/**
 * reporter 自检（任务 16.5；需求 6.9、17.2、17.3、17.5；设计"Testing Strategy"末段）。
 *
 * 三个用例都故意"不成功"，用来核对 `e2e/support/reporter.ts` 与 `summary.ts` 写出的 Run_Summary：
 *
 * | 用例 | 做法 | Run_Summary 中应出现的内容 |
 * | --- | --- | --- |
 * | 超时 | `test.setTimeout(TIMEOUTS.reporterSelftest)`（2,000 ms），在 `step("自检超时")` 内等待一个永不结算的 Promise | "失败用例"节，结果"失败（超时）"；"超时用例"节：用例名、生效超时 2000 ms、步骤"自检超时"（6.9） |
 * | 断言失败 | 在 `step("自检断言失败")` 内做一个必然不成立的 `expect` | "失败用例"节：步骤"自检断言失败"、错误首行 |
 * | 意外通过 | `test.fail(true, …)` 标注预期失败，用例体却全部通过 | "失败用例"节，结果"意外通过"；"预期失败与意外通过"节的"意外通过"小节 |
 *
 * 三者的"失败用例"条目都应带 trace、失败时截图、浏览器控制台日志三项产物的相对路径（17.2），
 * 整次运行的退出码为 1（17.5）。
 *
 * ## 为什么用 `support/fixtures.ts` 的 `test` 与 `page`
 *
 * tooling 下的其余用例是无浏览器的纯逻辑测试，直接用 `@playwright/test`。本文件要验证的是 UI 用例
 * 失败时的完整产物链，所以改用场景用例同一个 `test`：
 *
 * - 自动 fixture `diagnostics` 在结果与预期不符时写 `console.log`（附件 `console-log`）与
 *   `step-at-end`（步骤名与生效超时）；没有它，summary 对 tooling 用例只能写"无具名步骤"与
 *   "未生成（没有 console-log 附件）"。
 * - 每个用例都请求 `page`（`about:blank`，不访问 E2E_Server），使配置里的
 *   `trace: "retain-on-failure"` 与 `screenshot: "only-on-failure"` 有浏览器上下文可录、有页面可拍。
 * - 每个用例先经 `page.evaluate` 打一条 `[selftest]` 控制台消息，核对它出现在 `console.log` 里。
 *
 * tooling 项目的 `profile` 为 `null`：`target` 不加注解、不跳过，`lib`、`shot` 等书库相关 fixture
 * 一概不用，因此本文件不依赖 Fixture_Library，也不拍摄 Review_Shot。
 *
 * ## 只按需运行
 *
 * 每个标题都带 `@selftest`。它是 `playwright.config.ts` 的按需标签：`tooling` 默认以 `grepInvert`
 * 排除，只有命令行 `-g` 的取值里写出 `@selftest` 时才收集，例如
 * `npm run e2e:profile -- --profile fixture -g '@selftest'`（PowerShell 里 `@` 开头的参数须加引号）。
 * 因此平时的 `npm run e2e` 与 `--profile fixture` 运行都不含这三个用例，不影响退出码。
 *
 * 意外通过的用例不引用任何 Finding 编号（16.7：引用的编号须在 Findings_Log 中存在），summary
 * 对它写"未引用 Finding 编号"。它测的是 reporter，不是应用缺陷，所以不按 16.2 记 Finding。
 */
import { expect, test } from "../../support/fixtures";
import { TIMEOUTS } from "../../support/settings";
import { step } from "../../support/step";

/** 每个用例打到浏览器控制台的标记前缀；核对 `console.log` 时按它查找。 */
const CONSOLE_MARK = "[selftest]";

/**
 * 永不结算的 Promise：超时用例在具名步骤内等它，使用例超时停在该步骤。不是固定时长等待（6.5），
 * 也不注册任何计时器；用例超时后 Playwright 放弃用例体，它随 worker 一起被回收。
 */
function never(): Promise<never> {
  return new Promise<never>(() => undefined);
}

test("reporter 自检：用例在具名步骤「自检超时」内超时 @selftest", async ({ page }) => {
  test.setTimeout(TIMEOUTS.reporterSelftest);
  await step("自检超时", async () => {
    await page.evaluate((mark) => console.log(`${mark} 进入「自检超时」，随后等待永不结算的 Promise`), CONSOLE_MARK);
    await never();
  });
});

test("reporter 自检：具名步骤「自检断言失败」内断言失败 @selftest", async ({ page }) => {
  await step("自检断言失败", async () => {
    await page.evaluate((mark) => console.log(`${mark} 进入「自检断言失败」，随后断言 1 + 1 === 3`), CONSOLE_MARK);
    expect(1 + 1, "reporter 自检：故意不成立的断言").toBe(3);
  });
});

test("reporter 自检：带 test.fail() 标注却通过 @selftest", async ({ page }) => {
  test.fail(true, "reporter 自检：故意意外通过（不引用 Finding 编号）");
  await step("自检意外通过", async () => {
    await page.evaluate((mark) => console.log(`${mark} 进入「自检意外通过」，随后断言 1 + 1 === 2`), CONSOLE_MARK);
    expect(1 + 1).toBe(2);
  });
});
