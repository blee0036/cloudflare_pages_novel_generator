/**
 * Run_Summary 第 11 节"Perf_Metrics"的整理与渲染，以及 `e2e/.out/perf.json` 的内容（需求 1.7、
 * 14.2、14.4、14.5、14.7；设计"性能观测（需求 14）"的"汇总"一段与"Perf_Metrics"数据模型）。
 *
 * 本文件全是纯函数：不读写文件、不访问网络、不修改参数。reporter（`support/reporter.ts`）先把
 * `perf-metrics` 附件 `path` 指向的 JSON 读进 `body`，连同 CPU 读数与运行开始时间交给
 * `buildPerfReport`，把结果原样写成 `e2e/.out/perf.json`，再把 `renderPerfSection` 的结果作为
 * 该节正文。`PerfReport` 的字段与设计的数据模型一致（`runStartedAt`、`env`、`items`、`bookLoads`），
 * `e2e/acceptance/acceptance.py` 的 `render_perf` 按这些字段读取；其余字段是补充说明。
 *
 * ## (a)–(d)
 *
 * - 读数取自各 perf 用例的 `perf-metrics` 附件（`PerfMetricsAttachment`），按 `PERF_KEYS` 的顺序
 *   每项一行，由 `evaluatePerfItem` 给出中位数、最大值与状态（14.4、14.7）。同一项出现在多份附件里
 *   时取第一份，另记一条附件问题。
 * - 没有附件给出某项时，该项 5 次读数都记为 null、状态为"未采集"，不以 0 填充（14.7）。原因按负责
 *   该项的用例（`PERF_CASE_OF_KEY`）写明：本次未收集、未执行、跳过（附跳过原因），或附件缺失、
 *   无法解析。real 核对（4.3）未通过时 `target` fixture 在 `perf` fixture 建立之前就跳过了用例，
 *   没有附件，走的就是这一条。
 * - 表头的 Chromium 版本与 headless 标志取自第一份有效附件；一份都没有时为 null，写作"未知"。
 * - 超预算只做标注：本文件的结果不参与退出码与用例结果（1.7、14.4）。
 *
 * ## (e) `[book-load]`
 *
 * 取自全部用例的 `book-load` 附件（`bookLog` fixture 只在 real 下写），按用例顺序、附件顺序。只保留
 * 满足 14.2 条件的行（`BookLoadFilter`）：
 *
 * - 桌面视口：附件的 `viewport` 等于 `VIEWPORTS.desktop`。
 * - 默认主题：附件的 `theme`（该行出现时 `<html data-theme>` 的值）等于
 *   `expectedDataTheme(THEME_UNSET)`。14.2 的"默认主题"指 localStorage 中没有已存储的主题（用户
 *   决定，见 `support/theme.ts`），这时应用按 `DEFAULT_SETTINGS.theme` 渲染，当前是 `sepia`。
 *   所以这里**不**与字面量 `"default"` 比较：`data-theme="default"` 说明用例 seed 了主题键
 *   `default`，不属于默认主题。反过来，seed 了 `sepia` 的用例从 `data-theme` 上与默认主题无法区分，
 *   会被保留。
 * - Opaque_Mode：用例的 `mode` 注解（`target` fixture 写下）为 `opaque`，没有注解时按项目名判断
 *   （`-transparent` 结尾的项目为 Transparent_Mode）。设计原文只列了视口与主题，这里按 14.2 原文
 *   补上 Opaque_Mode。
 *
 * 未采集的打开（`status: "uncollected"`，14.7）没有视口与主题，只按模式过滤。不满足条件的行只计数
 * （`bookLoadsExcluded`），不列出。
 */
import { ANNOTATIONS, ATTACHMENTS, type BookLoadAttachment } from "../support/fixtures";
import { repoRelative } from "../support/library";
import { PERF, VIEWPORTS } from "../support/settings";
import {
  OUTCOME_LABELS,
  TITLE_SEPARATOR,
  UNSPECIFIED_SKIP_REASON,
  mdCell,
  mdCode,
  mdOneLine,
  mdTableRow,
  toCaseRow,
  type CaseFacts,
  type CaseOutcome,
} from "../support/summary";
import { THEME_UNSET, expectedDataTheme } from "../support/theme";
import {
  PERF_KEYS,
  PERF_METRICS_ATTACHMENT,
  evaluatePerfItem,
  type PerfEvaluated,
  type PerfItem,
  type PerfKey,
  type PerfMetricsAttachment,
  type PerfStatus,
} from "./metrics";

