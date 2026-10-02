/**
 * 阅读器：当前章节判定、目录抽屉中的卷节点与跨卷段导航（需求 8.1–8.6、8.11–8.13；Checklist H5）。
 * `common/`：`fixture` 与 `real` 两个项目都跑（Opaque_Mode、桌面视口、默认主题）。
 *
 * ## 用书（4.4：节点数、卷位置、标题一律在运行时由 `_toc.json` 推导）
 *
 * - `lib.role("volumes")`：fixture 为 3.3 (b) 的书，real 为《1852铁血中华》。8.1、8.2、8.3、8.6、8.11、
 *   8.12 与"书中后部的卷段"用它。
 * - `lib.role("leadingVolume")`：第 2 个节点即卷节点的书（紧跟首节点的卷段，H5）。fixture 下仍是 3.3 (b)
 *   的书，real 下为《萌娘武侠世界》；real 下该书不具备 4.7 的特征时按 `[4.7]` 跳过。
 * - 相邻卷节点（8.13）：在"可用的书"（`lib.candidateBookIds()`：fixture 为全部书，real 为全部 Test_Book）
 *   中按顺序找第一个由 ≥ 2 个相邻卷节点组成、且前后都有正文章节的卷段；找不到时相关用例以 `[8.13]`
 *   跳过（Run_Summary 注明"当前书库缺少相邻卷节点"）。
 *
 * ## 各条的做法
 *
 * - 8.1：`?ch=` 依次取首个正文章节、首个卷段之后的第一个正文章节、居中的一个正文章节与末个正文章节，
 *   每个都重新打开并按 8.1 判定（`expectCurrentChapter`）。
 * - 8.2：打开目录抽屉（检索框为空），读取已挂载行（`readTocList`，连续 2 帧不变）。按行的位置对应到
 *   节点下标：卷节点为 `<h3>` 且 `tabIndex` < 0，正文章节为 `<button>`，行文本含节点标题；再以 role
 *   定位核对卷标题（heading）与章节行（button）的个数与可访问名称。当前章节行完整位于列表可视区内，
 *   且是已挂载行中唯一带 `aria-current="true"` 的行。分两处验证：当前章节为首个卷段之后的第一个
 *   正文章节（列表停在顶部附近，RS-08 在此拍摄），以及最后一个卷段之后的第一个正文章节（列表需滚动
 *   居中）。
 * - 8.3：当前章节为最后一个卷段之后的第一个正文章节，点击列表可视区内的卷标题；之后 URL 与当前章节
 *   不变，目录抽屉仍打开，当前章节行仍带 `aria-current`。
 * - 8.4 / 8.5：三种卷段（紧跟首节点的、书中后部的、相邻卷节点组成的）× 两个方向 × 两种方式（底栏
 *   "下一章 (→)" / "上一章 (←)" 按钮，→ / ← 键）。每个用例从新打开的出发章节执行一次，判定目标章节
 *   并核对"第 N / M 章"的 N 恰好加 1 或减 1。紧跟首节点的卷段出发章节 / 目标为下标 0 的节点（H5）。
 * - 8.6：在首个正文章节、最后一个卷段之后的第一个正文章节与末个正文章节，核对"章节进度"滑杆的
 *   `min`、`max`、有效步长与当前值；"第 N / M 章"的 M 由 8.1 判定一并核对；最后打开目录抽屉，核对
 *   页签"章节目录 (M)"与"共 M 章"。
 * - 8.11：`?ch=` 逐个取之后有正文章节的卷节点。
 * - 8.12：`?ch=` 取 `-1`、节点总数与 `abc`，每个值一个用例（全新上下文，不含该书的阅读进度）。
 *
 * ## RS-08
 *
 * `toc-volumes` 只属于 real，由标题为 `SHOT_TESTS.tocVolumes.title` 的用例拍摄；fixture 下 `shot()`
 * 不拍摄。默认主题（不 `seedTheme`）。
 *
 * 本文件不装 Controlled_Clock：这里没有与时间相关的断言，等待只依据 `[book-load]` 行与 DOM 状态。
 */
import type { Page } from "@playwright/test";
import { ROW_HEIGHT } from "../../../src/utils/listWindow";
import { SHOT_TESTS } from "../../review/catalog";
import { expect, test, type BookLog, type Lib } from "../../support/fixtures";
import type { TocFacts, VolumeRun } from "../../support/library";
import { chapterRowName, reader, readerError, tocDrawer } from "../../support/locators";
import {
  bookUnderTest,
  expectCurrentChapter,
  openReader,
  openTocDrawer,
  readChapterPosition,
  readTocList,
  rowFullyVisible,
  type BookUnderTest,
  type TocListSnapshot,
} from "../../support/reader";
import { step } from "../../support/step";

