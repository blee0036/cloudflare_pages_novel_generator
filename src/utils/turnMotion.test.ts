import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { TurnDirection, TurnSource } from "../components/reader/types";
import { PAGE_ANIM, type PageAnim } from "./pageAnim";
import type { PagePos } from "./paginate";
import { simCorner } from "./simulationGeometry";
import {
  coverLayout,
  keyStart,
  releaseTarget,
  runTouch,
  settleTarget,
  slideLayout,
  tapStart,
  TURN_BASE_MS,
  turnBaseMs,
  turnDuration,
  type Pt,
  type TurnRun,
  type TurnState,
} from "./turnMotion";

// ───────────────────────────── 生成器 ─────────────────────────────

/** 视口宽或高：含小数，覆盖窄屏到超宽屏。 */
const extentArb = fc.double({ min: 1, max: 10_000, noNaN: true, noDefaultInfinity: true });

/** `[0, extent]` 内的坐标（含两端）。 */
function coordArb(extent: number): fc.Arbitrary<number> {
  return fc.double({ min: 0, max: extent, noNaN: true });
}

/** 视口内任意一点。 */
function pointArb(w: number, h: number): fc.Arbitrary<Pt> {
  return fc.record({ x: coordArb(w), y: coordArb(h) });
}

const directionArb = fc.constantFrom<TurnDirection>("prev", "next");

const pagePosArb: fc.Arbitrary<PagePos> = fc.record({
  chapterId: fc.integer({ min: 0, max: 10_000 }),
  page: fc.integer({ min: 0, max: 1_000 }),
});

/**
 * 覆盖、滑动的合法输入：NEXT 时 `touch.x ≤ start.x`，PREV 时 `touch.x ≥ start.x`（design Property 11）。
 *
 * 先取视口内两个横坐标再按方向排序；约五分之一的样本令二者相等，覆盖刚越阈即释放的零偏移。
 * 纵坐标彼此独立，验证释放不改 `touch.y`。卷起角恒为 `null`（`TurnState.corner` 的约定）。
 */
const horizontalArb = fc.tuple(extentArb, extentArb).chain(([w, h]) =>
  fc
    .record({
      anim: fc.constantFrom(PAGE_ANIM.cover, PAGE_ANIM.slide),
      direction: directionArb,
      cancel: fc.boolean(),
      a: coordArb(w),
      b: fc.oneof({ arbitrary: coordArb(w), weight: 4 }, { arbitrary: fc.constant(null), weight: 1 }),
      startY: coordArb(h),
      touchY: coordArb(h),
    })
    .map(({ anim, direction, cancel, a, b, startY, touchY }) => {
      const lo = Math.min(a, b ?? a);
      const hi = Math.max(a, b ?? a);
      const [startX, touchX] = direction === "next" ? [hi, lo] : [lo, hi];
      return {
        anim,
        direction,
        cancel,
        start: { x: startX, y: startY },
        touch: { x: touchX, y: touchY },
        w,
        h,
      };
    }),
);

/**
 * 仿真的输入：起点与触点取视口内任意一点。
 *
 * NEXT 的卷起角取右上角、右下角或缺失（缺失按右下角处理）；PREV 恒为右下角（需求 8.3），同样允许缺失。
 */
const simulationArb = fc.tuple(extentArb, extentArb).chain(([w, h]) =>
  directionArb.chain((direction) =>
    fc.record({
      direction: fc.constant(direction),
      cancel: fc.boolean(),
      start: pointArb(w, h),
      touch: pointArb(w, h),
      corner: fc.constantFrom<Pt | null>(
        ...(direction === "next" ? [null, { x: w, y: 0 }, { x: w, y: h }] : [null, { x: w, y: h }]),
      ),
      w: fc.constant(w),
      h: fc.constant(h),
    }),
  ),
);

