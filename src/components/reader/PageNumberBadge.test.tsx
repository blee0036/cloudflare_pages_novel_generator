import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PageNumberBadge } from "./PageNumberBadge";

/**
 * `PageNumberBadge` 的静态标记（任务 18.8，需求 2.9）。项目不搭 jsdom，这里用服务端渲染出 HTML
 * 字符串后直接检查标记；随底栏滑入滑出与对比度由 e2e 覆盖。
 */

function attr(tag: string, name: string): string | undefined {
  return new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1];
}

describe("PageNumberBadge", () => {
  it("没有页码时什么也不渲染（当前章未分页或滚动模式）", () => {
    expect(renderToStaticMarkup(<PageNumberBadge info={null} />)).toBe("");
  });

  it("可见文字为从 1 起算的 x / y，并附视觉隐藏的完整说法", () => {
    const html = renderToStaticMarkup(<PageNumberBadge info={{ index: 0, count: 3 }} />);
    expect(html).toContain('<span aria-hidden="true">1 / 3</span>');
    expect(html).toContain('<span class="sr-only">本章第 1 页，共 3 页</span>');

    const last = renderToStaticMarkup(<PageNumberBadge info={{ index: 11, count: 12 }} />);
    expect(last).toContain(">12 / 12</span>");
    expect(last).toContain(">本章第 12 页，共 12 页</span>");
  });

  it("绝对定位在底栏右上方、不拦截指针，配色取底栏的 --bg / --text-muted / --border", () => {
    const html = renderToStaticMarkup(<PageNumberBadge info={{ index: 1, count: 2 }} />);
    const outer = /^<div[^>]*>/.exec(html)?.[0] ?? "";
    const cls = (attr(outer, "class") ?? "").split(/\s+/);
    for (const c of [
      "pointer-events-none",
      "absolute",
      "-top-7",
      "right-4",
      "bg-[var(--bg)]",
      "text-[var(--text-muted)]",
      "border-[var(--border)]",
    ]) {
      expect(cls).toContain(c);
    }
    // 不是实时区域：每翻一页都播报会太吵
    expect(outer).not.toContain("role=");
    expect(outer).not.toContain("aria-live");
  });
});
