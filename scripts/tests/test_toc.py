# -*- coding: utf-8 -*-
r"""`scripts/lib/toc.py` 的按行扫描器与择一评分器（任务 17，需求 8.1–8.5）。

运行（仓库根目录）：`python -m pytest scripts/tests -q`

这里断言四件事：

1. **行边界与偏移**：`iter_lines` 的行内容与 `str.splitlines()` 逐字符相同，
   偏移与 `splitlines(keepends=True)` 的累加一致——CRLF 文本不许出现每行差 1 的漂移。
2. **输入契约**：喂给规则的是"一行原文"，缩进不 strip（否则第 14 条「顶格短行」失效）；
   偏移指向**标题行行首**（design §0 修订一：章节 range 含自身标题行）。
3. **评分口径**：间隔 >1000 计有效、<100 计误报、其间不计；误报门槛 3:1、
   取代门槛 +2、有效数 >70 提前退出。
4. **真实基线**：5 本真书各自选中的规则与 n_ok/n_bad（`public/books/` 是 gitignore
   的本地产物，缺失时这组自动跳过）。
"""

from __future__ import annotations

import gzip
import re
from pathlib import Path
from typing import List, Sequence, Tuple

import pytest

from scripts.lib.toc import (
    EARLY_EXIT,
    FALSE_RATIO,
    GAP_CHAPTER,
    GAP_VOLUME,
    OVER_RULE,
    SAMPLE_CHARS,
    RuleScore,
    iter_lines,
    pick_rule,
    sample_lines,
    scan,
    scan_text,
    score_rule,
)
from scripts.lib.toc_rules import RULES, RULES_BY_NAME, TocRule, by_name

#: 合成样本一律用 CRLF。真实产物就是 CRLF（任务 15：解码结果保留 CRLF，
#: 且与 `.gz` 内容逐字节一致），而 CRLF 正是偏移最容易错 1 的那种文本。
NL = '\r\n'

ENABLED_COUNT = len([r for r in RULES if r.enabled])


# ---------------------------------------------------------------------------
# 合成样本：按"标题该落在哪个偏移"造文本
# ---------------------------------------------------------------------------


def _pad(gap: int) -> str:
    """造出恰好 `gap` 个字符、且以行终止符收尾的填充块。

    以终止符收尾是必要的：下一个标题必须落在**行首**才会被按行扫描看到。
    """
    if gap == 0:
        return ''
    if gap == 1:
        return '\n'
    if gap == 2:
        return NL
    return '正' * (gap - 2) + NL


def place(spec: Sequence[Tuple[int, str]], tail: int = 600) -> str:
    """把 `[(目标偏移, 标题行)]` 铺到一张正文底布上，返回全文。

    偏移递增且相邻间隔 ≥ 标题行长度 + 2 时，标题行首恰好落在给定偏移。
    """
    parts: List[str] = []
    pos = 0
    for offset, title in spec:
        gap = offset - pos
        assert gap >= 0, f'偏移 {offset} 落在已写出的内容里'
        block = _pad(gap)
        parts.append(block)
        pos += len(block)
        assert pos == offset, f'填充块对不上：{pos} != {offset}'
        line = title + NL
        parts.append(line)
        pos += len(line)
    parts.append(_pad(tail))
    return ''.join(parts)


def chapters(count: int, body: int = 1200, first: int = 0) -> str:
    """造 `count` 章 `第N章 标题`，每章正文 `body` 字符（间隔 > GAP_CHAPTER）。"""
    step = body + 16
    return place([(first + i * step, f'第{i + 1}章 标题{i + 1}') for i in range(count)])


# ---------------------------------------------------------------------------
# 1. 行边界与偏移
# ---------------------------------------------------------------------------

TEXTS = [
    '',
    'a',
    'a\n',
    'a\nb',
    'a\r\nb\r\n',
    'a\rb\r',
    '\n\n\n',
    '\r\n\r\n',
    '第一章 甲\r\n正文\r\n第二章 乙\r\n',
    '\u3000\u3000缩进行\r\n顶格行\r\n',
    # splitlines 的冷门边界：垂直制表、换页、FS/GS/RS、NEL、行/段分隔符
    'a\vb\fc\x1cd\x1de\x1ef\x85g\u2028h\u2029i',
    '尾行无终止符',
]


