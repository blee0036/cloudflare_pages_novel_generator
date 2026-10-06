import { BookToc } from "../types";
import { fetchJson } from "./loadError";
import { tocUrl } from "./locator";

/**
 * 以 bookId 为键缓存 **Promise 而非结果**：并发的两个调用方（书架弹窗与阅读器）
 * 拿到的是同一个在途请求，因此一次会话内同一本书最多发一次 `_toc.json` 请求
 * （需求 3.4；大书的 `_toc.json` 压缩后也只有几十 KB）。
 */
const tocCache = new Map<string, Promise<BookToc>>();

/**
 * 取一本书的 `_toc.json`。失败经 `fetchJson` 抛出带类型的错误（`NetworkError`、
 * `HttpStatusError`、`ResponseFormatError`），阅读器据此按 `toc` 阶段分类，
 * 不再依赖错误消息文本（reader-defect-fixes 需求 13.1、13.2）。
 *
 * 保留 `async`：`tocUrl` 若同步抛错（`encodeURIComponent` 遇孤立代理项），仍以 rejection
 * 交给调用方并照常逐出，与改动前一致。
 */
async function fetchToc(bookId: string): Promise<BookToc> {
  return fetchJson<BookToc>(tocUrl(bookId));
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
