/**
 * 阅读器：滚动模式的跨章连续滚动（reader-page-turn-modes 需求 10.3、10.4、10.5、10.7、10.10、10.14、9.4；
 * 需求 15.4；design §7、§13.2）。`fixture` 项目（Opaque_Mode），桌面视口，默认主题（不 `seedTheme`），默认
 * 翻页模式（滚动，`pageAnim` 3，不 `seedPageMode`），不装 Controlled_Clock（翻页滚动与按键闸门按真实时间走）。
 * 用例标题以 `PTM <需求编号>` 开头。
 *
 * 全局上下文是 `prefers-reduced-motion: reduce`（`playwright.config.ts` 的 `contextOptions`）：翻页滚动在
 * 那里是瞬时赋值（需求 9.4）。需要平滑滚动的用例以 `page.emulateMedia({ reducedMotion: "no-preference" })`
 * 覆盖，并先核对页面的媒体查询确已改变。
 *
 * ## 用书与章节（期望值运行时推导）
 *
 * 书为 `lib.role("longText")`。章节取 `_toc.json` 的非卷节点序列（`TocFacts.bodyIndices`）：
 *
 * - 第 1、2、3 个正文章节（下文记为 C1、C2、C3）。经 `?ch=` 打开 C2 时窗口以 C2 为锚，上方挂着 C1、下方
 *   挂着 C3（需求 10.7、design §7.2 的"锚章 ± 1"）；判定线进入 C3 后锚章变为 C3，C1 若随之离开窗口即
 *   "Visible_Area 上方的卸载"。经 `?ch=` 打开 C3 后判定线回到 C2，C1 若随之挂上即"上方的挂载"。挂没挂、
 *   卸没卸由 `MutationObserver` 实测，不靠推算；10.3 的用例断言确实发生了上方的挂载 / 卸载。
 * - 长章（`roles.json longText.chapterIndex`）：9.4 的用例在它的章中翻页，前后都远离章界，窗口不变。
 * - 末个正文章节：10.14 的全书末尾。
 *
 * 前提不成立是测试自身的问题（16.6），用例普通失败。所选章节与读数记在注解 `continuous-scroll-plan`、
 * `continuous-scroll-reading` 里。
 *
 * ## 几何读数（`readView`）
 *
 * 只读的测量性 DOM 遍历（D8：不用于定位要操作的元素），全部为视口坐标：
 *
 * - 可见区（Visible_Area）：`<main>` 的可视矩形（边框盒上边 + `clientTop`，高 `clientHeight`）减去与它交叠的
 *   顶栏（banner）与底栏（contentinfo）；滑出视口的栏不计。
 * - 判定线（Judgment_Line）：`<main>` 内边距边上沿 + `TOP_BIAS`（应用的 `scrollTop + TOP_BIAS`）。判定线所在章
 *   取"顶边 ≤ 判定线的最后一个区段"（都在判定线之下时取首个），与应用的 `locateAt` 同一口径。
 * - 行：与可见区交叠的段落经 `Range.getClientRects()` 按纵向重叠（超过较矮者一半）合并成行，各区段的标题区
 *   整块当作一行（design §7.6）。可见区中的最后一行（含部分可见行）是 `top < 可见区底边` 的行里 `top` 最大的
 *   那一行；翻页后按（区段、块、行在块内的偏移）找回它，不经 `scrollTop` 换算：跨章时锚点补偿会改写
 *   `scrollTop` 而保持屏幕位置（需求 10.3）。
 *
 * ## 各条的做法
 *
 * - 10.4 / 10.5：打开 C2，把判定线放到 C3 区段顶边之上 0.6 屏处，再以读者操作（`setMainScrollTop`，先派发
 *   `deltaY` 为 0 的 `wheel`，design §3.3）每步把 `scrollTop` 增加 1/4 屏，共 5 步：判定线依次位于章界之上
 *   0.35、0.1 屏与之下 0.15、0.4、0.65 屏，不会压在章界上。每步停稳后断言当前章区段（`data-current`）与 URL
 *   的 `ch` 都是判定线所在章，且先后经过 C2 与 C3；`history.length` 不变（以替换历史记录项的方式写回）。
 *   最后底栏章节滑杆的值为 C3 的正文序号，按 `T` 打开目录抽屉，带 `aria-current="true"` 的行只有 C3。
 * - 10.7：打开 C2（章首），核对 C1 的区段紧接在 C2 之上、其末段在可见区之上，且末段文字与原文 C1 最后一个
 *   非空行相同；鼠标移到 `<main>` 中心、`mouse.wheel` 向上半屏（真实滚轮，需求 10.16），停稳后 C1 的末段与
 *   C2 的标题同在可见区内（连续读到前一章），判定线进入 C1，当前章与 URL 的 `ch` 变为 C1。
 * - 10.3：一次读者操作把 `scrollTop` 改到使目标段落的上边位于判定线之上 4 px（判定线压在该段上），随即读该段的
 *   `getBoundingClientRect().top`（应用还没收到 `scroll` 事件，记为 top₀）；此后测试不再滚动，逐帧（rAF）与在
 *   `<main>` 子节点变化的回调里（`MutationObserver`，挂卸提交之后的同一任务内）读这一段的上边，直到发生过挂卸、
 *   且之后连续 10 帧既无挂卸也无 `scrollTop` 变化。断言：可见区上方确有区段卸载（向下：C2 → C3 的第 2 段）/
 *   挂载（向上：C3 章首 → C2 末段），该段始终在 DOM 中，每个读数与 top₀ 相差 ≤ 1 px。
 * - 10.10：Reduced_Motion（瞬时）与 no-preference（按 100 ms 基准平滑滚动）各一个用例。打开 C2，把可见区底边
 *   放到 C3 区段顶边之上半个可见区高处；每次按 `Space` 之前把 `scrollTop` 微调到可见区的最后一行跨在可见区
 *   底边上（部分可见行），按下并停稳后断言这一行的上边与可见区顶边相差 ≤ 2 px（`scrollTop` 取整与锚点补偿的
 *   亚像素误差）；连按至判定线进入 C3（期间窗口挂卸，补偿与翻页动画叠加）。同方向两次按键至少间隔 600 ms
 *   （需求 11.6 的按键闸门，输入节奏）。
 * - 9.4（兼 9.7）：在长章章中，先以 no-preference 按 `Space`，再不刷新页面切到 Reduced_Motion 按 `Space`。
 *   按键前装一个捕获阶段的 `keydown` 监听（先于应用在 `window` 冒泡阶段的处理），记下按键时的 `scrollTop`，
 *   随后逐帧（rAF，注册早于应用的翻页动画帧）记 30 帧。"第 k 帧到达终点"指第 k 帧起的读数都等于最后一帧
 *   的读数。no-preference 下 k > 1（动画跨多帧，用作对照）；Reduced_Motion 下 k = 1：按键之后的第一帧就已是
 *   终点（在一帧内完成），且终点不同于按键时的位置。
 * - 10.14：打开末个正文章节，把 `<main>` 滚到底（窗口末章即全书末章），按 `Space`：`role="status"` 的边界提示
 *   中"没有上一页 / 没有下一页"唯一，文字为"没有下一页"；停稳后 `scrollTop` 不变。
 */
