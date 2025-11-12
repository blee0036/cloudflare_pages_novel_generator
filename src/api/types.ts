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

// 章节信息：[id, 标题, 全局字节偏移]
export type ChapterEntry = [string, string, number];

export interface PartInfo {
  path: string;  // 如 /books/xxx/part_001.txt
  size: number;  // 字节大小
}

export interface ChaptersFile {
  book: {
    id: string;
    title: string;
    author: string;
    totalChapters: number;
    parts: PartInfo[];     // 所有 part 信息
    totalSize: number;     // 整本书总字节数
  };
  chapters: ChapterEntry[];  // 章节用于导航
}
