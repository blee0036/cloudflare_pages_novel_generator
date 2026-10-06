/**
 * 定位原语（design §3，需求 2.1 / 12 / INV-1）。
 *
 * 三条上层功能——进度恢复（任务 35/36）、检索跳转（任务 40）、书签跳转（任务 41）——
 * 共用这一套算术。抽成模块而不是散在 `ReaderPage` 里，一是因为它们是**纯函数**
 * （不碰 DOM、不涉 React），能被直接测；二是因为这里全是差一位陷阱：算错了
 * `typecheck` 一无所知，症状是跳错段（design §11）。
 *
 * 模块分两块：**章内定位**（字符偏移 ↔ 段落 ↔ 滚动位置）与**章间定位**（卷节点的双视图
 * 与上下章导航，design §3.8）。后者同样是纯下标算术，同样只会错在差一位上，因此放在
 * 一起测。
 *
 * 唯一的寻址单位是「解压后 UTF-8 文本的字符偏移」（INV-1）。本模块只认两种偏移，
 * 且从不混用：
 *
 * - **章内偏移**（`Para.offset`、`JumpTarget.charOffset`）：相对 `chapter.start`；
 * - **全局偏移**（`chapter.start + charOffset`）：相对全文首字符，用于百分比与检索换算。
 *
 * 字节偏移与像素比例一概不进入这里（需求 2.1）。
 */

import type { ChapterMeta } from "../types";

/** 检索命中在某个正文段落里的落点（design §3.6）。下标与 `bodyParas` 对齐。 */
export interface ParaHighlight {
  /** `bodyParas` 的下标，即渲染出来的第几个 `<p>`。 */
  paraIndex: number;
  /** 命中起点在该段 `text` 里的下标：`charOffset - para.offset`（design §3.6）。 */
  offsetInPara: number;
  /** 要标的字符数，已夹到段尾——命中跨段时只标本段内那一截。 */
  length: number;
}

/** 段落：正文一行，外加它在**章内**的字符偏移。 */
export interface Para {
  /**
   * 章内字符偏移，指向该段**首个非空白字符**——也就是 `text[0]` 在章内的位置。
   * 因此 `chapterText.slice(offset, offset + text.length) === text` 恒成立，
   * 而 `chapter.start + offset` 是一个有效的全局偏移。
   */
  offset: number;
  /** 段落文本，已去掉首尾空白（含首行缩进的全角空格）。内部空白原样保留。 */
  text: string;
}

/**
 * 统一跳转入口的目标位置（design §3.5）。
 *
 * 进度恢复、检索结果、书签三个来源收敛到同一个形状，阅读器侧只需实现一条跳转路径：
 *
 * | 来源 | chapterId | charOffset | highlightLength |
 * | --- | --- | --- | --- |
 * | 进度恢复 | 记录里的 | 记录里的（v1 记录为 0） | — |
 * | 检索结果 | 由全局命中偏移二分得出 | `matchIndex - chapter.start` | 关键词长度 |
 * | 书签 | 记录里的 | 记录里的 | — |
 */
export interface JumpTarget {
  /** `toc.chapters[]` 下标。落到卷节点时改用其后第一个正文章节（需求 12.5）。 */
  chapterId: number;
  /** 章内字符偏移，相对 `chapter.start`。 */
  charOffset: number;
  /** 命中长度，仅检索跳转传入（需求 2.5）；缺省表示不高亮。 */
  highlightLength?: number;
}