import type { Page } from "@playwright/test";
import { DEFAULT_PAGE_ANIM } from "../../../src/utils/pageAnim";
import { TOP_BIAS } from "../../../src/utils/scrollTurn";
import { KEY_TURN_GAP_MS } from "../../../src/utils/turnInput";
import { expect, test, type BookLog, type Lib } from "../../support/fixtures";
import { reader, tocDrawer } from "../../support/locators";
import {
  bookText,
  bookUnderTest,
  expectCurrentChapter,
  expectDocumentNotScrollable,
  openReader,
  pageModeSpec,
  readChapterScroll,
  readCurrentRegion,
  readMainScroll,
  readTocList,
  setMainScrollTop,
  urlChapterParams,
  waitFrames,
  type BookUnderTest,
} from "../../support/reader";
import { TIMEOUTS } from "../../support/settings";
import { step } from "../../support/step";

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 10.4：起点的判定线在下一章区段顶边之上多少屏（`clientHeight` 的倍数）。 */
const CROSS_START_SCREENS = 0.6;

/** 10.4：每一步滚动的距离（屏）。 */
const CROSS_STEP_SCREENS = 0.25;

/** 10.4：步数。判定线依次位于章界之上 0.35、0.1 屏与之下 0.15、0.4、0.65 屏。 */
const CROSS_STEPS = 5;

/** "到位"的容差（px）：章首、滚到底。 */
const EDGE_PX = 2;

/** 相邻两个区段首尾相接：前者底边与后者顶边之差的上限（px，取整余量）。 */
const SECTION_JOIN_PX = 1;

/** 10.3：判定线处段落屏幕位置变化的上限（px）。 */
const ANCHOR_TOLERANCE_PX = 1;

/** 10.3：跳转后被跟踪段落的上边位于判定线之上多少 px（判定线因此压在该段上）。 */
const TRACK_LEAD_PX = 4;

/** 10.3：发生过挂卸之后，连续这么多帧既无挂卸也无 `scrollTop` 变化即停止采样。 */
const QUIET_FRAMES = 10;

/** 10.3：至多采样多少帧。 */
const MAX_TRACK_FRAMES = 240;

/** 10.10：保留一行的容差（px；`scrollTop` 取整与锚点补偿的亚像素误差，与 `reader-shortcuts.spec.ts` 相同）。 */
const KEEP_LINE_TOLERANCE_PX = 2;

/** 10.10：起点的可见区底边在下一章区段顶边之上多少个可见区高。 */
const TURN_START_BANDS = 0.5;

/** 10.10：判定线进入下一章之前至多按几次 `Space`（每次约翻过一个可见区高）。 */
const MAX_CROSSING_TURNS = 4;

/** 同方向两次翻页键之间至少等这么久（需求 11.6 的 600 ms 加余量，输入节奏）。 */
const KEY_GAP_MS = KEY_TURN_GAP_MS + 150;

/** 滚动停稳：`<main>` 的 `scrollTop` 连续这么多个动画帧不变。 */
const SETTLE_FRAMES = 3;

/** 9.4：按键之后逐帧采样的帧数（远长于按键翻页 100 ms 基准的动画）。 */
const SAMPLE_FRAMES = 30;

/** 9.4：页面上存放采样结果（Promise）的全局属性名。 */
const SAMPLER_KEY = "__e2eTurnFrames";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

// ---------------------------------------------------------------------------
// 用书与章节
// ---------------------------------------------------------------------------

interface ScrollPlan {
  book: BookUnderTest;
  /** 第 1、2、3 个正文章节的下标。 */
  c1: number;
  c2: number;
  c3: number;
  /** 长章（`longText.chapterIndex`）的下标。 */
  long: number;
  /** 末个正文章节的下标。 */
  last: number;
}

async function scrollPlan(lib: Lib): Promise<ScrollPlan> {
  const id = lib.role("longText");
  const book = await bookUnderTest(lib, id);
  return step("选定章节：第 1–3 个正文章节、长章（longText.chapterIndex）与末个正文章节", () => {
    const { facts } = book;
    const [c1, c2, c3] = facts.bodyIndices;
    const last = facts.bodyIndices[facts.bodyCount - 1];
    if (c1 === undefined || c2 === undefined || c3 === undefined || last === undefined) {
      throw new Error(`${id}：正文章节不足 3 个（共 ${facts.bodyCount} 个）`);
    }
    const long = lib.fixtureRoles().longText.chapterIndex;
    if (facts.bodyOrdinals[long] === null || facts.bodyOrdinals[long] === undefined) {
      throw new Error(`${id}：longText.chapterIndex（下标 ${long}）不是正文章节`);
    }
    const name = (i: number) => `下标 ${i}「${facts.titles[i]}」`;
    test.info().annotations.push({
      type: "continuous-scroll-plan",
      description: `书 ${id}；C1 ${name(c1)}、C2 ${name(c2)}、C3 ${name(c3)}；长章 ${name(long)}；末章 ${name(last)}`,
    });
    return { book, c1, c2, c3, long, last };
  });
}

/** 打开 `chapter`（`?ch=`），核对当前章与默认翻页模式，让焦点回到 `<body>`（翻页键不落在按钮上）。 */
async function openAt(page: Page, bookLog: BookLog, book: BookUnderTest, chapter: number): Promise<void> {
  await openReader(page, bookLog, book, chapter);
  await expectCurrentChapter(page, book.facts, chapter);
  const mode = pageModeSpec(DEFAULT_PAGE_ANIM);
  await step(`默认翻页模式（${mode.label}，<main data-page-mode="${mode.attr}">）`, async () => {
    await expect(reader(page).main).toHaveAttribute("data-page-mode", mode.attr);
  });
  await step("document.activeElement.blur()，焦点回到 <body>", async () => {
    await page.evaluate(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement) active.blur();
    });
    await expect
      .poll(() => page.evaluate(() => document.activeElement === document.body), { message: "焦点应在 <body> 上" })
      .toBe(true);
  });
}

/** 切换媒体查询 `prefers-reduced-motion` 并核对页面已生效，再等 2 帧让阅读器随之重渲染（需求 9.7）。 */
async function emulateReducedMotion(page: Page, reduce: boolean): Promise<void> {
  const value = reduce ? "reduce" : "no-preference";
  await step(`prefers-reduced-motion 设为 ${value}`, async () => {
    await page.emulateMedia({ reducedMotion: value });
    await expect
      .poll(() => page.evaluate((query) => window.matchMedia(query).matches, REDUCED_MOTION_QUERY), {
        message: `页面的 ${REDUCED_MOTION_QUERY} 应为 ${reduce}`,
      })
      .toBe(reduce);
    await waitFrames(page);
  });
}

// ---------------------------------------------------------------------------
// 滚动停稳与几何读数
// ---------------------------------------------------------------------------

