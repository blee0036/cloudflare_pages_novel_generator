/**
 * Review_Report 与一致性检查（需求 13.3、13.4、13.10、13.11；设计"Review_Catalog 与 Review_Report"
 * 与 Data Models"Review_Report 一致性检查"）。
 *
 * 本文件全是纯函数：不读取也不写入任何文件、不访问网络、不修改参数。reporter（任务 16.4）在 `onEnd` 中：
 *
 * 1. 列出 `e2e/.out/review/*.png`，每个读前 24 字节交给 `pngSize`，得到 `ReviewPng[]`；
 * 2. 由各用例的结果组装 `ShotRunFacts`，经 `resolveShotStatuses` 得到每张 Review_Shot 的拍摄状态；
 * 3. `checkReviewConsistency({ …, uncaptured: uncapturedReasons(statuses) })` 得到违规列表，
 *    每条违规记一条运行级失败（13.11），Run_Summary 用 `describeViolation` 逐条列出；
 * 4. `renderReviewReport` 写 `review-report.md`，`reviewReportData` 写 `review-report.json`。
 *    违规非空时照常写出（13.11）。
 *
 * ## 报告格式（13.3、13.4）
 *
 * - 开头两行：`- 运行开始时间：<startedAt>`（与 `results.json` 的 `startedAt` 为同一字符串，
 *   验收阶段 7 据此比对）与 `- 本次执行的 Library_Profile：fixture`（没有时写"无"）。
 * - 之后按 catalog 顺序每张一节，标题行为 `## <名称>`。
 * - 已拍摄的节：恰有 1 行 `- PNG：![A](<D>)`（RDF 16.3 的 CommonMark 合法形式）：A 为名称经
 *   `escapeLinkText` 转义，D 为相对报告的文件名 `<名称>.png`（二者同在 `e2e/.out/review/`）经
 *   `escapeLinkDestination` 转义并以尖括号包裹；13.1 的全部元数据（`shotMetadata`）、用例名与最终结果，以及带编号的准则；每条准则下恰有
 *   1 行判定栏 `VERDICT_FIELD`。
 * - 未拍摄的节：没有 PNG 行与判定栏；有 1 行 `- 未拍摄原因：<describeUncapturedReason>`、
 *   元数据与用例名。
 */
import type { FixtureRoles, LibraryProfile } from "../support/library";
import { VIEWPORTS } from "../support/settings";
import { reviewShotFileName, shotMetadata, type ReviewShotDef, type ShotTestRef } from "./catalog";

/** Review_Report 与其 JSON 的文件名（位于 `REVIEW_DIR`，与 PNG 同目录）。 */
export const REVIEW_REPORT_MD = "review-report.md";
export const REVIEW_REPORT_JSON = "review-report.json";

// ---------------------------------------------------------------------------
// PNG 尺寸（13.10）
// ---------------------------------------------------------------------------

export interface PngSize {
  readonly width: number;
  readonly height: number;
}

/** PNG 文件签名（8 字节）。 */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
/** IHDR 块类型的 ASCII。 */
const IHDR_TYPE = [0x49, 0x48, 0x44, 0x52] as const;
/** IHDR 数据长度恒为 13。 */
const IHDR_LENGTH = 13;
/** 读宽高所需的字节数：签名 8 + 块长度 4 + 块类型 4 + 宽 4 + 高 4。 */
export const PNG_HEAD_BYTES = 24;
/** PNG 规定宽高为 1 到 2^31 − 1。 */
const PNG_MAX_DIMENSION = 2 ** 31 - 1;

function readUint32BE(b: Uint8Array, at: number): number {
  return b[at] * 2 ** 24 + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3];
}

/**
 * 从文件开头读 PNG 的宽高（IHDR）。只看前 `PNG_HEAD_BYTES` 字节，多给的忽略。
 * 不足 24 字节、签名不符、首块不是长度 13 的 IHDR，或宽高不在 1 到 2^31 − 1 之间时返回 null。
 */
