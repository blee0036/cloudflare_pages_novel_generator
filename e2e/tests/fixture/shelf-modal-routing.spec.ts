/**
 * 书架详情弹窗与路由（需求 7.9、7.10、7.11、7.12、7.15；Checklist H9）。`fixture` 项目，桌面视口。
 *
 * - 7.9 / 7.10：从书卡的"章节目录"打开弹窗，浏览历史条数加 1，URL 路径为 `/`、查询参数 `book` 解码后
 *   等于该书 id，并显示以书名为 `<h2>` 的详情弹窗；随后浏览器后退，弹窗关闭，URL 等于打开前的 URL
 *   （不含 `book`），检索框的值、作者筛选状态条、"继续加载"按钮与已挂载书卡（书名与顺序）都与打开前
 *   相同。H9 用三种打开前的状态：
 *   (a) 空检索词、首批书卡；
 *   (b) 点过一次"继续加载"，从只在第二批才挂载的第 `PAGE_SIZE + 1` 张书卡打开；
 *   (c) 检索词非空且作者筛选生效（检索词取 3.3 (g) 同作者书书名的首字）。
 * - 7.11：新页面直接访问 `/?book=<id>`，`books.json` 加载完成后（首批书卡已挂载）弹窗显示在书架之上，
 *   URL 保持不变。一次选 `books.json` 的第 1 本（首批内），一次选第 `PAGE_SIZE + 1` 本（不在首批）。
 * - 7.12：先打开 `/`，记下历史条数 L，再访问未定义的路由（`/no-such-page`、`/a/b`）。这次导航本身新增
 *   1 条历史；应用以 replace 跳到 `/`，所以跳转完成后历史条数应为 L + 1（若以 push 跳转则为 L + 2）。
 * - 7.15：同样的做法访问 `/?book=<books.json 中不存在的 id>`：弹窗不出现，URL 被替换为 `/`，
 *   历史条数为 L + 1，书架显示首批书卡。
 *
 * 时间：只有 (c) 涉及 250 ms 检索防抖，在首次导航前安装 Controlled_Clock（6.4），书架加载完成后暂停，
 * 此后只经 `page.clock.runFor` 推进；其余用例不涉及时间，不装时钟。
 *
 * 期望值取自运行时的 `books.json` 与 `roles.json`（4.4）。书卡没有 role 容器，以书名 `<h3>` 计数与
 * 比较顺序（`shelf().cardTitles`），夹具中书名互不相同。历史条数经 `history.length` 读取，只作度量。
 */
import type { Page } from "@playwright/test";
import type { BookSummary, BooksCatalog } from "../../../src/types";
import { PAGE_SIZE } from "../../../src/utils/pagination";
import { expect, test } from "../../support/fixtures";
import { detailModal, shelf } from "../../support/locators";
import { step } from "../../support/step";

/** 弹窗书籍的查询参数名（需求 7.9、7.11、7.15 写明的 `book`）。 */
const BOOK_PARAM = "book";

/** 书架检索的防抖窗口（需求 7.3）。 */
const DEBOUNCE_MS = 250;

/**
 * 书架加载完成后暂停 Controlled_Clock 时向前跳的余量（与 `shelf-search-filter.spec.ts` 相同）：
 * `pauseAt` 只能跳向将来，此时尚无按键，跳过的这段时间里没有与断言相关的计时器。
 */
const PAUSE_LEAD_MS = 1_000;

/** 7.12 验证的未定义路由。 */
const UNDEFINED_ROUTES = ["/no-such-page", "/a/b"] as const;

/** 书卡书名，文档顺序。 */
async function cardTitleTexts(page: Page): Promise<string[]> {
  const texts = await shelf(page).cardTitles.allTextContents();
  return texts.map((t) => t.trim());
}

/** `books.json` 的前 `PAGE_SIZE` 本书名，按原顺序（首批书卡）。 */
function firstBatchTitles(catalog: BooksCatalog): string[] {
  return catalog.books.slice(0, PAGE_SIZE).map((b) => b.title);
}

/** 打开书架，等首批书卡挂载完成（按原顺序为 `books.json` 的前 `min(N, PAGE_SIZE)` 本）。 */
async function openShelf(page: Page, catalog: BooksCatalog): Promise<void> {
  await step("打开书架，等首批书卡挂载", async () => {
    await page.goto("/");
    await expect(shelf(page).cardTitles).toHaveText(firstBatchTitles(catalog));
  });
}

