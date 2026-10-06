/**
 * Opaque_Mode 下的确定态加载进度（需求 11.1；Review_Shot RS-15 `progress-determinate`）。`fixture`
 * 项目（:4611，Opaque_Mode，Fixture_Library），桌面视口，默认主题（`THEME_UNSET`，不 `seedTheme`），
 * `prefers-reduced-motion: reduce`（6.3）；不装 Controlled_Clock，以真实时钟运行。
 *
 * 承接 real 档移除前的同一用例（test-data-desensitization 需求 4.2 (b)、4.3）：取样、判定、前提
 * 核对与拍摄的步骤不变；书改为 Fixture_Library 中 huge 用途那本书，节流打开时的等待上限按传输量
 * 折算（见"等待上限"）。
 *
 * ## 场景
 *
 * 全新浏览器上下文（6.1：IndexedDB 为空）中首次打开 huge 用途那本书（`lib.role("huge")`：书 id 取自
 * `roles.json`；该书不具备"节点数 ≥ 3,000"的用途特征时 `lib.role()` 抛错，用例判失败）。字节数等
 * 期望值在运行时从磁盘上的文件取得（4.4），源码里不写书 id 与字节数。首次导航之前以 `throttle`
 * fixture 施加 CDP 下行节流（`THROTTLE_BYTES_PER_SEC`，`Network.emulateNetworkConditions`，不改响应头
 * 与响应字节），使 `.txt.gz` 的传输耗时 ≥ 3 s。
 *
 * ## 等待上限
 *
 * 节流作用于整个页面：App_Build、该书的 `_toc.json` 与 `.txt.gz` 都按同一速率传输。阅读器取完
 * `_toc.json` 才取 `.txt.gz`，"书籍加载进度"进度条在取 `_toc.json` 时就已出现。`bookUnderTest` 给出
 * 的 `loadTimeout` 不含节流下的传输时间（Fixture_Library 的书都小于 `BIG_BOOK_GZ_BYTES`，它就是
 * `TIMEOUTS.wait`），所以节流打开时的等待上限取 `loadTimeout` 加上该等待所跨字节按节流速率折算的
 * 传输时间（向上取整到毫秒；字节数在运行时取自磁盘，见 `throttledBudget`）：
 *
 * - 进度条出现之后开始的等待（`aria-valuenow` 到达拍摄时机、该书的 `[book-load]` 行）：加上
 *   `_toc.json` 与 `.txt.gz` 的字节数；
 * - 导航之前登记的等待（`.txt.gz` 的响应）：再加上 App_Build 全部文件的字节数。
 *
 * `[book-load]` 行由 `bookLog` 监听页面控制台得到，各项目都解析；`book-load` 附件只在 `perf` 项目
 * 写，这里的等待与核对都不依赖附件。
 *
 * ## 取样（11.1：以真实时钟每 100–300 ms 取样一次）
 *
 * "书籍加载进度"进度条（`readerLoading().progress`）出现后，从这个经 `locators.ts` 定位到的元素
 * 出发，在页面内以 `setInterval`（周期 `DETERMINATE_SAMPLE_MS`）读它的 `aria-valuenow`（只读，
 * 不改动页面），每次记下 `performance.now()` 与属性值；元素脱离文档（加载视图卸下）即停止。
 * 测试进程不做固定时长等待（6.5），它等的是：进度条出现、`aria-valuenow` 到达拍摄时机、该书的
 * `[book-load]` 行与正文标题。取样周期本身不是等待，也不用于等待任何状态出现。
 *
 * 判定（11.1）只看带 `aria-valuenow` 的取样：不少于 5 次；值均为 0–100 的整数；后一次不小于前一次；
 * 至少 2 个不同的值。另核对取样方法本身：从第一次到最后一次带值的取样之间，相邻取样的实际间隔都
 * 在 100–300 ms 内。取 `_toc.json` 期间（进度条为不确定态）与解压阶段（下载完成后，进度条回到
 * 不确定态，主线程可能长时间忙碌）都不在核对范围内。
 *
 * ## 前提核对
 *
 * - 该书 gz 字节数按节流速率折算的传输时间 ≥ 3 s（导航前；不成立时用例失败，节流速率须重新选取）。
 * - 加载完成后：
 *   - 响应头（Playwright 的 `response` 事件）：状态 200、不带 `Content-Encoding`、`Content-Length`
 *     等于磁盘上 `.txt.gz` 的字节数。
 *   - 传输（页面的 Resource Timing 条目，只读）：`responseEnd − responseStart` ≥ 3 s，
 *     `encodedBodySize` 等于该文件的字节数。
 *   - `[book-load]` 行为 `source=network`，其 `gz` 字段等于该文件字节数的写法。`source=network`
 *     同时表明 IndexedDB 中原本没有该书的记录。
 *
 * 传输耗时不取 Playwright 的 `request.timing()`：本机实测（Playwright 1.62.1、Chromium 151）在
 * CDP 下行节流下，这个请求不产生 `requestfinished`，而是在响应体收完的那一刻产生 `requestfailed`
 * （`net::ERR_ABORTED`）；同一时刻页面的 Resource Timing 条目完整（`encodedBodySize` 等于文件
 * 字节数），应用也照常解压并渲染。这是 DevTools 对节流请求的报告方式，与应用无关，所以不等
 * `requestfinished`，传输耗时读页面自己的 Resource Timing。
 *
 * ## RS-15
 *
 * `aria-valuenow` 到达 20–99 时拍摄（< 5 % 时填充宽度钳到 5 %，与显示的百分比不同；20 % 起填充
 * 明显可辨，且离下载结束还有数秒），拍摄前断言说明文字带百分比。拍摄前后各读一次页面的
 * `performance.now()`，事后以取样核对：拍摄开始之前与结束之后都有带值的取样，拍摄期间的取样也都
 * 带值。加载进度只会从不确定态进入确定态、下载结束时再回到不确定态各一次，所以截图拍到的是确定态。
 */
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { JSHandle, Locator, Page } from "@playwright/test";
import { formatBookLoadMetrics } from "../../../src/utils/loadMetrics";
import { txtUrl } from "../../../src/utils/locator";
import { parseBookLoadLine } from "../../perf/metrics";
import { SHOT_TESTS } from "../../review/catalog";
import { decodedPath } from "../../support/cache";
import { expect, test, type Lib } from "../../support/fixtures";
import { libRootFor, tocPath } from "../../support/library";
import { reader, readerLoading } from "../../support/locators";
import { bookUnderTest, readerPath, type BookUnderTest } from "../../support/reader";
import { DETERMINATE_SAMPLE_MS, THROTTLE_BYTES_PER_SEC } from "../../support/settings";
import { step } from "../../support/step";

