# -*- coding: utf-8 -*-
r"""`scripts/lib/toc.py` 的按书自适应正文命中过滤（需求 8.3 的同族问题）。

运行（仓库根目录）：`python -m pytest scripts/tests -q`

`toc_rules.UNIT` 的后缀白名单只看一行，挡不住"带了分隔符的句子"
（`第一场——5月1日17:00盐湖城。`、`第一章的开头是这样写的——`）。这一层按**整本书
自己的排版习惯**判：受害书里真标题一律顶格、正文误报一律缩进。

这里断言五组事实：

1. **判据本身**：`is_indented` / `is_sentence_shaped` / `flush_left_share` 的口径，
   以及"只在非句子形命中上统计顶格比例"这个关键选择。
2. **合取**：缩进 **且** 句子形才否决。任一半单独都会误杀真标题
   （`第六章 练级！练级！` 顶格带感叹号，`第N章 标题` 在 6.5% 的书里本来就缩进）。
3. **自适应**：同一批命中，在"顶格派"的书里被否决，在"缩进派"的书里一条不动。
4. **不会把书清空**：过滤后不足 `MIN_FILTERED_HITS` 就整批退回；输出恒为输入的子序列，
   且幂等。没引 hypothesis——理由同 `test_toc_title.py` / `test_validate.py`：不给
   `scripts/requirements.txt` 加只有测试才用的依赖，改用把行拆片段后穷举组合。
5. **真实书**：审计里受害最重的《球霸的黑科技系统》、`卷` 的唯一误报
   （《法兰西之花》）、以及"真标题全都缩进"的《我是若小安》。
"""

from __future__ import annotations

import gzip
import itertools
from pathlib import Path
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

BOOKS_DIR = Path(__file__).resolve().parents[2] / 'public' / 'books'

real_books = pytest.mark.skipif(
    not BOOKS_DIR.is_dir() or not any(BOOKS_DIR.glob('*.txt.gz')),
    reason='public/books 是 gitignore 的本地产物，缺失时跳过真实书基线',
)


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
    ('第一章 血洗满门（上）', False),
    ('第六章 练级！练级！', True),          # 句末标点 —— 但这行顶格，合取保住它
    ('第一幕很快上演。', True),
    ('第二节比赛开始，跳球。', True),
    ('第三场，面对本赛季ACC弱旅弗吉尼亚，球队更是以82比54狂屠对手。', True),
    ('第一章、拜师峨眉山', False),          # `、` 是分隔符，不是句读点
    ('第133章—第134章 野店', False),
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

#: 实测抄来的正文行（缩进 + 句子形），旧规则把它们全当成了章节标题。
PROSE = [
    f'{IND}第一节打完，23比30，主场作战的雷霆队已经领先了7分。',
    f'{IND}第三场，面对本赛季ACC弱旅弗吉尼亚，球队更是以82比54狂屠对手。',
    f'{IND}第二节比赛开始，跳球。',
    f'{IND}第一场雪下来，寒风也更凛冽，离过年也就不远了。',
    f'{IND}第三卷讲述罗德兹之战的漫画在市政厅出售。',
    f'{IND}第一幕很快上演。',
    f'{IND}第一节是物理课，李达完全没听，自主学习。',
    f'{IND}第一部监控视频程诺已经看过，所以直接打开第二部视频。',
    f'{IND}第一场——5月1日17:00盐湖城。',
    f'{IND}第一章的开头是这样写的，很有意思。',
]


@pytest.mark.parametrize('prose', PROSE, ids=[p.strip()[:14] for p in PROSE])
def test_indented_sentence_shaped_hits_are_rejected(prose: str):
    survivors = kept(*FLUSH_TITLES, prose)
    assert survivors == FLUSH_TITLES, f'没挡住：{prose}'


def test_flush_left_sentence_shaped_hits_are_kept():
    # 顶格但带标点的真标题：《超品巫师》一本就有 96 条带 `，`/`！` 的顶格真标题。
    titles = ['第六章 练级！练级！', '第七章 恶魔是怎么炼成的？', '第八章 甲，乙']
    assert kept(*FLUSH_TITLES, *titles) == FLUSH_TITLES + titles


def test_indented_non_sentence_hits_are_kept():
    # 缩进但形状是标题的行不动——它反过来正是"这本书缩进标题"的证据
    assert kept(*FLUSH_TITLES, f'{IND}第99章 甲') == FLUSH_TITLES + [f'{IND}第99章 甲']


# ---------------------------------------------------------------------------
# 3. 自适应：同一批命中，两类书两种结果
# ---------------------------------------------------------------------------


def test_a_book_that_indents_its_headings_keeps_everything():
    """《我是若小安》形态：真标题全部缩进，一条都不许丢。

    全库 7681 本里有 496 本属于这一类（6.5%）。一条 `^\\S` 全局锚会把它们整批毁掉，
    所以判据必须按书自适应。
    """
    indented_titles = [f'{IND}第{i}章 标题{i}' for i in range(1, 40)]
    # 其中若干条标题本身带逗号——单看"句子形"这一半会误杀它们
    indented_titles += [f'{IND}第40章 甲，乙', f'{IND}第41章 丙，丁']
    survivors = kept(*indented_titles)
    assert survivors == indented_titles
    share, _ = flush_left_share(indented_titles)
    assert share == 0.0


def test_the_same_prose_line_survives_in_an_indenting_book():
    # 这一条是自适应的全部意义：同一行，在顶格派的书里被否，在缩进派的书里留下。
    prose = f'{IND}第一幕很快上演。'
    assert prose not in kept(*FLUSH_TITLES, prose)
    indented_titles = [f'{IND}第{i}章 标题{i}' for i in range(1, 40)]
    assert prose in kept(*indented_titles, prose)


