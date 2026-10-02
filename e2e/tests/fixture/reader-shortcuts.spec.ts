/**
 * 阅读器：键盘快捷键（需求 10.9–10.22；`reader-consolidation` 需求 9.4、差异表 C13）。`fixture` 项目
 * （:4611，Opaque_Mode），桌面视口，默认主题（不 `seedTheme`），不装 Controlled_Clock（不涉及时长）。
 *
 * ## 用书与章节（4.4：期望值运行时推导）
 *
 * 书为 `lib.role("longText")`（3.3 (h)(i) 的夹具书），章节取 `roles.json` 的 `longText.chapterIndex`：该书的
 * 长章节，须既非首个也非末个正文章节（不满足即为测试自身的问题，16.6）。10.9 / 10.10 的"上一个 / 下一个
 * 正文章节"取 `_toc.json` 非卷节点序列中的前一个 / 后一个（`TocFacts.bodyIndices`），卷节点因此自然跳过；
 * 这本书没有卷节点，跨卷段的 `←` / `→` 已由 `reader-volumes.spec.ts` 的 8.4 / 8.5 覆盖（按键与按钮各测一次）。
 *
 * ## 起始状态（`readerStart`；需求 10 的前言、设计"补充场景"10.9–10.22）
 *
 * 前言规定的起始状态有两部分：(a) "正文滚动容器"（`<main>` 地标）的最大可滚距离 ≥ 2 × `clientHeight`，
 * `scrollTop` 介于 2 px 与"最大可滚距离 − 2 px"之间；(b) 章节既非首也非末、三个抽屉均关闭、焦点在 `<body>`。
 *
 * `readerStart` 的做法：
 *
 * - 先核对文档滚动元素不可滚动（reader-defect-fixes 需求 2.1、14.2，`expectDocumentNotScrollable`），
 *   再按设计经 `getByRole("main")` 把 `<main>` 的 `scrollTop` 设为其 `clientHeight`，并对 `<main>` 硬性核对
 *   (a) 的两个不等式。正文因此确实停在章中，10.16–10.22 的"`scrollTop` 不变"不会因为停在 0 或最大值而恒真。
 * - (b) 照常建立并核对：三个抽屉的打开标志计数均为 0；`document.activeElement.blur()` 后焦点在 `<body>`。
 *
 * 历史：EV 验收时 `<main>` 不是滚动容器、实际滚动的是文档（Findings_Log F-002，已修复（reader-defect-fixes））。
 * 当时 `readerStart` 改对文档建立 (a)，`<main>` 上的 (a) 由 10.11、10.13–10.15 的预期失败用例以 `expect.soft`
 * 断言；修复后 (a) 直接在 `<main>` 上建立并核对，那几个用例改为普通用例。
 *
 * 起始状态的读数记在注解 `shortcut-start` 里，每次按键前后的读数记在 `shortcut-reading` 里。
 *
 * ## "章节不变"与 URL 的 `ch`
 *
 * 前言把"章节不变"定义为 URL 的 `ch` 不变。阅读器在每次定位（首次定位与各种换章）后以替换历史记录的
 * 方式把当前章写回 URL 的 `ch`（reader-defect-fixes 需求 7.1、D2），所以 URL 的 `ch` 随换章改变。本文件的
 * "章节不变"同时比较 URL 的 `ch` 与 8.1 所判定的当前章节（正文 `<h1>` 与"第 N / M 章"的文本）。
 * 10.9、10.10、10.12 的"URL 的 `ch` 变为上一个 / 下一个正文章节"在单独的用例中断言：写回在换章提交之后的
 * effect 里发起，路由状态的更新包在 transition 中，所以以正文切到目标章节为同步点后轮询 URL；同一条里
 * "渲染该章"的断言在另一个用例中。
 *
 * 历史：EV 验收时阅读器只读取 `?ch=`，阅读器内换章从不写回 URL（Findings_Log F-005，已修复
 * （reader-defect-fixes））。那时只比 URL 的"章节不变"恒真，于是同时比较两者；10.9、10.10、10.12 的 URL 一项
 * 按 16.7 拆成标题注明 F-005 的预期失败用例。修复后它们改为普通用例，用例划分、断言对象与期望值不变，URL 的
 * 读取由一次读数改为轮询（写回晚于正文渲染）。
 *
 * ## 翻页类快捷键（10.11–10.15）
 *
 * `Space` / `Shift+Space` / `Home` / `End` 都 `preventDefault()`（拦下浏览器的默认滚动），再只读写 `<main>`
 * （`contentContainerRef`）的滚动几何。10.11–10.15 的滚动断言按需求对 `<main>` 地标进行，起始状态 (a) 已由
 * `readerStart` 在 `<main>` 上核对；按键后、断言滚动之前再核对一次文档不可滚动（需求 2.1）。同一条里的滚动
 * 断言与"章节不变"分在两个用例中（10.11 的章节不变与滚动断言在同一用例）。
 *
 * 10.12 是 IF–THEN："剩余可滚距离 ≤ 2 px（先按 `End`）时按 `Space` 换到下一章"。用例先按 `End` 并对
 * `<main>` 核对条件（剩余可滚距离 ≤ 2 px），再按 `Space` 断言渲染下一个正文章节；URL 一项在单独的用例中。
 *
 * 历史：EV 验收时 `<main>` 没有可滚距离（Findings_Log F-002，已修复（reader-defect-fixes））：`Space` 在章中
 * 任何位置都被判为"已到章末"而直接换章，`Shift+Space` 不动，`Home` / `End` 的赋值无效，10.11、10.13–10.15
 * 的滚动断言按 16.7 拆成标题注明 F-002 的预期失败用例。修复后它们改为普通用例，用例划分与断言保持不变。
 *
 * ## 其余各条
 *
 * - 10.16–10.18：`T` / `F` / `S` 后对应抽屉的打开标志可见、另两个计数为 0，章节与 `scrollTop` 不变。
 *   `F` 打开的检索抽屉在 150 ms 后自动聚焦检索框（`SearchDrawer` 的 `setTimeout`），以检索框获得焦点作为
 *   比较前的同步点。
 * - 10.19：分别以 `T`、`F`、`S` 打开一个抽屉，`blur()` 让焦点回到 `<body>`（`F` 的情形先等自动聚焦发生，
 *   否则延时聚焦会在 `blur()` 之后把焦点拉回检索框），再按 `Esc`。
 * - 10.20：按 `F` 打开检索抽屉并聚焦检索框，依次按 10.9–10.19 的 10 个键，每次按键前核对焦点仍在检索框、
 *   按键后断言章节、`scrollTop` 与"只有检索抽屉打开"都不变；最后断言检索框的值为两个空格后接 `TFS`
 *   （`Home` / `End` 只移动插入点）。检索框是 `type="text"`，`Esc` 不清空它。
 * - 10.21：Ctrl / Alt / Meta × `→` / `Space` / `F` 共 9 个用例。Playwright 的按键经 CDP 派发给页面，不经操作
 *   系统与浏览器的快捷键处理（设计"补充场景"）。
 * - 10.22：选顶栏"添加书签"按钮（`Space` 激活它只切换书签，不跳章、不滚动正文；`readerAction` 对 `BUTTON`
 *   上的 `Space` 不接管）。聚焦后按 `Space`，断言按钮名称变为"已添加书签 (点击移除)"，章节与 `scrollTop` 不变。
 *
 * "`scrollTop` 不变"比较 `<main>` 的 `scrollTop`，比较前核对文档不可滚动（需求 2.1、14.2；与
 * `reader-search.spec.ts` 的 9.3、9.11 相同）。"不变"类断言在按键后等 2 个动画帧（`waitFrames`）再读一次
 * 比较，不用固定时长（设计"补充场景的定位与断言"）；"变为"类断言用会重试的 `expect`。
 */
