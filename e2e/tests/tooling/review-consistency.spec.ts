/**
 * Review_Report 一致性检查的无浏览器测试（`tooling` 项目；设计 Data Models"Review_Report 一致性检查"
 * 与 Correctness Properties 属性 13）。
 *
 * 属性 13（故障注入，需求 13.10、13.11）：先按构造得到一致的输入，`checkReviewConsistency` 应返回
 * 空列表；再逐一施加设计列出的 7 种扰动，结果应含该扰动对应 `kind` 的违规，且其 `name` / `item` /
 * `file` 指向被扰动的对象。这里另外核对结果恰好等于扰动的直接后果（按 kind、对象排序），确认扰动
 * 不引出无关的违规；"删掉一个必需名称"的直接后果还含它独占的 Checklist 项与它的 PNG。
 *
 * 一致的输入：
 * - catalog 取真实的 `REVIEW_CATALOG`（全部，或打乱后的子集），或以真实条目为底、改写名称、视口、
 *   截取范围与 Checklist 的合成条目（真实 catalog 全是视口截图，元素与整页只能靠合成条目覆盖）。
 *   名称互不相同；`requiredNames` 与 `requiredChecklist` 取 catalog 已覆盖的子集，全量 catalog
 *   配真实的 `REQUIRED_SHOT_NAMES` 与 `REQUIRED_CHECKLIST`。
 * - 每张：恰有 1 条附件与 1 个尺寸合规的 PNG；或没有附件、没有 PNG 且带非空原因。13.11 没有列入
 *   违规的两种情形也算一致：有附件与 PNG 又注明了原因；有 PNG 而没有附件（可带原因）。
 * - PNG 一律以 24 字节的 IHDR 头（后接任意字节）经 `pngSize` 读出尺寸，并核对读出的等于构造的。
 *
 * 期望值不从被测实现推导：文件名按设计写作 `<名称>.png`，13.10 的尺寸范围在生成器里按需求原文
 * 构造。只有排序用 `VIOLATION_KINDS`（13.11 的列举顺序），`bad-size` 的 `expected` 文字取
 * `expectedShotSize` / `EXPECTED_PNG_IHDR`。
 *
 * 属性 14（需求 13.3、13.4）：对任意 catalog（真实 catalog、其打乱的子集，或改写了 Library_Profile、
 * 模式、主题、状态、准则与用例标题的合成条目，偶尔含重名条目）、任意拍摄状态映射（每个名称已拍摄、
 * 未拍摄或缺席，另有不在 catalog 中的名称）与任意开头信息，`renderReviewReport` 的 Markdown 按
 * CommonMark 的行结束符切行、以 `## ` 开头的行切节后：
 * - 开头（首节之前）恰有 1 行运行开始时间与 1 行 Library_Profile；
 * - 节的标题依次等于 catalog 各条目的名称（13.3"每张恰好一节，按 catalog 顺序"；重名条目各占一节）；
 * - 已拍摄的节：恰有 1 行 PNG，指向相对报告的 `<名称>.png`；13.1 的每项元数据恰有 1 行；用例名与
 *   最终结果各 1 行；准则从 1 起连续编号、原文与定义相同；每条准则下恰有 1 行待填判定栏，判定栏
 *   总数等于准则数；没有未拍摄原因；
 * - 未拍摄的节：没有 PNG 行、没有引用 `<名称>.png`、没有判定栏；恰有 1 行原因，为 13.4 的四类之一
 *   （原因为 null 或不在映射中时为 `UNKNOWN_UNCAPTURED_REASON`）；元数据与用例名同上。
 * `reviewReportData` 与 Markdown 同一顺序、同一口径。自由文字（状态、准则、用例名、跳过原因、步骤名、
 * 开始时间）会夹带换行与形似报告前缀的片段，核对它们不会拆出多余的行、节或判定栏；比较文字时
 * 把空白串视为一个空格（渲染器把换行改成空格）。
 *
 * Review_Catalog 的例子（任务 15.4，需求 13.1、13.2）：真实的 `REVIEW_CATALOG`、`REQUIRED_SHOT_NAMES`
 * 与 `REQUIRED_CHECKLIST` 对照附录 A、附录 B 的原文（照录于 `APPENDIX_A`、`APPENDIX_B_VISUAL`）：25 个
 * 名称与顺序、各条的场景字段、书 id 与 URL、1–5 条准则的原文与编号、7 项 Checklist 的引用，以及 `by`
 * 指向的用例。Library_Profile 只有 fixture；附录 A 点名的书写作它承担的用途，书 id 按 `SAMPLE_ROLES`
 * 解析为 `roles.json` 中承担该用途的书（test-data-desensitization 需求 4.1）。
 * 后续 spec 追加的准则（`reader-defect-fixes` 需求 13.6 的 RS-20 第 3 条）单独列在
 * `APPENDIX_A_ADDED_CRITERIA`，接在原文之后核对。
 *
 * RDF 16.1 的例子（`reader-defect-fixes` 任务 5.2，需求 16.1、16.4）：`resolveShotStatus` 区分"命令行
 * 过滤未选中"（运行未中止，拍摄用例不在 `collected` 中）与"运行在拍摄前中止"（`abort.json` 存在，或用例
 * 已被收集却被中断、未执行），并核对 Review_Report 中该节的原因行；`extractFilterArgs` 对 `-g x`、
 * `--grep=x`、`--project=fixture`、位置参数等写法的提取。原因文字按需求与报告原文写成字面量。
 *
 * RDF 属性 10（`reader-defect-fixes` 任务 5.6，需求 16.3、16.4）：对任意不含 `\r`、`\n` 的名称
 * （字母表富含 `\`、`[`、`]`、`<`、`>`、`(`、`)`、`!` 等 ASCII 标点，另有空格、制表符、中文、代理对
 * 与任意码点），`escapeLinkText` / `escapeLinkDestination` 拼出的图片与 `renderReviewReport` 中该节的
 * PNG 行都形如 `![A](<D>)`。测试内的参照解析器 `parseImage` 按 CommonMark 的反斜杠转义规则逐字读取，
 * 核对 A 中没有未转义的方括号、D 中没有未转义的尖括号与行结束符，并反解出 A 等于名称、D 等于
 * `<名称>.png`。参照解析器只处理反斜杠转义（属性 10 的口径），不处理代码段、原始 HTML 等其它行内结构。
 *
 * 属性内用 `node:assert` 而不是 Playwright 的 `expect`，理由同 `server-resolve.spec.ts`：
 * 每次 `expect` 都会在报告里记一个步骤。例子测试用 `expect`。
 */
import { expect, test } from "@playwright/test";
import fc from "fast-check";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  BOOK_ID_PLACEHOLDER,
  REQUIRED_CHECKLIST,
  REQUIRED_SHOT_NAMES,
  REVIEW_CATALOG,
  SHOT_TESTS,
  resolveShotBook,
  resolveShotUrl,
  reviewShot,
  reviewShotFileName,
  sameShotTest,
  shotMetadata,
  shotTestRef,
  type ChecklistItem,
  type ReviewShotDef,
  type ShotScope,
  type ShotTestRef,
  type ShotViewport,
} from "../../review/catalog";
import {
  EXPECTED_PNG_IHDR,
  NO_FILTER_ARGS,
  REPORT_TEXT,
  UNKNOWN_UNCAPTURED_REASON,
  VIOLATION_KINDS,
  checkReviewConsistency,
  describeCaseResult,
  describeUncapturedReason,
  escapeLinkDestination,
  escapeLinkText,
  expectedShotSize,
  formatShotTest,
  pngSize,
  renderReviewReport,
  resolveShotStatus,
  reviewReportData,
  shotCaseKey,
  type CaseOutcome,
  type ConsistencyInput,
  type PngSize,
  type ReviewReportMeta,
  type ShotCaseResult,
  type ShotRunFacts,
  type ShotStatus,
  type UncapturedReason,
  type Violation,
  type ViolationKind,
} from "../../review/consistency";
import type { Mode } from "../../server/resolve";
import { BOOK_ROLES, type BookRole, type FixtureRoles, type LibraryProfile } from "../../support/library";
import { extractFilterArgs } from "../../support/reporter";
import { VIEWPORTS } from "../../support/settings";
import { THEME_KEYS, THEME_UNSET, type DeclaredTheme } from "../../support/theme";

// ---------------------------------------------------------------------------
// PNG 头
// ---------------------------------------------------------------------------

/** 设计：文件名即 `<名称>.png`。按原文写出，不取 `reviewShotFileName`。 */
const pngFileOf = (name: string): string => `${name}.png`;

/** 签名 8 字节 + IHDR 块长度 4 + 块类型 4 + 宽 4 + 高 4。 */
const HEAD_LEN = 24;
const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IHDR = [0x49, 0x48, 0x44, 0x52];
/** PNG 规定宽高为 1 到 2^31 − 1。 */
const MAX_DIM = 2 ** 31 - 1;

/** 宽高为 `size` 的 PNG 文件开头：24 字节头，后接 `tail`（`pngSize` 应忽略它）。 */
function pngHead(size: PngSize, tail: Uint8Array = new Uint8Array(0)): Uint8Array {
  const head = new Uint8Array(HEAD_LEN + tail.length);
  const view = new DataView(head.buffer);
  head.set(SIGNATURE, 0);
  view.setUint32(8, 13);
  head.set(IHDR, 12);
  view.setUint32(16, size.width);
  view.setUint32(20, size.height);
  head.set(tail, HEAD_LEN);
  return head;
}

function corrupted(mutate: (head: Uint8Array, view: DataView) => void): Uint8Array {
  const head = pngHead({ width: 1280, height: 800 });
  mutate(head, new DataView(head.buffer));
  return head;
}

const tailArb = fc.uint8Array({ maxLength: 8 });

/** 读不出宽高的头部：截断、签名或块类型被改、IHDR 长度不是 13、宽或高为 0 或 ≥ 2^31。 */
const invalidHeadArb: fc.Arbitrary<Uint8Array> = fc.oneof(
  fc.integer({ min: 0, max: HEAD_LEN - 1 }).map((len) => pngHead({ width: 1280, height: 800 }).slice(0, len)),
  fc
    .tuple(fc.integer({ min: 0, max: 7 }), fc.integer({ min: 1, max: 255 }))
    .map(([at, x]) =>
      corrupted((b) => {
        b[at] ^= x;
      }),
    ),
  fc
    .integer({ min: 0, max: 0xffff_ffff })
    .filter((n) => n !== 13)
    .map((n) => corrupted((_, v) => v.setUint32(8, n))),
  fc
    .tuple(fc.integer({ min: 12, max: 15 }), fc.integer({ min: 1, max: 255 }))
    .map(([at, x]) =>
      corrupted((b) => {
        b[at] ^= x;
      }),
    ),
  fc
    .tuple(fc.constantFrom(16, 20), fc.integer({ min: 2 ** 31, max: 0xffff_ffff }), fc.boolean())
    .map(([at, n, zero]) => corrupted((_, v) => v.setUint32(at, zero ? 0 : n))),
);

// ---------------------------------------------------------------------------
// 模型：一次运行结束时的 catalog、附件、review 目录与未拍摄原因
// ---------------------------------------------------------------------------

interface PngFile {
  readonly file: string;
  readonly head: Uint8Array;
  /** 构造时写入头部的尺寸；头部无效时为 null。 */
  readonly intended: PngSize | null;
}

interface Capture {
  readonly name: string;
  readonly test: string;
}

interface Scenario {
  readonly catalog: readonly ReviewShotDef[];
  readonly requiredNames: readonly string[];
  readonly requiredChecklist: readonly string[];
  readonly captures: readonly Capture[];
  readonly pngs: readonly PngFile[];
  readonly uncaptured: Readonly<Record<string, string>>;
}

/** 与 reporter 相同：每个 PNG 的头交给 `pngSize`；读出的尺寸须等于构造时写入的。 */
function toInput(s: Scenario): ConsistencyInput {
  const pngs = s.pngs.map((p) => {
    const size = pngSize(p.head);
    assert.deepEqual(size, p.intended, `pngSize 读 ${JSON.stringify(p.file)} 的头部`);
    return { file: p.file, size };
  });
  return {
    catalog: s.catalog,
    requiredNames: s.requiredNames,
    requiredChecklist: s.requiredChecklist,
    captures: s.captures,
    pngs,
    uncaptured: s.uncaptured,
  };
}

