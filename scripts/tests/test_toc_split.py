# -*- coding: utf-8 -*-
r"""`scripts/lib/toc.py` 的切分与卷标记（任务 18，需求 8.7 / 8.7a / 8.14 / 8.15）。

运行（仓库根目录）：`python -m pytest scripts/tests -q`

断言五组事实：

1. **严格连续覆盖**（需求 8.14）：`chapters[0].start == 0`、
   `chapters[i].end == chapters[i+1].start`、`chapters[-1].end == len(text)`、
   `length == end - start > 0`、`id` 从 0 连续递增。**卷节点同样参与**。
2. **range 以自身标题行起始**（需求 8.15）：`text.startswith(标题行原文, start)`，
   缩进算在章节里。这是前端"跳过与标题相同的首段"的前提（design §3.2）。
3. **卷标记**（需求 8.7 / 8.7a）：正文不足 100 字符则 `isVolume=True`，
   **不改 start/end**；正文章节压根没有这个键（不是 `False`）。卷节点的 range
   只含标题行与其后的空行，CRLF 下比 LF 恰好多出行终止符的个数。
4. **合成长书**：一本越过采样窗口（`SAMPLE_CHARS`）、带序章与若干卷的长书，把选中的规则、
   节点数、正文章数、卷数、严格覆盖、range 从行首开始、卷节点去掉标题行后没有正文、
   最短正文章不低于卷门槛一次断言完。
5. **标题形态与覆盖表**：「单位 序号」、「标准章节」的生僻单位、「括号装饰」的裸序号分支、
   「大写数字 冒号 标题」四种形态各造一本书，自动判定必须选中对应的规则、切分落在行首；
   覆盖表点名默认关闭的「纯序号行」时跳过自动判定，按裸序号行切分。

书全部在用例里现场合成，标题自拟；本文件不读 `public/` 下的任何文件，覆盖表也在内存里
构造、不读本机表。真实书库上"最短正文章离卷门槛还有多少余量"这一项不在这里：合成文本的
余量由构造者决定，断言它说明不了真实书离门槛有多远（test-data-desensitization 需求 2.6）；
门槛本身的语义由 `test_volume_threshold_is_a_strict_less_than` 钉住。

夹具一律用 CRLF——真实产物就是 CRLF（任务 15），而 design §4.5 的
`length - len(title) - 1` 恰好在 CRLF 上算错（终止符 2 字符而非 1），
`body_length` 的存在就是为了这个。
"""

from __future__ import annotations

from pathlib import Path
from typing import Callable, List, Sequence, Tuple

import pytest

from scripts.lib.toc import (
    PREFACE_TITLE,
    SAMPLE_CHARS,
    VOLUME_BODY_MAX,
    Chapter,
    body_length,
    count_content_chapters,
    mark_volumes,
    pick_rule,
    renumber,
    split_book,
    split_chapters,
)
from scripts.lib.toc_overrides import Overrides, pick_rule_for
from scripts.lib.toc_rules import by_name

STANDARD = by_name('标准章节')

#: 夹具一律用 CRLF，理由见模块 docstring。
NL = '\r\n'


# ---------------------------------------------------------------------------
# 通用不变量检查（design §2.1 不变量 1–5，需求 8.14）
#
# `assert_covers` 与 `test_toc_fallback.py`、`test_fixtures.py` 里的同名物重复定义——宁可
# 重复十行，也不让测试模块互相 import（`scripts/tests` 没有 `__init__.py`，跨模块 import 的
# 可用性取决于 pytest 的 import 模式，不值得依赖）。
# ---------------------------------------------------------------------------


def assert_covers(chapters: Sequence[Chapter], text: str) -> None:
    assert chapters, '切分结果不许为空'
    assert chapters[0]['start'] == 0
    assert chapters[-1]['end'] == len(text)
    for index, chapter in enumerate(chapters):
        assert chapter['id'] == index, 'id 即数组下标'
        assert chapter['length'] == chapter['end'] - chapter['start']
        assert chapter['length'] > 0, '零长度节点会让标题行字符无归属（design §0 修订一）'
    for left, right in zip(chapters, chapters[1:]):
        assert left['end'] == right['start'], '相邻章节必须无缝衔接，卷节点也不例外'


