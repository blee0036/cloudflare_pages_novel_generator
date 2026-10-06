/**
 * 阅读器：阅读进度的保存与恢复（需求 9.8、9.9、9.10、9.12；Checklist H3）。
 * `common/`：在 `fixture` 项目运行（Opaque_Mode、桌面视口、默认主题）。测试只用 Fixture_Library
 * （test-data-desensitization 去掉了 real 档）。
 *
 * ## 用书与章节（4.4：期望值运行时推导）
 *
 * 书为 `lib.role("longText")`：3.3 (h)(i) 的夹具书。
 *
 * - 进度章节（9.8 的"正文高度不少于滚动容器可视高度 3 倍的章节"）：取 `roles.json` 的
 *   `longText.chapterIndex`（240 段）。打开后核对前提：正文高度 ≥ 3 × 滚动容器可视高度。
 * - k：不超过该章正文段落数一半、且能滚到判定线的最大序号（1 ≤ k ≤ ⌊段落数 / 2⌋）。
 * - 9.12 的 `?ch=`：进度章节之后的下一个正文章节（没有时取上一个）。取另一章而不是进度章节本身：
 *   若应用不顾 `?ch=` 按已存进度恢复，显示的会是进度章节（`<h1>` 不同）及其第 k 段；两层差别都能测到。
 *   同一章时只能靠段落区分；EV 验收时恢复本身不滚动（F-002，已修复（reader-defect-fixes）），那样的用例
 *   不论对错都通过。
 *
 * 所选章节、k 与读数记在注解 `progress-plan`、`progress-key` 里。前提不成立是测试自身的问题（16.6）。
 *
 * ## 滚动容器与判定段落
 *
 * 判定段落按需求 9.5 的定义，由 `e2e/support/reader.ts` 的 `readJudgeParagraph` 读取。"滚到第 k 段"对正文
 * 滚动容器 `<main>` 赋值 `scrollTop` 并等到它的 `scroll` 事件（`scrollJudgeParagraphTo`）；滚动之前与
 * 重新载入后读判定段落之前，都核对文档本身不可滚动（`expectDocumentNotScrollable`，reader-defect-fixes
 * 需求 2.1、14.2）。
 *
 * 应用的进度保存监听 `<main>` 的 `scroll` 事件（rAF 里算判定段落，再以 1,000 ms 防抖落盘），恢复位置
 * 赋值 `<main>.scrollTop`。同一场景的断言分在两个用例中：9.8 的 900 ms 未写入 / 1,100 ms 已更新，9.9 的
 * 同一章 / 判定段落仍为 k，9.10 的新字号 / 判定段落仍为 k；两个用例都执行该条 WHEN 中的全部操作（滚到
 * 第 k 段、推进 1,100 ms、调字号、重新载入）。9.12 不依赖滚动保存。打开进度章节本身就会写一条"该章章首"
 * 的进度记录（`ReaderPage` 的落盘 effect），9.8 的"滚动前的值"即这一条。
 *
 * `RDF 3.4`（reader-defect-fixes 需求 3.4 的偏移范围）：同样执行 9.8 的 WHEN 并推进 1,100 ms，等进度键更新后
 * 读出记录，断言其 `chapterId` 为进度章节、`charOffset` 不小于第 k 段的章内起点、小于第 k + 1 段的起点。
 * 各段起点由测试独立推导（`readParagraphStarts`：测试进程解压的全书文本按行切分，与渲染出的 `<p>` 文本
 * 依次对齐），不取自应用；全书文本在 worker 内只解压一次（`bookText` 缓存）。
 *
 * `RDF 3.6`（reader-defect-fixes 需求 3.6，RC 2.4 的行高一项）：与 9.10 同一流程，只是把"字号增大 5 px"换成
 * 在"行高间距"滑杆（按可访问名称定位，需求 6.1）上把行高调到网格上的非端点值 2.1；滑杆失焦后按 Esc 关闭
 * 抽屉、不再滚动，以不带 `?ch=` 的 `/read/<id>` 重新载入，断言正文段落的计算 `line-height` 与"字号 × 2.1"
 * 相差 ≤ 0.5 px，且判定段落序号仍为 k。修复前正文 `<p>` 的行高固定为 `leading-relaxed`，这一条无从谈起
 * （Findings_Log F-004 备注，已修复（reader-defect-fixes））。
 *
 * 历史：EV 验收时 `<main>` 随内容增高、实际滚动的是文档（Findings_Log F-002，已修复（reader-defect-fixes））：
 * 文档滚动不触发进度保存，恢复位置的赋值无效，9.8 的"1,100 ms 时更新"与 9.9、9.10 的"判定段落仍为 k"
 * 按 16.7 拆成预期失败用例。修复后它们改为普通用例，用例划分与断言保持不变。
 *
 * ## 时间（6.4、6.5）
 *
 * 每个用例首次导航前 `clock.install()`（起点 `CLOCK_T0`），书加载完成后暂停（`pauseAt` 须跳向将来，取
 * `PAUSE_LEAD_MS` 的余量；此时尚无点击与滚动，跳过的这段时间里没有与断言相关的计时器），此后只经
 * `page.clock.runFor` 推进。"自最后一次滚动事件起"：滚动后先等到 `scroll` 事件（浏览器渲染步骤派发，
 * 不受时钟控制），此后时钟保持暂停，推进量即自该事件起的时长。应用的 rAF 与防抖定时器都受时钟控制；
 * React 的提交走 MessageChannel，不受控，所以"已更新"以 `expect.poll` 等待，"仍相同"在推进后立即读取
 * （防抖定时器未到期，不会有待提交的写入）。
 *
 * 重新载入用 `page.goto`（不带 `?ch=` 的 `/read/<id>`，9.9 的"重新访问"）。首次打开的 URL 带 `?ch=`，
 * 两者不同，是一次新的导航，浏览器不做重载时的滚动位置还原。Controlled_Clock 在新文档里按日志重放，
 * 保持暂停；书的加载只依赖 fetch、IndexedDB 与解压流，不需要推进时钟。9.12 的"scrollTop 为 0"读数前推进
 * 2 帧（`2 × CLOCK_STEP_MS`），让受时钟控制的 rAF 回调执行到（`waitFrames` 不能与时钟同用）。
 */
