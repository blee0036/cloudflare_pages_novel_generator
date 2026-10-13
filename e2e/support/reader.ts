/**
 * 阅读器场景的共用步骤与度量（任务 10.1 起；10.2–10.6、11.x 复用）。
 *
 * | 函数 | 作用 |
 * | --- | --- |
 * | `bookUnderTest(lib, id)` | 取 `_toc.json` 推导的 `TocFacts` 与 gz 字节数；gz ≥ `BIG_BOOK_GZ_BYTES` 时把本用例超时设为 `TIMEOUTS.bigBookTest`，并给出等待加载的上限（6.8） |
 * | `readerPath(id, ch?)` | `/read/<id>`（可带 `?ch=`），书 id 经百分号编码 |
 * | `openReader(page, bookLog, book, ch?)` | 导航到阅读器，等本次导航的 `[book-load]` 行与正文 `<h1>` |
 * | `readCurrentRegion(page)` | 当前章 / 当前页的区域（带 `data-current="true"` 的 `section[data-chapter-id]` 或分页图层）及其章号（翻页模式任务 21.2 起） |
 * | `expectCurrentChapter(page, facts, index)` | 8.1 的"当前章节"判定（其余各条所说的当前章节均按此判定），以当前章区域为界，并等到 URL 的 `ch` 写回为该下标（reader-defect-fixes 需求 7.1） |
 * | `urlChapterParams(page)` | 页面 URL 中 `ch` 查询参数的全部取值（读 `page.url()`） |
 * | `readChapterPosition(page)` | 读"第 N / M 章"的 N、M |
 * | `PAGE_MODES` / `pageModeSpec(anim)` | 五种翻页模式的编号、设置抽屉按钮文字与 `<main data-page-mode>` 取值（翻页模式需求 1.3） |
 * | `seedPageMode(context, anim)` | 首次导航之前把已存储的 `pageAnim` 写为 `anim`（`addInitScript`，与 `seedTheme` 同一口径） |
 * | `selectPageMode(page, anim, options?)` | 经设置抽屉"翻页模式"选项组切换，核对 `aria-pressed`、`data-page-mode` 与存储的 `pageAnim`（需求 1.4、1.5） |
 * | `readStoredPageAnim(page)` | localStorage 设置键里的 `pageAnim` 原值 |
 * | `readPagedView(page)` / `waitPageTurnSettled(page)` | 读分页视图的 `data-page-mode`、`data-turning`、`data-paginated` 与当前页的 `data-page-*`；等 `data-turning="false"` 且当前页就位 |
 * | `TAP_ZONES` / `TAP_ZONE_ACTIONS` / `tapZoneCenter(page, zone)` | 九宫格的 9 区、各区的动作（需求 5.2–5.4），按区中心点击 `<main>`（含"点 MC 唤出控制栏"） |
 * | `readControlsVisible(page)` | 顶栏与底栏的滑入滑出过渡结束后，两者是否完整位于视口内 |
 * | `reshowControls(page)` | 重新亮起控制栏：可见时先点 MC 隐藏再点 MC 唤出，不可见时点一次 MC；返回时控制栏可见、4.5 s 自动隐藏刚开始计时 |
 * | `openTocDrawer(page)` | 点顶栏"章节目录 (快捷键: T)"打开目录抽屉 |
 * | `readTocList(page)` | 目录抽屉列表的度量快照：等已挂载行集合连续 2 帧不变后返回每行的下标、标签、文本、标题文本及其是否可见、`tabIndex`、`aria-current` 与位置，以及列表内容的总高度 |
 * | `scrollTocList(page, position)` | 把目录抽屉列表直接滚到顶部、中部或底部（8.7 的三处取样位置），等到 `scroll` 事件 |
 * | `scrollDetailGrid(page, position)` | 同上，对象为详情弹窗的章节网格（8.8） |
 * | `readDetailGrid(page)` | 详情弹窗章节网格的度量快照：等已挂载单元集合连续 2 帧不变后返回列数与每个单元的位置、文本 |
 * | `bookText(lib, id)` | 在测试进程中解压 `.txt.gz` 得到的全书文本（与浏览器 `Response.text()` 同样按 UTF-8 解码并去掉 BOM），按 worker 缓存（任务 10.4 起） |
 * | `findOccurrences(book, keyword, limit?)` | 关键词在全书中不区分大小写、互不重叠的出现次数 K 与前 `limit` 处的偏移（9.1） |
 * | `openSearchDrawer(page)` | 点顶栏"全书内容检索 (快捷键: F)"打开检索抽屉 |
 * | `readSearchResults(page)` | 检索抽屉结果列表的度量快照：每条的章节名、命中文字及其前后片段 |
 * | `readMainScroll(page)` / `setMainScrollTop(page, top, options?)` | 读 / 设正文滚动容器（`<main>`）的滚动位置；设定时默认先以一次 `wheel` 标记为读者操作 |
 * | `readChapterScroll(page)` | 滚动模式下以当前章区段（`section[data-chapter-id]`）为界的滚动位置：章首、章末对应的 `scrollTop` |
 * | `readDocumentScroll(page)` / `setDocumentScrollTop(page, top)` | 读 / 设文档滚动元素的滚动位置（书架页由文档滚动；阅读器正文分支里文档不可滚） |
 * | `expectDocumentNotScrollable(page)` | 需求 2.1：文档滚动元素的最大可滚距离 ≤ 1 px（阅读器的滚动断言之前调用，reader-defect-fixes 14.2） |
 * | `waitFrames(page, n?)` | 等 n 个动画帧（"不变"类断言前的等待；不能与 Controlled_Clock 同用） |
 * | `readJudgeParagraph(page)` | 9.5 的判定段落序号及其所依据的几何量（判定线、可视高度、正文高度、`<main>` 的滚动位置、当前章区段的章首章末）（任务 10.5 起；10.6 复用） |
 * | `judgeScrollTarget(reading, k)` | 使判定段落成为第 k 段的目标 `<main>.scrollTop` |
 * | `scrollJudgeParagraphTo(page, k)` | 把判定段落滚到第 k 段：核对文档不可滚，以读者操作设定 `<main>` 的 `scrollTop`，等到 `scroll` 事件，核对序号为 k 且仍在同一章 |
 * | `readParagraphStarts(page, lib, bookId, chapter)` / `paragraphRange(starts, k)` | 当前章区段各正文段落的章内起点（由全书文本与渲染出的段落文本推导），与第 k 段的章内偏移范围（reader-defect-fixes 需求 3.2、3.4） |
 * | `expectOffsetInParagraph(starts, k, offset, what)` | 断言章内偏移落在第 k 段的范围内：不小于该段起点、小于下一段起点（需求 3.2、3.4） |
 * | `openBookmarkList(page)` | 打开目录抽屉并切到"我的书签"页签（任务 10.6 起） |
 * | `readBookmarkEntries(page)` | "我的书签"列表的度量快照：每条的章节名与预览文字（任务 10.6 起） |
 *
 * ## 约定
 *
 * - 期望值一律来自 `TocFacts`（4.4）：下标、标题、正文序号都不写字面量。
 * - 元素经 `locators.ts` 定位（D8）；`countExactText` 与 `readTocList` 是只读的测量性 DOM 遍历，
 *   不用于定位要操作的元素。设置抽屉的"翻页模式"选项组在 `locators.ts` 里还没有条目，这里按
 *   role（`group`）与可访问名称就地定位（`pageModeButton`），同样不用 CSS 选择器。
 * - **当前章以区段为界**（翻页模式 design §7.1、§13.3）：滚动模式的 `<main>` 里同时挂着若干章，每章
 *   一个 `<section data-chapter-id>`，判定线所在章的区段带 `data-current="true"`；分页模式的当前页
 *   图层同样带 `data-current="true"` 与 `data-chapter-id`，`<main>` 里另有整章的测量盒。读当前章、
 *   章内偏移与滚动位置的函数一律以这个区域为界（经 `reader(page).article` 向上找到它），不再以整个
 *   `<main>` 为界：`<main>` 的 `scrollTop = 0` 不再是章首，章首是区段顶边对齐容器顶边（design §3.1）。
 * - **控制栏**：顶栏与底栏显示后 4.5 s 自动隐藏（`ReaderPage` 的 `triggerShowControls`），隐藏时平移到
 *   视口之外、不可点击。启动这个计时的是：点正文九宫格的 MC 区（中间一格，需求 5.4）、换章等导航
 *   （底栏按钮、目录、滑杆、滚动模式的 `←`/`→`、检索与书签跳转）、点顶栏。翻页（Tap、按键、滚轮）
 *   不启动它（需求 11.16）。点正文其余 8 区只翻页、不唤出控制栏
 *   （需求 5.11）；控制栏可见时点正文任一区只隐藏控制栏、不翻页也不重新计时（需求 5.9）。所以"点一下
 *   正文让控制栏亮起"不再成立，要用 `reshowControls`（可见时 MC 两下，不可见时 MC 一下）。页面刚加载
 *   完成时两者可见且不会自动隐藏；需要点击栏内按钮的步骤应紧跟在加载、换章或 `reshowControls` 之后。
 * - `readTocList`、`readDetailGrid` 以 `requestAnimationFrame` 判定稳定，不能在装了 Controlled_Clock
 *   的页面上使用（rAF 随时钟停住）。`scrollTocList`、`scrollDetailGrid` 等的是 `scroll` 事件，同样
 *   不能与 Controlled_Clock 同用。
 */
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { expect, test } from "@playwright/test";
import type { BrowserContext, Locator, Page } from "@playwright/test";
import { ROW_HEIGHT } from "../../src/utils/listWindow";
import { PAGE_ANIM, PAGE_ANIM_OPTIONS, type PageAnim, type RenderFamily } from "../../src/utils/pageAnim";
import type { TapZone } from "../../src/utils/tapZone";
import { READER_SETTINGS_KEY, type BookLog, type Lib } from "./fixtures";
import type { TocFacts } from "./library";
import { detailModal, reader, searchDrawer, settingsDrawer, tocDrawer } from "./locators";
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

