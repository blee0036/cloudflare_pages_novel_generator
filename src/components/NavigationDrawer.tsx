import React, { useState, useMemo, useEffect, useRef } from "react";
import { X, Search, BookOpen, Bookmark as BookmarkIcon, Trash2 } from "lucide-react";
import { ChapterMeta, Bookmark } from "../types";
import { ThemeConfig, getBookmarks, removeBookmark } from "../utils/storage";

interface NavigationDrawerProps {
  isOpen: boolean;
  bookId: string;
  bookTitle: string;
  author: string;
  chapters: ChapterMeta[];
  currentChapterId: number;
  theme: ThemeConfig;
  onClose: () => void;
  onSelectChapter: (chapterId: number) => void;
}

export const NavigationDrawer: React.FC<NavigationDrawerProps> = ({
  isOpen,
  bookId,
  bookTitle,
  author,
  chapters,
  currentChapterId,
  theme,
  onClose,
  onSelectChapter,
}) => {
  const [activeTab, setActiveTab] = useState<"toc" | "bookmark">("toc");
  const [keyword, setKeyword] = useState("");
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const activeItemRef = useRef<HTMLButtonElement>(null);

  // Refresh bookmarks when opening or tab changes
  useEffect(() => {
    if (isOpen) {
      setBookmarks(getBookmarks(bookId));
    }
  }, [isOpen, bookId, activeTab]);

  const filteredChapters = useMemo(() => {
    if (!keyword.trim()) return chapters;
    const lower = keyword.toLowerCase();
    return chapters.filter((c) => c.title.toLowerCase().includes(lower));
  }, [chapters, keyword]);

  // Scroll active chapter into view when opening drawer
  useEffect(() => {
    if (isOpen && activeTab === "toc" && activeItemRef.current) {
      setTimeout(() => {
        activeItemRef.current?.scrollIntoView({
          block: "center",
          behavior: "smooth",
        });
      }, 150);
    }
  }, [isOpen, currentChapterId, activeTab]);

  const handleDeleteBookmark = (bmId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    removeBookmark(bookId, bmId);
    setBookmarks(getBookmarks(bookId));
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-40 flex">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/40 backdrop-blur-sm transition-opacity"
        onClick={onClose}
      />

      {/* Drawer */}
      <div
        className="relative w-80 sm:w-96 max-w-[85vw] h-full shadow-2xl flex flex-col z-50 transition-transform duration-300"
        style={{
          backgroundColor: theme.bg,
          color: theme.text,
          borderRight: `1px solid ${theme.border}`,
        }}
      >
        {/* Header */}
        <div
          className="p-4 border-b flex items-start justify-between"
          style={{ borderColor: theme.border }}
        >
          <div>
            <div className="flex items-center space-x-2">
              <BookOpen className="w-4 h-4" style={{ color: theme.accent }} />
              <h2 className="font-bold text-base line-clamp-1">{bookTitle}</h2>
            </div>
            <p className="text-xs opacity-60 mt-1">
              作者: {author} · 共 {chapters.length} 章
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-black/5 dark:hover:bg-white/10"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tab Switcher (Koodo Style) */}
        <div
          className="grid grid-cols-2 p-1.5 border-b gap-1 text-xs font-medium"
          style={{ borderColor: theme.border, backgroundColor: theme.cardBg }}
        >
          <button
            onClick={() => setActiveTab("toc")}
            className={`py-1.5 rounded-lg transition-all flex items-center justify-center space-x-1.5 ${
              activeTab === "toc"
                ? "bg-white shadow text-blue-600 dark:bg-slate-700 dark:text-blue-400 font-bold"
                : "opacity-60 hover:opacity-100"
            }`}
          >
            <BookOpen className="w-3.5 h-3.5" />
            <span>章节目录 ({chapters.length})</span>
          </button>

          <button
            onClick={() => setActiveTab("bookmark")}
            className={`py-1.5 rounded-lg transition-all flex items-center justify-center space-x-1.5 ${
              activeTab === "bookmark"
                ? "bg-white shadow text-blue-600 dark:bg-slate-700 dark:text-blue-400 font-bold"
                : "opacity-60 hover:opacity-100"
            }`}
          >
            <BookmarkIcon className="w-3.5 h-3.5" />
            <span>我的书签 ({bookmarks.length})</span>
          </button>
        </div>

        {/* TOC Content */}
        {activeTab === "toc" && (
          <>
            {/* Search */}
            <div className="p-3 border-b" style={{ borderColor: theme.border }}>
              <div
                className="flex items-center px-3 py-1.5 rounded-lg border text-sm"
                style={{
                  backgroundColor: theme.cardBg,
                  borderColor: theme.border,
                }}
              >
                <Search className="w-4 h-4 opacity-50 mr-2 shrink-0" />
                <input
                  type="text"
                  placeholder="搜索章节名..."
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                  className="bg-transparent w-full focus:outline-none text-xs sm:text-sm"
                  style={{ color: theme.text }}
                />
                {keyword && (
                  <button
                    onClick={() => setKeyword("")}
                    className="text-xs opacity-50 hover:opacity-100"
                  >
                    清除
                  </button>
                )}
              </div>
            </div>

            {/* Chapter List */}
            <div className="flex-1 overflow-y-auto py-2 divide-y divide-black/5 dark:divide-white/5">
              {filteredChapters.length === 0 ? (
                <div className="p-8 text-center text-xs opacity-50">
                  未找到匹配的章节
                </div>
              ) : (
                filteredChapters.map((chap) => {
                  const isActive = chap.id === currentChapterId;
                  return (
                    <button
                      key={chap.id}
                      ref={isActive ? activeItemRef : undefined}
                      onClick={() => {
                        onSelectChapter(chap.id);
                        onClose();
                      }}
                      className={`w-full text-left px-4 py-3 text-xs sm:text-sm flex items-center justify-between transition-colors ${
                        isActive
                          ? "font-semibold shadow-inner"
                          : "opacity-80 hover:opacity-100 hover:bg-black/5 dark:hover:bg-white/5"
                      }`}
                      style={{
                        backgroundColor: isActive ? theme.cardBg : "transparent",
                        color: isActive ? theme.accent : theme.text,
                      }}
                    >
                      <span className="truncate pr-2">{chap.title}</span>
                      <span className="text-[10px] opacity-40 shrink-0">
                        {chap.length ? `${chap.length}字` : ""}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </>
        )}

        {/* Bookmarks Tab Content */}
        {activeTab === "bookmark" && (
          <div className="flex-1 overflow-y-auto p-3 divide-y divide-black/5 dark:divide-white/5">
            {bookmarks.length === 0 ? (
              <div className="py-24 text-center opacity-40 text-xs px-6">
                暂无书签。在阅读页面点击右上角书签图标即可随时记录精彩位置
              </div>
            ) : (
              bookmarks.map((bm) => (
                <div
                  key={bm.id}
                  onClick={() => {
                    onSelectChapter(bm.chapterId);
                    onClose();
                  }}
                  className="py-3 px-2 rounded-xl hover:bg-black/5 dark:hover:bg-white/5 transition-colors cursor-pointer group flex items-start justify-between space-x-2"
                >
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-xs truncate flex items-center space-x-1.5">
                      <BookmarkIcon className="w-3 h-3 text-amber-500 fill-current shrink-0" />
                      <span className="truncate">{bm.chapterTitle}</span>
                    </div>
                    {bm.previewText && (
                      <p className="text-[11px] opacity-70 line-clamp-2 mt-1 leading-relaxed">
                        {bm.previewText}
                      </p>
                    )}
                    <span className="text-[9px] opacity-40 mt-1 block">
                      {new Date(bm.createdAt).toLocaleDateString()} {new Date(bm.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>

                  <button
                    onClick={(e) => handleDeleteBookmark(bm.id, e)}
                    className="p-1 text-slate-400 hover:text-rose-500 transition-colors opacity-0 group-hover:opacity-100 shrink-0"
                    title="删除此书签"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
};
