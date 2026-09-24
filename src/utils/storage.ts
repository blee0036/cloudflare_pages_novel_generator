import { ReaderSettings, ReadingProgress, ReaderThemeKey, Bookmark } from "../types";

export interface ThemeConfig {
  key: ReaderThemeKey;
  name: string;
  bg: string;
  text: string;
  border: string;
  accent: string;
  cardBg: string;
}

export const THEME_CONFIGS: Record<ReaderThemeKey, ThemeConfig> = {
  default: {
    key: "default",
    name: "默认明亮",
    bg: "#ffffff",
    text: "#1f2937",
    border: "#e5e7eb",
    accent: "#3b82f6",
    cardBg: "#f9fafb",
  },
  sepia: {
    key: "sepia",
    name: "复古羊皮",
    bg: "#f8f1e3",
    text: "#523c21",
    border: "#ebd9bf",
    accent: "#b45309",
    cardBg: "#f2e6d0",
  },
  eyecare: {
    key: "eyecare",
    name: "护眼豆绿",
    bg: "#eaf3e8",
    text: "#244228",
    border: "#d1e4cf",
    accent: "#15803d",
    cardBg: "#dff0dc",
  },
  dark: {
    key: "dark",
    name: "暗色夜间",
    bg: "#1e2430",
    text: "#cbd5e1",
    border: "#334155",
    accent: "#60a5fa",
    cardBg: "#283141",
  },
  black: {
    key: "black",
    name: "极夜纯黑",
    bg: "#000000",
    text: "#9ca3af",
    border: "#262626",
    accent: "#38bdf8",
    cardBg: "#121212",
  },
};

const DEFAULT_SETTINGS: ReaderSettings = {
  theme: "sepia",
  fontSize: 19,
  lineHeight: 1.85,
  letterSpacing: 1,
  fontFamily: "system",
  contentWidth: 820,
  viewMode: "scroll",
};

const SETTINGS_KEY = "koodo_novel_reader_settings";
const PROGRESS_PREFIX = "koodo_novel_progress_";
const BOOKMARKS_PREFIX = "koodo_novel_bookmarks_";

// --- Settings ---
export function getStoredSettings(): ReaderSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    }
  } catch (e) {
    console.error("Failed to load settings:", e);
  }
  return DEFAULT_SETTINGS;
}

export function saveStoredSettings(settings: ReaderSettings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (e) {
    console.error("Failed to save settings:", e);
  }
}

// --- Reading Progress ---
export function getBookProgress(bookId: string): ReadingProgress | null {
  try {
    const raw = localStorage.getItem(`${PROGRESS_PREFIX}${bookId}`);
    if (raw) {
      return JSON.parse(raw);
    }
  } catch (e) {
    console.error("Failed to load progress:", e);
  }
  return null;
}

export function saveBookProgress(progress: ReadingProgress) {
  try {
    localStorage.setItem(
      `${PROGRESS_PREFIX}${progress.bookId}`,
      JSON.stringify(progress)
    );
  } catch (e) {
    console.error("Failed to save progress:", e);
  }
}

export function getAllReadingHistory(): ReadingProgress[] {
  const history: ReadingProgress[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(PROGRESS_PREFIX)) {
        const item = localStorage.getItem(key);
        if (item) {
          history.push(JSON.parse(item));
        }
      }
    }
    history.sort((a, b) => b.lastReadTime - a.lastReadTime);
  } catch (e) {
    console.error("Failed to load reading history:", e);
  }
  return history;
}

// --- Bookmarks ---
export function getBookmarks(bookId: string): Bookmark[] {
  try {
    const raw = localStorage.getItem(`${BOOKMARKS_PREFIX}${bookId}`);
    if (raw) {
      return JSON.parse(raw);
    }
  } catch (e) {
    console.error("Failed to load bookmarks:", e);
  }
  return [];
}

export function saveBookmarks(bookId: string, bookmarks: Bookmark[]) {
  try {
    localStorage.setItem(
      `${BOOKMARKS_PREFIX}${bookId}`,
      JSON.stringify(bookmarks)
    );
  } catch (e) {
    console.error("Failed to save bookmarks:", e);
  }
}

export function addBookmark(bookmark: Bookmark) {
  const list = getBookmarks(bookmark.bookId);
  // Avoid duplicates in same chapter
  const exists = list.some((b) => b.chapterId === bookmark.chapterId);
  if (!exists) {
    list.unshift(bookmark);
    saveBookmarks(bookmark.bookId, list);
  }
}

export function removeBookmark(bookId: string, bookmarkId: string) {
  const list = getBookmarks(bookId).filter((b) => b.id !== bookmarkId);
  saveBookmarks(bookId, list);
}

export function isChapterBookmarked(bookId: string, chapterId: number): boolean {
  const list = getBookmarks(bookId);
  return list.some((b) => b.chapterId === chapterId);
}
