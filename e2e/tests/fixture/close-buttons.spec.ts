/**
 * 详情弹窗与三个抽屉的关闭按钮（reader-defect-fixes 需求 11.1、11.2；Findings_Log F-009，已修复
 * （reader-defect-fixes））。`fixture` 项目（:4611，Opaque_Mode），桌面视口（全局默认 1280×800），默认主题
 * （不 `seedTheme`），不装 Controlled_Clock（不涉及时长）。用例标题以 `RDF <需求编号>` 开头（设计 S10）。
 *
 * ## 用书与入口（4.4：期望值运行时推导）
 *
 * 全部用 `lib.role("volumes")`（3.3 (b)，与 A11y_Scan 的 `a11y-detail`、`a11y-toc` 等同一本书）。
 *
 * - 三个抽屉：打开 `/read/<id>?ch=<该书第一个正文章节的下标>`，按 8.1 判定当前章节，再点顶栏"章节目录""全书
 *   内容检索""阅读设置"打开目录 / 检索 / 设置抽屉。
 * - 详情弹窗，深链接：新页面访问 `/?book=<id>`，等弹窗标志、书名与完整章节目录载入。这条历史项不是应用
 *   压入的，关闭时应用以 replace 去掉 `book` 参数（`BookshelfPage` 的 `closeToc`）。11.1 与 11.2 各用一次。
 * - 详情弹窗，书卡：打开 `/`，点该书书卡的"章节目录"（push 一条 `?book=<id>`），关闭时应用走后退。只用于
 *   11.2。该书须在首批书卡内（前提；不成立是测试自身的问题，16.6）。
 *
 * 所选的书与入口记在注解 `close-plan` 里。
 *
 * ## 各条的做法
 *
 * - 打开后先核对前提：四个打开标志（`overlayMarkers`）中只有目标弹窗 / 抽屉的计数为 1，其余为 0。
 * - 11.1：按名称精确匹配（`exact: true`）的按钮恰有 1 个、可见，可访问名称等于该名称、`title` 同文（设计
 *   第 10 节）；另按"名称含该串"（区分大小写的子串，`buttonsNameContaining`）计数也为 1，即页面上没有别的
 *   按钮的名称包含它。
 * - 11.2：点击该按钮（不加 `force`，Playwright 照常做可见、稳定、可点、不被遮挡的检查），四个打开标志的计数
 *   都变为 0、关闭按钮不在页面上，所在视图仍在（阅读器的 `<article>` / 书架的检索框）。详情弹窗另轮询 URL：
 *   路径仍为 `/`，不含 `book` 查询参数。
 */
import type { Page } from "@playwright/test";
import { PAGE_SIZE } from "../../../src/utils/pagination";
import { expect, test, type BookLog, type Lib } from "../../support/fixtures";
import {
  CLOSE_BUTTON_NAMES,
  buttonsNameContaining,
  detailModal,
  overlayCloseButtons,
  overlayMarkers,
  reader,
  settingsDrawer,
  shelf,
  viewMarkers,
  type OverlayKey,
} from "../../support/locators";
import {
  bookUnderTest,
  expectCurrentChapter,
  openReader,
  openSearchDrawer,
  openTocDrawer,
} from "../../support/reader";
import { step } from "../../support/step";

/** 详情弹窗的查询参数名（需求 11.2 写明的 `book`）。 */
const BOOK_PARAM = "book";

/** 报告用的弹窗 / 抽屉名称。 */
const OVERLAY_LABELS: Readonly<Record<OverlayKey, string>> = {
  detailModal: "书籍详情弹窗",
  tocDrawer: "目录抽屉",
  searchDrawer: "检索抽屉",
  settingsDrawer: "设置抽屉",
};

/** 4 个打开标志的键，按 `overlayMarkers` 的顺序。 */
const OVERLAY_KEYS = Object.keys(CLOSE_BUTTON_NAMES) as OverlayKey[];

interface CaseFixtures {
  page: Page;
  lib: Lib;
  bookLog: BookLog;
}

