/**
 * 阅读器：全书检索的结果列表、跳转高亮与高亮清除（需求 9.1–9.4、9.11；Checklist H4）。
 * `common/`：在 `fixture` 项目运行（Opaque_Mode、桌面视口、默认主题）。测试只用 Fixture_Library
 * （test-data-desensitization 去掉了 real 档）。
 *
 * ## 用书与检索词（4.4；9.1：K 一律由测试在运行时从该书全文计算）
 *
 * 书为 `lib.role("longText")`：3.3 (h) 的夹具书。全文由 `bookText` 在测试进程中解压 `.txt.gz` 得到；K 为
 * 关键词在全文中不区分大小写、互不重叠的出现次数（`findOccurrences`）。命中章节与检索词取 `roles.json` 的
 * `longText`：命中章节为 `chapterIndex`，少量命中词为 `fewKeyword`，大量命中词为 `capKeyword`，无命中词为
 * `noHitKeyword`。
 *
 * 取得后核对前提：1 ≤ K(少量) < 150、K(大量) ≥ 150、K(无命中) = 0，命中章节是正文章节且既非首个也非末个
 * （9.4 的前后两章都存在），少量命中词在命中章节内至少有一处不在标题行内。不成立是测试自身的问题（16.6），
 * 用例普通失败。所用的词与 K 记在注解 `search-keywords` 里。
 *
 * "章节标题行"：章节范围内第一个换行符之前的部分（预处理产物每章以标题行开头）。9.2 / 9.4 点击的结果是
 * 少量命中词在命中章节内、不在标题行内的第一处命中；K < 150，全部命中都在列表里，按命中先后即可算出它是
 * 第几条。夹具书的命中本就在长章节的中后部，离章首足够远：章首一屏内的命中不经滚动也在视口内，测不出 9.2
 * 的"滚入视口"。
 *
 * ## 各条的做法
 *
 * - 9.1：打开首个正文章节，经顶栏打开检索抽屉输入关键词。核对结果条数为 min(K, 150)、计数行、有无"仅展示
 *   前 150 处"，并逐条核对顺序：第 i 条的章节名为第 i 处命中所在章节，命中文字为原文该处的文字，命中前后的
 *   片段（去掉应用加的"..."与全部空白后）分别是原文该处之前文字的结尾、之后文字的开头。
 * - 9.2 / 9.3（RS-10、RS-11）：选择上述结果后不推进时钟，核对抽屉关闭、`<h1>` 等于结果项的章节名、正文区
 *   恰有 1 个 `<mark>` 且文本与关键词相同（不区分大小写）。然后推进到自点击起 4,900 ms（高亮仍在）与
 *   5,000 ms（高亮移除、滚动位置与 4,900 ms 时相同）。
 * - 9.2 边界框（单独的用例）：同样的前置之后，核对文档不可滚动（需求 2.1）与 `<mark>` 的边界框位于视口内、
 *   顶栏之下、底栏之上（栏移出视口时以视口边代替）。
 * - 9.4：6 种导航方式各一个用例（设计"补充场景"9.4 一条）。共用前置"点击命中章节内的检索结果"，自点击起
 *   1,000 ms 时核对高亮仍在并导航离开，核对当前章节与无高亮；3,000 ms（不足 5,000 ms）时导航回命中章节，
 *   再核对无高亮。书签方式的书签在前置之前于上一章添加（顶栏"添加书签"）。
 * - 9.11：打开命中章节并把正文滚到章中，输入无命中词；核对无匹配提示、0 条结果、无"仅展示前 150 处"，
 *   等 2 个动画帧后当前章节与滚动位置不变。
 *
 * ## 滚动容器
 *
 * 正文滚动容器是 `<main>`（reader-defect-fixes 需求 2.1、2.2）。应用把命中段落滚入视口时赋值
 * `<main>.scrollTop`。"滚动位置不变"类比较（9.3、9.11、RS-11）比较 `<main>` 的 `scrollTop`，比较前核对
 * 文档本身不可滚动（`expectDocumentNotScrollable`，需求 14.2）；9.11 的"滚到章中"同样只设 `<main>`。
 *
 * 历史：EV 验收时 `<main>` 随内容增高、实际滚动的是文档（Findings_Log F-002，已修复（reader-defect-fixes））：
 * 命中段落的滚入赋值无效，高亮落在视口之下。9.2 的边界框断言因此按 16.7 拆成单独的预期失败用例，"滚动位置
 * 不变"类比较同时比较 `<main>` 与文档。修复后边界框用例改为普通用例（划分保留），比较只对 `<main>` 进行。
 *
 * ## 时间（6.4、6.5）
 *
 * 9.1、9.11 不涉及时间，不装 Controlled_Clock。9.2 / 9.3 与 9.4 在首次导航前 `clock.install()`（起点
 * `CLOCK_T0`），书加载完成后暂停（`pauseAt` 须跳向将来，取 `PAUSE_LEAD_MS` 的余量；此时尚未打开抽屉，
 * 跳过的这段时间里没有与断言相关的计时器），此后只经 `page.clock.runFor` 推进；"自点击检索结果起"的累计
 * 推进量由 `sinceClick` 记账。React 的提交走 MessageChannel，不受时钟控制，暂停期间点击与换章照常渲染。
 * 顶栏与底栏在换章或检索跳转后 4.5 s 自动隐藏：9.4 在自点击起 1,000 ms 离开、3,000 ms 回来，两次操作栏内
 * 按钮时栏都可见。
 *
 * ## RS-10、RS-11
 *
 * 由标题为 `SHOT_TESTS.searchHighlight.title` 的用例在 `fixture` 项目中拍摄（Review_Catalog 的条目都属于
 * fixture）。默认主题（不 `seedTheme`）。RS-10 在 9.2 核对之后拍摄（栏可见）；RS-11 在 5,000 ms 时拍摄，
 * 拍摄前另核对滚动位置与拍摄 RS-10 时相同（同一段落）。RS-10 画面中高亮是否在视口内由评审按其准则判定
 * （EV 验收时受 F-002 影响不在视口内；该缺陷已修复（reader-defect-fixes））。
 */
