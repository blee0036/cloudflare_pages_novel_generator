#!/usr/bin/env python3
"""reader-defect-fixes 的起始快照与收尾工具（需求 1；设计"1. Start_Snapshot 与收尾工具"）。

只用 Python 标准库；`import acceptance` 复用 EV 验收助手的 `take_readings()`（EV 18.6 读数）与
`compare_readings()`，读数口径与 EV 验收一致。子进程一律以参数列表启动，不经 shell；git 输出按 UTF-8
解码（`errors="replace"`），并带 `-c core.quotepath=off`，使非 ASCII 路径原样显示。

命令
----

    python e2e/acceptance/defect_fixes.py snapshot              # 写 Start_Snapshot（需求 1.2、1.6）
    python e2e/acceptance/defect_fixes.py scope [--json <out>]  # 改动范围核对（需求 1.3–1.5）
    python e2e/acceptance/defect_fixes.py run <id> -- <命令…>   # 执行并记录一条命令（需求 17.4、21.1、21.2）
    python e2e/acceptance/defect_fixes.py readings <label>      # 记一次 EV 18.6 读数（需求 21.4）
    python e2e/acceptance/defect_fixes.py compare-runs <id1> <id2>  # 两次运行的结果比较（需求 17.4）
    python e2e/acceptance/defect_fixes.py summary               # 写 acceptance.md（需求 21.5、21.6）

退出码
------

- `snapshot`：0 已写出；2 拒绝写出——F-001 修复涉及的 6 个文件中任一个出现在 `git status --porcelain`
  中（F-001 尚未提交，D14），或 `start-snapshot.json` 已存在（基准只记一次）。
- `scope`：0 通过；1 不通过。
- `run`：命令本身的退出码（被 Ctrl+C 打断为 130，无法启动为 1）；2 拒绝执行——`final-check.json` 中已有
  同一 id（每个 id 只记一次），或 Playwright 命令遇到 `e2e/.out/playwright.lock` 已存在。拒绝时不执行、
  不记录。
- `readings`：0 已记录；2 拒绝——该 label 已记过（每个 label 只记一次）。
- `compare-runs`：0 一致；1 不一致或结果文件缺失。
- `summary`：0 结论为"通过"；1 结论为"不通过"（`acceptance.md` 照样写出）。
- 其余可预期的错误（git 失败、Start_Snapshot 缺失或无法解析、`final-check.json` 无法解析、找不到可执行
  文件）：1；用法错误：2（argparse）。

Final_Check 记录（`.kiro/specs/reader-defect-fixes/final-check.json`，设计 Data Models）
------------------------------------------------------------------------------------

    {"commands": [{"id": "fixture-1", "argv": ["npm", "run", "e2e:profile", "--", "--profile", "fixture"],
                   "startedAt": "<本机时间，带 UTC 偏移>", "endedAt": "…", "durationSec": 95.3,
                   "exitCode": 0, "playwright": true,
                   "results": ".kiro/specs/reader-defect-fixes/final-check/fixture-1-results.json",
                   "artifacts": ["…/fixture-1-summary.md", "…/fixture-1-review/"], "notes": []}],
     "readings": {"<label>": <acceptance.take_readings() 的结果>}}

- `run` 在命令结束后才追加记录（先重新读取文件，保留其间写入的其他记录）；文件不存在时创建，无法解析时
  报错退出、不改写。
- Playwright 命令（`is_playwright_command`：`npm run e2e` / `e2e:profile` / `e2e:update`、`npx
  playwright …`、`npm exec playwright …`、`node e2e/run.mjs …`、`node …playwright…`、`playwright …`）
  执行前以独占方式创建 `e2e/.out/playwright.lock`（内容为 id、pid、开始时间与命令），已存在即拒绝；
  命令结束、产物复制完之后删除。进程被强行结束而遗留的锁须人工确认没有 Playwright 进程后删除。
- Playwright 命令结束后，把本次运行写出的（修改时间不早于命令开始的）`e2e/.out/results.json` 复制为
  `final-check/<id>-results.json`（记入 `results`；不是本次写出的不复制，`results` 为 null 并记入
  `notes`），另把 `summary.md` 与 `review/` 目录复制为 `<id>-summary.md`、`<id>-review/`（记入
  `artifacts`）：后续的 `real` 运行会清空 `e2e/.out/review/`，评审 fixture 的 Review_Shot 用这份副本。
- `id` 用作文件名：只允许字母、数字、`.`、`_`、`-`，以字母或数字开头。

两次运行的比较（`compare-runs`，纯函数 `compare_runs`）
------------------------------------------------------

读 `final-check/<id1>-results.json` 与 `final-check/<id2>-results.json`：两份的用例 id 集合相同；同一
用例两次的 outcome 相同；两份各至少有一行 `visual.spec`，且每行都是通过（EV 6.6）。

Final_Check（任务 21.3）与验收小结（`summary`，纯函数 `evaluate_final_check`、`render_acceptance`）
------------------------------------------------------------------------------------------------

Final_Check 按以下顺序执行（`FINAL_CHECK_COMMANDS`；`summary` 只认这 7 个 id，`final-check.json` 中的其他
记录如任务 19.4 的 `fixture-1`、`fixture-2`、`real-1` 不属于该命令集）：

    python e2e/acceptance/defect_fixes.py readings start
    python e2e/acceptance/defect_fixes.py run gate-typecheck -- npm run typecheck
    python e2e/acceptance/defect_fixes.py run gate-lint -- npm run lint
    python e2e/acceptance/defect_fixes.py run gate-build -- npm run build
    python e2e/acceptance/defect_fixes.py run gate-test -- npm run test
    python e2e/acceptance/defect_fixes.py run gate-pytest -- python -m pytest scripts/tests -q
    python e2e/acceptance/defect_fixes.py run audit -- npm audit
    python e2e/acceptance/defect_fixes.py run e2e -- npm run e2e
    python e2e/acceptance/defect_fixes.py readings end
    python e2e/acceptance/defect_fixes.py scope
    python e2e/acceptance/defect_fixes.py summary

`summary` 读 `final-check.json`、各记录的结果与 Review_Report 副本、Start_Snapshot、`baseline-review.md`、
两份 Review_Record、EV 的 Findings_Log 与 `acceptance/run-8.json`、`package.json` 与锁文件，逐项核对（任一项
不成立即"不通过"，并在 acceptance.md 第 1 节逐项列出读数）：

- 21.1：7 条命令各有记录、命令与上表相同、按顺序依次执行（每条在上一条结束后开始）、退出码均为 0。
- 21.2：记录中的全部 Playwright 运行（含任务 19.4 的三次）执行时间两两不重叠，`playwright.lock` 已释放。
- 21.3：`e2e` 的结果副本中 fixture、real、tooling 都已运行，无中止、无运行级失败，失败 / 意外通过 / 未执行
  均为 0，`visual.spec` 全部通过；14.5：fixture 的预期失败与跳过为 0，real 的预期失败为 0、跳过与 EV 阶段 8
  的 5 个 [4.7] / [8.13] 数据限制逐条相同；15.1：A11y_Scan 一节（reporter 写入 `results.json` 的
  `sections.a11y.data`）恰有 31 次扫描，全部完成且 0 条违规。
- 21.4：`start` 记于第一条命令开始之前、`end` 记于最后一条命令结束之后，两次读数与 Start_Snapshot 逐项一致。
- 1.5：`scope` 的核对（`collect_scope`）通过。
- 17.2：`baseline-review.md` 按 EV 18.2 逐张记录 `e2e/baselines/` 的 13 张 PNG，全部"接受"。
- 17.5：两份 Review_Record 按开头的运行开始时间匹配被评审运行的副本，按 EV 13.6 通过核对；没有"不通过"；
  `MANDATORY_CRITERIA` 为"通过"；未拍摄的只有按 [4.7] / [8.13] 跳过的数据限制（如 RS-18）。"无法判断"
  列入人工核对清单，不影响结论（EV 13.8）。
- 18.2：Findings_Log 中 F-002–F-012 每条 `## F-xxx` 标题下的"状态"为"已修复"（文件开头说明字段写法的
  `- 状态：` 一行不属于任何条目）。
- 19.1：`audit` 退出码 0。`npm audit` 没有漏洞时以 0 结束、有任何级别的漏洞时以非 0 结束；`summary` 不运行
  npm，只依据记录的退出码（仓库根 `.npmrc` 设置了 `audit-level` 时判不成立）。
- 19.2：`dependencies` 与 `devDependencies` 的版本都是"主.次.修订"，与锁文件 `packages[""]` 及
  `packages["node_modules/<名称>"].version` 相同；19.3：`@playwright/test` 为 1.62.1。

人工核对清单（不影响结论）：`a11y-shelf` 与 4 次 `a11y-contrast-shelf-<主题键>` 的 `color-contrast`
incomplete 节点数与示例选择器（D13），Review_Record 的待人工复核条目，以及 real 按 [4.7] / [8.13] 跳过的数据
限制。

Start_Snapshot（`.kiro/specs/reader-defect-fixes/start-snapshot.json`，设计 Data Models）
------------------------------------------------------------------------------------------

    {"head": "<git rev-parse HEAD>", "takenAt": "<本机时间，带 UTC 偏移>",
     "porcelain": "<git status --porcelain 全文>",
     "files": {"<相对路径>": "<SHA-256 十六进制> | null"},
     "readings": <acceptance.take_readings() 的结果>}

`files` 的路径取自 `git status --porcelain -z --untracked-files=all --no-renames`：未被 gitignore 的未
跟踪文件逐个展开，改名拆成删除与新增。值为工作区文件字节的 SHA-256；文件已删除（或不是普通文件）时为
null。

改动范围（`scope`，纯函数 `classify_changes`）
--------------------------------------------

1. 候选路径 = `git diff --name-only <head>` ∪ `git ls-files --others --exclude-standard` ∪ `files` 的键。
2. 起始状态：在 `files` 中取记下的哈希；否则取 `<head>:<路径>` 的 blob 字节的哈希（不存在为缺失）。当前
   状态取工作区文件的哈希或缺失。两者不同即为变化（新增 / 修改 / 删除）。
3. 每个变化路径按需求 1.1 的允许集合匹配（`ALLOWED_PREFIXES`、`ALLOWED_FILES`；F-001 的 6 个文件除外）。
4. 另判：`HEAD` 等于 `head`（1.4）；F-001 的 6 个文件当前哈希等于起始状态（1.3）；`public/`、
   `zip-novel/`、`scripts/`、`index.html`、`.preprocess-manifest.json` 没有变化路径，且 EV 18.6 读数与
   Start_Snapshot 一致（1.4；被 gitignore 的 `public/books/`、`public/data/` 与清单文件由读数覆盖）。
5. (d) 类路径（`vite.config.ts` 等配置文件与 `build/` 下的文件）未在设计"改动文件清单"的 (d) 行中登记
   时，标"需在设计文档中说明"并判不通过。登记集合由 `registered_d_entries` 从 `design.md` 读出。

被 gitignore 的路径（含整个 `.kiro/`）不在候选路径中：(e)、(f) 两类只会出现在被忽略的目录里。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Mapping, NamedTuple, Optional, Sequence, Set, Tuple

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    # 以路径加载本文件（pytest、importlib）时，同目录的 acceptance.py 也要能 `import`。
    sys.path.insert(0, str(HERE))

import acceptance  # noqa: E402  （须在 sys.path 补上本目录之后）

AcceptanceError = acceptance.AcceptanceError

# ---------------------------------------------------------------------------
# 路径与集合（需求 1.1、1.3、1.4）
# ---------------------------------------------------------------------------

REPO_ROOT = HERE.parent.parent
SPEC_REL = '.kiro/specs/reader-defect-fixes'
SNAPSHOT_REL = f'{SPEC_REL}/start-snapshot.json'
DESIGN_REL = f'{SPEC_REL}/design.md'
FINAL_CHECK_REL = f'{SPEC_REL}/final-check.json'
FINAL_CHECK_DIR_REL = f'{SPEC_REL}/final-check'

#: E2E 运行的产物与 Playwright 进程锁（需求 21.2）。
OUT_REL = 'e2e/.out'
LOCK_REL = f'{OUT_REL}/playwright.lock'
OUT_RESULTS_REL = f'{OUT_REL}/results.json'
OUT_SUMMARY_REL = f'{OUT_REL}/summary.md'
OUT_REVIEW_REL = f'{OUT_REL}/review'

SELF = 'python e2e/acceptance/defect_fixes.py'

#: F-001 修复涉及的 6 个文件（需求 1.3、1.6）。
F001_FILES: Tuple[str, ...] = (
    'src/utils/decompress.ts',
    'src/utils/loadMetrics.ts',
    'src/utils/loadMetrics.test.ts',
    'src/utils/bookTextCheck.ts',
    'src/utils/bookTextCheck.test.ts',
    'src/utils/bookLoader.test.ts',
)

#: 需求 1.1 的允许集合（设计第 1 节算法第 3 步）：前缀与类别。
ALLOWED_PREFIXES: Tuple[Tuple[str, str], ...] = (
    ('src/', '(a)'),
    ('e2e/', '(b)'),
    ('build/', '(d)'),
    ('.kiro/specs/reader-defect-fixes/', '(e)'),
    ('.kiro/specs/e2e-visual-testing/findings/', '(f)'),
)

#: 需求 1.1 的允许集合：精确路径与类别。
ALLOWED_FILES: Dict[str, str] = {
    'package.json': '(c)',
    'package-lock.json': '(c)',
    'README.md': '(c)',
    'vite.config.ts': '(d)',
    'vitest.config.ts': '(d)',
    'playwright.config.ts': '(d)',
    'tsconfig.json': '(d)',
    'eslint.config.js': '(d)',
    '.kiro/specs/e2e-visual-testing/findings.md': '(f)',
    '.kiro/specs/e2e-visual-testing/tasks.md': '(f)',
    '.kiro/specs/e2e-visual-testing/design.md': '(f)',
}

#: 需求 1.4 的受保护路径。
PROTECTED_PREFIXES: Tuple[str, ...] = ('public/', 'zip-novel/', 'scripts/')
PROTECTED_FILES: Tuple[str, ...] = ('index.html', '.preprocess-manifest.json')
PROTECTED_LABEL = 'public/、zip-novel/、scripts/、index.html、.preprocess-manifest.json'

KIND_LABELS = {'added': '新增', 'modified': '修改', 'deleted': '删除'}

#: 设计文档中"改动文件清单"一节的标题。
DESIGN_SECTION = '## 改动文件清单'


def allowed_category(path: str) -> Optional[str]:
    """路径落在需求 1.1 允许集合的哪一类（`(a)`–`(f)`）；不在时为 None。F-001 的 6 个文件不在其中。"""
    if path in F001_FILES:
        return None
    if path in ALLOWED_FILES:
        return ALLOWED_FILES[path]
    for prefix, category in ALLOWED_PREFIXES:
        if path.startswith(prefix):
            return category
    return None


def is_protected(path: str) -> bool:
    return path in PROTECTED_FILES or path.startswith(PROTECTED_PREFIXES)


def is_d_category(path: str) -> bool:
    return ALLOWED_FILES.get(path) == '(d)' or path.startswith('build/')


def registered_d_entries(design_text: Optional[str]) -> Set[str]:
    """设计"改动文件清单"中 (d) 行登记的文件（精确路径；`build/*` 记为前缀 `build/`）。

    只读该节表格中首格为 `(d)` 的行；文件格含"预计不改"的行是"预计不改的文件"，不算登记。文件格中
    第一个全角冒号之前的反引号片段为文件名，冒号之后是说明（其中的 `exclude` 等不是文件）。"""
    out: Set[str] = set()
    if not design_text:
        return out
    in_section = False
    for line in design_text.splitlines():
        if line.startswith('## '):
            in_section = line.strip() == DESIGN_SECTION
            continue
        stripped = line.strip()
        if not in_section or not stripped.startswith('|'):
            continue
        cells = [c.strip() for c in stripped.strip('|').split('|')]
        if len(cells) < 2 or cells[0] != '(d)' or '预计不改' in cells[1]:
            continue
        for token in re.findall(r'`([^`]+)`', cells[1].split('：', 1)[0]):
            entry = token[:-1] if token.endswith('/*') else token
            if is_d_category(entry):
                out.add(entry)
    return out


def is_registered(path: str, entries: Iterable[str]) -> bool:
    return any(path == e or (e.endswith('/') and path.startswith(e)) for e in entries)


# ---------------------------------------------------------------------------
# 改动范围核对（纯函数；需求 1.3–1.5）
# ---------------------------------------------------------------------------

HashFn = Callable[[str], Optional[str]]


def classify_changes(snapshot: Mapping[str, Any], head_now: str, tracked_diff: Iterable[str],
                     untracked: Iterable[str], hash_of: HashFn, hash_at_head: HashFn, *,
                     registered_d: Iterable[str] = (),
                     readings_now: Optional[Mapping[str, Any]] = None) -> Dict[str, Any]:
    """按设计第 1 节的算法列出变化路径并逐一判定。

    - `snapshot`：Start_Snapshot 的内容（用到 `head`、`files`，给出 `readings_now` 时还用 `readings`）。
    - `head_now`：当前 `git rev-parse HEAD`。
    - `tracked_diff`：`git diff --name-only <snapshot.head>`；`untracked`：`git ls-files --others
      --exclude-standard`。
    - `hash_of(path)`：工作区文件的 SHA-256，缺失为 None；`hash_at_head(path)`：`<snapshot.head>:<path>`
      的 SHA-256，不存在为 None。
    - `registered_d`：设计"改动文件清单"(d) 行登记的条目（见 `registered_d_entries`）。
    - `readings_now`：当前的 `take_readings()`；为 None 时不比较读数。

    返回值的 `ok` 为真当且仅当 `problems` 为空。"""
    base = str(snapshot.get('head') or '')
    raw_files = snapshot.get('files')
    recorded: Mapping[str, Optional[str]] = raw_files if isinstance(raw_files, Mapping) else {}
    registered = sorted(set(registered_d))

    def start_of(path: str) -> Optional[str]:
        return recorded[path] if path in recorded else hash_at_head(path)

    candidates = sorted({p for p in (*tracked_diff, *untracked, *recorded.keys()) if p})
    changes: List[Dict[str, Any]] = []
    for path in candidates:
        start, current = start_of(path), hash_of(path)
        if start == current:
            continue
        kind = 'added' if start is None else 'deleted' if current is None else 'modified'
        category = allowed_category(path)
        changes.append({
            'path': path,
            'kind': kind,
            'start': start,
            'current': current,
            'category': category,
            'allowed': category is not None,
            'protected': is_protected(path),
            'f001': path in F001_FILES,
            'undocumentedD': category == '(d)' and not is_registered(path, registered),
        })

    f001 = []
    for path in F001_FILES:
        expected, current = start_of(path), hash_of(path)
        f001.append({'path': path, 'expected': expected, 'current': current, 'ok': expected == current})

    head_unchanged = bool(base) and head_now == base
    violations = [c['path'] for c in changes if not c['allowed'] and not c['protected'] and not c['f001']]
    protected = [c['path'] for c in changes if c['protected']]
    undocumented = [c['path'] for c in changes if c['undocumentedD']]

    reading_diffs: Optional[List[Dict[str, Any]]] = None
    if readings_now is not None:
        before = snapshot.get('readings')
        diffs = acceptance.compare_readings(before if isinstance(before, Mapping) else {}, readings_now)
        reading_diffs = [d._asdict() for d in diffs]

    problems: List[str] = []
    if not head_unchanged:
        problems.append(f'HEAD 为 {head_now or "（无）"}，与 Start_Snapshot 记下的 {base or "（无）"} 不同（需求 1.4）')
    for f in f001:
        if not f['ok']:
            problems.append(f'F-001 文件的 SHA-256 有变化：{f["path"]}（需求 1.3）')
    for c in changes:
        label = KIND_LABELS[c['kind']]
        if c['protected']:
            problems.append(f'受保护路径有变化：{c["path"]}（{label}；需求 1.4）')
        elif not c['allowed'] and not c['f001']:
            problems.append(f'越界：{c["path"]}（{label}；不在需求 1.1 的允许集合内）')
        elif c['undocumentedD']:
            problems.append(f'需在设计文档中说明：{c["path"]}（{label}；(d) 类，未在设计"改动文件清单"中登记）')
    for d in reading_diffs or ():
        problems.append(f'EV 18.6 读数不一致：{d["label"]}：{acceptance.reading_text(d["before"])} → '
                        f'{acceptance.reading_text(d["after"])}（需求 1.4）')

    return {
        'base': base,
        'headNow': head_now,
        'headUnchanged': head_unchanged,
        'changes': changes,
        'violations': violations,
        'protected': protected,
        'undocumentedD': undocumented,
        'registeredD': registered,
        'f001': f001,
        'readingDiffs': reading_diffs,
        'problems': problems,
        'ok': not problems,
    }


# ---------------------------------------------------------------------------
# git 与文件
# ---------------------------------------------------------------------------


def _git_exe() -> str:
    exe = shutil.which('git')
    if exe is None:
        raise AcceptanceError('找不到 git')
    return exe


def git_bytes(root: Path, *args: str) -> bytes:
    proc = subprocess.run([_git_exe(), '-c', 'core.quotepath=off', *args], cwd=root,
                          stdin=subprocess.DEVNULL, capture_output=True)
    if proc.returncode != 0:
        err = proc.stderr.decode('utf-8', errors='replace').strip().splitlines()
        raise AcceptanceError(f'git {" ".join(args)} 以退出码 {proc.returncode} 结束：{err[0] if err else "（无输出）"}')
    return proc.stdout


def git_text(root: Path, *args: str) -> str:
    return git_bytes(root, *args).decode('utf-8', errors='replace')


def git_blob(root: Path, rev: str, path: str) -> Optional[bytes]:
    """`<rev>:<path>` 的 blob 原始字节（不做行尾或 textconv 转换）；不存在时为 None。"""
    proc = subprocess.run([_git_exe(), 'cat-file', 'blob', f'{rev}:{path}'], cwd=root,
                          stdin=subprocess.DEVNULL, capture_output=True)
    return proc.stdout if proc.returncode == 0 else None


def sha256_bytes(data: Optional[bytes]) -> Optional[str]:
    return None if data is None else hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> Optional[str]:
    """工作区文件字节的 SHA-256；不存在或不是普通文件时为 None。"""
    try:
        if not path.is_file():
            return None
        return sha256_bytes(path.read_bytes())
    except OSError:
        return None


def split_z(text: str) -> List[str]:
    return [p for p in text.split('\0') if p]


def parse_porcelain_z(text: str) -> List[Tuple[str, str]]:
    """`git status --porcelain -z` → [(XY 状态码, 路径)]。改名 / 复制项的原路径（下一个字段）一并列出。"""
    out: List[Tuple[str, str]] = []
    fields = text.split('\0')
    i = 0
    while i < len(fields):
        entry = fields[i]
        i += 1
        if len(entry) < 4:
            continue
        code, path = entry[:2], entry[3:]
        out.append((code, path))
        if 'R' in code or 'C' in code:
            if i < len(fields) and fields[i]:
                out.append((code, fields[i]))
            i += 1
    return out


def display_path(path: Path, root: Path) -> str:
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return str(path)


# ---------------------------------------------------------------------------
# snapshot（需求 1.2、1.6）
# ---------------------------------------------------------------------------


def collect_snapshot(root: Path) -> Tuple[List[Tuple[str, str]], Optional[Dict[str, Any]]]:
    """返回 (F-001 文件在 porcelain 中的条目, Start_Snapshot 内容)。前者非空时后者为 None。"""
    porcelain = git_text(root, 'status', '--porcelain')
    entries = parse_porcelain_z(git_text(root, 'status', '--porcelain', '-z', '--untracked-files=all',
                                         '--no-renames'))
    blocked = [(code, path) for code, path in entries if path in F001_FILES]
    if blocked:
        return blocked, None
    head = git_text(root, 'rev-parse', 'HEAD').strip()
    files = {path: sha256_file(root / path) for path in sorted({p for _, p in entries})}
    return [], {
        'head': head,
        'takenAt': acceptance.iso(acceptance.now_local()),
        'porcelain': porcelain,
        'files': files,
        'readings': acceptance.take_readings(root),
    }


def cmd_snapshot(root: Path = REPO_ROOT, out: Optional[Path] = None) -> int:
    target = out if out is not None else root / SNAPSHOT_REL
    shown = display_path(target, root)
    if target.exists():
        print(f'{shown} 已存在：Start_Snapshot 只记一次，未改写（需求 1.2）。')
        return 2
    blocked, payload = collect_snapshot(root)
    if payload is None:
        print('F-001 修复涉及的文件仍出现在 git status --porcelain 中（F-001 尚未提交，D14），'
              '未写出 Start_Snapshot（需求 1.6）：')
        for code, path in blocked:
            print(f'  {code} {path}')
        print('请先单独提交 F-001 的修复，再执行本命令；本 spec 的实施任务在 Start_Snapshot 写出之前不开始。')
        return 2
    acceptance.write_json(target, payload)
    print(f'Start_Snapshot 已写入 {shown}（{payload["takenAt"]}）')
    print(f'  HEAD：{payload["head"]}')
    print(f'  git status --porcelain：{len(payload["files"])} 个文件'
          + ('' if payload['files'] else '（工作区干净）'))
    for path, digest in payload['files'].items():
        print(f'    {path}：{acceptance.short(digest)}')
    values = payload['readings']['values']
    for key, label in acceptance.READING_KEYS:
        print(f'  {label}：{acceptance.reading_text(values.get(key))}')
    return 0


# ---------------------------------------------------------------------------
# scope（需求 1.3–1.5）
# ---------------------------------------------------------------------------

_COMMIT = re.compile(r'[0-9a-f]{40}(?:[0-9a-f]{24})?')


def load_snapshot(root: Path) -> Dict[str, Any]:
    data = acceptance.load_json(root / SNAPSHOT_REL)
    if not isinstance(data, dict):
        raise AcceptanceError(f'{SNAPSHOT_REL} 缺失或无法解析；先执行 {SELF} snapshot')
    if not isinstance(data.get('head'), str) or not _COMMIT.fullmatch(data['head']):
        raise AcceptanceError(f'{SNAPSHOT_REL} 的 head 不是提交哈希')
    if not isinstance(data.get('files'), dict):
        raise AcceptanceError(f'{SNAPSHOT_REL} 缺少 files')
    return data


def collect_scope(root: Path, snapshot: Mapping[str, Any]) -> Dict[str, Any]:
    base = str(snapshot['head'])
    git_bytes(root, 'cat-file', '-e', f'{base}^{{commit}}')
    head_now = git_text(root, 'rev-parse', 'HEAD').strip()
    diff = split_z(git_text(root, 'diff', '--name-only', '--no-renames', '-z', base))
    untracked = split_z(git_text(root, 'ls-files', '--others', '--exclude-standard', '-z'))
    registered = registered_d_entries(acceptance.read_text(root / DESIGN_REL))
    return classify_changes(
        snapshot, head_now, diff, untracked,
        hash_of=lambda p: sha256_file(root / p),
        hash_at_head=lambda p: sha256_bytes(git_blob(root, base, p)),
        registered_d=registered,
        readings_now=acceptance.take_readings(root),
    )


def scope_verdict(c: Mapping[str, Any]) -> str:
    """一个变化路径的判定写法（`scope` 的打印与 `summary` 的改动范围一节共用）。"""
    if c['protected']:
        return '受保护路径'
    if c['f001']:
        return 'F-001 文件'
    if not c['allowed']:
        return '越界'
    if c['undocumentedD']:
        return f'{c["category"]}，需在设计文档中说明'
    return f'允许 {c["category"]}'


def print_scope(result: Mapping[str, Any], snapshot: Mapping[str, Any]) -> None:
    print(f'Start_Snapshot：{result["base"]}（{snapshot.get("takenAt", "—")}）')
    print(f'HEAD：{result["headNow"]}（{"与 Start_Snapshot 相同" if result["headUnchanged"] else "已变化"}）')
    changes = result['changes']
    print(f'变化路径 {len(changes)} 个：')
    for c in changes:
        print(f'  [{KIND_LABELS[c["kind"]]}] {c["path"]} — {scope_verdict(c)}')
    bad_f001 = [f['path'] for f in result['f001'] if not f['ok']]
    print('F-001 的 6 个文件：' + ('SHA-256 与起始状态相同' if not bad_f001 else '有变化：' + '、'.join(bad_f001)))
    print(f'受保护路径（{PROTECTED_LABEL}）：' + ('无变化' if not result['protected'] else '有变化'))
    diffs = result['readingDiffs']
    if diffs is not None:
        print('EV 18.6 读数：' + ('与 Start_Snapshot 一致' if not diffs else f'{len(diffs)} 项不一致'))
    print('设计"改动文件清单"(d) 行登记：' + ('、'.join(result['registeredD']) or '（无）'))
    print(f'结论：{"通过" if result["ok"] else "不通过"}')
    for p in result['problems']:
        print(f'  - {p}')


def cmd_scope(root: Path = REPO_ROOT, json_out: Optional[str] = None) -> int:
    snapshot = load_snapshot(root)
    result = collect_scope(root, snapshot)
    print_scope(result, snapshot)
    if json_out:
        path = Path(json_out)
        if not path.is_absolute():
            path = Path.cwd() / path
        acceptance.write_json(path, result)
        print(f'核对结果已写入 {display_path(path, root)}')
    return 0 if result['ok'] else 1


# ---------------------------------------------------------------------------
# final-check.json（需求 21.1、21.4）
# ---------------------------------------------------------------------------

#: `run` 的 id 与 `readings` 的 label：id 还用作 `final-check/` 下的文件名。
_RUN_ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]*')

EXIT_INTERRUPTED = 130


def load_final_check(root: Path) -> Dict[str, Any]:
    """读 `final-check.json`；不存在时为空记录。无法解析时报错，不让后续写入覆盖它。"""
    path = root / FINAL_CHECK_REL
    if not path.exists():
        return {'commands': [], 'readings': {}}
    data = acceptance.load_json(path)
    if (not isinstance(data, dict) or not isinstance(data.get('commands', []), list)
            or not isinstance(data.get('readings', {}), dict)):
        raise AcceptanceError(f'{FINAL_CHECK_REL} 无法解析或结构不对（应为 {{"commands": [...], "readings": {{...}}}}），'
                              '请检查后再执行；本次未改写它')
    data.setdefault('commands', [])
    data.setdefault('readings', {})
    return data


def save_final_check(root: Path, data: Mapping[str, Any]) -> None:
    acceptance.write_json(root / FINAL_CHECK_REL, data)


def results_rel(run_id: str) -> str:
    return f'{FINAL_CHECK_DIR_REL}/{run_id}-results.json'


# ---------------------------------------------------------------------------
# run（需求 17.4、21.1、21.2）
# ---------------------------------------------------------------------------

#: 启动 Playwright 的 npm 脚本（package.json；`e2e:install` 只下载浏览器，不算）。
PLAYWRIGHT_NPM_SCRIPTS = frozenset({'e2e', 'e2e:profile', 'e2e:update'})
_EXE_SUFFIXES = ('.cmd', '.exe', '.bat', '.ps1')


def program_name(arg: str) -> str:
    """`C:\\…\\npm.cmd` → `npm`：去掉目录与 Windows 的可执行文件后缀，转小写。"""
    name = re.split(r'[\\/]', arg)[-1].lower()
    for suffix in _EXE_SUFFIXES:
        if name.endswith(suffix):
            return name[:-len(suffix)]
    return name


def _operands(args: Sequence[str]) -> List[str]:
    """不以 `-` 开头的参数（npm / npx / node 的选项与 `--` 都去掉）。"""
    return [a for a in args if not a.startswith('-')]


def is_playwright_command(argv: Sequence[str]) -> bool:
    """命令是否会启动 Playwright 进程（需求 21.2 的四种写法，另含 `npm exec` 与直接调用 CLI）。"""
    if not argv:
        return False
    prog = program_name(argv[0])
    rest = _operands(argv[1:])
    if prog == 'playwright':
        return True
    if prog == 'npx':
        return bool(rest) and rest[0] in ('playwright', '@playwright/test')
    if prog == 'npm':
        if len(rest) >= 2 and rest[0] in ('run', 'run-script'):
            return rest[1] in PLAYWRIGHT_NPM_SCRIPTS
        if len(rest) >= 2 and rest[0] in ('exec', 'x'):
            return rest[1] in ('playwright', '@playwright/test')
        return False
    if prog == 'node':
        if not rest:
            return False
        script = rest[0].replace('\\', '/').lower()
        return script.endswith('e2e/run.mjs') or 'playwright' in script
    return False


def resolve_executable(program: str) -> str:
    """`python` 取本解释器；Windows 上无后缀的名称先找 `<名称>.cmd`（npm、npx），再按 PATHEXT 找。"""
    if program == 'python':
        return sys.executable
    found: Optional[str] = None
    if os.name == 'nt' and not Path(program).suffix:
        found = shutil.which(program + '.cmd')
    found = found or shutil.which(program)
    if not found:
        raise AcceptanceError(f'找不到可执行文件 {program}（未执行，也未记录）')
    return found


def acquire_lock(path: Path, info: Mapping[str, Any]) -> Optional[str]:
    """以独占方式创建锁文件。成功返回 None；锁已存在时返回其内容（读不到为空串），不改动它。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with open(path, 'x', encoding='utf-8', newline='\n') as handle:
            handle.write(json.dumps(info, ensure_ascii=False) + '\n')
    except FileExistsError:
        return acceptance.read_text(path) or ''
    return None


