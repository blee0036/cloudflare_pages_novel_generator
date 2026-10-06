/**
 * 阅读器：兜底切分书与标题全为 `※※※` 的书的目录抽屉（需求 8.9、8.10）。
 * `common/`：在 `fixture` 项目运行（Opaque_Mode、桌面视口、默认主题）。测试只用 Fixture_Library
 * （test-data-desensitization 去掉了 real 档）。
 *
 * ## 用书（4.4：节点数与标题一律在运行时由 `_toc.json` 推导）
 *
 * - `lib.role("fallback")`：3.3 (c) 的 `fallback: true` 的书。
 * - `lib.role("stars")`：3.3 (d) 的书。
 *
 * 两个用途的特征（test-data-desensitization 需求 4.2 (f) 的 `fallback` 为 true、(e) 的全部节点标题为
 * `※※※`）由 `lib.role()` 核对，不成立时抛错，用例判失败而不是跳过。
 *
 * ## 取样
 *
 * 两个用例都在检索框为空的目录抽屉里，把列表依次直接设到顶部、中部、底部（`scrollTocList`，
 * 定义同 8.7，见 `SCROLL_POSITION_LABELS`），再等已挂载行集合连续 2 个动画帧不变（`readTocList`）
 * 后在该位置核对。行的"标题文本"取 `TocRowSnapshot.title`（行内第一段非空文本，即字数之前的
 * 标题 span），不含章节行末尾的"N字"。
 *
 * - 8.9：每个位置的每个已挂载行，标题文本等于 `_toc.json` 对应节点的标题，形如 `第 N 部分`，且
 *   N 等于该行在列表中的序号加 1（行按文档顺序逐个相邻；顶部的首行为下标 0，即 N 从 1 起）。
 *   随后重新打开 `?ch=0`，以底栏"下一章 (→)"执行一次下一章，当前章节变为下标 1（8.1 判定）。
 * - 8.10："可滚动总高度"取列表内容本身的高度（`TocListSnapshot.contentHeight`：含撑高占位的全部
 *   子元素从最上沿到最下沿），须等于节点总数 × 44 px（±1 px）。内容超出可视区时另核对
 *   `scrollHeight` 与之相同；fixture 的书只有几个节点、不足一屏，这时 `scrollHeight` 按定义等于
 *   `clientHeight`，只核对内容高度。顶部首行、底部末行的标题文本分别等于首、末节点标题；每个
 *   位置的每个已挂载行，标题文本非空且可见地渲染（`TocRowSnapshot.titleVisible`）。
 *
 * ## RS-17、RS-18
 *
 * `toc-fallback`、`toc-stars` 分别由标题为 `SHOT_TESTS.tocFallback.title`、`SHOT_TESTS.tocStars.title`
 * 的用例在 `fixture` 项目中、顶部取样之后拍摄（Review_Catalog 的条目都属于 fixture）。默认主题
 * （不 `seedTheme`）。
 *
 * 本文件不装 Controlled_Clock：稳定判定依赖 `requestAnimationFrame`，这里没有与时间相关的断言，
 * 等待只依据 `[book-load]` 行、`scroll` 事件与 DOM 状态。
 */
import type { Page } from "@playwright/test";
import { SHOT_TESTS } from "../../review/catalog";
import { expect, test } from "../../support/fixtures";
import { STARS_TITLE, type TocFacts } from "../../support/library";
import { reader, tocDrawer } from "../../support/locators";
import {
  SCROLL_POSITIONS,
  SCROLL_POSITION_LABELS,
  bookUnderTest,
  expectCurrentChapter,
  openReader,
  openTocDrawer,
  readTocList,
  scrollTocList,
  type ScrollPosition,
  type TocListSnapshot,
  type TocRowSnapshot,
} from "../../support/reader";
import { step } from "../../support/step";

// ---------------------------------------------------------------------------
// 需求中的字面值
// ---------------------------------------------------------------------------

/** 8.10 的行高（px）。 */
const TOC_ROW_PX = 44;
/** 8.10 总高度的误差上限（px）。 */
const HEIGHT_TOLERANCE_PX = 1;
/** 滚动定位的容差（px）。 */
const SCROLL_TOLERANCE_PX = 1;
/** 8.9 兜底切分的标题形式。 */
const FALLBACK_TITLE = /^第 (\d+) 部分$/;

// ---------------------------------------------------------------------------
// 共用
// ---------------------------------------------------------------------------

