/**
 * 加载路径与离线缓存：Opaque_Mode 下的 IndexedDB 缓存（需求 11.2、11.3、11.6、11.7、11.8；
 * Checklist H11）。`fixture` 项目（:4611，Opaque_Mode），桌面视口，默认主题（不 seedTheme），
 * 不装 Controlled_Clock（各条的"5 s 内"是真实时间的判定时限，不是应用内的计时行为）。
 *
 * ## 用书（4.4：期望值运行时推导）
 *
 * `pickBooks(lib, n)`：取当前书库 `books.json` 中 `.txt.gz` 最小的 n 本（字节数升序，同大小按 id），
 * 各用例需要几本就取几本。缓存行为与书的内容无关，取小书只是让多次整页打开更快。gz 字节数与
 * SHA-256 由测试进程直接读 `lib.gzPath(id)` 的文件得出（`node:crypto`）。
 *
 * ## 观测
 *
 * - `[book-load]`：`bookLog`。`openBook` 在导航前先登记一个等待，记下本次导航的那一行到达测试
 *   进程的时刻（`loggedAt`），再经 `openReader` 打开（等同一行与正文 `<h1>`）。11.2、11.7 的
 *   "5 s 内"自 `loggedAt` 起算。
 * - IndexedDB：`idb` fixture（只读，不会创建库）。`keys()` 为记录的键集合，`gzSha256(id)` 为某条
 *   记录所存 gz 的 SHA-256，`gzSizes()` 为各记录所存 gz 的 `byteLength`（11.6 的 S）。等记录出现或
 *   集合达到预期一律 `expect.poll`（6.5）；判定时限取 `TIMEOUTS.cacheSettle`（5 s），没有时限的前置
 *   等待取 `TIMEOUTS.wait`。
 * - 11.2 的 `gz` 字段：日志里的 gz 是人读记号（≥ 1,024 B 时为两位小数的 KB，见
 *   `src/utils/loadMetrics.ts`），期望值由 `formatBookLoadMetrics` 以文件字节数格式化后取同一字段
 *   得出；逐字节相同由记录的 SHA-256 与字节长度核对。
 * - 11.3 的请求：自 `page.reload()` 之前一刻起，到本次加载的 `[book-load]` 行、正文 `<h1>` 与首个
 *   段落都出现为止，`context.on("request")` 记下全部请求；按解码后的路径筛出该书的
 *   `/books/<id>.txt.gz` 与 `/data/<id>_toc.json`。E2E_Server 的每个响应都带
 *   `Cache-Control: no-store`，由 HTTP 缓存应答的请求在 Chromium 中同样会产生 `request` 事件。
 * - 设置抽屉：经顶栏"阅读设置 (快捷键: S)"打开。"已缓存"一行（`settingsDrawer().cacheUsage`）先显示
 *   "统计中…"，等它变为"N 本 · 大小"的读数后再读一次文本作判定（H11），不对读数本身重试。
 *   期望值 `formatByteSize` 取自 `src/utils/cacheUsage.ts`（11.6 原文即 `formatByteSize(S)`）。
 * - 11.7 的上限滑杆（`getByRole("slider", { name: "离线缓存本数上限" })`）：聚焦后按 `Home`，即其最小值；
 *   断言滑杆值为 "1"、显示值为"1 本"。焦点在 `INPUT` 上时阅读器快捷键不接管按键。
 *
 * ## 用例划分（16.7）
 *
 * 11.2、11.3、11.6、11.7、11.8 各一个用例，各自新上下文（6.1）。11.3 以 11.2 的打开与记录出现为
 * 前置，11.8 以"IndexedDB 中有 2 条记录"为前置，前置只核对到能进入被测条目所需的程度。
 *
 * 读数（用书、字节数、SHA-256、S、"已缓存"读数、请求计数、键集合）记在注解 `cache-*` 里。
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { BrowserContext, Page, Request } from "@playwright/test";
import { formatByteSize } from "../../../src/utils/cacheUsage";
import { formatBookLoadMetrics } from "../../../src/utils/loadMetrics";
import { parseBookLoadLine } from "../../perf/metrics";
import { decodedPath, openBook, pickBooks } from "../../support/cache";
import { expect, test, type BookLog, type IdbProbe, type Lib } from "../../support/fixtures";
import { NAMES, reader, settingsDrawer } from "../../support/locators";
import type { BookUnderTest } from "../../support/reader";
import { TIMEOUTS } from "../../support/settings";
import { step } from "../../support/step";

// ---------------------------------------------------------------------------
// 用书（`pickBooks` 见 `e2e/support/cache.ts`）
// ---------------------------------------------------------------------------

/** 磁盘上该书 `.txt.gz` 的字节数与 SHA-256（小写十六进制）。 */
async function gzFileFacts(lib: Lib, id: string): Promise<{ bytes: number; sha256: string }> {
  const buf = await readFile(lib.gzPath(id));
  return { bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex") };
}

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
// 打开、等待与读数（`openBook`、`decodedPath` 见 `e2e/support/cache.ts`）
// ---------------------------------------------------------------------------

/** 自 `start`（`Date.now()`）起、时限 `TIMEOUTS.cacheSettle` 所剩的毫秒数（至少 1：0 表示不设时限）。 */
function remainingMs(start: number): number {
  return Math.max(1, TIMEOUTS.cacheSettle - (Date.now() - start));
}

/** 按 `idb.keys()` 的排序规则（默认 `sort()`）排列的键集合。 */
function sortedIds(ids: readonly string[]): string[] {
  return [...ids].sort();
}

/** 等到 books store 的键集合恰为 `ids`。 */
async function expectCacheKeys(idb: IdbProbe, ids: readonly string[], timeout: number, why: string): Promise<void> {
  await expect
    .poll(() => idb.keys(), { message: `IndexedDB books store 的键集合（${why}）`, timeout })
    .toEqual(sortedIds(ids));
}

/** 依次整页打开 `books`，每本等到其记录出现（前置，时限 `TIMEOUTS.wait`），最后核对键集合恰为这几本。 */
async function openAndCache(page: Page, bookLog: BookLog, idb: IdbProbe, books: readonly BookUnderTest[]): Promise<void> {
  for (const book of books) {
    await openBook(page, bookLog, book);
    await step(`前置：IndexedDB books store 出现 ${book.id} 的记录`, async () => {
      await expect
        .poll(() => idb.keys(), { message: `books store 的键集合应含 ${book.id}`, timeout: TIMEOUTS.wait })
        .toContain(book.id);
    });
  }
  await step(`前置：books store 的键集合恰为这 ${books.length} 本`, async () => {
    await expectCacheKeys(idb, books.map((b) => b.id), TIMEOUTS.wait, "前置");
  });
}

/** 点顶栏"阅读设置"打开设置抽屉。 */
async function openSettingsDrawer(page: Page): Promise<void> {
  await step("点击顶栏“阅读设置”打开设置抽屉", async () => {
    await reader(page).settingsButton.click();
    await expect(settingsDrawer(page).marker).toBeVisible();
  });
}

/** 等"已缓存"一行由"统计中…"变为"N 本 · 大小"的读数（H11），返回此刻的文本（只读一次，不重试）。 */
async function readCacheUsage(page: Page): Promise<string> {
  return step("等“已缓存”由“统计中…”变为读数（H11），读取该行", async () => {
    const usage = settingsDrawer(page).cacheUsage;
    await expect(usage, "“已缓存”一行应显示“N 本 · 大小”的读数").toHaveText(/^\d+ 本 · .+$/);
    return ((await usage.textContent()) ?? "").trim();
  });
}

/** 某书 `.txt.gz` 与 `_toc.json` 的请求（按解码后的路径识别）。 */
interface BookRequests {
  gz: string[];
  toc: string[];
  /** 期间全部请求的 URL（按发出顺序）。 */
  all: string[];
}

/** 开始记录本上下文发出的请求；`stop()` 停止记录并返回该书的两类请求。 */
function watchBookRequests(context: BrowserContext, bookId: string): { stop(): BookRequests } {
  const gzPath = `/books/${bookId}.txt.gz`;
  const tocPath = `/data/${bookId}_toc.json`;
  const seen: BookRequests = { gz: [], toc: [], all: [] };
  let recording = true;
  const onRequest = (request: Request): void => {
    if (!recording) return;
    const url = request.url();
    seen.all.push(url);
    const p = decodedPath(url);
    if (p === gzPath) seen.gz.push(url);
    else if (p === tocPath) seen.toc.push(url);
  };
  context.on("request", onRequest);
  return {
    stop() {
      recording = false;
      context.off("request", onRequest);
      return seen;
    },
  };
}

// ---------------------------------------------------------------------------
// 11.2
// ---------------------------------------------------------------------------

test("11.2 全新上下文打开一本书：[book-load] 为 source=network 且 gz 字段为 .txt.gz 的字节数；日志出现后 5 s 内 IndexedDB books 出现该书记录，所存 gz 与 .txt.gz 逐字节相同", async ({
  page,
  lib,
  bookLog,
  idb,
}) => {
  const [book] = await pickBooks(lib, 1);
  const file = await gzFileFacts(lib, book.id);
  const opened = await openBook(page, bookLog, book);

  await step(`11.2 [book-load] ${book.id} 为 source=network，gz 字段为 ${file.bytes} 字节的写法「${gzToken(file.bytes)}」`, async () => {
    test.info().annotations.push({
      type: "cache-book-load",
      description: `${book.id} source=${opened.line.source} gz=${opened.line.gz} chars=${opened.line.chars}；文件 ${file.bytes} 字节`,
    });
    expect(opened.line.source, "全新上下文首次打开的来源分支").toBe("network");
    expect(opened.line.gz, `gz 字段（文件 ${file.bytes} 字节）`).toBe(gzToken(file.bytes));
  });

  await step(`11.2 日志出现后 ${TIMEOUTS.cacheSettle} ms 内 books store 出现以 ${book.id} 为键的记录`, async () => {
    await expect
      .poll(() => idb.keys(), {
        message: `books store 的键集合应含 ${book.id}（自 [book-load] 行起 ${TIMEOUTS.cacheSettle} ms 内）`,
        timeout: remainingMs(opened.loggedAt),
      })
      .toContain(book.id);
  });

  await step("11.2 记录所存 gz 与 .txt.gz 逐字节相同（字节长度与 SHA-256）", async () => {
    const [stored, sizes] = await Promise.all([idb.gzSha256(book.id), idb.gzSizes()]);
    const size = sizes.find((s) => s.bookId === book.id)?.gzBytes ?? null;
    test.info().annotations.push({
      type: "cache-record",
      description: `记录 gz ${size ?? "（无）"} 字节，SHA-256 ${stored ?? "（无）"}；文件 ${file.bytes} 字节，SHA-256 ${file.sha256}`,
    });
    expect(size, "记录所存 gz 的字节长度").toBe(file.bytes);
    expect(stored, "记录所存 gz 的 SHA-256").toBe(file.sha256);
  });
});

// ---------------------------------------------------------------------------
// 11.3
// ---------------------------------------------------------------------------

test("11.3 记录出现后整页重载阅读页：[book-load] 为 source=indexeddb 并渲染章节；重载到正文渲染完成期间该书 .txt.gz 请求 0 次、_toc.json 恰好 1 次", async ({
  page,
  context,
  lib,
  bookLog,
  idb,
}) => {
  const [book] = await pickBooks(lib, 1);
  const first = await openBook(page, bookLog, book);
  await step("前置（11.2）：首次打开为 source=network，IndexedDB 出现该书记录", async () => {
    expect(first.line.source, "首次打开的来源分支").toBe("network");
    await expect
      .poll(() => idb.keys(), { message: `books store 的键集合应含 ${book.id}`, timeout: TIMEOUTS.wait })
      .toContain(book.id);
  });
  const headingBefore = ((await reader(page).chapterHeading.textContent()) ?? "").trim();

  const since = bookLog.count;
  const watch = watchBookRequests(context, book.id);
  let seen: BookRequests;
  try {
    await step("整页重载（page.reload），等本次加载的 [book-load] 行、正文 <h1> 与首个段落", async () => {
      await page.reload();
      await bookLog.waitFor(book.id, undefined, { since, timeout: book.loadTimeout });
      await expect(reader(page).chapterHeading).toBeVisible();
      await expect(reader(page).paragraphs.first()).toBeVisible();
    });
  } finally {
    seen = watch.stop();
  }
  test.info().annotations.push({
    type: "cache-reload-requests",
    description:
      `重载到正文渲染期间请求 ${seen.all.length} 个；${book.id}.txt.gz ${seen.gz.length} 次，` +
      `${book.id}_toc.json ${seen.toc.length} 次`,
  });

  await step("11.3 重载后的 [book-load] 为 source=indexeddb", async () => {
    const lines = bookLog.all().slice(since).filter((l) => l.bookId === book.id);
    test.info().annotations.push({
      type: "cache-book-load",
      description: lines.map((l) => `${l.bookId} source=${l.source} gz=${l.gz} chars=${l.chars}`).join("；"),
    });
    expect(lines[0]?.source, "重载后第一条 [book-load] 的来源分支").toBe("indexeddb");
  });
  await step(`11.3 重载后渲染该书章节（正文 <h1> 仍为「${headingBefore}」）`, async () => {
    await expect(reader(page).chapterHeading, "重载前后正文的一级标题").toHaveText(headingBefore);
  });
  await step("11.3 重载到正文渲染完成期间未请求该书 .txt.gz", async () => {
    expect(seen.gz, `${book.id}.txt.gz 的请求`).toEqual([]);
  });
  await step("11.3 重载到正文渲染完成期间该书 _toc.json 恰好请求 1 次", async () => {
    expect(seen.toc.length, `${book.id}_toc.json 的请求次数（${seen.toc.join("、") || "无"}）`).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 11.6
// ---------------------------------------------------------------------------

test("11.6 整页导航依次打开 2 本书、IndexedDB 出现这 2 条记录后打开设置抽屉：“已缓存”由“统计中…”变为读数后为「2 本 · formatByteSize(S)」", async ({
  page,
  lib,
  bookLog,
  idb,
}) => {
  const books = await pickBooks(lib, 2);
  await openAndCache(page, bookLog, idb, books);

  const s = await step("读 IndexedDB 各记录所存 gz 的字节长度之和 S，核对它等于这 2 本 .txt.gz 的文件大小之和", async () => {
    const sizes = await idb.gzSizes();
    const files = await Promise.all(books.map((b) => lib.gzSize(b.id)));
    const sum = sizes.reduce((acc, x) => acc + x.gzBytes, 0);
    const fileSum = files.reduce((acc, x) => acc + x, 0);
    test.info().annotations.push({
      type: "cache-usage-expected",
      description:
        `记录 ${sizes.map((x) => `${x.bookId} ${x.gzBytes} 字节`).join("、")}；S = ${sum}；` +
        `文件大小之和 ${fileSum}；formatByteSize(S) = ${formatByteSize(sum)}`,
    });
    expect(sizes.map((x) => x.bookId), "books store 的记录").toEqual(sortedIds(books.map((b) => b.id)));
    expect(sum, "S（各记录所存 gz 的字节长度之和）应等于 2 本 .txt.gz 的文件大小之和").toBe(fileSum);
    return sum;
  });

  await openSettingsDrawer(page);
  const reading = await readCacheUsage(page);
  const expected = `${books.length} 本 · ${formatByteSize(s)}`;
  await step(`11.6 “已缓存”一行为「${expected}」`, async () => {
    test.info().annotations.push({ type: "cache-usage", description: `“已缓存”读数「${reading}」；期望「${expected}」` });
    expect(reading, "“已缓存”一行的读数").toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// 11.7
// ---------------------------------------------------------------------------

test("11.7 在设置抽屉把“离线缓存本数上限”设为 1，随后整页导航依次打开从未打开过的书 A、B：打开 A 后 5 s 内 books 只含 A，打开 B 后只含 B", async ({
  page,
  lib,
  bookLog,
  idb,
}) => {
  const [x, a, b] = await pickBooks(lib, 3);
  await openAndCache(page, bookLog, idb, [x]);

  await openSettingsDrawer(page);
  await step("把“离线缓存本数上限”设为 1（聚焦滑杆后按 Home）", async () => {
    const drawer = settingsDrawer(page);
    await drawer.cacheMaxBooksSlider.press("Home");
    await expect(drawer.cacheMaxBooksSlider, "滑杆的值").toHaveValue("1");
    await expect(drawer.cacheMaxBooksValue, "上限的显示值").toHaveText("1 本");
  });

  for (const [label, book] of [
    ["A", a],
    ["B", b],
  ] as const) {
    const opened = await openBook(page, bookLog, book);
    await step(`11.7 打开 ${label}（${book.id}）后 ${TIMEOUTS.cacheSettle} ms 内 books store 只含 ${label} 的记录`, async () => {
      await expectCacheKeys(idb, [book.id], remainingMs(opened.loggedAt), `打开 ${label} 后只含 ${book.id}`);
      test.info().annotations.push({
        type: "cache-keys",
        description:
          `打开 ${label}（${book.id}，source=${opened.line.source}）后 ${Date.now() - opened.loggedAt} ms 内` +
          `键集合为 ${book.id}`,
      });
    });
  }
});

// ---------------------------------------------------------------------------
// 11.8
// ---------------------------------------------------------------------------

test("11.8 IndexedDB 有 2 条记录时在设置抽屉点击“清空缓存”：5 s 内 books 记录数为 0，“已缓存”显示「0 本 · 0B」", async ({
  page,
  lib,
  bookLog,
  idb,
}) => {
  const books = await pickBooks(lib, 2);
  await openAndCache(page, bookLog, idb, books);

  await openSettingsDrawer(page);
  const before = await readCacheUsage(page);
  const drawer = settingsDrawer(page);
  await step("“清空缓存”按钮可用", async () => {
    await expect(drawer.clearCacheButton).toHaveAccessibleName(NAMES.clearCache);
    await expect(drawer.clearCacheButton).toBeEnabled();
  });

  const clickedAt = await step("点击“清空缓存”", async () => {
    const at = Date.now();
    await drawer.clearCacheButton.click();
    return at;
  });

  await step(`11.8 点击后 ${TIMEOUTS.cacheSettle} ms 内 books store 记录数为 0，“已缓存”显示「0 本 · 0B」`, async () => {
    await Promise.all([
      expect
        .poll(async () => (await idb.keys()).length, {
          message: `books store 的记录数（自点击起 ${TIMEOUTS.cacheSettle} ms 内）`,
          timeout: remainingMs(clickedAt),
        })
        .toBe(0),
      expect(drawer.cacheUsage, `“已缓存”一行（自点击起 ${TIMEOUTS.cacheSettle} ms 内）`).toHaveText("0 本 · 0B", {
        timeout: remainingMs(clickedAt),
      }),
    ]);
    test.info().annotations.push({
      type: "cache-clear",
      description:
        `点击前 books store ${books.length} 条、“已缓存”「${before}」；` +
        `自点击起 ${Date.now() - clickedAt} ms 内记录数为 0、“已缓存”为「0 本 · 0B」`,
    });
  });
});
