/**
 * 设置抽屉里 5 个滑杆的取值规格与归一（F-003；需求 6.3、6.5；design §5）。
 *
 * 归一的目的是让"滑杆位置 = 旁边显示的数值 = 实际生效的值"对**任何**存储内容都成立（D4）：
 * 受控 `<input type="range">` 会把不在 `[min, max]` 或不在步进网格上的 `value` 悄悄吸附到
 * 网格上，而显示文字与排版用的仍是原值，三者从此对不上。`getStoredSettings()` 读出设置后
 * 统一过一遍 `normalizeSliderSettings`，下游（排版、滑杆、`bookCache` 的淘汰计算）拿到的
 * 就都是网格上的值。
 *
 * 本模块不 import 任何东西，是刻意的：`cacheMaxBooks` 的三个数与 `utils/bookCache.ts` 的
 * `MIN_MAX_BOOKS` / `MAX_MAX_BOOKS` / `DEFAULT_MAX_BOOKS` 相同，但 bookCache 读设置要 import
 * `storage.ts`，而 `storage.ts` 要 import 本模块——这里再 import bookCache 就成环，先加载
 * bookCache 的入口（如 `bookCache.test.ts`）会在本模块求值 `SLIDER_SPECS` 时读到尚未初始化的
 * 常量。所以这里写字面量，由 `storage.test.ts` 的单测钉住两边一致（与 `storage.ts` 里
 * `DEFAULT_SETTINGS` 曾经的做法同一口径）。
 */

/** 归一的 5 个设置字段（Slider_Setting）。 */
export type SliderKey = "fontSize" | "lineHeight" | "letterSpacing" | "contentWidth" | "cacheMaxBooks";

/** 一个滑杆的取值区间、步长与默认值。`fallback` 必须落在网格上（单测断言）。 */
export interface SliderSpec {
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly fallback: number;
}

/**
 * 各滑杆的规格。`SettingDrawer` 的 `min` / `max` / `step` 与 `storage.ts` 的默认值都取自这里。
 *
 * 版心宽度的步长由 40 改为 20（D4）：默认值 820 不在旧网格 600 + 40k 上，而此前经滑杆可达的
 * 全部值都在新网格上，存量设置因此不需要迁移。
 */
export const SLIDER_SPECS: Readonly<Record<SliderKey, SliderSpec>> = {
  fontSize: { min: 14, max: 36, step: 1, fallback: 19 },
  lineHeight: { min: 1.4, max: 2.5, step: 0.05, fallback: 1.85 },
  letterSpacing: { min: 0, max: 4, step: 0.5, fallback: 1 },
  contentWidth: { min: 600, max: 1200, step: 20, fallback: 820 },
  // 与 bookCache.ts 的 MIN_MAX_BOOKS / MAX_MAX_BOOKS / DEFAULT_MAX_BOOKS 一致（见模块说明）
  cacheMaxBooks: { min: 1, max: 50, step: 1, fallback: 10 },
};

/** 十进制字面量的小数位数（`0.05` → 2，`20` → 0）。规格里都是短小数，不会出现指数记法。 */
function decimalsOf(n: number): number {
  const s = String(n);
  const dot = s.indexOf(".");
  return dot < 0 ? 0 : s.length - dot - 1;
}

/**
 * 第 k 个网格点 `min + k·step`，按规格的小数位数四舍五入，消除浮点尾差
 * （`1.4 + 9 × 0.05` 算出来是 `1.8500000000000003`，这里得到 `1.85`）。
 *
 * 位数取 `min` 与 `step` 中较多的那个：现有 5 项里 `min` 的位数都不多于 `step`，结果即
 * design §5 所说的"按步长的小数位数"（`lineHeight` 2 位、`letterSpacing` 1 位，其余 0 位）。
 * `Math.round(x · 10^d) / 10^d` 是两个可精确表示的整数相除，得到的正是该十进制数最近的
 * 浮点数，与源码里直接写 `1.85` 是同一个值。
 */
function gridPoint(spec: SliderSpec, k: number): number {
  const scale = 10 ** Math.max(decimalsOf(spec.min), decimalsOf(spec.step));
  return Math.round((spec.min + k * spec.step) * scale) / scale;
}

/**
 * 把任意值归一到规格的区间与网格上（需求 6.5）：
 *
 * - 不是有限数（缺失、字符串、`null`、`NaN`、`±Infinity`）→ `fallback`；
 * - 越界 → 夹到端点；
 * - 区间内不在网格上 → 取最近的网格点，两侧距离相等时取较小者。
 *
 * 网格下标 `k = (v − min) / step` 只用来圈出 `floor(k)`、`ceil(k)` 两个候选，"谁更近"按
 * 候选网格点（已四舍五入）与 v 的实际距离比较：k 本身带浮点误差，直接看它的小数部分是否
 * 过半，在正中附近可能与真实距离给出相反结论。候选下标夹在 `[0, 末格]` 内，`v = max` 时
 * `ceil(k)` 不会因尾差越出区间。
 *
 * 网格点归一后不变，所以本函数幂等。
 */
export function normalizeSliderValue(spec: SliderSpec, raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return spec.fallback;

  const v = Math.min(spec.max, Math.max(spec.min, raw));
  const last = Math.round((spec.max - spec.min) / spec.step);
  const k = (v - spec.min) / spec.step;
  const lo = gridPoint(spec, Math.min(last, Math.max(0, Math.floor(k))));
  const hi = gridPoint(spec, Math.min(last, Math.max(0, Math.ceil(k))));

  return Math.abs(hi - v) < Math.abs(v - lo) ? hi : lo;
}

/**
 * 把对象里的 5 个滑杆字段逐一归一，其余字段原样保留（返回新对象，不改入参）。
 *
 * 逐字段写出而不是遍历键：返回类型要求 5 个键全在，漏写一个编译器就会报错。
 */
export function normalizeSliderSettings<T extends Record<SliderKey, unknown>>(
  raw: T,
): T & Record<SliderKey, number> {
  return {
    ...raw,
    fontSize: normalizeSliderValue(SLIDER_SPECS.fontSize, raw.fontSize),
    lineHeight: normalizeSliderValue(SLIDER_SPECS.lineHeight, raw.lineHeight),
    letterSpacing: normalizeSliderValue(SLIDER_SPECS.letterSpacing, raw.letterSpacing),
    contentWidth: normalizeSliderValue(SLIDER_SPECS.contentWidth, raw.contentWidth),
    cacheMaxBooks: normalizeSliderValue(SLIDER_SPECS.cacheMaxBooks, raw.cacheMaxBooks),
  };
}
