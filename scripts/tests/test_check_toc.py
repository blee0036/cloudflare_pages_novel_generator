# -*- coding: utf-8 -*-
r"""`scripts/check_toc.py` 章节质量度量工具（任务 27，需求 8.11 / 8.12，INV-4，design §4.10）。

运行（仓库根目录）：`python -m pytest scripts/tests -q`

断言七组事实：

1. **七项指标的口径**（需求 8.11）：章数只数非卷、卷数只数 `isVolume`、
   中位/最短/最长**排除卷节点**、疑似误判的两条边界、标题重复率的分母含卷节点、
   兜底与规则名三态（规则名 / `无规则` / `未记录`）。
2. **阈值与 `lib/toc` 同源**：上界就是 `toc.CHAPTER_MAX` 本身（恰好等于不算误判、
   多一个字符才算），下界 50 不含边界。两处常量一漂，这一列报的就不再是
   "逐章兜底没修掉的残留"而是两个常量的差值。
3. **容错**（模块 docstring"不做 schema 校验"）：缺 `tocRule` 的**旧产物**照样能量
   ——度量工具最常见的用法正是量改造前的基线；个别节点读不出长度时排除它并继续。
   只有"不是对象 / 没有 chapters 数组"才抛 `MetricsError`。
4. **表格可 diff**：列按**显示宽度**对齐（中文 id 占 2 格）、行尾无空白、
   行序按 id 排序——这三条是"前后两份输出直接 diff"的前提（需求 8.12）。
5. **退出码只回答"有没有读到东西"**：疑似误判再多也是 0；目录不存在 / 没有产物 /
   `--book` 没命中 / 有产物读不出来才是 1。指标差就红掉的话，改规则表前的那次运行
   会直接失败，前后对比无从开始。
6. **不变量（组合枚举）**：`节点数 == 章数 + 卷数 + 读不出`、
   `最短 <= 中位 <= 最长`、`疑似误判 <= 章数`、重复率落在 `[0, 1)`。
   没引 hypothesis——理由同 `test_pinyin.py` / `test_toc_title.py`：不给
   `scripts/requirements.txt` 加只有测试才用的依赖，改用把章节形态拆片段后穷举组合。
7. **真实产物**：`public/data` 是 gitignore 的本地文件，缺失时按 `test_pinyin.py`
   的约定跳过那一组；其余全部跑在 `tmp_path` 的合成夹具上。
"""

from __future__ import annotations

import io
import itertools
import json
import unicodedata
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import pytest

from scripts import check_toc
from scripts.check_toc import (
    COLUMNS,
    EXIT_NO_DATA,
    EXIT_OK,
    MISJUDGE_MIN,
    Metrics,
    MetricsError,
    RULE_MISSING,
    RULE_NONE,
    TOC_SUFFIX,
    book_ids,
    format_table,
    main,
    measure,
    measure_dir,
    resolve_book,
    run,
)
from scripts.lib.manifest import toc_name
from scripts.lib.toc import CHAPTER_MAX

BOOK_ID = '从零开始-雷云风暴'
OTHER_ID = 'BUG之神-耳火大帝'

DATA_DIR = Path(__file__).resolve().parents[2] / 'public' / 'data'

real_books = pytest.mark.skipif(
    not DATA_DIR.is_dir() or not any(DATA_DIR.glob(f'*{TOC_SUFFIX}')),
    reason='public/data 是 gitignore 的本地产物，缺失时跳过真实产物基线',
)


# ---------------------------------------------------------------------------
# 夹具：合成一份形状合法的 `_toc.json`
# ---------------------------------------------------------------------------

#: 一个节点的规格：`(标题, 长度, 是否卷节点)`。
Spec = Tuple[str, int, bool]


def ch(title: str, length: int, volume: bool = False) -> Spec:
    return (title, length, volume)