// ---------------------------------------------------------------------------
// 需求中的字面值
// ---------------------------------------------------------------------------

/** 11.1：`.txt.gz` 的传输耗时下限。 */
const MIN_TRANSFER_MS = 3_000;

/** 11.1：相邻两次取样的间隔区间（毫秒，含两端）。 */
const SAMPLE_INTERVAL_MS = { min: 100, max: 300 } as const;

/** 11.1：带 `aria-valuenow` 的取样次数下限。 */
const MIN_VALUED_SAMPLES = 5;

/** 11.1：带值取样中不同值的个数下限。 */
const MIN_DISTINCT_VALUES = 2;

/** RS-15 的拍摄时机：`aria-valuenow` 为 20–99（见文件头"RS-15"）。 */
const SHOT_VALUE_NOW = /^[2-9]\d$/;

// ---------------------------------------------------------------------------
// 节流下的等待上限（见文件头"等待上限"）
// ---------------------------------------------------------------------------

/** 仓库根（本文件位于 `e2e/tests/fixture/`）。 */
const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));

/**
 * App_Build 的目录，与 `e2e/support/build-app.ts` 的 `APP_BUILD_DIR` 相同。不从那里导入：它静态导入
 * Vite，worker 会因此加载 Vite（`e2e/support/fixtures.ts` 的 `APP_INDEX_HTML` 同理）。
 */
const APP_BUILD_DIR = path.join(REPO_ROOT, "e2e", ".out", "app");

