import React, { useState, useMemo, useRef, useEffect } from "react";
import { X, Search, ChevronRight, Hash } from "lucide-react";
import { ChapterMeta } from "../types";
import { ThemeConfig } from "../utils/storage";

interface SearchDrawerProps {
  isOpen: boolean;
  fullText: string | null;
  chapters: ChapterMeta[];
  theme: ThemeConfig;
  onClose: () => void;
  onSelectResult: (chapterId: number, matchOffset: number) => void;
}

interface SearchMatch {
  index: number;
  chapterId: number;
  chapterTitle: string;
  snippetBefore: string;
  matchedText: string;
  snippetAfter: string;
}

export const SearchDrawer: React.FC<SearchDrawerProps> = ({
  isOpen,
  fullText,
  chapters,
  theme,
  onClose,
  onSelectResult,
}) => {
  const [keyword, setKeyword] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 150);
    }
  }, [isOpen]);

  // Binary search to find which chapter a character offset belongs to
  const findChapterForOffset = (offset: number): ChapterMeta | null => {
    let low = 0;
    let high = chapters.length - 1;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const ch = chapters[mid];
      if (offset >= ch.start && offset < ch.end) {
        return ch;
      } else if (offset < ch.start) {
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }
    return null;
  };

  const searchResults: SearchMatch[] = useMemo(() => {
    if (!fullText || !keyword.trim() || keyword.trim().length < 1) {
      return [];
    }

    const term = keyword.trim();
    const results: SearchMatch[] = [];
    const maxResults = 150; // Cap to 150 results for smooth UI
    let pos = 0;

    // Case-insensitive search
    const lowerText = fullText.toLowerCase();
    const lowerTerm = term.toLowerCase();

    while (pos < lowerText.length && results.length < maxResults) {
      const matchIndex = lowerText.indexOf(lowerTerm, pos);
      if (matchIndex === -1) break;

      const ch = findChapterForOffset(matchIndex);
      if (ch) {
        const snippetStart = Math.max(0, matchIndex - 24);
        const snippetEnd = Math.min(fullText.length, matchIndex + term.length + 30);

        results.push({
          index: matchIndex,
          chapterId: ch.id,
          chapterTitle: ch.title,
          snippetBefore: fullText.slice(snippetStart, matchIndex).replace(/\s+/g, " "),
          matchedText: fullText.slice(matchIndex, matchIndex + term.length),
          snippetAfter: fullText.slice(matchIndex + term.length, snippetEnd).replace(/\s+/g, " "),
        });
      }

      pos = matchIndex + Math.max(1, term.length);
    }

    return results;
  }, [fullText, keyword, chapters]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-40 flex">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/40 backdrop-blur-sm transition-opacity"
        onClick={onClose}
      />

      {/* Drawer */}
      <div
        className="relative w-80 sm:w-96 max-w-[85vw] h-full shadow-2xl flex flex-col z-50 transition-transform duration-300"
        style={{
          backgroundColor: theme.bg,
          color: theme.text,
          borderRight: `1px solid ${theme.border}`,
        }}
      >
        {/* Header */}
        <div
          className="p-4 border-b flex items-center justify-between"
          style={{ borderColor: theme.border }}
        >
          <div className="flex items-center space-x-2">
            <Search className="w-4 h-4" style={{ color: theme.accent }} />
            <h2 className="font-bold text-base">全书内容检索</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-black/5 dark:hover:bg-white/10"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Search Input */}
        <div className="p-3 border-b" style={{ borderColor: theme.border }}>
          <div
            className="flex items-center px-3 py-2 rounded-xl border text-sm"
            style={{
              backgroundColor: theme.cardBg,
              borderColor: theme.border,
            }}
          >
            <Search className="w-4 h-4 opacity-50 mr-2 shrink-0" />
            <input
              ref={inputRef}
              type="text"
              placeholder="输入关键词（角色、地点、台词...）"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              className="bg-transparent w-full focus:outline-none text-xs sm:text-sm"
              style={{ color: theme.text }}
            />
            {keyword && (
              <button
                onClick={() => setKeyword("")}
                className="text-xs opacity-50 hover:opacity-100 shrink-0 ml-1"
              >
                清除
              </button>
            )}
          </div>
          {keyword && (
            <div className="mt-2 text-xs opacity-60 flex items-center justify-between px-1">
              <span>找到 {searchResults.length} 条匹配</span>
              {searchResults.length >= 150 && (
                <span className="text-[10px] text-amber-500">仅展示前 150 处</span>
              )}
            </div>
          )}
        </div>

        {/* Results List */}
        <div className="flex-1 overflow-y-auto divide-y divide-black/5 dark:divide-white/5 p-2">
          {!keyword.trim() ? (
            <div className="py-20 text-center opacity-40 text-xs px-6">
              输入关键词即可在整本小说几百万字中毫秒级全文检索
            </div>
          ) : searchResults.length === 0 ? (
            <div className="py-20 text-center opacity-50 text-xs">
              未在全书中找到与 "{keyword}" 相关的内容
            </div>
          ) : (
            searchResults.map((res, i) => (
              <button
                key={i}
                onClick={() => {
                  onSelectResult(res.chapterId, res.index);
                  onClose();
                }}
                className="w-full text-left p-3 rounded-xl hover:bg-black/5 dark:hover:bg-white/5 transition-all group flex flex-col space-y-1.5"
              >
                {/* Chapter badge */}
                <div className="flex items-center justify-between text-[11px] font-semibold opacity-70 group-hover:opacity-100">
                  <span className="truncate pr-2">{res.chapterTitle}</span>
                  <ChevronRight className="w-3.5 h-3.5 opacity-40 group-hover:opacity-100 shrink-0" />
                </div>
                {/* Snippet */}
                <p className="text-xs leading-relaxed opacity-90 line-clamp-2">
                  <span>...{res.snippetBefore}</span>
                  <mark
                    className="px-0.5 rounded font-bold"
                    style={{
                      backgroundColor: "rgba(234, 179, 8, 0.3)",
                      color: theme.accent,
                    }}
                  >
                    {res.matchedText}
                  </mark>
                  <span>{res.snippetAfter}...</span>
                </p>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
};
