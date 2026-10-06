/**
 * 阅读器：书签（需求 9.5、9.6、9.7；Review_Shot RS-21）。`fixture` 项目，桌面视口，默认主题（不 seedTheme），
 * Opaque_Mode。
 *
 * ## 用书与章节（4.4：期望值运行时推导）
 *
 * 书为 `lib.role("longText")`（3.3 (h)(i) 的夹具书），书签章节取 `roles.json` 的 `longText.chapterIndex`
 * （长章节，可以滚到章中）。9.6 的"另一章"取书签章节之后的下一个正文章节（没有时取上一个）。
 * k 与 `reader-progress.spec.ts` 同一取法：不超过该章正文段落数一半、且能滚到判定线的最大序号（k ≥ 1）。
 * 所选章节与 k 记在注解 `bookmark-plan` 里，新条目的内容记在 `bookmark-entry` 里。
 *
 * 每个用例都是新的浏览器上下文，localStorage 中没有书签键，即"当前章没有书签"（9.5、9.7 的 WHILE）。
 * 用例开始时经 UI 核对这一前提：顶栏按钮名为"添加书签"，"我的书签"计数为 0、显示"暂无书签"。
 *
 * ## 判定段落
 *
 * 判定段落按需求 9.5 的定义，由 `e2e/support/reader.ts` 的 `readJudgeParagraph` 读取；"滚到第 k 段"对正文
 * 滚动容器 `<main>` 赋值 `scrollTop` 并等到它的 `scroll` 事件（`scrollJudgeParagraphTo`）。滚动之前与书签
 * 跳转后读判定段落之前，都核对文档本身不可滚动（`expectDocumentNotScrollable`，reader-defect-fixes
 * 需求 2.1、14.2）。
 *
 * 应用添加书签时记下的章内偏移取自 `liveCharOffset()`，即 `<main>` 的 `scroll` 事件在 rAF 里算出的待落盘
 * 偏移，没有时退回 `charOffset` state（打开本章时为 0）；预览取该偏移所在段落的前 100 字。书签跳转把偏移
 * 交给 `jumpTo`，偏移为 0 时直接显示章首，否则在测量后赋值 `<main>.scrollTop`。同一场景的断言分在两个用例
 * 中：9.5 的计数、章节名、非空预览与按钮名称切换 / 预览为第 k 段的前缀，9.6 的章节 / 判定段落序号等于 k；
 * 两个用例都执行该条 WHEN 的全部操作。
 *
 * `RDF 3.2`（reader-defect-fixes 需求 3.2 的偏移范围）：同样执行 9.5 的 WHEN，再读书签键中本章的那条记录，
 * 断言其 `charOffset` 不小于第 k 段的章内起点、小于第 k + 1 段的起点。各段起点由测试独立推导
 * （`readParagraphStarts`：测试进程解压的全书文本按行切分，与渲染出的 `<p>` 文本依次对齐），不取自应用。
 *
 * 历史：EV 验收时实际滚动的是文档而不是 `<main>`（Findings_Log F-002，已修复（reader-defect-fixes））：
 * 书签记的是章首，预览为第 0 段，跳回来也是章首，9.5 的"预览为第 k 段的前缀"与 9.6 的"判定段落序号等于 k"
 * 按 16.7 拆成预期失败用例。修复后它们改为普通用例，用例划分与断言保持不变。
 *
 * 9.6 的"在另一章"以 `page.goto("/read/<id>?ch=<另一章>")` 进入：一次新的导航，`<main>` 的 `scrollTop` 从 0
 * 开始，书签从 localStorage 读回，点击书签后的判定段落只取决于书签跳转本身。（EV 验收时不用阅读器内换章
 * 的另一个理由是 F-002 之下换章不复位文档的滚动位置；该缺陷已修复（reader-defect-fixes）。）
 *
 * ## 时间（6.4、6.5）
 *
 * 每个用例首次导航前 `clock.install()`，书加载完成后暂停（`pauseAt` 须跳向将来，取 `PAUSE_LEAD_MS` 的余量；
 * 此时尚无点击与滚动），此后只经 `page.clock.runFor` 推进。9.5 的"推进 100 ms"在收到 `scroll` 事件之后
 * 执行：应用的 rAF 与 1,000 ms 的进度保存防抖都受时钟控制，100 ms 足以跑过若干帧而早于保存。
 * 时钟暂停还保证顶栏不会自动隐藏（阅读器内的点击与换章都会启动 4.5 s 的隐藏定时器，全程推进量只有
 * 100 ms）。9.7 不涉及时长，同样装时钟并暂停，只为让顶栏在连续点击期间保持可见。
 *
 * 9.7 的"任何时刻"：点击之间只等顶栏按钮的可访问名称切换（读者看到图标变化再点下一次），并读一次
 * 书签键中该章的记录数（"我的书签"列表每次打开都从这个键读取）；n 次点击后再打开列表核对条目与计数。
 * n = 1..4 各一个用例，第 i 次点击后的列表也就在 n = i 的用例中核对过。
 */
