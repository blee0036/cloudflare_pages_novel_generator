/**
 * Run_Summary 判定的无浏览器测试（`tooling` 项目；设计"Run_Summary（需求 17、6.9）"与
 * Correctness Properties 属性 12）。
 *
 * 属性 12（用例归类与退出码，需求 1.7、17.1、17.5）：对任意用例行列表（`status` 取 Playwright 的
 * 5 种状态之一或没有结果，`expectedStatus` 取 `passed` 或 `failed`，项目取 4 个之一）、任意运行级
 * 失败列表（覆盖 `RunLevelFailure` 的全部 kind，含 `run-error`）与可空的中止信息：
 * - 每行恰好落入五类之一或"未执行"，且与设计"归类"一条逐项相同；`toCaseRow` 与直接调用
 *   `classify` 结果一致，`profileOf` 与设计"项目归属"一条相同；
 * - `aggregate` 按 fixture、tooling 各一行；每行的五类计数与"未执行"数等于按期望归类数出的值，
 *   五类计数之和加"未执行"数等于该 profile 的行数，两行合计等于总行数；计数与是否选中 fixture 无关；
 * - `exitCode`：中止于"浏览器检查"为 3，其余中止为 1；未中止时有运行级失败、失败或意外通过为 1，
 *   否则为 0。即 0 当且仅当没有失败、没有意外通过、运行级失败为空且未中止；
 * - 向行列表的任意位置插入任意个跳过、预期失败或"未执行"的行，退出码不变（"未执行"一项按设计
 *   "归类"一条"不进五类计数"与 `exitCode` 的文档）；
 * - 各函数不修改参数。
 *
 * 期望值不从被测实现推导：归类表、项目归属表与"浏览器检查"阶段名都按设计原文写在本文件里。
 * 超预算的 Perf_Metrics 与 A11y 违规不是运行级失败（1.7），`RunLevelFailure` 中没有对应的 kind；
 * `RUN_LEVEL_ARBS` 以 kind 为键的映射类型保证生成器覆盖全部 kind，新增 kind 时 typecheck 会报错。
 *
 * 属性内用 `node:assert` 而不是 Playwright 的 `expect`，理由同 `server-resolve.spec.ts`：
 * 每次 `expect` 都会在报告里记一个步骤。
 *
 * 文件后半是 `renderSummary` 的例子测试（任务 16.3；需求 17.1、17.4、17.7）：节序，以及"未运行"
 * "未生成""未收集"各一例。`RunFacts` 手写，产物与第 11 节按 reporter 的组装方式取得
 * （`missingArtifactReason`、`extraSectionNotRun`）；期望的节序、产物路径与原因文字按设计原文写在
 * 本文件里，断言只取标题、行标签与关键短语。
 *
 * Library_Profile 只有 fixture（test-data-desensitization：测试只用合成书库）：计数表只有 fixture
 * 与 tooling 两行，`perf` 项目归 fixture，第 10 节只有夹具核对。"未运行"一例因此以未选中 fixture
 * 的运行为输入，另以选中 fixture 的同一组用例对照计数。
 *
 * 文件末尾是 reader-defect-fixes 的属性 9（`numbered()` 的续行缩进，需求 16.2、16.4）及一个边界例子。
 * 标记宽度按"序号位数加点号与一个空格"写成独立的表，不取自实现。
 */
import { test, type TestStatus } from "@playwright/test";
import type { FullResult } from "@playwright/test/reporter";
import fc from "fast-check";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Violation } from "../../review/consistency";
import {
  ARTIFACT_KEYS,
  ARTIFACT_LABELS,
  ARTIFACT_PATHS,
  EXTRA_SECTION_KEYS,
  NONE_TEXT,
  PROFILE_LABELS,
  RUN_STAGES,
  SUMMARY_HEADINGS,
  SUMMARY_SECTION_ORDER,
  SUMMARY_TITLE,
  aggregate,
  buildRunSummary,
  classify,
  exitCode,
  extraSectionNotRun,
  isCollected,
  missingArtifactReason,
  numbered,
  profileOf,
  renderSummary,
  resolveAbort,
  toCaseRow,
  type AbortInfo,
  type ArtifactKey,
  type ArtifactRef,
  type CaseFacts,
  type CaseOutcome,
  type CaseRow,
  type ExtraSection,
  type ExtraSectionKey,
  type Outcome,
  type Profile,
  type RunContext,
  type RunFacts,
  type RunLevelFailure,
  type RunLevelFailureKind,
  type SummaryProfile,
  type SummarySection,
} from "../../support/summary";

/** 仓库根（本文件位于 `e2e/tests/tooling/`）。 */
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

// ---------------------------------------------------------------------------
// 期望值（按设计原文，独立于实现）
// ---------------------------------------------------------------------------

/** Playwright 的 5 种 `TestStatus`。 */
const STATUSES = ["passed", "failed", "timedOut", "skipped", "interrupted"] as const satisfies readonly TestStatus[];
type Status = (typeof STATUSES)[number];

/** 属性 12 的 `expectedStatus` 取值：普通用例与 `test.fail()`。 */
type Expected = "passed" | "failed";

/** 没有结果的用例（`CaseFacts.result` 为 null，`classify` 收到 null）。 */
const NO_RESULT = "none";
type StatusOrNone = Status | typeof NO_RESULT;

/**
 * 设计"归类"：`skipped` → 跳过；`expectedStatus` 为 `failed` 时 `failed` → 预期失败、`passed` →
 * 意外通过、其余（含 `timedOut`）→ 失败；为 `passed` 时 `passed` → 通过、其余 → 失败；
 * `interrupted` 与没有结果 → 未执行。
 */
const OUTCOME_TABLE: Readonly<Record<Expected, Readonly<Record<StatusOrNone, CaseOutcome>>>> = {
  passed: {
    passed: "passed",
    failed: "failed",
    timedOut: "failed",
    skipped: "skipped",
    interrupted: "notRun",
    none: "notRun",
  },
  failed: {
    passed: "unexpectedPass",
    failed: "expectedFail",
    timedOut: "failed",
    skipped: "skipped",
    interrupted: "notRun",
    none: "notRun",
  },
};

/** 五类结果与"未执行"。 */
const FIVE: readonly Outcome[] = ["passed", "failed", "unexpectedPass", "skipped", "expectedFail"];
const SIX: readonly CaseOutcome[] = [...FIVE, "notRun"];

