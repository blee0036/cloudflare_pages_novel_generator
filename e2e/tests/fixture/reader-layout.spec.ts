/**
 * 阅读器：底栏、目录当前行的底色与长串换行（reader-defect-fixes 需求 8.1–8.4、9.1、10.1；Findings_Log F-006、
 * F-007、F-008，已修复（reader-defect-fixes））。`fixture` 项目（:4611，Opaque_Mode），不装 Controlled_Clock
 * （不涉及时长）。用例标题以 `RDF <需求编号>` 开头（设计 S10）。
 *
 * ## 用书与章节（4.4：期望值运行时推导）
 *
 * - 8.x：`lib.role("longText")` 的长章 `roles.json longText.chapterIndex`，须既非首个也非末个正文章节（底栏
 *   "上一章""下一章"都可用；8.3 要换到下一个正文章节）。默认主题（不 `seedTheme`）。
 * - 9.1：`lib.role("volumes")`（3.3 (b)，带卷节点）中第一个之后有正文章节的卷段；当前章节取卷段之后的第一个
 *   正文章节（`after`），它的上一行就是该卷段末个卷节点的 Volume_Header，目录列表居中当前章时两者同时挂载。
 *   5 个主题各一个用例，首次导航前 `seedTheme(主题键)`（含 `default`）。
 * - 10.1：`roles.json longRun`（3.3 (j)）的书与章节（`chapterIndex` 为 `_toc.json` 下标），章内恰有一个由 60 个
 *   `=` 构成的段落（生成器按 EV 3.8 核对）。默认主题。
 *
 * 前提不成立是测试自身的问题（16.6），用例普通失败。所选的书、章节与读数记在注解 `layout-plan`、
 * `layout-reading` 里。
 *
 * ## 各条的做法
 *
 * - 8.1（移动 390×844）/ 8.4（桌面 1280×800）：打开该章（页面刚加载完成时底栏可见、不会自动隐藏），等底栏
 *   完整位于视口内，在同一次页面内读数中取底栏与 5 个控件（`bottomBarControls`）的边界框，连续两次读数（间隔
 *   2 个动画帧）相同后断言：每个控件左边 ≥ 0、右边 ≤ 视口宽、上下边位于底栏边界框内（也就在视口内），且 5 个
 *   控件两两不重叠（两个边界框的交集宽、高都 > 0 才算重叠，相邻边重合不算）。
 * - 8.2（移动）：同一读数中章节进度滑杆的宽度 ≥ 48 px。
 * - 8.3（移动）：点击底栏"下一章 (→)"按钮（不加 `force`，Playwright 照常做可见、稳定、可点、不被遮挡的检查），
 *   按 8.1 判定渲染了下一个正文章节（`expectCurrentChapter` 另等到 URL 的 `ch` 写回为该下标）。
 * - 9.1（桌面）：打开当前章节，断言主题，打开目录抽屉（检索框为空），等已挂载行连续 2 帧不变（`readTocList`），
 *   核对前提：已挂载行中至少 1 个 `<h3>`（Volume_Header），当前章节行是唯一带 `aria-current="true"` 的行。再取
 *   全部已挂载的 Volume_Header 与 Current_Row 的计算 `background-color`，在页面内画到 1×1 的画布上读回 8 位
 *   RGBA（`color-mix()` 的计算值在 Chromium 中序列化为 `color(srgb …)`，`--card-bg` 则是 `rgb(…)`，两种写法
 *   都经画布换算为同一表示），断言每个 Volume_Header 的 RGBA 都与 Current_Row 的不同。
 * - 10.1（桌面 / 移动）：打开该章，核对前提（至少 1 个段落含 ≥ 58 个连续 `=`），等 2 个动画帧后对 `<article>`
 *   内的全部正文 `<p>` 断言 `scrollWidth ≤ clientWidth`，且边界框右边 ≤ `<article>` 内容框右边（边界框右边减
 *   右边框与右内边距）+ 1 px。
 */
