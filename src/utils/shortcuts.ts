/**
 * 阅读器快捷键的按键 → 动作映射（需求 9.4、差异表 C13）。
 *
 * 从 `ReaderPage` 的 `keydown` 回调里抽出来的**纯函数**：入参是一个事件快照
 * （`KeyboardEvent` 的几个字段 + 事件目标的 `tagName`），出参是一个动作名。抽出来的理由
 * 不是"为了分层"，而是这张表里真正容易出错的部分——什么时候**不该**响应——只能靠逐条
 * 断言钉住，而组件里的 DOM 事件在本项目的测试范围外（design §11：不搭 jsdom）。
 *
 * 三条"不响应"的规则，每条都对应一个具体的坏症状：
 *
 * 1. **焦点在输入类元素上**：检索抽屉的输入框里打空格会翻页、打字母 f 会关掉抽屉。
 *    这条规则本来就有（原实现判 `INPUT` / `TEXTAREA`），本任务只是把 `SELECT` 与
 *    `contenteditable` 一并纳入——目前页面上没有这两种元素，所以行为零变化。
 * 2. **`Space` 落在按钮上**：`Space` 在 `<button>` 上是"激活"，不是滚动。阅读器满屏是
 *    按钮（顶栏图标、底栏目录/搜索、章末导航卡），读者用 Tab 或点击摸到按钮后按 `Space`，
 *    期望是按下那个按钮，而不是既按下按钮又翻一页。
 * 3. **带 Ctrl / Alt / Meta**：这些组合属于浏览器和系统——`Ctrl+F` 是查找、`Ctrl+S` 是
 *    保存、**`Ctrl+Space` 在 Windows 上是中英文切换**、`Alt+Space` 是窗口菜单。原实现只看
 *    `e.key`，于是 `Ctrl+F` 会同时打开我们的抽屉和浏览器查找框；`Space` 若不加这条守卫，
 *    读者切一次输入法就翻一页。`Shift` 是唯一的例外：它是 `Space` 的上翻修饰键。
 */

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
   * 打开时**滚动类快捷键一律让给浏览器**：抽屉是覆盖全屏的浮层，各自带可滚列表，此时
   * `Space`/`Home`/`End` 应该滚那个列表（原生行为），而不是滚它背后那篇读者看不见的正文。
   * 章节导航（`←`/`→`）与面板开关（`T`/`F`/`S`/`Esc`）不受影响——它们原本就能在抽屉打开时用。
   */
  readonly panelOpen: boolean;
}

/**
 * 一次按键对应的阅读器动作。命名按"做什么"而不是"按了哪个键"，于是 `ReaderPage` 里的
 * `switch` 读起来就是一份行为清单。
 */
export type ReaderAction =
  | "prev-chapter"
  | "next-chapter"
  | "page-down"
  | "page-up"
  | "chapter-start"
  | "chapter-end"
  | "toggle-toc"
  | "toggle-search"
  | "toggle-settings"
  | "close-panels";

/** 焦点在这些元素里时一律不接管按键（规则 1）。 */
const TYPING_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/**
 * `Space` 在这些元素上是"激活"而不是滚动（规则 2）。
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

/** 焦点元素是否会被 `Space` 激活（规则 2）。 */
export function isSpaceActivatedTarget(target: ShortcutTarget | null | undefined): boolean {
  return SPACE_ACTIVATED_TAGS.has(tagOf(target));
}

/**
 * 需要 `preventDefault()` 的动作：浏览器对这几个键自己也有默认行为。
 *
 * `Space` 最要紧——不拦住的话浏览器会在我们赋值 `scrollTop` 之后再滚一次默认滚动容器，
 * 表现为"按一下跳两屏"或正文抖一下。`Home`/`End` 同理（默认滚到文档两端）。
 *
 * 反过来，章节导航与面板开关**不**拦：`←`/`→` 的默认行为是横向滚动（这里没有横向可滚），
 * 字母键没有默认行为，`Esc` 还要留给浏览器停止加载等固有语义。少拦一个键比多拦一个安全。
 */
export function preventsDefault(action: ReaderAction): boolean {
  return (
    action === "page-down" ||
    action === "page-up" ||
    action === "chapter-start" ||
    action === "chapter-end"
  );
}

/**
 * 把一次按键映射成阅读器动作；`null` = 不接管，交给浏览器。
 *
 * 大小写各列一条（`t`/`T`）而不是先 `toLowerCase()`：`Shift+T` 也该开目录，而 `Shift`
 * 在这里不是"另一个键"——它唯一的独立含义是 `Shift+Space` 的上翻。
 */
export function readerAction(
  event: ShortcutEvent,
  context: ShortcutContext,
): ReaderAction | null {
  if (isTypingTarget(event.target)) return null;
  if (event.ctrlKey || event.altKey || event.metaKey) return null;

  switch (event.key) {
    // 既有的章节导航：`←`/`→` 是**换章**，不是翻页（C13 保留原语义）
    case "ArrowLeft":
      return "prev-chapter";
    case "ArrowRight":
      return "next-chapter";

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

    // 本任务新增：下翻 / 上翻（需求 9.4）
    case " ":
      if (isSpaceActivatedTarget(event.target)) return null;
      if (context.panelOpen) return null;
      // `Shift+Space` 是浏览器里"上翻"的通行约定，而本阅读器没有别的裸键可用于上翻
      // （`←`/`→` 已被章节导航占用）。代价只是同一份算术换个方向。
      return event.shiftKey ? "page-up" : "page-down";

    // 本任务新增：章首 / 章末（需求 9.4）
    case "Home":
      return context.panelOpen ? null : "chapter-start";
    case "End":
      return context.panelOpen ? null : "chapter-end";

    default:
      return null;
  }
}
