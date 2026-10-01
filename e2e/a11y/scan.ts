/**
 * 执行一次 A11y_Scan（需求 15.1、15.2、15.3、15.7、15.9；设计"无障碍冒烟（需求 15）"的
 * `runA11yScan` 四步；任务 20.3）。
 *
 * 用例（`a11y.spec.ts`，20.4）负责进入视图：按 `def.url` 导航、打开目标弹窗或抽屉、检索视图输入
 * `volumesKeyword`；对比度扫描在首次导航前 `seedTheme(def.theme)`，其余 6 个视图不 seed。
 * 然后调用 `runA11yScan(page, def)`：
 *
 * 1. 前提与冻结（15.1、15.7 (a)）：桌面视口 1280×800；默认主题的扫描本上下文没有 `seedTheme` 过；
 *    `page.addStyleTag` 注入 `FREEZE_MOTION_CSS` 禁用 CSS 动画与过渡，并确认页面匹配
 *    `prefers-reduced-motion: reduce`（全局 `use.reducedMotion`）。
 * 2. 在 `TIMEOUTS.wait` 内等到 15.7 (b)–(d) 与视图本身就绪（`unmetScanConditions`）；定义声明了
 *    主题键时（15.2 的对比度扫描）再 `assertTheme`。设置抽屉已关闭由 (c) 保证（阅读器正文视图要求
 *    弹窗与抽屉合计 0 个）。
 * 3. `new AxeBuilder({ page })`：`wcag` 规则集 `.withTags([...A11Y_TAGS])`（15.3，标签清单只在
 *    `settings.ts`），`color-contrast` 规则集 `.withRules(["color-contrast"])`（15.2）；不设
 *    `include`，即整页；`.analyze()`。
 * 4. `summarizeAxe` 归纳，附为 `a11y-result`（`A11Y_RESULT_ATTACHMENT`），同时写
 *    `e2e/.out/a11y/<name>.json`。
 *
 * ## 判定（15.8、15.9、16.4）
 *
 * - 违规与 incomplete 从不断言：扫描成功时本函数不因它们抛错。
 * - 第 1–3 步抛错（前提不符、注入失败、axe 执行抛错或未返回结果、等待超时、主题断言不成立）时，先
 *   附 `{ status: "failed", reason }` 并写结果文件，再重抛，用例失败。reason 以所处阶段开头。
 * - 目标元素已渲染却定位不到（16.4 的可测性缺口）：用例在 Findings_Log 记 Finding 后调用
 *   `skipA11yScan(def, "F-xxx", 说明)`，附 `{ status: "skipped" }` 并以 `[16.4 F-xxx]` 前缀跳过。
 * - 用例在调用 `runA11yScan` 之前就失败或超时（如目标抽屉打不开）时没有附件；用例文件在
 *   `test.afterEach` 中调用 `ensureA11yResult(testInfo, def)` 补记 `failed`（或 `skipped`），
 *   reporter 因此只对真正没有运行的用例写"未执行"。
 *
 * ## `[aria-busy="true"]` 的计数
 *
 * 15.7 (b) 以属性本身定义条件，且 Playwright 的 `getByRole` 没有按 `aria-busy` 过滤的选项；
 * 这里在页内以 `querySelectorAll` 计数，只用于度量条件是否成立，不用来定位或操作任何元素（D8 与
 * `locators.ts` 模块说明的"测量性 DOM 遍历"）。其余定位一律经 `locators.ts`。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { stripVTControlCharacters } from "node:util";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { assertTheme, seededTheme } from "../support/fixtures";
import {
  detailModal,
  overlayMarkers,
  readerJumpHighlight,
  readerLoading,
  searchDrawer,
  viewMarkers,
} from "../support/locators";
import { A11Y_TAGS, TIMEOUTS, VIEWPORTS } from "../support/settings";
import { step } from "../support/step";
import { themeToSeed } from "../support/theme";
import {
  A11Y_DIR,
  A11Y_RESULT_ATTACHMENT,
  A11Y_VIEW_LABELS,
  COLOR_CONTRAST_RULE,
  a11yResultFile,
  a11yResultWithoutAxe,
  type A11yScanDef,
} from "./scans";
import { summarizeAxe, type A11yScanResult, type A11yView } from "./summarize";

/** 15.7 (a)：禁用 CSS 动画与过渡（`prefers-reduced-motion: reduce` 由全局 `use.reducedMotion` 设定）。 */
export const FREEZE_MOTION_CSS =
  "*, *::before, *::after { animation: none !important; transition: none !important; }";

