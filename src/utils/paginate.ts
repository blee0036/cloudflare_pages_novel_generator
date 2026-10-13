/**
 * 分页算术（design §2.2、§4）。
 *
 * 纯函数模块：行盒合并、按行分页、页面几何、测量换算（行界、页首偏移、段中拆分）、偏移找页、
 * 页片段、片段高亮、跨章步进、页表缓存。测量（读 DOM 矩形）在 `usePaginator` 里做，这里只接收测量结果，
 * 段中拆分的矩形读取也以回调传入，因此能被直接测。
 *
 * 页码只是运行时派生物（需求 2.8）：本模块产出的 `PageTable` 与 `PagePos` 只存在于内存，
 * 进度、书签与 URL 里只出现（章号, 章内字符偏移），页与偏移之间靠 `starts` 互换。
 *
 * 偏移一律是**章内偏移**（与 `Para.offset` 同一坐标，INV-1）；二分一律走 `locator.ts`
 * （`upperBound`、`findParaIndex`），全项目只有那一处二分实现（design §4.4）。
 */

import type { TurnDirection } from "../components/reader/types";
import {
  NO_CONTENT_CHAPTER,
  findParaIndex,
  resolveHighlight,
  stepContentChapter,
  upperBound,
  type ChapterViews,
  type Para,
} from "./locator";

/**
 * 测量容器坐标系中的一行（design §4.2）。
 *
 * `block = -1` 表示标题区（标题与"第 N / 共 M 章"整体视为一行，只出现在第 0 页），
 * `≥ 0` 为 `bodyParas` 下标。
 */
export interface LineBox {
  top: number;
  bottom: number;
  block: number;
}

/** 一章在某个排版参数下的分页结果（design §4.5 的缓存单元）。 */
export interface PageTable {
  chapterId: number;
  /** 排版参数指纹（design §2.2）。与当前值不同即整表作废。 */
  layoutKey: string;
  /** 各页的 Page_Start_Offset（章内偏移）。`starts[0] = 0`，严格递增。 */
  starts: number[];
}

/** 页内一段文字：`bodyParas[para]` 的 `[from, to)`，偏移是章内偏移。 */
export interface PageFragment {
  para: number;
  from: number;
  to: number;
  /** `from` 不是段首：不缩进（续段）。 */
  continued: boolean;
  /** `to` 不是段尾：末行两端对齐（`text-align-last: justify`）。 */
  continues: boolean;
}

/** 一页要渲染的内容（design §4.4）。 */
export interface PageView {
  /** 是否渲染标题区。只有第 0 页为真（需求 2.2）。 */
  header: boolean;
  fragments: PageFragment[];
}

/**
 * 某一页的位置：第几章的第几页（需求 3.1、3.2 的跨章步进结果）。
 *
 * `chapterId` 是 `toc.chapters[]` 的原始下标，`page` 是该章 `PageTable.starts` 的下标。
 * 只在内存中使用，不持久化（需求 2.8）。
 */
export interface PagePos {
  chapterId: number;
  page: number;
}

// ───────────────────────────── 行盒 ─────────────────────────────

/** 一个矩形的纵向范围。`getClientRects()` 给出的 `DOMRect` 天然满足。 */
export interface VerticalExtent {
  readonly top: number;
  readonly bottom: number;
}

/**
 * 两个纵向范围是否属于同一行：重叠部分超过较矮者高度的一半。
 *
 * 不用"有重叠即同行"：字形矩形是字体的内容区（ascent + descent），回退字体的内容区可能比
 * 1em 高出不少，紧排时相邻两行的字形矩形会擦边重叠，"有重叠即合并"会把整段并成一行。
 * 同一行上的多个矩形共用基线，重叠几乎是较矮者的全部高度；相邻行的擦边重叠远不到一半。
 */
function sameLine(a: VerticalExtent, b: VerticalExtent): boolean {
  const overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return overlap > 0.5 * Math.min(a.bottom - a.top, b.bottom - b.top);
}