/** 一种打开方式：打开哪个弹窗 / 抽屉、经什么入口、关闭后应留在哪个视图。 */
interface OpenCase {
  key: OverlayKey;
  /** 标题中的写法，如"目录抽屉"、"书籍详情弹窗（深链接 /?book=<id> 打开）"。 */
  label: string;
  /** 关闭后应仍在的主视图（`viewMarkers` 的键）。 */
  view: "reader" | "shelf";
  open: (fx: CaseFixtures) => Promise<void>;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

function notePlan(description: string): void {
  test.info().annotations.push({ type: "close-plan", description });
}

/** 打开 volumes 书的第一个正文章节，按 8.1 判定当前章节。 */
async function openVolumesReader({ page, lib, bookLog }: CaseFixtures): Promise<void> {
  const book = await bookUnderTest(lib, lib.role("volumes"));
  const chapter = book.facts.bodyIndices[0];
  if (chapter === undefined) throw new Error(`${book.id} 没有正文章节（3.3 (b)）`);
  notePlan(`书 ${book.id}，阅读器下标 ${chapter}「${book.facts.titles[chapter]}」`);
  await openReader(page, bookLog, book, chapter);
  await expectCurrentChapter(page, book.facts, chapter);
}

/** 点顶栏"阅读设置 (快捷键: S)"打开设置抽屉，等抽屉标题出现。 */
async function openSettingsDrawer(page: Page): Promise<void> {
  await step("点击顶栏“阅读设置”打开设置抽屉", async () => {
    await reader(page).settingsButton.click();
    await expect(settingsDrawer(page).marker).toBeVisible();
  });
}

/** 当前 URL 中 `book` 查询参数的全部取值（没有时为空数组）。读 `page.url()`，不经页面脚本。 */
function bookParams(page: Page): string[] {
  return new URL(page.url()).searchParams.getAll(BOOK_PARAM);
}

/** 以书名为二级标题的详情弹窗已显示，完整章节目录已载入（网格挂载了章节单元）。 */
async function expectDetailLoaded(page: Page, title: string): Promise<void> {
  const modal = detailModal(page);
  await expect(modal.marker).toBeVisible();
  await expect(modal.heading(title)).toBeVisible();
  await expect(modal.loading).toHaveCount(0);
  await expect(modal.chapterRows.first()).toBeVisible();
}

/** 新页面访问 `/?book=<volumes 书>`。 */
async function openDetailByDeepLink({ page, lib }: CaseFixtures): Promise<void> {
  const book = await lib.book(lib.role("volumes"));
  const url = `/?${new URLSearchParams({ [BOOK_PARAM]: book.id }).toString()}`;
  notePlan(`书 ${book.id}《${book.title}》，深链接 ${decodeURIComponent(url)}`);
  await step(`打开 ${decodeURIComponent(url)}，等《${book.title}》的详情弹窗载入完整章节目录`, async () => {
    await page.goto(url);
    await expectDetailLoaded(page, book.title);
    expect(bookParams(page), "URL 的 book 参数").toEqual([book.id]);
  });
}

/** 打开书架，点 volumes 书书卡上的"章节目录"。 */
async function openDetailFromCard({ page, lib }: CaseFixtures): Promise<void> {
  const id = lib.role("volumes");
  const catalog = await lib.books();
  const index = catalog.books.findIndex((b) => b.id === id);
  const book = await step(`前提：${id} 在 books.json 的前 ${PAGE_SIZE} 本内（首批书卡）`, () => {
    expect(index, `${id} 在 books.json 中的下标`).toBeGreaterThanOrEqual(0);
    expect(index, `${id} 在 books.json 中的下标`).toBeLessThan(PAGE_SIZE);
    return catalog.books[index];
  });
  notePlan(`书 ${id}《${book.title}》，书架第 ${index + 1} 张书卡的“章节目录”`);
  const view = shelf(page);
  await step("打开书架，等首批书卡挂载、骨架移除", async () => {
    await page.goto("/");
    await expect(view.cardTitles.first()).toBeVisible();
    await expect(view.skeleton).toHaveCount(0);
    await expect(view.card(index).title, `第 ${index + 1} 张书卡的书名`).toHaveText(book.title);
    expect(bookParams(page), "打开前 URL 不含 book 参数").toEqual([]);
  });
  await step(`点击《${book.title}》书卡上的“章节目录”，等详情弹窗载入完整章节目录`, async () => {
    await view.card(index).tocButton.click();
    await expect.poll(() => bookParams(page), { message: "URL 的 book 参数应为该书 id" }).toEqual([id]);
    await expectDetailLoaded(page, book.title);
  });
}

const DRAWER_CASES: readonly OpenCase[] = [
  {
    key: "tocDrawer",
    label: OVERLAY_LABELS.tocDrawer,
    view: "reader",
    open: async (fx) => {
      await openVolumesReader(fx);
      await openTocDrawer(fx.page);
    },
  },
  {
    key: "searchDrawer",
    label: OVERLAY_LABELS.searchDrawer,
    view: "reader",
    open: async (fx) => {
      await openVolumesReader(fx);
      await openSearchDrawer(fx.page);
    },
  },
  {
    key: "settingsDrawer",
    label: OVERLAY_LABELS.settingsDrawer,
    view: "reader",
    open: async (fx) => {
      await openVolumesReader(fx);
      await openSettingsDrawer(fx.page);
    },
  },
];

const DETAIL_DEEP_LINK: OpenCase = {
  key: "detailModal",
  label: `${OVERLAY_LABELS.detailModal}（深链接 /?book=<id> 打开）`,
  view: "shelf",
  open: openDetailByDeepLink,
};

const DETAIL_FROM_CARD: OpenCase = {
  key: "detailModal",
  label: `${OVERLAY_LABELS.detailModal}（点书卡“章节目录”打开）`,
  view: "shelf",
  open: openDetailFromCard,
};

/** 11.1 的 4 例：每个弹窗 / 抽屉一种入口。 */
const NAME_CASES: readonly OpenCase[] = [...DRAWER_CASES, DETAIL_DEEP_LINK];

/** 11.2 的 5 例：详情弹窗的两种入口关闭时分别走 replace 与后退。 */
const CLOSE_CASES: readonly OpenCase[] = [...DRAWER_CASES, DETAIL_DEEP_LINK, DETAIL_FROM_CARD];

// ---------------------------------------------------------------------------
// 断言
// ---------------------------------------------------------------------------

/** 前提：四个打开标志中只有 `key` 的计数为 1，其余为 0。 */
async function expectOnlyOpen(page: Page, key: OverlayKey): Promise<void> {
  await step(`前提：只打开了${OVERLAY_LABELS[key]}（四个打开标志中只有它的计数为 1）`, async () => {
    const markers = overlayMarkers(page);
    for (const k of OVERLAY_KEYS) {
      await expect(markers[k], `${OVERLAY_LABELS[k]}的打开标志`).toHaveCount(k === key ? 1 : 0);
    }
  });
}

test.describe("RDF 11.1 关闭按钮的可访问名称", () => {
  for (const c of NAME_CASES) {
    const name = CLOSE_BUTTON_NAMES[c.key];
    test(`RDF 11.1 ${c.label}：打开时名称为“${name}”的按钮恰有 1 个（精确匹配与名称含该串的匹配各计 1 个），可访问名称即“${name}”`, async ({
      page,
      lib,
      bookLog,
    }) => {
      await c.open({ page, lib, bookLog });
      await expectOnlyOpen(page, c.key);

      const closeButton = overlayCloseButtons(page)[c.key];
      await step(`RDF 11.1 名称精确为“${name}”的按钮恰有 1 个且可见，可访问名称为“${name}”，title 同文`, async () => {
        await expect(closeButton, `名称为“${name}”的按钮（精确匹配）`).toHaveCount(1);
        await expect(closeButton).toBeVisible();
        await expect(closeButton).toHaveAccessibleName(name);
        await expect(closeButton, "title 与名称同文（设计第 10 节）").toHaveAttribute("title", name);
      });
      await step(`RDF 11.1 名称中含“${name}”的按钮也恰有 1 个（没有别的按钮的名称包含它）`, async () => {
        await expect(buttonsNameContaining(page, name), `名称中含“${name}”的按钮`).toHaveCount(1);
      });
    });
  }
});

test.describe("RDF 11.2 点击关闭按钮", () => {
  for (const c of CLOSE_CASES) {
    const name = CLOSE_BUTTON_NAMES[c.key];
    const urlClause = c.key === "detailModal" ? `，URL 不含 ${BOOK_PARAM} 查询参数` : "";
    test(`RDF 11.2 ${c.label}：点击“${name}”按钮后${OVERLAY_LABELS[c.key]}关闭${urlClause}`, async ({
      page,
      lib,
      bookLog,
    }) => {
      await c.open({ page, lib, bookLog });
      await expectOnlyOpen(page, c.key);

      const closeButton = overlayCloseButtons(page)[c.key];
      await step(`RDF 11.2 点击“${name}”按钮（不加 force）`, async () => {
        await closeButton.click();
      });
      await step(`RDF 11.2 ${OVERLAY_LABELS[c.key]}已关闭：四个打开标志与“${name}”按钮都不在页面上，所在视图仍在`, async () => {
        const markers = overlayMarkers(page);
        for (const k of OVERLAY_KEYS) {
          await expect(markers[k], `${OVERLAY_LABELS[k]}的打开标志`).toHaveCount(0);
        }
        await expect(closeButton, `“${name}”按钮`).toHaveCount(0);
        await expect(viewMarkers(page)[c.view], c.view === "reader" ? "阅读器正文" : "书架检索框").toBeVisible();
      });
      if (c.key === "detailModal") {
        await step(`RDF 11.2 关闭详情弹窗后 URL 的路径为 /，不含 ${BOOK_PARAM} 查询参数`, async () => {
          await expect
            .poll(() => bookParams(page), { message: `URL 不应含 ${BOOK_PARAM} 查询参数（需求 11.2）` })
            .toEqual([]);
          expect(new URL(page.url()).pathname, "URL 的路径").toBe("/");
        });
      }
    });
  }
});
