/**
 * 阅读器：主题（需求 10.4、10.5、10.6；Checklist H6；Review_Shot RS-12）。`fixture` 项目（:4611，
 * Opaque_Mode），桌面视口，不装 Controlled_Clock（不涉及时长）。
 *
 * ## 用书
 *
 * `lib.role("volumes")`（RS-12 的 catalog 条目用同一本书）。期望值不依赖书的内容，只要它能在阅读器里
 * 正常打开。
 *
 * ## 主题从哪来
 *
 * - 主题键与顺序取自 `THEME_KEYS`（即 `src/utils/theme.ts` 的 `READER_THEMES`，设置抽屉的呈现顺序），
 *   色块经 `settingsDrawer(page).theme(key)` 定位，其名称同样由 `READER_THEMES` 推导（`locators.ts`）。
 * - 各用例一开始都不 `seedTheme`：localStorage 中没有已存储的主题，应用按默认主题（当前 sepia）渲染；
 *   主题一律经设置抽屉切换（6.2），10.6 的已存储主题也由这一操作写入（"经第 4 条的操作写入"）。
 *
 * ## 颜色怎么比（10.4、10.5）
 *
 * 测试代码不含任何主题颜色字面量。`readThemeBackground` 在页面里只读地取：
 *
 * - `<html>` 上 `--bg` 的计算值（原文，如 CSS 里写的十六进制）；把它赋给一个临时 `<div>` 的
 *   `background-color`，挂到 `<body>` 下读计算样式后立即移除，得到浏览器解析出的颜色——这就是
 *   "`<html>` 上 `--bg` 变量解析所得的颜色"。临时元素只用于度量，不在 `#root` 内，不影响应用。
 * - 挂载点 `#root` 的首个子元素（阅读器 / 书架页面最外层容器）的计算 `background-color`。
 *
 * 两者都在测试进程中换算为 `{ r, g, b, a }`（`parseCssColor`）后比较。最外层容器带
 * `transition-colors`，切换主题后的约 200 ms 内背景色是过渡中间值，所以比较用 `expect.poll` 等到
 * 相等（等待只依据可观测条件，6.5）。
 *
 * ## 10.6 的观察脚本
 *
 * `page.addInitScript(installThemeLoadObserver)` 在每次文档创建后、页面任何脚本执行前运行（即早于
 * `main.tsx` 的 `initTheme()` 与 React 的首次渲染）。它在 `document` 上挂一个 MutationObserver：
 *
 * - `attributes`（只看 `data-theme`，带 `attributeOldValue`）：只记目标为 `<html>` 的记录。设置抽屉里
 *   的色块也带 `data-theme`，按目标过滤掉。
 * - `childList` + `subtree`：`#root` 在观察脚本运行时还不存在（解析器稍后才建出它），观察整个
 *   `document` 的子树即可收到它被插入以及它自己的 `childList` 记录，不需要另等它出现。
 *
 * 同一批回调里的记录按发生顺序排列。每条 `data-theme` 记录之后的值 = 下一条同类记录的 `oldValue`，
 * 最后一条之后的值 = 回调时的当前值（回调时队列已清空，当前值就是这批记录全部发生之后的状态）；
 * 某条 `#root` 的 `childList` 记录发生时的值，就是它之前最近一条 `data-theme` 记录之后的值。
 * 由此得到本次加载中 `data-theme` 依次取过的每个值，以及向 `#root` 插入首个子节点那一刻的值。
 * 读取时（`read()`）先 `takeRecords()` 处理尚未派发的记录。
 *
 * 每次导航（含 `page.reload()`）都会建出新的全局对象，记录只属于本次加载。
 *
 * ## 用例划分（16.7）
 *
 * - 10.4（拍 RS-12）：一个用例在同一次加载里依次选 5 个主题。
 * - 10.5：每个主题键一个用例。
 * - 10.6：每个主题键 × {`/read/<id>`, `/`} 一个用例。`/read/<id>` 先按 8.1 判定当前章节为首个正文章节（不带
 *   进度打开），这一判定同时等到阅读器以替换方式把当前章写回 URL（reader-defect-fixes 需求 7.1），再
 *   `page.reload()`：重新加载的是 `/read/<id>?ch=<首个正文章节>`，路径不变，也不与写回竞争。`/` 先经
 *   "返回书架"在应用内回到书架，再 `page.reload()`。
 *
 * 读数（各主题 `--bg` 的原文与解析色、观察脚本的记录）记在注解 `theme-colors`、`theme-load` 里。
 */
