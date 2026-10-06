/**
 * 书架骨架与加载失败（需求 7.1、7.16、7.17；Checklist H7；Review_Shot RS-03）。`fixture` 项目。
 *
 * - 7.1：挂起 `books.json` 的响应，断言 `role="status"`、`aria-busy="true"` 的骨架区块；读骨架网格的
 *   列轨道数，放行后再读书卡网格的列轨道数，两者相等，且桌面为 4、移动为 1。桌面用例在挂起期间拍
 *   RS-03 `bookshelf-skeleton`（默认主题：不 seedTheme）。
 * - 7.16：`books.json` 为非成功状态（HTTP 500）或网络错误时，骨架移除，显示失败说明与"重新加载"，
 *   不显示书卡与"最近阅读"。为使"不显示最近阅读"有区分度，首次导航前写入 1 条有效的阅读进度，
 *   书架正常加载时它会出现在"最近阅读"里（7.17 的用例在重新加载成功后核对这一点）。失败说明按
 *   reader-defect-fixes 需求 13.11 断言为 `unavailable` 的书架文案（`SHELF_ERROR_TEXTS`）。历史：EV 验收时
 *   失败说明是原始 `err.message`，HTTP 500 一例断言其含 `(HTTP 500)`（Findings_Log F-012，已修复
 *   （reader-defect-fixes））。
 * - 7.17：在 7.16 的失败状态下点击"重新加载"，`books.json` 恰好再请求 1 次并正常返回，随后显示书卡
 *   网格，失败说明与"重新加载"消失。
 * - reader-defect-fixes 需求 13.10、13.11（F-012）：`books.json` 分别返回状态 404、返回状态 500、以网络
 *   错误失败时，失败说明分别为 `not-found`、`unavailable`、`unavailable` 的书架文案，其余同 7.16；
 *   失败状态显示后再等 2 个动画帧为观测窗口终点，其间 console 中以 `[load-error] ` 开头的消息恰为
 *   1 条（`console.error`），含 `stage=catalog`、所抛值的名称与消息，以及响应状态（有响应时；
 *   `e2e/support/load-error.ts`）。
 *
 * 列轨道数取自网格容器计算样式的 `grid-template-columns`（测量性 DOM 读取，设计"测试支撑"末条）：
 * 骨架网格是骨架区块内的网格容器，书卡网格是第一张书卡书名的最近网格祖先。
 */
import type { Locator, Page, Route } from "@playwright/test";
import type { ReadingProgress } from "../../../src/types";
import { PAGE_SIZE } from "../../../src/utils/pagination";
import { SHOT_TESTS } from "../../review/catalog";
import { expect, seedProgress, test, type Lib } from "../../support/fixtures";
import { expectSingleLoadErrorLog, recordLoadErrorLog } from "../../support/load-error";
import { SHELF_ERROR_TEXTS, recentReads, shelf } from "../../support/locators";
import { waitFrames } from "../../support/reader";
import { VIEWPORTS } from "../../support/settings";
import { step } from "../../support/step";

/** 书架索引的请求路径（`BookshelfPage` 的 `fetch("/data/books.json")`）。 */
const BOOKS_JSON_PATH = "/data/books.json";

/** 7.1：各视口下书卡网格的列数（H7；`lg:grid-cols-4` 与移动端的 `grid-cols-1`）。 */
const EXPECTED_COLUMNS = { desktop: 4, mobile: 1 } as const;

type ViewportKey = keyof typeof EXPECTED_COLUMNS;

const isBooksJson = (url: URL): boolean => url.pathname === BOOKS_JSON_PATH;

/** 统计本页面发出的 `books.json` 请求数（含被拦截后返回失败或被中止的）。 */
function countBooksJsonRequests(page: Page): { readonly count: number } {
  let count = 0;
  page.on("request", (request) => {
    if (isBooksJson(new URL(request.url()))) count++;
  });
  return {
    get count() {
      return count;
    },
  };
}

