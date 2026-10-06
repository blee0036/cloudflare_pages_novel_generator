/**
 * Pixel_Baseline 的定义（需求 12.2、12.3、12.9、12.10；设计"像素视觉回归"与 Data Models 的
 * `BaselineDef`）。
 *
 * 清单就是 `BASELINES` 这个数组，不另设 JSON manifest。每张基线的名称、视口、主题、书、URL、章节、
 * 检索词、要展示的状态、准备画面的步骤与遮罩清单都写在这里；`e2e/tests/fixture/visual.spec.ts`
 * （任务 18.5）按视口分组、每个定义一个用例，`baseline-catalog.spec.ts`（任务 18.9）核对
 * `REQUIRED_BASELINE_NAMES` 与 `e2e/baselines/` 一一对应。容差不在这里：全部基线共用
 * `playwright.config.ts` 中取自 `VISUAL` 的同一组值，定义里没有容差字段（12.4）。
 *
 * ## 数量
 *
 * 需求 12.2 列出 13 个名称（`px-reader-<主题键>` 5 张计入），设计表格展开后同为 13 行；任务 18.4
 * 与设计中"14 个 / × 14"的写法与清单对不上，这里以 12.2 的清单为准，不自行增补第 14 张。
 *
 * ## 字段与设计的差异
 *
 * - `theme`：`DeclaredTheme`（`e2e/support/theme.ts`，用户决定）。`THEME_UNSET` 即"默认主题"，
 *   localStorage 中没有已存储的主题，用例**不得** `seedTheme`，拍摄前断言应用默认主题（当前
 *   `sepia`）；主题键（含 `default`）先 `seedTheme` 再断言该键。设计原文"`def.theme` 不是 default
 *   时 seedTheme"按此理解为"不是 `THEME_UNSET` 时 seed `themeToSeed(def.theme)`"，所以
 *   `px-reader-default` 要 seed `default`。书架、骨架、弹窗、移动阅读器、目录、设置与检索这 8 张
 *   是默认主题（`THEME_UNSET`）。
 * - `role`：设计写作 `keyof FixtureRoles`；`FixtureRoles` 里有非单本书的键，这里与 Review_Catalog
 *   一样改用 `BookRole`（`lib.role()` 的参数类型）。
 * - `chapter`：设计的类型里没有，按 12.2"章节……固定写在该基线的定义中"补上：画面停在的章节的
 *   下标与标题，`prepare` 据此等正文。
 * - `cleanup`：设计的类型里没有。`px-shelf-skeleton` 的挂起路由须在用例结束时移除（设计表格：
 *   "结束时 `unrouteAll({ behavior: "ignoreErrors" })`"），由用例在截图之后（含失败）调用。
 *
 * ## 书 id、章节与检索词都是字面量（12.2）
 *
 * 取自当前 Fixture_Library（`e2e/.out/fixture/roles.json` 与各书 `_toc.json`），夹具生成确定
 * （属性 4），所以字面量跨运行不变。`visual.spec.ts` 在 `prepare` 之前核对
 * `lib.role(def.role) === def.bookId`，不符即失败；夹具规格改了书名或用途时须同步改这里。
 *
 * ## `prepare(page)`
 *
 * 用例先 `clock.install(CLOCK_T0)`（不暂停，时间照常流动），需要时 `seedTheme`，再调用
 * `prepare(page)`。`prepare` 只把页面带到目标状态并等可观测条件成立，不做与状态无关的断言；主题
 * 断言（6.12）、遮罩核对（12.3、12.10）、缺失基线检查（12.6）与截图都由用例完成。
 *
 * 阅读器里的三个抽屉用快捷键 T / S / F 打开，不点顶栏按钮：阅读器内任意点击都会启动 4.5 s 后
 * 自动隐藏顶栏与底栏的定时器（`ReaderPage` 的 `triggerShowControls`），它们在抽屉的半透明遮罩下
 * 仍可见，截图落在隐藏前还是隐藏后取决于运行快慢；按键不启动这个定时器，也不留下指针悬停样式。
 * 快捷键本身由 10.16–10.18 的用例覆盖。全程不移动鼠标。
 *
 * ## 遮罩（12.3）
 *
 * 13 张均为空：时间相关内容由 `CLOCK_T0` 固定，缓存占用读自 IndexedDB 元数据，夹具确定。
 * 只有 6.6 的两次连续运行暴露不稳定区域时才加遮罩，并在 `reason` 写明内容为何随运行变化。
 *
 * ## 已知缺陷（18.9）
 *
 * 评审判为"含已知缺陷接受"时，把 Finding 编号写入该定义的 `knownDefects`，并在 `masks` 定义旁注释。
 * 目前没有任何定义带 `knownDefects`：EV 阶段 5 曾按此标注的 9 张，已在 reader-defect-fixes 修复对应
 * 缺陷后删除并以基线更新命令重新生成（该 spec 需求 17.1、17.3）。
 */
