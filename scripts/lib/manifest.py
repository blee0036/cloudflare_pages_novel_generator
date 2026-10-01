# -*- coding: utf-8 -*-
r"""增量清单（design §4.9，需求 7.3 / 7.4 / 7.5 / 7.12，任务 23 / 65）。

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

编排层（design §4.9）用到的主要口子：

```python
digest = manifest.sha256_file(src)
if mf.should_skip(src, digest):   # 需求 7.4：摘要一致 **且** 产物完整存在
    report.skipped(src); continue
...
mf.update(src, digest, meta)      # 需求 7.3：每本成功即落盘
...
for key, entry in mf.archived(sources):   # 需求 7.5：源已删除的书，产物与索引照旧
    gz_ok, toc_ok = mf.artifact_state(entry.book_id)
    ...
```

## 为什么要有清单（需求 D7）

7000 本、14.58 GB 源包全量重跑是小时级；改一本书、加一本书却要等整批，等于
没人会去跑它。摘要比对把"没变的书"压到一次 SHA-256（22 MB 的包约 30 ms），
这是 7000 本规模下能用/不能用的分界。

## 跳过必须两个条件同时成立（需求 7.4）

design §4.9 写的是 `manifest.unchanged(src, digest) and artifacts_exist(src)`。
本模块把这两半合进 `should_skip()`，因为**只查一半是会静默漏产物的**：清单说
"这本处理过"，而 `public/books/<id>.txt.gz` 已被手工删掉/磁盘满时写崩/被
误删——跳过它就等于让站点带着一个 404 的资源上线，且日志显示一切正常。
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

**例外是源文件已经删掉的书。**`--delete-source`（需求 7.12）处理完一本就删源包，
此后这本书只剩两份记录：`public/` 里的两个产物，和清单里的这一条。清单一丢，这些书
不会被重跑（没有源可跑），只会从 `books.json` 里消失。读取降级依旧只是告警——挡住
整批也找不回丢掉的记录——但编排层会在批次末尾点名"磁盘上有产物、索引里却没有"的书
（`preprocess` 的孤儿产物告警），不让这种丢失静默发生。所以删源模式下清单**不再是
可以随手删的缓存**，它是书库的一部分。

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

`MANIFEST_VERSION` 是另一件事，别混用：它管**文件格式**，不认识就整张表作废——
源文件已删除的书随之从索引里消失（它们只剩清单这一份记录）。所以改它必须同时写迁移，
不能简单 +1。流水线换版不该付这个代价：条目全都还有效，只是不再满足跳过条件而已。

## 清单放在仓库根，不放 `public/`

`.preprocess-manifest.json` 是**构建状态**，不是站点资源。放进 `public/` 会被
Vite 复制/硬链接进 `dist/` 跟着部署（design §4.1 的产物目录），白占需求 10.1 的
20000 文件配额，还把源包文件名与摘要一并发布出去。放仓库根 + 一条 `.gitignore`
最省事：它描述的 `public/books`、`public/data` 本身也是 gitignore 的本地产物，
两者同为"本机状态"，不该进版本库。

## 源文件删了，书还在（需求 7.5 修订）

旧版 `prune(sources)` 拿源目录做差集：源没了 = 书删了，连产物带条目一起清走。这条
语义与"处理完就删源包、省磁盘"（需求 7.12）正面冲突——删源之后的下一次运行会把
全库产物删光——所以改为：

- **源目录只是输入，不是书库的名单。**清单里有、源目录里没有的书叫"归档"
  （`archived()`）：产物照旧、`books.json` 照旧，只是不会再因为源文件变化而重跑。
- **流水线换版照样生效。**归档书没有源包可重跑，但 `.txt.gz` 里就是解码后的全文，
  编排层据此只重切章节（`preprocess.resplit_book`），不让 `PIPELINE_VERSION` 在删源
  之后悄悄失效。
- **要移除一本书，删它的产物。**归档书的两个产物都不在了 = 这本书没了，编排层用
  `forget()` 移除条目。只缺 `_toc.json` 时从 `.txt.gz` 重切；只缺 `.txt.gz` 时正文已
  无从恢复，告警、不进索引、条目保留（把源包放回来还能重建）。
- **本模块从不删产物文件。**唯一的删除动作是编排层在 `--delete-source` 下删**源包**，
  而且只在这本书的产物与清单记录都已落盘之后。

## `book_id` 在清单里唯一

两条记录指向同一组产物名，意味着其中一条的产物已经被另一条覆盖——它记的
`charCount`、`gzSize` 描述的是一组不存在的文件。源文件还在时这无伤大雅（重跑就好），
归档书却会带着这条假记录进索引，并在 `books.json` 里撞出重复 id。所以：

- `update()` 写入一条记录时，**移除**其他指向同一 `book_id` 的记录并告警（那组文件
  刚刚被覆盖）；
- `load()` 读到重复时保留 `processedAt` 最晚的那条（最后写那组文件的就是它），其余
  丢弃并告警。

有了这条不变量，编排层才能在逐本处理之前把清单里的 id 预先占住
（`report.Report.claim`），`book_id` 由"扫描顺序的函数"变成"一经分配就不变"。
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import IO, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple, Union

__all__ = [
    'DEFAULT_BOOKS_DIR',
    'DEFAULT_DATA_DIR',
    'DEFAULT_PATH',
    'GZ_SUFFIX',
    'MANIFEST_VERSION',
    'PIPELINE_VERSION',
    'TOC_SUFFIX',
    'Entry',
    'Manifest',
    'ManifestError',
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
#: 产物形态变了不要动它——那是 `PIPELINE_VERSION` 的事。作废整张表会让源文件已删除
#: 的书从索引里消失（见模块 docstring），改它必须同时写迁移。
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

#: 整张表作废时追加的一句：对源文件已删除的书，这不是"退化成全量重跑"。
_WHOLE_TABLE_LOST = (
    '\n  源文件已删除的书只有清单这一份记录：它们本次不会进 books.json'
    '（产物还在磁盘上，批次末尾的孤儿产物告警会列出它们）。'
)


class ManifestError(Exception):
    """清单**写入**失败，或调用方传入了不可能处理的元数据。

    只有真正该让这一本计入失败的情况才用它（见模块 docstring 末两段）：
    清单文件读坏了不属于此列——那是告警。
    """


# ---------------------------------------------------------------------------
# 命名与摘要
# ---------------------------------------------------------------------------


#: 两个产物的文件名后缀。`book_id` 与后缀直接拼接，反过来按后缀截掉就是 id。
GZ_SUFFIX = '.txt.gz'
TOC_SUFFIX = '_toc.json'


def gz_name(book_id: str) -> str:
    """整本正文的产物名：`<id>.txt.gz`。"""
    return f'{book_id}{GZ_SUFFIX}'


def toc_name(book_id: str) -> str:
    """单书章节索引的产物名：`<id>_toc.json`。"""
    return f'{book_id}{TOC_SUFFIX}'


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

    - `book_id`：两个产物名由它推出；源文件删掉之后，这本书进索引、重切章节都靠它
      （需求 7.5）。在整张清单里唯一（见模块 docstring）。
    - `digest`：跳过判定的依据（需求 7.4），也是识别"源文件只是改了名"的依据。
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

    @property
    def current(self) -> bool:
        """产物是否出自**当前**这版切分流水线（`PIPELINE_VERSION`）。`None` 不算。"""
        return self.pipeline_version == PIPELINE_VERSION

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
        也推不出产物名，留着只会制造"看起来处理过"的假象。其余字段容忍缺失——
        它们只影响汇总里的数字，不影响正确性（数字为 0 的归档书会从 `.txt.gz` 重切）。

        `pipelineVersion` **缺失不是错误**：`PIPELINE_VERSION` 之前写出的清单里都没
        有这个键。缺失读成 `None`，落到"旧版流水线"那一档，结果是重跑这一本——正是
        想要的行为，所以不必为此丢弃整条记录（丢了它，源文件已删除的书就从索引里
        消失了）。
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
                没有 `book_id` 就推不出产物名，这条记录写进去等于在索引里埋一颗
                哑弹。
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


def _usable(path: Path) -> bool:
    """产物"存在"的口径：是普通文件且非空（见模块 docstring"跳过必须两个条件"）。"""
    return path.is_file() and path.stat().st_size > 0


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
    """尚未输出的告警：加载期的（文件损坏、格式版本不符、条目被丢弃、id 重复、
    流水线换版），以及 `update()` 挤掉旧记录时的。`drain_warnings()` 取走。"""

    def __len__(self) -> int:
        return len(self.entries)

    def __contains__(self, src: Union[Path, str]) -> bool:
        return source_key(src) in self.entries

    def emit_warnings(self, stream: Optional[IO[str]] = None) -> None:
        """把积压的告警打到 stderr（默认）。无告警则什么都不做。"""
        _emit(self.warnings, stream)

    def drain_warnings(self) -> List[str]:
        """取走并清空积压的告警。编排层交给 `report.warn_all()`，条数才会进汇总。"""
        drained, self.warnings = self.warnings, []
        return drained

    # -- 查询 ---------------------------------------------------------------

    def entry_for(self, src: Union[Path, str]) -> Optional[Entry]:
        """取这本书上次的记录；清单里没有则 `None`。"""
        return self.entries.get(source_key(src))

    def artifacts_for(self, book_id: str) -> Tuple[Path, Path]:
        """这本书的两个产物路径：`(<books_dir>/<id>.txt.gz, <data_dir>/<id>_toc.json)`。"""
        return (self.books_dir / gz_name(book_id), self.data_dir / toc_name(book_id))

    def artifact_state(self, book_id: str) -> Tuple[bool, bool]:
        """`(.txt.gz 可用, _toc.json 可用)`。"可用" = 存在**且非空**（见模块 docstring）。

        归档书要分开看两半：缺 `_toc.json` 还能从 `.txt.gz` 重切，缺 `.txt.gz` 就只能
        等源包放回来（见模块 docstring"源文件删了，书还在"）。
        """
        gz_path, toc_path = self.artifacts_for(book_id)
        return _usable(gz_path), _usable(toc_path)

    def artifacts_exist(self, book_id: str) -> bool:
        """两个产物是否都存在**且非空**（见模块 docstring）。"""
        return all(self.artifact_state(book_id))

    def archived(self, sources: Iterable[Union[Path, str]]) -> List[Tuple[str, Entry]]:
        """清单里有、`sources` 里没有的书——源文件已删除的"归档书"，按键排序。

        Args:
            sources: 当前源目录里全部源文件（`archive.scan_source_dir` 的结果），只取文件名。

        空的 `sources` 不需要护栏：旧版 `prune` 在这里会把"全库都该删"当真，现在的结果
        只是"全库都按归档处理"——产物与索引一个都不动。
        """
        live = {source_key(item) for item in sources}
        return [(key, self.entries[key]) for key in sorted(self.entries) if key not in live]

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
        if not entry.current:
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
        if entry.current:
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

        其他指向同一 `book_id` 的记录会被移除并留一条告警：这组产物刚刚被本书覆盖，
        旧记录描述的已经是不存在的文件（见模块 docstring"`book_id` 在清单里唯一"）。
        """
        entry = Entry.from_meta(digest, meta)
        key = source_key(src)
        displaced = sorted(
            other for other, held in self.entries.items()
            if other != key and held.book_id == entry.book_id
        )
        for other in displaced:
            del self.entries[other]
        self.entries[key] = entry
        self.save()
        if displaced:
            self.warnings.append(
                f'[清单] 产物 "{entry.book_id}" 刚由 {key} 写出，原先记在 '
                f'{"、".join(displaced)} 名下的记录已移除：那组文件已被覆盖。'
                '源文件还在的话，下次运行会按新的 id 重建它。'
            )
        return entry

    def forget(self, src: Union[Path, str]) -> Optional[Entry]:
        """移除这本书的记录并落盘，返回被移除的记录；本就没有时返回 `None` 且不写文件。

        **不碰产物文件。**编排层只在归档书的两个产物都已不在时调它（见模块 docstring
        "要移除一本书，删它的产物"）。

        Raises:
            ManifestError: 清单写入失败。
        """
        entry = self.entries.pop(source_key(src), None)
        if entry is not None:
            self.save()
        return entry

    def rekey(self, old: Union[Path, str], new: Union[Path, str]) -> Entry:
        """源文件改了名：把 `old` 名下的记录原样挪到 `new` 名下，并落盘。

        `book_id`、摘要、流水线版本全都不变——内容一个字节没动，产物也就不必重做。

        Raises:
            KeyError: `old` 不在清单里。
            ManifestError: `new` 名下已有记录（那是另一本书，不许覆盖），或写入失败。
        """
        old_key, new_key = source_key(old), source_key(new)
        if new_key != old_key and new_key in self.entries:
            raise ManifestError(f'{new_key} 已有清单记录，不能把 {old_key} 的记录挪过去')
        entry = self.entries.pop(old_key)
        self.entries[new_key] = entry
        try:
            self.save()
        except ManifestError:
            # 没落盘就当没挪过：内存与文件各说各话，调用方的告警就会撒谎。
            del self.entries[new_key]
            self.entries[old_key] = entry
            raise
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


