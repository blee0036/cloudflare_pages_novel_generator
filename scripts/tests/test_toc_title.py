# -*- coding: utf-8 -*-
r"""`scripts/lib/toc.py` 的标题净化（任务 20，需求 8.1 / D16，design §4.6）。

运行（仓库根目录）：`python -m pytest scripts/tests -q`

断言四组事实：

1. **净化本身**：折叠内部空白、去除成对装饰符号、净化成空回退 `第 N 节`，
   以及 `第 N 节` 与全书兜底的 `第 N 部分` 保持互不混用。
2. **不改坏半边形态**：`青石巷(12)`（规则 9 的主力形态）、`第一章（上）` 原样保留。
   design §4.6 的草图会把它们剥成 `青石巷(12` / `第一章（上`，这里按"成对"处理。
3. **幂等 + 严格相等**（任务 20 的核心约束）：`clean_title` 在一个组合枚举出来的输入
   空间上幂等，于是 `_title_line_end` 能用 `clean_title(源行) == title` 认出标题行——
   被净化改写过的标题照样能被标成卷（不会退化成"少标卷"）。
4. **真实书**：5 本真书里到底有几个标题被净化改写（答案：2 个，都在《NB-NB》），
   且卷标记与任务 18/19 的基线一字不差。

夹具一律用 CRLF，理由同 `test_toc_split.py`。
"""

from __future__ import annotations

import gzip
import itertools
from pathlib import Path
from typing import Dict, List, Sequence, Tuple

import pytest

from scripts.lib.toc import (
    CHAPTER_MAX,
    TITLE_PAIRS,
    VOLUME_BODY_MAX,
    Chapter,
    body_length,
    clean_title,
    fallback_title,
    normalize_title,
    pick_rule,
    section_title,
    split_chapters,
)
# 取"章节的第一行"必须用模块自己的行边界定义，否则这组测试会对着另一套行语义断言。
from scripts.lib.toc import _LINE_BREAK
from scripts.lib.toc_rules import by_name

STANDARD = by_name('标准章节')
TOP_SHORT = by_name('顶格短行')

NL = '\r\n'

BOOKS_DIR = Path(__file__).resolve().parents[2] / 'public' / 'books'

real_books = pytest.mark.skipif(
    not BOOKS_DIR.is_dir() or not any(BOOKS_DIR.glob('*.txt.gz')),
    reason='public/books 是 gitignore 的本地产物，缺失时跳过真实书基线',
)


def body(chars: int) -> str:
    """一段 `chars` 个字符（含收尾 CRLF）的正文。不会被任何规则当成标题。"""
    return '雨' * (chars - 2) + NL


def titles(chapters: Sequence[Chapter]) -> List[str]:
    return [c['title'] for c in chapters]


# ---------------------------------------------------------------------------
# 1. 折叠内部空白
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('raw,expected', [
    ('第一章 甲', '第一章 甲'),                       # 已规范：原样
    ('第一章  甲', '第一章 甲'),                      # 双半角
    ('第一章\u3000甲', '第一章 甲'),                  # 全角空格（中文 txt 的主流）
    ('第一章\t甲', '第一章 甲'),                      # 制表
    ('第一章\xa0甲', '第一章 甲'),                    # NBSP
    ('第一章 \u3000 甲', '第一章 甲'),                # 混合空白算一处
    ('  第一章 甲  ', '第一章 甲'),                   # 首尾空白
    ('\u3000\u3000第一章 甲', '第一章 甲'),           # 全角缩进
    ('第一章 甲 乙 丙', '第一章 甲 乙 丙'),            # 多处各折叠一次
    ('第一回  春寒露沾衣', '第一回 春寒露沾衣'),        # 《NB-NB》实测形态之一
    ('第十回\u3000青光之眼', '第十回 青光之眼'),        # 《NB-NB》实测形态之二
])
def test_interior_whitespace_is_collapsed_to_one_space(raw: str, expected: str):
    assert clean_title(raw) == expected


