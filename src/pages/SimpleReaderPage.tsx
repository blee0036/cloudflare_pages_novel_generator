import { useEffect, useRef, useState, useCallback } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { useBook, useBookContent } from "../api/hooks_simple";
import { siteConfig } from "../config/siteConfig";
import { saveReadingProgress, getBookProgress } from "../utils/readingProgress";

const CHUNK_SIZE = 100000; // 每次加载 100KB（约50页）
const MAX_CHUNKS = 3;       // 最多保留3块内容
const SAVE_INTERVAL = 100;  // 滚动100像素就保存一次（约5行）

export const SimpleReaderPage: React.FC = () => {
  const { bookId } = useParams<{ bookId: string }>();
  const navigate = useNavigate();
  
  const { data: book, error, isLoading } = useBook(bookId);
  
  // 当前窗口的字节范围 [start, end)
  const [viewStart, setViewStart] = useState(0);
  const [viewEnd, setViewEnd] = useState(CHUNK_SIZE);
  const [isInitialized, setIsInitialized] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  
  const contentRef = useRef<HTMLDivElement>(null);
  const lastScrollTop = useRef(0);
  
  // 从 localStorage 恢复阅读位置
  useEffect(() => {
    if (!book || isInitialized) return;
    
    const progress = getBookProgress(book.id);
    if (progress && progress.scrollPosition) {
      const savedByte = progress.scrollPosition;
      // 居中加载：前后各一块，总共2块
      // 例如：102KB → 加载 0-200KB，视口在 102KB
      const idealStart = Math.max(0, savedByte - CHUNK_SIZE);
      const idealEnd = Math.min(savedByte + CHUNK_SIZE, book.totalSize);
      
      setViewStart(idealStart);
      setViewEnd(idealEnd);
      
      // 等内容加载后，滚动到保存的位置
      // 这里不直接设置scrollTop，因为内容还没渲染
      // 会在下面的 effect 中处理
    } else {
      // 新书，从头开始
      setViewStart(0);
      setViewEnd(CHUNK_SIZE);
    }
    setIsInitialized(true);
  }, [book, isInitialized]);
  
  // 加载当前窗口的内容
  const { data: contentData, isLoading: isContentLoading } = useBookContent(
    book?.id,
    viewStart,
    viewEnd - viewStart
  );
  
  // 内容加载完成后，恢复到保存的字节位置
  useEffect(() => {
    if (!book || !contentData || !isInitialized || !contentRef.current) return;
    
    const progress = getBookProgress(book.id);
    if (progress && progress.scrollPosition && progress.scrollPosition >= viewStart) {
      // 计算相对位置：保存的字节在当前内容中的偏移百分比
      const relativeBytes = progress.scrollPosition - viewStart;
      const totalBytes = viewEnd - viewStart;
      const relativePercent = relativeBytes / totalBytes;
      
      // 根据百分比设置滚动位置
      const targetScrollTop = contentRef.current.scrollHeight * relativePercent;
      contentRef.current.scrollTop = targetScrollTop;
      
      // 只恢复一次
      // 清除标记，避免后续滚动时重复定位
      // 这里不清除progress，只是不再自动定位
    }
  }, [contentData, book, isInitialized, viewStart, viewEnd]);
  
  // 保存阅读进度（高频保存）
  const lastSavePosition = useRef(0);
  
  useEffect(() => {
    if (!book || !contentRef.current || !contentData) return;
    
    const handleScrollSave = () => {
      const scrollTop = contentRef.current?.scrollTop || 0;
      
      // 每滚动 SAVE_INTERVAL 像素就保存一次
      if (Math.abs(scrollTop - lastSavePosition.current) > SAVE_INTERVAL) {
        lastSavePosition.current = scrollTop;
        
        // 计算当前的字节位置（根据滚动百分比）
        const scrollHeight = contentRef.current?.scrollHeight || 1;
        const scrollPercent = scrollTop / scrollHeight;
        const currentByte = Math.floor(viewStart + (viewEnd - viewStart) * scrollPercent);
        
        // 获取当前可见的第一行文本作为预览
        const firstVisibleLine = contentData.split('\n').find(line => line.trim());
        const preview = firstVisibleLine ? firstVisibleLine.trim().substring(0, 20) : '';
        
        const percent = ((currentByte / book.totalSize) * 100).toFixed(1);
        
        saveReadingProgress({
          bookId: book.id,
          bookTitle: book.title,
          author: book.author,
          chapterId: book.id,
          chapterTitle: preview ? `${percent}% · ${preview}...` : `已读 ${percent}%`,
          scrollPosition: currentByte,
          bookHash: String(book.totalSize),
          updatedAt: Date.now(),
        });
      }
    };
    
    const el = contentRef.current;
    el.addEventListener('scroll', handleScrollSave);
    return () => el.removeEventListener('scroll', handleScrollSave);
  }, [book, viewStart, viewEnd, contentData]);
  
  // 滚动加载更多
  const handleScroll = useCallback(() => {
    if (!contentRef.current || !book) return;
    
    const { scrollTop, scrollHeight, clientHeight } = contentRef.current;
    const scrollBottom = scrollHeight - scrollTop - clientHeight;
    
    // 判断滚动方向（大幅度拖动也能检测）
    const scrollDelta = scrollTop - lastScrollTop.current;
    const scrollDirection = scrollDelta > 0 ? 'down' : scrollDelta < 0 ? 'up' : 'none';
    lastScrollTop.current = scrollTop;
    
    // 向下滚动：距离底部不到 2 屏时，加载下一块
    // 或者直接检测：scrollBottom < 2 屏，无论方向
    if (scrollBottom < clientHeight * 2 && viewEnd < book.totalSize && !isLoadingMore) {
      console.log('[滚动加载] 向下', {
        scrollBottom,
        threshold: clientHeight * 2,
        viewEnd,
        totalSize: book.totalSize
      });
      
      const newEnd = Math.min(viewEnd + CHUNK_SIZE, book.totalSize);
      if (newEnd > viewEnd) {
        setIsLoadingMore(true);
        setViewEnd(newEnd);
        
        // 如果超过 MAX_CHUNKS 块，移除最前面的块
        const currentChunks = Math.ceil((viewEnd - viewStart) / CHUNK_SIZE);
        if (currentChunks >= MAX_CHUNKS) {
          setViewStart(viewStart + CHUNK_SIZE);
        }
        
        setTimeout(() => setIsLoadingMore(false), 300);
      }
    }
    
    // 向上滚动：距离顶部不到 1 屏时，向前扩展
    if (scrollTop < clientHeight && viewStart > 0 && !isLoadingMore) {
      console.log('[滚动加载] 向上', {
        scrollTop,
        threshold: clientHeight,
        viewStart
      });
      
      const newStart = Math.max(0, viewStart - CHUNK_SIZE);
      setIsLoadingMore(true);
      
      // 保存当前滚动位置（相对于文档顶部）
      const oldScrollTop = scrollTop;
      
      setViewStart(newStart);
      
      // 如果超过 MAX_CHUNKS 块，移除最后面的块
      const currentChunks = Math.ceil((viewEnd - viewStart) / CHUNK_SIZE);
      if (currentChunks >= MAX_CHUNKS) {
        setViewEnd(viewEnd - CHUNK_SIZE);
      }
      
      // 内容加载后，恢复滚动位置
      requestAnimationFrame(() => {
        if (contentRef.current) {
          // 新内容增加的高度 = 加载的字节数对应的渲染高度
          // 简单方案：等内容渲染完，保持用户看到的内容不变
          const newScrollHeight = contentRef.current.scrollHeight;
          const addedHeight = newScrollHeight - scrollHeight;
          contentRef.current.scrollTop = oldScrollTop + addedHeight;
        }
        setIsLoadingMore(false);
      });
    }
  }, [viewStart, viewEnd, book, isLoadingMore]);
  
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    
    el.addEventListener("scroll", handleScroll);
    return () => el.removeEventListener("scroll", handleScroll);
  }, [handleScroll]);
  
  // 更新页面标题
  useEffect(() => {
    if (book) {
      document.title = `${book.title} - ${siteConfig.siteName}`;
    }
    return () => {
      document.title = siteConfig.siteName;
    };
  }, [book]);
  
  if (error) {
    return (
      <section className="panel">
        <div className="error-state">书籍加载失败：{error.message}</div>
      </section>
    );
  }
  
  if (isLoading || !book) {
    return (
      <section className="panel reader-shell">
        <div className="reader-toolbar">
          <div className="skeleton" style={{ width: 260, height: 24, borderRadius: 10 }} />
        </div>
        <div className="chapter-content skeleton" style={{ height: 420 }} />
      </section>
    );
  }
  
  return (
    <section className="panel reader-shell">
      <div className="reader-header">
        <div className="reader-toolbar">
          <div className="reader-breadcrumb">
            <Link to={`/books/${book.id}`} className="reader-back">
              ← 返回详情
            </Link>
            <span>{book.title}</span>
          </div>
          <div className="reader-controls">
            <span>文件大小: {(book.totalSize / 1024 / 1024).toFixed(1)} MB</span>
          </div>
        </div>
        <div className="reader-heading">
          <h1>{book.title}</h1>
          <span>
            {book.author}
            {isContentLoading ? " · 加载中" : ""}
          </span>
        </div>
      </div>
      
      <article className="chapter-content" aria-live="polite" ref={contentRef}>
        {isContentLoading && !contentData ? (
          <div className="chapter-loading">加载中...</div>
        ) : (
          <div style={{ whiteSpace: "pre-wrap" }}>{contentData ?? ""}</div>
        )}
        {isContentLoading && contentData && (
          <div className="chapter-loading">加载更多...</div>
        )}
      </article>
    </section>
  );
};