/** 无动画的输入：方向、取消、起点、触点互不约束；`from`/`to` 是翻页前后的页。 */
const noAnimArb = fc.tuple(extentArb, extentArb).chain(([w, h]) =>
  fc.record({
    direction: directionArb,
    cancel: fc.boolean(),
    start: pointArb(w, h),
    touch: pointArb(w, h),
    from: pagePosArb,
    to: pagePosArb,
    base: fc.constantFrom(TURN_BASE_MS.gesture, TURN_BASE_MS.key),
    w: fc.constant(w),
    h: fc.constant(h),
  }),
);

/** 落定判定读取的三个字段：取消标记与翻页前后的页。 */
type SettleCore = Pick<TurnState, "cancel" | "from" | "to">;

/** 落定判定的输入：`from`、`to` 各自独立生成，内容可能相同，但恒为不同对象，便于按引用区分。 */
const settleCoreArb: fc.Arbitrary<SettleCore> = fc.record({
  cancel: fc.boolean(),
  from: pagePosArb,
  to: pagePosArb,
});

/** 分页翻页器实际使用的动画（滚动不走分页翻页器）。 */
const turnAnimArb = fc.constantFrom<PageAnim>(PAGE_ANIM.cover, PAGE_ANIM.slide, PAGE_ANIM.simulation, PAGE_ANIM.none);

const sourceArb = fc.constantFrom<TurnSource>("drag", "tap", "key", "wheel");

/** 线性插值：`a + (b − a)·p`，即 design §6.2 的动画推进式。 */
function lerp(a: Pt, b: Pt, p: number): Pt {
  return { x: a.x + (b.x - a.x) * p, y: a.y + (b.y - a.y) * p };
}

/**
 * 以给定的 `cancel`/`from`/`to` 生成翻页进行到任意一步的 `TurnState`（design Property 12）。
 *
 * 约一半样本仍在拖拽：`run = null`，触点取视口内任意一点。其余样本在动画中：动画段起点取视口内
 * 任意一点，终点与时长按翻页器的方式由 `releaseTarget`、`turnDuration` 算出，进度 `p ∈ [0, 1]`
 * 决定当前触点，两端覆盖动画刚开始与已到终点。其余字段（动画、方向、来源、起点、上一个触点、
 * 卷起角、视口尺寸）互不约束。
 */
function turnStateArb(core: SettleCore): fc.Arbitrary<TurnState> {
  return fc.tuple(extentArb, extentArb).chain(([w, h]) =>
    fc
      .record({
        anim: turnAnimArb,
        direction: directionArb,
        source: sourceArb,
        start: pointArb(w, h),
        last: pointArb(w, h),
        corner: fc.constantFrom<Pt | null>(null, { x: w, y: 0 }, { x: w, y: h }),
        dragTouch: pointArb(w, h),
        animation: fc.option(
          fc.record({
            from: pointArb(w, h),
            t0: fc.double({ min: 0, max: 1e7, noNaN: true }),
            p: fc.double({ min: 0, max: 1, noNaN: true }),
          }),
          { nil: null },
        ),
      })
      .map(({ dragTouch, animation, ...rest }): TurnState => {
        if (animation === null) return { ...rest, ...core, touch: dragTouch, run: null };
        const to = releaseTarget(rest.anim, rest.direction, core.cancel, rest.start, animation.from, rest.corner, w, h);
        const duration = turnDuration(
          turnBaseMs(rest.source),
          to.x - animation.from.x,
          to.y - animation.from.y,
          w,
          h,
        );
        return {
          ...rest,
          ...core,
          touch: lerp(animation.from, to, animation.p),
          run: { from: animation.from, to, t0: animation.t0, duration },
        };
      }),
  );
}

/**
 * 浮点意义下相等。
 *
 * 覆盖、滑动的终点按 Legado 原式计算（如 NEXT 取消的 `touch.x + w − min(w, w − start.x + touch.x)`），
 * 数学上恰为 `start.x`，浮点下会差几个 ulp。容差取坐标量级 `scale` 的 1e-9 倍，远小于 1 个设备像素。
 */
