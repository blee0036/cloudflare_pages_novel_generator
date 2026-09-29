import { describe, expect, it } from "vitest";
import {
  ReaderAction,
  ShortcutEvent,
  isSpaceActivatedTarget,
  isTypingTarget,
  preventsDefault,
  readerAction,
} from "./shortcuts";

/**
 * `src/utils/shortcuts.ts`（任务 60，需求 9.4、差异表 C13）。
 *
 * 重点不在"按 T 开目录"这类正向映射，而在**什么时候不该接管**：输入框里、焦点落在按钮上、
 * 带 Ctrl/Alt/Meta、抽屉打开时。这几条错了的症状分别是"检索框里打空格翻页"、"按一下
 * Space 既按下按钮又翻页"、"切输入法翻一页"、"滚的是读者看不见的正文"。
 */

/** 关着抽屉的阅读器（绝大多数时间）。 */
const READING = { panelOpen: false };
/** 有抽屉打开（目录/检索/设置任一）。 */
const PANEL = { panelOpen: true };

function press(key: string, extra: Partial<ShortcutEvent> = {}): ShortcutEvent {
  return { key, ...extra };
}

/** 既有快捷键的完整清单（C13 的"保留"部分），本任务不得改动它们。 */
const EXISTING: [string, ReaderAction][] = [
  ["ArrowLeft", "prev-chapter"],
  ["ArrowRight", "next-chapter"],
  ["t", "toggle-toc"],
  ["T", "toggle-toc"],
  ["f", "toggle-search"],
  ["F", "toggle-search"],
  ["s", "toggle-settings"],
  ["S", "toggle-settings"],
  ["Escape", "close-panels"],
];

describe("既有快捷键并存（C13 保留部分）", () => {
  it.each(EXISTING)("%s → %s", (key, action) => {
    expect(readerAction(press(key), READING)).toBe(action);
  });

  it("抽屉打开时章节导航与面板开关照旧可用", () => {
    for (const [key, action] of EXISTING) {
      expect(readerAction(press(key), PANEL)).toBe(action);
    }
  });

  it("←/→ 仍是换章，不是翻页", () => {
    expect(readerAction(press("ArrowLeft"), READING)).toBe("prev-chapter");
    expect(readerAction(press("ArrowRight"), READING)).toBe("next-chapter");
  });

  it("未绑定的键一律不接管", () => {
    for (const key of ["a", "Enter", "Tab", "PageDown", "ArrowUp", "ArrowDown", "1"]) {
      expect(readerAction(press(key), READING)).toBeNull();
    }
  });
});

describe("Space 下翻 / 上翻（需求 9.4）", () => {
  it("Space → 下翻", () => {
    expect(readerAction(press(" "), READING)).toBe("page-down");
  });

  it("Shift+Space → 上翻（浏览器通行约定）", () => {
    expect(readerAction(press(" ", { shiftKey: true }), READING)).toBe("page-up");
  });

  it("焦点在按钮上时让给按钮的激活行为，不翻页", () => {
    for (const tagName of ["BUTTON", "SUMMARY"]) {
      expect(readerAction(press(" ", { target: { tagName } }), READING)).toBeNull();
    }
  });

  it("按钮上的其它快捷键不受影响（它们在按钮上没有原生行为）", () => {
    const target = { tagName: "BUTTON" };
    expect(readerAction(press("ArrowRight", { target }), READING)).toBe("next-chapter");
    expect(readerAction(press("T", { target }), READING)).toBe("toggle-toc");
  });

  it("抽屉打开时不滚背后的正文，交给浏览器去滚抽屉自己的列表", () => {
    expect(readerAction(press(" "), PANEL)).toBeNull();
    expect(readerAction(press(" ", { shiftKey: true }), PANEL)).toBeNull();
  });

  it("Ctrl+Space（Windows 切输入法）与 Alt+Space（窗口菜单）都不翻页", () => {
    expect(readerAction(press(" ", { ctrlKey: true }), READING)).toBeNull();
    expect(readerAction(press(" ", { altKey: true }), READING)).toBeNull();
    expect(readerAction(press(" ", { metaKey: true }), READING)).toBeNull();
  });
});