def test_whitespace_is_collapsed_to_a_half_width_space():
    # 折叠成半角空格而不是保留原字符：同一本书里 `甲 乙`/`甲　乙` 混排时标题才一致
    assert clean_title('甲\u3000乙') == '甲 乙'
    assert '\u3000' not in clean_title('甲\u3000乙')


# ---------------------------------------------------------------------------
# 2. 成对装饰符号
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('open_,close', sorted(TITLE_PAIRS.items()))
def test_every_registered_pair_is_stripped(open_: str, close: str):
    assert clean_title(f'{open_}第一章 夜行{close}') == '第一章 夜行'


def test_nested_pairs_are_stripped_to_the_core():
    # 逐层剥到不能剥为止——这同时是幂等的必要条件
    assert clean_title('『「第一章 夜行」』') == '第一章 夜行'
    assert clean_title('【（第一章）】') == '第一章'
    assert clean_title('（（第一章））') == '第一章', '同型嵌套也要剥干净'


@pytest.mark.parametrize('raw', [
    '（甲）乙（丙）',      # 行首那个 `（` 在中间就闭合了
    '【甲】乙【丙】',
    '(甲)乙',
    '（上）第一章（下）',
])
def test_two_separate_pairs_are_not_mistaken_for_one_enclosing_pair(raw: str):
    """"首字符是开符号且尾字符是它的闭符号"不够——要数配对深度。

    否则 `（甲）乙（丙）` 会被剥成 `甲）乙（丙`，和 design §4.6 草图那个 bug 同一类。
    """
    assert clean_title(raw) == raw


def test_decoration_and_whitespace_are_handled_together():
    assert clean_title('\u3000【 第一章\u3000\u3000夜行 】 ') == '第一章 夜行'


def test_a_dangling_half_is_stripped_when_its_partner_is_absent():
    # `toc_rules._OPEN` 明确说很多书只写左半
    assert clean_title('【第一章 夜行') == '第一章 夜行'
    assert clean_title('第一章 夜行】') == '第一章 夜行'
    assert clean_title('【【第一章 夜行') == '第一章 夜行'


@pytest.mark.parametrize('raw', [
    '青石巷(12)',        # 规则 9「书名 序号」的主力形态
    '青石巷（12）',
    '第一章（上）',
    '第一章 甲(1)',      # 与 `split_overlong` 的片段命名同形
    '第一章 甲（下篇）',
])
def test_a_matched_pair_inside_the_title_is_left_alone(raw: str):
    """行尾闭符号在行内有配对的开符号时**不剥**——这是与 design §4.6 草图的实质偏差。

    草图的 `re.sub(r'^…|…$', '', t)` 两个分支独立，会把这些标题剥成 `青石巷(12`、
    `第一章（上`。任务 20 的措辞是"去除**成对**装饰符号"，按成对处理才不改坏它们。
    """
    assert clean_title(raw) == raw


def test_title_marks_are_not_decoration():
    # 书名号/尖括号承载语义，剥掉是改写标题（TITLE_PAIRS 故意不含它们）
    assert clean_title('《青石巷》') == '《青石巷》'
    assert clean_title('〈第一章〉') == '〈第一章〉'


# ---------------------------------------------------------------------------
# 3. 净化成空的回退
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('raw', ['【】', '（）', '()', '「」', '【', '】', '\u3000 \t', ''])
def test_clean_title_can_return_empty(raw: str):
    assert clean_title(raw) == ''


def test_normalize_title_falls_back_to_a_section_number():
    assert normalize_title('【】', 0) == '第 1 节'
    assert normalize_title('', 6) == '第 7 节'
    assert normalize_title('  ', 0) == '第 1 节'


def test_normalize_title_returns_the_clean_title_when_it_is_not_empty():
    assert normalize_title('【第一章  夜行】', 3) == '第一章 夜行'


