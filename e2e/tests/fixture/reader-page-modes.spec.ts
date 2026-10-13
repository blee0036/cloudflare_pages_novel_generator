/**
 * 阅读器：五种翻页模式的切换、持久化、九宫格点击、刷新续读、往返恒等与减弱动态效果（reader-page-turn-modes
 * 任务 23.1；需求 1.3–1.8、5.1–5.5、5.9、5.11、9.3、9.5–9.7、15.2；design §1.2、§3.1、§3.3、§5.4、§5.5、
 * §6.8、§9、§13.2）。`fixture` 项目（:4611，Opaque_Mode），桌面视口，默认主题（不 `seedTheme`）。
 *
 * ## 用例标题的前缀
 *
 * 不带前缀的条目号指 e2e-visual-testing 的需求，`RDF` 指 reader-defect-fixes；本文件（以及同一 spec 的
 * 其余新用例）以 `PTM`（Page-Turn Modes）前缀引用 reader-page-turn-modes 的需求条目，如 `PTM 1.7`。
 *
 * ## 五种模式各跑一遍
 *
 * design §13.2 写的是 `test.describe.each`；Playwright Test 没有这个 API，这里用
 * `for (const mode of PAGE_MODES) test.describe(…)` 达到同样效果：每种模式一个 describe，其中 6 个用例
 * 结构相同，只有模式不同。模式的编号、按钮文字与 `<main data-page-mode>` 取值取自
 * `e2e/support/reader.ts` 的 `PAGE_MODES`；需求 1.3 的按钮顺序在本文件按需求原文写成字面量另行核对。
 * 起始模式经 `seedPageMode`（首次导航前写入已存储的 `pageAnim`）设定。
 *
 * ## 动画：以 no-preference 运行（6.3 的例外）
 *
 * 全局的 `contextOptions: { reducedMotion: "reduce" }`（`playwright.config.ts`）会让覆盖、滑动、仿真三种
 * 模式都按无动画翻页（需求 9.3），五种模式就测不出差别。本文件顶层 `test.use({ contextOptions:
 * { reducedMotion: "no-preference" } })` 整体替换它，用例打开阅读器后先核对页面确为 `no-preference`；
 * 本文件不拍摄 Review_Shot 与 Pixel_Baseline。减弱动态效果的用例（9.x）在用例中途以
 * `page.emulateMedia({ reducedMotion })` 切换系统状态，不重新载入（需求 9.7）。
 *
 * ## 用书与章节（4.4：期望值运行时推导）
 *
 * 书为 `lib.role("longText")`，起始章节取 `roles.json` 的 `longText.chapterIndex`：该书的长章节（分页
 * 模式下页数 ≥ 2，打开后核对），须既非首个也非末个正文章节（不满足即为测试自身的问题，16.6）。相邻章
 * 取 `TocFacts.bodyIndices` 中的前一个 / 后一个，卷节点因此自然跳过。
 *
 * ## 读数
 *
 * - **分页模式**：当前页图层的 `data-chapter-id`、`data-page-index`、`data-page-count`、`data-page-start`
 *   （`readPagedView`）。"翻到某页"以轮询等到 `<main data-turning="false">` 且当前页即目标页。"上一页 /
 *   下一页"按页表推导：本章内为页序 ± 1，在章首 / 章末时为相邻正文章节的末页 / 第 1 页（需求 3.1、3.2）。
 * - **滚动模式**：以起始章节区段（`section[data-chapter-id]`）的视口上边作为正文位置的读数。窗口挂卸
 *   章节时的锚点补偿会平移 `scrollTop`，但不移动画面（需求 10.3），区段上边因此只随读者的滚动变化。
 *   NEXT 翻页后上边上移、PREV 后下移，位移至少半个可视高度（保留一行的步长另由
 *   `reader-shortcuts.spec.ts` 的 10.11 核对）。翻页滚动有 300 ms 基准的动画，等区段上边与 `scrollTop`
 *   连续 3 帧不变再读（`waitScrollTurnSettled`）。
 * - **阅读位置**（Reading_Position）：分页模式翻页后为新页的页首偏移（需求 2.7），滚动模式为判定线处
 *   段落的章内偏移（需求 10.6）。两者都以进度记录（localStorage `koodo_novel_progress_<id>`）核对：
 *   位置停止变化 1 s 后落盘（需求 12.6），以轮询等到记录为期望值。滚动模式的期望段落范围由
 *   `readParagraphStarts`（测试进程解压的全书文本与渲染出的 `<p>` 依次对齐）独立推导。
 *
 * ## 各用例
 *
 * - `PTM 1.3–1.6 切换`：起始模式为另一渲染族（目标为滚动时从覆盖起，否则从滚动起），先移动到章中某处，
 *   再按 `S` 打开设置抽屉：选项组"翻页模式"的 5 个按钮依次为覆盖、滑动、仿真、滚动、无动画（1.3），
 *   起始模式 `aria-pressed="true"`；点目标模式后 `selectPageMode` 核对 5 个按钮的 `aria-pressed`（1.4）、
 *   `<main data-page-mode>` 与 localStorage 的 `pageAnim`（1.5）。新模式以切换前的位置 o 定位（1.6）：
 *   分页模式显示包含 o 的页（`data-page-start ≤ o`，再按一次 `PageDown`，下一页页首 > o 或已入下一章）；
 *   滚动模式下判定段落即 o 所在段落。最后核对底栏换章按钮：名称恒为"上一章""下一章"，`title` 在滚动
 *   模式附按键"(←)""(→)"，分页模式不附（分页模式的 `←`/`→` 是翻页，没有换章键）。
 * - `PTM 5.1–5.3 5.5 5.11 八区翻页`：先点 MC 隐藏控制栏（页面刚加载完成时可见），再按 TR、TL、MR、TC、
 *   BC、ML、BR、BL 的顺序点各区中心（前翻、回翻交替，始终停在起始章节附近），每次核对翻页方向与目标、
 *   控制栏仍隐藏（翻页不动控制栏，5.11）。坐标以 `<main>` 的矩形为参照（`tapZoneCenter`，5.1）。
 * - `PTM 5.4 5.9 控制栏`：装 Controlled_Clock（6.4），书加载完成后暂停。控制栏可见时依次点 8 个翻页区，
 *   每次控制栏变为隐藏，推进 600 ms（长于最长的 Tap 翻页时长：仿真 NEXT 为 570 ms）后正文位置不变、
 *   分页模式 `data-turning` 不为 `"true"`（5.9），再点 MC 唤出（5.4）；最后控制栏可见时点 MC 同样只
 *   隐藏，隐藏时点 MC 唤出后推进 4,499 ms 仍可见、再推进 1 ms 即隐藏（4.5 s 自动隐藏）。时钟暂停期间
 *   rAF 与定时器都不走，所以"不翻页"不会因读得太早而恒真：任何翻页都会在推进的 600 ms 里显出来。
 *   顶栏、底栏的滑入滑出是 CSS 过渡，不受时钟控制，`readControlsVisible` 等过渡结束再读。
 * - `PTM 1.8 刷新`：移动到章中某处（分页模式 `PageDown` 一页，滚动模式把判定段落滚到第 k 段），等进度
 *   记录为该位置后 `page.reload()`；核对 `<main data-page-mode>`、localStorage 的 `pageAnim` 与设置
 *   抽屉的 `aria-pressed` 仍为该模式，位置仍为刷新前的阅读位置（分页：同一章同一页、`data-page-start`
 *   相同；滚动：同一章、判定段落仍为第 k 段）。
 * - `PTM 1.6 1.7 往返`：分页模式先 `PageDown` 一页，切到滚动（判定段落为该页页首所在段落，1.6），未做
 *   任何移动切回原模式，当前页的章、页序与 `data-page-start` 都不变（1.7）。滚动模式改为滚动 → 覆盖 →
 *   滚动：中途的覆盖模式显示包含该位置的页，切回后判定段落不变。
 * - `PTM 9.5 9.6 提示`：`emulateMedia({ reducedMotion: "reduce" })` 后打开设置抽屉：所选模式仍
 *   `aria-pressed="true"`、localStorage 的 `pageAnim` 与 `<main data-page-mode>` 不变（9.5）；覆盖、
 *   滑动、仿真在选项组下显示"系统已开启减弱动态效果，翻页不播放动画"并作为选项组的可访问描述，滚动与
 *   无动画不显示（9.6）。抽屉开着时切回 `no-preference`，提示随即消失。
 * - `PTM 9.3 9.7`（单独一个 describe，覆盖模式）：`reduce` 下 Tap 与按键翻页各一次，`<main>` 的
 *   `data-turning` 始终不为 `"true"`（以 MutationObserver 记下翻页期间该属性的全部取值，包括两次读数之间
 *   一闪而过的值），页面照常翻到下一页；设置抽屉出现提示；切回 `no-preference` 后下一次 Tap 翻页的
 *   取值序列里出现 `"true"`（恢复动画，无需刷新），最后回到 `"false"`。
 *
 * 所选章节与读数记在注解 `page-mode-plan`、`page-mode-reading` 里。
 */
