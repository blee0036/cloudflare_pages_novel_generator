/**
 * E2E_Suite 的自定义 reporter（设计"Run_Summary（需求 17、6.9）""Review_Catalog 与 Review_Report"
 * 与"public/ 快照（4.5、4.8）"；需求 3.9、4.5、4.8、13.3、13.4、13.11、17.1–17.7）。
 *
 * 在 `playwright.config.ts` 中接在 `list` 与 `html` 之后，只在主进程运行。本文件只做收集与 I/O，
 * 判定与渲染都交给纯函数：Run_Summary 用 `support/summary.ts`，Review_Report 与一致性检查用
 * `review/consistency.ts`。
 *
 * ## 收集
 *
 * - `onBegin`：记下根套件与其中的用例数（任务 1.5 的 R4：`onBegin` 在 globalSetup 结束之后才被
 *   调用；globalSetup 中止或用例文件加载失败时套件为 0 个用例），并由 `suite.allTests()` 建
 *   Review_Report 所用的 `collected`（`collectedShotCases`，RDF 16.1）。
 * - `onTestEnd`：按 `TestCase.id` 记下唯一的结果（`retries: 0`）。
 * - `onError`：按顺序记下错误信息（globalSetup 的重抛、用例文件加载失败、globalTeardown 抛错等）。
 *
 * ## `onEnd` 的顺序
 *
 * 1. 取 `public/` 结束快照并写 `public-snapshot-end.json`（4.5；teardown 此时已关闭全部实例，
 *    中止的运行同样取），读开始快照：不存在、读取失败，或其 `takenAt` 早于本次运行开始（上一次运行
 *    的残留）时记"开始快照缺失"；两者都可用时 `diffSnapshots`（4.8）。
 * 2. 读本次运行的 `abort.json` 与 `fixture-failed.json`，以写入时刻不早于本次运行开始为准，
 *    排除残留；内容不合法时记为 reporter 错误（见下）。
 * 3. 由每个用例整理 `CaseFacts`；按 `isCollected` / `resolveAbort` 得到中止信息与 `RunContext`。
 * 4. Review_Report：列出 `e2e/.out/review/*.png` 并读 IHDR，汇总 `review-shot` 附件，按
 *    `resolveShotStatuses` 判每张的拍摄状态，`checkReviewConsistency` 得到违规（13.10、13.11）。
 * 5. 第 11 节（视觉回归、Perf_Metrics、A11y_Scan）：先 `extraSectionNotRun`，否则交给
 *    `SECTION_PROVIDERS` 中的生成函数（视觉回归见 `visual/report.ts`，Perf_Metrics 见
 *    `perf/report.ts`，后者同时写 `e2e/.out/perf.json`；A11y_Scan 见 `a11y/report.ts`，只取
 *    `a11y-result` 附件）；尚未接入的写"未生成"。
 * 6. 产物路径（17.4）：文件存在且修改时间不早于本次运行开始才算本次生成。
 * 7. `buildRunSummary` → 写 `review-report.md` 与 `review-report.json`（`startedAt` 与
 *    `results.json` 为同一字符串），再写 `summary.md` 与 `results.json`。
 * 8. 退出码非 0 时返回 `{ status: "failed" }`，Playwright 进程随之以 1 结束（R4 已核实）；中止于
 *    "浏览器检查"时 summary 写 3，由 `run.mjs` 返回（1.5）。
 *
 * ## 与设计的差异与补充
 *
 * - 列出模式（`--list`）：Playwright 不执行 globalSetup，也不执行用例，本 reporter 什么也不写，
 *   上一次运行的 `summary.md`、`results.json` 与 Review_Report 原样保留（它们描述的是那次运行）。
 * - 运行起止取 `onEnd` 的 `result.startTime` 与 `result.duration`（R4），不用 `onBegin` 的时刻。
 * - Review_Report 的用例按 `shotCaseKey(profile, mode, shotTestRef(file, title))` 归档：profile 与
 *   mode 先取结果中 `target` fixture 写下的 `profile` / `mode` 注解，没有时取项目的 `use`。
 *   `abortStage` 取 `abort.json` 的阶段；未收集到用例时取"用例收集"，各节注明中止阶段。
 *   运行未中止、而拍摄用例不在 `onBegin` 收集的用例中时，该节写"用例未被本次运行选中"，附
 *   `extractFilterArgs(process.argv)` 取出的命令行过滤参数（RDF 16.1）。
 * - reporter 自身的读取或写入错误（状态文件格式无效、Review_Report 写入失败等）以
 *   `reporter：` 开头并入 `onError` 的错误列表，按运行级失败 `run-error` 计（退出码 1）：这时
 *   Run_Summary 已不能完整反映本次运行。
 * - Playwright 以 `failed` 结束、而模型未找到任何原因时补一条 `run-error`，保证 summary 写出的
 *   退出码与进程实际退出码一致。
 * - `onEnd` 内出现意料之外的异常时写一份只含概况的应急 Run_Summary（注明 reporter 内部错误、
 *   退出码 1），不写 `results.json`，并返回 `failed`。
 */