def build(
    *specs: Spec,
    book_id: str = BOOK_ID,
    title: str = '从零开始',
    rule: Optional[str] = '标准章节',
    with_rule: bool = True,
    fallback: bool = False,
) -> Dict[str, Any]:
    """按 design §2.1 的形状造一份 `_toc.json`：range 严格连续覆盖，`isVolume` 真时才写。

    `with_rule=False` 造的是**任务 17 之前的旧产物**（压根没有 `tocRule` 字段）
    ——度量工具必须能量它，那是需求 8.12 前后对比里"前"的那一半。
    """
    chapters: List[Dict[str, Any]] = []
    pos = 0
    for index, (node_title, length, volume) in enumerate(specs):
        node: Dict[str, Any] = {
            'id': index,
            'title': node_title,
            'start': pos,
            'end': pos + length,
            'length': length,
        }
        if volume:
            node['isVolume'] = True
        chapters.append(node)
        pos += length

    data: Dict[str, Any] = {
        'id': book_id,
        'title': title,
        'author': '雷云风暴',
        'charCount': pos,
        'totalChapters': sum(1 for spec in specs if not spec[2]),
    }
    if with_rule:
        data['tocRule'] = rule
    if fallback:
        data['fallback'] = True
    data['chapters'] = chapters
    return data


def write(data_dir: Path, data: Dict[str, Any]) -> Path:
    """把一份产物写进目录，文件名由 `id` 派生（与 `manifest.toc_name` 同一规则）。"""
    data_dir.mkdir(parents=True, exist_ok=True)
    path = data_dir / toc_name(str(data['id']))
    path.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
    return path


@pytest.fixture
def data_dir(tmp_path: Path) -> Path:
    directory = tmp_path / 'public' / 'data'
    directory.mkdir(parents=True)
    return directory


def invoke(data_dir: Path, book: Optional[str] = None) -> Tuple[int, str, str]:
    """跑一次 `run()`，两条输出流都收进内存，返回 `(退出码, stdout, stderr)`。

    命令行参数到 `run()` 的接线由 `test_main_wires_the_cli_flags` 单独钉住
    （那条才走真的 argparse），这里不重复一遍参数解析。
    """
    out, err = io.StringIO(), io.StringIO()
    code = run(data_dir=data_dir, book=book, out=out, err=err)
    return code, out.getvalue(), err.getvalue()


# ---------------------------------------------------------------------------
# 1. 七项指标的口径（需求 8.11）
# ---------------------------------------------------------------------------


def test_counts_split_content_and_volume_nodes():
    m = measure(build(
        ch('序章 / 前言', 426),
        ch('第一卷', 6, True),
        ch('第001章 古堡', 3176),
        ch('第002章 夜行', 2400),
        ch('第二卷 大乱斗', 10, True),
        ch('第003章 练级', 5000),
    ))
    assert (m.nodes, m.chapters, m.volumes) == (6, 4, 2)
    # 章数就是 `totalChapters` 的口径（design §2.1 不变量 4）
    assert m.chapters == 4


def test_length_stats_exclude_volume_nodes():
    # 卷节点恒为 6–11 字符：混进统计就会把"最短"一列钉死在 6，
    # 那一列从此再也报不出"有正文章节短得可疑"。
    m = measure(build(
        ch('第一卷', 6, True),
        ch('第一章', 400),
        ch('第二章', 2000),
        ch('第三章', 9000),
    ))
    assert (m.shortest, m.median, m.longest) == (400, 2000, 9000)


def test_median_is_an_actually_existing_chapter_length():
    # 偶数本数时 statistics.median 会给 (2000+3000)/2 = 2500.0：一个这本书里
    # 并不存在的章长，还带 .5 的可能。`median_low` 取真实存在的那个。
    m = measure(build(ch('一', 1000), ch('二', 2000), ch('三', 3000), ch('四', 4000)))
    assert m.median == 2000
    assert isinstance(m.median, int)


def test_no_content_chapters_yields_zero_stats():
    # 整本只有卷节点：不能让 min()/median() 在空序列上炸掉
    m = measure(build(ch('第一卷', 6, True), ch('第二卷', 8, True)))
    assert (m.chapters, m.volumes) == (0, 2)
    assert (m.shortest, m.median, m.longest, m.misjudged) == (0, 0, 0, 0)