import type { BrowserContext, Page } from "@playwright/test";
import type { ReadingProgress } from "../../../src/types";
import { PAGE_ANIM } from "../../../src/utils/pageAnim";
import type { TapZone } from "../../../src/utils/tapZone";
import { PROGRESS_KEY_PREFIX, expect, test, type BookLog, type Lib } from "../../support/fixtures";
import type { TocFacts } from "../../support/library";
import { reader, settingsDrawer } from "../../support/locators";
import {
  PAGE_MODES,
  TAP_ZONES,
  TAP_ZONE_ACTIONS,
  bookUnderTest,
  expectCurrentChapter,
  expectOffsetInParagraph,
  judgeScrollTarget,
  openReader,
  pageModeButton,
  pageModeSpec,
  paragraphRange,
  readControlsVisible,
  readCurrentRegion,
  readJudgeParagraph,
  readPagedView,
  readParagraphStarts,
  readStoredPageAnim,
  scrollJudgeParagraphTo,
  seedPageMode,
  selectPageMode,
  tapZoneCenter,
  waitFrames,
  waitPageTurnSettled,
  type BookUnderTest,
  type CurrentPage,
  type JudgeReading,
  type PageModeSpec,
  type PagedViewReading,
  type ParagraphStarts,
} from "../../support/reader";
import { TIMEOUTS } from "../../support/settings";
import { step } from "../../support/step";

// ---------------------------------------------------------------------------
// 常量（取自需求条文）
// ---------------------------------------------------------------------------

/** 需求 1.3：设置抽屉"翻页模式"选项组的标题与按钮顺序（按需求原文写成字面量）。 */
const MODE_GROUP_NAME = "翻页模式";
const MODE_LABELS: readonly string[] = ["覆盖", "滑动", "仿真", "滚动", "无动画"];

/** 需求 9.6 的提示文字。 */
const REDUCED_MOTION_HINT = "系统已开启减弱动态效果，翻页不播放动画";

/** 需求 5.4 / Glossary Control_Bars：唤出后自动隐藏的时长。 */
const CONTROLS_AUTO_HIDE_MS = 4_500;

/**
 * 5.9 的观察窗口：控制栏可见时点正文后推进这么久，正文位置仍不变。长于最长的 Tap 翻页时长
 * （仿真 NEXT 的 Turn_Duration 为 300 × 1.9 = 570 ms，design §6.2、任务 5.5 的例子）。
 */
const TURN_WINDOW_MS = 600;

/** 书加载完成后暂停 Controlled_Clock 时向前跳的余量（与 `reader-progress.spec.ts` 相同）。 */
const PAUSE_LEAD_MS = 1_000;

/** 滚动模式的一次翻页滚动至少移动可视高度的这个比例（保留一行时约为一屏减一行）。 */
const SCROLL_TURN_MIN_RATIO = 0.5;

/** 滚动停稳：区段上边与 `scrollTop` 连续这么多个动画帧不变。 */
const SETTLE_FRAMES = 3;

/** 点击后这么多帧内正文一点没动，就不再等动画（交给随后的断言报错）。 */
const MOVE_WAIT_FRAMES = 30;

/** 正文位置"不变"的容差（px，亚像素取整）。 */
const STILL_PX = 1;

/**
 * 八区翻页的点击顺序：前翻、回翻交替（TR、TL、MR、TC、BC、ML、BR、BL），每次回翻都回到前一次前翻的
 * 出发页，正文始终停在起始章节附近。8 区恰好各出现一次。
 */
const TURN_ORDER: readonly TapZone[] = ["TR", "TL", "MR", "TC", "BC", "ML", "BR", "BL"];

/** 8 个翻页区（TAP_ZONES 去掉 MC），按 TAP_ZONES 的顺序。 */
const TURN_ZONES: readonly TapZone[] = TAP_ZONES.filter((zone) => TAP_ZONE_ACTIONS[zone] !== "menu");

// 整个文件以 no-preference 运行（见文件头"动画"）
test.use({ contextOptions: { reducedMotion: "no-preference" } });

// ---------------------------------------------------------------------------
// 用书与章节
// ---------------------------------------------------------------------------

