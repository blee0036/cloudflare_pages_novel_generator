/**
 * real 专用的 Review_Shot 与需求 7.4 的 real 半句（任务 13.1；需求 7.4、13.2）。`real` 项目（:4621，
 * Opaque_Mode，真实书库 `public/`），默认桌面视口；RS-02、RS-19 所在的 describe 以
 * `test.use({ viewport: VIEWPORTS.mobile })` 切到移动视口。
 *
 * | 用例（标题取自 `SHOT_TESTS`） | 拍摄 |
 * | --- | --- |
 * | `realShelfHome` | RS-01 `bookshelf-home` |
 * | `realShelfMobile`（移动） | RS-02 `bookshelf-mobile` |
 * | `realSearchPinyin`（兼 7.4 的 real 半句） | RS-04 `search-pinyin` |
 * | `realAuthorFilter` | RS-05 `author-filter` |
 * | `realDetailModal` | RS-07 `detail-modal` |
 * | `realReaderTheme[key]` × 5 | RS-13 `reader-theme-<key>` |
 * | `realCacheUsage` | RS-16 `cache-usage` |
 * | `realMobileToc`（移动） | RS-19 `reader-mobile-toc` |
 *
 * ## 用书
 *
 * 每张截图的书 id 取自其 Review_Catalog 条目（`resolveShotBook(reviewShot(name), null)`，real 下即
 * 测试用书表），与 `shot()` 核对页面 URL 时的解析相同；RS-16 先打开的《第七天》取
 * `testBookFor("fallback")`。这里不经 `lib.role()`：它在该书不具备需求 4.7 的特征时跳过用例，而
 * 4.7 只让"依赖该书用途所需特征"的用例跳过，本文件的截图都不依赖那些特征（RS-13 只要一本书的
 * 正文，RS-16 只要任意两本书进入缓存，RS-19 只要正文与目录抽屉）。实测《三国配角演义》不具备
 * "全部节点标题为 ※※※"，经 `lib.role("stars")` 取书会让 RS-16 以 `[4.7]` 跳过、`cache-usage`
 * 未拍摄。书名、作者与作品数一律取自运行时的 `books.json`（4.4）。
 *
 * ## 主题
 *
 * RS-13 的 5 张在首次导航前 `seedTheme(key)`（含 `default`）；其余条目为默认主题（`THEME_UNSET`，
 * localStorage 中没有已存储的主题），不 `seedTheme`。`shot()` 在拍摄前断言 `data-theme`。
 *
 * ## 时间
 *
 * 只有 7.4 的用例在首次导航前安装 Controlled_Clock（6.4）：书架加载完成后暂停，键入 `clks`，再经
 * `page.clock.runFor` 推进 250 ms（防抖窗口）。其余用例不涉及时间，不装时钟；等待只依据
 * `[book-load]` 行、IndexedDB 记录与 DOM 状态。
 *
 * ## 拍摄前的状态核对
 *
 * 每个用例在拍摄前断言画面处于条目 `state` 所写的状态（首批书卡已挂载、筛选状态条在视口内、弹窗
 * 标题与章节网格、抽屉已打开、"已缓存"已有读数等），不断言验收准则本身（由视觉评审判定）。
 */
import type { Page } from "@playwright/test";
import type { BooksCatalog } from "../../../src/types";
import { isFilterableAuthor } from "../../../src/utils/bookSearch";
import { PAGE_SIZE } from "../../../src/utils/pagination";
import { SHOT_TESTS, resolveShotBook, reviewShot, type ReviewShotName } from "../../review/catalog";
import { openBook } from "../../support/cache";
import { expect, test, type IdbProbe } from "../../support/fixtures";
import { testBookFor, type BookRole } from "../../support/library";
import { detailModal, overlayMarkers, reader, settingsDrawer, shelf } from "../../support/locators";
import {
  bookUnderTest,
  expectCurrentChapter,
  openReader,
  openTocDrawer,
  readDetailGrid,
  readDocumentScroll,
  readMainScroll,
  readTocList,
  setDocumentScrollTop,
} from "../../support/reader";
import { TIMEOUTS, VIEWPORTS } from "../../support/settings";
import { step } from "../../support/step";
import { THEME_KEYS } from "../../support/theme";

// ---------------------------------------------------------------------------
// 需求中的字面值
// ---------------------------------------------------------------------------

/** 7.4 real 半句的检索串。 */
const REAL_PINYIN_QUERY = "clks";

/** 书架检索的防抖窗口（需求 7.3、7.4：推进 250 ms）。 */
const DEBOUNCE_MS = 250;

/**
 * 书架加载完成后暂停 Controlled_Clock 时向前跳的余量（与 `shelf-search-filter.spec.ts` 相同）：
 * `pauseAt` 只能跳向将来，此时尚无按键，跳过的这段时间里没有与断言相关的计时器。
 */
