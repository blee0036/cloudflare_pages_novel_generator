import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { TurnDirection } from "../components/reader/types";
import {
  SIM_FLAT_EPS_PX,
  SIM_FRONT_SHADOW_PX,
  SIM_ZERO_DENOMINATOR,
  mirrorMatrix,
  pinTouchY,
  simCorner,
  simFrame,
  simGeometry,
  type SimGeometry,
} from "./simulationGeometry";
import { keyStart, tapStart, type Pt } from "./turnMotion";

/** 严格大于 v 的某个数（v > 0 时 `v · (1 + ε)` 至少比 v 高一个 ulp）。 */
function justAbove(v: number): number {
  return v * (1 + Number.EPSILON);
}

/** 严格小于 v 的某个数（v > 0 时 `v · (1 − ε)` 至少比 v 低一个 ulp）。 */
function justBelow(v: number): number {
  return v * (1 - Number.EPSILON);
}

/** 视口宽或高：含小数，覆盖远小于真实视口到超宽屏。 */
const extentArb = fc.double({ min: 0.01, max: 10_000, noNaN: true, noDefaultInfinity: true });

const directionArb = fc.constantFrom<TurnDirection>("next", "prev");

/**
 * `[0, h]` 内的纵坐标：一般取值，外加 h/3、h/2、2h/3 三条分界线及其两侧紧邻的数、0 与 h。
 * 分界线的写法与 design Property 18 的式子一致（`2h/3` 即 `(2 * h) / 3`）。
 */
function yArb(h: number): fc.Arbitrary<number> {
  const marks = [h / 3, h / 2, (2 * h) / 3];
  return fc.oneof(
    fc.double({ min: 0, max: h, noNaN: true }),
    fc.constantFrom(0, h, justBelow(h), ...marks, ...marks.map(justBelow), ...marks.map(justAbove)),
  );
}

const scenarioArb = fc
  .tuple(extentArb, extentArb)
  .chain(([w, h]) =>
    fc.record({
      w: fc.constant(w),
      h: fc.constant(h),
      direction: directionArb,
      y: yArb(h),
    }),
  );

/*
 * 参照模型（design Property 18）：先按 `y ≤ h/2` 分上下，再看是否落在中间带 `(h/3, 2h/3)`。
 * 被测函数是按区间逐段返回，这里拆成"哪一侧"与"是否在带内"两个独立判定再组合。
 */
function referenceCorner(direction: TurnDirection, y: number, w: number, h: number): Pt {
  const top = direction === "next" && y <= h / 2;
  return { x: w, y: top ? 0 : h };
}

function referencePin(direction: TurnDirection, y: number, h: number): number | null {
  if (direction === "prev") return h;
  const inBand = y > h / 3 && y < (2 * h) / 3;
  if (!inBand) return null;
  return y <= h / 2 ? 1 : h;
}

