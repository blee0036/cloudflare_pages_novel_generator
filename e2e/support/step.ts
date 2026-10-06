/**
 * 具名测试步骤（需求 6.9、17.2；设计"测试支撑"的 `step(title, fn)` 一条）。
 *
 * 场景用例的步骤一律经 `step()` 声明，不直接写 `test.step`（`eslint.config.js` 的 e2e 块以
 * `no-restricted-syntax` 禁止，只有本文件豁免）。`step()` 在调用 `test.step` 的同时维护本用例的
 * 步骤栈，使 `diagnostics` fixture（任务 7.4）在 teardown 中能用 `stepAtEnd(testInfo)` 读出
 * "失败或超时时所处的步骤名"，写进 `step-at-end` 附件，再由 reporter 写进 Run_Summary。
 *
 * ## 状态怎么记
 *
 * - 进入步骤时压栈，`finally` 出栈；步骤体抛错时，若本用例的 `failedAt` 尚未设置，记下当前栈
 *   路径（`外层 › 内层`），再原样重抛。嵌套步骤里最内层先捕获到错误，所以记下的是最内层的完整
 *   路径，外层看到 `failedAt` 已设就不再覆盖。
 * - 用例超时时步骤体的 Promise 不再结算，`finally` 不执行，栈里留着的就是超时所处的步骤。
 * - 超时后 Playwright 把 `testInfo.status` 置为 `timedOut` 并开始 teardown，但被放弃的用例体
 *   仍可能继续跑：挂起的操作可能在之后自行结算，使 `finally` 出栈，或让后续代码进入下一个
 *   `step()`。所以 `status` 为 `timedOut` / `interrupted` 之后，本模块不再改动栈与 `failedAt`，
 *   保留超时那一刻的状态（仍照常调用 `test.step`）。
 *
 * ## 按用例隔离
 *
 * 状态以 `TestInfo` 对象为键放在 `WeakMap` 里。同一用例的 hooks、fixture 与用例体拿到的是同一个
 * `TestInfo`（`test.info()` 与 fixture 参数里的 `testInfo` 相同），不同用例各有各的，用例结束后
 * 随 `TestInfo` 一起被回收。worker 是独立进程、进程内逐个执行用例，不存在跨用例的并发；
 * 用例失败后 Playwright 会换一个新的 worker 进程，被放弃的用例体不会活到下一个用例里。
 */
import { fileURLToPath } from "node:url";
import { test } from "@playwright/test";
import type { Location, TestInfo, TestStepInfo } from "@playwright/test";

/** 步骤路径中各层标题之间的分隔符（设计：`外层 › 内层`）。 */
export const STEP_PATH_SEPARATOR = " › ";

/** 失败或超时发生在任何具名步骤之外时的步骤名（需求 6.9）。 */
export const NO_NAMED_STEP = "无具名步骤";

interface StepState {
  /** 当前仍在执行的步骤标题，外层在前。 */
  readonly stack: string[];
  /** 首个抛出错误的步骤路径；未设置时为 `undefined`。 */
  failedAt: string | undefined;
}

const states = new WeakMap<TestInfo, StepState>();

function stateOf(info: TestInfo): StepState {
  let state = states.get(info);
  if (!state) {
    state = { stack: [], failedAt: undefined };
    states.set(info, state);
  }
  return state;
}

/** 用例体已被 Playwright 放弃（超时或中断）：此后不再改动步骤状态。 */
function isAbandoned(info: TestInfo): boolean {
  return info.status === "timedOut" || info.status === "interrupted";
}

function joinPath(stack: readonly string[]): string | undefined {
  return stack.length > 0 ? stack.join(STEP_PATH_SEPARATOR) : undefined;
}

/**
 * 取 `step()` 调用处的源码位置，交给 `test.step` 的 `location`。
 *
 * 不传时 Playwright 取直接调用 `test.step` 的那一帧，即本文件，HTML 报告与 trace 里每个步骤都会
 * 指向 `step.ts`。这里用 `Error.captureStackTrace` 去掉 `step` 自身及以上的帧，第一帧就是调用方
 * （Playwright 在 worker 里装了源码映射，帧位置已映射回 `.ts`）。解析不出时返回 `undefined`，
 * 退回 Playwright 的默认行为。
 */
function callerLocation(): Location | undefined {
  const holder: { stack?: string } = {};
  Error.captureStackTrace(holder, step);
  const frame = holder.stack
    ?.split("\n")
    .slice(1)
    .map((line) => line.trim())
    .find((line) => line.startsWith("at "));
  if (!frame) return undefined;

  const match = /(?:\(|at (?:async )?)([^()]+):(\d+):(\d+)\)?$/.exec(frame);
  if (!match) return undefined;

  let file = match[1];
  if (file.startsWith("file://")) {
    try {
      file = fileURLToPath(file);
    } catch {
      return undefined;
    }
  }
  return { file, line: Number(match[2]), column: Number(match[3]) };
}

/**
 * 声明一个具名测试步骤：调用 `test.step(title, body, options)`，同时维护本用例的步骤栈。
 *
 * 只能在用例体、hook 或用例级 fixture 中调用（`test.info()` 在其外会抛错，与 `test.step` 相同）。
 * `options.location` 未给出时取 `step()` 的调用处。
 */
export async function step<T>(
  title: string,
  body: (stepInfo: TestStepInfo) => T | Promise<T>,
  options: { box?: boolean; location?: Location; timeout?: number } = {},
): Promise<T> {
  const info = test.info();
  const state = stateOf(info);
  const location = options.location ?? callerLocation();

  return test.step(
    title,
    async (stepInfo) => {
      const tracked = !isAbandoned(info);
      if (tracked) state.stack.push(title);
      try {
        return await body(stepInfo);
      } catch (error) {
        if (tracked && !isAbandoned(info) && state.failedAt === undefined) {
          state.failedAt = joinPath(state.stack);
        }
        throw error;
      } finally {
        if (tracked && !isAbandoned(info)) state.stack.pop();
      }
    },
    { ...options, ...(location ? { location } : {}) },
  );
}

/**
 * 用例结束时所处的步骤名，供 `diagnostics` fixture 写 `step-at-end` 附件（需求 6.9、17.2）。
 *
 * - 一般情形取 `failedAt ?? 栈路径 ?? "无具名步骤"`（设计原文）。
 * - 超时（`timedOut`）时优先取栈路径：栈停在超时那一刻，就是超时所处的步骤；栈为空说明超时
 *   发生在具名步骤之外，记"无具名步骤"。只有在用例代码吞掉了某个步骤抛出的错误、之后又超时的
 *   情形下，两种取法才会不同，那时 `failedAt` 指向的是早先被吞掉的错误，不是超时处。
 *
 * 应在用例体结束之后调用（fixture teardown 中）。
 */
export function stepAtEnd(info: TestInfo): string {
  const state = states.get(info);
  if (!state) return NO_NAMED_STEP;
  const stackPath = joinPath(state.stack);
  if (info.status === "timedOut") return stackPath ?? NO_NAMED_STEP;
  return state.failedAt ?? stackPath ?? NO_NAMED_STEP;
}
