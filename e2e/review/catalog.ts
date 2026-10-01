/**
 * Review_Catalog（需求 13.1、13.2；设计"Review_Catalog 与 Review_Report"）。
 *
 * 附录 A 的 21 条，RS-13 按 5 个主题键展开，共 25 张 Review_Shot，按附录 A 的顺序排列；Review_Report
 * 按同一顺序每张一节（13.3）。准则取附录 A 的原文，以"；"切分后逐条编号（从 1 起）。
 *
 * ## 字段（13.1）
 *
 * - `name`：文件名即 `<name>.png`（`reviewShotFile`），跨运行不变。
 * - `theme`：`THEME_UNSET`（`"unset"`）表示"默认主题"，即 localStorage 中没有已存储的主题，
 *   用例**不得** `seedTheme`，拍摄前断言 `data-theme` 等于应用默认（`appDefaultTheme()`，当前
 *   为 `sepia`）；主题键（含 `default`）表示先 seed 该键（或经设置抽屉切到该键）再断言该键。
 *   规则与辅助函数见 `e2e/support/theme.ts`（用户决定，基线、Perf_Metrics、A11y_Scan 同用）。
 * - `book`：`{ role }` 按用途取书（fixture 取 `roles.json`，real 取测试用书表，见 `library.ts`），
 *   `{ id }` 为字面量书 id，`null` 表示不涉及某本书库中的书。`resolveShotBook` 解析为书 id。
 *   （设计写作 `{ role: keyof FixtureRoles }`；`FixtureRoles` 里有非单本书的键，这里改用
 *   `BookRole`。）
 * - `url`：`{id}`（`BOOK_ID_PLACEHOLDER`）处代入 `book` 的书 id（`resolveShotUrl`），不做百分号
 *   编码。`shot` fixture 拍摄前核对当前页面的路径与此相同，且此处写出的查询参数都在当前页面中、
 *   取值相同（当前页面可以多带查询参数，如 `?ch=`）。
 * - `by`：拍摄它的用例，`file` 相对 `e2e/tests`、以 `/` 分隔，`title` 为用例自身的标题
 *   （`TestCase.title` / `testInfo.title`，不含 describe）。标题统一取自 `SHOT_TESTS`，场景用例
 *   写作 `test(SHOT_TESTS.xxx.title, …)`；`shot` fixture 核对调用它的用例与 `by` 一致，未拍摄时
 *   reporter 据 `by` 找到用例结果（13.4）。
 *
 * ## 与附录 A 的细化
 *
 * - `state` 在附录 A"场景"一栏的基础上写明了具体取法（RS-05 的作者、RS-16 的 2 本书、RS-19 的书等），
 *   用例按 `state` 准备画面。
 * - RS-06：用例按 7.13 写入 6 条进度，"最近阅读"列出其中 5 条，与准则的"5 行"一致。
 * - RS-13：第 3 条准则"深色两套中没有残留的浅色背景块"只属于 `dark` 与 `black` 两张；
 *   浅色三张只有前 2 条，避免出现与该图无关的准则（13.1）。
 *
 * 本文件只依赖 Node 内置模块与无副作用的模块，reporter 也导入它。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ReaderThemeKey } from "../../src/types";
import type { Mode } from "../server/resolve";
import {
  fixtureRoleBookId,
  testBookFor,
  type BookRole,
  type FixtureRoles,
  type LibraryProfile,
} from "../support/library";
import { VIEWPORTS } from "../support/settings";
import {
  THEME_COLOR_SCHEME,
  THEME_KEYS,
  THEME_UNSET,
  describeTheme,
  type DeclaredTheme,
} from "../support/theme";

/** 仓库根（本文件位于 `e2e/review/`）。 */
const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** 场景用例的根；`by.file` 相对于它。 */
const TESTS_DIR = path.join(REPO_ROOT, "e2e", "tests");