/** 节流打开一本书时各项等待的上限（毫秒）与折算所用的字节数。 */
interface ThrottledBudget {
  /** 进度条出现之后开始的等待：`loadTimeout` 加上 `_toc.json` 与 `.txt.gz` 的传输时间。 */
  afterProgress: number;
  /** 导航之前登记的等待：`afterProgress` 再加上 App_Build 的传输时间。 */
  fromNavigation: number;
  /** 未节流时的等待上限（`bookUnderTest` 的 `loadTimeout`）。 */
  loadTimeout: number;
  /** App_Build 全部文件、该书 `_toc.json` 与 `.txt.gz` 的字节数（运行时取自磁盘）。 */
  bytes: { app: number; toc: number; gz: number };
}

/** `bytes` 字节按 `THROTTLE_BYTES_PER_SEC` 折算的传输时间（毫秒，向上取整）。 */
function transferMs(bytes: number): number {
  return Math.ceil((bytes / THROTTLE_BYTES_PER_SEC) * 1000);
}

/** `dir` 下全部文件的字节数之和（递归，只读元数据）。 */
async function treeBytes(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? await treeBytes(full) : (await stat(full)).size;
  }
  return total;
}

/** 按节流速率折算 `book` 的各项等待上限（见文件头"等待上限"）。 */
async function throttledBudget(lib: Lib, book: BookUnderTest): Promise<ThrottledBudget> {
  const [app, tocStat] = await Promise.all([
    treeBytes(APP_BUILD_DIR),
    stat(tocPath(libRootFor(lib.profile), book.id)),
  ]);
  const bytes = { app, toc: tocStat.size, gz: book.gzBytes };
  const afterProgress = book.loadTimeout + transferMs(bytes.toc + bytes.gz);
  return {
    afterProgress,
    fromNavigation: afterProgress + transferMs(bytes.app),
    loadTimeout: book.loadTimeout,
    bytes,
  };
}

/** 等待上限的读数（注解用）。 */
function describeBudget(b: ThrottledBudget): string {
  return (
    `进度条出现之后的等待上限 ${b.afterProgress} ms（loadTimeout ${b.loadTimeout} ms + ` +
    `_toc.json ${b.bytes.toc} 字节与 .txt.gz ${b.bytes.gz} 字节的传输 ${transferMs(b.bytes.toc + b.bytes.gz)} ms）；` +
    `导航之前登记的等待上限 ${b.fromNavigation} ms（另加 App_Build ${b.bytes.app} 字节的传输 ${transferMs(b.bytes.app)} ms）；` +
    `节流 ${THROTTLE_BYTES_PER_SEC} B/s`
  );
}

// ---------------------------------------------------------------------------
// 页面内取样
// ---------------------------------------------------------------------------

/** 一次取样。 */
interface ProgressSample {
  /** 页面的 `performance.now()`（毫秒）。 */
  t: number;
  /** `aria-valuenow` 原样；不带该属性（不确定态）时为 null。 */
  valueNow: string | null;
}

/** 取样器的读数。 */
interface SamplerReading {
  samples: ProgressSample[];
  /** 发现进度条已脱离文档的时刻（页面的 `performance.now()`）；取样停止时仍在文档中则为 null。 */
  detachedAt: number | null;
}

/** 页面内的取样器（经 `JSHandle` 持有）。 */
interface PageSampler {
  read(): SamplerReading;
  stop(): void;
}

/**
 * 在页面内开始取样：立即取一次，此后每 `periodMs` 取一次 `progress` 元素的 `aria-valuenow`，
 * 直到该元素脱离文档或 `stop()`。`progress` 须已在文档中（经 `locators.ts` 定位）。
 */
function startSampler(progress: Locator, periodMs: number): Promise<JSHandle<PageSampler>> {
  return progress.evaluateHandle((el, ms): PageSampler => {
    const samples: ProgressSample[] = [];
    let detachedAt: number | null = null;
    let timer = 0;
    const take = (): void => {
      const t = performance.now();
      if (!el.isConnected) {
        detachedAt = t;
        window.clearInterval(timer);
        return;
      }
      samples.push({ t, valueNow: el.getAttribute("aria-valuenow") });
    };
    timer = window.setInterval(take, ms);
    take();
    return {
      read: () => ({ samples: samples.slice(), detachedAt }),
      stop: () => window.clearInterval(timer),
    };
  }, periodMs);
}

