/**
 * 阅读器错误页（需求 11.9、11.10、11.11、19.7；Review_Shot RS-20）。`fixture` 项目（:4611，
 * Opaque_Mode），桌面视口，默认主题（不 seedTheme），不装 Controlled_Clock（"10 s 内"是真实时间的
 * 判定时限 `TIMEOUTS.loadError`）。
 *
 * ## 场景
 *
 * - 11.9：访问 `/read/不存在的id`。该 id 含中文字符、不在 `books.json` 中，书库里也没有其
 *   `_toc.json` 与 `.txt.gz`，E2E_Server 按 5.6 对该 `_toc.json` 请求以状态 200 返回 App_Build 的
 *   `index.html`（前置里核对这一响应）。自访问起 10 s 内进度条消失并显示错误页，拍 RS-20
 *   `load-error`（catalog 的 URL 即 `/read/不存在的id`，`book: null`）。
 * - 11.10（F-001 的 E2E 断言，按 19.7 为普通断言，不加预期失败）：取 `books.json` 中 `.txt.gz`
 *   最小的一本书（`pickBooks`），其 `_toc.json` 照常由 E2E_Server 返回；该书 `.txt.gz` 的请求被
 *   `page.route` 拦截，以与 5.6 回退相同的响应返回：状态 200、`Content-Type` 取
 *   `contentTypeFor("index.html", "opaque")`、`Cache-Control: no-store`、不带 `Content-Encoding`，
 *   响应体为 `lib.indexHtml()` 的字节。
 * - 11.11：在 11.9 与 11.10 的错误页各点击一次"返回书架"，URL 变为 `/` 并显示书卡网格。
 * - 19.2 后半句（F-001 修复的"失败不进内存缓存"）：11.10 的错误页之后，经"返回书架"与浏览器后退
 *   在同一会话（同一文档，不整页重载）内再次打开该书，此时已撤掉拦截；不出现 `source=memory`，
 *   而是重新经网络加载（`source=network`）并渲染正文。
 *
 * ## 观测
 *
 * - 错误页（`readerError`）：错误标题"未能打开书籍"、标题下的一行说明（错误视图中唯一的段落，
 *   非空、不含换行；文本随原因而变，只记入注解）与"返回书架"按钮；"书籍加载进度"进度条
 *   （`readerLoading().progress`）计数为 0。时限自 `page.goto` 之前一刻起算：11.10 / 19.1 的
 *   "响应体接收完毕后 10 s 内"起点更晚，自访问起算只会更严。
 * - "不打 `[book-load]`、不写 IndexedDB"是否定判断，观测窗口的终点取可观测条件：错误页已显示后
 *   再等 2 个动画帧（`waitFrames`），不用固定时长。失败路径上应用既不写内存缓存也不写 IndexedDB
 *   （写入只在成功返回全文之后发生），窗口终点之后不会再有写入。
 * - 请求：`page.on("request")` 按解码后的路径识别该书的 `.txt.gz` 与 `_toc.json`（路径由应用自己的
 *   `txtUrl` / `tocUrl` 推得）；拦截器另计被拦截的次数。11.10 的".txt.gz 只请求 1 次"是 19.5
 *   （删除 `network-fallback` 兜底重取）与 19.9（只执行一轮网络分支）在全新上下文中的结果。
 * - "不把响应内容当作正文渲染"：没有正文 `<article>` 与正文 `<h1>`，且页面可见文本
 *   （`document.body.innerText`，只作度量）不含 `index.html` 的任何一行（去掉首尾空白、折叠空白后
 *   比较）。修复前的 `network-fallback` 会把这页 HTML 源码逐行渲染为正文段落。
 *
 * ## 用例划分
 *
 * 11.9、11.10 各一个用例；11.11 按两种错误页各一个用例；19.2 的再次打开一个用例。各自新上下文
 * （6.1），前置只核对到能进入被测条目所需的程度。读数记在注解 `load-error-*` 里。
 */