def release_lock(path: Path) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        pass


def _fresh(path: Path, since: float) -> bool:
    try:
        return path.stat().st_mtime >= since - acceptance.FRESH_TOLERANCE_S
    except OSError:
        return False


def copy_run_outputs(root: Path, run_id: str, since: float, notes: List[str]) -> Tuple[Optional[str], List[str]]:
    """把本次运行写出的 `results.json`、`summary.md` 与 `review/` 复制进 `final-check/`。

    返回 (结果文件副本的相对路径或 None, 其余副本的相对路径)。不是本次运行写出的不复制，原因记入 `notes`。"""
    dest_dir = root / FINAL_CHECK_DIR_REL
    dest_dir.mkdir(parents=True, exist_ok=True)
    results: Optional[str] = None
    artifacts: List[str] = []
    for src_rel, name in ((OUT_RESULTS_REL, f'{run_id}-results.json'), (OUT_SUMMARY_REL, f'{run_id}-summary.md')):
        src, dst = root / src_rel, dest_dir / name
        if not _fresh(src, since):
            notes.append(f'{src_rel} 不存在或不是本次运行写出的，未复制为 {FINAL_CHECK_DIR_REL}/{name}')
            continue
        shutil.copy2(src, dst)
        if src_rel == OUT_RESULTS_REL:
            results = f'{FINAL_CHECK_DIR_REL}/{name}'
        else:
            artifacts.append(f'{FINAL_CHECK_DIR_REL}/{name}')
    review = root / OUT_REVIEW_REL
    if review.is_dir() and _fresh(review, since):
        dst = dest_dir / f'{run_id}-review'
        if dst.exists():
            shutil.rmtree(dst)
        shutil.copytree(review, dst)
        artifacts.append(f'{FINAL_CHECK_DIR_REL}/{run_id}-review/')
    else:
        notes.append(f'{OUT_REVIEW_REL}/ 不存在或不是本次运行重建的，未复制')
    return results, artifacts


