/**
 * 阅读器：键盘快捷键（需求 10.9–10.22；`reader-consolidation` 需求 9.4、差异表 C13；翻页模式需求 10.1、10.10、
 * 11.10–11.13）。`fixture` 项目（:4611，Opaque_Mode），桌面视口，默认主题（不 `seedTheme`），默认翻页模式
 * （滚动，不 `seedPageMode`），不装 Controlled_Clock（不涉及时长）。
 *
 * ## 用书与章节（4.4：期望值运行时推导）
 *
 * 书为 `lib.role("longText")`（3.3 (h)(i) 的夹具书），章节取 `roles.json` 的 `longText.chapterIndex`：该书的
 * 长章节，须既非首个也非末个正文章节（不满足即为测试自身的问题，16.6）。10.9 / 10.10 的"上一个 / 下一个
 * 正文章节"取 `_toc.json` 非卷节点序列中的前一个 / 后一个（`TocFacts.bodyIndices`），卷节点因此自然跳过；
 * 这本书没有卷节点，跨卷段的 `←` / `→` 已由 `reader-volumes.spec.ts` 的 8.4 / 8.5 覆盖（按键与按钮各测一次）。
 *
 * ## 滚动模式下的"章"（翻页模式需求 10.1）
 *
 * 默认的滚动模式把正文章节按目录顺序首尾相接地挂在同一个 `<main>` 里：每章一个 `<section data-chapter-id>`，
 * 判定线所在章的区段带 `data-current="true"`，起始章节之上挂着上一章、之下挂着下一章。`<main>` 的
 * `scrollTop = 0` 因此不是章首，`scrollHeight − clientHeight` 也不是章末。本文件的"章首""章末""章内"一律以
 * 当前章区段为界（`readChapterScroll`）：章首是区段顶边对齐容器顶边时的 `scrollTop`，章末是
 * `max(章首, 区段底边 − clientHeight)`（design §7.6 的 `chapterEdgeScrollTop`）。正文 `<h1>` 与"第 N / M 章"
 * 取当前章区段里的那一份（`reader(page)` 的定位器限定在 `data-current="true"` 之内）。
 *
 * ## 起始状态（`readerStart`；需求 10 的前言、设计"补充场景"10.9–10.22）
 *
 * 前言规定的起始状态有两部分：(a) 章节的最大可滚距离 ≥ 2 × `clientHeight`，`scrollTop` 离两端都至少 2 px；
 * (b) 章节既非首也非末、三个抽屉均关闭、焦点在 `<body>`。连续滚动之后 (a) 按当前章区段解释：本章的可滚跨度
 * （章末 − 章首）≥ 2 × `clientHeight`，`scrollTop − 章首` 介于 2 px 与"可滚跨度 − 2 px"之间。
 *
 * `readerStart` 的做法：
 *
 * - 核对 `<main data-page-mode>` 为默认翻页模式（滚动）。
 * - 先核对文档滚动元素不可滚动（reader-defect-fixes 需求 2.1、14.2，`expectDocumentNotScrollable`），再把
 *   `<main>` 的 `scrollTop` 设为"章首 + `clientHeight`"，并核对当前章区段仍是起始章节、(a) 的两个不等式成立。
 *   这一滚以读者操作设定（`setMainScrollTop` 先派发一个 `deltaY` 为 0 的 `wheel`）：滚动视图在导航定位后钉住
 *   位置归约器，读者操作之后才上报阅读位置（design §3.3）。正文因此确实停在章中，10.16–10.22 的
 *   "`scrollTop` 不变"不会因为停在端点而恒真；直接设为 `clientHeight`（改版前的做法）会滚进上方的上一章。
 * - (b) 照常建立并核对：三个抽屉的打开标志计数均为 0；`document.activeElement.blur()` 后焦点在 `<body>`。
 *
 * 起始状态的读数记在注解 `shortcut-start` 里，每次按键前后的读数记在 `shortcut-reading` 里。
 *
 * 历史：EV 验收时 `<main>` 不是滚动容器、实际滚动的是文档（Findings_Log F-002，已修复（reader-defect-fixes））。
 * 修复后 (a) 直接在 `<main>` 上建立；翻页模式（任务 21.4）起 (a) 改以当前章区段为界。
 *
 * ## "章节不变"与 URL 的 `ch`
 *
 * 前言把"章节不变"定义为 URL 的 `ch` 不变。阅读器在每次定位（首次定位与各种换章）后以替换历史记录的
 * 方式把当前章写回 URL 的 `ch`（reader-defect-fixes 需求 7.1、D2），滚动模式下判定线进入另一章时同样写回
 * （翻页模式需求 10.4）。本文件的"章节不变"同时比较 URL 的 `ch` 与 8.1 所判定的当前章节（正文 `<h1>` 与
 * "第 N / M 章"的文本）。10.9、10.10、10.12 的"URL 的 `ch` 变为上一个 / 下一个正文章节"在单独的用例中断言：
 * 写回在换章提交之后的 effect 里发起，路由状态的更新包在 transition 中，所以以正文切到目标章节为同步点后
 * 轮询 URL；同一条里"渲染该章"的断言在另一个用例中。
 *
 * 历史：EV 验收时阅读器内换章从不写回 URL（Findings_Log F-005，已修复（reader-defect-fixes））。那时只比 URL
 * 的"章节不变"恒真，于是同时比较两者；修复后 URL 的读取由一次读数改为轮询（写回晚于正文渲染）。
 *
 * ## 翻页类快捷键（10.11–10.15）
 *
 * 滚动模式下 `Space` / `PageDown` 为 NEXT 翻页滚动、`Shift+Space` 为 PREV 翻页滚动（翻页模式需求 11.11、
 * 11.12），`Home` / `End` 跳到当前章章首 / 章末（需求 11.13），都 `preventDefault()`，只读写 `<main>` 的滚动
 * 几何。翻页滚动按 Turn_Duration（按键 100 ms 基准）平滑滚动（需求 10.12），所以按键后等 `<main>` 的
 * `scrollTop` 连续 3 帧不变（`waitScrollSettled`）再读数；断言滚动之前再核对一次文档不可滚动（需求 2.1）。
 *
 * - 10.11（`Space`、`PageDown`）：保留一行（翻页模式需求 10.10，取代原条文"增量不超过 `clientHeight`、不小于
 *   `clientHeight` 的一半"）。按键前读可见区（`<main>` 的可视矩形减去与它交叠的顶栏、底栏；起始状态下两栏
 *   都可见，且没有导航或点击，不会自动隐藏）与其中的最后一行（含部分可见行）：可见区内的段落经
 *   `Range.getClientRects()` 按纵向重叠合并成行，标题区整块当作一行（design §7.6）。滚动停稳后断言这一行的
 *   上边与可见区顶边相差 ≤ 2 px（`scrollTop` 取整与锚点补偿的亚像素误差）。这一行按（区段、块、行在块内的
 *   偏移）找回，不经 `scrollTop` 换算：窗口挂卸章节时的锚点补偿会平移内容坐标。章节不变。
 * - 10.12：原条文是"章末按 `Space` 换到下一章"，翻页模式 D1 / 需求 10.1 把它改为跨章连续滚动（替代
 *   reader-consolidation 需求 9.4）。两个用例都先按 `End` 并核对 `scrollTop` 在章末（相差 ≤ 2 px）：
 *   - 下一个正文章节的区段紧接在当前章区段之下（区段边相差 ≤ 1 px），其标题尚在可见区之下；按 `Space` 后
 *     保留一行照常成立：翻页前可见区的最后一行属于当前章，翻页后留在可见区顶端，下一章的 `<h1>` 随之完整
 *     进入可见区，没有跳章；
 *   - 继续按 `Space`（同方向两次按键至少间隔 600 ms，需求 11.6；每次都保留一行），直到判定线进入下一章：
 *     当前章变为下一个正文章节，URL 的 `ch` 随之写回为其下标。
 * - 10.13（`Shift+Space`）：沿用原断言，`scrollTop` 减量在 (0, `clientHeight`] 内且不小于
 *   min(`clientHeight` / 2, 按键前 `scrollTop`)（容差 1 px），章节不变（分在两个用例中）。
 * - 10.14 / 10.15（`Home` / `End`）：`scrollTop` 变为当前章章首 / 章末（相差 ≤ 2 px），章节不变（分在两个用例中）。
 *
 * 历史：EV 验收时 `<main>` 没有可滚距离（F-002）：`Space` 在章中任何位置都被判为"已到章末"而直接换章，
 * 10.11、10.13–10.15 的滚动断言按 16.7 拆成预期失败用例；修复后改为普通用例。翻页模式（任务 21.4）起，
 * 10.11 的步长断言改为保留一行、加测 `PageDown`，10.12 改为跨章连续滚动，10.14 / 10.15 的端点改为当前章区段。
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
 * `reader-search.spec.ts` 的 9.3、9.11 相同）。"不变"类断言在按键后等 `scrollTop` 连续 3 帧不变（至少 3 个
 * 动画帧，不用固定时长；设计"补充场景的定位与断言"）再读一次比较；"变为"类断言用会重试的 `expect`。
 * 10.12 两次 `Space` 之间的等待是输入节奏（需求 11.6 的按键闸门），不是"不变"类断言的等待。
 */
