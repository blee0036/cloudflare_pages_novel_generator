# -*- coding: utf-8 -*-
r"""`scripts/lib/toc.py` 的两级兜底（任务 19，需求 8.8 / 8.9）。

运行（仓库根目录）：`python -m pytest scripts/tests -q`

分三组：

1. **逐章兜底**（需求 8.8）：单章超过 `CHAPTER_MAX` 时就地按段落再切，片段标题
   `原标题(N)`，原标题降为卷节点。其余章节一个字符都不许动。
2. **全书兜底**（需求 8.9）：标题命中少于 2 条时整本按段落块切，块长约
   `FALLBACK_BLOCK`；某一段没有空行就在换行处断；结果带书级 `fallback: true`。
3. **普通长书**：一本合成长书，大多数章几千字符、少数几章紧贴 `CHAPTER_MAX` 之下，
   两级兜底都不该触发——不整本兜底、没有一章被再切，严格连续覆盖照旧。

两级兜底都不许破坏需求 8.14 的严格连续覆盖，这是本文件最主要的断言——
`assert_covers` 与 `test_toc_split.py` 里的同名物一致（那边也注明了：宁可重复十行，
也不让两个测试模块互相 import）。

夹具一律 CRLF，理由同 `test_toc_split.py`：真实产物就是 CRLF（任务 15），
而"空行"的判据、断点落位都得在两字符终止符上成立。
"""

from __future__ import annotations

import re
from typing import List, Sequence

from scripts.lib.toc import (
    CHAPTER_MAX,
    FALLBACK_BLOCK,
    FALLBACK_TAIL_MIN,
    MIN_USEFUL_SHARE,
    PREFACE_TITLE,
    SAMPLE_CHARS,
    Chapter,
    count_content_chapters,
    fallback_split,
    fallback_title,
    pick_rule,
    split_book,
    split_chapters,
    split_overlong,
)
from scripts.lib.toc_rules import by_name

STANDARD = by_name('标准章节')

NL = '\r\n'


# ---------------------------------------------------------------------------
# 夹具与通用断言
# ---------------------------------------------------------------------------


def assert_covers(chapters: Sequence[Chapter], text: str) -> None:
    """需求 8.14：严格连续覆盖。兜底产物与正常产物同一标准，不打折。"""
    assert chapters, '切分结果不许为空'
    assert chapters[0]['start'] == 0
    assert chapters[-1]['end'] == len(text)
    for index, chapter in enumerate(chapters):
        assert chapter['id'] == index, 'id 即数组下标'
        assert chapter['length'] == chapter['end'] - chapter['start']
        assert chapter['length'] > 0
    for left, right in zip(chapters, chapters[1:]):
        assert left['end'] == right['start'], '相邻章节必须无缝衔接'
    joined = ''.join(text[c['start']:c['end']] for c in chapters)
    assert joined == text, '拼回去必须逐字符等于原文'


def titles(chapters: Sequence[Chapter]) -> List[str]:
    return [c['title'] for c in chapters]


def line(chars: int, char: str = '雨') -> str:
    """一行 `chars` 个字符，**含**末尾 CRLF。"""
    assert chars >= 3
    return char * (chars - 2) + NL


def prose(paragraphs: int, size: int = 400) -> str:
    """`paragraphs` 个段落，每段 `size` 字符（含 CRLF），段间一个空行。

    单元长度 = `size + 2`，所有块长断言都是从这个数算出来的。
    """
    return (line(size) + NL) * paragraphs


#: `prose()` 的单元长度：400 字符的段落 + 2 字符的空行。
UNIT = 402


def test_the_fixture_arithmetic_is_what_the_assertions_assume():
    # 后面几处硬编码的块长（4824 / 99696 …）都是 UNIT 的整数倍，先把 UNIT 钉住
    assert len(prose(1)) == UNIT == 402
    assert len(prose(60)) == 60 * UNIT


# ---------------------------------------------------------------------------
# 1. 逐章兜底（需求 8.8，design §4.5 ②）
#
# 每个夹具都带一串**正常章节**做背景，不是凑数：`toc.Coverage` 的篇幅门槛要求
# "可读节点"（间隔落在 (VOLUME_BODY_MAX, CHAPTER_MAX] 的那些）覆盖全书三成以上，
# 而"一章超长"这件事本身贡献的是一个无命中的巨块。真书里超长章总是出现在一本有
# 几十上百章的书里（全库实测走逐章兜底的书最少也有 10 条命中），夹具得有同一个背景，
# 否则整本会被判成"这几条命中不是目录"、走全书兜底——那是门槛的正确行为，
# 它自己的断言在 `test_toc_floor.py`。
# ---------------------------------------------------------------------------

