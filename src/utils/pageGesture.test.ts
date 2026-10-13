import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { TurnDirection } from "../components/reader/types";
import type { RenderFamily } from "./pageAnim";
import {
  GESTURE_IDLE,
  LONG_PRESS_MS,
  TOUCH_SLOP_PX,
  beyondTouchSlop,
  dragStep,
  focalPoint,
  gestureStep,
  initialDragState,
  resolveTap,
  type DragState,
  type GestureEvent,
  type GestureOutput,
  type GestureState,
  type TapContext,
  type TapDecision,
} from "./pageGesture";
import { tapAction, type TapZone } from "./tapZone";
import type { Pt } from "./turnMotion";

/** 从 `GESTURE_IDLE` 起把事件依次喂给 `gestureStep`，收集每一步的输出与最终状态。 */
function runGesture(events: readonly GestureEvent[]): { outs: GestureOutput[]; state: GestureState } {
  let state = GESTURE_IDLE;
  const outs: GestureOutput[] = [];
  for (const event of events) {
    const step = gestureStep(state, event);
    state = step.state;
    outs.push(step.out);
  }
  return { outs, state };
}

// ───────────────────────────── 手势分类（gestureStep） ─────────────────────────────

/**
 * 坐标取在 1/8 px 的网格上：差值与平方和都能精确表示，参照模型的 `dx² + dy² > 8²` 不受舍入影响。
 * 网格上与按下点恰好相距 8 的只有轴向四点（2 的幂作斜边没有非平凡的勾股数）。
 */
const GRID = 8;

function gridArb(min: number, max: number): fc.Arbitrary<number> {
  return fc.integer({ min: min * GRID, max: max * GRID }).map((n) => n / GRID);
}

/** 移动相对按下点的位移：多数落在 Touch_Slop 附近，外加恰在阈值上、刚越过阈值与远距离三类。 */
const offsetArb: fc.Arbitrary<Pt> = fc.oneof(
  { arbitrary: fc.record({ x: gridArb(-TOUCH_SLOP_PX, TOUCH_SLOP_PX), y: gridArb(-TOUCH_SLOP_PX, TOUCH_SLOP_PX) }), weight: 4 },
  {
    arbitrary: fc.constantFrom<Pt>(
      { x: TOUCH_SLOP_PX, y: 0 },
      { x: -TOUCH_SLOP_PX, y: 0 },
      { x: 0, y: TOUCH_SLOP_PX },
      { x: 0, y: -TOUCH_SLOP_PX },
      { x: TOUCH_SLOP_PX + 1 / GRID, y: 0 },
      { x: 0, y: -TOUCH_SLOP_PX - 1 / GRID },
      { x: 5.625, y: 5.625 }, // 距离 ≈ 7.955，未越过
      { x: -5.625, y: 5.75 }, // 距离 ≈ 8.044，越过
    ),
    weight: 1,
  },
  { arbitrary: fc.record({ x: gridArb(-400, 400), y: gridArb(-400, 400) }), weight: 2 },
);

/** 定时器相对按下的延迟：不足 600ms、恰好 599 / 600，以及满 600ms 之后任意时刻。 */
const timerDelayArb = fc.oneof(
  fc.integer({ min: 0, max: LONG_PRESS_MS - 1 }),
  fc.constantFrom(LONG_PRESS_MS - 1, LONG_PRESS_MS),
  fc.integer({ min: LONG_PRESS_MS, max: 5 * LONG_PRESS_MS }),
);

/**
 * 单指针轨迹：`down`，若干 `move`（与上一事件的间隔 `gap`），以 `up` 或 `cancel` 结束。
 * `timer` 插在 `moves[before]` 之前（`before = moves.length` 即插在结束事件之前），可以没有。
 */
interface Trajectory {
  id: number;
  start: Pt;
  t0: number;
  moves: { offset: Pt; gap: number }[];
  timer: { before: number; delay: number } | null;
  end: "up" | "cancel";
  endGap: number;
}

const gapArb = fc.integer({ min: 0, max: 300 });

