/**
 * 定长行列表的窗口化原语（design §6.2，需求 3.2）。
 *
 * 不引虚拟列表库：章节列表的行高本来就是固定的，"可见区间 = scrollTop / 行高" 是一次
 * 除法就能算完的事，上下各垫一个 spacer 撑出总高度即可。把这点算术抽成纯函数而不是散在
 * 组件里，是为了让它能被直接测，也让任务 11（`BookDetailModal` 章节网格）复用同一套
 * 边界处理——网格只需把"行数"换成 `ceil(总数 / 每行列数)` 传进来。
 */

/**
 * 固定行高（px）。目录项必须单行截断以守住这个值：一旦出现可变行高，
 * `scrollTop → 行号` 的换算就不再成立。任务 38 的卷节点表头同样用这个行高。
 */
export const ROW_HEIGHT = 44;

/** 可见区上下各多渲染的行数，用于吸收滚动与重渲染之间的一帧延迟。 */
export const OVERSCAN = 8;

/**
 * 章节网格（`BookDetailModal`，需求 3.3）的单元高度（px）。
 * 与目录抽屉的 `ROW_HEIGHT` 分开取值：网格单元是带边框的卡片而非裸行。
 */
export const GRID_CELL_HEIGHT = 44;

/** 网格的行/列间距（px），对应 Tailwind 的 `gap-2`。 */
export const GRID_GAP = 8;

/**
 * 网格的**行距**：单元高度 + 行间距。窗口化算术里的"行高"指的是这个值，
 * 因为第 i 行的顶端落在 `i * GRID_ROW_PITCH`。
 */
export const GRID_ROW_PITCH = GRID_CELL_HEIGHT + GRID_GAP;

export interface WindowRange {
  /** 需要挂载的首行下标（含）。 */
  start: number;
  /** 需要挂载的末行下标（不含）。 */
  end: number;
}

/**
 * 求当前应挂载的行区间。
 *
 * `viewH` 为 0 时（首帧尚未测量）退化为只渲染 overscan 那几行——这不会影响滚动定位，
 * 因为容器总高度由 spacer 按 `total` 撑出，与实际挂载了多少行无关。
 */
export function computeWindow(
  scrollTop: number,
  viewH: number,
  total: number,
  row: number = ROW_HEIGHT,
  overscan: number = OVERSCAN,
): WindowRange {
  if (!(total > 0) || !(row > 0)) return { start: 0, end: 0 };

  const top = Math.max(0, scrollTop);
  const h = Math.max(0, viewH);

  const start = Math.min(total, Math.max(0, Math.floor(top / row) - overscan));
  const end = Math.min(total, Math.ceil((top + h) / row) + overscan);

  return { start, end: Math.max(start, end) };
}

/**
 * 把第 `idx` 行送到视口中间所需的 `scrollTop`，已夹到 `[0, maxScrollTop]`。
 *
 * 取代 `scrollIntoView`：窗口化之后当前章那一行很可能根本不在 DOM 里，没有元素可以
 * 滚给浏览器；而且 `behavior:"smooth"` 会在打开抽屉的瞬间叠一段动画。直接算位置则是
 * 一次赋值就落位。
 */
export function centerScrollTop(
  idx: number,
  viewH: number,
  total: number,
  row: number = ROW_HEIGHT,
): number {
  if (!(total > 0) || !(row > 0) || idx < 0) return 0;

  const maxTop = Math.max(0, total * row - Math.max(0, viewH));
  return Math.round(Math.min(maxTop, Math.max(0, idx * row - Math.max(0, viewH) / 2)));
}
export interface GridWindowRange extends WindowRange {
  /** 网格总行数 = `ceil(total / columns)`。撑高度用的是行数，不是条目数。 */
  rows: number;
  /** 需要挂载的首个条目下标（含）。 */
  itemStart: number;
  /** 需要挂载的末个条目下标（不含）。 */
  itemEnd: number;
}

/**
 * 网格版窗口化（需求 3.3）。把「条目数 + 列数」折成行数后交给 `computeWindow`，
 * 再把行区间摊回条目区间——窗口化的算术只有一份，这里只做坐标换算。
 *
 * `columns` 必须是调用方**实际渲染**的列数（响应式网格要随断点变化），否则行数算错，
 * 滚动条长度与挂载区间都会偏。
 */
export function computeGridWindow(
  scrollTop: number,
  viewH: number,
  total: number,
  columns: number,
  rowPitch: number = GRID_ROW_PITCH,
  overscan: number = OVERSCAN,
): GridWindowRange {
  const count = Math.max(0, Math.floor(total));
  // 列数兜底为 1：测量尚未完成或拿到脏值时，退化成单列列表仍然是正确的渲染，
  // 只是一屏挂载的条目变少。
  const cols = Math.max(1, Math.floor(columns) || 1);
  const rows = Math.ceil(count / cols);

  const { start, end } = computeWindow(scrollTop, viewH, rows, rowPitch, overscan);

  return {
    rows,
    start,
    end,
    itemStart: Math.min(count, start * cols),
    itemEnd: Math.min(count, end * cols),
  };
}