import type { Page } from "@playwright/test";
import { SHOT_TESTS } from "../../review/catalog";
import { expect, test, type BookLog, type ClockControl, type Lib } from "../../support/fixtures";
import { NAMES, bookmarksTabName, reader, tocDrawer } from "../../support/locators";
import {
  bookUnderTest,
  expectCurrentChapter,
  expectDocumentNotScrollable,
  expectOffsetInParagraph,
  judgeScrollTarget,
  openBookmarkList,
  openReader,
  readBookmarkEntries,
  readJudgeParagraph,
  readParagraphStarts,
  scrollJudgeParagraphTo,
  type BookUnderTest,
  type BookmarkEntrySnapshot,
  type JudgeReading,
} from "../../support/reader";
import { step } from "../../support/step";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 9.5：滚动后、点击"添加书签"前 Controlled_Clock 推进的时长。 */
const ADD_AFTER_MS = 100;

/** 书加载完成后暂停 Controlled_Clock 时向前跳的余量（与 `reader-progress.spec.ts` 相同）。 */
const PAUSE_LEAD_MS = 1_000;

/** 9.7：连续点击次数 n 的取值。 */
const CLICK_COUNTS = [1, 2, 3, 4] as const;

/** 书签的 localStorage 键前缀（`src/utils/storage.ts` 的 `BOOKMARKS_PREFIX`，未导出）。 */
const BOOKMARKS_KEY_PREFIX = "koodo_novel_bookmarks_";

/** 注解里文本的截取长度。 */
const NOTE_CHARS = 40;

// ---------------------------------------------------------------------------
// 用书与章节
// ---------------------------------------------------------------------------

interface BookmarkPlan {
  book: BookUnderTest;
  /** 书签章节的下标。 */
  chapter: number;
  /** 书签章节的标题。 */
  title: string;
  /** 9.6 的"另一章"：书签章节之后（没有时之前）的一个正文章节。 */
  other: number;
}

async function bookmarkPlan(lib: Lib): Promise<BookmarkPlan> {
  const id = lib.role("longText");
  const book = await bookUnderTest(lib, id);
  return step("选定书签章节（roles.json longText.chapterIndex）与 9.6 的另一章", () => {
    const { facts } = book;
    const chapter = lib.fixtureRoles().longText.chapterIndex;
    const ordinal = facts.bodyOrdinals[chapter];
    if (ordinal === null || ordinal === undefined) {
      throw new Error(`${id}：longText.chapterIndex（下标 ${chapter}）不是正文章节`);
    }
    const other = facts.bodyIndices[ordinal + 1] ?? facts.bodyIndices[ordinal - 1];
    if (other === undefined) throw new Error(`${id} 只有 1 个正文章节，9.6 找不到另一章`);
    const title = facts.titles[chapter];
    test.info().annotations.push({
      type: "bookmark-plan",
      description: `书 ${id}；书签章节 下标 ${chapter}「${title}」；另一章 下标 ${other}「${facts.titles[other]}」`,
    });
    return { book, chapter, title, other };
  });
}

function clip(text: string): string {
  return text.length > NOTE_CHARS ? `${text.slice(0, NOTE_CHARS)}…` : text;
}

// ---------------------------------------------------------------------------
// 书签键（度量）
// ---------------------------------------------------------------------------

