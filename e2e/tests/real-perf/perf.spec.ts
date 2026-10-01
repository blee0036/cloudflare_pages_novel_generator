/**
 * 性能观测：大书上的目录、检索与加载的实测读数（需求 6.10、14.1、14.2、14.3、14.7、14.8；
 * Checklist H1、H2 只记录）。设计"性能观测（需求 14）"。
 *
 * `real-perf` 项目只收集本文件，不开 `fullyParallel`：3 个用例在同一 worker 里顺序执行；profile
 * 含 real 时其余项目都依赖它，所以它先于一切用例单独运行，不与任何用例并发（6.10）。桌面视口、
 * 默认主题（不 `seedTheme`）、Opaque_Mode 取自项目配置（14.2）。
 *
 * | 用例 | 书 | 超时 | 采集 |
 * | --- | --- | --- | --- |
 * | `perf-toc` | 《极品全能高手》（`huge`） | `bigBookTest`（`bookUnderTest`，6.8） | 5 轮，每轮先 (a) 后 (b)；(e) |
 * | `perf-shelf-search` | — | `test` | (c) × 5 |
 * | `perf-reader-search` | 《从零开始》（`longText`） | `bigBookTest` | (d) × 5；(e) |
 *
 * ## 不设门（14.1、14.4）
 *
 * 这些用例不含硬断言：依赖项目失败时 Playwright 会跳过下游全部项目，读数抖动不能连累别的用例。
 *
 * - 任一取样出错（到 `TIMEOUTS.wait` 仍未到达终止条件、无法建立 `longtask` 观测、复位不成立等）
 *   都记为该次"未采集"并附原因，不以 0 填充（14.7）；复位失败时本项余下的取样一并记为未采集。
 * - 每次取样前核对用例剩余时间，不足 `TIMEOUTS.wait + 5 s`（`SAMPLE_RESERVE_MS`）时余下取样记为
 *   未采集，用例本身不会超时。
 * - 书没能打开时，本用例的各项全部未采集；没等到 `[book-load]` 行时另以 `bookLog.uncollected`
 *   记该次打开未采集（14.2 (e)、14.7）。
 * - real 核对（4.3）未通过时由 `target` fixture 跳过；`lib.role` 按 4.7 跳过。跳过不阻断下游。
 *
 * 超预算只由 reporter 标注（14.4），本文件不比较预算。
 *
 * ## 时钟（14.8）
 *
 * 不装 Controlled_Clock。起止时刻都在页面内取：起点为触发事件的 `event.timeStamp`（`armStart`），
 * 终点为首个满足终止条件的动画帧回调开头的 `performance.now()`（`waitFrame`），二者同一时基
 * （`e2e/perf/probes.ts`）。等待只依据可观测条件；(c)(d) 的 100 ms 按键间隔（`pressSequentially`
 * 的 `delay`）是输入节奏，不是等待。
 *
 * 帧判定总在触发动作之前挂上（`untilAfter`）：动作的往返结束时页面可能早已画出结果，事后才开始
 * 判定会把终点推迟到下一帧之后。四个终止条件在触发之前都不成立。
 *
 * ## 各项
 *
 * - (a)：`armStart(目录按钮, "click")` → 点击 → 首个目录行（卷标题 `<h3>` 或章节按钮）与视口相交；
 *   读数 = 终点 − 点击时刻。
 * - (b)：在 (a) 打开的抽屉内打开 `longtask` 窗口，直接设定列表的 `scrollTop` 为
 *   (⌈N/2⌉ − 1) × `ROW_HEIGHT`（t0 取设定前一刻），等第 ⌈N/2⌉ 个节点的行与列表可视区相交；再设为
 *   最大值，等第 N 个节点的行相交（t1）；读数 = `maxLongTask(entries, t0, t1)`。N 取 `_toc.json`
 *   的节点数（`TocFacts.nodeCount`）。
 * - (c)：记下书卡标题序列 → `armStart(检索框, "input", "last")` → 逐字键入 `PERF.shelfQuery` →
 *   标题序列与输入前不同，且《从零开始》书卡可见；读数 = 终点 − 末次按键。终点早于末次按键（相邻
 *   按键间隔超过 250 ms 防抖，中途就出了结果）时记为未采集。
 * - (d)：先在测试进程中解压该书核对 `PERF.readerKeyword` 为 5 个字且至少命中 1 处，否则整项未采集。
 *   打开 `longtask` 窗口 → `armStart(检索框, "input", "first")` → 逐字键入 → 结果列表里出现命中
 *   文字恰为该关键词的结果；窗口为首次按键到终点。
 * - (e)：打开书经 `openReader`，等本次导航的 `[book-load]` 行；`bookLog` fixture 在 real 下把每行
 *   附为 `book-load`，reporter 据此写 (e)。
 *
 * ## 复位（14.7）
 *
 * - (a)(b)：每轮开始时关闭目录抽屉（Esc），核对正文 `<h1>` 仍是首个正文章节；再点一下正文标题，让
 *   顶栏显示并重新计时，等目录按钮完整位于视口内。顶栏在阅读器内的点击后 4.5 s 自动隐藏
 *   （`ReaderPage` 的 `triggerShowControls`，点击目录按钮本身也会触发），隐藏时目录按钮在视口之外，
 *   点不到。
 * - (c)：`fill("")`，等标题序列回到输入前。
 * - (d)：`fill("")`，等"输入关键词即可…"提示出现、结果列表清空。检索抽屉用快捷键 F 打开而不点顶栏
 *   按钮：点击会启动上面的 4.5 s 计时，顶栏到时隐藏引起的整页重渲染会落进某次 (d) 的观测窗口。
 *
 * ## 汇总
 *
 * `perf` fixture 在 teardown 里写 `perf-metrics.json` 并附为 `perf-metrics`（`PerfMetricsAttachment`：
 * `PerfItem[]`、`browser.version()`、headless 标志），中途出错、超时或跳过也照附；没取满的取样补记为
 * 未采集并注明用例提前结束。
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ElementHandle, Locator, Page, TestInfo } from "@playwright/test";
import { ROW_HEIGHT } from "../../../src/utils/listWindow";
import { PAGE_SIZE } from "../../../src/utils/pagination";
import {
  PERF_METRICS_ATTACHMENT,
  maxLongTask,
  type PerfItem,
  type PerfKey,
  type PerfMetricsAttachment,
} from "../../perf/metrics";
import {
  armStart,
  openLongTaskWindow,
  readStart,
  waitFrame,
  type InPage,
  type MeasurePredicate,
} from "../../perf/probes";
import { expect, test as base, type BookLog, type Lib } from "../../support/fixtures";
import type { TocFacts } from "../../support/library";
import { normalizeWhiteSpace, reader, searchDrawer, shelf, tocDrawer } from "../../support/locators";
import {
  bookText,
  bookUnderTest,
  expectCurrentChapter,
  findOccurrences,
  openReader,
  type BookUnderTest,
} from "../../support/reader";
import { PERF, TIMEOUTS } from "../../support/settings";
import { step } from "../../support/step";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 每次取样前至少要剩下的用例时间（设计"性能观测"：不足 `TIMEOUTS.wait + 5 s` 时余下取样记为未采集）。 */
const SAMPLE_RESERVE_MS = TIMEOUTS.wait + 5_000;

