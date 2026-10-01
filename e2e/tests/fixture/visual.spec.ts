/**
 * 像素视觉回归（Visual_Regression_Check；需求 6.12、12.1、12.2、12.3、12.5、12.6、12.9、12.10；
 * 设计"像素视觉回归"）。`fixture` 项目（:4611，Opaque_Mode）；real 各项目不收集本文件，也就不读写
 * `e2e/baselines/`（12.1）。
 *
 * ## 用例
 *
 * 基线的定义全部在 `e2e/visual/baselines.ts`（名称、视口、主题、书、URL、章节、检索词、状态、
 * `prepare`、遮罩）。这里按视口分两个 `describe`（`test.use({ viewport })`），每个 `BaselineDef`
 * 一个用例，标题形如 `12.2 px-reader-dark：桌面 1280×800，主题 dark`，以 `12.2 <基线名>：` 开头
 * （`naming.ts` 的 `visualTestTitle`）。reporter 的"视觉回归"一节（`visual/report.ts`）与
 * `acceptance.py` 的 `judge_4` / `judge_6` 按文件名 `visual.spec.ts` 识别这些行，前者再以
 * `baselineNameOfTitle` 从标题取回基线名。
 *
 * ## 每个用例的 7 步（设计原文，编号与步骤名一致）
 *
 * 1. `clock.install()`（起点 `CLOCK_T0`，不暂停：`px-search-results` 依赖检索抽屉打开 150 ms 后的
 *    自动聚焦）。`themeToSeed(def.theme)` 不为 null 时 `seedTheme`；`THEME_UNSET`（默认主题：没有
 *    已存储的主题）不 seed，`px-reader-default` 则 seed `default`（`e2e/support/theme.ts`）。
 * 2. 核对定义中的字面量仍与当前 Fixture_Library 一致（12.2）：`lib.role(def.role) === def.bookId`；
 *    有 `chapter` 时 `_toc.json` 该下标的标题等于它，且 URL 不带 `ch` 时它是没有阅读进度时阅读器
 *    停在的节点（第一个非卷节点）；有 `keyword` 时它在该书全文中至少命中 1 次。不符即失败。
 * 3. `def.prepare(page)`。
 * 4. `assertTheme(expectedDataTheme(def.theme))`（6.12）。
 * 5. 核对视口等于 `VIEWPORTS[def.viewport]`（12.9：截图尺寸即视口）；遮罩逐个 `count()`，为 0 即
 *    失败并报基线名（12.10）；遮罩合计面积比超过 `VISUAL.maxMaskRatio` 同样失败（12.3）。
 * 6. `updateSnapshots === "none"` 且基线文件不存在时抛出 `missingBaselineMessage` 的
 *    `缺少 Pixel_Baseline e2e/baselines/<file>；运行 npm run e2e:update`，不调用
 *    `toHaveScreenshot`，因此不会补写（12.6）。基线路径由 `naming.ts` 的 `baselinePath` 给出，并先
 *    核对它与 Playwright 按 `pathTemplate` 解析的路径（`testInfo.snapshotPath`）相同，保证检查的就是
 *    `toHaveScreenshot` 要读的文件。
 * 7. `expect(page).toHaveScreenshot(`${def.name}.png`, { mask })`。容差、`animations`、`caret`、
 *    `scale` 与 `stylePath` 全部来自 `playwright.config.ts`，这里不传（12.4、12.9）。
 *
 * 无论成败，`finally` 中都调用 `def.cleanup?.(page)`（`px-shelf-skeleton` 移除挂起 `books.json`
 * 的路由）。
 *
 * ## headed 下跳过
 *
 * 基线只在 headless 下拍摄与比对（`--hide-scrollbars` 等拍摄设置随之固定，12.9），`--headed`
 * 或调试模式（Playwright 把 `headless` 置为 false）下全部用例以普通原因跳过。这类原因不带约定
 * 前缀，Run_Summary 归入"其他"；验收运行（需求 18）只用 headless，不会出现。
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { baselinesFor, type BaselineDef, type BaselineViewport } from "../../visual/baselines";
import {
  baselinePath,
  maskAreaOverLimit,
  maskAreaRatio,
  missingBaselineMessage,
  visualTestTitle,
  type MaskBox,
} from "../../visual/naming";
import { expect, test, type ClockControl, type Lib } from "../../support/fixtures";
import { VIEWPORTS, VISUAL } from "../../support/settings";
import { step } from "../../support/step";
import { THEME_UNSET, expectedDataTheme, themeToSeed, type DeclaredTheme } from "../../support/theme";
import type { ReaderThemeKey } from "../../../src/types";

/** 仓库根（本文件位于 `e2e/tests/fixture/`）。 */
const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));

const VIEWPORT_LABELS: Readonly<Record<BaselineViewport, string>> = {
  desktop: `桌面 ${VIEWPORTS.desktop.width}×${VIEWPORTS.desktop.height}`,
  mobile: `移动 ${VIEWPORTS.mobile.width}×${VIEWPORTS.mobile.height}`,
};

