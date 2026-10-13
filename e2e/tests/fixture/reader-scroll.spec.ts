/**
 * 阅读器：正文滚动容器（reader-defect-fixes 需求 2.1–2.3、4.2、4.3；Findings_Log F-002，已修复
 * （reader-defect-fixes））。`fixture` 项目（:4611，Opaque_Mode），默认主题（不 `seedTheme`），不装
 * Controlled_Clock（按键闸门与翻页滚动按真实时间走）。用例标题以 `RDF <需求编号>` 开头（设计 S10）。
 *
 * 翻页模式（reader-page-turn-modes，任务 21.5）之后，默认模式是滚动（`pageAnim` 3）：`<main>` 里首尾相接地
 * 挂着当前章前后的若干章（翻页模式需求 10.1、10.2），`Space`/`PageDown` 与 `Shift+Space`/`PageUp` 是保留一行
 * 的翻页滚动（需求 10.10、10.11、11.11、11.12），跨章靠连续滚动，不再"章末按 Space 换章"。下文的"章首""章末"
 * 一律以当前章区段（`section[data-chapter-id][data-current="true"]`）为界，不是 `<main>` 的两端。
 *
 * ## Body_Scroller 与文档滚动元素
 *
 * Body_Scroller 是阅读器正文的 `main` 地标（`reader(page).main`，需求 Glossary、D1）；文档滚动元素为
 * `document.scrollingElement`。读数与赋值经 `e2e/support/reader.ts` 的 `readChapterScroll`、`readMainScroll`、
 * `setMainScrollTop`、`readDocumentScroll`；2.1 的"文档滚动元素的最大可滚距离 ≤ 1 px"即
 * `expectDocumentNotScrollable`，每次滚动断言前都先核对它（需求 14.2）。
 *
 * - **章首**：区段顶边对齐 `<main>` 顶边时的 `scrollTop`（`readChapterScroll().chapterStart`，翻页模式 design §3.1）。
 *   经 `?ch=` 打开一章即定位于此；上方挂着前一章时它大于 0（需求 10.7）。
 * - **章末**：区段底边贴住 `<main>` 底边时的 `scrollTop`（`chapterEnd`，design §7.6 的 `chapterEdgeScrollTop`）。
 * - **本章可滚距离**：`chapterEnd − chapterStart`，即旧版单章容器的"最大可滚距离"。
 * - **全书两端**：只有窗口首章是全书首个正文章节时 `scrollTop = 0` 才是尽头，只有窗口末章是全书末个正文章节
 *   时 `<main>` 的最大可滚距离才是尽头；别处的容器两端会随章节窗口挂上新章而移走，不能作为"到边"的起始状态。
 *
 * ## 用书与章节（4.4：期望值运行时推导）
 *
 * - 长章：`lib.role("longText")` 的 `roles.json longText.chapterIndex`（夹具的长章节，正文高度为数屏），须既非
 *   首个也非末个正文章节（上下都挂着相邻章）。2.1 的"长章"与 2.2、4.2、4.3 都用它。
 * - 短章：`lib.role("huge")`（章节最多的夹具书，每章只有几行）中 `_toc.json` 的 `length` 最小的正文章节
 *   （同长取下标最小者），是夹具书库中最短的正文章节。2.1 的"与章节长度无关"由它与长章两端覆盖。桌面
 *   视口下核对前提：本章可滚距离 ≤ 1 px（正文不足一屏）。移动视口下这一章也只略高于一屏（见注解），作为
 *   同一书库里最短的一章照常断言。
 * - 全书首末章：长章所在书的首个与末个正文章节，4.3 "到边不动"的两个起始状态（见上文"全书两端"）。
 * - 2.3：`books.json` 首批书卡中的最后一张（第 min(PAGE_SIZE, N) 张）所对应的书，经书卡"开始阅读"进入。
 *
 * 前提不成立是测试自身的问题（16.6），用例普通失败。所选的书、章节与读数记在注解 `scroll-plan`、
 * `scroll-reading` 里。
 *
 * ## 翻页键：按键闸门与保留一行
 *
 * - **闸门**（翻页模式需求 11.5–11.7）：同方向两次翻页键间隔不足 600 ms、或上一次翻页滚动的动画（按键
 *   Turn_Duration ≤ 100 ms，需求 10.12）还在走时，按键被忽略。翻页键之前先按页面时钟等到距上一次同方向
 *   翻页键满 `KEY_TURN_GAP_MS`（记录取自按键之后，偏保守），按下后等满 `TURN_BASE_MS.key` 再等 `<main>` 的
 *   `scrollTop` 稳定。这两段等待是需求规定的时间量，不是凑出来的固定时长；行滚动键（`↑`/`↓`）与
 *   `Home`/`End` 不过闸门、没有动画，照旧只等 2 个动画帧。
 * - **保留一行**（需求 10.10、10.11）：按键前在页面里量出可见区（Visible_Area：`<main>` 的可视矩形减去与它
 *   交叠的顶栏、底栏）与 `<main>` 里与可见区相交的全部行（段落经 `Range.getClientRects()` 取字形矩形，纵向
 *   重叠过半的并为一行；章节标题区整块当作一行，design §7.6），NEXT 取其中最后一行、PREV 取第一行（含部分
 *   可见行），记下这一行所在的元素与行号；翻页后重测同一行，断言 NEXT 时它的上边与可见区顶边、PREV 时它的
 *   下边与可见区底边相差 ≤ `LINE_PX`，且它在屏幕上的位移 > 0、不超过可见区高度。比较的是屏幕坐标：跨章时
 *   章节窗口挂卸上方的章，锚点补偿会改写 `scrollTop` 而保持屏幕位置（需求 10.3），所以跨章的翻页不按
 *   `scrollTop` 的增减判断方向。这一段测量是只读的 DOM 遍历，不用于定位要操作的元素（D8）。
 *
 * ## 各条的做法
 *
 * - 2.1：桌面 1280×800 与移动 390×844 × 短章 / 长章，共 4 个用例。打开该章后读 `<main>` 的 `clientHeight`、
 *   边界框与 `innerHeight`，断言相差均 ≤ 1 px，并核对文档不可滚动；本章可滚时再把 `<main>` 滚到章末重读
 *   一次（"WHILE 显示正文章节"在章内任何位置都成立）。
 * - 2.2（桌面，长章）：
 *   - 最大可滚距离：`<main>` 的 `scrollHeight − clientHeight` 与"正文超出可视高度的部分"相差 ≤ 1 px 且 > 0。
 *     "正文高度"取 `<main>` 内容的实际高度：自 `<main>` 内边距边上沿（`scrollTop` 为 0 处）到最后一个子元素
 *     （窗口末章的区段）边界框下边的距离，加上 `<main>` 的下内边距；可视高度为 `clientHeight`。
 *   - 滚轮：自章首，鼠标移到 `<main>` 边界框中心，`mouse.wheel` 向下再向上各一次，等 `scrollTop` 稳定。
 *   - 赋值：依次把 `<main>` 的 `scrollTop` 设为章首 + `clientHeight`、章末与章首（都在本章区段内）。
 *   - 按键：自章中依次按 `↓`、`↑`、`PageDown`、`PageUp`、`Space`、`Shift+Space`、`End`、`Home`。翻页键另断言
 *     保留一行；`End`/`Home` 另断言到了本章区段的章末 / 章首（翻页模式需求 11.13）。
 *   每次滚动后断言 `<main>` 的 `scrollTop` 按预期方向改变、文档滚动元素的 `scrollTop` 为 0，章节不变。
 * - 2.3（桌面）：打开书架，把最后一张首批书卡的"开始阅读"按钮滚入视口（核对文档 `scrollTop` > 0），在页面上
 *   留一个标记后点击它；等 `[book-load]` 行与正文 `<h1>`，核对标记仍在（应用内导航，没有整页载入）与路径为
 *   `/read/<id>`，再读一次文档滚动元素的 `scrollTop`，断言为 0，并核对文档不可滚动。
 * - 4.2（桌面，长章；翻页模式需求 10.10、11.11 取代"Space 只在章末换章"）：(a) 自章首连按 `Space`：每次保留
 *   一行；判定线留在本章时章节不变，读完本章后当前章变为下一个正文章节（连续滚入，不经跳转）。(b) 自章末
 *   按 `Space` 直到当前章变为下一个正文章节，再按 `Shift+Space` 直到回到本章：每次保留一行（需求 10.7 的
 *   "向上滚动时可连续读到前一章正文"、11.12）。
 * - 4.3（桌面）：`↓`、`PageDown`、`↑`、`PageUp` 各 4 个用例：
 *   - 焦点在 `<body>`、正文在长章章中（EV 需求 10 前言的起始状态 (a)，以章首为原点）：`scrollTop` 增大 / 减小，
 *     翻页键保留一行，章节不变；
 *   - 焦点在 `<body>`、正文在长章章末 / 章首（下方 / 上方挂着相邻章）：不停在章界。`↓`/`↑` 的 `scrollTop`
 *     增大 / 减小、章节不变；`PageDown` 保留一行、下一个正文章节的标题进入可见区；`PageUp` 保留一行、当前章
 *     变为前一个正文章节（需求 10.7：经 `?ch=` 打开即在区段顶边，上方挂着前一章）；
 *   - 焦点在 `<body>`、`<main>` 在全书末尾 / 开头（见上文"全书两端"）：`scrollTop` 不变，章节不变；
 *   - 焦点在 `<main>` 上（非输入类元素，见 `focusInsideMain`）、正文在长章章中：同第一种。
 *
 * "章节不变"与 `reader-shortcuts.spec.ts` 相同：当前章区段的章号、URL 的 `ch` 与 8.1 所判定的当前章节
 * （正文 `<h1>` 与"第 N / M 章"的文本）都与按键前相同。"三个抽屉均关闭"以三个打开标志的计数为 0 核对。
 */
