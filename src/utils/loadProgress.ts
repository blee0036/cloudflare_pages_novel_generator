/**
 * 加载进度的两态（design §8.3，需求 10.5）。
 *
 * ## 为什么需要一个显式的"不确定态"
 *
 * `decompress.ts` 原先的回调契约是 `onProgress(loaded, total)`，且**只在 `total > 0` 时
 * 触发**。于是调用方手里只有一个数字，"还没开始"与"永远拿不到百分比"共用同一个读数 0，
 * 进度条就只能停在 0% 直到文本整份到手——需求 10.5 明令禁止的正是这个。
 *
 * 靠哨兵值（`-1`、`null`）区分两者也不行：哨兵要求每个读到它的地方都记得那条不成文的
 * 约定，漏一处就是一个"进度 -1%"的渲染。改成带 `kind` 的可辨识联合后，"没有百分比"
 * 在类型层面就不是一个数字，渲染分支漏写编译不过。
 *
 * ## 三条拿不到百分比的路径
 *
 * 1. 响应没有 `content-length`（代理改写、分块传输）——分母未知。
 * 2. `Content-Encoding: gzip` 透明解压——HTTP 层在 `fetch` 返回前就把流吃掉了，JS 侧
 *    拿不到任何逐字节的进展；`content-length` 即便存在也是压缩后的长度，与
 *    `response.text()` 的进展无关（需求 10.8 要在真实环境核对走的是哪条分支）。
 * 3. IndexedDB 命中——下载这一步根本没发生，剩下的是本地那约 126 ms 的解压
 *    （附录 M1），纯 CPU 工作，`DecompressionStream` 不报进展。
 *
 * 三条都不是异常，而是常态分支，所以不确定态是一等状态，不是错误态。
 *
 * ## 纯函数，可单测
 *
 * 本模块不碰 DOM、不引 React，两个函数都是纯算术（design §11）。差一位与边界（分母 0、
 * 分子超过分母、非有限数）正是类型检查看不见而症状明显的那类错。
 */

/**
 * 一次加载的进度显示状态。
 *
 * `pct` 恒落在 `[0, 100]` 的整数区间——渲染方可以直接当宽度百分比用，不必再 clamp。
 */
export type LoadProgress =
  | { readonly kind: "determinate"; readonly pct: number }
  | { readonly kind: "indeterminate" };

/**
 * 不确定态的**共享单例**。
 *
 * 刻意只有一个实例：React 的 `useState` 用 `Object.is` 判断是否要重渲染，每次新建
 * `{ kind: "indeterminate" }` 会让每一次上报都触发一轮渲染。下载 22 MB 的最大书约有
 * 数百个分片，那就是数百次无意义的重绘。冻结是为了让"共享"这件事不可能被就地改坏。
 */
export const INDETERMINATE: LoadProgress = Object.freeze({
  kind: "indeterminate",
} as const);

/** 进度上报口。`decompress.ts` 的每条分支各自决定报什么。 */
export type ProgressReporter = (progress: LoadProgress) => void;

/**
 * 由"已到达字节 / 总字节"推出显示状态。
 *
 * 分母不可用（缺头、非有限、≤ 0）或分子不是有限数时一律不确定态——**不把它当 0%**，
 * 这是本函数存在的全部意义。
 *
 * 分子越界时钳到 `[0, total]`：`content-length` 可能被代理改写得比实际短，那时宁可让
 * 进度条停在 100% 也不能报出 103%。
 */
export function deriveLoadProgress(loaded: number, total: number): LoadProgress {
  if (!Number.isFinite(total) || total <= 0) return INDETERMINATE;
  if (!Number.isFinite(loaded)) return INDETERMINATE;

  const clamped = Math.min(Math.max(loaded, 0), total);
  return { kind: "determinate", pct: Math.round((clamped / total) * 100) };
}

/**
 * 两个进度是否代表同一个显示状态。
 *
 * 给调用方做 setState 前的去重用：`pct` 是整数，22 MB 的书在字节层面有数百次上报，
 * 但屏幕上只有 101 个可区分的状态。没有这道闸门，进度条会为同一个百分比重渲染十几次。
 * 比较取值而非引用，所以 `deriveLoadProgress` 每次返回新对象也无妨。
 */
export function sameLoadProgress(a: LoadProgress, b: LoadProgress): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === "determinate" && b.kind === "determinate" ? a.pct === b.pct : true;
}