function themeLabel(theme: DeclaredTheme): string {
  return theme === THEME_UNSET ? "默认主题（未存储）" : `主题 ${theme}`;
}

/** 用例标题：`12.2 <基线名>：<视口>，<主题>`（`visualTestTitle`，reporter 以 `baselineNameOfTitle` 取回基线名）。 */
function titleOf(def: BaselineDef): string {
  return visualTestTitle(def.name, `${VIEWPORT_LABELS[def.viewport]}，${themeLabel(def.theme)}`);
}

/** 路径比较：Windows 上不区分大小写（盘符等）。 */
function samePath(a: string, b: string): boolean {
  const na = path.normalize(a);
  const nb = path.normalize(b);
  return process.platform === "win32" ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

/** 相对 URL 是否带 `ch` 查询参数。 */
function hasChapterParam(url: string): boolean {
  return new URL(url, "http://127.0.0.1").searchParams.has("ch");
}

/** `text` 中 `keyword` 的出现次数（不重叠）。 */
function countOccurrences(text: string, keyword: string): number {
  let count = 0;
  for (let at = text.indexOf(keyword); at !== -1; at = text.indexOf(keyword, at + keyword.length)) count += 1;
  return count;
}

// ---------------------------------------------------------------------------
// 7 步
// ---------------------------------------------------------------------------

interface VisualFixtures {
  page: Page;
  lib: Lib;
  clock: ClockControl;
  seedTheme: (theme: ReaderThemeKey) => Promise<void>;
  assertTheme: (theme: ReaderThemeKey) => Promise<void>;
}

/** 第 1 步：Controlled_Clock 与已存储主题（首次导航之前）。 */
async function installClockAndTheme(def: BaselineDef, { clock, seedTheme }: VisualFixtures): Promise<void> {
  const seed = themeToSeed(def.theme);
  const title =
    seed === null
      ? "1. 安装 Controlled_Clock（CLOCK_T0，不暂停）；默认主题，不写入已存储主题"
      : `1. 安装 Controlled_Clock（CLOCK_T0，不暂停）；首次导航前把已存储主题写为 ${seed}`;
  await step(title, async () => {
    await clock.install();
    if (seed !== null) await seedTheme(seed);
  });
}

/** 第 2 步：定义中的书 id、章节与检索词仍取自当前 Fixture_Library（12.2）。 */
async function checkLiterals(def: BaselineDef, { lib }: VisualFixtures): Promise<void> {
  if (def.role === null) {
    await step("2. 本基线不涉及书库中的某本书（role 为 null），无字面量可核对", () => {
      expect(def.bookId, `${def.name}：role 为 null 时 bookId 也应为 null`).toBeNull();
    });
    return;
  }
  const role = def.role;
  await step(`2. 核对 lib.role("${role}") 等于定义中的书 id ${def.bookId ?? "（null）"}`, () => {
    expect(
      lib.role(role),
      `${def.name}：roles.json 的 ${role} 与 baselines.ts 中的书 id 不符；夹具规格改动后须同步改 baselines.ts`,
    ).toBe(def.bookId);
  });
  const bookId = def.bookId;
  if (bookId === null) return; // 上一步已断言相等，role 非 null 时 bookId 不会为 null

  const chapter = def.chapter;
  if (chapter !== undefined) {
    await step(`2. 核对 _toc.json 下标 ${chapter.index} 的标题为「${chapter.title}」`, async () => {
      const facts = await lib.tocFacts(bookId);
      expect(facts.titles[chapter.index], `${def.name}：${bookId} 的 _toc.json 下标 ${chapter.index} 的标题`).toBe(
        chapter.title,
      );
      if (!hasChapterParam(def.url)) {
        // URL 不带 ?ch= 且没有阅读进度：阅读器停在第一个非卷节点（8.12 同一规则）
        expect(
          chapter.index,
          `${def.name}：URL ${def.url} 不带 ch，没有阅读进度时阅读器停在第一个非卷节点`,
        ).toBe(facts.bodyIndices[0]);
      }
    });
  }

  const keyword = def.keyword;
  if (keyword !== undefined) {
    await step(`2. 核对检索词「${keyword}」在 ${bookId} 全文中至少命中 1 次`, async () => {
      const text = gunzipSync(await readFile(lib.gzPath(bookId))).toString("utf8");
      expect(countOccurrences(text, keyword), `${def.name}：「${keyword}」在 ${bookId} 全文中的命中次数`).toBeGreaterThan(
        0,
      );
    });
  }
}

/** 第 3 步：把页面带到目标状态。 */
async function prepare(def: BaselineDef, { page }: VisualFixtures): Promise<void> {
  await step(`3. 准备画面：${def.state}`, () => def.prepare(page));
}

/** 第 4 步：主题断言（6.12）。 */
async function checkTheme(def: BaselineDef, { assertTheme }: VisualFixtures): Promise<void> {
  const theme = expectedDataTheme(def.theme);
  await step(`4. 断言 <html> 的 data-theme 为 ${theme}，color-scheme 与之一致（6.12）`, () => assertTheme(theme));
}

/** 第 5 步：视口（12.9）与遮罩（12.3、12.10）。返回交给 `toHaveScreenshot` 的遮罩定位。 */
async function checkViewportAndMasks(def: BaselineDef, { page }: VisualFixtures): Promise<Locator[]> {
  const want = VIEWPORTS[def.viewport];
  await step(`5. 核对视口为 ${want.width}×${want.height}（12.9：截图尺寸即视口）`, () => {
    expect(page.viewportSize(), `${def.name}：页面视口`).toEqual({ width: want.width, height: want.height });
  });

  const title =
    def.masks.length === 0
      ? "5. 遮罩清单为空，不加遮罩"
      : `5. 核对 ${def.masks.length} 个遮罩均匹配到元素（12.10），合计面积不超过截图的 ${VISUAL.maxMaskRatio * 100}%（12.3）`;
  return step(title, async () => {
    const locators = def.masks.map((mask) => mask.locate(page));
    const boxes: MaskBox[] = [];
    for (const [i, locator] of locators.entries()) {
      const count = await locator.count();
      if (count === 0) {
        throw new Error(
          `${def.name}：第 ${i + 1} 个遮罩（${def.masks[i].reason}）的定位在拍摄时匹配到 0 个元素，` +
            "不拍摄、不比对（12.10）",
        );
      }
      for (const element of await locator.all()) {
        const box = await element.boundingBox();
        if (box !== null) boxes.push(box);
      }
    }
    const ratio = maskAreaRatio(boxes, want);
    if (maskAreaOverLimit(ratio)) {
      throw new Error(
        `${def.name}：遮罩合计面积为截图面积的 ${(ratio * 100).toFixed(2)}%，` +
          `超过上限 ${VISUAL.maxMaskRatio * 100}%（12.3）`,
      );
    }
    return locators;
  });
}

/** 第 6 步：非更新运行中基线缺失即失败，不调用 `toHaveScreenshot`（12.6）。 */
async function checkBaselinePresent(def: BaselineDef, testInfo: TestInfo): Promise<void> {
  const relative = baselinePath(def.name, process.platform);
  const mode = testInfo.config.updateSnapshots;
  await step(`6. 核对基线文件 ${relative}（updateSnapshots 为 ${mode}）`, () => {
    const file = path.resolve(REPO_ROOT, relative);
    const resolvedByPlaywright = testInfo.snapshotPath(`${def.name}.png`, { kind: "screenshot" });
    if (!samePath(file, resolvedByPlaywright)) {
      throw new Error(
        `${def.name}：naming.ts 给出的基线路径 ${file} 与 Playwright 按 pathTemplate 解析的 ` +
          `${resolvedByPlaywright} 不同；缺失检查与比对须指向同一文件`,
      );
    }
    if (mode === "none" && !existsSync(file)) {
      throw new Error(missingBaselineMessage(relative));
    }
  });
}

/** 第 7 步：与 Pixel_Baseline 比对（容差等设置全部取自配置）。 */
async function compare(def: BaselineDef, { page }: VisualFixtures, mask: Locator[]): Promise<void> {
  await step(`7. toHaveScreenshot("${def.name}.png")${mask.length > 0 ? `，${mask.length} 个遮罩` : ""}`, async () => {
    await expect(page).toHaveScreenshot(`${def.name}.png`, { mask });
  });
}

async function runVisualCheck(def: BaselineDef, fixtures: VisualFixtures, testInfo: TestInfo): Promise<void> {
  await installClockAndTheme(def, fixtures);
  await checkLiterals(def, fixtures);
  try {
    await prepare(def, fixtures);
    await checkTheme(def, fixtures);
    const mask = await checkViewportAndMasks(def, fixtures);
    await checkBaselinePresent(def, testInfo);
    await compare(def, fixtures, mask);
  } finally {
    if (def.cleanup !== undefined) {
      const cleanup = def.cleanup;
      await step("撤销 prepare 的页面设置（cleanup）", () => cleanup(fixtures.page));
    }
  }
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

// 12.9：更新与比对只在 headless 下进行（同一组拍摄设置）
test.skip(({ headless }) => !headless, "headed 模式下不做 Visual_Regression_Check：基线只在 headless 下拍摄与比对（12.9）");

for (const viewport of ["desktop", "mobile"] as const satisfies readonly BaselineViewport[]) {
  test.describe(`12.2 Pixel_Baseline（${VIEWPORT_LABELS[viewport]}）`, () => {
    test.use({ viewport: VIEWPORTS[viewport] });

    for (const def of baselinesFor(viewport)) {
      test(titleOf(def), async ({ page, lib, clock, seedTheme, assertTheme }, testInfo) => {
        await runVisualCheck(def, { page, lib, clock, seedTheme, assertTheme }, testInfo);
      });
    }
  });
}