describe("simCorner / pinTouchY / Tap 与按键起点", () => {
  // Feature: reader-page-turn-modes, Property 18: 仿真选角与触点固定
  // **Validates: Requirements 8.1, 8.2, 8.3**
  it("Feature: reader-page-turn-modes, Property 18: 仿真选角与触点固定——卷起角恒在右侧且 y ≤ h/2 归上角，中间带的固定边恒为卷起角所在的水平边", () => {
    fc.assert(
      fc.property(scenarioArb, ({ w, h, direction, y }) => {
        const corner = simCorner(direction, y, w, h);
        const pin = pinTouchY(direction, y, h);

        // 需求 8.1、8.3：x 恒为 w；PREV 恒为右下角
        expect(corner.x).toBe(w);
        if (direction === "prev") expect(corner).toEqual({ x: w, y: h });
        expect(corner).toEqual(referenceCorner(direction, y, w, h));

        // 需求 8.2、8.3：中间带固定，其余不固定；PREV 恒固定到下边
        expect(pin).toBe(referencePin(direction, y, h));

        // 固定边与卷起角一致（1 视为上边）：包括 y 恰为 h/2 时都归上（design §0 偏离表）
        if (pin !== null) expect(pin).toBe(corner.y === 0 ? 1 : h);
      }),
      { numRuns: 300 },
    );
  });

  // Feature: reader-page-turn-modes, Property 18: 仿真选角与触点固定（Tap 与按键起点）
  // **Validates: Requirements 8.3, 8.7, 8.8**
  it("Feature: reader-page-turn-modes, Property 18: 仿真选角与触点固定——Tap 起点与 simCorner 选出的上下角一致，按键起点恒对应右下角", () => {
    fc.assert(
      fc.property(scenarioArb, ({ w, h, direction, y: tapY }) => {
        const tap = tapStart(direction, tapY, w, h);
        const key = keyStart(direction, w, h);

        if (direction === "next") {
          // 需求 8.7：下半区起点 y = 0.9h，上半区贴着上边 y = 1
          expect(tap).toEqual({ x: 0.9 * w, y: tapY > h / 2 ? 0.9 * h : 1 });
          // 用起点再选角，与用 Tap 位置选角是同一个角。`h ≥ 2` 才有 `1 ≤ h/2`；真实视口远高于 2px。
          if (h >= 2) {
            const byTap = simCorner("next", tapY, w, h);
            expect(simCorner("next", tap.y, w, h)).toEqual(byTap);
            expect(byTap.y === 0).toBe(tapY <= h / 2);
          }
          expect(key).toEqual({ x: 0.9 * w, y: h });
        } else {
          // 需求 8.3：PREV 从左下角起翻，卷起角为右下角
          expect(tap).toEqual({ x: 0, y: h });
          expect(key).toEqual({ x: 0, y: h });
          expect(simCorner("prev", tap.y, w, h)).toEqual({ x: w, y: h });
        }

        // 需求 8.8：按键与滚轮的起点恒对应右下角，且不落在中间带（不固定触点）
        expect(simCorner(direction, key.y, w, h)).toEqual({ x: w, y: h });
        if (direction === "next") expect(pinTouchY("next", key.y, h)).toBeNull();
      }),
      { numRuns: 300 },
    );
  });

  const W = 600;
  const H = 900;

  it("NEXT 的分界：h/3 与 2h/3 不固定，(h/3, h/2] 固定到上边，(h/2, 2h/3) 固定到下边", () => {
    expect(simCorner("next", 0, W, H)).toEqual({ x: W, y: 0 });
    expect(pinTouchY("next", 0, H)).toBeNull();
    expect(simCorner("next", 300, W, H)).toEqual({ x: W, y: 0 });
    expect(pinTouchY("next", 300, H)).toBeNull();
    expect(pinTouchY("next", 301, H)).toBe(1);
    // y 恰为 h/2：卷起角与固定边都归上（与 Legado 的整数除法不同）
    expect(simCorner("next", 450, W, H)).toEqual({ x: W, y: 0 });
    expect(pinTouchY("next", 450, H)).toBe(1);
    expect(simCorner("next", 451, W, H)).toEqual({ x: W, y: H });
    expect(pinTouchY("next", 451, H)).toBe(H);
    expect(simCorner("next", 600, W, H)).toEqual({ x: W, y: H });
    expect(pinTouchY("next", 600, H)).toBeNull();
    expect(simCorner("next", H, W, H)).toEqual({ x: W, y: H });
    expect(pinTouchY("next", H, H)).toBeNull();
  });

  it("PREV 不论按下点在哪，都以右下角卷起并固定到下边", () => {
    for (const y of [0, 300, 450, 600, H]) {
      expect(simCorner("prev", y, W, H)).toEqual({ x: W, y: H });
      expect(pinTouchY("prev", y, H)).toBe(H);
    }
  });

  it("Tap 与按键起点的具体取值", () => {
    expect(tapStart("next", 450, W, H)).toEqual({ x: 0.9 * W, y: 1 });
    expect(tapStart("next", 451, W, H)).toEqual({ x: 0.9 * W, y: 0.9 * H });
    expect(tapStart("prev", 100, W, H)).toEqual({ x: 0, y: H });
    expect(keyStart("next", W, H)).toEqual({ x: 0.9 * W, y: H });
    expect(keyStart("prev", W, H)).toEqual({ x: 0, y: H });
  });
});