/** Review_Shot 与 Review_Report 的目录（gitignore，每次运行开始时由 globalSetup 清空，13.5）。 */
export const REVIEW_DIR = path.join(REPO_ROOT, "e2e", ".out", "review");

/** `url` 中代入书 id 的占位串。 */
export const BOOK_ID_PLACEHOLDER = "{id}";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export type ShotViewport = keyof typeof VIEWPORTS;

/** 截取范围（13.1、13.10）：视口 / 元素 / 整页，默认视口。 */
export type ShotScope = "viewport" | "element" | "fullPage";

/** Checklist 项编号（附录 B）。 */
export type ChecklistItem = `H${number}`;

/** 截图涉及的书：按用途、字面量 id，或不涉及。 */
export type ShotBook = { readonly role: BookRole } | { readonly id: string } | null;

/** 拍摄某张 Review_Shot 的用例。 */
export interface ShotTestRef {
  /** 相对 `e2e/tests`、以 `/` 分隔的文件路径。 */
  readonly file: string;
  /** 用例自身的标题（不含 describe）。 */
  readonly title: string;
}

export interface ReviewShotDef {
  readonly name: string;
  /** 附录 A 的编号，如 `RS-13`（RS-13 的 5 张共用）。 */
  readonly rs: string;
  readonly profile: LibraryProfile;
  readonly viewport: ShotViewport;
  /** 5 个主题键之一，或 `THEME_UNSET`（默认主题：没有已存储的主题）。 */
  readonly theme: DeclaredTheme;
  readonly mode: Mode;
  readonly book: ShotBook;
  readonly url: string;
  /** 要展示的状态。 */
  readonly state: string;
  readonly scope: ShotScope;
  /** 覆盖的 Checklist 项编号，可为空。 */
  readonly checklist: readonly ChecklistItem[];
  /** 1–5 条验收准则，数组下标 + 1 即准则编号。 */
  readonly criteria: readonly string[];
  readonly by: ShotTestRef;
}

// ---------------------------------------------------------------------------
// 附录 A 的名称与 Checklist 覆盖（一致性检查的依据，13.2、13.11）
// ---------------------------------------------------------------------------

/**
 * 附录 A 展开后的 25 个名称，按附录 A 的顺序；RS-13 按 `default`、`sepia`、`eyecare`、`dark`、
 * `black` 展开。独立于 `REVIEW_CATALOG` 书写，供一致性检查核对 catalog 没有漏项。
 */
export const REQUIRED_SHOT_NAMES = [
  "bookshelf-home",
  "bookshelf-mobile",
  "bookshelf-skeleton",
  "search-pinyin",
  "author-filter",
  "recent-reads",
  "detail-modal",
  "toc-volumes",
  "toc-huge-middle",
  "search-highlight",
  "search-highlight-cleared",
  "theme-swatches",
  "reader-theme-default",
  "reader-theme-sepia",
  "reader-theme-eyecare",
  "reader-theme-dark",
  "reader-theme-black",
  "progress-indeterminate",
  "progress-determinate",
  "cache-usage",
  "toc-fallback",
  "toc-stars",
  "reader-mobile-toc",
  "load-error",
  "bookmark-list",
] as const;

/** Review_Shot 名称（`shot(name)` 的参数类型）。 */
export type ReviewShotName = (typeof REQUIRED_SHOT_NAMES)[number];

/** 附录 B"视觉评审"栏不为"—"的 7 项，每项至少被 1 张 Review_Shot 引用（13.2）。 */
export const REQUIRED_CHECKLIST = ["H1", "H4", "H5", "H6", "H7", "H10", "H11"] as const;

// ---------------------------------------------------------------------------
// 拍摄用例（by）
// ---------------------------------------------------------------------------

const REAL_SHOTS_FILE = "real/real-shots.spec.ts";

