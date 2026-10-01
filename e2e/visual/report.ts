/**
 * Run_Summary 第 11 节"视觉回归"的整理与渲染（需求 12.5、12.6；设计"像素视觉回归"的"失败报告"
 * 一条）。本文件全是纯函数：不读写文件、不访问网络、不修改参数。reporter（`support/reporter.ts`）
 * 只把 `BASELINES` 与本次的 `CaseFacts` 交给 `buildVisualSection`，再把 `renderVisualSection` 的
 * 结果作为该节正文，`VisualSectionData` 随 `results.json` 写出。
 *
 * ## 识别 Visual_Regression_Check 的用例
 *
 * 文件为 `e2e/tests/fixture/visual.spec.ts`（`VISUAL_SPEC_FILE`），用例自身的标题由
 * `naming.ts` 的 `visualTestTitle` 生成、`baselineNameOfTitle` 取回基线名。每个 `BaselineDef`
 * 按 `BASELINES` 的顺序占一行；本次没有收集到它的用例时记"未收集"（如以 `-g` 或文件参数只选了
 * 部分用例）。标题对不上任何定义的用例单独列出（说明标题格式与 `naming.ts` 不一致）。
 *
 * ## 失败的归类
 *
 * 1. 报错中有 12.6 的信息（`parseMissingBaseline`）→ 缺少基线：写基线路径与更新命令，没有图片。
 * 2. 否则取第一条能被 `parseScreenshotFailure` 解析的报错 → 超出容差（`pixels`）或尺寸不符
 *    （`size`），写三张图的路径与差异像素数、占比，尺寸不符时另写两组宽高（12.5）。
 * 3. 否则若有任一张 `<name>-expected|actual|diff.png` 附件，或报错来自 `toHaveScreenshot`
 *    → 比对失败（如连拍两张不稳定、超时），写报错正文与已有的图。
 * 4. 其余 → 失败（发生在比对之前，如字面量核对、主题断言、遮罩核对），写所处步骤与错误首行。
 *
 * 三张图取自 Playwright 附在结果上的附件（1.62.1 的 `SnapshotHelper.handleDifferent`）：名称为
 * `<toHaveScreenshot 的名称去掉扩展名>-expected.png` / `-actual.png` / `-diff.png`，即
 * `px-reader-dark-expected.png` 等；`-expected` 的 `path` 指向基线文件本身
 * （`e2e/baselines/<name>-<platform>.png`），另两张在该用例的输出目录（`e2e/.out/test-results/`
 * 下）。路径经 `repoRelative` 写成相对仓库根。
 *
 * ## 占比
 *
 * Playwright 原文的 `ratio` 向上取整到两位小数（见 `parseScreenshotFailure`），这里另以差异像素数
 * 除以比对尺寸的像素数给出精确占比。比对尺寸与 Playwright 一致：尺寸相同时即基线宽高，也就是该基线的
 * 视口（12.9，`visual.spec.ts` 第 5 步已核对视口）；尺寸不符时 Playwright 先把两图补齐到较大的宽与
 * 较大的高再比对，`ratio` 与容差都按补齐后的尺寸计，这里的宽高取自报错中的两组宽高。容差上限为
 * `⌊宽 × 高 × VISUAL.maxDiffPixelRatio⌋`（Playwright 在差异像素数大于 `宽 × 高 × ratio` 时判失败）。
 */
import { repoRelative } from "../support/library";
import { VISUAL } from "../support/settings";
import {
  TITLE_SEPARATOR,
  UNSPECIFIED_SKIP_REASON,
  mdArtifact,
  mdCell,
  mdCode,
  mdOneLine,
  mdTableRow,
  stripAnsi,
  toCaseRow,
  type ArtifactRef,
  type CaseAttachment,
  type CaseFacts,
  type CaseOutcome,
  type CaseRow,
} from "../support/summary";
import {
  baselineNameOfTitle,
  parseMissingBaseline,
  parseScreenshotFailure,
  type ImageSize,
  type ScreenshotFailure,
} from "./naming";

/** Visual_Regression_Check 的用例文件（相对仓库根，12.1：只在 `tests/fixture/`）。 */
export const VISUAL_SPEC_FILE = "e2e/tests/fixture/visual.spec.ts";

/** 基线定义所在的文件（summary 中注明）。 */
const BASELINES_FILE = "e2e/visual/baselines.ts";

// ---------------------------------------------------------------------------
// 模型
// ---------------------------------------------------------------------------

