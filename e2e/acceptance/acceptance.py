#!/usr/bin/env python3
"""Acceptance_Run 助手（需求 18，另含 16.5；设计"整体验收运行"）。

只用 Python 标准库：阶段 1 装依赖之前也能运行，18.6 的读数也能在任何 npm 包安装之前取得。子进程一律
以参数列表启动，不经 shell；`npm` 经 `shutil.which` 解析（Windows 上为 `npm.cmd`），`python` 取
运行本脚本的解释器（`sys.executable`）。捕获的 git 输出按 UTF-8 解码（`errors="replace"`）。

全部记录写在 `.kiro/specs/e2e-visual-testing/` 下，只存本机（D10，已列入 `.gitignore`）。任何一次
E2E 运行都不读写它们（13.9）。

命令
----

    python e2e/acceptance/acceptance.py readings --out <file>           # 18.6 读数
    python e2e/acceptance/acceptance.py stage run <n>                   # 运行型阶段 1–4、6、8、10
    python e2e/acceptance/acceptance.py stage begin <n> [--terminate]   # 人工阶段 5、7、9、11；--terminate 仅限 11
    python e2e/acceptance/acceptance.py stage end <n> --result 完成|失败|中断 [--note <文字>]
    python e2e/acceptance/acceptance.py status                          # 各阶段状态、失效原因、下一步
    python e2e/acceptance/acceptance.py scope                           # 16.5 改动范围核对（只打印）
    python e2e/acceptance/acceptance.py summary                         # 写 acceptance.md（18.7）

退出码：0 成功（`scope` 为核对通过）；1 阶段失败、核对未通过或拒绝开始；2 用法错误。

阶段与判定
----------

- 各阶段的命令只在 `STAGES` 表里定义一次。`stage run` 逐条执行，记下开始与结束时间和每条命令的
  退出码；有命令非 0 时记"失败"并注明该命令（阶段 10 仍执行其余命令，18.8），遇 `KeyboardInterrupt`
  记"中断"。命令都以 0 结束后，阶段 4、6、8 再按 `judge_4`、`judge_6`、`judge_8` 判定，不通过记"失败"，
  逐条问题写入 `stages.json` 的 `problems`。
- 用户决定（验收前，风险 R5）：`judge_8` 另允许按 [4.7] / [8.13] 跳过（真实书库的数据限制），这些用例
  写入阶段 8 记录的 `accepted`，并作为"按用户决定接受的数据限制"列入 `acceptance.md` 与待人工复核清单；
  其余跳过类别仍不通过。
- 用户决定（验收前，16.5）：`PRE_EXISTING_FILES` 的路径与 `PRE_EXISTING_PACKAGE_CHANGES` 的 package.json
  改动是规格开始前已存在的改动，`scope` 列出但不计入核对。
- 人工阶段以 `stage begin` 开始、`stage end` 结束。`--result 完成` 时先做该阶段的核对（见下），核对不
  通过则拒绝结束并列出问题，执行保持"进行中"，修正记录后再次 `stage end`，或以"失败 / 中断"结束。
- 运行型阶段只能由 `stage run` 判定完成；进程被强行结束而遗留"进行中"的执行，用
  `stage end <n> --result 中断` 关闭。
- 同一时刻只能有一次执行"进行中"：另一阶段开始前须先结束它。
- 前置（18.1）：`stage run` / `stage begin` 在任一前序阶段未"有效完成"时拒绝开始，并打印 `status`
  给出的下一步。有效完成指最后一次执行记为"完成"，且未被下面的失效规则作废。阶段 11 在阶段 1–10
  都有效完成后开始；用户决定终止验收时以 `stage begin 11 --terminate` 开始，不检查前置。阶段 1 另要求
  `acceptance/readings-before.json` 已存在（18.6）。阶段 1–10 已有效完成时不重跑（18.10）。
- 运行型阶段的每条 Playwright 命令结束后，把 `e2e/.out/` 中本次运行写出的 `results.json`、
  `summary.md`、`review/review-report.json`、`perf.json` 与 `a11y/*.json` 按 `STAGES` 表复制进
  `acceptance/`（`run-3.json`、`run-4.json`、`run-6-1.json`、`run-6-2.json`、`run-8.json`、
  `summary-<阶段>[-<次>].md`、`review-report-fixture.json`、`review-report-real.json`、`perf.json`、
  `a11y/`）。只复制修改时间不早于该命令开始的文件，避免把上一次运行的残留当成本次结果；阶段开始时先
  删除该阶段上一次执行复制的文件。

失效（18.10）
-------------

锚点阶段完成时记下摘要值（阶段 3、4 在执行开始时计算，阶段 5 在 `stage end 5` 时计算），`status`
与当前值比较：

- `fixtureDigest`：`e2e/fixture/generate.py` 的 `source_digest()`，锚点阶段 4。变化即作废阶段 4 及以后。
- `baselineDigest`：`e2e/baselines/` 下按相对路径排序的名称与字节的 SHA-256，锚点阶段 5。变化即作废
  阶段 5 及以后。
- `suiteDigest`：`git ls-files -co --exclude-standard -- e2e playwright.config.ts` 所列文件（排除
  `e2e/baselines/` 与 `e2e/acceptance/`）的路径与内容的 SHA-256，锚点阶段 3。变化即作废阶段 3，以及
  阶段 6 起所有已完成的阶段。
- 多条规则同时命中时取并集。
- "从某阶段起重跑"的落实：锚点阶段重新完成后，规则范围内在它之前完成的阶段一并作废（阶段 3 重跑
  不作废阶段 4、5，与 18.10 一致）。
- 产物覆盖：阶段 7（9）尚未有效完成时，若 `e2e/.out/results.json` 的 `startedAt` 已不等于
  `run-6-2.json`（`run-8.json`）的 `startedAt`，即阶段 6（8）之后又发生过运行、`e2e/.out/review/`
  已被清空（13.5），阶段 6（8）作废，须重跑后再评审。

人工阶段的核对
--------------

阶段 5（`baseline-review.md`，18.2）：每张基线一行，单元格以 `|` 分隔（Markdown 表格行或普通行均可）：

    <文件名> | 接受/含已知缺陷接受/重拍 | 依据 | F-xxx | Reviewer | 日期

`e2e/baselines/` 的每个 PNG 恰有一行，不含目录中不存在的文件；没有"重拍"；依据、Reviewer、日期非空；
"含已知缺陷接受"须引用 `findings.md` 中存在的 Finding，且该编号出现在 `e2e/visual/baselines.ts` 中（18.9）。

阶段 7 / 9（`review-record-fixture.md` / `review-record-real.md`，设计 Data Models"Review_Record"）：

    # Review_Record：fixture
    - 所评 Review_Report 的运行开始时间：<results.json 的 startedAt 原样>
    - Reviewer：AI 模型（Kiro，模型：…）
    - 评审日期：<日期>

    ## 判定
    <名称>#<准则号> | 通过/不通过/无法判断 | 依据（≤200 字） | F-xxx（仅"不通过"必填）
    <名称> | 未拍摄 | <13.4 的原因>

    ## 待人工复核
    <名称>#<准则号> | 原因

名称为 Review_Catalog 的 `name`（如 `bookshelf-skeleton`），可包在反引号里。核对：`e2e/.out/review/
review-report.md` 与记录开头的运行开始时间都等于 `run-6-2.json`（`run-8.json`）的 `startedAt`；该
Library_Profile 的每张已拍摄 Review_Shot 每条准则恰有 1 个判定，未拍摄的恰有 1 行且带原因；"不通过"引用的
Finding 存在于 `findings.md`，`findings/` 中有以该编号开头的证据文件；"无法判断"全部列入"待人工复核"。

阶段 11：`acceptance/readings-after.json` 与 `acceptance.md` 都在本次执行开始后写出。

记录文件
--------

- `acceptance/stages.json`：`{"version": 1, "executions": [...]}`。每次执行一项：`stage`、`attempt`
  （该阶段第几次执行）、`startedAt` / `endedAt`（本机本地时间，带 UTC 偏移）、`startedEpoch` /
  `endedEpoch`、`commands`（`command`、`startedAt`、`endedAt`、`durationSec`、`exitCode`）、`result`
  （完成 / 失败 / 中断；进行中为 null）、`notes`、`problems`、`reports`（相对仓库根的路径）、`digests`、
  `accepted`（仅阶段 8：按用户决定接受的数据限制）、`terminate`（仅阶段 11）。
- `acceptance-log.md`：由 `stages.json` 渲染的阶段表，每次写 `stages.json` 时一并重写。
- `acceptance/readings-before.json` / `readings-after.json`：`{"version": 1, "takenAt": ..., "values":
  {...}}`，键见 `READING_KEYS`；文件或目录不存在时值为 null。
- `acceptance.md`：`summary` 生成的验收小结，节序同 18.7。
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, NamedTuple, Optional, Sequence, Set, Tuple

# ---------------------------------------------------------------------------
# 路径
# ---------------------------------------------------------------------------

ACCEPTANCE_PY_DIR = Path(__file__).resolve().parent
REPO_ROOT = ACCEPTANCE_PY_DIR.parent.parent

SPEC_DIR = REPO_ROOT / '.kiro' / 'specs' / 'e2e-visual-testing'
ACC_DIR = SPEC_DIR / 'acceptance'
STAGES_FILE = ACC_DIR / 'stages.json'
LOG_FILE = SPEC_DIR / 'acceptance-log.md'
SUMMARY_FILE = SPEC_DIR / 'acceptance.md'
BASE_COMMIT_FILE = ACC_DIR / 'base-commit.txt'
READINGS_BEFORE = ACC_DIR / 'readings-before.json'
READINGS_AFTER = ACC_DIR / 'readings-after.json'
BASELINE_REVIEW_FILE = SPEC_DIR / 'baseline-review.md'
REVIEW_RECORD_FILES = {
    'fixture': SPEC_DIR / 'review-record-fixture.md',
    'real': SPEC_DIR / 'review-record-real.md',
}
FINDINGS_FILE = SPEC_DIR / 'findings.md'
FINDINGS_DIR = SPEC_DIR / 'findings'

OUT_DIR = REPO_ROOT / 'e2e' / '.out'
OUT_RESULTS = OUT_DIR / 'results.json'
OUT_SUMMARY = OUT_DIR / 'summary.md'
OUT_REVIEW_JSON = OUT_DIR / 'review' / 'review-report.json'
OUT_REVIEW_MD = OUT_DIR / 'review' / 'review-report.md'
OUT_PERF = OUT_DIR / 'perf.json'
OUT_A11Y = OUT_DIR / 'a11y'

BASELINE_DIR = REPO_ROOT / 'e2e' / 'baselines'
BASELINES_TS = REPO_ROOT / 'e2e' / 'visual' / 'baselines.ts'
GENERATE_PY = REPO_ROOT / 'e2e' / 'fixture' / 'generate.py'

#: 本脚本的调用写法（打印"下一步"时用）。
SELF = 'python e2e/acceptance/acceptance.py'

#: 复制产物时允许的时钟误差（秒）：修改时间不早于命令开始前这么久的文件才算本次运行写出。
FRESH_TOLERANCE_S = 1.0

# ---------------------------------------------------------------------------
# 通用工具
# ---------------------------------------------------------------------------


class AcceptanceError(Exception):
    """可预期的错误：打印信息后以退出码 1 结束。"""


def _force_utf8(stream: Any) -> None:
    """Windows 控制台默认 cp936；阶段名、书名与判定都是 UTF-8 文本。"""
    if stream is None or not hasattr(stream, 'reconfigure'):
        return
    try:
        stream.reconfigure(encoding='utf-8')
    except Exception:
        pass


def now_local() -> datetime:
    return datetime.now().astimezone()


def iso(dt: datetime) -> str:
    """本机本地时间，带 UTC 偏移，精确到秒。"""
    return dt.isoformat(timespec='seconds')


def rel(path: Path) -> str:
    """相对仓库根、以 `/` 分隔的路径；不在仓库内时原样返回。"""
    try:
        return path.resolve().relative_to(REPO_ROOT).as_posix()
    except ValueError:
        return str(path)


def load_json(path: Path) -> Optional[Any]:
    """读 UTF-8 JSON；文件不存在或无法解析时为 None。"""
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None


def read_text(path: Path) -> Optional[str]:
    try:
        return path.read_text(encoding='utf-8', errors='replace')
    except OSError:
        return None


def write_text(path: Path, text: str) -> None:
    """写 UTF-8、LF；先写临时文件再替换。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f'{path.name}.tmp{os.getpid()}')
    with open(tmp, 'w', encoding='utf-8', newline='\n') as handle:
        handle.write(text)
    os.replace(tmp, path)


def write_json(path: Path, payload: Any) -> None:
    write_text(path, json.dumps(payload, ensure_ascii=False, indent=2) + '\n')


def short(digest: Optional[str]) -> str:
    return '（无）' if not digest else digest[:12]


def md_cell(text: Any) -> str:
    """Markdown 表格单元格：去掉换行、转义 `|`；空值写"—"。"""
    s = '' if text is None else str(text)
    s = re.sub(r'\s*[\r\n]+\s*', ' ', s).strip().replace('|', '\\|')
    return s or '—'


def md_row(cells: Sequence[Any]) -> str:
    return '| ' + ' | '.join(md_cell(c) for c in cells) + ' |'


def md_table(header: Sequence[str], rows: Iterable[Sequence[Any]]) -> List[str]:
    lines = [md_row(header), '| ' + ' | '.join('---' for _ in header) + ' |']
    lines += [md_row(r) for r in rows]
    return lines


def code(text: str) -> str:
    return f'`{text}`'


def started_of(run: Optional[Mapping[str, Any]]) -> Optional[str]:
    """`results.json`（RunSummaryModel）或 `review-report.json` 的 `startedAt`。"""
    if not isinstance(run, Mapping):
        return None
    value = run.get('startedAt')
    return value if isinstance(value, str) and value else None


FINDING_ID = re.compile(r'F-\d{3,}')


def finding_ids_in(text: Optional[str]) -> List[str]:
    """按首次出现的顺序、去重（与 `summary.ts` 的 `findingIds` 同一写法）。"""
    out: List[str] = []
    for fid in FINDING_ID.findall(text or ''):
        if fid not in out:
            out.append(fid)
    return out


# ---------------------------------------------------------------------------
# 阶段表（18.1；设计"阶段"）
# ---------------------------------------------------------------------------

RESULT_DONE = '完成'
RESULT_FAILED = '失败'
RESULT_INTERRUPTED = '中断'
RESULTS = (RESULT_DONE, RESULT_FAILED, RESULT_INTERRUPTED)
STATUS_NONE = '未执行'
STATUS_OPEN = '进行中'


