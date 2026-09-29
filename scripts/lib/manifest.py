# -*- coding: utf-8 -*-
r"""增量清单与失效清理（design §4.9，需求 7.3 / 7.4 / 7.5，任务 23）。

清单是一张"源文件 → 上次产物"的映射，预处理据它决定**这本书要不要重跑**：

```jsonc
{
  "version": 1,
  "books": {
    "《从零开始》作者：雷云风暴.rar": {      // 键 = 源文件名
      "bookId": "从零开始-雷云风暴",         // 产物名由它派生
      "digest": "9f2c…",                    // 源文件 SHA-256
      "pipelineVersion": 2,                 // 产出它的切分流水线版本
      "charCount": 20532902,
      "totalChapters": 3221,
      "gzSize": 23446528,
      "compressor": "zopfli",
      "processedAt": "2026-09-24T11:02:07Z"
    }
  }
}
```

编排层（design §4.9）只用到四个口子：

```python
digest = manifest.sha256_file(src)
if mf.should_skip(src, digest):   # 需求 7.4：摘要一致 **且** 产物完整存在
    report.skipped(src); continue
...
mf.update(src, digest, meta)      # 需求 7.3：每本成功即落盘
...
mf.prune(sources)                 # 需求 7.5：源已删除的书，清产物 + 清条目
```

## 为什么要有清单（需求 D7）

7000 本、14.58 GB 源包全量重跑是小时级；改一本书、加一本书却要等整批，等于
没人会去跑它。摘要比对把"没变的书"压到一次 SHA-256（22 MB 的包约 30 ms），
这是 7000 本规模下能用/不能用的分界。

## 跳过必须两个条件同时成立（需求 7.4）

design §4.9 写的是 `manifest.unchanged(src, digest) and artifacts_exist(src)`。
本模块把这两半合进 `should_skip()`，因为**只查一半是会静默漏产物的**：清单说
"这本处理过"，而 `public/books/<id>.txt.gz` 已被手工删掉/磁盘满时写崩/被
`prune` 误删——跳过它就等于让站点带着一个 404 的资源上线，且日志显示一切正常。
两个 `stat` 的成本与一次 SHA-256 相比可以忽略，没有理由把它做成可选项。

产物"存在"的判定是 `is_file() and st_size > 0`：零字节文件是写入过程被打断的
典型残留，它存在但毫无用处。（结构层面的完整性由 `validate.py` 在写入时把关，
不在这里重复——那需要解析 7000 个 JSON。）

## 每本成功即落盘（需求 7.3）

现版本 `books.json` 在循环结束后才写，中途异常等于本次全部成果丢失。清单反过来：
**每本 `update()` 都立刻重写整个文件**，任何时刻按 Ctrl-C 或断电，已完成的书下次
都会被跳过。

两个代价，都是清楚的：

- **写入量是 O(n²)**：7000 本 × 约 1.4 MB ≈ 10 GB 顺序写。同一批次要读 14.58 GB
  源包、写约 6 GB 产物、每本还要跑一遍 gzip，清单的这份开销落在噪声里，
  换来的是"中断不丢成果"这条需求本身。不做"每 N 本写一次"的批量优化：那等于
  把需求 7.3 打一个 N 本的折扣，而省下的时间测不出来。
- **写入必须原子**：先写同目录临时文件、`flush` + `fsync`、再 `os.replace()`。
  直接覆盖原文件的话，正在写的那一刻被打断会留下一个半截 JSON——那不是"丢一本"，
  而是**整张清单报废**，比没有清单更糟。`os.replace` 在 Windows 与 POSIX 上都是
  原子替换，这是它取代 `shutil.move` 的唯一理由。

## 清单坏了是告警，写不进去才是错误

读：清单是**可再生的缓存**（把它删掉只是退化成全量重跑）。所以文件损坏、根不是
对象、版本不认识、某条目字段缺失，一律"丢弃 + 告警 + 继续"，绝不让一个缓存文件
把整批构建挡在门外。粒度尽量细——单条坏掉只重跑那一本，不是全部。

写：`save()` 失败（磁盘满、权限、路径被占）抛 `ManifestError`。这时候沉默才是
危险的：需求 7.3 已经失效，而使用者以为断点续跑还在保护他。

## 流水线改了，摘要不会变（`PIPELINE_VERSION`）

清单只认源文件的 SHA-256。改了 `toc_rules.py` 的规则表或 `toc.py` 的择一/切分逻辑
之后重跑，7,681 本书的摘要一个都没变，于是全部被"正确地"跳过——而磁盘上那些
`_toc.json` 全是旧逻辑切出来的。这条故障没有任何征兆：日志一片正常、退出码 0、
"本次跳过 7,681 本"，然后把上一版的切分结果又发布了一次。

出口是 `PIPELINE_VERSION`：每条记录都盖上"我是哪一版流水线产出的"，`should_skip()`
要求它等于当前值；不等、或旧清单里根本没有这个字段，就重跑这一本。

**版本盖在每条记录上，不写在表的顶层。**理由是中断安全：`save()` 每本都重写整个
文件，顶层字段必然被写成"当前版本"，可那一刻表里多数条目还是旧流水线产出的。跑到
第 300 本被 Ctrl-C，下次运行看顶层就以为整表都是新的，剩下 7,381 本永远不会被重做
——恰好是这个字段要消掉的那个故障，只是换了个形状。记在条目上则天然表达"表里混着
两版"这个真实状态。顶层因此**不**冗余再记一份：两处状态能互相矛盾时，多出来的那
一处只会骗人。

`MANIFEST_VERSION` 是另一件事，别混用：它管**文件格式**，不认识就整张表作废——连
`prune` 要用的 `bookId` 一起丢掉，源文件已删除的书从此没人清得掉它的产物。流水线
换版不该付这个代价：条目全都还有效，只是不再满足跳过条件而已。

## 清单放在仓库根，不放 `public/`

`.preprocess-manifest.json` 是**构建状态**，不是站点资源。放进 `public/` 会被
Vite 复制/硬链接进 `dist/` 跟着部署（design §4.1 的产物目录），白占需求 10.1 的
20000 文件配额，还把源包文件名与摘要一并发布出去。放仓库根 + 一条 `.gitignore`
最省事：它描述的 `public/books`、`public/data` 本身也是 gitignore 的本地产物，
两者同为"本机状态"，不该进版本库。

## `prune` 只动清单里记过的东西（需求 7.5）

`prune(sources)` 拿当前源目录的清单做差集：清单里有、源目录里没有的书 = 已删除，
移除它的 `.txt.gz`、`_toc.json` 与清单条目。三条护栏：

1. **源列表为空时拒绝执行**（除非显式 `allow_empty=True`）。源目录被挪走、
   `zip-novel/` 没挂上、glob 写错扩展名——这些都会得到一个空列表，而按差集
   语义那意味着"全库都该删"。删 7000 本产物是不可逆的，一个拼错的路径不该有
   这种权力，所以这里选择什么都不做 + 告警。
2. **`book_id` 仍被其他源文件占用时不删文件**，只删这条死条目。id 冲突消歧
   （任务 25）之后两本书可能指向同一组产物名，照差集删会把活着的那本的产物
   一并带走。
3. **删不掉就保留条目**（文件被占用、权限不足）。条目一删，那两个文件就再没有
   任何记录指向它们，永远成为孤儿；留着条目下次运行还会重试。

对应地，本模块**不做**"扫 `public/` 里没有清单条目的文件并删掉"的孤儿清理：
删除从未记录过的文件是数据丢失的常见来源（那目录下还有 `books.json` 这类不属于
任何单本书的产物），而总文件数的异常增长由任务 25 的护栏报告负责暴露。
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import IO, Dict, List, Mapping, Optional, Sequence, Tuple, Union

__all__ = [
    'DEFAULT_BOOKS_DIR',
    'DEFAULT_DATA_DIR',
    'DEFAULT_PATH',
    'MANIFEST_VERSION',
    'PIPELINE_VERSION',
    'Entry',
    'Manifest',
    'ManifestError',
    'PruneResult',
    'Pruned',
    'gz_name',
    'load',
    'sha256_file',
    'source_key',
    'toc_name',
]

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent

#: 清单的默认位置：仓库根的隐藏文件（见模块 docstring"不放 `public/`"）。
#: 按**仓库路径**解析而不是按 `cwd`——预处理从哪个目录发起都该读到同一张清单。
DEFAULT_PATH: Path = _REPO_ROOT / '.preprocess-manifest.json'

#: 产物目录的默认位置，与 `preprocess.py` 的输出目录一致。
DEFAULT_BOOKS_DIR: Path = _REPO_ROOT / 'public' / 'books'
DEFAULT_DATA_DIR: Path = _REPO_ROOT / 'public' / 'data'

#: 清单**文件格式**的版本。不认识就整张表作废并全量重跑（见 `load()`）。
#: 产物形态变了不要动它——那是 `PIPELINE_VERSION` 的事，作废整张表会把 `prune`
#: 要用的 `bookId` 一起丢掉（见模块 docstring）。
MANIFEST_VERSION = 1

# ---------------------------------------------------------------------------
# 章节切分流水线的版本
#
# **改了下面任何一处，就必须把 PIPELINE_VERSION +1：**
#
#   - `scripts/lib/toc_rules.py`：章节规则表（具名规则的正则、长度门槛、排除集）
#   - `scripts/lib/toc.py`：规则择一评分、全文切分、卷标记、两级兜底
#
# 这两处一动，磁盘上每一份 `_toc.json` 就都是旧逻辑的产物，而源文件的 SHA-256 一个
# 都没变——不 +1 的话重跑会把 7,681 本全部跳过，静默发布旧切分（见模块 docstring
# "流水线改了，摘要不会变"）。
#
# 反过来，只改 `report.py` 的文案、注释、或本模块自己的实现**不要**动它：它标定的是
# **产物形态**，不是提交次数；白 +1 一次就是 7,681 本重跑约数小时。
#
# 这条约定靠注释协调，不靠 import：`toc.py` / `toc_rules.py` 反向依赖清单模块是不
# 该有的耦合（它们不知道什么是增量构建）。改那边的人请回来这里 +1。
#
#   2（本次）：规则表与择一逻辑正在重写，全库必须重切一遍。
#   1：隐式的初版流水线。那时还没有这个字段，所以旧清单里读不到它
#      （`Entry.pipeline_version is None`），一律按"旧版"处理 → 重跑。
# ---------------------------------------------------------------------------

PIPELINE_VERSION = 2

#: SHA-256 的分块读取大小。源包最大约 22 MB，分块只是为了不把整包读进内存
#: ——7000 本的批次里这是唯一一处会无意义常驻几十 MB 的地方。
HASH_CHUNK_BYTES = 1 << 20

_VERSION_KEY = 'version'
_BOOKS_KEY = 'books'


class ManifestError(Exception):
    """清单**写入**失败，或调用方传入了不可能处理的元数据。

    只有真正该让这一本计入失败的情况才用它（见模块 docstring 末两段）：
    清单文件读坏了不属于此列——那是告警。
    """


# ---------------------------------------------------------------------------
# 命名与摘要
# ---------------------------------------------------------------------------


def gz_name(book_id: str) -> str:
    """整本正文的产物名：`<id>.txt.gz`。"""
    return f'{book_id}.txt.gz'


def toc_name(book_id: str) -> str:
    """单书章节索引的产物名：`<id>_toc.json`。"""
    return f'{book_id}_toc.json'


def source_key(src: Union[Path, str]) -> str:
    """清单里这本书的键：源文件名。

    用**文件名**而不是绝对路径：清单要能跟着仓库整体搬家、也要在
    `zip-novel/` 换挂载点后继续有效。`archive.scan_source_dir` 只枚举源目录下的
    一层文件，文件名在同一目录内天然唯一。

    大小写不做归一：NTFS 不区分、ext4 区分，归一会在 Linux 上把两个不同的源文件
    当成同一本。键的来源始终是 `scan_source_dir` 报出的真实文件名。
    """
    return Path(src).name


def sha256_file(path: Union[Path, str], chunk_size: int = HASH_CHUNK_BYTES) -> str:
    """源文件的 SHA-256 十六进制摘要（design §4.9 的 `sha256(src)`）。

    Raises:
        OSError: 文件读不了。编排层的 try/except 会把它记成这一本的失败
            （需求 7.1），不影响其余的书。
    """
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for block in iter(lambda: handle.read(chunk_size), b''):
            digest.update(block)
    return digest.hexdigest()


def _now_iso() -> str:
    """UTC 的秒级 ISO 8601 时间戳，形如 `2026-09-24T11:02:07Z`。"""
    return datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


def _as_int(raw: object, field_name: str) -> int:
    if isinstance(raw, bool) or not isinstance(raw, int):
        raise ValueError(f'{field_name} 必须是整数，实际是 {type(raw).__name__}：{raw!r}')
    return raw


# ---------------------------------------------------------------------------
# 条目
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Entry:
    """一本书上次成功处理的记录。

    只存**后续判断真正要用到**的东西，不做"顺手记一份 books.json"：

    - `book_id`：`prune` 靠它推出该删哪两个文件（需求 7.5）。
    - `digest`：跳过判定的依据（需求 7.4）。
    - `pipeline_version`：产出这份产物的切分流水线版本，跳过判定的另一半
      （`PIPELINE_VERSION`）。`None` = 旧清单里没有这个字段，按"旧版"处理 → 重跑。
    - `char_count` / `total_chapters` / `gz_size`：让汇总能报出**被跳过**那些书的
      规模，而不必回头解析 7000 个 `_toc.json`（任务 25）。
    - `compressor`：被跳过的书，这是"它当初用的是 gz9 还是 zopfli"唯一还留存的
      记录——产物文件本身看不出来，而越限报错时第一个要回答的就是这个问题
      （design §4.9 / 需求 10.7）。
    - `processed_at`：给人看的，"这本是什么时候构建的"。
    """

    book_id: str
    digest: str
    pipeline_version: Optional[int] = None
    char_count: int = 0
    total_chapters: int = 0
    gz_size: int = 0
    compressor: Optional[str] = None
    processed_at: str = ''

    def to_json(self) -> Dict[str, object]:
        """序列化为清单里的对象。`compressor` 为空时不写该键（"真时才输出"）。"""
        data: Dict[str, object] = {
            'bookId': self.book_id,
            'digest': self.digest,
        }
        # 紧跟 digest：它们俩合起来才是"这本要不要重跑"的完整依据。未记录时不写该键，
        # 读回来就是 None——与旧清单同一种形态，都按"旧版流水线"处理。
        if self.pipeline_version is not None:
            data['pipelineVersion'] = self.pipeline_version
        data['charCount'] = self.char_count
        data['totalChapters'] = self.total_chapters
        data['gzSize'] = self.gz_size
        if self.compressor:
            data['compressor'] = self.compressor
        data['processedAt'] = self.processed_at
        return data

    @classmethod
    def from_json(cls, raw: object) -> 'Entry':
        """反序列化。字段缺失/类型不对时抛 `ValueError`，由 `load()` 降级为告警。

        `bookId` 与 `digest` 是硬要求：少了任何一个，这条记录既不能用于跳过判定
        也不能用于清理，留着只会制造"看起来处理过"的假象。其余字段容忍缺失——
        它们只影响汇总里的数字，不影响正确性。

        `pipelineVersion` **缺失不是错误**：`PIPELINE_VERSION` 之前写出的清单里都没
        有这个键。缺失读成 `None`，落到"旧版流水线"那一档，结果是重跑这一本——正是
        想要的行为，所以不必为此丢弃整条记录（丢了 `prune` 就找不到该删的产物了）。
        """
        if not isinstance(raw, dict):
            raise ValueError(f'条目必须是对象，实际是 {type(raw).__name__}')
        book_id = raw.get('bookId')
        digest = raw.get('digest')
        if not isinstance(book_id, str) or not book_id.strip():
            raise ValueError(f'bookId 缺失或不是非空字符串：{book_id!r}')
        if not isinstance(digest, str) or not digest.strip():
            raise ValueError(f'digest 缺失或不是非空字符串：{digest!r}')
        compressor = raw.get('compressor')
        if compressor is not None and not isinstance(compressor, str):
            raise ValueError(f'compressor 必须是字符串或缺失：{compressor!r}')
        processed_at = raw.get('processedAt', '')
        if not isinstance(processed_at, str):
            raise ValueError(f'processedAt 必须是字符串：{processed_at!r}')
        raw_pipeline = raw.get('pipelineVersion')
        return cls(
            book_id=book_id,
            digest=digest,
            # 缺失 → None（旧清单）；写成别的类型 → 与其余字段同样按坏条目丢弃，
            # 两条路的结果都是"重跑这一本"，不会静默跳过一份来历不明的产物。
            pipeline_version=(
                None if raw_pipeline is None
                else _as_int(raw_pipeline, 'pipelineVersion')
            ),
            char_count=_as_int(raw.get('charCount', 0), 'charCount'),
            total_chapters=_as_int(raw.get('totalChapters', 0), 'totalChapters'),
            gz_size=_as_int(raw.get('gzSize', 0), 'gzSize'),
            compressor=compressor or None,
            processed_at=processed_at,
        )

    @classmethod
    def from_meta(cls, digest: str, meta: Mapping[str, object]) -> 'Entry':
        """由 `books.json` 的条目（`process_book` 的返回值）构造记录。

        Raises:
            ManifestError: `meta` 里没有 `id`。那是编排层的 bug，不是数据问题——
                没有 `book_id` 就推不出产物名，这条记录写进去等于给 `prune`
                埋一颗哑弹。
        """
        book_id = meta.get('id')
        if not isinstance(book_id, str) or not book_id.strip():
            raise ManifestError(f'元数据缺少可用的 id，无法写入清单：{meta!r}')
        compressor = meta.get('compressor')
        return cls(
            book_id=book_id,
            digest=digest,
            # 版本不从 `meta` 来：写清单的这一刻，产物就是**当前**这版流水线切出来的。
            # 唯一的真值源是模块常量，编排层无从（也不必）覆盖它。
            pipeline_version=PIPELINE_VERSION,
            char_count=int(meta.get('charCount') or 0),
            total_chapters=int(meta.get('totalChapters') or 0),
            gz_size=int(meta.get('gzSize') or 0),
            compressor=str(compressor) if compressor else None,
            processed_at=_now_iso(),
        )


# ---------------------------------------------------------------------------
# prune 的结果
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Pruned:
    """一本被清理掉的书。"""

    source_name: str
    """清单里的键，即已经不在源目录里的那个源文件名。"""

    book_id: str
    """它的产物 id。"""

    removed: Tuple[Path, ...] = ()
    """实际删掉的文件。早就不存在的产物不计入——那不是失败，是已经清干净了。"""

    kept: Tuple[Path, ...] = ()
    """因 `book_id` 仍被别的源文件占用而**保留**的文件（id 冲突，见模块 docstring）。"""


@dataclass(frozen=True)
class PruneResult:
    """一次 `prune` 的结果。汇总与告警由编排层输出（任务 25）。"""

    pruned: Tuple[Pruned, ...] = ()
    """已移除条目的书。"""

    kept_for_retry: Tuple[str, ...] = ()
    """文件删除失败、条目**故意留着**下次重试的键（见模块 docstring 护栏 3）。"""

    refused_empty: bool = False
    """是否因"源列表为空"而整体拒绝执行（护栏 1）。为真时什么都没删。"""

    warnings: Tuple[str, ...] = ()
    """告警文本；`emit_warnings()` 负责输出。"""

    @property
    def removed_files(self) -> Tuple[Path, ...]:
        """本次实际删除的全部文件，按书的顺序铺平。"""
        return tuple(path for item in self.pruned for path in item.removed)

    def emit_warnings(self, stream: Optional[IO[str]] = None) -> None:
        """把告警打到 stderr（默认）。无告警则什么都不做。"""
        _emit(self.warnings, stream)


def _emit(lines: Sequence[str], stream: Optional[IO[str]] = None) -> None:
    if not lines:
        return
    out = stream if stream is not None else sys.stderr
    for line in lines:
        print(line, file=out)
    try:
        out.flush()
    except Exception:
        pass


# ---------------------------------------------------------------------------
# 清单
# ---------------------------------------------------------------------------


@dataclass
class Manifest:
    """加载完毕的清单。可变——`update()` 会改内容并立刻落盘。"""

    path: Path = DEFAULT_PATH
    """清单文件位置。写进告警/报错信息，让人知道该去看哪个文件。"""

    books_dir: Path = DEFAULT_BOOKS_DIR
    """`.txt.gz` 的产物目录。"""

    data_dir: Path = DEFAULT_DATA_DIR
    """`_toc.json` 的产物目录。"""

    entries: Dict[str, Entry] = field(default_factory=dict)
    """源文件名 → 上次处理记录。空清单是完全正常的状态（首次运行就是空的）。"""

    warnings: List[str] = field(default_factory=list)
    """加载期产生的告警（文件损坏、格式版本不符、条目被丢弃、流水线换版）。
    `emit_warnings()` 输出。"""

    def __len__(self) -> int:
        return len(self.entries)

    def __contains__(self, src: Union[Path, str]) -> bool:
        return source_key(src) in self.entries

    def emit_warnings(self, stream: Optional[IO[str]] = None) -> None:
        """把加载期告警打到 stderr（默认）。无告警则什么都不做。"""
        _emit(self.warnings, stream)

    # -- 查询 ---------------------------------------------------------------

    def entry_for(self, src: Union[Path, str]) -> Optional[Entry]:
        """取这本书上次的记录；清单里没有则 `None`。"""
        return self.entries.get(source_key(src))

    def artifacts_for(self, book_id: str) -> Tuple[Path, Path]:
        """这本书的两个产物路径：`(<books_dir>/<id>.txt.gz, <data_dir>/<id>_toc.json)`。"""
        return (self.books_dir / gz_name(book_id), self.data_dir / toc_name(book_id))

    def artifacts_exist(self, book_id: str) -> bool:
        """两个产物是否都存在**且非空**（见模块 docstring）。"""
        return all(
            path.is_file() and path.stat().st_size > 0
            for path in self.artifacts_for(book_id)
        )

    def unchanged(self, src: Union[Path, str], digest: str) -> bool:
        """源文件的摘要是否与清单记录一致（design §4.9 的 `unchanged`）。

        只回答"源没变"这一半问题。判断能不能跳过请用 `should_skip()`——单独用这个
        会漏掉"产物已经不在了"和"产物是旧版流水线切的"这两种情况。
        """
        entry = self.entry_for(src)
        return entry is not None and entry.digest == digest

    def should_skip(self, src: Union[Path, str], digest: str) -> bool:
        """能否跳过这本书：摘要一致、流水线版本一致**且**产物完整存在（需求 7.4）。

        这就是 design §4.9 里 `unchanged(src, digest) and artifacts_exist(src)`
        那一行，合成一个调用是为了让"只查了一半"在源码里无法发生；
        `PIPELINE_VERSION` 这一项同理——它属于跳过判定，不该由调用方另外记得去查。
        """
        entry = self.entry_for(src)
        if entry is None or entry.digest != digest:
            return False
        if entry.pipeline_version != PIPELINE_VERSION:
            # 源文件一个字节都没变，但产出它的是另一版切分逻辑：产物已经过期
            # （见模块 docstring"流水线改了，摘要不会变"）。`None` 也走这条路。
            return False
        return self.artifacts_exist(entry.book_id)

    def pipeline_stale(self, src: Union[Path, str], digest: str) -> bool:
        """这本书是否**只因流水线版本不符**而必须重跑。

        换句话说："源文件与产物都没变，加 `PIPELINE_VERSION` 之前它会被静默跳过。"
        编排层据此把"因版本变更重做"与"因源文件改动重做"分开报——一次"什么都没改"
        的运行突然重建全库时，操作者要的正是这个区分。

        源文件真的变了、或产物不齐（本来就要重跑）时都是 `False`：那些书的重跑
        原因另有出处，算在版本变更头上只会把这个数字搅浑。
        """
        entry = self.entry_for(src)
        if entry is None or entry.digest != digest:
            return False
        if entry.pipeline_version == PIPELINE_VERSION:
            return False
        return self.artifacts_exist(entry.book_id)

    # -- 更新 ---------------------------------------------------------------

    def update(
        self,
        src: Union[Path, str],
        digest: str,
        meta: Mapping[str, object],
    ) -> Entry:
        """记下这本书并**立刻落盘**（需求 7.3，design §4.9 的 `update`）。

        Args:
            src: 源文件路径（只取文件名作键）。
            digest: 刚算过的源文件 SHA-256。
            meta: `books.json` 的条目，至少含 `id`；`charCount` / `totalChapters` /
                `gzSize` / `compressor` 有则记。

        Returns:
            写入的记录。

        Raises:
            ManifestError: `meta` 缺少 `id`，或清单写入失败。
        """
        entry = Entry.from_meta(digest, meta)
        self.entries[source_key(src)] = entry
        self.save()
        return entry

    def save(self) -> None:
        """原子重写整个清单文件。

        先写同目录的临时文件并 `fsync`，再 `os.replace()`——直接覆盖的话，写到
        一半被打断会留下半截 JSON，那是整张清单报废而不是丢一本书。

        Raises:
            ManifestError: 写入失败（磁盘满、权限、目录不存在）。这时候沉默最危险：
                需求 7.3 已经失效，而使用者以为断点续跑还在保护他。
        """
        payload = {
            _VERSION_KEY: MANIFEST_VERSION,
            # 按键排序：写入结果与插入顺序无关，文件可直接 diff
            _BOOKS_KEY: {key: self.entries[key].to_json() for key in sorted(self.entries)},
        }
        text = json.dumps(payload, ensure_ascii=False, indent=2) + '\n'
        tmp = self.path.with_name(f'{self.path.name}.tmp{os.getpid()}')
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with open(tmp, 'w', encoding='utf-8', newline='\n') as handle:
                handle.write(text)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp, self.path)
        except OSError as exc:
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass
            raise ManifestError(
                f'清单写入失败：{self.path}（{exc}）\n'
                '  已完成的书本次不会被记录，下次运行会重跑它们。'
            ) from exc

    # -- 清理 ---------------------------------------------------------------

    def prune(
        self,
        sources: Sequence[Union[Path, str]],
        allow_empty: bool = False,
    ) -> PruneResult:
        """清理源目录中已删除的书：产物 + 清单条目（需求 7.5）。

        Args:
            sources: 当前源目录里全部源文件（`archive.scan_source_dir` 的结果）。
                只取文件名。
            allow_empty: 源目录确实空了时传 `True`，否则空列表会被拒绝执行
                （见模块 docstring 护栏 1）。

        Returns:
            `PruneResult`。没有该清理的书时是一个全空的结果，且**不重写文件**。
        """
        live = {source_key(item) for item in sources}
        dead = sorted(key for key in self.entries if key not in live)
        if not dead:
            return PruneResult()

        if not live and not allow_empty:
            warning = '\n'.join(
                [
                    f'[清理已跳过] 源列表为空，但清单里还有 {len(dead)} 本书。',
                    '  照差集语义这意味着"全库都该删"，而源目录没挂上/路径写错同样'
                    '会得到空列表。',
                    f'  本次什么都没删（清单：{self.path}）。源目录确实空了，'
                    '请显式允许清空。',
                ]
            )
            return PruneResult(refused_empty=True, warnings=(warning,))

        # id 冲突消歧（任务 25）后两个源文件可能指向同一组产物名：活着的那本的
        # 产物不能被死条目带走。
        claimed = {entry.book_id for key, entry in self.entries.items() if key in live}

        pruned: List[Pruned] = []
        kept_for_retry: List[str] = []
        warnings: List[str] = []

        for key in dead:
            entry = self.entries[key]
            paths = self.artifacts_for(entry.book_id)

            if entry.book_id in claimed:
                kept = tuple(path for path in paths if path.exists())
                warnings.append(
                    f'[清理] 源文件 {key} 已删除，但 book_id "{entry.book_id}" 仍被'
                    '其他源文件占用；只移除清单条目，产物保留。'
                )
                del self.entries[key]
                pruned.append(Pruned(key, entry.book_id, removed=(), kept=kept))
                continue

            removed: List[Path] = []
            failed: List[str] = []
            for path in paths:
                try:
                    path.unlink()
                except FileNotFoundError:
                    continue          # 已经清干净了，不是失败
                except OSError as exc:
                    failed.append(f'{path}（{exc}）')
                else:
                    removed.append(path)

            if failed:
                # 条目一删，这两个文件就再没有任何记录指向它们；留着下次重试。
                kept_for_retry.append(key)
                warnings.append(
                    '\n'.join(
                        [
                            f'[清理未完成] {key}（{entry.book_id}）的产物删不掉，'
                            '清单条目保留以便下次重试：',
                            *(f'    - {item}' for item in failed),
                        ]
                    )
                )
                continue

            del self.entries[key]
            pruned.append(Pruned(key, entry.book_id, removed=tuple(removed)))

        if pruned:
            self.save()

        return PruneResult(
            pruned=tuple(pruned),
            kept_for_retry=tuple(kept_for_retry),
            warnings=tuple(warnings),
        )


# ---------------------------------------------------------------------------
# 加载
# ---------------------------------------------------------------------------


def load(
    path: Optional[Union[Path, str]] = None,
    books_dir: Optional[Union[Path, str]] = None,
    data_dir: Optional[Union[Path, str]] = None,
) -> Manifest:
    """读取清单。**任何读取问题都只降级 + 告警，不抛异常。**

    清单是可再生的缓存：丢了只是退化成全量重跑，不该让它把整批构建挡在门外。
    降级粒度尽量细——单条坏掉只重跑那一本。

    Args:
        path: 清单路径，默认 `DEFAULT_PATH`。
        books_dir: `.txt.gz` 目录，默认 `DEFAULT_BOOKS_DIR`。
        data_dir: `_toc.json` 目录，默认 `DEFAULT_DATA_DIR`。

    Returns:
        `Manifest`。文件不存在时是空清单且**无告警**——首次运行就是这样。
        其余降级情形（JSON 坏了、版本不认识、条目字段缺失）都会在
        `Manifest.warnings` 里留下一条，由编排层 `emit_warnings()` 输出。
    """
    target = Path(path) if path is not None else DEFAULT_PATH
    manifest = Manifest(
        path=target,
        books_dir=Path(books_dir) if books_dir is not None else DEFAULT_BOOKS_DIR,
        data_dir=Path(data_dir) if data_dir is not None else DEFAULT_DATA_DIR,
    )

    if not target.is_file():
        return manifest                      # 首次运行：空清单，不是异常

    try:
        raw = json.loads(target.read_text(encoding='utf-8'))
    except json.JSONDecodeError as exc:
        manifest.warnings.append(
            f'[清单损坏] {target} 不是合法 JSON（第 {exc.lineno} 行第 {exc.colno} 列'
            f' {exc.msg}），本次全部重新处理。'
        )
        return manifest
    except OSError as exc:
        manifest.warnings.append(f'[清单不可读] {target}（{exc}），本次全部重新处理。')
        return manifest

    if not isinstance(raw, dict):
        manifest.warnings.append(
            f'[清单损坏] {target} 的根必须是对象，实际是 {type(raw).__name__}，'
            '本次全部重新处理。'
        )
        return manifest

    version = raw.get(_VERSION_KEY)
    if version != MANIFEST_VERSION:
        manifest.warnings.append(
            f'[清单版本不符] {target} 记的是 {version!r}，当前为 {MANIFEST_VERSION}，'
            '整张表作废、本次全部重新处理。'
        )
        return manifest

    books = raw.get(_BOOKS_KEY)
    if not isinstance(books, dict):
        manifest.warnings.append(
            f'[清单损坏] {target} 的 "{_BOOKS_KEY}" 必须是对象，'
            f'实际是 {type(books).__name__}，本次全部重新处理。'
        )
        return manifest

    dropped: List[str] = []
    for key, value in books.items():
        if not isinstance(key, str) or not key.strip():
            dropped.append(f'{key!r}：键不是非空字符串')
            continue
        try:
            manifest.entries[key] = Entry.from_json(value)
        except ValueError as exc:
            dropped.append(f'{key}：{exc}')

    if dropped:
        manifest.warnings.append(
            '\n'.join(
                [
                    f'[清单条目丢弃] {target} 里有 {len(dropped)} 条记录不可用，'
                    '对应的书本次重新处理：',
                    *(f'    - {item}' for item in dropped),
                ]
            )
        )

    # 流水线换版的一次性告示：一条，不是 7,681 条。操作者最想在**开跑之前**就知道
    # "这次为什么不是全部跳过"，而不是等几小时后看汇总。
    stale = [
        entry for entry in manifest.entries.values()
        if entry.pipeline_version != PIPELINE_VERSION
    ]
    if stale:
        recorded = sorted(
            {'未记录' if entry.pipeline_version is None else str(entry.pipeline_version)
             for entry in stale}
        )
        manifest.warnings.append(
            '\n'.join(
                [
                    f'[流水线版本变更] {target} 里有 {len(stale)}/{len(manifest.entries)}'
                    f' 条记录是旧流水线产出的（记的是 {"、".join(recorded)}，'
                    f'当前 {PIPELINE_VERSION}）。',
                    '  这些书本次**全部重新处理**：源文件没变，但章节规则表/切分逻辑变了，'
                    '磁盘上的 _toc.json 是旧逻辑切出来的。',
                    '  条目本身仍然有效（prune 还要用），只是不再满足跳过条件。',
                ]
            )
        )

    return manifest
