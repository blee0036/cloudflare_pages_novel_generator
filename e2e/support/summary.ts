/**
 * Run_Summary 的判定与渲染（设计"Run_Summary（需求 17、6.9）"与 Data Models"Run_Summary 模型"；
 * 需求 1.7、6.9、17.1–17.5、17.7）。
 *
 * 本文件全是纯函数：不读写文件、不访问网络、不修改参数。reporter（任务 16.4）只做收集与 I/O：
 *
 * 1. `onTestEnd` / `onEnd` 中把每个 `TestCase` 与其唯一的 `TestResult`（`retries: 0`）整理成
 *    `CaseFacts`；`onError` 的错误信息按顺序收集；`onBegin` 记下套件中的用例数。
 * 2. `onEnd` 读 `abort.json`（`isAbortFromRun` 排除残留）、`fixture-failed.json`、`real-precheck.json`，
 *    取结束快照并与开始快照比对，得到 Review_Report 一致性违规、产物是否存在，组装 `RunFacts`。
 * 3. `buildRunSummary(facts)` 得到 `RunSummaryModel`；`renderSummary(model)` 写 `summary.md`，
 *    `JSON.stringify(model)` 写 `results.json`；`model.exitCode` 非 0 时 `onEnd` 返回 `failed`。
 *
 * ## 与设计的差异（均为补充，已核对需求）
 *
 * - 运行起止（R4，任务 1.5 实测）：`onBegin` 在 globalSetup 结束之后才被调用，所以开始时间取
 *   `onEnd` 的 `result.startTime`（早于 globalSetup 开始），总耗时取 `result.duration`，不用
 *   "`onBegin` 到 `onEnd`"。Perf_Metrics 表头的运行开始时间应与 `startedAt` 为同一字符串。
 * - "未收集"（17.7）：不以"`onBegin` 未被调用"判断（用例文件加载失败时 `onBegin` 照样被调用，
 *   套件为 0 个用例）。判为未收集当且仅当 `abort.json` 存在（globalSetup 中止必在收集之前），
 *   或 `onBegin` 的套件为 0 个用例且收到过 `onError`（`isCollected`）。
 * - 中止信息（`resolveAbort`）除 globalSetup 的 `abort.json` 外还有两种来源，阶段名见 `RUN_STAGES`：
 *   用例收集失败（"用例收集"，原因为 `onError` 的首行）；运行被中断或超出全局超时（"用例执行"，
 *   设计错误处理表）。三者都使退出码为 1（"浏览器检查"为 3）。
 * - 运行级失败多一种 `run-error`：未被上面两条中止吸收的 `onError`（如 globalTeardown 抛错）。
 *   Playwright 此时以退出码 1 结束，summary 写出的退出码须与之一致（设计"退出码"一条）。
 * - `fixture-failed` 另带 `reason`（`FixtureFailure.reason`），summary 据此写一句话原因。
 * - `CaseRow.artifacts` 的三项取 `ArtifactRef`（`{ path }` 或 `{ missing: 原因 }`），而不是可选字符串：
 *   `console.log` 写入失败时要写"未生成（原因）"（设计错误处理表），可选字符串表达不了原因。
 * - 模型另有 `checks`（第 10 节的夹具与 real 核对明细）与 `sections`（第 11 节）。第 11 节的
 *   视觉回归、Perf_Metrics、A11y_Scan 由任务 18.6、19.6、20.5 各自产出 `ExtraSection`；接入之前，
 *   reporter 以 `extraSectionNotRun` 判"未运行"，其余写 `{ status: "notGenerated", reason }`。
 *
 * ## 归类（设计"归类"一条；属性 12）
 *
 * `classify`：`status` 为 `skipped` → 跳过；`expectedStatus` 为 `failed`（`test.fail()`）时，
 * `failed` → 预期失败、`passed` → 意外通过、其余（含 `timedOut`）→ 失败；`expectedStatus` 为
 * `passed` 时，`passed` → 通过、其余 → 失败。`interrupted` 与没有结果的用例记"未执行"（`notRun`），
 * 不进五类计数。`expectedStatus` 取其他值（Playwright 只会给出 `skipped`，且此时 `status` 也是
 * `skipped`）时按 `passed` 的规则判定。
 *
 * ## 跳过原因与 Finding 编号
 *
 * 跳过原因以约定前缀开头（`[3.9]`、`[4.3]`、`[4.7]`、`[8.13]`、`[16.4 F-xxx]`，见 `SKIP_KINDS`），
 * 其余归为 `other`。Finding 编号按 `/F-\d{3,}/g` 提取（`findingIds`）：预期失败与意外通过取自
 * `fail` 注解的 description 与用例标题（16.2 要求标题注明 `F-xxx`）；16.4 跳过取自跳过原因。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TestStatus } from "@playwright/test";
import type { FullResult } from "@playwright/test/reporter";
import { REVIEW_DIR } from "../review/catalog";
import { REVIEW_REPORT_MD, describeViolation, type CaseOutcome, type Violation } from "../review/consistency";
import { ABORT_STAGES, type AbortCheck, type AbortInfo } from "./abort";
import { ATTACHMENTS, type StepAtEnd } from "./fixtures";
import {
  LIBRARY_PROFILES,
  formatPrecheckFailure,
  repoRelative,
  type FixtureFailure,
  type LibraryProfile,
  type RealPrecheck,
} from "./library";
import { DIFF_KIND_LABEL, type SnapshotDiff } from "./snapshot";
import { NO_NAMED_STEP } from "./step";

export type { AbortCheck, AbortInfo, CaseOutcome, TestStatus };

/** 仓库根（本文件位于 `e2e/support/`）。 */
const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const OUT_DIR = path.join(REPO_ROOT, "e2e", ".out");

/** Run_Summary（17.1：被 gitignore 的运行产物目录内的固定路径，覆盖上一次）。 */
export const SUMMARY_FILE = path.join(OUT_DIR, "summary.md");
/** `RunSummaryModel` 的原样序列化，供 Acceptance_Run 判定。 */
export const RESULTS_FILE = path.join(OUT_DIR, "results.json");

// ---------------------------------------------------------------------------
// 基本类型与常量
// ---------------------------------------------------------------------------

/** Library_Profile。 */
export type Profile = LibraryProfile;

/** 计数表的一行：两个 Library_Profile 与单列的 tooling。 */
export type SummaryProfile = Profile | "tooling";

/** 计数表的行序。 */
export const SUMMARY_PROFILES: readonly SummaryProfile[] = [...LIBRARY_PROFILES, "tooling"];

/** 计数表与用例列表中的写法。 */
export const PROFILE_LABELS: Readonly<Record<SummaryProfile, string>> = {
  fixture: "fixture",
  real: "real",
  tooling: "工具（不属于 Library_Profile）",
};

