/**
 * 阅读器：整本下载（需求 10.1、10.2、10.3；Checklist H8）。`fixture` 项目（:4611，Opaque_Mode），
 * 桌面视口，默认主题（不 seedTheme），不装 Controlled_Clock（不涉及时长）。
 *
 * ## 用书（4.4：期望值运行时推导）
 *
 * - 10.1、10.2：`lib.role("longText")`（3.3 (h)(i) 的夹具书）。取它是因为它是夹具里正文最长的普通书
 *   之一（第 3 章 240 段），下载文件足够大，字节数与 `chars` 的比对不会因书太短而偶然成立；书名全是
 *   汉字，`bookTxtFileName` 的结果就是"书名.txt"。
 * - 10.3：`lib.role("crlf")`（夹具源以 CR LF 换行，另有两处段落以单独的 LF 结尾，见
 *   `e2e/fixture/books.py`）。断言前在测试进程中核对前提：独立解压所得字节至少含 1 处 CR LF，
 *   不满足即判失败并注明缺少含 CR LF 的测试用书；单独的 LF 有则一并核对计数，没有则记在注解里。
 *
 * 期望的文件名由测试直接调用 `src/utils/download.ts` 的 `bookTxtFileName(toc.title)` 得出，`title` 取自
 * 该书的 `_toc.json`（`lib.toc(id)`）。
 *
 * ## 下载与请求的观测
 *
 * 每个用例都是新的浏览器上下文，经 `openReader` 打开 `/read/<id>`（等到本次导航的 `[book-load]` 行与
 * 正文 `<h1>`，即"正文加载完成"），点顶栏"阅读设置 (快捷键: S)"打开设置抽屉，核对"下载 UTF-8 纯文本"
 * 可用后点击它。
 *
 * - 下载事件：`page.on("download")` 计数，`page.waitForEvent("download")` 取第一次。下载完成（`saveAs`
 *   结算）后再等 2 个动画帧（设计"补充场景"：不变类断言前的等待），此时的计数即 10.1 的"恰好 1 次"。
 * - 请求：自点击前一刻起到第一次下载事件为止，`context.on("request")` 记下全部请求的 URL。`download`
 *   监听里同步停止记录，Playwright 按协议消息的顺序派发事件，所以下载事件之前发出的请求都已记下。
 *   10.1 断言其中源为本实例（`target.origin`）的请求为 0；`blob:` 等非服务器 URL 只记在注解里。
 * - 文件：`download.saveAs(testInfo.outputPath(<建议文件名>))`，即 `e2e/.out/test-results/` 下本用例的
 *   输出目录，不写入仓库其他位置；随后以 `readFile` 读回全部字节。
 *
 * ## 字节与计数（10.2、10.3）
 *
 * - 10.2：文件以 `EF BB BF` 开头；其余字节以 `new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })`
 *   解码（遇非法序列即抛错，且不再剥除 BOM），所得字符串的 `length`（UTF-16 码元数）等于同一页面加载中
 *   该书最近一条 `[book-load]` 行的 `chars`（`bookLog`，自本次导航起）。
 * - 10.3：文件去掉开头 3 字节后与 `gunzip(readFile(lib.gzPath(id)))` 逐字节相同。先比较 CR LF、单独的 LF
 *   与单独的 CR 的个数（报错信息可读），再比较长度与首个不同字节的偏移（不对整段 Buffer 做 `toEqual`，
 *   免得失败时输出巨大的差异）。
 *
 * 读数（文件名、字节数、`chars`、换行计数、观测到的请求）记在注解 `download-plan`、`download-result` 里。
 */
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import type { BrowserContext, Download, Page, Request, TestInfo } from "@playwright/test";
import { bookTxtFileName } from "../../../src/utils/download";
import { expect, test, type BookLog, type Lib, type RunTarget } from "../../support/fixtures";
import { reader, settingsDrawer } from "../../support/locators";
import { bookUnderTest, openReader, waitFrames, type BookUnderTest } from "../../support/reader";
import { TIMEOUTS } from "../../support/settings";
import { step } from "../../support/step";

const gunzipAsync = promisify(gunzip);

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 10.2：UTF-8 BOM 的 3 字节。 */
const UTF8_BOM_BYTES = Buffer.from([0xef, 0xbb, 0xbf]);

const CR = 0x0d;
const LF = 0x0a;

/** 10.3 失败时报告首个不同字节前后各取的字节数。 */
const DIFF_CONTEXT_BYTES = 16;

/** 注解里列出的请求 URL 条数上限。 */
const NOTE_REQUESTS = 10;

// ---------------------------------------------------------------------------
// 用书与打开
// ---------------------------------------------------------------------------

