# -*- coding: utf-8 -*-
r"""`scripts/lib/toc.py` 的按书自适应正文命中过滤（需求 8.3 的同族问题）。

运行（仓库根目录）：`python -m pytest scripts/tests -q`

`toc_rules.UNIT` 的后缀白名单只看一行，挡不住"带了分隔符的句子"
（`第三场——夜里九点，城南的旧仓库。`、`第一章的结尾是这样收的——`）。这一层按**整本书
自己的排版习惯**判：受害书里真标题一律顶格、正文误报一律缩进。

这里断言五组事实：

1. **判据本身**：`is_indented` / `is_sentence_shaped` / `flush_left_share` 的口径，
   以及"只在非句子形命中上统计顶格比例"这个关键选择。
2. **合取**：缩进 **且** 句子形才否决。任一半单独都会误杀真标题
   （`第九章 收网！收网！` 顶格带感叹号，`第N章 标题` 在 6.5% 的书里本来就缩进）。
3. **自适应**：同一批命中，在"顶格派"的书里被否决，在"缩进派"的书里一条不动。
4. **不会把书清空**：过滤后不足 `MIN_FILTERED_HITS` 就整批退回；输出恒为输入的子序列，
   且幂等。没引 hypothesis——理由同 `test_toc_title.py` / `test_validate.py`：不给
   `scripts/requirements.txt` 加只有测试才用的依赖，改用把行拆片段后穷举组合。
5. **接进 `split_book`**：只删命中，偏移与连续覆盖不动。`卷` 在规则层故意不设防，
   缩进的 `第N卷…。` 叙述句能过「标准章节」，只能在这一层挡下。

输入全是测试里现造的合成文本，标题与句子都是自拟的。
"""

from __future__ import annotations

import itertools
from typing import List, Tuple

import pytest

from scripts.lib.toc import (
    FLUSH_DOMINANT,
    MIN_CLEAN_HITS,
    MIN_FILTERED_HITS,
    Heading,
    count_content_chapters,
    filter_prose_hits,
    flush_left_share,
    is_indented,
    is_sentence_shaped,
    scan_text,
    split_book,
)
from scripts.lib.toc_rules import by_name

STANDARD = by_name('标准章节')

NL = '\r\n'

#: 全角缩进：中文 txt 的主流排版，也是实测里正文误报的统一特征。
IND = '\u3000\u3000'


def heads(*lines: str) -> List[Heading]:
    """把若干行包成 `(偏移, 行原文)`。偏移只要互不相同就行，过滤器不看它。"""
    return [(i * 1000, line) for i, line in enumerate(lines)]


def kept(*lines: str) -> List[str]:
    return [line for _offset, line in filter_prose_hits(heads(*lines))]


# ---------------------------------------------------------------------------
# 1. 判据本身
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('line,expected', [
    ('第一章 甲', False),
    ('\u3000第一章 甲', True),
    ('\u3000\u3000第一章 甲', True),
    (' 第一章 甲', True),
    ('\t第一章 甲', True),
    ('', False),
])
def test_is_indented(line: str, expected: bool):
    # 与 `toc_rules` 第 11 条的 `^\S` 互为反面：喂进来的必须是未 strip 的行原文
    assert is_indented(line) is expected


@pytest.mark.parametrize('line,expected', [
    ('第一章 甲', False),
    ('第933章', False),
    ('第五章 灯下理账（上）', False),
    ('第九章 收网！收网！', True),          # 句末标点 —— 但这行顶格，合取保住它
    ('第二幕散场时已近半夜。', True),
    ('第四节课上到一半，停电了。', True),
    ('第三场，雨下得太大，裁判只好叫停了比赛。', True),
    ('第六章、夜访旧邻', False),            # `、` 是分隔符，不是句读点
    ('第207章—第208章 渡口', False),
    ('第四回……', True),
    ('第一卷完。', True),
])
def test_is_sentence_shaped(line: str, expected: bool):
    assert is_sentence_shaped(line) is expected


def test_flush_left_share_only_looks_at_non_sentence_hits():
    # 关键选择：句子形的命中里混着待判决的误报，拿它们一起算比例等于让嫌疑人自证。
    lines = ['第一章 甲', '第二章 乙'] + [f'{IND}第{i}节打完，比分是1比2。' for i in range(20)]
    share, n_clean = flush_left_share(lines)
    assert (share, n_clean) == (1.0, 2), '20 条句子形的误报不该把比例冲淡'


