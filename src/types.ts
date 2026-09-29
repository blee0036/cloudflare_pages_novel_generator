/**
 * 前端类型定义。与 Python 预处理产物一一对应——`BookSummary` / `BookToc` /
 * `ChapterMeta` 的形状由 `scripts/lib/validate.py` 在构建期强制（需求 7.10），
 * 本文件是它的 TypeScript 镜像（design §2.1、§2.2）。
 *
 * 改这里的产物类型时必须同步 `validate.py`，反之亦然：选 Python 做预处理的代价
 * 就是失去编译期共享类型（需求 A8），两边只能靠"一起改"维持一致。
 */

/**
 * `books.json` 中的单本条目（design §2.2）。
 *
 * **不含 `txtPath` / `tocPath`**：两个 URL 由 `id` 派生（需求 5.1），产物里不写。
 */
export interface BookSummary {
  id: string;
  title: string;
  author: string;
  /**
   * 书名拼音首字母，构建期 `pypinyin` 生成（需求 5.6）。
   * 纯 ASCII 书名（缩写与 `title` 小写相同）时产物省略该字段，故为可选。
   */
  titleAbbr?: string;
  /** 作者拼音首字母，缺省规则同 `titleAbbr`。 */
  authorAbbr?: string;
  charCount: number;
  totalChapters: number;
  gzSize: number;
}

/** `books.json` 的整体形状（design §2.2）。 */
export interface BooksCatalog {
  count: number;
  /**
   * 产物生成时刻，秒级 UTC ISO 8601（`validate.TIMESTAMP` 的口径）。
   *
   * **前端不读它**，但它是 `validate.check_books` 的必需字段（缺失即硬错误），
   * 所以这份镜像里也必须有：本文件声称是产物形状的 TypeScript 镜像，漏掉一个必有字段
   * 会让读代码的人以为 `books.json` 只有 `count` 与 `books`。
   */
  generatedAt: string;
  books: BookSummary[];
}

/**
 * 章节表中的单个节点（design §2.1）。
 *
 * `start` / `end` 是**解压后 UTF-8 文本的字符偏移**（INV-1），且严格连续覆盖全文：
 * `chapters[0].start === 0`、`chapters[i].end === chapters[i+1].start`、
 * `chapters[至末].end === charCount`（需求 8.14）。每个节点的 range **以自己的标题行起始**，
 * 所以章内第一段通常就是标题本身（需求 8.15，渲染时需跳过）。
 */
export interface ChapterMeta {
  id: number;
  title: string;
  start: number;
  end: number;
  length: number;
  /**
   * 卷 / 部 / 册级节点（需求 8.7、12.1）。产物**只在为真时写出**该字段，
   * 故读取一律用 `!!c.isVolume`。
   *
   * 卷节点不是零长度节点：它的 range 恰好覆盖自己的标题行，同样参与上面的连续性
   * （design §0 修订一）。前端据此把它渲染为不可点击的分组表头、并在导航与章节计数中跳过。
   */
  isVolume?: boolean;
}

/** `<id>_toc.json` 的整体形状（design §2.1）。 */
export interface BookToc {
  id: string;
  title: string;
  author: string;
  charCount: number;
  /** **仅正文章节**，不含卷节点（需求 12.4）。 */
  totalChapters: number;
  /** 切分时命中的具名规则名（需求 8.1），供审查与人工覆盖参考。 */
  tocRule: string;
  /**
   * 全书无规则可用、按段落/字数兜底切分（需求 8.9）。
   * 与 `isVolume` 同样采用"真时才输出"的写法，故为可选。
   */
  fallback?: boolean;
  chapters: ChapterMeta[];
}

/**
 * 阅读进度，localStorage 键 `koodo_novel_progress_<bookId>`（design §2.3）。
 *
 * 已废弃的 `scrollRatio`（像素比例，与 INV-1 冲突且从未被写入）由 `charOffset` 取代。
 * 磁盘上仍可能存在缺 `charOffset` / `v` 的 v1 记录，读取侧负责补齐（需求 2.8，任务 31）。
 */
export interface ReadingProgress {
  bookId: string;
  /** `chapters[]` 下标，必为正文章节而非卷节点（需求 12.5）。 */
  chapterId: number;
  chapterTitle: string;
  /** 章内字符偏移，相对 `chapter.start`（需求 2.1）。 */
  charOffset: number;
  /** 保存时算好 `(chapter.start + charOffset) / charCount`，使书架无需加载 toc（需求 2.7）。 */
  progressPercent: number;
  lastReadTime: number;
  /** 格式版本。缺失即 v1。 */
  v: 2;
}

/**
 * 书签（design §2.4）。**保持"每章至多一个书签"的现有语义**——顶栏按钮是个 toggle，
 * 一章多书签会让它的"已加 / 未加"状态失去意义。
 */
export interface Bookmark {
  id: string;
  bookId: string;
  chapterId: number;
  chapterTitle: string;
  /** 按下书签时的章内字符偏移，使跳转能回到当时那一段（需求 2.6）。 */
  charOffset: number;
  previewText: string;
  createdAt: number;
}

export type ReaderThemeKey = "default" | "sepia" | "eyecare" | "dark" | "black";

/**
 * 阅读器设置，localStorage 键 `koodo_novel_reader_settings`（`storage.ts`）。
 *
 * 除排版与主题外还带一个 `cacheMaxBooks`：需求 4.2 要求离线缓存的本数上限"可在设置中
 * 调整"，而设置抽屉手里已经有这个对象和它的持久化通路，另开一个 localStorage 键只会把
 * 读取/写入/默认值/旧值兼容再写一遍（详见 `utils/bookCache.ts` 的模块说明）。
 * 代价是本类型的语义从"排版设置"扩宽为"阅读器设置"。
 */
export interface ReaderSettings {
  theme: ReaderThemeKey;
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  fontFamily: "system" | "serif" | "kaiti";
  contentWidth: number; // in px, e.g. 800
  /**
   * IndexedDB 离线缓存的本数上限（需求 4.2，默认 10）。
   *
   * 数值不在此处校验——`getStoredSettings()` 只做浅合并，手改过的存储可能给出负数或字符串，
   * 故由用处的 `normalizeMaxBooks()` 收拢到 `[1, 50]`。设置 UI 由任务 50 负责。
   */
  cacheMaxBooks: number;
}
