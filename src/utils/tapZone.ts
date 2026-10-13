/**
 * 九宫格判定与动作映射（design §5.4，需求 5.1–5.5）。
 *
 * 阅读视口按宽、高各以 33% / 66% 两条分界线切成 9 区。两个函数的签名都不含翻页模式：
 * 五种模式共用同一套映射（需求 5.5），模式相关的差异全部放在 `resolveTap`（design §5.5）。
 *
 * 与 Legado 的有意偏离：`setRect9x` 把 TR 的左边界写成 `width * 0.36`，这里统一按 0.33。
 */

/** 九宫格区域。首字母 T/M/B 为上中下，次字母 L/C/R 为左中右。 */
export type TapZone = "TL" | "TC" | "TR" | "ML" | "MC" | "MR" | "BL" | "BC" | "BR";

/** 区域对应的动作：上一页、下一页、唤出控制栏。 */
export type TapZoneAction = "prev" | "next" | "menu";

/** 第一条分界线（宽或高的比例）。 */
export const TAP_ZONE_SPLIT_1 = 0.33;

/** 第二条分界线（宽或高的比例）。 */
export const TAP_ZONE_SPLIT_2 = 0.66;

/**
 * 把坐标归入一个区域。坐标以阅读视口（`<main>` 的 `getBoundingClientRect()`）为参照。
 *
 * x 或 y 恰在分界线上时归右侧或下方：`x < 0.33W` → L，`x < 0.66W` → C，否则 R；纵向同理。
 */
export function tapZone(x: number, y: number, width: number, height: number): TapZone {
  const col = x < TAP_ZONE_SPLIT_1 * width ? "L" : x < TAP_ZONE_SPLIT_2 * width ? "C" : "R";
  const row = y < TAP_ZONE_SPLIT_1 * height ? "T" : y < TAP_ZONE_SPLIT_2 * height ? "M" : "B";
  return `${row}${col}`;
}

/** Legado `AppConfig` 的默认映射：TL/TC/ML/BL → prev，TR/MR/BC/BR → next，MC → menu。 */
const TAP_ACTIONS: Readonly<Record<TapZone, TapZoneAction>> = {
  TL: "prev",
  TC: "prev",
  TR: "next",
  ML: "prev",
  MC: "menu",
  MR: "next",
  BL: "prev",
  BC: "next",
  BR: "next",
};

/** 区域到动作的映射，与翻页模式无关（需求 5.2–5.5）。 */
export function tapAction(zone: TapZone): TapZoneAction {
  return TAP_ACTIONS[zone];
}
