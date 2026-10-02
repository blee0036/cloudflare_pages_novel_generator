/**
 * 读当前书库、real 预检与 Test_Book 特征核对（设计"测试支撑（fixtures.ts）"的 `lib`、
 * "globalSetup 顺序"第 3 步；需求 4.2、4.3、4.4、4.7）。
 *
 * ## 书库根
 *
 * 两个 Library_Profile 的书库文件种类与命名相同（3.1），只是根不同：
 *
 * | profile | 根 | 说明 |
 * | --- | --- | --- |
 * | fixture | `e2e/.out/fixture/` | Fixture_Generator 的产物，另有 `roles.json` |
 * | real | `public/` | Real_Library，只读 |
 *
 * 根下为 `data/books.json`、`data/<id>_toc.json` 与 `books/<id>.txt.gz`，即 E2E_Server 的 `libRoot`。
 *
 * ## 用途（`BookRole`）
 *
 * 用例一律按用途取书，不写死 fixture 的书 id：fixture 下读 `roles.json`，real 下映射到
 * `TEST_BOOKS`（需求 Introduction 的测试用书表）。`FixtureRoles` 里 `sameAuthor`、`recent`、
 * `volumesKeyword` 不是单本书，不是 `BookRole`；`longRun`（书 id + 章节下标，3.3 (j)）只在 fixture
 * 下使用，用例直接读 `roles.longRun`，也不是 `BookRole`。另加一个 `leadingVolume`（第 2 个节点即卷节点的
 * 书，8.4 / 8.5 的"紧跟首节点的卷段"）：fixture 的 volumes 书同时承担它（3.3 (b)），real 下是
 * 《萌娘武侠世界》。real 下没有 crlf 书（10.3 只在 fixture 下验证），取它会抛错。
 *
 * | BookRole | fixture（roles.json） | real（Test_Book） |
 * | --- | --- | --- |
 * | volumes | `volumes` | 1852铁血中华-绯红之月 |
 * | leadingVolume | `volumes` | 萌娘武侠世界-三十二变 |
 * | huge | `huge` | 极品全能高手_极品全能学生_-花都大少 |
 * | stars | `stars` | 三国配角演义-马伯庸 |
 * | fallback | `fallback` | 第七天-余华 |
 * | pinyin | `pinyin.id` | 从零开始-雷云风暴 |
 * | longText | `longText.id` | 从零开始-雷云风暴 |
 * | crlf | `crlf` | —（抛错） |
 *
 * ## 期望值（4.4）
 *
 * 节点总数、卷节点序号、非卷节点数、标题、`fallback` 标记与 `.txt.gz` 字节数一律在运行时从
 * `_toc.json` 与 `.txt.gz` 推导（`deriveTocFacts`、`Library.gzSize`），本文件与用例源码都不写
 * 这些值的字面量。`TEST_BOOKS` 里只有书 id 与 4.7 的特征定义（阈值 3,000、标题 `※※※` 取自
 * 需求 4.7 的条文本身，是特征而不是期望值）。
 *
 * ## real 预检（4.2、4.3）与特征核对（4.7）
 *
 * globalSetup 第 3 步（profile 含 real 时）调用 `runRealPrecheck()`，以 `writeRealPrecheck()`
 * 写 `e2e/.out/real-precheck.json`。`lib` fixture 以 `readRealPrecheck()` 读回：
 *
 * - `ok` 为 false 时 real 下全部用例以 `precheckSkipReason()` 的原因跳过（前缀 `[4.3]`，逐个列出
 *   文件相对路径与失败类型：缺失 / 为空 / 无法解析 / 未列出某 Test_Book）；
 * - `features` 中 `ok` 为 false 的书，只跳过依赖它的用例（`featureSkipReason()`，前缀 `[4.7]`，
 *   注明书 id 与未满足的特征）。`Library.featureCheck(id)` 以同一个纯函数现场核对，结果相同。
 *
 * reporter 同样读这份文件，写 Run_Summary 的"夹具与 real 核对明细"一节。
 *
 * ## Fixture_Generator 失败记录（3.9）
 *
 * globalSetup 第 2 步（profile 含 fixture 时）运行 `generate.py --if-stale`；它未以退出码 0 结束
 * （含找不到 Python 解释器）时，以 `writeFixtureFailed()` 写 `e2e/.out/fixture-failed.json`。
 * `lib` fixture 以 `readFixtureFailed()` 读回，文件存在即让 fixture 各项目的用例以
 * `fixtureFailedSkipReason()` 的原因（前缀 `[3.9]`）跳过；reporter 据同一文件记一条运行级失败，
 * 并在 Run_Summary 中列出 `detail`（Fixture_Generator 报告的出错书或未满足项）。
 *
 * ## 其他约定
 *
 * - 只读：本文件不写书库下的任何文件，写操作只有 `writeRealPrecheck` 与 `writeFixtureFailed`
 *   （都写到 `e2e/.out/`）。
 * - JSON 开头的 UTF-8 BOM 与浏览器的 `Response.json()` 一样先去掉再解析。
 * - `Library` 按 worker 缓存 `books.json` 与各本 `_toc.json` 的解析结果，调用方不要修改返回值。
 * - 本文件只依赖 Node 内置模块（`src/types` 只作类型导入），不在运行时导入其他 E2E 模块。
 */
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BookSummary, BooksCatalog, BookToc, ChapterMeta } from "../../src/types";

