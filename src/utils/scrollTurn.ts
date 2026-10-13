/**
 * 连续滚动视图的纯算术（design §7，需求 10）。
 *
 * 七件事：翻页滚动的位移（`scrollTurnDelta`，§7.6；取哪些行、可见区多大、到边怎么办见
 * `turnBlocks` / `visibleBand` / `planScrollTurn`）、章节挂载窗口（`chapterWindow`，§7.2）、
 * 判定线定位（`locateAt`，§7.4）、几何变化后的锚点补偿（`anchorAt` / `anchoredScrollTop`，§7.3）、
 * 导航定位与判定线位置的互逆换算（`navScrollTop` / `positionAt`，§3.1、§7.4）、
 * 位置上报的判定（`scrollPositionStep`，§3.3）、鼠标拖拽释放后的惯性（`estimateVelocity` /
 * `flingAt`，§7.5）。测量（读行盒、区段与段落的顶边）在
 * `ScrollReader` 的 layout effect 里做，这里只接收测量结果；时间一律由调用方以 ms 传入。不碰 DOM、
 * 不管定时器、不涉 React，因此能被直接做属性测试。
 *
 * 坐标约定：
 *
 * - `scrollTurnDelta` 的行盒与可见区是**视口坐标**（`getClientRects()` 的坐标系），返回的是
 *   `scrollTop` 的增量，正值向下；
 * - `locateAt`、`anchorAt` 的区段顶边、段落顶边与判定线 `y` 是**滚动容器内容坐标**（`offsetTop`
 *   的坐标系，即 `scrollTop` 的坐标系，`<main>` 设了 `relative`，design §7.1）。`ScrollReader`
 *   用 `getBoundingClientRect` 换算得到同一坐标系下的亚像素值，见 `ScrollGeometry`；
 * - `chapterWindow` 的下标是**正文序号**（`contentIdx` 的下标），不是 `toc.chapters[]` 的原始下标。
 *
 * 二分一律走 `locator.ts` 的 `upperBound`，全项目只有那一处二分实现（design §4.4）。
 */

import type { TurnDirection } from "../components/reader/types";
import { findParaIndex, upperBound, type Para } from "./locator";
import { EDGE_EPSILON_PX } from "./pageScroll";
import type { VerticalExtent } from "./paginate";