/** 打开目录抽屉并核对检索框为空。 */
async function openEmptyToc(page: Page): Promise<void> {
  await openTocDrawer(page);
  await step("目录抽屉的章节检索框为空", async () => {
    await expect(tocDrawer(page).filter).toHaveValue("");
  });
}

/** 把列表滚到 `position`，等已挂载行集合连续 2 个动画帧不变后返回快照。 */
async function sampleToc(page: Page, position: ScrollPosition): Promise<TocListSnapshot> {
  const label = SCROLL_POSITION_LABELS[position];
  return step(`把目录列表滚到${label}，等已挂载行集合连续 2 个动画帧不变`, async () => {
    const applied = await scrollTocList(page, position);
    const list = await readTocList(page);
    expect(
      Math.abs(list.scrollTop - applied.target),
      `应停在${label}：目标 ${applied.target}，实际 ${list.scrollTop}` +
        `（scrollHeight ${applied.scrollHeight}，clientHeight ${applied.clientHeight}）`,
    ).toBeLessThanOrEqual(SCROLL_TOLERANCE_PX);
    expect(list.rows.length, "目录列表应至少挂载 1 行").toBeGreaterThan(0);
    return list;
  });
}

function where(row: TocRowSnapshot, k: number): string {
  return `第 ${k + 1} 个已挂载行（列表项 ${row.index}）`;
}

function mountedRange(list: TocListSnapshot): string {
  const { rows } = list;
  return rows.length > 0 ? `${rows[0].index}–${rows[rows.length - 1].index}` : "无";
}

// ---------------------------------------------------------------------------
// 8.9 兜底切分书
// ---------------------------------------------------------------------------

/** 8.9：已挂载行逐个相邻，标题文本等于节点标题、形如「第 N 部分」且 N 为列表序号加 1。 */
function fallbackRowProblems(list: TocListSnapshot, facts: TocFacts, position: ScrollPosition): string[] {
  const { rows } = list;
  const problems: string[] = [];
  if (position === "top" && rows[0].index !== 0) {
    problems.push(`顶部的首个已挂载行应为列表项 0（第 1 部分），实际为列表项 ${rows[0].index}`);
  }
  rows.forEach((row, k) => {
    const at = where(row, k);
    if (k > 0 && row.index !== rows[k - 1].index + 1) {
      problems.push(`${at}与上一行（列表项 ${rows[k - 1].index}）不相邻`);
    }
    if (row.index < 0 || row.index >= facts.nodeCount) {
      problems.push(`${at}超出节点范围 [0, ${facts.nodeCount})`);
      return;
    }
    const expected = facts.titles[row.index];
    if (row.title !== expected) {
      problems.push(`${at}的标题文本「${row.title}」不等于 _toc.json 节点 ${row.index} 的标题「${expected}」`);
    }
    const match = FALLBACK_TITLE.exec(row.title);
    if (match === null) {
      problems.push(`${at}的标题文本「${row.title}」不是「第 N 部分」的形式`);
    } else if (Number(match[1]) !== row.index + 1) {
      problems.push(`${at}为「第 ${match[1]} 部分」，按行序应为「第 ${row.index + 1} 部分」`);
    }
  });
  return problems;
}