import type { Page } from "@playwright/test";
import type { ReaderThemeKey } from "../../../src/types";
import { THEME_ATTRIBUTE } from "../../../src/utils/theme";
import { SHOT_TESTS } from "../../review/catalog";
import { READER_SETTINGS_KEY, expect, test, type BookLog, type Lib } from "../../support/fixtures";
import { reader, settingsDrawer, shelf } from "../../support/locators";
import { bookUnderTest, expectCurrentChapter, openReader, type BookUnderTest } from "../../support/reader";
import { step } from "../../support/step";
import { THEME_KEYS, appDefaultTheme } from "../../support/theme";

// ---------------------------------------------------------------------------
// 颜色
// ---------------------------------------------------------------------------

/** 一个颜色的 RGBA 表示（通道 0–255，`a` 为 0–1）。 */
interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * 把计算样式里的颜色串换算为 RGBA：接受 `rgb(r, g, b)`、`rgba(r, g, b, a)` 与空格分隔的
 * `rgb(r g b / a)`，通道须为数字。其他写法（`color(...)`、百分数等）返回 null，由调用方报错。
 */
function parseCssColor(text: string): Rgba | null {
  const match = /^rgba?\(([^)]*)\)$/i.exec(text.trim());
  if (match === null) return null;
  const parts = match[1].split(/[\s,/]+/).filter((p) => p !== "");
  if (parts.length !== 3 && parts.length !== 4) return null;
  const values = parts.map(Number);
  if (values.some((v) => !Number.isFinite(v))) return null;
  const [r, g, b, a = 1] = values;
  return { r, g, b, a };
}

function describeRgba(c: Rgba): string {
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a})`;
}

function sameRgba(x: Rgba, y: Rgba): boolean {
  return x.r === y.r && x.g === y.g && x.b === y.b && x.a === y.a;
}

/** 页面里的一次主题与背景色读数（只读；临时元素读完即移除）。 */
interface ThemeBackgroundReading {
  /** `<html>` 的 `data-theme`；未设置时为 null。 */
  dataTheme: string | null;
  /** `<html>` 上 `--bg` 的计算值原文（去首尾空白）。 */
  bgVar: string;
  /** 把 `bgVar` 赋给临时元素的 `background-color` 后读到的计算值；`bgVar` 不是合法颜色时为 ""。 */
  bgResolved: string;
  /** `#root` 首个子元素的计算 `background-color`；`#root` 没有子元素时为 null。 */
  container: string | null;
  /** `#root` 首个子元素的标签名（诊断用）。 */
  containerTag: string | null;
}

function readThemeBackground(page: Page): Promise<ThemeBackgroundReading> {
  return page.evaluate((attr) => {
    const html = document.documentElement;
    const bgVar = getComputedStyle(html).getPropertyValue("--bg").trim();
    const probe = document.createElement("div");
    probe.style.backgroundColor = bgVar;
    let bgResolved = "";
    // 赋值被拒（不是合法颜色）时内联样式保持为空
    if (bgVar !== "" && probe.style.backgroundColor !== "") {
      document.body.appendChild(probe);
      try {
        bgResolved = getComputedStyle(probe).backgroundColor;
      } finally {
        probe.remove();
      }
    }
    const first = document.getElementById("root")?.firstElementChild ?? null;
    return {
      dataTheme: html.getAttribute(attr),
      bgVar,
      bgResolved,
      container: first === null ? null : getComputedStyle(first).backgroundColor,
      containerTag: first === null ? null : first.tagName,
    };
  }, THEME_ATTRIBUTE);
}

