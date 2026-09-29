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
   **不改 start/end**；正文章节压根没有这个键（不是 `False`）。
4. **真实基线**：5 本真书的规则、章数、卷数，以及任务点名的三个卷标题。
5. **新规则的真实书基线**：「单位 序号」/「大写数字 冒号 标题」/「括号装饰」的裸序号
   分支、以及覆盖表点名「纯序号行」的那几本——每一本改动前都只切出 4–33 个巨型节点
   （或整本走全书兜底），这一组把修好之后的节点数钉住。

夹具一律用 CRLF——真实产物就是 CRLF（任务 15），而 design §4.5 的
`length - len(title) - 1` 恰好在 CRLF 上算错（终止符 2 字符而非 1），
`body_length` 的存在就是为了这个。
"""

from __future__ import annotations

import gzip
from pathlib import Path
from typing import Dict, List, Sequence, Tuple

import pytest

from scripts.lib.toc import (
    PREFACE_TITLE,
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
from scripts.lib.toc_rules import by_name

STANDARD = by_name('标准章节')

#: 夹具一律用 CRLF，理由见模块 docstring。
NL = '\r\n'

#: `public/books/` 是 gitignore 的本地产物，干净检出时真实书那组整体跳过。
#: 这两个符号与 `test_toc.py` 里的同名物重复定义——宁可重复三行，也不让两个测试
#: 模块互相 import（`scripts/tests` 没有 `__init__.py`，跨模块 import 的可用性
#: 取决于 pytest 的 import 模式，不值得依赖）。
BOOKS_DIR = Path(__file__).resolve().parents[2] / 'public' / 'books'

real_books = pytest.mark.skipif(
    not BOOKS_DIR.is_dir() or not any(BOOKS_DIR.glob('*.txt.gz')),
    reason='public/books 是 gitignore 的本地产物，缺失时跳过真实书基线',
)


# ---------------------------------------------------------------------------
# 通用不变量检查（design §2.1 不变量 1–5，需求 8.14）
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
    title = '第二卷 大乱斗'
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
# 3. 真实书基线（任务 29 的对比起点）
#
# `public/books/` 是 gitignore 的本地产物，干净检出时这组整体跳过。
#
# 数值与仓库里已提交的 `_toc.json` **不一致，这是预期的**：那批产物的 charCount 按
# LF 归一后的文本算、而 `.gz` 里是 CRLF（任务 15 修掉了根因），所以偏移与长度整体
# 变大；章数变化则来自"一本书只选一条规则"取代了旧版的 7 条正则同时套用。
# ---------------------------------------------------------------------------

#: book_id → (规则名, 总节点数, 正文章数, 卷节点数)
#:
#: 相比任务 18 的实测值，这里每本都少了 0–2 个节点：`UNIT` 的后缀白名单与
#: `filter_prose_hits` 各否掉了几条正文命中。逐条核对过，丢掉的全是正文行——
#: `　　第二场战斗开始。`、`　　第一篇就是《太平兴，满清亡！》`、
#: `　　第三场随后开始，热血盟对光明联盟。…`（都缩进、都是句子形），
#: 真标题一条没少。《1852》的卷节点因此从 9 降到 8：少掉的那个正是零正文的伪标题。
BASELINE: Dict[str, Tuple[str, int, int, int]] = {
    '1852铁血中华-绯红之月': ('标准章节', 1391, 1383, 8),
    '1991从芯开始-三分糊涂': ('标准章节', 1051, 1048, 3),
    'BUG之神-耳火大帝': ('标准章节', 676, 673, 3),
    'NB-NB': ('标准章节', 421, 421, 0),
    '从零开始-雷云风暴': ('标准章节', 3416, 3416, 0),
}

#: 任务 18 点名要核对的三个卷标题，都在《BUG之神》里。
#: 括号里是已提交产物（LF 归一）的长度；CRLF 下每个标题后跟 3 个换行，各 +3。
NAMED_VOLUMES: Dict[str, Tuple[int, int]] = {
    '第一卷': (6, 9),
    '第二卷 大乱斗': (10, 13),
    '第三卷 星球扬名': (11, 14),
}


def read_full(book_id: str) -> str:
    """读出一本书 gz 的全文（`newline=''`：不翻译 CRLF，与产物逐字符一致）。"""
    path = BOOKS_DIR / f'{book_id}.txt.gz'
    with gzip.open(path, 'rt', encoding='utf-8', newline='') as f:
        return f.read()


def split_real(book_id: str) -> Tuple[str, List[Chapter], str]:
    path = BOOKS_DIR / f'{book_id}.txt.gz'
    if not path.exists():
        pytest.skip(f'{book_id} 不在本地 public/books 里')
    text = read_full(book_id)
    pick = pick_rule(text)
    assert pick.rule is not None
    return text, split_chapters(text, pick.rule), pick.name


@real_books
@pytest.mark.parametrize('book_id,expected', sorted(BASELINE.items()))
def test_real_book_split_is_a_strict_cover(book_id: str, expected: Tuple[str, int, int, int]):
    rule_name, total, content, volume_count = expected
    text, chapters, picked = split_real(book_id)
    assert picked == rule_name
    assert (len(chapters), count_content_chapters(chapters)) == (total, content)
    assert len(volumes(chapters)) == volume_count
    assert_covers(chapters, text)
    # 末章 end 就是 charCount——已提交产物正是在这里差了 52308 个字符（CRLF 被吞）
    assert chapters[-1]['end'] == len(text)


@real_books
@pytest.mark.parametrize('book_id', sorted(BASELINE))
def test_real_book_ranges_start_at_a_line_start(book_id: str):
    # 需求 8.15。序章是唯一的例外——它本来就从 0 开始。
    text, chapters, _ = split_real(book_id)
    for chapter in chapters:
        start = chapter['start']
        assert start == 0 or text[start - 1] in '\r\n'


@real_books
def test_named_volumes_are_marked():
    book_id = 'BUG之神-耳火大帝'
    text, chapters, _ = split_real(book_id)
    found = {c['title']: c for c in volumes(chapters)}
    assert set(found) == set(NAMED_VOLUMES), '这本书只有这三个卷节点'
    for title, (lf_length, crlf_length) in NAMED_VOLUMES.items():
        chapter = found[title]
        assert chapter['length'] == crlf_length, f'{title} 的 CRLF 长度'
        assert chapter['length'] == lf_length + 3, '三个行终止符，CRLF 下各多 1 个字符'
        assert body_length(text, chapter) < VOLUME_BODY_MAX
        # 不改 start/end：range 恰好覆盖自己的标题行（外加后面的空行）
        assert text.startswith(title, chapter['start'])
        assert text[chapter['start']:chapter['end']].strip() == title


@real_books
@pytest.mark.parametrize('book_id', sorted(BASELINE))
def test_no_real_content_chapter_is_mistaken_for_a_volume(book_id: str):
    """任务 18 的验收：无正文章节被误标。

    口径是"被标 isVolume 的节点，去掉标题行后确实没有正文"——卷标题后面只剩空行。
    5 本书里被标的 15 个节点全部满足，其中 13 个是 `第N卷 …` 真卷标题，
    另外 2 个（《1852》）是规则在正文里匹出的伪标题，它们同样零正文，
    降为不可点击的分组表头正是需求 8.7a 想要的降级方向。

    另一半的保障是余量：非卷章节里最短的也有 156 字符，离 100 这条线还有 56 字符，
    不是"刚好没踩上"。
    """
    text, chapters, _ = split_real(book_id)
    for chapter in volumes(chapters):
        remainder = text[chapter['start']:chapter['end']].strip()
        assert remainder == chapter['title'], f'被标为卷却还有正文：{chapter!r}'

    content = [c for c in chapters if not c.get('isVolume')]
    shortest = min(content, key=lambda c: body_length(text, c))
    assert body_length(text, shortest) >= VOLUME_BODY_MAX, f'差一点被误标：{shortest!r}'


# ---------------------------------------------------------------------------
# 4. 「按书成类的编号习惯」那三条新规则的真实书基线
#
# 每一本都是"旧表一条规则都表达不了它的标题、于是整本失去导航"的书。数值是全量扫
# `public/books/*.txt.gz` 量出来的，格式 `(规则名, 节点数, 改动前节点数)`。
# 第三个数不参与断言，写在这里是为了让"到底修好了什么"一眼可见。
# ---------------------------------------------------------------------------

#: book_id → (自动判定选中的规则, 节点数, 改动前的节点数)
FIX_TARGETS: Dict[str, Tuple[str, int, int]] = {
    # (a) 单位字在前、序号在后
    '乌纱-西风紧_2': ('单位 序号', 398, 27),
    '捡个萝莉当老婆-本人杨建东': ('单位 序号', 378, 29),
    '狩魔手记-烟雨江南': ('单位 序号', 567, 33),
    '尘缘-烟雨江南': ('单位 序号', 88, 170),      # 改动前 170 个节点全叫 `※※※`
    '尘缘-烟雨江南_2': ('单位 序号', 88, 21),
    '奉天承运-西风紧': ('单位 序号', 262, 25),
    # (b) 生僻但规整的章节单位
    '东瀛百鬼-张小琉': ('标准章节', 49, 8),
    '萌娘武侠世界-三十二变': ('标准章节', 1064, 1062),   # 改动前整本走全书兜底
    # (d) 括号里只有序号 + 标题
    '我的老婆是妖精-浪漫烟灰': ('括号装饰', 340, 51),
    '神迹-阿木': ('括号装饰', 38, 7),
    '斩龙-失落叶': ('括号装饰', 255, 17),
    # (e) 大写数字 + 全角冒号
    '历史真的很有料-雾满拦江': ('大写数字 冒号 标题', 33, 30),
}

#: `toc-overrides.json` 里点名 `纯序号行` 的书，(节点数, 改动前节点数)。
#: 这条规则默认关闭，所以这一组走的是覆盖表而不是自动判定——理由见
#: `toc_rules` 模块 docstring 与 `toc-overrides.json` 里逐本的注释键。
FIX_PINNED: Dict[str, Tuple[int, int]] = {
    '夜半笛声-蔡骏': (103, 53),
    '神在看着你-蔡骏': (87, 77),
    '绝秦书-张浩文': (48, 38),
    '单身女王-马广源': (21, 11),
    '长安乱-韩寒': (9, 5),
    '盛夏的樱花树-沈星妤': (39, 21),
    '网游之江湖任务行-蝴蝶蓝': (17, 4),
}


@real_books
@pytest.mark.parametrize('book_id,expected', sorted(FIX_TARGETS.items()))
def test_new_rules_rescue_the_target_books(book_id: str, expected: Tuple[str, int, int]):
    rule_name, node_count, _before = expected
    text, chapters, picked = split_real(book_id)
    assert picked == rule_name
    assert len(chapters) == node_count
    assert_covers(chapters, text)
    # 每个非合成标题都必须真的坐在自己那一行的行首（需求 8.15）——
    # 这是"新边界落在真标题上"的机器可验版本
    for chapter in chapters:
        start = chapter['start']
        assert start == 0 or text[start - 1] in '\r\n'


@real_books
@pytest.mark.parametrize('book_id,expected', sorted(FIX_PINNED.items()))
def test_pinned_books_use_the_numeral_line_rule(book_id: str, expected: Tuple[int, int]):
    from scripts.lib import toc_overrides

    node_count, _before = expected
    path = BOOKS_DIR / f'{book_id}.txt.gz'
    if not path.exists():
        pytest.skip(f'{book_id} 不在本地 public/books 里')
    overrides = toc_overrides.load()
    assert book_id in overrides, f'{book_id} 不在 toc-overrides.json 里'
    text = read_full(book_id)
    pick = toc_overrides.pick_rule_for(text, book_id, overrides)
    assert (pick.name, pick.overridden) == ('纯序号行', True)
    chapters = split_chapters(text, pick.rule)
    assert len(chapters) == node_count
    assert_covers(chapters, text)


@real_books
def test_real_books_keep_a_margin_above_the_volume_threshold():
    # 门槛 100 不是拍出来的：最短的正文章节离它还有 130 字符的余量。
    # 任务 18 实测这个数是 143，现在是 230——垫底的那几章原本是正文误报切出来的
    # 碎片，`UNIT` 的后缀白名单与 `filter_prose_hits` 把它们消掉之后，
    # 最短的正文章节变成了《NB-NB》那条 230 字符的序章。
    margins = {}
    for book_id in BASELINE:
        path = BOOKS_DIR / f'{book_id}.txt.gz'
        if not path.exists():
            continue
        text, chapters, _ = split_real(book_id)
        margins[book_id] = min(
            body_length(text, c) for c in chapters if not c.get('isVolume')
        )
    assert margins, 'public/books 里一本书都没有'
    assert min(margins.values()) == 230, f'最短正文的实测值变了：{margins}'
