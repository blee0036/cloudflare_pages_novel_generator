# -*- coding: utf-8 -*-
r"""`scripts/lib/validate.py` 产物 schema 自校验（任务 24，需求 7.10 / 8.14）。

运行（仓库根目录）：`python -m pytest scripts/tests -q`

断言五组事实：

1. **真产物必须通过**：夹具不是手写的 JSON，而是 `toc.split_book` 的真实输出
   （含卷节点、含序章、含全书兜底）按 `preprocess.process_book` 的写法组装。
   校验器与写入侧对不上时，这一组先炸——这比任何手写夹具都贴近回归的形态。
2. **不变量逐条可捕获**（design §2.1 的 1–4，需求 8.14）：`id` 连续、
   `chapters[0].start == 0`、相邻衔接、末章 `end == charCount`、
   `length == end - start > 0`、`totalChapters` 等于非卷节点数。
3. **单字段扰动全被捕获**（穷举，非 hypothesis）：对每种合法产物，把每个章节的
   `id`/`start`/`end`/`length` 各 ±1，逐个都必须抛异常。这是"连续覆盖"这组不变量
   真正要的性质——不是"某个手写反例能被发现"，而是**任何一处偏移错位都无处可藏**。
   没引 hypothesis，理由同 `test_toc_title.py`：不给 `scripts/requirements.txt`
   加只有测试用的依赖。
4. **告警不是失败**（不变量 6）：`isVolume` 为真却越过 100 字符时告警、校验仍然通过；
   `books.json` 里残留 `txtPath`/`tocPath` 同理。产物能读，只是可疑。
5. **`books.json`**（design §2.2）：必需字段与类型、`count` 与实际条数一致、
   `id` 不重复（需求 7.9 的验收端）、两份产物对同一事实的记载必须一致。

夹具一律用 CRLF——真实产物就是 CRLF（任务 15）。
"""

from __future__ import annotations

import copy
import json
from typing import Any, Dict, List, Sequence

import pytest

from scripts.lib import validate
from scripts.lib.toc import (
    VOLUME_BODY_MAX,
    count_content_chapters,
    pick_rule,
    split_book,
)
from scripts.lib.toc_rules import by_name
from scripts.lib.validate import (
    BOOK_FIELDS,
    TOC_FIELDS,
    ValidationError,
    check,
    check_book,
    check_books,
    check_toc,
)

STANDARD = by_name('标准章节')

#: 夹具一律用 CRLF，理由见模块 docstring。
NL = '\r\n'

#: 样例书：`scripts/fixtures/standard-cn.txt` 那本原创样本。`GZ_SIZE` 是自拟的数。
BOOK_ID = '青石巷-夜行'
BOOK_TITLE = '青石巷'
BOOK_AUTHOR = '夜行'
GZ_SIZE = 13579246
GENERATED_AT = '2026-09-24T09:08:23Z'


# ---------------------------------------------------------------------------
# 夹具：用真实切分结果组装产物
# ---------------------------------------------------------------------------


def body(chars: int) -> str:
    """一段 `chars` 个字符（含收尾 CRLF）的正文。"""
    return '雨' * (chars - 2) + NL


def make_text(*, preface: int = 0, bodies: Sequence[int] = (1200,) * 3) -> str:
    """造一本书的全文。某段 `bodies` 很短时，那一章会被 `mark_volumes` 标成卷。

    正文默认 1200 字符：夹具走的是 `pick_rule` 的真实评分器，相邻标题间隔必须
    > `GAP_CHAPTER`（1000）才算有效章节，否则整条规则被否决、这本书变成全书兜底
    （那样就测不到卷节点与序章了）。
    """
    parts: List[str] = []
    if preface:
        parts.append(body(preface))
    for index, size in enumerate(bodies, 1):
        parts.append(f'第{index}章 标题{index}' + NL)
        parts.append(body(size))
    return ''.join(parts)


#: 一本没有任何章节标记的书：所有规则都不可用，走全书兜底（需求 8.9）。
NO_HEADINGS = (body(600) + NL) * 20


