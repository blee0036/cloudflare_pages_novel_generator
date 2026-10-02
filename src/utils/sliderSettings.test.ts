import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  SLIDER_SPECS,
  SliderKey,
  SliderSpec,
  normalizeSliderSettings,
  normalizeSliderValue,
} from "./sliderSettings";

/*
 * 参照模型（design Property 1）：枚举全部网格点，取与 v 距离最近者，距离相等取较小者；
 * v 不是有限数时取 fallback。它不夹端点、不算网格下标，与被测函数的做法互相独立——越界的 v
 * 最近的网格点本来就是端点。
 *
 * "距离相等"的口径：
 * - 网格点取十进制网格点 `min + k·step` 最近的 JS 数（源码写 `1.85` 得到的那个数，也是被测函数
 *   返回、滑杆实际使用的值）。这里由定点整数拼出十进制串再 `Number()` 得到，不经浮点四则运算；
 * - 距离是 v 与网格数的精确实数差：把 double 换成以 2^-1074 为单位的 BigInt 再相减，不经浮点减法，
 *   所以平分判定本身没有舍入误差。
 *
 * 字号、字间距、版心宽度、缓存上限的网格点与正中（如 19.5、0.25、830、10.5）都能精确表示，
 * 上述口径就是字面意义上的"正中取小"。行高不同：网格数（如 1.8）与十进制正中（如 1.825）大多
 * 不能精确表示，"十进制写法在正中"不等于"JS 数在正中"——
 * - `1.825` 作为 JS 数是 1.82499999999999995559…，严格离 1.8 更近；`1.425` 是
 *   1.42500000000000004441…，严格离 1.45 更近；
 * - `2.225`、`2.475` 作为 JS 数恰与两侧网格数等距，按平分取小得 2.2、2.45；若改以精确十进制
 *   网格点量距离，它们比十进制正中大 1e-16 量级，会得出较大者。两种口径只在十进制正中 1 个
 *   可表示数以内有出入；本测试取 JS 数口径，因为返回值本身就是这些 JS 数。
 */

const SLIDER_KEYS: readonly SliderKey[] = [
  "fontSize",
  "lineHeight",
  "letterSpacing",
  "contentWidth",
  "cacheMaxBooks",
];

/** 定点位数：5 个规格都是 6 位以内的十进制小数。 */
const FIXED_DIGITS = 6;

/** 非负十进制字面量（`String(n)` 无指数记法）→ 按 FIXED_DIGITS 位定点的整数。 */
function toFixed(n: number): bigint {
  const [int, frac = ""] = String(n).split(".");
  if (!/^\d+$/.test(int) || !/^\d*$/.test(frac) || frac.length > FIXED_DIGITS) {
    throw new Error(`规格取值 ${n} 不是 ${FIXED_DIGITS} 位以内的非负十进制小数`);
  }
  return BigInt(int + frac.padEnd(FIXED_DIGITS, "0"));
}

/** 定点整数 → 该十进制数最近的 JS 数（`Number()` 对十进制串是正确舍入的）。 */
function fromFixed(g: bigint): number {
  const s = g.toString().padStart(FIXED_DIGITS + 1, "0");
  return Number(`${s.slice(0, -FIXED_DIGITS)}.${s.slice(-FIXED_DIGITS)}`);
}

const f64 = new DataView(new ArrayBuffer(8));

/**
 * 有限 double 的精确值乘以 2^1074（必为整数）。规格化数为 (2^52 + 尾数)·2^(e − 1075)，
 * 乘 2^1074 后是 (2^52 + 尾数)·2^(e − 1)；非规格化数为 尾数·2^−1074。
 */
function exactValue(x: number): bigint {
  f64.setFloat64(0, x);
  const bits = f64.getBigUint64(0);
  const expField = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & 0xfffffffffffffn;
  const magnitude =
    expField === 0 ? fraction : (fraction | (1n << 52n)) << BigInt(expField - 1);
  return bits >> 63n ? -magnitude : magnitude;
}

/** 从 x 起数 n 个相邻的可表示数（n 可为负；±0 视为同一个）。 */
function stepUlps(x: number, n: number): number {
  f64.setFloat64(0, x);
  const bits = f64.getBigUint64(0);
  const ordinal = (bits >> 63n ? -(bits & 0x7fffffffffffffffn) : bits) + BigInt(n);
  f64.setBigUint64(0, ordinal < 0n ? -ordinal | (1n << 63n) : ordinal);
  return f64.getFloat64(0);
}

const abs = (x: bigint): bigint => (x < 0n ? -x : x);

