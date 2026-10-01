/**
 * 阅读器场景的共用步骤与度量（任务 10.1 起；10.2–10.6、11.x 复用）。
 *
 * | 函数 | 作用 |
 * | --- | --- |
 * | `bookUnderTest(lib, id)` | 取 `_toc.json` 推导的 `TocFacts` 与 gz 字节数；gz ≥ `BIG_BOOK_GZ_BYTES` 时把本用例超时设为 `TIMEOUTS.bigBookTest`，并给出等待加载的上限（6.8） |
 * | `readerPath(id, ch?)` | `/read/<id>`（可带 `?ch=`），书 id 经百分号编码 |
 * | `openReader(page, bookLog, book, ch?)` | 导航到阅读器，等本次导航的 `[book-load]` 行与正文 `<h1>` |
 * | `expectCurrentChapter(page, facts, index)` | 8.1 的"当前章节"判定（其余各条所说的当前章节均按此判定） |
 * | `readChapterPosition(page)` | 读"第 N / M 章"的 N、M |
 * | `openTocDrawer(page)` | 点顶栏"章节目录 (快捷键: T)"打开目录抽屉 |
 * | `readTocList(page)` | 目录抽屉列表的度量快照：等已挂载行集合连续 2 帧不变后返回每行的下标、标签、文本、标题文本及其是否可见、`tabIndex`、`aria-current` 与位置，以及列表内容的总高度 |
 * | `scrollTocList(page, position)` | 把目录抽屉列表直接滚到顶部、中部或底部（8.7 的三处取样位置），等到 `scroll` 事件 |
 * | `scrollDetailGrid(page, position)` | 同上，对象为详情弹窗的章节网格（8.8） |
 * | `readDetailGrid(page)` | 详情弹窗章节网格的度量快照：等已挂载单元集合连续 2 帧不变后返回列数与每个单元的位置、文本 |
 * | `bookText(lib, id)` | 在测试进程中解压 `.txt.gz` 得到的全书文本（与浏览器 `Response.text()` 同样按 UTF-8 解码并去掉 BOM），按 worker 缓存（任务 10.4 起） |
 * | `findOccurrences(book, keyword, limit?)` | 关键词在全书中不区分大小写、互不重叠的出现次数 K 与前 `limit` 处的偏移（9.1） |
 * | `openSearchDrawer(page)` | 点顶栏"全书内容检索 (快捷键: F)"打开检索抽屉 |
 * | `readSearchResults(page)` | 检索抽屉结果列表的度量快照：每条的章节名、命中文字及其前后片段 |
 * | `readMainScroll(page)` / `setMainScrollTop(page, top)` | 读 / 设正文滚动容器（`<main>`）的滚动位置 |
 * | `readDocumentScroll(page)` / `setDocumentScrollTop(page, top)` | 读 / 设文档滚动元素的滚动位置（实测实际滚动的是文档，见 Findings_Log F-002） |
 * | `waitFrames(page, n?)` | 等 n 个动画帧（"不变"类断言前的等待；不能与 Controlled_Clock 同用） |
 * | `readJudgeParagraph(page)` | 9.5 的判定段落序号及其所依据的几何量（判定线、可视高度、正文高度、实际滚动元素）（任务 10.5 起；10.6 复用） |
 * | `judgeScrollTarget(reading, k)` | 使判定段落成为第 k 段的目标 `scrollTop`（对实际滚动元素） |
 * | `scrollJudgeParagraphTo(page, k)` | 把判定段落滚到第 k 段：设定实际滚动元素的 `scrollTop`，等到 `scroll` 事件，核对序号为 k |
 * | `openBookmarkList(page)` | 打开目录抽屉并切到"我的书签"页签（任务 10.6 起） |
 * | `readBookmarkEntries(page)` | "我的书签"列表的度量快照：每条的章节名与预览文字（任务 10.6 起） |
 *
 * ## 约定
 *
 * - 期望值一律来自 `TocFacts`（4.4）：下标、标题、正文序号都不写字面量。
 * - 元素经 `locators.ts` 定位（D8）；`countExactText` 与 `readTocList` 是只读的测量性 DOM 遍历，
 *   不用于定位要操作的元素。
 * - 顶栏与底栏在阅读器内导航（换章）后 4.5 s 自动隐藏（`ReaderPage` 的 `triggerShowControls`），
 *   隐藏时平移到视口之外、不可点击；页面刚加载完成时两者可见且不会自动隐藏。需要点击栏内按钮的
 *   步骤应紧跟在加载或换章之后。
 * - `readTocList`、`readDetailGrid` 以 `requestAnimationFrame` 判定稳定，不能在装了 Controlled_Clock
 *   的页面上使用（rAF 随时钟停住）。`scrollTocList`、`scrollDetailGrid` 等的是 `scroll` 事件，同样
 *   不能与 Controlled_Clock 同用。
 */
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { ROW_HEIGHT } from "../../src/utils/listWindow";
import type { BookLog, Lib } from "./fixtures";
import type { TocFacts } from "./library";
import { detailModal, reader, searchDrawer, tocDrawer } from "./locators";
import { BIG_BOOK_GZ_BYTES, TIMEOUTS } from "./settings";
import { step } from "./step";

// ---------------------------------------------------------------------------
// 书与导航
// ---------------------------------------------------------------------------

/** 用例所用的一本书：期望值与超时。 */
export interface BookUnderTest {
  id: string;
  /** 由 `_toc.json` 推导的期望值（4.4）。 */
  facts: TocFacts;
  /** `.txt.gz` 的字节数。 */
  gzBytes: number;
  /** gz ≥ `BIG_BOOK_GZ_BYTES`（6.8）。 */
  big: boolean;
  /** 等待该书加载完成的上限：大书为 `TIMEOUTS.bigBookLoad`，否则为 `TIMEOUTS.wait`（6.8）。 */
  loadTimeout: number;
}

/**
 * 取一本书的期望值与超时。gz ≥ `BIG_BOOK_GZ_BYTES` 时把当前用例的超时设为
 * `TIMEOUTS.bigBookTest`（6.8），因此须在用例体内调用。
 */
