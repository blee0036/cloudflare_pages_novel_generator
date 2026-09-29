import { BookToc } from "../types";
import { tocUrl } from "./locator";

/**
 * 以 bookId 为键缓存 **Promise 而非结果**：并发的两个调用方（书架弹窗与阅读器）
 * 拿到的是同一个在途请求，因此一次会话内同一本书最多发一次 `_toc.json` 请求
 * （需求 3.4；最大书压缩后 89 KB）。
 */
const tocCache = new Map<string, Promise<BookToc>>();

async function fetchToc(bookId: string): Promise<BookToc> {
  const res = await fetch(tocUrl(bookId));
  if (!res.ok) {
    throw new Error(`无法获取章节索引 (HTTP ${res.status})`);
  }
  return (await res.json()) as BookToc;
}

/**
 * 获取某本书的章节表，同一会话内复用。
 *
 * 失败的 Promise 不会被长期持有：请求一旦 reject 就把条目摘掉，使调用方的重试
 * （重新打开弹窗、重新进入阅读器）能真正重新发起请求，而不是反复拿到同一个旧的失败。
 */
export function loadToc(bookId: string): Promise<BookToc> {
  const cached = tocCache.get(bookId);
  if (cached) return cached;

  const pending = fetchToc(bookId);
  tocCache.set(bookId, pending);

  // 这里挂的 catch 只负责逐出，不改变返回给调用方的 Promise（调用方仍会收到 rejection）。
  // 同时它也让 rejection 有了处理者，避免 unhandledrejection 噪音。
  pending.catch(() => {
    if (tocCache.get(bookId) === pending) {
      tocCache.delete(bookId);
    }
  });

  return pending;
}
