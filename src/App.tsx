import React from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { BookshelfPage } from "./pages/BookshelfPage";
import { ReaderPage } from "./pages/ReaderPage";

export const App: React.FC = () => {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<BookshelfPage />} />
        <Route path="/read/:bookId" element={<ReaderPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
};

export default App;