// ---------------------------------------------------------------------------
// 卷段
// ---------------------------------------------------------------------------

/** 前后都有正文章节的卷段（8.4 / 8.5 的出发与目标章节都存在）。 */
interface InnerRun extends VolumeRun {
  before: number;
  after: number;
}

function isInner(run: VolumeRun): run is InnerRun {
  return run.before !== null && run.after !== null;
}

function describeRuns(facts: TocFacts): string {
  const shown = facts.volumeRuns.slice(0, 8).map((r) => (r.first === r.last ? `${r.first}` : `${r.first}–${r.last}`));
  const more = facts.volumeRuns.length > shown.length ? ` 等 ${facts.volumeRuns.length} 个` : "";
  return shown.length > 0 ? `[${shown.join(", ")}]${more}` : "无";
}

/** 首个前后都有正文章节的卷段。 */
function firstInnerRun(facts: TocFacts, id: string): InnerRun {
  const run = facts.volumeRuns.find(isInner);
  if (run === undefined) {
    throw new Error(`${id} 没有前后均有正文章节的卷段（卷段：${describeRuns(facts)}）`);
  }
  return run;
}

/** 最后一个前后都有正文章节的卷段（3.3 (b) / 4.7 保证至少有 1 个）。 */
function lastInnerRun(facts: TocFacts, id: string): InnerRun {
  const inner = facts.volumeRuns.filter(isInner);
  const run = inner[inner.length - 1] as InnerRun | undefined;
  if (run === undefined) {
    throw new Error(`${id} 没有前后均有正文章节的卷段（卷段：${describeRuns(facts)}；3.3 (b) / 4.7）`);
  }
  return run;
}

/** 紧跟首节点的卷段：从下标 1 开始，之前是下标 0 的节点（H5）。 */
function leadingRun(facts: TocFacts, id: string): InnerRun {
  const run = facts.volumeRuns[0];
  if (run === undefined || run.first !== 1 || !isInner(run)) {
    throw new Error(
      `${id} 的第 2 个节点应为卷节点、且该卷段之后有正文章节（3.3 (b) / 4.7），实际卷段：${describeRuns(facts)}`,
    );
  }
  return run;
}

/** 一个用例要跨越的卷段，或 8.13 的跳过原因。 */
type SegmentTarget = { id: string; run: InnerRun } | { skip: string };

/** 在"可用的书"中找第一个由相邻卷节点组成、前后都有正文章节的卷段（8.13）。 */
async function findAdjacentRun(lib: Lib): Promise<SegmentTarget> {
  const ids = await lib.candidateBookIds();
  let edgeOnly = 0;
  for (const id of ids) {
    const facts = await lib.tocFacts(id);
    const adjacent = facts.volumeRuns.filter((r) => r.last > r.first);
    const run = adjacent.find(isInner);
    if (run !== undefined) return { id, run };
    if (adjacent.length > 0) edgeOnly += 1;
  }
  const scope =
    lib.profile === "fixture" ? `Fixture_Library 全部 ${ids.length} 本书中` : `全部 ${ids.length} 本 Test_Book 中`;
  const detail =
    edgeOnly > 0
      ? `${scope}的相邻卷节点都位于书首或书末（其前或其后没有正文章节），共 ${edgeOnly} 本`
      : `${scope}没有任何两个相邻的卷节点`;
  return { skip: `[8.13] 当前书库缺少相邻卷节点：${detail}` };
}

interface SegmentCase {
  label: string;
  /** 8.4 的出发章节 / 8.5 的目标章节的补充说明。 */
  beforeNote: string;
  resolve(lib: Lib): Promise<SegmentTarget>;
}

const SEGMENTS: readonly SegmentCase[] = [
  {
    label: "紧跟首节点的卷段（H5）",
    beforeNote: "（下标 0 的节点）",
    async resolve(lib) {
      const id = lib.role("leadingVolume");
      return { id, run: leadingRun(await lib.tocFacts(id), id) };
    },
  },
  {
    label: "书中最后一个前后均有正文章节的卷段",
    beforeNote: "",
    async resolve(lib) {
      const id = lib.role("volumes");
      return { id, run: lastInnerRun(await lib.tocFacts(id), id) };
    },
  },
  {
    label: "由相邻卷节点组成的卷段（8.13）",
    beforeNote: "",
    resolve: findAdjacentRun,
  },
];