/** 仓库根（本文件位于 `e2e/support/`）。 */
const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** E2E_Suite 的运行产物目录（gitignore）。 */
const OUT_DIR = path.join(REPO_ROOT, "e2e", ".out");

export type LibraryProfile = "fixture" | "real";

/** 全部 Library_Profile，按启动顺序。 */
export const LIBRARY_PROFILES: readonly LibraryProfile[] = ["fixture", "real"];

/**
 * 解析 `E2E_PROFILE`（`run.mjs` 设置）：`fixture`、`real`，或 `all`；未设置或为空时同 `all`
 * （直接执行 `npx playwright test`）。`run.mjs` 已校验过取值（1.8）；这里只防直接执行 Playwright
 * 时传入非法值，此时抛错。`playwright.config.ts`（选项目）与 globalSetup（起实例）共用本函数。
 */
export function selectedProfiles(value: string | undefined): LibraryProfile[] {
  if (value === undefined || value === "" || value === "all") return [...LIBRARY_PROFILES];
  if (value === "fixture" || value === "real") return [value];
  throw new Error(
    `E2E_PROFILE 的取值无效：${JSON.stringify(value)}。可接受的取值：${LIBRARY_PROFILES.join("、")}` +
      "（不设置时同时运行两者）",
  );
}

/** Fixture_Library 的根（Fixture_Generator 的输出目录，3.2）。 */
export const FIXTURE_LIB_ROOT = path.join(OUT_DIR, "fixture");

/** Real_Library 的根，只读（4.1）。 */
export const REAL_LIB_ROOT = path.join(REPO_ROOT, "public");

/** globalSetup 第 3 步写出的 real 预检结果。 */
export const REAL_PRECHECK_FILE = path.join(OUT_DIR, "real-precheck.json");

/** 4.7：《极品全能高手》须具备的最少节点数（与 8.7 "≥ 3,000 节点的书"同一阈值）。 */
export const HUGE_MIN_NODES = 3000;

/** 4.7：《三国配角演义》全部节点的标题。 */
export const STARS_TITLE = "※※※";

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

export function libRootFor(profile: LibraryProfile): string {
  return profile === "fixture" ? FIXTURE_LIB_ROOT : REAL_LIB_ROOT;
}

/**
 * 核对书 id 可以安全地拼进路径：非空，不含 `/`、`\`、NUL，也不是 `.` 或 `..`。
 * 书 id 来自 `books.json` 或 `TEST_BOOKS`，正常情况下总是满足；这里只防误用。
 */
function assertBookId(id: string): void {
  if (id === "" || id === "." || id === ".." || /[/\\\0]/.test(id)) {
    throw new Error(`不是合法的书 id：${JSON.stringify(id)}`);
  }
}

export function booksJsonPath(root: string): string {
  return path.join(root, "data", "books.json");
}

export function tocPath(root: string, id: string): string {
  assertBookId(id);
  return path.join(root, "data", `${id}_toc.json`);
}

export function gzPath(root: string, id: string): string {
  assertBookId(id);
  return path.join(root, "books", `${id}.txt.gz`);
}

export function rolesPath(root: string = FIXTURE_LIB_ROOT): string {
  return path.join(root, "roles.json");
}

/** 相对仓库根、以 `/` 分隔的路径；不在仓库内时返回绝对路径（Run_Summary 的写法，4.3）。 */
export function repoRelative(abs: string): string {
  const rel = path.relative(REPO_ROOT, path.resolve(abs));
  if (rel === "") return ".";
  if (path.isAbsolute(rel) || rel.split(path.sep)[0] === "..") return path.resolve(abs);
  return rel.split(path.sep).join("/");
}

// ---------------------------------------------------------------------------
// 解析与校验
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isErrno(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && (err as NodeJS.ErrnoException).code === code;
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return code ? `${code}：${err.message}` : err.message;
  }
  return String(err);
}

/** 内容不符合预期结构。`detail` 不含文件路径，供预检写入失败项。 */
class ShapeError extends Error {
  readonly detail: string;

  constructor(file: string, detail: string) {
    super(`${file} 格式无效：${detail}`);
    this.name = "ShapeError";
    this.detail = detail;
  }
}

/** 去掉开头的 BOM 后 `JSON.parse`；语法错误时抛 `ShapeError`。 */
function parseJsonText(text: string, file: string): unknown {
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (err) {
    throw new ShapeError(file, `不是合法 JSON（${(err as Error).message}）`);
  }
}

async function readJsonFile(file: string): Promise<unknown> {
  return parseJsonText(await readFile(file, "utf8"), file);
}

