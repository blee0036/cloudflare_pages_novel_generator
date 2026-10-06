/**
 * 性能观测的页内探针（设计"性能观测（需求 14）"；需求 14.2、14.6）。
 *
 * 每个导出函数在 Node 端调用，经 `page.evaluate` / `locator.evaluate` 把本文件里对应的
 * `*InPage` 函数搬进页面执行。触发元素（目录按钮、检索框）由调用方经 `e2e/support/locators.ts`
 * 定位后以 `Locator` 传入；页内的 DOM 判定只用于度量（D8）。
 *
 * | 函数 | 作用 |
 * | --- | --- |
 * | `armStart(target, type, which)` | 在 `target` 上挂 capture 监听，记下首个或末个 `click` / `input` 事件的 `event.timeStamp` |
 * | `readStart(page)` | 取出上一次 `armStart` 记下的时刻并摘掉监听 |
 * | `waitFrame(page, pred, arg, capMs)` | 每个 rAF 回调里判定一次 `pred`，首次成立时返回该回调开头的 `performance.now()`；到 `capMs` 仍不成立返回 `null` |
 * | `openLongTaskWindow(page)` | 以 `PerformanceObserver` 观测 `longtask`；`close()` 取出窗口内的全部条目并断开 |
 *
 * ## 时基
 *
 * `event.timeStamp`、`performance.now()` 与 `longtask` 条目的 `startTime` 都以页面的时间原点为
 * 零点（毫秒），即 14.2 所说的同一个高精度时钟，彼此可以直接相减。终点取帧回调时刻，精度约一帧。
 * 探针依赖真实的 rAF、`setTimeout` 与 `performance.now()`，不可与 Controlled_Clock 同用；
 * perf 用例本就不装时钟（14.8）。
 *
 * ## 谓词（`MeasurePredicate`）的传递方式
 *
 * 函数不能作为 `page.evaluate` 的参数跨进页面，所以 `waitFrame` 取谓词的源码
 * （`String(pred)`），连同可序列化的参数 `arg` 一起送进页面，在页面里以 `globalThis.eval`
 * 重建成函数，再在每帧调用 `pred(arg, kit)`。这与 Playwright 自己的 `page.evaluate`、
 * `page.waitForFunction` 搬运函数的做法相同（二者都在页面里 `globalThis.eval` 源码），
 * 应用也没有 CSP，不引入新的限制。于是：
 *
 * - 谓词必须是**自包含**的箭头函数或 `function` 表达式：只能使用参数 `arg`、`kit` 与页面全局
 *   （`document`、`window` 等），不得引用所在模块或外层作用域的任何标识符（包括 import 进来的
 *   函数与常量）；违反时页面里抛 `ReferenceError`，`waitFrame` 以"谓词在页面内出错"重抛。
 * - 谓词必须同步返回 `boolean`。返回其他值（例如 `async` 函数返回的 Promise）按出错处理，
 *   不会被当成"成立"。
 * - `arg` 与 `page.evaluate` 的参数规则相同：可 JSON 化的值、`RegExp`、`Date`，以及
 *   `ElementHandle` / `JSHandle`（页面里拿到的是对应的元素或值，类型见 `InPage`）。`Locator`
 *   不能放进 `arg`；需要页面里的元素时，先 `await locator.elementHandle()`（或经
 *   `locator.evaluateHandle` 做测量性遍历，例如找滚动祖先）取得句柄。
 * - `kit`（`FrameKit`）是页面里现成的几何与文本小工具，免得每个谓词各写一遍相交判定。
 *
 * 选源码而不选"谓词描述 DSL"，是因为 14.2 的四个终止条件（首个目录行进入视口、指定行进入
 * 列表可视区、书卡标题序列被替换且含某书、检索结果含完整关键词）形态各异，DSL 要么覆盖不全，
 * 要么长成一门小语言；源码谓词保留 TypeScript 的类型检查，写法与 `locator.evaluate` 一致。
 *
 * ## 用法示意（任务 19.5）
 *
 * ```ts
 * // (a) 点击目录按钮 → 首个目录行进入视口
 * await armStart(reader(page).tocButton, "click");
 * await reader(page).tocButton.click();
 * const end = await waitFrame(page, (name, kit) =>
 *   Array.from(document.querySelectorAll("button, h3")).some(
 *     (el) => name.test(kit.text(el)) && kit.inViewport(el)), firstRowName);
 * const reading = end === null ? null : end - (await readStart(page));
 *
 * // (b)(d) 长任务窗口
 * const win = await openLongTaskWindow(page);   // 不支持 longtask 时抛 NoLongTaskError
 * …
 * const entries = await win.close();            // LongTaskEntry[]，交给 maxLongTask(entries, t0, t1)
 * ```
 *
 * 上例的 DOM 查询只是示意，具体谓词由 19.5 按设计写定。
 *
 * ## 页内状态
 *
 * `armStart` 与 `openLongTaskWindow` 的状态挂在 `window[PROBE_KEY]` 上，随文档存亡：页面导航或
 * 重载后状态消失，此时 `readStart` 与 `close()` 抛错说明原因，调用方据此把该次取样记为
 * "未采集"（14.7）。
 *
 * 本文件所有 `*InPage` 函数都在页面内执行，不得引用本模块的任何标识符。Playwright 转译 TS 时
 * 会把 `?.`、`??` 改写成函数内的临时变量，不引入模块级辅助函数；类会引入辅助函数，页内函数里
 * 不写类。
 */
