import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { bodyParagraphs, buildChapterViews, resolveHighlight, splitParagraphs, type Para } from "./locator";
import {
  PAGE_FIT_EPS,
  PAGE_PAD_BOTTOM,
  PAGE_PAD_TOP,
  PAGE_TABLE_CACHE_LIMIT,
  cachePageTable,
  cachedPageTable,
  firstCharBelow,
  fragmentHighlight,
  layoutKeyOf,
  measureBoxTarget,
  neighborChapters,
  pageHeightFor,
  pageIndexOf,
  pageStartOffsets,
  pageView,
  pagedPositionStep,
  paginateLines,
  paragraphLines,
  stepPage,
  type LayoutInputs,
  type LineBox,
  type PageFragment,
  type PagePos,
  type PagedPosEvent,
  type PagedPosState,
  type PageTable,
  type PageTableCache,
} from "./paginate";

/*
 * 分页纯函数的测试（design §4、§12 Property 3–7、27）。
 *
 * 结构：先是各 describe 共用的生成器与辅助函数，随后每个被测函数一个 describe。
 */

// ───────────────────────────── 共享生成器 ─────────────────────────────

/** 有限 double 的简写：不含 NaN 与 ±Infinity。 */
function finite(min: number, max: number): fc.Arbitrary<number> {
  return fc.double({ min, max, noNaN: true, noDefaultInfinity: true });
}

/** 一行在章节排版中的参数：与上一行之间的空隙、本行高度。 */
interface LineSpec {
  gap: number;
  height: number;
}

/** 一章的测量结果骨架：标题区的位置与高度，各段的段前间距与各行。 */
interface ChapterSpec {
  /** 标题区 `offsetTop`（测量容器的上内边距等）。 */
  origin: number;
  headerHeight: number;
  paras: { gap: number; lines: LineSpec[] }[];
  /** 正文的典型行高，用来构造"页高恰好是整数行"的边界。 */
  lineHeight: number;
}

/**
 * 按 `ChapterSpec` 累加出行盒序列：标题区一行（`block = -1`）在最前，其后各段的行
 * （`block` 为段下标）。高度恒为正、空隙非负，所以结果按 `top` 升序且互不重叠，
 * 相邻行可以恰好相接（design §4.2 第 3 步换算出的行盒就是首尾相接的）。
 */
function buildLines(spec: ChapterSpec): LineBox[] {
  let cursor = spec.origin;
  const lines: LineBox[] = [{ top: cursor, bottom: cursor + spec.headerHeight, block: -1 }];
  cursor += spec.headerHeight;
  spec.paras.forEach((para, block) => {
    cursor += para.gap;
    para.lines.forEach((line, i) => {
      // 段首行与上一段之间只隔段前间距，行间空隙从第二行算起
      if (i > 0) cursor += line.gap;
      lines.push({ top: cursor, bottom: cursor + line.height, block });
      cursor += line.height;
    });
  });
  return lines;
}

/** 段落间距：多数为 0（行盒相接）或 `space-y-6` 一类的固定值，也含任意小数。 */
const gapArb: fc.Arbitrary<number> = fc.oneof(
  fc.constant(0),
  fc.constantFrom(16, 24, 32),
  finite(0, 48),
);

/**
 * 规整的章：正文所有行同高（字号 × 行高倍数，带小数），行盒首尾相接，段间统一间距。
 * 这是浏览器排版的常见形态，页高取整数行附近时最容易踩到容差边界。
 */
const regularChapterArb: fc.Arbitrary<ChapterSpec> = fc
  .record({
    origin: fc.oneof(fc.constant(0), finite(0, 200)),
    headerHeight: finite(1, 300),
    lineHeight: finite(8, 80),
    paraGap: gapArb,
    counts: fc.array(fc.integer({ min: 1, max: 12 }), { maxLength: 40 }),
  })
  .map(({ origin, headerHeight, lineHeight, paraGap, counts }) => ({
    origin,
    headerHeight,
    lineHeight,
    paras: counts.map((count) => ({
      gap: paraGap,
      lines: Array.from({ length: count }, () => ({ gap: 0, height: lineHeight })),
    })),
  }));

/** 不规整的章：每行高度、行间空隙、段前间距各自任意（字体回退、行内大字号等）。 */
const irregularChapterArb: fc.Arbitrary<ChapterSpec> = fc
  .record({
    origin: fc.oneof(fc.constant(0), finite(0, 200)),
    headerHeight: finite(0.5, 400),
    paras: fc.array(
      fc.record({
        gap: gapArb,
        lines: fc.array(
          fc.record({
            gap: fc.oneof(fc.constant(0), finite(0, 12)),
            height: finite(0.5, 120),
          }),
          { minLength: 1, maxLength: 12 },
        ),
      }),
      { maxLength: 30 },
    ),
  })
  .map((spec) => ({ ...spec, lineHeight: spec.paras[0]?.lines[0]?.height ?? spec.headerHeight }));

/** 任意一章的行盒序列（首个为标题区），附带其典型行高。 */
const chapterLinesArb: fc.Arbitrary<{ lines: LineBox[]; lineHeight: number }> = fc
  .oneof(regularChapterArb, irregularChapterArb)
  .map((spec) => ({ lines: buildLines(spec), lineHeight: spec.lineHeight }));

/**
 * 页高 `H > 0`：
 * - 任意值，从极矮视口到超高视口；
 * - 整数行附近：恰好放满、差一点放满、超出不到 / 恰好 / 超过 `PAGE_FIT_EPS`；
 * - 比一行还矮：每行独占一页（单行超高）。
 */
function pageHeightArb(lineHeight: number): fc.Arbitrary<number> {
  const nearWholeLines = fc
    .tuple(
      fc.integer({ min: 1, max: 40 }),
      fc.constantFrom(-1, -PAGE_FIT_EPS, -0.25, 0, 0.25, PAGE_FIT_EPS, 1),
    )
    .map(([k, delta]) => Math.max(0.1, k * lineHeight + delta));
  return fc.oneof(finite(0.1, 4000), nearWholeLines, finite(0.1, lineHeight));
}

/** 段落文本里的字符：汉字、全角标点、拉丁字母与数字。段落已去掉首尾空白，这里不放空白。 */
const paraCharArb: fc.Arbitrary<string> = fc.constantFrom(..."天地玄黄宇宙洪荒日月盈昃，。！？「」abcXYZ019");

/** 非空的段落文本：既有单字、短对话，也有一段上百字的叙述。 */
const paraTextArb: fc.Arbitrary<string> = fc.oneof(
  fc.string({ unit: paraCharArb, minLength: 1, maxLength: 4 }),
  fc.string({ unit: paraCharArb, minLength: 1, maxLength: 120 }),
);

/**
 * 一章的 `bodyParas`（`Para` 见 locator.ts）：偏移严格递增、文本非空、段与段互不重叠。
 *
 * 段间至少隔一个字符（换行符；空行、首行缩进会让空隙更大），这些空白不属于任何段。
 * 首段可以从 0 开始，也可以在后面（前导空行，或与标题重复的首段已被跳过）。可以没有段落。
 */
const parasArb: fc.Arbitrary<Para[]> = fc
  .record({
    first: fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 200 })),
    specs: fc.array(
      fc.record({
        gap: fc.oneof(fc.constant(1), fc.integer({ min: 1, max: 40 })),
        text: paraTextArb,
      }),
      { maxLength: 30 },
    ),
  })
  .map(({ first, specs }) => {
    let cursor = first;
    return specs.map(({ gap, text }, i) => {
      if (i > 0) cursor += gap;
      const para = { offset: cursor, text };
      cursor += text.length;
      return para;
    });
  });