import { stat } from "node:fs/promises";
import type { Page, Request, Route } from "@playwright/test";
import { tocUrl, txtUrl } from "../../../src/utils/locator";
import { PAGE_SIZE } from "../../../src/utils/pagination";
import { SHOT_TESTS, reviewShot } from "../../review/catalog";
import { contentTypeFor } from "../../server/resolve";
import { decodedPath, pickBooks } from "../../support/cache";
import { expect, test, type BookLog, type IdbProbe, type Lib } from "../../support/fixtures";
import { libRootFor, tocPath } from "../../support/library";
import { normalizeWhiteSpace, reader, readerError, readerLoading, shelf } from "../../support/locators";
import { readerPath, waitFrames, type BookUnderTest } from "../../support/reader";
import { TIMEOUTS } from "../../support/settings";
import { step } from "../../support/step";

/** 11.9 的书 id：含中文字符，不在 `books.json` 中，书库里也没有其文件（RS-20 的 URL 即 `/read/<它>`）。 */
const MISSING_BOOK_ID = "不存在的id";

/** App_Build 入口文件名；5.6 回退响应的 `Content-Type` 按它取（与 E2E_Server 相同）。 */
const INDEX_HTML = "index.html";

// ---------------------------------------------------------------------------
// 路径、时限与请求
// ---------------------------------------------------------------------------

/** 应用请求该书 `.txt.gz` 的路径（解码后）。 */
function gzRequestPath(id: string): string {
  return decodeURIComponent(txtUrl(id));
}

/** 应用请求该书 `_toc.json` 的路径（解码后）。 */
function tocRequestPath(id: string): string {
  return decodeURIComponent(tocUrl(id));
}

/** 自 `start`（`Date.now()`）起、时限 `TIMEOUTS.loadError` 所剩的毫秒数（至少 1：0 表示不设时限）。 */
function remainingMs(start: number): number {
  return Math.max(1, TIMEOUTS.loadError - (Date.now() - start));
}

/** 文件是否存在；`ENOENT` 以外的错误原样抛出。 */
async function fileExists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** 本页面发出的请求（按解码后的路径查询）。`stop()` 之后不再记录。 */
interface RequestLog {
  of(path: string): string[];
  stop(): void;
}

function recordRequests(page: Page): RequestLog {
  const seen: { url: string; path: string | null }[] = [];
  let recording = true;
  const onRequest = (request: Request): void => {
    if (!recording) return;
    const url = request.url();
    seen.push({ url, path: decodedPath(url) });
  };
  page.on("request", onRequest);
  return {
    of: (p) => seen.filter((s) => s.path === p).map((s) => s.url),
    stop() {
      recording = false;
      page.off("request", onRequest);
    },
  };
}

/** `interceptGzWithIndexHtml` 的句柄。 */
interface GzIntercept {
  /** 被拦截并以 `index.html` 应答的次数。 */
  readonly fulfilled: number;
  /** 撤掉拦截，此后该书 `.txt.gz` 由 E2E_Server 照常返回。 */
  remove(): Promise<void>;
}

/**
 * 拦截该书 `.txt.gz` 的请求，以与 5.6 回退相同的响应应答：状态 200、`Content-Type` 同
 * `index.html`、`Cache-Control: no-store`、不带 `Content-Encoding`，响应体为 App_Build 的
 * `index.html` 字节（11.10）。须在首次导航之前调用。
 */
async function interceptGzWithIndexHtml(page: Page, lib: Lib, id: string): Promise<GzIntercept> {
  const body = await lib.indexHtml();
  const gzPath = gzRequestPath(id);
  let fulfilled = 0;
  const matcher = (url: URL): boolean => decodedPath(url.href) === gzPath;
  const handler = async (route: Route): Promise<void> => {
    fulfilled += 1;
    await route.fulfill({
      status: 200,
      headers: {
        "Content-Type": contentTypeFor(INDEX_HTML, "opaque"),
        "Content-Length": String(body.length),
        "Cache-Control": "no-store",
      },
      body,
    });
  };
  await page.route(matcher, handler);
  return {
    get fulfilled() {
      return fulfilled;
    },
    remove: () => page.unroute(matcher, handler),
  };
}

// ---------------------------------------------------------------------------
// 错误页与观测窗口
// ---------------------------------------------------------------------------

/** 错误页的读数。 */
interface ErrorPageShown {
  /** 错误说明的文本（去掉首尾空白）。 */
  description: string;
  /** 自 `since` 起到错误标题可见、进度条消失的毫秒数。 */
  elapsedMs: number;
}