/**
 * 等 `<main>` 的 `scrollTop` 连续 `SETTLE_FRAMES` 个动画帧不变（翻页滚动动画、锚点补偿都已结束）。
 * 至少等 `SETTLE_FRAMES` 帧；上限 `TIMEOUTS.wait`。
 */
async function waitScrollSettled(page: Page): Promise<void> {
  await reader(page).main.evaluate(
    async (el, { frames, timeoutMs }) => {
      const started = performance.now();
      let last = el.scrollTop;
      let stable = 0;
      while (stable < frames) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const now = el.scrollTop;
        if (now === last) {
          stable += 1;
        } else {
          stable = 0;
          last = now;
        }
        if (stable < frames && performance.now() - started > timeoutMs) {
          throw new Error(`<main> 的 scrollTop 在 ${timeoutMs} ms 内未连续 ${frames} 帧保持不变（最后为 ${now}）`);
        }
      }
    },
    { frames: SETTLE_FRAMES, timeoutMs: TIMEOUTS.wait },
  );
}

/** 纵向区间（视口坐标，px）。 */
interface Extent {
  top: number;
  bottom: number;
}

/** 一行（视口坐标），以及找回它所需的块定位。 */
interface LineMark extends Extent {
  /** 所在区段的 `data-chapter-id`。 */
  chapterId: number;
  /** −1 为标题区（`<article>` 的 `<header>`，整块当作一行）；否则为区段内第几个 `<p>`（从 0 起）。 */
  block: number;
  /** 行上边相对所在块上边的距离。 */
  offset: number;
}

/** 一个已挂载的章节区段（视口坐标）。 */
interface SectionBox extends Extent {
  chapterId: number;
  /** 区段带 `data-current="true"`。 */
  current: boolean;
  /** 区段内正文 `<h1>`；没有时为 null。 */
  heading: (Extent & { text: string }) | null;
  /** 区段内最后一个 `<p>`（文字去掉首尾空白）；没有时为 null。 */
  lastPara: (Extent & { text: string }) | null;
}

interface ViewReading {
  /** 可见区（Visible_Area）。 */
  band: Extent;
  /** 判定线：`<main>` 内边距边上沿 + `TOP_BIAS`。 */
  line: number;
  scrollTop: number;
  clientHeight: number;
  /** `<main>` 的 `scrollHeight − clientHeight`。 */
  maxScrollTop: number;
  /** `<main>` 下的章节区段，按文档顺序。 */
  sections: SectionBox[];
  /** 判定线所在区段的章号（见文件头）；没有区段时为 null。 */
  judged: number | null;
  /** 可见区中的最后一行（含部分可见行）；没有时为 null。 */
  lastLine: LineMark | null;
  /** 入参 `mark` 那一行此刻的上边；未给出或找不到它所在的块时为 null。 */
  markTop: number | null;
}

/** 读可见区、判定线、各区段与可见区中的最后一行（测量，只读；见文件头"几何读数"）。 */
async function readView(page: Page, mark: LineMark | null = null): Promise<ViewReading> {
  const view = reader(page);
  const [main, topBar, bottomBar] = await Promise.all([
    view.main.elementHandle(),
    view.topBar.elementHandle(),
    view.bottomBar.elementHandle(),
  ]);
  if (main === null || topBar === null || bottomBar === null) throw new Error("找不到正文 <main>、顶栏或底栏");
  try {
    return await page.evaluate(
      ({ main: mainEl, topBar: topEl, bottomBar: bottomEl, mark: wanted, topBias }): ViewReading => {
        const mainRect = mainEl.getBoundingClientRect();
        const viewTop = mainRect.top + mainEl.clientTop;
        const viewBottom = viewTop + mainEl.clientHeight;
        let bandTop = viewTop;
        let bandBottom = viewBottom;
        const topRect = topEl.getBoundingClientRect();
        if (topRect.height > 0 && topRect.bottom > viewTop && topRect.top < viewBottom) {
          bandTop = Math.max(bandTop, topRect.bottom);
        }
        const bottomRect = bottomEl.getBoundingClientRect();
        if (bottomRect.height > 0 && bottomRect.bottom > viewTop && bottomRect.top < viewBottom) {
          bandBottom = Math.min(bandBottom, bottomRect.top);
        }
        const line = viewTop + topBias;

        const range = document.createRange();
        const linesOf = (p: Element): Extent[] => {
          range.selectNodeContents(p);
          const rects = Array.from(range.getClientRects())
            .filter((r) => r.height > 0 && r.width > 0)
            .sort((a, b) => a.top - b.top);
          const lines: Extent[] = [];
          for (const r of rects) {
            const prev = lines[lines.length - 1];
            const overlap = prev ? Math.min(prev.bottom, r.bottom) - Math.max(prev.top, r.top) : 0;
            if (prev && overlap > 0.5 * Math.min(prev.bottom - prev.top, r.height)) {
              prev.top = Math.min(prev.top, r.top);
              prev.bottom = Math.max(prev.bottom, r.bottom);
            } else {
              lines.push({ top: r.top, bottom: r.bottom });
            }
          }
          return lines;
        };

        const candidates: LineMark[] = [];
        const sections: SectionBox[] = [];
        let judged: number | null = null;
        let markTop: number | null = null;
        for (const section of Array.from(mainEl.querySelectorAll<HTMLElement>(":scope > section[data-chapter-id]"))) {
          const chapterId = Number(section.dataset.chapterId);
          const rect = section.getBoundingClientRect();
          if (judged === null || rect.top <= line) judged = chapterId;

          const article = section.querySelector("article");
          const header = article?.querySelector(":scope > header") ?? null;
          const paras = article ? Array.from(article.querySelectorAll("p")) : [];
          const h1 = section.querySelector("h1");
          const h1Rect = h1?.getBoundingClientRect();
          const last = paras[paras.length - 1];
          const lastRect = last?.getBoundingClientRect();
          sections.push({
            chapterId,
            current: section.dataset.current === "true",
            top: rect.top,
            bottom: rect.bottom,
            heading:
              h1 && h1Rect ? { top: h1Rect.top, bottom: h1Rect.bottom, text: (h1.textContent ?? "").trim() } : null,
            lastPara:
              last && lastRect
                ? { top: lastRect.top, bottom: lastRect.bottom, text: (last.textContent ?? "").trim() }
                : null,
          });

          if (header) {
            const r = header.getBoundingClientRect();
            if (r.height > 0) candidates.push({ chapterId, block: -1, offset: 0, top: r.top, bottom: r.bottom });
          }
          for (let i = 0; i < paras.length; i++) {
            const r = paras[i].getBoundingClientRect();
            if (r.bottom <= bandTop || r.top >= bandBottom) continue;
            for (const l of linesOf(paras[i])) {
              candidates.push({ chapterId, block: i, offset: l.top - r.top, top: l.top, bottom: l.bottom });
            }
          }
          if (wanted && wanted.chapterId === chapterId) {
            const el = wanted.block < 0 ? header : paras[wanted.block];
            if (el) markTop = el.getBoundingClientRect().top + wanted.offset;
          }
        }

        let lastLine: LineMark | null = null;
        for (const l of candidates) {
          if (l.top < bandBottom && (lastLine === null || l.top > lastLine.top)) lastLine = l;
        }
        return {
          band: { top: bandTop, bottom: bandBottom },
          line,
          scrollTop: mainEl.scrollTop,
          clientHeight: mainEl.clientHeight,
          maxScrollTop: mainEl.scrollHeight - mainEl.clientHeight,
          sections,
          judged,
          lastLine,
          markTop,
        };
      },
      { main, topBar, bottomBar, mark, topBias: TOP_BIAS },
    );
  } finally {
    await Promise.all([main.dispose(), topBar.dispose(), bottomBar.dispose()]);
  }
}

