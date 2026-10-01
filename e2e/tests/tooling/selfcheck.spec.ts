/**
 * 服务器自检的结果核对（任务 7.6；需求 5.10、5.11；设计 Acceptance_Run 阶段 3）。
 *
 * globalSetup 第 6 步对每个已启动的 E2E_Server 实例执行 `runSelfcheck`，把逐项结果写进
 * `e2e/.out/selfcheck.json`；任一项失败时 globalSetup 已中止，本用例不会运行。本用例是这一步在
 * 用例层面的证据：阶段 3 以 `npm run e2e -- -g @selfcheck` 运行，退出码 0 即表示 globalSetup
 * 完整走到了自检，且文件中每个实例的每项检查都通过。
 *
 * 断言：
 * 1. 文件存在且格式合法，没有 `error`，`profiles` 与本次运行选中的 Library_Profile 相同。
 * 2. 选中的每个 Library_Profile × 模式恰好出现一次：在 `results` 里（已自检），或在 `skipped`
 *    里（书库在本次运行中不可用而未启动，3.9 / 4.3）；没有多出来的实例。
 * 3. 每个已自检的实例：自检用书的 id 含中文字符，5.10 列出的 5 项请求都发出过。
 * 4. 每个已自检实例的每项检查都通过；失败时逐项列出实例、检查项、请求路径、期望值与实际值
 *    （5.11 的字段）。`ok` 字段须与逐项结果一致。
 *
 * 未启动的实例不是自检失败：每个以一条 `selfcheck-skipped` 注解列出（HTML 报告可见）。一个实例
 * 也没有启动时没有可核对的内容，本用例以这些实例的跳过原因（`[3.9]` / `[4.3]` 前缀）跳过。
 *
 * 标题带 `@selfcheck`，它不是按需标签（不在 `playwright.config.ts` 的 `ON_DEMAND_TAGS` 中），
 * 所以随每次含 fixture 的运行在 `tooling` 项目中执行：globalSetup 每次都写 `selfcheck.json`，
 * 核对它不需要任何额外准备。profile 只有 real 时 `tooling` 不提供非按需用例，本用例不运行。
 */
import { expect, test } from "@playwright/test";
import {
  SELFCHECK_FILE,
  readSelfcheckReport,
  selfcheckFailures,
  type SelfcheckReport,
  type SelfcheckResult,
} from "../../server/selfcheck";
import type { Mode } from "../../server/resolve";
import { serverOrigin } from "../../support/fixtures";
import { repoRelative, selectedProfiles } from "../../support/library";
import { step } from "../../support/step";

const MODES: readonly Mode[] = ["opaque", "transparent"];

/** 5.10：自检用书的 id 须含中文字符。 */
const HAN = /\p{Script=Han}/u;

/** 未启动实例的注解类型。 */
const SKIPPED_ANNOTATION = "selfcheck-skipped";

const REPORT_PATH = repoRelative(SELFCHECK_FILE);

/**
 * 5.10 要求的 5 项请求：以自检用书 id 推出前两项的原样路径，其余按形态认出，不依赖
 * `selfcheck.ts` 内部的具体取值。返回缺少的请求说明。
 */
function missingRequests(r: SelfcheckResult): string[] {
  const paths = new Set(r.items.map((item) => item.path));
  const id = encodeURIComponent(r.bookId);
  const bookGz = `/books/${id}.txt.gz`;
  const required: { what: string; present: boolean }[] = [
    { what: `中文 id 的 .txt.gz（${bookGz}）`, present: paths.has(bookGz) },
    { what: "/data/books.json", present: paths.has("/data/books.json") },
    {
      what: "/books/ 下不存在的 .txt.gz",
      present: [...paths].some((p) => p !== bookGz && /^\/books\/[^/]+\.txt\.gz$/.test(p)),
    },
    { what: `/read/<id> 深链接（/read/${id}）`, present: paths.has(`/read/${id}`) },
    { what: "%2e%2e 编码的越界路径", present: [...paths].some((p) => /%2e%2e/i.test(p)) },
  ];
  return required.filter((req) => !req.present).map((req) => req.what);
}

