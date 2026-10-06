/**
 * App_Build（设计"build-app.ts（5.1）"与 globalSetup 第 3 步；需求 4.6、5.1、5.11）。
 *
 * `buildApp()` 以 Vite JS API 基于当前 `src/` 构建到 `e2e/.out/app/`：
 *
 * - 插件与选项取自 `vite.config.ts`（经 `loadConfigFromFile` 在运行时读入，不静态 `import`：
 *   静态导入会把它拉进 `npm run typecheck`，而它用到的 `new Error(msg, { cause })` 需要
 *   ES2022 的 lib）。与 `npm run build` 只差两项：输出目录，以及去掉 `link-assets` 插件
 *   （书库接入）。`copyPublicDir: false` 照旧，所以 `public/` 既不复制也不硬链接进产物；
 *   `site-config` 插件照常 `emitFile` favicon，读 `public/` 时只读。`vite.config.ts` 本身不改。
 * - 构建前先删除整个输出目录（5.1 的"先清空"），构建失败时也不会留下上一次的产物。
 *
 * `validateAppBuild()` 校验产物满足 5.1 与 4.6，返回违规清单（空数组即通过）：
 *
 * - 顶层没有 `books`、`data`（不区分大小写：Windows 上 `Books/` 与 `books/` 是同一个目录）；
 * - 顶层没有 `404.html`（不区分大小写，判定复用 `build/linkAssets.ts` 的 `findForbiddenOutputs`）；
 * - 没有任何文件与 `public/` 下的文件互为硬链接（同卷且文件编号相同）。
 *
 * 硬链接的判定分两步，正常情况下不遍历 `public/`：
 *
 * 1. 遍历产物（几十个文件），对每个文件取 `lstat(p, { bigint: true })`。链接数为 1 的文件只有
 *    产物里这一个目录项，不可能与 `public/` 下的任何文件是同一个文件，直接排除。Vite 写出的
 *    文件都是新建的，正常产物里没有链接数大于 1 的文件。
 * 2. 只有存在链接数不为 1 的文件时，才遍历 `public/`（约 2.3 万个文件，只取元数据、不读内容），
 *    以 `dev`（卷序列号）与 `ino`（64 位文件编号，用 bigint 避免截断）比对。文件系统不提供
 *    文件编号（`ino` 为 0）时无法判定，按违规报告。
 *
 * 违规项的字段与 `abort.json` 的 `checks` 相同（名称、路径、期望值、实际值），globalSetup
 * 可原样写入并由 Run_Summary 逐项列出（5.11、17.7）。
 */
import type { Dir } from "node:fs";
import { lstat, opendir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, loadConfigFromFile, type Plugin, type PluginOption } from "vite";
import { findForbiddenOutputs } from "../../build/linkAssets";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const PUBLIC_DIR = path.join(REPO_ROOT, "public");
const VITE_CONFIG = path.join(REPO_ROOT, "vite.config.ts");

/** App_Build 的输出目录：在被 gitignore 的 `e2e/.out/` 内，与 `dist/`、`public/` 都不重叠（5.1）。 */
export const APP_BUILD_DIR = path.join(REPO_ROOT, "e2e", ".out", "app");

/** 从 `vite.config.ts` 的插件中去掉的书库接入插件（`build/linkAssets.ts` 的 `name`）。 */
const LINK_ASSETS_PLUGIN = "link-assets";

/** 产物顶层不得出现的书库目录名（比较时统一小写）。 */
const LIBRARY_DIR_NAMES: readonly string[] = ["books", "data"];

/** 一次构建的结果。 */
export interface AppBuild {
  /** 产物目录的绝对路径，即 `APP_BUILD_DIR`，作为 E2E_Server 的 `appRoot`。 */
  readonly outDir: string;
  /** 实际参与构建的插件名，按执行顺序（不含 `link-assets`）。 */
  readonly plugins: readonly string[];
  /** 读取配置、清空目录与构建的总耗时（毫秒）。 */
  readonly ms: number;
}

/** 一项违规，字段与 `abort.json` 的 `checks` 一致（5.11）。 */
export interface AppBuildViolation {
  /** 检查项名称。 */
  readonly name: string;
  /** 违规的文件或目录：相对仓库根、以 `/` 分隔；不在仓库内时为绝对路径。 */
  readonly path: string;
  readonly expected: string;
  readonly actual: string;
}

/** 产物违反 5.1 的约束。globalSetup 以阶段"产物校验"中止，`violations` 即 `abort.json` 的 `checks`。 */
export class AppBuildInvalidError extends Error {
  readonly violations: readonly AppBuildViolation[];

  constructor(violations: readonly AppBuildViolation[]) {
    const lines = violations.map(
      (v) => `  - ${v.name}：${v.path}（期望：${v.expected}；实际：${v.actual}）`,
    );
    super(`App_Build 违反需求 5.1 的约束（${violations.length} 项）：\n${lines.join("\n")}`);
    this.name = "AppBuildInvalidError";
    this.violations = violations;
  }
}

/**
 * 清空 `APP_BUILD_DIR` 并基于当前 `src/` 构建 App_Build。
 *
 * 构建失败时原样抛出 Vite 的错误（globalSetup 以阶段"App_Build 构建"中止）。本函数不做产物
 * 校验，调用方随后调用 `validateAppBuild()`。
 */
