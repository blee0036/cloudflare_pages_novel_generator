# -*- coding: utf-8 -*-
r"""`scripts/lib/bundle.py` 合集包的并入顺序与册名。

运行（仓库根目录）：`python -m pytest scripts/tests -q`

断言四件事：

1. **三层判据各管各的形态**：包名用 `+` 列出顺序、同名加序号（容忍前缀）、兜底"最大的是
   正文"，而且单用文件名序或体积序会排错的那几种形态在这里都排对。
2. **没把握时点名**：副文件够得上最大文件的 `UNSURE_SHARE` 才进 `unsure`，小附录不算。
3. **覆盖表的 `order` 说了算**：没列的不并入；名字对不上、对上多个、重复都抛 `BundleError`，
   报错里列出包里实际有哪些文件。
4. **册名**：书名号里的书名、版本注记与作者去掉、书名号后面的别的字保留、净化幂等。

夹具全是合成的文件名（`青石巷` 系列），不点名任何真实藏书。
"""

from __future__ import annotations

import itertools
from typing import List, Sequence, Tuple

import pytest

from scripts.lib import bundle, toc
from scripts.lib.bundle import (
    METHOD_OVERRIDE,
    METHOD_PLUS,
    METHOD_SERIES,
    METHOD_SINGLE,
    METHOD_SIZE,
    UNSURE_SHARE,
    BundleError,
    Member,
    plan,
    volume_title,
)


def members(*pairs: Tuple[str, int]) -> List[Member]:
    return [Member(name, size) for name, size in pairs]


def names(result: bundle.Plan) -> List[str]:
    return [member.name for member in result.order]


# ---------------------------------------------------------------------------
# 1. 三层判据
# ---------------------------------------------------------------------------


def test_plus_in_the_archive_title_wins_even_when_the_sequel_is_bigger():
    # 只按体积排的话，续作比正篇大，书就从续作开始
    files = members(
        ('《青石巷》（校对版全本）作者：夜行.txt', 2_000_000),
        ('《青石巷续》（校对版全本）作者：夜行.txt', 2_400_000),
    )
    result = plan('青石巷+巷续', files)
    assert result.method == METHOD_PLUS
    assert names(result) == [
        '《青石巷》（校对版全本）作者：夜行.txt',
        '《青石巷续》（校对版全本）作者：夜行.txt',
    ]
    assert result.unsure == ()


def test_plus_order_beats_code_point_order():
    # 冬 (U+51AC) 的码位比 雪 (U+96EA) 小：只按文件名排，包名点的顺序就反了
    files = members(('雪山.txt', 900_000), ('冬林.txt', 1_000_000))
    result = plan('雪山+冬林', files)
    assert (result.method, names(result)) == (METHOD_PLUS, ['雪山.txt', '冬林.txt'])


def test_plus_with_unmatched_extras_puts_them_last():
    files = members(('甲篇.txt', 500_000), ('乙篇.txt', 500_000), ('后记.txt', 3_000))
    result = plan('甲篇+乙篇', files)
    assert names(result) == ['甲篇.txt', '乙篇.txt', '后记.txt']


def test_series_with_a_numeric_prefix_is_ordered_by_the_tail_number():
    # 只按文件名排的话，`441青石巷5` 会排到第一
    files = members(
        ('441青石巷5.txt', 357_000),
        ('青石巷1.txt', 445_000),
        ('青石巷2.txt', 332_000),
        ('青石巷3.txt', 336_000),
        ('青石巷4.txt', 368_000),
    )
    result = plan('青石巷1-5合集', files)
    assert result.method == METHOD_SERIES
    assert names(result) == [
        '青石巷1.txt', '青石巷2.txt', '青石巷3.txt', '青石巷4.txt', '441青石巷5.txt',
    ]
    assert result.unsure == ()


@pytest.mark.parametrize(
    'ordered',
    [
        ['青石巷 第一部.txt', '青石巷 第二部.txt', '青石巷 第十一部.txt'],
        ['青石巷（上）.txt', '青石巷（中）.txt', '青石巷（下）.txt'],
        ['青石巷(2).txt', '青石巷(10).txt'],
        ['《青石巷》.txt', '《青石巷2》.txt', '《青石巷3》.txt'],
        ['1.txt', '2.txt', '10.txt'],
        ['卷一.txt', '卷二.txt', '卷二十三.txt'],
    ],
    ids=['cn-parts', 'upper-middle-lower', 'parenthesized', 'bare-base-first', 'pure-numbers',
         'cn-tens'],
)
def test_series_number_forms(ordered: List[str]):
    files = members(*[(name, 100_000) for name in reversed(ordered)])
    result = plan('青石巷合集', files)
    assert (result.method, names(result)) == (METHOD_SERIES, ordered)


def test_duplicate_numbers_are_not_a_series():
    # 两个"第 2"——序号说明不了先后，退到兜底
    files = members(('青石巷2.txt', 100_000), ('青石巷(2).txt', 300_000))
    assert plan('青石巷', files).method == METHOD_SIZE


def test_series_extras_go_last_in_natural_order():
    files = members(
        ('青石巷2.txt', 400_000), ('青石巷1.txt', 400_000),
        ('作品相关10.txt', 2_000), ('作品相关9.txt', 2_000),
    )
    # 作品相关 9/10 自己也是一组序号（主干还更长），但组员一样多时取总体积更大的一组
    result = plan('青石巷', files)
    assert names(result)[:2] == ['青石巷1.txt', '青石巷2.txt']
    assert names(result)[2:] == ['作品相关9.txt', '作品相关10.txt'], '文件名自然序：9 在 10 前'


