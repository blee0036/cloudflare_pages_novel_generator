/**
 * 从书架（书卡、章节目录弹窗）整本下载：先把正文取到手，再交给 `downloadBookAsTxt`。
 *
 * 阅读器里的下载不走这里：那时全文已在 `ReaderPage` 的 `fullText` 里，直接同步生成文件，
 * 不发任何请求（需求 9.1）。书架上手里只有 `books.json` 的一行，正文要按打开这本书时的
 * 同一条路径取——`loadGzipBookText`（内存 → IndexedDB → 网络）。所以：
 *
 * - 读过的书、或刚在书架下载过的书，再下载 / 再打开都不重复取数；
 * - 取到的正文与阅读器看到的是同一份（同样过码点检查），文件内容因此一致；
 * - 代价与打开这本书相同：会写一份离线缓存，也会留在本会话的内存缓存里。
 *
 * `download.ts` 保持"不碰网络"的承诺，取数与保存的拼装放在这个单独的模块里。
 *
 * ## 为什么是模块级的状态，而不是组件里的 `useState`
 *
 * 同一本书在书卡和弹窗里各有一个按钮，弹窗还可能在下载途中关掉再打开。状态挂在组件上，
 * 两个按钮会各自发起一轮下载、各存一个文件，关掉弹窗再打开时进度也丢了。按 `bookId`
 * 记在模块里：同一本书同时只有一个任务，所有按钮看到的是同一个进度。
 */
import { loadGzipBookText } from "./decompress";
import { downloadBookAsTxt } from "./download";
import { formatLoadErrorLog } from "./loadError";
import { INDETERMINATE, LoadProgress, sameLoadProgress } from "./loadProgress";
import { txtUrl } from "./locator";

/** 一本书的下载状态。没有任务时为 `idle`；失败后停在 `failed`，直到再次点下载。 */
export type BookDownloadState =
  | { readonly status: "idle" }
  | { readonly status: "loading"; readonly progress: LoadProgress }
  | { readonly status: "failed" };

/** 下载任务需要的书籍信息：`id` 定位正文，`title` 定文件名。 */
export interface DownloadableBook {
  readonly id: string;
  readonly title: string;
}

export interface BookDownloadDeps {
  loadText(bookId: string, onProgress: (progress: LoadProgress) => void): Promise<string>;
  save(text: string, title: string): void;
  logError(bookId: string, error: unknown): void;
}

export interface BookDownloads {
  /** 当前状态。没变化时返回同一个对象，可直接作 `useSyncExternalStore` 的快照。 */
  getState(bookId: string): BookDownloadState;
  /** 订阅任意一本书的状态变化，返回退订函数。 */
  subscribe(listener: () => void): () => void;
  /**
   * 开始下载。这本书已在下载中时什么也不做（不会存出第二个文件）。
   * 永不 reject：失败记进状态并写一行控制台日志。
   */
  start(book: DownloadableBook): Promise<void>;
}

/** `idle` 的共享单例：快照必须引用稳定，否则 `useSyncExternalStore` 会无限重渲染。 */
export const DOWNLOAD_IDLE: BookDownloadState = Object.freeze({ status: "idle" } as const);
const DOWNLOAD_FAILED: BookDownloadState = Object.freeze({ status: "failed" } as const);

export function createBookDownloads(deps: BookDownloadDeps): BookDownloads {
  const states = new Map<string, BookDownloadState>();
  const listeners = new Set<() => void>();

  const setState = (bookId: string, next: BookDownloadState): void => {
    if (next === DOWNLOAD_IDLE) states.delete(bookId);
    else states.set(bookId, next);
    for (const listener of listeners) listener();
  };

  const getState = (bookId: string): BookDownloadState => states.get(bookId) ?? DOWNLOAD_IDLE;

  return {
    getState,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async start(book) {
      if (getState(book.id).status === "loading") return;
      setState(book.id, { status: "loading", progress: INDETERMINATE });

      try {
        const text = await deps.loadText(book.id, (progress) => {
          const current = getState(book.id);
          // 百分比没变就不通知：大书有数百个分片，屏幕上只有 101 个可区分的读数
          if (current.status !== "loading" || sameLoadProgress(current.progress, progress)) return;
          setState(book.id, { status: "loading", progress });
        });
        deps.save(text, book.title);
        setState(book.id, DOWNLOAD_IDLE);
      } catch (error) {
        deps.logError(book.id, error);
        setState(book.id, DOWNLOAD_FAILED);
      }
    },
  };
}

/** 全站共用的一份下载任务表。 */
export const bookDownloads: BookDownloads = createBookDownloads({
  loadText: (bookId, onProgress) => loadGzipBookText(txtUrl(bookId), bookId, onProgress),
  save: downloadBookAsTxt,
  logError: (bookId, error) => console.error(formatLoadErrorLog("text", bookId, error)),
});

/**
 * 按钮上显示的文字。`idleLabel` 由调用方给（书卡上地方小，弹窗里可以写全）。
 *
 * 不确定态（缓存命中、或服务器没给总长度）不显示百分比，只写"下载中…"，
 * 与阅读器加载页同一口径：没有读数就不编一个 0%。
 */
export function downloadButtonLabel(state: BookDownloadState, idleLabel: string): string {
  switch (state.status) {
    case "loading":
      return state.progress.kind === "determinate"
        ? `下载中 ${state.progress.pct}%`
        : "下载中…";
    case "failed":
      return "下载失败，重试";
    default:
      return idleLabel;
  }
}
