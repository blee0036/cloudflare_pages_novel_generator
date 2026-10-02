/**
 * real：移动视口下《第七天》正文不横向溢出（reader-defect-fixes 需求 10.3；Findings_Log F-008，已修复
 * （reader-defect-fixes））。`real` 项目（:4621，Opaque_Mode，真实书库 `public/`），以
 * `test.use({ viewport: VIEWPORTS.mobile })` 切到移动视口 390×844，默认主题（不 `seedTheme`），不装
 * Controlled_Clock。用例标题以 `RDF <需求编号>` 开头（设计 S10）。
 *
 * ## 用书
 *
 * 书 id `第七天-余华` 是需求 10.3 原文点名的书，也是测试用书表中承担 `fallback` 的 Test_Book：用例先核对它在
 * `TEST_BOOKS` 中，于是它的 `_toc.json` 与 `.txt.gz` 由 globalSetup 的 real 书库核对（EV 4.2）覆盖，缺失时整个
 * real 项目按 `[4.3]` 跳过（与其他 real 用例相同）。这里不经 `lib.role("fallback")`：它在该书不具备 4.7 的特征
 * （`fallback` 为 true）时跳过用例，而 10.3 只要这本书的正文，不依赖那项特征（同 `real-shots.spec.ts`）。
 * "第一个正文章节"取 `_toc.json` 推导的第一个非卷节点（4.4），以 `?ch=<下标>` 打开。
 *
 * ## 做法
 *
 * 打开该章、按 8.1 判定当前章节后等 2 个动画帧，读文档滚动元素（`document.scrollingElement`）与 Body_Scroller
 * （`<main>`）的 `scrollWidth`、`clientWidth`，断言前者均 ≤ 后者。读数记在注解 `layout-reading` 里。
 */
import type { Page } from "@playwright/test";
import { expect, test } from "../../support/fixtures";
import { TEST_BOOKS } from "../../support/library";
import { reader } from "../../support/locators";
import { bookUnderTest, expectCurrentChapter, openReader, waitFrames } from "../../support/reader";
import { VIEWPORTS } from "../../support/settings";
import { step } from "../../support/step";

/** 需求 10.3 点名的书。 */
const SEVENTH_DAY_ID = "第七天-余华";

const MOBILE_LABEL = `移动 ${VIEWPORTS.mobile.width}×${VIEWPORTS.mobile.height}`;

/** 一个元素的横向宽度读数（px）。 */
interface WidthReading {
  scrollWidth: number;
  clientWidth: number;
}

/** 读文档滚动元素与 `<main>` 的 `scrollWidth`、`clientWidth`（只读）。 */
async function readWidths(page: Page): Promise<{ document: WidthReading; main: WidthReading }> {
  const [doc, main] = await Promise.all([
    page.evaluate(() => {
      const el = document.scrollingElement ?? document.documentElement;
      return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
    }),
    reader(page).main.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth })),
  ]);
  return { document: doc, main };
}

test.describe(`RDF 10.3 《第七天》正文不横向溢出（${MOBILE_LABEL}）`, () => {
  test.use({ viewport: VIEWPORTS.mobile });

  test(`RDF 10.3 ${MOBILE_LABEL} 打开《第七天》（${SEVENTH_DAY_ID}）的第一个正文章节：文档滚动元素与 <main> 的 scrollWidth 均 ≤ 各自的 clientWidth`, async ({
    page,
    lib,
    bookLog,
  }) => {
    await step(`用例前提：${SEVENTH_DAY_ID} 是测试用书表中的 Test_Book（其文件由 real 书库核对覆盖）`, () => {
      expect(TEST_BOOKS.map((def) => def.id), "测试用书表").toContain(SEVENTH_DAY_ID);
    });
    const book = await bookUnderTest(lib, SEVENTH_DAY_ID);
    const first = book.facts.bodyIndices[0];
    if (first === undefined) throw new Error(`${SEVENTH_DAY_ID} 没有正文章节`);
    test.info().annotations.push({
      type: "layout-plan",
      description: `书 ${SEVENTH_DAY_ID} 第一个正文章节：下标 ${first}「${book.facts.titles[first]}」`,
    });

    await openReader(page, bookLog, book, first);
    await expectCurrentChapter(page, book.facts, first);

    const widths = await step("等 2 个动画帧后读文档滚动元素与 <main> 的 scrollWidth、clientWidth", async () => {
      await waitFrames(page);
      const read = await readWidths(page);
      test.info().annotations.push({
        type: "layout-reading",
        description:
          `文档滚动元素 scrollWidth ${read.document.scrollWidth}、clientWidth ${read.document.clientWidth}；` +
          `<main> scrollWidth ${read.main.scrollWidth}、clientWidth ${read.main.clientWidth}`,
      });
      return read;
    });

    await step("RDF 10.3 文档滚动元素与 <main> 的 scrollWidth 均 ≤ 各自的 clientWidth", () => {
      expect(widths.document.scrollWidth, "文档滚动元素的 scrollWidth（≤ clientWidth）").toBeLessThanOrEqual(
        widths.document.clientWidth,
      );
      expect(widths.main.scrollWidth, "<main> 的 scrollWidth（≤ clientWidth）").toBeLessThanOrEqual(
        widths.main.clientWidth,
      );
    });
  });
});
