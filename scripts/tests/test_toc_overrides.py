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

另外钉住覆盖表移出版本库之后的约定（test-data-desensitization 需求 3，见第 5 节）：
本机表 `scripts/toc-overrides.local.json` 是预处理读的唯一路径，且被 `.gitignore` 排除；
进版本库的只有格式示例 `scripts/toc-overrides.example.json`，这里核对它能被加载、并自带
用法说明。本文件**不读本机表、也不断言它存在**：每次加载都显式传路径（`tmp_path` 下的
临时表或示例），本机有没有那张表，结果都一样（需求 3.13）。
"""

from __future__ import annotations

import json
import subprocess
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

#: 仓库根：只用来拼本机表的期望路径、在仓库里问 git。
REPO_ROOT = Path(__file__).resolve().parents[2]

#: 本机覆盖表相对仓库根的路径（需求 3.1、3.2）。
LOCAL_OVERRIDE = 'scripts/toc-overrides.local.json'


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
    ],
    ids=['int', 'null', 'bool', 'list'],
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


def test_non_utf8_table_raises_with_the_path(tmp_path: Path):
    # 换了编码另存的表（这里存成 GBK）：解码错误既不是 OSError 也不是 JSONDecodeError，
    # 漏接的话编排层拿到的是一段不带文件路径的 traceback，而不是一条能照着去改的报错
    path = tmp_path / 'toc-overrides.json'
    path.write_bytes(json.dumps({BOOK_ID: '标准章节'}, ensure_ascii=False).encode('gbk'))
    with pytest.raises(OverrideError) as excinfo:
        load(path)
    assert '不是合法的 UTF-8' in str(excinfo.value) and str(path) in str(excinfo.value)


def test_surrounding_whitespace_in_the_rule_name_is_tolerated(tmp_path: Path):
    # 手写 JSON 多打一个空格不该变成"规则名不存在"
    overrides = load(write(tmp_path, {BOOK_ID: '  标准章节 '}))
    assert overrides.rule_for(BOOK_ID).name == '标准章节'


# ---------------------------------------------------------------------------
# 3b. 对象写法：{"rule": …, "order": […]}（合集包的并入顺序）
# ---------------------------------------------------------------------------

ORDER = ['青石巷前传.txt', '青石巷.txt']


def test_object_with_only_a_rule_is_the_same_as_the_string_form(tmp_path: Path):
    overrides = load(write(tmp_path, {BOOK_ID: {'rule': '顶格短行'}}))
    assert overrides.rule_for(BOOK_ID).name == '顶格短行'
    assert overrides.order_for(BOOK_ID) is None
    assert pick_rule_for(BOOK, BOOK_ID, overrides).overridden is True


def test_object_with_only_an_order_leaves_the_rule_to_auto_detection(tmp_path: Path):
    overrides = load(write(tmp_path, {BOOK_ID: {'order': ORDER}}))
    assert overrides.order_for(BOOK_ID) == tuple(ORDER)
    assert overrides.rule_for(BOOK_ID) is None
    assert pick_rule_for(BOOK, BOOK_ID, overrides) == toc.pick_rule(BOOK)


def test_object_with_both_and_comment_keys(tmp_path: Path):
    overrides = load(write(tmp_path, {BOOK_ID: {
        f'{COMMENT_PREFIX} 为什么': '前传要先读',
        'rule': ' 标准章节 ',
        'order': [' 青石巷前传.txt', '青石巷.txt '],
    }}))
    assert overrides.rule_for(BOOK_ID).name == '标准章节'
    assert overrides.order_for(BOOK_ID) == tuple(ORDER), '首尾空白与规则名一样容忍'


def test_a_book_with_only_an_order_still_counts_and_can_be_unused(tmp_path: Path):
    # "点名了几本书"与"哪些键对不上书"都要把只写了 order 的书算进去，
    # 否则 order 的键写错了就没有任何信号
    overrides = load(write(tmp_path, {BOOK_ID: '标准章节', '打错的合集-作者': {'order': ORDER}}))
    assert len(overrides) == 2
    assert '打错的合集-作者' in overrides
    assert overrides.unused([BOOK_ID]) == ['打错的合集-作者']


@pytest.mark.parametrize(
    ('value', 'fragment'),
    [
        ({'name': '标准章节'}, '不认识的字段 name'),
        ({}, '至少写一个'),
        ({f'{COMMENT_PREFIX} 注释': '只有注释'}, '至少写一个'),
        ({'rule': 1}, '必须是规则名字符串'),
        ({'rule': '标准章'}, '不存在'),
        ({'order': []}, '非空的文件名列表'),
        ({'order': '青石巷.txt'}, '非空的文件名列表'),
        ({'order': ['青石巷.txt', 3]}, '不是非空字符串'),
        ({'order': ['青石巷.txt', ' ']}, '不是非空字符串'),
        ({'order': ['青石巷.txt', '青石巷.txt ']}, '列了两次'),
    ],
    ids=['unknown-key', 'empty', 'only-comments', 'rule-type', 'rule-typo', 'order-empty',
         'order-str', 'order-item-type', 'order-item-blank', 'order-duplicate'],
)
def test_malformed_object_raises_at_load_time(tmp_path: Path, value: Dict[str, Any], fragment: str):
    # 与规则名写错同一条理由：写这一项的人已经否决了自动结果，写坏了不能悄悄不生效
    path = write(tmp_path, {BOOK_ID: value})
    with pytest.raises(OverrideError) as excinfo:
        load(path)
    message = str(excinfo.value)
    assert fragment in message
    assert BOOK_ID in message and str(path) in message


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
# 5. 本机表与格式示例（test-data-desensitization 需求 3）
# ---------------------------------------------------------------------------
#
# 本机表点名的是真实书，只存在本机；进版本库的只有格式示例。这一节不读本机表、
# 也不断言它存在（需求 3.13）。


def test_default_path_is_the_local_file():
    # 需求 3.1：预处理只读这一个路径。它按模块文件位置解析成绝对路径，与从哪个目录启动无关。
    # 只比路径值，不碰文件本身
    assert toc_overrides.DEFAULT_PATH.is_absolute()
    assert toc_overrides.DEFAULT_PATH == REPO_ROOT / LOCAL_OVERRIDE


def test_local_override_file_is_gitignored():
    # 需求 3.2。`check-ignore` 只看忽略规则、不要求文件存在，所以本机有没有这张表都不影响结果；
    # 规则写在进库的 `.gitignore` 里而不是 `.git/info/exclude`，只做过 `git init` 的副本结果相同。
    # 不加 `--no-index` 时，已被跟踪的文件判为未忽略（退出码 1），被 `git add -f` 进了版本库
    # 同样会让这条失败
    result = subprocess.run(
        ['git', 'check-ignore', '-q', LOCAL_OVERRIDE],
        cwd=REPO_ROOT,
        capture_output=True,
    )
    assert result.returncode == 0, result.stderr.decode('utf-8', 'replace')


def test_example_table_documents_its_format():
    # 需求 3.4 (b)：示例是部署者手边唯一的格式说明，用法得写在文件自己身上
    raw = json.loads(toc_overrides.EXAMPLE_PATH.read_text(encoding='utf-8'))
    assert isinstance(raw, dict), '形如 {"书名-作者": "规则名"}'
    assert all(isinstance(v, (str, dict)) for v in raw.values())
    notes = '\n'.join(v for k, v in raw.items() if k.startswith(COMMENT_PREFIX))
    assert notes, '至少保留 1 个注释键说明用法'
    # 本机表在哪、它不进版本库、键是什么、值是什么、哪些键是注释、合集顺序怎么写
    for phrase in (LOCAL_OVERRIDE, '不进版本库', '书 id', '规则名', COMMENT_PREFIX, 'order'):
        assert phrase in notes, phrase
    # 两种写法各有一例：只看说明不看实例，照着抄的人仍然不知道对象该长什么样
    assert any(isinstance(v, str) for k, v in raw.items() if not k.startswith(COMMENT_PREFIX))
    assert any(isinstance(v, dict) for v in raw.values())


def test_example_table_loads():
    # 需求 3.5：接替旧的"进库的表能加载"。示例写坏了，照着抄的人抄到的就是一张加载即报错的表
    overrides = load(toc_overrides.EXAMPLE_PATH)
    assert overrides.found is True
    assert len(overrides) >= 1, '至少点名 1 本书，否则看不出值该怎么写'
    for book_id, rule in overrides.table.items():
        assert not book_id.startswith(COMMENT_PREFIX)
        assert by_name(rule.name) is rule
    assert overrides.orders, '至少有一本书示范 order 的写法'


def test_missing_file_loads_as_an_empty_table_marked_not_found(tmp_path: Path):
    # 需求 3.9：缺表照常运行，按空表处理；`found=False` 是编排层打印那一行提示的依据（需求 3.12）。
    # 同目录放两张能加载的表（示例名与旧文件名）：缺失时不改读它们（需求 3.1）
    table = json.dumps({BOOK_ID: '标准章节'}, ensure_ascii=False)
    for decoy in (toc_overrides.EXAMPLE_PATH.name, 'toc-overrides.json'):
        (tmp_path / decoy).write_text(table, encoding='utf-8')
    missing = tmp_path / toc_overrides.DEFAULT_PATH.name
    assert load(missing) == Overrides(path=missing, table={}, found=False)