export async function bookUnderTest(lib: Lib, id: string): Promise<BookUnderTest> {
  const [facts, gzBytes] = await Promise.all([lib.tocFacts(id), lib.gzSize(id)]);
  const big = gzBytes >= BIG_BOOK_GZ_BYTES;
  if (big) test.info().setTimeout(TIMEOUTS.bigBookTest);
  return { id, facts, gzBytes, big, loadTimeout: big ? TIMEOUTS.bigBookLoad : TIMEOUTS.wait };
}

/** 阅读器的相对 URL：`/read/<id>`，给出 `ch` 时带 `?ch=<ch>`（原样写入，非法值也照写，供 8.12）。 */
export function readerPath(id: string, ch?: number | string): string {
  const base = `/read/${encodeURIComponent(id)}`;
  return ch === undefined ? base : `${base}?${new URLSearchParams({ ch: String(ch) }).toString()}`;
}

/**
 * 在当前页面打开 `readerPath(book.id, ch)`（一次完整导航），等到本次导航产生的 `[book-load]` 行
 * （上限 `book.loadTimeout`）与正文区的 `<h1>` 出现。不判定是哪一章，由调用方 `expectCurrentChapter`。
 */
export async function openReader(
  page: Page,
  bookLog: BookLog,
  book: BookUnderTest,
  ch?: number | string,
): Promise<void> {
  const url = readerPath(book.id, ch);
  await step(`打开 ${decodeURIComponent(url)}，等正文加载完成`, async () => {
    const since = bookLog.count;
    await page.goto(url);
    await bookLog.waitFor(book.id, undefined, { since, timeout: book.loadTimeout });
    await expect(reader(page).chapterHeading).toBeVisible();
  });
}

// ---------------------------------------------------------------------------
// 当前章节（8.1）
// ---------------------------------------------------------------------------

/** 正文区（`<main>`，不含其自身）内去掉首尾空白后文本与 `text` 完全相同的元素个数（测量）。 */
function countExactText(page: Page, text: string): Promise<number> {
  return reader(page).main.evaluate((root, wanted) => {
    let n = 0;
    for (const el of Array.from(root.querySelectorAll("*"))) {
      if ((el.textContent ?? "").trim() === wanted) n += 1;
    }
    return n;
  }, text);
}

/**
 * 断言当前章节为下标 `index` 的节点（8.1）：正文区（`<main>`，不含顶栏与底栏）的一级标题文本
 * 等于该节点标题；"第 N / M 章"的 N 为该节点在非卷节点中的序号（从 1 起）、M 为非卷节点数；
 * 正文区内去掉首尾空白后与标题完全相同的元素恰好 1 个。`index` 须为正文章节。
 */
export async function expectCurrentChapter(page: Page, facts: TocFacts, index: number): Promise<void> {
  const ordinal = facts.bodyOrdinals[index];
  if (ordinal === null || ordinal === undefined) {
    throw new Error(`下标 ${index} 不是正文章节（节点总数 ${facts.nodeCount}），不能作为当前章节`);
  }
  const title = facts.titles[index];
  const position = `第 ${ordinal + 1} / ${facts.bodyCount} 章`;
  const view = reader(page);
  await step(`8.1 当前章节为下标 ${index}「${title}」（${position}）`, async () => {
    await expect(view.chapterHeading, "正文区的一级标题应为该节点标题（8.1）").toHaveText(title);
    await expect(view.chapterPosition, "“第 N / M 章”应为该节点的正文序号与非卷节点数（8.1）").toHaveText(
      position,
    );
    await expect
      .poll(() => countExactText(page, title), {
        message: `正文区内与标题「${title}」完全相同的元素应恰好 1 个（8.1）`,
      })
      .toBe(1);
  });
}

/** 正文区"第 N / M 章"的 N 与 M。 */
export async function readChapterPosition(page: Page): Promise<{ n: number; m: number }> {
  const text = (await reader(page).chapterPosition.textContent()) ?? "";
  const match = /^第 (\d+) \/ (\d+) 章$/.exec(text.trim());
  if (match === null) throw new Error(`无法解析“第 N / M 章”：${JSON.stringify(text)}`);
  return { n: Number(match[1]), m: Number(match[2]) };
}

// ---------------------------------------------------------------------------
// 目录抽屉
// ---------------------------------------------------------------------------

/** 点顶栏"章节目录 (快捷键: T)"打开目录抽屉，等"章节目录 (M)"页签出现。 */
export async function openTocDrawer(page: Page): Promise<void> {
  await step("点击顶栏“章节目录”打开目录抽屉", async () => {
    await reader(page).tocButton.click();
    await expect(tocDrawer(page).marker).toBeVisible();
  });
}

// ---------------------------------------------------------------------------
// "我的书签"列表（任务 10.6 起）
// ---------------------------------------------------------------------------

/**
 * 经顶栏打开目录抽屉并点击"我的书签 (N)"页签，等页签内容出现（有书签时为条目的"删除此书签"按钮，
 * 没有时为"暂无书签"提示）。页签是抽屉组件内的状态，抽屉关闭后仍保持，这里总是显式点击一次。
 *
 * 注意：抽屉每次打开（及切换页签）后才从 localStorage 重读书签，页签上的计数在那之前的一次提交里
 * 可能还是上次打开时的值。断言计数请用会重试的 `toHaveText`，再读 `readBookmarkEntries`。
 */
export async function openBookmarkList(page: Page): Promise<void> {
  await openTocDrawer(page);
  await step("切到“我的书签”页签", async () => {
    const drawer = tocDrawer(page);
    await drawer.tabBookmarks.click();
    await expect(drawer.bookmarkDeleteButtons.or(drawer.noBookmarks).first()).toBeVisible();
  });
}

/** "我的书签"列表里的一条（度量快照）。 */
export interface BookmarkEntrySnapshot {
  /** 条目标题行的文本（章节名），去掉首尾空白。 */
  chapterTitle: string;
  /** 预览文字：条目内 `<p>` 的 `textContent`，原样（不去空白）；应用没有渲染预览时为 null。 */
  preview: string | null;
}