import type { Page } from "@playwright/test";
import type { ReadingProgress } from "../../../src/types";
import { PROGRESS_KEY_PREFIX, expect, test, type BookLog, type ClockControl, type Lib } from "../../support/fixtures";
import { reader, settingsDrawer } from "../../support/locators";
import {
  bookUnderTest,
  expectCurrentChapter,
  expectDocumentNotScrollable,
  expectOffsetInParagraph,
  judgeScrollTarget,
  openReader,
  readDocumentScroll,
  readJudgeParagraph,
  readMainScroll,
  readParagraphStarts,
  scrollJudgeParagraphTo,
  type BookUnderTest,
  type JudgeReading,
} from "../../support/reader";
import { CLOCK_STEP_MS } from "../../support/settings";
import { step } from "../../support/step";

// ---------------------------------------------------------------------------
// 常量（取自需求条文）
// ---------------------------------------------------------------------------

/** 9.8：自最后一次滚动事件起推进到此时，进度键的值仍须与滚动前相同。 */
const SAVE_NOT_YET_MS = 900;

/** 9.8：自最后一次滚动事件起推进满此时（1,000 ms 防抖 + 至多 100 ms 帧调度余量），进度键须已更新。 */
const SAVE_DONE_MS = 1_100;

/** 9.8：正文高度不少于滚动容器可视高度的倍数。 */
const BODY_SCREENS = 3;

/** 9.10：字号增大的幅度（点击"A+"的次数，步长 1 px）与字号取值范围。 */
const FONT_INCREASE_PX = 5;
const FONT_MIN_PX = 14;
const FONT_MAX_PX = 36;

/** 书加载完成后暂停 Controlled_Clock 时向前跳的余量（与 `reader-search.spec.ts` 相同）。 */
const PAUSE_LEAD_MS = 1_000;

