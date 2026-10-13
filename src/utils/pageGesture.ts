/**
 * 指针手势分类与拖拽方向归约（design §5.2、§6.1；需求 4.1–4.3、4.5–4.8、4.10）。
 *
 * 纯函数模块，不碰 DOM、不管定时器：
 * - `gestureStep` 把一串指针事件分成 Tap / Long_Press / Drag，状态转移照搬 Legado
 *   `ReadView.onTouchEvent`。600ms 长按定时器由调用方（`useReaderGesture`）在进入
 *   `"pressed"` 时启动、离开时撤销，到期后以 `timer` 事件喂回来。
 * - `dragStep` 逐行对应 Legado `HorizontalPageDelegate.onScroll`：起步判向、起步无页时静止、
 *   越过起点反转、反向无页时冻结、取消判定。
 * - `focalPoint` 是多指针的焦点（需求 4.6）。
 * - `resolveTap` 把一次 Tap 的上下文归约成决策（design §5.5，需求 5.4、5.8–5.11）。
 *
 * 与 Legado 的偏离：Touch_Slop 取 8 CSS px 的欧氏距离（design §0），Legado 用系统
 * `scaledTouchSlop` 且把位移截成整数后再平方比较。
 */

import type { TurnDirection } from "../components/reader/types";
import type { RenderFamily } from "./pageAnim";
import { tapAction, type TapZone } from "./tapZone";
import type { Pt } from "./turnMotion";

/** Touch_Slop：指针相对按下点的直线距离超过该值才算"已移动"，恰好等于不算（需求 4.1）。 */
export const TOUCH_SLOP_PX = 8;

/** Long_Press 的按住时长：按下后满 600ms 且未移动即为长按（Legado `longPressTimeout`）。 */
export const LONG_PRESS_MS = 600;

/** `to` 相对 `from` 的欧氏距离是否超过 Touch_Slop。`gestureStep` 与 `dragStep` 共用这一条判定。 */
export function beyondTouchSlop(from: Pt, to: Pt): boolean {
  return Math.hypot(to.x - from.x, to.y - from.y) > TOUCH_SLOP_PX;
}

/**
 * 多指针焦点：全部按下指针坐标的算术平均（需求 4.6，Legado `onScroll` 的 `sumX / div`）。
 *
 * 抬起事件计算时由调用方先排除抬起的那一个。调用方保证点集非空；空集按 0/0 得到 NaN 坐标。
 */
export function focalPoint(points: readonly Pt[]): Pt {
  let sumX = 0;
  let sumY = 0;
  for (const p of points) {
    sumX += p.x;
    sumY += p.y;
  }
  return { x: sumX / points.length, y: sumY / points.length };
}

// ---------------------------------------------------------------------------
// 手势分类（design §5.2）
// ---------------------------------------------------------------------------

/** 输入事件。`id` 是 `PointerEvent.pointerId`，`t` 与 `timer` 的 `t` 用同一时钟（ms）。 */
export type GestureEvent =
  | { kind: "down"; id: number; p: Pt; t: number }
  | { kind: "move"; id: number; p: Pt; t: number }
  | { kind: "up"; id: number; t: number }
  | { kind: "cancel"; id: number }
  | { kind: "timer"; t: number }; // 长按定时器到期

/** 输出动作。`none` 表示本事件不需要调用方做任何事。 */
export type GestureOutput =
  | { kind: "drag-start"; focus: Pt }
  | { kind: "drag-move"; focus: Pt }
  | { kind: "drag-end" }
  | { kind: "long-press"; at: Pt }
  | { kind: "select-extend"; to: Pt }
  | { kind: "tap"; at: Pt }
  | { kind: "none" };

/**
 * 手势所处阶段。
 *
 * - `idle`：没有指针按下。
 * - `pressed`：已按下，尚未越过 Touch_Slop，也未满 600ms（调用方此时持有长按定时器）。
 * - `drag`：越过 Touch_Slop（需求 4.1），之后的移动都是拖拽。
 * - `long-press`：满 600ms 仍未移动（需求 4.10），之后的移动只扩展选区。
 */
