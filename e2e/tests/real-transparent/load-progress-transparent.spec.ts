/**
 * Transparent_Mode 下的不确定态加载进度（需求 11.5，Checklist H10；Review_Shot RS-14
 * `progress-indeterminate`）。`real-transparent` 项目（:4622，Transparent_Mode，真实书库 `public/`），
 * 桌面视口，默认主题（`THEME_UNSET`，不 `seedTheme`）；不装 Controlled_Clock，以真实时钟运行（6.4）。
 *
 * ## 场景（两个用例相同）
 *
 * 全新浏览器上下文（6.1：IndexedDB 为空）中首次打开《极品全能高手》（`lib.role("huge")`，gz 约
 * 24 MB）。首次导航之前以 `throttle` fixture 施加 CDP 下行节流（`THROTTLE_BYTES_PER_SEC`，
 * `Network.emulateNetworkConditions`，不改响应头与响应字节），使 `.txt.gz` 的传输耗时 ≥ 3 s。
 * Transparent_Mode 的 `.txt.gz` 带 `Content-Encoding: gzip`（5.4），浏览器在 HTTP 层解压，应用走
 * `network-transparent` 分支：该分支拿不到百分比，整个加载期间只报不确定态。
 *
 * ## 11.5 用例（`reducedMotion: "no-preference"`，不拍摄）
 *
 * 6.3 的例外：以 `no-preference` 运行、不禁用动画，且不拍摄 Review_Shot 或 Pixel_Baseline 对比截图。
 * 全局的 `contextOptions: { reducedMotion: "reduce" }`（`playwright.config.ts`）由本文件一个
 * `describe` 内的 `test.use({ contextOptions: { reducedMotion: "no-preference" } })` 覆盖
 * （`contextOptions` 整体替换，不合并）；用例先核对页面确为 `no-preference`。
 *
 * 取样：进度条（`readerLoading().progress`）出现后，测试进程反复"取样一次 → 等
 * `PROGRESS_SAMPLE_MS`"，直到进度条脱离文档（加载视图卸下）。每次取样在页面内一次读完（只读，
 * 不改动页面）：`performance.now()`、进度条的 `aria-valuenow`、子元素个数，以及其内部短条（进度条
 * 唯一的子元素）的计算 `transform`。`PROGRESS_SAMPLE_MS` 是 6.5 允许的唯一固定等待，只用于分隔
 * 两次取样，不用于等待任何状态出现；取样何时开始、何时结束都由可观测条件决定。
 *
 * 判定（11.5）：
 * - 每次取样都不带 `aria-valuenow`（不确定态），且进度条恰有 1 个子元素（短条）。
 * - "≥ 3 次、相邻间隔 200–400 ms 的取样"：把取样按相邻间隔是否落在 200–400 ms 切成若干段
 *   （间隔越界处断开），至少有一段含 ≥ 3 次取样，且该段内短条的计算 `transform` 至少有 2 个
 *   不同的值（H10：短条在动）。下载结束后浏览器要把几十 MB 明文解码成字符串、应用再做码点检查，
 *   主线程忙碌期间的取样间隔会超过 400 ms，这些取样仍计入"每次取样都不带 aria-valuenow"，但不属于
 *   任何合格的段。
 *
 * ## RS-14 用例（默认 `reduce`）
 *
 * 进度条出现后先断言画面状态（不带 `aria-valuenow`、恰有一截短条、标题可见、说明文字不带百分比），
 * 再拍摄 `progress-indeterminate`；`shot()` 以 `animations: "disabled"` 取消无限循环动画，短条按
 * 不含动画的样式呈现在轨道左端。拍摄后核对同一个进度条元素仍在文档中且仍不带 `aria-valuenow`：加载
 * 视图只会卸下一次，拍摄前后都在，截图拍到的就是加载中的不确定态。
 *
 * ## 前提核对（两个用例都做，加载完成后）
 *
 * - 该书 gz 字节数按节流速率折算的传输时间 ≥ 3 s（导航前；否则节流速率须重新选取）。
 * - 响应头（Playwright 的 `response` 事件）：状态 200、`Content-Encoding: gzip`、`Content-Length`
 *   等于磁盘上 `.txt.gz` 的字节数（5.4）。
 * - 传输（页面的 Resource Timing 条目，只读）：`responseEnd − responseStart` ≥ 3 s；`encodedBodySize`
 *   （解码 `Content-Encoding` 之前的字节数）等于文件字节数，`decodedBodySize` 大于它（HTTP 层确实
 *   解压了响应体）。
 * - `[book-load]` 行为 `source=network-transparent`，其 `gz` 字段（该分支取 `Content-Length`）等于
 *   文件字节数的写法。`network-transparent` 同时表明内存与 IndexedDB 中原本都没有该书。
 *
 * 与 `e2e/tests/real/load-progress-opaque.spec.ts`（任务 13.2）相同，传输耗时不取 Playwright 的
 * `request.timing()`，也不等 `requestfinished`：CDP 下行节流下这个请求在响应体收完时报的是
 * `requestfailed`（`net::ERR_ABORTED`），页面的 Resource Timing 条目与应用的加载都不受影响。
 */