/** perf 用例的文件（相对仓库根，6.10：`real-perf` 项目只收集它）。 */
export const PERF_SPEC_FILE = "e2e/tests/real-perf/perf.spec.ts";

/** 各项由哪个 perf 用例采集（`perf.spec.ts` 中用例自身的标题）。 */
export const PERF_CASE_OF_KEY: Readonly<Record<PerfKey, string>> = {
  tocOpen: "perf-toc",
  tocScrollLongTask: "perf-toc",
  shelfSearch: "perf-shelf-search",
  readerSearchLongTask: "perf-reader-search",
};

/** 表中各项的写法（14.2 (a)–(d)）。 */
export const PERF_ITEM_LABELS: Readonly<Record<PerfKey, string>> = {
  tocOpen: "(a) 点击目录按钮到首个目录行进入视口",
  tocScrollLongTask: "(b) 目录抽屉直接滚到第 ⌈N/2⌉ 与第 N 个节点期间的最长长任务",
  shelfSearch: "(c) 书架检索末次按键到结果更新",
  readerSearchLongTask: "(d) 阅读器检索逐字键入期间的最长长任务",
};

/** 状态列的三种取值（14.5）。 */
export const PERF_STATUS_LABELS: Readonly<Record<PerfStatus, string>> = {
  within: "未超预算",
  over: "超预算",
  uncollected: "未采集",
};

/** (e) 的预算列（14.3、14.5）。 */
export const NO_BUDGET_TEXT = "无预算";

/** 读数单元格中未采集的写法；不以 0 填充（14.7）。 */
const UNCOLLECTED_READING = "未采集";

/** 中位数、最大值等没有数值时的写法。 */
const EMPTY_CELL = "—";

// ---------------------------------------------------------------------------
// 模型
// ---------------------------------------------------------------------------

/** 运行 reporter 的主机（`os.cpus()`，由 reporter 读取）。 */
export interface PerfHost {
  /** CPU 型号。 */
  cpu: string;
  /** 逻辑核数。 */
  cores: number;
}

/** Perf_Metrics 表头的运行环境（14.5）。 */
export interface PerfEnv extends PerfHost {
  /** `browser.version()`；没有有效的 `perf-metrics` 附件时为 null。 */
  chromium: string | null;
  /** 浏览器是否以 headless 模式运行；没有有效附件时为 null。 */
  headless: boolean | null;
}

interface ViewportSize {
  width: number;
  height: number;
}

/** (e) 的一行：一次打开的 `[book-load]` 字段，或一次未采集的打开（14.7）。 */
export type BookLoadRow =
  | {
      bookId: string;
      source: string;
      gz: string;
      chars: number;
      decompress: string;
      total: string;
      project: string;
      /** 用例：`<文件> › <标题路径>`。 */
      test: string;
      viewport: ViewportSize;
      theme: string;
    }
  | { bookId: string; project: string; test: string; status: "uncollected"; reason: string };

/** (e) 只保留的条件（14.2）。 */
export interface BookLoadFilter {
  viewport: ViewportSize;
  /** `expectedDataTheme(THEME_UNSET)`：默认主题下 `<html data-theme>` 的值（见文件头）。 */
  theme: string;
  mode: "opaque";
}

/** 一个 perf 用例的结果，写在表头供对照。 */
export interface PerfCaseSummary {
  /** 用例自身的标题（`perf-toc` 等）。 */
  title: string;
  project: string;
  outcome: CaseOutcome;
  /** 跳过原因，或失败的错误首行。 */
  detail?: string;
}

/** `e2e/.out/perf.json` 的内容。 */
export interface PerfReport {
  /** 运行开始时间，与 `results.json` 的 `startedAt` 为同一字符串。 */
  runStartedAt: string;
  env: PerfEnv;
  /** (a)–(d)，按 `PERF_KEYS` 的顺序，恰好 4 项。 */
  items: PerfEvaluated[];
  /** (e)，只含满足 `bookLoadFilter` 的行。 */
  bookLoads: BookLoadRow[];
  bookLoadFilter: BookLoadFilter;
  /** 不满足 `bookLoadFilter` 而未列入 (e) 的行数。 */
  bookLoadsExcluded: number;
  /** 本次收集到的 `perf.spec.ts` 用例，按套件顺序。 */
  cases: PerfCaseSummary[];
  /** 附件缺失正文、无法解析、重复给出某项等问题，逐条写入该节。 */
  problems: string[];
}

