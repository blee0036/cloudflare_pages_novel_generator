/**
 * 阅读器：当前章节写回 URL（reader-defect-fixes 需求 7.1、7.3、7.4、7.5、7.8、7.9；Findings_Log F-005，已修复
 * （reader-defect-fixes））。`fixture` 项目（:4611，Opaque_Mode），桌面视口，默认主题（不 `seedTheme`）。用例标题以
 * `RDF <需求编号>` 开头（设计 S10）。
 *
 * ## 写回与等待
 *
 * 阅读器每完成一次定位（首次定位与各种换章），就以替换当前历史记录的方式把 URL 的 `ch` 写成当前章节在
 * `_toc.json` 中的下标（D2）。写回在定位提交之后的 effect 里发起，路由状态的更新包在 transition 中（React
 * Router 7），比正文渲染晚一拍：URL 一律经 `expectCurrentChapter`（8.1 判定 + 轮询 URL 的 `ch`）等到写回，再读
 * `page.url()` / `location`。7.3、7.9 的"不变"类比较在写回之后再等一轮渲染（`settle`：页面内 3 次
 * MessageChannel 往返，即 React 调度所用的任务源，再等 2 个动画帧）后读数比较，不用固定时长。
 *
 * ## 用书（4.4：期望值运行时推导）
 *
 * - 7.1、7.4、7.5 的卷节点一例：`lib.role("volumes")`（3.3 (b)，带卷节点）。选"前后都有正文章节、卷节点最多"的
 *   卷段（同数取下标最小者）：`before` 为卷段之前的最后一个正文章节，`after` 为卷段之后的第一个正文章节，
 *   两者下标之差大于 1，URL 的 `ch` 若写成正文序号或相邻下标都会被测出。
 * - 7.3、7.5、7.9：`lib.role("longText")` 的长章 `roles.json longText.chapterIndex`（可滚到章中），检索词为
 *   `longText.fewKeyword`。
 * - 7.8：`books.json` 首批书卡中第一本至少有 3 个正文章节的书，经书卡"开始阅读"进入。
 *
 * ## 各条的做法
 *
 * - 7.1：每种入口一个用例。以 `?from=…&ch=<起点>&note=…` 打开（`ch` 之外另带两个参数，其一含中文、空格与
 *   `&`、`=`、`?`），记下路径、参数与 `history.length`，执行一次换章，断言 8.1 的当前章节为目标、URL 恰有一个
 *   `ch` 且等于 `String(目标下标)`（十进制、无前导零），路径与 `ch` 以外的参数（键、值与先后顺序）不变，
 *   `history.length` 不变。入口：`→` / `←` 键、底栏"下一章 (→)" / "上一章 (←)"、章末"下一章" / "上一章"、
 *   章节进度滑杆（聚焦后按 `End`，方向键与 `End` 归滑杆自己）、目录点击、书签跳转（在 `before` 添加书签，
 *   `→` 到 `after`，经"我的书签"跳回）、检索跳转（`volumesKeyword` 最后一处位于另一个正文章节的命中）、
 *   `Space` 换章（先 `End`）。首次定位一个用例，依次以 `ch` 无效（`abc`）、缺省、指向卷节点、带前导零打开，
 *   `history.length` 的基准取导航前的值加 1（导航本身新增的那条）。
 * - 7.3：写回发生后 `scrollTop`、高亮与待恢复的位置不变。检索跳转（装 Controlled_Clock、书加载后暂停，顶栏与
 *   底栏在度量期间保持可见，高亮的 5 s 定时器也不走）：URL 写回为命中章节后满足需求 3.1（EV 9.2 的全部断言），
 *   再等一轮渲染，`scrollTop` 不变、高亮仍在。书签跳转：长章滚到第 k 段后添加书签，`→` 换章，经"我的书签"跳回，
 *   URL 写回后判定段落为 k（需求 3.3），再等一轮渲染仍为 k、`scrollTop` 不变。首次定位：长章滚到第 k 段，等进度
 *   键写入后以不带 `?ch=` 的 `/read/<id>` 重新打开，URL 写回为该章后判定段落为 k（需求 3.5），再等一轮仍不变。
 * - 7.4：以 `?ch=<before>` 打开，`→` 换到 `after`，等进度键的章号为 `after` 后 `page.reload()`：显示 `after`，
 *   进度键的章号仍为 `after`。
 * - 7.5：长章滚到第 k 段、进度写入后以 `?ch=<该章>` 打开，判定段落为 k；卷节点一例在 `after` 滚到第 k 段，
 *   以 `?ch=<卷段末个卷节点>` 打开（归一后即 `after`），判定段落为 k，URL 写回为 `after`。
 * - 7.8：打开书架，记下 URL，点书卡"开始阅读"进入，`→`、`→`、`←` 换章 3 次（`history.length` 不变），浏览器后退
 *   一次：URL 与进入前相同，书架检索框可见。
 * - 7.9：长章滚到章中，`history.pushState` 把 `ch` 改为下一个正文章节并派发 `popstate`：渲染该章，章首
 *   （`scrollTop` 为 0）；另一例改为当前章节的下标：章节、`scrollTop` 与 URL 的 `ch` 都不变。两例的
 *   `history.length` 都只多出 `pushState` 那 1 条。
 *
 * 等进度写入用真实时间（7.3 首次定位、7.4、7.5）：停止滚动后 1 s 防抖保存，轮询进度键直到出现本章、偏移 > 0 的
 * 记录（可观测条件，上限 `TIMEOUTS.wait`）。所选的书、章节、k 与读数记在注解 `url-plan`、`url-reading` 里。
 */