/**
 * 读"我的书签"列表（按文档顺序，即列表顺序）。条目本身没有 role（locators.ts 文件头），这里从
 * role 定位到的每个"删除此书签"按钮出发做只读的测量性遍历：按钮的父元素即条目，条目的第一个子
 * 元素是文字区，文字区的第一个子元素是标题行，文字区内的 `<p>` 是预览。抽屉须已切到"我的书签"。
 */
export function readBookmarkEntries(page: Page): Promise<BookmarkEntrySnapshot[]> {
  return tocDrawer(page).bookmarkDeleteButtons.evaluateAll((buttons) =>
    buttons.map((button) => {
      const info = button.parentElement?.firstElementChild ?? null;
      const preview = info?.getElementsByTagName("p")[0];
      return {
        chapterTitle: (info?.firstElementChild?.textContent ?? "").trim(),
        preview: preview === undefined ? null : (preview.textContent ?? ""),
      };
    }),
  );
}

/** 目录列表中一个已挂载的行（卷标题或章节按钮）。 */
export interface TocRowSnapshot {
  /** 行在列表内容中的上沿除以行高后取整，即该行对应的列表项下标（检索框为空时即节点下标）。 */
  index: number;
  /** 行在列表内容中的上沿（px，自内容顶部起）。 */
  offset: number;
  height: number;
  /** 行上沿、下沿相对列表可视区上沿的位置（px）；可视区为 [0, clientHeight)。 */
  visibleTop: number;
  visibleBottom: number;
  /** 元素标签名（大写），如 `H3`、`BUTTON`。 */
  tag: string;
  /** `textContent` 去掉首尾空白。 */
  text: string;
  /**
   * 行的标题文本：行内第一段非空文本节点去掉首尾空白（章节行为标题 span，其后才是"N字"；
   * 卷标题行为圆点之后的标题 span）。行内没有非空文本时为 ""（8.9、8.10）。
   */
  title: string;
  /**
   * `title` 那段文本是否可见地渲染（8.10）：其文字区域（Range 的外接矩形）宽高均 > 0 且与行的
   * 矩形相交；所在元素 `visibility` 为 `visible`、文字颜色的不透明度 > 0；自所在元素到文档根
   * 各级 `opacity` 的乘积 > 0。
   */
  titleVisible: boolean;
  /** 元素的 `tabIndex` 属性值；负数表示不在 Tab 焦点序列中。 */
  tabIndex: number;
  /** `aria-current` 属性；没有时为 null。 */
  ariaCurrent: string | null;
}

/** 目录列表（滚动容器）的一次度量。 */
export interface TocListSnapshot {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  /**
   * 列表内容本身的高度（px）：全部直接子元素（含 `aria-hidden` 的撑高占位）从最上沿到最下沿。
   * 内容超出可视区时与 `scrollHeight` 相同；不足一屏时 `scrollHeight` 等于 `clientHeight`，
   * 这个值仍是内容的高度（8.10）。
   */
  contentHeight: number;
  /** 已挂载的行，按文档顺序；不含 `aria-hidden` 的撑高占位元素。 */
  rows: TocRowSnapshot[];
  /** 从开始度量到判定稳定经过的动画帧数。 */
  frames: number;
}

interface TocListProbe {
  rowHeight: number;
  stableFrames: number;
  timeoutMs: number;
}

/** 目录抽屉列表中任一已挂载的行（章节按钮或卷标题），度量时由它向上找列表的滚动容器。 */
function tocRowAnchor(page: Page): Locator {
  const drawer = tocDrawer(page);
  return drawer.chapterRows.or(drawer.volumes).first();
}

/**
 * 读目录抽屉的列表：从一个已挂载的行（经 `locators.ts` 定位）向上找到最近的纵向滚动容器，
 * 在连续的动画帧里读取其直接子元素（跳过 `aria-hidden` 的占位元素），直到滚动位置与已挂载行
 * 集合连续 2 帧不变（8.7 的"连续 2 个动画帧不变"，即 3 次读数相同）后返回。
 * 上限 `TIMEOUTS.wait` 内不稳定即抛错。只读，不改动页面。
 */
