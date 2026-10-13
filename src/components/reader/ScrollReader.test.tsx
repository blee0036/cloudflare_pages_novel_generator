import type { RefObject } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { BookToc, ChapterMeta, ReaderSettings } from "../../types";
import { bodyParagraphs, buildChapterViews, splitParagraphs } from "../../utils/locator";
import { ScrollReader } from "./ScrollReader";
import type { HighlightTarget, NavRequest } from "./types";

/**
 * `ScrollReader` 的静态标记（任务 16.1）。项目不搭 jsdom，这里用服务端渲染出首帧 HTML 检查结构；
 * 测量、窗口重算、`data-current` 都发生在 layout effect 里，由 e2e 覆盖。
 *
 * 服务端没有窗口，视口高度按 0 计，首帧窗口恰为"导航目标章 ± 1"（`chapterWindow` 第 1 步），
 * 断言因此是确定的。
 */

// 第 1 卷是卷节点（只有标题行），其余是正文章节；正文序号 0 1 2 3 对应章号 0 2 3 4
const SOURCES: { title: string; text: string; isVolume?: boolean }[] = [
  { title: "第一章 起", text: "第一章 起\n\u3000\u3000甲乙丙\n丁戊\n" },
  { title: "第一卷", text: "第一卷\n", isVolume: true },
  { title: "第二章 承", text: "第二章 承\n己庚\n" },
  { title: "第三章 转", text: "第三章 转\n\n辛壬\n癸子\n" },
  { title: "第四章 合", text: "第四章 合\n丑寅\n" },
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
  totalChapters: 4,
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
  pageAnim: 3,
};

const noop = () => {};

function render(chapterId: number, highlight: HighlightTarget | null = null): string {
  const nav: NavRequest = { seq: 1, chapterId, charOffset: 0 };
  const positionRef: RefObject<{ chapterId: number; charOffset: number }> = {
    current: { chapterId, charOffset: 0 },
  };
  const html = renderToStaticMarkup(
    <ScrollReader
      toc={toc}
      fullText={fullText}
      views={views}
      settings={settings}
      positionRef={positionRef}
      nav={nav}
      highlight={highlight}
      controlsVisible={false}
      onPosition={noop}
      onControls={noop}
      onBoundary={noop}
    />,
  );
  return html.replace(/<!-- -->/g, "");
}

/** 每个区段：章号与内部 HTML。 */
function sections(html: string): { chapterId: number; inner: string }[] {
  return Array.from(html.matchAll(/<section[^>]*data-chapter-id="(\d+)"[^>]*>([\s\S]*?)<\/section>/g), (m) => ({
    chapterId: Number(m[1]),
    inner: m[2],
  }));
}

const stripTags = (html: string) => html.replace(/<[^>]+>/g, "");

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

describe("ScrollReader：视图结构", () => {
  it("<main> 是滚动容器：保留 relative，关闭原生 scroll anchoring，触摸只交出纵向平移与缩放", () => {
    const main = /^<main[^>]*>/.exec(render(3))?.[0] ?? "";
    expect(main).toContain('data-page-mode="scroll"');
    expect(main).toContain(
      'class="relative flex-1 min-h-0 overflow-y-auto pb-28 px-4 sm:px-8 ' +
        'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--accent)]"',
    );
    expect(main).toContain("overflow-anchor:none");
    expect(main).toContain("touch-action:pan-y pinch-zoom");
  });

  it("<main> 进 Tab 序列（滚动区里没有别的可聚焦内容），焦点圈只挂在 focus-visible 上", () => {
    const main = /^<main[^>]*>/.exec(render(3))?.[0] ?? "";
    expect(main).toContain('tabindex="0"');
    // `focus:outline-none` 会把 Tailwind v4 的 `--tw-outline-style` 置为 none，键盘焦点圈随之消失
    expect(main).not.toMatch(/(?:^|\s|")focus:outline-none/);
  });

  it("每章一个区段：pt-16 pb-8、章间分隔线、无定位属性，区段内是带标题区的 <article>", () => {
    const html = render(3);
    const tags = Array.from(html.matchAll(/<section[^>]*>/g), (m) => m[0]);
    expect(tags.length).toBe(3);
    for (const tag of tags) {
      expect(tag).toContain('class="pt-16 pb-8 [&amp;+&amp;]:border-t border-[var(--border)]"');
      expect(tag).not.toMatch(/relative|absolute|fixed|sticky/);
    }
    for (const { inner } of sections(html)) {
      expect(inner).toMatch(/^<article/);
      expect(inner).toContain("<header");
    }
  });

  it("挂载导航目标章 ± 1，跳过卷节点；「第 N / 共 M 章」按正文序号", () => {
    expect(sections(render(3)).map((s) => s.chapterId)).toEqual([2, 3, 4]);
    // 书首：没有上一章；章号 1 是卷节点，不挂载
    expect(sections(render(0)).map((s) => s.chapterId)).toEqual([0, 2]);
    // 导航到卷节点按"其后第一个正文章节"归一
    expect(sections(render(1)).map((s) => s.chapterId)).toEqual([0, 2, 3]);

    const meta = sections(render(3)).map((s) => /第 \d+ \/ \d+ 章/.exec(stripTags(s.inner))?.[0]);
    expect(meta).toEqual(["第 2 / 4 章", "第 3 / 4 章", "第 4 / 4 章"]);
  });

  it("段落与 ReaderPage 同源：跳过标题行，data-offset 即章内偏移", () => {
    for (const { chapterId, inner } of sections(render(3))) {
      const meta = chapters[chapterId];
      const expected = bodyParagraphs(splitParagraphs(fullText.slice(meta.start, meta.end)), meta.title);
      const offsets = Array.from(inner.matchAll(/<p[^>]*data-offset="(\d+)"/g), (m) => Number(m[1]));
      expect(offsets).toEqual(expected.map((p) => p.offset));
      expect(expected.length).toBeGreaterThan(0);
    }
  });

  it("首帧不渲染 data-current（由 layout effect 直接写 DOM 属性）", () => {
    expect(render(3)).not.toContain("data-current");
  });

  it("检索高亮只渲染在命中所属章的区段里", () => {
    // 第三章"辛"的章内偏移（标题行与空行之后）
    const html = render(3, { chapterId: 3, charOffset: SOURCES[3].text.indexOf("辛"), length: 1 });
    const marks = sections(html).map((s) => (s.inner.match(/<mark/g) ?? []).length);
    expect(marks).toEqual([0, 1, 0]);
    expect(html).toMatch(/<mark[^>]*>辛<\/mark>壬/);

    // 不在窗口内的章的高亮不出现
    expect(render(3, { chapterId: 0, charOffset: 0, length: 1 })).not.toContain("<mark");
  });
});