import type { Locator, Page } from "@playwright/test";
import type { ReadingProgress } from "../../../src/types";
import { PAGE_SIZE } from "../../../src/utils/pagination";
import { PROGRESS_KEY_PREFIX, expect, test, type BookLog, type Lib } from "../../support/fixtures";
import type { VolumeRun } from "../../support/library";
import { NAMES, reader, readerJumpHighlight, searchDrawer, shelf, tocDrawer } from "../../support/locators";
import {
  bookText,
  bookUnderTest,
  expectCurrentChapter,
  expectDocumentNotScrollable,
  findOccurrences,
  judgeScrollTarget,
  openReader,
  openSearchDrawer,
  openTocDrawer,
  readJudgeParagraph,
  readMainScroll,
  readSearchResults,
  readerPath,
  scrollJudgeParagraphTo,
  setMainScrollTop,
  waitFrames,
  type BookUnderTest,
  type JudgeReading,
} from "../../support/reader";
import { CLOCK_STEP_MS } from "../../support/settings";
import { step } from "../../support/step";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 7.1：`ch` 之外随 URL 一起打开的参数，分在 `ch` 前后（值含中文、空格与需要编码的 `&`、`=`、`?`）。 */
const EXTRA_BEFORE: [string, string] = ["from", "rdf-7.1"];
const EXTRA_AFTER: [string, string] = ["note", "中 文&=?"];

/** 检索结果的条数上限（EV 9.1）。 */
const RESULT_CAP = 150;

/** EV 10.12 的条件：剩余可滚距离 ≤ 2 px 时按 `Space` 换到下一章。 */
const EDGE_PX = 2;

/** `settle` 在页面内做的 MessageChannel 往返次数。 */
const SETTLE_ROUNDS = 3;

/** 书加载完成后暂停 Controlled_Clock 时向前跳的余量（与 `reader-search.spec.ts` 相同）。 */
const PAUSE_LEAD_MS = 1_000;

// ---------------------------------------------------------------------------
// URL 读数
// ---------------------------------------------------------------------------

/** URL 的一次读数。 */
interface UrlState {
  href: string;
  /** `location.pathname`（百分号编码原样）。 */
  path: string;
  /** 查询参数的条目（解码后的键与值），按先后顺序。 */
  params: [string, string][];
  historyLength: number;
}

function safeDecode(url: string): string {
  try {
    return decodeURI(url);
  } catch {
    return url;
  }
}

function urlStateOf(href: string, historyLength: number): UrlState {
  const url = new URL(href);
  return { href, path: url.pathname, params: [...url.searchParams], historyLength };
}

async function readUrlState(page: Page): Promise<UrlState> {
  const { href, historyLength } = await page.evaluate(() => ({
    href: window.location.href,
    historyLength: window.history.length,
  }));
  return urlStateOf(href, historyLength);
}

function historyLength(page: Page): Promise<number> {
  return page.evaluate(() => window.history.length);
}

function withoutCh(params: readonly [string, string][]): [string, string][] {
  return params.filter(([key]) => key !== "ch");
}

/** `/read/<id>` 带 7.1 的两个额外参数；`ch` 给出时放在两者之间（原样写入，非法值也照写）。 */
function urlWithExtras(bookId: string, ch?: string): string {
  const entries: [string, string][] = ch === undefined ? [EXTRA_BEFORE, EXTRA_AFTER] : [EXTRA_BEFORE, ["ch", ch], EXTRA_AFTER];
  return `${readerPath(bookId)}?${new URLSearchParams(entries).toString()}`;
}

/**
 * 在当前页面打开 `url`（一次完整导航），等本次导航的 `[book-load]` 行与正文 `<h1>`。返回 URL 的基准：
 * 所请求 URL 的路径与参数，`history.length` 取导航前的值加 1（导航本身新增的那条），与写回发生的早晚无关。
 */
async function openUrl(page: Page, bookLog: BookLog, book: BookUnderTest, url: string): Promise<UrlState> {
  const before = await historyLength(page);
  await step(`打开 ${safeDecode(url)}，等正文加载完成`, async () => {
    const since = bookLog.count;
    await page.goto(url);
    await bookLog.waitFor(book.id, undefined, { since, timeout: book.loadTimeout });
    await expect(reader(page).chapterHeading).toBeVisible();
  });
  return urlStateOf(new URL(url, page.url()).href, before + 1);
}

/**
 * 7.1 的断言：8.1 的当前章节为 `index`（含 URL 的 `ch` 写回的等待），URL 恰有一个 `ch` 且为 `String(index)`，
 * 路径与 `ch` 以外的参数（键、值与先后顺序）同 `base`，`history.length` 同 `base`。
 */
async function expectUrlWrittenBack(
  page: Page,
  book: BookUnderTest,
  index: number,
  base: UrlState,
  item: string,
): Promise<void> {
  await expectCurrentChapter(page, book.facts, index);
  await step(
    `RDF 7.1 ${item}：URL 的 ch 为 ${index}，路径与其余查询参数不变，history.length 不变（${base.historyLength}）`,
    async () => {
      const now = await readUrlState(page);
      test.info().annotations.push({
        type: "url-reading",
        description:
          `${item}：基准 ${safeDecode(base.href)}（history.length ${base.historyLength}）→ ` +
          `${safeDecode(now.href)}（history.length ${now.historyLength}）`,
      });
      expect(
        now.params.filter(([key]) => key === "ch").map(([, value]) => value),
        "URL 中 ch 参数的全部取值（十进制、无前导零）",
      ).toEqual([String(index)]);
      expect(now.path, "路径").toBe(base.path);
      expect(withoutCh(now.params), "ch 以外的查询参数（键、值与先后顺序）").toEqual(withoutCh(base.params));
      expect(now.historyLength, "history.length（以替换方式写回，不新增历史记录）").toBe(base.historyLength);
    },
  );
}

// ---------------------------------------------------------------------------
// 共用步骤
// ---------------------------------------------------------------------------

/**
 * 等写回之后的一轮渲染落地：页面内连续 `SETTLE_ROUNDS` 次 MessageChannel 往返（React 的调度经 MessageChannel，
 * 不受 Controlled_Clock 控制；路由状态的更新在 transition 里，于其后的任务中提交），再等 2 个动画帧（时钟已暂停时
 * 改为推进 2 × `CLOCK_STEP_MS`，`waitFrames` 不能与时钟同用）。
 */
