import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  EDGE_EPSILON_PX,
  LINE_STEP_PX,
  ChapterSpan,
  PageDirection,
  ScrollBox,
  chapterEdgeScrollTop,
  lineScrollTarget,
  maxScrollTop,
} from "./pageScroll";

/**
 * `src/utils/pageScroll.ts`（任务 60，需求 9.4、差异表 C13）。
 *
 * 两条不变量逐条钉住：一次滚动的位移 `<= clientHeight`（不跳过未读内容），返回值恒落在
 * `[0, maxScrollTop]`（不越界）。这两条错了 `typecheck` 一无所知，症状是"按一下 ↓
 * 跳过了两行"或"到章尾还能再按一下"（design §11）。
 */

/** 一屏 800px 的桌面视口，正文 5000px：约 6 屏的普通章节。 */
const VIEW = 800;
const TALL: ScrollBox = { scrollTop: 0, clientHeight: VIEW, scrollHeight: 5000 };

/** 内容不满一屏的短章节（卷后的小节、序言）：无行可滚。 */
const SHORT: ScrollBox = { scrollTop: 0, clientHeight: VIEW, scrollHeight: 600 };

function at(box: ScrollBox, scrollTop: number): ScrollBox {
  return { ...box, scrollTop };
}

describe("maxScrollTop", () => {
  it("等于内容高度减去视口高度", () => {
    expect(maxScrollTop(TALL)).toBe(5000 - VIEW);
  });

  it("内容不满一屏时为 0，不出现负数", () => {
    expect(maxScrollTop(SHORT)).toBe(0);
  });

  it("脏几何（NaN / 负数）按 0 处理，不外泄 NaN", () => {
    expect(maxScrollTop({ scrollTop: 0, clientHeight: Number.NaN, scrollHeight: 900 })).toBe(900);
    expect(maxScrollTop({ scrollTop: 0, clientHeight: -10, scrollHeight: Number.NaN })).toBe(0);
  });
});

describe("lineScrollTarget（需求 4.3 的 ↑/↓）", () => {
  it("中段按 ↓ / ↑ 各走一行（40px）", () => {
    expect(LINE_STEP_PX).toBe(40);
    expect(lineScrollTarget(at(TALL, 1000), 1)).toBe(1000 + LINE_STEP_PX);
    expect(lineScrollTarget(at(TALL, 1000), -1)).toBe(1000 - LINE_STEP_PX);
  });

  it("已在章首按 ↑ → null（原地不动），容差内的小数位置同样算章首", () => {
    expect(lineScrollTarget(TALL, -1)).toBeNull();
    expect(lineScrollTarget(at(TALL, EDGE_EPSILON_PX), -1)).toBeNull();
    expect(lineScrollTarget(at(TALL, EDGE_EPSILON_PX + 1), -1)).toBe(0);
  });

  it("已在章尾按 ↓ → null（不换章），容差内的小数位置同样算章尾", () => {
    const max = maxScrollTop(TALL);
    expect(lineScrollTarget(at(TALL, max), 1)).toBeNull();
    expect(lineScrollTarget(at(TALL, max - EDGE_EPSILON_PX), 1)).toBeNull();
    expect(lineScrollTarget(at(TALL, max - EDGE_EPSILON_PX - 1), 1)).toBe(max);
  });

  it("不足一行时夹到两端，不越界", () => {
    const max = maxScrollTop(TALL);
    expect(lineScrollTarget(at(TALL, max - 20), 1)).toBe(max);
    expect(lineScrollTarget(at(TALL, 20), -1)).toBe(0);
  });

  it("极矮视口一行也不越过一整屏", () => {
    const tiny: ScrollBox = { scrollTop: 100, clientHeight: 30, scrollHeight: 5000 };
    expect(lineScrollTarget(tiny, 1)).toBe(130);
    expect(lineScrollTarget(tiny, -1)).toBe(70);
  });

  it("短章节、未布局的容器（clientHeight 0 / NaN / 不足 1px）两个方向都是 null", () => {
    for (const box of [
      SHORT,
      { scrollTop: 100, clientHeight: 0, scrollHeight: 5000 },
      { scrollTop: 100, clientHeight: Number.NaN, scrollHeight: 5000 },
      { scrollTop: 100, clientHeight: 0.5, scrollHeight: 5000 },
    ]) {
      expect(lineScrollTarget(box, 1)).toBeNull();
      expect(lineScrollTarget(box, -1)).toBeNull();
    }
  });

  it("scrollTop 超出合法区间（刚换章的残留值）先被夹回来", () => {
    const max = maxScrollTop(TALL);
    expect(lineScrollTarget(at(TALL, 99999), 1)).toBeNull();
    expect(lineScrollTarget(at(TALL, 99999), -1)).toBe(max - LINE_STEP_PX);
    expect(lineScrollTarget(at(TALL, Number.NaN), 1)).toBe(LINE_STEP_PX);
    expect(lineScrollTarget(at(TALL, -50), -1)).toBeNull();
  });
});

/*
 * Property 5 的生成器。
 *
 * 有限值都取在 1/64 px 网格上（Chrome 的布局单位），绝对值不超过 1e7：这样 `from ± 40` 与
 * `max - from` 都是精确运算，"位移 ≤ 一行""位移恰为一行"可以按 `===` 断言。任意小数的 double
 * 不行——`2029.261253609772 + 40 - 2029.261253609772` 得 `40.00000000000023`，位移会多出
 * 1 ulp（随机小数里约 0.7% 如此），而 `scrollTop` 超过 2^52 时 `from + 40` 干脆舍入回 `from`。
 * 这些是浮点表示的限度而不是被测函数的错，所以不在生成范围内。
 *
 * 脏值（`NaN`、±`Infinity`、负数、`-0`、0、不足 1px）照常生成，用来钉住 null 与夹取。
 */
