/**
 * 读 Fixture_Library，并按用途核对特征（设计"测试支撑（fixtures.ts）"的 `lib`；
 * test-data-desensitization 需求 4.2）。
 *
 * 不带前缀的条目号指 e2e-visual-testing 的需求；其他 spec 的条目写明 spec 名。
 *
 * ## 书库根
 *
 * 只有一个 Library_Profile：fixture。real 档已移除，测试只用合成书库（test-data-desensitization
 * 需求 2.1、4.1）。书库根为 `e2e/.out/fixture/`，即 Fixture_Generator 的产物：根下为
 * `data/books.json`、`data/<id>_toc.json`、`books/<id>.txt.gz` 与 `roles.json`，也是 E2E_Server
 * 的 `libRoot`。
 *
 * ## 用途（`BookRole`）与特征
 *
 * 用例一律按用途取书，不写死书 id：书 id 取自 `roles.json`（`fixtureRoleBookId`）。`FixtureRoles` 里
 * `sameAuthor`、`recent`、`volumesKeyword` 不是单本书，不是 `BookRole`；`longRun`（书 id + 章节下标，
 * 3.3 (j)）由用例直接读 `roles.longRun`，也不是 `BookRole`。`leadingVolume`（第 2 个节点即卷节点的书，
 * 8.4 / 8.5 的"紧跟首节点的卷段"）由 volumes 书同时承担（3.3 (b)）。
 *
 * | BookRole | `roles.json` 字段 | 特征（`ROLE_FEATURES`，判定只看 `_toc.json`） |
 * | --- | --- | --- |
 * | volumes | `volumes` | 至少 1 个卷节点，且该卷节点前后均有非卷节点 |
 * | leadingVolume | `volumes` | 第 2 个节点为卷节点 |
 * | huge | `huge` | 节点数 ≥ `HUGE_MIN_NODES`（3,000） |
 * | stars | `stars` | 全部节点标题为 `STARS_TITLE`（`※※※`）；0 个节点不算 |
 * | fallback | `fallback` | `fallback` 为 true |
 * | pinyin | `pinyin.id` | 无 |
 * | longText | `longText.id` | 无 |
 * | crlf | `crlf` | 无 |
 *
 * `checkRoleFeature(role, toc)` 是上表的纯函数入口。核对的时机与失败处理在 `e2e/support/fixtures.ts`：
 * worker fixture `libraryState` 打开书库后，对每个有特征的用途核对一次（另核对书 id 列在
 * `books.json` 中）；`lib.role(name)` 遇到不成立的特征时抛错，用例判失败而不是跳过，错误信息为
 * `[4.2] <用途> <书 id>：<特征>（实际：…）`。`Library.role()` 只做用途到书 id 的映射，不核对特征。
 *
 * ## 期望值（4.4）
 *
 * 节点总数、卷节点序号、非卷节点数、标题、`fallback` 标记与 `.txt.gz` 字节数一律在运行时从
 * `_toc.json` 与 `.txt.gz` 推导（`deriveTocFacts`、`Library.gzSize`），本文件与用例源码都不写
 * 这些值的字面量。`ROLE_FEATURES` 里的阈值 3,000 与标题 `※※※` 是特征本身，不是期望值。
 *
 * ## Fixture_Generator 失败记录（3.9）
 *
 * globalSetup 第 2 步运行 `generate.py --if-stale`；它未以退出码 0 结束（含找不到 Python 解释器）时，
 * 以 `writeFixtureFailed()` 写 `e2e/.out/fixture-failed.json`。`lib` fixture 以 `readFixtureFailed()`
 * 读回，文件存在即让 fixture 各项目的用例以 `fixtureFailedSkipReason()` 的原因（前缀 `[3.9]`）跳过；
 * reporter 据同一文件记一条运行级失败，并在 Run_Summary 中列出 `detail`（Fixture_Generator 报告的
 * 出错书或未满足项）。
 *
 * ## 其他约定
 *
 * - 只读：本文件不写书库下的任何文件，写操作只有 `writeFixtureFailed`（写到 `e2e/.out/`）。
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

/** Library_Profile。real 档已移除（test-data-desensitization），只剩 fixture。 */
export type LibraryProfile = "fixture";

/** 全部 Library_Profile。 */
export const LIBRARY_PROFILES: readonly LibraryProfile[] = ["fixture"];

/**
 * 解析 `E2E_PROFILE`（`run.mjs` 设置）：`fixture` 与 `all` 都返回 `["fixture"]`；未设置或为空时同
 * `all`（直接执行 `npx playwright test`）。`run.mjs` 已校验过取值（1.8）；这里只防直接执行 Playwright
 * 时传入非法值，此时抛错，`real` 另说明 real 档已移除。`playwright.config.ts`（选项目）与 globalSetup
 * （起实例）共用本函数。
 */