/** 当前章 / 当前页的区域（见文件头"当前章以区段为界"）。 */
export interface CurrentRegion {
  /** `section`：滚动模式的当前章区段；`page`：分页模式的当前页图层。 */
  kind: "section" | "page";
  /** 区域的 `data-chapter-id`：章节在 `toc.chapters[]` 中的下标。 */
  chapterId: number;
}

/**
 * 读 `<main>` 内带 `data-current="true"` 与 `data-chapter-id` 的那个区域（测量）。整页至多一个；
 * 没有时（分页模式尚未分页完成、滚动模式首帧）为 null。只读，不等待。
 */
export function readCurrentRegion(page: Page): Promise<CurrentRegion | null> {
  return reader(page).main.evaluate((main) => {
    const el = main.querySelector<HTMLElement>('[data-current="true"][data-chapter-id]');
    if (el === null) return null;
    return { kind: el.tagName === "SECTION" ? "section" : "page", chapterId: Number(el.dataset.chapterId) };
  });
}

/**
 * 当前章区域（滚动模式的 `section[data-chapter-id]`、分页模式的当前页图层，不含其自身）内去掉首尾空白
 * 后文本与 `text` 完全相同的元素个数（测量）。区域由 `reader(page).article` 向上找；窗口里的其余章与
 * 分页测量盒都不计入。
 */
function countExactText(page: Page, text: string): Promise<number> {
  return reader(page).article.evaluate((article, wanted) => {
    const root = article.closest("[data-chapter-id]") ?? article;
    let n = 0;
    for (const el of Array.from(root.querySelectorAll("*"))) {
      if ((el.textContent ?? "").trim() === wanted) n += 1;
    }
    return n;
  }, text);
}

/** 页面 URL 中 `ch` 查询参数的全部取值（按出现顺序；没有时为空数组）。读 `page.url()`，不经页面脚本。 */
export function urlChapterParams(page: Page): string[] {
  return new URL(page.url()).searchParams.getAll("ch");
}

/**
 * 断言当前章节为下标 `index` 的节点（8.1）：当前章区域（`data-current="true"` 的区段或页面图层，
 * 见 `readCurrentRegion`）的 `data-chapter-id` 为 `index`；其中的一级标题文本等于该节点标题；
 * "第 N / M 章"的 N 为该节点在非卷节点中的序号（从 1 起）、M 为非卷节点数；区域内去掉首尾空白后
 * 与标题完全相同的元素恰好 1 个。`index` 须为正文章节。
 *
 * 标题区只在章首：滚动模式下每个区段都有，分页模式下只在本章第 1 页（需求 2.2），分页模式的其余页
 * 改用 `readPagedView` 的 `data-chapter-id` 判定。
 *
 * 另轮询 URL：`ch` 参数恰有一个，值为 `String(index)`（十进制、无前导零）。阅读器在每次定位（首次
 * 定位与各种换章）后以替换历史记录的方式把当前章写回 URL（reader-defect-fixes 需求 7.1、D2）；写回在
 * 定位提交之后的 effect 里发起，路由状态的更新又包在 transition 中（React Router 7），比正文渲染晚
 * 一拍，所以用轮询等。本函数返回后读到的 `page.url()` 即写回之后的 URL。
 */
