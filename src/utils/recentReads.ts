/**
 * "最近阅读"区块的取数与时间文案（需求 5.10，差异表 B5 / 缺陷 E6）。
 *
 * B5 的原话是"函数已在，只缺一个组件"——`getAllReadingHistory()` 自始就实现完整却无人调用。
 * 但那个函数交出来的是**进度记录**，而需求 5.10 要展示的是"书名 + 上次章节 + 相对时间 +
 * 续读入口"，两者之间差着两件这里补上的活：
 *
 * 1. **书名不在记录里**。进度记录（`ReadingProgress`，design §2.3）只有 `bookId` 与
 *    `chapterTitle`，书名得拿 `books.json` 的条目对出来——所以本模块是"历史 × 书目"的连接，
 *    而不是历史的格式化。
 * 2. **相对时间是纯算术**，正是最容易差一位、也最不该埋在 JSX 里的那类逻辑（design §11 把
 *    单测范围划定为"纯 TS 工具函数"，这两件都落在里面；React 组件不在单测范围内）。
 *
 * 模块只做数据，不含任何 DOM/React 依赖：区块的呈现在 `components/RecentReads.tsx`。
 */

import { BookSummary, ReadingProgress } from "../types";

/** 区块最多展示几条（需求 5.10 的"最多 5 条"）。 */
export const RECENT_READS_LIMIT = 5;

/**
 * `chapterTitle` 为空时的占位。
 *
 * 空标题不是假想情况：`readProgress()` 对坏掉的字段一律补退化值而不丢整条记录（需求 2.8），
 * 空串正是它给 `chapterTitle` 的退化值。这里不退化成"第 N 章"——`chapterId` 是含卷节点的
 * 原始下标，拿它当章序号会报出一个和目录对不上的数字，比承认不知道更糟。
 */
export const UNKNOWN_CHAPTER_TITLE = "未记录章节";

/** 区块里的一行：历史记录与书目条目连接后的结果。 */
export interface RecentRead {
  bookId: string;
  /** 来自 `books.json`，进度记录里没有这个字段。 */
  title: string;
  /** 同上。7000 本里同名书不罕见（A18），作者是行与行之间的区分依据。 */
  author: string;
  /** 上次读到的章节名，空记录用 `UNKNOWN_CHAPTER_TITLE` 兜。 */
  chapterTitle: string;
  /** 交给 `formatRelativeTime()` 的原始时间戳，格式化留到渲染时做。 */
  lastReadTime: number;
}

/**
 * 把阅读历史连接到书目上，取最近的 `limit` 条（需求 5.10）。
 *
 * ## 书目里没有的书直接丢掉
 *
 * 进度记录按 `koodo_novel_progress_<bookId>` 每书一键存在 localStorage 里，生命周期与
 * `books.json` 完全独立：源包删掉、`book_id` 因消歧改名（A18）、换站点重跑预处理，都会留下
 * 一条指向已不存在书籍的记录。这类记录**不渲染**，两个理由缺一不可：
 *
 * - 需求 5.10 要求展示书名，而记录里没有书名，对不上书目就只能显示 id（`从零开始-雷云风暴`
 *   这种拼接串），那不是书名；
 * - "续读入口"会落到 `/read/<id>`，而阅读器取 `<id>.txt.gz` 必然 404。给读者一个必然失败的
 *   入口比不给更糟。
 *
 * 过滤发生在**取前 5 条之前**：否则一本早已删掉的书会白占一个名额，让区块只剩 4 行。
 * 记录本身不在这里清理——那是 `storage.ts` 的上限淘汰（需求 2.9）该管的事，书架读一次页面
 * 就顺手删存储不是取数函数该有的副作用。
 *
 * @param history 通常来自 `getAllReadingHistory()`。**不会被修改**（排序走副本）。
 * @param books `books.json` 的 `books` 数组。
 * @param limit 上限，脏值（负数 / `NaN`）按 0 处理，即不渲染任何行。
 */