import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import type { ReaderThemeKey } from "../../src/types";
import { createIdbProbe } from "../support/fixtures";
import type { BookRole } from "../support/library";
import { detailModal, reader, searchDrawer, settingsDrawer, shelf, tocDrawer } from "../support/locators";
import type { VIEWPORTS } from "../support/settings";
import { step } from "../support/step";
import { THEME_UNSET, type DeclaredTheme } from "../support/theme";
import type { BaselineName } from "./naming";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 基线所用的视口（`VIEWPORTS` 的键：桌面 1280×800、移动 390×844，12.9）。 */
export type BaselineViewport = keyof typeof VIEWPORTS;

/** 一个遮罩：以 role、label 或可见文本定位（`locators.ts`），`reason` 必填（12.3）。 */
export interface MaskDef {
  locate(page: Page): Locator;
  /** 区域内容为何在 Controlled_Clock 与 Fixture_Library 都固定时仍随运行变化。 */
  reason: string;
}

/** 基线画面停在的章节：`_toc.json` 中的节点下标与标题（字面量，12.2）。 */
export interface BaselineChapter {
  readonly index: number;
  readonly title: string;
}

export interface BaselineDef {
  readonly name: BaselineName;
  readonly viewport: BaselineViewport;
  /** 5 个主题键之一，或 `THEME_UNSET`（默认主题：没有已存储的主题）。 */
  readonly theme: DeclaredTheme;
  /** 所用书的用途；不涉及书库中的某本书时为 null。 */
  readonly role: BookRole | null;
  /** 所用书的 id（字面量）；`role` 为 null 时为 null。用例核对 `lib.role(role) === bookId`。 */
  readonly bookId: string | null;
  /** 首次导航的相对 URL（未做百分号编码的原文）。 */
  readonly url: string;
  /** 阅读器类基线停在的章节。 */
  readonly chapter?: BaselineChapter;
  /** 检索词（`px-search-results`）。 */
  readonly keyword?: string;
  /** 要展示的状态。 */
  readonly state: string;
  /** 把页面带到 `state`（首次导航在其中）；只等可观测条件，不做其他断言。 */
  prepare(page: Page): Promise<void>;
  /** 截图之后（含失败）由用例调用，撤销 `prepare` 对页面的拦截等设置。 */
  cleanup?(page: Page): Promise<void>;
  /** 遮罩清单，无容差字段（12.4）。不需要遮罩时为空数组。 */
  readonly masks: readonly MaskDef[];
  /** 18.9："含已知缺陷接受"时标注的 Finding 编号，同时写在 `masks` 定义旁的注释里。 */
  readonly knownDefects?: readonly string[];
}

// ---------------------------------------------------------------------------
// 12.2 的名称清单（独立于 BASELINES 书写，供目录核对）
// ---------------------------------------------------------------------------

/** `px-reader-<主题键>` 的 5 个主题键，按 12.2 的顺序（与 `READER_THEMES` 相同）。 */
export const READER_BASELINE_THEMES = ["default", "sepia", "eyecare", "dark", "black"] as const satisfies readonly ReaderThemeKey[];

/** 需求 12.2 列出的全部名称，按其顺序。 */
export const REQUIRED_BASELINE_NAMES = [
  "px-shelf-desktop",
  "px-shelf-mobile",
  "px-shelf-skeleton",
  "px-detail-modal",
  "px-reader-default",
  "px-reader-sepia",
  "px-reader-eyecare",
  "px-reader-dark",
  "px-reader-black",
  "px-reader-mobile",
  "px-toc-volumes",
  "px-settings-drawer",
  "px-search-results",
] as const satisfies readonly BaselineName[];

export type RequiredBaselineName = (typeof REQUIRED_BASELINE_NAMES)[number];

// ---------------------------------------------------------------------------
// Fixture_Library 中的书（字面量，12.2）
// ---------------------------------------------------------------------------

