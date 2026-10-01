# -*- coding: utf-8 -*-
r"""批次汇总、容量护栏与 `book_id` 消歧（design §4.9 / §10，需求 7.1 / 7.2 / 7.9 / 7.11 / 10.1 / 10.2 / 10.7，任务 25）。

编排层（design §4.9）用到的口子就是这几个：

```python
rep = report.Report()
for src in sources:
    book_id = rep.unique_id(parse(src).id, src)   # 需求 7.9：冲突加后缀，不静默覆盖
    rep.check_source(src)                         # 需求 7.11：源包 > 30MB 预警
    try:
        if mf.should_skip(src, digest):
            rep.skipped(src, mf.entry_for(src)); continue    # 需求 7.4
        meta = process_book(src)
        rep.warn_all(validate.check(meta, toc_data).warnings)
        mf.update(src, digest, meta)
        rep.ok(src, meta)                                    # 逐本记下压缩器
    except Exception as e:
        rep.fail(src, e)                                     # 需求 7.1：记原因、继续下一本
        continue

rep.summary()        # 需求 7.2
rep.guard_rails()    # 需求 10.1 / 10.2 / 10.7
raise SystemExit(rep.exit_code)
```

## 为什么非零退出在这里、而且是**返回**出去的

需求 7.1 与 7.10/10.1 拉的是两个方向：单本坏书**不许**终止批次，但"批次里有失败"
与"产物越限"必须让构建红掉。把这两件事分开的唯一干净做法是：

- 逐本环节只**记账**（`fail()` 记原因、打完整报错，然后返回），
- 批次末尾由本模块把账算成一个退出码。

本模块因此**不调 `sys.exit()`**。`summary()` / `guard_rails()` 返回带 `exit_code`
的结果对象，`Report.exit_code` 把两者合成一个数，由入口脚本 `raise SystemExit(...)`。
理由有两条：深处的 `sys.exit` 会被上层的 `except Exception` 吞掉（`SystemExit` 不是
`Exception`，但编排层的 `try` 若写成 `except BaseException` 就会）；更要紧的是
护栏与汇总要能在单测里跑——`sys.exit` 的版本只能靠 `pytest.raises(SystemExit)`
反推，拿不到"哪个文件越限、它用的是哪个压缩器"这些真正要断言的东西。

退出码分两档，都非零，但能一眼分清是谁红的：

- `EXIT_BOOK_FAILED`（1）：有书失败（需求 7.1 / 7.2）。产物本身合规，重跑那几本即可。
- `EXIT_GUARD_RAIL`（2）：产物越限（需求 10.1）。**这批产物部署不上去**，比个别书失败严重，
  所以两者同时发生时取 2。

## 护栏量的是磁盘，不是内存里的账

`guard_rails()` 直接 `rglob` 扫 `public/books` 与 `public/data`，而不是把
`meta['gzSize']` 加起来。差别在于它要回答的是"**这批产物能不能部署**"：

- 上次构建留下的、本次被跳过的、`prune` 没清掉的文件同样占 20000 文件配额，
  也同样会因为单文件 > 25 MiB 让部署失败。只看本次处理过的书就会漏掉它们
  ——而漏掉的恰好是最可能出问题的那批（"我明明没动过它"）。
- `books.json` 这类不属于任何单本书的产物也在配额里。

内存里的账（`Report.books`）只用来给磁盘上的文件**贴压缩器标签**：`.txt.gz` 本身
看不出是 gz9 还是 zopfli 压的（两者都是标准 gzip 流，这正是选 zopfli 的原因），
而越限报错时第一个要回答的问题就是"zopfli 是不是已经上过了"（design §4.9）。
被跳过的书也有这个标签——它来自清单里的 `compressor`（`manifest.Entry`）。

## 越限的两种情形，处置完全不同（需求 10.7）

- **已用 `zopfli` 仍 > 25 MiB —— 硬失败。**没有下一档压缩器可换：gzip level 9 是
  gzip 的天花板（附录 M5），zopfli 在它之上只再省 8%，用掉之后余量为零。唯一出路
  是按章节分片，而那是本阶段明确的 Out of Scope（需求 10.6）。报错文案直说这条结论，
  **不给"重试 / 调级别 / 换参数"留想象空间**——那些方向一个都不存在，让人去试等于
  白烧两分钟一本的 zopfli。
- **用 `gz9` 就 > 25 MiB —— 阈值适用性问题，不是硬失败。**说明这本源包在 10MB 阈值
  以下却压不住（极端可压缩的源包），按 §4.8 把它改判 `zopfli` 重压即可。

`near_limit`（20–25 MiB 的 gz，需求 10.2）同理带上压缩器：`gz9` 的还有 8% 的余量可用，
`zopfli` 的已经没有了，两句提示不能混。

## 失败原因逐条列全，告警不重复打

需求 7.2 要的是"逐条失败原因摘要"，所以 `summary()` **不截断**失败列表：一本一行，
7000 本里失败 30 本就是 30 行，这正是要看的东西。相反，单个异常的完整消息
（`ValidationError` 一次能报十几行）在 `fail()` 的当场就已经完整打过了，摘要里
只留首行——同一份文字打两遍只会把真正的信号压下去。

告警（`warn()` / `warn_all()`）也是当场输出、摘要里只报条数。`warn_all()` 存在的
理由是 `validate.Result.warnings` 与 `manifest.Manifest.warnings` 都是"收集完由
编排层输出"的形态：交给它而不是各自 `emit_warnings()`，告警条数才会进汇总。

## 输出本身不许杀掉批次

`_emit` 对 `UnicodeEncodeError` 做降级（`_write_line` / `_degrade`），这不是防御性
编程的装饰，而是因为 **`fail()` 是从编排层逐本的 `except Exception` 里面被调用的**：
写 stderr 时抛出的编码错误不会被那一本的 `try` 接住，它是从 handler 里飞出来的，
于是剩下几千本一起终止——正是三层容错要消掉的形态。

`preprocess.py` 的入口已经把 stdout 与 stderr 都重设成 UTF-8，这是第一道防线；但流
不一定重设得了（编码写死的管道、嵌入式 runner、有人换掉了 `sys.stderr`），所以第二道
防线放在这里：先原样写，`UnicodeEncodeError` 就按流自己的编码 `backslashreplace`
重写一遍（cp936 下汉字还是汉字，只有 `❌` 这类越界字符变成 `\u274c`），再不成就
丢掉这一行。**打得歪的告警远好过死掉的批次。**

顺带一句这条为什么紧要：`fail()` 的行首 "❌"（U+274C）本身就不在 GBK 里，所以在
stock cp936 控制台上，触发条件不是"某本书的书名恰好越界"，而是"第一本失败的书"。

## `book_id` 一经分配就不变

`unique_id()` 让先到的书拿裸 id，后来的拿 `_2` / `_3`（需求 7.9）。单看这一个函数，
**后缀是扫描顺序的函数，不是内容的函数**：新增一本排在前面的同名书，谁拿裸 id 就会
变，两本的产物名随之互换、整体重建一次。

源文件可以删掉之后（需求 7.5 修订 / 7.12），这个性质就不能再放任：源包已删除的书
没法重建，它的 id 一旦被新来的同名书拿走，产物就被覆盖、再也找不回来。所以编排层在
逐本处理之前先用 `claim()` 把清单里已分配的 id 全部占住——源文件已删除的书一律占，
源文件还在的书只要它的 id 仍能由文件名推出（裸 id 或 `<裸 id>_N`）也占——只有真正
的新书才走 `unique_id()`，而且只会拿到没人用过的后缀。清单里 `book_id` 唯一
（`manifest` 模块 docstring），占位之间不会互相冲突。

消歧换来的是"绝不静默覆盖"：不消歧的话两本书写同一组 `<id>.txt.gz` / `<id>_toc.json`，
后写的盖掉先写的，`books.json` 里出现重复 id，前端 `key={book.id}` 重复、点第一本
打开第二本（A18）。7000 本里同名书（尤其大量"佚名"）概率不低。

`claim()` / `unique_id()` 要在**跳过判定之前**对每本书都做一次，包括会被跳过的：
id 命名空间的占用与这本书这次要不要重跑无关，漏掉跳过的那些会让本次处理的书拿到
一个已经被磁盘上的产物占着的裸 id。
"""