@pytest.mark.parametrize('text', TEXTS, ids=range(len(TEXTS)))
def test_iter_lines_matches_splitlines(text: str):
    # 规则表的输入契约就是"splitlines 的产物"，这条把等价性钉死
    assert [line for _, line in iter_lines(text)] == text.splitlines()


@pytest.mark.parametrize('text', TEXTS, ids=range(len(TEXTS)))
def test_offsets_point_at_the_real_line_start(text: str):
    pos = 0
    for offset, line in iter_lines(text):
        assert offset >= pos
        # 行首偏移与行内容必须在原文里对得上
        assert text.startswith(line, offset)
        # 上一行结尾到本行行首之间只能是行终止符，一个字符都不许漏算
        assert not text[pos:offset].strip('\r\n\v\f\x1c\x1d\x1e\x85\u2028\u2029')
        pos = offset + len(line)


def test_crlf_does_not_shift_offsets():
    # 每行差 1 个字符是现有产物的真实缺陷（gz 4,814,326 字符 vs charCount 4,762,018）。
    # 按 LF 记偏移、按 CRLF 存产物就会这样，所以这里逐行核对。
    text = 'a\r\nbb\r\n第三章 丙\r\n'
    assert list(iter_lines(text)) == [(0, 'a'), (3, 'bb'), (7, '第三章 丙')]
    assert text.startswith('第三章 丙', 7)


def test_limit_keeps_the_straddling_line_whole():
    text = place([(0, '第一章 甲'), (2000, '第二章 乙')])
    rule = by_name('标准章节')
    # 行首偏移 2000 不小于 limit，整行都不产出
    assert [o for o, _ in scan_text(text, rule, limit=2000)] == [0]
    # 行首在 limit 之内的行整行产出，不会被截成半行
    assert [o for o, _ in scan_text(text, rule, limit=2001)] == [0, 2000]
    assert list(iter_lines(text, limit=2001))[-1] == (2000, '第二章 乙')


def test_limit_zero_yields_nothing():
    assert list(iter_lines('第一章 甲\r\n正文', limit=0)) == []


def test_sample_lines_stops_at_the_sample_window():
    text = chapters(3, body=SAMPLE_CHARS)
    assert all(offset < SAMPLE_CHARS for offset, _ in sample_lines(text))


# ---------------------------------------------------------------------------
# 2. 输入契约：一行原文，偏移在行首
# ---------------------------------------------------------------------------


def test_scan_yields_line_start_offset_and_raw_line():
    # 缩进保留、偏移指向缩进的第一个字符——章节 range 以标题行行首起始（design §0 修订一）
    # 底布不用「正文」：它本身就是 SPECIAL 里的一个标题词。
    text = '雨停了\r\n\u3000\u3000第七章 夜行\r\n雨停了\r\n'
    hits = list(scan_text(text, by_name('标准章节')))
    assert hits == [(5, '\u3000\u3000第七章 夜行')]
    offset, title = hits[0]
    assert text.startswith(title, offset)
    assert not title.startswith('第'), '标题不许被预先 strip（净化是任务 20 的事）'


def test_scan_does_not_prestrip_the_line():
    # 第 14 条靠 `^\S` 判顶格。若扫描器先 strip，缩进行也会被当成顶格短行。
    text = '\u3000\u3000缩进行\r\n顶格行\r\n'
    hits = list(scan_text(text, by_name('顶格短行')))
    assert [t for _, t in hits] == ['顶格行']


def test_titles_ending_with_exclamation_are_kept():
    # 旧版的 END_PUNCT 预筛会丢掉这类标题：实测《从零开始》全书 225 条真标题受害。
    text = place([(0, '第六章 练级！练级！'), (2000, '第七章 恶魔是怎么炼成的？')])
    assert [t for _, t in scan_text(text, by_name('标准章节'))] == [
        '第六章 练级！练级！',
        '第七章 恶魔是怎么炼成的？',
    ]