/** 当前会话的浏览历史条数（度量）。 */
function historyLength(page: Page): Promise<number> {
  return page.evaluate(() => window.history.length);
}

/** 当前 URL 中 `book` 查询参数解码后的值；没有时为 null。 */
function bookParam(page: Page): string | null {
  return new URL(page.url()).searchParams.get(BOOK_PARAM);
}

/** `/?book=<id>`（`URLSearchParams` 负责百分号编码）。 */
function deepLink(id: string): string {
  return `/?${new URLSearchParams({ [BOOK_PARAM]: id }).toString()}`;
}

/** `books.json` 中书名为 `title` 的书（夹具中书名唯一）。 */
function bookByTitle(catalog: BooksCatalog, title: string): BookSummary {
  const hits = catalog.books.filter((b) => b.title === title);
  if (hits.length !== 1) {
    throw new Error(`books.json 中书名为《${title}》的书应恰有 1 本，实际 ${hits.length} 本`);
  }
  return hits[0];
}

/** 以该书书名为二级标题的详情弹窗已显示。 */
async function expectModalOpen(page: Page, book: BookSummary): Promise<void> {
  const modal = detailModal(page);
  await expect(modal.marker).toBeVisible();
  await expect(modal.heading(book.title)).toBeVisible();
}

/** 详情弹窗不在页面上（给出 `book` 时另核对其书名 `<h2>` 不在）。 */
async function expectModalClosed(page: Page, book?: BookSummary): Promise<void> {
  const modal = detailModal(page);
  await expect(modal.marker).toHaveCount(0);
  if (book !== undefined) await expect(modal.heading(book.title)).toHaveCount(0);
}

/** H9 比较的书架状态。 */
interface ShelfState {
  url: string;
  search: string;
  /** 作者筛选状态条的个数（0 或 1）。 */
  filterBars: number;
  /** "继续加载"按钮的个数（0 或 1）。 */
  loadMore: number;
  /** 已挂载书卡的书名，文档顺序。 */
  titles: string[];
}

async function readShelfState(page: Page): Promise<ShelfState> {
  const view = shelf(page);
  return {
    url: page.url(),
    search: await view.searchBox.inputValue(),
    filterBars: await view.authorFilterBar.count(),
    loadMore: await view.loadMoreButton.count(),
    titles: await cardTitleTexts(page),
  };
}

async function expectShelfState(page: Page, state: ShelfState): Promise<void> {
  const view = shelf(page);
  await expect(page).toHaveURL(state.url);
  await expect(view.searchBox).toHaveValue(state.search);
  await expect(view.authorFilterBar).toHaveCount(state.filterBars);
  await expect(view.loadMoreButton).toHaveCount(state.loadMore);
  await expect(view.cardTitles).toHaveText(state.titles);
}

/**
 * 7.9 + 7.10：从第 `index` 张书卡（应为 `book`）的"章节目录"打开弹窗，再浏览器后退。
 * 返回打开前的书架状态，调用方可再补充断言。
 */
async function openTocThenGoBack(page: Page, index: number, book: BookSummary): Promise<ShelfState> {
  const view = shelf(page);

  const before = await step("记下打开弹窗前的书架状态与历史条数", async () => {
    await expectModalClosed(page);
    const state = await readShelfState(page);
    expect(state.titles[index], `第 ${index + 1} 张书卡应为《${book.title}》`).toBe(book.title);
    expect(bookParam(page), "打开前 URL 不含 book 参数").toBeNull();
    return { state, history: await historyLength(page) };
  });

  await step(`点击《${book.title}》书卡上的“章节目录”`, async () => {
    await view.card(index).tocButton.click();
  });

  await step("7.9 新增一条历史记录，URL 为 /?book=<id>，显示以书名为二级标题的详情弹窗", async () => {
    await expect
      .poll(() => bookParam(page), { message: "URL 的 book 参数解码后应等于该书 id（7.9）" })
      .toBe(book.id);
    expect(new URL(page.url()).pathname, "URL 路径应为 /（7.9）").toBe("/");
    await expectModalOpen(page, book);
    expect(await historyLength(page), "打开弹窗应新增一条浏览历史记录（7.9）").toBe(before.history + 1);
  });

  await step("浏览器后退", async () => {
    await page.goBack();
  });

  await step("7.10 弹窗关闭；URL、检索框、作者筛选状态条与已挂载书卡均与打开前相同", async () => {
    await expectModalClosed(page, book);
    await expectShelfState(page, before.state);
    expect(bookParam(page), "后退后 URL 不含 book 参数（7.10）").toBeNull();
  });

  return before.state;
}