/** 五类结果（17.1）。与 `review/consistency.ts` 的 `CaseOutcome` 同源，后者多一个 `notRun`。 */
export type Outcome = Exclude<CaseOutcome, "notRun">;

/** 五类结果，按计数表的列序。 */
export const OUTCOMES: readonly Outcome[] = ["passed", "failed", "unexpectedPass", "skipped", "expectedFail"];

export const OUTCOME_LABELS: Readonly<Record<CaseOutcome, string>> = {
  passed: "通过",
  failed: "失败",
  unexpectedPass: "意外通过",
  skipped: "跳过",
  expectedFail: "预期失败",
  notRun: "未执行",
};

/** `playwright.config.ts` 定义的 6 个项目。 */
export type ProjectName = "fixture" | "fixture-transparent" | "real" | "real-transparent" | "real-perf" | "tooling";

/** 项目 → 所属 Library_Profile（设计"项目归属"）。 */
export const PROJECT_PROFILE: Readonly<Record<ProjectName, SummaryProfile>> = {
  fixture: "fixture",
  "fixture-transparent": "fixture",
  real: "real",
  "real-transparent": "real",
  "real-perf": "real",
  tooling: "tooling",
};

export const PROJECT_NAMES: readonly ProjectName[] = [
  "fixture",
  "fixture-transparent",
  "real",
  "real-transparent",
  "real-perf",
  "tooling",
];

/** 跳过原因的约定前缀（设计"跳过原因约定前缀"），`other` 为不带约定前缀的原因。 */
export type SkipKind = "3.9" | "4.3" | "4.7" | "8.13" | "16.4" | "other";

export const SKIP_KINDS: readonly SkipKind[] = ["3.9", "4.3", "4.7", "8.13", "16.4", "other"];

export const SKIP_KIND_LABELS: Readonly<Record<SkipKind, string>> = {
  "3.9": "Fixture_Generator 失败",
  "4.3": "real 书库核对未通过",
  "4.7": "Test_Book 缺少所需特征",
  "8.13": "当前书库缺少相邻卷节点",
  "16.4": "可测性缺口",
  other: "其他原因",
};

/** 跳过注解没有 description 时的原因（与 `consistency.ts` 的写法相同）。 */
export const UNSPECIFIED_SKIP_REASON = "未注明跳过原因";

/** 意外通过的"错误首行"：Playwright 不为它生成错误信息。 */
export const UNEXPECTED_PASS_LINE = "带预期失败标注的用例实际通过（Expected to fail, but passed）";

/** 失败类用例没有 `step-at-end` 附件时"所处步骤"的写法（tooling 用例除外，见 `toCaseRow`）。 */
export const STEP_NOT_RECORDED = "未记录（没有 step-at-end 附件）";

/** 用例名中文件与标题、标题各层之间的分隔符（与 Review_Report 的写法相同）。 */
export const TITLE_SEPARATOR = " › ";

/** globalSetup 之外的两种中止阶段（设计错误处理表）。 */
export const RUN_STAGES = {
  /** 用例文件加载失败等，未收集到用例。 */
  collect: "用例收集",
  /** 运行被中断（Ctrl+C 等）或超出全局超时。 */
  execute: "用例执行",
} as const;

/** 中止于该阶段时退出码为 3（由 `run.mjs` 返回，1.5）。 */
export const BROWSER_CHECK_STAGE: string = ABORT_STAGES[0];

/** 第 9 节最多列出的差异条数（4.8）。 */
export const SNAPSHOT_DIFF_LIST_LIMIT = 50;

// ---------------------------------------------------------------------------
// 模型（Data Models"Run_Summary 模型"）
// ---------------------------------------------------------------------------

/** 一项产物：相对仓库根的路径，或未生成的原因（summary 写作"未生成（原因）"）。 */
export type ArtifactRef = { path: string } | { missing: string };

export interface CaseRow {
  /** `TestCase.id`。 */
  id: string;
  /** 用例文件，相对仓库根、以 `/` 分隔。 */
  file: string;
  /** 文件内的标题路径（describe › 用例），以 `TITLE_SEPARATOR` 连接。 */
  title: string;
  project: string;
  profile: SummaryProfile;
  outcome: CaseOutcome;
  /** 本次结果的开始时刻（epoch 毫秒）；没有结果时为 null。 */
  startMs: number | null;
  durationMs: number | null;
  /** 失败类：失败或超时所处的步骤路径，或"无具名步骤"；没有 `step-at-end` 附件的 UI 用例不设。 */
  step?: string;
  /** 失败类：生效的超时值（毫秒）。 */
  timeoutMs?: number;
  /** 失败类：`status === "timedOut"`。 */
  timedOut?: boolean;
  /** 失败类：错误信息首行（已去掉 ANSI 转义）。 */
  errorLine?: string;
  /** 仅失败类（失败、超时、意外通过，17.2）。 */
  artifacts?: { trace: ArtifactRef; screenshot: ArtifactRef; console: ArtifactRef };
  /** 仅跳过。 */
  skip?: { kind: SkipKind; reason: string };
  /** 预期失败 / 意外通过 / 16.4 跳过引用的 Finding 编号，按首次出现的顺序、去重。 */
  findings: string[];
}

export interface ProfileStats {
  profile: SummaryProfile;
  /** fixture / real：本次是否选中；tooling：本次是否有 tooling 用例。 */
  ran: boolean;
  counts: Record<Outcome, number>;
  notRun: number;
  /** 该 profile 用例 `startMs` 的最小值到 `startMs + durationMs` 的最大值（秒，一位小数）；没有带时间的用例时为 null。 */
  wallSec: number | null;
}

export type RunLevelFailure =
  /** 4.8：起止快照有差异。 */
  | { kind: "snapshot-diff"; total: number }
  /** 4.8：某次快照缺失、为残留或读取失败。 */
  | { kind: "snapshot-missing"; which: "start" | "end"; reason: string }
  /** 3.9：`fixture-failed.json` 存在。 */
  | { kind: "fixture-failed"; reason: string; detail: string[] }
  /** 13.11：Review_Report 一致性违规。 */
  | { kind: "review-consistency"; violations: Violation[] }
  /** 未被中止吸收的 `onError`（每条取首行）。 */
  | { kind: "run-error"; errors: string[] };

export type RunLevelFailureKind = RunLevelFailure["kind"];

/** 第 11 节的三个分节。 */
export type ExtraSectionKey = "visual" | "perf" | "a11y";

export const EXTRA_SECTION_KEYS: readonly ExtraSectionKey[] = ["visual", "perf", "a11y"];

/** 各分节依赖的 Library_Profile：视觉回归与 A11y_Scan 只在 fixture（12.1、15.1），Perf_Metrics 只在 real（14.1）。 */
export const EXTRA_SECTION_PROFILE: Readonly<Record<ExtraSectionKey, Profile>> = {
  visual: "fixture",
  perf: "real",
  a11y: "fixture",
};