/**
 * 自 `since` 起 `TIMEOUTS.loadError` 内"书籍加载进度"进度条消失并显示错误页：错误标题、一行错误
 * 说明（非空、不含换行）与"返回书架"按钮（11.9、11.10、19.1）。
 */
async function expectErrorPage(page: Page, since: number, label: string): Promise<ErrorPageShown> {
  return step(
    `${label} ${TIMEOUTS.loadError} ms 内“书籍加载进度”进度条消失，显示错误页（错误标题、一行错误说明、“返回书架”按钮）`,
    async () => {
      const error = readerError(page);
      await expect(error.heading, "错误标题“未能打开书籍”").toBeVisible({ timeout: remainingMs(since) });
      await expect(readerLoading(page).progress, "“书籍加载进度”进度条").toHaveCount(0, {
        timeout: remainingMs(since),
      });
      const elapsedMs = Date.now() - since;

      await expect(error.description, "错误说明（错误视图中唯一的段落）").toHaveCount(1);
      await expect(error.description).toBeVisible();
      const description = ((await error.description.textContent()) ?? "").trim();
      expect(description, "错误说明不应为空").not.toBe("");
      expect(description, "错误说明应为一行（不含换行）").not.toMatch(/[\r\n]/);
      await expect(error.backButton, "“返回书架”按钮").toBeVisible();

      test.info().annotations.push({
        type: "load-error-page",
        description: `${label}：自访问起 ${elapsedMs} ms 内错误页显示、进度条消失；错误说明「${description}」`,
      });
      return { description, elapsedMs };
    },
  );
}

/** 否定判断（不打日志、不写 IndexedDB）的观测窗口终点：错误页已显示后再等 2 个动画帧。 */
async function endObservationWindow(page: Page): Promise<void> {
  await step("观测窗口终点：错误页显示后等 2 个动画帧", async () => {
    await waitFrames(page, 2);
  });
}

/** 该 id 没有任何 `[book-load]` 日志（含 `source=network-fallback`）。 */
async function expectNoBookLoad(bookLog: BookLog, id: string, label: string): Promise<void> {
  await step(`${label} ${id} 不产生 [book-load] 日志`, async () => {
    const all = bookLog.all();
    test.info().annotations.push({
      type: "load-error-book-load",
      description:
        all.length === 0
          ? "本上下文没有任何 [book-load] 行"
          : all.map((l) => `${l.bookId} source=${l.source} gz=${l.gz} chars=${l.chars}`).join("；"),
    });
    expect(
      all.filter((l) => l.bookId === id).map((l) => `source=${l.source}`),
      `${id} 的 [book-load] 行`,
    ).toEqual([]);
    expect(
      all.filter((l) => l.source === "network-fallback").map((l) => l.bookId),
      "source=network-fallback 的 [book-load] 行",
    ).toEqual([]);
  });
}

/** IndexedDB `books` store 中没有该 id 的记录。 */
async function expectNoCacheRecord(idb: IdbProbe, id: string, label: string): Promise<void> {
  await step(`${label} IndexedDB books store 中没有以 ${id} 为键的记录`, async () => {
    const keys = await idb.keys();
    test.info().annotations.push({
      type: "load-error-idb",
      description: `books store 的键集合：${keys.length === 0 ? "（空）" : keys.join("、")}`,
    });
    expect(keys, "books store 的键集合").not.toContain(id);
  });
}

/** 点击错误页的"返回书架"：URL 变为 `/`，显示书架的书卡网格（11.11）。 */
async function expectBackToShelf(page: Page, lib: Lib): Promise<void> {
  const view = shelf(page);
  const catalog = await lib.books();
  const home = new URL("/", page.url()).href;

  await step("点击错误页的“返回书架”", async () => {
    await readerError(page).backButton.click();
  });
  await step(`11.11 URL 变为 /（${home}）`, async () => {
    await expect(page, "点击“返回书架”后的 URL").toHaveURL(home);
  });
  await step("11.11 显示书架的书卡网格，错误页消失", async () => {
    await expect(view.cardTocButtons.first(), "首张书卡").toBeVisible();
    await expect(view.cardTocButtons, "首屏书卡数").toHaveCount(Math.min(PAGE_SIZE, catalog.books.length));
    await expect(readerError(page).heading, "错误标题").toHaveCount(0);
  });
}