import type { Page } from "@playwright/test";
import type { TurnDirection } from "../../../src/components/reader/types";
import type { BooksCatalog } from "../../../src/types";
import { PAGE_SIZE } from "../../../src/utils/pagination";
import { KEY_TURN_GAP_MS } from "../../../src/utils/turnInput";
import { TURN_BASE_MS } from "../../../src/utils/turnMotion";
import { expect, test, type BookLog, type Lib } from "../../support/fixtures";
import { overlayMarkers, reader, shelf } from "../../support/locators";
import {
  bookUnderTest,
  expectCurrentChapter,
  expectDocumentNotScrollable,
  openReader,
  readChapterScroll,
  readDocumentScroll,
  readMainScroll,
  readerPath,
  setMainScrollTop,
  waitFrames,
  type BookUnderTest,
  type ChapterScroll,
  type MainScroll,
} from "../../support/reader";
import { VIEWPORTS } from "../../support/settings";
import { step } from "../../support/step";

// ---------------------------------------------------------------------------
// 常量（取自需求条文）
// ---------------------------------------------------------------------------

/** 2.1 / 2.2：几何量的容差（px）。 */
const FIT_PX = 1;

/** EV 需求 10 前言：章中起始状态离本章两端的最小距离（px）；与应用的到边阈值 `EDGE_EPSILON_PX` 同值。 */
const EDGE_PX = 2;

/** 起始状态的前提：本章（全书两端时为整个 `<main>`）的可滚距离不少于 `clientHeight` 的倍数。 */
const START_SCREENS = 2;

/** 保留一行的容差（px）：行盒带小数，`scrollTop` 由浏览器取整。 */
const LINE_PX = 2;

/** 2.2：滚轮一次的纵向滚动量（px）。 */
const WHEEL_DELTA_PX = 400;

/** 等 `<main>` 的 `scrollTop` 稳定：每次等 2 帧，最多这么多次。 */
const SETTLE_MAX_ROUNDS = 60;

/** 同方向两次翻页键之间，在 `KEY_TURN_GAP_MS` 之外多等的余量（ms）。 */
const KEY_GAP_MARGIN_MS = 50;

/** 按键翻页滚动的动画（≤ `TURN_BASE_MS.key`）之外多等的余量（ms）。 */
const TURN_SETTLE_MARGIN_MS = 50;

/** 4.2 (b)：越过一道章界最多按几次翻页键（一次翻页滚动的位移接近可见区高度，2 次即可）。 */
const CROSS_MAX_PRESSES = 4;

/** 2.3：点击书卡前写在页面上的标记（应用内导航不会清掉它，整页载入会）。 */
const IN_APP_NAV_FLAG = "__e2eRdfInAppNavigation";

/** 页面上记录"上一次翻页键按下之后的 `performance.now()`"（按方向）的属性名。整页载入即清空，与应用的闸门同寿。 */
const TURN_KEY_FLAG = "__e2eRdfTurnKeyAt";

/** 页面上记录"翻页前选中的那一行"（元素与行号）的属性名。 */
const TURN_LINE_FLAG = "__e2eRdfTurnLine";

// ---------------------------------------------------------------------------
// 用书与章节
// ---------------------------------------------------------------------------

interface ChapterPlan {
  book: BookUnderTest;
  /** 打开的章节下标。 */
  chapter: number;
  /** 其前的上一个正文章节下标（没有时为 null）。 */
  prev: number | null;
  /** 其后的下一个正文章节下标（没有时为 null）。 */
  next: number | null;
}

/** `chapter` 的前后正文章节。 */
function neighboursOf(book: BookUnderTest, chapter: number): ChapterPlan {
  const ordinal = book.facts.bodyOrdinals[chapter];
  if (ordinal === null || ordinal === undefined) {
    throw new Error(`${book.id}：下标 ${chapter} 不是正文章节`);
  }
  return {
    book,
    chapter,
    prev: book.facts.bodyIndices[ordinal - 1] ?? null,
    next: book.facts.bodyIndices[ordinal + 1] ?? null,
  };
}

/** 长章：`roles.json longText.chapterIndex`，须既非首个也非末个正文章节。 */
async function longChapterPlan(lib: Lib): Promise<ChapterPlan> {
  const id = lib.role("longText");
  const book = await bookUnderTest(lib, id);
  return step("选定长章（roles.json longText.chapterIndex，既非首也非末的正文章节）", () => {
    const { facts } = book;
    const plan = neighboursOf(book, lib.fixtureRoles().longText.chapterIndex);
    const { chapter, prev, next } = plan;
    if (prev === null || next === null) {
      const ordinal = facts.bodyOrdinals[chapter] ?? 0;
      throw new Error(`${id}：长章（下标 ${chapter}，正文第 ${ordinal + 1} / ${facts.bodyCount} 章）须既非首个也非末个`);
    }
    test.info().annotations.push({
      type: "scroll-plan",
      description:
        `长章：书 ${id} 下标 ${chapter}「${facts.titles[chapter]}」；上一个正文章节 下标 ${prev}「${facts.titles[prev]}」；` +
        `下一个正文章节 下标 ${next}「${facts.titles[next]}」`,
    });
    return plan;
  });
}

/** 短章：`huge` 书中 `length` 最小的正文章节（同长取下标最小者）。 */
async function shortChapterPlan(lib: Lib): Promise<ChapterPlan> {
  const id = lib.role("huge");
  const book = await bookUnderTest(lib, id);
  const toc = await lib.toc(id);
  return step("选定短章（huge 书中 _toc.json length 最小的正文章节）", () => {
    const { facts } = book;
    // `<`：同长时保留下标较小的
    const chapter = facts.bodyIndices.reduce(
      (best, i) => (toc.chapters[i].length < toc.chapters[best].length ? i : best),
      facts.bodyIndices[0],
    );
    test.info().annotations.push({
      type: "scroll-plan",
      description: `短章：书 ${id} 下标 ${chapter}「${facts.titles[chapter]}」（${toc.chapters[chapter].length} 字）`,
    });
    return neighboursOf(book, chapter);
  });
}

/** 全书首个 / 末个正文章节（长章所在的书）：4.3 "到边不动"的起始章。 */
async function bookEdgePlan(lib: Lib, edge: "first" | "last"): Promise<ChapterPlan> {
  const id = lib.role("longText");
  const book = await bookUnderTest(lib, id);
  const which = edge === "first" ? "首" : "末";
  return step(`选定全书${which}个正文章节（长章所在的书）`, () => {
    const { facts } = book;
    if (facts.bodyCount < 2) throw new Error(`${id}：正文章节不足 2 个（${facts.bodyCount}）`);
    const chapter = facts.bodyIndices[edge === "first" ? 0 : facts.bodyCount - 1];
    test.info().annotations.push({
      type: "scroll-plan",
      description: `全书${which}个正文章节：书 ${id} 下标 ${chapter}「${facts.titles[chapter]}」`,
    });
    return neighboursOf(book, chapter);
  });
}

// ---------------------------------------------------------------------------
// 读数
// ---------------------------------------------------------------------------

/** 一次读数：URL 的 `ch`、8.1 的当前章节、以当前章区段为界的滚动几何与文档滚动元素的 `scrollTop`。 */
interface ScrollSnapshot {
  /** URL 的 `ch` 查询参数；没有时为 null。 */
  ch: string | null;
  /** 正文 `<h1>` 的文本（8.1）。 */
  heading: string;
  /** "第 N / M 章"的文本（8.1）。 */
  position: string;
  /** `<main>` 的滚动位置，及当前章区段的章号、章首、章末（`readChapterScroll`）。 */
  main: ChapterScroll;
  /** 文档滚动元素的 `scrollTop`。 */
  documentTop: number;
}

function urlCh(page: Page): Promise<string | null> {
  return page.evaluate(() => new URLSearchParams(window.location.search).get("ch"));
}