async function settle(page: Page, clockPaused: boolean): Promise<void> {
  await step("等写回之后的一轮渲染（MessageChannel 往返与 2 个动画帧）", async () => {
    await page.evaluate(async (rounds) => {
      for (let i = 0; i < rounds; i++) {
        await new Promise<void>((resolve) => {
          const channel = new MessageChannel();
          channel.port1.onmessage = () => {
            channel.port1.close();
            resolve();
          };
          channel.port2.postMessage(null);
        });
      }
    }, SETTLE_ROUNDS);
    if (clockPaused) await page.clock.runFor(2 * CLOCK_STEP_MS);
    else await waitFrames(page);
  });
}

/** `document.activeElement.blur()`，并核对焦点在 `<body>` 上（按键前的前提）。 */
async function blurToBody(page: Page): Promise<void> {
  await step("document.activeElement.blur()，焦点回到 <body>", async () => {
    await page.evaluate(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement) active.blur();
    });
    await expect
      .poll(() => page.evaluate(() => document.activeElement === document.body), { message: "焦点应在 <body> 上" })
      .toBe(true);
  });
}

async function press(page: Page, label: string, key: string): Promise<void> {
  await blurToBody(page);
  await step(`按 ${label}`, () => page.keyboard.press(key));
}

/** 书加载完成后暂停 Controlled_Clock，此后时间只经 `page.clock.runFor` 推进。 */
async function pauseClock(page: Page): Promise<void> {
  await step("暂停 Controlled_Clock（此后只经 runFor 推进）", async () => {
    const now = await page.evaluate(() => Date.now());
    await page.clock.pauseAt(now + PAUSE_LEAD_MS);
  });
}

/** 不超过段落数一半、且能滚到判定线的最大序号；没有时为 0（与 `reader-progress.spec.ts` 相同）。 */
function chooseK(reading: JudgeReading): number {
  for (let k = Math.floor(reading.count / 2); k >= 1; k--) {
    const target = judgeScrollTarget(reading, k);
    if (target >= 0 && target <= reading.maxScrollTop) return k;
  }
  return 0;
}

/** 选定 k（≥ 1）并把判定段落滚到第 k 段。 */
async function scrollToK(page: Page): Promise<number> {
  const k = await step("选定 k：不超过本章段落数一半且能滚到判定线的最大序号（k ≥ 1）", async () => {
    const reading = await readJudgeParagraph(page);
    const picked = chooseK(reading);
    test.info().annotations.push({
      type: "url-plan",
      description: `段落 ${reading.count}、k = ${picked}；<main> 最大可滚距离 ${reading.maxScrollTop}`,
    });
    expect(picked, `应有 1 ≤ k ≤ ⌊${reading.count} / 2⌋ 且能滚到判定线的段落`).toBeGreaterThanOrEqual(1);
    return picked;
  });
  await scrollJudgeParagraphTo(page, k);
  return k;
}

/** 判定段落序号轮询为 `k`（恢复在段落测量后的 layout effect 中执行）。之前核对文档不可滚动（需求 2.1）。 */
async function expectJudgeParagraph(page: Page, k: number, what: string): Promise<JudgeReading> {
  await expectDocumentNotScrollable(page);
  return step(`${what}：判定段落序号为 ${k}`, async () => {
    let last: JudgeReading | null = null;
    try {
      await expect
        .poll(
          async () => {
            last = await readJudgeParagraph(page);
            return last.index;
          },
          { message: `判定段落序号应为 ${k}` },
        )
        .toBe(k);
    } finally {
      const r = last as JudgeReading | null;
      if (r !== null) {
        test.info().annotations.push({
          type: "url-reading",
          description:
            `${what}：判定段落 ${r.index}；<main> scrollTop ${r.scrollTop}（最大 ${r.maxScrollTop}）、` +
            `判定线 ${r.line}、第 ${k} 段上边 ${r.tops[k]}`,
        });
      }
    }
    return readJudgeParagraph(page);
  });
}

/** 写回之后再等一轮渲染：判定段落仍为 `k`，`<main>` 的 `scrollTop` 与 `before` 相同。 */
async function expectStillAtK(page: Page, k: number, before: JudgeReading, what: string, clockPaused: boolean): Promise<void> {
  await settle(page, clockPaused);
  await expectDocumentNotScrollable(page);
  await step(`RDF 7.3 ${what}：再等一轮渲染后判定段落仍为第 ${k} 段，<main> 的 scrollTop 不变（${before.scrollTop}）`, async () => {
    const after = await readJudgeParagraph(page);
    expect({ index: after.index, scrollTop: after.scrollTop }, "判定段落序号与 <main> 的 scrollTop").toEqual({
      index: k,
      scrollTop: before.scrollTop,
    });
  });
}

/** 进度键中的记录；键不存在或不是合法 JSON 时为 null。 */
async function readProgress(page: Page, bookId: string): Promise<Partial<ReadingProgress> | null> {
  const raw = await page.evaluate((key) => window.localStorage.getItem(key), `${PROGRESS_KEY_PREFIX}${bookId}`);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as Partial<ReadingProgress>;
  } catch {
    return null;
  }
}

/** 轮询进度键，直到其中的记录满足 `ok`。 */
async function waitProgress(
  page: Page,
  bookId: string,
  title: string,
  ok: (record: Partial<ReadingProgress>) => boolean,
): Promise<void> {
  await step(title, async () => {
    let last: Partial<ReadingProgress> | null = null;
    try {
      await expect
        .poll(
          async () => {
            last = await readProgress(page, bookId);
            return last !== null && ok(last);
          },
          { message: `进度键 ${PROGRESS_KEY_PREFIX}${bookId}` },
        )
        .toBe(true);
    } finally {
      test.info().annotations.push({
        type: "url-reading",
        description: `${title}：进度键 ${JSON.stringify(last)}`,
      });
    }
  });
}

/**
 * 打开 `?ch=<chapter>`，把判定段落滚到第 k 段，等停止滚动 1 s 后的防抖保存把本章、偏移 > 0 的记录写进进度键。
 * 返回 k。
 */