@dataclass(frozen=True)
class Copy:
    """一条 Playwright 命令结束后从 `e2e/.out/` 复制进 `acceptance/` 的产物（目标文件名）。"""

    results: str
    summary: str
    review: Optional[str] = None
    perf: Optional[str] = None
    a11y: Optional[str] = None

    def targets(self) -> List[str]:
        return [t for t in (self.results, self.summary, self.review, self.perf, self.a11y) if t]


@dataclass(frozen=True)
class Cmd:
    program: str                 # 'npm' | 'python'
    args: Tuple[str, ...]
    copy: Optional[Copy] = None

    @property
    def display(self) -> str:
        return ' '.join((self.program, *self.args))


@dataclass(frozen=True)
class Stage:
    n: int
    title: str
    manual: bool
    done_when: str
    commands: Tuple[Cmd, ...] = ()
    #: 某条命令非 0 时仍执行其余命令（阶段 10：逐条注明失败的命令，18.8）。
    run_all: bool = False
    #: 执行命令前删除 `e2e/baselines/*.png`（阶段 4：全部重新写入，18.1 (4)）。
    delete_baselines: bool = False
    #: 命令都以 0 结束后调用的判定（4、6、8）。
    judge: Optional[int] = None
    #: 人工阶段在阶段记录"命令"一栏的写法。
    manual_desc: str = ''
    #: 人工阶段的报告（相对仓库根）。
    manual_reports: Tuple[str, ...] = ()


_PW_FIXTURE = ('run', 'e2e:profile', '--', '--profile', 'fixture')

STAGES: Tuple[Stage, ...] = (
    Stage(1, '安装依赖与 Chromium', False, '三条命令退出码均为 0', commands=(
        Cmd('npm', ('ci',)),
        Cmd('python', ('-m', 'pip', 'install', '-r', 'scripts/requirements.txt')),
        Cmd('npm', ('run', 'e2e:install')),
    )),
    Stage(2, '生成 Fixture_Library', False, '两条命令退出码均为 0（含属性 4 的确定性核对）', commands=(
        Cmd('npm', ('run', 'e2e:fixture')),
        Cmd('python', ('e2e/fixture/generate.py', '--verify-determinism')),
    )),
    Stage(3, '服务器自检', False, '退出码为 0', commands=(
        Cmd('npm', ('run', 'e2e', '--', '-g', '@selfcheck'), Copy('run-3.json', 'summary-3.md')),
    )),
    Stage(4, '重新生成全部 Pixel_Baseline', False,
          '先删除 e2e/baselines/*.png；退出码为 0，且 results.json 中 visual.spec 的每行都是通过',
          commands=(Cmd('npm', ('run', 'e2e:update'), Copy('run-4.json', 'summary-4.md')),),
          delete_baselines=True, judge=4),
    Stage(5, '评审 Pixel_Baseline', True,
          'baseline-review.md：基线目录的每个文件恰有一行，没有“重拍”',
          manual_desc='Kiro 逐张读取 e2e/baselines/*.png，写 baseline-review.md',
          manual_reports=(rel(BASELINE_REVIEW_FILE),)),
    Stage(6, 'fixture 连续两次非更新运行', False, 'judge 6 通过（18.3）', commands=(
        Cmd('npm', _PW_FIXTURE, Copy('run-6-1.json', 'summary-6-1.md')),
        Cmd('npm', _PW_FIXTURE, Copy('run-6-2.json', 'summary-6-2.md',
                                     review='review-report-fixture.json', a11y='a11y')),
    ), judge=6),
    Stage(7, '评审 fixture 的 Review_Shot', True, 'review-record-fixture.md 通过核对（18.5）',
          manual_desc='Kiro 读阶段 6 第二次运行的 review-report.md 与 PNG，写 review-record-fixture.md',
          manual_reports=(rel(REVIEW_RECORD_FILES['fixture']),)),
    Stage(8, 'real 运行', False, 'judge 8 通过（18.4）', commands=(
        Cmd('npm', ('run', 'e2e:profile', '--', '--profile', 'real'),
            Copy('run-8.json', 'summary-8.md', review='review-report-real.json', perf='perf.json')),
    ), judge=8),
    Stage(9, '评审 real 的 Review_Shot', True, 'review-record-real.md 通过核对（18.5）',
          manual_desc='Kiro 读阶段 8 的 review-report.md 与 PNG，写 review-record-real.md',
          manual_reports=(rel(REVIEW_RECORD_FILES['real']),)),
    Stage(10, 'Existing_Gates', False, '五条命令退出码均为 0（18.8）', commands=(
        Cmd('npm', ('run', 'typecheck')),
        Cmd('npm', ('run', 'lint')),
        Cmd('npm', ('run', 'build')),
        Cmd('npm', ('run', 'test')),
        Cmd('python', ('-m', 'pytest', 'scripts/tests', '-q')),
    ), run_all=True),
    Stage(11, '验收小结', True, 'readings-after.json 与 acceptance.md 在本次执行开始后写出',
          manual_desc='readings --out …/readings-after.json；scope；summary',
          manual_reports=(rel(READINGS_AFTER), rel(SUMMARY_FILE))),
)

STAGE_BY_N: Dict[int, Stage] = {s.n: s for s in STAGES}
STAGE_NUMBERS: Tuple[int, ...] = tuple(s.n for s in STAGES)
LAST_STAGE = STAGE_NUMBERS[-1]

#: 阶段 6、8 复制的结果文件与对应的评审阶段（产物覆盖规则、阶段 7 / 9 的核对）。
RUN_FOR_REVIEW: Dict[int, Tuple[int, str, str]] = {
    # 评审阶段: (运行阶段, 结果文件名, Library_Profile)
    7: (6, 'run-6-2.json', 'fixture'),
    9: (8, 'run-8.json', 'real'),
}


# ---------------------------------------------------------------------------
# 18.6 读数
# ---------------------------------------------------------------------------

#: 读数的键与写法（18.6）。修改时间取 `st_mtime_ns`，按文件系统报告的完整精度比较。
READING_KEYS: Tuple[Tuple[str, str], ...] = (
    ('booksJson.size', 'public/data/books.json 大小（字节）'),
    ('booksJson.mtimeNs', 'public/data/books.json 最后修改时间（st_mtime_ns）'),
    ('booksDir.files', 'public/books/ 文件数'),
    ('booksDir.bytes', 'public/books/ 总字节数'),
    ('manifest.size', '.preprocess-manifest.json 大小（字节）'),
    ('manifest.mtimeNs', '.preprocess-manifest.json 最后修改时间（st_mtime_ns）'),
)
READING_LABELS: Dict[str, str] = dict(READING_KEYS)


def _file_reading(path: Path) -> Tuple[Optional[int], Optional[int]]:
    try:
        st = os.stat(path)
    except OSError:
        return None, None
    return st.st_size, st.st_mtime_ns


def _dir_reading(root: Path) -> Tuple[Optional[int], Optional[int]]:
    """递归统计文件数与总字节数（不跟随符号链接）；目录不存在时为 (None, None)。"""
    if not root.is_dir():
        return None, None
    files = total = 0
    stack = [str(root)]
    while stack:
        with os.scandir(stack.pop()) as it:
            for entry in it:
                if entry.is_dir(follow_symlinks=False):
                    stack.append(entry.path)
                else:
                    files += 1
                    total += entry.stat(follow_symlinks=False).st_size
    return files, total


def take_readings(root: Path = REPO_ROOT) -> Dict[str, Any]:
    books_size, books_mtime = _file_reading(root / 'public' / 'data' / 'books.json')
    dir_files, dir_bytes = _dir_reading(root / 'public' / 'books')
    man_size, man_mtime = _file_reading(root / '.preprocess-manifest.json')
    values = {
        'booksJson.size': books_size,
        'booksJson.mtimeNs': books_mtime,
        'booksDir.files': dir_files,
        'booksDir.bytes': dir_bytes,
        'manifest.size': man_size,
        'manifest.mtimeNs': man_mtime,
    }
    return {'version': 1, 'takenAt': iso(now_local()), 'values': values}


class ReadingDiff(NamedTuple):
    key: str
    label: str
    before: Any
    after: Any


def compare_readings(before: Mapping[str, Any], after: Mapping[str, Any]) -> List[ReadingDiff]:
    """18.6：逐项比较两次读数，返回不一致项及其两次取值（按 `READING_KEYS` 的顺序）。

    参数为读数文件的内容（含 `values`）或直接是 `values`。某项在一侧缺失按 None 比较；两侧都为 None
    （文件两次都不存在）算一致。
    """
    b = before.get('values', before) if isinstance(before, Mapping) else {}
    a = after.get('values', after) if isinstance(after, Mapping) else {}
    out: List[ReadingDiff] = []
    for key, label in READING_KEYS:
        bv, av = b.get(key), a.get(key)
        if bv != av:
            out.append(ReadingDiff(key, label, bv, av))
    return out


def reading_text(value: Any) -> str:
    return '不存在' if value is None else str(value)


# ---------------------------------------------------------------------------
# 摘要值（18.10）
# ---------------------------------------------------------------------------

DIGEST_SCHEME_BASELINE = 'acceptance-baselines-v1'
DIGEST_SCHEME_SUITE = 'acceptance-suite-v1'

#: suiteDigest 覆盖的路径与排除的前缀。`e2e/acceptance/` 是验收助手本身，不属于 E2E_Suite：修正它不应
#: 作废阶段 3 与阶段 6 起的运行。
SUITE_PATHSPEC = ('e2e', 'playwright.config.ts')
SUITE_EXCLUDE_PREFIXES = ('e2e/baselines/', 'e2e/acceptance/')


def _digest_files(scheme: str, entries: Iterable[Tuple[str, Optional[bytes]]]) -> str:
    """按给定顺序把"相对路径、字节数、内容"写入 SHA-256；内容为 None 表示文件已删除。"""
    h = hashlib.sha256()
    h.update(f'{scheme}\n'.encode('utf-8'))
    for name, data in entries:
        if data is None:
            h.update(f'{name}\n<deleted>\n'.encode('utf-8'))
            continue
        h.update(f'{name}\n{len(data)}\n'.encode('utf-8'))
        h.update(data)
        h.update(b'\n')
    return h.hexdigest()


def _read_bytes(path: Path) -> Optional[bytes]:
    try:
        return path.read_bytes()
    except OSError:
        return None


_FIXTURE_MODULE: Any = None


def fixture_digest() -> str:
    """复用 `generate.py` 的 `source_digest()`（按路径加载，只用标准库）。"""
    global _FIXTURE_MODULE
    if _FIXTURE_MODULE is None:
        spec = importlib.util.spec_from_file_location('_acceptance_fixture_generate', GENERATE_PY)
        if spec is None or spec.loader is None:
            raise AcceptanceError(f'无法加载 {rel(GENERATE_PY)}')
        module = importlib.util.module_from_spec(spec)
        # generate.py 定义了 dataclass，执行前须登记在 sys.modules 中（dataclasses 按 __module__ 查找）。
        sys.modules[spec.name] = module
        try:
            spec.loader.exec_module(module)
        except BaseException:
            sys.modules.pop(spec.name, None)
            raise
        _FIXTURE_MODULE = module
    return str(_FIXTURE_MODULE.source_digest())


def baseline_digest(root: Path = BASELINE_DIR) -> str:
    """`e2e/baselines/` 下全部文件按相对路径排序的名称与字节；目录不存在时为空清单的摘要。"""
    files: List[Tuple[str, Path]] = []
    if root.is_dir():
        for path in root.rglob('*'):
            if path.is_file():
                files.append((path.relative_to(root).as_posix(), path))
    files.sort(key=lambda item: item[0])
    return _digest_files(DIGEST_SCHEME_BASELINE, ((name, _read_bytes(p)) for name, p in files))


def suite_paths(listing: Iterable[str]) -> List[str]:
    """`git ls-files` 的输出 → suiteDigest 覆盖的路径（去重、排序、排除 `SUITE_EXCLUDE_PREFIXES`）。"""
    out = {p for p in listing if p and not p.startswith(SUITE_EXCLUDE_PREFIXES)}
    return sorted(out)


def suite_digest() -> str:
    listing = git('ls-files', '-co', '--exclude-standard', '-z', '--', *SUITE_PATHSPEC).split('\0')
    return _digest_files(DIGEST_SCHEME_SUITE, ((p, _read_bytes(REPO_ROOT / p)) for p in suite_paths(listing)))


DIGEST_FUNCS = {
    'fixtureDigest': fixture_digest,
    'baselineDigest': baseline_digest,
    'suiteDigest': suite_digest,
}


def current_digests() -> Tuple[Dict[str, Optional[str]], Dict[str, str]]:
    """三个摘要的当前值；算不出的为 None，原因放在第二个返回值里。"""
    values: Dict[str, Optional[str]] = {}
    errors: Dict[str, str] = {}
    for key, func in DIGEST_FUNCS.items():
        try:
            values[key] = func()
        except Exception as exc:  # noqa: BLE001  任何原因都按"无法计算"处理，状态据此判为失效
            values[key] = None
            errors[key] = f'{type(exc).__name__}: {exc}'
    return values, errors


# ---------------------------------------------------------------------------
# git
# ---------------------------------------------------------------------------


def git(*args: str) -> str:
    exe = shutil.which('git')
    if exe is None:
        raise AcceptanceError('找不到 git')
    proc = subprocess.run([exe, '-c', 'core.quotepath=off', *args], cwd=REPO_ROOT,
                          stdin=subprocess.DEVNULL, capture_output=True)
    if proc.returncode != 0:
        err = proc.stderr.decode('utf-8', errors='replace').strip().splitlines()
        raise AcceptanceError(f'git {" ".join(args)} 以退出码 {proc.returncode} 结束：{err[0] if err else "（无输出）"}')
    return proc.stdout.decode('utf-8', errors='replace')


# ---------------------------------------------------------------------------
# 阶段记录与状态（18.1、18.10）
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Rule:
    key: str
    anchor: int
    stages: Tuple[int, ...]
    label: str
    restart: str


RULES: Tuple[Rule, ...] = (
    Rule('fixtureDigest', 4, tuple(range(4, LAST_STAGE + 1)),
         'Fixture_Library（夹具源摘要）', '从阶段 4 起重跑'),
    Rule('baselineDigest', 5, tuple(range(5, LAST_STAGE + 1)),
         'Pixel_Baseline（e2e/baselines/ 的摘要）', '从阶段 5 起重跑'),
    Rule('suiteDigest', 3, (3,) + tuple(range(6, LAST_STAGE + 1)),
         'E2E_Suite 文件（suiteDigest）', '重跑阶段 3，以及阶段 6 起所有已完成的阶段'),
)
#: 锚点阶段 → 它记录的摘要键。
ANCHOR_KEY: Dict[int, str] = {r.anchor: r.key for r in RULES}


