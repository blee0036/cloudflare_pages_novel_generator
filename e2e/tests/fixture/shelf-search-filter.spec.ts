/**
 * 书架检索、作者筛选与分页（需求 7.2–7.8）。`fixture` 项目，桌面视口。
 *
 * - 7.2 / 7.3：从空检索框开始，以 Controlled_Clock 上相隔 `KEY_GAP_MS` 的按键逐字键入 3.3 (f) 那本书的
 *   书名拼音首字母全串（`books.json` 的 `titleAbbr`，与 `roles.json` 的 `pinyin.abbr` 核对一致）。
 *   末次按键后推进 2 帧与 249 ms 各比较一次：检索框的值等于已键入的串，书卡列表仍是 `books.json` 的
 *   前 `BATCH` 本、按原顺序；再推进 1 ms（满 250 ms）后只剩该书一张书卡。
 * - 7.4（大写半句）：同一串的大写形式，推进 250 ms 后同样只剩该书一张书卡。小写串的半句由
 *   `fixture/review-shots.spec.ts` 的 RS-04 覆盖（键入 `roles.json` 的 `pinyin.abbr`）。
 * - 7.5 / 7.6：检索框为空时点击 3.3 (g) 同作者书的作者按钮，只显示该作者的书、数目等于 `books.json`
 *   中该作者的书数，并显示含作者名与"清除筛选"的状态条；点击"清除筛选"后状态条移除，列表恢复为筛选
 *   前的首批（顺序相同），检索框的值不变。另一用例在检索词非空时验证 7.6，检索词取同作者书书名中一个
 *   也出现在别的作者书名里的字，使筛选前后的列表确有不同。
 * - 7.7 / 7.8：空检索词下结果数 N = `books.json` 的书数（> `BATCH`）。首批恰好 `BATCH` 张，"继续加载"
 *   注明还剩 N − `BATCH` 本，计数为"已显示 `BATCH` / N 本"；每点一次挂载数增至 min(N, M + `BATCH`)，
 *   原有 M 张的顺序不变；挂载满 N 时按钮与计数移除。
 *
 * 时间：7.2–7.4 与检索词非空的 7.6 在首次导航前安装 Controlled_Clock（6.4），书架加载完成后暂停，此后
 * 只经 `page.clock.runFor` 推进。"不变"类比较在按键后先推进 2 帧（`CLOCK_STEP_MS` × 2，装了时钟后
 * rAF 也受控）再读，与设计"补充场景的定位与断言"的约定一致。其余用例不涉及时间，不装时钟。
 *
 * 期望值一律取自运行时的 `books.json` 与 `roles.json`（4.4）。书卡没有 role 容器，以书名 `<h3>` 计数
 * 与比较顺序（`locators.ts` 的 `shelf().cardTitles`）；夹具中书名互不相同。
 */
import type { Page } from "@playwright/test";
import type { BookSummary, BooksCatalog } from "../../../src/types";
import { PAGE_SIZE } from "../../../src/utils/pagination";
import { expect, test, type Lib } from "../../support/fixtures";
import { shelf } from "../../support/locators";
import { CLOCK_STEP_MS } from "../../support/settings";
import { step } from "../../support/step";

/**
 * 首批与每批追加的书卡数。需求 7.2、7.7、7.8 写的是 50；书架已改为对齐到网格列数（50 → 48，
 * 见 `src/utils/shelfGrid.ts`），这里直接取应用的 `PAGE_SIZE`，与其他用例一致。
 */
const BATCH = PAGE_SIZE;

/** 书架检索的防抖窗口（需求 7.2、7.3：末次按键后 249 ms 不变、满 250 ms 生效）。 */
const DEBOUNCE_MS = 250;

/** 7.2：相邻按键在 Controlled_Clock 上的间隔（需求上限 100 ms，取上限以验证每次按键都重置防抖）。 */
const KEY_GAP_MS = 100;

/** "不变"类比较前推进的时长：2 个动画帧。 */
const TWO_FRAMES_MS = 2 * CLOCK_STEP_MS;

