import { describe, expect, it } from "vitest";
import {
  DEFAULT_SITE_CONFIG,
  SiteConfig,
  documentTitleFor,
  faviconHref,
  faviconPublicPath,
  resolveSiteConfig,
  siteHtmlPlaceholderPattern,
  siteHtmlPlaceholders,
} from "./siteConfig";

/** 断言"这个字段回落到了默认值，且给出了告警" —— 逐字段回落是本模块的核心契约。 */
function expectFallback(
  raw: unknown,
  field: keyof SiteConfig,
  matcher: RegExp,
): readonly string[] {
  const { config, warnings } = resolveSiteConfig(raw);
  expect(config[field]).toEqual(DEFAULT_SITE_CONFIG[field]);
  expect(warnings.some((w) => matcher.test(w))).toBe(true);
  return warnings;
}

describe("resolveSiteConfig", () => {
  it("空对象即全部默认值，且不告警（配置文件可以只覆盖一两个字段）", () => {
    expect(resolveSiteConfig({})).toEqual({
      config: DEFAULT_SITE_CONFIG,
      warnings: [],
    });
  });

  it("只覆盖 name 时其余字段保持默认", () => {
    const { config, warnings } = resolveSiteConfig({ name: "老张的书架" });

    expect(warnings).toEqual([]);
    expect(config).toEqual({ ...DEFAULT_SITE_CONFIG, name: "老张的书架" });
  });

  it("字符串字段去首尾空白", () => {
    const { config } = resolveSiteConfig({ name: "  老张的书架\n" });
    expect(config.name).toBe("老张的书架");
  });

  it("顶层不是对象时整份回落，并说明实际类型", () => {
    for (const raw of [null, ["a"], 42, "site"]) {
      const { config, warnings } = resolveSiteConfig(raw);
      expect(config).toEqual(DEFAULT_SITE_CONFIG);
      expect(warnings).toHaveLength(1);
    }
    expect(resolveSiteConfig(null).warnings[0]).toMatch(/null/);
    expect(resolveSiteConfig([]).warnings[0]).toMatch(/数组/);
  });

  it("字段类型写错只影响该字段", () => {
    const { config, warnings } = resolveSiteConfig({ name: 42, description: "还在" });

    expect(config.name).toBe(DEFAULT_SITE_CONFIG.name);
    expect(config.description).toBe("还在");
    expect(warnings).toHaveLength(1);
  });

  it("空白字符串视为写错，回落到默认值", () => {
    expectFallback({ name: "   " }, "name", /空白/);
  });

  it("键名拼错时告警而不是静默忽略", () => {
    const { config, warnings } = resolveSiteConfig({ siteName: "老张的书架" });

    expect(config).toEqual(DEFAULT_SITE_CONFIG);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/siteName/);
  });

  it("keywords 收数组，也收（中英文）逗号分隔的字符串", () => {
    expect(resolveSiteConfig({ keywords: ["小说", " 阅读 "] }).config.keywords).toEqual([
      "小说",
      "阅读",
    ]);
    expect(resolveSiteConfig({ keywords: "小说, 阅读，电子书" }).config.keywords).toEqual([
      "小说",
      "阅读",
      "电子书",
    ]);
  });

  it("显式的空 keywords 是合法表达（这个站不要关键词），不告警", () => {
    const { config, warnings } = resolveSiteConfig({ keywords: [] });
    expect(config.keywords).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("keywords 里的非字符串项被丢弃并告警", () => {
    const { config, warnings } = resolveSiteConfig({ keywords: ["小说", 7, "", null] });
    expect(config.keywords).toEqual(["小说"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/3 项/);
  });

  it("keywords 类型完全对不上时回落到默认值", () => {
    expectFallback({ keywords: { a: 1 } }, "keywords", /keywords/);
  });

  it("favicon 保留 data URI 与绝对 URL", () => {
    for (const value of [
      "data:image/svg+xml,%3Csvg%3E%3C/svg%3E",
      "https://cdn.example.com/i.png",
      "//cdn.example.com/i.png",
    ]) {
      const { config, warnings } = resolveSiteConfig({ favicon: value });
      expect(config.favicon).toBe(value);
      expect(warnings).toEqual([]);
    }
  });

  it("favicon 接受 public/ 下的相对路径，两种写法都行", () => {
    expect(resolveSiteConfig({ favicon: "/favicon.svg" }).config.favicon).toBe("/favicon.svg");
    expect(resolveSiteConfig({ favicon: "icons/book.png" }).config.favicon).toBe(
      "icons/book.png",
    );
  });

  it("favicon 不接受越出 public/ 的路径、反斜杠与纯斜杠", () => {
    expectFallback({ favicon: "../secret/i.png" }, "favicon", /\.\./);
    expectFallback({ favicon: "icons\\book.png" }, "favicon", /正斜杠/);
    expectFallback({ favicon: "/" }, "favicon", /文件名/);
  });
});

describe("documentTitleFor", () => {
  it("没有书名时就是站点名（书架、以及书还没加载完的阅读器）", () => {
    expect(documentTitleFor("老张的书架")).toBe("老张的书架");
    expect(documentTitleFor("老张的书架", null)).toBe("老张的书架");
    expect(documentTitleFor("老张的书架", "   ")).toBe("老张的书架");
  });

  it("有书名时书名在前（标签页被截断时留下的是那个能分辨的词）", () => {
    expect(documentTitleFor("老张的书架", "从零开始")).toBe("从零开始 - 老张的书架");
  });

  it("书名去首尾空白", () => {
    expect(documentTitleFor("老张的书架", " 从零开始 ")).toBe("从零开始 - 老张的书架");
  });

  it("站点名为空白时兜回内置默认站名，不产出空标题", () => {
    expect(documentTitleFor("")).toBe(DEFAULT_SITE_CONFIG.name);
    expect(documentTitleFor("  ", "从零开始")).toBe(`从零开始 - ${DEFAULT_SITE_CONFIG.name}`);
  });
});

describe("faviconPublicPath / faviconHref", () => {
  it("外部地址没有对应文件，原样进 href", () => {
    expect(faviconPublicPath("data:image/svg+xml,%3Csvg%3E")).toBeNull();
    expect(faviconPublicPath("https://cdn.example.com/i.png")).toBeNull();
    expect(faviconHref("https://cdn.example.com/i.png")).toBe("https://cdn.example.com/i.png");
  });

  it("本地路径归一成 public/ 下的相对路径，href 补前导斜杠", () => {
    expect(faviconPublicPath("/favicon.svg")).toBe("favicon.svg");
    expect(faviconPublicPath("icons/book.png")).toBe("icons/book.png");
    expect(faviconHref("icons/book.png")).toBe("/icons/book.png");
    expect(faviconHref("/favicon.svg")).toBe("/favicon.svg");
  });
});

describe("siteHtmlPlaceholders", () => {
  const config: SiteConfig = {
    name: "张三 & 李四的书架",
    description: '带"引号"与 <标签> 的简介',
    keywords: ["小说", "阅读"],
    favicon: "/favicon.svg",
  };

  it("转义会破坏 HTML 结构的字符", () => {
    const values = siteHtmlPlaceholders(config);

    expect(values["%SITE_NAME%"]).toBe("张三 &amp; 李四的书架");
    expect(values["%SITE_DESCRIPTION%"]).toBe("带&quot;引号&quot;与 &lt;标签&gt; 的简介");
  });

  it("关键词以逗号连接，favicon 给出最终 href", () => {
    const values = siteHtmlPlaceholders(config);

    expect(values["%SITE_KEYWORDS%"]).toBe("小说,阅读");
    expect(values["%SITE_FAVICON%"]).toBe("/favicon.svg");
  });

  it("默认 favicon 已百分号编码，不会被转义改写", () => {
    const values = siteHtmlPlaceholders(DEFAULT_SITE_CONFIG);
    expect(values["%SITE_FAVICON%"]).toBe(DEFAULT_SITE_CONFIG.favicon);
  });

  it("占位符集合与 index.html 里用到的四个一致", () => {
    expect(Object.keys(siteHtmlPlaceholders(config)).sort()).toEqual([
      "%SITE_DESCRIPTION%",
      "%SITE_FAVICON%",
      "%SITE_KEYWORDS%",
      "%SITE_NAME%",
    ]);
  });
});

describe("siteHtmlPlaceholderPattern", () => {
  it("替换全部占位符，认不出的原样留下", () => {
    const html = `<title>%SITE_NAME%</title><meta content="%SITE_TYPO%"><link href="%SITE_FAVICON%">`;
    const values = siteHtmlPlaceholders(DEFAULT_SITE_CONFIG);

    const out = html.replace(
      siteHtmlPlaceholderPattern(),
      (token) => values[token] ?? token,
    );

    expect(out).toContain(`<title>${DEFAULT_SITE_CONFIG.name}</title>`);
    expect(out).toContain(`href="${DEFAULT_SITE_CONFIG.favicon}"`);
    expect(out).toContain("%SITE_TYPO%");
  });

  it("每次调用给出独立的正则，不共享 lastIndex", () => {
    const values = siteHtmlPlaceholders(DEFAULT_SITE_CONFIG);
    const once = () =>
      "%SITE_NAME%".replace(siteHtmlPlaceholderPattern(), (t) => values[t] ?? t);

    expect(once()).toBe(DEFAULT_SITE_CONFIG.name);
    expect(once()).toBe(DEFAULT_SITE_CONFIG.name);
  });
});