export async function readTocList(page: Page): Promise<TocListSnapshot> {
  const anchor = tocRowAnchor(page);
  const probe: TocListProbe = { rowHeight: ROW_HEIGHT, stableFrames: 2, timeoutMs: TIMEOUTS.wait };
  return anchor.evaluate(async (row, { rowHeight, stableFrames, timeoutMs }) => {
    const scrolls = (el: Element): boolean => {
      const overflow = getComputedStyle(el).overflowY;
      return overflow === "auto" || overflow === "scroll";
    };
    let list: HTMLElement | null = row.parentElement;
    while (list !== null && !scrolls(list)) list = list.parentElement;
    if (list === null) throw new Error("找不到目录行所在的纵向滚动容器");
    const container = list;

    /** 计算样式颜色的不透明度：`transparent` 为 0，`rgb()` 为 1，`rgba()` / `rgb(… / a)` 取 a。 */
    const alphaOf = (color: string): number => {
      if (color === "transparent") return 0;
      const match = /^rgba?\(([^)]*)\)$/.exec(color);
      if (match === null) return 1;
      const parts = match[1].split(/[\s,/]+/).filter((p) => p !== "");
      return parts.length >= 4 ? Number(parts[3]) : 1;
    };
    /** 行内第一段非空文本及其是否可见地渲染（见 `TocRowSnapshot.title` / `titleVisible`）。 */
    const titleOf = (row: Element, rowRect: DOMRect): { title: string; titleVisible: boolean } => {
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const title = (node.textContent ?? "").trim();
        if (title === "") continue;
        const holder = node.parentElement ?? row;
        const range = document.createRange();
        range.selectNodeContents(node);
        const box = range.getBoundingClientRect();
        const style = getComputedStyle(holder);
        let opacity = 1;
        for (let el: Element | null = holder; el !== null; el = el.parentElement) {
          opacity *= Number(getComputedStyle(el).opacity);
        }
        const titleVisible =
          box.width > 0 &&
          box.height > 0 &&
          box.right > rowRect.left &&
          box.left < rowRect.right &&
          box.bottom > rowRect.top &&
          box.top < rowRect.bottom &&
          style.visibility === "visible" &&
          alphaOf(style.color) > 0 &&
          opacity > 0;
        return { title, titleVisible };
      }
      return { title: "", titleVisible: false };
    };

    const read = () => {
      const box = container.getBoundingClientRect();
      const top0 = box.top + container.clientTop;
      const rows: TocRowSnapshot[] = [];
      let contentTop = Number.POSITIVE_INFINITY;
      let contentBottom = Number.NEGATIVE_INFINITY;
      for (const el of Array.from(container.children)) {
        const rect = el.getBoundingClientRect();
        contentTop = Math.min(contentTop, rect.top);
        contentBottom = Math.max(contentBottom, rect.bottom);
        if (el.getAttribute("aria-hidden") === "true") continue;
        const visibleTop = rect.top - top0;
        const offset = visibleTop + container.scrollTop;
        rows.push({
          index: Math.round(offset / rowHeight),
          offset,
          height: rect.height,
          visibleTop,
          visibleBottom: rect.bottom - top0,
          tag: el.tagName,
          text: (el.textContent ?? "").trim(),
          ...titleOf(el, rect),
          tabIndex: el instanceof HTMLElement ? el.tabIndex : -1,
          ariaCurrent: el.getAttribute("aria-current"),
        });
      }
      return {
        scrollTop: container.scrollTop,
        clientHeight: container.clientHeight,
        scrollHeight: container.scrollHeight,
        contentHeight: contentBottom > contentTop ? contentBottom - contentTop : 0,
        rows,
      };
    };
    type Reading = ReturnType<typeof read>;
    const key = (r: Reading): string =>
      JSON.stringify([
        r.scrollTop,
        r.clientHeight,
        r.scrollHeight,
        r.contentHeight,
        r.rows.map((x) => [x.tag, x.text, x.offset, x.ariaCurrent, x.titleVisible]),
      ]);
    const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    const started = performance.now();
    let previous = read();
    let unchanged = 0;
    for (let frames = 1; ; frames++) {
      await nextFrame();
      const current = read();
      unchanged = key(current) === key(previous) ? unchanged + 1 : 0;
      previous = current;
      if (unchanged >= stableFrames) return { ...current, frames };
      if (performance.now() - started > timeoutMs) {
        throw new Error(`目录列表在 ${timeoutMs} ms（${frames} 帧）内未连续 ${stableFrames} 帧保持不变`);
      }
    }
  }, probe);
}

/** 行是否完整位于列表可视区内（容差 0.5 px，吸收亚像素取整）。 */
export function rowFullyVisible(list: TocListSnapshot, row: TocRowSnapshot): boolean {
  return row.visibleTop >= -0.5 && row.visibleBottom <= list.clientHeight + 0.5;
}

// ---------------------------------------------------------------------------
// 列表的三处取样位置（8.7、8.8）
// ---------------------------------------------------------------------------

/** 8.7 / 8.8 的取样位置：顶部、中部、底部。 */
export type ScrollPosition = "top" | "middle" | "bottom";

/** 取样顺序（8.7："依次滚动到顶部、中部与底部"）。 */
export const SCROLL_POSITIONS: readonly ScrollPosition[] = ["top", "middle", "bottom"];

/** 各位置的定义（8.7 原文），用于步骤名与报错信息。 */
export const SCROLL_POSITION_LABELS: Readonly<Record<ScrollPosition, string>> = {
  top: "顶部（scrollTop 为 0）",
  middle: "中部（scrollTop 为 (scrollHeight − clientHeight) / 2）",
  bottom: "底部（scrollTop 为 scrollHeight − clientHeight）",
};