/**
 * 书架加载完成后暂停 Controlled_Clock 时向前跳的余量。`pauseAt` 只能跳向将来，而安装后时钟随真实时间
 * 走动，读取页面时间到暂停生效之间还会走几毫秒，取 1 s 足够。本用例此时尚无按键，跳过的这段时间里
 * 没有与断言相关的计时器。
 */
const PAUSE_LEAD_MS = 1_000;

/** 书卡书名，文档顺序。 */
async function cardTitleTexts(page: Page): Promise<string[]> {
  const texts = await shelf(page).cardTitles.allTextContents();
  return texts.map((t) => t.trim());
}

/** 打开书架，等首批书卡挂载完成（`min(N, BATCH)` 张）。 */
async function openShelf(page: Page, catalog: BooksCatalog): Promise<void> {
  await step("打开书架，等首批书卡挂载", async () => {
    await page.goto("/");
    await expect(shelf(page).cardTitles).toHaveCount(Math.min(BATCH, catalog.books.length));
  });
}

/** 暂停 Controlled_Clock，此后时间只经 `page.clock.runFor` 推进。 */
async function pauseClock(page: Page): Promise<void> {
  await step("暂停 Controlled_Clock", async () => {
    const now = await page.evaluate(() => Date.now());
    await page.clock.pauseAt(now + PAUSE_LEAD_MS);
  });
}

/** `books.json` 的前 `BATCH` 本书名，按原顺序。 */
function firstBatchTitles(catalog: BooksCatalog): string[] {
  return catalog.books.slice(0, BATCH).map((b) => b.title);
}

/** 3.3 (f) 的拼音书与它的书名拼音首字母全串（取自 `books.json`，与 `roles.json` 核对）。 */
async function pinyinBook(lib: Lib): Promise<{ book: BookSummary; abbr: string }> {
  const role = lib.fixtureRoles().pinyin;
  const book = await lib.book(role.id);
  const abbr = book.titleAbbr ?? "";
  if (abbr === "" || abbr !== role.abbr) {
    throw new Error(
      `roles.json 的 pinyin.abbr（${role.abbr}）应等于 books.json 中 ${role.id} 的 titleAbbr（${abbr || "缺失"}）`,
    );
  }
  return { book, abbr };
}

/** 7.6（检索词非空）的检索词：该作者某本书书名中的一个字，它也出现在其他作者的书名里。 */
function sharedTitleChar(books: readonly BookSummary[], author: string): string {
  const others = books.filter((b) => b.author !== author);
  for (const book of books.filter((b) => b.author === author)) {
    for (const ch of book.title) {
      if (others.some((o) => o.title.includes(ch))) return ch;
    }
  }
  throw new Error(`夹具中找不到一个字，同时出现在「${author}」与其他作者的书名里`);
}

// ---------------------------------------------------------------------------
// 7.2、7.3、7.4：拼音首字母检索与 250 ms 防抖
// ---------------------------------------------------------------------------

