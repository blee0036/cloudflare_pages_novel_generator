/**
 * 翻页运动学（design §2.3、§6.2、§6.3、§6.5）。
 *
 * 纯函数模块：Turn_Duration、释放终点、动画段插值、落定判定、Tap 与按键的起点，以及覆盖/滑动布局。
 * 不碰 DOM、不读 React，入参是视口尺寸与触点，出参是坐标、页位置或图层布局。
 *
 * 坐标约定与 Legado `PageDelegate` 相同：`w`、`h` 是 Reader_Viewport 的宽高，
 * 原点在左上角，x 向右、y 向下。
 */

import type { TurnDirection, TurnSource } from "../components/reader/types";
import { PAGE_ANIM, type PageAnim } from "./pageAnim";
import type { PagePos } from "./paginate";

/**
 * 视口坐标系中的一个点，单位 CSS px，原点在 `<main>` 左上角。
 *
 * 触点、起点、仿真卷起角都用它表示（需求 4.2 的水平位移即 `touch.x − start.x`）。
 */
export interface Pt {
  x: number;
  y: number;
}

/**
 * 一次分页翻页的完整状态（design §2.3）。
 *
 * 由翻页器在翻页开始时创建（拖拽越阈、Tap、按键、滚轮），拖拽期间经 `dragStep` 更新触点，
 * 释放后补上 `run`。逐帧样式只由这里的数值算出，不经过 React（G4）。
 */
export interface TurnState {
  /** 本次翻页实际使用的动画，即 `effectiveTurnAnim` 的结果；翻页途中不变（需求 9.7）。 */
  anim: PageAnim;
  direction: TurnDirection;
  source: TurnSource;
  /** Legado 的 `startX/startY`：方向确定或反转时重置为当时的焦点。 */
  start: Pt;
  /** 当前触点；动画期间由 `run` 线性插值得出。 */
  touch: Pt;
  /** 上一个触点，用于取消判定（需求 4.7、4.8）。 */
  last: Pt;
  /** 释放时是否撤销本次翻页。 */
  cancel: boolean;
  /** 仿真的卷起角；其他模式为 `null`。 */
  corner: Pt | null;
  /** 翻页前的页。 */
  from: PagePos;
  /** 翻页完成后的页。 */
  to: PagePos;
  /** 释放后的动画段；`null` 表示仍在拖拽。 */
  run: { from: Pt; to: Pt; t0: number; duration: number } | null;
}

// ───────────────────────────── 时长 ─────────────────────────────

/**
 * Turn_Duration 的基准时长（ms）。
 *
 * `gesture` 用于 Tap 与拖拽释放（Legado `defaultAnimationSpeed` 的 300），
 * `key` 用于按键与滚轮（Legado `keyTurnPage` 的 100）。需求 4.7、4.8、5.6、11.4。
 */
export const TURN_BASE_MS = { gesture: 300, key: 100 } as const;

/** 触发来源对应的基准时长：tap 与 drag 用 `gesture`，key 与 wheel 用 `key`。 */
export function turnBaseMs(source: TurnSource): number {
  return source === "key" || source === "wheel" ? TURN_BASE_MS.key : TURN_BASE_MS.gesture;
}

/**
 * Turn_Duration（术语表；Legado `PageDelegate.startScroll`）。
 *
 * `dx ≠ 0` 时为 `base·|dx|/w`，否则为 `base·|dy|/h`；`dx = dy = 0` 时为 0，表示没有动画段，
 * 翻页器应当场落定。剩余位移恰为一屏宽（`|dx| = w`）时恰好等于 `base`。
 *
 * 与 Legado 的差别只在精度：Legado 用整数除法，这里保留小数，rAF 按毫秒插值不需要取整。
 * 滚动模式的翻页滚动传 `dx = 0`、`dy = 滚动距离`、`h = Visible_Area 高度`（需求 10.12）。
 */
export function turnDuration(base: number, dx: number, dy: number, w: number, h: number): number {
  if (dx !== 0) return (base * Math.abs(dx)) / w;
  return (base * Math.abs(dy)) / h;
}

// ───────────────────────────── 释放 ─────────────────────────────