interface ModePlan {
  book: BookUnderTest;
  /** 起始章节（`longText.chapterIndex`）的下标。 */
  chapter: number;
}

async function modePlan(lib: Lib): Promise<ModePlan> {
  const id = lib.role("longText");
  const book = await bookUnderTest(lib, id);
  return step("选定起始章节（roles.json longText.chapterIndex，既非首也非末的正文章节）", () => {
    const { facts } = book;
    const chapter = lib.fixtureRoles().longText.chapterIndex;
    const ordinal = facts.bodyOrdinals[chapter];
    if (ordinal === null || ordinal === undefined) {
      throw new Error(`${id}：longText.chapterIndex（下标 ${chapter}）不是正文章节`);
    }
    if (facts.bodyIndices[ordinal - 1] === undefined || facts.bodyIndices[ordinal + 1] === undefined) {
      throw new Error(
        `${id}：起始章节（下标 ${chapter}，正文第 ${ordinal + 1} / ${facts.bodyCount} 章）须既非首个也非末个正文章节`,
      );
    }
    test.info().annotations.push({
      type: "page-mode-plan",
      description: `书 ${id}；起始章节 下标 ${chapter}「${facts.titles[chapter]}」`,
    });
    return { book, chapter };
  });
}

function note(description: string): void {
  test.info().annotations.push({ type: "page-mode-reading", description });
}

/** 起始模式：目标为滚动时从覆盖起，否则从滚动起（跨渲染族切换，需求 1.6）。 */
function otherFamilyMode(mode: PageModeSpec): PageModeSpec {
  return pageModeSpec(mode.family === "scroll" ? PAGE_ANIM.cover : PAGE_ANIM.scroll);
}

// ---------------------------------------------------------------------------
// 打开阅读器
// ---------------------------------------------------------------------------

/**
 * 以 `mode` 打开起始章节：首次导航前 `seedPageMode`，打开 `?ch=<起始章节>`，核对当前章节、
 * `<main data-page-mode>` 与页面为 `no-preference`。分页模式另等当前页就位，核对它是本章第 1 页、
 * 本章页数 ≥ 2，并返回它；滚动模式返回 null。装 Controlled_Clock 的用例须在此之前 `clock.install()`。
 */
async function openInMode(
  page: Page,
  context: BrowserContext,
  bookLog: BookLog,
  plan: ModePlan,
  mode: PageModeSpec,
): Promise<CurrentPage | null> {
  await seedPageMode(context, mode.anim);
  await openReader(page, bookLog, plan.book, plan.chapter);
  await expectCurrentChapter(page, plan.book.facts, plan.chapter);
  await step(`前提：<main data-page-mode="${mode.attr}">，页面为 prefers-reduced-motion: no-preference`, async () => {
    await expect(reader(page).main, "<main> 的 data-page-mode").toHaveAttribute("data-page-mode", mode.attr);
    const noPreference = await page.evaluate(() => window.matchMedia("(prefers-reduced-motion: no-preference)").matches);
    expect(noPreference, "matchMedia('(prefers-reduced-motion: no-preference)').matches").toBe(true);
  });
  if (mode.family === "scroll") return null;
  const current = await waitPageTurnSettled(page);
  await step("前提：当前页为起始章节第 1 页，本章页数 ≥ 2", () => {
    note(`打开后当前页：${JSON.stringify(current)}`);
    expect(current.chapterId, "当前页的 data-chapter-id").toBe(plan.chapter);
    expect(current.pageIndex, "当前页的 data-page-index").toBe(0);
    expect(current.pageCount, "起始章节的页数（data-page-count）").toBeGreaterThanOrEqual(2);
  });
  return current;
}

/** 页面刚加载完成时控制栏可见（且不会自动隐藏）：点 MC 把它隐藏（需求 5.9）。 */
async function hideControls(page: Page): Promise<void> {
  await step("控制栏可见（页面刚加载完成）：点 MC 把它隐藏（需求 5.9）", async () => {
    expect(await readControlsVisible(page), "页面刚加载完成时控制栏应可见").toBe(true);
    await tapZoneCenter(page, "MC");
    await expect.poll(() => readControlsVisible(page), { message: "点 MC 后控制栏应隐藏" }).toBe(false);
  });
}

/** 书加载完成后暂停 Controlled_Clock，此后时间只经 `page.clock.runFor` 推进。 */
async function pauseClock(page: Page): Promise<void> {
  await step("暂停 Controlled_Clock（此后只经 runFor 推进）", async () => {
    const now = await page.evaluate(() => Date.now());
    await page.clock.pauseAt(now + PAUSE_LEAD_MS);
  });
}

async function advanceClock(page: Page, ms: number, what: string): Promise<void> {
  await step(`Controlled_Clock 推进 ${ms} ms（${what}）`, () => page.clock.runFor(ms));
}

/** `page.reload()`，等本次导航的 `[book-load]` 行与当前章 / 当前页区域出现。 */
async function reloadReader(page: Page, bookLog: BookLog, book: BookUnderTest): Promise<void> {
  await step("刷新页面（page.reload），等正文加载完成", async () => {
    const since = bookLog.count;
    await page.reload();
    await bookLog.waitFor(book.id, undefined, { since, timeout: book.loadTimeout });
    await expect
      .poll(() => readCurrentRegion(page), { message: "刷新后应出现当前章 / 当前页区域（data-current）" })
      .not.toBeNull();
  });
}

// ---------------------------------------------------------------------------
// 分页模式：相邻页与翻页
// ---------------------------------------------------------------------------

/** 期望的当前页：章号与页序（`"last"` 为该章末页）。 */
interface PageTarget {
  chapterId: number;
  pageIndex: number | "last";
}

function describeTarget(target: PageTarget): string {
  const index = target.pageIndex === "last" ? "末页" : `第 ${target.pageIndex + 1} 页（data-page-index ${target.pageIndex}）`;
  return `下标 ${target.chapterId} 的${index}`;
}

/** `from` 的上一页 / 下一页：本章内为页序 ± 1，章首 / 章末为相邻正文章节的末页 / 第 1 页（需求 3.1–3.3）。 */
function neighborPage(facts: TocFacts, from: CurrentPage, direction: "prev" | "next"): PageTarget {
  if (direction === "next" && from.pageIndex < from.pageCount - 1) {
    return { chapterId: from.chapterId, pageIndex: from.pageIndex + 1 };
  }
  if (direction === "prev" && from.pageIndex > 0) {
    return { chapterId: from.chapterId, pageIndex: from.pageIndex - 1 };
  }
  const ordinal = facts.bodyOrdinals[from.chapterId];
  const chapterId = ordinal === null || ordinal === undefined ? undefined : facts.bodyIndices[ordinal + (direction === "next" ? 1 : -1)];
  if (chapterId === undefined) throw new Error(`下标 ${from.chapterId} 没有${direction === "next" ? "下" : "上"}一个正文章节`);
  return { chapterId, pageIndex: direction === "next" ? 0 : "last" };
}