const PAUSE_LEAD_MS = 1_000;

// ---------------------------------------------------------------------------
// 用书
// ---------------------------------------------------------------------------

/** Review_Catalog 条目 `name` 的书 id（real 下取测试用书表，不做 4.7 核对；见文件头"用书"）。 */
function shotBookId(name: ReviewShotName): string {
  const id = resolveShotBook(reviewShot(name), null);
  if (id === null) throw new Error(`Review_Catalog 的 ${name} 在 real 下解析不出书 id`);
  return id;
}

/** 测试用书表中承担 `role` 的书 id（不做 4.7 核对）。 */
function testBookId(role: BookRole): string {
  const def = testBookFor(role);
  if (def === undefined) throw new Error(`测试用书表中没有承担 ${role} 用途的书`);
  return def.id;
}

// ---------------------------------------------------------------------------
// 书架
// ---------------------------------------------------------------------------

/** `books.json` 的前 `PAGE_SIZE` 本书名，按原顺序（首批书卡）。 */
function firstBatchTitles(catalog: BooksCatalog): string[] {
  return catalog.books.slice(0, PAGE_SIZE).map((b) => b.title);
}

/** 打开书架，等 `books.json` 加载完成、首批书卡按原顺序挂载。 */
async function openShelf(page: Page, catalog: BooksCatalog): Promise<void> {
  await step(`打开书架，等首批 ${Math.min(PAGE_SIZE, catalog.books.length)} 张书卡挂载`, async () => {
    await page.goto("/");
    await expect(shelf(page).cardTitles).toHaveText(firstBatchTitles(catalog));
  });
}

/** 书架首屏：骨架已消失，检索框可见且为空，没有作者筛选。 */
async function expectShelfHome(page: Page): Promise<void> {
  await step("书架首屏：骨架已消失，检索框为空，无作者筛选", async () => {
    const view = shelf(page);
    await expect(view.skeleton).toHaveCount(0);
    await expect(view.searchBox).toBeVisible();
    await expect(view.searchBox).toHaveValue("");
    await expect(view.authorFilterBar).toHaveCount(0);
  });
}

/** 暂停 Controlled_Clock，此后时间只经 `page.clock.runFor` 推进。 */
async function pauseClock(page: Page): Promise<void> {
  await step("暂停 Controlled_Clock", async () => {
    const now = await page.evaluate(() => Date.now());
    await page.clock.pauseAt(now + PAUSE_LEAD_MS);
  });
}

/**
 * RS-05 的作者：首批书卡中在 `books.json` 里作品数最多的一位，并列时取首批中最先出现的。只考虑
 * 书卡上渲染了作者按钮的作者（`isFilterableAuthor`：`佚名` 与空值按纯文本渲染，点不了）。
 */
function pickAuthor(catalog: BooksCatalog): { author: string; count: number } {
  const counts = new Map<string, number>();
  for (const b of catalog.books) counts.set(b.author, (counts.get(b.author) ?? 0) + 1);
  let best: { author: string; count: number } | null = null;
  for (const b of catalog.books.slice(0, PAGE_SIZE)) {
    if (!isFilterableAuthor(b.author)) continue;
    const count = counts.get(b.author) ?? 0;
    if (best === null || count > best.count) best = { author: b.author, count };
  }
  if (best === null) throw new Error("首批书卡中没有可筛选的作者（全部为佚名或空）");
  return best;
}

/** 元素的边界框完整位于视口内（不依赖 rAF，可与 Controlled_Clock 同用）。 */
function fullyInViewport(page: Page, box: { y: number; height: number } | null): boolean {
  const viewport = page.viewportSize();
  if (box === null || viewport === null) return false;
  return box.y >= 0 && box.y + box.height <= viewport.height;
}

// ---------------------------------------------------------------------------
// 阅读器
// ---------------------------------------------------------------------------

/** 离线缓存（IndexedDB books store）的键集合，按 `idb.keys()` 的排序规则。 */
async function expectCacheKeys(idb: IdbProbe, ids: readonly string[], why: string): Promise<void> {
  await expect
    .poll(() => idb.keys(), { message: `IndexedDB books store 的键集合（${why}）`, timeout: TIMEOUTS.wait })
    .toEqual([...ids].sort());
}

/** 目录、检索、设置三个抽屉均未打开。 */
async function expectDrawersClosed(page: Page): Promise<void> {
  const markers = overlayMarkers(page);
  await expect(markers.tocDrawer, "目录抽屉应关闭").toHaveCount(0);
  await expect(markers.searchDrawer, "检索抽屉应关闭").toHaveCount(0);
  await expect(markers.settingsDrawer, "设置抽屉应关闭").toHaveCount(0);
}

// ---------------------------------------------------------------------------
// RS-01、RS-02：书架首屏
// ---------------------------------------------------------------------------

