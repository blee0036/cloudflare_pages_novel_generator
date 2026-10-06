#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""章节质量度量工具（design §4.10，需求 8.11 / 8.12，INV-4，任务 27）。

    python scripts/check_toc.py [--book <id>] [--data-dir <path>]
    # 或：python -m scripts.check_toc

逐本读 `public/data/<id>_toc.json`，输出一行指标：

```
书籍                  规则      章数   卷  中位字数  最短    最长  疑似误判  标题重复  兜底
青石巷-夜行           标准章节     5    1      1081   161    1246        0      0.0%  no
石桥夜话-青禾         标准章节   418    2      4186    37   18264        2      0.2%  no
```

## 它存在的理由：INV-4

「任何会被反复调参的逻辑（正则表格、编码探测），必须同时存在一个能输出统计指标的
检查工具，否则不允许扩张。」规则表（`lib/toc_rules.py` 的 15 条）与评分阈值
（`lib/toc.py` 的 5 个常量）正是那种逻辑：改一个负向排除集、动一档间隔门槛，
影响面是 7000 本书里"多认出几百个真标题"还是"多切出几百个空壳"，靠读代码判断不了。

流程因此是（design §11 验证层 4，需求 8.12）：**改规则表前跑一次、改完再跑一次、
人工 diff 两份输出**。所以这份输出的形态本身是一个契约——列、顺序、口径都要稳定，
换个写法就等于让所有历史基线失效。也是旧版 `check_chapters.py` 唯一被回收的东西
（需求 D13：回收它的**意图**，不回收它的实现）。

## 口径（需求 8.11 逐项）

| 列 | 含义 |
| --- | --- |
| 规则 | `_toc.json` 的 `tocRule`。`无规则` = 字段是 `null`（一条规则都没通过误报门槛，或全被篇幅门槛否掉）；`未记录` = 压根没有这个字段（任务 17 之前的旧产物） |
| 章数 | **非卷**节点数，即 `totalChapters` 的口径（design §2.1 不变量 4） |
| 卷 | `isVolume` 为真的节点数（需求 8.7 / 8.7a） |
| 中位字数 / 最短 / 最长 | 只统计**非卷**节点的 `length`。卷节点恒为 6–11 字符，混进来会把最短一列钉死在那儿，那一列就再也报不出"有正文章节短得可疑" |
| 疑似误判 | 非卷节点中 `length < 50` 或 `> CHAPTER_MAX`（10 万）的数量 |
| 标题重复 | `(参与统计的节点数 - 不同标题数) / 参与统计的节点数` |
| 兜底 | `_toc.json` 的 `fallback`（需求 8.9，全书兜底才为真） |

**疑似误判的上界直接 `from .lib.toc import CHAPTER_MAX`**，不抄一份 100_000：
`toc.split_overlong` 用同一个常量决定"这章要不要就地再切"，两处一旦漂开，这一列
报出的就不再是"逐章兜底没修掉的残留"，而是两个常量的差值。下界 50 是本模块独有的
（`MISJUDGE_MIN`）——`toc` 那边最接近的是 `VOLUME_BODY_MAX`（100，判卷用），
但那是"去掉标题行后的正文"，而这里量的是含标题行的 `length`，不是同一个量。

**标题重复率量的是"读者在目录里分不清"**。规则误匹到正文里的重复行（人物属性表、
分隔线、"未完待续"）时，标题会成批重复；靠 `length` 不一定看得出来——那些行彼此
间隔可能很正常。分母是"对象节点数"而不是章数：卷节点的标题同样出现在目录里
（需求 12.2 把它渲染成分组表头），重复的卷标题一样让人分不清。合成标题
（`序章 / 前言`、`第 N 部分`、`原标题(N)`、`第 N 节`）天然唯一或带编号，
不会把这个比率抬起来。

## 这个工具不做的三件事