import type { Locator, Page } from "@playwright/test";
import type { BookToc } from "../../../src/types";
import { SHOT_TESTS } from "../../review/catalog";
import { expect, test, type BookLog, type Lib } from "../../support/fixtures";
import { reader, readerJumpHighlight, searchDrawer, tocDrawer } from "../../support/locators";
import {
  bookText,
  bookUnderTest,
  expectCurrentChapter,
  expectDocumentNotScrollable,
  findOccurrences,
  openReader,
  openSearchDrawer,
  openTocDrawer,
  readMainScroll,
  readSearchResults,
  setMainScrollTop,
  waitFrames,
  type BookText,
  type BookUnderTest,
  type MainScroll,
  type SearchResultSnapshot,
} from "../../support/reader";
import { step } from "../../support/step";

// ---------------------------------------------------------------------------
// 常量（取自需求条文）
// ---------------------------------------------------------------------------

/** 9.1：结果条数上限。 */
const RESULT_CAP = 150;

/** 9.1：K ≥ 150 时检索抽屉中的提示（文案已对照 `src/components/SearchDrawer.tsx` 核实）。 */
const CAP_NOTICE = `仅展示前 ${RESULT_CAP} 处`;

/** 9.3：自点击检索结果起推进到此时，高亮仍须存在。 */
const HIGHLIGHT_KEPT_MS = 4_900;

/** 9.3：自点击检索结果起推进满此时，高亮须已移除。 */
const HIGHLIGHT_CLEARED_MS = 5_000;

/** 9.4：自点击检索结果起在此时导航离开命中章节（高亮仍在，顶栏与底栏可见）。 */
const NAV_AWAY_AT_MS = 1_000;

/** 9.4：自点击检索结果起在此时导航回命中章节（不足 `HIGHLIGHT_CLEARED_MS`，栏仍可见）。 */
const NAV_BACK_AT_MS = 3_000;

/** 书加载完成后暂停 Controlled_Clock 时向前跳的余量（与 `shelf-search-filter.spec.ts` 相同）。 */
const PAUSE_LEAD_MS = 1_000;

/** 9.1 顺序核对时，取原文命中前后各这么多个字符与结果片段比较（应用的片段远短于它）。 */
const CONTEXT_CHARS = 200;

/** 应用在结果片段前后加的省略号。 */
const ELLIPSIS = "...";

// ---------------------------------------------------------------------------
// 检索计划：检索词、K、命中所在章节与要点击的结果
// ---------------------------------------------------------------------------

/** 一处命中。 */
interface Hit {
  /** 全书偏移（UTF-16 码元）。 */
  offset: number;
  /** 所在节点的下标（`start ≤ offset < end`）；不在任何节点内时为 -1。 */
  chapter: number;
  /** 命中起点位于该节点的标题行内。 */
  inTitleLine: boolean;
}

/** 一个检索词及其在全书中的命中。 */
interface KeywordCase {
  keyword: string;
  /** K：全书不区分大小写、互不重叠的出现次数。 */
  count: number;
  /** 前 min(K, 150) 处命中，按先后。 */
  hits: Hit[];
  /** 选词依据（记入注解）。 */
  rule: string;
}

interface SearchPlan {
  book: BookUnderTest;
  toc: BookToc;
  text: BookText;
  /** 1 ≤ K < 150。 */
  few: KeywordCase;
  /** K ≥ 150。 */
  many: KeywordCase;
  /** K = 0。 */
  noHit: KeywordCase;
  /** 9.2 / 9.4 要点击的结果：`few` 在命中章节内、不在标题行内的第一处命中。 */
  target: { chapter: number; title: string; resultIndex: number; hit: Hit };
  /** 命中章节的上一个 / 下一个正文章节的下标。 */
  prev: number;
  next: number;
}

