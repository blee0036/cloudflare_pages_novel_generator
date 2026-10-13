/**
 * 阅读器：分页模式（翻页模式需求 2.5、2.9、3.1、3.2、3.5–3.10、4.7、4.8、4.10、4.11、12.3、12.8、15.3）。
 * `fixture` 项目（:4611，Opaque_Mode），桌面视口，默认主题（不 `seedTheme`）。每个用例在首次导航之前以
 * `seedPageMode` 把翻页模式设为覆盖（`pageAnim` 0）：覆盖模式的拖拽在当前页图层上有可读的平移量，便于核对
 * "拖过半屏"。项目默认以 `prefers-reduced-motion: reduce` 运行（6.3），那样覆盖模式会按无动画翻页、拖拽中页面
 * 静止（需求 9.2、9.3），所以本文件以 `test.use` 把 `reducedMotion` 覆盖为 `no-preference`（不拍 Review_Shot）。
 * 不装 Controlled_Clock：翻页动画、长按 600 ms 与按键闸门都按真实时间走。用例标题以 `PTM <需求编号>` 开头。
 *
 * ## 用书（4.4：期望值运行时推导）
 *
 * 一律用 `lib.role("longText")`：长章 `roles.json longText.chapterIndex` 在桌面视口下分成多页，其后还有正文
 * 章节；检索词为 `longText.fewKeyword`。全书首末取 `TocFacts` 的首个与末个正文章节。
 *
 * ## 读数
 *
 * - 当前页一律读 `<main>` 与当前页图层的测试钩子（`readPagedView`：`data-turning`、`data-chapter-id`、
 *   `data-page-index`、`data-page-count`、`data-page-start`；design §4.5、§6.4）。翻页由应用的 rAF 推进，
 *   "落定"以轮询 `data-turning="false"` 且当前页为期望值判定（`waitPageAt`），不用固定时长。
 * - "这期间没有翻页"用 `<main>` 上的 MutationObserver 记录 `data-turning` 是否出现过 `"true"`
 *   （`watchTurning`），不靠抽样。
 * - 底栏页码读 `<footer>`（contentinfo）里的可见文字 `x / y` 与读屏文本"本章第 x 页，共 y 页"（需求 2.9）。
 *
 * ## 各条的做法
 *
 * - 4.7 / 4.8 拖拽：在长章第 1 页的 `<main>` 上按下鼠标（宽 85%、高 50% 处），先左移 20 px 越过 Touch_Slop
 *   并等 2 帧（让"起步"以这一点为起点，design §6.1），再分 12 步左拖到宽 25% 处，等 2 帧。此时
 *   `data-turning="true"`、当前页仍是拖拽前那页，且当前页图层的 `translateX` 左移超过半个视口宽（覆盖模式
 *   NEXT 的移动层即当前页，需求 4.4、6.1）。完成：直接释放，落定后页码 +1、页首偏移变大，底栏页码随之更新。
 *   取消：再一次性右移到宽 60% 处（不越过起点，不换向；最后一次移动背离 NEXT），等 2 帧后释放，落定后页码不变。
 * - 3.1 / 3.2 / 3.9 / 3.10 双向跨章：以 `?ch=<长章>` 打开，`End` 到本章末页（前置：不止一页），核对正文里没有
 *   章末导航卡（需求 12.8）；`PageDown` → 下一个正文章节第 1 页（8.1 的当前章判定可用：标题区在第 1 页），
 *   `PageUp` → 长章末页（页数与 `End` 时相同）。每次跨章后核对 URL 恰有一个 `ch` 且为新章下标、
 *   `history.length` 与打开时相同（替换历史记录项），章节滑杆的值为新章的正文序号，目录抽屉（按 `T` 打开）
 *   中唯一带 `aria-current` 的行是新章，底栏页码为新页。
 * - 3.5–3.8 边界提示：全书首个正文章节第 1 页按 `PageUp`，出现"没有上一页"；提示可见时再向右拖拽一次（同一
 *   边界，需求 4.3 的起步无页），`role="status"` 的实时区域仍恰有 1 个、文字仍为"没有上一页"，整页这段文字只出现
 *   一次，当前页不变且全程没有翻页。全书末个正文章节 `End` 到末页（核对没有章末导航卡）后按 `PageDown`、再向左
 *   拖拽，对称地核对"没有下一页"。
 * - 12.3 检索：从首个正文章节打开检索抽屉，点击检索词在正文章节内（不在标题行）章内偏移最大的那条命中。落定后
 *   当前页为命中章节、`data-page-start ≤ 命中章内偏移`（前置：不是第 1 页，否则这条核对没有分量），正文恰有 1 个
 *   `<mark>`、位于当前页图层内、文字是检索词的前缀（命中可以跨页，`fragmentHighlight` 只在命中起点所在页标出
 *   起点那一截）；再按 `PageDown`，下一页的页首偏移 > 命中章内偏移（命中在本章末页时以章长为界）。
 * - 2.5 改字号：同样经检索把 Reading_Position 落在页中间（命中章内偏移 P，不吸附到页首，design §3.3），核对
 *   `data-page-start ≤ P`；按 `S` 打开设置抽屉点 "A+" 4 次、`Esc` 关闭，等当前页 `<article>` 的计算字号变为新值
 *   且翻页落定，核对仍在命中章节、`data-page-start ≤ P`；再按 `PageDown`，下一页页首 > P（或 P 在本章末页）。
 * - 2.5 连续改字号：同样经检索落到 P，打开设置抽屉。点 "A+" 之前在 `<main>` 内的 `MeasureBox`
 *   （`[data-measure-box]`）上挂一个 MutationObserver：第一次改字号让当前章按新字号分页完成（`data-paginated`
 *   含命中章节、当前页 `<article>` 为新字号）之后，分页器在空闲回调里给相邻章分页，盒子里挂上的是别的章（`<h1>`
 *   不是命中章节的标题）。观察者在这一刻的回调里（空闲回调刚结束、React 还没处理它排下的低优先级更新）对 "A+"
 *   调用 `click()`，第二次改字号恰好落在相邻章后台分页途中；按真实时间连点两次赶不上这个窗口，不可复现。随后等
 *   当前页为最终字号、翻页落定且 `data-paginated` 含命中章节（当前章已按最终 `layoutKey` 分页，不是上一次的页表），
 *   核对仍含 P、当前页每一行文字的底边都在页面内容盒之内（页表出自最终字号：旧页表下大字号的正文会溢出页底），
 *   再按 `PageDown`，下一页页首 > P。
 * - 4.10 长按：在当前页第一个段落的第 5 个字上按下鼠标不动，按住期间轮询选区，非空时记下自按下起的耗时
 *   （应 ≥ 600 ms），再松开。选区仍非空、锚点在当前页图层内，页码不变且全程没有翻页。
 * - 4.11 底栏拖拽：控制栏可见时，在 `<footer>` 右端留白处按下（核对该点最上层的元素在底栏内且不是控件），横向
 *   拖到左端留白处再松开。页码、章节滑杆与 URL 的 `ch` 都不变，全程没有翻页。
 *
 * 所选的书、章节、命中与读数记在注解 `paged-plan`、`paged-reading` 里。
 */