export async function buildApp(): Promise<AppBuild> {
  const started = performance.now();
  const configEnv = { command: "build", mode: "production" } as const;
  const loaded = await loadConfigFromFile(configEnv, VITE_CONFIG, REPO_ROOT);
  if (loaded === null) {
    throw new Error(`无法读取 ${VITE_CONFIG}`);
  }
  const { config } = loaded;
  const plugins = (await flattenPlugins(config.plugins ?? [])).filter(
    (plugin) => plugin.name !== LINK_ASSETS_PLUGIN,
  );

  await rm(APP_BUILD_DIR, { recursive: true, force: true });

  // 未设置 NODE_ENV 时 Vite 会把它设为 production 并留在当前进程；构建后复原，
  // 使 Playwright 运行进程及其派生的 worker 的环境与构建前相同。
  const nodeEnv = process.env.NODE_ENV;
  try {
    await build({
      ...config,
      configFile: false,
      // `npm run build` 在仓库根执行，root 即仓库根；这里显式给出，不依赖当前工作目录。
      root: config.root ? path.resolve(REPO_ROOT, config.root) : REPO_ROOT,
      mode: configEnv.mode,
      plugins,
      logLevel: "warn",
      build: { ...config.build, outDir: APP_BUILD_DIR, emptyOutDir: true, copyPublicDir: false },
    });
  } finally {
    if (nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnv;
  }

  return {
    outDir: APP_BUILD_DIR,
    plugins: plugins.map((plugin) => plugin.name),
    ms: Math.round(performance.now() - started),
  };
}

/**
 * 校验 App_Build 满足 5.1 与 4.6，返回违规清单（按检查项、路径排序；空数组即通过）。
 *
 * `outDir` 不存在或不可读时抛出文件系统错误；`publicDir` 不存在时视为空目录（干净 clone
 * 上可能没有书库）。两个参数只为测试可替换，globalSetup 用默认值。
 */
export async function validateAppBuild(
  outDir: string = APP_BUILD_DIR,
  publicDir: string = PUBLIC_DIR,
): Promise<AppBuildViolation[]> {
  const violations: AppBuildViolation[] = [];
  const top = await readdir(outDir, { withFileTypes: true });

  for (const entry of top) {
    const lower = entry.name.toLowerCase();
    if (LIBRARY_DIR_NAMES.includes(lower)) {
      violations.push({
        name: `产物中没有 ${lower}/`,
        path: displayPath(path.join(outDir, entry.name)),
        expected: "不存在",
        actual: `存在（${entry.isDirectory() ? "目录" : "非目录"}）`,
      });
    }
  }

  for (const name of findForbiddenOutputs(top.map((entry) => entry.name))) {
    violations.push({
      name: "产物顶层没有 404.html（不区分大小写）",
      path: displayPath(path.join(outDir, name)),
      expected: "不存在",
      actual: "存在",
    });
  }

  violations.push(...(await findPublicHardLinks(outDir, publicDir)));
  return violations;
}

/** 产物中与 `publicDir` 下的文件互为硬链接的文件，以及无法判定的文件。 */
async function findPublicHardLinks(
  outDir: string,
  publicDir: string,
): Promise<AppBuildViolation[]> {
  const name = "产物中没有与 public/ 互为硬链接的文件";
  const expected = "与 public/ 下的任何文件都不是同一文件";
  const violations: AppBuildViolation[] = [];

  /** `dev:ino` → 产物中链接数不为 1 的文件（绝对路径）。 */
  const candidates = new Map<string, string[]>();
  for await (const file of walkFiles(outDir)) {
    const st = await lstat(file, { bigint: true });
    if (st.nlink === 1n) continue;
    if (st.ino === 0n) {
      violations.push({
        name,
        path: displayPath(file),
        expected,
        actual: `文件系统未提供文件编号，无法判定（链接数 ${st.nlink}）`,
      });
      continue;
    }
    const key = `${st.dev}:${st.ino}`;
    const files = candidates.get(key);
    if (files) files.push(file);
    else candidates.set(key, [file]);
  }

  if (candidates.size > 0) {
    for await (const file of walkFiles(publicDir, { missingOk: true })) {
      const st = await lstat(file, { bigint: true });
      const outs = candidates.get(`${st.dev}:${st.ino}`);
      if (!outs) continue;
      for (const out of outs) {
        violations.push({
          name,
          path: displayPath(out),
          expected,
          actual: `与 ${displayPath(file)} 是同一文件（卷 ${st.dev}，文件编号 ${st.ino}）`,
        });
      }
    }
  }

  return violations.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * 递归列出 `root` 下的全部非目录条目（文件与符号链接），不跟随符号链接。
 * `missingOk` 时根目录不存在即视为空。
 */
async function* walkFiles(
  root: string,
  options: { missingOk?: boolean } = {},
): AsyncGenerator<string> {
  let dir: Dir;
  try {
    dir = await opendir(root);
  } catch (error) {
    if (options.missingOk && isErrno(error, "ENOENT")) return;
    throw error;
  }
  const subdirs: string[] = [];
  for await (const entry of dir) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) subdirs.push(full);
    else yield full;
  }
  for (const sub of subdirs) {
    yield* walkFiles(sub);
  }
}

/** 展开 `vite.config.ts` 的插件列表：等待 Promise、拍平嵌套数组、去掉假值（同 Vite 自身的处理）。 */
async function flattenPlugins(options: readonly PluginOption[]): Promise<Plugin[]> {
  const plugins: Plugin[] = [];
  for (const option of options) {
    const resolved = await option;
    if (!resolved) continue;
    if (Array.isArray(resolved)) plugins.push(...(await flattenPlugins(resolved)));
    else plugins.push(resolved);
  }
  return plugins;
}

/** 相对仓库根、以 `/` 分隔的路径；不在仓库内时返回绝对路径。 */
function displayPath(abs: string): string {
  const rel = path.relative(REPO_ROOT, abs);
  if (rel === "" || path.isAbsolute(rel) || rel.split(path.sep)[0] === "..") return abs;
  return rel.split(path.sep).join("/");
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === code
  );
}
