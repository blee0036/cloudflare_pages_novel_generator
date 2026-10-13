import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { RenderFamily } from "./pageAnim";
import {
  ReaderAction,
  ShortcutContext,
  ShortcutEvent,
  ShortcutTarget,
  isSpaceActivatedTarget,
  isTypingTarget,
  preventsDefault,
  readerAction,
} from "./shortcuts";

/**
 * `src/utils/shortcuts.ts`（reader-page-turn-modes 需求 11.1–11.3、11.10–11.15；design §8.1）。
 *
 * 重点不在"按 T 开目录"这类正向映射，而在**什么时候不该接管**：输入框里、焦点落在按钮上、
 * 带 Ctrl/Alt/Meta、抽屉打开时。这几条错了的症状分别是"检索框里打空格翻页"、"按一下
 * Space 既按下按钮又翻页"、"切输入法翻一页"、"翻的是读者看不见的正文"。
 *
 * 守卫与面板开关在两种渲染族下语义相同（需求 11.14、11.15），所以守卫用例按渲染族各跑一遍；
 * 正向映射两族不同，各写一张表。按模式映射的属性测试（Property 24）在文件末尾，对照的是
 * 一份按 design §8.1 独立写出的参照模型，不复用上面这几张表。
 */

const FAMILIES: readonly RenderFamily[] = ["paged", "scroll"];

function ctx(family: RenderFamily, panelOpen = false): ShortcutContext {
  return { family, panelOpen };
}

function press(key: string, extra: Partial<ShortcutEvent> = {}): ShortcutEvent {
  return { key, ...extra };
}

type Binding = [key: string, action: ReaderAction];

/** 面板开关：两种渲染族下含义相同，面板打开时也照旧可用（需求 11.15）。 */
const PANEL_KEYS: Binding[] = [
  ["t", "toggle-toc"],
  ["T", "toggle-toc"],
  ["f", "toggle-search"],
  ["F", "toggle-search"],
  ["s", "toggle-settings"],
  ["S", "toggle-settings"],
  ["Escape", "close-panels"],
];

/** 分页族的翻页类按键（需求 11.1–11.3）。`Shift+Space` 另测。 */
const PAGED_TURN_KEYS: Binding[] = [
  ["ArrowRight", "turn-next"],
  ["ArrowDown", "turn-next"],
  ["PageDown", "turn-next"],
  [" ", "turn-next"],
  ["ArrowLeft", "turn-prev"],
  ["ArrowUp", "turn-prev"],
  ["PageUp", "turn-prev"],
  ["Home", "page-first"],
  ["End", "page-last"],
];

/** 滚动族的翻页类与滚动类按键（需求 11.11–11.13）。`Shift+Space` 另测。 */
const SCROLL_TURN_KEYS: Binding[] = [
  ["ArrowDown", "line-down"],
  ["ArrowUp", "line-up"],
  ["PageDown", "turn-next"],
  ["PageUp", "turn-prev"],
  [" ", "turn-next"],
  ["Home", "chapter-start"],
  ["End", "chapter-end"],
];

/** 滚动族的换章键（需求 11.10）：不属于翻页类，面板打开时照旧可用。 */
const SCROLL_CHAPTER_KEYS: Binding[] = [
  ["ArrowLeft", "prev-chapter"],
  ["ArrowRight", "next-chapter"],
];

interface FamilyKeys {
  /** 面板打开时让给浏览器的键：翻页类与滚动类（需求 11.14）。 */
  readonly yielding: readonly Binding[];
  /** 面板打开时照旧可用的键：面板开关，滚动族另有换章。 */
  readonly persistent: readonly Binding[];
}

const KEYS: Record<RenderFamily, FamilyKeys> = {
  paged: { yielding: PAGED_TURN_KEYS, persistent: PANEL_KEYS },
  scroll: { yielding: SCROLL_TURN_KEYS, persistent: [...SCROLL_CHAPTER_KEYS, ...PANEL_KEYS] },
};