import type { JSHandle, Locator, Page } from "@playwright/test";
import { PAGE_ANIM } from "../../../src/utils/pageAnim";
import { PAGE_PAD_BOTTOM } from "../../../src/utils/paginate";
import { LONG_PRESS_MS, TOUCH_SLOP_PX } from "../../../src/utils/pageGesture";
import { SLIDER_SPECS } from "../../../src/utils/sliderSettings";
import { KEY_TURN_GAP_MS } from "../../../src/utils/turnInput";
import { expect, test, type BookLog, type Lib } from "../../support/fixtures";
import type { TocFacts } from "../../support/library";
import { reader, readerJumpHighlight, searchDrawer, settingsDrawer, tocDrawer } from "../../support/locators";
import {
  bookText,
  bookUnderTest,
  expectCurrentChapter,
  findOccurrences,
  openReader,
  openSearchDrawer,
  pageModeSpec,
  readControlsVisible,
  readPagedView,
  readSearchResults,
  readTocList,
  reshowControls,
  seedPageMode,
  urlChapterParams,
  waitFrames,
  type BookUnderTest,
  type CurrentPage,
  type PagedViewReading,
} from "../../support/reader";
import { step } from "../../support/step";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 本文件的翻页模式：覆盖（需求 6.1、6.2）。 */
const MODE = pageModeSpec(PAGE_ANIM.cover);

/** 检索结果的条数上限（EV 9.1）。 */
const RESULT_CAP = 150;

/**
 * 两次同方向翻页键之间的最短间隔：不足 `KEY_TURN_GAP_MS` 会被闸门忽略（需求 11.6），多留 50 ms 余量。
 * 应用按真实时间计这个闸门，只能按时长等。
 */
const KEY_GAP_MS = KEY_TURN_GAP_MS + 50;

/** 拖拽的纵向位置与按下点（占 `<main>` 宽 / 高的比例）。 */
const DRAG_FY = 0.5;
const DRAG_PRESS_FX = 0.85;
/** 越过 Touch_Slop 的第一步（px）：之后等 2 帧，让拖拽的起点落在这里（design §6.1 的"起步"）。 */
const DRAG_FIRST_STEP_PX = 20;
/** 左拖的终点：自按下点左移 60% 宽，越过半屏（扣掉第一步的 20 px 后仍余 100 px 以上）。 */
const DRAG_FAR_FX = 0.25;
/** 左拖的步数（`page.mouse.move` 的 `steps`）。 */
const DRAG_STEPS = 12;
/** 取消：回拖一步到这里。在起点之左（不换向），在左拖途经的各点之右（最后一次移动背离 NEXT，需求 4.8）。 */
const DRAG_BACK_FX = 0.6;

/** 边界上的拖拽：向右（PREV）从 15% 拖到 70%，向左（NEXT）从 85% 拖到 25%。 */
const PREV_DRAG = { from: 0.15, to: 0.7 } as const;
const NEXT_DRAG = { from: DRAG_PRESS_FX, to: DRAG_FAR_FX } as const;

/** 改字号：点 "A+" 的次数（每次 +`SLIDER_SPECS.fontSize.step` px）。 */
const FONT_CLICKS = 4;

/** 长按选中的字：当前页第一个段落的第几个字（下标，从 0 起；段落更短时取末字）。 */
const LONG_PRESS_CHAR = 4;

/** 底栏拖拽的起止点距底栏左右边缘的距离（px）：落在 `<footer>` 的水平内边距里，不在任何控件上。 */
const FOOTER_EDGE_PX = 12;

// ---------------------------------------------------------------------------
// 用书
// ---------------------------------------------------------------------------

interface PagedPlan {
  book: BookUnderTest;
  /** 长章（`longText.chapterIndex`）。 */
  chapter: number;
  /** 其后的下一个正文章节。 */
  next: number;
  /** 首个、末个正文章节。 */
  firstBody: number;
  lastBody: number;
}

async function pagedPlan(lib: Lib): Promise<PagedPlan> {
  const id = lib.role("longText");
  const book = await bookUnderTest(lib, id);
  return step("选定长章（roles.json longText.chapterIndex，其后还有正文章节）与全书首末正文章节", () => {
    const { facts } = book;
    const chapter = lib.fixtureRoles().longText.chapterIndex;
    const ordinal = facts.bodyOrdinals[chapter];
    if (ordinal === null || ordinal === undefined) {
      throw new Error(`${id}：longText.chapterIndex（下标 ${chapter}）不是正文章节`);
    }
    const next = facts.bodyIndices[ordinal + 1];
    if (next === undefined) throw new Error(`${id}：长章（下标 ${chapter}）之后没有正文章节`);
    const firstBody = facts.bodyIndices[0];
    const lastBody = facts.bodyIndices[facts.bodyCount - 1];
    test.info().annotations.push({
      type: "paged-plan",
      description:
        `书 ${id}；长章 下标 ${chapter}「${facts.titles[chapter]}」；下一个正文章节 下标 ${next}；` +
        `首个正文章节 下标 ${firstBody}；末个正文章节 下标 ${lastBody}`,
    });
    return { book, chapter, next, firstBody, lastBody };
  });
}

/** 一处检索命中（检索抽屉里的一条结果）。 */
interface HitPlan {
  keyword: string;
  /** 检索抽屉列出的结果条数（`min(K, RESULT_CAP)`）。 */
  shown: number;
  /** 这条命中在结果列表中的下标。 */
  index: number;
  /** 所在正文章节的下标与标题。 */
  chapter: number;
  title: string;
  /** 章内偏移（全书偏移 − 该章 `start`），即跳转后的 Reading_Position。 */
  offset: number;
  /** 该章的长度（`end − start`）。 */
  chapterLength: number;
}

/**
 * 检索词 `longText.fewKeyword` 的前 `RESULT_CAP` 处命中里，落在正文章节内、不在标题行（节点范围内第一个
 * 换行符之前）、章内偏移最大的一处。章内偏移越大，跳转后越不可能停在第 1 页，"含命中的页"才有分量。
 */
async function deepestHit(lib: Lib, book: BookUnderTest): Promise<HitPlan> {
  const keyword = lib.fixtureRoles().longText.fewKeyword;
  const [toc, text] = await Promise.all([lib.toc(book.id), bookText(lib, book.id)]);
  return step(`选定检索词「${keyword}」在正文章节内、不在标题行、章内偏移最大的一处命中`, () => {
    const found = findOccurrences(text, keyword, RESULT_CAP);
    let best: HitPlan | null = null;
    found.offsets.forEach((global, index) => {
      const chapter = toc.chapters.findIndex((c) => c.start <= global && global < c.end);
      if (chapter < 0 || toc.chapters[chapter].isVolume === true) return;
      const { start, end } = toc.chapters[chapter];
      const newline = text.text.indexOf("\n", start);
      const titleEnd = newline < 0 || newline >= end ? end : newline;
      if (global <= titleEnd) return;
      const offset = global - start;
      if (best === null || offset > best.offset) {
        best = {
          keyword,
          shown: Math.min(found.count, RESULT_CAP),
          index,
          chapter,
          title: book.facts.titles[chapter],
          offset,
          chapterLength: end - start,
        };
      }
    });
    const hit = best as HitPlan | null;
    if (hit === null) throw new Error(`${book.id}：「${keyword}」在正文章节内没有不在标题行的命中`);
    test.info().annotations.push({
      type: "paged-plan",
      description:
        `检索词「${keyword}」K=${found.count}；第 ${hit.index + 1} 条，下标 ${hit.chapter}「${hit.title}」，` +
        `章内偏移 ${hit.offset}（章长 ${hit.chapterLength}）`,
    });
    return hit;
  });
}

// ---------------------------------------------------------------------------
// 读数与等待
// ---------------------------------------------------------------------------

/** `waitPageAt` 的期望：章，以及（可选）页下标或"本章末页"。 */
interface PageExpectation {
  chapterId: number;
  pageIndex?: number | "last";
}

