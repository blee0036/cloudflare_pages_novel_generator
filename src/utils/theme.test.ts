import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReaderThemeKey } from "../types";
import { READER_THEMES, THEME_ATTRIBUTE, applyTheme, initTheme } from "./theme";

/**
 * 最小 `<html>` 替身。`theme.ts` 只用到 `document.documentElement.setAttribute`，
 * 一个记事本对象就够——所以这组断言**不需要 jsdom**，仍落在 design §11 划定的
 * "只测纯 TS 逻辑"范围内（组件与真实 DOM 渲染测试不在范围内）。
 */
function fakeDocument() {
  const attrs = new Map<string, string>();
  return {
    attrs,
    documentElement: {
      setAttribute: (name: string, value: string) => {
        attrs.set(name, value);
      },
    },
  };
}

/** 最小 localStorage 替身，与 `storage.test.ts` 同一套路。 */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, String(v));
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    clear: () => {
      map.clear();
    },
  } as Storage;
}

const host = globalThis as unknown as {
  document?: ReturnType<typeof fakeDocument>;
  localStorage?: Storage;
};

const SETTINGS_KEY = "koodo_novel_reader_settings";

const THEME_KEYS: ReaderThemeKey[] = READER_THEMES.map((t) => t.key);

beforeEach(() => {
  host.document = fakeDocument();
  host.localStorage = memoryStorage();
});

afterEach(() => {
  delete host.document;
  delete host.localStorage;
});

describe("applyTheme", () => {
  it("把主题键写到根元素的 data-theme 上", () => {
    applyTheme("black");

    expect(THEME_ATTRIBUTE).toBe("data-theme");
    expect(host.document!.attrs.get("data-theme")).toBe("black");
  });

  it("五套主题都能写出，且写的就是主题键本身（CSS 选择器按它匹配）", () => {
    for (const key of THEME_KEYS) {
      applyTheme(key);
      expect(host.document!.attrs.get("data-theme")).toBe(key);
    }
  });

  it("切换主题是覆盖而非追加，根元素上始终只有一个主题", () => {
    applyTheme("sepia");
    applyTheme("eyecare");

    expect(host.document!.attrs.get("data-theme")).toBe("eyecare");
    expect(host.document!.attrs.size).toBe(1);
  });

  it("宿主没有 document 时静默跳过，不把环境差异甩给调用方", () => {
    delete host.document;

    expect(() => applyTheme("dark")).not.toThrow();
  });
});

describe("initTheme", () => {
  it("用持久化的主题初始化，而不是 CSS 里的裸 :root 兜底值", () => {
    host.localStorage!.setItem(SETTINGS_KEY, JSON.stringify({ theme: "black" }));

    initTheme();

    expect(host.document!.attrs.get("data-theme")).toBe("black");
  });

  it("没有存储记录时落到默认设置的主题（sepia），不留空属性", () => {
    initTheme();

    expect(host.document!.attrs.get("data-theme")).toBe("sepia");
  });
});

/**
 * 任务 44 起，颜色取值只存在于 `src/index.css`（需求 6.1）——TS 侧再没有 `THEME_CONFIGS`
 * 可供逐位比对，"CSS 的取值与 TS 的取值一致"这条断言连同它的基准一起退场。
 *
 * 剩下这组断言换了对象：不管颜色**是什么**，只管主题机制的**结构**是否完整。三条都是
 * 类型检查看不见、肉眼也难发现的失效模式：
 *
 * 1. 某套主题漏声明一个变量 → 该变量沿用 `:root`（默认明亮）的值，于是极夜纯黑下
 *    出现一块浅灰卡片。单看 CSS 很难发现，因为它语法完全合法。
 * 2. CSS 的主题块与设置面板的 `READER_THEMES` 对不上 → 面板少一个色块，或某个色块
 *    点下去后页面没有对应的变量块（退化到默认明亮）。
 * 3. 选择器写回 `:root[data-theme=...]` → 面板的五个色块全部变成当前主题的同一种颜色
 *    （它们靠在普通元素上重声明变量来预览别的主题）。
 */