function realReaderThemeTests(): Readonly<Record<ReaderThemeKey, ShotTestRef>> {
  const entries = THEME_KEYS.map(
    (key) => [key, { file: REAL_SHOTS_FILE, title: `RS-13 《1852铁血中华》正文：主题 ${key}` }] as const,
  );
  return Object.fromEntries(entries) as Record<ReaderThemeKey, ShotTestRef>;
}

/**
 * 拍摄 Review_Shot 的用例（文件与标题）。场景用例的标题一律取自这里：
 * `test(SHOT_TESTS.shelfSkeleton.title, async (…) => { … await shot("bookshelf-skeleton"); })`。
 * 用例放在别的文件或改了标题时，`shot()` 直接使用例失败。
 */
export const SHOT_TESTS = {
  // --- fixture（任务 9.x–12.x）---
  /** RS-03（任务 9.1） */
  shelfSkeleton: {
    file: "fixture/shelf-skeleton.spec.ts",
    title: "7.1 books.json 挂起时显示骨架，列数等于书卡网格（桌面）",
  },
  /** RS-06（任务 9.4） */
  shelfRecent: {
    file: "fixture/shelf-recent.spec.ts",
    title: "7.13 6 条阅读进度：「最近阅读」按时间倒序列出 5 行与相对时间",
  },
  /** RS-21（任务 10.6） */
  bookmarkAdd: {
    file: "fixture/reader-bookmark.spec.ts",
    title: "9.5 添加书签：「我的书签」计数加 1，新条目显示章节名与第 k 段预览",
  },
  /** RS-12（任务 11.2） */
  themeSwatches: {
    file: "fixture/reader-theme.spec.ts",
    title: "10.4 设置抽屉依次选择 5 个主题：data-theme 与最外层背景色等于 --bg",
  },
  /** RS-20（任务 12.3） */
  loadErrorMissingBook: {
    file: "fixture/load-error.spec.ts",
    title: "11.9 不在书库中的中文 id：10 s 内显示错误页，不打 [book-load] 日志，不写 IndexedDB",
  },

  // --- common（fixture 与 real 都跑，只在 real 下拍摄；任务 10.1–10.4）---
  /** RS-08（任务 10.1） */
  tocVolumes: {
    file: "common/reader-volumes.spec.ts",
    title: "8.2 目录抽屉：卷节点为不在 Tab 序列中的 heading，正文章节为 button，当前章节行可见且唯一带 aria-current",
  },
  /** RS-09（任务 10.2） */
  tocWindow: {
    file: "common/reader-toc-window.spec.ts",
    title: "8.7 ≥ 3,000 节点的书：目录抽屉顶、中、底三处的挂载行数上界与行位覆盖",
  },
  /** RS-17（任务 10.3） */
  tocFallback: {
    file: "common/reader-fallback-stars.spec.ts",
    title: "8.9 fallback 书：目录行为「第 N 部分」且逐行加 1，下一章进入下标 1",
  },
  /** RS-18（任务 10.3） */
  tocStars: {
    file: "common/reader-fallback-stars.spec.ts",
    title: "8.10 标题全为 ※※※ 的书：目录总高度、首末行标题与非空标题",
  },
  /** RS-10、RS-11（任务 10.4） */
  searchHighlight: {
    file: "common/reader-search.spec.ts",
    title: "9.2、9.3 选择检索结果后高亮位于视口内，4,900 ms 时仍在、5,000 ms 时清除",
  },

  // --- real（任务 13.x）---
  /** RS-15（任务 13.2） */
  progressDeterminate: {
    file: "real/load-progress-opaque.spec.ts",
    title: "11.1 Opaque_Mode 节流加载《极品全能高手》：确定态进度条取样 ≥ 5 次且单调不减",
  },
  /** RS-14（任务 13.3；与 11.5 的用例分开，11.5 以 no-preference 运行、不拍摄，6.3） */
  progressIndeterminate: {
    file: "real-transparent/load-progress-transparent.spec.ts",
    title: "RS-14 Transparent_Mode 节流加载《极品全能高手》时的不确定态进度条",
  },
  /** RS-01（任务 13.1） */
  realShelfHome: { file: REAL_SHOTS_FILE, title: "RS-01 书架首屏（桌面）" },
  /** RS-02（任务 13.1） */
  realShelfMobile: { file: REAL_SHOTS_FILE, title: "RS-02 书架首屏（移动）" },
  /** RS-04，兼 7.4 的 real 半句（任务 13.1） */
  realSearchPinyin: {
    file: REAL_SHOTS_FILE,
    title: "7.4 real：输入 clks 并推进 250 ms 后首批书卡含《从零开始》",
  },
  /** RS-05（任务 13.1） */
  realAuthorFilter: { file: REAL_SHOTS_FILE, title: "RS-05 点击作者按钮后的作者筛选" },
  /** RS-07（任务 13.1） */
  realDetailModal: { file: REAL_SHOTS_FILE, title: "RS-07 深链接打开《从零开始》详情弹窗" },
  /** RS-13 ×5（任务 13.1），按主题键取 */
  realReaderTheme: realReaderThemeTests(),
  /** RS-16（任务 13.1） */
  realCacheUsage: { file: REAL_SHOTS_FILE, title: "RS-16 整页打开 2 本书后设置抽屉的缓存占用" },
  /** RS-19（任务 13.1） */
  realMobileToc: { file: REAL_SHOTS_FILE, title: "RS-19 移动视口：阅读器正文与打开的目录抽屉" },
} as const;

