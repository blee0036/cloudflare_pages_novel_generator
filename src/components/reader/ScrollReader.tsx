/**
 * 连续滚动视图（design §7，需求 10）。
 *
 * 一个滚动容器（`<main>`）里按目录顺序首尾相接地挂着若干章，每章一个
 * `<section data-chapter-id>`，内含 `scroll` 变体的 `ChapterContent`：标题区（章节标题与
 * "第 N / 共 M 章"）加整章正文（需求 10.1）。章与章之间只有一道分隔线，正文末尾不再有
 * 章末导航卡（需求 12.8）。
 *
 * ### 结构上的约束（design §7.1）
 *
 * - `<main>` 保留 `relative`：段落与区段的 offsetParent 因此是滚动容器自己，`offsetTop` 与
 *   `scrollTop` 共用一个原点（容器的内边距边），测出来的值直接就是 `scrollTop`。
 *   **`<section>` 不得设任何定位属性**，否则 offsetParent 会落到区段上，段落坐标整体错位。
 * - 原内联渲染 `<main>` 上的 `pt-16` 挪到每个 `<section>`：区段顶边对齐容器顶边时，标题下移
 *   64px，与旧版 `scrollTop = 0` 时的屏幕位置相同；判定线 `scrollTop + TOP_BIAS`（56px）也落在
 *   该区段自己的上内边距里，判出的是这一章而不是前一章末段。
 * - `overflow-anchor: none`：原生 scroll anchoring 一律关闭，挂卸章节与重排的补偿由本视图
 *   手动完成（design §7.3），三家浏览器表现才一致。
 * - `touch-action: pan-y pinch-zoom`：触摸滚动与惯性交给浏览器（design G6，需求 10.8、10.9）。
 * - `tabIndex = 0`：滚动区里没有可聚焦的内容，`<main>` 自己进 Tab 序列，只用键盘的读者才能聚焦它
 *   （axe `scrollable-region-focusable`）。焦点圈只在键盘聚焦时画，见 `MAIN_CLASS`、`MAIN_TAB_INDEX`。
 *
 * ### 章节窗口（design §7.2，需求 10.2）
 *
 * 全书可能有几千章，同时只挂载 `chapterWindow` 给出的闭区间 `[lo, hi]`（正文序号，至多
 * `MAX_MOUNTED_CHAPTERS` 章）。窗口是"锚章 + 各章高度"的确定性函数：锚章是导航目标章
 * （滚动起来以后是判定线所在章）；已挂载过的章取实测区段高度，没测过的按"字数 × 已测像素/字"
 * 估算。估算只决定挂几章、不进入任何坐标，估错的代价只是多挂或少挂一章。
 *
 * 每次窗口提交后在 layout effect 里测一遍已挂载区段，再按新高度重算窗口；结果不变则不触发
 * 渲染。窗口重算时读到的高度都属于窗口内的章，挂上即被实测，所以几轮之内必然收敛。
 *
 * ### 当前章
 *
 * 当前章的区段带 `data-current="true"`。它随判定线变化得很频繁，所以不进 JSX、不触发渲染，
 * 由 `markCurrent` 直接改 DOM 属性；新挂上的区段在窗口提交后的 layout effect 里补上。窗口里
 * 同时有多个 `<article>`，e2e 靠它定位"当前章"（design §13.3）。
 *
 * ### 几何缓存与锚点补偿（design §7.3，需求 10.3）
 *
 * `geometryRef` 缓存已挂载区段的顶边、高度与各段顶边（`ScrollGeometry`）。**滚动路径上一次布局都
 * 不读**：重测只发生在可能改变几何的时机，统一走 `updateGeometry`：
 *
 * | 失效时机 | 入口 |
 * | --- | --- |
 * | 窗口变化（段落集合随之变化）、排版设置变化 | 窗口提交后的 layout effect |
 * | 容器或任一区段尺寸变化（窗口缩放、版心过渡逐帧推进） | `ResizeObserver` |
 * | 版心过渡结束（字间距这类不一定改变区段高度的变化） | `<article>` 的 `transitionend` |
 * | 全屏切换 | `fullscreenchange` |
 * | Web 字体加载完成 | `document.fonts` 的 `loadingdone` 与 `ready` |
 *
 * `scroll` 变体的 `<article>` 带 150ms 过渡：改字号的那次提交里，layout effect 测到的还是过渡
 * 起点的版式，真正的重排发生在随后几帧。`ResizeObserver` 在每帧布局之后、绘制之前回调，在那里重测
 * 并补偿，读者看不到任何一帧跳动；`transitionend` 兜住终态。
 *
 * 锚点（`ScrollAnchor`）是判定线处的那一段及其屏幕位置。滚动 rAF 只用缓存值重取锚点；每次重测前
 * 也先按**旧**缓存把锚点对到最新的 `scrollTop`，重测后令 `scrollTop = 新段顶 − delta`，这一段的
 * 屏幕位置因此保持不变。原生 scroll anchoring 已关闭（`overflow-anchor: none`），补偿全由这里完成。
 *
 * 补偿写入之后锚点不随之重取：`anchoredAtRef` 记着锚点对应的 `scrollTop`，补偿写入的回声事件
 * 读到的正是它，锚点原样保留。否则每次写入的取整误差会被吸收进 `delta`，一次过渡十来帧下来，
 * 误差会累积成肉眼可见的偏移。几何坐标用 `getBoundingClientRect` 换算（`offsetTop` 取整到整数
 * 像素，单是取整就可能吃掉 1px 的预算）。
 *
 * ### 位置上报与导航指令（design §3.1–§3.3，需求 1.6、1.7、10.4–10.7）
 *
 * 滚动 rAF 用缓存几何求判定线处的（章, 段）（`positionAt`），经位置归约器 `scrollPositionStep`
 * 判定后才 `onPosition` 上报。归约器在导航指令到达与落地时被钉住（`pin`），直到读者第一次真正
 * 操作（`wheel`、`pointerdown`、`touchstart`，以及视图处理的翻页、行滚动、章首章末键，统称
 * `user-input`）才松开：导航定位、挂卸补偿、重排补偿引起的 scroll 事件因此都不改动阅读位置，
 * "切到滚动模式再切回"能原样带回进入时的偏移（需求 1.7）。判定线换章只在松开之后才算数：此时
 * `data-current` 挪到新章、窗口改以新章为锚，并随上报一起交给 `ReaderPage` 更新当前章与 `?ch=`
 * （需求 10.4、10.5）。钉住期间当前章恒为导航目标章，与 `ReaderPage` 所知的一致。
 *
 * 导航指令（`nav`）按 `seq` 识别新指令，到达时以目标章为锚重算窗口；目标章挂上并测量之后才落地：
 * 落地挂在 `updateGeometry` 上，取代那一次的锚点补偿。窗口要变时，落地发生在随后那次同步提交的
 * layout effect 里，读者看不到中间态。落地后 `resetAnchor()`，之后的挂卸补偿以目标段为锚。
 *
 * ### 翻页滚动与句柄（design §7.6，需求 10.10–10.15、11.11–11.13）
 *
 * `turn()` 保留一行：可见区（`<main>` 的可视矩形减去此刻压在上面的顶栏、底栏）在翻页方向那条边
 * 附近的几段（`turnBlocks`，按缓存几何挑）逐段 `Range.getClientRects()` 合并成行，标题区整块
 * 当作一行，交给 `scrollTurnDelta`。到了容器尽头时，窗口那一端若已是全书那一端就 `onBoundary`，
 * 否则窗口还没跟上，原地不动（`planScrollTurn`）。
 *
 * 位移按 Turn_Duration（Tap 300ms、按键 100ms 基准）线性插值写 `scrollTop`；Reduced_Motion
 * 成立时直接赋值（需求 9.4）。动画期间若几何变化触发了锚点补偿，补偿量同样加到动画的起止点上：
 * 补偿只是换了坐标原点，读者看到的动画不跳。导航指令到达时动画立即停止，否则下一帧会把刚定好的
 * 位置写掉。`edge()`、`line()` 同样先停动画再瞬时赋值。
 *
 * ### 手势（design §5、§7.5、G6，需求 5.2–5.5、5.9、10.8、10.9、10.13、10.16）
 *
 * `useReaderGesture` 把 `<main>` 上的指针事件分成 Tap / Long_Press / Drag：
 *
 * - **Tap**：九宫格决策（`resolveTap`，滚动族规则 5：按下时打断了动画或惯性的那次 Tap 不翻页）。
 *   `turn` 走 300ms 基准的翻页滚动 `turnScroll(direction, "tap")`，不动控制栏（需求 5.11）；
 *   `show-controls` / `hide-controls` 交给 `onControls`。
 * - **鼠标拖拽**自绘：`scrollTop = startScrollTop + (start.y − p.y)`，`start` 是按下点，按住的那个字
 *   始终在指针下（需求 10.8）。释放时把释放点也作为一个采样，`estimateVelocity` 求指针速度，取负
 *   即正文初速度，按 `flingAt` 惯性滚动至停（需求 10.9）。滚到窗口尽头被夹住时，窗口那一端若已是
 *   全书那一端就停下；否则窗口随后会接上新章，惯性接着走。
 * - **触摸与触控笔**交给浏览器（`touch-action: pan-y`，Pointer Events 规定它对两者都生效）：原生
 *   跟手与惯性，浏览器接管时发 `pointercancel`，这里不自绘。滚轮同样全用原生（需求 10.16）。
 * - **长按**：`touch-action: pan-y` 下长按后再移动会被浏览器接管成原生滚动，选区扩展不下去。所以
 *   `<main>` 上挂 `{ passive: false }` 的 `touchmove`，处于 Long_Press 时 `preventDefault()`
 *   （design §5.3）。
 *
 * 拖拽与惯性都在内容坐标里定起点（`startScrollTop`、`base`），锚点补偿平移内容坐标时随翻页滚动动画
 * 一并平移（`shiftMotions`），拖过章界引起的挂卸不会让画面跳一下。
 *
 * **打断**（需求 10.13）：`<main>` 上任何 `pointerdown`、`wheel`（捕获阶段），以及按键翻页、章首章末、
 * 行滚动、导航指令，都立即停下翻页滚动动画与惯性（`stopMotion`）。`pointerdown` 那一次的结果记进
 * `pressAbortedRef`，手势层的 `abort()` 稍后读它作 `abortedAnimation`：捕获阶段先于手势层的监听器，
 * 等手势层再问时动画已经停了。滚动条上的按下手势层不处理，但同样会停下惯性，不与拖滚动条打架。
 * 惯性不受 Reduced_Motion 影响：需求 9.4 只要求 Tap 与按键的翻页滚动瞬时完成，触摸的原生惯性也照常。
 *
 * 与本目录其他组件一样不做 DOM 单元测试（项目不搭 jsdom）；静态标记见 `ScrollReader.test.tsx`，
 * 运行时行为由 e2e 覆盖。
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useReaderGesture } from "../../hooks/useReaderGesture";
import { useReducedMotion } from "../../hooks/useReducedMotion";
import type { BookToc, ChapterMeta } from "../../types";
import {
  NO_CONTENT_CHAPTER,
  bodyParagraphs,
  contentPositionOf,
  splitParagraphs,
  type ChapterViews,
} from "../../utils/locator";
import { chapterEdgeScrollTop, lineScrollTarget, maxScrollTop } from "../../utils/pageScroll";
import type { TapDecision } from "../../utils/pageGesture";
import { mergeLineRects, type VerticalExtent } from "../../utils/paginate";
import {
  EMPTY_SCROLL_GEOMETRY,
  VELOCITY_WINDOW_MS,
  anchorAt,
  anchoredScrollTop,
  chapterWindow,
  estimateVelocity,
  flingAt,
  navScrollTop,
  planScrollTurn,
  positionAt,
  scrollPositionStep,
  scrollTurnDelta,
  turnBlocks,
  visibleBand,
  type ChapterWindow,
  type MotionSample,
  type ScrollAnchor,
  type ScrollGeometry,
  type ScrollPosEvent,
  type ScrollPosState,
  type ScrollPosition,
  type TurnBlock,
} from "../../utils/scrollTurn";
import { turnBaseMs, turnDuration, type Pt } from "../../utils/turnMotion";
import { ChapterContent, type ChapterContentChapter, type ChapterTypography } from "./ChapterContent";
import type { NavRequest, ReaderViewHandle, ReaderViewProps, TurnDirection, TurnSource } from "./types";

// ───────────────────────────── 结构 ─────────────────────────────

/**
 * 滚动容器。与原内联渲染的 `<main>` 相同，只是 `pt-16` 挪到了区段上（见模块注释）。
 * `flex-1 min-h-0` 让它恰好占满 `ReaderPage` 根容器剩下的那一屏而不被正文撑高。
 *
 * 焦点圈只在 `:focus-visible` 时画（键盘聚焦）：2px 的 `--accent` 描边，与书架、最近阅读的焦点圈
 * 同色同宽。鼠标点击正文聚焦时 `:focus-visible` 不成立，浏览器自带的焦点圈也挂在 `:focus-visible`
 * 上，所以不画任何描边。描边用**负 offset** 画在容器内侧：`<main>` 四边贴着根容器的
 * `overflow-hidden`，画在外侧会被裁掉。
 *
 * 不加 `focus:outline-none`：Tailwind v4 里它把 `--tw-outline-style` 置为 `none`，而 `outline-2`
 * 的 `outline-style` 取的正是这个变量，两者同时生效时焦点圈的线型也成了 `none`，一笔都画不出来。
 */