/** 轮询等到翻页落定且当前页为 `target`，返回当前页。 */
async function expectPagedAt(page: Page, target: PageTarget, what: string): Promise<CurrentPage> {
  let last: PagedViewReading | null = null;
  await expect
    .poll(
      async () => {
        last = await readPagedView(page);
        const current = last.current;
        if (last.turning !== false || current === null) return false;
        const index = target.pageIndex === "last" ? current.pageCount - 1 : target.pageIndex;
        return current.chapterId === target.chapterId && current.pageIndex === index;
      },
      { message: `${what}：翻页应落定（data-turning="false"），当前页为${describeTarget(target)}` },
    )
    .toBe(true);
  const reading = last as PagedViewReading | null;
  if (reading === null || reading.current === null) throw new Error(`${what}：读不到当前页`);
  return reading.current;
}

/** 按 `PageDown`：分页模式下 NEXT 翻页（需求 11.1），等落到下一页。 */
async function pageDown(page: Page, facts: TocFacts, from: CurrentPage): Promise<CurrentPage> {
  return step("按 PageDown（分页模式下 NEXT 翻页，需求 11.1），等落到下一页", async () => {
    await page.keyboard.press("PageDown");
    const at = await expectPagedAt(page, neighborPage(facts, from, "next"), "按 PageDown 之后");
    note(`PageDown 之后当前页：${JSON.stringify(at)}`);
    return at;
  });
}

function samePage(a: CurrentPage, b: CurrentPage): boolean {
  return a.chapterId === b.chapterId && a.pageIndex === b.pageIndex && a.pageStart === b.pageStart;
}

// ---------------------------------------------------------------------------
// data-turning 的取值记录（9.3、9.7）
// ---------------------------------------------------------------------------

/** 页面上保存 MutationObserver 记录的属性名。 */
const TURNING_RECORDER = "__e2ePageModesTurning";

/**
 * 开始记录 `<main>` 的 `data-turning`：MutationObserver 以 `attributeOldValue` 记下每次改动前的值，
 * `takeTurningRecord` 再补上此刻的值，得到这段时间里该属性依次取过的全部值（即使某个值只在两次
 * 读数之间存在过）。`<main>` 须在记录期间不被替换（分页族内不重挂视图）。
 */
async function startTurningRecord(page: Page): Promise<void> {
  await reader(page).main.evaluate((main, key) => {
    const w = window as unknown as Record<string, unknown>;
    const old: (string | null)[] = [];
    const observer = new MutationObserver((records) => {
      for (const r of records) old.push(r.oldValue);
    });
    observer.observe(main, { attributes: true, attributeFilter: ["data-turning"], attributeOldValue: true });
    w[key] = { observer, old, main };
  }, TURNING_RECORDER);
}

/** 结束记录，返回 `data-turning` 依次取过的值（首项为开始记录时的值，末项为此刻的值）。 */
function takeTurningRecord(page: Page): Promise<(string | null)[]> {
  return page.evaluate((key) => {
    const w = window as unknown as Record<string, unknown>;
    const rec = w[key] as { observer: MutationObserver; old: (string | null)[]; main: Element } | undefined;
    if (rec === undefined) throw new Error("没有进行中的 data-turning 记录（须先 startTurningRecord）");
    for (const r of rec.observer.takeRecords()) rec.old.push(r.oldValue);
    rec.observer.disconnect();
    delete w[key];
    return [...rec.old, rec.main.getAttribute("data-turning")];
  }, TURNING_RECORDER);
}

// ---------------------------------------------------------------------------
// 滚动模式：正文位置
// ---------------------------------------------------------------------------

/** 滚动模式下正文位置的一次读数。 */
interface ScrollMark {
  scrollTop: number;
  /** 起始章节区段的上边相对 `<main>` 上边的距离（px，视口坐标之差）。 */
  sectionTop: number;
  clientHeight: number;
}

/** 读起始章节区段的位置（测量）。区段不在窗口里时抛错。 */
function readScrollMark(page: Page, chapterId: number): Promise<ScrollMark> {
  return reader(page).main.evaluate((main, id) => {
    const section = main.querySelector(`section[data-chapter-id="${id}"]`);
    if (section === null) throw new Error(`下标 ${id} 的章节区段不在滚动窗口里`);
    return {
      scrollTop: main.scrollTop,
      sectionTop: section.getBoundingClientRect().top - main.getBoundingClientRect().top,
      clientHeight: main.clientHeight,
    };
  }, chapterId);
}

/**
 * 等一次翻页滚动停稳（真实时钟）：先等正文动起来（至多 `MOVE_WAIT_FRAMES` 帧；一直不动就直接返回，
 * 由调用方的断言报错），再等 `scrollTop` 与区段上边连续 `SETTLE_FRAMES` 帧不变。不能与 Controlled_Clock 同用。
 */
async function waitScrollTurnSettled(page: Page, chapterId: number): Promise<void> {
  await reader(page).main.evaluate(
    async (main, { id, stable, idle, timeoutMs }) => {
      const read = () => {
        const section = main.querySelector(`section[data-chapter-id="${id}"]`);
        return `${main.scrollTop}|${section === null ? "none" : section.getBoundingClientRect().top}`;
      };
      const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const first = read();
      const started = performance.now();
      let last = first;
      let same = 0;
      let moved = false;
      for (let frames = 1; ; frames++) {
        await frame();
        const now = read();
        if (now !== first) moved = true;
        same = now === last ? same + 1 : 0;
        last = now;
        if (moved && same >= stable) return;
        if (!moved && frames >= idle) return;
        if (performance.now() - started > timeoutMs) {
          throw new Error(`翻页滚动在 ${timeoutMs} ms（${frames} 帧）内未停稳`);
        }
      }
    },
    { id: chapterId, stable: SETTLE_FRAMES, idle: MOVE_WAIT_FRAMES, timeoutMs: TIMEOUTS.wait },
  );
}

/** 不超过段落数一半、且能滚到判定线的最大序号（与 `reader-progress.spec.ts` 相同）；没有时抛错。 */
function chooseK(reading: JudgeReading): number {
  for (let k = Math.floor(reading.count / 2); k >= 1; k--) {
    const target = judgeScrollTarget(reading, k);
    if (target >= 0 && target <= reading.maxScrollTop) return k;
  }
  throw new Error(`下标 ${reading.chapterId}：没有能滚到判定线的段落（共 ${reading.count} 段）`);
}

