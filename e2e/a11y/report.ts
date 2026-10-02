/**
 * Run_Summary 第 11 节"A11y_Scan"的整理与渲染（需求 15.4、15.5、15.9；设计"无障碍冒烟
 * （需求 15）"的最后一段；任务 20.5。节点明细：reader-defect-fixes（RDF）需求 15.3、15.4，
 * 任务 6.1）。另有违规时的用例失败信息 `formatA11yViolations`（RDF 15.2，任务 17.1）。
 *
 * ## 节点明细
 *
 * 违规在规则表之后逐条规则列出节点明细表：每个节点的 `target`、`html`（`summarizeAxe` 已截到
 * 200 字符以内）、`failureSummary`，`color-contrast` 另列前景色、背景色、实测与要求的对比度、
 * 字号与字重（RDF 15.4）。incomplete 仍只列规则 id 与节点数，明细只在结果文件中（RDF 15.3）。
 *
 * 本文件全是纯函数：不读写文件、不访问网络、不修改参数。reporter（`support/reporter.ts`）把
 * `A11Y_SCANS` 与本次的 `CaseFacts` 交给 `buildA11ySection`，再把 `renderA11ySection` 的结果作为
 * 该节正文，`A11ySectionData` 随 `results.json` 写出。
 *
 * ## 数据来源
 *
 * 只取本次运行结果上的 `a11y-result` 附件（`scan.ts` 附上，body 为 `A11yScanResult` 的 JSON），
 * **不**读 `e2e/.out/a11y/`：globalSetup 不清空该目录，上一次运行留下的文件会混进本次的结果。
 *
 * - 附件按其中的扫描名归到 `A11Y_SCANS` 的定义。同一扫描名出现多次时取第一份（按用例顺序、附件
 *   顺序），其余与无法解析、扫描名不在定义中、视图或主题与定义不符的附件一起记为附件问题。
 * - 违规的"待记入 Findings_Log"按影响级别重新判定（`isFlaggedImpact`，15.5），不采信附件里的
 *   `flagged`，两者不一致时以影响级别为准。
 *
 * ## 没有有效附件的扫描
 *
 * 按对应用例（`a11y.spec.ts` 中自身标题等于 `a11yTestTitle(def)` 的用例）的结果写明，任何一种都
 * **不**写成"违规数 0"（15.9）：
 *
 * - 本次未收集该用例（如以文件参数或 `-g` 只选了部分用例）→ 未执行；
 * - 用例没有结果或被中断 → 未执行；
 * - 用例跳过 → 跳过，附跳过原因；
 * - 其余（失败、超时、通过却没有附件、附件无法解析）→ 扫描失败，附原因。
 *
 * ## 判定与退出码（RDF 15.2、15.3）
 *
 * 本文件只整理与渲染，结果不参与退出码与用例结果。违规的阻断在用例里：`a11y.spec.ts` 在
 * `runA11yScan` 返回 `ok` 后断言违规为空，失败信息由 `formatA11yViolations` 生成；用例失败再经
 * `summary.ts` 的 `exitCode` 使退出码为 1。这取代 EV 1.7、15.8 中 A11y_Scan 违规不影响用例结果与
 * 退出码的规定。incomplete 只列出，不使用例失败。
 */
import { repoRelative } from "../support/library";
import { A11Y_TAGS, VIEWPORTS } from "../support/settings";
import {
  OUTCOME_LABELS,
  TITLE_SEPARATOR,
  UNSPECIFIED_SKIP_REASON,
  mdCell,
  mdCode,
  mdOneLine,
  mdTableRow,
  toCaseRow,
  type CaseFacts,
  type CaseOutcome,
} from "../support/summary";
import { THEME_KEYS, THEME_UNSET, describeTheme, type DeclaredTheme } from "../support/theme";
import {
  A11Y_RESULT_ATTACHMENT,
  A11Y_VIEW_LABELS,
  COLOR_CONTRAST_RULE,
  a11yTestTitle,
  describeA11yScan,
  type A11yRules,
  type A11yScanDef,
} from "./scans";
import {
  FINDINGS_FLAG_LABEL,
  HTML_MAX_LENGTH,
  IMPACTS,
  isFlaggedImpact,
  type A11yContrastData,
  type A11yIncomplete,
  type A11yNodeDetail,
  type A11yScanResult,
  type A11yView,
  type A11yViolation,
  type Impact,
} from "./summarize";