def run_stats_lines(run: Optional[Mapping[str, Any]]) -> List[str]:
    """`results.json` 的各 profile 计数、跳过类别与 Visual_Regression_Check 的通过数。"""
    if not isinstance(run, Mapping):
        return ['  结果文件缺失或无法解析']
    lines: List[str] = []
    for s in run.get('stats') or []:
        if not isinstance(s, Mapping) or not s.get('ran'):
            continue
        counts = s.get('counts') if isinstance(s.get('counts'), Mapping) else {}
        parts = [f'{acceptance.OUTCOME_LABELS[k]} {counts.get(k, 0)}' for k in acceptance.OUTCOME_ORDER]
        parts.append(f'未执行 {s.get("notRun", 0)}')
        lines.append(f'  {s.get("profile")}：' + '、'.join(parts))
    rows = acceptance.rows_of(run)
    skips = Counter(
        (str(r.get('profile')), str((r.get('skip') or {}).get('kind') or 'other'))
        for r in rows if r.get('outcome') == 'skipped' and isinstance(r.get('skip') or {}, Mapping))
    if skips:
        lines.append('  跳过：' + '、'.join(f'{p} [{k}]×{n}' for (p, k), n in sorted(skips.items())))
    visual = [r for r in rows if acceptance.is_visual_row(r)]
    if visual:
        passed = sum(1 for r in visual if r.get('outcome') == 'passed')
        lines.append(f'  visual.spec：{passed}/{len(visual)} 通过')
    if run.get('abort'):
        lines.append(f'  中止：{run.get("abort")}')
    for f in run.get('runLevel') or []:
        if isinstance(f, Mapping):
            lines.append(f'  运行级失败：{acceptance.describe_run_level(f)}')
    return lines


def cmd_run(run_id: str, argv: Sequence[str], root: Path = REPO_ROOT) -> int:
    if not argv:
        print(f'用法：{SELF} run <id> -- <命令…>（-- 之后缺少命令）')
        return 2
    if not _RUN_ID.fullmatch(run_id):
        print(f'id {run_id!r} 不合法：只允许字母、数字、"."、"_"、"-"，以字母或数字开头（它用作文件名）')
        return 2
    data = load_final_check(root)
    if any(isinstance(c, Mapping) and c.get('id') == run_id for c in data['commands']):
        print(f'{FINAL_CHECK_REL} 中已有 id 为 {run_id} 的记录：每个 id 只记一次，未执行命令。'
              f'需要重跑时换一个 id（如 {run_id}-retry）。')
        return 2
    command = list(argv)
    display = ' '.join(command)
    executable = resolve_executable(command[0])
    playwright = is_playwright_command(command)
    lock = root / LOCK_REL

    started = acceptance.now_local()
    if playwright:
        held = acquire_lock(lock, {'id': run_id, 'pid': os.getpid(), 'startedAt': acceptance.iso(started),
                                   'argv': command})
        if held is not None:
            print(f'{LOCK_REL} 已存在：另一个 Playwright 进程可能正在运行（需求 21.2），未执行命令，也未记录。')
            print(f'  锁内容：{held.strip() or "（空）"}')
            print('  确认没有 Playwright 进程在运行后，可删除该文件再重试。')
            return 2

    notes: List[str] = []
    rc: Optional[int] = None
    interrupted = False
    results: Optional[str] = None
    artifacts: List[str] = []
    t0 = time.time()
    print(f'[{run_id}] $ {display}', flush=True)
    print(f'[{run_id}] 开始于 {acceptance.iso(started)}' + ('（持有 Playwright 锁）' if playwright else ''), flush=True)
    try:
        try:
            # 参数列表、不经 shell；输出直接交给当前控制台。
            rc = subprocess.run([executable, *command[1:]], cwd=root, stdin=subprocess.DEVNULL).returncode
        except KeyboardInterrupt:
            interrupted = True
            notes.append('被 Ctrl+C 打断')
        except OSError as exc:
            notes.append(f'无法启动：{exc}')
        ended = acceptance.now_local()
        duration = round(time.time() - t0, 1)
        if playwright:
            # 复制完再释放锁：其间不会有另一次运行改写 e2e/.out/。
            results, artifacts = copy_run_outputs(root, run_id, t0, notes)
    finally:
        if playwright:
            release_lock(lock)

    entry = {
        'id': run_id,
        'argv': command,
        'startedAt': acceptance.iso(started),
        'endedAt': acceptance.iso(ended),
        'durationSec': duration,
        'exitCode': rc,
        'playwright': playwright,
        'results': results,
        'artifacts': artifacts,
        'notes': notes,
    }
    data = load_final_check(root)  # 重新读取：保留命令执行期间写入的其他记录
    data['commands'].append(entry)
    save_final_check(root, data)

    print(f'[{run_id}] 结束于 {entry["endedAt"]}（{duration} s），退出码 {"—" if rc is None else rc}')
    for note in notes:
        print(f'  - {note}')
    if results:
        print(f'[{run_id}] 结果文件：{results}')
        for line in run_stats_lines(acceptance.load_json(root / results)):
            print(line)
    print(f'[{run_id}] 已记入 {FINAL_CHECK_REL}')
    if rc is None:
        return EXIT_INTERRUPTED if interrupted else 1
    return rc


# ---------------------------------------------------------------------------
# readings（需求 21.4）
# ---------------------------------------------------------------------------


def cmd_readings(label: str, root: Path = REPO_ROOT) -> int:
    if not _RUN_ID.fullmatch(label):
        print(f'label {label!r} 不合法：只允许字母、数字、"."、"_"、"-"，以字母或数字开头')
        return 2
    data = load_final_check(root)
    if label in data['readings']:
        print(f'{FINAL_CHECK_REL} 中已有 label 为 {label} 的读数（{data["readings"][label].get("takenAt", "—")}）：'
              '每个 label 只记一次，未改写。')
        return 2
    reading = acceptance.take_readings(root)
    data['readings'][label] = reading
    save_final_check(root, data)
    print(f'EV 18.6 读数已以 {label} 记入 {FINAL_CHECK_REL}（{reading["takenAt"]}）')
    for key, text in acceptance.READING_KEYS:
        print(f'  {text}：{acceptance.reading_text(reading["values"].get(key))}')
    return 0


# ---------------------------------------------------------------------------
# compare-runs（需求 17.4）
# ---------------------------------------------------------------------------


def compare_runs(run1: Optional[Mapping[str, Any]], run2: Optional[Mapping[str, Any]],
                 labels: Tuple[str, str] = ('第 1 次', '第 2 次')) -> List[str]:
    """两次运行的 `results.json` 比较；返回不满足的条件（空列表即一致）。

    - 两份的用例 id 集合相同；
    - 同一用例两次的 outcome 相同；
    - 两份各至少有一行 `visual.spec`，且每行都是通过（Visual_Regression_Check 零失败，EV 6.6）。"""
    out = [f'{label}：结果文件缺失或无法解析' for run, label in zip((run1, run2), labels)
           if not isinstance(run, Mapping)]
    if out:
        return out
    by_id = [{str(r.get('id')): r for r in acceptance.rows_of(run)} for run in (run1, run2)]
    for i in (0, 1):
        for rid in sorted(set(by_id[i]) - set(by_id[1 - i])):
            out.append(f'用例只在{labels[i]}中出现：{acceptance.row_label(by_id[i][rid])}')
    for rid in sorted(set(by_id[0]) & set(by_id[1])):
        a, b = by_id[0][rid], by_id[1][rid]
        if a.get('outcome') != b.get('outcome'):
            out.append(f'两次结果不同：{acceptance.row_label(a)}：{labels[0]} {acceptance.outcome_text(a)}，'
                       f'{labels[1]} {acceptance.outcome_text(b)}')
    for i, rows in enumerate(by_id):
        visual = sorted((r for r in rows.values() if acceptance.is_visual_row(r)), key=acceptance.row_label)
        if not visual:
            out.append(f'{labels[i]}：没有 visual.spec 的用例结果，Visual_Regression_Check 未执行')
        for row in visual:
            if row.get('outcome') != 'passed':
                out.append(f'{labels[i]}：Visual_Regression_Check 未通过：{acceptance.row_label(row)}：'
                           f'{acceptance.outcome_text(row)}'
                           + (f'：{row.get("errorLine")}' if row.get('errorLine') else ''))
    return out