// ---------------------------------------------------------------------------
// 11.9 的打开
// ---------------------------------------------------------------------------

/** 11.9 的前置核对：该 id 含中文、不在 `books.json` 中、书库里没有其文件；RS-20 的 URL 与之相同。 */
async function checkMissingBook(lib: Lib): Promise<void> {
  await step(
    `前置：${MISSING_BOOK_ID} 含中文字符，不在 books.json 中，书库中也没有其 _toc.json 与 .txt.gz`,
    async () => {
      expect(MISSING_BOOK_ID, "书 id 应含中文字符").toMatch(/\p{Script=Han}/u);
      const ids = (await lib.books()).books.map((b) => b.id);
      expect(ids, "books.json 的书 id").not.toContain(MISSING_BOOK_ID);
      const toc = tocPath(libRootFor(lib.profile), MISSING_BOOK_ID);
      expect(await fileExists(toc), `${toc} 不应存在`).toBe(false);
      expect(await fileExists(lib.gzPath(MISSING_BOOK_ID)), `${lib.gzPath(MISSING_BOOK_ID)} 不应存在`).toBe(false);
      expect(decodeURIComponent(readerPath(MISSING_BOOK_ID)), "RS-20 的 URL").toBe(reviewShot("load-error").url);
    },
  );
}

/**
 * 访问 `/read/不存在的id`，核对该 id 的 `_toc.json` 请求收到 5.6 的回退（状态 200、响应体为
 * App_Build 的 `index.html`）。返回访问前一刻（`Date.now()`）。
 */
async function openMissingBook(page: Page, lib: Lib): Promise<number> {
  const indexHtml = await lib.indexHtml();
  const tocPathname = tocRequestPath(MISSING_BOOK_ID);
  const tocResponse = page.waitForResponse((r) => decodedPath(r.url()) === tocPathname);
  // goto 自身失败时不留下未处理的拒绝；成功路径仍 await 同一个 Promise
  void tocResponse.catch(() => undefined);

  const url = readerPath(MISSING_BOOK_ID);
  const startedAt = await step(`访问 ${decodeURIComponent(url)}`, async () => {
    const at = Date.now();
    await page.goto(url);
    return at;
  });
  await step(`前置（5.6）：${tocPathname} 以状态 200 返回 App_Build 的 index.html`, async () => {
    const response = await tocResponse;
    const body = await response.body();
    test.info().annotations.push({
      type: "load-error-toc-response",
      description:
        `${tocPathname}：状态 ${response.status()}，Content-Type ${response.headers()["content-type"] ?? "（无）"}，` +
        `响应体 ${body.length} 字节（index.html ${indexHtml.length} 字节）`,
    });
    expect(response.status(), `${tocPathname} 的状态`).toBe(200);
    expect(body.equals(indexHtml), `${tocPathname} 的响应体应为 App_Build 的 index.html`).toBe(true);
  });
  return startedAt;
}

// ---------------------------------------------------------------------------
// 11.10 的打开
// ---------------------------------------------------------------------------

/** 11.10 的一次打开。 */
interface InterceptedOpen {
  book: BookUnderTest;
  intercept: GzIntercept;
  requests: RequestLog;
  /** 访问前一刻（`Date.now()`）。 */
  startedAt: number;
}

/**
 * 取 `.txt.gz` 最小的一本书，拦截其 `.txt.gz`（`interceptGzWithIndexHtml`），开始记录请求后访问
 * 其阅读页；核对 `_toc.json` 正常返回、`.txt.gz` 收到的是状态 200、不带 `Content-Encoding` 的
 * `index.html` 且响应体接收完毕。
 */