export function buildRecentReads(
  history: ReadingProgress[],
  books: BookSummary[],
  limit: number = RECENT_READS_LIMIT,
): RecentRead[] {
  const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  if (max === 0 || history.length === 0 || books.length === 0) return [];

  // 先出现的条目胜出：`books.json` 的 id 由预处理保证唯一（A18 的消歧），这只是不让
  // 万一重复的条目改变"第一条即权威"的取值。
  const byId = new Map<string, BookSummary>();
  for (const book of books) {
    if (!byId.has(book.id)) byId.set(book.id, book);
  }

  /*
   * 自己再排一次序，不依赖入参已排好。
   *
   * `getAllReadingHistory()` 确实按 `lastReadTime` 降序返回，但本函数的"最多 5 条"只有在
   * 输入有序时才等于"最近 5 条"——把这个前提写进契约，就得让每个调用点都去保证它。记录数有
   * 上限 50（`MAX_PROGRESS_RECORDS`），排一次的成本可以忽略。
   * 同刻记录按 bookId 兜一个稳定次序，使结果不随宿主的排序实现摆动。
   */
  const ordered = [...history].sort(
    (a, b) => b.lastReadTime - a.lastReadTime || (a.bookId < b.bookId ? -1 : 1),
  );

  const out: RecentRead[] = [];
  // 每书一键，bookId 本不会重复；这道去重是给 `key={bookId}` 兜底的，重复的 key 会让 React
  // 复用错行。
  const seen = new Set<string>();

  for (const record of ordered) {
    if (out.length >= max) break;
    if (seen.has(record.bookId)) continue;

    const book = byId.get(record.bookId);
    if (!book) continue;

    seen.add(record.bookId);
    out.push({
      bookId: record.bookId,
      title: book.title,
      author: book.author,
      chapterTitle: record.chapterTitle.trim() || UNKNOWN_CHAPTER_TITLE,
      lastReadTime: record.lastReadTime,
    });
  }

  return out;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** 本地时区当天零点的时间戳。跨天判定的基准。 */
function startOfLocalDay(timestamp: number): number {
  const d = new Date(timestamp);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * 相差几个**日历日**（本地时区）。同一天为 0，昨天为 1。
 *
 * 先归到当天零点再相减，而不是 `Math.floor(delta / DAY_MS)`：后者算的是"过了几个 24 小时"，
 * 于是今天 00:30 看昨天 23:00 会得出 0 天、被说成"1 小时前"，而读者心里那是昨天的事。
 * 外层 `Math.round` 吸收夏令时造成的 23/25 小时日（本地时区不一定是东八区）。
 */
function calendarDayDiff(from: number, to: number): number {
  return Math.round((startOfLocalDay(to) - startOfLocalDay(from)) / DAY_MS);
}

/**
 * 相对时间文案（需求 5.10 的"相对时间"）。
 *
 * ## 为什么手写，不用 `Intl.RelativeTimeFormat`
 *
 * `Intl.RelativeTimeFormat` 负责的是"给定数值与单位 → 本地化短语"（`format(-3, "minute")`
 * → `3分钟前`），**选单位与判定跨天仍然要自己算**——而那恰恰是这里全部的逻辑，也是唯一会
 * 出错的部分。换过去之后本函数的分支一条都不会少，只是把最后一步的字符串拼接外包出去，代价是：
 *
 * - `numeric: "auto"` 才会把 -1 天说成"昨天"，而它输出什么由运行时的 ICU 数据决定，Node 与
 *   各浏览器版本并不保证一致，单测就只能断言"大概是那个意思"；
 * - 本站的界面文案（"章"、"万字"、"继续阅读"）全是硬编码中文，没有多语言诉求，拿不到它
 *   唯一的真实好处。
 *
 * 所以这里手写，换来确定的输出与可断言的边界。要做多语言时再整体替换。
 *
 * ## 档位
 *
 * 分钟级两档在日历判定**之前**（跨午夜的 20 分钟仍是"20 分钟前"，不是"昨天"），其后全部走
 * 日历日。上限只有 50 条记录、区块只显示 5 行，"3 个月前"这种粗档位足够——真要精确时间，
 * 书卡上的百分比与阅读器里的进度才是去处。
 *
 * @param timestamp 记录的 `lastReadTime`。非有限数或 ≤ 0（`readProgress()` 对坏值的退化值）
 *   返回空串，由调用方决定不渲染——编不出时间比编一个"1970"好。
 * @param now 注入当前时刻，使测试不依赖真实时钟。
 */
export function formatRelativeTime(timestamp: number, now: number = Date.now()): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "";

  const delta = now - timestamp;
  // delta < 0 是宿主时钟被回调（或记录来自另一台设备）。"刚刚"是这种情况下最不刺眼的说法，
  // 负数天差会一路掉进下面的档位算出"-1 天前"。
  if (delta < MINUTE_MS) return "刚刚";
  if (delta < HOUR_MS) return `${Math.floor(delta / MINUTE_MS)} 分钟前`;

  const days = calendarDayDiff(timestamp, now);
  if (days <= 0) return `${Math.floor(delta / HOUR_MS)} 小时前`;
  if (days === 1) return "昨天";
  if (days === 2) return "前天";
  if (days < 7) return `${days} 天前`;
  if (days < 30) return `${Math.floor(days / 7)} 周前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return `${Math.floor(days / 365)} 年前`;
}