from __future__ import annotations

import sys
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import IO, Dict, Iterable, List, Mapping, Optional, Sequence, Set, Tuple, Union

from .manifest import DEFAULT_BOOKS_DIR, DEFAULT_DATA_DIR, gz_name, toc_name

__all__ = [
    'Artifact',
    'Book',
    'EXIT_BOOK_FAILED',
    'EXIT_GUARD_RAIL',
    'EXIT_OK',
    'FILE_COUNT_MAX',
    'FILE_MAX_BYTES',
    'Failure',
    'GZ9',
    'GZ_WARN_BYTES',
    'GuardRails',
    'LARGE_SOURCE_BYTES',
    'MAX_LISTED',
    'REASON_MAX_CHARS',
    'Report',
    'Summary',
    'ZOPFLI',
]

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent

#: 源文件预警线（需求 7.11）。30MB 的包解压后是 80MB 量级的文本，且按 §4.8 必然
#: 走 zopfli（单本约两分钟），值得在开始处理前就说一声。
LARGE_SOURCE_BYTES = 30 * 1024 * 1024

#: 单本 gz 的"接近上限"告警线（需求 10.2）。实测《从零开始》22.36MB、
#: 《极品全能高手》zopfli 后 23.14MB，两本现在就会触发——这条不是预案。
GZ_WARN_BYTES = 20 * 1024 * 1024

#: Cloudflare Pages 的单文件上限：25 MiB = 26,214,400 B（需求 10.1）。
#: 越过即部署失败，所以这里用 MiB 而不是 10^6 的 MB——按 10^6 算会放过
#: 25,000,000–26,214,400 之间的文件，那段恰好是最容易出事的区间。
FILE_MAX_BYTES = 25 * 1024 * 1024

#: Cloudflare Pages 的总文件数上限（需求 10.1）。
FILE_COUNT_MAX = 20_000