#: 背景章节数。12 章 × 12,069 字符 = 144,828 字符可读节点，占 `OVERLONG` 全书
#: 386,035 字符的 37.5%，离门槛的 30% 有余量；命中 13 条也过 `MIN_RULE_HITS`（6）。
TAIL_COUNT = 12

#: 背景章节的标题（`第2章 标题2` … `第13章 标题13`）。
TAIL_TITLES = [f'第{n}章 标题{n}' for n in range(2, 2 + TAIL_COUNT)]

#: 背景章节的正文：每章 30 段 = 12,060 字符，远低于 CHAPTER_MAX，一章都不该被再切。
TAIL = ''.join(title + NL + prose(30) for title in TAIL_TITLES)

#: 一本"第一章超长、后面十二章正常"的书。超长章正文 600 段 = 241,200 字符，远超 10 万。
OVERLONG = '第一章 甲' + NL + prose(600) + TAIL

#: 超长章的标题行，降级后的卷节点恰好覆盖它。
OVERLONG_HEAD = '第一章 甲' + NL


def test_overlong_chapter_is_split_in_place():
    chapters = split_chapters(OVERLONG, STANDARD)
    assert_covers(chapters, OVERLONG)
    assert titles(chapters) == [
        '第一章 甲',
        '第一章 甲(1)',
        '第一章 甲(2)',
        '第一章 甲(3)',
        *TAIL_TITLES,
    ]
    # 断点落在段落边界上，所以块长是 UNIT 的整数倍：248 + 248 + 104 = 600 段
    assert [c['length'] for c in chapters[1:4]] == [248 * UNIT, 248 * UNIT, 104 * UNIT]
    assert all(c['length'] <= CHAPTER_MAX for c in chapters)


def test_the_original_title_becomes_a_volume_node_covering_its_own_title_line():
    chapters = split_chapters(OVERLONG, STANDARD)
    head = chapters[0]
    assert head['isVolume'] is True
    assert (head['start'], head['length']) == (0, len(OVERLONG_HEAD))
    assert OVERLONG[head['start']:head['end']] == OVERLONG_HEAD
    # 片段本身是正文章节，不是卷（前端要能点进去）
    assert [c.get('isVolume') for c in chapters[1:]] == [None] * (3 + TAIL_COUNT)
    assert count_content_chapters(chapters) == 3 + TAIL_COUNT


def test_untouched_chapters_are_the_very_same_objects():
    # "只修那 10%"：没超长的章节原样通过，连对象都不换
    chapters = split_chapters(OVERLONG, STANDARD)
    last = chapters[-1]
    assert last['title'] == TAIL_TITLES[-1]
    assert OVERLONG.startswith(TAIL_TITLES[-1], last['start'])
    assert last['end'] == len(OVERLONG)
    # 背景章节一条都没被动过：每章正文 30 段，长度只差标题行那几个字符
    assert all(
        c['length'] - len(c['title']) - 2 == 30 * UNIT for c in chapters[4:]
    )


def test_overlong_fragments_break_after_a_blank_line():
    chapters = split_chapters(OVERLONG, STANDARD)
    for fragment in chapters[2:4]:
        start = fragment['start']
        assert OVERLONG[start - 4:start] == NL + NL, '断点落在空行之后'
        assert OVERLONG[start] == '雨', '新块从实体文字开头，不从空行开头'


def test_a_chapter_at_the_threshold_is_not_split():
    head = '第一章 甲' + NL
    text = head + line(CHAPTER_MAX - len(head)) + TAIL
    chapters = split_chapters(text, STANDARD)
    assert chapters[0]['length'] == CHAPTER_MAX
    assert titles(chapters) == ['第一章 甲', *TAIL_TITLES], '恰好等于上限不算超长'


def test_a_chapter_one_char_past_the_threshold_is_demoted_even_with_one_fragment():
    # 只超线 1 个字符：扣掉标题行后正文已经合规，照常降级——否则它会永远挂在
    # `check_toc.py` 的疑似误判里（那边的上界与这里是同一个 CHAPTER_MAX）
    head = '第一章 甲' + NL
    text = head + line(CHAPTER_MAX - len(head) + 1) + TAIL
    chapters = split_chapters(text, STANDARD)
    assert titles(chapters) == ['第一章 甲', '第一章 甲(1)', *TAIL_TITLES]
    assert (chapters[0]['length'], chapters[0]['isVolume']) == (len(head), True)
    assert chapters[1]['length'] == CHAPTER_MAX - len(head) + 1
    assert_covers(chapters, text)


