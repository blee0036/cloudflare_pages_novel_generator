/**
 * 加载路径与离线缓存用例的共用步骤（任务 12.1 起；`cache-opaque.spec.ts`、`cache-transparent.spec.ts`）。
 *
 * | 函数 | 作用 |
 * | --- | --- |
 * | `pickBooks(lib, n)` | 取当前书库 `books.json` 中 `.txt.gz` 最小的 n 本（字节数升序，同大小按 id），附 `cache-books` 注解 |
 * | `openBook(page, bookLog, book)` | 经 `openReader` 整页打开阅读页，返回本次导航的 `[book-load]` 行及其到达测试进程的时刻 |
 * | `decodedPath(url)` | URL 的路径部分按百分号解码（中文 id 的请求据此与 `/books/<id>.txt.gz` 比对） |
 *
 * 缓存行为与书的内容无关，取小书只是让多次整页打开更快；期望值一律运行时推导（4.4）。
 */
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { BookLoadLine } from "../perf/metrics";
import type { BookLog, Lib } from "./fixtures";
import { bookUnderTest, openReader, type BookUnderTest } from "./reader";
import { step } from "./step";

/** 当前书库中 `.txt.gz` 最小的 `n` 本（字节数升序，同大小按 id 升序）。须在用例体内调用。 */
export async function pickBooks(lib: Lib, n: number): Promise<BookUnderTest[]> {
  const ids = await step(`选定用书：books.json 中 .txt.gz 最小的 ${n} 本`, async () => {
    const all = (await lib.books()).books.map((b) => b.id);
    const sized = await Promise.all(all.map(async (id) => ({ id, bytes: await lib.gzSize(id) })));
    sized.sort((a, b) => a.bytes - b.bytes || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const chosen = sized.slice(0, n);
    expect(chosen.length, `书库中的书应不少于 ${n} 本（books.json 共 ${all.length} 本）`).toBe(n);
    test.info().annotations.push({
      type: "cache-books",
      description: chosen.map((c) => `${c.id}（gz ${c.bytes} 字节）`).join("；"),
    });
    return chosen.map((c) => c.id);
  });
  const books: BookUnderTest[] = [];
  for (const id of ids) books.push(await bookUnderTest(lib, id));
  return books;
}

/** `openBook` 的结果。 */
export interface Opened {
  /** 本次导航的 `[book-load]` 行。 */
  line: BookLoadLine;
  /** 该行到达测试进程的时刻（`Date.now()`）。 */
  loggedAt: number;
}

/** 整页导航到 `/read/<id>`（`openReader`），返回本次导航的 `[book-load]` 行及其到达时刻。 */
export async function openBook(page: Page, bookLog: BookLog, book: BookUnderTest): Promise<Opened> {
  const since = bookLog.count;
  const logged = bookLog
    .waitFor(book.id, undefined, { since, timeout: book.loadTimeout })
    .then((line) => ({ line, loggedAt: Date.now() }));
  // openReader 自身失败时不留下未处理的拒绝；成功路径仍 await 同一个 Promise
  void logged.catch(() => undefined);
  await openReader(page, bookLog, book);
  return logged;
}

/** URL 的路径部分，按百分号解码；无法解析或解码时为 null。 */
export function decodedPath(url: string): string | null {
  try {
    return decodeURIComponent(new URL(url).pathname);
  } catch {
    return null;
  }
}
