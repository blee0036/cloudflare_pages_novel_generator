/**
 * 全部元素定位集中于此（D8；设计"测试支撑"末条的已知锚点）。
 *
 * 规则：
 * - 只用 role（含可访问名称）、`aria-label`（经 role 名称或 `getByLabel`）与可见文本；不用
 *   `data-testid`、CSS 选择器或 DOM 层级路径，也不向 `src/` 添加任何属性。
 * - 需要在某个区域内查找时，用 role 定位到的区域作为作用域（`getByRole("article").getByRole(...)`），
 *   或以 role 过滤（`filter({ has: getByRole("mark") })`）。应用里的弹窗与三个抽屉都没有
 *   `role="dialog"` 或其他可命名的容器，所以它们不提供"容器"定位，只提供各自内部的锚点；
 *   `marker` 是判断该弹窗 / 抽屉是否打开用的唯一锚点。
 * - 名称一律精确匹配（字符串配 `exact: true`，或首尾锚定的正则）：非精确匹配是不区分大小写的
 *   子串匹配，"上一章"会同时命中"上一章 (←)"。
 * - 测量性 DOM 遍历（找滚动祖先、读网格列数等）不在本文件，由调用方从这里定位到的元素出发自行
 *   完成，且只用于度量。
 *
 * 可访问名称的来历（以 Playwright 1.62 的计算为准）：按钮先取内容文本，内容为空才退到 `title`；
 * 文本输入框无 `<label>` 时取 `placeholder`；块级子元素两侧补空格，整串空白折叠为一个空格。
 * 因此：
 * - 纯图标按钮（顶栏各按钮、底栏"上一章 (←)""下一章 (→)"、"删除此书签"）的名称就是 `title`。
 * - 底栏目录 / 检索按钮在 `sm`（640 px）及以上显示文字"目录""全书搜索"，名称取文字；窄屏文字
 *   被隐藏，名称退到 `title`"查看完整章节列表 (T)""全文检索 (F)"。定位写成两者之一。
 * - 设置抽屉的主题色块显示主题名的前两个字（`name.slice(0, 2)`），名称取这两个字，完整主题名
 *   在 `title` 里，只是描述。
 * - 章节行（目录抽屉、详情弹窗网格）的名称是"章节标题 + 空格 + N字"，`length` 为 0 时只有标题。
 * - 设置抽屉的 5 个滑杆都按可访问名称定位：字号、行高、版心宽度三个的说明文字是关联的
 *   `<label htmlFor>`，名称即"字号大小""行高间距""内容版心宽度"；字间距与缓存上限的名称来自
 *   `aria-label`。历史：EV 验收时前三个滑杆没有名称、说明文字是 `<span>`，只能定位旁边的文字与
 *   显示值（Findings_Log F-003，已修复（reader-defect-fixes））。
 * - 详情弹窗与三个抽屉右上角的关闭按钮（×）：纯图标，名称来自 `aria-label`（`title` 同文，作悬停
 *   提示），即"关闭书籍详情""关闭目录""关闭检索""关闭设置"（`CLOSE_BUTTON_NAMES`）。历史：EV 验收时
 *   这四个按钮没有 `title` 或 `aria-label`，按名称定位不到（Findings_Log F-009，已修复
 *   （reader-defect-fixes））。
 *
 * 定位不到的元素（已渲染但没有可用的 role 名称或文本，需求 16.4 的可测性缺口，由各场景任务按需
 * 记 Finding）：
 * - 弹窗与抽屉的遮罩：无 role 的 `<div>`。
 * - "我的书签"列表条目是带点击处理器的 `<div>`，没有 role；只能按其中的章节标题文本定位，见
 *   `tocDrawer().bookmarkEntry`。
 */
import type { Locator, Page } from "@playwright/test";
import type { ReaderThemeKey } from "../../src/types";
import { READER_THEMES } from "../../src/utils/theme";

/** `getByRole` 等方法的作用域：整页，或由 role 定位到的某个区域。 */
export type Scope = Page | Locator;

type AriaRole = Parameters<Page["getByRole"]>[0];

/**
 * `<mark>` 的隐式 role（ARIA 1.3 `mark`）。Playwright 1.62 的角色引擎把 `MARK` 映射为 `mark`，
 * 且 `getByRole` 接受任意角色串，但其类型定义的角色联合里没有 `mark`，只能在此处转一次类型。
 */
const MARK_ROLE = "mark" as string as AriaRole;

