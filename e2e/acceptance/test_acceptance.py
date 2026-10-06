# -*- coding: utf-8 -*-
"""`e2e/acceptance/acceptance.py` 的例子测试（任务 23.2；需求 16.5、18.3、18.4、18.6、18.10）。

运行（仓库根目录）：`python -m pytest e2e/acceptance -q`

只测纯函数：输入都是内存里的小字典或 `tmp_path` 下的临时文件，不读写 `.kiro/specs/…` 的真实记录，
不运行 npm、Playwright 或会改动仓库的 git 命令。

- 18.3 `judge_6`：两次 fixture 运行的结果集合、逐用例结果与 Visual_Regression_Check。
- 18.4 `judge_8`：real 运行允许按 4.3 / 16.4 跳过；按用户决定（风险 R5）另允许 4.7 / 8.13，由
  `accepted_limits_8` 逐条记录并列入待人工复核清单；其余跳过类别仍不通过。
- 18.10 `stage_states` 与 `start_refusal`：三条摘要规则、并集、"从某阶段起重跑"、产物覆盖。
- 18.6 `compare_readings` 与 `take_readings`：读数逐项比较，缺失按 None。
- 16.5 `scope`：允许集合与 `package.json` 的内容核对；规格开始前已存在的改动（用户决定）只按精确路径与
  `name` 键的那一处改动排除。
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional

import pytest

# acceptance.py 不是包：按路径加载。它定义了 dataclass，执行前须登记在 sys.modules 中。
_ACCEPTANCE_PY = Path(__file__).resolve().parent / 'acceptance.py'
_SPEC = importlib.util.spec_from_file_location('_acceptance_under_test', _ACCEPTANCE_PY)
assert _SPEC is not None and _SPEC.loader is not None
acc = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = acc
_SPEC.loader.exec_module(acc)

DONE = acc.RESULT_DONE
FAILED = acc.RESULT_FAILED
INTERRUPTED = acc.RESULT_INTERRUPTED
ALL_STAGES = set(acc.STAGE_NUMBERS)

# ---------------------------------------------------------------------------
# results.json（RunSummaryModel）的构造
# ---------------------------------------------------------------------------

KNOWN = {'F-001', 'F-002', 'F-003'}
STARTED = '2025-06-01T10:00:00+08:00'


def row(rid: str, outcome: str = 'passed', *, file: str = 'e2e/tests/fixture/shelf-search-filter.spec.ts',
        title: Optional[str] = None, project: str = 'fixture', profile: Optional[str] = None,
        findings: tuple = (), skip: Optional[Dict[str, str]] = None, **extra: Any) -> Dict[str, Any]:
    """`CaseRow` 的最小形态。"""
    r: Dict[str, Any] = {
        'id': rid,
        'file': file,
        'title': title or f'用例 {rid}',
        'project': project,
        'profile': profile or ('real' if project.startswith('real') else project),
        'outcome': outcome,
        'startMs': 0,
        'durationMs': 1,
        'findings': list(findings),
    }
    if skip is not None:
        r['skip'] = skip
    r.update(extra)
    return r


def visual_row(rid: str, outcome: str = 'passed', **extra: Any) -> Dict[str, Any]:
    return row(rid, outcome, file='e2e/tests/fixture/visual.spec.ts', title=f'desktop › px-{rid}', **extra)


def run(rows: List[Dict[str, Any]], *, selected: tuple = ('fixture',), started: str = STARTED,
        abort: Optional[Dict[str, str]] = None, run_level: tuple = ()) -> Dict[str, Any]:
    return {
        'startedAt': started,
        'endedAt': started,
        'totalSec': 1,
        'selected': list(selected),
        'collected': True,
        'rows': rows,
        'stats': [],
        'runLevel': list(run_level),
        'abort': abort,
        'exitCode': 0,
    }


def fixture_rows() -> List[Dict[str, Any]]:
    """阶段 6 可以接受的一组结果：通过、引用 Finding 的预期失败、按 16.4 跳过、视觉回归通过。"""
    return [
        row('a1'),
        row('a2', 'expectedFail', title='11.10 缺书 F-002', findings=('F-002',)),
        row('a3', 'skipped', file='e2e/tests/fixture/reader-typography.spec.ts', title='10.7 行高滑杆',
            findings=('F-003',), skip={'kind': '16.4', 'reason': '[16.4 F-003] 行高滑杆无法定位'}),
        row('t1', project='tooling', file='e2e/tests/tooling/run-summary.spec.ts'),
        visual_row('v1'),
        visual_row('v2'),
    ]


def label(r: Mapping[str, Any]) -> str:
    return acc.row_label(r)


# ---------------------------------------------------------------------------
# 18.3：judge_6
# ---------------------------------------------------------------------------


def test_judge6_identical_acceptable_runs_pass() -> None:
    assert acc.judge_6(run(fixture_rows()), run(fixture_rows()), KNOWN) == []
    # 不给 known_findings 时不核对编号是否存在
    assert acc.judge_6(run(fixture_rows()), run(fixture_rows())) == []


def test_judge6_same_case_with_different_outcomes_fails() -> None:
    first, second = fixture_rows(), fixture_rows()
    second[0] = row('a1', 'expectedFail', findings=('F-002',))
    problems = acc.judge_6(run(first), run(second), KNOWN)
    assert problems == [f'两次结果不同：{label(first[0])}：第 1 次 通过，第 2 次 预期失败（F-002）']


def test_judge6_case_missing_from_one_run_fails() -> None:
    first, second = fixture_rows(), fixture_rows()
    dropped = second.pop(0)
    problems = acc.judge_6(run(first), run(second), KNOWN)
    assert problems == [f'用例只在第 1 次运行中出现：{label(dropped)}']


def test_judge6_visual_regression_failure_fails() -> None:
    first, second = fixture_rows(), fixture_rows()
    second[-1] = visual_row('v2', 'failed', errorLine='Error: 1500 pixels (ratio 0.002) are different.')
    problems = acc.judge_6(run(first), run(second), KNOWN)
    assert (f'第 2 次：Visual_Regression_Check 未通过：{label(second[-1])}：失败：'
            'Error: 1500 pixels (ratio 0.002) are different.') in problems
    assert any(p.startswith('两次结果不同：') for p in problems)
    assert not any(p.startswith('第 1 次') for p in problems)


def test_judge6_without_visual_rows_fails() -> None:
    rows = [r for r in fixture_rows() if not acc.is_visual_row(r)]
    problems = acc.judge_6(run(rows), run(fixture_rows()), KNOWN)
    assert '第 1 次：没有 visual.spec 的用例结果，Visual_Regression_Check 未执行' in problems


@pytest.mark.parametrize('bad, expected', [
    (row('b1', 'expectedFail'), '预期失败，但标注与标题中没有 Finding 编号'),
    (row('b1', 'expectedFail', findings=('F-099',)), '预期失败引用的 F-099 不在 findings.md 中'),
    (row('b1', 'skipped', skip={'kind': 'other', 'reason': '暂时跳过'}),
     '按 [other] 跳过（不带约定前缀的原因），18.3 只允许按 16.4 跳过；跳过原因：暂时跳过'),
    (row('b1', 'skipped', skip={'kind': '4.3', 'reason': '[4.3] books.json 缺失'}),
     '按 [4.3] 跳过（real 书库核对未通过），18.3 只允许按 16.4 跳过；跳过原因：[4.3] books.json 缺失'),
    (row('b1', 'skipped', skip={'kind': '16.4', 'reason': '[16.4] 定位不到'}),
     '按 16.4 跳过，但跳过原因中没有可测性缺口的 Finding 编号'),
    (row('b1', 'skipped', findings=('F-098',), skip={'kind': '16.4', 'reason': '[16.4 F-098] 定位不到'}),
     '按 16.4 跳过引用的 F-098 不在 findings.md 中'),
    (row('b1', 'unexpectedPass', findings=('F-002',)), '意外通过（带预期失败标注的用例实际通过），按失败计'),
    (row('b1', 'failed', errorLine='Error: expect(locator).toBeVisible() failed'),
     '失败：Error: expect(locator).toBeVisible() failed'),
    (row('b1', 'failed', timedOut=True, errorLine='Test timeout of 30000ms exceeded.'),
     '超时：Test timeout of 30000ms exceeded.'),
    (row('b1', 'notRun'), '未执行（运行被中断或没有结果）'),
], ids=['expected-fail-no-finding', 'expected-fail-unknown-finding', 'unprefixed-skip', 'skip-4.3',
        'skip-16.4-no-finding', 'skip-16.4-unknown-finding', 'unexpected-pass', 'failed', 'timed-out', 'not-run'])
def test_judge6_disallowed_outcome_fails_in_each_run(bad: Dict[str, Any], expected: str) -> None:
    rows = fixture_rows() + [bad]
    problems = acc.judge_6(run(rows), run([dict(r) for r in rows]), KNOWN)
    assert problems == [f'第 1 次：{label(bad)}：{expected}', f'第 2 次：{label(bad)}：{expected}']


def test_judge6_abort_and_run_level_failures_fail() -> None:
    aborted = run([], abort={'stage': 'server-selfcheck', 'reason': '自检失败 2 项'})
    dirty = run(fixture_rows(), run_level=(
        {'kind': 'snapshot-diff', 'total': 3},
        {'kind': 'review-consistency', 'violations': [{'kind': 'missing-shot'}]},
    ))
    problems = acc.judge_6(aborted, dirty, KNOWN)
    assert '第 1 次：运行中止于"server-selfcheck"：自检失败 2 项' in problems
    assert '第 1 次：没有 fixture 的用例结果' in problems
    assert '第 2 次：public/ 起止快照有 3 处差异（4.8）' in problems
    assert '第 2 次：Review_Report 一致性违规 1 条（missing-shot，13.11）' in problems


def test_judge6_missing_or_wrong_profile_run_fails() -> None:
    assert acc.judge_6(None, run(fixture_rows()), KNOWN) == ['第 1 次：结果文件缺失或无法解析']
    problems = acc.judge_6(run(fixture_rows()), run(fixture_rows(), selected=('real',)), KNOWN)
    assert "第 2 次：本次运行没有选中 fixture（selected = ['real']）" in problems


# ---------------------------------------------------------------------------
# 18.4：judge_8
# ---------------------------------------------------------------------------


def real_rows() -> List[Dict[str, Any]]:
    return [
        row('r1', project='real', file='e2e/tests/real/real-shots.spec.ts'),
        row('r2', 'expectedFail', project='real', file='e2e/tests/common/reader-search.spec.ts', findings=('F-002',)),
        row('r3', 'skipped', project='real-transparent', file='e2e/tests/real-transparent/load-progress-transparent.spec.ts',
            skip={'kind': '4.3', 'reason': '[4.3] public/data/books.json：缺失'}),
        row('r4', 'skipped', project='real', file='e2e/tests/common/reader-volumes.spec.ts',
            findings=('F-003',), skip={'kind': '16.4', 'reason': '[16.4 F-003] 卷节点按钮无法定位'}),
        # Perf_Metrics 不参与判定：perf 用例只要不失败就行，超预算不影响
        row('r5', project='real-perf', file='e2e/tests/real-perf/perf.spec.ts'),
    ]


def test_judge8_allowed_outcomes_pass() -> None:
    assert acc.judge_8(run(real_rows(), selected=('real',)), KNOWN) == []


def test_judge8_skip_without_reason_fails() -> None:
    bad = row('r9', 'skipped', project='real', skip={'kind': '4.3', 'reason': '  '})
    problems = acc.judge_8(run(real_rows() + [bad], selected=('real',)), KNOWN)
    assert problems == [f'{label(bad)}：按 [4.3] 跳过，但 Run_Summary 中没有写明原因']


# 用户决定（验收前，风险 R5）：按 [4.7] / [8.13] 跳过是真实书库的数据限制，阶段 8 允许但逐条记录。
# 下面两条跳过原因里的书 id 是自拟的合成样例。

VOLUMES_SPEC = 'e2e/tests/common/reader-volumes.spec.ts'
R47 = '[4.7] 雾港旧事-林栖: 全部节点标题为 ※※※（实际：…首个为第 3 个「第一章」）'
R813 = '[8.13] 当前书库缺少相邻卷节点：松间渡-白砚'


def r5_rows() -> List[Dict[str, Any]]:
    """按 row_label 排序后依次为 8.10（[4.7]）、8.3、8.4（[8.13]）。"""
    return [
        row('s1', 'skipped', project='real', file=VOLUMES_SPEC, title='8.10 卷节点标题', skip={'kind': '4.7', 'reason': R47}),
        row('s2', 'skipped', project='real', file=VOLUMES_SPEC, title='8.3 跨卷段导航', skip={'kind': '8.13', 'reason': R813}),
        row('s3', 'skipped', project='real', file=VOLUMES_SPEC, title='8.4 方向键跨卷', skip={'kind': '8.13', 'reason': R813}),
    ]


def test_judge8_skips_by_4_7_and_8_13_are_accepted_and_recorded() -> None:
    s47, s813a, s813b = r5_rows()
    run8 = run(real_rows() + [s813b, s47, s813a], selected=('real',))
    assert acc.judge_8(run8, KNOWN) == []
    accepted = acc.accepted_limits_8(run8)
    assert accepted == [
        {'case': label(s47), 'profile': 'real', 'kind': '4.7', 'reason': R47},
        {'case': label(s813a), 'profile': 'real', 'kind': '8.13', 'reason': R813},
        {'case': label(s813b), 'profile': 'real', 'kind': '8.13', 'reason': R813},
    ]
    assert acc.accepted_limits_note(accepted) == (
        '按用户决定接受的数据限制（风险 R5）3 项：[4.7] 1 个、[8.13] 2 个；已列入待人工复核清单')
    # 4.3 / 16.4 跳过不是数据限制
    assert acc.accepted_limits_8(run(real_rows(), selected=('real',))) == []
    assert acc.accepted_limits_8(None) == []


def test_judge8_accepted_data_limits_do_not_hide_other_failures() -> None:
    failed = row('s4', 'failed', project='real', errorLine='Error: boom')
    run8 = run(real_rows() + r5_rows() + [failed], selected=('real',))
    assert acc.judge_8(run8, KNOWN) == [f'{label(failed)}：失败：Error: boom']
    assert [a['kind'] for a in acc.accepted_limits_8(run8)] == ['4.7', '8.13', '8.13']


@pytest.mark.parametrize('kind, reason', [
    ('other', '暂时跳过'),
    ('3.9', '[3.9] Fixture_Generator 失败'),
], ids=['unprefixed', 'skip-3.9'])
def test_judge8_other_skip_kinds_still_fail(kind: str, reason: str) -> None:
    bad = row('s5', 'skipped', project='real', skip={'kind': kind, 'reason': reason})
    run8 = run(real_rows() + [bad], selected=('real',))
    assert acc.judge_8(run8, KNOWN) == [
        f'{label(bad)}：按 [{kind}] 跳过（{acc.SKIP_KIND_LABELS[kind]}），18.4 只允许按 4.3 或 16.4 跳过'
        f'（另按用户决定接受 [4.7]、[8.13] 作为数据限制）；跳过原因：{reason}']
    assert acc.accepted_limits_8(run8) == []


def test_accepted_data_limits_appear_in_summary_and_manual_review_list() -> None:
    s47 = r5_rows()[0]
    accepted = acc.accepted_limits_8(run(real_rows() + r5_rows(), selected=('real',)))
    section3 = acc.render_accepted_limits(accepted)
    assert any(line.startswith('按用户决定接受的数据限制（') for line in section3)
    assert acc.md_row([label(s47), '[4.7] Test_Book 缺少所需特征', R47]) in section3
    section7 = acc.render_review_records({'fixture': None, 'real': None}, accepted)
    assert '待人工复核（3 条，交由用户复核，不影响验收结论）：' in section7
    assert acc.md_row(['real', label(s47), f'按用户决定接受的数据限制：{R47}']) in section7
    assert acc.render_accepted_limits([]) == []


def test_judge8_abort_and_run_level_failures_fail() -> None:
    problems = acc.judge_8(run([], selected=('real',), abort={'stage': 'real-precheck', 'reason': 'books.json 缺失'}))
    assert 'real 运行：运行中止于"real-precheck"：books.json 缺失' in problems
    assert 'real 运行：没有 real 的用例结果' in problems

    problems = acc.judge_8(run(real_rows(), selected=('real',), run_level=(
        {'kind': 'run-error', 'errors': ['Error: No tests found']},)), KNOWN)
    assert problems == ['real 运行：Playwright 报告错误：Error: No tests found']

    assert acc.judge_8(None) == ['real 运行：结果文件缺失或无法解析']
    problems = acc.judge_8(run(fixture_rows()), KNOWN)
    assert "real 运行：本次运行没有选中 real（selected = ['fixture']）" in problems


# 阶段 4（18.1 (4)）：visual.spec 的每行都是通过


def test_judge4_requires_every_visual_row_to_pass() -> None:
    assert acc.judge_4(run(fixture_rows())) == []
    rows = fixture_rows()
    rows[-1] = visual_row('v2', 'failed', errorLine='Error: A snapshot does not exist')
    assert acc.judge_4(run(rows)) == [f'{label(rows[-1])}：失败，不是通过：Error: A snapshot does not exist']
    assert acc.judge_4(run([row('a1')])) == ['results.json 中没有 visual.spec 的用例结果']
    assert acc.judge_4(None) == ['run-4.json 缺失或无法解析']


# ---------------------------------------------------------------------------
# 18.10：stage_states 的失效规则与 start_refusal
# ---------------------------------------------------------------------------

DIGESTS = {'fixtureDigest': 'f' * 64, 'baselineDigest': 'b' * 64, 'suiteDigest': 's' * 64}
T62 = '2025-06-01T11:00:00+08:00'
T8 = '2025-06-01T12:00:00+08:00'
T_LATER = '2025-06-01T13:00:00+08:00'


def ex(n: int, result: Optional[str] = DONE, **digests: str) -> Dict[str, Any]:
    return {'stage': n, 'attempt': 1, 'result': result, 'digests': dict(digests)}


def done(*stages: int, current: Mapping[str, str] = DIGESTS) -> List[Dict[str, Any]]:
    """依次完成的执行；锚点阶段 3、4、5 记下当时的摘要值。"""
    out = []
    for n in stages:
        key = acc.ANCHOR_KEY.get(n)
        out.append(ex(n, **({key: current[key]} if key else {})))
    return out


def states(executions: List[Dict[str, Any]], current: Mapping[str, Optional[str]] = DIGESTS,
           out_started: Optional[str] = None,
           run_started: Optional[Mapping[int, Optional[str]]] = None) -> Dict[int, Any]:
    return acc.stage_states(executions, current, out_started, run_started)


def valid(st: Mapping[int, Any]) -> set:
    return {n for n, s in st.items() if s.valid}


def test_all_stages_completed_with_unchanged_digests_are_valid() -> None:
    st = states(done(*range(1, 12)))
    assert valid(st) == ALL_STAGES
    assert all(s.label == DONE and s.reasons == [] for s in st.values())


def test_status_of_last_execution_counts() -> None:
    execs = done(1, 2) + [ex(2, FAILED), ex(3, INTERRUPTED), ex(4, None)]
    st = states(execs)
    assert valid(st) == {1}
    assert (st[2].label, st[3].label, st[4].label, st[5].label) == (FAILED, INTERRUPTED, '进行中', '未执行')


@pytest.mark.parametrize('key, voided, restart', [
    ('fixtureDigest', set(range(4, 12)), '从阶段 4 起重跑'),
    ('baselineDigest', set(range(5, 12)), '从阶段 5 起重跑'),
    ('suiteDigest', {3} | set(range(6, 12)), '重跑阶段 3，以及阶段 6 起所有已完成的阶段'),
])
def test_each_digest_rule_voids_its_range(key: str, voided: set, restart: str) -> None:
    current = {**DIGESTS, key: 'changed'}
    st = states(done(*range(1, 12)), current)
    assert valid(st) == ALL_STAGES - voided
    for n in voided:
        assert st[n].label == '已失效'
        assert len(st[n].reasons) == 1 and restart in st[n].reasons[0], (n, st[n].reasons)
        assert '当前值 changed' in st[n].reasons[0]


def test_rules_hit_together_are_unioned() -> None:
    current = {**DIGESTS, 'fixtureDigest': 'changed', 'suiteDigest': 'changed'}
    st = states(done(*range(1, 12)), current)
    assert valid(st) == {1, 2}
    assert [len(st[n].reasons) for n in range(3, 12)] == [1, 1, 1, 2, 2, 2, 2, 2, 2]


def test_uncomputable_or_unrecorded_digest_counts_as_changed() -> None:
    st = states(done(*range(1, 7)), {**DIGESTS, 'suiteDigest': None})
    assert valid(st) == {1, 2, 4, 5}
    assert '当前值 （无）' in st[3].reasons[0]

    execs = done(1, 2, 3) + [ex(4)] + done(5)  # 阶段 4 的完成记录没有 fixtureDigest
    st = states(execs)
    assert valid(st) == {1, 2, 3}
    assert '记录值 （无）' in st[4].reasons[0]


def test_stage_completed_without_anchor_completion_is_void() -> None:
    st = states(done(1, 2) + [ex(6)])
    assert not st[6].valid
    assert len(st[6].reasons) == 3 and all('没有完成记录' in r for r in st[6].reasons)


def test_recompleting_stage4_voids_stages_completed_before_it() -> None:
    st = states(done(*range(1, 8)) + done(4))
    assert valid(st) == {1, 2, 3, 4}
    for n in (5, 6, 7):
        assert st[n].reasons == ['阶段 4 在本阶段完成之后重新完成（Fixture_Library（夹具源摘要）的规则）：从阶段 4 起重跑']


def test_recompleting_stage5_voids_stages_6_on_but_not_4() -> None:
    st = states(done(*range(1, 8)) + done(5))
    assert valid(st) == {1, 2, 3, 4, 5}
    assert all('阶段 5 在本阶段完成之后重新完成' in st[n].reasons[0] for n in (6, 7))


def test_rerun_of_stage3_after_suite_change_keeps_4_and_5_then_6_on_rerun() -> None:
    changed = {**DIGESTS, 'suiteDigest': 'suite-2'}
    execs = done(*range(1, 10))
    st = states(execs, changed)
    assert valid(st) == {1, 2, 4, 5}

    execs += done(3, current=changed)
    st = states(execs, changed)
    assert valid(st) == {1, 2, 3, 4, 5}  # 阶段 3 重跑不作废阶段 4、5
    for n in (6, 7, 8, 9):
        assert len(st[n].reasons) == 1 and '阶段 3 在本阶段完成之后重新完成' in st[n].reasons[0]
    assert st[10].label == '未执行'

    execs += done(6, 7, 8, 9, current=changed)
    assert valid(states(execs, changed)) == set(range(1, 10))


def test_output_overwritten_before_stage7_voids_stage6() -> None:
    execs = done(*range(1, 7))
    assert valid(states(execs, out_started=T62, run_started={6: T62})) == set(range(1, 7))

    st = states(execs, out_started=T_LATER, run_started={6: T62})
    assert valid(st) == set(range(1, 6))
    assert len(st[6].reasons) == 1
    assert 'run-6-2.json 的 startedAt' in st[6].reasons[0] and st[6].reasons[0].endswith('重跑阶段 6')

    # 阶段 7 进行中也算"尚未有效完成"
    assert not states(execs + [ex(7, None)], out_started=T_LATER, run_started={6: T62})[6].valid

    st = states(execs, out_started=T62, run_started={})
    assert st[6].reasons == ['acceptance/run-6-2.json 缺失或没有 startedAt，阶段 7 无从评审：重跑阶段 6']

    # 阶段 7 有效完成后，之后的运行不再影响阶段 6
    assert valid(states(done(*range(1, 8)), out_started=T_LATER, run_started={6: T62})) == set(range(1, 8))


def test_output_overwritten_before_stage9_voids_stage8() -> None:
    execs = done(*range(1, 9))
    run_started = {6: T62, 8: T8}
    assert valid(states(execs, out_started=T8, run_started=run_started)) == set(range(1, 9))

    st = states(execs, out_started=None, run_started=run_started)
    assert valid(st) == set(range(1, 8))
    assert 'e2e/.out/results.json 的 startedAt（无）已不等于 run-8.json 的 startedAt' in st[8].reasons[0]

    assert valid(states(done(*range(1, 10)), out_started=T_LATER, run_started=run_started)) == set(range(1, 10))


def test_start_refusal_completed_stage_is_not_rerun_voided_stage_is() -> None:
    execs = done(*range(1, 7))
    st = states(execs, out_started=T62, run_started={6: T62})
    assert '不重跑（18.10）' in acc.start_refusal(2, st, execs, True)
    assert acc.start_refusal(7, st, execs, True) is None

    st = states(execs, {**DIGESTS, 'fixtureDigest': 'changed'}, out_started=T62, run_started={6: T62})
    assert acc.start_refusal(4, st, execs, True) is None  # 从阶段 4 起重跑
    refusal = acc.start_refusal(6, st, execs, True)
    assert refusal is not None and '前置未完成' in refusal
    assert '阶段 4「' in refusal and '阶段 5「' in refusal


def test_start_refusal_failed_stage_restarts_from_its_beginning() -> None:
    execs = done(1) + [ex(2, FAILED)]
    st = states(execs)
    assert acc.start_refusal(2, st, execs, True) is None
    refusal = acc.start_refusal(3, st, execs, True)
    assert refusal is not None and '阶段 2「' in refusal

    open_execs = done(1) + [ex(2, None)]
    refusal = acc.start_refusal(2, states(open_execs), open_execs, True)
    assert refusal is not None and '尚未结束' in refusal


# ---------------------------------------------------------------------------
# 18.6：读数与比较
# ---------------------------------------------------------------------------

READINGS = {
    'booksJson.size': 1000,
    'booksJson.mtimeNs': 1_700_000_000_123_456_700,
    'booksDir.files': 7681,
    'booksDir.bytes': 2_000_000_000,
    'manifest.size': 500,
    'manifest.mtimeNs': 1_700_000_000_000_000_100,
}


def test_compare_readings_identical_has_no_diffs() -> None:
    assert acc.compare_readings({'version': 1, 'values': dict(READINGS)}, {'version': 1, 'values': dict(READINGS)}) == []
    # 直接传 values 也行
    assert acc.compare_readings(dict(READINGS), {'version': 1, 'takenAt': 'x', 'values': dict(READINGS)}) == []


def test_compare_readings_reports_each_changed_key_in_order() -> None:
    after = {**READINGS, 'manifest.size': 501, 'booksJson.mtimeNs': READINGS['booksJson.mtimeNs'] + 100,
             'booksDir.files': 7680}
    diffs = acc.compare_readings({'values': READINGS}, {'values': after})
    assert [(d.key, d.before, d.after) for d in diffs] == [
        ('booksJson.mtimeNs', 1_700_000_000_123_456_700, 1_700_000_000_123_456_800),
        ('booksDir.files', 7681, 7680),
        ('manifest.size', 500, 501),
    ]
    assert diffs[0].label == acc.READING_LABELS['booksJson.mtimeNs']


def test_compare_readings_missing_values_are_none() -> None:
    after = {**READINGS, 'manifest.size': None, 'manifest.mtimeNs': None}
    diffs = acc.compare_readings({'values': READINGS}, {'values': after})
    assert [(d.key, d.before, d.after) for d in diffs] == [
        ('manifest.size', 500, None),
        ('manifest.mtimeNs', 1_700_000_000_000_000_100, None),
    ]
    # 一侧缺键按 None；两侧都不存在算一致
    partial = {k: v for k, v in READINGS.items() if k != 'booksDir.bytes'}
    assert [d.key for d in acc.compare_readings({'values': READINGS}, {'values': partial})] == ['booksDir.bytes']
    both_missing = {**READINGS, 'manifest.size': None, 'manifest.mtimeNs': None}
    assert acc.compare_readings({'values': both_missing}, {'values': dict(both_missing)}) == []


def test_take_readings_on_temp_tree(tmp_path: Path) -> None:
    books_json = tmp_path / 'public' / 'data' / 'books.json'
    books_json.parent.mkdir(parents=True)
    books_json.write_bytes(b'[]')
    books_dir = tmp_path / 'public' / 'books'
    (books_dir / 'sub').mkdir(parents=True)
    (books_dir / 'a.txt.gz').write_bytes(b'x' * 10)
    (books_dir / 'sub' / 'b.txt.gz').write_bytes(b'y' * 5)

    before = acc.take_readings(tmp_path)
    values = before['values']
    assert set(values) == {k for k, _ in acc.READING_KEYS}
    assert values['booksJson.size'] == 2
    assert values['booksJson.mtimeNs'] == os.stat(books_json).st_mtime_ns
    assert (values['booksDir.files'], values['booksDir.bytes']) == (2, 15)
    assert (values['manifest.size'], values['manifest.mtimeNs']) == (None, None)
    assert acc.compare_readings(before, acc.take_readings(tmp_path)) == []

    st = os.stat(books_json)
    os.utime(books_json, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000))
    (books_dir / 'c.txt.gz').write_bytes(b'z' * 3)
    (tmp_path / '.preprocess-manifest.json').write_bytes(b'{}\n')
    diffs = acc.compare_readings(before, acc.take_readings(tmp_path))
    assert [d.key for d in diffs] == ['booksJson.mtimeNs', 'booksDir.files', 'booksDir.bytes',
                                      'manifest.size', 'manifest.mtimeNs']
    assert (diffs[1].before, diffs[1].after) == (2, 3)
    assert (diffs[2].before, diffs[2].after) == (15, 18)
    assert (diffs[3].before, diffs[3].after) == (None, 3)


def test_verdict_uses_all_stages_and_reading_comparison() -> None:
    st = states(done(*range(1, 11)))
    assert acc.verdict(st, {'values': READINGS}, {'values': dict(READINGS)}) == ('通过', [])

    conclusion, reasons = acc.verdict(st, {'values': READINGS}, {'values': {**READINGS, 'booksDir.files': None}})
    assert conclusion == '不通过'
    assert reasons == [f'读数不一致：{acc.READING_LABELS["booksDir.files"]}：阶段 1 开始前 7681，阶段 11 开始时 不存在']

    conclusion, reasons = acc.verdict(states(done(*range(1, 7)) + done(8, 9, 10)), {'values': READINGS}, None)
    assert conclusion == '不通过'
    assert any(r.startswith('阶段 7「') for r in reasons)
    assert any('缺少阶段 11 开始时的读数' in r for r in reasons)


# ---------------------------------------------------------------------------
# 16.5：改动范围
# ---------------------------------------------------------------------------

BASE = 'a' * 40
BASE_PKG: Dict[str, Any] = {
    'name': 'novel-reader',
    'private': True,
    'version': '0.0.0',
    'type': 'module',
    'scripts': {'build': 'vite build', 'test': 'vitest run'},
    'dependencies': {'react': '19.1.0'},
    'devDependencies': {'typescript': '5.8.3', 'vite': '7.0.0'},
}


def pkg(**changes: Any) -> str:
    data = json.loads(json.dumps(BASE_PKG))
    for key, value in changes.items():
        if value is None:
            data.pop(key, None)
        else:
            data[key] = value
    return json.dumps(data, indent=2)


def test_scope_allowed_paths_pass() -> None:
    paths = [
        'e2e/acceptance/test_acceptance.py', 'e2e/baselines/px-shelf-home-win32.png',
        '.kiro/specs/e2e-visual-testing/findings.md', 'package.json', 'package-lock.json', 'tsconfig.json',
        'eslint.config.js', '.gitignore', 'README.md', 'vitest.config.ts', 'playwright.config.ts',
        'src/utils/decompress.ts', 'src/utils/bookTextCheck.ts', 'src/utils/bookLoader.test.ts',
        '', 'package.json',  # 空行与重复（两条 git 命令的并集）
    ]
    result = acc.scope(BASE, paths, pkg(), pkg())
    assert result['ok'] is True and result['violations'] == [] and result['packageJson'] == []
    assert result['base'] == BASE
    assert len(result['paths']) == 14 and all(e['allowed'] for e in result['paths'])
    by_path = {e['path']: e['rule'] for e in result['paths']}
    assert by_path['e2e/acceptance/test_acceptance.py'] == '前缀 e2e/'
    assert by_path['src/utils/decompress.ts'] == '精确路径'


def test_scope_out_of_scope_paths_fail() -> None:
    paths = ['e2e/run.mjs', 'src/components/ReaderPage.tsx', 'public/robots.txt', 'scripts/build_index.py',
             '.kiro/specs/reader-consolidation/tasks.md', 'src/utils/other.ts', 'e2e.md']
    result = acc.scope(BASE, paths, pkg(), pkg())
    assert result['ok'] is False
    assert result['violations'] == sorted(p for p in paths if p != 'e2e/run.mjs')
    assert result['excluded'] == [] and result['packageJsonExcluded'] == []
    assert result['packageJson'] == []


# 用户决定（验收前）：规格开始前已存在的改动不计入 16.5 的核对。

OLD_NAME, NEW_NAME = 'novel-reader-web', 'cloudflare-pages-novel'


def test_scope_pre_existing_changes_are_excluded_and_listed() -> None:
    pre = list(acc.PRE_EXISTING_FILES)
    assert len(pre) == 7
    result = acc.scope(BASE, [*pre, 'e2e/run.mjs', 'package.json'], pkg(name=OLD_NAME), pkg(name=NEW_NAME))
    assert result['ok'] is True
    assert result['violations'] == [] and result['packageJson'] == []
    assert result['excluded'] == sorted(pre)
    assert result['packageJsonExcluded'] == [
        '键 name 由 "novel-reader-web" 改为 "cloudflare-pages-novel"（规格开始前已存在的改动）']
    by_path = {e['path']: e for e in result['paths']}
    assert by_path['scripts/preprocess.py'] == {
        'path': 'scripts/preprocess.py', 'allowed': False, 'excluded': True, 'rule': '规格开始前已存在的改动'}
    assert by_path['e2e/run.mjs']['excluded'] is False and by_path['e2e/run.mjs']['allowed'] is True

    scope_md = '\n'.join(acc.render_scope(result, None))
    assert '`scripts/preprocess.py`' in scope_md and '规格开始前已存在的改动' in scope_md
    assert acc.md_row(['public/favicon.svg', '不计入核对（规格开始前已存在的改动）']) in scope_md
    assert '- 结论：通过' in scope_md


def test_scope_pre_existing_exclusion_is_exact_path_only() -> None:
    near = ['public/favicon.png', 'public/favicon.svg.bak', 'scripts/lib/manifest_v2.py', 'scripts/lib/other.py',
            'scripts/tests/test_other.py', 'scripts/preprocess.py/x', 'Scripts/preprocess.py']
    result = acc.scope(BASE, [*near, 'scripts/preprocess.py'], pkg(), pkg())
    assert result['ok'] is False
    assert result['violations'] == sorted(near)
    assert result['excluded'] == ['scripts/preprocess.py']


@pytest.mark.parametrize('base_name, cur_name, expected', [
    (OLD_NAME, 'novel-reader-next', ['键 name 的内容有变化']),
    ('novel-reader', NEW_NAME, ['键 name 的内容有变化']),
    (OLD_NAME, None, ['删除了键 name']),
], ids=['other-new-name', 'other-old-name', 'name-removed'])
def test_scope_package_json_name_other_changes_still_fail(base_name: str, cur_name: Optional[str],
                                                          expected: List[str]) -> None:
    result = acc.scope(BASE, ['package.json'], pkg(name=base_name), pkg(name=cur_name))
    assert result['packageJson'] == expected
    assert result['packageJsonExcluded'] == []
    assert result['ok'] is False


def test_scope_package_json_name_exclusion_does_not_cover_other_keys() -> None:
    result = acc.scope(BASE, ['package.json'], pkg(name=OLD_NAME), pkg(name=NEW_NAME, version='1.0.0'))
    assert result['packageJson'] == ['键 version 的内容有变化']
    assert len(result['packageJsonExcluded']) == 1
    assert result['ok'] is False


def test_scope_package_json_allows_new_dev_dependency_and_scripts() -> None:
    current = pkg(
        devDependencies={**BASE_PKG['devDependencies'], '@playwright/test': '1.62.1', 'fast-check': '3.23.2'},
        scripts={**BASE_PKG['scripts'], 'e2e': 'node e2e/run.mjs', 'test': 'vitest run --config vitest.config.ts'},
    )
    result = acc.scope(BASE, ['package.json'], pkg(), current)
    assert result['ok'] is True and result['packageJson'] == []


@pytest.mark.parametrize('changes, expected', [
    ({'dependencies': {'react': '19.1.1'}}, ['键 dependencies 的内容有变化']),
    ({'overrides': {'vite': '7.0.1'}}, ['新增了键 overrides']),
    ({'type': None}, ['删除了键 type']),
    ({'devDependencies': {'typescript': '5.9.2', 'vite': '7.0.0'}},
     ['devDependencies 中已有条目 typescript 的版本由 5.8.3 改为 5.9.2']),
    ({'devDependencies': {'typescript': '5.8.3'}}, ['devDependencies 删除了已有条目 vite（原为 7.0.0）']),
], ids=['dependencies-changed', 'key-added', 'key-removed', 'dev-version-changed', 'dev-removed'])
def test_scope_package_json_violations_fail(changes: Dict[str, Any], expected: List[str]) -> None:
    result = acc.scope(BASE, ['package.json'], pkg(), pkg(**changes))
    assert result['violations'] == []
    assert result['packageJson'] == expected
    assert result['ok'] is False


def test_scope_package_json_unreadable_fails() -> None:
    assert acc.scope(BASE, [], None, pkg())['packageJson'] == ['取不到基准提交的 package.json']
    problems = acc.scope(BASE, [], pkg(), '{not json')['packageJson']
    assert len(problems) == 1 and problems[0].startswith('当前 package.json 无法解析')
