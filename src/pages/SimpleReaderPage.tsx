import { useEffect, useRef, useState, useCallback } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { useBook, useBookContent } from "../api/hooks_simple";
import { siteConfig } from "../config/siteConfig";
import { saveReadingProgress, getBookProgress } from "../utils/readingProgress";

const CHUNK_SIZE = 50000; // 每次加载 50KB
const BUFFER_SIZE = 5000; // 滚动缓冲区

export const SimpleReaderPage: React.FC = () => {
  const { bookId } = useParams<{ bookId: string }>();
  const navigate = useNavigate();
  
  const { data: book, error, isLoading } = useBook(bookId);
  
  // 当前窗口的字节范围 [start, end)
  const [viewStart, setViewStart] = useState(0);
  const [viewEnd, setViewEnd] = useState(CHUNK_SIZE);
  const [isInitialized, setIsInitialized] = useState(false);
  
  const contentRef = useRef<HTMLDivElement>(null);
  
  // 从 localStorage 恢复阅读位置
  useEffect(() => {
    if (!book || isInitialized) return;
    
    const progress = getBookProgress(book.id);
    if (progress && progress.scrollPosition) {
      const savedByte = progress.scrollPosition;
      setViewStart(Math.max(0, savedByte - CHUNK_SIZE / 2));
      setViewEnd(savedByte + CHUNK_SIZE / 2);
    } else {
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
  
  // 保存阅读进度
  useEffect(() => {
    if (!book) return;
    
    const timer = setTimeout(() => {
      const percent = ((viewStart / book.totalSize) * 100).toFixed(1);
      saveReadingProgress({
        bookId: book.id,
        bookTitle: book.title,
        author: book.author,
        chapterId: book.id, // 无章节，用 bookId 作为路由参数
        chapterTitle: `已读 ${percent}%`,
        scrollPosition: viewStart,
        bookHash: String(book.totalSize),
        updatedAt: Date.now(),
      });
    }, 1000);
    
    return () => clearTimeout(timer);
  }, [book, viewStart]);
  
  // 滚动加载更多
  const handleScroll = useCallback(() => {
    if (!contentRef.current || !book || isContentLoading) return;
    
    const { scrollTop, scrollHeight, clientHeight } = contentRef.current;
    const scrollBottom = scrollHeight - scrollTop - clientHeight;
    
    // 距离底部小于 BUFFER_SIZE 时，向下扩展窗口
    if (scrollBottom < BUFFER_SIZE) {
      const newEnd = Math.min(viewEnd + CHUNK_SIZE, book.totalSize);
      if (newEnd > viewEnd) {
        setViewEnd(newEnd);
        // 如果窗口太大，缩小前面的部分
        if (newEnd - viewStart > CHUNK_SIZE * 3) {
          setViewStart(viewStart + CHUNK_SIZE);
        }
      }
    }
    
    // 距离顶部小于 BUFFER_SIZE 时，向上扩展窗口
    if (scrollTop < BUFFER_SIZE && viewStart > 0) {
      const newStart = Math.max(0, viewStart - CHUNK_SIZE);
      setViewStart(newStart);
      // 如果窗口太大，缩小后面的部分
      if (viewEnd - newStart > CHUNK_SIZE * 3) {
        setViewEnd(viewEnd - CHUNK_SIZE);
      }
    }
  }, [viewStart, viewEnd, book, isContentLoading]);
  
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