/** 与 Playwright 比较可访问名称与文本前所做的空白规整相同：去掉零宽空格与软连字符，首尾去空白，连续空白（含全角空格、NBSP）折成一个空格。 */
export function normalizeWhiteSpace(text: string): string {
  return text.replace(/[\u200b\u00ad]/g, "").trim().replace(/\s+/g, " ");
}

/** 转义正则元字符，用于从运行时数据（书名、章节标题）拼出精确匹配的正则。 */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 章节行（目录抽屉、详情弹窗网格）的可访问名称：标题，其后可跟 " N字"。 */
export function chapterRowName(title: string): RegExp {
  return new RegExp(`^${escapeRegExp(normalizeWhiteSpace(title))}(?: \\d+字)?$`);
}

/** 任一章节行：名称以 " N字" 结尾。`length` 为 0 的行不含字数，不在此列。 */
const ANY_CHAPTER_ROW = / \d+字$/;

/** 底栏目录按钮的名称：宽屏取文字"目录"，窄屏文字隐藏、退到 `title`。 */
const FOOTER_TOC_NAME = /^(?:目录|查看完整章节列表 \(T\))$/;

/** 底栏检索按钮的名称：宽屏取文字"全书搜索"，窄屏文字隐藏、退到 `title`。 */
const FOOTER_SEARCH_NAME = /^(?:全书搜索|全文检索 \(F\))$/;

/**
 * 已知锚点的原文（可访问名称或可见文本），与 `src/` 中的写法逐字一致。
 * 断言可访问名称时直接用这里的值（如 `toHaveAccessibleName(NAMES.removeBookmark)`）。
 */
export const NAMES = {
  // 书架（BookshelfPage、BookCard、RecentReads）
  shelfSearch: "搜索书名、作者或拼音首字母...",
  shelfErrorHeading: "加载遇到问题",
  reload: "重新加载",
  cardToc: "章节目录",
  cardStart: "开始阅读",
  cardContinue: "继续阅读",
  authorFilterPrefix: "正在查看作者",
  clearAuthorFilter: "清除筛选",
  recentHeading: "最近阅读",

  // 详情弹窗（BookDetailModal）
  modalMarker: "章节目录 · 全本精校",
  closeDetailModal: "关闭书籍详情",
  modalFilter: "快速过滤章节...",
  modalStartFirst: "从第 1 章开始阅读",
  modalLoading: "正在载入完整章节目录...",
  noMatchingChapter: "未找到匹配的章节",

  // 阅读器顶栏（Header）
  backToShelf: "返回书架",
  addBookmark: "添加书签",
  removeBookmark: "已添加书签 (点击移除)",
  headerToc: "章节目录 (快捷键: T)",
  headerSearch: "全书内容检索 (快捷键: F)",
  headerSettings: "阅读设置 (快捷键: S)",
  fullscreen: "全屏切换 (快捷键: F11)",

  // 阅读器底栏与章末导航（ReaderPage）
  prevChapter: "上一章 (←)",
  nextChapter: "下一章 (→)",
  footerTocWide: "目录",
  footerTocNarrow: "查看完整章节列表 (T)",
  footerSearchWide: "全书搜索",
  footerSearchNarrow: "全文检索 (F)",
  chapterProgress: "章节进度",
  prevChapterEnd: "上一章",
  nextChapterEnd: "下一章",

  // 加载与错误视图（ReaderPage）
  loadProgress: "书籍加载进度",
  loadingHeading: "正在流式解压书籍...",
  loadingNote: "原生 Gzip 解压加速中",
  loadErrorHeading: "未能打开书籍",
  noContentHeading: "这本书没有可阅读的章节",

  // 目录抽屉（NavigationDrawer）
  closeTocDrawer: "关闭目录",
  tocFilter: "搜索章节名...",
  clearKeyword: "清除",
  deleteBookmark: "删除此书签",

  // 检索抽屉（SearchDrawer）
  closeSearchDrawer: "关闭检索",
  searchHeading: "全书内容检索",
  searchInput: "输入关键词（角色、地点、台词...）",

  // 设置抽屉（SettingDrawer）
  closeSettingsDrawer: "关闭设置",
  settingsHeading: "阅读设置",
  fontIncrease: "A+",
  fontDecrease: "A-",
  fontSystem: "系统黑体",
  fontSerif: "宋体/明体",
  fontKaiti: "楷体/手写",
  fontSize: "字号大小",
  lineHeight: "行高间距",
  letterSpacing: "字间距",
  contentWidth: "内容版心宽度",
  cacheMaxBooks: "离线缓存本数上限",
  clearCache: "清空缓存",
  clearingCache: "清空中…",
  download: "下载 UTF-8 纯文本",
} as const;