// ---------------------------------------------------------------------------
// 共用步骤
// ---------------------------------------------------------------------------

/** 打开 `?ch=<index>` 并按 8.1 判定当前章节为 `index`。 */
async function openAt(page: Page, bookLog: BookLog, book: BookUnderTest, index: number): Promise<void> {
  await openReader(page, bookLog, book, index);
  await expectCurrentChapter(page, book.facts, index);
}

/**
 * 8.2：在已打开、检索框为空的目录抽屉中核对已挂载行，当前章节为下标 `current`。
 * 返回稳定后的列表快照。
 */
async function expectTocRows(page: Page, facts: TocFacts, current: number): Promise<TocListSnapshot> {
  const drawer = tocDrawer(page);
  return step(
    "8.2 已挂载行：卷节点为不在 Tab 序列中的 heading，正文章节为 button，行内含节点标题；当前章节行可见且唯一带 aria-current",
    async () => {
      await expect(drawer.filter, "目录抽屉的章节检索框应为空（8.2）").toHaveValue("");
      const list = await readTocList(page);
      const { rows } = list;
      expect(rows.length, "目录列表应至少挂载 1 行").toBeGreaterThan(0);

      const problems: string[] = [];
      rows.forEach((row, k) => {
        const where = `第 ${k + 1} 个已挂载行（下标 ${row.index}）`;
        if (Math.abs(row.offset - row.index * ROW_HEIGHT) > 1) {
          problems.push(`${where}的上沿 ${row.offset} px 不是行高 ${ROW_HEIGHT} px 的整数倍`);
        }
        if (k > 0 && row.index !== rows[k - 1].index + 1) {
          problems.push(`${where}与上一行（下标 ${rows[k - 1].index}）不相邻`);
        }
        if (row.index < 0 || row.index >= facts.nodeCount) {
          problems.push(`${where}超出节点范围 [0, ${facts.nodeCount})`);
          return;
        }
        const title = facts.titles[row.index];
        if (facts.bodyOrdinals[row.index] === null) {
          if (row.tag !== "H3") problems.push(`${where}是卷节点，应为 <h3>，实际为 <${row.tag.toLowerCase()}>`);
          if (row.tabIndex >= 0) problems.push(`${where}是卷节点，不应在 Tab 焦点序列中（tabIndex=${row.tabIndex}）`);
        } else if (row.tag !== "BUTTON") {
          problems.push(`${where}是正文章节，应为 <button>，实际为 <${row.tag.toLowerCase()}>`);
        }
        if (!row.text.includes(title)) problems.push(`${where}的文本「${row.text}」不含节点标题「${title}」`);
      });

      const marked = rows.filter((r) => r.ariaCurrent === "true").map((r) => r.index);
      if (marked.length !== 1 || marked[0] !== current) {
        problems.push(`带 aria-current="true" 的已挂载行应只有当前章节（下标 ${current}），实际为 [${marked.join(", ")}]`);
      }
      const currentRow = rows.find((r) => r.index === current);
      if (currentRow === undefined) {
        problems.push(`当前章节（下标 ${current}）的行未挂载`);
      } else if (!rowFullyVisible(list, currentRow)) {
        problems.push(
          `当前章节行不在列表可视区内（${currentRow.visibleTop}–${currentRow.visibleBottom} px，可视高度 ${list.clientHeight} px）`,
        );
      }
      expect(problems, "目录抽屉的已挂载行（8.2）").toEqual([]);

      // 以 role 核对：卷标题为 heading、章节行为 button，个数与名称按文档顺序与已挂载行一致
      const mounted = rows.map((r) => r.index);
      const volumeRows = mounted.filter((i) => facts.bodyOrdinals[i] === null);
      const bodyRows = mounted.filter((i) => facts.bodyOrdinals[i] !== null);
      await expect(drawer.volumes, "卷节点行应为 role heading（level 3）").toHaveCount(volumeRows.length);
      for (const [k, i] of volumeRows.entries()) {
        await expect(drawer.volumes.nth(k)).toHaveAccessibleName(facts.titles[i]);
      }
      await expect(drawer.chapterRows, "正文章节行应为 role button").toHaveCount(bodyRows.length);
      for (const [k, i] of bodyRows.entries()) {
        await expect(drawer.chapterRows.nth(k)).toHaveAccessibleName(chapterRowName(facts.titles[i]));
      }
      await expect(drawer.chapterRows.nth(bodyRows.indexOf(current))).toHaveAttribute("aria-current", "true");
      return list;
    },
  );
}