@pytest.mark.parametrize('toc_rule', RULES, ids=[r.name for r in RULES])
def test_no_rule_matches_an_empty_line(toc_rule: TocRule):
    # `scan` 有一条"空行直接跳过"的快路径，它的正确性依赖这个前提
    assert not toc_rule.match('')


def test_scan_text_equals_scan_over_prebuilt_lines():
    text = chapters(5)
    rule = by_name('标准章节')
    assert list(scan_text(text, rule)) == list(scan(sample_lines(text), rule))


# ---------------------------------------------------------------------------
# 3. 评分口径（需求 8.3–8.5）
# ---------------------------------------------------------------------------


def score(text: str, rule_name: str = '标准章节') -> RuleScore:
    return score_rule(sample_lines(text), by_name(rule_name))


def test_far_apart_hits_count_as_chapters():
    s = score(chapters(4))
    assert (s.hits, s.n_ok, s.n_bad) == (4, 4, 0)


def test_dense_hits_count_as_false_positives():
    s = score(place([(0, '第一章 甲'), (50, '第二章 乙'), (90, '第三章 丙')]))
    # 首个命中无条件算有效，其后两个都贴得太近
    assert (s.hits, s.n_ok, s.n_bad) == (3, 1, 2)


def test_grey_zone_counts_for_neither_side():
    s = score(place([
        (0, '第一章 甲'),
        (500, '第二章 乙'),      # 灰区：既不计有效也不计误报，且不推进基准
        (900, '第三章 丙'),      # 仍以 0 为基准 → 900，还在灰区
        (2000, '第四章 丁'),     # 以 0 为基准 → 2000 > 1000，有效
    ]))
    assert (s.hits, s.n_ok, s.n_bad) == (4, 2, 0)


def test_gap_thresholds_are_strict_inequalities():
    # 恰好 GAP_CHAPTER 不算有效，恰好 GAP_VOLUME 不算误报
    at_chapter = score(place([(0, '第一章 甲'), (GAP_CHAPTER, '第二章 乙')]))
    assert (at_chapter.n_ok, at_chapter.n_bad) == (1, 0)
    at_volume = score(place([(0, '第一章 甲'), (GAP_VOLUME, '第二章 乙')]))
    assert (at_volume.n_ok, at_volume.n_bad) == (1, 0)


def test_first_hit_is_ok_even_at_offset_zero():
    # design 的伪码用 `last == 0` 表示"还没有基准"，那会让首标题恰在偏移 0 的书
    # （`第一章` 就是第一行，很常见）白送第二个命中一次免检。这里用显式哨兵，
    # 所以紧跟其后的密集命中照样记误报。
    s = score(place([(0, '第一章 甲'), (20, '第二章 乙')]))
    assert (s.n_ok, s.n_bad) == (1, 1)


def test_base_advances_only_on_valid_chapters():
    # 误报不推进基准：第三条命中按"距 0"算 1050 > 1000 记有效；
    # 若基准被误报推到了 60，它就只剩 990，会掉进灰区变成 n_ok=1。
    s = score(place([(0, '第一章 甲'), (60, '第二章 乙'), (1050, '第三章 丙')]))
    assert (s.n_ok, s.n_bad) == (2, 1)


@pytest.mark.parametrize(
    'n_ok,n_bad,usable',
    [(0, 0, True), (3, 1, True), (2, 1, False), (300, 100, True), (299, 100, False)],
)
def test_usable_gate_is_three_to_one(n_ok: int, n_bad: int, usable: bool):
    # 需求 8.3：误报超过有效数的 1/3 即整条规则不可用
    assert RuleScore('x', n_ok=n_ok, n_bad=n_bad, hits=n_ok + n_bad).usable is usable
    assert FALSE_RATIO == 3


# ---------------------------------------------------------------------------
# 4. 择一（需求 8.1 / 8.4 / 8.5 / 8.6）
# ---------------------------------------------------------------------------