import type { Page } from "@playwright/test";
import { expect, test, type BookLog, type Lib } from "../../support/fixtures";
import { NAMES, overlayMarkers, reader, searchDrawer } from "../../support/locators";
import {
  bookUnderTest,
  expectCurrentChapter,
  expectDocumentNotScrollable,
  openReader,
  readMainScroll,
  setMainScrollTop,
  waitFrames,
  type BookUnderTest,
  type MainScroll,
} from "../../support/reader";
import { step } from "../../support/step";

// ---------------------------------------------------------------------------
// 常量（取自需求条文）
// ---------------------------------------------------------------------------

/** 起始状态：最大可滚距离不少于 `clientHeight` 的倍数。 */
const START_SCREENS = 2;

/** 起始状态的 `scrollTop` 离两端的距离（px）；10.12 的剩余可滚距离与 10.15 的相差上限同为此值。 */
const EDGE_PX = 2;

/** 10.11 / 10.13 的增减量容差（px）。 */
const STEP_TOLERANCE_PX = 1;

/** 10.20：依次按下的键（10.9–10.19 的 10 个键）与它们在检索框里产生的文字。 */
const INPUT_KEYS: readonly KeyCase[] = [
  { label: "←", key: "ArrowLeft" },
  { label: "→", key: "ArrowRight" },
  { label: "Space", key: "Space" },
  { label: "Shift+Space", key: "Shift+Space" },
  { label: "Home", key: "Home" },
  { label: "End", key: "End" },
  { label: "T", key: "T" },
  { label: "F", key: "F" },
  { label: "S", key: "S" },
  { label: "Esc", key: "Escape" },
];
const INPUT_TYPED = "  TFS";

