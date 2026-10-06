/**
 * 性能观测的纯函数（设计"性能观测（需求 14）"；需求 14.2）。
 *
 * 本文件只放不依赖浏览器、文件系统与 Playwright 的纯函数，供 fixture（`bookLog`）、
 * perf 用例与 reporter 共用，也便于在 tooling 项目里做无浏览器的属性测试：
 *
 * - `parseBookLoadLine`：解析应用打出的 `[book-load]` 控制台行（14.2 (e)，任务 7.2）。
 * - `LongTaskEntry`：`longtask` 条目中计量所需的两个字段（14.6），由页内探针
 *   `e2e/perf/probes.ts` 的 `openLongTaskWindow` 产出（任务 19.4）。
 * - `evaluatePerfItem`：(a)–(d) 每项 5 次读数的中位数、最大值与预算判定（14.3、14.4、14.7，
 *   设计 Property 7），供 reporter 写 Perf_Metrics 表（任务 19.1）。
 * - `maxLongTask`：观测窗口内的最长长任务读数（14.6，设计 Property 8），供 (b)(d) 的取样
 *   使用（任务 19.1）。
 */
import { LOAD_LOG_PREFIX } from "../../src/utils/loadMetrics";
import { PERF } from "../support/settings";

// ---------------------------------------------------------------------------
// `[book-load]` 行解析（14.2 (e)）
// ---------------------------------------------------------------------------

/**
 * 一条 `[book-load]` 日志解析后的字段。
 *
 * 行由 `src/utils/loadMetrics.ts` 的 `formatBookLoadMetrics` 生成，形如：
 *
 * ```text
 * [book-load] <bookId> source=<source> gz=<gz> chars=<chars> decompress=<decompress> total=<total>
 * ```
 *
 * 除 `chars` 外各字段都保留日志里的原样记号，不做换算：
 * - `gz` 是人读的字节数（`640B`、`12.34KB`、`3.21MB`）或 `n/a`，KB/MB 已按两位小数取整，
 *   换回字节会失真；
 * - `decompress`、`total` 是取整后的毫秒（`85ms`）或 `n/a`。
 *
 * `source` 保留为 `string` 而不收窄到 `BookLoadSource`：应用若打出枚举外的取值（例如回归出
 * 已删除的 `network-fallback`，19.2），调用方应当看到并据此判失败，而不是被解析器吞掉。
 */
export interface BookLoadLine {
  /** 书 id，原样取自日志；可含中文、连字符等任意字符。 */
  bookId: string;
  /** 来源分支：`memory` / `indexeddb` / `network` / `network-transparent`（原样，不校验）。 */
  source: string;
  /** gz 字节数的格式化记号，或 `n/a`。 */
  gz: string;
  /** 全文的 UTF-16 码元数（`String.length`，19.4）。 */
  chars: number;
  /** 解压耗时的格式化记号（如 `85ms`），或 `n/a`。 */
  decompress: string;
  /** 总耗时的格式化记号（如 `240ms`）。 */
  total: string;
}

/** 行首记号：前缀加 1 个空格，其后紧跟书 id。 */
const LINE_HEAD = `${LOAD_LOG_PREFIX} `;

/**
 * 行尾的 5 个定长字段。每个值都是不含空白的记号，字段间恰好 1 个空格，并锚定到串尾，
 * 所以它们只能是整行最后 5 个以空白分隔的片段；其前的全部内容（去掉行首记号）就是书 id。
 * 这样即使 id 含空格，甚至含形似字段的子串，也能与 `formatBookLoadMetrics` 精确互逆。
 */
const LINE_TAIL =
  / source=(\S+) gz=(\S+) chars=(\d+) decompress=(\S+) total=(\S+)$/;

/**
 * 解析一条控制台消息文本；不是 `[book-load]` 行或格式不符时返回 `null`，从不抛错。
 *
 * - 必须以 `[book-load] `（含空格）开头，且其后的书 id 非空；
 * - 行尾必须恰为 `source= gz= chars= decompress= total=` 五个字段，其后不得有多余内容；
 * - `chars` 必须是十进制非负整数且不超过 `Number.MAX_SAFE_INTEGER`。
 *
 * 对 `formatBookLoadMetrics(m)` 的输出（`m.bookId` 非空、`m.chars` 为非负安全整数），
 * 返回值的 `bookId`、`source`、`chars` 等于 `m` 的对应字段，`gz`、`decompress`、`total`
 * 等于格式化串中的对应记号（设计 Property 9）。
 */