import type { Page } from "@playwright/test";
import { expect, test, type BookLog, type Lib } from "../../support/fixtures";
import { bottomBarControls, reader, tocDrawer } from "../../support/locators";
import {
  bookUnderTest,
  expectCurrentChapter,
  openReader,
  openTocDrawer,
  readTocList,
  waitFrames,
  type BookUnderTest,
} from "../../support/reader";
import { VIEWPORTS } from "../../support/settings";
import { step } from "../../support/step";
import { THEME_KEYS, describeTheme } from "../../support/theme";

// ---------------------------------------------------------------------------
// 常量（取自需求条文）
// ---------------------------------------------------------------------------

/** 8.2：移动视口下章节进度滑杆的最小宽度（px）。 */
const SLIDER_MIN_WIDTH_PX = 48;

/** 10.1：段落边界框右边超出 `<article>` 内容框右边的上限（px）。 */
const ARTICLE_OVERFLOW_PX = 1;

/** 10.1 / 10.2：长串的最小长度（连续且没有断行机会的字符数）。 */
const LONG_RUN_MIN = 58;

/**
 * 8.1 / 8.4 的几何比较只吸收浮点误差（布局坐标是 1/64 px 的整数倍，比较本身不设容差）。
 * 重叠以交集的宽、高都大于它为准，相邻边重合不算重叠。
 */
const GEOMETRY_EPS_PX = 0.01;

/** 等底栏读数稳定：每次等 2 帧，最多这么多次。 */
const SETTLE_MAX_ROUNDS = 30;

// ---------------------------------------------------------------------------
// 用书与章节
// ---------------------------------------------------------------------------

interface ChapterPlan {
  book: BookUnderTest;
  /** 打开的章节下标。 */
  chapter: number;
  /** 其后的下一个正文章节下标。 */
  next: number;
}

/** 8.x：`roles.json longText.chapterIndex`，须既非首个也非末个正文章节。 */
async function barChapterPlan(lib: Lib): Promise<ChapterPlan> {
  const id = lib.role("longText");
  const book = await bookUnderTest(lib, id);
  return step("选定章节（roles.json longText.chapterIndex，既非首也非末的正文章节）", () => {
    const { facts } = book;
    const chapter = lib.fixtureRoles().longText.chapterIndex;
    const ordinal = facts.bodyOrdinals[chapter];
    if (ordinal === null || ordinal === undefined) {
      throw new Error(`${id}：longText.chapterIndex（下标 ${chapter}）不是正文章节`);
    }
    const prev = facts.bodyIndices[ordinal - 1];
    const next = facts.bodyIndices[ordinal + 1];
    if (prev === undefined || next === undefined) {
      throw new Error(`${id}：下标 ${chapter}（正文第 ${ordinal + 1} / ${facts.bodyCount} 章）须既非首个也非末个`);
    }
    test.info().annotations.push({
      type: "layout-plan",
      description: `书 ${id} 下标 ${chapter}「${facts.titles[chapter]}」；下一个正文章节 下标 ${next}「${facts.titles[next]}」`,
    });
    return { book, chapter, next };
  });
}

interface TocPlan {
  book: BookUnderTest;
  /** 当前章节：卷段之后的第一个正文章节。 */
  current: number;
  /** 卷段末个卷节点的下标（当前章节的上一行）。 */
  volume: number;
}

/** 9.1：volumes 书中第一个之后有正文章节的卷段。 */
async function tocPlan(lib: Lib): Promise<TocPlan> {
  const id = lib.role("volumes");
  const book = await bookUnderTest(lib, id);
  return step("选定当前章节（volumes 书第一个之后有正文章节的卷段的 after）", () => {
    const run = book.facts.volumeRuns.find((r) => r.after !== null);
    if (run === undefined || run.after === null) {
      throw new Error(`${id} 没有之后有正文章节的卷段（3.3 (b)）`);
    }
    const { titles } = book.facts;
    test.info().annotations.push({
      type: "layout-plan",
      description: `书 ${id}：卷节点 下标 ${run.last}「${titles[run.last]}」，当前章节 下标 ${run.after}「${titles[run.after]}」`,
    });
    return { book, current: run.after, volume: run.last };
  });
}