export interface PerfReportInput {
  /** 运行开始时间（`formatLocalTimestamp`）。 */
  runStartedAt: string;
  host: PerfHost;
  /**
   * 本次收集到的全部用例，按套件顺序。`perf-metrics` 附件须已带 `body`（reporter 读出 `path` 指向的
   * 文件）；只有 `path` 而没有 `body` 的记为附件问题。
   */
  cases: readonly CaseFacts[];
}

// ---------------------------------------------------------------------------
// 附件解析
// ---------------------------------------------------------------------------

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const decoder = new TextDecoder();

function bodyText(body: string | Uint8Array | undefined): string | undefined {
  if (body === undefined) return undefined;
  return typeof body === "string" ? body : decoder.decode(body);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPerfKey(value: unknown): value is PerfKey {
  return typeof value === "string" && (PERF_KEYS as readonly string[]).includes(value);
}

function parseJson(text: string): Parsed<unknown> {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    return { ok: false, error: `不是有效的 JSON（${error instanceof Error ? error.message : String(error)}）` };
  }
}

/** 解析 `perf-metrics` 附件的正文（`PerfMetricsAttachment`）；格式不符时给出原因，从不抛错。 */
export function parsePerfMetrics(text: string): Parsed<PerfMetricsAttachment> {
  const json = parseJson(text);
  if (!json.ok) return json;
  const data = json.value;
  if (!isRecord(data)) return { ok: false, error: "不是 JSON 对象" };
  const { items, chromium, headless } = data;
  if (!Array.isArray(items)) return { ok: false, error: "items 不是数组" };
  if (typeof chromium !== "string") return { ok: false, error: "chromium 不是字符串" };
  if (typeof headless !== "boolean") return { ok: false, error: "headless 不是布尔值" };

  const parsed: PerfItem[] = [];
  for (const [i, raw] of items.entries()) {
    if (!isRecord(raw)) return { ok: false, error: `items[${i}] 不是对象` };
    const { key, readings, reason } = raw;
    if (!isPerfKey(key)) {
      return { ok: false, error: `items[${i}].key 不是 ${PERF_KEYS.join("、")} 之一：${JSON.stringify(key)}` };
    }
    if (!Array.isArray(readings) || !readings.every((r) => r === null || typeof r === "number")) {
      return { ok: false, error: `items[${i}].readings 不是由数字与 null 组成的数组` };
    }
    if (reason !== undefined && typeof reason !== "string") {
      return { ok: false, error: `items[${i}].reason 不是字符串` };
    }
    const item: PerfItem = { key, readings: [...(readings as (number | null)[])] };
    if (reason !== undefined) item.reason = reason;
    parsed.push(item);
  }
  return { ok: true, value: { items: parsed, chromium, headless } };
}

function isViewport(value: unknown): value is ViewportSize {
  return isRecord(value) && typeof value.width === "number" && typeof value.height === "number";
}

/** 解析 `book-load` 附件的正文（`BookLoadAttachment`）；格式不符时给出原因，从不抛错。 */
export function parseBookLoadAttachment(text: string): Parsed<BookLoadAttachment> {
  const json = parseJson(text);
  if (!json.ok) return json;
  const d = json.value;
  if (!isRecord(d)) return { ok: false, error: "不是 JSON 对象" };
  const { bookId, status, reason, source, gz, chars, decompress, total, viewport, theme } = d;
  if (typeof bookId !== "string") return { ok: false, error: "bookId 不是字符串" };
  if (status === "uncollected") {
    if (typeof reason !== "string") return { ok: false, error: "未采集的记录缺少 reason" };
    return { ok: true, value: { bookId, status: "uncollected", reason } };
  }
  if (typeof source !== "string") return { ok: false, error: "source 不是字符串" };
  if (typeof gz !== "string") return { ok: false, error: "gz 不是字符串" };
  if (typeof decompress !== "string") return { ok: false, error: "decompress 不是字符串" };
  if (typeof total !== "string") return { ok: false, error: "total 不是字符串" };
  if (typeof chars !== "number" || !Number.isSafeInteger(chars) || chars < 0) {
    return { ok: false, error: "chars 不是非负整数" };
  }
  if (viewport !== null && !isViewport(viewport)) return { ok: false, error: "viewport 不是 { width, height } 或 null" };
  if (theme !== null && typeof theme !== "string") return { ok: false, error: "theme 不是字符串或 null" };
  return {
    ok: true,
    value: {
      bookId,
      source,
      gz,
      chars,
      decompress,
      total,
      viewport: viewport === null ? null : { width: viewport.width, height: viewport.height },
      theme,
    },
  };
}