describe("Home / End 章首章末（需求 9.4）", () => {
  it("Home → 章首，End → 章末", () => {
    expect(readerAction(press("Home"), READING)).toBe("chapter-start");
    expect(readerAction(press("End"), READING)).toBe("chapter-end");
  });

  it("抽屉打开时让给抽屉列表", () => {
    expect(readerAction(press("Home"), PANEL)).toBeNull();
    expect(readerAction(press("End"), PANEL)).toBeNull();
  });
});

describe("输入框内忽略快捷键（任务 60 要求保持的行为）", () => {
  const keys = [" ", "Home", "End", "ArrowLeft", "ArrowRight", "t", "f", "s", "Escape"];

  it.each(["INPUT", "TEXTAREA", "SELECT"])("焦点在 %s 里时一个键都不接管", (tagName) => {
    for (const key of keys) {
      expect(readerAction(press(key, { target: { tagName } }), READING)).toBeNull();
    }
  });

  it("contenteditable 同样不接管", () => {
    const target = { tagName: "DIV", isContentEditable: true };
    for (const key of keys) {
      expect(readerAction(press(key, { target }), READING)).toBeNull();
    }
  });

  it("正文段落（普通元素）上的按键照常接管", () => {
    const target = { tagName: "P", isContentEditable: false };
    expect(readerAction(press(" ", { target }), READING)).toBe("page-down");
    expect(readerAction(press("End", { target }), READING)).toBe("chapter-end");
  });

  it("target 缺失（focus 在 body / 事件被合成）时照常接管", () => {
    expect(readerAction(press(" ", { target: null }), READING)).toBe("page-down");
    expect(readerAction(press(" ", { target: {} }), READING)).toBe("page-down");
  });
});

describe("修饰键归浏览器与系统", () => {
  it("Ctrl+F 交给浏览器查找，不再同时打开检索抽屉", () => {
    expect(readerAction(press("f", { ctrlKey: true }), READING)).toBeNull();
  });

  it("Ctrl / Alt / Meta 组合一律不接管", () => {
    for (const key of ["ArrowLeft", "ArrowRight", "t", "s", "Home", "End", "Escape"]) {
      expect(readerAction(press(key, { ctrlKey: true }), READING)).toBeNull();
      expect(readerAction(press(key, { altKey: true }), READING)).toBeNull();
      expect(readerAction(press(key, { metaKey: true }), READING)).toBeNull();
    }
  });
});

describe("isTypingTarget / isSpaceActivatedTarget", () => {
  it("输入类元素与 contenteditable 算输入目标", () => {
    expect(isTypingTarget({ tagName: "INPUT" })).toBe(true);
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isTypingTarget({ tagName: "P" })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(undefined)).toBe(false);
  });

  it("只有真会被 Space 激活的元素算激活目标（链接由 Enter 激活）", () => {
    expect(isSpaceActivatedTarget({ tagName: "BUTTON" })).toBe(true);
    expect(isSpaceActivatedTarget({ tagName: "A" })).toBe(false);
    expect(isSpaceActivatedTarget({ tagName: "P" })).toBe(false);
    expect(isSpaceActivatedTarget(null)).toBe(false);
  });
});

describe("preventsDefault", () => {
  it("只拦滚动类动作——浏览器对这几个键有默认滚动", () => {
    for (const action of ["page-down", "page-up", "chapter-start", "chapter-end"] as const) {
      expect(preventsDefault(action)).toBe(true);
    }
  });

  it("章节导航与面板开关不拦，Esc 的固有语义留给浏览器", () => {
    for (const action of [
      "prev-chapter",
      "next-chapter",
      "toggle-toc",
      "toggle-search",
      "toggle-settings",
      "close-panels",
    ] as const) {
      expect(preventsDefault(action)).toBe(false);
    }
  });
});
