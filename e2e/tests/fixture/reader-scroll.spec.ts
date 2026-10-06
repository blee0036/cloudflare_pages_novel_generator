/**
 * 阅读器：正文滚动容器（reader-defect-fixes 需求 2.1–2.3、4.2、4.3；Findings_Log F-002，已修复
 * （reader-defect-fixes））。`fixture` 项目（:4611，Opaque_Mode），默认主题（不 `seedTheme`），不装
 * Controlled_Clock（不涉及时长）。用例标题以 `RDF <需求编号>` 开头（设计 S10）。
 *
 * ## Body_Scroller 与文档滚动元素
 *
 * Body_Scroller 是阅读器正文的 `main` 地标（`reader(page).main`，需求 Glossary、D1）；文档滚动元素为
 * `document.scrollingElement`。读数与赋值经 `e2e/support/reader.ts` 的 `readMainScroll`、`setMainScrollTop`、
 * `readDocumentScroll`；2.1 的"文档滚动元素的最大可滚距离 ≤ 1 px"即 `expectDocumentNotScrollable`，每次滚动
 * 断言前都先核对它（需求 14.2）。
 *
 * ## 用书与章节（4.4：期望值运行时推导）
 *
 * - 长章：`lib.role("longText")` 的 `roles.json longText.chapterIndex`（夹具的长章节，正文高度为数屏），须既非
 *   首个也非末个正文章节（4.2 要换到下一个正文章节）。2.1 的"长章"与 2.2、4.2、4.3 都用它。
 * - 短章：`lib.role("huge")`（章节最多的夹具书，每章只有几行）中 `_toc.json` 的 `length` 最小的正文章节
 *   （同长取下标最小者），是夹具书库中最短的正文章节。2.1 的"与章节长度无关"由它与长章两端覆盖。打开后
 *   `<main>` 的最大可滚距离记在注解 `scroll-plan` 里；桌面视口下核对前提：正文不足一屏（最大可滚距离
 *   ≤ 1 px）。移动视口下这一章也只略高于一屏（见注解），作为同一书库里最短的一章照常断言。
 * - 2.3：`books.json` 首批书卡中的最后一张（第 min(PAGE_SIZE, N) 张）所对应的书，经书卡"开始阅读"进入。
 *
 * 前提不成立是测试自身的问题（16.6），用例普通失败。所选的书、章节与读数记在注解 `scroll-plan`、
 * `scroll-reading` 里。
 *
 * ## 各条的做法
 *
 * - 2.1：桌面 1280×800 与移动 390×844 × 短章 / 长章，共 4 个用例。打开该章后读 `<main>` 的 `clientHeight`、
 *   边界框与 `innerHeight`，断言相差均 ≤ 1 px，并核对文档不可滚动；`<main>` 可滚时再把它滚到章末重读一次
 *   （"WHILE 显示正文章节"在章内任何位置都成立）。
 * - 2.2（桌面）：
 *   - 最大可滚距离：`<main>` 的 `scrollHeight − clientHeight` 与"正文超出可视高度的部分"相差 ≤ 1 px 且 > 0。
 *     "正文高度"取 `<main>` 内容的实际高度：自 `<main>` 内边距边上沿（`scrollTop` 为 0 处）到 `<article>`
 *     边界框下边的距离，加上 `<main>` 的下内边距；可视高度为 `clientHeight`。
 *   - 滚轮：鼠标移到 `<main>` 边界框中心，`mouse.wheel` 向下再向上各一次，等 `<main>` 的 `scrollTop` 稳定。
 *   - 赋值：依次把 `<main>` 的 `scrollTop` 设为 `clientHeight`、最大可滚距离与 0。
 *   - 按键：自章中依次按 `↓`、`↑`、`PageDown`、`PageUp`、`Space`、`Shift+Space`、`End`、`Home`（需求 4 的按键）。
 *   每次滚动后断言 `<main>` 的 `scrollTop` 按预期方向改变、文档滚动元素的 `scrollTop` 为 0，章节不变。
 * - 2.3（桌面）：打开书架，把最后一张首批书卡的"开始阅读"按钮滚入视口（核对文档 `scrollTop` > 0），在页面上
 *   留一个标记后点击它；等 `[book-load]` 行与正文 `<h1>`，核对标记仍在（应用内导航，没有整页载入）与路径为
 *   `/read/<id>`，再读一次文档滚动元素的 `scrollTop`，断言为 0，并核对文档不可滚动。
 * - 4.2（桌面，长章）：(a) 自章首连按 `Space`：每次按键前剩余可滚距离 > 2 px，按后章节不变、`scrollTop` 增大；
 *   剩余 ≤ 2 px 后再按一次，渲染下一个正文章节（8.1 的判定）。(b) 把 `<main>` 设在剩余可滚距离 3 px 处按
 *   `Space`：章节不变；此时剩余已 ≤ 2 px，再按一次才换到下一个正文章节。
 * - 4.3（桌面，长章）：`↓`、`PageDown`、`↑`、`PageUp` 各 3 个用例：焦点在 `<body>`、正文在章中（EV 需求 10
 *   前言的起始状态 (a)）时 `scrollTop` 增大 / 减小；焦点在 `<body>`、`<main>` 已在最大可滚距离处 / `scrollTop`
 *   为 0 时不变；焦点在 `<main>` 内的章末"下一章"按钮（非输入类元素，`focus({ preventScroll: true })`，聚焦
 *   不改变滚动位置）上、正文在章中时增大 / 减小。每个用例都断言章节不变。
 *
 * "章节不变"与 `reader-shortcuts.spec.ts` 相同：URL 的 `ch` 与 8.1 所判定的当前章节（正文 `<h1>` 与"第 N / M
 * 章"的文本）都与按键前相同。"三个抽屉均关闭"以三个打开标志的计数为 0 核对。"不变"类断言与按键后的读数
 * 都在等 2 个动画帧（`waitFrames`）之后读取，不用固定时长。
 */