async function readSnapshot(page: Page): Promise<ScrollSnapshot> {
  const view = reader(page);
  const [ch, heading, position, main, doc] = await Promise.all([
    urlCh(page),
    view.chapterHeading.textContent(),
    view.chapterPosition.textContent(),
    readChapterScroll(page),
    readDocumentScroll(page),
  ]);
  return {
    ch,
    heading: (heading ?? "").trim(),
    position: (position ?? "").trim(),
    main,
    documentTop: doc.scrollTop,
  };
}

/** `<main>` 的最大可滚距离（整个容器）。 */
function maxOf(m: MainScroll): number {
  return m.scrollHeight - m.clientHeight;
}

/** 本章可滚距离：章末 − 章首。 */
function spanOf(c: ChapterScroll): number {
  return c.chapterEnd - c.chapterStart;
}

/** 注解与消息里的像素值：整数原样，小数保留 1 位。 */
function px(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function describeScroll(c: ChapterScroll): string {
  return (
    `scrollTop ${px(c.scrollTop)}、clientHeight ${c.clientHeight}、scrollHeight ${c.scrollHeight}；` +
    `当前章区段 下标 ${c.chapterId}，章首 ${px(c.chapterStart)}、章末 ${px(c.chapterEnd)}`
  );
}

function describeSnapshot(s: ScrollSnapshot): string {
  return `ch=${s.ch ?? "（无）"}「${s.heading}」${s.position}；<main> ${describeScroll(s.main)}；文档 scrollTop ${s.documentTop}`;
}

function noteReading(label: string, before: ScrollSnapshot, after: ScrollSnapshot): void {
  test.info().annotations.push({
    type: "scroll-reading",
    description: `${label}：之前 ${describeSnapshot(before)} → 之后 ${describeSnapshot(after)}`,
  });
}

/** 等 `<main>` 的 `scrollTop` 连续两次读数（间隔 2 帧）相同后返回读数（滚轮与翻页滚动都带动画）。 */
async function readSettled(page: Page): Promise<ScrollSnapshot> {
  let previous = await readSnapshot(page);
  for (let round = 0; round < SETTLE_MAX_ROUNDS; round++) {
    await waitFrames(page);
    const current = await readSnapshot(page);
    if (current.main.scrollTop === previous.main.scrollTop) return current;
    previous = current;
  }
  throw new Error(`<main> 的 scrollTop 在 ${SETTLE_MAX_ROUNDS} × 2 帧内未稳定（最后 ${previous.main.scrollTop}）`);
}

// ---------------------------------------------------------------------------
// 断言
// ---------------------------------------------------------------------------

/** "章节不变"比较的内容：当前章区段的章号、URL 的 `ch` 与 8.1 的当前章节。 */
function chapterOf(s: ScrollSnapshot): { chapterId: number; ch: string | null; heading: string; position: string } {
  return { chapterId: s.main.chapterId, ch: s.ch, heading: s.heading, position: s.position };
}

async function expectSameChapter(after: ScrollSnapshot, before: ScrollSnapshot, item: string): Promise<void> {
  await step(`${item} 章节不变（当前章区段、URL 的 ch 与正文 <h1>、“第 N / M 章”）`, () => {
    expect(chapterOf(after), "当前章区段、URL 的 ch 与当前章节").toEqual(chapterOf(before));
  });
}

type Motion = "down" | "up" | "none";

const MOTION_LABELS: Readonly<Record<Motion, string>> = {
  down: "增大",
  up: "减小",
  none: "不变",
};

/**
 * 2.2：只有 `<main>` 滚动。先核对文档不可滚动（2.1），再断言文档滚动元素的 `scrollTop` 为 0、`<main>` 的
 * `scrollTop` 相对 `before` 按 `motion` 改变。只用于章节窗口不变（判定线留在同一章）的移动。
 */
async function expectMainMoved(
  page: Page,
  after: ScrollSnapshot,
  before: ScrollSnapshot,
  motion: Motion,
  item: string,
): Promise<void> {
  await expectDocumentNotScrollable(page);
  await step(`${item} <main> 的 scrollTop ${MOTION_LABELS[motion]}（${px(before.main.scrollTop)} → ${px(after.main.scrollTop)}），文档滚动元素的 scrollTop 为 0`, () => {
    expect(after.documentTop, "文档滚动元素的 scrollTop").toBe(0);
    const scrollTop = after.main.scrollTop;
    if (motion === "down") expect(scrollTop, "<main> 的 scrollTop 应增大").toBeGreaterThan(before.main.scrollTop);
    else if (motion === "up") expect(scrollTop, "<main> 的 scrollTop 应减小").toBeLessThan(before.main.scrollTop);
    else expect(scrollTop, "<main> 的 scrollTop 应不变").toBe(before.main.scrollTop);
  });
}

type ChapterEdge = "start" | "end";

/** 翻页模式需求 11.13：`Home`/`End` 到本章区段的章首 / 章末。 */
async function expectAtChapterEdge(after: ScrollSnapshot, edge: ChapterEdge, item: string): Promise<void> {
  const c = after.main;
  const target = edge === "start" ? c.chapterStart : c.chapterEnd;
  const what = edge === "start" ? "章首（区段顶边对齐 <main> 顶边）" : "章末（区段底边贴住 <main> 底边）";
  await step(`${item} <main> 的 scrollTop 在本章区段的${what} ${px(target)} 处（相差 ≤ ${FIT_PX} px）`, () => {
    expect(Math.abs(c.scrollTop - target), `scrollTop ${px(c.scrollTop)} 与${what} ${px(target)} 之差`).toBeLessThanOrEqual(
      FIT_PX,
    );
  });
}

// ---------------------------------------------------------------------------
// 保留一行（翻页模式需求 10.10、10.11）
// ---------------------------------------------------------------------------

/** 纵向区间（视口坐标，px）。 */
interface Extent {
  top: number;
  bottom: number;
}

/** 一次行测量：可见区、选中的那一行（没有时为 null）及其位置说明。 */
interface LineMeasure {
  band: Extent;
  line: Extent | null;
  where: string;
}

/** 翻页前的测量。 */
interface TurnLineProbe extends LineMeasure {
  direction: TurnDirection;
}

/** 翻页前选中的那一行，及翻页后重测的可见区与该行（元素已不在文档里时 `line` 为 null）。 */
interface TurnLineReading {
  probe: TurnLineProbe;
  band: Extent;
  line: Extent | null;
}

interface LineProbeArg {
  main: HTMLElement;
  topBar: HTMLElement;
  bottomBar: HTMLElement;
  /** 选行的方向；null 表示重测上一次选中的那一行。 */
  direction: TurnDirection | null;
  flag: string;
}

/**
 * 在页面里量可见区与行（见文件头"保留一行"）。`direction` 给出时，在 `<main>` 的各区段里找与可见区相交的
 * 行，NEXT 取最后一行、PREV 取第一行，把元素与行号记在页面的 `TURN_LINE_FLAG` 上；为 null 时重测记下的那一行。
 * 只读几何量，不改动应用状态。
 */
async function measureLine(page: Page, direction: TurnDirection | null): Promise<LineMeasure> {
  const view = reader(page);
  const [main, topBar, bottomBar] = await Promise.all([
    view.main.elementHandle(),
    view.topBar.elementHandle(),
    view.bottomBar.elementHandle(),
  ]);
  if (main === null || topBar === null || bottomBar === null) throw new Error("找不到 <main>、顶栏或底栏");
  try {
    return await page.evaluate((arg): LineMeasure => {
      const { main: mainEl, topBar: topEl, bottomBar: bottomEl, direction: dir, flag } = arg as unknown as LineProbeArg;

      // 可见区：<main> 的可视矩形减去与它交叠的顶栏、底栏（滑出视口的栏不交叠，不扣除）
      const viewTop = mainEl.getBoundingClientRect().top + mainEl.clientTop;
      const viewBottom = viewTop + mainEl.clientHeight;
      let top = viewTop;
      let bottom = viewBottom;
      const topRect = topEl.getBoundingClientRect();
      if (topRect.bottom > topRect.top && topRect.bottom > viewTop && topRect.top < viewBottom) {
        top = Math.max(top, topRect.bottom);
      }
      const bottomRect = bottomEl.getBoundingClientRect();
      if (bottomRect.bottom > bottomRect.top && bottomRect.bottom > viewTop && bottomRect.top < viewBottom) {
        bottom = Math.min(bottom, bottomRect.top);
      }
      const band = { top, bottom: Math.max(top, bottom) };

      // 一个块的行：标题区整块当作一行；段落取字形矩形，纵向重叠超过较矮者一半的并为同一行
      const linesOf = (el: Element): Extent[] => {
        if (el.tagName === "HEADER") {
          const r = el.getBoundingClientRect();
          return [{ top: r.top, bottom: r.bottom }];
        }
        const range = document.createRange();
        range.selectNodeContents(el);
        const rects = Array.from(range.getClientRects())
          .filter((r) => r.bottom > r.top)
          .sort((a, b) => a.top - b.top || a.bottom - b.bottom);
        const lines: Extent[] = [];
        for (const r of rects) {
          const last = lines[lines.length - 1];
          if (last !== undefined) {
            const overlap = Math.min(last.bottom, r.bottom) - Math.max(last.top, r.top);
            if (overlap > 0.5 * Math.min(last.bottom - last.top, r.bottom - r.top)) {
              last.top = Math.min(last.top, r.top);
              last.bottom = Math.max(last.bottom, r.bottom);
              continue;
            }
          }
          lines.push({ top: r.top, bottom: r.bottom });
        }
        return lines;
      };

      const store = window as unknown as Record<string, { el: Element; index: number } | undefined>;
      if (dir === null) {
        const stored = store[flag];
        const line = stored !== undefined && stored.el.isConnected ? (linesOf(stored.el)[stored.index] ?? null) : null;
        return { band, line, where: "" };
      }

      let best: { el: Element; index: number; line: Extent } | null = null;
      const blocks = mainEl.querySelectorAll(":scope > section > article > header, :scope > section article p");
      for (const el of Array.from(blocks)) {
        const box = el.getBoundingClientRect();
        if (box.bottom <= band.top || box.top >= band.bottom) continue;
        const lines = linesOf(el);
        for (let index = 0; index < lines.length; index++) {
          const line = lines[index];
          // 与可见区相交（含部分可见行）
          if (line.bottom <= band.top || line.top >= band.bottom) continue;
          const better = best === null || (dir === "next" ? line.top > best.line.top : line.top < best.line.top);
          if (better) best = { el, index, line };
        }
      }
      if (best === null) {
        delete store[flag];
        return { band, line: null, where: "（可见区里没有行）" };
      }
      store[flag] = { el: best.el, index: best.index };
      const section = best.el.closest("section[data-chapter-id]");
      const chapterId = section instanceof HTMLElement ? section.dataset.chapterId : "?";
      const block =
        best.el.tagName === "HEADER" ? "标题区" : `第 ${best.el.getAttribute("data-para") ?? "?"} 段第 ${best.index + 1} 行`;
      return { band, line: best.line, where: `下标 ${chapterId} 的区段 ${block}` };
    }, { main, topBar, bottomBar, direction, flag: TURN_LINE_FLAG });
  } finally {
    await Promise.all([main.dispose(), topBar.dispose(), bottomBar.dispose()]);
  }
}

function describeExtent(e: Extent | null): string {
  return e === null ? "（无）" : `[${px(e.top)}, ${px(e.bottom)}]`;
}

function describeTurnLine(t: TurnLineReading): string {
  return (
    `翻页前可见区 ${describeExtent(t.probe.band)}，选中 ${t.probe.where} ${describeExtent(t.probe.line)}；` +
    `翻页后可见区 ${describeExtent(t.band)}，该行 ${describeExtent(t.line)}`
  );
}

/**
 * 保留一行（需求 10.10、10.11）：NEXT 时翻页前可见区的最后一行成为可见区顶端第一行（上边与可见区顶边相差
 * ≤ `LINE_PX`），PREV 时翻页前可见区的第一行成为可见区底端最后一行（下边与可见区底边相差 ≤ `LINE_PX`）；
 * 该行在屏幕上的位移 > 0 且不超过可见区高度。
 */
async function expectKeptOneLine(reading: KeyReading, item: string): Promise<void> {
  const turn = reading.turn;
  if (turn === null) throw new Error(`${item} 不是翻页键，没有保留一行的测量`);
  const { probe } = turn;
  const next = probe.direction === "next";
  const rule = next
    ? "翻页前可见区的最后一行（含部分可见行）成为可见区顶端第一行（需求 10.10）"
    : "翻页前可见区的第一行（含部分可见行）成为可见区底端最后一行（需求 10.11）";
  await step(`${item} 保留一行：${rule}，位移不超过可见区高度`, () => {
    const before = probe.line;
    const after = turn.line;
    const detail = describeTurnLine(turn);
    if (before === null) throw new Error(`翻页前可见区里没有行（前提）：${detail}`);
    if (after === null) throw new Error(`翻页前选中的那一行（${probe.where}）翻页后不在文档里：${detail}`);
    const height = probe.band.bottom - probe.band.top;
    let moved: number;
    if (next) {
      expect(before.top, `前提：选中的行起于可见区顶边之下（${detail}）`).toBeGreaterThan(probe.band.top);
      expect(Math.abs(after.top - turn.band.top), `该行翻页后的上边与可见区顶边之差（${detail}）`).toBeLessThanOrEqual(
        LINE_PX,
      );
      moved = before.top - after.top;
    } else {
      expect(before.bottom, `前提：选中的行止于可见区底边之上（${detail}）`).toBeLessThan(probe.band.bottom);
      expect(Math.abs(after.bottom - turn.band.bottom), `该行翻页后的下边与可见区底边之差（${detail}）`).toBeLessThanOrEqual(
        LINE_PX,
      );
      moved = after.bottom - before.bottom;
    }
    expect(moved, `正文在屏幕上的位移应 > 0（${detail}）`).toBeGreaterThan(0);
    expect(moved, `正文在屏幕上的位移应不超过可见区高度 ${px(height)}（${detail}）`).toBeLessThanOrEqual(height + LINE_PX);
  });
}

/** 翻页后：标题为 `title` 的章节标题（`<main>` 内的一级标题）完整位于可见区内。 */
async function expectHeadingInBand(page: Page, title: string, band: Extent, item: string): Promise<void> {
  await step(`${item} 正文连续滚入下一章：其标题「${title}」进入可见区 ${describeExtent(band)}`, async () => {
    const box = await reader(page).main.getByRole("heading", { level: 1, name: title, exact: true }).boundingBox();
    if (box === null) throw new Error(`标题「${title}」没有边界框`);
    expect(box.y, "标题上边").toBeGreaterThanOrEqual(band.top - LINE_PX);
    expect(box.y + box.height, "标题下边").toBeLessThanOrEqual(band.bottom + LINE_PX);
  });
}

// ---------------------------------------------------------------------------
// 按键
// ---------------------------------------------------------------------------

interface KeyCase {
  /** 标题与步骤名里的写法。 */
  label: string;
  /** `page.keyboard.press` 的参数。 */
  key: string;
  /** 翻页键（翻页模式需求 11.11、11.12）的方向；行滚动键与 `Home`/`End` 没有。 */
  turn?: TurnDirection;
}

const ARROW_DOWN: KeyCase = { label: "↓", key: "ArrowDown" };
const ARROW_UP: KeyCase = { label: "↑", key: "ArrowUp" };
const PAGE_DOWN: KeyCase = { label: "PageDown", key: "PageDown", turn: "next" };
const PAGE_UP: KeyCase = { label: "PageUp", key: "PageUp", turn: "prev" };
const SPACE: KeyCase = { label: "Space", key: "Space", turn: "next" };
const SHIFT_SPACE: KeyCase = { label: "Shift+Space", key: "Shift+Space", turn: "prev" };
const END: KeyCase = { label: "End", key: "End" };
const HOME: KeyCase = { label: "Home", key: "Home" };

/** 按键闸门（需求 11.6）：按页面时钟等到距上一次同方向翻页键满 `KEY_TURN_GAP_MS`（加余量）。 */
async function waitTurnKeyGap(page: Page, direction: TurnDirection): Promise<void> {
  await page.evaluate(
    async ({ flag, dir, gap }) => {
      const record = (window as unknown as Record<string, Partial<Record<TurnDirection, number>> | undefined>)[flag];
      const last = record?.[dir];
      if (last === undefined) return;
      const wait = last + gap - performance.now();
      if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait));
    },
    { flag: TURN_KEY_FLAG, dir: direction, gap: KEY_TURN_GAP_MS + KEY_GAP_MARGIN_MS },
  );
}