def titles(chapters: Sequence[Chapter]) -> List[str]:
    return [c['title'] for c in chapters]


def volumes(chapters: Sequence[Chapter]) -> List[Chapter]:
    return [c for c in chapters if c.get('isVolume')]


# ---------------------------------------------------------------------------
# 1. 切分：连续覆盖与序章
# ---------------------------------------------------------------------------


def body(chars: int) -> str:
    """一段 `chars` 个字符（含收尾 CRLF）的正文。"""
    return '雨' * (chars - 2) + NL


def book(*, preface: int = 0, bodies: Sequence[int] = (800, 900, 1000)) -> Tuple[str, List[str]]:
    """造一本书，返回 `(全文, 标题列表)`。`preface` > 0 时首个标题之前有内容。"""
    parts: List[str] = []
    if preface:
        parts.append(body(preface))
    names = [f'第{i + 1}章 标题{i + 1}' for i in range(len(bodies))]
    for name, size in zip(names, bodies):
        parts.append(name + NL)
        parts.append(body(size))
    return ''.join(parts), names


def test_adjacent_headings_form_chapters():
    text, names = book()
    chapters = split_chapters(text, STANDARD)
    assert titles(chapters) == names
    assert_covers(chapters, text)


def test_content_before_the_first_heading_becomes_a_preface():
    text, names = book(preface=600)
    chapters = split_chapters(text, STANDARD)
    assert titles(chapters) == [PREFACE_TITLE] + names
    assert chapters[0]['start'] == 0 and chapters[0]['end'] == 600
    assert_covers(chapters, text)


def test_no_preface_when_the_first_heading_is_at_offset_zero():
    text, names = book(preface=0)
    chapters = split_chapters(text, STANDARD)
    assert titles(chapters) == names, '偏移 0 处就是标题时不该造一个零长度的序章'
    assert_covers(chapters, text)


def test_last_chapter_reaches_the_end_of_text():
    text, _ = book()
    chapters = split_chapters(text, STANDARD)
    assert chapters[-1]['end'] == len(text)


def test_last_chapter_without_a_trailing_terminator():
    # 末行没有行终止符时偏移最容易差 1
    text = '第一章 甲' + NL + body(800) + '第二章 乙'
    chapters = split_chapters(text, STANDARD)
    assert_covers(chapters, text)
    assert chapters[-1]['length'] == len('第二章 乙')


def test_range_starts_at_the_title_line_including_indent():
    # 需求 8.15：range 以自身标题行起始。缩进算在本章里，不算在上一章尾部。
    text = body(600) + '\u3000\u3000第一章 甲' + NL + body(800) + '第二章 乙' + NL + body(800)
    chapters = split_chapters(text, STANDARD)
    first = chapters[1]
    assert text.startswith('\u3000\u3000第一章 甲', first['start'])
    assert first['title'] == '第一章 甲', '标题去首尾空白，但 start 仍指向缩进的第一个字符'
    assert_covers(chapters, text)


def test_titles_are_normalized_while_offsets_stay_put():
    # 任务 20：标题走 `normalize_title`（内部空白折叠、成对装饰符号去除），
    # 但 start/end 一个字符都不动。净化本身的行为在 test_toc_title.py 里细查。
    text = '\u3000\u3000第一章  甲\u3000\u3000乙' + NL + body(800) + '第二章 丙' + NL + body(800)
    chapters = split_chapters(text, STANDARD)
    assert chapters[0]['title'] == '第一章 甲 乙'
    assert chapters[0]['start'] == 0, 'range 仍从缩进的第一个字符起'
    assert text.startswith('\u3000\u3000第一章  甲\u3000\u3000乙', chapters[0]['start'])
    assert_covers(chapters, text)


