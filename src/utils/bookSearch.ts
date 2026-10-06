/**
 * 书架模糊检索（design §5，需求 5.3–5.5）。
 *
 * 零运行时依赖：子序列匹配 + 连续命中加权，配上构建期由 `pypinyin` 写进 `books.json` 的
 * 拼音首字母（需求 5.6，前端不引任何拼音库）。**不引 FlexSearch**——它对 CJK 无内置分词，
 * `tokenize:"full"` 本质仍是子串匹配，拿不到"青巷"→《青石巷》这种跳字命中（附录 M4）。
 *
 * 模块的划分方式本身是为了守住一条性能约束：`haystack`（每本书的检索串）必须在加载
 * `books.json` 后**一次性**拼好并缓存，绝不能放在依赖搜索词的 `useMemo` 里——那正是
 * design §6.1 里 `fullText.toLowerCase()` 每次按键把整本书的全文重跑一遍的同类错误。故拼串
 * （`buildSearchIndex`）与打分（`searchBooks`）是两个独立入口，调用方无法把它们塞进
 * 同一个 memo。
 */

import { BookSummary } from "../types";

/**
 * 子序列模糊匹配的得分：`needle` 的每个字符都能在 `hay` 里按序找到时返回正分，
 * 否则返回 **0**（不命中）。
 *
 * 计分规则（design §5）：每命中一个字符基础分 1；与上一次命中紧邻（连续命中）时按连击
 * 数额外加 `streak * 2`，所以"完整子串"永远排在"跳字命中"前面；跳过的字符每个扣 0.1，
 * 最多扣 4 个（0.4），避免长书名里零散的命中被距离惩罚压成负分。
 *
 * 返回值口径：**0 表示不命中**（design §11 的测试约定，而非 §5 示例代码里的 -1）。
 * 两者在本函数上等价可选，取 0 是因为多词求和时"命中 ⇔ 分数 > 0"这一条判据能同时用于
 * 单词与词组；而任何真实命中的最低分是 `1 - 0.4 = 0.6`，与 0 不会相撞。
 */
export function fuzzyScore(hay: string, needle: string): number {
  if (!needle) return 0;

  let hi = 0;
  let score = 0;
  let streak = 0;

  for (const ch of needle) {
    const idx = hay.indexOf(ch, hi);
    if (idx === -1) return 0;
    streak = idx === hi ? streak + 1 : 0;
    score += 1 + streak * 2 - Math.min(idx - hi, 4) * 0.1;
    // 用 `ch.length` 而非 §5 示例的 `+ 1`：`for...of` 按码点迭代，遇到 BMP 之外的字符
    // （书名里的生僻字、emoji）`ch` 是两个码元，加 1 会把游标停在代理对中间，使下一个
    // 字符的"紧邻"判定失真。对 CJK 与 ASCII 两者完全一致。
    hi = idx + ch.length;
  }

  return score;
}

/** 索引中的一本书：原条目 + 预拼好的检索串。 */
export interface SearchableBook {
  book: BookSummary;
  /** 书名 + 作者 + 两者拼音首字母，小写。 */
  haystack: string;
}

/**
 * 拼出单本书的检索串（design §5）：书名、作者、书名拼音首字母、作者拼音首字母，小写。
 *
 * 缺失的 `titleAbbr` / `authorAbbr` 必须先落成空串再拼——纯 ASCII 书名（只含英文字母、数字与符号）的
 * 产物里这两个字段是省略的，直接套模板字符串会把字面量 `undefined` 拼进检索串，于是
 * 任意包含 u/n/d/e/f 子序列的查询都会命中这本书。
 */
export function buildHaystack(book: BookSummary): string {
  return [book.title, book.author, book.titleAbbr ?? "", book.authorAbbr ?? ""]
    .filter((part) => part.length > 0)
    .join(" ")
    .toLowerCase();
}

