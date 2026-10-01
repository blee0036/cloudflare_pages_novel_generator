/**
 * 无障碍冒烟（A11y_Scan；需求 15.1、15.2、15.8、15.9、16.4；设计"无障碍冒烟（需求 15）"；任务 20.4）。
 * `fixture` 项目（:4611，Opaque_Mode），桌面视口（全局默认 1280×800），不装 Controlled_Clock。
 *
 * ## 用例
 *
 * `A11Y_SCANS`（`e2e/a11y/scans.ts`）每项一个用例，各自新上下文（6.1）。标题由 `a11yTestTitle`
 * 生成，形如 `15.1 a11y-toc：目录抽屉 · 默认主题（未存储，实际 sepia）`、
 * `15.2 a11y-contrast-dark：阅读器正文 · dark（暗色夜间）· 仅 color-contrast`，节名部分取自
 * `describeA11yScan`。reporter（20.5）按 `a11y-result` 附件里的扫描名归节，不解析标题；没有附件的
 * 用例按与 `a11yTestTitle` 相等的标题找回。
 *
 * 每个用例：
 *
 * 1. 主题：`themeToSeed(def.theme)` 不为 null（15.2 的对比度扫描）时首次导航前 `seedTheme`；
 *    15.1 的 6 个视图是"默认主题"（`THEME_UNSET`，localStorage 中没有已存储的主题），不 seed，
 *    `runA11yScan` 据 `seededTheme(context)` 核对。
 * 2. 进入视图：按 `resolveA11yUrl(def, id)` 导航（书为 `lib.role("volumes")`，3.3 (b)；书架首屏
 *    不涉及某本书）。
 *    - 书架首屏：等首批书卡挂载、骨架移除。
 *    - 详情弹窗：等弹窗标志与该书书名、完整章节目录载入完、网格挂载章节单元。
 *    - 阅读器正文及三个抽屉：等本次导航的 `[book-load]` 行，再按 8.1 断言当前章节为下标 0
 *      （设计表格"下标 0"；15.2 的 5 次对比度扫描因此是同一章）。然后：目录抽屉点顶栏"章节目录"；
 *      检索抽屉先核对 `volumesKeyword` 在该书全文中命中 ≥ 1 次，点顶栏"全书内容检索"、等检索框
 *      自动获得焦点后输入它，等结果列出（15.1）；设置抽屉点顶栏"阅读设置"，等缓存占用统计完成
 *      （抽屉只在打开时统计一次，之后不再变化）。
 * 3. `runA11yScan(page, def)`：冻结动画、等 15.7 的条件、按规则集运行 axe、附 `a11y-result` 并写
 *    `e2e/.out/a11y/<name>.json`（`e2e/a11y/scan.ts`）。
 *
 * ## 判定（15.8、15.9、16.4）
 *
 * - 违规与 incomplete 从不断言：扫描成功时用例的结果只由第 2 步的断言决定。
 * - `runA11yScan` 内的失败（前提不符、注入或执行失败、无结果、15.7 条件超时、主题断言不成立）
 *   由它先附 `{ status: "failed" }` 再重抛。第 2 步就失败或超时的用例没有附件，`test.afterEach`
 *   调用 `ensureA11yResult` 补记 `failed`（被跳过的补记 `skipped`），reporter 因此不会把它写成
 *   "未执行"或违规数 0。
 * - 16.4：目标元素已渲染却按 role、`aria-label` 与可见文本都定位不到时，先在 Findings_Log 记
 *   可测性缺口，再在 `TESTABILITY_GAPS` 登记该扫描与 Finding 编号，用例在进入视图之前以
 *   `skipA11yScan` 跳过（`[16.4 F-xxx]`）。目前 11 个扫描依赖的元素（书架检索框、详情弹窗的
 *   "章节目录 · 全本精校"、正文 `<article>`、三个抽屉的页签或标题、顶栏三个按钮、检索框与结果）
 *   都能定位，表为空。F-003（行高与版心宽度滑杆没有可访问名称）不影响定位：扫描不操作滑杆，
 *   它由 axe 在 `a11y-settings` 里作为违规报出。
 */
import type { Page } from "@playwright/test";
import { ensureA11yResult, runA11yScan, skipA11yScan } from "../../a11y/scan";
import {
  A11Y_SCANS,
  a11yTestTitle,
  resolveA11yUrl,
  type A11yScanDef,
  type A11yScanName,
} from "../../a11y/scans";
import { expect, test, type BookLog, type Lib } from "../../support/fixtures";
import { detailModal, reader, searchDrawer, settingsDrawer, shelf } from "../../support/locators";
import {
  bookText,
  bookUnderTest,
  expectCurrentChapter,
  findOccurrences,
  openSearchDrawer,
  openTocDrawer,
  type BookUnderTest,
} from "../../support/reader";
import { step } from "../../support/step";
import { themeToSeed } from "../../support/theme";

/** 阅读器相关视图停在的节点下标（设计表格"`/read/<id>`，下标 0"）。 */
const READER_CHAPTER_INDEX = 0;

/**
 * 16.4 的可测性缺口：扫描名 → 记入 Findings_Log 的 Finding 编号与说明。登记的扫描在进入视图前
 * 以 `[16.4 F-xxx] <说明>` 跳过。目前为空（见文件头"判定"）。
 */
const TESTABILITY_GAPS: Partial<Record<A11yScanName, { finding: string; detail: string }>> = {};

interface ScanFixtures {
  page: Page;
  lib: Lib;
  bookLog: BookLog;
}

// ---------------------------------------------------------------------------
// 进入视图（第 2 步）
// ---------------------------------------------------------------------------