type Direction = "next" | "prev";
type Via = "button" | "key";

const VIA_LABELS: Readonly<Record<Via, Readonly<Record<Direction, string>>>> = {
  button: { next: "“下一章 (→)”按钮", prev: "“上一章 (←)”按钮" },
  key: { next: " → 键", prev: " ← 键" },
};

const VIAS: readonly Via[] = ["button", "key"];

/** 以 `via` 执行一次下一章 / 上一章。 */
async function moveChapter(page: Page, direction: Direction, via: Via): Promise<void> {
  const label = `${VIA_LABELS[via][direction]}执行一次${direction === "next" ? "下一章" : "上一章"}`;
  await step(`以${label}`, async () => {
    if (via === "button") {
      const view = reader(page);
      await (direction === "next" ? view.nextChapterButton : view.prevChapterButton).click();
      return;
    }
    await expect
      .poll(() => page.evaluate(() => document.activeElement === document.body), {
        message: "按键前焦点应在 <body> 上",
      })
      .toBe(true);
    await page.keyboard.press(direction === "next" ? "ArrowRight" : "ArrowLeft");
  });
}

/** 8.4 / 8.5：从 `from` 出发执行一次导航，当前章节变为 `to`，N 恰好 ±1。 */
async function crossSegment(
  page: Page,
  bookLog: BookLog,
  book: BookUnderTest,
  from: number,
  to: number,
  direction: Direction,
  via: Via,
): Promise<void> {
  await openAt(page, bookLog, book, from);
  const before = await readChapterPosition(page);
  await moveChapter(page, direction, via);
  await expectCurrentChapter(page, book.facts, to);
  await step(`“第 N / M 章”的 N 恰好${direction === "next" ? "加" : "减"} 1，M 不变`, async () => {
    const after = await readChapterPosition(page);
    expect(after.n - before.n, `N 由 ${before.n} 变为 ${after.n}`).toBe(direction === "next" ? 1 : -1);
    expect(after.m).toBe(before.m);
  });
}

// ---------------------------------------------------------------------------
// 8.1 当前章节判定
// ---------------------------------------------------------------------------

test.describe("8.1 当前章节判定", () => {
  test("8.1 ?ch=<n> 指向正文章节：正文区一级标题为该节点标题，“第 N / M 章”的 N 为其正文序号，与标题相同的元素恰好 1 个", async ({
    page,
    lib,
    bookLog,
  }) => {
    const book = await bookUnderTest(lib, lib.role("volumes"));
    const { facts } = book;
    const body = facts.bodyIndices;
    const samples = [
      body[0],
      firstInnerRun(facts, book.id).after,
      body[Math.floor(body.length / 2)],
      body[body.length - 1],
    ];
    for (const index of [...new Set(samples)].sort((a, b) => a - b)) {
      await openAt(page, bookLog, book, index);
    }
  });
});

// ---------------------------------------------------------------------------
// 8.2 8.3 目录抽屉中的卷节点
// ---------------------------------------------------------------------------