/** 书签键中的一条记录（只取用到的字段）。 */
interface StoredBookmark {
  chapterId: unknown;
  charOffset: unknown;
}

/** 书签键中的记录，原样读取（不去重）；键不存在时为空数组。 */
function storedBookmarks(page: Page, bookId: string): Promise<StoredBookmark[]> {
  return page.evaluate((key) => {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return [];
    const list: unknown = JSON.parse(raw);
    if (!Array.isArray(list)) throw new Error(`${key} 的值不是数组：${raw}`);
    return list.map((item: unknown) => {
      const record = typeof item === "object" && item !== null ? (item as Partial<StoredBookmark>) : {};
      return { chapterId: record.chapterId ?? null, charOffset: record.charOffset ?? null };
    });
  }, `${BOOKMARKS_KEY_PREFIX}${bookId}`);
}

/** 书签键中本章的记录。 */
async function storedFor(page: Page, plan: BookmarkPlan): Promise<StoredBookmark[]> {
  return (await storedBookmarks(page, plan.book.id)).filter((b) => b.chapterId === plan.chapter);
}

async function storedCountFor(page: Page, plan: BookmarkPlan): Promise<number> {
  return (await storedFor(page, plan)).length;
}

// ---------------------------------------------------------------------------
// 共用步骤
// ---------------------------------------------------------------------------

/** 书加载完成后暂停 Controlled_Clock，此后时间只经 `page.clock.runFor` 推进。 */
async function pauseClock(page: Page): Promise<void> {
  await step("暂停 Controlled_Clock（此后只经 runFor 推进）", async () => {
    const now = await page.evaluate(() => Date.now());
    await page.clock.pauseAt(now + PAUSE_LEAD_MS);
  });
}

/** 按 Esc 关闭目录抽屉。 */
async function closeTocDrawer(page: Page): Promise<void> {
  await step("按 Esc 关闭目录抽屉", async () => {
    await page.keyboard.press("Escape");
    await expect(tocDrawer(page).marker, "目录抽屉应已关闭").toHaveCount(0);
  });
}

/**
 * 装时钟打开书签章节（`?ch=`），暂停时钟，核对"当前章没有书签"：顶栏书签按钮名为"添加书签"，
 * 书签键中没有该章的记录，"我的书签"计数为 0、显示"暂无书签"。随后关闭抽屉。返回计数的初值（0）。
 */
async function openChapterWithoutBookmark(
  page: Page,
  bookLog: BookLog,
  clock: ClockControl,
  plan: BookmarkPlan,
): Promise<number> {
  const { book, chapter } = plan;
  await clock.install();
  await openReader(page, bookLog, book, chapter);
  await expectCurrentChapter(page, book.facts, chapter);
  await pauseClock(page);

  const initial = 0;
  await step("前提：当前章没有书签（顶栏按钮为“添加书签”，书签键中没有本章的记录）", async () => {
    await expect(reader(page).bookmarkButton, "顶栏书签按钮的可访问名称").toHaveAccessibleName(NAMES.addBookmark);
    expect(await storedCountFor(page, plan), "书签键中本章的记录数").toBe(0);
  });
  await openBookmarkList(page);
  await step(`“我的书签”计数为 ${initial}，显示“暂无书签”`, async () => {
    const drawer = tocDrawer(page);
    await expect(drawer.tabBookmarks).toHaveText(bookmarksTabName(initial));
    await expect(drawer.noBookmarks).toBeVisible();
  });
  await closeTocDrawer(page);
  return initial;
}

/** 不超过段落数一半、且能滚到判定线的最大序号；没有时为 0（与 `reader-progress.spec.ts` 相同）。 */
function chooseK(reading: JudgeReading): number {
  for (let k = Math.floor(reading.count / 2); k >= 1; k--) {
    const target = judgeScrollTarget(reading, k);
    if (target >= 0 && target <= reading.maxScrollTop) return k;
  }
  return 0;
}

/** 9.5 的 WHEN 做完之后的状态。 */
interface BookmarkAdded {
  k: number;
  /** 添加书签时各正文段落的文本（`textContent` 原样），下标即段落序号。 */
  texts: string[];
}