import type { Dirent } from "node:fs";
import { mkdir, open, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestError,
  TestResult,
} from "@playwright/test/reporter";
import {
  REQUIRED_CHECKLIST,
  REQUIRED_SHOT_NAMES,
  REVIEW_CATALOG,
  REVIEW_DIR,
  shotTestRef,
} from "../review/catalog";
import {
  PNG_HEAD_BYTES,
  REVIEW_REPORT_JSON,
  REVIEW_REPORT_MD,
  checkReviewConsistency,
  formatShotTest,
  pngSize,
  renderReviewReport,
  resolveShotStatuses,
  reviewReportData,
  shotCaseKey,
  uncapturedReasons,
  type ReviewPng,
  type ReviewReportMeta,
  type ShotCaseResult,
  type ShotRunFacts,
  type ShotStatus,
  type Violation,
} from "../review/consistency";
import { buildA11ySection, renderA11ySection } from "../a11y/report";
import { A11Y_RESULT_ATTACHMENT, A11Y_SCANS } from "../a11y/scans";
import { PERF_METRICS_ATTACHMENT } from "../perf/metrics";
import { buildPerfReport, renderPerfSection, type PerfHost } from "../perf/report";
import type { Mode } from "../server/resolve";
import { BASELINES } from "../visual/baselines";
import { baselinePath } from "../visual/naming";
import { buildVisualSection, renderVisualSection, type VisualBaselineRef } from "../visual/report";
import { ABORT_FILE, isAbortFromRun, readAbort, type AbortInfo } from "./abort";
import { ANNOTATIONS, ATTACHMENTS } from "./fixtures";
import {
  FIXTURE_FAILED_FILE,
  LIBRARY_PROFILES,
  readFixtureFailed,
  readFixtureRoles,
  repoRelative,
  selectedProfiles,
  type FixtureFailure,
  type FixtureRoles,
  type LibraryProfile,
} from "./library";
import { VIEWPORTS } from "./settings";
import {
  SNAPSHOT_END_FILE,
  SNAPSHOT_START_FILE,
  diffSnapshots,
  readSnapshot,
  takeSnapshot,
  writeSnapshot,
  type Snapshot,
  type SnapshotDiff,
} from "./snapshot";
import {
  ARTIFACT_KEYS,
  ARTIFACT_PATHS,
  EXTRA_SECTION_KEYS,
  RESULTS_FILE,
  SUMMARY_FILE,
  SUMMARY_HEADINGS,
  SUMMARY_TITLE,
  buildRunSummary,
  extraSectionNotRun,
  formatLocalTimestamp,
  isCollected,
  missingArtifactReason,
  parseStepAtEnd,
  renderSummary,
  resolveAbort,
  toCaseRow,
  type ArtifactKey,
  type ArtifactRef,
  type CaseAnnotation,
  type CaseAttachment,
  type CaseFacts,
  type ExtraSection,
  type ExtraSectionKey,
  type RunContext,
  type RunFacts,
  type RunSummaryModel,
  type SnapshotReading,
} from "./summary";

/** 仓库根（本文件位于 `e2e/support/`）。 */
const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** reporter 自身错误在错误列表中的前缀（见文件头）。 */
const REPORTER_ERROR_PREFIX = "reporter：";

// ---------------------------------------------------------------------------
// 第 11 节的接入点（任务 18.6 / 19.6 / 20.5）
// ---------------------------------------------------------------------------

/** 一个用例与其唯一的结果（没有结果时为 null），以及由它整理出的 `CaseFacts`。 */
export interface CollectedCase {
  readonly test: TestCase;
  readonly result: TestResult | null;
  readonly facts: CaseFacts;
}

/** 第 11 节分节生成函数的输入。 */
export interface SectionInput {
  /** 本次收集到的全部用例，按套件顺序。 */
  readonly cases: readonly CollectedCase[];
  readonly ctx: RunContext;
  /** `onEnd` 的 `result.startTime`；判断产物是否为本次生成时以它为准。 */
  readonly startTime: Date;
  /** 与 `results.json` 的 `startedAt` 相同的字符串（Perf_Metrics 表头的运行开始时间，14.5）。 */
  readonly startedAt: string;
}

/**
 * 生成第 11 节的一个分节；可以写该分节自己的产物（如 19.6 的 `e2e/.out/perf.json`），它们在
 * 第 8 节"产物路径"核对之前完成。抛错时该分节记"未生成"并附错误，不改变退出码（1.7）。
 */
export type SectionProvider = (input: SectionInput) => Promise<ExtraSection>;

/**
 * "视觉回归"（12.5，任务 18.6）：整理与渲染都在 `visual/report.ts` 的纯函数里，这里只把
 * `BASELINES`（顺序即该节的行序）与本次的 `CaseFacts` 交给它；不读写文件。三张图的路径取自
 * Playwright 附在结果上的附件。
 */
const visualSection: SectionProvider = async ({ cases }) => {
  const defs: VisualBaselineRef[] = BASELINES.map((d) => ({
    name: d.name,
    viewport: VIEWPORTS[d.viewport],
    file: baselinePath(d.name, process.platform),
  }));
  const data = buildVisualSection(defs, cases.map((c) => c.facts));
  return { status: "ready", lines: renderVisualSection(data), data };
};

/**
 * 名为 `name` 的附件只有 `path` 时读成 `body` 交给纯函数：`perf-metrics` 平时只有 `path`（perf 用例
 * 写在输出目录里的 `perf-metrics.json`）；`a11y-result` 以 `body` 附上，这里只是兜底。读不出时保留
 * 原样，纯函数记为附件问题（`buildPerfReport` 把该附件负责的各项记"未采集"，`buildA11ySection`
 * 把该扫描记"扫描失败"）。
 */