/** 翻页键按下之后：记下此刻（供下一次同方向翻页键的闸门），再等满按键翻页滚动的 Turn_Duration 上限（加余量）。 */
async function settleTurnKey(page: Page, direction: TurnDirection): Promise<void> {
  await page.evaluate(
    async ({ flag, dir, settle }) => {
      const w = window as unknown as Record<string, Partial<Record<TurnDirection, number>> | undefined>;
      w[flag] = { ...w[flag], [dir]: performance.now() };
      await new Promise<void>((resolve) => setTimeout(resolve, settle));
    },
    { flag: TURN_KEY_FLAG, dir: direction, settle: TURN_BASE_MS.key + TURN_SETTLE_MARGIN_MS },
  );
}

/** `pressAndRead` 的结果。 */
interface KeyReading {
  after: ScrollSnapshot;
  /** 翻页键：翻页前选中的那一行及其翻页后的位置；其余键为 null。 */
  turn: TurnLineReading | null;
}

/**
 * 按下 `key` 并读取按键后的状态，前后读数记入注解。翻页键先过闸门、量好翻页前的那一行，按下后等翻页滚动
 * 结束、`scrollTop` 稳定，再重测那一行；其余键等 2 个动画帧后读取。
 */
async function pressAndRead(page: Page, before: ScrollSnapshot, key: KeyCase): Promise<KeyReading> {
  const direction = key.turn;
  let probe: TurnLineProbe | null = null;
  if (direction !== undefined) {
    const which = direction === "next" ? "最后一行" : "第一行";
    probe = await step(
      `等按键闸门（距上一次同方向翻页键 ≥ ${KEY_TURN_GAP_MS} ms），量出翻页前可见区与其中的${which}（含部分可见行）`,
      async () => {
        await waitTurnKeyGap(page, direction);
        return { ...(await measureLine(page, direction)), direction };
      },
    );
  }
  await step(`按 ${key.label}`, () => page.keyboard.press(key.key));
  const after = await step(
    direction === undefined
      ? "等 2 个动画帧后读取章节与滚动位置"
      : `等翻页滚动结束（按键 Turn_Duration ≤ ${TURN_BASE_MS.key} ms）、<main> 的 scrollTop 稳定后读取章节与滚动位置`,
    async () => {
      if (direction === undefined) {
        await waitFrames(page);
        return readSnapshot(page);
      }
      await settleTurnKey(page, direction);
      return readSettled(page);
    },
  );
  noteReading(key.label, before, after);
  if (probe === null) return { after, turn: null };
  const moved = await measureLine(page, null);
  const turn: TurnLineReading = { probe, band: moved.band, line: moved.line };
  test.info().annotations.push({ type: "scroll-reading", description: `${key.label} 保留一行：${describeTurnLine(turn)}` });
  return { after, turn };
}