const trajectoryArb: fc.Arbitrary<Trajectory> = fc
  .record({
    id: fc.nat(),
    start: fc.record({ x: gridArb(0, 2000), y: gridArb(0, 2000) }),
    t0: fc.integer({ min: 0, max: 1_000_000 }),
    moves: fc.array(fc.record({ offset: offsetArb, gap: gapArb }), { maxLength: 12 }),
    end: fc.oneof({ arbitrary: fc.constant("up" as const), weight: 3 }, { arbitrary: fc.constant("cancel" as const), weight: 1 }),
    endGap: gapArb,
  })
  .chain((tr) =>
    fc
      .option(fc.record({ before: fc.integer({ min: 0, max: tr.moves.length }), delay: timerDelayArb }), { nil: null })
      .map((timer) => ({ ...tr, timer })),
  );

/** 把轨迹展开成时间戳单调不减的事件序列。定时器不早于前一事件，也不早于 `t0 + delay`。 */
function trajectoryEvents(tr: Trajectory): { events: GestureEvent[]; points: Pt[]; timerAt: number | null } {
  const events: GestureEvent[] = [{ kind: "down", id: tr.id, p: tr.start, t: tr.t0 }];
  const points = tr.moves.map(({ offset }) => ({ x: tr.start.x + offset.x, y: tr.start.y + offset.y }));
  let t = tr.t0;
  let timerAt: number | null = null;
  const pushTimer = (): void => {
    if (tr.timer === null) return;
    t = Math.max(t, tr.t0 + tr.timer.delay);
    timerAt = t;
    events.push({ kind: "timer", t });
  };
  tr.moves.forEach(({ gap }, k) => {
    if (tr.timer?.before === k) pushTimer();
    t += gap;
    events.push({ kind: "move", id: tr.id, p: points[k], t });
  });
  if (tr.timer?.before === tr.moves.length) pushTimer();
  t += tr.endGap;
  events.push(tr.end === "up" ? { kind: "up", id: tr.id, t } : { kind: "cancel", id: tr.id });
  return { events, points, timerAt };
}

/**
 * 参照模型（design Property 9），只看轨迹整体，不模拟状态机：
 * - `cross`：首个与按下点欧氏距离 > 8 的 `move`。
 * - 长按：定时器距按下满 600ms，且插在 `cross` 之前（或根本没有越阈的移动）。
 * - 拖拽：有越阈的移动且未长按。
 * 每个事件的期望输出由这三者直接给出；Tap 与长按都报告按下点。
 */
function expectedOutputs(tr: Trajectory, points: readonly Pt[], timerAt: number | null): GestureOutput[] {
  const beyond = (p: Pt): boolean => {
    const dx = p.x - tr.start.x;
    const dy = p.y - tr.start.y;
    return dx * dx + dy * dy > TOUCH_SLOP_PX * TOUCH_SLOP_PX;
  };
  const cross = points.findIndex(beyond);
  const longPressFrom =
    tr.timer !== null && timerAt !== null && timerAt - tr.t0 >= LONG_PRESS_MS && (cross === -1 || tr.timer.before <= cross)
      ? tr.timer.before
      : null;
  const dragFrom = cross !== -1 && longPressFrom === null ? cross : null;

  const none: GestureOutput = { kind: "none" };
  const timerOut: GestureOutput = longPressFrom !== null ? { kind: "long-press", at: tr.start } : none;
  const out: GestureOutput[] = [none];
  points.forEach((p, k) => {
    if (tr.timer?.before === k) out.push(timerOut);
    if (longPressFrom !== null && k >= longPressFrom) out.push({ kind: "select-extend", to: p });
    else if (dragFrom !== null && k === dragFrom) out.push({ kind: "drag-start", focus: p });
    else if (dragFrom !== null && k > dragFrom) out.push({ kind: "drag-move", focus: p });
    else out.push(none);
  });
  if (tr.timer?.before === points.length) out.push(timerOut);
  if (dragFrom !== null) out.push({ kind: "drag-end" });
  else if (tr.end === "up" && longPressFrom === null) out.push({ kind: "tap", at: tr.start });
  else out.push(none);
  return out;
}

