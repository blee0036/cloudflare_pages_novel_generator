/**
 * 阅读器快捷键的按键 → 动作映射（需求 11.1–11.3、11.10–11.15；design §8.1）。
 *
 * 从 `ReaderPage` 的 `keydown` 回调里抽出来的**纯函数**：入参是一个事件快照
 * （`KeyboardEvent` 的几个字段 + 事件目标的 `tagName`）与阅读器状态，出参是一个动作名。抽出来的理由
 * 不是"为了分层"，而是这张表里真正容易出错的部分——什么时候**不该**响应——只能靠逐条
 * 断言钉住，而组件里的 DOM 事件在本项目的测试范围外（design §11：不搭 jsdom）。
 *
 * 同一个键在两种渲染族下含义不同（design §8.1）：
 *
 * | 键 | 分页族 | 滚动族 |
 * | --- | --- | --- |
 * | `→` `↓` `PageDown` `Space` | `turn-next` | `→` 换章；`↓` 行滚动；`PageDown`、`Space` 为 `turn-next` |
 * | `←` `↑` `PageUp` `Shift+Space` | `turn-prev` | `←` 换章；`↑` 行滚动；`PageUp`、`Shift+Space` 为 `turn-prev` |
 * | `Home` / `End` | `page-first` / `page-last` | `chapter-start` / `chapter-end` |
 * | `T` `F` `S` `Esc` | 面板开关 | 面板开关 |
 *
 * 三条"不响应"的规则在两种渲染族下都**最先**判断，顺序与语义不变（需求 11.14），
 * 每条都对应一个具体的坏症状：
 *
 * 1. **焦点在输入类元素上**：检索抽屉的输入框里打空格会翻页、打字母 f 会关掉抽屉；底栏
 *    章节滑杆（`<input type="range">`）上的方向键归滑杆自己。`SELECT` 与 `contenteditable`
 *    一并纳入。
 * 2. **带 Ctrl / Alt / Meta**：这些组合属于浏览器和系统——`Ctrl+F` 是查找、`Ctrl+S` 是
 *    保存、**`Ctrl+Space` 在 Windows 上是中英文切换**、`Alt+Space` 是窗口菜单。不加这条守卫，
 *    `Ctrl+F` 会同时打开我们的抽屉和浏览器查找框，读者切一次输入法就翻一页。`Shift` 是唯一的
 *    例外：它是 `Space` 的上翻修饰键。
 * 3. **`Space` 落在按钮上**：`Space` 在 `<button>` 上是"激活"，不是翻页。阅读器满屏是
 *    按钮（顶栏图标、底栏目录/搜索），读者用 Tab 或点击摸到按钮后按 `Space`，期望是按下那个
 *    按钮，而不是既按下按钮又翻一页。
 *
 * 第四条规则——面板打开时翻页类与滚动类按键让给浏览器——放在三条守卫之后、按渲染族分派之前。
 */

import type { RenderFamily } from "./pageAnim";

/** 事件目标里本模块用得到的部分。`HTMLElement` 结构上即满足，测试只需一个字面量。 */
export interface ShortcutTarget {
  readonly tagName?: string;
  readonly isContentEditable?: boolean;
}

/** `KeyboardEvent` 里本模块用得到的部分。 */
export interface ShortcutEvent {
  readonly key: string;
  readonly shiftKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly metaKey?: boolean;
  readonly target?: ShortcutTarget | null;
}

/** 映射时需要知道的阅读器状态。 */
export interface ShortcutContext {
  /**
   * 有没有抽屉/面板处于打开状态（目录、检索、设置）。
   *
   * 打开时**翻页类与滚动类快捷键一律让给浏览器**（需求 11.14）：抽屉是覆盖全屏的浮层，各自带
   * 可滚列表，此时 `Space`/`Home`/`End`/`↑`/`↓`/`PageUp`/`PageDown` 应该滚那个列表（原生行为），
   * 而不是翻它背后那篇读者看不见的正文。分页族的 `←`/`→` 属于翻页类，同样让出；滚动族的
   * `←`/`→` 是换章，与面板开关（`T`/`F`/`S`/`Esc`）一样不受影响。
   */
  readonly panelOpen: boolean;
  /** 当前渲染族：决定方向键、翻页键与 `Home`/`End` 的含义（design §8.1）。 */
  readonly family: RenderFamily;
}

