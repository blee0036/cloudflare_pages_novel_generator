import React, {
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useMemo,
  useCallback,
} from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import {
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  AlertCircle,
  List,
  Search,
} from "lucide-react";
import { BookToc, ChapterMeta } from "../types";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import {
  getStoredSettings,
  saveStoredSettings,
  getBookProgress,
  saveBookProgress,
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
  Para,
  bodyParagraphs,
  buildChapterViews,
  contentChapterAt,
  contentPositionOf,
  findParaIndex,
  previewAt,
  progressPercentAt,
  resolveHighlight,
  resolveJumpTarget,
  splitParagraphs,
  stepContentChapter,
  txtUrl,
  upperBound,
} from "../utils/locator";
import {
  ChapterEdge,
  PageDirection,
  chapterEdgeScrollTop,
  lineScrollTarget,
  pageScrollTarget,
} from "../utils/pageScroll";
import { preventsDefault, readerAction } from "../utils/shortcuts";
import { CHAPTER_PARAM, parseUrlChapter, withChapterParam } from "../utils/readerUrl";
import { initialPosition } from "../utils/readerPosition";
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

/**
 * 视口顶端的"判定线"相对滚动容器顶边的距离（design §3.3 的 `TOP_BIAS`）。
 *
 * 取 56 = 顶栏 `Header` 的 `h-14`。滚动时以 `scrollTop + TOP_BIAS` 为线，取顶端不低于
 * 该线的最后一段作为"视口首个可见段落"；恢复位置时反过来令 `scrollTop = tops[i] - TOP_BIAS`
 * （任务 36）。两个方向共用一个常数，来回换算才是自洽的。
 *
 * 判定线略高于顶栏底边是有意的：宁可选中"顶端刚被顶栏压住、主体仍可见"的那一段，
 * 也不要选中它上面那段可能已经完全滚出视口的段落。
 */
const TOP_BIAS = 56;

/**
 * 停止滚动多久后把位置落盘（需求 2.2 的"滚动停止超过 1 秒"）。
 *
 * 每次滚动都重排这个定时器，所以连续翻阅期间一次都不会写；真正停下来才写一次。
 * 取值不宜再小：localStorage 是同步 API，写在滚动尾声更可能撞上读者继续滚动。
 */
const SAVE_DEBOUNCE_MS = 1000;

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
 * 待渲染的命中高亮（design §3.6）。
 *
 * 存的是**章内字符偏移**而不是段落下标：段落集合会随排版重算（`bodyParas` 是 memo），
 * 而偏移是稳定的坐标。换算成"第几段 + 段内起点"由 `resolveHighlight` 在渲染时做。
 *
 * `chapterId` 是给自己定身份用的：读者翻到别的章时这条高亮就不该再出现，即便 5 秒还没到。
 */
interface HighlightTarget {
  chapterId: number;
  charOffset: number;
  length: number;
}