/** 设计"项目归属"：4 个项目 → fixture / tooling（`perf` 以 Fixture_Library 运行，归 fixture）。 */
const PROJECT_TABLE = {
  fixture: "fixture",
  "fixture-transparent": "fixture",
  perf: "fixture",
  tooling: "tooling",
} as const satisfies Record<string, SummaryProfile>;
type Project = keyof typeof PROJECT_TABLE;
const PROJECTS = Object.keys(PROJECT_TABLE) as Project[];

/** 计数表的行序：Library_Profile（只有 fixture），再单列 tooling。 */
const PROFILE_ROWS: readonly SummaryProfile[] = ["fixture", "tooling"];

/** 设计"退出码"：中止于该阶段时写 3（由 `run.mjs` 返回）。 */
const BROWSER_CHECK = "浏览器检查";

interface RowSpec {
  project: Project;
  expected: Expected;
  status: Status | null;
}

function expectedOutcome(s: RowSpec): CaseOutcome {
  return OUTCOME_TABLE[s.expected][s.status ?? NO_RESULT];
}

function expectedExitCode(specs: readonly RowSpec[], runLevel: readonly RunLevelFailure[], abort: AbortInfo | null): 0 | 1 | 3 {
  if (abort !== null) return abort.stage === BROWSER_CHECK ? 3 : 1;
  if (runLevel.length > 0) return 1;
  const bad = specs.some((s) => {
    const o = expectedOutcome(s);
    return o === "failed" || o === "unexpectedPass";
  });
  return bad ? 1 : 0;
}

// ---------------------------------------------------------------------------
// 用例行
// ---------------------------------------------------------------------------

const T0 = Date.UTC(2025, 5, 1, 12, 0, 0);

/** 与 reporter 交给 `toCaseRow` 的形状相同：`test.fail()` 带 `fail` 注解，跳过带 `skip` 注解。 */
function factsOf(s: RowSpec, id: string, i: number): CaseFacts {
  const annotations: CaseFacts["annotations"][number][] = [];
  if (s.expected === "failed") annotations.push({ type: "fail", description: "F-001 已知缺陷" });
  if (s.status === "skipped") annotations.push({ type: "skip", description: "[8.13] 当前书库缺少相邻卷节点" });
  const failing = s.status === "failed" || s.status === "timedOut";
  return {
    id,
    file: path.join(REPO_ROOT, "e2e", "tests", s.project, `case-${i % 3}.spec.ts`),
    titlePath: ["分组", `用例 ${id}`],
    project: s.project,
    expectedStatus: s.expected,
    timeoutMs: 30_000,
    annotations,
    result:
      s.status === null
        ? null
        : {
            status: s.status,
            startMs: T0 + i * 1_000,
            durationMs: 250 + i,
            errors: failing ? ["Error: 断言失败\n    at 某处"] : [],
            attachments: [],
          },
  };
}

const projectArb = fc.constantFrom(...PROJECTS);
const expectedArb = fc.constantFrom<Expected>("passed", "failed");

/** 任意行：5 种状态或没有结果。 */
const anySpecArb: fc.Arbitrary<RowSpec> = fc.record({
  project: projectArb,
  expected: expectedArb,
  status: fc.oneof(
    { weight: 10, arbitrary: fc.constantFrom(...STATUSES) },
    { weight: 1, arbitrary: fc.constant(null) },
  ),
});

/** 不改变退出码的行：跳过、预期失败、未执行（`interrupted` 或没有结果）。 */
const neutralSpecArb: fc.Arbitrary<RowSpec> = fc.oneof(
  fc.record({ project: projectArb, expected: expectedArb, status: fc.constant<Status | null>("skipped") }),
  fc.record({
    project: projectArb,
    expected: fc.constant<Expected>("failed"),
    status: fc.constant<Status | null>("failed"),
  }),
  fc.record({
    project: projectArb,
    expected: expectedArb,
    status: fc.constantFrom<Status | null>("interrupted", null),
  }),
);

/** 不含失败与意外通过的行：通过，或上面的中性行。 */
const cleanSpecArb: fc.Arbitrary<RowSpec> = fc.oneof(
  fc.record({
    project: projectArb,
    expected: fc.constant<Expected>("passed"),
    status: fc.constant<Status | null>("passed"),
  }),
  neutralSpecArb,
);

/** 一半的输入只含"干净"的行，使退出码 0 的情形足够常见。 */
const specsArb = fc.oneof(
  fc.array(anySpecArb, { maxLength: 16 }),
  fc.array(cleanSpecArb, { maxLength: 16 }),
);

// ---------------------------------------------------------------------------
// 运行级失败与中止信息
// ---------------------------------------------------------------------------

const textArb = fc.oneof(
  fc.constantFrom("public/books/中文书.txt.gz 大小变化", "Error: globalTeardown 抛错", "", "多行\n原因"),
  fc.string({ maxLength: 12 }),
);

const violationArb: fc.Arbitrary<Violation> = fc.oneof(
  textArb.map((name) => ({ kind: "missing-name" as const, name })),
  textArb.map((file) => ({ kind: "orphan-png" as const, file })),
  fc.record({ name: textArb, count: fc.integer({ min: 2, max: 5 }) }).map(({ name, count }) => ({
    kind: "multiple-png" as const,
    name,
    count,
  })),
);

/** 以 kind 为键：`RunLevelFailure` 新增 kind 时这里缺键，typecheck 报错。 */
const RUN_LEVEL_ARBS: { readonly [K in RunLevelFailureKind]: fc.Arbitrary<Extract<RunLevelFailure, { kind: K }>> } = {
  "snapshot-diff": fc.integer({ min: 1, max: 5_000 }).map((total) => ({ kind: "snapshot-diff" as const, total })),
  "snapshot-missing": fc
    .record({ which: fc.constantFrom("start" as const, "end" as const), reason: textArb })
    .map(({ which, reason }) => ({ kind: "snapshot-missing" as const, which, reason })),
  "fixture-failed": fc
    .record({ reason: textArb, detail: fc.array(textArb, { maxLength: 3 }) })
    .map(({ reason, detail }) => ({ kind: "fixture-failed" as const, reason, detail })),
  "review-consistency": fc
    .array(violationArb, { minLength: 1, maxLength: 3 })
    .map((violations) => ({ kind: "review-consistency" as const, violations })),
  "run-error": fc
    .array(textArb, { minLength: 1, maxLength: 3 })
    .map((errors) => ({ kind: "run-error" as const, errors })),
};

const runLevelItemArb: fc.Arbitrary<RunLevelFailure> = fc.oneof(
  ...(Object.values(RUN_LEVEL_ARBS) as fc.Arbitrary<RunLevelFailure>[]),
);