@pytest.mark.parametrize('length,short,long_', [
    (1, 1, 0),
    (MISJUDGE_MIN - 1, 1, 0),      # 49：算
    (MISJUDGE_MIN, 0, 0),          # 50：不算（下界不含边界）
    (3000, 0, 0),
    (CHAPTER_MAX, 0, 0),           # 恰好 10 万：不算
    (CHAPTER_MAX + 1, 0, 1),       # 多一个字符：算
])
def test_misjudge_boundaries(length: int, short: int, long_: int):
    m = measure(build(ch('第一章', length)))
    assert (m.too_short, m.too_long) == (short, long_)
    assert m.misjudged == short + long_


def test_volume_nodes_are_never_counted_as_misjudged():
    # 卷节点本来就只覆盖自己的标题行（6–11 字符），按 length < 50 判它是误判
    # 会让每本书的这一列等于卷数，这一列就废了（需求 8.7 / 8.7a）。
    m = measure(build(ch('第一卷', 6, True), ch('第二卷 大乱斗', 10, True), ch('第一章', 3000)))
    assert m.misjudged == 0


def test_duplicate_rate_counts_volume_titles_too():
    # 卷标题同样出现在目录里（需求 12.2 渲染成分组表头），重复的卷标题一样让人分不清
    m = measure(build(
        ch('第一卷', 6, True),
        ch('第一卷', 6, True),
        ch('第一章', 3000),
        ch('第一章', 3000),
        ch('第二章', 3000),
    ))
    assert (m.title_nodes, m.unique_titles) == (5, 3)
    assert m.duplicate_titles == 2
    assert m.duplicate_rate == pytest.approx(0.4)
    assert m.cells()[COLUMNS.index('标题重复')] == '40.0%'


def test_unique_titles_yield_zero_duplicate_rate():
    m = measure(build(ch('第一章', 3000), ch('第二章', 3000), ch('第三章', 3000)))
    assert m.duplicate_titles == 0
    assert m.cells()[COLUMNS.index('标题重复')] == '0.0%'


@pytest.mark.parametrize('kwargs,label', [
    ({'rule': '标准章节'}, '标准章节'),
    ({'rule': None}, RULE_NONE),            # tocRule 是 null：一条规则都没通过门槛
    ({'with_rule': False}, RULE_MISSING),   # 任务 17 之前的旧产物
])
def test_rule_label_has_three_states(kwargs: Dict[str, Any], label: str):
    m = measure(build(ch('第一章', 3000), **kwargs))
    assert m.rule_label == label
    assert m.cells()[COLUMNS.index('规则')] == label


@pytest.mark.parametrize('fallback,cell', [(True, 'yes'), (False, 'no')])
def test_fallback_column(fallback: bool, cell: str):
    m = measure(build(ch('第 1 部分', 5000), rule=None, fallback=fallback))
    assert m.fallback is fallback
    assert m.cells()[COLUMNS.index('兜底')] == cell


def test_cells_match_the_columns():
    m = measure(build(ch('第一章', 3000)))
    assert len(m.cells()) == len(COLUMNS)
    assert m.cells()[0] == BOOK_ID


def test_book_id_falls_back_to_the_filename():
    # 产物里的 id 缺了也得有个能定位的名字——它是表里第一列
    m = measure({'chapters': [{'id': 0, 'title': '一', 'start': 0, 'end': 9, 'length': 9}]},
                book_id=BOOK_ID)
    assert m.book_id == BOOK_ID
    assert m.title == BOOK_ID


# ---------------------------------------------------------------------------
# 2. 阈值与 lib/toc 同源
# ---------------------------------------------------------------------------


def test_upper_bound_is_toc_chapter_max_itself():
    # 不是"抄了个 100000"，而是同一个常量：toc.split_overlong 用它决定"这章要不要
    # 就地再切"，两处一漂，这一列报的就是两个常量的差值而不是残留的超长章。
    assert check_toc.CHAPTER_MAX == CHAPTER_MAX == 100_000


def test_lower_bound_matches_the_design():
    assert MISJUDGE_MIN == 50