async function openInterceptedBook(page: Page, lib: Lib): Promise<InterceptedOpen> {
  const [book] = await pickBooks(lib, 1);
  const indexHtml = await lib.indexHtml();
  const intercept = await interceptGzWithIndexHtml(page, lib, book.id);
  const requests = recordRequests(page);
  const tocPathname = tocRequestPath(book.id);
  const gzPathname = gzRequestPath(book.id);
  const tocResponse = page.waitForResponse((r) => decodedPath(r.url()) === tocPathname);
  const gzResponse = page.waitForResponse((r) => decodedPath(r.url()) === gzPathname);
  void tocResponse.catch(() => undefined);
  void gzResponse.catch(() => undefined);

  const url = readerPath(book.id);
  const startedAt = await step(`访问 ${decodeURIComponent(url)}（${gzPathname} 被拦截）`, async () => {
    const at = Date.now();
    await page.goto(url);
    return at;
  });
  await step(`前置：${tocPathname} 正常返回（状态 200 的 JSON）`, async () => {
    const response = await tocResponse;
    expect(response.status(), `${tocPathname} 的状态`).toBe(200);
    expect(response.headers()["content-type"] ?? "", `${tocPathname} 的 Content-Type`).toBe(
      contentTypeFor(tocPathname, "opaque"),
    );
  });
  await step(`前置：${gzPathname} 收到状态 200、不带 Content-Encoding 的 index.html，响应体接收完毕`, async () => {
    const response = await gzResponse;
    const finished = await response.finished();
    const headers = response.headers();
    const body = await response.body();
    test.info().annotations.push({
      type: "load-error-gz-response",
      description:
        `${gzPathname}：状态 ${response.status()}，Content-Type ${headers["content-type"] ?? "（无）"}，` +
        `Content-Encoding ${headers["content-encoding"] ?? "（无）"}，响应体 ${body.length} 字节` +
        `（index.html ${indexHtml.length} 字节）`,
    });
    expect(finished, "响应体应接收完毕且无错误").toBeNull();
    expect(response.status(), `${gzPathname} 的状态`).toBe(200);
    expect(headers["content-encoding"], "不带 Content-Encoding（Opaque_Mode）").toBeUndefined();
    expect(body.equals(indexHtml), "响应体应为 App_Build 的 index.html").toBe(true);
  });
  return { book, intercept, requests, startedAt };
}

// ---------------------------------------------------------------------------
// 11.9
// ---------------------------------------------------------------------------

test(SHOT_TESTS.loadErrorMissingBook.title, async ({ page, lib, bookLog, idb, shot }) => {
  await checkMissingBook(lib);
  const startedAt = await openMissingBook(page, lib);
  await expectErrorPage(page, startedAt, "11.9");
  await endObservationWindow(page);
  // RS-20 为默认主题（localStorage 中没有已存储的主题），不 seedTheme
  await shot("load-error");
  await expectNoBookLoad(bookLog, MISSING_BOOK_ID, "11.9");
  await expectNoCacheRecord(idb, MISSING_BOOK_ID, "11.9");
});

// ---------------------------------------------------------------------------
// 11.10（19.7：普通断言）
// ---------------------------------------------------------------------------