/* ------------------------------------------------------------------ */
/* Property 19：仿真几何                                                */
/* ------------------------------------------------------------------ */

/** 页面尺寸：多数取真实视口量级，另有 1/4 取 `extentArb` 的全范围（含远小于 1px 的极端值）。 */
const pageExtentArb = fc.oneof(
  { arbitrary: fc.double({ min: 200, max: 5000, noNaN: true }), weight: 3 },
  { arbitrary: extentArb, weight: 1 },
);

/** 页面四角之一（design Property 19 的"任意卷起角"）；实际用到的是右上、右下两个。 */
function cornerArb(w: number, h: number): fc.Arbitrary<Pt> {
  return fc.constantFrom<Pt>({ x: w, y: 0 }, { x: w, y: h }, { x: 0, y: 0 }, { x: 0, y: h });
}

/**
 * 贴近卷起角的触点：两个方向各偏移不超过 2px，含恰为 0、±1 的偏移，横坐标夹到 `[−w, w]`。
 * 覆盖"距卷起角不足 1px"、`corner.x − middle.x = 0`（control1 发散）与 `corner.y − middle.y = 0`
 * （0.1 分母）等退化分支。
 */
function nearCornerTouchArb(corner: Pt, w: number): fc.Arbitrary<Pt> {
  const offset = fc.oneof(
    fc.double({ min: -2, max: 2, noNaN: true }),
    fc.constantFrom(0, 1, -1),
  );
  return fc.record({ ox: offset, oy: offset }).map(({ ox, oy }) => ({
    x: Math.min(w, Math.max(-w, corner.x + ox)),
    y: corner.y + oy,
  }));
}

/**
 * 一般触点：横坐标在 `[−w, w]` 内（Property 19 的前提），纵坐标在页面及其上下各半页内；
 * 另取页边、页中与中间带的固定边（`pinTouchY` 的 1 与 h）等特殊值。
 */
function generalTouchArb(corner: Pt, w: number, h: number): fc.Arbitrary<Pt> {
  const x = fc.oneof(
    { arbitrary: fc.double({ min: -w, max: w, noNaN: true }), weight: 4 },
    { arbitrary: fc.constantFrom(-w, 0, w / 2, w), weight: 1 },
  );
  const y = fc.oneof(
    { arbitrary: fc.double({ min: -h / 2, max: 1.5 * h, noNaN: true }), weight: 3 },
    { arbitrary: fc.constantFrom(1, h, 0, corner.y, h / 2), weight: 1 },
  );
  return fc.record({ x, y });
}

/** 触点：10% 贴近卷起角，其余为一般触点。 */
function touchArb(corner: Pt, w: number, h: number): fc.Arbitrary<Pt> {
  return fc.oneof(
    { arbitrary: nearCornerTouchArb(corner, w), weight: 1 },
    { arbitrary: generalTouchArb(corner, w, h), weight: 9 },
  );
}

/** 检验"保持距离"用的任意点，取在页面及其外扩一倍的范围内。 */
function probeArb(w: number, h: number): fc.Arbitrary<Pt> {
  return fc.record({
    x: fc.double({ min: -w, max: 2 * w, noNaN: true }),
    y: fc.double({ min: -h, max: 2 * h, noNaN: true }),
  });
}

const geometryScenarioArb = fc
  .tuple(pageExtentArb, pageExtentArb)
  .chain(([w, h]) =>
    cornerArb(w, h).chain((corner) =>
      fc.record({
        w: fc.constant(w),
        h: fc.constant(h),
        corner: fc.constant(corner),
        touch: touchArb(corner, w, h),
        probes: fc.tuple(probeArb(w, h), probeArb(w, h)),
      }),
    ),
  );