function describePage(expected: PageExpectation): string {
  const where =
    expected.pageIndex === undefined
      ? "某一页"
      : expected.pageIndex === "last"
        ? "末页"
        : `第 ${expected.pageIndex + 1} 页（data-page-index ${expected.pageIndex}）`;
  return `下标 ${expected.chapterId} 的${where}`;
}

function noteReading(what: string, reading: PagedViewReading | null): void {
  test.info().annotations.push({
    type: "paged-reading",
    description:
      reading === null
        ? `${what}：无读数`
        : `${what}：data-turning ${String(reading.turning)}、data-paginated [${reading.paginated.join(",")}]、` +
          `当前页 ${JSON.stringify(reading.current)}`,
  });
}

/**
 * 等翻页落定在期望的页（轮询，上限为 expect 超时）：`<main data-turning="false">`，当前页图层的章号（与页下标）
 * 为期望值。返回当前页。
 */
async function waitPageAt(page: Page, expected: PageExpectation, what: string): Promise<CurrentPage> {
  return step(`${what}：翻页落定（data-turning="false"），当前页为${describePage(expected)}`, async () => {
    let last: PagedViewReading | null = null;
    const want = { chapterId: expected.chapterId, pageIndex: expected.pageIndex ?? "any" };
    try {
      await expect
        .poll(
          async () => {
            last = await readPagedView(page);
            const cur = last.current;
            if (last.turning !== false || cur === null) return null;
            const pageIndex =
              expected.pageIndex === undefined
                ? "any"
                : expected.pageIndex === "last" && cur.pageIndex === cur.pageCount - 1
                  ? "last"
                  : cur.pageIndex;
            return { chapterId: cur.chapterId, pageIndex };
          },
          { message: `当前页应为${describePage(expected)}，且 data-turning 为 "false"` },
        )
        .toEqual(want);
    } finally {
      noteReading(what, last as PagedViewReading | null);
    }
    const settled = (last as PagedViewReading | null)?.current ?? null;
    if (settled === null) throw new Error(`${what}：落定后读不到当前页`);
    return settled;
  });
}

/** `<main>` 上 `data-turning` 的观察：自开始观察起，它是否出现过 `"true"`。 */
interface TurningWatch {
  /** 停止观察，返回期间是否出现过 `data-turning="true"`（含开始观察那一刻）。 */
  stop(): Promise<boolean>;
}

/**
 * 在 `<main>` 上挂一个 MutationObserver（`attributeOldValue`），记录 `data-turning` 是否出现过 `"true"`：
 * 一次翻页即便在两次读数之间开始又结束，也会留下 `oldValue === "true"` 的记录。只读，不改动页面。
 */
async function watchTurning(page: Page): Promise<TurningWatch> {
  const handle = await reader(page).main.evaluateHandle((main) => {
    const state = { turned: main.dataset.turning === "true", observer: null as MutationObserver | null };
    const observer = new MutationObserver((records) => {
      for (const r of records) if (r.oldValue === "true") state.turned = true;
      if (main.dataset.turning === "true") state.turned = true;
    });
    observer.observe(main, { attributes: true, attributeFilter: ["data-turning"], attributeOldValue: true });
    state.observer = observer;
    return state;
  });
  return {
    async stop() {
      try {
        return await handle.evaluate((state) => {
          state.observer?.disconnect();
          return state.turned;
        });
      } finally {
        await handle.dispose();
      }
    },
  };
}

/** `watch` 期间没有发生翻页（`data-turning` 从未为 `"true"`）。先等 2 帧，让最后的提交与观察回调落地。 */
async function expectNoTurn(page: Page, watch: TurningWatch, what: string): Promise<void> {
  await step(`${what}：期间 <main> 的 data-turning 从未为 "true"（没有发生翻页）`, async () => {
    await waitFrames(page);
    expect(await watch.stop(), `${what}：data-turning 出现过 "true"`).toBe(false);
  });
}

/** 当前页图层此刻的 `translateX`（px，计算样式的变换矩阵的 m41；没有变换时为 0）。 */
function currentLayerOffset(page: Page): Promise<number> {
  return reader(page).main.evaluate((main) => {
    const el = main.querySelector<HTMLElement>('[data-current="true"][data-page-index]');
    if (el === null) throw new Error("没有当前页图层");
    const transform = getComputedStyle(el).transform;
    return transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m41;
  });
}

function historyLength(page: Page): Promise<number> {
  return page.evaluate(() => window.history.length);
}

// ---------------------------------------------------------------------------
// 共用步骤
// ---------------------------------------------------------------------------

/**
 * 以 `?ch=<ch>` 打开阅读器（`openReader`），核对 `<main data-page-mode>` 为覆盖，等当前页落定在该章第 1 页
 * （导航到章首显示第 1 页，需求 12.1）。
 */
