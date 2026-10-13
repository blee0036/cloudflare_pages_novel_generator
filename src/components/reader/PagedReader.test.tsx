import type { RefObject } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { BookToc, ChapterMeta, ReaderSettings } from "../../types";
import { PAGE_ANIM, type PageAnim } from "../../utils/pageAnim";
import { bodyParagraphs, buildChapterViews, splitParagraphs } from "../../utils/locator";
import { pageView, type PageTable } from "../../utils/paginate";
import type { ChapterContentChapter, ChapterTypography } from "./ChapterContent";
import { simFrame, simGeometry, type SimShadowStrip } from "../../utils/simulationGeometry";
import {
  PageSurface,
  PagedReader,
  SIM_Z,
  SimulationLayers,
  applyNav,
  applyTable,
  emptySimElements,
  pagedAnimOf,
  simCurlSlot,
  simLayerFrame,
  stackFrame,
  stripMatrix,
  stripStyle,
  turnStack,
  wheelRoute,
  type PagedViewState,
} from "./PagedReader";
import type { NavRequest } from "./types";

/**
 * `PagedReader` 的静态标记与模块内纯函数（任务 18.4、18.5、18.6）。项目不搭 jsdom：测量、翻页、手势都发生在
 * layout effect 与事件里，由 e2e 覆盖。服务端渲染没有布局，分页器不会测量，首帧只有测量盒。
 */

// 第 1 卷是卷节点；正文序号 0 1 2 对应章号 0 2 3
const SOURCES: { title: string; text: string; isVolume?: boolean }[] = [
  { title: "第一章 起", text: "第一章 起\n\u3000\u3000甲乙丙丁戊己\n庚辛\n" },
  { title: "第一卷", text: "第一卷\n", isVolume: true },
  { title: "第二章 承", text: "第二章 承\n壬癸\n" },
  { title: "第三章 转", text: "第三章 转\n子丑\n" },
];

const fullText = SOURCES.map((s) => s.text).join("");

const chapters: ChapterMeta[] = (() => {
  let start = 0;
  return SOURCES.map((s, id) => {
    const meta: ChapterMeta = { id, title: s.title, start, end: start + s.text.length, length: s.text.length };
    if (s.isVolume) meta.isVolume = true;
    start = meta.end;
    return meta;
  });
})();

const toc: BookToc = {
  id: "book",
  title: "书",
  author: "作者",
  charCount: fullText.length,
  totalChapters: 3,
  tocRule: "test",
  chapters,
};

const views = buildChapterViews(chapters);

const settings: ReaderSettings = {
  theme: "sepia",
  fontSize: 19,
  lineHeight: 1.85,
  letterSpacing: 1,
  fontFamily: "system",
  contentWidth: 820,
  cacheMaxBooks: 10,
  pageAnim: PAGE_ANIM.cover,
};

const typography: ChapterTypography = {
  contentWidth: settings.contentWidth,
  fontFamily: settings.fontFamily,
  fontSize: settings.fontSize,
  lineHeight: settings.lineHeight,
  letterSpacing: settings.letterSpacing,
};

const noop = () => {};

function render(chapterId: number, pageAnim: PageAnim = PAGE_ANIM.cover): string {
  const nav: NavRequest = { seq: 1, chapterId, charOffset: 0 };
  const positionRef: RefObject<{ chapterId: number; charOffset: number }> = {
    current: { chapterId, charOffset: 0 },
  };
  const html = renderToStaticMarkup(
    <PagedReader
      toc={toc}
      fullText={fullText}
      views={views}
      settings={{ ...settings, pageAnim }}
      positionRef={positionRef}
      nav={nav}
      highlight={null}
      controlsVisible={false}
      onPosition={noop}
      onControls={noop}
      onBoundary={noop}
      onPageInfo={noop}
    />,
  );
  return html.replace(/<!-- -->/g, "");
}