/**
 * 设置抽屉主题色块的可访问名称：`READER_THEMES`（`src/utils/theme.ts`）中主题名的前两个字
 * （`SettingDrawer` 渲染 `name.slice(0, 2)`，完整名称只在 `title` 里）。名称取自导入的
 * `READER_THEMES`，不在这里另写一份（当前为"默认""复古""护眼""暗色""极夜"）。
 */
export const THEME_BUTTON_NAMES: Readonly<Record<ReaderThemeKey, string>> = Object.fromEntries(
  READER_THEMES.map(({ key, name }) => [key, name.slice(0, 2)]),
) as Record<ReaderThemeKey, string>;

/**
 * 阅读器错误页（"未能打开书籍"）标题下的错误说明，键为 Load_Error_Category（reader-defect-fixes
 * 需求 13.1）。按需求原文逐字照录，不从 `src/utils/loadError.ts` 导入：期望值不由被测代码推出。
 */
export const READER_ERROR_TEXTS = {
  "not-found": "书库里找不到这本书，可能已被移除，或链接有误。",
  unavailable: "暂时无法连接书库，请检查网络后重试。",
  damaged: "这本书的正文文件缺失或已损坏，暂时无法打开。",
  unknown: "打开这本书时出了点问题，请稍后重试。",
} as const;

/**
 * 书架加载失败（"加载遇到问题"）的失败说明，键为 Load_Error_Category（`catalog` 阶段没有
 * `damaged`；reader-defect-fixes 需求 13.7）。同样按需求原文逐字照录。
 */
export const SHELF_ERROR_TEXTS = {
  "not-found": "暂时找不到书库目录，站点可能正在更新，请稍后再试。",
  unavailable: "暂时无法连接书库，请检查网络后重试。",
  unknown: "加载书架时出了点问题，请稍后重试。",
} as const;

/** 书架失败说明的三句之一（整句精确匹配）。 */
const SHELF_ERROR_TEXT_PATTERN = new RegExp(
  `^(?:${Object.values(SHELF_ERROR_TEXTS).map(escapeRegExp).join("|")})$`,
);

/** 设置抽屉的三个字体按钮，键与 `ReaderSettings["fontFamily"]` 相同。 */
export const FONT_BUTTON_NAMES = {
  system: NAMES.fontSystem,
  serif: NAMES.fontSerif,
  kaiti: NAMES.fontKaiti,
} as const;

export type FontKey = keyof typeof FONT_BUTTON_NAMES;

/**
 * 详情弹窗与三个抽屉右上角关闭按钮（×）的可访问名称（`aria-label`，reader-defect-fixes 需求 11.1），
 * 键与 `overlayMarkers` 相同。
 */
export const CLOSE_BUTTON_NAMES = {
  detailModal: NAMES.closeDetailModal,
  tocDrawer: NAMES.closeTocDrawer,
  searchDrawer: NAMES.closeSearchDrawer,
  settingsDrawer: NAMES.closeSettingsDrawer,
} as const;

/** 详情弹窗与三个抽屉的键（`overlayMarkers`、`overlayCloseButtons`、`CLOSE_BUTTON_NAMES` 共用）。 */
export type OverlayKey = keyof typeof CLOSE_BUTTON_NAMES;

function button(scope: Scope, name: string): Locator {
  return scope.getByRole("button", { name, exact: true });
}

/**
 * 可访问名称中含 `name`（区分大小写的子串，未锚定的正则）的按钮。只用于"没有别的按钮的名称包含它"
 * 一类唯一性核对（reader-defect-fixes 需求 11.1），不用于操作：定位一律精确匹配（见文件头）。
 */
export function buttonsNameContaining(scope: Scope, name: string): Locator {
  return scope.getByRole("button", { name: new RegExp(escapeRegExp(normalizeWhiteSpace(name))) });
}

/* -------------------------------------------------------------------------- */
/* 书架                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 书架页（`/`）。
 *
 * 书卡没有 role 容器，一张卡的书名、"章节目录"与"开始阅读 / 继续阅读"按钮按文档顺序一一对应，
 * 用 `card(i)` 按下标取同一张卡的三者；作者按钮只在作者可筛选时渲染，不参与下标对应，按作者名取。
 */
