/**
 * 书架"最近阅读"（需求 7.13、7.14；Review_Shot RS-06）。`fixture` 项目，桌面视口，默认主题（不 seedTheme）。
 *
 * - 7.13：首次导航前写入 6 条有效的阅读进度（`roles.json` 的 `recent` 6 本书；上次阅读时间依次为
 *   T0 − 30 s、− 5 min、− 24 h、− 48 h、− 72 h、− 240 h；章节取各书 `_toc.json` 中互不相同的正文章节）。
 *   书架在 Controlled_Clock 暂停于 T0 时加载完成后，"最近阅读"按时间倒序列出前 5 本，逐行核对书名、
 *   作者、章节名与相对时间（"刚刚""5 分钟前""昨天""前天""3 天前"），T0 − 240 h 那本不出现；随后拍
 *   RS-06 `recent-reads`。
 * - 7.14：4 种状态各一个用例，断言页面中没有"最近阅读"标题：(a) 没有进度记录；(b) 进度记录全部指向
 *   books.json 中不存在的书；(c) 检索框的值经 250 ms 防抖后非空；(d) 作者筛选生效。(c)(d) 沿用 7.13
 *   的 6 条种子，并先核对动作前区块可见，使"不渲染"确由该状态引起；(b) 的记录与 7.13 只差书 id。
 *
 * 时间（6.4、6.5）：相对时间由 `formatRelativeTime` 在渲染时以 `Date.now()` 计算，所以书架加载时页面
 * 时钟必须恰为 T0。做法是首次导航前 `clock.install()`（起点 `CLOCK_T0`）后立即
 * `page.clock.pauseAt(CLOCK_T0)`：
 * - 此时页面仍在 about:blank，那里的时钟读数恰为 T0，且直接执行的 install 不启动实时同步，读数不会
 *   随真实时间走动，所以 pauseAt 不前跳，也不会报"跳向过去"；
 * - 首次导航后，新文档按日志重放 install(T0) → pauseAt(T0)，pauseAt 把时间直接设为 T0 并保持暂停。
 * 于是从书架开始加载到拍摄为止 `Date.now()` 一直等于 T0（加载后核对）。暂停期间 setTimeout / rAF
 * 不触发；书架加载只依赖 fetch 与 React 调度（MessageChannel，不受时钟控制），不受影响。(c) 的防抖以
 * `page.clock.runFor(250)` 推进。(a)(b)(d) 不涉及时间，不装时钟。
 *
 * 期望值一律取自运行时的 `books.json`、`_toc.json` 与 `roles.json`（4.4）。
 */
import type { Page } from "@playwright/test";
import type { ReadingProgress } from "../../../src/types";
import { PAGE_SIZE } from "../../../src/utils/pagination";
import { SHOT_TESTS } from "../../review/catalog";
import {
  PROGRESS_KEY_PREFIX,
  expect,
  seedProgress,
  test,
  type ClockControl,
  type Lib,
} from "../../support/fixtures";
import { recentEntryName, recentReads, shelf } from "../../support/locators";
import { CLOCK_T0 } from "../../support/settings";
import { step } from "../../support/step";

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;

/** 7.13 的 6 条记录距 T0 的时长，按上次阅读时间从近到远；第 i 条写给 `roles.json` 的 `recent[i]`。 */
const AGES_MS = [30 * SECOND_MS, 5 * MINUTE_MS, 24 * HOUR_MS, 48 * HOUR_MS, 72 * HOUR_MS, 240 * HOUR_MS] as const;

/** 前 5 条在 T0 的相对时间（7.13），第 6 条（T0 − 240 h）不出现。 */
const RELATIVE_TIMES = ["刚刚", "5 分钟前", "昨天", "前天", "3 天前"] as const;

/** "最近阅读"列出的行数（7.13 的 5 行）。 */
const SHOWN = RELATIVE_TIMES.length;

/** 书架检索的防抖窗口（需求 7.14 (c) 的 250 ms）。 */
const DEBOUNCE_MS = 250;

/** `CLOCK_T0` 的毫秒时间戳。 */
const T0_MS = new Date(CLOCK_T0).getTime();

/** 一条种子进度及其期望显示的内容。 */
interface SeededRead {
  bookId: string;
  /** `books.json` 中该书的书名与作者（进度记录里没有这两个字段）。 */
  title: string;
  author: string;
  chapterId: number;
  /** 记录中的章节名（`_toc.json` 中该章的标题）。 */
  chapterTitle: string;
  lastReadTime: number;
}

/**
 * 7.13 的 6 条种子：`roles.json` 的 `recent` 6 本书按顺序配 `AGES_MS`；第 i 本记第 i 个正文章节
 * （不足时取最后一个），使各行的章节名确实来自各自的记录。
 */
