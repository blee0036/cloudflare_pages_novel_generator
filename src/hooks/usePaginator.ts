/**
 * 分页器：离屏测量、页表缓存与分页调度（design §2.2、§4.1、§4.2、§4.5；需求 2.1–2.6、3.4、14.2、14.3）。
 *
 * 分页靠"测量版式 = 显示版式"成立：`MeasureBox` 以 `measure` 变体渲染一整章 `ChapterContent`，
 * 外层用与 `PageSurface` 内容盒相同的类名（`PAGE_CONTENT_CLASS`），宽度天然一致；再按 design §4.2
 * 的 7 步读出行盒、切页、换算页首偏移，产出 `PageTable`。可测的算术都在 `utils/paginate.ts`
 * （`paragraphLines`、`paginateLines`、`pageStartOffsets`、`firstCharBelow`、`pageHeightFor`、
 * `layoutKeyOf`、`cachePageTable`、`neighborChapters`），这里只做读 DOM 与调度的那一半。
 *
 * ### layoutKey 与缓存
 *
 * `layoutKey` 由视口宽高（`<main>` 的 `clientWidth` / `clientHeight`）、五项排版设置与字体纪元拼成
 * （`layoutKeyOf`）。页表缓存只保留当前 `layoutKey` 下最近 5 章（`cachePageTable`），`layoutKey` 一变
 * 整体作废。换书（toc / 正文 / 双视图任一变化）同样作废。
 *
 * 缓存同时存两份：React state 供渲染读（`table`、`tableOf`、`paginatedIds`），ref 供事件回调读
 * （`pageCount`、`startsOf`、`ensurePaginated`）。两份在同一处写入；ref 那份立即生效，
 * `ensurePaginated` 刚补完的页表在同一个回调里就能读到。
 *
 * ### 三条分页路径
 *
 * - **当前章，渲染驱动**：当前章在当前 `layoutKey` 下没有页表时，本次渲染把它挂进 `MeasureBox`，
 *   本 hook 的 layout effect 测量后写缓存。React 在绘制前同步处理这次更新，读者看不到中间态。
 * - **相邻章，后台**：当前章就绪后，按"下一章 → 上一章"（`neighborChapters`，跳过卷节点）每次一章，
 *   在 `requestIdleCallback`（不支持时 `setTimeout(0)`）里分页。`paused` 为真（翻页或拖拽进行中）时
 *   不调度，已排上的撤销，结束后再排（需求 3.4、14.1）。跨章翻页提交后当前章一变，新相邻章随即排上
 *   （需求 14.3），宿主不必在 `onTurnSettled` 里另做什么。
 * - **兜底，当场同步**（`ensurePaginated`）：拖拽或点击要跨章而相邻章还没好时，经 `measureChapter`
 *   当场分页并写缓存，宁可一次长任务也不误报"没有下一页"。`measureChapter` 经 `flushSync` 只重渲
 *   `MeasureBox` 自己，不重渲宿主视图，拖拽途中不会让整个图层栈重渲（G4）。
 *
 * ### 重分页的触发
 *
 * | 触发 | 处理 |
 * | --- | --- |
 * | `ResizeObserver(<main>)` | 回调里 `flushSync` 更新视口，同一帧内重测，不先画一帧旧版式 |
 * | `fullscreenchange` | 同上；全屏切换最终也会表现为 `<main>` 尺寸变化，RO 会兜住 |
 * | 五项排版设置 | 随渲染进入 `layoutKey` |
 * | `document.fonts` 的 `loadingdone` 与 `ready` | 已加载的字体数变了才把字体纪元加 1，两个信号重复到达只算一次 |
 *
 * `layoutKey` 改变之前先调用宿主的 `beforeRelayout`（宿主在这里 `settle()` 进行中的翻页，需求 2.6）：
 * 事件驱动的三种在更新 state 之前调用；排版设置随 props 进来，由 layout effect 在测量之前调用，
 * 同样早于绘制。调用期间 `pageCount` / `startsOf` 仍按旧 `layoutKey` 作答，落定提交的页首偏移
 * 出自旧页表。此后宿主按新页表把阅读位置映回页（`pageIndexOf`，需求 2.5）。
 *
 * 视口宽或高为 0 时不分页，`table` 保留该章上一份页表（其 `layoutKey` 已过时），等 RO 报告
 * 非零尺寸再分页。测量前还会核对 `<main>` 的实际尺寸与 `layoutKey` 里的视口是否一致：不一致说明
 * RO 还没报到，先对齐视口、下一次渲染再测，缓存里因此不会出现贴错标签的页表。
 *
 * ### 对宿主的要求
 *
 * - 宿主组件自己渲染 `<main ref={mainRef}>`，并把 `measureBox` 放在 `<main>` 之内。layout effect 的
 *   执行顺序是先子后父：宿主的 effect 运行时 `<main>` 的 ref 与盒子的句柄都已就位。`<main>` 在宿主
 *   的整个生命周期内不换元素（RO 只在挂载时接上）。
 * - `<main>` 是定位元素（`relative`），是 `MeasureBox` 与 `PageSurface` 共同的包含块；`overflow: hidden`，
 *   测量期间那一整章的隐藏内容不会撑出滚动条，也不会改变 `<main>` 自身的尺寸（否则 RO 会循环）。
 * - `PageSurface` 铺满 `<main>`（`absolute inset-0`），内容盒用 `PAGE_CONTENT_CLASS` 与
 *   `PAGE_CONTENT_STYLE`。页高 `H = <main>.clientHeight − PAGE_PAD_TOP − PAGE_PAD_BOTTOM`。
 * - 与 `usePageTurner` 的接线：`pageCount`、`ensurePaginated`、`viewport` 直接传过去（引用稳定，
 *   读最新值）；`paused` 取 `turner.turning !== null`；`beforeRelayout` 调 `turner.settle()`；
 *   `<main data-paginated={paginatedIds.join(",")}>`。`paused` 要用到 `turner` 的渲染值，所以宿主先调
 *   `usePageTurner`，再调本 hook；给翻页器的三个回调经一个 ref 转到本 hook 的返回值上即可。
 *
 * 与本目录其他 hook 一样不做单元测试（项目不搭 jsdom）；纯函数在 `utils/paginate.test.ts` 测，
 * 运行时行为由 e2e 覆盖。
 */