/** 书架索引的请求（`BookshelfPage` 的 `fetch("/data/books.json")`），设计写作此 glob。 */
const BOOKS_JSON_GLOB = "**/data/books.json";

/**
 * `roles.json` 的 `volumes`：卷结构书《云岭长歌》（19 个节点，其中 4 个卷节点）。下标 0 的「楔子」
 * 是位于第一个卷节点之前的正文章节，没有阅读进度时阅读器停在它的章首。
 */
const VOLUMES_BOOK = {
  role: "volumes",
  id: "云岭长歌-夹具作者甲",
  start: { index: 0, title: "楔子" },
  /** 第一个卷节点（卷一），`px-toc-volumes` 要求它在目录抽屉的可视区内。 */
  firstVolume: { index: 1, title: "第一卷 云起" },
} as const satisfies { role: BookRole; id: string; start: BaselineChapter; firstVolume: BaselineChapter };

/**
 * `roles.json` 的 `longText`：长文本书《长夜书灯》。没有阅读进度时停在下标 0 的「第一章 初雪」；
 * `fewKeyword`（`longText.fewKeyword`）在全书中命中 1 至 149 次（夹具校验 3.3）。
 */
const LONG_TEXT_BOOK = {
  role: "longText",
  id: "长夜书灯-夹具作者己",
  start: { index: 0, title: "第一章 初雪" },
  fewKeyword: "琉璃盏",
} as const satisfies { role: BookRole; id: string; start: BaselineChapter; fewKeyword: string };

/** volumes 书的阅读器 URL（原文，不编码；没有 `?ch=`，停在没有进度时的起始章）。 */
const VOLUMES_READER_URL = `/read/${VOLUMES_BOOK.id}`;

/** volumes 书的详情弹窗深链接（原文，不编码）。 */
const VOLUMES_DETAIL_URL = `/?book=${VOLUMES_BOOK.id}`;

/** longText 书的阅读器 URL（原文，不编码）。 */
const LONG_TEXT_READER_URL = `/read/${LONG_TEXT_BOOK.id}`;

// ---------------------------------------------------------------------------
// prepare 的共用步骤
// ---------------------------------------------------------------------------

/** 以百分号编码后的 URL 导航（书 id 含中文）。 */
function gotoRaw(page: Page, url: string): Promise<unknown> {
  return page.goto(encodeURI(url));
}

/** 打开书架 `/`，等首批书卡挂载、骨架移除（书卡在同一次提交中全部渲染）。 */
async function openShelf(page: Page): Promise<void> {
  await step("打开书架 /，等首批书卡挂载、骨架移除", async () => {
    await gotoRaw(page, "/");
    const view = shelf(page);
    await expect(view.cardTitles.first()).toBeVisible();
    await expect(view.skeleton).toHaveCount(0);
  });
}

/** 打开阅读器 `url`，等正文显示 `chapter` 的标题与"第 N / M 章"（没有阅读进度，停在章首）。 */
async function openReaderAt(page: Page, url: string, chapter: BaselineChapter): Promise<void> {
  await step(`打开 ${url}，等正文显示「${chapter.title}」`, async () => {
    await gotoRaw(page, url);
    const view = reader(page);
    await expect(view.chapterHeading).toHaveText(chapter.title);
    await expect(view.chapterPosition).toBeVisible();
  });
}

// ---------------------------------------------------------------------------
// 定义
// ---------------------------------------------------------------------------

function shelfHome(name: BaselineName, viewport: BaselineViewport, label: string): BaselineDef {
  return {
    name,
    viewport,
    theme: THEME_UNSET,
    role: null,
    bookId: null,
    url: "/",
    state:
      `书架首屏（${label}）：books.json 加载完成，首批书卡已挂载、骨架已移除；检索框为空、无作者筛选，` +
      "localStorage 中没有阅读进度（不显示「最近阅读」）",
    prepare: openShelf,
    masks: [],
  };
}