describe("gestureStep：手势分类", () => {
  // Feature: reader-page-turn-modes, Property 9: 手势分类
  // **Validates: Requirements 4.1, 4.10**
  it("Feature: reader-page-turn-modes, Property 9: 手势分类——越过 8px 前无 drag-*，满 600ms 的定时器先到则只扩展选区，未拖拽未长按的 up 才是 tap", () => {
    fc.assert(
      fc.property(trajectoryArb, (tr) => {
        const { events, points, timerAt } = trajectoryEvents(tr);
        const { outs, state } = runGesture(events);
        expect(outs).toEqual(expectedOutputs(tr, points, timerAt));
        // 结束事件之后回到空闲，下一个手势从头开始。
        expect(state.phase).toBe("idle");
        expect(state.pointers).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });
});

describe("gestureStep：长按判定、长按后的移动与 cancel 的例子", () => {
  const NONE: GestureOutput = { kind: "none" };
  const p0: Pt = { x: 200, y: 300 };
  const t0 = 10_000;
  const down = (id = 1, p: Pt = p0, t = t0): GestureEvent => ({ kind: "down", id, p, t });
  /** 主指针相对按下点位移 (dx, dy)。 */
  const move = (dx: number, dy: number, t: number, id = 1): GestureEvent => ({
    kind: "move",
    id,
    p: { x: p0.x + dx, y: p0.y + dy },
    t,
  });
  const timer = (elapsed: number): GestureEvent => ({ kind: "timer", t: t0 + elapsed });
  const up = (t: number, id = 1): GestureEvent => ({ kind: "up", id, t });
  const cancel = (id = 1): GestureEvent => ({ kind: "cancel", id });

  it("按下后 599ms 到期的定时器不算长按，仍处于按下阶段，抬起是 Tap", () => {
    const pressed = gestureStep(GESTURE_IDLE, down()).state;
    const early = gestureStep(pressed, timer(LONG_PRESS_MS - 1));
    expect(early).toEqual({ state: pressed, out: NONE });

    const { outs, state } = runGesture([down(), timer(LONG_PRESS_MS - 1), up(t0 + LONG_PRESS_MS - 1)]);
    expect(outs).toEqual([NONE, NONE, { kind: "tap", at: p0 }]);
    expect(state).toEqual(GESTURE_IDLE);
  });

  it("满 600ms 即长按并报告按下点；抬起不产生 Tap", () => {
    const { outs, state } = runGesture([down(), timer(LONG_PRESS_MS), up(t0 + 900)]);
    expect(outs).toEqual([NONE, { kind: "long-press", at: p0 }, NONE]);
    expect(state).toEqual(GESTURE_IDLE);
  });

  it("599ms 的定时器落空不影响之后 600ms 的定时器触发长按", () => {
    const { outs } = runGesture([down(), timer(LONG_PRESS_MS - 1), timer(LONG_PRESS_MS), up(t0 + 700)]);
    expect(outs).toEqual([NONE, NONE, { kind: "long-press", at: p0 }, NONE]);
  });

  it("长按后的移动只输出 select-extend：越过 8px 乃至远距离都不起步拖拽", () => {
    const { outs, state } = runGesture([
      down(),
      timer(LONG_PRESS_MS),
      move(3, 2, t0 + 650),
      move(TOUCH_SLOP_PX + 1, 0, t0 + 700),
      move(-300, 120, t0 + 750),
      up(t0 + 800),
    ]);
    expect(outs).toEqual([
      NONE,
      { kind: "long-press", at: p0 },
      { kind: "select-extend", to: { x: p0.x + 3, y: p0.y + 2 } },
      { kind: "select-extend", to: { x: p0.x + TOUCH_SLOP_PX + 1, y: p0.y } },
      { kind: "select-extend", to: { x: p0.x - 300, y: p0.y + 120 } },
      NONE,
    ]);
    expect(state).toEqual(GESTURE_IDLE);
  });

  it("长按后第二根手指的移动也只扩展选区，选区端点始终跟随主指针", () => {
    const q: Pt = { x: 600, y: 500 };
    const { outs, state } = runGesture([
      down(),
      timer(LONG_PRESS_MS),
      down(2, q, t0 + 620),
      { kind: "move", id: 2, p: { x: q.x - 200, y: q.y }, t: t0 + 650 },
      move(30, 10, t0 + 700),
      up(t0 + 750, 2),
      up(t0 + 800),
    ]);
    expect(outs).toEqual([
      NONE,
      { kind: "long-press", at: p0 },
      NONE,
      { kind: "select-extend", to: p0 },
      { kind: "select-extend", to: { x: p0.x + 30, y: p0.y + 10 } },
      NONE,
      NONE,
    ]);
    expect(state).toEqual(GESTURE_IDLE);
  });

  it("先越阈起步拖拽，之后到期的 600ms 定时器不再转成长按", () => {
    const { outs } = runGesture([
      down(),
      move(TOUCH_SLOP_PX + 1, 0, t0 + 100),
      timer(LONG_PRESS_MS),
      move(50, 0, t0 + 650),
      up(t0 + 700),
    ]);
    expect(outs).toEqual([
      NONE,
      { kind: "drag-start", focus: { x: p0.x + TOUCH_SLOP_PX + 1, y: p0.y } },
      NONE,
      { kind: "drag-move", focus: { x: p0.x + 50, y: p0.y } },
      { kind: "drag-end" },
    ]);
  });

  it("cancel 不产生 Tap：按下后、未越阈的移动后、长按中取消都输出 none，随后同一指针的 up 也被忽略", () => {
    const prefixes: GestureEvent[][] = [
      [down()],
      [down(), move(5, 5, t0 + 100)], // 距离 ≈ 7.07，未越阈
      [down(), timer(LONG_PRESS_MS)],
    ];
    for (const prefix of prefixes) {
      const { outs, state } = runGesture([...prefix, cancel(), up(t0 + 900)]);
      expect(outs.slice(-2)).toEqual([NONE, NONE]);
      expect(outs.some((out) => out.kind === "tap")).toBe(false);
      expect(state).toEqual(GESTURE_IDLE);
    }
  });

  it("拖拽中被 cancel 按拖拽结束处理：输出 drag-end，不是 tap", () => {
    const { outs, state } = runGesture([down(), move(-20, 0, t0 + 100), cancel()]);
    expect(outs).toEqual([NONE, { kind: "drag-start", focus: { x: p0.x - 20, y: p0.y } }, { kind: "drag-end" }]);
    expect(state).toEqual(GESTURE_IDLE);
  });

  it("多指手势中任一指针 cancel 即结束整个手势，其余指针随后抬起也不产生 Tap", () => {
    const { outs, state } = runGesture([down(), down(2, { x: 260, y: 320 }, t0 + 50), cancel(2), up(t0 + 200)]);
    expect(outs).toEqual([NONE, NONE, NONE, NONE]);
    expect(state).toEqual(GESTURE_IDLE);
  });
});

// ───────────────────────────── 拖拽方向归约（dragStep / focalPoint） ─────────────────────────────

/** 某一步 `hasPage` 对两个方向的回答。 */
type Pages = Readonly<Record<TurnDirection, boolean>>;

function opposite(direction: TurnDirection): TurnDirection {
  return direction === "next" ? "prev" : "next";
}

/**
 * `p` 相对 `ref` 是否背离 `direction`：next 背离为向右（x 增大），prev 背离为向左；水平分量为 0 不算。
 * 越过起点（以 `start` 为参照，需求 4.5）与取消（以 `last` 为参照，需求 4.8）是同一条判定。
 */
function against(direction: TurnDirection, ref: Pt, p: Pt): boolean {
  return direction === "next" ? p.x > ref.x : p.x < ref.x;
}

/** 起步或反转后的状态：`start`、`touch`、`last` 都落在该次焦点上，尚未取消。 */
function anchoredAt(direction: TurnDirection, p: Pt): DragState {
  return { moved: true, blocked: false, direction, start: p, touch: p, last: p, cancel: false };
}

/** 从按下点起依次喂入焦点，第 k 步的 `hasPage(d)` 取 `hasPage(k, d)`；收集每一步的输出。 */
function runDrag(
  down: Pt,
  focuses: readonly Pt[],
  hasPage: (k: number, direction: TurnDirection) => boolean,
): { state: DragState; notice: TurnDirection | null }[] {
  let state = initialDragState(down);
  return focuses.map((focus, k) => {
    const step = dragStep(state, focus, (direction) => hasPage(k, direction));
    state = step.state;
    return step;
  });
}

/**
 * 相邻两次焦点的位移。坐标沿用 1/8 px 网格，阈值与越过起点的比较都是精确的。
 * 小幅随机游走常常越过起点，反转与冻结都能频繁触发；另有纯竖直移动与贴着阈值的定长步。
 */
const focusStepArb: fc.Arbitrary<Pt> = fc.oneof(
  { arbitrary: fc.record({ x: gridArb(-24, 24), y: gridArb(-8, 8) }), weight: 4 },
  { arbitrary: fc.record({ x: fc.constant(0), y: gridArb(-16, 16) }), weight: 1 },
  {
    arbitrary: fc.constantFrom<Pt>(
      { x: TOUCH_SLOP_PX, y: 0 },
      { x: -TOUCH_SLOP_PX, y: 0 },
      { x: 0, y: TOUCH_SLOP_PX },
      { x: 1 / GRID, y: 0 },
      { x: -1 / GRID, y: 0 },
    ),
    weight: 1,
  },
);

/** 偏向有页，免得多数轨迹在起步时就被挡住。 */
const hasPageArb = fc.oneof({ arbitrary: fc.constant(true), weight: 3 }, { arbitrary: fc.constant(false), weight: 1 });
const pagesArb: fc.Arbitrary<Pages> = fc.record({ prev: hasPageArb, next: hasPageArb });

interface DragCase {
  down: Pt;
  /** 每一步的焦点（绝对坐标）。 */
  focuses: Pt[];
  /** 每一步 `hasPage` 的回答：多数轨迹全程同一个谓词，其余逐步随机（对应 `"pending"` 补分页后答案改变）。 */
  pages: Pages[];
}

const dragCaseArb: fc.Arbitrary<DragCase> = fc
  .record({
    down: fc.record({ x: gridArb(0, 1000), y: gridArb(0, 1000) }),
    steps: fc.array(focusStepArb, { minLength: 1, maxLength: 24 }),
    fixed: fc.option(pagesArb, { nil: null }),
  })
  .chain(({ down, steps, fixed }) =>
    fc.array(pagesArb, { minLength: steps.length, maxLength: steps.length }).map((perStep): DragCase => {
      const focuses: Pt[] = [];
      let p = down;
      for (const d of steps) {
        p = { x: p.x + d.x, y: p.y + d.y };
        focuses.push(p);
      }
      return { down, focuses, pages: fixed === null ? perStep : steps.map(() => fixed) };
    }),
  );

describe("dragStep / focalPoint：拖拽方向归约", () => {
  // Feature: reader-page-turn-modes, Property 10: 拖拽方向归约
  // **Validates: Requirements 4.2, 4.3, 4.5, 4.6**
  it("Feature: reader-page-turn-modes, Property 10: 拖拽方向归约——起步按水平位移符号判向，起步无页全程静止，越过 start 且反向有页才切换，cancel 为本次焦点相对上一触点背离方向", () => {
    fc.assert(
      fc.property(dragCaseArb, ({ down, focuses, pages }) => {
        const steps = runDrag(down, focuses, (k, direction) => pages[k][direction]);
        const init = initialDragState(down);
        const beyond = (p: Pt): boolean => {
          const dx = p.x - down.x;
          const dy = p.y - down.y;
          return dx * dx + dy * dy > TOUCH_SLOP_PX * TOUCH_SLOP_PX;
        };
        const cross = focuses.findIndex(beyond);
        const crossAt = cross === -1 ? focuses.length : cross;

        // 越过 Touch_Slop 之前状态不变、没有提示。
        for (let k = 0; k < crossAt; k++) expect(steps[k]).toEqual({ state: init, notice: null });
        if (cross === -1) return;

        // 起步：首个越阈焦点相对按下点的 x 位移 > 0 为 prev，≤ 0 为 next（需求 4.2）。
        let direction: TurnDirection = focuses[cross].x - down.x > 0 ? "prev" : "next";
        if (!pages[cross][direction]) {
          // 起步方向无页：提示该方向，此后一切移动都被忽略，触点永远停在按下点（需求 4.3）。
          const blocked: DragState = { ...init, moved: true, blocked: true };
          expect(steps[cross]).toEqual({ state: blocked, notice: direction });
          for (let k = cross + 1; k < focuses.length; k++) expect(steps[k]).toEqual({ state: blocked, notice: null });
          return;
        }
        let model = anchoredAt(direction, focuses[cross]);
        expect(steps[cross]).toEqual({ state: model, notice: null });

        for (let k = cross + 1; k < focuses.length; k++) {
          const focus = focuses[k];
          const reverse = opposite(direction);
          let expected: { state: DragState; notice: TurnDirection | null };
          if (!against(direction, model.start, focus)) {
            // 跟随：cancel 拿本次焦点与上一触点 `last` 比较，然后触点后移一位（last ← touch ← focus）。
            expected = {
              state: { ...model, cancel: against(direction, model.last, focus), last: model.touch, touch: focus },
              notice: null,
            };
          } else if (pages[k][reverse]) {
            // 越过 start 且反方向有页：切换方向，start 等于该次焦点（需求 4.5）。
            direction = reverse;
            expected = { state: anchoredAt(direction, focus), notice: null };
          } else {
            // 越过 start 但反方向无页：提示反方向，保持原方向，触点与 cancel 都不更新（design §0 冻结规则）。
            expected = { state: model, notice: reverse };
          }
          expect(steps[k]).toEqual(expected);
          model = expected.state;
        }
      }),
      { numRuns: 300 },
    );
  });

  // Feature: reader-page-turn-modes, Property 10: 拖拽方向归约
  // **Validates: Requirements 4.6**
  it("Feature: reader-page-turn-modes, Property 10: 拖拽方向归约——focalPoint 返回各按下指针坐标的算术平均", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ x: gridArb(-2000, 2000), y: gridArb(-2000, 2000) }), { minLength: 1, maxLength: 10 }),
        (points) => {
          // 网格坐标求和没有舍入，和与求和次序无关；两边除以同一个 n，可以精确比较。
          const n = points.length;
          const mean: Pt = {
            x: points.reduce((sum, p) => sum + p.x, 0) / n,
            y: points.reduce((sum, p) => sum + p.y, 0) / n,
          };
          expect(focalPoint(points)).toEqual(mean);
          // 每个指针权重相同：换个次序结果不变。
          expect(focalPoint([...points].reverse())).toEqual(mean);
        },
      ),
      { numRuns: 200 },
    );
  });

  const down: Pt = { x: 400, y: 300 };
  const at = (dx: number, dy = 0): Pt => ({ x: down.x + dx, y: down.y + dy });
  const always = (): boolean => true;

  it("位移恰好 8px 不算移动，再多 1/8px 才起步", () => {
    const init = initialDragState(down);
    for (const p of [at(TOUCH_SLOP_PX), at(-TOUCH_SLOP_PX), at(0, TOUCH_SLOP_PX), at(0, -TOUCH_SLOP_PX)]) {
      expect(beyondTouchSlop(down, p)).toBe(false);
      expect(dragStep(init, p, always)).toEqual({ state: init, notice: null });
    }
    expect(dragStep(init, at(TOUCH_SLOP_PX + 1 / GRID), always).state).toEqual(anchoredAt("prev", at(TOUCH_SLOP_PX + 1 / GRID)));
    expect(dragStep(init, at(-TOUCH_SLOP_PX - 1 / GRID), always).state).toEqual(anchoredAt("next", at(-TOUCH_SLOP_PX - 1 / GRID)));
  });

  it("首个越阈焦点 x − start.x = 0 判为 next；next 无页时提示 next 并全程静止", () => {
    const init = initialDragState(down);
    const p = at(0, 20);
    expect(dragStep(init, p, always)).toEqual({ state: anchoredAt("next", p), notice: null });

    const noNext = (direction: TurnDirection): boolean => direction !== "next";
    const blocked = dragStep(init, p, noNext);
    expect(blocked).toEqual({ state: { ...init, moved: true, blocked: true }, notice: "next" });
    // 之后往右拖（prev 方向有页）也不动。
    expect(dragStep(blocked.state, at(200), always)).toEqual({ state: blocked.state, notice: null });
  });

  it("水平分量为 0 不算取消", () => {
    const next = runDrag(down, [at(-20), at(-20, 10), at(-20, 25)], always);
    expect(next.map((s) => [s.state.direction, s.state.cancel])).toEqual([
      ["next", false],
      ["next", false],
      ["next", false],
    ]);
    const prev = runDrag(down, [at(20), at(20, -10), at(20, -25)], always);
    expect(prev.map((s) => [s.state.direction, s.state.cancel])).toEqual([
      ["prev", false],
      ["prev", false],
      ["prev", false],
    ]);
  });

  it("cancel 与 last（touch 之前的触点）比较：单次回拉要到下一次移动才判为取消（照 Legado onScroll 的取值时机）", () => {
    // next 起步于 x = 380：→370 前进；→375 回拉，但与 last = 380 比仍不取消；→373 与 last = 370 比，取消。
    const steps = runDrag(down, [at(-20), at(-30), at(-25), at(-27)], always);
    expect(steps.map((s) => s.state.cancel)).toEqual([false, false, false, true]);
  });
});