// ---------------------------------------------------------------------------
// Review_Catalog
// ---------------------------------------------------------------------------

type CatalogEntry = ReviewShotDef & { readonly name: ReviewShotName };

/** 未注明时的取值（附录 A：桌面、默认主题、Opaque_Mode；13.1：截取范围默认视口）。 */
const DEFAULTS = {
  viewport: "desktop",
  theme: THEME_UNSET,
  mode: "opaque",
  scope: "viewport",
} as const;

const RS13_CRITERIA = ["正文与背景对比清晰可读", "顶栏、底栏与正文背景属于同一配色"] as const;
const RS13_DARK_CRITERION = "深色两套中没有残留的浅色背景块";

const ENTRIES: readonly CatalogEntry[] = [
  {
    ...DEFAULTS,
    name: "bookshelf-home",
    rs: "RS-01",
    profile: "real",
    book: null,
    url: "/",
    state: "书架首屏：首批书卡加载完成，检索框为空、无作者筛选",
    checklist: [],
    criteria: ["书卡呈规则网格且列宽一致", "书名与作者文字未与相邻元素重叠、未溢出卡片", "页头与检索框可见"],
    by: SHOT_TESTS.realShelfHome,
  },
  {
    ...DEFAULTS,
    name: "bookshelf-mobile",
    rs: "RS-02",
    profile: "real",
    viewport: "mobile",
    book: null,
    url: "/",
    state: "书架首屏，移动视口：首批书卡加载完成，检索框为空、无作者筛选",
    checklist: [],
    criteria: ["书卡单列并占满可用宽度", "无横向滚动条", "检索框完整可见"],
    by: SHOT_TESTS.realShelfMobile,
  },
  {
    ...DEFAULTS,
    name: "bookshelf-skeleton",
    rs: "RS-03",
    profile: "fixture",
    book: null,
    url: "/",
    state: "books.json 的响应被挂起时：骨架区块（role=status、aria-busy=true）显示中",
    checklist: ["H7"],
    criteria: [
      "占位卡的列数与 RS-01 同视口的书卡列数相同",
      "占位卡的外形（圆角卡片、封面区 + 文字区）与书卡一致",
    ],
    by: SHOT_TESTS.shelfSkeleton,
  },
  {
    ...DEFAULTS,
    name: "search-pinyin",
    rs: "RS-04",
    profile: "real",
    book: { role: "pinyin" },
    url: "/",
    state: "在空检索框输入 clks，Controlled_Clock 自末次按键起推进 250 ms 后的书卡列表",
    checklist: [],
    criteria: ["结果中可见《从零开始》", "结果仍呈网格排布"],
    by: SHOT_TESTS.realSearchPinyin,
  },
  {
    ...DEFAULTS,
    name: "author-filter",
    rs: "RS-05",
    profile: "real",
    book: null,
    url: "/",
    state:
      "检索框为空时点击一张书卡上的作者按钮后，筛选状态条显示中；作者取首批书卡中在 books.json 里" +
      "作品数最多的一位（并列时取首批中最先出现的）",
    checklist: [],
    criteria: ["可见当前筛选的作者名与清除入口", "可见书卡的作者全部相同"],
    by: SHOT_TESTS.realAuthorFilter,
  },
  {
    ...DEFAULTS,
    name: "recent-reads",
    rs: "RS-06",
    profile: "fixture",
    book: null,
    url: "/",
    state:
      "localStorage 中有 7.13 的 6 条阅读进度（T0 − 30 s 至 T0 − 240 h），书架在 Controlled_Clock " +
      "暂停于 T0 时加载完成，「最近阅读」列出其中 5 条",
    checklist: [],
    criteria: ["区块位于书卡网格之上", "5 行各有书名、章节名与相对时间", "文字可辨认"],
    by: SHOT_TESTS.shelfRecent,
  },
  {
    ...DEFAULTS,
    name: "detail-modal",
    rs: "RS-07",
    profile: "real",
    book: { role: "pinyin" },
    url: `/?book=${BOOK_ID_PLACEHOLDER}`,
    state: "新页面直接访问该 URL，books.json 加载完成后详情弹窗显示中",
    checklist: [],
    criteria: ["弹窗浮于书架之上且背景变暗", "章节网格可见且无空白格"],
    by: SHOT_TESTS.realDetailModal,
  },
  {
    ...DEFAULTS,
    name: "toc-volumes",
    rs: "RS-08",
    profile: "real",
    book: { role: "volumes" },
    url: `/read/${BOOK_ID_PLACEHOLDER}`,
    state: "《1852铁血中华》阅读器打开目录抽屉（检索框为空），列表滚到首个卷节点的行进入可视区",
    checklist: ["H5"],
    criteria: [
      "卷标题与章节行在字重、底色或缩进中至少一项上可区分",
      "卷标题不带当前章节的选中底色",
    ],
    by: SHOT_TESTS.tocVolumes,
  },
  {
    ...DEFAULTS,
    name: "toc-huge-middle",
    rs: "RS-09",
    profile: "real",
    book: { role: "huge" },
    url: `/read/${BOOK_ID_PLACEHOLDER}`,
    state:
      "《极品全能高手》目录抽屉（检索框为空）滚到中部：scrollTop 为（可滚动总高度 − 可视高度）/ 2，" +
      "已挂载行集合连续 2 个动画帧不变",
    checklist: ["H1"],
    criteria: ["可视区内的行连续，无空白行或重叠行", "显示的章节序号在全书中部附近"],
    by: SHOT_TESTS.tocWindow,
  },
  {
    ...DEFAULTS,
    name: "search-highlight",
    rs: "RS-10",
    profile: "real",
    book: { role: "longText" },
    url: `/read/${BOOK_ID_PLACEHOLDER}`,
    state: "《从零开始》检索抽屉中选择一条命中不在章节标题行内的结果后：检索抽屉已关闭，正文区有 1 个高亮",
    checklist: ["H4"],
    criteria: [
      "高亮文字在视口内，底色与正文背景明显不同",
      "高亮所在段落未被顶栏或底栏遮挡",
    ],
    by: SHOT_TESTS.searchHighlight,
  },
  {
    ...DEFAULTS,
    name: "search-highlight-cleared",
    rs: "RS-11",
    profile: "real",
    book: { role: "longText" },
    url: `/read/${BOOK_ID_PLACEHOLDER}`,
    state: "RS-10 之后 Controlled_Clock 自点击检索结果起累计推进 5,000 ms：高亮已移除，滚动位置不变",
    checklist: ["H4"],
    criteria: ["与 RS-10 为同一段落", "高亮底色已消失"],
    by: SHOT_TESTS.searchHighlight,
  },
  {
    ...DEFAULTS,
    name: "theme-swatches",
    rs: "RS-12",
    profile: "fixture",
    book: { role: "volumes" },
    url: `/read/${BOOK_ID_PLACEHOLDER}`,
    state: "夹具书（volumes 用途）阅读器中打开设置抽屉，尚未切换主题（当前为应用默认主题）",
    checklist: ["H6"],
    criteria: [
      "5 个主题色块的颜色两两可区分",
      "当前主题的色块有可见的选中标记",
      "每个色块旁的名称与其颜色相符（如\"极夜纯黑\"为黑色）",
    ],
    by: SHOT_TESTS.themeSwatches,
  },
  ...THEME_KEYS.map(
    (key): CatalogEntry => ({
      ...DEFAULTS,
      name: `reader-theme-${key}`,
      rs: "RS-13",
      profile: "real",
      theme: key,
      book: { role: "volumes" },
      url: `/read/${BOOK_ID_PLACEHOLDER}`,
      state: `《1852铁血中华》阅读器，已存储主题 ${key}：不带进度打开，停在首个正文章节的章首，三个抽屉均关闭`,
      checklist: ["H6"],
      criteria:
        THEME_COLOR_SCHEME[key] === "dark" ? [...RS13_CRITERIA, RS13_DARK_CRITERION] : [...RS13_CRITERIA],
      by: SHOT_TESTS.realReaderTheme[key],
    }),
  ),
  {
    ...DEFAULTS,
    name: "progress-indeterminate",
    rs: "RS-14",
    profile: "real",
    mode: "transparent",
    book: { role: "huge" },
    url: `/read/${BOOK_ID_PLACEHOLDER}`,
    state: "Transparent_Mode 下以 CDP 节流首次打开《极品全能高手》，加载中：书籍加载进度条为不确定态（不带 aria-valuenow）",
    checklist: ["H10"],
    criteria: ["进度轨道内有一截短条", "未显示 0% 或超过 100% 的百分比"],
    by: SHOT_TESTS.progressIndeterminate,
  },
  {
    ...DEFAULTS,
    name: "progress-determinate",
    rs: "RS-15",
    profile: "real",
    book: { role: "huge" },
    url: `/read/${BOOK_ID_PLACEHOLDER}`,
    state: "Opaque_Mode 下以 CDP 节流首次打开《极品全能高手》，加载中：书籍加载进度条为确定态，已显示百分比",
    checklist: [],
    criteria: ["进度条填充宽度与显示的百分比相符"],
    by: SHOT_TESTS.progressDeterminate,
  },
  {
    ...DEFAULTS,
    name: "cache-usage",
    rs: "RS-16",
    profile: "real",
    book: { role: "stars" },
    url: `/read/${BOOK_ID_PLACEHOLDER}`,
    state:
      "全新上下文中先整页打开《第七天》、再整页打开《三国配角演义》，IndexedDB 出现这 2 条记录后在" +
      "《三国配角演义》阅读器中打开设置抽屉，「已缓存」一行已由「统计中…」变为读数",
    checklist: ["H11"],
    criteria: ["\"已缓存\"显示 2 本与带单位的字节数", "上限滑杆的当前值可读"],
    by: SHOT_TESTS.realCacheUsage,
  },
  {
    ...DEFAULTS,
    name: "toc-fallback",
    rs: "RS-17",
    profile: "real",
    book: { role: "fallback" },
    url: `/read/${BOOK_ID_PLACEHOLDER}`,
    state: "《第七天》阅读器停在下标 0 的节点，打开目录抽屉（检索框为空），列表在顶部",
    checklist: [],
    criteria: ["条目为\"第 N 部分\"且序号连续"],
    by: SHOT_TESTS.tocFallback,
  },
  {
    ...DEFAULTS,
    name: "toc-stars",
    rs: "RS-18",
    profile: "real",
    book: { role: "stars" },
    url: `/read/${BOOK_ID_PLACEHOLDER}`,
    state: "《三国配角演义》阅读器打开目录抽屉（检索框为空），列表在顶部",
    checklist: [],
    criteria: ["每一行都有可见文字，无空白行"],
    by: SHOT_TESTS.tocStars,
  },
  {
    ...DEFAULTS,
    name: "reader-mobile-toc",
    rs: "RS-19",
    profile: "real",
    viewport: "mobile",
    book: { role: "fallback" },
    url: `/read/${BOOK_ID_PLACEHOLDER}`,
    state: "移动视口，《第七天》阅读器正文加载完成后打开目录抽屉",
    checklist: [],
    criteria: ["抽屉宽度不超过屏宽的 85%，抽屉外可见遮罩", "正文无横向溢出"],
    by: SHOT_TESTS.realMobileToc,
  },
  {
    ...DEFAULTS,
    name: "load-error",
    rs: "RS-20",
    profile: "fixture",
    book: null,
    url: "/read/不存在的id",
    state: "访问不在 books.json 中、书库也没有其文件的中文 id，书籍加载进度条消失后的错误页",
    checklist: [],
    criteria: [
      "显示表明未能打开该书的错误标题、一行错误说明与\"返回书架\"按钮",
      "页面非空白",
    ],
    by: SHOT_TESTS.loadErrorMissingBook,
  },
  {
    ...DEFAULTS,
    name: "bookmark-list",
    rs: "RS-21",
    profile: "fixture",
    book: { role: "longText" },
    url: `/read/${BOOK_ID_PLACEHOLDER}`,
    state: "夹具书（longText 用途）某章滚到第 k 段（k ≥ 1）并点击「添加书签」后，打开目录抽屉的「我的书签」列表",
    checklist: [],
    criteria: ["书签条目显示章节名与预览文字"],
    by: SHOT_TESTS.bookmarkAdd,
  },
];

