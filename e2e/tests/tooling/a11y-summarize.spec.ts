/**
 * A11y_Scan 结果归纳的无浏览器测试（`tooling` 项目；设计"无障碍冒烟（需求 15）"与 Testing Strategy）。
 *
 * - `summarizeAxe`：属性 10（axe 结果归纳，需求 15.4、15.5）与定向例子。只调用纯函数，不启动
 *   浏览器、不注入 axe。输入按 `AxeBuilder.analyze()` 结果的形状生成：除用到的 `id`、`impact`、
 *   `nodes` 外还带 `description`、`help`、`helpUrl`、`tags` 等字段，核对它们不进入输出。
 * - 影响级别与标记原文按需求原文写成字面量（4 级、serious 与 critical、"待记入 Findings_Log"），
 *   期望值不从被测代码的常量推出。
 * - 节点明细：reader-defect-fixes（RDF）的属性 8（需求 15.2–15.4）与定向例子。节点按 axe-core
 *   `NodeResult` 的形状生成：`target` 含 shadow DOM 的嵌套选择器，`html` 长短不一（含 CJK 与
 *   代理对，长度跨过 200），`failureSummary` 可缺失，`any[0].data` 齐全、缺字段、类型不符或缺失。
 *   期望值由 `expectedDetail` 按 RDF 设计第 14 节与属性 8 的文字逐字段写出，上限、省略号与连接符
 *   写成字面量，不调用被测代码的 `summarizeNode`、`truncateHtml`、`selectorText`。
 */