const MAIN_CLASS =
  "relative flex-1 min-h-0 overflow-y-auto pb-28 px-4 sm:px-8 " +
  "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--accent)]";

/**
 * `<main>` 进 Tab 序列（axe `scrollable-region-focusable`，WCAG 2.1.1）。章末导航卡删除之后
 * （需求 12.8），滚动容器里只剩标题与段落，没有任何可聚焦的内容；只用键盘的读者需要能把焦点
 * 放到滚动区上。
 *
 * 焦点落在 `<main>` 自己身上时，阅读器快捷键照常生效：`readerAction` 的三条守卫只拦输入类元素与
 * 会被 `Space` 激活的按钮（`MAIN` 都不是），`ReaderPage` 在 `window` 上监听 `keydown`，事件从
 * `<main>` 冒泡上去。翻页、行滚动、章首章末这些由视图完成位移的键都 `preventDefault`
 * （`preventsDefault`），聚焦的滚动区不会再叠一次浏览器的默认按键滚动。
 */
const MAIN_TAB_INDEX = 0;

const MAIN_STYLE: CSSProperties = {
  overflowAnchor: "none",
  touchAction: "pan-y pinch-zoom",
};

/**
 * 章节区段。`[&+&]:border-t` 只给"前面紧挨着另一个区段"的区段画上边线，即章与章之间的分隔线，
 * 窗口首章的顶上没有线。不设定位属性（见模块注释）。
 */
const SECTION_CLASS = "pt-16 pb-8 [&+&]:border-t border-[var(--border)]";

/** 当前章区段上的标记属性（design §7.1）。 */
const CURRENT_ATTR = "data-current";

/** 没有正文章节时的空窗口（与 `chapterWindow` 对 `total < 1` 的返回值相同）。 */
const EMPTY_WINDOW: ChapterWindow = { lo: 0, hi: -1 };

/** `<main>` 下的章节区段，按窗口顺序。只查 DOM 树，不读布局。 */
function sectionsOf(main: HTMLElement): HTMLElement[] {
  return Array.from(main.querySelectorAll<HTMLElement>(":scope > section[data-chapter-id]"));
}

// ───────────────────────────── 几何 ─────────────────────────────

/**
 * 补偿的最小位移（px）。目标与当前 `scrollTop` 相差不超过它就不写：省掉取整噪声引起的写入
 * （写 `scrollTop` 会打断部分浏览器的触摸惯性），误差仍在需求 10.3 的 1px 之内，且锚点不变、
 * 不会累积。
 */
const COMPENSATE_MIN_PX = 0.5;

/**
 * `<article>` 上会改变几何的过渡属性（`ChapterContent` 的 `transition-all`）。颜色等过渡结束时
 * 不必重测；段落上的 `transition-colors` 也会冒泡上来，按目标元素与属性名一并滤掉。
 */
const GEOMETRY_TRANSITIONS = new Set(["font-size", "line-height", "letter-spacing", "max-width"]);

/**
 * 量出 `<main>` 下全部区段与段落的几何（滚动容器内容坐标）。调用方保证布局已就绪（layout effect
 * 或 `ResizeObserver` 回调里），这里一次性读完，不穿插任何写入。
 *
 * 坐标由 `getBoundingClientRect` 换算：内容坐标 `c` 在视口里位于
 * `main 顶边 + clientTop + c − scrollTop`，反解即得。与 `offsetTop` 同一坐标系（`<main>` 是
 * offsetParent），但保留亚像素。段落按 DOM 顺序收集，即 `data-para` 的顺序（`ChapterContent`
 * 的整章渲染逐段输出），下标与 `bodyParas` 对齐。
 */