// ---------------------------------------------------------------------------
// 整理
// ---------------------------------------------------------------------------

/** (e) 只保留的条件：桌面视口、默认主题（未存储主题时应用渲染的键）、Opaque_Mode（14.2）。 */
export function bookLoadFilter(): BookLoadFilter {
  return {
    viewport: { width: VIEWPORTS.desktop.width, height: VIEWPORTS.desktop.height },
    theme: expectedDataTheme(THEME_UNSET),
    mode: "opaque",
  };
}

/** 用例是否属于 perf 用例文件（按文件识别）。 */
export function isPerfCase(f: CaseFacts): boolean {
  return repoRelative(f.file) === PERF_SPEC_FILE;
}

function ownTitle(f: CaseFacts): string {
  return f.titlePath[f.titlePath.length - 1] ?? "";
}

function caseLabel(f: CaseFacts): string {
  return [repoRelative(f.file), ...f.titlePath].join(TITLE_SEPARATOR);
}

/** 用例的 `.txt.gz` 模式：`mode` 注解优先，否则按项目名（`-transparent` 结尾为 transparent）。 */
function modeOf(f: CaseFacts): string {
  const noted = f.annotations.find((a) => a.type === ANNOTATIONS.mode)?.description;
  if (noted !== undefined) return noted;
  return f.project.endsWith("-transparent") ? "transparent" : "opaque";
}

function sameViewport(a: ViewportSize | null, b: ViewportSize): boolean {
  return a !== null && a.width === b.width && a.height === b.height;
}

function summarizeCase(f: CaseFacts): PerfCaseSummary {
  const row = toCaseRow(f);
  const summary: PerfCaseSummary = { title: ownTitle(f), project: f.project, outcome: row.outcome };
  if (row.outcome === "skipped") summary.detail = row.skip?.reason ?? UNSPECIFIED_SKIP_REASON;
  else if (row.errorLine !== undefined) summary.detail = row.errorLine;
  return summary;
}

/** 没有附件给出 `key` 时的未采集原因（14.7）。 */
function missingItemReason(key: PerfKey, perfCases: readonly CaseFacts[], unreadable: ReadonlySet<string>): string {
  const title = PERF_CASE_OF_KEY[key];
  const owner = perfCases.find((f) => ownTitle(f) === title);
  if (owner === undefined) return `本次运行未收集用例 ${title}`;
  const { outcome, detail } = summarizeCase(owner);
  if (outcome === "notRun") return `用例 ${title} 未执行`;
  if (outcome === "skipped") return `用例 ${title} 跳过：${detail ?? UNSPECIFIED_SKIP_REASON}`;
  const label = OUTCOME_LABELS[outcome];
  return unreadable.has(owner.id)
    ? `用例 ${title}（${label}）的 perf-metrics 附件无法读取或解析`
    : `用例 ${title}（${label}）没有附上该项的读数`;
}

function uncollectedItem(key: PerfKey, reason: string): PerfItem {
  return { key, readings: Array.from({ length: PERF.samples }, (): number | null => null), reason };
}

/**
 * 由本次全部用例整理 Perf_Metrics（即 `e2e/.out/perf.json` 的内容）。见文件头的规则。
 */
