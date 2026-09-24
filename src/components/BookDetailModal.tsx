import React, { useState, useEffect, useMemo } from "react";
import { X, Search, BookOpen, User, HardDrive, Play, RefreshCw, CheckCircle2 } from "lucide-react";
import { BookSummary, BookToc, ReadingProgress } from "../types";

interface BookDetailModalProps {
  book: BookSummary | null;
  progress: ReadingProgress | null;
  isOpen: boolean;
  onClose: () => void;
  onSelectChapter: (bookId: string, chapterId: number) => void;
}

export const BookDetailModal: React.FC<BookDetailModalProps> = ({
  book,
  progress,
  isOpen,
  onClose,
  onSelectChapter,
}) => {
  const [toc, setToc] = useState<BookToc | null>(null);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!book || !isOpen) return;

    let cancelled = false;
    setLoading(true);
    setSearch("");

    fetch(book.tocPath)
      .then((res) => res.json())
      .then((data: BookToc) => {
        if (!cancelled) setToc(data);
      })
      .catch((err) => {
        console.error("Failed to load toc:", err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [book, isOpen]);

  const filteredChapters = useMemo(() => {
    if (!toc) return [];
    if (!search.trim()) return toc.chapters;
    const term = search.toLowerCase();
    return toc.chapters.filter((c) => c.title.toLowerCase().includes(term));
  }, [toc, search]);

  if (!isOpen || !book) return null;

  const charCountStr =
    book.charCount > 10000
      ? `${(book.charCount / 10000).toFixed(1)}万字`
      : `${book.charCount}字`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-sm transition-opacity"
        onClick={onClose}
      />

      {/* Modal Content */}
      <div className="relative w-full max-w-2xl max-h-[88vh] bg-white dark:bg-slate-850 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700 flex flex-col z-10 overflow-hidden bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100">
        {/* Top Info Banner */}
        <div className="p-6 border-b border-slate-200/80 dark:border-slate-800 flex items-start justify-between bg-slate-50 dark:bg-slate-800/50">
          <div>
            <div className="flex items-center space-x-2 text-xs text-blue-600 dark:text-blue-400 font-semibold mb-1">
              <BookOpen className="w-4 h-4" />
              <span>章节目录 · 全本精校</span>
            </div>
            <h2 className="text-xl font-bold">{book.title}</h2>
            <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500 dark:text-slate-400 mt-2">
              <span className="flex items-center">
                <User className="w-3.5 h-3.5 mr-1 opacity-70" />
                {book.author}
              </span>
              <span>·</span>
              <span>共 {book.totalChapters} 章</span>
              <span>·</span>
              <span>{charCountStr}</span>
              <span>·</span>
              <span className="flex items-center">
                <HardDrive className="w-3.5 h-3.5 mr-1 opacity-70" />
                {(book.gzSize / (1024 * 1024)).toFixed(1)}MB Gzip
              </span>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Quick Read / Resume Button & Search */}
        <div className="p-4 border-b border-slate-200/80 dark:border-slate-800 flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="relative w-full sm:w-72">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              placeholder="快速过滤章节..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 pr-3 py-1.5 text-xs sm:text-sm rounded-xl bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 focus:outline-none focus:border-blue-500"
            />
          </div>

          <button
            onClick={() => onSelectChapter(book.id, progress ? progress.chapterId : 0)}
            className="w-full sm:w-auto px-5 py-2 rounded-xl text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white flex items-center justify-center space-x-1.5 shadow-md shadow-blue-500/20 transition-all shrink-0"
          >
            <Play className="w-3.5 h-3.5 fill-current" />
            <span>
              {progress
                ? `继续阅读 (第 ${progress.chapterId + 1} 章)`
                : "从第 1 章开始阅读"}
            </span>
          </button>
        </div>

        {/* Chapters Grid / List */}
        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="py-20 text-center text-slate-400">
              <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2 text-blue-500" />
              <p className="text-xs">正在载入完整章节目录...</p>
            </div>
          ) : filteredChapters.length === 0 ? (
            <div className="py-16 text-center text-slate-400 text-xs">
              未找到匹配的章节
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {filteredChapters.map((chap) => {
                const isRead = progress && progress.chapterId === chap.id;
                return (
                  <button
                    key={chap.id}
                    onClick={() => onSelectChapter(book.id, chap.id)}
                    className={`text-left p-3 rounded-xl border text-xs flex items-center justify-between transition-all group ${
                      isRead
                        ? "border-blue-500 bg-blue-50/50 dark:bg-blue-950/30 text-blue-600 dark:text-blue-400 font-semibold"
                        : "border-slate-100 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800/50 text-slate-700 dark:text-slate-300"
                    }`}
                  >
                    <span className="truncate pr-2 group-hover:text-blue-600 dark:group-hover:text-blue-400">
                      {chap.title}
                    </span>
                    <span className="text-[10px] text-slate-400 shrink-0">
                      {chap.length ? `${chap.length}字` : ""}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