// ---------------------------------------------------------------------------
// 起始状态
// ---------------------------------------------------------------------------

/**
 * 正文的起始位置（以当前章区段为界，见文件头）：
 *
 * - `chapter-start`：章首。经 `?ch=` 打开后的定位本身（不另行赋值），需求 10.7 的"区段顶边对齐容器顶边"；
 * - `middle`：章中，EV 需求 10 前言的起始状态 (a)，`scrollTop` 设为章首 + `clientHeight`；
 * - `chapter-end`：章末，`scrollTop` 设为 `chapterEnd`，下方仍挂着下一章；
 * - `book-start`：全书开头，全书首个正文章节，`scrollTop` 为 0；
 * - `book-end`：全书末尾，全书末个正文章节，`scrollTop` 为 `<main>` 的最大可滚距离。
 */
type StartPosition = "chapter-start" | "middle" | "chapter-end" | "book-start" | "book-end";

const POSITION_LABELS: Readonly<Record<StartPosition, string>> = {
  "chapter-start": "章首（经 ?ch= 打开后区段顶边对齐 <main> 顶边）",
  middle: "章中（scrollTop 设为章首 + clientHeight）",
  "chapter-end": "章末（scrollTop 设为区段底边贴住 <main> 底边处）",
  "book-start": "全书开头（首个正文章节，scrollTop 为 0）",
  "book-end": "全书末尾（末个正文章节，scrollTop 为 <main> 的最大可滚距离）",
};

/** 要赋给 `<main>` 的 `scrollTop`；`chapter-start` 为 null（不赋值，核对导航本身的定位）。 */
function startTarget(c: ChapterScroll, position: StartPosition): number | null {
  switch (position) {
    case "chapter-start":
      return null;
    case "middle":
      return Math.round(c.chapterStart + c.clientHeight);
    case "chapter-end":
      return Math.round(c.chapterEnd);
    case "book-start":
      return 0;
    case "book-end":
      return maxOf(c);
  }
}

/** 起始位置的前提；返回不满足的项（空数组即满足）。 */
function startProblems(c: ChapterScroll, position: StartPosition, plan: ChapterPlan): string[] {
  const problems: string[] = [];
  if (c.chapterId !== plan.chapter) problems.push(`当前章区段为下标 ${c.chapterId}，应为 ${plan.chapter}`);
  const max = maxOf(c);
  const span = spanOf(c);
  if (position === "book-start" || position === "book-end") {
    if (max < START_SCREENS * c.clientHeight) {
      problems.push(`<main> 的最大可滚距离 ${max} < ${START_SCREENS} × clientHeight（${c.clientHeight}）`);
    }
  } else if (span < START_SCREENS * c.clientHeight) {
    problems.push(`本章可滚距离 ${px(span)} < ${START_SCREENS} × clientHeight（${c.clientHeight}）`);
  }
  switch (position) {
    case "chapter-start":
      if (Math.abs(c.intoChapter) > FIT_PX) problems.push(`scrollTop ${c.scrollTop} 与章首 ${px(c.chapterStart)} 相差 > ${FIT_PX} px`);
      break;
    case "middle":
      if (c.scrollTop < c.chapterStart + EDGE_PX || c.scrollTop > c.chapterEnd - EDGE_PX) {
        problems.push(`scrollTop ${c.scrollTop} 不在 [章首 + ${EDGE_PX}, 章末 − ${EDGE_PX}] = [${px(c.chapterStart + EDGE_PX)}, ${px(c.chapterEnd - EDGE_PX)}] 内`);
      }
      break;
    case "chapter-end":
      if (Math.abs(c.scrollTop - c.chapterEnd) > FIT_PX) problems.push(`scrollTop ${c.scrollTop} 与章末 ${px(c.chapterEnd)} 相差 > ${FIT_PX} px`);
      if (max - c.scrollTop <= EDGE_PX) problems.push(`章末之下没有可滚距离（下方应挂着下一章；最大可滚距离 ${max}）`);
      break;
    case "book-start":
      if (plan.prev !== null) problems.push(`下标 ${plan.chapter} 不是全书首个正文章节`);
      if (c.scrollTop !== 0) problems.push(`scrollTop ${c.scrollTop} ≠ 0`);
      break;
    case "book-end":
      if (plan.next !== null) problems.push(`下标 ${plan.chapter} 不是全书末个正文章节`);
      if (Math.abs(max - c.scrollTop) >= FIT_PX) problems.push(`scrollTop ${c.scrollTop} 不在最大可滚距离 ${max} 处`);
      break;
  }
  return problems;
}

/** `document.activeElement.blur()`，并核对焦点在 `<body>` 上。 */
async function blurToBody(page: Page): Promise<void> {
  await step("document.activeElement.blur()，焦点回到 <body>", async () => {
    await page.evaluate(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement) active.blur();
    });
    await expect
      .poll(() => page.evaluate(() => document.activeElement === document.body), {
        message: "焦点应在 <body> 上",
      })
      .toBe(true);
  });
}

/**
 * 打开 `plan` 的章节，核对三个抽屉均关闭，等经 `?ch=` 的定位落在章首（区段顶边对齐 `<main>` 顶边），再把
 * `<main>` 设到 `position`（先核对文档不可滚动），核对前提，焦点回到 `<body>`。返回起始读数。
 */
async function readerAt(
  page: Page,
  bookLog: BookLog,
  plan: ChapterPlan,
  position: StartPosition,
): Promise<ScrollSnapshot> {
  const { book, chapter } = plan;
  await openReader(page, bookLog, book, chapter);
  await expectCurrentChapter(page, book.facts, chapter);
  await step("三个抽屉均关闭", async () => {
    const markers = overlayMarkers(page);
    await expect(markers.tocDrawer, "目录抽屉").toHaveCount(0);
    await expect(markers.searchDrawer, "检索抽屉").toHaveCount(0);
    await expect(markers.settingsDrawer, "设置抽屉").toHaveCount(0);
  });
  await step(`起始位置：${POSITION_LABELS[position]}`, async () => {
    await expectDocumentNotScrollable(page);
    // 先等导航定位落定（章节窗口挂上前一章时有锚点补偿），再以此为准换算目标位置
    await expect
      .poll(async () => Math.abs((await readChapterScroll(page)).intoChapter), {
        message: `经 ?ch= 打开后 <main> 的 scrollTop 应在章首（区段顶边对齐 <main> 顶边，相差 ≤ ${FIT_PX} px）`,
      })
      .toBeLessThanOrEqual(FIT_PX);
    const target = startTarget(await readChapterScroll(page), position);
    if (target !== null) await setMainScrollTop(page, target);
    await waitFrames(page);
    const c = await readChapterScroll(page);
    expect(startProblems(c, position, plan), `<main> 应满足起始位置的前提（${describeScroll(c)}）`).toEqual([]);
  });
  await blurToBody(page);
  const state = await readSnapshot(page);
  test.info().annotations.push({ type: "scroll-reading", description: `起始：${describeSnapshot(state)}` });
  return state;
}