def test_flush_left_share_without_any_clean_hit():
    share, n_clean = flush_left_share([f'{IND}第一节打完，比分是1比2。'])
    assert (share, n_clean) == (None, 0), '没有可信样本时不给结论'
    assert filter_prose_hits(heads(f'{IND}第一节打完，比分是1比2。')) == heads(
        f'{IND}第一节打完，比分是1比2。'
    )


# ---------------------------------------------------------------------------
# 2. 合取：缩进 且 句子形
# ---------------------------------------------------------------------------

#: 一本"顶格派"的书：足够多的顶格真标题撑起判定前提。
FLUSH_TITLES = [f'第{i}章 标题{i}' for i in range(1, MIN_CLEAN_HITS + 1)]

#: 自拟的正文行（缩进 + 句子形）：`第N` 加单位字开头的叙述句，旧规则把这种形态全当成了章节标题。
PROSE = [
    f'{IND}第二节刚开始，客队就叫了暂停。',
    f'{IND}第三场，雨下得太大，裁判只好叫停了比赛。',
    f'{IND}第四节课上到一半，停电了。',
    f'{IND}第一场秋雨落下来，巷口的槐树叶子掉了一地。',
    f'{IND}第五卷写的是兄弟俩分家以后各自谋生的事。',
    f'{IND}第二幕散场时已近半夜。',
    f'{IND}第三节是自习，教室里只剩翻书的声音。',
    f'{IND}第一部手稿他早就抄完了，第二部还压在箱底。',
    f'{IND}第三场——夜里九点，城南的旧仓库。',
    f'{IND}第一章的结尾收得很急，像是赶着交稿。',
]


@pytest.mark.parametrize('prose', PROSE, ids=[p.strip()[:14] for p in PROSE])
def test_indented_sentence_shaped_hits_are_rejected(prose: str):
    survivors = kept(*FLUSH_TITLES, prose)
    assert survivors == FLUSH_TITLES, f'没挡住：{prose}'


def test_flush_left_sentence_shaped_hits_are_kept():
    # 顶格但带标点的真标题：有书成批的顶格真标题带 `，`/`！`/`？`，合取让它们一条不丢。
    titles = ['第九章 收网！收网！', '第十章 门外站着谁？', '第十一章 雨停，人散']
    assert kept(*FLUSH_TITLES, *titles) == FLUSH_TITLES + titles


def test_indented_non_sentence_hits_are_kept():
    # 缩进但形状是标题的行不动——它反过来正是"这本书缩进标题"的证据
    assert kept(*FLUSH_TITLES, f'{IND}第99章 甲') == FLUSH_TITLES + [f'{IND}第99章 甲']


# ---------------------------------------------------------------------------
# 3. 自适应：同一批命中，两类书两种结果
# ---------------------------------------------------------------------------


def test_a_book_that_indents_its_headings_keeps_everything():
    """真标题全部缩进的书：一条都不许丢。

    全库 7681 本里有 496 本属于这一类（6.5%）。一条 `^\\S` 全局锚会把它们整批毁掉，
    所以判据必须按书自适应。
    """
    indented_titles = [f'{IND}第{i}章 标题{i}' for i in range(1, 31)]
    # 其中若干条标题本身带逗号——单看"句子形"这一半会误杀它们
    indented_titles += [f'{IND}第31章 戊，己', f'{IND}第32章 庚，辛']
    survivors = kept(*indented_titles)
    assert survivors == indented_titles
    share, n_clean = flush_left_share(indented_titles)
    assert share == 0.0
    # 样本是够的：过滤器不启用，是因为这本书缩进标题，不是因为样本太少判不出来
    assert n_clean >= MIN_CLEAN_HITS


def test_the_same_prose_line_survives_in_an_indenting_book():
    # 这一条是自适应的全部意义：同一行，在顶格派的书里被否，在缩进派的书里留下。
    prose = f'{IND}第二幕散场时已近半夜。'
    assert prose not in kept(*FLUSH_TITLES, prose)
    indented_titles = [f'{IND}第{i}章 标题{i}' for i in range(1, 40)]
    assert prose in kept(*indented_titles, prose)


def test_mixed_books_below_the_threshold_are_left_alone():
    # 顶格占比落在门槛以下（这里 8/10 = 0.8 < 0.9）→ 判不出来，就不要替它做决定
    lines = [f'第{i}章 标题{i}' for i in range(1, 9)]
    lines += [f'{IND}第9章 标题9', f'{IND}第10章 标题10']
    prose = f'{IND}第二幕散场时已近半夜。'
    share, n_clean = flush_left_share(lines + [prose])
    assert share == pytest.approx(0.8) and n_clean == 10
    assert share < FLUSH_DOMINANT
    assert kept(*lines, prose) == lines + [prose]


