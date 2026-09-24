import { getCachedBookText, saveCachedBookText } from "./indexedDB";

// In-memory cache for loaded books
const memoryBookCache = new Map<string, string>();

/**
 * 加载并流式解压 gzip 压缩的小说文本文件
 * 具备双重缓存机制：
 * 1. 内存一级缓存 (0ms 切换)
 * 2. 浏览器持久化 IndexedDB 二级缓存 (离线无网秒开，永不重复下载)
 */
export async function loadGzipBookText(
  url: string,
  bookId: string,
  onProgress?: (loaded: number, total: number) => void
): Promise<string> {
  // 1. 检查内存缓存
  if (memoryBookCache.has(bookId)) {
    return memoryBookCache.get(bookId)!;
  }

  // 2. 检查持久化 IndexedDB 离线缓存
  const indexedDBCached = await getCachedBookText(bookId);
  if (indexedDBCached) {
    memoryBookCache.set(bookId, indexedDBCached);
    return indexedDBCached;
  }

  // 3. 网络请求与流式解压
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`无法获取书籍文件: HTTP ${response.status} ${response.statusText}`);
  }

  if (!response.body) {
    throw new Error("浏览器响应体不可读取");
  }

  const contentLength = response.headers.get("content-length");
  const totalBytes = contentLength ? parseInt(contentLength, 10) : 0;
  const contentEncoding = (response.headers.get("content-encoding") || "").toLowerCase();

  let finalText = "";

  // 如果服务器已经返回 Content-Encoding: gzip，浏览器 HTTP 层已自动透明解压
  if (contentEncoding.includes("gzip")) {
    finalText = await response.text();
  } else {
    // 否则，响应体为原始 gzip 二进制流，使用前端原生 DecompressionStream 极速解压
    let loadedBytes = 0;
    const progressStream = new TransformStream({
      transform(chunk, controller) {
        loadedBytes += chunk.length;
        if (onProgress && totalBytes > 0) {
          onProgress(loadedBytes, totalBytes);
        }
        controller.enqueue(chunk);
      },
    });

    try {
      const decompressedStream = response.body
        .pipeThrough(progressStream)
        .pipeThrough(new DecompressionStream("gzip"));

      const decompressedResponse = new Response(decompressedStream);
      finalText = await decompressedResponse.text();
    } catch (err) {
      // 降级兜底
      const fallbackResponse = await fetch(url);
      finalText = await fallbackResponse.text();
    }
  }

  // 写入双重缓存
  memoryBookCache.set(bookId, finalText);
  saveCachedBookText(bookId, finalText); // 异步写入 IndexedDB 持久化

  return finalText;
}