// ---------------------------------------------------------------------------
// RDF 2.1 Body_Scroller 占满视口、文档不可滚动
// ---------------------------------------------------------------------------

/** `<main>` 与视口的几何量（px）。 */
interface ViewportFit {
  innerHeight: number;
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
  /** 边界框上边、下边（视口坐标）。 */
  top: number;
  bottom: number;
}

function readViewportFit(page: Page): Promise<ViewportFit> {
  return reader(page).main.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return {
      innerHeight: window.innerHeight,
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      scrollTop: el.scrollTop,
      top: rect.top,
      bottom: rect.bottom,
    };
  });
}

function fitProblems(f: ViewportFit): string[] {
  const problems: string[] = [];
  if (Math.abs(f.clientHeight - f.innerHeight) > FIT_PX) {
    problems.push(`clientHeight ${f.clientHeight} 与 innerHeight ${f.innerHeight} 相差 > ${FIT_PX} px`);
  }
  if (Math.abs(f.top) > FIT_PX) problems.push(`边界框上边 ${f.top} 与视口上边 0 相差 > ${FIT_PX} px`);
  if (Math.abs(f.bottom - f.innerHeight) > FIT_PX) {
    problems.push(`边界框下边 ${f.bottom} 与视口下边 ${f.innerHeight} 相差 > ${FIT_PX} px`);
  }
  return problems;
}

/** 2.1 的全部断言：`<main>` 的 `clientHeight` 与边界框贴合视口，文档不可滚动。 */
async function expectViewportFit(page: Page, where: string): Promise<void> {
  await step(
    `RDF 2.1 ${where}：<main> 的 clientHeight 与 innerHeight、边界框上下边与视口上下边各相差 ≤ ${FIT_PX} px`,
    async () => {
      const f = await readViewportFit(page);
      test.info().annotations.push({
        type: "scroll-reading",
        description:
          `${where}：innerHeight ${f.innerHeight}；<main> clientHeight ${f.clientHeight}、scrollHeight ${f.scrollHeight}、` +
          `scrollTop ${f.scrollTop}、边界框 [${f.top}, ${f.bottom}]`,
      });
      expect(fitProblems(f), "<main> 应占满视口").toEqual([]);
    },
  );
  await expectDocumentNotScrollable(page);
}

const VIEWPORT_CASES = [
  { key: "desktop", label: `桌面 ${VIEWPORTS.desktop.width}×${VIEWPORTS.desktop.height}` },
  { key: "mobile", label: `移动 ${VIEWPORTS.mobile.width}×${VIEWPORTS.mobile.height}` },
] as const;

const CHAPTER_CASES = [
  { key: "short", label: "短章", plan: shortChapterPlan },
  { key: "long", label: "长章", plan: longChapterPlan },
] as const;

for (const viewport of VIEWPORT_CASES) {
  test.describe(`RDF 2.1 Body_Scroller 占满视口（${viewport.label}）`, () => {
    test.use({ viewport: VIEWPORTS[viewport.key] });

    for (const chapterCase of CHAPTER_CASES) {
      test(`RDF 2.1 ${viewport.label}、${chapterCase.label}：<main> 的 clientHeight 与 innerHeight 相差 ≤ 1 px，边界框上下边与视口上下边相差 ≤ 1 px，文档滚动元素的最大可滚距离 ≤ 1 px`, async ({
        page,
        lib,
        bookLog,
      }) => {
        const plan = await chapterCase.plan(lib);
        await openReader(page, bookLog, plan.book, plan.chapter);
        await expectCurrentChapter(page, plan.book.facts, plan.chapter);
        await expectViewportFit(page, "打开本章后");
        const opened = await readChapterScroll(page);
        const span = spanOf(opened);
        test.info().annotations.push({
          type: "scroll-plan",
          description:
            `${chapterCase.label}在${viewport.label}下本章可滚距离 ${px(span)} px（区段高 ${px(opened.sectionHeight)}、` +
            `clientHeight ${opened.clientHeight}）；<main> 的最大可滚距离 ${maxOf(opened)} px`,
        });
        if (chapterCase.key === "short" && viewport.key === "desktop") {
          await step("前提：短章正文不足一屏（本章可滚距离 ≤ 1 px）", () => {
            expect(span, "本章可滚距离").toBeLessThanOrEqual(FIT_PX);
          });
        }
        if (chapterCase.key === "long") {
          await step("前提：长章正文超过一屏（本章可滚距离 > 1 px）", () => {
            expect(span, "本章可滚距离").toBeGreaterThan(FIT_PX);
          });
        }
        if (span > FIT_PX) {
          await step(`把 <main> 滚到章末（scrollTop 设为 ${px(opened.chapterEnd)}）`, async () => {
            await setMainScrollTop(page, Math.round(opened.chapterEnd));
            await waitFrames(page);
          });
          await expectViewportFit(page, "滚到章末后");
        }
      });
    }
  });
}

// ---------------------------------------------------------------------------
// RDF 2.2 只有 Body_Scroller 滚动（桌面）
// ---------------------------------------------------------------------------

/** `<main>` 的滚动范围与正文高度（px）。 */
interface MainOverflow {
  clientHeight: number;
  scrollHeight: number;
  /** 正文高度：`<main>` 内边距边上沿（`scrollTop` 0 处）到最后一个子元素（窗口末章的区段）下边，加 `<main>` 的下内边距。 */
  contentHeight: number;
  /** `<main>` 里挂着的区段数。 */
  sections: number;
}

/** 读 `<main>` 的滚动范围与正文高度（只读；区段的几何量只作度量）。 */
function readMainOverflow(page: Page): Promise<MainOverflow> {
  return reader(page).main.evaluate((mainEl) => {
    const last = mainEl.lastElementChild;
    if (last === null) throw new Error("<main> 里没有正文");
    const mainRect = mainEl.getBoundingClientRect();
    const paddingBottom = Number.parseFloat(getComputedStyle(mainEl).paddingBottom);
    const contentTop = mainRect.top + mainEl.clientTop - mainEl.scrollTop;
    return {
      clientHeight: mainEl.clientHeight,
      scrollHeight: mainEl.scrollHeight,
      contentHeight: last.getBoundingClientRect().bottom - contentTop + paddingBottom,
      sections: mainEl.querySelectorAll(":scope > section[data-chapter-id]").length,
    };
  });
}