import type { Page } from "@playwright/test";
import { DEFAULT_PAGE_ANIM } from "../../../src/utils/pageAnim";
import { KEY_TURN_GAP_MS } from "../../../src/utils/turnInput";
import { expect, test, type BookLog, type Lib } from "../../support/fixtures";
import { NAMES, overlayMarkers, reader, searchDrawer } from "../../support/locators";
import {
  bookUnderTest,
  expectCurrentChapter,
  expectDocumentNotScrollable,
  openReader,
  pageModeSpec,
  readChapterScroll,
  readCurrentRegion,
  readMainScroll,
  setMainScrollTop,
  waitFrames,
  type BookUnderTest,
  type ChapterScroll,
  type MainScroll,
} from "../../support/reader";
import { TIMEOUTS } from "../../support/settings";
import { step } from "../../support/step";

// ---------------------------------------------------------------------------
// 常量（取自需求条文）
// ---------------------------------------------------------------------------

/** 起始状态：当前章的可滚跨度不少于 `clientHeight` 的倍数。 */
const START_SCREENS = 2;

/** 起始状态的 `scrollTop` 离章首、章末的距离（px）；10.12、10.14、10.15 的"到端点"容差同为此值。 */
const EDGE_PX = 2;

/** 10.13 的减量容差（px）。 */
const STEP_TOLERANCE_PX = 1;