import type { JSHandle, Page, Response } from "@playwright/test";
import { formatBookLoadMetrics } from "../../../src/utils/loadMetrics";
import { txtUrl } from "../../../src/utils/locator";
import { parseBookLoadLine } from "../../perf/metrics";
import { SHOT_TESTS } from "../../review/catalog";
import { decodedPath } from "../../support/cache";
import { expect, test, type BookLog, type Lib, type Throttle } from "../../support/fixtures";
import { reader, readerLoading } from "../../support/locators";
import { bookUnderTest, readerPath, type BookUnderTest } from "../../support/reader";
import { PROGRESS_SAMPLE_MS, THROTTLE_BYTES_PER_SEC } from "../../support/settings";
import { step } from "../../support/step";

// ---------------------------------------------------------------------------
// 需求中的字面值
// ---------------------------------------------------------------------------

/** 11.5：`.txt.gz` 的传输耗时下限。 */
const MIN_TRANSFER_MS = 3_000;

/** 11.5：合格取样段内相邻两次取样的间隔区间（毫秒，含两端）。 */
const SAMPLE_INTERVAL_MS = { min: 200, max: 400 } as const;

/** 11.5：合格取样段的取样次数下限。 */
const MIN_RUN_SAMPLES = 3;

/** 11.5：合格取样段内短条 `transform` 不同值的个数下限。 */
const MIN_DISTINCT_TRANSFORMS = 2;

// ---------------------------------------------------------------------------
// 打开与前提核对（两个用例共用）
// ---------------------------------------------------------------------------

/** 已在节流下开始加载的一次打开。 */
interface ThrottledOpen {
  book: BookUnderTest;
  /** 该书 `.txt.gz` 的路径（百分号解码后），用于匹配响应与 Resource Timing 条目。 */
  gzPath: string;
  /** 该书 `.txt.gz` 的响应（响应头到达即结算）。 */
  gzResponse: Promise<Response>;
  /** 导航前的 `bookLog.count`。 */
  since: number;
}

/**
 * 核对节流速率、施加 CDP 下行节流，然后首次打开《极品全能高手》，等"书籍加载进度"进度条出现。
 * 须在用例体内调用（`bookUnderTest` 会把用例超时设为 `TIMEOUTS.bigBookTest`）。
 */