export function selectedProfiles(value: string | undefined): LibraryProfile[] {
  if (value === undefined || value === "" || value === "all" || value === "fixture") {
    return [...LIBRARY_PROFILES];
  }
  const accepted = `可接受的取值：${[...LIBRARY_PROFILES, "all"].join("、")}（不设置时同 all）`;
  if (value === "real") {
    throw new Error(
      `E2E_PROFILE 的取值无效："real"。real 档已移除：测试只用合成书库（test-data-desensitization）。` +
        accepted,
    );
  }
  throw new Error(`E2E_PROFILE 的取值无效：${JSON.stringify(value)}。${accepted}`);
}

/** Fixture_Library 的根（Fixture_Generator 的输出目录，3.2）。 */
export const FIXTURE_LIB_ROOT = path.join(OUT_DIR, "fixture");

/**
 * huge 用途须具备的最少节点数（test-data-desensitization 需求 4.2 (b)；与 8.7"≥ 3,000 节点的书"
 * 同一阈值）。
 */
export const HUGE_MIN_NODES = 3000;

/** stars 用途全部节点的标题（test-data-desensitization 需求 4.2 (e)）。 */
export const STARS_TITLE = "※※※";

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

/** Library_Profile 的书库根，即 E2E_Server 的 `libRoot`。 */
export function libRootFor(profile: LibraryProfile): string {
  switch (profile) {
    case "fixture":
      return FIXTURE_LIB_ROOT;
  }
}

/**
 * 核对书 id 可以安全地拼进路径：非空，不含 `/`、`\`、NUL，也不是 `.` 或 `..`。
 * 书 id 来自 `books.json` 或 `roles.json`，正常情况下总是满足；这里只防误用。
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

/** 相对仓库根、以 `/` 分隔的路径；不在仓库内时返回绝对路径（Run_Summary 的写法）。 */
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

