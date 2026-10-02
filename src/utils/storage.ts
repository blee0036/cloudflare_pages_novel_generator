import { ReaderSettings, ReadingProgress, Bookmark } from "../types";
import { SLIDER_SPECS, normalizeSliderSettings } from "./sliderSettings";

/*
 * 这里曾有 `ThemeConfig` 与 `THEME_CONFIGS`（5 套 × 5 个颜色），任务 44 一并删除：
 * 主题配色的唯一真相现在是 `src/index.css` 的 `[data-theme="..."]` 变量块（需求 6.1），
 * 运行时不再有任何 TS 代码持有颜色值，组件也不再接收主题 prop（需求 6.5）。
 * 主题的键定义在 `src/types.ts`（`ReaderThemeKey`），给读者看的名字在
 * `src/utils/theme.ts`（`READER_THEMES`）——本模块只管持久化，不管呈现。
 */

// 5 个滑杆项的默认值取自 `SLIDER_SPECS` 的 `fallback`（19 / 1.85 / 1 / 820 / 10），与归一时
// "不是有限数取默认值"用的是同一个数，两处不会各说各话。
const DEFAULT_SETTINGS: ReaderSettings = {
  theme: "sepia",
  fontSize: SLIDER_SPECS.fontSize.fallback,
  lineHeight: SLIDER_SPECS.lineHeight.fallback,
  letterSpacing: SLIDER_SPECS.letterSpacing.fallback,
  fontFamily: "system",
  contentWidth: SLIDER_SPECS.contentWidth.fallback,
  // 离线缓存本数上限（需求 4.2）。旧 localStorage 里没有这个键，浅合并会自动补上这个默认值。
  // 它必须与 `utils/bookCache.ts` 的 `DEFAULT_MAX_BOOKS` 一致（有单测钉住）；不 import 的原因
  // 见 `sliderSettings.ts` 的模块说明（bookCache 要读本模块的设置，会成环）。
  cacheMaxBooks: SLIDER_SPECS.cacheMaxBooks.fallback,
};

// 白名单：只有这些字段会被写回 localStorage。旧版本遗留的键（如 viewMode）
// 即使存在于 localStorage 也不会被再次持久化，从而自然消失。
// 显式字面量而非遍历键，好处是编译器会强制它与 ReaderSettings 完全一致。
function pickSettings(raw: ReaderSettings): ReaderSettings {
  return {
    theme: raw.theme,
    fontSize: raw.fontSize,
    lineHeight: raw.lineHeight,
    letterSpacing: raw.letterSpacing,
    fontFamily: raw.fontFamily,
    contentWidth: raw.contentWidth,
    cacheMaxBooks: raw.cacheMaxBooks,
  };
}

const SETTINGS_KEY = "koodo_novel_reader_settings";
const PROGRESS_PREFIX = "koodo_novel_progress_";
const BOOKMARKS_PREFIX = "koodo_novel_bookmarks_";

/**
 * 进度记录条数上限（需求 2.9）。超限时按 `lastReadTime` 淘汰最旧的。
 *
 * 取 50 的理由：旧版的上限是 20，但那是因为旧版把全部记录挤在**一个**键里，每次保存都要
 * 重写整个数组，条数直接等于写放大倍数；新版每书一键（C18），保存只写自己那一条，条数不再
 * 影响写入成本，上限只需要防"键无限增长"。单条记录约 200 字节，50 条约 10KB，占 5MB 配额
 * 的 0.2%；同时给"最近阅读"区块（最多 5 条，任务 55）留了十倍余量，正常读者不可能被淘汰
 * 波及。要再调大也只影响枚举键的那一次 O(n)。
 */
export const MAX_PROGRESS_RECORDS = 50;

function progressKey(bookId: string): string {
  return `${PROGRESS_PREFIX}${bookId}`;
}

function bookmarksKey(bookId: string): string {
  return `${BOOKMARKS_PREFIX}${bookId}`;
}