interface ReferenceGrid {
  /** 全部网格数，升序。 */
  readonly points: readonly number[];
  /** `points` 各项的 exactValue。 */
  readonly exact: readonly bigint[];
  /** 每对相邻网格点的十进制正中最近的 JS 数（如 830、1.825）。 */
  readonly midpoints: readonly number[];
}

function buildGrid(spec: SliderSpec): ReferenceGrid {
  const lo = toFixed(spec.min);
  const hi = toFixed(spec.max);
  const step = toFixed(spec.step);
  if (step <= 0n || hi < lo || (hi - lo) % step !== 0n) {
    throw new Error(`规格 ${JSON.stringify(spec)} 的区间不是步长的整数倍`);
  }
  const fixed: bigint[] = [];
  for (let g = lo; g <= hi; g += step) fixed.push(g);
  const midpoints = fixed.slice(1).map((g, i) => {
    const sum = fixed[i] + g;
    if (sum % 2n !== 0n) throw new Error("定点位数不足以表示网格正中");
    return fromFixed(sum / 2n);
  });
  const points = fixed.map(fromFixed);
  return { points, exact: points.map(exactValue), midpoints };
}

const GRIDS = Object.fromEntries(
  SLIDER_KEYS.map((key) => [key, buildGrid(SLIDER_SPECS[key])]),
) as Record<SliderKey, ReferenceGrid>;

/** 参照模型：枚举全部网格点取最近，平分取小（升序遍历、只在严格更近时替换）。 */
function referenceNormalize(key: SliderKey, raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return SLIDER_SPECS[key].fallback;
  const { points, exact } = GRIDS[key];
  const v = exactValue(raw);
  let best = 0;
  for (let i = 1; i < points.length; i++) {
    if (abs(v - exact[i]) < abs(v - exact[best])) best = i;
  }
  return points[best];
}

/** 某个规格下的任意输入：网格点、正中、二者附近、区间内外、非有限数与非数值。 */
function rawValue(key: SliderKey): fc.Arbitrary<unknown> {
  const spec = SLIDER_SPECS[key];
  const { points, midpoints } = GRIDS[key];
  const span = spec.max - spec.min;
  const gridIndex = fc.integer({ min: 0, max: points.length - 1 });
  const midIndex = fc.integer({ min: 0, max: midpoints.length - 1 });
  const ulps = fc.integer({ min: -3, max: 3 });
  return fc.oneof(
    gridIndex.map((i) => points[i]),
    midIndex.map((i) => midpoints[i]),
    // 十进制正中前后几个可表示数：行高的"JS 数恰在正中"就落在这里（如 2.225）
    fc.tuple(midIndex, ulps).map(([i, n]) => stepUlps(midpoints[i], n)),
    // 网格点前后几个可表示数（含 0 以下的非规格化负数）与半步以内的偏移
    fc.tuple(gridIndex, ulps).map(([i, n]) => stepUlps(points[i], n)),
    fc
      .tuple(gridIndex, fc.double({ min: -spec.step / 2, max: spec.step / 2, noNaN: true }))
      .map(([i, d]) => points[i] + d),
    // 区间内外的任意值（两端各外扩一个区间宽度）
    fc.double({ min: spec.min - span, max: spec.max + span, noNaN: true }),
    // 任意 double：含 NaN、±Infinity、-0 与极大极小值
    fc.double(),
    fc.constantFrom(Number.NaN, Infinity, -Infinity, -0, Number.MAX_VALUE, -Number.MIN_VALUE),
    // 非数值：数字串、bigint、包装对象、数组等都取 fallback
    gridIndex.map((i) => String(points[i])),
    fc.constantFrom<unknown>(null, undefined, true, false, 830n, [830], {}, Object(820)),
    fc.string(),
    fc.anything(),
  );
}

const keyAndValue = fc
  .constantFrom(...SLIDER_KEYS)
  .chain((key) => rawValue(key).map((raw) => [key, raw] as const));