async function openThrottled(page: Page, lib: Lib, bookLog: BookLog, throttle: Throttle): Promise<ThrottledOpen> {
  const book = await bookUnderTest(lib, lib.role("huge"));
  const gzPath = decodeURIComponent(txtUrl(book.id));

  await step(
    `用例前提：${book.id}.txt.gz 共 ${book.gzBytes} 字节，按 ${THROTTLE_BYTES_PER_SEC} B/s 节流的传输时间 ≥ ${MIN_TRANSFER_MS} ms`,
    () => {
      const expectedMs = (book.gzBytes / THROTTLE_BYTES_PER_SEC) * 1000;
      expect(expectedMs, "按节流速率折算的传输时间（ms）").toBeGreaterThanOrEqual(MIN_TRANSFER_MS);
    },
  );

  await step(`首次导航之前施加 CDP 下行节流（${THROTTLE_BYTES_PER_SEC} B/s）`, async () => {
    await throttle();
  });

  // 响应头到达即结算（见文件头"前提核对"：节流下该请求不产生 requestfinished）
  const gzResponse = page.waitForResponse((response) => decodedPath(response.url()) === gzPath, {
    timeout: book.loadTimeout,
  });
  // 后面的步骤失败时不留下未处理的拒绝；成功路径仍 await 同一个 Promise
  void gzResponse.catch(() => undefined);
  const since = bookLog.count;

  await step(`打开 ${decodeURIComponent(readerPath(book.id))}，等“书籍加载进度”进度条出现`, async () => {
    await page.goto(readerPath(book.id));
    await expect(readerLoading(page).progress).toBeVisible();
  });

  return { book, gzPath, gzResponse, since };
}

/** 等加载完成：该书的 `[book-load]` 行出现、正文标题可见、进度条消失。 */
async function waitLoaded(page: Page, bookLog: BookLog, open: ThrottledOpen): Promise<void> {
  await step("等加载完成：该书的 [book-load] 行出现、正文标题可见、进度条消失", async () => {
    await bookLog.waitFor(open.book.id, undefined, { since: open.since, timeout: open.book.loadTimeout });
    await expect(reader(page).chapterHeading).toBeVisible();
    await expect(readerLoading(page).progress).toHaveCount(0);
  });
}

/** 页面 Resource Timing 中一个资源条目的读数（毫秒，页面的 `performance.now()` 时基）。 */
interface ResourceTimingReading {
  /** 资源的绝对 URL（百分号编码，与请求相同）。 */
  name: string;
  responseStart: number;
  responseEnd: number;
  /** 收到的响应体字节数（解码 `Content-Encoding` 之前）。 */
  encodedBodySize: number;
  /** 解码 `Content-Encoding` 之后的响应体字节数。 */
  decodedBodySize: number;
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
        decodedBodySize: r.decodedBodySize,
      };
    }),
  );
}

/** `[book-load]` 行里 `gz` 字段对 `bytes` 字节的写法（取应用自己的格式化，只取该字段）。 */
function gzToken(bytes: number): string {
  const text = formatBookLoadMetrics({
    bookId: "gz-token",
    source: "network-transparent",
    gzBytes: bytes,
    chars: 0,
    decompressMs: null,
    totalMs: 0,
  });
  const line = parseBookLoadLine(text);
  if (line === null) throw new Error(`无法解析 formatBookLoadMetrics 的输出：${text}`);
  return line.gz;
}

