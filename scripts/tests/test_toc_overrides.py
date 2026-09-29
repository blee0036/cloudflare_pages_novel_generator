# -*- coding: utf-8 -*-
r"""`scripts/lib/toc_overrides.py` 规则人工覆盖（任务 21，需求 8.10）。

运行（仓库根目录）：`python -m pytest scripts/tests -q`

断言四件事：

1. **覆盖优先于自动判定**：命中时用点名的规则、且**根本没评分**（`scores` 为空），
   包括点名那两条默认不启用的激进规则——那是这张表最主要的用途（需求 8.6）。
2. **写错必须炸**：规则名不存在时抛 `OverrideError` 并列出全部合法名，
   绝不静默退回自动判定。这个功能就是为消掉"悄悄没生效"而存在的，不能自己再造一个。
3. **未命中不受影响**：表里没这本书时，结果与直接 `toc.pick_rule(text)` 逐字段相等。
4. **重跑仍生效**：表每次从磁盘重读，键是 `book_id`，没有"上次选了什么"的状态可丢。
   同一批产物的端到端双跑验证在任务记录里，这里钉住可单测的那一半。

另外校验**进版本库的那份** `scripts/toc-overrides.json` 本身能被加载——
它是手写文件，语法错了整批预处理会退出，这条断言是它的守门人。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict

import pytest

from scripts.lib import toc, toc_overrides
from scripts.lib.toc_overrides import COMMENT_PREFIX, OverrideError, Overrides, load, pick_rule_for
from scripts.lib.toc_rules import RULES, by_name

NL = '\r\n'

#: 这本"书"对自动判定与激进规则都有话说：`第N章 标题` 行让「标准章节」稳稳胜出；
#: 每章正文里那行顶格短句（`夜色深沉`）只有「顶格短行」会当成标题，所以两条规则的
#: 切分结果必然不同——"覆盖是否真的越过了自动判定"由此可观测。
#: 顺带一提，「顶格短行」在这本书上连误报门槛都过不了（n_ok 7 / n_bad 6），
#: 正是"只能人工点名"的那类规则。
BOOK = ''.join(
    f'第{i}章 标题{i}{NL}夜色深沉{NL}' + '正' * 1200 + NL
    for i in range(1, 8)
)

BOOK_ID = '覆盖测试-某人'


def write(tmp_path: Path, payload: Any) -> Path:
    path = tmp_path / 'toc-overrides.json'
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')
    return path


# ---------------------------------------------------------------------------
# 1. 覆盖优先于自动判定
# ---------------------------------------------------------------------------


def test_auto_pick_on_this_book_is_the_standard_rule():
    # 基线：不覆盖时这本书选「标准章节」。后面几条都以此为对照。
    assert toc.pick_rule(BOOK).name == '标准章节'


def test_override_wins_and_skips_scoring(tmp_path: Path):
    overrides = load(write(tmp_path, {BOOK_ID: '顶格短行'}))
    pick = pick_rule_for(BOOK, BOOK_ID, overrides)

    assert pick.name == '顶格短行'
    assert pick.overridden is True
    # 跳过自动判定的可观测证据：一条规则都没评分过
    assert pick.scores == ()
    assert (pick.n_ok, pick.n_bad, pick.early_exit) == (0, 0, False)


def test_override_can_name_a_disabled_aggressive_rule(tmp_path: Path):
    # 需求 8.6：这两条默认不参与自动择一，只能被本表点名（这是本表的主要用途）
    for name in ('顶格短行', '通用激进'):
        assert by_name(name).enabled is False
        overrides = load(write(tmp_path, {BOOK_ID: name}))
        assert overrides.rule_for(BOOK_ID).name == name
        assert pick_rule_for(BOOK, BOOK_ID, overrides).name == name


def test_override_actually_changes_the_split(tmp_path: Path):
    # 覆盖不只是改了 tocRule 字段，切分结果确实按点名的规则来
    auto = toc.split_book(BOOK, toc.pick_rule(BOOK).rule)
    overrides = load(write(tmp_path, {BOOK_ID: '顶格短行'}))
    forced = toc.split_book(BOOK, pick_rule_for(BOOK, BOOK_ID, overrides).rule)
    assert len(forced.chapters) > len(auto.chapters)
    assert '夜色深沉' in [c['title'] for c in forced.chapters]
    assert '夜色深沉' not in [c['title'] for c in auto.chapters]


# ---------------------------------------------------------------------------
# 2. 未命中不受影响
# ---------------------------------------------------------------------------


def test_miss_falls_through_to_auto_detection(tmp_path: Path):
    overrides = load(write(tmp_path, {'另一本书-另一个人': '顶格短行'}))
    assert pick_rule_for(BOOK, BOOK_ID, overrides) == toc.pick_rule(BOOK)


def test_no_table_at_all_falls_through(tmp_path: Path):
    assert pick_rule_for(BOOK, BOOK_ID, None) == toc.pick_rule(BOOK)
    empty = load(tmp_path / 'does-not-exist.json')
    assert len(empty) == 0
    assert pick_rule_for(BOOK, BOOK_ID, empty) == toc.pick_rule(BOOK)


def test_missing_file_is_an_empty_table_not_an_error(tmp_path: Path):
    # "没有覆盖"是正常状态，不该因为可选配置缺失就让整批失败
    overrides = load(tmp_path / 'nope.json')
    assert (len(overrides), overrides.rule_for(BOOK_ID)) == (0, None)


def test_empty_object_is_valid(tmp_path: Path):
    assert len(load(write(tmp_path, {}))) == 0


# ---------------------------------------------------------------------------
# 3. 写错必须炸（不许静默退回自动判定）
# ---------------------------------------------------------------------------


def test_unknown_rule_name_raises_and_lists_valid_names(tmp_path: Path):
    path = write(tmp_path, {BOOK_ID: '顶格短行 '.strip() + '（打错的）'})
    with pytest.raises(OverrideError) as excinfo:
        load(path)
    message = str(excinfo.value)
    assert '顶格短行（打错的）' in message
    assert BOOK_ID in message and str(path) in message
    # 全部合法名都要列出来，否则"到底该写什么"还得去翻源码
    for rule in RULES:
        assert rule.name in message


def test_typo_never_silently_falls_back_to_auto(tmp_path: Path):
    # 这条是本功能存在的理由：写错的覆盖如果静默无效，等于把人明确否决过的
    # 自动判定结果又装了回去，而日志一片正常
    path = write(tmp_path, {BOOK_ID: '标准章'})
    with pytest.raises(OverrideError):
        load(path)


@pytest.mark.parametrize(
    'payload',
    [
        {BOOK_ID: 123},
        {BOOK_ID: None},
        {BOOK_ID: True},
        {BOOK_ID: ['标准章节']},
        {BOOK_ID: {'name': '标准章节'}},
    ],
    ids=['int', 'null', 'bool', 'list', 'object'],
)
def test_value_must_be_a_rule_name_string(tmp_path: Path, payload: Dict[str, Any]):
    with pytest.raises(OverrideError, match='必须是规则名字符串'):
        load(write(tmp_path, payload))


def test_blank_value_raises(tmp_path: Path):
    with pytest.raises(OverrideError, match='规则名是空白'):
        load(write(tmp_path, {BOOK_ID: '   '}))


def test_blank_key_raises(tmp_path: Path):
    # 空键永远匹配不上任何书，留着它只会让人以为覆盖生效了
    with pytest.raises(OverrideError, match='空白'):
        load(write(tmp_path, {'  ': '标准章节'}))


@pytest.mark.parametrize('payload', [[], 'x', 1, None], ids=['list', 'str', 'int', 'null'])
def test_root_must_be_an_object(tmp_path: Path, payload: Any):
    with pytest.raises(OverrideError, match='根必须是对象'):
        load(write(tmp_path, payload))


def test_broken_json_raises_with_the_path(tmp_path: Path):
    path = tmp_path / 'toc-overrides.json'
    path.write_text('{ "书-作者": "标准章节", }', encoding='utf-8')
    with pytest.raises(OverrideError) as excinfo:
        load(path)
    assert '不是合法 JSON' in str(excinfo.value) and str(path) in str(excinfo.value)


def test_surrounding_whitespace_in_the_rule_name_is_tolerated(tmp_path: Path):
    # 手写 JSON 多打一个空格不该变成"规则名不存在"
    overrides = load(write(tmp_path, {BOOK_ID: '  标准章节 '}))
    assert overrides.rule_for(BOOK_ID).name == '标准章节'


# ---------------------------------------------------------------------------
# 4. 注释键、未命中键告警、重跑
# ---------------------------------------------------------------------------


def test_comment_keys_are_skipped(tmp_path: Path):
    overrides = load(write(tmp_path, {
        f'{COMMENT_PREFIX} 用法': '随便写什么都行，甚至不是规则名',
        f'{COMMENT_PREFIX}': 42,
        BOOK_ID: '标准章节',
    }))
    assert len(overrides) == 1
    assert overrides.rule_for(BOOK_ID).name == '标准章节'
    assert f'{COMMENT_PREFIX} 用法' not in overrides


def test_unused_keys_are_reported(tmp_path: Path):
    overrides = load(write(tmp_path, {BOOK_ID: '标准章节', '打错的书-作者': '顶格短行'}))
    assert overrides.unused([BOOK_ID]) == ['打错的书-作者']
    assert overrides.unused([BOOK_ID, '打错的书-作者']) == []


def test_table_is_read_fresh_every_time(tmp_path: Path):
    # 需求 8.10 后半句的机制：没有缓存、没有产物里的状态，重跑必然重新读到表
    path = write(tmp_path, {BOOK_ID: '标准章节'})
    assert load(path).rule_for(BOOK_ID).name == '标准章节'
    write(tmp_path, {BOOK_ID: '顶格短行'})
    assert load(path).rule_for(BOOK_ID).name == '顶格短行'
    assert pick_rule_for(BOOK, BOOK_ID, load(path)).name == '顶格短行'


def test_repeated_loads_are_identical(tmp_path: Path):
    path = write(tmp_path, {BOOK_ID: '顶格短行'})
    assert load(path) == load(path)


# ---------------------------------------------------------------------------
# 5. 进版本库的那份表
# ---------------------------------------------------------------------------


def test_committed_table_loads():
    # 手写文件，语法错了整批预处理会以非零码退出——这条是它的守门人
    assert toc_overrides.DEFAULT_PATH.name == 'toc-overrides.json'
    assert toc_overrides.DEFAULT_PATH.is_file(), '覆盖表必须进版本库（需求 8.10）'
    overrides = load()
    assert isinstance(overrides, Overrides)
    for book_id, rule in overrides.table.items():
        assert not book_id.startswith(COMMENT_PREFIX)
        assert by_name(rule.name) is rule


def test_committed_table_is_a_json_object_of_strings():
    raw = json.loads(toc_overrides.DEFAULT_PATH.read_text(encoding='utf-8'))
    assert isinstance(raw, dict), '形如 {"书-作者": "规则名"}（design §4.7）'
    assert all(isinstance(v, str) for v in raw.values())
    # 空表时也得留着用法说明：这文件是给人手写的
    assert any(k.startswith(COMMENT_PREFIX) for k in raw), '至少保留注释键说明用法'