test.describe("拼音首字母检索与防抖", () => {
  test("7.2 7.3 逐字键入拼音首字母：末次按键后 249 ms 内列表不变，满 250 ms 只剩该书", async ({
    page,
    lib,
    clock,
  }) => {
    const catalog = await lib.books();
    const { book, abbr } = await pinyinBook(lib);
    const firstBatch = firstBatchTitles(catalog);
    const view = shelf(page);

    await clock.install();
    await openShelf(page, catalog);
    await pauseClock(page);

    await step(`检索框为空，书卡为 books.json 的前 ${BATCH} 本`, async () => {
      await expect(view.searchBox).toHaveValue("");
      expect(await cardTitleTexts(page)).toEqual(firstBatch);
    });

    await step(`逐字键入 ${abbr}（相邻按键间隔 ${KEY_GAP_MS} ms）`, async () => {
      await view.searchBox.focus();
      for (const [i, ch] of [...abbr].entries()) {
        if (i > 0) await page.clock.runFor(KEY_GAP_MS);
        await page.keyboard.type(ch);
        await expect(view.searchBox).toHaveValue(abbr.slice(0, i + 1));
      }
    });

    await step(`末次按键后 ${TWO_FRAMES_MS} ms：检索框为已键入的串，列表仍为前 ${BATCH} 本`, async () => {
      await page.clock.runFor(TWO_FRAMES_MS);
      await expect(view.searchBox).toHaveValue(abbr);
      expect(await cardTitleTexts(page), "防抖期间书卡列表应保持输入前的状态（7.2）").toEqual(firstBatch);
    });

    await step(`末次按键后 ${DEBOUNCE_MS - 1} ms：列表仍为前 ${BATCH} 本`, async () => {
      await page.clock.runFor(DEBOUNCE_MS - 1 - TWO_FRAMES_MS);
      await expect(view.searchBox).toHaveValue(abbr);
      expect(await cardTitleTexts(page), "防抖期间书卡列表应保持输入前的状态（7.2）").toEqual(firstBatch);
    });

    await step(`末次按键后满 ${DEBOUNCE_MS} ms：只显示《${book.title}》一张书卡`, async () => {
      await page.clock.runFor(1);
      await expect(view.cardTitles).toHaveText([book.title]);
      await expect(view.searchBox).toHaveValue(abbr);
    });
  });

  test("7.4 输入大写拼音首字母，250 ms 后与小写结果相同（只剩该书）", async ({ page, lib, clock }) => {
    const catalog = await lib.books();
    const { book, abbr } = await pinyinBook(lib);
    const upper = abbr.toUpperCase();
    expect(upper, "拼音首字母串应含可大写的字母").not.toBe(abbr);
    const view = shelf(page);

    await clock.install();
    await openShelf(page, catalog);
    await pauseClock(page);

    await step(`在空检索框中键入 ${upper}`, async () => {
      await expect(view.searchBox).toHaveValue("");
      await view.searchBox.focus();
      await page.keyboard.type(upper);
      await expect(view.searchBox).toHaveValue(upper);
    });

    await step(`推进 ${DEBOUNCE_MS} ms：只显示《${book.title}》一张书卡`, async () => {
      await page.clock.runFor(DEBOUNCE_MS);
      await expect(view.cardTitles).toHaveText([book.title]);
    });
  });
});

// ---------------------------------------------------------------------------
// 7.5、7.6：作者筛选与清除
// ---------------------------------------------------------------------------

