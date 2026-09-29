import React, { useState, useEffect, useMemo, useRef } from "react";
import { X, Search, BookOpen, User, HardDrive, Play, RefreshCw } from "lucide-react";
import { BookSummary, BookToc, ReadingProgress } from "../types";
import { loadToc } from "../utils/tocCache";
import {
  GRID_CELL_HEIGHT,
  GRID_ROW_PITCH,
  computeGridWindow,
} from "../utils/listWindow";

/**
 * 滚动容器的纵向内边距（`p-4` = 16px）。行号换算前要先扣掉，否则第 0 行的顶端
 * 不在 `scrollTop = 0` 处。
 */
const SCROLL_PAD = 16;

/**
 * 列数切换点。原先网格写的是 `grid-cols-1 sm:grid-cols-2`，`sm` 是 Tailwind 默认的
 * 40rem——这里直接查同一个断点，让"算出来的列数"与"渲染出来的列数"同源：
 * `gridTemplateColumns` 也由这个数生成，两者不可能对不上。
 */
const TWO_COLUMN_QUERY = "(min-width: 40rem)";

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

  // 窗口化状态（design §6.2，需求 3.3）：这四个数决定挂载哪些章节。
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(0);
  const [columns, setColumns] = useState(1);
  const rafRef = useRef(0);
  const pendingTopRef = useRef(0);

  useEffect(() => {
    if (!book || !isOpen) return;

    let cancelled = false;
    setLoading(true);
    setSearch("");

    // 经 tocCache 走，与阅读器共用同一个在途/已完成请求（需求 3.4）
    loadToc(book.id)
      .then((data: BookToc) => {
        if (!cancelled) setToc(data);
      })
      .catch((err) => {
        console.error("Failed to load toc:", err);
        // 失败时不能留着上一本书的章节表继续渲染
        if (!cancelled) setToc(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [book, isOpen]);

  // 列数：随断点变化（手机单列、桌面双列），不能假定固定列数。
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const mq = window.matchMedia(TWO_COLUMN_QUERY);
    const sync = () => setColumns(mq.matches ? 2 : 1);

    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  // 视口高度：弹窗高度是 88vh，会随窗口尺寸与旋屏变化，用 ResizeObserver 跟住。
  useEffect(() => {
    const el = gridRef.current;
    if (!isOpen || !el) return;

    setViewH(el.clientHeight);
    if (typeof ResizeObserver === "undefined") return;

    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [isOpen]);

  useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  const filteredChapters = useMemo(() => {
    if (!toc) return [];
    if (!search.trim()) return toc.chapters;
    const term = search.toLowerCase();
    return toc.chapters.filter((c) => c.title.toLowerCase().includes(term));
  }, [toc, search]);

  // 换书或改过滤词后列表内容整体变了，停在原来的 scrollTop 上只会看到一片空白，
  // 直接回到顶部。
  useEffect(() => {
    if (gridRef.current) gridRef.current.scrollTop = 0;
    setScrollTop(0);
  }, [filteredChapters]);

  const grid = useMemo(
    () =>
      computeGridWindow(
        scrollTop - SCROLL_PAD,
        viewH,
        filteredChapters.length,
        columns,
      ),
    [scrollTop, viewH, filteredChapters.length, columns],
  );

  // 滚动经 rAF 节流：一帧最多一次 setState，且只用事件里已经算好的 scrollTop，
  // 不在处理器里回读布局。
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    pendingTopRef.current = e.currentTarget.scrollTop;
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      setScrollTop(pendingTopRef.current);
    });
  };

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
      <div className="relative w-full max-w-2xl max-h-[88vh] rounded-2xl shadow-2xl border border-[var(--border)] flex flex-col z-10 overflow-hidden bg-[var(--bg)] text-[var(--text)]">
        {/* Top Info Banner */}
        <div className="p-6 border-b border-[var(--border)] flex items-start justify-between bg-[var(--card-bg)]">
          <div>
            <div className="flex items-center space-x-2 text-xs text-[var(--accent)] font-semibold mb-1">
              <BookOpen className="w-4 h-4" />
              <span>章节目录 · 全本精校</span>
            </div>
            <h2 className="text-xl font-bold">{book.title}</h2>
            <div className="flex flex-wrap items-center gap-3 text-xs text-[var(--text)]/60 mt-2">
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
            className="p-1.5 rounded-lg hover:bg-[var(--hover)] text-[var(--text)]/50 hover:text-[var(--text)]"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Quick Read / Resume Button & Search */}
        <div className="p-4 border-b border-[var(--border)] flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="relative w-full sm:w-72">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text)]/50" />
            <input
              type="text"
              placeholder="快速过滤章节..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 pr-3 py-1.5 text-xs sm:text-sm rounded-xl bg-[var(--card-bg)] border border-[var(--border)] focus:outline-none focus:border-[var(--accent)]"
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

        {/*
          Chapters Grid / List（窗口化，design §6.2）
          - 纵向内边距仍是 `p-4`，换算时由 `SCROLL_PAD` 扣掉。
          - 两个 spacer 按"行"撑高度：总高恒为 `rows * GRID_ROW_PITCH - GRID_GAP`，
            与当前挂载了哪一段无关，所以滚动条不会抖。
        */}
        <div
          ref={gridRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto p-4"
        >
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
            <>
              <div style={{ height: grid.start * GRID_ROW_PITCH }} aria-hidden />
              <div
                className="grid gap-2"
                style={{
                  gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                }}
              >
                {filteredChapters
                  .slice(grid.itemStart, grid.itemEnd)
                  .map((chap) => {
                    const isRead = progress && progress.chapterId === chap.id;
                    return (
                      <button
                        key={chap.id}
                        onClick={() => onSelectChapter(book.id, chap.id)}
                        // 固定单元高度：一旦出现可变高度，"行号 ↔ scrollTop" 的换算就不成立
                        style={{ height: GRID_CELL_HEIGHT }}
                        className={`text-left px-3 rounded-xl border text-xs flex items-center justify-between transition-all group ${
                          isRead
                            ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)] font-semibold"
                            : "border-[var(--border)] hover:bg-[var(--hover)] text-[var(--text)]"
                        }`}
                      >
                        <span className="truncate pr-2 group-hover:text-[var(--accent)]">
                          {chap.title}
                        </span>
                        <span className="text-[10px] text-slate-400 shrink-0">
                          {chap.length ? `${chap.length}字` : ""}
                        </span>
                      </button>
                    );
                  })}
              </div>
              <div
                style={{
                  height: Math.max(0, (grid.rows - grid.end) * GRID_ROW_PITCH),
                }}
                aria-hidden
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
};