async function withAttachmentBodies(facts: CaseFacts, name: string): Promise<CaseFacts> {
  const result = facts.result;
  const needsRead = (a: CaseAttachment): boolean => a.name === name && a.body === undefined && a.path !== undefined;
  if (result === null || !result.attachments.some(needsRead)) return facts;
  const attachments = await Promise.all(
    result.attachments.map(async (a): Promise<CaseAttachment> => {
      if (!needsRead(a) || a.path === undefined) return a;
      try {
        return { ...a, body: await readFile(a.path, "utf8") };
      } catch (error) {
        warn(`读取 ${repoRelative(a.path)} 失败：${errorText(error)}`);
        return a;
      }
    }),
  );
  return { ...facts, result: { ...result, attachments } };
}

/** 表头的 CPU 型号与逻辑核数（14.5，设计：取 `os.cpus()`）。 */
function perfHost(): PerfHost {
  const cpus = os.cpus();
  const model = cpus[0]?.model.trim() ?? "";
  return { cpu: model === "" ? "未知（os.cpus() 未给出型号）" : model, cores: cpus.length };
}

/**
 * "Perf_Metrics"（14.2、14.4、14.5、14.7，任务 19.6）：整理与渲染都在 `perf/report.ts` 的纯函数里。
 * 这里读 `perf-metrics` 附件的文件与 `os.cpus()`，写 `e2e/.out/perf.json`（`PerfReport` 原样序列化，
 * 第 8 节随后核对它是否为本次生成）。超预算只做标注，本函数的结果不参与退出码（1.7、14.4）。
 * perf.json 写不出时照常给出该节，另注明原因；第 8 节随之把它记为未生成。
 */
const perfSection: SectionProvider = async ({ cases, startedAt }) => {
  const facts = await Promise.all(cases.map((c) => withAttachmentBodies(c.facts, PERF_METRICS_ATTACHMENT)));
  const report = buildPerfReport({ runStartedAt: startedAt, host: perfHost(), cases: facts });
  const lines = renderPerfSection(report);
  const file = path.join(REPO_ROOT, ARTIFACT_PATHS.perf);
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  } catch (error) {
    warn(`未能写出 ${ARTIFACT_PATHS.perf}：${errorText(error)}`);
    lines.unshift(`- 未能写出 \`${ARTIFACT_PATHS.perf}\`：${errorText(error).replace(/\s*[\r\n]+\s*/g, " ")}`);
  }
  return { status: "ready", lines, data: report };
};

/**
 * "A11y_Scan"（15.4、15.5、15.9，任务 20.5）：整理与渲染都在 `a11y/report.ts` 的纯函数里，这里只把
 * `A11Y_SCANS`（顺序即该节 31 个分节的顺序）与本次的 `CaseFacts` 交给它。结果只取本次运行的
 * `a11y-result` 附件，不读 `e2e/.out/a11y/`（globalSetup 不清空该目录，会混入上一次运行的文件）。
 * 本函数只写该节，结果不参与退出码；违规由 `a11y.spec.ts` 的断言使所在用例失败（RDF 15.2，取代
 * EV 1.7 中 A11y_Scan 违规不影响退出码的规定），经用例结果计入退出码。
 */
const a11ySection: SectionProvider = async ({ cases }) => {
  const facts = await Promise.all(cases.map((c) => withAttachmentBodies(c.facts, A11Y_RESULT_ATTACHMENT)));
  const data = buildA11ySection(A11Y_SCANS, facts);
  return { status: "ready", lines: renderA11ySection(data), data };
};

/**
 * 已接入的分节生成函数，任务 18.6（`visual`）、19.6（`perf`）、20.5（`a11y`）的生成函数登记在这里；
 * 未登记的分节在其 profile 已运行时写"未生成"。三节都依赖 fixture（`EXTRA_SECTION_PROFILE`）：
 * fixture 未运行或运行在用例之前中止时由 `extraSectionNotRun` 判"未运行"，不调用生成函数（例如
 * globalSetup 中止时三节都写"未运行"，也不写 perf.json）。
 */
export const SECTION_PROVIDERS: Readonly<Partial<Record<ExtraSectionKey, SectionProvider>>> = {
  visual: visualSection,
  perf: perfSection,
  a11y: a11ySection,
};

/** 尚未接入时"未生成"的原因中注明的任务号。 */
const PENDING_SECTION_TASKS: Readonly<Record<ExtraSectionKey, string>> = {
  visual: "18.6",
  perf: "19.6",
  a11y: "20.5",
};

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code && !error.message.includes(code) ? `${code}：${error.message}` : error.message;
  }
  return String(error);
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === code;
}

function warn(message: string): void {
  console.error(`[e2e] ${message}`);
}

function testErrorText(error: TestError): string {
  return error.message ?? error.value ?? error.stack ?? "（空的错误信息）";
}

/** 附件 body 的文字（UTF-8）；没有 body 时为 undefined。 */
function attachmentText(body: Buffer | undefined): string | undefined {
  return body === undefined ? undefined : body.toString("utf8");
}

/** 命令行是否为列出模式（`--list` 出现在 `--` 之前）。 */
function isListInvocation(argv: readonly string[]): boolean {
  for (const arg of argv) {
    if (arg === "--") return false;
    if (arg === "--list") return true;
  }
  return false;
}

/**
 * Playwright `test` 命令各选项的取值方式，录自锁定版本 @playwright/test 1.62.1 的
 * `playwright/lib/program.js`（`testOptions`）：`flag` 不带值，`required` 为 `<值>`，`optional` 为
 * `[值]`，`variadic` 为 `<值...>`。`extractFilterArgs` 靠它跳过非过滤选项的取值，使取值不被误当作
 * 位置参数。
 */