def test_the_section_fallback_is_distinct_from_the_whole_book_fallback():
    # 两者混用会让 check_toc.py（任务 27）分不清"兜底书"和"标题被净化光的书"
    assert section_title(0) == '第 1 节'
    assert fallback_title(1) == '第 1 部分'
    assert section_title(0) != fallback_title(1)
    for index in range(50):
        assert section_title(index) != fallback_title(index + 1)


def test_prev_is_accepted_and_ignored():
    # 需求 D16 只要求净化环节"能看见"上下文；当前实现是固定两步，用不上
    prev = [{'id': 0, 'title': '第一卷', 'start': 0, 'end': 9, 'length': 9, 'isVolume': True}]
    assert normalize_title('第一章  甲', 1, prev) == '第一章 甲'
    assert normalize_title('第一章  甲', 1) == normalize_title('第一章  甲', 1, prev)


# ---------------------------------------------------------------------------
# 4. 幂等：`_title_line_end` 的严格相等全靠这一条
#
# 没有引 hypothesis（会给 scripts/requirements.txt 加一个只有测试用的依赖），
# 改用组合枚举：把排版噪声拆成若干片段，四片一组穷举出 3 万多个输入，
# 覆盖"装饰符号 × 空白 × 正文 × 半边括号"的全部组合形态。
# ---------------------------------------------------------------------------

#: 枚举用的片段：正文、空白、成对符号的两半（含不该剥的书名号）、数字尾缀。
_PARTS: Tuple[str, ...] = (
    '', '第一章', '甲', '12',
    ' ', '\u3000',
    '【', '】', '（', '）', '(', ')', '《', '》',
)


def _corpus() -> List[str]:
    return [''.join(combo) for combo in itertools.product(_PARTS, repeat=4)]


def test_clean_title_is_idempotent_over_the_whole_corpus():
    corpus = _corpus()
    assert len(corpus) == len(_PARTS) ** 4 == 38_416
    for raw in corpus:
        once = clean_title(raw)
        assert clean_title(once) == once, f'不幂等：{raw!r} -> {once!r} -> {clean_title(once)!r}'


def test_clean_title_output_is_always_in_normal_form():
    for raw in _corpus():
        out = clean_title(raw)
        assert out == out.strip(), f'首尾还有空白：{out!r}'
        assert '  ' not in out and '\u3000' not in out and '\t' not in out, f'空白没折叠：{out!r}'
        assert len(out) <= len(raw), f'净化只删不增：{raw!r} -> {out!r}'


def test_normalize_title_is_never_empty_and_agrees_with_clean_title():
    # 这两条合起来就是 `_title_line_end` 依赖的等式：
    # 只要净化结果非空，`clean_title(源行)` 就恰好等于写进产物的 `title`。
    for index, raw in enumerate(_corpus()):
        cleaned = clean_title(raw)
        final = normalize_title(raw, index)
        assert final, f'标题不许为空：{raw!r}'
        if cleaned:
            assert final == cleaned
        else:
            assert final == section_title(index)


# ---------------------------------------------------------------------------
# 5. 接入 split_book：净化之后标题行仍然认得出来（不退化成"少标卷"）
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('rule_name,title_line', [
    ('标准章节', '第二卷\u3000\u3000大乱斗'),   # 只折叠空白
    ('括号装饰', '【第二卷\u3000\u3000大乱斗】'),  # 折叠空白 + 去装饰
])
def test_a_normalized_volume_title_is_still_marked_as_a_volume(
    rule_name: str, title_line: str
):
    """任务 20 的核心回归：净化改写了标题，`body_length` 仍要认出那一行。

    若 `_title_line_end` 还用 `源行.strip() != title` 比对，这两个卷节点都会被算成
    "整章都是正文"（>= 100 字符），于是漏标——正是任务里点名不许接受的降级。
    """
    rule = by_name(rule_name)
    decorate = '【{}】'.format if rule_name == '括号装饰' else '{}'.format
    text = (
        decorate('第一章 甲') + NL + body(800)
        + title_line + NL + body(VOLUME_BODY_MAX - 1)
        + decorate('第三章 丙') + NL + body(800)
    )
    chapters = split_chapters(text, rule)
    volume = chapters[1]
    assert volume['title'] == '第二卷 大乱斗'
    assert body_length(text, volume) == VOLUME_BODY_MAX - 1, '标题行被正确扣掉'
    assert volume['isVolume'] is True
    # 不改 start/end：range 仍从标题行**原文**起始
    assert text.startswith(title_line, volume['start'])
    assert volume['length'] == len(title_line) + 2 + VOLUME_BODY_MAX - 1