/** 加载完成后核对 Transparent_Mode 与节流是否如场景所述（见文件头"前提核对"）；返回该书的 Resource Timing 条目。 */
async function checkPreconditions(page: Page, bookLog: BookLog, open: ThrottledOpen): Promise<ResourceTimingReading> {
  const { book, gzPath } = open;

  await step(`前提：${book.id}.txt.gz 的响应头带 Content-Encoding: gzip（Transparent_Mode；节流不改响应头）`, async () => {
    const response = await open.gzResponse;
    const headers = await response.allHeaders();
    test.info().annotations.push({
      type: "progress-headers",
      description:
        `状态 ${response.status()}；Content-Length ${headers["content-length"] ?? "（无）"}；` +
        `Content-Encoding ${headers["content-encoding"] ?? "（无）"}；文件 ${book.gzBytes} 字节`,
    });
    expect(response.status(), ".txt.gz 响应状态").toBe(200);
    expect(headers["content-encoding"], "Transparent_Mode 的 .txt.gz 响应带 Content-Encoding: gzip").toBe("gzip");
    expect(headers["content-length"], "Content-Length 应等于 .txt.gz 文件的字节数").toBe(String(book.gzBytes));
  });

  const entry = await step(
    `前提：${book.id}.txt.gz 的传输耗时 ≥ ${MIN_TRANSFER_MS} ms，收到的响应体字节数等于文件字节数且经 HTTP 层解压`,
    async () => {
      const entries = (await readResourceTimings(page)).filter((e) => decodedPath(e.name) === gzPath);
      test.info().annotations.push({
        type: "progress-transfer",
        description: entries
          .map(
            (e) =>
              `Resource Timing：responseStart ${e.responseStart.toFixed(0)} ms、responseEnd ${e.responseEnd.toFixed(0)} ms，` +
              `传输 ${(e.responseEnd - e.responseStart).toFixed(0)} ms；encodedBodySize ${e.encodedBodySize}；` +
              `decodedBodySize ${e.decodedBodySize}`,
          )
          .join("；"),
      });
      expect(entries.length, `${book.id}.txt.gz 的 Resource Timing 条目数`).toBe(1);
      const [only] = entries;
      expect(only.responseStart, "responseStart 应可读（同源资源）").toBeGreaterThan(0);
      expect(only.responseEnd - only.responseStart, `响应体传输耗时（ms）应 ≥ ${MIN_TRANSFER_MS}`).toBeGreaterThanOrEqual(
        MIN_TRANSFER_MS,
      );
      expect(only.encodedBodySize, "收到的响应体字节数（解码前）应等于 .txt.gz 文件的字节数").toBe(book.gzBytes);
      expect(only.decodedBodySize, "解码后的响应体字节数应大于解码前（HTTP 层解压了响应体）").toBeGreaterThan(
        only.encodedBodySize,
      );
      return only;
    },
  );

  await step("前提：[book-load] 为 source=network-transparent，gz 字段为 .txt.gz 文件的字节数", () => {
    const line = bookLog.find(book.id, undefined, open.since);
    if (line === undefined) throw new Error(`没有收到 ${book.id} 的 [book-load] 行`);
    expect(line.source, "Transparent_Mode 下全新上下文首次打开的来源分支").toBe("network-transparent");
    expect(line.gz, `gz 字段（文件 ${book.gzBytes} 字节）`).toBe(gzToken(book.gzBytes));
  });

  return entry;
}

// ---------------------------------------------------------------------------
// 页面内读数
// ---------------------------------------------------------------------------

/** 11.5 的一次取样。 */
interface IndeterminateSample {
  /** 页面的 `performance.now()`（毫秒）。 */
  t: number;
  /** `aria-valuenow` 原样；不带该属性（不确定态）时为 null。 */
  valueNow: string | null;
  /** 进度条的子元素个数（不确定态为 1 截短条）。 */
  bars: number;
  /** 首个子元素（短条）的计算 `transform`；没有子元素时为 null。 */
  transform: string | null;
}

/** 取样一次（只读）；进度条已脱离文档时为 null。 */
function takeSample(progress: JSHandle<Element>): Promise<IndeterminateSample | null> {
  return progress.evaluate((el): IndeterminateSample | null => {
    const t = performance.now();
    if (!el.isConnected) return null;
    const bar = el.firstElementChild;
    return {
      t,
      valueNow: el.getAttribute("aria-valuenow"),
      bars: el.childElementCount,
      transform: bar === null ? null : getComputedStyle(bar).transform,
    };
  });
}