@dataclass
class StageState:
    n: int
    #: 未执行 / 进行中 / 完成 / 失败 / 中断（最后一次执行的结果）。
    status: str
    #: 最后一次执行"完成"但被作废的原因。
    reasons: List[str] = field(default_factory=list)
    last: Optional[Dict[str, Any]] = None

    @property
    def valid(self) -> bool:
        return self.status == RESULT_DONE and not self.reasons

    @property
    def label(self) -> str:
        return '已失效' if self.status == RESULT_DONE and self.reasons else self.status


def empty_records() -> Dict[str, Any]:
    return {'version': 1, 'executions': []}


def stage_states(
    executions: Sequence[Mapping[str, Any]],
    current: Mapping[str, Optional[str]],
    out_started: Optional[str] = None,
    run_started: Optional[Mapping[int, Optional[str]]] = None,
) -> Dict[int, StageState]:
    """各阶段的状态（纯函数）。

    - `executions`：`stages.json` 的 `executions`，按开始顺序。
    - `current`：三个摘要的当前值（算不出时为 None，按"已变化"处理）。
    - `out_started`：`e2e/.out/results.json` 的 `startedAt`（没有时为 None）。
    - `run_started`：运行阶段 6、8 复制的 `run-6-2.json`、`run-8.json` 的 `startedAt`。

    规则见文件头"失效"。
    """
    run_started = run_started or {}
    last_idx: Dict[int, int] = {}
    last_done_idx: Dict[int, int] = {}
    for i, e in enumerate(executions):
        n = int(e.get('stage', 0))
        last_idx[n] = i
        if e.get('result') == RESULT_DONE:
            last_done_idx[n] = i

    states: Dict[int, StageState] = {}
    for n in STAGE_NUMBERS:
        if n not in last_idx:
            states[n] = StageState(n, STATUS_NONE)
            continue
        i = last_idx[n]
        e = dict(executions[i])
        result = e.get('result')
        status = STATUS_OPEN if result is None else str(result)
        reasons: List[str] = []
        if status == RESULT_DONE:
            for rule in RULES:
                if n not in rule.stages:
                    continue
                a = last_done_idx.get(rule.anchor)
                if a is None:
                    reasons.append(f'阶段 {rule.anchor} 没有完成记录，无从核对{rule.label}')
                    continue
                recorded = (executions[a].get('digests') or {}).get(rule.key)
                now = current.get(rule.key)
                if recorded is None or now is None or recorded != now:
                    reasons.append(f'{rule.label}在阶段 {rule.anchor} 完成后被改动（记录值 {short(recorded)}，'
                                   f'当前值 {short(now)}）：{rule.restart}')
                elif n != rule.anchor and a > i:
                    reasons.append(f'阶段 {rule.anchor} 在本阶段完成之后重新完成（{rule.label}的规则）：{rule.restart}')
        states[n] = StageState(n, status, reasons, e)

    # 产物覆盖：评审阶段尚未有效完成时，e2e/.out/ 须仍是被评审的那次运行。
    for review_n, (run_n, run_file, _profile) in RUN_FOR_REVIEW.items():
        run_state = states[run_n]
        if not run_state.valid or states[review_n].valid:
            continue
        expected = run_started.get(run_n)
        if expected is None:
            run_state.reasons.append(f'acceptance/{run_file} 缺失或没有 startedAt，阶段 {review_n} 无从评审：重跑阶段 {run_n}')
        elif out_started != expected:
            run_state.reasons.append(
                f'阶段 {review_n} 尚未完成，而 e2e/.out/results.json 的 startedAt（{out_started or "无"}）已不等于 '
                f'{run_file} 的 startedAt（{expected}）：阶段 {run_n} 之后又发生过运行，e2e/.out/review/ 已被覆盖，'
                f'重跑阶段 {run_n}')
    return states


def describe_execution(e: Optional[Mapping[str, Any]]) -> str:
    """最后一次执行的一句话描述（阶段表与验收结论用）。"""
    if not e:
        return '未执行'
    head = f'第 {e.get("attempt", "?")} 次，开始于 {e.get("startedAt", "?")}'
    result = e.get('result')
    if result is None:
        return f'进行中（{head}）'
    text = f'{result}（{head}，结束于 {e.get("endedAt", "?")}）'
    notes = [str(x) for x in (e.get('notes') or []) if x]
    if result != RESULT_DONE and notes:
        text += '：' + '；'.join(notes)
    return text


def describe_state(s: StageState) -> str:
    if s.status == RESULT_DONE and s.reasons:
        return f'已完成但失效：{"；".join(s.reasons)}'
    return describe_execution(s.last)


def stage_command(n: int) -> str:
    stage = STAGE_BY_N[n]
    return f'{SELF} stage {"begin" if stage.manual else "run"} {n}'


def open_executions(executions: Sequence[Mapping[str, Any]]) -> List[Mapping[str, Any]]:
    return [e for e in executions if e.get('result') is None]


def next_step(states: Mapping[int, StageState], readings_before_exists: bool,
              executions: Sequence[Mapping[str, Any]] = ()) -> str:
    """`status` 给出的下一步。"""
    opened = open_executions(executions)
    if opened:
        e = opened[-1]
        n = int(e.get('stage', 0))
        how = ('完成人工核对后 ' + code(f'{SELF} stage end {n} --result 完成')
               if STAGE_BY_N.get(n) and STAGE_BY_N[n].manual else
               code(f'{SELF} stage end {n} --result 中断') + '（运行型阶段的遗留执行）')
        return f'阶段 {n} 的第 {e.get("attempt", "?")} 次执行尚未结束：{how}'
    for n in STAGE_NUMBERS:
        if states[n].valid:
            continue
        if n == 1 and not readings_before_exists:
            return ('先记录阶段 1 开始前的读数（18.6）：'
                    + code(f'{SELF} readings --out {rel(READINGS_BEFORE)}') + '，再 ' + code(stage_command(1)))
        why = '' if states[n].status == STATUS_NONE else f'（{states[n].label}）'
        if n == LAST_STAGE:
            return (f'阶段 11 {why}：' + code(stage_command(11)) + '，然后依次 '
                    + code(f'{SELF} readings --out {rel(READINGS_AFTER)}') + '、' + code(f'{SELF} scope') + '、'
                    + code(f'{SELF} summary') + '，核对 acceptance.md 后 ' + code(f'{SELF} stage end 11 --result 完成'))
        return f'阶段 {n}「{STAGE_BY_N[n].title}」{why}：' + code(stage_command(n))
    return '阶段 1–11 均已有效完成，验收结束；需要更新小结时可再次执行 ' + code(f'{SELF} summary')


def start_refusal(n: int, states: Mapping[int, StageState], executions: Sequence[Mapping[str, Any]],
                  readings_before_exists: bool, terminate: bool = False) -> Optional[str]:
    """`stage run` / `stage begin` 能否开始；不能时返回原因（纯函数）。"""
    opened = open_executions(executions)
    if opened:
        e = opened[-1]
        k = e.get('stage')
        return (f'阶段 {k} 的第 {e.get("attempt", "?")} 次执行尚未结束（开始于 {e.get("startedAt", "?")}）。'
                f'请先执行 {code(f"{SELF} stage end {k} --result 完成|失败|中断")}。')
    if n == LAST_STAGE and terminate:
        return None
    if n != LAST_STAGE and states[n].valid:
        return f'阶段 {n} 已有效完成，不重跑（18.10）。'
    missing = [k for k in STAGE_NUMBERS if k < n and not states[k].valid]
    if missing:
        lines = [f'阶段 {n} 的前置未完成（18.1）：']
        lines += [f'  - 阶段 {k}「{STAGE_BY_N[k].title}」：{describe_state(states[k])}' for k in missing]
        if n == LAST_STAGE:
            lines.append('  用户决定终止验收时以 ' + code(f'{SELF} stage begin 11 --terminate') + ' 开始。')
        return '\n'.join(lines)
    if n == 1 and not readings_before_exists:
        return ('阶段 1 开始前须先记录读数（18.6）：' + code(f'{SELF} readings --out {rel(READINGS_BEFORE)}'))
    return None


# ---------------------------------------------------------------------------
# 判定：阶段 4、6、8（18.1 (4)、18.3、18.4）
# ---------------------------------------------------------------------------

OUTCOME_LABELS: Dict[str, str] = {
    'passed': '通过',
    'failed': '失败',
    'unexpectedPass': '意外通过',
    'skipped': '跳过',
    'expectedFail': '预期失败',
    'notRun': '未执行',
}
OUTCOME_ORDER: Tuple[str, ...] = ('passed', 'failed', 'unexpectedPass', 'skipped', 'expectedFail')

#: 与 `summary.ts` 的 `SKIP_KIND_LABELS` 相同。
SKIP_KIND_LABELS: Dict[str, str] = {
    '3.9': 'Fixture_Generator 失败',
    '4.3': 'real 书库核对未通过',
    '4.7': 'Test_Book 缺少所需特征',
    '8.13': '当前书库缺少相邻卷节点',
    '16.4': '可测性缺口',
    'other': '不带约定前缀的原因',
}

#: 18.3 与 18.4 允许的跳过类别。
ALLOWED_SKIPS_6: Tuple[str, ...] = ('16.4',)
ALLOWED_SKIPS_8: Tuple[str, ...] = ('4.3', '16.4')

#: 用户决定（验收前，风险 R5）：real 运行中按 [4.7] / [8.13] 跳过的用例是真实书库的数据限制，阶段 8 也允许，
#: 但逐条记录（`accepted_limits_8`）：写入阶段记录的 `accepted`、acceptance.md 与待人工复核清单。
ACCEPTED_LIMIT_SKIPS_8: Tuple[str, ...] = ('4.7', '8.13')
ACCEPTED_LIMIT_LABEL = '按用户决定接受的数据限制'

VISUAL_SPEC_NAME = 'visual.spec.ts'


def rows_of(run: Optional[Mapping[str, Any]]) -> List[Mapping[str, Any]]:
    rows = run.get('rows') if isinstance(run, Mapping) else None
    return [r for r in rows if isinstance(r, Mapping)] if isinstance(rows, list) else []


def is_visual_row(row: Mapping[str, Any]) -> bool:
    file = str(row.get('file') or '')
    return file == VISUAL_SPEC_NAME or file.endswith('/' + VISUAL_SPEC_NAME)


def row_label(row: Mapping[str, Any]) -> str:
    return f'{row.get("file", "?")} › {row.get("title", "?")}（{row.get("project", "?")}）'


def row_findings(row: Mapping[str, Any]) -> List[str]:
    value = row.get('findings')
    return [str(x) for x in value] if isinstance(value, list) else []


def outcome_text(row: Mapping[str, Any]) -> str:
    """`跳过 [8.13]`、`预期失败（F-002）` 这类写法。"""
    outcome = str(row.get('outcome'))
    text = OUTCOME_LABELS.get(outcome, outcome)
    if outcome == 'skipped':
        kind = (row.get('skip') or {}).get('kind') if isinstance(row.get('skip'), Mapping) else None
        text += f' [{kind}]' if kind else ''
    ids = row_findings(row)
    if ids and outcome in ('expectedFail', 'unexpectedPass', 'skipped'):
        text += f'（{"、".join(ids)}）'
    return text


def _unknown(ids: Sequence[str], known: Optional[Set[str]]) -> List[str]:
    return [] if known is None else [i for i in ids if i not in known]


def row_problem(row: Mapping[str, Any], allowed_skips: Sequence[str], requirement: str,
                known_findings: Optional[Set[str]] = None,
                accepted_skips: Sequence[str] = ()) -> Optional[str]:
    """用例结果是否属于 {通过；引用 Finding 的预期失败；按允许类别跳过且写明原因}；不属于时返回原因。

    `known_findings` 为 `findings.md` 中的编号集合；给出时另核对引用的编号存在（16.7）。
    `accepted_skips` 为按用户决定另外接受的跳过类别（同样须写明原因）。
    """
    outcome = row.get('outcome')
    ids = row_findings(row)
    if outcome == 'passed':
        return None
    if outcome == 'expectedFail':
        if not ids:
            return '预期失败，但标注与标题中没有 Finding 编号'
        missing = _unknown(ids, known_findings)
        return f'预期失败引用的 {"、".join(missing)} 不在 findings.md 中' if missing else None
    if outcome == 'skipped':
        skip = row.get('skip') if isinstance(row.get('skip'), Mapping) else {}
        kind = str(skip.get('kind') or 'other')
        reason = str(skip.get('reason') or '').strip()
        if kind not in allowed_skips and kind not in accepted_skips:
            allowed = ' 或 '.join(allowed_skips)
            extra = (f'（另按用户决定接受 {"、".join(f"[{k}]" for k in accepted_skips)} 作为数据限制）'
                     if accepted_skips else '')
            return (f'按 [{kind}] 跳过（{SKIP_KIND_LABELS.get(kind, kind)}），{requirement} 只允许按 {allowed} 跳过'
                    f'{extra}；跳过原因：{reason or "（空）"}')
        if not reason:
            return f'按 [{kind}] 跳过，但 Run_Summary 中没有写明原因'
        if kind == '16.4':
            if not ids:
                return '按 16.4 跳过，但跳过原因中没有可测性缺口的 Finding 编号'
            missing = _unknown(ids, known_findings)
            if missing:
                return f'按 16.4 跳过引用的 {"、".join(missing)} 不在 findings.md 中'
        return None
    if outcome == 'unexpectedPass':
        return '意外通过（带预期失败标注的用例实际通过），按失败计'
    if outcome == 'failed':
        head = '超时' if row.get('timedOut') else '失败'
        return f'{head}：{row.get("errorLine") or "（没有错误信息）"}'
    if outcome == 'notRun':
        return '未执行（运行被中断或没有结果）'
    return f'无法识别的结果 {outcome!r}'


def describe_run_level(f: Mapping[str, Any]) -> str:
    kind = f.get('kind')
    if kind == 'snapshot-diff':
        return f'public/ 起止快照有 {f.get("total")} 处差异（4.8）'
    if kind == 'snapshot-missing':
        return f'public/ {f.get("which")} 快照缺失或无效：{f.get("reason")}'
    if kind == 'fixture-failed':
        return f'Fixture_Generator 失败：{f.get("reason") or "；".join(map(str, f.get("detail") or []))}'
    if kind == 'review-consistency':
        violations = f.get('violations') or []
        kinds = sorted({str(v.get('kind')) for v in violations if isinstance(v, Mapping)})
        return f'Review_Report 一致性违规 {len(violations)} 条（{"、".join(kinds) or "—"}，13.11）'
    if kind == 'run-error':
        return 'Playwright 报告错误：' + '；'.join(map(str, f.get('errors') or []))
    return f'运行级失败 {kind!r}'