/** 在 `body` 期间以 `handler` 拦截 `books.json`；结束时（含失败）移除全部路由，忽略仍挂起的处理器。 */
async function withBooksJsonRoute(
  page: Page,
  handler: (route: Route) => Promise<void> | void,
  body: () => Promise<void>,
): Promise<void> {
  await page.route(isBooksJson, handler);
  try {
    await body();
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
  }
}

/**
 * 网格容器的列轨道数：计算样式 `grid-template-columns` 的轨道个数（`none` 为 0）。
 * `inside`：`el` 自身或其后代中的第一个网格容器（骨架区块）；`around`：`el` 最近的网格祖先（书卡）。
 */
function gridColumns(el: Locator, where: "inside" | "around"): Promise<number> {
  return el.evaluate((start, where) => {
    const isGrid = (node: Element): boolean => getComputedStyle(node).display === "grid";
    let grid: Element | null | undefined;
    if (where === "inside") {
      grid = [start, ...start.querySelectorAll("*")].find(isGrid);
    } else {
      grid = start.parentElement;
      while (grid && !isGrid(grid)) grid = grid.parentElement;
    }
    if (!grid) throw new Error(where === "inside" ? "区块内没有网格容器" : "元素没有网格祖先");
    const value = getComputedStyle(grid).gridTemplateColumns.trim();
    return value === "" || value === "none" ? 0 : value.split(/\s+/).length;
  }, where);
}

/**
 * 7.1 的场景：挂起 `books.json` → 骨架显示中（`whileHeld` 在此时执行，如拍摄 RS-03）→ 放行 →
 * 书卡网格；比较两者的列轨道数。
 */
async function skeletonMatchesCardGrid(
  page: Page,
  viewport: ViewportKey,
  whileHeld?: () => Promise<void>,
): Promise<void> {
  const view = shelf(page);
  const held: Route[] = [];

  await withBooksJsonRoute(
    page,
    (route) => {
      held.push(route);
    },
    async () => {
      await step("打开书架，挂起 books.json 的响应", async () => {
        await page.goto("/");
        await expect
          .poll(() => held.length, { message: "books.json 的请求应已发出并被挂起" })
          .toBe(1);
      });

      const skeletonCols = await step("骨架区块显示中（role=status、aria-busy=true）", async () => {
        await expect(view.skeleton).toBeVisible();
        await expect(view.skeleton).toHaveAttribute("aria-busy", "true");
        await expect(view.cardTocButtons).toHaveCount(0);
        return gridColumns(view.skeleton, "inside");
      });

      if (whileHeld !== undefined) await whileHeld();

      await step("放行 books.json", async () => {
        for (const route of held.splice(0)) await route.continue();
      });

      const cardCols = await step("书卡网格显示，骨架移除", async () => {
        await expect(view.cardTocButtons.first()).toBeVisible();
        await expect(view.skeleton).toHaveCount(0);
        return gridColumns(view.card(0).title, "around");
      });

      await step(`比较列数（${viewport} 应为 ${EXPECTED_COLUMNS[viewport]} 列）`, () => {
        expect(skeletonCols, "骨架网格的列数应等于同一视口下书卡网格的列数（7.1）").toBe(cardCols);
        expect(cardCols, `书卡网格的列数（7.1、H7）`).toBe(EXPECTED_COLUMNS[viewport]);
      });
    },
  );
}

test.describe("7.1 骨架与书卡网格列数", () => {
  test(SHOT_TESTS.shelfSkeleton.title, async ({ page, shot }) => {
    // RS-03 为默认主题（localStorage 中没有已存储的主题），不 seedTheme
    await skeletonMatchesCardGrid(page, "desktop", async () => {
      await shot("bookshelf-skeleton");
    });
  });

  test.describe("移动视口", () => {
    test.use({ viewport: VIEWPORTS.mobile });

    test("7.1 books.json 挂起时显示骨架，列数等于书卡网格（移动）", async ({ page }) => {
      await skeletonMatchesCardGrid(page, "mobile");
    });
  });
});