#: 压缩器的名字（design §4.8）。写进清单、汇总与护栏输出，越限时据此给不同的处置。
GZ9 = 'gz9'
ZOPFLI = 'zopfli'

#: 退出码。见模块 docstring"为什么非零退出在这里"。
EXIT_OK = 0
EXIT_BOOK_FAILED = 1
EXIT_GUARD_RAIL = 2

#: 失败原因在摘要里的单行长度上限；超出截断并加省略号（完整消息 `fail()` 已打过）。
REASON_MAX_CHARS = 160

#: 汇总里"同类条目"最多列几条（zopfli 书目、接近上限的 gz）。
#: **失败列表不受此限**——需求 7.2 要的就是逐条。
MAX_LISTED = 10


# ---------------------------------------------------------------------------
# 小工具
# ---------------------------------------------------------------------------


def _mb(size: int) -> str:
    """字节数的人类可读形式，口径与需求/附录 M 一致（1MB = 1024×1024 B）。

    不足 1MB 的走 KB：产物 gz 都是 MB 级，但"距上限还剩"与夹具里的小文件会落到
    1MB 以下，那时 `0.00 MB` 等于没说。
    """
    if size < 1024 * 1024:
        return f'{size / 1024:.1f} KB'
    return f'{size / 1024 / 1024:.2f} MB'


def _show(path: Path) -> str:
    """路径的显示形式：能相对仓库根就相对，否则绝对（临时目录里跑测试时）。"""
    try:
        return str(path.resolve().relative_to(_REPO_ROOT)).replace('\\', '/')
    except (OSError, ValueError):
        return str(path)


def _one_line(text: str) -> str:
    """多行消息压成一行摘要：取首个非空行、折叠空白、超长截断。"""
    for raw in text.splitlines():
        line = ' '.join(raw.split())
        if line:
            if len(line) > REASON_MAX_CHARS:
                return line[: REASON_MAX_CHARS - 1] + '…'
            return line
    return '（无消息）'


def _int_of(value: object) -> int:
    """容错取整：拿不到就 0。这些数字只进汇总，不该让汇总本身炸掉。"""
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        return 0
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _degrade(text: str, stream: IO[str]) -> str:
    r"""把一行降级成目标流一定收得下的形态。

    先按流**自己的**编码做 `backslashreplace`：cp936 控制台下汉字照旧是汉字，只有
    越界的那几个字符（如 `❌` → `\u274c`）变成转义，可读性损失最小。取不到编码、
    或那条编码本身有问题时退到纯 ASCII——任何编码都收得下它。
    """
    encoding = getattr(stream, 'encoding', None)
    if isinstance(encoding, str) and encoding:
        try:
            return text.encode(encoding, errors='backslashreplace').decode(
                encoding, errors='replace'
            )
        except (LookupError, UnicodeError, TypeError, ValueError):
            pass
    return text.encode('ascii', errors='backslashreplace').decode('ascii')


def _write_line(line: str, stream: IO[str]) -> None:
    r"""写一行；**编码错误绝不向外抛**（见模块 docstring"告警不许杀掉批次"）。

    `fail()` 是从逐本的 `except Exception` 里面被调用的：这里抛出去，剩下几千本
    就一起没了。所以编码不合就降级重写一遍，再不成就把这一行丢掉——一条打不出来
    的告警远好过一批死掉的书。
    """
    try:
        print(line, file=stream)
        return
    except UnicodeEncodeError:
        pass
    try:
        print(_degrade(line, stream), file=stream)
    except Exception:
        pass          # 连降级都写不出去：这一行只能放弃，批次继续


def _emit(lines: Sequence[str], stream: IO[str]) -> None:
    if not lines:
        return
    for line in lines:
        _write_line(line, stream)
    try:
        stream.flush()
    except Exception:
        pass


# ---------------------------------------------------------------------------
# 记录
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Book:
    """一本处理完毕的书：成功（`skipped=False`）或被增量判定跳过（`skipped=True`）。"""

    source: str
    """源文件名。"""

    book_id: str
    """产物 id（已经过 `unique_id` 消歧）。"""

    title: str
    """书名；取不到时退回 `book_id`。"""

    char_count: int = 0
    total_chapters: int = 0
    gz_size: int = 0

    compressor: Optional[str] = None
    """`gz9` / `zopfli`，见模块 docstring"护栏量的是磁盘"。跳过的书取自清单。"""

    skipped: bool = False

    archived: bool = False
    """源文件已不在源目录、产物沿用清单记录的书（需求 7.5 修订）。恒有 `skipped=True`，
    但不计入"跳过"：跳过是"源文件查过、没变"，归档是"源文件已经没了"。"""


@dataclass(frozen=True)
class Failure:
    """一本失败的书（需求 7.1）。批次继续，退出码在末尾统一给。"""

    source: str
    kind: str
    """异常类名。`str(e)` 可能是空的（`KeyError` 之类），类名至少说明了是哪一层坏的。"""

    reason: str
    """单行摘要，进 `summary()`。"""

    detail: str
    """原始的完整消息，`fail()` 当场已打（`ValidationError` 一次能报十几行）。"""