/** 14.2 (d)：关键词的字数。 */
const READER_KEYWORD_CHARS = 5;

/** 读数文件名（附件名见 `PERF_METRICS_ATTACHMENT`）。 */
const PERF_METRICS_FILE = "perf-metrics.json";

/** 未采集原因里错误信息的长度上限。 */
const REASON_MAX_CHARS = 300;

// ---------------------------------------------------------------------------
// 读数记录（`perf` fixture）
// ---------------------------------------------------------------------------

/** 一项 (a)–(d) 的取样记录，按取样顺序。 */
interface PerfSeries {
  readonly key: PerfKey;
  /** 记一次读数（毫秒）。 */
  push(ms: number): void;
  /** 记一次未采集及其原因（14.7）。 */
  miss(reason: string): void;
  /** 余下的取样全部记为未采集。 */
  missRest(reason: string): void;
  toItem(): PerfItem;
}

interface PerfRecorder {
  /** 登记本用例负责的一项；同一项只登记一次。 */
  series(key: PerfKey): PerfSeries;
  /** 剩余时间不够再取一次样时返回未采集的原因，否则返回 null。 */
  shortOfTime(): string | null;
}

function createSeries(key: PerfKey): PerfSeries {
  const readings: (number | null)[] = [];
  /** 原因 → 取样序号（从 1 起）。 */
  const reasons = new Map<string, number[]>();

  const miss = (reason: string): void => {
    if (readings.length >= PERF.samples) return;
    readings.push(null);
    const numbers = reasons.get(reason) ?? [];
    numbers.push(readings.length);
    reasons.set(reason, numbers);
  };

  return {
    key,
    push(ms) {
      if (readings.length >= PERF.samples) {
        throw new Error(`${key} 已取满 ${PERF.samples} 次，不能再记读数`);
      }
      readings.push(ms);
    },
    miss,
    missRest(reason) {
      while (readings.length < PERF.samples) miss(reason);
    },
    toItem() {
      const item: PerfItem = { key, readings: [...readings] };
      if (reasons.size > 0) {
        item.reason = [...reasons].map(([reason, numbers]) => `第 ${numbers.join("、")} 次：${reason}`).join("；");
      }
      return item;
    },
  };
}