export async function expectCurrentChapter(page: Page, facts: TocFacts, index: number): Promise<void> {
  const ordinal = facts.bodyOrdinals[index];
  if (ordinal === null || ordinal === undefined) {
    throw new Error(`下标 ${index} 不是正文章节（节点总数 ${facts.nodeCount}），不能作为当前章节`);
  }
  const title = facts.titles[index];
  const position = `第 ${ordinal + 1} / ${facts.bodyCount} 章`;
  const view = reader(page);
  await step(`8.1 当前章节为下标 ${index}「${title}」（${position}），URL 的 ch 为 ${index}`, async () => {
    await expect
      .poll(async () => (await readCurrentRegion(page))?.chapterId ?? null, {
        message: `当前章区域（data-current="true"）的 data-chapter-id 应为 ${index}`,
      })
      .toBe(index);
    await expect(view.chapterHeading, "当前章的一级标题应为该节点标题（8.1）").toHaveText(title);
    await expect(view.chapterPosition, "“第 N / M 章”应为该节点的正文序号与非卷节点数（8.1）").toHaveText(
      position,
    );
    await expect
      .poll(() => countExactText(page, title), {
        message: `当前章区域内与标题「${title}」完全相同的元素应恰好 1 个（8.1）`,
      })
      .toBe(1);
    await expect
      .poll(() => urlChapterParams(page), {
        message: `URL 的 ch 应写回为当前章节的下标 ${index}（恰有一个 ch 参数；reader-defect-fixes 需求 7.1）`,
      })
      .toEqual([String(index)]);
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

/**
 * 读正文滚动容器（`<main>`）的 `scrollTop`、`clientHeight` 与 `scrollHeight`（只读）。
 *
 * 这是整个容器的读数：滚动模式下容器里挂着当前章前后的若干章，`scrollTop = 0` 是窗口首章的顶边，
 * 不是当前章的章首。以当前章为界的读数用 `readChapterScroll`。
 */
export function readMainScroll(page: Page): Promise<MainScroll> {
  return reader(page).main.evaluate((el) => ({
    scrollTop: el.scrollTop,
    clientHeight: el.clientHeight,
    scrollHeight: el.scrollHeight,
  }));
}

/** `setMainScrollTop` 的选项。 */
export interface SetScrollOptions {
  /**
   * 默认 true：赋值之前先在 `<main>` 上派发一个 `deltaY` 为 0 的 `wheel` 事件，即读者碰了一下滚动输入。
   *
   * 滚动视图的位置归约器在每次导航定位后"钉住"，直到 `<main>` 上出现 `wheel`、`pointerdown`、
   * `touchstart`（或视图处理的翻页键）才松开（design §3.3）：钉住期间的 `scroll` 事件被当作定位与
   * 补偿，不上报阅读位置、不挪 `data-current`、不写回 `?ch=`。读者真实的滚动总有这类输入在先，测试
   * 直接赋值 `scrollTop` 时就由这一个事件补上；`deltaY` 为 0，不产生任何位移（分页模式的滚轮闸门同样
   * 忽略它）。为 false 时不派发，用于"定位不是读者移动"一类断言。
   */
  asReader?: boolean;
}

/**
 * 直接设定正文滚动容器的 `scrollTop`（不经滚轮或键盘，没有平滑滚动；设计"补充场景"10.9 的
 * 前置同样如此），返回赋值后容器报告的值（浏览器会夹到可滚范围内）。默认作为读者操作（见
 * `SetScrollOptions.asReader`）。不等待 `scroll` 事件；需要应用处理完滚动时由调用方随后 `waitFrames`
 * 或推进 Controlled_Clock。
 */
export function setMainScrollTop(page: Page, top: number, options: SetScrollOptions = {}): Promise<number> {
  const asReader = options.asReader ?? true;
  return reader(page).main.evaluate(
    (el, { value, wheel }) => {
      if (wheel) el.dispatchEvent(new WheelEvent("wheel", { deltaY: 0, bubbles: true, cancelable: true }));
      el.scrollTop = value;
      return el.scrollTop;
    },
    { value: top, wheel: asReader },
  );
}

/** 滚动模式下以当前章区段为界的滚动读数（内容坐标，即与 `scrollTop` 同一坐标系，单位 px）。 */
export interface ChapterScroll extends MainScroll {
  /** 当前章区段（`section[data-chapter-id][data-current="true"]`）的章号。 */
  chapterId: number;
  /** 章首：区段顶边对齐容器顶边时的 `scrollTop`（design §3.1；导航到章首即定位于此）。 */
  chapterStart: number;
  /** 章末：`max(chapterStart, 区段底边 − clientHeight)`（design §7.6 的 `chapterEdgeScrollTop`）。 */
  chapterEnd: number;
  /** 区段高度（含上下内边距）。 */
  sectionHeight: number;
  /** `scrollTop − chapterStart`：滚过了本章多少（章首为 0）。 */
  intoChapter: number;
}

/**
 * 读滚动模式下以当前章区段为界的滚动位置（只读）。区段由 `reader(page).article` 向上找到；坐标由
 * `getBoundingClientRect` 换算为内容坐标（`区段边 − (<main> 顶边 + clientTop) + scrollTop`），保留亚像素，
 * 与 `scrollTop` 比较时请留取整余量。当前章区域不是区段（分页模式）时抛错。
 */
export function readChapterScroll(page: Page): Promise<ChapterScroll> {
  return reader(page).article.evaluate((article) => {
    const section = article.closest("section[data-chapter-id]");
    if (!(section instanceof HTMLElement) || section.parentElement === null) {
      throw new Error("当前章的 <article> 不在 <section data-chapter-id> 里：readChapterScroll 只用于滚动模式");
    }
    const main = section.parentElement;
    const origin = main.getBoundingClientRect().top + main.clientTop - main.scrollTop;
    const rect = section.getBoundingClientRect();
    const chapterStart = rect.top - origin;
    return {
      scrollTop: main.scrollTop,
      clientHeight: main.clientHeight,
      scrollHeight: main.scrollHeight,
      chapterId: Number(section.dataset.chapterId),
      chapterStart,
      chapterEnd: Math.max(chapterStart, rect.bottom - origin - main.clientHeight),
      sectionHeight: rect.height,
      intoChapter: main.scrollTop - chapterStart,
    };
  });
}

/**
 * 读文档滚动元素（`document.scrollingElement`）的滚动位置（只读）。
 *
 * 书架页由文档滚动。阅读器正文分支里 `<main>` 是唯一的滚动容器，文档不可滚动（reader-defect-fixes
 * 需求 2.1），阅读器的滚动读写一律经 `readMainScroll` / `setMainScrollTop`；那里用本函数只为
 * `expectDocumentNotScrollable` 的核对与"文档 `scrollTop` 为 0"一类读数。
 */
export function readDocumentScroll(page: Page): Promise<MainScroll> {
  return page.evaluate(() => {
    const el = document.scrollingElement ?? document.documentElement;
    return { scrollTop: el.scrollTop, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight };
  });
}

/** 直接设定文档滚动元素的 `scrollTop`，返回赋值后的值（书架页；见 `readDocumentScroll`）。 */
export function setDocumentScrollTop(page: Page, top: number): Promise<number> {
  return page.evaluate((value) => {
    const el = document.scrollingElement ?? document.documentElement;
    el.scrollTop = value;
    return el.scrollTop;
  }, top);
}

/** 需求 2.1：文档滚动元素的最大可滚距离 `scrollHeight − clientHeight` 的上限（px）。 */
export const DOCUMENT_SCROLL_SLACK_PX = 1;

/**
 * 需求 2.1 / 14.2：断言文档滚动元素不可滚动，即 `scrollHeight − clientHeight ≤ 1` px（一次读数，不轮询）。
 *
 * 阅读器正文分支里 `<main>` 是唯一的正文滚动容器（reader-defect-fixes 设计第 3 节）。"滚到第 k 段"、
 * EV 需求 10 的起始状态与"`scrollTop` 不变"类比较只读写 `<main>`，在滚动或比较之前调用本函数：
 * 文档若可滚，读者看到的滚动就不一定发生在 `<main>` 上，这些读数也就不再代表阅读位置。
 * 只读几何量，不依赖 `requestAnimationFrame`，可与 Controlled_Clock 同用。
 */
export async function expectDocumentNotScrollable(page: Page): Promise<void> {
  await step(
    `2.1 文档滚动元素不可滚动（scrollHeight − clientHeight ≤ ${DOCUMENT_SCROLL_SLACK_PX} px）`,
    async () => {
      const doc = await readDocumentScroll(page);
      expect(
        doc.scrollHeight - doc.clientHeight,
        `文档滚动元素的最大可滚距离（scrollTop ${doc.scrollTop}、clientHeight ${doc.clientHeight}、` +
          `scrollHeight ${doc.scrollHeight}）`,
      ).toBeLessThanOrEqual(DOCUMENT_SCROLL_SLACK_PX);
    },
  );
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
// 连续滚动（翻页模式需求 10）之后 `<main>` 里挂着若干章，这里的 `<article>` 是当前章区段
// （`section[data-chapter-id][data-current="true"]`，即判定线所在的那章）里的那一篇，段落、正文高度与
// 章首章末都以该区段为界；`<main>` 的 `scrollTop` 与可滚距离仍是整个容器的。判定段落只在滚动模式下
// 有定义，当前章区域不是区段（分页模式）时这些函数抛错。
//
// `<main>` 是唯一的正文滚动容器（reader-defect-fixes 需求 2.1、2.2）：它占满一屏（边界框上边为视口
// 顶边），正文在它里面滚动，文档本身不可滚。判定线因此落在视口 56 px 处（顶栏下沿）加 1 px，即读者
// 看到的"视口首个可见段落"，与应用自己的判定（`ReaderPage` 的 `scrollTop + TOP_BIAS`）同义。
// "滚动容器可视高度"（9.8）取 `<main>` 的 `clientHeight`；"正文高度"取正文首段上边到末段下边的距离。
// 滚动一律对 `<main>` 赋值；`scrollJudgeParagraphTo` 先以 `expectDocumentNotScrollable` 核对需求 2.1。
//
// 历史：EV 验收时 `<main>` 随内容增高、实际滚动的是文档（Findings_Log F-002，已修复（reader-defect-fixes））。
// 当时这里按"实际在滚动的元素"二选一，并把"`<main>` 边界框上边"取为它与视口交集的上边；修复后两处
// 变通都已删除，改为按 9.5 的字面定义只读写 `<main>`（需求 14.2）。
//
// 这些函数只读几何量、直接赋值 `scrollTop`，不依赖 `requestAnimationFrame`，可与 Controlled_Clock
// 同用：`scroll` 事件由浏览器的渲染步骤派发，不受时钟控制。

/** 9.5：判定线在滚动容器可视区上边之下的距离（顶栏高度，`Header` 的 `h-14`）。 */
export const JUDGE_TOP_BAR_PX = 56;

/** 9.5：判定线的取整余量。 */
export const JUDGE_ROUNDING_PX = 1;

/** 判定段落的一次读数（几何量除注明为内容坐标的以外均为视口坐标，单位 px）。 */
export interface JudgeReading {
  /** 当前章区段的 `data-chapter-id`（`toc.chapters[]` 下标）；以下段落均属这一章。 */
  chapterId: number;
  /** 判定段落序号（从 0 起）。 */
  index: number;
  /** 正文段落数（当前章 `<article>` 内章节标题区之后的 `<p>`）。 */
  count: number;
  /** 判定线：`mainTop + 56 + 1`。 */
  line: number;
  /** `<main>` 边界框上边。 */
  mainTop: number;
  /** 滚动容器可视高度：`<main>` 的 `clientHeight`（9.8）。 */
  visibleHeight: number;
  /** 正文高度：正文首段上边到末段下边（9.8）；没有段落时为 0。 */
  bodyHeight: number;
  /** 各正文段落的边界框上边，按文档顺序。 */
  tops: number[];
  /** `<main>` 的 `scrollTop`。 */
  scrollTop: number;
  /** `<main>` 的最大可滚距离 `scrollHeight − clientHeight`。 */
  maxScrollTop: number;
  /** 内容坐标：当前章区段的章首 `scrollTop`（同 `ChapterScroll.chapterStart`）。 */
  chapterStart: number;
  /** 内容坐标：当前章区段的章末 `scrollTop`（同 `ChapterScroll.chapterEnd`）。 */
  chapterEnd: number;
}

interface JudgeProbe {
  main: HTMLElement;
  article: HTMLElement;
  topBar: number;
  rounding: number;
}

/**
 * 读判定段落（9.5）。段落经 `reader(page).paragraphs` 定位（D8，即当前章区段里的段落）；`<main>`、
 * `<article>` 及其所在区段的几何量与章节标题区（`<article>` 的 `<header>` 子元素）只作度量。只读，
 * 不改动页面。当前章区域不是 `<main>` 下的区段（分页模式）时抛错。
 */
export async function readJudgeParagraph(page: Page): Promise<JudgeReading> {
  const view = reader(page);
  const [main, article] = await Promise.all([view.main.elementHandle(), view.article.elementHandle()]);
  if (main === null || article === null) throw new Error("找不到正文 <main> 或 <article>");
  try {
    const probe = { main, article, topBar: JUDGE_TOP_BAR_PX, rounding: JUDGE_ROUNDING_PX };
    return await view.paragraphs.evaluateAll((elements, arg): JudgeReading => {
      const { main: mainEl, article: articleEl, topBar, rounding } = arg as unknown as JudgeProbe;
      const section = articleEl.closest("section[data-chapter-id]");
      if (!(section instanceof HTMLElement) || section.parentElement !== mainEl) {
        throw new Error("当前章的 <article> 不在 <main> 下的 <section data-chapter-id> 里：判定段落只在滚动模式下有定义");
      }
      // 章节标题区之后的 <p>：标题区里目前没有 <p>，仍按定义排除它及其之前的段落
      const header = articleEl.querySelector(":scope > header");
      const body = elements.filter(
        (p) =>
          header === null ||
          (!header.contains(p) && (header.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0),
      );

      const mainRect = mainEl.getBoundingClientRect();
      const mainTop = mainRect.top;
      const line = mainTop + topBar + rounding;

      const rects = body.map((p) => p.getBoundingClientRect());
      const tops = rects.map((r) => r.top);
      let index = 0;
      tops.forEach((top, i) => {
        if (top <= line) index = i;
      });

      // 区段边换算为内容坐标（与 `readChapterScroll` 相同）
      const origin = mainTop + mainEl.clientTop - mainEl.scrollTop;
      const sectionRect = section.getBoundingClientRect();
      const chapterStart = sectionRect.top - origin;

      return {
        chapterId: Number(section.dataset.chapterId),
        index,
        count: body.length,
        line,
        mainTop,
        visibleHeight: mainEl.clientHeight,
        bodyHeight: rects.length > 0 ? rects[rects.length - 1].bottom - rects[0].top : 0,
        tops,
        scrollTop: mainEl.scrollTop,
        maxScrollTop: mainEl.scrollHeight - mainEl.clientHeight,
        chapterStart,
        chapterEnd: Math.max(chapterStart, sectionRect.bottom - origin - mainEl.clientHeight),
      };
    }, probe);
  } finally {
    await Promise.all([main.dispose(), article.dispose()]);
  }
}

/**
 * 使判定段落成为第 `k` 段所需的 `<main>.scrollTop`：把第 k 段的上边放到 `<main>` 上边之下 56 px 处
 * （判定线之上 1 px；第 k + 1 段的上边随之在判定线之下）。与应用恢复位置时的 `tops[k] − TOP_BIAS`
 * 同义。可能超出 `[0, maxScrollTop]`，由调用方判断能否滚到。
 */
export function judgeScrollTarget(reading: JudgeReading, k: number): number {
  const top = reading.tops[k];
  if (top === undefined) throw new Error(`第 ${k} 段不存在（共 ${reading.count} 段）`);
  return reading.scrollTop + Math.round(top - (reading.mainTop + JUDGE_TOP_BAR_PX));
}

/** `scrollJudgeParagraphTo` 在页面上记录"已收到 scroll 事件"的属性名。 */
const SCROLL_SEEN_FLAG = "__e2eJudgeScrollSeen";

/**
 * 把判定段落滚到第 `k` 段：先核对文档不可滚动（需求 2.1，`expectDocumentNotScrollable`），再对 `<main>`
 * 直接赋值 `judgeScrollTarget` 算出的 `scrollTop`（不经滚轮或键盘，没有平滑滚动），等到 `<main>` 的
 * `scroll` 事件，再读一次判定段落并断言序号为 `k`、当前章没有变。返回滚动后的读数。目标超出可滚范围、
 * 或滚后序号不为 `k` 时失败（测试自身的问题，16.6）。
 *
 * 这一滚是读者的移动：赋值之前先在 `<main>` 上派发一个 `deltaY` 为 0 的 `wheel` 事件（见
 * `SetScrollOptions.asReader`），滚动视图的位置归约器因此松开，随后的阅读位置照常上报、落盘，书签取
 * 判定线处的偏移（design §3.3）。
 */
export async function scrollJudgeParagraphTo(page: Page, k: number): Promise<JudgeReading> {
  return step(`把判定段落滚到第 ${k} 段（以读者操作设定 <main> 的 scrollTop，等到 scroll 事件）`, async () => {
    await expectDocumentNotScrollable(page);
    const before = await readJudgeParagraph(page);
    if (before.maxScrollTop < 1) throw new Error("<main> 没有可滚距离，无法滚动正文");
    const target = judgeScrollTarget(before, k);
    if (target < 0 || target > before.maxScrollTop) {
      throw new Error(`第 ${k} 段滚不到判定线：目标 scrollTop ${target} 不在 [0, ${before.maxScrollTop}] 内`);
    }
    const applied = await reader(page).main.evaluate(
      (mainEl, { top, flag }) => {
        const w = window as unknown as Record<string, unknown>;
        w[flag] = false;
        mainEl.addEventListener(
          "scroll",
          () => {
            w[flag] = true;
          },
          { once: true },
        );
        mainEl.dispatchEvent(new WheelEvent("wheel", { deltaY: 0, bubbles: true, cancelable: true }));
        const from = mainEl.scrollTop;
        mainEl.scrollTop = top;
        return { from, to: mainEl.scrollTop };
      },
      { top: target, flag: SCROLL_SEEN_FLAG },
    );
    if (applied.to !== applied.from) {
      await expect
        .poll(
          () => page.evaluate((flag) => (window as unknown as Record<string, unknown>)[flag] === true, SCROLL_SEEN_FLAG),
          { message: `设定 <main> 的 scrollTop = ${target} 后应收到 scroll 事件` },
        )
        .toBe(true);
    }
    const after = await readJudgeParagraph(page);
    expect(after.chapterId, `滚动前后当前章区段应同为下标 ${before.chapterId}`).toBe(before.chapterId);
    expect(
      after.index,
      `判定段落应为第 ${k} 段（<main> scrollTop ${applied.from} → ${applied.to}，判定线 ${after.line}，` +
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

/** 按 worker 缓存的全文，键为 `<profile>\0<id>`：同一本书在一个 worker 内只解压一次。 */
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
// 段落的章内偏移范围（reader-defect-fixes 需求 3.2、3.4；任务 7.6）
// ---------------------------------------------------------------------------
//
// 书签记录与进度记录里的 `charOffset` 是章内字符偏移（相对 `_toc.json` 中该章的 `start`，UTF-16 码元）。
// 需求 3.2、3.4 要求它落在第 k 段的范围内：不小于第 k 段的起点、小于第 k + 1 段的起点。
//
// 期望值不取自应用的切分函数，由测试独立推导：该章的原文取测试进程解压的全书文本（`bookText`）在
// `[start, end)` 上的切片（不去首尾空白），按 `\n` 切成行，每行去掉首尾空白（含全角缩进与 `\r`）后
// 非空的即一个候选段落，其起点为该行首个非空白字符在章内的位置。再读 `<article>` 内渲染出的各 `<p>` 的
// 文本，按文档顺序依次对齐到文本相同的下一个候选段落（标题行若未渲染为段落，就在对齐时被跳过）。
// 对不齐（某段文本在其后的候选段落中找不到）说明渲染的不是该章，或推导有误，直接抛错（16.6）。

/** 当前章各正文段落的章内起点。 */
export interface ParagraphStarts {
  /** 第 i 个正文段落（`<article>` 内第 i 个 `<p>`）首字在章内的偏移，严格递增。 */
  starts: number[];
  /** 该章的长度（`end − start`），即末段范围的上界。 */
  chapterLength: number;
}

/**
 * 读当前章各正文段落的章内起点（见上方说明）。段落取当前章区段（`section[data-chapter-id]`）里的那篇
 * `<article>`（`reader(page).paragraphs`），窗口里的其余章不计入。`chapter` 须为当前章区段的章号，
 * 否则抛错（滚动模式下才有整章段落；分页模式的当前页只有页片段，同样抛错）。调用前正文须已渲染，
 * 且没有检索高亮以外的改写（高亮的 `<mark>` 不改变 `<p>` 的 `textContent`）。
 */
export async function readParagraphStarts(
  page: Page,
  lib: Lib,
  bookId: string,
  chapter: number,
): Promise<ParagraphStarts> {
  const region = await readCurrentRegion(page);
  if (region === null || region.kind !== "section" || region.chapterId !== chapter) {
    throw new Error(
      `readParagraphStarts 须在滚动模式下、当前章区段为下标 ${chapter} 时调用（当前区域：${JSON.stringify(region)}）`,
    );
  }
  const [toc, book, texts] = await Promise.all([
    lib.toc(bookId),
    bookText(lib, bookId),
    reader(page).paragraphs.evaluateAll((ps) => ps.map((p) => p.textContent ?? "")),
  ]);
  const node = toc.chapters[chapter];
  if (node === undefined) throw new Error(`${bookId} 没有下标 ${chapter} 的节点`);
  const source = book.text.slice(node.start, node.end);

  const lines: { offset: number; text: string }[] = [];
  let pos = 0;
  for (const raw of source.split("\n")) {
    const text = raw.trim();
    if (text !== "") lines.push({ offset: pos + (raw.length - raw.trimStart().length), text });
    pos += raw.length + 1;
  }

  const starts: number[] = [];
  let next = 0;
  texts.forEach((text, i) => {
    while (next < lines.length && lines[next].text !== text) next++;
    if (next >= lines.length) {
      throw new Error(
        `${bookId} 下标 ${chapter}：第 ${i} 段「${text.slice(0, 20)}」在该章原文的后续行中找不到（共 ${lines.length} 行非空）`,
      );
    }
    starts.push(lines[next].offset);
    next++;
  });
  return { starts, chapterLength: node.end - node.start };
}

/** 第 `k` 段的章内偏移范围 `[start, end)`：`end` 为第 k + 1 段的起点，末段为章长。 */
export function paragraphRange(paragraphs: ParagraphStarts, k: number): { start: number; end: number } {
  const start = paragraphs.starts[k];
  if (start === undefined) throw new Error(`第 ${k} 段不存在（共 ${paragraphs.starts.length} 段）`);
  return { start, end: paragraphs.starts[k + 1] ?? paragraphs.chapterLength };
}

/**
 * 需求 3.2、3.4：断言章内偏移 `offset` 落在第 `k` 段的范围内，即不小于该段起点、小于下一段起点。
 * `what` 是偏移的来历（如"书签记录的 charOffset"），用于步骤名与报错信息。
 */
export async function expectOffsetInParagraph(
  paragraphs: ParagraphStarts,
  k: number,
  offset: unknown,
  what: string,
): Promise<void> {
  const { start, end } = paragraphRange(paragraphs, k);
  await step(`${what} 落在第 ${k} 段的范围内（章内偏移 [${start}, ${end})）`, () => {
    test.info().annotations.push({
      type: "paragraph-range",
      description: `${what} ${String(offset)}；第 ${k} 段起点 ${start}、第 ${k + 1} 段起点 ${end}`,
    });
    expect(typeof offset, `${what} 应为数值`).toBe("number");
    const value = offset as number;
    // 落在哪一段（诊断用）：起点不大于偏移的最后一段
    const at = paragraphs.starts.reduce((found, s, i) => (s <= value ? i : found), -1);
    expect(value, `${what} 应不小于第 ${k} 段的起点（实际落在第 ${at} 段）`).toBeGreaterThanOrEqual(start);
    expect(value, `${what} 应小于第 ${k + 1} 段的起点（实际落在第 ${at} 段）`).toBeLessThan(end);
  });
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

// ---------------------------------------------------------------------------
// 翻页模式（reader-page-turn-modes 任务 21.2 起；23.x 的新用例复用）
// ---------------------------------------------------------------------------

/** 一种翻页模式在 e2e 里用到的各个名字（翻页模式需求 1.1、1.3；design §2.1、§4.5、§7.1）。 */
export interface PageModeSpec {
  /** `ReaderSettings.pageAnim` 的编号（覆盖 0、滑动 1、仿真 2、滚动 3、无动画 4）。 */
  anim: PageAnim;
  /** 设置抽屉"翻页模式"选项组里的按钮文字。 */
  label: string;
  /** `<main data-page-mode>` 的取值。 */
  attr: string;
  /** 渲染族：滚动为 `scroll`（`ScrollReader`），其余为 `paged`（`PagedReader`）。 */
  family: RenderFamily;
}

/** `<main data-page-mode>` 的取值：分页视图按读者所选的模式（不是本次实际动画），滚动视图为 `scroll`。 */
const PAGE_MODE_ATTRS: Readonly<Record<PageAnim, string>> = {
  [PAGE_ANIM.cover]: "cover",
  [PAGE_ANIM.slide]: "slide",
  [PAGE_ANIM.simulation]: "simulation",
  [PAGE_ANIM.scroll]: "scroll",
  [PAGE_ANIM.none]: "none",
};

/** 五种翻页模式，按设置抽屉的按钮顺序：覆盖、滑动、仿真、滚动、无动画（需求 1.3）。 */
export const PAGE_MODES: readonly PageModeSpec[] = PAGE_ANIM_OPTIONS.map(
  ({ value, label }): PageModeSpec => ({
    anim: value,
    label,
    attr: PAGE_MODE_ATTRS[value],
    family: value === PAGE_ANIM.scroll ? "scroll" : "paged",
  }),
);

/** 编号对应的翻页模式。 */
export function pageModeSpec(anim: PageAnim): PageModeSpec {
  const spec = PAGE_MODES.find((m) => m.anim === anim);
  if (spec === undefined) throw new Error(`没有编号为 ${String(anim)} 的翻页模式`);
  return spec;
}

/**
 * 在 `context` 的首次导航之前，把已存储设置的 `pageAnim` 写为 `anim`（`addInitScript`，设置键
 * `koodo_novel_reader_settings`；与 `fixtures.ts` 的 `seedTheme` 同一口径）。
 *
 * 只在存储的设置里还没有 `pageAnim` 时写入：初始脚本在每次导航（含重载）都会执行，应用此后保存的设置
 * （保存时写全部字段，含 `pageAnim`）与用例经设置抽屉的切换都不会被它改回去。已存储的其余字段原样
 * 保留；存储值不是 JSON 对象时不动它。
 *
 * 与 `seedTheme` 同用时须先调用 `seedTheme`：它只在设置键整体不存在时写入，本函数先写过的话它就会跳过。
 */
export async function seedPageMode(context: BrowserContext, anim: PageAnim): Promise<void> {
  const navigated = context.pages().find((p) => p.url() !== "about:blank");
  if (navigated !== undefined) {
    throw new Error(`seedPageMode() 须在首次导航之前调用；页面已在 ${navigated.url()}`);
  }
  await context.addInitScript(
    ({ key, value }) => {
      try {
        const raw = window.localStorage.getItem(key);
        let stored: Record<string, unknown> = {};
        if (raw !== null) {
          const parsed: unknown = JSON.parse(raw);
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
          stored = parsed as Record<string, unknown>;
        }
        if ("pageAnim" in stored) return;
        window.localStorage.setItem(key, JSON.stringify({ ...stored, pageAnim: value }));
      } catch {
        // about:blank 等不透明源没有 localStorage；存储值不是 JSON 时同样不动它
      }
    },
    { key: READER_SETTINGS_KEY, value: anim },
  );
}

/** localStorage 设置键里 `pageAnim` 的原值（不归一）；键不存在、不是 JSON 或没有该字段时为 undefined。 */
export function readStoredPageAnim(page: Page): Promise<unknown> {
  return page.evaluate((key) => {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return undefined;
    try {
      const parsed = JSON.parse(raw) as { pageAnim?: unknown } | null;
      return parsed?.pageAnim;
    } catch {
      return undefined;
    }
  }, READER_SETTINGS_KEY);
}

/** 设置抽屉"翻页模式"选项组的名称：`role="group"` 经 `aria-labelledby` 取自可见标题（需求 1.3、1.4）。 */
const PAGE_MODE_GROUP_NAME = "翻页模式";

/**
 * 设置抽屉"翻页模式"选项组里某个模式的按钮（role `button`，名称为按钮文字，选中态为 `aria-pressed`）。
 * 抽屉须已打开。`locators.ts` 的 `settingsDrawer` 里还没有这一组，这里按 role 与名称就地定位。
 */
export function pageModeButton(page: Page, anim: PageAnim): Locator {
  return page
    .getByRole("group", { name: PAGE_MODE_GROUP_NAME, exact: true })
    .getByRole("button", { name: pageModeSpec(anim).label, exact: true });
}

/** `selectPageMode` 的选项。 */
export interface SelectPageModeOptions {
  /** 选完后保持设置抽屉打开。默认按 `Esc` 关上：抽屉的遮罩会挡住正文上的点击。 */
  keepOpen?: boolean;
}

/**
 * 经设置抽屉切换翻页模式（需求 1.5）。抽屉没开时按快捷键 `S` 打开（不点顶栏按钮：顶栏可能已自动隐藏，
 * 按键也不启动自动隐藏计时）；点"翻页模式"选项组里该模式的按钮，再核对：
 *
 * - 该按钮 `aria-pressed="true"`，其余四个为 `"false"`（需求 1.4）；
 * - `<main data-page-mode>` 为该模式的取值，当前章 / 当前页的 `<article>` 恰有 1 个（新视图已定位；
 *   切换渲染族时 `<main>` 整个换成另一种视图）；
 * - localStorage 设置键里的 `pageAnim` 为该编号（需求 1.5）。
 *
 * 默认随后按 `Esc` 关上抽屉（见 `SelectPageModeOptions.keepOpen`）。调用前不得有其他面板打开。
 */
export async function selectPageMode(
  page: Page,
  anim: PageAnim,
  options: SelectPageModeOptions = {},
): Promise<void> {
  const mode = pageModeSpec(anim);
  await step(`在设置抽屉“翻页模式”中选择“${mode.label}”（pageAnim ${anim}，data-page-mode="${mode.attr}"）`, async () => {
    const drawer = settingsDrawer(page);
    if ((await drawer.marker.count()) === 0) {
      await page.keyboard.press("s");
      await expect(drawer.marker, "按 S 应打开设置抽屉").toBeVisible();
    }
    await pageModeButton(page, anim).click();
    for (const other of PAGE_MODES) {
      await expect(
        pageModeButton(page, other.anim),
        `“${other.label}”按钮的 aria-pressed（需求 1.4）`,
      ).toHaveAttribute("aria-pressed", String(other.anim === anim));
    }
    const view = reader(page);
    await expect(view.main, "<main> 的 data-page-mode").toHaveAttribute("data-page-mode", mode.attr);
    await expect(view.article, "当前章 / 当前页的 <article>").toHaveCount(1);
    await expect
      .poll(() => readStoredPageAnim(page), {
        message: `localStorage ${READER_SETTINGS_KEY} 的 pageAnim 应为 ${anim}（需求 1.5）`,
      })
      .toBe(anim);
    if (options.keepOpen !== true) {
      await page.keyboard.press("Escape");
      await expect(drawer.marker, "按 Esc 应关上设置抽屉").toHaveCount(0);
    }
  });
}

/** 分页视图当前页图层上的测试钩子（design §4.5）。 */
export interface CurrentPage {
  /** 当前页所在章（`toc.chapters[]` 下标）。 */
  chapterId: number;
  /** 当前页在本章中的序号，从 0 起。 */
  pageIndex: number;
  /** 本章的页数（≥ 1）。 */
  pageCount: number;
  /** Page_Start_Offset：当前页首字的章内字符偏移。 */
  pageStart: number;
}

/** 阅读区 `<main>` 上翻页测试钩子的一次读数（design §4.5、§6.4）。 */
export interface PagedViewReading {
  /** `data-page-mode`；滚动视图为 `scroll`。 */
  mode: string | null;
  /** `data-turning`；滚动视图没有这个属性，为 null。 */
  turning: boolean | null;
  /** `data-paginated`：当前排版下已分页完成的章号，按属性里的顺序。 */
  paginated: number[];
  /** 当前页图层（带 `data-current="true"` 与 `data-page-index`）；尚未分页完成或在滚动视图里为 null。 */
  current: CurrentPage | null;
}

/**
 * 读分页视图的测试钩子（只读，不等待）：`<main>` 的 `data-page-mode`、`data-turning`、`data-paginated`，
 * 与当前页图层的 `data-chapter-id`、`data-page-index`、`data-page-count`、`data-page-start`。翻页途中
 * 只有当前页图层带这些属性，目标页图层没有（design §4.5）。页码只存在于这些运行时属性里（需求 2.8）。
 */
export function readPagedView(page: Page): Promise<PagedViewReading> {
  return reader(page).main.evaluate((main) => {
    const el = main.querySelector<HTMLElement>('[data-current="true"][data-page-index]');
    const { pageMode, turning, paginated } = main.dataset;
    return {
      mode: pageMode ?? null,
      turning: turning === undefined ? null : turning === "true",
      paginated: paginated === undefined || paginated === "" ? [] : paginated.split(",").map(Number),
      current:
        el === null
          ? null
          : {
              chapterId: Number(el.dataset.chapterId),
              pageIndex: Number(el.dataset.pageIndex),
              pageCount: Number(el.dataset.pageCount),
              pageStart: Number(el.dataset.pageStart),
            },
    };
  });
}

/**
 * 等翻页落定（轮询，上限为 expect 超时）：`<main data-turning="false">` 且当前页图层就位，返回当前页。
 * 动画中的翻页、刚切到分页模式还没分页完成时都会等。只用于分页模式：`<main>` 为滚动视图时抛错。
 * 只读属性，不依赖 `requestAnimationFrame`；但翻页动画本身由应用的 rAF 推进，装了 Controlled_Clock
 * 的页面要由调用方推进时钟。
 */
export async function waitPageTurnSettled(page: Page): Promise<CurrentPage> {
  return step('等翻页落定：<main data-turning="false">，当前页图层就位', async () => {
    let last: PagedViewReading | null = null;
    await expect
      .poll(
        async () => {
          last = await readPagedView(page);
          if (last.mode === PAGE_MODE_ATTRS[PAGE_ANIM.scroll]) {
            throw new Error("waitPageTurnSettled 只用于分页模式，<main> 当前为滚动视图");
          }
          return last.turning === false && last.current !== null;
        },
        { message: '<main> 的 data-turning 应为 "false"，且当前页图层带 data-page-index' },
      )
      .toBe(true);
    const settled = last as PagedViewReading | null;
    if (settled === null || settled.current === null) throw new Error("翻页落定后读不到当前页");
    return settled.current;
  });
}

/** 九宫格的 9 区（Glossary Tap_Zone），按行（上、中、下）、行内按列（左、中、右）。 */
export const TAP_ZONES: readonly TapZone[] = ["TL", "TC", "TR", "ML", "MC", "MR", "BL", "BC", "BR"];

/**
 * 各区的动作（需求 5.2–5.4）：TL、TC、ML、BL 上一页，TR、MR、BC、BR 下一页，MC 唤出控制栏。
 * 五种翻页模式相同（需求 5.5）。控制栏可见时任一区都只隐藏控制栏（需求 5.9），见 `reshowControls`。
 */
export const TAP_ZONE_ACTIONS: Readonly<Record<TapZone, "prev" | "next" | "menu">> = {
  TL: "prev",
  TC: "prev",
  TR: "next",
  ML: "prev",
  MC: "menu",
  MR: "next",
  BL: "prev",
  BC: "next",
  BR: "next",
};

/** 九宫格的两条分界线，占阅读视口宽 / 高的比例（Glossary Tap_Zone：33% 与 66%）。 */
const TAP_ZONE_SPLIT_LOW = 0.33;
const TAP_ZONE_SPLIT_HIGH = 0.66;

/** 各列（L/C/R）、各行（T/M/B）的中心比例：相邻两条分界线（含 0 与 1）的中点。 */
const TAP_ZONE_CENTER: Readonly<Record<string, number>> = {
  L: TAP_ZONE_SPLIT_LOW / 2,
  C: (TAP_ZONE_SPLIT_LOW + TAP_ZONE_SPLIT_HIGH) / 2,
  R: (TAP_ZONE_SPLIT_HIGH + 1) / 2,
  T: TAP_ZONE_SPLIT_LOW / 2,
  M: (TAP_ZONE_SPLIT_LOW + TAP_ZONE_SPLIT_HIGH) / 2,
  B: (TAP_ZONE_SPLIT_HIGH + 1) / 2,
};

/** 视口坐标（CSS px）。 */
export interface ViewportPoint {
  x: number;
  y: number;
}

/**
 * 用鼠标点击正文九宫格 `zone` 区的中心，返回点击的视口坐标。区域以阅读区 `<main>` 的
 * `getBoundingClientRect()` 为参照（需求 5.1）；点击前核对该点最上层的元素在 `<main>` 之内，被控制栏、
 * 面板或遮罩挡住时抛错（测试自身的问题，16.6），不去点挡住它的东西。
 *
 * 点 MC 即"点 MC 唤出控制栏"（需求 5.4）：控制栏不可见时唤出并开始 4.5 s 计时；可见时按需求 5.9 只隐藏。
 * 要的是"点完之后控制栏可见"，用 `reshowControls`。滚动模式下鼠标按下同时算作读者操作（design §3.3）。
 */
export async function tapZoneCenter(page: Page, zone: TapZone): Promise<ViewportPoint> {
  return step(`点击正文九宫格 ${zone} 区的中心`, async () => {
    const fractions = { fx: TAP_ZONE_CENTER[zone[1]], fy: TAP_ZONE_CENTER[zone[0]] };
    const at = await reader(page).main.evaluate((main, { fx, fy }) => {
      const r = main.getBoundingClientRect();
      const x = r.left + r.width * fx;
      const y = r.top + r.height * fy;
      const hit = document.elementFromPoint(x, y);
      return { x, y, inside: hit !== null && main.contains(hit), hit: hit === null ? null : hit.tagName.toLowerCase() };
    }, fractions);
    if (!at.inside) {
      throw new Error(
        `${zone} 区中心 (${at.x}, ${at.y}) 处最上层的元素是 ${at.hit ?? "（无）"}，不在 <main> 内（被控制栏、面板或遮罩挡住）`,
      );
    }
    await page.mouse.click(at.x, at.y);
    return { x: at.x, y: at.y };
  });
}

/**
 * 顶栏与底栏此刻是否可见（测量）：先等两者自身的 CSS 过渡（`transition-transform` 的滑入滑出）全部结束，
 * 再在同一次读数里取两者的边界框，完整位于视口内为可见、完全移出视口为隐藏。
 *
 * `getAnimations()` 会先刷新样式，所以刚提交的显隐（点击的 `pointerup` 里同步提交）也能在这里看到对应
 * 的过渡，不会读到过渡开始前的旧位置。两者显隐不一致、或停在视口边缘时抛错。CSS 过渡不受
 * Controlled_Clock 控制，可与之同用；可见只表示此刻可见，不表示自动隐藏计时何时到期。
 */
export async function readControlsVisible(page: Page): Promise<boolean> {
  const view = reader(page);
  const footer = await view.bottomBar.elementHandle();
  try {
    return await view.topBar.evaluate(async (header, footerEl) => {
      const bars = [header, footerEl];
      const running = () => bars.flatMap((el) => el.getAnimations().filter((a) => a instanceof CSSTransition));
      for (let pending = running(); pending.length > 0; pending = running()) {
        await Promise.allSettled(pending.map((a) => a.finished));
      }
      const vh = window.innerHeight;
      const placement = (el: Element): boolean | null => {
        const r = el.getBoundingClientRect();
        if (r.top >= -0.5 && r.bottom <= vh + 0.5) return true;
        if (r.bottom <= 0.5 || r.top >= vh - 0.5) return false;
        return null;
      };
      const [top, bottom] = bars.map(placement);
      if (top === null || bottom === null || top !== bottom) {
        const describe = (el: Element) => {
          const r = el.getBoundingClientRect();
          return `top ${r.top}、bottom ${r.bottom}`;
        };
        throw new Error(
          `顶栏（${describe(header)}）与底栏（${describe(footerEl)}）应同时完整可见或同时完全移出视口（视口高 ${vh}）`,
        );
      }
      return top;
    }, footer);
  } finally {
    await footer.dispose();
  }
}

/** `reshowControls` 最多点几次 MC：正常 1–2 次，下面几种情形各多一次，再留一次余量。 */
const RESHOW_MAX_TAPS = 5;

/**
 * 重新亮起控制栏（design §13.3）：控制栏可见时点正文只会把它隐藏（需求 5.9），所以可见时先点 MC 隐藏、
 * 再点 MC 唤出；不可见时点一次 MC（需求 5.4）。返回时两栏完整可见，4.5 s 自动隐藏刚从最后那一下开始计时，
 * 栏内按钮随即可点。
 *
 * 判定"唤出成功"的依据是观察到一次"点前隐藏 → 点后可见"：点前隐藏时，能让控制栏亮起的只有这一下 MC。
 * 以下情形里那一下不改变显隐，循环会再点：按下时页面有非空选区（只清除选区，需求 5.8）、按下时结束了
 * 进行中的翻页动画或惯性（需求 5.10）、自动隐藏恰在读数与点击之间到期（那一下其实已唤出，但无从分辨）。
 * 分页模式下先等 `data-turning` 不为 `"true"`。
 *
 * 不用"点正文标题"：标题在 TL/TC 区，控制栏不可见时点它会回翻（滚动模式）或翻到上一页（分页模式）。
 * 调用前不得有面板打开（抽屉的遮罩会挡住 MC，`tapZoneCenter` 抛错）。
 */
export async function reshowControls(page: Page): Promise<void> {
  await step("重新亮起控制栏：可见时先点 MC 隐藏再点 MC 唤出，不可见时点一次 MC", async () => {
    const view = reader(page);
    const history: string[] = [];
    for (let tap = 1; tap <= RESHOW_MAX_TAPS; tap++) {
      await expect(view.main, "点 MC 之前，分页翻页应已落定").not.toHaveAttribute("data-turning", "true");
      const before = await readControlsVisible(page);
      await tapZoneCenter(page, "MC");
      const after = await readControlsVisible(page);
      history.push(`${before ? "可见" : "隐藏"} → ${after ? "可见" : "隐藏"}`);
      if (!before && after) return;
    }
    throw new Error(`点了 ${RESHOW_MAX_TAPS} 次 MC 仍未观察到“隐藏 → 可见”：${history.join("；")}`);
  });
}