export function shelf(page: Page) {
  const main = page.getByRole("main");
  const cardTitles = main.getByRole("heading", { level: 3 });
  const cardTocButtons = button(page, NAMES.cardToc);
  const cardReadButtons = page.getByRole("button", { name: /^(?:开始阅读|继续阅读)$/ });

  return {
    /** 顶栏（`<header>`，banner）。 */
    banner: page.getByRole("banner"),
    main,
    searchBox: page.getByRole("textbox", { name: NAMES.shelfSearch, exact: true }),
    /** 骨架占位（`role="status"`、`aria-busy="true"`）。 */
    skeleton: page.getByRole("status"),
    errorHeading: page.getByRole("heading", { name: NAMES.shelfErrorHeading, exact: true }),
    /**
     * "加载遇到问题"下的失败说明：`SHELF_ERROR_TEXTS` 三句之一（整句匹配），按类别断言具体哪一句。
     * 历史：EV 验收时这里显示原始 `err.message`（非成功状态为"无法获取书架索引 (HTTP N)。…"，网络错误为
     * 浏览器的报错原文），本定位曾按前者匹配（Findings_Log F-012，已修复（reader-defect-fixes））。
     */
    errorDetail: page.getByText(SHELF_ERROR_TEXT_PATTERN),
    reloadButton: button(page, NAMES.reload),
    /** 检索（及作者筛选）结果为空时的提示。 */
    emptyResult: page.getByText(/^(?:「.+」的作品里没有|未找到)与 ".*" 相关的书籍$/),

    /** 书卡书名（`<h3>`）。仅在非错误态下与书卡一一对应（错误态的"加载遇到问题"也是 `<h3>`）。 */
    cardTitles,
    cardTitle: (title: string) =>
      main.getByRole("heading", { level: 3, name: title, exact: true }),
    cardTocButtons,
    cardReadButtons,
    /** 第 `index` 张书卡（从 0 起，文档顺序）的书名与两枚按钮。 */
    card: (index: number) => ({
      title: cardTitles.nth(index),
      tocButton: cardTocButtons.nth(index),
      readButton: cardReadButtons.nth(index),
    }),
    /** 书卡上的作者筛选按钮；同一作者有多本书时匹配多个，效果相同，按需取 `.first()`。 */
    authorButton: (author: string) => button(page, `筛选作者「${author}」的全部作品`),

    /** 作者筛选状态条的"正在查看作者"字样（状态条存在的标志）。 */
    authorFilterBar: page.getByText(NAMES.authorFilterPrefix, { exact: true }),
    /**
     * 作者筛选状态条整条，且其中的作者名为 `author`。状态条没有 role，按其整段可见文本
     * （"正在查看作者" + 作者名 + "共 N 本" + "清除筛选"）定位：同时含这几段文字的最小元素就是它。
     * 作者名单独按文本定位会同时命中书卡上的作者按钮，所以不单独提供。
     */
    authorFilterStrip: (author: string) =>
      page.getByText(
        new RegExp(
          `^${escapeRegExp(NAMES.authorFilterPrefix)}\\s*${escapeRegExp(author)}\\s*` +
            `共 \\d+ 本\\s*${escapeRegExp(NAMES.clearAuthorFilter)}$`,
        ),
      ),
    /** 作者筛选状态条里的计数"共 N 本"。 */
    authorFilterCount: page.getByText(/^共 \d+ 本$/),
    clearFilterButton: button(page, NAMES.clearAuthorFilter),

    /** "继续加载（还有 N 本）"。 */
    loadMoreButton: page.getByRole("button", { name: /^继续加载（还有 \d+ 本）$/ }),
    /** "已显示 X / Y 本"。 */
    shownCount: page.getByText(/^已显示 \d+ \/ \d+ 本$/),
  };
}

/** 书架首屏的"最近阅读"区块（`<section aria-labelledby>`，region）。 */
export function recentReads(page: Page) {
  const region = page.getByRole("region", { name: NAMES.recentHeading, exact: true });
  return {
    region,
    heading: page.getByRole("heading", { name: NAMES.recentHeading, exact: true }),
    /** 全部续读行（按钮名称"继续阅读《书名》，上次读到 章节标题"）。 */
    entries: region.getByRole("button", { name: /^继续阅读《.*》，上次读到 / }),
    /** 某本书的续读行。 */
    entry: (bookTitle: string) =>
      region.getByRole("button", {
        name: new RegExp(`^继续阅读《${escapeRegExp(normalizeWhiteSpace(bookTitle))}》，上次读到 `),
      }),
    /** 续读行 `entry` 内整段等于 `text` 的可见文字（书名、作者或章节名各占一段）。 */
    entryText: (entry: Locator, text: string) => entry.getByText(text, { exact: true }),
    /** 续读行 `entry` 内的相对时间（`<time>`，role time）；时间戳无效时应用不渲染它。 */
    entryTime: (entry: Locator) => entry.getByRole("time"),
  };
}