/**
 * 第 11 节一个分节的内容。`ready` 的 `lines` 是该分节正文的 Markdown 行（不含分节标题），由任务
 * 18.6 / 19.6 / 20.5 的渲染函数产出；`data` 可放该分节的结构化数据，随 `results.json` 一并写出。
 */
export type ExtraSection =
  | { status: "ready"; lines: string[]; data?: unknown }
  | { status: "notRun"; reason: string }
  | { status: "notGenerated"; reason: string };

/** 第 8 节的四项产物（17.4）。 */
export type ArtifactKey = "htmlReport" | "reviewReport" | "perf" | "a11y";

export const ARTIFACT_KEYS: readonly ArtifactKey[] = ["htmlReport", "reviewReport", "perf", "a11y"];

/** 四项产物相对仓库根的路径。 */
export const ARTIFACT_PATHS: Readonly<Record<ArtifactKey, string>> = {
  htmlReport: "e2e/.out/report/index.html",
  reviewReport: repoRelative(path.join(REVIEW_DIR, REVIEW_REPORT_MD)),
  perf: "e2e/.out/perf.json",
  a11y: "e2e/.out/a11y/",
};

export const ARTIFACT_LABELS: Readonly<Record<ArtifactKey, string>> = {
  htmlReport: "Playwright HTML 报告",
  reviewReport: "Review_Report",
  perf: "Perf_Metrics",
  a11y: "A11y_Scan 结果",
};

/** 各产物依赖的 Library_Profile；null 表示每次运行都应生成。 */
const ARTIFACT_PROFILE: Readonly<Record<ArtifactKey, Profile | null>> = {
  htmlReport: null,
  reviewReport: null,
  perf: "real",
  a11y: "fixture",
};

export interface RunSummaryModel {
  /** 运行开始的本机本地时间（带 UTC 偏移，`formatLocalTimestamp`）；Review_Report 与 Perf_Metrics 用同一字符串。 */
  startedAt: string;
  endedAt: string;
  totalSec: number;
  selected: Profile[];
  /** 是否收集到了用例（`isCollected`）；为 false 时计数写"未收集"。 */
  collected: boolean;
  rows: CaseRow[];
  stats: ProfileStats[];
  runLevel: RunLevelFailure[];
  abort: AbortInfo | null;
  exitCode: 0 | 1 | 3;
  artifacts: Record<ArtifactKey, ArtifactRef>;
  snapshot: {
    start: { count: number; ms: number } | null;
    end: { count: number; ms: number } | null;
    diff: SnapshotDiff | null;
  };
  /** 第 10 节：`fixture-failed.json` 与 `real-precheck.json` 的内容；文件不存在时为 null。 */
  checks: { fixture: FixtureFailure | null; real: RealPrecheck | null };
  /** 第 11 节。 */
  sections: Record<ExtraSectionKey, ExtraSection>;
}

// ---------------------------------------------------------------------------
// 归类、项目归属与退出码
// ---------------------------------------------------------------------------

/** 用例归类（见文件头"归类"）。`status` 为 null / undefined 表示没有结果。 */
export function classify(status: TestStatus | null | undefined, expected: TestStatus): CaseOutcome {
  if (status === null || status === undefined || status === "interrupted") return "notRun";
  if (status === "skipped") return "skipped";
  if (expected === "failed") {
    if (status === "failed") return "expectedFail";
    if (status === "passed") return "unexpectedPass";
    return "failed";
  }
  return status === "passed" ? "passed" : "failed";
}

function isProjectName(project: string): project is ProjectName {
  return Object.prototype.hasOwnProperty.call(PROJECT_PROFILE, project);
}

/**
 * 项目 → fixture / real / tooling。
 *
 * @throws 项目名不在 `PROJECT_NAMES` 中时（项目清单只由 `playwright.config.ts` 定义，出现别的名字说明两边不一致）。
 */
export function profileOf(project: string): SummaryProfile {
  if (!isProjectName(project)) {
    throw new Error(`未知的 Playwright 项目 ${JSON.stringify(project)}，应为：${PROJECT_NAMES.join("、")}`);
  }
  return PROJECT_PROFILE[project];
}

function zeroCounts(): Record<Outcome, number> {
  return { passed: 0, failed: 0, unexpectedPass: 0, skipped: 0, expectedFail: 0 };
}

/** 毫秒 → 秒，一位小数。 */
function toSec(ms: number): number {
  return Math.round(ms / 100) / 10;
}

function wallSeconds(rows: readonly CaseRow[]): number | null {
  let first = Infinity;
  let last = -Infinity;
  for (const r of rows) {
    if (r.startMs === null || r.durationMs === null) continue;
    first = Math.min(first, r.startMs);
    last = Math.max(last, r.startMs + r.durationMs);
  }
  return first === Infinity ? null : toSec(Math.max(0, last - first));
}

/**
 * 每个 profile（`SUMMARY_PROFILES` 的顺序）一行：五类计数、未执行数与墙钟耗时。计数取自全部行，
 * 与是否选中无关，所以五类计数之和加未执行数恒等于该 profile 的行数（属性 12）。
 */
export function aggregate(rows: readonly CaseRow[], selected: readonly Profile[]): ProfileStats[] {
  return SUMMARY_PROFILES.map((profile): ProfileStats => {
    const own = rows.filter((r) => r.profile === profile);
    const counts = zeroCounts();
    let notRun = 0;
    for (const r of own) {
      if (r.outcome === "notRun") notRun++;
      else counts[r.outcome]++;
    }
    const ran = profile === "tooling" ? own.length > 0 : selected.includes(profile);
    return { profile, ran, counts, notRun, wallSec: wallSeconds(own) };
  });
}

/**
 * 退出码（1.7、17.5、17.7）：中止于"浏览器检查"为 3；其余中止、任一运行级失败、任一失败或意外通过
 * 为 1；否则为 0。跳过、预期失败与未执行都不改变退出码（属性 12）。
 */
export function exitCode(
  rows: readonly CaseRow[],
  runLevel: readonly RunLevelFailure[],
  abort: AbortInfo | null,
): 0 | 1 | 3 {
  if (abort !== null) return abort.stage === BROWSER_CHECK_STAGE ? 3 : 1;
  if (runLevel.length > 0) return 1;
  return rows.some((r) => r.outcome === "failed" || r.outcome === "unexpectedPass") ? 1 : 0;
}

// ---------------------------------------------------------------------------
// 跳过原因、Finding 编号与错误首行
// ---------------------------------------------------------------------------

const SKIP_PREFIXES: readonly (readonly [Exclude<SkipKind, "other">, RegExp])[] = [
  ["3.9", /^\[3\.9\]/],
  ["4.3", /^\[4\.3\]/],
  ["4.7", /^\[4\.7\]/],
  ["8.13", /^\[8\.13\]/],
  ["16.4", /^\[16\.4(?:\s[^\]]*)?\]/],
];