/** 运行一致性检查，并核对它没有修改参数（纯函数）。 */
function check(s: Scenario): Violation[] {
  const input = toInput(s);
  const before = structuredClone(input);
  const result = checkReviewConsistency(input);
  assert.deepEqual(input, before, "checkReviewConsistency 修改了参数");
  return result;
}

function subjectOf(v: Violation): string {
  switch (v.kind) {
    case "checklist-uncovered":
      return v.item;
    case "orphan-png":
      return v.file;
    default:
      return v.name;
  }
}

/** 设计：结果按 kind（13.11 的列举顺序）、再按对象（UTF-16 码元序）排列。 */
function sorted(vs: readonly Violation[]): Violation[] {
  const rank = (v: Violation): number => VIOLATION_KINDS.indexOf(v.kind);
  const bySubject = (a: Violation, b: Violation): number => {
    const x = subjectOf(a);
    const y = subjectOf(b);
    return x < y ? -1 : x > y ? 1 : 0;
  };
  return [...vs].sort((a, b) => rank(a) - rank(b) || bySubject(a, b));
}

// ---------------------------------------------------------------------------
// 生成器：一致的输入
// ---------------------------------------------------------------------------

const VIEWPORT_KEYS = Object.keys(VIEWPORTS) as ShotViewport[];
const SCOPES: readonly ShotScope[] = ["viewport", "element", "fullPage"];

/** [min, max] 内的整数，偏向两端（13.10 的边界）。 */
function dimArb(min: number, max: number): fc.Arbitrary<number> {
  return fc.oneof(
    { weight: 1, arbitrary: fc.constantFrom(min, max) },
    { weight: 3, arbitrary: fc.integer({ min, max }) },
  );
}

const sizeOf = (width: number, height: number): PngSize => ({ width, height });

/** 13.10 范围内：视口截图等于视口；元素宽、高都不超过视口；整页宽等于视口宽、高不超过视口高的 3 倍。 */
function fittingSizeArb(def: ReviewShotDef): fc.Arbitrary<PngSize> {
  const vp = VIEWPORTS[def.viewport];
  switch (def.scope) {
    case "viewport":
      return fc.constant(sizeOf(vp.width, vp.height));
    case "element":
      return fc.tuple(dimArb(1, vp.width), dimArb(1, vp.height)).map(([w, h]) => sizeOf(w, h));
    case "fullPage":
      return dimArb(1, vp.height * 3).map((h) => sizeOf(vp.width, h));
  }
}

/** 13.10 范围外：只把宽或高之一改到范围外，另一个留在范围内。 */
function outOfRangeSizeArb(def: ReviewShotDef): fc.Arbitrary<PngSize> {
  const vp = VIEWPORTS[def.viewport];
  const notEqualTo = (v: number): fc.Arbitrary<number> => fc.oneof(dimArb(1, v - 1), dimArb(v + 1, MAX_DIM));
  switch (def.scope) {
    case "viewport":
      return fc.oneof(
        notEqualTo(vp.width).map((w) => sizeOf(w, vp.height)),
        notEqualTo(vp.height).map((h) => sizeOf(vp.width, h)),
      );
    case "element":
      return fc.oneof(
        fc.tuple(dimArb(vp.width + 1, MAX_DIM), dimArb(1, vp.height)).map(([w, h]) => sizeOf(w, h)),
        fc.tuple(dimArb(1, vp.width), dimArb(vp.height + 1, MAX_DIM)).map(([w, h]) => sizeOf(w, h)),
      );
    case "fullPage":
      return fc.oneof(
        fc.tuple(notEqualTo(vp.width), dimArb(1, vp.height * 3)).map(([w, h]) => sizeOf(w, h)),
        dimArb(vp.height * 3 + 1, MAX_DIM).map((h) => sizeOf(vp.width, h)),
      );
  }
}

function pngFileArb(file: string, sizeArb: fc.Arbitrary<PngSize>): fc.Arbitrary<PngFile> {
  return fc.tuple(sizeArb, tailArb).map(([size, tail]) => ({ file, head: pngHead(size, tail), intended: size }));
}

/** 任意 PNG 头（孤儿 PNG 不核对尺寸）：任意合法尺寸，或读不出尺寸。 */
const anyHeadArb: fc.Arbitrary<Pick<PngFile, "head" | "intended">> = fc.oneof(
  fc
    .tuple(dimArb(1, MAX_DIM), dimArb(1, MAX_DIM), tailArb)
    .map(([w, h, tail]) => ({ head: pngHead(sizeOf(w, h), tail), intended: sizeOf(w, h) })),
  invalidHeadArb.map((head) => ({ head, intended: null })),
);

/** 全部 Library_Profile（只有 fixture）。 */
const PROFILES: readonly LibraryProfile[] = ["fixture"];

const uncapturedReasonArb: fc.Arbitrary<UncapturedReason> = fc.oneof(
  fc.constantFrom(...PROFILES).map((profile): UncapturedReason => ({ kind: "profile-not-run", profile })),
  fc
    .constantFrom("[3.9] Fixture_Generator 失败：roles.json 缺失", "[8.13] 当前书库缺少相邻卷节点", "[16.4 F-003] 定位不到目标")
    .map((reason): UncapturedReason => ({ kind: "skipped", reason })),
  fc
    .tuple(fc.constantFrom("打开阅读器", "无具名步骤"), fc.boolean())
    .map(([step, timedOut]): UncapturedReason => ({ kind: "failed-before-shot", step, timedOut })),
  fc.constantFrom("构建应用", "服务器自检").map((stage): UncapturedReason => ({ kind: "aborted", cause: "abort", stage })),
  fc
    .constantFrom("interrupted" as const, "not-executed" as const)
    .map((cause): UncapturedReason => ({ kind: "aborted", cause })),
);

/** 非空原因：13.4 的原因文字，或前后带空白的任意非空白文字。 */
const reasonArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 3, arbitrary: uncapturedReasonArb.map(describeUncapturedReason) },
  {
    weight: 1,
    arbitrary: fc
      .string({ minLength: 1, maxLength: 12 })
      .filter((s) => s.trim() !== "")
      .map((s) => ` ${s}\t`),
  },
);

/** "不给原因"：没有该键（null），或只有空白（含全角空格）。 */
const blankReasonArb: fc.Arbitrary<string | null> = fc.oneof(
  { weight: 2, arbitrary: fc.constant(null) },
  { weight: 3, arbitrary: fc.constantFrom("", " ", "\t\n", "\u3000") },
);

/** 合成名称的字母表：不含 `#`（孤儿 PNG 的记号）；含大小写、空格、点、中文、全角与代理对。 */
const NAME_UNITS = [..."abAB09-_. 中文书ｆ𠮷"];
/** 与 `Object.prototype` 的属性同名：`uncaptured` 没有这一键时不能读到继承来的函数。 */
const PROTO_NAMES = ["toString", "constructor", "hasOwnProperty", "valueOf"];

const nameArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 3, arbitrary: fc.string({ unit: fc.constantFrom(...NAME_UNITS), minLength: 1, maxLength: 6 }) },
  { weight: 1, arbitrary: fc.constantFrom(...PROTO_NAMES) },
);

const checklistItemArb = fc.integer({ min: 1, max: 12 }).map((n): ChecklistItem => `H${n}`);

interface CatalogCase {
  readonly catalog: readonly ReviewShotDef[];
  readonly requiredNames: readonly string[];
  readonly requiredChecklist: readonly string[];
}

/** `requiredNames` 与 `requiredChecklist`：catalog 已覆盖的名称与 Checklist 项的子集（无重复）。 */
function withRequirements(catalog: readonly ReviewShotDef[]): fc.Arbitrary<CatalogCase> {
  const names = catalog.map((d) => d.name);
  const covered = [...new Set(catalog.flatMap((d) => d.checklist))];
  return fc
    .record({ requiredNames: fc.shuffledSubarray(names), requiredChecklist: fc.shuffledSubarray(covered) })
    .map((r) => ({ catalog, ...r }));
}

/** 以真实条目为底，改写名称、视口、截取范围与 Checklist；名称互不相同。 */
const syntheticCatalogArb: fc.Arbitrary<ReviewShotDef[]> = fc
  .uniqueArray(
    fc.record({
      name: nameArb,
      viewport: fc.constantFrom(...VIEWPORT_KEYS),
      scope: fc.constantFrom(...SCOPES),
      checklist: fc.uniqueArray(checklistItemArb, { maxLength: 3 }),
      base: fc.nat({ max: REVIEW_CATALOG.length - 1 }),
    }),
    { selector: (r) => r.name, maxLength: 8 },
  )
  .map((rows) => rows.map(({ base, ...fields }): ReviewShotDef => ({ ...REVIEW_CATALOG[base], ...fields })));

const catalogCaseArb: fc.Arbitrary<CatalogCase> = fc.oneof(
  {
    weight: 1,
    arbitrary: fc.constant<CatalogCase>({
      catalog: REVIEW_CATALOG,
      requiredNames: [...REQUIRED_SHOT_NAMES],
      requiredChecklist: [...REQUIRED_CHECKLIST],
    }),
  },
  { weight: 2, arbitrary: fc.shuffledSubarray([...REVIEW_CATALOG], { minLength: 1 }).chain(withRequirements) },
  { weight: 3, arbitrary: syntheticCatalogArb.chain(withRequirements) },
);

/** 一张 Review_Shot 在一致的输入中的样子。 */
type ShotState =
  /** 1 条附件与 1 个合规 PNG；`reason` 非 null 时又注明了原因（13.11 未列入违规）。 */
  | { readonly kind: "captured"; readonly png: PngFile; readonly reason: string | null }
  /** 有合规 PNG 而没有附件，可带原因（13.11 未列入违规）。 */
  | { readonly kind: "png-only"; readonly png: PngFile; readonly reason: string | null }
  /** 没有附件、没有 PNG，带非空原因。 */
  | { readonly kind: "uncaptured"; readonly reason: string };

function shotStateArb(def: ReviewShotDef): fc.Arbitrary<ShotState> {
  const png = pngFileArb(pngFileOf(def.name), fittingSizeArb(def));
  return fc.oneof(
    { weight: 5, arbitrary: png.map((p): ShotState => ({ kind: "captured", png: p, reason: null })) },
    { weight: 4, arbitrary: reasonArb.map((reason): ShotState => ({ kind: "uncaptured", reason })) },
    {
      weight: 1,
      arbitrary: fc.tuple(png, reasonArb).map(([p, reason]): ShotState => ({ kind: "captured", png: p, reason })),
    },
    {
      weight: 1,
      arbitrary: fc
        .tuple(png, fc.option(reasonArb))
        .map(([p, reason]): ShotState => ({ kind: "png-only", png: p, reason })),
    },
  );
}

function assemble(c: CatalogCase, states: readonly ShotState[]): Scenario {
  const captures: Capture[] = [];
  const pngs: PngFile[] = [];
  const uncaptured: Record<string, string> = {};
  c.catalog.forEach((def, i) => {
    const state = states[i];
    if (state.kind === "captured") captures.push({ name: def.name, test: formatShotTest(def.by) });
    if (state.kind !== "uncaptured") pngs.push(state.png);
    if (state.reason !== null) uncaptured[def.name] = state.reason;
  });
  return { ...c, captures, pngs, uncaptured };
}

/** 按构造一致的输入；附件与目录列表的顺序打乱（检查不应依赖它们的顺序）。 */
const scenarioArb: fc.Arbitrary<Scenario> = catalogCaseArb.chain((c) =>
  fc.tuple(...c.catalog.map((def) => shotStateArb(def))).chain((states) => {
    const s = assemble(c, states);
    return fc
      .tuple(
        fc.shuffledSubarray([...s.captures], { minLength: s.captures.length }),
        fc.shuffledSubarray([...s.pngs], { minLength: s.pngs.length }),
      )
      .map(([captures, pngs]): Scenario => ({ ...s, captures, pngs }));
  }),
);

// ---------------------------------------------------------------------------
// 扰动（设计属性 13 列出的 7 种）
// ---------------------------------------------------------------------------

interface Injected {
  readonly scenario: Scenario;
  /** 扰动对应的违规：kind 与所指的对象（name / item / file）。 */
  readonly target: Violation;
  /** 扰动的全部直接后果（含 `target`）。 */
  readonly expected: readonly Violation[];
}