/** `books.json`：顶层对象，`books` 为数组，每项有字符串 `id`。其余字段按 `BooksCatalog` 原样返回。 */
export function parseBooksCatalog(data: unknown, file: string): BooksCatalog {
  if (!isRecord(data)) throw new ShapeError(file, "顶层不是对象");
  const { books } = data;
  if (!Array.isArray(books)) throw new ShapeError(file, "缺少 books 数组");
  books.forEach((book: unknown, i) => {
    if (!isRecord(book) || typeof book.id !== "string") {
      throw new ShapeError(file, `books[${i}].id 不是字符串`);
    }
  });
  return data as unknown as BooksCatalog;
}

/** `_toc.json`：顶层对象，`chapters` 为数组，每项有字符串 `title`。其余字段按 `BookToc` 原样返回。 */
export function parseToc(data: unknown, file: string): BookToc {
  if (!isRecord(data)) throw new ShapeError(file, "顶层不是对象");
  const { chapters } = data;
  if (!Array.isArray(chapters)) throw new ShapeError(file, "缺少 chapters 数组");
  chapters.forEach((node: unknown, i) => {
    if (!isRecord(node) || typeof node.title !== "string") {
      throw new ShapeError(file, `chapters[${i}].title 不是字符串`);
    }
  });
  return data as unknown as BookToc;
}

// ---------------------------------------------------------------------------
// roles.json（fixture）
// ---------------------------------------------------------------------------

/** `roles.json` 的内容（设计 Data Models；由 `e2e/fixture/books.py` 的 `build_roles` 组装）。 */
export interface FixtureRoles {
  volumes: string;
  fallback: string;
  stars: string;
  huge: string;
  crlf: string;
  pinyin: { id: string; abbr: string };
  sameAuthor: { author: string; ids: string[] };
  longText: {
    id: string;
    chapterIndex: number;
    capKeyword: string;
    fewKeyword: string;
    noHitKeyword: string;
  };
  /** 6 本，供 7.13。 */
  recent: string[];
  /** 在 volumes 书中命中 ≥ 1（生成器校验），供 15.1 检索抽屉。 */
  volumesKeyword: string;
  /**
   * 3.3 (j)（reader-defect-fixes 需求 10.2）：`chapterIndex`（`_toc.json` 的节点下标）所指正文章节
   * 内恰有一个段落由 ≥ 58 个连续 `=` 构成（生成器校验），供 RDF 10.1。
   */
  longRun: { id: string; chapterIndex: number };
}

/** 校验 `roles.json` 的结构；不合法时抛错，错误信息含文件路径与第一处不合法的字段。 */
export function parseFixtureRoles(data: unknown, file: string): FixtureRoles {
  const bad = (what: string): ShapeError => new ShapeError(file, what);
  const str = (v: unknown, what: string): string => {
    if (typeof v !== "string" || v === "") throw bad(`${what} 不是非空字符串`);
    return v;
  };
  const obj = (v: unknown, what: string): Record<string, unknown> => {
    if (!isRecord(v)) throw bad(`${what} 不是对象`);
    return v;
  };
  const strList = (v: unknown, what: string): string[] => {
    if (!Array.isArray(v)) throw bad(`${what} 不是数组`);
    return v.map((item: unknown, i) => str(item, `${what}[${i}]`));
  };

  const index = (v: unknown, what: string): number => {
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw bad(`${what} 不是非负整数`);
    return v;
  };

  const top = obj(data, "顶层");
  const pinyin = obj(top.pinyin, "pinyin");
  const sameAuthor = obj(top.sameAuthor, "sameAuthor");
  const longText = obj(top.longText, "longText");
  const chapterIndex = index(longText.chapterIndex, "longText.chapterIndex");
  const longRun = obj(top.longRun, "longRun");
  return {
    volumes: str(top.volumes, "volumes"),
    fallback: str(top.fallback, "fallback"),
    stars: str(top.stars, "stars"),
    huge: str(top.huge, "huge"),
    crlf: str(top.crlf, "crlf"),
    pinyin: { id: str(pinyin.id, "pinyin.id"), abbr: str(pinyin.abbr, "pinyin.abbr") },
    sameAuthor: {
      author: str(sameAuthor.author, "sameAuthor.author"),
      ids: strList(sameAuthor.ids, "sameAuthor.ids"),
    },
    longText: {
      id: str(longText.id, "longText.id"),
      chapterIndex,
      capKeyword: str(longText.capKeyword, "longText.capKeyword"),
      fewKeyword: str(longText.fewKeyword, "longText.fewKeyword"),
      noHitKeyword: str(longText.noHitKeyword, "longText.noHitKeyword"),
    },
    recent: strList(top.recent, "recent"),
    volumesKeyword: str(top.volumesKeyword, "volumesKeyword"),
    longRun: {
      id: str(longRun.id, "longRun.id"),
      chapterIndex: index(longRun.chapterIndex, "longRun.chapterIndex"),
    },
  };
}

/** 读 Fixture_Library 的 `roles.json`（文件不存在时抛出 `ENOENT`）。 */
export async function readFixtureRoles(root: string = FIXTURE_LIB_ROOT): Promise<FixtureRoles> {
  const file = rolesPath(root);
  return parseFixtureRoles(await readJsonFile(file), file);
}

// ---------------------------------------------------------------------------
// 用途与 Test_Book
// ---------------------------------------------------------------------------

