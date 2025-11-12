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
  byteOffset: number;  // 全局字节偏移
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
      const chapters = payload.chapters.map(toChapterView);
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
      const chapters = data.chapters.map(toChapterView);
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

// 加载指定字节范围的内容（可能跨多个 part）
export function useBookContent(bookId: string | undefined, startByte: number, length: number) {
  return useQuery<string, ApiError>({
    queryKey: ["book-content", bookId, startByte, length],
    enabled: Boolean(bookId) && startByte >= 0 && length > 0,
    retry: 1,
    staleTime: Infinity, // 内容不会变化，永久缓存
    queryFn: async () => {
      if (!bookId) {
        throw new ApiError(400, "Missing book id");
      }
      
      const metadata = await apiFetch<ChaptersFile>(`/data/${bookId}_chapters.json`);
      const { parts, totalSize } = metadata.book;
      
      // 限制读取范围
      const endByte = Math.min(startByte + length, totalSize);
      const actualLength = endByte - startByte;
      
      if (actualLength <= 0) {
        return "";
      }
      
      // 找到起始字节所在的 part
      const chunks: Uint8Array[] = [];
      let currentByte = 0;
      let remainingStart = startByte;
      let remainingLength = actualLength;
      
      for (const part of parts) {
        const partEnd = currentByte + part.size;
        
        // 判断这个 part 是否包含我们需要的数据
        if (remainingStart < partEnd && remainingLength > 0) {
          // 计算在这个 part 中的偏移和长度
          const offsetInPart = Math.max(0, remainingStart - currentByte);
          const bytesToRead = Math.min(remainingLength, part.size - offsetInPart);
          
          // 读取这个 part 的数据
          const rangeStart = offsetInPart;
          const rangeEnd = offsetInPart + bytesToRead - 1;
          
          const response = await fetch(part.path, {
            headers: {
              Range: `bytes=${rangeStart}-${rangeEnd}`,
            },
          });
          
          if (!response.ok) {
            throw new ApiError(response.status, `Failed to load ${part.path}`);
          }
          
          let buffer = new Uint8Array(await response.arrayBuffer());
          // 如果服务器不支持 Range，手动切片
          if (response.status !== 206 && response.status !== 416) {
            buffer = buffer.slice(rangeStart, rangeStart + bytesToRead);
          }
          
          chunks.push(buffer);
          
          remainingStart = partEnd;
          remainingLength -= bytesToRead;
        }
        
        currentByte = partEnd;
        
        if (remainingLength <= 0) {
          break;
        }
      }
      
      // 合并所有 chunks
      const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const merged = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
      }
      
      const decoder = new TextDecoder("utf-8");
      const text = decoder.decode(merged);
      return text.replace(/^\uFEFF/, ""); // 移除 BOM
    },
  });
}

function toChapterView(entry: ChapterEntry, index: number): ChapterView {
  const [id, title, byteOffset] = entry;
  return {
    id,
    title,
    order: index + 1,
    byteOffset,
  };
}