// ───────────────────────────── Tap 决策（resolveTap） ─────────────────────────────

const TAP_ZONES: readonly TapZone[] = ["TL", "TC", "TR", "ML", "MC", "MR", "BL", "BC", "BR"];
const FAMILIES: readonly RenderFamily[] = ["paged", "scroll"];
const BOOLS = [false, true] as const;

const tapContextArb: fc.Arbitrary<TapContext> = fc.record({
  zone: fc.constantFrom(...TAP_ZONES),
  hadSelection: fc.boolean(),
  controlsVisible: fc.boolean(),
  abortedAnimation: fc.boolean(),
  family: fc.constantFrom(...FAMILIES),
});

/** 全部 9 × 2 × 2 × 2 × 2 = 144 种上下文。 */
const ALL_TAP_CONTEXTS: readonly TapContext[] = TAP_ZONES.flatMap((zone) =>
  FAMILIES.flatMap((family) =>
    BOOLS.flatMap((hadSelection) =>
      BOOLS.flatMap((controlsVisible) =>
        BOOLS.map((abortedAnimation): TapContext => ({ zone, hadSelection, controlsVisible, abortedAnimation, family })),
      ),
    ),
  ),
);

/** 参照模型的翻页方向：照需求 5.2、5.3 直接列出，不借用 `tapAction`。MC 不翻页。 */
const MODEL_TURN: Readonly<Partial<Record<TapZone, TurnDirection>>> = {
  TL: "prev",
  TC: "prev",
  ML: "prev",
  BL: "prev",
  TR: "next",
  MR: "next",
  BC: "next",
  BR: "next",
};

