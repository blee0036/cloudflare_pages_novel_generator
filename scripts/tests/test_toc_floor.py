# -*- coding: utf-8 -*-
r"""`scripts/lib/toc.py` 的篇幅门槛与装饰规则取代限制（需求 8.3–8.5 的同族问题）。

运行（仓库根目录）：`python -m pytest scripts/tests -q`

两条改动合在一个文件里，因为它们在真实语料上是**互相依赖**的（见第 4 组）：

- **篇幅门槛**（`Coverage`）：需求 8.3–8.5 的三道门槛只比较命中之间的相对关系，
  从不与"这本书有多长"对照，于是 2 条命中就能选中一条规则，`split_overlong` 再按
  10 万字符凭空编出一张章节表。全库审计里这样的书有 12 本，赢的命中要么是卷标记、
  要么是首尾杂项（`番外` / `后记` / `尾声`）、要么是书末附录里的条目清单。
- **装饰规则的取代限制**（`TocRule.decorative`）：分场分隔线 `※※※` 在结构上必然比
  章节多，而取代门槛只比命中数，于是"多"就赢了"准"——分场符号的命中数可以是
  章标题的数倍。

本文件只用合成书：每本书都由下面的 `place` / `evenly` 按"标题落在哪个偏移"现场铺出来，
覆盖表在内存里构造，不读本机书库，也不读本机覆盖表。各条用例复现的是全库审计归纳出的
形态类别，偏移、条数与标题都是自拟的。

五组断言：

1. **`Coverage` 的算术**：间隔的上下界（`VOLUME_BODY_MAX` / `CHAPTER_MAX`）、
   `sparse` 与 `blind` 的合取/单条语义、三个阈值本身。
2. **合成书形态**：审计里每一类失败（只有卷标记 / 只有首尾杂项 / 附录条目 /
   几条命中挤在一角 / 日常量词当章节单位）都有一个最小复现，每一类**不该被否**的书
   （短书 + 真章节 / 一个巨型盲区 + 几十条真章标题 / 覆盖率紧挨门槛之上 /
   章节本来就短）也都有。
3. **装饰规则**：`※※※` 命中数压倒时精确规则仍然胜出；而原文压根没有标题行时
   它依旧是唯一候选，照旧选中。
4. **两条改动的联动**：装饰限制单独加会让 3 本书掉到"寥寥几条挤在一处的精确命中"上，
   篇幅门槛在择一那一层把那些候选排除掉，装饰规则于是照旧胜出。
5. **全书尺度与人工点名**：采样窗口通过、全书不通过的书由 `split_book` 否掉；
   覆盖表点名的规则不会被篇幅门槛送回兜底。
"""

from __future__ import annotations

import statistics
from pathlib import Path
from typing import List, Sequence, Tuple

import pytest

from scripts.lib.toc import (
    CHAPTER_MAX,
    GAP_CHAPTER,
    MAX_MEAN_NODE,
    MIN_RULE_HITS,
    MIN_USEFUL_SHARE,
    PREFACE_TITLE,
    SAMPLE_CHARS,
    VOLUME_BODY_MAX,
    Coverage,
    coverage,
    pick_rule,
    split_book,
)
from scripts.lib.toc_overrides import Overrides, pick_rule_for
from scripts.lib.toc_rules import RULES, by_name

STANDARD = by_name('标准章节')
MARK = by_name('符号装饰')

NL = '\r\n'


# ---------------------------------------------------------------------------
# 合成夹具：按"标题该落在哪个偏移"铺文本
#
# 与 `test_toc.py::place` 同一套写法。刻意重复而不是互相 import——两个测试模块
# 各自独立可读，与 `test_toc_fallback.py` 里 `assert_covers` 的重复同一个理由。
# ---------------------------------------------------------------------------