const TEST_OPTION_ARITY: Readonly<Record<string, "flag" | "required" | "optional" | "variadic">> = {
  "--browser": "required",
  "--config": "required",
  "--debug": "optional",
  "--fail-on-flaky-tests": "flag",
  "--forbid-only": "flag",
  "--fully-parallel": "flag",
  "--global-timeout": "required",
  "--grep": "required",
  "--grep-invert": "required",
  "--headed": "flag",
  "--ignore-snapshots": "flag",
  "--last-failed": "flag",
  "--last-failed-file": "required",
  "--list": "flag",
  "--max-failures": "required",
  "--no-deps": "flag",
  "--output": "required",
  "--only-changed": "optional",
  "--pass-with-no-tests": "flag",
  "--project": "variadic",
  "--quiet": "flag",
  "--repeat-each": "required",
  "--reporter": "required",
  "--retries": "required",
  "--run-agents": "required",
  "--shard": "required",
  "--test-list": "required",
  "--test-list-invert": "required",
  "--timeout": "required",
  "--trace": "required",
  "--tsconfig": "required",
  "--ui": "flag",
  "--ui-host": "required",
  "--ui-port": "required",
  "--update-snapshots": "optional",
  "--update-source-method": "required",
  "--workers": "required",
  "-x": "flag",
};

/** 短选项 → `TEST_OPTION_ARITY` 中的名称（`-x` 只有短形式）。 */
const TEST_SHORT_OPTIONS: Readonly<Record<string, string>> = {
  "-c": "--config",
  "-g": "--grep",
  "-G": "--grep-invert",
  "-j": "--workers",
  "-u": "--update-snapshots",
  "-x": "-x",
};

/** RDF 16.1 计为"命令行过滤"的选项（设计第 15 节）；位置参数（文件过滤）另计。 */
const FILTER_OPTIONS: ReadonlySet<string> = new Set([
  "--grep",
  "--grep-invert",
  "--project",
  "--last-failed",
  "--only-changed",
]);

/** commander 的口径：长度大于 1 且以 `-` 开头的参数按选项解析。 */
function looksLikeOption(arg: string): boolean {
  return arg.length > 1 && arg.startsWith("-");
}

function optionArity(name: string | undefined): (typeof TEST_OPTION_ARITY)[string] | undefined {
  return name !== undefined && Object.prototype.hasOwnProperty.call(TEST_OPTION_ARITY, name)
    ? TEST_OPTION_ARITY[name]
    : undefined;
}

function shortOptionName(flag: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(TEST_SHORT_OPTIONS, flag) ? TEST_SHORT_OPTIONS[flag] : undefined;
}

/**
 * 从主进程的 `process.argv` 中取出本次运行的命令行过滤参数（RDF 16.1，设计第 15 节）：
 * `-g`/`--grep`、`-G`/`--grep-invert`、`--project`（含 `--name=值` 与短选项连写 `-g值` 的形式，
 * 连同取值）、`--last-failed`、`--only-changed`（连同可选的 ref），以及位置参数（文件过滤）。
 * 结果按出现顺序保留各参数的原样（`-g x` 为 `["-g", "x"]`，`--grep=x` 为 `["--grep=x"]`）。纯函数。
 *
 * `argv` 的形状为 `[node, <Playwright CLI 脚本>, "test", ...参数]`：`run.mjs` 以
 * `process.execPath <@playwright/test/cli> test …` 启动，`npx playwright test …` 也是同样的形状。
 * 前两项总是跳过，随后的 `test` 子命令也跳过。参数按 Playwright 所用 commander 的规则解析：
 *
 * - 带值选项（`required`）总是取下一个参数为值；可选值（`optional`）只在下一个参数不像选项时取它；
 *   `--project` 是可变参数，其后不像选项的参数都是项目名（`--project=a` 形式之后则不再是）。
 * - 短选项连写：带值的取其余部分为值（`-gfoo`、`-j4`），布尔的（`-x`）把其余部分当作下一个短选项
 *   （`-xg foo` 等同 `-x -g foo`）。
 * - `--` 之后的参数 Playwright 不当作文件过滤（`program.js` 的 `testFilters`），这里也不取。
 * - 不认识的选项不带值、不计入（Playwright 会因未知选项报错退出）。
 */
export function extractFilterArgs(argv: readonly string[]): string[] {
  const args = argv.slice(2);
  if (args[0] === "test") args.shift();
  const out: string[] = [];
  /** 正在接收可变参数（`--project a b`）时为该选项是否计入过滤；否则为 null。 */
  let variadicKeep: boolean | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") break;
    if (variadicKeep !== null && !looksLikeOption(arg)) {
      if (variadicKeep) out.push(arg);
      continue;
    }
    variadicKeep = null;

    if (!looksLikeOption(arg)) {
      out.push(arg);
      continue;
    }

    // 1. 完整的选项名：`--grep x`、`-g x`、`--last-failed`、`--project a b`
    const name = arg.startsWith("--") ? arg : shortOptionName(arg);
    const arity = optionArity(name);
    if (name !== undefined && arity !== undefined) {
      const taken = [arg];
      if (arity === "required" || arity === "variadic") {
        if (i + 1 < args.length) taken.push(args[++i]);
      } else if (arity === "optional") {
        if (i + 1 < args.length && !looksLikeOption(args[i + 1])) taken.push(args[++i]);
      }
      const keep = FILTER_OPTIONS.has(name);
      if (keep) out.push(...taken);
      if (arity === "variadic") variadicKeep = keep;
      continue;
    }

    // 2. 短选项连写：`-gfoo`、`-j4`、`-xg foo`
    if (arg.length > 2 && arg[1] !== "-") {
      const head = shortOptionName(arg.slice(0, 2));
      const headArity = optionArity(head);
      if (head !== undefined && headArity !== undefined) {
        if (headArity === "flag") {
          args[i] = `-${arg.slice(2)}`;
          i--;
        } else if (FILTER_OPTIONS.has(head)) {
          out.push(arg);
        }
        continue;
      }
    }

    // 3. `--name=值`
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq > 2) {
      const longName = arg.slice(0, eq);
      const longArity = optionArity(longName);
      if (longArity !== undefined && longArity !== "flag") {
        if (FILTER_OPTIONS.has(longName)) out.push(arg);
        continue;
      }
    }
    // 4. 不认识的选项：不计入
  }
  return out;
}