/** 页面 Resource Timing 中一个资源条目的读数（毫秒，页面的 `performance.now()` 时基）。 */
interface ResourceTimingReading {
  /** 资源的绝对 URL（百分号编码，与请求相同）。 */
  name: string;
  responseStart: number;
  responseEnd: number;
  /** 收到的响应体字节数（解码 `Content-Encoding` 之前）。 */
  encodedBodySize: number;
}

/** 读页面的全部 `resource` 性能条目（只读）。 */
function readResourceTimings(page: Page): Promise<ResourceTimingReading[]> {
  return page.evaluate(() =>
    performance.getEntriesByType("resource").map((e) => {
      const r = e as PerformanceResourceTiming;
      return {
        name: r.name,
        responseStart: r.responseStart,
        responseEnd: r.responseEnd,
        encodedBodySize: r.encodedBodySize,
      };
    }),
  );
}

/** 页面当前的 `performance.now()`（与取样的 `t` 同一时基）。 */
function pageNow(page: Page): Promise<number> {
  return page.evaluate(() => performance.now());
}

/** 属性值是否为 0–100 的整数（十进制、无前导零、无符号与空白）。 */
function isPercentInteger(value: string): boolean {
  return /^(?:0|[1-9]\d*)$/.test(value) && Number(value) <= 100;
}

/** 取样值的紧凑写法：连续相同的值合并为 `值×次数`。 */
function compactValues(values: readonly string[]): string {
  const runs: { value: string; n: number }[] = [];
  for (const value of values) {
    const last = runs[runs.length - 1];
    if (last !== undefined && last.value === value) last.n += 1;
    else runs.push({ value, n: 1 });
  }
  return runs.map((r) => (r.n > 1 ? `${r.value}×${r.n}` : r.value)).join(", ");
}

// ---------------------------------------------------------------------------
// 期望值
// ---------------------------------------------------------------------------

/** `[book-load]` 行里 `gz` 字段对 `bytes` 字节的写法（取应用自己的格式化，只取该字段）。 */
function gzToken(bytes: number): string {
  const text = formatBookLoadMetrics({
    bookId: "gz-token",
    source: "network",
    gzBytes: bytes,
    chars: 0,
    decompressMs: null,
    totalMs: 0,
  });
  const line = parseBookLoadLine(text);
  if (line === null) throw new Error(`无法解析 formatBookLoadMetrics 的输出：${text}`);
  return line.gz;
}

// ---------------------------------------------------------------------------
// 11.1 与 RS-15
// ---------------------------------------------------------------------------