export const ReaderPage: React.FC = () => {
  const { bookId } = useParams<{ bookId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
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
   * 代价是标题在 `_toc.json` 到手之前还是站点名——那一段正是"正在流式解压书籍"的加载页，
   * 此时书名确实尚不可知，显示站点名比显示一个 slug 或空标题都对。
   *
   * 返回书架时不需要在这里恢复：书架自己也声明标题（见 hooks/useDocumentTitle.ts）。
   */
  useDocumentTitle(toc?.title);

  // Active Chapter & Page State
  const [currentChapterIndex, setCurrentChapterIndex] = useState<number>(0);
  /**
   * **最近一次决定的**当前章号：`setCurrentChapterIndex` 只有两处调用（首次定位与 `jumpTo`），
   * 两处都先写这里再写 state，于是它要么等于 `currentChapterIndex`，要么领先它一次提交。
   *
   * 领先的那一拍正是它存在的理由（design §6，需求 7.9）：定位 effect 因外部改动的 `ch` 调了
   * `jumpTo` 之后，同一次 effect 冲刷里紧接着跑的写回 effect 闭包里还是旧章号；若照旧章号
   * 写回，会把读者刚要跳去的 `ch` 改回去，随后两边来回拉扯。写回 effect 见到二者不等就等下一次
   * 提交；定位 effect 用它判断"外部给的章是不是当前章"，不必把 `currentChapterIndex` 列进依赖。
   */
  const currentChapterRef = useRef(0);
  /**
   * 本组件最后一次处理过、或写回的 `ch` 原文（`null` = 参数缺省），design §6 的 S3。
   *
   * 用来区分"自己的写回"与"外部改动"：写回 effect 发起导航之前先把目标值记在这里，导航落地后
   * `searchParams` 变化回到定位 effect，命中 `raw === urlChRef.current` 原地返回（需求 7.3）；
   * 外部改出来的值对不上它，才当作一次跳转请求处理（需求 7.9）。
   *
   * 写回 effect 也拿它（而不是渲染时的 `searchParams`）判断 URL 是否已是当前章：`replace` 导航
   * 包在 transition 里，落地前的渲染读到的 `searchParams` 还是旧值。连按 `→` `←` 时当前章恰好
   * 回到旧值，按 `searchParams` 判会以为"已一致"而不写，随后落地的 `→` 那次写回就被误当成外部
   * 改动、把读者拽回去。
   */
  const urlChRef = useRef<string | null>(null);
  /**
   * 当前位置的章内字符偏移（需求 2.1）。与 `currentChapterIndex` 一起构成阅读位置的
   * 唯一真相：谁移动了位置就改这两个 state（章节导航、`?ch=` 跳转、进度恢复、停止滚动后的
   * 提交），落盘则统一由下面那个 effect 负责，因此不会有两条路径写出互相矛盾的记录。
   *
   * 滚动过程**不进** state：rAF 只更新 `pendingOffsetRef`（任务 34），停止滚动 1 秒后才
   * 提交一次，所以连续滚动期间零渲染。
   *
   * 它表示"读者在哪"，**不**表示"该把视口移到哪"——后者是下面 `pendingRestore` 那条
   * 一次性指令。两者分开，才使改字号时重新测量不会顺手把读者拽回打开时的位置。
   */
  const [charOffset, setCharOffset] = useState<number>(0);
  /**
   * 一次性的"把视口移到这个位置"指令，落地即消费（任务 36，design §3.4）。
   * `null` = 没有待恢复的位置，绝大多数时间都是 null。
   *
   * **为什么是一次性指令，而不是"每次测量后都对齐 `charOffset`"**：`measure()` 有五个
   * 失效时机（换章、`ResizeObserver`、排版设置、全屏、字体就绪），恢复若挂在测量之后，
   * 读者读到第 300 段时改一次字号就会被拽回打开时的位置。需求 2.4 说的是**跨会话**——
   * 改了字号再打开仍落在同一段落（字符偏移天然满足，与像素比例的根本差别就在这），
   * 不是会话内跟着重排再滚一次：那时读者的眼睛已经在屏幕上某处，不该动它。
   *
   * 所以恢复只由"位置来源"显式发起：本任务是进度恢复，任务 40 / 41 的检索与书签跳转
   * 将复用同一个通道。`JumpTarget` 正是 design §3.5 给这三个来源定的统一形状——
   * 恢复路径不读 `highlightLength`（那是任务 40 的事）。
   */
  const [pendingRestore, setPendingRestore] = useState<JumpTarget | null>(null);
  /**
   * 检索命中高亮，`null` = 不高亮（需求 2.5）。
   *
   * 与 `pendingRestore` 同由 `jumpTo` 写入，但生命周期不同：那个落地即消费，这个要在屏幕上
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

  // 滚动容器（`<main>`）。既存的同步路径（跳章时复位 scrollTop）继续读这个 ref。
  const contentContainerRef = useRef<HTMLElement | null>(null);

  // 同一个元素再进一份 state：loading / error 分支会提前 return，`<main>` 那时还不存在，
  // 依赖 `[]` 的监听类 effect 只会拿到 null 且永不重跑。用 state 当依赖，元素挂载时
  // effect 自然重跑一次。`<article>` 同理（供 ResizeObserver 用）。
  const [scrollerEl, setScrollerEl] = useState<HTMLElement | null>(null);
  const [articleEl, setArticleEl] = useState<HTMLElement | null>(null);

  const attachScroller = useCallback((el: HTMLElement | null) => {
    contentContainerRef.current = el;
    setScrollerEl(el);
    // 从滚动过的书架页进来时，文档还停在书架的 scrollTop 上（需求 2.3）。正文分支的
    // 根容器已钉成一屏高，文档此刻不可滚，浏览器本会把它夹到 0；这里显式归零，行为
    // 不依赖夹取。ref 回调在提交阶段的 layout 时段执行，早于绘制，读者看不到中间态。
    if (el) {
      const docScroller = document.scrollingElement;
      if (docScroller) docScroller.scrollTop = 0;
    }
  }, []);

  // Which book the initial position has already been resolved for. Keeps the
  // positioning effect from clobbering in-reader navigation when it re-runs for
  // a reason other than an externally changed `?ch=`.
  //
  // 它同时是 URL 写回 effect 的闸门（需求 7.1）：初始位置定下来之前，`currentChapterIndex`
  // 还是占位的 0，此时写回会把 URL 上的 `?ch=` 冲掉。
  //
  // 任务 35 把它从 ref 改成 state，因为进度落盘 effect 需要把它当闸门用：`toc` 到位的
  // 那一次提交里章号还是 0、偏移还是 0，若此时就落盘，会把"第 500 章 / 偏移 12345"的
  // 记录覆盖成章首——正好在恢复它之前（任务 36）。ref 的变化不会让落盘 effect 重跑，
  // 因此闸门必须是 state。
  const [positionedBook, setPositionedBook] = useState<string | null>(null);

  // 1. Load Book TOC and Decompress Book File.
  //    Keyed on `bookId` only — this effect downloads and decompresses the
  //    whole book, so it must never re-run on a mere URL query change.
  //    Chapter positioning lives in the separate effect below.
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

  // 2. 定位与 URL 写回（需求 7，design §6）两个 effect 声明在 `jumpTo` 之后：定位 effect 的
  //    依赖数组在渲染时就要读 `jumpTo`，提前声明会撞上 `const` 的暂时性死区。

  // Current Chapter Object
  const currentChapter: ChapterMeta | undefined = toc?.chapters[currentChapterIndex];

  // 本章原文。**不得 `.trim()`**：那会把段落偏移整体平移，使
  // `chapter.start + para.offset` 不再是有效的全局偏移，定位基准当场失效
  // （design §3.1）。前导空白由 `splitParagraphs` 的空段落过滤自然跳过。
  const chapterText = useMemo(() => {
    if (!fullText || !currentChapter) return "";
    return fullText.slice(currentChapter.start, currentChapter.end);
  }, [fullText, currentChapter]);

  // 带章内偏移的段落（需求 2.1）。进度保存/恢复、检索跳转、书签都以这些偏移为基准。
  const paras = useMemo(() => splitParagraphs(chapterText), [chapterText]);

  // 渲染用的正文段落：跳过与标题重复的首段，修复 E10（标题显示两次）。
  const bodyParas = useMemo(
    () => bodyParagraphs(paras, currentChapter?.title),
    [paras, currentChapter]
  );

  /**
   * 命中高亮在本章段落里的落点（需求 2.5、design §3.6）。
   *
   * 每次排版变化都重算——`bodyParas` 变了就重算，这正是把高亮存成"偏移 + 长度"而不是
   * "第几段"的用处。章号对不上（读者翻走了）一律不渲染，不必等 5 秒定时器。
   *
   * `null` 的来源有三种，对读者都表现为"没有高亮但位置跳对了"：没有待高亮的命中、
   * 命中落在被跳过的标题行上（`bodyParas` 里没有它，`resolveHighlight` 判 `null`）、
   * 命中落在段间空白里。
   */
  const highlight = useMemo(() => {
    if (!highlightTarget || highlightTarget.chapterId !== currentChapterIndex) return null;
    return resolveHighlight(bodyParas, highlightTarget.charOffset, highlightTarget.length);
  }, [highlightTarget, currentChapterIndex, bodyParas]);

  // 高亮 5 秒后自动清除（需求 2.5）。换一条命中会让本 effect 重跑，定时器随之重排——
  // 连点两条结果时第二条同样能亮满 5 秒。另一条清除路径在 `jumpTo`（外部改 `?ch=` 也经它）
  // 与首次定位里。
  useEffect(() => {
    if (!highlightTarget) return;
    const timer = setTimeout(() => setHighlightTarget(null), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlightTarget]);

  // ===========================================================================
  // 段落几何测量：offsetTop 缓存 + 失效（design §3.3，需求 3.6 / 2.2）
  //
  // 约定：**滚动路径上一次布局都不读**。各段的 `offsetTop` 在渲染后、以及每个可能
  // 改变排版的事件后一次性缓存进 `topsRef`，滚动时只读 `scrollTop`（滚动位置，不是
  // 几何量）并在这个升序数组上二分。一章的段落数不过几十到几百，这么短的
  // 数组加一次二分的成本可以忽略——这也是不用 IntersectionObserver 的原因：那要给
  // 每个段落挂一个 observer，回调还是异步的，状态同步反而更难做（design §3.3）。
  //
  // `pendingOffsetRef` 的消费者是下面的"停止滚动 1 秒后落盘"（需求 2.2）；
  // 任务 36 的恢复位置读 `topsRef`。
  // ===========================================================================

  /** 各正文段落的 `offsetTop`，下标与 `bodyParas` 对齐，升序。 */
  const topsRef = useRef<number[]>([]);
  /** 段落 DOM 元素，下标与 `bodyParas` 对齐。 */
  const paraElsRef = useRef<(HTMLParagraphElement | undefined)[]>([]);
  /** 当前 `bodyParas` 的镜像，供事件回调读取（避免 effect 依赖整章段落数组）。 */
  const bodyParasRef = useRef<readonly Para[]>([]);
  /**
   * 滚动算出的"视口首个可见段落"章内偏移，等待落盘。
   *
   * `null` 的含义是"没有未消费的滚动结果"——提交成 state 后、换章时都会置回 null，
   * 卸载补写正是靠这个空值判断有没有漏掉的位置。
   */
  const pendingOffsetRef = useRef<number | null>(null);
  /** 最近一次滚动事件读到的 `scrollTop`，交给 rAF 里的纯计算使用。 */
  const lastScrollTopRef = useRef(0);
  /** 已排队的 rAF 句柄，非 null 表示本帧已有待执行的滚动处理。 */
  const scrollRafRef = useRef<number | null>(null);

  /**
   * 一次性测量全部段落顶端位置。
   *
   * `offsetTop` 相对 offsetParent 的内边距边——`<main>` 带 `relative`，正是滚动容器
   * 本身，而 `scrollTop === 0` 对应的也是它的内边距边。两个原点重合，所以
   * `tops[i]` 直接就是"把第 i 段顶到容器顶边所需的 scrollTop"。
   */
  const measure = useCallback(() => {
    const els = paraElsRef.current;
    const count = bodyParasRef.current.length;
    const tops = new Array<number>(count);

    let prev = 0;
    for (let i = 0; i < count; i++) {
      const el = els[i];
      // 元素缺失（ref 尚未挂上/已卸下）时沿用上一个值：宁可让该段与前一段同位，
      // 也不能让数组失去升序——升序是二分的前提。
      if (el) prev = el.offsetTop;
      tops[i] = prev;
    }

    topsRef.current = tops;
  }, []);

  /**
   * 按下标缓存段落 ref 回调。
   *
   * 每个下标复用同一个函数，identity 跨渲染稳定；否则 React 每次渲染都要把旧 ref
   * 置 null 再挂新的，白白多两次调用。
   */
  const paraRefSetters = useRef(
    new Map<number, (el: HTMLParagraphElement | null) => void>()
  );
  const paraRef = useCallback((index: number) => {
    let setter = paraRefSetters.current.get(index);
    if (!setter) {
      setter = (el: HTMLParagraphElement | null) => {
        paraElsRef.current[index] = el ?? undefined;
      };
      paraRefSetters.current.set(index, setter);
    }
    return setter;
  }, []);

  // 失效时机 ①：段落集合变化（章节切换即走这里——`bodyParas` 随 `chapterText` 重算）。
  // 用 layout effect：子元素的 ref 在父组件 layout effect 之前挂好，因此这里读到的
  // 已是本章的段落，且测量发生在浏览器绘制之前——任务 36 的恢复位置要靠这一点才不闪。
  useLayoutEffect(() => {
    bodyParasRef.current = bodyParas;
    paraElsRef.current.length = bodyParas.length; // 丢掉上一章多出来的元素引用
    pendingOffsetRef.current = null; // 上一章算出的待落盘偏移就地作废
    measure();
  }, [bodyParas, measure]);

  // 失效时机 ②：`<article>` 尺寸变化。窗口缩放、版心过渡动画中途、以及任何
  // 未被下面几条显式覆盖到的重排都由它兜住（含 Safari 的前缀全屏事件）。
  // measure 只读不写布局，不会形成 ResizeObserver 回调循环。
  useEffect(() => {
    if (!articleEl) return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(articleEl);
    return () => observer.disconnect();
  }, [articleEl, measure]);

  // 失效时机 ③：排版类设置变化。`<article>` 的行内样式在同一次渲染里已更新，
  // layout effect 读到的就是新布局。字间距这类不改变总高度的变化不一定触发
  // ResizeObserver，所以必须显式列出这五项。
  useLayoutEffect(() => {
    measure();
  }, [
    measure,
    settings.fontSize,
    settings.lineHeight,
    settings.letterSpacing,
    settings.contentWidth,
    settings.fontFamily,
  ]);

  // 失效时机 ④：全屏切换（顶栏里的按钮与 F11 都会派发此事件，阅读器无需知道是谁触发的）。
  useEffect(() => {
    const onFullscreenChange = () => measure();
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, [measure]);

  // 失效时机 ⑤：字体加载完成。首屏常以后备字体排版，字体到位后行高与段高都会变。
  // 依赖里带上 `fontFamily`：切到楷体/宋体可能触发新一轮字体加载。
  useEffect(() => {
    const fonts: FontFaceSet | undefined = document.fonts;
    if (!fonts) return;

    let isCancelled = false;
    fonts.ready
      .then(() => {
        if (!isCancelled) measure();
      })
      .catch(() => {
        /* 字体加载失败不影响排版测量，后备字体的布局已由其他时机覆盖 */
      });

    return () => {
      isCancelled = true;
    };
  }, [measure, settings.fontFamily]);

  // ===========================================================================
  // 位置恢复（design §3.4，需求 2.3 / 2.4）
  // ===========================================================================

  /**
   * 消费 `pendingRestore`：把目标偏移所在段落移到判定线上。
   *
   * 必须是 **layout effect**，且必须声明在上面那几个 `measure()` 之后——同一次提交里
   * 它们先跑，这里读到的 `topsRef` 就是本章的新几何；而赋值发生在浏览器绘制之前，
   * 读者不会先看见章首再被弹到目标段落（design §3.3 末句所指的"不闪"）。
   *
   * deps 里没有 `charOffset`：恢复读的是指令里的偏移，不是那个随滚动持续变化的 state。
   * 也正因如此，滚动、改设置、`ResizeObserver` 重新测量都不会让这里再跑一次。
   *
   * 三种情况不消费指令，各有各的理由：
   * - **章号与当前章不符**：读者在恢复落地前已自己翻走 → 指令过期，丢弃，不抢他的位置；
   * - **正文还没渲染出来**（`.txt.gz` 尚未解压完，`bodyParas` 为空）：指令继续挂着，
   *   等 `bodyParas` 到位的那次提交再来；
   * - **滚动容器不存在**（loading / error 分支提前 return 了 `<main>`）：同上。
   */
  useLayoutEffect(() => {
    if (!pendingRestore) return;

    if (pendingRestore.chapterId !== currentChapterIndex) {
      setPendingRestore(null);
      return;
    }

    const scroller = contentContainerRef.current;
    const tops = topsRef.current;
    // 长度不等 = 这一帧的测量还没跟上段落集合，读 `tops[i]` 会拿到 undefined（scrollTop
    // 变 NaN）。等下一次提交，不猜。
    if (!scroller || !bodyParas.length || tops.length !== bodyParas.length) return;

    setPendingRestore(null);

    const index = findParaIndex(bodyParas, pendingRestore.charOffset);

    // 目标是首个正文段，或落在它之前——章首、v1 记录补的偏移 0、被跳过的标题行（需求 2.8）。
    // 这时显示章首（`scrollTop` 为 0），让 `<h1>` 一起进视野，而不是把它顶到视口之上。
    // 这也正是保存的逆：`scrollTop` 为 0 时判定线之上的最后一段就是首段，记下的是它的偏移；
    // 若按判定线恢复，会停在章首之下 `tops[0] − TOP_BIAS` 处。没有标题行的章节（如"序章 /
    // 前言"）首段偏移就是章首，没有进度时同样落到这里（reader-defect-fixes 需求 7.6）。
    if (index === 0) {
      scroller.scrollTop = 0;
      return;
    }

    // 与保存完全互逆的一步：保存取的是"顶端不低于 `scrollTop + TOP_BIAS` 的最后一段"
    // （design §3.3），恢复就把那一段的顶端放回同一条判定线上。两个方向共用 TOP_BIAS，
    // 于是"恢复 → 浏览器补一次 scroll 事件 → 1 秒后落盘"算出的仍是这一段，记录自洽。
    //
    // 直接赋值 `scrollTop` 而不是 `scrollIntoView`：后者带平滑滚动动画（一打开书就当着
    // 读者的面滚几千像素），也无法精确控制 TOP_BIAS（design §3.4）。
    scroller.scrollTop = Math.max(0, tops[index] - TOP_BIAS);
  }, [pendingRestore, currentChapterIndex, bodyParas]);

  // ===========================================================================
  // 进度保存（design §3.3 / §3.7，需求 2.2 / 2.7）
  // ===========================================================================

  /** "停止滚动 1 秒"的防抖句柄。每次滚动重排，卸载与提交时清掉。 */
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * 把滚动算出的待落盘偏移提交成 state，随后由落盘 effect 写盘。
   *
   * 提交前把 `pendingOffsetRef` 置空，于是"已消费"这件事只有一个表示。偏移与当前 state
   * 相同时 React 自行 bail out，不重渲染也不落盘——在同一段内来回小幅滚动因此完全免费。
   *
   * identity 稳定（deps `[]`），滚动 effect 才不必因它重订阅。
   */
  const commitPendingOffset = useCallback(() => {
    const pending = pendingOffsetRef.current;
    if (pending === null) return;
    pendingOffsetRef.current = null;
    setCharOffset(pending);
  }, []);

  // 滚动处理：rAF 节流，路径上零布局读取（需求 3.6）。
  useEffect(() => {
    if (!scrollerEl) return;

    const onScroll = () => {
      // 滚动事件派发时 `scrollTop` 已是最新值，读它不触发重排；几何量
      // （offsetTop / getBoundingClientRect）一概不在这条路径上。
      lastScrollTopRef.current = scrollerEl.scrollTop;

      // 本帧已排队 → 丢掉这次调度，但上面那行仍更新了位置，
      // 所以待执行的那一帧读到的永远是最新的 scrollTop。
      if (scrollRafRef.current !== null) return;

      scrollRafRef.current = requestAnimationFrame(() => {
        scrollRafRef.current = null;

        const tops = topsRef.current;
        const currentParas = bodyParasRef.current;
        if (!tops.length || !currentParas.length) return;

        // 视口首个可见段落 = 顶端不低于判定线的最后一段（design §3.3）。
        const index = Math.max(0, upperBound(tops, lastScrollTopRef.current + TOP_BIAS) - 1);
        pendingOffsetRef.current = currentParas[index]?.offset ?? null;

        // 停止滚动 1 秒后落盘（需求 2.2）。定时器排在 rAF 里而不是 scroll 回调里：
        // 要保存的是"最后一帧算出的那个位置"，两者在同一处排队才不会写出上一帧的结果。
        if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(() => {
          saveTimerRef.current = null;
          commitPendingOffset();
        }, SAVE_DEBOUNCE_MS);
      });
    };

    scrollerEl.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scrollerEl.removeEventListener("scroll", onScroll);
      if (scrollRafRef.current !== null) {
        cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
    };
  }, [scrollerEl, commitPendingOffset]);

  /**
   * 当前位置的阅读百分比：`(chapter.start + charOffset) / charCount`（需求 2.7）。
   *
   * 顶栏显示与落盘写入的是同一个数，两处口径不可能漂移。旧的
   * `(chapterIndex + 1) / totalChapters` 就此退场——同一本书的章长可以相差几个数量级，
   * 章号比例失真严重（design §3.7）。
   */
  const progressPercent = useMemo(() => {
    if (!toc || !currentChapter) return 0;
    return progressPercentAt(currentChapter.start + charOffset, toc.charCount);
  }, [toc, currentChapter, charOffset]);

  /**
   * 写一条进度记录（design §2.3）。
   *
   * `offset` 显式传入而不是直接读 `charOffset`：卸载补写要写的是尚未提交成 state 的那个
   * 待落盘偏移，那时 state 已经不会再更新了。
   *
   * 条数上限与淘汰由 `saveBookProgress` 负责（任务 31），这里不管。
   */
  const writeProgress = useCallback(
    (offset: number) => {
      if (!bookId || !currentChapter || !toc) return;
      saveBookProgress({
        bookId,
        chapterId: currentChapter.id,
        chapterTitle: currentChapter.title,
        charOffset: offset,
        // 保存时就算好，书架因此无需为了显示百分比去加载 toc（design §2.3）
        progressPercent: progressPercentAt(currentChapter.start + offset, toc.charCount),
        lastReadTime: Date.now(),
        v: 2,
      });
    },
    [bookId, currentChapter, toc]
  );

  // 位置变化即落盘：停止滚动后的提交走这里，章节切换也走这里——短章节读者可能一次都没滚过，
  // 但"上次读到哪一章"仍必须进书架。
  //
  // `positionedBook` 是闸门（见其声明处）：初始位置还没解析出来时一个字也不写，免得把
  // 待恢复的记录覆盖成"第 0 章 / 章首"。
  useEffect(() => {
    if (positionedBook !== bookId) return;
    writeProgress(charOffset);
  }, [positionedBook, bookId, charOffset, writeProgress]);

  /**
   * 卸载补写用的镜像。每次渲染刷新，因此闭包里的章与偏移永远是最新的，
   * 而下面那个 effect 的 deps 可以是 `[]`（只想在卸载时跑一次）。
   */
  const flushProgressRef = useRef<() => void>(() => {});
  useEffect(() => {
    flushProgressRef.current = () => {
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      const pending = pendingOffsetRef.current;
      pendingOffsetRef.current = null;
      // 没有未消费的滚动结果，或它与已落盘的偏移相同 → 落盘 effect 已经写过了
      if (pending === null || pending === charOffset) return;
      if (positionedBook !== bookId) return;
      writeProgress(pending);
    };
  });

  // 离开阅读器（返回书架 / 切到另一本书）时补写：防抖那 1 秒不该让读者丢掉最后一屏的位置。
  //
  // 换章不需要补写：`pendingOffsetRef` 在段落集合变化的 layout effect 里已被清空，而每书
  // 只有一条记录，旧章的偏移写出去也会立刻被新章那次落盘覆盖。
  useEffect(() => () => flushProgressRef.current(), []);

  // Sync bookmark state with current chapter
  useEffect(() => {
    if (bookId && currentChapter) {
      setIsBookmarked(isChapterBookmarked(bookId, currentChapter.id));
    }
  }, [bookId, currentChapter]);

  /**
   * 读者此刻所在的章内偏移，**含尚未提交成 state 的那一帧**（需求 2.6）。
   *
   * 滚动算出的偏移要等"停止滚动 1 秒"才进 `charOffset`（任务 35），而按书签这个动作往往
   * 紧跟在滚动之后——那一秒里 state 还是上一次提交的旧位置，直接读它会把书签存到读者刚刚
   * 划过的某一段上。落盘路径上的卸载补写是同一个道理（`flushProgressRef`）。
   *
   * 只读不清：清空 `pendingOffsetRef` 是防抖提交与换章的职责，这里顺手清掉会让本该落盘的
   * 那次进度更新丢一拍。
   */
  const liveCharOffset = (): number => {
    const pending = pendingOffsetRef.current;
    return pending === null ? charOffset : pending;
  };

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
      const offset = liveCharOffset();
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
   * **统一跳转入口**（design §3.5）：读者发起的每一次位置移动都走这里——目录点击、底部滑杆、
   * 上下章、检索命中（本任务）、书签（任务 41）。进度恢复是唯一的例外，它在定位 effect 里
   * 直接写 state（还要同时立起 `positionedBook` 闸门），但发出的同样是一条 `JumpTarget`
   * 指令，落地走的也是同一个 layout effect。
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
      currentChapterRef.current = resolved.chapterId;
      setCurrentChapterIndex(resolved.chapterId);
      setCharOffset(resolved.charOffset);
      // 防住"上一章算出的偏移被换章后才触发的防抖提交带进新章"
      pendingOffsetRef.current = null;
      // 章首（偏移 0）不需要恢复指令：下面那句 `scrollTop = 0` 当场就是正确位置，不必等测量。
      // 顺带也保住了"章节导航看得见 `<h1>`"——恢复路径会把目标段顶到判定线上，章首用不着。
      //
      // 非章首目标则挂上指令，由恢复 layout effect 在测量完成后把命中段滚入视口（需求 2.5）。
      // 读者自己翻章时这里传的是 null，正好也把上一条待恢复的位置作废：`jumpTo(当前章)`
      // （滑杆拖回原处）不改 `currentChapterIndex`，恢复 effect 的过期判定看不出异常。
      setPendingRestore(resolved.charOffset > 0 ? resolved : null);
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
      if (contentContainerRef.current) {
        contentContainerRef.current.scrollTop = 0;
      }
      triggerShowControls();
    },
    [chapterViews, triggerShowControls]
  );

  // ===========================================================================
  // 定位与 URL 写回（design §6，需求 7；S3）
  //
  // 两个 effect 各管一个方向，以 `urlChRef` 区分"自己的写回"与"外部改动"：
  // - 定位 effect 只处理**外部给出**的 `ch`：首次定位时 URL 上的那个，以及之后经应用内导航
  //   改出来的（`popstate` 等，需求 7.9）。读者自己换章不经过这里——那些路径直接走 `jumpTo`。
  // - 写回 effect 只负责把当前章以 `replace` 写进 URL（需求 7.1、D2）。全部换章路径最终都改
  //   `currentChapterIndex`，写回因此只有这一个出口。
  //
  // 声明顺序有意义：同一次 effect 冲刷里定位先跑、写回后跑，写回读到的 `urlChRef` /
  // `currentChapterRef` 已是定位 effect 处理过本次 `searchParams` 之后的值。
  // ===========================================================================

  // 定位：首次定位，或响应外部改动的 `ch`。
  //
  // 依赖里有 `searchParams`，同一本书内改 `?ch=` 会重新定位而不重新下载（RC 1.5）；加载 effect
  // 只认 `bookId`。`jumpTo` 只随 `chapterViews` 与 `triggerShowControls`（identity 稳定）变化，
  // 换章不会让本 effect 重跑；即使重跑，也因 `raw === urlChRef.current` 直接返回。
  useEffect(() => {
    if (!bookId || !toc) return;
    // 全是卷节点的异常数据：没有任何章可定位，一个字也不写（包括不动已存的进度记录、不写回
    // URL——`positionedBook` 不立起来），由错误页接手（需求 12.6）。
    if (!hasContentChapters) return;

    const raw = searchParams.get(CHAPTER_PARAM);
    const chapterCount = toc.chapters.length;

    if (positionedBook !== bookId) {
      // 首次定位：URL 章号与已存进度按 D3 / RC 12.5 合成唯一的（章号, 偏移）——有效 `?ch=`
      // 指向进度所在章时恢复章内偏移（7.5），指向另一章或没有进度时落在章首（7.6、EV 9.12），
      // 缺省或无效时按进度恢复；卷节点一律归一到其后第一个正文章节。
      const target = initialPosition(
        chapterViews,
        chapterCount,
        parseUrlChapter(raw, chapterCount),
        getBookProgress(bookId)
      );
      // 上面已判过 `hasContentChapters`，这里不会是 null；判一次只为类型收窄
      if (target === null) return;

      // 记下这次处理过的原文：写回 effect 随后若要改写它（无效、卷节点、或缺省），改写后的
      // 值也会先记在这里，落地时本 effect 原地返回，不会把首次定位再做一遍。
      urlChRef.current = raw;
      currentChapterRef.current = target.chapterId;
      setPositionedBook(bookId);
      setCurrentChapterIndex(target.chapterId);
      setCharOffset(target.charOffset);
      setHighlightTarget(null);
      // 位置本身即刻生效（百分比、落盘都读 state）。章内偏移 > 0 时发一条一次性的恢复指令，
      // 由恢复 layout effect 在段落渲染并测量完成后把视口移过去——位置（state）与"移动视口"
      // （指令）必须分开，否则每次重排都会把读者拽回原处。章首用不着指令：`scrollTop = 0`
      // 当场就是正确位置（`<main>` 尚未挂载时它本来就从 0 开始）。
      if (target.charOffset > 0) {
        setPendingRestore(target);
      } else {
        setPendingRestore(null);
        if (contentContainerRef.current) {
          contentContainerRef.current.scrollTop = 0;
        }
      }
      return;
    }

    // 自己的写回落地，或 `ch` 没变：不碰 `scrollTop`、高亮与待恢复的位置（需求 7.3）
    if (raw === urlChRef.current) return;
    urlChRef.current = raw;

    const urlChapter = parseUrlChapter(raw, chapterCount);
    // 无效（缺省、非数字、负数、越界）：位置不动，写回 effect 随后把 URL 改回当前章
    if (urlChapter === null) return;

    // 章内位置与首次定位同一套规则（7.9 的"按第 5、6 条确定"）
    const target = initialPosition(chapterViews, chapterCount, urlChapter, getBookProgress(bookId));
    // 归一后就是当前章（含指向当前章之前那个卷节点）：不改变当前位置（7.9）。URL 原文若与
    // 当前章号的规范写法不同（"03"、卷节点下标），由写回 effect 规整。
    if (target === null || target.chapterId === currentChapterRef.current) return;

    // 清高亮、复位 scrollTop、必要时挂恢复指令，并先行更新 `currentChapterRef`
    jumpTo(target);
  }, [bookId, toc, searchParams, positionedBook, chapterViews, hasContentChapters, jumpTo]);

  // 写回：位置已定后，URL 的 `ch` 与当前章不一致即以 `replace` 写回（需求 7.1、D2）。
  //
  // `replace` 不新增历史记录，`history.length` 不变；书架进入阅读器那一次 push 之后，一次后退
  // 仍回到进入前的页面（7.8）。函数式更新器只改 `ch`，路径与其余参数（键、值、顺序）不变
  // （`withChapterParam`，7.2）。
  //
  // 本 effect 不碰 `scrollTop`、高亮与 `pendingRestore`；导航落地后的那次渲染里，定位 effect
  // 命中 `raw === urlChRef.current` 原地返回（7.3）。
  //
  // `searchParams` 在依赖里但不在函数体里：外部把 `ch` 改成无效值时当前章不变，要靠它让本 effect
  // 重跑、把 URL 改回当前章。
  useEffect(() => {
    if (positionedBook !== bookId) return;
    // 定位 effect 刚在本次冲刷里调了 `jumpTo`，state 还是旧章：此刻写回会把读者要去的 `ch`
    // 改回旧章。`jumpTo` 那次提交会带着新的 `currentChapterIndex` 让本 effect 重跑。
    if (currentChapterRef.current !== currentChapterIndex) return;

    const want = String(currentChapterIndex);
    if (urlChRef.current === want) return;

    // 先记下要写出的值，再发起导航：导航落地时定位 effect 凭它认出这是自己的写回
    const previous = urlChRef.current;
    urlChRef.current = want;
    try {
      setSearchParams((prev) => withChapterParam(prev.toString(), currentChapterIndex), {
        replace: true,
      });
    } catch (err) {
      // Safari / Firefox 对 `history.replaceState` 限频，超限时抛 `SecurityError`（DOMException），
      // React Router 的 `replace` 不接这个异常。拖章节滑杆划过上百章就可能撞上；任它从 effect 里
      // 抛出会卸掉整个应用。这里只吞这一类：URL 没变，`urlChRef` 退回原值，下一次换章照常写回。
      if (!(err instanceof DOMException)) throw err;
      urlChRef.current = previous;
    }
  }, [positionedBook, bookId, currentChapterIndex, searchParams, setSearchParams]);

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

  /**
   * 下翻 / 上翻一屏（需求 9.4 的 `Space`、`Shift+Space`）。
   *
   * 直接赋值 `scrollTop`，不用 `scrollBehavior: smooth`：与位置恢复同一个理由——平滑滚动
   * 期间容器位置是动画中间值，而滚动路径上那条"停止滚动 1 秒后落盘"会被动画的每一帧不断
   * 重排定时器（design §3.4 拒绝 `scrollIntoView` 也是为此）。瞬时到位，读者连按也跟得上。
   *
   * 赋值会触发 `scroll` 事件，于是进度保存照常走既有那条 rAF → `pendingOffset` → 1 秒防抖
   * 的路径（任务 35）。这是对的：位置确实变了，该记下来。
   *
   * **不调 `triggerShowControls()`**：翻页是阅读动作而不是导航动作，每按一次都把底栏弹出来
   * 会正好盖住刚翻上来的最后两行，还要 4.5 秒才退回去。章节导航（`←`/`→`、章末换章）仍然
   * 亮一下控制栏——那是"换了地方"，读者需要看到新的章号与进度。
   *
   * 已在该方向尽头时 `pageScrollTarget` 返回 `null`，两个方向的处置不对称（理由写在
   * `pageScroll.ts` 的该函数上）：下翻进入下一章，上翻原地不动。
   */
  const pageScroll = useCallback(
    (direction: PageDirection) => {
      const scroller = contentContainerRef.current;
      if (!scroller) return;

      const target = pageScrollTarget(scroller, direction);
      if (target === null) {
        if (direction > 0) goToRelativeChapter(1);
        return;
      }
      scroller.scrollTop = target;
    },
    [goToRelativeChapter]
  );

  /**
   * 跳到本章章首 / 章末（需求 9.4 的 `Home`/`End`）。
   *
   * 只动滚动位置，**不动章号**：`Home` 是"回到这一章的开头"，不是"回到第一章"。整本书的
   * 两端由目录与底部滑杆负责，键盘上再塞一个跨章跳转只会让误按的代价变大（长书里一次
   * 误按就要靠进度记录找回来）。
   */
  const scrollToChapterEdge = useCallback((edge: ChapterEdge) => {
    const scroller = contentContainerRef.current;
    if (!scroller) return;
    scroller.scrollTop = chapterEdgeScrollTop(scroller, edge);
  }, []);

  /**
   * 行滚动 / 一屏滚动（需求 4.3 的 `↑`/`↓`、`PageUp`/`PageDown`）。
   *
   * 正文滚动容器是 `<main>`（D1），浏览器的默认按键滚动不保证落到它上面，所以由这里赋值
   * `scrollTop`；赋值方式与不弹控制栏的理由同 `pageScroll`。一屏的步长复用
   * `pageScrollTarget`，但到尽头（`null`）时**原地不动、不换章**——这与 `Space` 不同，
   * 需求 4.3 要求四种按键下章节都不变。
   */
  const lineScroll = useCallback((direction: PageDirection) => {
    const scroller = contentContainerRef.current;
    if (!scroller) return;
    const target = lineScrollTarget(scroller, direction);
    if (target !== null) scroller.scrollTop = target;
  }, []);

  const screenScroll = useCallback((direction: PageDirection) => {
    const scroller = contentContainerRef.current;
    if (!scroller) return;
    const target = pageScrollTarget(scroller, direction);
    if (target !== null) scroller.scrollTop = target;
  }, []);

  // Keyboard Navigation (Inspired by Koodo Reader)
  //
  // 按键 → 动作的映射（含"什么时候不接管"的三条规则）全在 `readerAction` 里，这里只负责
  // 把动作接到阅读器的能力上。抽屉打开时滚动类快捷键让给浏览器（去滚抽屉自己的列表），
  // 所以三个面板的开关状态要进 deps——effect 体只是一次 add/removeEventListener，重订阅
  // 的成本可以忽略。
  useEffect(() => {
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
        { panelOpen: isTocOpen || isSearchOpen || isSettingOpen }
      );
      if (action === null) return;

      // `Space` 必须拦住浏览器自己的翻页滚动，否则我们赋值的 scrollTop 之上还会叠一次
      // 默认滚动（见 `preventsDefault`）。
      if (preventsDefault(action)) e.preventDefault();

      switch (action) {
        case "prev-chapter":
          goToRelativeChapter(-1);
          break;
        case "next-chapter":
          goToRelativeChapter(1);
          break;
        case "page-down":
          pageScroll(1);
          break;
        case "page-up":
          pageScroll(-1);
          break;
        case "chapter-start":
          scrollToChapterEdge("start");
          break;
        case "chapter-end":
          scrollToChapterEdge("end");
          break;
        case "line-down":
          lineScroll(1);
          break;
        case "line-up":
          lineScroll(-1);
          break;
        case "screen-down":
          screenScroll(1);
          break;
        case "screen-up":
          screenScroll(-1);
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
  }, [
    goToRelativeChapter,
    pageScroll,
    scrollToChapterEdge,
    lineScroll,
    screenScroll,
    isTocOpen,
    isSearchOpen,
    isSettingOpen,
  ]);

  // Handle settings update
  const handleUpdateSettings = (newSettings: Partial<typeof settings>) => {
    const updated = { ...settings, ...newSettings };
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
   * 不做"是否要下载几十 MB"的二次确认：读者是在设置抽屉里专门找到这个按钮按下去的，意图
   * 明确；真正的大书成本在下载**这本书**时早已付过（下载 gz 的那一次），本地再写一份文件
   * 不产生流量。
   *
   * `fullText` 为 null 只在正文还没解压完时成立，而那时抽屉根本没渲染（页面停在 loading
   * 分支）。这里仍然判一次：类型上它可空，而"按钮能按但什么也没发生"比置灰难查得多。
   */
  const handleDownloadBook = useCallback(() => {
    if (fullText === null || !toc) return;
    downloadBookAsTxt(fullText, toc.title);
  }, [fullText, toc]);

  // Font family class
  const getFontFamilyStyle = () => {
    switch (settings.fontFamily) {
      case "serif":
        return "'Source Han Serif SC', 'Noto Serif SC', 'Songti SC', 'SimSun', serif";
      case "kaiti":
        return "'KaiTi', 'STKaiti', '楷体', serif";
      case "system":
      default:
        return "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei', sans-serif";
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-4 transition-colors bg-[var(--bg)] text-[var(--text)]">
        <div className="w-16 h-16 rounded-2xl bg-blue-500/10 flex items-center justify-center mb-4">
          <RefreshCw className="w-8 h-8 animate-spin text-blue-500" />
        </div>
        <h2 className="text-base font-semibold mb-1">正在流式解压书籍...</h2>
        <p className="text-xs text-[var(--text-muted)] mb-4">
          原生 Gzip 解压加速中
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
  // `_toc.json` 或规则把整本书都误判成卷。文案因此指向"重新预处理"而不是"重试"——
  // 刷新一百次也还是这份产物。
  if (!hasContentChapters) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-4 bg-[var(--bg)] text-[var(--text)]">
        <AlertCircle className="w-12 h-12 text-amber-500 mb-3" />
        <h2 className="text-lg font-bold mb-1">这本书没有可阅读的章节</h2>
        <p className="text-xs text-[var(--text-muted)] mb-6 max-w-sm text-center leading-relaxed">
          《{toc.title}》的章节表里 {toc.chapters.length} 个节点全部是卷/分部标题，
          没有任何正文章节。该书的预处理产物有误，请重新生成后再打开。
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
   * 正文滚动模型（F-002，需求 2.1 / 2.2，design §3）：`<main>` 是**唯一**的滚动容器。
   *
   * 根容器钉成一屏高（`h-dvh`）并 `overflow-hidden`，文档本身因此没有可滚的距离；
   * `<main>` 是 flex 列里唯一的流内子元素（顶栏、底栏、三个抽屉都是 `position: fixed`），
   * `flex-1 min-h-0` 让它恰好占满这一屏而不被正文撑高——缺了 `min-h-0`，flex 子项的
   * 最小高度默认是内容高度，`<main>` 会长成整章那么高，滚动又落回文档上。
   *
   * 以前根容器是 `min-h-screen`：`<main>` 随正文长高、自己从不滚动，于是所有对
   * `contentContainerRef.scrollTop` 的赋值都落空（恢复、检索、书签、翻页键），滚动监听也
   * 从不触发。现在这些读写点原样不动就都生效了。
   *
   * 根容器不能带 transform / filter / contain：那会让 fixed 子元素改以它为包含块，
   * 进而被这里的 `overflow-hidden` 裁掉。
   */
  return (
    <div
      className="h-dvh flex flex-col relative overflow-hidden select-text transition-colors duration-200 bg-[var(--bg)] text-[var(--text)]"
      onClick={triggerShowControls}
    >
      {/* 1. Floating Top Header */}
      <Header
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
      />

      {/* 2. Reader Body
          `relative` 不是装饰：它让滚动容器自己成为段落的 offsetParent，于是
          `p.offsetTop` 与 `scrollTop` 共用同一个原点（容器的内边距边），
          `tops[i]` 才能直接当 scrollTop 用（design §3.3）。去掉它的话
          offsetParent 会落到外层那个 `relative` 的根 div 上，测出来的值整体带一个
          偏移量，滚动判定与位置恢复会一起错。

          `min-h-0` 见上面根容器处的说明：没有它 `<main>` 会被正文撑高而不再滚动。 */}
      <main
        ref={attachScroller}
        className="relative flex-1 min-h-0 overflow-y-auto pt-16 pb-28 px-4 sm:px-8"
      >
        <article
          ref={setArticleEl}
          className="mx-auto transition-all duration-150"
          style={{
            maxWidth: `${settings.contentWidth}px`,
            fontFamily: getFontFamilyStyle(),
            fontSize: `${settings.fontSize}px`,
            lineHeight: settings.lineHeight,
            letterSpacing: `${settings.letterSpacing}px`,
          }}
        >
          {/* Chapter Title */}
          <header className="mb-10 pt-4 pb-6 border-b border-[var(--border)]">
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight mb-2">
              {currentChapter?.title}
            </h1>
            <div className="flex items-center text-xs text-[var(--text-muted)] space-x-3">
              {/* 正文序号，卷节点不计入（需求 12.4）：见 `contentTotal` 处的口径说明 */}
              <span>
                第 {contentPosition + 1} / {contentTotal} 章
              </span>
              <span>·</span>
              <span>{currentChapter?.length} 字</span>
            </div>
          </header>

          {/* Chapter Text Paragraphs：key 用章内偏移（章内唯一且稳定），不用下标

              命中段落拆成前 / 命中 / 后三段，命中部分用 `<mark>` 包起来（design §3.6）。
              不做 DOM 手术——高亮是渲染的一部分，改字号、换章、清除高亮都只是重新渲染，
              不需要在真实 DOM 上插删节点再想办法撤销。

              段落不设 `leading-*`：行高继承 `<article>` 行内的无单位 `lineHeight`，计算值即
              "字号 × 行高"（需求 5.1）。章节标题区不受此影响——`text-xl` / `sm:text-2xl` /
              `text-xs` 在 Tailwind v4 中各自声明 `line-height`（需求 5.3）。

              `wrap-anywhere`（`overflow-wrap: anywhere`）让书源自带的长分隔线这类没有断行机会的
              长串在版心内折行；它也计入最小内容宽度，不会把版心撑宽（需求 10.1、10.3）。汉字本就
              逐字可断，普通段落的折行不变。 */}
          <div className="space-y-6 text-justify">
            {bodyParas.map((para, index) => (
              <p
                key={para.offset}
                ref={paraRef(index)}
                className="indent-[2em] wrap-anywhere transition-colors select-text"
              >
                {highlight && highlight.paraIndex === index ? (
                  <>
                    {para.text.slice(0, highlight.offsetInPara)}
                    {/* 只改底色与字色，不动内边距与字重：那些会改变字符宽度，进而可能改变
                        本段的折行与高度，让刚测好的 `topsRef` 就地失真（design §3.3）。
                        字色取 `--text` 而非 `--accent`（F-010）：琥珀底上强调色在四套主题下不足
                        4.5:1。底色 30% 与检索抽屉相同——32% 时 black 主题的 `--text` 只有
                        4.38:1，30% 时五套主题均 ≥ 4.63:1。 */}
                    <mark className="animate-fade-in rounded bg-[rgba(234,179,8,0.3)] text-[var(--text)]">
                      {para.text.slice(
                        highlight.offsetInPara,
                        highlight.offsetInPara + highlight.length
                      )}
                    </mark>
                    {para.text.slice(highlight.offsetInPara + highlight.length)}
                  </>
                ) : (
                  para.text
                )}
              </p>
            ))}
          </div>

          {/* End of Chapter Navigation Card */}
          <div className="mt-16 pt-8 border-t border-[var(--border)] flex flex-col sm:flex-row items-center justify-between gap-4">
            <button
              onClick={() => goToRelativeChapter(-1)}
              disabled={isFirstContentChapter}
              className={`w-full sm:w-auto px-5 py-2.5 rounded-xl border border-[var(--border)] text-xs font-semibold flex items-center justify-center space-x-2 transition-all ${
                isFirstContentChapter
                  ? "opacity-30 cursor-not-allowed"
                  : "hover:bg-[var(--hover)]"
              }`}
            >
              <ChevronLeft className="w-4 h-4" />
              <span>上一章</span>
            </button>

            <span className="text-xs text-[var(--text-muted)]">
              {contentPosition + 1} / {contentTotal}
            </span>

            <button
              onClick={() => goToRelativeChapter(1)}
              disabled={isLastContentChapter}
              className={`w-full sm:w-auto px-5 py-2.5 rounded-xl border border-[var(--border)] text-xs font-semibold flex items-center justify-center space-x-2 transition-all ${
                isLastContentChapter
                  ? "opacity-30 cursor-not-allowed"
                  : "hover:bg-[var(--hover)]"
              }`}
            >
              <span>下一章</span>
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </article>
      </main>

      {/* 3. Floating Bottom Toolbar / Progress Bar (Koodo style) */}
      <footer
        className={`fixed bottom-0 left-0 right-0 h-14 z-30 transition-transform duration-300 ease-in-out border-t shadow-lg flex items-center justify-between px-4 sm:px-8 bg-[var(--bg)] text-[var(--text)] border-[var(--border)] ${
          showControls ? "translate-y-0" : "translate-y-full"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="max-w-4xl mx-auto w-full flex items-center justify-between space-x-3 sm:space-x-4">
          {/* Prev Chapter */}
          <button
            onClick={() => goToRelativeChapter(-1)}
            disabled={isFirstContentChapter}
            className="p-2 rounded-lg hover:bg-[var(--hover)] disabled:opacity-30 transition-colors shrink-0"
            title="上一章 (←)"
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
            title="下一章 (→)"
          >
            <ChevronRight className="w-5 h-5" />
          </button>
        </div>
      </footer>

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