export type GesturePhase = "idle" | "pressed" | "drag" | "long-press";

/** 一个按下中的指针及其最新坐标。 */
export interface GesturePointer {
  id: number;
  p: Pt;
}

export interface GestureState {
  phase: GesturePhase;
  /** 按下点：首个指针按下时的坐标。Touch_Slop、Tap 落点与长按选区起点都以它为准。 */
  start: Pt;
  /** 首个指针按下的时刻（ms），`timer` 以它判定是否已满 600ms。 */
  downAt: number;
  /** 按下中的指针，按按下先后排列；`[0]` 是主指针（Legado `event.x` 取的那一个）。 */
  pointers: readonly GesturePointer[];
}

/** 没有指针按下时的状态，也是每个手势的初始状态。 */
export const GESTURE_IDLE: GestureState = {
  phase: "idle",
  start: { x: 0, y: 0 },
  downAt: 0,
  pointers: [],
};

const NONE: GestureOutput = { kind: "none" };

/**
 * 手势分类的一步：吃进一个事件，给出新状态与本步输出（design §5.2 的 5 步）。
 *
 * 1. `down`：首个指针记下起点与时刻，进入 `pressed`；后续指针只加入焦点计算。
 * 2. `move`：`pressed` 下焦点到起点的距离超过 Touch_Slop 时进入 `drag`，输出 `drag-start`；
 *    `drag` 下每次输出 `drag-move`；`long-press` 下只输出 `select-extend`（主指针位置）。
 * 3. `timer`：`pressed` 且距按下已满 600ms 时进入 `long-press`，输出 `long-press`（按下点）。
 *    不足 600ms 的 `timer` 不起作用，`drag` 之后到达的 `timer` 也不起作用。
 * 4. `up`：最后一个指针抬起时结束手势。`pressed` 输出 `tap`（按下点），`drag` 输出 `drag-end`，
 *    `long-press` 输出 `none`。还有指针按着时手势继续，焦点改由其余指针计算。
 * 5. `cancel`：浏览器接管（如触摸原生滚动）时发出。整个手势立即结束：`drag` 按拖拽结束处理
 *    输出 `drag-end`，其余阶段输出 `none`，绝不产生 Tap。
 *
 * 不属于本手势的指针（`idle` 下的悬停 `move`、未登记 `id` 的 `up`/`cancel`）原样忽略。
 */
export function gestureStep(state: GestureState, event: GestureEvent): { state: GestureState; out: GestureOutput } {
  switch (event.kind) {
    case "down": {
      if (state.phase === "idle") {
        return {
          state: { phase: "pressed", start: event.p, downAt: event.t, pointers: [{ id: event.id, p: event.p }] },
          out: NONE,
        };
      }
      // 多指：只把新指针加入焦点计算，阶段、起点与长按计时都不变（Legado 的 ACTION_POINTER_DOWN 不重置这些）。
      return { state: { ...state, pointers: upsertPointer(state.pointers, event.id, event.p) }, out: NONE };
    }

    case "move": {
      if (!hasPointer(state, event.id)) return { state, out: NONE };
      // 登记过的指针只存在于 pressed / drag / long-press 三个阶段。
      const pointers = upsertPointer(state.pointers, event.id, event.p);
      const next: GestureState = { ...state, pointers };
      if (state.phase === "long-press") {
        return { state: next, out: { kind: "select-extend", to: pointers[0].p } };
      }
      const focus = focalPoint(pointers.map((ptr) => ptr.p));
      if (state.phase === "drag") return { state: next, out: { kind: "drag-move", focus } };
      if (!beyondTouchSlop(state.start, focus)) return { state: next, out: NONE };
      return { state: { ...next, phase: "drag" }, out: { kind: "drag-start", focus } };
    }

    case "timer": {
      if (state.phase !== "pressed" || event.t - state.downAt < LONG_PRESS_MS) return { state, out: NONE };
      return { state: { ...state, phase: "long-press" }, out: { kind: "long-press", at: state.start } };
    }

    case "up": {
      if (!hasPointer(state, event.id)) return { state, out: NONE };
      const pointers = state.pointers.filter((ptr) => ptr.id !== event.id);
      if (pointers.length > 0) return { state: { ...state, pointers }, out: NONE };
      // 最后一个指针抬起。`pressed` 下按住必然不足 600ms，否则 `timer` 已把它转成长按。
      const out: GestureOutput =
        state.phase === "pressed"
          ? { kind: "tap", at: state.start }
          : state.phase === "drag"
            ? { kind: "drag-end" }
            : NONE;
      return { state: GESTURE_IDLE, out };
    }

    case "cancel": {
      if (!hasPointer(state, event.id)) return { state, out: NONE };
      return { state: GESTURE_IDLE, out: state.phase === "drag" ? { kind: "drag-end" } : NONE };
    }
  }
}