const SHELF_SKELETON: BaselineDef = {
  name: "px-shelf-skeleton",
  viewport: "desktop",
  theme: THEME_UNSET,
  role: null,
  bookId: null,
  url: "/",
  state:
    `以 page.route("${BOOKS_JSON_GLOB}") 挂起 books.json 的响应（不应答）时的书架：骨架区块` +
    "（role=status、aria-busy=true）显示中，尚无书卡",
  prepare: (page) =>
    step("挂起 books.json 的响应，打开书架 /，等骨架区块显示", async () => {
      let held = 0;
      // 不调用 continue / fulfill / abort：请求一直挂起，直到 cleanup 移除路由
      await page.route(BOOKS_JSON_GLOB, () => {
        held += 1;
      });
      await gotoRaw(page, "/");
      await expect.poll(() => held, { message: "books.json 的请求应已发出并被挂起" }).toBeGreaterThan(0);
      const view = shelf(page);
      await expect(view.skeleton).toBeVisible();
      await expect(view.skeleton).toHaveAttribute("aria-busy", "true");
    }),
  cleanup: (page) => page.unrouteAll({ behavior: "ignoreErrors" }),
  masks: [],
};

const DETAIL_MODAL: BaselineDef = {
  name: "px-detail-modal",
  viewport: "desktop",
  theme: THEME_UNSET,
  role: VOLUMES_BOOK.role,
  bookId: VOLUMES_BOOK.id,
  url: VOLUMES_DETAIL_URL,
  state:
    "新页面直接访问深链接：books.json 加载完成后详情弹窗显示在书架之上，完整章节目录已载入" +
    "（不再显示「正在载入完整章节目录...」），网格中已挂载章节单元；没有阅读进度",
  prepare: (page) =>
    step(`打开 ${VOLUMES_DETAIL_URL}，等详情弹窗与章节网格`, async () => {
      await gotoRaw(page, VOLUMES_DETAIL_URL);
      const modal = detailModal(page);
      await expect(modal.marker).toBeVisible();
      await expect(modal.loading).toHaveCount(0);
      await expect(modal.chapterRows.first()).toBeVisible();
    }),
  masks: [],
};

function readerTheme(theme: (typeof READER_BASELINE_THEMES)[number]): BaselineDef {
  const chapter = VOLUMES_BOOK.start;
  return {
    name: `px-reader-${theme}`,
    viewport: "desktop",
    theme,
    role: VOLUMES_BOOK.role,
    bookId: VOLUMES_BOOK.id,
    url: VOLUMES_READER_URL,
    chapter,
    state:
      `已存储主题为 ${theme}（首次导航前 seedTheme），没有阅读进度：阅读器停在下标 ${chapter.index} 的` +
      `「${chapter.title}」章首；5 张 px-reader-<主题键> 为同一本书的同一章`,
    prepare: (page) => openReaderAt(page, VOLUMES_READER_URL, chapter),
    masks: [],
  };
}

const READER_MOBILE: BaselineDef = {
  name: "px-reader-mobile",
  viewport: "mobile",
  theme: THEME_UNSET,
  role: VOLUMES_BOOK.role,
  bookId: VOLUMES_BOOK.id,
  url: VOLUMES_READER_URL,
  chapter: VOLUMES_BOOK.start,
  state:
    `移动视口，默认主题，没有阅读进度：阅读器停在下标 ${VOLUMES_BOOK.start.index} 的` +
    `「${VOLUMES_BOOK.start.title}」章首`,
  prepare: (page) => openReaderAt(page, VOLUMES_READER_URL, VOLUMES_BOOK.start),
  masks: [],
};

const TOC_VOLUMES: BaselineDef = {
  name: "px-toc-volumes",
  viewport: "desktop",
  theme: THEME_UNSET,
  role: VOLUMES_BOOK.role,
  bookId: VOLUMES_BOOK.id,
  url: VOLUMES_READER_URL,
  chapter: VOLUMES_BOOK.start,
  state:
    `阅读器停在「${VOLUMES_BOOK.start.title}」章首（默认主题、没有阅读进度）后按 T 打开目录抽屉：` +
    `卷一标题「${VOLUMES_BOOK.firstVolume.title}」（下标 ${VOLUMES_BOOK.firstVolume.index}）在可视区内`,
  async prepare(page) {
    const volume = VOLUMES_BOOK.firstVolume;
    await openReaderAt(page, VOLUMES_READER_URL, VOLUMES_BOOK.start);
    await step(`按 T 打开目录抽屉，等卷一标题「${volume.title}」进入可视区`, async () => {
      await page.keyboard.press("T");
      const drawer = tocDrawer(page);
      await expect(drawer.marker).toBeVisible();
      await expect(drawer.volume(volume.title)).toBeInViewport();
    });
  },
  masks: [],
};