function measureGeometry(main: HTMLElement): ScrollGeometry {
  const origin = main.getBoundingClientRect().top + main.clientTop - main.scrollTop;

  const chapterIds: number[] = [];
  const sectionTops: number[] = [];
  const sectionHeights: number[] = [];
  const paraTops: number[][] = [];
  for (const section of sectionsOf(main)) {
    const rect = section.getBoundingClientRect();
    chapterIds.push(Number(section.dataset.chapterId));
    sectionTops.push(rect.top - origin);
    sectionHeights.push(rect.height);

    const paras = section.querySelectorAll<HTMLElement>("p[data-para]");
    const tops = new Array<number>(paras.length);
    for (let i = 0; i < paras.length; i++) tops[i] = paras[i].getBoundingClientRect().top - origin;
    paraTops.push(tops);
  }
  return { chapterIds, sectionTops, sectionHeights, paraTops };
}

// ───────────────────────────── 翻页滚动 ─────────────────────────────

/** 浮动顶栏、底栏的高度（`h-14`）。只在找不到这两个元素时兜底用。 */
const CHROME_BAR_PX = 56;

/**
 * 此刻压在滚动容器上的控制栏矩形（视口坐标），供 `visibleBand` 扣除。
 *
 * 顶栏 `<header>` 与底栏 `<footer>` 是 `<main>` 的 `position: fixed` 兄弟节点（`ReaderPage`
 * 的根容器下），按标签取，读的是含滑入滑出途中位置的真实矩形。万一结构变了找不到它们，退回
 * "控制栏可见时上下各扣一栏高"。只在翻页时调用，不在滚动路径上。
 */
function chromeBars(main: HTMLElement, view: VerticalExtent, controlsVisible: boolean): VerticalExtent[] {
  const bars = main.parentElement?.querySelectorAll<HTMLElement>(":scope > header, :scope > footer");
  if (bars && bars.length) return Array.from(bars, (bar) => bar.getBoundingClientRect());
  if (!controlsVisible) return [];
  return [
    { top: view.top, bottom: view.top + CHROME_BAR_PX },
    { top: view.bottom - CHROME_BAR_PX, bottom: view.bottom },
  ];
}

/**
 * 候选块的行盒（视口坐标，按 `top` 升序）：段落经 `Range.getClientRects()` + `mergeLineRects`
 * 合并成行（检索高亮的 `<mark>` 与文本节点的矩形在这里合并），标题区整块当作一行。不在 DOM 里的
 * 块（窗口刚变、几何还没跟上）跳过。
 */
function blockLines(main: HTMLElement, blocks: readonly TurnBlock[]): VerticalExtent[] {
  const lines: VerticalExtent[] = [];
  const range = document.createRange();
  for (const { chapterId, para } of blocks) {
    const section = main.querySelector<HTMLElement>(`:scope > section[data-chapter-id="${chapterId}"]`);
    if (!section) continue;
    if (para < 0) {
      const header = section.querySelector("header");
      if (header) {
        const { top, bottom } = header.getBoundingClientRect();
        lines.push({ top, bottom });
      }
      continue;
    }
    const p = section.querySelector<HTMLElement>(`p[data-para="${para}"]`);
    if (!p) continue;
    range.selectNodeContents(p);
    for (const line of mergeLineRects(range.getClientRects(), para)) lines.push(line);
  }
  return lines.sort((a, b) => a.top - b.top);
}

/** 进行中的翻页滚动动画（`scrollTop` 从 `from` 线性插值到 `to`）。 */
interface TurnAnimation {
  from: number;
  to: number;
  /** 起始时刻（`performance.now()` 的时钟，与 rAF 时间戳相同）。 */
  t0: number;
  duration: number;
  raf: number;
}

// ───────────────────────────── 拖拽与惯性 ─────────────────────────────

/** 进行中的鼠标拖拽（design §7.5）。纵坐标都以 `<main>` 的边框盒为原点（`useReaderGesture` 的约定）。 */
interface MouseDrag {
  /** 拖拽起点对应的 `scrollTop`（内容坐标；锚点补偿时随之平移）。 */
  startScrollTop: number;
  /** 按下点的纵坐标。 */
  startY: number;
  /** 最近一次焦点的纵坐标，即释放点。 */
  lastY: number;
  /** 最近 `VELOCITY_WINDOW_MS` 内的焦点采样，释放时估计速度用。 */
  samples: MotionSample[];
}

/** 进行中的惯性滚动：`scrollTop = base + flingAt(v0, now − t0).offset`。 */
interface Fling {
  /** 释放时的 `scrollTop`（内容坐标；锚点补偿时随之平移）。 */
  base: number;
  /** 正文的初速度（px/s），正为向下（`scrollTop` 增大）。 */
  v0: number;
  /** 释放时刻（`performance.now()` 的时钟，与 rAF 时间戳相同）。 */
  t0: number;
  raf: number;
}

/** 惯性写入后读回值比目标少（或多）出这么多（px），视为已被夹在容器尽头。容得下浏览器的取整。 */
const FLING_CLAMP_PX = 1;

// ───────────────────────────── 章节数据 ─────────────────────────────

/**
 * 一章的渲染数据。段落的切分与 `ReaderPage` 原内联渲染完全相同：`splitParagraphs` 切本章原文
 * （**不 `trim`**，否则段落偏移整体平移），`bodyParagraphs` 跳过与标题重复的首段。段落偏移因此
 * 与进度、书签、检索、`?ch=` 用的是同一套章内偏移（design §3.1）。
 */
function buildChapter(
  fullText: string,
  meta: ChapterMeta,
  chapterId: number,
  position: number,
  total: number,
): ChapterContentChapter {
  const paras = bodyParagraphs(splitParagraphs(fullText.slice(meta.start, meta.end)), meta.title);
  return { chapterId, title: meta.title, length: meta.length, position, total, paras };
}

// ───────────────────────────── 高度估算 ─────────────────────────────

/**
 * 还没有任何实测区段时的"像素/字"：按版心宽排满一行的字数折算行高。只决定首帧挂几章，
 * 第一次测量后即被实测值取代。
 */
function typographicPxPerChar(t: ChapterTypography): number {
  const perLine = Math.max(1, t.contentWidth / Math.max(1, t.fontSize + t.letterSpacing));
  return (t.fontSize * t.lineHeight) / perLine;
}

/**
 * 区段高度缓存的有效范围：五项排版设置加滚动容器的宽度（版心比视口宽时，折行由视口宽决定）。
 * 任何一项变化，之前测过、此刻未挂载的章的高度一并作废。
 */
function layoutKeyOf(t: ChapterTypography, clientWidth: number): string {
  return [t.contentWidth, t.fontFamily, t.fontSize, t.lineHeight, t.letterSpacing, clientWidth].join("|");
}

// ───────────────────────────── 位置上报 ─────────────────────────────

/**
 * `<main>` 上算作读者操作的事件（design §3.3 的 `user-input`）。拖动滚动条也会在 `<main>` 上
 * 派发 `pointerdown`。一律被动监听、在捕获阶段接收：只记一笔，不拦截任何默认行为（滚轮与触摸
 * 滚动交给浏览器，需求 10.16），子元素阻止冒泡也漏不掉。
 */
const USER_INPUT_EVENTS = ["wheel", "pointerdown", "touchstart"] as const;

const USER_INPUT_OPTIONS: AddEventListenerOptions = { passive: true, capture: true };

/** 最近一次提交的输入快照（见 `latestRef`）。 */
interface LatestInputs {
  views: ChapterViews;
  toc: BookToc;
  typography: ChapterTypography;
  /** 已提交的窗口内各章，与 `geometryRef` 出自同一次提交，段落下标与 `paraTops` 对得上。 */
  chapters: readonly ChapterContentChapter[];
  onPosition: ReaderViewProps["onPosition"];
  onBoundary: ReaderViewProps["onBoundary"];
  onControls: ReaderViewProps["onControls"];
  controlsVisible: boolean;
  /** Reduced_Motion：翻页滚动直接赋值，不做动画（需求 9.4）。 */
  reducedMotion: boolean;
}

/** 窗口内某章的段落（`bodyParas`）；该章不在窗口内时为 `undefined`。至多 7 章，线性查找即可。 */
function parasIn(chapters: readonly ChapterContentChapter[], chapterId: number) {
  return chapters.find((chapter) => chapter.chapterId === chapterId)?.paras;
}

// ───────────────────────────── 组件 ─────────────────────────────