/**
 * 一次按键对应的阅读器动作。命名按"做什么"而不是"按了哪个键"，于是 `ReaderPage` 里的
 * `switch` 读起来就是一份行为清单。
 *
 * - `turn-next` / `turn-prev`：一次翻页。分页族由翻页器换页，滚动族按"保留一行"滚动一屏
 *   （需求 11.1、11.2、11.11、11.12）。
 * - `page-first` / `page-last`：分页族跳到本章第 1 页 / 最后一页（需求 11.3）。
 * - `chapter-start` / `chapter-end`：滚动族跳到本章章首 / 章末（需求 11.13）。
 * - `line-down` / `line-up`：滚动族每次滚动 40 CSS px（需求 11.13）。
 */
export type ReaderAction =
  | "prev-chapter"
  | "next-chapter"
  | "turn-next"
  | "turn-prev"
  | "page-first"
  | "page-last"
  | "chapter-start"
  | "chapter-end"
  | "line-down"
  | "line-up"
  | "toggle-toc"
  | "toggle-search"
  | "toggle-settings"
  | "close-panels";

/** 焦点在这些元素里时一律不接管按键（规则 1）。 */
const TYPING_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/**
 * `Space` 在这些元素上是"激活"而不是翻页（规则 3）。
 *
 * 只列真正会被 `Space` 激活的原生元素。`<a href>` 不在其中：链接由 `Enter` 激活，
 * `Space` 在链接上仍是滚动。`role="button"` 的 `div` 也不在其中——本项目的可点元素
 * 一律是真 `<button>`（无障碍要求，见书架与抽屉），没有需要照顾的伪按钮。
 */
const SPACE_ACTIVATED_TAGS = new Set(["BUTTON", "SUMMARY"]);

function tagOf(target: ShortcutTarget | null | undefined): string {
  return target?.tagName ?? "";
}

/** 焦点是否落在输入/编辑类元素上（规则 1）。 */
export function isTypingTarget(target: ShortcutTarget | null | undefined): boolean {
  return TYPING_TAGS.has(tagOf(target)) || target?.isContentEditable === true;
}

/** 焦点元素是否会被 `Space` 激活（规则 3）。 */
export function isSpaceActivatedTarget(target: ShortcutTarget | null | undefined): boolean {
  return SPACE_ACTIVATED_TAGS.has(tagOf(target));
}

/**
 * 需要 `preventDefault()` 的动作：浏览器对这几个键自己也有默认行为。
 *
 * `Space` 最要紧——不拦住的话浏览器会在我们翻页之后再滚一次默认滚动容器，
 * 表现为"按一下跳两屏"或正文抖一下。`Home`/`End`、`↑`/`↓`/`PageUp`/`PageDown` 同理：
 * 位移已由阅读器完成，浏览器的默认按键滚动若再落到某个可滚元素上，就是第二次位移。
 * 分页族的 `←`/`→` 映为 `turn-*`，一并拦下，代价为零（这里没有横向可滚）。
 *
 * 反过来，滚动族的章节导航与面板开关**不**拦：`←`/`→` 的默认行为是横向滚动（这里没有横向可滚），
 * 字母键没有默认行为，`Esc` 还要留给浏览器停止加载等固有语义。少拦一个键比多拦一个安全。
 */
export function preventsDefault(action: ReaderAction): boolean {
  return (
    action === "turn-next" ||
    action === "turn-prev" ||
    action === "page-first" ||
    action === "page-last" ||
    action === "chapter-start" ||
    action === "chapter-end" ||
    action === "line-down" ||
    action === "line-up"
  );
}

