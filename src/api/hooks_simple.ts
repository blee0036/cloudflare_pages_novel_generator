import { useQuery } from "@tanstack/react-query";
import { ApiError, apiFetch } from "./client";
import type { ChaptersFile, BooksFile, BooksFileRaw } from "./types";

// 获取所有书籍列表
export function useBooks() {
  return useQuery<BooksFile, ApiError>({
    queryKey: ["books"],
    queryFn: async () => {
      const raw = await apiFetch<BooksFileRaw>("/data/books.json");
      // 转换数组格式为对象数组
      const books = raw.books.map(row => ({
        id: row[0],
        title: row[1],
        author: row[2],
        totalChapters: row[3],
      }));
      return {
        ...raw,
        books,
      };
    },
    staleTime: Infinity,
  });
}

// 获取单本书信息（兼容旧的 _chapters.json 结构）
export function useBook(bookId: string | undefined) {
  return useQuery<ChaptersFile["book"], ApiError>({
    queryKey: ["book", bookId],
    enabled: Boolean(bookId),
    queryFn: async () => {
      const data = await apiFetch<ChaptersFile>(`/data/${bookId}_chapters.json`);
      return data.book;
    },
    staleTime: Infinity,
  });
}

// 加载指定字节范围的内容（可能跨多个 part）
export function useBookContent(bookId: string | undefined, startByte: number, length: number) {
  return useQuery<string, ApiError>({
    queryKey: ["book-content", bookId, startByte, length],
    enabled: Boolean(bookId) && startByte >= 0 && length > 0,
    retry: 1,
    staleTime: Infinity,
    queryFn: async () => {
      if (!bookId) {
        throw new ApiError(400, "Missing book id");
      }
      
      const data = await apiFetch<ChaptersFile>(`/data/${bookId}_chapters.json`);
      const { parts, totalSize } = data.book;
      
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
        
        if (remainingStart < partEnd && remainingLength > 0) {
          const offsetInPart = Math.max(0, remainingStart - currentByte);
          const bytesToRead = Math.min(remainingLength, part.size - offsetInPart);
          
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
      
      // 使用非严格模式的 TextDecoder，允许不完整的 UTF-8 字符
      // 如果末尾被截断，会显示 �，但下次加载会补全
      const decoder = new TextDecoder("utf-8", { fatal: false });
      const text = decoder.decode(merged);
      
      return text.replace(/^\uFEFF/, ""); // 移除 BOM
    },
  });
}
