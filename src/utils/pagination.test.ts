import { describe, expect, it } from "vitest";
import {
  PAGE_SIZE,
  hasMore,
  nextPageCount,
  remainingCount,
  totalPages,
  visibleCount,
} from "./pagination";

/** 差异表 B3 里那个"一次性挂载会卡死"的规模。 */
const HUGE = 7000;

describe("visibleCount", () => {
  it("首屏只挂载一批（需求 5.8 的默认 50 本）", () => {
    expect(PAGE_SIZE).toBe(50);
    expect(visibleCount(HUGE, 1)).toBe(50);
  });

  it("每加一页多挂一批", () => {
    expect(visibleCount(HUGE, 2)).toBe(100);
    expect(visibleCount(HUGE, 3)).toBe(150);
  });

  it("结果集比一批还少时全部挂载，不补空位", () => {
    expect(visibleCount(6, 1)).toBe(6);
    expect(visibleCount(0, 1)).toBe(0);
  });

  it("页数超出结果集时被夹在总数上，slice 不越界", () => {
    expect(visibleCount(120, 99)).toBe(120);
  });

  it("页数为 0 / 负数 / NaN 时仍挂载首屏一批，不白屏", () => {
    for (const pages of [0, -4, Number.NaN]) {
      expect(visibleCount(HUGE, pages)).toBe(50);
    }
  });

  it("批大小非法时退化为全部挂载，而不是挂 0 本", () => {
    for (const size of [0, -10, Number.NaN]) {
      expect(visibleCount(HUGE, 1, size)).toBe(HUGE);
    }
  });

  it("随页数单调不减，且恒落在 [0, total]", () => {
    let prev = 0;
    for (let pages = 1; pages <= 200; pages += 1) {
      const n = visibleCount(HUGE, pages);
      expect(n).toBeGreaterThanOrEqual(prev);
      expect(n).toBeLessThanOrEqual(HUGE);
      prev = n;
    }
    expect(prev).toBe(HUGE);
  });
});

describe("hasMore / remainingCount", () => {
  it("首屏之后还有剩余时为真，并报出准确的剩余数", () => {
    expect(hasMore(HUGE, 1)).toBe(true);
    expect(remainingCount(HUGE, 1)).toBe(HUGE - 50);
  });

  it("结果集不足一批时没有继续加载入口", () => {
    expect(hasMore(50, 1)).toBe(false);
    expect(hasMore(7, 1)).toBe(false);
    expect(hasMore(0, 1)).toBe(false);
    expect(remainingCount(50, 1)).toBe(0);
  });

  it("刚好整批边界不会多出一次空的继续加载", () => {
    // 100 本 / 每批 50：第 2 页正好装满，此时入口必须消失
    expect(hasMore(100, 2)).toBe(false);
    expect(remainingCount(100, 2)).toBe(0);
    expect(hasMore(101, 2)).toBe(true);
    expect(remainingCount(101, 2)).toBe(1);
  });

  it("已挂载数 + 剩余数恒等于总数", () => {
    for (const total of [0, 1, 49, 50, 51, 999, HUGE]) {
      for (const pages of [1, 2, 7, 500]) {
        expect(visibleCount(total, pages) + remainingCount(total, pages)).toBe(total);
      }
    }
  });
});

describe("totalPages", () => {
  it("按批大小向上取整", () => {
    expect(totalPages(50)).toBe(1);
    expect(totalPages(51)).toBe(2);
    expect(totalPages(HUGE)).toBe(140);
  });

  it("空列表也算一页（那页空的首屏）", () => {
    expect(totalPages(0)).toBe(1);
  });
});

describe("nextPageCount", () => {
  it("逐页推进", () => {
    expect(nextPageCount(HUGE, 1)).toBe(2);
    expect(nextPageCount(HUGE, 2)).toBe(3);
  });

  it("在装满结果集的页数处封顶，连点不会涨成虚高的页数", () => {
    expect(nextPageCount(120, 3)).toBe(3);
    expect(nextPageCount(120, 99)).toBe(3);
    expect(nextPageCount(0, 1)).toBe(1);
  });

  it("反复推进能在 ceil(total / PAGE_SIZE) 步内挂满全部条目", () => {
    let pages = 1;
    let steps = 0;
    while (hasMore(HUGE, pages)) {
      pages = nextPageCount(HUGE, pages);
      steps += 1;
      // 防止封顶逻辑出错时测试挂死
      expect(steps).toBeLessThanOrEqual(HUGE);
    }
    expect(steps).toBe(totalPages(HUGE) - 1);
    expect(visibleCount(HUGE, pages)).toBe(HUGE);
  });
});
