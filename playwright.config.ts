/**
 * Playwright 配置（设计"Playwright 配置""像素视觉回归"；需求 2.2、5.5、5.12、6.1、6.2、6.3、6.7、
 * 6.8、6.10、6.11、12.1、12.3、12.4、12.7、12.9、17.6）。
 *
 * 平时经 `e2e/run.mjs` 运行（`npm run e2e`、`npm run e2e:profile -- --profile fixture`），它把
 * `--profile` 的取值放进环境变量 `E2E_PROFILE`；直接执行 `npx playwright test` 时未设置，等同
 * `all`。常量一律取自 `e2e/support/settings.ts`。
 *
 * 只有一个 Library_Profile：fixture，`all` 与它等同。real 档已移除，测试只用合成书库
 * （test-data-desensitization 需求 4.1）。`E2E_PROFILE` 为 `real` 或其他取值时，加载本配置即由
 * `selectedProfiles()` 抛错（`run.mjs` 已先行校验，这里防直接执行 Playwright）。
 *
 * ## 项目
 *
 * 项目清单固定，不随 `E2E_PROFILE` 或命令行变化：
 *
 * | 项目 | 收集 | 实例（baseURL） | `profile`、`mode` | 依赖 |
 * | --- | --- | --- | --- | --- |
 * | `fixture` | `tests/common/`、`tests/fixture/` | :4611 | fixture、opaque | `perf` |
 * | `fixture-transparent` | `tests/fixture-transparent/` | :4612 | fixture、transparent | `perf` |
 * | `perf` | `tests/perf/` | :4611 | fixture、opaque | — |
 * | `tooling` | `tests/tooling/` | — | 不设（`null`） | `perf` |
 *
 * - 项目名与 `e2e/support/summary.ts` 的 `ProjectName` 逐字一致，定义项目时的名字都标注为
 *   `ProjectName`：reporter 按项目名归类，遇到别的名字时只写应急 Run_Summary，并以退出码 1 结束。
 * - 每个 UI 项目的 `baseURL` 由 `serverOrigin(profile, mode)` 算出，端口只来自 `PORTS`（5.12）；
 *   `target` fixture 会核对两者一致（5.5、6.11）。`perf` 与 `fixture` 共用 Opaque_Mode 的实例。
 *   模式只在项目级声明，Transparent_Mode 的用例放在单独的目录与项目里，因此每个用例收到的
 *   `.txt.gz` 响应头只由其项目决定（6.11）。
 * - `visual.spec.ts` 只在 `tests/fixture/`，只有 `fixture` 项目收集它（12.1）。
 * - `perf` 是其余全部项目（含 `tooling`）的 `dependencies`：它先于一切用例单独运行，需求 14.2 的
 *   用例不与任何其它用例并发（6.10）。它只含 `perf.spec.ts` 一个文件，不开 `fullyParallel`，3 个
 *   用例在同一 worker 里顺序执行。注意 Playwright 不把命令行的 `-g` 与文件过滤作用于依赖项目：
 *   带过滤的运行也会先完整执行 `perf`，需要时可透传 `--no-deps` 跳过（`npm run e2e:update`
 *   即如此，见 `run.mjs`）。
 *
 * ## `tooling` 与按需用例（`@audit`、`@selftest`）
 *
 * `tooling` 是无浏览器的工具测试，每次运行都有。标题带 `@audit`（R1 审计）或 `@selftest`
 * （reporter 自检，故意失败）的用例只按需运行：默认以 `grepInvert` 排除，只有命令行的 `-g` /
 * `--grep` 取值里写出了该标签时才不排除（设计："除非显式 `-g` 选中"），例如
 * `npm run e2e:profile -- --profile fixture -g '@audit'`（PowerShell 里 `@` 开头的参数须加引号）。
 *
 * 实现上有一个约束：worker 进程会重新加载本配置，并按项目名查找项目；它的 `process.argv` 里没有
 * 命令行参数。所以项目清单不取决于命令行（主进程与 worker 一致），命令行里的 `-g` 只影响 `tooling`
 * 的 `grepInvert`，而按标题过滤只在主进程进行，worker 不再使用它。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type PlaywrightTestProject } from "@playwright/test";
import type { Mode } from "./e2e/server/resolve";
import { serverOrigin, type E2EWorkerOptions } from "./e2e/support/fixtures";
import { selectedProfiles, type LibraryProfile } from "./e2e/support/library";
import { TIMEOUTS, VIEWPORTS, VISUAL, WORKERS } from "./e2e/support/settings";
import type { ProjectName } from "./e2e/support/summary";

type Project = PlaywrightTestProject<object, E2EWorkerOptions>;

const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url));
/** E2E 专用的测试目录；全部项目只在其中收集 `*.spec.ts`（2.2）。 */
const TESTS_DIR = path.join(REPO_ROOT, "e2e", "tests");
/** 运行产物目录（gitignore）。 */
const OUT_DIR = path.join(REPO_ROOT, "e2e", ".out");