const runLevelArb = fc.oneof(
  fc.constant<RunLevelFailure[]>([]),
  fc.array(runLevelItemArb, { minLength: 1, maxLength: 4 }),
);

/**
 * 中止阶段：浏览器检查；globalSetup 的其余阶段与 reporter 的"用例收集""用例执行"；与"浏览器检查"
 * 只差空白或截断的串（按设计是严格相等，应得 1）；任意串。
 */
const abortStageArb = fc.oneof(
  { weight: 3, arbitrary: fc.constant(BROWSER_CHECK) },
  {
    weight: 4,
    arbitrary: fc.constantFrom("夹具生成", "App_Build 构建", "产物校验", "端口占用", "服务器自检", "用例收集", "用例执行"),
  },
  { weight: 1, arbitrary: fc.constantFrom(` ${BROWSER_CHECK}`, `${BROWSER_CHECK} `, "浏览器", "") },
  { weight: 1, arbitrary: fc.string({ maxLength: 8 }) },
);

const abortArb: fc.Arbitrary<AbortInfo | null> = fc.oneof(
  { weight: 2, arbitrary: fc.constant(null) },
  {
    weight: 1,
    arbitrary: fc
      .record({
        stage: abortStageArb,
        reason: textArb,
        checks: fc.option(
          fc.array(
            fc.record({ name: textArb, path: fc.constantFrom("/", "/data/books.json"), expected: textArb, actual: textArb }),
            { minLength: 1, maxLength: 3 },
          ),
          { nil: undefined },
        ),
      })
      .map(({ stage, reason, checks }): AbortInfo => (checks === undefined ? { stage, reason } : { stage, reason, checks })),
  },
);

/** 选中 fixture，或什么都没选中（计数与选中与否无关）。 */
const selectedArb = fc.subarray<Profile>(["fixture"]);

/** 待插入的中性行及其插入位置（按插入时的长度取模）。 */
const insertionsArb = fc.array(fc.record({ spec: neutralSpecArb, at: fc.nat() }), { maxLength: 6 });

// ---------------------------------------------------------------------------
// 属性 12
// ---------------------------------------------------------------------------

function zeroCounts(): Record<CaseOutcome, number> {
  return { passed: 0, failed: 0, unexpectedPass: 0, skipped: 0, expectedFail: 0, notRun: 0 };
}

test.describe("用例归类、计数与退出码（需求 1.7、17.1、17.5）", () => {
  // Feature: e2e-visual-testing, Property 12: 用例归类与退出码
  // **Validates: Requirements 1.7, 17.1, 17.5**
  test("属性 12：每行恰好一类，各 profile 计数之和等于行数，退出码按定义，插入跳过、预期失败或未执行的行不改变退出码", () => {
    const seen = new Set<number>();
    fc.assert(
      fc.property(
        specsArb,
        runLevelArb,
        abortArb,
        selectedArb,
        insertionsArb,
        (specs, runLevel, abort, selected, insertions) => {
          const facts = specs.map((s, i) => factsOf(s, `case-${i}`, i));
          const factsBefore = structuredClone(facts);
          const rows: CaseRow[] = facts.map(toCaseRow);
          assert.deepEqual(facts, factsBefore, "toCaseRow 修改了参数");

          // 每行恰好落入五类之一或"未执行"，与归类表、项目归属表一致
          specs.forEach((s, i) => {
            const want = expectedOutcome(s);
            const label = `第 ${i} 行 ${JSON.stringify(s)}`;
            assert.ok(SIX.includes(rows[i].outcome), `${label}：outcome ${JSON.stringify(rows[i].outcome)} 不是六类之一`);
            assert.equal(rows[i].outcome, want, `${label}：toCaseRow 的归类`);
            assert.equal(classify(s.status, s.expected), want, `${label}：classify 的归类`);
            assert.equal(profileOf(s.project), PROJECT_TABLE[s.project], `${label}：profileOf`);
            assert.equal(rows[i].profile, PROJECT_TABLE[s.project], `${label}：toCaseRow 的 profile`);
          });

          // 每个 profile：计数等于按期望归类数出的值，五类之和加未执行等于该 profile 的行数
          const rowsBefore = structuredClone(rows);
          const runLevelBefore = structuredClone(runLevel);
          const abortBefore = structuredClone(abort);
          const stats = aggregate(rows, selected);
          assert.deepEqual(
            stats.map((st) => st.profile),
            PROFILE_ROWS,
            "aggregate 应按 fixture、tooling 各给一行",
          );
          let total = 0;
          for (const st of stats) {
            const own = specs.filter((s) => PROJECT_TABLE[s.project] === st.profile);
            const want = zeroCounts();
            for (const s of own) want[expectedOutcome(s)]++;
            const { notRun: wantNotRun, ...wantFive } = want;
            assert.deepEqual(st.counts, wantFive, `${st.profile} 的五类计数`);
            assert.equal(st.notRun, wantNotRun, `${st.profile} 的未执行数`);
            const sum = FIVE.reduce((acc, o) => acc + st.counts[o], 0);
            assert.equal(sum + st.notRun, own.length, `${st.profile}：五类计数之和加未执行数应等于行数`);
            total += sum + st.notRun;
          }
          assert.equal(total, rows.length, "两行合计应等于总行数");

          // 退出码
          const code = exitCode(rows, runLevel, abort);
          assert.equal(code, expectedExitCode(specs, runLevel, abort), "exitCode");
          const clean = !rows.some((r) => r.outcome === "failed" || r.outcome === "unexpectedPass");
          assert.equal(
            code === 0,
            clean && runLevel.length === 0 && abort === null,
            "退出码为 0 当且仅当没有失败、没有意外通过、运行级失败为空且未中止",
          );
          seen.add(code);

          assert.deepEqual(rows, rowsBefore, "aggregate / exitCode 修改了 rows");
          assert.deepEqual(runLevel, runLevelBefore, "exitCode 修改了 runLevel");
          assert.deepEqual(abort, abortBefore, "exitCode 修改了 abort");

          // 在任意位置插入跳过、预期失败或未执行的行，退出码不变
          const extended = [...rows];
          insertions.forEach(({ spec, at }, j) => {
            const row = toCaseRow(factsOf(spec, `extra-${j}`, specs.length + j));
            assert.ok(
              ["skipped", "expectedFail", "notRun"].includes(row.outcome),
              `插入行 ${JSON.stringify(spec)} 的归类应为跳过、预期失败或未执行，实际 ${row.outcome}`,
            );
            extended.splice(at % (extended.length + 1), 0, row);
          });
          assert.equal(exitCode(extended, runLevel, abort), code, "插入中性行后退出码应不变");
        },
      ),
      { numRuns: 100 },
    );
    // 生成器应覆盖三种退出码，否则上面的"当且仅当"可能只验证了一侧
    assert.deepEqual([...seen].sort(), [0, 1, 3], "100 次输入应覆盖退出码 0、1、3");
  });
});