def test_too_few_clean_hits_to_judge():
    # 形状明确是标题的命中不足 MIN_CLEAN_HITS → 不做判断
    few = [f'第{i}章 标题{i}' for i in range(1, MIN_CLEAN_HITS)]
    prose = f'{IND}第二幕散场时已近半夜。'
    assert len(few) == MIN_CLEAN_HITS - 1
    assert kept(*few, prose) == few + [prose]
    # 补够一条就开始生效
    enough = few + [f'第{MIN_CLEAN_HITS}章 标题']
    assert kept(*enough, prose) == enough


# ---------------------------------------------------------------------------
# 4. 不会把书清空；输出是输入的子序列；幂等
# ---------------------------------------------------------------------------


def test_the_filter_can_never_starve_a_book():
    """被否决的命中一定是句子形的，而判定所依据的非句子形命中一条都不会被否。

    所以幸存数恒 >= `MIN_CLEAN_HITS` > `MIN_FILTERED_HITS`——这不是靠兜底分支
    守住的，是结构上成立的。这条断言把那个推理钉住。
    """
    assert MIN_CLEAN_HITS > MIN_FILTERED_HITS
    prose = [f'{IND}第{i}节打完，比分是1比2。' for i in range(500)]
    survivors = kept(*FLUSH_TITLES, *prose)
    assert survivors == FLUSH_TITLES
    assert len(survivors) >= MIN_FILTERED_HITS


def test_a_book_with_no_hits_at_all():
    assert filter_prose_hits([]) == []
    assert filter_prose_hits(heads('第一章 甲')) == heads('第一章 甲')


# 下面三条不变量用**组合枚举**而不是 hypothesis——理由同 `test_toc_title.py` /
# `test_validate.py`：不给 `scripts/requirements.txt` 加一个只有测试才用的依赖。
# 这里要覆盖的输入空间本来就是离散的：缩进 × 行内容 × 收尾标点，三片一组穷举，
# 再按"长度 1..4 的任意组合"拼成命中集合，正好把"顶格/缩进 × 标题形/句子形"
# 四个象限的每种配比都走一遍。

#: 行片段：缩进档 × 主体 × 收尾。4 × 5 × 5 = 100 种行。
_INDENTS = ('', ' ', IND, '\t')
_BODIES = ('第一章 甲', '第二节 乙', '第933章', '第三场 丙丁', '甲乙丙')
_ENDS = ('', '。', '！', '，戊', '…')

#: 100 种行。
ALL_LINES = tuple(
    indent + body + end
    for indent, body, end in itertools.product(_INDENTS, _BODIES, _ENDS)
)

#: 命中集合：从 100 种行里取 3 个的有序组合会爆，所以按"每档缩进各取几种主体"
#: 的方式压到 20 种代表行，再枚举长度 1–3 的全部有序组合（20 + 400 + 8000）。
_REPS = tuple(
    indent + body + end
    for indent in _INDENTS[:2] + _INDENTS[2:3]
    for body in _BODIES[:2]
    for end in _ENDS[:3]
) + (f'{IND}第99章 甲', f'{IND}第二幕散场时已近半夜。')

CASES = tuple(
    combo
    for size in (1, 2, 3)
    for combo in itertools.product(_REPS, repeat=size)
)


def test_the_enumerated_input_space_covers_all_four_quadrants():
    # 枚举本身得有覆盖度，否则下面三条不变量是在空气上成立的
    quadrants = {
        (is_indented(line), is_sentence_shaped(line)) for line in ALL_LINES
    }
    assert quadrants == {(False, False), (False, True), (True, False), (True, True)}
    assert len(CASES) == len(_REPS) + len(_REPS) ** 2 + len(_REPS) ** 3


def test_filter_output_is_always_a_subsequence():
    # 只删不改、不重排、偏移一个字符都不动
    for lines in CASES:
        source = heads(*lines)
        out = filter_prose_hits(source)
        assert out == [h for h in source if h in out], lines
        assert all(h in source for h in out), lines


def test_filter_is_idempotent():
    # 被否决的都是句子形的，而判定所依据的非句子形子集一条不变，
    # 所以第二遍的前提与第一遍完全一样、且已经没有可否决的东西了
    for lines in CASES:
        out = filter_prose_hits(heads(*lines))
        assert filter_prose_hits(out) == out, lines