/**
 * 把一个文本节点 `range.getClientRects()` 的结果合并成行（design §4.2 第 2 步）。
 *
 * 同一行可能返回多个矩形（字体回退、双向文本），按纵向重叠合并：并集的 `top` 取最小、
 * `bottom` 取最大。返回的行按 `top` 升序、互不重叠，每行都标上 `block`（段落在
 * `bodyParas` 里的下标；标题区为 -1，见 `LineBox`）。
 *
 * 这里给出的是**字形矩形**的范围，比行盒矮半个行距；行界换算（相邻两行字形矩形的中点、
 * 首行上沿取段落顶边、末行下沿取段落底边）是 design §4.2 第 3 步，由调用方完成。
 *
 * 高度非正或坐标非有限的矩形（折叠空白、未布局的节点）不携带任何纵向信息，直接丢弃。
 * 入参不必有序，内部按 `top` 排序后扫一遍。
 */
export function mergeLineRects(rects: ArrayLike<VerticalExtent>, block: number): LineBox[] {
  const spans: VerticalExtent[] = [];
  for (let i = 0; i < rects.length; i++) {
    const { top, bottom } = rects[i];
    if (Number.isFinite(top) && Number.isFinite(bottom) && bottom > top) {
      spans.push({ top, bottom });
    }
  }
  spans.sort((a, b) => a.top - b.top || a.bottom - b.bottom);

  const lines: LineBox[] = [];
  for (const span of spans) {
    // 已按 top 升序，新矩形只可能与最后一行同行
    const line = lines[lines.length - 1];
    if (line && sameLine(line, span)) {
      line.top = Math.min(line.top, span.top);
      line.bottom = Math.max(line.bottom, span.bottom);
    } else {
      lines.push({ top: span.top, bottom: span.bottom, block });
    }
  }
  return lines;
}

// ───────────────────────────── 按行分页 ─────────────────────────────

/**
 * 判定"一行能否放进本页"时的容差（px）。
 *
 * 测量值带小数（行高 = 字号 × 行高倍数），子像素舍入可能让恰好放满的一页算出
 * `H + 0.3` 之类的跨度，没有容差就会把本该在页底的那一行挤到下一页。
 */
export const PAGE_FIT_EPS = 0.5;

/**
 * 按行贪心分页（design §4.3）：返回每页首行在 `lines` 中的下标。
 *
 * 规则：`pageTop = lines[0].top`，逐行检查；某行满足 `line.bottom − pageTop > H + EPS`
 * 且不是本页首行时，从这一行起开新页，`pageTop = line.top`。由此：
 *
 * - 结果以 0 开头、严格递增，每行恰好属于一页，页内只有整行（需求 2.3）；
 * - 除只含一行的页外，每页跨度不超过 `H + EPS`；
 * - 贪心极大：任一页的首行并入上一页都会超高；
 * - 单行超过页高时独占一页（只在视口极矮时出现），每页至少前进一行，不会死循环。
 *
 * `lines` 须按 `top` 升序、互不重叠（`mergeLineRects` 的产物天然满足）。标题区作为一行
 * 排在最前，于是它必然落在第 0 页（需求 2.2）。`lines` 为空时返回空数组。
 *
 * `pageHeight` 须为正的有限数；视口高为 0 时调用方不应分页（保留上一份页表）。
 */
export function paginateLines(lines: readonly LineBox[], pageHeight: number): number[] {
  if (!lines.length) return [];

  const firsts = [0];
  let pageTop = lines[0].top;
  for (let i = 1; i < lines.length; i++) {
    // i 进入循环时一定不是本页首行（本页首行是上一次 push 的下标，已被跳过）
    if (lines[i].bottom - pageTop > pageHeight + PAGE_FIT_EPS) {
      firsts.push(i);
      pageTop = lines[i].top;
    }
  }
  return firsts;
}

// ───────────────────────────── 页面几何 ─────────────────────────────