test.describe("作者筛选", () => {
  test("7.5 7.6 检索框为空时点击作者按钮只显示该作者的书；清除筛选后恢复首批", async ({ page, lib }) => {
    const catalog = await lib.books();
    const { author } = lib.fixtureRoles().sameAuthor;
    const authorTitles = catalog.books.filter((b) => b.author === author).map((b) => b.title);
    expect(authorTitles.length, `books.json 中「${author}」应至少有 2 本书（3.3 (g)）`).toBeGreaterThanOrEqual(2);
    const view = shelf(page);

    await openShelf(page, catalog);

    const before = await step("检索框为空，记下筛选前的书卡", async () => {
      await expect(view.searchBox).toHaveValue("");
      await expect(view.authorFilterBar).toHaveCount(0);
      return cardTitleTexts(page);
    });

    await step(`点击「${author}」的作者按钮`, async () => {
      await view.authorButton(author).first().click();
    });

    await step(`只显示「${author}」的 ${authorTitles.length} 本书，并显示筛选状态条`, async () => {
      await expect(view.cardTitles).toHaveCount(authorTitles.length);
      // 每张书卡的作者按钮都以作者名命名：按钮数等于书卡数，即每张卡的作者都是该作者
      await expect(view.authorButton(author)).toHaveCount(authorTitles.length);
      expect((await cardTitleTexts(page)).sort(), "书卡应恰为该作者的全部作品（7.5）").toEqual(
        [...authorTitles].sort(),
      );
      await expect(view.authorFilterStrip(author)).toBeVisible();
      await expect(view.clearFilterButton).toBeVisible();
    });

    await step("点击“清除筛选”：状态条移除，书卡恢复为筛选前的首批，检索框的值不变", async () => {
      await view.clearFilterButton.click();
      await expect(view.authorFilterBar).toHaveCount(0);
      await expect(view.clearFilterButton).toHaveCount(0);
      await expect(view.cardTitles).toHaveText(before);
      await expect(view.searchBox).toHaveValue("");
    });
  });

  test("7.6 检索词非空时清除筛选，恢复该检索词下的首批结果，检索框的值不变", async ({
    page,
    lib,
    clock,
  }) => {
    const catalog = await lib.books();
    const { author } = lib.fixtureRoles().sameAuthor;
    const query = sharedTitleChar(catalog.books, author);
    const firstBatch = firstBatchTitles(catalog);
    const view = shelf(page);

    await clock.install();
    await openShelf(page, catalog);
    await pauseClock(page);

    const before = await step(`检索「${query}」，推进 ${DEBOUNCE_MS} ms 后记下结果`, async () => {
      await view.searchBox.focus();
      await page.keyboard.type(query);
      await page.clock.runFor(DEBOUNCE_MS);
      await expect
        .poll(() => cardTitleTexts(page), { message: "检索结果应已替换首批书卡" })
        .not.toEqual(firstBatch);
      const titles = await cardTitleTexts(page);
      const byAuthor = await view.authorButton(author).count();
      // 前置：结果里既有该作者的书（作者按钮可点），也有别的作者的书（清除筛选前后确有不同）
      expect(byAuthor, `检索「${query}」的结果应含「${author}」的书`).toBeGreaterThan(0);
      expect(titles.length, `检索「${query}」的结果应含其他作者的书`).toBeGreaterThan(byAuthor);
      return titles;
    });

    await step(`点击「${author}」的作者按钮`, async () => {
      await view.authorButton(author).first().click();
      await expect(view.authorFilterStrip(author)).toBeVisible();
      await expect(view.cardTitles).toHaveCount(await view.authorButton(author).count());
      expect((await cardTitleTexts(page)).length).toBeLessThan(before.length);
    });

    await step("点击“清除筛选”：状态条移除，书卡恢复为该检索词下的结果，检索框的值不变", async () => {
      await view.clearFilterButton.click();
      await expect(view.authorFilterBar).toHaveCount(0);
      await expect(view.cardTitles).toHaveText(before);
      await expect(view.searchBox).toHaveValue(query);
    });
  });
});

// ---------------------------------------------------------------------------
// 7.7、7.8：分页与"继续加载"
// ---------------------------------------------------------------------------

test.describe("分页", () => {
  test("7.7 7.8 结果多于一批时首批整批与“继续加载”，点击后追加直至全部挂载", async ({ page, lib }) => {
    const catalog = await lib.books();
    const total = catalog.books.length;
    expect(total, `fixture 的 books.json 应多于 ${BATCH} 本（3.3）`).toBeGreaterThan(BATCH);
    const view = shelf(page);

    await openShelf(page, catalog);

    await step(`首批恰好 ${BATCH} 张，“继续加载”注明还剩 ${total - BATCH} 本，计数为 ${BATCH} / ${total}`, async () => {
      await expect(view.cardTitles).toHaveCount(BATCH);
      await expect(view.loadMoreButton).toHaveText(new RegExp(`^继续加载.*还有 ${total - BATCH} 本`));
      await expect(view.shownCount).toHaveText(`已显示 ${BATCH} / ${total} 本`);
    });

    let mounted = BATCH;
    while (mounted < total) {
      const next = Math.min(total, mounted + BATCH);
      await step(`点击“继续加载”：挂载数 ${mounted} → ${next}，原有 ${mounted} 张顺序不变`, async () => {
        const before = await cardTitleTexts(page);
        await view.loadMoreButton.click();
        await expect(view.cardTitles).toHaveCount(next);
        expect((await cardTitleTexts(page)).slice(0, mounted), "原有书卡的顺序应不变（7.8）").toEqual(before);
        if (next < total) {
          await expect(view.loadMoreButton).toHaveText(new RegExp(`^继续加载.*还有 ${total - next} 本`));
          await expect(view.shownCount).toHaveText(`已显示 ${next} / ${total} 本`);
        }
      });
      mounted = next;
    }

    await step(`挂载满 ${total} 张：“继续加载”与计数移除`, async () => {
      await expect(view.loadMoreButton).toHaveCount(0);
      await expect(view.shownCount).toHaveCount(0);
    });
  });
});