/** Review_Catalog：25 张，按附录 A 的顺序（13.1、13.2、13.3）。 */
export const REVIEW_CATALOG: readonly ReviewShotDef[] = ENTRIES;

/** 按名称取定义；不在 catalog 中时抛错。 */
export function reviewShot(name: ReviewShotName): ReviewShotDef {
  const def = ENTRIES.find((d) => d.name === name);
  if (def === undefined) throw new Error(`Review_Catalog 中没有 ${name}`);
  return def;
}

// ---------------------------------------------------------------------------
// 路径与用例
// ---------------------------------------------------------------------------

/** Review_Shot 的文件名（13.10：由名称唯一确定），也是它相对 Review_Report 的路径。 */
export function reviewShotFileName(name: string): string {
  return `${name}.png`;
}

/** Review_Shot 的绝对路径：`e2e/.out/review/<name>.png`。 */
export function reviewShotFile(name: string): string {
  return path.join(REVIEW_DIR, reviewShotFileName(name));
}

/** 由用例文件的绝对路径与标题得到 `ShotTestRef`（reporter 与 `shot` fixture 同用这一口径）。 */
export function shotTestRef(absFile: string, title: string): ShotTestRef {
  return { file: path.relative(TESTS_DIR, absFile).split(path.sep).join("/"), title };
}