/** 10.11 / 10.12 保留一行：翻页后那一行的上边与可见区顶边之差的上限（px；`scrollTop` 取整与锚点补偿的亚像素误差）。 */
const KEEP_LINE_TOLERANCE_PX = 2;

/** 10.12：相邻两个章节区段"首尾相接"时，前者底边与后者顶边之差的上限（px，取整余量）。 */
const SECTION_JOIN_PX = 1;

/** 10.12：同方向两次翻页按键之间至少等这么久（需求 11.6 的 600 ms 加余量，输入节奏）。 */
const KEY_GAP_MS = KEY_TURN_GAP_MS + 150;

/** 10.12：从章末起，判定线进入下一章之前至多按几次 `Space`（每次约翻过一个可见区高，下一章紧接在章末之后）。 */
const MAX_CROSSING_TURNS = 4;

/** 滚动停稳的判定：`<main>` 的 `scrollTop` 连续这么多个动画帧不变。 */
const SETTLE_FRAMES = 3;

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

/** 报告里的像素值：保留一位小数。 */
function px(value: number): number {
  return Math.round(value * 10) / 10;
}

function describeScroll(m: MainScroll): string {
  return `scrollTop ${m.scrollTop}、clientHeight ${m.clientHeight}、scrollHeight ${m.scrollHeight}`;
}

function describeChapterScroll(c: ChapterScroll): string {
  return (
    `当前章区段 下标 ${c.chapterId}：scrollTop ${c.scrollTop}、章首 ${px(c.chapterStart)}、` +
    `章末 ${px(c.chapterEnd)}、clientHeight ${c.clientHeight}`
  );
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

/**
 * 等 `<main>` 的 `scrollTop` 连续 `SETTLE_FRAMES` 个动画帧不变（翻页滚动动画、锚点补偿都已结束）。
 * 至少等 `SETTLE_FRAMES` 帧；上限 `TIMEOUTS.wait`。不能与 Controlled_Clock 同用（rAF 随时钟停住）。
 */
async function waitScrollSettled(page: Page): Promise<void> {
  await reader(page).main.evaluate(
    async (el, { frames, timeoutMs }) => {
      const started = performance.now();
      let last = el.scrollTop;
      let stable = 0;
      while (stable < frames) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const now = el.scrollTop;
        if (now === last) {
          stable += 1;
        } else {
          stable = 0;
          last = now;
        }
        if (stable < frames && performance.now() - started > timeoutMs) {
          throw new Error(`<main> 的 scrollTop 在 ${timeoutMs} ms 内未连续 ${frames} 帧保持不变（最后为 ${now}）`);
        }
      }
    },
    { frames: SETTLE_FRAMES, timeoutMs: TIMEOUTS.wait },
  );
}