def run_problems(run: Optional[Mapping[str, Any]], label: str, profile: str) -> List[str]:
    """两次判定共用的附加条件：结果文件存在、未中止、没有运行级失败、选中了该 profile 且有其用例。"""
    if not isinstance(run, Mapping):
        return [f'{label}：结果文件缺失或无法解析']
    out: List[str] = []
    abort = run.get('abort')
    if abort:
        stage = abort.get('stage') if isinstance(abort, Mapping) else None
        reason = abort.get('reason') if isinstance(abort, Mapping) else abort
        out.append(f'{label}：运行中止于"{stage}"：{reason}')
    for f in run.get('runLevel') or []:
        if isinstance(f, Mapping):
            out.append(f'{label}：{describe_run_level(f)}')
    selected = run.get('selected') or []
    if profile not in selected:
        out.append(f'{label}：本次运行没有选中 {profile}（selected = {selected}）')
    elif not any(r.get('profile') == profile for r in rows_of(run)):
        out.append(f'{label}：没有 {profile} 的用例结果')
    return out


def judge_4(run: Optional[Mapping[str, Any]]) -> List[str]:
    """阶段 4：`results.json` 中 `visual.spec` 至少有 1 行，且每行都是通过（退出码另由 `stage run` 核对）。"""
    if not isinstance(run, Mapping):
        return ['run-4.json 缺失或无法解析']
    out: List[str] = []
    abort = run.get('abort')
    if abort:
        stage = abort.get('stage') if isinstance(abort, Mapping) else None
        reason = abort.get('reason') if isinstance(abort, Mapping) else abort
        out.append(f'运行中止于"{stage}"：{reason}')
    visual = [r for r in rows_of(run) if is_visual_row(r)]
    if not visual:
        out.append('results.json 中没有 visual.spec 的用例结果')
    for row in visual:
        if row.get('outcome') != 'passed':
            out.append(f'{row_label(row)}：{outcome_text(row)}，不是通过'
                       + (f'：{row.get("errorLine")}' if row.get('errorLine') else ''))
    return out


def judge_6(run1: Optional[Mapping[str, Any]], run2: Optional[Mapping[str, Any]],
            known_findings: Optional[Set[str]] = None) -> List[str]:
    """18.3：两次 fixture 运行。返回不满足的条件（空列表即通过）。

    - 两次都无中止、无运行级失败，选中 fixture 且有 fixture 用例（本设计附加的条件）。
    - 两次的用例 id 集合相同；同一用例两次的 outcome 相同。
    - 每个用例都是通过、引用 Finding 的预期失败，或按 16.4 跳过（引用 Finding）；意外通过按失败计。
    - 两次的 Visual_Regression_Check 都是零失败：`visual.spec` 至少 1 行且每行都是通过。
    """
    labels = ('第 1 次', '第 2 次')
    out = run_problems(run1, labels[0], 'fixture') + run_problems(run2, labels[1], 'fixture')
    if not isinstance(run1, Mapping) or not isinstance(run2, Mapping):
        return out
    by_id = [{str(r.get('id')): r for r in rows_of(run)} for run in (run1, run2)]
    only = [sorted(set(by_id[i]) - set(by_id[1 - i])) for i in (0, 1)]
    for i in (0, 1):
        for rid in only[i]:
            out.append(f'用例只在{labels[i]}运行中出现：{row_label(by_id[i][rid])}')
    for i, rows in enumerate(by_id):
        visual = [r for r in rows.values() if is_visual_row(r)]
        if not visual:
            out.append(f'{labels[i]}：没有 visual.spec 的用例结果，Visual_Regression_Check 未执行')
        for row in sorted(rows.values(), key=row_label):
            if is_visual_row(row):
                if row.get('outcome') != 'passed':
                    out.append(f'{labels[i]}：Visual_Regression_Check 未通过：{row_label(row)}：{outcome_text(row)}'
                               + (f'：{row.get("errorLine")}' if row.get('errorLine') else ''))
                continue
            problem = row_problem(row, ALLOWED_SKIPS_6, '18.3', known_findings)
            if problem:
                out.append(f'{labels[i]}：{row_label(row)}：{problem}')
    for rid in sorted(set(by_id[0]) & set(by_id[1])):
        a, b = by_id[0][rid], by_id[1][rid]
        if a.get('outcome') != b.get('outcome'):
            out.append(f'两次结果不同：{row_label(a)}：第 1 次 {outcome_text(a)}，第 2 次 {outcome_text(b)}')
    return out


def judge_8(run: Optional[Mapping[str, Any]], known_findings: Optional[Set[str]] = None) -> List[str]:
    """18.4：real 运行。返回不满足的条件（空列表即通过）。

    每个用例都是通过、引用 Finding 的预期失败，或按 4.3 / 16.4 跳过且写明原因；Perf_Metrics 不参与。
    另要求无中止、无运行级失败，选中 real 且有 real 用例。

    用户决定（验收前，风险 R5）：按 [4.7] / [8.13] 跳过且写明原因的用例也允许，作为真实书库的数据限制；
    它们不在返回值中，由 `accepted_limits_8` 逐条列出。其余跳过类别仍不通过。
    """
    out = run_problems(run, 'real 运行', 'real')
    if not isinstance(run, Mapping):
        return out
    for row in sorted(rows_of(run), key=row_label):
        problem = row_problem(row, ALLOWED_SKIPS_8, '18.4', known_findings, ACCEPTED_LIMIT_SKIPS_8)
        if problem:
            out.append(f'{row_label(row)}：{problem}')
    return out


def accepted_limits_8(run: Optional[Mapping[str, Any]]) -> List[Dict[str, str]]:
    """`judge_8` 按用户决定接受的数据限制：按 [4.7] / [8.13] 跳过且写明原因的用例，按 `row_label` 排序。

    每项为 `{'case', 'profile', 'kind', 'reason'}`；写入阶段 8 记录的 `accepted`，并由 `summary` 列入
    acceptance.md 与待人工复核清单。
    """
    out: List[Dict[str, str]] = []
    for row in sorted(rows_of(run), key=row_label):
        skip = row.get('skip') if isinstance(row.get('skip'), Mapping) else {}
        kind = str(skip.get('kind') or '')
        reason = str(skip.get('reason') or '').strip()
        if row.get('outcome') == 'skipped' and kind in ACCEPTED_LIMIT_SKIPS_8 and reason:
            out.append({'case': row_label(row), 'profile': str(row.get('profile') or 'real'),
                        'kind': kind, 'reason': reason})
    return out


def accepted_limits_note(items: Sequence[Mapping[str, str]]) -> str:
    """阶段 8 记录中的一句汇总，如 `…数据限制（风险 R5）5 项：[4.7] 1 个、[8.13] 4 个；…`。"""
    counts: Dict[str, int] = {}
    for a in items:
        counts[a['kind']] = counts.get(a['kind'], 0) + 1
    by_kind = '、'.join(f'[{k}] {counts[k]} 个' for k in ACCEPTED_LIMIT_SKIPS_8 if k in counts)
    return f'{ACCEPTED_LIMIT_LABEL}（风险 R5）{len(items)} 项：{by_kind}；已列入待人工复核清单'


# ---------------------------------------------------------------------------
# Findings_Log
# ---------------------------------------------------------------------------


def parse_findings(text: Optional[str]) -> List[Dict[str, Optional[str]]]:
    """`## F-xxx 标题` 与其下的 `- 严重度：…`。"""
    out: List[Dict[str, Optional[str]]] = []
    current: Optional[Dict[str, Optional[str]]] = None
    for line in (text or '').splitlines():
        m = re.match(r'^##\s+(F-\d{3,})\s*(.*)$', line)
        if m:
            current = {'id': m.group(1), 'title': m.group(2).strip(), 'severity': None}
            out.append(current)
            continue
        if line.startswith('## '):
            current = None
            continue
        m = re.match(r'^-\s*严重度\s*[：:]\s*(阻断|严重|一般|轻微)', line)
        if m and current is not None and current['severity'] is None:
            current['severity'] = m.group(1)
    return out


def known_finding_ids() -> Set[str]:
    return {str(f['id']) for f in parse_findings(read_text(FINDINGS_FILE))}


def evidence_names() -> List[str]:
    if not FINDINGS_DIR.is_dir():
        return []
    return sorted(p.name for p in FINDINGS_DIR.rglob('*') if p.is_file())


# ---------------------------------------------------------------------------
# 人工阶段的核对：阶段 5、7、9、11
# ---------------------------------------------------------------------------


def _strip_code(cell: str) -> str:
    c = cell.strip()
    if len(c) >= 2 and c[0] == '`' and c[-1] == '`':
        c = c[1:-1].strip()
    return c


def split_cells(line: str) -> List[str]:
    """`a | b | c`、`| a | b |`、`- a | b` 都拆成单元格；`\\|` 视为单元格内的竖线。"""
    s = line.strip()
    if s.startswith(('- ', '* ')):
        s = s[2:].strip()
    if s.startswith('|'):
        s = s[1:]
    if s.endswith('|') and not s.endswith('\\|'):
        s = s[:-1]
    return [_strip_code(c.replace('\\|', '|')) for c in re.split(r'(?<!\\)\|', s)]


BASELINE_VERDICTS = ('接受', '含已知缺陷接受', '重拍')


class BaselineRow(NamedTuple):
    file: str
    verdict: str
    basis: str
    finding: str
    reviewer: str
    date: str
    line: int


def parse_baseline_review(text: Optional[str]) -> List[BaselineRow]:
    """`baseline-review.md` 中首个单元格以 `.png` 结尾的行。"""
    rows: List[BaselineRow] = []
    for i, line in enumerate((text or '').splitlines(), start=1):
        if '|' not in line:
            continue
        cells = split_cells(line)
        if not cells or not cells[0].lower().endswith('.png'):
            continue
        cells += [''] * (6 - len(cells))
        rows.append(BaselineRow(cells[0], cells[1], cells[2], cells[3], cells[4], cells[5], i))
    return rows


def baseline_name_of(file: str) -> str:
    """`px-shelf-home-win32.png` → `px-shelf-home`（平台标识不含 `-`，6.7）。"""
    stem = file[:-4] if file.lower().endswith('.png') else file
    return stem.rsplit('-', 1)[0] if '-' in stem else stem


def check_baseline_review(text: Optional[str], baseline_files: Sequence[str], known_findings: Set[str],
                          baselines_ts: Optional[str]) -> List[str]:
    """阶段 5 的核对（18.2、18.9）。`baseline_files` 为 `e2e/baselines/` 中的 PNG 文件名。"""
    if text is None:
        return [f'{rel(BASELINE_REVIEW_FILE)} 不存在']
    out: List[str] = []
    if not baseline_files:
        out.append('e2e/baselines/ 中没有 PNG（阶段 4 是否已生成基线？）')
    rows = parse_baseline_review(text)
    by_file: Dict[str, List[BaselineRow]] = {}
    for r in rows:
        by_file.setdefault(r.file, []).append(r)
    for f in baseline_files:
        n = len(by_file.get(f, []))
        if n != 1:
            out.append(f'{f}：应恰有 1 行判定，实际 {n} 行')
    for f in sorted(set(by_file) - set(baseline_files)):
        out.append(f'{f}：记录中的文件不在 e2e/baselines/ 中')
    for r in rows:
        where = f'第 {r.line} 行 {r.file}'
        if r.verdict not in BASELINE_VERDICTS:
            out.append(f'{where}：判定 {r.verdict!r} 不是 接受 / 含已知缺陷接受 / 重拍 之一')
        elif r.verdict == '重拍':
            out.append(f'{where}：判为"重拍"；修正测试代码并重新生成后再评审（18.2）')
        for label, value in (('依据', r.basis), ('Reviewer', r.reviewer), ('日期', r.date)):
            if not value or value == '—':
                out.append(f'{where}：缺少{label}')
        if r.verdict == '含已知缺陷接受':
            ids = finding_ids_in(r.finding)
            if not ids:
                out.append(f'{where}："含已知缺陷接受"须引用 Finding 编号（18.9）')
            for fid in ids:
                if fid not in known_findings:
                    out.append(f'{where}：{fid} 不在 findings.md 中')
                if baselines_ts is None or fid not in baselines_ts:
                    out.append(f'{where}：{fid} 未标注在 e2e/visual/baselines.ts（knownDefects 与遮罩定义旁，18.9）')
    return out


REVIEW_VERDICTS = ('通过', '不通过', '无法判断')
REVIEW_UNCAPTURED = '未拍摄'
_SHOT_NAME = r'[a-z0-9]+(?:-[a-z0-9]+)*'
_CRITERION = re.compile(rf'(?P<name>{_SHOT_NAME})#(?P<k>\d+)')
_SHOT = re.compile(_SHOT_NAME)
MAX_BASIS_CHARS = 200


@dataclass
class ReviewRecord:
    started: Optional[str] = None
    reviewer: Optional[str] = None
    date: Optional[str] = None
    #: (名称, 准则号, 判定, 依据, Finding 单元格, 行号)
    verdicts: List[Tuple[str, int, str, str, str, int]] = field(default_factory=list)
    #: (名称, 原因, 行号)
    uncaptured: List[Tuple[str, str, int]] = field(default_factory=list)
    #: (名称, 准则号, 原因, 行号)
    pending: List[Tuple[str, int, str, int]] = field(default_factory=list)
    errors: List[str] = field(default_factory=list)


def _header_value(line: str, pattern: str) -> Optional[str]:
    m = re.search(pattern + r'\s*[：:]\s*(.+?)\s*$', line)
    return _strip_code(m.group(1)) if m else None