// ---------------------------------------------------------------------------
// renderSummary 例子（任务 16.3；需求 17.1、17.4、17.7）
// ---------------------------------------------------------------------------

/**
 * 设计"Run_Summary"一节的节序 1–12（第 11 节为视觉回归、Perf_Metrics、A11y_Scan 三个分节），
 * 以及设计中该节名称里的关键词。第 1 节设计称"头部"，不核对标题文字。
 */
const DESIGN_SECTIONS: readonly { section: SummarySection; no: number; keyword: string | null }[] = [
  { section: "overview", no: 1, keyword: null },
  { section: "counts", no: 2, keyword: "计数" },
  { section: "runLevel", no: 3, keyword: "运行级失败" },
  { section: "failures", no: 4, keyword: "失败用例" },
  { section: "timeouts", no: 5, keyword: "超时用例" },
  { section: "skipped", no: 6, keyword: "跳过用例" },
  { section: "expectedFail", no: 7, keyword: "预期失败与意外通过" },
  { section: "artifacts", no: 8, keyword: "产物路径" },
  { section: "snapshot", no: 9, keyword: "public/ 快照" },
  { section: "checks", no: 10, keyword: "夹具核对" },
  { section: "visual", no: 11, keyword: "视觉回归" },
  { section: "perf", no: 11, keyword: "Perf_Metrics" },
  { section: "a11y", no: 11, keyword: "A11y_Scan" },
  { section: "consistency", no: 12, keyword: "Review_Report 一致性违规" },
];

/** 设计第 8 节：四项产物相对仓库根的路径（17.4）。 */
const DESIGN_ARTIFACT_PATHS: Readonly<Record<ArtifactKey, string>> = {
  htmlReport: "e2e/.out/report/index.html",
  reviewReport: "e2e/.out/review/review-report.md",
  perf: "e2e/.out/perf.json",
  a11y: "e2e/.out/a11y/",
};

/** 17.1 的五类，按计数表的列名。 */
const FIVE_LABELS = ["通过", "失败", "意外通过", "跳过", "预期失败"] as const;

const H = SUMMARY_HEADINGS;

interface ExampleCase {
  project: Project;
  /** 相对仓库根、以 `/` 分隔。 */
  file: string;
  title: string;
  status: Status | null;
  /** 默认 `passed`；`failed` 表示 `test.fail()`。 */
  expected?: Expected;
  /** `fail` 注解的 description。 */
  fail?: string;
  /** `skip` 注解的 description。 */
  skip?: string;
  /** 相对 T0 的开始时刻（毫秒）。 */
  at: number;
  ms: number;
}

function exampleCaseFacts(c: ExampleCase, i: number): CaseFacts {
  const annotations: CaseFacts["annotations"][number][] = [];
  if (c.fail !== undefined) annotations.push({ type: "fail", description: c.fail });
  if (c.skip !== undefined) annotations.push({ type: "skip", description: c.skip });
  return {
    id: `example-${i}`,
    file: path.join(REPO_ROOT, ...c.file.split("/")),
    titlePath: [c.title],
    project: c.project,
    expectedStatus: c.expected ?? "passed",
    timeoutMs: 30_000,
    annotations,
    result:
      c.status === null
        ? null
        : { status: c.status, startMs: T0 + c.at, durationMs: c.ms, errors: [], attachments: [] },
  };
}

interface ExampleRun {
  selected: Profile[];
  cases?: readonly ExampleCase[];
  /** `onEnd` 的 `result.status`，默认 `passed`。 */
  status?: FullResult["status"];
  /** `onBegin` 时的用例数，默认等于用例数。 */
  onBeginTests?: number;
  errors?: string[];
  setupAbort?: AbortInfo;
  /** 本次写出的产物；其余按 `missingArtifactReason` 记未生成。 */
  present: readonly ArtifactKey[];
  /** 第 11 节未被 `extraSectionNotRun` 判"未运行"时的内容；未给出的写一行占位正文。 */
  provided?: Partial<Record<ExtraSectionKey, ExtraSection>>;
}

/** 与 reporter 的组装方式相同：先判收集与中止，再按 `RunContext` 定产物与第 11 节。 */
function exampleRunFacts(r: ExampleRun): RunFacts {
  const cases = (r.cases ?? []).map(exampleCaseFacts);
  const errors = r.errors ?? [];
  const setupAbort = r.setupAbort ?? null;
  const status = r.status ?? "passed";
  const onBeginTests = r.onBeginTests ?? cases.length;
  const collected = isCollected({ setupAborted: setupAbort !== null, onBeginTests, errorCount: errors.length });
  const ctx: RunContext = {
    selected: r.selected,
    abort: resolveAbort({ setupAbort, collected, status, errors }),
    collected,
  };
  const artifacts = {} as Record<ArtifactKey, ArtifactRef>;
  for (const key of ARTIFACT_KEYS) {
    artifacts[key] = r.present.includes(key) ? { path: ARTIFACT_PATHS[key] } : { missing: missingArtifactReason(key, ctx) };
  }
  const sections = {} as Record<ExtraSectionKey, ExtraSection>;
  for (const key of EXTRA_SECTION_KEYS) {
    sections[key] = extraSectionNotRun(key, ctx) ?? r.provided?.[key] ?? { status: "ready", lines: [`- ${key} 例子正文`] };
  }
  return {
    startTime: new Date(T0),
    durationMs: 83_450,
    status,
    selected: r.selected,
    onBeginTests,
    errors,
    setupAbort,
    cases,
    snapshot: {
      start: { ok: true, count: 15_234, ms: 412 },
      end: { ok: true, count: 15_234, ms: 398 },
      diff: { total: 0, entries: [] },
    },
    fixtureFailed: null,
    reviewViolations: [],
    artifacts,
    sections,
    utcOffsetMinutes: 480,
  };
}

function summaryOf(r: ExampleRun): string {
  return renderSummary(buildRunSummary(exampleRunFacts(r)));
}

