import React, {
  useState,
  useMemo,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";
import { X, Search, BookOpen, Bookmark as BookmarkIcon, Trash2 } from "lucide-react";
import { ChapterMeta, Bookmark } from "../types";
import { getBookmarks, removeBookmark } from "../utils/storage";
import {
  ROW_HEIGHT,
  centerScrollTop,
  computeWindow,
} from "../utils/listWindow";

interface NavigationDrawerProps {
  isOpen: boolean;
  bookId: string;
  bookTitle: string;
  author: string;
  /** 全部节点，含卷节点——目录里要看得见（需求 12.2）。 */
  chapters: ChapterMeta[];
  /**
   * 正文章节数，用于所有对读者显示的计数（需求 12.4）。
   *
   * 不等于 `chapters.length`：后者含卷节点，书里有几个卷，两者就差几。
   * 由 `ReaderPage` 的 `chapterViews` 传入而不是在这里 `filter(!isVolume)`，是为了让
   * 正文口径只有一个来源——抽屉自己数一遍，就多一处会与滑杆、上下章按钮走散的地方。
   */
  contentTotal: number;
  currentChapterId: number;
  onClose: () => void;
  /** 目录点击：整章跳转，落在章首（偏移 0）。 */
  onSelectChapter: (chapterId: number) => void;
  /**
   * 书签点击：带上记录里的**章内字符偏移**（需求 2.6）。
   *
   * 不复用 `onSelectChapter`——那条路径只认章号，书签走它就只能回到章首，精确位置白存了。
   * 形状与 `SearchDrawer` 的 `onSelectResult` 一致（章号 + 偏移），阅读器侧两者都收敛到
   * 同一个 `JumpTarget` 入口（design §3.5）。
   */
  onSelectBookmark: (chapterId: number, charOffset: number) => void;
}

export const NavigationDrawer: React.FC<NavigationDrawerProps> = ({
  isOpen,
  bookId,
  bookTitle,
  author,
  chapters,
  contentTotal,
  currentChapterId,
  onClose,
  onSelectChapter,
  onSelectBookmark,
}) => {
  const [activeTab, setActiveTab] = useState<"toc" | "bookmark">("toc");
  const [keyword, setKeyword] = useState("");
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);

  // 窗口化状态（design §6.2）：只有这两个数决定挂载哪些行。
  const listRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(0);
  const rafRef = useRef(0);
  const pendingTopRef = useRef(0);

  // Refresh bookmarks when opening or tab changes
  useEffect(() => {
    if (isOpen) {
      setBookmarks(getBookmarks(bookId));
    }
  }, [isOpen, bookId, activeTab]);

  /**
   * 目录列表的数据源。
   *
   * 无检索词时遍历**原始** `chapters`：卷节点要在目录里看得见（需求 12.2），这是它与
   * 导航/计数（走 `contentIdx` 双视图，任务 37/39）唯一不同的地方。
   *
   * 有检索词时只留正文章节：卷节点点不动，留在结果里就是一行点不动的死行；而它名下的
   * 同卷章节大多已被过滤掉，"分组表头"本身也不再成立。检索态下这个列表的每一项都是
   * 可跳转的目标，于是"有结果但没有一项能点"的状态不会出现。
   */
  const filteredChapters = useMemo(() => {
    if (!keyword.trim()) return chapters;
    const lower = keyword.toLowerCase();
    return chapters.filter(
      (c) => !c.isVolume && c.title.toLowerCase().includes(lower),
    );
  }, [chapters, keyword]);

  const total = filteredChapters.length;

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

  useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  // 视口高度：抽屉高度随窗口变化（手机旋屏、桌面拖拽），用 ResizeObserver 跟住。
  useEffect(() => {
    const el = listRef.current;
    if (!isOpen || activeTab !== "toc" || !el) return;

    setViewH(el.clientHeight);
    if (typeof ResizeObserver === "undefined") return;

    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [isOpen, activeTab]);

  // 当前章定位：直接算 scrollTop 落位，不用 scrollIntoView——窗口化之后当前章那一行
  // 很可能不在 DOM 里，没有元素可滚（design §6.2）。
  // 过滤词变化时 `filteredChapters` 会换引用，于是这里顺带重新定位：当前章仍在结果里就
  // 居中它，被过滤掉了就回到顶部。
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!isOpen || activeTab !== "toc" || !el) return;

    const h = el.clientHeight;
    setViewH(h);

    const idx = filteredChapters.findIndex((c) => c.id === currentChapterId);
    const next =
      idx < 0 ? 0 : centerScrollTop(idx, h, filteredChapters.length);

    el.scrollTop = next;
    setScrollTop(next);
  }, [isOpen, activeTab, currentChapterId, filteredChapters]);

  const { start, end } = useMemo(
    () => computeWindow(scrollTop, viewH, total),
    [scrollTop, viewH, total],
  );

  const handleDeleteBookmark = (bmId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    removeBookmark(bookId, bmId);
    setBookmarks(getBookmarks(bookId));
  };

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
        <div className="p-4 border-b border-[var(--border)] flex items-start justify-between">
          <div>
            <div className="flex items-center space-x-2">
              <BookOpen className="w-4 h-4 text-[var(--accent)]" />
              <h2 className="font-bold text-base line-clamp-1">{bookTitle}</h2>
            </div>
            <p className="text-xs text-[var(--text-muted)] mt-1">
              作者: {author} · 共 {contentTotal} 章
            </p>
          </div>
          {/* 只含图标的按钮：名称由 `aria-label` 给出，`title` 同文作悬停提示（F-009，需求 11.1） */}
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-[var(--hover)]"
            aria-label="关闭目录"
            title="关闭目录"
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        {/* Tab Switcher (Koodo Style) */}
        <div className="grid grid-cols-2 p-1.5 border-b gap-1 text-xs font-medium border-[var(--border)] bg-[var(--card-bg)]">
          <button
            onClick={() => setActiveTab("toc")}
            className={`py-1.5 rounded-lg transition-all flex items-center justify-center space-x-1.5 ${
              activeTab === "toc"
                ? /* 选中页签浮在 --card-bg 的切换条上，故底色取 --bg：与原先"白底
                     卡片 + 深色主题下 slate-700"同一个意思——比容器亮一档 */
                  "bg-[var(--bg)] shadow text-[var(--accent)] font-bold"
                : /* 未选中页签：不透明的 `--text-muted` 取代 `opacity-60`（F-010），
                     悬停时提到 `--text`，与原先 60% → 100% 的反馈同义 */
                  "text-[var(--text-muted)] hover:text-[var(--text)]"
            }`}
          >
            <BookOpen className="w-3.5 h-3.5" />
            <span>章节目录 ({contentTotal})</span>
          </button>

          <button
            onClick={() => setActiveTab("bookmark")}
            className={`py-1.5 rounded-lg transition-all flex items-center justify-center space-x-1.5 ${
              activeTab === "bookmark"
                ? "bg-[var(--bg)] shadow text-[var(--accent)] font-bold"
                : "text-[var(--text-muted)] hover:text-[var(--text)]"
            }`}
          >
            <BookmarkIcon className="w-3.5 h-3.5" />
            <span>我的书签 ({bookmarks.length})</span>
          </button>
        </div>

        {/* TOC Content */}
        {activeTab === "toc" && (
          <>
            {/* Search */}
            <div className="p-3 border-b border-[var(--border)]">
              <div className="flex items-center px-3 py-1.5 rounded-lg border text-sm bg-[var(--card-bg)] border-[var(--border)]">
                <Search className="w-4 h-4 opacity-50 mr-2 shrink-0" />
                <input
                  type="text"
                  placeholder="搜索章节名..."
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                  className="bg-transparent w-full focus:outline-none text-xs sm:text-sm text-[var(--text)]"
                />
                {keyword && (
                  <button
                    onClick={() => setKeyword("")}
                    className="text-xs text-[var(--text-muted)] hover:text-[var(--text)]"
                  >
                    清除
                  </button>
                )}
              </div>
            </div>

            {/*
              Chapter List（窗口化，design §6.2）
              - 容器不加纵向 padding：任何额外偏移都会让 `scrollTop → 行号` 的换算错位。
              - 分隔线从容器的 divide-y 挪到每行的 border-b，否则两个 spacer 也会被算作
                子元素而画出多余的线。
            */}
            <div
              ref={listRef}
              onScroll={handleScroll}
              className="flex-1 overflow-y-auto"
            >
              {total === 0 ? (
                <div className="p-8 text-center text-xs text-[var(--text-muted)]">
                  未找到匹配的章节
                </div>
              ) : (
                <>
                  <div style={{ height: start * ROW_HEIGHT }} aria-hidden />
                  {filteredChapters.slice(start, end).map((chap, i) => {
                    const isActive = chap.id === currentChapterId;
                    // 末行不画分隔线，与原先 divide-y 的观感保持一致
                    const isLast = start + i === total - 1;
                    const divider = isLast
                      ? ""
                      : "border-b border-[var(--border)]";

                    /*
                      卷节点：不可点击的分组表头（需求 12.2）。

                      - 用 `<h3>` 而不是 `<button disabled>`：它不是一个"暂时不能点的
                        条目"，而是一条分组标注。非交互元素也就自然不进 Tab 序列。
                      - 行高仍是 `ROW_HEIGHT`，且照旧单行截断：`scrollTop → 行号` 的换算
                        建立在"每行等高"之上，表头一旦更高或能折行，窗口区间与当前章居中
                        就会整体错位（design §6.2）。
                      - 不用 `position: sticky`：窗口化之后这一行滚出挂载区间就被卸载，
                        粘不住，只会在滚动中闪现。
                      - 不显示字数：卷节点的 length 只是它自己标题行的长度，摆出来是噪声。
                    */
                    if (chap.isVolume) {
                      return (
                        <h3
                          key={chap.id}
                          title={chap.title}
                          className={`px-4 flex items-center text-[11px] font-bold tracking-wider bg-[var(--card-bg)] text-[var(--text)] ${divider}`}
                          // 行高仍是唯一留在行内样式里的东西：它是窗口化换算的参数
                          // （`ROW_HEIGHT`），不是配色，与主题无关。
                          style={{ height: ROW_HEIGHT }}
                        >
                          <span
                            className="w-0.5 h-3.5 mr-2 rounded-full shrink-0 bg-[var(--accent)]"
                            aria-hidden
                          />
                          <span className="truncate text-[var(--text-muted)]">
                            {chap.title}
                          </span>
                        </h3>
                      );
                    }

                    return (
                      <button
                        key={chap.id}
                        onClick={() => {
                          onSelectChapter(chap.id);
                          onClose();
                        }}
                        aria-current={isActive ? "true" : undefined}
                        /* 未选中行的 `hover:bg-[var(--hover)]` 从这一步起才真正生效：
                           行内 `backgroundColor: "transparent"` 此前无条件压过它（行内样式
                           胜过任何非 !important 的类），悬停一直没有反馈。删掉行内样式后
                           这个类回到它本来该有的作用，与书架、书签列表的行为一致。
                           当前行底色取 `--selected`（`--accent` 15% 混 `--bg`）而不是
                           `--card-bg`：后者是卷标题的底色，两者相同就分不清"卷标题"与
                           "当前章"（F-007，需求 9.1）。`shadow-inner` 随之去掉。
                           未选中行原先是 `--text` 加 `opacity-80`，改为不透明的 `--text-muted`
                           （F-010）；悬停反馈由 `hover:bg-[var(--hover)]` 承担。 */
                        className={`w-full text-left px-4 text-xs sm:text-sm flex items-center justify-between transition-colors ${divider} ${
                          isActive
                            ? "font-semibold bg-[var(--selected)] text-[var(--accent)]"
                            : "bg-transparent text-[var(--text-muted)] hover:bg-[var(--hover)]"
                        }`}
                        style={{ height: ROW_HEIGHT }}
                      >
                        <span className="truncate pr-2">{chap.title}</span>
                        {/* 字数沿用所在行的字色（原先再叠 `opacity-40`，五套主题下都不足 4.5:1）：
                            未选中行是 `--text-muted`，当前行是 `--accent`。当前行不改用
                            `--text-muted`——它在 `--selected` 上 sepia 只有 4.25:1，而 `--accent`
                            对 `--selected` ≥ 4.5:1 由 `palette.test.ts` 核对。 */}
                        <span className="text-[10px] shrink-0">
                          {chap.length ? `${chap.length}字` : ""}
                        </span>
                      </button>
                    );
                  })}
                  <div
                    style={{ height: Math.max(0, (total - end) * ROW_HEIGHT) }}
                    aria-hidden
                  />
                </>
              )}
            </div>
          </>
        )}

        {/* Bookmarks Tab Content */}
        {activeTab === "bookmark" && (
          <div className="flex-1 overflow-y-auto p-3 divide-y divide-[var(--border)]">
            {bookmarks.length === 0 ? (
              <div className="py-24 text-center text-[var(--text-muted)] text-xs px-6">
                暂无书签。在阅读页面点击右上角书签图标即可随时记录精彩位置
              </div>
            ) : (
              bookmarks.map((bm) => (
                <div
                  key={bm.id}
                  /* 带偏移跳转：回到按下书签时那一段，而不是该章章首（需求 2.6）。
                     偏移的归一（卷节点、越界、v1 记录的 0）一律由阅读器侧的
                     `resolveJumpTarget` 负责，抽屉只负责把记录原样交出去。 */
                  onClick={() => {
                    onSelectBookmark(bm.chapterId, bm.charOffset);
                    onClose();
                  }}
                  className="py-3 px-2 rounded-xl hover:bg-[var(--hover)] transition-colors cursor-pointer group flex items-start justify-between space-x-2"
                >
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-xs truncate flex items-center space-x-1.5">
                      <BookmarkIcon className="w-3 h-3 text-amber-500 fill-current shrink-0" />
                      <span className="truncate">{bm.chapterTitle}</span>
                    </div>
                    {bm.previewText && (
                      <p className="text-[11px] text-[var(--text-muted)] line-clamp-2 mt-1 leading-relaxed">
                        {bm.previewText}
                      </p>
                    )}
                    <span className="text-[9px] text-[var(--text-muted)] mt-1 block">
                      {new Date(bm.createdAt).toLocaleDateString()} {new Date(bm.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>

                  <button
                    onClick={(e) => handleDeleteBookmark(bm.id, e)}
                    className="p-1 text-[var(--text-muted)] hover:text-rose-500 transition-colors opacity-0 group-hover:opacity-100 shrink-0"
                    title="删除此书签"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
};