/** 按约定前缀归类跳过原因；忽略开头的空白。 */
export function skipKindOf(reason: string): SkipKind {
  const text = reason.trimStart();
  for (const [kind, prefix] of SKIP_PREFIXES) {
    if (prefix.test(text)) return kind;
  }
  return "other";
}

const FINDING_ID = /F-\d{3,}/g;

/** 依次从各段文字中提取 Finding 编号（`/F-\d{3,}/g`），按首次出现的顺序去重。 */
export function findingIds(...texts: readonly (string | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const text of texts) {
    if (!text) continue;
    for (const id of text.match(FINDING_ID) ?? []) {
      if (!out.includes(id)) out.push(id);
    }
  }
  return out;
}

/** CSI 转义序列（Playwright 的错误信息带颜色）。 */
const ANSI_CSI = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-?]*[ -/]*[@-~]`, "g");

export function stripAnsi(text: string): string {
  return text.replace(ANSI_CSI, "");
}

/** 去掉 ANSI 转义后的第一个非空行（两端去空白）；没有时为 undefined。 */
export function firstLine(text: string | null | undefined): string | undefined {
  if (!text) return undefined;
  for (const line of stripAnsi(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed !== "") return trimmed;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// CaseFacts → CaseRow
// ---------------------------------------------------------------------------

export interface CaseAnnotation {
  type: string;
  description?: string;
}

export interface CaseAttachment {
  name: string;
  /** 绝对路径（Playwright 给出的形式）。 */
  path?: string;
  body?: string | Uint8Array;
}

/** reporter 从一个 `TestCase` 与其结果中取出的事实。 */
export interface CaseFacts {
  /** `TestCase.id`。 */
  id: string;
  /** 用例文件的绝对路径（`TestCase.location.file`）。 */
  file: string;
  /** 文件内的标题路径：`titlePath()` 去掉根、项目与文件三层。 */
  titlePath: readonly string[];
  project: string;
  expectedStatus: TestStatus;
  /** `TestCase.timeout`：没有 `step-at-end` 附件时作为生效超时值。 */
  timeoutMs: number;
  /** 用例与本次结果的注解，按出现顺序（`test.annotations` 与 `result.annotations` 合并）。 */
  annotations: readonly CaseAnnotation[];
  /** 本次唯一的结果（`retries: 0`）；没有结果时为 null。 */
  result: {
    status: TestStatus;
    /** `result.startTime.getTime()`。 */
    startMs: number;
    durationMs: number;
    /** `result.errors` 的 message，按顺序，可含 ANSI 转义。 */
    errors: readonly string[];
    attachments: readonly CaseAttachment[];
  } | null;
}

/** Playwright 内置附件名：`trace: "retain-on-failure"` 与 `screenshot: "only-on-failure"`（17.2）。 */
const PLAYWRIGHT_ATTACHMENTS = { trace: "trace", screenshot: "screenshot" } as const;

const decoder = new TextDecoder();

function bodyText(body: string | Uint8Array | undefined): string | undefined {
  if (body === undefined) return undefined;
  return typeof body === "string" ? body : decoder.decode(body);
}

/** 最后一条带 description 的 `skip` / `fixme` 注解（运行时的跳过排在静态注解之后）。 */
function skipReasonOf(annotations: readonly CaseAnnotation[]): string {
  for (let i = annotations.length - 1; i >= 0; i--) {
    const a = annotations[i];
    if ((a.type === "skip" || a.type === "fixme") && a.description !== undefined && a.description.trim() !== "") {
      return a.description;
    }
  }
  return UNSPECIFIED_SKIP_REASON;
}

function failDescriptions(annotations: readonly CaseAnnotation[]): string[] {
  return annotations.filter((a) => a.type === "fail" && a.description !== undefined).map((a) => a.description as string);
}

/**
 * `step-at-end` 附件的 body（JSON 为 `StepAtEnd`）；缺失或格式不符时为 null。reporter 也用它为
 * Review_Report 取"拍摄前所处的步骤"（13.4），与 Run_Summary 同一口径。
 */
export function parseStepAtEnd(body: string | undefined): StepAtEnd | null {
  if (body === undefined) return null;
  try {
    const data: unknown = JSON.parse(body);
    if (typeof data !== "object" || data === null) return null;
    const { step, timeoutMs } = data as Record<string, unknown>;
    if (typeof step !== "string" || typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) return null;
    return { step, timeoutMs };
  } catch {
    return null;
  }
}

/** `console-log` 附件写入失败时的 body：`未生成（原因）`。 */
const NOT_GENERATED_BODY = /^未生成（([\s\S]*)）$/;

function artifactOf(attachments: readonly CaseAttachment[], name: string): ArtifactRef {
  const found = attachments.find((a) => a.name === name);
  if (found === undefined) return { missing: `没有 ${name} 附件` };
  if (found.path !== undefined) return { path: repoRelative(found.path) };
  const body = bodyText(found.body)?.trim();
  if (body === undefined || body === "") return { missing: `${name} 附件没有文件路径` };
  const m = NOT_GENERATED_BODY.exec(body);
  return { missing: m ? m[1] : body };
}

/**
 * 把一个用例整理成 `CaseRow`（纯函数；路径经 `repoRelative` 换成相对仓库根）。
 *
 * - 跳过：记下原因与前缀类型；16.4 跳过提取 Finding 编号。
 * - 预期失败：Finding 编号取自 `fail` 注解与标题。
 * - 失败与意外通过：步骤（`step-at-end`；tooling 用例不经 `fixtures.ts`、也不用 `step()`，
 *   记"无具名步骤"）、生效超时、是否超时、错误首行，以及 trace、失败截图、`console.log` 三项产物；
 *   意外通过另取 Finding 编号。
 */
export function toCaseRow(f: CaseFacts): CaseRow {
  const profile = profileOf(f.project);
  const result = f.result;
  const outcome = classify(result?.status, f.expectedStatus);
  const title = f.titlePath.join(TITLE_SEPARATOR);
  const row: CaseRow = {
    id: f.id,
    file: repoRelative(f.file),
    title,
    project: f.project,
    profile,
    outcome,
    startMs: result?.startMs ?? null,
    durationMs: result?.durationMs ?? null,
    findings: [],
  };
  if (result === null) return row;

  switch (outcome) {
    case "skipped": {
      const reason = skipReasonOf(f.annotations);
      const kind = skipKindOf(reason);
      row.skip = { kind, reason };
      if (kind === "16.4") row.findings = findingIds(reason);
      break;
    }
    case "expectedFail":
      row.findings = findingIds(...failDescriptions(f.annotations), title);
      break;
    case "failed":
    case "unexpectedPass": {
      const atEnd = parseStepAtEnd(
        bodyText(result.attachments.find((a) => a.name === ATTACHMENTS.stepAtEnd)?.body),
      );
      const step = atEnd?.step ?? (profile === "tooling" ? NO_NAMED_STEP : undefined);
      if (step !== undefined) row.step = step;
      row.timeoutMs = atEnd?.timeoutMs ?? f.timeoutMs;
      row.timedOut = result.status === "timedOut";
      const error = result.errors.map(firstLine).find((line) => line !== undefined);
      row.errorLine = error ?? (outcome === "unexpectedPass" ? UNEXPECTED_PASS_LINE : "（没有错误信息）");
      row.artifacts = {
        trace: artifactOf(result.attachments, PLAYWRIGHT_ATTACHMENTS.trace),
        screenshot: artifactOf(result.attachments, PLAYWRIGHT_ATTACHMENTS.screenshot),
        console: artifactOf(result.attachments, ATTACHMENTS.consoleLog),
      };
      if (outcome === "unexpectedPass") row.findings = findingIds(...failDescriptions(f.annotations), title);
      break;
    }
    case "passed":
    case "notRun":
      break;
  }
  return row;
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 行序：文件、标题、项目、id（UTF-16 码元序）。 */
export function compareRows(a: CaseRow, b: CaseRow): number {
  return (
    compareCodeUnits(a.file, b.file) ||
    compareCodeUnits(a.title, b.title) ||
    compareCodeUnits(a.project, b.project) ||
    compareCodeUnits(a.id, b.id)
  );
}

// ---------------------------------------------------------------------------
// 收集与中止（R4）
// ---------------------------------------------------------------------------

export interface CollectionFacts {
  /** 本次运行写出了 `abort.json`（globalSetup 中止必在收集之前）。 */
  setupAborted: boolean;
  /** `onBegin` 时套件中的用例数；`onBegin` 未被调用时为 null。 */
  onBeginTests: number | null;
  /** `onError` 被调用的次数。 */
  errorCount: number;
}

/** 是否收集到了用例（见文件头；任务 1.5 的 R4 结论）。 */
export function isCollected(f: CollectionFacts): boolean {
  if (f.setupAborted || f.onBeginTests === null) return false;
  return !(f.onBeginTests === 0 && f.errorCount > 0);
}

export interface AbortFacts {
  /** 本次运行的 `abort.json`（`AbortRecord` 可直接传入）；没有时为 null。 */
  setupAbort: AbortInfo | null;
  collected: boolean;
  /** `onEnd` 的 `result.status`。 */
  status: FullResult["status"];
  /** `onError` 的错误信息，按顺序，可含 ANSI 转义。 */
  errors: readonly string[];
}

function copyAbort(a: AbortInfo): AbortInfo {
  const out: AbortInfo = { stage: a.stage, reason: a.reason };
  if (a.checks !== undefined && a.checks.length > 0) out.checks = a.checks.map((c) => ({ ...c }));
  return out;
}

function errorLines(errors: readonly string[]): string[] {
  return errors.map((e) => firstLine(e) ?? "（空的错误信息）");
}

/**
 * 本次运行的中止信息：`abort.json` → 原样（去掉 `writtenAt`）；未收集 → "用例收集"，原因为
 * `onError` 各条的首行；`interrupted` / `timedout` → "用例执行"；否则 null。
 */
export function resolveAbort(f: AbortFacts): AbortInfo | null {
  if (f.setupAbort !== null) return copyAbort(f.setupAbort);
  if (!f.collected) {
    const lines = errorLines(f.errors);
    return {
      stage: RUN_STAGES.collect,
      reason: lines.length > 0 ? lines.join("；") : "未收集到任何用例（Playwright 未报告原因）",
    };
  }
  if (f.status === "interrupted") {
    return { stage: RUN_STAGES.execute, reason: "运行被中断（Ctrl+C 等），未结束的用例记为未执行" };
  }
  if (f.status === "timedout") {
    return { stage: RUN_STAGES.execute, reason: "运行超出全局超时（globalTimeout），未结束的用例记为未执行" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 未生成 / 未运行的原因
// ---------------------------------------------------------------------------

export interface RunContext {
  selected: readonly Profile[];
  abort: AbortInfo | null;
  collected: boolean;
}

function abortedBeforeTests(ctx: RunContext): string | null {
  return ctx.abort !== null && !ctx.collected ? `运行中止于"${ctx.abort.stage}"阶段` : null;
}

/** 某项产物文件不存在时的原因（17.4、17.7）。 */
export function missingArtifactReason(key: ArtifactKey, ctx: RunContext): string {
  const aborted = abortedBeforeTests(ctx);
  if (aborted !== null) return aborted;
  const need = ARTIFACT_PROFILE[key];
  if (need === null) return "reporter 未写出该文件";
  if (!ctx.selected.includes(need)) return `${need} 未运行`;
  return "对应用例未执行";
}

/** 第 11 节某分节因中止或所属 profile 未选中而"未运行"时返回该分节；否则 null（应由对应任务给出内容）。 */
export function extraSectionNotRun(key: ExtraSectionKey, ctx: RunContext): ExtraSection | null {
  const aborted = abortedBeforeTests(ctx);
  if (aborted !== null) return { status: "notRun", reason: aborted };
  const need = EXTRA_SECTION_PROFILE[key];
  if (!ctx.selected.includes(need)) return { status: "notRun", reason: `${need} 未运行` };
  return null;
}

// ---------------------------------------------------------------------------
// 时间
// ---------------------------------------------------------------------------

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * 本机本地时间，ISO 8601 带 UTC 偏移：`2025-06-01T20:00:00.000+08:00`（17.1）。
 *
 * @param offsetMinutes 相对 UTC 的偏移（东八区为 480），默认取本机时区在该时刻的偏移。
 */
export function formatLocalTimestamp(date: Date, offsetMinutes: number = -date.getTimezoneOffset()): string {
  const local = new Date(date.getTime() + offsetMinutes * 60_000).toISOString().slice(0, 23);
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  return `${local}${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

// ---------------------------------------------------------------------------
// 组装模型
// ---------------------------------------------------------------------------

/** 一次快照的读取结果：成功时为文件数与耗时，否则为原因（缺失、残留或读取失败）。 */
export type SnapshotReading = { ok: true; count: number; ms: number } | { ok: false; reason: string };

/** reporter 在 `onEnd` 中交给 `buildRunSummary` 的全部事实。 */
export interface RunFacts {
  /** `onEnd` 的 `result.startTime`（R4）。 */
  startTime: Date;
  /** `onEnd` 的 `result.duration`（毫秒）。 */
  durationMs: number;
  /** `onEnd` 的 `result.status`。 */
  status: FullResult["status"];
  selected: readonly Profile[];
  /** `onBegin` 时套件中的用例数；未被调用时为 null。 */
  onBeginTests: number | null;
  /** `onError` 的错误信息，按顺序。 */
  errors: readonly string[];
  /** 本次运行的 `abort.json`；没有时为 null。 */
  setupAbort: AbortInfo | null;
  cases: readonly CaseFacts[];
  snapshot: { start: SnapshotReading; end: SnapshotReading; diff: SnapshotDiff | null };
  fixtureFailed: FixtureFailure | null;
  realPrecheck: RealPrecheck | null;
  reviewViolations: readonly Violation[];
  artifacts: Record<ArtifactKey, ArtifactRef>;
  sections: Record<ExtraSectionKey, ExtraSection>;
  /** 测试用：固定 UTC 偏移（分钟）；默认取本机时区。 */
  utcOffsetMinutes?: number;
}

/**
 * 由运行事实组装 `RunSummaryModel`。运行级失败的顺序：快照缺失（开始、结束）、快照差异、
 * Fixture_Generator 失败、Review_Report 一致性违规、其余 `onError`。
 */
export function buildRunSummary(f: RunFacts): RunSummaryModel {
  const collected = isCollected({
    setupAborted: f.setupAbort !== null,
    onBeginTests: f.onBeginTests,
    errorCount: f.errors.length,
  });
  const abort = resolveAbort({ setupAbort: f.setupAbort, collected, status: f.status, errors: f.errors });
  const rows = f.cases.map(toCaseRow).sort(compareRows);

  const runLevel: RunLevelFailure[] = [];
  const { start, end, diff } = f.snapshot;
  if (!start.ok) runLevel.push({ kind: "snapshot-missing", which: "start", reason: start.reason });
  if (!end.ok) runLevel.push({ kind: "snapshot-missing", which: "end", reason: end.reason });
  if (diff !== null && diff.total > 0) runLevel.push({ kind: "snapshot-diff", total: diff.total });
  if (f.fixtureFailed !== null) {
    runLevel.push({ kind: "fixture-failed", reason: f.fixtureFailed.reason, detail: [...f.fixtureFailed.detail] });
  }
  if (f.reviewViolations.length > 0) {
    runLevel.push({ kind: "review-consistency", violations: [...f.reviewViolations] });
  }
  // globalSetup 的重抛与收集失败已由中止信息吸收
  const absorbed = f.setupAbort !== null || !collected;
  if (!absorbed && f.errors.length > 0) runLevel.push({ kind: "run-error", errors: errorLines(f.errors) });

  const selected = LIBRARY_PROFILES.filter((p) => f.selected.includes(p));
  const offset = f.utcOffsetMinutes;
  const endDate = new Date(f.startTime.getTime() + f.durationMs);
  return {
    startedAt: formatLocalTimestamp(f.startTime, offset ?? -f.startTime.getTimezoneOffset()),
    endedAt: formatLocalTimestamp(endDate, offset ?? -endDate.getTimezoneOffset()),
    totalSec: toSec(f.durationMs),
    selected,
    collected,
    rows,
    stats: aggregate(rows, selected),
    runLevel,
    abort,
    exitCode: exitCode(rows, runLevel, abort),
    artifacts: { ...f.artifacts },
    snapshot: {
      start: start.ok ? { count: start.count, ms: start.ms } : null,
      end: end.ok ? { count: end.count, ms: end.ms } : null,
      diff,
    },
    checks: { fixture: f.fixtureFailed, real: f.realPrecheck },
    sections: { ...f.sections },
  };
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

export const SUMMARY_TITLE = "# E2E Run_Summary";

/** 各节标题，键按设计的节序排列（第 11 节拆成三个分节）。 */
export const SUMMARY_HEADINGS = {
  overview: "## 概况",
  counts: "## 用例计数",
  runLevel: "## 运行级失败",
  failures: "## 失败用例（含超时与意外通过）",
  timeouts: "## 超时用例",
  skipped: "## 跳过用例",
  expectedFail: "## 预期失败与意外通过",
  artifacts: "## 产物路径",
  snapshot: "## public/ 快照",
  checks: "## 夹具与 real 核对",
  visual: "## 视觉回归",
  perf: "## Perf_Metrics",
  a11y: "## A11y_Scan",
  consistency: "## Review_Report 一致性违规",
} as const;

export type SummarySection = keyof typeof SUMMARY_HEADINGS;

/** 节序与设计 1–12 的对应（第 11 节拆成三个分节）。 */
export const SUMMARY_SECTION_ORDER: readonly { section: SummarySection; no: number }[] = [
  { section: "overview", no: 1 },
  { section: "counts", no: 2 },
  { section: "runLevel", no: 3 },
  { section: "failures", no: 4 },
  { section: "timeouts", no: 5 },
  { section: "skipped", no: 6 },
  { section: "expectedFail", no: 7 },
  { section: "artifacts", no: 8 },
  { section: "snapshot", no: 9 },
  { section: "checks", no: 10 },
  { section: "visual", no: 11 },
  { section: "perf", no: 11 },
  { section: "a11y", no: 11 },
  { section: "consistency", no: 12 },
];

/** 某节没有条目时的正文。 */
export const NONE_TEXT = "无";
/** 未运行、未生成、未收集的写法（17.1、17.4、17.7）。 */
export const NOT_RUN_TEXT = "未运行";
export const NOT_GENERATED_TEXT = "未生成";
export const NOT_COLLECTED_TEXT = "未收集";

function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, " ");
}