/** `view` 里章号为 `chapterId` 的区段；未挂载时抛错（测试前提不成立）。 */
function sectionOf(view: ViewReading, chapterId: number): SectionBox {
  const found = view.sections.find((s) => s.chapterId === chapterId);
  if (found === undefined) {
    throw new Error(`下标 ${chapterId} 的区段未挂载（已挂载：${view.sections.map((s) => s.chapterId).join(", ")}）`);
  }
  return found;
}

/** 报告里的像素值：保留一位小数。 */
function px(value: number): number {
  return Math.round(value * 10) / 10;
}

function describeExtent(e: Extent): string {
  return `[${px(e.top)}, ${px(e.bottom)}]`;
}

function describeLine(line: LineMark): string {
  const block = line.block < 0 ? "标题区" : `第 ${line.block} 段`;
  return `下标 ${line.chapterId} 的${block}、块内偏移 ${px(line.offset)}，上边 ${px(line.top)}、下边 ${px(line.bottom)}`;
}

function describeView(v: ViewReading): string {
  const sections = v.sections
    .map((s) => `${s.chapterId}${s.current ? "*" : ""}${describeExtent(s)}`)
    .join(" ");
  return (
    `scrollTop ${v.scrollTop}（最大 ${v.maxScrollTop}）；可见区 ${describeExtent(v.band)}；判定线 ${px(v.line)} 在下标 ` +
    `${v.judged ?? "（无）"}；区段 ${sections}`
  );
}

// ---------------------------------------------------------------------------
// 10.4 / 10.5 连续滚过章界
// ---------------------------------------------------------------------------

test.describe("PTM 10.4 10.5 连续滚过章界", () => {
  test("PTM 10.4 10.5 自 C2 章末附近按 1/4 屏的步长连续滚过 C2/C3 章界：当前章与 URL 的 ch 随判定线所在章更新（替换历史记录，history.length 不变），章节滑杆与目录高亮跟随", async ({
    page,
    lib,
    bookLog,
  }) => {
    const plan = await scrollPlan(lib);
    const { facts } = plan.book;
    await openAt(page, bookLog, plan.book, plan.c2);
    const historyLength = await page.evaluate(() => window.history.length);

    await step(`起点：判定线在 C3 区段顶边之上 ${CROSS_START_SCREENS} 屏处（仍在 C2 内）`, async () => {
      await expectDocumentNotScrollable(page);
      const view = await readView(page);
      const shift = sectionOf(view, plan.c3).top - view.line - CROSS_START_SCREENS * view.clientHeight;
      await setMainScrollTop(page, view.scrollTop + Math.round(shift));
      await waitScrollSettled(page);
      const after = await readView(page);
      test.info().annotations.push({ type: "continuous-scroll-reading", description: `起点：${describeView(after)}` });
      expect(after.judged, `判定线应仍在 C2（${describeView(after)}）`).toBe(plan.c2);
      expect(
        Math.abs(sectionOf(after, plan.c3).top - after.line - CROSS_START_SCREENS * after.clientHeight),
        `C3 区段顶边与判定线之距应为 ${CROSS_START_SCREENS} 屏（${describeView(after)}）`,
      ).toBeLessThanOrEqual(EDGE_PX);
    });

    const judgedSeq: number[] = [];
    for (let i = 1; i <= CROSS_STEPS; i++) {
      await step(`第 ${i} 步：<main> 的 scrollTop 增加 ${CROSS_STEP_SCREENS} 屏；当前章与 URL 的 ch 为判定线所在章`, async () => {
        const before = await readView(page);
        await setMainScrollTop(page, before.scrollTop + Math.round(CROSS_STEP_SCREENS * before.clientHeight));
        await waitScrollSettled(page);
        const after = await readView(page);
        const judged = after.judged;
        test.info().annotations.push({
          type: "continuous-scroll-reading",
          description: `第 ${i} 步：${describeView(before)} → ${describeView(after)}`,
        });
        if (judged === null) throw new Error(`判定线不在任何区段内（${describeView(after)}）`);
        judgedSeq.push(judged);
        await expect
          .poll(async () => (await readCurrentRegion(page))?.chapterId ?? null, {
            message: `10.4 当前章区段（data-current="true"）应为判定线所在章 ${judged}`,
          })
          .toBe(judged);
        await expect
          .poll(() => urlChapterParams(page), { message: `10.4 URL 的 ch 应写回为判定线所在章 ${judged}` })
          .toEqual([String(judged)]);
      });
    }

    await step("判定线先后位于 C2 与 C3（确实滚过了章界）", () => {
      expect([...new Set(judgedSeq)], `各步判定线所在章：${judgedSeq.join(" → ")}`).toEqual([plan.c2, plan.c3]);
    });
    await expectCurrentChapter(page, facts, plan.c3);
    await step("10.4 以替换当前历史记录项的方式写回 ?ch=：history.length 不变", async () => {
      expect(await page.evaluate(() => window.history.length), "history.length").toBe(historyLength);
    });
    await step(`10.5 底栏章节滑杆的值为 C3 的正文序号 ${facts.bodyOrdinals[plan.c3]}`, async () => {
      await expect(reader(page).chapterSlider, "章节进度滑杆的当前值").toHaveValue(
        String(facts.bodyOrdinals[plan.c3]),
      );
    });
    await step("10.5 按 T 打开目录抽屉：带 aria-current=\"true\" 的行只有 C3", async () => {
      await page.keyboard.press("T");
      await expect(tocDrawer(page).marker, "按 T 应打开目录抽屉").toBeVisible();
      const list = await readTocList(page);
      const marked = list.rows.filter((r) => r.ariaCurrent === "true").map((r) => r.index);
      expect(marked, "带 aria-current 的目录行").toEqual([plan.c3]);
    });
  });
});

// ---------------------------------------------------------------------------
// 10.7 自章首向上滚入前一章
// ---------------------------------------------------------------------------