/** 打开 `chapter` 并按 8.1 判定当前章节。 */
async function openAt(page: Page, bookLog: BookLog, book: BookUnderTest, chapter: number): Promise<void> {
  await openReader(page, bookLog, book, chapter);
  await expectCurrentChapter(page, book.facts, chapter);
}

// ---------------------------------------------------------------------------
// RDF 8.1–8.4 底栏
// ---------------------------------------------------------------------------

/** 边界框（视口坐标，px）。 */
interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}

interface BarLayout {
  /** 视口（`page.viewportSize()`）。 */
  viewport: { width: number; height: number };
  /** 底栏 `<footer>` 的边界框。 */
  bar: Box;
  /** 5 个控件，从左到右（`bottomBarControls` 的顺序）。 */
  controls: { label: string; box: Box }[];
}

/** 在同一次页面内读数中取底栏与 5 个控件的边界框（只读）。 */
async function readBarLayoutOnce(page: Page): Promise<BarLayout> {
  const viewport = page.viewportSize();
  if (viewport === null) throw new Error("页面没有固定视口");
  const controls = bottomBarControls(page);
  const barHandle = await reader(page).bottomBar.elementHandle();
  const found = await Promise.all(controls.map((c) => c.locator.elementHandle()));
  const handles = found.filter((h): h is NonNullable<typeof h> => h !== null);
  if (barHandle === null || handles.length !== controls.length) {
    await Promise.all([barHandle?.dispose(), ...handles.map((h) => h.dispose())]);
    throw new Error("找不到底栏或其中的控件");
  }
  try {
    const boxes = await page.evaluate(
      ({ bar, els }) => {
        const boxOf = (el: Element) => {
          const r = el.getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
        };
        return { bar: boxOf(bar), controls: els.map((el) => boxOf(el)) };
      },
      { bar: barHandle, els: handles },
    );
    return {
      viewport,
      bar: boxes.bar,
      controls: controls.map((c, i) => ({ label: c.label, box: boxes.controls[i] })),
    };
  } finally {
    await Promise.all([barHandle.dispose(), ...handles.map((h) => h.dispose())]);
  }
}

/** 等连续两次读数（间隔 2 帧）相同后返回（底栏的 `transform` 带过渡）。 */
async function readBarLayout(page: Page): Promise<BarLayout> {
  let previous = await readBarLayoutOnce(page);
  for (let round = 0; round < SETTLE_MAX_ROUNDS; round++) {
    await waitFrames(page);
    const current = await readBarLayoutOnce(page);
    if (JSON.stringify(current) === JSON.stringify(previous)) return current;
    previous = current;
  }
  throw new Error(`底栏的边界框在 ${SETTLE_MAX_ROUNDS} × 2 帧内未稳定`);
}

function describeBox(b: Box): string {
  return `[${b.left}, ${b.right}] × [${b.top}, ${b.bottom}]（${b.width}×${b.height}）`;
}

/** 8.1 / 8.4 的全部条件；返回不满足的项（空数组即满足）。 */
function barProblems(layout: BarLayout): string[] {
  const { viewport, bar, controls } = layout;
  const problems: string[] = [];
  for (const { label, box } of controls) {
    if (!(box.width > 0 && box.height > 0)) problems.push(`${label} 的边界框为空（${describeBox(box)}）`);
    if (box.left < -GEOMETRY_EPS_PX) problems.push(`${label} 的左边 ${box.left} < 0`);
    if (box.right > viewport.width + GEOMETRY_EPS_PX) {
      problems.push(`${label} 的右边 ${box.right} > 视口宽 ${viewport.width}`);
    }
    if (box.top < bar.top - GEOMETRY_EPS_PX || box.bottom > bar.bottom + GEOMETRY_EPS_PX) {
      problems.push(`${label} 的上下边 [${box.top}, ${box.bottom}] 不在底栏边界框 [${bar.top}, ${bar.bottom}] 内`);
    }
    if (box.top < -GEOMETRY_EPS_PX || box.bottom > viewport.height + GEOMETRY_EPS_PX) {
      problems.push(`${label} 的上下边 [${box.top}, ${box.bottom}] 不在视口 [0, ${viewport.height}] 内`);
    }
  }
  for (let i = 0; i < controls.length; i++) {
    for (let j = i + 1; j < controls.length; j++) {
      const a = controls[i].box;
      const b = controls[j].box;
      const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (overlapX > GEOMETRY_EPS_PX && overlapY > GEOMETRY_EPS_PX) {
        problems.push(`${controls[i].label} 与 ${controls[j].label} 重叠（交集 ${overlapX}×${overlapY}）`);
      }
    }
  }
  return problems;
}