def test_an_unsplittable_overlong_chapter_is_left_as_is():
    # 整段正文是一个没有换行的超长单行：绝不切在一行文字中间，所以切不动。
    # 与其产出"空壳卷 + 同样超长的 (1)"，不如原样留着让度量工具报出来。
    head = '第一章 甲' + NL
    text = head + line(CHAPTER_MAX + 50_000) + TAIL
    chapters = split_chapters(text, STANDARD)
    assert titles(chapters) == ['第一章 甲', *TAIL_TITLES]
    assert chapters[0]['length'] > CHAPTER_MAX
    assert 'isVolume' not in chapters[0]
    assert_covers(chapters, text)


def test_an_overlong_preface_gets_no_volume_head():
    # `序章 / 前言` 是合成标题，原文里没有对应的标题行，没有东西可以降级为卷
    text = prose(600) + TAIL
    chapters = split_chapters(text, STANDARD)
    assert titles(chapters)[:3] == [f'{PREFACE_TITLE}({n})' for n in (1, 2, 3)]
    assert chapters[0]['start'] == 0
    assert not any(c.get('isVolume') for c in chapters), '没有标题行可降级'
    assert_covers(chapters, text)


def test_split_overlong_never_touches_a_volume_node():
    # 卷节点只有标题行，正常不可能超长；真超长说明它被误标了，那也不该在这里切
    text = '第一卷' + NL + line(CHAPTER_MAX + 1_000)
    volume: Chapter = {
        'id': 0, 'title': '第一卷', 'start': 0,
        'end': len(text), 'length': len(text), 'isVolume': True,
    }
    out = split_overlong([volume], text)
    assert out == [volume]
    assert out[0] is volume, '原样通过，不复制不改写'


# ---------------------------------------------------------------------------
# 2. 全书兜底（需求 8.9，design §4.5 ③）
# ---------------------------------------------------------------------------


def test_fallback_aggregates_paragraphs_into_blocks_of_about_the_target():
    text = prose(60)
    chapters = fallback_split(text)
    assert_covers(chapters, text)
    assert titles(chapters) == [fallback_title(n) for n in range(1, len(chapters) + 1)]
    assert titles(chapters)[:2] == ['第 1 部分', '第 2 部分']
    # 12 段 = 4824 字符是"不超过 5000 的最后一个段落边界"
    assert [c['length'] for c in chapters] == [12 * UNIT] * 5
    assert all(c['length'] <= FALLBACK_BLOCK for c in chapters)


def test_fallback_blocks_start_after_a_blank_line():
    text = prose(60)
    for chapter in fallback_split(text)[1:]:
        start = chapter['start']
        assert text[start - 4:start] == NL + NL, '在段落边界断开'
        assert text[start] == '雨'


def test_fallback_treats_whitespace_only_lines_as_blank():
    # "空行"= strip 之后为空，所以全角空格排版的书同样按段落断
    separator = '\u3000\u3000' + NL
    text = (line(400) + separator) * 60
    chapters = fallback_split(text)
    assert len(chapters) == 5
    for chapter in chapters[1:]:
        start = chapter['start']
        assert text[start - len(separator):start] == separator


def test_fallback_without_blank_lines_breaks_at_line_ends():
    text = line(300) * 100          # 30,000 字符，一个空行都没有
    chapters = fallback_split(text)
    assert_covers(chapters, text)
    for chapter in chapters:
        assert text[chapter['end'] - 2:chapter['end']] == NL, '断点落在换行处'
    for chapter in chapters[:-1]:
        assert FALLBACK_BLOCK <= chapter['length'] < FALLBACK_BLOCK + 300


def test_fallback_with_no_line_break_at_all_yields_a_single_block():
    # 需求 8.9 只允许在换行处断，没有换行就切不开——不切在一行文字中间
    text = '雨' * 30_000
    chapters = fallback_split(text)
    assert [c['length'] for c in chapters] == [30_000]


