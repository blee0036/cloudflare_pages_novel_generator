/**
 * 性能观测：目录、检索与加载的实测读数（需求 6.10、14.1、14.2、14.3、14.7、14.8；Checklist H1、H2
 * 只记录），以及分页模式的翻页、重新分页与相邻章分页（reader-page-turn-modes 需求 14.1–14.4）。
 * 设计"性能观测（需求 14）"；翻页模式 design §10、§13.4。
 *
 * 不带前缀的条目号指 e2e-visual-testing 的需求；其他 spec 的条目写明 spec 名，翻页模式即
 * reader-page-turn-modes。
 *
 * `perf` 项目只收集本文件，不开 `fullyParallel`：5 个用例在同一 worker 里顺序执行。其余项目都依赖
 * 它，所以它先于一切用例单独运行，不与任何用例并发（6.10）。桌面视口、默认主题（不 `seedTheme`）、
 * Fixture_Library 的 Opaque_Mode 实例取自项目配置（14.2），不节流。项目级的
 * `prefers-reduced-motion: reduce`（6.3）只在 `perf-paged-turn` 里经 `page.emulateMedia` 取消：
 * 减弱动态效果时覆盖与仿真按无动画翻页（翻页模式需求 9.3），而翻页模式需求 14.1 测的正是动画与
 * 拖拽期间。`perf-repaginate` 不涉及动画，沿用项目配置。
 *
 * | 用例 | 书 | 超时 | 采集 |
 * | --- | --- | --- | --- |
 * | `perf-toc` | `lib.role("huge")` | 按 `bookUnderTest`（6.8） | 5 轮，每轮先 (a) 后 (b)；(e) |
 * | `perf-shelf-search` | —（终点书卡为 `lib.role("pinyin")`） | `test` | (c) × 5 |
 * | `perf-reader-search` | `lib.role("longText")` | 按 `bookUnderTest`（6.8） | (d) × 5；(e) |
 * | `perf-paged-turn` | 最长正文章节 L 所在的书 | 按 `bookUnderTest`（6.8） | (f)：仿真、覆盖各 5 个窗口；(h) × 5；(e) × 6 |
 * | `perf-repaginate` | 同上 | 按 `bookUnderTest`（6.8） | (g) × 5；(e) |
 *
 * `bookUnderTest` 只给 gz ≥ `BIG_BOOK_GZ_BYTES` 的书放宽到 `bigBookTest`。Fixture_Library 的书都
 * 小于该值，所以打开书的四个用例实际都是 `TIMEOUTS.test`。
 *
 * ## 取书与检索词（运行时推导）
 *
 * (a)–(d) 的书一律经 `lib.role()` 与 `lib.fixtureRoles()` 取自 `roles.json`；(f)–(h) 的书与章节按
 * 下面的规则由书库内容推导。检索词与期望值在运行时从 `books.json`、`_toc.json` 与 `.txt.gz` 推导。
 * 本文件不写书 id、书名、章节下标或检索词的字面量（test-data-desensitization 需求 4.1、4.3）。
 *
 * - (a)(b)：huge 用途那本书（`roles.json` 的 `huge`，用途特征为节点数 ≥ 3,000）。N 与各行标题取自
 *   它的 `_toc.json`（`TocFacts.nodeCount`、`TocFacts.titles`）。
 * - (c)：检索词为 `roles.json` 的 `pinyin.abbr`，即 pinyin 用途那本书书名的拼音首字母。终止条件里的
 *   书名取 `books.json` 中这本书的 `title`。
 * - (d)：longText 用途那本书在测试进程中解压（`bookText`）。取下标为 `roles.json` 的
 *   `longText.chapterIndex` 的节点，它在 `_toc.json` 中的范围 `[start, end)` 含标题行；自中点
 *   `start + ⌊(end − start) / 2⌋` 起，落在 `end` 之前的第一处 5 个连续汉字（`\p{Script=Han}`）即
 *   关键词。再按 `findOccurrences` 核对它在全书中至少命中 1 处。规则只看书库内容，书库不变时每次
 *   取到同一个词。
 * - (f)(g)(h)：Fixture_Library 中最长的正文章节，记为第 L 章（翻页模式需求 14.2 的测量对象，(f)(h)
 *   沿用同一章）。遍历 `books.json` 列出的每本书的 `_toc.json`，取非卷节点中范围 `end − start`（章内
 *   偏移的取值范围）最大的一个；并列时取 `books.json` 中靠前的书、同一本书中下标小的节点。(h) 另取
 *   L 之后的下一个正文章节 L₁ 与再下一个 L₂（`TocFacts.bodyIndices`，跳过卷节点）。规则只看书库
 *   内容，书库不变时每次取到同一章。
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
 * - (d) 的关键词取不到（节点不存在、是卷节点、中点之后没有 5 个连续汉字、全书无命中，或读取、解压
 *   出错）时，整项记为未采集并写明原因，不再打开书（14.7）。
 * - (f)–(h) 的前提不成立时同样记为未采集并写明原因：书库读不出最长正文章节时三项全部未采集；第 L 章
 *   的页数不够在章内连翻 4 页时 (f) 的复位失败；L 之后不足两个正文章节时 (h) 整项未采集。
 * - Fixture_Generator 失败时，`target` fixture 按 `[3.9]` 跳过本文件的全部用例，跳过不阻断下游。
 *   用途核对不成立时 `lib.role` 抛 `[4.2]`，用例判失败（test-data-desensitization 需求 4.2）。这是
 *   书库本身的问题，不是读数抖动。
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
 * 判定会把终点推迟到下一帧之后。各终止条件在触发之前都不成立。
 *
 * 两处起点不是输入事件：(f) 的窗口起点 t0 是鼠标按下之前在页内取的 `performance.now()`；(h) 的起点
 * 是跨章翻页的提交，触发之前在 `<main>` 上挂 `MutationObserver`，在提交那次 DOM 变更的回调里取
 * `performance.now()`（`armCommitWatch`）。二者与帧时刻、`longtask` 条目同一时基。
 *
 * ## 各项
 *
 * - (a)：`armStart(目录按钮, "click")` → 点击 → 首个目录行（卷标题 `<h3>` 或章节按钮）与视口相交；
 *   读数 = 终点 − 点击时刻。
 * - (b)：在 (a) 打开的抽屉内打开 `longtask` 窗口，直接设定列表的 `scrollTop` 为
 *   (⌈N/2⌉ − 1) × `ROW_HEIGHT`（t0 取设定前一刻），等第 ⌈N/2⌉ 个节点的行与列表可视区相交；再设为
 *   最大值，等第 N 个节点的行相交（t1）；读数 = `maxLongTask(entries, t0, t1)`。
 * - (c)：记下书卡标题序列 → `armStart(检索框, "input", "last")` → 逐字键入检索词 → 标题序列与输入前
 *   不同，且 pinyin 用途那本书的书卡可见；读数 = 终点 − 末次按键。终点早于末次按键（相邻按键间隔
 *   超过 250 ms 防抖，中途就出了结果）时记为未采集。
 * - (d)：先按上文的规则取关键词。打开 `longtask` 窗口 → `armStart(检索框, "input", "first")` →
 *   逐字键入 → 结果列表里出现命中文字恰为该关键词的结果；窗口为首次按键到终点。
 * - (e)：打开书经 `openReader`（(f)–(h) 经 `openPagedBook`），等本次导航的 `[book-load]` 行；
 *   `bookLog` fixture 在 `perf` 项目下把每行附为 `book-load`，reporter 据此写 (e)。`perf-paged-turn`
 *   打开 6 次（开头 1 次、(h) 每次取样前 1 次），每次一行。
 * - (f)：分页模式，`seedPageMode` 先置为仿真，仿真 5 个窗口取完后经设置抽屉切到覆盖，再取 5 个
 *   窗口（分页族内切换不重挂视图）。每个窗口：打开 `longtask` 窗口，页内取 t0；在 `<main>` 上自视口
 *   宽 `DRAG_FROM_X`、高 `DRAG_Y` 处按下鼠标，分 `DRAG_STEPS` 步左移到宽 `DRAG_TO_X` 处后抬起（拖过
 *   半屏，末次移动朝 NEXT，翻页完成，需求 4.7），等翻到下一页落定；再点九宫格 MR 区 `PAGED_TAPS`
 *   次，每次等上一次落定再点（不打断动画）。"落定"即首个 `<main data-turning="false">` 且当前页
 *   `data-page-index` 为下一页的帧，判定在动作之前挂上；t1 为最后一次落定的那一帧。窗口读数 =
 *   `maxLongTask(entries, t0, t1)`。第 k 次读数取仿真第 k 个窗口与覆盖第 k 个窗口的较大者，任一
 *   未采集则第 k 次未采集，原因按模式注明。
 * - (g)：覆盖模式（`seedPageMode`）。`armStart(字号滑杆, "input", "first")` → 在滑杆上按一次 `→`
 *   （已到上限时按 `←`），即把滑杆移动一档 → 首个同时满足下列条件的帧：当前页仍属第 L 章，
 *   `data-page-start ≤ P <` 当前页最后一个正文片段的末尾（该 `<p>` 的 `data-offset` 加文字长度），
 *   该片段的计算字号为新值，`data-paginated` 含 L；读数 = 终点 − 输入事件时刻。
 *   - 包含：页内片段是正文的连续切片（`pageView`），P 是原版式下的页首，总落在某段之内，所以"不小于
 *     页首、小于末片段的末尾"恰是"当前页包含 P"。
 *   - `layoutKey` 已更新：`layoutKey` 不在 DOM 上。`data-paginated` 只列出与本次渲染的 `layoutKey`
 *     相同的页表（`usePaginator` 的 `paginatedIds`）；正文已按新字号渲染，说明本次渲染的 `layoutKey`
 *     已含新字号。二者出自同一次提交，同时成立即当前页取自新 `layoutKey` 下的页表。
 *   - 用键盘而不用指针拖动滑杆：一档只产生一个 `input` 事件，起止唯一；指针拖动会连发若干个中间值，
 *     每个都触发一次重分页。键盘与指针拖动走的是同一个 `input` 事件与 `onChange`。
 * - (h)：覆盖模式（(f) 最后切到的模式，存储随整页重开保留）。在第 L 章末页按 `→` 跨章到 L₁；起点为
 *   提交时刻（当前页 `data-chapter-id` 为 L₁ 且 `data-turning="false"` 的那次 DOM 变更），终点为首个
 *   `data-paginated` 含 L₂ 的帧（翻页模式 design §10：跨章后新的相邻章）；读数 = 终点 − 起点。
 *
 * ## 复位（14.7）
 *
 * - (a)(b)：每轮开始时关闭目录抽屉（Esc），核对正文 `<h1>` 仍是首个正文章节；再以 `reshowControls`
 *   重新亮起控制栏（可见时点两下九宫格 MC 区，先隐藏再唤出；不可见时点一下），让顶栏显示并重新计时，
 *   等目录按钮完整位于视口内。顶栏显示后 4.5 s 自动隐藏（`ReaderPage` 的 `triggerShowControls`；点 MC
 *   与点顶栏都会重新计时，点击目录按钮本身也算），隐藏时目录按钮在视口之外，点不到。不点正文标题：
 *   标题在 TL/TC 区，控制栏不可见时点它会回翻，可见时点正文任一处只会把控制栏隐藏
 *   （reader-page-turn-modes 需求 5.4、5.9）。
 * - (c)：`fill("")`，等标题序列回到输入前。
 * - (d)：`fill("")`，等"输入关键词，在整本书里查找"提示出现、结果列表清空。检索抽屉用快捷键 F 打开而不点顶栏
 *   按钮：点击会启动上面的 4.5 s 计时，顶栏到时隐藏引起的整页重渲染会落进某次 (d) 的观测窗口。
 * - (f)：每个窗口之前核对页面不处于减弱动态效果（否则翻页没有动画）、设置抽屉已关闭；按 `Home`
 *   回到第 L 章第 1 页（`edge()`，不播动画）；等
 *   `data-paginated` 含 L 与它前后的正文章节，即相邻章后台分页已完成，窗口内的翻页都在章内，不会
 *   再排相邻章分页（design §4.5）；核对本章页数够连翻 `PAGED_TURNS` 页；控制栏隐藏（可见时点一下
 *   MC：控制栏可见时点正文只隐藏它、不翻页，需求 5.9；页面刚打开时控制栏可见且不自动隐藏）。
 * - (g)：一次性准备：打开第 L 章，隐藏控制栏，点 MR 翻到第 ⌊页数 / 2⌋ 页（从 0 起），记下 P = 该页
 *   `data-page-start`（翻页提交后阅读位置即 P，需求 2.7），按 S 打开设置抽屉，此后一直开着。每次
 *   取样前：字号滑杆不在原值时按一次反向键，等滑杆回到原值、当前页包含 P 且正文为原字号（判定同
 *   上）。重分页只重算显示页、不改阅读位置（design §3.3），所以每次都从 P 出发。按反向键之前与
 *   复位完成时都等 `data-paginated` 含 L 与它前后的正文章节：每次改字号后分页器会在空闲回调里重排
 *   相邻章（design §4.5），等它做完再改下一次，取样测的只是当前章的同步重分页，不与后台分页交叠。
 * - (h)：每次取样前整页重新打开 `?ch=L`（页表缓存随文档清空；同章有进度时会恢复到页中，不影响），
 *   等 `data-paginated` 含 L 与它前后的正文章节、不含 L₂，再按 `End` 到本章末页。不在同一文档里
 *   接着取：L₂ 一旦分页就留在缓存里（缓存保留最近 5 章），下一次就没有"新的相邻章"了。
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
import { PAGE_ANIM, type PageAnim } from "../../../src/utils/pageAnim";
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
import {
  normalizeWhiteSpace,
  reader,
  searchDrawer,
  settingsDrawer,
  shelf,
  tocDrawer,
} from "../../support/locators";
import {
  bookText,
  bookUnderTest,
  expectCurrentChapter,
  findOccurrences,
  openReader,
  pageModeSpec,
  readControlsVisible,
  readPagedView,
  readerPath,
  reshowControls,
  seedPageMode,
  selectPageMode,
  tapZoneCenter,
  waitPageTurnSettled,
  type BookUnderTest,
  type CurrentPage,
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

/** (f) 的两种模式，按取样顺序（翻页模式 design §10："仿真与覆盖模式下"）。 */
const TURN_MODES: readonly PageAnim[] = [PAGE_ANIM.simulation, PAGE_ANIM.cover];

