import { describe, expect, it } from "vitest";
import {
  EDGE_EPSILON_PX,
  PAGE_OVERLAP_PX,
  ScrollBox,
  chapterEdgeScrollTop,
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