import { expect, test } from "@playwright/test";
import fc from "fast-check";
import assert from "node:assert/strict";
import {
  FINDINGS_FLAG_LABEL,
  FLAGGED_IMPACTS,
  HTML_ELLIPSIS,
  HTML_MAX_LENGTH,
  IMPACTS,
  SHADOW_SELECTOR_SEPARATOR,
  summarizeAxe,
  type A11yAxeSummary,
  type A11yNodeDetail,
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

/** `n` 个空节点（`{}`）的明细：target、html、failureSummary 都取缺失时的写法（RDF 15.4）。 */
function emptyDetails(n: number): A11yNodeDetail[] {
  return Array.from({ length: n }, () => ({ target: [], html: "", failureSummary: "" }));
}

// ---------------------------------------------------------------------------
// 属性 10 的判定
// ---------------------------------------------------------------------------

/**
 * 按属性 10 逐条核对 `summarizeAxe(results)`：
 * - 违规规则 id 序列与输入相同（不排序、不去重、不过滤）；
 * - 每条违规的 `nodes` 等于输入 `nodes` 的长度，`impact` 为输入的级别（缺失记为 null），
 *   `flagged` 当且仅当级别为 serious 或 critical；除节点明细 `details` 外只含这 4 个字段；
 * - incomplete 同样逐条保留 id 与节点数，除 `details` 外只含这 2 个字段（不带影响级别，也不做
 *   15.5 的标记）；
 * - 两者的 `details` 与输入节点一一对应（长度等于 `nodes`；各字段的写法见 reader-defect-fixes
 *   的 Property 8）；
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
    const { details, ...summary } = out.violations[i];
    assert.deepEqual(
      summary,
      {
        id: rule.id,
        impact: rule.impact ?? null,
        nodes: rule.nodes.length,
        flagged: expectFlagged(rule.impact),
      },
      `第 ${i} 条违规（${where}）`,
    );
    assert.equal(details.length, rule.nodes.length, `第 ${i} 条违规的 details 与节点一一对应（${where}）`);
  });

  assert.deepEqual(
    out.incomplete.map((r) => r.id),
    results.incomplete.map((r) => r.id),
    `incomplete 规则 id 序列与输入相同（${where}）`,
  );
  results.incomplete.forEach((rule, i) => {
    const { details, ...summary } = out.incomplete[i];
    assert.deepEqual(summary, { id: rule.id, nodes: rule.nodes.length }, `第 ${i} 条 incomplete（${where}）`);
    assert.equal(details.length, rule.nodes.length, `第 ${i} 条 incomplete 的 details 与节点一一对应（${where}）`);
  });

  assert.equal(out.axeVersion, results.testEngine.version, `axeVersion（${where}）`);
  assert.deepEqual(Object.keys(out).sort(), ["axeVersion", "incomplete", "violations"], `输出字段（${where}）`);
  assert.deepEqual(JSON.parse(JSON.stringify(out)), out, `输出经 JSON 往返不变（${where}）`);
  return out;
}

// ---------------------------------------------------------------------------
// RDF 属性 8 的判定：节点明细
// ---------------------------------------------------------------------------

/** axe-core `CheckResult` 的形状（节点 `any` 的元素）；`data` 的内容随检查项而定，可缺失。 */
interface AxeCheckInput {
  id: string;
  impact: Impact;
  message: string;
  relatedNodes: unknown[];
  data?: unknown;
}

/**
 * 生成器给出的 axe 节点（axe-core `NodeResult` 的形状）。归纳只读 `target`、`html`、
 * `failureSummary` 与 `any[0].data`，其余字段应被丢弃。
 */
interface AxeNodeInput {
  /** 一项为字符串，或 shadow DOM 中自外层宿主到内层元素的选择器数组。 */
  target: (string | string[])[];
  html: string;
  failureSummary?: string;
  impact?: Impact | null;
  any?: AxeCheckInput[];
  all: unknown[];
  none: unknown[];
}

/** 节点类型为 `N` 的规则结果（生成器的输出类型，可直接交给 `summarizeAxe`）。 */
interface AxeRuleOf<N> extends AxeRuleResultLike {
  nodes: N[];
}

/** 节点类型为 `N` 的 axe 结果。 */
interface AxeResultsOf<N> extends AxeResultsLike {
  violations: AxeRuleOf<N>[];
  incomplete: AxeRuleOf<N>[];
}

/**
 * 一个节点应得的明细，按 RDF 设计第 14 节与属性 8 的文字逐字段写出（长度按 UTF-16 码元计）：
 * - `target`：逐项转换，字符串原样，数组以 " >>> " 连接；
 * - `html`：不超过 200 个码元时原样，否则为前 199 个码元加 "…"（截断处可能切开代理对）；
 * - `failureSummary`：输入值，缺失时为空串；
 * - `contrast`：当且仅当规则 id 恰为 `color-contrast` 且 `any[0].data` 为对象时存在，只含 6 个
 *   字段：字符串字段缺失或类型不符时为空串；`contrastRatio` 为有限数时原样（`-0` 记为 0），否则为 0。
 */
function expectedDetail(ruleId: string, node: AxeNodeInput): A11yNodeDetail {
  const detail: A11yNodeDetail = {
    target: node.target.map((item) => (typeof item === "string" ? item : item.join(" >>> "))),
    html: node.html.length <= 200 ? node.html : `${node.html.slice(0, 199)}…`,
    failureSummary: node.failureSummary ?? "",
  };
  const data = node.any?.[0]?.data;
  if (ruleId === "color-contrast" && typeof data === "object" && data !== null && !Array.isArray(data)) {
    const fields = data as Record<string, unknown>;
    const text = (key: string): string => {
      const value = fields[key];
      return typeof value === "string" ? value : "";
    };
    const ratio = fields.contrastRatio;
    detail.contrast = {
      fgColor: text("fgColor"),
      bgColor: text("bgColor"),
      // -0 !== 0 为假，-0 也落到 0
      contrastRatio: typeof ratio === "number" && Number.isFinite(ratio) && ratio !== 0 ? ratio : 0,
      expectedContrastRatio: text("expectedContrastRatio"),
      fontSize: text("fontSize"),
      fontWeight: text("fontWeight"),
    };
  }
  return detail;
}

/**
 * 按 RDF 属性 8 核对 `summarizeAxe(results)`：
 * - 先按属性 10 逐条核对（`assertSummary`：规则顺序、计数、标记、不修改输入、输出经 JSON 往返不变，
 *   往返覆盖全部明细）；
 * - 再核对每条违规与每条 incomplete 的 `details` 与输入节点逐一对应、顺序相同，每项等于
 *   `expectedDetail`（`contrast` 键的有无也在比较之内），`html` 不超过 200 个码元。
 *
 * 失败信息只写规则位置与 id：完整输入见 fast-check 给出的反例。
 */
function assertDetails(results: AxeResultsOf<AxeNodeInput>): void {
  const out = assertSummary(results);
  const check = (kind: string, rules: readonly AxeRuleOf<AxeNodeInput>[], details: readonly A11yNodeDetail[][]) => {
    rules.forEach((rule, i) => {
      const where = `第 ${i} 条${kind}（id=${JSON.stringify(rule.id)}）`;
      assert.deepEqual(
        details[i],
        rule.nodes.map((node) => expectedDetail(rule.id, node)),
        `${where}的 details 与输入节点逐一对应`,
      );
      details[i].forEach((detail, j) => {
        assert.ok(detail.html.length <= 200, `${where}第 ${j} 个节点的 html 长 ${detail.html.length}，超过 200`);
      });
    });
  };
  check("违规", results.violations, out.violations.map((v) => v.details));
  check(" incomplete ", results.incomplete, out.incomplete.map((r) => r.details));
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

/** axe 的节点结果中常见的字段；属性 10 只核对个数，明细的写法由属性 8 核对。 */
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
 * axe 结果：违规与 incomplete 各为至多 `maxRules` 条规则。一条规则结果的 `impact` 取 4 级之一
 * 或 null，也可缺省（axe-core 的类型里是可选字段）；其余字段是 axe 结果中本就存在、归纳时应丢弃
 * 的内容。
 */
function axeResultsArbOf<N>(
  idArb: fc.Arbitrary<string>,
  nodesOfRuleArb: fc.Arbitrary<N[]>,
  maxRules: number,
): fc.Arbitrary<AxeResultsOf<N>> {
  const ruleArb: fc.Arbitrary<AxeRuleOf<N>> = fc.record(
    {
      id: idArb,
      impact: fc.constantFrom<Impact | null>(...LEVELS, null),
      nodes: nodesOfRuleArb,
      description: fc.string({ maxLength: 30 }),
      help: fc.string({ maxLength: 30 }),
      helpUrl: fc.constant("https://dequeuniversity.com/rules/axe/4.11/x"),
      tags: fc.subarray(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "cat.color"]),
    },
    { requiredKeys: ["id", "nodes", "description", "help", "helpUrl", "tags"] },
  );
  const rulesArb = fc.array(ruleArb, { maxLength: maxRules });
  return fc.record({
    violations: rulesArb,
    incomplete: rulesArb,
    testEngine: fc.record({
      name: fc.constant("axe-core"),
      version: fc.oneof(fc.constantFrom("4.13.0", "4.11.1", "4.10.3"), fc.string({ maxLength: 12 })),
    }),
  });
}

/** 属性 10 的输入。 */
const axeResultsArb = axeResultsArbOf(ruleIdArb, nodesArb, 12);

// ---------------------------------------------------------------------------
// RDF 属性 8 的生成器
// ---------------------------------------------------------------------------

/** 选择器：常见写法（含中文属性值）与任意 Unicode 串（含空串）。 */
const selectorArb = fc.oneof(
  {
    weight: 2,
    arbitrary: fc.constantFrom(
      "html",
      "#root",
      ".book-card:nth-child(2) > h3",
      'button[aria-label="关闭目录"]',
      "reader-view",
      "p.muted",
    ),
  },
  { weight: 1, arbitrary: fc.string({ unit: "binary", maxLength: 16 }) },
);

/** `target` 的一项：字符串，或 shadow DOM 中自外层宿主到内层元素的选择器数组。 */
const targetItemArb: fc.Arbitrary<string | string[]> = fc.oneof(
  { weight: 3, arbitrary: selectorArb },
  { weight: 1, arbitrary: fc.array(selectorArb, { minLength: 1, maxLength: 3 }) },
);

/** `html` 的组成单位：标记字符、CJK（1 个码元）与增补平面字符（代理对，2 个码元）。 */
const htmlUnitArb = fc.constantFrom("<", ">", "/", "=", '"', " ", "a", "div", "书", "页", "😀", "𠀀");

/**
 * `html`：短片段；100–320 个单位（约 100–960 个码元，多数超过 200）的长片段；以及长度恰在 200
 * 附近（196–206 个码元）的片段：`before` 个 "a"、1 个 `mid`、`after` 个 "b"。`before` 为 198、
 * `mid` 为代理对且总长超过 200 时，截断处正好切开代理对。
 */
const htmlArb = fc.oneof(
  { weight: 2, arbitrary: fc.string({ unit: "binary", maxLength: 60 }) },
  { weight: 2, arbitrary: fc.string({ unit: htmlUnitArb, minLength: 100, maxLength: 320 }) },
  {
    weight: 1,
    arbitrary: fc
      .record({
        before: fc.integer({ min: 195, max: 201 }),
        mid: fc.constantFrom("a", "书", "😀"),
        after: fc.nat({ max: 3 }),
      })
      .map(({ before, mid, after }) => `${"a".repeat(before)}${mid}${"b".repeat(after)}`),
  },
);

/** `failureSummary`：axe 的原文（含换行）、空串与任意串。 */
const failureSummaryArb = fc.oneof(
  fc.constantFrom(
    "Fix any of the following:\n  Element has insufficient color contrast of 4.47 (foreground color: #777777, background color: #ffffff, font size: 12.0pt (16px), font weight: normal). Expected contrast ratio of 4.5:1",
    "Fix any of the following:\n  Element's background color could not be determined due to a background gradient",
    "",
  ),
  fc.string({ unit: "binary", maxLength: 40 }),
);

const colorArb = fc.constantFrom("#777777", "#ffffff", "#1f2937", "rgba(0, 0, 0, 0.5)");
/** 实测对比度：0–21 的有限数，以及 -0（应记为 0）。 */
const ratioArb = fc.oneof(fc.double({ min: 0, max: 21, noNaN: true }), fc.constantFrom(0, -0, 1, 4.47, 21));
const expectedRatioArb = fc.constantFrom("4.5:1", "3:1", "7:1");
const fontSizeArb = fc.constantFrom("12.0pt (16px)", "13.5pt (18px)", "9.8pt (13px)", "18.0pt (24px)");
const fontWeightArb = fc.constantFrom("normal", "bold");
const messageKeyArb = fc.constantFrom(null, "bgGradient", "bgOverlap", "pseudoContent", "shortTextContent");
/** 字符串字段类型不符时的取值。 */
const notStringArb = fc.constantFrom<unknown>(16, 0, null, true, {}, ["#ffffff"]);
/** `contrastRatio` 类型不符或不是有限数时的取值（应记为 0）。 */
const notRatioArb = fc.constantFrom<unknown>("4.47", "", null, NaN, Infinity, -Infinity, false);

/** 多数取类型正确的值，少数取类型不符的值。 */
function mostlyRight(right: fc.Arbitrary<unknown>, wrong: fc.Arbitrary<unknown>): fc.Arbitrary<unknown> {
  return fc.oneof({ weight: 3, arbitrary: right }, { weight: 1, arbitrary: wrong });
}

/**
 * `color-contrast` 检查的 `data`：6 个字段齐全且类型正确（axe 对违规节点的写法）；或每个字段
 * 都可缺失、可类型不符（incomplete 节点常只给出一部分）。两种都可带 axe 另有的 `messageKey`，
 * 核对它不进入明细。
 */
const contrastDataArb = fc.oneof(
  fc.record(
    {
      fgColor: colorArb,
      bgColor: colorArb,
      contrastRatio: ratioArb,
      fontSize: fontSizeArb,
      fontWeight: fontWeightArb,
      messageKey: messageKeyArb,
      expectedContrastRatio: expectedRatioArb,
    },
    { requiredKeys: ["fgColor", "bgColor", "contrastRatio", "fontSize", "fontWeight", "expectedContrastRatio"] },
  ),
  fc.record(
    {
      fgColor: mostlyRight(colorArb, notStringArb),
      bgColor: mostlyRight(colorArb, notStringArb),
      contrastRatio: mostlyRight(ratioArb, notRatioArb),
      fontSize: mostlyRight(fontSizeArb, notStringArb),
      fontWeight: mostlyRight(fontWeightArb, notStringArb),
      messageKey: messageKeyArb,
      expectedContrastRatio: mostlyRight(expectedRatioArb, notStringArb),
    },
    { requiredKeys: [] },
  ),
);

/** 检查项的 `data`：多数为对比度数据；少数不是对象（null，或其它检查项给出的字符串、数），不得产生 `contrast`。 */
const checkDataArb = fc.oneof(
  { weight: 4, arbitrary: contrastDataArb },
  { weight: 1, arbitrary: fc.constantFrom<unknown>(null, "bgOverlap", 0) },
);

/** axe 的检查结果；`data` 可缺失。 */
const checkArb: fc.Arbitrary<AxeCheckInput> = fc.record(
  {
    id: fc.constantFrom("color-contrast", "has-visible-text", "aria-label"),
    impact: fc.constantFrom(...LEVELS),
    message: fc.string({ maxLength: 20 }),
    relatedNodes: fc.constant([]),
    data: checkDataArb,
  },
  { requiredKeys: ["id", "impact", "message", "relatedNodes"] },
);

/**
 * axe 节点：`target` 至多 3 项（含空数组）；`failureSummary` 可缺失；`any` 可缺失、可为空数组、
 * 可有 2 项（只有 `any[0]` 的 `data` 计入）。
 */
const detailNodeArb: fc.Arbitrary<AxeNodeInput> = fc.record(
  {
    target: fc.array(targetItemArb, { maxLength: 3 }),
    html: htmlArb,
    failureSummary: failureSummaryArb,
    impact: fc.constantFrom<Impact | null>(...LEVELS, null),
    any: fc.array(checkArb, { maxLength: 2 }),
    all: fc.constant([]),
    none: fc.constant([]),
  },
  { requiredKeys: ["target", "html", "all", "none"] },
);

/** 节点列表：多数很短（含空列表）；少数长到几百个（同一节点复制，`target` 各不相同，用来核对顺序）。 */
const detailNodesArb: fc.Arbitrary<AxeNodeInput[]> = fc.oneof(
  { weight: 4, arbitrary: fc.array(detailNodeArb, { maxLength: 6 }) },
  {
    weight: 1,
    arbitrary: fc
      .tuple(detailNodeArb, fc.nat({ max: 300 }))
      .map(([node, n]) => Array.from({ length: n }, (_, i): AxeNodeInput => ({ ...node, target: [`#n${i}`] }))),
  },
);

/**
 * 规则 id：多数为 `color-contrast`；也有同样带对比度数据、但不是 `color-contrast` 的规则
 * （`color-contrast-enhanced`、`link-in-text-block`）与大小写不同的写法，它们不得产生 `contrast`；
 * 其余取属性 10 的 id。
 */
const detailRuleIdArb = fc.oneof(
  { weight: 3, arbitrary: fc.constant("color-contrast") },
  { weight: 1, arbitrary: fc.constantFrom("color-contrast-enhanced", "link-in-text-block", "Color-Contrast") },
  { weight: 2, arbitrary: ruleIdArb },
);

/** 属性 8 的输入。 */
const detailResultsArb = axeResultsArbOf(detailRuleIdArb, detailNodesArb, 8);

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

  test("一份整页扫描结果：4 个级别各一条违规，只有 serious 与 critical 带标记；incomplete 只留 id、节点数与节点明细；其余字段丢弃", () => {
    const node = (target: string) => ({ html: `<div id="${target}"></div>`, target: [`#${target}`], failureSummary: "Fix any of the following" });
    // 节点没有 any[0].data，color-contrast 的明细也不带 contrast
    const detail = (target: string) => ({ target: [`#${target}`], html: `<div id="${target}"></div>`, failureSummary: "Fix any of the following" });
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
        { id: "region", impact: "moderate", nodes: 1, flagged: false, details: [detail("a")] },
        { id: "color-contrast", impact: "serious", nodes: 3, flagged: true, details: [detail("b"), detail("c"), detail("d")] },
        { id: "button-name", impact: "critical", nodes: 2, flagged: true, details: [detail("e"), detail("f")] },
        { id: "list", impact: "minor", nodes: 1, flagged: false, details: [detail("g")] },
      ],
      incomplete: [{ id: "color-contrast", nodes: 2, details: [detail("h"), detail("i")] }],
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
    expect(out.incomplete).toEqual([{ id: "color-contrast", nodes: 4, details: emptyDetails(4) }]);
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
      { id: "label", impact: "critical", nodes: 1, flagged: true, details: emptyDetails(1) },
      { id: "color-contrast", impact: "serious", nodes: 0, flagged: true, details: [] },
      { id: "label", impact: "minor", nodes: 2, flagged: false, details: emptyDetails(2) },
    ]);
    expect(out.incomplete).toEqual([
      { id: "b", nodes: 0, details: [] },
      { id: "a", nodes: 1, details: emptyDetails(1) },
      { id: "b", nodes: 1, details: emptyDetails(1) },
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
      { id: "missing", impact: null, nodes: 1, flagged: false, details: emptyDetails(1) },
      { id: "null", impact: null, nodes: 1, flagged: false, details: emptyDetails(1) },
      { id: "upper", impact: null, nodes: 1, flagged: false, details: emptyDetails(1) },
      { id: "other", impact: null, nodes: 1, flagged: false, details: emptyDetails(1) },
    ]);
    // 缺失的级别写成 null 而不是 undefined，写入 JSON 后不会丢掉该字段
    expect(JSON.parse(JSON.stringify(out.violations[0]))).toHaveProperty("impact", null);
  });
});