// ---------------------------------------------------------------------------
// 阅读位置（进度记录）
// ---------------------------------------------------------------------------

/** 进度记录（localStorage `koodo_novel_progress_<id>`）；不存在或不是 JSON 时为 null。 */
function readProgress(page: Page, bookId: string): Promise<Partial<ReadingProgress> | null> {
  return page.evaluate((key) => {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as Partial<ReadingProgress>;
    } catch {
      return null;
    }
  }, `${PROGRESS_KEY_PREFIX}${bookId}`);
}

/** 轮询等到进度记录满足 `accept`（落盘有 1 s 防抖，需求 12.6），返回其章内偏移。 */
async function waitProgress(
  page: Page,
  bookId: string,
  chapter: number,
  accept: (offset: number) => boolean,
  what: string,
): Promise<number> {
  return step(`等进度记录落盘：${what}`, async () => {
    let record: Partial<ReadingProgress> | null = null;
    await expect
      .poll(
        async () => {
          record = await readProgress(page, bookId);
          return record?.chapterId === chapter && typeof record.charOffset === "number" && accept(record.charOffset);
        },
        { message: `进度记录应为下标 ${chapter} 的${what}` },
      )
      .toBe(true);
    const saved = record as Partial<ReadingProgress> | null;
    note(`进度记录：${JSON.stringify(saved)}`);
    return saved?.charOffset as number;
  });
}

/** 滚动模式：把判定段落滚到第 k 段，等进度记录落在第 k 段内，返回 k、段落起点与记录的偏移。 */
async function scrollToJudgeK(
  page: Page,
  lib: Lib,
  plan: ModePlan,
): Promise<{ k: number; offset: number; paragraphs: ParagraphStarts }> {
  const k = chooseK(await readJudgeParagraph(page));
  await scrollJudgeParagraphTo(page, k);
  const paragraphs = await readParagraphStarts(page, lib, plan.book.id, plan.chapter);
  const { start, end } = paragraphRange(paragraphs, k);
  const offset = await waitProgress(
    page,
    plan.book.id,
    plan.chapter,
    (o) => o >= start && o < end,
    `第 ${k} 段内的偏移（[${start}, ${end})）`,
  );
  return { k, offset, paragraphs };
}

// ---------------------------------------------------------------------------
// 设置抽屉
// ---------------------------------------------------------------------------

/** 设置抽屉的"翻页模式"选项组（`role="group"`，名称取自可见标题，需求 1.3）。抽屉须已打开。 */
function modeGroup(page: Page) {
  return page.getByRole("group", { name: MODE_GROUP_NAME, exact: true });
}

/** 按 `S` 打开设置抽屉（不点顶栏按钮：顶栏可能已隐藏，按键也不启动自动隐藏计时）。 */
async function openSettings(page: Page): Promise<void> {
  await step("按 S 打开设置抽屉", async () => {
    await page.keyboard.press("s");
    await expect(settingsDrawer(page).marker, "按 S 应打开设置抽屉").toBeVisible();
  });
}

async function closeSettings(page: Page): Promise<void> {
  await step("按 Esc 关上设置抽屉", async () => {
    await page.keyboard.press("Escape");
    await expect(settingsDrawer(page).marker, "按 Esc 应关上设置抽屉").toHaveCount(0);
  });
}

/** 设置抽屉里只有 `mode` 的按钮 `aria-pressed="true"`（需求 1.4、9.5）。抽屉须已打开。 */
async function expectPressed(page: Page, mode: PageModeSpec): Promise<void> {
  for (const other of PAGE_MODES) {
    await expect(pageModeButton(page, other.anim), `“${other.label}”按钮的 aria-pressed`).toHaveAttribute(
      "aria-pressed",
      String(other.anim === mode.anim),
    );
  }
}

/**
 * 切换系统的减弱动态效果状态，核对页面的媒体查询随之改变，再等 2 帧让阅读器随之重渲染（需求 9.7）。
 *
 * `matchMedia(...).matches` 在 `emulateMedia` 之后立即反映新值，但 Chromium 在下一个动画帧才派发
 * `change` 事件；阅读器经 `useReducedMotion` 订阅该事件，事件之前翻页器读到的仍是旧值。不等帧就
 * Tap，翻页可能按旧状态播放动画。与 `reader-continuous-scroll.spec.ts` 的同名函数相同。
 */
async function emulateReducedMotion(page: Page, value: "reduce" | "no-preference"): Promise<void> {
  await step(`page.emulateMedia({ reducedMotion: "${value}" })`, async () => {
    await page.emulateMedia({ reducedMotion: value });
    const matches = await page.evaluate((v) => window.matchMedia(`(prefers-reduced-motion: ${v})`).matches, value);
    expect(matches, `matchMedia('(prefers-reduced-motion: ${value})').matches`).toBe(true);
    await waitFrames(page);
  });
}

// ---------------------------------------------------------------------------
// 五种模式
// ---------------------------------------------------------------------------