type Affine = [number, number, number, number, number, number];

/** CSS `matrix(a, b, c, d, e, f)`：`(x, y) → (a·x + c·y + e, b·x + d·y + f)`。 */
function applyAffine([a, b, c, d, e, f]: Affine, p: Pt): Pt {
  return { x: a * p.x + c * p.y + e, y: b * p.x + d * p.y + f };
}

function geometryPoints(g: SimGeometry): Pt[] {
  return [g.touch, g.start1, g.control1, g.vertex1, g.end1, g.start2, g.control2, g.vertex2, g.end2];
}

/** `vertex = (start + 2·control + end) / 4`，误差按参与运算的量级取相对值。 */
function expectBezierMid(vertex: Pt, start: Pt, control: Pt, end: Pt): void {
  for (const k of ["x", "y"] as const) {
    const expected = (start[k] + 2 * control[k] + end[k]) / 4;
    const scale = Math.abs(start[k]) + 2 * Math.abs(control[k]) + Math.abs(end[k]);
    expect(Math.abs(vertex[k] - expected)).toBeLessThanOrEqual(1e-12 * scale);
  }
}

describe("simGeometry / mirrorMatrix / simFrame", () => {
  // Feature: reader-page-turn-modes, Property 19: 仿真几何
  // **Validates: Requirements 8.4, 8.5, 8.6**
  it("Feature: reader-page-turn-modes, Property 19: 仿真几何——结果为 null 或全部有限；书脊端点不越出页边，顶点为贝塞尔中点，镜像把卷起角映到触点且为等距对合，阴影条宽度符合规定", () => {
    fc.assert(
      fc.property(geometryScenarioArb, ({ w, h, corner, touch, probes }) => {
        const g = simGeometry(touch, corner, w, h);

        // 退化分支：距卷起角不足 1px 视为平整（design §6.6）
        if (Math.hypot(corner.x - touch.x, corner.y - touch.y) < SIM_FLAT_EPS_PX) {
          expect(g).toBeNull();
          return;
        }
        if (g === null) return;

        // 全部坐标有限
        for (const p of geometryPoints(g)) {
          expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
        }
        expect(Number.isFinite(g.touchToCorner)).toBe(true);
        expect(Number.isFinite(g.degrees)).toBe(true);

        // 需求 8.4：触点在页内时，书脊端点回拉后 start1 落在页内
        if (touch.x > 0 && touch.x < w) {
          expect(g.start1.x).toBeGreaterThanOrEqual(-1e-6);
          expect(g.start1.x).toBeLessThanOrEqual(w + 1e-6);
        }

        // 需求 8.4：顶点是二次贝塞尔曲线 t = 0.5 处的点
        expectBezierMid(g.vertex1, g.start1, g.control1, g.end1);
        expectBezierMid(g.vertex2, g.start2, g.control2, g.end2);

        // 需求 8.5：背面是沿折线的镜像
        const tol = 1e-6 * Math.max(w, h);
        const m = mirrorMatrix(g, corner);
        expect(m.every(Number.isFinite)).toBe(true);
        const image = applyAffine(m, corner);
        expect(Math.abs(image.x - g.touch.x)).toBeLessThanOrEqual(tol);
        expect(Math.abs(image.y - g.touch.y)).toBeLessThanOrEqual(tol);

        // M² = I：线性部分为单位阵，且任意点映两次回到原处
        const [a, b, c, d] = m;
        expect(Math.abs(a * a + c * b - 1)).toBeLessThanOrEqual(1e-9);
        expect(Math.abs(a * c + c * d)).toBeLessThanOrEqual(1e-9);
        expect(Math.abs(b * a + d * b)).toBeLessThanOrEqual(1e-9);
        expect(Math.abs(b * c + d * d - 1)).toBeLessThanOrEqual(1e-9);
        for (const p of [corner, g.touch, ...probes]) {
          const back = applyAffine(m, applyAffine(m, p));
          expect(Math.abs(back.x - p.x)).toBeLessThanOrEqual(tol);
          expect(Math.abs(back.y - p.y)).toBeLessThanOrEqual(tol);
        }

        // 保持距离
        const [p1, p2] = probes;
        const q1 = applyAffine(m, p1);
        const q2 = applyAffine(m, p2);
        expect(
          Math.abs(Math.hypot(q1.x - q2.x, q1.y - q2.y) - Math.hypot(p1.x - p2.x, p1.y - p2.y)),
        ).toBeLessThanOrEqual(tol);

        // 需求 8.5、8.6：各渐变条宽度；路径与矩阵字符串不含 NaN / Infinity
        const frame = simFrame(g, w, h);
        if (frame === null) return;
        expect(SIM_FRONT_SHADOW_PX).toBe(25);
        expect(frame.backShadow.width).toBe(g.touchToCorner / 4);
        expect(frame.frontShadow1.width).toBe(25);
        expect(frame.frontShadow2.height).toBe(25);
        const f1 = Math.abs(g.start1.x - g.control1.x) / 2;
        const f2 = Math.abs(g.start2.y - g.control2.y) / 2;
        expect(frame.foldShadow.width).toBe(Math.min(f1, f2));
        for (const s of [...Object.values(frame.clip), frame.mirror]) {
          expect(s).not.toMatch(/NaN|Infinity/);
        }
      }),
      { numRuns: 500 },
    );
  });
});