export function pngSize(head: Uint8Array): PngSize | null {
  if (head.length < PNG_HEAD_BYTES) return null;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (head[i] !== PNG_SIGNATURE[i]) return null;
  }
  if (readUint32BE(head, 8) !== IHDR_LENGTH) return null;
  for (let i = 0; i < IHDR_TYPE.length; i++) {
    if (head[12 + i] !== IHDR_TYPE[i]) return null;
  }
  const width = readUint32BE(head, 16);
  const height = readUint32BE(head, 20);
  const ok = (n: number): boolean => n >= 1 && n <= PNG_MAX_DIMENSION;
  return ok(width) && ok(height) ? { width, height } : null;
}

/**
 * 13.10 的尺寸规则：`viewport` 等于该视口；`element` 宽、高均不超过视口；`fullPage` 宽等于视口宽、
 * 高不超过视口高的 3 倍（桌面 2,400 px，移动 2,532 px）。
 */
export function shotSizeFits(def: Pick<ReviewShotDef, "viewport" | "scope">, size: PngSize): boolean {
  const vp = VIEWPORTS[def.viewport];
  switch (def.scope) {
    case "viewport":
      return size.width === vp.width && size.height === vp.height;
    case "element":
      return size.width <= vp.width && size.height <= vp.height;
    case "fullPage":
      return size.width === vp.width && size.height <= vp.height * 3;
  }
}

/** `bad-size` 违规中"应为"的写法；PNG 头读不出时写"PNG IHDR"（设计错误处理表）。 */
export function expectedShotSize(def: Pick<ReviewShotDef, "viewport" | "scope">): string {
  const vp = VIEWPORTS[def.viewport];
  switch (def.scope) {
    case "viewport":
      return `${vp.width}×${vp.height}`;
    case "element":
      return `宽 ≤ ${vp.width} 且高 ≤ ${vp.height}`;
    case "fullPage":
      return `宽 = ${vp.width} 且高 ≤ ${vp.height * 3}`;
  }
}

/** PNG 头读不出宽高时 `bad-size` 的 `expected`。 */
export const EXPECTED_PNG_IHDR = "PNG IHDR";

// ---------------------------------------------------------------------------
// 拍摄状态（13.3、13.4）
// ---------------------------------------------------------------------------

/**
 * 用例的归类，取值与 `support/summary.ts` 的 `classify`（任务 16.1）相同：`notRun` 为运行被中断
 * 或没有结果的用例。
 */
export type CaseOutcome = "passed" | "failed" | "unexpectedPass" | "skipped" | "expectedFail" | "notRun";

/** 13.4 的四类原因，加上 reader-defect-fixes 需求 16.1 的"未被本次运行选中"。 */
export type UncapturedReason =
  /** 所属 Library_Profile 未在本次运行中执行。 */
  | { readonly kind: "profile-not-run"; readonly profile: LibraryProfile }
  /**
   * 运行没有中止，而拍摄用例因命令行过滤（`-g`、文件参数、`--project` 等）未被本次运行收集
   * （RDF 16.1）；`filter` 为本次运行的过滤参数（reporter 的 `extractFilterArgs`），可为空。
   */
  | { readonly kind: "not-selected"; readonly filter: readonly string[] }
  /** 用例被跳过；`reason` 为 Run_Summary 中的跳过原因（如 `[3.9] …`、`[16.4 F-003] …`）。 */
  | { readonly kind: "skipped"; readonly reason: string }
  /** 用例在拍摄前失败或超时；`step` 为 `step-at-end` 的步骤名（或"无具名步骤"）。 */
  | { readonly kind: "failed-before-shot"; readonly step: string; readonly timedOut: boolean }
  /**
   * 运行在拍摄前中止：`abort.json` 存在（附中止阶段），或该用例已被收集、但被中断或未执行
   * （RDF 16.1：未被收集的用例归 `not-selected`）。
   */
  | { readonly kind: "aborted"; readonly cause: "abort"; readonly stage: string }
  | { readonly kind: "aborted"; readonly cause: "interrupted" | "not-executed" };