for (const mode of PAGE_MODES) {
  const paged = mode.family === "paged";
  const hinted = mode.anim === PAGE_ANIM.cover || mode.anim === PAGE_ANIM.slide || mode.anim === PAGE_ANIM.simulation;

  test.describe(`PTM 翻页模式“${mode.label}”（pageAnim ${mode.anim}，data-page-mode="${mode.attr}"）`, () => {
    const start = otherFamilyMode(mode);

    test(`PTM 1.3–1.6 从“${start.label}”经设置抽屉切到“${mode.label}”：选项组依次为覆盖、滑动、仿真、滚动、无动画，aria-pressed 标示所选，<main data-page-mode="${mode.attr}">，localStorage 的 pageAnim 为 ${mode.anim}，新模式以切换前的阅读位置定位`, async ({
      page,
      context,
      lib,
      bookLog,
    }) => {
      const plan = await modePlan(lib);
      const { facts } = plan.book;
      const from = await openInMode(page, context, bookLog, plan, start);

      // 切换前的阅读位置 o：分页翻一页取页首（需求 2.7），滚动取判定线处段落的偏移（需求 10.6）
      const before =
        from === null
          ? (await scrollToJudgeK(page, lib, plan)).offset
          : (await pageDown(page, facts, from)).pageStart;
      if (from !== null) {
        await waitProgress(page, plan.book.id, plan.chapter, (o) => o === before, `页首偏移 ${before}`);
      }

      await openSettings(page);
      await step(`1.3 选项组“${MODE_GROUP_NAME}”的按钮依次为 ${MODE_LABELS.join("、")}；1.4 起始模式“${start.label}”为 aria-pressed="true"`, async () => {
        await expect(modeGroup(page).getByRole("button"), "“翻页模式”选项组的按钮及其顺序（需求 1.3）").toHaveText([
          ...MODE_LABELS,
        ]);
        await expectPressed(page, start);
      });
      await selectPageMode(page, mode.anim);

      await step(`1.6 “${mode.label}”以切换前的阅读位置（下标 ${plan.chapter}，章内偏移 ${before}）定位`, async () => {
        if (paged) {
          const at = await waitPageTurnSettled(page);
          note(`切换后当前页：${JSON.stringify(at)}`);
          expect(at.chapterId, "当前页所在章").toBe(plan.chapter);
          expect(at.pageStart, "当前页的页首偏移应不大于切换前的位置").toBeLessThanOrEqual(before);
          const next = await pageDown(page, facts, at);
          if (next.chapterId === plan.chapter) {
            expect(next.pageStart, "下一页的页首偏移应大于切换前的位置（当前页包含它）").toBeGreaterThan(before);
          } else {
            expect(at.pageIndex, "下一页已入下一章时，切换后的页应为本章末页").toBe(at.pageCount - 1);
          }
        } else {
          const judge = await readJudgeParagraph(page);
          note(`切换后判定段落：下标 ${judge.chapterId} 第 ${judge.index} 段`);
          expect(judge.chapterId, "判定段落所在章").toBe(plan.chapter);
          const paragraphs = await readParagraphStarts(page, lib, plan.book.id, plan.chapter);
          await expectOffsetInParagraph(paragraphs, judge.index, before, "切换前的阅读位置");
        }
      });

      const [prevTitle, nextTitle] = paged ? ["上一章", "下一章"] : ["上一章 (←)", "下一章 (→)"];
      await step(`底栏换章按钮的名称为“上一章”“下一章”，悬停提示为“${prevTitle}”“${nextTitle}”（${paged ? "分页模式没有换章键" : "滚动模式 ←/→ 即换章"}）`, async () => {
        const view = reader(page);
        await expect(view.prevChapterButton, "上一章按钮（按名称精确定位）").toHaveCount(1);
        await expect(view.nextChapterButton, "下一章按钮（按名称精确定位）").toHaveCount(1);
        await expect(view.prevChapterButton, "上一章按钮的 title").toHaveAttribute("title", prevTitle);
        await expect(view.nextChapterButton, "下一章按钮的 title").toHaveAttribute("title", nextTitle);
      });
    });

    test(`PTM 5.1–5.3 5.5 5.11 控制栏隐藏时点九宫格各区中心：TL、TC、ML、BL 回翻，TR、MR、BC、BR 前翻（${paged ? "分页模式翻一页" : "滚动模式翻页滚动"}），翻页后控制栏仍隐藏`, async ({
      page,
      context,
      lib,
      bookLog,
    }) => {
      const plan = await modePlan(lib);
      const { facts } = plan.book;
      let at = await openInMode(page, context, bookLog, plan, mode);
      await hideControls(page);

      for (const zone of TURN_ORDER) {
        const direction = TAP_ZONE_ACTIONS[zone];
        if (direction === "menu") throw new Error(`${zone} 不是翻页区`);
        const label = direction === "next" ? "前翻" : "回翻";
        await step(`点 ${zone} 区中心：${label}（需求 ${direction === "next" ? "5.3" : "5.2"}），控制栏仍隐藏（5.11）`, async () => {
          if (at !== null) {
            const target = neighborPage(facts, at, direction);
            await tapZoneCenter(page, zone);
            at = await expectPagedAt(page, target, `点 ${zone} 之后`);
            note(`${zone} → ${JSON.stringify(at)}`);
          } else {
            const before = await readScrollMark(page, plan.chapter);
            await tapZoneCenter(page, zone);
            await waitScrollTurnSettled(page, plan.chapter);
            const after = await readScrollMark(page, plan.chapter);
            const moved = after.sectionTop - before.sectionTop;
            note(`${zone}：起始章节区段上边 ${before.sectionTop} → ${after.sectionTop}（scrollTop ${before.scrollTop} → ${after.scrollTop}）`);
            const min = before.clientHeight * SCROLL_TURN_MIN_RATIO;
            if (direction === "next") {
              expect(-moved, `${label}：正文应上移至少 ${min} px（可视高度的一半）`).toBeGreaterThanOrEqual(min);
            } else {
              expect(moved, `${label}：正文应下移至少 ${min} px（可视高度的一半）`).toBeGreaterThanOrEqual(min);
            }
          }
          expect(await readControlsVisible(page), "翻页不唤出控制栏（需求 5.11）").toBe(false);
        });
      }
    });

    test(`PTM 5.4 5.9 控制栏可见时点九宫格任一区只隐藏控制栏、不翻页；隐藏时点 MC 唤出控制栏，4.5 s 后自动隐藏（Controlled_Clock）`, async ({
      page,
      context,
      lib,
      bookLog,
      clock,
    }) => {
      const plan = await modePlan(lib);
      await clock.install();
      await openInMode(page, context, bookLog, plan, mode);
      await pauseClock(page);
      // 打开后尚未执行的帧回调与定时器先走完，再取"不变"的基准
      await advanceClock(page, TURN_WINDOW_MS, "让打开后排队的帧回调执行完");

      /** 正文位置：分页为当前页与 data-turning，滚动为起始章节区段的位置。 */
      const readStill = async (): Promise<{ page: CurrentPage | null; turning: boolean | null; scroll: ScrollMark | null }> => {
        if (paged) {
          const view = await readPagedView(page);
          return { page: view.current, turning: view.turning, scroll: null };
        }
        return { page: null, turning: null, scroll: await readScrollMark(page, plan.chapter) };
      };
      const base = await readStill();
      note(`基准位置：${JSON.stringify(base)}`);
      const expectStill = async (what: string): Promise<void> => {
        const now = await readStill();
        if (paged) {
          expect(now.turning, `${what}：data-turning 不应为 "true"（没有翻页在进行）`).toBe(false);
          expect(now.page, `${what}：当前页应不变`).toEqual(base.page);
        } else {
          const a = base.scroll as ScrollMark;
          const b = now.scroll as ScrollMark;
          expect(Math.abs(b.sectionTop - a.sectionTop), `${what}：正文位置应不变（区段上边 ${a.sectionTop} → ${b.sectionTop}）`).toBeLessThanOrEqual(STILL_PX);
        }
      };
      const expectVisible = async (visible: boolean, what: string): Promise<void> => {
        await expect.poll(() => readControlsVisible(page), { message: `${what}：控制栏应${visible ? "可见" : "隐藏"}` }).toBe(visible);
      };

      await step("页面刚加载完成：控制栏可见", async () => {
        expect(await readControlsVisible(page), "页面刚加载完成时控制栏应可见").toBe(true);
      });

      for (const zone of TURN_ZONES) {
        await step(`5.9 控制栏可见时点 ${zone} 区中心：控制栏隐藏，推进 ${TURN_WINDOW_MS} ms 后不翻页；再点 MC 唤出（5.4）`, async () => {
          await tapZoneCenter(page, zone);
          await expectVisible(false, `点 ${zone} 之后`);
          await page.clock.runFor(TURN_WINDOW_MS);
          await expectStill(`点 ${zone} 并推进 ${TURN_WINDOW_MS} ms 之后`);
          await tapZoneCenter(page, "MC");
          await expectVisible(true, "控制栏隐藏时点 MC 之后");
        });
      }

      await step(`5.9 控制栏可见时点 MC：控制栏隐藏，推进 ${TURN_WINDOW_MS} ms 后不翻页`, async () => {
        await tapZoneCenter(page, "MC");
        await expectVisible(false, "控制栏可见时点 MC 之后");
        await page.clock.runFor(TURN_WINDOW_MS);
        await expectStill(`点 MC 并推进 ${TURN_WINDOW_MS} ms 之后`);
      });

      await step(`5.4 控制栏隐藏时点 MC：控制栏唤出；推进 ${CONTROLS_AUTO_HIDE_MS - 1} ms 仍可见，再推进 1 ms 即自动隐藏`, async () => {
        await tapZoneCenter(page, "MC");
        await expectVisible(true, "控制栏隐藏时点 MC 之后");
        await page.clock.runFor(CONTROLS_AUTO_HIDE_MS - 1);
        expect(await readControlsVisible(page), `唤出后 ${CONTROLS_AUTO_HIDE_MS - 1} ms：控制栏应仍可见`).toBe(true);
        await page.clock.runFor(1);
        await expectVisible(false, `唤出后 ${CONTROLS_AUTO_HIDE_MS} ms`);
        await expectStill("点 MC 唤出控制栏并等它自动隐藏之后");
      });
    });

    test(`PTM 1.8 刷新后仍以“${mode.label}”呈现，位置仍为刷新前的阅读位置（${paged ? "同一页，data-page-start 相同" : "同一章，判定段落相同"}）`, async ({
      page,
      context,
      lib,
      bookLog,
    }) => {
      const plan = await modePlan(lib);
      const { facts } = plan.book;
      const from = await openInMode(page, context, bookLog, plan, mode);

      if (from !== null) {
        const before = await pageDown(page, facts, from);
        await waitProgress(page, plan.book.id, plan.chapter, (o) => o === before.pageStart, `页首偏移 ${before.pageStart}`);
        await reloadReader(page, bookLog, plan.book);
        await step(`刷新后当前页仍为下标 ${before.chapterId} 第 ${before.pageIndex + 1} 页，data-page-start 为 ${before.pageStart}`, async () => {
          const after = await waitPageTurnSettled(page);
          note(`刷新后当前页：${JSON.stringify(after)}`);
          expect(after, "刷新前后的当前页（章、页序、页数、页首偏移）").toEqual(before);
        });
      } else {
        const { k } = await scrollToJudgeK(page, lib, plan);
        await reloadReader(page, bookLog, plan.book);
        await step(`刷新后当前章仍为下标 ${plan.chapter}，判定段落仍为第 ${k} 段`, async () => {
          await expect
            .poll(
              async () => {
                const judge = await readJudgeParagraph(page);
                return { chapterId: judge.chapterId, index: judge.index };
              },
              { message: "刷新后的判定段落（章、段序）" },
            )
            .toEqual({ chapterId: plan.chapter, index: k });
        });
      }

      await step(`刷新后仍为“${mode.label}”：<main data-page-mode="${mode.attr}">，localStorage 的 pageAnim 为 ${mode.anim}，设置抽屉标示该模式`, async () => {
        await expect(reader(page).main, "<main> 的 data-page-mode").toHaveAttribute("data-page-mode", mode.attr);
        expect(await readStoredPageAnim(page), "localStorage 的 pageAnim").toBe(mode.anim);
        await openSettings(page);
        await expectPressed(page, mode);
        await closeSettings(page);
      });
    });

    if (paged) {
      test(`PTM 1.6 1.7 “${mode.label}” → 滚动 → “${mode.label}”：中途的滚动模式把该页页首所在段落置于判定线；未做移动切回后当前页不变（data-page-start 相同）`, async ({
        page,
        context,
        lib,
        bookLog,
      }) => {
        const plan = await modePlan(lib);
        const { facts } = plan.book;
        const from = await openInMode(page, context, bookLog, plan, mode);
        if (from === null) throw new Error("分页模式应有当前页");
        const before = await pageDown(page, facts, from);

        await selectPageMode(page, PAGE_ANIM.scroll);
        await step(`1.6 滚动模式下判定段落为页首偏移 ${before.pageStart} 所在段落`, async () => {
          const judge = await readJudgeParagraph(page);
          note(`滚动模式下判定段落：下标 ${judge.chapterId} 第 ${judge.index} 段`);
          expect(judge.chapterId, "判定段落所在章").toBe(plan.chapter);
          const paragraphs = await readParagraphStarts(page, lib, plan.book.id, plan.chapter);
          await expectOffsetInParagraph(paragraphs, judge.index, before.pageStart, "切换前的页首偏移");
        });

        await selectPageMode(page, mode.anim);
        await step(`1.7 切回“${mode.label}”后当前页仍为下标 ${before.chapterId} 第 ${before.pageIndex + 1} 页，data-page-start 为 ${before.pageStart}`, async () => {
          const after = await waitPageTurnSettled(page);
          note(`切回后当前页：${JSON.stringify(after)}`);
          expect(samePage(after, before), `切回后当前页 ${JSON.stringify(after)} 应与切换前 ${JSON.stringify(before)} 相同`).toBe(true);
        });
      });
    } else {
      test("PTM 1.6 1.7 滚动 → 覆盖 → 滚动：中途的覆盖模式显示包含该位置的页；未做移动切回后判定段落不变", async ({
        page,
        context,
        lib,
        bookLog,
      }) => {
        const plan = await modePlan(lib);
        await openInMode(page, context, bookLog, plan, mode);
        const { k, offset } = await scrollToJudgeK(page, lib, plan);

        await selectPageMode(page, PAGE_ANIM.cover);
        await step(`1.6 覆盖模式显示下标 ${plan.chapter} 中页首偏移不大于 ${offset} 的页`, async () => {
          const at = await waitPageTurnSettled(page);
          note(`覆盖模式下当前页：${JSON.stringify(at)}`);
          expect(at.chapterId, "当前页所在章").toBe(plan.chapter);
          expect(at.pageStart, "当前页的页首偏移应不大于切换前的位置").toBeLessThanOrEqual(offset);
        });

        await selectPageMode(page, PAGE_ANIM.scroll);
        await step(`1.7 切回滚动后当前章仍为下标 ${plan.chapter}，判定段落仍为第 ${k} 段`, async () => {
          const judge = await readJudgeParagraph(page);
          note(`切回后判定段落：下标 ${judge.chapterId} 第 ${judge.index} 段`);
          expect({ chapterId: judge.chapterId, index: judge.index }, "切回后的判定段落（章、段序）").toEqual({
            chapterId: plan.chapter,
            index: k,
          });
        });
      });
    }

    test(`PTM 9.5 9.6 Reduced_Motion 成立时设置抽屉仍标示“${mode.label}”，pageAnim 仍为 ${mode.anim}；${hinted ? "选项组下显示" : "不显示"}“${REDUCED_MOTION_HINT}”`, async ({
      page,
      context,
      lib,
      bookLog,
    }) => {
      const plan = await modePlan(lib);
      await openInMode(page, context, bookLog, plan, mode);
      await emulateReducedMotion(page, "reduce");
      await openSettings(page);
      const hint = page.getByText(REDUCED_MOTION_HINT, { exact: true });

      await step(`9.5 所选模式不变：“${mode.label}”为 aria-pressed="true"，localStorage 的 pageAnim 为 ${mode.anim}，<main data-page-mode="${mode.attr}">`, async () => {
        await expectPressed(page, mode);
        expect(await readStoredPageAnim(page), "localStorage 的 pageAnim").toBe(mode.anim);
        await expect(reader(page).main, "<main> 的 data-page-mode").toHaveAttribute("data-page-mode", mode.attr);
      });

      await step(`9.6 ${hinted ? "显示提示，且为选项组的可访问描述" : "不显示提示（只针对覆盖、滑动、仿真）"}`, async () => {
        if (hinted) {
          await expect(hint, "减弱动态效果的提示").toBeVisible();
          await expect(modeGroup(page), "选项组的可访问描述（aria-describedby）").toHaveAccessibleDescription(
            REDUCED_MOTION_HINT,
          );
        } else {
          await expect(hint, "减弱动态效果的提示").toHaveCount(0);
          await expect(modeGroup(page), "选项组的可访问描述").toHaveAccessibleDescription("");
        }
      });

      await emulateReducedMotion(page, "no-preference");
      await step("9.7 抽屉开着时切回 no-preference：提示不显示，所选模式不变", async () => {
        await expect(hint, "减弱动态效果的提示").toHaveCount(0);
        await expect(modeGroup(page), "选项组的可访问描述").toHaveAccessibleDescription("");
        await expectPressed(page, mode);
      });
      await closeSettings(page);
    });
  });
}