/** 选词结果（尚未计算命中）。 */
interface KeywordChoice {
  chapter: number;
  chapterRule: string;
  few: string;
  fewRule: string;
  many: string;
  manyRule: string;
  noHit: string;
  noHitRule: string;
}

/** 全书偏移 `offset` 所在的节点下标（最后一个 `start ≤ offset` 的节点，且 `offset < end`）；没有时为 -1。 */
function chapterAt(toc: BookToc, offset: number): number {
  const chapters = toc.chapters;
  let lo = 0;
  let hi = chapters.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (chapters[mid].start <= offset) lo = mid + 1;
    else hi = mid;
  }
  const index = lo - 1;
  return index >= 0 && offset < chapters[index].end ? index : -1;
}

/** 节点标题行之后第一个字符的全书偏移：节点范围内第一个换行符之后；范围内没有换行符时为节点末尾。 */
function bodyStart(text: BookText, toc: BookToc, chapter: number): number {
  const { start, end } = toc.chapters[chapter];
  const newline = text.text.indexOf("\n", start);
  return newline < 0 || newline >= end ? end : newline + 1;
}

function keywordCase(text: BookText, toc: BookToc, keyword: string, rule: string): KeywordCase {
  const found = findOccurrences(text, keyword, RESULT_CAP);
  const hits = found.offsets.map((offset): Hit => {
    const chapter = chapterAt(toc, offset);
    return { offset, chapter, inTitleLine: chapter >= 0 && offset < bodyStart(text, toc, chapter) };
  });
  return { keyword, count: found.count, hits, rule };
}

/** 命中章节与检索词取 `roles.json` 的 `longText`（见文件头）。 */
function fixtureChoice(lib: Lib): KeywordChoice {
  const { chapterIndex, fewKeyword, capKeyword, noHitKeyword } = lib.fixtureRoles().longText;
  return {
    chapter: chapterIndex,
    chapterRule: "roles.json longText.chapterIndex",
    few: fewKeyword,
    fewRule: "roles.json longText.fewKeyword",
    many: capKeyword,
    manyRule: "roles.json longText.capKeyword",
    noHit: noHitKeyword,
    noHitRule: "roles.json longText.noHitKeyword",
  };
}

function describePlan(plan: SearchPlan): string {
  const word = (label: string, kc: KeywordCase) => `${label}「${kc.keyword}」K=${kc.count}（${kc.rule}）`;
  const { target } = plan;
  return [
    `书 ${plan.book.id}`,
    word("少量命中词", plan.few),
    word("大量命中词", plan.many),
    word("无命中词", plan.noHit),
    `命中章节 下标 ${target.chapter}「${target.title}」，点击第 ${target.resultIndex + 1} 条结果（全书偏移 ${target.hit.offset}）`,
  ].join("；");
}

/**
 * 取本用例的检索计划（见文件头）。前提不成立即抛错（测试自身的问题，16.6）。须在用例体内调用：
 * `bookUnderTest` 会为大书设置用例超时。
 */
async function searchPlan(lib: Lib): Promise<SearchPlan> {
  const id = lib.role("longText");
  const book = await bookUnderTest(lib, id);
  return step("由全书文本推导检索词、K 与要点击的结果（9.1：K 由测试在运行时计算）", async () => {
    const [toc, text] = await Promise.all([lib.toc(id), bookText(lib, id)]);
    const { facts } = book;
    const choice = fixtureChoice(lib);
    const few = keywordCase(text, toc, choice.few, choice.fewRule);
    const many = keywordCase(text, toc, choice.many, choice.manyRule);
    const noHit = keywordCase(text, toc, choice.noHit, choice.noHitRule);

    const problems: string[] = [];
    if (!(few.count >= 1 && few.count < RESULT_CAP)) {
      problems.push(`少量命中词「${few.keyword}」的 K 应满足 1 ≤ K < ${RESULT_CAP}，实际为 ${few.count}`);
    }
    if (!(many.count >= RESULT_CAP)) {
      problems.push(`大量命中词「${many.keyword}」的 K 应 ≥ ${RESULT_CAP}，实际为 ${many.count}`);
    }
    if (noHit.count !== 0) problems.push(`无命中词「${noHit.keyword}」的 K 应为 0，实际为 ${noHit.count}`);
    const ordinal = facts.bodyOrdinals[choice.chapter];
    if (ordinal === null || ordinal === undefined || ordinal === 0 || ordinal === facts.bodyCount - 1) {
      problems.push(
        `命中章节（下标 ${choice.chapter}，${choice.chapterRule}）应为既非首个也非末个的正文章节（正文序号 ${ordinal ?? "无"}，共 ${facts.bodyCount} 章）`,
      );
    }
    const resultIndex = few.hits.findIndex((h) => h.chapter === choice.chapter && !h.inTitleLine);
    if (resultIndex < 0) {
      problems.push(`少量命中词「${few.keyword}」在命中章节（下标 ${choice.chapter}）内没有不在标题行内的命中`);
    }
    if (problems.length > 0 || ordinal === null || ordinal === undefined) {
      throw new Error(`${id} 的检索计划不满足前提：${problems.join("；")}`);
    }

    const plan: SearchPlan = {
      book,
      toc,
      text,
      few,
      many,
      noHit,
      target: {
        chapter: choice.chapter,
        title: facts.titles[choice.chapter],
        resultIndex,
        hit: few.hits[resultIndex],
      },
      prev: facts.bodyIndices[ordinal - 1],
      next: facts.bodyIndices[ordinal + 1],
    };
    test.info().annotations.push({ type: "search-keywords", description: describePlan(plan) });
    return plan;
  });
}