/** 书架首屏：首批书卡挂载、骨架移除。 */
async function openShelfHome(page: Page, url: string): Promise<void> {
  await step(`打开书架 ${url}，等首批书卡挂载、骨架移除`, async () => {
    await page.goto(encodeURI(url));
    const view = shelf(page);
    await expect(view.cardTitles.first()).toBeVisible();
    await expect(view.skeleton).toHaveCount(0);
  });
}

/** 详情弹窗：弹窗标志与书名可见，完整章节目录已载入，网格已挂载章节单元。 */
async function openDetailModal(page: Page, lib: Lib, bookId: string, url: string): Promise<void> {
  const { title } = await lib.book(bookId);
  await step(`打开 ${url}，等《${title}》的详情弹窗载入完整章节目录`, async () => {
    await page.goto(encodeURI(url));
    const modal = detailModal(page);
    await expect(modal.marker).toBeVisible();
    await expect(modal.heading(title)).toBeVisible();
    await expect(modal.loading).toHaveCount(0);
    await expect(modal.chapterRows.first()).toBeVisible();
  });
}

/** 阅读器正文：等本次导航的 `[book-load]` 行，当前章节为下标 0（8.1）。 */
async function openReaderView(page: Page, bookLog: BookLog, book: BookUnderTest, url: string): Promise<void> {
  await step(`打开 ${url}，等正文加载完成`, async () => {
    const since = bookLog.count;
    await page.goto(encodeURI(url));
    await bookLog.waitFor(book.id, undefined, { since, timeout: book.loadTimeout });
  });
  await expectCurrentChapter(page, book.facts, READER_CHAPTER_INDEX);
}

/** 检索抽屉：输入 `volumesKeyword` 并列出结果（15.1）。 */
async function searchVolumesKeyword(page: Page, keyword: string): Promise<void> {
  await openSearchDrawer(page);
  await step(`等检索框自动获得焦点后输入「${keyword}」，等结果列出`, async () => {
    const drawer = searchDrawer(page);
    // 抽屉打开 150 ms 后自动聚焦检索框；先等它发生，之后不再有焦点变化
    await expect(drawer.input).toBeFocused();
    await drawer.input.fill(keyword);
    await expect(drawer.results.first()).toBeVisible();
    await expect(drawer.resultCount).toBeVisible();
  });
}

/** 设置抽屉：点顶栏"阅读设置"，等缓存占用统计完成。 */
async function openSettingsDrawer(page: Page): Promise<void> {
  await step("点击顶栏“阅读设置”打开设置抽屉，等缓存占用统计完成", async () => {
    await reader(page).settingsButton.click();
    const drawer = settingsDrawer(page);
    await expect(drawer.marker).toBeVisible();
    await expect(drawer.cacheUsage).toHaveText(/^\d+ 本 · .+$/);
  });
}

async function enterView(def: A11yScanDef, { page, lib, bookLog }: ScanFixtures): Promise<void> {
  if (def.book === null) {
    await openShelfHome(page, resolveA11yUrl(def, null));
    return;
  }
  const bookId = lib.role(def.book);
  const url = resolveA11yUrl(def, bookId);
  if (def.view === "detail") {
    await openDetailModal(page, lib, bookId, url);
    return;
  }

  const book = await bookUnderTest(lib, bookId);
  // 检索词先在测试进程中核对，不符即失败，不必打开页面
  const keyword = def.view === "search" ? lib.fixtureRoles().volumesKeyword : null;
  if (keyword !== null) {
    await step(`核对 volumesKeyword「${keyword}」在 ${bookId} 全文中至少命中 1 次（15.1）`, async () => {
      const { count } = findOccurrences(await bookText(lib, bookId), keyword);
      expect(count, `「${keyword}」在 ${bookId} 全文中的命中次数`).toBeGreaterThan(0);
    });
  }

  await openReaderView(page, bookLog, book, url);
  switch (def.view) {
    case "reader":
      return;
    case "toc":
      await openTocDrawer(page);
      return;
    case "search":
      if (keyword === null) throw new Error(`${def.name}：检索视图缺少检索词`);
      await searchVolumesKeyword(page, keyword);
      return;
    case "settings":
      await openSettingsDrawer(page);
      return;
    case "shelf":
      throw new Error(`${def.name}：书架首屏不涉及某本书，book 应为 null`);
  }
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

/** 标题 → 扫描定义，供 `afterEach` 找回当前用例的扫描。 */
const SCAN_BY_TITLE = new Map<string, A11yScanDef>();

for (const def of A11Y_SCANS) {
  const title = a11yTestTitle(def);
  if (SCAN_BY_TITLE.has(title)) throw new Error(`A11y_Scan 用例标题重复：${title}`);
  SCAN_BY_TITLE.set(title, def);

  test(title, async ({ page, lib, bookLog, seedTheme }) => {
    const gap = TESTABILITY_GAPS[def.name];
    if (gap !== undefined) await skipA11yScan(def, gap.finding, gap.detail);

    const seed = themeToSeed(def.theme);
    if (seed !== null) {
      await step(`首次导航前把已存储主题写为 ${seed}（15.2）`, () => seedTheme(seed));
    }
    await enterView(def, { page, lib, bookLog });
    // 15.8：违规与 incomplete 不断言；runA11yScan 只在扫描本身失败时抛错（15.9）
    await runA11yScan(page, def);
  });
}

// 15.9：在 runA11yScan 之前就失败、超时或被跳过的用例补记结果
test.afterEach(async ({}, testInfo) => {
  const def = SCAN_BY_TITLE.get(testInfo.title);
  if (def === undefined) throw new Error(`找不到用例「${testInfo.title}」对应的 A11y_Scan 定义`);
  await ensureA11yResult(testInfo, def);
});