def test_largest_is_the_main_text_and_small_appendices_follow():
    files = members(
        ('《青石巷》作者：夜行.txt', 6_500_000),
        ('作品相关与外传.txt', 270_000),
        ('资料.txt', 900),
    )
    result = plan('青石巷', files)
    assert result.method == METHOD_SIZE
    assert names(result) == ['《青石巷》作者：夜行.txt', '作品相关与外传.txt', '资料.txt']
    assert result.unsure == ()


def test_a_single_file_is_returned_as_is():
    result = plan('青石巷', members(('book.txt', 10)))
    assert (result.method, names(result), result.excluded) == (METHOD_SINGLE, ['book.txt'], ())


def test_plan_does_not_depend_on_input_order():
    files = members(
        ('441青石巷5.txt', 5), ('青石巷1.txt', 1), ('青石巷2.txt', 2), ('后记.txt', 9),
    )
    results = {tuple(names(plan('青石巷', list(p)))) for p in itertools.permutations(files)}
    assert len(results) == 1


def test_empty_member_list_is_a_caller_bug():
    with pytest.raises(ValueError):
        plan('青石巷', [])


# ---------------------------------------------------------------------------
# 2. 没把握时点名
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ('extra_size', 'unsure'),
    [(int(1_000_000 * UNSURE_SHARE), True), (int(1_000_000 * UNSURE_SHARE) - 1, False)],
    ids=['at-threshold', 'just-below'],
)
def test_a_sizeable_extra_is_flagged(extra_size: int, unsure: bool):
    # 体量够得上一本书的副文件可能是该排在前面的前情提要，只看文件名判断不了
    files = members(('《青石巷》作者：夜行.txt', 1_000_000), ('【外篇】.txt', extra_size))
    result = plan('青石巷', files)
    assert names(result) == ['《青石巷》作者：夜行.txt', '【外篇】.txt'], '照常并入，排在后面'
    assert [m.name for m in result.unsure] == (['【外篇】.txt'] if unsure else [])


def test_extras_left_over_by_a_series_can_be_flagged_too():
    files = members(('青石巷1.txt', 400_000), ('青石巷2.txt', 400_000), ('外传.txt', 200_000))
    result = plan('青石巷', files)
    assert [m.name for m in result.unsure] == ['外传.txt']


# ---------------------------------------------------------------------------
# 3. 覆盖表的 order
# ---------------------------------------------------------------------------

PACK = members(
    ('《青石巷》作者：夜行.txt', 1_000_000),
    ('【外篇】.txt', 300_000),
    ('下载说明.txt', 200),
)


def test_forced_order_is_followed_and_unlisted_files_are_excluded():
    result = plan('青石巷', PACK, forced=['【外篇】.txt', '《青石巷》作者：夜行.txt'])
    assert result.method == METHOD_OVERRIDE
    assert names(result) == ['【外篇】.txt', '《青石巷》作者：夜行.txt']
    assert [m.name for m in result.excluded] == ['下载说明.txt']
    assert result.unsure == (), '人工点过名就不再告警'


def test_forced_order_matches_basenames_under_a_directory():
    files = members(('青石巷合集/甲.txt', 10), ('青石巷合集/乙.txt', 10))
    result = plan('青石巷', files, forced=['乙.txt', '青石巷合集/甲.txt'])
    assert names(result) == ['青石巷合集/乙.txt', '青石巷合集/甲.txt']


@pytest.mark.parametrize(
    ('files', 'forced', 'fragment'),
    [
        (PACK, ['不存在.txt'], '找不到'),
        (members(('a/甲.txt', 1), ('b/甲.txt', 1)), ['甲.txt'], '对上了 2 个文件'),
        (members(('a/甲.txt', 1), ('a/乙.txt', 1)), ['甲.txt', 'a/甲.txt'], '列了两次'),
    ],
    ids=['missing', 'ambiguous', 'same-file-twice'],
)
def test_forced_order_that_does_not_fit_the_pack_raises(
    files: Sequence[Member], forced: List[str], fragment: str
):
    with pytest.raises(BundleError) as excinfo:
        plan('青石巷', files, forced=forced)
    message = str(excinfo.value)
    assert fragment in message
    for member in files:
        assert member.name in message, '报错里列出包里实际有哪些文件，照着改就行'


def test_forced_order_also_applies_to_a_single_file_pack():
    with pytest.raises(BundleError):
        plan('青石巷', members(('book.txt', 10)), forced=['别的.txt'])
    assert names(plan('青石巷', members(('book.txt', 10)), forced=['book.txt'])) == ['book.txt']


# ---------------------------------------------------------------------------
# 4. 册名
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ('name', 'author', 'expected'),
    [
        ('《青石巷》（校对版全本）作者：夜行.txt', None, '青石巷'),
        ('《青石巷》夜行.txt', '夜行', '青石巷'),
        ('《青石巷》番外.txt', '夜行', '《青石巷》番外'),
        ('废稿《残篇》.txt', None, '废稿《残篇》'),
        ('【外篇】.txt', None, '外篇'),
        ('441青石巷5.txt', None, '441青石巷5'),
        ('青石巷  资料.txt', None, '青石巷 资料'),
        ('合集/青石巷(2).TXT', None, '青石巷(2)'),
        ('青石巷（上）（精校版）.txt', None, '青石巷（上）'),
        ('【】.txt', None, '第 3 册'),
    ],
    ids=['quoted-title', 'bare-author', 'quoted-plus-more', 'quote-inside', 'brackets',
         'numeric-prefix', 'whitespace', 'dir-and-ordinal-note', 'ordinal-note-kept',
         'empty-falls-back'],
)
def test_volume_title(name: str, author: str, expected: str):
    title = volume_title(name, 3, author)
    assert title == expected
    # 与章节标题同一约定：净化幂等（前端"跳过与标题相同的首段"靠它）
    assert toc.clean_title(title) == title