async function openPaged(page: Page, bookLog: BookLog, book: BookUnderTest, ch: number): Promise<CurrentPage> {
  await openReader(page, bookLog, book, ch);
  await step(`<main> 的 data-page-mode 为 "${MODE.attr}"（seedPageMode 写入的 pageAnim ${MODE.anim}）`, async () => {
    await expect(reader(page).main).toHaveAttribute("data-page-mode", MODE.attr);
  });
  return waitPageAt(page, { chapterId: ch, pageIndex: 0 }, `打开 ?ch=${ch}`);
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

/** 翻页键的方向；`null` 为非翻页键（不受按键闸门约束）。 */
type KeyDirection = "next" | "prev" | null;

/**
 * 按键器：每次按键前让焦点回到 `<body>`；翻页键距上一次同方向的翻页键不足 `KEY_GAP_MS` 时先等够（需求 11.6
 * 的闸门是应用按真实时间计的）。
 */
function keyPresser(page: Page): (label: string, key: string, direction: KeyDirection) => Promise<void> {
  const pressedAt = new Map<Exclude<KeyDirection, null>, number>();
  return async (label, key, direction) => {
    await blurToBody(page);
    if (direction !== null) {
      const at = pressedAt.get(direction);
      const rest = at === undefined ? 0 : at + KEY_GAP_MS - Date.now();
      if (rest > 0) {
        await step(`距上一次同方向翻页键满 ${KEY_GAP_MS} ms（需求 11.6 的按键闸门）`, () => page.waitForTimeout(rest));
      }
    }
    await step(`按 ${label}`, () => page.keyboard.press(key));
    if (direction !== null) pressedAt.set(direction, Date.now());
  };
}

/** `<main>` 的边界框（视口坐标）。 */
async function mainBox(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await reader(page).main.boundingBox();
  if (box === null) throw new Error("<main> 没有边界框");
  return box;
}

interface Point {
  x: number;
  y: number;
}

function pointIn(box: { x: number; y: number; width: number; height: number }, fx: number, fy: number): Point {
  return { x: box.x + box.width * fx, y: box.y + box.height * fy };
}

function fmt(p: Point): string {
  return `(${Math.round(p.x)}, ${Math.round(p.y)})`;
}

/**
 * 在 `<main>` 上用鼠标横向拖拽（不松开）：移到 `fromFx`、按下，先朝 `toFx` 一侧移 `DRAG_FIRST_STEP_PX` 越过
 * Touch_Slop 并等 2 帧，再分 `DRAG_STEPS` 步移到 `toFx`，等 2 帧。纵向在 `DRAG_FY` 处。返回 `<main>` 的边界框。
 */
async function pressAndDrag(page: Page, fromFx: number, toFx: number, what: string) {
  const box = await mainBox(page);
  const from = pointIn(box, fromFx, DRAG_FY);
  const to = pointIn(box, toFx, DRAG_FY);
  const sign = Math.sign(to.x - from.x);
  await step(
    `${what}：在 <main> 的 ${fmt(from)} 按下鼠标，先移 ${DRAG_FIRST_STEP_PX} px 越过 ${TOUCH_SLOP_PX} px 的 Touch_Slop，` +
      `再分 ${DRAG_STEPS} 步拖到 ${fmt(to)}（不松开）`,
    async () => {
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(from.x + sign * DRAG_FIRST_STEP_PX, from.y);
      await waitFrames(page);
      await page.mouse.move(to.x, to.y, { steps: DRAG_STEPS });
      await waitFrames(page);
    },
  );
  return box;
}

/** 底栏页码（需求 2.9）：可见文字 `x / y` 与读屏文本"本章第 x 页，共 y 页"各恰有一处，与当前页的钩子一致。 */
async function expectPageBadge(page: Page, current: CurrentPage, what: string): Promise<void> {
  const x = current.pageIndex + 1;
  const y = current.pageCount;
  await step(`PTM 2.9 ${what}：底栏页码为“${x} / ${y}”，读屏文本为“本章第 ${x} 页，共 ${y} 页”`, async () => {
    const bar = reader(page).bottomBar;
    await expect(bar.getByText(`${x} / ${y}`, { exact: true }), "底栏的可见页码").toHaveCount(1);
    await expect(bar.getByText(`本章第 ${x} 页，共 ${y} 页`, { exact: true }), "底栏页码的读屏文本").toHaveCount(1);
  });
}

/** 需求 12.8：正文区（`<main>`）里没有按钮与链接，也没有文字恰为"上一章""下一章"的元素（章末导航卡已删除）。 */
async function expectNoChapterEndCard(page: Page, what: string): Promise<void> {
  await step(`PTM 12.8 ${what}：正文区没有章末导航卡（<main> 内没有按钮与链接，没有“上一章”“下一章”字样）`, async () => {
    const main = reader(page).main;
    await expect(main.getByRole("button"), "<main> 内的按钮").toHaveCount(0);
    await expect(main.getByRole("link"), "<main> 内的链接").toHaveCount(0);
    await expect(main.getByText(/^(?:上一章|下一章)$/), "<main> 内文字恰为“上一章”“下一章”的元素").toHaveCount(0);
  });
}

/**
 * 需求 3.9、3.10：URL 恰有一个 `ch` 且为 `index`（轮询：写回在定位提交之后的 effect 里），`history.length`
 * 仍为 `historyBase`（替换当前历史记录项）；章节滑杆的值为该章的正文序号；目录抽屉（按 `T` 打开）中唯一带
 * `aria-current="true"` 的行是该章，随后按 `Esc` 关上。
 */
async function expectChapterFollowed(
  page: Page,
  facts: TocFacts,
  index: number,
  historyBase: number,
  what: string,
): Promise<void> {
  await step(`PTM 3.9 ${what}：URL 的 ch 写回为 ${index}，history.length 不变（${historyBase}）`, async () => {
    await expect
      .poll(() => urlChapterParams(page), { message: `URL 的 ch 应为 ${index}（恰有一个 ch 参数）` })
      .toEqual([String(index)]);
    expect(await historyLength(page), "history.length（以替换方式写回，不新增历史记录）").toBe(historyBase);
  });
  const ordinal = facts.bodyOrdinals[index];
  await step(`PTM 3.10 ${what}：章节滑杆的值为正文序号 ${String(ordinal)}`, async () => {
    await expect(reader(page).chapterSlider).toHaveValue(String(ordinal));
  });
  await blurToBody(page);
  await step(`PTM 3.10 ${what}：按 T 打开目录抽屉，唯一带 aria-current 的行是下标 ${index}，按 Esc 关上`, async () => {
    const drawer = tocDrawer(page);
    await page.keyboard.press("T");
    await expect(drawer.marker, "按 T 应打开目录抽屉").toBeVisible();
    await expect
      .poll(async () => (await readTocList(page)).rows.filter((r) => r.ariaCurrent === "true").map((r) => r.index), {
        message: "目录中带 aria-current 的行",
      })
      .toEqual([index]);
    await page.keyboard.press("Escape");
    await expect(drawer.marker, "按 Esc 应关上目录抽屉").toHaveCount(0);
  });
}

/** 需求 3.7、3.8：`role="status"` 的实时区域恰有 1 个，文字为 `text`，整页这段文字只出现一次。 */
async function expectSingleNotice(page: Page, text: string, what: string): Promise<void> {
  await step(`${what}：role="status" 的实时区域恰有 1 个、文字为“${text}”，整页这段文字只出现一次`, async () => {
    const status = page.getByRole("status");
    await expect(status, 'role="status" 的元素').toHaveCount(1);
    await expect(status, "实时区域的文字").toHaveText(text);
    await expect(page.getByText(text, { exact: true }), `整页文字恰为“${text}”的元素`).toHaveCount(1);
  });
}

/** 在已打开的检索抽屉输入检索词，等结果为 `hit.shown` 条，核对第 `hit.index` 条的章节名后点击它，等抽屉关闭。 */
async function searchAndSelect(page: Page, hit: HitPlan): Promise<void> {
  const drawer = searchDrawer(page);
  await step(`在检索框输入「${hit.keyword}」，等结果列表为 ${hit.shown} 条`, async () => {
    await drawer.input.fill(hit.keyword);
    await expect(drawer.results).toHaveCount(hit.shown);
  });
  await step(`点击第 ${hit.index + 1} 条结果（命中在「${hit.title}」内），等检索抽屉关闭`, async () => {
    const row = (await readSearchResults(page))[hit.index];
    expect(row?.chapterTitle, "该条结果的章节名").toBe(hit.title);
    await drawer.results.nth(hit.index).click();
    await expect(drawer.marker, "检索抽屉应已关闭").toHaveCount(0);
  });
}

/** 从首个正文章节打开，经检索跳到 `hit`；返回落定后的当前页（命中章节内）。 */
async function jumpToHit(
  page: Page,
  bookLog: BookLog,
  plan: PagedPlan,
  hit: HitPlan,
): Promise<CurrentPage> {
  if (plan.firstBody === hit.chapter) throw new Error(`${plan.book.id}：命中章节不应是首个正文章节`);
  await openPaged(page, bookLog, plan.book, plan.firstBody);
  await openSearchDrawer(page);
  await searchAndSelect(page, hit);
  return waitPageAt(page, { chapterId: hit.chapter }, "检索跳转");
}

/**
 * 按 `PageDown` 翻到下一页，核对它的页首偏移大于 `offset`（`offset` 在 `from` 页上时，下一页页首是它的上界）。
 * `from` 是本章末页时下一页在下一章，上界改为章长。
 */
async function expectNextPageStartsAfter(
  page: Page,
  press: ReturnType<typeof keyPresser>,
  from: CurrentPage,
  offset: number,
  chapterLength: number,
  what: string,
): Promise<void> {
  if (from.pageIndex === from.pageCount - 1) {
    await step(`${what}：当前页是本章末页，下一页页首即章长 ${chapterLength}，应大于 ${offset}`, () => {
      expect(offset, "章内偏移").toBeLessThan(chapterLength);
    });
    return;
  }
  await press("PageDown（翻到下一页，读它的页首偏移）", "PageDown", "next");
  const next = await waitPageAt(
    page,
    { chapterId: from.chapterId, pageIndex: from.pageIndex + 1 },
    `${what}：PageDown 之后`,
  );
  await step(`${what}：下一页的 data-page-start（${next.pageStart}）大于 ${offset}`, () => {
    expect(next.pageStart, "下一页的 data-page-start").toBeGreaterThan(offset);
  });
}

/** 设置抽屉里字号显示值"NNpx"的数值。 */
async function readFontSizeSetting(page: Page): Promise<number> {
  const text = ((await settingsDrawer(page).fontSizeValue.textContent()) ?? "").trim();
  const match = /^(\d+)px$/.exec(text);
  if (match === null) throw new Error(`无法解析字号显示值 ${JSON.stringify(text)}`);
  return Number(match[1]);
}

/** `armSecondFontClick` 在页内的状态。 */
interface FontRaceState {
  /** 是否已点下第二次 "A+"。 */
  fired: boolean;
  /** 点下时 `MeasureBox` 里挂着的那一章的 `<h1>`（相邻章）。 */
  measured: string | null;
  /** 点下时 `<main>` 的 `data-paginated`。 */
  paginated: string | null;
  observer: MutationObserver | null;
}

/**
 * 2.5 连续改字号的第二次点击（见文件头）：在 `<main>` 内的 `MeasureBox` 上挂 MutationObserver。第一次改字号
 * 已落地（`data-paginated` 含 `chapterId`、当前页 `<article>` 的计算字号为 `firstPx`）之后，盒子里第一次挂上
 * 别的章（`<h1>` 不是 `title`，即相邻章的后台分页）时，在这次观察回调里对 `increase` 调用 `click()`，随即停止观察。
 * 当前章自己的渲染驱动测量也会往盒子里挂内容，`<h1>` 是 `title`，不算。
 */
async function armSecondFontClick(
  page: Page,
  increase: Locator,
  current: { chapterId: number; title: string },
  firstPx: string,
): Promise<JSHandle<FontRaceState>> {
  const button = await increase.elementHandle();
  if (button === null) throw new Error("找不到“A+”按钮");
  try {
    return await reader(page).main.evaluateHandle(
      (main, arg) => {
        const box = main.querySelector("[data-measure-box]");
        if (box === null) throw new Error("<main> 内没有 MeasureBox（[data-measure-box]）");
        const state: FontRaceState = { fired: false, measured: null, paginated: null, observer: null };
        const firstApplied = () => {
          const ids = (main.getAttribute("data-paginated") ?? "").split(",");
          if (!ids.includes(String(arg.chapterId))) return false;
          const article = main.querySelector('[data-current="true"][data-page-index] article');
          return article !== null && getComputedStyle(article).fontSize === arg.firstPx;
        };
        const observer = new MutationObserver((records) => {
          if (state.fired) return;
          for (const record of records) {
            for (const node of Array.from(record.addedNodes)) {
              if (!(node instanceof Element)) continue;
              const heading = node.querySelector("h1")?.textContent ?? null;
              if (heading === null || heading === arg.title || !firstApplied()) continue;
              state.fired = true;
              state.measured = heading;
              state.paginated = main.getAttribute("data-paginated");
              observer.disconnect();
              (arg.button as HTMLElement).click();
              return;
            }
          }
        });
        observer.observe(box, { childList: true });
        state.observer = observer;
        return state;
      },
      { button, chapterId: current.chapterId, title: current.title, firstPx },
    );
  } finally {
    await button.dispose();
  }
}

/**
 * 当前页图层里每一行文字的底边（各文本节点 `getClientRects()` 的最大 `bottom`）与页面内容盒的底边
 * （图层底边减去 `PAGE_PAD_BOTTOM`）。页表出自当前版式时前者不超过后者（需求 2.3）。
 */
function readCurrentPageFit(page: Page): Promise<{ textBottom: number; contentBottom: number }> {
  return reader(page).main.evaluate((main, padBottom) => {
    const surface = main.querySelector<HTMLElement>('[data-current="true"][data-page-index]');
    if (surface === null) throw new Error("没有当前页图层");
    const walker = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let textBottom = -Infinity;
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if ((node.textContent ?? "").trim() === "") continue;
      range.selectNodeContents(node);
      for (const r of Array.from(range.getClientRects())) {
        if (r.height > 0) textBottom = Math.max(textBottom, r.bottom);
      }
    }
    return { textBottom, contentBottom: surface.getBoundingClientRect().bottom - padBottom };
  }, PAGE_PAD_BOTTOM);
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

// 覆盖模式要真的播动画（见文件头）。contextOptions 整体替换项目里的那一份，其中只有 reducedMotion 一项
test.use({ contextOptions: { reducedMotion: "no-preference" } });

test.beforeEach(async ({ context }) => {
  await seedPageMode(context, MODE.anim);
});

test.describe("PTM 4.7 4.8 鼠标拖拽翻页", () => {
  test("PTM 4.7 鼠标分步拖过半屏后释放（最后一次移动朝向 NEXT）：完成翻页，页码 +1，底栏页码随之更新", async ({
    page,
    lib,
    bookLog,
  }) => {
    const plan = await pagedPlan(lib);
    const before = await openPaged(page, bookLog, plan.book, plan.chapter);
    await step("前置：长章不止一页", () => {
      expect(before.pageCount, "长章的页数").toBeGreaterThan(1);
    });
    await expectPageBadge(page, before, "拖拽前");

    const box = await pressAndDrag(page, DRAG_PRESS_FX, DRAG_FAR_FX, "向左拖过半屏");
    await step("拖拽进行中：data-turning 为 true，当前页仍是拖拽前那页，当前页图层左移超过半个视口宽", async () => {
      const reading = await readPagedView(page);
      noteReading("拖拽进行中", reading);
      expect(reading.turning, "data-turning").toBe(true);
      expect(reading.current, "当前页").toEqual(before);
      const offset = await currentLayerOffset(page);
      test.info().annotations.push({ type: "paged-reading", description: `当前页图层 translateX ${offset}（视口宽 ${box.width}）` });
      expect(offset, "当前页图层的 translateX（覆盖模式 NEXT 的移动层，需求 4.4、6.1）").toBeLessThan(-box.width / 2);
    });
    await step("释放鼠标", () => page.mouse.up());

    const after = await waitPageAt(page, { chapterId: plan.chapter, pageIndex: before.pageIndex + 1 }, "PTM 4.7 释放后");
    await step(`PTM 4.7 页首偏移变大（${before.pageStart} → ${after.pageStart}），页数不变`, () => {
      expect(after.pageStart, "data-page-start").toBeGreaterThan(before.pageStart);
      expect(after.pageCount, "data-page-count").toBe(before.pageCount);
    });
    await expectPageBadge(page, after, "拖拽翻页后");
  });

  test("PTM 4.8 鼠标分步拖过半屏后回拖一步再释放（最后一次移动背离 NEXT）：取消翻页，页码不变", async ({
    page,
    lib,
    bookLog,
  }) => {
    const plan = await pagedPlan(lib);
    const before = await openPaged(page, bookLog, plan.book, plan.chapter);
    await step("前置：长章不止一页", () => {
      expect(before.pageCount, "长章的页数").toBeGreaterThan(1);
    });

    const box = await pressAndDrag(page, DRAG_PRESS_FX, DRAG_FAR_FX, "向左拖过半屏");
    const far = await step("拖过半屏：data-turning 为 true，当前页图层左移超过半个视口宽", async () => {
      const reading = await readPagedView(page);
      noteReading("拖过半屏", reading);
      expect(reading.turning, "data-turning").toBe(true);
      expect(reading.current, "当前页").toEqual(before);
      const offset = await currentLayerOffset(page);
      expect(offset, "当前页图层的 translateX").toBeLessThan(-box.width / 2);
      return offset;
    });
    const back = pointIn(box, DRAG_BACK_FX, DRAG_FY);
    await step(`回拖一步：一次性右移到 ${fmt(back)}（仍在起点之左，不换向），等 2 帧`, async () => {
      await page.mouse.move(back.x, back.y);
      await waitFrames(page);
    });
    await step("回拖后：仍在翻页（data-turning 为 true），当前页图层随指针右移但仍在原位之左", async () => {
      const reading = await readPagedView(page);
      noteReading("回拖之后", reading);
      expect(reading.turning, "data-turning").toBe(true);
      const offset = await currentLayerOffset(page);
      test.info().annotations.push({ type: "paged-reading", description: `translateX：拖过半屏 ${far} → 回拖 ${offset}` });
      expect(offset, "回拖后的 translateX").toBeGreaterThan(far);
      expect(offset, "回拖后的 translateX（未越过起点）").toBeLessThan(0);
    });
    await step("释放鼠标", () => page.mouse.up());

    const after = await waitPageAt(page, { chapterId: plan.chapter, pageIndex: before.pageIndex }, "PTM 4.8 释放后");
    await step("PTM 4.8 页面回到原位：当前页的全部钩子与拖拽前相同，图层没有残留的平移", async () => {
      expect(after, "当前页").toEqual(before);
      expect(await currentLayerOffset(page), "当前页图层的 translateX").toBe(0);
    });
    await expectPageBadge(page, after, "取消翻页后");
  });
});

test.describe("PTM 3.1 3.2 3.9 3.10 跨章翻页", () => {
  test("PTM 3.1 3.2 3.9 3.10 章末 PageDown 进入下一章第 1 页、章首 PageUp 回到上一章末页：?ch= 以替换方式更新，history.length 不变，滑杆与目录高亮跟随", async ({
    page,
    lib,
    bookLog,
  }) => {
    const plan = await pagedPlan(lib);
    const { facts } = plan.book;
    await openPaged(page, bookLog, plan.book, plan.chapter);
    await expectCurrentChapter(page, facts, plan.chapter);
    const historyBase = await historyLength(page);
    const press = keyPresser(page);

    await press("End（本章末页，需求 11.3）", "End", null);
    const chapterEnd = await waitPageAt(page, { chapterId: plan.chapter, pageIndex: "last" }, "End 之后");
    await step("前置：长章不止一页", () => {
      expect(chapterEnd.pageCount, "长章的页数").toBeGreaterThan(1);
    });
    await expectNoChapterEndCard(page, "长章末页");

    await press("PageDown（章末向 NEXT 翻页）", "PageDown", "next");
    const nextFirst = await waitPageAt(page, { chapterId: plan.next, pageIndex: 0 }, "PTM 3.1 章末 PageDown 之后");
    await expectCurrentChapter(page, facts, plan.next);
    await expectChapterFollowed(page, facts, plan.next, historyBase, "进入下一章");
    await expectPageBadge(page, nextFirst, "进入下一章");

    await press("PageUp（章首向 PREV 翻页）", "PageUp", "prev");
    const backLast = await waitPageAt(page, { chapterId: plan.chapter, pageIndex: "last" }, "PTM 3.2 章首 PageUp 之后");
    await step(`PTM 3.2 落在上一章末页：页数与 End 时相同（${chapterEnd.pageCount}），页首偏移相同（${chapterEnd.pageStart}）`, () => {
      expect(backLast, "当前页").toEqual(chapterEnd);
    });
    await expectChapterFollowed(page, facts, plan.chapter, historyBase, "回到上一章");
    await expectPageBadge(page, backLast, "回到上一章末页");
  });
});

test.describe("PTM 3.5 3.6 3.7 3.8 边界提示", () => {
  test("PTM 3.6 3.7 3.8 全书首页按 PageUp 出现“没有上一页”，提示可见时再向右拖拽：实时区域仍只有一条“没有上一页”，当前页不变", async ({
    page,
    lib,
    bookLog,
  }) => {
    const plan = await pagedPlan(lib);
    const before = await openPaged(page, bookLog, plan.book, plan.firstBody);
    const press = keyPresser(page);
    const watch = await watchTurning(page);

    await press("PageUp（全书首页向 PREV 翻页）", "PageUp", "prev");
    await expectSingleNotice(page, "没有上一页", "PTM 3.6 3.8 PageUp 之后");

    await pressAndDrag(page, PREV_DRAG.from, PREV_DRAG.to, "提示可见时再触发同一边界：向右拖拽（起步方向无页）");
    await step("释放鼠标", () => page.mouse.up());
    await expectSingleNotice(page, "没有上一页", "PTM 3.7 再次触发同一边界之后");

    await expectNoTurn(page, watch, "PageUp 与向右拖拽");
    await step("PTM 3.6 当前页不变（全书首个正文章节第 1 页）", async () => {
      expect((await readPagedView(page)).current, "当前页").toEqual(before);
    });
  });

  test("PTM 3.5 3.7 3.8 12.8 全书末页（正文末尾没有章末导航卡）按 PageDown 出现“没有下一页”，提示可见时再向左拖拽：实时区域仍只有一条“没有下一页”，当前页不变", async ({
    page,
    lib,
    bookLog,
  }) => {
    const plan = await pagedPlan(lib);
    await openPaged(page, bookLog, plan.book, plan.lastBody);
    const press = keyPresser(page);
    await press("End（本章末页）", "End", null);
    const before = await waitPageAt(page, { chapterId: plan.lastBody, pageIndex: "last" }, "End 之后");
    await expectNoChapterEndCard(page, "全书末页");
    const watch = await watchTurning(page);

    await press("PageDown（全书末页向 NEXT 翻页）", "PageDown", "next");
    await expectSingleNotice(page, "没有下一页", "PTM 3.5 3.8 PageDown 之后");

    await pressAndDrag(page, NEXT_DRAG.from, NEXT_DRAG.to, "提示可见时再触发同一边界：向左拖拽（起步方向无页）");
    await step("释放鼠标", () => page.mouse.up());
    await expectSingleNotice(page, "没有下一页", "PTM 3.7 再次触发同一边界之后");

    await expectNoTurn(page, watch, "PageDown 与向左拖拽");
    await step("PTM 3.5 当前页不变（全书末个正文章节末页）", async () => {
      expect((await readPagedView(page)).current, "当前页").toEqual(before);
    });
  });
});

test.describe("PTM 12.3 检索命中跳转", () => {
  test("PTM 12.3 检索命中跳转：显示含命中起点的页（data-page-start ≤ 命中偏移 < 下一页页首），<mark> 位于当前页", async ({
    page,
    lib,
    bookLog,
  }) => {
    const plan = await pagedPlan(lib);
    const hit = await deepestHit(lib, plan.book);
    const landed = await jumpToHit(page, bookLog, plan, hit);
    await step(`PTM 12.3 当前页含命中起点：data-page-start（${landed.pageStart}）≤ 命中章内偏移 ${hit.offset}`, () => {
      expect(landed.pageIndex, "前置：命中不在本章第 1 页（否则这条核对没有分量）").toBeGreaterThan(0);
      expect(landed.pageStart, "data-page-start").toBeLessThanOrEqual(hit.offset);
    });
    await step("PTM 12.3 正文恰有 1 个 <mark>，位于当前页图层内，文字是检索词的前缀（不区分大小写）", async () => {
      const mark = readerJumpHighlight(page);
      await expect(mark, "正文中的 <mark>").toHaveCount(1);
      const where = await mark.evaluate((el) => {
        const surface = el.closest('[data-current="true"]');
        return {
          pageIndex: surface instanceof HTMLElement ? Number(surface.dataset.pageIndex) : null,
          text: el.textContent ?? "",
        };
      });
      test.info().annotations.push({ type: "paged-reading", description: `<mark>：${JSON.stringify(where)}` });
      expect(where.pageIndex, "<mark> 所在页图层的 data-page-index").toBe(landed.pageIndex);
      expect(where.text.length, "<mark> 的文字长度").toBeGreaterThan(0);
      expect(hit.keyword.toLowerCase().startsWith(where.text.toLowerCase()), `<mark> 的文字「${where.text}」应是检索词的前缀`).toBe(true);
    });
    await expectNextPageStartsAfter(page, keyPresser(page), landed, hit.offset, hit.chapterLength, "PTM 12.3");
  });
});

test.describe("PTM 2.5 改字号后重新分页", () => {
  test("PTM 2.5 经检索把阅读位置落在页中间后改字号：重新分页后仍显示包含原 Reading_Position 的页", async ({
    page,
    lib,
    bookLog,
  }) => {
    const plan = await pagedPlan(lib);
    const hit = await deepestHit(lib, plan.book);
    const before = await jumpToHit(page, bookLog, plan, hit);
    await step(`改字号前：data-page-start（${before.pageStart}）≤ Reading_Position ${hit.offset}`, () => {
      expect(before.pageStart, "data-page-start").toBeLessThanOrEqual(hit.offset);
    });

    const press = keyPresser(page);
    await press("S 打开设置抽屉", "s", null);
    const drawer = settingsDrawer(page);
    const { step: fontStep, max: fontMax } = SLIDER_SPECS.fontSize;
    const increased = await step(`点击“A+” ${FONT_CLICKS} 次，再按 Esc 关上设置抽屉`, async () => {
      await expect(drawer.marker, "按 S 应打开设置抽屉").toBeVisible();
      const text = ((await drawer.fontSizeValue.textContent()) ?? "").trim();
      const match = /^(\d+)px$/.exec(text);
      if (match === null) throw new Error(`无法解析字号显示值 ${JSON.stringify(text)}`);
      const original = Number(match[1]);
      const target = original + FONT_CLICKS * fontStep;
      expect(target, `前置：增大后的字号应 ≤ ${fontMax}`).toBeLessThanOrEqual(fontMax);
      for (let i = 1; i <= FONT_CLICKS; i++) {
        await drawer.fontIncrease.click();
        await expect(drawer.fontSizeValue).toHaveText(`${original + i * fontStep}px`);
      }
      await page.keyboard.press("Escape");
      await expect(drawer.marker, "按 Esc 应关上设置抽屉").toHaveCount(0);
      test.info().annotations.push({ type: "paged-plan", description: `字号 ${original}px → ${target}px` });
      return target;
    });

    const after = await step(`等当前页 <article> 的计算字号为 ${increased}px 且翻页落定（重新分页完成）`, async () => {
      let last: PagedViewReading | null = null;
      try {
        await expect
          .poll(
            async () => {
              last = await readPagedView(page);
              if (last.turning !== false || last.current === null) return null;
              return reader(page).article.evaluate((a) => getComputedStyle(a).fontSize);
            },
            { message: `当前页 <article> 的计算字号应为 ${increased}px` },
          )
          .toBe(`${increased}px`);
      } finally {
        noteReading("改字号之后", last as PagedViewReading | null);
      }
      // 字体纪元等后续排版输入若再触发一次重分页，也在这两帧里落地
      await waitFrames(page);
      const current = (await readPagedView(page)).current;
      if (current === null) throw new Error("改字号之后读不到当前页");
      return current;
    });
    await step(
      `PTM 2.5 改字号后仍在下标 ${hit.chapter}，data-page-start（${after.pageStart}）≤ Reading_Position ${hit.offset}`,
      () => {
        test.info().annotations.push({
          type: "paged-reading",
          description: `页数 ${before.pageCount} → ${after.pageCount}；页首 ${before.pageStart} → ${after.pageStart}`,
        });
        expect(after.chapterId, "当前页的章").toBe(hit.chapter);
        expect(after.pageStart, "data-page-start").toBeLessThanOrEqual(hit.offset);
      },
    );
    await expectNextPageStartsAfter(page, press, after, hit.offset, hit.chapterLength, "PTM 2.5 改字号后");
  });

  test("PTM 2.5 连续两次改字号、第二次落在相邻章后台分页途中：当前章按最终字号重新分页（data-paginated 含当前章），仍显示包含原 Reading_Position 的页，页内各行都在页面之内", async ({
    page,
    lib,
    bookLog,
  }) => {
    const plan = await pagedPlan(lib);
    const { facts } = plan.book;
    const hit = await deepestHit(lib, plan.book);
    await step("前置：命中章节与它前后的正文章节标题互不相同（按 MeasureBox 里的 <h1> 分辨测的是哪一章）", () => {
      const ordinal = facts.bodyOrdinals[hit.chapter];
      if (ordinal === null || ordinal === undefined) throw new Error(`下标 ${hit.chapter} 不是正文章节`);
      const neighbors = [facts.bodyIndices[ordinal - 1], facts.bodyIndices[ordinal + 1]].filter(
        (id): id is number => id !== undefined,
      );
      expect(neighbors.length, "命中章节前后的正文章节数").toBeGreaterThan(0);
      for (const id of neighbors) expect(facts.titles[id], `下标 ${id} 的标题`).not.toBe(hit.title);
    });
    const before = await jumpToHit(page, bookLog, plan, hit);
    await step(`改字号前：data-page-start（${before.pageStart}）≤ Reading_Position ${hit.offset}`, () => {
      expect(before.pageStart, "data-page-start").toBeLessThanOrEqual(hit.offset);
    });

    const press = keyPresser(page);
    await press("S 打开设置抽屉", "s", null);
    const drawer = settingsDrawer(page);
    await expect(drawer.marker, "按 S 应打开设置抽屉").toBeVisible();
    const { step: fontStep, max: fontMax } = SLIDER_SPECS.fontSize;
    const original = await readFontSizeSetting(page);
    const first = original + fontStep;
    const second = original + 2 * fontStep;
    await step(`前置：两次增大后的字号（${second}px）≤ ${fontMax}px`, () => {
      expect(second, "两次增大后的字号").toBeLessThanOrEqual(fontMax);
    });
    test.info().annotations.push({ type: "paged-plan", description: `字号 ${original}px → ${first}px → ${second}px` });

    const race = await armSecondFontClick(page, drawer.fontIncrease, { chapterId: hit.chapter, title: hit.title }, `${first}px`);
    try {
      await step(`点击“A+”（${original}px → ${first}px）`, () => drawer.fontIncrease.click());
      await step(
        `等当前章按 ${first}px 分页完成、相邻章开始后台分页：MeasureBox 挂上相邻章的那一刻再点一次“A+”（→ ${second}px）`,
        async () => {
          await expect
            .poll(() => race.evaluate((s) => s.fired), { message: "相邻章后台分页时应已点下第二次“A+”" })
            .toBe(true);
          const fired = await race.evaluate((s) => ({ measured: s.measured, paginated: s.paginated }));
          test.info().annotations.push({
            type: "paged-reading",
            description: `第二次“A+”：MeasureBox 里是「${String(fired.measured)}」，data-paginated [${String(fired.paginated)}]`,
          });
        },
      );
    } finally {
      await race.evaluate((s) => s.observer?.disconnect());
      await race.dispose();
    }
    await step(`设置抽屉的字号显示为 ${second}px，按 Esc 关上设置抽屉`, async () => {
      await expect(drawer.fontSizeValue).toHaveText(`${second}px`);
      await page.keyboard.press("Escape");
      await expect(drawer.marker, "按 Esc 应关上设置抽屉").toHaveCount(0);
    });

    const after = await step(
      `等当前页 <article> 的计算字号为 ${second}px、翻页落定，且 data-paginated 含下标 ${hit.chapter}（当前章已按最终字号分页）`,
      async () => {
        let last: PagedViewReading | null = null;
        try {
          await expect
            .poll(
              async () => {
                last = await readPagedView(page);
                if (last.turning !== false || last.current === null) return null;
                const fontSize = await reader(page).article.evaluate((a) => getComputedStyle(a).fontSize);
                return { fontSize, paginated: last.paginated.includes(hit.chapter) };
              },
              { message: `当前页应为 ${second}px，且 data-paginated 含下标 ${hit.chapter}（页表不是上一次字号的）` },
            )
            .toEqual({ fontSize: `${second}px`, paginated: true });
        } finally {
          noteReading("连续改字号之后", last as PagedViewReading | null);
        }
        const current = (last as PagedViewReading | null)?.current ?? null;
        if (current === null) throw new Error("连续改字号之后读不到当前页");
        return current;
      },
    );
    await step(
      `PTM 2.5 仍在下标 ${hit.chapter}，data-page-start（${after.pageStart}）≤ Reading_Position ${hit.offset}`,
      () => {
        test.info().annotations.push({
          type: "paged-reading",
          description: `页数 ${before.pageCount} → ${after.pageCount}；页首 ${before.pageStart} → ${after.pageStart}`,
        });
        expect(after.chapterId, "当前页的章").toBe(hit.chapter);
        expect(after.pageStart, "data-page-start").toBeLessThanOrEqual(hit.offset);
      },
    );
    await step("PTM 2.3 2.5 当前页每一行文字的底边都在页面内容盒之内（页表出自最终字号）", async () => {
      const fit = await readCurrentPageFit(page);
      test.info().annotations.push({ type: "paged-reading", description: `页内文字底边 ${fit.textBottom}，内容盒底边 ${fit.contentBottom}` });
      expect(fit.textBottom, "当前页文字的最大底边（px）").toBeLessThanOrEqual(fit.contentBottom + 1);
    });
    await expectNextPageStartsAfter(page, press, after, hit.offset, hit.chapterLength, "PTM 2.5 连续改字号后");
  });
});

test.describe("PTM 4.10 4.11 长按与控制栏上的拖拽", () => {
  test(`PTM 4.10 在正文上按住鼠标 ${LONG_PRESS_MS} ms 不动：建立非空选区，页码不变，没有翻页`, async ({
    page,
    lib,
    bookLog,
  }) => {
    const plan = await pagedPlan(lib);
    const before = await openPaged(page, bookLog, plan.book, plan.chapter);
    const at = await step(`取当前页第一个段落第 ${LONG_PRESS_CHAR + 1} 个字的中心点，核对该点最上层的元素在当前页图层内`, async () =>
      reader(page)
        .paragraphs.first()
        .evaluate((p, wanted) => {
          const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
          let node = walker.nextNode();
          while (node !== null && (node.textContent ?? "").trim() === "") node = walker.nextNode();
          if (node === null) throw new Error("当前页第一个段落没有文字");
          const length = (node.textContent ?? "").length;
          const index = Math.min(wanted, length - 1);
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + 1);
          const r = range.getBoundingClientRect();
          const x = r.left + r.width / 2;
          const y = r.top + r.height / 2;
          const hit = document.elementFromPoint(x, y);
          if (hit === null || hit.closest('[data-current="true"]') === null) {
            throw new Error(`(${x}, ${y}) 处最上层的元素不在当前页图层内`);
          }
          window.getSelection()?.removeAllRanges();
          return { x, y };
        }, LONG_PRESS_CHAR),
    );
    const watch = await watchTurning(page);

    const elapsed = await step(`在 ${fmt(at)} 按下鼠标不动，按住期间等到页面出现非空选区，再松开`, async () => {
      await page.mouse.move(at.x, at.y);
      const pressedAt = Date.now();
      await page.mouse.down();
      try {
        await expect
          .poll(() => page.evaluate(() => window.getSelection()?.toString() ?? ""), {
            message: "按住期间应出现非空选区（Long_Press）",
          })
          .not.toBe("");
        return Date.now() - pressedAt;
      } finally {
        await page.mouse.up();
      }
    });
    await step(`PTM 4.10 选区自按下起 ${elapsed} ms 出现（不早于 ${LONG_PRESS_MS} ms）；松开后仍非空，锚点在当前页图层内`, async () => {
      test.info().annotations.push({ type: "paged-reading", description: `长按：选区自按下起 ${elapsed} ms 出现` });
      expect(elapsed, "选区出现的时刻（自按下起，ms）").toBeGreaterThanOrEqual(LONG_PRESS_MS);
      await waitFrames(page);
      const selection = await page.evaluate(() => {
        const sel = window.getSelection();
        const node = sel?.anchorNode ?? null;
        const el = node instanceof Element ? node : (node?.parentElement ?? null);
        return { text: sel?.toString() ?? "", inCurrentPage: el?.closest('[data-current="true"]') != null };
      });
      test.info().annotations.push({ type: "paged-reading", description: `松开后的选区：${JSON.stringify(selection)}` });
      expect(selection.text, "松开后的选区文字").not.toBe("");
      expect(selection.inCurrentPage, "选区锚点在当前页图层内").toBe(true);
    });
    await expectNoTurn(page, watch, "长按与松开");
    await step("PTM 4.10 当前页不变", async () => {
      expect((await readPagedView(page)).current, "当前页").toEqual(before);
    });
  });

  test("PTM 4.11 在底栏上横向拖拽：页码、章节滑杆与 URL 的 ch 都不变，没有翻页", async ({ page, lib, bookLog }) => {
    const plan = await pagedPlan(lib);
    const { facts } = plan.book;
    const before = await openPaged(page, bookLog, plan.book, plan.chapter);
    await expectCurrentChapter(page, facts, plan.chapter);
    const ordinal = String(facts.bodyOrdinals[plan.chapter]);
    await step("控制栏可见（不可见时重新亮起）", async () => {
      if (!(await readControlsVisible(page))) await reshowControls(page);
    });
    const path = await step(
      `取底栏纵向中线上距左右边缘 ${FOOTER_EDGE_PX} px 的两点，核对两处最上层的元素都在底栏内且不是控件`,
      () =>
        reader(page).bottomBar.evaluate((footer, edge) => {
          const r = footer.getBoundingClientRect();
          const y = r.top + r.height / 2;
          const from = { x: r.right - edge, y };
          const to = { x: r.left + edge, y };
          for (const p of [from, to]) {
            const hit = document.elementFromPoint(p.x, p.y);
            if (hit === null || !footer.contains(hit) || hit.closest("a,button,input,select,textarea,label") !== null) {
              throw new Error(`(${p.x}, ${p.y}) 处最上层的元素 ${hit?.tagName ?? "（无）"} 不在底栏内或是控件`);
            }
          }
          return { from, to };
        }, FOOTER_EDGE_PX),
    );
    const watch = await watchTurning(page);

    await step(`在底栏 ${fmt(path.from)} 按下鼠标，分 ${DRAG_STEPS} 步横向拖到 ${fmt(path.to)} 再松开`, async () => {
      await page.mouse.move(path.from.x, path.from.y);
      await page.mouse.down();
      await page.mouse.move(path.to.x, path.to.y, { steps: DRAG_STEPS });
      await waitFrames(page);
      await page.mouse.up();
    });
    await expectNoTurn(page, watch, "底栏上的拖拽");
    await step(`PTM 4.11 当前页、章节滑杆（${ordinal}）与 URL 的 ch（${plan.chapter}）都不变`, async () => {
      expect((await readPagedView(page)).current, "当前页").toEqual(before);
      await expect(reader(page).chapterSlider, "章节滑杆的值").toHaveValue(ordinal);
      expect(urlChapterParams(page), "URL 的 ch").toEqual([String(plan.chapter)]);
    });
  });
});
