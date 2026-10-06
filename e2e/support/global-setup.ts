/**
 * Playwright globalSetup：一次 E2E 运行的编排（设计"globalSetup 顺序"；需求 1.5、1.9、3.7、3.9、
 * 4.5、5.1、5.9–5.12、5.14、13.5、17.7）。
 *
 * 按以下 6 步执行，第 1–5 步包在同一个 `try` 里，当前阶段名随步骤更新：
 *
 * | 步 | 做什么 | 阶段名 |
 * | --- | --- | --- |
 * | 1 | 删除上一次的 `abort.json`、`public-snapshot-*.json`、`results.json` 与本文件写出的状态文件，清空 `e2e/.out/review/`（13.5）；取 `public/` 开始快照写 `public-snapshot-start.json`（4.5）；`E2E_ABORT` 已设置时即中止（1.5） | 浏览器检查 |
 * | 2 | 运行 `python e2e/fixture/generate.py --if-stale`（3.7）；失败时写 `fixture-failed.json`（3.9）并中止 | 夹具生成 |
 * | 3 | `buildApp()`（5.1），随后 `validateAppBuild()`（5.1、4.6） | App_Build 构建 → 产物校验 |
 * | 4 | 为 Fixture_Library 的 Opaque_Mode 与 Transparent_Mode 各启动一个实例（5.12）；端口被占用时中止（5.9） | 端口占用 |
 * | 5 | 对每个已启动的实例执行服务器自检，写 `selfcheck.json`；任一项失败即中止（5.10、5.11） | 服务器自检 |
 * | 6 | 返回 teardown：关闭全部实例，10 s 内结束（5.14） | — |
 *
 * 第 1 步的开始快照只取 `public/` 下各文件与 `.preprocess-manifest.json` 的元数据（`lstat`），不读
 * 文件内容；`public/` 不存在时快照里没有它的条目。reporter 结束时再取一次并与之比对，守住"运行前后
 * Real_Library 不变"（test-data-desensitization 需求 2.7）。
 *
 * ## 中止（17.7）
 *
 * 任一步抛错时：先以 `writeAbort({ stage, reason, checks })` 写 `abort.json`（`checks` 为 5.11 的
 * 检查项，或产物违规的文件路径），再关闭已启动的实例，最后原样重抛。Playwright 随即不执行任何
 * 用例；任务 1.5 已对锁定版本（1.62.1）核实 R4：reporter 仍依次收到 `onError` 与
 * `onEnd`（`failed`），由 reporter 在 `onEnd` 读 `abort.json` 写中止版 Run_Summary 与
 * Review_Report，所以这里不自己写 Run_Summary。
 *
 * ## Library_Profile
 *
 * 只有 fixture 一个：real 档已移除，测试只用合成书库（test-data-desensitization 需求 4.1）。
 * `run.mjs` 设置的环境变量 `E2E_PROFILE` 为 `fixture` 或 `all`，未设置时同 `all`（即直接执行
 * `npx playwright test`），三者都只选中 fixture；其他取值由 `selectedProfiles` 抛错。
 * Fixture_Generator 失败时（3.9）第 2 步即中止，不启动任何实例，所以 `selfcheck.json` 的
 * `skipped` 总是空数组。
 *
 * ## 状态文件（均在被 gitignore 的 `e2e/.out/`）
 *
 * - `abort.json`：`abort.ts`；只在中止时写。
 * - `fixture-failed.json`：`library.ts` 的 `writeFixtureFailed`；只在 Fixture_Generator 失败时写。
 * - `selfcheck.json`：`selfcheck.ts` 的 `writeSelfcheckReport`；走到第 5 步时写（自检未能进行时同样写，带 `error`）。
 * - `public-snapshot-start.json`：`snapshot.ts`；取快照失败时不写，reporter 按"开始快照缺失"判运行失败（4.8）。
 * - `server.log`：各实例共用，追加写入 403 请求（5.7）。
 *
 * 第 1 步把前 3 个与 `public-snapshot-*.json`、`results.json` 一并删除，上一次运行的残留不会被
 * 本次的 `lib` fixture 或 reporter 误读。
 */