function expectNear(actual: number, expected: number, scale: number): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1e-9 * Math.max(1, scale));
}

// ───────────────────────────── Property 11 ─────────────────────────────

describe("releaseTarget", () => {
  // Feature: reader-page-turn-modes, Property 11: 释放终点
  // **Validates: Requirements 4.7, 4.8**
  it("Feature: reader-page-turn-modes, Property 11: 释放终点——覆盖与滑动：完成时相对起点偏移 NEXT 为 −w、PREV 为 +w，取消时为 0，纵坐标不变", () => {
    fc.assert(
      fc.property(horizontalArb, ({ anim, direction, cancel, start, touch, w, h }) => {
        const target = releaseTarget(anim, direction, cancel, start, touch, null, w, h);
        const expectedOffset = cancel ? 0 : direction === "next" ? -w : w;
        expectNear(target.x - start.x, expectedOffset, w);
        expect(target.y).toBe(touch.y);
      }),
      { numRuns: 300 },
    );
  });

  // Feature: reader-page-turn-modes, Property 11: 释放终点
  // **Validates: Requirements 8.9, 8.10**
  it("Feature: reader-page-turn-modes, Property 11: 释放终点——仿真：NEXT 完成移出左侧、取消回到卷起角；PREV 完成落到 (w, h)、取消移出左侧", () => {
    fc.assert(
      fc.property(simulationArb, ({ direction, cancel, start, touch, corner, w, h }) => {
        const target = releaseTarget(PAGE_ANIM.simulation, direction, cancel, start, touch, corner, w, h);
        // 缺失的卷起角按右下角处理
        const effectiveCorner = corner ?? { x: w, y: h };
        if (direction === "next") {
          if (cancel) {
            // 需求 8.10：卷起角回到原页角
            expect(target).toEqual(effectiveCorner);
          } else {
            // 需求 8.9：卷起角移出视口左侧；上角终点取 1 而不是 0（Legado 防止 mTouchY 变为 0）
            expect(target).toEqual({ x: -w, y: effectiveCorner.y > 0 ? h : 1 });
          }
        } else if (cancel) {
          // 需求 8.10：上一页重新卷起并移出视口左侧
          expect(target).toEqual({ x: -w, y: h });
        } else {
          // 需求 8.9：上一页完全展开，触点回到右下角
          expect(target).toEqual({ x: w, y: h });
        }
      }),
      { numRuns: 300 },
    );
  });

  // Feature: reader-page-turn-modes, Property 11: 释放终点
  // **Validates: Requirements 9.2**
  it("Feature: reader-page-turn-modes, Property 11: 释放终点——无动画：终点即触点、动画时长为 0，结果页只由 cancel 决定", () => {
    fc.assert(
      fc.property(noAnimArb, ({ direction, cancel, start, touch, from, to, base, w, h }) => {
        const target = releaseTarget(PAGE_ANIM.none, direction, cancel, start, touch, null, w, h);
        // 终点是触点的副本：零位移，不产生动画段
        expect(target).toEqual(touch);
        expect(target).not.toBe(touch);
        expect(turnDuration(base, target.x - touch.x, target.y - touch.y, w, h)).toBe(0);
        // 释放时当场落定：完成落到 to，取消回到 from
        expect(settleTarget({ cancel, from, to })).toBe(cancel ? from : to);
      }),
      { numRuns: 300 },
    );
  });
});

// ───────────────────────────── Property 12 ─────────────────────────────

