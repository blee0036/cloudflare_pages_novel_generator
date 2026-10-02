import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  EDGE_EPSILON_PX,
  LINE_STEP_PX,
  PAGE_OVERLAP_PX,
  PageDirection,
  ScrollBox,
  chapterEdgeScrollTop,
  lineScrollTarget,
  maxScrollTop,
  pageScrollTarget,
  pageStep,
} from "./pageScroll";

/**
 * `src/utils/pageScroll.ts`（任务 60，需求 9.4、差异表 C13）。
 *
 * 两条不变量逐条钉住：一次翻页的位移 `<= clientHeight`（不跳过未读内容），返回值恒落在
 * `[0, maxScrollTop]`（不越界）。这两条错了 `typecheck` 一无所知，症状是"按一下 Space
 * 少了一行"或"翻到章尾还能再按一下"（design §11）。
 */

/** 一屏 800px 的桌面视口，正文 5000px：约 6 屏的普通章节。 */
const VIEW = 800;
const TALL: ScrollBox = { scrollTop: 0, clientHeight: VIEW, scrollHeight: 5000 };

/** 内容不满一屏的短章节（卷后的小节、序言）：无页可翻。 */
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

describe("pageStep", () => {
  it("普通视口下是一屏减去重叠量", () => {
    expect(pageStep(VIEW)).toBe(VIEW - PAGE_OVERLAP_PX);
  });

  it("恒不超过视口高度——否则会跳过未读的一段", () => {
    for (const height of [1, 17, 128, 129, 320, 640, VIEW, 1440, 2160]) {
      expect(pageStep(height)).toBeLessThanOrEqual(height);
    }
  });

  it("极矮视口至少推进半屏，不做原地挪动", () => {
    expect(pageStep(100)).toBe(50);
    expect(pageStep(120)).toBe(60);
  });

  it("视口高度随之单调不减", () => {
    let prev = 0;
    for (let height = 1; height <= 2000; height += 7) {
      const step = pageStep(height);
      expect(step).toBeGreaterThanOrEqual(prev);
      prev = step;
    }
  });

  it("未布局的容器（0 / NaN / 负数）没有可翻的页", () => {
    for (const height of [0, 0.4, -100, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(pageStep(height)).toBe(0);
    }
  });
});

describe("pageScrollTarget 下翻", () => {
  it("从章首往下推一屏（减去重叠量）", () => {
    expect(pageScrollTarget(TALL, 1)).toBe(VIEW - PAGE_OVERLAP_PX);
  });

  it("接近章尾时夹在最大值上，不越界", () => {
    const max = maxScrollTop(TALL);
    expect(pageScrollTarget(at(TALL, max - 20), 1)).toBe(max);
  });

  it("已在章尾 → null（调用方据此换章）", () => {
    expect(pageScrollTarget(at(TALL, maxScrollTop(TALL)), 1)).toBeNull();
  });

  it("停在容差内的小数位置也算章尾，不出现按了没反应", () => {
    const max = maxScrollTop(TALL);
    expect(pageScrollTarget(at(TALL, max - EDGE_EPSILON_PX), 1)).toBeNull();
    expect(pageScrollTarget(at(TALL, max - EDGE_EPSILON_PX - 1), 1)).not.toBeNull();
  });

  it("内容不满一屏 → 一次就报章尾", () => {
    expect(pageScrollTarget(SHORT, 1)).toBeNull();
  });

  it("scrollTop 超出合法区间（刚换章的残留值）先被夹回来", () => {
    expect(pageScrollTarget(at(TALL, 99999), 1)).toBeNull();
    expect(pageScrollTarget(at(TALL, Number.NaN), 1)).toBe(VIEW - PAGE_OVERLAP_PX);
  });

  it("连续下翻能在有限步内到章尾，且每步都不跳过未读像素", () => {
    let box = TALL;
    let steps = 0;
    for (;;) {
      const target = pageScrollTarget(box, 1);
      if (target === null) break;
      // 位移不超过一屏 = 上一屏底边之后没有像素被越过
      expect(target - box.scrollTop).toBeGreaterThan(0);
      expect(target - box.scrollTop).toBeLessThanOrEqual(VIEW);
      box = at(box, target);
      steps += 1;
      expect(steps).toBeLessThanOrEqual(100); // 防止边界写反时测试挂死
    }
    expect(box.scrollTop).toBe(maxScrollTop(TALL));
    expect(steps).toBe(6);
  });
});

describe("pageScrollTarget 上翻", () => {
  it("从章尾往上推一屏", () => {
    const max = maxScrollTop(TALL);
    expect(pageScrollTarget(at(TALL, max), -1)).toBe(max - (VIEW - PAGE_OVERLAP_PX));
  });

  it("接近章首时夹到 0，不出现负的 scrollTop", () => {
    expect(pageScrollTarget(at(TALL, 20), -1)).toBe(0);
  });

  it("已在章首 → null（调用方原地不动，不回上一章）", () => {
    expect(pageScrollTarget(TALL, -1)).toBeNull();
    expect(pageScrollTarget(at(TALL, EDGE_EPSILON_PX), -1)).toBeNull();
  });

  it("下翻再上翻回到章首，往返不丢位置", () => {
    const down = pageScrollTarget(TALL, 1);
    expect(down).not.toBeNull();
    expect(pageScrollTarget(at(TALL, down as number), -1)).toBe(0);
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

describe("chapterEdgeScrollTop", () => {
  it("章首是 0——让 <h1> 标题一起进视野", () => {
    expect(chapterEdgeScrollTop(at(TALL, 3000), "start")).toBe(0);
  });

  it("章末是最大可滚位置——章末导航卡一并露出", () => {
    expect(chapterEdgeScrollTop(at(TALL, 0), "end")).toBe(maxScrollTop(TALL));
  });

  it("短章节的两端重合在 0", () => {
    expect(chapterEdgeScrollTop(SHORT, "start")).toBe(0);
    expect(chapterEdgeScrollTop(SHORT, "end")).toBe(0);
  });
});