def test_fallback_escalates_to_line_ends_only_where_blank_lines_are_missing():
    # 按区域选档而不是按全书二选一：中间那一大段没有空行，
    # 不该让其余地方也丢掉段落边界
    text = prose(30) + line(300) * 40 + NL + prose(30)
    chapters = fallback_split(text)
    assert_covers(chapters, text)
    starts = [c['start'] for c in chapters[1:]]
    after_blank = [s for s in starts if text[s - 4:s] == NL + NL]
    at_line_end = [s for s in starts if text[s - 4:s] != NL + NL]
    assert after_blank, '有空行的地方按段落断'
    assert at_line_end, '没有空行的那一段按换行断'
    assert all(text[s - 1] == '\n' for s in starts), '断点一律在行终止符之后'
    assert all(c['length'] < FALLBACK_BLOCK * 2 for c in chapters)


def test_fallback_skips_a_paragraph_boundary_that_would_leave_a_runt_block():
    # 段落边界之后紧跟一个上万字不分段的长段落：在那个边界断开，切下来的只是边界
    # 之前那一小截——这里是一个短段落加一个空行，块首恰好是空行时就只剩那个空行。
    # 所以"不足目标一半就不算可用边界"，长段落连同前面那一截归同一块。
    text = line(300) + NL + line(24_000) + NL + prose(25)
    chapters = fallback_split(text)
    assert_covers(chapters, text)
    assert chapters[0]['length'] == 302 + 24_000, '长段落整个归第一块，不切出 302 的碎块'
    assert min(c['length'] for c in chapters[:-1]) >= FALLBACK_BLOCK // 2


def test_fallback_merges_a_too_short_tail():
    text = line(100) * 102          # 10,200 字符，无空行 → 5000 + 5000 + 200
    chapters = fallback_split(text)
    assert titles(chapters) == ['第 1 部分', '第 2 部分']
    assert [c['length'] for c in chapters] == [5_000, 5_200]
    assert_covers(chapters, text)


def test_fallback_keeps_a_tail_that_is_long_enough():
    text = line(100) * 106          # 尾块 600 ≥ FALLBACK_TAIL_MIN
    chapters = fallback_split(text)
    assert [c['length'] for c in chapters] == [5_000, 5_000, 600]
    assert 600 >= FALLBACK_TAIL_MIN


def test_fallback_output_has_no_volume_nodes():
    # 兜底意味着一个标题都没认出来，没有任何东西可以降级为卷；
    # 拿 100 字符的门槛去量合成标题只会把偏短的尾块误标成分组表头
    chapters = fallback_split(prose(60))
    assert count_content_chapters(chapters) == len(chapters)
    assert not any('isVolume' in c for c in chapters)


def test_fallback_on_empty_text_yields_nothing():
    assert fallback_split('') == []


def test_fewer_than_two_headings_goes_to_the_fallback():
    one_heading = '第一章 甲' + NL + prose(60)
    result = split_book(one_heading, STANDARD)
    assert result.fallback is True
    assert titles(result.chapters)[0] == '第 1 部分', '不按那唯一一条标题切'
    assert_covers(result.chapters, one_heading)


def test_no_usable_rule_goes_to_the_fallback():
    text = prose(60)
    result = split_book(text, None)
    assert result.fallback is True
    assert titles(result.chapters) == titles(fallback_split(text))


def test_fallback_is_a_book_level_flag_not_a_chapter_field():
    # `_toc.json` 把 fallback 放在根上（design §2.1），章节里不该出现这个键
    result = split_book(prose(60), STANDARD)
    assert result.fallback is True
    assert all('fallback' not in c for c in result.chapters)


def test_per_chapter_fallback_does_not_set_the_book_level_flag():
    # 需求 8.8 是正常路径里的局部修补，规则依然可用，tocRule 依然有意义
    result = split_book(OVERLONG, STANDARD)
    assert result.fallback is False
    assert any(c['title'] == '第一章 甲(1)' for c in result.chapters)


def test_split_chapters_is_split_book_without_the_flag():
    text = prose(60)
    assert split_chapters(text, STANDARD) == split_book(text, STANDARD).chapters


# ---------------------------------------------------------------------------
# 3. 普通长书（两级兜底都不该触发）
#
# 前两组各自把一级兜底逼到触发，这一组反过来：章节表本来就正常的书，两级兜底都不许碰。
# 夹具是一本合成长书，比 `SAMPLE_CHARS` 长——择一只看前 100 万字符，切分看全书。
# 大多数章是几千字符的普通章，每 `LONG_EVERY` 章有一个长章，只比 `CHAPTER_MAX`
# 短 1 个字符。长章占了全书七成以上的篇幅，所以两道门槛都在实打实地判，不是旁路：
#
# - 逐章兜底：长章紧贴上限，判"超长"的线稍往下挪，它们就会被切成 `原标题(N)`、
#   原标题降为卷头；
# - 全书兜底：`Coverage` 的可读区间 `(VOLUME_BODY_MAX, CHAPTER_MAX]` 得把长章算进去，
#   可读覆盖才过得了 `MIN_USEFUL_SHARE`——只算普通章不到三成，整本会被判成盲区。
#
# 恰好等于 `CHAPTER_MAX` 的那一格由 `test_a_chapter_at_the_threshold_is_not_split` 钉住。
# ---------------------------------------------------------------------------