/** 一、二级标题行（三级标题属于所在的节）。 */
function headingsOf(md: string): string[] {
  return md.split("\n").filter((line) => /^#{1,2} /.test(line));
}

/** `heading` 一节的正文行：到下一个二级标题为止，去掉首尾空行。 */
function sectionBody(md: string, heading: string): string[] {
  const lines = md.split("\n");
  const at = lines.indexOf(heading);
  assert.ok(at >= 0, `summary 中没有 ${heading}：\n${md}`);
  const next = lines.findIndex((line, i) => i > at && line.startsWith("## "));
  const body = lines.slice(at + 1, next === -1 ? undefined : next);
  while (body.length > 0 && body[0] === "") body.shift();
  while (body.length > 0 && body[body.length - 1] === "") body.pop();
  return body;
}

function splitRow(line: string): string[] {
  assert.ok(line.startsWith("|") && line.endsWith("|"), `不是表格行：${line}`);
  return line
    .slice(1, -1)
    .split(/(?<!\\)\|/)
    .map((c) => c.trim());
}

/** 首列表头为 `firstHeader` 的表格：每个数据行按表头取值。 */
function tableOf(lines: readonly string[], firstHeader: string): Record<string, string>[] {
  const at = lines.findIndex((line) => line.startsWith("|") && splitRow(line)[0] === firstHeader);
  assert.ok(at >= 0, `没有首列为 ${firstHeader} 的表格：\n${lines.join("\n")}`);
  const header = splitRow(lines[at]);
  const rows: Record<string, string>[] = [];
  for (let i = at + 2; i < lines.length && lines[i].startsWith("|"); i++) {
    const cells = splitRow(lines[i]);
    assert.equal(cells.length, header.length, `列数与表头不符：${lines[i]}`);
    rows.push(Object.fromEntries(header.map((h, j) => [h, cells[j]])));
  }
  return rows;
}

/** 计数表：按 Library_Profile 列取行。 */
function countsTable(md: string): Map<string, Record<string, string>> {
  const rows = tableOf(sectionBody(md, H.counts), "Library_Profile");
  return new Map(rows.map((row) => [row["Library_Profile"], row]));
}

/** 某行除 Library_Profile 外的单元格。 */
function countCells(row: Record<string, string> | undefined): string[] {
  assert.ok(row, "计数表中缺少该行");
  return Object.entries(row)
    .filter(([h]) => h !== "Library_Profile")
    .map(([, v]) => v);
}

/** 计数表中该行写作 `word`：首个数据列为 `word`，其余列没有任何数字。 */
function assertBlankRow(md: string, label: string, word: string): void {
  const cells = countCells(countsTable(md).get(label));
  assert.equal(cells[0], word, `计数表 ${label} 一行应写"${word}"：${JSON.stringify(cells)}`);
  assert.ok(
    cells.every((c) => !/\d/.test(c)),
    `计数表 ${label} 一行写"${word}"时不应有计数或耗时：${JSON.stringify(cells)}`,
  );
}

/** 第 8 节中某项产物的一行。 */
function artifactLine(md: string, key: ArtifactKey): string {
  const prefix = `- ${ARTIFACT_LABELS[key]}：`;
  const lines = sectionBody(md, H.artifacts).filter((line) => line.startsWith(prefix));
  assert.equal(lines.length, 1, `产物路径一节应恰有 1 行 ${prefix}`);
  return lines[0];
}

/** 第 10 节中 `### <profile>…` 分节的首行正文。 */
function checkFirstLine(md: string, profile: Profile): string {
  const body = sectionBody(md, H.checks);
  const at = body.findIndex((line) => line.startsWith(`### ${profile}`));
  assert.ok(at >= 0, `夹具核对一节缺少 ${profile} 分节：\n${body.join("\n")}`);
  const first = body.slice(at + 1).find((line) => line !== "");
  assert.ok(first !== undefined, `${profile} 分节没有正文`);
  return first;
}

/** 中止于 globalSetup "服务器自检"阶段（5.11 的检查项表）。 */
const SELFCHECK_ABORT: AbortInfo = {
  stage: "服务器自检",
  reason: "fixture 透明实例自检 2 项未通过",
  checks: [
    { name: "首页", path: "/", expected: "200 text/html", actual: "404" },
    { name: "gz 响应头", path: "/books/中文书.txt.gz", expected: "Content-Encoding: gzip", actual: "无 Content-Encoding" },
  ],
};

/** globalSetup 重抛后 Playwright 经 `onError` 报告的错误（R4：此后 `onBegin` 以 0 个用例被调用）。 */
const SETUP_ERROR = "Error: 服务器自检失败\n    at globalSetup (e2e/support/global-setup.ts:1:1)";

test.describe("renderSummary 例子（需求 17.1、17.4、17.7）", () => {
  test("节序：标题之后依次为设计 1–12 节（第 11 节三个分节），正常结束与中止的运行相同", () => {
    assert.deepEqual(
      SUMMARY_SECTION_ORDER.map(({ section, no }) => ({ section, no })),
      DESIGN_SECTIONS.map(({ section, no }) => ({ section, no })),
      "SUMMARY_SECTION_ORDER 应与设计节序一致",
    );
    for (const s of DESIGN_SECTIONS) {
      if (s.keyword !== null) assert.ok(H[s.section].includes(s.keyword), `第 ${s.no} 节标题 ${H[s.section]} 应含"${s.keyword}"`);
    }
    const expected = [SUMMARY_TITLE, ...DESIGN_SECTIONS.map((s) => H[s.section])];

    const runs: Record<string, ExampleRun> = {
      // 各节都有条目：失败、超时、意外通过、跳过、预期失败，使节内的三级标题与编号条目都出现
      正常结束: {
        selected: ["fixture"],
        status: "failed",
        cases: [
          { project: "fixture", file: "e2e/tests/fixture/shelf-skeleton.spec.ts", title: "书架骨架", status: "passed", at: 0, ms: 900 },
          { project: "fixture", file: "e2e/tests/fixture/shelf-recent.spec.ts", title: "最近阅读", status: "failed", at: 100, ms: 1_200 },
          { project: "fixture", file: "e2e/tests/fixture/reader-theme.spec.ts", title: "主题", status: "timedOut", at: 200, ms: 30_000 },
          {
            project: "fixture",
            file: "e2e/tests/fixture/reader-typography.spec.ts",
            title: "行高滑杆",
            status: "skipped",
            skip: "[16.4 F-002] 行高滑杆定位不到",
            at: 300,
            ms: 5,
          },
          {
            project: "fixture",
            file: "e2e/tests/fixture/load-error.spec.ts",
            title: "F-001 加载失败",
            status: "failed",
            expected: "failed",
            fail: "F-001",
            at: 400,
            ms: 800,
          },
          {
            project: "fixture-transparent",
            file: "e2e/tests/fixture-transparent/load-progress-transparent.spec.ts",
            title: "F-003 进度条",
            status: "passed",
            expected: "failed",
            fail: "F-003",
            at: 500,
            ms: 700,
          },
          { project: "perf", file: "e2e/tests/perf/perf.spec.ts", title: "perf-toc", status: "passed", at: 600, ms: 1_500 },
          { project: "tooling", file: "e2e/tests/tooling/snapshot-diff.spec.ts", title: "快照差异", status: "passed", at: 0, ms: 50 },
        ],
        present: ARTIFACT_KEYS,
      },
      中止: {
        selected: ["fixture"],
        status: "failed",
        onBeginTests: 0,
        errors: [SETUP_ERROR],
        setupAbort: SELFCHECK_ABORT,
        present: ["htmlReport", "reviewReport"],
      },
    };
    for (const [name, run] of Object.entries(runs)) {
      const md = summaryOf(run);
      assert.equal(md.split("\n")[0], SUMMARY_TITLE, `${name}：首行应为 Run_Summary 标题`);
      assert.deepEqual(headingsOf(md), expected, `${name}：一、二级标题应按设计节序各出现一次`);
    }
  });

  test("未运行：未选中 fixture 时 fixture 一行写未运行，Perf_Metrics 标未生成（fixture 未运行），各节注明 fixture 未运行", () => {
    const toolingCase: ExampleCase = {
      project: "tooling",
      file: "e2e/tests/tooling/snapshot-diff.spec.ts",
      title: "快照差异",
      status: "passed",
      at: 200,
      ms: 300,
    };

    // 对照：选中 fixture 的运行。头部、计数表的列，以及 fixture 一行合计它的三个项目
    const ran = summaryOf({
      selected: ["fixture"],
      cases: [
        { project: "fixture", file: "e2e/tests/fixture/shelf-skeleton.spec.ts", title: "书架骨架", status: "passed", at: 1_000, ms: 2_000 },
        {
          project: "fixture-transparent",
          file: "e2e/tests/fixture-transparent/cache-transparent.spec.ts",
          title: "透明解压",
          status: "passed",
          at: 1_500,
          ms: 4_000,
        },
        {
          project: "fixture",
          file: "e2e/tests/fixture/reader-typography.spec.ts",
          title: "行高滑杆",
          status: "skipped",
          skip: "[16.4 F-002] 行高滑杆定位不到",
          at: 3_000,
          ms: 5,
        },
        {
          project: "fixture",
          file: "e2e/tests/fixture/load-error.spec.ts",
          title: "F-001 坏记录",
          status: "failed",
          expected: "failed",
          fail: "F-001",
          at: 3_200,
          ms: 1_800,
        },
        { project: "perf", file: "e2e/tests/perf/perf.spec.ts", title: "perf-toc", status: "passed", at: 5_000, ms: 1_500 },
        toolingCase,
      ],
      present: ["htmlReport", "reviewReport", "a11y"],
    });

    // 头部：本地时间带 UTC 偏移、总耗时、退出码与本次的 Library_Profile（17.1）
    const overview = sectionBody(ran, H.overview);
    for (const line of [
      "- 开始时间：2025-06-01T20:00:00.000+08:00",
      "- 结束时间：2025-06-01T20:01:23.450+08:00",
      "- 总耗时：83.5 s",
      "- 退出码：0",
      "- 本次运行的 Library_Profile：fixture",
    ]) {
      assert.ok(overview.includes(line), `概况应含 ${line}：\n${overview.join("\n")}`);
    }

    // 计数表：五类列与耗时列；fixture 合计 fixture、fixture-transparent、perf 三个项目，tooling 单列
    const table = countsTable(ran);
    assert.deepEqual([...table.keys()], ["fixture", PROFILE_LABELS.tooling], "计数表的行");
    const header = Object.keys(table.get("fixture") ?? {});
    for (const label of FIVE_LABELS) assert.ok(header.includes(label), `计数表缺少"${label}"列：${JSON.stringify(header)}`);
    const timeColumn = header.find((h) => h.startsWith("耗时"));
    assert.ok(timeColumn !== undefined, `计数表缺少耗时列：${JSON.stringify(header)}`);
    const fixture = table.get("fixture") ?? {};
    assert.deepEqual(
      [...FIVE_LABELS.map((l) => fixture[l]), fixture[timeColumn]],
      ["3", "0", "0", "1", "1", "5.5"],
      "fixture 一行：三个项目的五类计数与墙钟耗时（1.0 s 到 6.5 s）",
    );
    const tooling = table.get(PROFILE_LABELS.tooling) ?? {};
    assert.deepEqual([...FIVE_LABELS.map((l) => tooling[l]), tooling[timeColumn]], ["1", "0", "0", "0", "0", "0.3"], "tooling 一行");
    assert.equal(artifactLine(ran, "a11y"), `- ${ARTIFACT_LABELS.a11y}：\`${DESIGN_ARTIFACT_PATHS.a11y}\``);
    assert.equal(checkFirstLine(ran, "fixture"), "- Fixture_Library 可用", "fixture 核对分节");

    // 未选中 fixture：只有 tooling 的用例
    const md = summaryOf({ selected: [], cases: [toolingCase], present: ["htmlReport", "reviewReport"] });
    const notRunOverview = sectionBody(md, H.overview);
    for (const line of ["- 退出码：0", "- 本次运行的 Library_Profile：无"]) {
      assert.ok(notRunOverview.includes(line), `未选中 fixture：概况应含 ${line}：\n${notRunOverview.join("\n")}`);
    }
    assert.deepEqual([...countsTable(md).keys()], ["fixture", PROFILE_LABELS.tooling], "未选中 fixture：计数表的行");
    assertBlankRow(md, "fixture", "未运行");
    const toolingOnly = countsTable(md).get(PROFILE_LABELS.tooling) ?? {};
    assert.deepEqual(
      [...FIVE_LABELS.map((l) => toolingOnly[l]), toolingOnly[timeColumn]],
      ["1", "0", "0", "0", "0", "0.3"],
      "未选中 fixture：tooling 一行照常计数",
    );

    // 依赖 fixture 的产物与各节：fixture 未运行；每次运行都有的两项照常给出路径
    assert.equal(artifactLine(md, "perf"), `- ${ARTIFACT_LABELS.perf}：未生成（fixture 未运行）`);
    assert.equal(artifactLine(md, "a11y"), `- ${ARTIFACT_LABELS.a11y}：未生成（fixture 未运行）`);
    assert.equal(artifactLine(md, "htmlReport"), `- ${ARTIFACT_LABELS.htmlReport}：\`${DESIGN_ARTIFACT_PATHS.htmlReport}\``);
    for (const key of EXTRA_SECTION_KEYS) {
      assert.deepEqual(sectionBody(md, H[key]), ["未运行（fixture 未运行）"], `${H[key]} 一节`);
    }
    assert.equal(checkFirstLine(md, "fixture"), "- 未运行", "未选中 fixture：fixture 核对分节");
  });

  test("未生成：fixture 已选中但 Perf_Metrics 的用例全部跳过时标未生成（对应用例未执行），其余三项给出相对仓库根的路径", () => {
    const perfSkip = "示例跳过原因：perf 用例的前提不成立";
    const md = summaryOf({
      selected: ["fixture"],
      cases: [
        { project: "fixture", file: "e2e/tests/fixture/shelf-skeleton.spec.ts", title: "书架骨架", status: "passed", at: 0, ms: 900 },
        ...["perf-toc", "perf-shelf-search", "perf-reader-search"].map(
          (title, i): ExampleCase => ({
            project: "perf",
            file: "e2e/tests/perf/perf.spec.ts",
            title,
            status: "skipped",
            skip: perfSkip,
            at: i,
            ms: 1,
          }),
        ),
        { project: "tooling", file: "e2e/tests/tooling/snapshot-diff.spec.ts", title: "快照差异", status: "passed", at: 0, ms: 50 },
      ],
      present: ["htmlReport", "reviewReport", "a11y"],
      provided: { perf: { status: "notGenerated", reason: "对应用例未执行" } },
    });

    assert.deepEqual(
      sectionBody(md, H.artifacts),
      [
        `- ${ARTIFACT_LABELS.htmlReport}：\`${DESIGN_ARTIFACT_PATHS.htmlReport}\``,
        `- ${ARTIFACT_LABELS.reviewReport}：\`${DESIGN_ARTIFACT_PATHS.reviewReport}\``,
        `- ${ARTIFACT_LABELS.perf}：未生成（对应用例未执行）`,
        `- ${ARTIFACT_LABELS.a11y}：\`${DESIGN_ARTIFACT_PATHS.a11y}\``,
      ],
      "产物路径一节：HTML 报告、Review_Report、Perf_Metrics、A11y_Scan 各一行",
    );
    assert.deepEqual(sectionBody(md, H.perf), ["未生成（对应用例未执行）"], "Perf_Metrics 一节");

    // fixture 已运行：计数表给出计数（perf 项目的 3 个跳过计入 fixture），不写未运行；跳过不改变退出码
    const fixture = countsTable(md).get("fixture") ?? {};
    assert.equal(fixture["通过"], "1", `fixture 一行的通过数：${JSON.stringify(fixture)}`);
    assert.equal(fixture["跳过"], "3", `fixture 一行的跳过数（perf 项目的 3 个用例）：${JSON.stringify(fixture)}`);
    assert.ok(!countCells(fixture).includes("未运行"), "fixture 已选中，不应写未运行");
    assert.ok(sectionBody(md, H.overview).includes("- 退出码：0"), "只有跳过时退出码为 0");
  });

  test("未收集：中止于用例收集之前时写中止阶段、原因、检查项表与未收集，未生成的产物注明中止阶段", () => {
    // globalSetup 中止于"服务器自检"：abort.json 带 5.11 的检查项
    const md = summaryOf({
      selected: ["fixture"],
      status: "failed",
      onBeginTests: 0,
      errors: [SETUP_ERROR],
      setupAbort: SELFCHECK_ABORT,
      present: ["htmlReport", "reviewReport"],
    });
    const overview = sectionBody(md, H.overview);
    for (const line of [
      "- 退出码：1",
      "- 中止阶段：服务器自检",
      `- 中止原因：${SELFCHECK_ABORT.reason}`,
      "- 中止前已执行的用例：未收集",
    ]) {
      assert.ok(overview.includes(line), `概况应含 ${line}：\n${overview.join("\n")}`);
    }
    assert.deepEqual(
      tableOf(overview, "检查项"),
      (SELFCHECK_ABORT.checks ?? []).map((c) => ({ 检查项: c.name, 路径: c.path ?? "", 期望: c.expected, 实际: c.actual })),
      "概况中的检查项表（5.11：名称、请求路径、期望值与实际值）",
    );
    assertBlankRow(md, "fixture", "未收集");
    assertBlankRow(md, PROFILE_LABELS.tooling, "未收集");
    // globalSetup 的重抛已由中止信息吸收，不再记为运行级失败
    assert.deepEqual(sectionBody(md, H.runLevel), ["无"], "运行级失败一节");
    const aborted = `未生成（运行中止于"服务器自检"阶段）`;
    assert.equal(artifactLine(md, "perf"), `- ${ARTIFACT_LABELS.perf}：${aborted}`);
    assert.equal(artifactLine(md, "a11y"), `- ${ARTIFACT_LABELS.a11y}：${aborted}`);
    assert.equal(artifactLine(md, "htmlReport"), `- ${ARTIFACT_LABELS.htmlReport}：\`${DESIGN_ARTIFACT_PATHS.htmlReport}\``);
    for (const key of EXTRA_SECTION_KEYS) {
      assert.deepEqual(sectionBody(md, H[key]), [`未运行（运行中止于"服务器自检"阶段）`], `${H[key]} 一节`);
    }

    // 中止于"浏览器检查"：退出码 3，没有检查项表，夹具未生成
    const chromium = summaryOf({
      selected: ["fixture"],
      status: "failed",
      onBeginTests: 0,
      errors: ["Error: 未找到 Chromium"],
      setupAbort: { stage: BROWSER_CHECK, reason: "未找到 Chromium，请先运行 npm run e2e:install" },
      present: ["htmlReport", "reviewReport"],
    });
    const chromiumOverview = sectionBody(chromium, H.overview);
    for (const line of ["- 退出码：3", `- 中止阶段：${BROWSER_CHECK}`, "- 中止前已执行的用例：未收集"]) {
      assert.ok(chromiumOverview.includes(line), `浏览器检查中止：概况应含 ${line}：\n${chromiumOverview.join("\n")}`);
    }
    assert.ok(!chromiumOverview.some((line) => line.startsWith("| 检查项")), "没有检查项时不写检查项表");
    assertBlankRow(chromium, "fixture", "未收集");
    assert.equal(checkFirstLine(chromium, "fixture"), `- 未执行（运行中止于"${BROWSER_CHECK}"阶段）`);

    // 用例文件加载失败：没有 abort.json，onBegin 为 0 个用例且有 onError → 中止于"用例收集"，原因取首行
    const loadError = "Error: Cannot find module './missing'\n    at Object.<anonymous> (e2e/tests/fixture/broken.spec.ts:1:1)";
    const collect = summaryOf({
      selected: ["fixture"],
      status: "failed",
      onBeginTests: 0,
      errors: [loadError, "Error: No tests found"],
      present: ["htmlReport", "reviewReport"],
    });
    const collectOverview = sectionBody(collect, H.overview);
    for (const line of [
      "- 退出码：1",
      `- 中止阶段：${RUN_STAGES.collect}`,
      "- 中止原因：Error: Cannot find module './missing'；Error: No tests found",
      "- 中止前已执行的用例：未收集",
    ]) {
      assert.ok(collectOverview.includes(line), `用例收集中止：概况应含 ${line}：\n${collectOverview.join("\n")}`);
    }
    assertBlankRow(collect, "fixture", "未收集");
    assert.deepEqual(sectionBody(collect, H.runLevel), ["无"], "收集失败的 onError 已由中止信息吸收");
    assert.equal(artifactLine(collect, "a11y"), `- ${ARTIFACT_LABELS.a11y}：未生成（运行中止于"${RUN_STAGES.collect}"阶段）`);
  });
});

// ---------------------------------------------------------------------------
// numbered() 的续行缩进（reader-defect-fixes 属性 9；需求 16.2、16.4）
// ---------------------------------------------------------------------------

/**
 * 第 i 项列表标记 `${i}. ` 的宽度：序号位数加点号与一个空格。1–9 为 3，10–99 为 4，100–200 为 5
 * （需求 16.2 的 n ≤ 200）。
 */
function markerWidth(i: number): number {
  assert.ok(Number.isInteger(i) && i >= 1 && i <= 200, `序号 ${i} 超出 1–200`);
  return i < 10 ? 3 : i < 100 ? 4 : 5;
}

/** 去掉 CommonMark 的行结束符（LF、CR），得到"不含换行的任意字符串"。 */
function withoutLineBreaks(s: string): string {
  return s.replace(/[\r\n]/g, "");
}

/**
 * 不含换行的一行：可打印 ASCII、任意 Unicode 码点，以及本身以空白、列表标记或缩进代码形式开头的行
 * （这些行的前导空白应原样保留在标记宽度的空格之后）。
 */
const listLineArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 3, arbitrary: fc.string({ maxLength: 16 }) },
  { weight: 2, arbitrary: fc.string({ unit: "binary", maxLength: 8 }).map(withoutLineBreaks) },
  {
    weight: 1,
    arbitrary: fc.constantFrom("", " ", "  前导两格", "    四格缩进", "\t制表符开头", "- 子项", "10. 像标记的续行", "trace：`e2e/.out/x.zip`"),
  },
);

