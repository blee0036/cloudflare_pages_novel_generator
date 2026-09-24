import React, { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Search, BookOpen, Sparkles, RefreshCw, AlertCircle } from "lucide-react";
import { BooksCatalog, BookSummary, ReadingProgress } from "../types";
import { getBookProgress } from "../utils/storage";
import { BookCard } from "../components/BookCard";
import { BookDetailModal } from "../components/BookDetailModal";

export const BookshelfPage: React.FC = () => {
  const navigate = useNavigate();
  const [catalog, setCatalog] = useState<BooksCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [progressMap, setProgressMap] = useState<Record<string, ReadingProgress | null>>({});
  const [selectedBookForToc, setSelectedBookForToc] = useState<BookSummary | null>(null);

  const fetchBooks = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/data/books.json");
      if (!res.ok) {
        throw new Error(`无法获取书架索引 (HTTP ${res.status})。请确保已执行 npm run preprocess`);
      }
      const data: BooksCatalog = await res.json();
      setCatalog(data);

      // Load progress for each book
      const pMap: Record<string, ReadingProgress | null> = {};
      data.books.forEach((b) => {
        pMap[b.id] = getBookProgress(b.id);
      });
      setProgressMap(pMap);
    } catch (err: any) {
      setError(err.message || "加载书架失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchBooks();
  }, []);

  const filteredBooks = useMemo(() => {
    if (!catalog?.books) return [];
    if (!searchTerm.trim()) return catalog.books;
    const term = searchTerm.toLowerCase();
    return catalog.books.filter(
      (b) =>
        b.title.toLowerCase().includes(term) ||
        b.author.toLowerCase().includes(term)
    );
  }, [catalog, searchTerm]);

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900 text-slate-800 dark:text-slate-100 transition-colors">
      {/* Top Navbar */}
      <header className="sticky top-0 z-20 bg-white/80 dark:bg-slate-800/80 backdrop-blur-md border-b border-slate-200/80 dark:border-slate-700/80">
        <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center space-x-2.5">
            <div className="w-9 h-9 rounded-xl bg-blue-600 flex items-center justify-center text-white shadow-md shadow-blue-500/20">
              <BookOpen className="w-5 h-5" />
            </div>
            <div>
              <span className="font-bold text-base tracking-tight block leading-tight">
                云端小说书架
              </span>
              <span className="text-[10px] text-slate-400 block leading-tight">
                Cloudflare Pages + Gzip 静态阅读器
              </span>
            </div>
          </div>

          {/* Search bar */}
          <div className="relative w-48 sm:w-72">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              placeholder="搜索书名或作者..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-9 pr-4 py-1.5 text-xs sm:text-sm rounded-xl bg-slate-100 dark:bg-slate-700/60 border border-transparent focus:border-blue-500 focus:bg-white dark:focus:bg-slate-750 focus:outline-none transition-all"
            />
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-6xl mx-auto px-4 py-8">
        {/* Banner */}
        <div className="mb-8 p-6 rounded-2xl bg-gradient-to-r from-blue-600 to-indigo-700 text-white shadow-lg shadow-blue-500/10 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <div className="flex items-center space-x-2 mb-2">
              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-white/20 backdrop-blur-md">
                <Sparkles className="w-3.5 h-3.5 mr-1" />
                Pure Cloudflare Pages 架构
              </span>
            </div>
            <h1 className="text-xl sm:text-2xl font-extrabold tracking-tight">
              轻量、丝滑且无限制的 Web 电子书库
            </h1>
            <p className="text-xs sm:text-sm text-blue-100 mt-1 max-w-xl">
              采用单书原生 Gzip 压缩存储，通过浏览器 DecompressionStream 内存流解压，配合分级正则状态机与绝对字符偏移断章，彻底告别切片乱码与文件数超限。
            </p>
          </div>
          <div className="shrink-0 bg-white/10 backdrop-blur-md px-5 py-3 rounded-xl border border-white/10 text-center sm:text-right">
            <div className="text-2xl font-black">{catalog?.count || 0}</div>
            <div className="text-xs text-blue-100">精校藏书</div>
          </div>
        </div>

        {/* Content States */}
        {loading ? (
          <div className="py-24 text-center">
            <RefreshCw className="w-8 h-8 animate-spin mx-auto text-blue-500 mb-3" />
            <p className="text-sm text-slate-500">正在载入书架索引...</p>
          </div>
        ) : error ? (
          <div className="py-16 text-center max-w-md mx-auto">
            <AlertCircle className="w-10 h-10 text-rose-500 mx-auto mb-3" />
            <h3 className="font-semibold text-base mb-1">加载遇到问题</h3>
            <p className="text-xs text-slate-500 mb-4">{error}</p>
            <button
              onClick={fetchBooks}
              className="px-4 py-2 bg-blue-600 text-white rounded-xl text-xs font-semibold hover:bg-blue-700 transition-colors shadow-sm"
            >
              重新加载
            </button>
          </div>
        ) : filteredBooks.length === 0 ? (
          <div className="py-20 text-center text-slate-400">
            <BookOpen className="w-12 h-12 mx-auto mb-2 opacity-30" />
            <p className="text-sm">未找到与 "{searchTerm}" 相关的书籍</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
            {filteredBooks.map((book) => (
              <BookCard
                key={book.id}
                book={book}
                progress={progressMap[book.id]}
                onRead={(bookId) => navigate(`/read/${encodeURIComponent(bookId)}`)}
                onOpenToc={(b) => setSelectedBookForToc(b)}
              />
            ))}
          </div>
        )}
      </main>

      {/* Chapter Directory Modal */}
      <BookDetailModal
        book={selectedBookForToc}
        progress={selectedBookForToc ? progressMap[selectedBookForToc.id] : null}
        isOpen={Boolean(selectedBookForToc)}
        onClose={() => setSelectedBookForToc(null)}
        onSelectChapter={(bookId, chapterId) => {
          setSelectedBookForToc(null);
          navigate(`/read/${encodeURIComponent(bookId)}?ch=${chapterId}`);
        }}
      />
    </div>
  );
};