import type { ElementHandle, JSHandle, Locator, Page } from "@playwright/test";
import { TIMEOUTS } from "../support/settings";
import type { LongTaskEntry } from "./metrics";

/** 页内状态在 `window` 上的键。 */
const PROBE_KEY = "__e2ePerfProbes";

// ---------------------------------------------------------------------------
// 公共类型
// ---------------------------------------------------------------------------

/** `armStart` 监听的事件：(a) 点击目录按钮为 `click`，(c)(d) 逐字输入为 `input`。 */
export type StartEventType = "click" | "input";

/** 记首个事件（(a)、(d) 的"首次按键"）还是末个事件（(c) 的"末次按键"）。 */
export type StartWhich = "first" | "last";

/**
 * 谓词在页面里可用的小工具。几何判定都按"相交面积大于 0"计：只擦边、尺寸为 0 或元素已脱离
 * 文档都不算相交。
 */
export interface FrameKit {
  /** `el` 的边框盒与视口（`document.documentElement` 的 client 区域）相交。 */
  inViewport(el: Element): boolean;
  /**
   * `el` 的边框盒与 `container` 的可视区（padding 盒，不含边框与滚动条，即滚动容器里用户
   * 看得到的区域）相交。用于"某行进入列表可视区"（14.2 (b)）。
   */
  intersects(el: Element, container: Element): boolean;
  /**
   * `node.textContent` 的规整结果：去掉零宽空格与软连字符，首尾去空白，连续空白折成一个空格，
   * 与 `locators.ts` 的 `normalizeWhiteSpace` 相同。相邻的内联子元素之间不补空格，例如目录
   * 章节行得到"标题1234字"，而不是可访问名称里的"标题 1234字"。
   */
  text(node: Node): string;
}

/**
 * `waitFrame` 的终止条件：在页面内每帧调用一次，同步返回 `true` 表示已满足。
 * 必须自包含，规则见文件头"谓词的传递方式"。
 */
export type MeasurePredicate<A> = (arg: A, kit: FrameKit) => boolean;

/**
 * Node 端的参数在页面里的样子：`ElementHandle<E>` 变成 `E`，`JSHandle<V>` 变成 `V`，
 * 数组与对象逐项换算，其余原样（Playwright `Unboxed` 的子集）。
 */
export type InPage<T> =
  T extends ElementHandle<infer E>
    ? E
    : T extends JSHandle<infer V>
      ? V
      : T extends RegExp | Date
        ? T
        : T extends readonly unknown[]
          ? { [K in keyof T]: InPage<T[K]> }
          : T extends object
            ? { [K in keyof T]: InPage<T[K]> }
            : T;

/** 无法建立 `longtask` 观测（14.7）：浏览器不支持该条目类型，或 `observe` 失败。 */
export class NoLongTaskError extends Error {
  /** 页面报告的 `PerformanceObserver.supportedEntryTypes`。 */
  readonly supportedEntryTypes: readonly string[];

  constructor(detail: string, supportedEntryTypes: readonly string[]) {
    super(`无法建立 longtask 观测：${detail}`);
    this.name = "NoLongTaskError";
    this.supportedEntryTypes = supportedEntryTypes;
  }
}