/** 第一章的渲染数据（与分页器 `chapterOf` 同一取法）。 */
function firstChapter(): ChapterContentChapter {
  const meta = chapters[0];
  return {
    chapterId: 0,
    title: meta.title,
    length: meta.length,
    position: 0,
    total: 3,
    paras: bodyParagraphs(splitParagraphs(fullText.slice(meta.start, meta.end)), meta.title),
  };
}

function renderSurface(page: number, current: boolean): string {
  const chapter = firstChapter();
  // 第 2 页从首段第 3 个字起：首段被页界拆开
  const starts = [0, chapter.paras[0].offset + 2];
  return renderToStaticMarkup(
    <PageSurface
      chapter={chapter}
      view={pageView(chapter.paras, starts, page)}
      typography={typography}
      highlight={null}
      current={current}
      pageIndex={page}
      pageCount={starts.length}
      pageStart={starts[page]}
      style={{ contain: "strict" }}
    />,
  ).replace(/<!-- -->/g, "");
}

// React 18 的服务端渲染对 useLayoutEffect 打一条"在服务端无效"的提示，只滤掉这一条
const consoleError = console.error;
beforeAll(() => {
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].includes("useLayoutEffect does nothing on the server")) return;
    consoleError(...args);
  });
});
afterAll(() => {
  vi.restoreAllMocks();
});

describe("PagedReader：视图结构", () => {
  it("<main> 是不滚动的定位容器，接管全部触摸手势，带三个测试钩子", () => {
    const names: [PageAnim, string][] = [
      [PAGE_ANIM.cover, "cover"],
      [PAGE_ANIM.slide, "slide"],
      [PAGE_ANIM.simulation, "simulation"],
      [PAGE_ANIM.none, "none"],
    ];
    for (const [anim, name] of names) {
      const main = /^<main[^>]*>/.exec(render(2, anim))?.[0] ?? "";
      expect(main).toContain(`data-page-mode="${name}"`);
      expect(main).toContain('data-turning="false"');
      expect(main).toContain('data-paginated=""');
      expect(main).toContain('class="relative flex-1 min-h-0 overflow-hidden"');
      expect(main).toContain("touch-action:none");
    }
  });

  it("收到滚动编号时按无动画处理", () => {
    expect(pagedAnimOf(PAGE_ANIM.scroll)).toBe(PAGE_ANIM.none);
    for (const anim of [PAGE_ANIM.cover, PAGE_ANIM.slide, PAGE_ANIM.simulation, PAGE_ANIM.none]) {
      expect(pagedAnimOf(anim)).toBe(anim);
    }
    expect(render(2, PAGE_ANIM.scroll)).toContain('data-page-mode="none"');
  });

  it("首帧只挂测量盒：当前章整章在 aria-hidden 的盒子里，还没有页面图层", () => {
    const html = render(2);
    expect(html).toMatch(/<div aria-hidden="true" data-measure-box=""/);
    expect(html).toContain("第二章 承");
    expect(html).not.toContain("第一章 起");
    expect(html).not.toContain("data-current");
  });
});

