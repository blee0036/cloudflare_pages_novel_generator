/**
 * 基线清单、容差与新增依赖的核对（`tooling` 项目，无浏览器；任务 18.9，设计 Testing Strategy 的
 * `baseline-catalog` 一行）。只读取文件，不写入、不删除，`e2e/baselines/` 的列表、大小与 mtime 不变
 * （12.7、18.10）。
 *
 * - 12.2：`REQUIRED_BASELINE_NAMES` 都定义在 `BASELINES` 中；`BASELINES` 的名称与
 *   `e2e/baselines/` 中的 PNG 一一对应。目录里的每一项都须是本机平台（`process.platform`）的
 *   `<名称>-<平台>.png`，名称属于 `BASELINES`，不留多余文件。只看 `parseBaselineFile` 是否为 null
 *   不够：缺平台段的 `px-shelf-desktop.png` 会被解析成名称 `px-shelf`、平台 `desktop`，所以另比对平台
 *   与名称（`visual-naming.spec.ts` 的最后一个例子）。
 * - 12.4：两值只在 `e2e/support/settings.ts` 的 `VISUAL` 中写一次；`playwright.config.ts` 的
 *   `expect.toHaveScreenshot` 取自 `VISUAL`，各项目不覆盖 `expect`；`BaselineDef` 与遮罩没有容差字段；
 *   E2E 源码中不设 `maxDiffPixels`，用例与基线定义中不传容差（源码扫描）。
 * - 1.1：设计 K5 与"无障碍冒烟"一节列出的 3 个新增包在 `devDependencies` 中以三段纯数字的精确版本
 *   声明，与 `package-lock.json` 根项的声明及 `node_modules/<包>` 解析出的版本相同。"已有条目不变"
 *   要与基准提交比较，由验收脚本的 `package_json_problems` 核对（16.5），这里不依赖 git 历史，
 *   以免今后正常的依赖升级让本文件误报。
 *
 * 本文件自身也在源码扫描范围内（`e2e/tests/`），所以正文与注释里都不在容差键名后紧接 ASCII 冒号。
 */
import { expect, test } from "@playwright/test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import config from "../../../playwright.config";
import { VISUAL } from "../../support/settings";
import { BASELINES, REQUIRED_BASELINE_NAMES, type BaselineDef, type MaskDef } from "../../visual/baselines";
import { BASELINE_NAME_PATTERN, UPDATE_COMMAND, baselineFile, parseBaselineFile } from "../../visual/naming";

/** 仓库根（本文件位于 `e2e/tests/tooling/`）。 */
const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));

/** repo 相对路径（`/` 分隔）→ 绝对路径。 */
function abs(relative: string): string {
  return path.join(REPO_ROOT, ...relative.split("/"));
}

// ---------------------------------------------------------------------------
// 12.2：名称清单 ↔ e2e/baselines/
// ---------------------------------------------------------------------------

/** 目录中的一项。 */
interface DirEntry {
  readonly name: string;
  readonly isFile: boolean;
}

/** PNG 文件签名（前 8 字节）。 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * 12.2 的一一对应，返回问题清单（空即通过）：
 *
 * - `defined`（`BASELINES` 的名称）都符合命名格式且不重复，`required`（12.2 的清单）都在其中；
 * - 目录中每一项都是文件，文件名能被 `parseBaselineFile` 解析，平台等于 `platform`，名称属于
 *   `defined`；否则是多余文件；
 * - `defined` 的每个名称恰好对应一个文件。`baselineFile` 是单射（属性 5），同名同平台只有一个文件名，
 *   所以"多于一个"不会出现；这里按"恰好一个"的原意计数。
 */