/** 底栏可见（完整位于视口内）、5 个控件各恰有 1 个且可见后，返回稳定的读数（记入注解）。 */
async function readVisibleBar(page: Page): Promise<BarLayout> {
  await step("底栏完整位于视口内，5 个控件（上一章、目录、章节进度滑杆、全文检索、下一章）各恰有 1 个且可见", async () => {
    await expect(reader(page).bottomBar, "底栏").toBeInViewport({ ratio: 1 });
    for (const { label, locator } of bottomBarControls(page)) {
      await expect(locator, label).toHaveCount(1);
      await expect(locator, label).toBeVisible();
    }
  });
  return step("读底栏与 5 个控件的边界框（连续两次读数相同）", async () => {
    const layout = await readBarLayout(page);
    test.info().annotations.push({
      type: "layout-reading",
      description:
        `视口 ${layout.viewport.width}×${layout.viewport.height}；底栏 ${describeBox(layout.bar)}；` +
        layout.controls.map((c) => `${c.label} ${describeBox(c.box)}`).join("；"),
    });
    return layout;
  });
}

async function expectBarFits(page: Page, req: string, viewportLabel: string): Promise<BarLayout> {
  const layout = await readVisibleBar(page);
  await step(
    `${req} ${viewportLabel}：5 个控件的边界框左边 ≥ 0、右边 ≤ ${layout.viewport.width}、上下边位于底栏边界框内，且两两不重叠`,
    () => {
      expect(barProblems(layout), "底栏控件的边界框").toEqual([]);
    },
  );
  return layout;
}

const MOBILE_LABEL = `移动 ${VIEWPORTS.mobile.width}×${VIEWPORTS.mobile.height}`;
const DESKTOP_LABEL = `桌面 ${VIEWPORTS.desktop.width}×${VIEWPORTS.desktop.height}`;

test.describe(`RDF 8.1–8.3 底栏（${MOBILE_LABEL}）`, () => {
  test.use({ viewport: VIEWPORTS.mobile });

  test(`RDF 8.1 ${MOBILE_LABEL}：底栏 5 个控件的边界框都完整落在视口内（左边 ≥ 0、右边 ≤ 390、上下边位于底栏边界框内），且两两不重叠`, async ({
    page,
    lib,
    bookLog,
  }) => {
    const plan = await barChapterPlan(lib);
    await openAt(page, bookLog, plan.book, plan.chapter);
    await expectBarFits(page, "RDF 8.1", MOBILE_LABEL);
  });

  test(`RDF 8.2 ${MOBILE_LABEL}：章节进度滑杆的宽度 ≥ ${SLIDER_MIN_WIDTH_PX} px`, async ({ page, lib, bookLog }) => {
    const plan = await barChapterPlan(lib);
    await openAt(page, bookLog, plan.book, plan.chapter);
    const layout = await readVisibleBar(page);
    await step(`RDF 8.2 章节进度滑杆的宽度 ≥ ${SLIDER_MIN_WIDTH_PX} px`, () => {
      const slider = layout.controls.find((c) => c.label === "章节进度滑杆");
      if (slider === undefined) throw new Error("读数中没有章节进度滑杆");
      expect(slider.box.width, `章节进度滑杆的宽度（${describeBox(slider.box)}）`).toBeGreaterThanOrEqual(
        SLIDER_MIN_WIDTH_PX,
      );
    });
  });

  test(`RDF 8.3 ${MOBILE_LABEL}：点击底栏“下一章 (→)”按钮（不使用强制点击），渲染下一个正文章节`, async ({
    page,
    lib,
    bookLog,
  }) => {
    const plan = await barChapterPlan(lib);
    await openAt(page, bookLog, plan.book, plan.chapter);
    await step("RDF 8.3 点击底栏“下一章 (→)”按钮（不加 force）", async () => {
      await reader(page).nextChapterButton.click();
    });
    await expectCurrentChapter(page, plan.book.facts, plan.next);
  });
});