def test_fewer_than_two_headings_falls_back_to_the_whole_book_split():
    # 需求 8.9 的触发条件。兜底产物的形态在 test_toc_fallback.py 里细查，
    # 这里只钉住"触发"这件事：一条标题撑不起一张目录，不该按那一条标题切。
    text = '第一章 甲' + NL + body(2000)
    result = split_book(text, STANDARD)
    assert result.fallback is True
    assert titles(result.chapters) == ['第 1 部分']
    assert_covers(result.chapters, text)

    prose = '他推开门，外面的雨已经停了。' + NL + body(2000) + '这一天就这样过去了。' + NL
    assert split_book(prose, STANDARD).fallback is True

    # 另一种触发方式：连规则都没选出来（`pick_rule` 返回 `rule=None`）
    assert split_book(prose, None).fallback is True


def test_two_headings_are_enough_to_avoid_the_fallback():
    text, names = book(bodies=(800, 900))
    result = split_book(text, STANDARD)
    assert result.fallback is False
    assert titles(result.chapters) == names


# ---------------------------------------------------------------------------
# 2. 卷标记（需求 8.7 / 8.7a）
# ---------------------------------------------------------------------------


def test_short_body_is_marked_as_a_volume():
    text = (
        '第一卷' + NL + NL                       # 正文只有 2 个字符（一个 CRLF）
        + '第一章 甲' + NL + body(800)
        + '第二章 乙' + NL + body(800)
    )
    chapters = split_chapters(text, STANDARD)
    assert titles(chapters) == ['第一卷', '第一章 甲', '第二章 乙']
    assert [c.get('isVolume') for c in chapters] == [True, None, None]
    assert_covers(chapters, text)


def test_volume_start_and_end_are_untouched():
    # design §0 修订一：卷节点不是零长度节点，range 恰好覆盖自己的标题行
    text = '第一卷' + NL + NL + '第一章 甲' + NL + body(800) + '第二章 乙' + NL + body(800)
    chapters = split_chapters(text, STANDARD)
    volume = chapters[0]
    # 3 个汉字 + 2 个 CRLF = 7 个字符，其中正文只有第二个 CRLF 那 2 个
    assert (volume['start'], volume['end'], volume['length']) == (0, 7, 7)
    assert text[volume['start']:volume['end']] == '第一卷\r\n\r\n'
    assert body_length(text, volume) == 2


#: 自拟的卷标题，长度各不相同。
NAMED_VOLUME_TITLES = (
    '第一卷 码头抄更簿',
    '第二卷 铁匠铺后面那口井',
    '第三卷 河堤上晾着的旧渔网',
    '第四卷 磨坊里那盏没人点的灯',
)


def test_named_volume_nodes_cover_only_their_title_line():
    # 每个卷标题后面跟两个空行：标题行自己的终止符加两个空行，一共 3 个行终止符，
    # 所以同一个卷节点在 CRLF 下比在 LF 下恰好长 3 个字符
    parts: List[str] = []
    number = 0
    for title in NAMED_VOLUME_TITLES:
        parts.append(title + NL * 3)
        for _ in range(2):
            number += 1
            parts.append(f'第{number}章 标题{number}' + NL + body(1_200))
    text = ''.join(parts)
    lf_text = text.replace(NL, '\n')

    chapters = split_chapters(text, STANDARD)
    found = {c['title']: c for c in volumes(chapters)}
    lf_found = {c['title']: c for c in volumes(split_chapters(lf_text, STANDARD))}
    assert list(found) == list(NAMED_VOLUME_TITLES), '只有这几个卷标题被标成卷'
    assert list(lf_found) == list(NAMED_VOLUME_TITLES)
    for title in NAMED_VOLUME_TITLES:
        chapter = found[title]
        assert lf_found[title]['length'] == len(title) + 3, f'{title} 的 LF 长度'
        assert chapter['length'] == lf_found[title]['length'] + 3, '三个行终止符，CRLF 下各多 1 个字符'
        assert body_length(text, chapter) < VOLUME_BODY_MAX
        # 不改 start/end：range 恰好是标题行加后面的空行，不多吞下一章的一个字符
        assert text[chapter['start']:chapter['end']] == title + NL * 3
    assert_covers(chapters, text)


