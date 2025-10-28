import { Link, useParams } from "react-router-dom";
import { useBookDetail } from "../api/hooks";
import { useBookProgress } from "../hooks/useReadingHistory";

const chapterSkeleton = Array.from({ length: 16 });

const BookDetailPage: React.FC = () => {
  const { bookId } = useParams();
  const { data, error, isLoading } = useBookDetail(bookId);
  const progress = useBookProgress(bookId);

  if (error) {
    return (
      <section className="panel">
        <div className="error-state">加载书籍失败：{error.message}</div>
      </section>
    );
  }

  if (isLoading || !data) {
    return (
      <section className="panel">
        <div className="breadcrumb skeleton" style={{ height: 18, width: 200 }} />
        <div className="book-meta">
          <div className="skeleton" style={{ height: 32, width: 240, borderRadius: 12 }} />
          <div className="skeleton" style={{ height: 40, width: 160, borderRadius: 12 }} />
        </div>
        <div className="chapter-list" style={{ marginTop: 32 }}>
          {chapterSkeleton.map((_, index) => (
            <div key={index} className="chapter-item skeleton" style={{ height: 68 }} />
          ))}
        </div>
      </section>
    );
  }

  const { book, chapters } = data;

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
            <Link className="continue-button" to={`/reader/${progress.chapterId}`}>
              继续阅读：{progress.chapterTitle}
            </Link>
          ) : null}
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
        共 {chapters.length} 章，点击下方章节快速阅读
      </div>
      <div className="chapter-list" role="list">
        {chapters.map((chapter) => (
          <Link key={chapter.id} to={`/reader/${chapter.id}`} className="chapter-item" role="listitem">
            <div className="chapter-order">第 {chapter.order} 章</div>
            <div className="chapter-title">{chapter.title}</div>
          </Link>
        ))}
      </div>
    </section>
  );
};

export default BookDetailPage;
