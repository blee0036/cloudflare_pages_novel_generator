import { describe, expect, it } from "vitest";
import type { Para } from "./locator";
import {
  EMPTY_SCROLL_GEOMETRY,
  navScrollTop,
  positionAt,
  type ScrollGeometry,
  TOP_BIAS,
} from "./scrollTurn";

/**
 * 导航定位与判定线位置的互逆换算（任务 16.3，design §3.1、§7.4）。`scrollTurn.test.ts` 覆盖
 * `locateAt` 与位置归约器；这里只钉住在其上组合出来的两个函数，以及两者互逆这一点。
 */

const para = (offset: number, text = "正文"): Para => ({ offset, text });

/**
 * 窗口里三章（章号 2、3、4）：第 3 章只有标题。区段带 64px 上内边距（`pt-16`），首段顶边在
 * 区段顶边之下约一个标题区的位置。
 */
const PARAS: Record<number, Para[]> = {
  2: [para(6), para(12), para(20)],
  3: [],
  4: [para(5), para(30)],
};

const geometry: ScrollGeometry = {
  chapterIds: [2, 3, 4],
  sectionTops: [0, 400, 600],
  sectionHeights: [400, 200, 300],
  paraTops: [[140, 200, 260], [], [740, 800]],
};

const parasOf = (chapterId: number) => PARAS[chapterId];

describe("navScrollTop：把目标段落置于判定线", () => {
  it("首段（含章首与首段之前的偏移）对齐区段顶边", () => {
    expect(navScrollTop(geometry, 2, PARAS[2], 0)).toBe(0);
    expect(navScrollTop(geometry, 2, PARAS[2], 6)).toBe(0);
    expect(navScrollTop(geometry, 2, PARAS[2], 11)).toBe(0);
    expect(navScrollTop(geometry, 4, PARAS[4], 0)).toBe(600);
    expect(navScrollTop(geometry, 4, PARAS[4], Number.NaN)).toBe(600);
  });

  it("其余段落的顶边压在判定线上：scrollTop = paraTop − TOP_BIAS", () => {
    expect(navScrollTop(geometry, 2, PARAS[2], 12)).toBe(200 - TOP_BIAS);
    // 段内偏移归到所在段
    expect(navScrollTop(geometry, 2, PARAS[2], 25)).toBe(260 - TOP_BIAS);
    expect(navScrollTop(geometry, 4, PARAS[4], 31)).toBe(800 - TOP_BIAS);
  });

  it("只有标题的章对齐区段顶边", () => {
    expect(navScrollTop(geometry, 3, PARAS[3], 0)).toBe(400);
    expect(navScrollTop(geometry, 3, PARAS[3], 99)).toBe(400);
  });

  it("结果不为负", () => {
    const tight: ScrollGeometry = { ...geometry, paraTops: [[20, 40, 60], [], [740, 800]] };
    expect(navScrollTop(tight, 2, PARAS[2], 12)).toBe(0);
  });

  it("目标章未挂载、未测量或测量没跟上段落集合时返回 null", () => {
    expect(navScrollTop(geometry, 5, [para(0)], 0)).toBeNull();
    expect(navScrollTop(EMPTY_SCROLL_GEOMETRY, 2, PARAS[2], 12)).toBeNull();
    expect(navScrollTop(geometry, 2, PARAS[2].slice(0, 2), 12)).toBeNull();
  });
});

describe("positionAt：判定线处的（章, 偏移）", () => {
  it("判定线压在段顶上取那一段，落在两段之间取上一段", () => {
    expect(positionAt(geometry, parasOf, 200 - TOP_BIAS)).toEqual({ chapterId: 2, charOffset: 12 });
    expect(positionAt(geometry, parasOf, 250 - TOP_BIAS)).toEqual({ chapterId: 2, charOffset: 12 });
  });

  it("判定线落在标题区里取首段；只有标题的章为章首 0", () => {
    expect(positionAt(geometry, parasOf, 0)).toEqual({ chapterId: 2, charOffset: 6 });
    expect(positionAt(geometry, parasOf, 600)).toEqual({ chapterId: 4, charOffset: 5 });
    expect(positionAt(geometry, parasOf, 400)).toEqual({ chapterId: 3, charOffset: 0 });
  });

  it("判定线越过区段顶边即换章", () => {
    expect(positionAt(geometry, parasOf, 400 - TOP_BIAS - 1)).toEqual({ chapterId: 2, charOffset: 20 });
    expect(positionAt(geometry, parasOf, 400 - TOP_BIAS)).toEqual({ chapterId: 3, charOffset: 0 });
  });

  it("拿不到段落时按章首处理；几何为空或 scrollTop 非有限时返回 null", () => {
    expect(positionAt(geometry, () => undefined, 200 - TOP_BIAS)).toEqual({ chapterId: 2, charOffset: 0 });
    expect(positionAt(EMPTY_SCROLL_GEOMETRY, parasOf, 0)).toBeNull();
    expect(positionAt(geometry, parasOf, Number.NaN)).toBeNull();
  });
});

describe("navScrollTop 与 positionAt 互逆（到段落为止）", () => {
  it("定位到任一段后，判定线判出的是同一章的同一段", () => {
    for (const chapterId of geometry.chapterIds) {
      const paras = PARAS[chapterId];
      const offsets = paras.length ? paras.map((p) => p.offset) : [0];
      for (const offset of offsets) {
        const top = navScrollTop(geometry, chapterId, paras, offset);
        expect(top).not.toBeNull();
        expect(positionAt(geometry, parasOf, top as number)).toEqual({ chapterId, charOffset: offset });
      }
    }
  });
});
