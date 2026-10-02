/**
 * A11y_Scan 结果归纳的纯函数与数据模型（设计"无障碍冒烟（需求 15）"与 Data Models 的
 * A11yScanResult；需求 15.4、15.5；任务 20.1。节点明细：reader-defect-fixes（RDF）需求 15.3、
 * 15.4，任务 6.1）。
 *
 * 本文件不依赖浏览器、文件系统、Playwright 与 axe-core 的运行时，只做一件事：把
 * `AxeBuilder.analyze()` 的结果收成结果文件与 Run_Summary 需要的形状，供 `scan.ts`（20.3）写附件与
 * `e2e/.out/a11y/<name>.json`，也供 reporter（20.5）读回后写 A11y_Scan 节：
 *
 * - 违规：每条规则的 id、影响级别与节点数；影响级别为 serious 或 critical 的标 `flagged`，
 *   reporter 据此写"待记入 Findings_Log"（15.5），minor 与 moderate 只列出。
 * - incomplete（axe 判为需人工复核）：每条规则的 id 与节点数。
 * - 没有违规时 `violations` 为空数组，reporter 写"违规数 0"（15.4）。
 * - 节点明细（RDF 15.4，RDF 设计第 14 节）：违规与 incomplete 的每条规则另带
 *   `details`，与 axe 的 `nodes` 逐一对应：`target` 选择器、截到 200 字符以内的 `html`、
 *   `failureSummary`，`color-contrast` 另带 `contrast`（前景色、背景色、实测与要求的对比度、字号、
 *   字重）。结果文件写出全部明细；Run_Summary 只为违规列出明细，incomplete 仍只列规则 id 与节点数
 *   （RDF 15.3，见 `report.ts`）。
 *
 * 归纳不排序、不去重、不过滤：输出的规则顺序与 axe 返回的顺序相同（设计 Property 10）。节点明细
 * 同样按 axe 的节点顺序，一个不少。
 *
 * 输入类型只声明用到的字段（`AxeResultsLike`），不 import `axe-core`：它是
 * `@axe-core/playwright` 的传递依赖，不在 `devDependencies` 中；`analyze()` 返回的
 * `AxeResults` 在结构上可直接赋给本类型，由 `scan.ts` 处的类型检查保证。
 */
import type { DeclaredTheme } from "../support/theme";

// ---------------------------------------------------------------------------
// 数据模型（设计 Data Models：A11y_Scan）
// ---------------------------------------------------------------------------

/** axe 的 4 个影响级别，自轻到重（15.4）。 */
export const IMPACTS = ["minor", "moderate", "serious", "critical"] as const;
export type Impact = (typeof IMPACTS)[number];

/** 需标"待记入 Findings_Log"的影响级别（15.5）。 */
export const FLAGGED_IMPACTS: readonly Impact[] = ["serious", "critical"];

/** reporter 为 `flagged` 违规写的标记原文（15.5）。 */
export const FINDINGS_FLAG_LABEL = "待记入 Findings_Log";

/** 被扫视图（15.1 的 6 个视图；15.2 的对比度扫描在 `reader` 视图上）。 */
export type A11yView = "shelf" | "detail" | "reader" | "toc" | "search" | "settings";

/**
 * 带对比度数据的规则 id（与 `scans.ts` 的 `COLOR_CONTRAST_RULE` 相同）。在本文件另写一份：
 * 本文件不 import 有运行时依赖的模块，`scans.ts` 只从这里取类型。
 */
const CONTRAST_RULE_ID = "color-contrast";

/** 节点 `html` 片段的长度上限（RDF 15.4），按 UTF-16 码元计，即 `String.prototype.length`。 */
export const HTML_MAX_LENGTH = 200;

/** `html` 超过上限时，截取前 `HTML_MAX_LENGTH - 1` 个码元后接的省略号（截断后长度恰为上限）。 */
export const HTML_ELLIPSIS = "…";

/**
 * axe `target` 中一项为数组时（shadow DOM：从外层宿主到内层元素的选择器）的连接符，连接后作为
 * `A11yNodeDetail.target` 中的一项。
 */
export const SHADOW_SELECTOR_SEPARATOR = " >>> ";

/**
 * `color-contrast` 节点的对比度数据（RDF 15.4），取自 axe 节点的 `any[0].data`。
 *
 * axe 对 incomplete 节点常只给出其中一部分（例如背景为渐变时没有 `bgColor`，伪元素时只有字号、
 * 字重与要求的对比度）：缺失或类型不符的字符串字段记为空串，`contrastRatio` 记为 0（axe 自己在
 * 测不出背景色时也报 0）；`-0` 记为 0，使输出经 JSON 往返不变。
 */
export interface A11yContrastData {
  /** 前景色，如 `#777777`。 */
  fgColor: string;
  /** 背景色。 */
  bgColor: string;
  /** 实测对比度（axe 已截到两位小数）。 */
  contrastRatio: number;
  /** 要求的对比度，如 `4.5:1`。 */
  expectedContrastRatio: string;
  /** 字号，如 `12.0pt (16px)`。 */
  fontSize: string;
  /** 字重：`normal` 或 `bold`。 */
  fontWeight: string;
}