import type { Page } from "@playwright/test";
import type { BooksCatalog } from "../../../src/types";
import { PAGE_SIZE } from "../../../src/utils/pagination";
import { expect, test, type BookLog, type Lib } from "../../support/fixtures";
import { overlayMarkers, reader, shelf } from "../../support/locators";
import {
  bookUnderTest,
  expectCurrentChapter,
  expectDocumentNotScrollable,
  openReader,
  readDocumentScroll,
  readMainScroll,
  readerPath,
  setMainScrollTop,
  waitFrames,
  type BookUnderTest,
  type MainScroll,
} from "../../support/reader";
import { VIEWPORTS } from "../../support/settings";
import { step } from "../../support/step";

// ---------------------------------------------------------------------------
// 常量（取自需求条文）
// ---------------------------------------------------------------------------

/** 2.1 / 2.2：几何量的容差（px）。 */
const FIT_PX = 1;

/** 4.2：剩余可滚距离的阈值（EV 10.12 的条件）；4.3 的起始状态离两端的距离（EV 需求 10 前言）。 */
const EDGE_PX = 2;

/** EV 需求 10 前言的起始状态：最大可滚距离不少于 `clientHeight` 的倍数。 */
const START_SCREENS = 2;

/** 4.2 (b)：剩余可滚距离略大于阈值时的取值（px）。 */
const NEAR_END_REMAINING_PX = 3;

/** 2.2：滚轮一次的纵向滚动量（px）。 */
const WHEEL_DELTA_PX = 400;

/** 等 `<main>` 的 `scrollTop` 稳定：每次等 2 帧，最多这么多次。 */
const SETTLE_MAX_ROUNDS = 60;

/** 2.3：点击书卡前写在页面上的标记（应用内导航不会清掉它，整页载入会）。 */
const IN_APP_NAV_FLAG = "__e2eRdfInAppNavigation";

// ---------------------------------------------------------------------------
// 用书与章节
// ---------------------------------------------------------------------------

interface ChapterPlan {
  book: BookUnderTest;
  /** 打开的章节下标。 */
  chapter: number;
  /** 其后的下一个正文章节下标（没有时为 null）。 */
  next: number | null;
}