/** 一个打开着的 `longtask` 观测窗口。 */
export interface LongTaskWindow {
  /**
   * 取出窗口打开以来收到的全部 `longtask` 条目（`takeRecords` 补上尚未派发的），然后断开观测。
   * 重复调用返回同一结果；页面已导航或重载时抛错。
   */
  close(): Promise<LongTaskEntry[]>;
}

// ---------------------------------------------------------------------------
// 页内状态与跨边界的结果（仅类型）
// ---------------------------------------------------------------------------

interface StartRecord {
  type: StartEventType;
  which: StartWhich;
  /** 记下的 `event.timeStamp`；尚未收到事件时为 `null`。 */
  time: number | null;
  /** 摘掉监听；可重复调用。 */
  detach: () => void;
}

interface LongTaskRecorder {
  observer: PerformanceObserver;
  /** 观测回调已派发的条目；`close` 时再补上 `takeRecords()` 的。 */
  entries: PerformanceEntry[];
}

interface ProbeState {
  start: StartRecord | null;
  windows: Record<number, LongTaskRecorder>;
  nextWindowId: number;
}

type ProbeArgs = { key: string };
type ArmStartArgs = ProbeArgs & { type: StartEventType; which: StartWhich };
type ReadStartOutcome = { ok: true; time: number } | { ok: false; reason: string };
type WaitFrameArgs = { src: string; arg: unknown; capMs: number };
type WaitFrameOutcome =
  | { kind: "hit"; time: number }
  | { kind: "cap" }
  | { kind: "error"; message: string };
type OpenWindowOutcome =
  | { ok: true; id: number }
  | { ok: false; reason: string; supported: string[] };
type CloseWindowArgs = ProbeArgs & { id: number };
type CloseWindowOutcome = { ok: true; entries: LongTaskEntry[] } | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// 页内函数（在页面内执行，不得引用本模块的任何标识符）
// ---------------------------------------------------------------------------

/**
 * 在 `el` 上挂 capture 监听。上一次 `armStart` 留下的监听先摘掉，记录清空。
 * 只认可信事件（`isTrusted`）：Playwright 的 `click`、`pressSequentially` 经 CDP 产生的输入
 * 都是可信的，脚本 `dispatchEvent` 出来的不算用户输入。
 */
function armStartInPage(el: Element, a: ArmStartArgs): void {
  const w = window as unknown as Record<string, ProbeState | undefined>;
  let state = w[a.key];
  if (state === undefined) {
    state = { start: null, windows: {}, nextWindowId: 1 };
    w[a.key] = state;
  }
  if (state.start !== null) state.start.detach();

  const record: StartRecord = { type: a.type, which: a.which, time: null, detach: () => {} };
  const onEvent = (event: Event): void => {
    if (!event.isTrusted) return;
    record.time = event.timeStamp;
    if (a.which === "first") record.detach();
  };
  record.detach = () => el.removeEventListener(a.type, onEvent, true);
  el.addEventListener(a.type, onEvent, true);
  state.start = record;
}

/** 取出记下的时刻并摘掉监听；记录保留，重复读取得到同一值。 */
function readStartInPage(a: ProbeArgs): ReadStartOutcome {
  const w = window as unknown as Record<string, ProbeState | undefined>;
  const record = w[a.key]?.start ?? null;
  if (record === null) {
    return { ok: false, reason: "页面里没有 armStart 的记录（未调用，或页面已导航 / 重载）" };
  }
  record.detach();
  if (record.time === null) {
    return { ok: false, reason: `armStart 之后没有收到可信的 ${record.type} 事件` };
  }
  return { ok: true, time: record.time };
}

/**
 * 每个 rAF 回调里先取 `performance.now()`，再判定谓词：成立即以该时刻结算为 `hit`；
 * 不成立且已过 `capMs` 结算为 `cap`，否则等下一帧。另设 `capMs` 的计时器兜底，主线程长时间
 * 无帧时也按 `cap` 结算。谓词抛错或返回非 boolean 结算为 `error`。
 */
