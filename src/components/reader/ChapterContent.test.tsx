import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { pageView } from "../../utils/paginate";
import { ChapterContent, type ChapterContentChapter, type ChapterTypography } from "./ChapterContent";
import type { HighlightTarget } from "./types";

/**
 * `ChapterContent` 的静态标记（任务 14.3）。项目不搭 jsdom，这里用服务端渲染出 HTML 字符串后
 * 直接检查标记；版式与交互由 e2e 覆盖。
 */

const chapter: ChapterContentChapter = {
  chapterId: 3,
  title: "第三章 风起",
  length: 42,
  position: 1,
  total: 5,
  // 章内偏移：第 0 段 [8, 13)，第 1 段 [15, 22)
  paras: [
    { offset: 8, text: "甲乙丙丁戊" },
    { offset: 15, text: "己庚辛壬癸子丑" },
  ],
};

const typography: ChapterTypography = {
  contentWidth: 720,
  fontFamily: "serif",
  fontSize: 19,
  lineHeight: 1.8,
  letterSpacing: 0.5,
};

/** 第 1 段在章内偏移 18 处被页界拆开：第 0 页 = 标题 + 第 0 段 + "己庚辛"，第 1 页 = "壬癸子丑"。 */
const STARTS = [0, 18];

const MARK_OPEN = '<mark class="animate-fade-in rounded bg-[rgba(234,179,8,0.3)] text-[var(--text)]">';

function hit(charOffset: number, length: number, chapterId = chapter.chapterId): HighlightTarget {
  return { chapterId, charOffset, length };
}

function render(node: ReactElement): string {
  // React 18 的静态渲染不插文本分隔注释，这里仍去一遍，断言不依赖该细节
  return renderToStaticMarkup(node).replace(/<!-- -->/g, "");
}

function articleOpenTag(html: string): string {
  const match = /^<article[^>]*>/.exec(html);
  if (!match) throw new Error(`应以 <article> 开头：${html}`);
  return match[0];
}

function styleOf(tag: string): string | undefined {
  return /style="([^"]*)"/.exec(tag)?.[1];
}

function headerOf(html: string): string | undefined {
  return /<header[\s\S]*?<\/header>/.exec(html)?.[0];
}

/** 每个 `<p>` 的开标签与内部 HTML。 */
function paragraphs(html: string): { open: string; inner: string }[] {
  return Array.from(html.matchAll(/(<p[^>]*>)([\s\S]*?)<\/p>/g), (m) => ({ open: m[1], inner: m[2] }));
}

function attr(tag: string, name: string): string | undefined {
  return new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1];
}

const stripTags = (html: string) => html.replace(/<[^>]+>/g, "");

describe("ChapterContent：三种变体共用版式", () => {
  const measure = render(<ChapterContent variant="measure" chapter={chapter} typography={typography} />);
  const scroll = render(
    <ChapterContent variant="scroll" chapter={chapter} typography={typography} highlight={null} />,
  );
  const page0 = render(
    <ChapterContent
      variant="page"
      chapter={chapter}
      typography={typography}
      view={pageView(chapter.paras, STARTS, 0)}
      highlight={null}
    />,
  );

  it("<article> 的行内排版样式相同，且包含五项排版设置", () => {
    const style = styleOf(articleOpenTag(measure));
    expect(style).toBeDefined();
    expect(styleOf(articleOpenTag(scroll))).toBe(style);
    expect(styleOf(articleOpenTag(page0))).toBe(style);
    expect(style).toContain("max-width:720px");
    expect(style).toContain("font-size:19px");
    expect(style).toContain("line-height:1.8");
    expect(style).toContain("letter-spacing:0.5px");
    expect(style).toContain("Source Han Serif SC");
  });

  it("标题区相同：章节标题与「第 N / M 章」", () => {
    const header = headerOf(measure);
    expect(header).toBeDefined();
    expect(headerOf(scroll)).toBe(header);
    expect(headerOf(page0)).toBe(header);
    expect(header).toContain("<h1");
    expect(header).toContain("第三章 风起");
    expect(stripTags(header ?? "")).toContain("第 2 / 5 章");
  });

  it("measure：没有 <mark>、没有过渡类名，每段只有段落文本", () => {
    expect(measure).not.toContain("<mark");
    expect(measure).not.toContain("transition");
    expect(paragraphs(measure).map((p) => p.inner)).toEqual(chapter.paras.map((p) => p.text));
  });

  it("scroll 与原内联渲染一致：版心带过渡、段落带颜色过渡", () => {
    expect(attr(articleOpenTag(scroll), "class")).toBe("mx-auto transition-all duration-150");
    expect(paragraphs(scroll).map((p) => attr(p.open, "class"))).toEqual([
      "indent-[2em] wrap-anywhere transition-colors select-text",
      "indent-[2em] wrap-anywhere transition-colors select-text",
    ]);
  });

  it("段落带 data-para（bodyParas 下标）与 data-offset（首字章内偏移）", () => {
    for (const html of [measure, scroll]) {
      expect(paragraphs(html).map((p) => [attr(p.open, "data-para"), attr(p.open, "data-offset")])).toEqual([
        ["0", "8"],
        ["1", "15"],
      ]);
    }
  });
});

