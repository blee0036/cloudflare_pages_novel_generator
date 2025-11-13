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
  books: BookRow[];
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