def parse_review_record(text: Optional[str]) -> ReviewRecord:
    """按文件头"阶段 7 / 9"一节的格式解析 Review_Record。"""
    rec = ReviewRecord()
    pending_section = False
    for i, line in enumerate((text or '').splitlines(), start=1):
        stripped = line.strip()
        if stripped.startswith('#'):
            pending_section = '待人工复核' in stripped
            continue
        if '|' not in stripped:
            if rec.started is None:
                rec.started = _header_value(stripped, r'运行开始时间')
            if rec.reviewer is None:
                rec.reviewer = _header_value(stripped, r'Reviewer[^：:]*')
            if rec.date is None:
                rec.date = _header_value(stripped, r'评审日期')
            continue
        cells = split_cells(stripped)
        if len(cells) < 2:
            continue
        m = _CRITERION.fullmatch(cells[0])
        if pending_section:
            if m:
                rec.pending.append((m.group('name'), int(m.group('k')), cells[1], i))
            continue
        if m:
            if cells[1] in REVIEW_VERDICTS:
                rec.verdicts.append((m.group('name'), int(m.group('k')), cells[1],
                                     cells[2] if len(cells) > 2 else '', cells[3] if len(cells) > 3 else '', i))
            else:
                rec.errors.append(f'第 {i} 行：{cells[0]} 的判定 {cells[1]!r} 不是 通过 / 不通过 / 无法判断 之一')
        elif _SHOT.fullmatch(cells[0]) and cells[1] == REVIEW_UNCAPTURED:
            rec.uncaptured.append((cells[0], cells[2] if len(cells) > 2 else '', i))
    return rec


def check_review_record(record: ReviewRecord, report: Optional[Mapping[str, Any]], profile: str,
                        run_started: Optional[str], report_md_started: Optional[str],
                        known_findings: Set[str], evidence: Sequence[str]) -> List[str]:
    """阶段 7 / 9 的核对（18.5、13.6–13.8；设计阶段表）。

    - `report`：该次运行的 `review-report.json`（ReviewReportData）。
    - `run_started`：`run-6-2.json` / `run-8.json` 的 `startedAt`。
    - `report_md_started`：`e2e/.out/review/review-report.md` 中"运行开始时间"的值。
    - `evidence`：`findings/` 中的文件名。
    """
    out: List[str] = list(record.errors)
    if not run_started:
        out.append('被评审运行的结果文件缺失或没有 startedAt')
    if report_md_started != run_started:
        out.append(f'e2e/.out/review/review-report.md 的运行开始时间（{report_md_started or "无"}）不等于被评审运行的 '
                   f'startedAt（{run_started or "无"}）：中间有别的运行，须重跑被评审的运行阶段')
    if record.started != run_started:
        out.append(f'Review_Record 开头的运行开始时间（{record.started or "无"}）不等于被评审运行的 startedAt（{run_started or "无"}）')
    if not record.reviewer:
        out.append('Review_Record 开头缺少 Reviewer')
    if not record.date:
        out.append('Review_Record 开头缺少评审日期')
    if not isinstance(report, Mapping):
        out.append('review-report.json 缺失或无法解析')
        return out
    if started_of(report) != run_started:
        out.append(f'review-report.json 的 startedAt（{started_of(report) or "无"}）不等于被评审运行的 startedAt')
    shots = [s for s in report.get('shots') or [] if isinstance(s, Mapping) and s.get('profile') == profile]
    names = {str(s.get('name')) for s in shots}
    verdicts: Dict[Tuple[str, int], List[Tuple[str, int, str, str, str, int]]] = {}
    for v in record.verdicts:
        verdicts.setdefault((v[0], v[1]), []).append(v)
    uncaptured: Dict[str, List[Tuple[str, str, int]]] = {}
    for u in record.uncaptured:
        uncaptured.setdefault(u[0], []).append(u)

    for s in shots:
        name = str(s.get('name'))
        n_criteria = int(s.get('criteria') or 0)
        if s.get('captured'):
            for k in range(1, n_criteria + 1):
                n = len(verdicts.get((name, k), []))
                if n != 1:
                    out.append(f'{name}#{k}：应恰有 1 个判定，实际 {n} 个')
            extra = sorted(k for (nm, k) in verdicts if nm == name and not 1 <= k <= n_criteria)
            for k in extra:
                out.append(f'{name}#{k}：该图只有 {n_criteria} 条准则')
            if name in uncaptured:
                out.append(f'{name}：已拍摄，却记为"未拍摄"')
        else:
            rows = uncaptured.get(name, [])
            if len(rows) != 1:
                out.append(f'{name}：未拍摄（{s.get("reason") or "原因见 Review_Report"}），应恰有 1 行"未拍摄"并写明原因，实际 {len(rows)} 行')
            elif not rows[0][1]:
                out.append(f'{name}：第 {rows[0][2]} 行"未拍摄"没有写明原因（13.4）')
            if any(nm == name for (nm, _k) in verdicts):
                out.append(f'{name}：未拍摄，却有准则判定')
    for nm in sorted({nm for (nm, _k) in verdicts} | set(uncaptured)):
        if nm not in names:
            out.append(f'{nm}：不是 Review_Catalog 中属于 {profile} 的 Review_Shot')

    pending = {(p[0], p[1]) for p in record.pending}
    for name, k, verdict, basis, finding, line in record.verdicts:
        where = f'第 {line} 行 {name}#{k}'
        if not basis or basis == '—':
            out.append(f'{where}：缺少依据')
        elif len(basis) > MAX_BASIS_CHARS:
            out.append(f'{where}：依据 {len(basis)} 字，超过 {MAX_BASIS_CHARS} 字')
        if verdict == '不通过':
            ids = finding_ids_in(finding)
            if not ids:
                out.append(f'{where}："不通过"须引用 Finding 编号（13.7）')
            for fid in ids:
                if fid not in known_findings:
                    out.append(f'{where}：{fid} 不在 findings.md 中')
                if not any(e.startswith(fid) for e in evidence):
                    out.append(f'{where}：findings/ 中没有以 {fid} 开头的证据文件（13.7）')
        elif verdict == '无法判断' and (name, k) not in pending:
            out.append(f'{where}："无法判断"未列入"待人工复核"清单（13.8）')
    return out


def report_md_started(text: Optional[str]) -> Optional[str]:
    """`review-report.md` 中 `- 运行开始时间：` 一行的值（`consistency.ts` 的 `REPORT_TEXT.startedAt`）。"""
    for line in (text or '').splitlines():
        if line.startswith('- 运行开始时间：'):
            return line[len('- 运行开始时间：'):].strip()
    return None


def check_stage11(started_epoch: float) -> List[str]:
    out: List[str] = []
    for path in (READINGS_AFTER, SUMMARY_FILE):
        try:
            mtime = path.stat().st_mtime
        except OSError:
            out.append(f'{rel(path)} 不存在')
            continue
        if mtime < started_epoch - FRESH_TOLERANCE_S:
            out.append(f'{rel(path)} 写于本次阶段 11 开始之前，须在本次执行中重新生成')
    return out


# ---------------------------------------------------------------------------
# 16.5 改动范围
# ---------------------------------------------------------------------------

ALLOWED_PREFIXES: Tuple[str, ...] = ('e2e/', '.kiro/specs/e2e-visual-testing/')
ALLOWED_FILES: Tuple[str, ...] = (
    'package.json', 'package-lock.json', 'tsconfig.json', 'eslint.config.js', '.gitignore', 'README.md',
    'vitest.config.ts', 'playwright.config.ts',
    # 设计"F-001 修复"一节列出的 6 个文件（16.1 (f)）
    'src/utils/decompress.ts', 'src/utils/loadMetrics.ts', 'src/utils/loadMetrics.test.ts',
    'src/utils/bookTextCheck.ts', 'src/utils/bookTextCheck.test.ts', 'src/utils/bookLoader.test.ts',
)
PACKAGE_MUTABLE_KEYS = ('devDependencies', 'scripts')

#: 用户决定（验收前）：规格开始前已存在的改动（实施开始前已暂存），`scope` 列出但不计入核对。只按精确路径
#: 匹配；这些文件之后再有改动也照样排除。其他路径仍按允许集合核对。
PRE_EXISTING_LABEL = '规格开始前已存在的改动'
PRE_EXISTING_FILES: Tuple[str, ...] = (
    'public/favicon.svg',
    'scripts/lib/manifest.py',
    'scripts/lib/report.py',
    'scripts/preprocess.py',
    'scripts/tests/test_manifest.py',
    'scripts/tests/test_preprocess.py',
    'scripts/tests/test_report.py',
)
#: 同上：package.json 只排除 `name` 键恰由旧值改为新值这一处；其余键（含 `name` 的其他取值）照常核对。
PRE_EXISTING_PACKAGE_CHANGES: Dict[str, Tuple[Any, Any]] = {
    'name': ('novel-reader-web', 'cloudflare-pages-novel'),
}


def allowed_rule(path: str) -> Optional[str]:
    """路径落在允许集合的哪一条；不在时为 None。"""
    for prefix in ALLOWED_PREFIXES:
        if path.startswith(prefix):
            return f'前缀 {prefix}'
    return '精确路径' if path in ALLOWED_FILES else None


def package_json_problems(base_text: Optional[str], current_text: Optional[str]) -> Tuple[List[str], List[str]]:
    """`package.json` 的内容核对（16.1 (b)、1.1）：`devDependencies`、`scripts` 以外的键不变，
    `devDependencies` 中已有条目的版本字符串不变。

    返回 (问题, 排除项)：与 `PRE_EXISTING_PACKAGE_CHANGES` 完全相符的改动不算问题，记入排除项。"""
    try:
        base = json.loads(base_text) if base_text is not None else None
    except ValueError as exc:
        return [f'基准提交的 package.json 无法解析：{exc}'], []
    try:
        cur = json.loads(current_text) if current_text is not None else None
    except ValueError as exc:
        return [f'当前 package.json 无法解析：{exc}'], []
    if not isinstance(base, dict):
        return ['取不到基准提交的 package.json'], []
    if not isinstance(cur, dict):
        return ['取不到当前的 package.json'], []
    out: List[str] = []
    excluded: List[str] = []
    for key in sorted(set(base) | set(cur)):
        if key in PACKAGE_MUTABLE_KEYS:
            continue
        exempt = PRE_EXISTING_PACKAGE_CHANGES.get(key)
        if exempt is not None and key in base and key in cur and (base[key], cur[key]) == exempt:
            old, new = (json.dumps(v, ensure_ascii=False) for v in exempt)
            excluded.append(f'键 {key} 由 {old} 改为 {new}（{PRE_EXISTING_LABEL}）')
            continue
        if key not in cur:
            out.append(f'删除了键 {key}')
        elif key not in base:
            out.append(f'新增了键 {key}')
        elif base[key] != cur[key]:
            out.append(f'键 {key} 的内容有变化')
    base_dev = base.get('devDependencies') or {}
    cur_dev = cur.get('devDependencies') or {}
    for name, version in sorted(base_dev.items()):
        if name not in cur_dev:
            out.append(f'devDependencies 删除了已有条目 {name}（原为 {version}）')
        elif cur_dev[name] != version:
            out.append(f'devDependencies 中已有条目 {name} 的版本由 {version} 改为 {cur_dev[name]}')
    return out, excluded


def scope(base: str, paths: Iterable[str], base_package: Optional[str],
          current_package: Optional[str]) -> Dict[str, Any]:
    """16.5 的核对（纯函数）。`paths` 为 `git diff --name-only <base>` 与
    `git ls-files --others --exclude-standard` 的并集。

    `PRE_EXISTING_FILES` 中的路径与 `PRE_EXISTING_PACKAGE_CHANGES` 中的 package.json 改动是规格开始前已存在
    的改动（用户决定，验收前）：列在 `excluded` / `packageJsonExcluded` 中，不影响 `ok`。"""
    entries = []
    for p in sorted({p for p in paths if p}):
        rule = allowed_rule(p)
        excluded = rule is None and p in PRE_EXISTING_FILES
        entries.append({'path': p, 'allowed': rule is not None, 'excluded': excluded,
                        'rule': PRE_EXISTING_LABEL if excluded else rule})
    pkg, pkg_excluded = package_json_problems(base_package, current_package)
    violations = [e['path'] for e in entries if not e['allowed'] and not e['excluded']]
    return {'base': base, 'paths': entries, 'violations': violations,
            'excluded': [e['path'] for e in entries if e['excluded']],
            'packageJson': pkg, 'packageJsonExcluded': pkg_excluded,
            'ok': not violations and not pkg}


def read_base_commit() -> str:
    text = read_text(BASE_COMMIT_FILE)
    value = (text or '').strip()
    if not re.fullmatch(r'[0-9a-f]{40}', value):
        raise AcceptanceError(f'{rel(BASE_COMMIT_FILE)} 缺失或不是 40 位提交哈希')
    return value


def collect_scope(base: str) -> Dict[str, Any]:
    git('cat-file', '-e', f'{base}^{{commit}}')
    diff = git('diff', '--name-only', '--no-renames', '-z', base).split('\0')
    untracked = git('ls-files', '--others', '--exclude-standard', '-z').split('\0')
    try:
        base_pkg: Optional[str] = git('show', f'{base}:package.json')
    except AcceptanceError:
        base_pkg = None
    return scope(base, [*diff, *untracked], base_pkg, read_text(REPO_ROOT / 'package.json'))


# ---------------------------------------------------------------------------
# 验收结论（18.7、18.11）
# ---------------------------------------------------------------------------


def verdict(states: Mapping[int, StageState], before: Optional[Mapping[str, Any]],
            after: Optional[Mapping[str, Any]]) -> Tuple[str, List[str]]:
    """阶段 1–10 全部有效完成且两次读数逐项一致时为"通过"，否则"不通过"并列出原因。

    待人工复核的条目与 16.5 的核对结果不影响结论（18.7；设计"判定函数"）。
    """
    reasons: List[str] = []
    for n in STAGE_NUMBERS:
        if n == LAST_STAGE:
            continue
        s = states.get(n)
        if s is None or not s.valid:
            desc = '未执行' if s is None else describe_state(s)
            reasons.append(f'阶段 {n}「{STAGE_BY_N[n].title}」未完成：{desc}')
    if not isinstance(before, Mapping):
        reasons.append(f'缺少阶段 1 开始前的读数（{rel(READINGS_BEFORE)}）')
    if not isinstance(after, Mapping):
        reasons.append(f'缺少阶段 11 开始时的读数（{rel(READINGS_AFTER)}）')
    if isinstance(before, Mapping) and isinstance(after, Mapping):
        for d in compare_readings(before, after):
            reasons.append(f'读数不一致：{d.label}：阶段 1 开始前 {reading_text(d.before)}，'
                           f'阶段 11 开始时 {reading_text(d.after)}')
    return ('通过' if not reasons else '不通过'), reasons


# ---------------------------------------------------------------------------
# 记录的读写与阶段表渲染（18.10）
# ---------------------------------------------------------------------------


def load_records() -> Dict[str, Any]:
    data = load_json(STAGES_FILE)
    if data is None:
        if STAGES_FILE.exists():
            raise AcceptanceError(f'{rel(STAGES_FILE)} 无法解析；请先修复或移走它')
        return empty_records()
    if not isinstance(data, dict) or not isinstance(data.get('executions'), list):
        raise AcceptanceError(f'{rel(STAGES_FILE)} 的格式不对（缺少 executions 列表）')
    return data