// ---------------------------------------------------------------------------
// 翻页滚动的读数：可见区、其中的最后一行、章节区段（翻页模式需求 10.1、10.10）
// ---------------------------------------------------------------------------

/** 纵向区间（视口坐标，px）。 */
interface Extent {
  top: number;
  bottom: number;
}

/** 一行（视口坐标），以及翻页后找回它所需的块定位。 */
interface LineMark extends Extent {
  /** 所在区段的 `data-chapter-id`。 */
  chapterId: number;
  /** −1 为标题区（`<article>` 的 `<header>`，整块当作一行，design §7.6）；否则为区段内第几个 `<p>`（从 0 起）。 */
  block: number;
  /** 行上边相对所在块上边的距离。 */
  offset: number;
}

/** 一个已挂载的章节区段（视口坐标）。 */
interface SectionBox extends Extent {
  chapterId: number;
  /** 区段带 `data-current="true"`（判定线所在章）。 */
  current: boolean;
  /** 区段内正文 `<h1>` 的位置与文本；没有时为 null。 */
  heading: (Extent & { text: string }) | null;
}

interface TurnReading {
  /** 可见区（Visible_Area）：`<main>` 的可视矩形减去与它交叠的顶栏、底栏。 */
  band: Extent;
  scrollTop: number;
  /** 可见区中的最后一行（含部分可见行）：`top < band.bottom` 的行里 `top` 最大的那一行；没有时为 null。 */
  lastLine: LineMark | null;
  /** 入参 `mark` 那一行此刻的上边；未给出或找不到它所在的块时为 null。 */
  markTop: number | null;
  /** `<main>` 下的章节区段，按文档顺序。 */
  sections: SectionBox[];
}

/**
 * 读翻页滚动的几何（测量，只读）。可见区按定义取：`<main>` 的可视矩形（边框盒上边 + `clientTop`，高
 * `clientHeight`），与之交叠的顶栏（banner）压低顶边、底栏（contentinfo）抬高底边，滑出视口的栏不计。
 * 行：与可见区交叠的段落经 `Range.getClientRects()` 按纵向重叠（超过较矮者一半）合并，各区段的标题区整块
 * 算一行。给出 `mark` 时另读那一行此刻的上边（所在块的上边 + 行在块内的偏移）。
 */