/** 解析后的读数：`bg` 为 `--bg` 的解析色，`container` 为最外层容器的背景色；解析不出为 null。 */
interface ParsedBackground {
  reading: ThemeBackgroundReading;
  bg: Rgba | null;
  container: Rgba | null;
}

async function readParsedBackground(page: Page): Promise<ParsedBackground> {
  const reading = await readThemeBackground(page);
  return {
    reading,
    bg: parseCssColor(reading.bgResolved),
    container: reading.container === null ? null : parseCssColor(reading.container),
  };
}

/** `expect.poll` 比较结果为相等时的取值。 */
const MATCH = "相等";

/**
 * 最外层容器背景色与 `--bg` 解析色的比较结论：相等时为 `MATCH`，否则为可读的说明（`expect.poll`
 * 失败时显示最后一次的说明）。给出 `expected` 时两者还须都等于它（10.5 的"同一 --bg 解析颜色"）。
 */
function backgroundVerdict(parsed: ParsedBackground, expected?: Rgba): string {
  const { reading, bg, container } = parsed;
  if (bg === null) {
    return `<html> 上 --bg「${reading.bgVar}」解析不出 RGBA（临时元素 background-color「${reading.bgResolved}」）`;
  }
  if (reading.container === null) return "#root 没有子元素";
  if (container === null) {
    return `#root 首个子元素 <${reading.containerTag}> 的 background-color「${reading.container}」解析不出 RGBA`;
  }
  if (expected !== undefined && !sameRgba(bg, expected)) {
    return `--bg 解析色 ${describeRgba(bg)} 不等于选定主题时的 ${describeRgba(expected)}`;
  }
  if (!sameRgba(container, bg)) {
    return (
      `#root 首个子元素 <${reading.containerTag}> 的 background-color ${describeRgba(container)} ` +
      `不等于 --bg「${reading.bgVar}」的解析色 ${describeRgba(bg)}（data-theme=${reading.dataTheme ?? "未设置"}）`
    );
  }
  return MATCH;
}

/** 一个主题的颜色读数（注解与两两比较用）。 */
interface ThemeColor {
  key: ReaderThemeKey;
  bgVar: string;
  bg: Rgba;
}

/**
 * 等到 `#root` 首个子元素的计算 `background-color` 等于 `<html>` 上 `--bg` 的解析色（给出 `expected`
 * 时两者还须等于它），返回此时的读数。`where` 只用于步骤名与报错信息。
 */
async function expectContainerMatchesBg(
  page: Page,
  key: ReaderThemeKey,
  where: string,
  expected?: Rgba,
): Promise<ThemeColor> {
  const title =
    expected === undefined
      ? `${where}最外层容器（#root 首个子元素）的背景色等于 --bg 的解析色`
      : `${where}最外层容器（#root 首个子元素）的背景色等于选定 ${key} 时的 --bg 解析色 ${describeRgba(expected)}`;
  return step(title, async () => {
    await expect
      .poll(async () => backgroundVerdict(await readParsedBackground(page), expected), {
        message: `主题 ${key}：${title}`,
      })
      .toBe(MATCH);
    const parsed = await readParsedBackground(page);
    // 刚才已相等；过渡结束后不再变化，这里仍按同一结论核对一次
    expect(backgroundVerdict(parsed, expected), `主题 ${key}：${title}（复读）`).toBe(MATCH);
    if (parsed.bg === null) throw new Error("unreachable：结论为相等时 --bg 必已解析");
    return { key, bgVar: parsed.reading.bgVar, bg: parsed.bg };
  });
}

// ---------------------------------------------------------------------------
// 设置抽屉与主题切换
// ---------------------------------------------------------------------------

async function openVolumesBook(page: Page, lib: Lib, bookLog: BookLog): Promise<BookUnderTest> {
  const book = await bookUnderTest(lib, lib.role("volumes"));
  await openReader(page, bookLog, book);
  return book;
}