/** 文件存在、是普通文件，且修改时间不早于 `since`（本次运行生成）。 */
async function isFreshFile(abs: string, since: Date): Promise<boolean> {
  try {
    const st = await stat(abs);
    return st.isFile() && Math.ceil(st.mtimeMs) >= since.getTime();
  } catch {
    return false;
  }
}

/** 目录中至少有一个修改时间不早于 `since` 的普通文件。 */
async function hasFreshFile(dir: string, since: Date): Promise<boolean> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.isFile() && (await isFreshFile(path.join(dir, entry.name), since))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 快照（4.5、4.8）
// ---------------------------------------------------------------------------

interface SnapshotRead {
  reading: SnapshotReading;
  snapshot: Snapshot | null;
}

async function takeEndSnapshot(): Promise<SnapshotRead> {
  let snapshot: Snapshot;
  try {
    snapshot = await takeSnapshot();
  } catch (error) {
    return { reading: { ok: false, reason: `取结束快照失败：${errorText(error)}` }, snapshot: null };
  }
  try {
    await writeSnapshot(SNAPSHOT_END_FILE, snapshot);
  } catch (error) {
    // 快照已在内存中取得并参与比对；只是没能留下文件
    warn(`结束快照已取得，但未能写入 ${repoRelative(SNAPSHOT_END_FILE)}：${errorText(error)}`);
  }
  return { reading: { ok: true, count: snapshot.count, ms: snapshot.ms }, snapshot };
}

async function readStartSnapshot(runStart: Date): Promise<SnapshotRead> {
  const rel = repoRelative(SNAPSHOT_START_FILE);
  let snapshot: Snapshot | null;
  try {
    snapshot = await readSnapshot(SNAPSHOT_START_FILE);
  } catch (error) {
    return { reading: { ok: false, reason: `开始快照读取失败：${errorText(error)}` }, snapshot: null };
  }
  if (snapshot === null) {
    return { reading: { ok: false, reason: `开始快照缺失（没有 ${rel}）` }, snapshot: null };
  }
  if (Date.parse(snapshot.takenAt) < runStart.getTime()) {
    return {
      reading: {
        ok: false,
        reason:
          `开始快照缺失：${rel} 取于 ${snapshot.takenAt}，早于本次运行开始（${runStart.toISOString()}），` +
          "是上一次运行的残留",
      },
      snapshot: null,
    };
  }
  return { reading: { ok: true, count: snapshot.count, ms: snapshot.ms }, snapshot };
}

// ---------------------------------------------------------------------------
// 状态文件（17.7、3.9）
// ---------------------------------------------------------------------------

/** 记录写于本次运行开始之后；时刻字段读不出时按残留处理。 */
function writtenDuringRun(iso: string, runStart: Date): boolean {
  const t = Date.parse(iso);
  return !Number.isNaN(t) && t >= runStart.getTime();
}

async function readRunAbort(runStart: Date, errors: string[]): Promise<AbortInfo | null> {
  try {
    const record = await readAbort();
    if (record === null) return null;
    if (!isAbortFromRun(record, runStart)) {
      warn(`忽略上一次运行残留的 ${repoRelative(ABORT_FILE)}（写于 ${record.writtenAt}）`);
      return null;
    }
    return record;
  } catch (error) {
    // abort.json 存在即 globalSetup 已中止，只是记录读不出
    errors.push(`${REPORTER_ERROR_PREFIX}读取 ${repoRelative(ABORT_FILE)} 失败：${errorText(error)}`);
    return { stage: "（未知）", reason: `${repoRelative(ABORT_FILE)} 存在但无法读取：${errorText(error)}` };
  }
}

async function readRunFixtureFailed(runStart: Date, errors: string[]): Promise<FixtureFailure | null> {
  try {
    const failure = await readFixtureFailed();
    if (failure === null || !writtenDuringRun(failure.writtenAt, runStart)) return null;
    return failure;
  } catch (error) {
    // 文件存在即 Fixture_Generator 失败（3.9），只是明细读不出
    const reason = `${repoRelative(FIXTURE_FAILED_FILE)} 存在但无法读取：${errorText(error)}`;
    errors.push(`${REPORTER_ERROR_PREFIX}${reason}`);
    return { writtenAt: new Date().toISOString(), exitCode: null, reason, detail: [] };
  }
}

async function readRolesOrNull(selected: readonly LibraryProfile[]): Promise<FixtureRoles | null> {
  if (!selected.includes("fixture")) return null;
  try {
    return await readFixtureRoles();
  } catch {
    // 取不到时元数据按用途写出（consistency.ts 的约定）
    return null;
  }
}