export function buildPerfReport(input: PerfReportInput): PerfReport {
  const filter = bookLoadFilter();
  const problems: string[] = [];
  const found = new Map<PerfKey, PerfItem>();
  const unreadable = new Set<string>();
  const bookLoads: BookLoadRow[] = [];
  let bookLoadsExcluded = 0;
  let browser: { chromium: string; headless: boolean } | null = null;

  for (const f of input.cases) {
    const label = caseLabel(f);
    const opaque = modeOf(f) === filter.mode;
    for (const a of f.result?.attachments ?? []) {
      if (a.name === PERF_METRICS_ATTACHMENT) {
        const text = bodyText(a.body);
        if (text === undefined) {
          unreadable.add(f.id);
          const file = a.path === undefined ? "" : `，文件 ${repoRelative(a.path)} 未能读取`;
          problems.push(`${label}：perf-metrics 附件没有正文${file}`);
          continue;
        }
        const parsed = parsePerfMetrics(text);
        if (!parsed.ok) {
          unreadable.add(f.id);
          problems.push(`${label}：perf-metrics 附件无法解析：${parsed.error}`);
          continue;
        }
        browser ??= { chromium: parsed.value.chromium, headless: parsed.value.headless };
        for (const item of parsed.value.items) {
          if (found.has(item.key)) {
            problems.push(`${label}：${item.key} 已由之前的 perf-metrics 附件给出，本份的读数未采用`);
            continue;
          }
          found.set(item.key, item);
        }
      } else if (a.name === ATTACHMENTS.bookLoad) {
        const text = bodyText(a.body);
        const parsed = text === undefined ? null : parseBookLoadAttachment(text);
        if (parsed === null || !parsed.ok) {
          problems.push(`${label}：book-load 附件${parsed === null ? "没有正文" : `无法解析：${parsed.error}`}`);
          continue;
        }
        const line = parsed.value;
        if (!opaque) {
          bookLoadsExcluded += 1;
        } else if ("status" in line) {
          bookLoads.push({ bookId: line.bookId, project: f.project, test: label, status: "uncollected", reason: line.reason });
        } else if (!sameViewport(line.viewport, filter.viewport) || line.theme !== filter.theme) {
          bookLoadsExcluded += 1;
        } else {
          const { bookId, source, gz, chars, decompress, total } = line;
          bookLoads.push({
            bookId,
            source,
            gz,
            chars,
            decompress,
            total,
            project: f.project,
            test: label,
            viewport: { ...filter.viewport },
            theme: filter.theme,
          });
        }
      }
    }
  }

  const perfCases = input.cases.filter(isPerfCase);
  const items = PERF_KEYS.map((key) =>
    evaluatePerfItem(found.get(key) ?? uncollectedItem(key, missingItemReason(key, perfCases, unreadable))),
  );

  return {
    runStartedAt: input.runStartedAt,
    env: {
      cpu: input.host.cpu,
      cores: input.host.cores,
      chromium: browser?.chromium ?? null,
      headless: browser?.headless ?? null,
    },
    items,
    bookLoads,
    bookLoadFilter: filter,
    bookLoadsExcluded,
    cases: perfCases.map(summarizeCase),
    problems,
  };
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

/** 毫秒读数：至多 1 位小数，去掉末尾的 `.0`。 */
export function formatMs(ms: number): string {
  return String(Math.round(ms * 10) / 10);
}

function headlessText(headless: boolean | null): string {
  if (headless === null) return "未知（没有有效的 perf-metrics 附件）";
  return headless ? "headless" : "headed";
}

function casesText(cases: readonly PerfCaseSummary[]): string {
  if (cases.length === 0) return `本次运行未收集 ${mdCode(PERF_SPEC_FILE)} 的用例`;
  return cases
    .map((c) => {
      const project = c.project === "real-perf" ? "" : `，项目 ${c.project}`;
      const detail = c.outcome === "passed" || c.detail === undefined ? "" : `：${mdOneLine(c.detail)}`;
      return `${c.title}（${OUTCOME_LABELS[c.outcome]}${project}${detail}）`;
    })
    .join("；");
}

function countsText(items: readonly PerfEvaluated[]): string {
  const count = (s: PerfStatus): number => items.filter((i) => i.status === s).length;
  const parts = (["within", "over", "uncollected"] as const).map((s) => `${PERF_STATUS_LABELS[s]} ${count(s)}`);
  return `${parts.join("、")}（共 ${items.length} 项）`;
}

function statusCell(item: PerfEvaluated): string {
  const label = PERF_STATUS_LABELS[item.status];
  return mdCell(item.status === "uncollected" && item.reason !== undefined ? `${label}：${item.reason}` : label);
}

function itemRow(item: PerfEvaluated): string {
  const readings = Array.from({ length: PERF.samples }, (_, i) => {
    const value = item.readings[i];
    return value === null || value === undefined ? UNCOLLECTED_READING : formatMs(value);
  });
  return mdTableRow([
    mdCell(PERF_ITEM_LABELS[item.key]),
    ...readings,
    item.median === null ? EMPTY_CELL : formatMs(item.median),
    item.max === null ? EMPTY_CELL : formatMs(item.max),
    formatMs(item.budgetMs),
    statusCell(item),
  ]);
}

function bookLoadRow(row: BookLoadRow): string {
  const test = mdCell(`${row.test}（${row.project}）`);
  if ("status" in row) {
    return mdTableRow([
      mdCell(row.bookId),
      mdCell(`${UNCOLLECTED_READING}：${row.reason}`),
      EMPTY_CELL,
      EMPTY_CELL,
      EMPTY_CELL,
      EMPTY_CELL,
      NO_BUDGET_TEXT,
      test,
    ]);
  }
  return mdTableRow([
    mdCell(row.bookId),
    mdCell(row.source),
    mdCell(row.gz),
    String(row.chars),
    mdCell(row.decompress),
    mdCell(row.total),
    NO_BUDGET_TEXT,
    test,
  ]);
}

/** "Perf_Metrics"一节的 Markdown 正文（不含节标题）。只读数据，不做判定。 */
export function renderPerfSection(r: PerfReport): string[] {
  const { viewport, theme } = r.bookLoadFilter;
  const conditions = `桌面视口 ${viewport.width}×${viewport.height}、默认主题（未存储，实际 ${theme}）、Opaque_Mode`;
  const readingHeads = Array.from({ length: PERF.samples }, (_, i) => `第 ${i + 1} 次`);
  const lines = [
    `- 运行开始时间：${r.runStartedAt}`,
    `- CPU：${mdOneLine(r.env.cpu)}，${r.env.cores} 个逻辑核`,
    `- Chromium：${r.env.chromium === null ? "未知（没有有效的 perf-metrics 附件）" : r.env.chromium}；` +
      `浏览器模式：${headlessText(r.env.headless)}`,
    `- 采集条件（14.2）：${conditions}；真实时钟，不装 Controlled_Clock（14.8）`,
    `- perf 用例：${casesText(r.cases)}`,
    `- 结果：${countsText(r.items)}；超预算只做标注，不影响用例结果与退出码（1.7、14.4）`,
    "",
    "读数、中位数、最大值与 Perf_Budget 的单位均为 ms；(b)(d) 是观测窗口内的最长长任务，只会是 0 或 ≥ 50" +
      `（14.6）。Perf_Budget 只在 ${mdCode("e2e/support/settings.ts")} 的 ${mdCode("PERF.budgetsMs")} 配置（14.3）；` +
      "中位数大于 Perf_Budget 即超预算（14.4）。",
    "",
    mdTableRow(["项", ...readingHeads, "中位数", "最大值", "Perf_Budget", "状态"]),
    mdTableRow(Array.from({ length: PERF.samples + 5 }, () => "---")),
    ...r.items.map(itemRow),
    "",
    `### ${mdCode("[book-load]")}（14.2 (e)）`,
    "",
    `每次打开 Test_Book 一行，只列${conditions}下的打开；(e) 不设 Perf_Budget。`,
    "",
  ];

  if (r.bookLoads.length === 0) {
    lines.push(`本次没有满足条件的 ${mdCode("[book-load]")} 行。`);
  } else {
    lines.push(
      mdTableRow(["书 id", "source", "gz", "chars", "decompress", "total", "Perf_Budget", "用例"]),
      mdTableRow(Array.from({ length: 8 }, () => "---")),
      ...r.bookLoads.map(bookLoadRow),
    );
  }
  if (r.bookLoadsExcluded > 0) {
    lines.push("", `另有 ${r.bookLoadsExcluded} 条 ${mdCode("[book-load]")} 记录不满足上述条件，未列入。`);
  }

  if (r.problems.length > 0) {
    lines.push("", "### 附件问题", "", ...r.problems.map((p) => `- ${mdOneLine(p)}`));
  }
  return lines;
}
