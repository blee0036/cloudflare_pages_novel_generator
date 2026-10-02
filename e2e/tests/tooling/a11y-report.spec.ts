/**
 * Run_Summary "A11y_Scan"一节的例子测试（`tooling` 项目，无浏览器；任务 20.5，需求 1.7、15.4、
 * 15.5、15.9）。被测的是 `a11y/report.ts` 的纯函数：
 *
 * - `buildA11ySection`：只由 `a11y-result` 附件得出结果，按 `A11Y_SCANS` 的顺序每次扫描一节；没有
 *   有效附件的扫描按用例结果写"扫描失败""跳过"或"未执行"，不写成违规数 0。
 * - `renderA11ySection`：每节列出违规的规则 id、影响级别、节点数与 incomplete 的规则 id、节点数；
 *   critical 与 serious 标"待记入 Findings_Log"。
 *
 * 影响级别、标记原文与"违规数 0"按需求原文写成字面量；`CaseFacts` 手写，形状与 reporter 的
 * `toCaseFacts` 相同，附件按 Playwright 交给 reporter 的样子带 `body`。只跑 real 时该节写"未运行"，
 * 由 `run-summary.spec.ts` 的"未运行"一例覆盖。
 *
 * reader-defect-fixes（RDF）任务 6.4（需求 15.3、15.6）另加两例：`A11Y_SCANS` 恰为 31 次，名称、
 * 顺序、视图、主题与规则集按需求原文写成字面量（EV 15.1、15.2 的 11 次不变，RDF 15.6 的 20 次
 * Contrast_Extension_Scan 的书与进入路径同 15.1 中同一视图）；违规节点明细表的渲染（对比度列、
 * 缺数据与空字段写"—"、多项 target、单元格中的 `|`、反引号与标签、failureSummary 的换行），
 * incomplete 带明细时仍只列规则 id 与节点数。
 *
 * RDF 任务 17.2（需求 15.2、15.3）另加 `formatA11yViolations` 的例子：违规时 `a11y.spec.ts` 断言失败
 * 所用的纯文本说明按字面量逐行核对（首行概括、逐条规则与节点的 target、html、failureSummary、
 * 对比度数据，空字段写"—"、影响级别缺失写"未给出"）；incomplete 不进入说明；不修改参数；首行
 * 单独成句（reporter 只取错误信息首行写进失败用例清单）；Run_Summary 中违规使所在用例失败、
 * incomplete 只列出。
 */
import { expect, test } from "@playwright/test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  A11Y_SPEC_FILE,
  buildA11ySection,
  formatA11yViolations,
  renderA11ySection,
  type A11ySectionData,
} from "../../a11y/report";
import {
  A11Y_CONTRAST_EXT_VIEWS,
  A11Y_RESULT_ATTACHMENT,
  A11Y_SCANS,
  EXTENSION_THEMES,
  a11yScan,
  a11yTestTitle,
  describeA11yScan,
  type A11yScanName,
} from "../../a11y/scans";
import type { A11yNodeDetail, A11yScanResult } from "../../a11y/summarize";
import { THEME_UNSET, appDefaultTheme, describeTheme } from "../../support/theme";
import {
  buildRunSummary,
  firstLine,
  renderSummary,
  SUMMARY_HEADINGS,
  type CaseAnnotation,
  type CaseAttachment,
  type CaseFacts,
  type RunFacts,
  type TestStatus,
} from "../../support/summary";

/** 仓库根（本文件位于 `e2e/tests/tooling/`）。 */
const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));

const AXE_VERSION = "4.11.0";

/** 15.5 的标记原文。 */
const FLAG = "待记入 Findings_Log";

/** 15.4：没有违规的节显示的写法。 */
const ZERO_VIOLATIONS = "- 违规数：0";

// ---------------------------------------------------------------------------
// CaseFacts
// ---------------------------------------------------------------------------

interface CaseSpec {
  /** 省略时为 `a11yTestTitle(def)`。 */
  title?: string;
  /** 省略时为 passed；null 表示没有结果（未执行）。 */
  status?: TestStatus | null;
  errors?: string[];
  annotations?: CaseAnnotation[];
  attachments?: CaseAttachment[];
}

function scanCase(name: string, c: CaseSpec = {}): CaseFacts {
  const def = A11Y_SCANS.find((d) => d.name === name);
  const title = c.title ?? (def === undefined ? name : a11yTestTitle(def));
  const status = c.status === undefined ? "passed" : c.status;
  return {
    id: `fixture:${title}`,
    file: path.join(REPO_ROOT, A11Y_SPEC_FILE),
    titlePath: [title],
    project: "fixture",
    expectedStatus: "passed",
    timeoutMs: 60_000,
    annotations: c.annotations ?? [],
    result:
      status === null
        ? null
        : { status, startMs: 0, durationMs: 1, errors: c.errors ?? [], attachments: c.attachments ?? [] },
  };
}

/** `a11y-result` 附件：Playwright 把 `testInfo.attach` 的 body 以 Buffer 交给 reporter。 */
function attachment(result: A11yScanResult | string): CaseAttachment {
  const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
  return { name: A11Y_RESULT_ATTACHMENT, body: Buffer.from(text) };
}

function okResult(name: A11yScanName, parts: Partial<Pick<A11yScanResult, "violations" | "incomplete">> = {}): A11yScanResult {
  const def = a11yScan(name);
  return {
    name: def.name,
    view: def.view,
    theme: def.theme,
    status: "ok",
    violations: parts.violations ?? [],
    incomplete: parts.incomplete ?? [],
    axeVersion: AXE_VERSION,
  };
}