// ---------------------------------------------------------------------------
// 用例 → CaseFacts
// ---------------------------------------------------------------------------

/** 文件内的标题路径：从文件套件之下到用例自身，跳过匿名 describe。 */
function titlePathInFile(test: TestCase): string[] {
  const titles = [test.title];
  for (let suite: Suite | undefined = test.parent; suite && suite.type === "describe"; suite = suite.parent) {
    if (suite.title !== "") titles.unshift(suite.title);
  }
  return titles;
}

/** 用例与结果的注解，按出现顺序合并；类型与说明都相同的只留第一条（Playwright 把静态注解同时放进两处）。 */
function mergedAnnotations(test: TestCase, result: TestResult | null): CaseAnnotation[] {
  const out: CaseAnnotation[] = [];
  const seen = new Set<string>();
  for (const a of [...test.annotations, ...(result?.annotations ?? [])]) {
    const key = JSON.stringify([a.type, a.description ?? null]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a.description === undefined ? { type: a.type } : { type: a.type, description: a.description });
  }
  return out;
}

function caseAttachments(result: TestResult): CaseAttachment[] {
  return result.attachments.map((a) => {
    const item: CaseAttachment = { name: a.name };
    if (a.path !== undefined) item.path = a.path;
    if (a.body !== undefined) item.body = a.body;
    return item;
  });
}

function toCaseFacts(test: TestCase, result: TestResult | null): CaseFacts {
  return {
    id: test.id,
    file: test.location.file,
    titlePath: titlePathInFile(test),
    project: test.parent.project()?.name ?? "",
    expectedStatus: test.expectedStatus,
    timeoutMs: test.timeout,
    annotations: mergedAnnotations(test, result),
    result:
      result === null
        ? null
        : {
            status: result.status,
            startMs: result.startTime.getTime(),
            durationMs: result.duration,
            errors: result.errors.map(testErrorText),
            attachments: caseAttachments(result),
          },
  };
}

// ---------------------------------------------------------------------------
// Review_Report（13.3、13.4、13.10、13.11）
// ---------------------------------------------------------------------------

function isLibraryProfile(v: unknown): v is LibraryProfile {
  return LIBRARY_PROFILES.some((p) => p === v);
}

function isMode(v: unknown): v is Mode {
  return v === "opaque" || v === "transparent";
}

/** 用例所用的 Library_Profile 与模式：先取 `target` 写下的注解，再取项目的 `use`；tooling 为 null。 */
function caseTarget(test: TestCase, annotations: readonly CaseAnnotation[]): { profile: LibraryProfile; mode: Mode } | null {
  const noted = (type: string): string | undefined => annotations.find((a) => a.type === type)?.description;
  const use = (test.parent.project()?.use ?? {}) as { profile?: unknown; mode?: unknown };
  const profile = noted(ANNOTATIONS.profile) ?? use.profile;
  const mode = noted(ANNOTATIONS.mode) ?? use.mode ?? "opaque";
  if (!isLibraryProfile(profile) || !isMode(mode)) return null;
  return { profile, mode };
}

function reviewShotNames(result: TestResult | null): string[] {
  if (result === null) return [];
  const names: string[] = [];
  for (const a of result.attachments) {
    if (a.name !== ATTACHMENTS.reviewShot) continue;
    const name = attachmentText(a.body)?.trim();
    if (name) names.push(name);
  }
  return names;
}

function stepAtEndOf(result: TestResult | null): string | null {
  const body = result?.attachments.find((a) => a.name === ATTACHMENTS.stepAtEnd)?.body;
  return parseStepAtEnd(attachmentText(body))?.step ?? null;
}