RULE_A = TocRule(name='测试甲', pattern=re.compile(r'^AAA.*$'), example='AAA')
RULE_B = TocRule(name='测试乙', pattern=re.compile(r'^BBB.*$'), example='BBB')


def two_rule_book(n_a: int, n_b: int, step: int = 2000) -> str:
    """A、B 两种标题交错铺开，各自内部间隔 `step` > GAP_CHAPTER。"""
    spec = [(i * step, 'AAA 甲') for i in range(n_a)]
    spec += [(i * step + step // 2, 'BBB 乙') for i in range(n_b)]
    return place(sorted(spec))


def test_picks_the_standard_rule_for_a_normal_chinese_book():
    pick = pick_rule(chapters(12))
    assert pick.name == '标准章节'
    assert (pick.n_ok, pick.n_bad) == (12, 0)
    # 选中的名字就是写进 `_toc.json` 的 `tocRule` 字段的值
    assert pick.name in RULES_BY_NAME


def test_returns_none_when_no_rule_is_usable():
    # 无任何章节标记 → 没有规则能赢，交给全书兜底（需求 8.9，任务 19）
    prose = place([(0, '他推开门，外面的雨已经停了。'), (2000, '这一天就这样过去了。')])
    pick = pick_rule(prose)
    assert pick.rule is None
    assert pick.name is None
    assert (pick.n_ok, pick.n_bad) == (0, 0)


def test_dense_rule_is_vetoed_by_the_false_ratio():
    # 命中最多的规则也可能整条被否决——这是空章问题（D5）的解药
    dense = place([(i * 40, f'{i + 1}、甲') for i in range(30)])
    single = score_rule(sample_lines(dense), by_name('数字 分隔符 标题'))
    assert single.hits == 30 and not single.usable
    assert pick_rule(dense).rule is None


def test_challenger_needs_more_than_two_extra_chapters():
    # 平手或微弱领先时保留靠前的保守规则（需求 8.4）
    assert OVER_RULE == 2
    tie = pick_rule(two_rule_book(5, 7), rules=(RULE_A, RULE_B))
    assert (tie.name, tie.n_ok) == ('测试甲', 5)
    win = pick_rule(two_rule_book(5, 8), rules=(RULE_A, RULE_B))
    assert (win.name, win.n_ok) == ('测试乙', 8)


def test_early_exit_above_seventy():
    pick = pick_rule(chapters(EARLY_EXIT + 2))
    assert pick.name == '标准章节'
    assert pick.early_exit is True
    assert len(pick.scores) == 1, '提前退出后不该再评估任何规则'


def test_exactly_seventy_does_not_trigger_early_exit():
    pick = pick_rule(chapters(EARLY_EXIT))
    assert pick.n_ok == EARLY_EXIT
    assert pick.early_exit is False
    assert len(pick.scores) == ENABLED_COUNT


def test_disabled_rules_never_participate():
    # 顶格短行会匹配这本书的每一行标题，但它默认关闭（需求 8.6），
    # 只能由覆盖表（任务 21）显式点名。纯序号行同理——它默认关闭的理由不是"不精确"
    # 而是"对错取决于整本书"，见 toc_rules 模块 docstring。
    pick = pick_rule(chapters(EARLY_EXIT))
    evaluated = [s.name for s in pick.scores]
    for name in ('纯序号行', '顶格短行', '通用激进'):
        assert name not in evaluated, name
    assert evaluated == [r.name for r in RULES if r.enabled]


def test_text_and_prebuilt_lines_give_the_same_pick():
    text = chapters(9)
    assert pick_rule(text) == pick_rule(sample_lines(text))


def test_only_the_sample_window_is_scored():
    """需求 8.2：选规则只看前 SAMPLE_CHARS 个字符。

    采样窗口里铺满章节（`EARLY_EXIT` 之内的 60 章，正文 1.2 万字符一章 ≈ 72 万字符），
    窗口之外再放 50 章。窗口内的 60 章一条不少、窗口外的 50 章一条不算，`n_ok` 就是 60。

    窗口里为什么要铺满：篇幅门槛（`Coverage`）要求命中覆盖被度量的篇幅，
    而"4 章挤在开头、后面 100 万字符一条命中都没有"正是它要否决的形态——
    那本书的目录确实只有 4 条，全书兜底读起来更好。这条测试要验的是**采样边界**，
    不是篇幅门槛，所以夹具不能同时踩中后者。
    """
    head = chapters(60, body=12_000)
    assert len(head) < SAMPLE_CHARS
    text = head + '正' * SAMPLE_CHARS + NL + chapters(50)
    pick = pick_rule(text)
    assert (pick.name, pick.n_ok) == ('标准章节', 60)
    # 窗口长度取**最后一行的末尾**，而不是 SAMPLE_CHARS：短书的采样就是全书，
    # 拿 100 万当分母会把平均节点长度算大几十倍。跨越 limit 的那一行整行入样
    # （`iter_lines` 的既有语义），所以这里的窗口比 SAMPLE_CHARS 还长一截。
    window = sample_lines(text)[-1]
    assert pick.scores[0].cover.total == window[0] + len(window[1])


# ---------------------------------------------------------------------------
# 5. 真实书基线（任务 29 的对比起点）
#
# `public/books/` 是 gitignore 的本地产物，干净检出时这组整体跳过。
# 数值是任务 17 实测所得；它会随规则表或评分口径的改动而变，变了就要自觉更新。
# ---------------------------------------------------------------------------

BOOKS_DIR = Path(__file__).resolve().parents[2] / 'public' / 'books'

#: book_id → (规则名, n_ok, n_bad)
BASELINE = {
    '1852铁血中华-绯红之月': ('标准章节', 296, 5),
    '1991从芯开始-三分糊涂': ('标准章节', 395, 2),
    'BUG之神-耳火大帝': ('标准章节', 334, 2),
    'NB-NB': ('标准章节', 275, 0),
    '从零开始-雷云风暴': ('标准章节', 189, 0),
}

real_books = pytest.mark.skipif(
    not BOOKS_DIR.is_dir() or not any(BOOKS_DIR.glob('*.txt.gz')),
    reason='public/books 是 gitignore 的本地产物，缺失时跳过真实书基线',
)


def read_sample(book_id: str) -> str:
    """读出一本书 gz 里的前 SAMPLE_CHARS 字符（`newline=''`：不翻译 CRLF）。"""
    path = BOOKS_DIR / f'{book_id}.txt.gz'
    with gzip.open(path, 'rt', encoding='utf-8', newline='') as f:
        return f.read(SAMPLE_CHARS + 4096)


@real_books
@pytest.mark.parametrize('book_id,expected', sorted(BASELINE.items()))
def test_real_book_baseline(book_id: str, expected: Tuple[str, int, int]):
    path = BOOKS_DIR / f'{book_id}.txt.gz'
    if not path.exists():
        pytest.skip(f'{book_id} 不在本地 public/books 里')
    name, n_ok, n_bad = expected
    text = read_sample(book_id)
    pick = pick_rule(text)
    assert (pick.name, pick.n_ok, pick.n_bad) == (name, n_ok, n_bad)
    # 5 本书都在第一条规则上就越过 EARLY_EXIT，所以只评估了一条
    assert pick.early_exit is True and len(pick.scores) == 1


@real_books
def test_real_book_offsets_land_on_line_starts():
    book_id = 'BUG之神-耳火大帝'
    path = BOOKS_DIR / f'{book_id}.txt.gz'
    if not path.exists():
        pytest.skip(f'{book_id} 不在本地 public/books 里')
    text = read_sample(book_id)
    hits = list(scan_text(text, by_name('标准章节'), limit=SAMPLE_CHARS))
    assert len(hits) > 100
    for offset, title in hits:
        # CRLF 全文里每条命中的行原文都必须在该偏移处对上
        assert text.startswith(title, offset)
        assert offset == 0 or text[offset - 1] in '\r\n'