async function saveProgressAtK(page: Page, bookLog: BookLog, book: BookUnderTest, chapter: number): Promise<number> {
  await openReader(page, bookLog, book, chapter);
  await expectCurrentChapter(page, book.facts, chapter);
  const k = await scrollToK(page);
  await waitProgress(
    page,
    book.id,
    `等进度键写入本章第 ${k} 段处的记录（chapterId ${chapter}、charOffset > 0；停止滚动 1 s 后保存）`,
    (r) => r.chapterId === chapter && typeof r.charOffset === "number" && r.charOffset > 0,
  );
  return k;
}

// ---------------------------------------------------------------------------
// 用书与章节
// ---------------------------------------------------------------------------

interface VolumesPlan {
  book: BookUnderTest;
  run: VolumeRun;
  /** 卷段之前的最后一个正文章节。 */
  before: number;
  /** 卷段之后的第一个正文章节。 */
  after: number;
  /** 末个正文章节。 */
  lastBody: number;
}

async function volumesPlan(lib: Lib): Promise<VolumesPlan> {
  const id = lib.role("volumes");
  const book = await bookUnderTest(lib, id);
  return step("选定卷段：前后都有正文章节、卷节点最多的一个（同数取下标最小者）", () => {
    const { facts } = book;
    let run: VolumeRun | undefined;
    for (const r of facts.volumeRuns) {
      if (r.before === null || r.after === null) continue;
      if (run === undefined || r.last - r.first > run.last - run.first) run = r;
    }
    if (run === undefined || run.before === null || run.after === null) {
      throw new Error(`${id}：没有前后都有正文章节的卷段`);
    }
    const lastBody = facts.bodyIndices[facts.bodyCount - 1];
    if (lastBody === run.before || lastBody === run.after) {
      throw new Error(`${id}：末个正文章节（下标 ${lastBody}）不应是卷段前后的章节`);
    }
    test.info().annotations.push({
      type: "url-plan",
      description:
        `书 ${id}；卷段 下标 ${run.first}–${run.last}；before 下标 ${run.before}「${facts.titles[run.before]}」；` +
        `after 下标 ${run.after}「${facts.titles[run.after]}」；末个正文章节 下标 ${lastBody}`,
    });
    return { book, run, before: run.before, after: run.after, lastBody };
  });
}

interface LongPlan {
  book: BookUnderTest;
  /** 长章（`longText.chapterIndex`）。 */
  chapter: number;
  /** 其后的下一个正文章节。 */
  next: number;
}

async function longPlan(lib: Lib): Promise<LongPlan> {
  const id = lib.role("longText");
  const book = await bookUnderTest(lib, id);
  return step("选定长章（roles.json longText.chapterIndex，其后还有正文章节）", () => {
    const { facts } = book;
    const chapter = lib.fixtureRoles().longText.chapterIndex;
    const ordinal = facts.bodyOrdinals[chapter];
    if (ordinal === null || ordinal === undefined) {
      throw new Error(`${id}：longText.chapterIndex（下标 ${chapter}）不是正文章节`);
    }
    const next = facts.bodyIndices[ordinal + 1];
    if (next === undefined) throw new Error(`${id}：长章（下标 ${chapter}）之后没有正文章节`);
    test.info().annotations.push({
      type: "url-plan",
      description: `书 ${id}；长章 下标 ${chapter}「${facts.titles[chapter]}」；下一个正文章节 下标 ${next}`,
    });
    return { book, chapter, next };
  });
}

/** 一处检索命中。 */
interface Hit {
  /** 全书偏移。 */
  offset: number;
  /** 所在节点的下标；不在任何节点内时为 -1。 */
  chapter: number;
  /** 命中起点位于该节点的标题行（节点范围内第一个换行符之前）。 */
  inTitleLine: boolean;
}

/** 关键词前 `RESULT_CAP` 处命中（即检索抽屉列出的结果，按先后）与全书命中数。 */
async function keywordHits(lib: Lib, id: string, keyword: string): Promise<{ count: number; hits: Hit[] }> {
  const [toc, text] = await Promise.all([lib.toc(id), bookText(lib, id)]);
  const found = findOccurrences(text, keyword, RESULT_CAP);
  const hits = found.offsets.map((offset): Hit => {
    const chapter = toc.chapters.findIndex((c) => c.start <= offset && offset < c.end);
    if (chapter < 0) return { offset, chapter, inTitleLine: false };
    const { start, end } = toc.chapters[chapter];
    const newline = text.text.indexOf("\n", start);
    const titleEnd = newline < 0 || newline >= end ? end : newline;
    return { offset, chapter, inTitleLine: offset <= titleEnd };
  });
  return { count: found.count, hits };
}

/** 在已打开的检索抽屉输入 `keyword`，等结果为 `shown` 条，核对第 `index` 条的章节名后点击它，等抽屉关闭。 */
async function searchAndSelect(page: Page, keyword: string, shown: number, index: number, title: string): Promise<void> {
  const drawer = searchDrawer(page);
  await step(`在检索框输入「${keyword}」，等结果列表为 ${shown} 条`, async () => {
    await drawer.input.fill(keyword);
    await expect(drawer.results).toHaveCount(shown);
  });
  await step(`点击第 ${index + 1} 条结果（命中在「${title}」内），等检索抽屉关闭`, async () => {
    const row = (await readSearchResults(page))[index];
    expect(row?.chapterTitle, "该条结果的章节名").toBe(title);
    await drawer.results.nth(index).click();
    await expect(drawer.marker, "检索抽屉应已关闭").toHaveCount(0);
  });
}

// ---------------------------------------------------------------------------
// RDF 7.1 换章入口
// ---------------------------------------------------------------------------

interface EntryContext {
  page: Page;
  lib: Lib;
  plan: VolumesPlan;
  base: UrlState;
}

interface ChangeEntry {
  /** 标题与步骤名里的写法。 */
  label: string;
  /** 起点章节。 */
  from: (plan: VolumesPlan) => number;
  /** 执行换章，返回目标章节的下标。 */
  act: (ctx: EntryContext) => Promise<number>;
}

