/**
 * Run_Summary "Perf_Metrics"一节与 `e2e/.out/perf.json` 的例子测试（`tooling` 项目，无浏览器；
 * 任务 19.6，需求 1.7、14.2、14.4、14.5、14.7）。被测的是 `perf/report.ts` 的纯函数：
 *
 * - `buildPerfReport`：(a)–(d) 由 `perf-metrics` 附件得出、按 `PERF_KEYS` 排列；缺附件时按用例的
 *   结果写明未采集的原因；(e) 只保留桌面视口、默认主题、Opaque_Mode 的 `[book-load]` 行。
 * - `renderPerfSection`：表头的环境（14.5）、每项 5 次读数与中位数、最大值、Perf_Budget、状态，
 *   (e) 的预算列写"无预算"。
 *
 * 期望值按需求原文写在本文件里；`CaseFacts` 手写，形状与 reporter 的 `toCaseFacts` 相同，
 * `perf-metrics` 附件按 reporter 读出文件后的样子带 `body`。只跑 fixture 时该节写"未运行"，由
 * `run-summary.spec.ts` 的"未运行"一例覆盖。
 */
import { expect, test } from "@playwright/test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PERF_KEYS, PERF_METRICS_ATTACHMENT, type PerfItem } from "../../perf/metrics";
import {
  NO_BUDGET_TEXT,
  PERF_ITEM_LABELS,
  PERF_SPEC_FILE,
  buildPerfReport,
  renderPerfSection,
  type PerfReport,
} from "../../perf/report";
import { ANNOTATIONS, ATTACHMENTS, type BookLoadAttachment } from "../../support/fixtures";
import { PERF, VIEWPORTS } from "../../support/settings";
import type { CaseAnnotation, CaseAttachment, CaseFacts, TestStatus } from "../../support/summary";
import { THEME_UNSET, expectedDataTheme } from "../../support/theme";

/** 仓库根（本文件位于 `e2e/tests/tooling/`）。 */
const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));

const STARTED_AT = "2025-06-01T20:00:00.000+08:00";
const HOST = { cpu: "Example CPU @ 3.00GHz", cores: 8 };
const CHROMIUM = "151.0.7922.34";
const PERF_DESCRIBE = "需求 14 性能观测（只记录，不设门）";
const REAL_FILE = "e2e/tests/real/load-progress-opaque.spec.ts";
const TRANSPARENT_FILE = "e2e/tests/real-transparent/load-progress-transparent.spec.ts";

/** 需求 14.5 状态列的三种写法。 */
const STATUS = { within: "未超预算", over: "超预算", uncollected: "未采集" } as const;

// ---------------------------------------------------------------------------
// CaseFacts
// ---------------------------------------------------------------------------

interface CaseSpec {
  file: string;
  titlePath: string[];
  project: string;
  mode?: "opaque" | "transparent";
  /** 省略时为 passed；null 表示没有结果（未执行）。 */
  status?: TestStatus | null;
  annotations?: CaseAnnotation[];
  attachments?: CaseAttachment[];
}

function caseFacts(c: CaseSpec): CaseFacts {
  const annotations: CaseAnnotation[] = [
    { type: ANNOTATIONS.profile, description: "real" },
    { type: ANNOTATIONS.mode, description: c.mode ?? "opaque" },
    ...(c.annotations ?? []),
  ];
  const status = c.status === undefined ? "passed" : c.status;
  return {
    id: `${c.project}:${c.titlePath.join("/")}`,
    file: path.join(REPO_ROOT, c.file),
    titlePath: c.titlePath,
    project: c.project,
    expectedStatus: "passed",
    timeoutMs: 180_000,
    annotations,
    result:
      status === null
        ? null
        : { status, startMs: 0, durationMs: 1, errors: [], attachments: c.attachments ?? [] },
  };
}

function perfCase(title: string, rest: Omit<CaseSpec, "file" | "titlePath" | "project"> = {}): CaseFacts {
  return caseFacts({ file: PERF_SPEC_FILE, titlePath: [PERF_DESCRIBE, title], project: "real-perf", ...rest });
}

function metrics(items: PerfItem[], headless = true): CaseAttachment {
  return { name: PERF_METRICS_ATTACHMENT, body: JSON.stringify({ items, chromium: CHROMIUM, headless }) };
}

function bookLoad(body: BookLoadAttachment): CaseAttachment {
  return { name: ATTACHMENTS.bookLoad, body: Buffer.from(JSON.stringify(body)) };
}

