import { useEffect, useState } from "react";
import {
  loadReadingProgress,
  getBookProgress,
  READING_PROGRESS_EVENT,
  type ReadingProgressEntry,
} from "../utils/readingProgress";

const hasWindow = typeof window !== "undefined";

export function useReadingHistory(limit = 5): ReadingProgressEntry[] {
  const [history, setHistory] = useState<ReadingProgressEntry[]>(() => loadReadingProgress(limit));

  useEffect(() => {
    if (!hasWindow) return;
    const update = () => setHistory(loadReadingProgress(limit));
    window.addEventListener(READING_PROGRESS_EVENT, update);
    window.addEventListener("storage", update);
    return () => {
      window.removeEventListener(READING_PROGRESS_EVENT, update);
      window.removeEventListener("storage", update);
    };
  }, [limit]);

  return history.slice(0, limit);
}

export function useBookProgress(bookId: string | undefined): ReadingProgressEntry | null {
  const [progress, setProgress] = useState<ReadingProgressEntry | null>(() => getBookProgress(bookId));

  useEffect(() => {
    if (!hasWindow || !bookId) {
      return;
    }
    const update = () => setProgress(getBookProgress(bookId));
    update();
    window.addEventListener(READING_PROGRESS_EVENT, update);
    window.addEventListener("storage", update);
    return () => {
      window.removeEventListener(READING_PROGRESS_EVENT, update);
      window.removeEventListener("storage", update);
    };
  }, [bookId]);

  return progress;
}