describe("index.css 的主题机制", () => {
  // 去掉注释再断言：文件头那段说明里就写着 `:root[data-theme="..."]`（解释为什么**不**这么
  // 写），拿原文匹配会被自己的文档绊倒。
  const css = readFileSync(new URL("../index.css", import.meta.url), "utf-8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );

  /** 每套主题都必须自带的全套变量（缺一个就会串到 `:root` 的兜底值上）。 */
  const REQUIRED_VARS = ["--bg", "--text", "--border", "--accent", "--card-bg"];

  /**
   * 取出以 `[data-theme="key"]` 为（其中一条）选择器的那个块的声明体。
   *
   * 前置的 `(^|[,\s])` 不只是为了容错：它要求该属性选择器**独立成一条复合选择器**，
   * 即不能写成 `:root[data-theme="..."]`——那样只有根元素匹配，色块预览就没了。
   */
  function themeBlock(key: ReaderThemeKey): string {
    const block = css.match(
      new RegExp(`(?:^|[,\\s])\\[data-theme="${key}"\\]\\s*\\{([^}]*)\\}`, "m"),
    );
    expect(block, `缺少 ${key} 的变量块`).not.toBeNull();
    return block![1];
  }

  /** 该块里声明的自定义属性（`color-scheme` 一类的普通属性不计入）。 */
  function themeVars(key: ReaderThemeKey): Record<string, string> {
    const vars: Record<string, string> = {};
    for (const [, name, value] of themeBlock(key).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      vars[name] = value.trim();
    }
    return vars;
  }

  /**
   * 各主题期望的 `color-scheme`（任务 45）。UA 自己画的那部分——原生 range 滑杆、
   * Firefox 滚动条、根画布底色——按它走，所以它必须跟主题的明暗一致，而不是
   * `light dark`（那是"交给系统偏好挑"，需求 6 要消掉的最后一处系统驱动）。
   */
  const EXPECTED_COLOR_SCHEME: Record<ReaderThemeKey, "light" | "dark"> = {
    default: "light",
    sepia: "light",
    eyecare: "light",
    dark: "dark",
    black: "dark",
  };

  it("五套主题各有一块，且每块都声明了全套变量（不靠 :root 兜底）", () => {
    for (const key of THEME_KEYS) {
      const vars = themeVars(key);
      expect(Object.keys(vars).sort(), key).toEqual([...REQUIRED_VARS].sort());
      for (const name of REQUIRED_VARS) {
        expect(vars[name], `${key} 的 ${name}`).not.toBe("");
      }
    }
  });

  it("CSS 里的主题块与设置面板的主题列表一一对应", () => {
    const inCss = [...css.matchAll(/\[data-theme="([\w-]+)"\]/g)].map(([, key]) => key);

    expect([...new Set(inCss)].sort()).toEqual([...THEME_KEYS].sort());
  });

  it("主题块不限定在 :root 上，任何元素带 data-theme 都能局部换色", () => {
    // 设置抽屉的五个主题色块依赖这一点（它们要同时显示五套配色）
    expect(css).not.toMatch(/:root\[data-theme=/);
  });

  it("裸 :root 与 default 共用一块，作为属性未写上时的兜底", () => {
    expect(css).toMatch(/:root,\s*\[data-theme="default"\]\s*\{/);
  });

  it("每套主题的 color-scheme 与其明暗一致，且不把选择权交回系统偏好", () => {
    for (const key of THEME_KEYS) {
      expect(themeBlock(key), `${key} 的 color-scheme`).toMatch(
        new RegExp(`color-scheme:\\s*${EXPECTED_COLOR_SCHEME[key]}\\s*;`),
      );
    }

    // `light dark` = 由系统偏好二选一，与 data-theme 无关，任务 45 已移除
    expect(css).not.toMatch(/color-scheme:\s*light\s+dark/);
  });

  it("定义了派生量 --hover，且由 --text 派生而非写死黑白", () => {
    expect(css).toMatch(/--hover:\s*color-mix\(in srgb, var\(--text\) 8%, transparent\)/);
  });
});