import { spawn } from "node:child_process";
import { mkdir, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import type { Mode } from "../server/resolve";
import {
  SELFCHECK_FILE,
  runSelfcheck,
  selfcheckFailures,
  writeSelfcheckReport,
  type SelfcheckReport,
  type SelfcheckResult,
} from "../server/selfcheck";
import { PortInUseError, createE2EServer, type E2EServer } from "../server/server";
import {
  ABORT_ENV_STAGES,
  ABORT_STAGES,
  clearAbort,
  writeAbort,
  type AbortCheck,
  type AbortInput,
  type AbortStage,
} from "./abort";
import { AppBuildInvalidError, buildApp, validateAppBuild } from "./build-app";
import {
  FIXTURE_FAILED_FILE,
  Library,
  libRootFor,
  repoRelative,
  selectedProfiles,
  writeFixtureFailed,
  type FixtureFailure,
  type LibraryProfile,
} from "./library";
import { PORTS } from "./settings";
import { SNAPSHOT_START_FILE, takeSnapshot, writeSnapshot } from "./snapshot";

/** 仓库根（本文件位于 `e2e/support/`）。 */
const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const OUT_DIR = path.join(REPO_ROOT, "e2e", ".out");

/** Review_Shot 与 Review_Report 的目录，每次运行开始时清空（13.5）。 */
const REVIEW_DIR = path.join(OUT_DIR, "review");
/** reporter 写出的 Run_Summary 序列化，上一次的在第 1 步删除。 */
const RESULTS_FILE = path.join(OUT_DIR, "results.json");
/** `public-snapshot-start.json` / `public-snapshot-end.json` 等，上一次的在第 1 步删除。 */
const SNAPSHOT_FILE_PATTERN = /^public-snapshot-.*\.json$/;
/** 全部实例共用的服务器日志（5.7），不在任何被服务的目录之内。 */
const SERVER_LOG = path.join(OUT_DIR, "server.log");

/** Fixture_Generator；与 `npm run e2e:fixture` 用同一个解释器名。 */
const PYTHON = "python";
const FIXTURE_GENERATOR = path.join(REPO_ROOT, "e2e", "fixture", "generate.py");

const INSTALL_COMMAND = "npm run e2e:install";

/** 5.10：自检用书的 id 须含中文字符。 */
const HAN = /\p{Script=Han}/u;

/** 一个 Library_Profile × 模式组合对应的实例（5.12）；端口只取自 `settings.ts` 的 `PORTS`。 */
interface InstanceDef {
  /** 实例名，写入 `selfcheck.json` 与 `abort.json` 的检查项。 */
  name: string;
  profile: LibraryProfile;
  mode: Mode;
  port: number;
}

/** Fixture_Library 的 Opaque_Mode 与 Transparent_Mode 各一个实例，按启动顺序。 */
const INSTANCES: readonly InstanceDef[] = [
  { name: "fixture-opaque", profile: "fixture", mode: "opaque", port: PORTS.fixtureOpaque },
  { name: "fixture-transparent", profile: "fixture", mode: "transparent", port: PORTS.fixtureTransparent },
];

interface StartedInstance {
  def: InstanceDef;
  server: E2EServer;
}

/**
 * 本文件在已知原因下主动中止时抛出的错误。`reason` 与 `checks` 原样写入 `abort.json`；
 * 消息另带阶段名，Playwright 经 `onError` 报出的首行即可看出中止在哪一步。
 */
class SetupAbortError extends Error {
  readonly reason: string;
  readonly checks: readonly AbortCheck[] | undefined;

  constructor(stage: AbortStage, reason: string, checks?: readonly AbortCheck[]) {
    super(abortMessage(stage, reason, checks));
    this.name = "SetupAbortError";
    this.reason = reason;
    this.checks = checks;
  }
}

function abortMessage(stage: AbortStage, reason: string, checks?: readonly AbortCheck[]): string {
  const lines = [`E2E 运行在"${stage}"阶段中止：${reason}`];
  for (const c of checks ?? []) {
    const where = c.path === undefined ? "" : `（${c.path}）`;
    lines.push(`  - ${c.name}${where}：期望 ${c.expected}；实际 ${c.actual}`);
  }
  return lines.join("\n");
}

function log(message: string): void {
  console.log(`[e2e] ${message}`);
}

function warn(message: string): void {
  console.error(`[e2e] ${message}`);
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code && !error.message.includes(code) ? `${code}：${error.message}` : error.message;
  }
  return String(error);
}

// ---------------------------------------------------------------------------
// 第 1 步：清理与开始快照
// ---------------------------------------------------------------------------