def make_toc(text: str) -> Dict[str, Any]:
    """按 `preprocess.process_book` 的写法组装 `_toc.json`（design §2.1 的字段顺序）。"""
    rule = pick_rule(text).rule
    result = split_book(text, rule)
    data: Dict[str, Any] = {
        'id': BOOK_ID,
        'title': BOOK_TITLE,
        'author': BOOK_AUTHOR,
        'charCount': len(text),
        'totalChapters': count_content_chapters(result.chapters),
        'tocRule': rule.name if rule is not None else None,
    }
    if result.fallback:
        data['fallback'] = True
    data['chapters'] = result.chapters
    return data


def make_meta(toc: Dict[str, Any], **extra: Any) -> Dict[str, Any]:
    """按 design §2.2 组装 `books.json` 的条目，数字与 `_toc.json` 一致。"""
    return {
        'id': toc['id'],
        'title': toc['title'],
        'author': toc['author'],
        'titleAbbr': 'qsx',
        'authorAbbr': 'yx',
        'charCount': toc['charCount'],
        'totalChapters': toc['totalChapters'],
        'gzSize': GZ_SIZE,
        **extra,
    }


def make_books(*metas: Dict[str, Any]) -> Dict[str, Any]:
    return {'count': len(metas), 'generatedAt': GENERATED_AT, 'books': list(metas)}


#: 主夹具：序章 + 5 章，其中第 4 章正文只有 20 字符 → 被 `mark_volumes` 标成卷节点。
#: 卷节点前后各留足够多的正常章节，否则"疑似误报 1 个"会把整条规则拖到误报门槛以下
#: （需求 8.3 的 `n_ok >= n_bad * 3`），这本书就变成全书兜底了。
MAIN_TEXT = make_text(preface=600, bodies=(1200, 1200, 1200, 20, 1200))


@pytest.fixture
def toc() -> Dict[str, Any]:
    return make_toc(MAIN_TEXT)


@pytest.fixture
def meta(toc: Dict[str, Any]) -> Dict[str, Any]:
    return make_meta(toc)


def volumes(data: Dict[str, Any]) -> List[Dict[str, Any]]:
    return [c for c in data['chapters'] if c.get('isVolume')]


# ---------------------------------------------------------------------------
# 1. 真产物必须通过
# ---------------------------------------------------------------------------


def test_fixture_really_contains_a_volume_node(toc: Dict[str, Any]):
    """夹具自检：没有卷节点的话，不变量 6 与"卷参与连续覆盖"就都没被测到。"""
    assert toc['tocRule'] == STANDARD.name and 'fallback' not in toc
    assert len(toc['chapters']) == 6, '序章 + 5 章'
    assert len(volumes(toc)) == 1
    assert toc['chapters'][0]['title'] == '序章 / 前言'
    assert toc['totalChapters'] == len(toc['chapters']) - 1


def test_real_split_result_passes_without_warnings(toc: Dict[str, Any]):
    assert check_toc(toc).warnings == ()


def test_fallback_book_passes():
    """全书兜底的产物：`tocRule` 是 null、`fallback` 为真，同样必须通过。"""
    data = make_toc(NO_HEADINGS)
    assert data['tocRule'] is None and data['fallback'] is True
    assert len(data['chapters']) > 1
    assert check_toc(data).warnings == ()


def test_matching_pair_passes(toc: Dict[str, Any], meta: Dict[str, Any]):
    assert check(meta, toc).warnings == ()
    assert check_book(meta).warnings == ()
    assert check_books(make_books(meta)).warnings == ()


def test_json_round_trip_passes(toc: Dict[str, Any], meta: Dict[str, Any]):
    """产物落盘再读回来仍须通过——校验的是同一份数据，不该依赖 dict 的身份。"""
    reloaded_toc = json.loads(json.dumps(toc, ensure_ascii=False))
    reloaded_books = json.loads(json.dumps(make_books(meta), ensure_ascii=False))
    assert check_toc(reloaded_toc).warnings == ()
    assert check_books(reloaded_books).warnings == ()