export function parseBookLoadLine(text: string): BookLoadLine | null {
  if (typeof text !== "string" || !text.startsWith(LINE_HEAD)) return null;

  const rest = text.slice(LINE_HEAD.length);
  const tail = LINE_TAIL.exec(rest);
  if (tail === null) return null;

  const bookId = rest.slice(0, tail.index);
  if (bookId.length === 0) return null;

  const [, source, gz, charsToken, decompress, total] = tail;
  const chars = Number(charsToken);
  if (!Number.isSafeInteger(chars)) return null;

  return { bookId, source, gz, chars, decompress, total };
}

// ---------------------------------------------------------------------------
// 长任务条目（14.6）
// ---------------------------------------------------------------------------

/**
 * 一条 `longtask` 性能条目中计量所需的两个字段（设计"Perf_Metrics"数据模型）。
 *
 * 由 `e2e/perf/probes.ts` 的 `openLongTaskWindow().close()` 从页面内的 `PerformanceEntry`
 * 取出。两个字段与 `performance.now()`、`event.timeStamp` 同一时基（页面的时间原点，毫秒），
 * 所以可以直接与 `readStart`、`waitFrame` 的读数比较，确定条目是否落在观测窗口内。
 * Long Tasks API 只报告持续 ≥ 50 ms 的任务，`duration` 因而总 ≥ 50（14.6）。
 */
export interface LongTaskEntry {
  /** 任务开始时刻（页面时间原点起的毫秒）。 */
  startTime: number;
  /** 任务持续时长（毫秒）。 */
  duration: number;
}

// ---------------------------------------------------------------------------
// 最长长任务读数（14.6）
// ---------------------------------------------------------------------------

/**
 * 观测窗口 `[t0, t1]` 内的最长长任务读数（毫秒），14.2 (b)(d) 用（设计 Property 8）。
 *
 * - 条目占据闭区间 `[startTime, startTime + duration]`；与窗口闭区间 `[t0, t1]` 有公共点即算
 *   "相交"，即 `startTime <= t1 && startTime + duration >= t0`。窗口开始前已在执行、延续进窗口
 *   的任务同样阻塞了窗口内的主线程，因此计入；端点恰好相接也算相交。
 * - 读数为相交条目中 `duration` 的最大值；没有相交条目时为 0（14.6）。Long Tasks API 只报告
 *   ≥ 50 ms 的任务，所以读数只会是 0 或 ≥ 50；本函数不据此过滤条目。
 * - 不与窗口相交的条目不影响结果，调用方可以直接交入 `close()` 返回的全部条目。
 *
 * `t0`、`t1` 与条目同一时基（页面时间原点起的毫秒，即 `performance.now()` / `event.timeStamp`）。
 * 二者须为有限数且 `t0 <= t1`，否则抛 `RangeError`：窗口无效说明取样本身出了错，调用方应把该次
 * 取样记为"未采集"（14.7），而不是得到一个看似正常的 0。
 */
export function maxLongTask(
  entries: readonly LongTaskEntry[],
  t0: number,
  t1: number,
): number {
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t0 > t1) {
    throw new RangeError(`maxLongTask：观测窗口须满足有限的 t0 <= t1，实得 [${t0}, ${t1}]`);
  }
  let longest = 0;
  for (const { startTime, duration } of entries) {
    if (startTime <= t1 && startTime + duration >= t0 && duration > longest) {
      longest = duration;
    }
  }
  return longest;
}

// ---------------------------------------------------------------------------
// 预算判定（14.3、14.4、14.7）
// ---------------------------------------------------------------------------

/**
 * 14.2 的 (a)–(d) 四项，即 `PERF.budgetsMs` 的键：(a) `tocOpen`、(b) `tocScrollLongTask`、
 * (c) `shelfSearch`、(d) `readerSearchLongTask`。(e) `[book-load]` 不设预算，不在其中。
 */
export type PerfKey = keyof typeof PERF.budgetsMs;

/** 四项按 (a)–(d) 的顺序（即 `PERF.budgetsMs` 的书写顺序），供 reporter 排表与测试生成。 */
export const PERF_KEYS = Object.keys(PERF.budgetsMs) as readonly PerfKey[];

/**
 * 判定结果：`within` 未超预算、`over` 超预算、`uncollected` 未采集（14.5 状态列的三种取值）。
 * 超预算只做标注，不影响用例结果与退出码（14.4、1.7）。
 */
export type PerfStatus = "within" | "over" | "uncollected";

/**
 * perf 用例为一项采集到的原始读数（设计"Perf_Metrics"数据模型），随 `perf-metrics` 附件交给
 * reporter。
 */
export interface PerfItem {
  key: PerfKey;
  /**
   * 按取样顺序的读数（毫秒），长度应为 `PERF.samples`；`null` 表示该次未采集（到时未达终止条件、
   * 无法建立 `longtask` 观测、剩余时间不足等），不以 0 填充（14.7）。
   */
  readings: (number | null)[];
  /** 未采集的原因（14.7）；有 `null` 读数时由 perf 用例写明。 */
  reason?: string;
}