interface Fault {
  readonly title: string;
  readonly kind: ViolationKind;
  /** 该扰动能否施加于这份输入（例如 catalog 非空）。 */
  readonly applies: (s: Scenario) => boolean;
  readonly inject: (s: Scenario) => fc.Arbitrary<Injected>;
}

function only(scenario: Scenario, target: Violation): Injected {
  return { scenario, target, expected: [target] };
}

function pick<T>(xs: readonly T[], n: number): T {
  return xs[n % xs.length];
}

function insertAt<T>(xs: readonly T[], at: number, x: T): T[] {
  const i = at % (xs.length + 1);
  return [...xs.slice(0, i), x, ...xs.slice(i)];
}

const hasCatalog = (s: Scenario): boolean => s.catalog.length > 0;

/**
 * 无法映射的文件名：大小写不同（`.PNG`、名称转大写）、多一层扩展名、前导空格、换扩展名、无扩展名，
 * 以及过时的名称（含 `#`，合成名称与真实名称都不含它）。与某个 `<名称>.png` 相同或已在目录中的剔除。
 */
function orphanCandidates(s: Scenario, i: number, fresh: string): string[] {
  const mapped = new Set(s.catalog.map((d) => pngFileOf(d.name)));
  const present = new Set(s.pngs.map((p) => p.file));
  const out = [`过时#${fresh}.png`];
  if (s.catalog.length > 0) {
    const { name } = pick(s.catalog, i);
    out.push(`${name}.PNG`, `${name.toUpperCase()}.png`, `${name}.png.png`, ` ${name}.png`, `${name}.jpg`, name);
  }
  return out.filter((f) => !mapped.has(f) && !present.has(f));
}

const FAULTS: readonly Fault[] = [
  {
    title: "复制一个名称 → duplicate-name 指向该名称",
    kind: "duplicate-name",
    applies: hasCatalog,
    inject: (s) =>
      fc.record({ i: fc.nat(), renamed: fc.boolean(), j: fc.nat(), at: fc.nat() }).map(({ i, renamed, j, at }) => {
        const k = i % s.catalog.length;
        const def = s.catalog[k];
        // 原样复制可插在任意位置；把另一条目改成同名时插在原条目之后，"第一个定义"仍是原条目，
        // 同名条目的视口与截取范围不影响尺寸判定
        const catalog = renamed
          ? [...s.catalog.slice(0, k + 1), ...insertAt(s.catalog.slice(k + 1), at, { ...pick(s.catalog, j), name: def.name })]
          : insertAt(s.catalog, at, { ...def });
        return only({ ...s, catalog }, { kind: "duplicate-name", name: def.name });
      }),
  },
  {
    title: "删掉一个必需名称 → missing-name 指向该名称（它独占的 Checklist 项与它的 PNG 随之报 checklist-uncovered、orphan-png）",
    kind: "missing-name",
    applies: (s) => s.requiredNames.length > 0,
    inject: (s) =>
      fc.nat().map((k) => {
        const name = pick(s.requiredNames, k);
        const catalog = s.catalog.filter((d) => d.name !== name);
        const covered = new Set<string>(catalog.flatMap((d) => d.checklist));
        const target: Violation = { kind: "missing-name", name };
        const expected: Violation[] = [
          target,
          ...s.requiredChecklist
            .filter((item) => !covered.has(item))
            .map((item): Violation => ({ kind: "checklist-uncovered", item })),
          ...s.pngs
            .filter((p) => p.file === pngFileOf(name))
            .map((p): Violation => ({ kind: "orphan-png", file: p.file })),
        ];
        return { scenario: { ...s, catalog }, target, expected };
      }),
  },
  {
    title: "移除某 Checklist 项的全部引用 → checklist-uncovered 指向该项",
    kind: "checklist-uncovered",
    applies: (s) => s.requiredChecklist.length > 0,
    inject: (s) =>
      fc.nat().map((k) => {
        const item = pick(s.requiredChecklist, k);
        const catalog = s.catalog.map((d): ReviewShotDef => ({ ...d, checklist: d.checklist.filter((x) => x !== item) }));
        return only({ ...s, catalog }, { kind: "checklist-uncovered", item });
      }),
  },
  {
    title: "为某张追加第 2 条附件 → multiple-png 指向该名称，count 为附件条数",
    kind: "multiple-png",
    applies: hasCatalog,
    inject: (s) =>
      fc
        .record({
          i: fc.nat(),
          extra: fc.integer({ min: 0, max: 2 }),
          from: fc.nat(),
          at: fc.array(fc.nat(), { minLength: 4, maxLength: 4 }),
        })
        .map(({ i, extra, from, at }) => {
          const { name } = pick(s.catalog, i);
          const current = s.captures.filter((c) => c.name === name).length;
          // 至少追加到第 2 条；追加的附件可来自同一用例（拍了两次），也可来自另一条目的用例
          const added = Math.max(1, 2 - current) + extra;
          const testName = formatShotTest(pick(s.catalog, from).by);
          let captures: Capture[] = [...s.captures];
          for (let t = 0; t < added; t++) captures = insertAt(captures, at[t], { name, test: testName });
          return only({ ...s, captures }, { kind: "multiple-png", name, count: current + added });
        }),
  },
  {
    title: "删掉某张的 PNG 且不给原因 → no-png-no-reason 指向该名称",
    kind: "no-png-no-reason",
    applies: hasCatalog,
    inject: (s) =>
      fc.record({ i: fc.nat(), blank: blankReasonArb, preferProto: fc.boolean() }).map(({ i, blank, preferProto }) => {
        // 半数情形优先挑与 Object.prototype 属性同名的条目（若有），使"没有该键"常落在它们身上
        const protoDefs = s.catalog.filter((d) => PROTO_NAMES.includes(d.name));
        const { name } = preferProto && protoDefs.length > 0 ? pick(protoDefs, i) : pick(s.catalog, i);
        const pngs = s.pngs.filter((p) => p.file !== pngFileOf(name));
        // 附件（若有）保留：用例拍了，文件却不在目录里
        const uncaptured: Record<string, string> = Object.fromEntries(
          Object.entries(s.uncaptured).filter(([key]) => key !== name),
        );
        if (blank !== null) uncaptured[name] = blank;
        return only({ ...s, pngs, uncaptured }, { kind: "no-png-no-reason", name });
      }),
  },
  {
    title: "加入一个无法映射的 PNG → orphan-png 指向该文件",
    kind: "orphan-png",
    applies: () => true,
    inject: (s) =>
      fc
        .record({
          i: fc.nat(),
          variant: fc.nat(),
          fresh: fc.string({ unit: fc.constantFrom(...NAME_UNITS), maxLength: 4 }),
          head: anyHeadArb,
          at: fc.nat(),
        })
        .map(({ i, variant, fresh, head, at }) => {
          const file = pick(orphanCandidates(s, i, fresh), variant);
          const pngs = insertAt(s.pngs, at, { file, ...head });
          return only({ ...s, pngs }, { kind: "orphan-png", file });
        }),
  },
  {
    title: "把某张 PNG 的宽或高改到 13.10 的范围之外（或头部读不出） → bad-size 指向该名称",
    kind: "bad-size",
    applies: hasCatalog,
    inject: (s) =>
      fc.nat().chain((i) => {
        const def = pick(s.catalog, i);
        const file = pngFileOf(def.name);
        const bad: fc.Arbitrary<PngFile> = fc.oneof(
          { weight: 3, arbitrary: pngFileArb(file, outOfRangeSizeArb(def)) },
          { weight: 1, arbitrary: invalidHeadArb.map((head): PngFile => ({ file, head, intended: null })) },
        );
        return fc.tuple(bad, fc.nat()).map(([png, at]) => {
          // 替换该张原有的 PNG；原本没有 PNG 时新增（有 PNG 又注明原因不算违规，只剩尺寸一项）
          const pngs = insertAt(
            s.pngs.filter((p) => p.file !== file),
            at,
            png,
          );
          const target: Violation =
            png.intended === null
              ? { kind: "bad-size", name: def.name, actual: null, expected: EXPECTED_PNG_IHDR }
              : { kind: "bad-size", name: def.name, actual: png.intended, expected: expectedShotSize(def) };
          return only({ ...s, pngs }, target);
        });
      }),
  },
];

// ---------------------------------------------------------------------------
// 属性 13
// ---------------------------------------------------------------------------

test.describe("checkReviewConsistency（需求 13.10、13.11）", () => {
  // Feature: e2e-visual-testing, Property 13: 一致性检查的故障注入
  // **Validates: Requirements 13.10, 13.11**
  test("属性 13：按构造一致的输入没有违规，且检查不修改参数", () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        assert.deepEqual(check(s), [], "一致的输入不应有违规");
      }),
      { numRuns: 100 },
    );
  });

  for (const fault of FAULTS) {
    // Feature: e2e-visual-testing, Property 13: 一致性检查的故障注入
    // **Validates: Requirements 13.10, 13.11**
    test(`属性 13：${fault.title}`, () => {
      const arb = scenarioArb
        .filter(fault.applies)
        .chain((base) => fault.inject(base).map((injected) => ({ base, injected })));
      fc.assert(
        fc.property(arb, ({ base, injected }) => {
          assert.deepEqual(check(base), [], "扰动前的输入应一致");
          assert.equal(injected.target.kind, fault.kind);

          const result = check(injected.scenario);
          assert.ok(
            result.some((v) => isDeepStrictEqual(v, injected.target)),
            `结果中没有 ${JSON.stringify(injected.target)}；实际：${JSON.stringify(result)}`,
          );
          assert.deepEqual(result, sorted(injected.expected), "结果应恰为扰动的直接后果，并按 kind、对象排序");
        }),
        { numRuns: 100 },
      );
    });
  }
});

// ---------------------------------------------------------------------------
// 属性 14：Review_Report 的节与 catalog 一一对应（生成器）
// ---------------------------------------------------------------------------

/** 形似报告各行前缀的片段，夹带各种换行；渲染后须仍留在原来那一行里。 */
const TRICKY_TEXTS = [
  "",
  "  前后有空白\t",
  "\n## 伪造的节",
  "第一行\r\n- PNG：伪造.png",
  "\n   - 判定：（待填：通过 / 不通过 / 无法判断）",
  "准则之后\n2. 伪造的准则",
  "\r- 未拍摄原因：伪造的原因",
  "\n\n- 用例：伪造 › 用例\n",
  "- 名称：伪造\r\n- 运行开始时间：伪造",
];

/** 报告里的自由文字：可打印 ASCII、名称字母表加换行与制表符，或上面的片段。 */
const freeTextArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 3, arbitrary: fc.string({ maxLength: 16 }) },
  {
    weight: 2,
    arbitrary: fc.string({ unit: fc.constantFrom(...NAME_UNITS, "\n", "\r", "\t", "#"), maxLength: 10 }),
  },
  { weight: 2, arbitrary: fc.constantFrom(...TRICKY_TEXTS) },
);

const MODES: readonly Mode[] = ["opaque", "transparent"];
const DECLARED_THEMES: readonly DeclaredTheme[] = [THEME_UNSET, ...THEME_KEYS];
const OUTCOMES: readonly CaseOutcome[] = ["passed", "failed", "unexpectedPass", "skipped", "expectedFail", "notRun"];

/** fixture 的 `roles.json`（元数据里按用途解析书 id）。 */
const SAMPLE_ROLES: FixtureRoles = {
  volumes: "fx-volumes",
  fallback: "fx-fallback",
  stars: "fx-stars",
  huge: "fx-huge",
  crlf: "fx-crlf",
  pinyin: { id: "fx-pinyin", abbr: "fxpy" },
  sameAuthor: { author: "夹具作者", ids: ["fx-a", "fx-b"] },
  longText: { id: "fx-long", chapterIndex: 3, capKeyword: "的", fewKeyword: "少见", noHitKeyword: "无此词" },
  recent: ["fx-r1", "fx-r2", "fx-r3", "fx-r4", "fx-r5", "fx-r6"],
  volumesKeyword: "卷",
  longRun: { id: "fx-long-run", chapterIndex: 1 },
};

/**
 * 在合成条目上再改写 Library_Profile、模式、主题、状态、准则（0–5 条；0 条走"准则：无"）与用例标题。
 * 名称、视口、截取范围与 Checklist 由 `syntheticCatalogArb` 给出。
 */
