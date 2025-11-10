export interface ReadingProgressEntry {
  bookId: string;
  bookTitle: string;
  author: string;
  chapterId: string;
  chapterTitle: string;
  updatedAt: number;
  // 新增：滚动位置（字符偏移）
  scrollPosition?: number;
  // 新增：书籍hash，用于检测文件是否变化
  bookHash?: string;
}

const STORAGE_KEY = "novel-reading-progress:v1";
const HISTORY_LIMIT = 20;
export const READING_PROGRESS_EVENT = "reading-progress-updated";

const hasWindow = typeof window !== "undefined";

function readEntries(): ReadingProgressEntry[] {
  if (!hasWindow) return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ReadingProgressEntry[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) =>
        item && typeof item === "object" && typeof item.bookId === "string" && typeof item.chapterId === "string",
      )
      .map((item) => ({
        ...item,
        updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : Date.now(),
      }));
  } catch (error) {
    console.error("读取阅读进度失败", error);
    return [];
  }
}

function writeEntries(entries: ReadingProgressEntry[]): void {
  if (!hasWindow) return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

export function loadReadingProgress(limit?: number): ReadingProgressEntry[] {
  const entries = readEntries().sort((a, b) => b.updatedAt - a.updatedAt);
  return typeof limit === "number" ? entries.slice(0, limit) : entries;
}

export function getBookProgress(bookId: string | undefined): ReadingProgressEntry | null {
  if (!bookId) return null;
  const entries = loadReadingProgress();
  return entries.find((item) => item.bookId === bookId) ?? null;
}

export function saveReadingProgress(entry: ReadingProgressEntry): void {
  if (!hasWindow) return;
  const existing = readEntries().filter((item) => item.bookId !== entry.bookId);
  const nextEntries = [{ ...entry, updatedAt: Date.now() }, ...existing].slice(0, HISTORY_LIMIT);
  writeEntries(nextEntries);
  window.dispatchEvent(new CustomEvent(READING_PROGRESS_EVENT));
}

export function clearReadingProgress(): void {
  if (!hasWindow) return;
  window.localStorage.removeItem(STORAGE_KEY);
  window.dispatchEvent(new CustomEvent(READING_PROGRESS_EVENT));
}