interface DownloadPlan {
  book: BookUnderTest;
  /** `_toc.json` 的 `title`。 */
  title: string;
  /** `bookTxtFileName(title)`：10.1 的期望文件名。 */
  expectedFileName: string;
}

/** 取一本书与期望文件名，记注解 `download-plan`。须在用例体内调用（`bookUnderTest` 可能设置用例超时）。 */
async function downloadPlan(lib: Lib, id: string, why: string): Promise<DownloadPlan> {
  const book = await bookUnderTest(lib, id);
  return step(`选定用书 ${id}（${why}），由 _toc.json 的 title 推导期望文件名`, async () => {
    const { title } = await lib.toc(id);
    const expectedFileName = bookTxtFileName(title);
    test.info().annotations.push({
      type: "download-plan",
      description: `书 ${id}（${why}）；title「${title}」；期望文件名「${expectedFileName}」；gz ${book.gzBytes} 字节`,
    });
    return { book, title, expectedFileName };
  });
}

/** 打开阅读器并返回本次导航之前 `bookLog` 的行数（10.2 的"同一页面加载"自此算起）。 */
async function openBook(page: Page, bookLog: BookLog, plan: DownloadPlan): Promise<number> {
  const since = bookLog.count;
  await openReader(page, bookLog, plan.book);
  return since;
}

function requireTarget(target: RunTarget | null): RunTarget {
  if (target === null) throw new Error("本文件只在声明了 Library_Profile 的 fixture 项目中运行");
  return target;
}

// ---------------------------------------------------------------------------
// 下载
// ---------------------------------------------------------------------------

/** 一次整本下载的观测结果。 */
interface DownloadOutcome {
  download: Download;
  suggestedFilename: string;
  /** 另存到本用例输出目录的路径。 */
  file: string;
  /** 文件的全部字节。 */
  bytes: Buffer;
  /** 下载完成并再等 2 个动画帧后，本页面收到的下载事件总数。 */
  downloadEvents: number;
  /** 自点击前一刻起到第一次下载事件为止，本上下文发出的全部请求的 URL（按发出顺序）。 */
  requestsDuring: string[];
  /** `requestsDuring` 中源为本实例的那些。 */
  serverRequests: string[];
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * 10.1 的 WHEN：打开设置抽屉，核对"下载 UTF-8 纯文本"可用，点击它；记录下载事件与期间的请求，
 * 等下载完成并另存到本用例的输出目录，读回全部字节。
 */
async function downloadWholeBook(
  page: Page,
  context: BrowserContext,
  target: RunTarget,
  testInfo: TestInfo,
): Promise<DownloadOutcome> {
  const drawer = settingsDrawer(page);
  await step("点击顶栏“阅读设置”打开设置抽屉", async () => {
    await reader(page).settingsButton.click();
    await expect(drawer.marker).toBeVisible();
  });
  await step("“下载 UTF-8 纯文本”按钮可用（正文已就绪）", async () => {
    await expect(drawer.downloadButton).toBeEnabled();
  });

  const downloads: Download[] = [];
  const requestsDuring: string[] = [];
  let recording = true;
  const onRequest = (request: Request): void => {
    if (recording) requestsDuring.push(request.url());
  };
  const onDownload = (download: Download): void => {
    // 同步停止记录：第一次下载事件之后的请求不在 10.1 的观测区间内
    recording = false;
    downloads.push(download);
  };

  context.on("request", onRequest);
  page.on("download", onDownload);
  try {
    const download = await step("点击“下载 UTF-8 纯文本”，等到下载事件（期间记录请求）", async () => {
      const first = page.waitForEvent("download", { timeout: TIMEOUTS.wait });
      // 点击本身失败时不留下未处理的拒绝；成功路径仍 await 同一个 Promise
      void first.catch(() => undefined);
      await drawer.downloadButton.click();
      return first;
    });
    recording = false;
    context.off("request", onRequest);

    const suggestedFilename = download.suggestedFilename();
    const file = testInfo.outputPath(suggestedFilename);
    await step("等下载完成，另存到本用例的输出目录（e2e/.out/test-results/ 下）", async () => {
      await download.saveAs(file);
      expect(await download.failure(), "下载不应失败").toBeNull();
    });
    const bytes = await readFile(file);

    const downloadEvents = await step("下载完成后再等 2 个动画帧，读下载事件的总数", async () => {
      await waitFrames(page, 2);
      return downloads.length;
    });

    const serverRequests = requestsDuring.filter((url) => originOf(url) === target.origin);
    const listed = requestsDuring.slice(0, NOTE_REQUESTS).join("、");
    test.info().annotations.push({
      type: "download-result",
      description:
        `建议文件名「${suggestedFilename}」；文件 ${bytes.length} 字节；下载事件 ${downloadEvents} 次；` +
        `点击到下载事件之间的请求 ${requestsDuring.length} 个（本实例 ${serverRequests.length} 个）` +
        (requestsDuring.length > 0 ? `：${listed}${requestsDuring.length > NOTE_REQUESTS ? "…" : ""}` : ""),
    });
    return { download, suggestedFilename, file, bytes, downloadEvents, requestsDuring, serverRequests };
  } finally {
    recording = false;
    context.off("request", onRequest);
    page.off("download", onDownload);
  }
}

// ---------------------------------------------------------------------------
// 字节度量
// ---------------------------------------------------------------------------

/** 换行字节的计数：CR LF、单独的 LF（前面不是 CR）、单独的 CR（后面不是 LF）。 */
interface LineBreakCounts {
  crlf: number;
  loneLf: number;
  loneCr: number;
}

function countLineBreaks(bytes: Uint8Array): LineBreakCounts {
  let crlf = 0;
  let loneLf = 0;
  let loneCr = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === LF) {
      if (i > 0 && bytes[i - 1] === CR) crlf += 1;
      else loneLf += 1;
    } else if (b === CR && bytes[i + 1] !== LF) {
      loneCr += 1;
    }
  }
  return { crlf, loneLf, loneCr };
}