/** 续读行按钮的可访问名称（`RecentReads` 的 `aria-label`）。 */
export function recentEntryName(bookTitle: string, chapterTitle: string): string {
  return normalizeWhiteSpace(`继续阅读《${bookTitle}》，上次读到 ${chapterTitle}`);
}

/** 目录抽屉"我的书签"页签的可访问名称（即其文本）："我的书签 (N)"，N 为书签条数（`NavigationDrawer`）。 */
export function bookmarksTabName(count: number): string {
  return `我的书签 (${count})`;
}

/**
 * 书籍详情 / 章节目录弹窗（`/?book=<id>`）。没有 `role="dialog"`；`marker` 是弹窗头部的
 * "章节目录 · 全本精校"字样。
 */
export function detailModal(page: Page) {
  return {
    marker: page.getByText(NAMES.modalMarker, { exact: true }),
    /** 弹窗里的书名（`<h2>`）。书架上"最近阅读"也是 `<h2>`，所以必须带书名。 */
    heading: (bookTitle: string) =>
      page.getByRole("heading", { level: 2, name: bookTitle, exact: true }),
    filter: page.getByRole("textbox", { name: NAMES.modalFilter, exact: true }),
    /** "从第 1 章开始阅读"或"继续阅读 (第 N 章)"。 */
    startButton: page.getByRole("button", {
      name: /^(?:从第 1 章开始阅读|继续阅读 \(第 \d+ 章\))$/,
    }),
    chapter: (title: string) => page.getByRole("button", { name: chapterRowName(title) }),
    /** 网格中当前挂载的章节按钮（名称以" N字"结尾的按钮）。 */
    chapterRows: page.getByRole("button", { name: ANY_CHAPTER_ROW }),
    loading: page.getByText(NAMES.modalLoading, { exact: true }),
    empty: page.getByText(NAMES.noMatchingChapter, { exact: true }),
    /** 右上角的关闭按钮（×），名称"关闭书籍详情"（需求 11.1）；关闭后 URL 去掉 `book` 参数（11.2）。 */
    closeButton: button(page, NAMES.closeDetailModal),
  };
}

/* -------------------------------------------------------------------------- */
/* 阅读器                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * 正文中的检索跳转高亮（`<article>` 内的 `<mark>`，role mark）。检索抽屉结果里的 `<mark>`
 * 不在 `<article>` 内，不计入。
 */
export function readerJumpHighlight(page: Page): Locator {
  return page.getByRole("article").getByRole(MARK_ROLE);
}

/** 阅读器正文视图（`/read/<id>` 加载完成后）。 */
export function reader(page: Page) {
  const banner = page.getByRole("banner");
  const article = page.getByRole("article");
  return {
    /** 顶栏（`<header>`，banner）。正文 `<article>` 内的 `<header>` 不是 banner。 */
    topBar: banner,
    /** 底栏（`<footer>`，contentinfo）。 */
    bottomBar: page.getByRole("contentinfo"),
    /** 顶栏书名（`<h1>`）。 */
    bookTitle: banner.getByRole("heading", { level: 1 }),
    /** 顶栏书名下方的当前章节标题（`<p>`）。 */
    headerChapterTitle: banner.getByRole("paragraph"),
    /** 顶栏"已读 x.x%"（窄屏隐藏）。 */
    progressPercent: banner.getByText(/^已读 \d+(?:\.\d+)?%$/),

    backButton: button(page, NAMES.backToShelf),
    /** 书签按钮，不论是否已添加。 */
    bookmarkButton: page.getByRole("button", { name: /^(?:添加书签|已添加书签 \(点击移除\))$/ }),
    addBookmarkButton: button(page, NAMES.addBookmark),
    removeBookmarkButton: button(page, NAMES.removeBookmark),
    tocButton: button(page, NAMES.headerToc),
    searchButton: button(page, NAMES.headerSearch),
    settingsButton: button(page, NAMES.headerSettings),
    /** 全屏切换（窄屏隐藏）。 */
    fullscreenButton: button(page, NAMES.fullscreen),

    prevChapterButton: button(page, NAMES.prevChapter),
    nextChapterButton: button(page, NAMES.nextChapter),
    /** 底栏目录按钮：宽屏名称"目录"，窄屏"查看完整章节列表 (T)"。 */
    footerTocButton: page.getByRole("button", { name: FOOTER_TOC_NAME }),
    /** 底栏检索按钮：宽屏名称"全书搜索"，窄屏"全文检索 (F)"。 */
    footerSearchButton: page.getByRole("button", { name: FOOTER_SEARCH_NAME }),
    chapterSlider: page.getByRole("slider", { name: NAMES.chapterProgress, exact: true }),

    /** 滚动容器（`<main>`）。 */
    main: page.getByRole("main"),
    article,
    /** 正文章节标题（`<article>` 内的 `<h1>`）。 */
    chapterHeading: article.getByRole("heading", { level: 1 }),
    /** 章节标题下的"第 N / M 章"。 */
    chapterPosition: article.getByText(/^第 \d+ \/ \d+ 章$/),
    /** 正文段落（`<article>` 内的 `<p>`）。 */
    paragraphs: article.getByRole("paragraph"),
    jumpHighlight: readerJumpHighlight(page),
    /** 章末导航的"上一章""下一章"（带文字的按钮，区别于底栏的纯图标按钮）。 */
    prevChapterEndButton: article.getByRole("button", { name: NAMES.prevChapterEnd, exact: true }),
    nextChapterEndButton: article.getByRole("button", { name: NAMES.nextChapterEnd, exact: true }),
  };
}

