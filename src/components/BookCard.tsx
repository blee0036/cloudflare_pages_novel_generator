import React from "react";
import { BookOpen, User, HardDrive, Clock } from "lucide-react";
import { BookSummary, ReadingProgress } from "../types";

interface BookCardProps {
  book: BookSummary;
  progress: ReadingProgress | null;
  onRead: (bookId: string) => void;
  onOpenToc?: (book: BookSummary) => void;
}

// Generate deterministic pleasant gradient for book cover
function getCoverGradient(title: string) {
  const hash = title.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const gradients = [
    "from-amber-700 via-amber-800 to-amber-950",
    "from-blue-700 via-indigo-800 to-slate-900",
    "from-emerald-700 via-teal-800 to-slate-900",
    "from-rose-700 via-red-800 to-stone-900",
    "from-purple-700 via-violet-800 to-slate-900",
    "from-cyan-700 via-sky-800 to-slate-900",
  ];
  return gradients[hash % gradients.length];
}

export const BookCard: React.FC<BookCardProps> = ({
  book,
  progress,
  onRead,
}) => {
  const gradient = getCoverGradient(book.title);
  const charCountStr =
    book.charCount > 10000
      ? `${(book.charCount / 10000).toFixed(1)}万字`
      : `${book.charCount}字`;
  const gzSizeStr = `${(book.gzSize / (1024 * 1024)).toFixed(1)}MB`;

  return (
    <div className="group relative bg-white dark:bg-slate-800 rounded-2xl shadow-sm hover:shadow-xl border border-slate-200/80 dark:border-slate-700/80 transition-all duration-300 flex flex-col overflow-hidden">
      {/* Cover / Header section */}
      <div
        className={`h-36 bg-gradient-to-br ${gradient} p-4 flex flex-col justify-between text-white relative overflow-hidden`}
      >
        {/* Subtle decorative background circle */}
        <div className="absolute -right-6 -bottom-6 w-28 h-28 rounded-full bg-white/10 blur-xl pointer-events-none" />

        <div className="flex justify-between items-start z-10">
          <span className="text-[11px] font-medium tracking-wide uppercase px-2 py-0.5 rounded-full bg-black/20 backdrop-blur-md">
            全本精校
          </span>
          <span className="text-[11px] opacity-80 flex items-center bg-black/20 px-2 py-0.5 rounded-full">
            <HardDrive className="w-3 h-3 mr-1" />
            {gzSizeStr}
          </span>
        </div>

        <div className="z-10">
          <h3 className="font-bold text-lg leading-tight line-clamp-1 group-hover:scale-[1.02] transition-transform">
            {book.title}
          </h3>
          <p className="text-xs text-white/80 flex items-center mt-1">
            <User className="w-3 h-3 mr-1 opacity-70" />
            {book.author}
          </p>
        </div>
      </div>

      {/* Info & Progress */}
      <div className="p-4 flex-1 flex flex-col justify-between space-y-4">
        <div className="space-y-2">
          {/* Metadata chips */}
          <div className="flex items-center text-xs text-slate-500 dark:text-slate-400 space-x-3">
            <span className="flex items-center">
              <BookOpen className="w-3.5 h-3.5 mr-1 text-blue-500" />
              {book.totalChapters} 章
            </span>
            <span>·</span>
            <span>{charCountStr}</span>
          </div>

          {/* Reading progress banner if started */}
          {progress ? (
            <div className="bg-blue-50 dark:bg-blue-950/40 border border-blue-100 dark:border-blue-900/50 rounded-xl p-2.5">
              <div className="flex justify-between text-[11px] text-blue-600 dark:text-blue-400 font-medium mb-1">
                <span className="flex items-center">
                  <Clock className="w-3 h-3 mr-1" />
                  已读 {progress.progressPercent.toFixed(1)}%
                </span>
                <span className="truncate max-w-[120px] opacity-80">
                  {progress.chapterTitle}
                </span>
              </div>
              <div className="w-full bg-blue-200 dark:bg-blue-900 rounded-full h-1.5 overflow-hidden">
                <div
                  className="bg-blue-600 dark:bg-blue-400 h-full rounded-full transition-all"
                  style={{ width: `${Math.min(100, progress.progressPercent)}%` }}
                />
              </div>
            </div>
          ) : (
            <p className="text-xs text-slate-400 dark:text-slate-500 line-clamp-1">
              尚未阅读 · 点击立即开启
            </p>
          )}
        </div>

        {/* Action Buttons */}
        <div className="flex items-center space-x-2">
          <button
            onClick={() => onOpenToc ? onOpenToc(book) : onRead(book.id)}
            className="flex-1 py-2.5 px-3 rounded-xl text-xs font-semibold border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 transition-colors flex items-center justify-center space-x-1"
            title="查看完整章节目录"
          >
            <span>章节目录</span>
          </button>

          <button
            onClick={() => onRead(book.id)}
            className={`flex-1 py-2.5 px-3 rounded-xl text-xs font-semibold flex items-center justify-center space-x-1.5 transition-all shadow-sm ${
              progress
                ? "bg-blue-600 hover:bg-blue-700 text-white shadow-blue-500/20"
                : "bg-slate-900 hover:bg-black text-white dark:bg-slate-100 dark:hover:bg-white dark:text-slate-900"
            }`}
          >
            <BookOpen className="w-3.5 h-3.5" />
            <span>{progress ? "继续阅读" : "开始阅读"}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