/** A11y_Scan 的用例文件（相对仓库根，15.1：只在 fixture）。 */
export const A11Y_SPEC_FILE = "e2e/tests/fixture/a11y.spec.ts";

/** 扫描定义所在的文件（summary 中注明）。 */
const SCANS_FILE = "e2e/a11y/scans.ts";

/** 结果文件（`scans.ts` 的 `a11yResultFile`，相对仓库根；summary 中注明 incomplete 明细所在）。 */
const RESULT_FILE_PATTERN = "e2e/.out/a11y/<name>.json";

// ---------------------------------------------------------------------------
// 模型
// ---------------------------------------------------------------------------

/** 一次扫描在本次运行中的结果。 */
export type A11yEntryResult =
  /** 扫描完成：违规与 incomplete 取自附件。 */
  | { kind: "ok"; violations: A11yViolation[]; incomplete: A11yIncomplete[]; axeVersion: string }
  /** 15.9：扫描失败（附件的 `failed`，或用例未能留下有效附件）。 */
  | { kind: "failed"; reason: string }
  /** 16.4 等：跳过。 */
  | { kind: "skipped"; reason: string }
  /** 未收集或未执行。 */
  | { kind: "notRun"; reason: string };

export type A11yEntryKind = A11yEntryResult["kind"];

/** 对应用例的结果。 */
export interface A11yCaseRef {
  /** 相对仓库根。 */
  file: string;
  /** 文件内的标题路径（以 `TITLE_SEPARATOR` 连接）。 */
  title: string;
  project: string;
  outcome: CaseOutcome;
  timedOut: boolean;
}

/** A11y_Scan 节中的一节（15.4），按 `A11Y_SCANS` 的顺序。 */
export interface A11yEntry {
  name: string;
  /** 节名：视图与主题（`describeA11yScan`）。 */
  heading: string;
  view: A11yView;
  theme: DeclaredTheme;
  rules: A11yRules;
  /** 对应的用例；未收集时为 null。 */
  test: A11yCaseRef | null;
  result: A11yEntryResult;
}

/** "A11y_Scan"一节的数据（随 `results.json` 写出）。 */
export interface A11ySectionData {
  specFile: string;
  /** 15.3 的标签清单（`A11Y_TAGS`）。 */
  tags: string[];
  /** 本次收集到的 `a11y.spec.ts` 用例数。 */
  collected: number;
  /** 完成的扫描报告的 axe-core 版本，去重、按首次出现的顺序。 */
  axeVersions: string[];
  entries: A11yEntry[];
  /** 附件问题，逐条写入该节末尾。 */
  problems: string[];
}

// ---------------------------------------------------------------------------
// 附件解析
// ---------------------------------------------------------------------------

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const VIEWS: readonly A11yView[] = ["shelf", "detail", "reader", "toc", "search", "settings"];
const THEMES: readonly DeclaredTheme[] = [THEME_UNSET, ...THEME_KEYS];
const STATUSES: readonly A11yScanResult["status"][] = ["ok", "failed", "skipped"];

const decoder = new TextDecoder();