/* ------------------------------------------------------------------ */
/* 仿真几何的例子（需求 8.4、8.5）                                       */
/* ------------------------------------------------------------------ */

function expectPt(actual: Pt, expected: Pt, digits = 9): void {
  expect(actual.x).toBeCloseTo(expected.x, digits);
  expect(actual.y).toBeCloseTo(expected.y, digits);
}

function expectMatrix(actual: readonly number[], expected: readonly number[]): void {
  expect(actual).toHaveLength(6);
  // 逐项比较：反射矩阵的 0 项可能算出 −0，`toEqual` 会把它与 0 区分开
  expected.forEach((v, i) => expect(actual[i]).toBeCloseTo(v, 9));
}

describe("simGeometry / mirrorMatrix / simFrame 例子", () => {
  const W = 600;
  const H = 900;
  const BR: Pt = { x: W, y: H };
  const TR: Pt = { x: W, y: 0 };

  it("触点贴近卷起角（不足 1px）时返回 null，恰为 1px 时照常计算", () => {
    expect(simGeometry(BR, BR, W, H)).toBeNull();
    expect(simGeometry({ x: 599.5, y: 899.5 }, BR, W, H)).toBeNull(); // 约 0.71px
    expect(simGeometry({ x: 599.3, y: 900.7 }, BR, W, H)).toBeNull(); // 约 0.99px，触点在页外
    expect(simGeometry({ x: 599.2, y: 0.5 }, TR, W, H)).toBeNull(); // 约 0.94px，右上角

    const g = simGeometry({ x: 599, y: H }, BR, W, H);
    expect(g).not.toBeNull();
    expect(g?.touchToCorner).toBe(1);
  });

  it("书脊端点回拉后触点贴近卷起角，同样返回 null", () => {
    // 原触点距卷起角约 900px，但 start1.x ≈ −1214400 越出左边；回拉按比例 w / (w − start1.x) ≈ 4.9e-4
    // 把触点拉到距卷起角约 0.44px 处，视为平整。
    expect(simGeometry({ x: 599.5, y: 0 }, BR, W, H)).toBeNull();
  });

  it("corner.y − middle.y = 0 时 control2 取 0.1 分母（PREV 与按键翻页的常态）", () => {
    expect(SIM_ZERO_DENOMINATOR).toBe(0.1);

    // 触点与右下角同一水平线：middle = (500, 900)，corner − middle = (100, 0)。
    const g = simGeometry({ x: 400, y: H }, BR, W, H);
    expect(g).not.toBeNull();
    if (g === null) return;

    // control1 = (500 − 0² / 100, 900)；control2.y = 900 − 100² / 0.1 = −99100（Legado calcPoints）
    expectPt(g.control1, { x: 500, y: 900 });
    expectPt(g.control2, { x: 600, y: 900 - (100 * 100) / 0.1 }, 6);
    expectPt(g.control2, { x: 600, y: -99_100 }, 6);
    // start1.x = 500 − 100 / 2 = 450 落在页内，不回拉；start2.y = −99100 − (900 + 99100) / 2
    expectPt(g.touch, { x: 400, y: 900 });
    expectPt(g.start1, { x: 450, y: 900 });
    expectPt(g.start2, { x: 600, y: -149_100 }, 6);
    // end1：水平线 y = 900 与 start1start2 交于 start1；end2：斜率 −500 与 −1000 两线交于 (500, −49100)
    expectPt(g.end1, { x: 450, y: 900 });
    expectPt(g.end2, { x: 500, y: -49_100 }, 6);
    expectPt(g.vertex1, { x: 475, y: 900 });
    expectPt(g.vertex2, { x: 575, y: -99_100 }, 6);
    expect(g.touchToCorner).toBe(200);

    // 需求 8.5：0.1 分母只是近似，背面镜像仍是关于竖直折线 x = 500 的精确反射
    const m = mirrorMatrix(g, BR);
    expectMatrix(m, [-1, 0, 0, 1, 1000, 0]);
    expectPt(applyAffine(m, BR), g.touch);
  });

  it("书脊端点回拉的手算例：start1 越出左边时按比例回拉触点，start1 落到左边 x = 0", () => {
    // 回拉前：corner − touch = (300, 600)，middle = (450, 600)，
    // control1.x = 450 − 300² / 150 = −150，start1.x = −150 − 750 / 2 = −525 < 0。
    // 回拉（Legado calcPoints）：start1.x ← w − start1.x = 1125，f1 = 300，f2 = 600·300 / 1125 = 160，
    // touch.x = |600 − 160| = 440；f3 = 160·600 / 300 = 320，touch.y = |900 − 320| = 580。
    const g = simGeometry({ x: 300, y: 300 }, BR, W, H);
    expect(g).not.toBeNull();
    if (g === null) return;

    expectPt(g.touch, { x: 440, y: 580 });
    // 重算：middle = (520, 740)，control1.x = 520 − 160² / 80 = 200，control2.y = 740 − 80² / 160 = 700
    expectPt(g.control1, { x: 200, y: 900 });
    expectPt(g.control2, { x: 600, y: 700 });
    // start1.x = 200 − 400 / 2 = 0，恰在左边；start2.y = 700 − 200 / 2 = 600
    expectPt(g.start1, { x: 0, y: 900 });
    expectPt(g.start2, { x: 600, y: 600 });
    // end1：y − 900 = −4/3·(x − 200) 与 y = 900 − x/2 交于 (320, 740)
    // end2：y − 700 = 3/4·(x − 600) 与 y = 900 − x/2 交于 (520, 640)
    expectPt(g.end1, { x: 320, y: 740 });
    expectPt(g.end2, { x: 520, y: 640 });
    // vertex = (start + 2·control + end) / 4
    expectPt(g.vertex1, { x: 180, y: 860 });
    expectPt(g.vertex2, { x: 580, y: 660 });
    expect(g.touchToCorner).toBeCloseTo(160 * Math.sqrt(5), 9);
    // atan2(200 − 600, 700 − 900) = atan2(−400, −200)
    expect(g.degrees).toBeCloseTo(-180 + (Math.atan(2) * 180) / Math.PI, 9);
    expect(g.isRtOrLb).toBe(false);

    // 需求 8.5：折线是 (600, 900)–(440, 580) 的中垂线，u = (2, −1)/√5，
    // M = [[0.6, −0.8], [−0.8, −0.6]]，平移 = control1 − M·control1 = (800, 1600)
    const m = mirrorMatrix(g, BR);
    expectMatrix(m, [0.6, -0.8, -0.8, -0.6, 800, 1600]);
    expectPt(applyAffine(m, BR), { x: 440, y: 580 });

    // 需求 8.4：卷曲区域、露出的目标页与背面三条路径
    const frame = simFrame(g, W, H);
    expect(frame).not.toBeNull();
    if (frame === null) return;
    const curl =
      "M0.00 900.00 Q200.00 900.00 320.00 740.00 L440.00 580.00 " +
      "L520.00 640.00 Q600.00 700.00 600.00 600.00 L600.00 900.00 Z";
    expect(frame.clip.curl).toBe(`path("${curl}")`);
    expect(frame.clip.curlOutside).toBe(
      `path(evenodd, "M0 0 L600.00 0 L600.00 900.00 L0 900.00 Z ${curl}")`,
    );
    expect(frame.clip.reveal).toBe(
      'path("M0.00 900.00 L180.00 860.00 L580.00 660.00 L600.00 600.00 L600.00 900.00 Z")',
    );
    expect(frame.clip.back).toBe(
      'path("M580.00 660.00 L180.00 860.00 L320.00 740.00 L440.00 580.00 L520.00 640.00 Z")',
    );
  });

  it("simFrame 的路径与矩阵字符串不含 NaN：翻页起止点、0.1 分母、竖直求交与回拉等情形", () => {
    const cases: { name: string; corner: Pt; touch: Pt }[] = [
      { name: "Tap NEXT 下半区起点", corner: BR, touch: { x: 0.9 * W, y: 0.9 * H } },
      { name: "Tap NEXT 上半区起点", corner: TR, touch: { x: 0.9 * W, y: 1 } },
      { name: "按键 NEXT 起点（0.1 分母）", corner: BR, touch: { x: 0.9 * W, y: H } },
      { name: "NEXT 完成终点（右下）", corner: BR, touch: { x: -W, y: H } },
      { name: "NEXT 完成终点（右上）", corner: TR, touch: { x: -W, y: 1 } },
      { name: "PREV 起点（0.1 分母）", corner: BR, touch: { x: 0, y: H } },
      { name: "PREV 取消终点", corner: BR, touch: { x: -W, y: H } },
      // 触点在卷起角 45° 对角线上："触点—control1"是竖直线，Legado 的斜截式求交在此得到 NaN
      { name: "竖直求交", corner: BR, touch: { x: W - 300, y: H - 300 } },
      { name: "书脊端点回拉", corner: BR, touch: { x: 300, y: 300 } },
      { name: "右上角书脊端点回拉", corner: TR, touch: { x: 300, y: 600 } },
      { name: "触点在页面下方", corner: BR, touch: { x: 300, y: H + 200 } },
      { name: "触点在左边", corner: TR, touch: { x: 0, y: 450 } },
    ];

    for (const { name, corner, touch } of cases) {
      const g = simGeometry(touch, corner, W, H);
      expect(g, name).not.toBeNull();
      if (g === null) continue;
      const frame = simFrame(g, W, H);
      expect(frame, name).not.toBeNull();
      if (frame === null) continue;

      for (const s of [...Object.values(frame.clip), frame.mirror]) {
        expect(s, name).not.toMatch(/NaN|Infinity|undefined/);
      }
      for (const strip of [frame.backShadow, frame.frontShadow1, frame.frontShadow2, frame.foldShadow]) {
        const values = [strip.left, strip.top, strip.width, strip.height, strip.rotate, strip.originX, strip.originY];
        expect(values.every(Number.isFinite), name).toBe(true);
      }
    }

    // 竖直求交：end1 落在竖直线 x = 300 上（start1start2 斜率 −1，交于 y = 750）
    const vertical = simGeometry({ x: W - 300, y: H - 300 }, BR, W, H);
    expect(vertical).not.toBeNull();
    if (vertical !== null) {
      expectPt(vertical.end1, { x: 300, y: 750 });
      expectPt(vertical.end2, { x: 450, y: 600 });
    }
  });
});