/**
 * 页面内容盒的上、下内边距（px，design §4.1）。
 *
 * 页面图层（`PageSurface`）铺满 `<main>`，内容盒在这两段内边距之内，页高 `H` 即内容盒的高度。
 * 行界换算（design §4.2 第 3 步）带来的少量偏差落在这两段内边距里，不会被裁掉。
 */
export const PAGE_PAD_TOP = 32;
export const PAGE_PAD_BOTTOM = 32;

/**
 * 视口尺寸 → 页高 `H`（design §4.1、§4.2）。视口即 `PageSurface` 铺满的那个矩形（`<main>` 的
 * `clientWidth` / `clientHeight`）。
 *
 * - 宽或高不是正数（`<main>` 被隐藏、尚未布局，或 `NaN`）→ `null`：此时不分页，调用方保留上一份页表；
 * - 否则 `H = 高 − PAGE_PAD_TOP − PAGE_PAD_BOTTOM`，下限为 1。视口比上下内边距之和还矮时，
 *   每行都超过页高而独占一页（`paginateLines` 的单行超高规则），版面难看，但仍能逐页翻完。
 */
export function pageHeightFor(width: number, height: number): number | null {
  if (!(width > 0) || !(height > 0)) return null;
  return Math.max(1, height - PAGE_PAD_TOP - PAGE_PAD_BOTTOM);
}

// ───────────────────────────── 测量换算 ─────────────────────────────

/**
 * 一段的字形矩形 → 行盒（design §4.2 第 2、3 步）。
 *
 * `rects` 是该段文本节点 `range.getClientRects()` 的结果，`para` 是段落元素自身的纵向范围，
 * 两者须在同一坐标系里。先经 `mergeLineRects` 合并成字形行，再换算行界：
 *
 * - 字形矩形比行盒矮半个行距（上下各差半个 half-leading），所以相邻两行字形矩形之间空隙的
 *   中点就是两行的行界；
 * - 首行上沿取段落顶边、末行下沿取段落底边（段落没有内边距，两者就是首末行盒的外沿）。
 *
 * 结果首尾相接地铺满 `[para.top, para.bottom]`，按 `top` 升序、互不重叠，可以直接交给
 * `paginateLines`；段中拆分（第 7 步）也按这里的行界判定一个字属于哪一行。相邻字形行有重叠时
 * （回退字体的内容区偏高），中点仍落在两行之间；行界另外夹在 `[上一条行界, para.bottom]` 内，
 * 保证单调。
 *
 * 一个字形矩形都取不到（文本节点未布局等）时，整段当作一行。
 */
export function paragraphLines(
  rects: ArrayLike<VerticalExtent>,
  para: VerticalExtent,
  block: number,
): LineBox[] {
  const glyphs = mergeLineRects(rects, block);
  if (!glyphs.length) return [{ top: para.top, bottom: para.bottom, block }];

  const lines: LineBox[] = [];
  let top = para.top;
  for (let k = 0; k < glyphs.length; k++) {
    const mid = k + 1 < glyphs.length ? (glyphs[k].bottom + glyphs[k + 1].top) / 2 : para.bottom;
    const bottom = Math.min(para.bottom, Math.max(top, mid));
    lines.push({ top, bottom, block });
    top = bottom;
  }
  return lines;
}

/**
 * 每页首行 → 页首偏移（design §4.2 第 5 步），即 `PageTable.starts`。
 *
 * `lines` 是整章的行盒（标题区一行在最前，其后是各段的行），`firsts` 是
 * `paginateLines(lines, H)` 的结果，`paras` 是测量时渲染的那份 `bodyParas`（`LineBox.block`
 * 是它的下标）：
 *
 * - 第 0 页恒为 0（标题区在第 0 页，需求 2.2）；
 * - 首行是某段的第一行 → 该段的 `offset`；
 * - 首行在段中 → `splitAt(行下标)`，由调用方按字二分（第 7 步，见 `firstCharBelow`），返回章内偏移。
 *
 * 结果严格递增：不大于上一页页首的值直接丢弃，两页并作一页。这只在测量退化时出现（例如标题区
 * 独占一页、而首段恰好从偏移 0 起），宁可那一页底部被裁，也不产出非法的页表。
 */