/**
 * 9.5 的 WHEN：把判定段落滚到第 k 段（等到 `scroll` 事件），Controlled_Clock 推进 100 ms，点击顶栏
 * "添加书签"，等按钮的可访问名称切换为"已添加书签 (点击移除)"（书签已写入的同步点）。
 */
async function addBookmarkAtK(page: Page, plan: BookmarkPlan): Promise<BookmarkAdded> {
  const k = await step("选定 k：不超过本章段落数一半且能滚到判定线的最大序号（k ≥ 1）", async () => {
    const reading = await readJudgeParagraph(page);
    const picked = chooseK(reading);
    test.info().annotations.push({
      type: "bookmark-plan",
      description:
        `段落 ${reading.count}、k = ${picked}；<main> 最大可滚距离 ${reading.maxScrollTop}`,
    });
    expect(picked, `应有 1 ≤ k ≤ ⌊${reading.count} / 2⌋ 且能滚到判定线的段落`).toBeGreaterThanOrEqual(1);
    return picked;
  });

  const reading = await scrollJudgeParagraphTo(page, k);
  const texts = await step(`读第 0 段与第 ${k} 段的文本（度量）`, async () => {
    const all = await reader(page).paragraphs.evaluateAll((ps) => ps.map((p) => p.textContent ?? ""));
    // 章节标题区里没有 <p>，<article> 内的段落即判定段落所数的正文段落
    expect(all.length, "<article> 内 <p> 的个数应等于判定段落所数的正文段落数").toBe(reading.count);
    expect(all[k].length, `第 ${k} 段应非空`).toBeGreaterThan(0);
    test.info().annotations.push({
      type: "bookmark-plan",
      description: `第 0 段「${clip(all[0])}」；第 ${k} 段「${clip(all[k])}」`,
    });
    return all;
  });

  await step(`Controlled_Clock 推进 ${ADD_AFTER_MS} ms（滚动后经过若干动画帧，早于 1,000 ms 的进度保存）`, async () => {
    await page.clock.runFor(ADD_AFTER_MS);
  });
  await step(`推进后判定段落仍为第 ${k} 段`, async () => {
    expect((await readJudgeParagraph(page)).index, "判定段落序号").toBe(k);
  });

  await step("点击顶栏“添加书签”", async () => {
    const view = reader(page);
    await view.addBookmarkButton.click();
    await expect(view.bookmarkButton, "顶栏书签按钮的可访问名称").toHaveAccessibleName(NAMES.removeBookmark);
    // 度量：记下书签记录的章内偏移，供判断预览与跳转落在哪一段（失败时的诊断依据）
    const records = await storedFor(page, plan);
    test.info().annotations.push({
      type: "bookmark-record",
      description: `书签键中本章的记录 ${records.length} 条：${records.map((r) => `charOffset ${String(r.charOffset)}`).join("、")}`,
    });
  });
  return { k, texts };
}

/** 打开"我的书签"，等计数为 `count`，读列表并断言恰有 `count` 条、其中本章恰 1 条，返回本章的那条。 */
async function readNewEntry(page: Page, plan: BookmarkPlan, count: number): Promise<BookmarkEntrySnapshot> {
  await openBookmarkList(page);
  await step(`“我的书签”计数为 ${count}`, async () => {
    await expect(tocDrawer(page).tabBookmarks).toHaveText(bookmarksTabName(count));
  });
  return step(`列表共 ${count} 条，其中恰 1 条显示本章标题「${plan.title}」`, async () => {
    const entries = await readBookmarkEntries(page);
    test.info().annotations.push({
      type: "bookmark-entry",
      description: entries
        .map((e) => `「${e.chapterTitle}」预览 ${e.preview === null ? "（无）" : `「${clip(e.preview)}」`}`)
        .join("；"),
    });
    expect(entries.length, "列表条目数").toBe(count);
    const mine = entries.filter((e) => e.chapterTitle === plan.title);
    expect(mine.length, `显示本章标题「${plan.title}」的条目数`).toBe(1);
    return mine[0];
  });
}