const ENTRIES: readonly ChangeEntry[] = [
  {
    label: "→ 键",
    from: (p) => p.before,
    act: async ({ page, plan }) => {
      await press(page, "→", "ArrowRight");
      return plan.after;
    },
  },
  {
    label: "← 键",
    from: (p) => p.after,
    act: async ({ page, plan }) => {
      await press(page, "←", "ArrowLeft");
      return plan.before;
    },
  },
  {
    label: "底栏“下一章 (→)”按钮",
    from: (p) => p.before,
    act: async ({ page, plan }) => {
      await step("点击底栏“下一章 (→)”", () => reader(page).nextChapterButton.click());
      return plan.after;
    },
  },
  {
    label: "底栏“上一章 (←)”按钮",
    from: (p) => p.after,
    act: async ({ page, plan }) => {
      await step("点击底栏“上一章 (←)”", () => reader(page).prevChapterButton.click());
      return plan.before;
    },
  },
  {
    label: "章末导航“下一章”",
    from: (p) => p.before,
    act: async ({ page, plan }) => {
      await step("点击正文章末的“下一章”", () => reader(page).nextChapterEndButton.click());
      return plan.after;
    },
  },
  {
    label: "章末导航“上一章”",
    from: (p) => p.after,
    act: async ({ page, plan }) => {
      await step("点击正文章末的“上一章”", () => reader(page).prevChapterEndButton.click());
      return plan.before;
    },
  },
  {
    label: "章节进度滑杆",
    from: (p) => p.before,
    act: async ({ page, plan }) => {
      const slider = reader(page).chapterSlider;
      const ordinal = plan.book.facts.bodyOrdinals[plan.before];
      await step(`聚焦底栏“章节进度”滑杆（当前值 ${ordinal}），按 End（滑杆移到最大值，即末个正文章节）`, async () => {
        await slider.focus();
        await expect(slider).toBeFocused();
        await expect(slider, "滑杆当前值为起点章节的正文序号").toHaveValue(String(ordinal));
        await page.keyboard.press("End");
      });
      return plan.lastBody;
    },
  },
  {
    label: "目录点击",
    from: (p) => p.before,
    act: async ({ page, plan }) => {
      const title = plan.book.facts.titles[plan.after];
      await openTocDrawer(page);
      await step(`点击目录中的「${title}」，等目录抽屉关闭`, async () => {
        await tocDrawer(page).chapter(title).click();
        await expect(tocDrawer(page).marker, "目录抽屉应已关闭").toHaveCount(0);
      });
      return plan.after;
    },
  },
  {
    label: "书签跳转",
    from: (p) => p.before,
    act: async ({ page, plan, base }) => {
      const view = reader(page);
      const title = plan.book.facts.titles[plan.before];
      await step(`在「${title}」点击顶栏“添加书签”`, async () => {
        await view.addBookmarkButton.click();
        await expect(view.bookmarkButton).toHaveAccessibleName(NAMES.removeBookmark);
      });
      await press(page, "→（换到另一章）", "ArrowRight");
      await expectUrlWrittenBack(page, plan.book, plan.after, base, "书签跳转之前以 → 换章");
      await press(page, "T 打开目录抽屉", "T");
      await step(`切到“我的书签”，点击「${title}」的条目，等目录抽屉关闭`, async () => {
        const drawer = tocDrawer(page);
        await expect(drawer.marker).toBeVisible();
        await drawer.tabBookmarks.click();
        await expect(drawer.bookmarkDeleteButtons, "书签条数").toHaveCount(1);
        const entry = drawer.bookmarkEntry(title);
        await expect(entry, "页面上与该章节名完全相同的文本应只有条目标题一处").toHaveCount(1);
        await entry.click();
        await expect(drawer.marker, "目录抽屉应已关闭").toHaveCount(0);
      });
      return plan.before;
    },
  },
  {
    label: "检索跳转",
    from: (p) => p.before,
    act: async ({ page, lib, plan }) => {
      const { facts, id } = plan.book;
      const keyword = lib.fixtureRoles().volumesKeyword;
      const { count, hits } = await keywordHits(lib, id, keyword);
      // 最后一处位于起点以外的正文章节内的命中（离起点越远，下标与正文序号的差别越可能出现）
      let index = -1;
      hits.forEach((h, i) => {
        if (h.chapter >= 0 && h.chapter !== plan.before && facts.bodyOrdinals[h.chapter] !== null) index = i;
      });
      if (index < 0) throw new Error(`${id}：「${keyword}」在起点章节以外的正文章节里没有命中`);
      const chapter = hits[index].chapter;
      test.info().annotations.push({
        type: "url-plan",
        description: `检索词「${keyword}」K=${count}；点击第 ${index + 1} 条（下标 ${chapter}「${facts.titles[chapter]}」）`,
      });
      await openSearchDrawer(page);
      await searchAndSelect(page, keyword, Math.min(count, RESULT_CAP), index, facts.titles[chapter]);
      return chapter;
    },
  },
  {
    label: "Space（先 End）",
    from: (p) => p.before,
    act: async ({ page, plan }) => {
      await press(page, "End", "End");
      await step(`前提：<main> 的剩余可滚距离 ≤ ${EDGE_PX} px（EV 10.12 的条件）`, async () => {
        await expect
          .poll(
            async () => {
              const m = await readMainScroll(page);
              return m.scrollHeight - m.clientHeight - m.scrollTop;
            },
            { message: "<main> 的剩余可滚距离" },
          )
          .toBeLessThanOrEqual(EDGE_PX);
      });
      await step("按 Space", () => page.keyboard.press("Space"));
      return plan.after;
    },
  },
];