export function pageStartOffsets(
  lines: readonly LineBox[],
  firsts: readonly number[],
  paras: readonly Para[],
  splitAt: (line: number) => number,
): number[] {
  const starts = [0];
  for (let p = 1; p < firsts.length; p++) {
    const f = firsts[p];
    const line = lines[f];
    const para = line ? paras[line.block] : undefined;
    // 标题区只会是第 0 页的首行；block 与 paras 对不上属于测量错配，跳过这条页界
    if (!line || !para) continue;
    const paraStart = f === 0 || lines[f - 1].block !== line.block;
    const offset = paraStart ? para.offset : splitAt(f);
    if (offset > starts[starts.length - 1]) starts.push(offset);
  }
  return starts;
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** `i` 落在代理对的低位上时退到高位，得到码点起点。 */
function codePointStart(text: string, i: number): number {
  return i > 0 && isLowSurrogate(text.charCodeAt(i)) && isHighSurrogate(text.charCodeAt(i - 1)) ? i - 1 : i;
}

/** 从码点起点 `i` 开始的那个码点的结束下标（代理对占两个码元）。 */
function codePointEnd(text: string, i: number): number {
  return i + 1 < text.length && isHighSurrogate(text.charCodeAt(i)) && isLowSurrogate(text.charCodeAt(i + 1))
    ? i + 2
    : i + 1;
}

/**
 * 段中拆分（design §4.2 第 7 步）：`text` 中第一个落在 `boundary` 之下的字的下标。
 *
 * `midY(start, end)` 返回 `text[start, end)` 这一个字的纵向中点（与 `boundary` 同一坐标系），
 * 字没有可用的矩形（被折叠的空白等）时返回 `null`。中点 `≥ boundary` 即该字落在目标行或其后；
 * 字序与行序一致，这是一个单调谓词，二分即可，每个页界约 log₂(段长) 次矩形读取。
 *
 * - 只在码点起点上探测：二分中点落在低位代理项上时退一位，`[start, end)` 覆盖整个代理对，
 *   返回值也必是码点起点，代理对不会被页界拆开；
 * - 不可测的字跟随其后第一个可测的字归行；到 `hi`（已知落在 `boundary` 之下的位置，或段尾）
 *   为止都不可测时，按落在 `boundary` 之下处理。被折叠的空白在行首行尾都不占位，归哪一页
 *   版面都不变；
 * - 全部字都在 `boundary` 之上 → `text.length`；空串 → 0。
 */
export function firstCharBelow(
  text: string,
  boundary: number,
  midY: (start: number, end: number) => number | null,
): number {
  // 不变量：lo 是码点起点，[0, lo) 都在 boundary 之上；hi 是码点起点或 text.length，[hi, …) 都在其下
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    // lo 是码点起点，所以退位后仍有 lo ≤ mid < hi
    const mid = codePointStart(text, (lo + hi) >>> 1);
    let probe = mid;
    let y: number | null = null;
    while (probe < hi) {
      const end = codePointEnd(text, probe);
      y = midY(probe, end);
      if (y !== null) break;
      probe = end;
    }
    if (y === null || y >= boundary) hi = mid;
    else lo = codePointEnd(text, probe);
  }
  return lo;
}

// ───────────────────────────── 偏移 ↔ 页 ─────────────────────────────