/** 用例没取满就结束时，余下取样的未采集原因。 */
function endedEarlyReason(testInfo: TestInfo): string {
  if (testInfo.status === "skipped") {
    const skip = testInfo.annotations.find((a) => a.type === "skip");
    return skip?.description ? `用例跳过：${skip.description}` : "用例跳过";
  }
  return `用例在取满 ${PERF.samples} 次之前结束（${testInfo.status ?? "状态未知"}）`;
}

/** 写 `perf-metrics.json` 并附为 `perf-metrics`；写文件失败时改以正文附上，读数不丢。 */
async function attachPerfMetrics(testInfo: TestInfo, body: PerfMetricsAttachment): Promise<void> {
  const json = `${JSON.stringify(body, null, 2)}\n`;
  const file = testInfo.outputPath(PERF_METRICS_FILE);
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, json, "utf8");
  } catch {
    await testInfo.attach(PERF_METRICS_ATTACHMENT, { body: json, contentType: "application/json" });
    return;
  }
  await testInfo.attach(PERF_METRICS_ATTACHMENT, { path: file, contentType: "application/json" });
}

const test = base.extend<{ perf: PerfRecorder }>({
  perf: async ({ browser, headless }, use, testInfo) => {
    // 用例计时的近似起点：fixture 建立在用例体之前，比 Playwright 的计时略晚，差额远小于 SAMPLE_RESERVE_MS
    const startedAt = Date.now();
    const all = new Map<PerfKey, PerfSeries>();

    await use({
      series(key) {
        if (all.has(key)) throw new Error(`${key} 已登记`);
        const series = createSeries(key);
        all.set(key, series);
        return series;
      },
      shortOfTime() {
        if (testInfo.timeout === 0) return null;
        const left = testInfo.timeout - (Date.now() - startedAt);
        if (left >= SAMPLE_RESERVE_MS) return null;
        return `用例剩余时间约 ${Math.max(0, Math.round(left))} ms，不足 ${SAMPLE_RESERVE_MS} ms，未取样`;
      },
    });

    const early = endedEarlyReason(testInfo);
    const items = [...all.values()].map((series) => {
      series.missRest(early);
      return series.toItem();
    });
    await attachPerfMetrics(testInfo, { items, chromium: browser.version(), headless });
  },
});