async function clearPreviousRun(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  await clearAbort();
  const stale = (await readdir(OUT_DIR)).filter((name) => SNAPSHOT_FILE_PATTERN.test(name));
  await Promise.all([
    ...stale.map((name) => rm(path.join(OUT_DIR, name), { force: true })),
    ...[RESULTS_FILE, FIXTURE_FAILED_FILE, SELFCHECK_FILE].map((file) => rm(file, { force: true })),
  ]);
  // 评审截图可能正被看图程序打开（EBUSY / EPERM），给几次重试的机会
  await rm(REVIEW_DIR, { recursive: true, force: true, maxRetries: 3 });
  await mkdir(REVIEW_DIR, { recursive: true });
}

/**
 * 取 `public/` 开始快照（4.5）。失败时不中止：快照失败不是 `ABORT_STAGES` 中的阶段，
 * reporter 发现开始快照缺失即记一条运行级失败（4.8），这里把原因打到 stderr。
 */
async function recordStartSnapshot(): Promise<void> {
  try {
    const snapshot = await takeSnapshot();
    await writeSnapshot(SNAPSHOT_START_FILE, snapshot);
    log(`public/ 开始快照：${snapshot.count} 个文件，${snapshot.ms} ms → ${repoRelative(SNAPSHOT_START_FILE)}`);
  } catch (error) {
    await rm(SNAPSHOT_START_FILE, { force: true }).catch(() => undefined);
    warn(`未能取得 public/ 开始快照，本次运行将按"开始快照缺失"判为失败：${errorText(error)}`);
  }
}