/**
 * 覆盖与滑动的释放终点横坐标（`CoverPageDelegate` / `SlidePageDelegate` 的 `onAnimStart`，两者相同）。
 *
 * Legado 算的是位移 `distanceX`，起点为 `touchX`，这里直接返回 `touchX + distanceX`：
 * - NEXT 完成：`start.x − w`，移动页左移整整一屏（偏移 −w）；
 * - NEXT 取消：`touch.x + w − min(w, w − start.x + touch.x)`，触点在起点左侧时回到 `start.x`（偏移 0），
 *   在右侧时（方向与偏移矛盾，布局视为静止）原地不动；
 * - PREV 完成：`start.x + w`（偏移 +w）；
 * - PREV 取消：`start.x`（偏移 0）。
 */
function horizontalReleaseX(direction: TurnDirection, cancel: boolean, startX: number, touchX: number, w: number): number {
  if (direction === "next") {
    if (cancel) return touchX + w - Math.min(w, w - startX + touchX);
    return startX - w;
  }
  return cancel ? startX : startX + w;
}

/**
 * 仿真的释放终点（`SimulationPageDelegate.onAnimStart`）。
 *
 * - NEXT 完成：`(−w, 下角 ? h : 1)`，卷起角移出视口左侧（需求 8.9）；上角时终点取 1 而不是 0，
 *   沿用 Legado "防止 mTouchY 最终变为 0" 的处理。
 * - NEXT 取消：`(w, 下角 ? h : 0)`，即回到卷起角（需求 8.10）。
 * - PREV 完成：`(w, h)`，上一页完全展开、触点回到右下角（需求 8.9）。
 * - PREV 取消：`(−w, h)`，上一页重新卷起并移出视口左侧（需求 8.10）。
 *
 * PREV 的卷起角恒为右下角（需求 8.3），终点纵坐标直接取 `h`。`corner` 缺失时按右下角处理，
 * 与按键起点的默认卷起角一致。
 */
function simulationRelease(direction: TurnDirection, cancel: boolean, corner: Pt | null, w: number, h: number): Pt {
  if (direction === "next") {
    const bottom = (corner?.y ?? h) > 0;
    return cancel ? { x: w, y: bottom ? h : 0 } : { x: -w, y: bottom ? h : 1 };
  }
  return cancel ? { x: -w, y: h } : { x: w, y: h };
}

/**
 * 释放后的动画终点（需求 4.7、4.8、8.9、8.10、9.1、9.2；design §6.2 的表）。
 *
 * 动画段从 `touch` 线性插值到返回值，时长为 `turnDuration(base, to.x − touch.x, to.y − touch.y, w, h)`。
 *
 * - 覆盖、滑动：只改横坐标，纵坐标保持 `touch.y`，使 `dy = 0`，时长只由水平位移决定。
 * - 仿真：见 `simulationRelease`。
 * - 无动画（以及不走分页翻页器的滚动）：返回 `touch` 的副本。位移为 0，`turnDuration` 为 0，
 *   不产生动画段，翻页器按 `cancel` 当场提交或还原（需求 9.1、9.2）。
 */
export function releaseTarget(
  anim: PageAnim,
  direction: TurnDirection,
  cancel: boolean,
  start: Pt,
  touch: Pt,
  corner: Pt | null,
  w: number,
  h: number,
): Pt {
  switch (anim) {
    case PAGE_ANIM.cover:
    case PAGE_ANIM.slide:
      return { x: horizontalReleaseX(direction, cancel, start.x, touch.x, w), y: touch.y };
    case PAGE_ANIM.simulation:
      return simulationRelease(direction, cancel, corner, w, h);
    default:
      return { x: touch.x, y: touch.y };
  }
}

// ───────────────────────────── 插值 ─────────────────────────────

/** 释放后的一段动画（`TurnState.run` 的非空值）。 */
export type TurnRun = NonNullable<TurnState["run"]>;