const SETTINGS_DRAWER: BaselineDef = {
  name: "px-settings-drawer",
  viewport: "desktop",
  theme: THEME_UNSET,
  role: VOLUMES_BOOK.role,
  bookId: VOLUMES_BOOK.id,
  url: VOLUMES_READER_URL,
  chapter: VOLUMES_BOOK.start,
  state:
    `阅读器停在「${VOLUMES_BOOK.start.title}」章首（默认主题、没有阅读进度），本书已写入离线缓存` +
    "（IndexedDB 中有其记录）后按 S 打开设置抽屉：「已缓存」一行显示「N 本 · 大小」的读数",
  async prepare(page) {
    const bookId = VOLUMES_BOOK.id;
    await openReaderAt(page, VOLUMES_READER_URL, VOLUMES_BOOK.start);
    // 缓存写入不阻塞正文显示（decompress.ts 的 fire-and-forget），设置抽屉只在打开时统计一次；
    // 先等记录落盘，读数才不取决于写入与打开的先后
    await step("等本书写入离线缓存（IndexedDB 中有其记录）", async () => {
      const idb = createIdbProbe(page);
      await expect.poll(() => idb.keys(), { message: `IndexedDB 中应有 ${bookId} 的记录` }).toContain(bookId);
    });
    await step("按 S 打开设置抽屉，等缓存占用统计完成", async () => {
      await page.keyboard.press("S");
      const drawer = settingsDrawer(page);
      await expect(drawer.marker).toBeVisible();
      await expect(drawer.cacheUsage).toHaveText(/^\d+ 本 · .+$/);
    });
  },
  masks: [],
};

const SEARCH_RESULTS: BaselineDef = {
  name: "px-search-results",
  viewport: "desktop",
  theme: THEME_UNSET,
  role: LONG_TEXT_BOOK.role,
  bookId: LONG_TEXT_BOOK.id,
  url: LONG_TEXT_READER_URL,
  chapter: LONG_TEXT_BOOK.start,
  keyword: LONG_TEXT_BOOK.fewKeyword,
  state:
    `阅读器停在「${LONG_TEXT_BOOK.start.title}」章首（默认主题、没有阅读进度）后按 F 打开检索抽屉，` +
    `检索框自动获得焦点后输入 fewKeyword「${LONG_TEXT_BOOK.fewKeyword}」：列出 ≥ 1 条结果与「找到 N 条匹配」，` +
    "检索框持有焦点（插入符由拍摄设置隐藏）",
  async prepare(page) {
    const keyword = LONG_TEXT_BOOK.fewKeyword;
    await openReaderAt(page, LONG_TEXT_READER_URL, LONG_TEXT_BOOK.start);
    await step(`按 F 打开检索抽屉，输入「${keyword}」，等结果列出且检索框持有焦点`, async () => {
      await page.keyboard.press("F");
      const drawer = searchDrawer(page);
      await expect(drawer.marker).toBeVisible();
      // 抽屉打开 150 ms 后自动聚焦检索框；等它发生，之后不会再有焦点变化
      await expect(drawer.input).toBeFocused();
      await drawer.input.fill(keyword);
      await expect(drawer.results.first()).toBeVisible();
      await expect(drawer.resultCount).toBeVisible();
      await expect(drawer.input).toBeFocused();
    });
  },
  masks: [],
};

/** 全部 Pixel_Baseline，按 12.2 的顺序（`REQUIRED_BASELINE_NAMES`）。 */
export const BASELINES: readonly BaselineDef[] = [
  shelfHome("px-shelf-desktop", "desktop", "桌面"),
  shelfHome("px-shelf-mobile", "mobile", "移动"),
  SHELF_SKELETON,
  DETAIL_MODAL,
  ...READER_BASELINE_THEMES.map(readerTheme),
  READER_MOBILE,
  TOC_VOLUMES,
  SETTINGS_DRAWER,
  SEARCH_RESULTS,
];

/** 按名称取定义；不存在时抛错。 */
export function baselineDef(name: string): BaselineDef {
  const def = BASELINES.find((d) => d.name === name);
  if (def === undefined) throw new Error(`没有名为 ${name} 的 Pixel_Baseline 定义`);
  return def;
}

/** 某个视口下的定义，按 `BASELINES` 的顺序（`visual.spec.ts` 按视口分两个 describe）。 */
export function baselinesFor(viewport: BaselineViewport): readonly BaselineDef[] {
  return BASELINES.filter((d) => d.viewport === viewport);
}