/** 能解析为单本书的用途名（见模块说明的对照表）。 */
export const BOOK_ROLES = [
  "volumes",
  "leadingVolume",
  "huge",
  "stars",
  "fallback",
  "pinyin",
  "longText",
  "crlf",
] as const;

export type BookRole = (typeof BOOK_ROLES)[number];

/** fixture 下某用途对应的书 id。 */
export function fixtureRoleBookId(roles: FixtureRoles, role: BookRole): string {
  switch (role) {
    case "volumes":
    case "leadingVolume":
      return roles.volumes;
    case "huge":
      return roles.huge;
    case "stars":
      return roles.stars;
    case "fallback":
      return roles.fallback;
    case "pinyin":
      return roles.pinyin.id;
    case "longText":
      return roles.longText.id;
    case "crlf":
      return roles.crlf;
  }
}

/** 4.7 的一项特征核对结果。 */
export interface FeatureCheck {
  /** Test_Book 的 id。 */
  id: string;
  /** 需求 4.7 列出的特征。 */
  feature: string;
  ok: boolean;
  /** 实际情况的一句话描述；通过时概括满足特征的依据。 */
  actual: string;
}

/** `_toc.json` 中 4.7 核对与 `deriveTocFacts` 用到的部分。 */
export type TocShape = Pick<BookToc, "chapters" | "fallback">;

export interface TestBookFeature {
  /** 需求 4.7 列出的特征原文。 */
  label: string;
  /** 纯函数：按 `_toc.json` 判定是否具备该特征。 */
  check(toc: TocShape): { ok: boolean; actual: string };
}

export interface TestBookDef {
  id: string;
  /** 测试用书表中的"用途"。 */
  uses: string;
  /** 本书在 real 下承担的用途。 */
  roles: readonly BookRole[];
  /** 需求 4.7 要求的特征；表中未列特征的书（《从零开始》）为 null。 */
  feature: TestBookFeature | null;
}

/** 真实书库中的测试用书（需求 Introduction 的测试用书表）。书 id 与用途以外的数字一律运行时推导。 */
export const TEST_BOOKS: readonly TestBookDef[] = [
  {
    id: "1852铁血中华-绯红之月",
    uses: "卷表头、导航跳过卷",
    roles: ["volumes"],
    feature: {
      label: "至少 1 个卷节点，且该卷节点前后均有非卷节点",
      check(toc) {
        const facts = deriveTocFacts(toc);
        const run = facts.volumeRuns.find((r) => r.before !== null && r.after !== null);
        if (run) {
          return { ok: true, actual: `下标 ${run.first} 的卷节点前后均有非卷节点` };
        }
        const count = facts.volumeIndices.length;
        return {
          ok: false,
          actual: count === 0 ? "没有卷节点" : `${count} 个卷节点都缺少前或后的非卷节点`,
        };
      },
    },
  },
  {
    id: "极品全能高手_极品全能学生_-花都大少",
    uses: "最大书：目录规模、加载进度",
    roles: ["huge"],
    feature: {
      label: `节点数 ≥ ${HUGE_MIN_NODES.toLocaleString("en-US")}`,
      check(toc) {
        const n = toc.chapters.length;
        return { ok: n >= HUGE_MIN_NODES, actual: `${n} 个节点` };
      },
    },
  },
  {
    id: "从零开始-雷云风暴",
    uses: "拼音检索 clks、全文检索、进度恢复",
    roles: ["pinyin", "longText"],
    feature: null,
  },
  {
    id: "萌娘武侠世界-三十二变",
    uses: "紧跟首节点的卷（第 2 个节点即卷）",
    roles: ["leadingVolume"],
    feature: {
      label: "第 2 个节点为卷节点",
      check(toc) {
        const second = toc.chapters[1] as ChapterMeta | undefined;
        if (second === undefined) {
          return { ok: false, actual: `只有 ${toc.chapters.length} 个节点` };
        }
        return second.isVolume === true
          ? { ok: true, actual: `第 2 个节点「${second.title}」为卷节点` }
          : { ok: false, actual: `第 2 个节点「${second.title}」不是卷节点` };
      },
    },
  },
  {
    id: "三国配角演义-马伯庸",
    uses: `标题全为 ${STARS_TITLE}`,
    roles: ["stars"],
    feature: {
      label: `全部节点标题为 ${STARS_TITLE}`,
      check(toc) {
        const others = toc.chapters.filter((c) => c.title !== STARS_TITLE);
        if (others.length === 0) {
          return { ok: true, actual: `${toc.chapters.length} 个节点的标题均为 ${STARS_TITLE}` };
        }
        const first = toc.chapters.findIndex((c) => c.title !== STARS_TITLE);
        return {
          ok: false,
          actual:
            `${others.length} 个节点的标题不是 ${STARS_TITLE}，` +
            `首个为第 ${first + 1} 个「${toc.chapters[first].title}」`,
        };
      },
    },
  },
  {
    id: "第七天-余华",
    uses: "全书兜底",
    roles: ["fallback"],
    feature: {
      label: "fallback 为 true",
      check(toc) {
        const value: unknown = toc.fallback;
        if (value === true) return { ok: true, actual: "fallback 为 true" };
        return {
          ok: false,
          actual: value === undefined ? "未设置 fallback" : `fallback 为 ${JSON.stringify(value)}`,
        };
      },
    },
  },
];

