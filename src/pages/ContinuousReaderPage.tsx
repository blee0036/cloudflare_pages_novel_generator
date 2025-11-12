import { useEffect, useRef, useState, useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Link } from "react-router-dom";
import { useChapter, useBookContent } from "../api/hooks";
import { siteConfig } from "../config/siteConfig";
import { saveReadingProgress, getBookProgress } from "../utils/readingProgress";

const CHUNK_SIZE = 50000; // 每次加载 50000 字节
const BUFFER_SIZE = 5000; // 滚动缓冲区（触发加载的阈值）

export const ContinuousReaderPage: React.FC = () => {
  const { chapterId } = useParams<{ chapterId: string }>();
  const navigate = useNavigate();
  
  const { data, error, isLoading } = useChapter(chapterId);
  
  // 当前窗口的字节范围 [start, end)
  const [viewStart, setViewStart] = useState(0);
  const [viewEnd, setViewEnd] = useState(CHUNK_SIZE);
  const [isInitialized, setIsInitialized] = useState(false);
  
  const contentRef = useRef<HTMLDivElement>(null);
  
  // 从 localStorage 恢复阅读位置
  useEffect(() => {
    if (!data || isInitialized) return;
    
    const progress = getBookProgress(data.book.id);
    if (progress && progress.chapterId === chapterId && progress.scrollPosition) {
      // 恢复到上次的字节位置
      const savedByte = data.chapter.byteOffset + progress.scrollPosition;
      setViewStart(Math.max(0, savedByte - CHUNK_SIZE / 2));
      setViewEnd(savedByte + CHUNK_SIZE / 2);
    } else {
      // 新章节，从章节开头开始
      setViewStart(data.chapter.byteOffset);
      setViewEnd(data.chapter.byteOffset + CHUNK_SIZE);
    }
    setIsInitialized(true);
  }, [data, chapterId, isInitialized]);
  
  // 加载当前窗口的内容
  const { data: contentData, isLoading: isContentLoading } = useBookContent(
    data?.book.id,
    viewStart,
    viewEnd - viewStart
  );
  
  // 保存阅读进度
  useEffect(() => {
    if (!data || viewStart === 0) return;
    
    const relativePosition = viewStart - data.chapter.byteOffset;
    
    const timer = setTimeout(() => {
      saveReadingProgress({
        bookId: data.book.id,
        bookTitle: data.book.title,
        author: data.book.author,
        chapterId: data.chapter.id,
        chapterTitle: data.chapter.title,
        scrollPosition: relativePosition,
        bookHash: String(data.book.totalChapters),
        updatedAt: Date.now(),
      });
    }, 1000); // 防抖 1 秒
    
    return () => clearTimeout(timer);
  }, [data, viewStart]);
  
  // 滚动加载更多
  const handleScroll = useCallback(() => {
    if (!contentRef.current || !data || isContentLoading) return;
    
    const { scrollTop, scrollHeight, clientHeight } = contentRef.current;
    const scrollBottom = scrollHeight - scrollTop - clientHeight;
    
    // 距离底部小于 BUFFER_SIZE 时，向下扩展窗口
    if (scrollBottom < BUFFER_SIZE) {
      const newEnd = Math.min(viewEnd + CHUNK_SIZE, data.book.totalSize);
      if (newEnd > viewEnd) {
        setViewEnd(newEnd);
        // 如果窗口太大，缩小前面的部分
        if (newEnd - viewStart > CHUNK_SIZE * 3) {
          setViewStart(viewStart + CHUNK_SIZE);
        }
      }
    }
    
    // 距离顶部小于 BUFFER_SIZE 时，向上扩展窗口（上拉加载）
    if (scrollTop < BUFFER_SIZE && viewStart > 0) {
      const newStart = Math.max(0, viewStart - CHUNK_SIZE);
      setViewStart(newStart);
      // 如果窗口太大，缩小后面的部分
      if (viewEnd - newStart > CHUNK_SIZE * 3) {
        setViewEnd(viewEnd - CHUNK_SIZE);
      }
    }
  }, [viewStart, viewEnd, data, isContentLoading]);
  
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    
    el.addEventListener("scroll", handleScroll);
    return () => el.removeEventListener("scroll", handleScroll);
  }, [handleScroll]);
  
  // 更新页面标题
  useEffect(() => {
    if (data) {
      document.title = `${data.chapter.title} - ${data.book.title}`;
    }
    return () => {
      document.title = siteConfig.siteName;
    };
  }, [data]);
  
  // 跳转到指定章节
  const goToChapter = useCallback((targetChapterId: string | null) => {
    if (targetChapterId) {
      navigate(`/reader/${targetChapterId}`);
      setIsInitialized(false);
    }
  }, [navigate]);
  
  if (error) {
    return (
      <section className="panel">
        <div className="error-state">章节加载失败：{error.message}</div>
      </section>
    );
  }
  
  if (isLoading || !data) {
    return (
      <section className="panel reader-shell">
        <div className="reader-toolbar">
          <div className="skeleton" style={{ width: 260, height: 24, borderRadius: 10 }} />
          <div className="reader-nav">
            <div className="skeleton" style={{ width: 120, height: 40, borderRadius: 12 }} />
            <div className="skeleton" style={{ width: 120, height: 40, borderRadius: 12 }} />
          </div>
        </div>
        <div className="chapter-content skeleton" style={{ height: 420 }} />
      </section>
    );
  }
  
  const { book, chapter, prevChapterId, nextChapterId, chapters } = data;
  const displayIndex = chapters.findIndex((ch) => ch.id === chapter.id);
  
  return (
    <section className="panel reader-shell">
      <div className="reader-header">
        <div className="reader-toolbar">
          <div className="reader-breadcrumb">
            <Link to={`/books/${book.id}`} className="reader-back">
              ← 返回目录
            </Link>
            <span>{book.title}</span>
          </div>
          <div className="reader-controls">
            <label className="chapter-select">
              <span>章节</span>
              <select
                value={chapter.id}
                onChange={(e) => goToChapter(e.target.value)}
                aria-label="选择章节"
              >
                {chapters.map((item, index) => (
                  <option key={item.id} value={item.id}>
                    第 {index + 1} 章 · {item.title}
                  </option>
                ))}
              </select>
            </label>
            <div className="reader-nav">
              <button type="button" onClick={() => goToChapter(prevChapterId)} disabled={!prevChapterId}>
                上一章
              </button>
              <button type="button" onClick={() => goToChapter(nextChapterId)} disabled={!nextChapterId}>
                下一章
              </button>
            </div>
          </div>
        </div>
        <div className="reader-heading">
          <h1>{chapter.title}</h1>
          <span>
            {book.title} · {book.author}
            {isContentLoading ? " · 加载中" : ""}
          </span>
        </div>
      </div>
      
      <article className="chapter-content" aria-live="polite" ref={contentRef}>
        <div className="chapter-meta">第 {displayIndex + 1} 章 / 共 {chapters.length} 章</div>
        {isContentLoading && !contentData ? (
          <div className="chapter-loading">加载中...</div>
        ) : (
          <div style={{ whiteSpace: "pre-wrap" }}>{contentData ?? ""}</div>
        )}
        {isContentLoading && contentData && (
          <div className="chapter-loading">加载更多...</div>
        )}
      </article>
      
      <div className="reader-bottom-nav">
        <button type="button" onClick={() => goToChapter(prevChapterId)} disabled={!prevChapterId}>
          上一章
        </button>
        <button type="button" onClick={() => goToChapter(nextChapterId)} disabled={!nextChapterId}>
          下一章
        </button>
      </div>
    </section>
  );
};