async function readTurn(page: Page, mark: LineMark | null = null): Promise<TurnReading> {
  const view = reader(page);
  const [main, topBar, bottomBar] = await Promise.all([
    view.main.elementHandle(),
    view.topBar.elementHandle(),
    view.bottomBar.elementHandle(),
  ]);
  if (main === null || topBar === null || bottomBar === null) throw new Error("找不到正文 <main>、顶栏或底栏");
  try {
    return await page.evaluate(
      ({ main: mainEl, topBar: topEl, bottomBar: bottomEl, mark: wanted }): TurnReading => {
        const mainRect = mainEl.getBoundingClientRect();
        const viewTop = mainRect.top + mainEl.clientTop;
        const viewBottom = viewTop + mainEl.clientHeight;
        let bandTop = viewTop;
        let bandBottom = viewBottom;
        const topRect = topEl.getBoundingClientRect();
        if (topRect.height > 0 && topRect.bottom > viewTop && topRect.top < viewBottom) {
          bandTop = Math.max(bandTop, topRect.bottom);
        }
        const bottomRect = bottomEl.getBoundingClientRect();
        if (bottomRect.height > 0 && bottomRect.bottom > viewTop && bottomRect.top < viewBottom) {
          bandBottom = Math.min(bandBottom, bottomRect.top);
        }

        const range = document.createRange();
        const linesOf = (p: Element): { top: number; bottom: number }[] => {
          range.selectNodeContents(p);
          const rects = Array.from(range.getClientRects())
            .filter((r) => r.height > 0 && r.width > 0)
            .sort((a, b) => a.top - b.top);
          const lines: { top: number; bottom: number }[] = [];
          for (const r of rects) {
            const line = lines[lines.length - 1];
            const overlap = line ? Math.min(line.bottom, r.bottom) - Math.max(line.top, r.top) : 0;
            if (line && overlap > 0.5 * Math.min(line.bottom - line.top, r.height)) {
              line.top = Math.min(line.top, r.top);
              line.bottom = Math.max(line.bottom, r.bottom);
            } else {
              lines.push({ top: r.top, bottom: r.bottom });
            }
          }
          return lines;
        };

        const candidates: LineMark[] = [];
        const sections: SectionBox[] = [];
        let markTop: number | null = null;
        for (const section of Array.from(mainEl.querySelectorAll<HTMLElement>("section[data-chapter-id]"))) {
          const chapterId = Number(section.dataset.chapterId);
          const article = section.querySelector("article");
          const header = article?.querySelector(":scope > header") ?? null;
          const paras = article ? Array.from(article.querySelectorAll("p")) : [];
          const rect = section.getBoundingClientRect();
          const h1 = section.querySelector("h1");
          const h1Rect = h1?.getBoundingClientRect();
          sections.push({
            chapterId,
            current: section.dataset.current === "true",
            top: rect.top,
            bottom: rect.bottom,
            heading:
              h1 && h1Rect ? { top: h1Rect.top, bottom: h1Rect.bottom, text: (h1.textContent ?? "").trim() } : null,
          });

          if (header) {
            const r = header.getBoundingClientRect();
            if (r.height > 0) candidates.push({ chapterId, block: -1, offset: 0, top: r.top, bottom: r.bottom });
          }
          for (let i = 0; i < paras.length; i++) {
            const r = paras[i].getBoundingClientRect();
            if (r.bottom <= bandTop || r.top >= bandBottom) continue;
            for (const line of linesOf(paras[i])) {
              candidates.push({ chapterId, block: i, offset: line.top - r.top, top: line.top, bottom: line.bottom });
            }
          }
          if (wanted && wanted.chapterId === chapterId) {
            const el = wanted.block < 0 ? header : paras[wanted.block];
            if (el) markTop = el.getBoundingClientRect().top + wanted.offset;
          }
        }

        let lastLine: LineMark | null = null;
        for (const line of candidates) {
          if (line.top < bandBottom && (lastLine === null || line.top > lastLine.top)) lastLine = line;
        }
        return {
          band: { top: bandTop, bottom: bandBottom },
          scrollTop: mainEl.scrollTop,
          lastLine,
          markTop,
          sections,
        };
      },
      { main, topBar, bottomBar, mark },
    );
  } finally {
    await Promise.all([main.dispose(), topBar.dispose(), bottomBar.dispose()]);
  }
}

function describeExtent(e: Extent): string {
  return `[${px(e.top)}, ${px(e.bottom)}]`;
}

function describeLine(line: LineMark): string {
  const block = line.block < 0 ? "标题区" : `第 ${line.block} 段`;
  return `下标 ${line.chapterId} 的${block}、块内偏移 ${px(line.offset)}，上边 ${px(line.top)}、下边 ${px(line.bottom)}`;
}

/**
 * 按一次 NEXT 翻页键，断言保留一行（翻页模式需求 10.10、11.11）：按键前可见区中的最后一行（含部分可见行）
 * 在滚动停稳后成为可见区顶端第一行，其上边与可见区顶边相差 ≤ `KEEP_LINE_TOLERANCE_PX`。返回按键前后的读数。
 */
