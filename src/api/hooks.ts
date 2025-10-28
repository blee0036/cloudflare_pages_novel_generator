import { useQuery } from "@tanstack/react-query";
import { apiFetch, ApiError } from "./client";
import type { BookSummary, BooksFile, ChaptersFile, ChapterEntry } from "./types";

export interface BooksData {
  generatedAt: string;
  books: BookSummary[];
}

export interface ChapterView {
  id: string;
  title: string;
  order: number;
  assetIndex: number;
  assetPath: string;
  startByte: number;
  length: number;
}

export interface BookDetailData {
  book: ChaptersFile["book"];
  chapters: ChapterView[];
}

export interface ChapterData {
  book: ChaptersFile["book"];
  chapters: ChapterView[];
  chapter: ChapterView;
  prevChapterId: string | null;
  nextChapterId: string | null;
}

export function useBooks() {
  return useQuery<BooksData, ApiError>({
    queryKey: ["books"],
    queryFn: async () => {
      const payload = await apiFetch<BooksFile>("/data/books.json");
      const books = payload.books.map(([id, title, author, totalChapters]) => ({
        id,
        title,
        author,
        totalChapters,
      }));
      return {
        generatedAt: payload.generatedAt,
        books,
      };
    },
    retry: 1,
  });
}

export function useBookDetail(bookId: string | undefined) {
  return useQuery<BookDetailData, ApiError>({
    queryKey: ["book", bookId],
    queryFn: async () => {
      const payload = await apiFetch<ChaptersFile>(`/data/${bookId}_chapters.json`);
      const chapters = payload.chapters.map(toChapterView(payload.book.assets));
      return {
        book: payload.book,
        chapters,
      };
    },
    enabled: Boolean(bookId),
    retry: 1,
  });
}

export function useChapter(chapterId: string | undefined) {
  return useQuery<ChapterData, ApiError>({
    queryKey: ["chapter", chapterId],
    enabled: Boolean(chapterId),
    retry: 1,
    queryFn: async () => {
      if (!chapterId) {
        throw new ApiError(400, "Missing chapter id");
      }
      const bookId = inferBookIdFromChapterId(chapterId);
      const data = await apiFetch<ChaptersFile>(`/data/${bookId}_chapters.json`);
      const chapters = data.chapters.map(toChapterView(data.book.assets));
      const index = chapters.findIndex((chapter) => chapter.id === chapterId);
      if (index === -1) {
        throw new ApiError(404, "Chapter not found");
      }
      const prev = chapters[index - 1]?.id ?? null;
      const next = chapters[index + 1]?.id ?? null;
      return {
        book: data.book,
        chapters,
        chapter: chapters[index],
        prevChapterId: prev,
        nextChapterId: next,
      };
    },
  });
}

function inferBookIdFromChapterId(chapterId: string): string {
  const lastDashIndex = chapterId.lastIndexOf("-");
  if (lastDashIndex === -1) {
    throw new ApiError(400, "Invalid chapter id");
  }
  return chapterId.slice(0, lastDashIndex);
}

export function useChapterContent(chapter: ChapterView | undefined) {
  return useQuery<string, ApiError>({
    queryKey: [
      "chapter-content",
      chapter?.id,
      chapter?.assetPath,
      chapter?.startByte,
      chapter?.length,
    ],
    enabled: Boolean(chapter),
    retry: 1,
    queryFn: async () => {
      if (!chapter) {
        throw new ApiError(400, "Missing chapter metadata");
      }
      const start = chapter.startByte;
      const end = chapter.startByte + chapter.length - 1;
      const response = await fetch(chapter.assetPath, {
        headers: {
          Range: `bytes=${start}-${end}`,
        },
      });
      if (!response.ok) {
        throw new ApiError(response.status, "章节内容加载失败");
      }
      let buffer = new Uint8Array(await response.arrayBuffer());
      if (response.status !== 206 && response.status !== 416) {
        buffer = buffer.slice(start, start + chapter.length);
      }
      const decoder = new TextDecoder("utf-8");
      const raw = decoder.decode(buffer);
      return stripLeadingTitle(chapter.title, raw);
    },
  });
}

function stripLeadingTitle(title: string, content: string): string {
  const withoutBom = content.replace(/^\uFEFF/, "");
  const [firstLine, ...rest] = withoutBom.split(/\r?\n/);
  if (firstLine?.trim() === title.trim()) {
    return rest.join("\n").trimStart();
  }
  return withoutBom;
}

function toChapterView(assets: string[]) {
  return (entry: ChapterEntry, index: number): ChapterView => {
    const [id, title, assetIndex, startByte, length] = entry;
    const assetPath = assets[assetIndex];
    if (!assetPath) {
      throw new ApiError(500, `Missing asset for chapter ${id}`);
    }
    return {
      id,
      title,
      order: index + 1,
      assetIndex,
      assetPath,
      startByte,
      length,
    };
  };
}