/** 行内代码，反引号围栏长于文字中最长的反引号串。 */
function code(text: string): string {
  const t = oneLine(text);
  const longest = (t.match(/`+/g) ?? []).reduce((n, run) => Math.max(n, run.length), 0);
  const fence = "`".repeat(longest + 1);
  const pad = t.startsWith("`") || t.endsWith("`") ? " " : "";
  return `${fence}${pad}${t}${pad}${fence}`;
}

function cell(text: string): string {
  return oneLine(text).replace(/\|/g, "\\|");
}

function tableRow(cells: readonly string[]): string {
  return `| ${cells.join(" | ")} |`;
}

function formatSec(sec: number | null): string {
  return sec === null ? "—" : sec.toFixed(1);
}

function artifactText(ref: ArtifactRef | undefined): string {
  if (ref === undefined) return `${NOT_GENERATED_TEXT}（未记录）`;
  return "path" in ref ? code(ref.path) : `${NOT_GENERATED_TEXT}（${oneLine(ref.missing)}）`;
}

/** 第 11 节各分节（`visual/report.ts` 等）与本文件共用的 Markdown 写法。 */
export {
  artifactText as mdArtifact,
  cell as mdCell,
  code as mdCode,
  oneLine as mdOneLine,
  tableRow as mdTableRow,
};

function caseLabel(row: CaseRow): string {
  return `${code(row.file)}${TITLE_SEPARATOR}${oneLine(row.title)}`;
}

function profileLabel(row: CaseRow): string {
  const label = PROFILE_LABELS[row.profile];
  return row.project === row.profile ? label : `${label}（项目 ${row.project}）`;
}

function findingsText(ids: readonly string[]): string {
  return ids.length > 0 ? ids.join("、") : "未引用 Finding 编号";
}

function totalCounts(stats: readonly ProfileStats[]): { counts: Record<Outcome, number>; notRun: number } {
  const counts = zeroCounts();
  let notRun = 0;
  for (const s of stats) {
    for (const o of OUTCOMES) counts[o] += s.counts[o];
    notRun += s.notRun;
  }
  return { counts, notRun };
}

function countsText(counts: Record<Outcome, number>, notRun: number): string {
  return `${OUTCOMES.map((o) => `${OUTCOME_LABELS[o]} ${counts[o]}`).join("、")}；${OUTCOME_LABELS.notRun} ${notRun}`;
}

function numbered(items: readonly string[][]): string[] {
  if (items.length === 0) return [NONE_TEXT];
  return items.flatMap(([head, ...rest], i) => [`${i + 1}. ${head}`, ...rest.map((line) => `   ${line}`)]);
}

function renderOverview(m: RunSummaryModel): string[] {
  const lines = [
    `- 开始时间：${m.startedAt}`,
    `- 结束时间：${m.endedAt}`,
    `- 总耗时：${formatSec(m.totalSec)} s`,
    `- 退出码：${m.exitCode}`,
    `- 本次运行的 Library_Profile：${m.selected.length > 0 ? m.selected.join("、") : NONE_TEXT}`,
  ];
  if (m.abort === null) return lines;
  const { counts, notRun } = totalCounts(m.stats);
  lines.push(
    `- 中止阶段：${oneLine(m.abort.stage)}`,
    `- 中止原因：${oneLine(m.abort.reason)}`,
    `- 中止前已执行的用例：${m.collected ? countsText(counts, notRun) : NOT_COLLECTED_TEXT}`,
  );
  const checks = m.abort.checks ?? [];
  if (checks.length > 0) {
    lines.push(
      "",
      "未通过的检查项：",
      "",
      tableRow(["检查项", "路径", "期望", "实际"]),
      tableRow(["---", "---", "---", "---"]),
      ...checks.map((c) => tableRow([cell(c.name), c.path === undefined ? "—" : cell(c.path), cell(c.expected), cell(c.actual)])),
    );
  }
  return lines;
}

function renderCounts(m: RunSummaryModel): string[] {
  const header = ["Library_Profile", ...OUTCOMES.map((o) => OUTCOME_LABELS[o]), OUTCOME_LABELS.notRun, "耗时（s）"];
  const lines = [tableRow(header), tableRow(["---", ...header.slice(1).map(() => "---:")])];
  const blank = (word: string): string[] => [word, ...header.slice(2).map(() => "—")];
  for (const s of m.stats) {
    const label = cell(PROFILE_LABELS[s.profile]);
    const selected = s.profile === "tooling" || m.selected.includes(s.profile);
    if (!m.collected && selected) lines.push(tableRow([label, ...blank(NOT_COLLECTED_TEXT)]));
    else if (!s.ran) lines.push(tableRow([label, ...blank(NOT_RUN_TEXT)]));
    else {
      lines.push(tableRow([label, ...OUTCOMES.map((o) => String(s.counts[o])), String(s.notRun), formatSec(s.wallSec)]));
    }
  }
  return lines;
}

function describeRunLevel(f: RunLevelFailure): string {
  switch (f.kind) {
    case "snapshot-diff":
      return `\`public/\` 起止快照不一致：${f.total} 个文件有差异（明细见"public/ 快照"一节，4.8）`;
    case "snapshot-missing":
      return `\`public/\` ${f.which === "start" ? "开始" : "结束"}快照不可用：${oneLine(f.reason)}（4.8）`;
    case "fixture-failed":
      return `Fixture_Generator 失败：${oneLine(f.reason)}；fixture 下的用例未执行（明细见"夹具与 real 核对"一节，3.9）`;
    case "review-consistency":
      return `Review_Report 一致性违规 ${f.violations.length} 条（明细见"Review_Report 一致性违规"一节，13.11）`;
    case "run-error":
      return `Playwright 报告了用例之外的错误 ${f.errors.length} 条：${f.errors.map(oneLine).join("；")}`;
  }
}

function renderRunLevel(m: RunSummaryModel): string[] {
  return m.runLevel.length > 0 ? m.runLevel.map((f) => `- ${describeRunLevel(f)}`) : [NONE_TEXT];
}

function stepText(row: CaseRow): string {
  return oneLine(row.step ?? STEP_NOT_RECORDED);
}

function resultText(row: CaseRow): string {
  if (row.outcome === "failed" && row.timedOut === true) return `${OUTCOME_LABELS.failed}（超时）`;
  return OUTCOME_LABELS[row.outcome];
}

function renderFailures(m: RunSummaryModel): string[] {
  const rows = m.rows.filter((r) => r.outcome === "failed" || r.outcome === "unexpectedPass");
  return numbered(
    rows.map((r) => {
      const item = [
        caseLabel(r),
        `- Library_Profile：${profileLabel(r)}`,
        `- 结果：${resultText(r)}`,
        `- 失败时所处的测试步骤：${stepText(r)}`,
        `- 错误信息首行：${oneLine(r.errorLine ?? "（没有错误信息）")}`,
        `- trace：${artifactText(r.artifacts?.trace)}`,
        `- 失败时截图：${artifactText(r.artifacts?.screenshot)}`,
        `- 浏览器控制台日志：${artifactText(r.artifacts?.console)}`,
      ];
      if (r.outcome === "unexpectedPass") item.push(`- 引用的 Finding：${findingsText(r.findings)}`);
      return item;
    }),
  );
}

function renderTimeouts(m: RunSummaryModel): string[] {
  const rows = m.rows.filter((r) => r.timedOut === true);
  return numbered(
    rows.map((r) => [
      `${caseLabel(r)}：生效超时 ${r.timeoutMs === undefined ? "未知" : `${r.timeoutMs} ms`}；超时时所处的测试步骤：${stepText(r)}`,
    ]),
  );
}

function renderSkipped(m: RunSummaryModel): string[] {
  const rows = m.rows.filter((r) => r.outcome === "skipped");
  return numbered(
    rows.map((r) => {
      const kind = r.skip?.kind ?? "other";
      const item = [
        `${caseLabel(r)}（${profileLabel(r)}）`,
        `- 类型：${SKIP_KIND_LABELS[kind]}${kind === "other" ? "" : `（${kind}）`}`,
        `- 原因：${oneLine(r.skip?.reason ?? UNSPECIFIED_SKIP_REASON)}`,
      ];
      if (kind === "16.4") item.push(`- Finding：${findingsText(r.findings)}`);
      return item;
    }),
  );
}

function renderExpectedFail(m: RunSummaryModel): string[] {
  const part = (outcome: "expectedFail" | "unexpectedPass"): string[] => {
    const rows = m.rows.filter((r) => r.outcome === outcome);
    const items = rows.map((r) => [`${caseLabel(r)}（${profileLabel(r)}）：${findingsText(r.findings)}`]);
    return [`### ${OUTCOME_LABELS[outcome]}`, "", ...numbered(items)];
  };
  return [...part("expectedFail"), "", ...part("unexpectedPass")];
}

function renderArtifacts(m: RunSummaryModel): string[] {
  return ARTIFACT_KEYS.map((key) => `- ${ARTIFACT_LABELS[key]}：${artifactText(m.artifacts[key])}`);
}

function snapshotLine(which: "start" | "end", m: RunSummaryModel): string {
  const label = which === "start" ? "开始快照" : "结束快照";
  const s = m.snapshot[which];
  if (s !== null) return `- ${label}：${s.count} 个文件，耗时 ${s.ms} ms`;
  const failure = m.runLevel.find(
    (f): f is Extract<RunLevelFailure, { kind: "snapshot-missing" }> => f.kind === "snapshot-missing" && f.which === which,
  );
  return `- ${label}：不可用（${oneLine(failure?.reason ?? "未记录原因")}）`;
}

function renderSnapshot(m: RunSummaryModel): string[] {
  const lines = [snapshotLine("start", m), snapshotLine("end", m)];
  const diff = m.snapshot.diff;
  if (diff === null) {
    lines.push("- 差异：未比对（缺少可用的快照）");
    return lines;
  }
  if (diff.total === 0) {
    lines.push("- 差异：0 个文件");
    return lines;
  }
  const listed = diff.entries.slice(0, SNAPSHOT_DIFF_LIST_LIMIT);
  lines.push(
    `- 差异：${diff.total} 个文件${diff.total > listed.length ? `，下表列出前 ${listed.length} 个` : ""}`,
    "",
    tableRow(["路径", "差异类型"]),
    tableRow(["---", "---"]),
    ...listed.map((e) => tableRow([cell(e.path), e.kinds.map((k) => DIFF_KIND_LABEL[k]).join("、")])),
  );
  return lines;
}

/** 中止于"浏览器检查"时 globalSetup 尚未走到"夹具生成"一步，没有 Fixture_Library 的结论。 */
function abortedBeforeLibrary(abort: AbortInfo | null): boolean {
  return abort !== null && abort.stage === BROWSER_CHECK_STAGE;
}

function renderFixtureCheck(m: RunSummaryModel): string[] {
  const lines = ["### fixture（3.9）", ""];
  const failure = m.checks.fixture;
  if (!m.selected.includes("fixture")) lines.push(`- ${NOT_RUN_TEXT}`);
  else if (failure !== null) {
    const exit = failure.exitCode === null ? "无（未能启动或被信号终止）" : String(failure.exitCode);
    lines.push(`- Fixture_Generator 失败：${oneLine(failure.reason)}`, `- 退出码：${exit}`, "- 出错书或未满足项：");
    lines.push(...(failure.detail.length > 0 ? failure.detail.map((d) => `  - ${oneLine(d)}`) : ["  - （未报告）"]));
  } else if (abortedBeforeLibrary(m.abort)) {
    lines.push(`- 未执行（运行中止于"${oneLine(m.abort?.stage ?? "")}"阶段）`);
  } else lines.push("- Fixture_Library 可用");
  return lines;
}

function renderRealCheck(m: RunSummaryModel): string[] {
  const lines = ["### real（4.3、4.7）", ""];
  const p = m.checks.real;
  if (!m.selected.includes("real")) {
    lines.push(`- ${NOT_RUN_TEXT}`);
    return lines;
  }
  if (p === null) {
    lines.push(m.abort !== null ? `- 未核对（运行中止于"${oneLine(m.abort.stage)}"阶段）` : "- 未核对（没有 real-precheck.json）");
    return lines;
  }
  if (p.ok) lines.push(`- 4.2 核对通过（书库根 ${code(p.root)}）`);
  else {
    lines.push(`- 4.2 核对未通过（${p.failures.length} 项），real 下的用例整体跳过（4.3）：`);
    lines.push(...p.failures.map((f) => `  - ${oneLine(formatPrecheckFailure(f))}`));
  }
  if (p.features.length === 0) {
    lines.push("- 4.7 特征核对：无（没有可核对的 Test_Book）");
    return lines;
  }
  lines.push(
    "- 4.7 特征核对：",
    "",
    tableRow(["书 id", "特征", "结果", "实际"]),
    tableRow(["---", "---", "---", "---"]),
    ...p.features.map((f) => tableRow([cell(f.id), cell(f.feature), f.ok ? "满足" : "不满足（依赖它的用例跳过）", cell(f.actual)])),
  );
  return lines;
}

function renderChecks(m: RunSummaryModel): string[] {
  return [...renderFixtureCheck(m), "", ...renderRealCheck(m)];
}

function renderExtra(section: ExtraSection | undefined): string[] {
  if (section === undefined) return [`${NOT_GENERATED_TEXT}（未记录）`];
  switch (section.status) {
    case "ready":
      return section.lines.length > 0 ? [...section.lines] : [NONE_TEXT];
    case "notRun":
      return [`${NOT_RUN_TEXT}（${oneLine(section.reason)}）`];
    case "notGenerated":
      return [`${NOT_GENERATED_TEXT}（${oneLine(section.reason)}）`];
  }
}

function renderConsistency(m: RunSummaryModel): string[] {
  const violations = m.runLevel.flatMap((f) => (f.kind === "review-consistency" ? f.violations : []));
  return violations.length > 0 ? violations.map((v) => `- ${oneLine(describeViolation(v))}`) : [NONE_TEXT];
}

const SECTION_RENDERERS: Readonly<Record<SummarySection, (m: RunSummaryModel) => string[]>> = {
  overview: renderOverview,
  counts: renderCounts,
  runLevel: renderRunLevel,
  failures: renderFailures,
  timeouts: renderTimeouts,
  skipped: renderSkipped,
  expectedFail: renderExpectedFail,
  artifacts: renderArtifacts,
  snapshot: renderSnapshot,
  checks: renderChecks,
  visual: (m) => renderExtra(m.sections.visual),
  perf: (m) => renderExtra(m.sections.perf),
  a11y: (m) => renderExtra(m.sections.a11y),
  consistency: renderConsistency,
};

/** Run_Summary 的 Markdown（17.1–17.5、17.7、6.9），节序见 `SUMMARY_SECTION_ORDER`。只读模型，不做判定。 */
export function renderSummary(m: RunSummaryModel): string {
  const lines: string[] = [SUMMARY_TITLE];
  for (const { section } of SUMMARY_SECTION_ORDER) {
    lines.push("", SUMMARY_HEADINGS[section], "", ...SECTION_RENDERERS[section](m));
  }
  return `${lines.join("\n")}\n`;
}