#: 普通章的总长（含标题行与 CRLF），按章序轮流取用。7 个值与 `LONG_EVERY` 互素，
#: 所以每个值都轮得到。
ORDINARY_LENGTHS = (2_600, 4_100, 3_300, 5_800, 2_900, 7_400, 3_800)

#: 长章的总长：比 `CHAPTER_MAX` 短 1 个字符。
LONG_LENGTH = CHAPTER_MAX - 1

#: 第 8、16、24…章是长章。
LONG_EVERY = 8

#: 全书 120 章：`第1章 标题1` … `第120章 标题120`。
LONG_BOOK_TITLES = [f'第{n}章 标题{n}' for n in range(1, 121)]

#: 各章的总长，与 `LONG_BOOK_TITLES` 一一对应。
LONG_BOOK_LENGTHS = [
    LONG_LENGTH if n % LONG_EVERY == 0 else ORDINARY_LENGTHS[n % len(ORDINARY_LENGTHS)]
    for n in range(1, len(LONG_BOOK_TITLES) + 1)
]

#: 长章的个数（15）。
LONG_COUNT = LONG_BOOK_LENGTHS.count(LONG_LENGTH)


def sized_chapter(title: str, length: int) -> str:
    """标题行 + 正文，总长恰好 `length`（含 CRLF）。

    正文是若干个 `prose()` 段落，余数补成末尾一行（后面不跟空行），所以长度精确到字符。
    """
    head = title + NL
    paragraphs, rest = divmod(length - len(head) - 3, UNIT)
    return head + prose(paragraphs) + line(rest + 3)


#: 书前 3 段没有标题的引子（切分后是 `序章 / 前言`），然后是 120 章。
LONG_BOOK = prose(3) + ''.join(
    sized_chapter(title, length)
    for title, length in zip(LONG_BOOK_TITLES, LONG_BOOK_LENGTHS)
)

#: `split_overlong` 给片段起名的方式：`f'{原标题}({序号})'`——半角括号裹着从 1 起的
#: 序号，收在标题末尾。
FRAGMENT_TITLE = re.compile(r'\(\d+\)$')


def fragments(chapters: Sequence[Chapter]) -> List[str]:
    """章节表里由逐章兜底切出的片段标题。"""
    return [title for title in titles(chapters) if FRAGMENT_TITLE.search(title)]


def test_a_normal_long_book_triggers_neither_level_of_fallback():
    # 夹具算术：书比采样窗口长；长章以外的篇幅不到 `MIN_USEFUL_SHARE`
    assert len(LONG_BOOK) > SAMPLE_CHARS
    assert (len(LONG_BOOK) - LONG_COUNT * LONG_LENGTH) / len(LONG_BOOK) < MIN_USEFUL_SHARE
    # 判片段的写法认得出真片段，下面"一个都没有"才不是空话
    assert fragments(split_chapters(OVERLONG, STANDARD)) == [
        '第一章 甲(1)', '第一章 甲(2)', '第一章 甲(3)',
    ]

    pick = pick_rule(LONG_BOOK)
    assert pick.rule is STANDARD
    result = split_book(LONG_BOOK, pick.rule)
    chapters = result.chapters

    # 不整本兜底：章节表就是规则切出的那张自拟目录，不是 `第 N 部分`
    assert result.fallback is False, '普通长书该用规则切出目录，不该整本降级'
    assert titles(chapters) == [PREFACE_TITLE, *LONG_BOOK_TITLES]

    # 不逐章兜底：最长章就是紧贴上限的长章，原样保留，没有 `原标题(N)` 片段
    longest = max(c['length'] for c in chapters)
    assert longest < CHAPTER_MAX, '没有一章超线，逐章兜底不会被触发'
    assert longest == LONG_LENGTH
    assert fragments(chapters) == [], '不该有片段'

    # 严格连续覆盖：序章从 0 起，相邻首尾相接，末章止于全文末尾
    assert_covers(chapters, LONG_BOOK)
