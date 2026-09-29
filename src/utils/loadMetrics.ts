/**
 * 书籍加载链路的可观测埋点（需求 3.5）。
 *
 * ## 硬约束：只观察，不决策
 *
 * 这里产出的数字**不得**被任何代码读回去驱动行为——不做"字节数超过阈值就改走分片"、
 * 不做"解压太慢就跳过缓存"、不做任何形式的自动降级。需求 3.5 与差异定案 A7 把这条写成
 * 了显式禁令：旧版那条按运行时内存阈值降级的路径平时不跑、无人测试，最终成了死代码，
 * 本项目不重犯。因此本模块只有"写"的出口（`reportBookLoad`）而**没有读取器**：拿不到
 * 数据的代码自然无法依赖数据分支。要用这些数字，只能是人看日志后改设计（需求 10.7 的
 * 部署后核对就是这么用的）。
 *
 * ## 为什么单独一个模块
 *
 * 阶段 6 的任务 48 会把 `decompress.ts` 改成缓存原始 gz 二进制、命中缓存时再解压，
 * 任务 49 还要接进度的不确定态。指标形态集中在这一个文件、由调用方填槽位，那次重写就只
 * 需要改"谁来填 gzBytes / decompressMs"，不必在新增的分支里重新发明一遍日志格式。
 */

/**
 * 文本的来源分支。存在的意义之一是需求 10.7：部署到 Pages 之后要靠日志确认
 * `.txt.gz` 实际走的是前端 `DecompressionStream` 还是 HTTP 层透明解压。
 */
export type BookLoadSource =
  /** 内存 Map 命中，本次会话内的二次打开。 */
  | "memory"
  /** IndexedDB 持久缓存命中。 */
  | "indexeddb"
  /** 网络取回原始 gz，前端 `DecompressionStream` 解压。 */
  | "network"
  /** 服务器带了 `Content-Encoding: gzip`，浏览器 HTTP 层已透明解压。 */
  | "network-transparent"
  /** `DecompressionStream` 抛错后的 `fetch().text()` 兜底。 */
  | "network-fallback";

export interface BookLoadMetrics {
  bookId: string;
  source: BookLoadSource;
  /**
   * gz 字节数。拿不到时用 `null` 而不是 0：内存命中、透明解压这类分支本就观测不到线上
   * 字节，用 0 冒充会让日后按日志算压缩率的人得到假数据。
   */
  gzBytes: number | null;
  /** 结果字符数（`String.length`，即 UTF-16 码元数）。 */
  chars: number;
  /**
   * 解压耗时（ms），未发生解压时为 `null`。
   *
   * 流式解压与下载是重叠的，网络分支这个值实际是"解压管线的墙上时间（含下载）"，无法在
   * 不牺牲流式的前提下拆开。纯解压耗时要等任务 48 落地——那之后缓存命中会从本地 gz 解压，
   * 不含网络，`source === "indexeddb"` 的读数才是干净的解压成本（附录 M1 实测约 126ms）。
   */
  decompressMs: number | null;
  /** 从 `loadGzipBookText` 入口到拿到文本的总耗时（ms）。 */
  totalMs: number;
  /**
   * `performance.now()` 基准的起始时刻，仅用于把这段耗时画到性能时间轴上。
   * 省略或为 `null` 时只打日志，不落时间轴。
   */
  startedAt?: number | null;
}

/** 日志行前缀，便于在控制台按关键字过滤。 */
export const LOAD_LOG_PREFIX = "[book-load]";

/** `performance.measure` 的条目名前缀。 */
export const LOAD_MEASURE_PREFIX = "book-load";

/**
 * 单调时钟读数，`performance` 不可用时退回 `Date.now()`。
 * 单测环境（Node）与浏览器都有 `performance.now`，兜底只是为了不对宿主做假设。
 */
export function nowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

/** 字节数的人读形式。保留两位小数，够看出 22.36MB 与 22.4MB 的差别。 */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "n/a";
  if (bytes < 1024) return `${Math.round(bytes)}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

/** 毫秒的人读形式。取整：亚毫秒精度对这条链路没有意义。 */
function formatMs(ms: number): string {
  return Number.isFinite(ms) ? `${Math.round(ms)}ms` : "n/a";
}

/**
 * 把指标拼成一行定长字段的日志。
 *
 * 纯函数，与宿主环境无关，所以能被直接单测（design §11：单测只覆盖纯工具函数）。
 * 字段顺序固定、缺失值统一写 `n/a`，便于日后把控制台日志整段贴进表格比对。
 */
export function formatBookLoadMetrics(m: BookLoadMetrics): string {
  const gz = m.gzBytes === null ? "n/a" : formatBytes(m.gzBytes);
  const decompress = m.decompressMs === null ? "n/a" : formatMs(m.decompressMs);

  return (
    `${LOAD_LOG_PREFIX} ${m.bookId} source=${m.source} gz=${gz} ` +
    `chars=${m.chars} decompress=${decompress} total=${formatMs(m.totalMs)}`
  );
}

/**
 * 上报一次加载指标：打一行控制台日志，并在支持的浏览器里落一条 `performance.measure`。
 *
 * 用 `measure` 而不是两个 `mark`：measure 在性能面板里是一段可见区间，能直接和同一时刻的
 * 长任务、渲染帧对齐，而 mark 只是两个点，还得人工相减。
 *
 * 用 `console.info` 而不是 `debug`：需求 10.7 要在真实部署环境核对走了哪条分支，而
 * `debug` 级别在 Chrome 默认日志级别下是隐藏的，核对的人看不到。
 *
 * 整体 try/catch 且不抛：埋点永远不能成为加载失败的原因。
 */
export function reportBookLoad(m: BookLoadMetrics): void {
  try {
    console.info(formatBookLoadMetrics(m));

    if (
      typeof performance !== "undefined" &&
      typeof performance.measure === "function" &&
      typeof m.startedAt === "number"
    ) {
      performance.measure(`${LOAD_MEASURE_PREFIX}:${m.bookId}:${m.source}`, {
        start: m.startedAt,
        duration: m.totalMs,
        detail: {
          source: m.source,
          gzBytes: m.gzBytes,
          chars: m.chars,
          decompressMs: m.decompressMs,
        },
      });
    }
  } catch {
    // 埋点失败就当没埋过：宿主可能禁用 console、耗尽 performance 缓冲区，
    // 但这些都不该影响读者能不能看书。
  }
}