describe("ChapterContent：scroll 变体", () => {
  it("本章高亮用 resolveHighlight 标出命中，前后文字保留", () => {
    const html = render(
      <ChapterContent variant="scroll" chapter={chapter} typography={typography} highlight={hit(10, 2)} />,
    );
    const ps = paragraphs(html);
    expect(ps[0].inner).toBe(`甲乙${MARK_OPEN}丙丁</mark>戊`);
    expect(ps[1].inner).toBe("己庚辛壬癸子丑");
  });

  it("别的章的高亮、落在标题行上的高亮都不渲染 <mark>", () => {
    for (const h of [hit(10, 2, 4), hit(2, 3)]) {
      const html = render(
        <ChapterContent variant="scroll" chapter={chapter} typography={typography} highlight={h} />,
      );
      expect(html).not.toContain("<mark");
    }
  });
});

describe("ChapterContent：page 变体", () => {
  const renderPage = (k: number, highlight: HighlightTarget | null = null) =>
    render(
      <ChapterContent
        variant="page"
        chapter={chapter}
        typography={typography}
        view={pageView(chapter.paras, STARTS, k)}
        highlight={highlight}
      />,
    );

  it("标题区只在第 0 页；页界处前段末行两端对齐、续段不缩进", () => {
    const page0 = renderPage(0);
    const page1 = renderPage(1);
    expect(headerOf(page0)).toBeDefined();
    expect(headerOf(page1)).toBeUndefined();

    const [whole, head] = paragraphs(page0);
    expect(styleOf(whole.open)).toBeUndefined();
    expect(head.inner).toBe("己庚辛");
    expect(styleOf(head.open)).toBe("text-align-last:justify");

    const [tail] = paragraphs(page1);
    expect(tail.inner).toBe("壬癸子丑");
    expect(styleOf(tail.open)).toBe("text-indent:0");
    expect([attr(tail.open, "data-para"), attr(tail.open, "data-offset")]).toEqual(["1", "18"]);
  });

  it("跨页拼接与整章正文逐字相同", () => {
    const text = [0, 1].flatMap((k) => paragraphs(renderPage(k)).map((p) => p.inner)).join("");
    expect(text).toBe(chapter.paras.map((p) => p.text).join(""));
  });

  it("命中被页界拆开时两页各标自己那一截（fragmentHighlight）", () => {
    // 命中 [17, 20) = "辛壬癸"，页界在 18
    expect(paragraphs(renderPage(0, hit(17, 3)))[1].inner).toBe(`己庚${MARK_OPEN}辛</mark>`);
    expect(paragraphs(renderPage(1, hit(17, 3)))[0].inner).toBe(`${MARK_OPEN}壬癸</mark>子丑`);
    expect(renderPage(1, hit(17, 3, 4))).not.toContain("<mark");
  });
});