test.describe("书架首屏", () => {
  test(SHOT_TESTS.realShelfHome.title, async ({ page, lib, shot }) => {
    const catalog = await lib.books();
    await openShelf(page, catalog);
    await expectShelfHome(page);
    await shot("bookshelf-home");
  });

  test.describe("移动视口", () => {
    test.use({ viewport: VIEWPORTS.mobile });

    test(SHOT_TESTS.realShelfMobile.title, async ({ page, lib, shot }) => {
      const catalog = await lib.books();
      await openShelf(page, catalog);
      await expectShelfHome(page);
      await shot("bookshelf-mobile");
    });
  });
});

// ---------------------------------------------------------------------------
// 7.4 real 半句与 RS-04、RS-05、RS-07：检索、作者筛选与详情弹窗
// ---------------------------------------------------------------------------

test.describe("书架检索、作者筛选与详情弹窗", () => {
  test(SHOT_TESTS.realSearchPinyin.title, async ({ page, lib, clock, shot }) => {
    const catalog = await lib.books();
    const id = shotBookId("search-pinyin");
    const book = await lib.book(id);
    const view = shelf(page);

    await step(`用例前提：书名《${book.title}》在 books.json 中唯一，书卡按书名即对应到 ${id}`, () => {
      const sameTitle = catalog.books.filter((b) => b.title === book.title).map((b) => b.id);
      expect(sameTitle, `books.json 中书名为《${book.title}》的书`).toEqual([id]);
    });

    await clock.install();
    await openShelf(page, catalog);
    await pauseClock(page);

    await step(`在空检索框中键入 ${REAL_PINYIN_QUERY}`, async () => {
      await expect(view.searchBox).toHaveValue("");
      await view.searchBox.focus();
      await page.keyboard.type(REAL_PINYIN_QUERY);
      await expect(view.searchBox).toHaveValue(REAL_PINYIN_QUERY);
    });

    await step(`7.4 推进 ${DEBOUNCE_MS} ms：首批书卡（至多 ${PAGE_SIZE} 张）中有《${book.title}》（${id}）`, async () => {
      await page.clock.runFor(DEBOUNCE_MS);
      await expect(view.cardTitle(book.title), `首批书卡应含《${book.title}》（7.4）`).toBeVisible();
      expect(await view.cardTitles.count(), `首批书卡数应不超过 ${PAGE_SIZE}`).toBeLessThanOrEqual(PAGE_SIZE);
      await expect(view.searchBox).toHaveValue(REAL_PINYIN_QUERY);
    });

    await step(`RS-04 画面：《${book.title}》的书卡书名在视口内`, async () => {
      const box = await view.cardTitle(book.title).boundingBox();
      expect(fullyInViewport(page, box), `《${book.title}》的书名应完整位于视口内（${JSON.stringify(box)}）`).toBe(true);
    });

    await shot("search-pinyin");
  });

  test(SHOT_TESTS.realAuthorFilter.title, async ({ page, lib, shot }) => {
    const catalog = await lib.books();
    const { author, count } = pickAuthor(catalog);
    const shown = Math.min(count, PAGE_SIZE);
    const view = shelf(page);
    test.info().annotations.push({
      type: "author-filter",
      description: `首批书卡中作品数最多的可筛选作者：「${author}」，books.json 中 ${count} 本`,
    });

    await openShelf(page, catalog);
    await expectShelfHome(page);

    await step(`点击「${author}」的作者按钮`, async () => {
      await view.authorButton(author).first().click();
    });

    await step(`筛选状态条显示「${author}」与“清除筛选”，书卡为该作者的 ${shown} 本`, async () => {
      await expect(view.authorFilterStrip(author)).toBeVisible();
      await expect(view.clearFilterButton).toBeVisible();
      await expect(view.cardTitles).toHaveCount(shown);
      await expect(view.authorButton(author)).toHaveCount(shown);
    });

    await step("滚回页顶、指针移出书卡：筛选状态条在视口内", async () => {
      // 点击作者按钮时页面已滚到那张书卡处；状态条在书卡网格之上
      await setDocumentScrollTop(page, 0);
      // 筛选后书卡换了位置，指针仍停在点击处，会让其下的书卡呈悬停样式（阴影、书名放大）；
      // 移到视口左上角（顶栏空白处，没有悬停样式）
      await page.mouse.move(0, 0);
      await expect(view.authorFilterStrip(author)).toBeInViewport();
    });

    await shot("author-filter");
  });

  test(SHOT_TESTS.realDetailModal.title, async ({ page, lib, shot }) => {
    const catalog = await lib.books();
    const id = shotBookId("detail-modal");
    const book = await lib.book(id);
    const link = `/?${new URLSearchParams({ book: id }).toString()}`;
    const modal = detailModal(page);

    await step(`在新页面访问 /?book=${id}`, async () => {
      await page.goto(link);
    });

    await step("books.json 加载完成：首批书卡已挂载", async () => {
      await expect(shelf(page).cardTitles).toHaveText(firstBatchTitles(catalog));
    });

    await step(`书架之上显示《${book.title}》的详情弹窗，章节网格载入完成`, async () => {
      await expect(modal.marker).toBeVisible();
      await expect(modal.heading(book.title)).toBeVisible();
      await expect(modal.chapterRows.first()).toBeVisible();
      await expect(modal.loading).toHaveCount(0);
      const grid = await readDetailGrid(page);
      expect(grid.cells.length, "章节网格应已挂载单元").toBeGreaterThan(0);
    });

    await shot("detail-modal");
  });
});