def cmd_compare_runs(id1: str, id2: str, root: Path = REPO_ROOT) -> int:
    runs = []
    for run_id in (id1, id2):
        path = root / results_rel(run_id)
        run = acceptance.load_json(path)
        runs.append(run if isinstance(run, Mapping) else None)
        if isinstance(run, Mapping):
            print(f'{run_id}：{results_rel(run_id)}（startedAt {run.get("startedAt", "—")}，'
                  f'exitCode {run.get("exitCode", "—")}，用例 {len(acceptance.rows_of(run))} 个）')
            for line in run_stats_lines(run):
                print(line)
        else:
            print(f'{run_id}：{results_rel(run_id)} 缺失或无法解析')
    problems = compare_runs(runs[0], runs[1], (id1, id2))
    if not problems:
        common = len(acceptance.rows_of(runs[0]))
        visual = sum(1 for r in acceptance.rows_of(runs[0]) if acceptance.is_visual_row(r))
        print(f'结论：一致——用例 id 集合相同（{common} 个），每个用例两次的 outcome 相同，'
              f'visual.spec 两次各 {visual} 行全部通过（需求 17.4）')
        return 0
    print(f'结论：不一致（{len(problems)} 项）')
    for p in problems:
        print(f'  - {p}')
    return 1


# ---------------------------------------------------------------------------
# summary（需求 21.5、21.6；另核对 21.1–21.4、1.5、14.5、15.1、17.2、17.5、18.2、19.1–19.3）
# ---------------------------------------------------------------------------

ACCEPTANCE_REL = f'{SPEC_REL}/acceptance.md'
BASELINE_REVIEW_REL = f'{SPEC_REL}/baseline-review.md'
REVIEW_RECORD_RELS: Dict[str, str] = {
    'fixture': f'{SPEC_REL}/review-record-fixture.md',
    'real': f'{SPEC_REL}/review-record-real.md',
}
EV_SPEC_REL = '.kiro/specs/e2e-visual-testing'
FINDINGS_REL = f'{EV_SPEC_REL}/findings.md'
FINDINGS_DIR_REL = f'{EV_SPEC_REL}/findings'
#: EV 验收阶段 8 的 real 运行结果：需求 14.5 的"与 EV 验收阶段 8 的 5 个相同"以它为准。
EV_RUN8_REL = f'{EV_SPEC_REL}/acceptance/run-8.json'
BASELINES_DIR_REL = 'e2e/baselines'
BASELINES_TS_REL = 'e2e/visual/baselines.ts'
NPMRC_REL = '.npmrc'
#: `check_review_record` 的提示按 EV 的写法指向 `e2e/.out/review/`；这里核对的是 `run` 复制的副本。
EV_REVIEW_MD_REL = 'e2e/.out/review/review-report.md'

PASS = '通过'
FAIL = '不通过'

#: Final_Check 的命令集（需求 21.1）：id 与命令，按执行顺序。任务 21.3 逐条以
#: `run <id> -- <命令…>` 执行，`summary` 只认这 7 个 id；`final-check.json` 中的其他记录（如任务 19.4 的
#: `fixture-1`、`fixture-2`、`real-1`）不属于本命令集，只参与 21.2 的 Playwright 独占核对，以及按运行
#: 开始时间匹配 Review_Record 的被评审运行（17.5）。
FINAL_CHECK_COMMANDS: Tuple[Tuple[str, Tuple[str, ...]], ...] = (
    ('gate-typecheck', ('npm', 'run', 'typecheck')),
    ('gate-lint', ('npm', 'run', 'lint')),
    ('gate-build', ('npm', 'run', 'build')),
    ('gate-test', ('npm', 'run', 'test')),
    ('gate-pytest', ('python', '-m', 'pytest', 'scripts/tests', '-q')),
    ('audit', ('npm', 'audit')),
    ('e2e', ('npm', 'run', 'e2e')),
)
FINAL_CHECK_IDS: Tuple[str, ...] = tuple(cid for cid, _ in FINAL_CHECK_COMMANDS)
AUDIT_ID = 'audit'
E2E_ID = 'e2e'
#: 需求 21.4：Final_Check 开始时与结束时的读数 label。
READING_START = 'start'
READING_END = 'end'

#: `npm run e2e`（`--profile all`）应运行的 profile（`tooling` 随 fixture 运行）。
E2E_PROFILES: Tuple[str, ...] = ('fixture', 'real', 'tooling')
#: 需求 14.5：real 只允许按这两类跳过（EV 风险 R5 的数据限制）。
REAL_LIMIT_SKIPS: Tuple[str, ...] = acceptance.ACCEPTED_LIMIT_SKIPS_8
#: EV 验收阶段 8 的 5 个跳过（[4.7] 1 个、[8.13] 4 个）；`run-8.json` 不在时按类别计数比较。
EV_REAL_LIMIT_COUNTS: Dict[str, int] = {'4.7': 1, '8.13': 4}

#: 需求 15.1 的 31 次扫描（`e2e/a11y/scans.ts` 的 `A11Y_SCANS`，同一顺序）。
A11Y_EXT_THEMES: Tuple[str, ...] = ('default', 'eyecare', 'dark', 'black')
A11Y_SCAN_NAMES: Tuple[str, ...] = (
    *(f'a11y-{v}' for v in ('shelf', 'detail', 'reader', 'toc', 'search', 'settings')),
    *(f'a11y-contrast-{t}' for t in ('default', 'sepia', 'eyecare', 'dark', 'black')),
    *(f'a11y-contrast-{v}-{t}' for v in ('shelf', 'detail', 'toc', 'search', 'settings') for t in A11Y_EXT_THEMES),
)
#: 需求 21.5 / D13：人工核对书卡封面白字的 5 次扫描。
COVER_SCANS: Tuple[str, ...] = ('a11y-shelf', *(f'a11y-contrast-shelf-{t}' for t in A11Y_EXT_THEMES))
COLOR_CONTRAST = 'color-contrast'
#: 书卡封面节点的判别：选择器含 Tailwind 渐变类（`from-…`）。书架横幅的节点选择器不含它。
COVER_SELECTOR_MARK = 'from-'
GRADIENT_MARK = 'background gradient'
COVER_EXAMPLES = 3
A11Y_KIND_LABELS: Dict[str, str] = {'ok': '完成', 'failed': '扫描失败', 'skipped': '跳过', 'notRun': '未执行'}
THEME_LABELS: Dict[str, str] = {'unset': '未存储（实际 sepia）'}

#: 需求 17.5 点名须为"通过"的准则：profile → (Review_Shot 名称, 准则号, 写法)。
MANDATORY_CRITERIA: Dict[str, Tuple[Tuple[str, int, str], ...]] = {
    'fixture': (('load-error', 3, 'RS-20 新准则（需求 13.6）'),),
    'real': (
        ('toc-volumes', 2, 'RS-08 准则 2'),
        ('search-highlight', 1, 'RS-10 准则 1'),
        ('search-highlight', 2, 'RS-10 准则 2'),
        ('reader-mobile-toc', 2, 'RS-19 准则 2'),
    ),
}
#: 未拍摄只接受按 [4.7] / [8.13] 跳过的数据限制（如 RS-18 `toc-stars`；EV 风险 R5）。
_ACCEPTED_UNCAPTURED = re.compile(r'被跳过：\[(?:4\.7|8\.13)\]')

BASELINE_COUNT = 13
FIXED_FINDINGS: Tuple[str, ...] = tuple(f'F-{n:03d}' for n in range(2, 13))
FIXED_STATUS = '已修复'
PLAYWRIGHT_PACKAGE = '@playwright/test'
PLAYWRIGHT_VERSION = '1.62.1'
DEPENDENCY_SECTIONS: Tuple[str, ...] = ('dependencies', 'devDependencies')
EXACT_VERSION = re.compile(r'\d+\.\d+\.\d+')


class CheckItem(NamedTuple):
    """结论中的一项核对。`problems` 为不成立的情形（每条都带读数），为空即成立；`facts` 为读数摘要。"""

    key: str
    title: str
    problems: List[str]
    facts: List[str]

    @property
    def ok(self) -> bool:
        return not self.problems


@dataclass
class FinalCheckInputs:
    """`evaluate_final_check` 与 `render_acceptance` 的全部输入（由 `collect_final_check_inputs` 从磁盘读出）。

    - `final_check`：`final-check.json` 的内容；`snapshot`：Start_Snapshot（缺失为 None）。
    - `results` / `review_reports` / `review_mds`：命令 id → `final-check/<id>-results.json`、
      `<id>-review/review-report.json`、`<id>-review/review-report.md` 的内容（缺失为 None）。
    - `scope` / `scope_error`：`collect_scope` 的结果，或无法核对的原因。
    - `review_records`：profile → `review-record-<profile>.md` 的文本。
    - `findings` / `evidence`：EV 的 Findings_Log 文本与 `findings/` 中的文件名。
    - `ev_real_limits`：EV 阶段 8 按 [4.7] / [8.13] 跳过的用例（`row_label` 写法）；`run-8.json` 不在时为 None。
    - `lock_present`：`e2e/.out/playwright.lock` 是否存在；`npmrc`：仓库根 `.npmrc` 的文本。
    """

    final_check: Mapping[str, Any]
    snapshot: Optional[Mapping[str, Any]] = None
    results: Mapping[str, Optional[Mapping[str, Any]]] = field(default_factory=dict)
    review_reports: Mapping[str, Optional[Mapping[str, Any]]] = field(default_factory=dict)
    review_mds: Mapping[str, Optional[str]] = field(default_factory=dict)
    scope: Optional[Mapping[str, Any]] = None
    scope_error: Optional[str] = None
    baseline_review: Optional[str] = None
    baseline_files: Sequence[str] = ()
    baselines_ts: Optional[str] = None
    review_records: Mapping[str, Optional[str]] = field(default_factory=dict)
    findings: Optional[str] = None
    evidence: Sequence[str] = ()
    package_json: Optional[str] = None
    package_lock: Optional[str] = None
    ev_real_limits: Optional[Sequence[str]] = None
    lock_present: bool = False
    npmrc: Optional[str] = None


def _one_line(text: Any) -> str:
    return re.sub(r'\s*[\r\n]+\s*', ' ', str(text)).strip()


def _records(fc: Optional[Mapping[str, Any]]) -> List[Mapping[str, Any]]:
    commands = fc.get('commands') if isinstance(fc, Mapping) else None
    return [c for c in commands if isinstance(c, Mapping)] if isinstance(commands, list) else []


def _record(fc: Optional[Mapping[str, Any]], cid: str) -> Optional[Mapping[str, Any]]:
    found = [c for c in _records(fc) if c.get('id') == cid]
    return found[-1] if found else None


def _readings_of(fc: Optional[Mapping[str, Any]]) -> Mapping[str, Any]:
    readings = fc.get('readings') if isinstance(fc, Mapping) else None
    return readings if isinstance(readings, Mapping) else {}


def _time(value: Any) -> Optional[datetime]:
    """带 UTC 偏移的 ISO 时间；缺失、无法解析或不带偏移时为 None。"""
    if not isinstance(value, str) or not value:
        return None
    try:
        dt = datetime.fromisoformat(value)
    except ValueError:
        return None
    return dt if dt.utcoffset() is not None else None


def _argv_text(argv: Any) -> str:
    return ' '.join(map(str, argv)) if isinstance(argv, (list, tuple)) and argv else '—'


def _exit_ok(rc: Any) -> bool:
    return isinstance(rc, int) and not isinstance(rc, bool) and rc == 0


def _rc_text(rc: Any) -> str:
    return '—（未正常结束）' if rc is None else str(rc)


def _run_hint(cid: str, argv: Sequence[str]) -> str:
    return f'`{SELF} run {cid} -- {" ".join(argv)}`'


# --- 21.1、21.2：命令记录与 Playwright 独占 ----------------------------------


def check_commands(fc: Mapping[str, Any]) -> CheckItem:
    """21.1：7 条命令各有记录，命令与 `FINAL_CHECK_COMMANDS` 相同，时间可解析，按顺序依次执行，退出码 0。"""
    problems: List[str] = []
    passed = 0
    prev: Optional[Tuple[str, datetime, str]] = None
    for cid, argv in FINAL_CHECK_COMMANDS:
        expected = ' '.join(argv)
        rec = _record(fc, cid)
        if rec is None:
            problems.append(f'{cid}（`{expected}`）：没有记录；以 {_run_hint(cid, argv)} 执行')
            continue
        ok = True
        if list(rec.get('argv') or []) != list(argv):
            problems.append(f'{cid}：记录的命令为 `{_argv_text(rec.get("argv"))}`，应为 `{expected}`')
            ok = False
        start, end = _time(rec.get('startedAt')), _time(rec.get('endedAt'))
        if start is None or end is None:
            problems.append(f'{cid}：开始或结束时间缺失或无法解析（startedAt {rec.get("startedAt") or "—"}，'
                            f'endedAt {rec.get("endedAt") or "—"}）')
            ok = False
        elif end < start:
            problems.append(f'{cid}：结束时间 {rec["endedAt"]} 早于开始时间 {rec["startedAt"]}')
            ok = False
        else:
            if prev is not None and start < prev[1]:
                problems.append(f'{cid} 开始于 {rec["startedAt"]}，早于上一条 {prev[0]} 的结束时间 {prev[2]}：'
                                'Final_Check 的命令须依次执行')
                ok = False
            prev = (cid, end, str(rec['endedAt']))
        rc = rec.get('exitCode')
        if not _exit_ok(rc):
            problems.append(f'{cid}（`{expected}`）：退出码 {_rc_text(rc)}，应为 0')
            ok = False
        passed += ok
    facts = [f'{passed}/{len(FINAL_CHECK_COMMANDS)} 条命令依次执行并以退出码 0 结束']
    return CheckItem('21.1', 'Existing_Gates、npm audit、npm run e2e 依次执行，退出码均为 0', problems, facts)


def playwright_spans(fc: Mapping[str, Any]) -> Tuple[List[Tuple[datetime, datetime, str, str, str]], List[str]]:
    """记录中的 Playwright 运行（`playwright` 为真，或命令按 `is_playwright_command` 会启动 Playwright）。

    返回 ([(开始, 结束, id, startedAt, endedAt)]（按开始时间排序）, 问题)。"""
    spans: List[Tuple[datetime, datetime, str, str, str]] = []
    problems: List[str] = []
    for c in _records(fc):
        cid = str(c.get('id'))
        argv = [str(a) for a in c.get('argv') or []] if isinstance(c.get('argv'), list) else []
        detected = is_playwright_command(argv)
        if detected and not c.get('playwright'):
            problems.append(f'{cid}（`{_argv_text(argv)}`）会启动 Playwright，记录中却不是持锁执行的（playwright 为 false）')
        if not (detected or c.get('playwright')):
            continue
        start, end = _time(c.get('startedAt')), _time(c.get('endedAt'))
        if start is None or end is None:
            problems.append(f'{cid}：开始或结束时间缺失或无法解析，无法核对它是否与其他 Playwright 运行重叠')
            continue
        spans.append((start, end, cid, str(c.get('startedAt')), str(c.get('endedAt'))))
    spans.sort(key=lambda s: (s[0], s[1]))
    return spans, problems