/** Bottom_Bar 的一个控件：报告里的写法与定位。 */
export interface BottomBarControl {
  label: string;
  locator: Locator;
}

/**
 * Bottom_Bar（`<footer>`，contentinfo）的 5 个控件，按从左到右的顺序：上一章、目录、章节进度滑杆、
 * 全文检索、下一章（reader-defect-fixes 需求 8 的 Glossary）。都以 contentinfo 区域为作用域按 role 与
 * 名称定位，章末导航的"上一章""下一章"（在 `<article>` 内）不在其中。
 */
export function bottomBarControls(page: Page): readonly BottomBarControl[] {
  const bar = page.getByRole("contentinfo");
  return [
    { label: "上一章", locator: button(bar, NAMES.prevChapter) },
    { label: "目录", locator: bar.getByRole("button", { name: FOOTER_TOC_NAME }) },
    { label: "章节进度滑杆", locator: bar.getByRole("slider", { name: NAMES.chapterProgress, exact: true }) },
    { label: "全文检索", locator: bar.getByRole("button", { name: FOOTER_SEARCH_NAME }) },
    { label: "下一章", locator: button(bar, NAMES.nextChapter) },
  ];
}

/** 阅读器加载视图（`.txt.gz` 下载 / 解压中）。 */
export function readerLoading(page: Page) {
  return {
    heading: page.getByRole("heading", { name: NAMES.loadingHeading, exact: true }),
    /** 标题下的说明带百分比时（确定态）："原生 Gzip 解压加速中 (N%)"；不确定态不带百分比，不匹配。 */
    percentNote: page.getByText(new RegExp(`^${escapeRegExp(NAMES.loadingNote)} \\(\\d{1,3}%\\)$`)),
    /** "书籍加载进度"进度条；确定态带 `aria-valuenow`，不确定态不带。 */
    progress: page.getByRole("progressbar", { name: NAMES.loadProgress, exact: true }),
  };
}

/** 阅读器错误视图（"未能打开书籍"）与无正文章节视图。 */
export function readerError(page: Page) {
  return {
    heading: page.getByRole("heading", { name: NAMES.loadErrorHeading, exact: true }),
    noContentHeading: page.getByRole("heading", { name: NAMES.noContentHeading, exact: true }),
    /**
     * 标题下的一行说明（`<p>`）。错误视图中为 `READER_ERROR_TEXTS` 四句之一，按类别断言具体哪一句；
     * 不按文本定位，以便同一定位也用于无正文章节视图。两种视图都只有这一个段落，且整页只渲染该视图
     * （没有顶栏、底栏与正文），所以只在 `heading` 或 `noContentHeading` 可见时使用，并先断言计数为 1。
     * 历史：EV 验收时错误视图的这一行是原始异常消息（Findings_Log F-011，已修复（reader-defect-fixes））。
     */
    description: page.getByRole("paragraph"),
    backButton: button(page, NAMES.backToShelf),
  };
}

/**
 * 目录抽屉（NavigationDrawer）。`marker` 是"章节目录 (N)"页签，抽屉打开时总在（两个页签都显示）。
 * 阅读器页上 `<h3>` 只出现在目录抽屉的卷节点行。
 */
