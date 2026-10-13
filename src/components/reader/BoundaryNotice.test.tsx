import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BOUNDARY_NOTICE_MS, NOTICE_IDLE, noticeStep } from "../../utils/turnInput";
import { BoundaryNotice } from "./BoundaryNotice";

/**
 * `BoundaryNotice` 的静态标记（任务 14.4）。项目不搭 jsdom，这里用服务端渲染出 HTML 字符串后
 * 直接检查标记；定位与读屏播报由 e2e 覆盖。显示与到期规则见 `turnInput.test.ts`（Property 8）。
 */

/** 实时区域元素的开标签与内部 HTML。 */
function liveRegion(html: string): { open: string; inner: string } {
  const match = /(<div[^>]*role="status"[^>]*>)([\s\S]*?)<\/div>/.exec(html);
  if (!match) throw new Error(`缺少 role="status" 的实时区域：${html}`);
  return { open: match[1], inner: match[2] };
}

function attr(tag: string, name: string): string | undefined {
  return new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1];
}

describe("BoundaryNotice", () => {
  it("没有提示时实时区域仍在 DOM 中，但为空且不带任何盒子样式", () => {
    const { open, inner } = liveRegion(renderToStaticMarkup(<BoundaryNotice text={null} />));
    expect(attr(open, "aria-live")).toBe("polite");
    expect(attr(open, "aria-atomic")).toBe("true");
    expect(attr(open, "class")).toBeUndefined();
    expect(inner).toBe("");
  });

  it("有提示时同一个实时区域写入文字，并用 --card-bg / --text / --border 配色", () => {
    const shown = noticeStep(NOTICE_IDLE, { kind: "hit", direction: "next", t: 0 });
    const { open, inner } = liveRegion(renderToStaticMarkup(<BoundaryNotice text={shown.text} />));
    expect(inner).toBe("没有下一页");
    const cls = attr(open, "class") ?? "";
    expect(cls).toContain("bg-[var(--card-bg)]");
    expect(cls).toContain("text-[var(--text)]");
    expect(cls).toContain("border-[var(--border)]");

    const cleared = noticeStep(shown, { kind: "tick", t: BOUNDARY_NOTICE_MS });
    expect(liveRegion(renderToStaticMarkup(<BoundaryNotice text={cleared.text} />)).inner).toBe("");
  });

  it("外层定位壳不拦截指针，固定在底栏上方居中", () => {
    const html = renderToStaticMarkup(<BoundaryNotice text="没有上一页" />);
    const outer = /^<div[^>]*>/.exec(html)?.[0] ?? "";
    const cls = attr(outer, "class") ?? "";
    for (const c of ["pointer-events-none", "fixed", "bottom-20", "justify-center"]) {
      expect(cls).toContain(c);
    }
  });
});