/** 点顶栏"阅读设置 (快捷键: S)"打开设置抽屉，等抽屉标题与 5 个主题色块出现。 */
async function openSettingsDrawer(page: Page): Promise<void> {
  const drawer = settingsDrawer(page);
  await step("点击顶栏“阅读设置”打开设置抽屉，5 个主题色块均已渲染", async () => {
    await reader(page).settingsButton.click();
    await expect(drawer.marker).toBeVisible();
    for (const key of THEME_KEYS) {
      await expect(drawer.theme(key), `主题色块 ${key}`).toBeVisible();
    }
  });
}

/** `<html>` 的 `data-theme`（只读）；未设置时为 null。 */
function readDataTheme(page: Page): Promise<string | null> {
  return page.evaluate((attr) => document.documentElement.getAttribute(attr), THEME_ATTRIBUTE);
}

/** 等 `<html>` 的 `data-theme` 为 `key`。 */
async function expectDataTheme(page: Page, key: ReaderThemeKey, message: string): Promise<void> {
  await expect.poll(() => readDataTheme(page), { message }).toBe(key);
}

/** 在已打开的设置抽屉里点击主题 `key` 的色块，等 `<html data-theme>` 变为 `key`（10.4）。 */
async function selectTheme(page: Page, key: ReaderThemeKey): Promise<void> {
  await step(`在设置抽屉点击主题色块 ${key}，<html> 的 data-theme 变为 ${key}`, async () => {
    await settingsDrawer(page).theme(key).click();
    await expectDataTheme(page, key, `10.4 <html> 的 data-theme 应为 ${key}`);
  });
}

/**
 * 按 `Escape` 关闭设置抽屉。用例写于抽屉的 × 按钮尚无可访问名称时，沿用当时的做法；F-009 已修复
 * （reader-defect-fixes），× 按钮现名"关闭设置"，其名称与点击关闭由 `close-buttons.spec.ts` 覆盖。
 */
async function closeSettingsDrawer(page: Page): Promise<void> {
  await step("按 Escape 关闭设置抽屉", async () => {
    await page.keyboard.press("Escape");
    await expect(settingsDrawer(page).marker).toHaveCount(0);
  });
}

/** 已存储主题（localStorage 设置键里的 `theme`）；没有存储或无法解析时为 null。 */
function readStoredTheme(page: Page): Promise<string | null> {
  return page.evaluate((key) => {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      const theme = (parsed as { theme?: unknown } | null)?.theme;
      return typeof theme === "string" ? theme : null;
    } catch {
      return null;
    }
  }, READER_SETTINGS_KEY);
}

/** 点击顶栏"返回书架"，等 URL 变为 `/` 且书架的检索框出现（应用内导航）。 */
async function backToShelf(page: Page): Promise<void> {
  await step("点击顶栏“返回书架”（应用内导航），等书架出现", async () => {
    await reader(page).backButton.click();
    await expect.poll(() => new URL(page.url()).pathname, { message: "URL 的路径应为 /" }).toBe("/");
    await expect(shelf(page).searchBox).toBeVisible();
  });
}

/** 书架加载完成：检索框与第一张书卡的书名均可见。 */
async function expectShelfLoaded(page: Page): Promise<void> {
  const view = shelf(page);
  await expect(view.searchBox).toBeVisible();
  await expect(view.cardTitles.first()).toBeVisible();
}

function readTimeOrigin(page: Page): Promise<number> {
  return page.evaluate(() => performance.timeOrigin);
}

// ---------------------------------------------------------------------------
// 10.6 的观察脚本
// ---------------------------------------------------------------------------

/** 观察脚本挂在 `window` 上的名称（只在本文件使用）。 */
const OBSERVER_GLOBAL = "__e2eThemeLoadObserver";