/**
 * 动画段在时刻 `t` 的触点（design §6.2；Legado `Scroller(LinearInterpolator).computeScrollOffset`）。
 *
 * `touch(t) = from + (to − from) · p`，`p = (t − t0) / duration` 夹到 `[0, 1]`：
 * - `t < t0` 时 `p = 0`。rAF 回调的时间戳是该帧的起始时刻，可能早于释放时读的 `performance.now()`，
 *   夹住后第一帧停在起点，而不是往反方向外推。
 * - `t ≥ t0 + duration` 时 `done = true`，触点恰为 `to`（不经乘法，避免浮点误差让末帧差一点到位）。
 *   与 Legado 相同：`timePassed < duration` 时插值，否则直接取终点并结束。
 * - `duration` 不是正的有限数时直接到终点并结束（翻页器本不会为这种段启动动画，这里只为不产生 NaN）。
 *
 * 返回新对象，不与 `run.from` / `run.to` 共享引用。
 */
export function runTouch(run: TurnRun, t: number): { touch: Pt; done: boolean } {
  const { from, to, t0, duration } = run;
  if (!(duration > 0) || !Number.isFinite(duration) || t - t0 >= duration) {
    return { touch: { x: to.x, y: to.y }, done: true };
  }
  const p = Math.max(0, (t - t0) / duration);
  return { touch: { x: from.x + (to.x - from.x) * p, y: from.y + (to.y - from.y) * p }, done: false };
}

// ───────────────────────────── 落定 ─────────────────────────────

/**
 * 翻页落定到哪一页（需求 2.6、4.9）。
 *
 * 未取消落到 `to`，已取消回到 `from`，与拖拽或动画进行到哪一步无关。用于动画正常结束、
 * 按下打断动画（Legado `abortAnim`）、动画中视口尺寸变化、切模式与卸载前的 `settle()`。
 */
export function settleTarget(turn: Pick<TurnState, "cancel" | "from" | "to">): PagePos {
  return turn.cancel ? turn.from : turn.to;
}

// ───────────────────────────── 起点 ─────────────────────────────

/**
 * Tap 翻页的起点，同时也是初始触点（`start = touch`，design §6.3）。
 *
 * 对应 `HorizontalPageDelegate.nextPageByAnim` / `prevPageByAnim` 的 `setStartPoint`：
 * - NEXT：`(0.9w, tapY > h/2 ? 0.9h : 1)`。纵坐标与 `simCorner(next, tapY)` 选出的上下角
 *   在同一侧（需求 8.7）：下半区靠近右下角，上半区贴着上边（取 1 而不是 0，同 Legado）。
 *   `h ≥ 2` 时 `1 ≤ h/2`，所以用这个起点的纵坐标再去选角，结果也不变。
 * - PREV：`(0, h)`，仿真恒以右下角为卷起角（需求 8.3）。
 *
 * 覆盖、滑动只看横坐标：NEXT 完成的位移恰为 −w、PREV 恰为 +w，时长恰为基准时长（需求 5.6）。
 */
export function tapStart(direction: TurnDirection, tapY: number, w: number, h: number): Pt {
  if (direction === "prev") return { x: 0, y: h };
  return { x: 0.9 * w, y: tapY > h / 2 ? 0.9 * h : 1 };
}

/**
 * 按键与滚轮翻页的起点，同时也是初始触点（`keyTurnPage`，design §6.3）。
 *
 * Legado 的按键翻页沿用上一次触摸的纵坐标选角；本设计固定 `y = h`（design §0 偏离表），
 * 卷起角恒为右下角（需求 8.8）：
 * - NEXT：`(0.9w, h)`；
 * - PREV：`(0, h)`，与 Tap 相同。
 *
 * 横坐标与 Tap 相同，覆盖、滑动的时长恰为按键基准时长（需求 11.4）。
 */
export function keyStart(direction: TurnDirection, w: number, h: number): Pt {
  if (direction === "prev") return { x: 0, y: h };
  return { x: 0.9 * w, y: h };
}

// ───────────────────────────── 布局 ─────────────────────────────

/** 翻页图层栈里的一页：上一页、当前页、下一页（design §6.5）。 */
export type Layer = "prev" | "cur" | "next";

/** 覆盖模式阴影的宽度（CSS px），即 Legado `shadowDrawableR.setBounds(0, 0, 30, viewHeight)`（需求 6.3）。 */
export const COVER_SHADOW_PX = 30;

