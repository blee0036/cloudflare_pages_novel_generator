import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  Search,
  BookOpen,
  Sparkles,
  AlertCircle,
  ChevronDown,
  User,
  X,
} from "lucide-react";
import { BooksCatalog, BookSummary, ReadingProgress } from "../types";
import { SEARCH_DEBOUNCE_MS, useDebouncedValue } from "../hooks/useDebouncedValue";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { SITE } from "../utils/site";
import { faviconHref } from "../utils/siteConfig";
import { SHELF_GRID_CLASS } from "../utils/shelfGrid";
import { buildSearchIndex, filterByAuthor, searchBooks } from "../utils/bookSearch";
import {
  readTocBookId,
  withTocBookId,
  withoutTocBookId,
} from "../utils/bookshelfUrl";
import {
  SHELF_LOAD_ERROR_TEXT,
  ShelfLoadErrorCategory,
  classifyLoadError,
  fetchJson,
  formatLoadErrorLog,
} from "../utils/loadError";
import { hasMore, nextPageCount, remainingCount, visibleCount } from "../utils/pagination";
import { RecentRead, buildRecentReads } from "../utils/recentReads";
import { getAllReadingHistory, getBookProgress } from "../utils/storage";
import { BookCard } from "../components/BookCard";
import { BookDetailModal } from "../components/BookDetailModal";
import { BookshelfSkeleton } from "../components/BookshelfSkeleton";
import { RecentReads } from "../components/RecentReads";