// ---------------------------------------------------------------------------
// 共用步骤
// ---------------------------------------------------------------------------

/** 打开 `?ch=<index>` 并按 8.1 判定当前章节为 `index`。 */
async function openAt(page: Page, bookLog: BookLog, book: BookUnderTest, index: number): Promise<void> {
  await openReader(page, bookLog, book, index);
  await expectCurrentChapter(page, book.facts, index);
}

/** 书加载完成后暂停 Controlled_Clock，此后时间只经 `page.clock.runFor` 推进。 */
async function pauseClock(page: Page): Promise<void> {
  await step("暂停 Controlled_Clock（此后只经 runFor 推进）", async () => {
    const now = await page.evaluate(() => Date.now());
    await page.clock.pauseAt(now + PAUSE_LEAD_MS);
  });
}

/** 自点击检索结果起 Controlled_Clock 的累计推进量（9.3、9.4）。 */
interface SinceClick {
  readonly elapsed: number;
  /** 推进到自点击起 `ms` 毫秒（只能向前）。 */
  advanceTo(ms: number): Promise<void>;
}

/** 在点击检索结果之后立即调用（时钟已暂停，点击本身不推进时间）。 */
function sinceClick(page: Page): SinceClick {
  let elapsed = 0;
  return {
    get elapsed() {
      return elapsed;
    },
    async advanceTo(ms) {
      if (ms < elapsed) throw new Error(`自点击起已推进 ${elapsed} ms，不能回到 ${ms} ms`);
      await step(`Controlled_Clock 推进到自点击检索结果起 ${ms} ms（+${ms - elapsed} ms）`, async () => {
        if (ms > elapsed) await page.clock.runFor(ms - elapsed);
      });
      elapsed = ms;
    },
  };
}

/** 在已打开的检索抽屉输入关键词，等结果条数达到 min(K, 150)。 */
async function typeKeyword(page: Page, kc: KeywordCase): Promise<void> {
  const drawer = searchDrawer(page);
  const shown = Math.min(kc.count, RESULT_CAP);
  await step(`在检索框输入「${kc.keyword}」（全书 K = ${kc.count}），等结果列表为 ${shown} 条`, async () => {
    await drawer.input.fill(kc.keyword);
    await expect(drawer.results).toHaveCount(shown);
  });
}

const squeeze = (s: string): string => s.replace(/\s+/g, "");

/** 9.1 的顺序核对：第 i 条结果对应第 i 处命中。返回不符之处。 */
function resultOrderProblems(rows: readonly SearchResultSnapshot[], plan: SearchPlan, kc: KeywordCase): string[] {
  const { text, toc } = plan;
  const problems: string[] = [];
  rows.forEach((row, i) => {
    const hit = kc.hits[i];
    if (hit === undefined) {
      problems.push(`第 ${i + 1} 条结果没有对应的命中（全书前 ${kc.hits.length} 处）`);
      return;
    }
    const where = `第 ${i + 1} 条（第 ${i + 1} 处命中，全书偏移 ${hit.offset}）`;
    const title = hit.chapter >= 0 ? toc.chapters[hit.chapter].title : "（不在任何节点内）";
    if (row.chapterTitle !== title) problems.push(`${where}的章节名应为「${title}」，实际为「${row.chapterTitle}」`);

    const end = hit.offset + kc.keyword.length;
    const matched = text.text.slice(hit.offset, end);
    if (row.mark !== matched) problems.push(`${where}的命中文字应为「${matched}」，实际为「${row.mark}」`);

    const before = squeeze(row.before.startsWith(ELLIPSIS) ? row.before.slice(ELLIPSIS.length) : row.before);
    if (!squeeze(text.text.slice(Math.max(0, hit.offset - CONTEXT_CHARS), hit.offset)).endsWith(before)) {
      problems.push(`${where}命中前的片段「${before}」不是原文该处之前文字的结尾`);
    }
    const after = squeeze(row.after.endsWith(ELLIPSIS) ? row.after.slice(0, -ELLIPSIS.length) : row.after);
    if (!squeeze(text.text.slice(end, end + CONTEXT_CHARS)).startsWith(after)) {
      problems.push(`${where}命中后的片段「${after}」不是原文该处之后文字的开头`);
    }
  });
  return problems;
}

