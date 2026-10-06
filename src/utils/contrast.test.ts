import { describe, expect, it } from "vitest";
import { contrastRatio, mixSrgb, parseHex, relativeLuminance, toHsl, type Rgb } from "./contrast";

/**
 * `src/utils/contrast.ts` 的示例测试（reader-defect-fixes 需求 12.4，任务 16.3）。
 *
 * 已知数值不从被测模块读取，而是按 WCAG 2.1 "relative luminance" 的定义独立推导：
 * 通道 c = n / 255，`c ≤ 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ^ 2.4`，
 * L = 0.2126 R + 0.7152 G + 0.0722 B，对比度 = (L1 + 0.05) / (L2 + 0.05)。
 * 其中 #767676 / 白 ≈ 4.54、#777777 / 白 ≈ 4.48、#595959 / 白 ≈ 7.00、纯蓝 / 白 ≈ 8.59
 * 是常被引用的参考值；表中保留到第 3 位小数。
 */

const WHITE: Rgb = { r: 255, g: 255, b: 255 };
const BLACK: Rgb = { r: 0, g: 0, b: 0 };

// ---------------------------------------------------------------------------
// parseHex
// ---------------------------------------------------------------------------

describe("parseHex", () => {
  it("解析 #rrggbb", () => {
    expect(parseHex("#ffffff")).toEqual(WHITE);
    expect(parseHex("#000000")).toEqual(BLACK);
    expect(parseHex("#3b82f6")).toEqual({ r: 59, g: 130, b: 246 });
  });

  it("#rgb 的每一位重复一次展开为 #rrggbb", () => {
    expect(parseHex("#abc")).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc });
    expect(parseHex("#fff")).toEqual(parseHex("#ffffff"));
    expect(parseHex("#000")).toEqual(BLACK);
  });

  it("大小写不限", () => {
    expect(parseHex("#AbCdEf")).toEqual({ r: 0xab, g: 0xcd, b: 0xef });
    expect(parseHex("#ABC")).toEqual(parseHex("#abc"));
  });

  it("允许首尾空白", () => {
    expect(parseHex("  #123456\n\t")).toEqual({ r: 0x12, g: 0x34, b: 0x56 });
  });

  it.each([
    ["#rgba", "#ffff"],
    ["#rrggbbaa", "#ffffffff"],
    ["rgb()", "rgb(0, 0, 0)"],
    ["缺少 #", "ffffff"],
    ["空串", ""],
    ["5 位", "#12345"],
    ["7 位", "#1234567"],
    ["非十六进制字符", "#ggg"],
    ["# 后有空白", "# fff"],
  ])("拒绝 %s（%j），抛 SyntaxError", (_label, input) => {
    expect(() => parseHex(input)).toThrow(SyntaxError);
  });
});

// ---------------------------------------------------------------------------
// relativeLuminance
// ---------------------------------------------------------------------------

describe("relativeLuminance", () => {
  it("白 = 1，黑 = 0", () => {
    expect(relativeLuminance(WHITE)).toBeCloseTo(1, 12);
    expect(relativeLuminance(BLACK)).toBe(0);
  });

  it("纯红、纯绿、纯蓝分别等于各自的系数", () => {
    expect(relativeLuminance(parseHex("#ff0000"))).toBeCloseTo(0.2126, 12);
    expect(relativeLuminance(parseHex("#00ff00"))).toBeCloseTo(0.7152, 12);
    expect(relativeLuminance(parseHex("#0000ff"))).toBeCloseTo(0.0722, 12);
  });

  it("已知灰与蓝的亮度", () => {
    expect(relativeLuminance(parseHex("#777777"))).toBeCloseTo(0.184475, 6);
    expect(relativeLuminance(parseHex("#3b82f6"))).toBeCloseTo(0.235489, 6);
  });

  it("通道 10（10/255 ≤ 0.03928）走线性段 c / 12.92", () => {
    const expected = 10 / 255 / 12.92;
    expect(relativeLuminance({ r: 10, g: 10, b: 10 })).toBeCloseTo(expected, 12);
  });
});

// ---------------------------------------------------------------------------
// contrastRatio
// ---------------------------------------------------------------------------