/** 只按需运行的用例标签：`tooling` 默认以 `grepInvert` 排除（设计"Playwright 配置"）。 */
const ON_DEMAND_TAGS = ["@audit", "@selftest"] as const;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 只收集 `e2e/tests/<dir>/` 下（任意深度）的 `*.spec.ts`。用以绝对路径锚定的正则而不用 glob：
// Playwright 会给 glob 自动补上"任意层目录"前缀，写成 `fixture/**/*.spec.ts` 时仓库外层路径里
// 的同名目录也会命中。在 Windows 上 Playwright 另以 `/` 分隔的路径再匹配一次正则，因此这里统一
// 写 `/`，并忽略大小写（盘符）。
function specsUnder(...dirs: string[]): RegExp {
  const base = escapeRegExp(TESTS_DIR.split(path.sep).join("/"));
  const names = dirs.map(escapeRegExp).join("|");
  return new RegExp(`^${base}/(?:${names})/.+\\.spec\\.ts$`, "i");
}

/**
 * 命令行里 `-g` / `--grep` 的取值（`-g x`、`-gx`、`--grep x`、`--grep=x`）。只有主进程的 argv
 * 带这些参数（`run.mjs` 原样透传，或直接执行 `npx playwright test -g …`）；worker 重新加载本配置时
 * 取到空数组，这不影响结果（见文件头"实现上有一个约束"）。
 */
function cliGrepValues(argv: readonly string[]): string[] {
  const values: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") break;
    if (arg === "-g" || arg === "--grep") {
      if (i + 1 < argv.length) values.push(argv[++i]);
    } else if (arg.startsWith("--grep=")) {
      values.push(arg.slice("--grep=".length));
    } else if (arg.startsWith("-g") && !arg.startsWith("--")) {
      values.push(arg.slice(2));
    }
  }
  return values;
}

/** 在 `-g` 取值里被显式写出的按需标签。 */
function namedOnDemandTags(argv: readonly string[]): string[] {
  const greps = cliGrepValues(argv);
  return ON_DEMAND_TAGS.filter((tag) => greps.some((g) => g.includes(tag)));
}

function tagPattern(tags: readonly string[]): RegExp {
  return new RegExp(tags.map(escapeRegExp).join("|"));
}

function uiProject(name: ProjectName, dirs: string[], profile: LibraryProfile, mode: Mode): Project {
  return {
    name,
    testMatch: specsUnder(...dirs),
    use: { profile, mode, baseURL: serverOrigin(profile, mode) },
  };
}

/** `tooling` 项目：提供全部工具测试，命令行 `-g` 未点名的按需用例除外。 */
function toolingProject(named: readonly string[]): Project {
  const name: ProjectName = "tooling";
  const project: Project = { name, testMatch: specsUnder("tooling") };
  const excluded = ON_DEMAND_TAGS.filter((tag) => !named.includes(tag));
  if (excluded.length > 0) project.grepInvert = tagPattern(excluded);
  return project;
}