def check_playwright_exclusive(fc: Mapping[str, Any], lock_present: bool) -> CheckItem:
    """21.2：经 `run` 记录的 Playwright 运行两两不重叠（`run` 以 `e2e/.out/playwright.lock` 保证），且锁已释放。"""
    spans, problems = playwright_spans(fc)
    overlaps = 0
    for i, a in enumerate(spans):
        for b in spans[i + 1:]:
            if b[0] < a[1] and a[0] < b[1]:
                overlaps += 1
                problems.append(f'{a[2]}（{a[3]} – {a[4]}）与 {b[2]}（{b[3]} – {b[4]}）的执行时间重叠')
    if lock_present:
        problems.append(f'{LOCK_REL} 仍存在：可能有 Playwright 进程正在运行，或上一次运行被强行结束后遗留了锁')
    facts = [f'记录中的 Playwright 运行 {len(spans)} 次（{"、".join(s[2] for s in spans) or "无"}）'
             + ('，执行时间两两不重叠' if spans and not overlaps else '')]
    return CheckItem('21.2', '任一时刻只运行一个 Playwright 进程', problems, facts)


# --- 21.3、14.5、15.1：npm run e2e 的结果 -------------------------------------


def e2e_run(inputs: FinalCheckInputs) -> Tuple[Optional[Mapping[str, Any]], Optional[str]]:
    """`e2e` 记录的结果副本；取不到时返回 (None, 原因)。"""
    rec = _record(inputs.final_check, E2E_ID)
    if rec is None:
        return None, f'没有 {E2E_ID} 的记录（以 {_run_hint(E2E_ID, dict(FINAL_CHECK_COMMANDS)[E2E_ID])} 执行）'
    path = rec.get('results')
    if not path:
        notes = '；'.join(str(n) for n in rec.get('notes') or [])
        return None, f'{E2E_ID} 的记录没有结果文件副本（results 为 null）' + (f'：{notes}' if notes else '')
    run = inputs.results.get(E2E_ID)
    if not isinstance(run, Mapping):
        return None, f'{path} 缺失或无法解析'
    return run, None


def _stats_by_profile(run: Mapping[str, Any]) -> Dict[str, Mapping[str, Any]]:
    return {str(s.get('profile')): s for s in run.get('stats') or [] if isinstance(s, Mapping)}


def _skip_of(row: Mapping[str, Any]) -> Tuple[str, str]:
    skip = row.get('skip') if isinstance(row.get('skip'), Mapping) else {}
    return str(skip.get('kind') or 'other'), str(skip.get('reason') or '').strip()


def check_e2e_outcomes(run: Optional[Mapping[str, Any]], error: Optional[str]) -> CheckItem:
    """21.3：失败、意外通过与未执行为 0；未中止、无运行级失败；fixture、real、tooling 都已运行；
    Visual_Regression_Check 零失败（`visual.spec` 至少 1 行且全部通过）。"""
    title = 'npm run e2e：失败数与意外通过数为 0，Visual_Regression_Check 零失败'
    if run is None:
        return CheckItem('21.3', title, [str(error)], [])
    problems: List[str] = []
    if not _exit_ok(run.get('exitCode')):
        problems.append(f'results.json 的 exitCode 为 {_rc_text(run.get("exitCode"))}，应为 0')
    abort = run.get('abort')
    if abort:
        stage = abort.get('stage') if isinstance(abort, Mapping) else None
        reason = abort.get('reason') if isinstance(abort, Mapping) else abort
        problems.append(f'运行中止于"{stage}"：{reason}')
    for f in run.get('runLevel') or []:
        if isinstance(f, Mapping):
            problems.append(f'运行级失败：{acceptance.describe_run_level(f)}')
    stats = _stats_by_profile(run)
    for profile in E2E_PROFILES:
        s = stats.get(profile)
        if not s or not s.get('ran'):
            problems.append(f'{profile} 未运行（selected = {run.get("selected")}）')
    rows = sorted(acceptance.rows_of(run), key=acceptance.row_label)
    bad = {'failed': 0, 'unexpectedPass': 0, 'notRun': 0}
    for row in rows:
        outcome = str(row.get('outcome'))
        if outcome in bad:
            bad[outcome] += 1
            if not acceptance.is_visual_row(row):
                problems.append(f'{acceptance.row_label(row)}：{acceptance.outcome_text(row)}'
                                + (f'：{_one_line(row["errorLine"])}' if row.get('errorLine') else ''))
    visual = [r for r in rows if acceptance.is_visual_row(r)]
    if not visual:
        problems.append('没有 visual.spec 的用例结果，Visual_Regression_Check 未执行')
    for row in visual:
        if row.get('outcome') != 'passed':
            problems.append(f'Visual_Regression_Check 未通过：{acceptance.row_label(row)}：{acceptance.outcome_text(row)}'
                            + (f'：{_one_line(row["errorLine"])}' if row.get('errorLine') else ''))
    passed_visual = sum(1 for r in visual if r.get('outcome') == 'passed')
    facts = [f'用例 {len(rows)} 个：失败 {bad["failed"]}、意外通过 {bad["unexpectedPass"]}、未执行 {bad["notRun"]}',
             f'visual.spec {passed_visual}/{len(visual)} 通过']
    return CheckItem('21.3', title, problems, facts)


def real_limit_cases(run: Optional[Mapping[str, Any]]) -> List[Dict[str, str]]:
    """real 中按 [4.7] / [8.13] 跳过且写明原因的用例（`acceptance.accepted_limits_8` 的 real 部分）。"""
    return [a for a in acceptance.accepted_limits_8(run) if a['profile'] == 'real']


def check_expected_fail_and_skips(run: Optional[Mapping[str, Any]], error: Optional[str],
                                  ev_limits: Optional[Sequence[str]]) -> CheckItem:
    """14.5：fixture 的预期失败与跳过均为 0；real 的预期失败为 0，跳过只有 [4.7] / [8.13] 的数据限制，且与
    EV 验收阶段 8 的 5 个相同（`ev_limits` 给出时逐条比较，否则按类别计数比较）。"""
    title = '预期失败与跳过：fixture 均为 0；real 预期失败为 0，跳过只有 EV 阶段 8 的 5 个数据限制'
    if run is None:
        return CheckItem('14.5', title, [str(error)], [])
    problems: List[str] = []
    counts: Counter = Counter()
    for row in sorted(acceptance.rows_of(run), key=acceptance.row_label):
        profile, outcome = str(row.get('profile')), row.get('outcome')
        if profile not in ('fixture', 'real') or outcome not in ('expectedFail', 'skipped'):
            continue
        counts[(profile, outcome)] += 1
        label = acceptance.row_label(row)
        if outcome == 'expectedFail':
            problems.append(f'{label}：{acceptance.outcome_text(row)}（{profile} 的预期失败数须为 0）')
            continue
        kind, reason = _skip_of(row)
        if profile == 'fixture':
            problems.append(f'{label}：按 [{kind}] 跳过（fixture 的跳过数须为 0）：{reason or "（没有原因）"}')
        elif kind not in REAL_LIMIT_SKIPS:
            problems.append(f'{label}：按 [{kind}] 跳过，real 只允许按 [4.7] / [8.13] 跳过：{reason or "（没有原因）"}')
        elif not reason:
            problems.append(f'{label}：按 [{kind}] 跳过，但没有写明原因')
    limits = real_limit_cases(run)
    by_kind = Counter(a['kind'] for a in limits)
    if ev_limits is not None:
        now = {a['case'] for a in limits}
        for case in sorted(now - set(ev_limits)):
            problems.append(f'{case}：按 [4.7] / [8.13] 跳过，但不在 EV 验收阶段 8 的 {len(ev_limits)} 个数据限制中')
        for case in sorted(set(ev_limits) - now):
            problems.append(f'{case}：EV 验收阶段 8 按 [4.7] / [8.13] 跳过，本次不是这样跳过')
    elif dict(by_kind) != EV_REAL_LIMIT_COUNTS:
        problems.append(f'real 按 [4.7] / [8.13] 跳过 {dict(by_kind)}，与 EV 验收阶段 8 的 {EV_REAL_LIMIT_COUNTS} 不同'
                        f'（{EV_RUN8_REL} 不在，按类别计数比较）')
    facts = [f'fixture 预期失败 {counts[("fixture", "expectedFail")]}、跳过 {counts[("fixture", "skipped")]}；'
             f'real 预期失败 {counts[("real", "expectedFail")]}、跳过 {counts[("real", "skipped")]}'
             f'（[4.7] {by_kind.get("4.7", 0)}、[8.13] {by_kind.get("8.13", 0)}）']
    return CheckItem('14.5', title, problems, facts)


def a11y_data(run: Optional[Mapping[str, Any]]) -> Tuple[Optional[Mapping[str, Any]], Optional[str]]:
    """`results.json` 中 A11y_Scan 一节的数据（reporter 写出的 `A11ySectionData`）；取不到时返回 (None, 原因)。"""
    sections = run.get('sections') if isinstance(run, Mapping) else None
    section = sections.get('a11y') if isinstance(sections, Mapping) else None
    data = section.get('data') if isinstance(section, Mapping) else None
    if isinstance(data, Mapping):
        return data, None
    status = section.get('status') if isinstance(section, Mapping) else None
    reason = section.get('reason') if isinstance(section, Mapping) else None
    return None, f'results.json 中没有 A11y_Scan 一节的数据（status {status or "—"}' + (f'：{reason}' if reason else '') + '）'


def a11y_entries(data: Optional[Mapping[str, Any]]) -> List[Mapping[str, Any]]:
    entries = data.get('entries') if isinstance(data, Mapping) else None
    return [e for e in entries if isinstance(e, Mapping)] if isinstance(entries, list) else []


def _entry_result(entry: Mapping[str, Any]) -> Mapping[str, Any]:
    result = entry.get('result')
    return result if isinstance(result, Mapping) else {}


def _rules(result: Mapping[str, Any], key: str) -> List[Mapping[str, Any]]:
    return [x for x in result.get(key) or [] if isinstance(x, Mapping)]


def check_a11y(run: Optional[Mapping[str, Any]], error: Optional[str]) -> CheckItem:
    """15.1：31 次扫描（`A11Y_SCAN_NAMES`）各恰有一节，全部完成且 0 条违规；A11y 节没有附件问题。"""
    title = 'A11y_Scan 31 次扫描全部完成，每次 0 条违规'
    if run is None:
        return CheckItem('15.1', title, [str(error)], [])
    data, why = a11y_data(run)
    if data is None:
        return CheckItem('15.1', title, [str(why)], [])
    entries = a11y_entries(data)
    names = [str(e.get('name')) for e in entries]
    problems: List[str] = []
    if len(entries) != len(A11Y_SCAN_NAMES):
        problems.append(f'A11y_Scan 节有 {len(entries)} 次扫描，应为 {len(A11Y_SCAN_NAMES)} 次')
    for name in A11Y_SCAN_NAMES:
        if name not in names:
            problems.append(f'{name}：没有结果')
    for name in sorted(set(names) - set(A11Y_SCAN_NAMES)):
        problems.append(f'{name}：不是需求 15.1 的 31 次扫描之一')
    for name, n in sorted(Counter(names).items()):
        if n > 1:
            problems.append(f'{name}：出现 {n} 次')
    done = violations = incomplete_rules = 0
    for entry in entries:
        name, result = str(entry.get('name')), _entry_result(entry)
        kind = str(result.get('kind'))
        if kind != 'ok':
            problems.append(f'{name}：{A11Y_KIND_LABELS.get(kind, kind)}（{_one_line(result.get("reason") or "—")}），'
                            '没有 axe 结果，不计为 0 违规')
            continue
        done += 1
        rules = _rules(result, 'violations')
        incomplete_rules += len(_rules(result, 'incomplete'))
        if rules:
            violations += len(rules)
            problems.append(f'{name}：{len(rules)} 条违规：' + '；'.join(
                f'{v.get("id")}（{v.get("impact") or "未分级"}，{v.get("nodes")} 个节点）' for v in rules))
    for p in data.get('problems') or []:
        problems.append(f'A11y_Scan 附件问题：{_one_line(p)}')
    facts = [f'{len(entries)} 次扫描：完成 {done}，违规 {violations} 条规则；incomplete {incomplete_rules} 条规则（不阻断）']
    return CheckItem('15.1', title, problems, facts)


# --- 21.4：读数 ----------------------------------------------------------------


def _final_check_bounds(fc: Mapping[str, Any]) -> Tuple[Optional[Tuple[datetime, str]], Optional[Tuple[datetime, str]]]:
    """Final_Check 命令集中最早的开始时间与最晚的结束时间（(时间, 原文)）。"""
    starts: List[Tuple[datetime, str]] = []
    ends: List[Tuple[datetime, str]] = []
    for cid in FINAL_CHECK_IDS:
        rec = _record(fc, cid)
        if rec is None:
            continue
        s, e = _time(rec.get('startedAt')), _time(rec.get('endedAt'))
        if s is not None:
            starts.append((s, f'{cid} {rec["startedAt"]}'))
        if e is not None:
            ends.append((e, f'{cid} {rec["endedAt"]}'))
    return (min(starts) if starts else None), (max(ends) if ends else None)