describe("contrastRatio", () => {
  it("白 / 黑 = 21:1，与参数顺序无关", () => {
    expect(contrastRatio(WHITE, BLACK)).toBeCloseTo(21, 10);
    expect(contrastRatio(BLACK, WHITE)).toBeCloseTo(21, 10);
  });

  it.each(["#ffffff", "#000000", "#777777", "#3b82f6", "#ff0000"])(
    "相同颜色 %s 的对比度为 1:1",
    (hex) => {
      const c = parseHex(hex);
      expect(contrastRatio(c, c)).toBe(1);
    },
  );

  it("带小数通道的相同颜色也为 1:1", () => {
    const c = mixSrgb(parseHex("#3b82f6"), WHITE, 0.37);
    expect(contrastRatio(c, c)).toBe(1);
  });

  it.each([
    ["#777777", "#ffffff", 4.478],
    ["#767676", "#ffffff", 4.542],
    ["#595959", "#ffffff", 7.005],
    ["#808080", "#ffffff", 3.949],
    ["#808080", "#000000", 5.317],
    ["#3b82f6", "#ffffff", 3.678],
    ["#0000ff", "#ffffff", 8.592],
    ["#ff0000", "#ffffff", 3.998],
    ["#ff0000", "#000000", 5.252],
  ] as const)("%s 对 %s ≈ %f:1（两种参数顺序）", (fg, bg, expected) => {
    const a = parseHex(fg);
    const b = parseHex(bg);
    expect(contrastRatio(a, b)).toBeCloseTo(expected, 3);
    expect(contrastRatio(b, a)).toBe(contrastRatio(a, b));
  });

  it("4.5:1 门槛两侧：#767676 对白达标，#777777 对白不达标", () => {
    expect(contrastRatio(parseHex("#767676"), WHITE)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(parseHex("#777777"), WHITE)).toBeLessThan(4.5);
  });
});

// ---------------------------------------------------------------------------
// mixSrgb
// ---------------------------------------------------------------------------

describe("mixSrgb", () => {
  const A = parseHex("#3b82f6");
  const B = parseHex("#fdf6e3");

  it("p = 1 得 A，p = 0 得 B", () => {
    expect(mixSrgb(A, B, 1)).toEqual(A);
    expect(mixSrgb(A, B, 0)).toEqual(B);
  });

  it("p = 0.5 得逐通道中点，结果不取整", () => {
    expect(mixSrgb(WHITE, BLACK, 0.5)).toEqual({ r: 127.5, g: 127.5, b: 127.5 });
    const mid = mixSrgb(A, B, 0.5);
    expect(mid.r).toBeCloseTo((A.r + B.r) / 2, 10);
    expect(mid.g).toBeCloseTo((A.g + B.g) / 2, 10);
    expect(mid.b).toBeCloseTo((A.b + B.b) / 2, 10);
  });

  it("p 是 A 的权重：color-mix(in srgb, #ffffff 20%, #000000) 的各通道为 51", () => {
    const m = mixSrgb(WHITE, BLACK, 0.2);
    expect(m.r).toBeCloseTo(51, 10);
    expect(m.g).toBeCloseTo(51, 10);
    expect(m.b).toBeCloseTo(51, 10);
  });

  it("红蓝按 0.3 混合：r = 76.5、g = 0、b = 178.5", () => {
    const m = mixSrgb(parseHex("#ff0000"), parseHex("#0000ff"), 0.3);
    expect(m.r).toBeCloseTo(76.5, 10);
    expect(m.g).toBe(0);
    expect(m.b).toBeCloseTo(178.5, 10);
  });

  it.each([-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "p = %f 不在 [0, 1] 内，抛 RangeError",
    (p) => {
      expect(() => mixSrgb(A, B, p)).toThrow(RangeError);
    },
  );
});

// ---------------------------------------------------------------------------
// toHsl
// ---------------------------------------------------------------------------

describe("toHsl", () => {
  it.each([
    ["#ff0000", 0],
    ["#ffff00", 60],
    ["#00ff00", 120],
    ["#00ffff", 180],
    ["#0000ff", 240],
    ["#ff00ff", 300],
  ] as const)("%s 的色相为 %i°，饱和度 1，亮度 0.5", (hex, hue) => {
    const { h, s, l } = toHsl(parseHex(hex));
    expect(h).toBeCloseTo(hue, 10);
    expect(s).toBeCloseTo(1, 12);
    expect(l).toBeCloseTo(0.5, 12);
  });

  it("灰、白、黑：h = 0，s = 0", () => {
    expect(toHsl(parseHex("#808080"))).toEqual({ h: 0, s: 0, l: 128 / 255 });
    expect(toHsl(WHITE)).toEqual({ h: 0, s: 0, l: 1 });
    expect(toHsl(BLACK)).toEqual({ h: 0, s: 0, l: 0 });
  });

  it("#3b82f6 ≈ hsl(217.2°, 91.2%, 59.8%)", () => {
    const { h, s, l } = toHsl(parseHex("#3b82f6"));
    expect(h).toBeCloseTo(217.219, 3);
    expect(s).toBeCloseTo(0.912195, 6);
    expect(l).toBeCloseTo(0.598039, 6);
  });

  it("色相略小于 360 的颜色落回 [0, 360)，不出现负值", () => {
    // #ff0001：max 为 R，(G − B) / d = −1/255，色相 = −60/255° → 加 360。
    const { h } = toHsl(parseHex("#ff0001"));
    expect(h).toBeCloseTo(360 - 60 / 255, 9);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(360);
  });
});
