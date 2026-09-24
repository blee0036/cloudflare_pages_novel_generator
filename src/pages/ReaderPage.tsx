import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import {
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  AlertCircle,
  Menu,
  Sliders,
  ArrowUp,
  List,
  Search,
} from "lucide-react";
import { BookToc, ChapterMeta } from "../types";
import {
  getStoredSettings,
  saveStoredSettings,
  getBookProgress,
  saveBookProgress,
  THEME_CONFIGS,
  isChapterBookmarked,
  addBookmark,
  removeBookmark,
  getBookmarks,
} from "../utils/storage";
import { loadGzipBookText } from "../utils/decompress";
import { Header } from "../components/Header";
import { NavigationDrawer } from "../components/NavigationDrawer";
import { SettingDrawer } from "../components/SettingDrawer";
import { SearchDrawer } from "../components/SearchDrawer";

export const ReaderPage: React.FC = () => {
  const { bookId } = useParams<{ bookId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  // Settings & Theme
  const [settings, setSettings] = useState(getStoredSettings());
  const theme = THEME_CONFIGS[settings.theme];

  // Book Data State
  const [toc, setToc] = useState<BookToc | null>(null);
  const [fullText, setFullText] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [downloadProgress, setDownloadProgress] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);

  // Active Chapter & Page State
  const [currentChapterIndex, setCurrentChapterIndex] = useState<number>(0);
  const [currentPageInChapter, setCurrentPageInChapter] = useState<number>(0);
  const [isBookmarked, setIsBookmarked] = useState<boolean>(false);

  // UI Panels
  const [showControls, setShowControls] = useState(true);
  const [isTocOpen, setIsTocOpen] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isSettingOpen, setIsSettingOpen] = useState(false);
  const controlsTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const contentContainerRef = useRef<HTMLDivElement>(null);

  // 1. Load Book TOC and Decompress Book File
  useEffect(() => {
    if (!bookId) return;
    let isCancelled = false;

    const loadBook = async () => {
      setLoading(true);
      setError(null);
      setDownloadProgress(0);

      try {
        // 1. Fetch TOC metadata
        const tocRes = await fetch(`/data/${encodeURIComponent(bookId)}_toc.json`);
        if (!tocRes.ok) {
          throw new Error(`无法获取章节索引 (HTTP ${tocRes.status})`);
        }
        const tocData: BookToc = await tocRes.json();
        if (isCancelled) return;
        setToc(tocData);

        // 2. Fetch & decompress Gzip novel text
        const txtUrl = `/books/${encodeURIComponent(bookId)}.txt.gz`;
        const text = await loadGzipBookText(txtUrl, bookId, (loaded, total) => {
          if (!isCancelled && total > 0) {
            setDownloadProgress(Math.round((loaded / total) * 100));
          }
        });
        if (isCancelled) return;
        setFullText(text);

        // 3. Restore last reading progress (URL ?ch= param takes precedence)
        const urlCh = searchParams.get("ch");
        if (urlCh !== null && !isNaN(parseInt(urlCh, 10))) {
          const chNum = parseInt(urlCh, 10);
          if (chNum >= 0 && chNum < tocData.chapters.length) {
            setCurrentChapterIndex(chNum);
            return;
          }
        }

        const savedProgress = getBookProgress(bookId);
        if (
          savedProgress &&
          savedProgress.chapterId >= 0 &&
          savedProgress.chapterId < tocData.chapters.length
        ) {
          setCurrentChapterIndex(savedProgress.chapterId);
        } else {
          setCurrentChapterIndex(0);
        }
      } catch (err: any) {
        if (!isCancelled) {
          setError(err.message || "加载书籍内容失败");
        }
      } finally {
        if (!isCancelled) {
          setLoading(false);
        }
      }
    };

    loadBook();

    return () => {
      isCancelled = true;
    };
  }, [bookId]);

  // Current Chapter Object
  const currentChapter: ChapterMeta | undefined = toc?.chapters[currentChapterIndex];

  // Extract current chapter text cleanly using character offsets
  const chapterText = useMemo(() => {
    if (!fullText || !currentChapter) return "";
    return fullText.slice(currentChapter.start, currentChapter.end).trim();
  }, [fullText, currentChapter]);

  // Clean paragraphs
  const paragraphs = useMemo(() => {
    if (!chapterText) return [];
    return chapterText
      .split("\n")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
  }, [chapterText]);

  // Total reading progress percentage
  const overallProgressPercent = useMemo(() => {
    if (!toc || !toc.chapters.length) return 0;
    return ((currentChapterIndex + 1) / toc.chapters.length) * 100;
  }, [currentChapterIndex, toc]);

  // Save progress whenever chapter changes
  useEffect(() => {
    if (!bookId || !currentChapter || !toc) return;
    saveBookProgress({
      bookId,
      chapterId: currentChapter.id,
      chapterTitle: currentChapter.title,
      progressPercent: overallProgressPercent,
      lastReadTime: Date.now(),
    });
  }, [bookId, currentChapter, overallProgressPercent, toc]);

  // Sync bookmark state with current chapter
  useEffect(() => {
    if (bookId && currentChapter) {
      setIsBookmarked(isChapterBookmarked(bookId, currentChapter.id));
    }
  }, [bookId, currentChapter]);

  const handleToggleBookmark = () => {
    if (!bookId || !currentChapter) return;
    if (isBookmarked) {
      const bms = getBookmarks(bookId);
      const target = bms.find((b) => b.chapterId === currentChapter.id);
      if (target) {
        removeBookmark(bookId, target.id);
      }
      setIsBookmarked(false);
    } else {
      addBookmark({
        id: `${bookId}_${currentChapter.id}_${Date.now()}`,
        bookId,
        chapterId: currentChapter.id,
        chapterTitle: currentChapter.title,
        previewText: paragraphs[0] ? paragraphs[0].slice(0, 100) : "",
        createdAt: Date.now(),
      });
      setIsBookmarked(true);
    }
  };

  // Auto-hide controls timer
  const triggerShowControls = useCallback(() => {
    setShowControls(true);
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current);
    }
    controlsTimeoutRef.current = setTimeout(() => {
      setShowControls(false);
    }, 4500);
  }, []);

  // Jump to chapter
  const goToChapter = useCallback(
    (index: number) => {
      if (!toc) return;
      const targetIndex = Math.max(0, Math.min(index, toc.chapters.length - 1));
      setCurrentChapterIndex(targetIndex);
      setCurrentPageInChapter(0);
      if (contentContainerRef.current) {
        contentContainerRef.current.scrollTop = 0;
      }
      triggerShowControls();
    },
    [toc, triggerShowControls]
  );

  // Keyboard Navigation (Inspired by Koodo Reader)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if user is in an input field
      if (["INPUT", "TEXTAREA"].includes((e.target as HTMLElement).tagName)) {
        return;
      }

      if (e.key === "ArrowLeft") {
        goToChapter(currentChapterIndex - 1);
      } else if (e.key === "ArrowRight") {
        goToChapter(currentChapterIndex + 1);
      } else if (e.key === "t" || e.key === "T") {
        setIsTocOpen((prev) => !prev);
      } else if (e.key === "f" || e.key === "F") {
        setIsSearchOpen((prev) => !prev);
      } else if (e.key === "s" || e.key === "S") {
        setIsSettingOpen((prev) => !prev);
      } else if (e.key === "Escape") {
        setIsTocOpen(false);
        setIsSearchOpen(false);
        setIsSettingOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [currentChapterIndex, goToChapter]);

  // Handle settings update
  const handleUpdateSettings = (newSettings: Partial<typeof settings>) => {
    const updated = { ...settings, ...newSettings };
    setSettings(updated);
    saveStoredSettings(updated);
  };

  // Font family class
  const getFontFamilyStyle = () => {
    switch (settings.fontFamily) {
      case "serif":
        return "'Source Han Serif SC', 'Noto Serif SC', 'Songti SC', 'SimSun', serif";
      case "kaiti":
        return "'KaiTi', 'STKaiti', '楷体', serif";
      case "system":
      default:
        return "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei', sans-serif";
    }
  };

  if (loading) {
    return (
      <div
        className="min-h-screen flex flex-col items-center justify-center p-4 transition-colors"
        style={{ backgroundColor: theme.bg, color: theme.text }}
      >
        <div className="w-16 h-16 rounded-2xl bg-blue-500/10 flex items-center justify-center mb-4">
          <RefreshCw className="w-8 h-8 animate-spin text-blue-500" />
        </div>
        <h2 className="text-base font-semibold mb-1">正在流式解压书籍...</h2>
        <p className="text-xs opacity-60 mb-4">
          原生 Gzip 解压加速中 {downloadProgress > 0 ? `(${downloadProgress}%)` : ""}
        </p>
        <div className="w-48 bg-black/10 dark:bg-white/10 h-1.5 rounded-full overflow-hidden">
          <div
            className="bg-blue-500 h-full rounded-full transition-all duration-200"
            style={{ width: `${Math.max(5, downloadProgress)}%` }}
          />
        </div>
      </div>
    );
  }

  if (error || !toc) {
    return (
      <div
        className="min-h-screen flex flex-col items-center justify-center p-4"
        style={{ backgroundColor: theme.bg, color: theme.text }}
      >
        <AlertCircle className="w-12 h-12 text-rose-500 mb-3" />
        <h2 className="text-lg font-bold mb-1">未能打开书籍</h2>
        <p className="text-xs opacity-70 mb-6 max-w-sm text-center">{error}</p>
        <button
          onClick={() => navigate("/")}
          className="px-5 py-2.5 bg-blue-600 text-white rounded-xl text-xs font-semibold hover:bg-blue-700 shadow-md"
        >
          返回书架
        </button>
      </div>
    );
  }

  return (
    <div
      className="min-h-screen flex flex-col relative select-text transition-colors duration-200"
      style={{
        backgroundColor: theme.bg,
        color: theme.text,
      }}
      onClick={triggerShowControls}
    >
      {/* 1. Floating Top Header */}
      <Header
        title={toc.title}
        chapterTitle={currentChapter?.title}
        progressPercent={overallProgressPercent}
        theme={theme}
        show={showControls}
        isBookmarked={isBookmarked}
        onBack={() => navigate("/")}
        onToggleToc={() => setIsTocOpen((prev) => !prev)}
        onToggleSearch={() => setIsSearchOpen((prev) => !prev)}
        onToggleBookmark={handleToggleBookmark}
        onToggleSettings={() => setIsSettingOpen((prev) => !prev)}
      />

      {/* 2. Reader Body */}
      <main
        ref={contentContainerRef}
        className="flex-1 overflow-y-auto pt-16 pb-28 px-4 sm:px-8"
      >
        <article
          className="mx-auto transition-all duration-150"
          style={{
            maxWidth: `${settings.contentWidth}px`,
            fontFamily: getFontFamilyStyle(),
            fontSize: `${settings.fontSize}px`,
            lineHeight: settings.lineHeight,
            letterSpacing: `${settings.letterSpacing}px`,
          }}
        >
          {/* Chapter Title */}
          <header className="mb-10 pt-4 pb-6 border-b border-black/5 dark:border-white/5">
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight mb-2">
              {currentChapter?.title}
            </h1>
            <div className="flex items-center text-xs opacity-50 space-x-3">
              <span>
                第 {currentChapterIndex + 1} / {toc.totalChapters} 章
              </span>
              <span>·</span>
              <span>{currentChapter?.length} 字</span>
            </div>
          </header>

          {/* Chapter Text Paragraphs */}
          <div className="space-y-6 text-justify">
            {paragraphs.map((para, i) => (
              <p
                key={i}
                className="indent-[2em] leading-relaxed transition-colors select-text"
              >
                {para}
              </p>
            ))}
          </div>

          {/* End of Chapter Navigation Card */}
          <div
            className="mt-16 pt-8 border-t flex flex-col sm:flex-row items-center justify-between gap-4"
            style={{ borderColor: theme.border }}
          >
            <button
              onClick={() => goToChapter(currentChapterIndex - 1)}
              disabled={currentChapterIndex <= 0}
              className={`w-full sm:w-auto px-5 py-2.5 rounded-xl border text-xs font-semibold flex items-center justify-center space-x-2 transition-all ${
                currentChapterIndex <= 0
                  ? "opacity-30 cursor-not-allowed"
                  : "hover:bg-black/5 dark:hover:bg-white/10"
              }`}
              style={{ borderColor: theme.border }}
            >
              <ChevronLeft className="w-4 h-4" />
              <span>上一章</span>
            </button>

            <span className="text-xs opacity-50">
              {currentChapterIndex + 1} / {toc.totalChapters}
            </span>

            <button
              onClick={() => goToChapter(currentChapterIndex + 1)}
              disabled={currentChapterIndex >= toc.chapters.length - 1}
              className={`w-full sm:w-auto px-5 py-2.5 rounded-xl border text-xs font-semibold flex items-center justify-center space-x-2 transition-all ${
                currentChapterIndex >= toc.chapters.length - 1
                  ? "opacity-30 cursor-not-allowed"
                  : "hover:bg-black/5 dark:hover:bg-white/10"
              }`}
              style={{ borderColor: theme.border }}
            >
              <span>下一章</span>
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </article>
      </main>

      {/* 3. Floating Bottom Toolbar / Progress Bar (Koodo style) */}
      <footer
        className={`fixed bottom-0 left-0 right-0 h-14 z-30 transition-transform duration-300 ease-in-out border-t shadow-lg flex items-center justify-between px-4 sm:px-8 ${
          showControls ? "translate-y-0" : "translate-y-full"
        }`}
        style={{
          backgroundColor: theme.bg,
          borderColor: theme.border,
          color: theme.text,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="max-w-4xl mx-auto w-full flex items-center justify-between space-x-3 sm:space-x-4">
          {/* Prev Chapter */}
          <button
            onClick={() => goToChapter(currentChapterIndex - 1)}
            disabled={currentChapterIndex <= 0}
            className="p-2 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-30 transition-colors shrink-0"
            title="上一章 (←)"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>

          {/* Quick TOC button in footer */}
          <button
            onClick={() => setIsTocOpen((prev) => !prev)}
            className="px-2.5 py-1.5 rounded-lg border text-xs font-medium flex items-center space-x-1 hover:bg-black/5 dark:hover:bg-white/10 shrink-0"
            style={{ borderColor: theme.border }}
            title="查看完整章节列表 (T)"
          >
            <List className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">目录</span>
          </button>

          {/* Chapter Slider */}
          <div className="flex-1 flex items-center space-x-2 sm:space-x-3">
            <span className="text-xs font-mono opacity-60 w-10 text-right truncate">
              {currentChapterIndex + 1}
            </span>
            <input
              type="range"
              min="0"
              max={toc.chapters.length - 1}
              value={currentChapterIndex}
              onChange={(e) => goToChapter(parseInt(e.target.value, 10))}
              className="flex-1 h-1.5 bg-black/10 dark:bg-white/10 rounded-lg appearance-none cursor-pointer accent-blue-500"
            />
            <span className="text-xs font-mono opacity-60 w-10 truncate">
              {toc.totalChapters}
            </span>
          </div>

          {/* Quick Search button in footer */}
          <button
            onClick={() => setIsSearchOpen((prev) => !prev)}
            className="px-2.5 py-1.5 rounded-lg border text-xs font-medium flex items-center space-x-1 hover:bg-black/5 dark:hover:bg-white/10 shrink-0"
            style={{ borderColor: theme.border }}
            title="全文检索 (F)"
          >
            <Search className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">全书搜索</span>
          </button>

          {/* Next Chapter */}
          <button
            onClick={() => goToChapter(currentChapterIndex + 1)}
            disabled={currentChapterIndex >= toc.chapters.length - 1}
            className="p-2 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-30 transition-colors shrink-0"
            title="下一章 (→)"
          >
            <ChevronRight className="w-5 h-5" />
          </button>
        </div>
      </footer>

      {/* 4. Left TOC Navigation Drawer */}
      <NavigationDrawer
        isOpen={isTocOpen}
        bookId={bookId || ""}
        bookTitle={toc.title}
        author={toc.author}
        chapters={toc.chapters}
        currentChapterId={currentChapterIndex}
        theme={theme}
        onClose={() => setIsTocOpen(false)}
        onSelectChapter={goToChapter}
      />

      {/* 5. In-Book Full-Text Search Drawer (Koodo style) */}
      <SearchDrawer
        isOpen={isSearchOpen}
        fullText={fullText}
        chapters={toc.chapters}
        theme={theme}
        onClose={() => setIsSearchOpen(false)}
        onSelectResult={(chapterId) => {
          goToChapter(chapterId);
        }}
      />

      {/* 6. Right Reader Settings Drawer */}
      <SettingDrawer
        isOpen={isSettingOpen}
        settings={settings}
        theme={theme}
        onClose={() => setIsSettingOpen(false)}
        onUpdateSettings={handleUpdateSettings}
      />
    </div>
  );
};
