import { describe, expect, it } from "vitest";
import {
  SHELF_GRID_CLASS,
  SHELF_GRID_COLUMNS,
  SHELF_ROW_UNIT,
  alignToColumns,
  rowUnit,
} from "./shelfGrid";

describe("SHELF_GRID_CLASS / SHELF_GRID_COLUMNS", () => {
  it("类名里的列数与 SHELF_GRID_COLUMNS 一致（改网格时两处必须一起改）", () => {
    const fromClass = [...SHELF_GRID_CLASS.matchAll(/(?:^|\s)(?:[a-z0-9]+:)?grid-cols-(\d+)/g)].map(
      (m) => Number(m[1]),
    );
    expect(fromClass).toEqual([...SHELF_GRID_COLUMNS]);
  });

  it("对齐单位是 1/2/3/4 列的最小公倍数 12", () => {
    expect(SHELF_ROW_UNIT).toBe(12);
  });
});

describe("rowUnit", () => {
  it("求最小公倍数", () => {
    expect(rowUnit([1, 2, 3, 4])).toBe(12);
    expect(rowUnit([2, 4])).toBe(4);
    expect(rowUnit([1, 2, 3, 4, 5])).toBe(60);
    expect(rowUnit([3])).toBe(3);
  });

  it("忽略非正、非整数的列数；全不合法时为 1", () => {
    expect(rowUnit([0, -2, 1.5, Number.NaN, 4])).toBe(4);
    expect(rowUnit([])).toBe(1);
  });
});

describe("alignToColumns", () => {
  it("取离目标最近的整行倍数", () => {
    expect(alignToColumns(50, [1, 2, 3, 4])).toBe(48);
    expect(alignToColumns(55, [1, 2, 3, 4])).toBe(60);
    expect(alignToColumns(50, [1, 2])).toBe(50);
    expect(alignToColumns(50, [1, 2, 3])).toBe(48);
  });

  it("单位大于目标时至少给一个单位，不会是 0", () => {
    expect(alignToColumns(50, [1, 2, 3, 4, 5])).toBe(60);
    expect(alignToColumns(1, [1, 2, 3, 4])).toBe(12);
    expect(alignToColumns(0, [1, 2, 3, 4])).toBe(12);
  });

  it("结果对每个列数都整除", () => {
    for (const target of [1, 10, 37, 50, 99, 200]) {
      const size = alignToColumns(target, SHELF_GRID_COLUMNS);
      for (const c of SHELF_GRID_COLUMNS) expect(size % c).toBe(0);
    }
  });
});