/** real 下承担某用途的 Test_Book；没有时为 undefined（如 crlf）。 */
export function testBookFor(role: BookRole): TestBookDef | undefined {
  return TEST_BOOKS.find((def) => def.roles.includes(role));
}

/** 按 4.7 核对一本 Test_Book；该书没有要求的特征时返回 null。纯函数。 */
export function checkTestBookFeature(def: TestBookDef, toc: TocShape): FeatureCheck | null {
  if (def.feature === null) return null;
  const { ok, actual } = def.feature.check(toc);
  return { id: def.id, feature: def.feature.label, ok, actual };
}

/** 4.7 跳过原因：`[4.7] <id>: <特征>（实际：…）`。 */
export function featureSkipReason(check: FeatureCheck): string {
  return `[4.7] ${check.id}: ${check.feature}（实际：${check.actual}）`;
}

// ---------------------------------------------------------------------------
// 期望值推导（4.4）
// ---------------------------------------------------------------------------

/** 一个卷段：`_toc.json` 中 1 个或多个相邻的卷节点（8.4、8.5）。 */
export interface VolumeRun {
  /** 卷段首个卷节点的下标。 */
  first: number;
  /** 卷段末个卷节点的下标；单个卷节点时等于 `first`，大于 `first` 即相邻卷节点（8.13）。 */
  last: number;
  /** 卷段之前最后一个正文节点的下标（即 `first − 1`）；卷段位于书首时为 null。 */
  before: number | null;
  /** 卷段之后第一个正文节点的下标（即 `last + 1`）；卷段位于书末时为 null。 */
  after: number | null;
}

/** 由 `_toc.json` 推导的期望值（4.4）。 */
export interface TocFacts {
  /** 节点总数（含卷节点）。 */
  nodeCount: number;
  /** 每个节点的标题，按下标。 */
  titles: readonly string[];
  /** 卷节点的下标，升序。 */
  volumeIndices: readonly number[];
  /** 非卷节点（正文章节）的下标，升序。 */
  bodyIndices: readonly number[];
  /** 非卷节点数，即"第 N / M 章"的 M 与章节进度滑杆的最大值 + 1（8.6）。 */
  bodyCount: number;
  /** 按下标：该节点在非卷节点中的序号（从 0 起）；卷节点为 null。"第 N / M 章"的 N 为它加 1（8.1）。 */
  bodyOrdinals: readonly (number | null)[];
  /** `fallback` 标记；产物只在为真时写出该字段。 */
  fallback: boolean;
  /** 全部卷段，按下标升序。 */
  volumeRuns: readonly VolumeRun[];
}

/** 从 `_toc.json` 推导 `TocFacts`。纯函数，不修改参数。 */
export function deriveTocFacts(toc: TocShape): TocFacts {
  const nodes = toc.chapters;
  const titles: string[] = [];
  const volumeIndices: number[] = [];
  const bodyIndices: number[] = [];
  const bodyOrdinals: (number | null)[] = [];
  nodes.forEach((node, i) => {
    titles.push(node.title);
    if (node.isVolume === true) {
      volumeIndices.push(i);
      bodyOrdinals.push(null);
    } else {
      bodyOrdinals.push(bodyIndices.length);
      bodyIndices.push(i);
    }
  });

  const volumeRuns: VolumeRun[] = [];
  let i = 0;
  while (i < nodes.length) {
    if (nodes[i].isVolume !== true) {
      i += 1;
      continue;
    }
    let last = i;
    while (last + 1 < nodes.length && nodes[last + 1].isVolume === true) last += 1;
    volumeRuns.push({
      first: i,
      last,
      before: i > 0 ? i - 1 : null,
      after: last + 1 < nodes.length ? last + 1 : null,
    });
    i = last + 1;
  }

  return {
    nodeCount: nodes.length,
    titles,
    volumeIndices,
    bodyIndices,
    bodyCount: bodyIndices.length,
    bodyOrdinals,
    fallback: toc.fallback === true,
    volumeRuns,
  };
}

// ---------------------------------------------------------------------------
// real 预检（4.2、4.3）
// ---------------------------------------------------------------------------

/** 4.3 的失败类型。 */
export type PrecheckFailureKind = "缺失" | "为空" | "无法解析" | "未列出某 Test_Book";

export interface PrecheckFailure {
  /** 未通过核对的文件，相对仓库根、以 `/` 分隔（如 `public/data/books.json`）。 */
  path: string;
  kind: PrecheckFailureKind;
  /** 补充说明：未列出的书 id、解析错误、"0 字节"或"0 个节点"等。 */
  detail?: string;
}

