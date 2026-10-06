import { describe, expect, it } from "vitest";
import {
  GRID_ROW_PITCH,
  OVERSCAN,
  ROW_HEIGHT,
  centerScrollTop,
  computeGridWindow,
  computeWindow,
} from "./listWindow";

/** 自拟的大列表长度（几千章的量级），用来验证挂载量与总量脱钩。 */
const BIGGEST = 3080;
/** 抽屉列表区的典型高度：44px 一行，约能放 15 行。 */
const VIEW_H = 660;

describe("computeWindow", () => {
  it("在列表顶部时从第 0 行开始，不产生负下标", () => {
    expect(computeWindow(0, VIEW_H, BIGGEST)).toEqual({
      start: 0,
      end: Math.ceil(VIEW_H / ROW_HEIGHT) + OVERSCAN,
    });
  });

  it("滚到中段时以可见区为中心，上下各多 OVERSCAN 行", () => {
    const scrollTop = 100 * ROW_HEIGHT;
    expect(computeWindow(scrollTop, VIEW_H, BIGGEST)).toEqual({
      start: 100 - OVERSCAN,
      end: 100 + Math.ceil(VIEW_H / ROW_HEIGHT) + OVERSCAN,
    });
  });

  it("滚到底部时 end 被夹在总数上，不越界切片", () => {
    const maxTop = BIGGEST * ROW_HEIGHT - VIEW_H;
    const { start, end } = computeWindow(maxTop, VIEW_H, BIGGEST);
    expect(end).toBe(BIGGEST);
    expect(start).toBeLessThan(end);
  });

  it("挂载行数与列表总量无关，只随视口高度变化", () => {
    const small = computeWindow(0, VIEW_H, 50);
    const huge = computeWindow(0, VIEW_H, BIGGEST);
    // 50 章的列表本来就装得下，所以取两者中较小的那个上限
    expect(huge.end - huge.start).toBeLessThanOrEqual(
      Math.ceil(VIEW_H / ROW_HEIGHT) + 2 * OVERSCAN,
    );
    expect(small.end - small.start).toBeLessThanOrEqual(huge.end - huge.start);
  });

  it("空列表返回空区间", () => {
    expect(computeWindow(0, VIEW_H, 0)).toEqual({ start: 0, end: 0 });
  });

  it("尚未测量视口（viewH=0）时仍返回合法区间", () => {
    const { start, end } = computeWindow(0, 0, BIGGEST);
    expect(start).toBe(0);
    expect(end).toBeGreaterThanOrEqual(start);
    expect(end).toBeLessThanOrEqual(BIGGEST);
  });

  it("任意滚动位置下区间都落在 [0, total] 且覆盖可见区", () => {
    const maxTop = BIGGEST * ROW_HEIGHT - VIEW_H;
    for (let top = 0; top <= maxTop; top += 137) {
      const { start, end } = computeWindow(top, VIEW_H, BIGGEST);
      const firstVisible = Math.floor(top / ROW_HEIGHT);
      const lastVisible = Math.min(
        BIGGEST - 1,
        Math.floor((top + VIEW_H - 1) / ROW_HEIGHT),
      );

      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeLessThanOrEqual(BIGGEST);
      // 可见区必须被完全覆盖，否则会露白
      expect(start).toBeLessThanOrEqual(firstVisible);
      expect(end).toBeGreaterThan(lastVisible);
    }
  });
});

describe("centerScrollTop", () => {
  it("把目标行放到视口中间", () => {
    expect(centerScrollTop(100, VIEW_H, BIGGEST)).toBe(
      100 * ROW_HEIGHT - VIEW_H / 2,
    );
  });

  it("靠前的行不会算出负的 scrollTop", () => {
    expect(centerScrollTop(0, VIEW_H, BIGGEST)).toBe(0);
    expect(centerScrollTop(3, VIEW_H, BIGGEST)).toBe(0);
  });

  it("靠后的行被夹在最大可滚距离，不留空白", () => {
    const maxTop = BIGGEST * ROW_HEIGHT - VIEW_H;
    expect(centerScrollTop(BIGGEST - 1, VIEW_H, BIGGEST)).toBe(maxTop);
  });

  it("列表装得下时不滚动", () => {
    expect(centerScrollTop(5, VIEW_H, 10)).toBe(0);
  });

  it("找不到目标（idx<0）或空列表时回到顶部", () => {
    expect(centerScrollTop(-1, VIEW_H, BIGGEST)).toBe(0);
    expect(centerScrollTop(0, VIEW_H, 0)).toBe(0);
  });

  it("算出的位置一定能让目标行落进对应的挂载区间", () => {
    for (const idx of [0, 1, 7, 8, 9, 500, 1540, BIGGEST - 9, BIGGEST - 1]) {
      const top = centerScrollTop(idx, VIEW_H, BIGGEST);
      const { start, end } = computeWindow(top, VIEW_H, BIGGEST);
      expect(idx).toBeGreaterThanOrEqual(start);
      expect(idx).toBeLessThan(end);
    }
  });
});