@dataclass(frozen=True)
class Artifact:
    """磁盘上的一个产物文件。"""

    path: Path
    size: int

    book_id: Optional[str] = None
    """对得上本批记录的书时是它的 id；否则 `None`（残留文件、`books.json` 等）。"""

    compressor: Optional[str] = None
    """这本书实际用的压缩器；`None` 表示本批没有它的记录（见 `label`）。"""

    @property
    def label(self) -> str:
        """`public/books/x.txt.gz 23.14 MB（zopfli）` 这样的一行标签。"""
        who = self.compressor if self.compressor else '压缩器未记录'
        return f'{_show(self.path)} {_mb(self.size)}（{who}）'


@dataclass(frozen=True)
class Summary:
    """`summary()` 的结果（需求 7.2）。

    计数字段刻意与 `Report.n_ok` 等同名：`GuardRails` 上的 `ok` 是"这批能不能部署"
    的布尔值，这里若也叫 `ok` 就是两个同名不同义的属性摆在一起。
    """

    n_ok: int
    n_skipped: int
    n_failed: int
    compressors: Mapping[str, int]
    failures: Tuple[Failure, ...]
    warnings: int
    lines: Tuple[str, ...]
    exit_code: int
    n_archived: int = 0
    """源文件已不在、产物沿用清单记录的书（需求 7.5 修订）。"""

    @property
    def n_total(self) -> int:
        return self.n_ok + self.n_skipped + self.n_archived + self.n_failed


@dataclass(frozen=True)
class GuardRails:
    """`guard_rails()` 的结果（需求 10.1 / 10.2 / 10.7）。"""

    file_count: int
    """产物文件总数（含调用方传入的 `extra_files`）。"""

    largest: Optional[Artifact]
    """最大的单个产物文件；没有任何产物时 `None`。"""

    oversize: Tuple[Artifact, ...]
    """> 25 MiB 的文件：**硬护栏**，非零退出并指明文件（需求 10.1）。"""

    near_limit: Tuple[Artifact, ...]
    """20–25 MiB 的 `.txt.gz`：告警，仍然通过（需求 10.2）。"""

    count_exceeded: bool
    """文件总数是否越过 20000（需求 10.1）。"""

    lines: Tuple[str, ...]
    """已输出的全部文本，顺序为"报告 → 告警 → 越限"。"""

    exit_code: int

    @property
    def ok(self) -> bool:
        """这批产物能不能部署。"""
        return self.exit_code == EXIT_OK


# ---------------------------------------------------------------------------
# 汇总器
# ---------------------------------------------------------------------------