def test_is_volume_is_written_only_when_true():
    # 7000 本 × 冗余 false 是纯体积浪费（design §2.1）
    text, _ = book()
    for chapter in split_chapters(text, STANDARD):
        assert 'isVolume' not in chapter


def test_volume_threshold_is_a_strict_less_than():
    # 正文恰好 VOLUME_BODY_MAX 不算卷，少一个字符才算
    for size, is_volume in ((VOLUME_BODY_MAX, None), (VOLUME_BODY_MAX - 1, True)):
        text = (
            '第一章 甲' + NL + body(size)
            + '第二章 乙' + NL + body(800)
            + '第三章 丙' + NL + body(800)
        )
        chapters = split_chapters(text, STANDARD)
        assert body_length(text, chapters[0]) == size
        assert chapters[0].get('isVolume') is is_volume, f'正文 {size} 字符'


def test_body_length_is_measured_on_the_real_text_not_assumed_width():
    # design §4.5 的 `length - len(title) - 1` 在 CRLF + 缩进上偏大：
    # 终止符是 2 个字符、title 已 strip 掉 2 个全角空格 → 一共多算 3 个。
    # 恰好卡在门槛上的这一章会被那个式子漏标。
    indent = '\u3000\u3000'
    title = '第二卷 檐下听雨'
    line = indent + title + NL
    text = (
        '第一章 甲' + NL + body(800)
        + line + '雨' * (VOLUME_BODY_MAX - 1) + NL
        + '第三章 丙' + NL + body(800)
    )
    chapters = split_chapters(text, STANDARD)
    volume = chapters[1]
    assert volume['title'] == title
    assert body_length(text, volume) == VOLUME_BODY_MAX + 1, '实测正文 = 99 个雨 + CRLF'
    naive = volume['length'] - len(volume['title']) - 1
    assert naive == VOLUME_BODY_MAX + 4, 'design 的式子多算 3 个字符（CRLF 1 + 缩进 2）'
    assert volume.get('isVolume') is None, '实测值 101 >= 100，不是卷'


def test_body_length_counts_a_synthetic_title_as_all_body():
    # `序章 / 前言` 在原文里没有对应的标题行，不能从它身上扣一行
    text = body(300) + '第一章 甲' + NL + body(800) + '第二章 乙' + NL + body(800)
    chapters = split_chapters(text, STANDARD)
    preface = chapters[0]
    assert preface['title'] == PREFACE_TITLE
    assert body_length(text, preface) == preface['length'] == 300
    assert preface.get('isVolume') is None


def test_single_line_chapter_without_terminator_has_empty_body():
    text = '第一章 甲' + NL + body(800) + '第二章 乙'
    chapters = split_chapters(text, STANDARD)
    assert body_length(text, chapters[-1]) == 0
    assert chapters[-1]['isVolume'] is True


def test_mark_volumes_returns_the_same_list_and_only_adds_the_flag():
    text = '第一卷' + NL + NL + '第一章 甲' + NL + body(800)
    chapters = renumber([
        {'id': 0, 'title': '第一卷', 'start': 0, 'end': 9, 'length': 9},
        {'id': 0, 'title': '第一章 甲', 'start': 9, 'end': len(text), 'length': len(text) - 9},
    ])
    before = [(c['start'], c['end'], c['length']) for c in chapters]
    assert mark_volumes(chapters, text) is chapters
    assert [(c['start'], c['end'], c['length']) for c in chapters] == before


def test_total_chapters_excludes_volumes():
    # design §2.1 不变量 4
    text = '第一卷' + NL + NL + '第一章 甲' + NL + body(800) + '第二章 乙' + NL + body(800)
    chapters = split_chapters(text, STANDARD)
    assert len(chapters) == 3
    assert count_content_chapters(chapters) == 2
    assert count_content_chapters([]) == 0