function waitFrameInPage(a: WaitFrameArgs): Promise<WaitFrameOutcome> {
  let pred: (arg: unknown, kit: FrameKit) => unknown;
  try {
    pred = globalThis.eval(`(${a.src})`) as typeof pred;
    if (typeof pred !== "function") throw new TypeError("源码求值结果不是函数");
  } catch (e) {
    return Promise.resolve({ kind: "error", message: `无法重建谓词：${String(e)}` });
  }

  const overlaps = (el: Element, left: number, top: number, right: number, bottom: number): boolean => {
    if (!el.isConnected) return false;
    const r = el.getBoundingClientRect();
    return Math.min(r.right, right) > Math.max(r.left, left) && Math.min(r.bottom, bottom) > Math.max(r.top, top);
  };
  const kit: FrameKit = {
    inViewport: (el) => {
      const root = document.documentElement;
      return overlaps(el, 0, 0, root.clientWidth, root.clientHeight);
    },
    intersects: (el, container) => {
      if (!container.isConnected) return false;
      const c = container.getBoundingClientRect();
      const left = c.left + container.clientLeft;
      const top = c.top + container.clientTop;
      return overlaps(el, left, top, left + container.clientWidth, top + container.clientHeight);
    },
    text: (node) =>
      (node.textContent ?? "").replace(/[\u200b\u00ad]/g, "").trim().replace(/\s+/g, " "),
  };

  return new Promise<WaitFrameOutcome>((resolve) => {
    const startedAt = performance.now();
    let settled = false;
    let frame = 0;
    let timer = 0;
    const settle = (outcome: WaitFrameOutcome): void => {
      if (settled) return;
      settled = true;
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      resolve(outcome);
    };
    const onFrame = (): void => {
      if (settled) return;
      const now = performance.now();
      let result: unknown;
      try {
        result = pred(a.arg, kit);
      } catch (e) {
        settle({ kind: "error", message: e instanceof Error ? (e.stack ?? e.message) : String(e) });
        return;
      }
      if (result === true) {
        settle({ kind: "hit", time: now });
      } else if (result !== false) {
        settle({ kind: "error", message: `谓词须同步返回 boolean，实得 ${typeof result}` });
      } else if (now - startedAt >= a.capMs) {
        settle({ kind: "cap" });
      } else {
        frame = requestAnimationFrame(onFrame);
      }
    };
    timer = window.setTimeout(() => settle({ kind: "cap" }), a.capMs);
    frame = requestAnimationFrame(onFrame);
  });
}

/** 建立 `longtask` 观测（不取缓冲的旧条目），返回窗口编号。 */
function openLongTaskWindowInPage(a: ProbeArgs): OpenWindowOutcome {
  const supported =
    typeof PerformanceObserver === "function" && Array.isArray(PerformanceObserver.supportedEntryTypes)
      ? Array.from(PerformanceObserver.supportedEntryTypes)
      : [];
  if (!supported.includes("longtask")) {
    return { ok: false, reason: "PerformanceObserver.supportedEntryTypes 不含 longtask", supported };
  }

  const entries: PerformanceEntry[] = [];
  let observer: PerformanceObserver;
  try {
    observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) entries.push(entry);
    });
    observer.observe({ type: "longtask" });
  } catch (e) {
    return { ok: false, reason: `PerformanceObserver.observe 失败：${String(e)}`, supported };
  }

  const w = window as unknown as Record<string, ProbeState | undefined>;
  let state = w[a.key];
  if (state === undefined) {
    state = { start: null, windows: {}, nextWindowId: 1 };
    w[a.key] = state;
  }
  const id = state.nextWindowId;
  state.nextWindowId = id + 1;
  state.windows[id] = { observer, entries };
  return { ok: true, id };
}

/** 补上尚未派发的条目后断开观测，返回全部条目的 `startTime` 与 `duration`。 */
function closeLongTaskWindowInPage(a: CloseWindowArgs): CloseWindowOutcome {
  const w = window as unknown as Record<string, ProbeState | undefined>;
  const state = w[a.key];
  const recorder = state === undefined ? undefined : state.windows[a.id];
  if (state === undefined || recorder === undefined) {
    return { ok: false, reason: `页面里没有 longtask 观测窗口 #${a.id}（页面可能已导航 / 重载）` };
  }
  for (const entry of recorder.observer.takeRecords()) recorder.entries.push(entry);
  recorder.observer.disconnect();
  delete state.windows[a.id];
  return {
    ok: true,
    entries: recorder.entries.map((entry) => ({ startTime: entry.startTime, duration: entry.duration })),
  };
}