/** 失败原因的阶段前缀（reason 以此开头）。 */
export const A11Y_SCAN_PHASES = {
  precondition: "扫描前提",
  freeze: "冻结动画",
  wait: "等待 15.7 条件",
  axe: "运行 axe",
} as const;

type OverlayKey = keyof ReturnType<typeof overlayMarkers>;

const OVERLAY_KEYS: readonly OverlayKey[] = ["detailModal", "tocDrawer", "searchDrawer", "settingsDrawer"];

const OVERLAY_LABELS: Readonly<Record<OverlayKey, string>> = {
  detailModal: "详情弹窗",
  tocDrawer: "目录抽屉",
  searchDrawer: "检索抽屉",
  settingsDrawer: "设置抽屉",
};

/** 各视图的目标弹窗或抽屉（15.7 (c)）；书架首屏与阅读器正文为 null，即弹窗与抽屉合计 0 个。 */
const TARGET_OVERLAY: Readonly<Record<A11yView, OverlayKey | null>> = {
  shelf: null,
  detail: "detailModal",
  reader: null,
  toc: "tocDrawer",
  search: "searchDrawer",
  settings: "settingsDrawer",
};

/** 各视图所在的主视图：详情弹窗叠在书架上，三个抽屉叠在阅读器正文上。 */
const BASE_VIEW: Readonly<Record<A11yView, "shelf" | "reader">> = {
  shelf: "shelf",
  detail: "shelf",
  reader: "reader",
  toc: "reader",
  search: "reader",
  settings: "reader",
};

const BASE_VIEW_MARKER_LABELS: Readonly<Record<"shelf" | "reader", string>> = {
  shelf: "书架检索框",
  reader: "正文 <article>",
};

/** 错误信息的首个非空行，去掉终端颜色码。 */
function errorLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const line = stripVTControlCharacters(text)
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  return line ?? "（无错误信息）";
}

/** 附 `a11y-result`，并写 `e2e/.out/a11y/<name>.json`（内容相同）。 */
async function recordA11yResult(testInfo: TestInfo, result: A11yScanResult): Promise<void> {
  const body = JSON.stringify(result, null, 2);
  await testInfo.attach(A11Y_RESULT_ATTACHMENT, { body, contentType: "application/json" });
  await mkdir(A11Y_DIR, { recursive: true });
  await writeFile(a11yResultFile(result.name), `${body}\n`, "utf8");
}

/** 定位恰好 1 个元素且可见。多于 1 个时不调用 `isVisible`（它是严格模式的）。 */
async function visibleOnce(locator: Locator): Promise<{ count: number; visible: boolean }> {
  const count = await locator.count();
  return { count, visible: count === 1 && (await locator.isVisible()) };
}

// ---------------------------------------------------------------------------
// 第 1 步：前提与冻结（15.1、15.7 (a)）
// ---------------------------------------------------------------------------

function checkPreconditions(page: Page, def: A11yScanDef): void {
  const problems: string[] = [];
  const want = VIEWPORTS.desktop;
  const viewport = page.viewportSize();
  if (viewport === null || viewport.width !== want.width || viewport.height !== want.height) {
    const actual = viewport === null ? "未固定" : `${viewport.width}×${viewport.height}`;
    problems.push(`视口应为桌面 ${want.width}×${want.height}，当前为 ${actual}（15.1）`);
  }
  const seeded = seededTheme(page.context());
  if (themeToSeed(def.theme) === null && seeded !== undefined) {
    problems.push(`默认主题的扫描不得 seedTheme（localStorage 中应没有已存储的主题），本上下文 seed 过 ${seeded}（15.1）`);
  }
  if (page.url() === "about:blank") problems.push("页面尚未导航到被扫视图");
  if (problems.length > 0) throw new Error(problems.join("；"));
}