async function turnNextKeepingLine(
  page: Page,
  key: KeyCase,
  item: string,
): Promise<{ before: TurnReading; line: LineMark; after: TurnReading }> {
  const { before, line } = await step(`${item} 按 ${key.label} 前：读可见区与其中的最后一行（含部分可见行）`, async () => {
    const reading = await readTurn(page);
    const last = reading.lastLine;
    if (last === null) throw new Error(`可见区 ${describeExtent(reading.band)} 内没有任何一行`);
    expect(
      last.top,
      `可见区 ${describeExtent(reading.band)} 的最后一行（${describeLine(last)}）应起于可见区顶边之下` +
        "（否则按需求 10.10 退化为整屏，不是本条的情形）",
    ).toBeGreaterThan(reading.band.top + KEEP_LINE_TOLERANCE_PX);
    return { before: reading, line: last };
  });
  await step(`按 ${key.label}`, () => page.keyboard.press(key.key));
  const after = await step(`等 <main> 的 scrollTop 连续 ${SETTLE_FRAMES} 帧不变后找回那一行`, async () => {
    await waitScrollSettled(page);
    const reading = await readTurn(page, line);
    test.info().annotations.push({
      type: "shortcut-reading",
      description:
        `${item} ${key.label}：可见区 ${describeExtent(before.band)} → ${describeExtent(reading.band)}；` +
        `<main> scrollTop ${before.scrollTop} → ${reading.scrollTop}；最后一行 ${describeLine(line)} → ` +
        `上边 ${reading.markTop === null ? "（找不到）" : px(reading.markTop)}`,
    });
    return reading;
  });
  await expectDocumentNotScrollable(page);
  await step(`${item} 保留一行：翻页前可见区的最后一行成为可见区顶端第一行（容差 ${KEEP_LINE_TOLERANCE_PX} px）`, () => {
    expect(
      Math.abs(after.band.top - before.band.top) + Math.abs(after.band.bottom - before.band.bottom),
      `可见区应不变（控制栏未移动）：${describeExtent(before.band)} → ${describeExtent(after.band)}`,
    ).toBeLessThanOrEqual(1);
    expect(after.markTop, `翻页后应仍能找到那一行（${describeLine(line)}）`).not.toBeNull();
    const top = after.markTop ?? Number.NaN;
    expect(
      Math.abs(top - after.band.top),
      `那一行（${describeLine(line)}）翻页后的上边 ${px(top)} 与可见区顶边 ${px(after.band.top)} 之差`,
    ).toBeLessThanOrEqual(KEEP_LINE_TOLERANCE_PX);
  });
  return { before, line, after };
}

// ---------------------------------------------------------------------------
// 起始状态
// ---------------------------------------------------------------------------

interface ReaderStart {
  plan: ShortcutPlan;
  /** 起始状态的读数。 */
  state: ReaderSnapshot;
}

