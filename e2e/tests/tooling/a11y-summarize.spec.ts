/**
 * A11y_Scan 结果归纳的无浏览器测试（`tooling` 项目；设计"无障碍冒烟（需求 15）"与 Testing Strategy）。
 *
 * - `summarizeAxe`：属性 10（axe 结果归纳，需求 15.4、15.5）与定向例子。只调用纯函数，不启动
 *   浏览器、不注入 axe。输入按 `AxeBuilder.analyze()` 结果的形状生成：除用到的 `id`、`impact`、
 *   `nodes` 外还带 `description`、`help`、`helpUrl`、`tags` 等字段，核对它们不进入输出。
 * - 影响级别与标记原文按需求原文写成字面量（4 级、serious 与 critical、"待记入 Findings_Log"），
 *   期望值不从被测代码的常量推出。
 */
import { expect, test } from "@playwright/test";
import fc from "fast-check";
import assert from "node:assert/strict";
import {
  FINDINGS_FLAG_LABEL,
  FLAGGED_IMPACTS,
  IMPACTS,
  summarizeAxe,
  type A11yAxeSummary,
  type AxeResultsLike,
  type AxeRuleResultLike,
  type Impact,
} from "../../a11y/summarize";

/** 15.4 的 4 个影响级别，按需求原文写成字面量。 */
const LEVELS = ["minor", "moderate", "serious", "critical"] as const satisfies readonly Impact[];

/** 15.5：需标"待记入 Findings_Log"的级别，按需求原文写成字面量。 */
function expectFlagged(impact: Impact | null | undefined): boolean {
  return impact === "serious" || impact === "critical";
}

// ---------------------------------------------------------------------------
// 属性 10 的判定
// ---------------------------------------------------------------------------

/**
 * 按属性 10 逐条核对 `summarizeAxe(results)`：
 * - 违规规则 id 序列与输入相同（不排序、不去重、不过滤）；
 * - 每条违规的 `nodes` 等于输入 `nodes` 的长度，`impact` 为输入的级别（缺失记为 null），
 *   `flagged` 当且仅当级别为 serious 或 critical；输出只含这 4 个字段；
 * - incomplete 同样逐条保留 id 与节点数，只含这 2 个字段（不带影响级别，也不做 15.5 的标记）；
 * - `axeVersion` 取 `testEngine.version`；
 * - 不修改输入；输出经 JSON 往返不变（`scan.ts` 把它写入 `e2e/.out/a11y/<name>.json`，reporter
 *   读回的必须是同一份内容，缺失的级别不能在往返中丢掉）。
 *
 * 属性内用 `node:assert` 而不是 Playwright 的 `expect`，理由同 `server-resolve.spec.ts`：
 * 每次 `expect` 都会在报告里记一个步骤。
 */
function assertSummary(results: AxeResultsLike): A11yAxeSummary {
  const where = `results=${JSON.stringify(results)}`;
  const snapshot = structuredClone(results);
  const out = summarizeAxe(results);

  assert.deepEqual(results, snapshot, `不修改输入（${where}）`);

  assert.deepEqual(
    out.violations.map((v) => v.id),
    results.violations.map((r) => r.id),
    `违规规则 id 序列与输入相同（${where}）`,
  );
  results.violations.forEach((rule, i) => {
    assert.deepEqual(
      out.violations[i],
      {
        id: rule.id,
        impact: rule.impact ?? null,
        nodes: rule.nodes.length,
        flagged: expectFlagged(rule.impact),
      },
      `第 ${i} 条违规（${where}）`,
    );
  });

  assert.deepEqual(
    out.incomplete.map((r) => r.id),
    results.incomplete.map((r) => r.id),
    `incomplete 规则 id 序列与输入相同（${where}）`,
  );
  results.incomplete.forEach((rule, i) => {
    assert.deepEqual(out.incomplete[i], { id: rule.id, nodes: rule.nodes.length }, `第 ${i} 条 incomplete（${where}）`);
  });

  assert.equal(out.axeVersion, results.testEngine.version, `axeVersion（${where}）`);
  assert.deepEqual(Object.keys(out).sort(), ["axeVersion", "incomplete", "violations"], `输出字段（${where}）`);
  assert.deepEqual(JSON.parse(JSON.stringify(out)), out, `输出经 JSON 往返不变（${where}）`);
  return out;
}