test.describe("8.2 8.3 目录抽屉中的卷节点", () => {
  test(SHOT_TESTS.tocVolumes.title, async ({ page, lib, bookLog, shot }) => {
    // RS-08 为默认主题（localStorage 中没有已存储的主题），不 seedTheme
    const book = await bookUnderTest(lib, lib.role("volumes"));
    const { facts } = book;
    const current = firstInnerRun(facts, book.id).after;

    await openAt(page, bookLog, book, current);
    await openTocDrawer(page);
    const list = await expectTocRows(page, facts, current);

    if (shot.applies("toc-volumes")) {
      await step("RS-08 画面：检索框为空，首个卷节点的行完整位于列表可视区内", () => {
        const first = facts.volumeIndices[0];
        const row = list.rows.find((r) => r.index === first);
        expect(row !== undefined && rowFullyVisible(list, row), `首个卷节点（下标 ${first}）的行应在列表可视区内`).toBe(
          true,
        );
      });
    }
    await shot("toc-volumes");
  });

  test("8.2 当前章节为最后一个卷段之后的第一个正文章节：列表居中到当前章节行，卷节点仍为不在 Tab 序列中的 heading", async ({
    page,
    lib,
    bookLog,
  }) => {
    const book = await bookUnderTest(lib, lib.role("volumes"));
    const current = lastInnerRun(book.facts, book.id).after;

    await openAt(page, bookLog, book, current);
    await openTocDrawer(page);
    await expectTocRows(page, book.facts, current);
  });

  test("8.3 在目录抽屉点击卷标题：当前章节与 URL 不变，目录抽屉保持打开", async ({ page, lib, bookLog }) => {
    const book = await bookUnderTest(lib, lib.role("volumes"));
    const { facts } = book;
    const run = lastInnerRun(facts, book.id);
    const current = run.after;
    const drawer = tocDrawer(page);

    await openAt(page, bookLog, book, current);
    // openAt 的 8.1 判定已等到阅读器把当前章写回 URL（reader-defect-fixes 需求 7.1），这里记下的是写回后的 URL
    const url = page.url();
    await openTocDrawer(page);

    const target = await step("选取列表可视区内的一个卷标题", async () => {
      const list = await readTocList(page);
      const volumeRows = list.rows.filter((r) => facts.bodyOrdinals[r.index] === null);
      const visible = volumeRows.filter((r) => rowFullyVisible(list, r));
      const row = visible.find((r) => r.index === run.last) ?? visible[0];
      if (row === undefined) {
        throw new Error(
          `列表可视区内没有卷标题行（已挂载的卷节点：[${volumeRows.map((r) => r.index).join(", ")}]）`,
        );
      }
      const heading = drawer.volumes.nth(volumeRows.indexOf(row));
      await expect(heading).toHaveAccessibleName(facts.titles[row.index]);
      return { heading, index: row.index };
    });

    await step(`点击卷标题「${facts.titles[target.index]}」（下标 ${target.index}）`, async () => {
      await target.heading.click();
    });

    await step("8.3 目录抽屉仍打开，当前章节行仍是唯一带 aria-current 的行", async () => {
      await expect(drawer.marker).toBeVisible();
      const list = await readTocList(page);
      const marked = list.rows.filter((r) => r.ariaCurrent === "true").map((r) => r.index);
      expect(marked, "带 aria-current 的行").toEqual([current]);
    });
    await step("8.3 URL 不变", async () => {
      await expect(page).toHaveURL(url);
    });
    await expectCurrentChapter(page, facts, current);
  });
});

// ---------------------------------------------------------------------------
// 8.4 8.5 跨卷段导航
// ---------------------------------------------------------------------------