/** 10.21：修饰键与被组合的键。 */
const MODIFIERS: readonly KeyCase[] = [
  { label: "Ctrl", key: "Control" },
  { label: "Alt", key: "Alt" },
  { label: "Meta", key: "Meta" },
];
const MODIFIED_KEYS: readonly (KeyCase & { action: string })[] = [
  { label: "→", key: "ArrowRight", action: "下一章" },
  { label: "Space", key: "Space", action: "下翻" },
  { label: "F", key: "F", action: "打开检索抽屉" },
];

// ---------------------------------------------------------------------------
// 用书、章节与读数
// ---------------------------------------------------------------------------

interface KeyCase {
  /** 标题与步骤名里的写法。 */
  label: string;
  /** `page.keyboard.press` 的参数。 */
  key: string;
}

interface ShortcutPlan {
  book: BookUnderTest;
  /** 起始章节（`longText.chapterIndex`）的下标。 */
  chapter: number;
  /** 上一个 / 下一个正文章节的下标（跳过卷节点）。 */
  prev: number;
  next: number;
}

async function shortcutPlan(lib: Lib): Promise<ShortcutPlan> {
  const id = lib.role("longText");
  const book = await bookUnderTest(lib, id);
  return step("选定起始章节（roles.json longText.chapterIndex，既非首也非末的正文章节）", () => {
    const { facts } = book;
    const chapter = lib.fixtureRoles().longText.chapterIndex;
    const ordinal = facts.bodyOrdinals[chapter];
    if (ordinal === null || ordinal === undefined) {
      throw new Error(`${id}：longText.chapterIndex（下标 ${chapter}）不是正文章节`);
    }
    const prev = facts.bodyIndices[ordinal - 1];
    const next = facts.bodyIndices[ordinal + 1];
    if (prev === undefined || next === undefined) {
      throw new Error(
        `${id}：起始章节（下标 ${chapter}，正文第 ${ordinal + 1} / ${facts.bodyCount} 章）须既非首个也非末个正文章节`,
      );
    }
    test.info().annotations.push({
      type: "shortcut-start",
      description:
        `书 ${id}；起始章节 下标 ${chapter}「${facts.titles[chapter]}」；` +
        `上一个正文章节 下标 ${prev}「${facts.titles[prev]}」；下一个 下标 ${next}「${facts.titles[next]}」`,
    });
    return { book, chapter, prev, next };
  });
}

/** 三个抽屉是否打开（打开标志的计数 > 0）。 */
interface DrawerState {
  toc: boolean;
  search: boolean;
  settings: boolean;
}

const ALL_CLOSED: DrawerState = { toc: false, search: false, settings: false };

/** 一次读数：URL 的 `ch`、8.1 的当前章节、`<main>` 的滚动几何、三个抽屉的开闭。 */
interface ReaderSnapshot {
  /** URL 的 `ch` 查询参数；没有时为 null。 */
  ch: string | null;
  /** 正文 `<h1>` 的文本（8.1）。 */
  heading: string;
  /** "第 N / M 章"的文本（8.1）。 */
  position: string;
  main: MainScroll;
  drawers: DrawerState;
}

function urlCh(page: Page): Promise<string | null> {
  return page.evaluate(() => new URLSearchParams(window.location.search).get("ch"));
}

/** 读一次当前状态（只读；不等待变化）。 */
async function readSnapshot(page: Page): Promise<ReaderSnapshot> {
  const view = reader(page);
  const markers = overlayMarkers(page);
  const [ch, heading, position, main, toc, search, settings] = await Promise.all([
    urlCh(page),
    view.chapterHeading.textContent(),
    view.chapterPosition.textContent(),
    readMainScroll(page),
    markers.tocDrawer.count(),
    markers.searchDrawer.count(),
    markers.settingsDrawer.count(),
  ]);
  return {
    ch,
    heading: (heading ?? "").trim(),
    position: (position ?? "").trim(),
    main,
    drawers: { toc: toc > 0, search: search > 0, settings: settings > 0 },
  };
}

function describeScroll(m: MainScroll): string {
  return `scrollTop ${m.scrollTop}、clientHeight ${m.clientHeight}、scrollHeight ${m.scrollHeight}`;
}

function describeDrawers(d: DrawerState): string {
  const open = [d.toc ? "目录" : null, d.search ? "检索" : null, d.settings ? "设置" : null].filter(
    (x): x is string => x !== null,
  );
  return open.length > 0 ? `${open.join("、")}抽屉打开` : "抽屉均关闭";
}

