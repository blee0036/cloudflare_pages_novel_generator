import React from "react";
import { BookOpen, User, HardDrive, Clock } from "lucide-react";
import { BookSummary, ReadingProgress } from "../types";
import { isFilterableAuthor } from "../utils/bookSearch";

interface BookCardProps {
  book: BookSummary;
  progress: ReadingProgress | null;
  onRead: (bookId: string) => void;
  onOpenToc?: (book: BookSummary) => void;
  /**
   * 点作者名筛出该作者的全部作品（需求 5.11）。未传、或作者是 `佚名` 这类占位值时，
   * 作者名按纯文本渲染——不给读者一个点了没用的东西（见 `isFilterableAuthor`）。
   */
  onFilterByAuthor?: (author: string) => void;
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
  onOpenToc,
  onFilterByAuthor,
}) => {
  const gradient = getCoverGradient(book.title);
  const authorClickable = Boolean(onFilterByAuthor) && isFilterableAuthor(book.author);
  const charCountStr =
    book.charCount > 10000
      ? `${(book.charCount / 10000).toFixed(1)}万字`
      : `${book.charCount}字`;
  const gzSizeStr = `${(book.gzSize / (1024 * 1024)).toFixed(1)}MB`;

  return (
    <div className="group relative bg-[var(--card-bg)] rounded-2xl shadow-sm hover:shadow-xl border border-[var(--border)] transition-all duration-300 flex flex-col overflow-hidden">
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
          {/*
            作者名是筛选入口（需求 5.11 / 差异表 B12）。用真的 `<button>` 而不是带 onClick
            的 `<span>`：它要能被 Tab 到、被回车/空格触发，这两样浏览器只白送给按钮。
            `<p>` 里放 `<button>` 合法（按钮是 phrasing content）。

            不加 `stopPropagation`：卡片的祖先元素上没有任何点击处理器——"章节目录"与
            "开始阅读"是下方两枚独立按钮，封面区整块不可点，所以这里不存在会被连带触发的
            上层动作。若日后把整张卡做成可点，那时才需要拦。
          */}
          <p className="text-xs text-white/80 flex items-center mt-1">
            <User className="w-3 h-3 mr-1 opacity-70 shrink-0" />
            {authorClickable ? (
              <button
                type="button"
                onClick={() => onFilterByAuthor?.(book.author)}
                title={`只看「${book.author}」的作品`}
                aria-label={`筛选作者「${book.author}」的全部作品`}
                /* 虚线下划线是"这里可点"的唯一提示：白字压在渐变封面上，换底色或加边框都会
                   把封面这块唯一的留白弄脏；悬停时下划线转实线并把字提到纯白。
                   焦点圈用 `outline`（白色 80%）而非 --accent：封面是深色渐变，主题强调色
                   在上面对比度不够。 */
                /* `min-w-0`：作为 flex 项，默认 `min-width:auto` 会让它拒绝收缩，于是
                   `truncate` 对超长作者名不生效、字会顶出封面。 */
                className="min-w-0 truncate underline decoration-dotted decoration-white/40 underline-offset-2 hover:text-white hover:decoration-white focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/80 rounded-sm transition-colors"
              >
                {book.author}
              </button>
            ) : (
              <span className="min-w-0 truncate">{book.author}</span>
            )}
          </p>
        </div>
      </div>

      {/* Info & Progress */}
      <div className="p-4 flex-1 flex flex-col justify-between space-y-4">
        <div className="space-y-2">
          {/* Metadata chips */}
          <div className="flex items-center text-xs text-[var(--text-muted)] space-x-3">
            <span className="flex items-center">
              <BookOpen className="w-3.5 h-3.5 mr-1 text-blue-500" />
              {book.totalChapters} 章
            </span>
            <span>·</span>
            <span>{charCountStr}</span>
          </div>

          {/* Reading progress banner if started */}
          {progress ? (
            <div className="bg-[var(--accent)]/10 border border-[var(--accent)]/20 rounded-xl p-2.5">
              <div className="flex justify-between text-[11px] text-[var(--accent)] font-medium mb-1">
                <span className="flex items-center">
                  <Clock className="w-3 h-3 mr-1" />
                  已读 {progress.progressPercent.toFixed(1)}%
                </span>
                {/* 不再叠 `opacity-80`（F-010）。字色沿用这一行的 `--accent`：改成 `--text-muted`
                    会把强调色的章节名换成灰色 */}
                <span className="truncate max-w-[120px]">
                  {progress.chapterTitle}
                </span>
              </div>
              <div className="w-full bg-[var(--accent)]/20 rounded-full h-1.5 overflow-hidden">
                <div
                  className="bg-[var(--accent)] h-full rounded-full transition-all"
                  style={{ width: `${Math.min(100, progress.progressPercent)}%` }}
                />
              </div>
            </div>
          ) : (
            <p className="text-xs text-[var(--text-muted)] line-clamp-1">
              尚未阅读 · 点击立即开启
            </p>
          )}
        </div>

        {/* Action Buttons */}
        <div className="flex items-center space-x-2">
          <button
            onClick={() => onOpenToc ? onOpenToc(book) : onRead(book.id)}
            className="flex-1 py-2.5 px-3 rounded-xl text-xs font-semibold border border-[var(--border)] hover:bg-[var(--hover)] text-[var(--text)] transition-colors flex items-center justify-center space-x-1"
            title="查看完整章节目录"
          >
            <span>章节目录</span>
          </button>

          <button
            onClick={() => onRead(book.id)}
            className={`flex-1 py-2.5 px-3 rounded-xl text-xs font-semibold flex items-center justify-center space-x-1.5 transition-all shadow-sm ${
              progress
                ? "bg-blue-600 hover:bg-blue-700 text-white shadow-blue-500/20"
                : /* 反色按钮：原先靠深色变体手工翻转（slate-900 ↔ slate-100），
                     换成前景/背景两个变量对调——任何主题下都自动与页面反色 */
                  "bg-[var(--text)] text-[var(--bg)] hover:opacity-90"
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