/** 9.6 的 WHEN：以 `?ch=<另一章>` 进入另一章，打开"我的书签"，点击本章的条目。返回被点击条目的快照。 */
async function jumpFromOtherChapter(
  page: Page,
  bookLog: BookLog,
  plan: BookmarkPlan,
): Promise<BookmarkEntrySnapshot> {
  const { book, other } = plan;
  await openReader(page, bookLog, book, other);
  await expectCurrentChapter(page, book.facts, other);
  const entry = await readNewEntry(page, plan, 1);
  await step(`点击“我的书签”中「${entry.chapterTitle}」的条目`, async () => {
    const drawer = tocDrawer(page);
    const target = drawer.bookmarkEntry(entry.chapterTitle);
    await expect(target, "页面上与该章节名完全相同的文本应只有条目标题一处").toHaveCount(1);
    await target.click();
    await expect(drawer.marker, "目录抽屉应已关闭").toHaveCount(0);
  });
  return entry;
}

// ---------------------------------------------------------------------------
// 9.5 添加书签（RS-21）
// ---------------------------------------------------------------------------

test.describe("9.5 添加书签", () => {
  test(SHOT_TESTS.bookmarkAdd.title, async ({ page, lib, bookLog, clock, shot }) => {
    // RS-21 为默认主题（localStorage 中没有已存储的主题），不 seedTheme
    const plan = await bookmarkPlan(lib);
    const initial = await openChapterWithoutBookmark(page, bookLog, clock, plan);
    await addBookmarkAtK(page, plan);
    // 第 k 段前缀的断言在下一个用例中（EV 因 F-002 按 16.7 拆出；已修复（reader-defect-fixes），拆分保留）
    const entry = await readNewEntry(page, plan, initial + 1);
    await step("9.5 新条目显示预览文字（非空）", async () => {
      expect(entry.preview, "新条目应渲染预览文字").not.toBeNull();
      expect(entry.preview ?? "", "预览文字应非空").not.toBe("");
    });
    await shot("bookmark-list");
  });

  test("9.5 添加书签：新条目的预览文字为判定段落第 k 段文本的非空前缀", async ({
    page,
    lib,
    bookLog,
    clock,
  }) => {
    const plan = await bookmarkPlan(lib);
    const initial = await openChapterWithoutBookmark(page, bookLog, clock, plan);
    const { k, texts } = await addBookmarkAtK(page, plan);
    const entry = await readNewEntry(page, plan, initial + 1);
    await step(`9.5 预览文字是第 ${k} 段文本的非空前缀`, async () => {
      const preview = entry.preview ?? "";
      const prefixOf = texts.flatMap((text, i) => (preview !== "" && text.startsWith(preview) ? [i] : []));
      expect(preview, "预览文字应非空").not.toBe("");
      expect(
        texts[k].startsWith(preview),
        `预览「${clip(preview)}」应为第 ${k} 段「${clip(texts[k])}」的前缀；` +
          `实际是第 ${prefixOf.length > 0 ? prefixOf.join("、") : "（无）"} 段的前缀`,
      ).toBe(true);
    });
  });

  test("RDF 3.2 判定段落滚到第 k 段后添加书签：书签记录的 charOffset 落在第 k 段的范围内（不小于该段起点、小于第 k + 1 段起点）", async ({
    page,
    lib,
    bookLog,
    clock,
  }) => {
    const plan = await bookmarkPlan(lib);
    await openChapterWithoutBookmark(page, bookLog, clock, plan);
    const { k } = await addBookmarkAtK(page, plan);
    const record = await step(`读书签键 ${BOOKMARKS_KEY_PREFIX}${plan.book.id} 中本章的记录（恰 1 条）`, async () => {
      const records = await storedFor(page, plan);
      expect(records.length, "书签键中本章的记录数").toBe(1);
      return records[0];
    });
    const paragraphs = await step("由全书文本与渲染出的段落文本推导本章各段的章内起点", () =>
      readParagraphStarts(page, lib, plan.book.id, plan.chapter),
    );
    await expectOffsetInParagraph(paragraphs, k, record.charOffset, "RDF 3.2 书签记录的 charOffset");
  });
});

// ---------------------------------------------------------------------------
// 9.6 书签跳转
// ---------------------------------------------------------------------------