/** `real-precheck.json` 的内容。 */
export interface RealPrecheck {
  /** 核对时刻，ISO 8601（UTC）。 */
  checkedAt: string;
  /** 被核对的书库根，相对仓库根（正常为 `public`）。 */
  root: string;
  /** 4.2 的全部核对通过（不含 4.7）。为 false 时 real 下全部用例跳过（4.3）。 */
  ok: boolean;
  /** 4.2 未通过的项，按核对顺序：先 `books.json`，再逐本 Test_Book 的 `.txt.gz`、`_toc.json`。 */
  failures: PrecheckFailure[];
  /**
   * 4.7 的核对结果，按 `TEST_BOOKS` 顺序；只含有特征要求、且 `_toc.json` 通过 4.2 的书。
   * `ok` 为 false 的书只跳过依赖它的用例。
   */
  features: FeatureCheck[];
}

type FileProbe = { present: true; size: number } | { present: false; detail?: string };

async function probeFile(abs: string): Promise<FileProbe> {
  try {
    const st = await stat(abs);
    if (!st.isFile()) return { present: false, detail: st.isDirectory() ? "是目录" : "不是普通文件" };
    return { present: true, size: st.size };
  } catch (err) {
    if (isErrno(err, "ENOENT") || isErrno(err, "ENOTDIR")) return { present: false };
    return { present: false, detail: `无法访问（${errorText(err)}）` };
  }
}

function withDetail(
  failure: { path: string; kind: PrecheckFailureKind },
  detail: string | undefined,
): PrecheckFailure {
  return detail === undefined ? failure : { ...failure, detail };
}

/**
 * 按 4.2 核对一个 JSON 文件：存在、非空、可解析且结构符合 `parse`。
 * 不通过时把失败项追加到 `failures` 并返回 null。
 */
async function precheckJson<T>(
  abs: string,
  parse: (data: unknown, file: string) => T,
  failures: PrecheckFailure[],
): Promise<T | null> {
  const rel = repoRelative(abs);
  const probe = await probeFile(abs);
  if (!probe.present) {
    failures.push(withDetail({ path: rel, kind: "缺失" }, probe.detail));
    return null;
  }
  if (probe.size === 0) {
    failures.push({ path: rel, kind: "为空", detail: "0 字节" });
    return null;
  }
  let text: string;
  try {
    text = await readFile(abs, "utf8");
  } catch (err) {
    failures.push({ path: rel, kind: "缺失", detail: `无法读取（${errorText(err)}）` });
    return null;
  }
  try {
    return parse(parseJsonText(text, rel), rel);
  } catch (err) {
    if (!(err instanceof ShapeError)) throw err;
    failures.push({ path: rel, kind: "无法解析", detail: err.detail });
    return null;
  }
}

/**
 * 按 4.2 核对 Real_Library，并对通过的 `_toc.json` 按 4.7 核对特征（globalSetup 第 3 步）。
 *
 * 只读取文件：`books.json` 与各本 Test_Book 的 `_toc.json` 整体读入解析，`.txt.gz` 只取元数据。
 * 核对失败不抛错，只体现在返回值上；只有意料之外的程序错误才会 reject。
 *
 * @param root 书库根，默认 `public/`；测试可传临时目录。
 * @param books 测试用书，默认 `TEST_BOOKS`。
 */
export async function runRealPrecheck(
  root: string = REAL_LIB_ROOT,
  books: readonly TestBookDef[] = TEST_BOOKS,
): Promise<RealPrecheck> {
  const checkedAt = new Date().toISOString();
  const failures: PrecheckFailure[] = [];
  const features: FeatureCheck[] = [];

  const catalogFile = booksJsonPath(root);
  const catalog = await precheckJson(catalogFile, parseBooksCatalog, failures);
  if (catalog !== null) {
    const listed = new Set(catalog.books.map((b) => b.id));
    for (const def of books) {
      if (!listed.has(def.id)) {
        failures.push({ path: repoRelative(catalogFile), kind: "未列出某 Test_Book", detail: def.id });
      }
    }
  }

  for (const def of books) {
    const gz = gzPath(root, def.id);
    const probe = await probeFile(gz);
    if (!probe.present) {
      failures.push(withDetail({ path: repoRelative(gz), kind: "缺失" }, probe.detail));
    } else if (probe.size === 0) {
      failures.push({ path: repoRelative(gz), kind: "为空", detail: "0 字节" });
    }

    const tocFile = tocPath(root, def.id);
    const toc = await precheckJson(tocFile, parseToc, failures);
    if (toc === null) continue;
    if (toc.chapters.length === 0) {
      failures.push({ path: repoRelative(tocFile), kind: "为空", detail: "0 个节点" });
      continue;
    }
    const feature = checkTestBookFeature(def, toc);
    if (feature !== null) features.push(feature);
  }

  return { checkedAt, root: repoRelative(root), ok: failures.length === 0, failures, features };
}

/** `路径（类型：说明）`，Run_Summary 与跳过原因的写法。 */
export function formatPrecheckFailure(f: PrecheckFailure): string {
  return f.detail === undefined ? `${f.path}（${f.kind}）` : `${f.path}（${f.kind}：${f.detail}）`;
}

/** 4.3 跳过原因；预检通过时返回 null。前缀 `[4.3]`，逐个列出未通过核对的文件与失败类型。 */
export function precheckSkipReason(p: RealPrecheck): string | null {
  if (p.ok) return null;
  return `[4.3] real 书库核对未通过（${p.failures.length} 项）：${p.failures
    .map(formatPrecheckFailure)
    .join("；")}`;
}