test("11.10 _toc.json 正常而 .txt.gz 收到状态 200 的 index.html（Opaque_Mode）：10 s 内显示错误页，不把响应内容渲染为正文，不写 IndexedDB，不打该书 [book-load]，.txt.gz 只请求 1 次", async ({
  page,
  lib,
  bookLog,
  idb,
}) => {
  const opened = await openInterceptedBook(page, lib);
  const { book } = opened;
  await expectErrorPage(page, opened.startedAt, "11.10");
  await endObservationWindow(page);
  opened.requests.stop();

  await step("11.10 不把该响应的内容当作正文渲染：没有正文 <article> 与正文 <h1>，页面可见文本不含 index.html 的任何一行", async () => {
    const view = reader(page);
    await expect(view.article, "正文 <article>").toHaveCount(0);
    await expect(view.chapterHeading, "正文 <h1>").toHaveCount(0);
    const html = (await lib.indexHtml()).toString("utf8");
    const lines = html
      .split(/\r?\n/)
      .map((l) => normalizeWhiteSpace(l))
      .filter((l) => l !== "");
    const visible = normalizeWhiteSpace(await page.evaluate(() => document.body.innerText));
    const leaked = lines.filter((l) => visible.includes(l));
    test.info().annotations.push({
      type: "load-error-visible-text",
      description: `页面可见文本「${visible}」；index.html 共 ${lines.length} 个非空行，出现在其中的 ${leaked.length} 行`,
    });
    expect(leaked, "页面可见文本中出现的 index.html 行").toEqual([]);
  });

  await expectNoCacheRecord(idb, book.id, "11.10");
  await expectNoBookLoad(bookLog, book.id, "19.2");

  await step(`19.5、19.9 ${book.id}.txt.gz 只请求 1 次（没有兜底重取）`, async () => {
    const gz = opened.requests.of(gzRequestPath(book.id));
    const toc = opened.requests.of(tocRequestPath(book.id));
    test.info().annotations.push({
      type: "load-error-requests",
      description:
        `${book.id}.txt.gz 请求 ${gz.length} 次（被拦截 ${opened.intercept.fulfilled} 次），` +
        `${book.id}_toc.json 请求 ${toc.length} 次`,
    });
    expect(gz.length, `${book.id}.txt.gz 的请求次数（${gz.join("、") || "无"}）`).toBe(1);
    expect(opened.intercept.fulfilled, `${book.id}.txt.gz 被拦截的次数`).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 11.11
// ---------------------------------------------------------------------------

test("11.11 在 11.9 的错误页点击“返回书架”：URL 变为 /，显示书架的书卡网格", async ({ page, lib }) => {
  await checkMissingBook(lib);
  const startedAt = await openMissingBook(page, lib);
  await expectErrorPage(page, startedAt, "前置（11.9）");
  await expectBackToShelf(page, lib);
});

test("11.11 在 11.10 的错误页点击“返回书架”：URL 变为 /，显示书架的书卡网格", async ({ page, lib }) => {
  const opened = await openInterceptedBook(page, lib);
  await expectErrorPage(page, opened.startedAt, "前置（11.10）");
  opened.requests.stop();
  await expectBackToShelf(page, lib);
});

// ---------------------------------------------------------------------------
// 19.2：失败的加载不进内存缓存
// ---------------------------------------------------------------------------

test("19.2 11.10 的错误页之后，同一会话内经“返回书架”与浏览器后退再次打开该书：不出现 source=memory，重新经网络加载并渲染正文", async ({
  page,
  lib,
  bookLog,
}) => {
  const opened = await openInterceptedBook(page, lib);
  const { book } = opened;
  await expectErrorPage(page, opened.startedAt, "前置（11.10）");
  await step("前置：点击“返回书架”回到书架", async () => {
    await readerError(page).backButton.click();
    await expect(shelf(page).cardTocButtons.first()).toBeVisible();
  });
  opened.requests.stop();

  await step(`撤掉 ${book.id}.txt.gz 的拦截`, async () => {
    await opened.intercept.remove();
  });

  const since = bookLog.count;
  const requests = recordRequests(page);
  await step("浏览器后退回到该书的阅读页（同一文档内导航，不整页重载），等本次加载的 [book-load] 行与正文 <h1>", async () => {
    await page.goBack();
    await expect
      .poll(() => decodedPath(page.url()), { message: "后退后的路径" })
      .toBe(decodeURIComponent(readerPath(book.id)));
    await bookLog.waitFor(book.id, undefined, { since, timeout: book.loadTimeout });
    await expect(reader(page).chapterHeading, "正文 <h1>").toBeVisible();
  });
  requests.stop();

  await step("19.2 再次打开的 [book-load] 为 source=network（不是 memory），且该书没有 source=memory 的行", async () => {
    const lines = bookLog.all().filter((l) => l.bookId === book.id);
    const again = bookLog.all().slice(since).filter((l) => l.bookId === book.id);
    const gz = requests.of(gzRequestPath(book.id));
    const toc = requests.of(tocRequestPath(book.id));
    test.info().annotations.push({
      type: "load-error-reopen",
      description:
        `再次打开：${again.map((l) => `source=${l.source} gz=${l.gz} chars=${l.chars}`).join("；") || "（无）"}；` +
        `${book.id}.txt.gz 请求 ${gz.length} 次，${book.id}_toc.json 请求 ${toc.length} 次`,
    });
    expect(again[0]?.source, "再次打开的来源分支").toBe("network");
    expect(lines.filter((l) => l.source === "memory").length, "source=memory 的行数").toBe(0);
    expect(gz.length, `再次打开时 ${book.id}.txt.gz 的请求次数`).toBe(1);
  });
});