/** 一次滚动定位的结果。 */
export interface ScrollApplied {
  position: ScrollPosition;
  /** 按定义算出的目标 `scrollTop`（中部可为小数）。 */
  target: number;
  /** 赋值后容器报告的 `scrollTop`（浏览器可能取整）。 */
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

interface ScrollProbe {
  position: ScrollPosition;
  timeoutMs: number;
}

/**
 * 从 `anchor`（经 `locators.ts` 定位的一个已挂载行或单元）向上找到最近的纵向滚动容器，按
 * `position` 的定义直接设定其 `scrollTop`（不经滚轮或键盘，也没有平滑滚动）。滚动位置确有变化时
 * 等到该容器的 `scroll` 事件（上限 `TIMEOUTS.wait`），应用据此在下一帧重算挂载区间；位置本来就
 * 是目标值时不会有 `scroll` 事件，直接返回。挂载区间是否已稳定由随后的 `readTocList` /
 * `readDetailGrid` 判定。
 */
async function scrollAncestorTo(anchor: Locator, position: ScrollPosition): Promise<ScrollApplied> {
  const probe: ScrollProbe = { position, timeoutMs: TIMEOUTS.wait };
  return anchor.evaluate(async (el, { position: where, timeoutMs }) => {
    const scrolls = (node: Element): boolean => {
      const overflow = getComputedStyle(node).overflowY;
      return overflow === "auto" || overflow === "scroll";
    };
    let found: HTMLElement | null = el.parentElement;
    while (found !== null && !scrolls(found)) found = found.parentElement;
    if (found === null) throw new Error("找不到该元素所在的纵向滚动容器");
    const container = found;

    const max = container.scrollHeight - container.clientHeight;
    const target = where === "top" ? 0 : where === "middle" ? max / 2 : max;
    const before = container.scrollTop;

    const scrolled = new Promise<void>((resolve) => {
      container.addEventListener("scroll", () => resolve(), { once: true });
    });
    let timer = 0;
    const timedOut = new Promise<never>((_, reject) => {
      timer = window.setTimeout(
        () => reject(new Error(`设定 scrollTop = ${target} 后 ${timeoutMs} ms 内未收到 scroll 事件`)),
        timeoutMs,
      );
    });
    container.scrollTop = target;
    try {
      if (container.scrollTop !== before) await Promise.race([scrolled, timedOut]);
    } finally {
      window.clearTimeout(timer);
    }
    return {
      position: where,
      target,
      scrollTop: container.scrollTop,
      scrollHeight: container.scrollHeight,
      clientHeight: container.clientHeight,
    };
  }, probe);
}

/** 把目录抽屉的列表滚到 `position`（8.7）。抽屉须已打开且至少挂载 1 行。 */
export async function scrollTocList(page: Page, position: ScrollPosition): Promise<ScrollApplied> {
  return scrollAncestorTo(tocRowAnchor(page), position);
}

// ---------------------------------------------------------------------------
// 详情弹窗的章节网格（8.8）
// ---------------------------------------------------------------------------

/** 详情弹窗章节网格中任一已挂载的单元（章节按钮），度量时由它找到网格与滚动容器。 */
function detailGridAnchor(page: Page): Locator {
  return detailModal(page).chapterRows.first();
}

/** 把详情弹窗的章节网格滚到 `position`（8.8）。弹窗须已打开且网格至少挂载 1 个单元。 */
export async function scrollDetailGrid(page: Page, position: ScrollPosition): Promise<ScrollApplied> {
  return scrollAncestorTo(detailGridAnchor(page), position);
}

/** 章节网格中一个已挂载的单元。 */
export interface GridCellSnapshot {
  /** 单元上沿在滚动内容中的位置（px，自内容顶部起，含滚动容器的内边距）。 */
  offset: number;
  /** 单元左沿相对滚动容器左沿的位置（px）。 */
  left: number;
  height: number;
  /** 单元上沿、下沿相对滚动容器可视区上沿的位置（px）；可视区为 [0, clientHeight)。 */
  visibleTop: number;
  visibleBottom: number;
  /** `textContent` 去掉首尾空白。 */
  text: string;
}

/** 章节网格（滚动容器与网格元素）的一次度量。 */
export interface DetailGridSnapshot {
  scrollTop: number;
  /** 滚动容器的可视高度，即 8.8 的"网格可视高度"。 */
  clientHeight: number;
  scrollHeight: number;
  /** 网格元素计算样式 `grid-template-columns` 的列轨道数，即网格实际渲染的列数（8.8）。 */
  columns: number;
  /** 网格元素的全部子元素（已挂载的单元），按文档顺序。 */
  cells: GridCellSnapshot[];
  /** 从开始度量到判定稳定经过的动画帧数。 */
  frames: number;
}

interface GridProbe {
  stableFrames: number;
  timeoutMs: number;
}

/**
 * 读详情弹窗的章节网格：从一个已挂载的单元（经 `locators.ts` 定位）取其父元素（须为
 * `display: grid` 的网格），再向上找到最近的纵向滚动容器；在连续的动画帧里读取网格的列轨道数
 * 与全部子元素，直到滚动位置、列数与已挂载单元集合连续 2 帧不变（8.8 的"连续 2 个动画帧
 * 不变"）后返回。上限 `TIMEOUTS.wait` 内不稳定即抛错。只读，不改动页面。
 */
export async function readDetailGrid(page: Page): Promise<DetailGridSnapshot> {
  const probe: GridProbe = { stableFrames: 2, timeoutMs: TIMEOUTS.wait };
  return detailGridAnchor(page).evaluate(async (cell, { stableFrames, timeoutMs }) => {
    const grid = cell.parentElement;
    if (grid === null || getComputedStyle(grid).display !== "grid") {
      throw new Error("章节单元的父元素不是 display: grid 的网格");
    }
    const scrolls = (node: Element): boolean => {
      const overflow = getComputedStyle(node).overflowY;
      return overflow === "auto" || overflow === "scroll";
    };
    let found: HTMLElement | null = grid.parentElement;
    while (found !== null && !scrolls(found)) found = found.parentElement;
    if (found === null) throw new Error("找不到章节网格所在的纵向滚动容器");
    const container = found;

    /** 计算样式的列轨道数：去掉 `[name]` 行名后按空白切分；`none` 为 0。 */
    const trackCount = (value: string): number => {
      if (value.trim() === "none") return 0;
      return value
        .replace(/\[[^\]]*\]/g, " ")
        .trim()
        .split(/\s+/)
        .filter((t) => t !== "").length;
    };

    const read = () => {
      const box = container.getBoundingClientRect();
      const top0 = box.top + container.clientTop;
      const left0 = box.left + container.clientLeft;
      const cells: GridCellSnapshot[] = [];
      for (const el of Array.from(grid.children)) {
        const rect = el.getBoundingClientRect();
        const visibleTop = rect.top - top0;
        cells.push({
          offset: visibleTop + container.scrollTop,
          left: rect.left - left0,
          height: rect.height,
          visibleTop,
          visibleBottom: rect.bottom - top0,
          text: (el.textContent ?? "").trim(),
        });
      }
      return {
        scrollTop: container.scrollTop,
        clientHeight: container.clientHeight,
        scrollHeight: container.scrollHeight,
        columns: trackCount(getComputedStyle(grid).gridTemplateColumns),
        cells,
      };
    };
    type Reading = ReturnType<typeof read>;
    const key = (r: Reading): string =>
      JSON.stringify([
        r.scrollTop,
        r.clientHeight,
        r.scrollHeight,
        r.columns,
        r.cells.map((c) => [c.text, c.offset, c.left]),
      ]);
    const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    const started = performance.now();
    let previous = read();
    let unchanged = 0;
    for (let frames = 1; ; frames++) {
      await nextFrame();
      const current = read();
      unchanged = key(current) === key(previous) ? unchanged + 1 : 0;
      previous = current;
      if (unchanged >= stableFrames) return { ...current, frames };
      if (performance.now() - started > timeoutMs) {
        throw new Error(`章节网格在 ${timeoutMs} ms（${frames} 帧）内未连续 ${stableFrames} 帧保持不变`);
      }
    }
  }, probe);
}

// ---------------------------------------------------------------------------
// 正文滚动容器与动画帧（任务 10.4 起）
// ---------------------------------------------------------------------------

