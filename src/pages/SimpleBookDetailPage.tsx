import { useEffect } from "react";
import { useParams, Link, Navigate } from "react-router-dom";
import { useBook } from "../api/hooks_simple";
import { getBookProgress } from "../utils/readingProgress";
import { siteConfig } from "../config/siteConfig";

const SimpleBookDetailPage: React.FC = () => {
  const { bookId } = useParams<{ bookId: string }>();
  const { data: book, error, isLoading } = useBook(bookId);
  
  const progress = book ? getBookProgress(book.id) : null;
  
  useEffect(() => {
    if (book) {
      document.title = `${book.title} - ${siteConfig.siteName}`;
    }
    return () => {
      document.title = siteConfig.siteName;
    };
  }, [book]);
  
  if (error) {
    if (error.status === 404) {
      return <Navigate to="/404" replace />;
    }
    return (
      <section className="panel">
        <div className="error-state">加载失败：{error.message}</div>
      </section>
    );
  }
  
  if (isLoading || !book) {
    return (
      <section className="panel">
        <div className="skeleton" style={{ width: 200, height: 36, marginBottom: 16 }} />
        <div className="skeleton" style={{ width: 120, height: 24, marginBottom: 32 }} />
        <div className="skeleton" style={{ width: "100%", height: 200 }} />
      </section>
    );
  }
  
  return (
    <section className="panel">
      <nav className="breadcrumb" aria-label="breadcrumb">
        <Link to="/">书库</Link>
        <span>/</span>
        <span>{book.title}</span>
      </nav>
      <div className="book-meta">
        <div>
          <h1 className="panel-title" style={{ margin: 0 }}>
            {book.title}
          </h1>
          <div className="panel-subtitle">作者：{book.author}</div>
        </div>
        <div className="book-actions">
          {progress ? (
            <Link className="continue-button" to={`/reader/${book.id}`}>
              继续阅读
            </Link>
          ) : (
            <Link className="continue-button" to={`/reader/${book.id}`}>
              开始阅读
            </Link>
          )}
          <a className="download-button" href={`/api/books/${book.id}/download`}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M12 3v14" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M6 11l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M5 21h14" strokeLinecap="round" />
            </svg>
            下载整本
          </a>
        </div>
      </div>
      <div className="panel-subtitle" style={{ marginTop: 24 }}>
        文件大小：{(book.totalSize / 1024 / 1024).toFixed(1)} MB
      </div>
      <div className="panel-subtitle" style={{ marginTop: 8, color: "#666" }}>
        支持滚动连续阅读，自动保存进度
      </div>
    </section>
  );
};

export default SimpleBookDetailPage;
