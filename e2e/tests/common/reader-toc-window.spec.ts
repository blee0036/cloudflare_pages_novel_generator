/**
 * 超大目录的窗口化：目录抽屉与详情弹窗章节网格的挂载上界（需求 8.7、8.8、14.1；Checklist H1）。
 * `common/`：`fixture` 与 `real` 两个项目都跑（Opaque_Mode、桌面视口、默认主题）。
 *
 * ## 用书
 *
 * `lib.role("huge")`：fixture 为 3.3 (e) 的 ≥ 3,000 节点的书，real 为《极品全能高手》（gz ≥ 20 MB，
 * `bookUnderTest` 把用例超时设为 `TIMEOUTS.bigBookTest`，6.8）。节点数在运行时由 `_toc.json` 推导
 * （4.4），只核对它不少于 `HUGE_MIN_NODES`。real 下该书不具备 4.7 的特征时按 `[4.7]` 跳过。
 *
 * ## 取样与上界（14.1：Structural_Bound 为硬断言，任一位置超出即失败）
 *
 * 两个用例都把滚动容器依次直接设到顶部、中部、底部（`scrollTocList` / `scrollDetailGrid`，定义见
 * `SCROLL_POSITION_LABELS`），再等已挂载集合连续 2 个动画帧不变（`readTocList` / `readDetailGrid`）
 * 后在该位置取样：
 *
 * - 8.7 目录抽屉（检索框为空）：已挂载的行元素（卷标题与章节按钮合计，不含 `aria-hidden` 的撑高
 *   占位）数 ≤ ⌈列表 clientHeight / 44⌉ + 17；可视区 [scrollTop, scrollTop + clientHeight) 内的每个
 *   44 px 行位（第 i 个占列表内容的 [44i, 44i + 44) px，i < 节点数）都被一个已挂载的行元素完整覆盖
 *   （容差 `SLOT_TOLERANCE_PX`，吸收亚像素取整）。
 * - 8.8 详情弹窗（`/?book=<id>` 深链接；real 书架有 7,681 本，这本书不在首批书卡里）：已挂载的网格
 *   单元数 ≤ (⌈网格滚动容器 clientHeight / 52⌉ + 17) × 列数，列数取网格计算样式的列轨道数（网格
 *   实际渲染的列数）。
 *
 * 44、52 与 17 是需求原文的字面值（与 `src/utils/listWindow.ts` 的 `ROW_HEIGHT`、`GRID_ROW_PITCH`、
 * `2 × OVERSCAN + 1` 相同）；上界按需求取值，不随应用常量变化。
 *
 * 每个用例把三处的读数写进输出目录的 `window-bounds.json` 并附为 `window-bounds`（中途失败也照附
 * 已取得的读数），供核对实测值与上界。
 *
 * ## RS-09
 *
 * `toc-huge-middle` 只属于 real，由标题为 `SHOT_TESTS.tocWindow.title` 的 8.7 用例在中部取样之后
 * 拍摄；fixture 下 `shot()` 不拍摄。默认主题（不 `seedTheme`）。
 *
 * 本文件不装 Controlled_Clock：稳定判定依赖 `requestAnimationFrame`（6.4 没有要求这里控制时间），
 * 等待只依据 `[book-load]` 行、`scroll` 事件与 DOM 状态。
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TestInfo } from "@playwright/test";
import { SHOT_TESTS } from "../../review/catalog";
import { expect, test } from "../../support/fixtures";
import { HUGE_MIN_NODES, type TocFacts } from "../../support/library";
import { detailModal, tocDrawer } from "../../support/locators";
import {
  SCROLL_POSITIONS,
  SCROLL_POSITION_LABELS,
  bookUnderTest,
  expectCurrentChapter,
  openReader,
  openTocDrawer,
  readDetailGrid,
  readTocList,
  scrollDetailGrid,
  scrollTocList,
  type BookUnderTest,
  type DetailGridSnapshot,
  type ScrollApplied,
  type ScrollPosition,
  type TocListSnapshot,
} from "../../support/reader";
import { step } from "../../support/step";

// ---------------------------------------------------------------------------
// 需求中的字面值
// ---------------------------------------------------------------------------

/** 8.7 的行位高度（px）。 */
const TOC_SLOT_PX = 44;
/** 8.8 的网格行距（px）。 */
const GRID_PITCH_PX = 52;
/** 8.7 / 8.8 上界中的余量行数。 */
const BOUND_EXTRA_ROWS = 17;
/** 行位覆盖判定与滚动定位的容差（px）。 */
const SLOT_TOLERANCE_PX = 1;