/**
 * 取 localStorage，拿不到就返回 `null`。
 *
 * 不直接用全局名字，是因为访问它本身就可能抛（Safari 隐私模式）、也可能根本不存在
 * （单元测试跑在 Node 上）。调用点因此可以只处理"没有存储"这一种退化，而不必每个函数
 * 都包一层 try/catch 去接 `ReferenceError`。
 */
function getStore(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * 读一个键并 `JSON.parse`。键不存在、存储不可用、内容坏掉都返回 `undefined`，
 * 由调用方的规范化函数统一处理（它们对 `undefined` 的结论就是"没有记录"）。
 */
function readJson(key: string): unknown {
  const store = getStore();
  if (!store) return undefined;
  try {
    const raw = store.getItem(key);
    return raw === null ? undefined : JSON.parse(raw);
  } catch (e) {
    console.error(`Failed to read ${key}:`, e);
    return undefined;
  }
}

/** 写一个键，返回是否真的写进去了（配额满 / 存储不可用时为 false）。 */
function writeJson(key: string, value: unknown): boolean {
  const store = getStore();
  if (!store) return false;
  try {
    store.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    console.error(`Failed to write ${key}:`, e);
    return false;
  }
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/**
 * 章内字符偏移的规范化：非负整数，任何坏值（缺失、NaN、负数、字符串）都回到 0。
 *
 * 0 是安全的退化值——它就是"章首"，也正是 v1 记录该被理解成的位置（需求 2.8、design §10）。
 */
function asCharOffset(value: unknown): number {
  const n = asNumber(value, 0);
  return n > 0 ? Math.floor(n) : 0;
}

// --- Settings ---

/**
 * 读取设置，缺失 / 坏掉 / 存储不可用时回到默认值。
 *
 * 走本模块的 `readJson` 而不是裸 `localStorage`：宿主没有 localStorage（Node、SSR）时裸访问
 * 会抛 `ReferenceError` 并打一行 console.error，而本函数现在是**每次写缓存都要调**的
 * （`utils/bookCache.ts` 要读 `cacheMaxBooks`），那样每打开一本书就刷一条假错误。
 *
 * 浅合并保证新增字段（如 `cacheMaxBooks`）对旧存储自动取默认值；随后 `normalizeSliderSettings`
 * 把 5 个滑杆项归一到各自的区间与步进网格上（需求 6.5，D4）：手改过的存储给出的字符串、越界值、
 * 不在网格上的值在这里就收拢，滑杆位置、显示数值与生效值因此一致；
 * 最后 `pickSettings` 把结果收拢到白名单字段，旧版遗留键不会漏进返回值。
 * `theme` 与 `fontFamily` 不在归一范围内，仍是浅合并的原值。
 */
export function getStoredSettings(): ReaderSettings {
  const raw = readJson(SETTINGS_KEY);
  if (typeof raw !== "object" || raw === null) return DEFAULT_SETTINGS;
  return pickSettings(normalizeSliderSettings({ ...DEFAULT_SETTINGS, ...raw }));
}

export function saveStoredSettings(settings: ReaderSettings) {
  writeJson(SETTINGS_KEY, pickSettings(settings));
}

// --- Reading Progress ---

/**
 * 把磁盘上的任意一条进度记录规范化为 v2（需求 2.8，design §2.3）。
 *
 * v1 记录缺 `charOffset` 与 `v`，还可能带着已废弃的 `scrollRatio`。这里**逐字段重建**
 * 而不是 `{...raw}` 展开：`scrollRatio` 是像素比例，与"字符偏移唯一定位"（INV-1）冲突
 * 且从未被写入过，必须显式丢弃，不能靠类型断言假装它不在对象里。
 *
 * 除 `chapterId` 外的字段坏掉都用退化值补齐而不丢弃整条记录——需求 2.8 要的是"照常加载"，
 * 丢记录等于让读者的进度凭空消失。`chapterId` 不是数字时才返回 `null`：没有章号的记录连
 * "回到章首"都无从谈起。
 *
 * @param bookId 键名里的书 id。给了就以它为准（键名才是权威，记录内的 `bookId` 字段只是
 *   冗余副本；两者不一致时若信记录，回写就会落到另一个键上）。
 */
export function readProgress(raw: unknown, bookId?: string): ReadingProgress | null {
  if (typeof raw !== "object" || raw === null) return null;

  const p = raw as Partial<ReadingProgress> & { scrollRatio?: unknown };
  if (typeof p.chapterId !== "number" || !Number.isFinite(p.chapterId)) return null;

  const id = bookId ?? asString(p.bookId, "");
  if (!id) return null;

  return {
    bookId: id,
    // 小数 / 负数章号夹到合法下标：它会被直接用来索引 chapters[]，脏值会渲染出空白页。
    chapterId: Math.max(0, Math.floor(p.chapterId)),
    chapterTitle: asString(p.chapterTitle, ""),
    charOffset: asCharOffset(p.charOffset),
    progressPercent: Math.min(100, Math.max(0, asNumber(p.progressPercent, 0))),
    lastReadTime: Math.max(0, asNumber(p.lastReadTime, 0)),
    v: 2,
  };
}

export function getBookProgress(bookId: string): ReadingProgress | null {
  return readProgress(readJson(progressKey(bookId)), bookId);
}

export function saveBookProgress(progress: ReadingProgress) {
  if (!writeJson(progressKey(progress.bookId), progress)) return;
  enforceProgressLimit(progress.bookId);
}

export function getAllReadingHistory(): ReadingProgress[] {
  const store = getStore();
  if (!store) return [];

  const history: ReadingProgress[] = [];
  try {
    for (const key of progressKeys(store)) {
      const record = readProgress(readJson(key), bookIdFromProgressKey(key));
      if (record) history.push(record);
    }
    history.sort((a, b) => b.lastReadTime - a.lastReadTime);
  } catch (e) {
    console.error("Failed to load reading history:", e);
  }
  return history;
}

/** 进度记录的排序依据，淘汰计算只需要这两个字段。 */
export interface ProgressStamp {
  bookId: string;
  lastReadTime: number;
}

/**
 * 算出为了压回 `limit` 条需要淘汰哪些书的记录（需求 2.9）。纯函数，便于直接断言。
 *
 * `keepBookId`（刚刚写入的那本）永不被淘汰：哪怕它的 `lastReadTime` 因为宿主时钟被回调
 * 而显得最旧，把它删掉也等于"刚读完就丢了进度"。
 * 同刻的记录按 bookId 排序，使结果不依赖键的枚举顺序。
 */
export function planProgressEviction(
  stamps: ProgressStamp[],
  keepBookId?: string,
  limit: number = MAX_PROGRESS_RECORDS,
): string[] {
  const overflow = stamps.length - Math.max(0, limit);
  if (overflow <= 0) return [];

  return stamps
    .filter((s) => s.bookId !== keepBookId)
    .sort((a, b) => a.lastReadTime - b.lastReadTime || (a.bookId < b.bookId ? -1 : 1))
    .slice(0, overflow)
    .map((s) => s.bookId);
}

function progressKeys(store: Storage): string[] {
  const keys: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (key && key.startsWith(PROGRESS_PREFIX)) keys.push(key);
  }
  return keys;
}

function bookIdFromProgressKey(key: string): string {
  return key.slice(PROGRESS_PREFIX.length);
}

/**
 * 把进度记录压回上限以内（需求 2.9）。
 *
 * 进度是"每书一键"而不是一个数组，所以淘汰要先枚举 `koodo_novel_progress_*` 键。
 * 未超限时**只数键名、不解析任何 JSON**——这是绝大多数情况，而本函数每次保存进度都会跑
 * （任务 35 后是停止滚动 1 秒一次），不能把整批记录反复 parse 一遍。
 */
function enforceProgressLimit(keepBookId: string) {
  const store = getStore();
  if (!store) return;

  try {
    const keys = progressKeys(store);
    if (keys.length <= MAX_PROGRESS_RECORDS) return;

    const stamps = keys.map((key) => {
      const bookId = bookIdFromProgressKey(key);
      const record = readProgress(readJson(key), bookId);
      // 读不出来的记录记作最旧：它已经没用了，正好第一批清掉。
      return { bookId, lastReadTime: record ? record.lastReadTime : 0 };
    });

    for (const bookId of planProgressEviction(stamps, keepBookId)) {
      store.removeItem(progressKey(bookId));
    }
  } catch (e) {
    console.error("Failed to enforce progress limit:", e);
  }
}

// --- Bookmarks ---

/**
 * 规范化单条书签（需求 2.6）。缺 `charOffset` 的旧书签补 0，即跳回章首，
 * 与 v1 进度记录的处理一致。
 */
export function readBookmark(raw: unknown, bookId: string): Bookmark | null {
  if (typeof raw !== "object" || raw === null) return null;

  const b = raw as Partial<Bookmark>;
  if (typeof b.chapterId !== "number" || !Number.isFinite(b.chapterId)) return null;

  const chapterId = Math.max(0, Math.floor(b.chapterId));
  const id = asString(b.id, "");

  return {
    // id 是 removeBookmark 的唯一句柄。缺失时用 `书_章` 兜一个稳定值：每章至多一个书签，
    // 所以它既唯一又在多次读取之间不变（随机 id 会让删除按钮点了没反应）。
    id: id || `${bookId}_${chapterId}`,
    bookId,
    chapterId,
    chapterTitle: asString(b.chapterTitle, ""),
    charOffset: asCharOffset(b.charOffset),
    previewText: asString(b.previewText, ""),
    createdAt: Math.max(0, asNumber(b.createdAt, 0)),
  };
}

/**
 * 规范化整个书签数组。非数组（含 `undefined`）一律当空列表。
 *
 * 顺带去掉同章重复项、保留先出现的那条：顶栏书签按钮是个 toggle，"每章至多一个"是它
 * 状态有意义的前提（design §2.4）。`addBookmark` 本来就有去重，这里只是把不变式在读取侧
 * 也钉死，免得手改过的 localStorage 让 toggle 与列表打架。
 */
export function readBookmarks(raw: unknown, bookId: string): Bookmark[] {
  if (!Array.isArray(raw)) return [];

  const out: Bookmark[] = [];
  const seen = new Set<number>();
  for (const item of raw) {
    const bookmark = readBookmark(item, bookId);
    if (!bookmark || seen.has(bookmark.chapterId)) continue;
    seen.add(bookmark.chapterId);
    out.push(bookmark);
  }
  return out;
}

export function getBookmarks(bookId: string): Bookmark[] {
  return readBookmarks(readJson(bookmarksKey(bookId)), bookId);
}

export function saveBookmarks(bookId: string, bookmarks: Bookmark[]) {
  writeJson(bookmarksKey(bookId), bookmarks);
}

export function addBookmark(bookmark: Bookmark) {
  const list = getBookmarks(bookmark.bookId);
  // Avoid duplicates in same chapter
  const exists = list.some((b) => b.chapterId === bookmark.chapterId);
  if (!exists) {
    list.unshift(bookmark);
    saveBookmarks(bookmark.bookId, list);
  }
}

export function removeBookmark(bookId: string, bookmarkId: string) {
  const list = getBookmarks(bookId).filter((b) => b.id !== bookmarkId);
  saveBookmarks(bookId, list);
}

export function isChapterBookmarked(bookId: string, chapterId: number): boolean {
  const list = getBookmarks(bookId);
  return list.some((b) => b.chapterId === chapterId);
}