function hasPointer(state: GestureState, id: number): boolean {
  return state.pointers.some((ptr) => ptr.id === id);
}

/** 更新已登记指针的坐标（保持先后次序），未登记的追加到末尾。 */
function upsertPointer(pointers: readonly GesturePointer[], id: number, p: Pt): readonly GesturePointer[] {
  if (!pointers.some((ptr) => ptr.id === id)) return [...pointers, { id, p }];
  return pointers.map((ptr) => (ptr.id === id ? { id, p } : ptr));
}

// ---------------------------------------------------------------------------
// 拖拽方向归约（design §6.1）
// ---------------------------------------------------------------------------

/**
 * 一次拖拽的方向与触点，字段对应 Legado `PageDelegate` / `ReadView` 的同名量。
 *
 * `start`、`touch`、`last` 即 `startX/Y`、`touchX/Y`、`lastX/Y`：`touch` 是当前触点，
 * `last` 是它之前的那个触点，`cancel` 拿本次焦点与 `last` 比较（照 `onScroll` 的取值时机）。
 */
export interface DragState {
  /** 已越过 Touch_Slop（Legado `isMoved`）。 */
  moved: boolean;
  /** 起步方向无页：本次拖拽全程静止（需求 4.3）。 */
  blocked: boolean;
  /** 起步前与 `blocked` 时为 null。 */
  direction: TurnDirection | null;
  start: Pt;
  touch: Pt;
  last: Pt;
  /** 释放时是否取消翻页（需求 4.7、4.8）。 */
  cancel: boolean;
}

/** 按下时的拖拽状态：`start`、`touch`、`last` 都是按下点（Legado `setStartPoint`）。 */
export function initialDragState(start: Pt): DragState {
  return { moved: false, blocked: false, direction: null, start, touch: start, last: start, cancel: false };
}

/**
 * 拖拽的一步：吃进本次焦点，给出新状态与需要显示的边界提示（Legado `HorizontalPageDelegate.onScroll`）。
 *
 * - **起步**：焦点首次越过 Touch_Slop 时，`focus.x − start.x > 0` 为 prev，否则为 next（需求 4.2，
 *   恰为 0 也是 next）。该方向没有页时 `blocked = true` 并提示，此后一切移动都忽略（需求 4.3）；
 *   有页时 `start = touch = last = focus`。
 * - **反转**：next 下 `focus.x − start.x > 0`，或 prev 下 `< 0`，切换方向并令
 *   `start = touch = last = focus`（需求 4.5）。反方向没有页时提示、保持原方向，
 *   且本步不更新触点与 `cancel`（design §0 的冻结规则，Legado `noNext = true; return`）。
 * - **跟随**：`cancel = next ? focus.x > last.x : focus.x < last.x`，水平分量为 0 不算取消
 *   （需求 4.7、4.8）；然后 `last = touch`、`touch = focus`。
 *
 * `hasPage` 只在起步与反转时调用。`notice` 为需要提示的方向，没有则为 null；冻结期间每一步都会
 * 再次给出，去重交给边界提示归约器。
 */