/** 正文滚动容器（`<main>`）的一次读数。 */
export interface MainScroll {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

/** 读正文滚动容器（`<main>`）的 `scrollTop`、`clientHeight` 与 `scrollHeight`（只读）。 */
export function readMainScroll(page: Page): Promise<MainScroll> {
  return reader(page).main.evaluate((el) => ({
    scrollTop: el.scrollTop,
    clientHeight: el.clientHeight,
    scrollHeight: el.scrollHeight,
  }));
}

/**
 * 直接设定正文滚动容器的 `scrollTop`（不经滚轮或键盘，没有平滑滚动；设计"补充场景"10.9 的
 * 前置同样如此），返回赋值后容器报告的值（浏览器会夹到可滚范围内）。不等待 `scroll` 事件；
 * 需要应用处理完滚动时由调用方随后 `waitFrames` 或推进 Controlled_Clock。
 */
export function setMainScrollTop(page: Page, top: number): Promise<number> {
  return reader(page).main.evaluate((el, value) => {
    el.scrollTop = value;
    return el.scrollTop;
  }, top);
}

/**
 * 读文档滚动元素（`document.scrollingElement`）的滚动位置（只读）。
 *
 * 按设计，正文滚动容器是 `<main>`；但实测 `<main>` 的高度随内容增长、自身不滚动，实际滚动的是文档
 * （Findings_Log F-002）。需要"滚动位置不变"一类判断且不应依赖 F-002 的用例，可同时读两者。
 */
export function readDocumentScroll(page: Page): Promise<MainScroll> {
  return page.evaluate(() => {
    const el = document.scrollingElement ?? document.documentElement;
    return { scrollTop: el.scrollTop, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight };
  });
}

/** 直接设定文档滚动元素的 `scrollTop`，返回赋值后的值（见 `readDocumentScroll`、`setMainScrollTop`）。 */
export function setDocumentScrollTop(page: Page, top: number): Promise<number> {
  return page.evaluate((value) => {
    const el = document.scrollingElement ?? document.documentElement;
    el.scrollTop = value;
    return el.scrollTop;
  }, top);
}

/**
 * 等 `count` 个动画帧（`requestAnimationFrame` 连续 `count` 次）。设计"补充场景的定位与断言"：
 * "不变"类断言在按键或点击后等 2 个动画帧再比较，不用固定时长。
 *
 * 装了 Controlled_Clock 的页面上 rAF 随时钟停住，不能用本函数；那时改为 `page.clock.runFor`
 * 推进 `count × CLOCK_STEP_MS`。
 */
export async function waitFrames(page: Page, count = 2): Promise<void> {
  await page.evaluate(async (n) => {
    for (let i = 0; i < n; i++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

// ---------------------------------------------------------------------------
// 判定段落（需求 9.5 的定义；任务 10.5 起，10.6 的书签用例复用）
// ---------------------------------------------------------------------------
//
// 9.5：判定段落是 `<article>` 中章节标题区之后的正文 `<p>` 里，边界框上边 ≤ 滚动容器（`<main>`）
// 边界框上边 + 56 px（顶栏高度）+ 1 px 取整余量的最后一个；无此段时取第 0 段；序号从 0 起算。
//
// 这里的"`<main>` 边界框上边"取 `<main>` 边界框与视口交集的上边，即 `max(main.top, 0)`（视口坐标）：
//
// - 按设计 `<main>` 是铺满视口、自身滚动的容器，边界框上边恒为 0，与交集的上边相同，定义不受影响。
// - 实测（Findings_Log F-002）`<main>` 随内容增高、滚动的是文档：`<main>` 的边界框随文档一起上移，
//   各段与它的相对位置不随滚动变化。按字面取边界框上边时判定线跟着内容走，判定段落恒为第 0 段
//   （首段在 `<main>` 的 64 px 上内边距与章节标题区之下），"把判定段落滚到第 k 段"无从做起，
//   度量的就只是 F-002 本身而不是阅读位置。取交集的上边，判定线在两种布局下都落在顶栏下沿
//   （视口 56 px 处）加 1 px，即读者看到的"视口首个可见段落"，与应用自己的判定
//   （`ReaderPage` 的 `scrollTop + TOP_BIAS`）同义。
//
// "滚动容器可视高度"（9.8）按同一口径取交集的高度；"正文高度"取正文首段上边到末段下边的距离。
// 滚动时操作实际在滚动的元素：`<main>` 可滚动（`overflow-y` 为 auto/scroll 且有可滚距离）时是它，
// 否则是文档滚动元素（`document.scrollingElement`）。F-002 修复后无需改动这里。
//
// 这些函数只读几何量、直接赋值 `scrollTop`，不依赖 `requestAnimationFrame`，可与 Controlled_Clock
// 同用：`scroll` 事件由浏览器的渲染步骤派发，不受时钟控制。

/** 9.5：判定线在滚动容器可视区上边之下的距离（顶栏高度，`Header` 的 `h-14`）。 */
export const JUDGE_TOP_BAR_PX = 56;

/** 9.5：判定线的取整余量。 */
export const JUDGE_ROUNDING_PX = 1;

/** 实际在滚动的元素。按设计是 `<main>`；实测是文档（F-002）。 */
export type ReaderScroller = "main" | "document";

/** 判定段落的一次读数（几何量均为视口坐标，单位 px）。 */
export interface JudgeReading {
  /** 判定段落序号（从 0 起）。 */
  index: number;
  /** 正文段落数（`<article>` 内章节标题区之后的 `<p>`）。 */
  count: number;
  /** 判定线：`visibleTop + 56 + 1`。 */
  line: number;
  /** `<main>` 边界框上边。 */
  mainTop: number;
  /** `<main>` 边界框与视口交集的上边：`max(mainTop, 0)`。 */
  visibleTop: number;
  /** 滚动容器可视高度：`<main>` 边界框与视口交集的高度（9.8）。 */
  visibleHeight: number;
  /** 正文高度：正文首段上边到末段下边（9.8）；没有段落时为 0。 */
  bodyHeight: number;
  /** 各正文段落的边界框上边，按文档顺序。 */
  tops: number[];
  /** 实际在滚动的元素；`<main>` 与文档都不可滚动时为 null。 */
  scroller: ReaderScroller | null;
  /** `scroller` 的 `scrollTop`（为 null 时取文档的）。 */
  scrollTop: number;
  /** `scroller` 的最大可滚距离 `scrollHeight − clientHeight`（为 null 时为 0）。 */
  maxScrollTop: number;
  /** `<main>` 与文档滚动元素各自的 `scrollTop`。 */
  mainScrollTop: number;
  documentScrollTop: number;
}

interface JudgeProbe {
  main: HTMLElement;
  article: HTMLElement;
  topBar: number;
  rounding: number;
}

/**
 * 读判定段落（9.5）。段落经 `reader(page).paragraphs` 定位（D8）；`<main>`、`<article>` 的几何量与
 * 章节标题区（`<article>` 的 `<header>` 子元素）只作度量。只读，不改动页面。
 */
export async function readJudgeParagraph(page: Page): Promise<JudgeReading> {
  const view = reader(page);
  const [main, article] = await Promise.all([view.main.elementHandle(), view.article.elementHandle()]);
  if (main === null || article === null) throw new Error("找不到正文 <main> 或 <article>");
  try {
    const probe = { main, article, topBar: JUDGE_TOP_BAR_PX, rounding: JUDGE_ROUNDING_PX };
    return await view.paragraphs.evaluateAll((elements, arg): JudgeReading => {
      const { main: mainEl, article: articleEl, topBar, rounding } = arg as unknown as JudgeProbe;
      // 章节标题区之后的 <p>：标题区里目前没有 <p>，仍按定义排除它及其之前的段落
      const header = articleEl.querySelector(":scope > header");
      const body = elements.filter(
        (p) =>
          header === null ||
          (!header.contains(p) && (header.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0),
      );

      const viewportHeight = document.documentElement.clientHeight;
      const mainRect = mainEl.getBoundingClientRect();
      const visibleTop = Math.max(mainRect.top, 0);
      const visibleBottom = Math.min(mainRect.bottom, viewportHeight);
      const line = visibleTop + topBar + rounding;

      const rects = body.map((p) => p.getBoundingClientRect());
      const tops = rects.map((r) => r.top);
      let index = 0;
      tops.forEach((top, i) => {
        if (top <= line) index = i;
      });

      const doc = document.scrollingElement ?? document.documentElement;
      const overflow = getComputedStyle(mainEl).overflowY;
      const mainScrolls =
        (overflow === "auto" || overflow === "scroll") && mainEl.scrollHeight - mainEl.clientHeight >= 1;
      const docScrolls = doc.scrollHeight - doc.clientHeight >= 1;
      const scroller = mainScrolls ? "main" : docScrolls ? "document" : null;
      const el = scroller === "main" ? mainEl : doc;

      return {
        index,
        count: body.length,
        line,
        mainTop: mainRect.top,
        visibleTop,
        visibleHeight: Math.max(0, visibleBottom - visibleTop),
        bodyHeight: rects.length > 0 ? rects[rects.length - 1].bottom - rects[0].top : 0,
        tops,
        scroller,
        scrollTop: el.scrollTop,
        maxScrollTop: scroller === null ? 0 : el.scrollHeight - el.clientHeight,
        mainScrollTop: mainEl.scrollTop,
        documentScrollTop: doc.scrollTop,
      };
    }, probe);
  } finally {
    await Promise.all([main.dispose(), article.dispose()]);
  }
}

/**
 * 使判定段落成为第 `k` 段所需的 `scrollTop`（对 `reading.scroller`）：把第 k 段的上边放到可视区上边
 * 之下 56 px 处（判定线之上 1 px；第 k + 1 段的上边随之在判定线之下）。与应用恢复位置时的
 * `tops[k] − TOP_BIAS` 同义。可能超出 `[0, maxScrollTop]`，由调用方判断能否滚到。
 */
export function judgeScrollTarget(reading: JudgeReading, k: number): number {
  const top = reading.tops[k];
  if (top === undefined) throw new Error(`第 ${k} 段不存在（共 ${reading.count} 段）`);
  return reading.scrollTop + Math.round(top - (reading.visibleTop + JUDGE_TOP_BAR_PX));
}

/** `scrollJudgeParagraphTo` 在页面上记录"已收到 scroll 事件"的属性名。 */
const SCROLL_SEEN_FLAG = "__e2eJudgeScrollSeen";

/**
 * 把判定段落滚到第 `k` 段：对实际滚动元素直接赋值 `judgeScrollTarget` 算出的 `scrollTop`（不经滚轮或
 * 键盘，没有平滑滚动），等到该元素（文档滚动时为 `document`）的 `scroll` 事件，再读一次判定段落并
 * 断言序号为 `k`。返回滚动后的读数。目标超出可滚范围、或滚后序号不为 `k` 时失败（测试自身的问题，16.6）。
 */
export async function scrollJudgeParagraphTo(page: Page, k: number): Promise<JudgeReading> {
  return step(`把判定段落滚到第 ${k} 段（设定实际滚动元素的 scrollTop，等到 scroll 事件）`, async () => {
    const before = await readJudgeParagraph(page);
    if (before.scroller === null) throw new Error("<main> 与文档都没有可滚距离，无法滚动正文");
    const target = judgeScrollTarget(before, k);
    if (target < 0 || target > before.maxScrollTop) {
      throw new Error(
        `第 ${k} 段滚不到判定线：目标 scrollTop ${target} 不在 [0, ${before.maxScrollTop}] 内（${before.scroller}）`,
      );
    }
    const applied = await reader(page).main.evaluate(
      (mainEl, { scroller, top, flag }) => {
        const el = scroller === "main" ? mainEl : (document.scrollingElement ?? document.documentElement);
        const eventTarget: EventTarget = scroller === "main" ? mainEl : document;
        const w = window as unknown as Record<string, unknown>;
        w[flag] = false;
        eventTarget.addEventListener(
          "scroll",
          () => {
            w[flag] = true;
          },
          { once: true },
        );
        const from = el.scrollTop;
        el.scrollTop = top;
        return { from, to: el.scrollTop };
      },
      { scroller: before.scroller, top: target, flag: SCROLL_SEEN_FLAG },
    );
    if (applied.to !== applied.from) {
      await expect
        .poll(
          () => page.evaluate((flag) => (window as unknown as Record<string, unknown>)[flag] === true, SCROLL_SEEN_FLAG),
          { message: `设定 ${before.scroller} 的 scrollTop = ${target} 后应收到 scroll 事件` },
        )
        .toBe(true);
    }
    const after = await readJudgeParagraph(page);
    expect(
      after.index,
      `判定段落应为第 ${k} 段（${after.scroller} scrollTop ${applied.from} → ${applied.to}，判定线 ${after.line}，` +
        `第 ${k} 段上边 ${after.tops[k]}）`,
    ).toBe(k);
    return after;
  });
}

// ---------------------------------------------------------------------------
// 全书文本（任务 10.4 起；A11y_Scan、像素基线与性能观测的检索词核对可复用）
// ---------------------------------------------------------------------------

/** 测试进程中解压得到的一本书的全文。 */
export interface BookText {
  id: string;
  /** 全书文本：`.txt.gz` 解压后按 UTF-8 解码、去掉开头的 BOM（与浏览器 `Response.text()` 相同）。 */
  text: string;
  /** `text.toLowerCase()`，与 `text` 等长（不等长时 `bookText` 即抛错，偏移无法对应）。 */
  lower: string;
}

const gunzipAsync = promisify(gunzip);

/** 按 worker 缓存的全文，键为 `<profile>\0<id>`。real 的大书解压一次约 0.2 s、占内存约 80 MB。 */
const bookTexts = new Map<string, Promise<BookText>>();

async function decodeBookText(id: string, file: string): Promise<BookText> {
  const raw = await gunzipAsync(await readFile(file));
  // 与应用相同：`Response.text()` 按 UTF-8 解码（非法序列替换为 U+FFFD）并去掉 BOM
  const text = new TextDecoder("utf-8").decode(raw);
  const lower = text.toLowerCase();
  if (lower.length !== text.length) {
    throw new Error(
      `${id} 的全文转小写后长度由 ${text.length} 变为 ${lower.length}，不区分大小写的命中偏移无法与原文对应`,
    );
  }
  return { id, text, lower };
}

/**
 * 当前书库中一本书的全文（在测试进程中用 `node:zlib` 解压 `lib.gzPath(id)`），按 worker 缓存。
 * 期望值（命中次数、命中所在章节等）由它在运行时推导（4.4、9.1）。
 */
export function bookText(lib: Lib, id: string): Promise<BookText> {
  const key = `${lib.profile}\u0000${id}`;
  let cached = bookTexts.get(key);
  if (cached === undefined) {
    cached = decodeBookText(id, lib.gzPath(id));
    bookTexts.set(key, cached);
    cached.catch(() => bookTexts.delete(key));
  }
  return cached;
}

/** 关键词在全书中的出现情况。 */
export interface Occurrences {
  keyword: string;
  /** K：不区分大小写、互不重叠的出现次数（9.1）。 */
  count: number;
  /** 前 `limit` 处出现的全书偏移（UTF-16 码元，自全文开头起），升序。 */
  offsets: number[];
}

/**
 * 数 `keyword` 在全书中不区分大小写、互不重叠的出现次数（9.1 的 K）：从头依次查找，每次命中后
 * 从命中末尾继续。同时记下前 `limit` 处的偏移（默认全部）。`keyword` 须非空。
 */
export function findOccurrences(
  book: BookText,
  keyword: string,
  limit = Number.POSITIVE_INFINITY,
): Occurrences {
  const needle = keyword.toLowerCase();
  if (needle === "") throw new Error("findOccurrences 的关键词不能为空");
  const offsets: number[] = [];
  let count = 0;
  for (let from = 0; ; ) {
    const at = book.lower.indexOf(needle, from);
    if (at < 0) break;
    count += 1;
    if (offsets.length < limit) offsets.push(at);
    from = at + needle.length;
  }
  return { keyword, count, offsets };
}

// ---------------------------------------------------------------------------
// 检索抽屉（任务 10.4 起）
// ---------------------------------------------------------------------------

/** 点顶栏"全书内容检索 (快捷键: F)"打开检索抽屉，等抽屉标题与检索框出现。 */
export async function openSearchDrawer(page: Page): Promise<void> {
  await step("点击顶栏“全书内容检索”打开检索抽屉", async () => {
    await reader(page).searchButton.click();
    const drawer = searchDrawer(page);
    await expect(drawer.marker).toBeVisible();
    await expect(drawer.input).toBeVisible();
  });
}

/** 检索抽屉里的一条结果（度量快照）。 */
export interface SearchResultSnapshot {
  /** 结果项顶部的章节名（去掉首尾空白）。 */
  chapterTitle: string;
  /** 命中之前的片段，即 `<mark>` 前一个节点的文本（应用在片段前加了 "..."）。 */
  before: string;
  /** `<mark>` 的文本，即命中文字（保持原文大小写）。 */
  mark: string;
  /** 命中之后的片段，即 `<mark>` 后一个节点的文本（应用在片段后加了 "..."）。 */
  after: string;
}

/**
 * 读检索抽屉的结果列表（`searchDrawer(page).results`，按文档顺序）。从 role 定位到的结果按钮
 * 出发做只读的测量性遍历：章节名取按钮的第一个子元素的文本，命中取按钮内的 `<mark>` 及其
 * 前后两个节点的文本。调用前应先等结果条数稳定（如 `toHaveCount`）。
 */
export function readSearchResults(page: Page): Promise<SearchResultSnapshot[]> {
  return searchDrawer(page).results.evaluateAll((buttons) =>
    buttons.map((button) => {
      const mark = button.getElementsByTagName("mark")[0] as HTMLElement | undefined;
      return {
        chapterTitle: (button.firstElementChild?.textContent ?? "").trim(),
        before: mark?.previousSibling?.textContent ?? "",
        mark: mark?.textContent ?? "",
        after: mark?.nextSibling?.textContent ?? "",
      };
    }),
  );
}