def test_mixed_books_below_the_threshold_are_left_alone():
    # 顶格占比落在门槛以下（这里 8/10 = 0.8 < 0.9）→ 判不出来，就不要替它做决定
    lines = [f'第{i}章 标题{i}' for i in range(1, 9)]
    lines += [f'{IND}第9章 标题9', f'{IND}第10章 标题10']
    prose = f'{IND}第一幕很快上演。'
    share, n_clean = flush_left_share(lines + [prose])
    assert share == pytest.approx(0.8) and n_clean == 10
    assert share < FLUSH_DOMINANT
    assert kept(*lines, prose) == lines + [prose]


def test_too_few_clean_hits_to_judge():
    # 形状明确是标题的命中不足 MIN_CLEAN_HITS → 不做判断
    few = [f'第{i}章 标题{i}' for i in range(1, MIN_CLEAN_HITS)]
    prose = f'{IND}第一幕很快上演。'
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
) + (f'{IND}第99章 甲', f'{IND}第一幕很快上演。')

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


# ---------------------------------------------------------------------------
# 6. 真实书（`public/books` 是 gitignore 的本地产物，缺失时整组跳过）
#
# 数值来自 7681 本全库实测。规则层与过滤层分开记，因为两层各管一半问题。
# ---------------------------------------------------------------------------

#: book_id → (旧规则命中, 新规则命中, 新规则+过滤命中)
REAL_HITS = {
    # 审计里受害最重的一本：1820 个节点里 858 个是正文（47%）。
    # 后缀白名单干掉 855 条，剩下 3 条 `第N场——…` 由过滤器收尾。
    '球霸的黑科技系统-不爱吃草的羊': (1819, 964, 961),
    # `卷` 故意不设防，它全库唯一的那条正文误报就是靠过滤器挡下来的
    '法兰西之花-烽霜': (316, 316, 315),
    # 真标题全部缩进的那一类：过滤器不启用，且白名单还多认出 20 条 `第N部分 …`
    '我是若小安-唯公子': (483, 503, 503),
    # 顶格真标题里带 `，`/`！` 的那一类：两层都不该动它
    '超品巫师-九灯和善': (983, 983, 983),
}


def read_full(book_id: str) -> str:
    """整本读出来。**不用** `gzip.open(..., 'rt')`——它会翻译行终止符，
    偏移会整体平移（`newline=''` 才等价）。这里直接解码字节，最稳。"""
    return gzip.decompress((BOOKS_DIR / f'{book_id}.txt.gz').read_bytes()).decode('utf-8')


@real_books
@pytest.mark.parametrize('book_id,expected', sorted(REAL_HITS.items()))
def test_real_book_hit_counts(book_id: str, expected: Tuple[int, int, int]):
    path = BOOKS_DIR / f'{book_id}.txt.gz'
    if not path.exists():
        pytest.skip(f'{book_id} 不在本地 public/books 里')
    _old, n_rule, n_filtered = expected
    text = read_full(book_id)
    raw = list(scan_text(text, STANDARD))
    assert len(raw) == n_rule
    assert len(filter_prose_hits(raw)) == n_filtered


@real_books
def test_the_worst_audited_book_loses_only_prose():
    """《球霸的黑科技系统》：1820 个节点降到 962，且没有一条顶格真标题受影响。"""
    book_id = '球霸的黑科技系统-不爱吃草的羊'
    path = BOOKS_DIR / f'{book_id}.txt.gz'
    if not path.exists():
        pytest.skip(f'{book_id} 不在本地 public/books 里')
    text = read_full(book_id)
    result = split_book(text, STANDARD)
    assert (len(result.chapters), count_content_chapters(result.chapters)) == (962, 962)
    assert result.fallback is False
    # 被两层挡掉的行，没有一条是"顶格且形状像标题"的
    survivors = {title for _o, title in filter_prose_hits(list(scan_text(text, STANDARD)))}
    for _offset, line in scan_text(text, STANDARD):
        if line in survivors:
            continue
        assert is_indented(line) and is_sentence_shaped(line), f'疑似真标题被否：{line!r}'


@real_books
def test_a_real_indenting_book_keeps_all_of_its_headings():
    """《我是若小安》：243 条缩进真标题，过滤器必须完全不启用。"""
    book_id = '我是若小安-唯公子'
    path = BOOKS_DIR / f'{book_id}.txt.gz'
    if not path.exists():
        pytest.skip(f'{book_id} 不在本地 public/books 里')
    text = read_full(book_id)
    raw = list(scan_text(text, STANDARD))
    share, n_clean = flush_left_share([title for _o, title in raw])
    assert share is not None and share < FLUSH_DOMINANT, '这本书的标题是缩进的'
    assert n_clean >= MIN_CLEAN_HITS
    assert filter_prose_hits(raw) == raw, '一条都不许丢'


@real_books
def test_the_only_volume_false_positive_is_caught_by_the_filter():
    """《法兰西之花》：`卷` 不设防，那条 `第三卷讲述…出售。` 只能靠过滤器。"""
    book_id = '法兰西之花-烽霜'
    path = BOOKS_DIR / f'{book_id}.txt.gz'
    if not path.exists():
        pytest.skip(f'{book_id} 不在本地 public/books 里')
    text = read_full(book_id)
    raw = list(scan_text(text, STANDARD))
    dropped = [t for _o, t in raw if (_o, t) not in set(filter_prose_hits(raw))]
    assert [t.strip() for t in dropped] == ['第三卷讲述罗德兹之战的漫画在市政厅出售。']