export function dragStep(
  state: DragState,
  focus: Pt,
  hasPage: (direction: TurnDirection) => boolean,
): { state: DragState; notice: TurnDirection | null } {
  if (state.blocked) return { state, notice: null };

  let s = state;
  if (!s.moved) {
    if (!beyondTouchSlop(s.start, focus)) return { state, notice: null };
    const direction: TurnDirection = focus.x - s.start.x > 0 ? "prev" : "next";
    if (!hasPage(direction)) {
      return { state: { ...s, moved: true, blocked: true }, notice: direction };
    }
    s = { ...s, moved: true, direction, start: focus, touch: focus, last: focus };
  }

  const delta = focus.x - s.start.x;
  const reverse: TurnDirection | null =
    s.direction === "next" && delta > 0 ? "prev" : s.direction === "prev" && delta < 0 ? "next" : null;
  if (reverse !== null) {
    if (!hasPage(reverse)) return { state: s, notice: reverse };
    s = { ...s, direction: reverse, start: focus, touch: focus, last: focus };
  }

  const cancel = s.direction === "next" ? focus.x > s.last.x : focus.x < s.last.x;
  return { state: { ...s, cancel, last: s.touch, touch: focus }, notice: null };
}

// ---------------------------------------------------------------------------
// Tap 决策（design §5.5）
// ---------------------------------------------------------------------------

/** 一次 Tap 的上下文，均为按下那一刻的状态。由 `useReaderGesture` 收集。 */
export interface TapContext {
  /** 按下点所在的九宫格区域（`tapZone`，坐标以 `<main>` 的矩形为参照）。 */
  zone: TapZone;
  /** 按下时存在非空文本选区（调用方已清除它）。 */
  hadSelection: boolean;
  controlsVisible: boolean;
  /** 按下时结束了进行中的翻页动画（分页族）或滚动动画 / 惯性（滚动族）。 */
  abortedAnimation: boolean;
  family: RenderFamily;
}

/** Tap 的处理结果。`turn` 不附带任何控制栏动作（需求 5.11）。 */
export type TapDecision =
  | { kind: "none" }
  | { kind: "hide-controls" }
  | { kind: "show-controls" }
  | { kind: "turn"; direction: TurnDirection };

const TAP_NONE: TapDecision = { kind: "none" };
const TAP_HIDE_CONTROLS: TapDecision = { kind: "hide-controls" };
const TAP_SHOW_CONTROLS: TapDecision = { kind: "show-controls" };

/**
 * 按 design §5.5 的优先级取第一条命中的规则：
 *
 * 1. `hadSelection` → `none`（需求 5.8：清除选区并跳过本次动作）。
 * 2. MC 且 `abortedAnimation` → `none`（需求 5.10：保持控制栏当前显示状态）。
 *    必须排在第 3 条之前，否则控制栏可见时会被隐藏。
 * 3. `controlsVisible` → `hide-controls`（需求 5.9）。
 * 4. MC → `show-controls`（需求 5.4）。
 * 5. 滚动族且 `abortedAnimation` → `none`（照 Legado `isAbortAnim`）。
 * 6. 其余 → `turn`，方向取自 `tapAction`（需求 5.2、5.3）。
 *
 * 规则 4 用 `tapAction(zone) === "menu"` 判定：映射中只有 MC 映为 menu，两者等价，
 * 这样规则 6 拿到的动作已收窄为 prev / next。
 */
export function resolveTap(ctx: TapContext): TapDecision {
  if (ctx.hadSelection) return TAP_NONE;
  if (ctx.zone === "MC" && ctx.abortedAnimation) return TAP_NONE;
  if (ctx.controlsVisible) return TAP_HIDE_CONTROLS;
  const action = tapAction(ctx.zone);
  if (action === "menu") return TAP_SHOW_CONTROLS;
  if (ctx.family === "scroll" && ctx.abortedAnimation) return TAP_NONE;
  return { kind: "turn", direction: action };
}