export function tocDrawer(page: Page) {
  const tabToc = page.getByRole("button", { name: /^章节目录 \(\d+\)$/ });
  return {
    marker: tabToc,
    /** 右上角的关闭按钮（×），名称"关闭目录"（需求 11.1）。 */
    closeButton: button(page, NAMES.closeTocDrawer),
    /** 抽屉头部的书名（`<h2>`）。 */
    heading: (bookTitle: string) =>
      page.getByRole("heading", { level: 2, name: bookTitle, exact: true }),
    tabToc,
    tabBookmarks: page.getByRole("button", { name: /^我的书签 \(\d+\)$/ }),
    /** 抽屉头部书名下方的"作者: X · 共 M 章"（M 为正文章节数，8.6）。 */
    summary: page.getByText(/^作者: .* · 共 \d+ 章$/),

    filter: page.getByRole("textbox", { name: NAMES.tocFilter, exact: true }),
    clearFilterButton: button(page, NAMES.clearKeyword),
    /** 某个正文章节行（点击即跳转并关闭抽屉）。 */
    chapter: (title: string) => page.getByRole("button", { name: chapterRowName(title) }),
    /** 当前挂载的正文章节行（名称以" N字"结尾的按钮）。 */
    chapterRows: page.getByRole("button", { name: ANY_CHAPTER_ROW }),
    /** 某个卷节点行（`<h3>`，不可点击的分组表头）。 */
    volume: (title: string) =>
      page.getByRole("heading", { level: 3, name: title, exact: true }),
    /** 当前挂载的卷节点行。 */
    volumes: page.getByRole("heading", { level: 3 }),
    empty: page.getByText(NAMES.noMatchingChapter, { exact: true }),

    /**
     * "我的书签"页签里某条书签（按其章节标题文本）。条目本身没有 role，定位到的是标题所在的
     * 文本元素，点击会冒泡到条目的点击处理器。该章节恰为当前章时，顶栏副标题与正文 `<h1>`
     * 也是同一段文字，会匹配多个。
     */
    bookmarkEntry: (chapterTitle: string) => page.getByText(chapterTitle, { exact: true }),
    /** 每条书签各一个"删除此书签"按钮，计数即书签条数。 */
    bookmarkDeleteButtons: button(page, NAMES.deleteBookmark),
    noBookmarks: page.getByText(/^暂无书签。/),
  };
}

/**
 * 全书检索抽屉（SearchDrawer）。`marker` 是抽屉头部的"全书内容检索"标题（`<h2>`）；
 * 顶栏同名按钮的名称带"(快捷键: F)"，role 也不同。
 */
export function searchDrawer(page: Page) {
  const heading = page.getByRole("heading", { level: 2, name: NAMES.searchHeading, exact: true });
  const results = page.getByRole("button").filter({ has: page.getByRole(MARK_ROLE) });
  return {
    marker: heading,
    heading,
    /** 右上角的关闭按钮（×），名称"关闭检索"（需求 11.1）。 */
    closeButton: button(page, NAMES.closeSearchDrawer),
    input: page.getByRole("textbox", { name: NAMES.searchInput, exact: true }),
    clearButton: button(page, NAMES.clearKeyword),
    /** "找到 N 条匹配"。 */
    resultCount: page.getByText(/^找到 \d+ 条匹配$/),
    /** 结果达到上限时的"仅展示前 150 处"。 */
    capNotice: page.getByText(/^仅展示前 \d+ 处$/),
    /** 结果条目：内含 `<mark>` 的按钮（阅读器页上只有检索结果是这样）。 */
    results,
    /** 命中某章的结果条目。 */
    resultsIn: (chapterTitle: string) =>
      results.filter({ has: page.getByText(chapterTitle, { exact: true }) }),
    /** 结果条目里的命中片段（`<mark>`）。 */
    resultMarks: results.getByRole(MARK_ROLE),
    /** 未输入关键词时的提示。 */
    idleHint: page.getByText(/^输入关键词即可在整本小说/),
    /** 无命中时的提示。 */
    noHits: page.getByText(/^未在全书中找到与 ".*" 相关的内容$/),
  };
}

/**
 * 阅读设置抽屉（SettingDrawer）。`marker` 是抽屉头部的"阅读设置"标题（`<h2>`）。
 *
 * 显示值的正则按各项的取值范围区分（字号 14–36 → 两位数 px；字间距 0–4 步长 0.5 → 一位数
 * px；版心 600–1200 → 三到四位数 px；行高 1.4–2.5 → `x` 结尾），阅读器页上没有别处的文字
 * 与之整段相同。
 */