test.describe("8.4 8.5 跨卷段导航", () => {
  for (const segment of SEGMENTS) {
    for (const via of VIAS) {
      test(`8.4 ${segment.label}：以${VIA_LABELS[via].next}从卷段之前的最后一个正文章节${segment.beforeNote}前进到卷段之后的第一个正文章节，N 加 1`, async ({
        page,
        lib,
        bookLog,
      }) => {
        const target = await segment.resolve(lib);
        if ("skip" in target) {
          test.skip(true, target.skip);
          return;
        }
        const book = await bookUnderTest(lib, target.id);
        await crossSegment(page, bookLog, book, target.run.before, target.run.after, "next", via);
      });

      test(`8.5 ${segment.label}：以${VIA_LABELS[via].prev}从卷段之后的第一个正文章节回到卷段之前的最后一个正文章节${segment.beforeNote}，N 减 1`, async ({
        page,
        lib,
        bookLog,
      }) => {
        const target = await segment.resolve(lib);
        if ("skip" in target) {
          test.skip(true, target.skip);
          return;
        }
        const book = await bookUnderTest(lib, target.id);
        await crossSegment(page, bookLog, book, target.run.after, target.run.before, "prev", via);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// 8.6 章节进度滑杆与总章数
// ---------------------------------------------------------------------------

/** 8.6：滑杆的最小值、最大值、有效步长与当前值。 */
async function expectChapterSlider(page: Page, facts: TocFacts, index: number): Promise<void> {
  const ordinal = facts.bodyOrdinals[index];
  if (ordinal === null) throw new Error(`下标 ${index} 不是正文章节`);
  const slider = reader(page).chapterSlider;
  await step(`8.6 “章节进度”滑杆：min 0、max ${facts.bodyCount - 1}、步长 1、当前值 ${ordinal}`, async () => {
    await expect(slider, "滑杆最小值应为 0").toHaveAttribute("min", "0");
    await expect(slider, "滑杆最大值应为非卷节点数 − 1").toHaveAttribute("max", String(facts.bodyCount - 1));
    await expect(slider, "滑杆当前值应为当前章节在非卷节点中的序号（从 0 起）").toHaveValue(String(ordinal));
    // 有效步长：在脱离文档的副本上从 min 调用一次 stepUp()，不触发应用的事件处理
    const stepSize = await slider.evaluate((el) => {
      const probe = el.cloneNode() as HTMLInputElement;
      probe.value = probe.min;
      probe.stepUp();
      return Number(probe.value) - Number(probe.min);
    });
    expect(stepSize, "滑杆的有效步长应为 1").toBe(1);
  });
}

test.describe("8.6 章节进度滑杆与总章数", () => {
  test("8.6 “章节进度”滑杆的最小值 0、最大值为非卷节点数 − 1、步长 1、当前值为正文序号；“第 N / M 章”与目录抽屉的总章数都是非卷节点数", async ({
    page,
    lib,
    bookLog,
  }) => {
    const book = await bookUnderTest(lib, lib.role("volumes"));
    const { facts } = book;
    expect(facts.bodyCount, "该书应至少有 2 个正文章节，滑杆才有可测的步长").toBeGreaterThanOrEqual(2);
    const body = facts.bodyIndices;
    const positions = [body[0], lastInnerRun(facts, book.id).after, body[body.length - 1]];

    for (const index of [...new Set(positions)].sort((a, b) => a - b)) {
      // 8.1 的判定同时核对"第 N / M 章"的 M 为非卷节点数
      await openAt(page, bookLog, book, index);
      await expectChapterSlider(page, facts, index);
    }

    await openTocDrawer(page);
    await step(`8.6 目录抽屉显示的总章数为非卷节点数 ${facts.bodyCount}`, async () => {
      const drawer = tocDrawer(page);
      await expect(drawer.tabToc).toHaveAccessibleName(`章节目录 (${facts.bodyCount})`);
      await expect(drawer.summary).toHaveText(new RegExp(` · 共 ${facts.bodyCount} 章$`));
    });
  });
});

// ---------------------------------------------------------------------------
// 8.11 8.12 ?ch= 指向卷节点或非法值
// ---------------------------------------------------------------------------

test.describe("8.11 8.12 ?ch= 参数", () => {
  test("8.11 ?ch= 指向卷节点：当前章节为该卷节点之后的第一个正文章节", async ({ page, lib, bookLog }) => {
    const book = await bookUnderTest(lib, lib.role("volumes"));
    const { facts } = book;
    const cases = facts.volumeRuns.flatMap((run) => {
      const { after } = run;
      if (after === null) return [];
      return Array.from({ length: run.last - run.first + 1 }, (_, k) => ({ volume: run.first + k, after }));
    });
    expect(cases.length, `${book.id} 应有之后跟着正文章节的卷节点`).toBeGreaterThan(0);

    for (const { volume, after } of cases) {
      await step(`?ch=${volume}（卷节点「${facts.titles[volume]}」）→ 下标 ${after}`, async () => {
        await openReader(page, bookLog, book, volume);
        await expectCurrentChapter(page, facts, after);
      });
    }
  });

  const INVALID_CH: readonly { label: string; value(facts: TocFacts): string }[] = [
    { label: "-1（负数）", value: () => "-1" },
    { label: "<节点总数>（越界）", value: (facts) => String(facts.nodeCount) },
    { label: "abc（不是数字）", value: () => "abc" },
  ];

  for (const invalid of INVALID_CH) {
    test(`8.12 ?ch=${invalid.label}：忽略该参数，当前章节为第一个非卷节点，不显示加载失败提示`, async ({
      page,
      lib,
      bookLog,
    }) => {
      // 每个用例都是全新的浏览器上下文（6.1），不含该书的阅读进度
      const book = await bookUnderTest(lib, lib.role("volumes"));
      const { facts } = book;

      await openReader(page, bookLog, book, invalid.value(facts));
      await expectCurrentChapter(page, facts, facts.bodyIndices[0]);
      await step("不显示加载失败提示", async () => {
        const error = readerError(page);
        await expect(error.heading).toHaveCount(0);
        await expect(error.noContentHeading).toHaveCount(0);
      });
    });
  }
});