// ---------------------------------------------------------------------------
// RS-13：《1852铁血中华》正文，5 个主题
// ---------------------------------------------------------------------------

test.describe("阅读器正文的 5 个主题", () => {
  for (const key of THEME_KEYS) {
    test(SHOT_TESTS.realReaderTheme[key].title, async ({ page, lib, bookLog, seedTheme, shot }) => {
      const name = `reader-theme-${key}` as const;
      await seedTheme(key);
      const book = await bookUnderTest(lib, shotBookId(name));
      const first = book.facts.bodyIndices[0];

      await openReader(page, bookLog, book);
      await expectCurrentChapter(page, book.facts, first);

      await step("停在该章章首，三个抽屉均关闭", async () => {
        await expectDrawersClosed(page);
        const [main, doc] = await Promise.all([readMainScroll(page), readDocumentScroll(page)]);
        expect(main.scrollTop, "<main> 的 scrollTop").toBe(0);
        expect(doc.scrollTop, "文档的 scrollTop").toBe(0);
        await expect(reader(page).topBar).toBeInViewport();
      });

      await shot(name);
    });
  }
});

// ---------------------------------------------------------------------------
// RS-16：打开 2 本书后设置抽屉的缓存占用
// ---------------------------------------------------------------------------

test.describe("设置抽屉的缓存占用", () => {
  test(SHOT_TESTS.realCacheUsage.title, async ({ page, lib, bookLog, idb, shot }) => {
    const firstBook = await bookUnderTest(lib, testBookId("fallback"));
    const secondBook = await bookUnderTest(lib, shotBookId("cache-usage"));
    const drawer = settingsDrawer(page);

    await openBook(page, bookLog, firstBook);
    await step(`IndexedDB 出现 ${firstBook.id} 的记录`, async () => {
      await expectCacheKeys(idb, [firstBook.id], `打开 ${firstBook.id} 后`);
    });

    await openBook(page, bookLog, secondBook);
    await step(`IndexedDB 恰有 ${firstBook.id} 与 ${secondBook.id} 两条记录`, async () => {
      await expectCacheKeys(idb, [firstBook.id, secondBook.id], `再打开 ${secondBook.id} 后`);
    });

    await step("点击顶栏“阅读设置”打开设置抽屉", async () => {
      await reader(page).settingsButton.click();
      await expect(drawer.marker).toBeVisible();
    });

    await step("“已缓存”由“统计中…”变为读数，与上限滑杆一起在视口内", async () => {
      await expect(drawer.cacheUsage, "“已缓存”一行应显示“N 本 · 大小”的读数").toHaveText(/^\d+ 本 · .+$/);
      await drawer.cacheUsage.scrollIntoViewIfNeeded();
      await expect(drawer.cacheUsage).toBeInViewport();
      await expect(drawer.cacheMaxBooksSlider).toBeInViewport();
      test.info().annotations.push({
        type: "cache-usage",
        description: `“已缓存”读数「${((await drawer.cacheUsage.textContent()) ?? "").trim()}」`,
      });
    });

    await shot("cache-usage");
  });
});

// ---------------------------------------------------------------------------
// RS-19：移动视口，阅读器正文与打开的目录抽屉
// ---------------------------------------------------------------------------

test.describe("移动视口：阅读器目录抽屉", () => {
  test.use({ viewport: VIEWPORTS.mobile });

  test(SHOT_TESTS.realMobileToc.title, async ({ page, lib, bookLog, shot }) => {
    const book = await bookUnderTest(lib, shotBookId("reader-mobile-toc"));

    await openReader(page, bookLog, book);
    await expectCurrentChapter(page, book.facts, book.facts.bodyIndices[0]);
    await openTocDrawer(page);

    await step("目录列表已挂载，且已挂载行集合连续 2 个动画帧不变", async () => {
      const list = await readTocList(page);
      expect(list.rows.length, "目录列表应至少挂载 1 行").toBeGreaterThan(0);
    });

    await shot("reader-mobile-toc");
  });
});