describe("PageSurface：页面图层", () => {
  it("当前页：铺满、裁切、不透明底色；内容盒上下各 32px；带测试钩子", () => {
    const html = renderSurface(0, true);
    const tag = /^<div[^>]*>/.exec(html)?.[0] ?? "";
    expect(tag).toContain('class="absolute inset-0 overflow-hidden bg-[var(--bg)]"');
    expect(tag).toContain("contain:strict");
    expect(tag).toContain('data-current="true"');
    expect(tag).toContain('data-chapter-id="0"');
    expect(tag).toContain('data-page-index="0"');
    expect(tag).toContain('data-page-count="2"');
    expect(tag).toContain('data-page-start="0"');
    expect(tag).not.toContain("aria-hidden");
    expect(html).toContain('<div class="px-4 sm:px-8" style="padding-top:32px;padding-bottom:32px"><article');
    expect(html).toMatch(/<article class="mx-auto" style="max-width:820px;/);
  });

  it("非当前页：aria-hidden，没有测试钩子", () => {
    const tag = /^<div[^>]*>/.exec(renderSurface(1, false))?.[0] ?? "";
    expect(tag).toContain('aria-hidden="true"');
    expect(tag).not.toMatch(/data-(current|chapter-id|page-index|page-count|page-start)/);
  });

  it("标题区只在第 1 页；被页界拆开的段：前半截末行两端对齐，后半截不缩进", () => {
    const first = renderSurface(0, true);
    expect(first).toContain("<header");
    expect(first).toMatch(/<p[^>]*style="text-align-last:justify"[^>]*>甲乙<\/p>/);

    const second = renderSurface(1, true);
    expect(second).not.toContain("<header");
    expect(second).toMatch(/<p[^>]*style="text-indent:0"[^>]*>丙丁戊己<\/p>/);
    expect(second).toMatch(/>庚辛<\/p>/);
  });
});

describe("turnStack：图层栈", () => {
  it("覆盖：NEXT 当前页在上移走，PREV 上一页在上盖过来；都有阴影", () => {
    expect(turnStack(PAGE_ANIM.cover, "next")).toEqual({
      cur: { z: 1, moving: true },
      target: { z: 0, moving: false },
      shadow: true,
      curl: null,
    });
    expect(turnStack(PAGE_ANIM.cover, "prev")).toEqual({
      cur: { z: 0, moving: false },
      target: { z: 1, moving: true },
      shadow: true,
      curl: null,
    });
  });

  it("滑动：两层都移动，没有阴影", () => {
    for (const direction of ["next", "prev"] as const) {
      const stack = turnStack(PAGE_ANIM.slide, direction);
      expect(stack?.cur.moving).toBe(true);
      expect(stack?.target.moving).toBe(true);
      expect(stack?.shadow).toBe(false);
      expect(stack?.curl).toBeNull();
    }
  });

  it("仿真：NEXT 卷起当前页、露出下一页；PREV 卷起上一页盖到当前页上；页面不平移、没有覆盖阴影", () => {
    expect(simCurlSlot("next")).toBe("cur");
    expect(simCurlSlot("prev")).toBe("target");
    expect(turnStack(PAGE_ANIM.simulation, "next")).toEqual({
      cur: { z: SIM_Z.curling, moving: false },
      target: { z: SIM_Z.under, moving: false },
      shadow: false,
      curl: "cur",
    });
    expect(turnStack(PAGE_ANIM.simulation, "prev")).toEqual({
      cur: { z: SIM_Z.under, moving: false },
      target: { z: SIM_Z.curling, moving: false },
      shadow: false,
      curl: "target",
    });
  });

  it("仿真叠放次序自下而上：露出页、背面阴影、卷起页、前景阴影、背面", () => {
    const order = [SIM_Z.under, SIM_Z.backShadow, SIM_Z.curling, SIM_Z.frontShadow, SIM_Z.back];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(new Set(order).size).toBe(order.length);
  });

  it("无动画不挂图层栈", () => {
    expect(turnStack(PAGE_ANIM.none, "next")).toBeNull();
    expect(turnStack(PAGE_ANIM.scroll, "prev")).toBeNull();
  });
});

describe("stackFrame：一帧的图层位置", () => {
  const w = 400;

  it("覆盖 NEXT：当前页左移，下一页静止，阴影贴在当前页右缘外侧", () => {
    expect(stackFrame(PAGE_ANIM.cover, "next", -100, w)).toEqual({ cur: -100, target: 0, shadow: 300 });
  });

  it("覆盖 PREV：当前页静止，上一页从左侧进入，阴影贴在上一页右缘外侧", () => {
    expect(stackFrame(PAGE_ANIM.cover, "prev", 100, w)).toEqual({ cur: 0, target: -300, shadow: 100 });
  });

  it("覆盖：偏移为 0 不画阴影；方向与偏移矛盾时静止显示当前页", () => {
    expect(stackFrame(PAGE_ANIM.cover, "next", 0, w).shadow).toBeNull();
    expect(stackFrame(PAGE_ANIM.cover, "prev", 0, w)).toEqual({ cur: 0, target: -400, shadow: null });
    expect(stackFrame(PAGE_ANIM.cover, "next", 50, w)).toEqual({ cur: 0, target: null, shadow: null });
    expect(stackFrame(PAGE_ANIM.cover, "prev", -50, w)).toEqual({ cur: 0, target: null, shadow: null });
  });

  it("滑动：两页相距恰好一屏，没有阴影", () => {
    expect(stackFrame(PAGE_ANIM.slide, "next", -100, w)).toEqual({ cur: -100, target: 300, shadow: null });
    expect(stackFrame(PAGE_ANIM.slide, "prev", 100, w)).toEqual({ cur: 100, target: -300, shadow: null });
    expect(stackFrame(PAGE_ANIM.slide, "next", 50, w)).toEqual({ cur: 0, target: null, shadow: null });
  });

  it("仿真：页面图层不平移，没有覆盖阴影", () => {
    expect(stackFrame(PAGE_ANIM.simulation, "next", -100, w)).toEqual({ cur: 0, target: 0, shadow: null });
    expect(stackFrame(PAGE_ANIM.simulation, "prev", 100, w)).toEqual({ cur: 0, target: 0, shadow: null });
  });
});

/** CSS `matrix(a, b, c, d, e, f)` 作用于一点。 */
function applyMatrix(m: readonly number[], x: number, y: number): { x: number; y: number } {
  const [a, b, c, d, e, f] = m;
  return { x: a * x + c * y + e, y: b * x + d * y + f };
}

describe("simLayerFrame：一帧仿真图层", () => {
  const w = 400;
  const h = 600;

  it("就是 simGeometry + simFrame", () => {
    const touch = { x: 360, y: 540 };
    const corner = { x: w, y: h };
    const g = simGeometry(touch, corner, w, h);
    expect(g).not.toBeNull();
    expect(simLayerFrame({ touch, corner }, w, h)).toEqual(simFrame(g!, w, h));
  });

  it("裁剪是视口坐标的 path()；③ 用 curl 在视口内的补集；背面是镜像矩阵", () => {
    const frame = simLayerFrame({ touch: { x: 200, y: 450 }, corner: { x: w, y: h } }, w, h);
    expect(frame).not.toBeNull();
    expect(frame!.clip.curl).toMatch(/^path\("M/);
    expect(frame!.clip.curlOutside).toMatch(/^path\(evenodd, "M0 0 L400\.00 0 L400\.00 600\.00 L0 600\.00 Z M/);
    for (const key of ["reveal", "back", "front1", "front2"] as const) {
      expect(frame!.clip[key]).toMatch(/^path\("M[^"]*Z"\)$/);
    }
    expect(frame!.mirror).toMatch(/^matrix\(/);
  });

  it("没有卷起角、触点距卷起角不足 1px 时按平整页绘制", () => {
    expect(simLayerFrame({ touch: { x: 200, y: 450 }, corner: null }, w, h)).toBeNull();
    // NEXT 取消回到原页角、PREV 完成展开到右下角的末帧
    expect(simLayerFrame({ touch: { x: w, y: h }, corner: { x: w, y: h } }, w, h)).toBeNull();
    expect(simLayerFrame({ touch: { x: w - 0.5, y: 0 }, corner: { x: w, y: 0 } }, w, h)).toBeNull();
  });

  it("NEXT 完成的末帧（卷起角移出左侧）与 PREV 取消的末帧仍有几何，卷起部分落在视口外", () => {
    for (const corner of [
      { x: w, y: h },
      { x: w, y: 0 },
    ]) {
      const touch = { x: -w, y: corner.y > 0 ? h : 1 };
      expect(simLayerFrame({ touch, corner }, w, h)).not.toBeNull();
    }
  });
});

describe("stripMatrix / stripStyle：渐变条", () => {
  const strip: SimShadowStrip = {
    left: 30,
    top: 40,
    width: 25,
    height: 700,
    rotate: 0,
    originX: 0,
    originY: 0,
    direction: "to right",
  };

  it("不旋转时就是平移到 (left, top)", () => {
    const m = stripMatrix(strip);
    expect(applyMatrix(m, 0, 0)).toEqual({ x: 30, y: 40 });
    expect(applyMatrix(m, 25, 700)).toEqual({ x: 55, y: 740 });
  });

  it("绕 (left + originX, top + originY) 旋转：旋转中心不动，条内其余点按角度转过去", () => {
    const s: SimShadowStrip = { ...strip, rotate: 90, originX: 25, originY: 0 };
    const m = stripMatrix(s);
    const pivot = applyMatrix(m, 25, 0);
    expect(pivot.x).toBeCloseTo(55, 9);
    expect(pivot.y).toBeCloseTo(40, 9);
    // 局部 (25, 10) 在旋转中心正下方 10px，顺时针转 90° 后落到它左侧 10px
    const below = applyMatrix(m, 25, 10);
    expect(below.x).toBeCloseTo(45, 9);
    expect(below.y).toBeCloseTo(40, 9);
  });

  it("竖直折线时第二条前景阴影的旋转中心远在视口外，合成后的平移仍落在触点附近", () => {
    const w = 400;
    const h = 600;
    const touch = { x: 100, y: h }; // PREV / 中间带：触点钉在卷起角所在的下边
    const frame = simLayerFrame({ touch, corner: { x: w, y: h } }, w, h);
    expect(frame).not.toBeNull();
    const s = frame!.frontShadow2;
    expect(Math.abs(s.top)).toBeGreaterThan(1e5);
    const m = stripMatrix(s);
    const pivot = applyMatrix(m, s.originX, s.originY);
    expect(pivot.x).toBeCloseTo(s.left + s.originX, 3);
    expect(pivot.y).toBeCloseTo(s.top + s.originY, 3);
    expect(Math.hypot(m[4] - touch.x, m[5] - touch.y)).toBeLessThan(Math.hypot(w, h));
  });

  it("stripStyle：尺寸、合成矩阵与「阴影色 → 透明」的渐变", () => {
    const style = stripStyle({ ...strip, direction: "to left" }, "var(--turn-fold-shadow)");
    expect(style.width).toBe("25px");
    expect(style.height).toBe("700px");
    expect(style.transform).toMatch(/^matrix\(1, 0, -?0, 1, 30, 40\)$/);
    expect(style.backgroundImage).toBe("linear-gradient(to left, var(--turn-fold-shadow), transparent)");
  });
});

describe("SimulationLayers：仿真叠加层的静态结构", () => {
  function renderLayers(): string {
    const chapter = firstChapter();
    const starts = [0, chapter.paras[0].offset + 2];
    return renderToStaticMarkup(
      <SimulationLayers
        els={emptySimElements()}
        chapter={chapter}
        view={pageView(chapter.paras, starts, 0)}
        typography={typography}
        highlight={null}
        pageIndex={0}
        pageCount={starts.length}
        pageStart={0}
      />,
    ).replace(/<!-- -->/g, "");
  }

  it("三组外层：② 背面阴影、④ 前景阴影、⑤ 背面，按 SIM_Z 叠放，首帧前隐藏", () => {
    const outer = [
      ...renderLayers().matchAll(/<div aria-hidden="true" class="absolute inset-0 pointer-events-none" style="([^"]*)"/g),
    ].map((m) => m[1]);
    expect(outer).toEqual([
      `contain:strict;z-index:${SIM_Z.backShadow};visibility:hidden`,
      `contain:strict;z-index:${SIM_Z.frontShadow};visibility:hidden`,
      `contain:strict;z-index:${SIM_Z.back};visibility:hidden`,
    ]);
  });

  it("每组外层里嵌一层（④ 两层）铺满视口的裁剪包裹层，渐变条放在原点", () => {
    const html = renderLayers();
    const inner = html.match(/<div class="absolute inset-0 pointer-events-none" style="contain:strict">/g) ?? [];
    expect(inner).toHaveLength(4);
    const strips = html.match(/<div style="position:absolute;left:0;top:0;transform-origin:0 0"><\/div>/g) ?? [];
    expect(strips).toHaveLength(4);
  });

  it("⑤ 背面镜像副本：不透明页面底色、transform-origin 0 0、不可选中、aria-hidden，没有当前页钩子", () => {
    const html = renderLayers();
    const mirror = /<div class="absolute inset-0 overflow-hidden bg-\[var\(--bg\)\]"[^>]*>/.exec(html)?.[0] ?? "";
    expect(mirror).toContain("transform-origin:0 0");
    expect(mirror).toContain("user-select:none");
    expect(mirror).toContain('aria-hidden="true"');
    expect(mirror).not.toMatch(/data-(current|chapter-id|page-index|page-count|page-start)/);
    // 镜像的是卷起那一页的内容
    expect(html).toContain("甲乙");
  });
});

describe("applyNav / applyTable：程序化定位不改变阅读位置", () => {
  const table: PageTable = { chapterId: 2, layoutKey: "k", starts: [0, 10, 20] };

  it("导航保留页中偏移，页表就绪后显示包含它的页", () => {
    let s: PagedViewState = applyNav(null, { seq: 1, chapterId: 2, charOffset: 15 });
    expect(s.pos).toEqual({ chapterId: 2, charOffset: 15, page: 0 });
    s = applyTable(s, table);
    expect(s.pos).toEqual({ chapterId: 2, charOffset: 15, page: 1 });
  });

  it("指令与页表都没变时原样返回同一对象", () => {
    const s = applyTable(applyNav(null, { seq: 1, chapterId: 2, charOffset: 15 }), table);
    expect(applyNav(s, { seq: 1, chapterId: 2, charOffset: 15 })).toBe(s);
    expect(applyTable(s, table)).toBe(s);
  });

  it("同章导航（页表不变）也会按新偏移重算显示页", () => {
    const s = applyTable(applyNav(null, { seq: 1, chapterId: 2, charOffset: 15 }), table);
    const moved = applyTable(applyNav(s, { seq: 2, chapterId: 2, charOffset: 25 }), table);
    expect(moved.pos).toEqual({ chapterId: 2, charOffset: 25, page: 2 });
  });

  it("重分页只换显示页，偏移不动；别章的页表不参与", () => {
    const s = applyTable(applyNav(null, { seq: 1, chapterId: 2, charOffset: 15 }), table);
    const relaid = applyTable(s, { chapterId: 2, layoutKey: "k2", starts: [0, 30] });
    expect(relaid.pos).toEqual({ chapterId: 2, charOffset: 15, page: 0 });
    const other = applyTable(s, { chapterId: 3, layoutKey: "k", starts: [0, 5, 12] });
    expect(other.pos).toBe(s.pos);
  });
});

describe("wheelRoute：滚轮事件归谁处理", () => {
  it("正文上的普通滚轮由视图接管，送进滚轮闸门（需求 11.8）", () => {
    expect(wheelRoute({ ctrlKey: false, excluded: false })).toBe("turn");
  });

  it("Ctrl+滚轮留给浏览器缩放", () => {
    expect(wheelRoute({ ctrlKey: true, excluded: false })).toBe("browser");
    expect(wheelRoute({ ctrlKey: true, excluded: true })).toBe("browser");
  });

  it("落在 <main> 内可交互元素上的滚轮交给浏览器（需求 11.9）", () => {
    expect(wheelRoute({ ctrlKey: false, excluded: true })).toBe("browser");
  });
});