/** (f) 拖拽的按下点与抬起点：占阅读视口（`<main>`）宽、高的比例。按下点在 MR 区，抬起点越过半屏。 */
const DRAG_FROM_X = 0.9;
const DRAG_TO_X = 0.3;
const DRAG_Y = 0.5;

/** (f) 拖拽的分步数（`page.mouse.move` 的 `steps`）：每一步是一次 `pointermove`。 */
const DRAG_STEPS = 12;

/** (f) 拖拽翻页之后连续点击 MR 的次数。 */
const PAGED_TAPS = 3;

/** (f) 一个窗口在章内翻过的页数：拖拽 1 页加点击 `PAGED_TAPS` 页。 */
const PAGED_TURNS = 1 + PAGED_TAPS;

/** 隐藏控制栏时最多点几次 MC：正常 1 次；按下时恰有选区只清除选区（需求 5.8），再留一次余量。 */
const HIDE_MAX_TAPS = 3;

/** (h) 跨章翻页用的键（分页模式下为 NEXT，需求 11.1）。 */
const NEIGHBOR_TURN_KEY = "ArrowRight";

/** (h) 提交时刻的页内记录在 `window` 上的键。 */
const COMMIT_WATCH_KEY = "__e2ePerfCommitWatch";

// ---------------------------------------------------------------------------
// 读数记录（`perf` fixture）
// ---------------------------------------------------------------------------

