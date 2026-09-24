export interface BookSummary {
  id: string;
  title: string;
  author: string;
  charCount: number;
  totalChapters: number;
  gzSize: number;
  txtPath: string;
  tocPath: string;
}

export interface BooksCatalog {
  count: number;
  books: BookSummary[];
}

export interface ChapterMeta {
  id: number;
  title: string;
  start: number;
  end: number;
  length: number;
}

export interface BookToc {
  id: string;
  title: string;
  author: string;
  charCount: number;
  totalChapters: number;
  chapters: ChapterMeta[];
}

export interface ReadingProgress {
  bookId: string;
  chapterId: number;
  chapterTitle: string;
  progressPercent: number;
  scrollRatio?: number;
  lastReadTime: number;
}

export interface Bookmark {
  id: string;
  bookId: string;
  chapterId: number;
  chapterTitle: string;
  previewText: string;
  createdAt: number;
}

export type ReaderThemeKey = "default" | "sepia" | "eyecare" | "dark" | "black";

export interface ReaderSettings {
  theme: ReaderThemeKey;
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  fontFamily: "system" | "serif" | "kaiti";
  contentWidth: number; // in px, e.g. 800
  viewMode: "scroll" | "paged";
}