/** 一个节点的明细（RDF 15.4；设计第 14 节）。 */
export interface A11yNodeDetail {
  /**
   * axe 节点的 `target`，逐项转为字符串：字符串原样；数组（shadow DOM 的嵌套选择器）以
   * `SHADOW_SELECTOR_SEPARATOR` 连接。axe 没给出数组时为空数组。
   */
  target: string[];
  /** 节点的 `html`；超过 `HTML_MAX_LENGTH` 时截为前 199 个码元加 `HTML_ELLIPSIS`。缺失时为空串。 */
  html: string;
  /** axe 的 `failureSummary`，原样（含换行）；缺失时为空串。 */
  failureSummary: string;
  /** 仅当规则为 `color-contrast` 且节点带 `any[0].data`（对象）时存在。 */
  contrast?: A11yContrastData;
}

/** 一条违规规则的归纳。 */
export interface A11yViolation {
  /** axe 规则 id，原样。 */
  id: string;
  /** 影响级别；axe 未给出时为 null。 */
  impact: Impact | null;
  /** 涉及节点数，即 axe 该规则 `nodes` 的长度。 */
  nodes: number;
  /** 当且仅当 `impact` 为 serious 或 critical（15.5）。 */
  flagged: boolean;
  /** 节点明细，与 axe 的 `nodes` 逐一对应（长度等于 `nodes`；RDF 15.4）。 */
  details: A11yNodeDetail[];
}

/** 一条 incomplete 规则的归纳。 */
export interface A11yIncomplete {
  /** axe 规则 id，原样。 */
  id: string;
  /** 涉及节点数，即 axe 该规则 `nodes` 的长度。 */
  nodes: number;
  /** 节点明细，与 axe 的 `nodes` 逐一对应（RDF 15.4）；只写入结果文件，Run_Summary 不列出（RDF 15.3）。 */
  details: A11yNodeDetail[];
}

/** `summarizeAxe` 的输出：A11yScanResult 中来自 axe 结果的部分。 */
export interface A11yAxeSummary {
  violations: A11yViolation[];
  incomplete: A11yIncomplete[];
  /** axe-core 版本（`testEngine.version`），写入 A11y 节表头。 */
  axeVersion: string;
}

/**
 * 一次扫描的结果，即 `a11y-result` 附件与 `e2e/.out/a11y/<name>.json` 的内容。
 *
 * - `status: "ok"`：扫描完成，`violations`、`incomplete`、`axeVersion` 取自 `summarizeAxe`。
 * - `status: "failed"`：注入失败、执行抛错、无结果或等待超时（15.9），`reason` 写原因；
 *   reporter 标"扫描失败"，不计为零违规。
 * - `status: "skipped"`：目标定位不到，按 16.4 跳过。
 *
 * `failed` 与 `skipped` 没有 axe 结果，`violations`、`incomplete` 为空数组、`axeVersion`
 * 为空串；reporter 先看 `status`，不得把它们读作"违规数 0"。
 *
 * `theme` 用 `DeclaredTheme`：15.1 的 6 个视图不写入主题，记为 `"unset"`（见
 * `e2e/support/theme.ts`）；15.2 的对比度扫描记所 seed 的主题键。
 */
export interface A11yScanResult extends A11yAxeSummary {
  name: string;
  view: A11yView;
  theme: DeclaredTheme;
  status: "ok" | "failed" | "skipped";
  reason?: string;
}

// ---------------------------------------------------------------------------
// 输入：axe 结果中用到的字段
// ---------------------------------------------------------------------------

/**
 * axe 一条规则结果中用到的字段（`axe-core` 的 `Result` / `IncompleteResult` 可直接赋给它）。
 *
 * `nodes` 的元素不声明类型：归纳只读其中的 `target`、`html`、`failureSummary` 与
 * `any[0].data`（axe-core 的 `NodeResult` / `CheckResult`），逐项核对类型后再取用，缺失或类型
 * 不符时按 `A11yNodeDetail` 各字段注明的写法记录，不抛错。
 */
export interface AxeRuleResultLike {
  id: string;
  impact?: Impact | null;
  nodes: readonly unknown[];
}

/** `AxeBuilder.analyze()` 结果中用到的字段（`axe-core` 的 `AxeResults` 可直接赋给它）。 */
export interface AxeResultsLike {
  violations: readonly AxeRuleResultLike[];
  incomplete: readonly AxeRuleResultLike[];
  testEngine: { version: string };
}

// ---------------------------------------------------------------------------
// 归纳
// ---------------------------------------------------------------------------

/**
 * 规整影响级别：4 级之一原样返回；缺失（`undefined`）或不在 4 级之内的值返回 null。
 * 后者只防 axe 将来改动取值，按类型不会出现。
 */
export function normalizeImpact(impact: unknown): Impact | null {
  return typeof impact === "string" && (IMPACTS as readonly string[]).includes(impact)
    ? (impact as Impact)
    : null;
}