// ---------------------------------------------------------------------------
// 生成器
// ---------------------------------------------------------------------------

/**
 * 规则 id：4 个 WCAG 标签下常见的 axe 规则（从小集合里取，同一 id 常在一个列表中重复出现，
 * 用来核对不去重），以及任意 Unicode 串（含空串与孤立代理项）。
 */
const RULE_IDS = [
  "color-contrast",
  "button-name",
  "link-name",
  "image-alt",
  "label",
  "aria-allowed-attr",
  "aria-required-children",
  "aria-required-parent",
  "aria-dialog-name",
  "nested-interactive",
  "scrollable-region-focusable",
  "list",
  "listitem",
  "document-title",
  "html-has-lang",
] as const;

const ruleIdArb = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom(...RULE_IDS) },
  { weight: 1, arbitrary: fc.string({ unit: "binary", maxLength: 24 }) },
);

/** axe 的节点结果中常见的字段；内容与归纳无关，只有个数计入。 */
const nodeArb = fc.record({
  html: fc.string({ maxLength: 40 }),
  target: fc.array(fc.string({ maxLength: 16 }), { minLength: 1, maxLength: 3 }),
  failureSummary: fc.string({ maxLength: 40 }),
});

/** 节点列表：多数很短（含空列表），少数长到几百个节点（整页扫描时 color-contrast 常见）。 */
const nodesArb: fc.Arbitrary<unknown[]> = fc.oneof(
  { weight: 4, arbitrary: fc.array(nodeArb, { maxLength: 8 }) },
  {
    weight: 1,
    arbitrary: fc
      .nat({ max: 400 })
      .map((n) => Array.from({ length: n }, (_, i) => ({ html: "<p></p>", target: [`#n${i}`] }))),
  },
);

/**
 * 一条规则结果：`impact` 取 4 级之一或 null，也可缺省（axe-core 的类型里是可选字段）；其余
 * 字段是 axe 结果中本就存在、归纳时应丢弃的内容。
 */
const ruleArb: fc.Arbitrary<AxeRuleResultLike> = fc.record(
  {
    id: ruleIdArb,
    impact: fc.constantFrom<Impact | null>(...LEVELS, null),
    nodes: nodesArb,
    description: fc.string({ maxLength: 30 }),
    help: fc.string({ maxLength: 30 }),
    helpUrl: fc.constant("https://dequeuniversity.com/rules/axe/4.11/x"),
    tags: fc.subarray(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "cat.color"]),
  },
  { requiredKeys: ["id", "nodes", "description", "help", "helpUrl", "tags"] },
);

const rulesArb = fc.array(ruleArb, { maxLength: 12 });

const axeResultsArb: fc.Arbitrary<AxeResultsLike> = fc.record({
  violations: rulesArb,
  incomplete: rulesArb,
  testEngine: fc.record({
    name: fc.constant("axe-core"),
    version: fc.oneof(fc.constantFrom("4.11.1", "4.10.3"), fc.string({ maxLength: 12 })),
  }),
});