/** reporter 由 `BASELINES` 给出的一张基线。 */
export interface VisualBaselineRef {
  name: string;
  /** 该基线的视口，即截图尺寸（12.9）。 */
  viewport: ImageSize;
  /** 基线文件相对仓库根的路径（`naming.ts` 的 `baselinePath`）。 */
  file: string;
}

/** 12.5 的三张图。 */
export interface VisualImages {
  expected: ArtifactRef;
  actual: ArtifactRef;
  diff: ArtifactRef;
}

/** 差异像素数与精确占比（`basis` 为计算占比与容差所用的比对尺寸）。 */
export interface VisualDiffPixels {
  count: number;
  /** `count / (basis.width × basis.height)`。 */
  ratio: number;
  /** Playwright 原文中的 `ratio`（向上取整到两位小数）。 */
  reportedRatio: number;
  /** 尺寸相同时为基线宽高；尺寸不符时为两图补齐后的宽高（较大的宽 × 较大的高），与 Playwright 一致。 */
  basis: ImageSize;
  /** 容差上限（差异像素数）：`⌊basis.width × basis.height × VISUAL.maxDiffPixelRatio⌋`。 */
  maxPixels: number;
}

export type VisualResult =
  | { kind: "passed" }
  | { kind: "missingBaseline"; file: string; command: string }
  | {
      kind: "mismatch";
      failure: ScreenshotFailure;
      /** 差异像素；Playwright 未报告（尺寸不符但未超容差，或 `unknown`）时为 null。 */
      pixels: VisualDiffPixels | null;
      images: VisualImages;
      errorLine: string;
    }
  | { kind: "failed"; step: string; errorLine: string; timedOut: boolean }
  | { kind: "skipped"; reason: string }
  | { kind: "expectedFail"; findings: string[] }
  | { kind: "unexpectedPass"; findings: string[] }
  /** 收集到了用例，但没有结果（运行被中断）。 */
  | { kind: "notRun" }
  /** 本次没有收集到该基线的用例。 */
  | { kind: "notCollected" };

/** 某张基线在本次运行中的一行。 */
export interface VisualEntry {
  name: string;
  /** 基线文件相对仓库根的路径。 */
  file: string;
  viewport: ImageSize;
  /** 对应的用例；未收集时为 null。 */
  test: { file: string; title: string; project: string } | null;
  result: VisualResult;
}

/** 标题对不上任何基线定义的 `visual.spec.ts` 用例。 */
export interface UnmatchedVisualCase {
  file: string;
  title: string;
  project: string;
  outcome: CaseOutcome;
}

/** "视觉回归"一节的数据（随 `results.json` 写出）。 */
export interface VisualSectionData {
  baselineDir: string;
  tolerance: { threshold: number; maxDiffPixelRatio: number };
  /** 基线定义数（`BASELINES` 的长度）。 */
  baselines: number;
  /** 本次收集到的 `visual.spec.ts` 用例数。 */
  collected: number;
  /** 按 `BASELINES` 的顺序；同一基线有多个用例（多个项目）时按项目名与用例 id 排列。 */
  entries: VisualEntry[];
  unmatched: UnmatchedVisualCase[];
}

// ---------------------------------------------------------------------------
// 整理
// ---------------------------------------------------------------------------

/** 用例是否属于 Visual_Regression_Check（按文件识别）。 */
export function isVisualCase(f: CaseFacts): boolean {
  return repoRelative(f.file) === VISUAL_SPEC_FILE;
}