// ---------------------------------------------------------------------------
// 取样框架
// ---------------------------------------------------------------------------

/** 错误信息的首个非空行（去掉 ANSI 颜色码），用作未采集的原因。 */
function brief(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  // eslint-disable-next-line no-control-regex
  const plain = text.replace(/\u001b\[[0-9;]*m/g, "");
  const line = plain.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "未知错误";
  return line.length > REASON_MAX_CHARS ? `${line.slice(0, REASON_MAX_CHARS)}…` : line;
}

/**
 * 以具名步骤取一次样：`body` 返回读数即记入 `series`，抛错时以错误信息记为未采集（14.7）。
 * 错误不外抛，步骤与用例都不因此失败。返回是否取得读数。
 */
function takeSample(series: PerfSeries, title: string, body: () => Promise<number>): Promise<boolean> {
  return step(title, async () => {
    try {
      series.push(await body());
      return true;
    } catch (error) {
      series.miss(brief(error));
      return false;
    }
  });
}

/** 以具名步骤执行准备或复位：成功返回 null，失败返回原因（不外抛）。 */
function attempt(title: string, body: () => Promise<void>): Promise<string | null> {
  return step(title, async () => {
    try {
      await body();
      return null;
    } catch (error) {
      return brief(error);
    }
  });
}

/** 剩余时间不足时把各项余下的取样记为未采集，返回 true（调用方随即停止取样）。 */
function outOfTime(perf: PerfRecorder, series: readonly PerfSeries[]): boolean {
  const short = perf.shortOfTime();
  if (short === null) return false;
  for (const s of series) s.missRest(short);
  return true;
}

/**
 * 先挂上帧判定（`waiting` 为已发出的 `waitFrame`），再执行触发动作，然后取判定结果。
 * 动作失败时丢弃判定结果（页面里的判定到 `capMs` 自行结束）并重抛动作的错误。
 */
async function untilAfter(waiting: Promise<number | null>, trigger: () => Promise<void>): Promise<number | null> {
  // 触发动作期间判定可能先 reject：先挂上处理，免得被当作未处理的拒绝；下面 await 时照样抛出
  waiting.catch(() => undefined);
  await trigger();
  return waiting;
}

/**
 * 打开阅读器并等本次导航的 `[book-load]` 行与正文（`openReader`）；给出 `ch` 时再核对当前章节。
 * 成功返回 null；失败返回原因，没等到 `[book-load]` 行时另记该次打开未采集（14.2 (e)）。
 */
async function openBook(page: Page, bookLog: BookLog, book: BookUnderTest, ch?: number): Promise<string | null> {
  const since = bookLog.count;
  try {
    await openReader(page, bookLog, book, ch);
    if (ch !== undefined) await expectCurrentChapter(page, book.facts, ch);
    return null;
  } catch (error) {
    const reason = brief(error);
    if (bookLog.find(book.id, undefined, since) === undefined) {
      bookLog.uncollected(book.id, `未捕获到本次打开的 [book-load] 行：${reason}`);
    }
    return `未能打开 ${book.id}：${reason}`;
  }
}

// ---------------------------------------------------------------------------
// 页内终止条件（自包含，规则见 probes.ts 文件头"谓词的传递方式"）
// ---------------------------------------------------------------------------

/**
 * (a)：抽屉内首个目录行（文档顺序中第一个卷标题 `<h3>` 或章节按钮）与视口相交。阅读器页上
 * `<h3>` 只出现在目录抽屉的卷节点行；章节按钮的文本以"N字"结尾，页上别的按钮都不是。
 */
const firstTocRowInViewport: MeasurePredicate<null> = (_arg, kit) => {
  for (const el of Array.from(document.querySelectorAll("h3, button"))) {
    if (el.tagName === "H3" || /\d+字$/.test(kit.text(el))) return kit.inViewport(el);
  }
  return false;
};

/** (b) 的目标行：目录列表 `list` 中列表项下标为 `index`、标题为 `title` 的行。 */
interface TocRowTarget {
  list: ElementHandle<HTMLElement>;
  index: number;
  /** 规整过空白的节点标题（`normalizeWhiteSpace`）。 */
  title: string;
  rowHeight: number;
}

/**
 * (b)：目标行已挂载且与列表可视区相交。行的列表项下标由它在列表内容中的上沿除以行高得出
 * （与 `readTocList` 相同）；文本以节点标题开头（章节行其后是"N字"）。
 */
const tocRowInList: MeasurePredicate<InPage<TocRowTarget>> = ({ list, index, title, rowHeight }, kit) => {
  if (!list.isConnected) return false;
  const top0 = list.getBoundingClientRect().top + list.clientTop;
  for (const el of Array.from(list.children)) {
    if (el.getAttribute("aria-hidden") === "true") continue;
    const offset = el.getBoundingClientRect().top - top0 + list.scrollTop;
    if (Math.round(offset / rowHeight) !== index) continue;
    return kit.text(el).startsWith(title) && kit.intersects(el, list);
  }
  return false;
};

/** (c) 的终止条件参数。 */
interface ShelfTarget {
  /** 书架的 `<main>`。 */
  main: ElementHandle<HTMLElement | SVGElement>;
  /** 输入前的书卡标题序列（规整过空白）。 */
  before: string[];
  /** 《从零开始》的书名（规整过空白）。 */
  title: string;
}

/** (c)：书卡标题序列与输入前不同，且标题为 `title` 的书卡可见（边界框非空、`visibility` 为 visible）。 */
const shelfShowsResults: MeasurePredicate<InPage<ShelfTarget>> = ({ main, before, title }, kit) => {
  const headings = Array.from(main.querySelectorAll("h3"));
  const titles = headings.map((h) => kit.text(h));
  if (titles.length === before.length && titles.every((t, i) => t === before[i])) return false;
  const card = headings.find((h) => kit.text(h) === title);
  if (card === undefined) return false;
  const box = card.getBoundingClientRect();
  return box.width > 0 && box.height > 0 && getComputedStyle(card).visibility === "visible";
};

/**
 * (d)：检索结果里有命中文字恰为关键词（不区分大小写）的一条。结果条目是内含 `<mark>` 的按钮；
 * 正文里的跳转高亮 `<mark>` 不在按钮内，不计入。`keyword` 已转小写。
 */
const keywordResultShown: MeasurePredicate<string> = (keyword, kit) =>
  Array.from(document.querySelectorAll("button mark")).some((mark) => kit.text(mark).toLowerCase() === keyword);

// ---------------------------------------------------------------------------
// (a)(b) 目录抽屉
// ---------------------------------------------------------------------------

/**
 * 每轮的起始状态（14.7）：目录抽屉关闭、正文 `<h1>` 仍是首个正文章节；点一下正文标题让顶栏显示并
 * 重新计时（见文件头"复位"），等目录按钮完整位于视口内。
 */
async function prepareTocRound(page: Page, facts: TocFacts, start: number): Promise<void> {
  const view = reader(page);
  const marker = tocDrawer(page).marker;
  if ((await marker.count()) > 0) await page.keyboard.press("Escape");
  await expect(marker, "目录抽屉应已关闭").toHaveCount(0);
  await expect(view.chapterHeading, "正文应停在首个正文章节").toHaveText(facts.titles[start]);
  await view.chapterHeading.click();
  await expect(view.tocButton, "顶栏的目录按钮应完整位于视口内").toBeInViewport({ ratio: 1 });
}

/** (a) 一次：点击目录按钮到首个目录行进入视口（毫秒）。 */
async function sampleTocOpen(page: Page): Promise<number> {
  const button = reader(page).tocButton;
  await armStart(button, "click", "first");
  const end = await untilAfter(waitFrame(page, firstTocRowInViewport, null), () => button.click());
  if (end === null) throw new Error(`点击目录按钮后 ${TIMEOUTS.wait} ms 内没有目录行出现在视口内`);
  return end - (await readStart(page));
}

/** 目录抽屉列表的滚动容器：从一个已挂载的行向上找最近的纵向滚动祖先（测量性遍历）。 */
function tocListHandle(page: Page): Promise<ElementHandle<HTMLElement>> {
  const drawer = tocDrawer(page);
  return drawer.chapterRows
    .or(drawer.volumes)
    .first()
    .evaluateHandle((row) => {
      for (let el = row.parentElement; el !== null; el = el.parentElement) {
        const overflow = getComputedStyle(el).overflowY;
        if (overflow === "auto" || overflow === "scroll") return el;
      }
      throw new Error("找不到目录行所在的纵向滚动容器");
    });
}

/** (b) 一次：两次直接设定滚动位置期间的最长长任务（毫秒）。目录抽屉须已打开。 */
async function sampleTocScroll(page: Page, facts: TocFacts): Promise<number> {
  const n = facts.nodeCount;
  const middle = Math.ceil(n / 2) - 1;
  const last = n - 1;
  const target = (list: ElementHandle<HTMLElement>, index: number): TocRowTarget => ({
    list,
    index,
    title: normalizeWhiteSpace(facts.titles[index]),
    rowHeight: ROW_HEIGHT,
  });

  const list = await tocListHandle(page);
  try {
    const longTasks = await openLongTaskWindow(page);
    try {
      const t0 = await list.evaluate((el, top) => {
        const now = performance.now();
        el.scrollTop = top;
        return now;
      }, middle * ROW_HEIGHT);
      const reached = await waitFrame(page, tocRowInList, target(list, middle));
      if (reached === null) {
        throw new Error(`设定 scrollTop 后 ${TIMEOUTS.wait} ms 内第 ${middle + 1} 个节点的行未进入列表可视区`);
      }
      await list.evaluate((el) => {
        el.scrollTop = el.scrollHeight - el.clientHeight;
      });
      const t1 = await waitFrame(page, tocRowInList, target(list, last));
      if (t1 === null) {
        throw new Error(`滚到底部后 ${TIMEOUTS.wait} ms 内第 ${n} 个节点的行未进入列表可视区`);
      }
      return maxLongTask(await longTasks.close(), t0, t1);
    } finally {
      await longTasks.close().catch(() => undefined);
    }
  } finally {
    await list.dispose().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// (c) 书架检索
// ---------------------------------------------------------------------------

/** 书架 `<main>` 内的书卡标题序列，按与 `FrameKit.text` 相同的规则规整空白（测量）。 */
function readCardTitles(main: Locator): Promise<string[]> {
  return main.evaluate((root) =>
    Array.from(root.querySelectorAll("h3"), (h) =>
      (h.textContent ?? "").replace(/[\u200b\u00ad]/g, "").trim().replace(/\s+/g, " "),
    ),
  );
}

/** (c) 的起始状态（14.7）：检索框为空，书卡标题序列与输入前相同。 */
async function resetShelfSearch(page: Page, before: readonly string[]): Promise<void> {
  const view = shelf(page);
  if ((await view.searchBox.inputValue()) !== "") await view.searchBox.fill("");
  await expect
    .poll(() => readCardTitles(view.main), { message: "清空检索框后书卡应回到输入前的序列", timeout: TIMEOUTS.wait })
    .toEqual(before);
}

/** (c) 一次：末次按键到结果列表更新为检索结果（毫秒）。 */
async function sampleShelfSearch(page: Page, target: ShelfTarget): Promise<number> {
  const box = shelf(page).searchBox;
  await armStart(box, "input", "last");
  const end = await untilAfter(waitFrame(page, shelfShowsResults, target), () =>
    box.pressSequentially(PERF.shelfQuery, { delay: PERF.keyIntervalMs }),
  );
  if (end === null) {
    throw new Error(`键入 ${PERF.shelfQuery} 后 ${TIMEOUTS.wait} ms 内书卡未更新为含《${target.title}》的检索结果`);
  }
  const reading = end - (await readStart(page));
  if (reading < 0) {
    throw new Error(`结果列表在末次按键之前已更新（早 ${(-reading).toFixed(1)} ms），相邻按键间隔超过了检索防抖`);
  }
  return reading;
}

// ---------------------------------------------------------------------------
// (d) 阅读器检索
// ---------------------------------------------------------------------------

/** (d) 的起始状态（14.7）：检索框为空，显示未输入提示，结果列表为空。 */
async function resetReaderSearch(page: Page): Promise<void> {
  const drawer = searchDrawer(page);
  if ((await drawer.input.inputValue()) !== "") await drawer.input.fill("");
  await expect(drawer.idleHint, "清空检索框后应显示未输入提示").toBeVisible();
  await expect(drawer.results, "清空检索框后结果列表应为空").toHaveCount(0);
}

/** (d) 一次：首次按键到结果列表出现完整关键词命中期间的最长长任务（毫秒）。检索抽屉须已打开。 */
async function sampleReaderSearch(page: Page, keyword: string): Promise<number> {
  const input = searchDrawer(page).input;
  const longTasks = await openLongTaskWindow(page);
  try {
    await armStart(input, "input", "first");
    const t1 = await untilAfter(waitFrame(page, keywordResultShown, keyword.toLowerCase()), () =>
      input.pressSequentially(keyword, { delay: PERF.keyIntervalMs }),
    );
    if (t1 === null) throw new Error(`键入「${keyword}」后 ${TIMEOUTS.wait} ms 内结果列表未出现该关键词的命中`);
    const t0 = await readStart(page);
    return maxLongTask(await longTasks.close(), t0, t1);
  } finally {
    await longTasks.close().catch(() => undefined);
  }
}

/** (d) 的关键词核对：5 个字且在全书中至少命中 1 处。满足时返回 null，否则返回未采集的原因。 */
async function readerKeywordProblem(lib: Lib, id: string): Promise<string | null> {
  const keyword = PERF.readerKeyword;
  const chars = Array.from(keyword).length;
  if (chars !== READER_KEYWORD_CHARS) {
    return `关键词「${keyword}」为 ${chars} 个字，应为 ${READER_KEYWORD_CHARS} 个字（PERF.readerKeyword）`;
  }
  const { count } = findOccurrences(await bookText(lib, id), keyword, 0);
  return count > 0 ? null : `关键词无命中：「${keyword}」在 ${id} 中出现 0 次（PERF.readerKeyword）`;
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

test.describe("需求 14 性能观测（只记录，不设门）", () => {
  test("perf-toc", async ({ page, lib, bookLog, perf }) => {
    const tocOpen = perf.series("tocOpen");
    const tocScroll = perf.series("tocScrollLongTask");
    const both = [tocOpen, tocScroll];

    const book = await bookUnderTest(lib, lib.role("huge"));
    const start = book.facts.bodyIndices[0];
    const failed = await openBook(page, bookLog, book, start);
    if (failed !== null) {
      for (const s of both) s.missRest(failed);
      return;
    }

    for (let round = 1; round <= PERF.samples; round++) {
      if (outOfTime(perf, both)) break;
      const notReady = await attempt(`第 ${round} 轮：复位（目录抽屉关闭、停在首个正文章节、顶栏显示）`, () =>
        prepareTocRound(page, book.facts, start),
      );
      if (notReady !== null) {
        for (const s of both) s.missRest(`复位失败：${notReady}`);
        break;
      }

      await takeSample(tocOpen, `(a) 第 ${round} 次：点击目录按钮到首个目录行进入视口`, () => sampleTocOpen(page));

      if (outOfTime(perf, both)) break;
      const notOpen = await attempt(`(b) 第 ${round} 次之前：目录抽屉已打开`, async () => {
        await expect(tocDrawer(page).marker, "目录抽屉应已打开").toBeVisible();
      });
      if (notOpen !== null) {
        tocScroll.miss(`目录抽屉未打开：${notOpen}`);
        continue;
      }
      await takeSample(
        tocScroll,
        `(b) 第 ${round} 次：直接滚到第 ⌈N/2⌉ 与第 N 个节点（N = ${book.facts.nodeCount}）期间的最长长任务`,
        () => sampleTocScroll(page, book.facts),
      );
    }
  });

  test("perf-shelf-search", async ({ page, lib, perf }) => {
    const shelfSearch = perf.series("shelfSearch");
    const catalog = await lib.books();
    const summary = await lib.book(lib.role("pinyin"));
    const title = normalizeWhiteSpace(summary.title);
    const view = shelf(page);
    const firstBatch = catalog.books.slice(0, PAGE_SIZE).map((b) => b.title);

    const opened = await step(
      `打开书架，等首批 ${firstBatch.length} 张书卡挂载`,
      async (): Promise<ShelfTarget | string> => {
        try {
          await page.goto("/");
          await expect(view.cardTitles).toHaveText(firstBatch);
          await expect(view.searchBox).toHaveValue("");
          return { main: await view.main.elementHandle(), before: await readCardTitles(view.main), title };
        } catch (error) {
          return brief(error);
        }
      },
    );
    if (typeof opened === "string") {
      shelfSearch.missRest(`书架未能加载：${opened}`);
      return;
    }
    const target = opened;
    const { before } = target;

    for (let round = 1; round <= PERF.samples; round++) {
      if (outOfTime(perf, [shelfSearch])) break;
      if (round > 1) {
        const notReady = await attempt(`第 ${round} 次之前：清空检索框，等书卡回到输入前`, () =>
          resetShelfSearch(page, before),
        );
        if (notReady !== null) {
          shelfSearch.missRest(`复位失败：${notReady}`);
          break;
        }
      }
      await takeSample(
        shelfSearch,
        `(c) 第 ${round} 次：逐字键入 ${PERF.shelfQuery}，末次按键到书卡更新为含《${title}》的结果`,
        () => sampleShelfSearch(page, target),
      );
    }
  });

  test("perf-reader-search", async ({ page, lib, bookLog, perf }) => {
    const readerSearch = perf.series("readerSearchLongTask");
    const book = await bookUnderTest(lib, lib.role("longText"));
    const keyword = PERF.readerKeyword;

    const problem = await step(`核对关键词「${keyword}」：${READER_KEYWORD_CHARS} 个字，全书至少命中 1 处`, () =>
      readerKeywordProblem(lib, book.id),
    );
    if (problem !== null) {
      readerSearch.missRest(problem);
      return;
    }

    const failed = await openBook(page, bookLog, book);
    if (failed !== null) {
      readerSearch.missRest(failed);
      return;
    }
    const notOpen = await attempt("按快捷键 F 打开检索抽屉", async () => {
      await page.keyboard.press("f");
      const drawer = searchDrawer(page);
      await expect(drawer.marker, "检索抽屉应已打开").toBeVisible();
      await expect(drawer.input).toBeVisible();
    });
    if (notOpen !== null) {
      readerSearch.missRest(`检索抽屉未打开：${notOpen}`);
      return;
    }

    for (let round = 1; round <= PERF.samples; round++) {
      if (outOfTime(perf, [readerSearch])) break;
      const notReady = await attempt(`第 ${round} 次之前：检索框为空、结果列表为空`, () => resetReaderSearch(page));
      if (notReady !== null) {
        readerSearch.missRest(`复位失败：${notReady}`);
        break;
      }
      await takeSample(
        readerSearch,
        `(d) 第 ${round} 次：逐字键入「${keyword}」期间的最长长任务`,
        () => sampleReaderSearch(page, keyword),
      );
    }
  });
});