@dataclass
class Report:
    """一次批次的账本。逐本记账，末尾算出汇总、护栏与退出码。"""

    books_dir: Path = DEFAULT_BOOKS_DIR
    """`.txt.gz` 的产物目录，护栏在这里扫。"""

    data_dir: Path = DEFAULT_DATA_DIR
    """`_toc.json` / `books.json` 的产物目录。"""

    out: Optional[IO[str]] = None
    """进度与汇总的输出流，默认 `sys.stdout`（延迟取值，便于测试注入）。"""

    err: Optional[IO[str]] = None
    """失败、告警与越限的输出流，默认 `sys.stderr`。"""

    books: List[Book] = field(default_factory=list)
    failures: List[Failure] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)

    claimed: Dict[str, str] = field(default_factory=dict)
    """已占用的 `book_id` → 首个占用它的源文件名（`unique_id` 用）。"""

    guard: Optional[GuardRails] = None
    """最近一次 `guard_rails()` 的结果；没跑过是 `None`。"""

    # -- 输出 ---------------------------------------------------------------

    @property
    def _out(self) -> IO[str]:
        return self.out if self.out is not None else sys.stdout

    @property
    def _err(self) -> IO[str]:
        return self.err if self.err is not None else sys.stderr

    # -- 计数 ---------------------------------------------------------------

    @property
    def n_ok(self) -> int:
        """本次真正处理成功的书数。"""
        return sum(1 for book in self.books if not book.skipped)

    @property
    def n_skipped(self) -> int:
        """被增量判定跳过的书数（需求 7.4）。归档书不算，见 `n_archived`。"""
        return sum(1 for book in self.books if book.skipped and not book.archived)

    @property
    def n_archived(self) -> int:
        """源文件已不在、产物与索引条目沿用清单记录的书数（需求 7.5 修订）。"""
        return sum(1 for book in self.books if book.archived)

    @property
    def n_failed(self) -> int:
        return len(self.failures)

    @property
    def n_total(self) -> int:
        return len(self.books) + len(self.failures)

    def compressor_counts(self) -> Dict[str, int]:
        """压缩器 → 本数，含跳过的书（它们的产物同样躺在护栏要扫的目录里）。"""
        counts: Dict[str, int] = {}
        for book in self.books:
            key = book.compressor if book.compressor else '未记录'
            counts[key] = counts.get(key, 0) + 1
        return counts

    # -- 逐本记账 -----------------------------------------------------------

    def ok(self, src: Union[Path, str], meta: Union[Mapping[str, object], object]) -> Book:
        """记下一本处理成功的书（design §4.9 的 `report.ok(src, meta)`）。

        Args:
            src: 源文件路径（只取文件名）。
            meta: `books.json` 的条目（`process_book` 的返回值），或任何带
                `book_id` / `gz_size` / `compressor` 属性的对象（如 `manifest.Entry`）。
                `compressor` 缺失不是错误，只是护栏里这本会显示"压缩器未记录"。

        Returns:
            记下的 `Book`。
        """
        book = _as_book(src, meta, skipped=False)
        self.books.append(book)
        _emit(
            [
                f'  ✅ 《{book.title}》 {book.total_chapters} 章 · '
                f'{book.char_count:,} 字 · gz {_mb(book.gz_size)}'
                f'（{book.compressor if book.compressor else "压缩器未记录"}）'
            ],
            self._out,
        )
        return book

    def skipped(
        self,
        src: Union[Path, str],
        entry: Union[Mapping[str, object], object, None] = None,
    ) -> Book:
        """记下一本被跳过的书（需求 7.4，design §4.9 的 `report.skipped(src)`）。

        Args:
            src: 源文件路径。
            entry: 这本书的清单记录（`manifest.Entry`）或 `books.json` 条目。
                传了才能在汇总与护栏里带上它的规模与压缩器——**被跳过的书，清单是
                "它当初用的是 gz9 还是 zopfli"唯一还留存的记录**（design §4.9）。
        """
        book = _as_book(src, entry, skipped=True)
        self.books.append(book)
        label = f'《{book.title}》' if book.title else book.source
        _emit([f'  ⏭ 跳过 {label}：源文件与产物都没变（需求 7.4）'], self._out)
        return book

    def archived(
        self,
        src: Union[Path, str],
        entry: Union[Mapping[str, object], object, None] = None,
    ) -> Book:
        """记下一本归档书：源文件已不在源目录，产物与索引条目沿用清单记录（需求 7.5 修订）。

        **不逐本输出。**删源模式下归档书就是全库，7000 行"沿用"只会把真正的信号
        压下去；汇总里给一个数（`summary()`）。规模与压缩器照旧进账——护栏扫到它的
        产物时要能贴上压缩器标签。

        Args:
            src: 清单里的键（当初的源文件名）。
            entry: 这本书的清单记录（`manifest.Entry`）。
        """
        book = replace(_as_book(src, entry, skipped=True), archived=True)
        self.books.append(book)
        return book

    def fail(self, src: Union[Path, str], error: Union[BaseException, str]) -> Failure:
        """记下一本失败的书并**当场打完整报错**，然后返回（需求 7.1）。

        不抛、不退出：批次必须继续。非零退出码由 `exit_code` 在末尾给出。

        Args:
            src: 源文件路径。
            error: 捕获到的异常，或一句现成的失败说明。
        """
        source = Path(src).name
        if isinstance(error, BaseException):
            kind = type(error).__name__
            detail = str(error) or repr(error)
        else:
            kind = '失败'
            detail = str(error)

        failure = Failure(source, kind, _one_line(detail), detail)
        self.failures.append(failure)

        rest = detail.splitlines()
        lines = [f'  ❌ [失败] {source}（{kind}）：{rest[0].strip() if rest else failure.reason}']
        lines += [f'      {line}' for line in rest[1:]]
        lines.append('      本批继续处理下一本（需求 7.1）；这本不会写进清单，下次运行会重跑它。')
        _emit(lines, self._err)
        return failure

    def warn(self, message: str) -> str:
        """记一条告警并当场输出。返回原消息，便于调用方复用文案。

        没有 `[标签]` 前缀的消息会被补上 `[告警]`，与 `manifest` / `validate`
        的输出风格保持一致（人扫日志时靠方括号定位）。
        """
        text = message if message.lstrip().startswith('[') else f'[告警] {message}'
        self.warnings.append(text)
        _emit([text], self._err)
        return text

    def warn_all(self, messages: Iterable[str]) -> int:
        """批量记告警，返回条数。

        `validate.Result.warnings` 与 `manifest.Manifest.warnings` / `PruneResult.warnings`
        都是"收集完由编排层输出"的形态：交给这里而不是各自 `emit_warnings()`，
        告警条数才会进汇总。
        """
        count = 0
        for message in messages:
            self.warn(message)
            count += 1
        return count

    # -- 源文件预警（需求 7.11）--------------------------------------------

    def check_source(self, src: Union[Path, str]) -> Optional[str]:
        """源文件超过 30MB 时输出预警（需求 7.11）。

        Returns:
            告警文本，未触发或文件读不到时 `None`（读不到的错由后续解压环节报，
            这里不抢它的活）。
        """
        path = Path(src)
        try:
            size = path.stat().st_size
        except OSError:
            return None
        if size <= LARGE_SOURCE_BYTES:
            return None
        return self.warn(
            '\n'.join(
                [
                    f'[大文件] 源文件 {path.name} {_mb(size)}，超过 '
                    f'{_mb(LARGE_SOURCE_BYTES)} 预警线（需求 7.11）。',
                    '  解压后的 UTF-8 文本约是它的 3–5 倍，产物 gz 有可能逼近 25 MiB 上限；'
                    f'且源包 > 10MB 按 §4.8 走 {ZOPFLI}，单本压缩约两分钟。',
                ]
            )
        )

    # -- book_id 消歧（需求 7.9）------------------------------------------

    def claim(self, book_id: str, src: Union[Path, str, None] = None) -> bool:
        """把一个**已经分配过**的 `book_id`（清单里记着的）原样占住，不加后缀、不告警。

        Returns:
            `True` = 占住了（或本来就是这个源文件占着）；`False` = 已被别的源文件占用，
            调用方应改走 `unique_id()`。清单里 `book_id` 唯一，正常情况下不会是 `False`。

        见模块 docstring"`book_id` 一经分配就不变"。
        """
        source = Path(src).name if src is not None else ''
        owner = self.claimed.get(book_id)
        if owner is None:
            self.claimed[book_id] = source
            return True
        return owner == source

    def unique_id(self, book_id: str, src: Union[Path, str, None] = None) -> str:
        """占用一个 `book_id`；已被占用则追加数字后缀消歧并告警（需求 7.9）。

        Args:
            book_id: 由文件名推出的原始 id。
            src: 这本书的源文件，只为让告警能指出是哪两本撞了。

        Returns:
            可安全使用的 id：没冲突就是原值，否则 `<id>_2`、`<id>_3`……
            （`_2` 也被占了就继续往后找，不会二次冲突）。

        后缀是扫描顺序的函数，不是内容的函数——这条性质与它的代价见模块 docstring。
        """
        source = Path(src).name if src is not None else ''
        if book_id not in self.claimed:
            self.claimed[book_id] = source
            return book_id

        owner = self.claimed[book_id] or '前一本同名书'
        index = 2
        candidate = f'{book_id}_{index}'
        while candidate in self.claimed:
            index += 1
            candidate = f'{book_id}_{index}'
        self.claimed[candidate] = source

        self.warn(
            '\n'.join(
                [
                    f'[id 冲突] book_id "{book_id}" 已被 {owner} 占用，'
                    f'{source or "本书"} 消歧为 "{candidate}"（需求 7.9）。',
                    '  不消歧就是两本书写同一组 <id>.txt.gz / <id>_toc.json：后写的静默盖掉'
                    '先写的，books.json 出现重复 id，前端 key 重复、点第一本会打开第二本。',
                    '  这个 id 记进清单后就固定下来，此后的运行不会再让两本书换名。',
                ]
            )
        )
        return candidate

    # -- 批次汇总（需求 7.2）----------------------------------------------

    def summary(self) -> Summary:
        """输出成功数 / 失败数 / 跳过数、压缩器分布与逐条失败原因（需求 7.2）。

        Returns:
            `Summary`。`exit_code` 只反映"有没有书失败"；产物护栏是 `guard_rails()`
            的事，两者的合并值在 `Report.exit_code`。
        """
        counts = self.compressor_counts()
        archived = f' · 归档 {self.n_archived}' if self.n_archived else ''
        lines: List[str] = [
            '=' * 60,
            f'[汇总] 共 {self.n_total} 本：成功 {self.n_ok} · 跳过 {self.n_skipped}{archived}'
            f' · 失败 {self.n_failed}（需求 7.2）',
        ]
        if self.n_archived:
            lines.append(
                f'  归档 {self.n_archived} 本：源文件已不在源目录，产物与索引条目沿用清单记录'
                '（需求 7.5）。'
            )

        if counts:
            spread = ' · '.join(f'{name} {number} 本' for name, number in sorted(counts.items()))
            lines.append(f'  压缩器：{spread}')
            # zopfli 的书按分布预期只有个位数（7,681 本里 9 本），逐本列出来值得：
            # 它们就是最贴近 25 MiB 上限的那几本。
            heavy = [book for book in self.books if book.compressor == ZOPFLI]
            listed = heavy[:MAX_LISTED]
            for book in listed:
                lines.append(
                    f'    - {ZOPFLI}：《{book.title}》 gz {_mb(book.gz_size)}'
                    f'{"（本次跳过）" if book.skipped else ""}'
                )
            if len(heavy) > len(listed):
                lines.append(f'    … 另有 {len(heavy) - len(listed)} 本用 {ZOPFLI}，未逐条列出。')

        if self.failures:
            lines.append(f'  失败 {self.n_failed} 本（逐条原因如下，完整报错见上文）：')
            lines += [
                f'    - {item.source}（{item.kind}）：{item.reason}' for item in self.failures
            ]

        if self.warnings:
            lines.append(f'  告警 {len(self.warnings)} 条（已在上文逐条输出）。')

        exit_code = EXIT_BOOK_FAILED if self.failures else EXIT_OK
        if exit_code != EXIT_OK:
            lines.append(
                f'  本批有失败：退出码 {exit_code}。单本失败不终止批次（需求 7.1），'
                '非零退出在批次结束时统一给出。'
            )
        lines.append('=' * 60)

        _emit(lines, self._out)
        return Summary(
            n_ok=self.n_ok,
            n_skipped=self.n_skipped,
            n_archived=self.n_archived,
            n_failed=self.n_failed,
            compressors=counts,
            failures=tuple(self.failures),
            warnings=len(self.warnings),
            lines=tuple(lines),
            exit_code=exit_code,
        )

    # -- 容量护栏（需求 10.1 / 10.2 / 10.7）-------------------------------

    def _scan_artifacts(self, problems: List[str]) -> List[Artifact]:
        """扫产物目录，给每个文件贴上（能贴的）书与压缩器标签。"""
        tagged: Dict[str, Book] = {}
        for book in self.books:
            if not book.book_id:
                continue
            tagged[gz_name(book.book_id)] = book
            tagged[toc_name(book.book_id)] = book

        artifacts: List[Artifact] = []
        seen: Set[str] = set()
        for directory in (self.books_dir, self.data_dir):
            if not directory.is_dir():
                problems.append(
                    f'[护栏] 产物目录不存在：{_show(directory)}'
                    '（本次没有任何产物写进这里？护栏按 0 个文件计。）'
                )
                continue
            for path in sorted(directory.rglob('*')):
                try:
                    if not path.is_file():
                        continue
                    key = str(path.resolve())
                    if key in seen:          # books_dir 与 data_dir 指向同一处时
                        continue
                    seen.add(key)
                    size = path.stat().st_size
                except OSError as exc:
                    problems.append(f'[护栏] 产物文件读不到：{_show(path)}（{exc}）')
                    continue
                book = tagged.get(path.name)
                artifacts.append(
                    Artifact(
                        path=path,
                        size=size,
                        book_id=book.book_id if book else None,
                        compressor=book.compressor if book else None,
                    )
                )
        return artifacts

    def guard_rails(self, extra_files: int = 0) -> GuardRails:
        """报告产物规模并检查平台上限（需求 10.1 / 10.2，压缩器口径见需求 10.7）。

        Args:
            extra_files: 额外计入 20000 配额的文件数（前端构建产物等）。默认 0：
                本模块只扫得到书籍产物目录，`dist/` 里的 JS/CSS 由调用方自己数。

        Returns:
            `GuardRails`。**不退出进程**——`exit_code` 交给入口（见模块 docstring）。
        """
        problems: List[str] = []
        artifacts = self._scan_artifacts(problems)

        file_count = len(artifacts) + extra_files
        largest = max(artifacts, key=lambda item: item.size) if artifacts else None
        oversize = tuple(item for item in artifacts if item.size > FILE_MAX_BYTES)
        near_limit = tuple(
            item
            for item in artifacts
            if item.path.name.endswith('.txt.gz')
            and GZ_WARN_BYTES < item.size <= FILE_MAX_BYTES
        )
        count_exceeded = file_count > FILE_COUNT_MAX

        # ① 报告（需求 10.1 的前半句：无论有没有越限都要报出规模）
        info: List[str] = [
            f'[护栏] 产物 {file_count:,} 个文件（上限 {FILE_COUNT_MAX:,}）'
            + (f'，其中调用方额外计入 {extra_files:,} 个' if extra_files else '')
        ]
        if largest is not None:
            info.append(
                f'  最大单文件：{largest.label}，上限 {_mb(FILE_MAX_BYTES)}'
                f'（{FILE_MAX_BYTES:,} B）'
            )
        else:
            info.append('  没有扫到任何产物文件。')

        # ② 接近上限的 gz（需求 10.2）
        warn_lines: List[str] = list(problems)
        listed = near_limit[:MAX_LISTED]
        for item in listed:
            head = (
                f'[接近上限] {_show(item.path)} {_mb(item.size)}（{item.compressor or "压缩器未记录"}）'
                f'已过 {_mb(GZ_WARN_BYTES)} 告警线，距 {_mb(FILE_MAX_BYTES)} 上限还剩 '
                f'{_mb(FILE_MAX_BYTES - item.size)}（需求 10.2）。'
            )
            if item.compressor == ZOPFLI:
                tail = (
                    f'  这本已经是 {ZOPFLI}，那 8% 的余量已经用掉了：再长就只剩按章节分片'
                    '（本阶段 Out of Scope）。'
                )
            elif item.compressor == GZ9:
                tail = (
                    f'  这本用的是 {GZ9}，还有换 {ZOPFLI} 这一档余量（实测约省 8%）；'
                    '按 §4.8 改判即可，不必现在动。'
                )
            else:
                tail = (
                    '  本批没有它的压缩器记录（上次构建的产物？）：先确认它是 '
                    f'{GZ9} 还是 {ZOPFLI} 压的，再判断还有没有余量。'
                )
            warn_lines += [head, tail]
        if len(near_limit) > len(listed):
            warn_lines.append(
                f'[接近上限] 另有 {len(near_limit) - len(listed)} 本 gz 超过 '
                f'{_mb(GZ_WARN_BYTES)}，未逐条列出。'
            )

        # ③ 越限（需求 10.1：非零退出并指明具体文件；需求 10.7：先回答压缩器）
        fatal: List[str] = []
        for item in oversize:
            fatal.append(
                f'[越限] {_show(item.path)} {_mb(item.size)} 超过单文件上限 '
                f'{_mb(FILE_MAX_BYTES)}（{FILE_MAX_BYTES:,} B），'
                f'压缩器：{item.compressor or "未记录"}（需求 10.1）。'
            )
            if item.compressor == ZOPFLI:
                fatal += [
                    f'  已经用过 {ZOPFLI}，**没有下一档压缩器可换**——这是硬失败。',
                    '  唯一出路是按章节分片，而分片是本阶段明确的 Out of Scope（需求 10.6）。',
                    f'  不要重试、不要调 gzip 级别：level 9 已是 gzip 天花板，{ZOPFLI} 也已用尽，'
                    '这两个方向都不存在余量。',
                ]
            elif item.compressor == GZ9:
                fatal += [
                    f'  这本用的是 {GZ9}（源包 ≤10MB，按 §4.8 的源包阈值判的），'
                    f'说明阈值在它身上不适用：改判 {ZOPFLI} 重压即可（实测约省 8%）。',
                    '  属阈值适用性问题，不是硬失败。',
                ]
            else:
                fatal += [
                    '  本批没有它的压缩器记录：它可能是上次构建的残留、或不属于任何单本书的产物。',
                    '  先确认它该不该在产物目录里；确实是某本书的产物就按 §4.8 重压一次。',
                ]

        if count_exceeded:
            fatal += [
                f'[越限] 产物文件数 {file_count:,} 超过上限 {FILE_COUNT_MAX:,}（需求 10.1）。',
                f'  每本书 2 个文件（<id>.txt.gz + <id>_toc.json），约 '
                f'{(FILE_COUNT_MAX - 1) // 2:,} 本就是天花板。',
                '  先删掉不再要的书的两个产物（源文件已不在的书，下次运行清单会自动遗忘它，'
                '需求 7.5）、孤儿产物与非书文件；合并文件绕不过这条，前端要能按 id 直接'
                '取到单本。',
            ]

        exit_code = EXIT_GUARD_RAIL if (oversize or count_exceeded) else EXIT_OK
        if exit_code != EXIT_OK:
            fatal.append(
                f'  护栏未通过：退出码 {exit_code}。这批产物部署不上去，'
                '构建到此为止（需求 10.1）。'
            )

        _emit(info, self._out)
        _emit(warn_lines, self._err)
        _emit(fatal, self._err)

        result = GuardRails(
            file_count=file_count,
            largest=largest,
            oversize=oversize,
            near_limit=near_limit,
            count_exceeded=count_exceeded,
            lines=tuple(info) + tuple(warn_lines) + tuple(fatal),
            exit_code=exit_code,
        )
        self.guard = result
        return result

    # -- 退出码 -------------------------------------------------------------

    @property
    def exit_code(self) -> int:
        """整批的退出码，交给入口 `raise SystemExit(...)`。

        - `EXIT_GUARD_RAIL`（2）：产物越限，这批**部署不上去**（需求 10.1）；
        - `EXIT_BOOK_FAILED`（1）：有书失败但产物合规（需求 7.1 / 7.2）；
        - `EXIT_OK`（0）：干净。

        两者同时发生取 2——护栏更严重：失败的书重跑就好，越限的产物根本上不去。
        护栏部分只在 `guard_rails()` 跑过之后才计入。
        """
        if self.guard is not None and self.guard.exit_code != EXIT_OK:
            return self.guard.exit_code
        return EXIT_BOOK_FAILED if self.failures else EXIT_OK


