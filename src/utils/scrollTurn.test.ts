import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { VerticalExtent } from "./paginate";
import {
  anchorAt,
  anchoredScrollTop,
  type ChapterWindow,
  chapterWindow,
  EMPTY_SCROLL_GEOMETRY,
  estimateVelocity,
  FLING_MIN_SPEED,
  FLING_TAU_MS,
  flingAt,
  locateAt,
  MAX_MOUNTED_CHAPTERS,
  type MotionSample,
  OVERSCAN_ABOVE_SCREENS,
  OVERSCAN_BELOW_SCREENS,
  type ScrollGeometry,
  type ScrollPosEvent,
  type ScrollPosState,
  scrollPositionStep,
  scrollTurnDelta,
  TOP_BIAS,
  VELOCITY_WINDOW_MS,
} from "./scrollTurn";

// ───────────────────────────── scrollTurnDelta ─────────────────────────────

/**
 * 坐标网格：1/8 px。生成器在整数格点上构造，再乘以 `UNIT` 换成 px。二进制能精确表示 1/8，
 * 这个量级的加减不舍入，"平移后恰好落在顶端/底端"可以按原值用 `toBe` 断言（被测函数不取整）。
 */
const UNIT = 1 / 8;
const px = (units: number) => units * UNIT;

/** 相邻两行之间的空隙（格点）：行内紧贴、段间空隙，以及偶尔比可见区还高的大空隙。 */
const gapArb = fc.oneof(
  fc.constant(0),
  fc.integer({ min: 0, max: 60 / UNIT }),
  fc.integer({ min: 0, max: 800 / UNIT }),
);

/** 行盒高度（格点，恒为正）：普通文字行（含亚像素），以及标题区这类整块当作一行的高块。 */
const lineHeightArb = fc.oneof(
  fc.integer({ min: 1, max: 48 / UNIT }),
  fc.integer({ min: 1, max: 1200 / UNIT }),
);

interface TurnCase {
  lines: VerticalExtent[];
  visibleTop: number;
  visibleBottom: number;
}

/**
 * Property 23 的输入：按 `top` 升序、互不重叠的行盒序列，与一个至少和其中一行相交的可见区。
 *
 * 先随机挑一行 i，再让可见区顶端落在 `(top_i − H, bottom_i)` 内，保证 `top_i < visibleBottom`
 * 且 `bottom_i > visibleTop`。顶端一半取均匀值，一半取"某条行边恰好压在可见区顶端或底端"的
 * 格点，覆盖边缘落在行边、段间空隙里的情形。
 */
const turnCaseArb: fc.Arbitrary<TurnCase> = fc
  .record({
    start: fc.integer({ min: -3000 / UNIT, max: 3000 / UNIT }),
    boxes: fc.array(fc.record({ gap: gapArb, height: lineHeightArb }), {
      minLength: 1,
      maxLength: 40,
    }),
    height: fc.integer({ min: 1, max: 1000 / UNIT }),
  })
  .chain(({ start, boxes, height }) => {
    const units: { top: number; bottom: number }[] = [];
    let cursor = start;
    for (const box of boxes) {
      const top = cursor + box.gap;
      units.push({ top, bottom: top + box.height });
      cursor = top + box.height;
    }

    return fc.integer({ min: 0, max: units.length - 1 }).chain((i) => {
      const lo = units[i].top - height + 1;
      const hi = units[i].bottom - 1;
      const edges = units
        .flatMap(({ top, bottom }) => [top, bottom, top - height, bottom - height])
        .filter((v) => v >= lo && v <= hi);
      const uniform = fc.integer({ min: lo, max: hi });
      const topArb = edges.length ? fc.oneof(uniform, fc.constantFrom(...edges)) : uniform;

      return topArb.map((visibleTop) => ({
        lines: units.map(({ top, bottom }) => ({ top: px(top), bottom: px(bottom) })),
        visibleTop: px(visibleTop),
        visibleBottom: px(visibleTop + height),
      }));
    });
  });

