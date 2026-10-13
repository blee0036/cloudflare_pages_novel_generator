import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { TurnDirection } from "../components/reader/types";
import {
  BOUNDARY_NOTICE_MS,
  KEY_GATE_IDLE,
  KEY_TURN_GAP_MS,
  keyGateStep,
  NOTICE_IDLE,
  noticeStep,
  WHEEL_SETTLE_MS,
  wheelGateStep,
  type KeyGate,
  type NoticeEvent,
  type NoticeState,
  type WheelEvent as WheelGateEvent,
  type WheelPending,
} from "./turnInput";

// ───────────────────────────── 边界提示（noticeStep） ─────────────────────────────

/** 需求 3.5、3.6 规定的两条文字，与实现里的表各写一份。 */
const NOTICE_TEXT: Readonly<Record<TurnDirection, string>> = {
  prev: "没有上一页",
  next: "没有下一页",
};

/**
 * 事件时刻的取法：`gap` 为距上一事件的间隔；`edge` 落在当前到期时刻 `until` 的 −1 / 0 / +1 处，
 * 专门覆盖"恰好到期"的边界。两种都不早于上一事件，序列因此按时间排序。
 */
type Timing = { kind: "gap"; gap: number } | { kind: "edge"; offset: number };

interface NoticeSpec {
  kind: "hit" | "tick";
  direction: TurnDirection;
  timing: Timing;
}

const timingArb: fc.Arbitrary<Timing> = fc.oneof(
  // 短间隔：多落在提示可见期内，连续 hit 的情形最常见。
  { arbitrary: fc.integer({ min: 0, max: 500 }).map((gap): Timing => ({ kind: "gap", gap })), weight: 3 },
  // 长间隔：可越过到期时刻，包括到期后 tick 还没来、先来了 hit 的情形。
  {
    arbitrary: fc.integer({ min: 0, max: 3 * BOUNDARY_NOTICE_MS }).map((gap): Timing => ({ kind: "gap", gap })),
    weight: 2,
  },
  { arbitrary: fc.constantFrom(-1, 0, 1).map((offset): Timing => ({ kind: "edge", offset })), weight: 1 },
);

const noticeSpecArb: fc.Arbitrary<NoticeSpec> = fc.record({
  kind: fc.constantFrom<"hit" | "tick">("hit", "tick"),
  direction: fc.constantFrom<TurnDirection>("prev", "next"),
  timing: timingArb,
});