# ---------------------------------------------------------------------------
# 3. 合成长书
#
# 一本书把切分的全部不变量一起过一遍：CRLF 换行，章数上百（远超提前退出线），
# 全文越过采样窗口——选规则只看前 `SAMPLE_CHARS` 个字符，切分却必须铺满全书。
# 序章、卷节点、恰好压在卷门槛上的短章都在里面。
# ---------------------------------------------------------------------------

#: 长书的卷标题（自拟）。每个卷标题后面只跟一个空行，正文为零——它们必须被标成卷。
LONG_BOOK_VOLUMES = ('第一卷 盐仓旧账', '第二卷 晒谷场边', '第三卷 补网的人', '第四卷 灯油见底', '第五卷 渡船靠岸')

#: 每卷的章数。章号全书连续。
LONG_BOOK_CHAPTERS_PER_VOLUME = 32

#: 各章正文的字符数，按章号循环取。含一档恰好等于 `VOLUME_BODY_MAX` 的短章：它在
#: "不算卷"的那一侧，于是"最短正文章不低于卷门槛"这条断言不是白给的。
LONG_BOOK_BODIES = (8_200, 9_700, VOLUME_BODY_MAX, 7_600, 10_900, 6_800)


def long_book() -> Tuple[str, List[str]]:
    """造一本长书，返回 `(全文, 标题行列表)`。

    标题行按出现顺序排列，卷与章交错，不含序章：首个标题之前有一段正文，
    之后每卷一个卷标题行加一个空行，卷下 `LONG_BOOK_CHAPTERS_PER_VOLUME` 章。
    """
    parts: List[str] = [body(300)]
    names: List[str] = []
    number = 0
    for volume in LONG_BOOK_VOLUMES:
        parts.append(volume + NL + NL)
        names.append(volume)
        for _ in range(LONG_BOOK_CHAPTERS_PER_VOLUME):
            number += 1
            name = f'第{number}章 标题{number}'
            parts.append(name + NL + body(LONG_BOOK_BODIES[number % len(LONG_BOOK_BODIES)]))
            names.append(name)
    return ''.join(parts), names


def test_a_synthetic_long_book_split_is_a_strict_cover():
    text, names = long_book()
    assert len(text) > SAMPLE_CHARS, '夹具前提：全文越过采样窗口'
    pick = pick_rule(text)
    assert pick.name == '标准章节'
    chapters = split_chapters(text, pick.rule)

    # 节点数、正文章数、卷节点数，全由构造推出；序章算正文章
    assert titles(chapters) == [PREFACE_TITLE] + names
    content_count = len(names) - len(LONG_BOOK_VOLUMES) + 1
    assert (len(chapters), count_content_chapters(chapters)) == (len(names) + 1, content_count)
    assert titles(volumes(chapters)) == list(LONG_BOOK_VOLUMES)

    assert_covers(chapters, text)
    # 末章 end 就是 charCount：CRLF 一个字符都不能少算
    assert chapters[-1]['end'] == len(text)
    assert chapters[-1]['start'] > SAMPLE_CHARS, '采样窗口之外的标题照样切开'

    # 需求 8.15：除序章外，每个 range 都从自己标题行的行首开始。序章本来就从 0 开始
    assert chapters[0]['start'] == 0
    for chapter in chapters[1:]:
        start = chapter['start']
        assert text[start - 1] in '\r\n', f'不在行首：{chapter!r}'
        assert text.startswith(chapter['title'] + NL, start)

    # 被标为卷的节点去掉标题行后确实没有正文，正文章一个都没被误标
    for chapter in volumes(chapters):
        remainder = text[chapter['start']:chapter['end']].strip()
        assert remainder == chapter['title'], f'被标为卷却还有正文：{chapter!r}'
    content = [c for c in chapters if not c.get('isVolume')]
    shortest = min(content, key=lambda c: body_length(text, c))
    assert body_length(text, shortest) >= VOLUME_BODY_MAX, f'差一点被误标：{shortest!r}'