def _duration(e: Mapping[str, Any]) -> Optional[float]:
    start, end = e.get('startedEpoch'), e.get('endedEpoch')
    if isinstance(start, (int, float)) and isinstance(end, (int, float)):
        return round(end - start, 1)
    return None


def _commands_cell(e: Mapping[str, Any]) -> str:
    stage = STAGE_BY_N.get(int(e.get('stage', 0)))
    cmds = e.get('commands') or []
    if not cmds:
        return stage.manual_desc if stage and stage.manual else '—'
    parts = []
    for c in cmds:
        rc = c.get('exitCode')
        parts.append(f'`{c.get("command")}`（{"未结束" if rc is None else rc}）')
    return '<br>'.join(parts)


def _notes_cell(e: Mapping[str, Any], limit: int = 5) -> str:
    notes = [str(x) for x in (e.get('notes') or []) if x]
    problems = [str(x) for x in (e.get('problems') or []) if x]
    parts = list(notes)
    if problems:
        shown = problems[:limit]
        more = f'<br>……共 {len(problems)} 项，完整清单见 stages.json' if len(problems) > limit else ''
        parts.append('问题：' + '<br>'.join(shown) + more)
    return '<br>'.join(md_cell(p) for p in parts) or '—'


def render_stage_table(executions: Sequence[Mapping[str, Any]]) -> List[str]:
    header = ['阶段', '次', '开始', '结束', '耗时（s）', '命令（退出码）', '结果', '说明', '报告']
    lines = [md_row(header), '| ' + ' | '.join('---' for _ in header) + ' |']
    for e in executions:
        n = int(e.get('stage', 0))
        stage = STAGE_BY_N.get(n)
        dur = _duration(e)
        result = e.get('result') or STATUS_OPEN
        if e.get('terminate'):
            result = f'{result}（终止验收）'
        cells = [
            md_cell(f'{n} {stage.title if stage else "?"}'),
            md_cell(e.get('attempt')),
            md_cell(e.get('startedAt')),
            md_cell(e.get('endedAt')),
            md_cell('—' if dur is None else dur),
            _commands_cell(e),
            md_cell(result),
            _notes_cell(e),
            '<br>'.join(md_cell(r) for r in (e.get('reports') or [])) or '—',
        ]
        lines.append('| ' + ' | '.join(cells) + ' |')
    if not executions:
        lines.append('| — | — | — | — | — | — | 尚无执行记录 | — | — |')
    return lines


def render_log(executions: Sequence[Mapping[str, Any]]) -> str:
    lines = [
        '# Acceptance_Run 阶段记录',
        '',
        f'由 `{SELF}` 根据 `{rel(STAGES_FILE)}` 生成，每次写入记录时覆盖；请勿手工编辑。'
        '时间为本机本地时间（带 UTC 偏移），报告路径相对仓库根。',
        '',
        *render_stage_table(executions),
        '',
    ]
    return '\n'.join(lines)


def save_records(data: Dict[str, Any]) -> None:
    write_json(STAGES_FILE, data)
    write_text(LOG_FILE, render_log(data['executions']))


def new_execution(data: Dict[str, Any], n: int) -> Dict[str, Any]:
    attempt = 1 + sum(1 for e in data['executions'] if e.get('stage') == n)
    started = now_local()
    e: Dict[str, Any] = {
        'stage': n,
        'attempt': attempt,
        'startedAt': iso(started),
        'startedEpoch': time.time(),
        'endedAt': None,
        'endedEpoch': None,
        'result': None,
        'commands': [],
        'notes': [],
        'problems': [],
        'reports': [],
        'digests': {},
    }
    data['executions'].append(e)
    return e


def finish_execution(e: Dict[str, Any], result: str) -> None:
    e['result'] = result
    e['endedAt'] = iso(now_local())
    e['endedEpoch'] = time.time()


# ---------------------------------------------------------------------------
# 状态上下文
# ---------------------------------------------------------------------------


@dataclass
class Context:
    data: Dict[str, Any]
    states: Dict[int, StageState]
    current: Dict[str, Optional[str]]
    digest_errors: Dict[str, str]
    readings_before_exists: bool


def load_context() -> Context:
    data = load_records()
    current, errors = current_digests()
    run_started = {run_n: started_of(load_json(ACC_DIR / run_file))
                   for (run_n, run_file, _p) in RUN_FOR_REVIEW.values()}
    states = stage_states(data['executions'], current, started_of(load_json(OUT_RESULTS)), run_started)
    return Context(data, states, current, errors, READINGS_BEFORE.exists())


def print_next(ctx: Context) -> None:
    print('下一步：' + next_step(ctx.states, ctx.readings_before_exists, ctx.data['executions']))


# ---------------------------------------------------------------------------
# 运行型阶段
# ---------------------------------------------------------------------------


def resolve_program(program: str) -> str:
    if program == 'python':
        return sys.executable
    if program == 'npm':
        found = (shutil.which('npm.cmd') if os.name == 'nt' else None) or shutil.which('npm')
        if not found:
            raise AcceptanceError('找不到 npm（Windows 上应为 npm.cmd），请确认 Node.js 已安装并在 PATH 中')
        return found
    raise AcceptanceError(f'未知程序 {program!r}')


def run_command(cmd: Cmd) -> int:
    """以参数列表启动（不经 shell），输出直接交给当前控制台；返回退出码。"""
    argv = [resolve_program(cmd.program), *cmd.args]
    return subprocess.run(argv, cwd=REPO_ROOT, stdin=subprocess.DEVNULL).returncode


def _fresh(path: Path, since: float) -> bool:
    try:
        return path.stat().st_mtime >= since - FRESH_TOLERANCE_S
    except OSError:
        return False


def remove_copies(stage: Stage) -> None:
    """删除该阶段上一次执行复制的产物，避免判定读到旧文件。"""
    for cmd in stage.commands:
        if not cmd.copy:
            continue
        for name in cmd.copy.targets():
            target = ACC_DIR / name
            if target.is_dir():
                shutil.rmtree(target)
            elif target.exists():
                target.unlink()


def copy_artifacts(spec: Copy, since: float, notes: List[str]) -> List[str]:
    """把本次运行写出的产物从 `e2e/.out/` 复制进 `acceptance/`；返回复制后的路径（相对仓库根）。"""
    ACC_DIR.mkdir(parents=True, exist_ok=True)
    copied: List[str] = []
    pairs = [(OUT_RESULTS, spec.results), (OUT_SUMMARY, spec.summary)]
    if spec.review:
        pairs.append((OUT_REVIEW_JSON, spec.review))
    if spec.perf:
        pairs.append((OUT_PERF, spec.perf))
    for src, name in pairs:
        dst = ACC_DIR / name
        if _fresh(src, since):
            shutil.copy2(src, dst)
            copied.append(rel(dst))
        else:
            notes.append(f'{rel(src)} 不存在或不是本次运行写出的，未复制为 {name}')
    if spec.a11y:
        dst_dir = ACC_DIR / spec.a11y
        files = sorted(p for p in OUT_A11Y.glob('*.json') if _fresh(p, since)) if OUT_A11Y.is_dir() else []
        if files:
            dst_dir.mkdir(parents=True, exist_ok=True)
            for p in files:
                shutil.copy2(p, dst_dir / p.name)
            copied.append(rel(dst_dir) + '/')
        else:
            notes.append(f'{rel(OUT_A11Y)}/ 中没有本次运行写出的扫描结果，未复制')
    return copied


def delete_baselines() -> int:
    if not BASELINE_DIR.is_dir():
        return 0
    count = 0
    for p in sorted(BASELINE_DIR.glob('*.png')):
        p.unlink()
        count += 1
    return count


def run_judge(n: int) -> List[str]:
    known = known_finding_ids()
    if n == 4:
        return judge_4(load_json(ACC_DIR / 'run-4.json'))
    if n == 6:
        return judge_6(load_json(ACC_DIR / 'run-6-1.json'), load_json(ACC_DIR / 'run-6-2.json'), known)
    if n == 8:
        return judge_8(load_json(ACC_DIR / 'run-8.json'), known)
    raise AcceptanceError(f'阶段 {n} 没有判定函数')


def cmd_stage_run(n: int) -> int:
    stage = STAGE_BY_N[n]
    if stage.manual:
        raise AcceptanceError(f'阶段 {n} 是人工阶段，请用 {code(f"{SELF} stage begin {n}")}')
    ctx = load_context()
    refusal = start_refusal(n, ctx.states, ctx.data['executions'], ctx.readings_before_exists)
    if refusal:
        print(f'拒绝开始阶段 {n}：{refusal}')
        print_next(ctx)
        return 1

    data = ctx.data
    e = new_execution(data, n)
    key = ANCHOR_KEY.get(n)
    if key:
        value = ctx.current.get(key)
        if value is None:
            data['executions'].pop()
            raise AcceptanceError(f'无法计算 {key}：{ctx.digest_errors.get(key, "原因不明")}')
        e['digests'][key] = value
    remove_copies(stage)
    save_records(data)
    print(f'[阶段 {n}] {stage.title}：第 {e["attempt"]} 次执行，开始于 {e["startedAt"]}', flush=True)

    failed: List[str] = []
    result = RESULT_DONE
    try:
        if stage.delete_baselines:
            count = delete_baselines()
            e['notes'].append(f'执行前删除了 {count} 张旧基线（{rel(BASELINE_DIR)}/*.png）')
            save_records(data)
        for cmd in stage.commands:
            rec: Dict[str, Any] = {'command': cmd.display, 'startedAt': iso(now_local()), 'exitCode': None}
            e['commands'].append(rec)
            save_records(data)
            print(f'[阶段 {n}] $ {cmd.display}', flush=True)
            t0 = time.time()
            rc = run_command(cmd)
            rec.update(exitCode=rc, endedAt=iso(now_local()), durationSec=round(time.time() - t0, 1))
            if cmd.copy:
                e['reports'] += copy_artifacts(cmd.copy, t0, e['notes'])
            save_records(data)
            if rc != 0:
                failed.append(cmd.display)
                e['notes'].append(f'命令以非零退出码结束：`{cmd.display}`（退出码 {rc}）')
                if not stage.run_all:
                    break
        all_ran = len(e['commands']) == len(stage.commands)
        if stage.judge is not None and all_ran:
            e['problems'] = run_judge(stage.judge)
            if stage.judge == 8:
                e['accepted'] = accepted_limits_8(load_json(ACC_DIR / 'run-8.json'))
                if e['accepted']:
                    e['notes'].append(accepted_limits_note(e['accepted']))
            if e['problems']:
                e['notes'].append(f'judge {stage.judge} 未通过（{len(e["problems"])} 项）')
        if failed or e['problems']:
            result = RESULT_FAILED
    except KeyboardInterrupt:
        result = RESULT_INTERRUPTED
        running = [c['command'] for c in e['commands'] if c.get('exitCode') is None]
        e['notes'].append('被 Ctrl+C 打断' + (f'：正在执行 `{running[-1]}`' if running else ''))
    except Exception as exc:  # noqa: BLE001  启动失败等：记为失败后照常收尾
        result = RESULT_FAILED
        e['notes'].append(f'执行出错：{type(exc).__name__}: {exc}')
    finally:
        finish_execution(e, result)
        save_records(data)

    print(f'[阶段 {n}] 结果：{result}（{e["endedAt"]}）')
    for note in e['notes']:
        print(f'  - {note}')
    for a in e.get('accepted') or []:
        print(f'  ~ {ACCEPTED_LIMIT_LABEL}：{a["case"]}：{a["reason"]}')
    for p in e['problems']:
        print(f'  * {p}')
    print_next(load_context())
    return 0 if result == RESULT_DONE else 1


# ---------------------------------------------------------------------------
# 人工阶段
# ---------------------------------------------------------------------------


def baseline_files() -> List[str]:
    return sorted(p.name for p in BASELINE_DIR.glob('*.png')) if BASELINE_DIR.is_dir() else []


def manual_check(n: int, e: Mapping[str, Any]) -> List[str]:
    if n == 5:
        return check_baseline_review(read_text(BASELINE_REVIEW_FILE), baseline_files(), known_finding_ids(),
                                     read_text(BASELINES_TS))
    if n in RUN_FOR_REVIEW:
        _run_n, run_file, profile = RUN_FOR_REVIEW[n]
        review_file = 'review-report-fixture.json' if profile == 'fixture' else 'review-report-real.json'
        return check_review_record(
            parse_review_record(read_text(REVIEW_RECORD_FILES[profile])),
            load_json(ACC_DIR / review_file), profile,
            started_of(load_json(ACC_DIR / run_file)),
            report_md_started(read_text(OUT_REVIEW_MD)),
            known_finding_ids(), evidence_names())
    if n == LAST_STAGE:
        return check_stage11(float(e.get('startedEpoch') or 0))
    return []


BEGIN_HINTS: Dict[int, str] = {
    5: '逐张读取 e2e/baselines/*.png，在 baseline-review.md 每张写一行'
       '「<文件名> | 接受/含已知缺陷接受/重拍 | 依据 | F-xxx | Reviewer | 日期」。',
    7: '读取 e2e/.out/review/review-report.md 与 PNG，按本脚本文件头的格式写 review-record-fixture.md；'
       '"不通过"按 13.7 记 Finding 并把证据 PNG 复制到 findings/。',
    9: '读取 e2e/.out/review/review-report.md 与 PNG，按本脚本文件头的格式写 review-record-real.md；'
       '"不通过"按 13.7 记 Finding 并把证据 PNG 复制到 findings/。',
    11: f'依次执行 {code(f"{SELF} readings --out {rel(READINGS_AFTER)}")}、{code(f"{SELF} scope")}、'
        f'{code(f"{SELF} summary")}，核对 acceptance.md 各节。',
}


def cmd_stage_begin(n: int, terminate: bool) -> int:
    stage = STAGE_BY_N[n]
    if not stage.manual:
        raise AcceptanceError(f'阶段 {n} 是运行型阶段，请用 {code(f"{SELF} stage run {n}")}')
    if terminate and n != LAST_STAGE:
        raise AcceptanceError('--terminate 仅限阶段 11')
    ctx = load_context()
    refusal = start_refusal(n, ctx.states, ctx.data['executions'], ctx.readings_before_exists, terminate)
    if refusal:
        print(f'拒绝开始阶段 {n}：{refusal}')
        print_next(ctx)
        return 1
    e = new_execution(ctx.data, n)
    e['reports'] = list(stage.manual_reports)
    if terminate:
        e['terminate'] = True
        e['notes'].append('用户决定终止验收（18.1）')
    save_records(ctx.data)
    print(f'[阶段 {n}] {stage.title}：第 {e["attempt"]} 次执行，开始于 {e["startedAt"]}')
    print('  ' + BEGIN_HINTS.get(n, ''))
    print('  完成后：' + code(f'{SELF} stage end {n} --result 完成'))
    return 0