/** 该影响级别的违规是否要标"待记入 Findings_Log"（15.5）。 */
export function isFlaggedImpact(impact: Impact | null): boolean {
  return impact !== null && FLAGGED_IMPACTS.includes(impact);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/**
 * axe `target` 中的一项转为字符串：字符串原样；数组（shadow DOM 的嵌套选择器）逐项转换后以
 * `SHADOW_SELECTOR_SEPARATOR` 连接；其它值（axe 不会给出，只作防御）对象写成 JSON，其余经 `String`。
 */
export function selectorText(selector: unknown): string {
  if (typeof selector === "string") return selector;
  if (Array.isArray(selector)) return selector.map(selectorText).join(SHADOW_SELECTOR_SEPARATOR);
  if (typeof selector === "object" && selector !== null) {
    try {
      const json = JSON.stringify(selector);
      if (typeof json === "string") return json;
    } catch {
      // 落到下面的 String
    }
  }
  return String(selector);
}

/** 截断节点的 `html`：长度不超过 `HTML_MAX_LENGTH` 时原样，否则为前 199 个码元加 `HTML_ELLIPSIS`。 */
export function truncateHtml(html: string): string {
  return html.length <= HTML_MAX_LENGTH ? html : `${html.slice(0, HTML_MAX_LENGTH - 1)}${HTML_ELLIPSIS}`;
}

/** 有限数原样（`-0` 记为 0），否则为 0（见 `A11yContrastData`）。 */
function ratioOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value + 0 : 0;
}

/** 节点 `any[0].data` 中的对比度数据；没有 `any[0]`、或其 `data` 不是对象时为 undefined。 */
function contrastOf(node: Record<string, unknown>): A11yContrastData | undefined {
  const checks = node.any;
  if (!Array.isArray(checks) || checks.length === 0) return undefined;
  const first: unknown = checks[0];
  if (!isRecord(first)) return undefined;
  const data = first.data;
  if (!isRecord(data)) return undefined;
  return {
    fgColor: stringOr(data.fgColor, ""),
    bgColor: stringOr(data.bgColor, ""),
    contrastRatio: ratioOf(data.contrastRatio),
    expectedContrastRatio: stringOr(data.expectedContrastRatio, ""),
    fontSize: stringOr(data.fontSize, ""),
    fontWeight: stringOr(data.fontWeight, ""),
  };
}

/**
 * 一个 axe 节点的明细（RDF 15.4；字段写法见 `A11yNodeDetail`）。`ruleId` 为 `color-contrast` 时
 * 另取对比度数据。节点不是对象时各字段取缺失时的写法。不修改输入，不抛错。
 */
export function summarizeNode(ruleId: string, node: unknown): A11yNodeDetail {
  const n: Record<string, unknown> = isRecord(node) ? node : {};
  const target = n.target;
  const detail: A11yNodeDetail = {
    target: Array.isArray(target) ? target.map(selectorText) : typeof target === "string" ? [target] : [],
    html: truncateHtml(stringOr(n.html, "")),
    failureSummary: stringOr(n.failureSummary, ""),
  };
  if (ruleId === CONTRAST_RULE_ID) {
    const contrast = contrastOf(n);
    // 没有对比度数据时不写该字段（而不是写 undefined），输出经 JSON 往返不变
    if (contrast !== undefined) detail.contrast = contrast;
  }
  return detail;
}

/**
 * 把 axe 结果归纳为 `A11yAxeSummary`（15.4、15.5；设计 Property 10；RDF 15.4 与设计 Property 8）。
 *
 * - `violations` 与输入逐条对应、顺序相同：`id` 原样，`impact` 经 `normalizeImpact`，
 *   `nodes` 为输入 `nodes` 的长度，`flagged` 当且仅当影响级别为 serious 或 critical；
 * - `incomplete` 同样逐条对应，保留 `id` 与节点数（incomplete 不做 15.5 的标记）；
 * - 两者的 `details` 与输入 `nodes` 逐一对应（`summarizeNode`），长度等于 `nodes`；
 * - `axeVersion` 取 `testEngine.version`。
 *
 * 纯函数：不修改输入，不抛错（输入符合类型时；节点内容不符合 axe 的类型时也不抛错）。
 */
export function summarizeAxe(results: AxeResultsLike): A11yAxeSummary {
  // Array.from 而不是 map：稀疏数组的空位也得到一项明细，details 的长度总等于 nodes
  const detailsOf = (rule: AxeRuleResultLike): A11yNodeDetail[] =>
    Array.from(rule.nodes, (node) => summarizeNode(rule.id, node));
  const violations = results.violations.map((rule): A11yViolation => {
    const impact = normalizeImpact(rule.impact);
    return {
      id: rule.id,
      impact,
      nodes: rule.nodes.length,
      flagged: isFlaggedImpact(impact),
      details: detailsOf(rule),
    };
  });
  const incomplete = results.incomplete.map(
    (rule): A11yIncomplete => ({ id: rule.id, nodes: rule.nodes.length, details: detailsOf(rule) }),
  );
  return { violations, incomplete, axeVersion: results.testEngine.version };
}