/**
 * 偏移所在页：满足 `starts[p] ≤ offset` 的最大 `p`（design §4.4，需求 12.1、12.4）。
 *
 * - 偏移恰为某页页首 → 那一页（不是上一页）；偏移 0 → 第 0 页（需求 12.1 的"第 1 页"）；
 * - `offset < 0`（以及 `NaN`）→ 第 0 页；超出末页页首 → 末页；
 * - `starts` 为空 → 0。这是个不可用的下标，正常路径上 `starts[0] = 0` 恒成立，不会出现。
 *
 * `starts` 须严格递增。复用 `locator.ts` 的 `upperBound`：`upperBound − 1` 即"最后一个
 * 不大于 offset 的下标"，它不会超过 `length − 1`，只需夹住下界。
 */
export function pageIndexOf(starts: readonly number[], offset: number): number {
  return Math.max(0, upperBound(starts, offset) - 1);
}

/**
 * 第 `k` 页要渲染的内容（design §4.4，需求 2.2、2.4）。
 *
 * 页的章内区间是 `[starts[k], starts[k + 1] ?? +∞)`，与每段 `[offset, offset + text.length)`
 * 求交，非空的交集即一个片段。因此：
 *
 * - 各页片段按页序拼接恰好是全部正文，无重叠、无缺口（需求 2.4）；
 * - 页界落在段中时，该段被拆成前一页的 `continues` 片段与后一页的 `continued` 片段；
 * - 页界落在段间空白里也照样成立——空白不属于任何段，交集为空即被跳过。
 *
 * `paras` 是 **`bodyParas`**（已跳过与标题重复的首段），`fragment.para` 因此可以直接当渲染
 * 下标用；标题区不在 `paras` 里，只由 `header` 决定，且只有第 0 页为真（需求 2.2）。
 *
 * 起点用 `findParaIndex` 二分定位，每页只扫本页涉及的那几段，不随章长线性增长。
 * `k` 越界（含非整数）时返回空页：`header = false`，无片段。
 */
export function pageView(paras: readonly Para[], starts: readonly number[], k: number): PageView {
  if (!Number.isInteger(k) || k < 0 || k >= starts.length) return { header: false, fragments: [] };

  const lo = starts[k];
  const hi = k + 1 < starts.length ? starts[k + 1] : Infinity;
  const fragments: PageFragment[] = [];

  // 第一个可能与 [lo, hi) 相交的段：offset ≤ lo 的最后一段（lo 在首段之前时为 0）
  for (let i = findParaIndex(paras, lo); i < paras.length && paras[i].offset < hi; i++) {
    const { offset, text } = paras[i];
    const end = offset + text.length;
    const from = Math.max(offset, lo);
    const to = Math.min(end, hi);
    // lo 落在该段之后的段间空白里：这一段整段属于上一页
    if (from >= to) continue;
    fragments.push({ para: i, from, to, continued: from > offset, continues: to < end });
  }

  return { header: k === 0, fragments };
}

/**
 * 片段内的检索高亮（design §4.4，需求 12.3）。返回值是**章内偏移**的 `[from, to)`，
 * 与 `PageFragment` 同一坐标；渲染时减去 `fragment.from` 即片段文本内的下标。
 *
 * 语义与 `resolveHighlight` 完全相同，只多一步与片段求交：
 *
 * - 只标**命中起点所在段**；命中跨段时只标该段内那一截（`resolveHighlight` 已夹到段尾）；
 * - 该段被页界拆开时，高亮可以跨页——前一页的片段标前半截，后一页的片段标后半截，
 *   各片段结果的并集恰好是 `resolveHighlight` 的区间；
 * - `resolveHighlight` 为 `null`（命中落在标题行、段间空白，长度非正等）→ 任何片段都不高亮。
 *
 * `paras` 必须与生成 `fragment` 的那份 `bodyParas` 相同，`fragment.para` 才对得上
 * `ParaHighlight.paraIndex`。
 */
export function fragmentHighlight(
  paras: readonly Para[],
  fragment: PageFragment,
  hit: { charOffset: number; length: number },
): { from: number; to: number } | null {
  const target = resolveHighlight(paras, hit.charOffset, hit.length);
  if (!target || target.paraIndex !== fragment.para) return null;

  const start = paras[target.paraIndex].offset + target.offsetInPara;
  const from = Math.max(start, fragment.from);
  const to = Math.min(start + target.length, fragment.to);
  return from < to ? { from, to } : null;
}