def check_readings(fc: Mapping[str, Any], snapshot: Optional[Mapping[str, Any]]) -> CheckItem:
    """21.4：`start` 记于 Final_Check 第一条命令之前、`end` 记于最后一条命令之后；两次读数逐项一致，且与
    Start_Snapshot 的读数一致。"""
    readings = _readings_of(fc)
    start, end = readings.get(READING_START), readings.get(READING_END)
    base = snapshot.get('readings') if isinstance(snapshot, Mapping) else None
    problems: List[str] = []
    for label, value, when in ((READING_START, start, '第一条命令之前'), (READING_END, end, '最后一条命令之后')):
        if not isinstance(value, Mapping):
            problems.append(f'没有 {label} 读数（在 Final_Check 的{when}执行 `{SELF} readings {label}`）')
    if not isinstance(base, Mapping):
        problems.append(f'{SNAPSHOT_REL} 缺失或没有 readings')
    for la, lb, a, b in ((READING_START, READING_END, start, end), ('Start_Snapshot', READING_START, base, start),
                         ('Start_Snapshot', READING_END, base, end)):
        if isinstance(a, Mapping) and isinstance(b, Mapping):
            for d in acceptance.compare_readings(a, b):
                problems.append(f'{d.label}：{la} {acceptance.reading_text(d.before)}，{lb} {acceptance.reading_text(d.after)}')
    first, last = _final_check_bounds(fc)
    if isinstance(start, Mapping) and first is not None:
        taken = _time(start.get('takenAt'))
        if taken is None or taken > first[0]:
            problems.append(f'{READING_START} 读数记于 {start.get("takenAt") or "—"}，不在 Final_Check 第一条命令开始'
                            f'（{first[1]}）之前')
    if isinstance(end, Mapping) and last is not None:
        taken = _time(end.get('takenAt'))
        if taken is None or taken < last[0]:
            problems.append(f'{READING_END} 读数记于 {end.get("takenAt") or "—"}，不在 Final_Check 最后一条命令结束'
                            f'（{last[1]}）之后')
    facts = (['start、end 与 Start_Snapshot 的 6 项读数逐项一致'] if not problems else [])
    return CheckItem('21.4', 'Final_Check 开始时与结束时的 EV 18.6 读数一致，并与 Start_Snapshot 一致', problems, facts)


# --- 1.5、17.2、17.5、18.2 -----------------------------------------------------


def check_scope_item(scope: Optional[Mapping[str, Any]], error: Optional[str]) -> CheckItem:
    """1.5：`collect_scope` 的结论。"""
    title = '改动范围以 Start_Snapshot 为基准核对通过（含 1.3、1.4）'
    if scope is None:
        return CheckItem('1.5', title, [f'无法核对：{error or "—"}'], [])
    facts = [f'变化路径 {len(scope.get("changes") or [])} 个，越界 {len(scope.get("violations") or [])} 个']
    problems = [] if scope.get('ok') else (list(scope.get('problems') or []) or ['scope 的结论为不通过'])
    return CheckItem('1.5', title, problems, facts)


def baseline_verdict_text(text: Optional[str]) -> Optional[str]:
    """`baseline-review.md` 中只保留标题含"判定"的 `## ` 节（其余行置空，行号不变）。

    本 spec 的记录在判定表之后另有一张行距读数表，首格同样是 PNG 文件名；EV 的 `parse_baseline_review` 会把
    它也当成判定行。没有这样的节时原样返回。"""
    if text is None:
        return None
    lines = text.splitlines()
    if not any(line.startswith('## ') and '判定' in line for line in lines):
        return text
    kept: List[str] = []
    inside = False
    for line in lines:
        if line.startswith('## '):
            inside = '判定' in line
        kept.append(line if inside else '')
    return '\n'.join(kept)


def check_baselines(text: Optional[str], files: Sequence[str], known_findings: Set[str],
                    baselines_ts: Optional[str]) -> CheckItem:
    """17.2：`baseline-review.md` 的判定节按 EV 18.2 的格式逐张记录 13 张基线（`check_baseline_review`），且全部
    "接受"。"""
    title = '13 张 Pixel_Baseline 评审完毕，全部判为"接受"'
    text = baseline_verdict_text(text)
    if text is None:
        return CheckItem('17.2', title, [f'{BASELINE_REVIEW_REL} 不存在'], [])
    problems: List[str] = []
    if len(files) != BASELINE_COUNT:
        problems.append(f'{BASELINES_DIR_REL}/ 中有 {len(files)} 张 PNG，应为 {BASELINE_COUNT} 张（EV 12.2）')
    problems += acceptance.check_baseline_review(text, files, known_findings, baselines_ts)
    rows = acceptance.parse_baseline_review(text)
    for r in rows:
        if r.verdict == '含已知缺陷接受':
            problems.append(f'第 {r.line} 行 {r.file}：判为"含已知缺陷接受"，须为"接受"（需求 17.2、17.6）')
    counts = Counter(r.verdict for r in rows)
    facts = ['，'.join(f'{v} {counts.get(v, 0)} 张' for v in acceptance.BASELINE_VERDICTS) + f'（共 {len(rows)} 行）']
    return CheckItem('17.2', title, problems, facts)


def review_run_id(inputs: FinalCheckInputs, record: acceptance.ReviewRecord) -> Optional[str]:
    """Review_Record 开头的运行开始时间对应的记录 id（结果副本的 `startedAt` 相同；有多条时优先取带
    Review_Report 副本的、靠后的一条）。"""
    found = [str(c.get('id')) for c in _records(inputs.final_check)
             if record.started and acceptance.started_of(inputs.results.get(str(c.get('id')))) == record.started]
    with_report = [cid for cid in found if isinstance(inputs.review_reports.get(cid), Mapping)]
    return (with_report or found or [None])[-1]


def check_review_records(inputs: FinalCheckInputs, known_findings: Set[str]) -> CheckItem:
    """17.5：两份 Review_Record 按 EV 13.6 的格式通过核对（`check_review_record`，对照被评审运行的结果副本与
    Review_Report 副本）；没有"不通过"（17.6）；`MANDATORY_CRITERIA` 恰有 1 个判定且为"通过"；未拍摄的只有按
    [4.7] / [8.13] 跳过的数据限制。"无法判断"不影响结论，列入人工核对清单（EV 13.8）。"""
    title = 'Review_Record 两份核对通过，点名准则全部"通过"，没有"不通过"'
    problems: List[str] = []
    facts: List[str] = []
    for profile, rel_path in REVIEW_RECORD_RELS.items():
        text = inputs.review_records.get(profile)
        if text is None:
            problems.append(f'{profile}：{rel_path} 不存在')
            continue
        record = acceptance.parse_review_record(text)
        run_id = review_run_id(inputs, record)
        if run_id is None:
            problems.append(f'{profile}：{rel_path} 开头的运行开始时间（{record.started or "无"}）不对应 '
                            f'{FINAL_CHECK_REL} 中任何一次运行的结果副本')
        report = inputs.review_reports.get(run_id) if run_id else None
        md_started = acceptance.report_md_started(inputs.review_mds.get(run_id)) if run_id else None
        run_started = acceptance.started_of(inputs.results.get(run_id)) if run_id else None
        copy_md = f'{FINAL_CHECK_DIR_REL}/{run_id}-review/review-report.md'
        for msg in acceptance.check_review_record(record, report, profile, run_started, md_started,
                                                  known_findings, inputs.evidence):
            problems.append(f'{profile}：{msg.replace(EV_REVIEW_MD_REL, copy_md)}')
        for name, k, verdict, _basis, _finding, line in record.verdicts:
            if verdict == '不通过':
                problems.append(f'{profile}：第 {line} 行 {name}#{k} 判为"不通过"（需求 17.6：用户对相应 Finding 作出决定前，'
                                'Final_Check 判为不通过）')
        for name, k, label in MANDATORY_CRITERIA.get(profile, ()):
            got = [v[2] for v in record.verdicts if v[0] == name and v[1] == k]
            if got != [PASS]:
                problems.append(f'{profile}：{name}#{k}（{label}）须恰有 1 个判定且为"通过"，实际 {"、".join(got) or "没有判定"}')
        shots = {str(s.get('name')): s for s in (report or {}).get('shots') or [] if isinstance(s, Mapping)}
        for name, reason, line in record.uncaptured:
            shot_reason = str((shots.get(name) or {}).get('reason') or reason)
            if not _ACCEPTED_UNCAPTURED.search(shot_reason):
                problems.append(f'{profile}：第 {line} 行 {name} 未拍摄，原因不是按 [4.7] / [8.13] 跳过的数据限制：'
                                f'{_one_line(shot_reason)}')
        counts = Counter(v[2] for v in record.verdicts)
        facts.append(f'{profile}（{run_id or "未匹配到运行"}）：' + '、'.join(
            f'{v} {counts.get(v, 0)}' for v in acceptance.REVIEW_VERDICTS) + f'、未拍摄 {len(record.uncaptured)}')
    return CheckItem('17.5', title, problems, facts)


def parse_finding_statuses(text: Optional[str]) -> List[Dict[str, Optional[str]]]:
    """Findings_Log 的 `## F-xxx 标题` 及其下第一行顶格的 `- 状态：…`。

    只认 `## F-xxx` 标题之下、下一个 `## ` 标题之前的行：文件开头说明字段写法的 `- 状态：由需求 19.8 定义…`
    不属于任何条目，不计入。"""
    out: List[Dict[str, Optional[str]]] = []
    current: Optional[Dict[str, Optional[str]]] = None
    for line in (text or '').splitlines():
        m = re.match(r'^##\s+(F-\d{3,})\s*(.*)$', line)
        if m:
            current = {'id': m.group(1), 'title': m.group(2).strip(), 'status': None}
            out.append(current)
            continue
        if line.startswith('## '):
            current = None
            continue
        m = re.match(r'^-\s*状态\s*[：:]\s*(.+?)\s*$', line)
        if m and current is not None and current['status'] is None:
            current['status'] = m.group(1)
    return out


def check_findings(text: Optional[str]) -> CheckItem:
    """18.2：F-002–F-012 都在 Findings_Log 中，状态为"已修复"。"""
    title = 'Findings_Log 中 F-002–F-012 的状态均为"已修复"'
    if text is None:
        return CheckItem('18.2', title, [f'{FINDINGS_REL} 不存在'], [])
    by_id = {str(f['id']): f for f in parse_finding_statuses(text)}
    problems: List[str] = []
    fixed = 0
    for fid in FIXED_FINDINGS:
        f = by_id.get(fid)
        if f is None:
            problems.append(f'{fid}：不在 {FINDINGS_REL} 中')
        elif not f['status']:
            problems.append(f'{fid}：没有"状态"字段（视为未修复）')
        elif not str(f['status']).startswith(FIXED_STATUS):
            problems.append(f'{fid}：状态为"{f["status"]}"，应为"已修复"')
        else:
            fixed += 1
    return CheckItem('18.2', title, problems, [f'{fixed}/{len(FIXED_FINDINGS)} 条为"已修复"'])


# --- 19.1–19.3：依赖 -----------------------------------------------------------


def check_audit(fc: Mapping[str, Any], npmrc: Optional[str]) -> CheckItem:
    """19.1：`audit` 记录（`npm audit`）以退出码 0 结束。

    `npm audit` 没有漏洞时以 0 结束，报告任何严重级别（含开发依赖）的漏洞时以非 0 结束；`summary` 不运行
    npm，以记录的退出码为依据。仓库根 `.npmrc` 设置了 `audit-level` 时退出码不足以说明 0 个漏洞，判不成立。"""
    title = 'npm audit 报告 0 个漏洞（退出码 0）'
    rec = _record(fc, AUDIT_ID)
    problems: List[str] = []
    if rec is None:
        problems.append(f'没有 {AUDIT_ID} 的记录（以 {_run_hint(AUDIT_ID, dict(FINAL_CHECK_COMMANDS)[AUDIT_ID])} 执行）')
    elif not _exit_ok(rec.get('exitCode')):
        problems.append(f'npm audit 退出码 {_rc_text(rec.get("exitCode"))}：报告了漏洞或未能完成')
    if npmrc is not None and re.search(r'(?mi)^\s*audit-level\s*=', npmrc):
        problems.append(f'{NPMRC_REL} 设置了 audit-level：npm audit 的退出码不再等价于"0 个漏洞"')
    facts = [] if rec is None else [f'退出码 {_rc_text(rec.get("exitCode"))}']
    return CheckItem('19.1', title, problems, facts)


def dependency_rows(package_json: Optional[str], package_lock: Optional[str]) -> Tuple[List[Dict[str, Any]], List[str]]:
    """package.json 的直接依赖与锁文件的对照：每行 `section`、`name`、`declared`（package.json）、`locked`
    （锁文件 `packages[""]`）、`resolved`（锁文件 `packages["node_modules/<name>"].version`）。返回 (行, 读取问题)。"""
    errors: List[str] = []
    parsed: List[Any] = []
    for label, text in (('package.json', package_json), ('package-lock.json', package_lock)):
        if text is None:
            errors.append(f'{label} 不存在')
            parsed.append(None)
            continue
        try:
            value = json.loads(text)
        except ValueError as exc:
            errors.append(f'{label} 无法解析：{exc}')
            parsed.append(None)
            continue
        if not isinstance(value, dict):
            errors.append(f'{label} 的顶层不是对象')
            value = None
        parsed.append(value)
    pkg, lock = parsed
    if pkg is None or lock is None:
        return [], errors
    packages = lock.get('packages') if isinstance(lock.get('packages'), dict) else {}
    root_entry = packages.get('') if isinstance(packages.get(''), dict) else {}
    if not packages:
        errors.append('package-lock.json 没有 packages（lockfileVersion 应 ≥ 2）')
    rows: List[Dict[str, Any]] = []
    for section in DEPENDENCY_SECTIONS:
        declared = pkg.get(section) if isinstance(pkg.get(section), dict) else {}
        locked = root_entry.get(section) if isinstance(root_entry.get(section), dict) else {}
        for name in sorted(set(declared) | set(locked)):
            node = packages.get(f'node_modules/{name}')
            rows.append({'section': section, 'name': name, 'declared': declared.get(name), 'locked': locked.get(name),
                         'resolved': node.get('version') if isinstance(node, dict) else None})
    if not rows:
        errors.append('package.json 没有 dependencies / devDependencies')
    return rows, errors


def dependency_row_problems(row: Mapping[str, Any]) -> List[str]:
    where = f'{row["section"]} › {row["name"]}'
    declared, locked, resolved = row['declared'], row['locked'], row['resolved']
    if declared is None:
        return [f'{where}：只在锁文件 packages[""] 中出现（{locked}），package.json 中没有']
    out: List[str] = []
    if not isinstance(declared, str) or not EXACT_VERSION.fullmatch(declared):
        out.append(f'{where}：版本 {declared!r} 不是"主.次.修订"三段纯数字')
    if locked != declared:
        out.append(f'{where}：锁文件 packages[""] 中为 {locked if locked is not None else "（无）"}，package.json 为 {declared}')
    if resolved != declared:
        out.append(f'{where}：锁文件解析出的版本（packages["node_modules/{row["name"]}"].version）为 '
                   f'{resolved if resolved is not None else "（无）"}，package.json 为 {declared}')
    return out


