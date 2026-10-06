# -*- coding: utf-8 -*-
r"""合集包：一个源包里有好几个 `.txt` 时，定并入顺序、起册名。

编排层把包里全部非空 `.txt`（`archive.extract_txt_members`）交给 `plan()`，拿回并入顺序；
每一册在目录里是一个卷节点，册名由 `volume_title()` 从文件名起。切章与拼接在
`preprocess.py`，本模块只看文件名与体积，是纯函数。

## 排序：三层判据，前一层判不出才用下一层

1. **包名里用 `+` 列出了顺序**（`《甲+乙续》`）：看每个文件名对应第几段。先认完全相等，
   再在剩下的段里认包含关系（任一方向）——所以 `《青石巷+巷续》` 里的 `青石巷.txt` 先认走
   第 1 段，`青石巷续.txt` 才落到第 2 段，不会因为也包含"青石巷"而抢第 1 段。
2. **同一主干加结尾序号**（`青石巷1` … `青石巷5`）：去掉书名号、版本注记、`作者：…`
   之后取结尾的序号（阿拉伯数字、中文数字、`第N部/卷/册`、上中下）。主干允许带前缀：
   `441青石巷5` 的主干 `441青石巷` 以 `青石巷` 结尾，照样归进这一组、按 5 排——开头那串
   数字不参与排序。同名不带序号的文件算第 0 册（正篇排在续作前）。
3. **兜底：最大的是正文**，排第一；其余按文件名自然序跟在后面。

前两层没认领的文件（"作品相关"、外传、资料）一律按文件名自然序排在最后。

单用任何一种朴素判据都会排错：只按文件名排，`441青石巷5` 排到第一、`《岳…》` 排在
`《金…》` 前（码位序）；只按体积排，续作比正篇大的合订本就从续作开始。

## 没把握的时候告警

副文件（前两层没认领、或第 3 层里除正文外的）体量达到最大文件的 `UNSURE_SHARE` 时，
它可能是一本独立的书、也可能是该排在前面的前传或"前情提要"——只看文件名与体积分不出来。
这种情况照常并入（排在后面），但 `Plan.unsure` 点名它们，编排层打一条告警，人工核对后
在本机覆盖表里写 `order`。小于这个比例的副文件是后记、外传、资料一类，排在最后没有争议。

## 覆盖表的 `order`

本机覆盖表可以给一本书写 `{"order": ["第一个.txt", "第二个.txt", …]}`（`toc_overrides`）。
给了就完全按它来：名字按包内路径或文件名（不含目录）匹配，**没列出的文件不并入**——这是
排除广告/重复文件的唯一办法。列出的名字对不上包里的文件时抛 `BundleError`，这本书失败，
报错里列出包里实际有哪些文件；不退回自动排序，理由与规则名写错时一样（`toc_overrides`
模块 docstring"为什么校验在加载期、且是硬失败"）。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Dict, List, Optional, Sequence, Tuple

from . import toc

__all__ = [
    'METHOD_OVERRIDE',
    'METHOD_PLUS',
    'METHOD_SERIES',
    'METHOD_SINGLE',
    'METHOD_SIZE',
    'UNSURE_SHARE',
    'BundleError',
    'Member',
    'Plan',
    'match_key',
    'plan',
    'volume_title',
]

#: 副文件体量达到最大文件的这个比例，就算"顺序没把握"（见模块 docstring）。
#: 实测全库多 txt 的包里，后记/外传/资料类副文件都在正文的 5% 以下；够得上 20% 的
#: 副文件体量已经是一本书，排前排后只看文件名判断不了。
UNSURE_SHARE = 0.2

#: `Plan.method` 的取值，原样写进日志。
METHOD_SINGLE = '只有一个文件'
METHOD_OVERRIDE = '覆盖表点名'
METHOD_PLUS = '包名用 + 列出'
METHOD_SERIES = '同名加序号'
METHOD_SIZE = '最大的是正文'


class BundleError(ValueError):
    """覆盖表点名的顺序与包里的文件对不上。是**这一本书**的失败，不是配置错误——
    加载覆盖表时还不知道包里有哪些文件。"""


@dataclass(frozen=True)
class Member:
    """包里的一个 `.txt`：包内路径（`/` 分隔）与字节数。"""

    name: str
    size: int

    @property
    def basename(self) -> str:
        return PurePosixPath(self.name).name


@dataclass(frozen=True)
class Plan:
    """并入方案。"""

    order: Tuple[Member, ...]
    """并入顺序，至少一项。"""

    excluded: Tuple[Member, ...]
    """不并入的文件。只有覆盖表 `order` 会产生——自动排序从不丢文件。"""

    method: str
    """定顺序用的判据（`METHOD_*`），写进日志。"""

    unsure: Tuple[Member, ...] = ()
    """顺序没把握的副文件（见模块 docstring），编排层据此告警。"""


# ---------------------------------------------------------------------------
# 文件名 → 比对用的形态
# ---------------------------------------------------------------------------

_TXT_SUFFIX = re.compile(r'\.txt$', re.IGNORECASE)
_AUTHOR_TAIL = re.compile(r'作者[:：].*$')

#: 序号：阿拉伯数字（含全角）、中文数字、上中下。
_ORDINAL = r'(?:\d+|[零〇一二三四五六七八九十百两]+|[上中下])'

#: 括号注记。内容是序号（`(2)`、`（第三部）`、`（上）`）就保留内容，否则（`（校对版全本）`）删掉。
_NOTE = re.compile(r'[（(]([^（）()]*)[）)]')
_ORDINAL_NOTE = re.compile(rf'^\s*(?:第\s*)?{_ORDINAL}\s*[部卷册集篇季]?\s*$')

#: 比对时去掉的符号：书名号、方括号类、空白。
_MARKS = re.compile(r'[《》〈〉【】〖〗〔〕「」『』\[\]［］\s]')

#: 结尾的序号。主干非贪婪，所以 `441青石巷5` 得到主干 `441青石巷`、序号 `5`。
_TAIL = re.compile(rf'^(?P<stem>.*?)(?:第)?(?P<num>{_ORDINAL})[部卷册集篇季]?$')

_PLUS = re.compile(r'[+＋]')
_LEADING_TITLE = re.compile(r'^\s*《([^》]+)》')
_DIGITS = re.compile(r'(\d+)')

_CN_DIGIT: Dict[str, int] = {
    '零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4,
    '五': 5, '六': 6, '七': 7, '八': 8, '九': 9,
}
_CN_UNIT: Dict[str, int] = {'十': 10, '百': 100}
_UPPER_MIDDLE_LOWER: Dict[str, int] = {'上': 1, '中': 2, '下': 3}


def _stem(name: str) -> str:
    """包内路径 → 去掉目录与 `.txt` 的文件名。"""
    return _TXT_SUFFIX.sub('', PurePosixPath(name.replace('\\', '/')).name)


def _drop_notes(text: str, unwrap: bool = True) -> str:
    """删版本注记（`（校对版全本）`）、去作者尾巴。

    序号注记（`(2)`、`（上）`）保留：`unwrap` 为真时只去括号（比对用，`青石巷(2)` →
    `青石巷2`，结尾序号才认得出），为假时原样保留（册名用，`青石巷（上）` 比 `青石巷上` 好读）。
    """
    text = _AUTHOR_TAIL.sub('', text)

    def replace(match: 're.Match[str]') -> str:
        if not _ORDINAL_NOTE.match(match.group(1)):
            return ''
        return match.group(1).strip() if unwrap else match.group(0)

    return _NOTE.sub(replace, text)


def match_key(text: str) -> str:
    """文件名或包名里的一段 → 比对用的形态。

    `《青石巷》（校对版全本）作者：某甲` → `青石巷`；`青石巷(2)` → `青石巷2`。
    """
    return _MARKS.sub('', _drop_notes(_stem(text)))


def _ordinal_value(token: str) -> int:
    """`_ORDINAL` 匹配到的序号 → 整数。"""
    if token.isdecimal():
        return int(token)
    if token in _UPPER_MIDDLE_LOWER:
        return _UPPER_MIDDLE_LOWER[token]
    if not any(char in _CN_UNIT for char in token):
        # 没有十/百的连写（`二〇`）：逐位拼
        return int(''.join(str(_CN_DIGIT[char]) for char in token))
    total, digit = 0, None
    for char in token:
        if char in _CN_UNIT:
            total += (digit if digit is not None else 1) * _CN_UNIT[char]
            digit = None
        else:
            digit = _CN_DIGIT[char]
    return total + (digit or 0)


def _natural_key(member: Member) -> Tuple[Tuple[int, int, str], ...]:
    """文件名自然序：数字段按数值比。"""
    return tuple(
        (1, int(part), '') if part.isdecimal() else (0, 0, part)
        for part in _DIGITS.split(member.name)
        if part
    )


# ---------------------------------------------------------------------------
# 三层判据
# ---------------------------------------------------------------------------


def _by_plus(title: str, members: Sequence[Member]) -> Optional[List[Member]]:
    """第 1 层：包名里用 `+` 列出了顺序。认领到的少于 2 个就判不出，返回 `None`。"""
    parts = [match_key(part) for part in _PLUS.split(title)]
    if len([part for part in parts if part]) < 2:
        return None
    keys = {member: match_key(member.name) for member in members}
    assigned: Dict[int, Member] = {}

    # 先认完全相等，再在剩下的段里认包含关系（见模块 docstring）
    for member in members:
        for index, part in enumerate(parts):
            if part and index not in assigned and keys[member] == part:
                assigned[index] = member
                break
    taken = set(assigned.values())
    for member in members:
        key = keys[member]
        if member in taken or not key:
            continue
        hits = [
            index for index, part in enumerate(parts)
            if part and index not in assigned and (part in key or key in part)
        ]
        if len(hits) == 1:
            assigned[hits[0]] = member
            taken.add(member)

    if len(assigned) < 2:
        return None
    return [assigned[index] for index in sorted(assigned)]


def _by_series(members: Sequence[Member]) -> Optional[List[Member]]:
    """第 2 层：同一主干加结尾序号。凑不出 2 个序号互不相同的成员就返回 `None`。

    候选主干取自每个带序号成员的主干；以候选主干结尾的成员都算这一组（容忍前缀）。
    组员最多的主干胜出；同样多时取总体积更大的一组（正文那一组，而不是"附录1/附录2"），
    再一样取更长的主干（更具体）。
    """
    parsed = []
    for member in members:
        key = match_key(member.name)
        parsed.append((member, key, _TAIL.match(key)))

    best: Optional[Tuple[Tuple[int, int, int], List[Tuple[int, Member]]]] = None
    stems = sorted({hit.group('stem') for _, _, hit in parsed if hit})
    for stem in stems:
        series: List[Tuple[int, Member]] = []
        for member, key, hit in parsed:
            if key == stem and stem:
                series.append((0, member))
            elif hit and hit.group('stem').endswith(stem):
                series.append((_ordinal_value(hit.group('num')), member))
        numbers = [number for number, _ in series]
        if len(series) < 2 or len(set(numbers)) != len(numbers):
            continue
        rank = (len(series), sum(member.size for _, member in series), len(stem))
        if best is None or rank > best[0]:
            best = (rank, series)

    if best is None:
        return None
    return [member for _, member in sorted(best[1], key=lambda item: item[0])]


def _forced(order: Sequence[str], members: Sequence[Member]) -> Tuple[List[Member], List[Member]]:
    """覆盖表的 `order`：逐个匹配包内路径或文件名，返回 `(并入, 不并入)`。"""
    listing = '\n'.join(f'    - {member.name}（{member.size:,} B）' for member in members)
    picked: List[Member] = []
    for wanted in order:
        exact = [member for member in members if member.name == wanted]
        candidates = exact or [member for member in members if member.basename == wanted]
        if not candidates:
            raise BundleError(
                f'覆盖表 order 里的 "{wanted}" 在包里找不到。包里的 .txt：\n{listing}'
            )
        if len(candidates) > 1:
            raise BundleError(
                f'覆盖表 order 里的 "{wanted}" 在包里对上了 {len(candidates)} 个文件'
                f'（不同目录下同名），请写包内完整路径。包里的 .txt：\n{listing}'
            )
        if candidates[0] in picked:
            raise BundleError(
                f'覆盖表 order 把 "{candidates[0].name}" 列了两次。包里的 .txt：\n{listing}'
            )
        picked.append(candidates[0])
    excluded = [member for member in members if member not in picked]
    return picked, excluded


def plan(
    title: str,
    members: Sequence[Member],
    forced: Optional[Sequence[str]] = None,
) -> Plan:
    """定并入顺序。

    Args:
        title: 书名（取自**压缩包**文件名，`preprocess.parse_filename_meta` 的那个），第 1 层看它。
        members: 包里全部非空 `.txt`。
        forced: 本机覆盖表给这本书写的 `order`；`None` 表示没写，自动排序。

    Raises:
        ValueError: `members` 为空（调用方的 bug：`archive` 不会交出空列表）。
        BundleError: `forced` 对不上包里的文件。
    """
    if not members:
        raise ValueError('合集排序拿到了空的成员列表')
    members = sorted(members, key=lambda member: member.name)

    if forced is not None:
        picked, excluded = _forced(forced, members)
        return Plan(tuple(picked), tuple(excluded), METHOD_OVERRIDE)
    if len(members) == 1:
        return Plan((members[0],), (), METHOD_SINGLE)

    ordered = _by_plus(title, members)
    method = METHOD_PLUS
    if ordered is None:
        ordered = _by_series(members)
        method = METHOD_SERIES
    if ordered is None:
        ordered = [min(members, key=lambda member: (-member.size, member.name))]
        method = METHOD_SIZE

    extras = sorted((member for member in members if member not in ordered), key=_natural_key)
    largest = max(member.size for member in members)
    unsure = tuple(member for member in extras if member.size >= largest * UNSURE_SHARE)
    return Plan(tuple(ordered) + tuple(extras), (), method, unsure)


def volume_title(name: str, index: int, author: Optional[str] = None) -> str:
    """包内文件名 → 目录里这一册的标题。

    先去掉版本注记与 `作者：…`。剩下的以书名号开头、书名号之后什么都不剩（或只剩作者名，
    `《青石巷》某甲.txt`）时，取书名号里的内容：`《青石巷》（校对版全本）作者：某甲.txt` →
    `青石巷`。书名号之后还有别的字（`《青石巷》番外.txt`）就整段保留——丢掉它，两册会撞名。
    不以书名号开头的同样整段保留（`废稿《残篇》.txt` → `废稿《残篇》`）。

    最后过一遍 `toc.clean_title`：剥掉成对的方括号类装饰（`【外篇】` → `外篇`），也让册名
    满足与章节标题相同的"净化幂等"约定。净化成空时回退 `第 N 册`（`index` 1 起）。

    Args:
        name: 包内路径。
        index: 第几册，1 起。
        author: 这本书的作者（取自压缩包文件名）；书名号之后只剩它时一并去掉。
    """
    text = _drop_notes(_stem(name), unwrap=False).strip()
    lead = _LEADING_TITLE.match(text)
    if lead:
        rest = text[lead.end():].strip()
        if not rest or (author and rest == author.strip()):
            text = lead.group(1)
    return toc.clean_title(text) or f'第 {index} 册'