# ---------------------------------------------------------------------------
# meta / Entry → Book
# ---------------------------------------------------------------------------


def _as_book(
    src: Union[Path, str],
    meta: Union[Mapping[str, object], object, None],
    skipped: bool,
) -> Book:
    """把 `books.json` 条目或 `manifest.Entry` 归一成一条记录。

    两种形态都要收，是因为成功的书手上有 `meta`（驼峰键的 dict），而**被跳过的书
    只有清单记录**（`manifest.Entry`，蛇形属性）——它们的规模与压缩器同样要进汇总
    与护栏，否则跳过的那些书在护栏里会变成"压缩器未记录"。

    取不到的字段一律退化为 0 / 空：汇总不该因为少一个数字而炸掉。
    """
    source = Path(src).name

    if meta is None:
        return Book(source=source, book_id='', title='', skipped=skipped)

    if isinstance(meta, Mapping):
        book_id = str(meta.get('id') or '')
        title = str(meta.get('title') or '') or book_id
        compressor = meta.get('compressor')
        return Book(
            source=source,
            book_id=book_id,
            title=title,
            char_count=_int_of(meta.get('charCount')),
            total_chapters=_int_of(meta.get('totalChapters')),
            gz_size=_int_of(meta.get('gzSize')),
            compressor=str(compressor) if compressor else None,
            skipped=skipped,
        )

    book_id = str(getattr(meta, 'book_id', '') or '')
    title = str(getattr(meta, 'title', '') or '') or book_id
    compressor = getattr(meta, 'compressor', None)
    return Book(
        source=source,
        book_id=book_id,
        title=title,
        char_count=_int_of(getattr(meta, 'char_count', 0)),
        total_chapters=_int_of(getattr(meta, 'total_chapters', 0)),
        gz_size=_int_of(getattr(meta, 'gz_size', 0)),
        compressor=str(compressor) if compressor else None,
        skipped=skipped,
    )