/**
 * RDF 3.6：行高调到的网格上的非端点值（区间 1.4–2.5、步长 0.05；1.4 + 14 × 0.05），与默认值 1.85 不同。
 * 写成字面量，不在测试里做浮点累加。
 */
const RDF_LINE_HEIGHT = 2.1;

/** RDF 3.6：段落计算 `line-height` 与"字号 × 新行高"的容差。 */
const LINE_HEIGHT_TOLERANCE_PX = 0.5;

// ---------------------------------------------------------------------------
// 用书、章节与进度键
// ---------------------------------------------------------------------------

interface ProgressPlan {
  book: BookUnderTest;
  /** 进度章节（9.8 的长章节）的下标。 */
  chapter: number;
  /** 9.12 的 `?ch=`：进度章节之后（没有时之前）的一个正文章节。 */
  other: number;
}

/** 取本用例的书与章节（见文件头）。须在用例体内调用：`bookUnderTest` 会为大书设置用例超时。 */
async function progressPlan(lib: Lib): Promise<ProgressPlan> {
  const id = lib.role("longText");
  const book = await bookUnderTest(lib, id);
  return step("选定进度章节（9.8 的长章节）与 9.12 的 ?ch= 章节", () => {
    const { facts } = book;
    const chapter = lib.fixtureRoles().longText.chapterIndex;
    const rule = "roles.json longText.chapterIndex";
    const ordinal = facts.bodyOrdinals[chapter];
    if (ordinal === null || ordinal === undefined) {
      throw new Error(`${id}：进度章节（下标 ${chapter}，${rule}）不是正文章节`);
    }
    const other = facts.bodyIndices[ordinal + 1] ?? facts.bodyIndices[ordinal - 1];
    if (other === undefined) throw new Error(`${id} 只有 1 个正文章节，9.12 找不到另一章`);
    test.info().annotations.push({
      type: "progress-plan",
      description: `书 ${id}；进度章节 下标 ${chapter}「${facts.titles[chapter]}」（${rule}）；9.12 的 ?ch=${other}「${facts.titles[other]}」`,
    });
    return { book, chapter, other };
  });
}

function progressKey(bookId: string): string {
  return `${PROGRESS_KEY_PREFIX}${bookId}`;
}

/** 进度键的原值（没有时为 null）。 */
function readProgressValue(page: Page, bookId: string): Promise<string | null> {
  return page.evaluate((key) => window.localStorage.getItem(key), progressKey(bookId));
}

/** 进度记录的章号；键不存在或不是合法 JSON 时为 null。 */
function chapterIdOf(raw: string | null): number | null {
  if (raw === null) return null;
  try {
    const record = JSON.parse(raw) as Partial<ReadingProgress>;
    return typeof record.chapterId === "number" ? record.chapterId : null;
  } catch {
    return null;
  }
}