# ---------------------------------------------------------------------------
# 3. 容错（不做 schema 校验）
# ---------------------------------------------------------------------------


def test_old_artifacts_without_toc_rule_are_measurable():
    # 度量工具最常见的用法就是量改造前的产物（需求 8.12 的"前"）。
    # 注意 validate.check_toc 对"缺 tocRule"判硬错误——所以这里刻意不调它。
    old = build(ch('第一章', 3000), ch('第二章', 40), with_rule=False)
    m = measure(old)
    assert m.rule_label == RULE_MISSING
    assert (m.chapters, m.misjudged) == (2, 1)


def test_unreadable_node_is_excluded_not_fatal():
    data = build(ch('第一章', 3000), ch('第二章', 2000))
    data['chapters'][1]['length'] = 'oops'
    data['chapters'][1].pop('end')
    m = measure(data)
    assert m.broken == 1
    assert (m.nodes, m.chapters) == (2, 1)
    assert (m.shortest, m.longest) == (3000, 3000)


def test_length_falls_back_to_end_minus_start():
    data = build(ch('第一章', 3000))
    data['chapters'][0].pop('length')
    assert measure(data).shortest == 3000


def test_non_object_node_counts_as_broken():
    data = build(ch('第一章', 3000))
    data['chapters'].append('这不是节点')
    m = measure(data)
    assert (m.nodes, m.chapters, m.broken) == (2, 1, 1)
    # 非对象节点不贡献标题，也不该被算成一次重复
    assert m.duplicate_titles == 0


@pytest.mark.parametrize('data,fragment', [
    ([], '不是 JSON 对象'),
    ('从零开始', '不是 JSON 对象'),
    ({'id': BOOK_ID}, 'chapters 字段不存在'),
    ({'id': BOOK_ID, 'chapters': {}}, 'chapters 不是数组'),
])
def test_only_uncountable_artifacts_raise(data: Any, fragment: str):
    with pytest.raises(MetricsError) as excinfo:
        measure(data)
    assert fragment in str(excinfo.value)


# ---------------------------------------------------------------------------
# 4. 表格可 diff（需求 8.12）
# ---------------------------------------------------------------------------


def _width(text: str) -> int:
    return sum(2 if unicodedata.east_asian_width(c) in 'WF' else 1 for c in text)


def _last_column_at(line: str) -> int:
    """末列（兜底）在这一行里的起始格数。

    末列左对齐且行尾被 rstrip 掉了，所以整行宽度本来就不齐（`no` 比 `yes` 短一格）。
    真正要断言的是**列起始位置对齐**，所以量的是它前面那一截的显示宽度。
    末列的值（`兜底`/`yes`/`no`）里没有空格，行内最后一处两空格必是列分隔符。
    """
    head, _, _last = line.rpartition('  ')
    return _width(head)


def test_table_columns_align_by_display_width():
    rows = [
        measure(build(ch('第一章', 3000), book_id=BOOK_ID)),
        measure(build(ch('第一章', 3000), book_id='NB-NB')),
        measure(build(ch('第一章', 3000), book_id='1852铁血中华-绯红之月')),
    ]
    lines = format_table(rows)
    # 中文 id 占 2 格：按 len() padding 的表在终端里是歪的（design §4.10 那张示意表）
    assert len({_last_column_at(line) for line in lines}) == 1
    assert lines[0].split() == list(COLUMNS)
    assert [line.split()[-1] for line in lines] == ['兜底', 'no', 'no', 'no']


def test_table_has_no_trailing_whitespace():
    # 尾随空格会让前后两份输出的无关行也显示成差异
    lines = format_table([measure(build(ch('第一章', 3000)))])
    assert all(line == line.rstrip() for line in lines)


def test_rows_are_sorted_by_book_id(data_dir: Path):
    for book_id in ('从零开始-雷云风暴', 'BUG之神-耳火大帝', 'NB-NB'):
        write(data_dir, build(ch('第一章', 3000), book_id=book_id))
    rows, failures = measure_dir(data_dir, err=io.StringIO())
    assert failures == []
    assert [row.book_id for row in rows] == sorted(row.book_id for row in rows)