// ───────────────────────────── 跨章步进 ─────────────────────────────

/**
 * 页数是否可用：一张真实的页表 `starts[0] = 0`，至少一页。
 * `undefined`（未分页）与非正、非有限的脏值一律当作"还不知道"。
 */
function knownCount(count: number | undefined): count is number {
  return count !== undefined && count >= 1 && Number.isFinite(count);
}

/**
 * 相邻页（design §4.6，需求 2.7、3.1、3.2、3.3、3.5、3.6）。
 *
 * - 章内 ±1；
 * - 跨到下一章落在第 0 页，跨到上一章落在末页 `count − 1`（需求 3.1、3.2）；
 * - 相邻章由 `stepContentChapter` 求，卷节点因此天然被跳过，连续多个卷节点也只算一步（需求 3.3）；
 * - 已在全书首章第 0 页往前、或末章末页往后 → `null`，调用方显示边界提示（需求 3.5、3.6）；
 * - 需要的页数还不知道（相邻章未分页；往后翻时当前章也要先知道页数）→ `"pending"`，
 *   调用方当场同步分页后重试（design §4.5 的兜底）。
 *
 * "已到边界"用方向判定，而不是"结果等于当前章"：`stepContentChapter` 在首末章会夹住返回
 * 自身，而 `contentIdx` 升序，真正的下一章原始下标必然更大、上一章必然更小。这样即使
 * `pos.chapterId` 落在卷节点上（正常路径不会发生），也不会把"往后"走成往回退。
 *
 * 往返恒等（Property 7）：`q = stepPage(pos, "next")` 非 null 时 `stepPage(q, "prev") = pos`，
 * 前提是 `pos.page` 是该章的合法页下标。
 */
export function stepPage(
  pos: PagePos,
  direction: TurnDirection,
  views: ChapterViews,
  pageCount: (chapterId: number) => number | undefined,
): PagePos | "pending" | null {
  const { chapterId, page } = pos;

  if (direction === "next") {
    const count = pageCount(chapterId);
    if (!knownCount(count)) return "pending";
    if (page + 1 < count) return { chapterId, page: page + 1 };
  } else if (page > 0) {
    // 往前翻的章内一步不需要知道本章页数
    return { chapterId, page: page - 1 };
  }

  const delta = direction === "next" ? 1 : -1;
  const target = stepContentChapter(views, chapterId, delta);
  if (target === NO_CONTENT_CHAPTER) return null;
  // 夹住返回了自身（或更远的退化情形）：这个方向上已经没有正文章节
  if (direction === "next" ? target <= chapterId : target >= chapterId) return null;

  const count = pageCount(target);
  if (!knownCount(count)) return "pending";
  return { chapterId: target, page: direction === "next" ? 0 : count - 1 };
}

// ───────────────────────────── 页表缓存（design §2.2、§4.5） ─────────────────────────────

/** 决定分页结果的全部输入（design §2.2，需求 2.5 的排版输入）。 */
export interface LayoutInputs {
  /** Reader_Viewport 宽高：`<main>` 的 `clientWidth` / `clientHeight`。全屏切换表现为它的变化。 */
  width: number;
  height: number;
  contentWidth: number;
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  fontFamily: string;
  /** 字体纪元：每次 Web 字体加载完成加 1。 */
  fontEpoch: number;
}

/**
 * 排版参数指纹 `layoutKey`（design §2.2）：任何一项变化都得到不同的串，页表随之整体作废。
 *
 * `fontFamily` 放在最后：前面全是数字（不含分隔符），即使字体名里出现 `|` 也不会与别的组合撞串。
 */
export function layoutKeyOf(inputs: LayoutInputs): string {
  const { width, height, contentWidth, fontSize, lineHeight, letterSpacing, fontEpoch, fontFamily } = inputs;
  return [width, height, contentWidth, fontSize, lineHeight, letterSpacing, fontEpoch, fontFamily].join("|");
}