/** 一项 (a)–(d)、(f)–(h) 的取样记录，按取样顺序。 */
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

/**
 * 把读数存为 `perf-metrics.json`，再以 `perf-metrics` 为名附上。存盘失败时直接把 JSON 作为附件的
 * `body`，读数照样交给 reporter。
 */
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
 * 以具名步骤取一次样，不记入任何一项：返回读数，或以错误信息作为未采集的原因（不外抛）。
 * (f) 先分模式取窗口读数，两种模式都取完后再合成每次的读数（`combineTurnWindows`）。
 */
function measureOnce(title: string, body: () => Promise<number>): Promise<number | string> {
  return step(title, async () => {
    try {
      return await body();
    } catch (error) {
      return brief(error);
    }
  });
}

/**
 * 执行一次打开书的动作 `open`：成功返回 null；失败返回原因，没等到本次的 `[book-load]` 行时另记该次
 * 打开未采集（14.2 (e)）。
 */
async function openWith(bookLog: BookLog, book: BookUnderTest, open: () => Promise<void>): Promise<string | null> {
  const since = bookLog.count;
  try {
    await open();
    return null;
  } catch (error) {
    const reason = brief(error);
    if (bookLog.find(book.id, undefined, since) === undefined) {
      bookLog.uncollected(book.id, `未捕获到本次打开的 [book-load] 行：${reason}`);
    }
    return `未能打开 ${book.id}：${reason}`;
  }
}

/**
 * 打开阅读器并等本次导航的 `[book-load]` 行与正文（`openReader`）；给出 `ch` 时再核对当前章节。
 * 成功返回 null；失败返回原因（`openWith`）。
 */
function openBook(page: Page, bookLog: BookLog, book: BookUnderTest, ch?: number): Promise<string | null> {
  return openWith(bookLog, book, async () => {
    await openReader(page, bookLog, book, ch);
    if (ch !== undefined) await expectCurrentChapter(page, book.facts, ch);
  });
}

/**
 * 分页模式下打开 `?ch=<chapter>`（一次完整导航）：等本次导航的 `[book-load]` 行与翻页落定，核对当前页
 * 属于该章。不要求停在章首（同章有进度时阅读器恢复到页中，翻页模式需求 12.2），所以不等 `<h1>`：
 * 分页模式只在本章第 1 页显示标题（需求 2.2）。成功返回 null；失败返回原因（`openWith`）。
 */