function describeSnapshot(s: ReaderSnapshot): string {
  return (
    `ch=${s.ch ?? "（无）"}「${s.heading}」${s.position}；<main> ${describeScroll(s.main)}；` +
    describeDrawers(s.drawers)
  );
}

/** "章节不变"比较的内容：URL 的 `ch`（前言的定义）与 8.1 的当前章节（见文件头"章节不变"与 URL 的 `ch`）。 */
function chapterOf(s: ReaderSnapshot): { ch: string | null; heading: string; position: string } {
  return { ch: s.ch, heading: s.heading, position: s.position };
}

// ---------------------------------------------------------------------------
// 起始状态
// ---------------------------------------------------------------------------

interface ReaderStart {
  plan: ShortcutPlan;
  /** 起始状态的读数。 */
  state: ReaderSnapshot;
}

/** 起始状态 (a) 对 `<main>` 的两个不等式；返回不满足的项（空数组即满足）。 */
function startStateProblems(m: MainScroll): string[] {
  const max = m.scrollHeight - m.clientHeight;
  const problems: string[] = [];
  if (max < START_SCREENS * m.clientHeight) {
    problems.push(`最大可滚距离 ${max} < ${START_SCREENS} × clientHeight（${m.clientHeight}）`);
  }
  if (m.scrollTop < EDGE_PX || m.scrollTop > max - EDGE_PX) {
    problems.push(`scrollTop ${m.scrollTop} 不在 [${EDGE_PX}, ${max - EDGE_PX}] 内`);
  }
  return problems;
}

/**
 * 10.9–10.22 的共用前置（见文件头"起始状态"）：打开起始章节，把正文滚到章中，确认三个抽屉均关闭，
 * 让焦点回到 `<body>`。返回起始状态的读数。
 */
async function readerStart(page: Page, bookLog: BookLog, plan: ShortcutPlan): Promise<ReaderStart> {
  const { book, chapter } = plan;
  await openReader(page, bookLog, book, chapter);
  await expectCurrentChapter(page, book.facts, chapter);

  await step("起始状态：把正文滚到章中（<main> 的 scrollTop 设为其 clientHeight）", async () => {
    await expectDocumentNotScrollable(page);
    // 设计原文：经 getByRole("main").evaluate 把 scrollTop 设为 clientHeight
    await setMainScrollTop(page, (await readMainScroll(page)).clientHeight);
    await waitFrames(page);
    const main = await readMainScroll(page);
    expect(
      startStateProblems(main),
      `正文滚动容器 <main> 应满足起始状态：最大可滚距离 ≥ ${START_SCREENS} × clientHeight，` +
        `scrollTop 介于 ${EDGE_PX} px 与最大可滚距离 − ${EDGE_PX} px 之间（${describeScroll(main)}）`,
    ).toEqual([]);
  });

  await step("起始状态：三个抽屉均关闭", async () => {
    const markers = overlayMarkers(page);
    await expect(markers.tocDrawer, "目录抽屉").toHaveCount(0);
    await expect(markers.searchDrawer, "检索抽屉").toHaveCount(0);
    await expect(markers.settingsDrawer, "设置抽屉").toHaveCount(0);
  });
  await blurToBody(page, "起始状态：document.activeElement.blur()，焦点回到 <body>");

  const state = await readSnapshot(page);
  test.info().annotations.push({ type: "shortcut-start", description: describeSnapshot(state) });
  return { plan, state };
}

