import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ReaderThemeKey } from "../types";
import { type Rgb, contrastRatio, mixSrgb, parseHex, relativeLuminance, toHsl } from "./contrast";
import { READER_THEMES } from "./theme";

/**
 * 调色板核对（F-010；需求 12.2–12.5、9.1；design §8、§11）。
 *
 * 读 `src/index.css`：`[data-theme="<键>"]` 块给出每套主题的 5 个基础变量；裸 `:root` 块里的
 * `color-mix()` 给出派生量（`--selected`、`--text-muted`），派生量的百分比从 CSS 里解析，
 * 不在这里写死。"旧值"是 Start_Snapshot 所记提交中的取值，以常量写在下面（测试运行时
 * 不调用 git）。
 *
 * 口径：
 *
 * - 对比度按 WCAG 2.1 相对亮度公式（`contrast.ts`）。派生量按浮点通道参与计算，不取整到 8 位。
 * - "明暗关系"（12.3）按相对亮度比较：新旧颜色都比本主题 `--bg` 暗，或都比它亮。
 * - 色相差取圆周上的较短弧（355° 与 5° 相差 10°）；新旧颜色的 HSL 饱和度均 ≥ 10% 时才比较。
 * - 12.3 只约束 D5 允许修改的 `--text`、`--accent`、`--border`；对未修改的变量，两条约束
 *   自然成立，这里不区分改没改，五套主题的三个变量一律核对。
 */

/** Start_Snapshot（`.kiro/specs/reader-defect-fixes/start-snapshot.json`）记下的 `HEAD`。 */
const SNAPSHOT_COMMIT = "7344b7cbffa12dc9ea0cef1e6e128f9d7e7f2837";

type BaseVar = "--bg" | "--text" | "--border" | "--accent" | "--card-bg";

interface SnapshotTheme {
  readonly key: ReaderThemeKey;
  readonly name: string;
  /** 该主题块在快照中的 `color-scheme`。 */
  readonly scheme: "light" | "dark";
  readonly palette: Readonly<Record<BaseVar, string>>;
}

/**
 * 快照提交中的 `READER_THEMES`（`src/utils/theme.ts`）与 `src/index.css` 各主题块的取值，
 * 由 `git show <SNAPSHOT_COMMIT>:src/utils/theme.ts` 与 `git show <SNAPSHOT_COMMIT>:src/index.css`
 * 抄录，顺序同快照中的 `READER_THEMES`。
 */
const SNAPSHOT_THEMES: readonly SnapshotTheme[] = [
  {
    key: "default",
    name: "默认明亮",
    scheme: "light",
    palette: {
      "--bg": "#ffffff",
      "--text": "#1f2937",
      "--border": "#e5e7eb",
      "--accent": "#3b82f6",
      "--card-bg": "#f9fafb",
    },
  },
  {
    key: "sepia",
    name: "复古羊皮",
    scheme: "light",
    palette: {
      "--bg": "#f8f1e3",
      "--text": "#523c21",
      "--border": "#ebd9bf",
      "--accent": "#b45309",
      "--card-bg": "#f2e6d0",
    },
  },
  {
    key: "eyecare",
    name: "护眼豆绿",
    scheme: "light",
    palette: {
      "--bg": "#eaf3e8",
      "--text": "#244228",
      "--border": "#d1e4cf",
      "--accent": "#15803d",
      "--card-bg": "#dff0dc",
    },
  },
  {
    key: "dark",
    name: "暗色夜间",
    scheme: "dark",
    palette: {
      "--bg": "#1e2430",
      "--text": "#cbd5e1",
      "--border": "#334155",
      "--accent": "#60a5fa",
      "--card-bg": "#283141",
    },
  },
  {
    key: "black",
    name: "极夜纯黑",
    scheme: "dark",
    palette: {
      "--bg": "#000000",
      "--text": "#9ca3af",
      "--border": "#262626",
      "--accent": "#38bdf8",
      "--card-bg": "#121212",
    },
  },
];

/** D5 允许修改、受 12.3 约束的变量。 */
const MODIFIABLE_VARS = ["--text", "--accent", "--border"] as const;

