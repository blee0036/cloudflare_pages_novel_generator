# -*- coding: utf-8 -*-
"""`e2e/acceptance/defect_fixes.py` 的例子测试（reader-defect-fixes 任务 1.2；需求 1.3、1.4、1.5、1.6）。

运行（仓库根目录）：`python -m pytest e2e/acceptance/test_defect_fixes.py -q`

- `classify_changes`（纯函数，1.3–1.5）：允许路径、越界路径、F-001 文件变化、`HEAD` 变化、(d) 类未登记
  各一例。输入是内存里的小字典：由"Start_Snapshot 所记提交的文件 + 记快照时的未提交改动 + 之后的改动"
  推出 `git diff --name-only` 与 `git ls-files --others` 的输出和各文件的哈希。
- `cmd_snapshot`（1.2、1.6）：在 `tmp_path` 下的临时 git 仓库中正常写出，以及 F-001 的文件未提交时拒绝
  写出。git 子进程只读一份空的全局配置、不读系统配置，提交身份经环境变量给出；不读写真实仓库的
  `.kiro/specs/…`，也不在真实仓库中运行任何 git 命令。
- `compare_runs`（任务 21.2；需求 17.4）：一致、用例 id 集合不同、同一用例 outcome 不同、`visual.spec`
  有失败、没有 `visual.spec` 行。
- `evaluate_final_check` 的结论（任务 21.2；需求 21.6）：由 `passing_inputs()` 给出一份全部成立的最小输入
  （内存里的小字典与文本，形态同 `final-check.json`、`results.json`、Review_Record 等），再逐一扰动一处，
  核对结论为"不通过"、且恰是被扰动的条目不成立；另有 `render_acceptance` 的结论一节与
  `parse_finding_statuses` 跳过文件开头说明行的例子。
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional, Sequence, Set, Tuple

import pytest

# defect_fixes.py 不是包：按路径加载（它自己把本目录补进 sys.path 以 `import acceptance`）。
_DEFECT_FIXES_PY = Path(__file__).resolve().parent / 'defect_fixes.py'
_SPEC = importlib.util.spec_from_file_location('_defect_fixes_under_test', _DEFECT_FIXES_PY)
assert _SPEC is not None and _SPEC.loader is not None
dfx = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = dfx
_SPEC.loader.exec_module(dfx)

acc = dfx.acceptance

# ---------------------------------------------------------------------------
# classify_changes：模拟 git 输出与文件哈希
# ---------------------------------------------------------------------------

BASE = '1' * 40   # Start_Snapshot 记下的提交
LATER = '2' * 40  # 之后又出现的提交


def h(tag: str) -> str:
    return hashlib.sha256(tag.encode('utf-8')).hexdigest()


#: Start_Snapshot 所记提交中的文件：路径 → blob 的 SHA-256。
HEAD_TREE: Dict[str, str] = {p: h(f'head:{p}') for p in (
    *dfx.F001_FILES,
    'src/pages/ReaderPage.tsx', 'e2e/support/reader.ts',
    'package.json', 'README.md',
    'vite.config.ts', 'vitest.config.ts', 'build/linkAssets.ts',
    '.gitignore', 'site.config.json', 'scripts/preprocess.py',
)}

READINGS: Dict[str, Any] = {'version': 1, 'takenAt': '2026-10-02T09:00:00+08:00', 'values': {
    'booksJson.size': 1000,
    'booksJson.mtimeNs': 1_700_000_000_123_456_700,
    'booksDir.files': 7681,
    'booksDir.bytes': 2_000_000_000,
    'manifest.size': 500,
    'manifest.mtimeNs': 1_700_000_000_000_000_100,
}}


def snapshot(files: Optional[Mapping[str, Optional[str]]] = None) -> Dict[str, Any]:
    """Start_Snapshot 的最小形态；`files` 是记快照时 `git status --porcelain` 列出的文件及其哈希。"""
    return {'head': BASE, 'takenAt': READINGS['takenAt'], 'porcelain': '', 'files': dict(files or {}),
            'readings': READINGS}


def classify(snap: Mapping[str, Any], edits: Mapping[str, Optional[str]], *, head_now: str = BASE,
             registered_d: Iterable[str] = (), readings_now: Optional[Mapping[str, Any]] = None) -> Dict[str, Any]:
    """以 `HEAD_TREE` 与 `snap['files']` 还原记快照时的工作区，再施加 `edits`（路径 → 新内容标签；None 为
    删除），像 `scope` 一样由"工作区 vs 所记提交"推出 git 的两份输出后调用 `classify_changes`。"""
    tree: Dict[str, str] = dict(HEAD_TREE)
    later = [(p, None if tag is None else h(tag)) for p, tag in edits.items()]
    for path, digest in [*snap['files'].items(), *later]:
        if digest is None:
            tree.pop(path, None)
        else:
            tree[path] = digest
    tracked_diff = sorted(p for p in HEAD_TREE if tree.get(p) != HEAD_TREE[p])
    untracked = sorted(p for p in tree if p not in HEAD_TREE)
    return dfx.classify_changes(snap, head_now, tracked_diff, untracked, hash_of=tree.get,
                                hash_at_head=HEAD_TREE.get, registered_d=registered_d,
                                readings_now=readings_now)


def kinds(result: Mapping[str, Any]) -> Dict[str, tuple]:
    return {c['path']: (c['kind'], c['category']) for c in result['changes']}


def test_classify_allowed_paths_pass() -> None:
    # 记快照时 README.md 已有未提交的改动（记入 files），之后又改了一次
    snap = snapshot({'README.md': h('readme:dirty')})
    result = classify(snap, {
        'src/pages/ReaderPage.tsx': 'reader:fixed',
        'src/utils/sliderSettings.ts': 'slider:new',
        'e2e/support/reader.ts': None,
        'e2e/acceptance/test_defect_fixes.py': 'test:new',
        'package.json': 'pkg:pinned',
        'README.md': 'readme:again',
        'vitest.config.ts': 'vitest:exclude',
    }, registered_d={'vitest.config.ts'}, readings_now=READINGS)

    assert result['problems'] == [] and result['ok'] is True
    assert kinds(result) == {
        'README.md': ('modified', '(c)'),
        'e2e/acceptance/test_defect_fixes.py': ('added', '(b)'),
        'e2e/support/reader.ts': ('deleted', '(b)'),
        'package.json': ('modified', '(c)'),
        'src/pages/ReaderPage.tsx': ('modified', '(a)'),
        'src/utils/sliderSettings.ts': ('added', '(a)'),
        'vitest.config.ts': ('modified', '(d)'),
    }
    assert result['violations'] == [] and result['protected'] == [] and result['undocumentedD'] == []
    assert result['headUnchanged'] is True and all(f['ok'] for f in result['f001'])
    assert result['readingDiffs'] == []
    # 记快照时已有的改动以 Start_Snapshot 的哈希为起点，而不是所记提交中的内容
    readme = next(c for c in result['changes'] if c['path'] == 'README.md')
    assert (readme['start'], readme['current']) == (h('readme:dirty'), h('readme:again'))


def test_classify_out_of_scope_paths_fail() -> None:
    # site.config.json 的改动在 Start_Snapshot 之前就存在、之后没再动：不算变化
    snap = snapshot({'site.config.json': h('site:dirty')})
    result = classify(snap, {
        '.gitignore': 'gitignore:edited',
        'docs/notes.md': 'notes:new',
        'scripts/preprocess.py': 'preprocess:edited',
        'src/pages/ReaderPage.tsx': 'reader:fixed',
    })

    assert result['ok'] is False
    assert result['violations'] == ['.gitignore', 'docs/notes.md']
    assert result['protected'] == ['scripts/preprocess.py']
    assert 'site.config.json' not in kinds(result)
    assert result['problems'] == [
        '越界：.gitignore（修改；不在需求 1.1 的允许集合内）',
        '越界：docs/notes.md（新增；不在需求 1.1 的允许集合内）',
        '受保护路径有变化：scripts/preprocess.py（修改；需求 1.4）',
    ]


def test_classify_f001_file_change_fails() -> None:
    target = 'src/utils/decompress.ts'
    result = classify(snapshot(), {target: 'decompress:edited', 'src/pages/ReaderPage.tsx': 'reader:fixed'})

    assert result['ok'] is False
    # 只按 1.3 报一次；`src/` 前缀不覆盖 F-001 的 6 个文件，但也不另报越界
    assert result['problems'] == [f'F-001 文件的 SHA-256 有变化：{target}（需求 1.3）']
    assert result['violations'] == []
    change = next(c for c in result['changes'] if c['path'] == target)
    assert (change['f001'], change['allowed'], change['category']) == (True, False, None)
    f001 = {f['path']: f for f in result['f001']}
    assert set(f001) == set(dfx.F001_FILES)
    assert f001[target] == {'path': target, 'expected': HEAD_TREE[target], 'current': h('decompress:edited'),
                            'ok': False}
    assert all(f['ok'] for path, f in f001.items() if path != target)


def test_classify_head_change_fails() -> None:
    result = classify(snapshot(), {}, head_now=LATER)

    assert result['ok'] is False and result['headUnchanged'] is False
    assert result['changes'] == []
    assert result['problems'] == [f'HEAD 为 {LATER}，与 Start_Snapshot 记下的 {BASE} 不同（需求 1.4）']


def design(extra_rows: str = '') -> str:
    """设计文档的片段：只有"改动文件清单"一节中首格为 `(d)`、且不含"预计不改"的行算登记。"""
    return f'''# Design Document

## 改动文件清单

| 类别 | 文件 | 改动 |
| --- | --- | --- |
| (b) | `e2e/a11y/*`、`e2e/acceptance/test_defect_fixes.py` | 见各节 |
| (d) | `vitest.config.ts`：**仅当**测试文件集合变化时补 `exclude` | 依赖升级需要时 |
| (d) | `vite.config.ts`、`playwright.config.ts`、`build/*`：预计不改。若必须改，先在本节补上 | |
{extra_rows}
## Components and Interfaces

| (d) | `build/linkAssets.ts`：不在"改动文件清单"一节，不算登记 | |
'''


def test_classify_unregistered_d_paths_fail() -> None:
    registered = dfx.registered_d_entries(design())
    assert registered == {'vitest.config.ts'}
    edits = {'vitest.config.ts': 'vitest:exclude', 'vite.config.ts': 'vite:edited',
             'build/linkAssets.ts': 'link:edited'}
    result = classify(snapshot(), edits, registered_d=registered)

    assert result['ok'] is False
    assert result['undocumentedD'] == ['build/linkAssets.ts', 'vite.config.ts']
    assert result['violations'] == [] and result['protected'] == []
    assert result['problems'] == [
        '需在设计文档中说明：build/linkAssets.ts（修改；(d) 类，未在设计"改动文件清单"中登记）',
        '需在设计文档中说明：vite.config.ts（修改；(d) 类，未在设计"改动文件清单"中登记）',
    ]

    # 在 (d) 行补上登记（`build/*` 按前缀 `build/`）之后通过
    amended = dfx.registered_d_entries(design('| (d) | `vite.config.ts`、`build/*`：升级后必须改 | 依赖升级 |\n'))
    assert amended == {'vitest.config.ts', 'vite.config.ts', 'build/'}
    assert classify(snapshot(), edits, registered_d=amended)['ok'] is True


# ---------------------------------------------------------------------------
# cmd_snapshot：tmp_path 下的临时 git 仓库
# ---------------------------------------------------------------------------

#: 这些变量会让 git 落到别的仓库或索引上（例如在 git 钩子里运行 pytest 时）。
GIT_LOCATION_VARS = ('GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR',
                     'GIT_NAMESPACE')


def git(root: Path, *args: str) -> str:
    proc = subprocess.run(['git', '-c', 'core.quotepath=off', *args], cwd=root, stdin=subprocess.DEVNULL,
                          capture_output=True)
    assert proc.returncode == 0, proc.stderr.decode('utf-8', errors='replace')
    return proc.stdout.decode('utf-8')


def write(root: Path, rel: str, data: bytes) -> bytes:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return data


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


@pytest.fixture
def repo(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """临时 git 仓库：F-001 的 6 个文件与几个普通文件已提交，工作区干净；被 gitignore 的书库与清单另有内容。

    git 子进程（含被测代码启动的）只读一份空的全局配置、不读系统配置，提交身份经环境变量给出：既不受本机
    git 配置影响，也不改动它。`GIT_DIR` 等变量被清除，`GIT_CEILING_DIRECTORIES` 挡住向上查找。"""
    for name in GIT_LOCATION_VARS:
        monkeypatch.delenv(name, raising=False)
    empty_config = tmp_path / 'gitconfig'
    empty_config.write_bytes(b'')
    monkeypatch.setenv('GIT_CONFIG_GLOBAL', str(empty_config))
    monkeypatch.setenv('GIT_CONFIG_NOSYSTEM', '1')
    monkeypatch.setenv('GIT_CEILING_DIRECTORIES', str(tmp_path))
    for role in ('AUTHOR', 'COMMITTER'):
        monkeypatch.setenv(f'GIT_{role}_NAME', 'Test User')
        monkeypatch.setenv(f'GIT_{role}_EMAIL', 'test@example.com')

    root = tmp_path / 'repo'
    root.mkdir()
    git(root, 'init', '-q')
    write(root, '.gitignore', b'public/books/\npublic/data/\n.kiro/\n.preprocess-manifest.json\n')
    write(root, 'README.md', b'# repo\n')
    write(root, 'src/utils/old.ts', b'export const old = 1;\n')
    for path in dfx.F001_FILES:
        write(root, path, f'// {path}\n'.encode('utf-8'))
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'F-001')
    assert git(root, 'status', '--porcelain') == ''

    # 被 gitignore 的部分：不进 porcelain 与 files，只由 EV 18.6 读数覆盖
    write(root, 'public/data/books.json', b'[]')
    write(root, 'public/books/a.txt.gz', b'x' * 10)
    write(root, '.preprocess-manifest.json', b'{}\n')
    return root


def test_snapshot_writes_start_snapshot(repo: Path, capsys: pytest.CaptureFixture[str]) -> None:
    readme = write(repo, 'README.md', b'# repo\n\nchanged\n')
    (repo / 'src/utils/old.ts').unlink()
    added = write(repo, 'src/utils/新文件.ts', '// 非 ASCII 路径\n'.encode('utf-8'))
    nested = write(repo, 'e2e/新目录/新文件.txt', b'nested\n')

    assert dfx.cmd_snapshot(repo) == 0
    target = repo / dfx.SNAPSHOT_REL
    data = json.loads(target.read_text(encoding='utf-8'))
    assert set(data) == {'head', 'takenAt', 'porcelain', 'files', 'readings'}
    assert data['head'] == git(repo, 'rev-parse', 'HEAD').strip()
    assert datetime.fromisoformat(data['takenAt']).utcoffset() is not None
    # porcelain 是默认格式的全文：整个未跟踪的目录只列一行，非 ASCII 路径原样显示
    assert data['porcelain'] == git(repo, 'status', '--porcelain')
    assert sorted(data['porcelain'].splitlines()) == [
        ' D src/utils/old.ts', ' M README.md', '?? e2e/', '?? src/utils/新文件.ts']
    # files 把未跟踪目录逐个展开；已删除的为 null；被 gitignore 的不在其中
    assert data['files'] == {
        'README.md': sha(readme),
        'e2e/新目录/新文件.txt': sha(nested),
        'src/utils/old.ts': None,
        'src/utils/新文件.ts': sha(added),
    }
    values = data['readings']['values']
    assert values == acc.take_readings(repo)['values']
    assert (values['booksJson.size'], values['booksDir.files'], values['booksDir.bytes'], values['manifest.size']) \
        == (2, 1, 10, 3)
    assert f'Start_Snapshot 已写入 {dfx.SNAPSHOT_REL}' in capsys.readouterr().out

    # 基准只记一次：再次执行以退出码 2 结束，文件不变
    written = target.read_bytes()
    assert dfx.cmd_snapshot(repo) == 2
    assert target.read_bytes() == written
    assert '已存在' in capsys.readouterr().out


def test_snapshot_refuses_when_f001_files_uncommitted(repo: Path, capsys: pytest.CaptureFixture[str]) -> None:
    # F-001 的文件分别处于：未跟踪（从索引中移除后提交）、已暂存的修改、未暂存的修改
    git(repo, 'rm', '--cached', '-q', 'src/utils/bookTextCheck.test.ts')
    git(repo, 'commit', '-q', '-m', 'untrack')
    write(repo, 'src/utils/loadMetrics.ts', b'// staged\n')
    git(repo, 'add', 'src/utils/loadMetrics.ts')
    write(repo, 'src/utils/decompress.ts', b'// edited\n')
    write(repo, 'README.md', b'# repo\n\nchanged\n')  # 不是 F-001 的文件：不列出
    expected = {
        ('??', 'src/utils/bookTextCheck.test.ts'),
        ('M ', 'src/utils/loadMetrics.ts'),
        (' M', 'src/utils/decompress.ts'),
    }

    blocked, payload = dfx.collect_snapshot(repo)
    assert payload is None
    assert len(blocked) == 3 and set(blocked) == expected

    assert dfx.cmd_snapshot(repo) == 2
    assert not (repo / dfx.SNAPSHOT_REL).exists()
    lines = capsys.readouterr().out.splitlines()
    assert any('F-001 尚未提交' in line for line in lines)
    assert sorted(line for line in lines if line.startswith('  ')) == sorted(f'  {c} {p}' for c, p in expected)


# ---------------------------------------------------------------------------
# run（任务 19.4；需求 21.1、21.2）
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('argv, expected', [
    (['npm', 'run', 'e2e'], True),
    (['npm', 'run', 'e2e:profile', '--', '--profile', 'fixture'], True),
    (['npm.cmd', 'run', 'e2e:update'], True),
    (['npx', 'playwright', 'test', '-g', '@selfcheck'], True),
    (['node', 'e2e/run.mjs', '--profile', 'real'], True),
    (['npm', 'run', 'e2e:fixture'], False),
    (['npm', 'run', 'typecheck'], False),
    (['npm', 'audit'], False),
    (['python', '-m', 'pytest', 'scripts/tests', '-q'], False),
])
def test_is_playwright_command(argv: list, expected: bool) -> None:
    assert dfx.is_playwright_command(argv) is expected


def test_split_run_argv_keeps_inner_separator() -> None:
    own, command = dfx.split_run_argv(['run', 'fixture-1', '--', 'npm', 'run', 'e2e:profile', '--', '--profile',
                                       'fixture'])
    assert own == ['run', 'fixture-1']
    assert command == ['npm', 'run', 'e2e:profile', '--', '--profile', 'fixture']
    assert dfx.split_run_argv(['compare-runs', 'a', 'b']) == (['compare-runs', 'a', 'b'], None)


def test_run_records_command_and_refuses_duplicate_id(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    argv = ['python', '-c', 'import sys; sys.exit(3)']
    assert dfx.cmd_run('gate-1', argv, root=tmp_path) == 3
    data = json.loads((tmp_path / dfx.FINAL_CHECK_REL).read_text(encoding='utf-8'))
    [entry] = data['commands']
    assert entry['id'] == 'gate-1' and entry['argv'] == argv and entry['exitCode'] == 3
    assert entry['playwright'] is False and entry['results'] is None
    started, ended = (datetime.fromisoformat(entry[k]) for k in ('startedAt', 'endedAt'))
    assert started.utcoffset() is not None and started <= ended
    assert not (tmp_path / dfx.LOCK_REL).exists()

    # 同一 id 只记一次：拒绝执行，记录不变
    before = (tmp_path / dfx.FINAL_CHECK_REL).read_bytes()
    assert dfx.cmd_run('gate-1', ['python', '-c', 'pass'], root=tmp_path) == 2
    assert (tmp_path / dfx.FINAL_CHECK_REL).read_bytes() == before
    assert '已有 id 为 gate-1' in capsys.readouterr().out


def test_run_refuses_playwright_command_when_lock_exists(tmp_path: Path) -> None:
    lock = tmp_path / dfx.LOCK_REL
    lock.parent.mkdir(parents=True)
    lock.write_text('{"id": "other"}\n', encoding='utf-8')
    assert dfx.cmd_run('e2e-1', ['node', 'e2e/run.mjs', '--profile', 'fixture'], root=tmp_path) == 2
    assert lock.read_text(encoding='utf-8') == '{"id": "other"}\n'  # 别人的锁不动
    assert not (tmp_path / dfx.FINAL_CHECK_REL).exists()           # 未执行，也未记录


# ---------------------------------------------------------------------------
# compare_runs（任务 21.2；需求 17.4）
# ---------------------------------------------------------------------------

COMMON_SPEC = 'e2e/tests/common/reader-progress.spec.ts'
VISUAL_SPEC = 'e2e/tests/fixture/visual.spec.ts'


def case(rid: str, file: str, title: str, outcome: str = 'passed', *, project: str = 'fixture',
         **extra: Any) -> Dict[str, Any]:
    """`results.json` 中 `rows` 的一行（只取被测代码读到的字段，形态同 RunSummaryModel 的行）。"""
    return {'id': rid, 'file': file, 'title': title, 'project': project, 'profile': project, 'outcome': outcome,
            'durationMs': 100, 'findings': [], **extra}


def results_doc(rows: Sequence[Mapping[str, Any]], started: str = '2026-10-01T22:50:00.000+08:00') -> Dict[str, Any]:
    return {'startedAt': started, 'exitCode': 0, 'rows': [dict(r) for r in rows]}


def two_fixture_rows() -> List[Dict[str, Any]]:
    return [
        case('c1', COMMON_SPEC, '9.1 进度恢复'),
        case('c2', COMMON_SPEC, '9.8 节流'),
        case('v1', VISUAL_SPEC, '12.2 px-shelf-home'),
        case('v2', VISUAL_SPEC, '12.2 px-reader-default'),
    ]


def label_of(rid: str, rows: Sequence[Mapping[str, Any]]) -> str:
    return acc.row_label(next(r for r in rows if r['id'] == rid))


def test_compare_runs_identical_runs_are_consistent() -> None:
    rows = two_fixture_rows()
    assert dfx.compare_runs(results_doc(rows), results_doc(rows)) == []
    # 行的顺序与运行开始时间不参与比较
    later = results_doc(list(reversed(rows)), started='2026-10-01T23:10:00.000+08:00')
    assert dfx.compare_runs(results_doc(rows), later, ('fixture-1', 'fixture-2')) == []


def test_compare_runs_case_id_sets_differ() -> None:
    rows = two_fixture_rows()
    extra = case('c3', COMMON_SPEC, '9.9 新用例')
    run1 = results_doc(rows)
    run2 = results_doc([*rows[1:], extra])  # 少了 c1，多了 c3
    assert dfx.compare_runs(run1, run2) == [
        f'用例只在第 1 次中出现：{label_of("c1", rows)}',
        f'用例只在第 2 次中出现：{acc.row_label(extra)}',
    ]


def test_compare_runs_same_ids_but_outcome_differs() -> None:
    rows = two_fixture_rows()
    changed = [dict(r, outcome='failed', errorLine='Error: timeout') if r['id'] == 'c2' else r for r in rows]
    assert dfx.compare_runs(results_doc(rows), results_doc(changed), ('fixture-1', 'fixture-2')) == [
        f'两次结果不同：{label_of("c2", rows)}：fixture-1 通过，fixture-2 失败',
    ]


def test_compare_runs_visual_failure_in_either_run() -> None:
    rows = two_fixture_rows()
    failed = [dict(r, outcome='failed', errorLine='Screenshot comparison failed: 812 pixels')
              if r['id'] == 'v2' else r for r in rows]
    v2 = label_of('v2', rows)
    # 两次都失败：outcome 相同，只报 Visual_Regression_Check
    assert dfx.compare_runs(results_doc(failed), results_doc(failed)) == [
        f'第 1 次：Visual_Regression_Check 未通过：{v2}：失败：Screenshot comparison failed: 812 pixels',
        f'第 2 次：Visual_Regression_Check 未通过：{v2}：失败：Screenshot comparison failed: 812 pixels',
    ]
    # 只有第 1 次失败：另报两次结果不同
    problems = dfx.compare_runs(results_doc(failed), results_doc(rows))
    assert problems == [
        f'两次结果不同：{v2}：第 1 次 失败，第 2 次 通过',
        f'第 1 次：Visual_Regression_Check 未通过：{v2}：失败：Screenshot comparison failed: 812 pixels',
    ]


def test_compare_runs_without_visual_rows_or_results() -> None:
    rows = [r for r in two_fixture_rows() if not acc.is_visual_row(r)]
    assert dfx.compare_runs(results_doc(rows), results_doc(rows)) == [
        '第 1 次：没有 visual.spec 的用例结果，Visual_Regression_Check 未执行',
        '第 2 次：没有 visual.spec 的用例结果，Visual_Regression_Check 未执行',
    ]
    assert dfx.compare_runs(None, results_doc(two_fixture_rows()), ('fixture-1', 'fixture-2')) == [
        'fixture-1：结果文件缺失或无法解析']


# ---------------------------------------------------------------------------
# evaluate_final_check：全部成立的最小输入（任务 21.2；需求 21.6）
# ---------------------------------------------------------------------------

TZ = timezone(timedelta(hours=8))
T0 = datetime(2026, 10, 3, 9, 0, tzinfo=TZ)


def at(minutes: float) -> str:
    """Final_Check 当天 09:00 起第 `minutes` 分钟（带 UTC 偏移，同 `run` 的写法）。"""
    return (T0 + timedelta(minutes=minutes)).isoformat(timespec='milliseconds')


FIXTURE_ARGV = ('npm', 'run', 'e2e:profile', '--', '--profile', 'fixture')
REAL_ARGV = ('npm', 'run', 'e2e:profile', '--', '--profile', 'real')
#: 各次 Playwright 运行写进 results.json 的 startedAt（Review_Record 开头以它对应被评审运行）。
STARTED: Dict[str, str] = {'fixture-2': at(0.1), 'real-1': at(10.1), 'e2e': at(36.1)}
REVIEW_RUNS: Dict[str, str] = {'fixture': 'fixture-2', 'real': 'real-1'}

#: 被评审运行中的 Review_Shot：(名称, 准则条数)。点名准则见 `dfx.MANDATORY_CRITERIA`。
REVIEW_SHOTS: Dict[str, Tuple[Tuple[str, int], ...]] = {
    'fixture': (('load-error', 3),),
    'real': (('toc-volumes', 2), ('search-highlight', 2), ('reader-mobile-toc', 2)),
}
UNCAPTURED_REASON = '被跳过：[8.13] 当前书库缺少相邻卷节点'

BASELINE_FILES: Tuple[str, ...] = tuple(f'px-shot-{i:02d}-win32.png' for i in range(1, 14))

DEPS: Dict[str, Dict[str, str]] = {
    'dependencies': {'react': '19.1.0', 'react-dom': '19.1.0'},
    'devDependencies': {'@playwright/test': '1.62.1', 'vite': '6.3.5'},
}

ITEM_KEYS = ['21.1', '21.2', '21.3', '14.5', '15.1', '21.4', '1.5', '17.2', '17.5', '18.2', '19.1', '19.2', '19.3']


def command(cid: str, argv: Sequence[str], start: float, end: float, exit_code: Optional[int] = 0) -> Dict[str, Any]:
    """`final-check.json` 中 `commands` 的一条（同 `cmd_run` 写出的字段）。"""
    playwright = dfx.is_playwright_command(argv)
    return {'id': cid, 'argv': list(argv), 'startedAt': at(start), 'endedAt': at(end),
            'durationSec': round((end - start) * 60, 1), 'exitCode': exit_code, 'playwright': playwright,
            'results': dfx.results_rel(cid) if playwright else None, 'notes': []}


def reading(minute: float) -> Dict[str, Any]:
    return {'version': 1, 'takenAt': at(minute), 'values': dict(READINGS['values'])}


def e2e_rows() -> List[Dict[str, Any]]:
    """`npm run e2e` 的行：fixture、real、tooling 各有通过的用例；real 另有 EV 阶段 8 的 5 个数据限制跳过。"""
    limits = [case('r-47', 'e2e/tests/real/search.spec.ts', '4.7 搜索高亮', 'skipped', project='real',
                   skip={'kind': '4.7', 'reason': '[4.7] Test_Book 缺少所需特征：没有含长串的章节'})]
    limits += [case(f'r-813-{i}', 'e2e/tests/real/toc-volumes.spec.ts', f'8.13 相邻卷 {i}', 'skipped', project='real',
                    skip={'kind': '8.13', 'reason': '[8.13] 当前书库缺少相邻卷节点'}) for i in range(1, 5)]
    return [
        case('f-1', COMMON_SPEC, '9.1 进度恢复'),
        case('f-v', VISUAL_SPEC, '12.2 px-shelf-home'),
        case('r-1', COMMON_SPEC, '9.1 进度恢复', project='real'),
        *limits,
        case('t-1', 'e2e/tests/tooling/summary.spec.ts', '16.1 Run_Summary', project='tooling'),
    ]


def a11y_section() -> Dict[str, Any]:
    """`results.json` 的 A11y_Scan 一节：31 次扫描全部完成、0 违规；书卡封面的 5 次扫描带 color-contrast incomplete。"""
    entries = []
    for name in dfx.A11Y_SCAN_NAMES:
        incomplete: List[Dict[str, Any]] = []
        if name in dfx.COVER_SCANS:
            incomplete = [{'id': dfx.COLOR_CONTRAST, 'nodes': 2, 'details': [
                {'target': ['.bg-gradient-to-br.from-sky-500 > h3'],
                 'failureSummary': "Element's background color could not be determined due to a background gradient"},
                {'target': ['header > p'], 'failureSummary': 'Element content overlaps a pseudo element'},
            ]}]
        parts = name.split('-')  # a11y-<视图>、a11y-contrast-<主题>、a11y-contrast-<视图>-<主题>
        entries.append({'name': name, 'view': parts[1] if len(parts) == 2 else parts[2] if len(parts) == 4 else 'reader',
                        'theme': parts[-1] if parts[1] == 'contrast' else 'unset', 'rules': 'wcag',
                        'result': {'kind': 'ok', 'violations': [], 'incomplete': incomplete, 'axeVersion': '4.13.0'}})
    return {'status': 'ok', 'lines': [], 'data': {'specFile': 'e2e/tests/fixture/a11y.spec.ts', 'tags': [],
                                                  'collected': len(entries), 'axeVersions': ['4.13.0'],
                                                  'entries': entries, 'problems': []}}


def e2e_results() -> Dict[str, Any]:
    rows = e2e_rows()
    stats = []
    for profile in dfx.E2E_PROFILES:
        counts = {k: sum(1 for r in rows if r['profile'] == profile and r['outcome'] == k) for k in acc.OUTCOME_ORDER}
        stats.append({'profile': profile, 'ran': True, 'counts': counts, 'notRun': 0, 'wallSec': 60.0})
    return {'startedAt': STARTED['e2e'], 'endedAt': at(55.9), 'selected': 'all', 'exitCode': 0, 'abort': None,
            'runLevel': [], 'stats': stats, 'rows': rows, 'sections': {'a11y': a11y_section()}}


def review_record_text(profile: str, overrides: Optional[Mapping[str, Tuple[str, str]]] = None,
                       pending: Sequence[Tuple[str, str]] = ()) -> str:
    """`review-record-<profile>.md`（EV 13.6 的格式）：默认每条准则"通过"；`overrides` 为 条目 → (判定, Finding)。"""
    lines = [f'# Review_Record：{profile}', '',
             f'- 所评 Review_Report 的运行开始时间：{STARTED[REVIEW_RUNS[profile]]}',
             '- Reviewer：Kiro', '- 评审日期：2026-10-03', '',
             '## 判定', '', '| 条目 | 判定 | 依据 | Finding |', '|---|---|---|---|']
    for name, n in REVIEW_SHOTS[profile]:
        for k in range(1, n + 1):
            item = f'{name}#{k}'
            verdict, finding = (overrides or {}).get(item, (dfx.PASS, '—'))
            lines.append(f'| `{item}` | {verdict} | {item} 的画面符合准则 | {finding} |')
    if profile == 'real':
        lines.append(f'| `toc-stars` | 未拍摄 | {UNCAPTURED_REASON} |')
    lines += ['', '## 待人工复核', '']
    lines += [f'| `{item}` | {reason} |' for item, reason in pending] or ['- 本记录没有"无法判断"的条目。']
    return '\n'.join(lines) + '\n'


def review_report(profile: str) -> Dict[str, Any]:
    """被评审运行的 `review-report.json`（ReviewReportData）中被核对的字段。"""
    shots: List[Dict[str, Any]] = [{'name': name, 'profile': profile, 'captured': True, 'criteria': n}
                                   for name, n in REVIEW_SHOTS[profile]]
    if profile == 'real':
        shots.append({'name': 'toc-stars', 'profile': 'real', 'captured': False, 'criteria': 2,
                      'reason': UNCAPTURED_REASON})
    return {'startedAt': STARTED[REVIEW_RUNS[profile]], 'shots': shots}


def baseline_review_text(overrides: Optional[Mapping[str, Tuple[str, str]]] = None) -> str:
    """`baseline-review.md`：判定节 13 行（默认"接受"）；其后另有一张首格同为 PNG 文件名的行距读数表。"""
    lines = ['# Pixel_Baseline 评审', '', '## 判定', '',
             '| 文件 | 判定 | 依据 | Finding | Reviewer | 日期 |', '|---|---|---|---|---|---|']
    for file in BASELINE_FILES:
        verdict, finding = (overrides or {}).get(file, ('接受', '—'))
        lines.append(f'| `{file}` | {verdict} | 画面与修复后的预期一致 | {finding} | Kiro | 2026-10-02 |')
    lines += ['', '## 正文行距读数', '', '| 文件 | 相邻行间距（px） |', '|---|---|']
    lines += [f'| `{file}` | 35.15 |' for file in BASELINE_FILES[:9]]
    return '\n'.join(lines) + '\n'


def findings_text(statuses: Optional[Mapping[str, str]] = None, omit: Iterable[str] = ()) -> str:
    """Findings_Log：开头说明字段写法的 `- 状态：` 行不属于任何条目；F-002–F-012 默认"已修复"。"""
    lines = ['# Findings_Log', '', '字段：', '', '- 来源：A11y_Scan / 视觉评审 / 自动断言',
             '- 状态：由需求 19.8 定义，取值"已修复"或省略', '',
             '## F-001 解压与正文校验', '', '- 来源：自动断言', '']
    skipped = set(omit)
    for fid in dfx.FIXED_FINDINGS:
        if fid in skipped:
            continue
        status = (statuses or {}).get(fid, '已修复（工作区未提交）')
        lines += [f'## {fid} 缺陷 {fid[2:]}', '', '- 来源：自动断言', f'- 状态：{status}', '']
    return '\n'.join(lines)


def package_texts(deps: Optional[Mapping[str, Mapping[str, str]]] = None,
                  resolved: Optional[Mapping[str, str]] = None) -> Tuple[str, str]:
    """(package.json, package-lock.json)：锁文件 `packages[""]` 照抄声明，解析版本默认为去掉 `^` / `~` 的声明。"""
    declared = {section: dict(v) for section, v in (deps or DEPS).items()}
    packages: Dict[str, Any] = {'': {'name': 'novel-reader', **declared}}
    for section in declared.values():
        for name, version in section.items():
            packages[f'node_modules/{name}'] = {'version': (resolved or {}).get(name, version.lstrip('^~'))}
    pkg = {'name': 'novel-reader', 'private': True, **declared}
    lock = {'name': 'novel-reader', 'lockfileVersion': 3, 'requires': True, 'packages': packages}
    return json.dumps(pkg, ensure_ascii=False), json.dumps(lock, ensure_ascii=False)


def passing_inputs() -> Any:
    """一份全部核对项都成立的 `FinalCheckInputs`；每次调用都是新对象，可就地扰动。

    `final-check.json` 中先有任务 19.4 的 `fixture-2`（0–5 分）与 `real-1`（10–20 分），再依次是 Final_Check
    的 7 条命令（30 分起，`e2e` 占 20 分钟）；`start` / `end` 读数分别记于第一条命令之前、最后一条之后。"""
    commands = [command('fixture-2', FIXTURE_ARGV, 0, 5), command('real-1', REAL_ARGV, 10, 20)]
    minute = 30.0
    for cid, argv in dfx.FINAL_CHECK_COMMANDS:
        length = 20 if cid == dfx.E2E_ID else 1
        commands.append(command(cid, argv, minute, minute + length))
        minute += length
    final_check = {'version': 1, 'commands': commands,
                   'readings': {dfx.READING_START: reading(29), dfx.READING_END: reading(minute + 1)}}
    package_json, package_lock = package_texts()
    return dfx.FinalCheckInputs(
        final_check=final_check,
        snapshot=snapshot(),
        results={'fixture-2': results_doc([], STARTED['fixture-2']), 'real-1': results_doc([], STARTED['real-1']),
                 dfx.E2E_ID: e2e_results()},
        review_reports={REVIEW_RUNS[p]: review_report(p) for p in REVIEW_RUNS},
        review_mds={REVIEW_RUNS[p]: f'# Review_Report\n\n- 运行开始时间：{STARTED[REVIEW_RUNS[p]]}\n' for p in REVIEW_RUNS},
        scope=classify(snapshot(), {'src/pages/ReaderPage.tsx': 'reader:fixed'}, readings_now=READINGS),
        baseline_review=baseline_review_text(),
        baseline_files=BASELINE_FILES,
        baselines_ts='export const PIXEL_BASELINES = [/* 13 个定义，没有 knownDefects */];\n',
        review_records={p: review_record_text(p) for p in REVIEW_RUNS},
        findings=findings_text(),
        evidence=(),
        package_json=package_json,
        package_lock=package_lock,
        ev_real_limits=None,
        lock_present=False,
        npmrc=None,
    )


def rec(inputs: Any, cid: str) -> Dict[str, Any]:
    return next(c for c in inputs.final_check['commands'] if c['id'] == cid)


def drop_rec(inputs: Any, cid: str) -> None:
    inputs.final_check['commands'][:] = [c for c in inputs.final_check['commands'] if c['id'] != cid]


def e2e_row(inputs: Any, rid: str) -> Dict[str, Any]:
    return next(r for r in inputs.results[dfx.E2E_ID]['rows'] if r['id'] == rid)


def scan_entries(inputs: Any) -> List[Dict[str, Any]]:
    return inputs.results[dfx.E2E_ID]['sections']['a11y']['data']['entries']


def scan(inputs: Any, name: str) -> Dict[str, Any]:
    return next(e for e in scan_entries(inputs) if e['name'] == name)


def set_packages(inputs: Any, deps: Mapping[str, Mapping[str, str]]) -> None:
    """package.json 与锁文件一起换成 `deps`（两者一致、都是精确版本）。"""
    inputs.package_json, inputs.package_lock = package_texts(deps)


def failing_keys(items: Sequence[Any]) -> Set[str]:
    return {i.key for i in items if not i.ok}


def test_final_check_passes_with_all_items_ok() -> None:
    conclusion, items = dfx.evaluate_final_check(passing_inputs())
    assert [i.key for i in items] == ITEM_KEYS
    assert conclusion == dfx.PASS
    assert {i.key: i.problems for i in items} == {k: [] for k in ITEM_KEYS}
    facts = {i.key: i.facts for i in items}
    assert facts['21.1'] == ['7/7 条命令依次执行并以退出码 0 结束']
    assert facts['21.2'] == ['记录中的 Playwright 运行 3 次（fixture-2、real-1、e2e），执行时间两两不重叠']
    assert facts['14.5'] == ['fixture 预期失败 0、跳过 0；real 预期失败 0、跳过 5（[4.7] 1、[8.13] 4）']
    assert facts['17.2'] == ['接受 13 张，含已知缺陷接受 0 张，重拍 0 张（共 13 行）']
    assert facts['17.5'] == ['fixture（fixture-2）：通过 3、不通过 0、无法判断 0、未拍摄 0',
                             'real（real-1）：通过 6、不通过 0、无法判断 0、未拍摄 1']


Perturb = Callable[[Any], None]

PERTURBATIONS = [
    # 21.1：命令记录
    pytest.param(lambda i: rec(i, 'gate-lint').update(exitCode=1), {'21.1'},
                 ('21.1', 'gate-lint（`npm run lint`）：退出码 1，应为 0'), id='gate-exit-code'),
    pytest.param(lambda i: drop_rec(i, 'gate-pytest'), {'21.1'},
                 ('21.1', 'gate-pytest（`python -m pytest scripts/tests -q`）：没有记录'), id='gate-missing'),
    pytest.param(lambda i: rec(i, 'gate-lint').update(startedAt=at(30.5)), {'21.1'},
                 ('21.1', 'Final_Check 的命令须依次执行'), id='gate-not-sequential'),
    # 21.2：Playwright 独占
    pytest.param(lambda i: rec(i, 'real-1').update(startedAt=at(3)), {'21.2'},
                 ('21.2', f'fixture-2（{at(0)} – {at(5)}）与 real-1（{at(3)} – {at(20)}）的执行时间重叠'),
                 id='playwright-overlap'),
    pytest.param(lambda i: setattr(i, 'lock_present', True), {'21.2'},
                 ('21.2', f'{dfx.LOCK_REL} 仍存在'), id='playwright-lock-left'),
    # 21.3：npm run e2e 的结果
    pytest.param(lambda i: e2e_row(i, 'f-1').update(outcome='failed', errorLine='Error: expected 35.15'), {'21.3'},
                 ('21.3', f'{COMMON_SPEC} › 9.1 进度恢复（fixture）：失败：Error: expected 35.15'), id='e2e-failed'),
    pytest.param(lambda i: e2e_row(i, 'f-1').update(outcome='unexpectedPass', findings=['F-002']), {'21.3'},
                 ('21.3', f'{COMMON_SPEC} › 9.1 进度恢复（fixture）：意外通过（F-002）'), id='e2e-unexpected-pass'),
    pytest.param(lambda i: e2e_row(i, 'f-v').update(outcome='failed'), {'21.3'},
                 ('21.3', 'Visual_Regression_Check 未通过'), id='e2e-visual-failed'),
    pytest.param(lambda i: i.results.update({dfx.E2E_ID: None}), {'21.3', '14.5', '15.1'},
                 ('21.3', '缺失或无法解析'), id='e2e-results-missing'),
    # 14.5：预期失败与跳过
    pytest.param(lambda i: e2e_row(i, 'f-1').update(outcome='skipped', skip={'kind': '16.4', 'reason': '[16.4] 可测性缺口'}),
                 {'14.5'}, ('14.5', 'fixture 的跳过数须为 0'), id='fixture-skip'),
    pytest.param(lambda i: e2e_row(i, 'f-1').update(outcome='expectedFail', findings=['F-002']), {'14.5'},
                 ('14.5', 'fixture 的预期失败数须为 0'), id='fixture-expected-fail'),
    pytest.param(lambda i: e2e_row(i, 'r-813-4').update(skip={'kind': '16.4', 'reason': '[16.4] 可测性缺口'}), {'14.5'},
                 ('14.5', 'real 只允许按 [4.7] / [8.13] 跳过'), id='real-skip-other-kind'),
    # 15.1：A11y_Scan
    pytest.param(lambda i: scan(i, 'a11y-reader')['result'].update(
        violations=[{'id': 'button-name', 'impact': 'critical', 'nodes': 2}]), {'15.1'},
        ('15.1', 'a11y-reader：1 条违规：button-name（critical，2 个节点）'), id='a11y-violation'),
    pytest.param(lambda i: scan_entries(i).pop(), {'15.1'},
                 ('15.1', 'A11y_Scan 节有 30 次扫描，应为 31 次'), id='a11y-only-30-scans'),
    # 21.4：读数
    pytest.param(lambda i: i.final_check['readings'][dfx.READING_END]['values'].update({'booksDir.files': 7680}),
                 {'21.4'}, ('21.4', 'public/books/ 文件数：start 7681，end 7680'), id='readings-differ'),
    # 1.5：改动范围
    pytest.param(lambda i: setattr(i, 'scope', classify(snapshot(), {'.gitignore': 'gitignore:edited'})), {'1.5'},
                 ('1.5', '越界：.gitignore（修改；不在需求 1.1 的允许集合内）'), id='scope-not-ok'),
    # 17.2：基线评审
    pytest.param(lambda i: setattr(i, 'baseline_review', baseline_review_text(
        {BASELINE_FILES[2]: ('含已知缺陷接受', 'F-004')})), {'17.2'},
        ('17.2', f'{BASELINE_FILES[2]}：判为"含已知缺陷接受"，须为"接受"'), id='baseline-known-defect'),
    pytest.param(lambda i: setattr(i, 'baseline_review', baseline_review_text({BASELINE_FILES[0]: ('重拍', '—')})),
                 {'17.2'}, ('17.2', '判为"重拍"'), id='baseline-retake'),
    # 17.5：Review_Record
    pytest.param(lambda i: i.review_records.update(real=review_record_text(
        'real', {'search-highlight#1': ('不通过', 'F-008')})), {'17.5'},
        ('17.5', 'search-highlight#1 判为"不通过"（需求 17.6'), id='review-not-passed'),
    pytest.param(lambda i: i.review_records.update(fixture=review_record_text(
        'fixture', {'load-error#3': ('无法判断', '—')}, pending=[('load-error#3', '截图中文字过小')])), {'17.5'},
        ('17.5', 'fixture：load-error#3（RS-20 新准则（需求 13.6））须恰有 1 个判定且为"通过"，实际 无法判断'),
        id='review-mandatory-undecided'),
    # 18.2：Findings_Log
    pytest.param(lambda i: setattr(i, 'findings', findings_text({'F-007': '待修复'})), {'18.2'},
                 ('18.2', 'F-007：状态为"待修复"，应为"已修复"'), id='finding-not-fixed'),
    pytest.param(lambda i: setattr(i, 'findings', findings_text(omit={'F-012'})), {'18.2'},
                 ('18.2', 'F-012：不在'), id='finding-missing'),
    # 19.1：npm audit（退出码也是 21.1 的一条）
    pytest.param(lambda i: rec(i, dfx.AUDIT_ID).update(exitCode=1), {'21.1', '19.1'},
                 ('19.1', 'npm audit 退出码 1：报告了漏洞或未能完成'), id='audit-exit-code'),
    pytest.param(lambda i: setattr(i, 'npmrc', 'audit-level=critical\n'), {'19.1'},
                 ('19.1', '设置了 audit-level'), id='audit-level-in-npmrc'),
    # 19.2、19.3：依赖
    pytest.param(lambda i: setattr(i, 'package_json', package_texts(
        {**DEPS, 'dependencies': {**DEPS['dependencies'], 'react': '^19.1.0'}})[0]), {'19.2'},
        ('19.2', "dependencies › react：版本 '^19.1.0' 不是\"主.次.修订\"三段纯数字"), id='dependency-caret'),
    pytest.param(lambda i: setattr(i, 'package_lock', package_texts(resolved={'vite': '6.3.6'})[1]), {'19.2'},
                 ('19.2', 'devDependencies › vite：锁文件解析出的版本（packages["node_modules/vite"].version）为 6.3.6，'
                          'package.json 为 6.3.5'), id='dependency-lock-mismatch'),
    pytest.param(lambda i: set_packages(i, {**DEPS, 'devDependencies': {**DEPS['devDependencies'],
                                                                         '@playwright/test': '1.63.0'}}), {'19.3'},
                 ('19.3', '@playwright/test：package.json 为 1.63.0，锁文件解析为 1.63.0，应均为 1.62.1'),
                 id='playwright-version'),
]


@pytest.mark.parametrize('perturb, expected_failing, expected_problem', PERTURBATIONS)
def test_final_check_single_perturbation_fails(perturb: Perturb, expected_failing: Set[str],
                                               expected_problem: Tuple[str, str]) -> None:
    inputs = passing_inputs()
    perturb(inputs)
    conclusion, items = dfx.evaluate_final_check(inputs)
    assert conclusion == dfx.FAIL
    assert failing_keys(items) == expected_failing
    key, text = expected_problem
    problems = next(i.problems for i in items if i.key == key)
    assert any(text in p for p in problems), problems


def test_final_check_mandatory_criterion_reported_alone() -> None:
    """点名准则为"无法判断"（已列入待人工复核）时，17.5 只因 17.5 的点名规则不成立，没有别的问题。"""
    inputs = passing_inputs()
    inputs.review_records['fixture'] = review_record_text(
        'fixture', {'load-error#3': ('无法判断', '—')}, pending=[('load-error#3', '截图中文字过小')])
    item = dfx.check_review_records(inputs, {str(f['id']) for f in dfx.parse_finding_statuses(inputs.findings)})
    assert item.problems == ['fixture：load-error#3（RS-20 新准则（需求 13.6））须恰有 1 个判定且为"通过"，实际 无法判断']


def test_check_playwright_exclusive_touching_spans_and_unlocked_runs() -> None:
    fc = {'commands': [command('fixture-1', FIXTURE_ARGV, 0, 5), command('fixture-2', FIXTURE_ARGV, 5, 10)]}
    assert dfx.check_playwright_exclusive(fc, lock_present=False).ok  # 首尾相接不算重叠
    # 不经锁执行（playwright 为 false）的 Playwright 命令同样列出
    fc['commands'][1]['playwright'] = False
    item = dfx.check_playwright_exclusive(fc, lock_present=False)
    assert item.problems == ['fixture-2（`npm run e2e:profile -- --profile fixture`）会启动 Playwright，'
                             '记录中却不是持锁执行的（playwright 为 false）']


def test_check_dependencies_reads_rows_against_lock() -> None:
    pkg, lock = package_texts({**DEPS, 'dependencies': {'react': '~19.1.0', 'react-dom': '19.1.0'}})
    item_192, item_193 = dfx.check_dependencies(pkg, lock)
    assert item_192.problems == [
        "dependencies › react：版本 '~19.1.0' 不是\"主.次.修订\"三段纯数字",
        'dependencies › react：锁文件解析出的版本（packages["node_modules/react"].version）为 19.1.0，'
        'package.json 为 ~19.1.0',
    ]
    assert item_192.facts == ['3/4 个直接依赖一致']
    assert item_193.ok and item_193.facts == ['package.json 1.62.1，锁文件 1.62.1']
    # 锁文件缺失：两项都不成立
    missing_192, missing_193 = dfx.check_dependencies(pkg, None)
    assert missing_192.problems == ['package-lock.json 不存在'] and missing_193.problems == ['package-lock.json 不存在']


def test_check_scope_item_without_scope() -> None:
    item = dfx.check_scope_item(None, 'Start_Snapshot 不存在')
    assert item.problems == ['无法核对：Start_Snapshot 不存在']


# ---------------------------------------------------------------------------
# render_acceptance：结论一节（任务 21.2；需求 21.6）
# ---------------------------------------------------------------------------


def test_render_acceptance_conclusion_lists_failing_items() -> None:
    inputs = passing_inputs()
    conclusion, items = dfx.evaluate_final_check(inputs)
    text = dfx.render_acceptance(inputs, conclusion, items, at(60))
    assert '## 1. 结论\n\n**通过**\n' in text
    assert '不成立的条目' not in text
    assert [line.split('.')[0] for line in text.splitlines() if re.match(r'## \d+\. ', line)] == \
        [f'## {n}' for n in range(1, 12)]

    rec(inputs, 'gate-lint')['exitCode'] = 1
    inputs.findings = findings_text({'F-007': '待修复'})
    conclusion, items = dfx.evaluate_final_check(inputs)
    text = dfx.render_acceptance(inputs, conclusion, items, at(60))
    lines = text.splitlines()
    assert conclusion == dfx.FAIL and '## 1. 结论\n\n**不通过**\n' in text
    by_key = {i.key: i for i in items}
    row_21_1 = next(line for line in lines if line.startswith('| 21.1 | '))
    assert f'| {dfx.FAIL} | 6/7 条命令依次执行并以退出码 0 结束 |' in row_21_1
    assert next(line for line in lines if line.startswith('| 19.1 | ')).endswith(f'| {dfx.PASS} | 退出码 0 |')
    start = lines.index('不成立的条目（2 项）及其读数：')
    assert lines[start + 2:start + 6] == [
        f'- 21.1 {by_key["21.1"].title}：',
        '  - gate-lint（`npm run lint`）：退出码 1，应为 0',
        f'- 18.2 {by_key["18.2"].title}：',
        '  - F-007：状态为"待修复"，应为"已修复"',
    ]


# ---------------------------------------------------------------------------
# parse_finding_statuses（任务 21.2）
# ---------------------------------------------------------------------------


def test_parse_finding_statuses_ignores_preamble_status_line() -> None:
    text = '\n'.join([
        '# Findings_Log',
        '',
        '- 状态：由需求 19.8 定义，取值"已修复"',  # 文件开头的字段说明：不属于任何条目
        '',
        '## F-002 滚动容器',
        '- 来源：自动断言',
        '  - 状态：嵌套的列表项不算',
        '- 状态：已修复（工作区未提交）',
        '- 状态：第二个状态行不覆盖第一个',
        '',
        '## 附：字段说明',
        '- 状态：不在 F-xxx 标题下，不计入',
        '',
        '## F-003 滑杆名称与网格',
        '- 来源：A11y_Scan',
    ])
    assert dfx.parse_finding_statuses(text) == [
        {'id': 'F-002', 'title': '滚动容器', 'status': '已修复（工作区未提交）'},
        {'id': 'F-003', 'title': '滑杆名称与网格', 'status': None},
    ]
    # 只有开头说明行、没有条目时：没有任何 Finding，F-002–F-012 都不在其中
    preamble_only = '# Findings_Log\n\n- 状态：由需求 19.8 定义\n'
    assert dfx.parse_finding_statuses(preamble_only) == []
    assert dfx.check_findings(preamble_only).problems[0] == f'F-002：不在 {dfx.FINDINGS_REL} 中'