function reportDefArb(def: ReviewShotDef): fc.Arbitrary<ReviewShotDef> {
  return fc
    .record({
      profile: fc.constantFrom(...PROFILES),
      mode: fc.constantFrom(...MODES),
      theme: fc.constantFrom(...DECLARED_THEMES),
      state: fc.oneof(fc.constant(def.state), freeTextArb),
      criteria: fc.oneof(fc.constant(def.criteria), fc.array(freeTextArb, { maxLength: 5 })),
      title: fc.oneof(fc.constant(def.by.title), freeTextArb),
    })
    .map(({ title, ...fields }): ReviewShotDef => ({ ...def, ...fields, by: { file: def.by.file, title } }));
}

/** 真实 catalog、其打乱的子集（可为空）或合成条目；约五分之一再插入一个重名条目。 */
const reportCatalogArb: fc.Arbitrary<readonly ReviewShotDef[]> = fc
  .oneof(
    { weight: 1, arbitrary: fc.constant<readonly ReviewShotDef[]>(REVIEW_CATALOG) },
    { weight: 2, arbitrary: fc.shuffledSubarray([...REVIEW_CATALOG]) },
    { weight: 4, arbitrary: syntheticCatalogArb.chain((defs) => fc.tuple(...defs.map(reportDefArb))) },
  )
  .chain((catalog): fc.Arbitrary<readonly ReviewShotDef[]> => {
    if (catalog.length === 0) return fc.constant(catalog);
    const duplicated = fc
      .record({ i: fc.nat(), j: fc.nat(), at: fc.nat() })
      .map(({ i, j, at }) => insertAt(catalog, at, { ...pick(catalog, j), name: pick(catalog, i).name }));
    return fc.oneof({ weight: 4, arbitrary: fc.constant(catalog) }, { weight: 1, arbitrary: duplicated });
  });

/** 13.4 的原因；跳过原因、步骤名与中止阶段另可为自由文字。 */
const reportReasonArb: fc.Arbitrary<UncapturedReason> = fc.oneof(
  { weight: 2, arbitrary: uncapturedReasonArb },
  { weight: 1, arbitrary: freeTextArb.map((reason): UncapturedReason => ({ kind: "skipped", reason })) },
  {
    weight: 1,
    arbitrary: fc
      .tuple(freeTextArb, fc.boolean())
      .map(([step, timedOut]): UncapturedReason => ({ kind: "failed-before-shot", step, timedOut })),
  },
  {
    weight: 1,
    arbitrary: freeTextArb.map((stage): UncapturedReason => ({ kind: "aborted", cause: "abort", stage })),
  },
);

/** 已拍摄（任意最终结果）或未拍摄（13.4 的原因，或 null）；用例名多为 `def.by`，也可为自由文字。 */
function shotStatusArb(def: ReviewShotDef): fc.Arbitrary<ShotStatus> {
  const testArb = fc.oneof(
    { weight: 3, arbitrary: fc.constant(formatShotTest(def.by)) },
    { weight: 1, arbitrary: freeTextArb },
  );
  return fc.oneof(
    fc.record({
      captured: fc.constant(true as const),
      test: testArb,
      result: fc.constantFrom(...OUTCOMES),
      timedOut: fc.boolean(),
    }),
    fc.record({ captured: fc.constant(false as const), test: testArb, reason: fc.option(reportReasonArb, { freq: 4 }) }),
  );
}

/**
 * 拍摄状态映射：catalog 中每个名称（重名取第一个定义）约五分之一缺席、其余有状态；另有至多 3 个
 * 不在 catalog 中的名称（报告不应为它们出节）。插入顺序打乱。
 */
function statusesArb(catalog: readonly ReviewShotDef[]): fc.Arbitrary<Map<string, ShotStatus>> {
  const firstDefs = new Map<string, ReviewShotDef>();
  for (const def of catalog) if (!firstDefs.has(def.name)) firstDefs.set(def.name, def);
  const own = fc.tuple(
    ...[...firstDefs.values()].map((def) =>
      fc.option(shotStatusArb(def), { freq: 5 }).map((status) => ({ name: def.name, status })),
    ),
  );
  const strangers = fc
    .uniqueArray(
      fc.tuple(nameArb, fc.nat({ max: REVIEW_CATALOG.length - 1 })).filter(([name]) => !firstDefs.has(name)),
      { selector: ([name]) => name, maxLength: 3 },
    )
    .chain((rows) =>
      fc.tuple(...rows.map(([name, base]) => shotStatusArb(REVIEW_CATALOG[base]).map((status) => ({ name, status })))),
    );
  return fc.tuple(own, strangers).chain(([mine, others]) => {
    const entries = [...mine, ...others].flatMap(({ name, status }): [string, ShotStatus][] =>
      status === null ? [] : [[name, status]],
    );
    return fc.shuffledSubarray(entries, { minLength: entries.length }).map((es) => new Map(es));
  });
}

const metaArb: fc.Arbitrary<ReviewReportMeta> = fc.record({
  startedAt: fc.oneof(
    {
      weight: 3,
      arbitrary: fc
        .integer({ min: Date.UTC(2020, 0, 1), max: Date.UTC(2040, 0, 1) })
        .map((ms) => new Date(ms).toISOString()),
    },
    { weight: 1, arbitrary: freeTextArb },
  ),
  profiles: fc.shuffledSubarray([...PROFILES]),
  roles: fc.option(fc.constant(SAMPLE_ROLES), { freq: 2 }),
});

interface ReportCase {
  readonly catalog: readonly ReviewShotDef[];
  readonly statuses: ReadonlyMap<string, ShotStatus>;
  readonly meta: ReviewReportMeta;
}

const reportCaseArb: fc.Arbitrary<ReportCase> = reportCatalogArb.chain((catalog) =>
  fc.record({ statuses: statusesArb(catalog), meta: metaArb }).map((r): ReportCase => ({ catalog, ...r })),
);

// ---------------------------------------------------------------------------
// 属性 14：解析报告
// ---------------------------------------------------------------------------

/** 空白串视为一个空格、去掉首尾空白（渲染器把换行及其两侧空白改成一个空格）。 */
function squash(text: string): string {
  return text
    .split(/\s+/)
    .filter((part) => part !== "")
    .join(" ");
}

/** ATX 二级标题。 */
const H2 = "## ";

interface ReportSection {
  readonly heading: string;
  readonly lines: readonly string[];
}

interface ParsedReport {
  /** 首个节标题之前的行（"开头"）。 */
  readonly preamble: readonly string[];
  readonly sections: readonly ReportSection[];
}

/** 按 CommonMark 的行结束符（`\n`、`\r\n`、`\r`）切行，以 `## ` 开头的行为节标题。 */
function parseReport(markdown: string): ParsedReport {
  const preamble: string[] = [];
  const sections: { heading: string; lines: string[] }[] = [];
  for (const line of markdown.split(/\r\n|\r|\n/)) {
    if (line.startsWith(H2)) sections.push({ heading: line.slice(H2.length), lines: [] });
    else if (sections.length === 0) preamble.push(line);
    else sections[sections.length - 1].lines.push(line);
  }
  return { preamble, sections };
}

/** 以 `prefix` 开头的行去掉前缀后的内容。 */
function valuesAfter(lines: readonly string[], prefix: string): string[] {
  return lines.filter((line) => line.startsWith(prefix)).map((line) => line.slice(prefix.length));
}

/** 以 `prefix` 开头的行应恰有 1 行；返回去掉前缀后的内容。 */
function soleValue(lines: readonly string[], prefix: string, where: string): string {
  const found = valuesAfter(lines, prefix);
  assert.equal(found.length, 1, `${where}：以 ${JSON.stringify(prefix)} 开头的行应恰有 1 行，实际 ${found.length} 行`);
  return found[0];
}

/** 13.1 的场景元数据字段（准则另行核对），按需求原文列出。 */
const METADATA_LABELS_13_1 = [
  "名称",
  "Library_Profile",
  "视口",
  "主题",
  "服务器模式",
  "书 id",
  "URL",
  "要展示的状态",
  "截取范围",
  "覆盖的 Checklist 项",
];

/** 13.3 点名的三种最终结果。 */
const RESULT_WORDS_13_3: Partial<Record<CaseOutcome, string>> = {
  passed: "通过",
  failed: "失败",
  expectedFail: "预期失败",
};

/** 带编号的准则行：`<n>. <原文>`。 */
const CRITERION_LINE = /^(\d+)\. ([\s\S]*)$/;
/** 判定栏（去掉缩进后）的开头。 */
const VERDICT_MARK = "- 判定：";
const isVerdictLine = (line: string): boolean => line.trimStart().startsWith(VERDICT_MARK);
/**
 * PNG 行的内容：Markdown 图片 `![<替代文字>](<<路径>>)`，路径为 RDF 16.3 的尖括号形式。生成器的名称
 * 不含 `\`、`[`、`]`、`<`、`>`，转义不改变它们；含这些字符时的转义往返见属性 10（RDF）。
 */
const IMAGE = /^!\[([^\]]*)\]\(<([^>]*)>\)$/;
/** 报告中对 `<名称>.png` 的引用：图片的尖括号链接目标。 */
const pngRefOf = (png: string): string => `(<${png}>)`;

/** 设计：`statuses` 中没有的名称按未拍摄、原因不明处理，用例名取 `def.by`。 */
function expectedStatus(def: ReviewShotDef, statuses: ReadonlyMap<string, ShotStatus>): ShotStatus {
  return statuses.get(def.name) ?? { captured: false, test: formatShotTest(def.by), reason: null };
}

/**
 * 未拍摄原因（已 `squash`）：原因为 null 时为 `UNKNOWN_UNCAPTURED_REASON`；否则等于
 * `describeUncapturedReason`，且含 13.4 该类的要素（Library_Profile、跳过原因、失败或超时与步骤名、
 * 中止与中止阶段）。
 */
function assertReason(text: string, reason: UncapturedReason | null, where: string): void {
  if (reason === null) {
    assert.equal(text, squash(UNKNOWN_UNCAPTURED_REASON), `${where}：原因不明时的写法`);
    return;
  }
  assert.equal(text, squash(describeUncapturedReason(reason)), `${where}：未拍摄原因`);
  const has = (part: string, what: string): void =>
    assert.ok(text.includes(squash(part)), `${where}：13.4 的原因应含${what} ${JSON.stringify(part)}；实际 ${text}`);
  switch (reason.kind) {
    case "profile-not-run":
      has("Library_Profile", "");
      has(reason.profile, "未执行的 Library_Profile");
      break;
    case "skipped":
      has("跳过", "");
      has(reason.reason, "跳过原因");
      break;
    case "failed-before-shot":
      has(reason.timedOut ? "超时" : "失败", "");
      has(reason.step, "测试步骤名");
      break;
    case "aborted":
      has("中止", "");
      if (reason.cause === "abort") has(reason.stage, "中止阶段");
      break;
  }
}

