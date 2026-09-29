# -*- coding: utf-8 -*-
r"""`scripts/lib/toc.py` 的篇幅门槛与装饰规则取代限制（需求 8.3–8.5 的同族问题）。

运行（仓库根目录）：`python -m pytest scripts/tests -q`

两条改动合在一个文件里，因为它们在真实语料上是**互相依赖**的（见第 4 组）：

- **篇幅门槛**（`Coverage`）：需求 8.3–8.5 的三道门槛只比较命中之间的相对关系，
  从不与"这本书有多长"对照，于是 2 条命中就能选中一条规则，`split_overlong` 再按
  10 万字符凭空编出一张章节表。全库审计里这样的书有 12 本，赢的命中要么是卷标记、
  要么是首尾杂项（`番外` / `后记` / `尾声`）、要么是书末附录里的条目清单。
- **装饰规则的取代限制**（`TocRule.decorative`）：分场分隔线 `※※※` 在结构上必然比
  章节多，而取代门槛只比命中数，于是"多"就赢了"准"——《藏地密码》498 条 `※※※`
  压过 92 条 `第N章 标题`。

五组断言：

1. **`Coverage` 的算术**：间隔的上下界（`VOLUME_BODY_MAX` / `CHAPTER_MAX`）、
   `sparse` 与 `blind` 的合取/单条语义、三个阈值本身。
2. **合成书形态**：审计里每一类失败（只有卷标记 / 只有首尾杂项 / 附录条目 /
   三条命中挤在一角）都有一个最小复现，每一类**不该被否**的书（短书 + 真章节 /
   一个巨型盲区 + 几十条真章标题 / 章节本来就短）也都有。
3. **装饰规则**：`※※※` 命中数压倒时精确规则仍然胜出；而原文压根没有标题行时
   它依旧是唯一候选，照旧选中。
4. **两条改动的联动**：装饰限制单独加会让 3 本书掉到"4–10 条挤在一处的精确命中"上，
   篇幅门槛在择一那一层把那些候选排除掉，装饰规则于是照旧胜出。
5. **真实书**：审计里点名的每一本，连同对照组。`public/books` 是 gitignore 的本地
   产物，缺失时整组跳过。
"""

from __future__ import annotations

import gzip
import statistics
from pathlib import Path
from typing import List, Sequence, Tuple

import pytest

from scripts.lib import toc_overrides
from scripts.lib.toc import (
    CHAPTER_MAX,
    MAX_MEAN_NODE,
    MIN_RULE_HITS,
    MIN_USEFUL_SHARE,
    VOLUME_BODY_MAX,
    Coverage,
    count_content_chapters,
    coverage,
    pick_rule,
    split_book,
)
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


def evenly(count: int, step: int, *, first: int = 0, title: str = '第{i}章 标题{i}',
           tail: int = 4_000) -> str:
    """`count` 条标题，每 `step` 字符一条。"""
    return place(
        [(first + i * step, title.format(i=i + 1)) for i in range(count)], tail=tail
    )


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
    # 《月冷金邪》形态：3.5 万字符、5 条真章标题、平均节点 5867 —— 命中少但节点不大
    short = Coverage(total=35_205, hits=5, useful=35_205)
    assert short.hits < MIN_RULE_HITS and short.mean_node < MAX_MEAN_NODE
    assert (short.sparse, short.blind, short.ok) == (False, False, True)
    # 《云中人》形态：17 万字符、3 条命中、平均节点 42500 —— 两条都成立才否
    thin = Coverage(total=170_001, hits=3, useful=170_001)
    assert (thin.sparse, thin.blind, thin.ok) == (True, False, False)


def test_many_hits_are_never_sparse_however_long_the_chapters_are():
    # 《武林三绝》形态：12 条 `第N回` 真标题、每回 8.5 万字符。命中数够，就不判 sparse
    cov = Coverage(total=1_109_313, hits=12, useful=int(1_109_313 * 0.374))
    assert cov.mean_node > MAX_MEAN_NODE
    assert (cov.sparse, cov.blind, cov.ok) == (False, False, True)