test.describe("RDF 7.1 定位后以替换方式写回 URL 的 ch", () => {
  for (const entry of ENTRIES) {
    test(`RDF 7.1 ${entry.label}换章：URL 的 ch 写回为当前章节的下标（十进制、无前导零），路径与其余查询参数不变，history.length 不变`, async ({
      page,
      lib,
      bookLog,
    }) => {
      const plan = await volumesPlan(lib);
      const from = entry.from(plan);
      const base = await openUrl(page, bookLog, plan.book, urlWithExtras(plan.book.id, String(from)));
      await expectUrlWrittenBack(page, plan.book, from, base, `打开起点章节 ${from}`);
      const to = await entry.act({ page, lib, plan, base });
      await expectUrlWrittenBack(page, plan.book, to, base, `${entry.label}换章到下标 ${to}`);
    });
  }

  test("RDF 7.1 首次定位：ch 无效、缺省、指向卷节点、带前导零时，URL 的 ch 写回为定位到的正文章节下标，路径与其余查询参数不变，history.length 不变", async ({
    page,
    lib,
    bookLog,
  }) => {
    const plan = await volumesPlan(lib);
    const { facts } = plan.book;
    const first = facts.bodyIndices[0];
    // 先无效、后缺省：两者都按已存进度恢复，全新上下文里没有进度，缺省那次的进度是无效那次写下的首个正文章节
    const cases: readonly { label: string; ch: string | undefined; expected: number }[] = [
      { label: "ch=abc（无效）", ch: "abc", expected: first },
      { label: "不带 ch", ch: undefined, expected: first },
      { label: `ch=${plan.run.first}（卷节点）`, ch: String(plan.run.first), expected: plan.after },
      { label: `ch=0${plan.after}（前导零）`, ch: `0${plan.after}`, expected: plan.after },
    ];
    for (const c of cases) {
      const base = await openUrl(page, bookLog, plan.book, urlWithExtras(plan.book.id, c.ch));
      await expectUrlWrittenBack(page, plan.book, c.expected, base, `首次定位（${c.label}）`);
    }
  });
});

// ---------------------------------------------------------------------------
// RDF 7.3 写回不改变 scrollTop、高亮与待恢复的位置
// ---------------------------------------------------------------------------

interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

function boxOf(locator: Locator): Promise<Box> {
  return locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  });
}

/** 需求 3.1 / EV 9.2：高亮元素的边界框位于视口内、顶栏之下、底栏之上（栏移出视口时以视口边代替）。 */
async function expectHighlightInView(page: Page): Promise<void> {
  await step("RDF 7.3（需求 3.1）高亮边界框：左右边在视口内，上边 ≥ 顶栏下边，下边 ≤ 底栏上边", async () => {
    const view = reader(page);
    const viewport = page.viewportSize();
    if (viewport === null) throw new Error("页面没有固定视口");
    const [mark, topBar, bottomBar] = await Promise.all([
      boxOf(readerJumpHighlight(page)),
      boxOf(view.topBar),
      boxOf(view.bottomBar),
    ]);
    const upper = Math.max(0, topBar.bottom);
    const lower = Math.min(viewport.height, bottomBar.top);
    const problems: string[] = [];
    if (mark.left < 0) problems.push(`左边 ${mark.left} < 0`);
    if (mark.right > viewport.width) problems.push(`右边 ${mark.right} > 视口宽 ${viewport.width}`);
    if (mark.top < upper) problems.push(`上边 ${mark.top} < ${upper}（顶栏下边 ${topBar.bottom}）`);
    if (mark.bottom > lower) problems.push(`下边 ${mark.bottom} > ${lower}（底栏上边 ${bottomBar.top}）`);
    expect(problems, `高亮边界框 ${JSON.stringify(mark)} 应位于视口内、顶栏与底栏之间`).toEqual([]);
  });
}

test.describe("RDF 7.3 写回不改变滚动位置、高亮与待恢复的位置", () => {
  test("RDF 7.3 检索跳转：URL 的 ch 写回为命中章节后仍满足需求 3.1（EV 9.2 的全部断言），再等一轮渲染 <main> 的 scrollTop 不变、高亮仍在", async ({
    page,
    lib,
    bookLog,
    clock,
  }) => {
    const plan = await longPlan(lib);
    const { book } = plan;
    const keyword = lib.fixtureRoles().longText.fewKeyword;
    const { count, hits } = await keywordHits(lib, book.id, keyword);
    const index = hits.findIndex((h) => h.chapter === plan.chapter && !h.inTitleLine);
    if (index < 0) throw new Error(`${book.id}：「${keyword}」在长章（下标 ${plan.chapter}）内没有不在标题行内的命中`);
    const from = book.facts.bodyIndices[0];
    if (from === plan.chapter) throw new Error(`${book.id}：长章不应是首个正文章节`);
    const title = book.facts.titles[plan.chapter];
    test.info().annotations.push({
      type: "url-plan",
      description: `检索词「${keyword}」K=${count}；自下标 ${from} 点击第 ${index + 1} 条（全书偏移 ${hits[index].offset}）`,
    });

    await clock.install();
    await openReader(page, bookLog, book, from);
    await expectCurrentChapter(page, book.facts, from);
    await pauseClock(page);
    await openSearchDrawer(page);
    await searchAndSelect(page, keyword, Math.min(count, RESULT_CAP), index, title);

    await expectCurrentChapter(page, book.facts, plan.chapter);
    await settle(page, true);
    await step("RDF 7.3（需求 3.1）正文区 <h1> 等于结果项的章节名，正文区恰有 1 个高亮且其文本与关键词相同（不区分大小写）", async () => {
      await expect(reader(page).chapterHeading).toHaveText(title);
      const mark = readerJumpHighlight(page);
      await expect(mark, "正文区应恰有 1 个高亮元素").toHaveCount(1);
      expect(((await mark.textContent()) ?? "").toLowerCase(), "高亮文本").toBe(keyword.toLowerCase());
    });
    await expectDocumentNotScrollable(page);
    await expectHighlightInView(page);
    const atWriteBack = await readMainScroll(page);

    await settle(page, true);
    await expectDocumentNotScrollable(page);
    await step(`RDF 7.3 再等一轮渲染：<main> 的 scrollTop 不变（${atWriteBack.scrollTop}），高亮仍在，URL 的 ch 仍为 ${plan.chapter}`, async () => {
      expect((await readMainScroll(page)).scrollTop, "<main> 的 scrollTop").toBe(atWriteBack.scrollTop);
      await expect(readerJumpHighlight(page), "正文区应仍恰有 1 个高亮元素").toHaveCount(1);
      expect(new URL(page.url()).searchParams.getAll("ch"), "URL 的 ch").toEqual([String(plan.chapter)]);
    });
    await expectHighlightInView(page);
  });

  test("RDF 7.3 书签跳转：在另一章点击第 k 段处的书签，URL 的 ch 写回为书签章节后判定段落为 k（需求 3.3），再等一轮渲染仍为 k、<main> 的 scrollTop 不变", async ({
    page,
    lib,
    bookLog,
  }) => {
    const plan = await longPlan(lib);
    const { book, chapter } = plan;
    const title = book.facts.titles[chapter];
    await openReader(page, bookLog, book, chapter);
    await expectCurrentChapter(page, book.facts, chapter);
    const k = await scrollToK(page);
    await step("等 2 个动画帧（应用在 rAF 里算出滚动后的章内偏移）后点击顶栏“添加书签”", async () => {
      await waitFrames(page);
      const view = reader(page);
      await view.addBookmarkButton.click();
      await expect(view.bookmarkButton).toHaveAccessibleName(NAMES.removeBookmark);
    });

    await press(page, "→（换到另一章）", "ArrowRight");
    await expectCurrentChapter(page, book.facts, plan.next);
    await press(page, "T 打开目录抽屉", "T");
    await step(`切到“我的书签”，点击「${title}」的条目，等目录抽屉关闭`, async () => {
      const drawer = tocDrawer(page);
      await expect(drawer.marker).toBeVisible();
      await drawer.tabBookmarks.click();
      const entry = drawer.bookmarkEntry(title);
      await expect(entry, "页面上与该章节名完全相同的文本应只有条目标题一处").toHaveCount(1);
      await entry.click();
      await expect(drawer.marker, "目录抽屉应已关闭").toHaveCount(0);
    });

    await expectCurrentChapter(page, book.facts, chapter);
    await settle(page, false);
    const reading = await expectJudgeParagraph(page, k, "RDF 7.3（需求 3.3）书签跳转、URL 写回之后");
    await expectStillAtK(page, k, reading, "书签跳转", false);
  });

  test("RDF 7.3 首次定位：进度写入后以不带 ?ch= 的 /read/<id> 重新打开，URL 的 ch 写回为进度章节后判定段落为 k（需求 3.5），再等一轮渲染仍为 k、<main> 的 scrollTop 不变", async ({
    page,
    lib,
    bookLog,
  }) => {
    const plan = await longPlan(lib);
    const { book, chapter } = plan;
    const k = await saveProgressAtK(page, bookLog, book, chapter);
    await openReader(page, bookLog, book);
    await expectCurrentChapter(page, book.facts, chapter);
    await settle(page, false);
    const reading = await expectJudgeParagraph(page, k, "RDF 7.3（需求 3.5）首次定位、URL 写回之后");
    await expectStillAtK(page, k, reading, "首次定位", false);
  });
});

