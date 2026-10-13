/**
 * 翻页模式的编号、归一与派生判定（需求 1.1–1.3、9.3、9.5、9.6；design §2.1）。
 *
 * 编号与 Legado `constant/PageAnim.kt` 一致：覆盖 0、滑动 1、仿真 2、滚动 3、无动画 4。
 * 存进 `ReaderSettings.pageAnim` 的就是这个编号，渲染直接消费它（reader-consolidation
 * 需求 1.3：不得存在未被消费的开关）。
 *
 * 本模块只放纯函数与常量，不读 `matchMedia`、不调 `CSS.supports`：减弱动态效果与
 * `clip-path: path()` 支持度由调用方（`useReducedMotion`、翻页器）探测后作为参数传入，
 * 这样全部判定都能在 Node 上做属性测试。
 */

/** 五种翻页模式的编号（Page_Mode）。 */
export const PAGE_ANIM = { cover: 0, slide: 1, simulation: 2, scroll: 3, none: 4 } as const;

/** 合法的翻页模式编号：0–4。 */
export type PageAnim = (typeof PAGE_ANIM)[keyof typeof PAGE_ANIM];

/** 默认为滚动（D5）：旧存储里没有 `pageAnim`，浅合并后落到这里，老用户升级后仍是滚动阅读。 */
export const DEFAULT_PAGE_ANIM: PageAnim = PAGE_ANIM.scroll;

/**
 * 设置抽屉"翻页模式"选项组的按钮，按需求 1.3 的顺序：覆盖、滑动、仿真、滚动、无动画。
 *
 * 用数组而不是对象：按钮顺序就是这里的数组顺序，不依赖对象键的枚举顺序
 * （与 `theme.ts` 的 `READER_THEMES` 同一口径）。
 */
export const PAGE_ANIM_OPTIONS: readonly { value: PageAnim; label: string }[] = [
  { value: PAGE_ANIM.cover, label: "覆盖" },
  { value: PAGE_ANIM.slide, label: "滑动" },
  { value: PAGE_ANIM.simulation, label: "仿真" },
  { value: PAGE_ANIM.scroll, label: "滚动" },
  { value: PAGE_ANIM.none, label: "无动画" },
];

/**
 * 把任意存储值归一为合法编号（需求 1.2）。
 *
 * 只有 0–4 的整数原样返回；缺失、字符串 `"2"`、`2.5`、`NaN`、`-1`、`5` 等一律为 3。
 * 不做字符串到数字的宽松转换：`pageAnim` 只经 `onUpdateSettings` 以数字写入，
 * 出现字符串说明存储被外部改过，按"不认识"处理比猜测其含义更安全。
 */
export function normalizePageAnim(raw: unknown): PageAnim {
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= PAGE_ANIM.cover && raw <= PAGE_ANIM.none) {
    return raw as PageAnim;
  }
  return DEFAULT_PAGE_ANIM;
}

/** 渲染族：分页（0、1、2、4）由 `PagedReader` 呈现，滚动（3）由 `ScrollReader` 呈现。 */
export type RenderFamily = "paged" | "scroll";

/** 编号所属的渲染族。族内切换（如覆盖 → 仿真）不重挂视图（design §3.1）。 */
export function renderFamilyOf(anim: PageAnim): RenderFamily {
  return anim === PAGE_ANIM.scroll ? "scroll" : "paged";
}

/** 会播放水平翻页动画的模式：覆盖、滑动、仿真。 */
function isAnimatedPaged(anim: PageAnim): boolean {
  return anim === PAGE_ANIM.cover || anim === PAGE_ANIM.slide || anim === PAGE_ANIM.simulation;
}

/**
 * 一次翻页实际播放的动画（需求 9.3；design §6.8）。
 *
 * - `reduced` 为真时，覆盖、滑动、仿真都按无动画（4）翻页；
 * - 否则 `simulationSupported` 为假（不支持 `clip-path: path()`）时，仿真降级为覆盖（0）；
 * - 其余原样返回，滚动（3）与无动画（4）永远不变。
 *
 * 只返回本次要用的值，不改设置（需求 9.5）：设置抽屉仍标示读者所选的模式。
 */
export function effectiveTurnAnim(anim: PageAnim, reduced: boolean, simulationSupported: boolean): PageAnim {
  if (reduced && isAnimatedPaged(anim)) return PAGE_ANIM.none;
  if (anim === PAGE_ANIM.simulation && !simulationSupported) return PAGE_ANIM.cover;
  return anim;
}

/**
 * 设置抽屉是否显示"系统已开启减弱动态效果，翻页不播放动画"（需求 9.6）。
 *
 * 仅当减弱动态效果成立且所选模式本会播放动画（覆盖、滑动、仿真）时为真。
 * 滚动模式下 Tap 与按键的翻页滚动同样会变为瞬时（需求 9.4），但需求 9.6 只针对这三种模式。
 */
export function showsReducedMotionHint(anim: PageAnim, reduced: boolean): boolean {
  return reduced && isAnimatedPaged(anim);
}