/**
 * 按行切分章节文本，每段携带指向首个非空白字符的章内偏移（design §3.1）。
 *
 * **调用方必须传入未 `trim()` 的 `fullText.slice(chapter.start, chapter.end)`。**
 * 现有代码是 `.slice(start, end).trim()`，那个 `trim()` 会把所有段落偏移整体平移，
 * 使 `chapter.start + para.offset` 不再是有效的全局偏移——定位基准当场失效，
 * 而类型检查看不出任何问题。前导空行由"空段落不收录"自然跳过，不需要 trim。
 *
 * 只按 `\n` 切：`\r\n` 的 `\r` 落在行尾，被 `trim()` 一并去掉，偏移不受影响
 * （`pos` 按 `raw.length + 1` 递进，`raw` 里仍含那个 `\r`）。真·纯 `\r` 换行的
 * 古早文本不在支持范围内——预处理产物一律是 `\n` 或 `\r\n`。
 *
 * 空白行、纯全角空格行一律不收录：它们没有可渲染的内容，收录进来只会让段落下标
 * 与屏幕上看到的段落对不上，也让 `findParaIndex` 可能返回一个不可见的段落。
 */
export function splitParagraphs(chapterText: string): Para[] {
  const out: Para[] = [];
  let pos = 0;

  for (const raw of chapterText.split("\n")) {
    // 首行缩进（半角空格、全角 U+3000、制表符）都算前导空白，偏移要跳过它们，
    // 否则 `offset` 指向的是缩进而不是正文首字。
    const lead = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (text) out.push({ offset: pos + lead, text });
    pos += raw.length + 1; // +1 = 被 split 吃掉的那个 "\n"
  }

  return out;
}

/**
 * **本模块唯一的二分实现**：单调谓词的分界点。
 *
 * `pred` 必须在 `[0, length)` 上呈"前真后假"（真前缀 + 假后缀），返回第一个使它为假的
 * 下标；全真时返回 `length`，全假时返回 0。
 *
 * 所有边界查询（upper bound、lower bound、段落定位、正文章节定位）都用它表达，于是
 * "差一位"只可能错在这一处，而这一处被测试逐点与线性扫描对过（design §11）。
 */