test.describe("summarizeAxe 的节点明细（RDF 15.2–15.4）", () => {
  // Feature: reader-defect-fixes, Property 8: axe 结果归纳保留节点明细
  // **Validates: Requirements 15.2, 15.3, 15.4**
  test("RDF 15.4 属性 8：任意 axe 结果（节点的 target 含 shadow DOM 嵌套选择器，html 长短不一，failureSummary 可缺失，color-contrast 节点带或不带 any[0].data），满足属性 10 的全部条件，且每条规则的 details 与输入节点逐一对应：target 以“ >>> ”连接，html 不超过 200 个字符时原样、否则为前 199 个字符加“…”，failureSummary 为输入值或空串，contrast 当且仅当规则为 color-contrast 且带 any[0].data 时存在、各字段等于输入", () => {
    fc.assert(
      fc.property(detailResultsArb, (results) => {
        assertDetails(results);
      }),
      { numRuns: 100 },
    );
  });

  test("RDF 15.4 一份对比度扫描结果：shadow DOM 选择器以“ >>> ”连接；html 恰 200 个字符时原样、更长时截为前 199 个加“…”；color-contrast 取 any[0].data 的 6 个字段，incomplete 缺失的字段记为空串与 0；color-contrast-enhanced 带同样的数据也没有 contrast", () => {
    // 上限、省略号与连接符按 RDF 设计第 14 节写成字面量
    expect([HTML_MAX_LENGTH, HTML_ELLIPSIS, SHADOW_SELECTOR_SEPARATOR]).toEqual([200, "…", " >>> "]);

    const longHtml = `<p class="muted">${"书".repeat(200)}</p>`; // 17 + 200 + 4 = 221 个字符
    const exactHtml = `<button>${"a".repeat(183)}</button>`; // 8 + 183 + 9 = 200 个字符
    const lowContrast =
      "Fix any of the following:\n  Element has insufficient color contrast of 4.47 (foreground color: #777777, background color: #ffffff, font size: 12.0pt (16px), font weight: normal). Expected contrast ratio of 4.5:1";
    const gradient =
      "Fix any of the following:\n  Element's background color could not be determined due to a background gradient";
    const data = {
      fgColor: "#777777",
      bgColor: "#ffffff",
      contrastRatio: 4.47,
      fontSize: "12.0pt (16px)",
      fontWeight: "normal",
      messageKey: null,
      expectedContrastRatio: "4.5:1",
    };

    const out = summarizeAxe({
      violations: [
        {
          id: "color-contrast",
          impact: "serious",
          nodes: [
            {
              any: [{ id: "color-contrast", data, relatedNodes: [], impact: "serious", message: "m" }],
              all: [],
              none: [],
              impact: "serious",
              html: longHtml,
              target: [["reader-view", "p.muted"], "#chapter > p:nth-child(3)"],
              failureSummary: lowContrast,
            },
          ],
        },
        {
          id: "color-contrast-enhanced",
          impact: "serious",
          nodes: [{ any: [{ id: "color-contrast-enhanced", data }], html: exactHtml, target: ["#close"] }],
        },
      ],
      incomplete: [
        {
          id: "color-contrast",
          impact: "serious",
          nodes: [
            {
              any: [
                {
                  id: "color-contrast",
                  data: { fontSize: "13.5pt (18px)", fontWeight: "bold", messageKey: "bgGradient", expectedContrastRatio: "4.5:1" },
                },
              ],
              html: "<h3>书名</h3>",
              target: [".book-card > h3"],
              failureSummary: gradient,
            },
          ],
        },
      ],
      testEngine: { version: "4.13.0" },
    });

    // toStrictEqual：没有对比度数据时连 contrast 键也不带
    expect(out.violations.map((v) => v.details)).toStrictEqual([
      [
        {
          target: ["reader-view >>> p.muted", "#chapter > p:nth-child(3)"],
          html: `<p class="muted">${"书".repeat(182)}…`,
          failureSummary: lowContrast,
          contrast: {
            fgColor: "#777777",
            bgColor: "#ffffff",
            contrastRatio: 4.47,
            expectedContrastRatio: "4.5:1",
            fontSize: "12.0pt (16px)",
            fontWeight: "normal",
          },
        },
      ],
      [{ target: ["#close"], html: exactHtml, failureSummary: "" }],
    ]);
    expect(out.violations[0].details[0].html).toHaveLength(200);
    expect(out.incomplete).toStrictEqual([
      {
        id: "color-contrast",
        nodes: 1,
        details: [
          {
            target: [".book-card > h3"],
            html: "<h3>书名</h3>",
            failureSummary: gradient,
            contrast: {
              fgColor: "",
              bgColor: "",
              contrastRatio: 0,
              expectedContrastRatio: "4.5:1",
              fontSize: "13.5pt (18px)",
              fontWeight: "bold",
            },
          },
        ],
      },
    ]);
  });
});