# ---------------------------------------------------------------------------
# 加载
# ---------------------------------------------------------------------------


def load(
    path: Optional[Union[Path, str]] = None,
    books_dir: Optional[Union[Path, str]] = None,
    data_dir: Optional[Union[Path, str]] = None,
) -> Manifest:
    """读取清单。**任何读取问题都只降级 + 告警，不抛异常。**

    对源文件还在的书，清单是可再生的缓存：丢了只是退化成全量重跑。源文件已删除的书
    只剩清单这一份记录，丢了就不进索引——但挡住整批也找不回它们，所以同样只告警，
    由编排层在批次末尾点名那些"有产物、没索引"的书（见模块 docstring）。
    降级粒度尽量细——单条坏掉只影响那一本。

    读到多条记录指向同一 `book_id` 时只留 `processedAt` 最晚的一条（见模块 docstring
    "`book_id` 在清单里唯一"）。

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
            f' {exc.msg}），本次全部重新处理。' + _WHOLE_TABLE_LOST
        )
        return manifest
    except OSError as exc:
        manifest.warnings.append(
            f'[清单不可读] {target}（{exc}），本次全部重新处理。' + _WHOLE_TABLE_LOST
        )
        return manifest

    if not isinstance(raw, dict):
        manifest.warnings.append(
            f'[清单损坏] {target} 的根必须是对象，实际是 {type(raw).__name__}，'
            '本次全部重新处理。' + _WHOLE_TABLE_LOST
        )
        return manifest

    version = raw.get(_VERSION_KEY)
    if version != MANIFEST_VERSION:
        manifest.warnings.append(
            f'[清单版本不符] {target} 记的是 {version!r}，当前为 {MANIFEST_VERSION}，'
            '整张表作废、本次全部重新处理。' + _WHOLE_TABLE_LOST
        )
        return manifest

    books = raw.get(_BOOKS_KEY)
    if not isinstance(books, dict):
        manifest.warnings.append(
            f'[清单损坏] {target} 的 "{_BOOKS_KEY}" 必须是对象，'
            f'实际是 {type(books).__name__}，本次全部重新处理。' + _WHOLE_TABLE_LOST
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

    duplicates = _dedupe_book_ids(manifest.entries)
    if duplicates:
        manifest.warnings.append(
            '\n'.join(
                [
                    f'[清单 id 重复] {target} 里有 {len(duplicates)} 条记录与别的记录指向'
                    '同一组产物，已丢弃（那组文件只属于最后写它的那一本）：',
                    *(f'    - {item}' for item in duplicates),
                    '  源文件还在的书下次按新的 id 重建；源文件已删除的，它的产物早已被覆盖。',
                ]
            )
        )

    # 流水线换版的一次性告示：一条，不是 7,681 条。操作者最想在**开跑之前**就知道
    # "这次为什么不是全部跳过"，而不是等几小时后看汇总。
    stale = [entry for entry in manifest.entries.values() if not entry.current]
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
                    '  条目本身仍然有效，只是不再满足跳过条件；源文件已删除的书按 .txt.gz '
                    '重切章节。',
                ]
            )
        )

    return manifest


def _dedupe_book_ids(entries: Dict[str, Entry]) -> List[str]:
    """同一 `book_id` 只留 `processedAt` 最晚的一条，**就地**删掉其余的，返回描述。

    最晚写那组产物的就是它；时间相同（或都没记）时按键取最后一个，只为结果确定。
    """
    holders: Dict[str, List[str]] = {}
    for key, entry in entries.items():
        holders.setdefault(entry.book_id, []).append(key)

    dropped: List[str] = []
    for book_id in sorted(holders):
        keys = holders[book_id]
        if len(keys) < 2:
            continue
        keep = max(keys, key=lambda item: (entries[item].processed_at, item))
        for key in sorted(keys):
            if key != keep:
                del entries[key]
                dropped.append(f'{key}（与 {keep} 同为 "{book_id}"，保留后者）')
    return dropped