/** 全部项目，即文件头的表。`named` 只影响 `tooling` 的 `grepInvert`，项目清单本身固定。 */
function projectsFor(named: readonly string[]): Project[] {
  const projects: Project[] = [
    uiProject("fixture", ["common", "fixture"], "fixture", "opaque"),
    uiProject("fixture-transparent", ["fixture-transparent"], "fixture", "transparent"),
    // 6.10：只有 perf.spec.ts 一个文件，不开 fullyParallel，用例在同一 worker 里顺序执行
    { ...uiProject("perf", ["perf"], "fixture", "opaque"), fullyParallel: false },
    toolingProject(named),
  ];

  // 6.10：其余全部项目（含 tooling）都依赖 perf，perf 先于一切用例单独运行
  if (projects.some((p) => p.name === "perf")) {
    for (const p of projects) if (p.name !== "perf") p.dependencies = ["perf"];
  }
  return projects;
}

// 核对 E2E_PROFILE：`fixture`、`all` 与未设置都只选中 fixture，项目清单相同；`real`（已移除）与
// 其他取值在这里抛错，直接执行 `npx playwright test` 时也能看到原因（`run.mjs` 已先行校验，1.8）。
selectedProfiles(process.env.E2E_PROFILE);

export default defineConfig<object, E2EWorkerOptions>({
  testDir: TESTS_DIR,
  outputDir: path.join(OUT_DIR, "test-results"),
  globalSetup: "./e2e/support/global-setup.ts",

  // 6.10：不重试，worker 数固定
  retries: 0,
  workers: WORKERS,
  // 6.8：超时只取自 TIMEOUTS；涉及 gz ≥ 20 MB 的用例自行 test.setTimeout(TIMEOUTS.bigBookTest)
  timeout: TIMEOUTS.test,
  expect: {
    timeout: TIMEOUTS.wait,
    // 12.3、12.4、12.9：全部 Pixel_Baseline 共用这一组设置；容差只取自 VISUAL，单张基线不传容差，
    // 也不设 maxDiffPixels。视口截图、CSS 像素、隐藏插入符，screenshot.css 兜底隐藏滚动条；
    // 基线文件为 e2e/baselines/<name>-<process.platform>.png（6.7，与 e2e/visual/naming.ts 的
    // baselineFile 等价）。相对路径均按本文件所在目录解析
    toHaveScreenshot: {
      threshold: VISUAL.threshold,
      maxDiffPixelRatio: VISUAL.maxDiffPixelRatio,
      animations: "disabled",
      caret: "hide",
      scale: "css",
      stylePath: "e2e/visual/screenshot.css",
      pathTemplate: `${VISUAL.baselineDir}/{arg}-{platform}{ext}`,
    },
  },
  // 12.7：只有 `npm run e2e:update` 经 run.mjs 追加 --update-snapshots=changed
  updateSnapshots: "none",

  // 17.6：每次运行都生成 HTML 报告，从不自动打开浏览器。自定义 reporter（Run_Summary、
  // Review_Report、结束快照）必须排在 html 之后：它的 onEnd 核对 HTML 报告是否已写出（17.4）
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: path.join(OUT_DIR, "report") }],
    ["./e2e/support/reporter.ts"],
  ],

  use: {
    // K6：完整 Chromium 的新 headless 模式
    channel: "chromium",
    // 6.2：桌面视口为默认，设备像素比 1，不启用触屏与移动端仿真；locale、时区与配色固定
    viewport: VIEWPORTS.desktop,
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    colorScheme: "light",
    // 6.3：prefers-reduced-motion: reduce。它不是 Playwright 的具名 `use` 选项，只能经
    // contextOptions 传给浏览器上下文；11.5 的用例以 `test.use({ contextOptions: { reducedMotion:
    // "no-preference" } })` 覆盖（contextOptions 整体替换，不与这里合并）
    contextOptions: { reducedMotion: "reduce" },
    serviceWorkers: "block",
    // 6.8：单次等待可观测条件（动作的可操作性等待、导航）的上限
    actionTimeout: TIMEOUTS.wait,
    navigationTimeout: TIMEOUTS.wait,
    // 17.2：只为失败、超时与意外通过的用例保留 trace 与截图
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  projects: projectsFor(namedOnDemandTags(process.argv)),
});