function bodyText(body: string | Uint8Array | undefined): string | undefined {
  if (body === undefined) return undefined;
  return typeof body === "string" ? body : decoder.decode(body);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<T>(list: readonly T[], value: unknown): value is T {
  return (list as readonly unknown[]).includes(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** `A11yContrastData` 的字符串字段（`contrastRatio` 另行核对）。 */
const CONTRAST_STRING_FIELDS = ["fgColor", "bgColor", "expectedContrastRatio", "fontSize", "fontWeight"] as const;

/** 解析一个节点明细（`A11yNodeDetail`）；只保留已知字段。`where` 为错误信息中的位置，如 `violations[0].details[3]`。 */
function parseNodeDetail(raw: unknown, where: string): Parsed<A11yNodeDetail> {
  if (!isRecord(raw)) return { ok: false, error: `${where} 不是对象` };
  const { target, html, failureSummary, contrast } = raw;
  if (!Array.isArray(target) || !target.every((t) => typeof t === "string")) {
    return { ok: false, error: `${where}.target 不是字符串数组` };
  }
  if (typeof html !== "string") return { ok: false, error: `${where}.html 不是字符串` };
  if (typeof failureSummary !== "string") return { ok: false, error: `${where}.failureSummary 不是字符串` };
  const detail: A11yNodeDetail = { target: [...target], html, failureSummary };
  if (contrast !== undefined) {
    if (!isRecord(contrast)) return { ok: false, error: `${where}.contrast 不是对象` };
    for (const key of CONTRAST_STRING_FIELDS) {
      if (typeof contrast[key] !== "string") return { ok: false, error: `${where}.contrast.${key} 不是字符串` };
    }
    const { contrastRatio } = contrast;
    if (typeof contrastRatio !== "number" || !Number.isFinite(contrastRatio)) {
      return { ok: false, error: `${where}.contrast.contrastRatio 不是有限数` };
    }
    const c = contrast as Record<(typeof CONTRAST_STRING_FIELDS)[number], string>;
    const data: A11yContrastData = {
      fgColor: c.fgColor,
      bgColor: c.bgColor,
      contrastRatio,
      expectedContrastRatio: c.expectedContrastRatio,
      fontSize: c.fontSize,
      fontWeight: c.fontWeight,
    };
    detail.contrast = data;
  }
  return { ok: true, value: detail };
}

/** 解析一条规则的 `details`：须为数组，长度等于该规则的 `nodes`（RDF 15.4：与节点逐一对应）。 */
function parseDetails(raw: unknown, where: string, nodes: number): Parsed<A11yNodeDetail[]> {
  if (!Array.isArray(raw)) return { ok: false, error: `${where}.details 不是数组` };
  if (raw.length !== nodes) {
    return { ok: false, error: `${where}.details 有 ${raw.length} 项，与 nodes（${nodes}）不符` };
  }
  const details: A11yNodeDetail[] = [];
  for (const [j, item] of raw.entries()) {
    const parsed = parseNodeDetail(item, `${where}.details[${j}]`);
    if (!parsed.ok) return parsed;
    details.push(parsed.value);
  }
  return { ok: true, value: details };
}

/**
 * 解析 `a11y-result` 附件的正文（`A11yScanResult`）；格式不符时给出原因，从不抛错。
 * 违规的 `flagged` 按影响级别重新判定（15.5）。违规与 incomplete 的每条规则须带 `details`，
 * 长度等于 `nodes`（RDF 15.4）。
 */
export function parseA11yResult(text: string): Parsed<A11yScanResult> {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `不是有效的 JSON（${error instanceof Error ? error.message : String(error)}）` };
  }
  if (!isRecord(data)) return { ok: false, error: "不是 JSON 对象" };
  const { name, view, theme, status, reason, violations, incomplete, axeVersion } = data;
  if (typeof name !== "string" || name === "") return { ok: false, error: "name 不是非空字符串" };
  if (!isOneOf(VIEWS, view)) return { ok: false, error: `view 不是 ${VIEWS.join("、")} 之一：${JSON.stringify(view)}` };
  if (!isOneOf(THEMES, theme)) return { ok: false, error: `theme 不是 ${THEMES.join("、")} 之一：${JSON.stringify(theme)}` };
  if (!isOneOf(STATUSES, status)) {
    return { ok: false, error: `status 不是 ${STATUSES.join("、")} 之一：${JSON.stringify(status)}` };
  }
  if (reason !== undefined && typeof reason !== "string") return { ok: false, error: "reason 不是字符串" };
  if (typeof axeVersion !== "string") return { ok: false, error: "axeVersion 不是字符串" };
  if (!Array.isArray(violations)) return { ok: false, error: "violations 不是数组" };
  if (!Array.isArray(incomplete)) return { ok: false, error: "incomplete 不是数组" };

  const vs: A11yViolation[] = [];
  for (const [i, raw] of violations.entries()) {
    if (!isRecord(raw)) return { ok: false, error: `violations[${i}] 不是对象` };
    const { id, impact, nodes } = raw;
    if (typeof id !== "string") return { ok: false, error: `violations[${i}].id 不是字符串` };
    let level: Impact | null;
    if (impact === null) level = null;
    else if (isOneOf(IMPACTS, impact)) level = impact;
    else {
      return { ok: false, error: `violations[${i}].impact 不是 ${IMPACTS.join("、")} 或 null：${JSON.stringify(impact)}` };
    }
    if (!isCount(nodes)) return { ok: false, error: `violations[${i}].nodes 不是非负整数` };
    const details = parseDetails(raw.details, `violations[${i}]`, nodes);
    if (!details.ok) return details;
    vs.push({ id, impact: level, nodes, flagged: isFlaggedImpact(level), details: details.value });
  }
  const inc: A11yIncomplete[] = [];
  for (const [i, raw] of incomplete.entries()) {
    if (!isRecord(raw)) return { ok: false, error: `incomplete[${i}] 不是对象` };
    const { id, nodes } = raw;
    if (typeof id !== "string") return { ok: false, error: `incomplete[${i}].id 不是字符串` };
    if (!isCount(nodes)) return { ok: false, error: `incomplete[${i}].nodes 不是非负整数` };
    const details = parseDetails(raw.details, `incomplete[${i}]`, nodes);
    if (!details.ok) return details;
    inc.push({ id, nodes, details: details.value });
  }

  const result: A11yScanResult = { name, view, theme, status, violations: vs, incomplete: inc, axeVersion };
  if (reason !== undefined) result.reason = reason;
  return { ok: true, value: result };
}

// ---------------------------------------------------------------------------
// 整理
// ---------------------------------------------------------------------------

/** 用例是否属于 A11y_Scan 的用例文件（按文件识别）。 */
export function isA11yCase(f: CaseFacts): boolean {
  return repoRelative(f.file) === A11Y_SPEC_FILE;
}

function ownTitle(f: CaseFacts): string {
  return f.titlePath[f.titlePath.length - 1] ?? "";
}

function caseLabel(f: CaseFacts): string {
  return [repoRelative(f.file), ...f.titlePath].join(TITLE_SEPARATOR);
}

function caseRef(f: CaseFacts): A11yCaseRef {
  const row = toCaseRow(f);
  return { file: row.file, title: row.title, project: row.project, outcome: row.outcome, timedOut: row.timedOut === true };
}

function outcomeText(outcome: CaseOutcome, timedOut: boolean): string {
  return outcome === "failed" && timedOut ? `${OUTCOME_LABELS.failed}（超时）` : OUTCOME_LABELS[outcome];
}

function fromAttachment(r: A11yScanResult): A11yEntryResult {
  switch (r.status) {
    case "ok":
      return { kind: "ok", violations: r.violations, incomplete: r.incomplete, axeVersion: r.axeVersion };
    case "failed":
      return { kind: "failed", reason: r.reason ?? "未注明失败原因" };
    case "skipped":
      return { kind: "skipped", reason: r.reason ?? UNSPECIFIED_SKIP_REASON };
  }
}

/** 用例没有留下有效附件时的结果（见文件头）。`attachmentProblem` 为该用例附件无法读取或解析的原因。 */
function withoutAttachment(f: CaseFacts, attachmentProblem: string | undefined): A11yEntryResult {
  const row = toCaseRow(f);
  switch (row.outcome) {
    case "notRun":
      return { kind: "notRun", reason: "用例未执行完（运行被中断，或未轮到执行）" };
    case "skipped":
      return { kind: "skipped", reason: row.skip?.reason ?? UNSPECIFIED_SKIP_REASON };
    default: {
      const detail = attachmentProblem ?? `没有 ${A11Y_RESULT_ATTACHMENT} 附件`;
      const error = row.outcome === "passed" || row.errorLine === undefined ? "" : `：${row.errorLine}`;
      return { kind: "failed", reason: `${detail}；用例${outcomeText(row.outcome, row.timedOut === true)}${error}` };
    }
  }
}

/**
 * 由扫描定义（按 `A11Y_SCANS` 的顺序）与本次全部用例的 `CaseFacts` 整理"A11y_Scan"一节的数据。
 * 见文件头的规则。
 */
export function buildA11ySection(defs: readonly A11yScanDef[], cases: readonly CaseFacts[]): A11ySectionData {
  const known = new Map<string, A11yScanDef>(defs.map((d) => [d.name, d]));
  const adopted = new Map<string, { result: A11yScanResult; facts: CaseFacts }>();
  const byTitle = new Map<string, CaseFacts[]>();
  const unreadable = new Map<string, string>();
  const problems: string[] = [];
  let collected = 0;

  for (const f of cases) {
    if (isA11yCase(f)) {
      collected += 1;
      byTitle.set(ownTitle(f), [...(byTitle.get(ownTitle(f)) ?? []), f]);
    }
    const label = caseLabel(f);
    for (const a of f.result?.attachments ?? []) {
      if (a.name !== A11Y_RESULT_ATTACHMENT) continue;
      const text = bodyText(a.body);
      if (text === undefined) {
        const detail = `${A11Y_RESULT_ATTACHMENT} 附件没有正文${a.path === undefined ? "" : `，文件 ${repoRelative(a.path)} 未能读取`}`;
        if (!unreadable.has(f.id)) unreadable.set(f.id, detail);
        problems.push(`${label}：${detail}`);
        continue;
      }
      const parsed = parseA11yResult(text);
      if (!parsed.ok) {
        const detail = `${A11Y_RESULT_ATTACHMENT} 附件无法解析：${parsed.error}`;
        if (!unreadable.has(f.id)) unreadable.set(f.id, detail);
        problems.push(`${label}：${detail}`);
        continue;
      }
      const r = parsed.value;
      const def = known.get(r.name);
      if (def === undefined) {
        problems.push(`${label}：${A11Y_RESULT_ATTACHMENT} 附件的扫描名 ${r.name} 不在 A11Y_SCANS 中，未采用`);
        continue;
      }
      if (adopted.has(r.name)) {
        problems.push(`${label}：${r.name} 的结果已由之前的 ${A11Y_RESULT_ATTACHMENT} 附件给出，本份未采用`);
        continue;
      }
      if (r.view !== def.view || r.theme !== def.theme) {
        problems.push(
          `${label}：${r.name} 的附件记录的视图与主题为 ${r.view}、${r.theme}，与定义的 ${def.view}、${def.theme} 不符`,
        );
      }
      adopted.set(r.name, { result: r, facts: f });
    }
  }

  const entries = defs.map((def): A11yEntry => {
    const base = { name: def.name, heading: describeA11yScan(def), view: def.view, theme: def.theme, rules: def.rules };
    const hit = adopted.get(def.name);
    if (hit !== undefined) return { ...base, test: caseRef(hit.facts), result: fromAttachment(hit.result) };
    const own = byTitle.get(a11yTestTitle(def)) ?? [];
    if (own.length > 1) problems.push(`${def.name}：${own.length} 个用例的标题相同，只采用第一个的结果`);
    const f = own[0];
    if (f === undefined) {
      return { ...base, test: null, result: { kind: "notRun", reason: "本次运行未收集该扫描的用例" } };
    }
    return { ...base, test: caseRef(f), result: withoutAttachment(f, unreadable.get(f.id)) };
  });

  const axeVersions: string[] = [];
  for (const e of entries) {
    if (e.result.kind === "ok" && e.result.axeVersion !== "" && !axeVersions.includes(e.result.axeVersion)) {
      axeVersions.push(e.result.axeVersion);
    }
  }

  return { specFile: A11Y_SPEC_FILE, tags: [...A11Y_TAGS], collected, axeVersions, entries, problems };
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

/** 各类结果在 summary 中的写法。 */
export const A11Y_RESULT_LABELS: Readonly<Record<A11yEntryKind, string>> = {
  ok: "完成",
  failed: "扫描失败",
  skipped: "跳过",
  notRun: "未执行",
};

const RESULT_KINDS: readonly A11yEntryKind[] = ["ok", "failed", "skipped", "notRun"];

/** 没有 axe 结果的扫描的"违规数"写法：不写 0（15.9）。 */
export const NO_RESULT_TEXT = "没有结果";

/** 影响级别缺失时的写法。 */
const IMPACT_MISSING = "未给出";

/** 标记列中不需标记的写法。 */
const NO_FLAG = "—";

type OkResult = Extract<A11yEntryResult, { kind: "ok" }>;

function okResults(d: A11ySectionData): OkResult[] {
  return d.entries.flatMap((e) => (e.result.kind === "ok" ? [e.result] : []));
}

function countsText(d: A11ySectionData): string {
  const count = (k: A11yEntryKind): number => d.entries.filter((e) => e.result.kind === k).length;
  return `${RESULT_KINDS.map((k) => `${A11Y_RESULT_LABELS[k]} ${count(k)}`).join("、")}（共 ${d.entries.length} 次）`;
}

function caseLine(e: A11yEntry): string {
  if (e.test === null) return "- 用例：本次运行未收集";
  const project = e.test.project === "fixture" ? "" : `（项目 ${e.test.project}）`;
  return `- 用例结果：${outcomeText(e.test.outcome, e.test.timedOut)}${project}`;
}

function violationRow(v: A11yViolation): string {
  return mdTableRow([
    mdCell(mdCode(v.id)),
    v.impact ?? IMPACT_MISSING,
    String(v.nodes),
    v.flagged ? FINDINGS_FLAG_LABEL : NO_FLAG,
  ]);
}

function incompleteRow(i: A11yIncomplete): string {
  return mdTableRow([mdCell(mdCode(i.id)), String(i.nodes)]);
}

/** 节点明细中空字段的写法（空串写成行内代码会是两个孤立的反引号）。 */
const EMPTY_FIELD = "—";

/** 跨 frame 的 `target`（多项）之间的连接写法；每项各自是一段行内代码。 */
const TARGET_SEPARATOR = " → ";

/** 节点明细表的列（RDF 15.3、15.4）。 */
export const NODE_DETAIL_COLUMNS = ["节点", "target", "html", "failureSummary"] as const;

/** 对比度数据的列（RDF 15.4），只在该规则至少一个节点带对比度数据时出现。 */
export const CONTRAST_COLUMNS = ["前景色", "背景色", "实测对比度", "要求的对比度", "字号", "字重"] as const;

/** 右对齐的数值列。 */
const NUMERIC_DETAIL_COLUMNS: ReadonlySet<string> = new Set(["节点", "实测对比度"]);

/** 写成表格单元格的行内代码；空串写 `EMPTY_FIELD`。 */
function codeCell(text: string): string {
  return text === "" ? EMPTY_FIELD : mdCell(mdCode(text));
}

/** 写成表格单元格的普通文字；空串写 `EMPTY_FIELD`。 */
function textCell(text: string): string {
  return text === "" ? EMPTY_FIELD : mdCell(text);
}

function targetCell(target: readonly string[]): string {
  const parts = target.filter((t) => t !== "");
  return parts.length === 0 ? EMPTY_FIELD : parts.map((t) => mdCell(mdCode(t))).join(TARGET_SEPARATOR);
}

function contrastCells(c: A11yContrastData | undefined): string[] {
  if (c === undefined) return CONTRAST_COLUMNS.map(() => EMPTY_FIELD);
  return [
    textCell(c.fgColor),
    textCell(c.bgColor),
    String(c.contrastRatio),
    textCell(c.expectedContrastRatio),
    textCell(c.fontSize),
    textCell(c.fontWeight),
  ];
}

/**
 * 一条违规规则的节点明细（RDF 15.3、15.4）：一行说明，再接一张表，每个节点一行，按 axe 的节点顺序。
 * 该规则任一节点带对比度数据（`color-contrast`）时表格另加 `CONTRAST_COLUMNS`，没有数据的节点
 * 在这几列写 `EMPTY_FIELD`。`failureSummary` 中的换行折成空格。
 */
function violationDetailLines(v: A11yViolation): string[] {
  const head = `- 违规 ${mdCode(v.id)}（${v.impact ?? IMPACT_MISSING}）的节点明细`;
  if (v.details.length === 0) return [`${head}：没有节点`];
  const withContrast = v.details.some((d) => d.contrast !== undefined);
  const columns: string[] = [...NODE_DETAIL_COLUMNS, ...(withContrast ? CONTRAST_COLUMNS : [])];
  const align = columns.map((c) => (NUMERIC_DETAIL_COLUMNS.has(c) ? "---:" : "---"));
  const rows = v.details.map((d, i) =>
    mdTableRow([
      String(i + 1),
      targetCell(d.target),
      codeCell(d.html),
      codeCell(d.failureSummary),
      ...(withContrast ? contrastCells(d.contrast) : []),
    ]),
  );
  return [`${head}，共 ${v.details.length} 个：`, "", mdTableRow(columns), mdTableRow(align), ...rows];
}

function okLines(r: OkResult): string[] {
  const lines = [`- 违规数：${r.violations.length}`];
  if (r.violations.length > 0) {
    lines.push(
      "",
      mdTableRow(["规则 id", "影响级别", "节点数", "标记"]),
      mdTableRow(["---", "---", "---:", "---"]),
      ...r.violations.map(violationRow),
      "",
    );
    // RDF 15.3、15.4：违规逐条规则列出节点明细；incomplete 不列（明细只在结果文件中）
    for (const v of r.violations) lines.push(...violationDetailLines(v), "");
  }
  lines.push(`- incomplete（axe 判为需人工复核）：${r.incomplete.length}`);
  if (r.incomplete.length > 0) {
    lines.push("", mdTableRow(["规则 id", "节点数"]), mdTableRow(["---", "---:"]), ...r.incomplete.map(incompleteRow));
  }
  return lines;
}

function entryLines(e: A11yEntry): string[] {
  const r = e.result;
  const head = `- 扫描：${mdCode(e.name)}；结果：${A11Y_RESULT_LABELS[r.kind]}`;
  switch (r.kind) {
    case "ok":
      return [head, caseLine(e), ...okLines(r)];
    case "failed":
      return [
        head,
        `- 视图：${A11Y_VIEW_LABELS[e.view]}；主题：${describeTheme(e.theme)}`,
        `- 失败原因：${mdOneLine(r.reason)}`,
        caseLine(e),
        `- 违规数：${NO_RESULT_TEXT}（扫描失败，不计为 0）`,
      ];
    case "skipped":
      return [head, `- 跳过原因：${mdOneLine(r.reason)}`, caseLine(e), `- 违规数：${NO_RESULT_TEXT}（跳过）`];
    case "notRun":
      return [head, `- 原因：${mdOneLine(r.reason)}`, `- 违规数：${NO_RESULT_TEXT}（未执行）`];
  }
}

/** "A11y_Scan"一节的 Markdown 正文（不含节标题）。只读数据，不做判定。 */
export function renderA11ySection(d: A11ySectionData): string[] {
  const { width, height } = VIEWPORTS.desktop;
  const views = d.entries.filter((e) => e.rules !== COLOR_CONTRAST_RULE).length;
  const contrast = d.entries.length - views;
  const ok = okResults(d);
  const violations = ok.flatMap((r) => r.violations);
  const flagged = violations.filter((v) => v.flagged).length;
  const incomplete = ok.reduce((n, r) => n + r.incomplete.length, 0);
  const collected =
    d.collected === 0 ? `本次运行未收集 ${mdCode(d.specFile)} 的用例` : `${mdCode(d.specFile)} 收集 ${d.collected} 个`;

  const lines = [
    `- 扫描：${d.entries.length} 次，定义见 ${mdCode(SCANS_FILE)} 的 ${mdCode("A11Y_SCANS")}，下面按其顺序逐节列出（15.4）`,
    `- 条件（15.1、15.7）：fixture、桌面视口 ${width}×${height}、Opaque_Mode，扫描整页；` +
      "prefers-reduced-motion: reduce，CSS 动画与过渡已禁用",
    `- 规则（15.2、15.3）：${views} 个视图只启用 ${d.tags.map(mdCode).join("、")} 标签下的规则；` +
      `${contrast} 次对比度扫描只运行 ${mdCode(COLOR_CONTRAST_RULE)}`,
    `- axe-core：${d.axeVersions.length > 0 ? d.axeVersions.join("、") : "未知（没有完成的扫描）"}`,
    `- 用例：${collected}`,
    `- 结果：${countsText(d)}`,
    `- 违规：完成的扫描共报出 ${violations.length} 条违规规则，其中 critical 或 serious ${flagged} 条，` +
      `标"${FINDINGS_FLAG_LABEL}"（15.5）；incomplete ${incomplete} 条规则`,
    `- 节点明细（RDF 15.3、15.4）：违规逐条规则列出每个节点的 target、html（至多 ${HTML_MAX_LENGTH} 字符）与 ` +
      `failureSummary，${mdCode(COLOR_CONTRAST_RULE)} 另列前景色、背景色、实测与要求的对比度、字号与字重；` +
      `incomplete 只列规则 id 与节点数，节点明细只写在结果文件 ${mdCode(RESULT_FILE_PATTERN)} 中`,
    "- 判定（RDF 15.2、15.3）：任一违规即判该扫描的用例失败，失败信息列出规则 id、影响级别与节点明细；" +
      "incomplete 只列出，不使用例失败；扫描失败、跳过与未执行的扫描" +
      `没有 axe 结果，违规数写"${NO_RESULT_TEXT}"，不计为 0（15.9）`,
  ];

  d.entries.forEach((e, i) => {
    lines.push("", `### ${i + 1}. ${mdOneLine(e.heading)}`, "", ...entryLines(e));
  });

  if (d.problems.length > 0) {
    lines.push("", "### 附件问题", "", ...d.problems.map((p) => `- ${mdOneLine(p)}`));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// 用例失败信息（RDF 15.2）
// ---------------------------------------------------------------------------

/** 失败信息中节点字段的缩进（规则行为 0 格，节点行 3 格，字段行 5 格，字段续行 7 格）。 */
const NODE_INDENT = "   ";
const FIELD_INDENT = "     ";
const FIELD_CONTINUATION_INDENT = "       ";

/** 折成一行：含换行的空白段换成一个空格，两端去空白。 */
function plainOneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, " ").trim();
}

/** 纯文本字段值：空串写 `EMPTY_FIELD`。 */
function plainField(text: string): string {
  return text === "" ? EMPTY_FIELD : text;
}

function plainTarget(target: readonly string[]): string {
  const parts = target.filter((t) => t !== "");
  return parts.length === 0 ? EMPTY_FIELD : parts.join(TARGET_SEPARATOR);
}

/** `failureSummary` 保留 axe 的分行：首行接在字段名之后，其余非空行各占一行、缩进 7 格。 */
function failureSummaryLines(summary: string): string[] {
  const [first, ...rest] = summary
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
  if (first === undefined) return [`${FIELD_INDENT}failureSummary：${EMPTY_FIELD}`];
  return [`${FIELD_INDENT}failureSummary：${first}`, ...rest.map((l) => `${FIELD_CONTINUATION_INDENT}${l}`)];
}

function contrastLine(c: A11yContrastData): string {
  const fields: [string, string][] = [
    ["前景色", plainField(c.fgColor)],
    ["背景色", plainField(c.bgColor)],
    ["实测对比度", String(c.contrastRatio)],
    ["要求的对比度", plainField(c.expectedContrastRatio)],
    ["字号", plainField(c.fontSize)],
    ["字重", plainField(c.fontWeight)],
  ];
  return `${FIELD_INDENT}对比度：${fields.map(([k, v]) => `${k} ${v}`).join("；")}`;
}

function nodeLines(d: A11yNodeDetail, index: number, total: number): string[] {
  return [
    `${NODE_INDENT}节点 ${index + 1}/${total}`,
    `${FIELD_INDENT}target：${plainTarget(d.target)}`,
    `${FIELD_INDENT}html：${plainField(plainOneLine(d.html))}`,
    ...failureSummaryLines(d.failureSummary),
    ...(d.contrast === undefined ? [] : [contrastLine(d.contrast)]),
  ];
}

function ruleSummary(v: A11yViolation): string {
  return `${v.id}（${v.impact ?? IMPACT_MISSING}，${v.nodes} 个节点）`;
}

/**
 * RDF 15.2：扫描报出违规时 `a11y.spec.ts` 断言失败所用的说明（纯文本，不是 Markdown）。
 *
 * - 首行概括扫描名、视图与主题、违规规则数，以及每条规则的 id、影响级别与节点数。reporter 把错误
 *   信息首行写进 Run_Summary 的失败用例清单，首行因此自成一句。
 * - 其后空一行，逐条规则（按 axe 的顺序）列出规则 id、影响级别与节点数，再按节点顺序列出每个
 *   节点的 `target`（跨 frame 的多项以 `TARGET_SEPARATOR` 连接）、`html`（`summarizeAxe` 已截到
 *   200 字符以内，换行折成空格）、`failureSummary`（保留 axe 的分行）；带对比度数据的节点
 *   （`color-contrast`）另列前景色、背景色、实测与要求的对比度、字号与字重（RDF 15.4）。
 * - 空字段写 `EMPTY_FIELD`；影响级别缺失写"未给出"。
 * - incomplete 不列出（不使用例失败，RDF 15.3；明细在结果文件中）。
 * - 没有违规时只有首行（"报出 0 条违规规则"）。
 *
 * 纯函数：不修改参数，不抛错。
 */
export function formatA11yViolations(result: A11yScanResult): string {
  const { violations } = result;
  const where = `${A11Y_VIEW_LABELS[result.view]} · ${describeTheme(result.theme)}`;
  let head = `A11y_Scan ${result.name}（${where}）报出 ${violations.length} 条违规规则`;
  if (violations.length === 0) return head;
  head += `：${violations.map(ruleSummary).join("、")}；任一违规即判用例失败（RDF 15.2）`;

  const lines = [head];
  violations.forEach((v, i) => {
    lines.push("", `${i + 1}. ${v.id}（${v.impact ?? IMPACT_MISSING}），${v.nodes} 个节点`);
    if (v.details.length === 0) lines.push(`${NODE_INDENT}（没有节点明细）`);
    v.details.forEach((d, j) => lines.push(...nodeLines(d, j, v.details.length)));
  });
  return lines.join("\n");
}
