/**
 * `abort.json` 的读写（设计"globalSetup 顺序"末段与 Data Models 的 `AbortInfo`；需求 17.7、5.11）。
 *
 * globalSetup 的第 1–6 步包在一个 `try` 里，当前阶段名随步骤更新。任一步抛错时，先以
 * `writeAbort({ stage, reason, checks })` 写下中止阶段、原因与检查项，关闭已启动的实例，再重抛。
 * Playwright 随即不执行任何用例；reporter 的 `onEnd` 仍会以 `failed` 被调用（任务 1.5 已对
 * 锁定版本核实 R4），在其中 `readAbort()` 并写中止版 Run_Summary 与 Review_Report。
 *
 * - `checks` 即 5.11 的检查项：名称、请求路径、期望值与实际值。`selfcheck.ts` 的
 *   `SelfcheckFailure` 与 `build-app.ts` 的 `AppBuildViolation` 字段相同，可原样传入。
 * - `writtenAt` 由 `writeAbort` 填写。globalSetup 第 1 步会先 `clearAbort()`，正常情况下
 *   `abort.json` 只可能出自本次运行；reporter 仍可用 `isAbortFromRun` 与 `onEnd` 的
 *   `result.startTime` 比较，排除上一次运行的残留（R4 结论：`startTime` 早于 globalSetup 开始）。
 * - 本文件只依赖 Node 内置模块，不在运行时导入其他 E2E 模块。
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 仓库根（本文件位于 `e2e/support/`）。 */
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** globalSetup 中止时写入的文件，在被 gitignore 的 `e2e/.out/` 内。 */
export const ABORT_FILE = path.join(REPO_ROOT, "e2e", ".out", "abort.json");

/** globalSetup 第 1–6 步的阶段名，按执行顺序（设计"globalSetup 顺序"）。 */
export const ABORT_STAGES = [
  "浏览器检查",
  "夹具生成",
  "App_Build 构建",
  "产物校验",
  "端口占用",
  "服务器自检",
] as const;

export type AbortStage = (typeof ABORT_STAGES)[number];

/**
 * `run.mjs` 经环境变量 `E2E_ABORT` 要求 globalSetup 直接中止时，取值与中止阶段的对应
 * （1.5：Chromium 缺失时取完开始快照即以"浏览器检查"中止）。
 */
export const ABORT_ENV_STAGES: Readonly<Record<string, AbortStage>> = {
  "chromium-missing": "浏览器检查",
};

/** 一个检查项（5.11）。`path` 为请求路径或违规文件路径，没有时省略。 */
export interface AbortCheck {
  name: string;
  path?: string;
  expected: string;
  actual: string;
}

/** 与设计 Data Models 的 `AbortInfo` 相同；Run_Summary 模型直接使用它。 */
export interface AbortInfo {
  stage: string;
  reason: string;
  checks?: AbortCheck[];
}

/** `abort.json` 的内容：`AbortInfo` 加上写入时刻。 */
export interface AbortRecord extends AbortInfo {
  stage: AbortStage;
  /** 写入时刻，ISO 8601（UTC）。 */
  writtenAt: string;
}

/** `writeAbort` 的参数。`checks` 可直接传 `SelfcheckFailure[]` 或 `AppBuildViolation[]`。 */
export interface AbortInput {
  stage: AbortStage;
  reason: string;
  checks?: readonly AbortCheck[];
}

function isErrno(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && (err as NodeJS.ErrnoException).code === code;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isAbortStage(v: unknown): v is AbortStage {
  return typeof v === "string" && (ABORT_STAGES as readonly string[]).includes(v);
}

/**
 * 写 `abort.json`（覆盖已有文件，父目录不存在时创建），返回写入的内容。
 *
 * `checks` 为空数组时省略该字段；每一项只保留 `name`、`path`、`expected`、`actual` 四个字段。
 *
 * @throws `stage` 不是 `ABORT_STAGES` 之一，或 `reason` 为空串时。
 */
export async function writeAbort(input: AbortInput, file: string = ABORT_FILE): Promise<AbortRecord> {
  if (!isAbortStage(input.stage)) {
    throw new Error(`未知的中止阶段 ${JSON.stringify(input.stage)}，应为：${ABORT_STAGES.join("、")}`);
  }
  if (input.reason === "") {
    throw new Error("中止原因不能为空");
  }
  const record: AbortRecord = {
    stage: input.stage,
    reason: input.reason,
    writtenAt: new Date().toISOString(),
  };
  if (input.checks && input.checks.length > 0) {
    record.checks = input.checks.map(({ name, path: p, expected, actual }) =>
      p === undefined ? { name, expected, actual } : { name, path: p, expected, actual },
    );
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return record;
}

/**
 * 读 `abort.json`。文件不存在时返回 null（本次运行未中止）；内容不合法时抛错，
 * 错误信息含文件路径与第一处不合法的字段。
 */
export async function readAbort(file: string = ABORT_FILE): Promise<AbortRecord | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if (isErrno(err, "ENOENT")) return null;
    throw err;
  }
  const bad = (what: string): Error => new Error(`${file} 格式无效：${what}`);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw bad(`不是合法 JSON（${(err as Error).message}）`);
  }
  if (!isRecord(data)) throw bad("顶层不是对象");
  const { stage, reason, writtenAt, checks } = data;
  if (!isAbortStage(stage)) throw bad(`stage 为 ${JSON.stringify(stage)}`);
  if (typeof reason !== "string" || reason === "") throw bad("reason");
  if (typeof writtenAt !== "string" || Number.isNaN(Date.parse(writtenAt))) throw bad("writtenAt");
  const record: AbortRecord = { stage, reason, writtenAt };
  if (checks !== undefined) {
    if (!Array.isArray(checks)) throw bad("checks 不是数组");
    record.checks = checks.map((item: unknown, i) => {
      if (!isRecord(item)) throw bad(`checks[${i}] 不是对象`);
      const { name, path: p, expected, actual } = item;
      if (typeof name !== "string") throw bad(`checks[${i}].name`);
      if (p !== undefined && typeof p !== "string") throw bad(`checks[${i}].path`);
      if (typeof expected !== "string") throw bad(`checks[${i}].expected`);
      if (typeof actual !== "string") throw bad(`checks[${i}].actual`);
      return p === undefined ? { name, expected, actual } : { name, path: p, expected, actual };
    });
  }
  return record;
}

/** 删除 `abort.json`；文件不存在时什么也不做（globalSetup 第 1 步）。 */
export async function clearAbort(file: string = ABORT_FILE): Promise<void> {
  await rm(file, { force: true });
}

/**
 * `record` 是否写于本次运行开始之后。`runStartedAt` 取 reporter `onEnd` 的
 * `result.startTime`（早于 globalSetup 开始，见任务 1.5 的 R4 结论）。
 */
export function isAbortFromRun(record: Pick<AbortRecord, "writtenAt">, runStartedAt: Date): boolean {
  return Date.parse(record.writtenAt) >= runStartedAt.getTime();
}