/**
 * 参照模型（design Property 15）：不照搬优先级链逐条短路，而是把每种结果的成立条件展开成一条
 * 独立的布尔式。四条式子必须恰有一条成立（两两互斥、覆盖全部上下文），否则模型本身写错了。
 */
function expectedTapKind(ctx: TapContext): TapDecision["kind"] {
  const sel = ctx.hadSelection;
  const vis = ctx.controlsVisible;
  const ab = ctx.abortedAnimation;
  const mc = ctx.zone === "MC";
  const scroll = ctx.family === "scroll";
  const rules: [boolean, TapDecision["kind"]][] = [
    [sel || (mc && ab) || (!vis && !mc && scroll && ab), "none"],
    [!sel && !(mc && ab) && vis, "hide-controls"],
    [!sel && !vis && mc && !ab, "show-controls"],
    [!sel && !vis && !mc && !(scroll && ab), "turn"],
  ];
  const hits = rules.filter(([holds]) => holds).map(([, kind]) => kind);
  expect(hits).toHaveLength(1);
  return hits[0];
}

/** 对一个上下文核对 Property 15 的全部断言。 */
function checkTap(ctx: TapContext): void {
  const decision = resolveTap(ctx);
  const kind = expectedTapKind(ctx);
  if (kind === "turn") {
    expect(decision).toEqual({ kind: "turn", direction: MODEL_TURN[ctx.zone] });
  } else {
    expect(decision).toEqual({ kind });
  }

  if (decision.kind === "turn") {
    // 方向取自九宫格映射（需求 5.2、5.3）。
    expect(decision.direction).toBe(tapAction(ctx.zone));
    // 翻页只在控制栏隐藏时发生，且决策只有方向、不夹带任何控制栏动作（需求 5.9、5.11）。
    expect(ctx.controlsVisible).toBe(false);
    expect(Object.keys(decision).sort()).toEqual(["direction", "kind"]);
  }

  // MC 区按下时结束了动画：结果与控制栏是否可见无关，控制栏保持原状（需求 5.10）。
  if (ctx.zone === "MC" && ctx.abortedAnimation) {
    expect(resolveTap({ ...ctx, controlsVisible: !ctx.controlsVisible })).toEqual(decision);
  }
}