/** 内容不符合预期结构。 */
class ShapeError extends Error {
  constructor(file: string, detail: string) {
    super(`${file} 格式无效：${detail}`);
    this.name = "ShapeError";
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
// roles.json
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
// 用途与特征（test-data-desensitization 需求 4.2）
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

/** 某用途对应的书 id（取自 `roles.json`；leadingVolume 与 volumes 是同一本书）。 */
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

/**
 * `_toc.json` 中特征核对与 `deriveTocFacts` 用到的部分：节点只看 `title` 与 `isVolume`。
 * 整份 `BookToc` 可以直接传入；测试也可以只写这几个字段的片段。
 */
export interface TocShape {
  readonly chapters: readonly Pick<ChapterMeta, "title" | "isVolume">[];
  readonly fallback?: boolean;
}

/** `TocShape` 的一个节点。 */
type TocNode = TocShape["chapters"][number];

/** 一个用途的特征：特征的文字描述与判定函数。 */
export interface RoleFeature {
  /** 特征的文字描述，如"节点数 ≥ 3,000"；即错误信息中的 `<特征>`。 */
  readonly label: string;
  /**
   * 纯函数：按 `_toc.json` 判定是否具备该特征，不修改参数。`actual` 是实际情况的一句话描述：
   * 不具备时写明差在哪里，具备时概括满足特征的依据。
   */
  check(toc: TocShape): { ok: boolean; actual: string };
}

/**
 * 按用途索引的特征表（设计"需求 4.2 的特征核对"），见模块说明的对照表。无特征的用途为 null：
 * pinyin、longText 的检索词与章节下标取自 `roles.json`，crlf 由 10.3 的用例自己核对。
 */
export const ROLE_FEATURES: Readonly<Record<BookRole, RoleFeature | null>> = {
  volumes: {
    // 比需求 4.2 (a)"至少 1 个卷节点"更严：卷表头与导航跳过卷都要卷节点前后各有正文章节
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
  leadingVolume: {
    label: "第 2 个节点为卷节点",
    check(toc) {
      const second = toc.chapters[1] as TocNode | undefined;
      if (second === undefined) {
        return { ok: false, actual: `只有 ${toc.chapters.length} 个节点` };
      }
      return second.isVolume === true
        ? { ok: true, actual: `第 2 个节点「${second.title}」为卷节点` }
        : { ok: false, actual: `第 2 个节点「${second.title}」不是卷节点` };
    },
  },
  huge: {
    label: `节点数 ≥ ${HUGE_MIN_NODES.toLocaleString("en-US")}`,
    check(toc) {
      const n = toc.chapters.length;
      return { ok: n >= HUGE_MIN_NODES, actual: `${n} 个节点` };
    },
  },
  stars: {
    label: `全部节点标题为 ${STARS_TITLE}`,
    check(toc) {
      const nodes = toc.chapters;
      // 0 个节点时"全部节点"空真成立，但这样的书承担不了 stars 用途
      if (nodes.length === 0) return { ok: false, actual: "没有节点" };
      const first = nodes.findIndex((c) => c.title !== STARS_TITLE);
      if (first === -1) {
        return { ok: true, actual: `${nodes.length} 个节点的标题均为 ${STARS_TITLE}` };
      }
      const others = nodes.filter((c) => c.title !== STARS_TITLE).length;
      return {
        ok: false,
        actual:
          `${others} 个节点的标题不是 ${STARS_TITLE}，` +
          `首个为第 ${first + 1} 个「${nodes[first].title}」`,
      };
    },
  },
  fallback: {
    label: "fallback 为 true",
    check(toc) {
      // `parseToc` 不校验 fallback 的类型，JSON 里写成别的值时照实报出
      const value: unknown = toc.fallback;
      if (value === true) return { ok: true, actual: "fallback 为 true" };
      return {
        ok: false,
        actual: value === undefined ? "未设置 fallback" : `fallback 为 ${JSON.stringify(value)}`,
      };
    },
  },
  pinyin: null,
  longText: null,
  crlf: null,
};

/** `checkRoleFeature` 的结果：一个用途的特征核对。 */
export interface RoleFeatureCheck {
  /** 被核对的用途。 */
  role: BookRole;
  /** 特征的文字描述，即 `ROLE_FEATURES[role].label`。 */
  feature: string;
  /** 是否具备该特征。 */
  ok: boolean;
  /** 实际情况的文字描述：不具备时写明差在哪里，具备时概括满足特征的依据。 */
  actual: string;
}

/**
 * 按 `ROLE_FEATURES` 核对承担 `role` 的书是否具备该用途的特征（test-data-desensitization 需求 4.2）。
 * 纯函数：只看 `_toc.json`，不读文件，不修改参数，不抛错。
 *
 * 调用方在 `ok` 为 false 时据返回值拼出错误信息
 * `[4.2] ${role} ${书 id}：${feature}（实际：${actual}）`，书 id 由调用方提供（如 `Library.role(role)`）。
 *
 * @param role 用途。
 * @param toc 承担该用途的那本书的 `_toc.json`，或只含 `chapters`（每项 `title`、`isVolume`）与
 *   `fallback` 的片段。
 * @returns 该用途无特征（pinyin、longText、crlf）时为 null；否则为核对结果，`ok` 表示是否具备。
 */
export function checkRoleFeature(role: BookRole, toc: TocShape): RoleFeatureCheck | null {
  const feature = ROLE_FEATURES[role];
  if (feature === null) return null;
  const { ok, actual } = feature.check(toc);
  return { role, feature: feature.label, ok, actual };
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
 * 读 `fixture-failed.json`。文件不存在时返回 null（本次运行的 Fixture_Generator 没有失败）；
 * 内容不合法时抛错，错误信息含文件路径与第一处不合法的字段。
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
// Library：Fixture_Library 的读取入口（lib fixture 的底层）
// ---------------------------------------------------------------------------

export interface OpenLibraryOptions {
  /** 书库根；默认 `libRootFor(profile)`。 */
  root?: string;
}

/**
 * Fixture_Library 的读取入口。以 `Library.open("fixture")` 创建，同时读入 `roles.json`
 * （文件不存在时以 `ENOENT` reject）。
 *
 * 读取结果按实例缓存（读失败的不缓存）。书 id 不在书库中时，`toc` / `gzSize` 以文件系统错误 reject。
 */
export class Library {
  readonly profile: LibraryProfile;
  readonly root: string;
  /** `roles.json` 的内容。 */
  readonly fixtureRoles: FixtureRoles;
  #books: Promise<BooksCatalog> | null = null;
  readonly #tocs = new Map<string, Promise<BookToc>>();

  private constructor(profile: LibraryProfile, root: string, fixtureRoles: FixtureRoles) {
    this.profile = profile;
    this.root = root;
    this.fixtureRoles = fixtureRoles;
  }

  static async open(profile: LibraryProfile, options: OpenLibraryOptions = {}): Promise<Library> {
    const root = path.resolve(options.root ?? libRootFor(profile));
    return new Library(profile, root, await readFixtureRoles(root));
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
   * 承担某用途的书 id，取自 `roles.json`（`fixtureRoleBookId`）。只做映射，不核对特征：特征见
   * `checkRoleFeature`，不成立时由 `fixtures.ts` 的 `lib.role()` 抛错（test-data-desensitization 需求 4.2）。
   */
  role(name: BookRole): string {
    return fixtureRoleBookId(this.fixtureRoles, name);
  }

  /** 8.13 等条目所说的"可用的书"：Fixture_Library 的全部书，按 `books.json` 的顺序。 */
  async candidateBookIds(): Promise<string[]> {
    return (await this.books()).books.map((b) => b.id);
  }
}
