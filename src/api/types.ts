export interface BookSummary {
  id: string;
  title: string;
  author: string;
  totalChapters: number;
}

export type BookRow = [string, string, string, number];

export interface BooksFile {
  generatedAt: string;
  columns: ["id", "title", "author", "totalChapters"];
  books: BookSummary[]; // 转换后的对象数组
}

export interface BooksFileRaw {
  generatedAt: string;
  columns: ["id", "title", "author", "totalChapters"];
  books: BookRow[]; // 原始的数组格式
}

export interface PartInfo {
  path: string;
  size: number;
}

export type ChapterEntry = [string, string, number];

export interface ChaptersFile {
  book: {
    id: string;
    title: string;
    author: string;
    totalChapters: number;
    parts: PartInfo[];
    totalSize: number;
  };
  chapters: ChapterEntry[];
}