def cmd_stage_end(n: int, result: str, note: Optional[str]) -> int:
    stage = STAGE_BY_N[n]
    data = load_records()
    mine = [e for e in data['executions'] if e.get('stage') == n]
    if not mine or mine[-1].get('result') is not None:
        raise AcceptanceError(f'阶段 {n} 没有进行中的执行')
    e = mine[-1]
    if result == RESULT_DONE:
        if not stage.manual:
            raise AcceptanceError(f'阶段 {n} 是运行型阶段，只能由 stage run 判定完成；'
                                  '此处只能以 失败 / 中断 结束遗留的执行')
        problems = manual_check(n, e)
        if problems:
            print(f'阶段 {n} 的核对未通过（{len(problems)} 项），执行保持"进行中"：')
            for p in problems:
                print(f'  * {p}')
            print('修正记录后再次 ' + code(f'{SELF} stage end {n} --result 完成')
                  + '，或以 ' + code(f'{SELF} stage end {n} --result 失败|中断') + ' 结束本次执行。')
            return 1
        key = ANCHOR_KEY.get(n)
        if key:
            e['digests'][key] = DIGEST_FUNCS[key]()
    for c in e.get('commands') or []:
        if c.get('exitCode') is None:
            c['endedAt'] = c.get('endedAt') or iso(now_local())
    if note:
        e['notes'].append(note)
    finish_execution(e, result)
    save_records(data)
    print(f'[阶段 {n}] 结果：{result}（{e["endedAt"]}）')
    print_next(load_context())
    return 0


# ---------------------------------------------------------------------------
# Checklist H1–H11 的覆盖方式（需求附录 B；18.7 最后一项）
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ChecklistItem:
    id: str
    title: str
    #: 自动断言：相关用例标题（任一层）开头的需求编号。
    reqs: Tuple[str, ...]
    #: 视觉评审：相关 Review_Shot 的 RS 编号。
    shots: Tuple[str, ...]
    #: 仅记录的部分。
    record_only: Optional[str] = None


CHECKLIST: Tuple[ChecklistItem, ...] = (
    ChecklistItem('H1', '3000+ / 12,000 节点书上目录抽屉流畅', ('8.7', '8.8'), ('RS-09',), '14.2 (a)(b)'),
    ChecklistItem('H2', '检索连续输入流畅', (), (), '14.2 (c)(d)，不设门'),
    ChecklistItem('H3', '进度恢复到同一段落', ('9.8', '9.9', '9.10'), ()),
    ChecklistItem('H4', '高亮约 5 s 后清除', ('9.3', '9.4'), ('RS-10', 'RS-11')),
    ChecklistItem('H5', '卷节点在目录可见、导航跳过', ('8.2', '8.3', '8.4', '8.5'), ('RS-08',)),
    ChecklistItem('H6', '5 个主题色块正确、无闪烁', ('10.4', '10.5', '10.6'), ('RS-12', 'RS-13')),
    ChecklistItem('H7', '骨架与卡片网格一致', ('7.1',), ('RS-03',)),
    ChecklistItem('H8', '下载文件名与 BOM', ('10.1', '10.2', '10.3'), ()),
    ChecklistItem('H9', '后退关闭弹窗', ('7.10',), ()),
    ChecklistItem('H10', '不确定态进度条在动', ('11.5',), ('RS-14',)),
    ChecklistItem('H11', '缓存占用显示', ('11.6',), ('RS-16',)),
)

_LEADING_REQ = re.compile(r'\s*(?:[/、,，]\s*)?(\d{1,2})\.(\d{1,2})(?:\s*[–—-]\s*(\d{1,2})\.(\d{1,2}))?(?![\d.])')


def leading_requirements(segment: str) -> Set[str]:
    """标题一层开头连续出现的需求编号：`9.2 9.3 …` → {9.2, 9.3}；`10.16–10.18 …` 展开为区间。"""
    out: Set[str] = set()
    pos = 0
    while True:
        m = _LEADING_REQ.match(segment, pos)
        if not m or m.end() == pos:
            return out
        a, b = int(m.group(1)), int(m.group(2))
        if m.group(3):
            c, d = int(m.group(3)), int(m.group(4))
            if a == c and b <= d:
                out.update(f'{a}.{x}' for x in range(b, d + 1))
            else:
                out.update({f'{a}.{b}', f'{c}.{d}'})
        else:
            out.add(f'{a}.{b}')
        pos = m.end()


def row_requirements(row: Mapping[str, Any]) -> Set[str]:
    out: Set[str] = set()
    for segment in str(row.get('title') or '').split(' › '):
        out |= leading_requirements(segment)
    return out


def checklist_coverage(item: ChecklistItem, runs: Sequence[Tuple[str, Optional[Mapping[str, Any]], str]],
                       reports: Mapping[str, Optional[Mapping[str, Any]]],
                       records: Mapping[str, Optional[ReviewRecord]]) -> Tuple[str, List[str]]:
    """一项的覆盖方式与明细。`runs` 为 (写法, results.json, profile)，依次为阶段 6 第 2 次与阶段 8。"""
    modes: List[str] = []
    gaps: List[str] = []
    details: List[str] = []
    if item.reqs:
        wanted = set(item.reqs)
        grouped: Dict[Tuple[str, str], List[str]] = {}
        related: List[Mapping[str, Any]] = []
        for label, run, profile in runs:
            if not isinstance(run, Mapping):
                details.append(f'{label}：结果文件缺失')
                continue
            for row in rows_of(run):
                if row.get('profile') == profile and row_requirements(row) & wanted:
                    related.append(row)
                    grouped.setdefault((str(row.get('file')), str(row.get('title'))), []).append(
                        f'{label} {outcome_text(row)}')
        reqs = '、'.join(item.reqs)
        if not related:
            gaps.append(f'自动断言：阶段 6、8 的结果中没有需求 {reqs} 的用例')
        elif all(r.get('outcome') == 'skipped' for r in related):
            why = sorted({str((r.get('skip') or {}).get('reason') or '未注明') for r in related})
            gaps.append(f'自动断言：需求 {reqs} 的用例全部被跳过（{"；".join(why)}）')
        else:
            modes.append(f'自动断言（需求 {reqs}）')
        for (file, title), results in sorted(grouped.items()):
            details.append(f'{file} › {title}：{"；".join(results)}')
    if item.shots:
        shots: List[Tuple[str, Mapping[str, Any]]] = []
        for profile in ('fixture', 'real'):
            report = reports.get(profile)
            if not isinstance(report, Mapping):
                continue
            for s in report.get('shots') or []:
                if isinstance(s, Mapping) and s.get('rs') in item.shots and s.get('profile') == profile:
                    shots.append((profile, s))
        names = '、'.join(item.shots)
        if not shots:
            gaps.append(f'视觉评审：没有 {names} 的 Review_Report 数据')
        elif not any(s.get('captured') for _p, s in shots):
            why = sorted({str(s.get('reason') or '原因不明') for _p, s in shots})
            gaps.append(f'视觉评审：{names} 均未拍摄（{"；".join(why)}）')
        else:
            modes.append(f'视觉评审（{names}）')
        for profile, s in shots:
            name = str(s.get('name'))
            if not s.get('captured'):
                details.append(f'{s.get("rs")} {name}（{profile}）：未拍摄：{s.get("reason") or "原因不明"}')
                continue
            rec = records.get(profile)
            marks = []
            for k in range(1, int(s.get('criteria') or 0) + 1):
                found = [v for v in (rec.verdicts if rec else []) if v[0] == name and v[1] == k]
                if not found:
                    marks.append(f'#{k} 尚无判定')
                else:
                    v = found[0]
                    marks.append(f'#{k} {v[2]}' + (f'（{"、".join(finding_ids_in(v[4]))}）' if finding_ids_in(v[4]) else ''))
            details.append(f'{s.get("rs")} {name}（{profile}）：{"、".join(marks) or "无准则"}')
    record_only = [f'仅记录（{item.record_only}）'] if item.record_only else []
    if modes and gaps:
        details = [f'部分未覆盖：{g}' for g in gaps] + details
    if modes or not gaps:
        mode = '；'.join(modes + record_only)
    else:
        mode = '；'.join(['未覆盖：' + '；'.join(gaps)] + record_only)
    return mode, details


# ---------------------------------------------------------------------------
# 验收小结（acceptance.md，18.7；设计"验收小结"）
# ---------------------------------------------------------------------------


def _num(value: Any) -> str:
    if value is None:
        return '—'
    if isinstance(value, float):
        return f'{value:.1f}'
    return str(value)


def render_stats(run62: Optional[Mapping[str, Any]], run8: Optional[Mapping[str, Any]]) -> List[str]:
    rows = []
    missing = []
    for label, run in (('阶段 6 第 2 次（run-6-2.json）', run62), ('阶段 8（run-8.json）', run8)):
        if not isinstance(run, Mapping):
            missing.append(f'{label}：未生成（结果文件不存在）')
            continue
        for s in run.get('stats') or []:
            if not isinstance(s, Mapping) or not s.get('ran'):
                continue
            c = s.get('counts') or {}
            rows.append([label, s.get('profile'), *[c.get(k, 0) for k in OUTCOME_ORDER], s.get('notRun', 0),
                         _num(s.get('wallSec'))])
    header = ['来源', 'Profile', *[OUTCOME_LABELS[k] for k in OUTCOME_ORDER], '未执行', '耗时（s）']
    return (md_table(header, rows) if rows else []) + [f'- {m}' for m in missing]


def render_baseline_counts(text: Optional[str]) -> List[str]:
    if text is None:
        return [f'未生成：{rel(BASELINE_REVIEW_FILE)} 不存在。']
    rows = parse_baseline_review(text)
    counts = {v: sum(1 for r in rows if r.verdict == v) for v in BASELINE_VERDICTS}
    lines = ['- ' + '，'.join(f'{v} {counts[v]} 张' for v in BASELINE_VERDICTS) + f'（共 {len(rows)} 行）']
    known = [r for r in rows if r.verdict == '含已知缺陷接受']
    if known:
        lines += ['', *md_table(['基线', 'Finding'], [[r.file, '、'.join(finding_ids_in(r.finding)) or '—'] for r in known])]
    return lines


PERF_STATUS = {'within': '未超预算', 'over': '超预算', 'uncollected': '未采集'}


def render_perf(perf: Optional[Mapping[str, Any]]) -> List[str]:
    if not isinstance(perf, Mapping):
        return ['未生成：acceptance/perf.json 不存在（阶段 8 未复制 perf.json）。']
    env = perf.get('env') if isinstance(perf.get('env'), Mapping) else {}
    lines = [
        f'- 运行开始时间：{perf.get("runStartedAt", "—")}',
        f'- CPU：{env.get("cpu", "—")}（{env.get("cores", "—")} 逻辑核）；Chromium：{env.get("chromium", "—")}；'
        f'headless：{env.get("headless", "—")}',
        '- 超预算只做标注，不影响退出码与阶段 8 的判定（1.7、14.4、18.4）。',
        '',
    ]
    rows = []
    for item in perf.get('items') or []:
        if not isinstance(item, Mapping):
            continue
        readings = '、'.join('未采集' if r is None else _num(r) for r in item.get('readings') or [])
        status = PERF_STATUS.get(str(item.get('status')), str(item.get('status')))
        if item.get('reason'):
            status += f'（{item["reason"]}）'
        rows.append([item.get('key'), readings, _num(item.get('median')), _num(item.get('max')),
                     _num(item.get('budgetMs')), status])
    lines += md_table(['指标', '读数（ms）', '中位数', '最大值', '预算（ms）', '状态'], rows)
    loads = [b for b in perf.get('bookLoads') or [] if isinstance(b, Mapping)]
    if loads:
        lines += ['', '`[book-load]`：', '']
        lines += md_table(['书', '用例', 'source', 'gz', 'chars', 'decompress', 'total'], [
            [b.get('bookId'), b.get('test'), b.get('source', '未采集'), b.get('gz', b.get('reason', '—')),
             b.get('chars'), b.get('decompress'), b.get('total')] for b in loads])
    return lines


IMPACTS = ('critical', 'serious', 'moderate', 'minor')
A11Y_STATUS = {'ok': '完成', 'failed': '扫描失败', 'skipped': '跳过'}


def render_a11y(directory: Path) -> List[str]:
    files = sorted(directory.glob('*.json')) if directory.is_dir() else []
    if not files:
        return ['未生成：acceptance/a11y/ 中没有扫描结果（阶段 6 未复制）。']
    rows = []
    versions: Set[str] = set()
    totals = {k: 0 for k in (*IMPACTS, 'none')}
    for path in files:
        data = load_json(path)
        if not isinstance(data, Mapping):
            rows.append([path.name, '—', '—', '无法解析', *['—'] * 6])
            continue
        if data.get('axeVersion'):
            versions.add(str(data['axeVersion']))
        per: Dict[str, List[int]] = {k: [0, 0] for k in (*IMPACTS, 'none')}
        for v in data.get('violations') or []:
            if isinstance(v, Mapping):
                key = v.get('impact') if v.get('impact') in IMPACTS else 'none'
                per[key][0] += 1
                per[key][1] += int(v.get('nodes') or 0)
        for k in per:
            totals[k] += per[k][0]
        status = A11Y_STATUS.get(str(data.get('status')), str(data.get('status')))
        if data.get('reason'):
            status += f'（{data["reason"]}）'
        incomplete = len([x for x in data.get('incomplete') or [] if isinstance(x, Mapping)])
        rows.append([data.get('name', path.stem), data.get('view'), data.get('theme'), status,
                     *[f'{per[k][0]}（{per[k][1]} 节点）' if per[k][0] else '0' for k in (*IMPACTS, 'none')], incomplete])
    rows.append(['合计', '', '', '', *[totals[k] for k in (*IMPACTS, 'none')], ''])
    lines = [f'- axe-core：{"、".join(sorted(versions)) or "—"}；单元格为违规规则数（节点数）。'
             'critical 与 serious 待记入 Findings_Log（15.5）；违规不影响退出码（1.7）。', '']
    return lines + md_table(['扫描', '视图', '主题', '状态', *IMPACTS, '未分级', 'incomplete'], rows)