describe("normalizeSliderValue", () => {
  // Feature: reader-defect-fixes, Property 1: 滑杆取值归一等于参照模型且幂等
  // **Validates: Requirements 6.3, 6.5**
  it("对 5 个规格与任意输入都等于参照模型（最近网格点、平分取小、非有限数取 fallback），且再归一一次不变", () => {
    fc.assert(
      fc.property(keyAndValue, ([key, raw]) => {
        const spec = SLIDER_SPECS[key];
        const out = normalizeSliderValue(spec, raw);
        expect(out).toBe(referenceNormalize(key, raw));
        expect(normalizeSliderValue(spec, out)).toBe(out);
      }),
      { numRuns: 100 },
    );
  });

  it("穷举：每个网格点归一后不变；每对相邻网格点的正中及其前后 3 个可表示数都与参照模型一致", () => {
    for (const key of SLIDER_KEYS) {
      const spec = SLIDER_SPECS[key];
      const { points, midpoints } = GRIDS[key];
      for (const g of points) expect(normalizeSliderValue(spec, g)).toBe(g);
      for (const m of midpoints) {
        for (let n = -3; n <= 3; n++) {
          const v = stepUlps(m, n);
          expect(normalizeSliderValue(spec, v)).toBe(referenceNormalize(key, v));
        }
      }
    }
  });

  it("正中取小、越界夹到端点、浮点尾差归到网格上", () => {
    const { fontSize, lineHeight, letterSpacing, contentWidth, cacheMaxBooks } = SLIDER_SPECS;
    expect(normalizeSliderValue(contentWidth, 830)).toBe(820);
    expect(normalizeSliderValue(contentWidth, 830.0000000000001)).toBe(840);
    expect(normalizeSliderValue(contentWidth, 1300)).toBe(1200);
    expect(normalizeSliderValue(contentWidth, 500)).toBe(600);
    expect(normalizeSliderValue(fontSize, 19.5)).toBe(19);
    expect(normalizeSliderValue(letterSpacing, 0.25)).toBe(0);
    expect(normalizeSliderValue(letterSpacing, 0.75)).toBe(0.5);
    expect(normalizeSliderValue(letterSpacing, -3)).toBe(0);
    expect(normalizeSliderValue(cacheMaxBooks, 10.5)).toBe(10);
    expect(normalizeSliderValue(cacheMaxBooks, 0)).toBe(1);
    expect(normalizeSliderValue(cacheMaxBooks, 51)).toBe(50);
    // 行高：口径见文件开头的说明
    expect(normalizeSliderValue(lineHeight, 1.4 + 9 * 0.05)).toBe(1.85); // 1.8500000000000003
    expect(normalizeSliderValue(lineHeight, 1.625)).toBe(1.6); // 可精确表示的正中
    expect(normalizeSliderValue(lineHeight, 1.825)).toBe(1.8);
    expect(normalizeSliderValue(lineHeight, 1.425)).toBe(1.45);
    expect(normalizeSliderValue(lineHeight, 2.225)).toBe(2.2);
    expect(normalizeSliderValue(lineHeight, 2.6)).toBe(2.5);
    expect(normalizeSliderValue(lineHeight, 1.3)).toBe(1.4);
  });

  it("不是有限数（缺失、字符串、null、NaN、±Infinity、bigint、包装对象）时取 fallback", () => {
    const spec = SLIDER_SPECS.contentWidth;
    for (const raw of [undefined, null, "830", "", true, NaN, Infinity, -Infinity, 830n, [830], {}, Object(830)]) {
      expect(normalizeSliderValue(spec, raw)).toBe(820);
    }
  });
});

describe("SLIDER_SPECS", () => {
  it("恰有 5 个滑杆规格，版心宽度为 600–1200、步长 20（6.3）", () => {
    expect(Object.keys(SLIDER_SPECS).sort()).toEqual([...SLIDER_KEYS].sort());
    const { min, max, step } = SLIDER_SPECS.contentWidth;
    expect({ min, max, step }).toEqual({ min: 600, max: 1200, step: 20 });
  });

  it("每个 fallback 都在各自的网格上", () => {
    for (const key of SLIDER_KEYS) {
      expect(GRIDS[key].points).toContain(SLIDER_SPECS[key].fallback);
    }
  });
});

describe("normalizeSliderSettings", () => {
  it("逐一归一 5 个滑杆字段，其余字段原样保留，不改入参", () => {
    const extra = { nested: true };
    const raw = {
      theme: "dark",
      fontFamily: "serif",
      extra,
      fontSize: "20",
      lineHeight: 1.825,
      letterSpacing: -3,
      contentWidth: 830,
      cacheMaxBooks: NaN,
    };
    const before = { ...raw };

    const out = normalizeSliderSettings(raw);

    expect(out).toEqual({
      theme: "dark",
      fontFamily: "serif",
      extra,
      fontSize: 19,
      lineHeight: 1.8,
      letterSpacing: 0,
      contentWidth: 820,
      cacheMaxBooks: 10,
    });
    expect(out.extra).toBe(extra);
    expect(raw).toEqual(before);
  });
});