function openPagedBook(page: Page, bookLog: BookLog, book: BookUnderTest, chapter: number): Promise<string | null> {
  const url = readerPath(book.id, chapter);
  return openWith(bookLog, book, () =>
    step(`打开 ${decodeURIComponent(url)}（分页模式），等当前页落在下标 ${chapter} 的章节`, async () => {
      const since = bookLog.count;
      await page.goto(url);
      await bookLog.waitFor(book.id, undefined, { since, timeout: book.loadTimeout });
      const current = await waitPageTurnSettled(page);
      if (current.chapterId !== chapter) {
        throw new Error(`当前页在下标 ${current.chapterId} 的章节，应为 ${chapter}`);
      }
    }),
  );
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
  /** pinyin 用途那本书的书名（取自 `books.json`，规整过空白）。 */
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
 * 每轮的起始状态（14.7）：目录抽屉关闭、正文 `<h1>` 仍是首个正文章节；以 `reshowControls` 点九宫格
 * MC 区让顶栏显示并重新计时（见文件头"复位"），等目录按钮完整位于视口内。
 */
async function prepareTocRound(page: Page, facts: TocFacts, start: number): Promise<void> {
  const view = reader(page);
  const marker = tocDrawer(page).marker;
  if ((await marker.count()) > 0) await page.keyboard.press("Escape");
  await expect(marker, "目录抽屉应已关闭").toHaveCount(0);
  await expect(view.chapterHeading, "正文应停在首个正文章节").toHaveText(facts.titles[start]);
  await reshowControls(page);
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

/** (c) 一次：逐字键入 `query`，末次按键到结果列表更新为检索结果（毫秒）。 */
async function sampleShelfSearch(page: Page, target: ShelfTarget, query: string): Promise<number> {
  const box = shelf(page).searchBox;
  await armStart(box, "input", "last");
  const end = await untilAfter(waitFrame(page, shelfShowsResults, target), () =>
    box.pressSequentially(query, { delay: PERF.keyIntervalMs }),
  );
  if (end === null) {
    throw new Error(`键入 ${query} 后 ${TIMEOUTS.wait} ms 内书卡未更新为含《${target.title}》的检索结果`);
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

/** (d) 的关键词，或取不到时未采集的原因。 */
type ReaderKeyword = { ok: true; keyword: string } | { ok: false; reason: string };

/**
 * 自 `from` 起第一处 `READER_KEYWORD_CHARS` 个连续汉字，须整段落在 `to` 之前；没有时为 null。
 * 汉字的判定与 `global-setup.ts` 的"含中文字符"相同：`\p{Script=Han}`。
 */
function firstHanRun(text: string, from: number, to: number): string | null {
  const pattern = new RegExp(`\\p{Script=Han}{${READER_KEYWORD_CHARS}}`, "u");
  return pattern.exec(text.slice(from, to))?.[0] ?? null;
}

/**
 * (d) 的关键词（规则见文件头"取书与检索词"）：`id` 那本书中下标为 `chapterIndex` 的节点，自其
 * `[start, end)` 的中点起第一处 `READER_KEYWORD_CHARS` 个连续汉字，且在全书中至少命中 1 处。
 * 取不到时返回未采集的原因；读取或解压出错也归入原因，不外抛（14.7）。
 */
async function deriveReaderKeyword(lib: Lib, id: string, chapterIndex: number): Promise<ReaderKeyword> {
  const missed = (reason: string): ReaderKeyword => ({ ok: false, reason });
  const where = `${id} 下标 ${chapterIndex} 的节点（roles.json 的 longText.chapterIndex）`;
  try {
    const [toc, book] = await Promise.all([lib.toc(id), bookText(lib, id)]);
    const node = toc.chapters[chapterIndex];
    if (node === undefined) return missed(`${where}不存在（共 ${toc.chapters.length} 个节点）`);
    if (node.isVolume === true) return missed(`${where}是卷节点，不是正文章节`);
    const mid = node.start + Math.floor((node.end - node.start) / 2);
    const keyword = firstHanRun(book.text, mid, node.end);
    if (keyword === null) {
      return missed(`${where}自中点（章内偏移 ${mid - node.start}）到章末没有 ${READER_KEYWORD_CHARS} 个连续汉字`);
    }
    const { count } = findOccurrences(book, keyword, 0);
    return count > 0 ? { ok: true, keyword } : missed(`关键词无命中：「${keyword}」在 ${id} 中出现 0 次`);
  } catch (error) {
    return missed(`无法取得关键词：${brief(error)}`);
  }
}

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

// ---------------------------------------------------------------------------
// (f)(g)(h) 分页模式：取章与共用步骤
// ---------------------------------------------------------------------------

/** (f)–(h) 的书与章节（规则见文件头"取书与检索词"）。 */
interface PagedPlan {
  book: BookUnderTest;
  /** 第 L 章：Fixture_Library 中最长的正文章节在其书中的下标。 */
  chapter: number;
  /** 第 L 章的 `end − start`。 */
  chars: number;
  /** 取样前应已分页的章：L 与它前后的正文章节（相邻章后台分页完成，design §4.5），升序。 */
  settled: number[];
  /** L₁：L 之后的下一个正文章节；没有时为 null。 */
  next: number | null;
  /** L₂：L₁ 之后的下一个正文章节；没有时为 null。 */
  afterNext: number | null;
}

/** (f)–(h) 的书与章节，或取不到时三项未采集的原因。 */
type PagedPlanResult = { ok: true; plan: PagedPlan } | { ok: false; reason: string };

/** `index` 之前（`delta = -1`）或之后（`delta = 1`）的正文章节下标，跳过卷节点；没有时为 null。 */
function adjacentBodyChapter(facts: TocFacts, index: number, delta: 1 | -1): number | null {
  const ordinal = facts.bodyOrdinals[index];
  if (ordinal === null || ordinal === undefined) return null;
  return facts.bodyIndices[ordinal + delta] ?? null;
}

/**
 * 取第 L 章（Fixture_Library 中最长的正文章节，规则见文件头）与它的相邻正文章节。读不出书库时返回
 * 未采集的原因，不外抛（14.7）。`bookUnderTest` 会为大书放宽用例超时，须在用例体内调用。
 */
async function derivePagedPlan(lib: Lib): Promise<PagedPlanResult> {
  try {
    const { books } = await lib.books();
    const tocs = await Promise.all(books.map((b) => lib.toc(b.id)));
    let best: { id: string; index: number; chars: number } | null = null;
    for (let b = 0; b < books.length; b++) {
      const { chapters } = tocs[b];
      for (let index = 0; index < chapters.length; index++) {
        const node = chapters[index];
        if (node.isVolume === true) continue;
        const chars = node.end - node.start;
        if (best === null || chars > best.chars) best = { id: books[b].id, index, chars };
      }
    }
    if (best === null) return { ok: false, reason: "books.json 列出的书里没有正文章节" };

    const book = await bookUnderTest(lib, best.id);
    const prev = adjacentBodyChapter(book.facts, best.index, -1);
    const next = adjacentBodyChapter(book.facts, best.index, 1);
    const afterNext = next === null ? null : adjacentBodyChapter(book.facts, next, 1);
    const settled = [prev, best.index, next].filter((id): id is number => id !== null);
    return { ok: true, plan: { book, chapter: best.index, chars: best.chars, settled, next, afterNext } };
  } catch (error) {
    return { ok: false, reason: `无法取得书库中最长的正文章节：${brief(error)}` };
  }
}

/** 等待目标：第 `chapterId` 章的第 `pageIndex` 页翻页落定。 */
interface PageAt {
  main: ElementHandle<HTMLElement | SVGElement>;
  chapterId: number;
  pageIndex: number;
}

/** 翻页落定：`<main data-turning="false">`，当前页图层属于 `chapterId` 章、`data-page-index` 为 `pageIndex`。 */
const pageSettledAt: MeasurePredicate<InPage<PageAt>> = ({ main, chapterId, pageIndex }) => {
  if (!main.isConnected || main.getAttribute("data-turning") !== "false") return false;
  const el = main.querySelector('[data-current="true"][data-page-index]');
  return (
    el !== null &&
    el.getAttribute("data-chapter-id") === String(chapterId) &&
    el.getAttribute("data-page-index") === String(pageIndex)
  );
};

/** 挂上"落到第 `chapterId` 章第 `pageIndex` 页"的帧判定（`waitFrame`），交给 `untilAfter`。 */
function waitPageAt(
  page: Page,
  main: ElementHandle<HTMLElement | SVGElement>,
  chapterId: number,
  pageIndex: number,
): Promise<number | null> {
  const target: PageAt = { main, chapterId, pageIndex };
  return waitFrame(page, pageSettledAt, target);
}

/**
 * 分页视图此刻的状态（测量），写进未采集的原因：`data-turning`、`data-paginated`，当前页的章号、页码、
 * 页首，末个正文片段的末尾与计算字号。读不出时返回原因，不外抛。
 */
async function describePaged(page: Page): Promise<string> {
  try {
    return await reader(page).main.evaluate((main) => {
      const parts = [
        `data-turning=${main.getAttribute("data-turning")}`,
        `data-paginated=${main.getAttribute("data-paginated")}`,
      ];
      const el = main.querySelector('[data-current="true"][data-page-index]');
      if (el === null) {
        parts.push("没有当前页图层");
        return parts.join("，");
      }
      const index = Number(el.getAttribute("data-page-index"));
      parts.push(
        `当前页为下标 ${el.getAttribute("data-chapter-id")} 的章节第 ${index + 1} / ${el.getAttribute("data-page-count")} 页`,
        `页首 ${el.getAttribute("data-page-start")}`,
      );
      const fragments = el.querySelectorAll("p[data-offset]");
      if (fragments.length === 0) {
        parts.push("没有正文片段");
      } else {
        const last = fragments[fragments.length - 1];
        const end = Number(last.getAttribute("data-offset")) + (last.textContent ?? "").length;
        parts.push(`末片段止于 ${end}`, `字号 ${getComputedStyle(last).fontSize}`);
      }
      return parts.join("，");
    });
  } catch (error) {
    return `读不出分页状态：${brief(error)}`;
  }
}

/** 当前页（翻页已落定）；不在第 `chapterId` 章时抛错。只读，不等待。 */
async function currentPageIn(page: Page, chapterId: number): Promise<CurrentPage> {
  const { current, turning } = await readPagedView(page);
  if (current === null || turning !== false) throw new Error("当前页图层未就位或翻页尚未落定");
  if (current.chapterId !== chapterId) {
    throw new Error(`当前页在下标 ${current.chapterId} 的章节，应为 ${chapterId}`);
  }
  return current;
}

/** 按 `Home` / `End` 落到第 `chapterId` 章的首页 / 末页（`edge()`，需求 11.3）并等落定；已在该页时不按。 */
async function pressEdge(page: Page, chapterId: number, key: "Home" | "End"): Promise<void> {
  const current = await currentPageIn(page, chapterId);
  const target = key === "Home" ? 0 : current.pageCount - 1;
  if (current.pageIndex === target) return;
  const main = await reader(page).main.elementHandle();
  try {
    const at = await untilAfter(waitPageAt(page, main, chapterId, target), () => page.keyboard.press(key));
    if (at === null) {
      throw new Error(`按 ${key} 后 ${TIMEOUTS.wait} ms 内没有落到本章第 ${target + 1} 页（${await describePaged(page)}）`);
    }
  } finally {
    await main.dispose().catch(() => undefined);
  }
}

/** 点 MR 区翻到第 `chapterId` 章的下一页（当前为第 `index` 页），返回落定那一帧的时刻。 */
async function tapToNextPage(
  page: Page,
  main: ElementHandle<HTMLElement | SVGElement>,
  chapterId: number,
  index: number,
): Promise<number> {
  const at = await untilAfter(waitPageAt(page, main, chapterId, index + 1), async () => {
    await tapZoneCenter(page, "MR");
  });
  if (at === null) {
    throw new Error(`点击 MR 后 ${TIMEOUTS.wait} ms 内没有翻到本章第 ${index + 2} 页（${await describePaged(page)}）`);
  }
  return at;
}

/**
 * 等 `data-paginated` 含 `present` 的每一章（后台分页完成，上限为 expect 超时），再核对它不含
 * `absent` 的任何一章。
 */
async function expectPaginated(page: Page, present: readonly number[], absent: readonly number[] = []): Promise<void> {
  await expect
    .poll(
      async () => {
        const { paginated } = await readPagedView(page);
        return present.filter((id) => !paginated.includes(id));
      },
      { message: `data-paginated 应含下标 ${present.join("、")}（读数为尚缺的章号）` },
    )
    .toEqual([]);
  if (absent.length === 0) return;
  const { paginated } = await readPagedView(page);
  const already = absent.filter((id) => paginated.includes(id));
  if (already.length > 0) throw new Error(`data-paginated 已含下标 ${already.join("、")}，取样前不应已分页`);
}

/**
 * 隐藏控制栏：可见时点一下 MC（控制栏可见时点正文只隐藏它，需求 5.9），直到不可见。不可见时不点：
 * 点 MC 会唤出控制栏（需求 5.4）。调用前不得有面板打开。
 */
async function hideControls(page: Page): Promise<void> {
  for (let tap = 0; tap < HIDE_MAX_TAPS; tap++) {
    if (!(await readControlsVisible(page))) return;
    await tapZoneCenter(page, "MC");
  }
  if (await readControlsVisible(page)) throw new Error(`点了 ${HIDE_MAX_TAPS} 次 MC，控制栏仍可见`);
}

// ---------------------------------------------------------------------------
// (f) 拖拽与点击翻页期间的最长长任务
// ---------------------------------------------------------------------------

/** 当前不是 `anim` 模式时经设置抽屉切换（`selectPageMode`，随后关上抽屉）。 */
async function ensurePageMode(page: Page, anim: PageAnim): Promise<void> {
  const { mode } = await readPagedView(page);
  if (mode !== pageModeSpec(anim).attr) await selectPageMode(page, anim);
}

/** (f) 每个窗口的起始状态（14.7，见文件头"复位"）。 */
async function prepareTurnWindow(page: Page, plan: PagedPlan): Promise<void> {
  const reduced = await page.evaluate(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  if (reduced) throw new Error("页面处于 prefers-reduced-motion: reduce，翻页不播放动画（翻页模式需求 9.3）");
  await expect(settingsDrawer(page).marker, "设置抽屉应已关闭").toHaveCount(0);
  await pressEdge(page, plan.chapter, "Home");
  await expectPaginated(page, plan.settled);
  const current = await currentPageIn(page, plan.chapter);
  if (current.pageCount < PAGED_TURNS + 1) {
    throw new Error(`第 L 章（下标 ${plan.chapter}）只有 ${current.pageCount} 页，不够在章内连翻 ${PAGED_TURNS} 页`);
  }
  await hideControls(page);
}

/**
 * 用鼠标分步拖拽一页并释放（见文件头 (f)）。按下前核对按下点最上层的元素在 `<main>` 之内，被控制栏、
 * 面板或遮罩挡住时抛错。
 */
async function dragOnePage(page: Page): Promise<void> {
  const at = await reader(page).main.evaluate(
    (main, f) => {
      const r = main.getBoundingClientRect();
      const y = r.top + r.height * f.y;
      const from = r.left + r.width * f.from;
      const to = r.left + r.width * f.to;
      const hit = document.elementFromPoint(from, y);
      return { y, from, to, inside: hit !== null && main.contains(hit) };
    },
    { from: DRAG_FROM_X, to: DRAG_TO_X, y: DRAG_Y },
  );
  if (!at.inside) throw new Error(`拖拽按下点 (${at.from}, ${at.y}) 不在 <main> 内（被控制栏、面板或遮罩挡住）`);
  await page.mouse.move(at.from, at.y);
  await page.mouse.down();
  await page.mouse.move(at.to, at.y, { steps: DRAG_STEPS });
  await page.mouse.up();
}

/** (f) 一个窗口：拖拽一页并释放、再点 MR `PAGED_TAPS` 次期间的最长长任务（毫秒）。 */
async function sampleTurnWindow(page: Page, plan: PagedPlan): Promise<number> {
  const main = await reader(page).main.elementHandle();
  try {
    let index = (await currentPageIn(page, plan.chapter)).pageIndex;
    const longTasks = await openLongTaskWindow(page);
    try {
      const t0 = await page.evaluate(() => performance.now());
      const dragged = await untilAfter(waitPageAt(page, main, plan.chapter, index + 1), () => dragOnePage(page));
      if (dragged === null) {
        throw new Error(`拖拽释放后 ${TIMEOUTS.wait} ms 内没有翻到本章第 ${index + 2} 页（${await describePaged(page)}）`);
      }
      let t1 = dragged;
      index += 1;
      for (let tap = 1; tap <= PAGED_TAPS; tap++) {
        t1 = await tapToNextPage(page, main, plan.chapter, index);
        index += 1;
      }
      return maxLongTask(await longTasks.close(), t0, t1);
    } finally {
      await longTasks.close().catch(() => undefined);
    }
  } finally {
    await main.dispose().catch(() => undefined);
  }
}

/** (f) 一种模式的 5 个窗口读数（毫秒）或未采集的原因，按取样顺序，恰好 `PERF.samples` 个。 */
async function collectTurnWindows(
  page: Page,
  perf: PerfRecorder,
  plan: PagedPlan,
  anim: PageAnim,
): Promise<(number | string)[]> {
  const label = pageModeSpec(anim).label;
  const outcomes: (number | string)[] = [];
  const fill = (reason: string): void => {
    while (outcomes.length < PERF.samples) outcomes.push(reason);
  };

  const switched = await attempt(`(f) 切到“${label}”模式`, () => ensurePageMode(page, anim));
  if (switched !== null) {
    fill(`未能切到“${label}”模式：${switched}`);
    return outcomes;
  }
  for (let round = 1; round <= PERF.samples; round++) {
    const short = perf.shortOfTime();
    if (short !== null) {
      fill(short);
      break;
    }
    const notReady = await attempt(
      `(f) ${label}第 ${round} 次之前：设置抽屉关闭、回到第 L 章第 1 页、相邻章已分页、控制栏隐藏`,
      () => prepareTurnWindow(page, plan),
    );
    if (notReady !== null) {
      fill(`复位失败：${notReady}`);
      break;
    }
    outcomes.push(
      await measureOnce(`(f) ${label}第 ${round} 次：拖拽一页并释放、再点 MR ${PAGED_TAPS} 次期间的最长长任务`, () =>
        sampleTurnWindow(page, plan),
      ),
    );
  }
  return outcomes;
}

/** (f) 第 k 次读数 = 各模式第 k 个窗口的较大者；任一模式未采集时该次未采集，原因按模式注明。 */
function combineTurnWindows(series: PerfSeries, windows: ReadonlyMap<PageAnim, readonly (number | string)[]>): void {
  for (let i = 0; i < PERF.samples; i++) {
    const parts = TURN_MODES.map((anim) => ({ anim, outcome: windows.get(anim)?.[i] ?? "未取样" }));
    const readings = parts.flatMap((p) => (typeof p.outcome === "number" ? [p.outcome] : []));
    if (readings.length === parts.length) {
      series.push(Math.max(...readings));
    } else {
      series.miss(
        parts
          .filter((p) => typeof p.outcome === "string")
          .map((p) => `${pageModeSpec(p.anim).label}：${String(p.outcome)}`)
          .join("；"),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// (h) 跨章翻页提交到新相邻章分页完成
// ---------------------------------------------------------------------------

/** (h) 的章节：L 之后两个正文章节都在。 */
type NeighborPlan = PagedPlan & { next: number; afterNext: number };

/** 页内的提交时刻记录（`window[COMMIT_WATCH_KEY]`）。 */
interface CommitWatch {
  /** 首次观察到提交时的 `performance.now()`；尚未观察到时为 null。 */
  time: number | null;
  disconnect: () => void;
}

type CommitWatchArgs = { key: string; chapterId: number };
type CommitWatchOutcome = { ok: true; time: number } | { ok: false; reason: string };

/**
 * 页内执行（自包含）：在 `<main>` 上挂 `MutationObserver`，在首次满足"`data-turning="false"` 且当前页
 * 图层的 `data-chapter-id` 为 `chapterId`"的那次 DOM 变更回调里记下 `performance.now()` 并断开。
 * 上一次留下的观察先断开。挂上时条件已成立返回 false（不挂）。
 */
function armCommitWatchInPage(main: HTMLElement | SVGElement, a: CommitWatchArgs): boolean {
  const w = window as unknown as Record<string, CommitWatch | undefined>;
  const previous = w[a.key];
  if (previous !== undefined) previous.disconnect();
  const id = String(a.chapterId);
  const committed = (): boolean => {
    if (main.getAttribute("data-turning") !== "false") return false;
    const el = main.querySelector('[data-current="true"][data-page-index]');
    return el !== null && el.getAttribute("data-chapter-id") === id;
  };
  if (committed()) return false;
  const record: CommitWatch = { time: null, disconnect: () => {} };
  const observer = new MutationObserver(() => {
    if (record.time !== null || !committed()) return;
    record.time = performance.now();
    observer.disconnect();
  });
  record.disconnect = () => observer.disconnect();
  observer.observe(main, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["data-turning", "data-current", "data-chapter-id"],
  });
  w[a.key] = record;
  return true;
}

/** 页内执行（自包含）：取出提交时刻并断开观察。 */
function readCommitWatchInPage(a: { key: string }): CommitWatchOutcome {
  const w = window as unknown as Record<string, CommitWatch | undefined>;
  const record = w[a.key];
  if (record === undefined) return { ok: false, reason: "页面里没有提交观察的记录（未挂上，或页面已导航 / 重载）" };
  record.disconnect();
  if (record.time === null) return { ok: false, reason: "没有观察到跨章翻页的提交" };
  return { ok: true, time: record.time };
}

/** (h) 的终止条件参数。 */
interface NeighborTarget {
  main: ElementHandle<HTMLElement | SVGElement>;
  /** L₁：跨章之后的当前章。 */
  chapterId: number;
  /** L₂：跨章之后新的相邻章。 */
  neighborId: number;
}

/** (h)：翻页已落定、当前页属于 L₁，且 `data-paginated` 含 L₂。 */
const neighborPaginated: MeasurePredicate<InPage<NeighborTarget>> = ({ main, chapterId, neighborId }) => {
  if (!main.isConnected || main.getAttribute("data-turning") !== "false") return false;
  const el = main.querySelector('[data-current="true"][data-page-index]');
  if (el === null || el.getAttribute("data-chapter-id") !== String(chapterId)) return false;
  return (main.getAttribute("data-paginated") ?? "").split(",").includes(String(neighborId));
};

/** (h) 每次取样的起始状态（见文件头"复位"）；整页重开由调用方先做。 */
async function prepareNeighborSample(page: Page, plan: NeighborPlan): Promise<void> {
  await expectPaginated(page, plan.settled, [plan.afterNext]);
  await pressEdge(page, plan.chapter, "End");
  await expectPaginated(page, plan.settled, [plan.afterNext]);
}

/** (h) 一次：在第 L 章末页按 `→` 跨章，提交到 `data-paginated` 出现 L₂ 的那一帧（毫秒）。 */
async function sampleNeighborPaginate(page: Page, plan: NeighborPlan): Promise<number> {
  const main = await reader(page).main.elementHandle();
  try {
    const armed = await main.evaluate(armCommitWatchInPage, { key: COMMIT_WATCH_KEY, chapterId: plan.next });
    if (!armed) throw new Error(`跨章之前当前页已在下标 ${plan.next} 的章节`);
    const target: NeighborTarget = { main, chapterId: plan.next, neighborId: plan.afterNext };
    const end = await untilAfter(waitFrame(page, neighborPaginated, target), () =>
      page.keyboard.press(NEIGHBOR_TURN_KEY),
    );
    if (end === null) {
      throw new Error(
        `按 ${NEIGHBOR_TURN_KEY} 跨章后 ${TIMEOUTS.wait} ms 内 data-paginated 没有出现下标 ${plan.afterNext}（${await describePaged(page)}）`,
      );
    }
    const commit = await page.evaluate(readCommitWatchInPage, { key: COMMIT_WATCH_KEY });
    if (!commit.ok) throw new Error(commit.reason);
    const reading = end - commit.time;
    if (reading < 0) throw new Error(`终点早于提交时刻（早 ${(-reading).toFixed(1)} ms）`);
    return reading;
  } finally {
    await main.dispose().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// (g) 重新分页
// ---------------------------------------------------------------------------

/** (g) 的终止条件参数。 */
interface OffsetTarget {
  main: ElementHandle<HTMLElement | SVGElement>;
  chapterId: number;
  /** P：原位置（章内偏移）。 */
  offset: number;
  /** 正文应有的计算字号，如 `"20px"`。 */
  fontSize: string;
}

/**
 * (g)：翻页已落定；`data-paginated` 含当前章；当前页属于 `chapterId` 章，`data-page-start ≤ offset <`
 * 最后一个正文片段的末尾（`data-offset` 加文字长度），且该片段的计算字号为 `fontSize`。
 * 理由见文件头 (g)：包含、`layoutKey` 已更新两条。
 */
const pageHoldsOffset: MeasurePredicate<InPage<OffsetTarget>> = ({ main, chapterId, offset, fontSize }) => {
  if (!main.isConnected || main.getAttribute("data-turning") !== "false") return false;
  const id = String(chapterId);
  if (!(main.getAttribute("data-paginated") ?? "").split(",").includes(id)) return false;
  const el = main.querySelector('[data-current="true"][data-page-index]');
  if (el === null || el.getAttribute("data-chapter-id") !== id) return false;
  const fragments = el.querySelectorAll("p[data-offset]");
  if (fragments.length === 0) return false;
  const last = fragments[fragments.length - 1];
  if (getComputedStyle(last).fontSize !== fontSize) return false;
  const start = Number(el.getAttribute("data-page-start"));
  const end = Number(last.getAttribute("data-offset")) + (last.textContent ?? "").length;
  return start <= offset && offset < end;
};

/** (g) 一次性准备的结果（见文件头"复位"）。 */
interface RepaginateSetup {
  main: ElementHandle<HTMLElement | SVGElement>;
  chapter: number;
  /** `PagedPlan.settled`：L 与它前后的正文章节。 */
  settled: readonly number[];
  /** P：翻到的那一页的页首偏移，即此后的阅读位置。 */
  offset: number;
  /** 字号滑杆的原值与移动一档后的值。 */
  original: number;
  changed: number;
  /** 移动一档的键与还原的键。 */
  forwardKey: "ArrowRight" | "ArrowLeft";
  backKey: "ArrowRight" | "ArrowLeft";
}

/** (g) 的一次性准备：翻到第 L 章中间一页，记下 P，打开设置抽屉，读字号滑杆。 */
async function setupRepaginate(page: Page, plan: PagedPlan): Promise<RepaginateSetup> {
  await pressEdge(page, plan.chapter, "Home");
  await expectPaginated(page, plan.settled);
  await hideControls(page);

  const main = await reader(page).main.elementHandle();
  try {
    const first = await currentPageIn(page, plan.chapter);
    const middle = Math.floor(first.pageCount / 2);
    for (let index = first.pageIndex; index < middle; index++) {
      await tapToNextPage(page, main, plan.chapter, index);
    }
    const current = await currentPageIn(page, plan.chapter);
    if (current.pageIndex !== middle) {
      throw new Error(`应停在本章第 ${middle + 1} 页，实际第 ${current.pageIndex + 1} 页`);
    }

    const drawer = settingsDrawer(page);
    await page.keyboard.press("s");
    await expect(drawer.marker, "按 S 应打开设置抽屉").toBeVisible();
    const slider = drawer.fontSizeSlider;
    await expect(slider, "设置抽屉里应有字号滑杆").toBeVisible();
    const [value, stepAttr, maxAttr] = await Promise.all([
      slider.inputValue(),
      slider.getAttribute("step"),
      slider.getAttribute("max"),
    ]);
    const original = Number(value);
    const stepSize = Number(stepAttr);
    const max = Number(maxAttr);
    if (![original, stepSize, max].every(Number.isFinite) || stepSize <= 0) {
      throw new Error(`字号滑杆的取值无效：value ${value}、step ${stepAttr}、max ${maxAttr}`);
    }
    const up = original + stepSize <= max;
    return {
      main,
      chapter: plan.chapter,
      settled: plan.settled,
      offset: current.pageStart,
      original,
      changed: up ? original + stepSize : original - stepSize,
      forwardKey: up ? "ArrowRight" : "ArrowLeft",
      backKey: up ? "ArrowLeft" : "ArrowRight",
    };
  } catch (error) {
    await main.dispose().catch(() => undefined);
    throw error;
  }
}

function offsetTarget(s: RepaginateSetup, fontSize: number): OffsetTarget {
  return { main: s.main, chapterId: s.chapter, offset: s.offset, fontSize: `${fontSize}px` };
}

/**
 * (g) 的起始状态（14.7）：设置抽屉打开，字号滑杆为原值，当前页包含 P 且正文为原字号，相邻章后台
 * 分页已完成。字号改回之前也先等相邻章分页完成：每次改字号都只让当前章同步重分页，不与上一次
 * 留下的后台分页交叠（见文件头"复位"）。
 */
async function resetRepaginate(page: Page, s: RepaginateSetup): Promise<void> {
  const drawer = settingsDrawer(page);
  await expect(drawer.marker, "设置抽屉应保持打开").toBeVisible();
  const slider = drawer.fontSizeSlider;
  if (Number(await slider.inputValue()) !== s.original) {
    await expectPaginated(page, s.settled);
    await slider.press(s.backKey);
  }
  await expect(slider, `字号滑杆应回到原值 ${s.original}`).toHaveValue(String(s.original));
  const at = await waitFrame(page, pageHoldsOffset, offsetTarget(s, s.original));
  if (at === null) {
    throw new Error(
      `字号回到 ${s.original} 后 ${TIMEOUTS.wait} ms 内当前页不包含原位置 ${s.offset}（${await describePaged(page)}）`,
    );
  }
  await expectPaginated(page, s.settled);
}

/** (g) 一次：字号滑杆移动一档到显示包含 P 的新页（毫秒）。 */
async function sampleRepaginate(page: Page, s: RepaginateSetup): Promise<number> {
  const slider = settingsDrawer(page).fontSizeSlider;
  await armStart(slider, "input", "first");
  const end = await untilAfter(waitFrame(page, pageHoldsOffset, offsetTarget(s, s.changed)), () =>
    slider.press(s.forwardKey),
  );
  if (end === null) {
    throw new Error(
      `字号滑杆移到 ${s.changed} 后 ${TIMEOUTS.wait} ms 内没有显示包含原位置 ${s.offset} 的页（${await describePaged(page)}）`,
    );
  }
  const reading = end - (await readStart(page));
  if (reading < 0) throw new Error(`终点早于输入事件（早 ${(-reading).toFixed(1)} ms）`);
  return reading;
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
    const query = lib.fixtureRoles().pinyin.abbr;
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
        `(c) 第 ${round} 次：逐字键入 ${query}，末次按键到书卡更新为含《${title}》的结果`,
        () => sampleShelfSearch(page, target, query),
      );
    }
  });

  test("perf-reader-search", async ({ page, lib, bookLog, perf }) => {
    const readerSearch = perf.series("readerSearchLongTask");
    const book = await bookUnderTest(lib, lib.role("longText"));
    const { chapterIndex } = lib.fixtureRoles().longText;

    const derived = await step(
      `取关键词：下标 ${chapterIndex} 的节点自中点起第一处 ${READER_KEYWORD_CHARS} 个连续汉字，全书至少命中 1 处`,
      () => deriveReaderKeyword(lib, book.id, chapterIndex),
    );
    if (!derived.ok) {
      readerSearch.missRest(derived.reason);
      return;
    }
    const { keyword } = derived;

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

  test("perf-paged-turn", async ({ page, context, lib, bookLog, perf }) => {
    const pagedTurn = perf.series("pagedTurnLongTask");
    const neighbor = perf.series("neighborPaginate");
    const both = [pagedTurn, neighbor];

    const planned = await step("取第 L 章：书库中最长的正文章节，及其后两个正文章节 L₁、L₂", () =>
      derivePagedPlan(lib),
    );
    if (!planned.ok) {
      for (const s of both) s.missRest(planned.reason);
      return;
    }
    const { plan } = planned;

    // 项目级的 prefers-reduced-motion: reduce（6.3）会让覆盖与仿真按无动画翻页（翻页模式需求 9.3），
    // 14.1 要测的是动画与拖拽期间，所以本用例的页面取消这一模拟
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await seedPageMode(context, TURN_MODES[0]);
    const failed = await openPagedBook(page, bookLog, plan.book, plan.chapter);
    if (failed !== null) {
      for (const s of both) s.missRest(failed);
      return;
    }

    // (f)：先取完一种模式的 5 个窗口再切下一种，每次读数取两种模式同序窗口的较大者
    const windows = new Map<PageAnim, (number | string)[]>();
    for (const anim of TURN_MODES) windows.set(anim, await collectTurnWindows(page, perf, plan, anim));
    combineTurnWindows(pagedTurn, windows);

    // (h)
    const { next, afterNext } = plan;
    if (next === null || afterNext === null) {
      neighbor.missRest(`第 L 章（下标 ${plan.chapter}）之后不足两个正文章节，没有跨章后新的相邻章`);
      return;
    }
    const neighborPlan: NeighborPlan = { ...plan, next, afterNext };
    for (let round = 1; round <= PERF.samples; round++) {
      if (outOfTime(perf, [neighbor])) break;
      const reopened = await openPagedBook(page, bookLog, plan.book, plan.chapter);
      if (reopened !== null) {
        neighbor.missRest(`复位失败：${reopened}`);
        break;
      }
      const notReady = await attempt(
        `(h) 第 ${round} 次之前：相邻章已分页、L₂（下标 ${afterNext}）尚未分页，按 End 到第 L 章末页`,
        () => prepareNeighborSample(page, neighborPlan),
      );
      if (notReady !== null) {
        neighbor.missRest(`复位失败：${notReady}`);
        break;
      }
      await takeSample(
        neighbor,
        `(h) 第 ${round} 次：按 ${NEIGHBOR_TURN_KEY} 跨章到下标 ${next}，提交到 data-paginated 出现下标 ${afterNext}`,
        () => sampleNeighborPaginate(page, neighborPlan),
      );
    }
  });

  test("perf-repaginate", async ({ page, context, lib, bookLog, perf }) => {
    const repaginate = perf.series("repaginate");

    const planned = await step("取第 L 章：书库中最长的正文章节", () => derivePagedPlan(lib));
    if (!planned.ok) {
      repaginate.missRest(planned.reason);
      return;
    }
    const { plan } = planned;

    await seedPageMode(context, PAGE_ANIM.cover);
    const failed = await openPagedBook(page, bookLog, plan.book, plan.chapter);
    if (failed !== null) {
      repaginate.missRest(failed);
      return;
    }

    const prepared = await step(
      "翻到第 L 章中间一页记下原位置 P，按 S 打开设置抽屉",
      async (): Promise<RepaginateSetup | string> => {
        try {
          return await setupRepaginate(page, plan);
        } catch (error) {
          return brief(error);
        }
      },
    );
    if (typeof prepared === "string") {
      repaginate.missRest(`准备失败：${prepared}`);
      return;
    }
    const setup = prepared;

    try {
      for (let round = 1; round <= PERF.samples; round++) {
        if (outOfTime(perf, [repaginate])) break;
        const notReady = await attempt(
          `第 ${round} 次之前：字号滑杆为原值 ${setup.original}、当前页包含原位置 ${setup.offset}`,
          () => resetRepaginate(page, setup),
        );
        if (notReady !== null) {
          repaginate.missRest(`复位失败：${notReady}`);
          break;
        }
        await takeSample(
          repaginate,
          `(g) 第 ${round} 次：字号滑杆 ${setup.original} → ${setup.changed}，到显示包含原位置 ${setup.offset} 的页`,
          () => sampleRepaginate(page, setup),
        );
      }
    } finally {
      await setup.main.dispose().catch(() => undefined);
    }
  });
});