/** 读数附件的名称与文件名。 */
const BOUNDS_ATTACHMENT = "window-bounds";
const BOUNDS_FILE = "window-bounds.json";

// ---------------------------------------------------------------------------
// 共用
// ---------------------------------------------------------------------------

/** 用例前提：该书节点数 ≥ `HUGE_MIN_NODES`（3.3 (e)、4.7）。 */
function expectHugeBook(book: BookUnderTest): void {
  expect(
    book.facts.nodeCount,
    `${book.id} 的节点数应 ≥ ${HUGE_MIN_NODES}（fixture 3.3 (e)，real 4.7）`,
  ).toBeGreaterThanOrEqual(HUGE_MIN_NODES);
}

/** 滚动定位的前提：容器报告的 `scrollTop` 与按定义算出的目标相差 ≤ 容差。 */
function expectScrolledTo(applied: ScrollApplied, measuredScrollTop: number): void {
  const label = SCROLL_POSITION_LABELS[applied.position];
  expect(
    Math.abs(measuredScrollTop - applied.target),
    `应停在${label}：目标 ${applied.target}，实际 ${measuredScrollTop}` +
      `（scrollHeight ${applied.scrollHeight}，clientHeight ${applied.clientHeight}）`,
  ).toBeLessThanOrEqual(SLOT_TOLERANCE_PX);
}