/** 原文中第 `chapter` 章最后一个非空行（去掉首尾空白），即该章末段的期望文字。 */
async function lastParagraphText(lib: Lib, bookId: string, chapter: number): Promise<string> {
  const [toc, book] = await Promise.all([lib.toc(bookId), bookText(lib, bookId)]);
  const node = toc.chapters[chapter];
  if (node === undefined) throw new Error(`${bookId} 没有下标 ${chapter} 的节点`);
  const lines = book.text
    .slice(node.start, node.end)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  const last = lines[lines.length - 1];
  if (last === undefined) throw new Error(`${bookId} 下标 ${chapter} 的原文没有非空行`);
  return last;
}

test.describe("PTM 10.7 自章首向上滚动连续读到前一章", () => {
  test("PTM 10.7 经 ?ch= 打开 C2（章首），C1 的区段紧接在 C2 之上；滚轮向上半屏后 C1 的末段与 C2 的标题同在可见区内，判定线进入 C1，当前章与 URL 的 ch 变为 C1", async ({
    page,
    lib,
    bookLog,
  }) => {
    const plan = await scrollPlan(lib);
    const { facts } = plan.book;
    await openAt(page, bookLog, plan.book, plan.c2);
    const expected = await step("C1 末段的期望文字：原文 C1 最后一个非空行", () =>
      lastParagraphText(lib, plan.book.id, plan.c1),
    );

    await step("前提：<main> 在 C2 章首；C1 的区段紧接在 C2 之上（相差 ≤ 1 px），其末段在可见区之上、文字与原文相同", async () => {
      await expectDocumentNotScrollable(page);
      const at = await readChapterScroll(page);
      expect(at.chapterId, "当前章区段").toBe(plan.c2);
      expect(Math.abs(at.scrollTop - at.chapterStart), `scrollTop ${at.scrollTop} 与 C2 章首 ${px(at.chapterStart)}`).toBeLessThanOrEqual(EDGE_PX);
      const view = await readView(page);
      const above = sectionOf(view, plan.c1);
      const current = sectionOf(view, plan.c2);
      expect(
        Math.abs(current.top - above.bottom),
        `C2 区段顶边 ${px(current.top)} 与 C1 区段底边 ${px(above.bottom)}（首尾相接）`,
      ).toBeLessThanOrEqual(SECTION_JOIN_PX);
      expect(above.lastPara?.text, "C1 区段最后一个 <p> 的文字").toBe(expected);
      expect(above.lastPara?.bottom ?? Number.NaN, `C1 末段应在可见区 ${describeExtent(view.band)} 之上`).toBeLessThanOrEqual(
        view.band.top,
      );
    });

    const before = await readMainScroll(page);
    await step("鼠标移到 <main> 中心，滚轮向上半屏（mouse.wheel），等 scrollTop 减小并停稳", async () => {
      const box = await reader(page).main.boundingBox();
      if (box === null) throw new Error("<main> 没有边界框");
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, -Math.round(before.clientHeight / 2));
      await expect
        .poll(async () => (await readMainScroll(page)).scrollTop, { message: "滚轮之后 <main> 的 scrollTop 应减小" })
        .toBeLessThan(before.scrollTop);
      await waitScrollSettled(page);
    });

    await step("10.7 C1 的末段与 C2 的标题同在可见区内，两区段仍首尾相接（连续读到前一章正文）", async () => {
      const view = await readView(page);
      test.info().annotations.push({ type: "continuous-scroll-reading", description: `滚轮之后：${describeView(view)}` });
      const above = sectionOf(view, plan.c1);
      const current = sectionOf(view, plan.c2);
      expect(Math.abs(current.top - above.bottom), "C2 区段顶边与 C1 区段底边之差").toBeLessThanOrEqual(SECTION_JOIN_PX);
      const lastPara = above.lastPara;
      expect(lastPara?.text, "C1 区段最后一个 <p> 的文字").toBe(expected);
      expect(
        lastPara !== null && lastPara.top < view.band.bottom && lastPara.bottom > view.band.top,
        `C1 末段 ${lastPara === null ? "（无）" : describeExtent(lastPara)} 应与可见区 ${describeExtent(view.band)} 相交`,
      ).toBe(true);
      const heading = current.heading;
      expect(heading?.text, "C2 区段的 <h1>").toBe(facts.titles[plan.c2]);
      expect(
        heading !== null && heading.top >= view.band.top && heading.bottom <= view.band.bottom,
        `C2 标题 ${heading === null ? "（无）" : describeExtent(heading)} 应完整位于可见区 ${describeExtent(view.band)} 内`,
      ).toBe(true);
      expect(view.judged, "判定线所在章").toBe(plan.c1);
    });
    await expectCurrentChapter(page, facts, plan.c1);
  });
});

// ---------------------------------------------------------------------------
// 10.3 挂载与卸载时判定线处段落的屏幕位置
// ---------------------------------------------------------------------------

interface TrackFrame {
  /** 被跟踪段落的上边；它不在 DOM 中时为 null。 */
  top: number | null;
  scrollTop: number;
}

interface TrackMutation {
  /** 本批变化里挂上 / 卸下的区段章号。 */
  added: number[];
  removed: number[];
  /** 变化回调时被跟踪段落的上边（挂卸提交之后、同一任务内）；它不在 DOM 中时为 null。 */
  top: number | null;
  scrollTop: number;
}

interface AnchorTrack {
  /** 被跟踪段落所在章与它在区段内的序号。 */
  chapterId: number;
  para: number;
  /** 段落文字的开头（诊断用）。 */
  text: string;
  /** 判定线。 */
  line: number;
  /** 跳转前、跳转赋值后的 `scrollTop`。 */
  scrollBefore: number;
  scrollJumped: number;
  /** 跳转赋值后、应用响应前该段的上边。 */
  top0: number;
  /** 跳转前、采样结束时 `<main>` 下的区段章号（文档顺序）。 */
  sectionsBefore: number[];
  sectionsAfter: number[];
  mutations: TrackMutation[];
  frames: TrackFrame[];
}

/**
 * 10.3 的跳转与采样（见文件头）：以一次读者操作把 `scrollTop` 改到使第 `chapterId` 章的某段（`pick`："second"
 * 为第 2 段，"last" 为末段）的上边位于判定线之上 `TRACK_LEAD_PX`，读 top₀；此后不再滚动，逐帧与在 `<main>`
 * 子节点变化的回调里读该段的上边，直到发生过挂卸且之后连续 `QUIET_FRAMES` 帧既无挂卸也无 `scrollTop` 变化
 * （至多 `MAX_TRACK_FRAMES` 帧）。
 */