/**
 * 与 `paras` 匹配的合法页首表：以 0 开头，严格递增，其余元素都落在某段
 * `[offset, offset + len)` 内（含段首）。这是 `usePaginator` 由每页首行换算出的形状：
 * 页首是该行首字符的章内偏移，而标题区所在的第 0 页恒从 0 开始。
 *
 * 三种分布：页界落在任意段内位置；页界只在段首（每页由整段组成）；每个字符一页（最密）。
 * `fc.subarray` 保持原数组次序，候选位置本就升序且不含 0，因此结果严格递增。
 */
function pageStartsArb(paras: readonly Para[]): fc.Arbitrary<number[]> {
  const inside = paras
    .flatMap(({ offset, text }) => Array.from({ length: text.length }, (_, i) => offset + i))
    .filter((o) => o > 0);
  const heads = paras.map(({ offset }) => offset).filter((o) => o > 0);
  return fc
    .oneof(
      { arbitrary: fc.subarray(inside), weight: 4 },
      { arbitrary: fc.subarray(heads), weight: 2 },
      { arbitrary: fc.constant(inside), weight: 1 },
    )
    .map((picked) => [0, ...picked]);
}

/**
 * 不依赖段落的页首表：以 0 开头、严格递增的非负整数。页数从 1（空章、短章只有第 0 页）到上百页；
 * 相邻页首的间距既有 1–3（每字一页的极端）也有上千（一页装一整段长叙述）。
 */
const startsArb: fc.Arbitrary<number[]> = fc
  .array(fc.oneof(fc.integer({ min: 1, max: 3 }), fc.integer({ min: 1, max: 2000 })), { maxLength: 120 })
  .map((gaps) => {
    const starts = [0];
    for (const gap of gaps) starts.push(starts[starts.length - 1] + gap);
    return starts;
  });

/** 一章的段落，连同一份与之匹配的合法页首表。 */
const pagedChapterArb: fc.Arbitrary<{ paras: Para[]; starts: number[] }> = parasArb.chain((paras) =>
  pageStartsArb(paras).map((starts) => ({ paras, starts })),
);

// ───────────────────────────── 共享辅助 ─────────────────────────────

/** 由每页首行下标得出各页的行区间 `[start, end)`（末页止于 `lineCount`）。 */
function pageRanges(firsts: readonly number[], lineCount: number): { start: number; end: number }[] {
  return firsts.map((start, k) => ({ start, end: k + 1 < firsts.length ? firsts[k + 1] : lineCount }));
}

/** 冻结行盒序列及其中每个元素：被测函数若改写入参，严格模式下会直接抛错。 */
function frozenLines(lines: readonly LineBox[]): readonly LineBox[] {
  return Object.freeze(lines.map((line) => Object.freeze({ ...line })));
}

/** 冻结段落序列及其中每段（同 `frozenLines`）。 */
function frozenParas(paras: readonly Para[]): readonly Para[] {
  return Object.freeze(paras.map((para) => Object.freeze({ ...para })));
}

/** 片段对应的文字：所在段 `text` 的 `[from − offset, to − offset)`。 */
function fragmentText(paras: readonly Para[], fragment: PageFragment): string {
  const { offset, text } = paras[fragment.para];
  return text.slice(fragment.from - offset, fragment.to - offset);
}

/** 第 `k` 页的章内区间 `[lo, hi)`，末页止于 +∞（design §4.4）。 */
function pageInterval(starts: readonly number[], k: number): { lo: number; hi: number } {
  return { lo: starts[k], hi: k + 1 < starts.length ? starts[k + 1] : Infinity };
}

// ───────────────────────────── paginateLines ─────────────────────────────

