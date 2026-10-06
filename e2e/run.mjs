/**
 * E2E 启动器（设计 K1 与"npm 脚本"一节；需求 1.2、1.3、1.5、1.8、12.7、12.8）。
 *
 * Playwright CLI 不接受自定义参数，所以 profile 的校验放在它之前完成；package.json
 * 里也就不必出现 `VAR=value`。本文件只做三件事：
 *   1. 校验 `--profile`（只有 fixture；`all` 只供 `npm run e2e`，等同 fixture）与 `--update`，
 *      不合法时退出码 2。real 档已移除，测试只用合成书库（test-data-desensitization）：
 *      `--profile real` 同样以退出码 2 结束，并说明这一点；
 *   2. 检查与所装 @playwright/test 版本对应的 Chromium，缺失时仍转调 Playwright，
 *      但带上 `E2E_ABORT=chromium-missing`（globalSetup 取完开始快照即中止，reporter
 *      写中止版 Run_Summary），随后以退出码 3 结束；
 *   3. 以 `process.execPath` 执行 Playwright CLI 的 `test`，其余参数原样透传，
 *      `E2E_PROFILE` 放进子进程环境变量，返回子进程的退出码。
 *
 * 用法：
 *   npm run e2e                                  # --profile all，等同 fixture
 *   npm run e2e:profile -- --profile fixture     # 可再附 --list、-g 等 Playwright 参数
 *   npm run e2e:update                           # --profile fixture --update，唯一写基线的入口
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/** `--profile` 可接受的取值（1.8）。只有 fixture：real 档已移除（test-data-desensitization）。 */
const PROFILES = ["fixture"];
/** 仅 `npm run e2e` 使用的取值（1.2 (a)）。只有一个 profile，它等同 fixture。 */
const PROFILE_ALL = "all";
/** 已移除的 profile：给出时以退出码 2 结束，并说明原因（test-data-desensitization 需求 4.1）。 */
const REMOVED_PROFILE = "real";
const REMOVED_PROFILE_MESSAGE = "real 档已移除：测试只用合成书库（test-data-desensitization）。";
const INSTALL_COMMAND = "npm run e2e:install";
const UPDATE_COMMAND = "npm run e2e:update";

const EXIT_USAGE = 2;
const EXIT_CHROMIUM_MISSING = 3;

/** `--update` 时追加的参数（12.8）：只跑 fixture 项目的 visual.spec，只写缺失或超容差的基线。
 *  `--project` 在 Playwright CLI 中是可变参数，写成 `--project=fixture` 才不会把随后的
 *  `visual.spec` 当作第二个项目名。`--no-deps` 不跑依赖项目 `perf`：Playwright 不把文件过滤
 *  作用于依赖项目，不加它时每次更新基线都要先完整跑一遍性能用例（见 `playwright.config.ts`）。 */
const UPDATE_ARGS = ["--project=fixture", "--no-deps", "visual.spec", "--update-snapshots=changed"];

/** 用户自带的快照更新参数：`-u`（含 `-u…` 组合）与 `--update-snapshots[=…]`（12.7）。 */
const SNAPSHOT_FLAG = /^-u|^--update-snapshots(=|$)/;

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const requireHere = createRequire(import.meta.url);

function fail(lines) {
  for (const line of lines) console.error(`[e2e] ${line}`);
  process.exit(EXIT_USAGE);
}

function profileError(message) {
  fail([
    message,
    `--profile 可接受的取值：${PROFILES.join("、")}`,
    "用法：npm run e2e:profile -- --profile fixture",
  ]);
}

/**
 * 从命令行中取出 `--profile` 与 `--update`，其余参数原样保留（`--` 之后的部分不解析）。
 * @param {string[]} argv
 */
function parseArgs(argv) {
  /** @type {string[]} */
  const profiles = [];
  /** @type {string[]} */
  const passthrough = [];
  /** @type {string[]} */
  const tail = [];
  let update = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      tail.push(...argv.slice(i));
      break;
    }
    if (arg === "--profile") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) profileError("--profile 缺少取值。");
      profiles.push(value);
      i++;
      continue;
    }
    if (arg.startsWith("--profile=")) {
      profiles.push(arg.slice("--profile=".length));
      continue;
    }
    if (arg === "--update") {
      update = true;
      continue;
    }
    if (SNAPSHOT_FLAG.test(arg)) {
      fail([
        `不接受参数 ${arg}：基线只由 ${UPDATE_COMMAND} 写入，其余入口一律 updateSnapshots: "none"。`,
      ]);
    }
    passthrough.push(arg);
  }
  return { profiles, update, passthrough, tail };
}

function validateProfile(profiles) {
  if (profiles.length === 0) profileError("缺少 --profile。");
  if (profiles.length > 1) {
    profileError(`--profile 只能给出一次，收到：${profiles.join("、")}。`);
  }
  const [profile] = profiles;
  if (PROFILES.includes(profile)) return profile;
  if (profile === REMOVED_PROFILE) return profileError(REMOVED_PROFILE_MESSAGE);
  // `all` 由 `npm run e2e` 固定传入；经 e2e:profile 给出时按非法取值处理（1.8）。
  if (profile === PROFILE_ALL && process.env.npm_lifecycle_event !== "e2e:profile") {
    return profile;
  }
  return profileError(`无效的 --profile 取值：${profile}。`);
}

/** 与所装 @playwright/test 版本对应的 Chromium 是否已在本机缓存中（1.5）。 */
async function findChromium() {
  const { version } = requireHere("@playwright/test/package.json");
  const { chromium } = await import("@playwright/test");
  let executable;
  try {
    executable = chromium.executablePath();
  } catch {
    executable = "";
  }
  return { version, executable, present: executable !== "" && existsSync(executable) };
}

async function main() {
  const { profiles, update, passthrough, tail } = parseArgs(process.argv.slice(2));
  const profile = validateProfile(profiles);
  if (update && profile !== "fixture") {
    fail([
      `--update 只能与 --profile fixture 同用（收到 --profile ${profile}）。`,
      `更新 Pixel_Baseline 请执行：${UPDATE_COMMAND}`,
    ]);
  }

  const chromium = await findChromium();
  const env = { ...process.env, E2E_PROFILE: profile };
  delete env.E2E_ABORT;
  if (!chromium.present) {
    env.E2E_ABORT = "chromium-missing";
    console.error(
      `[e2e] 未找到 @playwright/test ${chromium.version} 对应的 Chromium` +
        (chromium.executable ? `（${chromium.executable}）` : "") +
        "。不会执行任何用例。",
    );
    console.error(`[e2e] 请先执行：${INSTALL_COMMAND}`);
  }

  const cli = requireHere.resolve("@playwright/test/cli");
  const args = [cli, "test", ...passthrough, ...(update ? UPDATE_ARGS : []), ...tail];

  // Ctrl+C 同时送达子进程；启动器自己不退出，等 Playwright 收尾（teardown、写 Run_Summary）。
  process.on("SIGINT", () => {});

  const child = spawn(process.execPath, args, { cwd: repoRoot, env, stdio: "inherit" });
  child.on("error", (error) => {
    console.error(`[e2e] 无法启动 Playwright：${error.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (!chromium.present) {
      console.error(`[e2e] 运行已在"浏览器检查"阶段中止。请先执行：${INSTALL_COMMAND}`);
      process.exit(EXIT_CHROMIUM_MISSING);
    }
    if (code === null) {
      console.error(`[e2e] Playwright 被信号 ${signal} 终止。`);
      process.exit(1);
    }
    process.exit(code);
  });
}

await main();
