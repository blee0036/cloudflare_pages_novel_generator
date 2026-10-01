/**
 * A11y_Scan 的 11 个扫描定义（需求 15.1、15.2；设计"无障碍冒烟（需求 15）"的表；任务 20.3）。
 *
 * | 名称 | 视图 | 进入方式（`url`） | 主题 | 规则 |
 * | --- | --- | --- | --- | --- |
 * | `a11y-shelf` | 书架首屏 | `/` | 默认（不 seed） | `A11Y_TAGS` |
 * | `a11y-detail` | 书籍详情弹窗 | `/?book={id}` | 默认（不 seed） | `A11Y_TAGS` |
 * | `a11y-reader` | 阅读器正文 | `/read/{id}`，下标 0 | 默认（不 seed） | `A11Y_TAGS` |
 * | `a11y-toc` | 目录抽屉 | 同上，再打开目录 | 默认（不 seed） | `A11Y_TAGS` |
 * | `a11y-search` | 检索抽屉 | 同上，输入 `volumesKeyword` 并出结果 | 默认（不 seed） | `A11Y_TAGS` |
 * | `a11y-settings` | 设置抽屉 | 同上，再打开设置 | 默认（不 seed） | `A11Y_TAGS` |
 * | `a11y-contrast-<theme>` × 5 | 阅读器正文 | `seedTheme(theme)` 后同 `a11y-reader` | 该主题键 | 仅 `color-contrast` |
 *
 * - 全部在 fixture、桌面视口（1280×800）、Opaque_Mode 下运行；书为 volumes 用途（3.3 (b)），
 *   书架首屏不涉及某本书（`book: null`）。
 * - "默认主题"指 localStorage 中没有已存储的主题（用户决定，见 `e2e/support/theme.ts`）：15.1 的
 *   6 个视图 `theme` 为 `THEME_UNSET`，用例**不得** `seedTheme`；15.2 的 5 次对比度扫描各 seed
 *   一个主题键，同一本书的同一章（下标 0），设置抽屉关闭。
 * - 顺序即 Run_Summary A11y_Scan 节的顺序（15.4）：先 15.1 的 6 个视图，再按 `THEME_KEYS`
 *   （设置抽屉的呈现顺序）排列的 5 次对比度扫描。
 * - axe 标签清单只在 `settings.ts` 的 `A11Y_TAGS` 一处（15.3），本文件只记规则集的种类。
 *
 * 本文件只依赖 Node 内置模块与无副作用的模块，reporter（20.5）也可导入它；执行扫描的
 * `runA11yScan` 在 `./scan.ts`（依赖 `@axe-core/playwright` 与 fixtures）。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ReaderThemeKey } from "../../src/types";
import { BOOK_ID_PLACEHOLDER } from "../review/catalog";
import type { BookRole } from "../support/library";
import { THEME_KEYS, THEME_UNSET, describeTheme, type DeclaredTheme } from "../support/theme";
import type { A11yScanResult, A11yView } from "./summarize";

/** 仓库根（本文件位于 `e2e/a11y/`）。 */
const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** 扫描结果文件的目录：每次扫描写 `<name>.json`（gitignore 的运行产物，17.4）。 */
export const A11Y_DIR = path.join(REPO_ROOT, "e2e", ".out", "a11y");

/** 每次扫描附一条的附件名，`body` 为 `A11yScanResult` 的 JSON。reporter 按名称收集（15.4、15.9）。 */
export const A11Y_RESULT_ATTACHMENT = "a11y-result";

/** 15.2 对比度扫描唯一启用的 axe 规则。 */
export const COLOR_CONTRAST_RULE = "color-contrast";

/** 规则集：`wcag` 即只启用 `A11Y_TAGS` 下的规则（15.3）；`color-contrast` 即只运行该规则（15.2）。 */
export type A11yRules = "wcag" | typeof COLOR_CONTRAST_RULE;

/** 详情弹窗与阅读器相关视图所用的书（3.3 (b) 的 volumes 用途）。 */
export const A11Y_BOOK_ROLE = "volumes" satisfies BookRole;

/** 15.1 的 6 个视图扫描的名称，按设计表格的顺序。 */
export const A11Y_VIEW_SCAN_NAMES = [
  "a11y-shelf",
  "a11y-detail",
  "a11y-reader",
  "a11y-toc",
  "a11y-search",
  "a11y-settings",
] as const;

export type A11yViewScanName = (typeof A11Y_VIEW_SCAN_NAMES)[number];

/** 15.2 的对比度扫描名称：`a11y-contrast-<主题键>`。 */
export type A11yContrastScanName = `a11y-contrast-${ReaderThemeKey}`;

export type A11yScanName = A11yViewScanName | A11yContrastScanName;

/** 一次 A11y_Scan 的定义（设计 Data Models 的 `A11yScanDef`，另加 `book` 与 `url` 两个进入方式字段）。 */
export interface A11yScanDef {
  /** 附件、`e2e/.out/a11y/<name>.json` 与 Run_Summary 节所用的名称，跨运行不变。 */
  readonly name: A11yScanName;
  readonly view: A11yView;
  /** `THEME_UNSET`（15.1：不 seed）或所 seed 的主题键（15.2）。 */
  readonly theme: DeclaredTheme;
  readonly rules: A11yRules;
  /** 所用的书（按用途）；书架首屏为 null。 */
  readonly book: BookRole | null;
  /**
   * 首次导航的路径；`{id}`（`BOOK_ID_PLACEHOLDER`）处代入 `book` 的书 id（`resolveA11yUrl`），
   * 不做百分号编码（与 Review_Catalog 相同，`page.goto` 负责编码）。抽屉视图在此路径打开阅读器后
   * 再由用例打开对应抽屉。
   */
  readonly url: string;
}