1. **不做 schema 校验。**`lib/validate.py` 才是那个（任务 24，写入时把关）。这里
   连 `validate.check_toc()` 都不调，因为它对"缺 `tocRule`"判**硬错误**——而度量
   工具最常见的用法恰好是量**旧产物**（对比基线的"前"那一半）。度量工具因此一路
   容错：字段缺了就报 `未记录`，个别节点读不出长度就计进 `读不出` 并继续。
2. **不评好坏、不据此失败。**退出码只回答"有没有读到东西"（见 `EXIT_NO_DATA`）。
   有疑似误判的书照样是 0 退出——不然改规则表前的那次运行会直接红掉，
   需求 8.12 的前后对比就无从开始。
3. **不重跑管线。**只读 JSON，不解压、不解码、不切分。所以它不导入
   `scripts/preprocess.py`（那个文件顶层就跑 `require_dependencies()`，
   会为了一次只读的度量要求 `zopfli` / `py7zr` 装好），产物目录常量取自
   `lib/manifest`——与预处理写出的目录同一个来源。

## 列宽按**显示宽度**算，不按 `len()`

书籍 id 是中文，`len('青石巷-夜行')` 是 6 而终端占 11 格。design §4.10 那张
示意表就是按 `len()` padding 的，所以它在终端里是歪的。这里按东亚宽度
（`unicodedata.east_asian_width` 的 W/F 记 2 格）对齐——一张手工 diff 用的表，
列对不上就等于没有列。
"""

from __future__ import annotations

import argparse
import json
import sys
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from statistics import median_low
from typing import IO, Any, List, Mapping, Optional, Sequence, Tuple

# Windows 终端默认不是 UTF-8，整张表全是中文，不改会直接 UnicodeEncodeError。
if sys.stdout and hasattr(sys.stdout, 'reconfigure'):
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass

REPO_ROOT = Path(__file__).resolve().parent.parent

# 以脚本方式运行时（`python scripts/check_toc.py`）仓库根目录不在搜索路径上，
# `scripts.lib.*` 无法导入。补上根目录，使它与 `python -m scripts.check_toc` 等价
# （同 `preprocess.py`，见 `scripts/__init__.py`）。
if __package__ in (None, ''):
    sys.path.insert(0, str(REPO_ROOT))

from scripts.lib.manifest import DEFAULT_DATA_DIR, toc_name  # noqa: E402
from scripts.lib.toc import CHAPTER_MAX  # noqa: E402

__all__ = [
    'ALIGN',
    'COLUMNS',
    'DATA_DIR',
    'EXIT_NO_DATA',
    'EXIT_OK',
    'MISJUDGE_MIN',
    'Metrics',
    'MetricsError',
    'RULE_MISSING',
    'RULE_NONE',
    'TOC_SUFFIX',
    'book_ids',
    'format_table',
    'load_toc',
    'main',
    'measure',
    'measure_dir',
    'parse_args',
    'resolve_book',
    'run',
    'summary_lines',
]

#: 产物目录。取自 `manifest` 而不是自己拼 `public/data`——"预处理写到哪儿"与
#: "度量从哪儿读"必须是同一个常量，否则改了输出目录之后这个工具会安静地量旧产物。
DATA_DIR: Path = DEFAULT_DATA_DIR

#: `_toc.json` 的文件名后缀。由 `manifest.toc_name` 推出，命名规则只有那一处。
TOC_SUFFIX: str = toc_name('')

#: 疑似误判的下界：非卷节点 `length < 50`（需求 8.11，design §4.10）。
#: 真实的正文章节没有这么短的——实测旧产物里 length < 35 的"章节"全是人物属性表
#: 的单行（D5 的空章问题）。上界直接用 `toc.CHAPTER_MAX`，见模块 docstring。
MISJUDGE_MIN = 50

#: `tocRule` 是 `null`：择一时没有规则可用——一条都没通过误报门槛，或候选全被篇幅门槛
#: （`toc.Coverage`）否掉——这本走了全书兜底（需求 8.9）。反过来不成立：采样选中、
#: 全文被篇幅门槛否掉的书会**记着** `tocRule` 却 `fallback` 为真，兜底要看 `兜底` 列。
RULE_NONE = '无规则'

#: 压根没有 `tocRule` 字段：任务 17 之前的旧产物。对比基线时这是正常的一半。
RULE_MISSING = '未记录'

#: 表头。顺序即 design §4.10，外加 `标题重复`——需求 8.11 要它，那张示意表漏了。
COLUMNS: Tuple[str, ...] = (
    '书籍', '规则', '章数', '卷', '中位字数', '最短', '最长', '疑似误判', '标题重复', '兜底',
)

#: 每列的对齐方式，与 `COLUMNS` 一一对应。数字右对齐才能按位比大小。
ALIGN: Tuple[str, ...] = (
    'left', 'left', 'right', 'right', 'right', 'right', 'right', 'right', 'right', 'left',
)

#: 退出码。度量工具不评好坏，只回答"有没有读到东西"（见模块 docstring 第 2 条）。
EXIT_OK = 0
EXIT_NO_DATA = 1


class MetricsError(Exception):
    """这份 `_toc.json` 连"能数"都做不到（不是对象、或没有 `chapters` 数组）。

    单本抛出不终止整批：`measure_dir` 记下来继续量下一本，与 `report.fail` 同一取向。
    """


# ---------------------------------------------------------------------------
# 显示宽度
# ---------------------------------------------------------------------------


def _width(text: str) -> int:
    """字符串在等宽终端里占的格数（东亚宽字符记 2 格）。

    `W`（宽）与 `F`（全角）是确定占两格的两类；`A`（ambiguous，主要是希腊字母与
    制表符号）按 1 格算——它在中文环境下确实常被渲染成 2 格，但书籍 id 里不会出现，
    为它引一个 locale 相关的分支只会让列宽随环境漂。
    """
    return sum(2 if unicodedata.east_asian_width(char) in 'WF' else 1 for char in text)


def _pad(text: str, width: int, align: str) -> str:
    """把 `text` 垫到 `width` 格（按显示宽度，不按 `len()`）。"""
    fill = ' ' * max(0, width - _width(text))
    return fill + text if align == 'right' else text + fill


def _num(value: int) -> str:
    """整数的显示形式。不加千分位：这张表是拿去 diff 的，逗号只会加长每一列。"""
    return str(value)


# ---------------------------------------------------------------------------
# 一本书的指标
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Metrics:
    """一本书的章节质量指标（需求 8.11 的全部七项 + 定位用的书名/字数）。

    字段是"数出来的原始量"，比率与合计都做成 property——前后对比时人眼盯的是
    `too_short` / `too_long` 这类能直接指向某一类误判的数，而不是一个合成分数。
    """

    book_id: str
    """产物 id，即 `<id>_toc.json` 去掉后缀。"""

    title: str
    """书名，取不到时退回 `book_id`。"""

    rule: Optional[str] = None
    """命中的规则名；`None` = 字段是 `null`（无规则可用）。"""

    rule_recorded: bool = True
    """`tocRule` 字段是否存在。为假 = 任务 17 之前的旧产物。"""

    fallback: bool = False
    """是否触发了全书兜底（需求 8.9）。"""

    char_count: int = 0
    """`charCount`，只用于汇总行。"""

    nodes: int = 0
    """`chapters` 数组的长度（正文 + 卷 + 读不出的）。"""

    chapters: int = 0
    """非卷且长度可用的节点数，即 `totalChapters` 的口径。"""

    volumes: int = 0
    """`isVolume` 为真的节点数。"""

    broken: int = 0
    """读不出的节点数：不是对象，或 `length` 与 `end - start` 都取不到。
    真实产物里应当恒为 0——`validate.py` 在写入时就会拒绝它们。"""

    median: int = 0
    """非卷章字数的中位数（`median_low`，见 `measure`）。没有正文章节时 0。"""

    shortest: int = 0
    longest: int = 0

    too_short: int = 0
    """非卷节点里 `length < MISJUDGE_MIN` 的数量。"""

    too_long: int = 0
    """非卷节点里 `length > CHAPTER_MAX` 的数量（逐章兜底没修掉的残留）。"""

    title_nodes: int = 0
    """参与标题重复统计的节点数（全部对象节点，含卷）。"""

    unique_titles: int = 0
    """不同标题的数量。"""

    @property
    def misjudged(self) -> int:
        """疑似误判数（需求 8.11）：过短 + 过长。"""
        return self.too_short + self.too_long

    @property
    def duplicate_titles(self) -> int:
        """重复的标题数（同一标题出现 n 次记 n-1）。"""
        return self.title_nodes - self.unique_titles

    @property
    def duplicate_rate(self) -> float:
        """标题重复率（需求 8.11），取值 `[0, 1)`。没有节点时 0.0。"""
        if self.title_nodes <= 0:
            return 0.0
        return self.duplicate_titles / self.title_nodes

    @property
    def rule_label(self) -> str:
        """`规则` 列的显示值。"""
        if not self.rule_recorded:
            return RULE_MISSING
        return self.rule if self.rule else RULE_NONE

    def cells(self) -> Tuple[str, ...]:
        """这本书在表里的一行，与 `COLUMNS` 一一对应。"""
        return (
            self.book_id,
            self.rule_label,
            _num(self.chapters),
            _num(self.volumes),
            _num(self.median),
            _num(self.shortest),
            _num(self.longest),
            _num(self.misjudged),
            f'{self.duplicate_rate * 100:.1f}%',
            'yes' if self.fallback else 'no',
        )


def _int(value: Any) -> Optional[int]:
    """整数或 `None`。`bool` 不算——`True` 当 1 用会让一个写错的字段悄悄通过。"""
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def _length(chapter: Mapping[str, Any]) -> Optional[int]:
    """章节长度：优先 `length`，退而 `end - start`，都取不到则 `None`。

    产物里这两者恒等（`validate` 的不变量 3 就是这条），所以退路平时用不上。
    留着它只为一件事：一个写坏的 `length` 字段不该让整本书的度量作废——而度量工具
    的活正是在这种时候还能报出数字来。
    """
    length = _int(chapter.get('length'))
    if length is not None and length > 0:
        return length
    start = _int(chapter.get('start'))
    end = _int(chapter.get('end'))
    if start is not None and end is not None and end > start:
        return end - start
    return None


def measure(data: Any, book_id: str = '') -> Metrics:
    """把一份 `_toc.json` 数成一行指标（需求 8.11）。

    Args:
        data: `json.loads` 的结果。
        book_id: 文件名推出的 id，用于 `data` 里的 `id` 缺失/不是字符串时兜底。

    Returns:
        `Metrics`。

    Raises:
        MetricsError: 不是对象，或 `chapters` 不是数组——"能数"的前提都不成立。
            其余任何字段问题一律容错（见模块 docstring"不做 schema 校验"）。

    中位数用 `median_low` 而不是 `statistics.median`：偶数本数时后者取两个中间值的
    平均，会造出一个**这本书里并不存在**的章长（还带 `.5`）。这张表是拿去手工 diff
    的，一个真实存在的章长比一个数学上更居中的小数有用。
    """
    if not isinstance(data, Mapping):
        raise MetricsError(f'不是 JSON 对象，而是 {type(data).__name__}')
    raw_chapters = data.get('chapters')
    if not isinstance(raw_chapters, list):
        kind = 'chapters 字段不存在' if 'chapters' not in data else (
            f'chapters 不是数组，而是 {type(raw_chapters).__name__}'
        )
        raise MetricsError(kind)

    lengths: List[int] = []
    titles: List[str] = []
    volumes = broken = too_short = too_long = 0

    for chapter in raw_chapters:
        if not isinstance(chapter, Mapping):
            broken += 1
            continue
        title = chapter.get('title')
        titles.append(title if isinstance(title, str) else '')
        if chapter.get('isVolume'):
            # 卷节点不进字数统计：它恒为 6–11 字符，混进来会把"最短"一列钉死。
            volumes += 1
            continue
        length = _length(chapter)
        if length is None:
            broken += 1
            continue
        lengths.append(length)
        if length < MISJUDGE_MIN:
            too_short += 1
        elif length > CHAPTER_MAX:
            too_long += 1

    # 产物里的 `id` / `title` 缺了也得有个能定位的名字——第一列就是它。
    recorded_id = data.get('id')
    recorded_title = data.get('title')
    label = recorded_id if isinstance(recorded_id, str) and recorded_id else (book_id or '?')
    rule = data.get('tocRule')

    return Metrics(
        book_id=label,
        title=recorded_title if isinstance(recorded_title, str) and recorded_title else label,
        rule=rule if isinstance(rule, str) and rule.strip() else None,
        rule_recorded='tocRule' in data,
        fallback=data.get('fallback') is True,
        char_count=_int(data.get('charCount')) or 0,
        nodes=len(raw_chapters),
        chapters=len(lengths),
        volumes=volumes,
        broken=broken,
        median=median_low(lengths) if lengths else 0,
        shortest=min(lengths) if lengths else 0,
        longest=max(lengths) if lengths else 0,
        too_short=too_short,
        too_long=too_long,
        title_nodes=len(titles),
        unique_titles=len(set(titles)),
    )


# ---------------------------------------------------------------------------
# 读产物
# ---------------------------------------------------------------------------


def load_toc(path: Path) -> Any:
    """读一份 `_toc.json`。

    Raises:
        MetricsError: 文件读不了或不是合法 JSON。调用方据此记下这一本并继续。
    """
    try:
        return json.loads(Path(path).read_text(encoding='utf-8'))
    except OSError as exc:
        raise MetricsError(f'读不到文件：{exc}') from exc
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise MetricsError(f'不是合法的 UTF-8 JSON：{exc}') from exc


def book_ids(data_dir: Path) -> List[str]:
    """产物目录里全部书籍 id，按 id 排序。

    排序是**稳定输出**的一半：前后两次运行的表要能直接 diff，行序不能跟着文件系统
    的枚举顺序走（`books.json` 那类非书产物天然被 `*_toc.json` 的模式排除）。
    """
    suffix = len(TOC_SUFFIX)
    return sorted(
        path.name[:-suffix]
        for path in Path(data_dir).glob(f'*{TOC_SUFFIX}')
        if path.is_file() and len(path.name) > suffix
    )


def resolve_book(wanted: str, ids: Sequence[str]) -> str:
    """把 `--book` 的值解析成一个确切的 id（需求 8.11 的"只看单本"）。

    Args:
        wanted: 用户给的值。允许直接粘贴文件名/路径（`…/青石巷-夜行_toc.json`）
            ——那是从日志里复制时最顺手的形态。
        ids: 目录里现有的 id。

    Returns:
        确切的 id。

    Raises:
        LookupError: 没匹配上，或子串匹配到多本。消息里带上可选项，
            省掉"再 `ls` 一次产物目录"这一步。

    匹配顺序：完全相同 → 忽略大小写相同 → 唯一的子串命中。子串是刻意留的：
    id 形如 `书名-作者`，只记得书名时 `--book 青石巷` 就该能用。
    """
    key = Path(wanted.strip()).name
    if key.endswith(TOC_SUFFIX):
        key = key[: -len(TOC_SUFFIX)]
    if not key:
        raise LookupError('--book 不能为空')

    if key in ids:
        return key
    folded = [book_id for book_id in ids if book_id.lower() == key.lower()]
    if len(folded) == 1:
        return folded[0]

    hits = [book_id for book_id in ids if key.lower() in book_id.lower()]
    if len(hits) == 1:
        return hits[0]
    if len(hits) > 1:
        raise LookupError(
            f'--book "{wanted}" 匹配到 {len(hits)} 本，请写全 id：\n'
            + '\n'.join(f'    - {book_id}' for book_id in hits)
        )
    lines = [f'--book "{wanted}" 在产物目录里没有对应的 {TOC_SUFFIX}。']
    if ids:
        lines.append(f'现有 {len(ids)} 本：')
        lines += [f'    - {book_id}' for book_id in ids]
    raise LookupError('\n'.join(lines))


def measure_dir(
    data_dir: Path,
    book: Optional[str] = None,
    err: Optional[IO[str]] = None,
) -> Tuple[List[Metrics], List[Tuple[str, str]]]:
    """量一个产物目录，返回 `(指标行, 失败列表)`。

    Args:
        data_dir: 产物目录。
        book: 只量这一本（`--book`）；`None` 量全部。
        err: 失败信息的输出流，默认 `sys.stderr`。

    Returns:
        `(rows, failures)`，`failures` 的元素是 `(book_id, 原因)`。

    Raises:
        LookupError: `book` 解析不到（消息里带可选项，见 `resolve_book`）。

    单本读坏不终止其余的书：度量工具最该出场的时刻就是"产物里有东西不对"，
    这时候整个表打不出来才是最没用的行为（同 `report.fail` 的取向，需求 7.1）。
    """
    stream = err if err is not None else sys.stderr
    ids = book_ids(data_dir)
    if book is not None:
        ids = [resolve_book(book, ids)]

    rows: List[Metrics] = []
    failures: List[Tuple[str, str]] = []
    for book_id in ids:
        path = Path(data_dir) / toc_name(book_id)
        try:
            rows.append(measure(load_toc(path), book_id))
        except MetricsError as exc:
            failures.append((book_id, str(exc)))
            print(f'[读不出] {path.name}：{exc}', file=stream)
    return rows, failures


# ---------------------------------------------------------------------------
# 输出
# ---------------------------------------------------------------------------


def format_table(rows: Sequence[Metrics]) -> List[str]:
    """把指标行排成对齐的表（design §4.10）。首行是表头。

    列宽按显示宽度算（见模块 docstring 末节）。行尾不留空白——这张表是拿去 diff 的，
    尾随空格只会让无关的改动也显示成差异。
    """
    cells = [COLUMNS, *(row.cells() for row in rows)]
    widths = [max(_width(row[i]) for row in cells) for i in range(len(COLUMNS))]
    return [
        '  '.join(
            _pad(value, widths[i], ALIGN[i]) for i, value in enumerate(row)
        ).rstrip()
        for row in cells
    ]


def summary_lines(rows: Sequence[Metrics]) -> List[str]:
    """合计与口径说明。合计那一行是"这次比上次好没好"的第一眼。"""
    if not rows:
        return []
    total_chapters = sum(row.chapters for row in rows)
    total_volumes = sum(row.volumes for row in rows)
    misjudged = sum(row.misjudged for row in rows)
    too_short = sum(row.too_short for row in rows)
    too_long = sum(row.too_long for row in rows)
    duplicates = sum(row.duplicate_titles for row in rows)
    fallbacks = [row for row in rows if row.fallback]
    broken = sum(row.broken for row in rows)
    unrecorded = [row for row in rows if not row.rule_recorded]

    lines = [
        '-' * 60,
        f'[合计] {len(rows)} 本 · 正文 {total_chapters:,} 章 · 卷 {total_volumes:,} · '
        f'疑似误判 {misjudged}（过短 {too_short} / 过长 {too_long}）· '
        f'标题重复 {duplicates} 处 · 兜底 {len(fallbacks)} 本',
        f'[口径] 疑似误判 = 非卷章节 length < {MISJUDGE_MIN} 或 > {CHAPTER_MAX:,}'
        '（toc.CHAPTER_MAX）；中位/最短/最长只统计非卷章节；'
        '标题重复率 = (节点数 - 不同标题数) / 节点数。',
    ]
    if fallbacks:
        lines.append(
            '[兜底] ' + '、'.join(row.book_id for row in fallbacks)
            + ' 走了全书兜底（需求 8.9）：一条规则都没通过误报门槛，'
            '或选中的规则被篇幅门槛（toc.Coverage：命中过稀，或可读节点覆盖不足全书 30%）'
            '否掉——后者可能仍记着 tocRule；'
            '章节是按段落块切的，标题为「第 N 部分」。'
        )
    if unrecorded:
        lines.append(
            f'[规则未记录] {len(unrecorded)} 本产物里没有 tocRule 字段，'
            '是任务 17 之前生成的旧产物；重跑 scripts/preprocess.py 后这一列才有值。'
            '（对比基线时这是正常的一半。）'
        )
    if broken:
        lines.append(
            f'[读不出] 共 {broken} 个节点的长度取不到（既没有合法的 length，'
            '也算不出 end - start），已排除在字数统计之外。'
            '正常产物里这个数恒为 0——validate.py 在写入时就会拒绝它们。'
        )
    return lines


def run(
    data_dir: Optional[Path] = None,
    book: Optional[str] = None,
    out: Optional[IO[str]] = None,
    err: Optional[IO[str]] = None,
) -> int:
    """跑一次度量，返回退出码（**不抛 `SystemExit`**，由 `main()` 负责）。

    Args:
        data_dir: 产物目录，默认 `DATA_DIR`。
        book: 只量这一本（`--book`）。
        out: 表格的输出流，默认 `sys.stdout`。
        err: 提示与失败的输出流，默认 `sys.stderr`。

    Returns:
        `EXIT_OK`（0）读到了东西；`EXIT_NO_DATA`（1）目录不存在 / 没有产物 /
        `--book` 没匹配上 / 有产物读不出来。**指标本身再差也不影响退出码**
        （见模块 docstring 第 2 条）。
    """
    directory = Path(DATA_DIR if data_dir is None else data_dir)
    sink = out if out is not None else sys.stdout
    problems = err if err is not None else sys.stderr

    if not directory.is_dir():
        print(
            f'[错误] 产物目录不存在：{directory}\n'
            '  public/data 是 gitignore 的本地产物，先跑一次 '
            'python scripts/preprocess.py 生成它。',
            file=problems,
        )
        return EXIT_NO_DATA

    try:
        rows, failures = measure_dir(directory, book, problems)
    except LookupError as exc:
        print(f'[错误] {exc}', file=problems)
        return EXIT_NO_DATA

    if not rows:
        if not failures:
            print(
                f'[错误] {directory} 里没有任何 *{TOC_SUFFIX}：'
                '先跑一次 python scripts/preprocess.py。',
                file=problems,
            )
        return EXIT_NO_DATA

    for line in format_table(rows):
        print(line, file=sink)
    for line in summary_lines(rows):
        print(line, file=sink)
    try:
        sink.flush()
    except Exception:
        pass

    return EXIT_NO_DATA if failures else EXIT_OK


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    """解析命令行。"""
    parser = argparse.ArgumentParser(
        prog='check_toc.py',
        description='章节质量度量：逐本输出规则名、章数/卷数、章字数分布、'
                    '疑似误判数、标题重复率与是否兜底（需求 8.11）。',
        epilog='改规则表前后各跑一次、diff 两份输出，即需求 8.12 的前后对比。',
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        '--book',
        metavar='<id>',
        help='只看单本。可写全 id、只写书名（唯一子串即可），或直接粘贴 '
             f'<id>{TOC_SUFFIX} 文件名。',
    )
    parser.add_argument(
        '--data-dir',
        metavar='<path>',
        type=Path,
        default=DATA_DIR,
        help=f'产物目录，默认 {DATA_DIR}。指向一份改造前的产物副本，'
             '就能让"前后对比"两份输出在同一台机器上先后跑出来。',
    )
    return parser.parse_args(argv)


def main(argv: Optional[Sequence[str]] = None) -> int:
    """入口：解析参数、跑一次度量并返回退出码。"""
    args = parse_args(argv)
    return run(data_dir=args.data_dir, book=args.book)


if __name__ == '__main__':
    raise SystemExit(main())