/** 某张 Review_Shot 在本次运行中的状态。`test` 为用例名（`formatShotTest`）。 */
export type ShotStatus =
  | {
      readonly captured: true;
      readonly test: string;
      /** 拍摄它的用例的最终结果。 */
      readonly result: CaseOutcome;
      readonly timedOut: boolean;
    }
  | {
      readonly captured: false;
      readonly test: string;
      /** null：不属于 13.4 的任何一种（例如用例通过却没有拍摄），一致性检查会据此报 `no-png-no-reason`。 */
      readonly reason: UncapturedReason | null;
    };

/** 报告与 Run_Summary 中的用例名：`<相对 e2e/tests 的文件> › <标题>`。 */
export function formatShotTest(ref: ShotTestRef): string {
  return `${ref.file} › ${ref.title}`;
}

/** 拍摄用例（`def.by`）在某个项目中的本次结果，由 reporter 从 `TestCase` / `TestResult` 取得。 */
export interface ShotCaseResult {
  readonly outcome: CaseOutcome;
  /** `TestResult.status === "timedOut"`。 */
  readonly timedOut: boolean;
  /** `outcome` 为 `skipped` 时的跳过原因（`skip` 注解的 description）。 */
  readonly skipReason: string | null;
  /** `step-at-end` 附件的步骤名；没有该附件时为 null。 */
  readonly step: string | null;
  /** 本次结果中 `review-shot` 附件的名称，按出现顺序。 */
  readonly shots: readonly string[];
}

/** `resolveShotStatus` 所需的运行事实。 */
export interface ShotRunFacts {
  /** 本次执行的 Library_Profile。 */
  readonly selected: readonly LibraryProfile[];
  /** `abort.json` 存在时的中止阶段；未中止为 null。 */
  readonly abortStage: string | null;
  /** 运行是否被中断（`onEnd` 的 `status` 为 `interrupted`）。 */
  readonly interrupted: boolean;
  /** 键为 `shotCaseKey(profile, mode, ref)`：用例所在项目的 Library_Profile、服务器模式与用例。 */
  readonly cases: ReadonlyMap<string, ShotCaseResult>;
  /**
   * 本次运行收集到的用例（reporter 在 `onBegin` 中由 `suite.allTests()` 建立），键同 `cases`
   * （`shotCaseKey`）。`onBegin` 未被调用时为空集（此时运行已中止，`abortStage` 非 null）。
   */
  readonly collected: ReadonlySet<string>;
  /** 本次运行的命令行过滤参数（`extractFilterArgs(process.argv)`），按出现顺序；没有时为空数组。 */
  readonly filterArgs: readonly string[];
}

/** `ShotRunFacts.cases` 的键。 */
export function shotCaseKey(profile: LibraryProfile, mode: ReviewShotDef["mode"], ref: ShotTestRef): string {
  return JSON.stringify([profile, mode, ref.file, ref.title]);
}

/**
 * 判定一张 Review_Shot 的状态。依次：
 * 1. `def.by` 在 `def.profile` / `def.mode` 的项目中的结果带有该名称的 `review-shot` 附件 → 已拍摄；
 * 2. `abort.json` 存在 → 运行在拍摄前中止（设计：中止的运行中全部未拍摄的节都写这一条）；
 * 3. `def.profile` 未被选中 → Library_Profile 未执行；
 * 4. 没有该用例的结果或 `notRun`（RDF 16.1）：
 *    - 该用例不在 `collected` 中（命令行过滤未选中；运行未中止已由第 2 步保证）→ 未被本次运行
 *      选中（附 `filterArgs`）；
 *    - 在 `collected` 中 → 运行在拍摄前中止（被中断 / 该用例未执行）；
 * 5. `skipped` → 用例被跳过（附跳过原因）；
 * 6. `failed` / `expectedFail`（实际失败或超时）→ 拍摄前失败或超时（附步骤名）；
 * 7. 其余（`passed` / `unexpectedPass`：用例跑完却没有拍摄）→ 原因为 null。
 */
