import { Navigate, Route, Routes } from "react-router-dom";
import { AppHeader } from "./components/AppHeader";
import HomePage from "./pages/HomePage";
import SimpleBookDetailPage from "./pages/SimpleBookDetailPage";
import { SimpleReaderPage } from "./pages/SimpleReaderPage";
import NotFoundPage from "./pages/NotFoundPage";

const App: React.FC = () => {
  return (
    <div className="app-shell">
      <AppHeader />
      <main className="app-main">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/books/:bookId" element={<SimpleBookDetailPage />} />
          <Route path="/reader/:bookId" element={<SimpleReaderPage />} />
          <Route path="/404" element={<NotFoundPage />} />
          <Route path="*" element={<Navigate to="/404" replace />} />
        </Routes>
      </main>
    </div>
  );
};

export default App;
