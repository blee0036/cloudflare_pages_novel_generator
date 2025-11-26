import { useQuery } from "@tanstack/react-query";
import { apiFetch, ApiError } from "./client";
import type { BookSummary, BooksFile, ChaptersFile, ChapterEntry } from "./types";

// 浏览器内存缓存 part 内容，避免重复下载
const partCache = new Map<string, Promise<Uint8Array>>();

async function loadPart(path: string): Promise<Uint8Array> {
  const cached = partCache.get(path);
  if (cached) {
    return cached;
  }

  const promise = fetch(path).then(async (response) => {
    if (!response.ok) {
      throw new ApiError(response.status, `Failed to load ${path}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  });

  // 只有成功的请求才留在缓存里，失败时清理
  partCache.set(
    path,
    promise.catch((error) => {
      partCache.delete(path);
      throw error;
    }),
  );

  return promise;
}

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
      
      // 验证数据格式
      if (!payload.book || !Array.isArray(payload.chapters)) {
        throw new ApiError(500, "Invalid book data format");
      }
      
      // 过滤并验证章节数据
      const validChapters = payload.chapters.filter((entry) => {
        return entry && Array.isArray(entry) && entry.length === 3;
      });
      
      if (validChapters.length === 0 && payload.chapters.length > 0) {
        throw new ApiError(500, "No valid chapters found in book data");
      }
      
      const chapters = validChapters.map(toChapterView);
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
      
      // 验证数据格式
      if (!data.book || !Array.isArray(data.chapters)) {
        throw new ApiError(500, "Invalid book data format");
      }
      
      // 过滤并验证章节数据
      const validChapters = data.chapters.filter((entry) => {
        return entry && Array.isArray(entry) && entry.length === 3;
      });
      
      if (validChapters.length === 0) {
        throw new ApiError(500, "No valid chapters found in book data");
      }
      
      const chapters = validChapters.map(toChapterView);
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
          
          // 读取整个 part（支持 gzip 缓存），在浏览器内存中切片
          const buffer = await loadPart(part.path);
          chunks.push(buffer.subarray(offsetInPart, offsetInPart + bytesToRead));
          
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
  // 添加额外的类型检查
  if (!entry || !Array.isArray(entry) || entry.length < 3) {
    throw new ApiError(500, "Invalid chapter entry format");
  }
  
  const [id, title, byteOffset] = entry;
  
  if (typeof id !== "string" || typeof title !== "string" || typeof byteOffset !== "number") {
    throw new ApiError(500, "Invalid chapter entry data types");
  }
  
  return {
    id,
    title,
    order: index + 1,
    byteOffset,
  };
}
