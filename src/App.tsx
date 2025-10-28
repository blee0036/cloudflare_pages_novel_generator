import { Navigate, Route, Routes } from "react-router-dom";
import { AppHeader } from "./components/AppHeader";
import HomePage from "./pages/HomePage";
import BookDetailPage from "./pages/BookDetailPage";
import ReaderPage from "./pages/ReaderPage";
import NotFoundPage from "./pages/NotFoundPage";

const App: React.FC = () => {
  return (
    <div className="app-shell">
      <AppHeader />
      <main className="app-main">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/books/:bookId" element={<BookDetailPage />} />
          <Route path="/reader/:chapterId" element={<ReaderPage />} />
          <Route path="/404" element={<NotFoundPage />} />
          <Route path="*" element={<Navigate to="/404" replace />} />
        </Routes>
      </main>
    </div>
  );
};

export default App;