async function freezeMotion(page: Page): Promise<void> {
  await page.addStyleTag({ content: FREEZE_MOTION_CSS });
  const reduced = await page.evaluate(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  if (!reduced) throw new Error("页面不是 prefers-reduced-motion: reduce（15.7 (a)）");
}

// ---------------------------------------------------------------------------
// 第 2 步：15.7 (b)–(d) 与视图就绪
// ---------------------------------------------------------------------------

/**
 * 当前未满足的扫描条件（立即读取，不等待）；全部满足时为空数组。
 *
 * - (b) 没有 `aria-busy="true"` 的元素，也没有"书籍加载进度"进度条；
 * - (c) 目标弹窗或抽屉恰好 1 个且可见，弹窗与抽屉合计恰好 1 个；书架首屏与阅读器正文为 0 个；
 * - (d) 正文中没有检索跳转高亮（`readerJumpHighlight`）；
 * - 视图本身：主视图的标志（书架检索框 / 正文 `<article>`）恰好 1 个且可见；详情弹窗的章节目录
 *   已载入完；检索抽屉已列出至少 1 条结果（15.1）。
 */
export async function unmetScanConditions(page: Page, def: A11yScanDef): Promise<string[]> {
  const unmet: string[] = [];

  const busy = await page.evaluate(() => document.querySelectorAll('[aria-busy="true"]').length);
  if (busy > 0) unmet.push(`(b) 有 ${busy} 个 aria-busy="true" 的元素`);
  const progress = await readerLoading(page).progress.count();
  if (progress > 0) unmet.push(`(b) "书籍加载进度"进度条仍在`);

  const markers = overlayMarkers(page);
  const counts = await Promise.all(OVERLAY_KEYS.map((key) => markers[key].count()));
  const open = OVERLAY_KEYS.map((key, i) => ({ key, count: counts[i] })).filter((o) => o.count > 0);
  const openText =
    open.length === 0
      ? "都未打开"
      : open.map((o) => (o.count === 1 ? OVERLAY_LABELS[o.key] : `${OVERLAY_LABELS[o.key]} ×${o.count}`)).join("、");
  const target = TARGET_OVERLAY[def.view];
  if (target === null) {
    if (open.length > 0) unmet.push(`(c) 弹窗与抽屉应均已关闭，实际打开：${openText}`);
  } else if (open.length !== 1 || open[0].key !== target || open[0].count !== 1) {
    unmet.push(`(c) 应只打开${OVERLAY_LABELS[target]}，实际：${openText}`);
  } else if (!(await markers[target].isVisible())) {
    unmet.push(`(c) ${OVERLAY_LABELS[target]}已挂载但不可见`);
  }

  const highlights = await readerJumpHighlight(page).count();
  if (highlights > 0) unmet.push(`(d) 正文中有 ${highlights} 个检索高亮`);

  const base = BASE_VIEW[def.view];
  const baseMarker = await visibleOnce(viewMarkers(page)[base]);
  if (!baseMarker.visible) {
    unmet.push(
      `${A11Y_VIEW_LABELS[base]}未就绪：${BASE_VIEW_MARKER_LABELS[base]}` +
        (baseMarker.count === 1 ? "不可见" : `匹配 ${baseMarker.count} 个`),
    );
  }
  if (def.view === "detail" && (await detailModal(page).loading.count()) > 0) {
    unmet.push("详情弹窗的章节目录仍在载入");
  }
  if (def.view === "search" && (await searchDrawer(page).results.count()) === 0) {
    unmet.push("检索抽屉尚未列出结果（15.1）");
  }

  return unmet;
}

async function waitForScanReady(page: Page, def: A11yScanDef): Promise<void> {
  let unmet: string[] = ["尚未检查"];
  try {
    await expect
      .poll(
        async () => {
          try {
            unmet = await unmetScanConditions(page, def);
          } catch (error) {
            unmet = [`检查条件时出错：${errorLine(error)}`];
          }
          return unmet;
        },
        { timeout: TIMEOUTS.wait, message: `${def.name} 的 15.7 扫描条件` },
      )
      .toEqual([]);
  } catch {
    // expect.poll 的报错只有最后一次读数的差异；这里改写为逐条列出未满足的条件
    throw new Error(`${TIMEOUTS.wait} ms 内未满足：${unmet.join("；")}`);
  }

  const seed = themeToSeed(def.theme);
  // 15.2：对比度扫描前 data-theme 等于该主题键（color-scheme 一并核对，6.12）
  if (seed !== null) await assertTheme(page, seed);
}

// ---------------------------------------------------------------------------
// 第 3 步：axe
// ---------------------------------------------------------------------------

async function analyze(page: Page, def: A11yScanDef) {
  const builder = new AxeBuilder({ page });
  if (def.rules === COLOR_CONTRAST_RULE) {
    builder.withRules([COLOR_CONTRAST_RULE]);
  } else {
    builder.withTags([...A11Y_TAGS]);
  }
  const results = await builder.analyze();
  if (
    results === null ||
    typeof results !== "object" ||
    !Array.isArray(results.violations) ||
    !Array.isArray(results.incomplete) ||
    typeof results.testEngine?.version !== "string"
  ) {
    throw new Error("axe 未返回结果");
  }
  return results;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * 对当前页面执行 `def` 的扫描（见模块说明的四步），返回 `status: "ok"` 的结果。
 * 只能在用例体中调用（经 `test.info()` 附附件）。第 1–3 步失败时附 `failed` 结果后重抛。
 */
export async function runA11yScan(page: Page, def: A11yScanDef): Promise<A11yScanResult> {
  const testInfo = test.info();
  return step(`A11y_Scan ${def.name}`, async () => {
    let phase: string = A11Y_SCAN_PHASES.precondition;
    let results: Awaited<ReturnType<typeof analyze>>;
    try {
      checkPreconditions(page, def);
      phase = A11Y_SCAN_PHASES.freeze;
      await step("冻结动画与过渡（15.7 (a)）", () => freezeMotion(page));
      phase = A11Y_SCAN_PHASES.wait;
      await step("等待 15.7 (b)–(d) 条件", () => waitForScanReady(page, def));
      phase = A11Y_SCAN_PHASES.axe;
      const ruleText = def.rules === COLOR_CONTRAST_RULE ? `仅 ${COLOR_CONTRAST_RULE}` : A11Y_TAGS.join("、");
      results = await step(`运行 axe（${ruleText}，整页）`, () => analyze(page, def));
    } catch (error) {
      const reason = `${phase}：${errorLine(error)}`;
      try {
        await recordA11yResult(testInfo, a11yResultWithoutAxe(def, "failed", reason));
      } catch (recordError) {
        // 仍重抛原错误；记录失败的原因接在其信息末尾（另起一行，不改首行）
        if (error instanceof Error) error.message += `\n（记录扫描结果失败：${errorLine(recordError)}）`;
      }
      throw error;
    }

    const result: A11yScanResult = {
      name: def.name,
      view: def.view,
      theme: def.theme,
      status: "ok",
      ...summarizeAxe(results),
    };
    await recordA11yResult(testInfo, result);
    return result;
  });
}

/**
 * 16.4：目标元素已渲染（截图或 trace 的 DOM 快照确认），但按 role、`aria-label` 或可见文本都
 * 定位不到时，在 Findings_Log 记可测性缺口 Finding 后调用。附 `{ status: "skipped" }` 结果并写
 * 结果文件，然后以 `[16.4 F-xxx] <说明>` 跳过当前用例（不返回）。只能在用例体中调用。
 */
export async function skipA11yScan(def: A11yScanDef, findingId: string, detail: string): Promise<never> {
  if (!/^F-\d{3,}$/.test(findingId)) {
    throw new Error(`Finding 编号应形如 F-001，实际为 ${JSON.stringify(findingId)}`);
  }
  const reason = `[16.4 ${findingId}] ${detail}`;
  const testInfo = test.info();
  await recordA11yResult(testInfo, a11yResultWithoutAxe(def, "skipped", reason));
  testInfo.skip(true, reason);
  throw new Error(`应已跳过：${reason}`);
}

/**
 * 在 `test.afterEach` 中调用：本用例没有附 `a11y-result`（在 `runA11yScan` 之前就失败、超时或被
 * 跳过）时补记一条，使 reporter 把它写成"扫描失败"（15.9）或"跳过"，而不是"未执行"。
 *
 * - 跳过：`skipped`，reason 取 skip 注解的说明（如 `[3.9] …`）。
 * - 失败或超时：`failed`，reason 为"扫描前失败：<错误首行>"或"用例超时（N ms）"。
 * - 通过却没有附件：说明用例没有调用 `runA11yScan`，抛错使用例失败。
 */
export async function ensureA11yResult(testInfo: TestInfo, def: A11yScanDef): Promise<void> {
  if (testInfo.attachments.some((a) => a.name === A11Y_RESULT_ATTACHMENT)) return;
  if (testInfo.status === "skipped") {
    const reason = testInfo.annotations.find((a) => a.type === "skip" && a.description)?.description ?? "跳过";
    await recordA11yResult(testInfo, a11yResultWithoutAxe(def, "skipped", reason));
    return;
  }
  if (testInfo.status === "passed") {
    throw new Error(`${def.name} 的用例通过了，却没有附 ${A11Y_RESULT_ATTACHMENT}：用例应调用 runA11yScan`);
  }
  const reason =
    testInfo.status === "timedOut"
      ? `用例超时（${testInfo.timeout} ms），扫描未完成`
      : `扫描前失败：${errorLine(testInfo.error?.message ?? testInfo.status ?? "未知")}`;
  await recordA11yResult(testInfo, a11yResultWithoutAxe(def, "failed", reason));
}