/** 进度条此刻的状态（只读）：是否仍在文档中、`aria-valuenow`、子元素个数。 */
function readBarState(progress: JSHandle<Element>): Promise<{ connected: boolean; valueNow: string | null; bars: number }> {
  return progress.evaluate((el) => ({
    connected: el.isConnected,
    valueNow: el.getAttribute("aria-valuenow"),
    bars: el.childElementCount,
  }));
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

/** 一段取样：取样序号 `from`–`to`（含两端），段内相邻间隔都在 `SAMPLE_INTERVAL_MS` 内。 */
interface SampleRun {
  from: number;
  to: number;
  /** 段内短条 `transform` 的不同值个数。 */
  distinct: number;
}

/** 按相邻间隔是否落在 `SAMPLE_INTERVAL_MS` 内把取样切段（间隔越界处断开）。 */
function sampleRuns(samples: readonly IndeterminateSample[]): SampleRun[] {
  const runs: SampleRun[] = [];
  let from = 0;
  for (let i = 1; i <= samples.length; i++) {
    const gap = i < samples.length ? samples[i].t - samples[i - 1].t : Number.NaN;
    if (i === samples.length || gap < SAMPLE_INTERVAL_MS.min || gap > SAMPLE_INTERVAL_MS.max) {
      if (samples.length > 0) {
        const transforms = new Set(samples.slice(from, i).map((s) => s.transform));
        runs.push({ from, to: i - 1, distinct: transforms.size });
      }
      from = i;
    }
  }
  return runs;
}

// ---------------------------------------------------------------------------
// 11.5（no-preference、真实时钟、不拍摄）
// ---------------------------------------------------------------------------

test.describe("11.5 以 prefers-reduced-motion: no-preference 运行（6.3 的例外，不拍摄）", () => {
  // contextOptions 整体替换全局的 { reducedMotion: "reduce" }（见 playwright.config.ts）
  test.use({ contextOptions: { reducedMotion: "no-preference" } });

  test(
    "11.5 Transparent_Mode 节流首次打开《极品全能高手》：每次取样进度条都不带 aria-valuenow，内部短条的 transform 在真实时钟取样中变化（H10）",
    async ({ page, lib, bookLog, throttle }) => {
      const open = await openThrottled(page, lib, bookLog, throttle);
      const loading = readerLoading(page);

      await step("前提：页面为 prefers-reduced-motion: no-preference（不禁用动画）", async () => {
        const noPreference = await page.evaluate(
          () => window.matchMedia("(prefers-reduced-motion: no-preference)").matches,
        );
        expect(noPreference, "matchMedia('(prefers-reduced-motion: no-preference)').matches").toBe(true);
      });

      const samples = await step(
        `取样：每次读 aria-valuenow 与短条的计算 transform，两次之间隔 ${PROGRESS_SAMPLE_MS} ms，直到进度条脱离文档`,
        async () => {
          const handle = await loading.progress.evaluateHandle((el) => el);
          const taken: IndeterminateSample[] = [];
          const deadline = Date.now() + open.book.loadTimeout;
          try {
            for (;;) {
              const sample = await takeSample(handle);
              if (sample === null) break;
              taken.push(sample);
              if (Date.now() > deadline) {
                throw new Error(`进度条 ${open.book.loadTimeout} ms 后仍在文档中（已取样 ${taken.length} 次）`);
              }
              // 6.5 唯一的固定等待：只分隔两次取样，不等待任何状态
              await page.waitForTimeout(PROGRESS_SAMPLE_MS);
            }
          } finally {
            await handle.dispose();
          }
          return taken;
        },
      );

      await waitLoaded(page, bookLog, open);
      const transfer = await checkPreconditions(page, bookLog, open);

      const intervals = samples.slice(1).map((s, i) => s.t - samples[i].t);
      const runs = sampleRuns(samples);
      const inTransfer = samples.filter((s) => s.t >= transfer.responseStart && s.t <= transfer.responseEnd).length;
      test.info().annotations.push({
        type: "progress-samples",
        description:
          `取样 ${samples.length} 次（传输期间 ${inTransfer} 次），aria-valuenow：` +
          `${compactValues(samples.map((s) => s.valueNow ?? "无"))}；` +
          (intervals.length > 0
            ? `相邻间隔 ${Math.min(...intervals).toFixed(1)}–${Math.max(...intervals).toFixed(1)} ms；`
            : "") +
          `间隔 ${SAMPLE_INTERVAL_MS.min}–${SAMPLE_INTERVAL_MS.max} ms 的取样段：` +
          runs.map((r) => `#${r.from}–#${r.to}（${r.to - r.from + 1} 次，transform ${r.distinct} 种）`).join("、"),
      });
      test.info().annotations.push({
        type: "progress-transforms",
        description: compactValues(samples.map((s) => s.transform ?? "（无短条）")),
      });

      await step("11.5 每次取样中进度条都不带 aria-valuenow（不确定态），且内部恰有 1 截短条", () => {
        expect(samples.length, "取样次数").toBeGreaterThan(0);
        const valued = samples.map((s, i) => ({ i, valueNow: s.valueNow })).filter((s) => s.valueNow !== null);
        expect(valued, "带 aria-valuenow 的取样（i 为取样序号）").toEqual([]);
        const barless = samples.map((s, i) => ({ i, bars: s.bars })).filter((s) => s.bars !== 1);
        expect(barless, "子元素个数不为 1 的取样（i 为取样序号）").toEqual([]);
      });

      await step(
        `11.5 有一段 ≥ ${MIN_RUN_SAMPLES} 次、相邻间隔 ${SAMPLE_INTERVAL_MS.min}–${SAMPLE_INTERVAL_MS.max} ms 的取样，` +
          `其中短条的 transform 至少有 ${MIN_DISTINCT_TRANSFORMS} 个不同的值（H10）`,
        () => {
          const longEnough = runs.filter((r) => r.to - r.from + 1 >= MIN_RUN_SAMPLES);
          expect(longEnough.length, `≥ ${MIN_RUN_SAMPLES} 次取样的合格段数`).toBeGreaterThan(0);
          const moving = longEnough.filter((r) => r.distinct >= MIN_DISTINCT_TRANSFORMS);
          expect(moving.length, `transform 至少 ${MIN_DISTINCT_TRANSFORMS} 种的合格段数`).toBeGreaterThan(0);
        },
      );
    },
  );
});

// ---------------------------------------------------------------------------
// RS-14（默认 reduce，拍摄）
// ---------------------------------------------------------------------------

test(SHOT_TESTS.progressIndeterminate.title, async ({ page, lib, bookLog, throttle, shot }) => {
  const open = await openThrottled(page, lib, bookLog, throttle);
  const loading = readerLoading(page);
  const handle = await loading.progress.evaluateHandle((el) => el);

  await step("RS-14 画面：进度条为不确定态（不带 aria-valuenow），轨道内有一截短条，说明文字不带百分比", async () => {
    await expect(loading.progress, "不确定态进度条不带 aria-valuenow").not.toHaveAttribute("aria-valuenow");
    await expect(loading.heading).toBeVisible();
    await expect(loading.percentNote, "说明文字不应带百分比").toHaveCount(0);
    expect((await readBarState(handle)).bars, "进度条内的短条个数").toBe(1);
  });

  await shot("progress-indeterminate");

  await step("RS-14 拍摄后同一个进度条仍在文档中且仍不带 aria-valuenow（拍到的是加载中的不确定态）", async () => {
    const after = await readBarState(handle);
    await handle.dispose();
    test.info().annotations.push({
      type: "progress-shot",
      description: `拍摄后：${after.connected ? "仍在文档中" : "已脱离文档"}；aria-valuenow ${after.valueNow ?? "无"}；短条 ${after.bars} 截`,
    });
    expect(after.connected, "拍摄后进度条仍在文档中").toBe(true);
    expect(after.valueNow, "拍摄后进度条仍不带 aria-valuenow").toBeNull();
  });

  await waitLoaded(page, bookLog, open);
  await checkPreconditions(page, bookLog, open);
});