// ---------------------------------------------------------------------------
// 覆盖模式：减弱动态效果下翻页无动画，切回后恢复（9.3、9.7）
// ---------------------------------------------------------------------------

test.describe("PTM 9.3 9.7 覆盖模式在 Reduced_Motion 下翻页", () => {
  test('PTM 9.3 9.5 9.6 9.7 emulateMedia reduce 后覆盖模式的 Tap 与按键翻页照常翻页、data-turning 始终不为 "true"，设置抽屉出现提示；切回 no-preference 后下一次翻页恢复动画（无需刷新）', async ({
    page,
    context,
    lib,
    bookLog,
  }) => {
    const plan = await modePlan(lib);
    const { facts } = plan.book;
    const cover = pageModeSpec(PAGE_ANIM.cover);
    const opened = await openInMode(page, context, bookLog, plan, cover);
    if (opened === null) throw new Error("覆盖模式应有当前页");
    let at: CurrentPage = opened;
    await hideControls(page);
    await emulateReducedMotion(page, "reduce");

    await step('9.3 Reduced_Motion 下点 TR 区中心：翻到下一页，data-turning 始终不为 "true"', async () => {
      await startTurningRecord(page);
      await tapZoneCenter(page, "TR");
      at = await expectPagedAt(page, neighborPage(facts, at, "next"), "点 TR 之后");
      const values = await takeTurningRecord(page);
      note(`Reduced_Motion 下 Tap 翻页期间 data-turning 的取值：${JSON.stringify(values)}`);
      expect(values, 'data-turning 依次取过的值不应含 "true"（不播放翻页动画，需求 9.3）').not.toContain("true");
    });

    await step('9.3 Reduced_Motion 下按 PageDown：翻到下一页，data-turning 始终不为 "true"', async () => {
      await startTurningRecord(page);
      at = await pageDown(page, facts, at);
      const values = await takeTurningRecord(page);
      note(`Reduced_Motion 下按键翻页期间 data-turning 的取值：${JSON.stringify(values)}`);
      expect(values, 'data-turning 依次取过的值不应含 "true"（不播放翻页动画，需求 9.3）').not.toContain("true");
    });

    await openSettings(page);
    await step(`9.5 9.6 设置抽屉：“覆盖”仍为 aria-pressed="true"，pageAnim 仍为 ${cover.anim}，选项组下显示“${REDUCED_MOTION_HINT}”`, async () => {
      await expectPressed(page, cover);
      expect(await readStoredPageAnim(page), "localStorage 的 pageAnim").toBe(cover.anim);
      await expect(page.getByText(REDUCED_MOTION_HINT, { exact: true }), "减弱动态效果的提示").toBeVisible();
    });
    await closeSettings(page);

    await emulateReducedMotion(page, "no-preference");
    await step('9.7 切回 no-preference 后点 TR 区中心：翻到下一页，翻页期间 data-turning 出现 "true"（恢复动画），最后回到 "false"', async () => {
      await startTurningRecord(page);
      await tapZoneCenter(page, "TR");
      at = await expectPagedAt(page, neighborPage(facts, at, "next"), "点 TR 之后");
      const values = await takeTurningRecord(page);
      note(`no-preference 下 Tap 翻页期间 data-turning 的取值：${JSON.stringify(values)}`);
      expect(values, 'data-turning 依次取过的值应含 "true"（下一次翻页按新状态播放动画，需求 9.7）').toContain("true");
      expect(values[values.length - 1], '翻页落定后 data-turning 为 "false"').toBe("false");
    });
  });
});
