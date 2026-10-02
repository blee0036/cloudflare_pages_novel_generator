/**
 * 加载失败日志 `[load-error]` 的记录与核对（reader-defect-fixes 需求 13.4、13.10；
 * `fixture/load-error.spec.ts`、`fixture/shelf-skeleton.spec.ts`）。
 *
 * 应用在阅读器 Error_Page 与书架 Shelf_Error_State 出现时各以 `console.error` 打一行日志，格式见
 * RDF 设计第 12 节：`[load-error] stage=<stage> id=<bookId|-> status=<n|-> name=<name> message=<message>`。
 * 浏览器自己的资源加载报错（"Failed to load resource: …"）也是 `error` 类型的 console 消息，但不以
 * `[load-error] ` 开头，不计入。
 *
 * "恰为 1 条"是否定判断：调用方在失败状态显示后再等 2 个动画帧（`waitFrames`）作为观测窗口终点，
 * 再调用 `expectSingleLoadErrorLog`。应用在 `setError` 之前打日志，失败状态可见时该行已经发出。
 */
import { expect, test } from "@playwright/test";
import type { ConsoleMessage, Page } from "@playwright/test";
import { escapeRegExp } from "./locators";
import { step } from "./step";

/** 日志行前缀（含末尾空格）。 */
export const LOAD_ERROR_PREFIX = "[load-error] ";

/** 一条以 `[load-error] ` 开头的 console 消息。 */
export interface LoadErrorLogLine {
  /** `ConsoleMessage.type()`；`console.error` 为 `error`。 */
  type: string;
  text: string;
}

/** 本页面的 `[load-error]` 日志。`stop()` 之后不再记录。 */
export interface LoadErrorLog {
  lines(): readonly LoadErrorLogLine[];
  stop(): void;
}

/** 开始记录本页面以 `[load-error] ` 开头的 console 消息。须在首次导航之前调用。 */
export function recordLoadErrorLog(page: Page): LoadErrorLog {
  const seen: LoadErrorLogLine[] = [];
  let recording = true;
  const onConsole = (msg: ConsoleMessage): void => {
    if (!recording) return;
    const text = msg.text();
    if (text.startsWith(LOAD_ERROR_PREFIX)) seen.push({ type: msg.type(), text });
  };
  page.on("console", onConsole);
  return {
    lines: () => [...seen],
    stop() {
      recording = false;
      page.off("console", onConsole);
    },
  };
}

/** 对那一行日志的期望。 */
export interface LoadErrorLogExpectation {
  /** Load_Stage。 */
  stage: "toc" | "text" | "catalog";
  /** 书 id；书架阶段没有书 id，为 null（日志写作 `id=-`）。 */
  bookId: string | null;
  /** 响应状态：数值为有响应时的状态码；null 为没有响应（`status=-`）；缺省不核对。 */
  status?: number | null;
}

/** 按设计第 12 节的格式拼出整行的正则：名称与消息只要求非空。 */
function logLinePattern(expected: LoadErrorLogExpectation): RegExp {
  const id = expected.bookId === null ? "-" : escapeRegExp(expected.bookId);
  const status =
    expected.status === undefined ? "\\S+" : expected.status === null ? "-" : String(expected.status);
  return new RegExp(
    `^${escapeRegExp(LOAD_ERROR_PREFIX)}stage=${expected.stage} id=${id} status=${status} name=\\S+ message=\\S.*$`,
  );
}

function describeExpectation(expected: LoadErrorLogExpectation): string {
  const parts = [`stage=${expected.stage}`, `id=${expected.bookId ?? "-"}`];
  if (expected.status !== undefined) parts.push(`status=${expected.status ?? "-"}`);
  return parts.join(" ");
}

/**
 * 观测窗口内以 `[load-error] ` 开头的 console 消息恰为 1 条，类型为 `error`（`console.error`），
 * 且含期望的阶段、书 id（与响应状态），以及非空的名称与消息（需求 13.4、13.10）。
 */
export async function expectSingleLoadErrorLog(
  log: LoadErrorLog,
  expected: LoadErrorLogExpectation,
  label: string,
): Promise<void> {
  await step(
    `${label} console 中以“${LOAD_ERROR_PREFIX.trim()}”开头的消息恰为 1 条（console.error），含 ${describeExpectation(expected)}、名称与消息`,
    async () => {
      const lines = log.lines();
      test.info().annotations.push({
        type: "load-error-log",
        description:
          lines.length === 0 ? "（没有 [load-error] 行）" : lines.map((l) => `[${l.type}] ${l.text}`).join("；"),
      });
      expect(
        lines.map((l) => l.text),
        `以“${LOAD_ERROR_PREFIX.trim()}”开头的 console 消息`,
      ).toHaveLength(1);
      const [line] = lines;
      expect(line.type, "该消息的类型（console.error 为 error）").toBe("error");
      expect(line.text, `该消息应含 ${describeExpectation(expected)}、非空的名称与消息`).toMatch(
        logLinePattern(expected),
      );
    },
  );
}
