import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  AlertCircle,
  List,
  Search,
} from "lucide-react";
import { BookToc } from "../types";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useReadingPosition } from "../hooks/useReadingPosition";
import { useChapterUrlRefs, useChapterUrlSync } from "../hooks/useChapterUrlSync";
import { useBoundaryNotice } from "../hooks/useBoundaryNotice";
import {
  getStoredSettings,
  saveStoredSettings,
  isChapterBookmarked,
  addBookmark,
  removeBookmark,
  getBookmarks,
} from "../utils/storage";
import { loadGzipBookText } from "../utils/decompress";
import { INDETERMINATE, LoadProgress, sameLoadProgress } from "../utils/loadProgress";
import {
  JumpTarget,
  NO_CONTENT_CHAPTER,
  bodyParagraphs,
  buildChapterViews,
  contentChapterAt,
  contentPositionOf,
  previewAt,
  resolveJumpTarget,
  splitParagraphs,
  stepContentChapter,
  txtUrl,
} from "../utils/locator";
import { preventsDefault, readerAction } from "../utils/shortcuts";
import { renderFamilyOf } from "../utils/pageAnim";
import { KEY_GATE_IDLE, keyGateStep, type KeyGate } from "../utils/turnInput";
import { loadToc } from "../utils/tocCache";
import {
  LoadErrorCategory,
  LoadStage,
  READER_LOAD_ERROR_TEXT,
  classifyLoadError,
  formatLoadErrorLog,
} from "../utils/loadError";
import { bookTxtFileName, downloadBookAsTxt } from "../utils/download";
import { applyTheme } from "../utils/theme";
import { Header } from "../components/Header";
import { NavigationDrawer } from "../components/NavigationDrawer";
import { SettingDrawer } from "../components/SettingDrawer";
import { SearchDrawer } from "../components/SearchDrawer";
import { BoundaryNotice } from "../components/reader/BoundaryNotice";
import { PageNumberBadge } from "../components/reader/PageNumberBadge";
import { PagedReader } from "../components/reader/PagedReader";
import { ScrollReader } from "../components/reader/ScrollReader";
import type {
  HighlightTarget,
  NavRequest,
  PageInfo,
  ReaderViewHandle,
  TurnDirection,
} from "../components/reader/types";

/**
 * 检索命中高亮的存活时长（需求 2.5 的"临时高亮"、design §3.6）。
 *
 * 5 秒够读者的眼睛找到那一句，又不会一直留在正文里干扰后续阅读。另一条清除路径是
 * "下一次导航"，两者谁先到都算。
 */
const HIGHLIGHT_MS = 5000;

/**
 * 书签预览文本的截取长度（design §2.4 的 `previewText`）。
 *
 * 抽屉里那一栏是 `line-clamp-2`，两行放不下这么多字；留出余量是为了让"读到哪"看得清，
 * 同时不把整段正文抄进 localStorage——每章至多一个书签，但一本长书仍可能有上千条。
 */
const BOOKMARK_PREVIEW_LENGTH = 100;

/**
 * `nav` 的初值：`seq = 0` 是占位，不是一条指令——消费方以"`seq` 与上次消费的不同"认新指令，
 * 而上次消费的初值也是 0。第一条真正的指令（`seq = 1`）由首次定位下发（`onInitialPosition`）。
 */
const NO_NAV: NavRequest = { seq: 0, chapterId: 0, charOffset: 0 };