/**
 * 两种渲染族下含义相同、面板打开时也照旧可用的面板开关（需求 11.15）。
 *
 * 大小写各列一条（`t`/`T`）而不是先 `toLowerCase()`：`Shift+T` 也该开目录，而 `Shift`
 * 在这里不是"另一个键"——它唯一的独立含义是 `Shift+Space` 的上翻。
 */
function panelAction(key: string): ReaderAction | null {
  switch (key) {
    case "t":
    case "T":
      return "toggle-toc";
    case "f":
    case "F":
      return "toggle-search";
    case "s":
    case "S":
      return "toggle-settings";
    case "Escape":
      return "close-panels";
    default:
      return null;
  }
}

/** 分页族的翻页类按键（需求 11.1–11.3）。`Shift` 只对 `Space` 有意义。 */
function pagedAction(event: ShortcutEvent): ReaderAction | null {
  switch (event.key) {
    case "ArrowRight":
    case "ArrowDown":
    case "PageDown":
      return "turn-next";
    case "ArrowLeft":
    case "ArrowUp":
    case "PageUp":
      return "turn-prev";
    case " ":
      return event.shiftKey ? "turn-prev" : "turn-next";
    case "Home":
      return "page-first";
    case "End":
      return "page-last";
    default:
      return null;
  }
}

/**
 * 滚动族的翻页类与滚动类按键（需求 11.11–11.13）。`←`/`→` 换章已在调用方处理。
 *
 * 正文滚动容器是 `<main>` 而不是文档，浏览器的默认按键滚动不保证落到它上面，所以由阅读器
 * 接管。`Shift` 只对 `Space` 有意义：`Shift+Space` 是浏览器里"上翻"的通行约定。
 */
function scrollAction(event: ShortcutEvent): ReaderAction | null {
  switch (event.key) {
    case "ArrowDown":
      return "line-down";
    case "ArrowUp":
      return "line-up";
    case "PageDown":
      return "turn-next";
    case "PageUp":
      return "turn-prev";
    case " ":
      return event.shiftKey ? "turn-prev" : "turn-next";
    case "Home":
      return "chapter-start";
    case "End":
      return "chapter-end";
    default:
      return null;
  }
}

/**
 * 把一次按键映射成阅读器动作；`null` = 不接管，交给浏览器。
 *
 * 三条守卫与面板开关在两种渲染族下相同；其余按 `context.family` 分派（design §8.1）：
 *
 * - **分页族**：`←`/`→` 与 `↑`/`↓`、`PageUp`/`PageDown`、`Space` 一样是上一页 / 下一页
 *   （`turn-prev` / `turn-next`），属于翻页类，面板打开时让给浏览器；
 * - **滚动族**：`←`/`→` 是上一章 / 下一章，面板打开时照旧可用；`↑`/`↓` 是行滚动，
 *   `PageUp`/`PageDown`、`Space` 是翻页滚动。
 */
export function readerAction(
  event: ShortcutEvent,
  context: ShortcutContext,
): ReaderAction | null {
  // 三条守卫：两种渲染族下都最先判断（需求 11.14）
  if (isTypingTarget(event.target)) return null;
  if (event.ctrlKey || event.altKey || event.metaKey) return null;
  if (event.key === " " && isSpaceActivatedTarget(event.target)) return null;

  const panel = panelAction(event.key);
  if (panel !== null) return panel;

  // 滚动族的 `←`/`→` 是换章，不是翻页（需求 11.10）；面板打开时照旧可用
  if (context.family === "scroll") {
    if (event.key === "ArrowLeft") return "prev-chapter";
    if (event.key === "ArrowRight") return "next-chapter";
  }

  // 余下都是翻页类与滚动类：面板打开时让给浏览器去滚面板自己的列表
  if (context.panelOpen) return null;

  return context.family === "paged" ? pagedAction(event) : scrollAction(event);
}