/** 需要可读的前景（12.4）与它们要对照的两种底色。 */
const FOREGROUND_VARS = ["--text", "--accent"] as const;
const BACKGROUND_VARS = ["--bg", "--card-bg"] as const;

/** 由裸 `:root` 定义的派生量（design §8、§11）。 */
const DERIVED_VARS = ["--selected", "--text-muted"] as const;

const MIN_CONTRAST = 4.5;
const MAX_HUE_SHIFT = 15;
const MIN_SATURATION_FOR_HUE = 0.1;
const MIN_SELECTED_DISTANCE = 12;

// ---------------------------------------------------------------------------
// CSS 解析与求值
// ---------------------------------------------------------------------------

/** 一条样式规则：选择器列表与其中声明的自定义属性（按源码顺序）。 */
interface CssRule {
  readonly selectors: readonly string[];
  readonly vars: ReadonlyMap<string, string>;
}

/**
 * 把样式表切成不含嵌套的规则块。只处理本项目 `index.css` 的写法：去掉注释后，
 * `@import` 语句由前导文本中最后一个 `;` 切掉；`@keyframes` 的内层 `from`/`to` 会被当成
 * 独立规则收进来，但它们的选择器不会与 `:root` 或 `[data-theme]` 相符，不影响结果。
 */
function parseRules(source: string): CssRule[] {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: CssRule[] = [];
  for (const [, prelude, body] of css.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const selectorText = prelude.split(";").pop()!.trim();
    if (selectorText === "") continue;
    const vars = new Map<string, string>();
    for (const decl of body.split(";")) {
      const colon = decl.indexOf(":");
      if (colon < 0) continue;
      const name = decl.slice(0, colon).trim();
      if (name.startsWith("--")) vars.set(name, decl.slice(colon + 1).trim());
    }
    rules.push({
      selectors: selectorText.split(",").map((s) => s.trim()),
      vars,
    });
  }
  return rules;
}

const themeSelector = (key: string) => `[data-theme="${key}"]`;

/** 以 `[data-theme="key"]` 为其中一条选择器的全部规则的自定义属性（按源码顺序合并）。 */
function themeBlockVars(rules: readonly CssRule[], key: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const rule of rules) {
    if (rule.selectors.includes(themeSelector(key))) {
      for (const [k, v] of rule.vars) vars.set(k, v);
    }
  }
  return vars;
}

/** 选择器恰为裸 `:root` 的规则中的自定义属性（派生量所在处）。 */
function bareRootVars(rules: readonly CssRule[]): Map<string, string> {
  const vars = new Map<string, string>();
  for (const rule of rules) {
    if (rule.selectors.length === 1 && rule.selectors[0] === ":root") {
      for (const [k, v] of rule.vars) vars.set(k, v);
    }
  }
  return vars;
}

/**
 * `<html data-theme="key">` 上各自定义属性的层叠结果。相关选择器（`:root`、`[data-theme]`）
 * 特异度都是 (0,1,0)，按源码顺序后者覆盖前者。
 */
function rootCascade(rules: readonly CssRule[], key: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const rule of rules) {
    if (rule.selectors.includes(":root") || rule.selectors.includes(themeSelector(key))) {
      for (const [k, v] of rule.vars) vars.set(k, v);
    }
  }
  return vars;
}

/** 按顶层逗号切分（括号内的逗号不切）。 */
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts.map((p) => p.trim());
}

/** `color-mix()` 的一个分量：颜色表达式与可选的百分比（前置或后置均可）。 */
function parseMixComponent(s: string): { color: string; pct: number | null } {
  const lead = /^(\d+(?:\.\d+)?)%\s+([\s\S]+)$/.exec(s);
  if (lead) return { color: lead[2].trim(), pct: Number(lead[1]) };
  const trail = /^([\s\S]+?)\s+(\d+(?:\.\d+)?)%$/.exec(s);
  if (trail) return { color: trail[1].trim(), pct: Number(trail[2]) };
  return { color: s.trim(), pct: null };
}

/**
 * 按 CSS Color 5 的百分比规则求 `color-mix()` 中第一个分量的权重（[0, 1]）。
 * 两个百分比之和小于 100% 时结果半透明，对比度没有定义，直接报错。
 */
