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
 */
import { expect, test } from "@playwright/test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { A11Y_SPEC_FILE, buildA11ySection, renderA11ySection, type A11ySectionData } from "../../a11y/report";
import {
  A11Y_RESULT_ATTACHMENT,
  A11Y_SCANS,
  a11yScan,
  a11yTestTitle,
  describeA11yScan,
  type A11yScanName,
} from "../../a11y/scans";
import type { A11yScanResult } from "../../a11y/summarize";
import { THEME_UNSET, describeTheme } from "../../support/theme";
import {
  buildRunSummary,
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

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

test.describe("A11y_Scan 一节（任务 20.5）", () => {
  test("11 次扫描都完成：按 A11Y_SCANS 的顺序逐节列出，critical 与 serious 标记、minor 与 moderate 只列出，无违规写违规数 0", () => {
    const settings = okResult("a11y-settings", {
      violations: [
        // flagged 故意写反：标记只看影响级别（15.5）
        { id: "label", impact: "critical", nodes: 2, flagged: false },
        { id: "color-contrast", impact: "serious", nodes: 3, flagged: true },
        { id: "region", impact: "moderate", nodes: 1, flagged: true },
        { id: "list", impact: "minor", nodes: 1, flagged: false },
      ],
      incomplete: [{ id: "color-contrast", nodes: 4 }],
    });
    // 用例顺序与 A11Y_SCANS 相反：节序只取 A11Y_SCANS
    const cases = [...A11Y_SCANS].reverse().map((def) =>
      scanCase(def.name, { attachments: [attachment(def.name === "a11y-settings" ? settings : okResult(def.name))] }),
    );
    const { data, lines } = section(cases);

    expect(A11Y_SCANS).toHaveLength(11);
    expect(data.entries.map((e) => e.name)).toEqual(A11Y_SCANS.map((d) => d.name));
    expect(data.entries.every((e) => e.result.kind === "ok")).toBe(true);
    expect(data.axeVersions).toEqual([AXE_VERSION]);
    expect(data.problems).toEqual([]);

    // 15.4：11 节，节名标明视图与主题
    expect(headings(lines)).toEqual(A11Y_SCANS.map((d, i) => `### ${i + 1}. ${describeA11yScan(d)}`));
    expect(headings(lines)[0]).toBe("### 1. 书架首屏 · " + describeTheme(THEME_UNSET));
    expect(headings(lines)[10]).toMatch(/^### 11\. 阅读器正文 · .+ · 仅 color-contrast$/);

    expect(lines).toContain(`- axe-core：${AXE_VERSION}`);
    expect(lines).toContain("- 结果：完成 11、扫描失败 0、跳过 0、未执行 0（共 11 次）");
    expect(lines.some((l) => l.includes("4 条违规规则，其中 critical 或 serious 2 条") && l.includes(FLAG))).toBe(true);
    expect(lines.some((l) => l.includes("不影响用例结果与退出码"))).toBe(true);

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
      // 5 次对比度扫描本次未收集
    ]);

    expect(data.collected).toBe(6);
    expect(data.entries.map((e) => e.result.kind)).toEqual([
      "failed", "skipped", "failed", "notRun", "skipped", "failed",
      "notRun", "notRun", "notRun", "notRun", "notRun",
    ]);
    expect(data.axeVersions).toEqual([]);
    expect(lines).toContain("- axe-core：未知（没有完成的扫描）");
    expect(lines).toContain("- 结果：完成 0、扫描失败 3、跳过 2、未执行 6（共 11 次）");
    expect(headings(lines)).toHaveLength(11);

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
        attachments: [attachment(okResult("a11y-shelf", { violations: [{ id: "region", impact: "moderate", nodes: 5, flagged: false }] }))],
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

  test("A11y_Scan 违规不影响退出码：用例全部通过时退出码为 0，summary 的 A11y_Scan 一节即本节正文", () => {
    const critical = okResult("a11y-settings", { violations: [{ id: "label", impact: "critical", nodes: 2, flagged: true }] });
    const cases = A11Y_SCANS.map((def) =>
      scanCase(def.name, { attachments: [attachment(def.name === "a11y-settings" ? critical : okResult(def.name))] }),
    );
    const { lines } = section(cases);
    const facts: RunFacts = {
      startTime: new Date("2025-06-01T12:00:00.000Z"),
      durationMs: 60_000,
      status: "passed",
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
    const model = buildRunSummary(facts);
    expect(model.exitCode).toBe(0);
    expect(model.runLevel).toEqual([]);

    const md = renderSummary(model).split("\n");
    const start = md.indexOf(SUMMARY_HEADINGS.a11y);
    expect(start).toBeGreaterThan(-1);
    expect(md.slice(start + 2, start + 2 + lines.length)).toEqual(lines);
    expect(md.some((l) => l.includes(`| \`label\` | critical | 2 | ${FLAG} |`))).toBe(true);
  });
});