export function resolveShotStatus(def: ReviewShotDef, facts: ShotRunFacts): ShotStatus {
  const test = formatShotTest(def.by);
  const key = shotCaseKey(def.profile, def.mode, def.by);
  const result = facts.cases.get(key);
  if (result !== undefined && result.shots.includes(def.name)) {
    return { captured: true, test, result: result.outcome, timedOut: result.timedOut };
  }
  const uncaptured = (reason: UncapturedReason | null): ShotStatus => ({ captured: false, test, reason });
  if (facts.abortStage !== null) return uncaptured({ kind: "aborted", cause: "abort", stage: facts.abortStage });
  if (!facts.selected.includes(def.profile)) return uncaptured({ kind: "profile-not-run", profile: def.profile });
  if (result === undefined || result.outcome === "notRun") {
    if (!facts.collected.has(key)) return uncaptured({ kind: "not-selected", filter: [...facts.filterArgs] });
    return uncaptured({ kind: "aborted", cause: facts.interrupted ? "interrupted" : "not-executed" });
  }
  switch (result.outcome) {
    case "skipped":
      return uncaptured({ kind: "skipped", reason: result.skipReason ?? "未注明跳过原因" });
    case "failed":
    case "expectedFail":
      return uncaptured({
        kind: "failed-before-shot",
        step: result.step ?? "无具名步骤",
        timedOut: result.timedOut,
      });
    case "passed":
    case "unexpectedPass":
      return uncaptured(null);
  }
}

/** 按 catalog 为每个名称判定状态（重名时取第一个定义）。 */
export function resolveShotStatuses(
  catalog: readonly ReviewShotDef[],
  facts: ShotRunFacts,
): Map<string, ShotStatus> {
  const out = new Map<string, ShotStatus>();
  for (const def of catalog) {
    if (!out.has(def.name)) out.set(def.name, resolveShotStatus(def, facts));
  }
  return out;
}

/** `not-selected` 的过滤参数为空时（如 `test.only`、`--shard` 造成的未收集）的写法。 */
export const NO_FILTER_ARGS = "无";

/** 13.4 的原因文字（`not-selected` 为 RDF 16.1：过滤参数以空格分隔，没有时写 `NO_FILTER_ARGS`）。 */
export function describeUncapturedReason(reason: UncapturedReason): string {
  switch (reason.kind) {
    case "profile-not-run":
      return `所属 Library_Profile（${reason.profile}）未在本次运行中执行`;
    case "not-selected": {
      const filter = reason.filter.length > 0 ? reason.filter.join(" ") : NO_FILTER_ARGS;
      return `用例未被本次运行选中（命令行过滤：${filter}）`;
    }
    case "skipped":
      return `用例被跳过：${reason.reason}`;
    case "failed-before-shot":
      return `用例在拍摄前${reason.timedOut ? "超时" : "失败"}，当时所处的测试步骤：${reason.step}`;
    case "aborted":
      switch (reason.cause) {
        case "abort":
          return `运行在拍摄前中止（中止阶段：${reason.stage}）`;
        case "interrupted":
          return "运行在拍摄前中止（运行被中断，该用例未执行完）";
        case "not-executed":
          return "运行在拍摄前中止（该用例未执行）";
      }
  }
}

/** 原因为 null 的未拍摄节的写法（不属于 13.4 的任一情形）。 */
export const UNKNOWN_UNCAPTURED_REASON = "原因不明：用例已结束但未拍摄该图，不属于需求 13.4 的任一情形";

/**
 * `ConsistencyInput.uncaptured`：未拍摄且有 13.4 原因的名称 → 原因文字。原因为 null 的不列入，
 * 使一致性检查对它们（没有 PNG 时）报 `no-png-no-reason`。
 */