/** 9.1：结果条数、计数行、上限提示与顺序。 */
async function expectResultList(page: Page, plan: SearchPlan, kc: KeywordCase): Promise<void> {
  const drawer = searchDrawer(page);
  const shown = Math.min(kc.count, RESULT_CAP);
  await step(`9.1 列出 min(K, ${RESULT_CAP}) = ${shown} 条结果，计数行为“找到 ${shown} 条匹配”`, async () => {
    await expect(drawer.results).toHaveCount(shown);
    await expect(drawer.resultCount).toHaveText(`找到 ${shown} 条匹配`);
  });
  if (kc.count >= RESULT_CAP) {
    await step(`9.1 K ≥ ${RESULT_CAP}：检索抽屉显示“${CAP_NOTICE}”`, async () => {
      await expect(drawer.capNotice).toHaveText(CAP_NOTICE);
    });
  } else {
    await step(`9.1 K < ${RESULT_CAP}：不显示“${CAP_NOTICE}”`, async () => {
      await expect(drawer.capNotice).toHaveCount(0);
    });
  }
  await step("9.1 结果按命中在全书中的先后排列：逐条核对章节名、命中文字与命中前后的片段", async () => {
    const rows = await readSearchResults(page);
    expect(rows.length, "结果条数").toBe(shown);
    const problems = resultOrderProblems(rows, plan, kc);
    const shownProblems = problems.slice(0, 10);
    if (problems.length > shownProblems.length) shownProblems.push(`……另有 ${problems.length - shownProblems.length} 处`);
    expect(shownProblems, "结果应按命中在全书中的先后顺序列出（9.1）").toEqual([]);
  });
}

/**
 * 经顶栏打开检索抽屉，输入少量命中词，点击 `plan.target` 那条结果（第 `resultIndex + 1` 条）。
 * `verify` 时点击前先核对该条的章节名与命中文字（9.1 已逐条核对顺序，这里只防点错）；9.2 边界框用例
 * 不做这项核对（EV 按 16.7 拆出时只含边界框断言，改为普通用例后保持不变）。返回点击时读到的该条结果
 * （`verify` 为 false 时为 null）。
 */
async function selectTargetResult(
  page: Page,
  plan: SearchPlan,
  verify: boolean,
): Promise<SearchResultSnapshot | null> {
  const { few, target } = plan;
  await openSearchDrawer(page);
  await typeKeyword(page, few);
  return step(
    `选择第 ${target.resultIndex + 1} 条结果：命中在「${target.title}」内（全书偏移 ${target.hit.offset}），不在章节标题行内`,
    async () => {
      let row: SearchResultSnapshot | null = null;
      if (verify) {
        row = (await readSearchResults(page))[target.resultIndex] ?? null;
        expect(row?.chapterTitle, "该条结果的章节名").toBe(target.title);
        expect(row?.mark.toLowerCase(), "该条结果的命中文字").toBe(few.keyword.toLowerCase());
      }
      await searchDrawer(page).results.nth(target.resultIndex).click();
      return row;
    },
  );
}

/**
 * 9.2 / 9.4 的共用前置：`selectTargetResult` 之后核对 9.2 的抽屉关闭、章节与高亮（不含边界框，边界框在
 * 单独的 9.2 用例中）。Controlled_Clock 须已暂停；返回自点击起的推进记账。
 */
async function jumpToTargetResult(page: Page, plan: SearchPlan): Promise<SinceClick> {
  const { few, target } = plan;
  const chosen = await selectTargetResult(page, plan, true);
  const since = sinceClick(page);
  if (chosen === null) throw new Error("selectTargetResult 在 verify 时应返回所点的结果");
  await step(
    "9.2 检索抽屉关闭，正文区 <h1> 等于结果项的章节名，正文区恰有 1 个高亮且其文本与关键词相同（不区分大小写）",
    async () => {
      await expect(searchDrawer(page).marker, "检索抽屉应已关闭").toHaveCount(0);
      await expect(reader(page).chapterHeading, "正文区 <h1> 应等于结果项的章节名").toHaveText(chosen.chapterTitle);
      const mark = readerJumpHighlight(page);
      await expect(mark, "正文区应恰有 1 个高亮元素").toHaveCount(1);
      const markText = (await mark.textContent()) ?? "";
      expect(markText.toLowerCase(), "高亮文本应与关键词相同（不区分大小写）").toBe(few.keyword.toLowerCase());
    },
  );
  await expectCurrentChapter(page, plan.book.facts, target.chapter);
  return since;
}

interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

function boxOf(locator: Locator): Promise<Box> {
  return locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
  });
}

/** 9.2：高亮元素的边界框位于视口内、顶栏之下、底栏之上（栏移出视口即未显示，以视口边代替）。 */
async function expectHighlightInView(page: Page): Promise<void> {
  await step(
    "9.2 高亮边界框：左右边在视口内，上边 ≥ 顶栏下边，下边 ≤ 底栏上边（栏未显示时以视口上边 / 下边代替）",
    async () => {
      const view = reader(page);
      const viewport = page.viewportSize();
      if (viewport === null) throw new Error("页面没有固定视口");
      const [mark, topBar, bottomBar] = await Promise.all([
        boxOf(readerJumpHighlight(page)),
        boxOf(view.topBar),
        boxOf(view.bottomBar),
      ]);
      const upper = Math.max(0, topBar.bottom);
      const lower = Math.min(viewport.height, bottomBar.top);
      const problems: string[] = [];
      if (mark.left < 0) problems.push(`左边 ${mark.left} < 0`);
      if (mark.right > viewport.width) problems.push(`右边 ${mark.right} > 视口宽 ${viewport.width}`);
      if (mark.top < upper) problems.push(`上边 ${mark.top} < ${upper}（顶栏下边 ${topBar.bottom}）`);
      if (mark.bottom > lower) problems.push(`下边 ${mark.bottom} > ${lower}（底栏上边 ${bottomBar.top}）`);
      expect(problems, `高亮边界框 ${JSON.stringify(mark)} 应位于视口内、顶栏与底栏之间（9.2）`).toEqual([]);
    },
  );
}

/** 章中的滚动位置：可视高度与最大可滚距离一半中的较小者（不可滚动时为 0）。 */
async function midScrollTop(reading: Promise<MainScroll>): Promise<number> {
  const { clientHeight, scrollHeight } = await reading;
  return Math.max(0, Math.min(clientHeight, Math.floor((scrollHeight - clientHeight) / 2)));
}

/** 正文滚动容器 `<main>` 的 `scrollTop`。 */
async function readPosition(page: Page): Promise<number> {
  return (await readMainScroll(page)).scrollTop;
}

async function expectNoHighlight(page: Page, title: string): Promise<void> {
  await step(title, async () => {
    await expect(readerJumpHighlight(page), "正文区不应有高亮元素").toHaveCount(0);
  });
}

// ---------------------------------------------------------------------------
// 9.1 结果条数与上限提示
// ---------------------------------------------------------------------------

test.describe("9.1 检索结果条数与上限提示", () => {
  test("9.1 1 ≤ K < 150 的关键词：按命中先后列出 K 条结果，不显示“仅展示前 150 处”", async ({
    page,
    lib,
    bookLog,
  }) => {
    const plan = await searchPlan(lib);
    await openAt(page, bookLog, plan.book, plan.book.facts.bodyIndices[0]);
    await openSearchDrawer(page);
    await typeKeyword(page, plan.few);
    await expectResultList(page, plan, plan.few);
  });

  test("9.1 K ≥ 150 的关键词：按命中先后列出前 150 条结果，并显示“仅展示前 150 处”", async ({
    page,
    lib,
    bookLog,
  }) => {
    const plan = await searchPlan(lib);
    await openAt(page, bookLog, plan.book, plan.book.facts.bodyIndices[0]);
    await openSearchDrawer(page);
    await typeKeyword(page, plan.many);
    await expectResultList(page, plan, plan.many);
  });
});

// ---------------------------------------------------------------------------
// 9.2 9.3 跳转高亮与 5 s 清除（RS-10、RS-11）
// ---------------------------------------------------------------------------