import {
  createElement,
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";
import {
  ChapterContent,
  type ChapterContentChapter,
  type ChapterTypography,
} from "../components/reader/ChapterContent";
import type { BookToc } from "../types";
import { bodyParagraphs, splitParagraphs, type ChapterViews, type Para } from "../utils/locator";
import {
  PAGE_PAD_BOTTOM,
  PAGE_PAD_TOP,
  cachePageTable,
  cachedPageTable,
  firstCharBelow,
  layoutKeyOf,
  measureBoxTarget,
  neighborChapters,
  pageHeightFor,
  pageStartOffsets,
  paginateLines,
  paragraphLines,
  type LineBox,
  type PageTable,
  type PageTableCache,
  type VerticalExtent,
} from "../utils/paginate";

// ───────────────────────────── 页面内容盒 ─────────────────────────────

/**
 * 页面内容盒的类名（design §4.1）：水平内边距沿用滚动模式的 `px-4 sm:px-8`。
 *
 * `PageSurface` 的内容盒与 `MeasureBox` 的外层**必须**同用这一个常量：两者都以 `<main>` 为包含块、
 * 左右贴边，内边距相同，`<article>` 的可用宽度因此相同，折行也就相同（需求 2.3）。
 */
export const PAGE_CONTENT_CLASS = "px-4 sm:px-8";

/** 页面内容盒的上下内边距（design §4.1），供 `PageSurface` 使用。 */
export const PAGE_CONTENT_STYLE: CSSProperties = {
  paddingTop: PAGE_PAD_TOP,
  paddingBottom: PAGE_PAD_BOTTOM,
};

/**
 * `MeasureBox` 的样式（design §4.2）：绝对定位贴住 `<main>` 顶边、左右铺满，不可见但照常布局。
 * `contain` 把这一整章的布局与绘制隔离在盒内，不波及正在显示的页面。
 */
const MEASURE_BOX_STYLE: CSSProperties = {
  position: "absolute",
  visibility: "hidden",
  insetInline: 0,
  top: 0,
  contain: "layout style paint",
};

/** 章节渲染数据的缓存上限：当前章、相邻两章与翻页途中的目标章，留些余量。 */
const CHAPTER_CACHE_LIMIT = 8;

// ───────────────────────────── MeasureBox ─────────────────────────────

interface MeasureBoxHandle {
  /** 盒子里已经提交的正是 `chapter`（同一个对象）时返回盒子元素，否则为 `null`。 */
  holding(chapter: ChapterContentChapter): HTMLElement | null;
  /**
   * 经 `flushSync` 同步把 `chapter` 挂进盒子；是否真的挂上用 `holding` 判断。有渲染驱动的目标
   * （props 的 `chapter` 非空）时它优先（`measureBoxTarget`），强制挂载不生效。
   */
  mount(chapter: ChapterContentChapter): void;
  /**
   * 经 `flushSync` 同步撤下 `mount` 挂上的内容，盒子回到渲染驱动的目标。同步撤下：强制挂载不会活过
   * 挂上它的那次 `measureChapter`，不会留到之后某次渲染里与新的渲染驱动目标争盒子。
   */
  release(): void;
}

interface MeasureBoxProps {
  /** 渲染驱动的测量目标（当前章页表未就绪时为当前章），`null` 为空盒。 */
  chapter: ChapterContentChapter | null;
  typography: ChapterTypography;
}

/**
 * 离屏测量盒。只在有测量目标时渲染整章，平时是一个空 `<div>`。
 *
 * 自己持有"强制挂载"的状态：`measureChapter` 的 `flushSync` 只重渲这里，不重渲宿主视图，
 * 拖拽途中的兜底分页因此不会让整个页面图层栈重渲（design G4）。
 *
 * 宿主的渲染驱动测量假定：本次提交里待测的当前章非空时，盒子挂着的就是它。两条规则保证这一点：
 * 渲染驱动的目标优先于强制挂载（`measureBoxTarget`），强制挂载在 `measureChapter` 返回前同步撤下
 * （`release` 经 `flushSync`）。否则相邻章刚在空闲回调里测完、撤下还排在低优先级时改字号，盒子会在
 * 同步优先级的那次提交里仍挂着相邻章，宿主跳过测量，且此后不再重试，当前章停在旧页表上（需求 2.5）。
 */
const MeasureBox = memo(
  forwardRef<MeasureBoxHandle, MeasureBoxProps>(function MeasureBox({ chapter, typography }, ref) {
    const boxRef = useRef<HTMLDivElement | null>(null);
    /** 最近一次提交进 DOM 的目标。在 layout 时段更新，早于宿主的 layout effect。 */
    const committedRef = useRef<ChapterContentChapter | null>(null);
    const [forced, setForced] = useState<ChapterContentChapter | null>(null);
    const shown = measureBoxTarget(chapter, forced);

    useLayoutEffect(() => {
      committedRef.current = shown;
    }, [shown]);

    useImperativeHandle(
      ref,
      () => ({
        holding: (target) => (committedRef.current === target ? boxRef.current : null),
        mount: (target) => flushSync(() => setForced(target)),
        release: () => flushSync(() => setForced(null)),
      }),
      [],
    );

    // React 18 不认识 `inert` 属性，经 DOM 设置
    const setBox = useCallback((el: HTMLDivElement | null) => {
      boxRef.current = el;
      el?.setAttribute("inert", "");
    }, []);

    return createElement(
      "div",
      {
        ref: setBox,
        "aria-hidden": true,
        "data-measure-box": "",
        className: PAGE_CONTENT_CLASS,
        style: MEASURE_BOX_STYLE,
      },
      shown ? createElement(ChapterContent, { variant: "measure", chapter: shown, typography }) : null,
    );
  }),
);

// ───────────────────────────── 测量 ─────────────────────────────

/**
 * 读出盒子里那一章的页首偏移（design §4.2 的 7 步）。所有矩形都取视口坐标：分页只用差值，
 * 不必换算到盒子的坐标系。
 *
 * 1. 标题区 `<header>`（`<article>` 的直接子元素）整体记为一行，`block = -1`。用
 *    `getBoundingClientRect` 而不是 `offsetTop` / `offsetHeight`：后者取整，与带小数的字形矩形混用会差出亚像素。
 * 2. 每段 `<p data-para>` 的唯一文本节点 `getClientRects()`；
 * 3. 经 `paragraphLines` 合并成行并换算行界；
 * 4. `paginateLines(lines, H)` 切页；
 * 5. `pageStartOffsets` 换算页首偏移；
 * 6. 由调用方拼成 `PageTable`；
 * 7. 页界落在段中时，在该段文本节点上按字二分（`firstCharBelow`），每次读一个字的
 *    `Range.getBoundingClientRect()`。
 *
 * 读的全是布局，中途不写 DOM，整个过程只触发一次布局。
 */
function measureStarts(box: HTMLElement, paras: readonly Para[], pageHeight: number): number[] {
  const article = box.firstElementChild;
  if (!article) return [0];

  const lines: LineBox[] = [];
  /** `bodyParas` 下标 → 该段的文本节点，供第 7 步使用。 */
  const texts = new Map<number, Text>();
  const range = document.createRange();

  const header = article.querySelector(":scope > header");
  if (header) {
    const r = header.getBoundingClientRect();
    lines.push({ top: r.top, bottom: r.bottom, block: -1 });
  }

  for (const p of Array.from(article.querySelectorAll<HTMLElement>("p[data-para]"))) {
    const block = Number(p.dataset.para);
    if (!Number.isInteger(block) || !paras[block]) continue;
    // measure 变体保证每段恰好一个文本节点（ChapterContent 不在这一变体里渲染 <mark>）
    const node = p.firstChild instanceof Text ? p.firstChild : null;
    let rects: ArrayLike<VerticalExtent> = [];
    if (node) {
      texts.set(block, node);
      range.selectNodeContents(node);
      rects = range.getClientRects();
    }
    for (const line of paragraphLines(rects, p.getBoundingClientRect(), block)) lines.push(line);
  }

  const firsts = paginateLines(lines, pageHeight);
  return pageStartOffsets(lines, firsts, paras, (index) => {
    const { block, top } = lines[index];
    const para = paras[block];
    const node = texts.get(block);
    // 没有文本节点的段只有一行（paragraphLines 的退化分支），走不到这里
    if (!node) return para.offset;
    const at = firstCharBelow(node.data, top, (start, end) => {
      range.setStart(node, start);
      range.setEnd(node, end);
      const r = range.getBoundingClientRect();
      return r.height > 0 ? (r.top + r.bottom) / 2 : null;
    });
    return para.offset + at;
  });
}

/**
 * 一章的渲染数据。卷节点、越界章号返回 `null`。
 *
 * 段落取法与 `ReaderPage` 相同：章节原文**不得 `trim()`**（段落偏移以章首为基准，design §3.1），
 * 再跳过与标题重复的首段（`bodyParagraphs`）。页片段的 `para` 是这份数组的下标。
 */
function buildChapter(
  toc: BookToc,
  fullText: string,
  views: ChapterViews,
  chapterId: number,
): ChapterContentChapter | null {
  const meta = toc.chapters[chapterId];
  const position = views.contentPos.get(chapterId);
  if (!meta || position === undefined) return null;
  return {
    chapterId,
    title: meta.title,
    length: meta.length,
    position,
    total: views.contentIdx.length,
    paras: bodyParagraphs(splitParagraphs(fullText.slice(meta.start, meta.end)), meta.title),
  };
}

// ───────────────────────────── 调度与触发器 ─────────────────────────────

/**
 * 相邻章后台分页的 idle 超时（ms）：页面迟迟不空闲时，最迟这么久之后执行。给"跨章翻页提交后
 * 600ms 内完成新相邻章分页"（需求 14.3）留出一章测量的余量。
 */
const NEIGHBOR_IDLE_TIMEOUT_MS = 300;

/** 空闲时执行一次 `task`（不支持 `requestIdleCallback` 时退化为 `setTimeout(0)`），返回撤销函数。 */
function scheduleIdle(task: () => void): () => void {
  if (typeof window.requestIdleCallback === "function") {
    const handle = window.requestIdleCallback(() => task(), { timeout: NEIGHBOR_IDLE_TIMEOUT_MS });
    return () => window.cancelIdleCallback(handle);
  }
  const timer = window.setTimeout(task, 0);
  return () => window.clearTimeout(timer);
}

/**
 * 已加载完成的字体数。字体纪元只在它变化时前进：同一次加载的 `loadingdone` 与 `ready`
 * 先后到达只算一次，挂载时早已就绪的 `ready` 也不会白白重分页一次。
 */
function loadedFontCount(fonts: FontFaceSet): number {
  let n = 0;
  fonts.forEach((face) => {
    if (face.status === "loaded") n++;
  });
  return n;
}

/** Reader_Viewport 的宽高（CSS px）：`<main>` 的 `clientWidth` / `clientHeight`。 */
export interface PaginatorViewport {
  w: number;
  h: number;
}

const ZERO_VIEWPORT: PaginatorViewport = { w: 0, h: 0 };
const NO_IDS: readonly number[] = [];

/** 页表缓存连同它所属的书（`chapterCache` 的引用）。换书即作废。 */
interface TableStore {
  book: object;
  cache: PageTableCache | null;
}

// ───────────────────────────── hook ─────────────────────────────

export interface PaginatorOptions {
  /** 视图自己的 `<main>`。页面几何以它的 `clientWidth` / `clientHeight` 为准（见模块注释）。 */
  mainRef: RefObject<HTMLElement>;
  toc: BookToc;
  fullText: string;
  views: ChapterViews;
  /** 五项排版设置。只按字段取值，对象引用变化不触发重新分页。 */
  typography: ChapterTypography;
  /** 当前章（原始下标）。它在当前 `layoutKey` 下没有页表时，本次渲染挂上 `MeasureBox` 同步测量。 */
  chapterId: number;
  /**
   * 暂停相邻章的后台分页：翻页或拖拽进行中为真（`usePageTurner` 的 `turning !== null`，design §4.5）。
   * 当前章的渲染驱动分页与 `ensurePaginated` 不受影响。
   */
  paused?: boolean;
  /**
   * `layoutKey` 即将改变时调用：宿主在这里落定进行中的翻页（`usePageTurner.settle`，需求 2.6）。
   * 调用期间 `pageCount` / `startsOf` 仍按旧 `layoutKey` 作答。可能在 layout effect 里被调用。
   */
  beforeRelayout?: () => void;
}

export interface Paginator {
  /** 本次渲染的排版参数指纹（design §2.2）。 */
  layoutKey: string;
  /**
   * 当前章的页表。尚未测量为 `null`。当前 `layoutKey` 下还没有时（视口宽或高为 0 不分页，
   * 或本次渲染刚换了排版、绘制前的重测还没完成）退回该章上一份页表，其 `layoutKey` 已过时，
   * 可与 `layoutKey` 比较分辨。
   */
  table: PageTable | null;
  /** 渲染用：某章在当前 `layoutKey` 下的页表（如翻页图层栈里目标页所在的章）。没有时为 `null`。 */
  tableOf(chapterId: number): PageTable | null;
  /**
   * 事件回调用（引用稳定，读最新值）：某章在当前 `layoutKey` 下的页数，未分页为 `undefined`。
   * 即 `usePageTurner` 的 `pageCount`（`stepPage` 的入参）。
   */
  pageCount(chapterId: number): number | undefined;
  /** 事件回调用（引用稳定，读最新值）：某章在当前 `layoutKey` 下的页首表（翻页提交的 `turned` 事件、`Home`/`End`）。 */
  startsOf(chapterId: number): readonly number[] | undefined;
  /**
   * 兜底（引用稳定）：该章在当前 `layoutKey` 下还没有页表时当场同步分页并写缓存，返回后
   * `pageCount(chapterId)` 即可用（design §4.5）。即 `usePageTurner` 的 `ensurePaginated`。
   * 只能在事件回调、rAF、idle 回调里调用；视口为 0、章号不是正文章、或 React 正在渲染时什么也不做。
   */
  ensurePaginated(chapterId: number): void;
  /** 引用稳定，读最新值：ResizeObserver 缓存的视口尺寸，即 `usePageTurner` 的 `viewport`。 */
  viewport(): PaginatorViewport;
  /** 当前 `layoutKey` 下已就绪的章号，升序。宿主写成 `<main data-paginated>`（design §4.5 测试钩子）。 */
  paginatedIds: readonly number[];
  /**
   * 一章的渲染数据（标题、正文序号、`bodyParas`），同一章在缓存期内引用稳定。
   * 页片段必须由同一份 `paras` 经 `pageView` 得出（`PageFragment.para` 是它的下标）。
   * 卷节点、越界章号返回 `null`。
   */
  chapterOf(chapterId: number): ChapterContentChapter | null;
  /**
   * 当场同步测量一章，只返回结果、不写缓存（写缓存走 `ensurePaginated`）。只能在事件回调、rAF、
   * idle 回调里调用。视口宽或高为 0、`<main>` 实际尺寸与 `layoutKey` 里的视口不符、章号不是正文章、
   * React 正在渲染无法同步提交，或盒子正挂着待测的当前章而要测的是别的章（渲染驱动的目标优先，
   * 见 `MeasureBox`）时返回 `null`。
   */
  measureChapter(chapterId: number): PageTable | null;
  /** 离屏测量盒，宿主把它渲染在 `<main>` 之内。 */
  measureBox: ReactElement;
}

export function usePaginator(options: PaginatorOptions): Paginator {
  const { mainRef, toc, fullText, views, chapterId, paused = false } = options;
  const { contentWidth, fontFamily, fontSize, lineHeight, letterSpacing } = options.typography;

  const typography = useMemo<ChapterTypography>(
    () => ({ contentWidth, fontFamily, fontSize, lineHeight, letterSpacing }),
    [contentWidth, fontFamily, fontSize, lineHeight, letterSpacing],
  );

  // layoutKey 的另两部分：视口（RO 缓存值，ref 那份领先 state，供事件回调读）与字体纪元
  const [viewport, setViewport] = useState<PaginatorViewport>(ZERO_VIEWPORT);
  const viewportRef = useRef<PaginatorViewport>(viewport);
  const [fontEpoch, setFontEpoch] = useState(0);
  const layoutKey = layoutKeyOf({
    width: viewport.w,
    height: viewport.h,
    contentWidth,
    fontSize,
    lineHeight,
    letterSpacing,
    fontFamily,
    fontEpoch,
  });

  // 章节渲染数据的 LRU 缓存；换书（toc / 正文 / 双视图任一变化）整体作废
  const chapterCache = useMemo(
    () => ({ toc, fullText, views, map: new Map<number, ChapterContentChapter>() }),
    [toc, fullText, views],
  );
  const chapterOf = useCallback(
    (id: number): ChapterContentChapter | null => {
      const { map } = chapterCache;
      const hit = map.get(id);
      if (hit) {
        // 移到末尾，最近用过的最后淘汰
        map.delete(id);
        map.set(id, hit);
        return hit;
      }
      const built = buildChapter(chapterCache.toc, chapterCache.fullText, chapterCache.views, id);
      if (!built) return null;
      map.set(id, built);
      if (map.size > CHAPTER_CACHE_LIMIT) {
        const oldest = map.keys().next();
        if (!oldest.done) map.delete(oldest.value);
      }
      return built;
    },
    [chapterCache],
  );

  // 页表缓存（design §4.5）：state 供渲染读，ref 供事件回调读，两份只在 commitTable 里一起写
  const [store, setStore] = useState<TableStore>(() => ({ book: chapterCache, cache: null }));
  const storeRef = useRef<TableStore>(store);
  const cache = store.book === chapterCache ? store.cache : null;
  const fresh = cachedPageTable(cache, layoutKey, chapterId);
  /** 本次渲染要同步测量的章：当前章在当前 `layoutKey` 下没有页表时就是它。 */
  const pending = fresh ? null : chapterOf(chapterId);

  const boxRef = useRef<MeasureBoxHandle>(null);

  const measureChapter = useCallback(
    (id: number): PageTable | null => {
      const handle = boxRef.current;
      const main = mainRef.current;
      const chapter = chapterOf(id);
      if (!handle || !main || !chapter) return null;
      // 视口宽或高为 0：不分页，免得白挂一整章
      const pageHeight = pageHeightFor(viewport.w, viewport.h);
      if (pageHeight === null) return null;
      let mounted = false;
      try {
        // 盒子里已经是这一章（渲染驱动的目标恰好是它）时不必再挂一次
        let box = handle.holding(chapter);
        if (!box) {
          handle.mount(chapter);
          mounted = true;
          // 渲染或 layout effect 里调用时 flushSync 提交不了，盒子里还是别的内容
          box = handle.holding(chapter);
          if (!box) return null;
        }
        // 挂载之后再读尺寸：读尺寸与测量共用同一次布局。与 layoutKey 里的视口不符说明 RO 还没
        // 报到，测出来的页表会贴错标签；不测，等 RO 更新视口后重来
        if (main.clientWidth !== viewport.w || main.clientHeight !== viewport.h) return null;
        return { chapterId: id, layoutKey, starts: measureStarts(box, chapter.paras, pageHeight) };
      } finally {
        if (mounted) handle.release();
      }
    },
    [chapterOf, layoutKey, mainRef, viewport.w, viewport.h],
  );

  /** 最近一次提交的渲染值，供引用稳定的回调读取。在 layout 时段刷新，早于本 hook 其余 effect。 */
  const latestRef = useRef({
    book: chapterCache as object,
    views,
    chapterId,
    measureChapter,
    beforeRelayout: options.beforeRelayout,
  });
  useLayoutEffect(() => {
    latestRef.current = { book: chapterCache, views, chapterId, measureChapter, beforeRelayout: options.beforeRelayout };
  });

  /**
   * 事件回调眼中的当前 `layoutKey`。比渲染值晚一步：`beforeRelayout` 调用完才前进，
   * 落定翻页时提交的页首偏移因此出自旧页表（见模块注释）。
   */
  const appliedKeyRef = useRef(layoutKey);

  /**
   * 写入一张页表（三条分页路径的汇合点）。测量期间 `layoutKey` 已前进时丢弃。
   * 淘汰时保住当前章与相邻两章（`cachePageTable` 的 `keep`）。
   */
  const commitTable = useCallback((table: PageTable): void => {
    if (table.layoutKey !== appliedKeyRef.current) return;
    const { book, views: currentViews, chapterId: current } = latestRef.current;
    const prev = storeRef.current.book === book ? storeRef.current.cache : null;
    const keep = [current, ...neighborChapters(currentViews, current)];
    const next: TableStore = { book, cache: cachePageTable(prev, table, keep) };
    storeRef.current = next;
    setStore(next);
  }, []);

  const startsOf = useCallback((id: number): readonly number[] | undefined => {
    const { book, cache: latest } = storeRef.current;
    if (book !== latestRef.current.book) return undefined;
    return cachedPageTable(latest, appliedKeyRef.current, id)?.starts;
  }, []);

  const pageCount = useCallback((id: number): number | undefined => startsOf(id)?.length, [startsOf]);

  const ensurePaginated = useCallback(
    (id: number): void => {
      if (startsOf(id)) return;
      const table = latestRef.current.measureChapter(id);
      if (table) commitTable(table);
    },
    [startsOf, commitTable],
  );

  const readViewport = useCallback((): PaginatorViewport => viewportRef.current, []);

  /**
   * 把 `<main>` 的实际尺寸同步进视口。尺寸变了才动：先 `beforeRelayout`（落定进行中的翻页，
   * 需求 2.6），再更新 state，`layoutKey` 随之前进。事件回调里经 `flushSync` 调用，同一帧内重测。
   */
  const syncViewport = useCallback((): void => {
    const main = mainRef.current;
    if (!main) return;
    const next: PaginatorViewport = { w: main.clientWidth, h: main.clientHeight };
    const current = viewportRef.current;
    if (next.w === current.w && next.h === current.h) return;
    latestRef.current.beforeRelayout?.();
    viewportRef.current = next;
    setViewport(next);
  }, [mainRef]);

  // layoutKey 前进：先落定进行中的翻页，再让事件回调改按新 layoutKey 作答。事件驱动的触发器
  // 已在更新 state 前调过 beforeRelayout，这里对它们是空操作；排版设置随 props 进来，靠这里兜住
  useLayoutEffect(() => {
    if (appliedKeyRef.current === layoutKey) return;
    latestRef.current.beforeRelayout?.();
    appliedKeyRef.current = layoutKey;
  }, [layoutKey]);

  // 当前章的渲染驱动测量（design §4.2、§4.5）。宿主是 <main> 与盒子的祖先，运行到这里时两者都已提交
  useLayoutEffect(() => {
    if (!pending) return;
    const box = boxRef.current?.holding(pending);
    const main = mainRef.current;
    if (!box || !main) return;
    // 实际尺寸与 layoutKey 里的视口不符（挂载后首次测量，或 RO 还没报到）：先对齐视口，
    // 下一次渲染（仍在绘制前）按新 layoutKey 再测
    if (main.clientWidth !== viewport.w || main.clientHeight !== viewport.h) {
      syncViewport();
      return;
    }
    const pageHeight = pageHeightFor(viewport.w, viewport.h);
    // 视口宽或高为 0：不分页，`table` 保留上一份页表
    if (pageHeight === null) return;
    commitTable({ chapterId: pending.chapterId, layoutKey, starts: measureStarts(box, pending.paras, pageHeight) });
  }, [pending, layoutKey, viewport.w, viewport.h, mainRef, syncViewport, commitTable]);

  // Web 字体加载完成 → 字体纪元 +1（需求 2.5）。放在测量之后：基线是首次测量时已加载的字体数。
  // 依赖 `fontFamily`：换字体可能开始新一轮加载，届时的 `ready` 是一个新的 Promise
  const fontsSeenRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    const fonts: FontFaceSet | undefined = document.fonts;
    if (!fonts) return;
    if (fontsSeenRef.current === null) fontsSeenRef.current = loadedFontCount(fonts);
    let active = true;
    const onFonts = () => {
      if (!active) return;
      const seen = loadedFontCount(fonts);
      if (seen === fontsSeenRef.current) return;
      fontsSeenRef.current = seen;
      flushSync(() => {
        latestRef.current.beforeRelayout?.();
        setFontEpoch((epoch) => epoch + 1);
      });
    };
    fonts.addEventListener("loadingdone", onFonts);
    fonts.ready.then(onFonts, () => {
      /* 字体加载失败时沿用后备字体的排版，无需重分页 */
    });
    return () => {
      active = false;
      fonts.removeEventListener("loadingdone", onFonts);
    };
  }, [fontFamily]);

  // 视口尺寸变化（窗口缩放、旋屏、全屏、控制栏以外的任何重排）。回调里 flushSync：
  // RO 在布局之后、绘制之前回调，同步重测就不会先画一帧旧版式（design §4.5）
  useEffect(() => {
    const main = mainRef.current;
    if (!main || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => flushSync(syncViewport));
    observer.observe(main);
    return () => observer.disconnect();
  }, [mainRef, syncViewport]);

  // 全屏切换（顶栏按钮与 F11 都会派发）。尺寸此刻可能尚未变化，那样就交给 RO
  useEffect(() => {
    const onFullscreenChange = () => flushSync(syncViewport);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, [syncViewport]);

  // 相邻章后台分页（design §4.5，需求 3.4、14.3）：当前章就绪且未暂停时，每次排一章，
  // 写入缓存后本 effect 随 `cache` 变化重跑，再排下一章。翻页开始（paused）或排版变化时撤销
  const background =
    !paused && fresh
      ? (neighborChapters(views, chapterId).find((id) => !cachedPageTable(cache, layoutKey, id)) ?? null)
      : null;
  useEffect(() => {
    if (background === null) return;
    return scheduleIdle(() => ensurePaginated(background));
  }, [background, layoutKey, ensurePaginated]);

  const tableOf = useCallback(
    (id: number): PageTable | null => cachedPageTable(cache, layoutKey, id) ?? null,
    [cache, layoutKey],
  );

  const paginatedIds = useMemo(
    () =>
      cache && cache.layoutKey === layoutKey ? Array.from(cache.tables.keys()).sort((a, b) => a - b) : NO_IDS,
    [cache, layoutKey],
  );

  const measureBox = createElement(MeasureBox, { ref: boxRef, chapter: pending, typography });

  return {
    layoutKey,
    // 当前 layoutKey 下没有时退回该章上一份页表（缓存还没被新 layoutKey 的页表替换时才在）
    table: fresh ?? cache?.tables.get(chapterId) ?? null,
    tableOf,
    pageCount,
    startsOf,
    ensurePaginated,
    viewport: readViewport,
    paginatedIds,
    chapterOf,
    measureChapter,
    measureBox,
  };
}