# ---------------------------------------------------------------------------
# 2. 不变量逐条（design §2.1 的 1–4，需求 8.14）
# ---------------------------------------------------------------------------


def broke(toc: Dict[str, Any], fragment: str) -> str:
    """校验必须失败，且消息里提到 `fragment`；返回完整消息供进一步断言。"""
    with pytest.raises(ValidationError) as excinfo:
        check_toc(toc)
    message = str(excinfo.value)
    assert fragment in message, message
    return message


def test_chapter_id_must_equal_index(toc: Dict[str, Any]):
    toc['chapters'][1]['id'] = 7
    broke(toc, '不变量 1')


def test_first_chapter_must_start_at_zero(toc: Dict[str, Any]):
    first = toc['chapters'][0]
    first['start'] = 1
    first['length'] = first['end'] - first['start']
    broke(toc, 'start 必须是 0')


def test_adjacent_chapters_must_meet(toc: Dict[str, Any]):
    second = toc['chapters'][1]
    second['start'] -= 1
    second['length'] = second['end'] - second['start']
    broke(toc, '应等于上一章的 end')


def test_last_chapter_must_reach_char_count(toc: Dict[str, Any]):
    last = toc['chapters'][-1]
    last['end'] -= 1
    last['length'] = last['end'] - last['start']
    broke(toc, '应等于 charCount')


def test_length_must_equal_end_minus_start(toc: Dict[str, Any]):
    toc['chapters'][0]['length'] += 1
    broke(toc, 'length 应等于 end - start')


def test_zero_length_node_is_rejected(toc: Dict[str, Any]):
    """卷节点也不许零长度：标题行的字符会无归属（design §0 修订一）。"""
    volume = volumes(toc)[0]
    volume['end'] = volume['start']
    volume['length'] = 0
    broke(toc, 'length 必须 >= 1')


def test_total_chapters_must_count_non_volume_nodes(toc: Dict[str, Any]):
    toc['totalChapters'] += 1
    broke(toc, '不变量 4')


def test_marking_a_content_chapter_as_volume_breaks_total_chapters(toc: Dict[str, Any]):
    """卷标记与 `totalChapters` 是同一个口径，改一边就得改另一边。"""
    toc['chapters'][-1]['isVolume'] = True
    broke(toc, '应等于非卷节点数')


def test_is_volume_false_is_rejected(toc: Dict[str, Any]):
    """"真时才出现"：写 `false` 是 7000 本 × 冗余字段的体积浪费（design §2.1）。"""
    toc['chapters'][0]['isVolume'] = False
    broke(toc, 'isVolume 只在为真时写入')


def test_fallback_false_is_rejected(toc: Dict[str, Any]):
    toc['fallback'] = False
    broke(toc, 'fallback 只在为真时写入')


def test_empty_chapter_table_is_rejected(toc: Dict[str, Any]):
    """空文本切不出章节表（`toc.fallback_split` 返回 `[]`），那不是能上线的产物。"""
    toc['chapters'] = []
    broke(toc, 'chapters 为空')


@pytest.mark.parametrize('bad', ['not-a-list', {}, 42, None])
def test_chapters_must_be_an_array(toc: Dict[str, Any], bad: Any):
    toc['chapters'] = bad
    broke(toc, 'chapters 必须是数组')


def test_chapter_must_be_an_object(toc: Dict[str, Any]):
    toc['chapters'][1] = '第一章'
    broke(toc, 'chapters[1] 必须是对象')


@pytest.mark.parametrize('bad', ['{}', 42, None, []])
def test_toc_root_must_be_an_object(bad: Any):
    with pytest.raises(ValidationError, match='必须是对象'):
        check_toc(bad)


def test_message_lists_at_most_ten_problems():
    """系统性错误会产出成百上千条同源问题，消息必须有上限。"""
    data = make_toc(make_text(bodies=(1200,) * 30))
    count = len(data['chapters'])
    assert count == 30
    for chapter in data['chapters']:
        chapter['length'] += 1
    message = broke(data, '另有')
    assert f'{count} 处问题' in message
    assert message.count('\n    - ') == validate.MAX_LISTED_PROBLEMS
    assert f'另有 {count - validate.MAX_LISTED_PROBLEMS} 处未列出' in message