/** 页表缓存的容量：当前 `layoutKey` 下最近 5 章（design §4.5）。 */
export const PAGE_TABLE_CACHE_LIMIT = 5;

/** 一个 `layoutKey` 下的页表缓存。不可变：每次写入产出新对象，可直接放进 React state。 */
export interface PageTableCache {
  readonly layoutKey: string;
  /** 章号 → 页表，按写入先后排列（最早写入的在前）。 */
  readonly tables: ReadonlyMap<number, PageTable>;
}

/** 某章在 `layoutKey` 下的页表。缓存属于别的 `layoutKey`（已整体作废）或没有这一章时为 `undefined`。 */
export function cachedPageTable(
  cache: PageTableCache | null,
  layoutKey: string,
  chapterId: number,
): PageTable | undefined {
  if (!cache || cache.layoutKey !== layoutKey) return undefined;
  return cache.tables.get(chapterId);
}

/**
 * 写入一张页表，返回新缓存（入参不变，design §4.5）。
 *
 * - `table.layoutKey` 与缓存不同：旧缓存整体作废，新缓存只含这一张。
 * - 同章已有页表：替换，并算作最新写入。
 * - 超出 `limit`：从最早写入的开始淘汰，先跳过 `keep` 里的章（当前章与相邻两章，正在用或马上要用）；
 *   只淘汰 `keep` 之外的仍不够时再淘汰 `keep` 里最早的。新写入的这一张永不淘汰，结果恒不超过 `limit`。
 *
 * 只按写入先后而不按读取先后排序：读发生在渲染里，不该改动缓存。`keep` 保证了往回翻时
 * 当前章不会因"写得早"被挤掉。
 */
export function cachePageTable(
  cache: PageTableCache | null,
  table: PageTable,
  keep: readonly number[],
  limit: number = PAGE_TABLE_CACHE_LIMIT,
): PageTableCache {
  const tables = new Map<number, PageTable>();
  if (cache && cache.layoutKey === table.layoutKey) {
    for (const [id, t] of cache.tables) if (id !== table.chapterId) tables.set(id, t);
  }
  tables.set(table.chapterId, table);

  const cap = Math.max(1, Math.floor(limit));
  const evict = (protect: (id: number) => boolean): void => {
    for (const id of Array.from(tables.keys())) {
      if (tables.size <= cap) return;
      if (id === table.chapterId || protect(id)) continue;
      tables.delete(id);
    }
  };
  evict((id) => keep.includes(id));
  evict(() => false);

  return { layoutKey: table.layoutKey, tables };
}

/**
 * 相邻章后台分页的顺序：下一个正文章节，再上一个正文章节（design §4.5）。
 *
 * 相邻章由 `stepContentChapter` 求，卷节点天然被跳过（需求 3.3、3.4）；全书首末章那一侧没有
 * 相邻章，略过不列（判定与 `stepPage` 相同：按方向比较原始下标，不看"是否等于自身"）。
 */
export function neighborChapters(views: ChapterViews, chapterId: number): number[] {
  const out: number[] = [];
  const next = stepContentChapter(views, chapterId, 1);
  if (next !== NO_CONTENT_CHAPTER && next > chapterId) out.push(next);
  const prev = stepContentChapter(views, chapterId, -1);
  if (prev !== NO_CONTENT_CHAPTER && prev < chapterId) out.push(prev);
  return out;
}