/** 长章：`roles.json longText.chapterIndex`，须既非首个也非末个正文章节。 */
async function longChapterPlan(lib: Lib): Promise<ChapterPlan> {
  const id = lib.role("longText");
  const book = await bookUnderTest(lib, id);
  return step("选定长章（roles.json longText.chapterIndex，既非首也非末的正文章节）", () => {
    const { facts } = book;
    const chapter = lib.fixtureRoles().longText.chapterIndex;
    const ordinal = facts.bodyOrdinals[chapter];
    if (ordinal === null || ordinal === undefined) {
      throw new Error(`${id}：longText.chapterIndex（下标 ${chapter}）不是正文章节`);
    }
    const prev = facts.bodyIndices[ordinal - 1];
    const next = facts.bodyIndices[ordinal + 1];
    if (prev === undefined || next === undefined) {
      throw new Error(`${id}：长章（下标 ${chapter}，正文第 ${ordinal + 1} / ${facts.bodyCount} 章）须既非首个也非末个`);
    }
    test.info().annotations.push({
      type: "scroll-plan",
      description: `长章：书 ${id} 下标 ${chapter}「${facts.titles[chapter]}」；下一个正文章节 下标 ${next}「${facts.titles[next]}」`,
    });
    return { book, chapter, next };
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
    const ordinal = facts.bodyOrdinals[chapter] ?? 0;
    test.info().annotations.push({
      type: "scroll-plan",
      description: `短章：书 ${id} 下标 ${chapter}「${facts.titles[chapter]}」（${toc.chapters[chapter].length} 字）`,
    });
    return { book, chapter, next: facts.bodyIndices[ordinal + 1] ?? null };
  });
}

// ---------------------------------------------------------------------------
// 读数
// ---------------------------------------------------------------------------