def test_book_ids_ignores_non_book_artifacts(data_dir: Path):
    write(data_dir, build(ch('第一章', 3000), book_id=BOOK_ID))
    (data_dir / 'books.json').write_text('{"count":0,"books":[]}', encoding='utf-8')
    (data_dir / TOC_SUFFIX).write_text('{}', encoding='utf-8')   # 空 id，不是一本书
    assert book_ids(data_dir) == [BOOK_ID]


def test_summary_line_reports_the_totals(data_dir: Path):
    write(data_dir, build(ch('第一章', 3000), ch('第二章', 9), book_id=BOOK_ID))
    write(data_dir, build(
        ch('第 1 部分', 5000), book_id=OTHER_ID, rule=None, fallback=True
    ))
    code, out, _ = invoke(data_dir)
    assert code == EXIT_OK
    assert '[合计] 2 本' in out
    assert '疑似误判 1（过短 1 / 过长 0）' in out
    assert '兜底 1 本' in out
    assert OTHER_ID in out.split('[兜底]')[1]


# ---------------------------------------------------------------------------
# 5. 退出码与 CLI
# ---------------------------------------------------------------------------


def test_bad_metrics_do_not_fail_the_run(data_dir: Path):
    # 27 个疑似误判的书照样是 0 退出：不然改规则表前的那次运行会直接红掉，
    # 需求 8.12 的前后对比无从开始。
    write(data_dir, build(*[ch(f'第{i}章', 9) for i in range(27)]))
    code, out, _ = invoke(data_dir)
    assert code == EXIT_OK
    assert '疑似误判 27' in out


def test_missing_data_dir_is_exit_one(tmp_path: Path):
    code, out, err = invoke(tmp_path / '没有这个目录')
    assert code == EXIT_NO_DATA
    assert out == ''
    assert 'preprocess.py' in err


def test_empty_data_dir_is_exit_one(data_dir: Path):
    code, _, err = invoke(data_dir)
    assert code == EXIT_NO_DATA
    assert TOC_SUFFIX in err


def test_unreadable_artifact_is_exit_one_but_others_still_print(data_dir: Path):
    write(data_dir, build(ch('第一章', 3000), book_id=BOOK_ID))
    (data_dir / toc_name(OTHER_ID)).write_text('{ 半截 JSON', encoding='utf-8')
    code, out, err = invoke(data_dir)
    assert code == EXIT_NO_DATA
    assert '[读不出]' in err and OTHER_ID in err
    assert BOOK_ID in out          # 一本读不出不该让整张表打不出来


def test_book_option_selects_a_single_row(data_dir: Path):
    write(data_dir, build(ch('第一章', 3000), book_id=BOOK_ID))
    write(data_dir, build(ch('第一章', 3000), book_id=OTHER_ID))
    code, out, _ = invoke(data_dir, BOOK_ID)
    assert code == EXIT_OK
    assert BOOK_ID in out and OTHER_ID not in out
    assert '[合计] 1 本' in out


def test_unknown_book_lists_the_available_ids(data_dir: Path):
    write(data_dir, build(ch('第一章', 3000), book_id=BOOK_ID))
    code, out, err = invoke(data_dir, '不存在的书')
    assert code == EXIT_NO_DATA
    assert out == ''
    assert BOOK_ID in err


@pytest.mark.parametrize('wanted', [
    BOOK_ID,                       # 完全相同
    '从零开始',                     # 只记得书名：唯一子串
    f'{BOOK_ID}{TOC_SUFFIX}',      # 从日志里粘贴的文件名
    f'public/data/{BOOK_ID}{TOC_SUFFIX}',
    'nb-nb'.upper(),               # 大小写
])
def test_resolve_book_accepts_the_handy_forms(wanted: str):
    ids = [BOOK_ID, OTHER_ID, 'NB-NB']
    assert resolve_book(wanted, ids) in ids


def test_resolve_book_refuses_an_ambiguous_substring():
    ids = ['从零开始-雷云风暴', '从零开始-佚名']
    with pytest.raises(LookupError) as excinfo:
        resolve_book('从零开始', ids)
    message = str(excinfo.value)
    assert all(book_id in message for book_id in ids)