test.describe("RDF 2.2 只有 Body_Scroller 滚动（桌面）", () => {
  test("RDF 2.2 打开长章后 <main> 里各章区段的正文高度超过可视高度：<main> 的最大可滚距离等于正文超出可视高度的部分（相差 ≤ 1 px），且 > 0", async ({
    page,
    lib,
    bookLog,
  }) => {
    const plan = await longChapterPlan(lib);
    await openReader(page, bookLog, plan.book, plan.chapter);
    await expectCurrentChapter(page, plan.book.facts, plan.chapter);
    await expectDocumentNotScrollable(page);
    await step("RDF 2.2 <main> 的 scrollHeight − clientHeight 等于正文高度 − 可视高度，且 > 0", async () => {
      const o = await readMainOverflow(page);
      const max = o.scrollHeight - o.clientHeight;
      const overflow = o.contentHeight - o.clientHeight;
      test.info().annotations.push({
        type: "scroll-reading",
        description:
          `<main> clientHeight ${o.clientHeight}、scrollHeight ${o.scrollHeight}（最大可滚距离 ${max}）；` +
          `挂着 ${o.sections} 个区段，正文高度 ${px(o.contentHeight)}（超出 ${px(overflow)}）`,
      });
      expect(overflow, "正文高度应超过 <main> 的可视高度（前提）").toBeGreaterThan(FIT_PX);
      expect(max, "<main> 的最大可滚距离应 > 0").toBeGreaterThan(0);
      expect(Math.abs(max - overflow), `最大可滚距离 ${max} 与正文超出可视高度的部分 ${px(overflow)} 之差`).toBeLessThanOrEqual(
        FIT_PX,
      );
    });
  });

  test("RDF 2.2 滚轮：自章首在 <main> 上向下、向上滚动只改变 <main> 的 scrollTop，文档滚动元素的 scrollTop 保持为 0", async ({
    page,
    lib,
    bookLog,
  }) => {
    const plan = await longChapterPlan(lib);
    const start = await readerAt(page, bookLog, plan, "chapter-start");
    await step("鼠标移到 <main> 边界框的中心", async () => {
      const box = await reader(page).main.boundingBox();
      if (box === null) throw new Error("<main> 没有边界框");
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    });

    await step(`滚轮向下 ${WHEEL_DELTA_PX} px`, () => page.mouse.wheel(0, WHEEL_DELTA_PX));
    const down = await step("等 <main> 的 scrollTop 改变并稳定", async () => {
      await expect
        .poll(async () => (await readMainScroll(page)).scrollTop, { message: "滚轮后 <main> 的 scrollTop 应增大" })
        .toBeGreaterThan(start.main.scrollTop);
      return readSettled(page);
    });
    noteReading("滚轮向下", start, down);
    await expectMainMoved(page, down, start, "down", "RDF 2.2 滚轮向下：");

    await step(`滚轮向上 ${WHEEL_DELTA_PX} px`, () => page.mouse.wheel(0, -WHEEL_DELTA_PX));
    const up = await step("等 <main> 的 scrollTop 改变并稳定", async () => {
      await expect
        .poll(async () => (await readMainScroll(page)).scrollTop, { message: "滚轮后 <main> 的 scrollTop 应减小" })
        .toBeLessThan(down.main.scrollTop);
      return readSettled(page);
    });
    noteReading("滚轮向上", down, up);
    await expectMainMoved(page, up, down, "up", "RDF 2.2 滚轮向上：");
    await expectSameChapter(up, start, "RDF 2.2 滚轮：");
  });

  test("RDF 2.2 赋值：依次把 <main> 的 scrollTop 设为章首 + clientHeight、章末与章首（本章区段内），只改变 <main> 的 scrollTop，文档滚动元素的 scrollTop 保持为 0", async ({
    page,
    lib,
    bookLog,
  }) => {
    const plan = await longChapterPlan(lib);
    const start = await readerAt(page, bookLog, plan, "chapter-start");
    const c = start.main;
    const targets: readonly { label: string; top: number; motion: Motion }[] = [
      { label: `章首 + clientHeight（${px(c.chapterStart + c.clientHeight)}）`, top: Math.round(c.chapterStart + c.clientHeight), motion: "down" },
      { label: `章末（${px(c.chapterEnd)}）`, top: Math.round(c.chapterEnd), motion: "down" },
      { label: `章首（${px(c.chapterStart)}）`, top: Math.round(c.chapterStart), motion: "up" },
    ];
    let before = start;
    for (const target of targets) {
      const after = await step(`把 <main> 的 scrollTop 设为 ${target.label}，等 2 个动画帧`, async () => {
        await setMainScrollTop(page, target.top);
        await waitFrames(page);
        return readSnapshot(page);
      });
      noteReading(`赋值 ${target.label}`, before, after);
      await expectMainMoved(page, after, before, target.motion, `RDF 2.2 赋值 ${target.label}：`);
      await step(`RDF 2.2 <main> 的 scrollTop 为 ${target.top}（相差 ≤ ${FIT_PX} px）`, () => {
        expect(Math.abs(after.main.scrollTop - target.top), `<main> 的 scrollTop ${px(after.main.scrollTop)}`).toBeLessThanOrEqual(
          FIT_PX,
        );
      });
      await expectSameChapter(after, start, `RDF 2.2 赋值 ${target.label}：`);
      before = after;
    }
  });

  test("RDF 2.2 按键：章中依次按 ↓、↑、PageDown、PageUp、Space、Shift+Space、End、Home，只改变 <main> 的 scrollTop（翻页键保留一行，End / Home 到本章区段的章末 / 章首），文档滚动元素的 scrollTop 保持为 0", async ({
    page,
    lib,
    bookLog,
  }) => {
    const plan = await longChapterPlan(lib);
    const start = await readerAt(page, bookLog, plan, "middle");
    const keys: readonly (KeyCase & { motion: Motion; edge?: ChapterEdge })[] = [
      { ...ARROW_DOWN, motion: "down" },
      { ...ARROW_UP, motion: "up" },
      { ...PAGE_DOWN, motion: "down" },
      { ...PAGE_UP, motion: "up" },
      { ...SPACE, motion: "down" },
      { ...SHIFT_SPACE, motion: "up" },
      { ...END, motion: "down", edge: "end" },
      { ...HOME, motion: "up", edge: "start" },
    ];
    let before = start;
    for (const key of keys) {
      const item = `RDF 2.2 ${key.label}：`;
      const reading = await pressAndRead(page, before, key);
      await expectMainMoved(page, reading.after, before, key.motion, item);
      if (key.turn !== undefined) await expectKeptOneLine(reading, item);
      if (key.edge !== undefined) await expectAtChapterEdge(reading.after, key.edge, item);
      await expectSameChapter(reading.after, start, item);
      before = reading.after;
    }
  });
});

// ---------------------------------------------------------------------------
// RDF 2.3 从滚动过的书架经书卡进入
// ---------------------------------------------------------------------------

test.describe("RDF 2.3 从滚动过的书架进入阅读器（桌面）", () => {
  test("RDF 2.3 书架页文档 scrollTop > 0 时点击书卡“开始阅读”进入阅读器（应用内导航）：正文渲染后文档滚动元素的 scrollTop 为 0", async ({
    page,
    lib,
    bookLog,
  }) => {
    const catalog: BooksCatalog = await lib.books();
    const index = Math.min(PAGE_SIZE, catalog.books.length) - 1;
    const summary = catalog.books[index];
    const book = await bookUnderTest(lib, summary.id);
    test.info().annotations.push({
      type: "scroll-plan",
      description: `书架首批书卡的第 ${index + 1} 张：《${summary.title}》（${summary.id}）`,
    });

    const card = shelf(page).card(index);
    await step("打开书架，等首批书卡挂载", async () => {
      await page.goto("/");
      await expect(shelf(page).cardTitles).toHaveText(catalog.books.slice(0, index + 1).map((b) => b.title));
    });
    const shelfTop = await step(`把第 ${index + 1} 张书卡的“开始阅读”按钮滚入视口（前提：文档 scrollTop > 0）`, async () => {
      await expect(card.title, "书卡书名").toHaveText(summary.title);
      await card.readButton.scrollIntoViewIfNeeded();
      await expect(card.readButton).toBeInViewport();
      const doc = await readDocumentScroll(page);
      test.info().annotations.push({
        type: "scroll-reading",
        description: `书架：文档 scrollTop ${doc.scrollTop}、clientHeight ${doc.clientHeight}、scrollHeight ${doc.scrollHeight}`,
      });
      expect(doc.scrollTop, "书架页文档滚动元素的 scrollTop").toBeGreaterThan(0);
      return doc.scrollTop;
    });

    await step(`在页面上留下标记 ${IN_APP_NAV_FLAG}，点击“开始阅读”，等正文加载完成`, async () => {
      await page.evaluate((flag) => {
        (window as unknown as Record<string, unknown>)[flag] = true;
      }, IN_APP_NAV_FLAG);
      const since = bookLog.count;
      await card.readButton.click();
      await bookLog.waitFor(book.id, undefined, { since, timeout: book.loadTimeout });
      await expect(reader(page).chapterHeading).toBeVisible();
    });
    const documentTop = await step("读文档滚动元素的 scrollTop（正文渲染后）", async () =>
      (await readDocumentScroll(page)).scrollTop,
    );
    await step("经应用内导航进入：页面标记仍在（没有整页载入），路径为 /read/<id>", async () => {
      const kept = await page.evaluate(
        (flag) => (window as unknown as Record<string, unknown>)[flag] === true,
        IN_APP_NAV_FLAG,
      );
      expect(kept, `页面标记 ${IN_APP_NAV_FLAG}`).toBe(true);
      expect(new URL(page.url()).pathname, "路径").toBe(readerPath(book.id));
    });
    await step(`RDF 2.3 正文渲染后文档滚动元素的 scrollTop 为 0（书架上为 ${shelfTop}）`, () => {
      expect(documentTop, "文档滚动元素的 scrollTop").toBe(0);
    });
    await expectDocumentNotScrollable(page);
  });
});

// ---------------------------------------------------------------------------
// RDF 4.2 Space 跨章连续滚动（桌面，长章）
// ---------------------------------------------------------------------------