/**
 * 覆盖模式一帧的图层布局（design §6.5）。
 *
 * `under` 静止铺满视口，`moving` 叠在其上、平移到 `movingX`；阴影是宽 `COVER_SHADOW_PX` 的
 * `linear-gradient(to right, var(--turn-shadow), transparent)`，左缘贴着移动页右缘外侧。
 */
export interface CoverLayout {
  /** 静止层：NEXT 为 next，PREV 为 cur。 */
  under: Layer;
  /** 移动层：NEXT 为 cur，PREV 为 prev。 */
  moving: Layer;
  /** 移动层的 `translateX`（CSS px）。 */
  movingX: number;
  /** 阴影的左缘（CSS px）；`null` 表示不画阴影。 */
  shadowX: number | null;
}

/** 滑动模式一帧的图层布局：两层同步平移，间距恒为 `w`，没有阴影（需求 7.1、7.2）。 */
export interface SlideLayout {
  /** 按从左到右的顺序列出，`x` 是各层的 `translateX`（CSS px）。 */
  layers: { layer: Layer; x: number }[];
}

/**
 * 方向与偏移符号是否矛盾：NEXT 时向右拖（`offset > 0`）、PREV 时向左拖（`offset < 0`）。
 *
 * 对应两个委托 `onDraw` 开头的提前返回。矛盾时不画图层栈，静止显示当前页；
 * NEXT 取消且触点停在起点右侧时，释放终点原地不动（`releaseTarget`），整段动画都保持这个状态。
 */
function contradicts(direction: TurnDirection, offset: number): boolean {
  return direction === "next" ? offset > 0 : offset < 0;
}

/**
 * 覆盖布局（`CoverPageDelegate.onDraw`，需求 4.4、6.1、6.2、6.3）。
 *
 * `offset = touch.x − start.x`，`w` 为视口宽度。
 * - NEXT（`offset ∈ [−w, 0]`）：next 静止在下，cur 平移到 `offset`，阴影左缘在 `offset + w`，
 *   即当前页右缘外侧（需求 6.1）。
 * - PREV（`offset ∈ [0, w]`）：cur 静止在下，prev 平移到 `offset − w`，阴影左缘在 `offset`，
 *   即上一页右缘外侧（需求 6.2）。
 * - `offset = 0` 时不画阴影（需求 6.3）。PREV 此时阴影左缘会落在 0，正好叠在当前页左缘上，
 *   必须去掉；NEXT 此时阴影在 `w`，本就在视口外。
 * - 方向与偏移符号矛盾时返回 `null`。
 *
 * Legado 在 PREV `offset = 0` 时把上一页画在 `+w`、在 `offset > w` 时钳到 0；这里统一按
 * `offset − w` 放置，`offset = 0` 时上一页在 `−w`，同样完全在视口外。偏移不做钳制，
 * 超出 `[−w, w]` 时按同一公式外推。
 */
export function coverLayout(direction: TurnDirection, offset: number, w: number): CoverLayout | null {
  if (contradicts(direction, offset)) return null;
  // `-0 === 0` 成立，NEXT 刚越阈时的 −0 偏移同样不画阴影
  const noShadow = offset === 0;
  if (direction === "next") {
    return { under: "next", moving: "cur", movingX: offset, shadowX: noShadow ? null : offset + w };
  }
  return { under: "cur", moving: "prev", movingX: offset - w, shadowX: noShadow ? null : offset };
}

/**
 * 滑动布局（`SlidePageDelegate.onDraw`，需求 4.4、7.1、7.2）。
 *
 * 当前页恒在 `offset`，目标页与之相差恰好 `w`：
 * - NEXT：cur 在 `offset`，next 在 `offset + w`（右侧）；
 * - PREV：prev 在 `offset − w`（左侧），cur 在 `offset`。
 *
 * 两层互不重叠，绘制顺序无关紧要。方向与偏移符号矛盾时返回 `null`。
 */
export function slideLayout(direction: TurnDirection, offset: number, w: number): SlideLayout | null {
  if (contradicts(direction, offset)) return null;
  if (direction === "next") {
    return {
      layers: [
        { layer: "cur", x: offset },
        { layer: "next", x: offset + w },
      ],
    };
  }
  return {
    layers: [
      { layer: "prev", x: offset - w },
      { layer: "cur", x: offset },
    ],
  };
}