test.describe(`RDF 8.4 底栏（${DESKTOP_LABEL}）`, () => {
  test.use({ viewport: VIEWPORTS.desktop });

  test(`RDF 8.4 ${DESKTOP_LABEL}：底栏 5 个控件的边界框都完整落在视口内（左边 ≥ 0、右边 ≤ 1280、上下边位于底栏边界框内），且两两不重叠`, async ({
    page,
    lib,
    bookLog,
  }) => {
    const plan = await barChapterPlan(lib);
    await openAt(page, bookLog, plan.book, plan.chapter);
    await expectBarFits(page, "RDF 8.4", DESKTOP_LABEL);
  });
});

// ---------------------------------------------------------------------------
// RDF 9.1 Volume_Header 与 Current_Row 的底色（5 个主题）
// ---------------------------------------------------------------------------

/** 一个计算颜色：原文与经画布换算的 8 位 RGBA。 */
interface ColorReading {
  css: string;
  rgba: [number, number, number, number];
}

interface TocColors {
  volumes: { title: string; color: ColorReading }[];
  current: ColorReading;
}

/**
 * 读全部已挂载的 Volume_Header 与 Current_Row 的计算 `background-color`，在页面内画到 1×1 的画布上读回
 * 8 位 RGBA。画布不认识的颜色（赋给 `fillStyle` 后被忽略）抛错。只读，不改动页面（画布不挂进文档）。
 */
async function readTocColors(page: Page, currentTitle: string): Promise<TocColors> {
  const drawer = tocDrawer(page);
  const current = await drawer.chapter(currentTitle).elementHandle();
  if (current === null) throw new Error(`找不到当前章节行「${currentTitle}」`);
  try {
    return await drawer.volumes.evaluateAll((headers, currentRow) => {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (ctx === null) throw new Error("取不到 2D 画布");
      const toRgba = (css: string): [number, number, number, number] => {
        // 无效颜色赋给 fillStyle 会被忽略：先后以两个不同的颜色打底，结果不同即说明没被接受
        ctx.fillStyle = "#000000";
        ctx.fillStyle = css;
        const onBlack = String(ctx.fillStyle);
        ctx.fillStyle = "#ffffff";
        ctx.fillStyle = css;
        if (String(ctx.fillStyle) !== onBlack) throw new Error(`画布不认识颜色 ${css}`);
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillRect(0, 0, 1, 1);
        const d = ctx.getImageData(0, 0, 1, 1).data;
        return [d[0], d[1], d[2], d[3]];
      };
      const read = (el: Element) => {
        const css = getComputedStyle(el).backgroundColor;
        return { css, rgba: toRgba(css) };
      };
      return {
        volumes: headers.map((h) => ({ title: (h.textContent ?? "").trim(), color: read(h) })),
        current: read(currentRow as Element),
      };
    }, current);
  } finally {
    await current.dispose();
  }
}

function describeColor(c: ColorReading): string {
  return `${c.css} → rgba(${c.rgba.join(", ")})`;
}

