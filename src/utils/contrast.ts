/**
 * 颜色对比度的纯函数（F-010；需求 12.3、12.4；design §11）。
 *
 * 只供 `palette.test.ts` 核对 `src/index.css` 的调色板使用，运行时代码不 import 本模块。
 *
 * 口径：
 *
 * - 颜色一律是不透明的 sRGB（gamma 编码）三通道，取值 0–255。`parseHex` 得到整数；
 *   `mixSrgb` 的结果**不取整**（浏览器按浮点保存 `color-mix()` 的结果，序列化为
 *   `color(srgb …)` 时也保留小数），其余函数都接受带小数的通道值。
 * - 相对亮度与对比度按 WCAG 2.1 的定义（1.4.3 / "relative luminance"），线性化阈值取
 *   规范原文的 0.03928，与 axe-core 的实现一致。对 8 位整数通道，0.03928 与 IEC 的
 *   0.04045 之间没有任何 `n / 255`，两者给出相同结果。
 */

/** sRGB 颜色，通道取值 0–255（可带小数）。 */
export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** HSL 表示：`h` 为色相，取值 [0, 360)；`s`、`l` 为饱和度与亮度，取值 [0, 1]。 */
export interface Hsl {
  readonly h: number;
  readonly s: number;
  readonly l: number;
}

/**
 * 解析 `#rrggbb` 或 `#rgb`（大小写不限，允许首尾空白）。
 *
 * 带透明度的 `#rgba` / `#rrggbbaa` 与其他写法一律抛 `SyntaxError`：调色板只用不透明色，
 * 对比度对半透明色没有定义（取决于下面叠的是什么）。
 */
export function parseHex(hex: string): Rgb {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) {
    throw new SyntaxError(`不是 #rgb 或 #rrggbb 形式的颜色：${JSON.stringify(hex)}`);
  }
  const digits = m[1];
  const full =
    digits.length === 3
      ? digits
          .split("")
          .map((d) => d + d)
          .join("")
      : digits;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

/** 单个 gamma 编码通道（0–255）→ 线性分量（0–1），WCAG 2.1 的分段公式。 */
function linearize(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.1 相对亮度，取值 [0, 1]：`0.2126 R + 0.7152 G + 0.0722 B`（R、G、B 为线性分量）。 */
export function relativeLuminance(color: Rgb): number {
  return 0.2126 * linearize(color.r) + 0.7152 * linearize(color.g) + 0.0722 * linearize(color.b);
}

/**
 * WCAG 2.1 对比度 `(L1 + 0.05) / (L2 + 0.05)`，L1 为两者中较亮的相对亮度。
 *
 * 结果在 [1, 21] 内，与参数顺序无关。
 */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * 与 CSS `color-mix(in srgb, A P%, B)` 相同的混合：在 gamma 编码的 sRGB 空间里逐通道线性插值，
 * 结果为 `A · p + B · (1 − p)`。
 *
 * `p` 是 **A 的权重，取值 [0, 1]**（CSS 里的 `P%` 除以 100）：`p = 1` 得 A，`p = 0` 得 B。
 * 两个输入都不透明，所以与 CSS 规范的预乘 alpha 步骤结果相同。结果不取整（见模块说明）。
 *
 * `p` 不是 [0, 1] 内的有限数时抛 `RangeError`。
 */
export function mixSrgb(a: Rgb, b: Rgb, p: number): Rgb {
  if (!Number.isFinite(p) || p < 0 || p > 1) {
    throw new RangeError(`mixSrgb 的权重应在 [0, 1] 内，实际为 ${p}`);
  }
  const q = 1 - p;
  return {
    r: a.r * p + b.r * q,
    g: a.g * p + b.g * q,
    b: a.b * p + b.b * q,
  };
}

/**
 * sRGB → HSL（CSS Color 4 的 HSL 定义）。
 *
 * 无彩色（三通道相等）时 `h = 0`、`s = 0`。`h` 落在 [0, 360) 内。
 */
export function toHsl(color: Rgb): Hsl {
  const r = color.r / 255;
  const g = color.g / 255;
  const b = color.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };

  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) {
    h = ((g - b) / d) % 6;
  } else if (max === g) {
    h = (b - r) / d + 2;
  } else {
    h = (r - g) / d + 4;
  }
  h *= 60;
  if (h < 0) h += 360;
  if (h >= 360) h -= 360;
  return { h, s, l };
}