/** 一次读数：URL 的 `ch`、8.1 的当前章节、`<main>` 的滚动几何与文档滚动元素的 `scrollTop`。 */
interface ScrollSnapshot {
  /** URL 的 `ch` 查询参数；没有时为 null。 */
  ch: string | null;
  /** 正文 `<h1>` 的文本（8.1）。 */
  heading: string;
  /** "第 N / M 章"的文本（8.1）。 */
  position: string;
  main: MainScroll;
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
    readMainScroll(page),
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

function maxOf(m: MainScroll): number {
  return m.scrollHeight - m.clientHeight;
}

function remainingOf(m: MainScroll): number {
  return maxOf(m) - m.scrollTop;
}

function describeScroll(m: MainScroll): string {
  return `scrollTop ${m.scrollTop}、clientHeight ${m.clientHeight}、scrollHeight ${m.scrollHeight}`;
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

/** 等 `<main>` 的 `scrollTop` 连续两次读数（间隔 2 帧）相同后返回读数（滚轮可能带滚动动画）。 */
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

/** "章节不变"比较的内容：URL 的 `ch` 与 8.1 的当前章节。 */
function chapterOf(s: ScrollSnapshot): { ch: string | null; heading: string; position: string } {
  return { ch: s.ch, heading: s.heading, position: s.position };
}

async function expectSameChapter(after: ScrollSnapshot, before: ScrollSnapshot, item: string): Promise<void> {
  await step(`${item} 章节不变（URL 的 ch 与正文 <h1>、“第 N / M 章”）`, () => {
    expect(chapterOf(after), "URL 的 ch 与当前章节").toEqual(chapterOf(before));
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
 * `scrollTop` 相对 `before` 按 `motion` 改变。
 */
async function expectMainMoved(
  page: Page,
  after: ScrollSnapshot,
  before: ScrollSnapshot,
  motion: Motion,
  item: string,
): Promise<void> {
  await expectDocumentNotScrollable(page);
  await step(`${item} <main> 的 scrollTop ${MOTION_LABELS[motion]}（${before.main.scrollTop} → ${after.main.scrollTop}），文档滚动元素的 scrollTop 为 0`, () => {
    expect(after.documentTop, "文档滚动元素的 scrollTop").toBe(0);
    const scrollTop = after.main.scrollTop;
    if (motion === "down") expect(scrollTop, "<main> 的 scrollTop 应增大").toBeGreaterThan(before.main.scrollTop);
    else if (motion === "up") expect(scrollTop, "<main> 的 scrollTop 应减小").toBeLessThan(before.main.scrollTop);
    else expect(scrollTop, "<main> 的 scrollTop 应不变").toBe(before.main.scrollTop);
  });
}

// ---------------------------------------------------------------------------
// 起始状态
// ---------------------------------------------------------------------------

/**
 * 正文的起始位置：`start` 章首（`scrollTop` 0）、`middle` 章中（EV 需求 10 前言的起始状态 (a)：
 * `scrollTop` 设为 `clientHeight`）、`end` 最大可滚距离处、`near-end` 剩余可滚距离 3 px 处。
 */
type StartPosition = "start" | "middle" | "end" | "near-end";

const POSITION_LABELS: Readonly<Record<StartPosition, string>> = {
  start: "章首（scrollTop 为 0）",
  middle: "章中（scrollTop 设为 clientHeight）",
  end: "章末（scrollTop 为最大可滚距离）",
  "near-end": `剩余可滚距离 ${NEAR_END_REMAINING_PX} px 处`,
};

function startTarget(m: MainScroll, position: StartPosition): number {
  switch (position) {
    case "start":
      return 0;
    case "middle":
      return m.clientHeight;
    case "end":
      return maxOf(m);
    case "near-end":
      return maxOf(m) - NEAR_END_REMAINING_PX;
  }
}

/** 起始位置的前提；返回不满足的项（空数组即满足）。 */
function startProblems(m: MainScroll, position: StartPosition): string[] {
  const max = maxOf(m);
  const problems: string[] = [];
  if (max < START_SCREENS * m.clientHeight) {
    problems.push(`最大可滚距离 ${max} < ${START_SCREENS} × clientHeight（${m.clientHeight}）`);
  }
  switch (position) {
    case "start":
      if (m.scrollTop !== 0) problems.push(`scrollTop ${m.scrollTop} ≠ 0`);
      break;
    case "middle":
      if (m.scrollTop < EDGE_PX || m.scrollTop > max - EDGE_PX) {
        problems.push(`scrollTop ${m.scrollTop} 不在 [${EDGE_PX}, ${max - EDGE_PX}] 内`);
      }
      break;
    case "end":
      if (Math.abs(max - m.scrollTop) >= FIT_PX) problems.push(`scrollTop ${m.scrollTop} 不在最大可滚距离 ${max} 处`);
      break;
    case "near-end":
      if (remainingOf(m) <= EDGE_PX) problems.push(`剩余可滚距离 ${remainingOf(m)} ≤ ${EDGE_PX} px`);
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
 * 打开 `plan` 的章节，核对三个抽屉均关闭，把 `<main>` 设到 `position`（先核对文档不可滚动），核对前提，
 * 焦点回到 `<body>`。返回起始读数。
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
    await setMainScrollTop(page, startTarget(await readMainScroll(page), position));
    await waitFrames(page);
    const main = await readMainScroll(page);
    expect(startProblems(main, position), `<main> 应满足起始位置的前提（${describeScroll(main)}）`).toEqual([]);
  });
  await blurToBody(page);
  const state = await readSnapshot(page);
  test.info().annotations.push({ type: "scroll-reading", description: `起始：${describeSnapshot(state)}` });
  return state;
}

/** 按下 `key`，等 2 个动画帧后读一次状态，前后读数记入注解。 */
async function pressAndRead(page: Page, before: ScrollSnapshot, key: KeyCase): Promise<ScrollSnapshot> {
  await step(`按 ${key.label}`, () => page.keyboard.press(key.key));
  return step("等 2 个动画帧后读取章节与滚动位置", async () => {
    await waitFrames(page);
    const after = await readSnapshot(page);
    noteReading(key.label, before, after);
    return after;
  });
}

interface KeyCase {
  /** 标题与步骤名里的写法。 */
  label: string;
  /** `page.keyboard.press` 的参数。 */
  key: string;
}

const SPACE: KeyCase = { label: "Space", key: "Space" };

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

/** 2.1 的全部断言：`<main>` 的 `clientHeight` 与边界框贴合视口，文档不可滚动。返回读数。 */
async function expectViewportFit(page: Page, where: string): Promise<ViewportFit> {
  const fit = await step(
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
      return f;
    },
  );
  await expectDocumentNotScrollable(page);
  return fit;
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
        const atStart = await expectViewportFit(page, "打开本章后");
        const max = atStart.scrollHeight - atStart.clientHeight;
        test.info().annotations.push({
          type: "scroll-plan",
          description: `${chapterCase.label}在${viewport.label}下 <main> 的最大可滚距离 ${max} px（clientHeight ${atStart.clientHeight}）`,
        });
        if (chapterCase.key === "short" && viewport.key === "desktop") {
          await step("前提：短章正文不足一屏（<main> 的最大可滚距离 ≤ 1 px）", () => {
            expect(max, "<main> 的最大可滚距离").toBeLessThanOrEqual(FIT_PX);
          });
        }
        if (chapterCase.key === "long") {
          await step("前提：长章正文超过一屏（<main> 的最大可滚距离 > 1 px）", () => {
            expect(max, "<main> 的最大可滚距离").toBeGreaterThan(FIT_PX);
          });
        }
        if (max > FIT_PX) {
          await step("把 <main> 滚到章末（scrollTop 设为最大可滚距离）", async () => {
            await setMainScrollTop(page, max);
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
  /** 正文高度：`<main>` 内边距边上沿（`scrollTop` 0 处）到 `<article>` 下边，加 `<main>` 的下内边距。 */
  contentHeight: number;
}

/** 读 `<main>` 的滚动范围与正文高度（只读；`<article>` 经 `locators.ts` 定位，几何量只作度量）。 */
async function readMainOverflow(page: Page): Promise<MainOverflow> {
  const view = reader(page);
  const article = await view.article.elementHandle();
  if (article === null) throw new Error("找不到正文 <article>");
  try {
    return await view.main.evaluate((mainEl, articleEl) => {
      const mainRect = mainEl.getBoundingClientRect();
      const articleRect = articleEl.getBoundingClientRect();
      const paddingBottom = Number.parseFloat(getComputedStyle(mainEl).paddingBottom);
      const contentTop = mainRect.top + mainEl.clientTop - mainEl.scrollTop;
      return {
        clientHeight: mainEl.clientHeight,
        scrollHeight: mainEl.scrollHeight,
        contentHeight: articleRect.bottom - contentTop + paddingBottom,
      };
    }, article);
  } finally {
    await article.dispose();
  }
}

test.describe("RDF 2.2 只有 Body_Scroller 滚动（桌面）", () => {
  test("RDF 2.2 长章正文高度超过 <main> 的可视高度：<main> 的最大可滚距离等于正文超出可视高度的部分（相差 ≤ 1 px），且 > 0", async ({
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
        description: `<main> clientHeight ${o.clientHeight}、scrollHeight ${o.scrollHeight}（最大可滚距离 ${max}）；正文高度 ${o.contentHeight}（超出 ${overflow}）`,
      });
      expect(overflow, "正文高度应超过 <main> 的可视高度（前提）").toBeGreaterThan(FIT_PX);
      expect(max, "<main> 的最大可滚距离应 > 0").toBeGreaterThan(0);
      expect(Math.abs(max - overflow), `最大可滚距离 ${max} 与正文超出可视高度的部分 ${overflow} 之差`).toBeLessThanOrEqual(
        FIT_PX,
      );
    });
  });

  test("RDF 2.2 滚轮：在 <main> 上向下、向上滚动只改变 <main> 的 scrollTop，文档滚动元素的 scrollTop 保持为 0", async ({
    page,
    lib,
    bookLog,
  }) => {
    const plan = await longChapterPlan(lib);
    const start = await readerAt(page, bookLog, plan, "start");
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

  test("RDF 2.2 赋值：依次把 <main> 的 scrollTop 设为 clientHeight、最大可滚距离与 0，只改变 <main> 的 scrollTop，文档滚动元素的 scrollTop 保持为 0", async ({
    page,
    lib,
    bookLog,
  }) => {
    const plan = await longChapterPlan(lib);
    const start = await readerAt(page, bookLog, plan, "start");
    const max = maxOf(start.main);
    const targets: readonly { label: string; top: number; motion: Motion }[] = [
      { label: `clientHeight（${start.main.clientHeight}）`, top: start.main.clientHeight, motion: "down" },
      { label: `最大可滚距离（${max}）`, top: max, motion: "down" },
      { label: "0", top: 0, motion: "up" },
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
      await step(`RDF 2.2 <main> 的 scrollTop 为 ${target.top}`, () => {
        expect(after.main.scrollTop, "<main> 的 scrollTop").toBe(target.top);
      });
      await expectSameChapter(after, start, `RDF 2.2 赋值 ${target.label}：`);
      before = after;
    }
  });

  test("RDF 2.2 按键：章中依次按 ↓、↑、PageDown、PageUp、Space、Shift+Space、End、Home，只改变 <main> 的 scrollTop，文档滚动元素的 scrollTop 保持为 0", async ({
    page,
    lib,
    bookLog,
  }) => {
    const plan = await longChapterPlan(lib);
    const start = await readerAt(page, bookLog, plan, "middle");
    const keys: readonly (KeyCase & { motion: Motion })[] = [
      { label: "↓", key: "ArrowDown", motion: "down" },
      { label: "↑", key: "ArrowUp", motion: "up" },
      { label: "PageDown", key: "PageDown", motion: "down" },
      { label: "PageUp", key: "PageUp", motion: "up" },
      { label: "Space", key: "Space", motion: "down" },
      { label: "Shift+Space", key: "Shift+Space", motion: "up" },
      { label: "End", key: "End", motion: "down" },
      { label: "Home", key: "Home", motion: "up" },
    ];
    let before = start;
    for (const key of keys) {
      const after = await pressAndRead(page, before, key);
      await expectMainMoved(page, after, before, key.motion, `RDF 2.2 ${key.label}：`);
      await expectSameChapter(after, start, `RDF 2.2 ${key.label}：`);
      before = after;
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
// RDF 4.2 Space 只在章末换章（桌面，长章）
// ---------------------------------------------------------------------------

test.describe("RDF 4.2 Space 只在章末换章（桌面）", () => {
  test("RDF 4.2 自章首连按 Space：剩余可滚距离 > 2 px 时每次按键章节不变、<main> 的 scrollTop 增大；剩余 ≤ 2 px 后再按一次才渲染下一个正文章节", async ({
    page,
    lib,
    bookLog,
  }) => {
    const plan = await longChapterPlan(lib);
    const start = await readerAt(page, bookLog, plan, "start");
    // 每次下翻至少半屏（pageScroll.ts 的 MIN_PAGE_RATIO），按到章末的次数不超过此上限
    const cap = Math.ceil(maxOf(start.main) / (start.main.clientHeight / 2)) + 1;
    let before = start;
    for (let press = 1; remainingOf(before.main) > EDGE_PX; press++) {
      if (press > cap) throw new Error(`按 ${cap} 次 Space 后 <main> 仍未到章末（${describeScroll(before.main)}）`);
      const remaining = remainingOf(before.main);
      const after = await pressAndRead(page, before, SPACE);
      await expectDocumentNotScrollable(page);
      await step(`RDF 4.2 第 ${press} 次 Space（按键前剩余可滚距离 ${remaining} px > ${EDGE_PX} px）：章节不变，<main> 的 scrollTop 增大`, () => {
        expect(chapterOf(after), "URL 的 ch 与当前章节").toEqual(chapterOf(start));
        expect(after.main.scrollTop, "<main> 的 scrollTop").toBeGreaterThan(before.main.scrollTop);
      });
      before = after;
    }
    await step(`剩余可滚距离 ${remainingOf(before.main)} px ≤ ${EDGE_PX} px，再按 Space`, () =>
      page.keyboard.press(SPACE.key),
    );
    if (plan.next === null) throw new Error("长章没有下一个正文章节");
    await expectCurrentChapter(page, plan.book.facts, plan.next);
  });

  test(`RDF 4.2 <main> 的剩余可滚距离为 ${NEAR_END_REMAINING_PX} px（> 2 px）时按 Space：章节不变；此后剩余 ≤ 2 px，再按 Space 才渲染下一个正文章节`, async ({
    page,
    lib,
    bookLog,
  }) => {
    const plan = await longChapterPlan(lib);
    const start = await readerAt(page, bookLog, plan, "near-end");
    const after = await pressAndRead(page, start, SPACE);
    await expectDocumentNotScrollable(page);
    await expectSameChapter(after, start, `RDF 4.2 剩余 ${remainingOf(start.main)} px 时按 Space：`);
    await step(`按键后剩余可滚距离 ≤ ${EDGE_PX} px`, () => {
      expect(remainingOf(after.main), `<main> ${describeScroll(after.main)}`).toBeLessThanOrEqual(EDGE_PX);
    });
    await step("再按 Space", () => page.keyboard.press(SPACE.key));
    if (plan.next === null) throw new Error("长章没有下一个正文章节");
    await expectCurrentChapter(page, plan.book.facts, plan.next);
  });
});

// ---------------------------------------------------------------------------
// RDF 4.3 ↑ / ↓ / PageUp / PageDown（桌面，长章）
// ---------------------------------------------------------------------------

interface LineKeyCase extends KeyCase {
  /** 该键滚动的方向。 */
  motion: "down" | "up";
}

const LINE_KEYS: readonly LineKeyCase[] = [
  { label: "↓", key: "ArrowDown", motion: "down" },
  { label: "PageDown", key: "PageDown", motion: "down" },
  { label: "↑", key: "ArrowUp", motion: "up" },
  { label: "PageUp", key: "PageUp", motion: "up" },
];

/**
 * 把焦点放到 `<main>` 内的章末"下一章"按钮上（非输入类元素）：`focus({ preventScroll: true })`，聚焦本身
 * 不滚动正文。核对焦点在该按钮上、`<main>` 的 `scrollTop` 未变，返回聚焦后的读数。
 */
async function focusInsideMain(page: Page, before: ScrollSnapshot): Promise<ScrollSnapshot> {
  return step("把焦点放到 <main> 内的章末“下一章”按钮上（focus({ preventScroll: true })）", async () => {
    const target = reader(page).nextChapterEndButton;
    await target.evaluate((el) => {
      if (el instanceof HTMLElement) el.focus({ preventScroll: true });
    });
    await expect(target, "焦点应在章末“下一章”按钮上").toBeFocused();
    await waitFrames(page);
    const focused = await readSnapshot(page);
    expect(focused.main.scrollTop, "聚焦后 <main> 的 scrollTop 应不变").toBe(before.main.scrollTop);
    return focused;
  });
}

test.describe("RDF 4.3 ↑ / ↓ / PageUp / PageDown 滚动 Body_Scroller（桌面）", () => {
  for (const key of LINE_KEYS) {
    const verb = MOTION_LABELS[key.motion];
    const edge: StartPosition = key.motion === "down" ? "end" : "start";
    const edgeLabel = key.motion === "down" ? "已在最大可滚距离处" : "scrollTop 为 0";

    test(`RDF 4.3 焦点在 <body>、正文在章中时按 ${key.label}：<main> 的 scrollTop ${verb}，章节不变`, async ({
      page,
      lib,
      bookLog,
    }) => {
      const start = await readerAt(page, bookLog, await longChapterPlan(lib), "middle");
      const after = await pressAndRead(page, start, key);
      await expectMainMoved(page, after, start, key.motion, `RDF 4.3 ${key.label}：`);
      await expectSameChapter(after, start, `RDF 4.3 ${key.label}：`);
    });

    test(`RDF 4.3 焦点在 <body>、<main> ${edgeLabel}时按 ${key.label}：scrollTop 保持不变，章节不变`, async ({
      page,
      lib,
      bookLog,
    }) => {
      const start = await readerAt(page, bookLog, await longChapterPlan(lib), edge);
      const after = await pressAndRead(page, start, key);
      await expectMainMoved(page, after, start, "none", `RDF 4.3 ${key.label}（${edgeLabel}）：`);
      await expectSameChapter(after, start, `RDF 4.3 ${key.label}（${edgeLabel}）：`);
    });

    test(`RDF 4.3 焦点在 <main> 内的章末“下一章”按钮上、正文在章中时按 ${key.label}：<main> 的 scrollTop ${verb}，章节不变`, async ({
      page,
      lib,
      bookLog,
    }) => {
      const start = await readerAt(page, bookLog, await longChapterPlan(lib), "middle");
      const focused = await focusInsideMain(page, start);
      const after = await pressAndRead(page, focused, key);
      await expectMainMoved(page, after, focused, key.motion, `RDF 4.3 ${key.label}：`);
      await expectSameChapter(after, start, `RDF 4.3 ${key.label}：`);
    });
  }
});
