import { useCallback, useSyncExternalStore } from "react";
import {
  BookDownloadState,
  DOWNLOAD_IDLE,
  DownloadableBook,
  bookDownloads,
} from "../utils/bookDownload";

/**
 * 书架上某本书的下载状态与入口（书卡、章节目录弹窗共用）。
 *
 * 状态在 `utils/bookDownload.ts` 的模块级任务表里，这里只订阅：同一本书的书卡按钮与弹窗按钮
 * 看到的是同一个进度，弹窗关掉再打开也接得上。`book` 为 `null`（弹窗未打开）时恒为 idle。
 */
export function useBookDownload(book: DownloadableBook | null): {
  state: BookDownloadState;
  start: () => void;
} {
  const bookId = book?.id ?? null;
  const getSnapshot = useCallback(
    () => (bookId === null ? DOWNLOAD_IDLE : bookDownloads.getState(bookId)),
    [bookId],
  );
  const state = useSyncExternalStore(bookDownloads.subscribe, getSnapshot);

  const start = useCallback(() => {
    if (book) void bookDownloads.start(book);
  }, [book]);

  return { state, start };
}