function describeCounts(c: LineBreakCounts): string {
  return `CR LF ${c.crlf} 处、单独的 LF ${c.loneLf} 处、单独的 CR ${c.loneCr} 处`;
}

/** 两段字节中首个不同的偏移；一段是另一段的前缀时为较短者的长度；完全相同时为 -1。 */
function firstDifference(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

function hexAround(bytes: Uint8Array, at: number): string {
  const from = Math.max(0, at - DIFF_CONTEXT_BYTES);
  const to = Math.min(bytes.length, at + DIFF_CONTEXT_BYTES);
  return Buffer.from(bytes.subarray(from, to)).toString("hex").replace(/(..)/g, "$1 ").trim();
}

function hexOf(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex").replace(/(..)/g, "$1 ").trim();
}

// ---------------------------------------------------------------------------
// 10.1 下载次数、文件名与请求
// ---------------------------------------------------------------------------

test("10.1 正文加载完成后在设置抽屉点击“下载 UTF-8 纯文本”：恰好 1 次下载，建议文件名等于 bookTxtFileName(_toc.json 的 title)，点击到下载事件期间 E2E_Server 未收到请求", async ({
  page,
  context,
  lib,
  bookLog,
  target,
}, testInfo) => {
  const run = requireTarget(target);
  const plan = await downloadPlan(lib, lib.role("longText"), "roles.json longText");
  await openBook(page, bookLog, plan);
  const outcome = await downloadWholeBook(page, context, run, testInfo);

  await step("10.1 下载事件恰好 1 次", async () => {
    expect(outcome.downloadEvents, "下载完成并再等 2 帧后的下载事件总数").toBe(1);
  });
  await step(`10.1 建议文件名为「${plan.expectedFileName}」`, async () => {
    expect(outcome.suggestedFilename, `bookTxtFileName(「${plan.title}」)`).toBe(plan.expectedFileName);
  });
  await step(`10.1 点击到下载事件期间本实例（${run.origin}）未收到请求`, async () => {
    expect(outcome.serverRequests, "点击到下载事件之间发往 E2E_Server 的请求").toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 10.2 BOM 与码元数
// ---------------------------------------------------------------------------

test("10.2 下载的文件以 EF BB BF 开头，其余字节按严格 UTF-8 解码所得的 UTF-16 码元数等于本次加载 [book-load] 的 chars", async ({
  page,
  context,
  lib,
  bookLog,
  target,
}, testInfo) => {
  const run = requireTarget(target);
  const plan = await downloadPlan(lib, lib.role("longText"), "roles.json longText");
  const since = await openBook(page, bookLog, plan);
  const { bytes } = await downloadWholeBook(page, context, run, testInfo);

  await step("10.2 文件以 3 字节 EF BB BF 开头", async () => {
    expect(bytes.length, "文件字节数").toBeGreaterThanOrEqual(UTF8_BOM_BYTES.length);
    expect(hexOf(bytes.subarray(0, UTF8_BOM_BYTES.length)), "文件开头 3 字节").toBe(hexOf(UTF8_BOM_BYTES));
  });

  const decoded = await step("10.2 其余字节按严格 UTF-8 解码（fatal、ignoreBOM）", () => {
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    let text = "";
    let failure: string | null = null;
    try {
      text = decoder.decode(bytes.subarray(UTF8_BOM_BYTES.length));
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    expect(
      failure,
      `去掉开头 3 字节后的 ${bytes.length - UTF8_BOM_BYTES.length} 字节应为合法的 UTF-8（严格解码的报错）`,
    ).toBeNull();
    return text;
  });

  await step("10.2 解码所得字符串的 UTF-16 码元数等于同一页面加载中该书最近一条 [book-load] 的 chars", async () => {
    const lines = bookLog.all().slice(since).filter((line) => line.bookId === plan.book.id);
    expect(lines.length, `本次导航以来 ${plan.book.id} 的 [book-load] 行数`).toBeGreaterThanOrEqual(1);
    const latest = lines[lines.length - 1];
    test.info().annotations.push({
      type: "download-result",
      description:
        `去掉 BOM 后 ${bytes.length - UTF8_BOM_BYTES.length} 字节，解码为 ${decoded.length} 个 UTF-16 码元；` +
        `最近一条 [book-load] source=${latest.source} chars=${latest.chars}（本次导航共 ${lines.length} 条）`,
    });
    expect(decoded.length, `[book-load] ${plan.book.id} source=${latest.source} 的 chars`).toBe(latest.chars);
  });
});

// ---------------------------------------------------------------------------
// 10.3 CR LF 书逐字节比对
// ---------------------------------------------------------------------------

test("10.3 含 CR LF 的书：下载的文件去掉开头 3 字节后与测试进程独立解压的 .txt.gz 逐字节相同，CR LF 与单独的 LF 原样保留", async ({
  page,
  context,
  lib,
  bookLog,
  target,
}, testInfo) => {
  const run = requireTarget(target);
  const plan = await downloadPlan(lib, lib.role("crlf"), "roles.json crlf");

  const expected = await step(`前提：独立解压 ${plan.book.id}.txt.gz，所得字节至少含 1 处 CR LF`, async () => {
    const raw = await gunzipAsync(await readFile(lib.gzPath(plan.book.id)));
    const counts = countLineBreaks(raw);
    const startsWithBom = raw.subarray(0, UTF8_BOM_BYTES.length).equals(UTF8_BOM_BYTES);
    test.info().annotations.push({
      type: "download-plan",
      description:
        `独立解压 ${raw.length} 字节：${describeCounts(counts)}；` +
        `开头${startsWithBom ? "是" : "不是"} BOM` +
        (counts.loneLf === 0 ? "；该书没有单独的 LF，只核对 CR LF" : ""),
    });
    expect(
      counts.crlf,
      `缺少含 CR LF 的测试用书：${plan.book.id} 的解压字节中没有 CR LF（需求 10.3 的前提；检查 roles.json 的 crlf 与夹具生成）`,
    ).toBeGreaterThanOrEqual(1);
    return { raw, counts };
  });

  await openBook(page, bookLog, plan);
  const { bytes } = await downloadWholeBook(page, context, run, testInfo);

  await step("文件以 3 字节 EF BB BF 开头（10.3 所说的“开头 3 字节”）", async () => {
    expect(hexOf(bytes.subarray(0, UTF8_BOM_BYTES.length)), "文件开头 3 字节").toBe(hexOf(UTF8_BOM_BYTES));
  });
  const body = bytes.subarray(UTF8_BOM_BYTES.length);

  await step(`10.3 CR LF 原样保留：${expected.counts.crlf} 处`, async () => {
    expect(countLineBreaks(body).crlf, "文件（去掉开头 3 字节）中 CR LF 的个数").toBe(expected.counts.crlf);
  });
  if (expected.counts.loneLf > 0) {
    await step(`10.3 单独的 LF 原样保留：${expected.counts.loneLf} 处`, async () => {
      expect(countLineBreaks(body).loneLf, "文件（去掉开头 3 字节）中单独的 LF 的个数").toBe(expected.counts.loneLf);
    });
  }

  await step(`10.3 去掉开头 3 字节后与独立解压的 ${expected.raw.length} 字节逐字节相同`, async () => {
    const at = firstDifference(body, expected.raw);
    const detail =
      at < 0
        ? "相同"
        : `长度 ${body.length} / ${expected.raw.length}；首个不同字节在偏移 ${at}：` +
          `文件 [${hexAround(body, at)}]，独立解压 [${hexAround(expected.raw, at)}]`;
    test.info().annotations.push({
      type: "download-result",
      description: `文件去掉开头 3 字节后 ${body.length} 字节（${describeCounts(countLineBreaks(body))}）；比对：${detail}`,
    });
    expect(body.length, "文件去掉开头 3 字节后的字节数").toBe(expected.raw.length);
    expect(at, `首个不同字节的偏移（-1 表示逐字节相同）：${detail}`).toBe(-1);
  });
});
