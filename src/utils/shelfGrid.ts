/**
 * 书架书卡网格的列数，以及"批量挂载数要能被列数整除"的对齐算术。
 *
 * ## 为什么要对齐
 *
 * 书架按批挂载书卡（`pagination.ts`）。批大小若不是列数的倍数，每一批的最后一行就会缺几张：
 * 四列网格挂 50 本是 12 行余 2，末行空着两个格子。读者看到的不是"还有更多"，而是"排版坏了"。
 *
 * ## 为什么对齐到所有列数的最小公倍数，而不是运行时量出当前列数
 *
 * 网格是响应式的（1 / 2 / 3 / 4 列），按当前列数现算批大小有两个毛病：
 * - 拖动窗口跨过断点时批大小跟着变，已挂载条数 = 页数 × 批大小也跟着变，列表会凭空多出或
 *   少掉几张卡；
 * - 需要 `matchMedia` 监听与对应的状态，纯算术变成了带副作用的 hook。
 *
 * 取所有列数的最小公倍数（1、2、3、4 → 12）作为对齐单位，批大小是它的整数倍，那么任何宽度、
 * 任何页数下已挂载条数都是整行。代价只是批大小不能随意取值（50 → 48），这在"首屏大约 50 本"
 * 的语义里无关紧要。
 *
 * 唯一无法对齐的是结果集的最后一批（书库总数、检索命中数本身不是整行）——那是数据决定的，
 * 不是排版问题。
 */

/**
 * 书卡网格的类名。书架页与骨架屏共用这一串，列数与 `SHELF_GRID_COLUMNS` 一一对应。
 *
 * 必须是完整的字面量：Tailwind 靠扫描源码里的类名字符串生成样式，拼接出来的类名它看不见。
 */
export const SHELF_GRID_CLASS =
  "grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6";

/**
 * `SHELF_GRID_CLASS` 在各断点下的列数。改网格时两处一起改，单测会核对两者一致。
 */
export const SHELF_GRID_COLUMNS: readonly number[] = [1, 2, 3, 4];

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/**
 * 一组列数的最小公倍数：批大小取它的倍数，所有列数下都是整行。
 * 非正、非整数的列数忽略；没有合法列数时返回 1（不对齐）。
 */
export function rowUnit(columns: readonly number[]): number {
  return columns
    .filter((c) => Number.isInteger(c) && c > 0)
    .reduce((acc, c) => (acc / gcd(acc, c)) * c, 1);
}

/**
 * 把期望的批大小对齐到 `columns` 的最小公倍数的整数倍，取离 `target` 最近的那个，至少一个单位。
 *
 * 例：目标 50、列数 1–4（单位 12）→ 48；目标 50、列数 1–5（单位 60）→ 60。
 */
export function alignToColumns(target: number, columns: readonly number[]): number {
  const unit = rowUnit(columns);
  const rows = Number.isFinite(target) ? Math.round(target / unit) : 1;
  return Math.max(1, rows) * unit;
}

/** 书架网格的对齐单位（当前为 12）。骨架屏的占位卡数也取它，保证骨架同样是整行。 */
export const SHELF_ROW_UNIT = rowUnit(SHELF_GRID_COLUMNS);