export function sameShotTest(a: ShotTestRef, b: ShotTestRef): boolean {
  return a.file === b.file && a.title === b.title;
}

// ---------------------------------------------------------------------------
// 书与 URL
// ---------------------------------------------------------------------------

/**
 * 截图涉及的书 id。`{ role }` 在 real 下取测试用书表（不做 4.7 核对），在 fixture 下取 `roles`
 * （`roles.json`）；fixture 下 `roles` 为 null，或该用途在 real 下没有 Test_Book 时返回 null。
 */
export function resolveShotBook(def: ReviewShotDef, roles: FixtureRoles | null): string | null {
  const { book } = def;
  if (book === null) return null;
  if ("id" in book) return book.id;
  if (def.profile === "real") return testBookFor(book.role)?.id ?? null;
  return roles === null ? null : fixtureRoleBookId(roles, book.role);
}

/** 代入书 id 后的 URL（未编码）；`bookId` 为 null 时保留占位串。 */
export function resolveShotUrl(def: ReviewShotDef, bookId: string | null): string {
  return bookId === null ? def.url : def.url.split(BOOK_ID_PLACEHOLDER).join(bookId);
}

function decodePath(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

/**
 * 当前页面是否处在定义的 URL 上：解码后的路径相同，且 `expected` 的每个查询参数都在当前页面中、
 * 取值相同（当前页面可多带参数）。`expected` 为 `resolveShotUrl` 的结果。
 */
export function pageMatchesShotUrl(pageUrl: string, expected: string): boolean {
  const actual = new URL(pageUrl);
  if (actual.origin === "null") return false; // about:blank 等不透明源
  const want = new URL(expected, actual.origin);
  if (decodePath(actual.pathname) !== decodePath(want.pathname)) return false;
  for (const [key, value] of want.searchParams) {
    if (!actual.searchParams.getAll(key).includes(value)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 报告用的元数据（13.1、13.3）
// ---------------------------------------------------------------------------

const VIEWPORT_LABELS: Readonly<Record<ShotViewport, string>> = { desktop: "桌面", mobile: "移动" };
const MODE_LABELS: Readonly<Record<Mode, string>> = {
  opaque: "Opaque_Mode",
  transparent: "Transparent_Mode",
};
const SCOPE_LABELS: Readonly<Record<ShotScope, string>> = {
  viewport: "视口",
  element: "元素",
  fullPage: "整页",
};

export function describeViewport(viewport: ShotViewport): string {
  const { width, height } = VIEWPORTS[viewport];
  return `${VIEWPORT_LABELS[viewport]} ${width}×${height}`;
}

function describeBook(def: ReviewShotDef, bookId: string | null): string {
  const { book } = def;
  if (book === null) return "—";
  if ("id" in book) return book.id;
  if (bookId === null) {
    return def.profile === "fixture"
      ? `用途 ${book.role}（roles.json 不可用）`
      : `用途 ${book.role}（real 下没有对应的 Test_Book）`;
  }
  return `${bookId}（用途 ${book.role}）`;
}

/**
 * 13.1 的全部场景元数据，按 Review_Report 中的顺序；主题写作"默认主题（未存储，实际 sepia）"或
 * "dark（暗色夜间）"。`roles` 为 fixture 的 `roles.json`（取不到时传 null）。
 */
export function shotMetadata(
  def: ReviewShotDef,
  roles: FixtureRoles | null,
): readonly { label: string; value: string }[] {
  const bookId = resolveShotBook(def, roles);
  return [
    { label: "名称", value: `${def.name}（${def.rs}）` },
    { label: "Library_Profile", value: def.profile },
    { label: "视口", value: describeViewport(def.viewport) },
    { label: "主题", value: describeTheme(def.theme) },
    { label: "服务器模式", value: MODE_LABELS[def.mode] },
    { label: "书 id", value: describeBook(def, bookId) },
    { label: "URL", value: resolveShotUrl(def, bookId) },
    { label: "要展示的状态", value: def.state },
    { label: "截取范围", value: SCOPE_LABELS[def.scope] },
    { label: "覆盖的 Checklist 项", value: def.checklist.length > 0 ? def.checklist.join("、") : "—" },
  ];
}