# ---------------------------------------------------------------------------
# 3. 单字段扰动全被捕获（穷举）
# ---------------------------------------------------------------------------

#: 合法产物的几种形态：有/无序章、卷节点在中间/末尾、单章、全书兜底。
#: 按名字索引（而不是把全文塞进 parametrize），否则 pytest 的用例 id 会是整本书。
VALID_TEXTS: Dict[str, str] = {
    '三章': make_text(),
    '序章 + 卷节点': MAIN_TEXT,
    '卷节点在末尾': make_text(bodies=(1200, 1200, 1200, 1200, 20)),
    '单章': make_text(bodies=(1200,)),
    '全书兜底': NO_HEADINGS,
}

SHAPES = list(VALID_TEXTS)


@pytest.mark.parametrize('shape', SHAPES)
def test_every_valid_shape_passes(shape: str):
    assert check_toc(make_toc(VALID_TEXTS[shape])).warnings == ()


@pytest.mark.parametrize('shape', SHAPES)
@pytest.mark.parametrize('field', ['id', 'start', 'end', 'length'])
@pytest.mark.parametrize('delta', [1, -1])
def test_any_single_offset_perturbation_is_caught(shape: str, field: str, delta: int):
    """把任一章节的任一数值字段挪 1，校验都必须失败。

    这是"严格连续覆盖"（需求 8.14）真正要的性质：偏移错位无处可藏。
    旧产物的 `charCount` 与 gz 字符数每行差 1（CRLF 与 LF 混算），正是这类错位
    在没有校验器的年代能一路活到线上的例子。
    """
    baseline = make_toc(VALID_TEXTS[shape])
    for index in range(len(baseline['chapters'])):
        data = copy.deepcopy(baseline)
        data['chapters'][index][field] += delta
        with pytest.raises(ValidationError):
            check_toc(data)


@pytest.mark.parametrize('shape', SHAPES)
@pytest.mark.parametrize('field', ['charCount', 'totalChapters'])
@pytest.mark.parametrize('delta', [1, -1])
def test_any_single_root_count_perturbation_is_caught(shape: str, field: str, delta: int):
    data = make_toc(VALID_TEXTS[shape])
    data[field] += delta
    with pytest.raises(ValidationError):
        check_toc(data)


# ---------------------------------------------------------------------------
# 4. 告警不是失败（不变量 6）
# ---------------------------------------------------------------------------


def test_long_volume_node_only_warns(toc: Dict[str, Any]):
    """`isVolume` 为真却很长 → 告警，产物照收：那是识别质量问题，不是 schema 问题。"""
    long_chapter = toc['chapters'][-1]
    long_chapter['isVolume'] = True
    toc['totalChapters'] -= 1          # 口径跟着改，否则先被不变量 4 拦下
    assert long_chapter['length'] >= VOLUME_BODY_MAX

    result = check_toc(toc)
    assert len(result.warnings) == 1
    assert '卷节点偏长' in result.warnings[0]
    assert str(long_chapter['length']) in result.warnings[0]


def test_short_volume_node_does_not_warn(toc: Dict[str, Any]):
    volume = volumes(toc)[0]
    assert volume['length'] < VOLUME_BODY_MAX
    assert check_toc(toc).warnings == ()


def test_warnings_go_to_stderr(capsys: Any, toc: Dict[str, Any]):
    toc['chapters'][-1]['isVolume'] = True
    toc['totalChapters'] -= 1
    check_toc(toc).emit_warnings()
    assert '卷节点偏长' in capsys.readouterr().err


def test_no_warnings_emits_nothing(capsys: Any, toc: Dict[str, Any]):
    check_toc(toc).emit_warnings()
    captured = capsys.readouterr()
    assert captured.out == '' and captured.err == ''


