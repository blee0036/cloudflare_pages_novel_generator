/**
 * 加载路径：Transparent_Mode 下不经 IndexedDB 缓存（需求 11.4）。`fixture-transparent` 项目
 * （:4612，Transparent_Mode；模式只在项目级声明，5.5、6.11），桌面视口，默认主题（不 seedTheme），
 * 不装 Controlled_Clock。
 *
 * ## 用书（4.4：期望值运行时推导）
 *
 * `pickBooks(lib, 1)`（`e2e/support/cache.ts`）：当前书库 `books.json` 中 `.txt.gz` 最小的一本。
 * 走哪条分支只由响应头决定，与书的内容无关。
 *
 * ## 观测
 *
 * - 前置：用例的 `target.mode` 为 `transparent`（`target` fixture 已核对 `baseURL` 指向该实例）；
 *   首次打开时该书 `.txt.gz` 的响应（`page.waitForResponse`，在导航前登记，按解码后的路径识别）
 *   状态 200、带 `Content-Encoding: gzip`。这两条只确认用例确实跑在 Transparent_Mode 实例上，
 *   响应头与字节的逐项核对属于 5.4（`server-resolve.spec.ts`）。
 * - `[book-load]`：`bookLog`。首次打开经 `openBook`（等同一行与正文 `<h1>`）；重载前记下
 *   `bookLog.count`，取其后该书的第一行。
 * - IndexedDB：`idb.keys()`（只读，不会创建库）。"此时"取重载后那条 `[book-load]` 行到达测试进程
 *   之后立即读一次，不轮询：Transparent_Mode 下应用没有要写入的 gz，不存在"稍后才出现"的记录。
 *
 * 读数（用书、响应头、两次 `[book-load]`、键集合）记在注解 `cache-*` 里。
 */
import type { Page } from "@playwright/test";
import { decodedPath, openBook, pickBooks } from "../../support/cache";
import { expect, test } from "../../support/fixtures";
import { step } from "../../support/step";

/** 某书 `.txt.gz` 响应中与模式有关的读数。 */
interface GzResponse {
  url: string;
  status: number;
  contentEncoding: string | null;
  contentLength: string | null;
  contentType: string | null;
}

/**
 * 登记等待该书下一个 `.txt.gz` 响应（按解码后的路径识别），须在触发请求的导航之前调用。
 * 返回的 Promise 被放弃时不留下未处理的拒绝；调用方仍 await 同一个 Promise。
 */
function awaitGzResponse(page: Page, bookId: string, timeout: number): Promise<GzResponse> {
  const gzPath = `/books/${bookId}.txt.gz`;
  const pending = page
    .waitForResponse((r) => decodedPath(r.url()) === gzPath, { timeout })
    .then(async (r) => {
      const headers = await r.allHeaders();
      return {
        url: r.url(),
        status: r.status(),
        contentEncoding: headers["content-encoding"] ?? null,
        contentLength: headers["content-length"] ?? null,
        contentType: headers["content-type"] ?? null,
      };
    });
  void pending.catch(() => undefined);
  return pending;
}

test("11.4 Transparent_Mode 下全新上下文打开一本书：[book-load] 为 source=network-transparent；日志出现后整页重载，再次为 source=network-transparent（而非 indexeddb），且此时 IndexedDB books 中没有以该书 id 为键的记录", async ({
  page,
  lib,
  bookLog,
  idb,
  target,
}) => {
  await step("前置：本用例指派给 Transparent_Mode 实例", async () => {
    expect(target?.mode, "项目声明的服务模式").toBe("transparent");
  });

  const [book] = await pickBooks(lib, 1);
  const firstGz = awaitGzResponse(page, book.id, book.loadTimeout);
  const first = await openBook(page, bookLog, book);

  await step(`前置：${book.id}.txt.gz 的响应状态 200、带 Content-Encoding: gzip`, async () => {
    const r = await firstGz;
    test.info().annotations.push({
      type: "cache-gz-response",
      description:
        `${decodedPath(r.url) ?? r.url} 状态 ${r.status}；Content-Encoding ${r.contentEncoding ?? "（无）"}；` +
        `Content-Length ${r.contentLength ?? "（无）"}（文件 ${book.gzBytes} 字节）；Content-Type ${r.contentType ?? "（无）"}`,
    });
    expect(r.status, ".txt.gz 的响应状态").toBe(200);
    expect(r.contentEncoding, ".txt.gz 响应的 Content-Encoding").toBe("gzip");
  });

  await step(`11.4 首次打开的 [book-load] ${book.id} 为 source=network-transparent`, async () => {
    test.info().annotations.push({
      type: "cache-book-load",
      description: `首次打开：${book.id} source=${first.line.source} gz=${first.line.gz} chars=${first.line.chars}`,
    });
    expect(first.line.source, "全新上下文首次打开的来源分支").toBe("network-transparent");
  });

  const since = bookLog.count;
  const keys = await step("该日志出现后整页重载（page.reload），等本次加载的 [book-load] 行，随即读 IndexedDB books store 的键集合", async () => {
    await page.reload();
    await bookLog.waitFor(book.id, undefined, { since, timeout: book.loadTimeout });
    return idb.keys();
  });

  await step("11.4 重载后的 [book-load] 再次为 source=network-transparent（而非 indexeddb）", async () => {
    const lines = bookLog.all().slice(since).filter((l) => l.bookId === book.id);
    test.info().annotations.push({
      type: "cache-book-load",
      description: `重载后：${lines.map((l) => `${l.bookId} source=${l.source} gz=${l.gz} chars=${l.chars}`).join("；")}`,
    });
    expect(lines[0]?.source, "重载后第一条 [book-load] 的来源分支").toBe("network-transparent");
  });

  await step(`11.4 此时 IndexedDB books store 中没有以 ${book.id} 为键的记录`, async () => {
    test.info().annotations.push({
      type: "cache-keys",
      description: `重载后的 [book-load] 到达时 books store 的键集合：${keys.length > 0 ? keys.join("、") : "（空）"}`,
    });
    expect(keys, "books store 的键集合").not.toContain(book.id);
  });
});