export const ScrollReader = forwardRef<ReaderViewHandle, ReaderViewProps>(function ScrollReader(
  props,
  ref,
) {
  const {
    toc,
    fullText,
    views,
    settings,
    nav,
    highlight,
    positionRef,
    controlsVisible,
    onPosition,
    onBoundary,
    onControls,
  } = props;

  // 系统设置变化时随之重渲染，下一次翻页即按新状态执行（需求 9.7）
  const reducedMotion = useReducedMotion();

  /** 滚动容器。在视图首次提交时就存在，生命周期内不替换（`useReaderGesture` 的前提）。 */
  const mainRef = useRef<HTMLElement>(null);

  // 引用稳定：`ChapterContent` 是 memo 组件，排版不变时窗口挪动不重渲染已挂载的章
  const typography = useMemo<ChapterTypography>(
    () => ({
      contentWidth: settings.contentWidth,
      fontFamily: settings.fontFamily,
      fontSize: settings.fontSize,
      lineHeight: settings.lineHeight,
      letterSpacing: settings.letterSpacing,
    }),
    [
      settings.contentWidth,
      settings.fontFamily,
      settings.fontSize,
      settings.lineHeight,
      settings.letterSpacing,
    ],
  );

  /**
   * 最近一次提交的输入，供下面那些 identity 稳定的回调读取。回调稳定，依赖它们的 effect 才
   * 不会因为改字号之类的无关变化重跑（例如导航 effect 重跑会把锚章拽回导航目标）。
   * `chapters` 在首次提交的 layout effect ① 里才填上（窗口的渲染数据在下面才算出来）。
   */
  const latestRef = useRef<LatestInputs>({
    views,
    toc,
    typography,
    chapters: [],
    onPosition,
    onBoundary,
    onControls,
    controlsVisible,
    reducedMotion,
  });

  // ── 几何缓存与锚点（design §7.3）──

  /**
   * 已挂载区段与段落的几何，按窗口顺序（见模块注释）。只由 `updateGeometry` 重测；滚动路径、
   * 判定线定位与位置上报（16.3）、翻页滚动与 `edge()`（16.4）都只读这份缓存。
   */
  const geometryRef = useRef<ScrollGeometry>(EMPTY_SCROLL_GEOMETRY);
  /** 判定线处的锚点；还没测量过时为 null。 */
  const scrollAnchorRef = useRef<ScrollAnchor | null>(null);
  /** `scrollAnchorRef` 是在哪个 `scrollTop` 下取的。`lastScrollTopRef` 与它相同时锚点无需重取。 */
  const anchoredAtRef = useRef(Number.NaN);
  /**
   * 视图所知的最新 `scrollTop`：scroll 事件里读到的值，或本视图写入后读回的值。程序化写入一律走
   * `writeScrollTop`，保证它不落后于真实位置。
   */
  const lastScrollTopRef = useRef(0);
  /** 已排队的滚动 rAF；非 null 表示本帧已有待执行的处理。 */
  const scrollRafRef = useRef<number | null>(null);
  /** 观察 `<main>` 与各区段尺寸的 `ResizeObserver`，以及它当前观察着的区段。 */
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const observedRef = useRef(new Set<Element>());

  /** 区段实测高度（px），按章号（`toc.chapters[]` 下标）。卸载后保留，供窗口估算。 */
  const heightsRef = useRef(new Map<number, number>());
  /** `heightsRef` 对应的 `layoutKeyOf`。 */
  const heightsKeyRef = useRef("");
  /** 已挂载区段的"像素/字"实测值；还没测过时为 null，改用排版估算。 */
  const pxPerCharRef = useRef<number | null>(null);
  /** 滚动容器的视口高度。测量前以窗口高度粗估（无窗口环境为 0，窗口只含锚章 ± 1）。 */
  const viewportHeightRef = useRef(typeof window === "undefined" ? 0 : window.innerHeight);

  // ── 锚章与当前章 ──

  /**
   * 窗口的锚章（正文序号）。导航时为目标章；读者滚动后为判定线所在章（`onScrollFrame`）。
   * 与补偿用的判定线锚点 `scrollAnchorRef`（章号 + 段 + 屏幕位置）是两回事。
   */
  const anchorRef = useRef(contentPositionOf(views, nav.chapterId));
  /**
   * 当前章的章号（`data-current` 的归属）；没有正文章节时为 `NO_CONTENT_CHAPTER`。导航时为目标章，
   * 读者滚动后为判定线所在章，与 `ReaderPage` 经 `onPosition` 得知的当前章一致。
   */
  const currentIdRef = useRef(
    anchorRef.current === NO_CONTENT_CHAPTER ? NO_CONTENT_CHAPTER : views.contentIdx[anchorRef.current],
  );

  // ── 位置上报与导航指令（design §3.1–§3.3）──

  /**
   * 位置归约器的状态。初值钉住：视图总是以一条导航指令挂载，挂载时的定位同样不算读者移动。
   */
  const posStateRef = useRef<ScrollPosState>({ pinned: true });
  /**
   * 已到达但还没落地的导航指令（章号已归一为正文章节）。目标章挂上并测量后由 `applyPendingNav`
   * 落地并清空；非 null 期间不上报任何位置。
   */
  const pendingNavRef = useRef<NavRequest | null>(null);
  /**
   * 最近一次收下的指令：`seq` 加上当时的章节视图。两者都没变就不是新指令，即便 `nav` 换了个对象
   * 引用也不重新定位，否则会把已经滚走的读者拽回去。换书（`views` 变化）时同一条指令按新书重新落地。
   */
  const receivedNavRef = useRef<{ seq: number; views: ChapterViews } | null>(null);
  /**
   * 最近一条导航指令的目标（章号已归一）。钉住期间阅读位置就是它，而不是判定线处段落的段首
   * （检索命中可能落在段中），`bookmarkOffset()` 据此返回（需求 12.5、design §3.3）。
   */
  const navTargetRef = useRef<ScrollPosition | null>(null);

  // ── 翻页滚动（design §7.6）──

  /** 进行中的翻页滚动动画；null 表示没有。 */
  const turnAnimRef = useRef<TurnAnimation | null>(null);

  // ── 手势（design §5、§7.5）──

  /** 进行中的鼠标拖拽；null 表示没有（触摸拖拽交给浏览器，不进这里）。 */
  const dragRef = useRef<MouseDrag | null>(null);
  /** 进行中的惯性滚动；null 表示没有。 */
  const flingRef = useRef<Fling | null>(null);
  /**
   * 最近一次 `<main>` 上的 `pointerdown` 是否停下了动画或惯性（捕获阶段写入）。手势层的 `abort()`
   * 读它作本次手势的 `abortedAnimation`，读后清零（见模块注释"打断"）。
   */
  const pressAbortedRef = useRef(false);

  /** 以当前锚章与已知高度计算窗口（design §7.2）。只读 ref，identity 稳定。 */
  const computeWindow = useCallback((): ChapterWindow => {
    const anchor = anchorRef.current;
    if (anchor === NO_CONTENT_CHAPTER) return EMPTY_WINDOW;

    const { views: v, toc: t, typography: typo } = latestRef.current;
    const heights = heightsRef.current;
    const pxPerChar = pxPerCharRef.current ?? typographicPxPerChar(typo);
    return chapterWindow({
      anchor,
      total: v.contentIdx.length,
      heightOf: (position) => {
        const chapterId = v.contentIdx[position];
        return heights.get(chapterId) ?? (t.chapters[chapterId]?.length ?? 0) * pxPerChar;
      },
      viewportHeight: viewportHeightRef.current,
    });
  }, []);

  const [win, setWin] = useState<ChapterWindow>(computeWindow);

  /** 重算窗口；区间不变时保留原对象，不触发渲染。 */
  const refreshWindow = useCallback(() => {
    const next = computeWindow();
    setWin((prev) => (prev.lo === next.lo && prev.hi === next.hi ? prev : next));
  }, [computeWindow]);

  /**
   * 把 `data-current="true"` 挪到 `chapterId` 的区段上（design §7.1）。直接改 DOM 属性，不触发
   * 渲染；该章此刻未挂载时只记下章号，挂上后由窗口提交的 layout effect 补上。
   */
  const markCurrent = useCallback((chapterId: number) => {
    currentIdRef.current = chapterId;
    const main = mainRef.current;
    if (!main) return;
    const id = String(chapterId);
    for (const section of sectionsOf(main)) {
      if (section.dataset.chapterId === id) section.setAttribute(CURRENT_ATTR, "true");
      else section.removeAttribute(CURRENT_ATTR);
    }
  }, []);

  /**
   * 重测几何缓存，并更新区段高度缓存、"像素/字"与视口高度。只在几何事件里调用（见模块注释的
   * 失效时机表），滚动路径上不读任何布局（design §7.3）。返回是否测到了有效几何。
   */
  const measureSections = useCallback((): boolean => {
    const main = mainRef.current;
    // 宽为 0 = 容器还没参与布局（或被隐藏），这时测到的全是 0，不能进缓存
    if (!main || !main.clientWidth) return false;

    const { toc: t, typography: typo } = latestRef.current;
    viewportHeightRef.current = main.clientHeight;

    const key = layoutKeyOf(typo, main.clientWidth);
    if (key !== heightsKeyRef.current) {
      heightsKeyRef.current = key;
      heightsRef.current.clear();
      pxPerCharRef.current = null;
    }

    const geometry = measureGeometry(main);
    geometryRef.current = geometry;

    let px = 0;
    let chars = 0;
    geometry.chapterIds.forEach((chapterId, s) => {
      const height = geometry.sectionHeights[s];
      heightsRef.current.set(chapterId, height);
      const length = t.chapters[chapterId]?.length ?? 0;
      if (length > 0) {
        px += height;
        chars += length;
      }
    });
    if (chars > 0) pxPerCharRef.current = px / chars;
    return true;
  }, []);

  /**
   * 程序化写 `scrollTop`，并把读回的值（浏览器会夹取、取整）记进 `lastScrollTopRef`。本视图的
   * 所有程序化滚动都走这里（补偿；16.3 的导航定位、16.4 的翻页滚动），锚点同步才不会读到过期位置。
   */
  const writeScrollTop = useCallback((top: number) => {
    const main = mainRef.current;
    if (!main) return;
    main.scrollTop = top;
    lastScrollTopRef.current = main.scrollTop;
  }, []);

  /** 就地停下翻页滚动动画（不跳到终点）。没有动画时什么也不做，返回是否停下了一个动画。 */
  const stopTurnAnim = useCallback((): boolean => {
    const anim = turnAnimRef.current;
    if (!anim) return false;
    cancelAnimationFrame(anim.raf);
    turnAnimRef.current = null;
    return true;
  }, []);

  /** 就地停下惯性滚动。没有惯性时什么也不做，返回是否停下了一个。 */
  const stopFling = useCallback((): boolean => {
    const fling = flingRef.current;
    if (!fling) return false;
    cancelAnimationFrame(fling.raf);
    flingRef.current = null;
    return true;
  }, []);

  /**
   * 停下翻页滚动动画与惯性（需求 10.13），返回是否确实停下了其中之一。两者都要停，不能短路。
   * 进行中的鼠标拖拽不在此列：它跟着指针走，由手势自己结束。
   */
  const stopMotion = useCallback((): boolean => {
    const stoppedTurn = stopTurnAnim();
    const stoppedFling = stopFling();
    return stoppedTurn || stoppedFling;
  }, [stopTurnAnim, stopFling]);

  /**
   * 内容坐标平移了 `shift`（锚点补偿）：进行中的翻页滚动动画、鼠标拖拽、惯性的起点都在内容坐标里，
   * 一起平移，下一帧接着原来的轨迹走，画面不跳。
   */
  const shiftMotions = useCallback((shift: number) => {
    const anim = turnAnimRef.current;
    if (anim) {
      anim.from += shift;
      anim.to += shift;
    }
    const drag = dragRef.current;
    if (drag) drag.startScrollTop += shift;
    const fling = flingRef.current;
    if (fling) fling.base += shift;
  }, []);

  /**
   * 翻页滚动动画的一帧：按 Turn_Duration 线性插值写 `scrollTop`（需求 10.12）。rAF 时间戳可能
   * 略早于起始时刻，进度夹到 `[0, 1]`。写入照常触发 scroll 事件，位置由滚动 rAF 上报。
   */
  const turnFrame = useCallback(
    function frame(now: number) {
      const anim = turnAnimRef.current;
      if (!anim) return;
      const progress = Math.min(1, Math.max(0, (now - anim.t0) / anim.duration));
      writeScrollTop(anim.from + (anim.to - anim.from) * progress);
      if (progress >= 1) {
        turnAnimRef.current = null;
        return;
      }
      anim.raf = requestAnimationFrame(frame);
    },
    [writeScrollTop],
  );

  /**
   * 窗口在 `direction` 那一端的章是否已是全书那一端的正文章节（按缓存几何）。是，则容器尽头就是
   * 书首或书尾；否则窗口还没跟上，挂上新章之后还能接着滚（design §7.6 的"到达书首或书尾"）。
   */
  const windowAtBookEdge = useCallback((direction: TurnDirection): boolean => {
    const { contentIdx } = latestRef.current.views;
    const { chapterIds } = geometryRef.current;
    const bookEdgeId = direction === "next" ? contentIdx[contentIdx.length - 1] : contentIdx[0];
    const windowEdgeId = direction === "next" ? chapterIds[chapterIds.length - 1] : chapterIds[0];
    return windowEdgeId !== undefined && windowEdgeId === bookEdgeId;
  }, []);

  /**
   * 惯性滚动的一帧（design §7.5，需求 10.9）：`scrollTop = base + flingAt(v0, now − t0).offset`，
   * 减速至 `done` 即停。写入照常触发 scroll 事件，位置由滚动 rAF 上报。
   *
   * 读回值与目标相差超过 `FLING_CLAMP_PX` 说明被夹在了容器尽头：窗口那一端已是全书那一端时停下；
   * 否则窗口随后会接上新章（判定线进入窗口端章 → 换锚 → 重算窗口 → 锚点补偿平移 `base`），以夹住处
   * 为新起点接着走，越界的量不攒起来，接上新章时画面不跳。
   */
  const flingFrame = useCallback(
    function frame(now: number) {
      const fling = flingRef.current;
      if (!fling) return;
      const { offset, done } = flingAt(fling.v0, now - fling.t0);
      const target = fling.base + offset;
      writeScrollTop(target);
      if (done) {
        flingRef.current = null;
        return;
      }
      const actual = lastScrollTopRef.current;
      if (Math.abs(actual - target) > FLING_CLAMP_PX) {
        if (windowAtBookEdge(fling.v0 > 0 ? "next" : "prev")) {
          flingRef.current = null;
          return;
        }
        fling.base = actual - offset;
      }
      fling.raf = requestAnimationFrame(frame);
    },
    [writeScrollTop, windowAtBookEdge],
  );

  /**
   * 用**当前缓存**把锚点对到 `lastScrollTopRef`：滚动 rAF 每帧调用；`updateGeometry` 重测前也
   * 调用一次，此时缓存仍是旧几何，与读者刚看到的画面一致。只读缓存，不读布局。
   *
   * 锚点已对应这个 `scrollTop`（读者没动过，包括补偿写入的回声）时原样保留，见模块注释。几何为空
   * （还没测量过）时保留原锚点。
   */
  const syncAnchor = useCallback(() => {
    const top = lastScrollTopRef.current;
    if (scrollAnchorRef.current && anchoredAtRef.current === top) return;
    const anchor = anchorAt(geometryRef.current, top);
    if (!anchor) return;
    scrollAnchorRef.current = anchor;
    anchoredAtRef.current = top;
  }, []);

  /**
   * 放弃旧锚点，按此刻的真实 `scrollTop` 与当前缓存重新取锚（不补偿）。用于首次测量、锚点所在章
   * 已离开窗口，以及程序化定位之后（`applyPendingNav` 写入后调用）。
   */
  const resetAnchor = useCallback(() => {
    const main = mainRef.current;
    if (!main) return;
    const top = main.scrollTop;
    lastScrollTopRef.current = top;
    scrollAnchorRef.current = anchorAt(geometryRef.current, top);
    anchoredAtRef.current = top;
  }, []);

  /**
   * 几何重测之后：令 `scrollTop = 锚定段的新顶边 − delta`，判定线处那一段的屏幕位置保持不变
   * （需求 10.3）。没有锚点、或锚点所在章已不在窗口内时改为重新取锚。
   */
  const compensate = useCallback(() => {
    const anchor = scrollAnchorRef.current;
    const target = anchor ? anchoredScrollTop(geometryRef.current, anchor) : null;
    if (target === null) {
      // 内容坐标平移了多少无从得知：翻页滚动动画与惯性的起点随之失效，就地停下；
      // 鼠标拖拽改以此刻的画面为起点，接着跟手
      stopMotion();
      resetAnchor();
      const drag = dragRef.current;
      if (drag) {
        drag.startScrollTop = lastScrollTopRef.current;
        drag.startY = drag.lastY;
      }
      return;
    }
    const before = lastScrollTopRef.current;
    if (Math.abs(target - before) <= COMPENSATE_MIN_PX) return;
    writeScrollTop(target);
    // 锚点不变，只是换了个 scrollTop 与之对应：随后的回声 scroll 事件不会让它被重取
    anchoredAtRef.current = lastScrollTopRef.current;
    // 补偿量就是内容坐标的平移量
    shiftMotions(target - before);
  }, [stopMotion, resetAnchor, writeScrollTop, shiftMotions]);

  /** 位置归约器走一步（design §3.3），返回本次是否应当上报 `derived` 位置。 */
  const stepPosition = useCallback((event: ScrollPosEvent): boolean => {
    const { state, report } = scrollPositionStep(posStateRef.current, event);
    posStateRef.current = state;
    return report;
  }, []);

  /** 读者真正操作了（design §3.3 的 `user-input`）：此后判定线算出的位置照常上报。 */
  const markUserInput = useCallback(() => {
    stepPosition({ kind: "user-input" });
  }, [stepPosition]);

  /**
   * 让待落地的导航指令落地（design §3.1）：目标章已挂上且测量跟上了它的段落集合时，把目标段落置于
   * 判定线（`navScrollTop`：首段对齐区段顶边，否则段顶压在判定线上），再按新位置重新取锚。返回是否
   * 落地；没落地时指令继续挂着，等下一次测量。
   *
   * 只在 `measureSections` 刚测完时调用（`updateGeometry`），读到的几何与 DOM、与
   * `latestRef.current.chapters` 都出自同一次提交。落地时再钉一次：指令到达之后若恰有一次读者操作，
   * 定位仍然盖过它，不把定位产生的 scroll 事件当成读者移动。
   */
  const applyPendingNav = useCallback((): boolean => {
    const pending = pendingNavRef.current;
    if (!pending) return false;
    const paras = parasIn(latestRef.current.chapters, pending.chapterId);
    if (!paras) return false;
    const top = navScrollTop(geometryRef.current, pending.chapterId, paras, pending.charOffset);
    if (top === null) return false;

    pendingNavRef.current = null;
    stepPosition({ kind: "pin" });
    writeScrollTop(top);
    resetAnchor();
    return true;
  }, [stepPosition, writeScrollTop, resetAnchor]);

  /**
   * 几何可能变了（模块注释的失效时机表）：按旧缓存对齐锚点 → 重测 → 补偿 → 按新高度重算窗口。
   * 有待落地的导航指令且目标章已就绪时，以落地取代补偿：定位本来就要改写 `scrollTop`。
   * 幂等：几何没变时补偿位移为 0、窗口不变，不产生任何写入与渲染。
   */
  const updateGeometry = useCallback(() => {
    syncAnchor();
    if (!measureSections()) return;
    if (!applyPendingNav()) compensate();
    refreshWindow();
  }, [syncAnchor, measureSections, applyPendingNav, compensate, refreshWindow]);

  /** `ResizeObserver` 改为观察当前窗口内的区段（`<main>` 自己在创建时就已观察）。 */
  const syncObservedSections = useCallback(() => {
    const observer = resizeObserverRef.current;
    const main = mainRef.current;
    if (!observer || !main) return;

    const current = new Set<Element>(sectionsOf(main));
    for (const el of observedRef.current) {
      if (!current.has(el)) observer.unobserve(el);
    }
    for (const el of current) {
      if (!observedRef.current.has(el)) observer.observe(el);
    }
    observedRef.current = current;
  }, []);

  /**
   * 滚动 rAF：只读缓存（design §7.3、§7.4）。先对齐补偿锚点，再求判定线处的（章, 段），经位置
   * 归约器判定后上报（需求 10.6）。
   *
   * 判定线进入另一章（且归约器放行）时：`data-current` 挪过去、窗口改以该章为锚，上报的章号随之
   * 变化，`ReaderPage` 据此立即切换当前章、目录高亮、章节滑杆、书签状态，并以 `replace` 写回
   * `?ch=`（需求 10.4、10.5）。同章时上报只更新待落盘偏移，停下 1 秒后落盘（design §3.2）。
   *
   * 每帧都上报而不去重：读者还在滚，防抖就该一直顺延。
   */
  const onScrollFrame = useCallback(() => {
    syncAnchor();
    // 导航指令正等着落地：此刻的位置马上会被定位改写，不上报
    if (pendingNavRef.current) return;

    const { chapters, views: v, onPosition: report } = latestRef.current;
    const position = positionAt(
      geometryRef.current,
      (chapterId) => parasIn(chapters, chapterId),
      lastScrollTopRef.current,
    );
    if (!position) return;
    if (!stepPosition({ kind: "derived", ...position })) return;

    if (position.chapterId !== currentIdRef.current) {
      markCurrent(position.chapterId);
      anchorRef.current = contentPositionOf(v, position.chapterId);
      refreshWindow();
    }
    report(position.chapterId, position.charOffset);
  }, [syncAnchor, stepPosition, markCurrent, refreshWindow]);

  /**
   * 本书各章的渲染数据缓存。正文与章节表一变整体作废；窗口挪动时只为新挂上的章切段落，
   * 已挂载章的对象引用不变（`ChapterContent` 的 memo 因此生效），离开窗口的章随即丢弃。
   */
  const chapterCache = useMemo(
    () => ({ fullText, toc, views, byId: new Map<number, ChapterContentChapter>() }),
    [fullText, toc, views],
  );

  const windowChapters = useMemo(() => {
    const { byId, views: v, toc: t, fullText: text } = chapterCache;
    const total = v.contentIdx.length;
    const chapters: ChapterContentChapter[] = [];
    const mounted = new Set<number>();

    // 换书的那一次提交里窗口还是上一本书的，夹到本书范围内；随后的导航 effect 会重算
    for (let position = Math.max(0, win.lo); position <= Math.min(win.hi, total - 1); position++) {
      const chapterId = v.contentIdx[position];
      const meta = t.chapters[chapterId];
      if (!meta) continue;
      let chapter = byId.get(chapterId);
      if (!chapter) {
        chapter = buildChapter(text, meta, chapterId, position, total);
        byId.set(chapterId, chapter);
      }
      chapters.push(chapter);
      mounted.add(chapterId);
    }

    for (const chapterId of byId.keys()) {
      if (!mounted.has(chapterId)) byId.delete(chapterId);
    }
    return chapters;
  }, [chapterCache, win.lo, win.hi]);

  // ── layout effects（按声明顺序执行，次序有意义）──

  // ① 先同步输入快照，后面的 effect 与回调读到的都是本次提交的值
  useLayoutEffect(() => {
    latestRef.current = {
      views,
      toc,
      typography,
      chapters: windowChapters,
      onPosition,
      onBoundary,
      onControls,
      controlsVisible,
      reducedMotion,
    };
  });

  // ② 换书：上一本书的区段高度、几何与锚点都按章号记录，对新书毫无意义
  useLayoutEffect(() => {
    heightsRef.current.clear();
    heightsKeyRef.current = "";
    pxPerCharRef.current = null;
    geometryRef.current = EMPTY_SCROLL_GEOMETRY;
    scrollAnchorRef.current = null;
    anchoredAtRef.current = Number.NaN;
  }, [toc]);

  // ③ 尺寸观察：必须声明在 ④ 之前，首次提交里 ④ 才能把区段交给它观察。`<main>` 与各区段的尺寸
  //   变化（窗口缩放、版心过渡逐帧推进）都在布局之后、绘制之前回调，补偿因此不会晚一帧。
  //   回调只读布局、只写 `scrollTop`，不改任何被观察元素的尺寸，不会形成回调循环。
  useLayoutEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    const observer = new ResizeObserver(() => updateGeometry());
    observer.observe(main);
    resizeObserverRef.current = observer;
    return () => {
      observer.disconnect();
      resizeObserverRef.current = null;
      observedRef.current = new Set();
    };
  }, [updateGeometry]);

  // ④ 窗口（段落集合）或排版变化后：观察新挂上的区段 → 重测并补偿 → 给新区段补 `data-current`。
  //   重测里按实测高度重算窗口；窗口变了就再走一遍，几轮之内收敛（见模块注释）。
  useLayoutEffect(() => {
    syncObservedSections();
    updateGeometry();
    markCurrent(currentIdRef.current);
  }, [windowChapters, typography, syncObservedSections, updateGeometry, markCurrent]);

  // ⑤ 导航指令（design §3.1）：钉住位置归约器，以目标章为锚、当前章指向目标章，再走一遍
  //   `updateGeometry`。目标章已在窗口内时就地落地；不在时窗口随之改变，`setWin` 在本次提交末尾
  //   同步重渲染，落地发生在那次提交的 ④ 里，绘制之前就已定位。
  useLayoutEffect(() => {
    const received = receivedNavRef.current;
    if (received && received.seq === nav.seq && received.views === views) return;
    receivedNavRef.current = { seq: nav.seq, views };
    // 进行中的翻页滚动、惯性若不停，下一帧就会把即将定好的位置写掉；鼠标拖拽同理，
    // 这次拖拽余下的移动不再跟随（指针抬起前什么也不做）
    stopMotion();
    dragRef.current = null;

    const position = contentPositionOf(views, nav.chapterId);
    anchorRef.current = position;
    if (position === NO_CONTENT_CHAPTER) {
      // 没有正文章节：无处可落，窗口清空，由 `ReaderPage` 走错误页
      pendingNavRef.current = null;
      navTargetRef.current = null;
      refreshWindow();
      return;
    }

    const chapterId = views.contentIdx[position];
    pendingNavRef.current = { seq: nav.seq, chapterId, charOffset: nav.charOffset };
    navTargetRef.current = { chapterId, charOffset: nav.charOffset };
    stepPosition({ kind: "pin" });
    markCurrent(chapterId);
    updateGeometry();
  }, [nav, views, stopMotion, stepPosition, markCurrent, refreshWindow, updateGeometry]);

  // ── 事件监听 ──

  // 读者操作（design §3.3 的 `user-input`）：松开位置归约器。视图处理的按键在句柄方法里发出。
  useEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    for (const type of USER_INPUT_EVENTS) main.addEventListener(type, markUserInput, USER_INPUT_OPTIONS);
    return () => {
      for (const type of USER_INPUT_EVENTS) main.removeEventListener(type, markUserInput, USER_INPUT_OPTIONS);
    };
  }, [markUserInput]);

  // 滚动：rAF 节流，路径上零布局读取。scroll 事件派发时 `scrollTop` 已是最新值，读它不触发重排；
  // 本帧已排队时只更新位置，待执行的那一帧读到的永远是最新的 scrollTop。
  useEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    const onScroll = () => {
      lastScrollTopRef.current = main.scrollTop;
      if (scrollRafRef.current !== null) return;
      scrollRafRef.current = requestAnimationFrame(() => {
        scrollRafRef.current = null;
        onScrollFrame();
      });
    };
    main.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      main.removeEventListener("scroll", onScroll);
      if (scrollRafRef.current !== null) cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = null;
    };
  }, [onScrollFrame]);

  // 版心过渡结束：终态版式下再测一次。字间距这类变化不一定改变区段高度，`ResizeObserver` 未必回调。
  useEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    const onTransitionEnd = (event: TransitionEvent) => {
      if (!GEOMETRY_TRANSITIONS.has(event.propertyName)) return;
      if (!(event.target instanceof HTMLElement) || event.target.tagName !== "ARTICLE") return;
      updateGeometry();
    };
    main.addEventListener("transitionend", onTransitionEnd);
    return () => main.removeEventListener("transitionend", onTransitionEnd);
  }, [updateGeometry]);

  // 全屏切换（顶栏按钮与 F11 都会派发此事件）。尺寸变化通常也会触发 `ResizeObserver`，这里是显式兜底。
  useEffect(() => {
    document.addEventListener("fullscreenchange", updateGeometry);
    return () => document.removeEventListener("fullscreenchange", updateGeometry);
  }, [updateGeometry]);

  // Web 字体加载完成：首屏常以后备字体排版，字体到位后行高与段高都会变。换字体可能触发新一轮加载，
  // 所以依赖里带上 `fontFamily`，重新等一次 `ready`。
  useEffect(() => {
    const fonts: FontFaceSet | undefined = document.fonts;
    if (!fonts) return;

    let isCancelled = false;
    const onFontsLoaded = () => {
      if (!isCancelled) updateGeometry();
    };
    fonts.addEventListener("loadingdone", onFontsLoaded);
    fonts.ready.then(onFontsLoaded).catch(() => {
      /* 字体加载失败不影响测量，后备字体的布局已由其他时机覆盖 */
    });
    return () => {
      isCancelled = true;
      fonts.removeEventListener("loadingdone", onFontsLoaded);
    };
  }, [updateGeometry, typography.fontFamily]);

  // 卸载时停掉翻页滚动动画与惯性，rAF 不再写一个已经不在的容器
  useEffect(
    () => () => {
      stopMotion();
    },
    [stopMotion],
  );

  // 打断（需求 10.13，见模块注释）：按下与滚轮立即停下翻页滚动动画与惯性。捕获阶段，先于手势层；
  // 被动监听，不拦任何默认行为（滚轮照常原生滚动，需求 10.16）。滚动条上的按下手势层不处理，
  // 这里同样会停，惯性不与拖滚动条打架。
  useEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    const onPointerDown = () => {
      pressAbortedRef.current = stopMotion();
    };
    const onWheel = () => {
      stopMotion();
    };
    main.addEventListener("pointerdown", onPointerDown, USER_INPUT_OPTIONS);
    main.addEventListener("wheel", onWheel, USER_INPUT_OPTIONS);
    return () => {
      main.removeEventListener("pointerdown", onPointerDown, USER_INPUT_OPTIONS);
      main.removeEventListener("wheel", onWheel, USER_INPUT_OPTIONS);
    };
  }, [stopMotion]);

  /**
   * 一次保留一行的翻页滚动（design §7.6，需求 10.10–10.12、10.14、10.15）。句柄的 `turn` 以
   * `"key"` 调用（100ms 基准），九宫格 Tap 以 `"tap"` 调用（300ms 基准，任务 16.5）。
   *
   * 1. 读者的动作：先发出 `user-input`，随后的滚动才会上报位置（design §3.3）；有动画或惯性在走
   *    就地停下（需求 10.13），从此刻真实的画面算起；
   * 2. 可见区 = `<main>` 的可视矩形减去此刻压在上面的控制栏；翻页方向那条边换算成内容坐标，经
   *    `turnBlocks` 挑出附近的段落与标题区，读它们的行盒，`scrollTurnDelta` 求位移；
   * 3. `planScrollTurn` 夹到 `[0, maxScrollTop]` 并判定到边：全书尽头 `onBoundary`，窗口还没跟上
   *    则原地不动；
   * 4. 按 Turn_Duration 线性插值；Reduced_Motion 成立（或时长退化为 0）时直接赋值（需求 9.4）。
   */
  const turnScroll = useCallback(
    (direction: TurnDirection, source: TurnSource) => {
      const main = mainRef.current;
      if (!main) return;
      markUserInput();
      stopMotion();

      const { onBoundary: notify, controlsVisible: barsShown, reducedMotion: reduced } = latestRef.current;
      const rect = main.getBoundingClientRect();
      const viewTop = rect.top + main.clientTop;
      const view = { top: viewTop, bottom: viewTop + main.clientHeight };
      const band = visibleBand(view, chromeBars(main, view, barsShown));

      const scrollTop = main.scrollTop;
      const geometry = geometryRef.current;
      // 视口坐标 → 内容坐标：内容坐标 c 在视口里位于 viewTop + c − scrollTop
      const edgeY = (direction === "next" ? band.bottom : band.top) - viewTop + scrollTop;
      const lines = blockLines(main, turnBlocks(geometry, edgeY));
      const delta = scrollTurnDelta(lines, band.top, band.bottom, direction);

      const plan = planScrollTurn({
        scrollTop,
        maxScrollTop: maxScrollTop(main),
        delta,
        direction,
        windowAtBookEdge: windowAtBookEdge(direction),
      });
      if (plan.kind === "boundary") {
        notify(direction);
        return;
      }
      if (plan.kind === "none") return;

      const duration = reduced
        ? 0
        : turnDuration(turnBaseMs(source), 0, plan.to - plan.from, main.clientWidth, band.bottom - band.top);
      if (!(duration > 0) || !Number.isFinite(duration)) {
        writeScrollTop(plan.to);
        return;
      }
      turnAnimRef.current = {
        from: plan.from,
        to: plan.to,
        t0: performance.now(),
        duration,
        raf: requestAnimationFrame(turnFrame),
      };
    },
    [markUserInput, stopMotion, writeScrollTop, turnFrame, windowAtBookEdge],
  );

  // ── 手势（design §5、§7.5、G6）──

  /**
   * 手势开始时打断动画（需求 10.13）。捕获阶段的 `pointerdown` 监听已经停过一次，结果记在
   * `pressAbortedRef`；这里再停一次兜底（两次都要执行，不短路），合起来即本次手势的
   * `abortedAnimation`（design §5.5 规则 2、5）。读后清零，不留给下一次手势。
   */
  const abortMotion = useCallback((): boolean => {
    const stopped = stopMotion();
    const aborted = pressAbortedRef.current || stopped;
    pressAbortedRef.current = false;
    return aborted;
  }, [stopMotion]);

  /** 九宫格 Tap 的决策（design §5.5）：翻页走 300ms 基准的翻页滚动，不动控制栏（需求 5.11）。 */
  const onTap = useCallback(
    (decision: TapDecision) => {
      switch (decision.kind) {
        case "turn":
          turnScroll(decision.direction, "tap");
          return;
        case "show-controls":
          latestRef.current.onControls("show");
          return;
        case "hide-controls":
          latestRef.current.onControls("hide");
          return;
        case "none":
          return;
      }
    },
    [turnScroll],
  );

  /**
   * 鼠标拖拽的一步：`scrollTop = startScrollTop + (start.y − p.y)`（需求 10.8），并记一个速度采样。
   * 被夹在容器尽头时把起点挪到夹住处：指针回头时正文立即跟上，越界的量不攒起来（与 Legado 按增量
   * 滚动一致）；窗口随后接上新章时，锚点补偿照常平移起点。
   */
  const moveMouseDrag = useCallback(
    (focus: Pt) => {
      const drag = dragRef.current;
      if (!drag) return;
      const now = performance.now();
      drag.lastY = focus.y;
      const { samples } = drag;
      samples.push({ y: focus.y, t: now });
      // 只留速度时间窗内的采样（`estimateVelocity` 也只看这一段），长拖拽不让数组无限增长
      while (samples.length > 1 && samples[0].t < now - VELOCITY_WINDOW_MS) samples.shift();

      const travel = drag.startY - focus.y;
      const target = drag.startScrollTop + travel;
      writeScrollTop(target);
      const actual = lastScrollTopRef.current;
      if (Math.abs(actual - target) > FLING_CLAMP_PX) drag.startScrollTop = actual - travel;
    },
    [writeScrollTop],
  );

  /**
   * 拖拽开始。只自绘鼠标：触摸与触控笔由 `touch-action: pan-y` 交给浏览器原生跟手与惯性
   * （design G6），浏览器接管时手势层收到 `pointercancel`。按下点 `start` 处的那个字从此跟着指针走，
   * 越过 Touch_Slop 的那几像素随第一步一并追上。
   */
  const onDragStart = useCallback(
    (focus: Pt, pointerType: string, start: Pt) => {
      const main = mainRef.current;
      if (pointerType !== "mouse" || !main) return;
      markUserInput();
      stopMotion();
      dragRef.current = { startScrollTop: main.scrollTop, startY: start.y, lastY: start.y, samples: [] };
      moveMouseDrag(focus);
    },
    [markUserInput, stopMotion, moveMouseDrag],
  );

  /**
   * 拖拽释放（需求 10.9）：把释放那一刻也作为一个采样（指针停住后不再有 `pointermove`，没有这一点
   * 就看不出"停了一会儿才松手"），求指针速度；正文与指针反向，取负即惯性初速度。低于停止阈值时不起
   * 惯性。惯性不受 Reduced_Motion 影响（见模块注释）。
   */
  const endMouseDrag = useCallback(() => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;

    const now = performance.now();
    drag.samples.push({ y: drag.lastY, t: now });
    const v0 = -estimateVelocity(drag.samples, now);
    if (flingAt(v0, 0).done) return;

    stopFling();
    flingRef.current = { base: lastScrollTopRef.current, v0, t0: now, raf: requestAnimationFrame(flingFrame) };
  }, [stopFling, flingFrame]);

  const gesture = useReaderGesture({
    mainRef,
    family: "scroll",
    controlsVisible,
    abort: abortMotion,
    onTap,
    onDragStart,
    onDragMove: moveMouseDrag,
    onDragEnd: endMouseDrag,
  });
  const { isLongPressing } = gesture;

  // 触摸长按后扩展选区（design §5.3）：`touch-action: pan-y` 下长按后再移动会被浏览器接管成原生
  // 滚动，选区就扩展不下去了。长按期间位移不超过 Touch_Slop，浏览器还没开始滚动，这时的 `touchmove`
  // 仍可取消。只在 Long_Press 时拦，其余时候触摸滚动照常原生。
  useEffect(() => {
    const main = mainRef.current;
    if (!main) return;
    const onTouchMove = (event: TouchEvent) => {
      if (event.cancelable && isLongPressing()) event.preventDefault();
    };
    main.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => main.removeEventListener("touchmove", onTouchMove);
  }, [isLongPressing]);

  /**
   * 把还没处理的滚动帧立刻处理掉：按此刻的 `scrollTop` 求判定线位置并（归约器放行时）上报。
   * `settle()` 用它保证 `ReaderPage` 随后读到的位置不落后一帧（切模式时以它下发导航指令，需求 1.6）。
   */
  const flushScrollFrame = useCallback(() => {
    const main = mainRef.current;
    if (!main) return;
    if (scrollRafRef.current !== null) {
      cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = null;
    }
    lastScrollTopRef.current = main.scrollTop;
    onScrollFrame();
  }, [onScrollFrame]);

  // 翻页、章首章末、行滚动是视图处理的滚动键：读者的动作，先发出 `user-input`（design §3.3、§7.6），
  // 随后的滚动才会上报位置
  useImperativeHandle(
    ref,
    () => ({
      turn: (direction, source) => turnScroll(direction, source),
      // 章首 / 章末：判定线所在章（当前章）的区段，瞬时到位（需求 11.13）
      edge: (edge) => {
        markUserInput();
        stopMotion();
        const main = mainRef.current;
        const { chapterIds, sectionTops, sectionHeights } = geometryRef.current;
        const section = chapterIds.indexOf(currentIdRef.current);
        if (!main || section < 0) return;
        const top = sectionTops[section];
        const span = { top, bottom: top + sectionHeights[section] };
        writeScrollTop(chapterEdgeScrollTop(span, main.clientHeight, edge));
      },
      // 行滚动：`↑`/`↓` 每次 40px，到容器尽头原地不动（需求 11.13）
      line: (direction) => {
        markUserInput();
        stopMotion();
        const main = mainRef.current;
        if (!main) return;
        const target = lineScrollTarget(main, direction);
        if (target !== null) writeScrollTop(target);
      },
      /**
       * 当前阅读位置的章内偏移（需求 12.5）。钉住期间（导航定位之后、读者操作之前）是导航目标的偏移；
       * 之后是判定线处段落的偏移（需求 10.6）。判定线此刻不在当前章（换章的那一帧还没处理）时退回
       * `ReaderPage` 所知的位置。
       */
      bookmarkOffset: () => {
        const target = navTargetRef.current;
        if (posStateRef.current.pinned && target && target.chapterId === currentIdRef.current) {
          return target.charOffset;
        }
        const { chapters } = latestRef.current;
        const position = positionAt(
          geometryRef.current,
          (chapterId) => parasIn(chapters, chapterId),
          lastScrollTopRef.current,
        );
        if (position && position.chapterId === currentIdRef.current) return position.charOffset;
        return positionRef.current?.charOffset ?? 0;
      },
      // 落定：进行中的翻页滚动直接跳到终点（与分页模式"未取消的翻页直接落到目标"一致），惯性就地停下，
      // 再立刻上报位置
      settle: () => {
        const anim = turnAnimRef.current;
        if (stopTurnAnim() && anim) writeScrollTop(anim.to);
        stopFling();
        flushScrollFrame();
      },
      // 只看翻页滚动动画：惯性与鼠标拖拽不算，按键翻页会直接打断它们（design §7.5；见 `ReaderViewHandle`）
      isAnimating: () => turnAnimRef.current !== null,
    }),
    [positionRef, markUserInput, stopMotion, stopTurnAnim, stopFling, writeScrollTop, turnScroll, flushScrollFrame],
  );

  return (
    <main
      ref={mainRef}
      data-page-mode="scroll"
      tabIndex={MAIN_TAB_INDEX}
      className={MAIN_CLASS}
      style={MAIN_STYLE}
    >
      {windowChapters.map((chapter) => (
        <section key={chapter.chapterId} data-chapter-id={chapter.chapterId} className={SECTION_CLASS}>
          <ChapterContent
            variant="scroll"
            chapter={chapter}
            typography={typography}
            // 检索高亮按区段所属章渲染：只交给命中所在的那一章，其余区段的 props 不变、不重渲染
            highlight={highlight && highlight.chapterId === chapter.chapterId ? highlight : null}
          />
        </section>
      ))}
    </main>
  );
});