function partitionPoint(length: number, pred: (index: number) => boolean): number {
  let lo = 0;
  let hi = length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pred(mid)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * 升序序列上的 upper bound：第一个**严格大于** `target` 的下标，
 * 等价于"值 `<= target` 的元素个数"。全都不大于时返回 `length`。
 */
function upperBoundBy(
  length: number,
  valueAt: (index: number) => number,
  target: number,
): number {
  return partitionPoint(length, (i) => valueAt(i) <= target);
}

/**
 * 升序序列上的 lower bound：第一个**大于或等于** `target` 的下标，
 * 等价于"值 `< target` 的元素个数"。全都更小时返回 `length`。
 *
 * 与 upper bound 只差比较符里的等号——正因为这个等号极易写反，两者才都由
 * `partitionPoint` 表达并各自被测试钉住。
 */
function lowerBoundBy(
  length: number,
  valueAt: (index: number) => number,
  target: number,
): number {
  return partitionPoint(length, (i) => valueAt(i) < target);
}

/**
 * 升序数组上的 upper bound（design §3.3 的滚动路径工具）。
 *
 * 返回第一个严格大于 `y` 的下标。滚动时用 `upperBound(tops, y) - 1` 取"顶端不低于
 * 视口线的最后一段"，即当前视口首个可见段落；`y` 小于所有元素时该式为 `-1`，
 * 调用方须夹到 0（design §3.3 的 `Math.max(0, i)`）。
 *
 * `values` 必须升序。段落的 `offsetTop` 天然升序，因此调用方无需排序。
 */
export function upperBound(values: readonly number[], y: number): number {
  return upperBoundBy(values.length, (i) => values[i], y);
}

/**
 * 求 `charOffset` 落在第几段：满足 `paras[i].offset <= charOffset` 的**最大** `i`
 * （design §3.4）。
 *
 * 边界行为（都是有意为之）：
 *
 * - `charOffset` 小于首段偏移（含负数、章首标题行之前的空白）→ 返回 0；
 * - `charOffset` 恰好等于某段偏移 → 返回**那一段**，不是下一段；
 * - `charOffset` 超出末段 → 返回末段；章尾之后没有"下一段"可落。
 *
 * `paras` 为空时返回 0，这是一个**不可用的下标**：调用方须先确认 `paras.length > 0`
 * （空章节的正确响应是不渲染正文，而不是跳到某一段）。这里不返回 -1，是为了让
 * `paras[findParaIndex(...)]` 在正常路径上永远不会拿到 `undefined`。
 */
export function findParaIndex(paras: readonly Para[], charOffset: number): number {
  return Math.max(0, upperBoundBy(paras.length, (i) => paras[i].offset, charOffset) - 1);
}

/**
 * 「这个全局偏移不属于任何章节」。`findChapterIndex` 的失败返回值。
 *
 * 连续覆盖（需求 8.14）成立时只有越界才会出现它；手改过的 `_toc.json` 也可能留出空隙。
 * 与 `NO_CONTENT_CHAPTER` 同值但不同含义：那个说的是"这本书没有正文章节"。
 */
export const NO_CHAPTER = -1;

/**
 * 全局字符偏移落在第几个章节节点（design §3.5 的检索侧章节定位）。
 *
 * 判定是 `start <= offset < end`——与检索抽屉原先那份就地写的二分同一口径，搬进来是为了
 * 让全模块只有一处二分（`partitionPoint`），且这一处被测试逐点与线性扫描对过。
 * 返回的是**数组下标**，与 `chapter.id` 相等（`validate.py` 的不变量 1：id 即下标），
 * 因此可以直接交给 `resolveContentChapter` / `goToChapter`。
 *
 * 要求 `chapters` 按 `start` 升序——产物的连续覆盖天然满足（需求 8.14）。
 * 找不到时返回 `NO_CHAPTER`：偏移越界，或章节表被手改出了空隙。
 *
 * **卷节点不在这里跳过**：它的 range 含自己的标题行，命中真落在卷标题上时这里会如实
 * 返回那个卷节点，由调用方过一遍 `resolveContentChapter` 改用其后第一个正文章节
 * （需求 12.5、design §3.5）。分层是有意的——"偏移在哪一节点"与"该跳到哪一章"是两件事。
 */
export function findChapterIndex(
  chapters: readonly Pick<ChapterMeta, "start" | "end">[],
  globalOffset: number,
): number {
  if (!Number.isFinite(globalOffset)) return NO_CHAPTER;

  // 最后一个 start <= offset 的节点，即唯一可能包含它的那个
  const index = upperBoundBy(chapters.length, (i) => chapters[i].start, globalOffset) - 1;
  if (index < 0) return NO_CHAPTER;
  return globalOffset < chapters[index].end ? index : NO_CHAPTER;
}

/**
 * 命中高亮的落点：把章内偏移 + 命中长度换算成「第几段 + 段内起点 + 段内长度」
 * （需求 2.5、design §3.6）。
 *
 * 入参是 **`bodyParas`**（已跳过与标题重复的首段），不是 `paras`——`paraIndex` 要能直接
 * 当渲染下标用。因此"命中落在标题行上"的情形在这里表现为 `charOffset` 小于首段偏移，
 * 返回 `null`：那一行根本没有渲染出来，无处可标（design §3.2 的首段跳过）。
 *
 * 其余返回 `null` 的情形：没有段落、长度非正、命中起点落在段间空白或空行里
 * （`findParaIndex` 会给出它**前面**那一段，段内起点因此越过段尾）。`null` 的语义统一是
 * "不高亮"——跳转本身仍然发生，读者落到该位置附近，只是没有 `<mark>`。这比标错一段好。
 *
 * 命中跨段时（关键词横跨一个换行）只标本段内那一截：长度夹到段尾。跨段高亮要拆成多个
 * `<mark>`，而检索关键词跨段落的情形本就罕见，不值得为它把渲染路径变复杂。
 */
export function resolveHighlight(
  bodyParas: readonly Para[],
  charOffset: number,
  length: number,
): ParaHighlight | null {
  if (!bodyParas.length) return null;
  if (!Number.isFinite(charOffset) || !Number.isFinite(length) || length < 1) return null;

  const offset = Math.trunc(charOffset);
  // 命中在首个正文段之前：被跳过的标题行、或章首空白
  if (offset < bodyParas[0].offset) return null;

  const paraIndex = findParaIndex(bodyParas, offset);
  const para = bodyParas[paraIndex];
  const offsetInPara = offset - para.offset;
  // 命中起点落在该段之后的空白里（空行、段间换行）→ 没有可标的字符
  if (offsetInPara >= para.text.length) return null;

  return {
    paraIndex,
    offsetInPara,
    length: Math.min(Math.trunc(length), para.text.length - offsetInPara),
  };
}

/**
 * 某个章内偏移处的预览文本：取**该偏移所在正文段落**的开头若干字（需求 2.6）。
 *
 * 书签列表用它（design §2.4 的 `previewText`）。取"所在段落"而不是全章首段，是因为书签
 * 记的是一个位置，列表里该显示读者按下时正在看的那几行；首段对读到第 200 段才加书签的人
 * 毫无信息量。
 *
 * 入参是 **`bodyParas`**（已跳过与标题重复的首段），于是预览永远不会是那行与
 * `chapterTitle` 重复的标题——书签记录里已经单独存着章节名。
 *
 * 从段首而不是从 `charOffset` 处截起：偏移是段内某处时（读者停在一段中间），从中间截出来
 * 的半句话读不通。段落粒度与 `findParaIndex` 的归一口径也一致——恢复位置落到的就是这一段。
 *
 * 边界：空段落集合（卷节点、空章）或非正的 `maxLength` → 空串；偏移落在首段之前（章首、
 * 被跳过的标题行）→ 首段，这正是"章首书签预览第一段"的期望行为；脏偏移按 0 处理。
 */
export function previewAt(
  bodyParas: readonly Para[],
  charOffset: number,
  maxLength: number,
): string {
  // `!(x >= 1)` 而不是 `x < 1`：NaN 要一并落到这里（NaN 的两个比较都是 false）
  if (!bodyParas.length || !(maxLength >= 1)) return "";

  const offset = Number.isFinite(charOffset) ? Math.trunc(charOffset) : 0;
  return bodyParas[findParaIndex(bodyParas, offset)].text.slice(0, Math.trunc(maxLength));
}

/**
 * 章节表的双视图（需求 12、design §3.8）。
 *
 * 卷节点（`isVolume`）的 range 只含自己的标题行，没有正文——目录里要看得见，导航与计数里
 * 必须当它不存在。两种需求靠两个视图并存来满足，而不是在业务代码里到处 `if (isVolume)`：
 * 那种写法每加一个消费者就多一处可漏的判断，症状是点"下一章"进了一页只有标题的空白。
 *
 * 卷节点在一本书里通常只有寥寥几个，但位置分散，且可能出现**相邻两个卷节点**——
 * "跳过一个就够了"的写法会在那里翻车，所以定位一律走二分而不是"看下一条"。
 */
export interface ChapterViews {
  /** 正文章节的**原始下标**（`toc.chapters[]` 的下标），升序、无重复。 */
  readonly contentIdx: readonly number[];
  /** 原始下标 → 它在 `contentIdx` 里的序号。卷节点不在表内。 */
  readonly contentPos: ReadonlyMap<number, number>;
}

/**
 * 「没有正文章节」的返回值：章节表为空，或全由卷节点构成的异常数据（需求 12.6）。
 *
 * 不返回 0 是有意的——0 在那种书里同样指向一个卷节点，交出去只会渲染出空白页。调用方
 * 见到它应当渲染错误提示，而不是继续往下走（`ReaderPage` 的 `contentIdx` 空分支）。
 */
export const NO_CONTENT_CHAPTER = -1;

/** 构造双视图（design §3.8）。产物省略 `isVolume` 字段时算正文，故判定用 `!chapter.isVolume`。 */
export function buildChapterViews(
  chapters: readonly Pick<ChapterMeta, "isVolume">[],
): ChapterViews {
  const contentIdx: number[] = [];
  const contentPos = new Map<number, number>();

  for (let raw = 0; raw < chapters.length; raw++) {
    if (chapters[raw].isVolume) continue;
    contentPos.set(raw, contentIdx.length);
    contentIdx.push(raw);
  }

  return { contentIdx, contentPos };
}

/**
 * 正文序号：`rawIndex` 对应的正文章节在 `contentIdx` 里的位置（需求 12.4 的值域、
 * 以及上下章按钮的禁用判定要用它）。
 *
 * `rawIndex` 是正文章节 → 它自己的序号；落在卷节点或越界 → 按 `resolveContentChapter`
 * 的同一套规则归一后的序号。没有正文章节时返回 `NO_CONTENT_CHAPTER`。
 */
export function contentPositionOf(views: ChapterViews, rawIndex: number): number {
  const { contentIdx, contentPos } = views;
  if (!contentIdx.length) return NO_CONTENT_CHAPTER;

  const exact = contentPos.get(rawIndex);
  if (exact !== undefined) return exact;

  // 第一个下标 >= rawIndex 的正文章节，即"其后第一个正文章节"（需求 12.5）。
  // rawIndex 本身是正文时上面已命中，所以这里的"其后"必然真在其后。
  const pos = lowerBoundBy(contentIdx.length, (i) => contentIdx[i], rawIndex);
  // 其后再没有正文章节（书尾挂着卷节点、或 rawIndex 越界）→ 退到最后一个正文章节。
  // 需求 12.5 只规定了"其后"，而这里没有"其后"可取；往前退一章总比渲染空白页好。
  return pos < contentIdx.length ? pos : contentIdx.length - 1;
}

/**
 * `contentPositionOf` 的反函数：正文序号 → 原始下标（需求 12.4 的滑杆 `onChange`）。
 *
 * 底部滑杆的值域是正文序号（`0 … contentIdx.length - 1`），而 `goToChapter` 收的是
 * 原始下标——两者在有卷节点的书里相差好几位（例如 12 个节点里有 3 个卷时，末章序号 8
 * 对应原始下标 11）。少了这一步换算，拖到滑杆最右端会落在原始下标 8 上，比末章早了
 * 整整 3 个节点；`typecheck` 对此一无所知。
 *
 * 越界的序号夹到两端，非整数（`Math.trunc`）与 `NaN`/`Infinity` 一律不放过：
 * 后者会让 `contentIdx[position]` 给出 `undefined`，`setCurrentChapterIndex(undefined)`
 * 的症状是整页空白而不是报错。没有正文章节、或入参不是有限数时返回
 * `NO_CONTENT_CHAPTER`，调用方原地返回即可（两种情形都无处可跳）。
 */
export function contentChapterAt(views: ChapterViews, position: number): number {
  const { contentIdx } = views;
  if (!contentIdx.length || !Number.isFinite(position)) return NO_CONTENT_CHAPTER;

  const clamped = Math.min(contentIdx.length - 1, Math.max(0, Math.trunc(position)));
  return contentIdx[clamped];
}

/**
 * 把任意跳转目标归一到正文章节（需求 12.5、design §10）：
 *
 * - 已是正文章节 → 原样返回；
 * - 落在卷节点 → **其后第一个**正文章节；
 * - 越界（章节表被重切过、`?ch=` 被手改、进度记录过期）→ 夹到两端的正文章节；
 * - 没有正文章节 → `NO_CONTENT_CHAPTER`，调用方改渲染错误页（需求 12.6）。
 *
 * 三条上层跳转——进度恢复、检索命中、书签——都必须过这里。检索侧尤其需要：命中偏移落在
 * 卷标题行上的概率虽低，但卷的 range 非空（含标题行），落进去就是一页空白（design §3.5）。
 *
 * 用"其后"而不是"最近"：读者点第 5 卷的第一章、或进度记录停在卷标题上，期望的都是往下
 * 读，不是被拽回上一卷的末章。
 */
export function resolveContentChapter(views: ChapterViews, rawIndex: number): number {
  const pos = contentPositionOf(views, rawIndex);
  return pos === NO_CONTENT_CHAPTER ? NO_CONTENT_CHAPTER : views.contentIdx[pos];
}

/**
 * 归一一条跳转指令（design §3.5 的统一入口，需求 12.5）：三个来源——进度恢复、检索命中、
 * 书签——交上来的 `JumpTarget` 都先过这里，阅读器只实现一条跳转路径。
 *
 * 做三件事：
 *
 * 1. 章号经 `resolveContentChapter` 归一（卷节点 → 其后第一个正文章节，越界 → 夹到两端）；
 * 2. **章号被改动时，偏移与高亮一并作废**——它们是原来那一章里的位置，带进新的一章会把读者
 *    扔到一个毫无关系的段落，还在那里标一段无关文字。这一条是整个函数存在的理由：
 *    `resolveContentChapter` 只管章号，光调它会静默留下一个错位的偏移；
 * 3. 脏值归一：偏移取整夹到非负，非正/非有限的 `highlightLength` 直接去掉（缺省即不高亮）。
 *
 * 没有正文章节时返回 `null`（需求 12.6 的错误页接手），调用方原地返回即可。
 */
export function resolveJumpTarget(views: ChapterViews, target: JumpTarget): JumpTarget | null {
  const chapterId = resolveContentChapter(views, target.chapterId);
  if (chapterId === NO_CONTENT_CHAPTER) return null;

  // 落到了另一章 → 偏移与高亮都是上一章的坐标，作废，从章首开始
  if (chapterId !== target.chapterId) return { chapterId, charOffset: 0 };

  const charOffset = Number.isFinite(target.charOffset)
    ? Math.max(0, Math.trunc(target.charOffset))
    : 0;
  const length = target.highlightLength;
  if (length === undefined || !Number.isFinite(length) || length < 1) {
    return { chapterId, charOffset };
  }
  return { chapterId, charOffset, highlightLength: Math.trunc(length) };
}

/**
 * 上一章 / 下一章：在 `contentIdx` 上 ±`delta`（需求 12.3、design §3.8）。
 *
 * 返回目标章的**原始下标**；已在首/末正文章节时返回当前章自身（夹住，不绕回）——调用方
 * 据此把按钮置灰即可，不需要另算边界。没有正文章节时返回 `NO_CONTENT_CHAPTER`。
 *
 * 跨越连续的卷节点只需一次调用：序号是在"已剔除卷节点"的数组上 ±1，卷节点有多少个、
 * 挤在一起还是分散，都与结果无关。
 *
 * `rawIndex` 落在卷节点上时（跳转都过 `resolveContentChapter`，正常不会发生）按"卷节点
 * 位于前后两个正文章节之间"处理：往后一步到它**后面**那章，往前一步到它**前面**那章。
 * 不这么修正的话，从卷节点往后一步会连着跳过两章。
 */
export function stepContentChapter(
  views: ChapterViews,
  rawIndex: number,
  delta: number,
): number {
  const { contentIdx, contentPos } = views;
  const pos = contentPositionOf(views, rawIndex);
  if (pos === NO_CONTENT_CHAPTER) return NO_CONTENT_CHAPTER;

  // 归一到了"其后"那一章，于是正向的第一步已经走完了，要扣掉。
  const onVolume = !contentPos.has(rawIndex);
  const from = onVolume && delta > 0 ? pos - 1 : pos;

  const target = Math.min(contentIdx.length - 1, Math.max(0, from + delta));
  return contentIdx[target];
}

/**
 * 阅读百分比（需求 2.7、design §3.7）：
 *
 * ```
 * progressPercent = (globalOffset / charCount) * 100
 * ```
 *
 * `globalOffset` 是**全局**字符偏移，即 `chapter.start + charOffset`；`charCount` 是
 * `toc.charCount`。这替代旧的 `(chapterIndex + 1) / totalChapters`——章长不均时后者严重
 * 失真：同一本书的章长可以相差几个数量级，按章号算出的"已读一半"可能实际只读了三成。
 *
 * 返回值夹在 0–100，且对脏输入一律退化为 0：
 *
 * - `charCount <= 0`（空书、坏 toc、NaN）→ 0。这里除零会产出 `Infinity` / `NaN`，而这个数
 *   要进 localStorage，并被书架直接当进度条宽度用（`width: ${p}%`），脏值的症状是空白条；
 * - 偏移越界（负数、超出全书）→ 夹到 0 / 100。
 *
 * 末段的偏移必然小于 `charCount`，所以读到最后一段显示的是 99.x% 而不是 100%。这是
 * "读到哪个位置"应有的语义——旧的章号比例在末章恒为 100%，反而看不出末章读到哪。
 */
export function progressPercentAt(globalOffset: number, charCount: number): number {
  if (!(charCount > 0)) return 0;
  const percent = (globalOffset / charCount) * 100;
  // NaN 不能靠 min/max 夹（两者遇 NaN 都返回 NaN），必须显式判。
  if (!Number.isFinite(percent)) return 0;
  return Math.min(100, Math.max(0, percent));
}

/**
 * 标题装饰符号的配对表，`scripts/lib/toc.py` 的 `TITLE_PAIRS` 镜像。
 *
 * **不含 `《》` 与 `〈〉`**：书名号与尖括号承载语义（`《青石巷》` 是书名），
 * 剥掉它们是改写标题而不是去装饰。
 */
const TITLE_PAIRS = new Map<string, string>([
  ["【", "】"],
  ["〖", "〗"],
  ["〔", "〕"],
  ["「", "」"],
  ["『", "』"],
  ["（", "）"],
  ["(", ")"],
  ["［", "］"],
  ["[", "]"],
]);

/** 闭 → 开，用于判"孤悬的行尾闭符号"。 */
const TITLE_CLOSERS = new Map<string, string>(
  [...TITLE_PAIRS].map(([open, close]) => [close, open]),
);

/**
 * `title[0]` 这个开符号是否**恰好闭合在** `title[title.length - 1]`。
 *
 * 按配对深度数，而不是"首字符是开符号、尾字符是它的闭符号"——后者会把
 * `（甲）乙（丙）` 剥成 `甲）乙（丙`。
 */
function encloses(title: string, open: string, close: string): boolean {
  if (title.length < 2 || title[title.length - 1] !== close) return false;

  let depth = 0;
  for (let i = 0; i < title.length; i++) {
    if (title[i] === open) depth += 1;
    else if (title[i] === close) {
      depth -= 1;
      if (depth === 0) return i === title.length - 1;
    }
  }
  return false;
}

/**
 * 标题净化：折叠内部空白 + 剥除成对装饰符号（design §3.2 / §4.6）。
 *
 * 这是 Python `clean_title` 的前端镜像，**不含**它那层 `第 N 节` 兜底
 * （Python 侧叫 `normalize_title`）：兜底标题在原文里没有对应文本，比对失败正是
 * 正确答案，所以整行都是装饰符号时这里返回空串。
 *
 * 存在的理由只有一个（需求 8.15、design §3.2 修订二）：章节 range 含自身标题行，
 * 于是 `paras[0]` 往往就是标题，渲染时要跳过它以免标题显示两次。判定必须是
 *
 * ```ts
 * normalizeTitle(paras[0].text) === chapter.title
 * ```
 *
 * 而不是拿行原文直接比——`chapter.title` 是净化过的文本，直接比会在"被净化改写过的
 * 标题"上假阴性。`clean_title` 幂等，所以「净化过的源行 === 已净化的标题」是精确等式。
 * 用 `===` 而非 `startsWith`，避免把正文首段误判成标题。
 *
 * 与 `scripts/lib/toc.py` 的 `clean_title` **必须一起改**：行为由
 * `scripts/tests/test_toc_title.py`（Python 侧）与 `locator.test.ts`（本侧）两边钉住。
 * 镜像不到位时的降级方向是安全的：不跳过首段，标题重复一次，不会丢内容。
 */
export function normalizeTitle(raw: string): string {
  // JS 的 `\s` 与 Python 的在冷门码位上略有出入（JS 多 U+FEFF，Python 多 C1 区几个），
  // 但两边都认空格 / 制表 / U+3000 / U+00A0，中文标题用不到那点差集。
  let title = raw.replace(/\s+/g, " ").trim();

  while (title) {
    const closer = TITLE_PAIRS.get(title[0]);
    if (closer !== undefined) {
      // 整行被这一对符号包住 → 两边一起剥
      if (encloses(title, title[0], closer)) {
        title = title.slice(1, -1).trim();
        continue;
      }
      // 配对的另一半整行都没出现 → 剥掉孤悬的开符号（很多书只写左半）
      if (!title.includes(closer)) {
        title = title.slice(1).trim();
        continue;
      }
    }

    const opener = TITLE_CLOSERS.get(title[title.length - 1]);
    if (opener !== undefined && !title.includes(opener)) {
      title = title.slice(0, -1).trim();
      continue;
    }

    break;
  }

  return title;
}

/**
 * 正文段落：`paras` 去掉"与章节标题重复的首段"（需求 8.15、design §3.2 修订二）。
 *
 * 章节 range 以自身标题行起始（需求 8.15），所以 `paras[0]` 通常就是标题行本身。
 * 阅读器又单独渲染 `<h1>{chapter.title}</h1>`，不跳过首段就是缺陷 E10：每章标题
 * 显示两次。
 *
 * 判定用 `===`（净化后严格相等）而不是 `startsWith`：后者会把"以标题开头的正文首段"
 * 误判成标题并整段吞掉——丢正文比标题重复严重得多。
 *
 * 跳过只在首段发生，且**不动 `paras` 里的偏移**：返回的是 `paras.slice(1)`，每段仍
 * 携带原本的章内偏移，`chapter.start + offset` 继续有效。这也是"跳过渲染"而非
 * "从 `chapterText` 裁掉标题行"的原因——裁掉会平移其后全部偏移（design §3.1）。
 *
 * 不跳过的情形（都是有意保留，降级方向是标题重复一次而非丢内容）：
 *
 * - 合成标题：`序章 / 前言`、兜底的 `原标题(N)`、净化空串后的 `第 N 节`——这些标题
 *   在原文里没有对应行，比对失败即是正确答案；
 * - 卷节点：正文本就只有标题行，跳过后 `bodyParas` 为空，调用方据此不渲染正文；
 * - 前端 `normalizeTitle` 与 Python `clean_title` 万一不同步时的假阴性。
 *
 * 首段被跳过时返回新数组，否则原样返回入参（引用不变，便于 `useMemo` 下游比较）。
 */
export function bodyParagraphs(
  paras: readonly Para[],
  chapterTitle: string | undefined,
): readonly Para[] {
  if (!paras.length || !chapterTitle) return paras;
  return normalizeTitle(paras[0].text) === chapterTitle ? paras.slice(1) : paras;
}

/**
 * 派生某本书正文 gz 的资源路径（需求 5.1）。
 *
 * `books.json` 不再写 `txtPath` / `tocPath`，两个 URL 一律由 `id` 派生，产物里省掉
 * 这两个可推导字段。派生规则只此一处，改布局时不必满仓库找字符串拼接。
 */
export function txtUrl(bookId: string): string {
  return `/books/${encodeURIComponent(bookId)}.txt.gz`;
}

/** 派生某本书 `_toc.json` 的资源路径（需求 5.1）。`tocCache` 取数即走这里。 */
export function tocUrl(bookId: string): string {
  return `/data/${encodeURIComponent(bookId)}_toc.json`;
}