def _pad(gap: int) -> str:
    """恰好 `gap` 个字符、且以行终止符收尾的填充块（下一个标题才落在行首）。"""
    if gap == 0:
        return ''
    if gap == 1:
        return '\n'
    if gap == 2:
        return NL
    # 每 400 字符断一行：块切分要能在换行处落刀，否则兜底只切得出一整块
    body = ('雨' * 398 + NL) * (gap // 400) + '雨' * (gap % 400)
    return (body[:gap - 2] if len(body) >= gap - 2 else body.ljust(gap - 2, '雨')) + NL


def place(spec: Sequence[Tuple[int, str]], tail: int = 4_000) -> str:
    """把 `[(目标偏移, 标题行)]` 铺到一张正文底布上，返回全文。"""
    parts: List[str] = []
    pos = 0
    for offset, title in spec:
        gap = offset - pos
        assert gap >= 0, f'偏移 {offset} 落在已写出的内容里'
        block = _pad(gap)
        parts.append(block)
        pos += len(block)
        assert pos == offset, f'填充块对不上：{pos} != {offset}'
        parts.append(title + NL)
        pos += len(title) + 2
    parts.append(_pad(tail))
    return ''.join(parts)


def series(count: int, step: int, *, first: int = 0,
           title: str = '第{i}章 标题{i}') -> List[Tuple[int, str]]:
    """`count` 条标题、每 `step` 字符一条的 `[(偏移, 标题行)]`；`title` 里的 `{i}` 从 1 数起。"""
    return [(first + k * step, title.format(i=k + 1)) for k in range(count)]


def evenly(count: int, step: int, *, first: int = 0, title: str = '第{i}章 标题{i}',
           tail: int = 4_000) -> str:
    """`count` 条标题，每 `step` 字符一条。"""
    return place(series(count, step, first=first, title=title), tail=tail)


def offsets_of(text: str, rule=STANDARD) -> List[int]:
    from scripts.lib.toc import scan_text
    return [offset for offset, _title in scan_text(text, rule)]


# ---------------------------------------------------------------------------
# 1. `Coverage` 的算术
# ---------------------------------------------------------------------------


def test_the_three_thresholds_are_what_the_docstrings_claim():
    assert (MIN_RULE_HITS, MAX_MEAN_NODE, MIN_USEFUL_SHARE) == (6, 30_000, 0.3)
    # 间隔的上下界不是新数，是既有的两个常量：没有正文的存根 / 就地再切线
    assert (VOLUME_BODY_MAX, CHAPTER_MAX) == (100, 100_000)


def test_coverage_counts_the_gaps_a_reader_can_jump_into():
    # 间隔的切法与 `split_book` 造章节表的切法一致：序章段 + 各章 + 末章
    cov = coverage([1_000, 3_000], 10_000)
    assert (cov.hits, cov.total) == (2, 10_000)
    assert cov.useful == 10_000, '1000 + 2000 + 7000，三段都在上下界之间'
    assert cov.useful_share == 1.0
    assert cov.mean_node == pytest.approx(10_000 / 3)
    assert cov.ok is True


@pytest.mark.parametrize('gap,counted', [
    (VOLUME_BODY_MAX, False),          # 恰好等于下界：没有正文的存根，不算覆盖
    (VOLUME_BODY_MAX + 1, True),
    (CHAPTER_MAX, True),               # 恰好等于上限：`split_overlong` 也不切它
    (CHAPTER_MAX + 1, False),          # 越线就是盲区：读者拿到的是凭空编的片段
])
def test_the_gap_bounds_are_closed_on_the_chapter_max_side(gap: int, counted: bool):
    cov = coverage([gap], gap + 200)
    # 两段：[0, gap) 与 [gap, total)。后一段恒为 200，一定计入
    assert cov.useful == (gap + 200 if counted else 200)


def test_an_empty_hit_list_covers_nothing_but_still_measures_the_text():
    cov = coverage([], 20_000)
    assert (cov.hits, cov.useful) == (0, 20_000), '整本就是一段，20000 在上下界之间'
    assert cov.mean_node == 20_000
    assert cov.ok is True, '篇幅门槛不负责"够不够两条标题"，那是 split_book 的事'
    # 同一个"零命中"，书长一点就落进 sparse——命中数与篇幅是合取的
    assert coverage([], 200_000).sparse is True


def test_an_empty_text_never_passes():
    cov = coverage([], 0)
    assert (cov.useful_share, cov.mean_node) == (0.0, 0.0)
    assert cov.ok is False, '没有篇幅可言，也没有目录可言'


def test_sparse_is_a_conjunction_so_short_books_survive():
    # 短篇形态：2.73 万字符、4 条真章标题、平均节点 5460 —— 命中少但节点不大
    short = Coverage(total=27_300, hits=4, useful=27_300)
    assert short.hits < MIN_RULE_HITS and short.mean_node < MAX_MEAN_NODE
    assert (short.sparse, short.blind, short.ok) == (False, False, True)
    # 稀疏形态：14.8 万字符、2 条命中、平均节点 49336 —— 两条都成立才否
    thin = Coverage(total=148_008, hits=2, useful=148_008)
    assert (thin.sparse, thin.blind, thin.ok) == (True, False, False)


def test_many_hits_are_never_sparse_however_long_the_chapters_are():
    # 长章形态：9 条真标题、每章约 7 万字符。命中数够，就不判 sparse
    cov = Coverage(total=702_000, hits=9, useful=int(702_000 * 0.45))
    assert cov.mean_node > MAX_MEAN_NODE
    assert (cov.sparse, cov.blind, cov.ok) == (False, False, True)


def test_blind_alone_is_enough_to_reject():
    # 附录形态：14 条命中（够多、平均节点也不大），但可读覆盖只有 0.07
    cov = Coverage(total=366_000, hits=14, useful=25_620)
    assert cov.hits >= MIN_RULE_HITS and cov.mean_node < MAX_MEAN_NODE
    assert (cov.sparse, cov.blind, cov.ok) == (False, True, False)


def test_the_useful_share_is_measured_against_the_whole_text_not_the_covered_part():
    # 覆盖率的分母是全篇幅。否则"附录里挤了 18 条"会算成 100%
    cov = coverage([100_000 + i * 400 for i in range(18)], 400_000)
    assert cov.useful_share < MIN_USEFUL_SHARE
    assert cov.blind is True


# ---------------------------------------------------------------------------
# 2. 合成书形态：审计里每一类，一个最小复现
# ---------------------------------------------------------------------------


def test_a_few_volume_markers_in_a_long_book_go_to_fallback():
    """卷标记形态：近 50 万字符的长书，全书只有 `上部` / `中部` / `下部` 三条命中。

    真章标题没有任何规则认得，于是规则切出来的节点几乎全是 `split_overlong`
    按 `CHAPTER_MAX` 编出来的片段，读者拿到的没有一个是真章节。
    """
    rule = by_name('卷部册集')
    text = place([(700, '上部 丙'), (150_000, '中部 戊'), (310_000, '下部 丁')], tail=180_000)
    offsets = offsets_of(text, rule)
    assert len(offsets) == 3
    cov = coverage(offsets, len(text))
    assert (cov.sparse, cov.ok) == (True, False)
    result = split_book(text, rule)
    assert result.fallback is True
    assert result.chapters[0]['title'] == '第 1 部分'
    assert max(c['length'] for c in result.chapters) < CHAPTER_MAX // 10


def test_trailing_matter_only_goes_to_fallback():
    """首尾杂项形态：十几万字符，仅有的三条命中全是书末的 `番外`、`尾声` 与 `后记`。

    最不能代表正文的几行赢了整本书：首个命中之前的十几万字符成了一个超长的序章段，
    只能靠超长章兜底编成一串片段。
    """
    text = place([(121_500, '番外 丙'), (133_200, '尾声'), (139_800, '后记')], tail=900)
    result = split_book(text, STANDARD)
    assert result.fallback is True
    cov = coverage(offsets_of(text), len(text))
    assert cov.sparse is True and cov.blind is True


def test_an_appendix_list_in_the_last_third_goes_to_fallback():
    """附录形态：15 条**真**标题，但全部挤在书末附录里。

    `括号装饰` 的裸序号分支认得 `〔N、标题〕` 这种附录条目，它们确实是标题，
    只是全挤在书尾。命中数与平均节点都不难看，只有覆盖率暴露了问题。
    """
    rule = by_name('括号装饰')
    text = place(series(15, 360, first=236_000, title='〔{i}、附注丙{i}〕'), tail=9_500)
    offsets = offsets_of(text, rule)
    assert len(offsets) == 15
    cov = coverage(offsets, len(text))
    assert cov.hits >= MIN_RULE_HITS, '命中数这道门槛拦不住它'
    assert cov.sparse is False and cov.blind is True
    assert split_book(text, rule).fallback is True


def test_a_few_hits_clustered_in_one_corner_go_to_fallback():
    """挤在一角的形态：4 条命中挤在一小段里，前后各是一个巨块。

    4 条里还有一条是叙述句 `…成千上万` 被「书名 序号」读成"书名 + `万`"的误报。
    间隔都没超过 `CHAPTER_MAX`，所以 `blind` 抓不到它——抓到它的是 `sparse`。
    """
    rule = by_name('书名 序号')
    text = place([(58_600, '山前的灯火成千上万'), (62_900, '丙丁的信（一）'),
                  (66_500, '丙丁的信（二）'), (70_800, '丙丁的信（三）')], tail=92_000)
    offsets = offsets_of(text, rule)
    assert len(offsets) == 4
    cov = coverage(offsets, len(text))
    assert cov.blind is False, '每一段都不超过 CHAPTER_MAX'
    assert cov.sparse is True
    assert split_book(text, rule).fallback is True


#: 以日常量词为章节单位的三种标题写法。`日` / `天` / `扇` 刻意不收进单位字，用它们写
#: 标题的书**有意**留在全书兜底（决定与理由见 `toc_rules._UNIT_GUARDED` 上方的注释）。
#: 序数与标题都是自拟的。
DAY_UNIT_HEADINGS = ('第{i}日 标题{i}', '第{i}天 标题{i}', '第{i}扇窗 标题{i}')


@pytest.mark.parametrize('heading', DAY_UNIT_HEADINGS, ids=['ri', 'tian', 'shan'])
def test_day_unit_headings_leave_the_book_on_fallback(heading: str):
    """哪天这条变红，说明有人把这几个量词收进了规则表。

    对照：同一本书把单位字换成 `章`，就能正常选中「标准章节」——兜底只因为单位字。
    """
    text = evenly(6, 3_800, first=600, title=heading)
    pick = pick_rule(text)
    assert all(score.hits == 0 for score in pick.scores), '没有一条启用的规则认得这种标题'
    assert pick.rule is None
    assert split_book(text, pick.rule).fallback is True
    assert pick_rule(evenly(6, 3_800, first=600)).name == '标准章节'


def test_a_short_book_with_few_real_chapters_is_kept():
    """短篇形态：两万多字符、4 条真章标题。命中数不够，但节点一点都不大。

    这条是 `sparse` 必须是**合取**的理由：只看命中数会把这类短篇集整批毁掉。
    """
    chapters = 4
    text = evenly(chapters, 7_200, first=450, tail=2_600)
    cov = coverage(offsets_of(text), len(text))
    assert cov.hits < MIN_RULE_HITS and cov.ok is True
    result = split_book(text, STANDARD)
    assert result.fallback is False
    assert result.chapters[0]['title'] == PREFACE_TITLE
    assert len(result.chapters) == chapters + 1, '序章段 + 各章'


def test_a_book_with_one_giant_blind_region_but_many_real_chapters_is_kept():
    """巨型盲区形态：前十几万字符是 33 条连号真章标题，后面大半本书只有卷标记。

    单看盲区占比这本书很难看（六成以上的篇幅落在无命中的巨块里），但退回兜底等于
    把 33 条确定正确的标题换成一堆 `第 N 部分`。所以门槛卡在 `MIN_USEFUL_SHARE`
    而不是更高：只要还有三成篇幅被切成可读节点，就保留规则。
    """
    spec = series(33, 5_500, first=1_800)
    spec += [(285_000, '第一卷 丙'), (390_000, '第二卷 丁')]
    text = place(spec, tail=101_000)
    cov = coverage(offsets_of(text), len(text))
    assert cov.blind is False and MIN_USEFUL_SHARE < cov.useful_share < 0.5
    result = split_book(text, STANDARD)
    assert result.fallback is False
    assert any(c['title'].endswith('(1)') for c in result.chapters), '巨块照旧就地再切'


def test_coverage_just_above_the_share_threshold_keeps_the_rule():
    """覆盖率紧挨门槛之上的书：前面几十条连号真章标题，后面一个无命中的巨块。

    可读覆盖只比 `MIN_USEFUL_SHARE` 多一点，规则照样保留、巨块照旧就地再切；
    把巨块再拉长一截、覆盖率落到门槛之下，同一条规则就选不中了，整本走全书兜底。
    两边离门槛都不到两个百分点。
    """
    kept = evenly(40, 4_000, first=1_000, tail=350_000)
    cov = coverage(offsets_of(kept), len(kept))
    assert 0 < cov.useful_share - MIN_USEFUL_SHARE < 0.01
    pick = pick_rule(kept)
    assert pick.name == '标准章节'
    result = split_book(kept, pick.rule)
    assert result.fallback is False
    assert any(c['title'].endswith('(1)') for c in result.chapters), '巨块照旧就地再切'

    longer = evenly(40, 4_000, first=1_000, tail=385_000)
    cov = coverage(offsets_of(longer), len(longer))
    assert 0 < MIN_USEFUL_SHARE - cov.useful_share < 0.02
    assert pick_rule(longer).rule is None
    assert split_book(longer, STANDARD).fallback is True


def test_short_chapters_are_not_blind():
    """短章形态：几百条真章标题，每章只有几百字符。

    这条钉住可读节点的**下界**取 `VOLUME_BODY_MAX` 而不是 `GAP_CHAPTER`：取后者的话，
    章节本来就短的书（几千条真章标题、中位长度不到 `GAP_CHAPTER`）算出来的覆盖率会
    跌到门槛以下而被误否。下界只排除"连正文都没有"的存根，不判"短"。
    """
    text = evenly(240, 650, first=350, tail=1_500)
    cov = coverage(offsets_of(text), len(text))
    assert cov.mean_node < GAP_CHAPTER
    assert cov.useful_share > 0.95 and cov.ok is True
    assert split_book(text, STANDARD).fallback is False


def test_a_stub_only_hit_cluster_does_not_count_as_coverage():
    # 下界的另一面：一串彼此只隔几十字符的存根（书前印的目录清单）不算覆盖
    stubs = [(1_000 + i * 20, f'第{i + 1}章 标题{i + 1}') for i in range(12)]
    text = place(stubs, tail=200_000)
    cov = coverage(offsets_of(text), len(text))
    assert cov.hits == 12 >= MIN_RULE_HITS
    assert cov.useful_share < MIN_USEFUL_SHARE and cov.ok is False


def test_the_floor_runs_after_the_prose_filter():
    """门槛必须排在 `filter_prose_hits` 之后：正文误报会让覆盖率虚高。

    这本合成书里，8 条顶格真标题挤在开头 1 万字符内，另有 20 条**缩进且句子形**的
    正文误报均匀铺满全书（`卷` 故意不受后缀白名单约束，所以这一类行确实会命中，
    全库唯一那条以 `第N卷` 开头、讲述那一卷内容的叙述句就是这么来的）。不过滤的话
    覆盖率漂亮得很；过滤掉之后真相是"真标题只覆盖开头那一点"，该走兜底。
    """
    ind = '\u3000\u3000'
    spec = [(200 + i * 1_200, f'第{i + 1}章 标题{i + 1}') for i in range(8)]
    spec += [(20_000 + i * 12_000, f'{ind}第{i + 1}卷压在箱底，一直没人翻开过。')
             for i in range(20)]
    text = place(sorted(spec), tail=10_000)
    raw = offsets_of(text)
    assert len(raw) == 28
    assert coverage(raw, len(text)).ok is True, '不过滤的话覆盖率是漂亮的'
    result = split_book(text, STANDARD)
    assert result.fallback is True, '过滤之后真标题只覆盖开头，门槛正确否决'


# ---------------------------------------------------------------------------
# 3. 装饰规则的取代限制
# ---------------------------------------------------------------------------


def test_only_the_mark_rule_is_marked_decorative():
    decorative = [r.name for r in RULES if r.decorative]
    assert decorative == ['符号装饰']


def test_scene_separators_do_not_displace_a_precise_rule():
    """分场形态：`※※※` 命中数是 `第N章 标题` 的数倍，但它赢不了。

    取代门槛只比命中数，而分场分隔线在结构上必然比章节多——这就是"多"赢了"准"。
    """
    spec = series(15, 30_000, first=1_500) + series(90, 5_000, first=4_200, title='※※※')
    text = place(sorted(spec), tail=8_000)
    pick = pick_rule(text)
    assert pick.name == '标准章节'
    scores = {s.name: s for s in pick.scores}
    assert scores['符号装饰'].n_ok > scores['标准章节'].n_ok, '命中数确实是它多'
    assert scores['符号装饰'].usable and scores['符号装饰'].covers, '否决它的只有装饰限制'


def test_a_book_with_no_title_lines_still_gets_the_mark_rule():
    """无标题行的对照组：原文压根没有标题行，`※※※` 就是它唯一的结构。

    装饰限制只拦"取代"，不拦"当选"——此时它是唯一候选，也就无人可取代。
    一串 `※※※` 节点是对原文的忠实反映，不该被改成一堆 `第 N 部分`。
    """
    text = place(series(17, 9_000, first=3_500, title='※※※'), tail=7_500)
    pick = pick_rule(text)
    assert pick.name == '符号装饰'
    result = split_book(text, MARK)
    assert result.fallback is False
    assert result.chapters[1]['title'] == '※※※'


def test_a_precise_rule_that_already_leads_on_hits_is_unaffected():
    """精确规则领先的对照组：`标准章节` 的命中本来就比 `符号装饰` 多，本来就是它赢，不许变。"""
    spec = series(41, 13_000, first=900) + series(26, 19_000, first=7_300, title='※※※')
    text = place(sorted(spec), tail=11_000)
    assert pick_rule(text).name == '标准章节'


def test_a_mark_rule_hit_with_a_real_title_is_still_a_decoration_hit():
    # 判据在规则上，不在单条命中上：全库 7681 本里没有一本让「符号装饰」靠"带真标题
    # 的命中"赢过精确规则（34 本选中它的书，有效命中里含可读文本的条数是 0 × 33 本、
    # 1 × 1 本），所以按规则标记与按内容逐条判给出逐本相同的结果，取代价更低的那个。
    spec = [(2_000 + i * 24_000, f'第{i + 1}章 标题{i + 1}') for i in range(20)]
    spec += [(3_000 + i * 4_500, f'☆、真标题{i + 1}') for i in range(100)]
    text = place(sorted(spec), tail=10_000)
    assert pick_rule(text).name == '标准章节'


# ---------------------------------------------------------------------------
# 4. 两条改动的联动
# ---------------------------------------------------------------------------


def test_a_weak_precise_rule_does_not_win_the_book_off_the_mark_rule():
    """弱精确规则形态：一长串 `※※※` 铺满全书，而「括号装饰」只有寥寥几条挤在一处。

    装饰限制单独加，这本书会掉到那几条上，再被篇幅门槛送去兜底——节点比原来少一大截，
    是净亏。篇幅门槛在**择一**那一层把这种候选排除掉，于是装饰规则照旧胜出、
    这本书一个字都不变。全库实测这样的书有 3 本。
    """
    spec = series(96, 1_900, first=2_100, title='※※※')
    spec += series(5, 4_300, first=118_650, title='【第{i}幕】')
    text = place(sorted(spec), tail=39_000)
    pick = pick_rule(text)
    scores = {s.name: s for s in pick.scores}
    assert scores['括号装饰'].usable is True, '误报门槛拦不住它'
    assert scores['括号装饰'].covers is False, '拦住它的是篇幅门槛'
    assert pick.name == '符号装饰'
    assert split_book(text, MARK).fallback is False


def test_the_floor_lets_selection_fall_through_to_the_next_rule():
    """篇幅门槛在择一那一层的作用就是"先试次优规则"，不花任何额外扫描。

    靠前的「卷部册集」只有 3 条卷标记（过不了门槛），靠后的「数字 分隔符 标题」
    有 40 条真标题铺满全书。老代码会选中前者（3 > -1 + 2），现在轮到后者。
    """
    spec = [(500 + i * 120_000, f'第{i + 1}卷 甲') for i in range(3)]
    spec += [(2_000 + i * 9_000, f'{i + 1}、标题{i + 1}') for i in range(40)]
    text = place(sorted(spec), tail=6_000)
    pick = pick_rule(text)
    scores = {s.name: s for s in pick.scores}
    assert scores['卷部册集'].usable and not scores['卷部册集'].covers
    assert pick.name == '数字 分隔符 标题'


def test_when_nothing_covers_the_book_the_pick_is_none():
    # 一条候选都过不了门槛 → 没有规则可用，交给全书兜底（需求 8.9）
    text = place([(400, '第一部 甲'), (240_000, '第二部 乙')], tail=220_000)
    pick = pick_rule(text)
    assert pick.rule is None and pick.name is None
    assert split_book(text, pick.rule).fallback is True


# ---------------------------------------------------------------------------
# 5. 全书尺度的最终判决与人工点名
#
# 采样窗口只看前 `SAMPLE_CHARS` 个字符，"覆盖了多少篇幅"却是全书属性，所以最终判决
# 在 `split_book` 里按全书重做一遍。覆盖表点名的规则跳过自动判定，但照样要过
# `split_book` 的篇幅门槛。覆盖表在内存里构造，不读本机覆盖表（需求 3.13）。
# ---------------------------------------------------------------------------


def test_a_rule_that_passes_the_sample_but_not_the_whole_book_goes_to_fallback():
    """采样通过、全书不通过：由 `split_book` 那一道否掉。

    前 `SAMPLE_CHARS` 个字符里 10 条真章标题铺得很匀，采样窗口过得了门槛，`pick_rule`
    照常选中「标准章节」；但全书有两百多万字符，后面一大半是无命中的巨块，按全书重算的
    覆盖率不到门槛。全库实测两个尺度的结论只有 1 本书不一致，方向就是这一种。
    """
    text = evenly(10, 60_000, first=1_200, tail=1_860_000)
    assert len(text) > 2 * SAMPLE_CHARS
    pick = pick_rule(text)
    assert pick.name == '标准章节'
    sample = {s.name: s for s in pick.scores}['标准章节'].cover
    assert sample is not None and sample.ok is True, '采样窗口上它像一张目录'
    whole = coverage(offsets_of(text), len(text))
    assert whole.blind is True, '全书尺度上大半本书落在无命中的巨块里'
    result = split_book(text, pick.rule)
    assert result.fallback is True
    lengths = [c['length'] for c in result.chapters]
    assert len(lengths) > whole.hits + 1, '兜底块比规则切出的节点多'
    assert max(lengths) <= 6_000 and statistics.median(lengths) <= 6_000


#: 自拟的书 id：内存覆盖表的键。
PINNED_BOOK_ID = '门槛点名样书-夹具作者丁'

#: 自动判定选不中、只能由覆盖表点名的三种形态：`规则名 → [(偏移, 标题行)]`。
PINNED_SHAPES = {
    # 书前印了一张密集的目录清单：一串彼此只隔几个字符的存根把误报计数推过门槛，
    # 「标准章节」整条被误报门槛否掉，而它切出来的篇幅分布完全正常
    '标准章节': series(18, 11, first=300) + series(18, 5_200, first=1_800),
    # 标题用的是规则表不认的单位字，只有默认关闭的「顶格短行」认得出
    '顶格短行': series(24, 6_405, first=1_200, title='第{i}枚'),
    # 整行只有一个序号：默认关闭的「纯序号行」（理由见 `toc_rules` 第 13 条）
    '纯序号行': series(20, 4_800, first=900, title='{i}'),
}


@pytest.mark.parametrize('rule_name', tuple(PINNED_SHAPES),
                         ids=['standard', 'top-flush', 'numeral-line'])
def test_a_pinned_rule_is_not_sent_to_fallback_by_the_floor(rule_name: str):
    """覆盖表点名的规则跳过自动判定，但 `split_book` 的篇幅门槛对它照样生效。

    `split_book` 不知道规则是人工点的还是自动选的。点名的书只要命中确实是一张目录，
    门槛就不会把它送回兜底——留着这条断言，是为了让"人工点名不会被自动门槛推翻"
    这件事有人守着。
    """
    spec = PINNED_SHAPES[rule_name]
    text = place(spec)
    rule = by_name(rule_name)
    assert pick_rule(text).name != rule_name, '自动判定选不中它，所以才要点名'
    overrides = Overrides(path=Path('memory-only.json'), table={PINNED_BOOK_ID: rule})
    pick = pick_rule_for(text, PINNED_BOOK_ID, overrides)
    assert (pick.name, pick.overridden, pick.scores) == (rule_name, True, ())
    result = split_book(text, pick.rule)
    assert result.fallback is False, '点名的规则必须能过篇幅门槛'
    assert result.cover is not None and result.cover.ok is True
    starts = {c['start'] for c in result.chapters}
    assert all(offset in starts for offset, _title in spec), '每条标题都切出了自己的节点'