describe("computeGridWindow", () => {
  /** 弹窗章节网格区的典型高度。 */
  const GRID_VIEW_H = 520;

  it("行数按列数折算，双列时只有单列的一半高", () => {
    const one = computeGridWindow(0, GRID_VIEW_H, BIGGEST, 1);
    const two = computeGridWindow(0, GRID_VIEW_H, BIGGEST, 2);
    expect(one.rows).toBe(BIGGEST);
    expect(two.rows).toBe(Math.ceil(BIGGEST / 2));
  });

  it("条目区间由行区间摊开，双列时一行两个", () => {
    const { start, end, itemStart, itemEnd } = computeGridWindow(
      40 * GRID_ROW_PITCH,
      GRID_VIEW_H,
      BIGGEST,
      2,
    );
    expect(itemStart).toBe(start * 2);
    expect(itemEnd).toBe(end * 2);
  });

  it("末行不满时条目区间被夹在总数上，不越界切片", () => {
    // 7 条 / 2 列 = 4 行，末行只有 1 条
    const { rows, itemEnd } = computeGridWindow(0, GRID_VIEW_H, 7, 2);
    expect(rows).toBe(4);
    expect(itemEnd).toBe(7);
  });

  it("列数非法（0 / 负数 / NaN）时退化为单列而不是除零", () => {
    for (const cols of [0, -3, Number.NaN]) {
      const { rows, itemStart, itemEnd } = computeGridWindow(
        0,
        GRID_VIEW_H,
        100,
        cols,
      );
      expect(rows).toBe(100);
      expect(itemStart).toBe(0);
      expect(itemEnd).toBeGreaterThan(0);
      expect(itemEnd).toBeLessThanOrEqual(100);
    }
  });

  it("空列表返回空区间", () => {
    expect(computeGridWindow(0, GRID_VIEW_H, 0, 2)).toEqual({
      rows: 0,
      start: 0,
      end: 0,
      itemStart: 0,
      itemEnd: 0,
    });
  });

  it("任意滚动位置与列数下，可见条目都在挂载区间内", () => {
    for (const cols of [1, 2, 3]) {
      const rows = Math.ceil(BIGGEST / cols);
      const maxTop = rows * GRID_ROW_PITCH - GRID_VIEW_H;
      for (let top = 0; top <= maxTop; top += 149) {
        const { itemStart, itemEnd } = computeGridWindow(
          top,
          GRID_VIEW_H,
          BIGGEST,
          cols,
        );
        const firstVisibleRow = Math.floor(top / GRID_ROW_PITCH);
        const lastVisibleRow = Math.min(
          rows - 1,
          Math.floor((top + GRID_VIEW_H - 1) / GRID_ROW_PITCH),
        );

        expect(itemStart).toBeLessThanOrEqual(firstVisibleRow * cols);
        // 末行最后一个可见条目必须被挂载
        expect(itemEnd).toBeGreaterThan(
          Math.min(BIGGEST - 1, lastVisibleRow * cols),
        );
        expect(itemEnd).toBeLessThanOrEqual(BIGGEST);
      }
    }
  });

  it("挂载条目数与总量无关，只随视口高度和列数变化", () => {
    const big = computeGridWindow(0, GRID_VIEW_H, BIGGEST, 2);
    const mounted = big.itemEnd - big.itemStart;
    const maxRows = Math.ceil(GRID_VIEW_H / GRID_ROW_PITCH) + 2 * OVERSCAN;
    expect(mounted).toBeLessThanOrEqual(maxRows * 2);
  });
});