async function recentSeeds(lib: Lib): Promise<SeededRead[]> {
  const ids = lib.fixtureRoles().recent;
  if (ids.length !== AGES_MS.length || new Set(ids).size !== ids.length) {
    throw new Error(`roles.json 的 recent 应为 ${AGES_MS.length} 本不同的书，实际为 ${JSON.stringify(ids)}`);
  }
  const seeds = await Promise.all(
    ids.map(async (bookId, i): Promise<SeededRead> => {
      const [book, facts] = await Promise.all([lib.book(bookId), lib.tocFacts(bookId)]);
      if (facts.bodyCount === 0) throw new Error(`${bookId} 的 _toc.json 没有正文章节`);
      const chapterId = facts.bodyIndices[Math.min(i, facts.bodyCount - 1)];
      const chapterTitle = facts.titles[chapterId];
      if (chapterTitle.trim() === "") throw new Error(`${bookId} 第 ${chapterId} 个节点的标题为空`);
      return {
        bookId,
        title: book.title,
        author: book.author,
        chapterId,
        chapterTitle,
        lastReadTime: T0_MS - AGES_MS[i],
      };
    }),
  );
  // 前置：书名互不相同，按行核对时不会把一行认成另一行
  expect(new Set(seeds.map((s) => s.title)).size, "recent 6 本书的书名应互不相同").toBe(seeds.length);
  return seeds;
}

/** 种子对应的 v2 进度记录（`src/types.ts` 的 `ReadingProgress`）。 */
function toRecord(seed: SeededRead, bookId = seed.bookId): ReadingProgress {
  return {
    bookId,
    chapterId: seed.chapterId,
    chapterTitle: seed.chapterTitle,
    charOffset: 0,
    progressPercent: 0,
    lastReadTime: seed.lastReadTime,
    v: 2,
  };
}

/** 首次导航前安装 Controlled_Clock（起点 T0）并暂停于 T0（原理见文件头）。 */
async function pauseAtT0(page: Page, clock: ClockControl): Promise<void> {
  await step("安装 Controlled_Clock 并暂停于 T0", async () => {
    await clock.install();
    await page.clock.pauseAt(CLOCK_T0);
  });
}

/** 打开书架，等首批书卡挂载（"最近阅读"与书卡在同一次提交中渲染）。 */
async function openShelf(page: Page, lib: Lib): Promise<void> {
  const catalog = await lib.books();
  await step("打开书架，等首批书卡挂载", async () => {
    await page.goto("/");
    await expect(shelf(page).cardTitles).toHaveCount(Math.min(PAGE_SIZE, catalog.books.length));
  });
}

/** 当前页面 localStorage 中阅读进度键对应的书 id，升序（只读）。 */
function progressBookIds(page: Page): Promise<string[]> {
  return page.evaluate((prefix) => {
    const ids: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key?.startsWith(prefix)) ids.push(key.slice(prefix.length));
    }
    return ids.sort();
  }, PROGRESS_KEY_PREFIX);
}

/** 前置：书架已显示"最近阅读"，恰有 5 行（用于 7.14 (c)(d) 动作之前）。 */
async function expectRecentShown(page: Page): Promise<void> {
  const recent = recentReads(page);
  await step(`“最近阅读”显示中，列出 ${SHOWN} 行`, async () => {
    await expect(recent.heading).toBeVisible();
    await expect(recent.entries).toHaveCount(SHOWN);
  });
}

/** 7.14：页面中不存在"最近阅读"标题。 */
async function expectRecentAbsent(page: Page): Promise<void> {
  await step("页面中没有“最近阅读”标题", async () => {
    await expect(recentReads(page).heading).toHaveCount(0);
    await expect(recentReads(page).region).toHaveCount(0);
  });
}

// ---------------------------------------------------------------------------
// 7.13：6 条进度 → 5 行与相对时间（RS-06）
// ---------------------------------------------------------------------------