/** 观察脚本记下的本次加载（见文件头"10.6 的观察脚本"）。 */
interface ThemeLoadRecord {
  /** 观察脚本开始执行时 `<html>` 是否已存在。 */
  htmlAtInit: boolean;
  /** `<html>` 首次出现时的 `data-theme`（观察脚本开始时已存在则取那时的值）；未设置为 null。 */
  initial: string | null;
  /** 观察脚本开始执行时 `#root` 是否已存在（应为 false：页面脚本执行前注入）。 */
  rootAtInit: boolean;
  /** 本次加载期间 `data-theme` 每次被设置（或移除）之后的值，按先后；移除记为 null。 */
  values: (string | null)[];
  /** 首次向 `#root` 插入子节点的那条记录；尚未观察到时为 null。 */
  firstRootChild: {
    /** 插入那一刻 `<html>` 的 `data-theme`；未设置为 null。 */
    theme: string | null;
    /** 插入之前 `values` 已有的条数。 */
    valuesBefore: number;
    /** 插入的首个节点的 `nodeName`。 */
    nodeName: string;
  } | null;
  /** 处理过的回调批次与记录条数（诊断用）。 */
  batches: number;
  records: number;
}

interface ObserverArgs {
  globalName: string;
  attr: string;
}

/**
 * 观察脚本本体：经 `page.addInitScript` 注入，在页面里执行，不得引用本模块的任何标识符。
 * 算法见文件头；读取经 `window[globalName].read()`。
 */
function installThemeLoadObserver({ globalName, attr }: ObserverArgs): void {
  const htmlAtStart = document.documentElement;
  const record = {
    htmlAtInit: htmlAtStart !== null,
    initial: htmlAtStart === null ? null : htmlAtStart.getAttribute(attr),
    rootAtInit: document.getElementById("root") !== null,
    values: [] as (string | null)[],
    firstRootChild: null as { theme: string | null; valuesBefore: number; nodeName: string } | null,
    batches: 0,
    records: 0,
  };
  let htmlSeen = htmlAtStart !== null;

  const currentTheme = (): string | null => {
    const html = document.documentElement;
    return html === null ? null : html.getAttribute(attr);
  };

  const handle = (mutations: MutationRecord[]): void => {
    if (mutations.length === 0) return;
    record.batches += 1;
    record.records += mutations.length;
    const html = document.documentElement;
    const root = document.getElementById("root");

    const themeIdx: number[] = [];
    mutations.forEach((m, i) => {
      if (m.type === "attributes" && m.attributeName === attr && m.target === html) themeIdx.push(i);
    });
    // 每条 data-theme 记录之后的值：下一条同类记录的 oldValue；最后一条之后为当前值
    const after = new Map<number, string | null>();
    themeIdx.forEach((idx, j) => {
      after.set(idx, j + 1 < themeIdx.length ? mutations[themeIdx[j + 1]].oldValue : currentTheme());
    });
    let value = themeIdx.length > 0 ? mutations[themeIdx[0]].oldValue : currentTheme();

    mutations.forEach((m, i) => {
      const next = after.get(i);
      if (next !== undefined) {
        value = next;
        record.values.push(value);
        return;
      }
      if (m.type !== "childList") return;
      if (!htmlSeen && html !== null && m.target === document && Array.from(m.addedNodes).includes(html)) {
        htmlSeen = true;
        record.initial = value;
      }
      if (record.firstRootChild === null && root !== null && m.target === root && m.addedNodes.length > 0) {
        record.firstRootChild = {
          theme: value,
          valuesBefore: record.values.length,
          nodeName: m.addedNodes[0].nodeName,
        };
      }
    });
  };

  const observer = new MutationObserver(handle);
  observer.observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: [attr],
    attributeOldValue: true,
  });
  Object.defineProperty(window, globalName, {
    configurable: true,
    value: {
      read(): unknown {
        handle(observer.takeRecords());
        return JSON.parse(JSON.stringify(record));
      },
    },
  });
}

async function installObserver(page: Page): Promise<void> {
  await step("注入观察脚本（addInitScript：每次加载在页面脚本之前运行，记录 data-theme 与 #root 首个子节点）", async () => {
    const args: ObserverArgs = { globalName: OBSERVER_GLOBAL, attr: THEME_ATTRIBUTE };
    await page.addInitScript(installThemeLoadObserver, args);
  });
}