/** 把可能为脏值的像素量夹成非负有限数。非有限数按 0 处理（尚未测量的章即是如此）。 */
function asPx(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

// ───────────────────────────── 翻页滚动 ─────────────────────────────

/**
 * 滚动模式下一次翻页的位移：保留一行（design §7.6，需求 10.10、10.11）。
 *
 * 对应 Legado `ScrollPageDelegate` 的 `calcNextPageOffset` / `calcPrevPageOffset`，记
 * `H = visibleBottom − visibleTop`：
 *
 * - **NEXT**：取 `top < visibleBottom` 的最后一行 L，`delta = L.top − visibleTop`，即把翻页前
 *   可见区里的最后一行（含只露出上半截的那行）推到可见区顶端。`delta ≤ 0` 时 L 起于顶端或
 *   更上方（单行、标题区高于可见区，或可见区落在一道比它还高的空隙里），按这一行对齐就推不
 *   动，退化为整屏 `H`；
 * - **PREV**：取 `bottom > visibleTop` 的第一行 F，`delta = F.bottom − visibleBottom`，即把
 *   翻页前可见区里的第一行（含只露出下半截的那行）拉到可见区底端。`delta ≥ 0` 时退化为 `−H`。
 *
 * 由此 NEXT 的结果恒在 `(0, H]`、PREV 恒在 `[−H, 0)`，且不跳过未读内容：可见区下方（或上方）
 * 没露全的行，平移后都不会越过可见区的另一端（design Property 23）。与 Legado 不同的是不取整：
 * 行盒带小数时，"L 平移后恰好落在顶端"要按原值成立，`scrollTop` 的取整交给浏览器。
 *
 * `lines` 只需包含可见区两端附近的候选行（边缘所在段与相邻段的行，标题区整块当作一行），
 * 须按 `top` 升序、互不重叠（`mergeLineRects` 的产物天然满足）。这里按"满足条件的行里 `top`
 * 最大 / `bottom` 最小"挑选，对升序输入它就是"最后一行 / 第一行"，候选行只有十来条，不必二分。
 * 坐标非有限的行不携带位置信息，直接忽略。
 *
 * 可见区退化（`H` 非正或非有限，即容器尚未布局）时返回 0：没有可翻的页，调用方原地不动。
 * 返回值未夹到 `[0, maxScrollTop]`，夹取与"到边"判定由调用方完成（design §7.6 的"执行"）。
 */
export function scrollTurnDelta(
  lines: readonly VerticalExtent[],
  visibleTop: number,
  visibleBottom: number,
  direction: TurnDirection,
): number {
  const height = visibleBottom - visibleTop;
  if (!(height > 0) || !Number.isFinite(height)) return 0;

  if (direction === "next") {
    // L：top < visibleBottom 的最后一行
    let lastTop = -Infinity;
    for (const { top } of lines) {
      if (Number.isFinite(top) && top < visibleBottom && top > lastTop) lastTop = top;
    }
    const delta = lastTop - visibleTop;
    // 没有候选行时 lastTop 仍为 -Infinity，delta 同样不为正，一并退化为整屏
    return delta > 0 ? delta : height;
  }

  // F：bottom > visibleTop 的第一行
  let firstBottom = Infinity;
  for (const { bottom } of lines) {
    if (Number.isFinite(bottom) && bottom > visibleTop && bottom < firstBottom) firstBottom = bottom;
  }
  const delta = firstBottom - visibleBottom;
  return delta < 0 ? delta : -height;
}

/**
 * `scrollTurnDelta` 的候选块：哪一章的哪一段（`para` 为 `bodyParas` 下标，−1 表示标题区，
 * 标题区整块当作一行）。
 */
export interface TurnBlock {
  chapterId: number;
  para: number;
}

/**
 * 翻页滚动要读行盒的块（design §7.6 的"边缘所在段与相邻段，再加上标题区"）。只读缓存，调用方
 * 再对这些块逐个 `Range.getClientRects()`，读布局的量与全书、全章的长度无关。
 *
 * `y` 是可见区在翻页方向上的那条边，换算成滚动容器内容坐标：NEXT 传可见区底边（找最后一行），
 * PREV 传可见区顶边（找第一行）。记 `y` 所在区段为 s、该区段内 `paraTop ≤ y` 的最后一段为 p
 * （`y` 在首段之上时 p = −1）：
 *
 * - s 的标题区，以及 s 内的 p − 1、p、p + 1 段（存在的话）。NEXT 要的"`top < y` 的最后一行"
 *   落在 p 段（或 p 段首行恰好起于 `y` 之下时的 p − 1 段、标题区）；PREV 要的"`bottom > y` 的
 *   第一行"落在 p 段（或 `y` 落在段后空隙时的 p + 1 段）；
 * - p = −1（`y` 在 s 的标题区或上内边距里）时，加上前一区段的末段（没有正文段时取它的标题区）：
 *   `y` 落在上内边距里时，NEXT 要的那一行在前一章末尾；
 * - p 是 s 的末段（含 s 没有正文段）时，加上后一区段的标题区：`y` 落在 s 的下内边距里时，PREV
 *   要的那一行是下一章的标题区。
 *
 * 漏掉真正的 L / F 只会让位移变小（选中的行更靠近起点），不会跳过未读内容。几何为空或 `y`
 * 非有限时返回空数组，`scrollTurnDelta` 随之退化为整屏。
 */
export function turnBlocks(geometry: ScrollGeometry, y: number): TurnBlock[] {
  const { chapterIds, sectionTops, paraTops } = geometry;
  if (!sectionTops.length || !Number.isFinite(y)) return [];

  const { section } = locateAt(sectionTops, (s) => paraTops[s] ?? [], y);
  const chapterId = chapterIds[section];
  if (chapterId === undefined) return [];

  const tops = paraTops[section] ?? [];
  // 与 `locateAt` 同一口径，只是不把"首段之上"夹成 0
  const p = upperBound(tops, y) - 1;

  const blocks: TurnBlock[] = [{ chapterId, para: -1 }];
  for (let i = Math.max(0, p - 1); i <= Math.min(tops.length - 1, p + 1); i++) {
    blocks.push({ chapterId, para: i });
  }

  if (p < 0 && section > 0) {
    const prevId = chapterIds[section - 1];
    const prevCount = paraTops[section - 1]?.length ?? 0;
    if (prevId !== undefined) blocks.push({ chapterId: prevId, para: prevCount - 1 });
  }
  if (p >= tops.length - 1 && section + 1 < chapterIds.length) {
    blocks.push({ chapterId: chapterIds[section + 1], para: -1 });
  }
  return blocks;
}

/**
 * 可见区（Visible_Area）：滚动容器的可视矩形减去压在它上面的控制栏（design §7.6）。视口坐标。
 *
 * `bars` 是浮动顶栏、底栏此刻的矩形（含滑入滑出途中的位置）。与可视矩形没有交叠的栏（已滑出、
 * 尺寸为 0）不计；交叠的栏按中心位置归类：在可视矩形中线之上的是顶栏，压低顶边；之下的是底栏，
 * 抬高底边。被完全盖住时返回 `top === bottom` 的空区间，`scrollTurnDelta` 对它返回 0。
 */
export function visibleBand(
  view: VerticalExtent,
  bars: readonly VerticalExtent[],
): { top: number; bottom: number } {
  let { top, bottom } = view;
  const middle = (view.top + view.bottom) / 2;
  for (const bar of bars) {
    if (!(bar.bottom > bar.top) || bar.bottom <= view.top || bar.top >= view.bottom) continue;
    if ((bar.top + bar.bottom) / 2 <= middle) top = Math.max(top, bar.bottom);
    else bottom = Math.min(bottom, bar.top);
  }
  return { top, bottom: Math.max(top, bottom) };
}

/** `planScrollTurn` 的结论。 */
export type ScrollTurnPlan =
  /** 从 `from` 滚到 `to`（都已夹进 `[0, maxScrollTop]`，且不相等）。 */
  | { kind: "scroll"; from: number; to: number }
  /** 已在全书尽头：显示边界提示，保持滚动位置（需求 10.14、10.15）。 */
  | { kind: "boundary" }
  /** 原地不动：窗口还没跟上（到了容器尽头，但那不是全书尽头），或无处可滚。 */
  | { kind: "none" };

/** `planScrollTurn` 的入参。 */
export interface ScrollTurnInput {
  scrollTop: number;
  /** 容器能滚到的最大 `scrollTop`（`pageScroll.ts` 的 `maxScrollTop`）。 */
  maxScrollTop: number;
  /** `scrollTurnDelta` 的结果。 */
  delta: number;
  direction: TurnDirection;
  /**
   * 窗口在 `direction` 一端的章就是全书在这一端的正文章节：NEXT 时窗口末章是全书最后一个
   * 正文章节，PREV 时窗口首章是全书第一个。
   */
  windowAtBookEdge: boolean;
}

/**
 * 一次翻页滚动的执行方案（design §7.6 的"执行"与"到达书首或书尾"）。
 *
 * 先把当前位置夹进 `[0, max]`。该方向剩余的可滚像素不超过 `EDGE_EPSILON_PX` 即视为到边：
 * 窗口这一端已是全书这一端时为 `boundary`，否则窗口还没跟上，这一下是空操作 `none`。没到边时
 * 目标为 `clamp(scrollTop + delta, 0, max)`；`delta` 为 0（可见区退化）或方向不符时目标与当前
 * 相同，同样是 `none`。脏值（`NaN`、负数）按 0 处理。
 */
export function planScrollTurn(input: ScrollTurnInput): ScrollTurnPlan {
  const max = asPx(input.maxScrollTop);
  const from = Math.min(max, asPx(input.scrollTop));
  const room = input.direction === "next" ? max - from : from;
  if (room <= EDGE_EPSILON_PX) return input.windowAtBookEdge ? { kind: "boundary" } : { kind: "none" };

  const sign = input.direction === "next" ? 1 : -1;
  const delta = Number.isFinite(input.delta) && Math.sign(input.delta) === sign ? input.delta : 0;
  const to = Math.min(max, Math.max(0, from + delta));
  return to === from ? { kind: "none" } : { kind: "scroll", from, to };
}

// ───────────────────────────── 章节窗口 ─────────────────────────────

/** 同时挂载的章节数上限（需求 10.2）。与全书章节数无关的常数。 */
export const MAX_MOUNTED_CHAPTERS = 7;

/** 锚章之前至少挂载的高度，以视口高度为单位（design §7.2）。 */
export const OVERSCAN_ABOVE_SCREENS = 1;

/** 锚章之后至少挂载的高度，以视口高度为单位（design §7.2）。向下读是常态，所以比上方多一屏。 */
export const OVERSCAN_BELOW_SCREENS = 2;

/** 正文序号的闭区间 `[lo, hi]`。 */
export interface ChapterWindow {
  lo: number;
  hi: number;
}

/** `chapterWindow` 的入参（design §7.2）。 */
export interface ChapterWindowInput {
  /** 判定线所在章（或导航目标章）的正文序号。越界与非整数会被夹进 `[0, total)`。 */
  anchor: number;
  /** 正文章节总数，即 `contentIdx.length`。 */
  total: number;
  /** 某章区段的高度（px）：已挂载的取测量值，未挂载的按字数 × 已测像素/字估算。 */
  heightOf: (position: number) => number;
  /** 滚动容器的视口高度（px）。 */
  viewportHeight: number;
}

/**
 * 滚动视图要挂载哪几章：返回正文序号的闭区间 `[lo, hi]`（design §7.2，需求 10.2、10.7）。
 *
 * 1. 先纳入 `anchor ± 1`（存在的话），保证无论高度怎么估，向上、向下都能连续读到相邻章
 *    （需求 10.7）；
 * 2. 向下扩展，直到锚章**之后**各章的累计高度 ≥ 2 屏；再向上扩展，直到锚章**之前**各章的
 *    累计高度 ≥ 1 屏。锚章自身不计入：判定线可能落在锚章任意位置，只看锚章之外的部分，
 *    锚章再长也不会让相邻方向缺货；
 * 3. 总数达到 `MAX_MOUNTED_CHAPTERS` 即停止（需求 10.2）。向下先扩，名额紧张时优先给下方。
 *
 * 因此 `0 ≤ lo ≤ anchor ≤ hi < total`、`hi − lo + 1 ≤ 7`，且锚章两侧的相邻章恒在窗口内
 * （design Property 20）。高度只影响挂几章、不影响任何坐标，估错的代价只是多挂或少挂一章；
 * 脏高度（负数、`NaN`）按 0 计，结果是多挂几章，仍受上限约束。
 *
 * 结果是锚点与高度的确定性函数，调用方比较 `lo`/`hi` 不变时不必重渲染。`total` 不足 1 时
 * 返回空区间 `{ lo: 0, hi: -1 }`：没有正文章节，调用方走错误页（需求 12.6）。
 */
export function chapterWindow(input: ChapterWindowInput): ChapterWindow {
  const total = Number.isFinite(input.total) ? Math.trunc(input.total) : 0;
  if (total < 1) return { lo: 0, hi: -1 };

  const anchor = Number.isFinite(input.anchor)
    ? Math.min(total - 1, Math.max(0, Math.trunc(input.anchor)))
    : 0;
  const screen = asPx(input.viewportHeight);
  const heightOf = (position: number) => asPx(input.heightOf(position));

  let lo = Math.max(0, anchor - 1);
  let hi = Math.min(total - 1, anchor + 1);
  const full = () => hi - lo + 1 >= MAX_MOUNTED_CHAPTERS;

  let below = 0;
  for (let p = anchor + 1; p <= hi; p++) below += heightOf(p);
  while (hi < total - 1 && !full() && below < OVERSCAN_BELOW_SCREENS * screen) {
    hi += 1;
    below += heightOf(hi);
  }

  let above = 0;
  for (let p = lo; p < anchor; p++) above += heightOf(p);
  while (lo > 0 && !full() && above < OVERSCAN_ABOVE_SCREENS * screen) {
    lo -= 1;
    above += heightOf(lo);
  }

  return { lo, hi };
}

// ───────────────────────────── 判定线定位 ─────────────────────────────

/** 判定线落点：窗口内第几个区段，以及该区段里第几段。 */
export interface ScrollLocation {
  /** 区段下标，与 `sectionTops` 对齐（即窗口内的第几章，不是正文序号）。 */
  section: number;
  /** 该区段的段落下标，与 `paraTopsOf(section)` 对齐（`bodyParas` 的下标）。 */
  para: number;
}

/**
 * 判定线 `y = scrollTop + TOP_BIAS` 处的（区段, 段落）（design §7.4，需求 10.4、10.6）。
 *
 * - 区段：`sectionTops[s] ≤ y` 的最后一个；`y` 在首个区段之上（或为 `NaN`）时取首个；
 * - 段落：该区段内 `paraTop ≤ y` 的最后一段；没有这样的段（判定线落在标题区里、或该区段
 *   没有正文）时为 0。
 *
 * 两处都是 `upperBound(tops, y) − 1` 再夹住下界，与现有恢复路径"视口首个可见段落"的口径
 * 一致（`locator.ts` 的 `upperBound` 注释）。判定线恰好压在某段顶边上时取那一段，不是上一段。
 *
 * `sectionTops` 与每个区段的段落顶边都须升序（`offsetTop` 天然满足）。`sectionTops` 为空
 * （窗口还没挂上）时返回 `{ section: 0, para: 0 }` 且不调用 `paraTopsOf`，这是个不可用的
 * 下标，调用方须先确认窗口非空——与 `findParaIndex` 对空数组的约定相同。
 */
export function locateAt(
  sectionTops: readonly number[],
  paraTopsOf: (section: number) => readonly number[],
  y: number,
): ScrollLocation {
  if (!sectionTops.length) return { section: 0, para: 0 };

  const section = Math.max(0, upperBound(sectionTops, y) - 1);
  const para = Math.max(0, upperBound(paraTopsOf(section), y) - 1);
  return { section, para };
}

// ───────────────────────────── 几何缓存与锚点补偿 ─────────────────────────────

/**
 * 判定线相对滚动容器顶边的距离（px，design §3.3 的 `TOP_BIAS`）。取 56，即顶栏 `h-14` 的高度。
 *
 * 滚动时以 `scrollTop + TOP_BIAS` 为线（`locateAt`、`anchorAt`）；定位时反过来令
 * `scrollTop = paraTop − TOP_BIAS`（任务 16.3）。两个方向共用这一个常数，来回换算才自洽。
 * `ReaderPage` 原内联渲染里的同名常数取值相同，随内联渲染一起在任务 19.1 删除。
 */
export const TOP_BIAS = 56;

/**
 * 已挂载区段与段落的几何缓存（design §7.3）。全部是滚动容器内容坐标（`scrollTop` 的坐标系）。
 *
 * 四个数组都按窗口顺序与区段对齐：第 `s` 项属于 `<main>` 下第 `s` 个 `<section>`，不是正文序号。
 * `sectionTops` 与每个 `paraTops[s]` 都按 DOM 顺序排列，因此升序（`locateAt` 的前提）。
 */
export interface ScrollGeometry {
  /** 各区段的章号（`toc.chapters[]` 下标）。 */
  chapterIds: readonly number[];
  /** 各区段的顶边。 */
  sectionTops: readonly number[];
  /** 各区段的高度（含上下内边距与分隔线），供 `edge()` 求章末（任务 16.4）。 */
  sectionHeights: readonly number[];
  /** 各区段内每个正文段落的顶边，下标与该章 `bodyParas` 对齐。只有标题的章为空数组。 */
  paraTops: readonly (readonly number[])[];
}

/** 还没测量过（或刚换书）时的几何。 */
export const EMPTY_SCROLL_GEOMETRY: ScrollGeometry = {
  chapterIds: [],
  sectionTops: [],
  sectionHeights: [],
  paraTops: [],
};

/**
 * 判定线处的锚点（design §7.3）：哪一章的哪一段，以及它的顶边此刻在容器里的屏幕位置。
 *
 * `delta = 锚定元素顶边 − scrollTop`，即该元素顶边到滚动容器顶边的距离（可为负）。几何变化后
 * 令 `scrollTop = 新顶边 − delta`，这个元素在屏幕上就停在原处（需求 10.3）。
 */
export interface ScrollAnchor {
  chapterId: number;
  /** 段落下标（`bodyParas` 的下标）；该章没有正文段时为 −1，改以区段顶边为锚。 */
  para: number;
  delta: number;
}

/**
 * 以 `scrollTop` 处的判定线（`scrollTop + TOP_BIAS`）求锚点（design §7.3）。只读缓存，不读布局。
 *
 * 锚定的是 `locateAt` 给出的那一段：判定线压在某段上取那一段；判定线落在标题区里（该区段内还没有
 * 段顶 ≤ 判定线）时取首段，它在判定线之下，`delta` 大于 `TOP_BIAS`，标题区随它一起保持不动。
 * 区段没有正文段时以区段顶边为锚（`para = −1`）。
 *
 * 几何为空（窗口还没挂上、还没测量）或 `scrollTop` 非有限时返回 `null`。
 */
export function anchorAt(geometry: ScrollGeometry, scrollTop: number): ScrollAnchor | null {
  const { chapterIds, sectionTops, paraTops } = geometry;
  if (!sectionTops.length || !Number.isFinite(scrollTop)) return null;

  const { section, para } = locateAt(sectionTops, (s) => paraTops[s] ?? [], scrollTop + TOP_BIAS);
  const chapterId = chapterIds[section];
  if (chapterId === undefined) return null;

  const tops = paraTops[section] ?? [];
  const top = tops.length ? tops[para] : sectionTops[section];
  if (!Number.isFinite(top)) return null;
  return { chapterId, para: tops.length ? para : -1, delta: top - scrollTop };
}

/**
 * 几何变化后让锚点回到原屏幕位置所需的 `scrollTop`（design §7.3，需求 10.3）：
 * `锚定元素的新顶边 − anchor.delta`。
 *
 * 锚点所在章已不在窗口内、段落下标在该区段里不存在，或任何量非有限时返回 `null`，调用方改为
 * 以当前 `scrollTop` 重新取锚点，不做补偿。结果未夹到 `[0, maxScrollTop]`，越界由浏览器夹取。
 *
 * 与 `anchorAt` 互逆：几何不变时 `anchoredScrollTop(g, anchorAt(g, t))` 等于 `t`（至多差一次
 * 浮点加减的舍入）。
 */
export function anchoredScrollTop(geometry: ScrollGeometry, anchor: ScrollAnchor): number | null {
  const section = geometry.chapterIds.indexOf(anchor.chapterId);
  if (section < 0) return null;

  const top =
    anchor.para < 0 ? geometry.sectionTops[section] : geometry.paraTops[section]?.[anchor.para];
  if (top === undefined || !Number.isFinite(top) || !Number.isFinite(anchor.delta)) return null;
  return top - anchor.delta;
}

// ───────────────────────────── 导航定位与判定线位置 ─────────────────────────────

/** 滚动视图里的阅读位置：章号（`toc.chapters[]` 下标）与章内字符偏移。 */
export interface ScrollPosition {
  chapterId: number;
  charOffset: number;
}

/**
 * 导航指令落地时的 `scrollTop`：把 `charOffset` 所在段落置于判定线（design §3.1，需求 1.6、10.7）。
 *
 * 段落取 `findParaIndex(paras, charOffset)`：
 *
 * - 下标为 0（目标是首段、落在首段之前，如章首与被跳过的标题行；或该章没有正文段）时，区段顶边
 *   对齐容器顶边：标题区一并进入视野，屏幕位置与旧版章首 `scrollTop = 0` 相同；
 * - 否则 `scrollTop = paraTop − TOP_BIAS`，该段顶边恰好压在判定线上。
 *
 * 两种情形都是 `positionAt` 的逆：几何不变、结果也未被 `maxScrollTop` 夹取时，`positionAt` 在
 * 结果处判出的正是目标章的这一段。首段的情形里，判定线落在区段自己的 `pt-16` 上内边距里，判出
 * 本章、段落 0（design §7.1）。逆只到段落为止，段内偏移会被归到段首，这正是位置归约器要钉住的
 * 东西（`scrollPositionStep`，需求 1.7）。
 *
 * 结果夹到 ≥ 0，上界交给浏览器夹取。目标章不在几何里（尚未挂载或尚未测量）、该区段测到的段数与
 * `paras` 不符（测量没跟上段落集合），或坐标非有限时返回 `null`：调用方保留指令，等下一次测量。
 */
export function navScrollTop(
  geometry: ScrollGeometry,
  chapterId: number,
  paras: readonly Para[],
  charOffset: number,
): number | null {
  const section = geometry.chapterIds.indexOf(chapterId);
  if (section < 0) return null;
  const tops = geometry.paraTops[section];
  if (!tops || tops.length !== paras.length) return null;

  // 非有限的偏移在 `findParaIndex` 里落到首段，即章首
  const index = paras.length ? findParaIndex(paras, charOffset) : 0;
  const top = index === 0 ? geometry.sectionTops[section] : tops[index] - TOP_BIAS;
  return Number.isFinite(top) ? Math.max(0, top) : null;
}

/**
 * `scrollTop` 处判定线（`scrollTop + TOP_BIAS`）的阅读位置（design §3.2、§7.4，需求 10.6）：
 * `locateAt` 给出的区段所属章，以及那一段的章内偏移。只读缓存，供滚动 rAF 每帧调用。
 *
 * 判定线落在标题区里时 `locateAt` 取首段，偏移即首段偏移（`navScrollTop` 把它放回章首）。
 * 该章没有正文段（只有标题）、或 `parasOf` 拿不到该章的段落时，偏移为 0，即章首。`parasOf`
 * 须给出与几何同一次提交的段落（`bodyParas`），下标才对得上 `paraTops`。
 *
 * 几何为空（窗口还没挂上、还没测量）或 `scrollTop` 非有限时返回 `null`。
 */
export function positionAt(
  geometry: ScrollGeometry,
  parasOf: (chapterId: number) => readonly Para[] | undefined,
  scrollTop: number,
): ScrollPosition | null {
  const { chapterIds, sectionTops, paraTops } = geometry;
  if (!sectionTops.length || !Number.isFinite(scrollTop)) return null;

  const { section, para } = locateAt(sectionTops, (s) => paraTops[s] ?? [], scrollTop + TOP_BIAS);
  const chapterId = chapterIds[section];
  if (chapterId === undefined) return null;
  return { chapterId, charOffset: parasOf(chapterId)?.[para]?.offset ?? 0 };
}

// ───────────────────────────── 位置上报 ─────────────────────────────

/**
 * 滚动位置归约器的输入（design §3.3）。
 *
 * - `pin`：导航指令落地（打开恢复、目录、滑杆、`?ch=`、检索、书签、`←`/`→`，以及切换模式），
 *   视图已把目标段落置于判定线；
 * - `user-input`：`wheel`、`pointerdown`（含拖动滚动条）、`touchstart`，以及阅读器处理的滚动键；
 * - `derived`：滚动 rAF 由判定线算出的位置（`locateAt` 的结果换算成章内偏移）。
 */
export type ScrollPosEvent =
  | { kind: "pin" }
  | { kind: "user-input" }
  | { kind: "derived"; chapterId: number; charOffset: number };

export interface ScrollPosState {
  /** 为真时不上报 `derived`：当前滚动位置来自程序化定位，读者还没有真正操作过。 */
  pinned: boolean;
}

/**
 * 滚动视图的位置上报判定（design §3.3，需求 1.7、10.6）。
 *
 * `pin` 置 `pinned = true`；`user-input` 置 `pinned = false`；`derived` 不改状态，只在未钉住时
 * 给出 `report = true`，由调用方上报 `(chapterId, charOffset)`。`pin` 与 `user-input` 自身从不上报。
 *
 * 这样导航定位、窗口挂卸补偿、重排补偿产生的 `scroll` 事件，在读者第一次真正操作之前都不会改动
 * 阅读位置，"切到滚动模式再切回"能原样带回进入时的偏移（需求 1.7）；读者一旦滚动，位置就严格
 * 等于判定线处段落的偏移（需求 10.6）。
 *
 * 状态不变时返回同一个对象，调用方可据此跳过写入。
 */
export function scrollPositionStep(
  state: ScrollPosState,
  event: ScrollPosEvent,
): { state: ScrollPosState; report: boolean } {
  switch (event.kind) {
    case "pin":
      return { state: state.pinned ? state : { pinned: true }, report: false };
    case "user-input":
      return { state: state.pinned ? { pinned: false } : state, report: false };
    case "derived":
      return { state, report: !state.pinned };
  }
}

// ───────────────────────────── 拖拽惯性 ─────────────────────────────

/** 惯性衰减的时间常数 τ（ms）：速度每过 τ 衰减到 1/e（design §7.5）。 */
export const FLING_TAU_MS = 325;

/** 惯性停止的速度阈值（px/s）：速度绝对值低于它即视为停止（design §7.5）。 */
export const FLING_MIN_SPEED = 20;

/** 估计释放速度时回看的时间窗（ms）（design §7.5）。 */
export const VELOCITY_WINDOW_MS = 100;

/** 拖拽过程中的一个采样：纵坐标（px）与时刻（ms，与 `now` 同一时钟）。 */
export interface MotionSample {
  y: number;
  t: number;
}

/**
 * 释放时的速度（px/s，与 `y` 同向）：时间窗 `[now − 100, now]` 内最早与最晚两个采样之间的
 * 平均速度（design §7.5，需求 10.9）。对匀速样本恰好返回该速度。
 *
 * 窗内不足两个采样（指针在释放前已停住超过 100ms，或拖拽极短）、或两点时刻相同时返回 0，即
 * 不产生惯性。采样不要求按时间排序，坐标或时刻非有限的采样直接忽略；`now` 非有限时返回 0。
 *
 * 调用方宜把释放那一刻的指针位置也作为一个采样传入：指针停住时不再产生 `pointermove`，没有这一点
 * 就看不到"停了一会儿才松手"。`y` 取指针纵坐标时，正文的滚动方向与之相反
 * （`scrollTop = startScrollTop + (start.y − p.y)`，§7.5），交给 `flingAt` 前取负。
 */
export function estimateVelocity(samples: readonly MotionSample[], now: number): number {
  if (!Number.isFinite(now)) return 0;
  const since = now - VELOCITY_WINDOW_MS;

  let first: MotionSample | null = null;
  let last: MotionSample | null = null;
  for (const sample of samples) {
    const { y, t } = sample;
    if (!Number.isFinite(y) || !Number.isFinite(t) || t < since || t > now) continue;
    if (first === null || t < first.t) first = sample;
    if (last === null || t >= last.t) last = sample;
  }

  if (first === null || last === null || first === last) return 0;
  const dt = last.t - first.t;
  return dt > 0 ? ((last.y - first.y) / dt) * 1000 : 0;
}

/**
 * 惯性滚动在释放后 `t` ms 的状态（design §7.5，需求 10.9）。`v0` 为释放速度（px/s），
 * 返回的 `offset` 是相对释放点的累计位移（px，与 `v0` 同向），`velocity` 为此刻速度（px/s）。
 *
 * 指数衰减模型，记 `τ = FLING_TAU_MS`：
 *
 * - `v(t) = v0·e^(−t/τ)`；
 * - `offset(t) = v0·τ·(1 − e^(−t/τ))`，即 `v(t)` 的积分。`v0` 以 px/s、`τ` 以 ms 计，这里按
 *   `τ / 1000` 换成秒再乘；
 * - `|v(t)| < FLING_MIN_SPEED` 时 `done = true`，此后 `velocity = 0`，`offset` 停在速度降到阈值
 *   那一刻的值 `sign(v0)·τ·(|v0| − FLING_MIN_SPEED)`，不再随 `t` 缓慢爬升。
 *
 * 由此：`|velocity|` 随 `t` 单调不增；`offset` 与 `v0` 同号（或为 0），`|offset|` 随 `t` 单调不减且
 * 严格小于 `|v0|·τ`；`t = τ·ln(|v0| / FLING_MIN_SPEED)` 之后必定 `done`（design Property 22）。
 * 停止点按阈值钉住，也避免了 `t` 很大时 `1 − e^(−t/τ)` 舍入成 1、位移恰好等于上界。
 *
 * `|v0| < FLING_MIN_SPEED`（含 `v0 = 0`）时一开始就 `done`，位移恒为 0。`v0` 非有限按 0 处理，
 * `t` 为负或非有限按 0 处理。是否已滚到内容两端由调用方判断，到端即停。
 */
export function flingAt(
  v0: number,
  t: number,
): { offset: number; velocity: number; done: boolean } {
  const initial = Number.isFinite(v0) ? v0 : 0;
  const elapsed = Number.isFinite(t) ? Math.max(0, t) : 0;
  const speed0 = Math.abs(initial);

  const decay = Math.exp(-elapsed / FLING_TAU_MS);
  const done = speed0 * decay < FLING_MIN_SPEED;
  // 停止时的衰减因子：速度恰为阈值处，`|v0|` 不足阈值时为 1（不动）。`v0 = 0` 时 20/0 = Infinity，同样取 1。
  const stopDecay = Math.min(1, FLING_MIN_SPEED / speed0);
  // 取较大者：未停时 decay ≥ stopDecay（至多差一个舍入），已停时钉在 stopDecay。两种情况下都随 t 单调不增。
  const effective = Math.max(decay, stopDecay);
  const offset = initial * (FLING_TAU_MS / 1000) * (1 - effective);

  return {
    // 负的 v0 不动时乘出来是 −0，归一成 0
    offset: offset === 0 ? 0 : offset,
    velocity: done ? 0 : initial * decay,
    done,
  };
}