def check_dependencies(package_json: Optional[str], package_lock: Optional[str]) -> Tuple[CheckItem, CheckItem]:
    """19.2：直接依赖都是精确版本，且与锁文件一致；19.3：`@playwright/test` 为 1.62.1。"""
    rows, errors = dependency_rows(package_json, package_lock)
    problems = list(errors)
    for row in rows:
        problems += dependency_row_problems(row)
    exact = sum(1 for r in rows if not dependency_row_problems(r))
    item_192 = CheckItem('19.2', 'package.json 的直接依赖均为精确版本，与锁文件解析出的版本相同', problems,
                         [f'{exact}/{len(rows)} 个直接依赖一致'] if rows else [])
    pw = next((r for r in rows if r['section'] == 'devDependencies' and r['name'] == PLAYWRIGHT_PACKAGE), None)
    pw_problems = list(errors)
    if pw is None and not errors:
        pw_problems.append(f'devDependencies 中没有 {PLAYWRIGHT_PACKAGE}')
    elif pw is not None and (pw['declared'], pw['resolved']) != (PLAYWRIGHT_VERSION, PLAYWRIGHT_VERSION):
        pw_problems.append(f'{PLAYWRIGHT_PACKAGE}：package.json 为 {pw["declared"]}，锁文件解析为 {pw["resolved"]}，'
                           f'应均为 {PLAYWRIGHT_VERSION}')
    item_193 = CheckItem('19.3', f'{PLAYWRIGHT_PACKAGE} 保持 {PLAYWRIGHT_VERSION}', pw_problems,
                         [f'package.json {pw["declared"]}，锁文件 {pw["resolved"]}'] if pw else [])
    return item_192, item_193


# --- 结论 ----------------------------------------------------------------------


def evaluate_final_check(inputs: FinalCheckInputs) -> Tuple[str, List[CheckItem]]:
    """Final_Check 的结论（纯函数，需求 21.6）：全部核对项成立时为"通过"，否则"不通过"。

    核对项依次为 21.1、21.2、21.3（另含 14.5、15.1）、21.4、1.5、17.2、17.5，以及任务 21.1 列入验收小结的
    18.2（F-002–F-012 状态）、19.1（npm audit）、19.2、19.3（版本锁定）。"""
    known = {str(f['id']) for f in parse_finding_statuses(inputs.findings)}
    run, error = e2e_run(inputs)
    items = [
        check_commands(inputs.final_check),
        check_playwright_exclusive(inputs.final_check, inputs.lock_present),
        check_e2e_outcomes(run, error),
        check_expected_fail_and_skips(run, error, inputs.ev_real_limits),
        check_a11y(run, error),
        check_readings(inputs.final_check, inputs.snapshot),
        check_scope_item(inputs.scope, inputs.scope_error),
        check_baselines(inputs.baseline_review, inputs.baseline_files, known, inputs.baselines_ts),
        check_review_records(inputs, known),
        check_findings(inputs.findings),
        check_audit(inputs.final_check, inputs.npmrc),
        *check_dependencies(inputs.package_json, inputs.package_lock),
    ]
    return (PASS if all(i.ok for i in items) else FAIL), items


# --- acceptance.md 的各节 -------------------------------------------------------

_table = acceptance.md_table


def _code(text: Any) -> str:
    return f'`{text}`'


def render_conclusion(conclusion: str, items: Sequence[CheckItem]) -> List[str]:
    lines = ['## 1. 结论', '', f'**{conclusion}**', '',
             '核对项：需求 21.1–21.4（21.3 含 14.5、15.1）、1.5、17.2、17.5（需求 21.6），以及任务 21.1 列入的 18.2、'
             '19.1–19.3。任一项不成立即判"不通过"。', '']
    lines += _table(['条目', '核对', '结果', '读数'],
                    [[i.key, i.title, PASS if i.ok else FAIL, '；'.join(i.facts) or '—'] for i in items])
    failing = [i for i in items if not i.ok]
    if failing:
        lines += ['', f'不成立的条目（{len(failing)} 项）及其读数：', '']
        for i in failing:
            lines.append(f'- {i.key} {i.title}：')
            lines += [f'  - {_one_line(p)}' for p in i.problems]
    return lines


def _command_row(cid: str, argv: Sequence[str], rec: Optional[Mapping[str, Any]]) -> List[Any]:
    if rec is None:
        return [cid, _code(' '.join(argv)), '未记录', '—', '—', '—', '—']
    return [cid, _code(_argv_text(rec.get('argv'))), rec.get('startedAt'), rec.get('endedAt'),
            rec.get('durationSec'), _rc_text(rec.get('exitCode')), rec.get('results') or '—']


def render_commands(inputs: FinalCheckInputs) -> List[str]:
    fc = inputs.final_check
    header = ['id', '命令', '开始', '结束', '耗时（s）', '退出码', '结果文件']
    lines = ['## 2. 命令记录（需求 21.1、21.2）', '',
             f'记录文件：`{FINAL_CHECK_REL}`（`{SELF} run <id> -- <命令…>` 写入；时间为本机时间，带 UTC 偏移）。', '',
             'Final_Check 的命令集（按执行顺序）：', '']
    lines += _table(header, [_command_row(cid, argv, _record(fc, cid)) for cid, argv in FINAL_CHECK_COMMANDS])
    notes = [(cid, n) for cid in FINAL_CHECK_IDS for n in ((_record(fc, cid) or {}).get('notes') or [])]
    if notes:
        lines += ['', '记录中的备注：', '']
        lines += [f'- {cid}：{_one_line(n)}' for cid, n in notes]
    others = [c for c in _records(fc) if c.get('id') not in FINAL_CHECK_IDS]
    if others:
        lines += ['', '其他记录（不属于 Final_Check 的命令集，如任务 19.4 的两次 fixture 运行与一次 real 运行，'
                      '是需求 17.4、17.5 的依据；参与下面的 Playwright 独占核对）：', '']
        lines += _table(header, [_command_row(str(c.get('id')), [], c) for c in others])
    spans, _ = playwright_spans(fc)
    lines += ['', f'Playwright 进程（需求 21.2）：`run` 执行 Playwright 命令前独占创建 `{LOCK_REL}`，锁已存在即拒绝执行；'
                  '本节按记录核对各次 Playwright 运行的执行时间两两不重叠。不经 `run` 直接启动的 Playwright 进程'
                  '不在记录中，本核对覆盖不到。', '']
    lines += [f'- {s[2]}：{s[3]} – {s[4]}' for s in spans] or ['- 无']
    readings = _readings_of(fc)
    lines += ['', '读数记录（需求 21.4，见第 7 节）：' + ('、'.join(
        f'{label}（{(v or {}).get("takenAt", "—") if isinstance(v, Mapping) else "—"}）'
        for label, v in readings.items()) or '无')]
    return lines


def render_stats(run: Optional[Mapping[str, Any]], error: Optional[str]) -> List[str]:
    lines = ['## 3. 各 Library_Profile 的用例统计与跳过清单（`npm run e2e`）', '']
    if run is None:
        return lines + [f'无法统计：{error}']
    rec_results = run.get('startedAt'), run.get('endedAt')
    lines += [f'- 运行开始：{rec_results[0] or "—"}；结束：{rec_results[1] or "—"}；exitCode：{_rc_text(run.get("exitCode"))}；'
              f'selected：{run.get("selected")}', '']
    rows = []
    for s in run.get('stats') or []:
        if not isinstance(s, Mapping):
            continue
        counts = s.get('counts') if isinstance(s.get('counts'), Mapping) else {}
        rows.append([s.get('profile'), '是' if s.get('ran') else '否',
                     *[counts.get(k, 0) for k in acceptance.OUTCOME_ORDER], s.get('notRun', 0), s.get('wallSec')])
    lines += _table(['Profile', '已运行', *[acceptance.OUTCOME_LABELS[k] for k in acceptance.OUTCOME_ORDER], '未执行',
                     '耗时（s）'], rows)
    skipped = [r for r in sorted(acceptance.rows_of(run), key=acceptance.row_label) if r.get('outcome') == 'skipped']
    lines += ['', f'跳过清单（{len(skipped)} 个）：', '']
    if skipped:
        lines += _table(['用例', 'Profile', '类别', '跳过原因'], [
            [acceptance.row_label(r), r.get('profile'), f'[{_skip_of(r)[0]}] '
             f'{acceptance.SKIP_KIND_LABELS.get(_skip_of(r)[0], _skip_of(r)[0])}', _skip_of(r)[1]] for r in skipped])
    else:
        lines.append('- 无')
    visual = [r for r in acceptance.rows_of(run) if acceptance.is_visual_row(r)]
    passed = sum(1 for r in visual if r.get('outcome') == 'passed')
    lines += ['', f'- Visual_Regression_Check（`visual.spec`）：{passed}/{len(visual)} 通过']
    return lines


def render_reviews(inputs: FinalCheckInputs) -> List[str]:
    lines = ['## 4. 基线与截图评审计数（需求 17.2、17.5）', '']
    text = baseline_verdict_text(inputs.baseline_review)
    if text is None:
        lines.append(f'- Pixel_Baseline：{BASELINE_REVIEW_REL} 不存在')
    else:
        counts = Counter(r.verdict for r in acceptance.parse_baseline_review(text))
        lines.append(f'- Pixel_Baseline（`{BASELINE_REVIEW_REL}`）：' + '，'.join(
            f'{v} {counts.get(v, 0)} 张' for v in acceptance.BASELINE_VERDICTS)
            + f'；`{BASELINES_DIR_REL}/` 中 {len(inputs.baseline_files)} 张 PNG')
    lines += ['', 'Review_Record：', '']
    rows = []
    mandatory_rows = []
    for profile, rel_path in REVIEW_RECORD_RELS.items():
        rtext = inputs.review_records.get(profile)
        if rtext is None:
            rows.append([profile, rel_path, '—', '—', '—', '—', '不存在'])
            continue
        record = acceptance.parse_review_record(rtext)
        counts = Counter(v[2] for v in record.verdicts)
        rows.append([profile, rel_path, review_run_id(inputs, record) or f'未匹配（{record.started or "无"}）',
                     *[counts.get(v, 0) for v in acceptance.REVIEW_VERDICTS], len(record.uncaptured)])
        for name, k, label in MANDATORY_CRITERIA.get(profile, ()):
            got = [v[2] for v in record.verdicts if v[0] == name and v[1] == k]
            mandatory_rows.append([profile, f'{name}#{k}', label, '、'.join(got) or '没有判定'])
    lines += _table(['Profile', '记录', '被评审运行', *acceptance.REVIEW_VERDICTS, '未拍摄'], rows)
    lines += ['', '需求 17.5 点名的准则：', '']
    lines += _table(['Profile', '条目', '准则', '判定'], mandatory_rows)
    return lines


def _incomplete_cell(result: Mapping[str, Any]) -> str:
    rules = _rules(result, 'incomplete')
    return '、'.join(f'{x.get("id")} {x.get("nodes")}' for x in rules) or '0'


def render_a11y(run: Optional[Mapping[str, Any]], error: Optional[str]) -> List[str]:
    lines = ['## 5. A11y_Scan 31 次扫描的违规与 incomplete 计数（需求 15.1）', '']
    if run is None:
        return lines + [f'无法列出：{error}']
    data, why = a11y_data(run)
    if data is None:
        return lines + [f'无法列出：{why}']
    lines += [f'- axe-core：{"、".join(map(str, data.get("axeVersions") or [])) or "—"}；`{data.get("specFile", "—")}` '
              f'收集 {data.get("collected", "—")} 个用例。违规按规则计（节点数）；incomplete 为规则 id 与节点数，'
              '只列出、不阻断（需求 15.3）。', '']
    rows = []
    for i, e in enumerate(a11y_entries(data), start=1):
        result = _entry_result(e)
        kind = str(result.get('kind'))
        if kind == 'ok':
            vs = _rules(result, 'violations')
            violations = (f'{len(vs)}（{sum(int(v.get("nodes") or 0) for v in vs)} 节点）' if vs else '0')
            incomplete = _incomplete_cell(result)
        else:
            violations = incomplete = '没有结果'
        theme = str(e.get('theme'))
        rows.append([i, e.get('name'), e.get('view'), THEME_LABELS.get(theme, theme),
                     A11Y_KIND_LABELS.get(kind, kind), violations, incomplete])
    lines += _table(['#', '扫描', '视图', '主题', '结果', '违规', 'incomplete'], rows)
    for p in data.get('problems') or []:
        lines.append(f'- 附件问题：{_one_line(p)}')
    return lines


def render_findings(text: Optional[str]) -> List[str]:
    lines = ['## 6. F-002–F-012 状态（需求 18.2）', '', f'来源：`{FINDINGS_REL}`（每条 `## F-xxx` 标题下的"状态"字段）。', '']
    by_id = {str(f['id']): f for f in parse_finding_statuses(text)}
    return lines + _table(['编号', '标题', '状态'], [
        [fid, (by_id.get(fid) or {}).get('title') or '—',
         (by_id[fid]['status'] or '未写明（视为未修复）') if fid in by_id else '不在 Findings_Log 中']
        for fid in FIXED_FINDINGS])


def render_readings(fc: Mapping[str, Any], snapshot: Optional[Mapping[str, Any]]) -> List[str]:
    readings = _readings_of(fc)
    base = snapshot.get('readings') if isinstance(snapshot, Mapping) else None
    cols = [('Start_Snapshot', base), (READING_START, readings.get(READING_START)), (READING_END, readings.get(READING_END))]
    lines = ['## 7. 读数比较（需求 21.4；EV 18.6）', '']
    lines += [f'- {label}：' + (str(v.get('takenAt', '—')) if isinstance(v, Mapping) else '未记录') for label, v in cols]
    lines.append('')
    rows = []
    for key, label in acceptance.READING_KEYS:
        values = [v.get('values', {}).get(key) if isinstance(v, Mapping) else None for _, v in cols]
        present = all(isinstance(v, Mapping) for _, v in cols)
        verdict = ('一致' if len(set(map(repr, values))) == 1 else '不一致') if present else '无法比较'
        rows.append([label, *[acceptance.reading_text(x) if isinstance(v, Mapping) else '—'
                              for x, (_, v) in zip(values, cols)], verdict])
    return lines + _table(['读数', *[c[0] for c in cols], '比较'], rows)


def render_scope(scope: Optional[Mapping[str, Any]], error: Optional[str]) -> List[str]:
    lines = ['## 8. 改动范围核对（需求 1.5）', '']
    if scope is None:
        return lines + [f'无法核对：{error or "—"}']
    bad_f001 = [f['path'] for f in scope.get('f001') or [] if not f.get('ok')]
    diffs = scope.get('readingDiffs')
    lines += [
        f'- 基准：Start_Snapshot 所记提交 `{scope.get("base")}`；当前 HEAD `{scope.get("headNow")}`'
        f'（{"相同" if scope.get("headUnchanged") else "已变化"}）',
        '- F-001 的 6 个文件：' + ('SHA-256 与起始状态相同' if not bad_f001 else '有变化：' + '、'.join(bad_f001)),
        f'- 受保护路径（{PROTECTED_LABEL}）：' + ('无变化' if not scope.get('protected') else '有变化'),
        '- EV 18.6 读数：' + ('未比较' if diffs is None else '与 Start_Snapshot 一致' if not diffs else f'{len(diffs)} 项不一致'),
        '- 设计"改动文件清单"(d) 行登记：' + ('、'.join(scope.get('registeredD') or []) or '（无）'),
        f'- 结论：{PASS if scope.get("ok") else FAIL}',
    ]
    lines += [f'  - {_one_line(p)}' for p in scope.get('problems') or []]
    changes = scope.get('changes') or []
    lines += ['', f'变化路径（{len(changes)} 个）：', '']
    lines += _table(['路径', '变化', '判定'], [[c['path'], KIND_LABELS.get(c['kind'], c['kind']), scope_verdict(c)]
                                            for c in changes]) if changes else ['- 无']
    return lines