test.describe("8.9 8.10 兜底切分书与标题全为 ※※※ 的书的目录", () => {
  test(SHOT_TESTS.tocFallback.title, async ({ page, lib, bookLog, shot }) => {
    // RS-17 为默认主题（localStorage 中没有已存储的主题），不 seedTheme
    const book = await bookUnderTest(lib, lib.role("fallback"));
    const { facts } = book;
    await step("用例前提：该书 fallback 为 true，下标 0、1 都是正文章节", () => {
      expect(facts.fallback, `${book.id} 的 _toc.json 应带 fallback: true（3.3 (c)）`).toBe(true);
      expect(facts.nodeCount, `${book.id} 的节点数应 ≥ 2（3.3 (c)）`).toBeGreaterThanOrEqual(2);
      expect(facts.bodyOrdinals.slice(0, 2), "下标 0、1 的正文序号").toEqual([0, 1]);
    });

    await openReader(page, bookLog, book, 0);
    await expectCurrentChapter(page, facts, 0);
    await openEmptyToc(page);

    for (const position of SCROLL_POSITIONS) {
      const label = SCROLL_POSITION_LABELS[position];
      const list = await sampleToc(page, position);
      await step(
        `8.9 ${label}：已挂载行（列表项 ${mountedRange(list)}）的标题文本等于节点标题，为「第 N 部分」且 N 逐行加 1`,
        () => {
          expect(fallbackRowProblems(list, facts, position), `${label}的已挂载行（8.9）`).toEqual([]);
        },
      );

      if (position === "top") {
        if (shot.applies("toc-fallback")) {
          await step("RS-17 画面：列表在顶部，当前章节行为下标 0", async () => {
            const again = await readTocList(page);
            expect(again.scrollTop, "列表的 scrollTop").toBe(0);
            const marked = again.rows.filter((r) => r.ariaCurrent === "true").map((r) => r.index);
            expect(marked, "带 aria-current 的行").toEqual([0]);
          });
        }
        await shot("toc-fallback");
      }
    }

    // 重新打开 ?ch=0 再执行下一章：不依赖关闭目录抽屉的方式，且刚加载完成时底栏可见、不会自动隐藏
    await openReader(page, bookLog, book, 0);
    await expectCurrentChapter(page, facts, 0);
    await step("以底栏“下一章 (→)”按钮执行一次下一章", async () => {
      await reader(page).nextChapterButton.click();
    });
    await expectCurrentChapter(page, facts, 1);
  });

  // -------------------------------------------------------------------------
  // 8.10 标题全为 ※※※ 的书
  // -------------------------------------------------------------------------

  test(SHOT_TESTS.tocStars.title, async ({ page, lib, bookLog, shot }) => {
    // RS-18 为默认主题（localStorage 中没有已存储的主题），不 seedTheme
    const book = await bookUnderTest(lib, lib.role("stars"));
    const { facts } = book;
    const last = facts.nodeCount - 1;
    await step(`用例前提：该书至少 2 个节点的标题为 ${STARS_TITLE}`, () => {
      const stars = facts.titles.filter((t) => t === STARS_TITLE).length;
      expect(stars, `${book.id} 中标题为 ${STARS_TITLE} 的节点数（3.3 (d)）`).toBeGreaterThanOrEqual(2);
    });

    await openReader(page, bookLog, book);
    await expectCurrentChapter(page, facts, facts.bodyIndices[0]);
    await openEmptyToc(page);

    for (const position of SCROLL_POSITIONS) {
      const label = SCROLL_POSITION_LABELS[position];
      const list = await sampleToc(page, position);

      if (position === "top") {
        const expected = facts.nodeCount * TOC_ROW_PX;
        await step(
          `8.10 目录列表的可滚动总高度 = ${facts.nodeCount} × ${TOC_ROW_PX} = ${expected} px（±${HEIGHT_TOLERANCE_PX} px）`,
          () => {
            expect(
              Math.abs(list.contentHeight - expected),
              `列表内容高度 ${list.contentHeight} px 应为 ${expected} px（8.10）`,
            ).toBeLessThanOrEqual(HEIGHT_TOLERANCE_PX);
            if (expected > list.clientHeight) {
              expect(
                Math.abs(list.scrollHeight - expected),
                `内容超出可视区（clientHeight ${list.clientHeight} px），scrollHeight ${list.scrollHeight} px 应为 ${expected} px（8.10）`,
              ).toBeLessThanOrEqual(HEIGHT_TOLERANCE_PX);
            }
          },
        );
        await step(`8.10 ${label}：首个行元素的标题文本为首节点标题「${facts.titles[0]}」`, () => {
          const first = list.rows[0];
          expect(first.index, "首个已挂载行的列表项").toBe(0);
          expect(first.title, "首个已挂载行的标题文本（8.10）").toBe(facts.titles[0]);
        });
      }
      if (position === "bottom") {
        await step(`8.10 ${label}：最后一个行元素的标题文本为末节点标题「${facts.titles[last]}」`, () => {
          const final = list.rows[list.rows.length - 1];
          expect(final.index, "最后一个已挂载行的列表项").toBe(last);
          expect(final.title, "最后一个已挂载行的标题文本（8.10）").toBe(facts.titles[last]);
        });
      }

      await step(`8.10 ${label}：每个已挂载行（列表项 ${mountedRange(list)}）的可见标题文本非空`, () => {
        const blank = list.rows.flatMap((row, k) => {
          if (row.title === "") return [`${where(row, k)}没有标题文本（行文本「${row.text}」）`];
          if (!row.titleVisible) return [`${where(row, k)}的标题文本「${row.title}」未可见地渲染`];
          return [];
        });
        expect(blank, `${label}的已挂载行（8.10）`).toEqual([]);
      });

      if (position === "top") {
        if (shot.applies("toc-stars")) {
          await step("RS-18 画面：列表在顶部", async () => {
            const again = await readTocList(page);
            expect(again.scrollTop, "列表的 scrollTop").toBe(0);
          });
        }
        await shot("toc-stars");
      }
    }
  });
});