// ---------------------------------------------------------------------------
// 7.9、7.10：打开弹窗与浏览器后退（H9）
// ---------------------------------------------------------------------------

test.describe("7.9 7.10 详情弹窗与后退（H9）", () => {
  test("7.9 7.10 从首批书卡打开弹窗新增一条历史记录；后退关闭弹窗，URL 与书架回到打开前", async ({
    page,
    lib,
  }) => {
    const catalog = await lib.books();
    const book = catalog.books[0];
    await openShelf(page, catalog);

    const before = await openTocThenGoBack(page, 0, book);

    await step("打开前后都是 / 上的首批书卡，未检索、未筛选", () => {
      expect(new URL(before.url).pathname).toBe("/");
      expect(new URL(before.url).search).toBe("");
      expect(before.search).toBe("");
      expect(before.filterBars).toBe(0);
      expect(before.titles).toEqual(firstBatchTitles(catalog));
    });
  });

  test(`7.10 点击“继续加载”后从第 ${PAGE_SIZE + 1} 张书卡打开弹窗，后退后书卡数与顺序不变`, async ({
    page,
    lib,
  }) => {
    const catalog = await lib.books();
    const total = catalog.books.length;
    expect(total, `fixture 的 books.json 应多于 ${PAGE_SIZE} 本（3.3）`).toBeGreaterThan(PAGE_SIZE);
    const mounted = Math.min(total, 2 * PAGE_SIZE);
    const book = catalog.books[PAGE_SIZE];
    const view = shelf(page);

    await openShelf(page, catalog);

    await step(`点击“继续加载”，挂载数 ${PAGE_SIZE} → ${mounted}`, async () => {
      await view.loadMoreButton.click();
      await expect(view.cardTitles).toHaveText(catalog.books.slice(0, mounted).map((b) => b.title));
    });

    const before = await openTocThenGoBack(page, PAGE_SIZE, book);

    await step(`后退后仍挂载 ${mounted} 张书卡`, () => {
      expect(before.titles).toHaveLength(mounted);
      expect(before.loadMore).toBe(mounted < total ? 1 : 0);
    });
  });

  test("7.10 检索词非空且作者筛选生效时打开弹窗，后退后检索框、筛选状态条与书卡不变", async ({
    page,
    lib,
    clock,
  }) => {
    const catalog = await lib.books();
    const { author } = lib.fixtureRoles().sameAuthor;
    const authorBooks = catalog.books.filter((b) => b.author === author);
    expect(authorBooks.length, `books.json 中「${author}」应至少有 2 本书（3.3 (g)）`).toBeGreaterThanOrEqual(2);
    const query = [...authorBooks[0].title][0];
    const view = shelf(page);

    await clock.install();
    await openShelf(page, catalog);
    await step("暂停 Controlled_Clock", async () => {
      const now = await page.evaluate(() => Date.now());
      await page.clock.pauseAt(now + PAUSE_LEAD_MS);
    });

    await step(`检索「${query}」，推进 ${DEBOUNCE_MS} ms`, async () => {
      await view.searchBox.focus();
      await page.keyboard.type(query);
      await page.clock.runFor(DEBOUNCE_MS);
      await expect
        .poll(() => cardTitleTexts(page), { message: "检索结果应已替换首批书卡" })
        .not.toEqual(firstBatchTitles(catalog));
      await expect(view.authorButton(author).first()).toBeVisible();
    });

    await step(`点击「${author}」的作者按钮`, async () => {
      await view.authorButton(author).first().click();
      await expect(view.authorFilterStrip(author)).toBeVisible();
      await expect(view.cardTitles).toHaveCount(await view.authorButton(author).count());
    });

    const titles = await cardTitleTexts(page);
    expect(titles.length, `检索「${query}」并筛选「${author}」后应至少有 1 张书卡`).toBeGreaterThan(0);
    const book = bookByTitle(catalog, titles[0]);

    const before = await openTocThenGoBack(page, 0, book);

    await step("后退后检索框仍为该检索词，筛选状态条仍为该作者", async () => {
      expect(before.search).toBe(query);
      expect(before.filterBars).toBe(1);
      await expect(view.searchBox).toHaveValue(query);
      await expect(view.authorFilterStrip(author)).toBeVisible();
    });
  });
});