/** perf 用例在 fixture teardown 里附上的附件名（设计"性能观测"的"汇总"一段），reporter 按此名收集。 */
export const PERF_METRICS_ATTACHMENT = "perf-metrics";

/**
 * `perf-metrics` 附件的内容（JSON）。每个 perf 用例一份，中途出错也照附（`e2e/tests/perf/perf.spec.ts`）。
 * reporter 据 `items` 算中位数与状态，据后两项写 Perf_Metrics 表头（14.5）。
 */
export interface PerfMetricsAttachment {
  /** 本用例负责的各项读数；每项恰好 `PERF.samples` 个，未采集的为 `null` 并附 `reason`。 */
  items: PerfItem[];
  /** `browser.version()`，即本次运行的 Chromium 版本。 */
  chromium: string;
  /** 浏览器是否以 headless 模式运行（Playwright 的 `headless` 选项）。 */
  headless: boolean;
}

/** `evaluatePerfItem` 的结果，即 `e2e/.out/perf.json` 与 Perf_Metrics 表的一行。 */
export interface PerfEvaluated extends PerfItem {
  /** 5 次读数的中位数；`status` 为 `uncollected` 时为 `null`。 */
  median: number | null;
  /** 5 次读数的最大值；`status` 为 `uncollected` 时为 `null`。 */
  max: number | null;
  /** 判定所用的 Perf_Budget（毫秒）。 */
  budgetMs: number;
  status: PerfStatus;
}

/**
 * 按 14.4、14.7 判定一项（设计 Property 7）：
 *
 * - 读数恰为 `PERF.samples`（5）个且每个都是有限的非负数时视为采齐：`median` 为升序排列后的
 *   正中一个（5 个读数即第 3 个），`max` 为最大读数；`median > budgetMs`（严格大于）时状态为
 *   `over`，否则为 `within`。结果与读数的排列顺序无关。
 * - 否则（含 `null`、个数不是 `PERF.samples`，或出现负数 / 非有限数）状态为 `uncollected`，
 *   `median` 与 `max` 都为 `null`，不用部分读数凑中位数，也不以 0 填充（14.7）。`reason` 取
 *   `item.reason`；它缺失或为空串时，按读数本身写出一条原因（哪几次未采集、个数不符或读数
 *   无效），使 Run_Summary 的"未采集"总附有原因。
 *
 * `budgetMs` 默认取 `PERF.budgetsMs[item.key]`（Perf_Budget 的唯一来源，14.3）；显式传入只为
 * 属性测试对任意预算做判定。它须为有限的非负数，否则抛 `RangeError`。
 *
 * 纯函数：不修改 `item`，返回值的 `readings` 是副本。
 */
export function evaluatePerfItem(
  item: PerfItem,
  budgetMs: number = PERF.budgetsMs[item.key],
): PerfEvaluated {
  if (!(Number.isFinite(budgetMs) && budgetMs >= 0)) {
    throw new RangeError(`evaluatePerfItem：预算须为有限的非负数，实得 ${budgetMs}（${item.key}）`);
  }

  const readings = [...item.readings];
  const problem = readingsProblem(readings);
  if (problem !== null) {
    const reason = item.reason !== undefined && item.reason !== "" ? item.reason : problem;
    return { key: item.key, readings, reason, median: null, max: null, budgetMs, status: "uncollected" };
  }

  // readingsProblem 为 null 时每项都是有限的非负数
  const sorted = (readings as number[]).slice().sort((x, y) => x - y);
  const middle = sorted.length >> 1;
  const median =
    sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  const max = sorted[sorted.length - 1];
  const status: PerfStatus = median > budgetMs ? "over" : "within";

  const result: PerfEvaluated = { key: item.key, readings, median, max, budgetMs, status };
  if (item.reason !== undefined) result.reason = item.reason;
  return result;
}

/**
 * 读数不构成一组完整取样时返回原因，否则返回 `null`。
 * 次序从 1 起编号，与 Run_Summary 表中"第 k 次读数"一致。
 */
function readingsProblem(readings: readonly (number | null)[]): string | null {
  const parts: string[] = [];
  if (readings.length !== PERF.samples) {
    parts.push(`读数 ${readings.length} 个，应为 ${PERF.samples} 个`);
  }
  const missing: number[] = [];
  const invalid: string[] = [];
  readings.forEach((value, i) => {
    if (value === null) missing.push(i + 1);
    else if (!(Number.isFinite(value) && value >= 0)) invalid.push(`第 ${i + 1} 次为 ${value}`);
  });
  if (missing.length > 0) parts.push(`第 ${missing.join("、")} 次未采集（未注明原因）`);
  if (invalid.length > 0) parts.push(`读数无效：${invalid.join("，")}`);
  return parts.length === 0 ? null : parts.join("；");
}