// ---------------------------------------------------------------------------
// Node 端 API
// ---------------------------------------------------------------------------

/**
 * 在触发元素上挂 capture 监听，记下 `type` 事件的 `event.timeStamp`：`which` 为 `"first"` 时
 * 记首个并随即摘掉监听，为 `"last"` 时每来一个覆盖一次，直到 `readStart`。
 * 须在触发动作（`click`、`pressSequentially`）之前 await 完成。
 */
export async function armStart(
  target: Locator,
  type: StartEventType,
  which: StartWhich = "first",
): Promise<void> {
  await target.evaluate(armStartInPage, { key: PROBE_KEY, type, which });
}

/**
 * 取出上一次 `armStart` 记下的时刻（页面时间原点起的毫秒）并摘掉监听。
 * 没有 `armStart` 记录（页面已导航）或其后没有收到事件时抛错。
 */
export async function readStart(page: Page): Promise<number> {
  const outcome = await page.evaluate(readStartInPage, { key: PROBE_KEY });
  if (!outcome.ok) throw new Error(`readStart：${outcome.reason}`);
  return outcome.time;
}

/**
 * 从下一帧起每个 rAF 回调判定一次 `pred(arg, kit)`，首次成立时返回该回调开头的
 * `performance.now()`；过了 `capMs`（默认 `TIMEOUTS.wait`）仍不成立返回 `null`。
 * 谓词不能在页面里重建、执行时抛错或返回非 boolean 时抛错。
 *
 * 调用本身不带超时以外的等待：返回前最多等 `capMs` 再加一次往返。调用方在每次取样前核对
 * 用例剩余时间（设计"性能观测"）。
 */
export async function waitFrame<A>(
  page: Page,
  pred: MeasurePredicate<InPage<A>>,
  arg: A,
  capMs: number = TIMEOUTS.wait,
): Promise<number | null> {
  if (!(Number.isFinite(capMs) && capMs > 0)) {
    throw new RangeError(`waitFrame：capMs 须为正的有限数，实得 ${capMs}`);
  }
  const args: WaitFrameArgs = { src: predicateSource(pred), arg, capMs };
  const outcome = await page.evaluate(waitFrameInPage, args);
  switch (outcome.kind) {
    case "hit":
      return outcome.time;
    case "cap":
      return null;
    default:
      throw new Error(`waitFrame：谓词在页面内出错：${outcome.message}`);
  }
}

/**
 * 打开 `longtask` 观测窗口。页面不支持 `longtask`，或建立观测失败时抛 `NoLongTaskError`
 * （14.7 的"无法建立 longtask 观测"）。
 */
export async function openLongTaskWindow(page: Page): Promise<LongTaskWindow> {
  const opened = await page.evaluate(openLongTaskWindowInPage, { key: PROBE_KEY });
  if (!opened.ok) throw new NoLongTaskError(opened.reason, opened.supported);

  const id = opened.id;
  let closing: Promise<LongTaskEntry[]> | null = null;
  const close = async (): Promise<LongTaskEntry[]> => {
    const outcome = await page.evaluate(closeLongTaskWindowInPage, { key: PROBE_KEY, id });
    if (!outcome.ok) throw new Error(`openLongTaskWindow().close()：${outcome.reason}`);
    return outcome.entries;
  };
  return {
    close() {
      if (closing === null) closing = close();
      return closing;
    },
  };
}

/**
 * 取谓词源码，并在 Node 端先按页面里的写法试编译一次（只解析、不执行），尽早报出不能搬运的
 * 写法。对象方法简写（`name(arg) { … }`）与 Playwright 一样补上 `function ` 前缀再试；
 * 原生函数、`bind` 出来的函数等源码不可用的，报 TypeError。
 */
function predicateSource(pred: (...args: never[]) => unknown): string {
  if (typeof pred !== "function") throw new TypeError("waitFrame：谓词必须是函数");
  const raw = String(pred).trim();
  for (const candidate of [raw, `function ${raw}`]) {
    try {
      new Function(`return (${candidate});`);
      return candidate;
    } catch {
      // 换下一种写法再试
    }
  }
  throw new TypeError(
    `waitFrame：谓词无法按源码在页面里重建，须是自包含的箭头函数或 function 表达式：${raw.slice(0, 120)}`,
  );
}
