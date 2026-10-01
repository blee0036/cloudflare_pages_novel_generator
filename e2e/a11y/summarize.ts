/**
 * A11y_Scan 结果归纳的纯函数与数据模型（设计"无障碍冒烟（需求 15）"与 Data Models 的
 * A11yScanResult；需求 15.4、15.5；任务 20.1）。
 *
 * 本文件不依赖浏览器、文件系统、Playwright 与 axe-core 的运行时，只做一件事：把
 * `AxeBuilder.analyze()` 的结果收成 Run_Summary 需要的最小形状，供 `scan.ts`（20.3）写附件与
 * `e2e/.out/a11y/<name>.json`，也供 reporter（20.5）读回后写 A11y_Scan 节：
 *
 * - 违规：每条规则的 id、影响级别与节点数；影响级别为 serious 或 critical 的标 `flagged`，
 *   reporter 据此写"待记入 Findings_Log"（15.5），minor 与 moderate 只列出。
 * - incomplete（axe 判为需人工复核）：每条规则的 id 与节点数。
 * - 没有违规时 `violations` 为空数组，reporter 写"违规数 0"（15.4）。
 *
 * 归纳不排序、不去重、不过滤：输出的规则顺序与 axe 返回的顺序相同（设计 Property 10）。
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
}

/** 一条 incomplete 规则的归纳。 */
export interface A11yIncomplete {
  /** axe 规则 id，原样。 */
  id: string;
  /** 涉及节点数，即 axe 该规则 `nodes` 的长度。 */
  nodes: number;
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

/** axe 一条规则结果中用到的字段（`axe-core` 的 `Result` / `IncompleteResult` 可直接赋给它）。 */
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

/**
 * 把 axe 结果归纳为 `A11yAxeSummary`（15.4、15.5；设计 Property 10）。
 *
 * - `violations` 与输入逐条对应、顺序相同：`id` 原样，`impact` 经 `normalizeImpact`，
 *   `nodes` 为输入 `nodes` 的长度，`flagged` 当且仅当影响级别为 serious 或 critical；
 * - `incomplete` 同样逐条对应，只保留 `id` 与节点数（incomplete 不做 15.5 的标记）；
 * - `axeVersion` 取 `testEngine.version`。
 *
 * 纯函数：不修改输入，不抛错（输入符合类型时）。
 */
export function summarizeAxe(results: AxeResultsLike): A11yAxeSummary {
  const violations = results.violations.map((rule): A11yViolation => {
    const impact = normalizeImpact(rule.impact);
    return { id: rule.id, impact, nodes: rule.nodes.length, flagged: isFlaggedImpact(impact) };
  });
  const incomplete = results.incomplete.map(
    (rule): A11yIncomplete => ({ id: rule.id, nodes: rule.nodes.length }),
  );
  return { violations, incomplete, axeVersion: results.testEngine.version };
}