async function readPngHead(file: string): Promise<Uint8Array> {
  const handle = await open(file, "r");
  try {
    const buf = Buffer.alloc(PNG_HEAD_BYTES);
    const { bytesRead } = await handle.read(buf, 0, PNG_HEAD_BYTES, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** `e2e/.out/review/` 中的 PNG（扩展名不区分大小写），逐个读 IHDR；读不出时尺寸为 null。 */
async function listReviewPngs(): Promise<ReviewPng[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(REVIEW_DIR, { withFileTypes: true });
  } catch (error) {
    if (isErrno(error, "ENOENT")) return [];
    throw error;
  }
  const files = entries
    .filter((e) => e.isFile() && /\.png$/i.test(e.name))
    .map((e) => e.name)
    .sort();
  return Promise.all(
    files.map(async (file): Promise<ReviewPng> => {
      try {
        return { file, size: pngSize(await readPngHead(path.join(REVIEW_DIR, file))) };
      } catch {
        return { file, size: null };
      }
    }),
  );
}

interface ReviewPlan {
  statuses: Map<string, ShotStatus>;
  violations: Violation[];
}

/**
 * `ShotRunFacts.collected`（RDF 16.1）：本次收集到的 UI 用例的 `shotCaseKey`，口径与 `planReview`
 * 归档结果时相同。`onBegin` 时还没有结果注解，profile 与 mode 取项目的 `use`；模式只在项目级声明
 * （`playwright.config.ts`），与 `target` fixture 之后写下的注解一致。tooling 用例没有 profile，不计入。
 */
function collectedShotCases(tests: readonly TestCase[]): Set<string> {
  const keys = new Set<string>();
  for (const test of tests) {
    const target = caseTarget(test, mergedAnnotations(test, null));
    if (target === null) continue;
    keys.add(shotCaseKey(target.profile, target.mode, shotTestRef(test.location.file, test.title)));
  }
  return keys;
}

async function planReview(
  cases: readonly CollectedCase[],
  run: Omit<ShotRunFacts, "cases">,
): Promise<ReviewPlan> {
  const captures: { name: string; test: string }[] = [];
  const byCase = new Map<string, ShotCaseResult>();
  for (const { test, result, facts } of cases) {
    const ref = shotTestRef(test.location.file, test.title);
    const shots = reviewShotNames(result);
    for (const name of shots) captures.push({ name, test: formatShotTest(ref) });

    const target = caseTarget(test, facts.annotations);
    if (target === null) continue;
    const row = toCaseRow(facts);
    const entry: ShotCaseResult = {
      outcome: row.outcome,
      timedOut: result?.status === "timedOut",
      skipReason: row.skip?.reason ?? null,
      step: stepAtEndOf(result),
      shots,
    };
    const key = shotCaseKey(target.profile, target.mode, ref);
    const existing = byCase.get(key);
    // 同一文件里自身标题相同的用例（不同 describe）归到同一键：合并拍摄记录，结果取先出现的
    byCase.set(key, existing === undefined ? entry : { ...existing, shots: [...existing.shots, ...shots] });
  }

  const statuses = resolveShotStatuses(REVIEW_CATALOG, { ...run, cases: byCase });
  const violations = checkReviewConsistency({
    catalog: REVIEW_CATALOG,
    requiredNames: REQUIRED_SHOT_NAMES,
    requiredChecklist: REQUIRED_CHECKLIST,
    captures,
    pngs: await listReviewPngs(),
    uncaptured: uncapturedReasons(statuses),
  });
  return { statuses, violations };
}

async function writeReviewReport(plan: ReviewPlan, meta: ReviewReportMeta): Promise<void> {
  await mkdir(REVIEW_DIR, { recursive: true });
  const data = reviewReportData(REVIEW_CATALOG, plan.statuses, meta);
  await writeFile(path.join(REVIEW_DIR, REVIEW_REPORT_MD), renderReviewReport(REVIEW_CATALOG, plan.statuses, meta), "utf8");
  await writeFile(path.join(REVIEW_DIR, REVIEW_REPORT_JSON), `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// 第 8 节与第 11 节
// ---------------------------------------------------------------------------

async function buildSections(input: SectionInput): Promise<Record<ExtraSectionKey, ExtraSection>> {
  const sections = {} as Record<ExtraSectionKey, ExtraSection>;
  for (const key of EXTRA_SECTION_KEYS) {
    const notRun = extraSectionNotRun(key, input.ctx);
    if (notRun !== null) {
      sections[key] = notRun;
      continue;
    }
    const provider = SECTION_PROVIDERS[key];
    if (provider === undefined) {
      sections[key] = { status: "notGenerated", reason: `该节尚未接入 reporter，见任务 ${PENDING_SECTION_TASKS[key]}` };
      continue;
    }
    try {
      sections[key] = await provider(input);
    } catch (error) {
      warn(`生成"${SUMMARY_HEADINGS[key].replace(/^#+\s*/, "")}"一节失败：${errorText(error)}`);
      sections[key] = { status: "notGenerated", reason: `生成该节时出错：${errorText(error)}` };
    }
  }
  return sections;
}

/** 第 8 节的四项产物；Review_Report 由本 reporter 在写 summary 之前写出，这里按将要写出处理。 */
async function collectArtifacts(ctx: RunContext, since: Date): Promise<Record<ArtifactKey, ArtifactRef>> {
  const out = {} as Record<ArtifactKey, ArtifactRef>;
  for (const key of ARTIFACT_KEYS) {
    const rel = ARTIFACT_PATHS[key];
    const abs = path.join(REPO_ROOT, rel);
    let present: boolean;
    if (key === "reviewReport") present = true;
    else if (key === "a11y") present = await hasFreshFile(abs, since);
    else present = await isFreshFile(abs, since);
    out[key] = present ? { path: rel } : { missing: missingArtifactReason(key, ctx) };
  }
  return out;
}

// ---------------------------------------------------------------------------
// 应急 Run_Summary
// ---------------------------------------------------------------------------

async function writeFallbackSummary(result: FullResult, error: unknown): Promise<void> {
  const end = new Date(result.startTime.getTime() + result.duration);
  const detail = errorText(error).replace(/\s*[\r\n]+\s*/g, " ");
  const lines = [
    SUMMARY_TITLE,
    "",
    SUMMARY_HEADINGS.overview,
    "",
    `- 开始时间：${formatLocalTimestamp(result.startTime)}`,
    `- 结束时间：${formatLocalTimestamp(end)}`,
    `- 退出码：1`,
    `- Playwright 结束状态：${result.status}`,
    `- reporter 内部错误：${detail}`,
    "",
    "reporter 未能生成完整的 Run_Summary，其余各节从略；错误堆栈见终端输出，用例结果见 Playwright HTML 报告。",
  ];
  await mkdir(path.dirname(SUMMARY_FILE), { recursive: true });
  await writeFile(SUMMARY_FILE, `${lines.join("\n")}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// Reporter
// ---------------------------------------------------------------------------

export default class E2EReporter implements Reporter {
  readonly #listMode: boolean;
  #suite: Suite | null = null;
  #onBeginTests: number | null = null;
  /** `onBegin` 时收集到的拍摄用例键（RDF 16.1）；`onBegin` 未被调用时为空集。 */
  #collected: ReadonlySet<string> = new Set<string>();
  readonly #errors: string[] = [];
  readonly #results = new Map<string, TestResult>();

  /** `options._mode` 为 Playwright 传给每个 reporter 的运行方式（`test` / `list` / `merge`）。 */
  constructor(options: { _mode?: unknown } = {}) {
    this.#listMode = options._mode === "list" || isListInvocation(process.argv);
  }

  printsToStdio(): boolean {
    return false;
  }

  onBegin(_config: FullConfig, suite: Suite): void {
    this.#suite = suite;
    const tests = suite.allTests();
    this.#onBeginTests = tests.length;
    this.#collected = collectedShotCases(tests);
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    this.#results.set(test.id, result);
  }

  onError(error: TestError): void {
    this.#errors.push(testErrorText(error));
  }

  async onEnd(result: FullResult): Promise<{ status?: FullResult["status"] } | undefined> {
    if (this.#listMode) return undefined;
    try {
      const model = await this.#finish(result);
      const exit = model.exitCode;
      console.log(
        `[e2e] Run_Summary：${repoRelative(SUMMARY_FILE)}（退出码 ${exit}）；` +
          `Review_Report：${repoRelative(path.join(REVIEW_DIR, REVIEW_REPORT_MD))}`,
      );
      return exit === 0 ? undefined : { status: "failed" };
    } catch (error) {
      warn(`reporter 未能写出完整的 Run_Summary：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      try {
        await writeFallbackSummary(result, error);
        warn(`已写应急 Run_Summary：${repoRelative(SUMMARY_FILE)}（退出码 1）`);
      } catch (writeError) {
        warn(`应急 Run_Summary 也未能写出：${errorText(writeError)}`);
      }
      return { status: "failed" };
    }
  }

  async #finish(result: FullResult): Promise<RunSummaryModel> {
    const startTime = result.startTime;
    const selected = selectedProfiles(process.env.E2E_PROFILE);
    const readErrors: string[] = [];

    // 1. 结束快照先取（4.5），再读开始快照并比对（4.8）
    const end = await takeEndSnapshot();
    const start = await readStartSnapshot(startTime);
    const diff: SnapshotDiff | null =
      start.snapshot !== null && end.snapshot !== null ? diffSnapshots(start.snapshot, end.snapshot) : null;

    // 2. 本次运行的状态文件
    const setupAbort = await readRunAbort(startTime, readErrors);
    const fixtureFailed = selected.includes("fixture") ? await readRunFixtureFailed(startTime, readErrors) : null;

    // 3. 用例与中止信息
    const cases: CollectedCase[] = (this.#suite?.allTests() ?? []).map((test) => {
      const res = this.#results.get(test.id) ?? null;
      return { test, result: res, facts: toCaseFacts(test, res) };
    });
    const errors = [...this.#errors, ...readErrors];
    const collected = isCollected({
      setupAborted: setupAbort !== null,
      onBeginTests: this.#onBeginTests,
      errorCount: errors.length,
    });
    const abort = resolveAbort({ setupAbort, collected, status: result.status, errors });
    const ctx: RunContext = { selected, abort, collected };

    // 4. Review_Report 的拍摄状态与一致性检查（13.11）
    const abortStage = setupAbort?.stage ?? (!collected && abort !== null ? abort.stage : null);
    const review = await planReview(cases, {
      selected,
      abortStage,
      interrupted: result.status === "interrupted",
      collected: this.#collected,
      filterArgs: extractFilterArgs(process.argv),
    });

    // 5–6. 第 11 节与第 8 节
    const startedAt = formatLocalTimestamp(startTime);
    const sections = await buildSections({ cases, ctx, startTime, startedAt });
    const artifacts = await collectArtifacts(ctx, startTime);

    // 7. 组装模型
    let facts: RunFacts = {
      startTime,
      durationMs: result.duration,
      status: result.status,
      selected,
      onBeginTests: this.#onBeginTests,
      errors,
      setupAbort,
      cases: cases.map((c) => c.facts),
      snapshot: { start: start.reading, end: end.reading, diff },
      fixtureFailed,
      reviewViolations: review.violations,
      artifacts,
      sections,
    };
    let model = buildRunSummary(facts);

    const meta: ReviewReportMeta = { startedAt: model.startedAt, profiles: model.selected, roles: await readRolesOrNull(selected) };
    try {
      await writeReviewReport(review, meta);
    } catch (error) {
      const reason = `写 Review_Report 失败：${errorText(error)}`;
      facts = {
        ...facts,
        errors: [...facts.errors, `${REPORTER_ERROR_PREFIX}${reason}`],
        artifacts: { ...facts.artifacts, reviewReport: { missing: reason } },
      };
      model = buildRunSummary(facts);
    }

    // Playwright 判失败而模型没有原因时补一条，使 summary 的退出码与进程一致
    if (model.exitCode === 0 && result.status !== "passed") {
      facts = {
        ...facts,
        errors: [
          ...facts.errors,
          `${REPORTER_ERROR_PREFIX}Playwright 以状态 ${result.status} 结束，但未找到失败的用例或运行级失败`,
        ],
      };
      model = buildRunSummary(facts);
    }

    // 8. summary.md 与 results.json
    await mkdir(path.dirname(SUMMARY_FILE), { recursive: true });
    await writeFile(SUMMARY_FILE, renderSummary(model), "utf8");
    await writeFile(RESULTS_FILE, `${JSON.stringify(model, null, 2)}\n`, "utf8");
    return model;
  }
}