/**
 * 离屏测量盒此刻该挂哪一章（design §4.5）：渲染驱动的目标（当前章在当前 `layoutKey` 下还没有页表时
 * 就是它）优先，没有时才是兜底 / 后台分页经 `mount` 强制挂上的那一章。
 *
 * 当前章的测量写在宿主的 layout effect 里，只在"待测的当前章"或 `layoutKey` 变化时运行，并假定那次
 * 提交里盒子挂着的正是当前章。强制挂载是盒子自己的 state，若它能盖过渲染驱动的目标，这一假定就会
 * 落空：相邻章在空闲回调里测完、撤下强制挂载的更新还没处理时改字号，同步优先级的那次渲染跳过低优先级
 * 的撤下，盒子提交的仍是相邻章，宿主的测量因此跳过；之后撤下生效、盒子换回当前章，宿主的 effect 却
 * 不会再运行，当前章就一直停在上一份页表（需求 2.5）。让渲染驱动的目标优先，假定恒成立。
 */
export function measureBoxTarget<T>(renderTarget: T | null, forced: T | null): T | null {
  return renderTarget ?? forced;
}

// ───────────────────────────── 分页视图的阅读位置 ─────────────────────────────

/** `pagedPositionStep` 的输入事件（design §3.3）。 */
export type PagedPosEvent =
  /** 导航指令落地（目录、滑杆、`?ch=`、检索、书签、切模式、首次定位）。 */
  | { kind: "nav"; chapterId: number; charOffset: number }
  /** 当前章的新页表（重分页，或导航后当前章的页表就绪）。 */
  | { kind: "relayout"; table: PageTable }
  /** 一次翻页或 `Home`/`End` 完成，落在 `to`；`starts` 是 `to` 所在章的页首表。 */
  | { kind: "turned"; to: PagePos; starts: readonly number[] };

/** 分页视图的位置状态：阅读位置（章 + 偏移）与当前显示的页。 */
export interface PagedPosState {
  chapterId: number;
  /** 阅读位置（章内偏移）。只有 `turned` 会改它。 */
  charOffset: number;
  /** 显示的页（`PageTable.starts` 的下标）。 */
  page: number;
}

/**
 * 分页视图的位置归约器（design §3.3，需求 1.6、1.7、2.5、2.7）。
 *
 * 核心规则：**程序化定位不改变阅读位置**，只有读者自己翻页才算移动。
 *
 * - `nav`：阅读位置换成指令里的 (章, 偏移)，原样保留——偏移可以落在某页中间（检索命中、
 *   切模式带来的滚动位置），不吸附到页首。此刻还没有该章的页表，`page` 暂记 0；
 *   调用方在页表就绪（缓存命中或测量完成）后再发一次 `relayout`。
 * - `relayout`：只重算显示页 `pageIndexOf(starts, charOffset)`，偏移不动（需求 2.5）。
 *   于是"切走再切回""改字号再改回"之后位置仍是原来的偏移（需求 1.7）。
 *   页表不属于当前章时（导航后旧章的测量结果才回来）忽略，以免按别章的页界选页。
 * - `turned`：阅读位置更新为新页的页首偏移（需求 2.7），`report = true`。
 *
 * 返回的 `report` 只在 `turned` 时为真；调用方据此调用 `onPosition`（design §3.2）。
 * 不改动的事件原样返回入参 `state`，调用方可用引用相等跳过渲染。
 */
export function pagedPositionStep(
  state: PagedPosState,
  event: PagedPosEvent,
): { state: PagedPosState; report: boolean } {
  switch (event.kind) {
    case "nav":
      return {
        state: { chapterId: event.chapterId, charOffset: event.charOffset, page: 0 },
        report: false,
      };

    case "relayout": {
      const { table } = event;
      if (table.chapterId !== state.chapterId) return { state, report: false };
      const page = pageIndexOf(table.starts, state.charOffset);
      return { state: page === state.page ? state : { ...state, page }, report: false };
    }

    case "turned": {
      const { to, starts } = event;
      // 正常路径上 `to.page` 必是 `starts` 的合法下标；夹一下只为不让 `undefined`
      // 作为偏移流进进度存储
      const page = starts.length ? Math.min(Math.max(0, to.page), starts.length - 1) : 0;
      const charOffset = starts.length ? starts[page] : 0;
      return { state: { chapterId: to.chapterId, charOffset, page }, report: true };
    }
  }
}