test.describe("RDF 4.2 Space 跨章连续滚动（桌面；翻页模式需求 10.10、11.11 取代“只在章末换章”）", () => {
  test("RDF 4.2 自章首连按 Space：每次保留一行（翻页前可见区的最后一行成为可见区顶端第一行）；判定线留在本章时章节不变，读完本章后连续滚入下一个正文章节", async ({
    page,
    lib,
    bookLog,
  }) => {
    const plan = await longChapterPlan(lib);
    const { next } = plan;
    if (next === null) throw new Error("长章没有下一个正文章节");
    const start = await readerAt(page, bookLog, plan, "chapter-start");
    // 按每次下翻至少半屏估算，读完本章（本章可滚距离再加一屏）的次数不超过此上限
    const cap =
      Math.ceil((spanOf(start.main) + start.main.clientHeight) / (start.main.clientHeight / 2)) + CROSS_MAX_PRESSES;
    let before = start;
    for (let press = 1; before.main.chapterId === plan.chapter; press++) {
      if (press > cap) throw new Error(`按 ${cap} 次 Space 后仍未进入下一个正文章节（${describeScroll(before.main)}）`);
      const item = `RDF 4.2 第 ${press} 次 Space：`;
      const reading = await pressAndRead(page, before, SPACE);
      await expectDocumentNotScrollable(page);
      await expectKeptOneLine(reading, item);
      if (reading.after.main.chapterId === plan.chapter) await expectSameChapter(reading.after, start, item);
      before = reading.after;
    }
    await expectCurrentChapter(page, plan.book.facts, next);
  });

  test("RDF 4.2 章末（区段底边贴住 <main> 底边）按 Space：每次保留一行，正文连续滚入下一个正文章节；再按 Shift+Space：每次保留一行，连续滚回本章", async ({
    page,
    lib,
    bookLog,
  }) => {
    const plan = await longChapterPlan(lib);
    const { next } = plan;
    if (next === null) throw new Error("长章没有下一个正文章节");
    let before = await readerAt(page, bookLog, plan, "chapter-end");
    for (let press = 1; before.main.chapterId === plan.chapter; press++) {
      if (press > CROSS_MAX_PRESSES) {
        throw new Error(`自章末按 ${CROSS_MAX_PRESSES} 次 Space 仍未进入下一个正文章节（${describeScroll(before.main)}）`);
      }
      const reading = await pressAndRead(page, before, SPACE);
      await expectDocumentNotScrollable(page);
      await expectKeptOneLine(reading, `RDF 4.2 章末起第 ${press} 次 Space：`);
      before = reading.after;
    }
    await expectCurrentChapter(page, plan.book.facts, next);

    for (let press = 1; before.main.chapterId !== plan.chapter; press++) {
      if (press > CROSS_MAX_PRESSES) {
        throw new Error(`按 ${CROSS_MAX_PRESSES} 次 Shift+Space 仍未回到长章（${describeScroll(before.main)}）`);
      }
      const reading = await pressAndRead(page, before, SHIFT_SPACE);
      await expectDocumentNotScrollable(page);
      await expectKeptOneLine(reading, `RDF 4.2 回滚第 ${press} 次 Shift+Space：`);
      before = reading.after;
    }
    await expectCurrentChapter(page, plan.book.facts, plan.chapter);
  });
});

// ---------------------------------------------------------------------------
// RDF 4.3 ↑ / ↓ / PageUp / PageDown（桌面）
// ---------------------------------------------------------------------------

interface LineKeyCase extends KeyCase {
  /** 该键滚动的方向。 */
  motion: "down" | "up";
}

const LINE_KEYS: readonly LineKeyCase[] = [
  { ...ARROW_DOWN, motion: "down" },
  { ...PAGE_DOWN, motion: "down" },
  { ...ARROW_UP, motion: "up" },
  { ...PAGE_UP, motion: "up" },
];

/**
 * 让 `<main>` 本身获得焦点（非输入类元素）。滚动模式的 `<main>` 里只有区段、`<article>`、标题区与段落，没有
 * 天然可聚焦的元素（原先用的章末"下一章"按钮已随章末导航卡删除，翻页模式需求 12.8），`<main>` 自己带
 * `tabIndex = 0`（滚动区可经键盘聚焦，axe `scrollable-region-focusable`）。先核对它在 Tab 序列中，再
 * `focus({ preventScroll: true })`，聚焦本身不滚动正文。核对焦点在 `<main>` 上、`<main>` 的 `scrollTop` 未变，
 * 返回聚焦后的读数。
 */
async function focusInsideMain(page: Page, before: ScrollSnapshot): Promise<ScrollSnapshot> {
  return step("让 <main> 本身获得焦点（tabIndex = 0，focus({ preventScroll: true })）", async () => {
    const main = reader(page).main;
    await expect(main, "<main> 应在 Tab 序列中（滚动区可经键盘聚焦）").toHaveAttribute("tabindex", "0");
    await main.evaluate((el) => {
      if (!(el instanceof HTMLElement)) throw new Error("<main> 不是 HTMLElement");
      el.focus({ preventScroll: true });
    });
    await expect(main, "焦点应在 <main> 上").toBeFocused();
    await waitFrames(page);
    const focused = await readSnapshot(page);
    expect(focused.main.scrollTop, "聚焦后 <main> 的 scrollTop 应不变").toBe(before.main.scrollTop);
    return focused;
  });
}

test.describe("RDF 4.3 ↑ / ↓ / PageUp / PageDown 滚动 Body_Scroller（桌面）", () => {
  for (const key of LINE_KEYS) {
    const verb = MOTION_LABELS[key.motion];
    const down = key.motion === "down";
    const keepsLine = key.turn !== undefined;
    const kept = keepsLine ? "（保留一行）" : "";

    test(`RDF 4.3 焦点在 <body>、正文在章中时按 ${key.label}：<main> 的 scrollTop ${verb}${kept}，章节不变`, async ({
      page,
      lib,
      bookLog,
    }) => {
      const item = `RDF 4.3 ${key.label}：`;
      const start = await readerAt(page, bookLog, await longChapterPlan(lib), "middle");
      const reading = await pressAndRead(page, start, key);
      await expectMainMoved(page, reading.after, start, key.motion, item);
      if (keepsLine) await expectKeptOneLine(reading, item);
      await expectSameChapter(reading.after, start, item);
    });

    const chapterEdge: StartPosition = down ? "chapter-end" : "chapter-start";
    const chapterEdgeLabel = down ? "长章章末（下方挂着下一章）" : "长章章首（经 ?ch= 打开，上方挂着前一章）";
    const crossing = down ? "连续滚入下一章（下一个正文章节的标题进入可见区）" : "连续滚入前一章（当前章变为前一个正文章节）";
    const chapterEdgeOutcome = keepsLine ? `保留一行，${crossing}` : `<main> 的 scrollTop ${verb}（不停在章界），章节不变`;

    test(`RDF 4.3 焦点在 <body>、正文在${chapterEdgeLabel}时按 ${key.label}：${chapterEdgeOutcome}`, async ({
      page,
      lib,
      bookLog,
    }) => {
      const item = `RDF 4.3 ${key.label}（${chapterEdgeLabel}）：`;
      const plan = await longChapterPlan(lib);
      const start = await readerAt(page, bookLog, plan, chapterEdge);
      if (!down) {
        await step("翻页模式 10.7：经 ?ch= 打开后区段顶边对齐 <main> 顶边，且上方挂着前一章（章首 scrollTop > 0）", () => {
          expect(start.main.chapterStart, `章首（${describeScroll(start.main)}）`).toBeGreaterThan(FIT_PX);
        });
      }
      const reading = await pressAndRead(page, start, key);
      if (!keepsLine) {
        await expectMainMoved(page, reading.after, start, key.motion, item);
        await expectSameChapter(reading.after, start, item);
        return;
      }
      await expectDocumentNotScrollable(page);
      await expectKeptOneLine(reading, item);
      if (down) {
        if (plan.next === null || reading.turn === null) throw new Error("长章没有下一个正文章节");
        await expectHeadingInBand(page, plan.book.facts.titles[plan.next], reading.turn.band, item);
      } else {
        if (plan.prev === null) throw new Error("长章没有上一个正文章节");
        await expectCurrentChapter(page, plan.book.facts, plan.prev);
      }
    });

    const bookEdge: StartPosition = down ? "book-end" : "book-start";
    const bookEdgeLabel = down
      ? "<main> 在全书末尾（末个正文章节，scrollTop 为最大可滚距离）"
      : "<main> 在全书开头（首个正文章节，scrollTop 为 0）";

    test(`RDF 4.3 焦点在 <body>、${bookEdgeLabel}时按 ${key.label}：scrollTop 保持不变，章节不变`, async ({
      page,
      lib,
      bookLog,
    }) => {
      const item = `RDF 4.3 ${key.label}（${down ? "全书末尾" : "全书开头"}）：`;
      const start = await readerAt(page, bookLog, await bookEdgePlan(lib, down ? "last" : "first"), bookEdge);
      const reading = await pressAndRead(page, start, key);
      await expectMainMoved(page, reading.after, start, "none", item);
      await expectSameChapter(reading.after, start, item);
    });

    test(`RDF 4.3 焦点在 <main> 上（非输入类元素）、正文在章中时按 ${key.label}：<main> 的 scrollTop ${verb}${kept}，章节不变`, async ({
      page,
      lib,
      bookLog,
    }) => {
      const item = `RDF 4.3 ${key.label}（焦点在 <main> 上）：`;
      const start = await readerAt(page, bookLog, await longChapterPlan(lib), "middle");
      const focused = await focusInsideMain(page, start);
      const reading = await pressAndRead(page, focused, key);
      await expectMainMoved(page, reading.after, focused, key.motion, item);
      if (keepsLine) await expectKeptOneLine(reading, item);
      await expectSameChapter(reading.after, start, item);
    });
  }
});