def test_a_normalized_content_title_is_not_marked_as_a_volume():
    # 反向：正文足够长的章不因净化被误标
    text = (
        '【第一章\u3000\u3000甲】' + NL + body(800)
        + '【第二章 乙】' + NL + body(800)
    )
    chapters = split_chapters(text, by_name('括号装饰'))
    assert titles(chapters) == ['第一章 甲', '第二章 乙']
    assert [c.get('isVolume') for c in chapters] == [None, None]


def test_overlong_chapter_with_a_normalized_title_still_yields_a_volume_head():
    # `split_overlong` 也走 `_title_line_end`：认不出标题行就没有卷头、片段铺满整段
    #
    # 尾部那 12 章不是装饰：`toc.Coverage` 的篇幅门槛要求"可读节点"覆盖全书三成以上，
    # 而这本夹具的主体是一个 15 万字符的超长章（本身就是无命中的巨块）。真书里
    # "某一章超长"总是发生在一本有几十上百章的书里，夹具得有同样的背景，
    # 否则整本会被判成"这几条命中不是目录"而走全书兜底——那是门槛的正确行为，
    # 单独钉在 `test_toc_floor.py` 里。
    title_line = '【第七章\u3000\u3000甲】'
    tail = [f'【第{n}章 丙】' for n in range(8, 20)]
    text = (
        '【第一章 乙】' + NL + body(800)
        + title_line + NL
        + ('雨' * 4998 + NL) * 30          # 15 万字符，超过 CHAPTER_MAX
        + ''.join(line + NL + body(12_000) for line in tail)
    )
    chapters = split_chapters(text, by_name('括号装饰'))
    assert titles(chapters) == [
        '第一章 乙', '第七章 甲', '第七章 甲(1)', '第七章 甲(2)',
        *(t.strip('【】') for t in tail),
    ]
    head = chapters[1]
    assert head['isVolume'] is True
    assert head['length'] == len(title_line) + 2, '卷头只覆盖标题行本身'
    assert chapters[2]['start'] == head['end']
    assert all(c['length'] <= CHAPTER_MAX for c in chapters[2:4])
    # 片段标题是在**已净化**的标题上加序号，不会把装饰符号带进去
    assert '【' not in chapters[2]['title']


def test_an_emptied_title_loses_the_title_line_match_and_that_is_the_safe_direction():
    """净化成空是唯一不精确的情形，方向是**少标卷**，与合成标题同类。

    `第 N 节` 在原文里没有对应文本，所以 `_title_line_end` 比对失败是正确答案
    （和 `序章 / 前言`、`第 N 部分` 一样）。代价是这一节的"正文长度"把装饰行也算进去，
    卡在 100 这条线上时会漏标。这里把它钉住，让它是**写明的**取舍而不是静默降级。
    """
    text = (
        '【】' + NL + body(VOLUME_BODY_MAX - 1)
        + '第一章 甲' + NL + body(800)
        + '第二章 乙' + NL + body(800)
    )
    chapters = split_chapters(text, TOP_SHORT)
    assert titles(chapters) == ['第 1 节', '第一章 甲', '第二章 乙']
    node = chapters[0]
    assert body_length(text, node) == node['length'], '合成标题 → 整段都算正文'
    assert node['length'] == len('【】') + 2 + VOLUME_BODY_MAX - 1
    assert node.get('isVolume') is None, '真实正文 99 字符本该标卷，这里漏标，方向安全'