async function jumpAndTrack(page: Page, chapterId: number, pick: "second" | "last"): Promise<AnchorTrack> {
  return reader(page).main.evaluate(
    async (main, { id, which, topBias, lead, quiet, maxFrames }): Promise<AnchorTrack> => {
      const ids = () =>
        Array.from(main.querySelectorAll<HTMLElement>(":scope > section[data-chapter-id]"), (s) =>
          Number(s.dataset.chapterId),
        );
      const section = main.querySelector<HTMLElement>(`:scope > section[data-chapter-id="${id}"]`);
      if (section === null) throw new Error(`下标 ${id} 的区段未挂载（已挂载：${ids().join(", ")}）`);
      const paras = Array.from(section.querySelectorAll("article p"));
      if (paras.length < 2) throw new Error(`下标 ${id} 的区段只有 ${paras.length} 个段落`);
      const para = which === "second" ? 1 : paras.length - 1;
      const p = paras[para];
      const line = main.getBoundingClientRect().top + main.clientTop + topBias;
      const topOf = () => (p.isConnected ? p.getBoundingClientRect().top : null);
      const chapterOf = (n: Node): number | null =>
        n instanceof HTMLElement && n.matches("section[data-chapter-id]") ? Number(n.dataset.chapterId) : null;

      const sectionsBefore = ids();
      const mutations: TrackMutation[] = [];
      const observer = new MutationObserver((records) => {
        const added: number[] = [];
        const removed: number[] = [];
        for (const record of records) {
          record.addedNodes.forEach((n) => {
            const c = chapterOf(n);
            if (c !== null) added.push(c);
          });
          record.removedNodes.forEach((n) => {
            const c = chapterOf(n);
            if (c !== null) removed.push(c);
          });
        }
        if (added.length > 0 || removed.length > 0) {
          mutations.push({ added, removed, top: topOf(), scrollTop: main.scrollTop });
        }
      });
      observer.observe(main, { childList: true });

      const frames: TrackFrame[] = [];
      try {
        const scrollBefore = main.scrollTop;
        const shift = p.getBoundingClientRect().top - (line - lead);
        // 读者操作（design §3.3）：先碰一下滚轮输入，位置归约器松开，判定线换章照常生效
        main.dispatchEvent(new WheelEvent("wheel", { deltaY: 0, bubbles: true, cancelable: true }));
        main.scrollTop = scrollBefore + shift;
        const scrollJumped = main.scrollTop;
        // 强制布局读一次：应用要到下一帧的 scroll 事件才会响应，此刻读到的是跳转本身的结果
        const top0 = p.getBoundingClientRect().top;

        let lastChange = 0;
        let lastScroll = scrollJumped;
        let seen = 0;
        for (let i = 1; i <= maxFrames; i++) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          const frame: TrackFrame = { top: topOf(), scrollTop: main.scrollTop };
          frames.push(frame);
          if (frame.scrollTop !== lastScroll || mutations.length !== seen) {
            lastChange = i;
            lastScroll = frame.scrollTop;
            seen = mutations.length;
          }
          if (mutations.length > 0 && i - lastChange >= quiet) break;
        }
        return {
          chapterId: id,
          para,
          text: (p.textContent ?? "").trim().slice(0, 16),
          line,
          scrollBefore,
          scrollJumped,
          top0,
          sectionsBefore,
          sectionsAfter: ids(),
          mutations,
          frames,
        };
      } finally {
        observer.disconnect();
      }
    },
    {
      id: chapterId,
      which: pick,
      topBias: TOP_BIAS,
      lead: TRACK_LEAD_PX,
      quiet: QUIET_FRAMES,
      maxFrames: MAX_TRACK_FRAMES,
    },
  );
}

/**
 * 10.3 的断言：可见区上方（文档顺序在被跟踪段落所在区段之前）确有区段 `change`（卸载 / 挂载），被跟踪段落
 * 始终在 DOM 中，逐帧与变化回调里的上边都与 top₀ 相差 ≤ `ANCHOR_TOLERANCE_PX`。
 */
async function expectAnchorStable(track: AnchorTrack, change: "unmount" | "mount"): Promise<void> {
  const precedes = (order: number[], id: number) => {
    const at = order.indexOf(id);
    return at >= 0 && at < order.indexOf(track.chapterId);
  };
  const aboveChanged =
    change === "unmount"
      ? track.mutations.flatMap((m) => m.removed).filter((id) => precedes(track.sectionsBefore, id))
      : track.mutations.flatMap((m) => m.added).filter((id) => precedes(track.sectionsAfter, id));
  const tops = [...track.frames.map((f) => f.top), ...track.mutations.map((m) => m.top)];
  const present = tops.filter((t): t is number => t !== null);
  const worst = present.reduce((w, t) => Math.max(w, Math.abs(t - track.top0)), 0);
  const finalScroll = track.frames[track.frames.length - 1]?.scrollTop ?? track.scrollJumped;
  const describeMutation = (m: TrackMutation) =>
    `+[${m.added.join(",")}] −[${m.removed.join(",")}] 上边 ${m.top === null ? "（不在 DOM）" : px(m.top)}、scrollTop ${m.scrollTop}`;
  test.info().annotations.push({
    type: "continuous-scroll-reading",
    description:
      `跟踪下标 ${track.chapterId} 第 ${track.para} 段「${track.text}」；判定线 ${px(track.line)}；` +
      `scrollTop ${track.scrollBefore} → 跳转 ${track.scrollJumped} → 补偿后 ${finalScroll}；top₀ ${px(track.top0)}；` +
      `区段 [${track.sectionsBefore.join(",")}] → [${track.sectionsAfter.join(",")}]；` +
      `挂卸 ${track.mutations.map(describeMutation).join("；") || "（无）"}；${track.frames.length} 帧；最大偏差 ${px(worst)} px`,
  });

  const what = change === "unmount" ? "卸载" : "挂载";
  await step(`10.3 前提：可见区上方确有区段${what}（被跟踪段落所在区段之前的区段）`, () => {
    expect(
      aboveChanged.length,
      `上方${what}的区段（区段 [${track.sectionsBefore.join(",")}] → [${track.sectionsAfter.join(",")}]，` +
        `挂卸 ${track.mutations.map(describeMutation).join("；") || "（无）"}）`,
    ).toBeGreaterThan(0);
  });
  await step(
    `10.3 判定线处段落（下标 ${track.chapterId} 第 ${track.para} 段）始终在 DOM 中，屏幕上边与 top₀ ${px(track.top0)} 相差 ≤ ${ANCHOR_TOLERANCE_PX} px`,
    () => {
      expect(tops.length - present.length, "读数中该段不在 DOM 中的次数").toBe(0);
      expect(worst, `逐帧 / 变化回调里该段上边与 top₀ 的最大偏差（共 ${tops.length} 个读数）`).toBeLessThanOrEqual(
        ANCHOR_TOLERANCE_PX,
      );
    },
  );
}