describe("resolveTap：Tap 决策优先级", () => {
  // Feature: reader-page-turn-modes, Property 15: Tap 决策优先级
  // **Validates: Requirements 5.8, 5.9, 5.10, 5.11**
  it("Feature: reader-page-turn-modes, Property 15: Tap 决策优先级——选区 > MC 且中断动画 > 控制栏可见 > MC 唤出 > 滚动族中断动画 > 按九宫格翻页", () => {
    fc.assert(fc.property(tapContextArb, checkTap), { numRuns: 300 });
  });

  // Feature: reader-page-turn-modes, Property 15: Tap 决策优先级
  // **Validates: Requirements 5.8, 5.9, 5.10, 5.11**
  it("Feature: reader-page-turn-modes, Property 15: Tap 决策优先级——穷举 144 种上下文与参照模型一致，四种结果都会出现", () => {
    expect(ALL_TAP_CONTEXTS).toHaveLength(144);
    for (const ctx of ALL_TAP_CONTEXTS) checkTap(ctx);
    const kinds = new Set(ALL_TAP_CONTEXTS.map((ctx) => resolveTap(ctx).kind));
    expect([...kinds].sort()).toEqual(["hide-controls", "none", "show-controls", "turn"]);
  });

  const ctx = (zone: TapZone, over: Partial<TapContext> = {}): TapContext => ({
    zone,
    hadSelection: false,
    controlsVisible: false,
    abortedAnimation: false,
    family: "paged",
    ...over,
  });

  it("控制栏可见时点 MC 结束动画：保持可见，不隐藏", () => {
    expect(resolveTap(ctx("MC", { controlsVisible: true, abortedAnimation: true }))).toEqual({ kind: "none" });
    expect(resolveTap(ctx("MC", { controlsVisible: true }))).toEqual({ kind: "hide-controls" });
  });

  it("按下时有选区：即使控制栏可见也什么都不做", () => {
    expect(resolveTap(ctx("MR", { hadSelection: true, controlsVisible: true }))).toEqual({ kind: "none" });
  });

  it("中断动画后点翻页区：分页族照常翻页，滚动族吞掉本次点击", () => {
    expect(resolveTap(ctx("MR", { abortedAnimation: true }))).toEqual({ kind: "turn", direction: "next" });
    expect(resolveTap(ctx("MR", { abortedAnimation: true, family: "scroll" }))).toEqual({ kind: "none" });
    expect(resolveTap(ctx("TC", { family: "scroll" }))).toEqual({ kind: "turn", direction: "prev" });
  });
});