test.describe("summarizeAxe（需求 15.4、15.5）", () => {
  // Feature: e2e-visual-testing, Property 10: axe 结果归纳
  // **Validates: Requirements 15.4, 15.5**
  test("属性 10：任意 axe 结果（违规与 incomplete 各为任意规则列表，影响级别取 4 级之一或 null，节点列表任意长），违规规则 id 序列与输入相同，每条 nodes 等于节点列表长度，flagged 当且仅当级别为 serious 或 critical；incomplete 逐条保留 id 与节点数", () => {
    fc.assert(
      fc.property(axeResultsArb, (results) => {
        assertSummary(results);
      }),
      { numRuns: 100 },
    );
  });

  // -------------------------------------------------------------------------
  // 例子
  // -------------------------------------------------------------------------

  test("影响级别与标记取自 15.4、15.5：4 级自轻到重，serious 与 critical 标记原文为“待记入 Findings_Log”", () => {
    expect(IMPACTS).toEqual(LEVELS);
    expect(FLAGGED_IMPACTS).toEqual(["serious", "critical"]);
    expect(FINDINGS_FLAG_LABEL).toBe("待记入 Findings_Log");
  });

  test("一份整页扫描结果：4 个级别各一条违规，只有 serious 与 critical 带标记；incomplete 只留 id 与节点数；其余字段丢弃", () => {
    const node = (target: string) => ({ html: `<div id="${target}"></div>`, target: [`#${target}`], failureSummary: "Fix any of the following" });
    const results = {
      violations: [
        { id: "region", impact: "moderate", tags: ["best-practice"], description: "d", help: "h", helpUrl: "u", nodes: [node("a")] },
        { id: "color-contrast", impact: "serious", tags: ["wcag2aa"], description: "d", help: "h", helpUrl: "u", nodes: [node("b"), node("c"), node("d")] },
        { id: "button-name", impact: "critical", tags: ["wcag2a"], description: "d", help: "h", helpUrl: "u", nodes: [node("e"), node("f")] },
        { id: "list", impact: "minor", tags: ["wcag2a"], description: "d", help: "h", helpUrl: "u", nodes: [node("g")] },
      ],
      incomplete: [
        { id: "color-contrast", impact: "serious", tags: ["wcag2aa"], description: "d", help: "h", helpUrl: "u", nodes: [node("h"), node("i")] },
      ],
      passes: [{ id: "html-has-lang", impact: null, nodes: [node("html")] }],
      testEngine: { name: "axe-core", version: "4.11.1" },
      url: "http://127.0.0.1:4611/",
    } as const;

    expect(summarizeAxe(results)).toEqual({
      violations: [
        { id: "region", impact: "moderate", nodes: 1, flagged: false },
        { id: "color-contrast", impact: "serious", nodes: 3, flagged: true },
        { id: "button-name", impact: "critical", nodes: 2, flagged: true },
        { id: "list", impact: "minor", nodes: 1, flagged: false },
      ],
      incomplete: [{ id: "color-contrast", nodes: 2 }],
      axeVersion: "4.11.1",
    });
  });

  test("没有违规时 violations 为空数组（reporter 据此写“违规数 0”），incomplete 照常列出", () => {
    const out = summarizeAxe({
      violations: [],
      incomplete: [{ id: "color-contrast", impact: "serious", nodes: [{}, {}, {}, {}] }],
      testEngine: { version: "4.11.1" },
    });
    expect(out.violations).toEqual([]);
    expect(out.incomplete).toEqual([{ id: "color-contrast", nodes: 4 }]);
  });

  test("不排序、不去重、不过滤：重复 id 与 0 个节点的规则原样保留、按输入顺序", () => {
    const out = summarizeAxe({
      violations: [
        { id: "label", impact: "critical", nodes: [{}] },
        { id: "color-contrast", impact: "serious", nodes: [] },
        { id: "label", impact: "minor", nodes: [{}, {}] },
      ],
      incomplete: [
        { id: "b", nodes: [] },
        { id: "a", nodes: [{}] },
        { id: "b", nodes: [{}] },
      ],
      testEngine: { version: "4.11.1" },
    });
    expect(out.violations).toEqual([
      { id: "label", impact: "critical", nodes: 1, flagged: true },
      { id: "color-contrast", impact: "serious", nodes: 0, flagged: true },
      { id: "label", impact: "minor", nodes: 2, flagged: false },
    ]);
    expect(out.incomplete).toEqual([
      { id: "b", nodes: 0 },
      { id: "a", nodes: 1 },
      { id: "b", nodes: 1 },
    ]);
  });

  test("影响级别缺失、为 null 或不在 4 级之内时记为 null，不带标记", () => {
    const out = summarizeAxe({
      violations: [
        { id: "missing", nodes: [{}] },
        { id: "null", impact: null, nodes: [{}] },
        // 运行时防御：axe 将来改动取值时不误标，也不把大小写不同的值当作 serious
        { id: "upper", impact: "Serious" as unknown as Impact, nodes: [{}] },
        { id: "other", impact: "high" as unknown as Impact, nodes: [{}] },
      ],
      incomplete: [],
      testEngine: { version: "4.11.1" },
    });
    expect(out.violations).toEqual([
      { id: "missing", impact: null, nodes: 1, flagged: false },
      { id: "null", impact: null, nodes: 1, flagged: false },
      { id: "upper", impact: null, nodes: 1, flagged: false },
      { id: "other", impact: null, nodes: 1, flagged: false },
    ]);
    // 缺失的级别写成 null 而不是 undefined，写入 JSON 后不会丢掉该字段
    expect(JSON.parse(JSON.stringify(out.violations[0]))).toHaveProperty("impact", null);
  });
});