function mixWeight(pa: number | null, pb: number | null, expr: string): number {
  if (pa === null && pb === null) return 0.5;
  if (pb === null) return pa! / 100;
  if (pa === null) return 1 - pb / 100;
  const sum = pa + pb;
  if (sum < 100) {
    throw new Error(`${expr} 的百分比之和小于 100%，结果半透明，无法计算对比度`);
  }
  return pa / sum;
}

/**
 * 求颜色表达式的值。支持 `#rgb`、`#rrggbb`、`var(--x)` 与
 * `color-mix(in srgb, <颜色> [P%], <颜色> [Q%])`；其他写法（含 `transparent`）报错——
 * 半透明色的对比度取决于下面叠的颜色，不在本测试的口径内。
 */
function evalColor(expr: string, vars: ReadonlyMap<string, string>, seen: readonly string[] = []): Rgb {
  const s = expr.trim();
  if (s.startsWith("#")) return parseHex(s);

  const ref = /^var\(\s*(--[\w-]+)\s*\)$/.exec(s);
  if (ref) {
    const name = ref[1];
    if (seen.includes(name)) throw new Error(`变量循环引用：${[...seen, name].join(" → ")}`);
    const value = vars.get(name);
    if (value === undefined) throw new Error(`${s} 引用的变量未定义`);
    return evalColor(value, vars, [...seen, name]);
  }

  const mix = /^color-mix\(\s*in\s+srgb\s*,([\s\S]*)\)$/.exec(s);
  if (mix) {
    const parts = splitTopLevel(mix[1]);
    if (parts.length !== 2) throw new Error(`${s} 应恰有两个颜色分量`);
    const a = parseMixComponent(parts[0]);
    const b = parseMixComponent(parts[1]);
    const p = mixWeight(a.pct, b.pct, s);
    return mixSrgb(evalColor(a.color, vars, seen), evalColor(b.color, vars, seen), p);
  }

  throw new Error(`不支持的颜色写法（需为不透明色）：${s}`);
}

// ---------------------------------------------------------------------------
// 换算辅助
// ---------------------------------------------------------------------------