// ---------------------------------------------------------------------------
// RDF 7.4 换章后重新载入
// ---------------------------------------------------------------------------

test.describe("RDF 7.4 换章后重新载入", () => {
  test("RDF 7.4 以 ?ch=<n> 进入、在阅读器内换章后重新载入：显示重载前的当前章节，进度键的章号仍为该章节（不被改写为 n）", async ({
    page,
    lib,
    bookLog,
  }) => {
    const plan = await volumesPlan(lib);
    const { book, before, after } = plan;
    await openReader(page, bookLog, book, before);
    await expectCurrentChapter(page, book.facts, before);
    await press(page, "→", "ArrowRight");
    await expectCurrentChapter(page, book.facts, after);
    await waitProgress(page, book.id, `前提：进度键的章号为换章后的 ${after}`, (r) => r.chapterId === after);

    await step("重新载入页面（page.reload），等正文加载完成", async () => {
      const since = bookLog.count;
      await page.reload();
      await bookLog.waitFor(book.id, undefined, { since, timeout: book.loadTimeout });
      await expect(reader(page).chapterHeading).toBeVisible();
    });
    await expectCurrentChapter(page, book.facts, after);
    await settle(page, false);
    await step(`RDF 7.4 进度键的章号仍为 ${after}（不是进入时的 ${before}）`, async () => {
      const record = await readProgress(page, book.id);
      test.info().annotations.push({ type: "url-reading", description: `重新载入后进度键：${JSON.stringify(record)}` });
      expect(record?.chapterId, "进度记录的 chapterId").toBe(after);
    });
  });
});

// ---------------------------------------------------------------------------
// RDF 7.5 ?ch= 指向已存进度的章节
// ---------------------------------------------------------------------------

test.describe("RDF 7.5 ?ch= 指向已存进度的章节时恢复章内偏移", () => {
  test("RDF 7.5 进度写入后以 ?ch=<进度章节> 打开：判定段落序号等于保存时的 k", async ({ page, lib, bookLog }) => {
    const plan = await longPlan(lib);
    const { book, chapter } = plan;
    const k = await saveProgressAtK(page, bookLog, book, chapter);
    // 经 page.goto 再次打开同一 URL。<main> 是内层容器，不受浏览器的滚动还原影响，判定段落只取决于应用的恢复
    await openReader(page, bookLog, book, chapter);
    await expectCurrentChapter(page, book.facts, chapter);
    await expectJudgeParagraph(page, k, `RDF 7.5 ?ch=${chapter}`);
  });

  test("RDF 7.5 进度写入后以 ?ch=<其前的卷节点> 打开（经卷节点归一后即进度章节）：判定段落序号等于保存时的 k，URL 的 ch 写回为进度章节", async ({
    page,
    lib,
    bookLog,
  }) => {
    const plan = await volumesPlan(lib);
    const { book, run, after } = plan;
    const k = await saveProgressAtK(page, bookLog, book, after);
    await openReader(page, bookLog, book, run.last);
    await expectCurrentChapter(page, book.facts, after);
    await expectJudgeParagraph(page, k, `RDF 7.5 ?ch=${run.last}（卷节点）→ 下标 ${after}`);
  });
});

// ---------------------------------------------------------------------------
// RDF 7.8 浏览器后退回到进入前的页面
// ---------------------------------------------------------------------------