export function settingsDrawer(page: Page) {
  const heading = page.getByRole("heading", { level: 2, name: NAMES.settingsHeading, exact: true });
  return {
    marker: heading,
    heading,
    /** 右上角的关闭按钮（×），名称"关闭设置"（需求 11.1）。 */
    closeButton: button(page, NAMES.closeSettingsDrawer),
    theme: (key: ReaderThemeKey) => button(page, THEME_BUTTON_NAMES[key]),

    fontIncrease: button(page, NAMES.fontIncrease),
    fontDecrease: button(page, NAMES.fontDecrease),
    /** "字号大小"滑杆：名称取自关联的 `<label>`（需求 6.1）。 */
    fontSizeSlider: page.getByRole("slider", { name: NAMES.fontSize, exact: true }),
    /** "字号大小"字样（滑杆的 `<label>`，可见文字）。 */
    fontSizeLabel: page.getByText(NAMES.fontSize, { exact: true }),
    /** 字号显示值"NNpx"（在 `<label>` 之外，不计入滑杆名称）。 */
    fontSizeValue: page.getByText(/^\d{2}px$/),
    fontFamily: (key: FontKey) => button(page, FONT_BUTTON_NAMES[key]),

    /** "行高间距"滑杆：名称取自关联的 `<label>`（需求 6.1）。 */
    lineHeightSlider: page.getByRole("slider", { name: NAMES.lineHeight, exact: true }),
    /** "行高间距"字样（滑杆的 `<label>`，可见文字）。 */
    lineHeightLabel: page.getByText(NAMES.lineHeight, { exact: true }),
    lineHeightValue: page.getByText(/^\d(?:\.\d+)?x$/),
    letterSpacingSlider: page.getByRole("slider", { name: NAMES.letterSpacing, exact: true }),
    letterSpacingValue: page.getByText(/^\d(?:\.\d)?px$/),
    /** "内容版心宽度"滑杆：名称取自关联的 `<label>`（需求 6.1）。 */
    contentWidthSlider: page.getByRole("slider", { name: NAMES.contentWidth, exact: true }),
    /** "内容版心宽度"字样（滑杆的 `<label>`，可见文字）。 */
    contentWidthLabel: page.getByText(NAMES.contentWidth, { exact: true }),
    contentWidthValue: page.getByText(/^\d{3,4}px$/),

    /** 已缓存"N 本 · 大小"，统计完成前为"统计中…"。 */
    cacheUsage: page.getByText(/^(?:统计中…|\d+ 本 · .+)$/),
    cacheMaxBooksSlider: page.getByRole("slider", { name: NAMES.cacheMaxBooks, exact: true }),
    /** 缓存上限显示值"N 本"。 */
    cacheMaxBooksValue: page.getByText(/^\d+ 本$/),
    /** "清空缓存"，清空进行中名称为"清空中…"。 */
    clearCacheButton: page.getByRole("button", { name: /^(?:清空缓存|清空中…)$/ }),
    downloadButton: button(page, NAMES.download),
    /** 清空失败或下载失败时的提示（`role="alert"`）。 */
    alerts: page.getByRole("alert"),
  };
}

/**
 * 弹窗与抽屉的打开标志，合计计数用于"恰好打开了一个"类判断（10.16–10.19、15.7 (c)）。
 * 详情弹窗只出现在书架，三个抽屉只出现在阅读器。
 */
export function overlayMarkers(page: Page): Record<OverlayKey, Locator> {
  return {
    detailModal: detailModal(page).marker,
    tocDrawer: tocDrawer(page).marker,
    searchDrawer: searchDrawer(page).marker,
    settingsDrawer: settingsDrawer(page).marker,
  };
}

/** 详情弹窗与三个抽屉右上角的关闭按钮（×），按 `CLOSE_BUTTON_NAMES` 精确匹配（reader-defect-fixes 需求 11）。 */
export function overlayCloseButtons(page: Page): Record<OverlayKey, Locator> {
  return {
    detailModal: detailModal(page).closeButton,
    tocDrawer: tocDrawer(page).closeButton,
    searchDrawer: searchDrawer(page).closeButton,
    settingsDrawer: settingsDrawer(page).closeButton,
  };
}

/** 两个主视图的标志：书架的检索框、阅读器的正文 `<article>`。 */
export function viewMarkers(page: Page): { shelf: Locator; reader: Locator } {
  return {
    shelf: shelf(page).searchBox,
    reader: page.getByRole("article"),
  };
}