def test_blind_alone_is_enough_to_reject():
    # 《听雷》形态：18 条命中（够多、平均节点也不大），但可读覆盖只有 0.047
    cov = Coverage(total=429_290, hits=18, useful=19_749)
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


def test_two_volume_markers_in_a_long_book_go_to_fallback():
    """《一段锦》形态：46 万字符、全书只有 `第一部` / `第二部` 两条命中。

    真章标题（`声声慢 前尘往事（一）`）没有任何规则认得，于是 8 个节点里 6 个是
    `split_overlong` 按 10 万字符编出来的片段，中位 86,135 字符。
    """
    text = place([(400, '第一部 甲'), (240_000, '第二部 乙')], tail=220_000)
    offsets = offsets_of(text, by_name('卷部册集'))
    assert len(offsets) == 2
    cov = coverage(offsets, len(text))
    assert (cov.sparse, cov.ok) == (True, False)
    result = split_book(text, by_name('卷部册集'))
    assert result.fallback is True
    assert result.chapters[0]['title'] == '第 1 部分'
    assert max(c['length'] for c in result.chapters) < CHAPTER_MAX // 10


def test_trailing_matter_only_goes_to_fallback():
    """《猫蛊手记》形态：16 万字符，唯一的两条命中是书末的 `番外` 与 `后记`。

    最不能代表正文的两行赢了整本书：4 个节点、最长 93,575 字符。
    """
    text = place([(137_000, '番外 东南篇'), (164_000, '后记')], tail=600)
    result = split_book(text, STANDARD)
    assert result.fallback is True
    cov = coverage(offsets_of(text), len(text))
    assert cov.sparse is True and cov.blind is True


def test_an_appendix_list_in_the_last_third_goes_to_fallback():
    """《听雷》形态：18 条**真**标题，但全部挤在书末附录里。

    这是波次 B 的唯一一处回退：`括号装饰` 的裸序号分支认出了
    `〔一、关于蜃〕` / `〔2.蓬莱的材料〕`，它们确实是标题，只覆盖全书最后三分之一。
    命中数（18）与平均节点（22,594）都不难看，只有覆盖率暴露了问题（0.047）。
    """
    rule = by_name('括号装饰')
    spec = [(275_000 + i * 400, f'〔{i + 1}、关于甲{i + 1}〕') for i in range(18)]
    text = place(spec, tail=12_000)
    offsets = offsets_of(text, rule)
    assert len(offsets) == 18
    cov = coverage(offsets, len(text))
    assert cov.hits >= MIN_RULE_HITS, '命中数这道门槛拦不住它'
    assert cov.sparse is False and cov.blind is True
    assert split_book(text, rule).fallback is True


def test_three_hits_clustered_in_one_corner_go_to_fallback():
    """《谁的青春不迷茫》形态：3 条命中挤在 41,969–51,177，前后各是一个巨块。

    3 条里还有一条是 `即使不能扬名立万` 被「书名 序号」读成"书名 + `万`"的误报。
    间隔都在 10 万以下，所以 `blind` 抓不到它——抓到它的是 `sparse`。
    """
    text = place([(41_900, '即使不能扬名立万'), (49_500, '关于甲的词（一）'),
                  (51_100, '关于甲的词（二）')], tail=83_000)
    rule = by_name('书名 序号')
    offsets = offsets_of(text, rule)
    assert len(offsets) == 3
    cov = coverage(offsets, len(text))
    assert cov.blind is False, '每一段都不到 10 万字符'
    assert cov.sparse is True
    assert split_book(text, rule).fallback is True


def test_a_short_book_with_five_real_chapters_is_kept():
    """《月冷金邪》形态：3.5 万字符、5 条真章标题。命中数不够，但节点一点都不大。

    这条是 `sparse` 必须是**合取**的理由：只看命中数会把这类短篇集整批毁掉。
    """
    text = evenly(5, 6_500, first=200, tail=3_000)
    cov = coverage(offsets_of(text), len(text))
    assert cov.hits < MIN_RULE_HITS and cov.ok is True
    result = split_book(text, STANDARD)
    assert result.fallback is False
    assert len(result.chapters) == 6, '序章段 + 5 章'


