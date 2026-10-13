/**
 * 输入闸门与边界提示归约（design §6.9、§8.2、§8.3）。
 *
 * 纯函数模块，不碰 DOM、不管定时器，时间一律由调用方以 `t`（ms，同一时钟）传入：
 * - `noticeStep`：边界提示"没有上一页 / 没有下一页"的显示与到期（需求 3.5–3.7、10.14、10.15）。
 *   调用方在提示出现时按 `until` 安排一次 `tick`。
 * - `keyGateStep`：`turn-*` 按键的过滤（需求 11.5–11.7），对应 Legado `keyPageDebounce`
 *   的 600ms leading 防抖，两个方向各一份。
 * - `wheelGateStep`：分页模式滚轮的 200ms 尾沿防抖（需求 11.8）。调用方在有待执行项时按
 *   `due` 安排一次 `tick`。
 *
 * 与 Legado 的偏离（design §0）：Legado 的上下两个方向各有一个独立的滚轮尾沿防抖，滚轮中途反转后
 * 两个方向的翻页都会执行；这里只保留一个待执行项，方向改变时丢弃前一方向未执行的那次翻页。
 */

import type { TurnDirection } from "../components/reader/types";

// ---------------------------------------------------------------------------
// 边界提示（design §6.9）
// ---------------------------------------------------------------------------

/** 边界提示的显示时长（需求 3.5、3.6）。 */
export const BOUNDARY_NOTICE_MS = 1500;

/** `hit`：某方向上没有可翻的页；`tick`：调用方的到期定时器。 */
export type NoticeEvent =
  | { kind: "hit"; direction: TurnDirection; t: number }
  | { kind: "tick"; t: number };

export interface NoticeState {
  /** 当前显示的文字，未显示时为 null。状态只有这一个字段承载文字，所以至多一条（需求 3.7）。 */
  text: string | null;
  /** 到期时刻（ms）。`text` 为 null 时无意义。 */
  until: number;
}

/** 没有提示时的状态，也是初始状态。 */
export const NOTICE_IDLE: NoticeState = { text: null, until: 0 };

const NOTICE_TEXT: Readonly<Record<TurnDirection, string>> = {
  prev: "没有上一页",
  next: "没有下一页",
};

/**
 * 边界提示的一步。
 *
 * - `hit`：提示可见（`text` 非 null 且 `t < until`）时原样返回，文字与到期时刻都不变，对应 Legado
 *   `if (!snackBar.isShown)`（需求 3.7）；否则显示该方向的文字，到期时刻为 `t + 1500`。
 *   已到期但 `tick` 尚未送达的提示视为不可见，此时的 `hit` 重新显示一条。
 * - `tick`：`t ≥ until` 时清除文字；未到期或本来就没有提示时原样返回。
 *
 * 状态不变时返回同一个对象，调用方可据此跳过渲染。
 */
export function noticeStep(state: NoticeState, event: NoticeEvent): NoticeState {
  const visible = state.text !== null && event.t < state.until;
  switch (event.kind) {
    case "hit":
      if (visible) return state;
      return { text: NOTICE_TEXT[event.direction], until: event.t + BOUNDARY_NOTICE_MS };
    case "tick":
      if (state.text === null || visible) return state;
      return NOTICE_IDLE;
  }
}

// ---------------------------------------------------------------------------
// 按键闸门（design §8.2）
// ---------------------------------------------------------------------------

/** 同方向两次翻页按键的最小间隔（需求 11.6，Legado `keyPageDebounce` 的 `wait = 600L`）。 */
export const KEY_TURN_GAP_MS = 600;

export interface KeyGate {
  /** 各方向上一次非 repeat 按键的时刻（ms），不论那次是否被接受。从未按过时为 `-Infinity`。 */
  lastAt: { prev: number; next: number };
}

/** 两个方向都没有按过的闸门，也是初始状态：第一次按键必定满足间隔。 */
export const KEY_GATE_IDLE: KeyGate = { lastAt: { prev: -Infinity, next: -Infinity } };

/**
 * 除自动重复事件外，每个 turn-* 按键事件都会更新该方向的 lastAt，因间隔不足或动画中被忽略的也算（需求 11.6）。
 * repeat 事件直接丢弃、不更新 lastAt，对应 Legado `keyPageDebounce` 里 `longPress` 的提前返回。
 *
 * `accept = !repeat && (t − 旧 lastAt[direction] ≥ 600) && !animating`（需求 11.5–11.7）。
 * 两个方向的 `lastAt` 互不影响；repeat 事件原样返回同一个闸门对象。
 */
export function keyGateStep(
  gate: KeyGate,
  event: { direction: TurnDirection; t: number; repeat: boolean; animating: boolean },
): { gate: KeyGate; accept: boolean } {
  if (event.repeat) return { gate, accept: false };
  const accept = event.t - gate.lastAt[event.direction] >= KEY_TURN_GAP_MS && !event.animating;
  return { gate: { lastAt: { ...gate.lastAt, [event.direction]: event.t } }, accept };
}

// ---------------------------------------------------------------------------
// 滚轮闸门（design §8.3）
// ---------------------------------------------------------------------------

/** 同方向滚轮事件停止多久后翻页（需求 11.8，Legado `keyPageDebounce` 的 `wait = 200L`）。 */
export const WHEEL_SETTLE_MS = 200;

/**
 * 滚轮闸门的输入：`wheel` 来自 `<main>` 的滚轮事件，`tick` 是调用方按 `due` 安排的定时器。
 *
 * 注意与 DOM 的同名类型 `WheelEvent` 区分；调用方同时用到两者时以别名导入。
 */
export type WheelEvent =
  | { kind: "wheel"; deltaY: number; t: number }
  | { kind: "tick"; t: number };

/** 待执行的那次翻页：方向与最早执行时刻（ms）。 */
export interface WheelPending {
  direction: TurnDirection;
  due: number;
}

/**
 * 滚轮闸门的一步，输出至多一次 `fire`。
 *
 * - `wheel`：`deltaY > 0` 为 next，`< 0` 为 prev；`deltaY` 为 0（或非有限数，同 Legado
 *   `onGenericMotionEvent` 的 `!axisValue.isFinite()`）时原样返回。同方向把 `due` 顺延到 `t + 200`，
 *   方向改变时以新方向替换待执行项，前一方向的翻页被丢弃（design §0）。
 * - `tick`：`t ≥ due` 时输出待执行项的方向并清空；未到期或没有待执行项时原样返回。
 *
 * 定时器可能晚到：`wheel` 到来时若待执行项已到期（`t ≥ due`，即同方向事件早已停了 200ms），
 * 先把它作为本步的 `fire` 输出，再登记新事件。这样输出只取决于事件时刻，与 `tick` 是否准时无关。
 */
export function wheelGateStep(
  pending: WheelPending | null,
  event: WheelEvent,
): { pending: WheelPending | null; fire: TurnDirection | null } {
  // 已到期的待执行项的方向；没有待执行项或未到期时为 null。
  const ripe = pending !== null && event.t >= pending.due ? pending.direction : null;
  switch (event.kind) {
    case "wheel": {
      if (event.deltaY === 0 || !Number.isFinite(event.deltaY)) return { pending, fire: null };
      const direction: TurnDirection = event.deltaY > 0 ? "next" : "prev";
      return { pending: { direction, due: event.t + WHEEL_SETTLE_MS }, fire: ripe };
    }
    case "tick":
      if (ripe === null) return { pending, fire: null };
      return { pending: null, fire: ripe };
  }
}