test.describe("RDF 7.8 浏览器后退", () => {
  test("RDF 7.8 从书架经书卡进入阅读器、在阅读器内换章 3 次后执行一次浏览器后退：回到书架，URL 与进入阅读器之前相同", async ({
    page,
    lib,
    bookLog,
  }) => {
    const catalog = await lib.books();
    const batch = catalog.books.slice(0, Math.min(PAGE_SIZE, catalog.books.length));
    let index = -1;
    for (let i = 0; i < batch.length && index < 0; i++) {
      if ((await lib.tocFacts(batch[i].id)).bodyCount >= 3) index = i;
    }
    if (index < 0) throw new Error("首批书卡中没有至少 3 个正文章节的书");
    const summary = batch[index];
    const book = await bookUnderTest(lib, summary.id);
    const body = book.facts.bodyIndices;
    test.info().annotations.push({
      type: "url-plan",
      description: `首批书卡的第 ${index + 1} 张：《${summary.title}》（${summary.id}），正文章节 ${book.facts.bodyCount} 个`,
    });

    await step("打开书架，等首批书卡挂载", async () => {
      await page.goto("/");
      await expect(shelf(page).cardTitles).toHaveText(batch.map((b) => b.title));
    });
    const shelfUrl = page.url();
    const card = shelf(page).card(index);
    await step(`点击第 ${index + 1} 张书卡《${summary.title}》的“开始阅读”（应用内导航），等正文加载完成`, async () => {
      await expect(card.title).toHaveText(summary.title);
      const since = bookLog.count;
      await card.readButton.click();
      await bookLog.waitFor(book.id, undefined, { since, timeout: book.loadTimeout });
      await expect(reader(page).chapterHeading).toBeVisible();
    });
    await expectCurrentChapter(page, book.facts, body[0]);
    const entered = await historyLength(page);

    const moves: readonly { label: string; key: string; to: number }[] = [
      { label: "→", key: "ArrowRight", to: body[1] },
      { label: "→", key: "ArrowRight", to: body[2] },
      { label: "←", key: "ArrowLeft", to: body[1] },
    ];
    for (const move of moves) {
      await press(page, move.label, move.key);
      await expectCurrentChapter(page, book.facts, move.to);
    }
    await step(`换章 ${moves.length} 次后 history.length 不变（${entered}）`, async () => {
      expect(await historyLength(page), "history.length").toBe(entered);
    });

    await step("浏览器后退一次", () => page.goBack());
    await step(`RDF 7.8 回到书架：URL 与进入阅读器之前相同（${safeDecode(shelfUrl)}），书架检索框可见`, async () => {
      await expect(page, "后退后的 URL").toHaveURL(shelfUrl);
      await expect(shelf(page).searchBox).toBeVisible();
    });
  });
});

// ---------------------------------------------------------------------------
// RDF 7.9 应用内导航改 ch
// ---------------------------------------------------------------------------

/** `history.pushState` 把 URL 的 `ch` 改为 `ch`（其余不变）并派发 `popstate`（React Router 据此读新位置）。 */
async function pushChapter(page: Page, ch: number): Promise<void> {
  await step(`history.pushState 把 URL 的 ch 改为 ${ch} 并派发 popstate（模拟应用内导航）`, async () => {
    await page.evaluate((value) => {
      const params = new URLSearchParams(window.location.search);
      params.set("ch", value);
      window.history.pushState(window.history.state, "", `${window.location.pathname}?${params.toString()}`);
      window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
    }, String(ch));
  });
}

/** 打开长章，把 `<main>` 滚到章中（`scrollTop` 设为 `clientHeight`），返回 `history.length` 与滚动读数。 */
async function openLongMiddle(page: Page, bookLog: BookLog, plan: LongPlan): Promise<{ history: number; scrollTop: number }> {
  await openReader(page, bookLog, plan.book, plan.chapter);
  await expectCurrentChapter(page, plan.book.facts, plan.chapter);
  return step("把正文滚到章中（<main> 的 scrollTop 设为其 clientHeight）", async () => {
    await expectDocumentNotScrollable(page);
    await setMainScrollTop(page, (await readMainScroll(page)).clientHeight);
    await waitFrames(page);
    const main = await readMainScroll(page);
    expect(main.scrollTop, "<main> 的 scrollTop 应 > 0（章中）").toBeGreaterThan(0);
    return { history: await historyLength(page), scrollTop: main.scrollTop };
  });
}

test.describe("RDF 7.9 应用内导航改 URL 的 ch", () => {
  test("RDF 7.9 pushState + popstate 把 ch 改为另一个有效下标：跳转到该章节，显示章首（<main> 的 scrollTop 为 0），history.length 只多出 pushState 那 1 条", async ({
    page,
    lib,
    bookLog,
  }) => {
    const plan = await longPlan(lib);
    const start = await openLongMiddle(page, bookLog, plan);
    await pushChapter(page, plan.next);
    await expectCurrentChapter(page, plan.book.facts, plan.next);
    await settle(page, false);
    await expectDocumentNotScrollable(page);
    await step("RDF 7.9 显示章首：<main> 的 scrollTop 为 0；history.length 为 pushState 之前加 1", async () => {
      expect((await readMainScroll(page)).scrollTop, "<main> 的 scrollTop").toBe(0);
      expect(await historyLength(page), "history.length").toBe(start.history + 1);
    });
  });

  test("RDF 7.9 pushState + popstate 把 ch 改为当前章节的下标：章节、<main> 的 scrollTop 与 URL 的 ch 都不变", async ({
    page,
    lib,
    bookLog,
  }) => {
    const plan = await longPlan(lib);
    const start = await openLongMiddle(page, bookLog, plan);
    await pushChapter(page, plan.chapter);
    await settle(page, false);
    await expectCurrentChapter(page, plan.book.facts, plan.chapter);
    await expectDocumentNotScrollable(page);
    await step(`RDF 7.9 位置不变：<main> 的 scrollTop 仍为 ${start.scrollTop}；history.length 为 pushState 之前加 1`, async () => {
      expect((await readMainScroll(page)).scrollTop, "<main> 的 scrollTop").toBe(start.scrollTop);
      expect(await historyLength(page), "history.length").toBe(start.history + 1);
    });
  });
});