def test_a_book_with_one_giant_blind_region_but_many_real_chapters_is_kept():
    """《三体》形态：前 20 万字符是 37 条连号真章标题，后面 34 万字符只有卷标记。

    单看盲区占比这本书很难看（0.587 落在无命中的巨块里），但退回兜底等于把 37 条
    确定正确的标题换成一堆 `第 N 部分`。所以门槛卡在 0.3 而不是更高：
    只要还有三成篇幅被切成可读节点，就保留规则。
    """
    spec = [(1_000 + i * 5_000, f'第{i + 1}章 标题{i + 1}') for i in range(45)]
    spec += [(360_000, '第一部'), (500_000, '第二部')]
    text = place(spec, tail=140_000)
    cov = coverage(offsets_of(text), len(text))
    assert cov.blind is False and MIN_USEFUL_SHARE < cov.useful_share < 0.6
    result = split_book(text, STANDARD)
    assert result.fallback is False
    assert any(c['title'].endswith('(1)') for c in result.chapters), '巨块照旧就地再切'


def test_short_chapters_are_not_blind():
    """《我的美女总裁》形态：几百条真章标题，每章只有几百字符。

    这条钉住可读节点的**下界**取 `VOLUME_BODY_MAX`（100）而不是 `GAP_CHAPTER`（1000）：
    取 1000 的话，全库实测《我的美女总裁》（6493 条真章标题、中位 793 字符）算出来
    只有 0.287、《说论语》（513 条真条目、中位 422）只有 0.227，两本都会被误否。
    下界只排除"连正文都没有"的存根，不判"短"。
    """
    text = evenly(300, 800, first=100, tail=2_000)
    cov = coverage(offsets_of(text), len(text))
    assert cov.mean_node < 1_000
    assert cov.useful_share > 0.9 and cov.ok is True
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
    全库唯一那条 `第三卷讲述…出售。` 就是这么来的）。不过滤的话覆盖率漂亮得很；
    过滤掉之后真相是"真标题只覆盖开头那一点"，该走兜底。
    """
    ind = '\u3000\u3000'
    spec = [(200 + i * 1_200, f'第{i + 1}章 标题{i + 1}') for i in range(8)]
    spec += [(20_000 + i * 12_000, f'{ind}第{i + 1}卷讲述甲乙的漫画在市政厅出售。')
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
    """《藏地密码》形态：`※※※` 命中数是 `第N章 标题` 的五倍多，但它赢不了。

    取代门槛只比命中数，而分场分隔线在结构上必然比章节多——这就是"多"赢了"准"。
    """
    spec = [(2_000 + i * 24_000, f'第{i + 1}章 标题{i + 1}') for i in range(20)]
    spec += [(3_000 + i * 4_500, '※※※') for i in range(100)]
    text = place(sorted(spec), tail=10_000)
    pick = pick_rule(text)
    assert pick.name == '标准章节'
    scores = {s.name: s for s in pick.scores}
    assert scores['符号装饰'].n_ok > scores['标准章节'].n_ok, '命中数确实是它多'
    assert scores['符号装饰'].usable and scores['符号装饰'].covers, '否决它的只有装饰限制'


def test_a_book_with_no_title_lines_still_gets_the_mark_rule():
    """《三国配角演义》对照组：原文压根没有标题行，`※※※` 就是它唯一的结构。

    装饰限制只拦"取代"，不拦"当选"——此时它是唯一候选，也就无人可取代。
    18 万字符里 22 个 `※※※` 节点是对原文的忠实反映，不该被改成一堆 `第 N 部分`。
    """
    text = place([(4_000 + i * 8_000, '※※※') for i in range(22)], tail=6_000)
    pick = pick_rule(text)
    assert pick.name == '符号装饰'
    result = split_book(text, MARK)
    assert result.fallback is False
    assert result.chapters[1]['title'] == '※※※'


def test_a_precise_rule_that_already_leads_on_hits_is_unaffected():
    """《剑海情涛》对照组：`标准章节` 48 > `符号装饰` 35，本来就是它赢，不许变。"""
    spec = [(600 + i * 15_000, f'第{i + 1}章 标题{i + 1}') for i in range(48)]
    spec += [(8_000 + i * 20_000, '※※※') for i in range(35)]
    text = place(sorted(spec), tail=14_000)
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
    """《忘川堂夜话》形态：113 条 `※※※` 铺满全书，而「括号装饰」只有 4 条挤在一处。

    装饰限制单独加，这本书会掉到那 4 条上（平均节点 39,384），再被篇幅门槛送去兜底
    ——114 个节点变 40 个，是净亏。篇幅门槛在**择一**那一层把这种候选排除掉，
    于是装饰规则照旧胜出、这本书一个字都不变。全库实测这样的书 3 本
    （另两本是《流浪玛厄斯》与《我们从此是路人》）。
    """
    spec = [(2_400 + i * 1_700, '※※※') for i in range(113)]
    spec += [(133_000 + i * 5_000, f'【第{i + 1}夜】') for i in range(4)]
    text = place(sorted(spec), tail=47_000)
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
# 5. 真实书
#
# `public/books/` 是 gitignore 的本地产物，干净检出时这组整体跳过。
# 数值是 7681 本全库实测所得（本次改动前 → 改动后），改了规则表或阈值就要自觉更新。
# ---------------------------------------------------------------------------

BOOKS_DIR = Path(__file__).resolve().parents[2] / 'public' / 'books'

real_books = pytest.mark.skipif(
    not BOOKS_DIR.is_dir() or not any(BOOKS_DIR.glob('*.txt.gz')),
    reason='public/books 是 gitignore 的本地产物，缺失时跳过真实书基线',
)


def read_full(book_id: str) -> str:
    """整本读出来。**不用** `gzip.open(..., 'rt')`——它会翻译行终止符，偏移会整体平移。"""
    path = BOOKS_DIR / f'{book_id}.txt.gz'
    if not path.exists():
        pytest.skip(f'{book_id} 不在本地 public/books 里')
    return gzip.decompress(path.read_bytes()).decode('utf-8')


def shipped(book_id: str) -> Tuple[str, bool, int, int, int]:
    """按 `preprocess.build_toc` 的口径跑一遍，返回 `(规则名, 是否兜底, 节点数, 中位, 最长)`。"""
    text = read_full(book_id)
    pick = toc_overrides.pick_rule_for(text, book_id, toc_overrides.load())
    result = split_book(text, pick.rule)
    lengths = [c['length'] for c in result.chapters]
    return (
        pick.name,
        result.fallback,
        len(result.chapters),
        int(statistics.median(lengths)),
        max(lengths),
    )


#: 篇幅门槛送去全书兜底的书：`book_id → (原规则, 原节点数, 原中位, 原最长, 新节点数)`。
#: 12 本在择一那一层就选不出规则（`rule=None`），《我的女儿之我的天使》是唯一一本
#: 采样通过、全书不通过的（0.352 → 0.222），由 `split_book` 那一道否掉。
TO_FALLBACK = {
    '一段锦-伏弓': ('标准章节', 8, 86_135, 99_751, 122),
    '云中人-路内': ('书名 序号', 4, 44_547, 77_759, 40),
    '你是那人间的四月天-林徽因': ('标准章节', 5, 12_484, 91_251, 31),
    '听雷-庞晓峰': ('括号装饰', 23, 427, 100_054, 86),
    '天意-钱莉芳': ('标准章节', 7, 1_196, 78_816, 30),
    '我的女儿之我的天使-盘古混沌': ('符号装饰', 45, 12_442, 99_923, 462),
    '猫蛊手记_考古手记_-微笑的猫': ('标准章节', 4, 35_775, 93_575, 34),
    '荒村公寓-蔡骏': ('标准章节', 8, 10_721, 98_518, 43),
    '荒村归来-蔡骏': ('标准章节', 8, 16_519, 99_042, 46),
    '谁的青春不迷茫-刘同': ('书名 序号', 4, 24_773, 83_111, 31),
    '魅生-楚惜刀': ('标准章节', 26, 34_735, 96_955, 230),
}


@real_books
@pytest.mark.parametrize('book_id,expected', sorted(TO_FALLBACK.items()))
def test_books_whose_hits_are_not_a_toc_go_to_fallback(book_id: str, expected):
    _old_rule, old_nodes, _old_median, old_max, new_nodes = expected
    name, fallback, nodes, median, longest = shipped(book_id)
    assert fallback is True, f'{book_id} 应当走全书兜底'
    assert nodes == new_nodes
    assert nodes > old_nodes, '兜底块比原来的巨型节点多'
    assert longest <= 6_000 < old_max, '再没有 10 万字符级的节点'
    assert median <= 6_000


#: 以 `第N日` / `第N天` / `第N扇门` 为真标题的 4 本书：**有意**留在全书兜底。
#: `日`/`天`/`扇` 是日常量词，收进单位字的误报面是整个书库（决定与数字见
#: `toc_rules._UNIT_GUARDED` 上方的注释）。哪天这条变红，说明有人把它们收进了规则表。
DAY_UNIT_BOOKS = ('荒村公寓-蔡骏', '荒村归来-蔡骏', '第七天-余华', '旋转门-蔡骏')


@real_books
@pytest.mark.parametrize('book_id', DAY_UNIT_BOOKS)
def test_day_unit_books_stay_on_fallback(book_id: str):
    _name, fallback, _nodes, _median, _longest = shipped(book_id)
    assert fallback is True, f'{book_id} 应当留在全书兜底'


#: 盲区不小、但命中确实是一张目录的书：一个字都不许变。
#: `book_id → (规则名, 节点数, 中位, 最长)`。四本的可读覆盖率分别是
#: 0.341 / 0.374 / 0.379 / 0.412，紧挨着 0.3 这条线之上；后五本是"章节本来就短"
#: 或"条目本来就多"的那一类，钉住可读节点的下界取 VOLUME_BODY_MAX 而不是 GAP_CHAPTER。
KEEP = {
    '唐朝的黑夜-魏风华': ('标准章节', 15, 22_625, 99_135),
    '武林三绝-梁羽生': ('标准章节', 23, 49_196, 99_672),
    '厚黑学-李宗吾': ('大写数字 分隔符 标题', 19, 4_792, 90_958),
    '三体-刘慈欣': ('标准章节', 54, 4_584, 100_317),
    '德云日记-赵峰': ('标准章节', 67, 1_493, 97_899),
    '幻之盛唐-猫疲': ('标准章节', 461, 4_966, 99_693),
    '民国就是这么生猛-雾满拦江': ('数字 分隔符 标题', 395, 766, 98_095),
    '说论语-贾志刚': ('数字 分隔符 标题', 514, 422, 2_690),
    '我的美女总裁-番茄': ('标准章节', 6_494, 793, 17_093),
}


@real_books
@pytest.mark.parametrize('book_id,expected', sorted(KEEP.items()))
def test_books_with_a_real_toc_are_untouched(book_id: str, expected):
    assert shipped(book_id) == (expected[0], False, expected[1], expected[2], expected[3])


#: 装饰限制改好的书：`book_id → (新规则, 原节点数, 原中位, 新节点数, 新中位)`。
#: 全库 34 本选中「符号装饰」的书里 29 本换成精确规则，这里取审计点名的四本。
DEMOTED = {
    '藏地密码-何马': ('标准章节', 499, 1_749, 93, 26_999),
    '逝鸿传说-碎石': ('标准章节', 95, 4_215, 39, 13_503),
    '云中歌-桐华': ('拉丁章节', 145, 2_459, 60, 11_079),
    '暗蚀-白开水': ('书名 序号', 125, 4_451, 189, 3_344),
}


@real_books
@pytest.mark.parametrize('book_id,expected', sorted(DEMOTED.items()))
def test_decorative_rule_no_longer_wins_on_hit_count(book_id: str, expected):
    new_rule, _old_nodes, _old_median, new_nodes, new_median = expected
    name, fallback, nodes, median, _longest = shipped(book_id)
    assert (name, fallback) == (new_rule, False)
    assert (nodes, median) == (new_nodes, new_median)


#: 对照组：改动前后逐字节相同。前五本是审计点名的"已经正确、不许动"，
#: 后三本是"装饰限制单独加会弄坏、靠篇幅门槛在择一那层救回来"的那三本。
CONTROLS = {
    '三国配角演义-马伯庸': ('符号装饰', 23, 3_344, 38_241),
    '剑海情涛-云中岳': ('标准章节', 49, 15_603, 17_532),
    '逆天网游行-雨天不打伞': ('标准章节', 848, 3_832, 100_045),
    '尘缘-烟雨江南': ('单位 序号', 88, 12_533, 37_362),
    '我的老婆是妖精-浪漫烟灰': ('括号装饰', 340, 3_485, 5_884),
    '忘川堂夜话-七日鸣': ('符号装饰', 114, 1_460, 6_338),
    '流浪玛厄斯-郝景芳': ('符号装饰', 86, 2_670, 22_732),
    '我们从此是路人-维和粽子': ('符号装饰', 49, 2_547, 25_500),
}


@real_books
@pytest.mark.parametrize('book_id,expected', sorted(CONTROLS.items()))
def test_control_books_do_not_change(book_id: str, expected):
    assert shipped(book_id) == (expected[0], False, expected[1], expected[2], expected[3])


#: 覆盖表这次新增的三本：`book_id → (点名的规则, 节点数, 正文章节数, 中位, 最长)`。
#: 三本都是"篇幅门槛救不了、只能逐本点名"的形态，每一本的实测口径写在
#: `scripts/toc-overrides.json` 自己的注释键上。
PINNED = {
    '人脉心理学-夏浩': ('标准章节', 36, 36, 3_646, 5_247),
    '带灯-贾平凹': ('顶格短行', 288, 278, 862, 7_440),
    '纵使相逢若别离_完整版-叶萱': ('标准章节', 25, 14, 1_245, 27_238),
}


@real_books
@pytest.mark.parametrize('book_id,expected', sorted(PINNED.items()))
def test_the_new_override_entries(book_id: str, expected):
    rule_name, nodes, content, median, longest = expected
    overrides = toc_overrides.load()
    assert book_id in overrides, f'{book_id} 不在 toc-overrides.json 里'
    text = read_full(book_id)
    pick = toc_overrides.pick_rule_for(text, book_id, overrides)
    assert (pick.name, pick.overridden) == (rule_name, True)
    result = split_book(text, pick.rule)
    lengths = [c['length'] for c in result.chapters]
    assert result.fallback is False, '点名的规则必须能过篇幅门槛'
    assert (len(result.chapters), count_content_chapters(result.chapters)) == (nodes, content)
    assert (int(statistics.median(lengths)), max(lengths)) == (median, longest)


@real_books
def test_the_override_table_is_never_blocked_by_the_floor():
    """21 本点名的书，没有一本被篇幅门槛送回兜底。

    `split_book` 不知道规则是人工点的还是自动选的，所以门槛对它们同样生效。
    实测这不是问题：21 本的可读覆盖率最低 0.999、命中数最少 8 条
    （《长安乱》8 条 `壹`…`捌`），离两条门槛都有大余量。留着这条断言是为了让
    "人工点名不会被自动门槛推翻"这件事有人守着。
    """
    overrides = toc_overrides.load()
    for book_id, rule in sorted(overrides.table.items()):
        path = BOOKS_DIR / f'{book_id}.txt.gz'
        if not path.exists():
            continue
        text = gzip.decompress(path.read_bytes()).decode('utf-8')
        assert split_book(text, rule).fallback is False, book_id