/**
 * 为整份书架建索引。**只在 `books.json` 加载完成后调用一次**，结果缓存在不依赖搜索词的
 * 位置（需求 5.3 的性能前提，见模块说明）。
 */
export function buildSearchIndex(books: readonly BookSummary[]): SearchableBook[] {
  return books.map((book) => ({ book, haystack: buildHaystack(book) }));
}

/** 查询串按空白拆词并小写化；空串与纯空白得到空数组。 */
export function splitQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 0);
}

/**
 * 词组对单本书的总分：**每个词都必须命中**（AND 语义），分数求和；任一词落空即 0。
 *
 * 求和而非取最大，是为了让"多给一个词"的查询把匹配得更完整的书顶上去。
 */
export function scoreHaystack(haystack: string, needles: readonly string[]): number {
  let total = 0;

  for (const needle of needles) {
    const score = fuzzyScore(haystack, needle);
    if (score <= 0) return 0;
    total += score;
  }

  return total;
}

/**
 * 检索并按分数降序返回（需求 5.5）。
 *
 * 空查询原样返回全部书籍，保持 `books.json` 的原始顺序。同分条目也保持原序——
 * `Array.prototype.sort` 在 ES2019 起是稳定排序，不必再塞一个下标做次级键。
 */
export function searchBooks(
  index: readonly SearchableBook[],
  query: string,
): BookSummary[] {
  const needles = splitQuery(query);
  if (needles.length === 0) return index.map((entry) => entry.book);

  const hits: { book: BookSummary; score: number }[] = [];
  for (const entry of index) {
    const score = scoreHaystack(entry.haystack, needles);
    if (score > 0) hits.push({ book: entry.book, score });
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.map((hit) => hit.book);
}

/**
 * 预处理在文件名里找不到"作者：xxx"时写入的占位值（`preprocess.parse_filename_meta`）。
 *
 * 它不是一个作者，是"作者未知"这件事本身。
 */
export const UNKNOWN_AUTHOR = "佚名";

/**
 * 这个作者名值不值得做成筛选入口（需求 5.11）。
 *
 * 排除 `UNKNOWN_AUTHOR` 与空值：按它筛出来的是"全库所有没能从文件名解析出作者的书"——7000 本规模下
 * 这一桶既大又彼此无关（A18 提到同名书里大量作者是占位值，正是这个来源），点进去回答不了
 * "这个作者还写了什么"，只会把书架换成一份更长的乱序清单。做成不可点的纯文本，
 * 读者也就不会去点一个注定没用的东西。
 */
export function isFilterableAuthor(author: string | null | undefined): boolean {
  if (!author) return false;
  const trimmed = author.trim();
  return trimmed.length > 0 && trimmed !== UNKNOWN_AUTHOR;
}

/**
 * 按作者筛选（需求 5.11）。`author` 为 `null` / 空串时原样返回，表示"没有筛选"。
 *
 * 判定是 `author` 字段的**精确相等**，不复用上面的模糊匹配：筛选值总是从某本书自己的
 * `author` 上点出来的，精确相等因此保证结果非空（至少含被点的那本），语义也恰好是读者要的
 * "同一个作者的全部作品"。放宽成模糊/子串会把"作者甲"与"作者甲2"这类不同笔名悄悄并进
 * 一桶，而读者从结果里看不出它们本是两个人——这种错误比漏掉几本更难发现。同一作者名的
 * 拼写变体（多余空格、繁简）留给预处理去规范，不在这里猜。
 *
 * 与检索词是 **AND** 关系：调用方把检索结果交给本函数，两个条件同时收窄。顺序不影响结果集
 * （筛选保序，检索已按分数排好），也不影响观感——7000 本的模糊检索是 1ms 量级（附录 M4）。
 */
export function filterByAuthor(
  books: readonly BookSummary[],
  author: string | null,
): readonly BookSummary[] {
  if (!author) return books;
  return books.filter((book) => book.author === author);
}