export const ReaderPage: React.FC = () => {
  const { bookId } = useParams<{ bookId: string }>();
  const navigate = useNavigate();

  // Settings & Theme
  const [settings, setSettings] = useState(getStoredSettings());

  /**
   * 把当前主题同步到 `<html data-theme>`（需求 6.1/6.2，design §7.1）。
   *
   * 这是本页与主题配色的**唯一**接触点：写下这个属性之后，配色全部由
   * `src/index.css` 的变量块接管。页面自己不持有任何颜色值，也不再把
   * `ThemeConfig` 往四个子组件里传（任务 44，需求 6.5）。
   *
   * 首屏那次由 `main.tsx` 的 `initTheme()` 负责，这里管的是运行时切换：设置抽屉改了
   * 主题后，根元素上的属性随之更新。**没有卸载时的清理**——返回书架时属性要留着，
   * 书架跟随阅读主题正是需求 6.2 想要的效果。
   */
  useEffect(() => {
    applyTheme(settings.theme);
  }, [settings.theme]);

  /**
   * 当前翻页模式所属的渲染族（design §1）：`"scroll"` 由 `ScrollReader` 呈现，`"paged"`（覆盖、
   * 滑动、仿真、无动画）由 `PagedReader` 呈现。快捷键按它映射（design §8.1）。
   *
   * 分页族内部换模式（如覆盖 → 仿真）只改 `settings.pageAnim`，渲染族不变，`PagedReader` 不重挂，
   * 页码保持不动；跨渲染族切换见 `handleUpdateSettings`。
   */
  const family = renderFamilyOf(settings.pageAnim);

  // Book Data State
  const [toc, setToc] = useState<BookToc | null>(null);
  const [fullText, setFullText] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /**
   * 加载进度（需求 10.5，design §8.3）。
   *
   * **初始值是不确定态而不是 0%**：`loadGzipBookText` 的五条分支里只有一条能给出百分比，
   * 而在它给出第一个读数之前还要先走完 `_toc.json` 那一跳。0% 起步会让缓存命中、透明解压
   * 这些根本不产出百分比的分支把整段等待都显示成"卡在 0%"。
   */
  const [downloadProgress, setDownloadProgress] = useState<LoadProgress>(INDETERMINATE);
  /**
   * 加载失败的类别（reader-defect-fixes 需求 13.1）。错误页只按类别显示固定的中文说明，
   * 原始异常不进页面，只在 `loadBook` 的 `catch` 里写一行进控制台（13.4）。
   */
  const [error, setError] = useState<LoadErrorCategory | null>(null);

  /**
   * 标签页标题跟着书名走（需求 9.3）。
   *
   * 取 `toc?.title` 而不是路由里的 `bookId`：id 是 `书名-作者` 的 slug，不是书名本身。
   * 代价是标题在 `_toc.json` 到手之前还是站点名——那一段正是"正在打开书籍"的加载页，
   * 此时书名确实尚不可知，显示站点名比显示一个 slug 或空标题都对。
   *
   * 返回书架时不需要在这里恢复：书架自己也声明标题（见 hooks/useDocumentTitle.ts）。
   */
  useDocumentTitle(toc?.title);

  // Active Chapter & Page State
  //
  // 阅读位置（`currentChapterIndex` + `charOffset`）与它的落盘在 `useReadingPosition`，
  // `?ch=` 的定位与写回在 `useChapterUrlSync`，两者都在 `positionedBook` 声明之后调用。
  /**
   * 最近一条导航指令（design §3.1）："把视口移到这个位置"，视图按 `seq` 认新指令、各消费一次。
   *
   * 首次定位、目录、滑杆、底栏上下章、`?ch=`、检索、书签全都下发它，**章首也下发**：滚动模式
   * 跨章连续之后，章首不再等于 `scrollTop = 0`，"复位视口"只能交给视图按目标去算（需求 10.7、
   * 12.1–12.4）。`seq` 单调递增，同一目标连发两次（滑杆拖回原处、目录再点一次当前章）也是
   * 一条新指令。
   *
   * **为什么是指令，而不是"每次测量后都对齐 `charOffset`"**：视图的几何有好几个失效时机
   * （换章、尺寸变化、排版设置、全屏、字体就绪），定位若挂在测量之后，读者读到第 300 段时
   * 改一次字号就会被拽回打开时的位置。需求 2.4 说的是**跨会话**——改了字号再打开
   * 仍落在同一段落（字符偏移天然满足，与像素比例的根本差别就在这），不是会话内跟着重排再
   * 滚一次：那时读者的眼睛已经在屏幕上某处，不该动它。
   *
   * 所以定位只由"位置来源"显式发起，经 `issueNav` 写入。指令不带 `highlightLength`：
   * 高亮另有 `highlightTarget`，生命周期不同。
   */
  const [nav, setNav] = useState<NavRequest>(NO_NAV);
  /**
   * 检索命中高亮，`null` = 不高亮（需求 2.5）。
   *
   * 与 `nav` 同由 `jumpTo` 写入，但生命周期不同：那个落地即消费，这个要在屏幕上
   * 留 5 秒（`HIGHLIGHT_MS`）或留到读者翻走。
   */
  const [highlightTarget, setHighlightTarget] = useState<HighlightTarget | null>(null);
  const [isBookmarked, setIsBookmarked] = useState<boolean>(false);

  // UI Panels
  const [showControls, setShowControls] = useState(true);
  const [isTocOpen, setIsTocOpen] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isSettingOpen, setIsSettingOpen] = useState(false);
  const controlsTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  /**
   * 边界提示"没有上一页 / 没有下一页"（design §6.9，需求 3.5–3.8、10.14、10.15）。
   *
   * 状态由 `noticeStep` 维护（至多一条、1.5 秒到期），挂在本页而不是视图里：切换翻页模式时
   * 视图会重挂，提示不应随之丢失。`boundaryNotice.onBoundary` 的 identity 恒定，两种视图接入后
   * 原样作为 `ReaderViewProps.onBoundary` 传入（任务 16.6、18.7）。
   */
  const boundaryNotice = useBoundaryNotice();

  // Which book the initial position has already been resolved for. Keeps the
  // positioning effect from clobbering in-reader navigation when it re-runs for
  // a reason other than an externally changed `?ch=`.
  //
  // 它同时是 URL 写回 effect 的闸门（需求 7.1）：初始位置定下来之前，`currentChapterIndex`
  // 还是占位的 0，此时写回会把 URL 上的 `?ch=` 冲掉。
  //
  // 任务 35 把它从 ref 改成 state，因为进度落盘 effect（`useReadingPosition`）需要把它当
  // 闸门用：`toc` 到位的那一次提交里章号还是 0、偏移还是 0，若此时就落盘，会把"第 500 章 /
  // 偏移 12345"的记录覆盖成章首——正好在恢复它之前（任务 36）。ref 的变化不会让落盘 effect
  // 重跑，因此闸门必须是 state。
  //
  // 由本组件持有而不是放进任一 hook：写它的是首次定位（`onInitialPosition`），读它的是
  // 落盘与 URL 写回两个 hook。
  const [positionedBook, setPositionedBook] = useState<string | null>(null);

  /**
   * `?ch=` 定位与写回共用的两枚 ref（`useChapterUrlSync`）。
   *
   * 必须早于 `useReadingPosition` 与 `jumpTo`：每一条改 `currentChapterIndex` 的路径都要先推进
   * `currentChapterRef`，而 `useChapterUrlSync` 本身要等 `jumpTo` 声明之后才能调用。
   */
  const urlRefs = useChapterUrlRefs();

  // 阅读位置：章号 + 章内偏移、1 秒防抖落盘、卸载补写、视图上报（design §3.2）
  const {
    currentChapterIndex,
    setCurrentChapterIndex,
    setCharOffset,
    currentChapter,
    progressPercent,
    pendingOffsetRef,
    reportPosition,
    commitPendingOffset,
    liveCharOffset,
  } = useReadingPosition({
    bookId,
    toc,
    positionedBook,
    // 经本 hook 决定的换章（含视图上报的跨章）不经过 `jumpTo`，`?ch=` 写回要靠这里跟上：
    // 写回 effect 只在 `currentChapterRef` 与 state 一致时才写（需求 3.9、10.4）。
    onChapterDecided: (id) => {
      urlRefs.currentChapterRef.current = id;
    },
  });

  /**
   * 读者此刻的位置，**含尚未提交成 state 的那一帧**（`ReaderViewProps.positionRef`，design §1.2）。
   *
   * 每一条改变位置的路径都同步写它：视图上报（`onPosition`）、`jumpTo`、首次定位。于是它恒等于
   * "章号 state + `liveCharOffset()`"，又不必等那次提交——切换渲染族时以它下发导航指令（需求 1.6），
   * 滚动视图的 `bookmarkOffset()` 在判定线还没跟上时也退回它。
   */
  const positionRef = useRef<{ chapterId: number; charOffset: number }>({
    chapterId: 0,
    charOffset: 0,
  });

  /**
   * 视图上报位置（`ReaderViewProps.onPosition`，design §3.2）：先记进 `positionRef`，再交给
   * `reportPosition` 决定"换章立即提交 / 同章走防抖"。identity 稳定。
   */
  const onPosition = useCallback(
    (chapterId: number, charOffset: number) => {
      positionRef.current = { chapterId, charOffset };
      reportPosition(chapterId, charOffset);
    },
    [reportPosition]
  );

  /**
   * 当前挂载的视图句柄（design §1.2）：滚动族为 `ScrollReader`，分页族为 `PagedReader`。快捷键分发、
   * 加书签与跨渲染族切换前的 `settle()` 经它驱动视图。视图挂上之前（首次定位未完成、正文仍在
   * 解压）为 null。
   */
  const viewRef = useRef<ReaderViewHandle | null>(null);

  /**
   * 分页视图上报的当前页页码（`PagedReaderProps.onPageInfo`，需求 2.9）：当前章尚未分页或挂的是
   * 滚动视图时为 null（`PagedReader` 卸载时自己报一次 null）。页码只存在于运行时（需求 2.8）。
   * 底栏的 `PageNumberBadge` 显示它。
   */
  const [pageInfo, setPageInfo] = useState<PageInfo | null>(null);

  /**
   * 视图句柄的 ref 回调。挂上时顺手把文档归零：从滚动过的书架页进来时，文档还停在书架的
   * scrollTop 上（需求 2.3）。正文分支的根容器已钉成一屏高，文档此刻不可滚，浏览器本会把它
   * 夹到 0；这里显式归零，行为不依赖夹取。句柄在提交阶段的 layout 时段挂上，早于绘制，读者
   * 看不到中间态。
   */
  const attachView = useCallback((handle: ReaderViewHandle | null) => {
    viewRef.current = handle;
    if (handle) {
      const docScroller = document.scrollingElement;
      if (docScroller) docScroller.scrollTop = 0;
    }
  }, []);

  /**
   * 翻页按键闸门（design §8.2，需求 11.5–11.7）：repeat 丢弃、同方向 600ms 内忽略、动画中忽略。
   * 只作用于 `turn-*`；行滚动与换章不经过它。
   */
  const keyGateRef = useRef<KeyGate>(KEY_GATE_IDLE);

  // 1. Load Book TOC and Decompress Book File.
  //    Keyed on `bookId` only — this effect downloads and decompresses the
  //    whole book, so it must never re-run on a mere URL query change.
  //    Chapter positioning lives in `useChapterUrlSync` below.
  useEffect(() => {
    if (!bookId) return;
    let isCancelled = false;

    const loadBook = async () => {
      setLoading(true);
      setError(null);
      setDownloadProgress(INDETERMINATE);
      // Drop the previous book's data so the positioning effect can't validate
      // a chapter index against the wrong chapter table.
      setToc(null);
      setFullText(null);
      // 上一本书里的检索命中与本书的章节表毫无关系（组件不会为换书而重新挂载）
      setHighlightTarget(null);

      // 当前所处的加载阶段，`catch` 据此分类（reader-defect-fixes 需求 13.1）：同一类错误
      // 在两个阶段含义不同，例如 404 在 `toc` 是"找不到这本书"，在 `text` 是"正文文件缺失"。
      let stage: LoadStage = "toc";

      try {
        // 1. Fetch TOC metadata（经 tocCache，与书架弹窗共用同一次请求；需求 3.4）
        const tocData: BookToc = await loadToc(bookId);
        if (isCancelled) return;
        setToc(tocData);
        stage = "text";

        // 2. Fetch & decompress Gzip novel text（路径由 id 派生，需求 5.1）
        //
        // 进度原样落进 state，不在这里判断确定与否——那是 `deriveLoadProgress` 在
        // 加载侧就定下的事（需求 10.5）。`sameLoadProgress` 是渲染闸门：大书的下载有
        // 数百个分片，而屏幕上只有 101 个可区分的百分比。
        const text = await loadGzipBookText(txtUrl(bookId), bookId, (progress) => {
          if (isCancelled) return;
          setDownloadProgress((prev) => (sameLoadProgress(prev, progress) ? prev : progress));
        });
        if (isCancelled) return;
        setFullText(text);
      } catch (err) {
        // 被取消的加载（换书、卸载、StrictMode 开发期的首轮 effect）什么也不做：错误页只为
        // 当前这本书出现，日志也就只随它打这一条（需求 13.4）。
        if (!isCancelled) {
          console.error(formatLoadErrorLog(stage, bookId, err));
          setError(classifyLoadError(stage, err));
        }
      } finally {
        if (!isCancelled) {
          setLoading(false);
        }
      }
    };

    loadBook();

    return () => {
      isCancelled = true;
    };
  }, [bookId]);

  /**
   * 章节表的双视图（需求 12、design §3.8）：`contentIdx` 是正文章节的原始下标数组，
   * `contentPos` 是它的反函数。目录抽屉照旧遍历 `toc.chapters`（卷节点要看得见，任务 38），
   * 导航、计数、滑杆一律走这两个视图（卷节点必须当它不存在）。
   *
   * 卷节点的 range 只含自己的标题行，没有正文——落进去就是一页只有标题的空白页，
   * 所以每一条会产生章号的路径（`?ch=`、进度恢复、目录点击、滑杆、检索、书签）都要
   * 先过 `resolveContentChapter`，上下章则在 `contentIdx` 上 ±1。
   *
   * 依赖是 `toc` 而不是 `toc.chapters`：换书时整个 `toc` 换掉，同一本书内章节表不变。
   */
  const chapterViews = useMemo(() => buildChapterViews(toc ? toc.chapters : []), [toc]);

  /** 本书有没有正文章节。全由卷节点构成的异常数据走错误页，不渲染空白（需求 12.6）。 */
  const hasContentChapters = chapterViews.contentIdx.length > 0;

  // 2. 定位与 URL 写回（需求 7，design §6）：`useChapterUrlSync` 调用在 `jumpTo` 之后——定位
  //    effect 的依赖数组在渲染时就要读 `jumpTo`，提前调用会撞上 `const` 的暂时性死区。

  // 本章原文。**不得 `.trim()`**：那会把段落偏移整体平移，使
  // `chapter.start + para.offset` 不再是有效的全局偏移，定位基准当场失效
  // （design §3.1）。前导空白由 `splitParagraphs` 的空段落过滤自然跳过。
  const chapterText = useMemo(() => {
    if (!fullText || !currentChapter) return "";
    return fullText.slice(currentChapter.start, currentChapter.end);
  }, [fullText, currentChapter]);

  // 带章内偏移的段落（需求 2.1）。书签以这些偏移为基准。
  const paras = useMemo(() => splitParagraphs(chapterText), [chapterText]);

  // 本章正文段落：跳过与标题重复的首段（E10）。只供书签预览取所在段（`previewAt`）——正文由视图
  // 各自按章切分渲染，检索高亮也由视图按 `highlightTarget` 自己落点。
  const bodyParas = useMemo(
    () => bodyParagraphs(paras, currentChapter?.title),
    [paras, currentChapter]
  );

  // 高亮 5 秒后自动清除（需求 2.5）。换一条命中会让本 effect 重跑，定时器随之重排——
  // 连点两条结果时第二条同样能亮满 5 秒。另一条清除路径在 `jumpTo`（外部改 `?ch=` 也经它）
  // 与首次定位里。
  useEffect(() => {
    if (!highlightTarget) return;
    const timer = setTimeout(() => setHighlightTarget(null), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlightTarget]);

  // Sync bookmark state with current chapter
  useEffect(() => {
    if (bookId && currentChapter) {
      setIsBookmarked(isChapterBookmarked(bookId, currentChapter.id));
    }
  }, [bookId, currentChapter]);

  const handleToggleBookmark = () => {
    if (!bookId || !currentChapter) return;
    if (isBookmarked) {
      const bms = getBookmarks(bookId);
      const target = bms.find((b) => b.chapterId === currentChapter.id);
      if (target) {
        removeBookmark(bookId, target.id);
      }
      setIsBookmarked(false);
    } else {
      // 挂着视图时由视图给出（需求 12.5）：分页视图返回当前页的页首偏移；滚动视图返回判定线处段落
      // 的偏移，钉住期间是导航目标的偏移（检索命中可能在段中）。视图还没挂上时沿用含未提交那一帧的
      // `liveCharOffset()`。
      const offset = viewRef.current ? viewRef.current.bookmarkOffset() : liveCharOffset();
      addBookmark({
        id: `${bookId}_${currentChapter.id}_${Date.now()}`,
        bookId,
        chapterId: currentChapter.id,
        chapterTitle: currentChapter.title,
        // 按下书签时的真实章内偏移（需求 2.6）：跳回来时落在同一段，而不是章首。
        charOffset: offset,
        // 预览取**该偏移所在**的那一段，不再是全章首段——书签是"这个位置"的凭据，列表里
        // 该显示读者当时在看的那几行。`bodyParas` 已跳过标题行，所以预览不会与
        // `chapterTitle` 重复（标题另有其字段）。
        previewText: previewAt(bodyParas, offset, BOOKMARK_PREVIEW_LENGTH),
        createdAt: Date.now(),
      });
      setIsBookmarked(true);
    }
  };

  // Auto-hide controls timer
  const triggerShowControls = useCallback(() => {
    setShowControls(true);
    if (controlsTimeoutRef.current) {
      clearTimeout(controlsTimeoutRef.current);
    }
    controlsTimeoutRef.current = setTimeout(() => {
      setShowControls(false);
    }, 4500);
  }, []);

  /**
   * 九宫格 Tap 的控制栏决策（`ReaderViewProps.onControls`，需求 5.4、5.9）：`show` 即
   * `triggerShowControls()`（带 4.5 秒自动隐藏），`hide` 立即隐藏并撤掉那个计时。
   * 翻页本身不调用它（需求 5.11、11.16）。identity 稳定。
   */
  const onControls = useCallback(
    (action: "show" | "hide") => {
      if (action === "show") {
        triggerShowControls();
        return;
      }
      if (controlsTimeoutRef.current) {
        clearTimeout(controlsTimeoutRef.current);
        controlsTimeoutRef.current = null;
      }
      setShowControls(false);
    },
    [triggerShowControls]
  );

  /**
   * 下发一条导航指令（design §3.1）：`seq` 在上一条之上 +1。
   *
   * 用函数式更新取上一条的 `seq`，于是本回调没有依赖、identity 恒定，`jumpTo` 与
   * `onInitialPosition` 不必为它多列一项依赖。同一批更新里连发两次也各得一个 `seq`。
   */
  const issueNav = useCallback((chapterId: number, charOffset: number) => {
    setNav((prev) => ({ seq: prev.seq + 1, chapterId, charOffset }));
  }, []);

  /**
   * **统一跳转入口**（design §3.1 / §3.5）：读者发起的每一次位置移动都走这里——目录点击、
   * 底部滑杆、底栏上下章（`goToRelativeChapter` → `goToChapter`）、外部改动的 `?ch=`、检索命中、
   * 书签。进度恢复是唯一的例外，它由 `useChapterUrlSync` 的定位 effect 经 `onInitialPosition`
   * 直接写 state（还要同时立起 `positionedBook` 闸门），但下发的同样是一条 `NavRequest`，
   * 由视图按同一套规则落地。
   *
   * `resolveJumpTarget` 先把指令归一（卷节点 → 其后第一个正文章节、越界夹到两端，
   * 且**章号被改动时连带作废偏移与高亮**，需求 12.5），于是"卷节点渲染出空白页"与
   * "偏移错位到另一章"这两个失败模式在入口处就不存在了，下游不需要再判 `isVolume`。
   */
  const jumpTo = useCallback(
    (target: JumpTarget) => {
      const resolved = resolveJumpTarget(chapterViews, target);
      if (resolved === null) return;

      // 先于 state 记下新章号：同一次 effect 冲刷里的写回 effect 据此知道 state 还没跟上
      urlRefs.currentChapterRef.current = resolved.chapterId;
      positionRef.current = { chapterId: resolved.chapterId, charOffset: resolved.charOffset };
      setCurrentChapterIndex(resolved.chapterId);
      setCharOffset(resolved.charOffset);
      // 防住"上一章算出的偏移被换章后才触发的防抖提交带进新章"
      pendingOffsetRef.current = null;
      // 章首也下发（design §3.1）：滚动模式下章首不再是 `scrollTop = 0`，视口怎么摆由视图
      // 按指令去算。每次跳转都是一条新指令，上一条还没落地的就此作废——`jumpTo(当前章)`
      // （滑杆拖回原处）不改 `currentChapterIndex`，也照样得到一个新 `seq`。
      issueNav(resolved.chapterId, resolved.charOffset);
      // 高亮只跟着带 `highlightLength` 的指令来（即检索）；其余任何跳转都是"下一次导航"，
      // 一律清除（需求 2.5）。
      setHighlightTarget(
        resolved.highlightLength === undefined
          ? null
          : {
              chapterId: resolved.chapterId,
              charOffset: resolved.charOffset,
              length: resolved.highlightLength,
            }
      );
      // 导航即亮控制栏：换了地方，读者需要看到新的章号与进度
      triggerShowControls();
    },
    // 除 `chapterViews` 外全部 identity 稳定：换章不会让 `jumpTo` 变，定位 effect 也就不重跑
    [
      chapterViews,
      triggerShowControls,
      urlRefs,
      setCurrentChapterIndex,
      setCharOffset,
      pendingOffsetRef,
      issueNav,
    ]
  );

  /**
   * 首次定位落地（由 `useChapterUrlSync` 的定位 effect 调用，调用前它已写好 `urlChRef` 与
   * `currentChapterRef`）：立起 `positionedBook` 闸门，把合成出的（章号, 偏移）写成当前位置，
   * 清掉检索高亮，并下发导航指令让视图显示该位置（需求 12.2）。
   *
   * identity 稳定（依赖全是稳定的 setter），列在定位 effect 的依赖里也不会让它在换章时重跑。
   */
  const onInitialPosition = useCallback(
    (positioned: string, target: JumpTarget) => {
      setPositionedBook(positioned);
      positionRef.current = { chapterId: target.chapterId, charOffset: target.charOffset };
      setCurrentChapterIndex(target.chapterId);
      setCharOffset(target.charOffset);
      setHighlightTarget(null);
      // 位置本身即刻生效（百分比、落盘都读 state）；"移动视口"另由指令承担，由视图在测量完成后
      // 落地——位置（state）与指令必须分开，否则每次重排都会把读者拽回原处。章首同样下发：视图
      // 往往还没挂载（正文仍在解压），它挂上时消费的就是这条指令。
      issueNav(target.chapterId, target.charOffset);
    },
    [setCurrentChapterIndex, setCharOffset, issueNav]
  );

  // 定位与 URL 写回（design §6，需求 7；S3）。必须晚于 `jumpTo`：定位 effect 的依赖数组在渲染
  // 时就要读它。两个 effect 在本组件 effect 序列里的位置与迁出前相同。
  useChapterUrlSync(urlRefs, {
    bookId,
    toc,
    chapterViews,
    positionedBook,
    currentChapterIndex,
    onInitialPosition,
    jumpTo,
  });

  /**
   * 整章跳转：目录点击、滑杆、上下章都落在**章首**（偏移 0、不高亮）。
   *
   * 只是 `jumpTo` 的一个特例，留着这层壳是因为目录抽屉的 `onSelectChapter` 收的是一个
   * 章号函数，且"翻到某章"在调用处读起来比手写一个 `JumpTarget` 字面量清楚。
   */
  const goToChapter = useCallback(
    (index: number) => {
      jumpTo({ chapterId: index, charOffset: 0 });
    },
    [jumpTo]
  );

  /**
   * 上一章 / 下一章：在 `contentIdx` 上 ±1，卷节点因此天然被跳过（需求 12.3）。
   *
   * 相邻的卷节点（例如下标 5、6 连着两个卷）也只需一步——序号是在已剔除卷节点的
   * 数组上移动的，卷有几个、挤在一起还是分散都不影响结果。
   *
   * 已在首/末正文章节时 `stepContentChapter` 返回当前章自身，这里就只亮一下控制栏、
   * 不动位置：按钮虽已置灰，键盘 ←/→ 仍会走进来，而"回到章首 + 把进度覆盖成偏移 0"
   * 不是读者按 → 想要的结果。
   */
  /**
   * 底部滑杆的跳转入口：入参是**正文序号**，不是原始下标（需求 12.4、design §3.8）。
   *
   * 滑杆的值域与显示口径都建立在"卷节点不存在"之上，所以拖动结果必须先经
   * `contentChapterAt` 换回原始下标再交给 `goToChapter`。直接把滑杆值当原始下标用，
   * 在有卷节点的书里会整体偏移（有几个卷，末端就偏几章）。
   */
  const goToContentPosition = useCallback(
    (position: number) => {
      const target = contentChapterAt(chapterViews, position);
      if (target === NO_CONTENT_CHAPTER) return;
      goToChapter(target);
    },
    [chapterViews, goToChapter]
  );

  const goToRelativeChapter = useCallback(
    (delta: number) => {
      const target = stepContentChapter(chapterViews, currentChapterIndex, delta);
      if (target === NO_CONTENT_CHAPTER || target === currentChapterIndex) {
        triggerShowControls();
        return;
      }
      goToChapter(target);
    },
    [chapterViews, currentChapterIndex, goToChapter, triggerShowControls]
  );

  /**
   * 检索结果跳转（需求 2.5、design §3.5）。
   *
   * 抽屉交出来的是**全局**命中偏移（它二分定位章节时本就要算），换算成章内偏移在这里做：
   * `charOffset = matchOffset - chapter.start`。这一步以前没有，`matchOffset` 算出来就被
   * 丢掉了，于是检索只能跳到章首（差异表 C4）。
   *
   * 命中长度原样进 `highlightLength`，`jumpTo` 据此立起高亮；命中落在卷标题上时
   * `resolveJumpTarget` 会改用其后第一个正文章节并连带作废偏移与高亮（需求 12.5）。
   */
  const handleSelectSearchResult = useCallback(
    (chapterId: number, matchOffset: number, matchLength: number) => {
      const chapter = toc?.chapters[chapterId];
      if (!chapter) return;
      jumpTo({
        chapterId,
        charOffset: matchOffset - chapter.start,
        highlightLength: matchLength,
      });
    },
    [toc, jumpTo]
  );

  /**
   * 书签跳转（需求 2.6、design §3.5 的第三个来源）。
   *
   * 章号与偏移**原样取自书签记录**——记录里存的本来就是章内偏移，不像检索那样要先从全局
   * 偏移换算。走的仍是同一个 `jumpTo`：卷节点归一、越界夹取、把目标段滚入视口这三件事
   * 因此与进度恢复、检索命中共用一套代码，不会出现"书签能跳到空白卷页"这种只在一条路径上
   * 存在的缺陷。
   *
   * 缺 `charOffset` 的 v1 书签由 `readBookmark` 补成 0（任务 31），表现为跳回章首，
   * 这里不必另判。
   *
   * 不传 `highlightLength`：书签标的是一个位置，不是一段文字，没有"命中"可标；`jumpTo`
   * 据此把上一条检索高亮清掉（需求 2.5 的"下一次导航即清除"）。
   */
  const handleSelectBookmark = useCallback(
    (chapterId: number, bookmarkOffset: number) => {
      jumpTo({ chapterId, charOffset: bookmarkOffset });
    },
    [jumpTo]
  );

  // Keyboard Navigation (Inspired by Koodo Reader)
  //
  // 按键 → 动作的映射（含"什么时候不接管"的三条规则）全在 `readerAction` 里，这里只负责
  // 把动作接到阅读器的能力上。抽屉打开时滚动类快捷键让给浏览器（去滚抽屉自己的列表），
  // 所以三个面板的开关状态要进 deps——effect 体只是一次 add/removeEventListener，重订阅
  // 的成本可以忽略。
  //
  // 映射按实际渲染族（design §8.1）。翻页类与滚动类动作一律经视图句柄分发（任务 16.6、18.7），
  // 不需要知道挂的是哪种视图：`turn-*` 先过按键闸门再 `turn(方向, "key")`；分页族的
  // `page-first`/`page-last` 与滚动族的 `chapter-start`/`chapter-end` 都走 `edge()`（分页为本章首页/
  // 末页，滚动为章首/章末）；行滚动走 `line()`（分页视图里是空操作，分页族也映射不出它）。
  // 翻页不亮控制栏（需求 11.16）；滚动族 `←`/`→` 换章仍走 `goToRelativeChapter`，与底栏、目录
  // 导航一样亮一下控制栏。
  useEffect(() => {
    /**
     * 按键翻页（需求 11.5–11.7）：repeat 丢弃且不推迟下一次；同方向距上一次非 repeat 按键不足
     * 600ms 忽略（被忽略的也算"上一次"）；视图的翻页动画进行中忽略。
     */
    const turnByKey = (view: ReaderViewHandle, direction: TurnDirection, repeat: boolean) => {
      const { gate, accept } = keyGateStep(keyGateRef.current, {
        direction,
        t: performance.now(),
        repeat,
        animating: view.isAnimating(),
      });
      keyGateRef.current = gate;
      if (accept) view.turn(direction, "key");
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      const action = readerAction(
        {
          key: e.key,
          shiftKey: e.shiftKey,
          ctrlKey: e.ctrlKey,
          altKey: e.altKey,
          metaKey: e.metaKey,
          target: e.target as HTMLElement | null,
        },
        { panelOpen: isTocOpen || isSearchOpen || isSettingOpen, family }
      );
      if (action === null) return;

      // `Space` 必须拦住浏览器自己的翻页滚动，否则视图的翻页之上还会叠一次默认滚动
      // （见 `preventsDefault`）。被闸门丢弃的 repeat 也照拦：按住 `Space` 不该变成
      // 浏览器的连续翻屏。
      if (preventsDefault(action)) e.preventDefault();

      // 当前视图的句柄。视图还没挂上（首次定位未完成、正文仍在解压）时为 null：屏幕上还没有
      // 正文，翻页与滚动类按键无事可做，原地忽略。
      const view = viewRef.current;

      switch (action) {
        case "prev-chapter":
          goToRelativeChapter(-1);
          break;
        case "next-chapter":
          goToRelativeChapter(1);
          break;
        case "turn-next":
          if (view) turnByKey(view, "next", e.repeat);
          break;
        case "turn-prev":
          if (view) turnByKey(view, "prev", e.repeat);
          break;
        // 分页族：本章首页 / 末页（需求 11.3）；滚动族：本章章首 / 章末（需求 11.13）。与翻页一样
        // 算读者移动，由视图上报位置
        case "page-first":
        case "chapter-start":
          view?.edge("start");
          break;
        case "page-last":
        case "chapter-end":
          view?.edge("end");
          break;
        case "line-down":
          view?.line(1);
          break;
        case "line-up":
          view?.line(-1);
          break;
        case "toggle-toc":
          setIsTocOpen((prev) => !prev);
          break;
        case "toggle-search":
          setIsSearchOpen((prev) => !prev);
          break;
        case "toggle-settings":
          setIsSettingOpen((prev) => !prev);
          break;
        case "close-panels":
          setIsTocOpen(false);
          setIsSearchOpen(false);
          setIsSettingOpen(false);
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [goToRelativeChapter, isTocOpen, isSearchOpen, isSettingOpen, family]);

  // Handle settings update
  const handleUpdateSettings = (newSettings: Partial<typeof settings>) => {
    const updated = { ...settings, ...newSettings };
    // 跨渲染族切换（design §3.1，需求 1.5–1.7）：新视图要以切换前的阅读位置挂载。
    //
    // 1. 先 `settle()` 旧视图：进行中的翻页（或翻页滚动）当场落定，提交的那一页经 `onPosition`
    //    同步写进 `positionRef`；
    // 2. 提交待落盘偏移，进度不因视图重挂而丢一拍；
    // 3. 以 `positionRef` 下发导航指令。它与 `setSettings` 同批提交：新视图在挂载时消费这条指令
    //    （分页显示包含该偏移的页，滚动把该段置于判定线），旧视图在同一次提交里卸载，不会消费它。
    //
    // 导航指令不改变阅读位置（design §3.3），所以切过去、未做移动再切回来，`positionRef` 仍是同一个
    // 位置，新视图呈现的也就是第一次切换前的位置（需求 1.7）。分页族内部换模式不走这里：视图不重挂，
    // 只有 `settings.pageAnim` 变化（下一次翻页按新模式播放）。
    if (renderFamilyOf(updated.pageAnim) !== family) {
      viewRef.current?.settle();
      commitPendingOffset();
      const { chapterId, charOffset } = positionRef.current;
      issueNav(chapterId, charOffset);
    }
    setSettings(updated);
    saveStoredSettings(updated);
  };

  /**
   * 整本下载（需求 9.1，差异表 C21）。
   *
   * **读的是 `fullText` 这个 state，不重新取数**：它就是打开这本书时解压出来的那份文本
   * （缓存命中时来自 IndexedDB 的 gz，同样已在内存里）。因此这个动作零网络往返——需求 9.1
   * 的"SHALL NOT 发起任何服务端请求"不是靠约定，而是结构上做不到：`utils/download.ts` 里
   * 没有 `fetch`，这里也不碰 `txtUrl()`。旧版那套 UI + Pages Function 因 `assets` 未声明
   * 对所有书必然 404，改造后连服务端都不存在了。
   *
   * 入口有两个：顶栏的下载图标与设置抽屉里的"下载 TXT 文件"，同一个回调。不做"是否要下载
   * 几十 MB"的二次确认：按下载按钮的意图是明确的；真正的大书成本在下载**这本书**时早已付过
   * （下载 gz 的那一次），本地再写一份文件不产生流量。
   *
   * `fullText` 为 null 只在正文还没解压完时成立，而那时抽屉根本没渲染（页面停在 loading
   * 分支）。这里仍然判一次：类型上它可空，而"按钮能按但什么也没发生"比置灰难查得多。
   */
  const handleDownloadBook = useCallback(() => {
    if (fullText === null || !toc) return;
    downloadBookAsTxt(fullText, toc.title);
  }, [fullText, toc]);

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-4 transition-colors bg-[var(--bg)] text-[var(--text)]">
        <div className="w-16 h-16 rounded-2xl bg-blue-500/10 flex items-center justify-center mb-4">
          <RefreshCw className="w-8 h-8 animate-spin text-blue-500" />
        </div>
        <h2 className="text-base font-semibold mb-1">正在打开书籍...</h2>
        <p className="text-xs text-[var(--text-muted)] mb-4">
          正在载入正文
          {downloadProgress.kind === "determinate" ? ` (${downloadProgress.pct}%)` : ""}
        </p>
        {/*
         * 两态各渲染一条（需求 10.5、design §8.3）：
         * - 确定态按百分比给宽度，`Math.max(5, …)` 只是让 0–4% 时仍有一截可见，文字与
         *   `aria-valuenow` 报的仍是真实读数。
         * - 不确定态是一截循环滑动的短条（`.animate-progress-loop`，见 index.css）。
         *   缺 `content-length`、透明解压、缓存命中三条路径都走这里——它们不是"进度 0"，
         *   而是没有进度可报，停在 0% 会被当成卡住。不带 `aria-valuenow` 正是 ARIA 表达
         *   indeterminate 的方式，读屏软件会念"忙"而不是"0%"。
         */}
        <div
          className="w-48 bg-[var(--hover)] h-1.5 rounded-full overflow-hidden"
          role="progressbar"
          aria-label="书籍加载进度"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={
            downloadProgress.kind === "determinate" ? downloadProgress.pct : undefined
          }
        >
          {downloadProgress.kind === "determinate" ? (
            <div
              className="bg-blue-500 h-full rounded-full transition-all duration-200"
              style={{ width: `${Math.max(5, downloadProgress.pct)}%` }}
            />
          ) : (
            <div className="bg-blue-500 h-full w-1/3 rounded-full animate-progress-loop" />
          )}
        </div>
      </div>
    );
  }

  if (error || !toc) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-4 bg-[var(--bg)] text-[var(--text)]">
        <AlertCircle className="w-12 h-12 text-rose-500 mb-3" />
        <h2 className="text-lg font-bold mb-1">未能打开书籍</h2>
        {/* 说明只由类别决定（需求 13.2）。`error` 为 null 而 `toc` 缺失不应出现，按 unknown 兜底 */}
        <p className="text-xs text-[var(--text-muted)] mb-6 max-w-sm text-center">
          {READER_LOAD_ERROR_TEXT[error ?? "unknown"]}
        </p>
        <button
          onClick={() => navigate("/")}
          className="px-5 py-2.5 bg-blue-600 text-white rounded-xl text-xs font-semibold hover:bg-blue-700 shadow-md"
        >
          返回书架
        </button>
      </div>
    );
  }

  // 章节表全由卷节点构成（异常数据）：没有任何正文可渲染。明确说清楚问题在哪，
  // 而不是把一页空白交给读者去猜（需求 12.6、design §10）。
  //
  // 这种产物过不了预处理的自校验（`totalChapters` 会是 0），所以只可能来自手工改过的
  // `_toc.json` 或规则把整本书都误判成卷。文案只对读者说清现象，不提"重试"——刷新一百次
  // 也还是这份产物；"重新预处理"是站主的事，不放进给读者看的页面。
  if (!hasContentChapters) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-4 bg-[var(--bg)] text-[var(--text)]">
        <AlertCircle className="w-12 h-12 text-amber-500 mb-3" />
        <h2 className="text-lg font-bold mb-1">这本书没有可阅读的章节</h2>
        <p className="text-xs text-[var(--text-muted)] mb-6 max-w-sm text-center leading-relaxed">
          《{toc.title}》的目录里只有分卷标题，找不到正文章节，暂时无法阅读。
        </p>
        <button
          onClick={() => navigate("/")}
          className="px-5 py-2.5 bg-blue-600 text-white rounded-xl text-xs font-semibold hover:bg-blue-700 shadow-md"
        >
          返回书架
        </button>
      </div>
    );
  }

  /**
   * 当前章在正文序号里的位置，以及是否已在首/末正文章节（需求 12.3）。
   *
   * 按钮的置灰判定必须走这里，不能再用 `currentChapterIndex <= 0` /
   * `>= chapters.length - 1`：末章之后若挂着卷节点，后者会把"下一章"显示成可点，
   * 点下去无处可去；书首是卷节点时"上一章"同理。
   *
   * `currentChapterIndex` 此刻必为正文章节（所有入口都过 `resolveContentChapter`），
   * 故 `contentPosition` 就是它自己的序号。滑杆值域与"第 N / 共 M 章"一并复用它。
   */
  const contentPosition = contentPositionOf(chapterViews, currentChapterIndex);
  /**
   * 正文章节总数，即"第 N / 共 M 章"的 M、滑杆的 `max + 1`（需求 12.4）。
   *
   * **口径只有这一个**：`contentIdx.length`，不用 `toc.totalChapters`。两者在现有全部
   * 产物里相等（预处理自校验就是拿"非卷节点数"去核对 `totalChapters` 的，任务 24），
   * 取前者是因为它与滑杆真正索引的那个数组同源——滑杆的 `max` 与它能落到的位置由同一个
   * `contentIdx` 决定，不可能互相矛盾。`totalChapters` 是产物里的一个**断言**而非推导值：
   * 手改过的 `_toc.json`、旧版产物、或将来 schema 漂移都可能让它对不上章节表，而那时
   * `max` 会指向一个不存在的位置（拖到最右端无处可跳），或反过来把末尾几章锁在滑杆之外。
   *
   * 显示口径与导航口径同源还有一个附带好处：滑杆右端的数字与"下一章"按钮何时置灰
   * （`isLastContentChapter`）永远一致。
   */
  const contentTotal = chapterViews.contentIdx.length;
  const isFirstContentChapter = contentPosition <= 0;
  const isLastContentChapter = contentPosition >= contentTotal - 1;

  /**
   * 下载文件名（需求 9.1：文件名就是书名）。
   *
   * 算在这里而不是 memo 里：`bookTxtFileName` 是几个正则加一次编码测量，输入是一个书名
   * 长度的字符串——比一个 `useMemo` 的比较开销还小。放在守卫之后，`toc` 此刻必非空。
   */
  const downloadFileName = bookTxtFileName(toc.title);

  /*
   * 正文滚动模型（F-002，需求 2.1 / 2.2，design §3）：文档不滚，正文在视图自己的 `<main>` 里。
   *
   * 根容器钉成一屏高（`h-dvh`）并 `overflow-hidden`，文档本身因此没有可滚的距离；
   * 视图的 `<main>` 是 flex 列里唯一的流内子元素（顶栏、底栏、三个抽屉都是 `position: fixed`），
   * `flex-1 min-h-0` 让它恰好占满这一屏而不被正文撑高——缺了 `min-h-0`，flex 子项的
   * 最小高度默认是内容高度，`<main>` 会长成整章那么高，滚动又落回文档上。滚动族的 `<main>`
   * 是滚动容器，分页族的不滚动（只是页面图层的包含块）。
   *
   * 根容器不能带 transform / filter / contain：那会让 fixed 子元素改以它为包含块，
   * 进而被这里的 `overflow-hidden` 裁掉。
   *
   * 根容器**不监听点击**：控制栏只由正文的九宫格 MC 区唤出（需求 5.4，视图经 `onControls` 回报），
   * 控制栏可见时点正文只隐藏它（需求 5.9），翻页不亮它（需求 5.11）。从前"点任意处唤出"的
   * `onClick` 只留在顶栏上，见下。
   */
  return (
    <div className="h-dvh flex flex-col relative overflow-hidden select-text transition-colors duration-200 bg-[var(--bg)] text-[var(--text)]">
      {/* 1. Floating Top Header

          `onClick` 保留"点顶栏重置 4.5 秒自动隐藏计时"的现状：顶栏的点击从前靠冒泡到根容器的
          `onClick` 重置计时，根容器不再监听之后挂到这里（design §5.1）。底栏自己
          `stopPropagation`，从来不重置计时，不变。顶栏必须仍是根容器的直接子元素：
          `ScrollReader` 按 `:scope > header` 取它的矩形，从翻页可见区里扣掉。 */}
      <Header
        onClick={triggerShowControls}
        title={toc.title}
        chapterTitle={currentChapter?.title}
        progressPercent={progressPercent}
        show={showControls}
        isBookmarked={isBookmarked}
        onBack={() => navigate("/")}
        onToggleToc={() => setIsTocOpen((prev) => !prev)}
        onToggleSearch={() => setIsSearchOpen((prev) => !prev)}
        onToggleBookmark={handleToggleBookmark}
        onToggleSettings={() => setIsSettingOpen((prev) => !prev)}
        onDownload={fullText === null ? null : handleDownloadBook}
      />

      {/* 2. Reader Body

          滚动族由 `ScrollReader` 呈现（跨章连续滚动，需求 10.1），分页族由 `PagedReader` 呈现
          （按页、跨章无缝，需求 2、3）。两者在同一位置、类型不同：跨渲染族切换时旧视图卸载、新视图
          挂载；分页族内部换模式是同一个 `PagedReader` 实例，不重挂（任务 18.7）。正文末尾没有
          章末导航卡（需求 12.8）：换章靠翻页 / 连续滚动本身，或底栏的上一章、下一章（需求 12.9）。

          视图等首次定位完成（`positionedBook`）才挂：它以挂载时的那条导航指令定位，这时的 `nav`
          已是合成好的阅读位置，不会先按占位指令摆出第 0 章再跳走。 */}
      {positionedBook === bookId &&
        fullText !== null &&
        (family === "scroll" ? (
          <ScrollReader
            ref={attachView}
            toc={toc}
            fullText={fullText}
            views={chapterViews}
            settings={settings}
            positionRef={positionRef}
            nav={nav}
            highlight={highlightTarget}
            controlsVisible={showControls}
            onPosition={onPosition}
            onControls={onControls}
            onBoundary={boundaryNotice.onBoundary}
          />
        ) : (
          <PagedReader
            ref={attachView}
            toc={toc}
            fullText={fullText}
            views={chapterViews}
            settings={settings}
            positionRef={positionRef}
            nav={nav}
            highlight={highlightTarget}
            controlsVisible={showControls}
            onPosition={onPosition}
            onControls={onControls}
            onBoundary={boundaryNotice.onBoundary}
            onPageInfo={setPageInfo}
          />
        ))}

      {/* 3. Floating Bottom Toolbar / Progress Bar (Koodo style)

          隐藏时平移 `100% + 2rem` 而不是 `100%`：分页模式下底栏右上方挂着页码标签
          （`PageNumberBadge`，`-top-7`，高出底栏 28px），只平移底栏自身的高度会让它在视口底边
          露出一截。多出的 32px 让标签随底栏一起完整滑出（design §4.7）。 */}
      <footer
        className={`fixed bottom-0 left-0 right-0 h-14 z-30 transition-transform duration-300 ease-in-out border-t shadow-lg flex items-center justify-between px-4 sm:px-8 bg-[var(--bg)] text-[var(--text)] border-[var(--border)] ${
          showControls ? "translate-y-0" : "translate-y-[calc(100%+2rem)]"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 本章页码（需求 2.9）：只在分页族显示。滚动族下 `PagedReader` 未挂、`pageInfo` 为 null，
            这里再按渲染族判一次，切到滚动的那一帧也不会残留旧页码 */}
        {family === "paged" && <PageNumberBadge info={pageInfo} />}
        <div className="max-w-4xl mx-auto w-full flex items-center justify-between space-x-3 sm:space-x-4">
          {/* Prev Chapter

              名称由 `aria-label` 给出，两种渲染族下都是"上一章"；`title` 是悬停提示，只在滚动族附上
              按键：滚动族 `←` 即上一章，分页族 `←` 是上一页、没有换章键（design §8.1），附上反而误导。
              下一章按钮同理。 */}
          <button
            onClick={() => goToRelativeChapter(-1)}
            disabled={isFirstContentChapter}
            className="p-2 rounded-lg hover:bg-[var(--hover)] disabled:opacity-30 transition-colors shrink-0"
            aria-label="上一章"
            title={family === "scroll" ? "上一章 (←)" : "上一章"}
          >
            <ChevronLeft className="w-5 h-5" />
          </button>

          {/* Quick TOC button in footer */}
          <button
            onClick={() => setIsTocOpen((prev) => !prev)}
            className="px-2.5 py-1.5 rounded-lg border border-[var(--border)] text-xs font-medium flex items-center space-x-1 hover:bg-[var(--hover)] shrink-0"
            title="查看完整章节列表 (T)"
          >
            <List className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">目录</span>
          </button>

          {/*
            Chapter Slider（需求 12.4）

            值域是**正文序号**而不是原始下标：`max` 为 `contentTotal - 1`，`value` 为
            `contentPosition`，`onChange` 经 `goToContentPosition` 换回原始下标。三者
            必须同时是序号口径——混用一处就整体偏移，且偏移量恰好是卷节点数，在没有卷的
            书上完全看不出来。

            单章书（`contentTotal === 1`）时 `min === max === 0`，滑块钉在左端且拖不动，
            这正是"没有别的章可去"的正确呈现，无需额外分支。

            区块与滑杆都带 `min-w-0`（需求 8）：flex 子项默认 `min-width: auto`，`<input type="range">`
            的固有宽度约 129 px，窄屏上它不肯收缩，整排控件被挤出视口。390 px 视口下可用 358 px，
            四个按钮 36 + 40 + 40 + 36 加 4 处 12 px 间距后区块剩 158 px，扣去两个 `w-10` 与
            两处 8 px 间距，滑杆约 62 px。
          */}
          <div className="flex-1 min-w-0 flex items-center space-x-2 sm:space-x-3">
            <span className="text-xs font-mono text-[var(--text-muted)] w-10 text-right truncate">
              {contentPosition + 1}
            </span>
            <input
              type="range"
              min="0"
              max={contentTotal - 1}
              value={contentPosition}
              onChange={(e) => goToContentPosition(parseInt(e.target.value, 10))}
              aria-label="章节进度"
              className="flex-1 min-w-0 h-1.5 bg-[var(--hover)] rounded-lg appearance-none cursor-pointer accent-blue-500"
            />
            <span className="text-xs font-mono text-[var(--text-muted)] w-10 truncate">
              {contentTotal}
            </span>
          </div>

          {/* Quick Search button in footer */}
          <button
            onClick={() => setIsSearchOpen((prev) => !prev)}
            className="px-2.5 py-1.5 rounded-lg border border-[var(--border)] text-xs font-medium flex items-center space-x-1 hover:bg-[var(--hover)] shrink-0"
            title="全文检索 (F)"
          >
            <Search className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">全书搜索</span>
          </button>

          {/* Next Chapter */}
          <button
            onClick={() => goToRelativeChapter(1)}
            disabled={isLastContentChapter}
            className="p-2 rounded-lg hover:bg-[var(--hover)] disabled:opacity-30 transition-colors shrink-0"
            aria-label="下一章"
            title={family === "scroll" ? "下一章 (→)" : "下一章"}
          >
            <ChevronRight className="w-5 h-5" />
          </button>
        </div>
      </footer>

      {/* 边界提示：常驻的实时区域，位于底栏上方居中；没有提示时不占任何像素（需求 3.8） */}
      <BoundaryNotice text={boundaryNotice.text} />

      {/* 4. Left TOC Navigation Drawer */}
      <NavigationDrawer
        isOpen={isTocOpen}
        bookId={bookId || ""}
        bookTitle={toc.title}
        author={toc.author}
        chapters={toc.chapters}
        // 列表要渲染全部节点（卷节点在目录里看得见，任务 38），但计数只认正文（需求 12.4）。
        // 由这里传入而不是在抽屉里自己数：全站的正文口径只出自 `chapterViews` 一处。
        contentTotal={contentTotal}
        currentChapterId={currentChapterIndex}
        onClose={() => setIsTocOpen(false)}
        onSelectChapter={goToChapter}
        onSelectBookmark={handleSelectBookmark}
      />

      {/* 5. In-Book Full-Text Search Drawer (Koodo style) */}
      <SearchDrawer
        isOpen={isSearchOpen}
        fullText={fullText}
        chapters={toc.chapters}
        onClose={() => setIsSearchOpen(false)}
        onSelectResult={handleSelectSearchResult}
      />

      {/* 6. Right Reader Settings Drawer */}
      <SettingDrawer
        isOpen={isSettingOpen}
        settings={settings}
        onClose={() => setIsSettingOpen(false)}
        onUpdateSettings={handleUpdateSettings}
        // 整本下载（需求 9.1）。正文未就绪时传 null 而不是一个会静默 return 的函数：
        // 抽屉据此置灰按钮，读者不会按下一个什么也不做的按钮。
        onDownloadBook={fullText === null ? null : handleDownloadBook}
        downloadFileName={downloadFileName}
      />
    </div>
  );
};