function readThemeLoadRecord(page: Page): Promise<ThemeLoadRecord> {
  return page.evaluate((name) => {
    const holder = (window as unknown as Record<string, { read(): unknown } | undefined>)[name];
    if (holder === undefined) throw new Error(`页面上没有观察脚本（window.${name}）`);
    return holder.read() as ThemeLoadRecord;
  }, OBSERVER_GLOBAL);
}

function describeValue(value: string | null): string {
  return value === null ? "未设置" : value;
}

function describeLoadRecord(rec: ThemeLoadRecord): string {
  const first =
    rec.firstRootChild === null
      ? "未观察到向 #root 插入子节点"
      : `向 #root 插入首个子节点 <${rec.firstRootChild.nodeName}> 时 data-theme=${describeValue(rec.firstRootChild.theme)}` +
        `（此前 data-theme 被设置 ${rec.firstRootChild.valuesBefore} 次）`;
  return (
    `观察脚本开始时 <html> ${rec.htmlAtInit ? "已" : "未"}存在、#root ${rec.rootAtInit ? "已" : "未"}存在；` +
    `初始 data-theme=${describeValue(rec.initial)}；本次加载中 data-theme 依次为 ` +
    `[${rec.values.map(describeValue).join(", ")}]；${first}；共 ${rec.batches} 批 ${rec.records} 条记录`
  );
}

/** 10.6 的两项断言（加上观察脚本确实早于页面脚本的前提）。 */
async function expectThemeLoad(page: Page, key: ReaderThemeKey, what: string): Promise<void> {
  const rec = await step(`读观察脚本对本次加载（${what}）的记录`, () => readThemeLoadRecord(page));
  test.info().annotations.push({ type: "theme-load", description: `${what}，已存储 ${key}：${describeLoadRecord(rec)}` });

  await step("前提：观察脚本在 #root 出现之前开始（页面脚本执行前注入）", async () => {
    expect(rec.rootAtInit, `观察脚本开始时 #root 不应已存在：${describeLoadRecord(rec)}`).toBe(false);
  });
  await step(`10.6 向 #root 插入首个子节点之前 data-theme 已为 ${key}`, async () => {
    expect(rec.firstRootChild, `应观察到向 #root 插入首个子节点：${describeLoadRecord(rec)}`).not.toBeNull();
    expect(
      rec.firstRootChild?.theme ?? null,
      `向 #root 插入首个子节点那一刻 <html> 的 data-theme：${describeLoadRecord(rec)}`,
    ).toBe(key);
  });
  await step(`10.6 本次加载期间 data-theme 除初始的未设置状态外只出现过 ${key}`, async () => {
    const seen = [...(rec.initial === null ? [] : [rec.initial]), ...rec.values];
    const others = seen.filter((v) => v !== key).map(describeValue);
    expect(others, `data-theme 取过的、不是 ${key} 的值：${describeLoadRecord(rec)}`).toEqual([]);
  });
}

// ---------------------------------------------------------------------------
// 10.4 设置抽屉依次选择 5 个主题（RS-12）
// ---------------------------------------------------------------------------