test.describe("PTM 10.3 章节挂载与卸载时判定线处段落的屏幕位置稳定", () => {
  test("PTM 10.3 向下：自 C2 章首跳到判定线压在 C3 第 2 段上，C1 自上方卸载：该段 getBoundingClientRect().top 逐帧变化 ≤ 1 px", async ({
    page,
    lib,
    bookLog,
  }) => {
    const plan = await scrollPlan(lib);
    await openAt(page, bookLog, plan.book, plan.c2);
    const track = await step("以读者操作跳到判定线压在 C3 第 2 段上，逐帧记录该段的上边与 <main> 的子节点变化", () =>
      jumpAndTrack(page, plan.c3, "second"),
    );
    await expectAnchorStable(track, "unmount");
    await expectCurrentChapter(page, plan.book.facts, plan.c3);
  });

  test("PTM 10.3 向上：自 C3 章首跳到判定线压在 C2 末段上，C1 在上方挂载：该段 getBoundingClientRect().top 逐帧变化 ≤ 1 px", async ({
    page,
    lib,
    bookLog,
  }) => {
    const plan = await scrollPlan(lib);
    await openAt(page, bookLog, plan.book, plan.c3);
    const track = await step("以读者操作跳到判定线压在 C2 末段上，逐帧记录该段的上边与 <main> 的子节点变化", () =>
      jumpAndTrack(page, plan.c2, "last"),
    );
    await expectAnchorStable(track, "mount");
    await expectCurrentChapter(page, plan.book.facts, plan.c2);
  });
});

// ---------------------------------------------------------------------------
// 10.10 Space 翻页保留一行（跨章）
// ---------------------------------------------------------------------------

/**
 * 微调 `scrollTop`，使可见区的最后一行跨在可见区底边上（部分可见行）：令它的上边位于底边之上半个行高。
 * 其下的行随之整体落到底边之下，它仍是最后一行。返回调整后的那一行。
 */
async function makeLastLinePartial(page: Page): Promise<LineMark> {
  return step("微调 <main> 的 scrollTop，使可见区的最后一行跨在可见区底边上（部分可见）", async () => {
    const view = await readView(page);
    const last = view.lastLine;
    if (last === null) throw new Error(`可见区 ${describeExtent(view.band)} 内没有任何一行`);
    const shift = Math.round(last.top - (view.band.bottom - (last.bottom - last.top) / 2));
    if (shift !== 0) {
      await setMainScrollTop(page, view.scrollTop + shift);
      await waitScrollSettled(page);
    }
    const after = await readView(page);
    const line = after.lastLine;
    if (line === null) throw new Error(`可见区 ${describeExtent(after.band)} 内没有任何一行`);
    expect(
      { startsInside: line.top < after.band.bottom, endsOutside: line.bottom > after.band.bottom },
      `可见区 ${describeExtent(after.band)} 的最后一行（${describeLine(line)}）应跨在底边上`,
    ).toEqual({ startsInside: true, endsOutside: true });
    expect(
      line.top,
      `最后一行（${describeLine(line)}）应起于可见区顶边之下（否则按需求 10.10 退化为整屏，不是本条的情形）`,
    ).toBeGreaterThan(after.band.top + KEEP_LINE_TOLERANCE_PX);
    return line;
  });
}

/** 按 `Space`，停稳后断言 `line` 成为可见区顶端第一行（上边与可见区顶边相差 ≤ `KEEP_LINE_TOLERANCE_PX`）。 */
async function spaceKeepsLine(page: Page, line: LineMark, before: Extent, item: string): Promise<void> {
  await step(`${item} 按 Space`, () => page.keyboard.press("Space"));
  const after = await step(`等 <main> 的 scrollTop 连续 ${SETTLE_FRAMES} 帧不变后找回那一行`, async () => {
    await waitScrollSettled(page);
    const reading = await readView(page, line);
    test.info().annotations.push({
      type: "continuous-scroll-reading",
      description:
        `${item}：最后一行 ${describeLine(line)} → 上边 ${reading.markTop === null ? "（找不到）" : px(reading.markTop)}；` +
        describeView(reading),
    });
    return reading;
  });
  await step(`${item} 保留一行：翻页前可见区的最后一行成为可见区顶端第一行（容差 ${KEEP_LINE_TOLERANCE_PX} px）`, () => {
    expect(
      Math.abs(after.band.top - before.top) + Math.abs(after.band.bottom - before.bottom),
      `可见区应不变（控制栏未移动）：${describeExtent(before)} → ${describeExtent(after.band)}`,
    ).toBeLessThanOrEqual(1);
    expect(after.markTop, `翻页后应仍能找到那一行（${describeLine(line)}）`).not.toBeNull();
    const top = after.markTop ?? Number.NaN;
    expect(
      Math.abs(top - after.band.top),
      `那一行（${describeLine(line)}）翻页后的上边 ${px(top)} 与可见区顶边 ${px(after.band.top)} 之差`,
    ).toBeLessThanOrEqual(KEEP_LINE_TOLERANCE_PX);
  });
}

const MOTIONS = [
  { reduce: true, label: "Reduced_Motion（瞬时跳转）" },
  { reduce: false, label: "no-preference（平滑滚动）" },
] as const;

test.describe("PTM 10.10 Space 翻页保留一行（跨章）", () => {
  for (const motion of MOTIONS) {
    test(`PTM 10.10 ${motion.label}：自 C2 章末附近连按 Space 滚入 C3，每次翻页前可见区的最后一行（部分可见行）成为翻页后可见区的第一行`, async ({
      page,
      lib,
      bookLog,
    }) => {
      const plan = await scrollPlan(lib);
      await emulateReducedMotion(page, motion.reduce);
      await openAt(page, bookLog, plan.book, plan.c2);

      const band = await step(`起点：可见区底边在 C3 区段顶边之上 ${TURN_START_BANDS} 个可见区高处`, async () => {
        await expectDocumentNotScrollable(page);
        const view = await readView(page);
        const height = view.band.bottom - view.band.top;
        const shift = sectionOf(view, plan.c3).top - view.band.bottom - TURN_START_BANDS * height;
        await setMainScrollTop(page, view.scrollTop + Math.round(shift));
        await waitScrollSettled(page);
        const after = await readView(page);
        test.info().annotations.push({ type: "continuous-scroll-reading", description: `起点：${describeView(after)}` });
        expect(after.judged, `判定线应仍在 C2（${describeView(after)}）`).toBe(plan.c2);
        return after.band;
      });

      let pressedAt: number | null = null;
      let current: number | null = plan.c2;
      for (let i = 1; i <= MAX_CROSSING_TURNS && current !== plan.c3; i++) {
        const line = await makeLastLinePartial(page);
        if (pressedAt !== null) {
          const rest = pressedAt + KEY_GAP_MS - Date.now();
          if (rest > 0) {
            await step(`距上一次 Space 满 ${KEY_GAP_MS} ms（需求 11.6 的按键闸门）`, () => page.waitForTimeout(rest));
          }
        }
        pressedAt = Date.now();
        await spaceKeepsLine(page, line, band, `10.10 第 ${i} 次`);
        current = (await readCurrentRegion(page))?.chapterId ?? null;
      }

      await step(`至多 ${MAX_CROSSING_TURNS} 次 Space 后判定线进入 C3`, () => {
        expect(current, "当前章区段（data-current）的 data-chapter-id").toBe(plan.c3);
      });
      await expectCurrentChapter(page, plan.book.facts, plan.c3);
    });
  }
});

// ---------------------------------------------------------------------------
// 9.4 Reduced_Motion 下翻页滚动在一帧内完成
// ---------------------------------------------------------------------------