# ---------------------------------------------------------------------------
# 4. 标题形态：每种编号习惯在整本书上选中自己的规则
#
# `toc_rules` 里「按书成类的编号习惯」那三条规则（第 3、7 条与第 9 条的裸序号分支），
# 外加第 1 条认的生僻章节单位。每种形态造一本书，书里的标题全是这一种写法。
# ---------------------------------------------------------------------------

_CN_DIGITS = '〇一二三四五六七八九'


def cn(number: int) -> str:
    """1–99 的中文小写数字：`一`、`十`、`十二`、`二十`、`九十九`。"""
    tens, ones = divmod(number, 10)
    head = '' if tens == 0 else ('十' if tens == 1 else _CN_DIGITS[tens] + '十')
    return head + (_CN_DIGITS[ones] if ones else '')


#: 规则名 → 第 n 章的标题行。标题按 `toc_rules` 里对应规则的形态自拟。
HEADING_STYLES: List[Tuple[str, Callable[[int], str]]] = [
    ('单位 序号', lambda n: f'段{cn(n)} 标题{n}'),           # 单位字在前、序号在后
    ('标准章节', lambda n: f'第{cn(n)}夜 标题{n}'),           # 生僻但规整的章节单位
    ('括号装饰', lambda n: f'【{n:03d}】标题{n}'),            # 括号里只有序号，后面跟标题
    ('大写数字 冒号 标题', lambda n: f'{cn(n)}：标题{n}'),    # 大写数字 + 全角冒号
]

#: 每本形态书的章数。
HEADING_STYLE_CHAPTERS = 18


@pytest.mark.parametrize(
    'rule_name,heading',
    HEADING_STYLES,
    ids=['unit-lead', 'rare-unit', 'bracket-serial', 'cn-colon'],
)
def test_heading_styles_pick_their_rule_and_split_on_line_starts(
    rule_name: str, heading: Callable[[int], str]
):
    lines = [heading(n) for n in range(1, HEADING_STYLE_CHAPTERS + 1)]
    text = ''.join(line + NL + body(1_500) for line in lines)
    pick = pick_rule(text)
    assert pick.name == rule_name
    chapters = split_chapters(text, pick.rule)
    assert titles(chapters) == lines
    assert_covers(chapters, text)
    # 每个标题都坐在自己那一行的行首（需求 8.15）——"新边界落在标题上"的机器可验版本
    for chapter, line in zip(chapters, lines):
        start = chapter['start']
        assert start == 0 or text[start - 1] in '\r\n'
        assert text.startswith(line + NL, start)


# ---------------------------------------------------------------------------
# 5. 覆盖表点名「纯序号行」
#
# 这条规则默认关闭（理由见 `toc_rules` 模块 docstring 里"整行只有一个序号"那一节），
# 需要它的书只能由覆盖表点名。覆盖表在内存里构造，不读本机表（需求 3.13）。
# ---------------------------------------------------------------------------

#: 自拟的书 id。
PINNED_BOOK_ID = '裸序号样书-夹具作者丙'

#: 这本书的章数。
PINNED_CHAPTERS = 16


def test_a_pinned_numeral_line_book_splits_on_bare_numerals():
    numeral_line = by_name('纯序号行')
    assert numeral_line.enabled is False, '默认关闭，只能由覆盖表点名'
    # 每章正文的第一行也以数字开头，但不是"整行一个序号"，不该被切开
    lines = [cn(n) for n in range(1, PINNED_CHAPTERS + 1)]
    text = ''.join(line + NL + '三更时分，灯还亮着。' + NL + body(1_400) for line in lines)
    overrides = Overrides(path=Path('in-memory.json'), table={PINNED_BOOK_ID: numeral_line})

    pick = pick_rule_for(text, PINNED_BOOK_ID, overrides)
    assert (pick.name, pick.overridden) == ('纯序号行', True)
    assert pick.scores == (), '点名即跳过自动判定：一条规则都没评分'

    chapters = split_chapters(text, pick.rule)
    assert titles(chapters) == lines
    assert_covers(chapters, text)
    for chapter, line in zip(chapters, lines):
        assert text.startswith(line + NL, chapter['start'])