/** `document.activeElement.blur()`，并核对焦点在 `<body>` 上。 */
async function blurToBody(page: Page, title: string): Promise<void> {
  await step(title, async () => {
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

// ---------------------------------------------------------------------------
// 按键与断言
// ---------------------------------------------------------------------------

/** 按下 `key`，等 2 个动画帧后读一次状态，前后读数记入注解 `shortcut-reading`。 */
async function pressAndRead(page: Page, before: ReaderSnapshot, key: KeyCase): Promise<ReaderSnapshot> {
  await step(`按 ${key.label}`, () => page.keyboard.press(key.key));
  return step("等 2 个动画帧后读取章节、滚动位置与抽屉状态", async () => {
    await waitFrames(page);
    const after = await readSnapshot(page);
    test.info().annotations.push({
      type: "shortcut-reading",
      description: `${key.label}：按键前 ${describeSnapshot(before)} → 按键后 ${describeSnapshot(after)}`,
    });
    return after;
  });
}

/** 章节不变：URL 的 `ch` 与 8.1 的当前章节都与 `before` 相同。 */
async function expectSameChapter(after: ReaderSnapshot, before: ReaderSnapshot, item: string): Promise<void> {
  await step(`${item} 章节不变（URL 的 ch 与正文 <h1>、“第 N / M 章”）`, () => {
    expect(chapterOf(after), "URL 的 ch 与当前章节").toEqual(chapterOf(before));
  });
}

/** `scrollTop` 不变：先核对文档不可滚动（需求 2.1），再比较 `<main>` 的 `scrollTop` 与 `before` 相同。 */
async function expectSameScroll(
  page: Page,
  after: ReaderSnapshot,
  before: ReaderSnapshot,
  item: string,
): Promise<void> {
  await expectDocumentNotScrollable(page);
  await step(`${item} scrollTop 不变（<main> ${before.main.scrollTop}）`, () => {
    expect(after.main.scrollTop, "<main> 的 scrollTop").toBe(before.main.scrollTop);
  });
}

async function expectDrawers(after: ReaderSnapshot, expected: DrawerState, item: string): Promise<void> {
  await step(`${item} ${describeDrawers(expected)}`, () => {
    expect(after.drawers, "三个抽屉的开闭").toEqual(expected);
  });
}

// ---------------------------------------------------------------------------
// 10.9 / 10.10 章节导航
// ---------------------------------------------------------------------------

interface NavCase {
  item: string;
  key: KeyCase;
  side: "prev" | "next";
  label: string;
  consistent: string;
}

const NAV_CASES: readonly NavCase[] = [
  { item: "10.9", key: { label: "←", key: "ArrowLeft" }, side: "prev", label: "上一个", consistent: "8.5" },
  { item: "10.10", key: { label: "→", key: "ArrowRight" }, side: "next", label: "下一个", consistent: "8.4" },
];

test.describe("10.9 10.10 ← / → 换章", () => {
  for (const nav of NAV_CASES) {
    test(`${nav.item} 按 ${nav.key.label}：渲染${nav.label}正文章节（跳过卷节点，与 ${nav.consistent} 一致）`, async ({
      page,
      lib,
      bookLog,
    }) => {
      const start = await readerStart(page, bookLog, await shortcutPlan(lib));
      const { facts } = start.plan.book;
      await step(`按 ${nav.key.label}`, () => page.keyboard.press(nav.key.key));
      await expectCurrentChapter(page, facts, start.plan[nav.side]);
    });

    test(`${nav.item} 按 ${nav.key.label}：URL 的 ch 变为${nav.label}正文章节的下标`, async ({
      page,
      lib,
      bookLog,
    }) => {
      const start = await readerStart(page, bookLog, await shortcutPlan(lib));
      const { facts } = start.plan.book;
      const target = start.plan[nav.side];
      await step(`按 ${nav.key.label}`, () => page.keyboard.press(nav.key.key));
      await step(`等正文切到${nav.label}正文章节「${facts.titles[target]}」（同步点）`, async () => {
        await expect(reader(page).chapterHeading).toHaveText(facts.titles[target]);
        await waitFrames(page);
      });
      await step(`${nav.item} URL 的 ch 为 ${target}`, async () => {
        let last: string | null = null;
        try {
          await expect
            .poll(
              async () => {
                last = await urlCh(page);
                return last;
              },
              { message: "URL 的 ch" },
            )
            .toBe(String(target));
        } finally {
          const ch = last as string | null;
          test.info().annotations.push({
            type: "shortcut-reading",
            description: `${nav.key.label}：按键前 URL ch=${start.state.ch ?? "（无）"}，换章后 ch=${ch ?? "（无）"}（期望 ${target}）`,
          });
        }
      });
    });
  }
});

// ---------------------------------------------------------------------------
// 10.11 10.12 Space
// ---------------------------------------------------------------------------

const SPACE: KeyCase = { label: "Space", key: "Space" };
const SHIFT_SPACE: KeyCase = { label: "Shift+Space", key: "Shift+Space" };
const HOME: KeyCase = { label: "Home", key: "Home" };
const END: KeyCase = { label: "End", key: "End" };

test.describe("10.11 10.12 Space 下翻", () => {
  test("10.11 按 Space：<main> 的 scrollTop 增大，增量不超过 clientHeight、不小于 min(clientHeight / 2, 剩余可滚距离)（容差 1 px），章节不变", async ({
    page,
    lib,
    bookLog,
  }) => {
    const start = await readerStart(page, bookLog, await shortcutPlan(lib));
    const before = start.state;
    const after = await pressAndRead(page, before, SPACE);
    await expectDocumentNotScrollable(page);
    await step("10.11 <main> 的 scrollTop 增量在 (0, clientHeight] 内且不小于 min(clientHeight / 2, 按键前剩余可滚距离)", () => {
      const { clientHeight, scrollTop, scrollHeight } = before.main;
      const remaining = scrollHeight - clientHeight - scrollTop;
      const delta = after.main.scrollTop - scrollTop;
      const floor = Math.min(clientHeight / 2, remaining);
      const problems: string[] = [];
      if (delta <= 0) problems.push(`增量 ${delta} ≤ 0`);
      if (delta > clientHeight + STEP_TOLERANCE_PX) problems.push(`增量 ${delta} > clientHeight ${clientHeight}`);
      if (delta < floor - STEP_TOLERANCE_PX) problems.push(`增量 ${delta} < min(${clientHeight / 2}, ${remaining})`);
      expect(problems, `<main> scrollTop ${scrollTop} → ${after.main.scrollTop}`).toEqual([]);
    });
    await expectSameChapter(after, before, "10.11");
  });

  test("10.12 先按 End 使 <main> 的剩余可滚距离 ≤ 2 px，再按 Space：渲染下一个正文章节", async ({
    page,
    lib,
    bookLog,
  }) => {
    const start = await readerStart(page, bookLog, await shortcutPlan(lib));
    const atEnd = await pressAndRead(page, start.state, END);
    await expectDocumentNotScrollable(page);
    await step("10.12 条件：<main> 的剩余可滚距离 ≤ 2 px", () => {
      const { scrollTop, clientHeight, scrollHeight } = atEnd.main;
      expect(scrollHeight - clientHeight - scrollTop, `<main> ${describeScroll(atEnd.main)}`).toBeLessThanOrEqual(
        EDGE_PX,
      );
    });
    await step("按 Space", () => page.keyboard.press(SPACE.key));
    await expectCurrentChapter(page, start.plan.book.facts, start.plan.next);
  });

  test("10.12 先按 End 再按 Space：URL 的 ch 变为下一个正文章节的下标", async ({ page, lib, bookLog }) => {
    const start = await readerStart(page, bookLog, await shortcutPlan(lib));
    const { facts } = start.plan.book;
    const target = start.plan.next;
    await pressAndRead(page, start.state, END);
    await step("按 Space", () => page.keyboard.press(SPACE.key));
    await step(`等正文切到下一个正文章节「${facts.titles[target]}」（同步点）`, async () => {
      await expect(reader(page).chapterHeading).toHaveText(facts.titles[target]);
      await waitFrames(page);
    });
    await step(`10.12 URL 的 ch 为 ${target}`, async () => {
      await expect.poll(() => urlCh(page), { message: "URL 的 ch" }).toBe(String(target));
    });
  });
});

// ---------------------------------------------------------------------------
// 10.13 Shift+Space
// ---------------------------------------------------------------------------

test.describe("10.13 Shift+Space 上翻", () => {
  test("10.13 按 Shift+Space：章节不变", async ({ page, lib, bookLog }) => {
    const start = await readerStart(page, bookLog, await shortcutPlan(lib));
    const after = await pressAndRead(page, start.state, SHIFT_SPACE);
    await expectSameChapter(after, start.state, "10.13");
  });

  test("10.13 按 Shift+Space：<main> 的 scrollTop 减小，减量不超过 clientHeight、不小于 min(clientHeight / 2, 按键前 scrollTop)（容差 1 px）", async ({
    page,
    lib,
    bookLog,
  }) => {
    const start = await readerStart(page, bookLog, await shortcutPlan(lib));
    const before = start.state;
    const after = await pressAndRead(page, before, SHIFT_SPACE);
    await expectDocumentNotScrollable(page);
    await step("10.13 <main> 的 scrollTop 减量在 (0, clientHeight] 内且不小于 min(clientHeight / 2, 按键前 scrollTop)", () => {
      const { clientHeight, scrollTop } = before.main;
      const delta = scrollTop - after.main.scrollTop;
      const floor = Math.min(clientHeight / 2, scrollTop);
      const problems: string[] = [];
      if (delta <= 0) problems.push(`减量 ${delta} ≤ 0`);
      if (delta > clientHeight + STEP_TOLERANCE_PX) problems.push(`减量 ${delta} > clientHeight ${clientHeight}`);
      if (delta < floor - STEP_TOLERANCE_PX) problems.push(`减量 ${delta} < min(${clientHeight / 2}, ${scrollTop})`);
      expect(problems, `<main> scrollTop ${scrollTop} → ${after.main.scrollTop}`).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// 10.14 10.15 Home / End
// ---------------------------------------------------------------------------

test.describe("10.14 10.15 Home / End", () => {
  test("10.14 按 Home：章节不变", async ({ page, lib, bookLog }) => {
    const start = await readerStart(page, bookLog, await shortcutPlan(lib));
    const after = await pressAndRead(page, start.state, HOME);
    await expectSameChapter(after, start.state, "10.14");
  });

  test("10.14 按 Home：<main> 的 scrollTop 由起始状态（介于 2 px 与最大可滚距离 − 2 px）变为 0", async ({
    page,
    lib,
    bookLog,
  }) => {
    const start = await readerStart(page, bookLog, await shortcutPlan(lib));
    const after = await pressAndRead(page, start.state, HOME);
    await expectDocumentNotScrollable(page);
    await step("10.14 <main> 的 scrollTop 为 0", () => {
      expect(after.main.scrollTop, `<main> ${describeScroll(after.main)}`).toBe(0);
    });
  });

  test("10.15 按 End：章节不变", async ({ page, lib, bookLog }) => {
    const start = await readerStart(page, bookLog, await shortcutPlan(lib));
    const after = await pressAndRead(page, start.state, END);
    await expectSameChapter(after, start.state, "10.15");
  });

  test("10.15 按 End：<main> 的 scrollTop 由起始状态变为与 scrollHeight − clientHeight 相差 ≤ 2 px", async ({
    page,
    lib,
    bookLog,
  }) => {
    const start = await readerStart(page, bookLog, await shortcutPlan(lib));
    const after = await pressAndRead(page, start.state, END);
    await expectDocumentNotScrollable(page);
    await step("10.15 <main> 的 scrollTop 与 scrollHeight − clientHeight 相差 ≤ 2 px", () => {
      const { scrollTop, clientHeight, scrollHeight } = after.main;
      expect(Math.abs(scrollHeight - clientHeight - scrollTop), `<main> ${describeScroll(after.main)}`).toBeLessThanOrEqual(
        EDGE_PX,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// 10.16–10.19 抽屉开关
// ---------------------------------------------------------------------------

interface DrawerCase {
  item: string;
  key: KeyCase;
  name: string;
  open: DrawerState;
}

const DRAWER_CASES: readonly DrawerCase[] = [
  { item: "10.16", key: { label: "T", key: "T" }, name: "目录", open: { ...ALL_CLOSED, toc: true } },
  { item: "10.17", key: { label: "F", key: "F" }, name: "检索", open: { ...ALL_CLOSED, search: true } },
  { item: "10.18", key: { label: "S", key: "S" }, name: "设置", open: { ...ALL_CLOSED, settings: true } },
];

/** 按下抽屉快捷键，等对应抽屉的打开标志可见；检索抽屉另等检索框获得焦点（延时 150 ms 的自动聚焦）。 */
async function openDrawerByKey(page: Page, drawer: DrawerCase): Promise<void> {
  await step(`按 ${drawer.key.label}`, () => page.keyboard.press(drawer.key.key));
  await step(`等${drawer.name}抽屉打开`, async () => {
    const markers = overlayMarkers(page);
    const marker = drawer.open.toc ? markers.tocDrawer : drawer.open.search ? markers.searchDrawer : markers.settingsDrawer;
    await expect(marker, `${drawer.name}抽屉的打开标志`).toBeVisible();
    if (drawer.open.search) {
      await expect(searchDrawer(page).input, "检索框应已获得焦点（抽屉打开后的自动聚焦，同步点）").toBeFocused();
    }
  });
}

test.describe("10.16–10.18 T / F / S 打开抽屉", () => {
  for (const drawer of DRAWER_CASES) {
    test(`${drawer.item} 按 ${drawer.key.label}：打开${drawer.name}抽屉，另两个抽屉保持关闭，章节与 scrollTop 不变`, async ({
      page,
      lib,
      bookLog,
    }) => {
      const start = await readerStart(page, bookLog, await shortcutPlan(lib));
      await openDrawerByKey(page, drawer);
      const after = await step("等 2 个动画帧后读取章节、滚动位置与抽屉状态", async () => {
        await waitFrames(page);
        const snapshot = await readSnapshot(page);
        test.info().annotations.push({
          type: "shortcut-reading",
          description: `${drawer.key.label}：按键前 ${describeSnapshot(start.state)} → 按键后 ${describeSnapshot(snapshot)}`,
        });
        return snapshot;
      });
      await expectDrawers(after, drawer.open, drawer.item);
      await expectSameChapter(after, start.state, drawer.item);
      await expectSameScroll(page, after, start.state, drawer.item);
    });
  }
});

test.describe("10.19 Esc 关闭抽屉", () => {
  for (const drawer of DRAWER_CASES) {
    test(`10.19 以 ${drawer.key.label} 打开${drawer.name}抽屉、焦点不在输入类元素上时按 Esc：关闭全部抽屉，章节与 scrollTop 不变`, async ({
      page,
      lib,
      bookLog,
    }) => {
      const start = await readerStart(page, bookLog, await shortcutPlan(lib));
      await openDrawerByKey(page, drawer);
      await blurToBody(page, "document.activeElement.blur()：焦点离开检索框等输入类元素，回到 <body>");
      const opened = await readSnapshot(page);
      const after = await pressAndRead(page, opened, { label: "Esc", key: "Escape" });
      await expectDrawers(after, ALL_CLOSED, "10.19");
      await expectSameChapter(after, start.state, "10.19");
      await expectSameScroll(page, after, start.state, "10.19");
    });
  }
});

// ---------------------------------------------------------------------------
// 10.20 焦点在输入类元素上
// ---------------------------------------------------------------------------

test.describe("10.20 焦点在检索框里", () => {
  test("10.20 焦点在检索抽屉的输入框上时依次按 10.9–10.19 的键：章节、scrollTop 与三个抽屉的开闭都不变，输入框照常编辑", async ({
    page,
    lib,
    bookLog,
  }) => {
    const start = await readerStart(page, bookLog, await shortcutPlan(lib));
    const input = searchDrawer(page).input;
    await openDrawerByKey(page, DRAWER_CASES[1]);
    await step("聚焦检索框", async () => {
      await input.focus();
      await expect(input).toBeFocused();
      await expect(input, "检索框初始为空").toHaveValue("");
    });
    const opened = await readSnapshot(page);
    await expectDrawers(opened, { ...ALL_CLOSED, search: true }, "10.20 前提：");
    await expectSameScroll(page, opened, start.state, "10.20 前提：打开检索抽屉后");

    for (const key of INPUT_KEYS) {
      await step(`按 ${key.label} 前焦点仍在检索框`, async () => {
        await expect(input).toBeFocused();
      });
      const after = await pressAndRead(page, opened, key);
      await expectSameChapter(after, opened, `10.20 ${key.label}：`);
      await expectSameScroll(page, after, opened, `10.20 ${key.label}：`);
      await expectDrawers(after, opened.drawers, `10.20 ${key.label}：仍只有`);
    }

    await step(`10.20 检索框的值为 ${JSON.stringify(INPUT_TYPED)}（两个空格后接 TFS；Home / End 只移动插入点）`, async () => {
      await expect(input).toHaveValue(INPUT_TYPED);
    });
  });
});

// ---------------------------------------------------------------------------
// 10.21 修饰键组合
// ---------------------------------------------------------------------------

test.describe("10.21 Ctrl / Alt / Meta 组合不接管", () => {
  for (const modifier of MODIFIERS) {
    for (const key of MODIFIED_KEYS) {
      const combo: KeyCase = { label: `${modifier.label}+${key.label}`, key: `${modifier.key}+${key.key}` };
      test(`10.21 按 ${combo.label}：不执行“${key.action}”，章节、scrollTop 与三个抽屉的开闭状态不变`, async ({
        page,
        lib,
        bookLog,
      }) => {
        const start = await readerStart(page, bookLog, await shortcutPlan(lib));
        const after = await pressAndRead(page, start.state, combo);
        await expectSameChapter(after, start.state, "10.21");
        await expectSameScroll(page, after, start.state, "10.21");
        await expectDrawers(after, ALL_CLOSED, "10.21");
      });
    }
  }
});

// ---------------------------------------------------------------------------
// 10.22 焦点在按钮上
// ---------------------------------------------------------------------------

test.describe("10.22 焦点在按钮上", () => {
  test("10.22 焦点在顶栏“添加书签”按钮上时按 Space：按钮照常激活（书签已添加），章节与 scrollTop 不因翻页快捷键改变", async ({
    page,
    lib,
    bookLog,
  }) => {
    const start = await readerStart(page, bookLog, await shortcutPlan(lib));
    const view = reader(page);
    await step("聚焦顶栏“添加书签”按钮", async () => {
      await expect(view.bookmarkButton, "当前章没有书签").toHaveAccessibleName(NAMES.addBookmark);
      await view.addBookmarkButton.focus();
      await expect(view.addBookmarkButton).toBeFocused();
    });
    const focused = await readSnapshot(page);
    await expectSameScroll(page, focused, start.state, "10.22 前提：聚焦按钮后");
    const after = await pressAndRead(page, focused, SPACE);
    await step("10.22 按钮照常激活：可访问名称变为“已添加书签 (点击移除)”", async () => {
      await expect(view.bookmarkButton).toHaveAccessibleName(NAMES.removeBookmark);
    });
    await expectSameChapter(after, focused, "10.22");
    await expectSameScroll(page, after, focused, "10.22");
  });
});