/** 写 `real-precheck.json`（覆盖已有文件，父目录不存在时创建）。 */
export async function writeRealPrecheck(
  result: RealPrecheck,
  file: string = REAL_PRECHECK_FILE,
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

const FAILURE_KINDS: readonly string[] = ["缺失", "为空", "无法解析", "未列出某 Test_Book"];

/**
 * 读 `real-precheck.json`。文件不存在时返回 null（本次运行未做 real 预检）；
 * 内容不合法时抛错，错误信息含文件路径与第一处不合法的字段。
 */
export async function readRealPrecheck(file: string = REAL_PRECHECK_FILE): Promise<RealPrecheck | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if (isErrno(err, "ENOENT")) return null;
    throw err;
  }
  const data = parseJsonText(text, file);
  const bad = (what: string): ShapeError => new ShapeError(file, what);
  if (!isRecord(data)) throw bad("顶层不是对象");
  const { checkedAt, root, ok, failures, features } = data;
  if (typeof checkedAt !== "string" || Number.isNaN(Date.parse(checkedAt))) throw bad("checkedAt");
  if (typeof root !== "string") throw bad("root");
  if (typeof ok !== "boolean") throw bad("ok");
  if (!Array.isArray(failures)) throw bad("failures 不是数组");
  if (!Array.isArray(features)) throw bad("features 不是数组");
  const parsedFailures = failures.map((f: unknown, i): PrecheckFailure => {
    if (!isRecord(f) || typeof f.path !== "string") throw bad(`failures[${i}].path`);
    if (typeof f.kind !== "string" || !FAILURE_KINDS.includes(f.kind)) throw bad(`failures[${i}].kind`);
    if (f.detail !== undefined && typeof f.detail !== "string") throw bad(`failures[${i}].detail`);
    return withDetail({ path: f.path, kind: f.kind as PrecheckFailureKind }, f.detail);
  });
  const parsedFeatures = features.map((f: unknown, i): FeatureCheck => {
    if (!isRecord(f)) throw bad(`features[${i}] 不是对象`);
    const { id, feature, ok: passed, actual } = f;
    if (typeof id !== "string") throw bad(`features[${i}].id`);
    if (typeof feature !== "string") throw bad(`features[${i}].feature`);
    if (typeof passed !== "boolean") throw bad(`features[${i}].ok`);
    if (typeof actual !== "string") throw bad(`features[${i}].actual`);
    return { id, feature, ok: passed, actual };
  });
  if (ok !== (parsedFailures.length === 0)) {
    throw bad(`ok 为 ${String(ok)}，failures 有 ${parsedFailures.length} 项`);
  }
  return { checkedAt, root, ok, failures: parsedFailures, features: parsedFeatures };
}

// ---------------------------------------------------------------------------
// Fixture_Generator 失败记录（3.9）
// ---------------------------------------------------------------------------

/** globalSetup 第 2 步在 Fixture_Generator 失败时写出的记录。 */
export const FIXTURE_FAILED_FILE = path.join(OUT_DIR, "fixture-failed.json");

/** `fixture-failed.json` 的内容。 */
export interface FixtureFailure {
  /** 写入时刻，ISO 8601（UTC）。 */
  writtenAt: string;
  /** Fixture_Generator 的退出码；未能启动（如找不到 Python 解释器）或被信号终止时为 null。 */
  exitCode: number | null;
  /** 一句话原因，如"Fixture_Generator 以退出码 1 结束"或"未找到 Python 解释器（python）"。 */
  reason: string;
  /** Fixture_Generator 报告的出错书或未满足项：其 stderr 的非空行，按输出顺序（3.9）。 */
  detail: string[];
}