describe("settleTarget", () => {
  // Feature: reader-page-turn-modes, Property 12: 落定
  // **Validates: Requirements 2.6, 4.9**
  it("Feature: reader-page-turn-modes, Property 12: 落定——拖拽中或动画任一进度落定，未取消落到 to、已取消回到 from，与进度无关", () => {
    fc.assert(
      fc.property(
        settleCoreArb.chain((core) =>
          fc.tuple(fc.constant(core), fc.array(turnStateArb(core), { minLength: 1, maxLength: 4 })),
        ),
        ([{ cancel, from, to }, turns]) => {
          // 同一组 cancel/from/to 下，进度各异的多个状态都落到同一页（同一对象，不是内容相等的另一页）
          const expected = cancel ? from : to;
          for (const turn of turns) {
            expect(settleTarget(turn)).toBe(expected);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

// ───────────────────────────── Property 13 ─────────────────────────────

/** Turn_Duration 的基准时长：任意正数，另有四分之一的样本取两种实际基准 300、100。 */
const baseArb = fc.oneof(
  { arbitrary: fc.constantFrom<number>(TURN_BASE_MS.gesture, TURN_BASE_MS.key), weight: 1 },
  { arbitrary: fc.double({ min: 1e-3, max: 1e4, noNaN: true }), weight: 3 },
);

/** 剩余位移的一个分量：正负皆可；约四分之一的样本为 0 或 −0，覆盖只走纵向分支的情形。 */
const deltaArb = fc.oneof(
  { arbitrary: fc.constantFrom(0, -0), weight: 1 },
  { arbitrary: fc.double({ min: -2e4, max: 2e4, noNaN: true }), weight: 3 },
);

/** 非零的位移大小，用于 `dx ≠ 0` 分支的单调性。 */
const magnitudeArb = fc.double({ min: 1e-6, max: 2e4, noNaN: true });

const signArb = fc.constantFrom(1, -1);

/** 整数视口宽度（`clientWidth` 恒为整数 CSS px）。 */
const integerExtentArb = fc.integer({ min: 1, max: 10_000 });

describe("turnDuration", () => {
  // Feature: reader-page-turn-modes, Property 13: Turn_Duration
  // **Validates: Requirements 4.7, 4.8, 10.12**
  it("Feature: reader-page-turn-modes, Property 13: Turn_Duration——dx ≠ 0 时为 base·|dx|/w，dx = 0 时为 base·|dy|/h，结果非负", () => {
    fc.assert(
      fc.property(baseArb, extentArb, extentArb, deltaArb, deltaArb, (base, w, h, dx, dy) => {
        const d = turnDuration(base, dx, dy, w, h);
        // 换一种运算顺序写期望值，避免与实现逐字相同；−0 与 0 同样走纵向分支
        const expected = dx !== 0 ? (Math.abs(dx) / w) * base : (Math.abs(dy) / h) * base;
        expect(Number.isFinite(d)).toBe(true);
        expect(d).toBeGreaterThanOrEqual(0);
        expectNear(d, expected, expected);
      }),
      { numRuns: 300 },
    );
  });

  // Feature: reader-page-turn-modes, Property 13: Turn_Duration
  // **Validates: Requirements 4.7, 4.8**
  it("Feature: reader-page-turn-modes, Property 13: Turn_Duration——在 |dx| 上单调不减", () => {
    fc.assert(
      fc.property(
        fc.record({
          base: baseArb,
          w: extentArb,
          h: extentArb,
          dy: deltaArb,
          m1: magnitudeArb,
          m2: magnitudeArb,
          s1: signArb,
          s2: signArb,
        }),
        ({ base, w, h, dy, m1, m2, s1, s2 }) => {
          const lo = Math.min(m1, m2);
          const hi = Math.max(m1, m2);
          // dx ≠ 0 分支：与 dx 的符号、dy 都无关，只随 |dx| 增大
          expect(turnDuration(base, s1 * lo, dy, w, h)).toBeLessThanOrEqual(turnDuration(base, s2 * hi, dy, w, h));
          // dx = 0 走纵向分支，只在没有纵向位移时可与 dx ≠ 0 比较：此时为 0，是最小值
          expect(turnDuration(base, 0, 0, w, h)).toBe(0);
          expect(turnDuration(base, 0, 0, w, h)).toBeLessThanOrEqual(turnDuration(base, s1 * lo, 0, w, h));
        },
      ),
      { numRuns: 300 },
    );
  });

  // Feature: reader-page-turn-modes, Property 13: Turn_Duration
  // **Validates: Requirements 4.7, 4.8, 5.6, 11.4**
  it("Feature: reader-page-turn-modes, Property 13: Turn_Duration——|dx| = w 时为 base（任意宽度下误差不超过浮点舍入）", () => {
    fc.assert(
      fc.property(baseArb, extentArb, extentArb, deltaArb, signArb, (base, w, h, dy, s) => {
        // base·w/w 在非整数宽度下可能差 1 ulp
        expectNear(turnDuration(base, s * w, dy, w, h), base, base);
      }),
      { numRuns: 300 },
    );
  });

  // Feature: reader-page-turn-modes, Property 13: Turn_Duration
  // **Validates: Requirements 4.7, 4.8, 5.6, 11.4**
  it("Feature: reader-page-turn-modes, Property 13: Turn_Duration——整数宽度下 |dx| = w 恰为基准：Tap 与拖拽 300ms，按键与滚轮 100ms", () => {
    fc.assert(
      fc.property(sourceArb, integerExtentArb, extentArb, deltaArb, signArb, (source, w, h, dy, s) => {
        const expected = source === "tap" || source === "drag" ? 300 : 100;
        expect(turnBaseMs(source)).toBe(expected);
        expect(turnDuration(turnBaseMs(source), s * w, dy, w, h)).toBe(expected);
      }),
      { numRuns: 300 },
    );
  });
});

describe("turnDuration 例子", () => {
  /** 手机竖屏、笔记本、桌面全屏三种常见视口。 */
  const viewports = [
    { w: 390, h: 844 },
    { w: 1280, h: 720 },
    { w: 1920, h: 1080 },
  ];

  /**
   * 按翻页器的路径算一次完成翻页的时长（design §6.3）：起点即初始触点，
   * 释放终点由 `releaseTarget` 给出，剩余位移交给 `turnDuration`。
   */
  function completedTurnMs(
    anim: PageAnim,
    direction: TurnDirection,
    source: TurnSource,
    start: Pt,
    corner: Pt | null,
    w: number,
    h: number,
  ): number {
    const to = releaseTarget(anim, direction, false, start, start, corner, w, h);
    return turnDuration(turnBaseMs(source), to.x - start.x, to.y - start.y, w, h);
  }

  // **Validates: Requirements 5.6**
  it("Tap 触发的覆盖与滑动翻页恰为 300ms", () => {
    for (const { w, h } of viewports) {
      for (const anim of [PAGE_ANIM.cover, PAGE_ANIM.slide]) {
        for (const tapY of [0.2 * h, 0.8 * h]) {
          expect(completedTurnMs(anim, "next", "tap", tapStart("next", tapY, w, h), null, w, h)).toBe(300);
          expect(completedTurnMs(anim, "prev", "tap", tapStart("prev", tapY, w, h), null, w, h)).toBe(300);
        }
      }
    }
  });

  // **Validates: Requirements 11.4**
  it("按键与滚轮触发的覆盖与滑动翻页恰为 100ms", () => {
    for (const { w, h } of viewports) {
      for (const anim of [PAGE_ANIM.cover, PAGE_ANIM.slide]) {
        for (const source of ["key", "wheel"] as const) {
          expect(completedTurnMs(anim, "next", source, keyStart("next", w, h), null, w, h)).toBe(100);
          expect(completedTurnMs(anim, "prev", source, keyStart("prev", w, h), null, w, h)).toBe(100);
        }
      }
    }
  });

  // **Validates: Requirements 5.6**
  it("仿真 Tap NEXT 为 570ms：从 0.9w 卷到 −w，剩余位移 1.9w（与 Legado 一致）", () => {
    for (const { w, h } of viewports) {
      // 上半区卷右上角、下半区卷右下角（需求 8.7），两种情形的水平位移相同
      for (const tapY of [0.2 * h, 0.8 * h]) {
        const start = tapStart("next", tapY, w, h);
        const corner = simCorner("next", start.y, w, h);
        expect(completedTurnMs(PAGE_ANIM.simulation, "next", "tap", start, corner, w, h)).toBe(570);
      }
    }
  });

  // **Validates: Requirements 10.12**
  it("滚动模式的翻页滚动按纵向位移与可见区高度计时", () => {
    // 可见区高 600：滚满一屏恰为基准时长，滚 450px 为四分之三
    expect(turnDuration(TURN_BASE_MS.gesture, 0, 600, 390, 600)).toBe(300);
    expect(turnDuration(TURN_BASE_MS.gesture, 0, -450, 390, 600)).toBe(225);
    expect(turnDuration(TURN_BASE_MS.key, 0, 600, 390, 600)).toBe(100);
    expect(turnDuration(TURN_BASE_MS.key, 0, -450, 390, 600)).toBe(75);
  });

  it("零位移为 0ms，翻页器当场落定", () => {
    expect(turnDuration(TURN_BASE_MS.gesture, 0, 0, 390, 844)).toBe(0);
    expect(turnDuration(TURN_BASE_MS.key, -0, -0, 390, 844)).toBe(0);
  });
});

// ───────────────────────────── 动画段插值 ─────────────────────────────
describe("runTouch", () => {
  // Tap 触发的覆盖 NEXT（w = 400）：起点 0.9w，终点 start.x − w，时长恰为 300ms（design §6.2、§6.3）
  const run: TurnRun = { from: { x: 360, y: 1 }, to: { x: -40, y: 1 }, t0: 1000, duration: 300 };

  it("起点之前夹在起点，不往反方向外推", () => {
    expect(runTouch(run, 990)).toEqual({ touch: { x: 360, y: 1 }, done: false });
    expect(runTouch(run, 1000)).toEqual({ touch: { x: 360, y: 1 }, done: false });
  });

  it("中途按时间线性插值", () => {
    expect(runTouch(run, 1150)).toEqual({ touch: { x: 160, y: 1 }, done: false });
    expect(runTouch(run, 1075).touch.x).toBeCloseTo(260, 9);
  });

  it("到点与超时都恰好落在终点并结束，返回的是副本", () => {
    for (const t of [1300, 5000]) {
      const r = runTouch(run, t);
      expect(r).toEqual({ touch: { x: -40, y: 1 }, done: true });
      expect(r.touch).not.toBe(run.to);
    }
  });

  it("仿真段两个分量一起插值", () => {
    const sim: TurnRun = { from: { x: 360, y: 540 }, to: { x: -400, y: 600 }, t0: 0, duration: 570 };
    const { touch, done } = runTouch(sim, 285);
    expect(done).toBe(false);
    expect(touch.x).toBeCloseTo(-20, 9);
    expect(touch.y).toBeCloseTo(570, 9);
  });

  it("时长不是正的有限数时直接结束，不产生 NaN", () => {
    for (const duration of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(runTouch({ ...run, duration }, 1000)).toEqual({ touch: { x: -40, y: 1 }, done: true });
    }
  });
});

// ───────────────────────────── Property 16 ─────────────────────────────

/**
 * 与方向一致的偏移（`offset = touch.x − start.x`）：NEXT 取 `[−w, 0]`，PREV 取 `[0, w]`（design Property 16）。
 *
 * 约五分之一的样本取两端 `±w` 与 `0`、`−0`：零偏移是阴影有无的分界（需求 6.3），`−0` 在两个方向下
 * 都不算矛盾，按 0 处理。
 */
function coverOffsetArb(direction: TurnDirection, w: number): fc.Arbitrary<number> {
  const [min, max] = direction === "next" ? [-w, 0] : [0, w];
  return fc.oneof(
    { arbitrary: fc.constantFrom(direction === "next" ? -w : w, 0, -0), weight: 1 },
    { arbitrary: fc.double({ min, max, noNaN: true }), weight: 4 },
  );
}

/** 一次拖拽中连续若干帧的偏移，方向与视口宽度固定。 */
const coverFramesArb = fc.tuple(extentArb, directionArb).chain(([w, direction]) =>
  fc.record({
    w: fc.constant(w),
    direction: fc.constant(direction),
    offsets: fc.array(coverOffsetArb(direction, w), { minLength: 1, maxLength: 6 }),
  }),
);

/**
 * 方向与偏移符号矛盾：NEXT 时向右（`offset > 0`）、PREV 时向左（`offset < 0`）。
 * 幅度从最小正次正规数到超出最宽视口，覆盖刚越过起点一点点与远远越过两种情形。
 */
const contradictingCoverArb = fc
  .record({
    w: extentArb,
    direction: directionArb,
    magnitude: fc.oneof(
      { arbitrary: fc.constant(Number.MIN_VALUE), weight: 1 },
      { arbitrary: fc.double({ min: Number.MIN_VALUE, max: 2e4, noNaN: true }), weight: 4 },
    ),
  })
  .map(({ w, direction, magnitude }) => ({ w, direction, offset: direction === "next" ? magnitude : -magnitude }));

describe("coverLayout", () => {
  // Feature: reader-page-turn-modes, Property 16: 覆盖布局
  // **Validates: Requirements 6.1, 6.2, 6.3**
  it("Feature: reader-page-turn-modes, Property 16: 覆盖布局——NEXT 下一页静止、当前页移到 offset；PREV 当前页静止、上一页移到 offset − w；阴影贴着移动页右缘，offset = 0 时不画", () => {
    fc.assert(
      fc.property(coverFramesArb, ({ w, direction, offsets }) => {
        for (const offset of offsets) {
          const layout = coverLayout(direction, offset, w);
          expect(layout).not.toBeNull();
          if (layout === null) return;
          if (direction === "next") {
            // 需求 6.1：当前页向左移出，下一页静止在下方
            expect(layout.under).toBe("next");
            expect(layout.moving).toBe("cur");
            expect(layout.movingX).toBe(offset);
          } else {
            // 需求 6.2：上一页从左侧进入，覆盖在静止的当前页之上
            expect(layout.under).toBe("cur");
            expect(layout.moving).toBe("prev");
            expect(layout.movingX).toBe(offset - w);
          }
          if (offset === 0) {
            // 需求 6.3：偏移为 0（含 −0）时不画阴影
            expect(layout.shadowX).toBeNull();
          } else {
            // 需求 6.3：阴影左缘 NEXT 为 offset + w、PREV 为 offset，都恰在移动页右缘外侧
            expect(layout.shadowX).toBe(direction === "next" ? offset + w : offset);
            expectNear(layout.shadowX ?? Number.NaN, layout.movingX + w, w);
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  // Feature: reader-page-turn-modes, Property 16: 覆盖布局
  // **Validates: Requirements 4.4**
  it("Feature: reader-page-turn-modes, Property 16: 覆盖布局——拖拽逐帧：图层分工不变，移动页位移与指针位移相同", () => {
    fc.assert(
      fc.property(coverFramesArb, ({ w, direction, offsets }) => {
        const layouts = offsets.map((offset) => coverLayout(direction, offset, w));
        const [first] = layouts;
        for (let i = 0; i < layouts.length; i++) {
          const layout = layouts[i];
          expect(layout).not.toBeNull();
          if (layout === null || first === null) return;
          // 同一次拖拽中静止层与移动层不互换
          expect(layout.under).toBe(first.under);
          expect(layout.moving).toBe(first.moving);
          // 移动页跟手：相对首帧的平移等于指针相对首帧的水平位移
          expectNear(layout.movingX - first.movingX, offsets[i] - offsets[0], w);
        }
      }),
      { numRuns: 300 },
    );
  });

  // Feature: reader-page-turn-modes, Property 16: 覆盖布局
  // **Validates: Requirements 4.4, 6.1, 6.2**
  it("Feature: reader-page-turn-modes, Property 16: 覆盖布局——方向与偏移符号矛盾时返回 null", () => {
    fc.assert(
      fc.property(contradictingCoverArb, ({ w, direction, offset }) => {
        expect(coverLayout(direction, offset, w)).toBeNull();
      }),
      { numRuns: 300 },
    );
  });
});

// ───────────────────────────── Property 17 ─────────────────────────────

/*
 * 滑动与覆盖的偏移定义域相同（`offset = touch.x − start.x`，NEXT 取 `[−w, 0]`、PREV 取 `[0, w]`），
 * 矛盾判定也相同（design §6.5），所以直接复用 Property 16 的 `coverFramesArb` 与 `contradictingCoverArb`。
 */

describe("slideLayout", () => {
  // Feature: reader-page-turn-modes, Property 17: 滑动布局
  // **Validates: Requirements 7.1, 7.2**
  it("Feature: reader-page-turn-modes, Property 17: 滑动布局——恰有两层：当前页在 offset，目标页与之相差恰好 w（NEXT 在右、PREV 在左），不含阴影", () => {
    fc.assert(
      fc.property(coverFramesArb, ({ w, direction, offsets }) => {
        for (const offset of offsets) {
          const layout = slideLayout(direction, offset, w);
          expect(layout).not.toBeNull();
          if (layout === null) return;
          // 需求 7.2：布局只有 layers 一个字段，每层只有 layer 与 x，没有任何阴影
          expect(Object.keys(layout)).toEqual(["layers"]);
          expect(layout.layers).toHaveLength(2);
          for (const l of layout.layers) expect(Object.keys(l).sort()).toEqual(["layer", "x"]);
          // layers 按从左到右排列：NEXT 时当前页在左，PREV 时当前页在右
          const [left, right] = layout.layers;
          const cur = direction === "next" ? left : right;
          const other = direction === "next" ? right : left;
          expect(cur.layer).toBe("cur");
          expect(cur.x).toBe(offset);
          if (direction === "next") {
            expect(other.layer).toBe("next");
            expect(other.x).toBe(offset + w);
          } else {
            expect(other.layer).toBe("prev");
            expect(other.x).toBe(offset - w);
          }
          // 需求 7.1：两层间距恰为 w，左层右缘与右层左缘对齐
          expectNear(right.x - left.x, w, w);
        }
      }),
      { numRuns: 300 },
    );
  });

  // Feature: reader-page-turn-modes, Property 17: 滑动布局
  // **Validates: Requirements 4.4, 7.1**
  it("Feature: reader-page-turn-modes, Property 17: 滑动布局——拖拽逐帧：两层分工与次序不变，各层位移都与指针位移相同", () => {
    fc.assert(
      fc.property(coverFramesArb, ({ w, direction, offsets }) => {
        const first = slideLayout(direction, offsets[0], w);
        expect(first).not.toBeNull();
        if (first === null) return;
        for (const offset of offsets) {
          const layout = slideLayout(direction, offset, w);
          expect(layout).not.toBeNull();
          if (layout === null) return;
          // 同一次拖拽中两层的身份与左右次序不变
          expect(layout.layers.map((l) => l.layer)).toEqual(first.layers.map((l) => l.layer));
          // 需求 4.4、7.1：两层同步跟手，相对首帧的平移都等于指针相对首帧的水平位移
          layout.layers.forEach((l, i) => {
            expectNear(l.x - first.layers[i].x, offset - offsets[0], w);
          });
        }
      }),
      { numRuns: 300 },
    );
  });

  // Feature: reader-page-turn-modes, Property 17: 滑动布局
  // **Validates: Requirements 4.4**
  it("Feature: reader-page-turn-modes, Property 17: 滑动布局——方向与偏移符号矛盾时返回 null", () => {
    fc.assert(
      fc.property(contradictingCoverArb, ({ w, direction, offset }) => {
        expect(slideLayout(direction, offset, w)).toBeNull();
      }),
      { numRuns: 300 },
    );
  });
});