test.describe("RDF 9.1 目录抽屉中 Volume_Header 与 Current_Row 的底色（5 个主题）", () => {
  for (const key of THEME_KEYS) {
    test(`RDF 9.1 ${describeTheme(key)}：目录抽屉中同时挂载 Volume_Header 与 Current_Row 时，两者的计算 background-color 换算为同一 RGBA 表示后不同`, async ({
      page,
      lib,
      bookLog,
      seedTheme,
      assertTheme,
    }) => {
      await seedTheme(key);
      const plan = await tocPlan(lib);
      const { facts } = plan.book;
      const currentTitle = facts.titles[plan.current];
      await openAt(page, bookLog, plan.book, plan.current);
      await assertTheme(key);
      await openTocDrawer(page);

      const drawer = tocDrawer(page);
      await step("前提：已挂载至少 1 个 Volume_Header（<h3>），当前章节行是唯一带 aria-current=\"true\" 的行", async () => {
        await expect(drawer.filter, "目录抽屉的章节检索框应为空").toHaveValue("");
        const list = await readTocList(page);
        const headers = list.rows.filter((r) => r.tag === "H3").map((r) => r.index);
        const marked = list.rows.filter((r) => r.ariaCurrent === "true").map((r) => r.index);
        test.info().annotations.push({
          type: "layout-reading",
          description: `已挂载行 ${list.rows.length} 个；Volume_Header 下标 [${headers.join(", ")}]；带 aria-current 的行 [${marked.join(", ")}]`,
        });
        expect(headers, "已挂载的 Volume_Header").toContain(plan.volume);
        expect(marked, "带 aria-current=\"true\" 的已挂载行").toEqual([plan.current]);
        await expect(drawer.volumes.first(), "Volume_Header").toBeVisible();
        await expect(drawer.chapter(currentTitle), "当前章节行").toHaveCount(1);
        await expect(drawer.chapter(currentTitle), "当前章节行").toHaveAttribute("aria-current", "true");
      });

      const colors = await step("读 Volume_Header 与 Current_Row 的计算 background-color（经画布换算为 8 位 RGBA）", async () => {
        const read = await readTocColors(page, currentTitle);
        test.info().annotations.push({
          type: "layout-reading",
          description:
            `${key}：Current_Row「${currentTitle}」${describeColor(read.current)}；` +
            read.volumes.map((v) => `Volume_Header「${v.title}」${describeColor(v.color)}`).join("；"),
        });
        return read;
      });

      await step(`RDF 9.1 ${key}：每个已挂载的 Volume_Header 的底色都与 Current_Row 的不同`, () => {
        expect(colors.volumes.length, "已挂载的 Volume_Header 数").toBeGreaterThan(0);
        const same = colors.volumes
          .filter((v) => v.color.rgba.every((channel, i) => channel === colors.current.rgba[i]))
          .map((v) => `「${v.title}」${describeColor(v.color)}`);
        expect(same, `与 Current_Row（${describeColor(colors.current)}）底色相同的 Volume_Header`).toEqual([]);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// RDF 10.1 长串不越出版心（桌面 / 移动）
// ---------------------------------------------------------------------------

interface ParagraphFit {
  /** 段落序号（从 0 起，`<article>` 内 `<p>` 的文档顺序）。 */
  index: number;
  /** 段落文本的前 20 个字符（报告用）。 */
  preview: string;
  /** 段落含 ≥ `LONG_RUN_MIN` 个连续 `=`。 */
  longRun: boolean;
  scrollWidth: number;
  clientWidth: number;
  /** 边界框右边（视口坐标）。 */
  right: number;
}

interface ArticleFit {
  /** `<article>` 内容框右边：边界框右边减右边框与右内边距（视口坐标）。 */
  contentRight: number;
  paragraphs: ParagraphFit[];
}

/** 读 `<article>` 内容框右边与全部正文段落的宽度读数（只读；段落经 `locators.ts` 定位）。 */
async function readArticleFit(page: Page): Promise<ArticleFit> {
  const view = reader(page);
  const article = await view.article.elementHandle();
  if (article === null) throw new Error("找不到正文 <article>");
  try {
    return await view.paragraphs.evaluateAll(
      (elements, { articleEl, min }) => {
        const host = articleEl as Element;
        const style = getComputedStyle(host);
        const contentRight =
          host.getBoundingClientRect().right -
          Number.parseFloat(style.borderRightWidth) -
          Number.parseFloat(style.paddingRight);
        const run = new RegExp(`={${min},}`);
        return {
          contentRight,
          paragraphs: elements.map((el, index) => {
            const text = el.textContent ?? "";
            return {
              index,
              preview: text.slice(0, 20),
              longRun: run.test(text),
              scrollWidth: el.scrollWidth,
              clientWidth: el.clientWidth,
              right: el.getBoundingClientRect().right,
            };
          }),
        };
      },
      { articleEl: article, min: LONG_RUN_MIN },
    );
  } finally {
    await article.dispose();
  }
}

function fitProblems(fit: ArticleFit): string[] {
  const problems: string[] = [];
  for (const p of fit.paragraphs) {
    const where = `第 ${p.index} 段「${p.preview}」${p.longRun ? "（长串段落）" : ""}`;
    if (p.scrollWidth > p.clientWidth) problems.push(`${where} scrollWidth ${p.scrollWidth} > clientWidth ${p.clientWidth}`);
    if (p.right > fit.contentRight + ARTICLE_OVERFLOW_PX) {
      problems.push(`${where}右边 ${p.right} 超出 <article> 内容框右边 ${fit.contentRight} 达 ${ARTICLE_OVERFLOW_PX} px 以上`);
    }
  }
  return problems;
}

const LONG_RUN_VIEWPORTS = [
  { key: "desktop", label: DESKTOP_LABEL },
  { key: "mobile", label: MOBILE_LABEL },
] as const;

for (const viewport of LONG_RUN_VIEWPORTS) {
  test.describe(`RDF 10.1 长串不越出版心（${viewport.label}）`, () => {
    test.use({ viewport: VIEWPORTS[viewport.key] });

    test(`RDF 10.1 ${viewport.label}：roles.longRun 那一章的全部正文段落（含 ≥ ${LONG_RUN_MIN} 个连续“=”的段落）scrollWidth ≤ clientWidth，且边界框右边不超过 <article> 内容框右边 ${ARTICLE_OVERFLOW_PX} px 以上`, async ({
      page,
      lib,
      bookLog,
    }) => {
      const { id, chapterIndex } = lib.fixtureRoles().longRun;
      const book = await bookUnderTest(lib, id);
      test.info().annotations.push({
        type: "layout-plan",
        description: `roles.longRun：书 ${id} 下标 ${chapterIndex}「${book.facts.titles[chapterIndex]}」`,
      });
      await openAt(page, bookLog, book, chapterIndex);

      const fit = await step("等 2 个动画帧后读 <article> 内容框右边与全部正文段落的宽度", async () => {
        await waitFrames(page);
        const read = await readArticleFit(page);
        const longRuns = read.paragraphs.filter((p) => p.longRun);
        test.info().annotations.push({
          type: "layout-reading",
          description:
            `${viewport.label}：<article> 内容框右边 ${read.contentRight}；段落 ${read.paragraphs.length} 个；` +
            longRuns.map((p) => `长串段落 第 ${p.index} 段 scrollWidth ${p.scrollWidth}、clientWidth ${p.clientWidth}、右边 ${p.right}`).join("；"),
        });
        return read;
      });

      await step(`前提：本章至少 1 个段落含 ≥ ${LONG_RUN_MIN} 个连续“=”（3.3 (j)）`, () => {
        expect(fit.paragraphs.filter((p) => p.longRun).length, "长串段落数").toBeGreaterThanOrEqual(1);
      });

      await step(`RDF 10.1 ${viewport.label}：全部正文段落 scrollWidth ≤ clientWidth，右边 ≤ <article> 内容框右边 + ${ARTICLE_OVERFLOW_PX} px`, () => {
        expect(fitProblems(fit), "越出版心的段落").toEqual([]);
      });
    });
  });
}