/** 一个条目：首行与 0–4 个续行。 */
const listItemArb: fc.Arbitrary<readonly [string, string[]]> = fc.tuple(listLineArb, fc.array(listLineArb, { maxLength: 4 }));

/** 条目数 1–200：一位、两位、三位序号各占三分之一，使 10 项与 100 项起的标记宽度都常被覆盖。 */
const listCountArb = fc.oneof(
  fc.integer({ min: 1, max: 9 }),
  fc.integer({ min: 10, max: 99 }),
  fc.integer({ min: 100, max: 200 }),
);

const listItemsArb = listCountArb.chain((n) => fc.array(listItemArb, { minLength: n, maxLength: n }));

test.describe("编号列表（需求 16.2）", () => {
  // Feature: reader-defect-fixes, Property 9: 编号列表的续行缩进等于列表标记宽度
  // **Validates: Requirements 16.2, 16.4**
  test("RDF 16.2 属性 9：第 i 项首行为 `${i}. 首行`，每个续行恰为标记宽度的空格加原文，行数等于首行与续行之和", () => {
    const widths = new Set<number>();
    fc.assert(
      fc.property(listItemsArb, (pairs) => {
        const items = pairs.map(([head, rest]) => [head, ...rest]);
        const before = structuredClone(items);
        const out = numbered(items);
        assert.deepEqual(items, before, "numbered 修改了参数");

        const total = items.reduce((acc, item) => acc + item.length, 0);
        assert.equal(out.length, total, "输出行数应等于全部首行与续行之和");

        let k = 0;
        items.forEach(([head, ...rest], j) => {
          const i = j + 1;
          const width = markerWidth(i);
          widths.add(width);
          const marker = `${i}. `;
          assert.equal(marker.length, width, `第 ${i} 项的标记宽度`);
          assert.equal(out[k], `${marker}${head}`, `第 ${i} 项的首行（输出第 ${k} 行）`);
          k++;
          rest.forEach((line, c) => {
            const label = `第 ${i} 项第 ${c + 1} 个续行（输出第 ${k} 行）`;
            assert.equal(out[k], " ".repeat(width) + line, `${label}：应为 ${width} 个空格加原文 ${JSON.stringify(line)}`);
            // 原文不以空格开头时，前导空格恰为标记宽度：续行属于该项，且不构成相对该项的缩进代码块
            if (!line.startsWith(" ")) {
              assert.equal(/^ */.exec(out[k])?.[0].length, width, `${label}：前导空格数`);
            }
            k++;
          });
        });
      }),
      { numRuns: 100 },
    );
    assert.deepEqual([...widths].sort(), [3, 4, 5], "100 次输入应覆盖一位、两位、三位序号的标记宽度");
  });

  test("RDF 16.2 例子：没有条目时为「无」；第 9 项的续行缩进 3 格，第 10 项起 4 格", () => {
    assert.deepEqual(numbered([]), [NONE_TEXT]);
    assert.equal(NONE_TEXT, "无");
    const items = Array.from({ length: 10 }, (_, j) => [`第 ${j + 1} 项`, "续行"]);
    const out = numbered(items);
    assert.equal(out.length, 20);
    assert.deepEqual(out.slice(16), ["9. 第 9 项", "   续行", "10. 第 10 项", "    续行"]);
  });
});