test(SHOT_TESTS.themeSwatches.title, async ({ page, lib, bookLog, shot, assertTheme }) => {
  // RS-12 为默认主题（localStorage 中没有已存储的主题），不 seedTheme
  await openVolumesBook(page, lib, bookLog);
  await openSettingsDrawer(page);
  // catalog：设置抽屉已打开、尚未切换主题（当前为应用默认主题）；shot() 断言 data-theme 为应用默认主题
  await shot("theme-swatches");

  const colors: ThemeColor[] = [];
  for (const key of THEME_KEYS) {
    await selectTheme(page, key);
    await assertTheme(key);
    colors.push(await expectContainerMatchesBg(page, key, "阅读器"));
  }

  test.info().annotations.push({
    type: "theme-colors",
    description:
      `应用默认主题 ${appDefaultTheme()}；` +
      colors.map((c) => `${c.key}: --bg「${c.bgVar}」→ ${describeRgba(c.bg)}`).join("；"),
  });

  await step(`10.4 ${THEME_KEYS.length} 个主题各自的 --bg 解析色两两不同`, async () => {
    const pairs: string[] = [];
    for (let i = 0; i < colors.length; i++) {
      for (let j = i + 1; j < colors.length; j++) {
        if (sameRgba(colors[i].bg, colors[j].bg)) {
          pairs.push(`${colors[i].key} 与 ${colors[j].key} 同为 ${describeRgba(colors[i].bg)}`);
        }
      }
    }
    expect(pairs, "解析色相同的主题对").toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 10.5 经应用内导航回到书架
// ---------------------------------------------------------------------------

test.describe("10.5 选定主题后经应用内导航回到书架", () => {
  for (const key of THEME_KEYS) {
    test(`10.5 选定 ${key} 后点“返回书架”（不重载）：data-theme 仍为 ${key}，书架最外层背景色等于同一 --bg 解析色`, async ({
      page,
      lib,
      bookLog,
      assertTheme,
    }) => {
      await openVolumesBook(page, lib, bookLog);
      await openSettingsDrawer(page);
      await selectTheme(page, key);
      await assertTheme(key);
      const selected = await expectContainerMatchesBg(page, key, "阅读器");
      const origin = await readTimeOrigin(page);

      await closeSettingsDrawer(page);
      await backToShelf(page);

      await step("回到书架时没有重新加载页面（performance.timeOrigin 不变）", async () => {
        expect(await readTimeOrigin(page), "performance.timeOrigin").toBe(origin);
      });
      await step(`10.5 书架页 <html> 的 data-theme 仍为 ${key}`, async () => {
        await expectDataTheme(page, key, `10.5 回到书架后 <html> 的 data-theme 应为 ${key}`);
      });
      await assertTheme(key);
      await expectContainerMatchesBg(page, key, "书架", selected.bg);
    });
  }
});

// ---------------------------------------------------------------------------
// 10.6 已存储主题下重新加载
// ---------------------------------------------------------------------------

/** 10.6 的两种重新加载。 */
type ReloadTarget = "reader" | "shelf";

const RELOAD_TARGETS: readonly ReloadTarget[] = ["reader", "shelf"];

const RELOAD_LABELS: Readonly<Record<ReloadTarget, string>> = {
  reader: "/read/<id>",
  shelf: "/",
};

test.describe("10.6 已存储主题下重新加载", () => {
  for (const key of THEME_KEYS) {
    for (const where of RELOAD_TARGETS) {
      const label = RELOAD_LABELS[where];
      test(`10.6 经设置抽屉存储 ${key} 后重新加载 ${label}：#root 插入首个子节点前 data-theme 已为 ${key}，加载期间只出现 ${key}`, async ({
        page,
        lib,
        bookLog,
      }) => {
        await installObserver(page);
        const book = await openVolumesBook(page, lib, bookLog);
        await openSettingsDrawer(page);
        await selectTheme(page, key);

        await step(`前提：localStorage 中已存储主题 ${key}（经第 4 条的操作写入）`, async () => {
          await expect
            .poll(() => readStoredTheme(page), { message: `localStorage ${READER_SETTINGS_KEY} 的 theme` })
            .toBe(key);
        });
        await closeSettingsDrawer(page);

        if (where === "reader") {
          // 先等阅读器把当前章写回 URL（reader-defect-fixes 需求 7.1），重新加载不与写回竞争（见文件头 10.6）
          await expectCurrentChapter(page, book.facts, book.facts.bodyIndices[0]);
          await step(`重新加载 ${label}，等正文加载完成`, async () => {
            const since = bookLog.count;
            await page.reload();
            await bookLog.waitFor(book.id, undefined, { since, timeout: book.loadTimeout });
            await expect(reader(page).chapterHeading).toBeVisible();
          });
        } else {
          await backToShelf(page);
          await step(`重新加载 ${label}，等书架加载完成`, async () => {
            await page.reload();
            await expectShelfLoaded(page);
          });
        }

        await expectThemeLoad(page, key, `重新加载 ${label}`);
      });
    }
  }
});