/** `E2E_ABORT` 要求中止时的原因与检查项（1.5）。 */
function envAbort(value: string): { stage: AbortStage; reason: string; checks?: AbortCheck[] } {
  const stage = ABORT_ENV_STAGES[value] as AbortStage | undefined;
  if (stage === undefined) {
    return {
      stage: ABORT_STAGES[0],
      reason: `环境变量 E2E_ABORT 为未知取值 ${JSON.stringify(value)}，按要求在执行任何用例之前中止`,
    };
  }
  let version = "（未知版本）";
  try {
    version = (createRequire(import.meta.url)("@playwright/test/package.json") as { version: string }).version;
  } catch {
    // 读不到版本号不影响中止本身
  }
  let executable = "";
  try {
    executable = chromium.executablePath();
  } catch {
    // 同上
  }
  return {
    stage,
    reason: `未找到与 @playwright/test ${version} 对应的 Chromium，未执行任何用例；请先执行 ${INSTALL_COMMAND}`,
    checks: [
      {
        name: `@playwright/test ${version} 对应的 Chromium`,
        ...(executable === "" ? {} : { path: executable }),
        expected: "已安装",
        actual: "缺失",
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// 第 2 步：Fixture_Generator
// ---------------------------------------------------------------------------

interface GeneratorRun {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** stderr 全文（UTF-8）。 */
  stderr: string;
  /** 进程未能启动时的错误（如 `ENOENT`：找不到解释器）。 */
  spawnError?: NodeJS.ErrnoException;
}

/**
 * 运行 `python e2e/fixture/generate.py --if-stale`。stdout 原样转到本进程的 stdout；stderr 同时
 * 转出与收集（失败清单写在 stderr，3.9）。不设超时：从零生成的时长取决于本机，由 Playwright
 * 的 `globalTimeout`（如有）兜底。
 */
function runFixtureGenerator(): Promise<GeneratorRun> {
  return new Promise<GeneratorRun>((resolve) => {
    let settled = false;
    const settle = (run: GeneratorRun): void => {
      if (settled) return;
      settled = true;
      resolve(run);
    };
    const chunks: Buffer[] = [];
    const child = spawn(PYTHON, [FIXTURE_GENERATOR, "--if-stale"], {
      cwd: REPO_ROOT,
      // generate.py 自己把输出流设为 UTF-8；这里再设一次，覆盖它之前的导入期输出
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout.on("data", (chunk: Buffer) => {
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      process.stderr.write(chunk);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      // 启动失败（没有 pid）时 close 不一定再触发；运行中的错误等 close 汇报退出码
      if (child.pid === undefined) {
        settle({ exitCode: null, signal: null, stderr: Buffer.concat(chunks).toString("utf8"), spawnError: error });
      }
    });
    child.on("close", (code, signal) => {
      settle({ exitCode: code, signal, stderr: Buffer.concat(chunks).toString("utf8") });
    });
  });
}

/**
 * 按需生成 Fixture_Library（3.7）。成功时返回 null；失败时写 `fixture-failed.json` 并返回其内容
 * （3.9），由调用方中止本次运行。
 */
async function prepareFixtureLibrary(): Promise<FixtureFailure | null> {
  log(`Fixture_Generator：${PYTHON} ${repoRelative(FIXTURE_GENERATOR)} --if-stale`);
  const run = await runFixtureGenerator();
  if (run.spawnError === undefined && run.exitCode === 0) return null;

  const detail = run.stderr
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "");
  let reason: string;
  if (run.spawnError !== undefined) {
    // 1.9：报告缺失的解释器
    reason =
      run.spawnError.code === "ENOENT"
        ? `未找到 Python 解释器（${PYTHON}）`
        : `无法启动 Python 解释器（${PYTHON}）：${errorText(run.spawnError)}`;
    detail.push(`无法启动 ${PYTHON}：${errorText(run.spawnError)}`);
  } else if (run.exitCode === null) {
    reason = `Fixture_Generator 被信号 ${run.signal ?? "（未知）"} 终止`;
  } else {
    reason = `Fixture_Generator 以退出码 ${run.exitCode} 结束`;
  }
  const failure: FixtureFailure = {
    writtenAt: new Date().toISOString(),
    exitCode: run.spawnError === undefined ? run.exitCode : null,
    reason,
    detail,
  };
  await writeFixtureFailed(failure);
  warn(`${reason}；已写 ${repoRelative(FIXTURE_FAILED_FILE)}`);
  return failure;
}

// ---------------------------------------------------------------------------
// 第 4、5 步：实例与自检
// ---------------------------------------------------------------------------

/**
 * 为一个 Library_Profile 取自检用书（5.10）：在 `books.json` 列出的全部书中，取 id 含中文字符、
 * `.txt.gz` 最小的一本（自检要整本读入求 SHA-256），大小相同时取靠前的。
 */
async function pickSelfcheckBook(profile: LibraryProfile): Promise<string> {
  const lib = await Library.open(profile);
  const ids = (await lib.books()).books.map((b) => b.id);
  const candidates = ids.filter((id) => HAN.test(id));
  if (candidates.length === 0) {
    throw new Error(`${profile} 书库中没有 id 含中文字符的书，无法按 5.10 取自检用书`);
  }
  const sized = await Promise.all(candidates.map(async (id) => ({ id, size: await lib.gzSize(id) })));
  sized.sort((a, b) => a.size - b.size);
  return sized[0].id;
}

/** 关闭实例（5.14）。各实例并行关闭，每个在 `TIMEOUTS.serverShutdown` 内未关闭即失败；返回失败说明。 */
async function closeInstances(started: StartedInstance[]): Promise<string[]> {
  const closing = started.splice(0, started.length);
  const results = await Promise.allSettled(closing.map((s) => s.server.close()));
  const failures: string[] = [];
  results.forEach((result, i) => {
    if (result.status === "rejected") {
      failures.push(`${closing[i].def.name}（${closing[i].server.origin}）：${errorText(result.reason)}`);
    }
  });
  return failures;
}

/** 把抛出的错误转成 `abort.json` 的内容。 */
function abortInputOf(stage: AbortStage, error: unknown): AbortInput {
  if (error instanceof SetupAbortError) {
    return { stage, reason: error.reason, checks: error.checks };
  }
  if (error instanceof AppBuildInvalidError) {
    return {
      stage,
      reason: `App_Build 违反需求 5.1 的约束（${error.violations.length} 项）`,
      checks: error.violations,
    };
  }
  if (error instanceof PortInUseError) {
    const def = INSTANCES.find((d) => d.port === error.port);
    return {
      stage,
      reason: `端口 ${error.port} 已被占用，已关闭本次启动的其余实例`,
      checks: [
        {
          name: `${def ? `[${def.name}] ` : ""}监听 127.0.0.1:${error.port}`,
          expected: "端口可用",
          actual: `端口 ${error.port} 已被占用`,
        },
      ],
    };
  }
  const reason = errorText(error).trim();
  return { stage, reason: reason === "" ? "未知错误" : reason };
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export default async function globalSetup(): Promise<() => Promise<void>> {
  const profiles = selectedProfiles(process.env.E2E_PROFILE);
  const started: StartedInstance[] = [];
  let stage: AbortStage = "浏览器检查";

  try {
    // 1. 清理上一次的产物与状态文件，取开始快照；E2E_ABORT 即中止
    log(`Library_Profile：${profiles.join("、")}`);
    await clearPreviousRun();
    await recordStartSnapshot();
    const abortValue = process.env.E2E_ABORT;
    if (abortValue !== undefined && abortValue !== "") {
      const info = envAbort(abortValue);
      stage = info.stage;
      throw new SetupAbortError(stage, info.reason, info.checks);
    }

    // 2. Fixture_Generator（3.7、3.9）；失败即中止，fixture 下的用例都无法执行
    stage = "夹具生成";
    const fixtureFailure = await prepareFixtureLibrary();
    if (fixtureFailure !== null) {
      throw new SetupAbortError(
        stage,
        `${fixtureFailure.reason}；测试只用 Fixture_Library，已没有可执行的用例` +
          `（出错书与未满足项见 ${repoRelative(FIXTURE_FAILED_FILE)}）`,
      );
    }

    // 3. App_Build 与产物校验（5.1、4.6）
    stage = "App_Build 构建";
    const app = await buildApp();
    log(`App_Build 完成：${repoRelative(app.outDir)}（${app.ms} ms）`);
    stage = "产物校验";
    const violations = await validateAppBuild(app.outDir);
    if (violations.length > 0) throw new AppBuildInvalidError(violations);

    // 4. 启动 Fixture_Library 的两个实例（5.12、5.9）
    stage = "端口占用";
    for (const def of INSTANCES) {
      const server = await createE2EServer({
        port: def.port,
        mode: def.mode,
        appRoot: app.outDir,
        libRoot: libRootFor(def.profile),
        log: SERVER_LOG,
      });
      started.push({ def, server });
      log(`${def.name} 已启动：${server.origin}`);
    }

    // 5. 服务器自检（5.10、5.11）
    stage = "服务器自检";
    const results: SelfcheckResult[] = [];
    const books = new Map<LibraryProfile, string>();
    let current = "";
    try {
      for (const { def, server } of started) {
        current = def.name;
        let bookId = books.get(def.profile);
        if (bookId === undefined) {
          bookId = await pickSelfcheckBook(def.profile);
          books.set(def.profile, bookId);
        }
        results.push(
          await runSelfcheck({
            instance: def.name,
            port: server.port,
            mode: def.mode,
            appRoot: app.outDir,
            libRoot: libRootFor(def.profile),
            log: SERVER_LOG,
            bookId,
          }),
        );
      }
    } catch (error) {
      const message = errorText(error);
      const report: SelfcheckReport = {
        checkedAt: new Date().toISOString(),
        profiles,
        results,
        skipped: [],
        error: { instance: current, message },
        ok: false,
      };
      await writeSelfcheckReport(report);
      throw new SetupAbortError(stage, `服务器自检未能进行（实例 ${current}）：${message}`);
    }
    const report: SelfcheckReport = {
      checkedAt: new Date().toISOString(),
      profiles,
      results,
      skipped: [],
      ok: results.every((r) => r.ok),
    };
    await writeSelfcheckReport(report);
    if (!report.ok) {
      const failures = selfcheckFailures(results);
      throw new SetupAbortError(stage, `服务器自检有 ${failures.length} 项未通过`, failures);
    }
    const itemCount = results.reduce((n, r) => n + r.items.length, 0);
    log(`服务器自检通过：${results.length} 个实例、${itemCount} 项 → ${repoRelative(SELFCHECK_FILE)}`);
  } catch (error) {
    // 先写 abort.json，再关闭已启动的实例，最后原样重抛（17.7、5.9、5.11）
    const info = abortInputOf(stage, error);
    try {
      await writeAbort(info);
    } catch (writeError) {
      warn(`写 abort.json 失败：${errorText(writeError)}`);
    }
    const closeFailures = await closeInstances(started);
    for (const line of closeFailures) warn(`关闭实例失败：${line}`);
    // SetupAbortError 的消息本身即中止说明，由 Playwright 报出；其余错误（如 Vite 构建错误）
    // 原样重抛，这里补一行阶段与原因
    if (!(error instanceof SetupAbortError)) warn(abortMessage(info.stage, info.reason, info.checks));
    throw error;
  }

  // 6. teardown：关闭全部实例（5.14）
  return async () => {
    const failures = await closeInstances(started);
    if (failures.length > 0) {
      throw new Error(`E2E_Server 未能全部关闭（5.14）：\n${failures.map((f) => `  - ${f}`).join("\n")}`);
    }
  };
}