const DIRTY: readonly number[] = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0, 0, -1, 0.5];
const LIMIT = 1e7;

/** `[min, max]` 内 1/64 px 网格上的值。`min`、`max` 须本身在网格上。 */
function gridPx(min: number, max: number): fc.Arbitrary<number> {
  return fc.integer({ min: Math.round(min * 64), max: Math.round(max * 64) }).map((n) => n / 64);
}

/** 视口高度：常见视口、步长附近的极矮视口（含 < 1 与 40 两侧）、任意网格值与脏值。 */
const clientHeight = fc.oneof(
  fc.integer({ min: 1, max: 2160 }),
  gridPx(0, 64),
  gridPx(-LIMIT, LIMIT),
  fc.constantFrom(...DIRTY, 1, 39, 40, 41),
);

/** 内容高度：普通章节、任意网格值与脏值。 */
const scrollHeight = fc.oneof(
  fc.integer({ min: 0, max: 20000 }),
  gridPx(0, LIMIT),
  gridPx(-LIMIT, LIMIT),
  fc.constantFrom(...DIRTY),
);

/**
 * 滚动几何快照：`scrollTop` 有意集中在两端附近（离 0 或 max 不超过一行多，覆盖 2px 容差与
 * "不足一行"的两条边界），另有区间内、区间外的任意网格值与脏值。
 */
const scrollBox: fc.Arbitrary<ScrollBox> = fc
  .tuple(clientHeight, scrollHeight)
  .chain(([clientHeight, scrollHeight]) => {
    const max = maxScrollTop({ scrollTop: 0, clientHeight, scrollHeight });
    const scrollTop = fc.oneof(
      gridPx(-8, 64),
      gridPx(-64, 8).map((offset) => max + offset),
      gridPx(0, max),
      gridPx(-LIMIT, LIMIT),
      fc.constantFrom(...DIRTY),
    );
    return scrollTop.map((top): ScrollBox => ({ scrollTop: top, clientHeight, scrollHeight }));
  });

const direction = fc.constantFrom<PageDirection>(1, -1);

/** 夹成非负有限数（与 design Property 5 的 from / clientHeight 口径一致：非有限数按 0）。 */
function px(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

describe("lineScrollTarget（属性）", () => {
  // Feature: reader-defect-fixes, Property 5: 行滚动不越界、方向正确
  // **Validates: Requirements 4.3**
  it("对任意几何快照与方向：无可滚距离或未布局时为 null，否则落在 [0, max]、朝方向走且位移为 min(一行, 视口, 剩余)", () => {
    fc.assert(
      fc.property(scrollBox, direction, (box, d) => {
        const max = maxScrollTop(box);
        const from = Math.min(max, px(box.scrollTop));
        const height = px(box.clientHeight);
        const room = d > 0 ? max - from : from;
        const step = Math.min(LINE_STEP_PX, height);

        const t = lineScrollTarget(box, d);

        if (height < 1 || room <= EDGE_EPSILON_PX) {
          expect(t).toBeNull();
          return;
        }
        expect(t).not.toBeNull();
        const target = t as number;
        // 不越界
        expect(target).toBeGreaterThanOrEqual(0);
        expect(target).toBeLessThanOrEqual(max);
        // 方向正确
        expect((target - from) * d).toBeGreaterThan(0);
        // 位移不超过一行、不超过一屏；剩余距离够一行时恰为一行，否则停在该方向的尽头
        const moved = Math.abs(target - from);
        expect(moved).toBeLessThanOrEqual(step);
        if (room >= step) expect(moved).toBe(step);
        else expect(target).toBe(d > 0 ? max : 0);
      }),
      { numRuns: 100 },
    );
  });
});

describe("chapterEdgeScrollTop（按章节区段）", () => {
  /** 上方挂着前一章的当前章：区段从 3000 开始，正文 5000px。 */
  const MIDDLE: ChapterSpan = { top: 3000, bottom: 8000 };

  it("章首是区段顶边——让 <h1> 标题一起进视野", () => {
    expect(chapterEdgeScrollTop(MIDDLE, VIEW, "start")).toBe(3000);
  });

  it("章末是区段底边贴住视口底边", () => {
    expect(chapterEdgeScrollTop(MIDDLE, VIEW, "end")).toBe(8000 - VIEW);
  });

  it("区段不满一屏时两端重合在区段顶边，不滚进上一章", () => {
    const short: ChapterSpan = { top: 3000, bottom: 3600 };
    expect(chapterEdgeScrollTop(short, VIEW, "start")).toBe(3000);
    expect(chapterEdgeScrollTop(short, VIEW, "end")).toBe(3000);
  });

  it("区段即整个内容时与旧版一致：章首 0、章末 maxScrollTop", () => {
    for (const box of [TALL, SHORT]) {
      const whole: ChapterSpan = { top: 0, bottom: box.scrollHeight };
      expect(chapterEdgeScrollTop(whole, box.clientHeight, "start")).toBe(0);
      expect(chapterEdgeScrollTop(whole, box.clientHeight, "end")).toBe(maxScrollTop(box));
    }
  });

  it("脏几何（NaN / 负数）按 0 处理，不外泄 NaN", () => {
    expect(chapterEdgeScrollTop({ top: Number.NaN, bottom: 900 }, VIEW, "start")).toBe(0);
    expect(chapterEdgeScrollTop({ top: 0, bottom: 900 }, Number.NaN, "end")).toBe(900);
    expect(chapterEdgeScrollTop({ top: -10, bottom: Number.NaN }, VIEW, "end")).toBe(0);
  });
});