/** 选中的每个 Library_Profile × 模式是否恰好出现一次，以及是否有多出来的实例。返回问题说明。 */
function coverageProblems(report: SelfcheckReport): string[] {
  const problems: string[] = [];
  const claimed = new Set<string>();
  for (const profile of report.profiles) {
    for (const mode of MODES) {
      const origin = serverOrigin(profile, mode);
      const port = Number(new URL(origin).port);
      const checked = report.results.filter((r) => r.origin === origin && r.mode === mode);
      const skipped = report.skipped.filter((s) => s.port === port && s.mode === mode);
      checked.forEach((r) => claimed.add(`result:${r.instance}`));
      skipped.forEach((s) => claimed.add(`skipped:${s.instance}`));
      const count = checked.length + skipped.length;
      if (count !== 1) {
        problems.push(`${profile} × ${mode}（${origin}）应恰好出现 1 次，实际 ${count} 次`);
      }
    }
  }
  for (const r of report.results) {
    if (!claimed.has(`result:${r.instance}`)) {
      problems.push(`results 中的 ${r.instance}（${r.origin}，${r.mode}）不属于本次选中的任何组合`);
    }
  }
  for (const s of report.skipped) {
    if (!claimed.has(`skipped:${s.instance}`)) {
      problems.push(`skipped 中的 ${s.instance}（:${s.port}，${s.mode}）不属于本次选中的任何组合`);
    }
  }
  return problems;
}

test("服务器自检：selfcheck.json 中每个已启动实例的每项检查都通过 @selfcheck", async () => {
  const report = await step("读取 selfcheck.json", async () => {
    const read = await readSelfcheckReport();
    expect(read, `${REPORT_PATH} 不存在：本次运行的 globalSetup 没有走到服务器自检`).not.toBeNull();
    return read as SelfcheckReport;
  });

  for (const s of report.skipped) {
    test.info().annotations.push({
      type: SKIPPED_ANNOTATION,
      description: `${s.instance}（:${s.port}，${s.mode}）未启动：${s.reason}`,
    });
  }

  await step("自检已完整进行，且属于本次运行", () => {
    expect(report.error, `自检未能进行：${JSON.stringify(report.error)}`).toBeUndefined();
    expect(report.profiles, "selfcheck.json 的 profiles 应为本次选中的 Library_Profile").toEqual(
      selectedProfiles(process.env.E2E_PROFILE),
    );
  });

  await step("选中的每个实例都已自检或注明未启动", () => {
    const problems = coverageProblems(report);
    expect(problems, `实例覆盖有误：\n${problems.join("\n")}`).toEqual([]);
  });

  test.skip(
    report.results.length === 0,
    report.skipped.map((s) => s.reason).join("；") || "没有已启动的实例",
  );

  await step("每个实例的自检用书与请求清单符合 5.10", () => {
    const problems: string[] = [];
    for (const r of report.results) {
      if (!HAN.test(r.bookId)) problems.push(`${r.instance}：自检用书 id ${JSON.stringify(r.bookId)} 不含中文字符`);
      for (const what of missingRequests(r)) problems.push(`${r.instance}：缺少请求 ${what}`);
    }
    expect(problems, `请求清单不全：\n${problems.join("\n")}`).toEqual([]);
  });

  await step("每项检查都通过", () => {
    const failures = selfcheckFailures(report.results);
    const lines = failures.map(
      (f) => `  - ${f.name}（${f.path}）：期望 ${f.expected}；实际 ${f.actual}`,
    );
    expect(failures, `服务器自检有 ${failures.length} 项未通过（${REPORT_PATH}）：\n${lines.join("\n")}`).toEqual(
      [],
    );

    const inconsistent = report.results
      .filter((r) => r.items.length === 0 || r.ok !== r.items.every((item) => item.ok))
      .map((r) => `${r.instance}：ok 为 ${r.ok}，检查项 ${r.items.length} 条`);
    expect(inconsistent, "ok 字段应与逐项结果一致，且每个实例至少有 1 项检查").toEqual([]);
    expect(report.ok, "顶层 ok 应为 true").toBe(true);
  });
});