def render_audit(fc: Mapping[str, Any], npmrc: Optional[str]) -> List[str]:
    rec = _record(fc, AUDIT_ID)
    lines = ['## 9. `npm audit`（需求 19.1）', '']
    if rec is None:
        lines.append(f'- 未记录：以 {_run_hint(AUDIT_ID, dict(FINAL_CHECK_COMMANDS)[AUDIT_ID])} 执行。')
    else:
        lines.append(f'- `{_argv_text(rec.get("argv"))}`：{rec.get("startedAt") or "—"} – {rec.get("endedAt") or "—"}，'
                     f'退出码 {_rc_text(rec.get("exitCode"))}')
    lines.append('- 判据：`npm audit` 没有漏洞时以 0 结束，报告任何严重级别（含开发依赖）的漏洞时以非 0 结束。'
                 '`summary` 不运行 npm，以记录的退出码为依据；漏洞明细见该命令执行时的终端输出。'
                 + (f'仓库根 `{NPMRC_REL}` 不存在。' if npmrc is None else f'仓库根 `{NPMRC_REL}` 存在，已核对其中没有 `audit-level`。'
                    if not re.search(r'(?mi)^\s*audit-level\s*=', npmrc) else f'仓库根 `{NPMRC_REL}` 设置了 `audit-level`。')
                 + '用户级与全局 npm 配置未核对。')
    return lines


def render_dependencies(package_json: Optional[str], package_lock: Optional[str]) -> List[str]:
    rows, errors = dependency_rows(package_json, package_lock)
    lines = ['## 10. `package.json` 精确版本与锁文件一致性（需求 19.2、19.3）', '']
    lines += [f'- {e}' for e in errors]
    if rows:
        lines += _table(['分组', '包', 'package.json', '锁文件 packages[""]', '锁文件解析版本', '核对'], [
            [r['section'], r['name'], r['declared'] or '—', r['locked'] or '—', r['resolved'] or '—',
             '；'.join(dependency_row_problems(r)) or '一致'] for r in rows])
    return lines


def cover_text_nodes(run: Optional[Mapping[str, Any]]) -> List[Dict[str, Any]]:
    """D13 人工核对清单：`COVER_SCANS` 每次扫描的 `color-contrast` incomplete 节点。

    每项：`name`、`theme`、`found`（有该扫描的完成结果）、`nodes`（axe 报告的节点数）、`gradient`（失败说明为
    背景渐变的节点数）、`cover`（书卡封面节点数：选择器含渐变类 `from-`）、`examples`（书卡封面节点的前几个
    选择器；没有时取全部节点的前几个）。"""
    data, _ = a11y_data(run)
    by_name = {str(e.get('name')): e for e in a11y_entries(data)}
    out: List[Dict[str, Any]] = []
    for name in COVER_SCANS:
        entry = by_name.get(name)
        result = _entry_result(entry) if entry else {}
        item: Dict[str, Any] = {'name': name, 'theme': str(entry.get('theme')) if entry else '—',
                                'found': result.get('kind') == 'ok', 'nodes': 0, 'gradient': 0, 'cover': 0,
                                'examples': []}
        rule = next((x for x in _rules(result, 'incomplete') if x.get('id') == COLOR_CONTRAST), None)
        if rule is not None:
            details = [d for d in rule.get('details') or [] if isinstance(d, Mapping)]
            targets = [' '.join(str(t) for t in d.get('target') or []) for d in details]
            covers = [t for t in targets if COVER_SELECTOR_MARK in t]
            item.update(nodes=int(rule.get('nodes') or 0),
                        gradient=sum(1 for d in details if GRADIENT_MARK in str(d.get('failureSummary') or '')),
                        cover=len(covers), examples=(covers or targets)[:COVER_EXAMPLES])
        out.append(item)
    return out


def render_manual(inputs: FinalCheckInputs, run: Optional[Mapping[str, Any]], error: Optional[str]) -> List[str]:
    lines = ['## 11. 人工核对清单', '', '以下条目交由用户人工核对，不影响第 1 节的结论。', '',
             '### 11.1 书卡封面白字压在渐变上（D13）', '',
             'axe 无法对渐变背景给出对比度判定，把这些节点报为 `color-contrast` 的 incomplete；本 spec 不修改（D13）。'
             '下表取自 `npm run e2e` 的 A11y_Scan 数据。"书卡封面"指选择器含 Tailwind 渐变类 `from-` 的节点，'
             '其余为书架横幅等节点。其他扫描的 incomplete 见第 5 节。', '']
    if run is None:
        lines.append(f'- 无法列出：{error}')
    else:
        items = cover_text_nodes(run)
        lines += _table(['扫描', '主题', 'color-contrast incomplete 节点数', '其中背景为渐变', '其中书卡封面'], [
            [i['name'], THEME_LABELS.get(i['theme'], i['theme']), i['nodes'] if i['found'] else '没有结果',
             i['gradient'], i['cover']] for i in items])
        lines += ['', f'示例选择器（每次扫描取书卡封面节点的前 {COVER_EXAMPLES} 个）：', '']
        for i in items:
            examples = '；'.join(_code(t) for t in i['examples']) or '—'
            lines.append(f'- `{i["name"]}`：{examples}')
    pending: List[List[Any]] = []
    for profile, _rel in REVIEW_RECORD_RELS.items():
        text = inputs.review_records.get(profile)
        if text is None:
            continue
        record = acceptance.parse_review_record(text)
        pending += [[profile, f'{p[0]}#{p[1]}', p[2]] for p in record.pending]
        listed = {(p[0], p[1]) for p in record.pending}
        pending += [[profile, f'{v[0]}#{v[1]}', f'判为"无法判断"：{v[3]}'] for v in record.verdicts
                    if v[2] == '无法判断' and (v[0], v[1]) not in listed]
    lines += ['', '### 11.2 Review_Record 的待人工复核条目', '']
    lines += _table(['Profile', '条目', '原因'], pending) if pending else ['- 无']
    limits = real_limit_cases(run) if run is not None else []
    lines += ['', '### 11.3 按用户决定接受的数据限制（EV 风险 R5）', '']
    lines += _table(['用例', '类别', '跳过原因'], [[a['case'], f'[{a["kind"]}]', a['reason']] for a in limits]) \
        if limits else ['- 无' if run is not None else f'- 无法列出：{error}']
    return lines


def render_acceptance(inputs: FinalCheckInputs, conclusion: str, items: Sequence[CheckItem], generated_at: str) -> str:
    """`acceptance.md` 的全文（纯函数，节序同需求 21.5）。"""
    run, error = e2e_run(inputs)
    lines = ['# 验收小结：阅读器缺陷修复与 E2E 跟进（reader-defect-fixes）', '',
             f'由 `{SELF} summary` 于 {generated_at} 生成。节序同需求 21.5。', '']
    sections = (
        render_conclusion(conclusion, items),
        render_commands(inputs),
        render_stats(run, error),
        render_reviews(inputs),
        render_a11y(run, error),
        render_findings(inputs.findings),
        render_readings(inputs.final_check, inputs.snapshot),
        render_scope(inputs.scope, inputs.scope_error),
        render_audit(inputs.final_check, inputs.npmrc),
        render_dependencies(inputs.package_json, inputs.package_lock),
        render_manual(inputs, run, error),
    )
    for section in sections:
        lines += [*section, '']
    return '\n'.join(lines)


# --- 读取与子命令 ---------------------------------------------------------------


def _file_names(directory: Path, pattern: str, recursive: bool = False) -> List[str]:
    if not directory.is_dir():
        return []
    found = directory.rglob(pattern) if recursive else directory.glob(pattern)
    return sorted(p.name for p in found if p.is_file())


def collect_final_check_inputs(root: Path = REPO_ROOT) -> FinalCheckInputs:
    """从磁盘读出 `summary` 的全部输入；`final-check.json` 无法解析时报错（不改写它）。"""
    fc = load_final_check(root)
    snapshot: Optional[Dict[str, Any]] = None
    scope: Optional[Dict[str, Any]] = None
    scope_error: Optional[str] = None
    try:
        snapshot = load_snapshot(root)
        scope = collect_scope(root, snapshot)
    except AcceptanceError as exc:
        scope_error = str(exc)
    results: Dict[str, Optional[Mapping[str, Any]]] = {}
    reports: Dict[str, Optional[Mapping[str, Any]]] = {}
    mds: Dict[str, Optional[str]] = {}
    for c in _records(fc):
        cid = str(c.get('id'))
        if not _RUN_ID.fullmatch(cid):
            continue
        path = c.get('results')
        value = acceptance.load_json(root / path) if isinstance(path, str) and path else None
        results[cid] = value if isinstance(value, Mapping) else None
        review_dir = root / FINAL_CHECK_DIR_REL / f'{cid}-review'
        report = acceptance.load_json(review_dir / 'review-report.json')
        reports[cid] = report if isinstance(report, Mapping) else None
        mds[cid] = acceptance.read_text(review_dir / 'review-report.md')
    run8 = acceptance.load_json(root / EV_RUN8_REL)
    ev_limits = [a['case'] for a in real_limit_cases(run8)] if isinstance(run8, Mapping) else None
    return FinalCheckInputs(
        final_check=fc,
        snapshot=snapshot,
        results=results,
        review_reports=reports,
        review_mds=mds,
        scope=scope,
        scope_error=scope_error,
        baseline_review=acceptance.read_text(root / BASELINE_REVIEW_REL),
        baseline_files=_file_names(root / BASELINES_DIR_REL, '*.png'),
        baselines_ts=acceptance.read_text(root / BASELINES_TS_REL),
        review_records={p: acceptance.read_text(root / r) for p, r in REVIEW_RECORD_RELS.items()},
        findings=acceptance.read_text(root / FINDINGS_REL),
        evidence=_file_names(root / FINDINGS_DIR_REL, '*', recursive=True),
        package_json=acceptance.read_text(root / 'package.json'),
        package_lock=acceptance.read_text(root / 'package-lock.json'),
        ev_real_limits=ev_limits,
        lock_present=(root / LOCK_REL).exists(),
        npmrc=acceptance.read_text(root / NPMRC_REL),
    )


def cmd_summary(root: Path = REPO_ROOT) -> int:
    inputs = collect_final_check_inputs(root)
    conclusion, items = evaluate_final_check(inputs)
    acceptance.write_text(root / ACCEPTANCE_REL, render_acceptance(inputs, conclusion, items,
                                                                   acceptance.iso(acceptance.now_local())))
    print(f'验收小结已写入 {ACCEPTANCE_REL}；结论：{conclusion}')
    for item in items:
        print(f'  [{PASS if item.ok else FAIL}] {item.key} {item.title}' + (f'：{"；".join(item.facts)}' if item.facts else ''))
        for p in item.problems:
            print(f'      - {_one_line(p)}')
    return 0 if conclusion == PASS else 1


# ---------------------------------------------------------------------------
# 命令行
# ---------------------------------------------------------------------------


def split_run_argv(argv: Sequence[str]) -> Tuple[List[str], Optional[List[str]]]:
    """`run <id> -- <命令…>`：在第一个 `--` 处切开（命令自己的 `--` 原样保留）。其余子命令不切。"""
    args = list(argv)
    if args[:1] == ['run'] and '--' in args:
        i = args.index('--')
        return args[:i], args[i + 1:]
    return args, None


def parse_args(argv: Optional[Sequence[str]]) -> argparse.Namespace:
    own, command = split_run_argv(sys.argv[1:] if argv is None else argv)
    parser = argparse.ArgumentParser(
        prog=SELF, description='reader-defect-fixes 的起始快照、改动范围核对与收尾记录（需求 1、17.4、21）。'
                               '规则见本文件头部的说明。')
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('snapshot', help=f'写 {SNAPSHOT_REL}（需求 1.2、1.6）')
    p = sub.add_parser('scope', help='以 Start_Snapshot 为基准核对改动范围（需求 1.3–1.5）')
    p.add_argument('--json', dest='json_out', help='把核对结果另写成 JSON（相对当前目录）')
    p = sub.add_parser('run', usage=f'{SELF} run <id> -- <命令…>',
                       help=f'执行一条命令并把开始 / 结束时间与退出码记入 {FINAL_CHECK_REL}（需求 21.1、21.2）')
    p.add_argument('id', help='记录的 id（每个 id 只记一次；也用作 final-check/<id>-results.json 的文件名）')
    p = sub.add_parser('readings', help=f'把 EV 18.6 读数以 label 记入 {FINAL_CHECK_REL}（需求 21.4）')
    p.add_argument('label', help='读数的标签，如 start、end（每个 label 只记一次）')
    p = sub.add_parser('compare-runs', help='比较 final-check/<id1>-results.json 与 <id2>-results.json（需求 17.4）')
    p.add_argument('id1')
    p.add_argument('id2')
    sub.add_parser('summary', help=f'写 {ACCEPTANCE_REL}（需求 21.5、21.6）；结论为"通过"时退出码 0，否则 1')
    args = parser.parse_args(own)
    if args.command == 'run':
        if not command:
            parser.error(f'run 需要 -- 之后的命令：{SELF} run <id> -- <命令…>')
        args.argv = command
    elif command is not None:  # pragma: no cover  split_run_argv 只对 run 切开
        parser.error('只有 run 接受 -- 之后的命令')
    return args


def main(argv: Optional[Sequence[str]] = None) -> int:
    acceptance._force_utf8(sys.stdout)
    acceptance._force_utf8(sys.stderr)
    args = parse_args(argv)
    try:
        if args.command == 'snapshot':
            return cmd_snapshot()
        if args.command == 'run':
            return cmd_run(args.id, args.argv)
        if args.command == 'readings':
            return cmd_readings(args.label)
        if args.command == 'compare-runs':
            return cmd_compare_runs(args.id1, args.id2)
        if args.command == 'summary':
            return cmd_summary()
        return cmd_scope(json_out=args.json_out)
    except AcceptanceError as exc:
        print(f'错误：{exc}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