/** 写 `window-bounds.json` 并附为 `window-bounds`。 */
async function attachBounds(testInfo: TestInfo, records: readonly object[]): Promise<void> {
  const file = testInfo.outputPath(BOUNDS_FILE);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(records, null, 2)}\n`, "utf8");
  await testInfo.attach(BOUNDS_ATTACHMENT, { path: file, contentType: "application/json" });
}

/** 前若干项加"等 N 个"，用于报错信息。 */
function listSome(values: readonly number[], limit = 12): string {
  const shown = values.slice(0, limit).join(", ");
  return values.length > limit ? `${shown} 等 ${values.length} 个` : shown;
}

// ---------------------------------------------------------------------------
// 8.7 目录抽屉
// ---------------------------------------------------------------------------

/** 8.7 在一处取样位置的读数。 */
interface TocWindowRecord {
  view: "toc-drawer";
  position: ScrollPosition;
  target: number;
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  /** 已挂载的行元素数（卷标题与章节按钮合计）。 */
  mounted: number;
  /** ⌈clientHeight / 44⌉ + 17。 */
  limit: number;
  /** 已挂载行的首末列表项下标。 */
  mountedFirst: number | null;
  mountedLast: number | null;
  /** 可视区内的首末行位。 */
  slotFirst: number;
  slotLast: number;
  /** 没有被已挂载的行元素完整覆盖的行位。 */
  missingSlots: number[];
  frames: number;
}

function measureTocWindow(
  list: TocListSnapshot,
  facts: TocFacts,
  applied: ScrollApplied,
): TocWindowRecord {
  const { rows, scrollTop, clientHeight } = list;
  const slotFirst = Math.floor(scrollTop / TOC_SLOT_PX);
  const slotLast = Math.min(facts.nodeCount - 1, Math.ceil((scrollTop + clientHeight) / TOC_SLOT_PX) - 1);
  const missingSlots: number[] = [];
  for (let i = slotFirst; i <= slotLast; i++) {
    const top = i * TOC_SLOT_PX;
    const covered = rows.some(
      (r) => r.offset <= top + SLOT_TOLERANCE_PX && r.offset + r.height >= top + TOC_SLOT_PX - SLOT_TOLERANCE_PX,
    );
    if (!covered) missingSlots.push(i);
  }
  return {
    view: "toc-drawer",
    position: applied.position,
    target: applied.target,
    scrollTop,
    clientHeight,
    scrollHeight: list.scrollHeight,
    mounted: rows.length,
    limit: Math.ceil(clientHeight / TOC_SLOT_PX) + BOUND_EXTRA_ROWS,
    mountedFirst: rows.length > 0 ? rows[0].index : null,
    mountedLast: rows.length > 0 ? rows[rows.length - 1].index : null,
    slotFirst,
    slotLast,
    missingSlots,
    frames: list.frames,
  };
}

// ---------------------------------------------------------------------------
// 8.8 详情弹窗的章节网格
// ---------------------------------------------------------------------------

/** 8.8 在一处取样位置的读数。 */
interface GridWindowRecord {
  view: "detail-grid";
  position: ScrollPosition;
  target: number;
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  /** 网格实际渲染的列数（列轨道数）。 */
  columns: number;
  /** 已挂载的网格单元数。 */
  mounted: number;
  /** (⌈clientHeight / 52⌉ + 17) × 列数。 */
  limit: number;
  /** 首末已挂载单元的文本（核对取样位置用）。 */
  firstCell: string | null;
  lastCell: string | null;
  frames: number;
}

function measureGridWindow(grid: DetailGridSnapshot, applied: ScrollApplied): GridWindowRecord {
  const { cells } = grid;
  return {
    view: "detail-grid",
    position: applied.position,
    target: applied.target,
    scrollTop: grid.scrollTop,
    clientHeight: grid.clientHeight,
    scrollHeight: grid.scrollHeight,
    columns: grid.columns,
    mounted: cells.length,
    limit: (Math.ceil(grid.clientHeight / GRID_PITCH_PX) + BOUND_EXTRA_ROWS) * grid.columns,
    firstCell: cells.length > 0 ? cells[0].text : null,
    lastCell: cells.length > 0 ? cells[cells.length - 1].text : null,
    frames: grid.frames,
  };
}

/** `/?book=<id>`（`URLSearchParams` 负责百分号编码）。 */
function detailPath(id: string): string {
  return `/?${new URLSearchParams({ book: id }).toString()}`;
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

test.describe("8.7 8.8 超大目录的窗口化（H1）", () => {
  test(SHOT_TESTS.tocWindow.title, async ({ page, lib, bookLog, shot }, testInfo) => {
    // RS-09 为默认主题（localStorage 中没有已存储的主题），不 seedTheme
    const book = await bookUnderTest(lib, lib.role("huge"));
    const { facts } = book;
    expectHugeBook(book);
    const start = facts.bodyIndices[0];

    await openReader(page, bookLog, book, start);
    await expectCurrentChapter(page, facts, start);
    await openTocDrawer(page);
    await step("目录抽屉的章节检索框为空", async () => {
      await expect(tocDrawer(page).filter).toHaveValue("");
    });

    const records: TocWindowRecord[] = [];
    try {
      for (const position of SCROLL_POSITIONS) {
        const label = SCROLL_POSITION_LABELS[position];
        const { list, applied } = await step(
          `把目录列表滚到${label}，等已挂载行集合连续 2 个动画帧不变`,
          async () => {
            const scrolled = await scrollTocList(page, position);
            const snapshot = await readTocList(page);
            expectScrolledTo(scrolled, snapshot.scrollTop);
            return { list: snapshot, applied: scrolled };
          },
        );
        const record = measureTocWindow(list, facts, applied);
        records.push(record);

        await step(
          `8.7 ${label}：已挂载 ${record.mounted} 行 ≤ ⌈${record.clientHeight} / ${TOC_SLOT_PX}⌉ + ${BOUND_EXTRA_ROWS} = ${record.limit}`,
          () => {
            expect(
              record.mounted,
              `${label}已挂载的行元素数（列表项 ${record.mountedFirst}–${record.mountedLast}）应 ≤ ${record.limit}（8.7、14.1）`,
            ).toBeLessThanOrEqual(record.limit);
          },
        );
        await step(
          `8.7 ${label}：可视区内的行位 ${record.slotFirst}–${record.slotLast} 都有行元素`,
          () => {
            expect(
              record.missingSlots,
              `${label}可视区内没有行元素的 ${TOC_SLOT_PX} px 行位（已挂载列表项 ${record.mountedFirst}–${record.mountedLast}；` +
                `缺 ${listSome(record.missingSlots)}）（8.7、14.1）`,
            ).toEqual([]);
          },
        );

        if (position === "middle") {
          if (shot.applies("toc-huge-middle")) {
            await step("RS-09 画面：列表仍停在中部，已挂载行集合与取样时相同", async () => {
              const again = await readTocList(page);
              expect(again.scrollTop, "列表的 scrollTop").toBe(list.scrollTop);
              expect(again.rows.map((r) => r.index), "已挂载的列表项").toEqual(list.rows.map((r) => r.index));
            });
          }
          await shot("toc-huge-middle");
        }
      }
    } finally {
      await attachBounds(testInfo, records);
    }
  });

  test("8.8 ≥ 3,000 节点的书：详情弹窗章节网格顶、中、底三处的挂载单元数上界", async ({ page, lib }, testInfo) => {
    // 只读 `_toc.json`，不加载 `.txt.gz`；gz ≥ 20 MB 时仍按 6.8 取 `bigBookTest` 超时（用例涉及该书）
    const book = await bookUnderTest(lib, lib.role("huge"));
    const { facts } = book;
    expectHugeBook(book);
    const summary = await lib.book(book.id);
    const modal = detailModal(page);

    await step(`直接访问 /?book=${book.id}，等详情弹窗的章节网格挂载`, async () => {
      await page.goto(detailPath(book.id));
      await expect(modal.heading(summary.title), "详情弹窗应以该书书名为二级标题").toBeVisible();
      await expect(modal.chapter(facts.titles[0]).first(), "网格应列出该书的首个节点").toBeVisible();
      await expect(modal.loading).toHaveCount(0);
      await expect(modal.filter, "章节过滤框应为空").toHaveValue("");
    });

    const records: GridWindowRecord[] = [];
    try {
      for (const position of SCROLL_POSITIONS) {
        const label = SCROLL_POSITION_LABELS[position];
        const { grid, applied } = await step(
          `把章节网格滚到${label}，等已挂载单元集合连续 2 个动画帧不变`,
          async () => {
            const scrolled = await scrollDetailGrid(page, position);
            const snapshot = await readDetailGrid(page);
            expectScrolledTo(scrolled, snapshot.scrollTop);
            expect(snapshot.columns, "网格应至少渲染 1 列").toBeGreaterThanOrEqual(1);
            expect(snapshot.cells.length, "网格应至少挂载 1 个单元").toBeGreaterThan(0);
            return { grid: snapshot, applied: scrolled };
          },
        );
        const record = measureGridWindow(grid, applied);
        records.push(record);

        await step(
          `8.8 ${label}：已挂载 ${record.mounted} 个单元 ≤ (⌈${record.clientHeight} / ${GRID_PITCH_PX}⌉ + ${BOUND_EXTRA_ROWS}) × ${record.columns} = ${record.limit}`,
          () => {
            expect(
              record.mounted,
              `${label}已挂载的网格单元数（「${record.firstCell}」至「${record.lastCell}」）应 ≤ ${record.limit}（8.8、14.1）`,
            ).toBeLessThanOrEqual(record.limit);
          },
        );
      }
    } finally {
      await attachBounds(testInfo, records);
    }
  });
});