function allBindings(family: RenderFamily): Binding[] {
  return [...KEYS[family].yielding, ...KEYS[family].persistent];
}

/** 正文里的普通落点：焦点在 body、`<main>`、正文段落上，或事件被合成（target 缺失）。 */
const PLAIN_TARGETS: (ShortcutTarget | null)[] = [
  null,
  {},
  { tagName: "BODY" },
  { tagName: "MAIN" },
  { tagName: "DIV" },
  { tagName: "P", isContentEditable: false },
];

/** 底栏章节滑杆。`ShortcutTarget` 只读 `tagName`；`type` 写出来只是为了让用例对应真实元素。 */
const SLIDER = { tagName: "INPUT", type: "range" };

/** 输入类元素（规则 1）。 */
const TYPING_TARGETS: ShortcutTarget[] = [
  SLIDER,
  { tagName: "INPUT" },
  { tagName: "TEXTAREA" },
  { tagName: "SELECT" },
  { tagName: "DIV", isContentEditable: true },
];

describe("分页族映射（需求 11.1–11.3）", () => {
  const reading = ctx("paged");

  it.each(PAGED_TURN_KEYS)("%j → %s", (key, action) => {
    expect(readerAction(press(key), reading)).toBe(action);
  });

  it("Shift+Space → turn-prev", () => {
    expect(readerAction(press(" ", { shiftKey: true }), reading)).toBe("turn-prev");
  });

  it("←/→ 是翻页，不是换章", () => {
    expect(readerAction(press("ArrowLeft"), reading)).toBe("turn-prev");
    expect(readerAction(press("ArrowRight"), reading)).toBe("turn-next");
  });
});

describe("滚动族映射（需求 11.10–11.13）", () => {
  const reading = ctx("scroll");

  it.each([...SCROLL_CHAPTER_KEYS, ...SCROLL_TURN_KEYS])("%j → %s", (key, action) => {
    expect(readerAction(press(key), reading)).toBe(action);
  });

  it("Shift+Space → turn-prev（浏览器通行约定）", () => {
    expect(readerAction(press(" ", { shiftKey: true }), reading)).toBe("turn-prev");
  });

  it("←/→ 仍是换章，不是翻页", () => {
    expect(readerAction(press("ArrowLeft"), reading)).toBe("prev-chapter");
    expect(readerAction(press("ArrowRight"), reading)).toBe("next-chapter");
  });
});

describe("面板打开时的 ←/→（需求 11.14）", () => {
  it("分页族：属于翻页类，让给浏览器", () => {
    expect(readerAction(press("ArrowLeft"), ctx("paged", true))).toBeNull();
    expect(readerAction(press("ArrowRight"), ctx("paged", true))).toBeNull();
  });

  it("滚动族：是换章，照旧可用", () => {
    expect(readerAction(press("ArrowLeft"), ctx("scroll", true))).toBe("prev-chapter");
    expect(readerAction(press("ArrowRight"), ctx("scroll", true))).toBe("next-chapter");
  });
});