describe("noticeStep：边界提示", () => {
  // Feature: reader-page-turn-modes, Property 8: 边界提示至多一条
  // **Validates: Requirements 3.7**
  it("Feature: reader-page-turn-modes, Property 8: 边界提示至多一条——任意时刻至多一条文字，可见期间的 hit 不改文字与到期时刻，到期后的第一个 tick 清除文字", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.array(noticeSpecArb, { minLength: 1, maxLength: 40 }),
        (t0, specs) => {
          let state: NoticeState = NOTICE_IDLE;
          let t = t0;
          // 上一条显示出来的提示的到期时刻；新提示出现时不得早于它，两条的显示区间 [t, until) 因此不重叠。
          let shownUntil = -Infinity;

          for (const spec of specs) {
            t = spec.timing.kind === "gap" ? t + spec.timing.gap : Math.max(t, state.until + spec.timing.offset);
            const event: NoticeEvent =
              spec.kind === "hit" ? { kind: "hit", direction: spec.direction, t } : { kind: "tick", t };
            const visible = state.text !== null && t < state.until;
            const next = noticeStep(state, event);

            // 状态里只有一条文字，且只能是两条规定文字之一。
            expect(next.text === null || Object.values(NOTICE_TEXT).includes(next.text)).toBe(true);

            if (event.kind === "hit") {
              if (visible) {
                // 可见期间再次触及边界：文字与到期时刻都不变，返回同一个对象。
                expect(next).toBe(state);
              } else {
                // 没有可见提示（含已到期但 tick 未到）：显示该方向的文字，持续 1.5 秒。
                expect(next).toEqual({ text: NOTICE_TEXT[event.direction], until: t + BOUNDARY_NOTICE_MS });
                expect(t).toBeGreaterThanOrEqual(shownUntil);
                shownUntil = next.until;
              }
            } else if (state.text !== null && t >= state.until) {
              // 到期后的第一个 tick 清除文字。
              expect(next.text).toBeNull();
            } else {
              // 未到期或本来就没有提示：tick 不改状态。
              expect(next).toBe(state);
            }

            state = next;
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("示例：可见期间的 hit 原样返回，tick 恰在到期时刻清除，到期未 tick 时新的 hit 重新显示一条", () => {
    const shown = noticeStep(NOTICE_IDLE, { kind: "hit", direction: "next", t: 100 });
    expect(shown).toEqual({ text: "没有下一页", until: 100 + BOUNDARY_NOTICE_MS });

    expect(noticeStep(shown, { kind: "hit", direction: "prev", t: shown.until - 1 })).toBe(shown);
    expect(noticeStep(shown, { kind: "tick", t: shown.until - 1 })).toBe(shown);
    expect(noticeStep(shown, { kind: "tick", t: shown.until })).toEqual(NOTICE_IDLE);

    expect(noticeStep(shown, { kind: "hit", direction: "prev", t: shown.until })).toEqual({
      text: "没有上一页",
      until: shown.until + BOUNDARY_NOTICE_MS,
    });
    expect(noticeStep(NOTICE_IDLE, { kind: "tick", t: 5000 })).toBe(NOTICE_IDLE);
  });
});

// ───────────────────────────── 按键闸门（keyGateStep） ─────────────────────────────

/** 需求 11.6 规定的同方向最小间隔，与实现里的常量各写一份。 */
const KEY_GAP = 600;

const DIRECTIONS: readonly TurnDirection[] = ["prev", "next"];

const OTHER: Readonly<Record<TurnDirection, TurnDirection>> = { prev: "next", next: "prev" };

interface KeyEvent {
  direction: TurnDirection;
  t: number;
  repeat: boolean;
  animating: boolean;
}

/**
 * 事件时刻的取法：`gap` 为距上一事件（不分方向）的间隔；`edge` 落在"同方向上一个非 repeat 事件 + 600"的
 * −1 / 0 / +1 处，专门覆盖间隔恰为 599 / 600 / 601ms 的边界。两种都不早于上一事件，序列因此按时间排序。
 */
type KeyTiming = { kind: "gap"; gap: number } | { kind: "edge"; offset: number };

interface KeySpec {
  direction: TurnDirection;
  repeat: boolean;
  animating: boolean;
  timing: KeyTiming;
}

/** 按权重取 true / false 的布尔生成器。 */
const weightedBool = (trueWeight: number, falseWeight: number): fc.Arbitrary<boolean> =>
  fc.oneof({ arbitrary: fc.constant(true), weight: trueWeight }, { arbitrary: fc.constant(false), weight: falseWeight });

const keyTimingArb: fc.Arbitrary<KeyTiming> = fc.oneof(
  // 短间隔：多落在 600ms 内，被忽略、且被忽略的这次又推迟下一次的情形最常见。
  { arbitrary: fc.integer({ min: 0, max: 400 }).map((gap): KeyTiming => ({ kind: "gap", gap })), weight: 3 },
  // 长间隔：可越过 600ms。
  { arbitrary: fc.integer({ min: 0, max: 1500 }).map((gap): KeyTiming => ({ kind: "gap", gap })), weight: 2 },
  { arbitrary: fc.constantFrom(-1, 0, 1).map((offset): KeyTiming => ({ kind: "edge", offset })), weight: 1 },
);

const keySpecArb: fc.Arbitrary<KeySpec> = fc.record({
  direction: fc.constantFrom<TurnDirection>("prev", "next"),
  // 按住产生的 repeat 常成串出现，权重取高一些。
  repeat: weightedBool(1, 3),
  animating: weightedBool(1, 4),
  timing: keyTimingArb,
});

/**
 * 把生成的规格展开成按时间排序的事件序列。`edge` 需要知道同方向上一个非 repeat 事件的时刻，
 * 这里自己记一份，不读闸门状态；该方向还没有非 repeat 事件时 `edge` 不推进时间。
 */
function buildKeyEvents(t0: number, specs: readonly KeySpec[]): KeyEvent[] {
  const lastNonRepeat: Partial<Record<TurnDirection, number>> = {};
  const events: KeyEvent[] = [];
  let t = t0;
  for (const spec of specs) {
    const last = lastNonRepeat[spec.direction];
    if (spec.timing.kind === "gap") t += spec.timing.gap;
    else if (last !== undefined) t = Math.max(t, last + KEY_GAP + spec.timing.offset);
    events.push({ direction: spec.direction, t, repeat: spec.repeat, animating: spec.animating });
    if (!spec.repeat) lastNonRepeat[spec.direction] = t;
  }
  return events;
}

describe("keyGateStep：按键闸门", () => {
  // Feature: reader-page-turn-modes, Property 25: 按键闸门
  // **Validates: Requirements 11.5, 11.6, 11.7**
  it("Feature: reader-page-turn-modes, Property 25: 按键闸门——repeat 与动画中的按键不被接受，非 repeat 按键当且仅当距同方向上一个非 repeat 按键 ≥ 600ms 且不在动画中时被接受，repeat 不改状态，两个方向互不影响", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.array(keySpecArb, { minLength: 1, maxLength: 40 }),
        (t0, specs) => {
          const events = buildKeyEvents(t0, specs);

          // 参照模型：每个方向上一个非 repeat 事件的时刻（无论那次是否被接受），从未出现过时为 undefined。
          const prevAt: Partial<Record<TurnDirection, number>> = {};
          const accepted: boolean[] = [];
          let gate: KeyGate = KEY_GATE_IDLE;

          for (const event of events) {
            const { gate: next, accept } = keyGateStep(gate, event);

            if (event.repeat) {
              // 需求 11.5：自动重复事件一律忽略，闸门原样返回，不算作"上一次"。
              expect(accept).toBe(false);
              expect(next).toBe(gate);
            } else {
              const prev = prevAt[event.direction];
              const gapOk = prev === undefined || event.t - prev >= KEY_GAP;
              // 需求 11.6、11.7：接受当且仅当距同方向上一个非 repeat 事件 ≥ 600ms 且不在动画中。
              // 这同时给出两个方向的结论：被接受的必满足间隔，满足间隔且不在动画中的必被接受。
              expect(accept).toBe(gapOk && !event.animating);
              // 被忽略的非 repeat 按键也记为该方向的"上一次"；另一方向的记录不动。
              expect(next.lastAt[event.direction]).toBe(event.t);
              expect(next.lastAt[OTHER[event.direction]]).toBe(gate.lastAt[OTHER[event.direction]]);
              prevAt[event.direction] = event.t;
            }

            accepted.push(accept);
            gate = next;
          }

          // 两个方向互不影响：只把某一方向的事件单独喂给新闸门，接受结果与混合序列里逐个相同。
          for (const direction of DIRECTIONS) {
            let solo: KeyGate = KEY_GATE_IDLE;
            events.forEach((event, i) => {
              if (event.direction !== direction) return;
              const step = keyGateStep(solo, event);
              expect(step.accept).toBe(accepted[i]);
              solo = step.gate;
            });
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  /** 一次非 repeat 的翻页按键。 */
  const press = (gate: KeyGate, t: number, animating = false, direction: TurnDirection = "next") =>
    keyGateStep(gate, { direction, t, repeat: false, animating });

  it("示例：按住产生的 repeat 全部忽略且闸门不变，松开后的下一次按键只按首个 keydown 计间隔", () => {
    const first = press(KEY_GATE_IDLE, 0);
    expect(first.accept).toBe(true);

    // 按住约 2 秒，系统每 30ms 发一次 repeat：远超 600ms 的那些也一律忽略，闸门对象原样返回。
    let gate = first.gate;
    for (let t = 30; t <= 1980; t += 30) {
      const step = keyGateStep(gate, { direction: "next", t, repeat: true, animating: false });
      expect(step.accept).toBe(false);
      expect(step.gate).toBe(gate);
      gate = step.gate;
    }
    expect(gate.lastAt.next).toBe(0);

    // 松开后在 2000ms 再按：距首个 keydown 2000ms，被接受。若 repeat 也算"上一次"，距 1980ms 只有 20ms，会被忽略。
    expect(press(gate, 2000).accept).toBe(true);
  });

  it("示例：同方向间隔 599ms 忽略、600ms 接受；因间隔不足或动画中被忽略的按键都算作“上一次”", () => {
    expect(KEY_TURN_GAP_MS).toBe(600);
    const g0 = press(KEY_GATE_IDLE, 1000).gate;
    expect(press(g0, 1599).accept).toBe(false);
    expect(press(g0, 1600).accept).toBe(true);

    // 1599ms 那次被忽略，但成了新的"上一次"：再过 599ms 仍忽略，满 600ms 才接受。
    const g1 = press(g0, 1599).gate;
    expect(press(g1, 2198).accept).toBe(false);
    expect(press(g1, 2199).accept).toBe(true);

    // 1600ms 满足间隔但动画在播，忽略；它同样算数：2199ms 距 1000ms 已超 600ms，但距 1600ms 只有 599ms，仍忽略。
    const g2 = press(g0, 1600, true);
    expect(g2.accept).toBe(false);
    expect(press(g2.gate, 2199).accept).toBe(false);
    expect(press(g2.gate, 2200).accept).toBe(true);

    // 另一方向不受 next 的记录影响。
    expect(press(g1, 1600, false, "prev").accept).toBe(true);
  });
});

// ───────────────────────────── 滚轮闸门（wheelGateStep） ─────────────────────────────

/** 需求 11.8 规定的停顿时长，与实现里的常量各写一份。 */
const WHEEL_SETTLE = 200;

/**
 * 事件时刻的取法：`gap` 为距上一事件（滚轮或 tick）的间隔；`edge` 落在"上一个非零滚轮事件 + 200"的
 * −1 / 0 / +1 处，覆盖相邻间隔恰为 199 / 200 / 201ms 的边界，tick 取它时恰好落在到期时刻前后。
 * 两种都不早于上一事件，序列因此按时间排序；还没有非零滚轮事件时 `edge` 不推进时间。
 */
type WheelTiming = { kind: "gap"; gap: number } | { kind: "edge"; offset: number };

type WheelSpec = { kind: "wheel"; deltaY: number; timing: WheelTiming } | { kind: "tick"; timing: WheelTiming };

const wheelTimingArb: fc.Arbitrary<WheelTiming> = fc.oneof(
  // 短间隔：都在 200ms 内，同向顺延成一段、反向打断前一段的情形最常见。
  { arbitrary: fc.integer({ min: 0, max: 150 }).map((gap): WheelTiming => ({ kind: "gap", gap })), weight: 3 },
  // 长间隔：可越过 200ms，让前一段执行。
  { arbitrary: fc.integer({ min: 0, max: 600 }).map((gap): WheelTiming => ({ kind: "gap", gap })), weight: 2 },
  { arbitrary: fc.constantFrom(-1, 0, 1).map((offset): WheelTiming => ({ kind: "edge", offset })), weight: 1 },
);

/** 触控板会给出小数 deltaY，所以用 double；0 与 −0 单独加权，保证"deltaY = 0"常出现。 */
const deltaYArb: fc.Arbitrary<number> = fc.oneof(
  { arbitrary: fc.constantFrom(0, -0), weight: 1 },
  { arbitrary: fc.double({ min: 0, max: 500, minExcluded: true, noNaN: true }), weight: 2 },
  { arbitrary: fc.double({ min: -500, max: 0, maxExcluded: true, noNaN: true }), weight: 2 },
);

const wheelSpecArb: fc.Arbitrary<WheelSpec> = fc.oneof(
  {
    arbitrary: fc.record({ kind: fc.constant("wheel" as const), deltaY: deltaYArb, timing: wheelTimingArb }),
    weight: 3,
  },
  { arbitrary: fc.record({ kind: fc.constant("tick" as const), timing: wheelTimingArb }), weight: 1 },
);

/**
 * 把生成的规格展开成按时间排序的事件序列，末尾补一个不早于"最后事件 + 200"的 tick：
 * 最后一段若没有被打断，必在这个 tick 或之前执行，fire 次数因此可以与段数直接比较。
 */
function buildWheelEvents(t0: number, specs: readonly WheelSpec[], flushExtra: number): WheelGateEvent[] {
  const events: WheelGateEvent[] = [];
  let t = t0;
  let lastWheel: number | undefined;
  for (const spec of specs) {
    if (spec.timing.kind === "gap") t += spec.timing.gap;
    else if (lastWheel !== undefined) t = Math.max(t, lastWheel + WHEEL_SETTLE + spec.timing.offset);
    if (spec.kind === "wheel") {
      events.push({ kind: "wheel", deltaY: spec.deltaY, t });
      if (spec.deltaY !== 0) lastWheel = t;
    } else {
      events.push({ kind: "tick", t });
    }
  }
  events.push({ kind: "tick", t: t + WHEEL_SETTLE + flushExtra });
  return events;
}

/**
 * 参照模型：把非零滚轮事件切成"同号且相邻间隔 < 200ms 的极大连续段"，按段序返回其后 200ms 内
 * 没有被反向事件打断的段：方向取该段的符号，最早执行时刻为段末事件 + 200。tick 与 deltaY = 0 的事件不参与切段。
 */
function expectedWheelFires(events: readonly WheelGateEvent[]): { direction: TurnDirection; notBefore: number }[] {
  const fires: { direction: TurnDirection; notBefore: number }[] = [];
  let segment: { direction: TurnDirection; lastT: number } | null = null;
  for (const event of events) {
    if (event.kind !== "wheel" || event.deltaY === 0) continue;
    const direction: TurnDirection = event.deltaY > 0 ? "next" : "prev";
    if (segment !== null) {
      const gap = event.t - segment.lastT;
      if (direction === segment.direction && gap < WHEEL_SETTLE) {
        segment.lastT = event.t;
        continue;
      }
      // 段在此结束。下一个事件距段末 < 200ms 时只能是反向事件，这一段被打断；否则这一段执行。
      if (gap >= WHEEL_SETTLE) fires.push({ direction: segment.direction, notBefore: segment.lastT + WHEEL_SETTLE });
    }
    segment = { direction, lastT: event.t };
  }
  // 最后一段之后再没有滚轮事件，不会被打断。
  if (segment !== null) fires.push({ direction: segment.direction, notBefore: segment.lastT + WHEEL_SETTLE });
  return fires;
}

describe("wheelGateStep：滚轮闸门", () => {
  // Feature: reader-page-turn-modes, Property 26: 滚轮闸门
  // **Validates: Requirements 11.8**
  it("Feature: reader-page-turn-modes, Property 26: 滚轮闸门——deltaY = 0 不改状态，fire 次数等于未被反向事件打断的同号连续段数，方向与段的符号一致，且不早于段末事件之后 200ms", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.array(wheelSpecArb, { minLength: 1, maxLength: 40 }),
        fc.integer({ min: 0, max: 1000 }),
        (t0, specs, flushExtra) => {
          const events = buildWheelEvents(t0, specs, flushExtra);
          const fires: { direction: TurnDirection; t: number }[] = [];
          let pending: WheelPending | null = null;

          for (const event of events) {
            const step = wheelGateStep(pending, event);
            if (event.kind === "wheel" && event.deltaY === 0) {
              // deltaY = 0（含 −0）：待执行项原样返回，也不借机执行已到期的那次。
              expect(step.pending).toBe(pending);
              expect(step.fire).toBeNull();
            }
            if (step.fire !== null) fires.push({ direction: step.fire, t: event.t });
            pending = step.pending;
          }

          const expected = expectedWheelFires(events);
          // 次数与方向：按段序逐个对应（deltaY > 0 为 next）。
          expect(fires.map((f) => f.direction)).toEqual(expected.map((f) => f.direction));
          // 时刻：每次 fire 不早于对应段末事件之后 200ms。
          fires.forEach((f, i) => expect(f.t).toBeGreaterThanOrEqual(expected[i].notBefore));
          // 末尾的 tick 已越过最后一段的到期时刻，不留待执行项。
          expect(pending).toBeNull();
        },
      ),
      { numRuns: 200 },
    );
  });

  /** 依次喂给闸门，返回每次 fire 的方向与时刻。 */
  function runWheel(events: readonly WheelGateEvent[]): { direction: TurnDirection; t: number }[] {
    const fires: { direction: TurnDirection; t: number }[] = [];
    let pending: WheelPending | null = null;
    for (const event of events) {
      const step = wheelGateStep(pending, event);
      if (step.fire !== null) fires.push({ direction: step.fire, t: event.t });
      pending = step.pending;
    }
    return fires;
  }

  it("示例：滚轮中途反向时丢弃前一方向未执行的翻页，只执行反向那一次", () => {
    expect(WHEEL_SETTLE_MS).toBe(200);

    // 向下滚 0、50、100ms，120ms 起改为向上滚 120、160ms，随后停住。
    const down = wheelGateStep(null, { kind: "wheel", deltaY: 100, t: 0 });
    const down2 = wheelGateStep(down.pending, { kind: "wheel", deltaY: 100, t: 50 });
    const down3 = wheelGateStep(down2.pending, { kind: "wheel", deltaY: 100, t: 100 });
    expect(down3).toEqual({ pending: { direction: "next", due: 300 }, fire: null });
    // 反向那一刻：向下那次尚未到期，直接被替换，不执行。
    const up = wheelGateStep(down3.pending, { kind: "wheel", deltaY: -100, t: 120 });
    expect(up).toEqual({ pending: { direction: "prev", due: 320 }, fire: null });

    expect(
      runWheel([
        { kind: "wheel", deltaY: 100, t: 0 },
        { kind: "wheel", deltaY: 100, t: 50 },
        { kind: "wheel", deltaY: 100, t: 100 },
        { kind: "wheel", deltaY: -100, t: 120 },
        { kind: "wheel", deltaY: -100, t: 160 },
        { kind: "tick", t: 300 }, // 向下那段原定的到期时刻：已被丢弃
        { kind: "tick", t: 360 },
        { kind: "tick", t: 1000 },
      ]),
    ).toEqual([{ direction: "prev", t: 360 }]);
  });

  it("示例：反向事件距前一方向末事件 199ms 时丢弃前一方向，200ms 时前一方向已到期照常执行", () => {
    // 199ms：仍在"中途"，向下那次被丢弃。
    expect(
      runWheel([
        { kind: "wheel", deltaY: 100, t: 0 },
        { kind: "wheel", deltaY: -100, t: 199 },
        { kind: "tick", t: 1000 },
      ]),
    ).toEqual([{ direction: "prev", t: 1000 }]);

    // 200ms：向下那次已到期（定时器晚到也一样），在反向事件这一步先执行，两次翻页都发生。
    expect(
      runWheel([
        { kind: "wheel", deltaY: 100, t: 0 },
        { kind: "wheel", deltaY: -100, t: 200 },
        { kind: "tick", t: 400 },
      ]),
    ).toEqual([
      { direction: "next", t: 200 },
      { direction: "prev", t: 400 },
    ]);
  });
});
