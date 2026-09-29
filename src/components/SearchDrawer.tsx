import React, { useState, useMemo, useRef, useEffect } from "react";
import { X, Search, ChevronRight } from "lucide-react";
import { ChapterMeta } from "../types";
import { NO_CHAPTER, findChapterIndex } from "../utils/locator";

interface SearchDrawerProps {
  isOpen: boolean;
  fullText: string | null;
  chapters: ChapterMeta[];
  onClose: () => void;
  /**
   * 选中一条结果（需求 2.5）。
   *
   * 传出的是**全局**命中偏移与命中长度，换算成章内偏移由阅读器完成
   * （`charOffset = matchOffset - chapter.start`，design §3.5）——抽屉不必知道
   * 定位基准，也不必知道卷节点该怎么绕。
   *
   * `chapterId` 是章节表下标（`validate.py` 的不变量 1：id 即下标），由下面的
   * `findChapterIndex` 二分得出，阅读器直接拿它索引 `toc.chapters`。
   */
  onSelectResult: (chapterId: number, matchOffset: number, matchLength: number) => void;
}

interface SearchMatch {
  index: number;
  chapterId: number;
  chapterTitle: string;
  snippetBefore: string;
  matchedText: string;
  snippetAfter: string;
}

const MAX_RESULTS = 150; // Cap results for smooth UI

export const SearchDrawer: React.FC<SearchDrawerProps> = ({
  isOpen,
  fullText,
  chapters,
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

  // Full-text level transform: depends on fullText only, so switching books is the
  // only thing that re-runs it. Keystrokes must never pay this cost (需求 3.1:
  // 2053 万字 toLowerCase = 31ms + 39MB per call).
  const lowerText = useMemo(() => fullText?.toLowerCase() ?? "", [fullText]);

  const searchResults: SearchMatch[] = useMemo(() => {
    if (!fullText || !keyword.trim()) {
      return [];
    }

    const term = keyword.trim();
    const results: SearchMatch[] = [];
    let pos = 0;

    // Case-insensitive search over the pre-lowered text
    const lowerTerm = term.toLowerCase();

    while (pos < lowerText.length && results.length < MAX_RESULTS) {
      const matchIndex = lowerText.indexOf(lowerTerm, pos);
      if (matchIndex === -1) break;

      const chapterId = findChapterIndex(chapters, matchIndex);
      if (chapterId !== NO_CHAPTER) {
        const ch = chapters[chapterId];
        const snippetStart = Math.max(0, matchIndex - 24);
        const snippetEnd = Math.min(fullText.length, matchIndex + term.length + 30);

        results.push({
          index: matchIndex,
          chapterId,
          chapterTitle: ch.title,
          snippetBefore: fullText.slice(snippetStart, matchIndex).replace(/\s+/g, " "),
          matchedText: fullText.slice(matchIndex, matchIndex + term.length),
          snippetAfter: fullText.slice(matchIndex + term.length, snippetEnd).replace(/\s+/g, " "),
        });
      }

      pos = matchIndex + Math.max(1, term.length);
    }

    return results;
    // fullText 仅用于按原文大小写切取片段；它与 lowerText 同步变化，
    // 列入依赖不会带来额外的重算。
  }, [fullText, lowerText, keyword, chapters]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-40 flex">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/40 backdrop-blur-sm transition-opacity"
        onClick={onClose}
      />

      {/* Drawer */}
      <div className="relative w-80 sm:w-96 max-w-[85vw] h-full shadow-2xl flex flex-col z-50 transition-transform duration-300 bg-[var(--bg)] text-[var(--text)] border-r border-[var(--border)]">
        {/* Header */}
        <div className="p-4 border-b border-[var(--border)] flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <Search className="w-4 h-4 text-[var(--accent)]" />
            <h2 className="font-bold text-base">全书内容检索</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-[var(--hover)]"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Search Input */}
        <div className="p-3 border-b border-[var(--border)]">
          <div className="flex items-center px-3 py-2 rounded-xl border text-sm bg-[var(--card-bg)] border-[var(--border)]">
            <Search className="w-4 h-4 opacity-50 mr-2 shrink-0" />
            <input
              ref={inputRef}
              type="text"
              placeholder="输入关键词（角色、地点、台词...）"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              className="bg-transparent w-full focus:outline-none text-xs sm:text-sm text-[var(--text)]"
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
              {searchResults.length >= MAX_RESULTS && (
                <span className="text-[10px] text-amber-500">
                  仅展示前 {MAX_RESULTS} 处
                </span>
              )}
            </div>
          )}
        </div>

        {/* Results List */}
        <div className="flex-1 overflow-y-auto divide-y divide-[var(--border)] p-2">
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
                  // 命中长度取 `matchedText.length`（按原文大小写切出的那段），与被检索的
                  // 关键词长度相等，但无需依赖渲染时的 `keyword` 与结果列表同步。
                  onSelectResult(res.chapterId, res.index, res.matchedText.length);
                  onClose();
                }}
                className="w-full text-left p-3 rounded-xl hover:bg-[var(--hover)] transition-all group flex flex-col space-y-1.5"
              >
                {/* Chapter badge */}
                <div className="flex items-center justify-between text-[11px] font-semibold opacity-70 group-hover:opacity-100">
                  <span className="truncate pr-2">{res.chapterTitle}</span>
                  <ChevronRight className="w-3.5 h-3.5 opacity-40 group-hover:opacity-100 shrink-0" />
                </div>
                {/* Snippet */}
                <p className="text-xs leading-relaxed opacity-90 line-clamp-2">
                  <span>...{res.snippetBefore}</span>
                  {/* 命中底色是固定的琥珀色（不随主题走，五套主题下都读得清），
                      字色取主题强调色 */}
                  <mark className="px-0.5 rounded font-bold bg-[rgba(234,179,8,0.3)] text-[var(--accent)]">
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