// ---------------------------------------------------------------------------
// 7.11：/?book=<id> 深链接
// ---------------------------------------------------------------------------

const DEEP_LINK_CASES = [
  { label: "books.json 的第 1 本（首批内）", index: 0 },
  { label: `books.json 的第 ${PAGE_SIZE + 1} 本（不在首批）`, index: PAGE_SIZE },
] as const;

test.describe("7.11 深链接", () => {
  for (const { label, index } of DEEP_LINK_CASES) {
    test(`7.11 直接访问 /?book=<id>，id 取${label}：书架加载后显示该书详情弹窗`, async ({ page, lib }) => {
      const catalog = await lib.books();
      expect(catalog.books.length, `books.json 应至少有 ${index + 1} 本`).toBeGreaterThan(index);
      const book = catalog.books[index];
      const link = deepLink(book.id);
      const view = shelf(page);

      await step(`在新页面访问 ${decodeURIComponent(link)}`, async () => {
        await page.goto(link);
      });

      await step("books.json 加载完成：书架首批书卡已挂载", async () => {
        await expect(view.searchBox).toBeVisible();
        await expect(view.cardTitles).toHaveText(firstBatchTitles(catalog));
        if (index >= PAGE_SIZE) {
          expect(await cardTitleTexts(page), `《${book.title}》不应在首批书卡中`).not.toContain(book.title);
        }
      });

      await step(`书架之上显示《${book.title}》的详情弹窗，URL 不变`, async () => {
        await expectModalOpen(page, book);
        expect(new URL(page.url()).pathname).toBe("/");
        expect(bookParam(page), "URL 的 book 参数应保持为该书 id").toBe(book.id);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// 7.12：未定义路由
// ---------------------------------------------------------------------------

test.describe("7.12 未定义路由", () => {
  for (const route of UNDEFINED_ROUTES) {
    test(`7.12 访问 ${route}：以替换方式跳到 / 并显示书架，历史条数不增加`, async ({ page, lib }) => {
      const catalog = await lib.books();

      await openShelf(page, catalog);
      const home = new URL("/", page.url()).href;
      const before = await historyLength(page);

      await step(`访问 ${route}（这次导航本身新增 1 条历史）`, async () => {
        await page.goto(route);
      });

      await step("跳到 / 并显示书架首批书卡", async () => {
        await expect(page).toHaveURL(home);
        await expect(shelf(page).searchBox).toBeVisible();
        await expect(shelf(page).cardTitles).toHaveText(firstBatchTitles(catalog));
      });

      await step("跳转以替换方式进行：历史条数只多出访问本身那 1 条", async () => {
        expect(await historyLength(page), "重定向不应新增浏览历史记录（7.12）").toBe(before + 1);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// 7.15：/?book=<不存在的 id>
// ---------------------------------------------------------------------------

/** 一个 `books.json` 中不存在的 id（含中文，覆盖解码）。 */
function missingBookId(catalog: BooksCatalog): string {
  const ids = new Set(catalog.books.map((b) => b.id));
  let id = "不存在的书-e2e";
  for (let n = 2; ids.has(id); n++) id = `不存在的书-e2e-${n}`;
  return id;
}

test.describe("7.15 不存在的书", () => {
  test("7.15 直接访问 /?book=<不存在的 id>：不显示弹窗，URL 以替换方式改为 /，显示首批书卡", async ({
    page,
    lib,
  }) => {
    const catalog = await lib.books();
    const missing = missingBookId(catalog);
    const link = deepLink(missing);

    await openShelf(page, catalog);
    const home = new URL("/", page.url()).href;
    const before = await historyLength(page);

    await step(`访问 ${decodeURIComponent(link)}（这次导航本身新增 1 条历史）`, async () => {
      await page.goto(link);
    });

    await step("books.json 加载完成后 URL 被改为 /，显示首批书卡", async () => {
      await expect(page).toHaveURL(home);
      await expect(shelf(page).cardTitles).toHaveText(firstBatchTitles(catalog));
    });

    await step("不显示详情弹窗", async () => {
      await expectModalClosed(page);
    });

    await step("URL 以替换方式修改：历史条数只多出访问本身那 1 条", async () => {
      expect(await historyLength(page), "摘掉 book 参数不应新增浏览历史记录（7.15）").toBe(before + 1);
    });
  });
});