def render_accepted_limits(items: Sequence[Mapping[str, str]]) -> List[str]:
    """第 3 节：阶段 8 按用户决定接受的数据限制（风险 R5）。"""
    if not items:
        return []
    lines = ['', f'{ACCEPTED_LIMIT_LABEL}（阶段 8 按 [4.7] / [8.13] 跳过；风险 R5，用户决定（验收前）允许；'
                 f'共 {len(items)} 项，已列入第 7 节的待人工复核清单）：', '']
    return lines + md_table(['用例', '类别', '跳过原因'], [
        [a['case'], f'[{a["kind"]}] {SKIP_KIND_LABELS.get(a["kind"], a["kind"])}', a['reason']] for a in items])


def render_review_records(records: Mapping[str, Optional[ReviewRecord]],
                          accepted: Sequence[Mapping[str, str]] = ()) -> List[str]:
    rows = []
    pending = []
    for profile, path in REVIEW_RECORD_FILES.items():
        rec = records.get(profile)
        if rec is None:
            rows.append([profile, '—', '—', '—', '—', f'未生成（{rel(path)} 不存在）'])
            continue
        counts = [sum(1 for v in rec.verdicts if v[2] == x) for x in REVIEW_VERDICTS]
        rows.append([profile, *counts, len(rec.uncaptured), rel(path)])
        pending += [[profile, f'{p[0]}#{p[1]}', p[2]] for p in rec.pending]
    pending += [[a['profile'], a['case'], f'{ACCEPTED_LIMIT_LABEL}：{a["reason"]}'] for a in accepted]
    lines = md_table(['Profile', *REVIEW_VERDICTS, '未拍摄（张）', '记录'], rows)
    lines += ['', f'待人工复核（{len(pending)} 条，交由用户复核，不影响验收结论）：', '']
    lines += md_table(['Profile', '条目', '原因'], pending) if pending else ['- 无']
    return lines


def render_findings(findings: Sequence[Mapping[str, Optional[str]]]) -> List[str]:
    if not findings:
        return [f'无（{rel(FINDINGS_FILE)} 中没有 `## F-xxx` 条目）。']
    return md_table(['编号', '标题', '严重度'], [[f['id'], f['title'], f['severity'] or '未写明'] for f in findings])


def render_readings(before: Optional[Mapping[str, Any]], after: Optional[Mapping[str, Any]]) -> List[str]:
    b = before.get('values', {}) if isinstance(before, Mapping) else {}
    a = after.get('values', {}) if isinstance(after, Mapping) else {}
    lines = [
        f'- 阶段 1 开始前：{before.get("takenAt", "—") if isinstance(before, Mapping) else "未记录"}（{rel(READINGS_BEFORE)}）',
        f'- 阶段 11 开始时：{after.get("takenAt", "—") if isinstance(after, Mapping) else "未记录"}（{rel(READINGS_AFTER)}）',
        '',
    ]
    rows = []
    for key, label in READING_KEYS:
        if not isinstance(before, Mapping) or not isinstance(after, Mapping):
            result = '无法比较'
        else:
            result = '一致' if b.get(key) == a.get(key) else '不一致'
        rows.append([label, reading_text(b.get(key)) if before else '—', reading_text(a.get(key)) if after else '—', result])
    return lines + md_table(['读数', '阶段 1 开始前', '阶段 11 开始时', '比较'], rows)


def render_scope(result: Optional[Mapping[str, Any]], error: Optional[str]) -> List[str]:
    if result is None:
        return [f'无法核对：{error}']
    excluded, pkg_excluded = result['excluded'], result['packageJsonExcluded']
    lines = [
        f'- 基准提交：`{result["base"]}`',
        f'- 路径：`git diff --name-only --no-renames <基准>` 与 `git ls-files --others --exclude-standard` 的并集，'
        f'共 {len(result["paths"])} 个，越界 {len(result["violations"])} 个，{PRE_EXISTING_LABEL} {len(excluded)} 个'
        '（不计入核对）。',
        f'- package.json 内容核对：{"通过" if not result["packageJson"] else "不通过"}',
    ]
    lines += [f'  - {p}' for p in result['packageJson']]
    if excluded or pkg_excluded:
        lines.append(f'- {PRE_EXISTING_LABEL}（实施开始前已暂存；用户决定（验收前）不计入核对，'
                     '清单为 `acceptance.py` 的 `PRE_EXISTING_FILES` / `PRE_EXISTING_PACKAGE_CHANGES`）：')
        lines += [f'  - {code(p)}' for p in excluded]
        lines += [f'  - package.json：{p}' for p in pkg_excluded]
    lines += [f'- 结论：{"通过" if result["ok"] else "不通过"}', '']

    def verdict_cell(e: Mapping[str, Any]) -> str:
        if e['allowed']:
            return f'允许（{e["rule"]}）'
        return f'不计入核对（{PRE_EXISTING_LABEL}）' if e['excluded'] else '越界'

    lines += md_table(['路径', '核对'], [[e['path'], verdict_cell(e)] for e in result['paths']])
    return lines


def render_checklist(runs: Sequence[Tuple[str, Optional[Mapping[str, Any]], str]],
                     reports: Mapping[str, Optional[Mapping[str, Any]]],
                     records: Mapping[str, Optional[ReviewRecord]]) -> List[str]:
    coverage = [(item, *checklist_coverage(item, runs, reports, records)) for item in CHECKLIST]
    lines = md_table(['#', '核对项', '覆盖方式'], [[item.id, item.title, mode] for item, mode, _d in coverage])
    for item, _mode, details in coverage:
        if details:
            lines += ['', f'{item.id} 明细：', '']
            lines += [f'- {d}' for d in details]
    return lines


def render_summary(ctx: Context) -> str:
    before, after = load_json(READINGS_BEFORE), load_json(READINGS_AFTER)
    conclusion, reasons = verdict(ctx.states, before, after)
    try:
        scope_result: Optional[Dict[str, Any]] = collect_scope(read_base_commit())
        scope_error: Optional[str] = None
    except AcceptanceError as exc:
        scope_result, scope_error = None, str(exc)
    run62, run8 = load_json(ACC_DIR / 'run-6-2.json'), load_json(ACC_DIR / 'run-8.json')
    reports = {'fixture': load_json(ACC_DIR / 'review-report-fixture.json'),
               'real': load_json(ACC_DIR / 'review-report-real.json')}
    records: Dict[str, Optional[ReviewRecord]] = {}
    for profile, path in REVIEW_RECORD_FILES.items():
        text = read_text(path)
        records[profile] = parse_review_record(text) if text is not None else None
    accepted = accepted_limits_8(run8)
    pending = sum(len(r.pending) for r in records.values() if r) + len(accepted)
    runs = (('阶段 6 第 2 次', run62, 'fixture'), ('阶段 8', run8, 'real'))

    lines = ['# 验收小结：E2E 与截图视觉测试（e2e-visual-testing）', '',
             f'由 `{SELF} summary` 于 {iso(now_local())} 生成，Kiro 核对。节序同需求 18.7。', '']
    lines += ['## 1. 验收结论', '', f'**{conclusion}**', '']
    lines += [f'- {r}' for r in reasons]
    if reasons:
        lines.append('')
    lines.append(f'- 待人工复核 {pending} 条（见第 7 节），交由用户复核，不影响结论（18.5、18.7）。')
    if accepted:
        lines.append(f'- {accepted_limits_note(accepted)}（阶段 8 按 [4.7] / [8.13] 跳过，用户决定（验收前）允许；'
                     '明细见第 3 节）。')
    if scope_result is None or not scope_result['ok']:
        lines.append('- 16.5 的改动范围核对未通过或无法完成（见第 10 节）；按 18.7，它不参与验收结论。')
    terminated = [e for e in ctx.data['executions'] if e.get('stage') == LAST_STAGE and e.get('terminate')]
    if terminated:
        lines.append('- 阶段 11 以"终止验收"开始（用户决定）。')

    lines += ['', '## 2. 阶段记录', '']
    lines += md_table(['阶段', '名称', '当前状态', '说明'],
                      [[n, STAGE_BY_N[n].title, ctx.states[n].label, describe_state(ctx.states[n])]
                       for n in STAGE_NUMBERS])
    lines += ['', f'每次执行的记录（与 `{rel(LOG_FILE)}` 相同）：', '']
    lines += render_stage_table(ctx.data['executions'])
    lines += ['', '## 3. 各 Library_Profile 的用例统计', '', *render_stats(run62, run8),
              *render_accepted_limits(accepted)]
    lines += ['', '## 4. Pixel_Baseline 评审', '', *render_baseline_counts(read_text(BASELINE_REVIEW_FILE))]
    lines += ['', '## 5. Perf_Metrics', '', *render_perf(load_json(ACC_DIR / 'perf.json'))]
    lines += ['', '## 6. A11y_Scan 违规计数', '', *render_a11y(ACC_DIR / 'a11y')]
    lines += ['', '## 7. Review_Record', '', *render_review_records(records, accepted)]
    lines += ['', '## 8. 新增 Finding', '', *render_findings(parse_findings(read_text(FINDINGS_FILE)))]
    lines += ['', '## 9. 读数（18.6）', '', *render_readings(before, after)]
    lines += ['', '## 10. 改动范围（16.5）', '', *render_scope(scope_result, scope_error)]
    lines += ['', '## 11. Checklist H1–H11 的覆盖方式', '', *render_checklist(runs, reports, records), '']
    return '\n'.join(lines)


# ---------------------------------------------------------------------------
# 其余子命令
# ---------------------------------------------------------------------------


def cmd_readings(out: str) -> int:
    path = Path(out)
    if not path.is_absolute():
        path = Path.cwd() / path
    if path.resolve() == READINGS_BEFORE.resolve() and path.exists() and load_records()['executions']:
        raise AcceptanceError(f'阶段已开始执行，不能覆盖 {rel(READINGS_BEFORE)}（18.6 的"阶段 1 开始前"读数）')
    readings = take_readings()
    write_json(path, readings)
    print(f'读数已写入 {rel(path)}（{readings["takenAt"]}）：')
    for key, label in READING_KEYS:
        print(f'  {label}：{reading_text(readings["values"][key])}')
    return 0


def cmd_status() -> int:
    ctx = load_context()
    print('Acceptance_Run 状态（' + rel(STAGES_FILE) + '）')
    for n in STAGE_NUMBERS:
        s = ctx.states[n]
        print(f'  阶段 {n:>2}「{STAGE_BY_N[n].title}」：{s.label}'
              + ('' if s.status == STATUS_NONE else f' — {describe_execution(s.last)}'))
        for r in s.reasons:
            print(f'      失效：{r}')
    print('当前摘要值：' + '；'.join(f'{k} {short(v)}' for k, v in ctx.current.items()))
    for k, err in ctx.digest_errors.items():
        print(f'  {k} 无法计算：{err}')
    print(f'阶段 1 开始前的读数：{"已记录" if ctx.readings_before_exists else "未记录"}（{rel(READINGS_BEFORE)}）')
    print_next(ctx)
    return 0


def cmd_scope() -> int:
    result = collect_scope(read_base_commit())
    allowed = [e for e in result['paths'] if e['allowed']]
    print(f'基准提交：{result["base"]}')
    print(f'路径 {len(result["paths"])} 个：允许 {len(allowed)} 个，{PRE_EXISTING_LABEL} {len(result["excluded"])} 个'
          f'（用户决定（验收前）不计入核对），越界 {len(result["violations"])} 个')
    for p in result['excluded']:
        print(f'  {PRE_EXISTING_LABEL}（不计入核对）：{p}')
    for p in result['violations']:
        print(f'  越界：{p}')
    for p in result['packageJsonExcluded']:
        print(f'  package.json：{p}，不计入核对')
    if result['packageJson']:
        for p in result['packageJson']:
            print(f'  package.json：{p}')
    else:
        print('  package.json：' + ('除上述排除项外，' if result['packageJsonExcluded'] else '')
              + 'devDependencies、scripts 以外的键不变，已有 devDependencies 的版本不变')
    print(f'结论：{"通过" if result["ok"] else "不通过"}')
    return 0 if result['ok'] else 1


def cmd_summary() -> int:
    ctx = load_context()
    text = render_summary(ctx)
    write_text(SUMMARY_FILE, text)
    conclusion, _ = verdict(ctx.states, load_json(READINGS_BEFORE), load_json(READINGS_AFTER))
    print(f'验收小结已写入 {rel(SUMMARY_FILE)}；验收结论：{conclusion}')
    return 0


def parse_args(argv: Optional[Sequence[str]]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog=SELF, description='Acceptance_Run 助手（需求 18、16.5）。格式与规则见本文件头部的说明。')
    sub = parser.add_subparsers(dest='command', required=True)

    p = sub.add_parser('readings', help='记录 18.6 的读数')
    p.add_argument('--out', required=True, help='输出文件（相对当前目录）')

    stage = sub.add_parser('stage', help='执行或记录阶段')
    stage_sub = stage.add_subparsers(dest='action', required=True)
    p = stage_sub.add_parser('run', help='执行运行型阶段 1–4、6、8、10 的既定命令')
    p.add_argument('n', type=int, choices=[s.n for s in STAGES if not s.manual])
    p = stage_sub.add_parser('begin', help='开始人工阶段 5、7、9、11')
    p.add_argument('n', type=int, choices=[s.n for s in STAGES if s.manual])
    p.add_argument('--terminate', action='store_true', help='仅限阶段 11：用户决定终止验收')
    p = stage_sub.add_parser('end', help='结束进行中的执行')
    p.add_argument('n', type=int, choices=list(STAGE_NUMBERS))
    p.add_argument('--result', required=True, choices=list(RESULTS))
    p.add_argument('--note', help='写入该次执行记录的说明')

    sub.add_parser('status', help='各阶段状态、失效原因与下一步')
    sub.add_parser('scope', help='16.5 改动范围核对（只打印，不写文件）')
    sub.add_parser('summary', help='写 acceptance.md')
    return parser.parse_args(argv)


def main(argv: Optional[Sequence[str]] = None) -> int:
    _force_utf8(sys.stdout)
    _force_utf8(sys.stderr)
    args = parse_args(argv)
    try:
        if args.command == 'readings':
            return cmd_readings(args.out)
        if args.command == 'status':
            return cmd_status()
        if args.command == 'scope':
            return cmd_scope()
        if args.command == 'summary':
            return cmd_summary()
        if args.action == 'run':
            return cmd_stage_run(args.n)
        if args.action == 'begin':
            return cmd_stage_begin(args.n, args.terminate)
        return cmd_stage_end(args.n, args.result, args.note)
    except AcceptanceError as exc:
        print(f'错误：{exc}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