def test_synthetic_titles_are_unaffected_by_normalization():
    # 序章与兜底块的标题不经过 normalize_title，`第 N 节` 不会出现在它们身上
    text = body(300) + '第一章 甲' + NL + body(800) + '第二章 乙' + NL + body(800)
    chapters = split_chapters(text, STANDARD)
    assert chapters[0]['title'] == '序章 / 前言'
    assert '节' not in chapters[0]['title']


# ---------------------------------------------------------------------------
# 6. 真实书：净化到底动了几个标题
#
# `public/books/` 是 gitignore 的本地产物，干净检出时这组整体跳过。
# ---------------------------------------------------------------------------

#: book_id → 被净化改写的标题数。任务 20 的实测结果：6961 个节点里只有 2 个。
NORMALIZED: Dict[str, int] = {
    '1852铁血中华-绯红之月': 0,
    '1991从芯开始-三分糊涂': 0,
    'BUG之神-耳火大帝': 0,
    'NB-NB': 2,
    '从零开始-雷云风暴': 0,
}


def read_full(book_id: str) -> str:
    path = BOOKS_DIR / f'{book_id}.txt.gz'
    with gzip.open(path, 'rt', encoding='utf-8', newline='') as f:
        return f.read()


def first_line(text: str, chapter: Chapter) -> str:
    """章节的第一行原文（不含行终止符）。"""
    start, end = int(chapter['start']), int(chapter['end'])
    match = _LINE_BREAK.search(text, start, end)
    return text[start:match.start()] if match else text[start:end]


def split_real(book_id: str) -> Tuple[str, List[Chapter]]:
    if not (BOOKS_DIR / f'{book_id}.txt.gz').exists():
        pytest.skip(f'{book_id} 不在本地 public/books 里')
    text = read_full(book_id)
    pick = pick_rule(text)
    assert pick.rule is not None
    return text, split_chapters(text, pick.rule)


@real_books
@pytest.mark.parametrize('book_id,expected', sorted(NORMALIZED.items()))
def test_real_book_normalization_touches_only_the_known_titles(book_id: str, expected: int):
    text, chapters = split_real(book_id)
    changed = [
        (first_line(text, c).strip(), c['title'])
        for c in chapters
        if clean_title(first_line(text, c)) == c['title']      # 标题取自这一行
        and first_line(text, c).strip() != c['title']          # 且净化改写了它
    ]
    assert len(changed) == expected, f'净化改写的标题变了：{changed[:5]}'


@real_books
def test_the_two_changed_titles_are_whitespace_collapses():
    text, chapters = split_real('NB-NB')
    changed = {
        first_line(text, c).strip(): c['title']
        for c in chapters
        if clean_title(first_line(text, c)) == c['title']
        and first_line(text, c).strip() != c['title']
    }
    assert changed == {
        '第一卷 浮云聚，渺万里青冥 第七章 神农架特区 第十回  春寒露沾衣':
            '第一卷 浮云聚，渺万里青冥 第七章 神农架特区 第十回 春寒露沾衣',
        '第一卷 浮云聚，渺万里青冥 第十三章 山海图略志 第十回\u3000青光之眼，沔水方书':
            '第一卷 浮云聚，渺万里青冥 第十三章 山海图略志 第十回 青光之眼，沔水方书',
    }


@real_books
@pytest.mark.parametrize('book_id', sorted(NORMALIZED))
def test_normalization_does_not_break_the_title_line_match_on_real_books(book_id: str):
    """每个非合成标题的章节都必须认得出自己的标题行（否则就是"少标卷"的入口）。

    口径：第一行净化之后等于 `title` 的章节（= 标题取自原文那一行），
    其 `body_length` 必须真的扣掉了那一行。
    """
    text, chapters = split_real(book_id)
    matched = 0
    for chapter in chapters:
        line = first_line(text, chapter)
        if clean_title(line) != chapter['title']:
            continue
        matched += 1
        consumed = chapter['length'] - body_length(text, chapter)
        assert consumed >= len(line), f'标题行没被扣掉：{chapter!r}'
    assert matched >= len(chapters) - 1, '除了序章，每个章节的标题都该取自原文'