describe("scrollTurnDelta", () => {
  // Feature: reader-page-turn-modes, Property 23: 滚动翻页保留一行
  // **Validates: Requirements 10.10, 10.11**
  //
  // "位于下方、未完全可见的行"取 `top > visibleTop && bottom > visibleBottom`：起点在可见区顶端
  // 之下、又没露全的行。起点在顶端或更上方、同时伸出底端的行（高于可见区的单行或标题区）只能
  // 整屏推进，它的未读部分由 `delta ≤ H` 保证不被跳过。PREV 对称。
  it("Feature: reader-page-turn-modes, Property 23: 滚动翻页保留一行——NEXT 位移在 (0, H] 内，下方没露全的行平移后不越过顶端，按行对齐时该行恰好落在顶端", () => {
    fc.assert(
      fc.property(turnCaseArb, ({ lines, visibleTop, visibleBottom }) => {
        const height = visibleBottom - visibleTop;
        const delta = scrollTurnDelta(lines, visibleTop, visibleBottom, "next");

        expect(delta).toBeGreaterThan(0);
        expect(delta).toBeLessThanOrEqual(height);

        for (const line of lines) {
          if (line.top > visibleTop && line.bottom > visibleBottom) {
            expect(line.top - delta).toBeGreaterThanOrEqual(visibleTop);
          }
        }

        // L：top < visibleBottom 的最后一行（输入升序，取过滤结果的末项）
        const before = lines.filter((line) => line.top < visibleBottom);
        const last = before[before.length - 1];
        if (last.top > visibleTop) {
          expect(last.top - delta).toBe(visibleTop);
        } else {
          expect(delta).toBe(height);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("Feature: reader-page-turn-modes, Property 23: 滚动翻页保留一行——PREV 位移在 [−H, 0) 内，上方没露全的行平移后不越过底端，按行对齐时该行恰好落在底端", () => {
    fc.assert(
      fc.property(turnCaseArb, ({ lines, visibleTop, visibleBottom }) => {
        const height = visibleBottom - visibleTop;
        const delta = scrollTurnDelta(lines, visibleTop, visibleBottom, "prev");

        expect(delta).toBeLessThan(0);
        expect(delta).toBeGreaterThanOrEqual(-height);

        for (const line of lines) {
          if (line.bottom < visibleBottom && line.top < visibleTop) {
            expect(line.bottom - delta).toBeLessThanOrEqual(visibleBottom);
          }
        }

        // F：bottom > visibleTop 的第一行
        const first = lines.find((line) => line.bottom > visibleTop) as VerticalExtent;
        if (first.bottom < visibleBottom) {
          expect(first.bottom - delta).toBe(visibleBottom);
        } else {
          expect(delta).toBe(-height);
        }
      }),
      { numRuns: 300 },
    );
  });

  /** 从 `top` 起、每行 `lineHeight`、紧贴排列的 `count` 行。 */
  function lineRun(top: number, count: number, lineHeight = 30): VerticalExtent[] {
    return Array.from({ length: count }, (_, k) => ({
      top: top + k * lineHeight,
      bottom: top + (k + 1) * lineHeight,
    }));
  }

  describe("单行高于可见区时退化为整屏", () => {
    // 可见区 [100, 500]，H = 400
    it("该行起于顶端之上、伸出底端：NEXT 为 H，PREV 为 −H", () => {
      const lines = [...lineRun(0, 2), { top: 60, bottom: 900 }, ...lineRun(900, 2)];
      expect(scrollTurnDelta(lines, 100, 500, "next")).toBe(400);
      expect(scrollTurnDelta(lines, 100, 500, "prev")).toBe(-400);
    });

    it("该行恰好起于顶端：按它对齐推不动（delta = 0），NEXT 仍前进 H", () => {
      const lines = [{ top: 100, bottom: 700 }, ...lineRun(700, 3)];
      expect(scrollTurnDelta(lines, 100, 500, "next")).toBe(400);
    });

    it("该行恰好止于底端：按它对齐拉不动（delta = 0），PREV 仍后退 H", () => {
      const lines = [...lineRun(-90, 3), { top: 0, bottom: 500 }];
      expect(scrollTurnDelta(lines, 100, 500, "prev")).toBe(-400);
    });
  });

  describe("可见区边缘落在段间空隙", () => {
    // 段 A：[0, 570)，19 行；段间空隙 [570, 610)；段 B：[610, 910)，10 行
    const lines = [...lineRun(0, 19), ...lineRun(610, 10)];

    it("底端落在空隙里：NEXT 让段 A 的末行（完整可见）成为首行，段 B 首行不越过顶端", () => {
      const delta = scrollTurnDelta(lines, 0, 600, "next");
      expect(delta).toBe(540);
      expect(610 - delta).toBeGreaterThanOrEqual(0);
    });

    it("顶端落在空隙里：PREV 让段 B 的首行（完整可见）成为末行，段 A 末行不越过底端", () => {
      const delta = scrollTurnDelta(lines, 590, 1190, "prev");
      expect(delta).toBe(640 - 1190);
      expect(570 - delta).toBeLessThanOrEqual(1190);
    });

    it("可见区整个落在比它还高的空隙里：没有可对齐的行，NEXT/PREV 都按整屏", () => {
      const sparse = [...lineRun(0, 2), ...lineRun(2000, 2)];
      expect(scrollTurnDelta(sparse, 500, 1100, "next")).toBe(600);
      expect(scrollTurnDelta(sparse, 500, 1100, "prev")).toBe(-600);
    });
  });

  describe("标题区整块当作一行", () => {
    // 上一章末尾几行，然后是下一章的标题区 [580, 760)，再接正文
    const title = { top: 580, bottom: 760 };
    const lines = [...lineRun(460, 3), title, ...lineRun(780, 10)];

    it("标题区跨过底端：NEXT 把整块标题区推到顶端，而不是按标题内部的某一行对齐", () => {
      expect(scrollTurnDelta(lines, 0, 600, "next")).toBe(title.top);
    });

    it("标题区跨过顶端：PREV 把整块标题区拉到底端，平移后标题区完整可见", () => {
      const delta = scrollTurnDelta(lines, 700, 1300, "prev");
      expect(delta).toBe(title.bottom - 1300);
      expect(title.top - delta).toBeGreaterThanOrEqual(700);
    });
  });
});

// ───────────────────────────── chapterWindow ─────────────────────────────

/** 区段高度（px，恒为正，1/8 px 格点）：只有标题的短章、普通章节、数万字的长章。 */
const sectionHeightArb = fc
  .oneof(
    fc.integer({ min: 1, max: 300 / UNIT }),
    fc.integer({ min: 1, max: 20_000 / UNIT }),
    fc.integer({ min: 1, max: 400_000 / UNIT }),
  )
  .map(px);

/** 脏高度：尚未测量（`NaN`、`±Infinity`）、负数与 `-0`，混在正常高度里。 */
const dirtyHeightArb = fc.oneof(
  { arbitrary: sectionHeightArb, weight: 3 },
  { arbitrary: fc.constantFrom(NaN, Infinity, -Infinity, -0), weight: 1 },
  { arbitrary: fc.integer({ min: -400_000 / UNIT, max: -1 }).map(px), weight: 1 },
);

/** `chapterWindow` 对高度的口径：非有限或非正一律按 0。 */
const cleanPx = (h: number) => (Number.isFinite(h) && h > 0 ? h : 0);

interface WindowCase {
  total: number;
  anchor: number;
  /** 循环取用：第 p 章的高度为 `heights[p % heights.length]`。 */
  heights: number[];
  viewportHeight: number;
}

/**
 * 高度函数：只在 `[0, total)` 的整数上有定义（调用方实际按正文序号查表），越界即抛错。
 * 高度表循环取用，`total` 很大时也不必生成同样长的数组。
 */
function heightsFn(heights: readonly number[], total: number): (position: number) => number {
  return (position) => {
    if (!Number.isInteger(position) || position < 0 || position >= total) {
      throw new RangeError(`heightOf(${position}) 越出 [0, ${total})`);
    }
    return heights[position % heights.length];
  };
}

/** `[from, to]` 各章高度之和（按 `cleanPx` 口径）；`from > to` 时为 0。 */
function span(heightOf: (position: number) => number, from: number, to: number): number {
  let sum = 0;
  for (let p = from; p <= to; p++) sum += cleanPx(heightOf(p));
  return sum;
}

/**
 * Property 20 的输入。总章数从个位数到十万章（检验上限与总章数无关）；锚点一半均匀、一半取
 * 书首书尾附近。视口高度一半均匀（含比所有章都高的超大视口），一半取"锚点下方前 k 章恰好 2 屏、
 * 上方前 k 章恰好 1 屏"的值，覆盖累计高度恰好等于阈值的边界。高度都在 1/8 px 格点上，七章以内的
 * 累加不舍入，阈值比较按原值成立。
 */
function windowCaseOf(heightArb: fc.Arbitrary<number>): fc.Arbitrary<WindowCase> {
  return fc
    .record({
      total: fc.oneof(
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 300 }),
        fc.integer({ min: 1, max: 100_000 }),
      ),
      heights: fc.array(heightArb, { minLength: 1, maxLength: 16 }),
    })
    .chain(({ total, heights }) => {
      const nearEdges = [0, 1, total - 2, total - 1].filter((a) => a >= 0 && a < total);
      const anchorArb = fc.oneof(fc.integer({ min: 0, max: total - 1 }), fc.constantFrom(...nearEdges));

      return anchorArb.chain((anchor) => {
        const h = (p: number) => cleanPx(heights[p % heights.length]);
        const edges: number[] = [];
        let below = 0;
        for (let k = 1; k < MAX_MOUNTED_CHAPTERS && anchor + k < total; k++) {
          below += h(anchor + k);
          edges.push(below / OVERSCAN_BELOW_SCREENS);
        }
        let above = 0;
        for (let k = 1; k < MAX_MOUNTED_CHAPTERS && anchor - k >= 0; k++) {
          above += h(anchor - k);
          edges.push(above / OVERSCAN_ABOVE_SCREENS);
        }
        const positiveEdges = edges.filter((v) => v > 0);

        const uniform = fc
          .oneof(fc.integer({ min: 1, max: 2_000 / UNIT }), fc.integer({ min: 1, max: 200_000 / UNIT }))
          .map(px);
        const viewportArb = positiveEdges.length
          ? fc.oneof(uniform, fc.constantFrom(...positiveEdges))
          : uniform;

        return viewportArb.map((viewportHeight) => ({ total, anchor, heights, viewportHeight }));
      });
    });
}

const windowCaseArb = windowCaseOf(sectionHeightArb);

/** Property 20 的三条：区间合法、不超过上限、锚章两侧的相邻章恒在窗口内。 */
function expectWindowShape({ lo, hi }: ChapterWindow, anchor: number, total: number) {
  expect(Number.isInteger(lo) && Number.isInteger(hi)).toBe(true);
  expect(lo).toBeGreaterThanOrEqual(0);
  expect(lo).toBeLessThanOrEqual(anchor);
  expect(hi).toBeGreaterThanOrEqual(anchor);
  expect(hi).toBeLessThan(total);
  expect(hi - lo + 1).toBeLessThanOrEqual(MAX_MOUNTED_CHAPTERS);
  if (anchor > 0) expect(lo).toBeLessThanOrEqual(anchor - 1);
  if (anchor < total - 1) expect(hi).toBeGreaterThanOrEqual(anchor + 1);
}

describe("chapterWindow", () => {
  // Feature: reader-page-turn-modes, Property 20: 章节挂载窗口
  // **Validates: Requirements 10.2, 10.7**
  it("Feature: reader-page-turn-modes, Property 20: 章节挂载窗口——0 ≤ lo ≤ anchor ≤ hi < total、至多 7 章、anchor ± 1 恒在窗口内，且结果是锚点与高度的确定性函数", () => {
    fc.assert(
      fc.property(windowCaseArb, ({ total, anchor, heights, viewportHeight }) => {
        const input = { anchor, total, heightOf: heightsFn(heights, total), viewportHeight };
        const win = chapterWindow(input);

        expectWindowShape(win, anchor, total);

        // 同一输入再算一次、换一个取值相同的新高度函数再算一次，结果都不变
        expect(chapterWindow(input)).toEqual(win);
        expect(chapterWindow({ ...input, heightOf: heightsFn([...heights], total) })).toEqual(win);
      }),
      { numRuns: 300 },
    );
  });

  it("Feature: reader-page-turn-modes, Property 20: 章节挂载窗口——锚章之后挂够 2 屏、之前挂够 1 屏（到书首书尾或满 7 章为止），不多挂，名额不足时先给下方", () => {
    fc.assert(
      fc.property(windowCaseArb, ({ total, anchor, heights, viewportHeight }) => {
        const heightOf = heightsFn(heights, total);
        const { lo, hi } = chapterWindow({ anchor, total, heightOf, viewportHeight });
        const full = hi - lo + 1 === MAX_MOUNTED_CHAPTERS;
        const belowNeed = OVERSCAN_BELOW_SCREENS * viewportHeight;
        const aboveNeed = OVERSCAN_ABOVE_SCREENS * viewportHeight;
        const below = span(heightOf, anchor + 1, hi);
        const above = span(heightOf, lo, anchor - 1);

        // 挂够：锚章自身不计入
        expect(below >= belowNeed || hi === total - 1 || full, "锚章之后不足 2 屏").toBe(true);
        expect(above >= aboveNeed || lo === 0 || full, "锚章之前不足 1 屏").toBe(true);

        // 不多挂：anchor ± 1 之外的每一章，都是纳入它之前还差着阈值的那一章
        if (hi > anchor + 1) expect(span(heightOf, anchor + 1, hi - 1)).toBeLessThan(belowNeed);
        if (lo < anchor - 1) expect(span(heightOf, lo + 1, anchor - 1)).toBeLessThan(aboveNeed);

        // 先向下扩：下方没挂够又没到书尾，名额就是向下时用完的，上方只剩 anchor − 1
        if (below < belowNeed && hi < total - 1) expect(lo).toBe(Math.max(0, anchor - 1));
      }),
      { numRuns: 300 },
    );
  });

  it("Feature: reader-page-turn-modes, Property 20: 章节挂载窗口——锚点越界或非整数时夹进 [0, total)，非有限锚点仍得到合法窗口", () => {
    const caseArb = windowCaseArb.chain((c) =>
      fc
        .oneof(
          fc.double({ min: -3, max: 3, noNaN: true }),
          fc.double({ min: c.total - 3, max: c.total + 3, noNaN: true }),
          fc.integer({ min: -1_000_000, max: 1_000_000 }),
        )
        .map((raw) => ({ ...c, raw })),
    );

    fc.assert(
      fc.property(caseArb, ({ total, heights, viewportHeight, raw }) => {
        const heightOf = heightsFn(heights, total);
        const clamped = Math.min(total - 1, Math.max(0, Math.floor(raw)));
        const win = chapterWindow({ anchor: raw, total, heightOf, viewportHeight });

        expect(win).toEqual(chapterWindow({ anchor: clamped, total, heightOf, viewportHeight }));
        expectWindowShape(win, clamped, total);

        for (const bad of [NaN, Infinity, -Infinity]) {
          const { lo, hi } = chapterWindow({ anchor: bad, total, heightOf, viewportHeight });
          expect(lo).toBeGreaterThanOrEqual(0);
          expect(hi).toBeGreaterThanOrEqual(lo);
          expect(hi).toBeLessThan(total);
          expect(hi - lo + 1).toBeLessThanOrEqual(MAX_MOUNTED_CHAPTERS);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("Feature: reader-page-turn-modes, Property 20: 章节挂载窗口——脏高度（负数、NaN、±Infinity）按 0 计，窗口仍合法", () => {
    fc.assert(
      fc.property(windowCaseOf(dirtyHeightArb), ({ total, anchor, heights, viewportHeight }) => {
        const win = chapterWindow({ anchor, total, heightOf: heightsFn(heights, total), viewportHeight });

        expectWindowShape(win, anchor, total);
        expect(win).toEqual(
          chapterWindow({ anchor, total, heightOf: heightsFn(heights.map(cleanPx), total), viewportHeight }),
        );
      }),
      { numRuns: 200 },
    );
  });

  it("Feature: reader-page-turn-modes, Property 20: 章节挂载窗口——total < 1（或为 NaN）时返回空区间 { lo: 0, hi: −1 }", () => {
    const totalArb = fc.oneof(
      fc.integer({ min: -1_000_000, max: 0 }),
      fc.double({ min: -1_000_000, max: 1, maxExcluded: true, noNaN: true }),
      fc.constantFrom(NaN, -Infinity),
    );
    const anchorArb = fc.oneof(fc.integer(), fc.double());

    fc.assert(
      fc.property(totalArb, anchorArb, sectionHeightArb, (total, anchor, viewportHeight) => {
        expect(chapterWindow({ anchor, total, heightOf: () => 100, viewportHeight })).toEqual({
          lo: 0,
          hi: -1,
        });
      }),
      { numRuns: 100 },
    );
  });

  // 需求 10.2：书首书尾一侧无章可挂时，窗口贴着边界收住，名额让给另一侧，仍不超过 7 章。
  // 高度函数越界即抛错（`heightsFn`），所以这些例子同时确认了不会查询 [0, total) 之外的章。
  describe("书首与书尾", () => {
    const TOTAL = 50;
    const VIEWPORT = 800;
    /** 每章等高：1000px 的常规章一章就超过 1 屏，100px 的短章挂满 7 章也凑不够 2 屏。 */
    const windowOf = (anchor: number, height: number, total = TOTAL) =>
      chapterWindow({ anchor, total, heightOf: heightsFn([height], total), viewportHeight: VIEWPORT });

    it("锚定第一章：lo = 0，上方无章可挂，下方挂够 2 屏即止", () => {
      // 下方 1000 + 1000 ≥ 2 × 800
      expect(windowOf(0, 1000)).toEqual({ lo: 0, hi: 2 });
    });

    it("锚定第一章、各章都很短：7 个名额全给下方", () => {
      expect(windowOf(0, 100)).toEqual({ lo: 0, hi: MAX_MOUNTED_CHAPTERS - 1 });
    });

    it("锚定第二章：上方只有第一章，不足 1 屏也停在 lo = 0，余下名额给下方", () => {
      expect(windowOf(1, 100)).toEqual({ lo: 0, hi: MAX_MOUNTED_CHAPTERS - 1 });
    });

    it("锚定末章：hi = total − 1，下方无章可挂，上方挂够 1 屏即止", () => {
      // 上方 1000 ≥ 1 × 800
      expect(windowOf(TOTAL - 1, 1000)).toEqual({ lo: TOTAL - 2, hi: TOTAL - 1 });
    });

    it("锚定末章、各章都很短：7 个名额全给上方", () => {
      expect(windowOf(TOTAL - 1, 100)).toEqual({ lo: TOTAL - MAX_MOUNTED_CHAPTERS, hi: TOTAL - 1 });
    });

    it("锚定倒数第二章：下方只有末章，不足 2 屏也停在 hi = total − 1，余下名额给上方", () => {
      expect(windowOf(TOTAL - 2, 100)).toEqual({ lo: TOTAL - MAX_MOUNTED_CHAPTERS, hi: TOTAL - 1 });
    });

    it("全书不足 7 章且都很短：无论锚定哪章，都同时贴住书首与书尾", () => {
      for (const anchor of [0, 1, 2]) expect(windowOf(anchor, 100, 3)).toEqual({ lo: 0, hi: 2 });
    });

    it("全书只有一章：窗口就是这一章", () => {
      expect(windowOf(0, 1000, 1)).toEqual({ lo: 0, hi: 0 });
    });
  });
});

// ───────────────────────────── locateAt ─────────────────────────────

interface LocateCase {
  sectionTops: number[];
  /** 与 `sectionTops` 对齐：第 s 个区段内各段的顶边。 */
  paraTops: number[][];
  y: number;
}

/**
 * 贴近真实版式的顶边表（滚动容器内容坐标，1/8 px 格点）：区段首尾相接，每个区段先是标题区
 * （含 `pt-16`），再是若干段落，最后是 `pb-8`。标题区、段高、尾部都可以为 0，所以会出现
 * 空正文的区段、相等的段顶，以及与下一个区段顶边重合的区段（相等的区段顶边）。
 */
const layoutTablesArb = fc
  .record({
    start: fc.integer({ min: -2000 / UNIT, max: 2000 / UNIT }),
    sections: fc.array(
      fc.record({
        header: fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 300 / UNIT })),
        paras: fc.array(fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 600 / UNIT })), {
          maxLength: 12,
        }),
        tail: fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 200 / UNIT })),
      }),
      { minLength: 1, maxLength: MAX_MOUNTED_CHAPTERS },
    ),
  })
  .map(({ start, sections }) => {
    const sectionTops: number[] = [];
    const paraTops: number[][] = [];
    let cursor = start;
    for (const { header, paras, tail } of sections) {
      sectionTops.push(px(cursor));
      let top = cursor + header;
      const tops: number[] = [];
      for (const height of paras) {
        tops.push(px(top));
        top += height;
      }
      paraTops.push(tops);
      cursor = top + tail;
    }
    return { sectionTops, paraTops };
  });

/** 任意升序表：随机格点排序而成。取值范围有宽有窄，窄的那档会大量出现相等元素。 */
function sortedTopsArb(minLength: number): fc.Arbitrary<number[]> {
  return fc
    .oneof(
      fc.array(fc.integer({ min: -4, max: 4 }), { minLength, maxLength: 12 }),
      fc.array(fc.integer({ min: -4000 / UNIT, max: 4000 / UNIT }), { minLength, maxLength: 12 }),
    )
    .map((values) => [...values].sort((a, b) => a - b).map(px));
}

/** 与真实版式无关的顶边表：段顶可以在区段顶边之上，也可以越过下一个区段。 */
const freeTablesArb = sortedTopsArb(1).chain((sectionTops) =>
  fc
    .array(sortedTopsArb(0), { minLength: sectionTops.length, maxLength: sectionTops.length })
    .map((paraTops) => ({ sectionTops, paraTops })),
);

/**
 * Property 21 的输入。判定线一半取均匀值（含表的上下方之外），一半取某条顶边本身或其 ±1/8 px，
 * 覆盖"判定线恰好压在顶边上"的边界；另以小概率取 `±Infinity` 与 `NaN`。
 */
const locateCaseArb: fc.Arbitrary<LocateCase> = fc
  .oneof(layoutTablesArb, freeTablesArb)
  .chain(({ sectionTops, paraTops }) => {
    const tops = [...sectionTops, ...paraTops.flat()];
    const lo = Math.min(...tops) / UNIT - 800;
    const hi = Math.max(...tops) / UNIT + 800;
    const edges = tops.flatMap((top) => [top - UNIT, top, top + UNIT]);

    const yArb = fc.oneof(
      { arbitrary: fc.integer({ min: lo, max: hi }).map(px), weight: 5 },
      { arbitrary: fc.constantFrom(...edges), weight: 5 },
      { arbitrary: fc.constantFrom(-Infinity, Infinity, NaN), weight: 1 },
    );
    return yArb.map((y) => ({ sectionTops, paraTops, y }));
  });

/** 参照实现：`tops` 中 `top ≤ y` 的最后一个下标，没有时为 −1。线性扫描，不依赖有序。 */
function lastAtOrBelow(tops: readonly number[], y: number): number {
  let found = -1;
  tops.forEach((top, i) => {
    if (top <= y) found = i;
  });
  return found;
}

describe("locateAt", () => {
  // Feature: reader-page-turn-modes, Property 21: 判定线定位
  // **Validates: Requirements 10.4, 10.6**
  it("Feature: reader-page-turn-modes, Property 21: 判定线定位——区段为 sectionTops[s] ≤ y 的最后一个（y 在首个区段之上时取首个），段落为该区段内 paraTop ≤ y 的最后一段（没有时为 0）", () => {
    fc.assert(
      fc.property(locateCaseArb, ({ sectionTops, paraTops, y }) => {
        const queried: number[] = [];
        const paraTopsOf = (section: number) => {
          queried.push(section);
          if (!Number.isInteger(section) || section < 0 || section >= paraTops.length) {
            throw new RangeError(`paraTopsOf(${section}) 越出 [0, ${paraTops.length})`);
          }
          return paraTops[section];
        };

        const { section, para } = locateAt(sectionTops, paraTopsOf, y);

        // 区段
        expect(Number.isInteger(section)).toBe(true);
        expect(section).toBeGreaterThanOrEqual(0);
        expect(section).toBeLessThan(sectionTops.length);
        if (y >= sectionTops[0]) {
          expect(sectionTops[section]).toBeLessThanOrEqual(y);
          if (section + 1 < sectionTops.length) expect(sectionTops[section + 1]).toBeGreaterThan(y);
        } else {
          expect(section).toBe(0);
        }
        expect(section).toBe(Math.max(0, lastAtOrBelow(sectionTops, y)));

        // 段落：只在判出的区段里找
        const tops = paraTops[section];
        const expected = lastAtOrBelow(tops, y);
        if (expected >= 0) {
          expect(tops[para]).toBeLessThanOrEqual(y);
          if (para + 1 < tops.length) expect(tops[para + 1]).toBeGreaterThan(y);
        }
        expect(para).toBe(Math.max(0, expected));

        // 只查询判出的那个区段的段落表
        expect(queried.every((s) => s === section)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});

// ───────────────────────────── scrollPositionStep ─────────────────────────────

const pinArb = fc.constant<ScrollPosEvent>({ kind: "pin" });
const userInputArb = fc.constant<ScrollPosEvent>({ kind: "user-input" });

/** rAF 由判定线算出的位置：章号与偏移任取，含 0 与很大的值（归约器不看取值）。 */
const derivedArb: fc.Arbitrary<ScrollPosEvent> = fc.record({
  kind: fc.constant("derived" as const),
  chapterId: fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 100_000 })),
  charOffset: fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 10_000_000 })),
});

/** 任意事件序列：`derived` 占多数（滚动时每帧一个），控制事件穿插其间，也会连发。 */
const scrollPosEventsArb = fc.array(
  fc.oneof(
    { arbitrary: derivedArb, weight: 4 },
    { arbitrary: pinArb, weight: 1 },
    { arbitrary: userInputArb, weight: 1 },
  ),
  { maxLength: 60 },
);

/** 从 `initial` 起依次喂入 `events`，记下每一步的输出。 */
function runScrollPos(initial: ScrollPosState, events: readonly ScrollPosEvent[]) {
  let state = initial;
  return events.map((event) => {
    const before = state;
    const out = scrollPositionStep(state, event);
    state = out.state;
    return { event, before, ...out };
  });
}

describe("scrollPositionStep", () => {
  // Feature: reader-page-turn-modes, Property 6: 程序化定位不改变阅读位置
  // **Validates: Requirements 1.7, 10.6**
  //
  // 第一条对应"导航定位、窗口挂卸补偿、重排补偿产生的 scroll 事件都不改动位置"：以 `pin` 开头、
  // 不含 `user-input` 的序列里，`derived` 再多也一个不报。初始状态任取，`pin` 前读者是否操作过都不影响。
  it("Feature: reader-page-turn-modes, Property 6: 程序化定位不改变阅读位置——以 pin 开头、不含 user-input 的序列里，没有任何事件给出 report = true", () => {
    const pinnedOnlyArb = fc.array(
      fc.oneof({ arbitrary: derivedArb, weight: 4 }, { arbitrary: pinArb, weight: 1 }),
      { maxLength: 60 },
    );

    fc.assert(
      fc.property(fc.boolean(), pinnedOnlyArb, (pinned, rest) => {
        const steps = runScrollPos({ pinned }, [{ kind: "pin" }, ...rest]);

        for (const step of steps) {
          expect(step.report, `${step.event.kind} 不应上报`).toBe(false);
          expect(step.state.pinned).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });

  // 第二条对应"读者一旦滚动，位置就严格等于判定线处段落的偏移"：任意序列中，每个 `derived` 是否上报
  // 只取决于它之前最近的一个控制事件——是 `user-input` 则报，是 `pin` 则不报，都没有时看初始状态。
  // `pin` 与 `user-input` 自身从不上报；`derived` 不改变状态。
  it("Feature: reader-page-turn-modes, Property 6: 程序化定位不改变阅读位置——user-input 之后、下一次 pin 之前的每个 derived 都给出 report = true", () => {
    fc.assert(
      fc.property(fc.boolean(), scrollPosEventsArb, (pinned, events) => {
        const steps = runScrollPos({ pinned }, events);

        steps.forEach((step, i) => {
          if (step.event.kind !== "derived") {
            expect(step.report, `${step.event.kind} 自身不应上报`).toBe(false);
            expect(step.state.pinned).toBe(step.event.kind === "pin");
            return;
          }

          let lastControl: ScrollPosEvent["kind"] | null = null;
          for (let j = i - 1; j >= 0 && lastControl === null; j--) {
            if (events[j].kind !== "derived") lastControl = events[j].kind;
          }
          const expected = lastControl === null ? !pinned : lastControl === "user-input";

          expect(step.report).toBe(expected);
          expect(step.state).toBe(step.before);
        });
      }),
      { numRuns: 300 },
    );
  });

  it("切到滚动模式后的补偿滚动不上报，读者第一次滚动起逐帧上报，再次导航后又停止上报", () => {
    const derived = (charOffset: number): ScrollPosEvent => ({ kind: "derived", chapterId: 12, charOffset });
    const steps = runScrollPos({ pinned: false }, [
      { kind: "pin" }, // 导航指令落地：阅读位置 480 在段中，该段（段首 450）置于判定线
      derived(450), // 窗口挂载补偿：若上报，位置会被改写成段首 450
      derived(450), // 字体就绪后的重排补偿
      { kind: "user-input" }, // 读者滚动
      derived(450),
      derived(1020),
      { kind: "pin" }, // 目录跳章
      derived(0),
    ]);

    expect(steps.map((s) => s.report)).toEqual([false, false, false, false, true, true, false, false]);
  });
});

// ───────────────────────────── anchorAt / anchoredScrollTop ─────────────────────────────

describe("anchorAt / anchoredScrollTop：几何变化后的锚点补偿（需求 10.3）", () => {
  /**
   * 窗口里三章：章号 4（三段）、5（只有标题）、7（两段）。区段顶边 0 / 1000 / 1800，
   * 判定线为 `scrollTop + TOP_BIAS`。
   */
  const GEOMETRY: ScrollGeometry = {
    chapterIds: [4, 5, 7],
    sectionTops: [0, 1000, 1800],
    sectionHeights: [1000, 800, 600],
    paraTops: [[150, 300, 600], [], [1950, 2100]],
  };

  /** 每个区段的几何整体平移 `dy`（挂卸上方章节时窗口内其余章的样子）。 */
  const shift = (g: ScrollGeometry, dy: number): ScrollGeometry => ({
    ...g,
    sectionTops: g.sectionTops.map((t) => t + dy),
    paraTops: g.paraTops.map((tops) => tops.map((t) => t + dy)),
  });

  it("判定线与 ReaderPage 原内联渲染相同，取顶栏高度 56px", () => {
    expect(TOP_BIAS).toBe(56);
  });

  it("锚定判定线处的段落，delta 为其顶边到容器顶边的距离", () => {
    // 判定线 256 落在第 0 段（150 ≤ 256 < 300）
    expect(anchorAt(GEOMETRY, 200)).toEqual({ chapterId: 4, para: 0, delta: -50 });
    // 判定线恰好压在段顶上时取那一段
    expect(anchorAt(GEOMETRY, 300 - TOP_BIAS)).toEqual({ chapterId: 4, para: 1, delta: TOP_BIAS });
  });

  it("判定线落在标题区里时锚定首段（在判定线之下），只有标题的章锚定区段顶边", () => {
    // 判定线 1856 在第 7 章标题区：首段 1950 还在线下
    expect(anchorAt(GEOMETRY, 1800)).toEqual({ chapterId: 7, para: 0, delta: 150 });
    // 第 5 章没有正文段
    expect(anchorAt(GEOMETRY, 1100)).toEqual({ chapterId: 5, para: -1, delta: -100 });
  });

  it("几何为空或 scrollTop 非有限时没有锚点", () => {
    expect(anchorAt(EMPTY_SCROLL_GEOMETRY, 0)).toBeNull();
    expect(anchorAt(GEOMETRY, Number.NaN)).toBeNull();
    expect(anchorAt(GEOMETRY, Infinity)).toBeNull();
  });

  it("几何不变时与 anchorAt 互逆：补偿位移为 0", () => {
    for (const scrollTop of [0, 37.25, 200, 244, 1100, 1799.5, 2500]) {
      const anchor = anchorAt(GEOMETRY, scrollTop);
      expect(anchor).not.toBeNull();
      expect(anchoredScrollTop(GEOMETRY, anchor!)).toBeCloseTo(scrollTop, 9);
    }
  });

  it("上方挂上一章：scrollTop 加上新章高度，锚定段的屏幕位置不变", () => {
    const anchor = anchorAt(GEOMETRY, 200)!;
    // 窗口前面多了章号 3（高 2400.5px）
    const below = shift(GEOMETRY, 2400.5);
    const mounted: ScrollGeometry = {
      chapterIds: [3, ...below.chapterIds],
      sectionTops: [0, ...below.sectionTops],
      sectionHeights: [2400.5, ...below.sectionHeights],
      paraTops: [[100, 200], ...below.paraTops],
    };
    const top = anchoredScrollTop(mounted, anchor)!;
    expect(top).toBe(2600.5);
    // 屏幕位置 = 段顶 − scrollTop，补偿前后相同；在新几何下重取锚点得到同一个锚点
    expect(mounted.paraTops[1][0] - top).toBe(GEOMETRY.paraTops[0][0] - 200);
    expect(anchorAt(mounted, top)).toEqual(anchor);
  });

  it("上方卸下一章：scrollTop 减去该章高度", () => {
    const anchor = anchorAt(GEOMETRY, 1800)!;
    const unmounted: ScrollGeometry = {
      chapterIds: [5, 7],
      sectionTops: [0, 800],
      sectionHeights: [800, 600],
      paraTops: [[], [950, 1100]],
    };
    expect(anchoredScrollTop(unmounted, anchor)).toBe(800);
  });

  it("锚定章内重排（改字号）：跟随锚定段的新顶边", () => {
    const anchor = anchorAt(GEOMETRY, 300)!; // 判定线 356 → 第 1 段，delta 0
    const reflowed: ScrollGeometry = {
      ...GEOMETRY,
      sectionHeights: [1100, 800, 600],
      paraTops: [[160, 330, 660], [], [2050, 2200]],
      sectionTops: [0, 1100, 1900],
    };
    expect(anchoredScrollTop(reflowed, anchor)).toBe(330);
  });

  it("锚定章已离开窗口、段落下标不存在或 delta 非有限时返回 null（调用方改为重新取锚）", () => {
    expect(anchoredScrollTop(GEOMETRY, { chapterId: 9, para: 0, delta: 0 })).toBeNull();
    expect(anchoredScrollTop(GEOMETRY, { chapterId: 4, para: 3, delta: 0 })).toBeNull();
    expect(anchoredScrollTop(GEOMETRY, { chapterId: 4, para: 0, delta: Number.NaN })).toBeNull();
    expect(anchoredScrollTop(EMPTY_SCROLL_GEOMETRY, { chapterId: 4, para: 0, delta: 0 })).toBeNull();
  });
});

// ───────────────────────────── flingAt / estimateVelocity ─────────────────────────────

/**
 * 速度格点：1/1024 px/s。避开次正规数这类极小速度：那时上界 `|v0|·τ` 本身会舍入成 0，
 * "严格小于上界"就无从谈起，而真实的指针速度不会落在那里。
 */
const SPEED_UNIT = 1 / 1024;
const speedArb = (max: number) =>
  fc.integer({ min: -max / SPEED_UNIT, max: max / SPEED_UNIT }).map((n) => n * SPEED_UNIT);

/** 释放速度（px/s）：0 与 −0、恰为停止阈值、阈值附近、常见的拖拽速度，以及远超常见的甩动速度。 */
const flingSpeedArb = fc.oneof(
  fc.constantFrom(0, -0, FLING_MIN_SPEED, -FLING_MIN_SPEED),
  speedArb(2 * FLING_MIN_SPEED),
  speedArb(20_000),
  speedArb(1_000_000),
);

/** 速度按模型降到阈值的时刻（ms）：`τ·ln(|v0| / FLING_MIN_SPEED)`；`|v0|` 不超过阈值时为 0。 */
function stopTime(v0: number): number {
  const speed = Math.abs(v0);
  return speed > FLING_MIN_SPEED ? FLING_TAU_MS * Math.log(speed / FLING_MIN_SPEED) : 0;
}

/**
 * Property 22 的输入：释放速度与两个时刻 `0 ≤ t1 ≤ t2`（ms）。时刻一部分均匀取在 10 秒内，一部分
 * 贴着停止时刻的 ±5ms（跨过 `done` 翻转的那一帧），一部分取在很久以后（`e^(−t/τ)` 下溢成 0）。
 */
const flingCaseArb = flingSpeedArb.chain((v0) => {
  const stop = stopTime(v0);
  const timeArb = fc.oneof(
    fc.double({ min: 0, max: 10_000, noNaN: true }),
    fc.double({ min: Math.max(0, stop - 5), max: stop + 5, noNaN: true }),
    fc.double({ min: 10_000, max: 1e9, noNaN: true }),
  );
  return fc
    .tuple(timeArb, timeArb)
    .map(([a, b]) => ({ v0, t1: Math.min(a, b), t2: Math.max(a, b) }));
});

/** 时刻格点：1/16 ms。`performance.now()` 带小数，取二进制能精确表示的格点，时间窗边界的比较按原值成立。 */
const TIME_UNIT = 1 / 16;

interface UniformCase {
  /** 匀速运动的速度（px/s）。 */
  v: number;
  /** 打乱顺序的采样（`estimateVelocity` 不要求有序）。 */
  samples: MotionSample[];
  now: number;
}

/**
 * 匀速样本：`y = y0 + v·(t − t0)`。相邻采样间隔从 1/16ms 到 40ms（1000Hz 的 `pointermove` 到
 * 掉帧），采样总跨度可以远超时间窗，窗外的采样同样在这条直线上。释放时刻 `now` 取在最后一个
 * 采样之后，但保证最后两个采样仍在时间窗 `[now − 100, now]` 内。
 */
const uniformCaseArb: fc.Arbitrary<UniformCase> = fc
  .record({
    v: fc.oneof(fc.constant(0), speedArb(20_000)),
    y0: fc.integer({ min: -100_000 / UNIT, max: 100_000 / UNIT }).map(px),
    t0: fc.integer({ min: 0, max: 10_000_000 / TIME_UNIT }).map((n) => n * TIME_UNIT),
    intervals: fc.array(fc.integer({ min: 1, max: 40 / TIME_UNIT }), { minLength: 1, maxLength: 30 }),
  })
  .chain(({ v, y0, t0, intervals }) => {
    const times = [t0];
    for (const n of intervals) times.push(times[times.length - 1] + n * TIME_UNIT);
    const samples = times.map((t) => ({ y: y0 + (v * (t - t0)) / 1000, t }));

    const lastT = times[times.length - 1];
    const lastGap = intervals[intervals.length - 1] * TIME_UNIT;
    const nowArb = fc
      .integer({ min: 0, max: (VELOCITY_WINDOW_MS - lastGap) / TIME_UNIT })
      .map((n) => lastT + n * TIME_UNIT);

    return fc
      .tuple(nowArb, fc.shuffledSubarray(samples, { minLength: samples.length }))
      .map(([now, shuffled]) => ({ v, samples: shuffled, now }));
  });

describe("flingAt / estimateVelocity", () => {
  // Feature: reader-page-turn-modes, Property 22: 惯性减速至停
  // **Validates: Requirements 10.9**
  //
  // 设计稿里的 `|offset| < |v0|·τ` 中 `v0` 以 px/s、`τ` 以 ms 计，按位移（px）比较时换成 `|v0|·τ / 1000`。
  it("Feature: reader-page-turn-modes, Property 22: 惯性减速至停——|velocity| 随 t 单调不增，offset 与 v0 同号、|offset| 单调不减且严格小于 |v0|·τ，停下后不再移动", () => {
    fc.assert(
      fc.property(flingCaseArb, ({ v0, t1, t2 }) => {
        const a = flingAt(v0, t1);
        const b = flingAt(v0, t2);
        const bound = Math.abs(v0) * (FLING_TAU_MS / 1000);

        // 速度：单调不增，方向与 v0 一致；没停时不低于阈值
        expect(Math.abs(b.velocity)).toBeLessThanOrEqual(Math.abs(a.velocity));
        for (const s of [a, b]) {
          expect(Number.isFinite(s.offset) && Number.isFinite(s.velocity)).toBe(true);
          expect([0, Math.sign(v0)]).toContain(Math.sign(s.velocity));
          if (!s.done) expect(Math.abs(s.velocity)).toBeGreaterThanOrEqual(FLING_MIN_SPEED);

          // 位移：与 v0 同号，有界
          expect([0, Math.sign(v0)]).toContain(Math.sign(s.offset));
          if (v0 !== 0) expect(Math.abs(s.offset)).toBeLessThan(bound);
        }

        // 位移只朝 v0 的方向累积，不回退
        expect(Math.abs(b.offset)).toBeGreaterThanOrEqual(Math.abs(a.offset));

        // 停下就一直停着，位移钉住
        if (a.done) {
          expect(b.done).toBe(true);
          expect(b.velocity).toBe(0);
          expect(b.offset).toBe(a.offset);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("Feature: reader-page-turn-modes, Property 22: 惯性减速至停——以 v0 为初速度出发，并在有限时刻 τ·ln(|v0| / 阈值) 之后停下", () => {
    fc.assert(
      fc.property(flingSpeedArb, fc.double({ min: 0, max: 1e6, noNaN: true }), (v0, later) => {
        // 释放那一刻：速度就是 v0（不足阈值时直接停下），尚未移动
        const start = flingAt(v0, 0);
        expect(start.offset).toBe(0);
        if (Math.abs(v0) >= FLING_MIN_SPEED) {
          expect(start.done).toBe(false);
          expect(start.velocity).toBe(v0);
        } else {
          expect(start.done).toBe(true);
        }

        // 停止时刻之后 1ms：速度已低于阈值
        const t = stopTime(v0) + 1;
        expect(Number.isFinite(t)).toBe(true);
        const stopped = flingAt(v0, t);
        expect(stopped.done).toBe(true);
        expect(stopped.velocity).toBe(0);
        expect(flingAt(v0, t + later)).toEqual(stopped);
      }),
      { numRuns: 300 },
    );
  });

  it("Feature: reader-page-turn-modes, Property 22: 惯性减速至停——v0 = 0 时位移恒为 0", () => {
    const timeArb = fc.oneof(
      fc.double({ min: 0, max: 10_000, noNaN: true }),
      fc.double({ min: 10_000, max: 1e9, noNaN: true }),
    );

    fc.assert(
      fc.property(fc.constantFrom(0, -0), timeArb, (v0, t) => {
        const s = flingAt(v0, t);
        // `toBe` 按 Object.is 比较：-0 也不行
        expect(s.offset).toBe(0);
        expect(s.velocity).toBe(0);
        expect(s.done).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it("Feature: reader-page-turn-modes, Property 22: 惯性减速至停——estimateVelocity 对匀速样本返回该速度（窗外有采样、采样乱序也一样）", () => {
    fc.assert(
      fc.property(uniformCaseArb, ({ v, samples, now }) => {
        const estimated = estimateVelocity(samples, now);

        // 采样坐标 `y0 + v·Δt` 有舍入，按相对误差比较；最短的采样间隔 1/16ms 会把舍入放大约 1.6 万倍
        expect(Number.isFinite(estimated)).toBe(true);
        expect(Math.abs(estimated - v)).toBeLessThanOrEqual(1e-5 * Math.max(1, Math.abs(v)));
      }),
      { numRuns: 300 },
    );
  });

  // 需求 10.9：时间窗 [now − 100, now] 内不足两个可用采样时速度为 0，松手后不产生惯性。
  // `toBe(0)` 按 Object.is 比较，-0 也不算通过。
  describe("estimateVelocity：时间窗内不足两个采样时为 0", () => {
    const NOW = 10_000;

    it("没有采样", () => {
      expect(estimateVelocity([], NOW)).toBe(0);
    });

    it("只有一个采样", () => {
      expect(estimateVelocity([{ y: 120, t: NOW - 16 }], NOW)).toBe(0);
    });

    it("较早的采样已在时间窗之外（指针停住超过 100ms 才松手），窗内只剩一个", () => {
      const samples = [
        { y: 0, t: NOW - VELOCITY_WINDOW_MS - 1 },
        { y: 300, t: NOW - 50 },
      ];
      expect(estimateVelocity(samples, NOW)).toBe(0);
    });

    it("晚于 now 的采样不计入，窗内只剩一个", () => {
      const samples = [
        { y: 0, t: NOW - 50 },
        { y: 300, t: NOW + 1 },
      ];
      expect(estimateVelocity(samples, NOW)).toBe(0);
    });

    it("坐标或时刻非有限的采样不计入，窗内只剩一个", () => {
      const samples = [
        { y: Number.NaN, t: NOW - 60 },
        { y: Infinity, t: NOW - 40 },
        { y: 80, t: Number.NaN },
        { y: 100, t: NOW - 20 },
      ];
      expect(estimateVelocity(samples, NOW)).toBe(0);
    });

    it("两个采样时刻相同：没有时间跨度，同样为 0", () => {
      const samples = [
        { y: 0, t: NOW - 30 },
        { y: 300, t: NOW - 30 },
      ];
      expect(estimateVelocity(samples, NOW)).toBe(0);
    });

    it("对照：恰在时间窗两端的两个采样就足以估计速度", () => {
      const samples = [
        { y: 0, t: NOW - VELOCITY_WINDOW_MS },
        { y: 50, t: NOW },
      ];
      // 50px / 100ms = 500 px/s
      expect(estimateVelocity(samples, NOW)).toBe(500);
    });
  });
});