function report(cases: CaseFacts[]): PerfReport {
  return buildPerfReport({ runStartedAt: STARTED_AT, host: HOST, cases });
}

// ---------------------------------------------------------------------------
// 渲染结果的读取
// ---------------------------------------------------------------------------

function cellsOf(row: string): string[] {
  return row.slice(2, -2).split(" | ");
}

/** 首格为 `first` 的表格行的各格。 */
function rowOf(lines: readonly string[], first: string): string[] {
  const row = lines.find((l) => l.startsWith(`| ${first} |`));
  assert.ok(row !== undefined, `没有首格为 ${first} 的行：\n${lines.join("\n")}`);
  return cellsOf(row);
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

test.describe("Perf_Metrics 一节与 perf.json（任务 19.6）", () => {
  test("三个 perf 用例都附上读数：按 (a)–(d) 排列，中位数、最大值与状态来自 5 次读数，表头注明运行环境", () => {
    const r = report([
      // 用例顺序与 (a)–(d) 不同：行序只取 PERF_KEYS
      perfCase("perf-reader-search", { attachments: [metrics([{ key: "readerSearchLongTask", readings: [0, 0, 0, 0, 0] }])] }),
      perfCase("perf-toc", {
        attachments: [
          metrics([
            { key: "tocOpen", readings: [14.5, 14.799999982118607, 15.399999976158142, 15, 14.8] },
            { key: "tocScrollLongTask", readings: [0, 120, 0, 130, 110] },
          ]),
        ],
      }),
      perfCase("perf-shelf-search", {
        attachments: [metrics([{ key: "shelfSearch", readings: [263, 265, 270.7000000178814, 261, 267.89999997615814] }])],
      }),
    ]);

    expect(r.items.map((i) => i.key)).toEqual([...PERF_KEYS]);
    expect(r.items.map((i) => i.status)).toEqual(["within", "over", "within", "within"]);
    // (b)：排序后 [0, 0, 110, 120, 130]，中位数 110 > 预算 100 → 超预算；最大值 130
    const scroll = r.items[1];
    expect([scroll.median, scroll.max, scroll.budgetMs]).toEqual([110, 130, PERF.budgetsMs.tocScrollLongTask]);
    expect(r.items[2].median).toBe(265);
    expect(r.env).toEqual({ cpu: HOST.cpu, cores: HOST.cores, chromium: CHROMIUM, headless: true });
    expect(r.runStartedAt).toBe(STARTED_AT);
    expect(r.problems).toEqual([]);
    expect(r.cases.map((c) => [c.title, c.outcome])).toEqual([
      ["perf-reader-search", "passed"],
      ["perf-toc", "passed"],
      ["perf-shelf-search", "passed"],
    ]);

    // perf.json 含设计数据模型的字段（acceptance.py 的 render_perf 按它们读取）
    const json = JSON.parse(JSON.stringify(r)) as Record<string, unknown>;
    for (const key of ["runStartedAt", "env", "items", "bookLoads"]) expect(json).toHaveProperty(key);
    expect(Object.keys(r.items[0]).sort()).toEqual(["budgetMs", "key", "max", "median", "readings", "status"]);

    const lines = renderPerfSection(r);
    // 14.5：表格上方注明 CPU 型号、逻辑核数、Chromium 版本、headless / headed 与运行开始时间
    const head = lines.slice(0, lines.findIndex((l) => l.startsWith("| ")));
    expect(head).toContain(`- 运行开始时间：${STARTED_AT}`);
    expect(head).toContain(`- CPU：${HOST.cpu}，${HOST.cores} 个逻辑核`);
    expect(head).toContain(`- Chromium：${CHROMIUM}；浏览器模式：headless`);
    expect(head.some((l) => l.includes("超预算 1") && l.includes("不影响用例结果与退出码"))).toBe(true);

    // 每项一行：5 次读数、中位数、最大值、Perf_Budget、状态
    const header = rowOf(lines, "项");
    expect(header).toEqual(["项", "第 1 次", "第 2 次", "第 3 次", "第 4 次", "第 5 次", "中位数", "最大值", "Perf_Budget", "状态"]);
    expect(rowOf(lines, PERF_ITEM_LABELS.tocOpen)).toEqual([
      PERF_ITEM_LABELS.tocOpen, "14.5", "14.8", "15.4", "15", "14.8", "14.8", "15.4", "500", STATUS.within,
    ]);
    expect(rowOf(lines, PERF_ITEM_LABELS.tocScrollLongTask)).toEqual([
      PERF_ITEM_LABELS.tocScrollLongTask, "0", "120", "0", "130", "110", "110", "130", "100", STATUS.over,
    ]);
    expect(rowOf(lines, PERF_ITEM_LABELS.shelfSearch).slice(1)).toEqual([
      "263", "265", "270.7", "261", "267.9", "265", "270.7", "350", STATUS.within,
    ]);
    expect(lines.filter((l) => /^\| \([a-d]\) /.test(l))).toHaveLength(PERF_KEYS.length);
    expect(lines).not.toContain("### 附件问题");
  });

  test("缺少读数：跳过（无附件）、未执行与未收集各自写明原因，5 次读数记 null 不以 0 填充；Chromium 与模式写未知", () => {
    const skip = "[4.3] real 书库核对未通过：public/data/books.json 缺失";
    const r = report([
      perfCase("perf-toc", { status: "skipped", annotations: [{ type: "skip", description: skip }] }),
      perfCase("perf-reader-search", { status: null }),
    ]);

    expect(r.items.map((i) => i.status)).toEqual(["uncollected", "uncollected", "uncollected", "uncollected"]);
    expect(r.items.map((i) => i.reason)).toEqual([
      `用例 perf-toc 跳过：${skip}`,
      `用例 perf-toc 跳过：${skip}`,
      "本次运行未收集用例 perf-shelf-search",
      "用例 perf-reader-search 未执行",
    ]);
    for (const item of r.items) {
      expect(item.readings).toEqual(Array.from({ length: PERF.samples }, () => null));
      expect([item.median, item.max]).toEqual([null, null]);
    }
    expect(r.env.chromium).toBeNull();
    expect(r.env.headless).toBeNull();

    const lines = renderPerfSection(r);
    expect(lines).toContain("- Chromium：未知（没有有效的 perf-metrics 附件）；浏览器模式：未知（没有有效的 perf-metrics 附件）");
    expect(rowOf(lines, PERF_ITEM_LABELS.shelfSearch)).toEqual([
      PERF_ITEM_LABELS.shelfSearch,
      ...Array.from({ length: PERF.samples }, () => "未采集"),
      "—",
      "—",
      "350",
      `${STATUS.uncollected}：本次运行未收集用例 perf-shelf-search`,
    ]);
  });

  test("perf 用例一个都没收集到时照常列出 4 项未采集，并注明未收集 perf.spec.ts", () => {
    const r = report([]);
    expect(r.items.map((i) => [i.status, i.reason])).toEqual([
      ["uncollected", "本次运行未收集用例 perf-toc"],
      ["uncollected", "本次运行未收集用例 perf-toc"],
      ["uncollected", "本次运行未收集用例 perf-shelf-search"],
      ["uncollected", "本次运行未收集用例 perf-reader-search"],
    ]);
    expect(r.cases).toEqual([]);
    expect(r.bookLoads).toEqual([]);
    const lines = renderPerfSection(r);
    expect(lines).toContain(`- perf 用例：本次运行未收集 \`${PERF_SPEC_FILE}\` 的用例`);
    expect(lines).toContain("本次没有满足条件的 `[book-load]` 行。");
  });

  test("(e) 只保留桌面视口、默认主题（未存储主题时的 data-theme，不是字面量 default）、Opaque_Mode 的行，未采集的打开照列", () => {
    const defaultTheme = expectedDataTheme(THEME_UNSET);
    // 前提：未存储主题时应用渲染的不是主题键 default（当前为 sepia），否则下面的对照没有意义
    expect(defaultTheme).not.toBe("default");
    const desktop = { ...VIEWPORTS.desktop };
    const line = { source: "network", gz: "22.36MB", chars: 60_123_456, decompress: "412ms", total: "2410ms" };

    const r = report([
      perfCase("perf-toc", {
        attachments: [
          bookLoad({ bookId: "极品全能高手", ...line, viewport: desktop, theme: defaultTheme }),
          bookLoad({ bookId: "从零开始", status: "uncollected", reason: "未捕获到本次打开的 [book-load] 行：超时" }),
        ],
      }),
      caseFacts({
        file: REAL_FILE,
        titlePath: ["11.1 确定态进度条"],
        project: "real",
        attachments: [
          bookLoad({ bookId: "a", ...line, viewport: desktop, theme: "default" }),
          bookLoad({ bookId: "b", ...line, viewport: { ...VIEWPORTS.mobile }, theme: defaultTheme }),
          bookLoad({ bookId: "c", ...line, viewport: desktop, theme: null }),
          bookLoad({ bookId: "d", ...line, viewport: null, theme: defaultTheme }),
        ],
      }),
      caseFacts({
        file: TRANSPARENT_FILE,
        titlePath: ["11.4 Transparent_Mode 下的进度"],
        project: "real-transparent",
        mode: "transparent",
        attachments: [bookLoad({ bookId: "e", ...line, source: "network-transparent", viewport: desktop, theme: defaultTheme })],
      }),
    ]);

    expect(r.bookLoadFilter).toEqual({ viewport: desktop, theme: defaultTheme, mode: "opaque" });
    const perfTest = `${PERF_SPEC_FILE} › ${PERF_DESCRIBE} › perf-toc`;
    expect(r.bookLoads).toEqual([
      { bookId: "极品全能高手", ...line, project: "real-perf", test: perfTest, viewport: desktop, theme: defaultTheme },
      {
        bookId: "从零开始",
        project: "real-perf",
        test: perfTest,
        status: "uncollected",
        reason: "未捕获到本次打开的 [book-load] 行：超时",
      },
    ]);
    expect(r.bookLoadsExcluded).toBe(5);
    expect(r.problems).toEqual([]);

    // 14.5：每次打开一行，书 id 与五个字段，预算列写"无预算"
    const lines = renderPerfSection(r);
    expect(rowOf(lines, "书 id")).toEqual(["书 id", "source", "gz", "chars", "decompress", "total", "Perf_Budget", "用例"]);
    expect(rowOf(lines, "极品全能高手")).toEqual([
      "极品全能高手", "network", "22.36MB", "60123456", "412ms", "2410ms", NO_BUDGET_TEXT, `${perfTest}（real-perf）`,
    ]);
    expect(rowOf(lines, "从零开始").slice(1, 7)).toEqual([
      "未采集：未捕获到本次打开的 [book-load] 行：超时", "—", "—", "—", "—", NO_BUDGET_TEXT,
    ]);
    expect(lines).toContain("另有 5 条 `[book-load]` 记录不满足上述条件，未列入。");
    expect(lines.some((l) => l.includes(`默认主题（未存储，实际 ${defaultTheme}）`))).toBe(true);
  });

  test("附件问题：无法解析或只有路径时记入附件问题，负责的项记未采集；附件内写明的未采集原因原样保留", () => {
    const timeout = "第 2 次：键入「系统提示音」后 10000 ms 内结果列表未出现该关键词的命中";
    const r = report([
      perfCase("perf-toc", {
        attachments: [{ name: PERF_METRICS_ATTACHMENT, path: path.join(REPO_ROOT, "e2e/.out/test-results/x/perf-metrics.json") }],
      }),
      perfCase("perf-shelf-search", { attachments: [{ name: PERF_METRICS_ATTACHMENT, body: "{not json" }] }),
      perfCase("perf-reader-search", {
        attachments: [metrics([{ key: "readerSearchLongTask", readings: [0, null, 0, 0, 0], reason: timeout }], false)],
      }),
    ]);

    expect(r.items.map((i) => [i.key, i.status, i.reason])).toEqual([
      ["tocOpen", "uncollected", "用例 perf-toc（通过）的 perf-metrics 附件无法读取或解析"],
      ["tocScrollLongTask", "uncollected", "用例 perf-toc（通过）的 perf-metrics 附件无法读取或解析"],
      ["shelfSearch", "uncollected", "用例 perf-shelf-search（通过）的 perf-metrics 附件无法读取或解析"],
      ["readerSearchLongTask", "uncollected", timeout],
    ]);
    expect(r.items[3].readings).toEqual([0, null, 0, 0, 0]);
    expect(r.env.headless).toBe(false);
    expect(r.problems).toHaveLength(2);
    expect(r.problems[0]).toContain("perf-metrics 附件没有正文，文件 e2e/.out/test-results/x/perf-metrics.json 未能读取");
    expect(r.problems[1]).toContain("perf-metrics 附件无法解析：不是有效的 JSON");

    const lines = renderPerfSection(r);
    expect(lines).toContain("- Chromium：151.0.7922.34；浏览器模式：headed");
    expect(rowOf(lines, PERF_ITEM_LABELS.readerSearchLongTask).slice(1, 6)).toEqual(["0", "未采集", "0", "0", "0"]);
    const problems = lines.slice(lines.indexOf("### 附件问题"));
    expect(problems).toHaveLength(2 + r.problems.length);
  });
});