def test_filter_never_drops_a_flush_or_clean_hit():
    for lines in CASES:
        source = heads(*lines)
        out = set(filter_prose_hits(source))
        for head in source:
            if not is_indented(head[1]) or not is_sentence_shaped(head[1]):
                assert head in out, f'合取之外的命中被否了：{head!r}（{lines}）'


def test_filter_leaves_at_least_two_hits_when_it_got_two():
    for lines in CASES:
        if len(lines) < MIN_FILTERED_HITS:
            continue
        assert len(filter_prose_hits(heads(*lines))) >= MIN_FILTERED_HITS, lines


# ---------------------------------------------------------------------------
# 5. 接进 split_book：只删命中，偏移与连续覆盖不动
# ---------------------------------------------------------------------------


def body(chars: int) -> str:
    return '雨' * (chars - 2) + NL


def synthetic_book() -> Tuple[str, List[str]]:
    """顶格真标题 + 缩进正文误报各若干，返回 `(全文, 真标题列表)`。"""
    parts: List[str] = []
    titles: List[str] = []
    for i in range(1, MIN_CLEAN_HITS + 1):
        title = f'第{i}章 标题{i}'
        titles.append(title)
        parts.append(title + NL)
        parts.append(body(400))
        parts.append(f'{IND}第{i}节打完，比分是1比2。' + NL)   # 旧规则会把它当标题
        parts.append(body(400))
    return ''.join(parts), titles


def test_split_book_drops_the_prose_hits_but_keeps_the_cover():
    text, titles = synthetic_book()
    raw = list(scan_text(text, STANDARD))
    result = split_book(text, STANDARD)
    assert [c['title'] for c in result.chapters] == titles
    assert len(raw) == len(titles), '后缀白名单已经挡掉了这批正文行'
    assert result.fallback is False
    # 需求 8.14：过滤只删命中，连续覆盖照旧
    assert result.chapters[0]['start'] == 0
    assert result.chapters[-1]['end'] == len(text)
    for left, right in zip(result.chapters, result.chapters[1:]):
        assert left['end'] == right['start']
    for chapter in result.chapters:
        assert text.startswith(chapter['title'], chapter['start'])


def test_split_book_still_falls_back_when_the_hits_were_never_there():
    # 过滤器承诺过滤后不少于 2 条，所以"够不够两条标题"这个兜底判断与改动前同义
    prose = (f'{IND}第一节打完，比分是1比2。' + NL) * 3 + body(3000)
    result = split_book(prose, STANDARD)
    assert result.fallback is True


def test_an_indented_volume_sentence_is_dropped_by_the_filter():
    """`卷` 在规则层不设防：缩进的 `第N卷…。` 叙述句能过「标准章节」，只能靠过滤器挡下。

    同一本书里还有句子形、但顶格的真标题。过滤器只否掉那一句，别的命中一条不动；
    进了 `split_book` 也不兜底，章节表正好是全部真标题，那一句留在所在章的正文里。
    """
    volume_prose = f'{IND}第四卷写到一半，他把稿子锁进了抽屉。'
    assert is_indented(volume_prose) and is_sentence_shaped(volume_prose)
    # 对照：换成带后缀白名单的单位字，同一句在规则层就被挡掉了
    assert not STANDARD.match(volume_prose.replace('卷', '节'))

    titles = [f'第{i}章 标题{i}' for i in range(1, MIN_CLEAN_HITS + 1)]
    titles += ['第九章 收网！收网！', '第十章 门外站着谁？', '第十一章 雨停，人散']
    parts: List[str] = []
    for i, title in enumerate(titles):
        parts += [title + NL, body(400)]
        if i == 4:
            parts += [volume_prose + NL, body(400)]   # 夹在第 5 章的正文中间
    text = ''.join(parts)

    raw = list(scan_text(text, STANDARD))
    assert [line for _offset, line in raw] == titles[:5] + [volume_prose] + titles[5:], (
        '规则层放行了这一句'
    )
    assert [line for _offset, line in filter_prose_hits(raw)] == titles, '过滤器只否掉这一句'

    result = split_book(text, STANDARD)
    assert result.fallback is False
    assert [c['title'] for c in result.chapters] == titles
    assert count_content_chapters(result.chapters) == len(titles)
    host = result.chapters[4]
    assert host['start'] < text.index(volume_prose) < host['end']