test(SHOT_TESTS.shelfRecent.title, async ({ page, lib, clock, shot }) => {
  const seeds = await recentSeeds(lib);
  const recent = recentReads(page);

  // RS-06 为默认主题（localStorage 中没有已存储的主题），不 seedTheme
  await seedProgress(page.context(), seeds.map((s) => toRecord(s)));
  await pauseAtT0(page, clock);
  await openShelf(page, lib);

  await step("书架加载完成时页面时钟停在 T0", async () => {
    expect(await page.evaluate(() => Date.now()), `Date.now() 应等于 ${CLOCK_T0}`).toBe(T0_MS);
    expect((await progressBookIds(page)).length, "localStorage 中应恰有 6 条阅读进度").toBe(AGES_MS.length);
  });

  await step(`“最近阅读”区块显示，恰有 ${SHOWN} 行`, async () => {
    await expect(recent.heading).toBeVisible();
    await expect(recent.region).toBeVisible();
    await expect(recent.entries).toHaveCount(SHOWN);
  });

  for (const [i, seed] of seeds.slice(0, SHOWN).entries()) {
    const when = RELATIVE_TIMES[i];
    await step(`第 ${i + 1} 行：《${seed.title}》${seed.author}，${seed.chapterTitle}，${when}`, async () => {
      const row = recent.entries.nth(i);
      await expect(row).toHaveAccessibleName(recentEntryName(seed.title, seed.chapterTitle));
      await expect(recent.entryText(row, seed.title)).toBeVisible();
      await expect(recent.entryText(row, seed.author)).toBeVisible();
      await expect(recent.entryText(row, seed.chapterTitle)).toBeVisible();
      await expect(recent.entryTime(row)).toHaveText(when);
    });
  }

  const oldest = seeds[SHOWN];
  await step(`T0 − 240 h 的《${oldest.title}》不出现`, async () => {
    await expect(recent.entry(oldest.title)).toHaveCount(0);
  });

  await shot("recent-reads");
});

// ---------------------------------------------------------------------------
// 7.14：4 种不渲染"最近阅读"的状态
// ---------------------------------------------------------------------------

test.describe("7.14 不渲染“最近阅读”", () => {
  test("7.14 (a) localStorage 中没有阅读进度记录时不渲染“最近阅读”", async ({ page, lib }) => {
    await openShelf(page, lib);
    await step("localStorage 中没有阅读进度记录", async () => {
      expect(await progressBookIds(page)).toEqual([]);
    });
    await expectRecentAbsent(page);
  });

  test("7.14 (b) 进度记录全部指向 books.json 中不存在的书时不渲染“最近阅读”", async ({ page, lib }) => {
    const seeds = await recentSeeds(lib);
    const catalogIds = new Set((await lib.books()).books.map((b) => b.id));
    // 与 7.13 的记录只差书 id：改成 books.json 里没有的 id
    const records = seeds.map((s) => toRecord(s, `${s.bookId}-已下架`));
    const missing = records.map((r) => r.bookId).sort();
    for (const id of missing) expect(catalogIds.has(id), `${id} 不应在 books.json 中`).toBe(false);

    await seedProgress(page.context(), records);
    await openShelf(page, lib);
    await step(`localStorage 中有 ${records.length} 条阅读进度，全部指向不存在的书`, async () => {
      expect(await progressBookIds(page)).toEqual(missing);
    });
    await expectRecentAbsent(page);
  });

  test("7.14 (c) 检索框的值经 250 ms 防抖后非空时不渲染“最近阅读”", async ({ page, lib, clock }) => {
    const seeds = await recentSeeds(lib);
    const firstBatch = Math.min(PAGE_SIZE, (await lib.books()).books.length);
    const view = shelf(page);
    // 检索词取第 1 行那本书的书名：结果里仍有这本最近读过的书，区块照样应当让位
    const query = seeds[0].title;

    await seedProgress(page.context(), seeds.map((s) => toRecord(s)));
    await pauseAtT0(page, clock);
    await openShelf(page, lib);
    await expectRecentShown(page);

    await step(`在检索框键入「${query}」`, async () => {
      await view.searchBox.fill(query);
      await expect(view.searchBox).toHaveValue(query);
    });

    await step(`推进 ${DEBOUNCE_MS} ms：检索结果替换首批书卡`, async () => {
      await page.clock.runFor(DEBOUNCE_MS);
      // 结果少于首批、且含该书，说明落定的检索词已非空
      await expect
        .poll(() => view.cardTitles.count(), { message: "检索结果应已替换首批书卡" })
        .toBeLessThan(firstBatch);
      await expect(view.cardTitle(query)).toBeVisible();
    });

    await expectRecentAbsent(page);
  });

  test("7.14 (d) 作者筛选生效时不渲染“最近阅读”", async ({ page, lib }) => {
    const seeds = await recentSeeds(lib);
    const { author } = lib.fixtureRoles().sameAuthor;
    const view = shelf(page);

    await seedProgress(page.context(), seeds.map((s) => toRecord(s)));
    await openShelf(page, lib);
    await expectRecentShown(page);

    await step(`点击「${author}」的作者按钮`, async () => {
      await expect(view.searchBox).toHaveValue("");
      await view.authorButton(author).first().click();
      await expect(view.authorFilterStrip(author)).toBeVisible();
    });

    await expectRecentAbsent(page);
  });
});