describe("paginateLines", () => {
  // Feature: reader-page-turn-modes, Property 3: 按行分页是有序划分且只含整行
  // **Validates: Requirements 2.2, 2.3**
  it("Feature: reader-page-turn-modes, Property 3: 按行分页是有序划分且只含整行——首页从标题区起、页首严格递增、每行恰属一页、多行页不超高、贪心极大", () => {
    fc.assert(
      fc.property(
        chapterLinesArb.chain(({ lines, lineHeight }) =>
          pageHeightArb(lineHeight).map((pageHeight) => ({ lines, pageHeight })),
        ),
        ({ lines, pageHeight }) => {
          const input = frozenLines(lines);
          const firsts = paginateLines(input, pageHeight);
          const n = input.length;
          // 页高容差：子像素舍入导致的超出量在 PAGE_FIT_EPS 以内仍算放得下（design §4.3）
          const limit = pageHeight + PAGE_FIT_EPS;

          // firsts[0] = 0，严格递增，且都是合法的行下标
          expect(firsts.length).toBeGreaterThanOrEqual(1);
          expect(firsts[0]).toBe(0);
          for (let k = 0; k < firsts.length; k++) {
            expect(Number.isInteger(firsts[k])).toBe(true);
            if (k > 0) expect(firsts[k]).toBeGreaterThan(firsts[k - 1]);
          }
          expect(firsts[firsts.length - 1]).toBeLessThan(n);

          // 每一行恰好属于一页：各页区间按页序首尾相接，覆盖 [0, n) 且无重复（需求 2.3）
          const pages = pageRanges(firsts, n);
          const owner: number[] = [];
          for (const { start, end } of pages) {
            expect(end).toBeGreaterThan(start);
            for (let i = start; i < end; i++) owner.push(i);
          }
          expect(owner).toEqual(Array.from({ length: n }, (_, i) => i));

          // 标题区是第 0 页的第一行（需求 2.2）
          expect(input[pages[0].start].block).toBe(-1);

          // 多行页的跨度（首行 top 到末行 bottom）不超过页高；只含一行的页允许超高
          for (const { start, end } of pages) {
            if (end - start > 1) {
              expect(input[end - 1].bottom - input[start].top).toBeLessThanOrEqual(limit);
            }
          }

          // 贪心极大：第 k 页的首行并入第 k − 1 页就会超高
          for (let k = 1; k < pages.length; k++) {
            expect(input[pages[k].start].bottom - input[pages[k - 1].start].top).toBeGreaterThan(limit);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it("单行超过页高时独占一页，前后的行照常成页", () => {
    // 页高 100：标题区与首行同页；第 2 行高 180（行内大字号一类），独占一页；其后两行合为一页
    const lines: LineBox[] = [
      { top: 0, bottom: 40, block: -1 },
      { top: 40, bottom: 70, block: 0 },
      { top: 70, bottom: 250, block: 0 },
      { top: 250, bottom: 280, block: 1 },
      { top: 280, bottom: 310, block: 1 },
    ];
    expect(paginateLines(lines, 100)).toEqual([0, 2, 3]);
  });

  it("标题区高于页高时独占第 0 页，正文从第 1 页起", () => {
    const lines: LineBox[] = [
      { top: 32, bottom: 232, block: -1 },
      { top: 256, bottom: 286, block: 0 },
      { top: 286, bottom: 316, block: 0 },
    ];
    expect(paginateLines(lines, 150)).toEqual([0, 1]);
  });

  it("视口极矮、每行都超过页高时每行各占一页，仍逐行前进", () => {
    // pageHeightFor 的下限就是 1
    const lines: LineBox[] = Array.from({ length: 5 }, (_, i) => ({
      top: i * 30,
      bottom: i * 30 + 30,
      block: i === 0 ? -1 : 0,
    }));
    expect(paginateLines(lines, 1)).toEqual([0, 1, 2, 3, 4]);
  });
});

// ───────────────────────────── pageView ─────────────────────────────

describe("pageView", () => {
  // Feature: reader-page-turn-modes, Property 4: 页片段按页序拼接等于正文
  // **Validates: Requirements 2.4**
  it("Feature: reader-page-turn-modes, Property 4: 页片段按页序拼接等于正文——片段无重叠无缺口且落在本页区间、续段标记准确、只有第 0 页带标题区、越界页为空", () => {
    fc.assert(
      fc.property(pagedChapterArb, fc.integer({ min: 0, max: 1000 }), ({ paras, starts }, beyond) => {
        const input = frozenParas(paras);
        const table: readonly number[] = Object.freeze([...starts]);
        const views = table.map((_, k) => pageView(input, table, k));

        // 按页序拼接全部片段文字 = 按段序拼接全部段落文字（需求 2.4）
        const pagedText = views.flatMap((view) => view.fragments.map((f) => fragmentText(input, f))).join("");
        expect(pagedText).toBe(input.map((para) => para.text).join(""));

        // 无重叠、无缺口：按页序展平后，片段依段序逐段铺满 [offset, offset + len)，
        // 每个片段从上一个片段的终点（或段首）接着开始，且不越出本段
        const flat = views.flatMap((view) => view.fragments);
        let next = 0;
        input.forEach((para, p) => {
          const end = para.offset + para.text.length;
          for (let pos = para.offset; pos < end; ) {
            expect(next).toBeLessThan(flat.length);
            const fragment = flat[next++];
            expect(fragment.para).toBe(p);
            expect(fragment.from).toBe(pos);
            expect(fragment.to).toBeGreaterThan(pos);
            expect(fragment.to).toBeLessThanOrEqual(end);
            pos = fragment.to;
          }
        });
        expect(next).toBe(flat.length);

        views.forEach((view, k) => {
          // 标题区只在第 0 页（需求 2.2）
          expect(view.header).toBe(k === 0);
          const { lo, hi } = pageInterval(table, k);
          for (const fragment of view.fragments) {
            const { offset, text } = input[fragment.para];
            // 片段是本页区间与段的交集
            expect(fragment.from).toBeGreaterThanOrEqual(lo);
            expect(fragment.to).toBeLessThanOrEqual(hi);
            // continued ⇔ 不从段首开始；continues ⇔ 不到段尾结束
            expect(fragment.continued).toBe(fragment.from !== offset);
            expect(fragment.continues).toBe(fragment.to !== offset + text.length);
          }
        });

        // 越界（含非整数）的页下标：空页，不带标题区
        const empty = { header: false, fragments: [] };
        for (const k of [-1, -1 - beyond, table.length, table.length + beyond, 0.5, Number.NaN]) {
          expect(pageView(input, table, k)).toEqual(empty);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("空正文章节只有第 0 页：标题区独占，没有正文片段", () => {
    // 章节 range 只有标题行与空白行；标题行与 chapter.title 相同，被 bodyParagraphs 跳过
    const paras = bodyParagraphs(splitParagraphs("第九章 空白\n\n　　\n"), "第九章 空白");
    expect(paras).toEqual([]);
    const splitNever = (): number => {
      throw new Error("空正文章节没有段落可拆");
    };

    // 测量只得到标题区一行；标题区比页高还高时也一样
    for (const header of [
      { top: 32, bottom: 112, block: -1 },
      { top: 0, bottom: 900, block: -1 },
    ]) {
      const lines: LineBox[] = [header];
      const firsts = paginateLines(lines, 600);
      expect(firsts).toEqual([0]);
      const starts = pageStartOffsets(lines, firsts, paras, splitNever);
      expect(starts).toEqual([0]);
      expect(pageView(paras, starts, 0)).toEqual({ header: true, fragments: [] });
      expect(pageView(paras, starts, 1)).toEqual({ header: false, fragments: [] });
      // 任何偏移都落在这唯一的一页上
      for (const offset of [-1, 0, 5, 1000]) expect(pageIndexOf(starts, offset)).toBe(0);
    }

    // 连标题区都没测到（未布局）：paginateLines 为空，页首表仍只有第 0 页
    expect(paginateLines([], 600)).toEqual([]);
    expect(pageStartOffsets([], [], paras, splitNever)).toEqual([0]);
  });
});

// ───────────────────────────── fragmentHighlight ─────────────────────────────

describe("fragmentHighlight", () => {
  /**
   * 与某章匹配的检索命中 `(charOffset, length ≥ 1)`，偏移是章内整数偏移（检索结果的形状）。
   *
   * 起点三种分布：
   * - 某段内的任意字符：命中必有高亮的常见情形；
   * - 页首及其前三个字、后一个字：命中横跨页界，高亮要拆到前后两页；
   * - 全章任意位置：含首段之前（被跳过的标题行、章首空白）、段间空白、正文之后与负数，都不高亮。
   *
   * 长度既有一两个字的关键词，也有长到越过段尾、跨过多页的长串（`resolveHighlight` 会夹到段尾）。
   */
  function hitArb(
    paras: readonly Para[],
    starts: readonly number[],
  ): fc.Arbitrary<{ charOffset: number; length: number }> {
    const last = paras[paras.length - 1];
    const end = last ? last.offset + last.text.length : 0;
    const anywhere = fc.integer({ min: -5, max: end + 5 });
    const nearPageStart = fc
      .tuple(fc.constantFrom(...starts), fc.integer({ min: -3, max: 1 }))
      .map(([start, delta]) => start + delta);
    const inPara = paras.length
      ? fc
          .integer({ min: 0, max: paras.length - 1 })
          .chain((p) => fc.integer({ min: paras[p].offset, max: paras[p].offset + paras[p].text.length - 1 }))
      : anywhere;
    return fc.record({
      charOffset: fc.oneof(
        { arbitrary: inPara, weight: 3 },
        { arbitrary: nearPageStart, weight: 2 },
        { arbitrary: anywhere, weight: 1 },
      ),
      length: fc.oneof(fc.integer({ min: 1, max: 4 }), fc.integer({ min: 1, max: 200 })),
    });
  }

  // Feature: reader-page-turn-modes, Property 27: 跨页检索高亮
  // **Validates: Requirements 12.3**
  it("Feature: reader-page-turn-modes, Property 27: 跨页检索高亮——各页各片段高亮的并集恰为 resolveHighlight 换算出的章内区间、互不重叠，命中起点所在页的高亮从命中起点开始", () => {
    fc.assert(
      fc.property(
        pagedChapterArb.chain(({ paras, starts }) => hitArb(paras, starts).map((hit) => ({ paras, starts, hit }))),
        ({ paras, starts, hit }) => {
          const input = frozenParas(paras);
          const table: readonly number[] = Object.freeze([...starts]);
          const query = Object.freeze({ ...hit });

          // 期望：resolveHighlight 的落点换算成章内区间 [lo, lo + length) 的逐字偏移；null 即不高亮
          const target = resolveHighlight(input, query.charOffset, query.length);
          const expected: number[] = [];
          if (target) {
            const lo = input[target.paraIndex].offset + target.offsetInPara;
            for (let i = lo; i < lo + target.length; i++) expected.push(i);
          }

          // 按页序、页内按片段序逐个求高亮，记下每个被标的章内偏移
          const covered: number[] = [];
          table.forEach((_, k) => {
            for (const fragment of pageView(input, table, k).fragments) {
              const mark = fragmentHighlight(input, fragment, query);
              if (!mark) continue;
              // 高亮是片段的非空子区间
              expect(mark.to).toBeGreaterThan(mark.from);
              expect(mark.from).toBeGreaterThanOrEqual(fragment.from);
              expect(mark.to).toBeLessThanOrEqual(fragment.to);
              for (let i = mark.from; i < mark.to; i++) covered.push(i);
            }
          });
          // 并集恰为期望区间（resolveHighlight 为 null 时为空）。按页序收集的偏移本应升序，
          // 不排序直接比：各片段的高亮有重叠会出现重复偏移，有缺口会少偏移，都比不过
          expect(covered).toEqual(expected);

          // 包含命中起点的那一页上，有一处高亮恰从命中起点开始（需求 12.3）
          if (target) {
            const page = pageIndexOf(table, query.charOffset);
            const marks = pageView(input, table, page).fragments.map((f) => fragmentHighlight(input, f, query));
            expect(marks.some((mark) => mark?.from === query.charOffset)).toBe(true);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it("命中落在被跳过的标题行时，任何一页都不高亮", () => {
    const title = "第三章 风起";
    const paras = bodyParagraphs(splitParagraphs(`${title}\n\u3000\u3000天地玄黄，宇宙洪荒。\n日月盈昃，辰宿列张。`), title);
    // 标题行 [0, 6) 被跳过，正文两段 [9, 19)、[20, 30)
    expect(paras).toEqual([
      { offset: 9, text: "天地玄黄，宇宙洪荒。" },
      { offset: 20, text: "日月盈昃，辰宿列张。" },
    ]);
    // 三页：两条页界都落在段中
    const starts = [0, 14, 25];
    const fragments = starts.flatMap((_, k) => pageView(paras, starts, k).fragments);
    expect(fragments).toHaveLength(4);

    // "第三"、"风起"，以及起点在标题行、长度伸进首段的长命中
    for (const hit of [
      { charOffset: 0, length: 2 },
      { charOffset: 4, length: 2 },
      { charOffset: 5, length: 12 },
    ]) {
      expect(fragments.map((f) => fragmentHighlight(paras, f, hit))).toEqual([null, null, null, null]);
    }

    // 对照：命中首段段首"天地"，第 0 页的片段照常高亮
    expect(fragmentHighlight(paras, fragments[0], { charOffset: 9, length: 2 })).toEqual({ from: 9, to: 11 });
  });
});

// ───────────────────────────── pageIndexOf ─────────────────────────────

describe("pageIndexOf", () => {
  /**
   * 任意整数偏移：页首本身及其左右各一（"恰为页首"归本页、差一归上一页的边界），
   * 章内任意位置，负数，以及远超末页页首的值（直到安全整数的两端）。
   */
  function offsetArb(starts: readonly number[]): fc.Arbitrary<number> {
    const last = starts[starts.length - 1];
    return fc.oneof(
      fc
        .tuple(fc.constantFrom(...starts), fc.constantFrom(-1, 0, 1))
        .map(([start, delta]) => start + delta),
      fc.integer({ min: -1000, max: last + 3000 }),
      fc.integer({ min: Number.MIN_SAFE_INTEGER, max: -1 }),
      fc.integer({ min: last, max: Number.MAX_SAFE_INTEGER }),
    );
  }

  // Feature: reader-page-turn-modes, Property 5: 由偏移找页
  // **Validates: Requirements 1.6, 2.5, 12.1, 12.4**
  it("Feature: reader-page-turn-modes, Property 5: 由偏移找页——结果是合法页下标、页首不大于偏移、偏移小于下一页页首、每个页首映回自身那一页", () => {
    fc.assert(
      fc.property(
        startsArb.chain((starts) => offsetArb(starts).map((offset) => ({ starts, offset }))),
        ({ starts, offset }) => {
          const table: readonly number[] = Object.freeze([...starts]);
          const p = pageIndexOf(table, offset);

          // 0 ≤ p < starts.length
          expect(Number.isInteger(p)).toBe(true);
          expect(p).toBeGreaterThanOrEqual(0);
          expect(p).toBeLessThan(table.length);
          // o ≥ 0 时 starts[p] ≤ o
          if (offset >= 0) expect(table[p]).toBeLessThanOrEqual(offset);
          // p 不是末页时 o < starts[p + 1]
          if (p + 1 < table.length) expect(offset).toBeLessThan(table[p + 1]);

          // 每个页首都映回它自己那一页（不是上一页）
          table.forEach((start, k) => expect(pageIndexOf(table, start)).toBe(k));
        },
      ),
      { numRuns: 300 },
    );
  });

  const starts = [0, 120, 245, 380];

  it("偏移 0 落在第 0 页", () => {
    expect(pageIndexOf(starts, 0)).toBe(0);
    expect(pageIndexOf([0], 0)).toBe(0);
    expect(pageIndexOf([0, 1], 0)).toBe(0);
  });

  it("偏移恰为某页页首时落在那一页，差一个字落在上一页", () => {
    expect(starts.map((start) => pageIndexOf(starts, start))).toEqual([0, 1, 2, 3]);
    expect(starts.slice(1).map((start) => pageIndexOf(starts, start - 1))).toEqual([0, 1, 2]);
    expect(pageIndexOf(starts, 200)).toBe(1);
  });

  it("负偏移视为 0，落在第 0 页", () => {
    for (const offset of [-1, -120, Number.MIN_SAFE_INTEGER, Number.NEGATIVE_INFINITY]) {
      expect(pageIndexOf(starts, offset)).toBe(0);
    }
    // NaN 不满足任何 starts[p] ≤ offset，同样夹到第 0 页
    expect(pageIndexOf(starts, Number.NaN)).toBe(0);
  });

  it("超出末页页首的偏移落在末页", () => {
    for (const offset of [381, 10_000, Number.MAX_SAFE_INTEGER, Number.POSITIVE_INFINITY]) {
      expect(pageIndexOf(starts, offset)).toBe(3);
    }
    // 只有一页的章：任何偏移都在第 0 页
    for (const offset of [-5, 0, 7, 10_000]) expect(pageIndexOf([0], offset)).toBe(0);
  });
});

// ───────────────────────────── pagedPositionStep ─────────────────────────────

describe("pagedPositionStep", () => {
  type NavEvent = Extract<PagedPosEvent, { kind: "nav" }>;

  /** 章号只取几个值，"页表属于当前章"与"属于别章"（导航后旧章的测量才回来）两种情形都常见。 */
  const chapterIdArb = fc.integer({ min: 0, max: 3 });

  /** 阅读位置：章首 0、章内任意位置（多数落在某页中间，来自检索或切模式），以及远超末页页首的值。 */
  const offsetArb = fc.oneof(
    fc.constant(0),
    fc.integer({ min: 0, max: 20_000 }),
    fc.integer({ min: 0, max: 1_000_000 }),
  );

  const navArb: fc.Arbitrary<NavEvent> = fc.record({
    kind: fc.constant("nav" as const),
    chapterId: chapterIdArb,
    charOffset: offsetArb,
  });

  /** 重分页：任意章、任意排版参数下的任意页表（窗口尺寸、字号、字体就绪……）。 */
  const relayoutArb: fc.Arbitrary<PagedPosEvent> = fc.record({
    kind: fc.constant("relayout" as const),
    table: fc.record({ chapterId: chapterIdArb, layoutKey: fc.constantFrom("A", "B", "C"), starts: startsArb }),
  });

  /** 翻页或 Home/End 完成：落点是所在章页首表的合法下标。 */
  const turnedArb: fc.Arbitrary<PagedPosEvent> = fc
    .record({ chapterId: chapterIdArb, starts: startsArb })
    .chain(({ chapterId, starts }) =>
      fc
        .integer({ min: 0, max: starts.length - 1 })
        .map((page) => ({ kind: "turned" as const, to: { chapterId, page }, starts })),
    );

  /** 归约器的初始状态：上一段阅读留下的任意位置与显示页。 */
  const stateArb: fc.Arbitrary<PagedPosState> = fc.record({
    chapterId: chapterIdArb,
    charOffset: offsetArb,
    page: fc.nat({ max: 50 }),
  });

  // Feature: reader-page-turn-modes, Property 6: 程序化定位不改变阅读位置
  // **Validates: Requirements 1.7, 2.5**
  //
  // 对应"挂载、重分页、窗口尺寸变化只重新计算显示哪一页，不上报"：`nav(c, o)` 之后无论来多少次
  // 重分页，阅读位置始终是 (c, o)，一次都不上报，显示页由最近一张属于 c 的页表决定。别章的页表
  // 被忽略，状态原样返回（引用相等）。`nav` 之后、第一张 c 的页表之前，显示页只是占位，不做断言。
  it("Feature: reader-page-turn-modes, Property 6: 程序化定位不改变阅读位置——nav(c, o) 之后只有 relayout 时，位置恒为 (c, o)、从不上报、显示页为 pageIndexOf(最近一张页表, o)", () => {
    fc.assert(
      fc.property(stateArb, navArb, fc.array(relayoutArb, { maxLength: 20 }), (initial, nav, relayouts) => {
        let state: PagedPosState = Object.freeze({ ...initial });
        let latest: readonly number[] | null = null;

        for (const event of [nav, ...relayouts]) {
          const before = state;
          const out = pagedPositionStep(before, event);
          state = Object.freeze(out.state);

          expect(out.report, `${event.kind} 不应上报`).toBe(false);
          expect(state.chapterId).toBe(nav.chapterId);
          expect(state.charOffset).toBe(nav.charOffset);

          if (event.kind === "relayout") {
            if (event.table.chapterId === nav.chapterId) latest = event.table.starts;
            else expect(state, "别章的页表应被忽略").toBe(before);
          }
          if (latest) expect(state.page).toBe(pageIndexOf(latest, nav.charOffset));
        }
      }),
      { numRuns: 300 },
    );
  });

  // 对应"只有翻页、Home/End 会上报位置"：任意事件序列中，`report` 为真当且仅当事件是 `turned`；
  // `turned(to, starts)` 之后阅读位置是新页的页首 `starts[to.page]`，显示页是 `to.page`。
  // 阅读位置只在 `nav` 与 `turned` 时改变，其间穿插的 `relayout` 只动显示页。
  it("Feature: reader-page-turn-modes, Property 6: 程序化定位不改变阅读位置——只有 turned 上报，turned 之后位置为新页页首，relayout 从不改动位置", () => {
    const eventsArb = fc.array(
      fc.oneof(
        { arbitrary: relayoutArb, weight: 3 },
        { arbitrary: turnedArb, weight: 2 },
        { arbitrary: navArb, weight: 1 },
      ),
      { maxLength: 40 },
    );

    fc.assert(
      fc.property(stateArb, eventsArb, (initial, events) => {
        let state: PagedPosState = Object.freeze({ ...initial });
        // 模型：读者此刻的阅读位置
        let position = { chapterId: initial.chapterId, charOffset: initial.charOffset };

        for (const event of events) {
          const out = pagedPositionStep(state, event);
          state = Object.freeze(out.state);

          expect(out.report).toBe(event.kind === "turned");
          switch (event.kind) {
            case "nav":
              position = { chapterId: event.chapterId, charOffset: event.charOffset };
              break;
            case "turned":
              position = { chapterId: event.to.chapterId, charOffset: event.starts[event.to.page] };
              expect(state.page).toBe(event.to.page);
              break;
            case "relayout":
              if (event.table.chapterId === position.chapterId) {
                expect(state.page).toBe(pageIndexOf(event.table.starts, position.charOffset));
              }
              break;
          }
          expect({ chapterId: state.chapterId, charOffset: state.charOffset }).toEqual(position);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("检索命中落在页中：改字号再改回后位置仍是命中偏移，翻一页后才变为下一页页首并上报", () => {
    const original: PageTable = { chapterId: 7, layoutKey: "18px", starts: [0, 380, 620, 900] };
    const larger: PageTable = { chapterId: 7, layoutKey: "22px", starts: [0, 240, 480, 720, 960] };
    const events: PagedPosEvent[] = [
      { kind: "nav", chapterId: 7, charOffset: 500 }, // 检索命中，位于第 1 页 [380, 620) 中间
      { kind: "relayout", table: original },
      { kind: "relayout", table: larger }, // 改大字号：命中落到第 2 页 [480, 720)，页首 480 不是阅读位置
      { kind: "relayout", table: { chapterId: 6, layoutKey: "18px", starts: [0, 450] } }, // 旧章的测量迟到
      { kind: "relayout", table: original }, // 改回
      { kind: "turned", to: { chapterId: 7, page: 2 }, starts: original.starts },
    ];

    let state: PagedPosState = { chapterId: 3, charOffset: 42, page: 0 };
    const steps = events.map((event) => {
      const out = pagedPositionStep(state, event);
      state = out.state;
      return out;
    });

    expect(steps.map((s) => s.report)).toEqual([false, false, false, false, false, true]);
    expect(steps.map((s) => [s.state.charOffset, s.state.page])).toEqual([
      [500, 0],
      [500, 1],
      [500, 2],
      [500, 2],
      [500, 1],
      [620, 2],
    ]);
  });
});

// ───────────────────────────── stepPage ─────────────────────────────

describe("stepPage", () => {
  /**
   * 章节表 + 每个正文章节的页数。
   *
   * 卷节点约占三成，位置任意：书首、书尾、相邻两三个挤在一起都会出现。另在任意位置插入一个
   * 正文章节，保证至少有一个。页数 ≥ 1：单页章（标题区独占、短章）连续出现时，一步就要跨章；
   * 也有几十页的长章。卷节点没有页数，`pageCount` 对它返回 `undefined`——若 `stepPage`
   * 误把卷节点当相邻章去查页数，结果会变成 `"pending"`，下面的断言会把它抓出来。
   */
  const bookArb: fc.Arbitrary<{ isVolume: boolean; count: number }[]> = fc
    .record({
      rest: fc.array(
        fc.record({
          isVolume: fc.oneof({ arbitrary: fc.constant(true), weight: 3 }, { arbitrary: fc.constant(false), weight: 7 }),
          count: fc.oneof(fc.constant(1), fc.integer({ min: 1, max: 4 }), fc.integer({ min: 1, max: 60 })),
        }),
        { maxLength: 20 },
      ),
      at: fc.nat(),
      count: fc.integer({ min: 1, max: 4 }),
    })
    .map(({ rest, at, count }) => {
      const book = [...rest];
      book.splice(at % (rest.length + 1), 0, { isVolume: false, count });
      return book;
    });

  /** 模型：原始下标 `id` 之后（`step = 1`）或之前（`step = −1`）第一个正文章节，没有时为 null。逐个扫描，不经二分。 */
  function adjacentContent(book: readonly { isVolume: boolean }[], id: number, step: 1 | -1): number | null {
    for (let i = id + step; i >= 0 && i < book.length; i += step) {
      if (!book[i].isVolume) return i;
    }
    return null;
  }

  // Feature: reader-page-turn-modes, Property 7: 跨章步进
  // **Validates: Requirements 2.7, 3.1, 3.2, 3.3, 3.5, 3.6**
  //
  // 对每个正文章节的每一页都走一遍两个方向，与逐个扫描的模型比对：章内 ±1；跨到下一章落在第 0 页，
  // 跨到上一章落在末页；卷节点被跳过；只有全书首章第 0 页往前、末章末页往后返回 null。
  // 页数全部已知，所以任何时候都不应出现 "pending"。
  it("Feature: reader-page-turn-modes, Property 7: 跨章步进——章内 ±1 或跨到相邻正文章节的首页 / 末页、结果恒为正文章节、null 当且仅当在全书首末、next 与 prev 互逆", () => {
    fc.assert(
      fc.property(bookArb, (book) => {
        const views = buildChapterViews(book);
        const counts = new Map<number, number>();
        book.forEach((chapter, id) => {
          if (!chapter.isVolume) counts.set(id, chapter.count);
        });
        const pageCount = (chapterId: number) => counts.get(chapterId);

        const contentIds = Array.from(counts.keys());
        const firstId = contentIds[0];
        const lastId = contentIds[contentIds.length - 1];

        for (const [chapterId, count] of counts) {
          for (let page = 0; page < count; page++) {
            const pos: PagePos = Object.freeze({ chapterId, page });

            // ── next ──
            const next = stepPage(pos, "next", views, pageCount);
            const nextId = adjacentContent(book, chapterId, 1);
            if (page + 1 < count) {
              expect(next).toEqual({ chapterId, page: page + 1 });
            } else if (nextId === null) {
              // 全书末章末页（需求 3.6）
              expect(chapterId).toBe(lastId);
              expect(next).toBeNull();
            } else {
              // 跨到下一个正文章节的第 0 页，中间的卷节点被跳过（需求 3.1、3.3）
              expect(next).toEqual({ chapterId: nextId, page: 0 });
            }

            // ── prev ──
            const prev = stepPage(pos, "prev", views, pageCount);
            const prevId = adjacentContent(book, chapterId, -1);
            if (page > 0) {
              expect(prev).toEqual({ chapterId, page: page - 1 });
            } else if (prevId === null) {
              // 全书首章第 0 页（需求 3.5）
              expect(chapterId).toBe(firstId);
              expect(prev).toBeNull();
            } else {
              // 跨到上一个正文章节的末页（需求 3.2、3.3）
              expect(prev).toEqual({ chapterId: prevId, page: counts.get(prevId)! - 1 });
            }

            for (const result of [next, prev]) {
              expect(result).not.toBe("pending");
              if (result === null || result === "pending") continue;
              // 结果章节恒为正文章节，页下标落在该章页数之内
              expect(book[result.chapterId].isVolume).toBe(false);
              expect(result.page).toBeGreaterThanOrEqual(0);
              expect(result.page).toBeLessThan(counts.get(result.chapterId)!);
            }

            // 往返：next 之后 prev 回到原处；prev 之后 next 同样回到原处
            if (next !== null && next !== "pending") {
              expect(stepPage(next, "prev", views, pageCount)).toEqual(pos);
            }
            if (prev !== null && prev !== "pending") {
              expect(stepPage(prev, "next", views, pageCount)).toEqual(pos);
            }
          }
        }

        // null 当且仅当在全书首末：从首章第 0 页一路往后，恰好走遍每个正文章节的每一页后才得到 null
        let walked = 0;
        let at: PagePos | "pending" | null = { chapterId: firstId, page: 0 };
        while (at !== null && at !== "pending") {
          walked += 1;
          at = stepPage(at, "next", views, pageCount);
        }
        expect(at).toBeNull();
        expect(walked).toBe(contentIds.reduce((sum, id) => sum + counts.get(id)!, 0));
      }),
      { numRuns: 300 },
    );
  });

  const VOL = { isVolume: true };
  const BODY = { isVolume: false };

  /** 已知页数的章 → pageCount；记下每次被问到的章号，表里没有的（卷节点、未分页）返回 undefined。 */
  function pageCountOf(counts: ReadonlyMap<number, number>) {
    const asked: number[] = [];
    const pageCount = (chapterId: number): number | undefined => {
      asked.push(chapterId);
      return counts.get(chapterId);
    };
    return { asked, pageCount };
  }

  it("全书首章第 0 页往前、末章末页往后返回 null；书首书尾的卷节点不算相邻章（需求 3.5、3.6）", () => {
    // 卷 · 第 1 章（2 页）· 第 2 章（3 页）· 卷
    const views = buildChapterViews([VOL, BODY, BODY, VOL]);
    const { pageCount } = pageCountOf(new Map([[1, 2], [2, 3]]));

    expect(stepPage({ chapterId: 1, page: 0 }, "prev", views, pageCount)).toBeNull();
    expect(stepPage({ chapterId: 2, page: 2 }, "next", views, pageCount)).toBeNull();
    // 同一页的另一个方向不是边界
    expect(stepPage({ chapterId: 1, page: 0 }, "next", views, pageCount)).toEqual({ chapterId: 1, page: 1 });
    expect(stepPage({ chapterId: 2, page: 2 }, "prev", views, pageCount)).toEqual({ chapterId: 2, page: 1 });
  });

  it("全书只有一个单页正文章时两个方向都是边界", () => {
    for (const book of [[BODY], [VOL, BODY, VOL]]) {
      const views = buildChapterViews(book);
      const pos: PagePos = { chapterId: book.indexOf(BODY), page: 0 };
      expect(stepPage(pos, "prev", views, () => 1)).toBeNull();
      expect(stepPage(pos, "next", views, () => 1)).toBeNull();
    }
  });

  it("书首往前判边界不需要页数：一章都没分页时也立即返回 null", () => {
    const views = buildChapterViews([VOL, BODY, BODY]);
    expect(stepPage({ chapterId: 1, page: 0 }, "prev", views, () => undefined)).toBeNull();
    // 往后要先知道本章页数，才能判断是否已在末页
    expect(stepPage({ chapterId: 2, page: 0 }, "next", views, () => undefined)).toBe("pending");
  });

  it("相邻章之间隔着卷节点时跨过卷节点：往后落在第 0 页、往前落在末页，从不向卷节点要页数（需求 3.3）", () => {
    // 第 0 章（2 页）· 卷 · 卷 · 第 3 章（3 页）· 卷 · 第 5 章（1 页）
    const views = buildChapterViews([BODY, VOL, VOL, BODY, VOL, BODY]);
    const { asked, pageCount } = pageCountOf(new Map([[0, 2], [3, 3], [5, 1]]));

    expect(stepPage({ chapterId: 0, page: 1 }, "next", views, pageCount)).toEqual({ chapterId: 3, page: 0 });
    expect(stepPage({ chapterId: 3, page: 0 }, "prev", views, pageCount)).toEqual({ chapterId: 0, page: 1 });
    expect(stepPage({ chapterId: 3, page: 2 }, "next", views, pageCount)).toEqual({ chapterId: 5, page: 0 });
    expect(stepPage({ chapterId: 5, page: 0 }, "prev", views, pageCount)).toEqual({ chapterId: 3, page: 2 });
    expect(asked.filter((id) => [1, 2, 4].includes(id))).toEqual([]);
  });

  it("隔着卷节点的相邻章还没分页时返回 pending，不误报边界", () => {
    const views = buildChapterViews([BODY, VOL, BODY]);
    expect(stepPage({ chapterId: 0, page: 1 }, "next", views, pageCountOf(new Map([[0, 2]])).pageCount)).toBe(
      "pending",
    );
    expect(stepPage({ chapterId: 2, page: 0 }, "prev", views, pageCountOf(new Map([[2, 3]])).pageCount)).toBe(
      "pending",
    );
  });

  it("空正文章节（只有第 0 页）照常被跨过", () => {
    // 第 0 章（2 页）· 第 1 章（空正文，1 页）· 第 2 章（2 页）
    const views = buildChapterViews([BODY, BODY, BODY]);
    const { pageCount } = pageCountOf(new Map([[0, 2], [1, 1], [2, 2]]));

    expect(stepPage({ chapterId: 0, page: 1 }, "next", views, pageCount)).toEqual({ chapterId: 1, page: 0 });
    expect(stepPage({ chapterId: 1, page: 0 }, "next", views, pageCount)).toEqual({ chapterId: 2, page: 0 });
    expect(stepPage({ chapterId: 2, page: 0 }, "prev", views, pageCount)).toEqual({ chapterId: 1, page: 0 });
    expect(stepPage({ chapterId: 1, page: 0 }, "prev", views, pageCount)).toEqual({ chapterId: 0, page: 1 });
  });
});

// ───────────────────────────── 测量换算（design §4.1、§4.2） ─────────────────────────────

describe("pageHeightFor", () => {
  it("视口宽或高为 0（或不是正数）时不分页", () => {
    const cases: [number, number][] = [
      [0, 800],
      [390, 0],
      [0, 0],
      [-1, 800],
      [Number.NaN, 800],
      [390, Number.NaN],
    ];
    for (const [w, h] of cases) expect(pageHeightFor(w, h)).toBeNull();
  });

  it("页高 = 视口高 − 上下内边距", () => {
    expect([PAGE_PAD_TOP, PAGE_PAD_BOTTOM]).toEqual([32, 32]);
    expect(pageHeightFor(390, 844)).toBe(780);
    expect(pageHeightFor(1280, 720.5)).toBe(656.5);
  });

  it("视口比上下内边距之和还矮时页高取 1", () => {
    expect(pageHeightFor(390, 64)).toBe(1);
    expect(pageHeightFor(390, 10)).toBe(1);
  });
});

describe("paragraphLines", () => {
  it("相邻字形行空隙的中点作行界，首行上沿取段落顶边、末行下沿取段落底边", () => {
    // 行高 30、字形高 20：每行字形上下各比行盒缩进 5
    const glyphs = [
      { top: 105, bottom: 125 },
      { top: 135, bottom: 155 },
      { top: 165, bottom: 185 },
    ];
    expect(paragraphLines(glyphs, { top: 100, bottom: 190 }, 2)).toEqual([
      { top: 100, bottom: 130, block: 2 },
      { top: 130, bottom: 160, block: 2 },
      { top: 160, bottom: 190, block: 2 },
    ]);
  });

  it("同一行的多个矩形先合并，入参无序也照样成行", () => {
    // 第一行：主字体 [105, 125] 与回退字体 [103, 127]；第二行 [135, 155]
    const rects = [
      { top: 135, bottom: 155 },
      { top: 105, bottom: 125 },
      { top: 103, bottom: 127 },
    ];
    expect(paragraphLines(rects, { top: 100, bottom: 160 }, 0)).toEqual([
      { top: 100, bottom: 131, block: 0 },
      { top: 131, bottom: 160, block: 0 },
    ]);
  });

  it("相邻字形行有重叠时，行界仍落在两行之间", () => {
    // 回退字体的内容区（36）高于行高：两行字形擦边重叠 6px
    expect(paragraphLines([{ top: 100, bottom: 136 }, { top: 130, bottom: 166 }], { top: 97, bottom: 169 }, 1)).toEqual([
      { top: 97, bottom: 133, block: 1 },
      { top: 133, bottom: 169, block: 1 },
    ]);
  });

  it("取不到可用的字形矩形时整段当作一行", () => {
    const whole = [{ top: 40, bottom: 70, block: 3 }];
    expect(paragraphLines([], { top: 40, bottom: 70 }, 3)).toEqual(whole);
    // 零高矩形（被折叠的空白）不携带纵向信息
    expect(paragraphLines([{ top: 50, bottom: 50 }], { top: 40, bottom: 70 }, 3)).toEqual(whole);
  });
});

describe("pageStartOffsets", () => {
  // 标题区一行；第 0 段 3 行，章内 [10, 40)；第 1 段 2 行，章内 [42, 62)
  const paras: Para[] = [
    { offset: 10, text: "甲".repeat(30) },
    { offset: 42, text: "乙".repeat(20) },
  ];
  const lines: LineBox[] = [
    { top: 0, bottom: 80, block: -1 },
    { top: 120, bottom: 150, block: 0 },
    { top: 150, bottom: 180, block: 0 },
    { top: 180, bottom: 210, block: 0 },
    { top: 234, bottom: 264, block: 1 },
    { top: 264, bottom: 294, block: 1 },
  ];
  const noSplit = () => {
    throw new Error("页首是段首行，不应拆段");
  };

  it("第 0 页为 0；首行是段首行时取段偏移；首行在段中时取 splitAt 的结果", () => {
    const calls: number[] = [];
    const starts = pageStartOffsets(lines, [0, 2, 4, 5], paras, (line) => {
      calls.push(line);
      return line === 2 ? 20 : 52;
    });
    expect(starts).toEqual([0, 20, 42, 52]);
    expect(calls).toEqual([2, 5]);
  });

  it("标题区独占第 0 页时，第 1 页从首段偏移起", () => {
    expect(pageStartOffsets(lines, [0, 1], paras, noSplit)).toEqual([0, 10]);
  });

  it("不大于上一页页首的偏移被丢弃，结果严格递增", () => {
    // 首段从偏移 0 起：标题区独占一页时，第 1 页的页首也是 0
    const fromZero: Para[] = [{ offset: 0, text: "甲".repeat(30) }, paras[1]];
    expect(pageStartOffsets(lines, [0, 1, 4], fromZero, noSplit)).toEqual([0, 42]);
    // 段中拆分退化，两个页界给出同一个偏移
    expect(pageStartOffsets(lines, [0, 2, 3], paras, () => 15)).toEqual([0, 15]);
  });

  it("只有一页或空章时只有第 0 页", () => {
    expect(pageStartOffsets(lines, [0], paras, noSplit)).toEqual([0]);
    expect(pageStartOffsets([], [], [], noSplit)).toEqual([0]);
  });
});

describe("firstCharBelow", () => {
  const cpWidth = (text: string, i: number) => ((text.codePointAt(i) ?? 0) > 0xffff ? 2 : 1);

  /**
   * 假排版：按码点每 `perLine` 个折一行，第 k 行的字形中点在 `30k + 15`，行界在 `30k`。
   * `blank` 中的码点没有矩形（被折叠的空白）。探测起点不是码点起点、或区间不是恰好一个码点时直接抛错。
   */
  function layout(text: string, perLine: number, blank: ReadonlySet<number> = new Set()) {
    const cpStarts: number[] = [];
    for (let i = 0; i < text.length; i += cpWidth(text, i)) cpStarts.push(i);
    const cpAt = new Map(cpStarts.map((unit, cp) => [unit, cp]));
    let probes = 0;
    const midY = (start: number, end: number): number | null => {
      probes += 1;
      const cp = cpAt.get(start);
      if (cp === undefined) throw new Error(`探测起点 ${start} 不是码点起点`);
      if (end !== start + cpWidth(text, start)) throw new Error(`探测区间 [${start}, ${end}) 不是恰好一个码点`);
      return blank.has(cp) ? null : Math.floor(cp / perLine) * 30 + 15;
    };
    return { cpStarts, midY, probes: () => probes };
  }

  it("返回目标行首字的下标", () => {
    const text = "零一二三四五六七八九十甲乙丙"; // 14 字，每行 4 字
    const { midY } = layout(text, 4);
    expect([1, 2, 3].map((k) => firstCharBelow(text, 30 * k, midY))).toEqual([4, 8, 12]);
  });

  it("boundary 在首行之上为 0，在末行之下为 text.length；空串为 0", () => {
    const text = "零一二三四五";
    const { midY } = layout(text, 4);
    expect(firstCharBelow(text, 0, midY)).toBe(0);
    expect(firstCharBelow(text, 1000, midY)).toBe(text.length);
    expect(firstCharBelow("", 30, midY)).toBe(0);
  });

  it("跳过低位代理项：只在码点起点上探测，代理对不被页界拆开", () => {
    const text = "甲😀乙😀😀丙😀丁戊😀😀😀己"; // 13 个码点，每行 3 个
    const { cpStarts, midY } = layout(text, 3);
    for (let k = 1; 3 * k < cpStarts.length; k++) {
      expect(firstCharBelow(text, 30 * k, midY)).toBe(cpStarts[3 * k]);
    }
  });

  it("不可测的字跟随其后第一个可测的字归行", () => {
    const text = "零一二三四五六七八九";
    // 第 1 行首字不可测：归第 1 行
    expect(firstCharBelow(text, 30, layout(text, 4, new Set([4])).midY)).toBe(4);
    // 第 0 行末字不可测（行尾被折叠的空白）：同样跟随第 1 行
    expect(firstCharBelow(text, 30, layout(text, 4, new Set([3])).midY)).toBe(3);
    // 段尾一串都不可测：按落在 boundary 之下处理
    expect(firstCharBelow(text, 1000, layout(text, 4, new Set([8, 9])).midY)).toBe(8);
  });

  it("每个页界约 log₂(段长) 次矩形读取", () => {
    const text = "字".repeat(1000);
    const fake = layout(text, 20);
    expect(firstCharBelow(text, 30 * 17, fake.midY)).toBe(340);
    expect(fake.probes()).toBeLessThanOrEqual(Math.ceil(Math.log2(1000)) + 1);
  });
});

// ───────────────────────────── 页表缓存（design §2.2、§4.5） ─────────────────────────────

describe("layoutKeyOf", () => {
  const base: LayoutInputs = {
    width: 390,
    height: 844,
    contentWidth: 800,
    fontSize: 18,
    lineHeight: 1.8,
    letterSpacing: 0,
    fontFamily: "system",
    fontEpoch: 0,
  };

  it("八项输入任何一项变化都得到不同的 layoutKey（需求 2.5）", () => {
    const variants: Partial<LayoutInputs>[] = [
      { width: 391 },
      { height: 843 },
      { contentWidth: 720 },
      { fontSize: 20 },
      { lineHeight: 2 },
      { letterSpacing: 0.5 },
      { fontFamily: "kaiti" },
      { fontEpoch: 1 },
    ];
    const keys = new Set([layoutKeyOf(base), ...variants.map((v) => layoutKeyOf({ ...base, ...v }))]);
    expect(keys.size).toBe(variants.length + 1);
  });

  it("相同输入得到相同的 layoutKey", () => {
    expect(layoutKeyOf({ ...base })).toBe(layoutKeyOf(base));
  });
});

describe("cachePageTable", () => {
  const table = (chapterId: number, layoutKey = "A"): PageTable => ({ chapterId, layoutKey, starts: [0, chapterId] });
  const ids = (cache: PageTableCache) => Array.from(cache.tables.keys());

  it("layoutKey 不同即整体作废，新缓存只含这一张", () => {
    const old = cachePageTable(cachePageTable(null, table(1), []), table(2), []);
    const next = cachePageTable(old, table(3, "B"), []);
    expect(next.layoutKey).toBe("B");
    expect(ids(next)).toEqual([3]);
    expect(cachedPageTable(next, "A", 1)).toBeUndefined();
    expect(cachedPageTable(next, "B", 3)).toEqual(table(3, "B"));
  });

  it("不改动入参缓存", () => {
    const first = cachePageTable(null, table(1), []);
    cachePageTable(first, table(2), []);
    expect(ids(first)).toEqual([1]);
  });

  it("同章重写替换旧表并算作最新写入", () => {
    let cache = cachePageTable(null, table(1), []);
    cache = cachePageTable(cache, table(2), []);
    const replaced = { chapterId: 1, layoutKey: "A", starts: [0, 7, 9] };
    cache = cachePageTable(cache, replaced, []);
    expect(ids(cache)).toEqual([2, 1]);
    expect(cache.tables.get(1)).toBe(replaced);
  });

  it(`超出 ${PAGE_TABLE_CACHE_LIMIT} 章时淘汰最早写入的，但保住 keep 里的章与新写入的那张`, () => {
    let cache: PageTableCache | null = null;
    // 往回翻：当前章 5 最早写入，随后才补 4、3……
    for (const id of [5, 6, 4, 3, 2]) cache = cachePageTable(cache, table(id), [5, 6, 4]);
    expect(ids(cache!)).toEqual([5, 6, 4, 3, 2]);
    // 读到第 2 章：keep 换成 2 与相邻的 3、1；最早的 5 先被淘汰
    cache = cachePageTable(cache, table(1), [2, 3, 1]);
    expect(ids(cache)).toEqual([6, 4, 3, 2, 1]);
    // keep 里的 5 早于 6 写入，但淘汰跳过它
    let kept: PageTableCache | null = null;
    for (const id of [5, 6, 7, 8, 9]) kept = cachePageTable(kept, table(id), [5]);
    kept = cachePageTable(kept, table(10), [5]);
    expect(ids(kept)).toEqual([5, 7, 8, 9, 10]);
  });

  it("keep 本身超出容量时仍不超过 limit，新写入的那张永不淘汰", () => {
    let cache: PageTableCache | null = null;
    for (const id of [1, 2, 3]) cache = cachePageTable(cache, table(id), [1, 2, 3], 2);
    expect(ids(cache!)).toEqual([2, 3]);
    expect(cachePageTable(null, table(9), [], 0).tables.size).toBe(1);
  });
});

describe("neighborChapters", () => {
  const VOL = { isVolume: true };
  const BODY = { isVolume: false };

  it("顺序为下一章、上一章，跳过卷节点（需求 3.3、3.4）", () => {
    const views = buildChapterViews([VOL, BODY, BODY, VOL, VOL, BODY, BODY]);
    expect(neighborChapters(views, 2)).toEqual([5, 1]);
    expect(neighborChapters(views, 5)).toEqual([6, 2]);
  });

  it("全书首末章只列有相邻章的那一侧；唯一的正文章没有相邻章", () => {
    const views = buildChapterViews([VOL, BODY, BODY, BODY, VOL]);
    expect(neighborChapters(views, 1)).toEqual([2]);
    expect(neighborChapters(views, 3)).toEqual([2]);
    expect(neighborChapters(buildChapterViews([VOL, BODY]), 1)).toEqual([]);
  });
});

describe("measureBoxTarget", () => {
  const current = { chapterId: 2 };
  const neighbor = { chapterId: 3 };

  it("待测的当前章优先于强制挂载的相邻章：宿主的渲染驱动测量总能在盒子里找到当前章（需求 2.5）", () => {
    expect(measureBoxTarget(current, neighbor)).toBe(current);
    expect(measureBoxTarget(current, null)).toBe(current);
  });

  it("没有渲染驱动的目标时挂强制挂载的那一章；两者都没有时为空盒", () => {
    expect(measureBoxTarget(null, neighbor)).toBe(neighbor);
    expect(measureBoxTarget(null, null)).toBeNull();
  });
});