function ownTitle(f: CaseFacts): string {
  return f.titlePath[f.titlePath.length - 1] ?? "";
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function imageRef(attachments: readonly CaseAttachment[], name: string): ArtifactRef {
  const found = attachments.find((a) => a.name === name);
  if (found === undefined) return { missing: `没有 ${name} 附件` };
  if (found.path === undefined) return { missing: `${name} 附件没有文件路径` };
  return { path: repoRelative(found.path) };
}

function imagesOf(name: string, attachments: readonly CaseAttachment[]): VisualImages {
  return {
    expected: imageRef(attachments, `${name}-expected.png`),
    actual: imageRef(attachments, `${name}-actual.png`),
    diff: imageRef(attachments, `${name}-diff.png`),
  };
}

function hasAnyImage(images: VisualImages): boolean {
  return "path" in images.expected || "path" in images.actual || "path" in images.diff;
}

/** `toHaveScreenshot` 的报错首行（可带 `.not` 等修饰）。 */
const SCREENSHOT_MATCHER = /\.toHaveScreenshot\(/;

/** 容差上限（差异像素数）。 */
export function maxDiffPixelsFor(size: ImageSize): number {
  return Math.floor(size.width * size.height * VISUAL.maxDiffPixelRatio);
}

/**
 * 尺寸不符时 Playwright 的比对尺寸：两图补齐到较大的宽与较大的高（1.62.1 `compareImages` 的
 * `padImageToSize`），`ratio` 与容差上限都按它计。
 */
export function paddedSize(expected: ImageSize, actual: ImageSize): ImageSize {
  return { width: Math.max(expected.width, actual.width), height: Math.max(expected.height, actual.height) };
}

function diffPixelsOf(failure: ScreenshotFailure, viewport: ImageSize): VisualDiffPixels | null {
  let basis: ImageSize;
  let count: number;
  let reportedRatio: number;
  if (failure.kind === "pixels") {
    basis = viewport;
    ({ count, ratio: reportedRatio } = failure);
  } else if (failure.kind === "size" && failure.pixels !== null) {
    basis = paddedSize(failure.expected, failure.actual);
    ({ count, ratio: reportedRatio } = failure.pixels);
  } else {
    return null;
  }
  const area = basis.width * basis.height;
  return { count, ratio: area > 0 ? count / area : 0, reportedRatio, basis, maxPixels: maxDiffPixelsFor(basis) };
}

function failedResult(f: CaseFacts, def: VisualBaselineRef, row: CaseRow): VisualResult {
  const errors = f.result?.errors ?? [];
  for (const error of errors) {
    const missing = parseMissingBaseline(error);
    if (missing !== null) return { kind: "missingBaseline", ...missing };
  }

  const errorLine = row.errorLine ?? "（没有错误信息）";
  const images = imagesOf(def.name, f.result?.attachments ?? []);
  const parsed = errors.map(parseScreenshotFailure);
  const known = parsed.find((p) => p.kind !== "unknown");
  if (known !== undefined) {
    return { kind: "mismatch", failure: known, pixels: diffPixelsOf(known, def.viewport), images, errorLine };
  }
  const fromMatcher = errors.findIndex((e) => SCREENSHOT_MATCHER.test(stripAnsi(e)));
  if (fromMatcher !== -1 || hasAnyImage(images)) {
    const failure = parsed[fromMatcher === -1 ? 0 : fromMatcher] ?? { kind: "unknown", detail: null };
    return { kind: "mismatch", failure, pixels: null, images, errorLine };
  }
  return { kind: "failed", step: row.step ?? "未记录", errorLine, timedOut: row.timedOut === true };
}

function resultOf(f: CaseFacts, def: VisualBaselineRef): { test: NonNullable<VisualEntry["test"]>; result: VisualResult } {
  const row = toCaseRow(f);
  const test = { file: row.file, title: row.title, project: row.project };
  switch (row.outcome) {
    case "passed":
      return { test, result: { kind: "passed" } };
    case "skipped":
      return { test, result: { kind: "skipped", reason: row.skip?.reason ?? UNSPECIFIED_SKIP_REASON } };
    case "expectedFail":
      return { test, result: { kind: "expectedFail", findings: row.findings } };
    case "unexpectedPass":
      return { test, result: { kind: "unexpectedPass", findings: row.findings } };
    case "notRun":
      return { test, result: { kind: "notRun" } };
    case "failed":
      return { test, result: failedResult(f, def, row) };
  }
}

/**
 * 由基线定义（按 `BASELINES` 的顺序）与本次全部用例的 `CaseFacts` 整理"视觉回归"一节的数据。
 * 不属于 `visual.spec.ts` 的用例被忽略。
 */
export function buildVisualSection(defs: readonly VisualBaselineRef[], cases: readonly CaseFacts[]): VisualSectionData {
  const known = new Set(defs.map((d) => d.name));
  const byName = new Map<string, CaseFacts[]>();
  const unmatched: UnmatchedVisualCase[] = [];
  let collected = 0;

  for (const f of cases) {
    if (!isVisualCase(f)) continue;
    collected += 1;
    const name = baselineNameOfTitle(ownTitle(f));
    if (name === null || !known.has(name)) {
      const row = toCaseRow(f);
      unmatched.push({ file: row.file, title: row.title, project: row.project, outcome: row.outcome });
      continue;
    }
    byName.set(name, [...(byName.get(name) ?? []), f]);
  }

  const entries = defs.flatMap((def): VisualEntry[] => {
    const own = [...(byName.get(def.name) ?? [])].sort(
      (a, b) => compareCodeUnits(a.project, b.project) || compareCodeUnits(a.id, b.id),
    );
    const base = { name: def.name, file: def.file, viewport: { ...def.viewport } };
    if (own.length === 0) return [{ ...base, test: null, result: { kind: "notCollected" } }];
    return own.map((f) => ({ ...base, ...resultOf(f, def) }));
  });

  unmatched.sort((a, b) => compareCodeUnits(a.file, b.file) || compareCodeUnits(a.title, b.title));
  return {
    baselineDir: VISUAL.baselineDir,
    tolerance: { threshold: VISUAL.threshold, maxDiffPixelRatio: VISUAL.maxDiffPixelRatio },
    baselines: defs.length,
    collected,
    entries,
    unmatched,
  };
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

/** 结果的分类键，按计数的列序。 */
const RESULT_KEYS = [
  "passed",
  "missingBaseline",
  "pixels",
  "size",
  "mismatch",
  "failed",
  "unexpectedPass",
  "expectedFail",
  "skipped",
  "notRun",
  "notCollected",
] as const;

type ResultKey = (typeof RESULT_KEYS)[number];

/** 各类结果在 summary 中的写法。 */
export const VISUAL_RESULT_LABELS: Readonly<Record<ResultKey, string>> = {
  passed: "通过",
  missingBaseline: "缺少基线",
  pixels: "超出容差",
  size: "尺寸不符",
  mismatch: "比对失败",
  failed: "失败",
  unexpectedPass: "意外通过",
  expectedFail: "预期失败",
  skipped: "跳过",
  notRun: "未执行",
  notCollected: "未收集",
};

function resultKey(r: VisualResult): ResultKey {
  if (r.kind !== "mismatch") return r.kind;
  return r.failure.kind === "pixels" ? "pixels" : r.failure.kind === "size" ? "size" : "mismatch";
}

/** 需在"未通过的基线"中逐条说明的结果。 */
function needsDetail(r: VisualResult): boolean {
  return r.kind === "missingBaseline" || r.kind === "mismatch" || r.kind === "failed" || r.kind === "unexpectedPass";
}

function groupDigits(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** 百分比，至多 3 位小数、去掉末尾的 0；大于 0 而不足 0.001% 时写"< 0.001%"。 */
function percentText(ratio: number): string {
  const pct = ratio * 100;
  if (pct > 0 && pct < 0.001) return "< 0.001%";
  return `${pct.toFixed(3).replace(/\.?0+$/, "")}%`;
}

function sizeText(s: ImageSize): string {
  return `${s.width}×${s.height}`;
}

function resultCell(e: VisualEntry): string {
  const r = e.result;
  const label = VISUAL_RESULT_LABELS[resultKey(r)];
  const project = e.test !== null && e.test.project !== "fixture" ? `（项目 ${e.test.project}）` : "";
  switch (r.kind) {
    case "skipped":
      return mdCell(`${label}${project}：${r.reason}`);
    case "failed":
      return mdCell(`${label}${r.timedOut ? "（超时）" : ""}${project}`);
    case "mismatch":
      return mdCell(
        r.pixels === null
          ? `${label}${project}`
          : `${label}${project}：${groupDigits(r.pixels.count)} 个像素（${percentText(r.pixels.ratio)}）`,
      );
    case "notCollected":
      return mdCell(`${label}（本次运行未选中该用例）`);
    default:
      return mdCell(`${label}${project}`);
  }
}

function countsText(d: VisualSectionData): string {
  const counts = new Map<ResultKey, number>();
  for (const e of d.entries) counts.set(resultKey(e.result), (counts.get(resultKey(e.result)) ?? 0) + 1);
  if (d.entries.length > 0 && counts.get("passed") === d.entries.length) {
    return `${d.baselines} 个基线，全部通过`;
  }
  const parts = RESULT_KEYS.filter((k) => (counts.get(k) ?? 0) > 0).map((k) => `${VISUAL_RESULT_LABELS[k]} ${counts.get(k)}`);
  return `${parts.join("、")}（共 ${d.baselines} 个基线）`;
}

function testLine(e: VisualEntry): string {
  return e.test === null ? "- 用例：本次未收集" : `- 用例：${mdCode(e.test.file)}${TITLE_SEPARATOR}${mdOneLine(e.test.title)}`;
}

/** `basisLabel`：尺寸相同时为"基线"，尺寸不符时为"两图补齐后的尺寸"。 */
function pixelsLines(p: VisualDiffPixels, basisLabel: string): string[] {
  return [
    `- 差异像素：${groupDigits(p.count)} 个，占 ${percentText(p.ratio)}` +
      `（按${basisLabel} ${sizeText(p.basis)} 计；容差上限 ${groupDigits(p.maxPixels)} 个，即 ${percentText(VISUAL.maxDiffPixelRatio)}）`,
    `- Playwright 报告的 ratio：${p.reportedRatio.toFixed(2)}（向上取整到两位小数）`,
  ];
}

function imagesLines(images: VisualImages): string[] {
  return [
    `- 基线：${mdArtifact(images.expected)}`,
    `- 实际：${mdArtifact(images.actual)}`,
    `- 差异：${mdArtifact(images.diff)}`,
  ];
}

function detailLines(e: VisualEntry): string[] {
  const r = e.result;
  const head = `${mdCode(e.name)}：${VISUAL_RESULT_LABELS[resultKey(r)]}`;
  switch (r.kind) {
    case "missingBaseline":
      return [
        head,
        `- 基线文件：${mdCode(r.file)} 不存在；非更新运行不补写基线（12.6）`,
        `- 生成基线：${mdCode(r.command)}`,
        testLine(e),
      ];
    case "mismatch": {
      const f = r.failure;
      const lines = [head];
      if (f.kind === "size") {
        lines.push(`- 尺寸：基线 ${sizeText(f.expected)}，实际 ${sizeText(f.actual)}`);
      }
      if (r.pixels !== null) lines.push(...pixelsLines(r.pixels, f.kind === "size" ? "两图补齐后的尺寸" : "基线"));
      else if (f.kind === "size") {
        const padded = paddedSize(f.expected, f.actual);
        lines.push(
          `- 差异像素：Playwright 未报告（补齐到 ${sizeText(padded)} 后未超过容差上限 ${groupDigits(maxDiffPixelsFor(padded))} 个）`,
        );
      } else {
        lines.push(`- 报错：${mdOneLine(f.kind === "unknown" && f.detail !== null ? f.detail : r.errorLine)}`);
      }
      lines.push(...imagesLines(r.images), testLine(e));
      return lines;
    }
    case "failed":
      return [
        `${head}${r.timedOut ? "（超时）" : ""}`,
        `- 所处步骤：${mdOneLine(r.step)}`,
        `- 错误信息首行：${mdOneLine(r.errorLine)}`,
        testLine(e),
      ];
    case "unexpectedPass":
      return [head, `- 引用的 Finding：${r.findings.length > 0 ? r.findings.join("、") : "未引用 Finding 编号"}`, testLine(e)];
    default:
      return [head, testLine(e)];
  }
}

/** 有序列表；续行缩进与序号宽度一致（第 10 项起为 4 格），子项才仍属于该项。 */
function numbered(items: readonly string[][]): string[] {
  return items.flatMap(([head, ...rest], i) => {
    const marker = `${i + 1}. `;
    const indent = " ".repeat(marker.length);
    return [`${marker}${head}`, ...rest.map((line) => `${indent}${line}`)];
  });
}

/** "视觉回归"一节的 Markdown 正文（不含节标题）。只读数据，不做判定。 */
export function renderVisualSection(d: VisualSectionData): string[] {
  const lines = [
    `- Pixel_Baseline：${d.baselines} 个（${mdCode(`${d.baselineDir}/`)}，定义见 ${mdCode(BASELINES_FILE)}）`,
    `- 容差（12.4）：threshold ${d.tolerance.threshold}，maxDiffPixelRatio ${d.tolerance.maxDiffPixelRatio}`,
  ];
  if (d.collected === 0) {
    lines.push(`- 结果：本次运行未收集 ${mdCode(VISUAL_SPEC_FILE)} 的用例，未做 Visual_Regression_Check`);
    return lines;
  }
  lines.push(
    `- 结果：${countsText(d)}`,
    "",
    mdTableRow(["基线", "视口", "结果"]),
    mdTableRow(["---", "---", "---"]),
    ...d.entries.map((e) => mdTableRow([mdCode(e.name), sizeText(e.viewport), resultCell(e)])),
  );

  const failing = d.entries.filter((e) => needsDetail(e.result));
  if (failing.length > 0) {
    lines.push(
      "",
      "### 未通过的基线",
      "",
      ...numbered(failing.map(detailLines)),
      "",
      `trace、失败时截图与浏览器控制台日志见"失败用例（含超时与意外通过）"一节。`,
    );
  }

  if (d.unmatched.length > 0) {
    lines.push(
      "",
      "### 未对应到基线定义的用例",
      "",
      ...d.unmatched.map(
        (u) =>
          `- ${mdCode(u.file)}${TITLE_SEPARATOR}${mdOneLine(u.title)}（项目 ${u.project}）：` +
          `标题不是 ${mdCode("12.2 <基线名>：…")} 的形式，或基线名不在 ${mdCode(BASELINES_FILE)} 中`,
      ),
    );
  }
  return lines;
}