function catalogProblems(
  defined: readonly string[],
  required: readonly string[],
  entries: readonly DirEntry[],
  platform: string,
): string[] {
  const problems: string[] = [];
  const definedSet = new Set<string>();
  for (const name of defined) {
    if (!BASELINE_NAME_PATTERN.test(name)) {
      problems.push(`BASELINES 中的名称 ${name} 不符合 ${BASELINE_NAME_PATTERN.source}`);
    }
    if (definedSet.has(name)) problems.push(`BASELINES 中的名称 ${name} 重复`);
    definedSet.add(name);
  }
  for (const name of required) {
    if (!definedSet.has(name)) problems.push(`12.2 的名称 ${name} 没有定义在 BASELINES 中`);
  }

  const filesOf = new Map<string, string[]>();
  for (const entry of entries) {
    const where = `${VISUAL.baselineDir}/${entry.name}`;
    if (!entry.isFile) {
      problems.push(`多余的项 ${where}：不是文件`);
      continue;
    }
    const parsed = parseBaselineFile(entry.name);
    if (parsed === null) {
      problems.push(`多余的文件 ${where}：不是 <名称>-<平台>.png 形式的基线文件名`);
      continue;
    }
    if (parsed.platform !== platform) {
      problems.push(
        `多余的文件 ${where}：按最后一个 - 切分得名称 ${parsed.name}、平台 ${parsed.platform}，平台不是本机的 ${platform}`,
      );
      continue;
    }
    if (!definedSet.has(parsed.name)) {
      problems.push(`多余的文件 ${where}：名称 ${parsed.name} 没有定义在 BASELINES 中`);
      continue;
    }
    filesOf.set(parsed.name, [...(filesOf.get(parsed.name) ?? []), entry.name]);
  }

  for (const name of definedSet) {
    if (!BASELINE_NAME_PATTERN.test(name)) continue; // 已报告；baselineFile 会对它抛错
    const files = filesOf.get(name) ?? [];
    if (files.length === 0) {
      problems.push(`缺少 ${VISUAL.baselineDir}/${baselineFile(name, platform)}（基线 ${name}）`);
    } else if (files.length > 1) {
      problems.push(`基线 ${name} 对应 ${files.length} 个文件：${files.join("、")}`);
    }
  }
  return problems;
}