/**
 * 装采样器：下一次 `keydown`（`window` 捕获阶段，先于应用在 `window` 冒泡阶段的处理）时记下 `scrollTop`，
 * 随后逐帧记 `SAMPLE_FRAMES` 帧，结果存为页面全局属性 `SAMPLER_KEY` 上的 Promise。采样的 rAF 在按键处理
 * 之前注册，同一帧里先于应用的翻页动画帧执行。
 */
async function armTurnSampler(page: Page): Promise<void> {
  await reader(page).main.evaluate(
    (main, { key, frames }) => {
      const w = window as unknown as Record<string, unknown>;
      w[key] = new Promise<number[]>((resolve) => {
        const onKeyDown = () => {
          window.removeEventListener("keydown", onKeyDown, true);
          const samples = [main.scrollTop];
          const tick = () => {
            samples.push(main.scrollTop);
            if (samples.length > frames) resolve(samples);
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        };
        window.addEventListener("keydown", onKeyDown, true);
      });
    },
    { key: SAMPLER_KEY, frames: SAMPLE_FRAMES },
  );
}

/** 取采样结果：第 0 项为按键时的 `scrollTop`，第 k 项为按键之后第 k 帧的读数。 */
function collectTurnSamples(page: Page): Promise<number[]> {
  return page.evaluate((key) => (window as unknown as Record<string, Promise<number[]>>)[key], SAMPLER_KEY);
}

/** 第几帧到达终点：最小的 k ≥ 1，使第 k 帧起的读数都等于最后一帧（没有移动时为 0）。 */
function framesToFinal(samples: readonly number[]): number {
  const final = samples[samples.length - 1];
  let k = samples.length - 1;
  while (k > 0 && samples[k - 1] === final) k -= 1;
  return k;
}

/** 装采样器、按 `Space`、取结果，并把读数记入注解。 */
async function sampleSpaceTurn(page: Page, label: string): Promise<number[]> {
  await armTurnSampler(page);
  await step(`${label}：按 Space`, () => page.keyboard.press("Space"));
  const samples = await step(`${label}：按键之后逐帧采样 ${SAMPLE_FRAMES} 帧的 scrollTop`, () =>
    collectTurnSamples(page),
  );
  test.info().annotations.push({
    type: "continuous-scroll-reading",
    description: `${label}：scrollTop 逐帧 ${samples.join(", ")}；第 ${framesToFinal(samples)} 帧到达终点`,
  });
  return samples;
}

test.describe("PTM 9.4 Reduced_Motion 下翻页滚动瞬时完成", () => {
  test("PTM 9.4 9.7 在长章章中按 Space：no-preference 下翻页滚动跨多帧（对照），不刷新切到 Reduced_Motion 后，按键之后的第一帧即已到达终点", async ({
    page,
    lib,
    bookLog,
  }) => {
    const plan = await scrollPlan(lib);
    await emulateReducedMotion(page, false);
    await openAt(page, bookLog, plan.book, plan.long);

    await step("起点：把正文滚到长章章中（章首 + clientHeight），之后两次翻页都留在本章", async () => {
      await expectDocumentNotScrollable(page);
      const at = await readChapterScroll(page);
      await setMainScrollTop(page, at.chapterStart + at.clientHeight);
      await waitScrollSettled(page);
      const c = await readChapterScroll(page);
      expect(c.chapterId, "当前章区段").toBe(plan.long);
      expect(
        c.chapterEnd - c.scrollTop,
        `到章末还应至少有 3 屏（章首 ${px(c.chapterStart)}、章末 ${px(c.chapterEnd)}、scrollTop ${c.scrollTop}）`,
      ).toBeGreaterThanOrEqual(3 * c.clientHeight);
    });

    const smooth = await sampleSpaceTurn(page, "no-preference");
    await step("对照：no-preference 下翻页滚动向下移动，且跨多帧才到达终点", () => {
      expect(smooth[smooth.length - 1], "终点应大于按键时的 scrollTop").toBeGreaterThan(smooth[0]);
      expect(framesToFinal(smooth), "到达终点的帧序号").toBeGreaterThan(1);
    });
    const firstAt = Date.now();

    await emulateReducedMotion(page, true);
    const rest = firstAt + KEY_GAP_MS - Date.now();
    if (rest > 0) {
      await step(`距上一次 Space 满 ${KEY_GAP_MS} ms（需求 11.6 的按键闸门）`, () => page.waitForTimeout(rest));
    }
    const instant = await sampleSpaceTurn(page, "Reduced_Motion");
    await step("9.4 Reduced_Motion 下翻页滚动向下移动，且按键之后的第一帧即已是终点（在一帧内完成）", () => {
      expect(instant[instant.length - 1], "终点应大于按键时的 scrollTop").toBeGreaterThan(instant[0]);
      expect(framesToFinal(instant), "到达终点的帧序号").toBe(1);
    });
    await step("两次翻页都留在长章内", async () => {
      expect((await readCurrentRegion(page))?.chapterId ?? null, "当前章区段").toBe(plan.long);
    });
  });
});

// ---------------------------------------------------------------------------
// 10.14 全书末尾
// ---------------------------------------------------------------------------

test.describe("PTM 10.14 全书末尾", () => {
  test("PTM 10.14 在末个正文章节把 <main> 滚到底（全书末尾）后按 Space：边界提示为“没有下一页”，scrollTop 不变", async ({
    page,
    lib,
    bookLog,
  }) => {
    const plan = await scrollPlan(lib);
    await openAt(page, bookLog, plan.book, plan.last);

    const end = await step("前提：把 <main> 滚到底；窗口末章即全书末个正文章节，当前章仍为它", async () => {
      await expectDocumentNotScrollable(page);
      const at = await readMainScroll(page);
      await setMainScrollTop(page, at.scrollHeight);
      await waitScrollSettled(page);
      const view = await readView(page);
      test.info().annotations.push({ type: "continuous-scroll-reading", description: `全书末尾：${describeView(view)}` });
      expect(view.maxScrollTop - view.scrollTop, "scrollTop 与最大可滚距离之差").toBeLessThanOrEqual(EDGE_PX);
      expect(view.sections[view.sections.length - 1]?.chapterId, "窗口末章").toBe(plan.last);
      expect((await readCurrentRegion(page))?.chapterId ?? null, "当前章区段").toBe(plan.last);
      return view.scrollTop;
    });

    await step("按 Space", () => page.keyboard.press("Space"));
    await step("10.14 role=\"status\" 的边界提示唯一，文字为“没有下一页”", async () => {
      const notices = page.getByRole("status").filter({ hasText: /^没有[上下]一页$/ });
      await expect(notices, "边界提示").toHaveCount(1);
      await expect(notices, "边界提示的文字").toHaveText("没有下一页");
      await expect(notices, "边界提示可见").toBeVisible();
    });
    await step("10.14 保持滚动位置：停稳后 <main> 的 scrollTop 不变", async () => {
      await waitScrollSettled(page);
      expect((await readMainScroll(page)).scrollTop, "<main> 的 scrollTop").toBe(end);
    });
  });
});