/** 起始状态 (a) 对当前章区段的两个不等式（见文件头"起始状态"）；返回不满足的项（空数组即满足）。 */
function startStateProblems(c: ChapterScroll): string[] {
  const span = c.chapterEnd - c.chapterStart;
  const problems: string[] = [];
  if (span < START_SCREENS * c.clientHeight) {
    problems.push(`当前章的可滚跨度（章末 − 章首）${px(span)} < ${START_SCREENS} × clientHeight（${c.clientHeight}）`);
  }
  if (c.intoChapter < EDGE_PX || c.intoChapter > span - EDGE_PX) {
    problems.push(`scrollTop − 章首 = ${px(c.intoChapter)} 不在 [${EDGE_PX}, ${px(span - EDGE_PX)}] 内`);
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

  const mode = pageModeSpec(DEFAULT_PAGE_ANIM);
  await step(`起始状态：默认翻页模式（${mode.label}，<main data-page-mode="${mode.attr}">）`, async () => {
    await expect(reader(page).main).toHaveAttribute("data-page-mode", mode.attr);
  });

  await step("起始状态：把正文滚到当前章章中（<main> 的 scrollTop 设为章首 + clientHeight，以读者操作设定）", async () => {
    await expectDocumentNotScrollable(page);
    const at = await readChapterScroll(page);
    await setMainScrollTop(page, at.chapterStart + at.clientHeight);
    await waitScrollSettled(page);
    const c = await readChapterScroll(page);
    expect(c.chapterId, `滚动后当前章区段应仍为起始章节（${describeChapterScroll(c)}）`).toBe(chapter);
    expect(
      startStateProblems(c),
      `当前章应满足起始状态：可滚跨度 ≥ ${START_SCREENS} × clientHeight，scrollTop − 章首介于 ${EDGE_PX} px 与` +
        `可滚跨度 − ${EDGE_PX} px 之间（${describeChapterScroll(c)}）`,
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

/** 按下 `key`，等 `<main>` 的 `scrollTop` 停稳后读一次状态，前后读数记入注解 `shortcut-reading`。 */
async function pressAndRead(page: Page, before: ReaderSnapshot, key: KeyCase): Promise<ReaderSnapshot> {
  await step(`按 ${key.label}`, () => page.keyboard.press(key.key));
  return step(`等 <main> 的 scrollTop 连续 ${SETTLE_FRAMES} 帧不变后读取章节、滚动位置与抽屉状态`, async () => {
    await waitScrollSettled(page);
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
// 10.11 10.12 Space / PageDown
// ---------------------------------------------------------------------------

const SPACE: KeyCase = { label: "Space", key: "Space" };
const PAGE_DOWN: KeyCase = { label: "PageDown", key: "PageDown" };
const SHIFT_SPACE: KeyCase = { label: "Shift+Space", key: "Shift+Space" };
const HOME: KeyCase = { label: "Home", key: "Home" };
const END: KeyCase = { label: "End", key: "End" };

/** 滚动模式下执行 NEXT 翻页滚动的键（翻页模式需求 11.11）。 */
const TURN_NEXT_KEYS: readonly KeyCase[] = [SPACE, PAGE_DOWN];

test.describe("10.11 Space / PageDown 下翻：保留一行", () => {
  for (const key of TURN_NEXT_KEYS) {
    test(`10.11 按 ${key.label}：翻页前可见区中的最后一行（含部分可见行）成为可见区顶端第一行（容差 2 px），章节不变`, async ({
      page,
      lib,
      bookLog,
    }) => {
      const start = await readerStart(page, bookLog, await shortcutPlan(lib));
      await turnNextKeepingLine(page, key, "10.11");
      await expectSameChapter(await readSnapshot(page), start.state, "10.11");
    });
  }
});

/** 10.12 的前一步：按 `End` 到当前章章末，核对仍在起始章节、`scrollTop` 与章末相差 ≤ 2 px。 */
async function pressEndToChapterEnd(page: Page, start: ReaderStart): Promise<void> {
  await pressAndRead(page, start.state, END);
  await expectDocumentNotScrollable(page);
  await step(`10.12 前提：<main> 的 scrollTop 在当前章章末（相差 ≤ ${EDGE_PX} px）`, async () => {
    const at = await readChapterScroll(page);
    expect(at.chapterId, `当前章区段应仍为起始章节（${describeChapterScroll(at)}）`).toBe(start.plan.chapter);
    expect(Math.abs(at.scrollTop - at.chapterEnd), describeChapterScroll(at)).toBeLessThanOrEqual(EDGE_PX);
  });
}

test.describe("10.12 章末按 Space：跨章连续滚动", () => {
  test("10.12 先按 End 到章末，再按 Space：下一个正文章节的区段紧接在当前章之下，翻页保留一行，当前章的末行留在可见区顶端、下一章标题完整进入可见区（不跳章）", async ({
    page,
    lib,
    bookLog,
  }) => {
    const start = await readerStart(page, bookLog, await shortcutPlan(lib));
    const { facts } = start.plan.book;
    const { chapter, next } = start.plan;
    await pressEndToChapterEnd(page, start);

    await step("10.12 前提：下一个正文章节的区段紧接在当前章区段之下，其标题尚在可见区之下", async () => {
      const reading = await readTurn(page);
      const at = reading.sections.findIndex((s) => s.chapterId === chapter);
      const current = reading.sections[at];
      const following = reading.sections[at + 1];
      expect(current, `应挂着当前章（下标 ${chapter}）的区段`).toBeDefined();
      expect(following?.chapterId, `当前章区段之后应紧跟下一个正文章节（下标 ${next}）的区段`).toBe(next);
      if (current === undefined || following === undefined) return;
      expect(
        Math.abs(following.top - current.bottom),
        `下一章区段顶边 ${px(following.top)} 与当前章区段底边 ${px(current.bottom)} 之差（首尾相接）`,
      ).toBeLessThanOrEqual(SECTION_JOIN_PX);
      expect(following.heading, "下一章区段应有正文 <h1>").not.toBeNull();
      expect(
        following.heading?.top ?? Number.NaN,
        `下一章标题应尚在可见区 ${describeExtent(reading.band)} 之下`,
      ).toBeGreaterThanOrEqual(reading.band.bottom);
    });

    const { line, after } = await turnNextKeepingLine(page, SPACE, "10.12");

    await step("10.12 翻页前可见区的最后一行属于当前章（翻页后留在可见区顶端，见上一步）", () => {
      expect(line.chapterId, `那一行：${describeLine(line)}`).toBe(chapter);
    });
    await step(`10.12 下一个正文章节的标题「${facts.titles[next]}」完整位于可见区内`, () => {
      const heading = after.sections.find((s) => s.chapterId === next)?.heading ?? null;
      expect(heading, `应挂着下一章（下标 ${next}）的区段及其 <h1>`).not.toBeNull();
      if (heading === null) return;
      expect(heading.text, "下一章区段的 <h1>").toBe(facts.titles[next]);
      expect(
        { top: heading.top >= after.band.top, bottom: heading.bottom <= after.band.bottom },
        `下一章标题 ${describeExtent(heading)} 应位于可见区 ${describeExtent(after.band)} 内`,
      ).toEqual({ top: true, bottom: true });
    });
  });

  test("10.12 先按 End 到章末，再连续按 Space（每次保留一行）：判定线进入下一个正文章节后，当前章变为该章，URL 的 ch 变为其下标", async ({
    page,
    lib,
    bookLog,
  }) => {
    const start = await readerStart(page, bookLog, await shortcutPlan(lib));
    const { facts } = start.plan.book;
    const target = start.plan.next;
    await pressEndToChapterEnd(page, start);

    let pressedAt: number | null = null;
    let current: number | null = start.plan.chapter;
    for (let i = 1; i <= MAX_CROSSING_TURNS && current !== target; i++) {
      if (pressedAt !== null) {
        const rest = pressedAt + KEY_GAP_MS - Date.now();
        if (rest > 0) {
          await step(`距上一次 Space 满 ${KEY_GAP_MS} ms（需求 11.6 的按键闸门）`, () => page.waitForTimeout(rest));
        }
      }
      pressedAt = Date.now();
      await turnNextKeepingLine(page, SPACE, `10.12 第 ${i} 次`);
      current = (await readCurrentRegion(page))?.chapterId ?? null;
    }

    await step(`10.12 至多 ${MAX_CROSSING_TURNS} 次 Space 后判定线进入下一个正文章节「${facts.titles[target]}」`, () => {
      expect(current, "当前章区段（data-current）的 data-chapter-id").toBe(target);
    });
    await expectCurrentChapter(page, facts, target);
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

  test("10.14 按 Home：<main> 的 scrollTop 由起始状态（章内）变为当前章章首（区段顶边对齐容器顶边，相差 ≤ 2 px）", async ({
    page,
    lib,
    bookLog,
  }) => {
    const start = await readerStart(page, bookLog, await shortcutPlan(lib));
    await pressAndRead(page, start.state, HOME);
    await expectDocumentNotScrollable(page);
    await step(`10.14 <main> 的 scrollTop 与当前章章首相差 ≤ ${EDGE_PX} px`, async () => {
      const at = await readChapterScroll(page);
      expect(at.chapterId, "当前章区段").toBe(start.plan.chapter);
      expect(Math.abs(at.scrollTop - at.chapterStart), describeChapterScroll(at)).toBeLessThanOrEqual(EDGE_PX);
    });
  });

  test("10.15 按 End：章节不变", async ({ page, lib, bookLog }) => {
    const start = await readerStart(page, bookLog, await shortcutPlan(lib));
    const after = await pressAndRead(page, start.state, END);
    await expectSameChapter(after, start.state, "10.15");
  });

  test("10.15 按 End：<main> 的 scrollTop 由起始状态（章内）变为当前章章末（max(章首, 区段底边 − clientHeight)，相差 ≤ 2 px）", async ({
    page,
    lib,
    bookLog,
  }) => {
    const start = await readerStart(page, bookLog, await shortcutPlan(lib));
    await pressAndRead(page, start.state, END);
    await expectDocumentNotScrollable(page);
    await step(`10.15 <main> 的 scrollTop 与当前章章末相差 ≤ ${EDGE_PX} px`, async () => {
      const at = await readChapterScroll(page);
      expect(at.chapterId, "当前章区段").toBe(start.plan.chapter);
      expect(Math.abs(at.scrollTop - at.chapterEnd), describeChapterScroll(at)).toBeLessThanOrEqual(EDGE_PX);
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