test.describe("9.2 9.3 检索跳转高亮", () => {
  test(SHOT_TESTS.searchHighlight.title, async ({ page, lib, bookLog, clock, shot }) => {
    // RS-10、RS-11 为默认主题（localStorage 中没有已存储的主题），不 seedTheme
    const plan = await searchPlan(lib);
    await clock.install();
    await openAt(page, bookLog, plan.book, plan.book.facts.bodyIndices[0]);
    await pauseClock(page);

    // 9.2 的边界框断言在下一个用例中（EV 因 F-002 按 16.7 拆出；已修复（reader-defect-fixes），拆分保留）
    const since = await jumpToTargetResult(page, plan);
    const atJump = await readPosition(page);
    await shot("search-highlight");

    await since.advanceTo(HIGHLIGHT_KEPT_MS);
    const kept = await step(`9.3 自点击起 ${HIGHLIGHT_KEPT_MS} ms：高亮仍在`, async () => {
      await expect(readerJumpHighlight(page), "高亮元素应仍存在").toHaveCount(1);
      return readPosition(page);
    });

    await since.advanceTo(HIGHLIGHT_CLEARED_MS);
    await expectDocumentNotScrollable(page);
    await step(
      `9.3 自点击起满 ${HIGHLIGHT_CLEARED_MS} ms：高亮已移除，滚动位置与移除前相同（<main> scrollTop ${kept}）`,
      async () => {
        await expect(readerJumpHighlight(page), "高亮元素应已移除").toHaveCount(0);
        expect(await readPosition(page), "高亮移除前后 <main> 的 scrollTop").toBe(kept);
      },
    );
    await expectCurrentChapter(page, plan.book.facts, plan.target.chapter);

    if (shot.applies("search-highlight-cleared")) {
      await step(
        `RS-11 画面：滚动位置与拍摄 RS-10 时相同（<main> scrollTop ${atJump}），即同一段落`,
        async () => {
          expect(await readPosition(page), "<main> 的 scrollTop").toBe(atJump);
        },
      );
    }
    await shot("search-highlight-cleared");
  });

  test("9.2 选择检索结果后高亮边界框位于视口内、顶栏之下、底栏之上（命中段落应滚入视口）", async ({
    page,
    lib,
    bookLog,
    clock,
  }) => {
    const plan = await searchPlan(lib);
    // 与上一用例相同的前置；暂停时钟使顶栏与底栏在度量时保持可见
    await clock.install();
    await openAt(page, bookLog, plan.book, plan.book.facts.bodyIndices[0]);
    await pauseClock(page);
    await selectTargetResult(page, plan, false);
    await step("等正文区出现高亮元素", async () => {
      await expect(readerJumpHighlight(page)).toHaveCount(1);
    });
    await expectDocumentNotScrollable(page);
    await expectHighlightInView(page);
  });
});

// ---------------------------------------------------------------------------
// 9.4 导航清除高亮
// ---------------------------------------------------------------------------

type Side = "prev" | "next";

interface NavCase {
  /** 用例标题中的导航方式。 */
  label: string;
  /** 离开后所在的章节：命中章节的上一章或下一章。 */
  to: Side;
  /** 书签跳转：前置中先在 `to` 所指的章添加书签（打开阅读器时就在那一章）。 */
  bookmark: boolean;
  away(page: Page, plan: SearchPlan): Promise<void>;
  /** 回到命中章节的方式。 */
  backLabel: string;
  back(page: Page, plan: SearchPlan): Promise<void>;
}

/** 焦点在 `<body>` 上时按下 `key`（阅读器的换章快捷键不接管输入类元素上的按键）。 */
async function pressKey(page: Page, key: "ArrowLeft" | "ArrowRight"): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => document.activeElement === document.body), {
      message: "按键前焦点应在 <body> 上",
    })
    .toBe(true);
  await page.keyboard.press(key);
}

/** 经顶栏打开目录抽屉（`fromBookmarks` 时先切回"章节目录"页签），点击下标 `index` 的章节行。 */
async function clickTocChapter(
  page: Page,
  plan: SearchPlan,
  index: number,
  fromBookmarks = false,
): Promise<void> {
  const drawer = tocDrawer(page);
  await openTocDrawer(page);
  if (fromBookmarks) await drawer.tabToc.click();
  await drawer.chapter(plan.book.facts.titles[index]).click();
  await expect(drawer.marker, "目录抽屉应已关闭").toHaveCount(0);
}

/** 经顶栏打开目录抽屉，切到"我的书签"，点击上一章的书签条目。 */
async function jumpViaBookmark(page: Page, plan: SearchPlan): Promise<void> {
  const drawer = tocDrawer(page);
  await openTocDrawer(page);
  await drawer.tabBookmarks.click();
  await expect(drawer.bookmarkDeleteButtons, "“我的书签”应只有前置中添加的 1 条").toHaveCount(1);
  await drawer.bookmarkEntry(plan.book.facts.titles[plan.prev]).click();
  await expect(drawer.marker, "目录抽屉应已关闭").toHaveCount(0);
}

const NAV_CASES: readonly NavCase[] = [
  {
    label: "“上一章 (←)”按钮",
    to: "prev",
    bookmark: false,
    away: (page) => reader(page).prevChapterButton.click(),
    backLabel: "“下一章 (→)”按钮",
    back: (page) => reader(page).nextChapterButton.click(),
  },
  {
    label: "“下一章 (→)”按钮",
    to: "next",
    bookmark: false,
    away: (page) => reader(page).nextChapterButton.click(),
    backLabel: "“上一章 (←)”按钮",
    back: (page) => reader(page).prevChapterButton.click(),
  },
  {
    label: " ← 键",
    to: "prev",
    bookmark: false,
    away: (page) => pressKey(page, "ArrowLeft"),
    backLabel: " → 键",
    back: (page) => pressKey(page, "ArrowRight"),
  },
  {
    label: " → 键",
    to: "next",
    bookmark: false,
    away: (page) => pressKey(page, "ArrowRight"),
    backLabel: " ← 键",
    back: (page) => pressKey(page, "ArrowLeft"),
  },
  {
    label: "目录抽屉点击上一章",
    to: "prev",
    bookmark: false,
    away: (page, plan) => clickTocChapter(page, plan, plan.prev),
    backLabel: "目录抽屉点击命中章节",
    back: (page, plan) => clickTocChapter(page, plan, plan.target.chapter),
  },
  {
    label: "“我的书签”点击上一章的书签条目",
    to: "prev",
    bookmark: true,
    away: jumpViaBookmark,
    backLabel: "目录抽屉点击命中章节",
    back: (page, plan) => clickTocChapter(page, plan, plan.target.chapter, true),
  },
];

