/**
 * 书架加载遮罩上的进度读数：`fetchJson` 报来的字节数 → 进度条的形态与那一行说明。
 *
 * 三种情形，对应 `books.json` 的三种到达方式：
 *
 * - **还没有响应**（`null`）：连接、排队、等首字节。说明写"正在连接书库"，进度条是循环态。
 * - **知道总长**（响应没有传输压缩、带 `Content-Length`）：本地 `vite` / `vite preview`、
 *   e2e 的静态服务器。进度条按百分比走，说明写百分比。
 * - **不知道总长**：线上 Cloudflare Pages 对 `books.json` 做传输压缩（需求 5.2a），浏览器
 *   拿不到未压缩的总长（`FetchProgress`）。进度条只能是循环态，说明写已收到多少——数字在涨，
 *   读者就知道没卡住，这正是慢网下最需要的那条信息。
 *
 * 纯函数、与 React 无关，单测直接断言读数。
 */
import type { FetchProgress } from "./loadError";
import { INDETERMINATE, type LoadProgress, deriveLoadProgress } from "./loadProgress";

export interface ShelfLoadReading {
  /** 进度条的形态：确定态带整数百分比，不确定态是循环滑动的短条。 */
  readonly bar: LoadProgress;
  /** 标题下那一行说明，也是进度条的 `aria-valuetext`。 */
  readonly note: string;
}

const KIB = 1024;
const MIB = 1024 * 1024;

/** 字节数 → `312 KB` / `1.8 MB`。不足 1 MB 按整数 KB，够了按一位小数 MB。 */
export function formatReceived(bytes: number): string {
  const safe = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (safe < MIB) return `${Math.round(safe / KIB)} KB`;
  return `${(safe / MIB).toFixed(1)} MB`;
}

export function readShelfLoad(progress: FetchProgress | null): ShelfLoadReading {
  if (progress === null) return { bar: INDETERMINATE, note: "正在连接书库…" };
  if (progress.total !== null) {
    const bar = deriveLoadProgress(progress.received, progress.total);
    if (bar.kind === "determinate") return { bar, note: `已载入 ${bar.pct}%` };
  }
  return { bar: INDETERMINATE, note: `已载入 ${formatReceived(progress.received)}` };
}

/**
 * 两次读数在屏幕上是否一样。给 setState 做闸门：一个分片一次上报，而说明里的 KB 数与
 * 百分比是取整过的，多数分片不会改变显示。
 */
export function sameShelfLoad(a: FetchProgress | null, b: FetchProgress | null): boolean {
  if (a === null || b === null) return a === b;
  const ra = readShelfLoad(a);
  const rb = readShelfLoad(b);
  return ra.note === rb.note && ra.bar.kind === rb.bar.kind;
}