/**
 * 手写违规与 incomplete 用的 `n` 个节点明细（RDF 15.4：长度须等于 `nodes`），target 为
 * `#<prefix><序号>`，不带对比度数据。
 */
function details(prefix: string, n: number): A11yNodeDetail[] {
  return Array.from({ length: n }, (_, i) => ({
    target: [`#${prefix}${i + 1}`],
    html: `<p id="${prefix}${i + 1}">`,
    failureSummary: "Fix any of the following:\n  x",
  }));
}

/** `details(prefix, n)` 中第 `i` 个（从 1 起）节点在明细表中的一行（failureSummary 的换行折成空格）。 */
function detailRow(prefix: string, i: number): string {
  return `| ${i} | \`#${prefix}${i}\` | \`<p id="${prefix}${i}">\` | \`Fix any of the following: x\` |`;
}

function noAxeResult(name: A11yScanName, status: "failed" | "skipped", reason: string): A11yScanResult {
  const def = a11yScan(name);
  return { name: def.name, view: def.view, theme: def.theme, status, reason, violations: [], incomplete: [], axeVersion: "" };
}

// ---------------------------------------------------------------------------
// 渲染结果的读取
// ---------------------------------------------------------------------------

/** `### n. …` 形式的分节标题（不含"附件问题"）。 */
function headings(lines: readonly string[]): string[] {
  return lines.filter((l) => /^### \d+\. /.test(l));
}

/** 第 `index` 个扫描（从 0 起）一节的正文：标题之后到下一个 `### ` 之前，去掉首尾空行。 */
function entryBody(lines: readonly string[], index: number): string[] {
  const start = lines.findIndex((l) => l.startsWith(`### ${index + 1}. `));
  assert.ok(start !== -1, `没有第 ${index + 1} 节：\n${lines.join("\n")}`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("### "));
  const body = end === -1 ? rest : rest.slice(0, end);
  while (body.length > 0 && body[0] === "") body.shift();
  while (body.length > 0 && body[body.length - 1] === "") body.pop();
  return body;
}

function bodyOf(lines: readonly string[], name: string): string[] {
  return entryBody(lines, A11Y_SCANS.findIndex((d) => d.name === name));
}

function section(cases: CaseFacts[]): { data: A11ySectionData; lines: string[] } {
  const data = buildA11ySection(A11Y_SCANS, cases);
  return { data, lines: renderA11ySection(data) };
}

/** 只跑 fixture 的一次运行：`cases` 为全部用例，`lines` 为 A11y_Scan 一节的正文，其余各节与产物取不涉及的写法。 */
function runFacts(cases: CaseFacts[], lines: string[], status: RunFacts["status"]): RunFacts {
  return {
    startTime: new Date("2025-06-01T12:00:00.000Z"),
    durationMs: 60_000,
    status,
    selected: ["fixture"],
    onBeginTests: cases.length,
    errors: [],
    setupAbort: null,
    cases,
    snapshot: { start: { ok: true, count: 10, ms: 5 }, end: { ok: true, count: 10, ms: 5 }, diff: null },
    fixtureFailed: null,
    realPrecheck: null,
    reviewViolations: [],
    artifacts: {
      htmlReport: { path: "e2e/.out/report/index.html" },
      reviewReport: { path: "e2e/.out/review/review-report.md" },
      perf: { missing: "real 未运行" },
      a11y: { path: "e2e/.out/a11y/" },
    },
    sections: {
      visual: { status: "notGenerated", reason: "本例不涉及" },
      perf: { status: "notRun", reason: "real 未运行" },
      a11y: { status: "ready", lines },
    },
    utcOffsetMinutes: 480,
  };
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

test.describe("A11y_Scan 一节（任务 20.5）", () => {
  test("31 次扫描都完成：按 A11Y_SCANS 的顺序逐节列出，critical 与 serious 标记、minor 与 moderate 只列出，无违规写违规数 0", () => {
    const settings = okResult("a11y-settings", {
      violations: [
        // flagged 故意写反：标记只看影响级别（15.5）
        { id: "label", impact: "critical", nodes: 2, flagged: false, details: details("l", 2) },
        { id: "color-contrast", impact: "serious", nodes: 3, flagged: true, details: details("c", 3) },
        { id: "region", impact: "moderate", nodes: 1, flagged: true, details: details("r", 1) },
        { id: "list", impact: "minor", nodes: 1, flagged: false, details: details("s", 1) },
      ],
      incomplete: [{ id: "color-contrast", nodes: 4, details: details("i", 4) }],
    });
    // 用例顺序与 A11Y_SCANS 相反：节序只取 A11Y_SCANS
    const cases = [...A11Y_SCANS].reverse().map((def) =>
      scanCase(def.name, { attachments: [attachment(def.name === "a11y-settings" ? settings : okResult(def.name))] }),
    );
    const { data, lines } = section(cases);

    // RDF 15.1、15.6：6 个视图扫描、5 次阅读器正文对比度扫描与 20 次 Contrast_Extension_Scan
    expect(A11Y_SCANS).toHaveLength(31);
    expect(data.entries.map((e) => e.name)).toEqual(A11Y_SCANS.map((d) => d.name));
    expect(data.entries.every((e) => e.result.kind === "ok")).toBe(true);
    expect(data.axeVersions).toEqual([AXE_VERSION]);
    expect(data.problems).toEqual([]);

    // 15.4：31 节，节名标明视图与主题
    expect(headings(lines)).toEqual(A11Y_SCANS.map((d, i) => `### ${i + 1}. ${describeA11yScan(d)}`));
    expect(headings(lines)[0]).toBe("### 1. 书架首屏 · " + describeTheme(THEME_UNSET));
    expect(headings(lines)[10]).toMatch(/^### 11\. 阅读器正文 · .+ · 仅 color-contrast$/);

    expect(lines).toContain(`- axe-core：${AXE_VERSION}`);
    expect(lines).toContain("- 结果：完成 31、扫描失败 0、跳过 0、未执行 0（共 31 次）");
    expect(lines.some((l) => l.includes("4 条违规规则，其中 critical 或 serious 2 条") && l.includes(FLAG))).toBe(true);
    // RDF 15.2、15.3：任一违规即判用例失败，incomplete 只列出
    expect(lines.some((l) => l.includes("任一违规即判该扫描的用例失败") && l.includes("incomplete 只列出，不使用例失败"))).toBe(
      true,
    );
    expect(lines.some((l) => l.includes("不影响用例结果与退出码"))).toBe(false);

    expect(bodyOf(lines, "a11y-shelf")).toEqual([
      "- 扫描：`a11y-shelf`；结果：完成",
      "- 用例结果：通过",
      ZERO_VIOLATIONS,
      "- incomplete（axe 判为需人工复核）：0",
    ]);
    expect(bodyOf(lines, "a11y-settings")).toEqual([
      "- 扫描：`a11y-settings`；结果：完成",
      "- 用例结果：通过",
      "- 违规数：4",
      "",
      "| 规则 id | 影响级别 | 节点数 | 标记 |",
      "| --- | --- | ---: | --- |",
      `| \`label\` | critical | 2 | ${FLAG} |`,
      `| \`color-contrast\` | serious | 3 | ${FLAG} |`,
      "| `region` | moderate | 1 | — |",
      "| `list` | minor | 1 | — |",
      "",
      // RDF 15.3、15.4：违规逐条规则列出节点明细
      "- 违规 `label`（critical）的节点明细，共 2 个：",
      "",
      "| 节点 | target | html | failureSummary |",
      "| ---: | --- | --- | --- |",
      detailRow("l", 1),
      detailRow("l", 2),
      "",
      "- 违规 `color-contrast`（serious）的节点明细，共 3 个：",
      "",
      "| 节点 | target | html | failureSummary |",
      "| ---: | --- | --- | --- |",
      detailRow("c", 1),
      detailRow("c", 2),
      detailRow("c", 3),
      "",
      "- 违规 `region`（moderate）的节点明细，共 1 个：",
      "",
      "| 节点 | target | html | failureSummary |",
      "| ---: | --- | --- | --- |",
      detailRow("r", 1),
      "",
      "- 违规 `list`（minor）的节点明细，共 1 个：",
      "",
      "| 节点 | target | html | failureSummary |",
      "| ---: | --- | --- | --- |",
      detailRow("s", 1),
      "",
      // incomplete 只列规则 id 与节点数（RDF 15.3）
      "- incomplete（axe 判为需人工复核）：1",
      "",
      "| 规则 id | 节点数 |",
      "| --- | ---: |",
      "| `color-contrast` | 4 |",
    ]);
    expect(lines).not.toContain("### 附件问题");
  });

  test("没有 axe 结果的扫描：扫描失败附视图、主题与原因，跳过附原因，未收集与未执行写未执行，都不写违规数 0", () => {
    const waitFailure = "等待 15.7 条件：10000 ms 内未满足：(c) 应只打开目录抽屉，实际：都未打开";
    const gap = "[16.4 F-009] 详情弹窗的章节目录没有可访问名称";
    const fixtureFailed = "[3.9] Fixture_Generator 失败：pipeline 退出码 1";
    const { data, lines } = section([
      scanCase("a11y-shelf", { status: "failed", errors: ["Error: A11y_Scan 失败"], attachments: [attachment(noAxeResult("a11y-shelf", "failed", waitFailure))] }),
      scanCase("a11y-detail", {
        status: "skipped",
        annotations: [{ type: "skip", description: gap }],
        attachments: [attachment(noAxeResult("a11y-detail", "skipped", gap))],
      }),
      // 在 runA11yScan 之前失败、afterEach 也没能补记：没有附件
      scanCase("a11y-reader", { status: "timedOut", errors: ["Test timeout of 60000ms exceeded."] }),
      scanCase("a11y-toc", { status: null }),
      scanCase("a11y-search", { status: "skipped", annotations: [{ type: "skip", description: fixtureFailed }] }),
      // 通过却只留下无法解析的附件
      scanCase("a11y-settings", { attachments: [attachment("{not json")] }),
      // 25 次对比度扫描（15.2 的 5 次与 RDF 15.6 的 20 次）本次未收集
    ]);

    expect(data.collected).toBe(6);
    expect(data.entries.map((e) => e.result.kind)).toEqual([
      "failed", "skipped", "failed", "notRun", "skipped", "failed",
      ...Array.from({ length: 25 }, () => "notRun"),
    ]);
    expect(data.axeVersions).toEqual([]);
    expect(lines).toContain("- axe-core：未知（没有完成的扫描）");
    expect(lines).toContain("- 结果：完成 0、扫描失败 3、跳过 2、未执行 26（共 31 次）");
    expect(headings(lines)).toHaveLength(31);

    // 15.9：标"扫描失败"，附视图名、主题与失败原因
    expect(bodyOf(lines, "a11y-shelf")).toEqual([
      "- 扫描：`a11y-shelf`；结果：扫描失败",
      `- 视图：书架首屏；主题：${describeTheme(THEME_UNSET)}`,
      `- 失败原因：${waitFailure}`,
      "- 用例结果：失败",
      "- 违规数：没有结果（扫描失败，不计为 0）",
    ]);
    expect(bodyOf(lines, "a11y-detail")).toEqual([
      "- 扫描：`a11y-detail`；结果：跳过",
      `- 跳过原因：${gap}`,
      "- 用例结果：跳过",
      "- 违规数：没有结果（跳过）",
    ]);
    expect(bodyOf(lines, "a11y-reader")[2]).toBe(
      `- 失败原因：没有 ${A11Y_RESULT_ATTACHMENT} 附件；用例失败（超时）：Test timeout of 60000ms exceeded.`,
    );
    expect(bodyOf(lines, "a11y-toc")).toEqual([
      "- 扫描：`a11y-toc`；结果：未执行",
      "- 原因：用例未执行完（运行被中断，或未轮到执行）",
      "- 违规数：没有结果（未执行）",
    ]);
    expect(bodyOf(lines, "a11y-search")[1]).toBe(`- 跳过原因：${fixtureFailed}`);
    expect(bodyOf(lines, "a11y-settings")[2]).toMatch(
      new RegExp(`^- 失败原因：${A11Y_RESULT_ATTACHMENT} 附件无法解析：不是有效的 JSON（.+）；用例通过$`),
    );
    expect(bodyOf(lines, "a11y-contrast-dark")).toEqual([
      "- 扫描：`a11y-contrast-dark`；结果：未执行",
      "- 原因：本次运行未收集该扫描的用例",
      "- 违规数：没有结果（未执行）",
    ]);

    for (let i = 0; i < A11Y_SCANS.length; i++) {
      const body = entryBody(lines, i);
      expect(body, A11Y_SCANS[i].name).not.toContain(ZERO_VIOLATIONS);
      expect(body.some((l) => l.startsWith("| ")), A11Y_SCANS[i].name).toBe(false);
    }
    expect(lines.slice(lines.indexOf("### 附件问题") + 2)).toHaveLength(1);
  });

  test("附件问题：同一扫描名取第一份，扫描名不在定义中与视图不符的附件记入附件问题", () => {
    const { data, lines } = section([
      scanCase("a11y-shelf", {
        attachments: [
          attachment(
            okResult("a11y-shelf", { violations: [{ id: "region", impact: "moderate", nodes: 5, flagged: false, details: details("r", 5) }] }),
          ),
        ],
      }),
      scanCase("a11y-shelf-again", { title: "另一个用例", attachments: [attachment(okResult("a11y-shelf")), attachment({ ...okResult("a11y-shelf"), name: "a11y-unknown" })] }),
      scanCase("a11y-reader", { attachments: [attachment({ ...okResult("a11y-reader"), view: "shelf" })] }),
    ]);

    const shelf = data.entries[0].result;
    assert.ok(shelf.kind === "ok");
    expect(shelf.violations.map((v) => [v.id, v.nodes])).toEqual([["region", 5]]);
    // 视图不符的附件照常采用，另记一条附件问题
    expect(data.entries[2].result.kind).toBe("ok");
    expect(data.problems).toHaveLength(3);
    expect(data.problems[0]).toContain("a11y-shelf 的结果已由之前的 a11y-result 附件给出，本份未采用");
    expect(data.problems[1]).toContain("扫描名 a11y-unknown 不在 A11Y_SCANS 中");
    expect(data.problems[2]).toContain("a11y-reader 的附件记录的视图与主题为 shelf、unset，与定义的 reader、unset 不符");
    const problems = lines.slice(lines.indexOf("### 附件问题"));
    expect(problems).toHaveLength(2 + data.problems.length);
  });

  // RDF 15.2 起违规由 a11y.spec.ts 的断言使用例失败；本节自身仍不参与退出码（不单列为运行级失败）
  test("退出码只取用例结果：本节不单列运行级失败，用例全部通过时退出码为 0，summary 的 A11y_Scan 一节即本节正文", () => {
    const critical = okResult("a11y-settings", {
      violations: [{ id: "label", impact: "critical", nodes: 2, flagged: true, details: details("l", 2) }],
    });
    const cases = A11Y_SCANS.map((def) =>
      scanCase(def.name, { attachments: [attachment(def.name === "a11y-settings" ? critical : okResult(def.name))] }),
    );
    const { lines } = section(cases);
    const model = buildRunSummary(runFacts(cases, lines, "passed"));
    expect(model.exitCode).toBe(0);
    expect(model.runLevel).toEqual([]);

    const md = renderSummary(model).split("\n");
    const start = md.indexOf(SUMMARY_HEADINGS.a11y);
    expect(start).toBeGreaterThan(-1);
    expect(md.slice(start + 2, start + 2 + lines.length)).toEqual(lines);
    expect(md.some((l) => l.includes(`| \`label\` | critical | 2 | ${FLAG} |`))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// RDF 任务 6.4：扫描集合（需求 15.6）与违规节点明细的渲染（需求 15.3、15.4）
// ---------------------------------------------------------------------------

/** RDF 15.6 的 5 个视图（`shelf`、`detail`、`toc`、`search`、`settings`）与 EV 15.4 节名中的写法，按需求原文的顺序。 */
const EXT_VIEWS = [
  ["shelf", "书架首屏"],
  ["detail", "书籍详情弹窗"],
  ["toc", "目录抽屉"],
  ["search", "检索抽屉"],
  ["settings", "设置抽屉"],
] as const;

/** RDF 15.6 的 4 个主题键（D12：默认主题即 sepia，已由 15.1 的 6 个视图扫描覆盖）。 */
const EXT_THEMES = ["default", "eyecare", "dark", "black"] as const;

/** 表格行按未转义的 `|` 切出的单元格数（`\|` 是单元格内的竖线，不分列）。 */
function cellCount(row: string): number {
  return row.split(/(?<!\\)\|/).length - 2;
}

test.describe("A11y_Scan 扫描集合与节点明细（RDF 任务 6.4）", () => {
  test("RDF 15.6 A11Y_SCANS 恰为 31 次：EV 15.1 的 6 次与 15.2 的 5 次不变，其后是 5 个视图 × default、eyecare、dark、black 的 20 次 color-contrast 扫描", () => {
    expect(A11Y_SCANS).toHaveLength(31);
    expect(A11Y_SCANS.map((d) => d.name)).toEqual([
      // EV 15.1：6 次视图扫描
      "a11y-shelf",
      "a11y-detail",
      "a11y-reader",
      "a11y-toc",
      "a11y-search",
      "a11y-settings",
      // EV 15.2：阅读器正文 5 个主题的对比度扫描
      "a11y-contrast-default",
      "a11y-contrast-sepia",
      "a11y-contrast-eyecare",
      "a11y-contrast-dark",
      "a11y-contrast-black",
      // RDF 15.6：Contrast_Extension_Scan，按视图 × 主题
      "a11y-contrast-shelf-default",
      "a11y-contrast-shelf-eyecare",
      "a11y-contrast-shelf-dark",
      "a11y-contrast-shelf-black",
      "a11y-contrast-detail-default",
      "a11y-contrast-detail-eyecare",
      "a11y-contrast-detail-dark",
      "a11y-contrast-detail-black",
      "a11y-contrast-toc-default",
      "a11y-contrast-toc-eyecare",
      "a11y-contrast-toc-dark",
      "a11y-contrast-toc-black",
      "a11y-contrast-search-default",
      "a11y-contrast-search-eyecare",
      "a11y-contrast-search-dark",
      "a11y-contrast-search-black",
      "a11y-contrast-settings-default",
      "a11y-contrast-settings-eyecare",
      "a11y-contrast-settings-dark",
      "a11y-contrast-settings-black",
    ]);

    // EV 15.1、15.2 的 11 次：名称、视图、主题、规则集与所用的书不变
    expect(A11Y_SCANS.slice(0, 11).map(({ name, view, theme, rules, book }) => ({ name, view, theme, rules, book }))).toEqual([
      { name: "a11y-shelf", view: "shelf", theme: THEME_UNSET, rules: "wcag", book: null },
      { name: "a11y-detail", view: "detail", theme: THEME_UNSET, rules: "wcag", book: "volumes" },
      { name: "a11y-reader", view: "reader", theme: THEME_UNSET, rules: "wcag", book: "volumes" },
      { name: "a11y-toc", view: "toc", theme: THEME_UNSET, rules: "wcag", book: "volumes" },
      { name: "a11y-search", view: "search", theme: THEME_UNSET, rules: "wcag", book: "volumes" },
      { name: "a11y-settings", view: "settings", theme: THEME_UNSET, rules: "wcag", book: "volumes" },
      { name: "a11y-contrast-default", view: "reader", theme: "default", rules: "color-contrast", book: "volumes" },
      { name: "a11y-contrast-sepia", view: "reader", theme: "sepia", rules: "color-contrast", book: "volumes" },
      { name: "a11y-contrast-eyecare", view: "reader", theme: "eyecare", rules: "color-contrast", book: "volumes" },
      { name: "a11y-contrast-dark", view: "reader", theme: "dark", rules: "color-contrast", book: "volumes" },
      { name: "a11y-contrast-black", view: "reader", theme: "black", rules: "color-contrast", book: "volumes" },
    ]);
    for (const def of A11Y_SCANS.slice(0, 6)) {
      expect(a11yTestTitle(def), def.name).toBe(`15.1 ${def.name}：${describeA11yScan(def)}`);
    }
    for (const def of A11Y_SCANS.slice(6, 11)) {
      expect(a11yTestTitle(def), def.name).toBe(`15.2 ${def.name}：${describeA11yScan(def)}`);
    }

    // D12：扩展的主题是 5 个主题键去掉应用默认渲染的 sepia；视图按需求原文的顺序
    expect(appDefaultTheme()).toBe("sepia");
    expect(EXTENSION_THEMES).toEqual(EXT_THEMES);
    expect(EXTENSION_THEMES).not.toContain(appDefaultTheme());
    expect(A11Y_CONTRAST_EXT_VIEWS).toEqual(EXT_VIEWS.map(([view]) => view));

    // RDF 15.6 的 20 次：只运行 color-contrast、seed 该主题键；书与进入路径同 15.1 中同一视图
    const expected = EXT_VIEWS.flatMap(([view, label]) => EXT_THEMES.map((theme) => ({ view, label, theme })));
    const ext = A11Y_SCANS.slice(11);
    expect(ext).toHaveLength(expected.length);
    expected.forEach(({ view, label, theme }, i) => {
      const def = ext[i];
      const name = `a11y-contrast-${view}-${theme}`;
      const base = A11Y_SCANS.find((d) => d.name === `a11y-${view}`);
      assert.ok(base !== undefined, `没有 a11y-${view}`);
      expect({ name: def.name, view: def.view, theme: def.theme, rules: def.rules }, name).toEqual({
        name,
        view,
        theme,
        rules: "color-contrast",
      });
      expect({ book: def.book, url: def.url }, name).toEqual({ book: base.book, url: base.url });
      expect(def.book, name).toBe(view === "shelf" ? null : "volumes");
      expect(a11yTestTitle(def), name).toBe(`RDF 15.6 ${name}：${label} · ${describeTheme(theme)} · 仅 color-contrast`);
    });

    // Run_Summary：20 次与 15.2 的对比度扫描同样计为对比度扫描，节名标明视图、主题与规则
    const { lines } = section(A11Y_SCANS.map((def) => scanCase(def.name, { attachments: [attachment(okResult(def.name))] })));
    expect(lines.some((l) => l.includes("6 个视图只启用") && l.includes("25 次对比度扫描只运行 `color-contrast`"))).toBe(true);
    expect(headings(lines).slice(11)).toEqual(
      expected.map(({ label, theme }, i) => `### ${12 + i}. ${label} · ${describeTheme(theme)} · 仅 color-contrast`),
    );
    expect(bodyOf(lines, "a11y-contrast-toc-dark")).toEqual([
      "- 扫描：`a11y-contrast-toc-dark`；结果：完成",
      "- 用例结果：通过",
      ZERO_VIOLATIONS,
      "- incomplete（axe 判为需人工复核）：0",
    ]);
  });

  test("RDF 15.3、15.4 违规节点明细：color-contrast 另列对比度数据，缺数据与空字段写“—”，多项 target 以 → 连接，单元格中的 |、反引号与标签照常显示，failureSummary 的换行折成空格；incomplete 带明细时仍只列规则 id 与节点数", () => {
    const contrastNode: A11yNodeDetail = {
      target: ["#ink"],
      html: '<span class="muted">第 1 章</span>',
      failureSummary: "Fix any of the following:\n  Element has insufficient color contrast of 3.2",
      contrast: {
        fgColor: "#8a8a8a",
        bgColor: "#f5ecd9",
        contrastRatio: 3.2,
        expectedContrastRatio: "4.5:1",
        fontSize: "10.5pt (14px)",
        fontWeight: "normal",
      },
    };
    // 同一规则中没有对比度数据的节点；跨 frame 的 target 有两项
    const plainNode: A11yNodeDetail = {
      target: ["iframe#reader", "#b"],
      html: '<label title="a|b">`x`</label>',
      failureSummary: "Fix all of the following:\n  a\r\n\r\n  b",
    };
    // 字段为空：target 为空数组、html 与 failureSummary 为空串，对比度数据只有一部分
    const emptyNode: A11yNodeDetail = {
      target: [],
      html: "",
      failureSummary: "",
      contrast: { fgColor: "", bgColor: "#000000", contrastRatio: 0, expectedContrastRatio: "4.5:1", fontSize: "", fontWeight: "" },
    };
    const pendingNode: A11yNodeDetail = {
      target: ["#pending"],
      html: "<em>待定</em>",
      failureSummary: "Fix any of the following:\n  y",
      contrast: { fgColor: "#abcdef", bgColor: "", contrastRatio: 0, expectedContrastRatio: "4.5:1", fontSize: "12.0pt (16px)", fontWeight: "bold" },
    };
    const search = okResult("a11y-search", {
      violations: [
        { id: "color-contrast", impact: "serious", nodes: 3, flagged: true, details: [contrastNode, plainNode, emptyNode] },
        { id: "label", impact: "critical", nodes: 1, flagged: true, details: details("l", 1) },
      ],
      incomplete: [{ id: "color-contrast", nodes: 1, details: [pendingNode] }],
    });
    const { data, lines } = section([scanCase("a11y-search", { attachments: [attachment(search)] })]);
    expect(data.problems).toEqual([]);

    const header = "| 节点 | target | html | failureSummary | 前景色 | 背景色 | 实测对比度 | 要求的对比度 | 字号 | 字重 |";
    const rows = [
      "| 1 | `#ink` | `<span class=\"muted\">第 1 章</span>` | `Fix any of the following: Element has insufficient color contrast of 3.2` | #8a8a8a | #f5ecd9 | 3.2 | 4.5:1 | 10.5pt (14px) | normal |",
      // 单元格内的 | 转义为 \|；html 含反引号时围栏加长为两个反引号
      '| 2 | `iframe#reader` → `#b` | ``<label title="a\\|b">`x`</label>`` | `Fix all of the following: a b` | — | — | — | — | — | — |',
      "| 3 | — | — | — | — | #000000 | 0 | 4.5:1 | — | — |",
    ];
    const body = bodyOf(lines, "a11y-search");
    expect(body).toEqual([
      "- 扫描：`a11y-search`；结果：完成",
      "- 用例结果：通过",
      "- 违规数：2",
      "",
      "| 规则 id | 影响级别 | 节点数 | 标记 |",
      "| --- | --- | ---: | --- |",
      `| \`color-contrast\` | serious | 3 | ${FLAG} |`,
      `| \`label\` | critical | 1 | ${FLAG} |`,
      "",
      "- 违规 `color-contrast`（serious）的节点明细，共 3 个：",
      "",
      header,
      "| ---: | --- | --- | --- | --- | --- | ---: | --- | --- | --- |",
      ...rows,
      "",
      // 对比度列按规则判定：本规则没有节点带对比度数据，不加这几列
      "- 违规 `label`（critical）的节点明细，共 1 个：",
      "",
      "| 节点 | target | html | failureSummary |",
      "| ---: | --- | --- | --- |",
      detailRow("l", 1),
      "",
      "- incomplete（axe 判为需人工复核）：1",
      "",
      "| 规则 id | 节点数 |",
      "| --- | ---: |",
      "| `color-contrast` | 1 |",
    ]);

    // 每行的列数与表头相同：单元格中的 |、反引号与标签不破坏表格
    for (const row of rows) expect(cellCount(row), row).toBe(cellCount(header));
    expect(cellCount(header)).toBe(10);
    // incomplete 的节点明细只在结果文件中，不出现在 Run_Summary
    const text = body.join("\n");
    expect(text).not.toContain("#pending");
    expect(text).not.toContain("#abcdef");
    expect(body.filter((l) => l.includes("节点明细"))).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// RDF 任务 17.2：违规时的用例失败信息（需求 15.2）与 Run_Summary 中的判定（需求 15.2、15.3）
// ---------------------------------------------------------------------------

/** 15.2 的失败信息中，每条规则之后都写的判定。 */
const BLOCKING = "任一违规即判用例失败（RDF 15.2）";

/** `color-contrast` 节点：带对比度数据，html 含换行，failureSummary 为 axe 的两行写法。 */
const CONTRAST_NODE: A11yNodeDetail = {
  target: ["#settings-panel .hint"],
  html: '<p class="hint">\n  字号\n</p>',
  failureSummary:
    "Fix any of the following:\n  Element has insufficient color contrast of 3.2 (foreground color: #8a8a8a, " +
    "background color: #f5ecd9, font size: 10.5pt (14px), font weight: normal). Expected contrast ratio of 4.5:1",
  contrast: {
    fgColor: "#8a8a8a",
    bgColor: "#f5ecd9",
    contrastRatio: 3.2,
    expectedContrastRatio: "4.5:1",
    fontSize: "10.5pt (14px)",
    fontWeight: "normal",
  },
};

/** 同一规则中没有对比度数据的节点：跨 frame 的 target 有两项，html 为空，failureSummary 含 `\r\n` 与空行。 */
const PLAIN_NODE: A11yNodeDetail = {
  target: ["iframe#reader", "#b"],
  html: "",
  failureSummary: "Fix all of the following:\n  a\r\n\r\n  b",
};

/** `label` 节点：failureSummary 为空。 */
const LABEL_NODE: A11yNodeDetail = {
  target: ["#font-size"],
  html: '<input id="font-size" type="range">',
  failureSummary: "",
};

/** 设置抽屉的视图扫描报出 2 条违规：`color-contrast`（2 个节点）与影响级别缺失的 `label`（1 个节点）。 */
function settingsViolations(): A11yScanResult {
  return okResult("a11y-settings", {
    violations: [
      { id: "color-contrast", impact: "serious", nodes: 2, flagged: true, details: [CONTRAST_NODE, PLAIN_NODE] },
      { id: "label", impact: null, nodes: 1, flagged: false, details: [LABEL_NODE] },
    ],
  });
}

/** `settingsViolations()` 的失败信息首行。 */
const SETTINGS_HEAD =
  `A11y_Scan a11y-settings（设置抽屉 · ${describeTheme(THEME_UNSET)}）报出 2 条违规规则：` +
  `color-contrast（serious，2 个节点）、label（未给出，1 个节点）；${BLOCKING}`;

test.describe("A11y_Scan 违规时的失败信息（RDF 任务 17.2）", () => {
  test("RDF 15.2 formatA11yViolations：0 条违规只有首行、不含换行；规则没有节点明细时写“（没有节点明细）”", () => {
    const message = formatA11yViolations(okResult("a11y-contrast-dark"));
    expect(message).toBe(`A11y_Scan a11y-contrast-dark（阅读器正文 · ${describeTheme("dark")}）报出 0 条违规规则`);
    expect(message).not.toContain("\n");

    const empty = okResult("a11y-shelf", {
      violations: [{ id: "region", impact: "moderate", nodes: 0, flagged: false, details: [] }],
    });
    expect(formatA11yViolations(empty).split("\n")).toEqual([
      `A11y_Scan a11y-shelf（书架首屏 · ${describeTheme(THEME_UNSET)}）报出 1 条违规规则：region（moderate，0 个节点）；${BLOCKING}`,
      "",
      "1. region（moderate），0 个节点",
      "   （没有节点明细）",
    ]);
  });

  test("RDF 15.2 formatA11yViolations：首行概括全部规则，其后逐条规则列出每个节点的 target、html、failureSummary 与对比度数据；多项 target 以 → 连接，html 的换行折成空格，failureSummary 保留分行，空字段写“—”，影响级别缺失写“未给出”", () => {
    expect(formatA11yViolations(settingsViolations())).toBe(
      [
        SETTINGS_HEAD,
        "",
        "1. color-contrast（serious），2 个节点",
        "   节点 1/2",
        "     target：#settings-panel .hint",
        '     html：<p class="hint"> 字号 </p>',
        "     failureSummary：Fix any of the following:",
        "       Element has insufficient color contrast of 3.2 (foreground color: #8a8a8a, background color: #f5ecd9, " +
          "font size: 10.5pt (14px), font weight: normal). Expected contrast ratio of 4.5:1",
        "     对比度：前景色 #8a8a8a；背景色 #f5ecd9；实测对比度 3.2；要求的对比度 4.5:1；字号 10.5pt (14px)；字重 normal",
        // 没有对比度数据的节点不写对比度一行
        "   节点 2/2",
        "     target：iframe#reader → #b",
        "     html：—",
        "     failureSummary：Fix all of the following:",
        "       a",
        "       b",
        "",
        "2. label（未给出），1 个节点",
        "   节点 1/1",
        "     target：#font-size",
        '     html：<input id="font-size" type="range">',
        "     failureSummary：—",
      ].join("\n"),
    );
  });

  test("RDF 15.3 formatA11yViolations：incomplete（即使带节点明细）不进入失败信息", () => {
    const pending: A11yNodeDetail = {
      target: ["#pending"],
      html: "<em>待定</em>",
      failureSummary: "Fix any of the following:\n  y",
      contrast: { fgColor: "#abcdef", bgColor: "", contrastRatio: 0, expectedContrastRatio: "4.5:1", fontSize: "12.0pt (16px)", fontWeight: "bold" },
    };
    const incomplete = [{ id: "aria-allowed-role", nodes: 1, details: [pending] }];
    const withIncomplete: A11yScanResult = { ...settingsViolations(), incomplete };

    const message = formatA11yViolations(withIncomplete);
    expect(message).toBe(formatA11yViolations(settingsViolations()));
    for (const text of ["aria-allowed-role", "#pending", "待定", "#abcdef", "incomplete"]) {
      expect(message, text).not.toContain(text);
    }
    // 只有 incomplete、没有违规：仍只有"报出 0 条违规规则"的首行
    expect(formatA11yViolations(okResult("a11y-detail", { incomplete }))).toBe(
      `A11y_Scan a11y-detail（书籍详情弹窗 · ${describeTheme(THEME_UNSET)}）报出 0 条违规规则`,
    );
  });

  test("RDF 15.2 formatA11yViolations 是纯函数：不修改参数，同一输入两次结果相同", () => {
    const input: A11yScanResult = {
      ...settingsViolations(),
      incomplete: [{ id: "color-contrast", nodes: 1, details: details("i", 1) }],
    };
    const before = structuredClone(input);
    const first = formatA11yViolations(input);
    expect(input).toEqual(before);
    expect(formatA11yViolations(input)).toBe(first);
    expect(input).toEqual(before);
  });

  test("RDF 15.2 失败信息首行单独成句：含扫描名、视图、主题与每条违规规则的 id，reporter 取的错误信息首行即此行", () => {
    const toc = okResult("a11y-contrast-toc-black", {
      violations: [{ id: "color-contrast", impact: "serious", nodes: 1, flagged: true, details: [CONTRAST_NODE] }],
    });
    const cases: [A11yScanResult, string, string, string[]][] = [
      [settingsViolations(), "设置抽屉", describeTheme(THEME_UNSET), ["color-contrast", "label"]],
      [toc, "目录抽屉", describeTheme("black"), ["color-contrast"]],
    ];
    for (const [result, view, theme, ids] of cases) {
      const message = formatA11yViolations(result);
      const head = message.split("\n")[0];
      expect(firstLine(message), result.name).toBe(head);
      expect(head, result.name).toContain(`A11y_Scan ${result.name}（${view} · ${theme}）`);
      expect(head, result.name).toContain(`报出 ${ids.length} 条违规规则`);
      for (const id of ids) expect(head, `${result.name} ${id}`).toContain(id);
      expect(head.endsWith(BLOCKING), result.name).toBe(true);
    }
    expect(formatA11yViolations(settingsViolations()).split("\n")[0]).toBe(SETTINGS_HEAD);
  });

  test("RDF 15.2、15.3 Run_Summary：有违规的扫描所在用例失败，失败用例清单的错误信息首行即失败信息首行，A11y_Scan 一节写明违规即判失败、incomplete 只列出", () => {
    const result: A11yScanResult = {
      ...settingsViolations(),
      incomplete: [{ id: "color-contrast", nodes: 2, details: details("pending", 2) }],
    };
    const message = formatA11yViolations(result);
    // Playwright 的 expect 带说明时，错误信息以说明开头、其后是匹配器的输出
    const error = `Error: ${message}\n\nexpect(received).toBe(expected) // Object.is equality\n\nExpected: 0\nReceived: 2`;
    const cases = A11Y_SCANS.map((def) =>
      def.name === "a11y-settings"
        ? scanCase(def.name, { status: "failed", errors: [error], attachments: [attachment(result)] })
        : scanCase(def.name, { attachments: [attachment(okResult(def.name))] }),
    );
    const { data, lines } = section(cases);
    expect(data.problems).toEqual([]);

    expect(lines).toContain(
      "- 判定（RDF 15.2、15.3）：任一违规即判该扫描的用例失败，失败信息列出规则 id、影响级别与节点明细；" +
        "incomplete 只列出，不使用例失败；扫描失败、跳过与未执行的扫描没有 axe 结果，" +
        '违规数写"没有结果"，不计为 0（15.9）',
    );
    // 用例失败不影响该扫描的结果：附件照常采用，违规与 incomplete 都列出
    const body = bodyOf(lines, "a11y-settings");
    expect(body.slice(0, 3)).toEqual(["- 扫描：`a11y-settings`；结果：完成", "- 用例结果：失败", "- 违规数：2"]);
    expect(body).toContain(`| \`color-contrast\` | serious | 2 | ${FLAG} |`);
    expect(body).toContain("| `label` | 未给出 | 1 | — |");
    expect(body).toContain("- 违规 `color-contrast`（serious）的节点明细，共 2 个：");
    expect(body).toContain("- 违规 `label`（未给出）的节点明细，共 1 个：");
    expect(body.slice(-5)).toEqual([
      "- incomplete（axe 判为需人工复核）：1",
      "",
      "| 规则 id | 节点数 |",
      "| --- | ---: |",
      "| `color-contrast` | 2 |",
    ]);
    expect(body.join("\n")).not.toContain("#pending");

    const model = buildRunSummary(runFacts(cases, lines, "failed"));
    expect(model.exitCode).toBe(1);
    // 失败用例清单中唯一的一项：续行缩进为列表标记"1. "的宽度
    const md = renderSummary(model).split("\n");
    expect(md).toContain(`   - 错误信息首行：Error: ${SETTINGS_HEAD}`);
  });
});