/** 一节的内容（13.3、13.4）。`where` 用于报错。 */
function assertSection(
  section: ReportSection,
  def: ReviewShotDef,
  status: ShotStatus,
  roles: FixtureRoles | null,
  where: string,
): void {
  const { lines } = section;
  const png = pngFileOf(def.name);

  // 13.1 的全部元数据各恰有 1 行，内容与定义相同；用例名 1 行（已拍摄与未拍摄都要）
  const metadata = shotMetadata(def, roles);
  assert.deepEqual(
    metadata.map((m) => m.label),
    METADATA_LABELS_13_1,
    `${where}：元数据应为 13.1 的全部字段`,
  );
  for (const { label, value } of metadata) {
    assert.equal(squash(soleValue(lines, `- ${label}：`, where)), squash(value), `${where}：元数据「${label}」`);
  }
  assert.equal(squash(soleValue(lines, REPORT_TEXT.test, where)), squash(status.test), `${where}：用例名`);

  // 准则与判定栏：每个判定栏归到它之前最近的准则行
  const numbered: { readonly n: number; readonly text: string }[] = [];
  const verdictsUnder: number[] = [];
  let verdictsBefore = 0;
  let verdicts = 0;
  for (const line of lines) {
    const m = CRITERION_LINE.exec(line);
    if (m !== null) {
      numbered.push({ n: Number(m[1]), text: m[2] });
      verdictsUnder.push(0);
    } else if (isVerdictLine(line)) {
      verdicts++;
      assert.equal(line, REPORT_TEXT.verdict, `${where}：判定栏应为待填`);
      if (verdictsUnder.length === 0) verdictsBefore++;
      else verdictsUnder[verdictsUnder.length - 1]++;
    }
  }

  const pngLines = valuesAfter(lines, REPORT_TEXT.png);
  const pngRefs = lines.filter((line) => line.includes(pngRefOf(png))).length;
  const reasons = valuesAfter(lines, REPORT_TEXT.reason);

  if (status.captured) {
    assert.equal(pngLines.length, 1, `${where}：已拍摄的节应恰有 1 行 PNG，实际 ${pngLines.length} 行`);
    const image = IMAGE.exec(pngLines[0]);
    assert.ok(image !== null, `${where}：PNG 行应为 Markdown 图片；实际 ${JSON.stringify(pngLines[0])}`);
    assert.equal(image[1], def.name, `${where}：PNG 的替代文字应为名称`);
    assert.equal(image[2], png, `${where}：PNG 路径应为相对报告的 <名称>.png`);
    assert.equal(pngRefs, 1, `${where}：已拍摄的节应恰引用 1 次 ${png}`);
    assert.equal(reasons.length, 0, `${where}：已拍摄的节不应有未拍摄原因`);

    const result = soleValue(lines, REPORT_TEXT.result, where);
    assert.equal(result, describeCaseResult(status.result, status.timedOut), `${where}：用例的最终结果`);
    const word = RESULT_WORDS_13_3[status.result];
    if (word !== undefined) assert.ok(result.startsWith(word), `${where}：最终结果应写作「${word}」；实际 ${result}`);

    assert.deepEqual(
      numbered.map((c) => c.n),
      def.criteria.map((_, i) => i + 1),
      `${where}：准则应从 1 起连续编号`,
    );
    assert.deepEqual(
      numbered.map((c) => squash(c.text)),
      def.criteria.map(squash),
      `${where}：准则原文`,
    );
    assert.equal(verdictsBefore, 0, `${where}：首条准则之前不应有判定栏`);
    assert.deepEqual(verdictsUnder, def.criteria.map(() => 1), `${where}：每条准则下应恰有 1 行判定栏`);
    assert.equal(verdicts, def.criteria.length, `${where}：判定栏数应等于准则数`);
  } else {
    assert.equal(pngLines.length, 0, `${where}：未拍摄的节不应有 PNG 行`);
    assert.equal(pngRefs, 0, `${where}：未拍摄的节不应引用 ${png}`);
    assert.equal(verdicts, 0, `${where}：未拍摄的节不应有判定栏`);
    assert.equal(reasons.length, 1, `${where}：未拍摄的节应恰有 1 行原因，实际 ${reasons.length} 行`);
    assertReason(squash(reasons[0]), status.reason, where);
  }
}

/** `review-report.json`：与 Markdown 同一顺序、同一口径。`mdReasons[i]` 为第 i 节的原因行（未拍摄时）。 */
function assertReportData(c: ReportCase, mdReasons: readonly (string | null)[]): void {
  const data = reviewReportData(c.catalog, c.statuses, c.meta);
  assert.equal(data.startedAt, c.meta.startedAt, "JSON：运行开始时间");
  assert.deepEqual(data.profiles, [...c.meta.profiles], "JSON：本次执行的 Library_Profile");
  assert.deepEqual(
    data.shots.map((s) => s.name),
    c.catalog.map((d) => d.name),
    "JSON：shots 应按 catalog 顺序，每个条目一项",
  );
  c.catalog.forEach((def, i) => {
    const shot = data.shots[i];
    const status = expectedStatus(def, c.statuses);
    const where = `JSON 第 ${i + 1} 项 ${JSON.stringify(def.name)}`;
    assert.equal(shot.rs, def.rs, where);
    assert.equal(shot.profile, def.profile, where);
    assert.equal(shot.test, status.test, `${where}：用例名`);
    assert.equal(shot.criteria, def.criteria.length, `${where}：准则数`);
    assert.equal(shot.captured, status.captured, `${where}：拍摄状态`);
    if (status.captured) {
      assert.equal(shot.png, pngFileOf(def.name), `${where}：PNG 路径`);
      assert.equal(shot.result, status.result, `${where}：最终结果`);
      assert.equal(shot.reason, null, `${where}：原因`);
    } else {
      assert.equal(shot.png, null, `${where}：PNG 路径`);
      assert.equal(shot.result, null, `${where}：最终结果`);
      assert.ok(shot.reason !== null, `${where}：未拍摄应有原因`);
      assert.equal(squash(shot.reason), squash(mdReasons[i] ?? ""), `${where}：原因应与报告相同`);
    }
  });
}

// ---------------------------------------------------------------------------
// 属性 14
// ---------------------------------------------------------------------------

