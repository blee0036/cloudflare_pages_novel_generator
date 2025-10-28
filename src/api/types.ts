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

export type ChapterEntry = [string, string, number, number, number];

export interface ChaptersFile {
  book: {
    id: string;
    title: string;
    author: string;
    totalChapters: number;
    assets: string[];
  };
  chapters: ChapterEntry[];
}
