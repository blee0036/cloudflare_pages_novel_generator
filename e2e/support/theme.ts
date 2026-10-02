/**
 * 截图与扫描定义中的"主题"（需求 6.12、13.1、15.1、15.2）。
 *
 * ## "默认主题"是什么（用户决定，任务 7.5）
 *
 * 需求 13.1 的"主题（5 个主题键之一，或默认主题）"与 15.1 的"默认主题（localStorage 中没有
 * 已存储的主题）"指的是**没有已存储的主题**，不是主题键 `default`。localStorage 为空时应用按
 * `src/utils/storage.ts` 的 `DEFAULT_SETTINGS.theme` 渲染，当前是 `sepia`，所以
 * "默认主题"的截图里 `<html data-theme>` 是 `sepia`，而不是 `default`。
 *
 * 定义里以 `THEME_UNSET`（`"unset"`）表示"默认主题"，与 5 个主题键区分开：
 *
 * | 定义中的 theme | 首次导航前 | 拍摄 / 扫描前断言的 `data-theme` | `color-scheme` |
 * | --- | --- | --- | --- |
 * | `"unset"` | **不得**调用 `seedTheme` | `appDefaultTheme()`（运行时取自 `src/`） | 该键的明暗 |
 * | 主题键 K（含 `default`） | `seedTheme(K)`，或经设置抽屉切到 K | K | K 的明暗 |
 *
 * 后续任务按同一规则：
 * - Review_Shot（`e2e/review/catalog.ts`、`shot` fixture）。
 * - Pixel_Baseline（18.4 `e2e/visual/baselines.ts`）：设计原文"`def.theme` 不是 default 时
 *   seedTheme"按本规则理解为"不是 `"unset"` 时 seedTheme"；`px-reader-default` 要 seed `default`。
 * - Perf_Metrics（19.5、19.6）：14.2 的"默认主题"即 `"unset"`，perf 用例不 seed；reporter 过滤
 *   `[book-load]` 行时以 `expectedDataTheme(THEME_UNSET)` 比对附件里的 `theme`。
 * - A11y_Scan（20.3）：15.1 的 6 个视图用 `"unset"`，15.2 的 5 次对比度扫描各 seed 一个主题键；
 *   reader-defect-fixes 15.6 的 20 次 Contrast_Extension_Scan 各 seed `default`、`eyecare`、`dark`、
 *   `black` 之一（应用默认渲染的主题已由 15.1 覆盖），合计 31 次。
 *
 * 可复用的函数：`themeToSeed`（要不要、seed 哪个键）、`expectedDataTheme`（断言的键，交给
 * `fixtures.ts` 的 `assertTheme`）、`describeTheme`（报告里的写法）、`appDefaultTheme`。
 */
import type { ReaderThemeKey } from "../../src/types";
import { getStoredSettings } from "../../src/utils/storage";
import { READER_THEMES } from "../../src/utils/theme";

/** 定义中表示"默认主题：localStorage 中没有已存储的主题"的取值（13.1、15.1）。 */
export const THEME_UNSET = "unset";

/** 截图、基线或扫描定义声明的主题：5 个主题键之一，或 `THEME_UNSET`。 */
export type DeclaredTheme = ReaderThemeKey | typeof THEME_UNSET;

/** 5 个主题键，按设置抽屉的呈现顺序（`src/utils/theme.ts` 的 `READER_THEMES`）。 */
export const THEME_KEYS: readonly ReaderThemeKey[] = READER_THEMES.map((t) => t.key);

/** 各主题的明暗（6.12）：`default`、`sepia`、`eyecare` 为 light，`dark`、`black` 为 dark。 */
export const THEME_COLOR_SCHEME: Readonly<Record<ReaderThemeKey, "light" | "dark">> = {
  default: "light",
  sepia: "light",
  eyecare: "light",
  dark: "dark",
  black: "dark",
};

export function isThemeKey(value: unknown): value is ReaderThemeKey {
  return typeof value === "string" && (THEME_KEYS as readonly string[]).includes(value);
}

let appDefault: ReaderThemeKey | null = null;

/**
 * 存储为空时应用渲染的主题键，即 `DEFAULT_SETTINGS.theme`（当前为 `sepia`）。
 *
 * `DEFAULT_SETTINGS` 未导出，这里在测试进程中调用 `src/` 的 `getStoredSettings()`：Node 没有
 * 全局 `localStorage`，它取不到存储，返回的就是 `DEFAULT_SETTINGS`。这样 `src/` 改了默认主题时
 * 本函数随之变化，不在 E2E 代码里再写一份字面量。结果不是 5 个主题键之一时抛错。
 */
export function appDefaultTheme(): ReaderThemeKey {
  if (appDefault === null) {
    const theme: unknown = getStoredSettings().theme;
    if (!isThemeKey(theme)) {
      throw new Error(`getStoredSettings().theme 不是主题键：${JSON.stringify(theme)}`);
    }
    appDefault = theme;
  }
  return appDefault;
}

/** 拍摄或扫描前 `<html data-theme>` 应等于的主题键（交给 `assertTheme`，6.12）。 */
export function expectedDataTheme(theme: DeclaredTheme): ReaderThemeKey {
  return theme === THEME_UNSET ? appDefaultTheme() : theme;
}

/** 首次导航前要 seed 的主题键；`THEME_UNSET` 返回 null，即不得 seed。 */
export function themeToSeed(theme: DeclaredTheme): ReaderThemeKey | null {
  return theme === THEME_UNSET ? null : theme;
}

/** 报告中的写法：`默认主题（未存储，实际 sepia）`，或 `dark（暗色夜间）`。 */
export function describeTheme(theme: DeclaredTheme): string {
  if (theme === THEME_UNSET) return `默认主题（未存储，实际 ${appDefaultTheme()}）`;
  const name = READER_THEMES.find((t) => t.key === theme)?.name;
  return name === undefined ? theme : `${theme}（${name}）`;
}