// ---------------------------------------------------------------------------
// 7.16、7.17：加载失败与"重新加载"
// ---------------------------------------------------------------------------

interface FailureKind {
  /** 用例标题里的写法。 */
  label: string;
  /** 让本次 `books.json` 请求失败。 */
  fail(route: Route): Promise<void>;
  /** 非成功状态时的 HTTP 状态码（`[load-error]` 日志里会带出）；网络错误为 null。 */
  status: number | null;
  /** Load_Error_Category：失败说明应为 `SHELF_ERROR_TEXTS` 中该类别的一句（RDF 需求 13.11）。 */
  category: keyof typeof SHELF_ERROR_TEXTS;
}

/** 以非成功状态应答（纯文本响应体，不是 JSON）。 */
function httpFailure(status: number, body: string, category: FailureKind["category"]): FailureKind {
  return {
    label: `HTTP ${status}`,
    status,
    category,
    fail: (route) => route.fulfill({ status, contentType: "text/plain; charset=utf-8", body }),
  };
}

const HTTP_404 = httpFailure(404, "Not Found", "not-found");
const HTTP_500 = httpFailure(500, "Internal Server Error", "unavailable");
const NETWORK_ERROR: FailureKind = {
  label: "网络错误",
  status: null,
  category: "unavailable",
  fail: (route) => route.abort("failed"),
};

/** EV 7.16、7.17 的两种失败。 */
const FAILURES: readonly FailureKind[] = [HTTP_500, NETWORK_ERROR];

/** RDF 13.10、13.11 的三种失败（13.11 的顺序）。 */
const CLASSIFIED_FAILURES: readonly FailureKind[] = [HTTP_404, HTTP_500, NETWORK_ERROR];

/**
 * 首次导航前写入 1 条有效的阅读进度（书取自 `roles.json` 的 `recent`，章节为该书第一个正文章节），
 * 使书架正常加载时"最近阅读"区块会出现。返回该书书名（取自 `books.json`）。
 */
async function seedOneProgress(page: Page, lib: Lib): Promise<string> {
  const bookId = lib.fixtureRoles().recent[0];
  const [book, facts] = await Promise.all([lib.book(bookId), lib.tocFacts(bookId)]);
  const chapterId = facts.bodyIndices[0];
  const record: ReadingProgress = {
    bookId,
    chapterId,
    chapterTitle: facts.titles[chapterId],
    charOffset: 0,
    progressPercent: 0,
    lastReadTime: Date.now(),
    v: 2,
  };
  await seedProgress(page.context(), [record]);
  return book.title;
}

/** 首个 `books.json` 请求按 `kind` 失败，其后的请求放行到 E2E_Server。 */
function failFirst(kind: FailureKind): (route: Route) => Promise<void> {
  let failed = false;
  return async (route) => {
    if (failed) {
      await route.continue();
      return;
    }
    failed = true;
    await kind.fail(route);
  };
}

/**
 * 7.16 的失败状态：失败说明与"重新加载"可见，骨架、书卡与"最近阅读"都不在。失败说明恰为该类别的
 * 书架文案（RDF 需求 13.11；标题与按钮不变，13.9）。
 */
async function expectFailureState(page: Page, kind: FailureKind): Promise<void> {
  const view = shelf(page);
  const expectedText = SHELF_ERROR_TEXTS[kind.category];
  await step(`显示“加载遇到问题”、${kind.category} 的书架文案「${expectedText}」与“重新加载”`, async () => {
    await expect(view.errorHeading).toBeVisible();
    await expect(view.errorDetail, "失败说明（书架文案三句之一）").toHaveCount(1);
    await expect(view.errorDetail, `失败说明应恰为 ${kind.category} 的书架文案（RDF 13.11）`).toHaveText(
      expectedText,
    );
    await expect(view.reloadButton).toBeVisible();
  });
  await step("骨架、书卡与“最近阅读”均不显示", async () => {
    await expect(view.skeleton).toHaveCount(0);
    await expect(view.cardTocButtons).toHaveCount(0);
    await expect(view.cardReadButtons).toHaveCount(0);
    await expect(recentReads(page).heading).toHaveCount(0);
  });
}