def test_deprecated_book_fields_only_warn(meta: Dict[str, Any]):
    """`txtPath`/`tocPath` 已由前端派生（design §2.2）：残留只是体积浪费。"""
    meta['txtPath'] = f'/books/{BOOK_ID}.txt.gz'
    meta['tocPath'] = f'/data/{BOOK_ID}_toc.json'
    result = check_book(meta)
    assert len(result.warnings) == 2
    assert all('字段已废弃' in line for line in result.warnings)


# ---------------------------------------------------------------------------
# 5. 必需字段与类型
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('field', TOC_FIELDS)
def test_missing_toc_field_is_rejected(toc: Dict[str, Any], field: str):
    del toc[field]
    broke(toc, f'缺少必需字段 {field}')


@pytest.mark.parametrize(
    'field,bad',
    [
        ('id', 123),
        ('id', ''),
        ('title', None),
        ('author', [BOOK_AUTHOR]),
        ('charCount', '12345678'),
        ('charCount', 86420.0),
        ('charCount', 0),
        ('totalChapters', True),
        ('tocRule', 42),
        ('tocRule', ''),
    ],
)
def test_wrong_toc_field_type_is_rejected(toc: Dict[str, Any], field: str, bad: Any):
    toc[field] = bad
    with pytest.raises(ValidationError):
        check_toc(toc)


def test_toc_rule_may_be_null(toc: Dict[str, Any]):
    """没有任何规则可用时 `tocRule` 就是 null，键本身仍须存在。"""
    toc['tocRule'] = None
    assert check_toc(toc).warnings == ()


@pytest.mark.parametrize('field', ['id', 'title', 'start', 'end', 'length'])
def test_missing_chapter_field_is_rejected(toc: Dict[str, Any], field: str):
    del toc['chapters'][1][field]
    broke(toc, f'chapters[1] 缺少必需字段 {field}')


@pytest.mark.parametrize('bad', ['0', 12.5, True, None, -1])
def test_non_integer_offset_is_rejected(toc: Dict[str, Any], bad: Any):
    """偏移要被前端拿去切字符串、当数组下标，`'0'` 与 `12.5` 在那里没人想过。"""
    toc['chapters'][1]['start'] = bad
    with pytest.raises(ValidationError):
        check_toc(toc)


@pytest.mark.parametrize('field', BOOK_FIELDS)
def test_missing_book_field_is_rejected(meta: Dict[str, Any], field: str):
    del meta[field]
    with pytest.raises(ValidationError, match=f'缺少必需字段 {field}'):
        check_book(meta)


@pytest.mark.parametrize(
    'field,bad',
    [
        ('id', ''),
        ('title', 42),
        ('author', None),
        ('charCount', 0),
        ('totalChapters', '2468'),
        ('gzSize', 0),
        ('titleAbbr', 42),
        ('authorAbbr', ''),
    ],
)
def test_wrong_book_field_type_is_rejected(meta: Dict[str, Any], field: str, bad: Any):
    meta[field] = bad
    with pytest.raises(ValidationError):
        check_book(meta)


def test_abbr_fields_are_optional(meta: Dict[str, Any]):
    """纯 ASCII 书名（如《XYZ》）的缩写与书名小写相同，此时按需求 5.6 省略。"""
    del meta['titleAbbr']
    del meta['authorAbbr']
    assert check_book(meta).warnings == ()


@pytest.mark.parametrize('bad', ['{}', 42, None, []])
def test_book_entry_must_be_an_object(bad: Any):
    with pytest.raises(ValidationError, match='必须是对象'):
        check_book(bad)


# ---------------------------------------------------------------------------
# 6. 整份 `books.json`（design §2.2）
# ---------------------------------------------------------------------------


def test_count_must_match_the_actual_length(meta: Dict[str, Any]):
    doc = make_books(meta)
    doc['count'] = 2
    with pytest.raises(ValidationError, match='count 应等于 books 的长度 1'):
        check_books(doc)