/** 圆周上两个色相的较短弧长，取值 [0, 180]。 */
function hueDifference(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** sRGB 欧氏距离（0–255 通道）。 */
function srgbDistance(a: Rgb, b: Rgb): number {
  return Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
}

/** 新颜色相对底色是更暗（-1）、更亮（1）还是等亮（0），按相对亮度。 */
function lightnessRelation(color: Rgb, bg: Rgb): -1 | 0 | 1 {
  return Math.sign(relativeLuminance(color) - relativeLuminance(bg)) as -1 | 0 | 1;
}

const fmt = (c: Rgb) => `rgb(${c.r.toFixed(1)}, ${c.g.toFixed(1)}, ${c.b.toFixed(1)})`;
const relationText = (r: -1 | 0 | 1) => (r < 0 ? "更暗" : r > 0 ? "更亮" : "等亮");

// ---------------------------------------------------------------------------
// 当前样式表
// ---------------------------------------------------------------------------

const RULES = parseRules(readFileSync(new URL("../index.css", import.meta.url), "utf-8"));
const ROOT_DERIVED = bareRootVars(RULES);

/** 当前样式表中某主题块的基础变量值（缺失时给出明确的失败信息）。 */
function currentBase(key: ReaderThemeKey, name: BaseVar): Rgb {
  const block = themeBlockVars(RULES, key);
  const raw = block.get(name);
  expect(raw, `index.css 的 [data-theme="${key}"] 块缺少 ${name}`).toBeDefined();
  return evalColor(raw!, rootCascade(RULES, key));
}

/** 当前样式表中某主题下的派生量值（由裸 `:root` 的 `color-mix()` 算出）。 */
function currentDerived(key: ReaderThemeKey, name: (typeof DERIVED_VARS)[number]): Rgb {
  expect(
    ROOT_DERIVED.has(name),
    `index.css 的裸 :root 块未定义派生量 ${name}（design §8、§11）`,
  ).toBe(true);
  return evalColor(ROOT_DERIVED.get(name)!, rootCascade(RULES, key));
}

const snapshotColor = (theme: SnapshotTheme, name: BaseVar) => parseHex(theme.palette[name]);

// ---------------------------------------------------------------------------
// 断言
// ---------------------------------------------------------------------------

describe("解析与换算自检", () => {
  it("快照常量来自 Start_Snapshot 所记提交", () => {
    expect(SNAPSHOT_COMMIT).toMatch(/^[0-9a-f]{40}$/);
    expect(SNAPSHOT_THEMES.map((t) => t.key)).toEqual(["default", "sepia", "eyecare", "dark", "black"]);
  });

  it("色相差按圆周上的较短弧计算", () => {
    expect(hueDifference(355, 5)).toBe(10);
    expect(hueDifference(5, 355)).toBe(10);
    expect(hueDifference(10, 190)).toBe(180);
    expect(hueDifference(217.2, 224.3)).toBeCloseTo(7.1, 9);
  });

  it("color-mix 的百分比按 CSS 规则换算成权重（前置、后置与缺省）", () => {
    const vars = new Map([
      ["--a", "#ff0000"],
      ["--b", "#0000ff"],
    ]);
    expect(evalColor("color-mix(in srgb, var(--a) 25%, var(--b))", vars)).toEqual({ r: 63.75, g: 0, b: 191.25 });
    expect(evalColor("color-mix(in srgb, 25% var(--a), var(--b))", vars)).toEqual({ r: 63.75, g: 0, b: 191.25 });
    expect(evalColor("color-mix(in srgb, var(--a), var(--b) 75%)", vars)).toEqual({ r: 63.75, g: 0, b: 191.25 });
    expect(evalColor("color-mix(in srgb, var(--a), var(--b))", vars)).toEqual({ r: 127.5, g: 0, b: 127.5 });
    expect(() => evalColor("color-mix(in srgb, var(--a) 8%, transparent)", vars)).toThrow(/不支持/);
  });

  it("快照中的旧值符合各主题的明暗：明亮三套的 --text 比 --bg 暗，深色两套的比 --bg 亮", () => {
    for (const theme of SNAPSHOT_THEMES) {
      const expected = theme.scheme === "light" ? -1 : 1;
      expect(
        lightnessRelation(snapshotColor(theme, "--text"), snapshotColor(theme, "--bg")),
        `${theme.key} 的旧 --text`,
      ).toBe(expected);
    }
  });
});

describe("需求 12.2：主题键、显示名称、--bg 与 --card-bg 与 Start_Snapshot 相同", () => {
  it("READER_THEMES 的主题键与显示名称与快照相同", () => {
    const current = Object.fromEntries(READER_THEMES.map((t) => [t.key, t.name]));
    const snapshot = Object.fromEntries(SNAPSHOT_THEMES.map((t) => [t.key, t.name]));
    expect(READER_THEMES).toHaveLength(SNAPSHOT_THEMES.length);
    expect(current).toEqual(snapshot);
  });

  it("index.css 的主题块与快照的主题键一一对应", () => {
    const inCss = new Set<string>();
    for (const rule of RULES) {
      for (const sel of rule.selectors) {
        const m = /^\[data-theme="([\w-]+)"\]$/.exec(sel);
        if (m) inCss.add(m[1]);
      }
    }
    expect([...inCss].sort()).toEqual(SNAPSHOT_THEMES.map((t) => t.key).sort());
  });

  describe.each(SNAPSHOT_THEMES)("$key（$name）", (theme) => {
    it.each(BACKGROUND_VARS)("%s 与快照相同", (name) => {
      expect(fmt(currentBase(theme.key, name)), `${theme.key} 的 ${name}，快照为 ${theme.palette[name]}`).toBe(
        fmt(snapshotColor(theme, name)),
      );
    });
  });
});

describe("需求 12.3：--text、--accent、--border 的新旧颜色可辨认", () => {
  describe.each(SNAPSHOT_THEMES)("$key（$name）", (theme) => {
    it.each(MODIFIABLE_VARS)("%s：饱和度均 ≥ 10% 时色相差 ≤ 15°，相对 --bg 的明暗与旧值相同", (name) => {
      const oldColor = snapshotColor(theme, name);
      const newColor = currentBase(theme.key, name);
      const bg = currentBase(theme.key, "--bg");

      const oldHsl = toHsl(oldColor);
      const newHsl = toHsl(newColor);
      if (oldHsl.s >= MIN_SATURATION_FOR_HUE && newHsl.s >= MIN_SATURATION_FOR_HUE) {
        const shift = hueDifference(oldHsl.h, newHsl.h);
        expect(
          shift,
          `${theme.key} 的 ${name}：${theme.palette[name]}（${oldHsl.h.toFixed(1)}°）→ ${fmt(newColor)}（${newHsl.h.toFixed(1)}°）`,
        ).toBeLessThanOrEqual(MAX_HUE_SHIFT);
      }

      const oldRel = lightnessRelation(oldColor, bg);
      const newRel = lightnessRelation(newColor, bg);
      expect(
        relationText(newRel),
        `${theme.key} 的 ${name} 相对 --bg：旧值${relationText(oldRel)}，新值 ${fmt(newColor)} ${relationText(newRel)}`,
      ).toBe(relationText(oldRel));
    });
  });
});

describe("需求 12.4：--text、--accent 对 --bg、--card-bg 的对比度 ≥ 4.5:1", () => {
  const pairs = FOREGROUND_VARS.flatMap((fg) => BACKGROUND_VARS.map((bg) => ({ fg, bg })));

  describe.each(SNAPSHOT_THEMES)("$key（$name）", (theme) => {
    it.each(pairs)("$fg 对 $bg", ({ fg, bg }) => {
      const ratio = contrastRatio(currentBase(theme.key, fg), currentBase(theme.key, bg));
      expect(ratio, `${theme.key}：${fg} 对 ${bg} 的对比度为 ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
        MIN_CONTRAST,
      );
    });
  });
});

describe("需求 12.5：5 个主题的 --bg 两两不同", () => {
  it("没有两套主题共用同一个 --bg", () => {
    const bgs = SNAPSHOT_THEMES.map((t) => ({ key: t.key, bg: fmt(currentBase(t.key, "--bg")) }));
    for (let i = 0; i < bgs.length; i++) {
      for (let j = i + 1; j < bgs.length; j++) {
        expect(bgs[i].bg, `${bgs[i].key} 与 ${bgs[j].key} 的 --bg`).not.toBe(bgs[j].bg);
      }
    }
  });
});

describe("派生量（design §8、§11；需求 9.1）", () => {
  it.each(DERIVED_VARS)("%s 定义在裸 :root 块中", (name) => {
    expect(ROOT_DERIVED.has(name), `index.css 的裸 :root 块未定义派生量 ${name}`).toBe(true);
  });

  describe.each(SNAPSHOT_THEMES)("$key（$name）", (theme) => {
    it.each(BACKGROUND_VARS)("--text-muted 对 %s 的对比度 ≥ 4.5:1", (bg) => {
      const muted = currentDerived(theme.key, "--text-muted");
      const ratio = contrastRatio(muted, currentBase(theme.key, bg));
      expect(ratio, `${theme.key}：--text-muted ${fmt(muted)} 对 ${bg} 的对比度为 ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
        MIN_CONTRAST,
      );
    });

    it("--accent 对 --selected 的对比度 ≥ 4.5:1", () => {
      const selected = currentDerived(theme.key, "--selected");
      const ratio = contrastRatio(currentBase(theme.key, "--accent"), selected);
      expect(ratio, `${theme.key}：--accent 对 --selected ${fmt(selected)} 的对比度为 ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
        MIN_CONTRAST,
      );
    });

    it("--selected 与 --card-bg 的 sRGB 欧氏距离 ≥ 12（需求 9.1）", () => {
      const selected = currentDerived(theme.key, "--selected");
      const cardBg = currentBase(theme.key, "--card-bg");
      const distance = srgbDistance(selected, cardBg);
      expect(
        distance,
        `${theme.key}：--selected ${fmt(selected)} 与 --card-bg ${fmt(cardBg)} 的距离为 ${distance.toFixed(2)}`,
      ).toBeGreaterThanOrEqual(MIN_SELECTED_DISTANCE);
    });
  });
});