test.describe("9.4 导航清除检索高亮", () => {
  for (const nav of NAV_CASES) {
    const side = nav.to === "prev" ? "上一章" : "下一章";
    test(`9.4 高亮存在时以${nav.label}导航到${side}：导航后正文无高亮；自点击起 ${NAV_BACK_AT_MS} ms（不足 ${HIGHLIGHT_CLEARED_MS} ms）时以${nav.backLabel}回到命中章节，仍无高亮`, async ({
      page,
      lib,
      bookLog,
      clock,
    }) => {
      const plan = await searchPlan(lib);
      const { facts } = plan.book;
      const away = plan[nav.to];

      await clock.install();
      await openAt(page, bookLog, plan.book, nav.bookmark ? away : facts.bodyIndices[0]);
      await pauseClock(page);
      if (nav.bookmark) {
        await step(`在「${facts.titles[away]}」点击顶栏“添加书签”（书签跳转的目标）`, async () => {
          const view = reader(page);
          await view.addBookmarkButton.click();
          await expect(view.removeBookmarkButton).toBeVisible();
        });
      }

      const since = await jumpToTargetResult(page, plan);
      await since.advanceTo(NAV_AWAY_AT_MS);
      await step(`自点击起 ${NAV_AWAY_AT_MS} ms：高亮仍在（导航前）`, async () => {
        await expect(readerJumpHighlight(page), "导航前正文区应有高亮").toHaveCount(1);
      });

      await step(`以${nav.label}导航到${side}「${facts.titles[away]}」`, () => nav.away(page, plan));
      await expectCurrentChapter(page, facts, away);
      await expectNoHighlight(page, "9.4 导航后正文区没有高亮元素");

      await since.advanceTo(NAV_BACK_AT_MS);
      await step(`以${nav.backLabel}回到命中章节「${plan.target.title}」`, () => nav.back(page, plan));
      await expectCurrentChapter(page, facts, plan.target.chapter);
      await expectNoHighlight(
        page,
        `9.4 自点击起 ${NAV_BACK_AT_MS} ms（不足 ${HIGHLIGHT_CLEARED_MS} ms）回到命中章节：正文区没有高亮元素`,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// 9.11 无命中
// ---------------------------------------------------------------------------

test.describe("9.11 无命中", () => {
  test("9.11 K = 0 的关键词：显示无匹配提示，0 条结果，不显示“仅展示前 150 处”，当前章节与 scrollTop 不变", async ({
    page,
    lib,
    bookLog,
  }) => {
    const plan = await searchPlan(lib);
    const { chapter } = plan.target;
    const drawer = searchDrawer(page);

    await openAt(page, bookLog, plan.book, chapter);
    await expectDocumentNotScrollable(page);
    const before = await step(
      "把正文滚到章中：<main> 的 scrollTop 设为其可视高度与最大可滚距离一半中的较小者",
      async () => {
        await setMainScrollTop(page, await midScrollTop(readMainScroll(page)));
        await waitFrames(page);
        const position = await readPosition(page);
        expect(position, "<main> 应已离开章首（命中章节的正文应可滚动）").toBeGreaterThan(0);
        return position;
      },
    );

    await openSearchDrawer(page);
    await step(`在检索框输入「${plan.noHit.keyword}」（全书 K = ${plan.noHit.count}）`, async () => {
      await drawer.input.fill(plan.noHit.keyword);
    });
    await step(`9.11 显示无匹配提示，结果 0 条，不显示“${CAP_NOTICE}”`, async () => {
      await expect(drawer.noHits).toHaveText(`未在全书中找到与 "${plan.noHit.keyword}" 相关的内容`);
      await expect(drawer.results).toHaveCount(0);
      await expect(drawer.capNotice).toHaveCount(0);
    });
    await step(`9.11 等 2 个动画帧（之后比较滚动位置）`, () => waitFrames(page));
    await expectDocumentNotScrollable(page);
    await step(`9.11 滚动位置不变（<main> scrollTop ${before}）`, async () => {
      expect(await readPosition(page), "检索前后 <main> 的 scrollTop").toBe(before);
    });
    await expectCurrentChapter(page, plan.book.facts, chapter);
  });
});