test.describe("12.2 名称清单与 e2e/baselines/ 一一对应", () => {
  test("12.2 BASELINES 含 12.2 的全部名称；e2e/baselines/ 中恰有每个名称的一个本机平台 PNG，无多余项", () => {
    const dir = abs(VISUAL.baselineDir);
    expect(existsSync(dir), `缺少基线目录 ${VISUAL.baselineDir}/；运行 ${UPDATE_COMMAND} 生成`).toBe(true);

    const entries: DirEntry[] = readdirSync(dir, { withFileTypes: true }).map((d) => ({
      name: d.name,
      isFile: d.isFile(),
    }));
    const defined = BASELINES.map((d) => d.name);
    expect(catalogProblems(defined, REQUIRED_BASELINE_NAMES, entries, process.platform)).toEqual([]);

    for (const name of defined) {
      const file = `${VISUAL.baselineDir}/${baselineFile(name, process.platform)}`;
      const bytes = readFileSync(abs(file));
      expect(bytes.length, `${file} 的字节数`).toBeGreaterThan(PNG_SIGNATURE.length);
      expect(bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE), `${file} 应以 PNG 签名开头`).toBe(true);
    }
  });

  test("目录核对的判定：缺文件、缺平台段、他平台、未定义的名称、无法识别的文件名与子目录都报出", () => {
    const defined = ["px-shelf-desktop", "px-reader-dark"];
    const complete: DirEntry[] = [
      { name: "px-shelf-desktop-win32.png", isFile: true },
      { name: "px-reader-dark-win32.png", isFile: true },
    ];
    expect(catalogProblems(defined, defined, complete, "win32")).toEqual([]);

    const extras: { entry: DirEntry; mention: string }[] = [
      // 缺平台段：解析成名称 px-shelf、平台 desktop，不能因能解析就放过
      { entry: { name: "px-shelf-desktop.png", isFile: true }, mention: "平台 desktop，平台不是本机的 win32" },
      { entry: { name: "px-shelf-desktop-linux.png", isFile: true }, mention: "平台 linux，平台不是本机的 win32" },
      { entry: { name: "px-toc-volumes-win32.png", isFile: true }, mention: "名称 px-toc-volumes 没有定义在 BASELINES 中" },
      { entry: { name: "px-shelf-desktop-win32.PNG", isFile: true }, mention: "不是 <名称>-<平台>.png" },
      { entry: { name: "Px-shelf-desktop-win32.png", isFile: true }, mention: "不是 <名称>-<平台>.png" },
      { entry: { name: ".gitkeep", isFile: true }, mention: "不是 <名称>-<平台>.png" },
      { entry: { name: "px-shelf-desktop-win32.png", isFile: false }, mention: "不是文件" },
    ];
    for (const { entry, mention } of extras) {
      const entries = entry.isFile ? [...complete, entry] : [complete[1], entry];
      const problems = catalogProblems(defined, defined, entries, "win32");
      const expected = entry.isFile ? 1 : 2; // 子目录顶替了文件时，另报缺少该文件
      expect(problems, JSON.stringify(entry)).toHaveLength(expected);
      expect(problems[0], JSON.stringify(entry)).toContain(mention);
      expect(problems[0], JSON.stringify(entry)).toContain(`${VISUAL.baselineDir}/${entry.name}`);
    }

    expect(catalogProblems(defined, defined, [complete[0]], "win32")).toEqual([
      `缺少 ${VISUAL.baselineDir}/px-reader-dark-win32.png（基线 px-reader-dark）`,
    ]);
    // 目录里只有他平台的基线：本机平台的每个名称都缺
    expect(catalogProblems(defined, defined, complete, "linux")).toHaveLength(2 + defined.length);
    expect(catalogProblems(["px-shelf-desktop"], defined, [complete[0]], "win32")).toEqual([
      "12.2 的名称 px-reader-dark 没有定义在 BASELINES 中",
    ]);
    expect(catalogProblems([...defined, "px-shelf-desktop"], defined, complete, "win32")).toEqual([
      "BASELINES 中的名称 px-shelf-desktop 重复",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 12.4：容差只在 VISUAL
// ---------------------------------------------------------------------------

const TOLERANCE_KEYS = ["threshold", "maxDiffPixelRatio", "maxDiffPixels"] as const;
type ToleranceKey = (typeof TOLERANCE_KEYS)[number];

/**
 * 对象键或类型成员位置上的容差键：键名、可选的 `?`、ASCII 冒号，捕获其后到 `,`、`;`、`}` 或行尾的值。
 * 以键名数组拼出，本文件的源码因此不含这种写法。
 */
const TOLERANCE_KEY_PATTERN = new RegExp(`\\b(${TOLERANCE_KEYS.join("|")})\\s*\\??\\s*:\\s*([^,;}\\r\\n]*)`, "g");

/** 容差的唯一定义处。 */
const DEFINITION_FILE = "e2e/support/settings.ts";
const CONFIG_FILE = "playwright.config.ts";
const VISUAL_SPEC = "e2e/tests/fixture/visual.spec.ts";
const BASELINES_FILE = "e2e/visual/baselines.ts";

/** 扫描时跳过的目录（运行产物与 Python 缓存）与要扫描的扩展名。 */
const SCAN_SKIP_DIRS = new Set([".out", "node_modules", "__pycache__"]);
const SCAN_EXTS = new Set([".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"]);

interface ToleranceHit {
  readonly file: string;
  readonly line: number;
  readonly key: ToleranceKey;
  readonly value: string;
}

/** `dirRelative` 下（递归）全部源码文件的 repo 相对路径，按码元序。 */
function sourceFiles(dirRelative: string): string[] {
  const out: string[] = [];
  const walk = (relative: string): void => {
    for (const d of readdirSync(abs(relative), { withFileTypes: true })) {
      const child = `${relative}/${d.name}`;
      if (d.isDirectory()) {
        if (!SCAN_SKIP_DIRS.has(d.name)) walk(child);
      } else if (d.isFile() && SCAN_EXTS.has(path.extname(d.name))) {
        out.push(child);
      }
    }
  };
  walk(dirRelative);
  return out.sort();
}

function toleranceHits(file: string): ToleranceHit[] {
  const text = readFileSync(abs(file), "utf8");
  const hits: ToleranceHit[] = [];
  for (const m of text.matchAll(TOLERANCE_KEY_PATTERN)) {
    const line = text.slice(0, m.index ?? 0).split("\n").length;
    hits.push({ file, line, key: m[1] as ToleranceKey, value: m[2].trim() });
  }
  return hits;
}

/** 用例与基线定义：不传任何容差（"单张基线不传容差"）。 */
function isPerBaselineSource(file: string): boolean {
  return file.startsWith("e2e/tests/") || file === BASELINES_FILE;
}

/** 定义处以外的一处容差键是否违规；合规时为 null。 */
function toleranceViolation(hit: ToleranceHit): string | null {
  if (hit.key === "maxDiffPixels") return "不设 maxDiffPixels";
  if (isPerBaselineSource(hit.file)) return "用例与基线定义中不传容差，全部取自 playwright.config.ts";
  // 取自 VISUAL 的同名项（配置与 Run_Summary），或只是类型标注
  if (hit.value === `VISUAL.${hit.key}` || hit.value === "number") return null;
  return `值应取自 VISUAL.${hit.key}`;
}

/** `BaselineDef` 与 `MaskDef` 的全部字段（均无容差字段）。 */
const BASELINE_DEF_KEYS = [
  "name",
  "viewport",
  "theme",
  "role",
  "bookId",
  "url",
  "chapter",
  "keyword",
  "state",
  "prepare",
  "cleanup",
  "masks",
  "knownDefects",
] as const satisfies readonly (keyof BaselineDef)[];
const MASK_DEF_KEYS = ["locate", "reason"] as const satisfies readonly (keyof MaskDef)[];

test.describe("12.4 全部 Pixel_Baseline 共用一组容差，只在 VISUAL 配置", () => {
  test("12.4 VISUAL 的 threshold 为 0.1、maxDiffPixelRatio 为 0.001，没有 maxDiffPixels", () => {
    expect(VISUAL.threshold).toBe(0.1);
    expect(VISUAL.maxDiffPixelRatio).toBe(0.001);
    expect(Object.keys(VISUAL)).not.toContain("maxDiffPixels");
  });

  test("12.4 playwright.config.ts 的 expect.toHaveScreenshot 取 VISUAL 的两值、不设 maxDiffPixels；各项目不覆盖 expect", () => {
    const shot = config.expect?.toHaveScreenshot;
    expect(shot, "playwright.config.ts 应设置 expect.toHaveScreenshot").toBeDefined();
    expect(shot?.threshold).toBe(VISUAL.threshold);
    expect(shot?.maxDiffPixelRatio).toBe(VISUAL.maxDiffPixelRatio);
    expect(shot).not.toHaveProperty("maxDiffPixels");

    const projects = config.projects ?? [];
    expect(projects.map((p) => p.name)).toContain("fixture"); // visual.spec.ts 所在的项目
    for (const p of projects) expect(p.expect, `项目 ${p.name} 不应覆盖 expect`).toBeUndefined();
  });

  test("12.4 BaselineDef 与遮罩只有设计给出的字段，没有容差字段", () => {
    const defKeys = new Set<string>(BASELINE_DEF_KEYS);
    const maskKeys = new Set<string>(MASK_DEF_KEYS);
    for (const def of BASELINES) {
      expect(Object.keys(def).filter((k) => !defKeys.has(k)), def.name).toEqual([]);
      for (const mask of def.masks) {
        expect(Object.keys(mask).filter((k) => !maskKeys.has(k)), `${def.name} 的遮罩`).toEqual([]);
      }
    }
  });

  test("12.4 源码扫描：两值只在 settings.ts 写一次，配置取自 VISUAL，用例与基线定义不传容差，任何地方都不设 maxDiffPixels", () => {
    const files = [CONFIG_FILE, ...sourceFiles("e2e")];
    expect(files).toEqual(expect.arrayContaining([DEFINITION_FILE, VISUAL_SPEC, BASELINES_FILE]));
    const hits = files.flatMap(toleranceHits);
    const brief = (h: ToleranceHit): string => `${h.key}=${h.value}`;

    // 定义处恰各一次；配置处恰取自 VISUAL 各一次（同时说明扫描确实能匹配到这种写法）
    expect(hits.filter((h) => h.file === DEFINITION_FILE).map(brief)).toEqual([
      "threshold=0.1",
      "maxDiffPixelRatio=0.001",
    ]);
    expect(hits.filter((h) => h.file === CONFIG_FILE).map(brief)).toEqual([
      "threshold=VISUAL.threshold",
      "maxDiffPixelRatio=VISUAL.maxDiffPixelRatio",
    ]);

    const violations = hits
      .filter((h) => h.file !== DEFINITION_FILE)
      .flatMap((h) => {
        const why = toleranceViolation(h);
        return why === null ? [] : [`${h.file}:${h.line} ${brief(h)}（${why}）`];
      });
    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 1.1：新增依赖为精确版本且与 lockfile 一致
// ---------------------------------------------------------------------------

/** 本 spec 新增的 npm 包（设计 K5：`@playwright/test`、`fast-check`；"无障碍冒烟"：`@axe-core/playwright`）。 */
const NEW_DEV_DEPENDENCIES = ["@axe-core/playwright", "@playwright/test", "fast-check"] as const;

/** 设计 K5 定下的 fast-check 版本。 */
const FAST_CHECK_VERSION = "3.23.2";

/** `主.次.修订` 三段纯数字（不带 `^`、`~`、`*`、`x`、`latest`、范围运算符或预发布后缀）。 */
const EXACT_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

type DependencyMap = Readonly<Record<string, string>>;

interface PackageJson {
  readonly dependencies?: DependencyMap;
  readonly devDependencies?: DependencyMap;
}

interface PackageLock {
  readonly lockfileVersion?: number;
  readonly packages?: Readonly<Record<string, { readonly version?: string; readonly devDependencies?: DependencyMap }>>;
}

function readJson<T>(relative: string): T {
  return JSON.parse(readFileSync(abs(relative), "utf8")) as T;
}

test.describe("1.1 新增的 npm 包以精确版本声明，与 package-lock.json 一致", () => {
  test("1.1 @axe-core/playwright、@playwright/test、fast-check 在 devDependencies 中为三段纯数字，等于 lockfile 根项的声明与解析出的版本", () => {
    const pkg = readJson<PackageJson>("package.json");
    const lock = readJson<PackageLock>("package-lock.json");
    // v2 起 lockfile 以 packages 记录根项声明与每个包的解析版本
    expect(lock.lockfileVersion, "package-lock.json 的 lockfileVersion").toBeGreaterThanOrEqual(2);
    const root = lock.packages?.[""];

    for (const name of NEW_DEV_DEPENDENCIES) {
      const declared = pkg.devDependencies?.[name];
      expect(declared, `package.json devDependencies 中 ${name} 的版本`).toMatch(EXACT_VERSION);
      expect(pkg.dependencies?.[name], `${name} 只在 devDependencies 中声明`).toBeUndefined();
      expect(root?.devDependencies?.[name], `package-lock.json 根项中 ${name} 的声明`).toBe(declared);
      expect(lock.packages?.[`node_modules/${name}`]?.version, `package-lock.json 中 ${name} 解析出的版本`).toBe(declared);
    }
    expect(pkg.devDependencies?.["fast-check"]).toBe(FAST_CHECK_VERSION);
  });
});
