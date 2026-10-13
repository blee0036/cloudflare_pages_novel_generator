import { describe, expect, it } from "vitest";
import { EDGE_EPSILON_PX } from "./pageScroll";
import {
  EMPTY_SCROLL_GEOMETRY,
  planScrollTurn,
  turnBlocks,
  visibleBand,
  type ScrollGeometry,
  type ScrollTurnInput,
} from "./scrollTurn";

/**
 * 翻页滚动的取行、可见区与执行方案（任务 16.4，design §7.6）。`scrollTurnDelta` 本身由
 * `scrollTurn.test.ts` 的 Property 23 覆盖；这里钉住 `ScrollReader.turn()` 在它前后组合的三个
 * 纯函数。
 */

/**
 * 窗口里三章（章号 2、3、4）：第 3 章只有标题。区段带 64px 上内边距，首段在标题区之下。
 */
const geometry: ScrollGeometry = {
  chapterIds: [2, 3, 4],
  sectionTops: [0, 400, 600],
  sectionHeights: [400, 200, 300],
  paraTops: [[140, 200, 260], [], [740, 800]],
};

describe("turnBlocks：边缘所在段、相邻段与标题区", () => {
  it("边缘落在段中：本章标题区与前后各一段", () => {
    expect(turnBlocks(geometry, 210)).toEqual([
      { chapterId: 2, para: -1 },
      { chapterId: 2, para: 0 },
      { chapterId: 2, para: 1 },
      { chapterId: 2, para: 2 },
    ]);
  });

  it("边缘落在末段或其后：加上下一章的标题区", () => {
    expect(turnBlocks(geometry, 270)).toEqual([
      { chapterId: 2, para: -1 },
      { chapterId: 2, para: 1 },
      { chapterId: 2, para: 2 },
      { chapterId: 3, para: -1 },
    ]);
  });

  it("边缘落在标题区或上内边距：加上前一章的末段，没有前一章时只取本章", () => {
    expect(turnBlocks(geometry, 100)).toEqual([
      { chapterId: 2, para: -1 },
      { chapterId: 2, para: 0 },
    ]);
    // 前一章只有标题：取它的标题区
    expect(turnBlocks(geometry, 620)).toEqual([
      { chapterId: 4, para: -1 },
      { chapterId: 4, para: 0 },
      { chapterId: 3, para: -1 },
    ]);
  });

  it("只有标题的章：前一章末段与后一章标题区都要", () => {
    expect(turnBlocks(geometry, 450)).toEqual([
      { chapterId: 3, para: -1 },
      { chapterId: 2, para: 2 },
      { chapterId: 4, para: -1 },
    ]);
  });

  it("窗口末章的末段之后：没有下一章可加", () => {
    expect(turnBlocks(geometry, 900)).toEqual([
      { chapterId: 4, para: -1 },
      { chapterId: 4, para: 0 },
      { chapterId: 4, para: 1 },
    ]);
  });

  it("几何为空或边缘非有限时为空", () => {
    expect(turnBlocks(EMPTY_SCROLL_GEOMETRY, 100)).toEqual([]);
    expect(turnBlocks(geometry, Number.NaN)).toEqual([]);
  });
});

describe("visibleBand：可视矩形减去压在上面的控制栏", () => {
  const view = { top: 0, bottom: 800 };

  it("控制栏可见时上下各扣一栏", () => {
    expect(visibleBand(view, [])).toEqual({ top: 0, bottom: 800 });
    expect(visibleBand(view, [{ top: 0, bottom: 56 }, { top: 744, bottom: 800 }])).toEqual({ top: 56, bottom: 744 });
  });

  it("已滑出的栏不计，滑动途中的栏按此刻露出的部分扣除", () => {
    expect(visibleBand(view, [{ top: -56, bottom: 0 }, { top: 800, bottom: 856 }])).toEqual({ top: 0, bottom: 800 });
    expect(visibleBand(view, [{ top: -20, bottom: 36 }, { top: 780, bottom: 836 }])).toEqual({ top: 36, bottom: 780 });
  });

  it("尺寸为 0 的栏不计；被完全盖住时为空区间", () => {
    expect(visibleBand(view, [{ top: 100, bottom: 100 }])).toEqual({ top: 0, bottom: 800 });
    expect(visibleBand({ top: 0, bottom: 100 }, [{ top: 0, bottom: 60 }, { top: 40, bottom: 100 }])).toEqual({
      top: 60,
      bottom: 60,
    });
  });
});

describe("planScrollTurn：夹取与到边", () => {
  const base: ScrollTurnInput = {
    scrollTop: 100,
    maxScrollTop: 1000,
    delta: 300,
    direction: "next",
    windowAtBookEdge: false,
  };

  it("没到边：目标为 scrollTop + delta，夹进 [0, max]", () => {
    expect(planScrollTurn(base)).toEqual({ kind: "scroll", from: 100, to: 400 });
    expect(planScrollTurn({ ...base, scrollTop: 900 })).toEqual({ kind: "scroll", from: 900, to: 1000 });
    expect(planScrollTurn({ ...base, scrollTop: 500, delta: -300, direction: "prev" })).toEqual({
      kind: "scroll",
      from: 500,
      to: 200,
    });
    expect(planScrollTurn({ ...base, scrollTop: 500, delta: -600, direction: "prev" })).toEqual({
      kind: "scroll",
      from: 500,
      to: 0,
    });
  });

  it("到边（容差内）：窗口端即全书端时提示边界，否则原地不动", () => {
    const atEnd = { ...base, scrollTop: 1000 - EDGE_EPSILON_PX };
    expect(planScrollTurn({ ...atEnd, windowAtBookEdge: true })).toEqual({ kind: "boundary" });
    expect(planScrollTurn(atEnd)).toEqual({ kind: "none" });

    const atStart = { ...base, scrollTop: EDGE_EPSILON_PX, delta: -300, direction: "prev" as const };
    expect(planScrollTurn({ ...atStart, windowAtBookEdge: true })).toEqual({ kind: "boundary" });
    expect(planScrollTurn(atStart)).toEqual({ kind: "none" });

    // 恰好越过容差就不算到边
    expect(planScrollTurn({ ...base, scrollTop: 1000 - EDGE_EPSILON_PX - 1, windowAtBookEdge: true })).toEqual({
      kind: "scroll",
      from: 1000 - EDGE_EPSILON_PX - 1,
      to: 1000,
    });
  });

  it("内容不满一屏：两个方向都在边上", () => {
    expect(planScrollTurn({ ...base, scrollTop: 0, maxScrollTop: 0, windowAtBookEdge: true })).toEqual({
      kind: "boundary",
    });
  });

  it("位移为 0、方向不符或非有限时原地不动", () => {
    expect(planScrollTurn({ ...base, delta: 0 })).toEqual({ kind: "none" });
    expect(planScrollTurn({ ...base, delta: -300 })).toEqual({ kind: "none" });
    expect(planScrollTurn({ ...base, delta: Number.NaN })).toEqual({ kind: "none" });
  });

  it("脏的 scrollTop 先夹进 [0, max]", () => {
    expect(planScrollTurn({ ...base, scrollTop: Number.NaN })).toEqual({ kind: "scroll", from: 0, to: 300 });
    expect(planScrollTurn({ ...base, scrollTop: 1200, windowAtBookEdge: true })).toEqual({ kind: "boundary" });
  });
});