test.describe("renderReviewReport（需求 13.3、13.4）", () => {
  // Feature: e2e-visual-testing, Property 14: Review_Report 的节与 catalog 一一对应
  // **Validates: Requirements 13.3, 13.4**
  test("属性 14：按 catalog 顺序每个条目恰好一节；已拍摄的节恰有 1 个 PNG 路径、判定栏数等于准则数，未拍摄的节只有 13.4 的原因", () => {
    assert.ok(REPORT_TEXT.verdict.trimStart().startsWith(VERDICT_MARK), "REPORT_TEXT.verdict 的写法");
    fc.assert(
      fc.property(reportCaseArb, (c) => {
        const { catalog, statuses, meta } = c;
        const before = structuredClone({ catalog, statuses, meta });
        const markdown = renderReviewReport(catalog, statuses, meta);
        assert.deepEqual({ catalog, statuses, meta }, before, "renderReviewReport 修改了参数");

        const report = parseReport(markdown);

        // 开头：运行开始时间与本次执行的 Library_Profile
        const startedAt = soleValue(report.preamble, REPORT_TEXT.startedAt, "开头");
        assert.equal(squash(startedAt), squash(meta.startedAt), "开头：运行开始时间");
        if (!/\s/.test(meta.startedAt)) assert.equal(startedAt, meta.startedAt, "开头：运行开始时间应原样写出");
        const profiles = soleValue(report.preamble, REPORT_TEXT.profiles, "开头");
        assert.deepEqual(profiles === "无" ? [] : profiles.split("、"), [...meta.profiles], "开头：Library_Profile");

        // 按 catalog 顺序每个条目恰好一节
        assert.deepEqual(
          report.sections.map((s) => s.heading),
          catalog.map((d) => d.name),
          "节标题应依次等于 catalog 各条目的名称",
        );

        const mdReasons = catalog.map((def, i): string | null => {
          const status = expectedStatus(def, statuses);
          assertSection(report.sections[i], def, status, meta.roles, `第 ${i + 1} 节 ${JSON.stringify(def.name)}`);
          return status.captured ? null : valuesAfter(report.sections[i].lines, REPORT_TEXT.reason)[0];
        });

        assertReportData(c, mdReasons);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Review_Catalog 的例子（任务 15.4；需求 13.1、13.2）
// ---------------------------------------------------------------------------

/** 场景用例的根（本文件位于 `e2e/tests/tooling/`）；`by.file` 相对于它。 */
const TESTS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 附录 A 的一行。未注明时视口为桌面、主题为默认、服务器为 Opaque_Mode（附录 A 开头）。 */
interface AppendixRow {
  readonly rs: string;
  /** RS-13 写作 `reader-theme-<key>`。 */
  readonly name: string;
  readonly profile: LibraryProfile;
  readonly viewport?: ShotViewport;
  readonly mode?: Mode;
  /** 场景或准则点名的书：写作它承担的用途，书 id 取 `roles.json` 中承担该用途的书。 */
  readonly book?: BookRole;
  /** 场景直接给出的 URL；其中点名那本书的 id 写作 `APPENDIX_BOOK_ID`。 */
  readonly url?: string;
  /** "验收准则"一栏原文，以"；"分隔。 */
  readonly criteria: string;
}

/** `APPENDIX_A` 的 URL 中代表"点名那本书的 id"的记号；核对时代入 `book` 用途在 `SAMPLE_ROLES` 中的书 id。 */
const APPENDIX_BOOK_ID = "<book-id>";

/**
 * 用途 → `SAMPLE_ROLES` 中承担它的书 id，按 `library.ts` 文件头的对照表（`BookRole` 与 `roles.json`
 * 字段）逐项写出，不经 `fixtureRoleBookId`。
 */
const SAMPLE_ROLE_BOOK: Readonly<Record<BookRole, string>> = {
  volumes: SAMPLE_ROLES.volumes,
  leadingVolume: SAMPLE_ROLES.volumes,
  huge: SAMPLE_ROLES.huge,
  stars: SAMPLE_ROLES.stars,
  fallback: SAMPLE_ROLES.fallback,
  pinyin: SAMPLE_ROLES.pinyin.id,
  longText: SAMPLE_ROLES.longText.id,
  crlf: SAMPLE_ROLES.crlf,
};

/**
 * requirements.md"附录 A：Review_Catalog 最低清单"，按原文照录，只有两处按 test-data-desensitization
 * （需求 4.1）改写：Library_Profile 一律为 fixture（测试只用合成书库）；附录 A 点名的书写作它承担的
 * 用途，RS-04 准则中的书名写作"pinyin 用途那本书"，RS-07 URL 中的书 id 写作 `APPENDIX_BOOK_ID`。
 */
const APPENDIX_A: readonly AppendixRow[] = [
  {
    rs: "RS-01",
    name: "bookshelf-home",
    profile: "fixture",
    criteria: "书卡呈规则网格且列宽一致；书名与作者文字未与相邻元素重叠、未溢出卡片；页头与检索框可见",
  },
  {
    rs: "RS-02",
    name: "bookshelf-mobile",
    profile: "fixture",
    viewport: "mobile",
    criteria: "书卡单列并占满可用宽度；无横向滚动条；检索框完整可见",
  },
  {
    rs: "RS-03",
    name: "bookshelf-skeleton",
    profile: "fixture",
    criteria: "占位卡的列数与 RS-01 同视口的书卡列数相同；占位卡的外形（圆角卡片、封面区 + 文字区）与书卡一致",
  },
  {
    rs: "RS-04",
    name: "search-pinyin",
    profile: "fixture",
    book: "pinyin",
    criteria: "结果中可见 pinyin 用途那本书；结果仍呈网格排布",
  },
  {
    rs: "RS-05",
    name: "author-filter",
    profile: "fixture",
    criteria: "可见当前筛选的作者名与清除入口；可见书卡的作者全部相同",
  },
  {
    rs: "RS-06",
    name: "recent-reads",
    profile: "fixture",
    criteria: "区块位于书卡网格之上；5 行各有书名、章节名与相对时间；文字可辨认",
  },
  {
    rs: "RS-07",
    name: "detail-modal",
    profile: "fixture",
    book: "pinyin",
    url: `/?book=${APPENDIX_BOOK_ID}`,
    criteria: "弹窗浮于书架之上且背景变暗；章节网格可见且无空白格",
  },
  {
    rs: "RS-08",
    name: "toc-volumes",
    profile: "fixture",
    book: "volumes",
    criteria: "卷标题与章节行在字重、底色或缩进中至少一项上可区分；卷标题不带当前章节的选中底色",
  },
  {
    rs: "RS-09",
    name: "toc-huge-middle",
    profile: "fixture",
    book: "huge",
    criteria: "可视区内的行连续，无空白行或重叠行；显示的章节序号在全书中部附近",
  },
  {
    rs: "RS-10",
    name: "search-highlight",
    profile: "fixture",
    book: "longText",
    criteria: "高亮文字在视口内，底色与正文背景明显不同；高亮所在段落未被顶栏或底栏遮挡",
  },
  {
    rs: "RS-11",
    name: "search-highlight-cleared",
    profile: "fixture",
    book: "longText",
    criteria: "与 RS-10 为同一段落；高亮底色已消失",
  },
  {
    rs: "RS-12",
    name: "theme-swatches",
    profile: "fixture",
    criteria:
      '5 个主题色块的颜色两两可区分；当前主题的色块有可见的选中标记；每个色块旁的名称与其颜色相符（如"极夜纯黑"为黑色）',
  },
  {
    rs: "RS-13",
    name: "reader-theme-<key>",
    profile: "fixture",
    book: "volumes",
    criteria: "正文与背景对比清晰可读；顶栏、底栏与正文背景属于同一配色；深色两套中没有残留的浅色背景块",
  },
  {
    rs: "RS-14",
    name: "progress-indeterminate",
    profile: "fixture",
    mode: "transparent",
    book: "huge",
    criteria: "进度轨道内有一截短条；未显示 0% 或超过 100% 的百分比",
  },
  {
    rs: "RS-15",
    name: "progress-determinate",
    profile: "fixture",
    book: "huge",
    criteria: "进度条填充宽度与显示的百分比相符",
  },
  {
    rs: "RS-16",
    name: "cache-usage",
    profile: "fixture",
    criteria: '"已缓存"显示 2 本与带单位的字节数；上限滑杆的当前值可读',
  },
  {
    rs: "RS-17",
    name: "toc-fallback",
    profile: "fixture",
    book: "fallback",
    criteria: '条目为"第 N 部分"且序号连续',
  },
  {
    rs: "RS-18",
    name: "toc-stars",
    profile: "fixture",
    book: "stars",
    criteria: "每一行都有可见文字，无空白行",
  },
  {
    rs: "RS-19",
    name: "reader-mobile-toc",
    profile: "fixture",
    viewport: "mobile",
    criteria: "抽屉宽度不超过屏宽的 85%，抽屉外可见遮罩；正文无横向溢出",
  },
  {
    rs: "RS-20",
    name: "load-error",
    profile: "fixture",
    url: "/read/不存在的id",
    criteria: '显示表明未能打开该书的错误标题、一行错误说明与"返回书架"按钮；页面非空白',
  },
  {
    rs: "RS-21",
    name: "bookmark-list",
    profile: "fixture",
    criteria: "书签条目显示章节名与预览文字",
  },
];

/**
 * 后续 spec 在附录 A 原文之后追加的准则，按编号列出，接在该行原文切分的结果之后。EV 附录 A 本身
 * 未改，`APPENDIX_A` 仍按原文照录。
 * - RS-20：`reader-defect-fixes` 需求 13.6（F-011）。
 */
const APPENDIX_A_ADDED_CRITERIA: Readonly<Record<string, readonly string[]>> = {
  "RS-20": ["错误说明是一句中文提示，不含英文异常信息或 HTML 片段"],
};

/** 5 个主题键，按设置抽屉的顺序（RS-13 按它展开）。 */
const APPENDIX_THEME_KEYS = ["default", "sepia", "eyecare", "dark", "black"] as const;

/**
 * RS-13 第 3 条"深色两套中没有残留的浅色背景块"只涉及深色两套的画面；浅色三张只取前 2 条，
 * 避免出现与该图无关的准则（13.1"每条准则只涉及该图中可见的……"；见 `catalog.ts` 的说明）。
 */
const DARK_THEME_KEYS: readonly string[] = ["dark", "black"];

/** 附录 B"视觉评审"栏不为"—"的 7 项及其点名的 Review_Shot 编号，按原文顺序。 */
const APPENDIX_B_VISUAL: Readonly<Record<string, readonly string[]>> = {
  H1: ["RS-09"],
  H4: ["RS-10", "RS-11"],
  H5: ["RS-08"],
  H6: ["RS-12", "RS-13"],
  H7: ["RS-03"],
  H10: ["RS-14"],
  H11: ["RS-16"],
};

/** 附录 B 的全部 Checklist 项 H1–H11（其余 4 项的"视觉评审"栏为"—"）。 */
const APPENDIX_B_ITEMS = Array.from({ length: 11 }, (_, i) => `H${i + 1}`);

/** 由附录 A 推出的一张 Review_Shot。 */
interface ExpectedShot {
  readonly rs: string;
  readonly name: string;
  readonly profile: LibraryProfile;
  readonly viewport: ShotViewport;
  readonly theme: DeclaredTheme;
  readonly mode: Mode;
  /** 附录 A 点名的书所承担的用途。 */
  readonly book: BookRole | null;
  /** 已代入 `SAMPLE_ROLES` 中书 id 的 URL。 */
  readonly url: string | null;
  readonly criteria: readonly string[];
  readonly checklist: readonly string[];
}

/** 附录 A 的 URL：`APPENDIX_BOOK_ID` 处代入点名那本书在 `SAMPLE_ROLES` 中的 id。 */
function appendixUrl(row: AppendixRow): string | null {
  if (row.url === undefined) return null;
  if (row.book === undefined) return row.url;
  return row.url.split(APPENDIX_BOOK_ID).join(SAMPLE_ROLE_BOOK[row.book]);
}

function checklistFor(rs: string): string[] {
  return Object.entries(APPENDIX_B_VISUAL)
    .filter(([, shots]) => shots.includes(rs))
    .map(([item]) => item);
}

/**
 * 附录 A 的一行展开为 Review_Shot：RS-13 按 5 个主题键各一张，其余一张、默认主题。准则为原文以
 * "；"切分的结果，后接 `APPENDIX_A_ADDED_CRITERIA` 中该编号的追加准则。
 */
function expandRow(row: AppendixRow): ExpectedShot[] {
  const base = {
    rs: row.rs,
    profile: row.profile,
    viewport: row.viewport ?? "desktop",
    mode: row.mode ?? "opaque",
    book: row.book ?? null,
    url: appendixUrl(row),
    checklist: checklistFor(row.rs),
  } as const;
  const criteria = [...row.criteria.split("；"), ...(APPENDIX_A_ADDED_CRITERIA[row.rs] ?? [])];
  if (row.rs !== "RS-13") return [{ ...base, name: row.name, theme: THEME_UNSET, criteria }];
  return APPENDIX_THEME_KEYS.map((key) => ({
    ...base,
    name: row.name.replace("<key>", key),
    theme: key,
    criteria: DARK_THEME_KEYS.includes(key) ? criteria : criteria.slice(0, 2),
  }));
}

const EXPECTED_SHOTS: readonly ExpectedShot[] = APPENDIX_A.flatMap(expandRow);

/** catalog 条目与附录 A 推出的期望按名称配对；名称对不上时直接失败（13.2 的用例另行报告差异）。 */
function pairedShots(): [ReviewShotDef, ExpectedShot][] {
  return REVIEW_CATALOG.map((def) => {
    const want = EXPECTED_SHOTS.find((e) => e.name === def.name);
    if (want === undefined) throw new Error(`附录 A 中没有 ${def.name}`);
    return [def, want];
  });
}

/** 名称可直接作文件名 `<名称>.png`：小写字母与数字，以单个 `-` 连接。 */
const SHOT_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 准则中点名另一张 Review_Shot 的写法。 */
const RS_REF = /RS-\d{2}/g;

/**
 * 涉及动画、时长或节奏的字样（13.1"不涉及动画、时长"）：只是机械的近似，准则是否只涉及画面内可见
 * 的内容仍由评审判断。
 */
const NOT_IN_A_STILL = /动画|闪烁|在动|时长|耗时|毫秒|秒|\d\s*m?s\b/;

/** 各 Library_Profile 与服务器模式的用例所在目录（`playwright.config.ts` 的项目表；`perf` 项目不拍摄）。 */
const SHOT_DIRS: Readonly<Record<`${LibraryProfile}/${Mode}`, readonly string[]>> = {
  "fixture/opaque": ["common", "fixture"],
  "fixture/transparent": ["fixture-transparent"],
};

/** 只按需运行的标签：带它的用例默认不收集（`playwright.config.ts`）。 */
const ON_DEMAND = /@audit|@selftest/;

/** `SHOT_TESTS` 展开为 `(键, 用例)`；`readerTheme` 按主题键展开为 5 项。 */
function shotTestEntries(): { readonly key: string; readonly ref: ShotTestRef }[] {
  return Object.entries(SHOT_TESTS).flatMap(([key, value]) =>
    "file" in value ? [{ key, ref: value }] : Object.values(value).map((ref) => ({ key, ref })),
  );
}

test.describe("Review_Catalog（需求 13.1、13.2）", () => {
  test("13.2：附录 A 的 21 个条目按 5 个主题键展开为 25 个名称，REQUIRED_SHOT_NAMES 与 REVIEW_CATALOG 依次等于它", () => {
    expect(
      APPENDIX_A.map((row) => row.rs),
      "附录 A 为 RS-01 至 RS-21",
    ).toEqual(Array.from({ length: 21 }, (_, i) => `RS-${String(i + 1).padStart(2, "0")}`));
    expect([...THEME_KEYS], "5 个主题键").toEqual([...APPENDIX_THEME_KEYS]);

    const names = EXPECTED_SHOTS.map((e) => e.name);
    expect(names).toHaveLength(25);
    expect([...REQUIRED_SHOT_NAMES], "REQUIRED_SHOT_NAMES").toEqual(names);
    expect(
      REVIEW_CATALOG.map((d) => d.name),
      "REVIEW_CATALOG 的名称与顺序",
    ).toEqual(names);
    expect(
      REVIEW_CATALOG.map((d) => d.rs),
      "REVIEW_CATALOG 的附录 A 编号",
    ).toEqual(EXPECTED_SHOTS.map((e) => e.rs));
  });

  test("13.2：7 项 Checklist（H1、H4、H5、H6、H7、H10、H11）各被至少 1 张 Review_Shot 引用", () => {
    expect([...REQUIRED_CHECKLIST]).toEqual(Object.keys(APPENDIX_B_VISUAL));
    for (const item of REQUIRED_CHECKLIST) {
      const covering = REVIEW_CATALOG.filter((d) => d.checklist.includes(item));
      expect(covering.length, `${item} 应被至少 1 张 Review_Shot 引用`).toBeGreaterThanOrEqual(1);
    }
  });

  test("13.1：名称在 catalog 内唯一，可直接作文件名", () => {
    const names = REVIEW_CATALOG.map((d) => d.name);
    expect(new Set(names).size, "名称应互不相同").toBe(names.length);
    for (const name of names) expect(name, "名称的写法").toMatch(SHOT_NAME);
  });

  test("13.1：Library_Profile、视口、主题、服务器模式、状态、截取范围与 Checklist 项取值合法且与附录 A、B 相符", () => {
    expect(VIEWPORTS, "6.2 的两个视口").toEqual({
      desktop: { width: 1280, height: 800 },
      mobile: { width: 390, height: 844 },
    });
    for (const [def, want] of pairedShots()) {
      const where = def.name;
      expect(def.rs, `${where}：附录 A 编号`).toBe(want.rs);
      expect(def.profile, `${where}：Library_Profile`).toBe(want.profile);
      expect(def.viewport, `${where}：视口`).toBe(want.viewport);
      expect(def.theme, `${where}：主题（"unset" 为默认主题）`).toBe(want.theme);
      expect(def.mode, `${where}：服务器模式`).toBe(want.mode);
      // 附录 A 没有声明元素或整页范围的条目，一律取 13.1 的默认值（13.10：整页仅限显式声明的条目）
      expect(def.scope, `${where}：截取范围`).toBe("viewport");
      expect(def.state.trim(), `${where}：要展示的状态`).not.toBe("");
      expect(def.state, `${where}：要展示的状态不带首尾空白`).toBe(def.state.trim());
      for (const item of def.checklist) expect(APPENDIX_B_ITEMS, `${where}：Checklist 项编号`).toContain(item);
      expect([...def.checklist].sort(), `${where}：覆盖的 Checklist 项（附录 B"视觉评审"栏）`).toEqual(
        [...want.checklist].sort(),
      );
    }
  });

  test("13.1：书 id 与 URL：URL 为站内路径，含 {id} 时有书，书按用途解析为 roles.json 中的书", () => {
    for (const [def, want] of pairedShots()) {
      const where = def.name;
      expect(def.url.startsWith("/") && !def.url.startsWith("//"), `${where}：URL ${def.url} 应为站内路径`).toBe(true);
      if (def.url.includes(BOOK_ID_PLACEHOLDER)) expect(def.book, `${where}：URL 含 {id} 时应有书`).not.toBeNull();
      if (def.book !== null) {
        if ("role" in def.book) expect(BOOK_ROLES, `${where}：用途`).toContain(def.book.role);
        else expect(def.book.id.trim(), `${where}：书 id`).not.toBe("");
      }

      // 按用途取 roles.json 中承担该用途的书；源码里不写书 id（test-data-desensitization 需求 4.1）
      const id = resolveShotBook(def, SAMPLE_ROLES);
      if (def.book !== null && "role" in def.book) {
        expect(id, `${where}：用途 ${def.book.role} 应解析为 roles.json 中承担它的书`).toBe(SAMPLE_ROLE_BOOK[def.book.role]);
      }
      if (want.book !== null) {
        expect(def.book, `${where}：附录 A 点名的书承担 ${want.book} 用途`).toEqual({ role: want.book });
      }
      if (want.url !== null) expect(resolveShotUrl(def, id), `${where}：URL`).toBe(want.url);
    }
  });

  test("13.1：准则为 1–5 条、从 1 起连续编号，与附录 A 原文逐条相同，点名的 Review_Shot 存在", () => {
    const rsInCatalog = new Set(REVIEW_CATALOG.map((d) => d.rs));
    for (const [def, want] of pairedShots()) {
      const where = def.name;
      const { criteria } = def;
      expect(criteria.length, `${where}：准则条数`).toBeGreaterThanOrEqual(1);
      expect(criteria.length, `${where}：准则条数`).toBeLessThanOrEqual(5);
      // 编号即下标 + 1：数组没有空位，编号才从 1 起连续
      expect(Object.keys(criteria), `${where}：准则数组不应有空位`).toEqual(criteria.map((_, i) => String(i)));
      expect([...criteria], `${where}：准则原文（附录 A 以"；"切分）`).toEqual([...want.criteria]);

      criteria.forEach((text, i) => {
        const at = `${where} 第 ${i + 1} 条`;
        expect(text.trim(), `${at}：非空`).not.toBe("");
        expect(text, `${at}：不带首尾空白`).toBe(text.trim());
        expect(text, `${at}：已按"；"切分、不含换行`).not.toMatch(/[；\r\n]/);
        expect(text, `${at}：原文不自带编号`).not.toMatch(/^\d+\s*[.、．)）]/);
        expect(text, `${at}：不涉及动画或时长`).not.toMatch(NOT_IN_A_STILL);
        for (const ref of text.match(RS_REF) ?? []) {
          expect(rsInCatalog.has(ref), `${at}：点名的 ${ref} 应在 catalog 中`).toBe(true);
          expect(ref, `${at}：点名的应是另一张 Review_Shot`).not.toBe(def.rs);
        }
      });
    }
  });

  test("RDF 13.6：RS-20 load-error 为附录 A 原文的 2 条准则加第 3 条「错误说明是一句中文提示，不含英文异常信息或 HTML 片段」", () => {
    const defs = REVIEW_CATALOG.filter((d) => d.rs === "RS-20");
    expect(
      defs.map((d) => d.name),
      "RS-20 只有 load-error 一张",
    ).toEqual(["load-error"]);
    expect([...defs[0].criteria], "RS-20 的准则").toEqual([
      '显示表明未能打开该书的错误标题、一行错误说明与"返回书架"按钮',
      "页面非空白",
      "错误说明是一句中文提示，不含英文异常信息或 HTML 片段",
    ]);
  });

  test("13.1、13.4：by 指向在该 Library_Profile 与服务器模式下收集、以 SHOT_TESTS 的标题声明的用例", async () => {
    const entries = shotTestEntries();

    for (const def of REVIEW_CATALOG) {
      const hits = entries.filter((e) => sameShotTest(e.ref, def.by));
      expect(hits.length, `${def.name}：by 应恰为 SHOT_TESTS 中的一项`).toBe(1);
      const dir = def.by.file.split("/")[0];
      expect(
        SHOT_DIRS[`${def.profile}/${def.mode}`],
        `${def.name}：${def.by.file} 应属于 ${def.profile}、${def.mode} 的项目`,
      ).toContain(dir);
    }

    for (const { key, ref } of entries) {
      const where = `SHOT_TESTS.${key}「${ref.title}」`;
      expect(
        REVIEW_CATALOG.some((d) => sameShotTest(d.by, ref)),
        `${where}：应被至少 1 张 Review_Shot 引用`,
      ).toBe(true);
      expect(ref.title.trim(), `${where}：标题非空`).not.toBe("");
      expect(ON_DEMAND.test(ref.title), `${where}：标题不应带按需运行的标签`).toBe(false);
      expect(ref.file, `${where}：文件路径相对 e2e/tests、以 / 分隔`).toMatch(/^[a-z-]+\/[a-z0-9-]+\.spec\.ts$/);
      // reporter 与 shot fixture 由用例的绝对路径得到 by，口径须与这里相同
      const abs = path.join(TESTS_ROOT, ...ref.file.split("/"));
      expect(shotTestRef(abs, ref.title), `${where}：由绝对路径得到的 by`).toEqual(ref);
    }

    const byFile = new Map<string, { key: string; ref: ShotTestRef }[]>();
    for (const e of entries) byFile.set(e.ref.file, [...(byFile.get(e.ref.file) ?? []), e]);
    for (const [file, group] of byFile) {
      const text = await readFile(path.join(TESTS_ROOT, ...file.split("/")), "utf8");
      for (const key of new Set(group.map((e) => e.key))) {
        const declared = new RegExp(`\\btest\\(\\s*SHOT_TESTS\\.${key}\\b`);
        expect(declared.test(text), `${file} 应以 test(SHOT_TESTS.${key}… 声明用例`).toBe(true);
      }
      const titles = group.map((e) => e.ref.title);
      expect(new Set(titles).size, `${file} 中拍摄用例的标题应互不相同`).toBe(titles.length);
    }
  });
});

// ---------------------------------------------------------------------------
// RDF 16.1：未拍摄原因区分"命令行过滤未选中"与"中止"（任务 5.2；需求 16.1、16.4）
// ---------------------------------------------------------------------------

/** 例子所用的 Review_Shot：fixture、Opaque_Mode 的 load-error（RS-20）。 */
const RDF_SHOT = reviewShot("load-error");
const RDF_SHOT_KEY = shotCaseKey(RDF_SHOT.profile, RDF_SHOT.mode, RDF_SHOT.by);
/** 同一次运行收集到的另一个用例：运行确实收集了用例，只是没有 load-error 的拍摄用例。 */
const OTHER_COLLECTED_KEY = shotCaseKey("fixture", "opaque", { file: "fixture/bookshelf.spec.ts", title: "另一个用例" });

/** `notRun`：已收集、却因运行被中断或未执行而没有完成的结果（`classify` 的口径）。 */
const NOT_RUN_RESULT: ShotCaseResult = { outcome: "notRun", timedOut: false, skipReason: null, step: null, shots: [] };

/** 默认：fixture 已执行、未中止、未被中断、没有任何结果、没有过滤参数。 */
function rdfRunFacts(over: Partial<ShotRunFacts>): ShotRunFacts {
  return {
    selected: PROFILES,
    abortStage: null,
    interrupted: false,
    cases: new Map<string, ShotCaseResult>(),
    collected: new Set([OTHER_COLLECTED_KEY]),
    filterArgs: [],
    ...over,
  };
}

/** 只含 load-error 一节的 Review_Report 中"未拍摄原因"各行的值。 */
function reportedReasons(status: ShotStatus): string[] {
  const markdown = renderReviewReport([RDF_SHOT], new Map([[RDF_SHOT.name, status]]), {
    startedAt: "2026-10-02T09:00:00.000+08:00",
    profiles: PROFILES,
    roles: SAMPLE_ROLES,
  });
  return markdown
    .split("\n")
    .filter((line) => line.startsWith(REPORT_TEXT.reason))
    .map((line) => line.slice(REPORT_TEXT.reason.length));
}

/** load-error 在 `facts` 下未拍摄、原因为 `reason`，且 Review_Report 该节恰有 1 行原因 `text`。 */
function expectUncaptured(facts: ShotRunFacts, reason: UncapturedReason, text: string, where: string): void {
  const status = resolveShotStatus(RDF_SHOT, facts);
  expect(status, `${where}：拍摄状态`).toEqual({ captured: false, test: formatShotTest(RDF_SHOT.by), reason });
  expect(reportedReasons(status), `${where}：Review_Report 中 load-error 一节的未拍摄原因`).toEqual([text]);
}

/** `run.mjs` 启动 Playwright 时主进程 `process.argv` 的形状：`[node, <@playwright/test/cli>, "test", …]`。 */
function cliArgv(...args: string[]): string[] {
  return ["C:\\Program Files\\nodejs\\node.exe", "D:\\repo\\node_modules\\@playwright\\test\\cli.js", "test", ...args];
}

test.describe("Review_Report 未拍摄原因（reader-defect-fixes 需求 16.1）", () => {
  test("RDF 16.1：运行未中止、拍摄用例因命令行过滤未被收集 → 注明「用例未被本次运行选中（命令行过滤）」并附过滤参数，不写「运行在拍摄前中止」", () => {
    const filterArgs = extractFilterArgs(cliArgv("fixture/bookshelf.spec.ts", "-g", "书架", "--project=fixture"));
    expect(filterArgs, "本次运行的过滤参数").toEqual(["fixture/bookshelf.spec.ts", "-g", "书架", "--project=fixture"]);
    const reason: UncapturedReason = { kind: "not-selected", filter: filterArgs };
    const text = "用例未被本次运行选中（命令行过滤：fixture/bookshelf.spec.ts -g 书架 --project=fixture）";

    expectUncaptured(rdfRunFacts({ filterArgs }), reason, text, "运行正常结束");
    // 运行被中断（如 Ctrl+C）而该用例本就未被收集：仍是"未被选中"，不是"中止"
    expectUncaptured(rdfRunFacts({ filterArgs, interrupted: true }), reason, text, "运行被中断");
    // 未被收集、但命令行没有过滤参数（如 `--shard`、`test.only`）
    expectUncaptured(
      rdfRunFacts({}),
      { kind: "not-selected", filter: [] },
      `用例未被本次运行选中（命令行过滤：${NO_FILTER_ARGS}）`,
      "没有过滤参数",
    );
  });

  test("RDF 16.1：abort.json 存在 → 「运行在拍摄前中止」并附中止阶段，不论用例是否被收集、有无过滤参数", () => {
    const filterArgs = ["-g", "书架"];
    const reason: UncapturedReason = { kind: "aborted", cause: "abort", stage: "构建应用" };
    const text = "运行在拍摄前中止（中止阶段：构建应用）";

    // globalSetup 中止时 onBegin 未被调用，collected 为空
    expectUncaptured(
      rdfRunFacts({ abortStage: "构建应用", collected: new Set(), filterArgs }),
      reason,
      text,
      "未收集到用例",
    );
    expectUncaptured(
      rdfRunFacts({
        abortStage: "构建应用",
        collected: new Set([OTHER_COLLECTED_KEY, RDF_SHOT_KEY]),
        cases: new Map([[RDF_SHOT_KEY, NOT_RUN_RESULT]]),
        filterArgs,
        interrupted: true,
      }),
      reason,
      text,
      "已收集、结果为 notRun",
    );
  });

  test("RDF 16.1：用例已被收集、但运行被中断或该用例未执行 → 「运行在拍摄前中止」，不写「用例未被本次运行选中」", () => {
    const collected = new Set([OTHER_COLLECTED_KEY, RDF_SHOT_KEY]);
    const filterArgs = ["--project=fixture"];
    const shapes: readonly { readonly label: string; readonly cases: ReadonlyMap<string, ShotCaseResult> }[] = [
      { label: "没有结果", cases: new Map() },
      { label: "结果为 notRun", cases: new Map([[RDF_SHOT_KEY, NOT_RUN_RESULT]]) },
    ];
    for (const { label, cases } of shapes) {
      expectUncaptured(
        rdfRunFacts({ collected, cases, filterArgs, interrupted: true }),
        { kind: "aborted", cause: "interrupted" },
        "运行在拍摄前中止（运行被中断，该用例未执行完）",
        `运行被中断、${label}`,
      );
      expectUncaptured(
        rdfRunFacts({ collected, cases, filterArgs }),
        { kind: "aborted", cause: "not-executed" },
        "运行在拍摄前中止（该用例未执行）",
        `运行未被中断、${label}`,
      );
    }
  });
});

test.describe("extractFilterArgs（RDF 16.1）", () => {
  test("RDF 16.1：-g x、--grep=x、--project=fixture 与位置参数按原样、按出现顺序取出", () => {
    expect(extractFilterArgs(cliArgv("-g", "x")), "-g x").toEqual(["-g", "x"]);
    expect(extractFilterArgs(cliArgv("--grep=x")), "--grep=x").toEqual(["--grep=x"]);
    expect(extractFilterArgs(cliArgv("--project=fixture")), "--project=fixture").toEqual(["--project=fixture"]);
    expect(
      extractFilterArgs(cliArgv("fixture/load-error.spec.ts", "common/reader-progress.spec.ts:42")),
      "位置参数（文件过滤）",
    ).toEqual(["fixture/load-error.spec.ts", "common/reader-progress.spec.ts:42"]);
    expect(
      extractFilterArgs(cliArgv("load-error", "--grep=x", "--project", "fixture", "tooling", "-g", "y", "--last-failed")),
      "混合：--project 的多个取值、-g、--last-failed",
    ).toEqual(["load-error", "--grep=x", "--project", "fixture", "tooling", "-g", "y", "--last-failed"]);
  });

  test("RDF 16.1：非过滤选项及其取值、`--` 之后的参数不计入；没有过滤时为空数组", () => {
    expect(extractFilterArgs(cliArgv()), "没有参数").toEqual([]);
    expect(
      extractFilterArgs(cliArgv("--reporter", "list", "--workers=2", "-x", "--max-failures", "3", "--update-snapshots")),
      "只有非过滤选项",
    ).toEqual([]);
    expect(
      extractFilterArgs(cliArgv("--reporter", "list", "-g", "x", "--timeout", "5000", "fixture/load-error.spec.ts")),
      "非过滤选项的取值不当作位置参数",
    ).toEqual(["-g", "x", "fixture/load-error.spec.ts"]);
    expect(extractFilterArgs(cliArgv("-g", "x", "--", "fixture/load-error.spec.ts")), "`--` 之后").toEqual(["-g", "x"]);
  });
});

// ---------------------------------------------------------------------------
// RDF 16.3：Review_Report 的 PNG 行转义往返（任务 5.6；需求 16.3、16.4；RDF 属性 10）
// ---------------------------------------------------------------------------

/**
 * CommonMark 的 ASCII 标点（U+0021–002F、U+003A–0040、U+005B–0060、U+007B–007E）：`\` 后跟其中之一
 * 即该字符本身。
 */
function isAsciiPunctuation(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return (c >= 0x21 && c <= 0x2f) || (c >= 0x3a && c <= 0x40) || (c >= 0x5b && c <= 0x60) || (c >= 0x7b && c <= 0x7e);
}

/** 全部 32 个 ASCII 标点。 */
const ASCII_PUNCTUATION: readonly string[] = Array.from({ length: 0x7e - 0x21 + 1 }, (_, i) =>
  String.fromCharCode(0x21 + i),
).filter(isAsciiPunctuation);

/** CommonMark 的行结束符由 `\n`、`\r` 组成。 */
const isLineEnding = (ch: string): boolean => ch === "\n" || ch === "\r";

interface EscapedRun {
  /** 按反斜杠转义反解后的文字。 */
  readonly text: string;
  /** 结束符（首个未转义的 `close`）的下标。 */
  readonly end: number;
}

/**
 * 从 `line[start]` 起按 CommonMark 的反斜杠转义规则读到首个未转义的 `close`：`\` 后跟 ASCII 标点即
 * 该标点本身（不再有特殊含义）；`\` 后跟其它字符或位于末尾时是字面的 `\`。遇到未转义的 `forbidden`
 * 字符或行结束符、或读到末尾仍没有 `close` 时抛出错误（`what` 用于报错）。按 UTF-16 码元读取：
 * 特殊字符都在 ASCII 内，代理对原样保留。
 */
function readEscaped(line: string, start: number, close: string, forbidden: string, what: string): EscapedRun {
  let text = "";
  let i = start;
  while (i < line.length) {
    const ch = line[i];
    if (ch === "\\") {
      const next = line[i + 1];
      if (next !== undefined && isAsciiPunctuation(next)) {
        text += next;
        i += 2;
      } else {
        text += ch;
        i += 1;
      }
      continue;
    }
    if (ch === close) return { text, end: i };
    if (forbidden.includes(ch) || isLineEnding(ch)) {
      throw new Error(`${what}中第 ${i} 个码元 ${JSON.stringify(ch)} 未转义：${JSON.stringify(line)}`);
    }
    text += ch;
    i += 1;
  }
  throw new Error(`${what}没有未转义的结束符 ${JSON.stringify(close)}：${JSON.stringify(line)}`);
}

/** 参照解析的结果：反解后的替代文本与链接目标。 */
interface ParsedImage {
  readonly alt: string;
  readonly destination: string;
}

/**
 * 参照解析器：把 `image` 整段按 CommonMark 读作 `![A](<D>)`（不带标题，`)` 之后即结束）。
 * - A 为链接文本（图片描述），读到首个未转义的 `]` 为止；其中不得有未转义的 `[` 与行结束符
 *   （需求 16.3 要求方括号一律转义；CommonMark 本身还允许成对的方括号，这里更严）。
 * - D 为尖括号形式的链接目标，读到首个未转义的 `>` 为止；其中不得有未转义的 `<` 与行结束符
 *   （CommonMark 对尖括号形式的要求）。
 * 返回按反斜杠转义规则反解后的 A 与 D；结构不合要求时抛出错误。只处理反斜杠转义（属性 10 的口径），
 * 不处理代码段、原始 HTML、自动链接、强调与实体引用。
 */
function parseImage(image: string): ParsedImage {
  const expectAt = (at: number, token: string): number => {
    if (!image.startsWith(token, at)) {
      throw new Error(`第 ${at} 个码元处应为 ${JSON.stringify(token)}：${JSON.stringify(image)}`);
    }
    return at + token.length;
  };
  const alt = readEscaped(image, expectAt(0, "!["), "]", "[", "替代文本");
  const destination = readEscaped(image, expectAt(alt.end, "](<"), ">", "<", "链接目标");
  const end = expectAt(destination.end, ">)");
  if (end !== image.length) {
    throw new Error(`图片之后还有 ${JSON.stringify(image.slice(end))}：${JSON.stringify(image)}`);
  }
  return { alt: alt.text, destination: destination.text };
}

/** 属性 10 的名称字母表：有特殊含义的 ASCII 标点、空格与制表符、字母数字、中文与代理对。 */
const ESCAPE_NAME_UNITS = [..."\\[]<>()!*_`&#.- \t", ..."aZ09", ..."中文书", "𠮷"];

/** 转义的边界：末尾的 `\`、`\` 与被转义字符相邻、形似图片语法的片段、空名称。 */
const TRICKY_NAMES = [
  "",
  "\\",
  "a\\",
  "\\\\",
  "\\]",
  "\\[",
  "\\<",
  "\\>",
  "\\a",
  "](",
  "](<x",
  "x>)",
  "<>",
  "[]",
  "[[]]",
  "![a](<b>)",
  "`",
  "中文\\书",
];

/** 不含 `\r`、`\n` 的名称：上面的字母表、全部 ASCII 标点、任意码点、边界片段或真实 catalog 的名称。 */
const escapeNameArb: fc.Arbitrary<string> = fc
  .oneof(
    { weight: 4, arbitrary: fc.string({ unit: fc.constantFrom(...ESCAPE_NAME_UNITS), maxLength: 12 }) },
    { weight: 2, arbitrary: fc.string({ unit: fc.constantFrom(...ASCII_PUNCTUATION, " ", "a"), maxLength: 12 }) },
    { weight: 1, arbitrary: fc.string({ unit: "binary", maxLength: 12 }) },
    { weight: 1, arbitrary: fc.constantFrom(...TRICKY_NAMES) },
    { weight: 1, arbitrary: fc.constantFrom(...REVIEW_CATALOG.map((d) => d.name)) },
  )
  .filter((name) => !/[\r\n]/.test(name));

/** 1–4 个互不相同的名称，各以一个真实条目为底，全部已拍摄（最终结果任意）。 */
const escapeCaseArb = fc.uniqueArray(
  fc.record({
    name: escapeNameArb,
    base: fc.nat({ max: REVIEW_CATALOG.length - 1 }),
    result: fc.constantFrom(...OUTCOMES),
    timedOut: fc.boolean(),
  }),
  { selector: (r) => r.name, minLength: 1, maxLength: 4 },
);

const ESCAPE_REPORT_META: ReviewReportMeta = {
  startedAt: "2026-10-02T09:00:00.000+08:00",
  profiles: PROFILES,
  roles: SAMPLE_ROLES,
};

test.describe("Review_Report 的 PNG 行（reader-defect-fixes 需求 16.3）", () => {
  test("RDF 16.3：参照解析器按 CommonMark 反斜杠转义反解，拒绝未转义的方括号、尖括号与行结束符", () => {
    expect(parseImage("![a\\]b\\[c\\\\](<d\\>e\\<f\\\\.png>)"), "转义的方括号、尖括号与反斜杠").toEqual({
      alt: "a]b[c\\",
      destination: "d>e<f\\.png",
    });
    expect(parseImage("![\\a\\中\\ ](<\\a.png>)"), "`\\` 后跟非 ASCII 标点时是字面的 `\\`").toEqual({
      alt: "\\a\\中\\ ",
      destination: "\\a.png",
    });
    expect(parseImage("![\\*\\_\\`\\!](<\\(\\) x.png>)"), "其它 ASCII 标点的转义；目标中的空格与圆括号").toEqual({
      alt: "*_`!",
      destination: "() x.png",
    });
    expect(parseImage("![](<>)"), "空的替代文本与目标").toEqual({ alt: "", destination: "" });

    const malformed = [
      "![a]b](<c.png>)",
      "![a[b](<c.png>)",
      "![a\\](<b.png>)",
      "![a](<b<c.png>)",
      "![a](<b>c.png>)",
      "![a](b.png)",
      "![a](<b.png>) ",
      "![a](<b\nc.png>)",
      "![a\rb](<c.png>)",
      "![a](<b.png",
      "[a](<b.png>)",
    ];
    for (const line of malformed) expect(() => parseImage(line), JSON.stringify(line)).toThrow();
  });

  // Feature: reader-defect-fixes, Property 10: Review_Report 的 PNG 行转义往返
  // **Validates: Requirements 16.3, 16.4**
  test("RDF 16.3：任意不含换行的名称，PNG 行为 ![A](<D>)，A 中的方括号与 D 中的尖括号都已转义；按 CommonMark 反斜杠转义反解后 A 等于名称、D 等于 <名称>.png", () => {
    fc.assert(
      fc.property(escapeCaseArb, (rows) => {
        const catalog = rows.map(({ name, base }): ReviewShotDef => ({ ...REVIEW_CATALOG[base], name }));
        const statuses = new Map(
          rows.map(({ name, base, result, timedOut }): [string, ShotStatus] => [
            name,
            { captured: true, test: formatShotTest(REVIEW_CATALOG[base].by), result, timedOut },
          ]),
        );
        const report = parseReport(renderReviewReport(catalog, statuses, ESCAPE_REPORT_META));
        assert.deepEqual(
          report.sections.map((s) => s.heading),
          catalog.map((d) => d.name),
          "节标题应依次等于各名称",
        );

        catalog.forEach(({ name }, i) => {
          const where = `第 ${i + 1} 节 ${JSON.stringify(name)}`;
          const file = pngFileOf(name);
          assert.equal(reviewShotFileName(name), file, `${where}：reviewShotFileName`);
          const expected: ParsedImage = { alt: name, destination: file };

          // 转义函数本身
          const direct = `![${escapeLinkText(name)}](${escapeLinkDestination(file)})`;
          assert.deepEqual(parseImage(direct), expected, `${where}：转义函数拼出的 ${JSON.stringify(direct)}`);

          // 报告中该节的 PNG 行
          const images = valuesAfter(report.sections[i].lines, REPORT_TEXT.png);
          assert.equal(images.length, 1, `${where}：已拍摄的节应恰有 1 行 PNG，实际 ${images.length} 行`);
          assert.deepEqual(parseImage(images[0]), expected, `${where}：PNG 行 ${JSON.stringify(images[0])}`);
        });
      }),
      { numRuns: 100 },
    );
  });
});