/** 写 `fixture-failed.json`（覆盖已有文件，父目录不存在时创建）。 */
export async function writeFixtureFailed(
  failure: FixtureFailure,
  file: string = FIXTURE_FAILED_FILE,
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(failure, null, 2)}\n`, "utf8");
}

/**
 * 读 `fixture-failed.json`。文件不存在时返回 null（本次运行的 Fixture_Library 可用，或未选中
 * fixture）；内容不合法时抛错，错误信息含文件路径与第一处不合法的字段。
 */
export async function readFixtureFailed(
  file: string = FIXTURE_FAILED_FILE,
): Promise<FixtureFailure | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if (isErrno(err, "ENOENT")) return null;
    throw err;
  }
  const data = parseJsonText(text, file);
  const bad = (what: string): ShapeError => new ShapeError(file, what);
  if (!isRecord(data)) throw bad("顶层不是对象");
  const { writtenAt, exitCode, reason, detail } = data;
  if (typeof writtenAt !== "string" || Number.isNaN(Date.parse(writtenAt))) throw bad("writtenAt");
  if (exitCode !== null && !(typeof exitCode === "number" && Number.isInteger(exitCode))) {
    throw bad("exitCode 不是整数或 null");
  }
  if (typeof reason !== "string" || reason === "") throw bad("reason 不是非空字符串");
  if (!Array.isArray(detail)) throw bad("detail 不是数组");
  const lines = detail.map((line: unknown, i) => {
    if (typeof line !== "string") throw bad(`detail[${i}] 不是字符串`);
    return line;
  });
  return { writtenAt, exitCode, reason, detail: lines };
}

/** 3.9 跳过原因：`[3.9] Fixture_Generator 失败（<原因>），fixture 下的用例不执行`。 */
export function fixtureFailedSkipReason(failure: Pick<FixtureFailure, "reason">): string {
  return `[3.9] Fixture_Generator 失败（${failure.reason}），fixture 下的用例不执行`;
}

// ---------------------------------------------------------------------------
// Library：当前书库的读取入口（lib fixture 的底层）
// ---------------------------------------------------------------------------

export interface OpenLibraryOptions {
  /** 书库根；默认 `libRootFor(profile)`。 */
  root?: string;
}

/**
 * 一个 Library_Profile 的书库。以 `Library.open(profile)` 创建；fixture 下同时读入 `roles.json`。
 *
 * 读取结果按实例缓存（读失败的不缓存）。书 id 不在书库中时，`toc` / `gzSize` 以文件系统错误 reject。
 */
export class Library {
  readonly profile: LibraryProfile;
  readonly root: string;
  /** fixture 下为 `roles.json` 的内容；real 下为 null。 */
  readonly fixtureRoles: FixtureRoles | null;
  #books: Promise<BooksCatalog> | null = null;
  readonly #tocs = new Map<string, Promise<BookToc>>();

  private constructor(profile: LibraryProfile, root: string, fixtureRoles: FixtureRoles | null) {
    this.profile = profile;
    this.root = root;
    this.fixtureRoles = fixtureRoles;
  }

  static async open(profile: LibraryProfile, options: OpenLibraryOptions = {}): Promise<Library> {
    const root = path.resolve(options.root ?? libRootFor(profile));
    const roles = profile === "fixture" ? await readFixtureRoles(root) : null;
    return new Library(profile, root, roles);
  }

  /** `data/books.json`。 */
  books(): Promise<BooksCatalog> {
    if (this.#books === null) {
      const file = booksJsonPath(this.root);
      const pending = readJsonFile(file).then((data) => parseBooksCatalog(data, file));
      pending.catch(() => {
        if (this.#books === pending) this.#books = null;
      });
      this.#books = pending;
    }
    return this.#books;
  }

  /** `books.json` 中的一本书；未列出时 reject。 */
  async book(id: string): Promise<BookSummary> {
    const found = (await this.books()).books.find((b) => b.id === id);
    if (found === undefined) {
      throw new Error(`${repoRelative(booksJsonPath(this.root))} 未列出 ${id}`);
    }
    return found;
  }

  /** `data/<id>_toc.json`。 */
  toc(id: string): Promise<BookToc> {
    let pending = this.#tocs.get(id);
    if (pending === undefined) {
      const file = tocPath(this.root, id);
      const created = readJsonFile(file).then((data) => parseToc(data, file));
      created.catch(() => {
        if (this.#tocs.get(id) === created) this.#tocs.delete(id);
      });
      this.#tocs.set(id, created);
      pending = created;
    }
    return pending;
  }

  /** 由 `_toc.json` 推导的期望值（4.4）。 */
  async tocFacts(id: string): Promise<TocFacts> {
    return deriveTocFacts(await this.toc(id));
  }

  /** `books/<id>.txt.gz` 的绝对路径（不核对是否存在）。 */
  gzPath(id: string): string {
    return gzPath(this.root, id);
  }

  /** `.txt.gz` 的字节数（4.4），每次调用都重新取元数据。 */
  async gzSize(id: string): Promise<number> {
    return (await stat(this.gzPath(id))).size;
  }

  /**
   * 承担某用途的书 id：fixture 下取自 `roles.json`，real 下取自 `TEST_BOOKS`。
   * real 下没有承担该用途的 Test_Book（crlf）时抛错。本方法不做 4.7 核对，见 `featureCheck`。
   */
  role(name: BookRole): string {
    if (this.fixtureRoles !== null) return fixtureRoleBookId(this.fixtureRoles, name);
    const def = testBookFor(name);
    if (def === undefined) {
      throw new Error(`real 书库没有承担 ${name} 用途的 Test_Book`);
    }
    return def.id;
  }

  /**
   * 8.13 等条目所说的"可用的书"：fixture 下为 Fixture_Library 全部书（`books.json` 的顺序），
   * real 下为全部 Test_Book（`TEST_BOOKS` 的顺序）。
   */
  async candidateBookIds(): Promise<string[]> {
    if (this.profile === "real") return TEST_BOOKS.map((def) => def.id);
    return (await this.books()).books.map((b) => b.id);
  }

  /**
   * 按 4.7 现场核对一本书。fixture 下、或该书不是有特征要求的 Test_Book 时返回 null；
   * 结果与 `real-precheck.json` 的 `features` 同出一个纯函数。
   */
  async featureCheck(id: string): Promise<FeatureCheck | null> {
    if (this.profile !== "real") return null;
    const def = TEST_BOOKS.find((d) => d.id === id);
    if (def === undefined || def.feature === null) return null;
    return checkTestBookFeature(def, await this.toc(id));
  }
}