function noteProgressKey(label: string, raw: string | null): void {
  test.info().annotations.push({ type: "progress-key", description: `${label}：${raw ?? "（键不存在）"}` });
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

async function advanceClock(page: Page, ms: number, what: string): Promise<void> {
  await step(`Controlled_Clock 推进 ${ms} ms（${what}）`, async () => {
    await page.clock.runFor(ms);
  });
}

/** 9.8 的 WHEN 做完之后的状态。 */
interface ScrolledToK {
  /** 判定段落序号。 */
  k: number;
  /** 滚动前进度键的值。 */
  before: string;
  /** 滚动后的判定段落读数。 */
  reading: JudgeReading;
}

/** 不超过段落数一半、且能滚到判定线的最大序号；没有时为 0。 */
function chooseK(reading: JudgeReading): number {
  for (let k = Math.floor(reading.count / 2); k >= 1; k--) {
    const target = judgeScrollTarget(reading, k);
    if (target >= 0 && target <= reading.maxScrollTop) return k;
  }
  return 0;
}

/**
 * 9.8 的 WHEN：装时钟打开进度章节（`?ch=`），暂停时钟，记下滚动前进度键的值，核对正文高度前提，
 * 把判定段落滚到第 k 段并等到 `scroll` 事件（此后时钟未推进）。
 */
async function openAndScrollToK(
  page: Page,
  bookLog: BookLog,
  clock: ClockControl,
  plan: ProgressPlan,
): Promise<ScrolledToK> {
  const { book, chapter } = plan;
  await clock.install();
  await openReader(page, bookLog, book, chapter);
  await expectCurrentChapter(page, book.facts, chapter);
  await pauseClock(page);

  const before = await step("打开本章后进度键已有本章的记录，记下滚动前的值", async () => {
    await expect
      .poll(async () => chapterIdOf(await readProgressValue(page, book.id)), {
        message: `进度键 ${progressKey(book.id)} 应已写入本章（chapterId ${chapter}）的记录`,
      })
      .toBe(chapter);
    const raw = await readProgressValue(page, book.id);
    if (raw === null) throw new Error("进度键在读取之间消失");
    noteProgressKey("滚动前", raw);
    return raw;
  });

  const k = await step(
    `9.8 前提：本章正文高度 ≥ ${BODY_SCREENS} × 滚动容器可视高度；k 取 ≤ 段落数一半且能滚到的最大序号`,
    async () => {
      const reading = await readJudgeParagraph(page);
      const picked = chooseK(reading);
      test.info().annotations.push({
        type: "progress-plan",
        description:
          `正文高度 ${reading.bodyHeight}、可视高度 ${reading.visibleHeight}、段落 ${reading.count}、` +
          `k = ${picked}；<main> 最大可滚距离 ${reading.maxScrollTop}`,
      });
      expect(reading.maxScrollTop, "<main> 应可滚动（最大可滚距离 ≥ 1 px）").toBeGreaterThanOrEqual(1);
      expect(
        reading.bodyHeight,
        `正文高度应 ≥ ${BODY_SCREENS} × 可视高度 ${reading.visibleHeight}（9.8）`,
      ).toBeGreaterThanOrEqual(BODY_SCREENS * reading.visibleHeight);
      expect(picked, `应有 1 ≤ k ≤ ⌊${reading.count} / 2⌋ 且能滚到判定线的段落`).toBeGreaterThanOrEqual(1);
      return picked;
    },
  );

  const reading = await scrollJudgeParagraphTo(page, k);
  return { k, before, reading };
}

/** 9.9 的重新载入：不带 `?ch=` 的 `/read/<id>`。 */
async function reopenWithoutCh(page: Page, bookLog: BookLog, book: BookUnderTest): Promise<void> {
  await openReader(page, bookLog, book);
}

/**
 * 重新载入后等判定段落为 `k`（恢复在段落测量后的 layout effect 中执行，以轮询等待）。之前核对文档不可
 * 滚动（需求 2.1），判定段落因此只取决于 `<main>` 的滚动位置。
 */
async function expectJudgeParagraph(page: Page, k: number, what: string): Promise<void> {
  await expectDocumentNotScrollable(page);
  await step(`${what}：判定段落序号为 ${k}`, async () => {
    let last: JudgeReading | null = null;
    await expect
      .poll(
        async () => {
          last = await readJudgeParagraph(page);
          return last.index;
        },
        { message: `判定段落序号应为 ${k}` },
      )
      .toBe(k)
      .catch((error: unknown) => {
        const r = last as JudgeReading | null;
        const detail =
          r === null
            ? ""
            : `（实际第 ${r.index} 段；<main> scrollTop ${r.scrollTop}（最大 ${r.maxScrollTop}）、` +
              `判定线 ${r.line}、第 ${k} 段上边 ${r.tops[k]}）`;
        throw new Error(`${what}：判定段落序号应为 ${k}${detail}\n${error instanceof Error ? error.message : String(error)}`);
      });
  });
}

/**
 * 9.10：经顶栏"阅读设置"打开设置抽屉，点击"A+" 5 次（前置核对当前字号 + 5 仍在 14–36 内），按 Esc
 * 关闭。返回新字号（px）。
 */
async function increaseFontSize(page: Page): Promise<number> {
  const drawer = settingsDrawer(page);
  await step("点击顶栏“阅读设置”打开设置抽屉", async () => {
    await reader(page).settingsButton.click();
    await expect(drawer.marker).toBeVisible();
  });
  const original = await step(
    `读当前字号（前置：增大 ${FONT_INCREASE_PX} px 后仍在 ${FONT_MIN_PX}–${FONT_MAX_PX} px 内）`,
    async () => {
      const text = ((await drawer.fontSizeValue.textContent()) ?? "").trim();
      const match = /^(\d+)px$/.exec(text);
      if (match === null) throw new Error(`无法解析字号显示值 ${JSON.stringify(text)}`);
      const value = Number(match[1]);
      expect(value, "当前字号").toBeGreaterThanOrEqual(FONT_MIN_PX);
      expect(value, `当前字号应 ≤ ${FONT_MAX_PX - FONT_INCREASE_PX}`).toBeLessThanOrEqual(FONT_MAX_PX - FONT_INCREASE_PX);
      return value;
    },
  );
  const increased = original + FONT_INCREASE_PX;
  await step(`点击“A+” ${FONT_INCREASE_PX} 次：字号 ${original}px → ${increased}px`, async () => {
    for (let i = 1; i <= FONT_INCREASE_PX; i++) {
      await drawer.fontIncrease.click();
      await expect(drawer.fontSizeValue).toHaveText(`${original + i}px`);
    }
  });
  await step("按 Esc 关闭设置抽屉（此后不再滚动）", async () => {
    await page.keyboard.press("Escape");
    await expect(drawer.marker, "设置抽屉应已关闭").toHaveCount(0);
  });
  return increased;
}

// ---------------------------------------------------------------------------
// 9.8 停止滚动 1 秒后写入进度
// ---------------------------------------------------------------------------

test.describe("9.8 停止滚动后写入进度", () => {
  test(`9.8 判定段落滚到第 k 段并停止滚动：自最后一次滚动事件起推进 ${SAVE_NOT_YET_MS} ms 时进度键的值仍与滚动前相同`, async ({
    page,
    lib,
    bookLog,
    clock,
  }) => {
    const plan = await progressPlan(lib);
    const { before } = await openAndScrollToK(page, bookLog, clock, plan);
    await advanceClock(page, SAVE_NOT_YET_MS, "自滚动事件起");
    await step(`9.8 自滚动事件起 ${SAVE_NOT_YET_MS} ms：进度键的值与滚动前相同`, async () => {
      const now = await readProgressValue(page, plan.book.id);
      noteProgressKey(`${SAVE_NOT_YET_MS} ms`, now);
      expect(now, `进度键 ${progressKey(plan.book.id)} 的值`).toBe(before);
    });
  });

  test(`9.8 判定段落滚到第 k 段并停止滚动：自最后一次滚动事件起推进满 ${SAVE_DONE_MS} ms 时更新进度键`, async ({
    page,
    lib,
    bookLog,
    clock,
  }) => {
    const plan = await progressPlan(lib);
    const { before } = await openAndScrollToK(page, bookLog, clock, plan);
    await advanceClock(page, SAVE_DONE_MS, "自滚动事件起");
    await step(`9.8 自滚动事件起满 ${SAVE_DONE_MS} ms：进度键的值已更新`, async () => {
      try {
        await expect
          .poll(() => readProgressValue(page, plan.book.id), {
            message: `进度键 ${progressKey(plan.book.id)} 的值应已不同于滚动前`,
          })
          .not.toBe(before);
      } finally {
        noteProgressKey(`${SAVE_DONE_MS} ms`, await readProgressValue(page, plan.book.id));
      }
    });
  });

  test(`RDF 3.4 判定段落滚到第 k 段并停止滚动：自最后一次滚动事件起满 ${SAVE_DONE_MS} ms 时写入的进度记录，其 charOffset 落在第 k 段的范围内（不小于该段起点、小于第 k + 1 段起点）`, async ({
    page,
    lib,
    bookLog,
    clock,
  }) => {
    const plan = await progressPlan(lib);
    const { k, before } = await openAndScrollToK(page, bookLog, clock, plan);
    await advanceClock(page, SAVE_DONE_MS, "自滚动事件起");
    const record = await step(`等进度键更新，读出本章（chapterId ${plan.chapter}）的进度记录`, async () => {
      await expect
        .poll(() => readProgressValue(page, plan.book.id), {
          message: `进度键 ${progressKey(plan.book.id)} 的值应已不同于滚动前`,
        })
        .not.toBe(before);
      const raw = await readProgressValue(page, plan.book.id);
      noteProgressKey(`${SAVE_DONE_MS} ms`, raw);
      if (raw === null) throw new Error("进度键在读取之间消失");
      const parsed = JSON.parse(raw) as Partial<ReadingProgress>;
      expect(parsed.chapterId, "进度记录的 chapterId").toBe(plan.chapter);
      return parsed;
    });
    const paragraphs = await step("由全书文本与渲染出的段落文本推导本章各段的章内起点", () =>
      readParagraphStarts(page, lib, plan.book.id, plan.chapter),
    );
    await expectOffsetInParagraph(paragraphs, k, record.charOffset, "RDF 3.4 进度记录的 charOffset");
  });
});

// ---------------------------------------------------------------------------
// 9.9 重新载入恢复到同一段落（H3）
// ---------------------------------------------------------------------------

test.describe("9.9 重新载入后恢复进度", () => {
  test("9.9 进度写入后以不带 ?ch= 的 /read/<id> 重新载入：显示同一章", async ({ page, lib, bookLog, clock }) => {
    const plan = await progressPlan(lib);
    await openAndScrollToK(page, bookLog, clock, plan);
    await advanceClock(page, SAVE_DONE_MS, "9.8 的写入时限");
    await reopenWithoutCh(page, bookLog, plan.book);
    await expectCurrentChapter(page, plan.book.facts, plan.chapter);
  });

  test("9.9 进度写入后以不带 ?ch= 的 /read/<id> 重新载入：判定段落序号仍为 k", async ({
    page,
    lib,
    bookLog,
    clock,
  }) => {
    const plan = await progressPlan(lib);
    const { k } = await openAndScrollToK(page, bookLog, clock, plan);
    await advanceClock(page, SAVE_DONE_MS, "9.8 的写入时限");
    await reopenWithoutCh(page, bookLog, plan.book);
    await expectJudgeParagraph(page, k, "9.9 重新载入后");
  });
});

// ---------------------------------------------------------------------------
// 9.10 字号增大后恢复到同一段落
// ---------------------------------------------------------------------------

/** 正文段落的计算样式 `font-size`（去重）。 */
function paragraphFontSizes(page: Page): Promise<string[]> {
  return reader(page).paragraphs.evaluateAll((ps) => [...new Set(ps.map((p) => getComputedStyle(p).fontSize))]);
}

test.describe("9.10 字号增大后恢复进度", () => {
  test(`9.10 进度写入后字号增大 ${FONT_INCREASE_PX} px、关闭设置抽屉并重新载入：正文段落以新字号渲染`, async ({
    page,
    lib,
    bookLog,
    clock,
  }) => {
    const plan = await progressPlan(lib);
    await openAndScrollToK(page, bookLog, clock, plan);
    await advanceClock(page, SAVE_DONE_MS, "9.8 的写入时限");
    const size = await increaseFontSize(page);
    await reopenWithoutCh(page, bookLog, plan.book);
    await step(`9.10 重新载入后正文段落的计算样式 font-size 均为 ${size}px`, async () => {
      await expect(reader(page).paragraphs.first()).toBeVisible();
      await expect.poll(() => paragraphFontSizes(page), { message: "正文段落的 font-size" }).toEqual([`${size}px`]);
    });
  });

  test(`9.10 进度写入后字号增大 ${FONT_INCREASE_PX} px、关闭设置抽屉并重新载入：判定段落序号仍为 k`, async ({
    page,
    lib,
    bookLog,
    clock,
  }) => {
    const plan = await progressPlan(lib);
    const { k } = await openAndScrollToK(page, bookLog, clock, plan);
    await advanceClock(page, SAVE_DONE_MS, "9.8 的写入时限");
    await increaseFontSize(page);
    await reopenWithoutCh(page, bookLog, plan.book);
    await expectJudgeParagraph(page, k, "9.10 字号增大后重新载入");
  });
});

// ---------------------------------------------------------------------------
// RDF 3.6 行高改变后恢复到同一段落
// ---------------------------------------------------------------------------

/** `"35.15px"` → 35.15；不是 px 长度时为 NaN。 */
function px(value: string): number {
  const match = /^(-?\d+(?:\.\d+)?)px$/.exec(value.trim());
  return match === null ? Number.NaN : Number(match[1]);
}

/** 正文段落的计算样式 `line-height`（去重）。 */
function paragraphLineHeights(page: Page): Promise<string[]> {
  return reader(page).paragraphs.evaluateAll((ps) => [...new Set(ps.map((p) => getComputedStyle(p).lineHeight))]);
}

/**
 * RDF 3.6：经顶栏"阅读设置"打开设置抽屉，在"行高间距"滑杆（按可访问名称定位，需求 6.1）上按方向键把
 * 行高调到 `target`（前置核对 `target` 在网格上、不在端点、与当前值不同），然后让滑杆失焦、按 Esc 关闭
 * 抽屉（焦点在滑杆上时 Esc 归输入框，阅读器不接管）。返回字号（px，未改动）。
 */
async function changeLineHeight(page: Page, target: number): Promise<number> {
  const drawer = settingsDrawer(page);
  await step("点击顶栏“阅读设置”打开设置抽屉", async () => {
    await reader(page).settingsButton.click();
    await expect(drawer.marker).toBeVisible();
  });
  const { fontSize, current, presses } = await step(
    `读当前字号与行高（前置：${target} 在行高滑杆的网格上、不在端点、与当前值不同）`,
    async () => {
      const parse = async (text: Promise<string | null>, pattern: RegExp, what: string): Promise<number> => {
        const raw = ((await text) ?? "").trim();
        const match = pattern.exec(raw);
        if (match === null) throw new Error(`无法解析${what}显示值 ${JSON.stringify(raw)}`);
        return Number(match[1]);
      };
      const size = await parse(drawer.fontSizeValue.textContent(), /^(\d+)px$/, "字号");
      const now = await parse(drawer.lineHeightValue.textContent(), /^(\d(?:\.\d+)?)x$/, "行高");
      const attr = async (name: string): Promise<number> => Number(await drawer.lineHeightSlider.getAttribute(name));
      const [min, max, stepSize] = [await attr("min"), await attr("max"), await attr("step")];
      const offset = (target - min) / stepSize;
      expect(Math.abs(offset - Math.round(offset)), `${target} 应在网格 ${min} + k × ${stepSize} 上`).toBeLessThan(1e-6);
      expect(target, "目标行高应大于下端点").toBeGreaterThan(min);
      expect(target, "目标行高应小于上端点").toBeLessThan(max);
      expect(target, "目标行高应与当前值不同").not.toBe(now);
      return { fontSize: size, current: now, presses: Math.round((target - now) / stepSize) };
    },
  );
  const key = presses > 0 ? "ArrowRight" : "ArrowLeft";
  await step(`“行高间距”滑杆按 ${key} ×${Math.abs(presses)}：行高 ${current}x → ${target}x`, async () => {
    for (let i = 0; i < Math.abs(presses); i++) await drawer.lineHeightSlider.press(key);
    await expect(drawer.lineHeightValue).toHaveText(`${target}x`);
    await expect(drawer.lineHeightSlider).toHaveValue(String(target));
  });
  await step("滑杆失焦后按 Esc 关闭设置抽屉（此后不再滚动）", async () => {
    await drawer.lineHeightSlider.blur();
    await page.keyboard.press("Escape");
    await expect(drawer.marker, "设置抽屉应已关闭").toHaveCount(0);
  });
  return fontSize;
}

test.describe("RDF 3.6 行高改变后恢复进度", () => {
  test(`RDF 3.6 进度写入后在设置抽屉把行高调到 ${RDF_LINE_HEIGHT}（网格上的非端点值）、关闭设置抽屉并以不带 ?ch= 的 /read/<id> 重新载入：正文段落 line-height 与「字号 × ${RDF_LINE_HEIGHT}」相差 ≤ ${LINE_HEIGHT_TOLERANCE_PX} px，判定段落序号仍为 k`, async ({
    page,
    lib,
    bookLog,
    clock,
  }) => {
    const plan = await progressPlan(lib);
    const { k, before } = await openAndScrollToK(page, bookLog, clock, plan);
    await advanceClock(page, SAVE_DONE_MS, "9.8 的写入时限");
    await step("前提：进度键已更新为第 k 段的记录", async () => {
      await expect
        .poll(() => readProgressValue(page, plan.book.id), {
          message: `进度键 ${progressKey(plan.book.id)} 的值应已不同于滚动前`,
        })
        .not.toBe(before);
      noteProgressKey("改行高前", await readProgressValue(page, plan.book.id));
    });
    const fontSize = await changeLineHeight(page, RDF_LINE_HEIGHT);
    await reopenWithoutCh(page, bookLog, plan.book);
    await expectCurrentChapter(page, plan.book.facts, plan.chapter);

    const expected = fontSize * RDF_LINE_HEIGHT;
    await step(
      `RDF 3.6 重新载入后正文段落的 line-height 与 ${fontSize}px × ${RDF_LINE_HEIGHT} = ${expected.toFixed(3)}px 相差 ≤ ${LINE_HEIGHT_TOLERANCE_PX}px`,
      async () => {
        await expect(reader(page).paragraphs.first()).toBeVisible();
        await expect
          .poll(
            async () => {
              const values = await paragraphLineHeights(page);
              const off = values.filter((v) => !(Math.abs(px(v) - expected) <= LINE_HEIGHT_TOLERANCE_PX));
              return off.length === 0 ? "相符" : `段落 line-height [${values.join(" | ")}]`;
            },
            { message: `正文段落的 line-height 应与 ${expected.toFixed(3)}px 相差 ≤ ${LINE_HEIGHT_TOLERANCE_PX}px` },
          )
          .toBe("相符");
      },
    );
    await expectJudgeParagraph(page, k, `RDF 3.6 行高改为 ${RDF_LINE_HEIGHT} 后重新载入`);
  });
});

// ---------------------------------------------------------------------------
// 9.12 带 ?ch= 时回到章首
// ---------------------------------------------------------------------------

test.describe("9.12 带 ?ch= 重新载入", () => {
  test("9.12 进度写入后以带有效 ?ch=<n> 的 URL 重新载入：显示第 n 章章首（<main> 与文档 scrollTop 为 0），不按已存进度恢复段落", async ({
    page,
    lib,
    bookLog,
    clock,
  }) => {
    const plan = await progressPlan(lib);
    const { book, chapter, other } = plan;
    await openAndScrollToK(page, bookLog, clock, plan);
    await advanceClock(page, SAVE_DONE_MS, "9.8 的写入时限");
    await step(`重新载入前进度键中是进度章节（chapterId ${chapter}）的记录`, async () => {
      const raw = await readProgressValue(page, book.id);
      noteProgressKey("重新载入前", raw);
      expect(chapterIdOf(raw), "进度记录的 chapterId").toBe(chapter);
    });

    await openReader(page, bookLog, book, other);
    await expectCurrentChapter(page, book.facts, other);
    await advanceClock(page, 2 * CLOCK_STEP_MS, "2 帧，让受时钟控制的 rAF 回调执行到");
    await expectDocumentNotScrollable(page);
    await step("9.12 显示章首：<main> 与文档滚动元素的 scrollTop 均为 0，判定段落为第 0 段", async () => {
      const [main, doc, judge] = await Promise.all([
        readMainScroll(page),
        readDocumentScroll(page),
        readJudgeParagraph(page),
      ]);
      expect({ main: main.scrollTop, document: doc.scrollTop }, "<main> 与文档的 scrollTop").toEqual({
        main: 0,
        document: 0,
      });
      expect(judge.index, "判定段落序号（章首）").toBe(0);
    });
  });
});