export const BookshelfPage: React.FC = () => {
  const navigate = useNavigate();
  /**
   * 书架的标题就是站点名（需求 9.3 后半句）。
   *
   * 这不是"从阅读器恢复回来"的补救动作，而是本页对自己标题的声明——从阅读器返回时
   * 恢复站点名只是它的一个自然结果，理由见 hooks/useDocumentTitle.ts。
   */
  useDocumentTitle();
  /**
   * 章节目录弹窗的开关状态存在 URL 里（需求 5.12，差异表 B8），不再是本地 state——
   * URL 形态与"为什么是查询参数而非 `/books/:id`"见 `utils/bookshelfUrl.ts`。
   */
  const [searchParams, setSearchParams] = useSearchParams();
  const [catalog, setCatalog] = useState<BooksCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  /**
   * 书架加载失败的类别（需求 13.7），`null` 表示没有失败。
   *
   * 存类别而不是 `err.message`：页面只显示类别对应的固定中文说明，原始异常只进控制台
   * （需求 13.8、13.10，F-012）。
   */
  const [error, setError] = useState<ShelfLoadErrorCategory | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  /**
   * 当前的作者筛选，`null` 表示没有筛选（需求 5.11）。
   *
   * 存作者名本身而不是书 id：筛选的语义是"作者的全部作品"，被点的那本书在结果里不特殊。
   * 不防抖——它不是连续输入，是一次点击。
   */
  const [authorFilter, setAuthorFilter] = useState<string | null>(null);
  const [progressMap, setProgressMap] = useState<Record<string, ReadingProgress | null>>({});
  /**
   * "最近阅读"的 5 行（需求 5.10）。和书目一起在 `fetchBooks` 里算好，而不是每次渲染重算：
   * 它要枚举 localStorage 的进度键（`getAllReadingHistory`），那是次 I/O，不是纯计算。
   */
  const [recentReads, setRecentReads] = useState<RecentRead[]>([]);

  /**
   * 书目加载的代次：每次 `fetchBooks` 开始时加 1，effect 清理（卸载、StrictMode 的
   * 装载→清理→装载）时也加 1。只有代次仍是自己的那次加载才写 state、打日志。
   *
   * 需求 13.10 要求每次显示 Shelf_Error_State 恰好打 1 条日志：开发环境下 StrictMode 会让
   * 首个 effect 发出两次请求，被清理掉的那一次若照常失败就会多打一条；连点"重新加载"时，
   * 先发出的那次也不该在后发的那次之后改写结果。
   */
  const loadGenerationRef = useRef(0);

  const fetchBooks = useCallback(async () => {
    const generation = ++loadGenerationRef.current;
    const isCurrent = () => loadGenerationRef.current === generation;
    setLoading(true);
    setError(null);
    try {
      /*
       * 404、2xx 但响应体不是 JSON（含 SPA 回退的 `index.html`）、其他非 2xx 与网络错误由
       * `fetchJson` 包装成三个错误类，分类见 `classifyLoadError`（需求 13.7）。
       */
      const data = await fetchJson<BooksCatalog>("/data/books.json");
      if (!isCurrent()) return;

      /*
       * 处理书目放在同一个 `try` 里、且先于任何 `setState`：响应体是 JSON 但不是书目
       * （例如 `{}`、`null`）时，这里抛出的未包装 `TypeError` 按需求 13.7 判为 `unknown`，
       * 而不会先把一份坏书目写进 `catalog` 再进失败态。
       */
      const pMap: Record<string, ReadingProgress | null> = {};
      data.books.forEach((b) => {
        pMap[b.id] = getBookProgress(b.id);
      });

      /*
       * 最近阅读的取数（需求 5.10，差异表 B5 / 缺陷 E6：`getAllReadingHistory()` 此前无人调用）。
       *
       * 不从上面那个 `pMap` 反推，尽管它手里已经有全部进度：`pMap` 只覆盖**书目里的书**，
       * 而按 `lastReadTime` 排序要的是全部记录；更要紧的是 `getAllReadingHistory()` 只读
       * 至多 50 个进度键（`MAX_PROGRESS_RECORDS`），比按 7000 本逐本取键便宜得多，顺带
       * 把排序也做完了。书名由 `buildRecentReads` 从 `data.books` 连接进来。
       */
      const recent = buildRecentReads(getAllReadingHistory(), data.books);

      setCatalog(data);
      setProgressMap(pMap);
      setRecentReads(recent);
    } catch (err) {
      if (!isCurrent()) return;
      // 原始异常只进控制台，恰好一行（需求 13.10）；页面只显示类别对应的固定说明（13.7、13.8）。
      console.error(formatLoadErrorLog("catalog", null, err));
      setError(classifyLoadError("catalog", err));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchBooks();
    return () => {
      // 作废进行中的那次加载：它的结果与失败日志都不再属于当前挂载。
      loadGenerationRef.current += 1;
    };
  }, [fetchBooks]);

  /* ---------------------------------------------------------------------------
   * 章节目录弹窗 ↔ URL（需求 5.12，差异表 B8）
   * ------------------------------------------------------------------------ */

  /** 当前 URL 指定的书籍 id，`null` 表示弹窗关闭。 */
  const tocBookId = readTocBookId(searchParams);

  /**
   * id → 书目条目。弹窗要的是"这本书的完整条目"，而 URL 里只有 id。
   *
   * 查的是**全部书目**而不是 `filteredBooks`：分享来的 `?book=` 不该受收件人书架上的
   * 检索词、作者筛选、翻到第几页影响——那本书大概率既不在首屏 50 本里、也不满足任何筛选，
   * 但链接必须照样打开它。这也是"弹窗状态在 URL、列表状态在本地"能各自独立的前提。
   */
  const booksById = useMemo(() => {
    const map = new Map<string, BookSummary>();
    for (const book of catalog?.books ?? []) {
      if (!map.has(book.id)) map.set(book.id, book);
    }
    return map;
  }, [catalog]);

  /**
   * 弹窗当前展示哪本书。**由 URL 推导，不另存一份 state**：两份状态就有两条不同步的路径，
   * 而浏览器后退只会改 URL 那一份。
   *
   * 书目还没加载完时是 `null`——弹窗自然等到 `books.json` 到位才打开（需求 5.12 的深链接
   * 场景），期间照常渲染骨架屏。
   */
  const selectedBookForToc = tocBookId ? booksById.get(tocBookId) ?? null : null;

  /**
   * 当前这个 `?book=` 条目是不是本会话里由"打开目录"**压进**历史的。
   *
   * 决定关闭弹窗时该怎么退（见 `closeToc`）：是我们压的就原路退回去，把那条历史项连同
   * 它的前进项一起消化掉；不是（分享链接直接落地、或刷新后的首个条目）就只能原地改写，
   * 因为那条目背后是读者来处，不是我们的书架。
   */
  const pushedTocEntryRef = useRef(false);

  // 参数没了（读者按了后退、或已被下面的清理改写），"这条是我们压的"随之失效。
  useEffect(() => {
    if (!tocBookId) pushedTocEntryRef.current = false;
  }, [tocBookId]);

  /**
   * URL 指向一本书目里没有的书：静默把参数摘掉。
   *
   * 会真实发生——预处理消歧改过 `book_id`（A18）、源包删了、链接在聊天软件里被截断。
   * 不弹错误：读者要的是书架，而摘掉参数之后他就在书架上了；留着参数则会在每次
   * `books.json` 重载后再试着打开一个不存在的弹窗。
   *
   * 用 `replace`：这条坏 URL 不值得在历史里占一格，否则读者按后退又会回到它。
   * `error` 时**不清**——那时书目是空的，任何 id 都查不到，而重试成功后弹窗还该打开。
   */
  useEffect(() => {
    if (loading || error || !catalog) return;
    if (!tocBookId || booksById.has(tocBookId)) return;
    setSearchParams((prev) => withoutTocBookId(prev), { replace: true });
  }, [loading, error, catalog, tocBookId, booksById, setSearchParams]);

  /**
   * 打开目录：**push** 一条 `?book=<id>`，于是浏览器后退键天然就是"关闭弹窗"——
   * 回到的上一条是同一条路由的书架（需求 5.12 的"不离开书架"），组件不卸载，
   * 检索词、作者筛选与已加载页数全都还在。
   */
  const openToc = useCallback(
    (book: BookSummary) => {
      pushedTocEntryRef.current = true;
      setSearchParams((prev) => withTocBookId(prev, book.id));
    },
    [setSearchParams],
  );

  /**
   * 关闭目录（X 按钮 / 点遮罩）。
   *
   * 是我们压进来的条目就走 `navigate(-1)`，效果与读者自己按后退完全一致——顺带把那条历史项
   * 消化掉，不会留下"关了弹窗却还能按前进把它叫回来"的悬空前进项，也不会因为再 push 一次
   * 干净 URL 而让后退键重新打开刚关掉的弹窗（那才是最难解释的一种）。
   *
   * 不是我们压的（分享链接直接落地、带参数刷新）则原地 `replace` 掉参数：此时后退会离开本站，
   * 拿它当"关闭弹窗"等于把读者送出去。这种首次落地的情形无法既关弹窗又留在书架——它的上一页
   * 本就不是书架，而伪造一条书架历史项是在劫持读者的后退键。
   */
  const closeToc = useCallback(() => {
    if (pushedTocEntryRef.current) {
      pushedTocEntryRef.current = false;
      navigate(-1);
      return;
    }
    setSearchParams((prev) => withoutTocBookId(prev), { replace: true });
  }, [navigate, setSearchParams]);

  /**
   * 检索串只随 `books.json` 变化，**不能依赖 `searchTerm`**（design §5）：拼串是每本书
   * 一次的活，放进随按键重跑的 memo 就是 design §6.1 那个"每次按键 toLowerCase 全文"
   * 的同类错误。
   */
  const searchIndex = useMemo(
    () => buildSearchIndex(catalog?.books ?? []),
    [catalog],
  );

  /**
   * 检索用的词是**防抖后**的（需求 5.7），输入框的 `searchTerm` 仍逐键即时回显——
   * 把受控值本身防抖会让光标在慢打字时跳字，需求要的只是"末次输入后 250ms 内给出结果"。
   */
  const activeQuery = useDebouncedValue(searchTerm, SEARCH_DEBOUNCE_MS);

  /**
   * 子序列模糊匹配 + 拼音首字母，按分数降序（需求 5.3–5.5），再套作者筛选（需求 5.11）。
   *
   * 两者是 AND：筛着某个作者时接着搜书名，收窄的是这个作者的作品。理由见
   * `filterByAuthor`——点作者名不清检索词，也就不会把读者刚打的字吞掉。
   */
  const filteredBooks = useMemo(
    () => filterByAuthor(searchBooks(searchIndex, activeQuery), authorFilter),
    [searchIndex, activeQuery, authorFilter],
  );

  /**
   * 分页窗口的失效键：任何**改变结果列表**的筛选条件都要并进这个串。
   *
   * 用 `\u0000` 分隔两段，而不是空格之类的可打印字符：否则检索"词 a" + 作者"b" 会和
   * 检索"词 a b" + 无筛选拼出同一个键，于是从前者切到后者时页数不重置，那一帧按新结果集
   * 挂满卡片——正是下面 `pagedListKey` 那段要避免的事。`\u0000` 进不了输入框，也不可能
   * 出现在作者名里。
   */
  const listKey = `${activeQuery}\u0000${authorFilter ?? ""}`;

  /** 已按了几次"继续加载"。记页数而非条数的理由见 `utils/pagination.ts`。 */
  const [pageCount, setPageCount] = useState(1);
  const [pagedListKey, setPagedListKey] = useState(listKey);

  /**
   * 换查询要回到首屏。
   *
   * 刻意在渲染期比对并重置（React 文档的"随 props 变化调整 state"），而不是塞进
   * `useEffect`：effect 要等这一帧提交之后才跑，于是"已加载到第 140 页 → 改查询"会先
   * 用旧页数提交一帧——那一帧按新结果集挂满 7000 张卡，正是 B3 要避免的事。
   */
  if (pagedListKey !== listKey) {
    setPagedListKey(listKey);
    setPageCount(1);
  }

  /**
   * 首屏只挂载一批 `PAGE_SIZE` 本（需求 5.8 / 差异表 B3；目标 50，对齐到网格列数后为 48）。
   *
   * 继续加载做成**按钮**而不是 IntersectionObserver 无限滚动：需求 5.8 只要求"提供继续
   * 加载机制"，而按钮是可聚焦、可用键盘触发的显式控件，读者也能知道列表到底还有多少；
   * 无限滚动要额外维护哨兵元素与观察器生命周期，还会和页脚、浏览器的滚动位置恢复互相打架
   * （返回书架时先恢复到旧 scrollTop，再由观察器连锁加载数批）。7000 本满打满算 139 次点击
   * 听着多，但那是"把整个库翻到底"的场景，真实路径是搜索收窄结果。
   */
  const visibleBooks = useMemo(
    () => filteredBooks.slice(0, visibleCount(filteredBooks.length, pageCount)),
    [filteredBooks, pageCount],
  );

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)] transition-colors">
      {/* Top Navbar */}
      <header className="sticky top-0 z-20 bg-[var(--card-bg)]/80 backdrop-blur-md border-b border-[var(--border)]">
        <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center space-x-2.5">
            {/* 顶栏图标就是站点 favicon（同一个配置值、同一个地址，浏览器只取一次）。
                alt 留空：右边紧挨着站名文字，图标对读屏软件是重复信息。 */}
            <img
              src={faviconHref(SITE.favicon)}
              alt=""
              width={36}
              height={36}
              className="w-9 h-9 shrink-0"
            />
            <div>
              {/* 顶栏品牌名同样取配置里的站点名（需求 9.2）：它与标签页标题、
                  `<meta>` 是同一个值，不该在这里再硬编码一份。 */}
              <span className="font-bold text-base tracking-tight block leading-tight">
                {SITE.name}
              </span>
              {/* 副标题与下方 Banner 的文案都来自 site.config.json，写成空串即不显示。 */}
              {SITE.tagline && (
                <span className="text-[10px] text-[var(--text-muted)] block leading-tight">
                  {SITE.tagline}
                </span>
              )}
            </div>
          </div>

          {/* Search bar */}
          <div className="relative w-48 sm:w-72">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
            <input
              type="text"
              placeholder="搜索书名、作者或拼音首字母..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              /* 底色用 --hover（前景色 8% 的叠加）而非 --card-bg：这条搜索框就在
                 --card-bg 的导航条上，同色会让它整个消失；原先 slate-100 在白色导航条上
                 也正是"比底色深一档"的关系，靠填充而非边框区分。 */
              className="w-full pl-9 pr-4 py-1.5 text-xs sm:text-sm rounded-xl bg-[var(--hover)] border border-transparent focus:border-[var(--accent)] focus:bg-[var(--bg)] focus:outline-none transition-all"
            />
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-6xl mx-auto px-4 py-8">
        {/* Banner */}
        <div className="mb-8 p-6 rounded-2xl bg-gradient-to-r from-blue-600 to-indigo-700 text-white shadow-lg shadow-blue-500/10 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            {SITE.banner.badge && (
              <div className="flex items-center space-x-2 mb-2">
                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-white/20 backdrop-blur-md">
                  <Sparkles className="w-3.5 h-3.5 mr-1" />
                  {SITE.banner.badge}
                </span>
              </div>
            )}
            <h1 className="text-xl sm:text-2xl font-extrabold tracking-tight">
              {SITE.banner.title}
            </h1>
            {SITE.banner.description && (
              <p className="text-xs sm:text-sm text-blue-100 mt-1 max-w-xl">
                {SITE.banner.description}
              </p>
            )}
          </div>
          <div className="shrink-0 bg-white/10 backdrop-blur-md px-5 py-3 rounded-xl border border-white/10 text-center sm:text-right">
            <div className="text-2xl font-black">{catalog?.count || 0}</div>
            <div className="text-xs text-blue-100">{SITE.banner.countLabel}</div>
          </div>
        </div>

        {/*
          最近阅读（需求 5.10）。位置在 Banner 之下、书格之上——需求要的是"首屏"，而书格
          是可以滚很长的那一块，续读入口排在它后面就不叫首屏了。

          **检索/筛选进行中时整块让位**（`!activeQuery && !authorFilter`）：需求 5.10 说的是
          首屏，而输入了检索词或点了作者名的书架已经不是首屏，是一个结果页。读者正在找某本书
          时，顶上钉着 5 行与查询无关的书只会把命中结果往下推——那正好抵掉需求 5.8 首屏只挂
          50 本的用意。作者筛选同理：它答的是"这个作者还写了什么"，最近读的 5 本多半不在其中。
          用落定的 `activeQuery` 而不是 `searchTerm`，与下面"未找到"的文案同一个口径，
          免得区块在打字途中闪一下。

          `loading` / `error` 时也不渲染：重试（点"重新加载"）会把 `loading` 重新置真，
          而此时 `recentReads` 还是上一轮的值，不拦就会出现"骨架屏上方顶着 5 行旧数据"。
        */}
        {!loading && !error && !activeQuery && !authorFilter && (
          <RecentReads
            items={recentReads}
            /* 裸 `/read/<id>`，**不带 `?ch=`**：阅读器只在 URL 没有章号时才恢复记录里的
               章内偏移，带上章号反而会被当成显式整章跳转、把偏移归零（见 RecentReads 注释）。 */
            onResume={(bookId) => navigate(`/read/${encodeURIComponent(bookId)}`)}
          />
        )}

        {/*
          作者筛选的状态条与清除入口（需求 5.11 后半句）。

          刻意放在三种内容态（骨架/错误/空结果）**之外**：清除按钮必须在结果为空时也够得着，
          否则"作者 A + 检索词 zzz"会把读者关在一个空列表里，唯一的出路是自己去清搜索框，
          而那甚至不是造成空结果的那个条件。

          条形而非弹窗/侧栏：当前只有一个筛选维度，一行字加一枚按钮就说完了。
          `loading`/`error` 时不渲染，与上面最近阅读同一个理由——那时 `filteredBooks` 的
          计数还是上一轮的值。
        */}
        {!loading && !error && authorFilter && (
          <div className="mb-6 flex flex-wrap items-center gap-2 text-xs">
            <span className="text-[var(--text-muted)]">正在查看作者</span>
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[var(--accent)]/10 border border-[var(--accent)]/20 text-[var(--accent)] font-semibold max-w-[16rem]">
              <User className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">{authorFilter}</span>
            </span>
            {/* 只把**会变的那个数**做成 live region（筛着作者再改检索词时它会动），
                与下方"已显示 X / Y 本"同一个口径；整条 bar 挂 aria-live 会把
                "清除筛选"这枚按钮的文字一起念出来。 */}
            <span className="text-[var(--text-muted)]" aria-live="polite">
              共 {filteredBooks.length} 本
            </span>
            <button
              type="button"
              onClick={() => setAuthorFilter(null)}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full font-semibold border border-[var(--border)] hover:bg-[var(--hover)] focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] transition-colors"
            >
              <X className="w-3.5 h-3.5" />
              清除筛选
            </button>
          </div>
        )}

        {/* Content States */}
        {loading ? (
          /* 骨架占位替代原先的居中 spinner（需求 5.9，差异表 B4）：网格类与卡片盒子
             跟下面真列表逐项对齐，数据到位时不发生纵向跳动。 */
          <BookshelfSkeleton />
        ) : error ? (
          <div className="py-16 text-center max-w-md mx-auto">
            <AlertCircle className="w-10 h-10 text-rose-500 mx-auto mb-3" />
            <h3 className="font-semibold text-base mb-1">加载遇到问题</h3>
            {/* 只显示类别对应的固定说明（需求 13.7、13.8），不再是 `err.message`——
                那里面的英文异常与"请确保已执行 npm run preprocess"是给站主看的（F-012）。
                标题与"重新加载"按钮不变（需求 13.9）。 */}
            <p className="text-xs text-[var(--text-muted)] mb-4">{SHELF_LOAD_ERROR_TEXT[error]}</p>
            <button
              onClick={() => void fetchBooks()}
              className="px-4 py-2 bg-blue-600 text-white rounded-xl text-xs font-semibold hover:bg-blue-700 transition-colors shadow-sm"
            >
              重新加载
            </button>
          </div>
        ) : filteredBooks.length === 0 ? (
          <div className="py-20 text-center text-[var(--text-muted)]">
            <BookOpen className="w-12 h-12 mx-auto mb-2 opacity-30" />
            {/* 文案用落定的词而非 `searchTerm`：否则打字途中会出现"未找到与『青石』相关"
                这种与当前结果不同步的提示。
                筛着作者时要点明是两个条件的交集为空——按作者精确相等筛出来的结果不可能为空
                （至少含被点的那本），所以走到这里必定是检索词把它清空的，得让读者知道该动哪个。 */}
            <p className="text-sm">
              {authorFilter
                ? `「${authorFilter}」的作品里没有与 "${activeQuery}" 相关的书籍`
                : `未找到与 "${activeQuery}" 相关的书籍`}
            </p>
          </div>
        ) : (
          <>
            {/* 网格类与 PAGE_SIZE 的对齐同源（shelfGrid.ts），每批都是整行。 */}
            <div className={SHELF_GRID_CLASS}>
              {visibleBooks.map((book) => (
                <BookCard
                  key={book.id}
                  book={book}
                  progress={progressMap[book.id]}
                  onRead={(bookId) => navigate(`/read/${encodeURIComponent(bookId)}`)}
                  /* 打开目录 = 往 URL 压一条 `?book=`（需求 5.12），不再是本地 state。 */
                  onOpenToc={openToc}
                  /* 点作者名即筛选（需求 5.11）。不清检索词也不动滚动位置：页数由
                     `listKey` 变化自动回到首屏，结果条数与清除入口都在上方那条状态条里。 */
                  onFilterByAuthor={setAuthorFilter}
                />
              ))}
            </div>

            {hasMore(filteredBooks.length, pageCount) && (
              <div className="mt-10 flex flex-col items-center gap-2">
                <button
                  type="button"
                  onClick={() =>
                    setPageCount((prev) => nextPageCount(filteredBooks.length, prev))
                  }
                  className="inline-flex items-center px-5 py-2.5 rounded-xl text-xs font-semibold bg-[var(--card-bg)] border border-[var(--border)] hover:bg-[var(--hover)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)] transition-colors shadow-sm"
                >
                  <ChevronDown className="w-4 h-4 mr-1.5" />
                  继续加载（还有 {remainingCount(filteredBooks.length, pageCount)} 本）
                </button>
                <p className="text-[11px] text-[var(--text-muted)]" aria-live="polite">
                  已显示 {visibleBooks.length} / {filteredBooks.length} 本
                </p>
              </div>
            )}
          </>
        )}
      </main>

      {/*
        章节目录弹窗（需求 5.12）。开关两端都接在 URL 上：`book` 由 `?book=` 推导，
        关闭走 `closeToc`。渲染位置与条件都没变——它在 `<main>` 之外、`fixed` 覆盖全屏。
      */}
      <BookDetailModal
        book={selectedBookForToc}
        progress={selectedBookForToc ? progressMap[selectedBookForToc.id] : null}
        isOpen={Boolean(selectedBookForToc)}
        onClose={closeToc}
        /*
          进阅读器是普通 push，**不替换**那条 `?book=` 历史项：URL 里既然认了弹窗是一个可
          导航的状态，从它进阅读器就该和任何页面跳转一样，后退回到章节目录（旧版 `/books/:id`
          正是这个行为，B8 要保的就是它）——读者挑了第 5 章读完想接着挑第 6 章，后退即回到网格。
          此处不必再关弹窗：跳的是另一条路由，书架整棵子树卸载。
        */
        onSelectChapter={(bookId, chapterId) => {
          navigate(`/read/${encodeURIComponent(bookId)}?ch=${chapterId}`);
        }}
      />
    </div>
  );
};