def test_resolve_book_refuses_an_empty_value():
    with pytest.raises(LookupError):
        resolve_book('  ', [BOOK_ID])


def test_main_wires_the_cli_flags(data_dir: Path, capsys: pytest.CaptureFixture):
    write(data_dir, build(ch('第一章', 3000), book_id=BOOK_ID))
    write(data_dir, build(ch('第一章', 3000), book_id=OTHER_ID))
    assert main(['--data-dir', str(data_dir), '--book', OTHER_ID]) == EXIT_OK
    captured = capsys.readouterr()
    assert OTHER_ID in captured.out and BOOK_ID not in captured.out


# ---------------------------------------------------------------------------
# 6. 不变量（组合枚举，不引 hypothesis）
# ---------------------------------------------------------------------------

#: 把"节点可能的形态"拆成片段：过短、边界、正常、超长、卷、重名。
#: 三片一组穷举，覆盖 343 张章节表。
FRAGMENTS: Tuple[Spec, ...] = (
    ch('甲', 1),
    ch('乙', MISJUDGE_MIN - 1),
    ch('丙', MISJUDGE_MIN),
    ch('丁', 3000),
    ch('戊', CHAPTER_MAX),
    ch('己', CHAPTER_MAX + 1),
    ch('第一卷', 6, True),
)

TABLES: List[Tuple[Spec, ...]] = list(itertools.product(FRAGMENTS, repeat=3))


def test_combo_space_is_big_enough_to_mean_something():
    assert len(TABLES) > 300


@pytest.mark.parametrize('specs', TABLES)
def test_node_counts_always_add_up(specs: Tuple[Spec, ...]):
    m = measure(build(*specs))
    assert m.nodes == m.chapters + m.volumes + m.broken
    assert m.volumes == sum(1 for spec in specs if spec[2])
    assert m.broken == 0


@pytest.mark.parametrize('specs', TABLES)
def test_stats_and_rates_stay_in_range(specs: Tuple[Spec, ...]):
    m = measure(build(*specs))
    assert m.shortest <= m.median <= m.longest
    assert m.misjudged <= m.chapters
    assert 0.0 <= m.duplicate_rate < 1.0
    assert len(m.cells()) == len(COLUMNS)


def test_every_table_formats_to_aligned_lines():
    rows = [measure(build(*specs)) for specs in TABLES[:50]]
    lines = format_table(rows)
    assert len(lines) == len(rows) + 1
    assert len({_last_column_at(line) for line in lines}) == 1


# ---------------------------------------------------------------------------
# 7. 真实产物
# ---------------------------------------------------------------------------


@real_books
def test_real_artifacts_are_measurable():
    rows, failures = measure_dir(DATA_DIR, err=io.StringIO())
    assert failures == [], f'本地产物读不出来：{failures}'
    assert rows, '产物目录里没有 *_toc.json'
    for row in rows:
        assert row.nodes == row.chapters + row.volumes + row.broken
        assert row.broken == 0
        assert row.shortest <= row.median <= row.longest
        assert 0.0 <= row.duplicate_rate < 1.0
        assert row.char_count > 0


@real_books
def test_real_run_prints_every_local_book():
    out, err = io.StringIO(), io.StringIO()
    code = run(data_dir=DATA_DIR, out=out, err=err)
    assert code == EXIT_OK, err.getvalue()
    text = out.getvalue()
    for book_id in book_ids(DATA_DIR):
        assert book_id in text
    assert '[合计]' in text and '[口径]' in text


@real_books
def test_real_single_book_matches_the_full_table():
    book_id = book_ids(DATA_DIR)[0]
    every = {row.book_id: row for row in measure_dir(DATA_DIR, err=io.StringIO())[0]}
    single, failures = measure_dir(DATA_DIR, book_id, err=io.StringIO())
    assert failures == []
    # `--book` 只是少打几行，不改任何一本的口径
    assert single == [every[book_id]]
    assert isinstance(single[0], Metrics)