/** 各视图的进入路径（设计表格的"进入方式"）。 */
const VIEW_URLS: Readonly<Record<A11yView, string>> = {
  shelf: "/",
  detail: `/?book=${BOOK_ID_PLACEHOLDER}`,
  reader: `/read/${BOOK_ID_PLACEHOLDER}`,
  toc: `/read/${BOOK_ID_PLACEHOLDER}`,
  search: `/read/${BOOK_ID_PLACEHOLDER}`,
  settings: `/read/${BOOK_ID_PLACEHOLDER}`,
};

/** 视图在 Run_Summary 节名中的写法（15.4：节名标明视图与主题）。 */
export const A11Y_VIEW_LABELS: Readonly<Record<A11yView, string>> = {
  shelf: "书架首屏",
  detail: "书籍详情弹窗",
  reader: "阅读器正文",
  toc: "目录抽屉",
  search: "检索抽屉",
  settings: "设置抽屉",
};

const VIEW_OF: Readonly<Record<A11yViewScanName, A11yView>> = {
  "a11y-shelf": "shelf",
  "a11y-detail": "detail",
  "a11y-reader": "reader",
  "a11y-toc": "toc",
  "a11y-search": "search",
  "a11y-settings": "settings",
};

function viewScan(name: A11yViewScanName): A11yScanDef {
  const view = VIEW_OF[name];
  return Object.freeze({
    name,
    view,
    theme: THEME_UNSET,
    rules: "wcag",
    book: view === "shelf" ? null : A11Y_BOOK_ROLE,
    url: VIEW_URLS[view],
  });
}

function contrastScan(theme: ReaderThemeKey): A11yScanDef {
  return Object.freeze({
    name: `a11y-contrast-${theme}`,
    view: "reader",
    theme,
    rules: COLOR_CONTRAST_RULE,
    book: A11Y_BOOK_ROLE,
    url: VIEW_URLS.reader,
  });
}

/** 全部 11 次扫描，按 Run_Summary 节的顺序（15.4）。`a11y.spec.ts`（20.4）为每项建一个用例。 */
export const A11Y_SCANS: readonly A11yScanDef[] = Object.freeze([
  ...A11Y_VIEW_SCAN_NAMES.map(viewScan),
  ...THEME_KEYS.map(contrastScan),
]);

/** 按名称取定义；名称不在 `A11Y_SCANS` 中时抛错。 */
export function a11yScan(name: A11yScanName): A11yScanDef {
  const def = A11Y_SCANS.find((d) => d.name === name);
  if (def === undefined) throw new Error(`A11Y_SCANS 中没有 ${name}`);
  return def;
}

/** 代入书 id 后的首次导航路径。`def.book` 不为 null 时必须给出 `bookId`。 */
export function resolveA11yUrl(def: A11yScanDef, bookId: string | null): string {
  if (def.book === null) return def.url;
  if (bookId === null || bookId === "") {
    throw new Error(`${def.name} 需要 ${def.book} 用途的书 id`);
  }
  return def.url.replace(BOOK_ID_PLACEHOLDER, bookId);
}

/** `e2e/.out/a11y/<name>.json` 的绝对路径。 */
export function a11yResultFile(name: string): string {
  return path.join(A11Y_DIR, `${name}.json`);
}

/**
 * Run_Summary 的节名（15.4）：视图与主题，对比度扫描另注明规则。例如
 * `阅读器正文 · 默认主题（未存储，实际 sepia）`、`阅读器正文 · dark（暗色夜间）· 仅 color-contrast`。
 */
export function describeA11yScan(def: Pick<A11yScanDef, "view" | "theme" | "rules">): string {
  const parts = [A11Y_VIEW_LABELS[def.view], describeTheme(def.theme)];
  if (def.rules === COLOR_CONTRAST_RULE) parts.push(`仅 ${COLOR_CONTRAST_RULE}`);
  return parts.join(" · ");
}

/**
 * `a11y.spec.ts`（20.4）的用例标题：`<需求条目> <扫描名>：<节名>`。reporter（20.5）按附件里的
 * 扫描名归节；只有没附 `a11y-result` 的用例才按与本函数结果相等的标题找回，不解析标题。
 */
export function a11yTestTitle(def: Pick<A11yScanDef, "name" | "view" | "theme" | "rules">): string {
  const clause = def.rules === COLOR_CONTRAST_RULE ? "15.2" : "15.1";
  return `${clause} ${def.name}：${describeA11yScan(def)}`;
}

/**
 * 没有 axe 结果的扫描结果（`failed` 或 `skipped`，15.9、16.4）：`violations`、`incomplete` 为空、
 * `axeVersion` 为空串。reporter 须先看 `status`，不得读作"违规数 0"。
 */
export function a11yResultWithoutAxe(
  def: A11yScanDef,
  status: "failed" | "skipped",
  reason: string,
): A11yScanResult {
  return {
    name: def.name,
    view: def.view,
    theme: def.theme,
    status,
    reason,
    violations: [],
    incomplete: [],
    axeVersion: "",
  };
}