test.describe("9.6 书签跳转", () => {
  test("9.6 在另一章点击「我的书签」中 9.5 添加的条目：显示该书签的章节（正文 <h1> 等于条目的章节名）", async ({
    page,
    lib,
    bookLog,
    clock,
  }) => {
    const plan = await bookmarkPlan(lib);
    await openChapterWithoutBookmark(page, bookLog, clock, plan);
    await addBookmarkAtK(page, plan);
    const entry = await jumpFromOtherChapter(page, bookLog, plan);
    await step(`9.6 正文 <h1> 等于条目的章节名「${entry.chapterTitle}」`, async () => {
      await expect(reader(page).chapterHeading).toHaveText(entry.chapterTitle);
    });
    await expectCurrentChapter(page, plan.book.facts, plan.chapter);
  });

  test("9.6 在另一章点击「我的书签」中 9.5 添加的条目：判定段落序号等于添加书签时的 k", async ({
    page,
    lib,
    bookLog,
    clock,
  }) => {
    const plan = await bookmarkPlan(lib);
    await openChapterWithoutBookmark(page, bookLog, clock, plan);
    const { k } = await addBookmarkAtK(page, plan);
    await jumpFromOtherChapter(page, bookLog, plan);
    await expectCurrentChapter(page, plan.book.facts, plan.chapter);
    await expectDocumentNotScrollable(page);
    await step(`9.6 判定段落序号为 ${k}`, async () => {
      let last: JudgeReading | null = null;
      try {
        await expect
          .poll(
            async () => {
              last = await readJudgeParagraph(page);
              return last.index;
            },
            { message: `书签跳转后判定段落序号应为 ${k}` },
          )
          .toBe(k);
      } finally {
        const r = last as JudgeReading | null;
        if (r !== null) {
          test.info().annotations.push({
            type: "bookmark-jump",
            description:
              `跳转后判定段落 ${r.index}；<main> scrollTop ${r.scrollTop}（最大 ${r.maxScrollTop}）、` +
              `判定线 ${r.line}、第 ${k} 段上边 ${r.tops[k]}`,
          });
        }
      }
    });
  });
});

// ---------------------------------------------------------------------------
// 9.7 连续点击书签按钮
// ---------------------------------------------------------------------------

test.describe("9.7 连续点击顶栏书签按钮", () => {
  for (const n of CLICK_COUNTS) {
    const expected = n % 2;
    test(`9.7 当前章初始没有书签，连续点击顶栏书签按钮 ${n} 次：「我的书签」中该章条目数为 ${expected}，计数随之增减，任何时刻不超过 1`, async ({
      page,
      lib,
      bookLog,
      clock,
    }) => {
      const plan = await bookmarkPlan(lib);
      const initial = await openChapterWithoutBookmark(page, bookLog, clock, plan);
      const view = reader(page);

      for (let i = 1; i <= n; i++) {
        const has = i % 2;
        await step(`第 ${i} 次点击顶栏书签按钮：本章有 ${has} 条书签`, async () => {
          await view.bookmarkButton.click();
          await expect(view.bookmarkButton, "顶栏书签按钮的可访问名称").toHaveAccessibleName(
            has === 1 ? NAMES.removeBookmark : NAMES.addBookmark,
          );
          const stored = await storedCountFor(page, plan);
          expect(stored, "书签键中本章的记录数不应超过 1").toBeLessThanOrEqual(1);
          expect(stored, "书签键中本章的记录数").toBe(has);
        });
      }

      await openBookmarkList(page);
      const count = initial + expected;
      await step(`9.7 “我的书签”计数为 ${count}（初值 ${initial} + ${n} mod 2）`, async () => {
        const drawer = tocDrawer(page);
        await expect(drawer.tabBookmarks).toHaveText(bookmarksTabName(count));
        if (count === 0) await expect(drawer.noBookmarks).toBeVisible();
      });
      await step(`9.7 列表中本章「${plan.title}」的条目数为 ${expected}，共 ${count} 条`, async () => {
        const entries = await readBookmarkEntries(page);
        expect(entries.length, "列表条目数").toBe(count);
        expect(entries.filter((e) => e.chapterTitle === plan.title).length, "本章的条目数").toBe(expected);
      });
    });
  }
});
