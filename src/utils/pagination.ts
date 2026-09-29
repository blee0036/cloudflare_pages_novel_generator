/**
 * 书架列表的分批挂载算术（需求 5.8，差异表 B3）。
 *
 * 约束来自 B3："7000 本一次性挂载会卡死"。首屏只挂载 `PAGE_SIZE` 本，其余靠"继续加载"
 * 逐批追加。注意这跟 `listWindow.ts` 的窗口化不是一回事：窗口化按滚动位置来回换挂载区间
 * （目录抽屉那种定高长列表），书架卡片是不定高的响应式网格，量不到行高也就算不出区间，
 * 所以这里用**单调增长的前缀**——只加不减，已经挂上的卡片不会被回收，滚动过程中零重排。
 *
 * ## 为什么把状态记成"页数"而不是"已挂载条数"
 *
 * 页数是个纯粹的意图（"我按了几次继续加载"），条数是意图与当前结果集的乘积。搜索词一变，
 * 结果集长度跟着变，若直接存条数就得在每次筛选后重新钳一遍；存页数则把钳位集中到
 * `visibleCount` 一处，且天然与"换查询要回到首屏"这条规则对齐（调用方把页数重置回 1 即可）。
 *
 * 所有函数都对脏输入（`NaN`、负数、小数）做钳位：结果集长度来自筛选后的数组，页数来自
 * `useState`，两者都不该崩，但差一位的症状（少挂一本、按钮永不消失）类型检查一无所知。
 */

/**
 * 首屏与每批追加的条目数（需求 5.8 的"默认 50 本"）。
 *
 * 首批与追加批取同一个值：需求只规定了首屏批次，再为"第二批加载更多"另立一个常数只会
 * 多一个需要解释的数字。
 */
export const PAGE_SIZE = 50;

/** 把可能为脏值的计数钳成非负整数。非有限数视为 0。 */
function asCount(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

/**
 * 把页数钳成 ≥ 1 的整数。
 *
 * 下限是 1 而不是 0：书架任何时候都至少挂载首屏一批，"0 页"不是一个合法的显示状态。
 */
function asPages(pages: number): number {
  return Number.isFinite(pages) ? Math.max(1, Math.floor(pages)) : 1;
}

/**
 * 批大小的钳位。非法批大小（0、负数、`NaN`）返回 0，由调用方解释为"不分页"。
 *
 * 选择退化成"全部挂载"而不是回落到 `PAGE_SIZE`：批大小是显式传进来的参数，传坏了应该
 * 表现为列表变慢（可见、可查），而不是静默按另一个值分页，更不能是挂载 0 本的白屏。
 */
function asSize(pageSize: number): number {
  return Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : 0;
}

/**
 * 装完 `total` 条需要多少页。空列表算 1 页（就是那页空的首屏），使"页数 ≥ 1"的不变量
 * 在任何结果集上都成立。
 */
export function totalPages(total: number, pageSize: number = PAGE_SIZE): number {
  const size = asSize(pageSize);
  if (size === 0) return 1;
  return Math.max(1, Math.ceil(asCount(total) / size));
}

/**
 * 当前应挂载的条目数：`pages` 批，但不超过结果总数。
 *
 * 调用方拿它去 `slice(0, n)`，所以返回值必须落在 `[0, total]`。
 */
export function visibleCount(
  total: number,
  pages: number,
  pageSize: number = PAGE_SIZE,
): number {
  const count = asCount(total);
  const size = asSize(pageSize);
  if (size === 0) return count;
  return Math.min(count, asPages(pages) * size);
}

/** 还有没有没挂载的条目——"继续加载"入口的显示条件。 */
export function hasMore(
  total: number,
  pages: number,
  pageSize: number = PAGE_SIZE,
): boolean {
  return visibleCount(total, pages, pageSize) < asCount(total);
}

/** 尚未挂载的条目数，用于"还有 N 本"的文案。没有剩余时为 0。 */
export function remainingCount(
  total: number,
  pages: number,
  pageSize: number = PAGE_SIZE,
): number {
  const count = asCount(total);
  return count - visibleCount(total, pages, pageSize);
}

/**
 * 点一次"继续加载"之后的页数。
 *
 * 在 `totalPages` 处封顶，使页数不会因为连点而涨到与结果集毫无关系的数值——否则清掉搜索词
 * 换一个命中更多的查询时，"已加载全部"会凭空生效（页数虚高，`visibleCount` 直接顶到总数）。
 */
export function nextPageCount(
  total: number,
  pages: number,
  pageSize: number = PAGE_SIZE,
): number {
  return Math.min(totalPages(total, pageSize), asPages(pages) + 1);
}