def test_duplicate_book_ids_are_rejected(meta: Dict[str, Any]):
    """两本书共用一组产物名 = 后写的覆盖先写的（需求 7.9 要求消歧到唯一）。"""
    doc = make_books(meta, copy.deepcopy(meta))
    with pytest.raises(ValidationError, match='与前面的条目重复'):
        check_books(doc)


def test_entry_problems_are_reported_with_their_index(meta: Dict[str, Any]):
    doc = make_books(meta)
    del doc['books'][0]['gzSize']
    with pytest.raises(ValidationError, match=r'books\[0\] 缺少必需字段 gzSize'):
        check_books(doc)


def test_generated_at_is_required(meta: Dict[str, Any]):
    doc = make_books(meta)
    del doc['generatedAt']
    with pytest.raises(ValidationError, match='缺少必需字段 generatedAt'):
        check_books(doc)


def test_odd_generated_at_format_only_warns(meta: Dict[str, Any]):
    """前端压根不读 `generatedAt`，格式偏差不该让整批构建失败。"""
    doc = make_books(meta)
    doc['generatedAt'] = '2026/09/24 09:08:23'
    result = check_books(doc)
    assert len(result.warnings) == 1 and '时间戳格式' in result.warnings[0]


@pytest.mark.parametrize('bad', ['[]', 42, {'a': 1}])
def test_books_must_be_an_array(meta: Dict[str, Any], bad: Any):
    doc = make_books(meta)
    doc['books'] = bad
    with pytest.raises(ValidationError, match='books 必须是数组'):
        check_books(doc)


def test_books_entry_must_be_an_object(meta: Dict[str, Any]):
    doc = make_books(meta)
    doc['books'][0] = BOOK_ID
    with pytest.raises(ValidationError, match=r'books\[0\] 必须是对象'):
        check_books(doc)


def test_empty_shelf_passes():
    """全批失败时 `books.json` 会是空的：那是坏消息，但不是坏结构。"""
    assert check_books(make_books()).warnings == ()


# ---------------------------------------------------------------------------
# 7. 编排层入口：两份产物一起验（design §4.9）
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('field', ['id', 'title', 'author', 'charCount', 'totalChapters'])
def test_check_cross_checks_the_two_artifacts(
    toc: Dict[str, Any], meta: Dict[str, Any], field: str
):
    """书架读 `books.json`、阅读器读 `_toc.json`，两边数字不一致时页面互相矛盾。"""
    meta[field] = meta[field] + 1 if isinstance(meta[field], int) else '别的'
    with pytest.raises(ValidationError, match='在两份产物里不一致'):
        check(meta, toc)


def test_check_without_toc_only_validates_the_entry(meta: Dict[str, Any]):
    assert check(meta).warnings == ()


def test_check_reports_problems_from_both_artifacts(
    toc: Dict[str, Any], meta: Dict[str, Any]
):
    """一次抛出、两份都报，省掉"修一轮再看一轮"。"""
    del meta['gzSize']
    toc['chapters'][0]['length'] += 1
    with pytest.raises(ValidationError) as excinfo:
        check(meta, toc)
    message = str(excinfo.value)
    assert '[books.json] 缺少必需字段 gzSize' in message
    assert '[_toc.json] chapters[0].length' in message
    assert BOOK_TITLE in message and BOOK_ID in message


def test_check_merges_warnings_from_both_artifacts(
    toc: Dict[str, Any], meta: Dict[str, Any]
):
    meta['txtPath'] = f'/books/{BOOK_ID}.txt.gz'
    toc['chapters'][-1]['isVolume'] = True
    toc['totalChapters'] -= 1
    meta['totalChapters'] -= 1         # 交叉核对的口径也要跟着改
    warnings = check(meta, toc).warnings
    assert len(warnings) == 2
    assert any('字段已废弃' in line for line in warnings)
    assert any('卷节点偏长' in line for line in warnings)


def test_check_rejects_a_non_mapping_toc(meta: Dict[str, Any]):
    with pytest.raises(ValidationError, match=r'\[_toc.json\] 必须是对象'):
        check(meta, ['chapters'])