describe.each(FAMILIES)("%s 族：守卫与面板开关（需求 11.14、11.15）", (family) => {
  const reading = ctx(family);
  const panel = ctx(family, true);
  const all = allBindings(family);
  const { yielding, persistent } = KEYS[family];

  describe("面板开关", () => {
    it.each(PANEL_KEYS)("%s → %s", (key, action) => {
      expect(readerAction(press(key), reading)).toBe(action);
    });

    it("面板打开时照旧可用", () => {
      for (const [key, action] of PANEL_KEYS) {
        expect(readerAction(press(key), panel)).toBe(action);
      }
    });
  });

  describe("正常落点", () => {
    it("焦点在 body、<main> 或正文普通元素上（含 target 缺失）时照常接管", () => {
      for (const target of PLAIN_TARGETS) {
        for (const [key, action] of all) {
          expect(readerAction(press(key, { target }), reading)).toBe(action);
        }
        expect(readerAction(press(" ", { target, shiftKey: true }), reading)).toBe("turn-prev");
      }
    });

    it("Shift 只改变 Space 的含义，其它键不变", () => {
      for (const [key, action] of all) {
        if (key === " ") continue;
        expect(readerAction(press(key, { shiftKey: true }), reading)).toBe(action);
      }
    });

    it("未绑定的键一律不接管", () => {
      for (const key of ["a", "Enter", "Tab", "1"]) {
        expect(readerAction(press(key), reading)).toBeNull();
        expect(readerAction(press(key), panel)).toBeNull();
      }
    });
  });

  describe("规则 1：焦点在输入类元素上", () => {
    it("一个键都不接管（含底栏章节滑杆上的方向键），面板开关与否都一样", () => {
      for (const target of TYPING_TARGETS) {
        for (const context of [reading, panel]) {
          for (const [key] of all) {
            expect(readerAction(press(key, { target }), context)).toBeNull();
          }
          expect(readerAction(press(" ", { target, shiftKey: true }), context)).toBeNull();
        }
      }
    });
  });

  describe("规则 2：Ctrl / Alt / Meta 归浏览器与系统", () => {
    it("Ctrl+F 交给浏览器查找，不再同时打开检索抽屉", () => {
      expect(readerAction(press("f", { ctrlKey: true }), reading)).toBeNull();
    });

    it("Ctrl+Space（Windows 切输入法）、Alt+Space（窗口菜单）、Meta+Space 都不翻页", () => {
      expect(readerAction(press(" ", { ctrlKey: true }), reading)).toBeNull();
      expect(readerAction(press(" ", { altKey: true }), reading)).toBeNull();
      expect(readerAction(press(" ", { metaKey: true }), reading)).toBeNull();
    });

    it("所有已绑定键的组合一律不接管（叠加 Shift 也一样）", () => {
      for (const context of [reading, panel]) {
        for (const [key] of all) {
          expect(readerAction(press(key, { ctrlKey: true }), context)).toBeNull();
          expect(readerAction(press(key, { altKey: true }), context)).toBeNull();
          expect(readerAction(press(key, { metaKey: true }), context)).toBeNull();
          expect(readerAction(press(key, { ctrlKey: true, shiftKey: true }), context)).toBeNull();
        }
      }
    });
  });

  describe("规则 3：Space 落在按钮上", () => {
    it("让给按钮的激活行为，Space 与 Shift+Space 都不翻页", () => {
      for (const tagName of ["BUTTON", "SUMMARY"]) {
        const target = { tagName };
        expect(readerAction(press(" ", { target }), reading)).toBeNull();
        expect(readerAction(press(" ", { target, shiftKey: true }), reading)).toBeNull();
      }
    });

    it("按钮上的其它键照常接管——它们在按钮上没有激活语义", () => {
      for (const tagName of ["BUTTON", "SUMMARY"]) {
        for (const [key, action] of all) {
          if (key === " ") continue;
          expect(readerAction(press(key, { target: { tagName } }), reading)).toBe(action);
        }
      }
    });

    it("链接由 Enter 激活，Space 落在链接上照常翻页", () => {
      const target = { tagName: "A" };
      expect(readerAction(press(" ", { target }), reading)).toBe("turn-next");
      expect(readerAction(press(" ", { target, shiftKey: true }), reading)).toBe("turn-prev");
    });
  });

  describe("规则 4：面板打开时翻页类与滚动类让给浏览器", () => {
    it("不翻背后的正文，交给浏览器去滚抽屉自己的列表", () => {
      for (const [key] of yielding) {
        expect(readerAction(press(key), panel)).toBeNull();
        expect(readerAction(press(key, { shiftKey: true }), panel)).toBeNull();
      }
    });

    it("其余键照旧可用", () => {
      for (const [key, action] of persistent) {
        expect(readerAction(press(key), panel)).toBe(action);
      }
    });
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
  it("翻页、跳页、章首章末与行滚动都拦——否则浏览器默认按键滚动会造成第二次位移", () => {
    for (const action of [
      "turn-next",
      "turn-prev",
      "page-first",
      "page-last",
      "chapter-start",
      "chapter-end",
      "line-down",
      "line-up",
    ] as const) {
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

  it.each(FAMILIES)("%s 族：面板打开时让出的键恰是要拦的键", (family) => {
    for (const [, action] of KEYS[family].yielding) {
      expect(preventsDefault(action)).toBe(true);
    }
    for (const [, action] of KEYS[family].persistent) {
      expect(preventsDefault(action)).toBe(false);
    }
  });
});

/* -------------------------------------------------------------------------------------------- */
/* Property 24：按模式的按键映射                                                                 */
/* -------------------------------------------------------------------------------------------- */

/*
 * 参照模型（design §8.1）。刻意不复用上面的 Binding 表，也不照抄被测模块的 switch：守卫按
 * tagName 集合判断，面板开关与按渲染族的映射都写成"键 + Shift 条件 → 动作"的行表，用
 * `Array.find` 查找。不用对象字面量取下标，免得 `constructor`、`__proto__` 这类随机键命中原型链。
 *
 * 判断顺序就是 §8.1 的顺序：三条守卫 → 面板开关 → 滚动族 ←/→ 换章（面板打开时也可用）
 * → 面板打开时翻页类与滚动类让出 → 按渲染族查表。
 */

/** `"any"` = 与 Shift 无关；`true`/`false` = 只在 Shift 按下/未按下时匹配（只有 Space 用得到）。 */
type ShiftRule = boolean | "any";
type Row = readonly [key: string, shift: ShiftRule, action: ReaderAction];

const REF_TYPING_TAGS: readonly string[] = ["INPUT", "TEXTAREA", "SELECT"];
const REF_SPACE_ACTIVATED_TAGS: readonly string[] = ["BUTTON", "SUMMARY"];

/** 面板开关（需求 11.15）：与渲染族、面板开合都无关，Shift 也不改变含义。 */
const REF_PANEL_ROWS: readonly Row[] = [
  ["t", "any", "toggle-toc"],
  ["T", "any", "toggle-toc"],
  ["f", "any", "toggle-search"],
  ["F", "any", "toggle-search"],
  ["s", "any", "toggle-settings"],
  ["S", "any", "toggle-settings"],
  ["Escape", "any", "close-panels"],
];

/** 滚动族的换章（需求 11.10）：不属于翻页类，面板打开时照旧可用。 */
const REF_SCROLL_CHAPTER_ROWS: readonly Row[] = [
  ["ArrowLeft", "any", "prev-chapter"],
  ["ArrowRight", "any", "next-chapter"],
];

/** 各渲染族的翻页类与滚动类按键（需求 11.1–11.3、11.11–11.13）；面板打开时一律让出（需求 11.14）。 */
const REF_FAMILY_ROWS: Record<RenderFamily, readonly Row[]> = {
  paged: [
    ["ArrowRight", "any", "turn-next"],
    ["ArrowDown", "any", "turn-next"],
    ["PageDown", "any", "turn-next"],
    [" ", false, "turn-next"],
    ["ArrowLeft", "any", "turn-prev"],
    ["ArrowUp", "any", "turn-prev"],
    ["PageUp", "any", "turn-prev"],
    [" ", true, "turn-prev"],
    ["Home", "any", "page-first"],
    ["End", "any", "page-last"],
  ],
  scroll: [
    ["ArrowDown", "any", "line-down"],
    ["ArrowUp", "any", "line-up"],
    ["PageDown", "any", "turn-next"],
    [" ", false, "turn-next"],
    ["PageUp", "any", "turn-prev"],
    [" ", true, "turn-prev"],
    ["Home", "any", "chapter-start"],
    ["End", "any", "chapter-end"],
  ],
};

/** 需要 `preventDefault()` 的动作（design §8.1）：按名字模式判断，不逐个枚举。 */
const REF_PREVENTED = /^(?:turn|page|line)-|^chapter-(?:start|end)$/;

function lookup(rows: readonly Row[], event: ShortcutEvent): ReaderAction | null {
  const shift = event.shiftKey === true;
  const row = rows.find(([key, rule]) => key === event.key && (rule === "any" || rule === shift));
  return row === undefined ? null : row[2];
}

/** 三条守卫（需求 11.14）：输入类目标、带 Ctrl/Alt/Meta、Space 落在按钮上。 */
function referenceGuarded(event: ShortcutEvent): boolean {
  const tag = event.target?.tagName ?? "";
  const typing = REF_TYPING_TAGS.includes(tag) || event.target?.isContentEditable === true;
  const combo = event.ctrlKey === true || event.altKey === true || event.metaKey === true;
  const spaceOnButton = event.key === " " && REF_SPACE_ACTIVATED_TAGS.includes(tag);
  return typing || combo || spaceOnButton;
}

function referenceReaderAction(
  event: ShortcutEvent,
  context: ShortcutContext,
): ReaderAction | null {
  if (referenceGuarded(event)) return null;
  const panel = lookup(REF_PANEL_ROWS, event);
  if (panel !== null) return panel;
  if (context.family === "scroll") {
    const chapter = lookup(REF_SCROLL_CHAPTER_ROWS, event);
    if (chapter !== null) return chapter;
  }
  if (context.panelOpen) return null;
  return lookup(REF_FAMILY_ROWS[context.family], event);
}

/** design §8.1 表里出现的全部键。 */
const BOUND_KEYS = [
  "ArrowRight",
  "ArrowDown",
  "PageDown",
  " ",
  "ArrowLeft",
  "ArrowUp",
  "PageUp",
  "Home",
  "End",
  "t",
  "T",
  "f",
  "F",
  "s",
  "S",
  "Escape",
] as const;

/** 未绑定的键：常见键、旧浏览器的键名别名（`Spacebar`、`Esc`、`Right`…）、会撞原型链的名字。 */
const DECOY_KEYS = [
  "a",
  "A",
  "Enter",
  "Tab",
  "Backspace",
  "Delete",
  "1",
  "F5",
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "Spacebar",
  "Space",
  "Esc",
  "Right",
  "Left",
  "Up",
  "Down",
  "constructor",
  "__proto__",
  "toString",
] as const;

const keyArb = fc.oneof(
  { weight: 6, arbitrary: fc.constantFrom(...BOUND_KEYS) },
  { weight: 2, arbitrary: fc.constantFrom(...DECOY_KEYS) },
  { weight: 1, arbitrary: fc.string({ maxLength: 12 }) },
);

/** Shift：缺省、未按、按下各占一份。 */
const shiftArb = fc.constantFrom<boolean | undefined>(undefined, false, true);

/** Ctrl/Alt/Meta 偏向不按，免得大多数用例都停在规则 2；三者任意组合仍都会出现。 */
const comboArb = fc.oneof(
  { weight: 2, arbitrary: fc.constant<boolean | undefined>(undefined) },
  { weight: 7, arbitrary: fc.constant<boolean | undefined>(false) },
  { weight: 1, arbitrary: fc.constant<boolean | undefined>(true) },
);

/** 输入类目标（规则 1）：含底栏章节滑杆与 contenteditable。 */
const typingTargetArb: fc.Arbitrary<ShortcutTarget> = fc.oneof(
  fc.constantFrom("INPUT", "TEXTAREA", "SELECT").map((tagName) => ({ tagName })),
  fc.constant<ShortcutTarget>(SLIDER),
  fc
    .constantFrom("DIV", "P", "SPAN", "BODY")
    .map((tagName) => ({ tagName, isContentEditable: true })),
);

/** 会被 Space 激活的目标（规则 3）。 */
const buttonTargetArb: fc.Arbitrary<ShortcutTarget> = fc
  .constantFrom("BUTTON", "SUMMARY")
  .map((tagName) => ({ tagName, isContentEditable: false }));

/** 正文里的普通落点：含 target 缺失、`<a>`（由 Enter 激活，不吃 Space）与任意 tagName。 */
const plainTargetArb: fc.Arbitrary<ShortcutTarget | null | undefined> = fc.oneof(
  fc.constant(null),
  fc.constant(undefined),
  fc.constant({}),
  fc.record({
    tagName: fc.constantFrom("BODY", "MAIN", "DIV", "P", "SPAN", "A", "ARTICLE", "LABEL"),
    isContentEditable: fc.constantFrom<boolean | undefined>(undefined, false),
  }),
  fc.record({ tagName: fc.string({ maxLength: 8 }), isContentEditable: fc.boolean() }),
);

const targetArb: fc.Arbitrary<ShortcutTarget | null | undefined> = fc.oneof(
  { weight: 1, arbitrary: typingTargetArb },
  { weight: 1, arbitrary: buttonTargetArb },
  { weight: 3, arbitrary: plainTargetArb },
);

const eventArb: fc.Arbitrary<ShortcutEvent> = fc.record({
  key: keyArb,
  shiftKey: shiftArb,
  ctrlKey: comboArb,
  altKey: comboArb,
  metaKey: comboArb,
  target: targetArb,
});

const contextArb: fc.Arbitrary<ShortcutContext> = fc.record({
  family: fc.constantFrom<RenderFamily>(...FAMILIES),
  panelOpen: fc.boolean(),
});

describe("readerAction / preventsDefault：按模式映射（属性）", () => {
  // Feature: reader-page-turn-modes, Property 24: 按模式的按键映射
  // **Validates: Requirements 11.1, 11.2, 11.3, 11.10, 11.11, 11.12, 11.13, 11.14, 11.15**
  it("Feature: reader-page-turn-modes, Property 24: 按模式的按键映射——任意事件与上下文的结果与 design §8.1 参照模型一致，且 preventsDefault 恰为 turn-*、page-*、chapter-start/end、line-*", () => {
    fc.assert(
      fc.property(eventArb, contextArb, (event, context) => {
        const action = readerAction(event, context);
        expect(action).toBe(referenceReaderAction(event, context));
        if (action !== null) {
          expect(preventsDefault(action)).toBe(REF_PREVENTED.test(action));
        }
      }),
      { numRuns: 1000 },
    );
  });

  // Feature: reader-page-turn-modes, Property 24: 按模式的按键映射
  // **Validates: Requirements 11.14, 11.15**
  it("Feature: reader-page-turn-modes, Property 24: 按模式的按键映射——守卫在两种渲染族下都返回 null，T/F/S/Esc 的结果与渲染族和面板开合无关，面板打开时不产生任何翻页类与滚动类动作", () => {
    fc.assert(
      fc.property(eventArb, (event) => {
        const results = FAMILIES.flatMap((family) =>
          [false, true].map((panelOpen) => ({
            panelOpen,
            action: readerAction(event, { family, panelOpen }),
          })),
        );

        if (referenceGuarded(event)) {
          for (const { action } of results) expect(action).toBeNull();
          return;
        }

        const panel = lookup(REF_PANEL_ROWS, event);
        if (panel !== null) {
          for (const { action } of results) expect(action).toBe(panel);
        }

        for (const { panelOpen, action } of results) {
          if (panelOpen && action !== null) expect(REF_PREVENTED.test(action)).toBe(false);
        }
      }),
      { numRuns: 1000 },
    );
  });
});