export function uncapturedReasons(statuses: ReadonlyMap<string, ShotStatus>): Record<string, string> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, status] of statuses) {
    if (!status.captured && status.reason !== null) out[name] = describeUncapturedReason(status.reason);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 一致性检查（13.10、13.11）
// ---------------------------------------------------------------------------

/** `review` 目录中的一个 PNG：文件名（不含目录）与 `pngSize` 的结果。 */
export interface ReviewPng {
  readonly file: string;
  readonly size: PngSize | null;
}

export interface ConsistencyInput {
  readonly catalog: readonly ReviewShotDef[];
  readonly requiredNames: readonly string[];
  readonly requiredChecklist: readonly string[];
  /** 每条 `review-shot` 附件一条（同名多次即多条）；`test` 为拍摄它的用例名。 */
  readonly captures: readonly { readonly name: string; readonly test: string }[];
  /** `review` 目录中实际存在的 PNG。 */
  readonly pngs: readonly ReviewPng[];
  /** 名称 → 13.4 的原因文字（`uncapturedReasons`）。 */
  readonly uncaptured: Readonly<Record<string, string>>;
}

export type Violation =
  /** catalog 中该名称出现不止一次。 */
  | { readonly kind: "duplicate-name"; readonly name: string }
  /** 13.2 要求的名称不在 catalog 中。 */
  | { readonly kind: "missing-name"; readonly name: string }
  /** 13.2 要求的 Checklist 项没有被任何条目引用。 */
  | { readonly kind: "checklist-uncovered"; readonly item: string }
  /** 同一名称有多于 1 条 `review-shot` 附件（后一次覆盖了前一次的 PNG）；`count` 为附件条数。 */
  | { readonly kind: "multiple-png"; readonly name: string; readonly count: number }
  /** 没有 `<名称>.png`，也没有 13.4 的原因。 */
  | { readonly kind: "no-png-no-reason"; readonly name: string }
  /** 文件名不是任何 catalog 名称的 `<名称>.png`。 */
  | { readonly kind: "orphan-png"; readonly file: string }
  /** 尺寸不符合 13.10；`actual` 为 null 表示读不出 PNG 头（此时 `expected` 为 `EXPECTED_PNG_IHDR`）。 */
  | { readonly kind: "bad-size"; readonly name: string; readonly actual: PngSize | null; readonly expected: string };

export type ViolationKind = Violation["kind"];

/** 结果中 kind 的先后，按 13.11 列举的顺序。 */
export const VIOLATION_KINDS: readonly ViolationKind[] = [
  "duplicate-name",
  "missing-name",
  "checklist-uncovered",
  "multiple-png",
  "no-png-no-reason",
  "orphan-png",
  "bad-size",
];

/** Run_Summary 中违规类型的写法（13.11）。 */
export const VIOLATION_LABELS: Readonly<Record<ViolationKind, string>> = {
  "duplicate-name": "Review_Catalog 重名",
  "missing-name": "Review_Catalog 缺少必需的名称",
  "checklist-uncovered": "Checklist 项未被任何 Review_Shot 覆盖",
  "multiple-png": "同一 Review_Shot 拍摄了多次",
  "no-png-no-reason": "没有 PNG 且未注明未拍摄原因",
  "orphan-png": "PNG 无法映射到 Review_Catalog 名称",
  "bad-size": "PNG 尺寸不符合 13.10",
};

/** 违规所指向的对象：名称、Checklist 项或文件名。 */
export function violationSubject(v: Violation): string {
  switch (v.kind) {
    case "checklist-uncovered":
      return v.item;
    case "orphan-png":
      return v.file;
    default:
      return v.name;
  }
}

/** Run_Summary 中一条违规的写法：`<类型>（<kind>）：<对象>[，细节]`。 */
export function describeViolation(v: Violation): string {
  const head = `${VIOLATION_LABELS[v.kind]}（${v.kind}）：${violationSubject(v)}`;
  switch (v.kind) {
    case "multiple-png":
      return `${head}，review-shot 附件 ${v.count} 条`;
    case "bad-size": {
      const actual = v.actual === null ? "读不出 PNG 头" : `${v.actual.width}×${v.actual.height}`;
      return `${head}，实际 ${actual}，应为 ${v.expected}`;
    }
    default:
      return head;
  }
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function hasOwn(record: Readonly<Record<string, string>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/**
 * 核对 catalog、附件与 `review` 目录的对应关系（13.10、13.11）。纯函数；结果先按
 * `VIOLATION_KINDS` 的顺序、再按对象（`violationSubject`）的 UTF-16 码元序排列。
 *
 * - `duplicate-name`：catalog 中出现 ≥ 2 次的名称，每个名称一条。
 * - `missing-name` / `checklist-uncovered`：`requiredNames` / `requiredChecklist` 中不被 catalog
 *   覆盖的项，每项一条。
 * - `multiple-png`：catalog 名称中 `captures` 多于 1 条的。
 * - `no-png-no-reason`：catalog 名称中既没有 `<名称>.png`、`uncaptured` 里也没有非空原因的。
 * - `orphan-png`：文件名不等于任何 catalog 名称的 `<名称>.png` 的 PNG（逐字比较，区分大小写）。
 * - `bad-size`：能映射到名称的 PNG 中，尺寸读不出或不符合该名称（重名时取第一个定义）的
 *   `viewport` 与 `scope` 的。
 */
export function checkReviewConsistency(input: ConsistencyInput): Violation[] {
  const violations: Violation[] = [];

  const defs = new Map<string, ReviewShotDef>();
  const nameCount = new Map<string, number>();
  for (const def of input.catalog) {
    nameCount.set(def.name, (nameCount.get(def.name) ?? 0) + 1);
    if (!defs.has(def.name)) defs.set(def.name, def);
  }
  for (const [name, count] of nameCount) {
    if (count > 1) violations.push({ kind: "duplicate-name", name });
  }

  for (const name of new Set(input.requiredNames)) {
    if (!defs.has(name)) violations.push({ kind: "missing-name", name });
  }

  const covered = new Set<string>(input.catalog.flatMap((def) => def.checklist));
  for (const item of new Set(input.requiredChecklist)) {
    if (!covered.has(item)) violations.push({ kind: "checklist-uncovered", item });
  }

  const captureCount = new Map<string, number>();
  for (const { name } of input.captures) captureCount.set(name, (captureCount.get(name) ?? 0) + 1);
  for (const name of defs.keys()) {
    const count = captureCount.get(name) ?? 0;
    if (count > 1) violations.push({ kind: "multiple-png", name, count });
  }

  const byFile = new Map<string, ReviewShotDef>();
  for (const def of defs.values()) byFile.set(reviewShotFileName(def.name), def);
  const present = new Set<string>();
  for (const png of input.pngs) {
    const def = byFile.get(png.file);
    if (def === undefined) {
      violations.push({ kind: "orphan-png", file: png.file });
      continue;
    }
    present.add(def.name);
    if (png.size === null) {
      violations.push({ kind: "bad-size", name: def.name, actual: null, expected: EXPECTED_PNG_IHDR });
    } else if (!shotSizeFits(def, png.size)) {
      violations.push({ kind: "bad-size", name: def.name, actual: png.size, expected: expectedShotSize(def) });
    }
  }

  for (const name of defs.keys()) {
    if (present.has(name)) continue;
    const reason = hasOwn(input.uncaptured, name) ? input.uncaptured[name] : "";
    if (reason.trim() === "") violations.push({ kind: "no-png-no-reason", name });
  }

  const rank = (v: Violation): number => VIOLATION_KINDS.indexOf(v.kind);
  return violations.sort(
    (a, b) => rank(a) - rank(b) || compareCodeUnits(violationSubject(a), violationSubject(b)),
  );
}

// ---------------------------------------------------------------------------
// Review_Report（13.3、13.4）
// ---------------------------------------------------------------------------

export interface ReviewReportMeta {
  /** 运行开始时间；与 `results.json` 的 `startedAt` 为同一字符串（验收阶段 7 比对）。 */
  readonly startedAt: string;
  /** 本次执行的 Library_Profile。 */
  readonly profiles: readonly LibraryProfile[];
  /** fixture 的 `roles.json`；取不到时为 null（元数据里按用途写出）。 */
  readonly roles: FixtureRoles | null;
}

/** 报告中固定的文字；属性 14 的测试与验收助手按这些前缀识别各行。 */
export const REPORT_TEXT = {
  title: "# Review_Report",
  startedAt: "- 运行开始时间：",
  profiles: "- 本次执行的 Library_Profile：",
  sectionHeading: "## ",
  status: "- 拍摄状态：",
  capturedStatus: "已拍摄",
  uncapturedStatus: "未拍摄",
  png: "- PNG：",
  reason: "- 未拍摄原因：",
  test: "- 用例：",
  result: "- 用例结果：",
  criteria: "准则：",
  noCriteria: "准则：无",
  /** 每条准则下的判定栏，已拍摄的节中每条准则恰好 1 行。 */
  verdict: "   - 判定：（待填：通过 / 不通过 / 无法判断）",
  basis: "   - 依据：（待填，不超过 200 字）",
} as const;

/** 13.3 的"用例的最终结果"。 */
export function describeCaseResult(result: CaseOutcome, timedOut: boolean): string {
  switch (result) {
    case "passed":
      return "通过";
    case "failed":
      return timedOut ? "失败（超时）" : "失败";
    case "expectedFail":
      return "预期失败";
    case "unexpectedPass":
      return "失败（意外通过）";
    case "skipped":
      return "跳过（拍摄之后）";
    case "notRun":
      return "未完成（运行被中断）";
  }
}

/** 报告的一行里不允许换行。 */
function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, " ");
}

/**
 * CommonMark 链接文本（图片的替代文本）的反斜杠转义（RDF 16.3）：`\`、`[`、`]` 前各加 `\`。
 * 转义后没有未转义的方括号，替代文本不会提前结束，也不会与名称里的 `[` 配对；原有的 `\` 先成为
 * `\\`，不会与其后的标点组成转义。按 CommonMark 反解（`\` 后跟 ASCII 标点即该标点）后得回原文。
 * 调用方先经 `oneLine` 去掉换行。
 */
export function escapeLinkText(s: string): string {
  return s.replace(/[\\[\]]/g, "\\$&");
}

/**
 * CommonMark 尖括号形式的链接目标（RDF 16.3）：`\`、`<`、`>` 前各加 `\`，整体以 `<` `>` 包裹。
 * 尖括号形式允许空格与圆括号，只要求其中没有换行（调用方先经 `oneLine`）与未转义的 `<`、`>`。
 * 按 CommonMark 反解后，`<` `>` 之间得回原文。
 */
export function escapeLinkDestination(s: string): string {
  return `<${s.replace(/[\\<>]/g, "\\$&")}>`;
}

function statusOf(def: ReviewShotDef, statuses: ReadonlyMap<string, ShotStatus>): ShotStatus {
  return statuses.get(def.name) ?? { captured: false, test: formatShotTest(def.by), reason: null };
}

function reasonText(status: Extract<ShotStatus, { captured: false }>): string {
  return status.reason === null ? UNKNOWN_UNCAPTURED_REASON : describeUncapturedReason(status.reason);
}

function describeProfiles(profiles: readonly LibraryProfile[]): string {
  return profiles.length > 0 ? profiles.join("、") : "无";
}

function renderSection(def: ReviewShotDef, status: ShotStatus, roles: FixtureRoles | null): string[] {
  const lines: string[] = [`${REPORT_TEXT.sectionHeading}${oneLine(def.name)}`, ""];
  if (status.captured) {
    lines.push(`${REPORT_TEXT.status}${REPORT_TEXT.capturedStatus}`);
    const alt = escapeLinkText(oneLine(def.name));
    const destination = escapeLinkDestination(oneLine(reviewShotFileName(def.name)));
    lines.push(`${REPORT_TEXT.png}![${alt}](${destination})`);
  } else {
    lines.push(`${REPORT_TEXT.status}${REPORT_TEXT.uncapturedStatus}`);
    lines.push(`${REPORT_TEXT.reason}${oneLine(reasonText(status))}`);
  }
  for (const { label, value } of shotMetadata(def, roles)) lines.push(`- ${label}：${oneLine(value)}`);
  lines.push(`${REPORT_TEXT.test}${oneLine(status.test)}`);
  if (!status.captured) return lines;

  lines.push(`${REPORT_TEXT.result}${describeCaseResult(status.result, status.timedOut)}`, "");
  if (def.criteria.length === 0) {
    lines.push(REPORT_TEXT.noCriteria);
    return lines;
  }
  lines.push(REPORT_TEXT.criteria, "");
  def.criteria.forEach((criterion, i) => {
    lines.push(`${i + 1}. ${oneLine(criterion)}`, REPORT_TEXT.verdict, REPORT_TEXT.basis);
  });
  return lines;
}

/**
 * Review_Report 的 Markdown（13.3、13.4）。按 catalog 顺序每个条目恰好一节（重名的条目各占一节）；
 * `statuses` 中没有的名称按未拍摄、原因不明处理。
 */
export function renderReviewReport(
  catalog: readonly ReviewShotDef[],
  statuses: ReadonlyMap<string, ShotStatus>,
  meta: ReviewReportMeta,
): string {
  const captured = catalog.filter((def) => statusOf(def, statuses).captured).length;
  const lines: string[] = [
    REPORT_TEXT.title,
    "",
    `${REPORT_TEXT.startedAt}${oneLine(meta.startedAt)}`,
    `${REPORT_TEXT.profiles}${describeProfiles(meta.profiles)}`,
    `- Review_Shot：${catalog.length} 张（已拍摄 ${captured} 张，未拍摄 ${catalog.length - captured} 张）`,
  ];
  for (const def of catalog) {
    lines.push("", ...renderSection(def, statusOf(def, statuses), meta.roles));
  }
  return `${lines.join("\n")}\n`;
}

/** `review-report.json` 的一项：每张 Review_Shot 的拍摄状态与准则数。 */
export interface ReviewReportShot {
  readonly name: string;
  readonly rs: string;
  readonly profile: LibraryProfile;
  readonly captured: boolean;
  /** 相对报告的 PNG 路径；未拍摄为 null。 */
  readonly png: string | null;
  readonly test: string;
  /** 已拍摄时拍摄用例的最终结果；未拍摄为 null。 */
  readonly result: CaseOutcome | null;
  /** 未拍摄的原因文字；已拍摄为 null。 */
  readonly reason: string | null;
  readonly criteria: number;
}

export interface ReviewReportData {
  readonly startedAt: string;
  readonly profiles: readonly LibraryProfile[];
  readonly shots: readonly ReviewReportShot[];
}

/** `review-report.json` 的内容，与 `renderReviewReport` 同一口径、同一顺序。 */
export function reviewReportData(
  catalog: readonly ReviewShotDef[],
  statuses: ReadonlyMap<string, ShotStatus>,
  meta: ReviewReportMeta,
): ReviewReportData {
  const shots = catalog.map((def): ReviewReportShot => {
    const status = statusOf(def, statuses);
    const base = { name: def.name, rs: def.rs, profile: def.profile, test: status.test, criteria: def.criteria.length };
    return status.captured
      ? { ...base, captured: true, png: reviewShotFileName(def.name), result: status.result, reason: null }
      : { ...base, captured: false, png: null, result: null, reason: reasonText(status) };
  });
  return { startedAt: meta.startedAt, profiles: [...meta.profiles], shots };
}
