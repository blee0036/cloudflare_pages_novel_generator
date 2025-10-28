import { ChangeEvent, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import FlexSearch from "flexsearch";
import { useBooks } from "../api/hooks";
import { useDebounce } from "../hooks/useDebounce";
import type { BookSummary } from "../api/types";
import { useReadingHistory } from "../hooks/useReadingHistory";
import { siteConfig } from "../config/siteConfig";
import { formatDateTime } from "../utils/text";

const skeletonItems = Array.from({ length: 8 });

const HomePage: React.FC = () => {
  const [searchTerm, setSearchTerm] = useState("");
  const debounced = useDebounce(searchTerm, 300);
  const { data, error, isLoading, isFetching } = useBooks();
  const books = useMemo(() => data?.books ?? [], [data?.books]);
  const history = useReadingHistory(5);
  const [filtered, setFiltered] = useState<BookSummary[]>(books);

  const searchDoc = useMemo(() => {
    if (!books.length) return null;

    type FlexDoc = {
      add(doc: BookSummary): void;
      search(term: string, options?: unknown): unknown;
    };

    type FlexSearchModule = {
      Document: new (...args: unknown[]) => FlexDoc;
    };

    const moduleRef = FlexSearch as unknown as FlexSearchModule;
    const doc = new moduleRef.Document({
      tokenize: "full",
      document: {
        id: "id",
        store: ["title", "author"],
        index: [
          { field: "title", tokenize: "full" },
          { field: "author", tokenize: "forward" },
        ],
      },
    });
    for (const book of books) {
      doc.add(book);
    }
    return doc;
  }, [books]);

  useEffect(() => {
    setFiltered(books);
  }, [books]);

  useEffect(() => {
    const term = debounced.trim();
    if (!term) {
      setFiltered(books);
      return;
    }
    if (!searchDoc) {
      setFiltered([]);
      return;
    }
    const results = (searchDoc?.search(term, { enrich: true }) ?? []) as Array<{
      field: string;
      result: Array<string | BookSummary>;
    }>;
    const ids = new Set<string>();
    for (const group of results ?? []) {
      for (const entry of group.result ?? []) {
        if (typeof entry === "string") {
          ids.add(entry);
        } else if (entry && typeof entry === "object" && "id" in entry) {
          ids.add(entry.id);
        }
      }
    }
    if (ids.size === 0) {
      setFiltered([]);
      return;
    }
    setFiltered(books.filter((book) => ids.has(book.id)));
  }, [debounced, books, searchDoc]);

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    setSearchTerm(event.target.value);
  };

  const { tagline } = siteConfig;

  return (
    <section className="panel" aria-label="书籍列表">
      <div className="panel-header">
        <div>
          <div className="panel-title">书库</div>
          <div className="panel-subtitle">{tagline ?? "纯静态 Cloudflare Pages 小说阅读器"}</div>
        </div>
        <label className="search-box" htmlFor="book-search">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path d="M21 21l-4.35-4.35" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="10.5" cy="10.5" r="6.5" />
          </svg>
          <input
            id="book-search"
            type="search"
            placeholder="搜索书名或作者"
            value={searchTerm}
            onChange={handleChange}
          />
        </label>
      </div>
      {error ? (
        <div className="error-state">加载失败：{error.message}</div>
      ) : (
        <>
          <div className="panel-subtitle">共 {books.length} 本书{isFetching ? " · 更新中" : ""}</div>
          {history.length > 0 ? (
            <section className="reading-history" aria-label="最近阅读">
              <header className="reading-history-header">
                <h2>最近阅读</h2>
                <p>快速回到刚刚离开的章节</p>
              </header>
              <div className="reading-history-list">
                {history.map((item) => (
                  <Link key={item.bookId} className="reading-history-item" to={`/reader/${item.chapterId}`}>
                    <div className="reading-history-text">
                      <div className="reading-history-book">{item.bookTitle}</div>
                      <div className="reading-history-chapter">{item.chapterTitle}</div>
                    </div>
                    <div className="reading-history-meta">
                      <span>{formatDateTime(item.updatedAt)}</span>
                      <span className="reading-history-action">继续阅读 →</span>
                    </div>
                  </Link>
                ))}
              </div>
            </section>
          ) : null}
          <div className="book-grid" role="list">
            {isLoading
              ? skeletonItems.map((_, index) => (
                  <div key={index} className="book-card skeleton" style={{ height: 130 }} />
                ))
              : filtered.map((book) => (
                  <article key={book.id} className="book-card" role="listitem">
                    <div>
                      <div className="book-title">{book.title}</div>
                      <div className="book-author">作者：{book.author}</div>
                    </div>
                    <Link className="book-link" to={`/books/${book.id}`}>
                      查看章节
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                        <path d="M9 18l6-6-6-6" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </Link>
                  </article>
                ))}
          </div>
          {!isLoading && filtered.length === 0 ? <div className="empty-state">暂无相关书籍</div> : null}
        </>
      )}
    </section>
  );
};

export default HomePage;
