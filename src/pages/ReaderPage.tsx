import { ChangeEvent, useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useChapter, useChapterContent } from "../api/hooks";
import { saveReadingProgress } from "../utils/readingProgress";
import { siteConfig } from "../config/siteConfig";
import { ReaderSettings as ReaderSettingsPanel } from "../components/ReaderSettings";
import { loadSettings, saveSettings, applySettings, type ReaderSettings } from "../utils/readerSettings";

const ReaderPage: React.FC = () => {
  const { chapterId } = useParams();
  const navigate = useNavigate();
  const { data, error, isLoading, isFetching } = useChapter(chapterId);
  const {
    data: content,
    error: contentError,
    isLoading: isContentLoading,
    isFetching: isContentFetching,
  } = useChapterContent(data?.chapter);
  
  const [settings, setSettings] = useState<ReaderSettings>(loadSettings);
  const [showSettings, setShowSettings] = useState(false);
  const contentRef = useRef<HTMLElement>(null);

  const goToChapter = useCallback(
    (targetId: string | null | undefined) => {
      if (!targetId) return;
      navigate(`/reader/${targetId}`);
    },
    [navigate],
  );

  const handleSelectChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      const target = event.target.value;
      if (target && target !== chapterId) {
        goToChapter(target);
      }
    },
    [chapterId, goToChapter],
  );

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [chapterId]);

  useEffect(() => {
    if (!data?.chapter) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        goToChapter(data.prevChapterId);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        goToChapter(data.nextChapterId);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [data?.chapter, data?.prevChapterId, data?.nextChapterId, goToChapter]);

  useEffect(() => {
    if (data?.chapter) {
      document.title = `${data.chapter.title} - ${data.book.title}`;
    }
    return () => {
      document.title = siteConfig.siteName;
    };
  }, [data?.chapter, data?.book]);

  useEffect(() => {
    if (!data?.book || !data.chapter) return;
    const { book, chapter } = data;
    saveReadingProgress({
      bookId: book.id,
      bookTitle: book.title,
      author: book.author,
      chapterId: chapter.id,
      chapterTitle: chapter.title,
      updatedAt: Date.now(),
    });
  }, [data]);

  useEffect(() => {
    if (contentRef.current) {
      applySettings(settings, contentRef.current);
    }
  }, [settings, content]);

  const handleSettingsChange = useCallback((newSettings: ReaderSettings) => {
    setSettings(newSettings);
    saveSettings(newSettings);
  }, []);

  if (error || contentError) {
    return (
      <section className="panel">
        <div className="error-state">章节加载失败：{error?.message ?? contentError?.message}</div>
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

  const { chapter } = data;
  const book = data.book;
  const prevChapterId = data.prevChapterId;
  const nextChapterId = data.nextChapterId;
  const chaptersList = data.chapters;
  const currentIndex = chaptersList.findIndex((item) => item.id === chapter.id);
  const displayIndex = currentIndex >= 0 ? currentIndex : 0;
  const totalChapters = chaptersList.length;

  const disabledPrev = !prevChapterId;
  const disabledNext = !nextChapterId;

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
              <select value={chapter.id} onChange={handleSelectChange} aria-label="选择章节">
                {chaptersList.map((item, index) => (
                  <option key={item.id} value={item.id}>
                    第 {index + 1} 章 · {item.title}
                  </option>
                ))}
              </select>
            </label>
            <div className="reader-nav">
              <button type="button" onClick={() => goToChapter(prevChapterId)} disabled={disabledPrev}>
                上一章
              </button>
              <button type="button" onClick={() => goToChapter(nextChapterId)} disabled={disabledNext}>
                下一章
              </button>
              <button
                type="button"
                onClick={() => setShowSettings(true)}
                className="reader-settings-toolbar-button"
                title="阅读设置"
              >
                ⚙️
              </button>
            </div>
          </div>
        </div>
        <div className="reader-heading">
          <h1>{chapter.title}</h1>
          <span>
            {book.title} · {book.author}
            {isFetching || isContentFetching ? " · 更新中" : ""}
          </span>
        </div>
      </div>
      <article className="chapter-content" aria-live="polite" ref={contentRef}>
        <div className="chapter-meta">第 {displayIndex + 1} 章 / 共 {totalChapters} 章</div>
        {isContentLoading ? <div className="chapter-loading">加载中...</div> : content ?? ""}
      </article>
      <div className="reader-bottom-nav">
        <button type="button" onClick={() => goToChapter(prevChapterId)} disabled={disabledPrev}>
          上一章
        </button>
        <button type="button" onClick={() => goToChapter(nextChapterId)} disabled={disabledNext}>
          下一章
        </button>
      </div>
      {showSettings && (
        <ReaderSettingsPanel
          settings={settings}
          onSettingsChange={handleSettingsChange}
          onClose={() => setShowSettings(false)}
        />
      )}
    </section>
  );
};

export default ReaderPage;