test(SHOT_TESTS.progressDeterminate.title, async ({ page, lib, bookLog, throttle, shot }) => {
  const book = await bookUnderTest(lib, lib.role("huge"));
  const gzPath = decodeURIComponent(txtUrl(book.id));
  const loading = readerLoading(page);

  await step(
    `用例前提：${book.id}.txt.gz 共 ${book.gzBytes} 字节，按 ${THROTTLE_BYTES_PER_SEC} B/s 节流的传输时间 ≥ ${MIN_TRANSFER_MS} ms`,
    () => {
      const expectedMs = (book.gzBytes / THROTTLE_BYTES_PER_SEC) * 1000;
      expect(expectedMs, "按节流速率折算的传输时间（ms）").toBeGreaterThanOrEqual(MIN_TRANSFER_MS);
    },
  );

  const budget = await step("按节流速率折算等待上限（App_Build、_toc.json 与 .txt.gz 的字节数取自磁盘）", async () => {
    const result = await throttledBudget(lib, book);
    test.info().annotations.push({ type: "progress-budget", description: describeBudget(result) });
    return result;
  });

  await step(`首次导航之前施加 CDP 下行节流（${THROTTLE_BYTES_PER_SEC} B/s）`, async () => {
    await throttle();
  });

  // 响应头到达即结算（见文件头"前提核对"：节流下该请求不产生 requestfinished）；导航之前登记，
  // 上限自导航起算（见文件头"等待上限"）
  const gzResponse = page.waitForResponse((response) => decodedPath(response.url()) === gzPath, {
    timeout: budget.fromNavigation,
  });
  // 前面的步骤失败时不留下未处理的拒绝；成功路径仍 await 同一个 Promise
  void gzResponse.catch(() => undefined);
  const since = bookLog.count;

  await step(`打开 ${decodeURIComponent(readerPath(book.id))}，等“书籍加载进度”进度条出现`, async () => {
    await page.goto(readerPath(book.id));
    await expect(loading.progress).toBeVisible();
  });

  const sampler = await step(`开始在页面内每 ${DETERMINATE_SAMPLE_MS} ms 读一次进度条的 aria-valuenow`, () =>
    startSampler(loading.progress, DETERMINATE_SAMPLE_MS),
  );

  await step("RS-15 画面：进度条为确定态，aria-valuenow 为 20–99，说明文字带百分比", async () => {
    await expect(loading.progress, "确定态进度条的 aria-valuenow").toHaveAttribute("aria-valuenow", SHOT_VALUE_NOW, {
      timeout: budget.afterProgress,
    });
    await expect(loading.heading).toBeVisible();
    await expect(loading.percentNote, "说明文字应带百分比“(N%)”").toBeVisible();
  });

  const shotStart = await pageNow(page);
  await shot("progress-determinate");
  const shotEnd = await pageNow(page);

  await step("等加载完成：该书的 [book-load] 行出现、正文标题可见、进度条消失", async () => {
    await bookLog.waitFor(book.id, undefined, { since, timeout: budget.afterProgress });
    await expect(reader(page).chapterHeading).toBeVisible();
    await expect(loading.progress).toHaveCount(0);
  });

  const reading = await step("停止取样并取回读数", async () => {
    const result = await sampler.evaluate((s) => {
      s.stop();
      return s.read();
    });
    await sampler.dispose();
    return result;
  });

  const valued = reading.samples.filter((s): s is ProgressSample & { valueNow: string } => s.valueNow !== null);
  const values = valued.map((s) => s.valueNow);
  const firstValued = reading.samples.findIndex((s) => s.valueNow !== null);
  const lastValued = reading.samples.map((s) => s.valueNow !== null).lastIndexOf(true);
  const intervals =
    firstValued < 0
      ? []
      : reading.samples
          .slice(firstValued + 1, lastValued + 1)
          .map((s, i) => s.t - reading.samples[firstValued + i].t);
  test.info().annotations.push({
    type: "progress-samples",
    description:
      `取样 ${reading.samples.length} 次，其中带 aria-valuenow ${valued.length} 次：${compactValues(values)}；` +
      (intervals.length > 0
        ? `带值区间内相邻间隔 ${Math.min(...intervals).toFixed(1)}–${Math.max(...intervals).toFixed(1)} ms；`
        : "") +
      (reading.detachedAt === null
        ? "停止取样前取样器尚未轮到发现进度条脱离文档"
        : `取样器于 ${reading.detachedAt.toFixed(0)} ms 发现进度条脱离文档`),
  });

  await step(`前提：${book.id}.txt.gz 的响应头（节流不改响应头）`, async () => {
    const response = await gzResponse;
    const headers = await response.allHeaders();
    test.info().annotations.push({
      type: "progress-headers",
      description:
        `状态 ${response.status()}；Content-Length ${headers["content-length"] ?? "（无）"}；` +
        `Content-Encoding ${headers["content-encoding"] ?? "（无）"}；文件 ${book.gzBytes} 字节`,
    });
    expect(response.status(), ".txt.gz 响应状态").toBe(200);
    expect(headers["content-encoding"], "Opaque_Mode 的 .txt.gz 响应不带 Content-Encoding").toBeUndefined();
    expect(headers["content-length"], "Content-Length 应等于 .txt.gz 文件的字节数").toBe(String(book.gzBytes));
  });

  await step(`前提：${book.id}.txt.gz 的传输耗时 ≥ ${MIN_TRANSFER_MS} ms，收到的响应体字节数等于文件字节数`, async () => {
    const entries = (await readResourceTimings(page)).filter((e) => decodedPath(e.name) === gzPath);
    test.info().annotations.push({
      type: "progress-transfer",
      description: entries
        .map(
          (e) =>
            `Resource Timing：responseStart ${e.responseStart.toFixed(0)} ms、responseEnd ${e.responseEnd.toFixed(0)} ms，` +
            `传输 ${(e.responseEnd - e.responseStart).toFixed(0)} ms；encodedBodySize ${e.encodedBodySize}`,
        )
        .join("；"),
    });
    expect(entries.length, `${book.id}.txt.gz 的 Resource Timing 条目数`).toBe(1);
    const [entry] = entries;
    expect(entry.responseStart, "responseStart 应可读（同源资源）").toBeGreaterThan(0);
    expect(entry.responseEnd - entry.responseStart, `响应体传输耗时（ms）应 ≥ ${MIN_TRANSFER_MS}`).toBeGreaterThanOrEqual(
      MIN_TRANSFER_MS,
    );
    expect(entry.encodedBodySize, "收到的响应体字节数应等于 .txt.gz 文件的字节数").toBe(book.gzBytes);
  });

  await step("前提：[book-load] 为 source=network，gz 字段为 .txt.gz 文件的字节数", () => {
    const line = bookLog.find(book.id, undefined, since);
    if (line === undefined) throw new Error(`没有收到 ${book.id} 的 [book-load] 行`);
    expect(line.source, "全新上下文首次打开的来源分支").toBe("network");
    expect(line.gz, `gz 字段（文件 ${book.gzBytes} 字节）`).toBe(gzToken(book.gzBytes));
  });

  await step(`11.1 取样方法：带值区间内相邻取样间隔在 ${SAMPLE_INTERVAL_MS.min}–${SAMPLE_INTERVAL_MS.max} ms`, () => {
    const outside = intervals
      .map((ms, i) => ({ i: firstValued + i + 1, ms }))
      .filter(({ ms }) => ms < SAMPLE_INTERVAL_MS.min || ms > SAMPLE_INTERVAL_MS.max);
    expect(outside, "超出区间的间隔（i 为取样序号，ms 为与前一次的间隔）").toEqual([]);
  });

  await step(`11.1 带 aria-valuenow 的取样不少于 ${MIN_VALUED_SAMPLES} 次`, () => {
    expect(valued.length, "带 aria-valuenow 的取样次数").toBeGreaterThanOrEqual(MIN_VALUED_SAMPLES);
  });

  await step("11.1 取样值均为 0–100 的整数", () => {
    expect(values.filter((v) => !isPercentInteger(v)), "不是 0–100 整数的取样值").toEqual([]);
  });

  await step("11.1 后一次取样值不小于前一次", () => {
    const decreases = values
      .map((v, i) => ({ i, from: i > 0 ? values[i - 1] : v, to: v }))
      .filter(({ from, to }) => Number(to) < Number(from));
    expect(decreases, "取样值下降之处（i 为带值取样的序号）").toEqual([]);
  });

  await step(`11.1 至少出现 ${MIN_DISTINCT_VALUES} 个不同的值`, () => {
    expect(new Set(values).size, "不同的取样值个数").toBeGreaterThanOrEqual(MIN_DISTINCT_VALUES);
  });

  await step("RS-15 拍摄期间进度条始终为确定态：拍摄前后都有带值的取样，拍摄期间的取样都带值", () => {
    const during = reading.samples.filter((s) => s.t >= shotStart && s.t <= shotEnd);
    test.info().annotations.push({
      type: "progress-shot",
      description:
        `拍摄于页面时刻 ${shotStart.toFixed(0)}–${shotEnd.toFixed(0)} ms；期间取样 ` +
        (during.length > 0 ? during.map((s) => s.valueNow ?? "无").join(", ") : "（无）"),
    });
    expect(valued.some((s) => s.t <= shotStart), "拍摄开始之前应有带值的取样").toBe(true);
    expect(valued.some((s) => s.t >= shotEnd), "拍摄结束之后应有带值的取样").toBe(true);
    expect(during.filter((s) => s.valueNow === null).length, "拍摄期间不带值的取样数").toBe(0);
  });
});