for (const kind of FAILURES) {
  test.describe(`books.json ${kind.label}`, () => {
    test(`7.16 books.json ${kind.label} 时显示失败说明与“重新加载”，不显示书卡与最近阅读`, async ({
      page,
      lib,
    }) => {
      await seedOneProgress(page, lib);
      const requests = countBooksJsonRequests(page);

      await withBooksJsonRoute(page, failFirst(kind), async () => {
        await step("打开书架", async () => {
          await page.goto("/");
        });
        await expectFailureState(page, kind);
        expect(requests.count, "books.json 只请求了 1 次").toBe(1);
      });
    });

    test(`7.17 books.json ${kind.label} 后点击“重新加载”，再请求一次并显示书卡网格`, async ({
      page,
      lib,
    }) => {
      const seededTitle = await seedOneProgress(page, lib);
      const catalog = await lib.books();
      const requests = countBooksJsonRequests(page);
      const view = shelf(page);

      await withBooksJsonRoute(page, failFirst(kind), async () => {
        await step("打开书架，books.json 失败", async () => {
          await page.goto("/");
          await expectFailureState(page, kind);
          expect(requests.count, "失败前 books.json 只请求了 1 次").toBe(1);
        });

        await step("点击“重新加载”", async () => {
          await view.reloadButton.click();
        });

        await step("显示书卡网格，失败说明与“重新加载”消失", async () => {
          await expect(view.cardTocButtons.first()).toBeVisible();
          await expect(view.cardTocButtons).toHaveCount(Math.min(PAGE_SIZE, catalog.books.length));
          await expect(view.errorHeading).toHaveCount(0);
          await expect(view.reloadButton).toHaveCount(0);
          expect(requests.count, "点击“重新加载”后 books.json 恰好再请求 1 次（7.17）").toBe(2);
        });

        await step("种子进度有效：正常加载后“最近阅读”列出该书", async () => {
          await expect(recentReads(page).entry(seededTitle)).toBeVisible();
        });
      });
    });
  });
}

// ---------------------------------------------------------------------------
// RDF 13.10、13.11：失败说明按类别显示，原始异常只进一行 [load-error] 日志
// ---------------------------------------------------------------------------

test.describe("RDF 13.10、13.11 书架加载失败的分类文案与 [load-error] 日志", () => {
  for (const kind of CLASSIFIED_FAILURES) {
    const text = SHELF_ERROR_TEXTS[kind.category];
    const statusClause = kind.status === null ? "status=-（没有响应）" : `status=${kind.status}`;
    test(`RDF 13.10、13.11 books.json ${kind.label}：失败说明为 ${kind.category} 的书架文案「${text}」，不显示书卡与最近阅读；console 中以“[load-error] ”开头的消息恰为 1 条，含 stage=catalog 与 ${statusClause}`, async ({
      page,
      lib,
    }) => {
      await seedOneProgress(page, lib);
      const requests = countBooksJsonRequests(page);
      const log = recordLoadErrorLog(page);

      await withBooksJsonRoute(page, failFirst(kind), async () => {
        await step("打开书架", async () => {
          await page.goto("/");
        });
        await expectFailureState(page, kind);
        await step("观测窗口终点：失败状态显示后等 2 个动画帧", async () => {
          await waitFrames(page, 2);
        });
        expect(requests.count, "books.json 只请求了 1 次").toBe(1);
      });
      log.stop();

      await expectSingleLoadErrorLog(log, { stage: "catalog", bookId: null, status: kind.status }, "RDF 13.10");
    });
  }
});
