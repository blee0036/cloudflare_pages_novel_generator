/**
 * E2E 用例的 fixture（设计"测试支撑（fixtures.ts）"；需求 3.9、5.5、6.1、6.4、6.5、6.9、6.12、
 * 17.2；test-data-desensitization 需求 4.2）。
 *
 * 不带前缀的条目号指 e2e-visual-testing 的需求；其他 spec 的条目写明 spec 名。
 *
 * 场景用例一律 `import { test, expect } from "../../support/fixtures"`，不直接用
 * `@playwright/test` 的 `test`；tooling 下的无浏览器用例不经本文件。
 *
 * ## 一览
 *
 * | fixture | 作用域 | 说明 |
 * | --- | --- | --- |
 * | `profile`、`mode` | worker，选项 | 项目（或文件的 `test.use`）声明的 Library_Profile 与服务模式（5.5）。`profile` 默认 `null`，即不属于任何 Library_Profile（tooling）；`mode` 默认 `opaque`，只有显式声明才是 `transparent` |
 * | `libraryState` | worker | 读 `fixture-failed.json`，打开 Fixture_Library（`Library`），对每个用途核对一次书 id 与特征（`checkLibraryRoles`）；均按 worker 缓存 |
 * | `target` | 用例，自动 | 给每个用例加 `profile`、`mode` 注解（5.5）；核对 `baseURL` 指向该组合的实例（6.11）；按 `[3.9]` 跳过（3.9） |
 * | `lib` | 用例 | 当前书库：`books()`、`toc(id)`、`gzPath(id)`、`indexHtml()`、`role(name)` 等；用途核对不成立时 `role()` 抛错（`[4.2]`，用例判失败） |
 * | `bookLog` | 用例 | 解析 `[book-load]` 控制台行，`waitFor(id, source)`；`perf` 项目下每行附为 `book-load` 附件（14.2 (e)） |
 * | `clock` | 用例 | `install()`（首次导航前，起点 `CLOCK_T0`）与 `advanceUntil(pred)`（6.4、6.5） |
 * | `idb` | 用例 | 读 `koodo_novel_cache_db/books`：键集合、某条记录 gz 的 SHA-256、各记录 gz 的字节长度 |
 * | `throttle` | 用例 | CDP 下行节流（11.1、11.5），不改响应头与字节 |
 * | `seedTheme`、`assertTheme` | 用例 | 首次导航前写入已存储主题；拍摄前断言 `data-theme` 与 `color-scheme`（6.12） |
 * | （函数）`seedProgress(context, records)` | — | 首次导航前写入阅读进度记录（7.13、7.14、7.16、7.17），不是 fixture |
 * | `shot` | 用例 | 拍摄 Review_Shot 到 `e2e/.out/review/<name>.png`，附 `review-shot`（13.5、13.10）；条目见 `e2e/review/catalog.ts` |
 * | `diagnostics` | 用例，自动 | 缓存全部 console 消息；结果与预期不符时写 `console.log` 并附 `console-log`、`step-at-end`（6.9、17.2） |
 *
 * ## 主题
 *
 * 定义里的"默认主题"指 localStorage 中没有已存储的主题（`THEME_UNSET`），不是主题键 `default`；
 * 这类截图不得 `seedTheme`，拍摄前断言应用默认主题（当前 `sepia`）。规则见 `./theme.ts`。
 *
 * ## 跳过（前缀即 Run_Summary 的归类依据）
 *
 * 本文件只有一种跳过：`[3.9]`。`fixture-failed.json` 存在（Fixture_Generator 失败）时，声明了
 * Library_Profile 的项目（fixture、fixture-transparent、perf）的全部用例跳过。它由自动 fixture
 * `target` 在浏览器上下文创建之前判定（`target` 排在 `diagnostics` 之前注册，Playwright 按注册顺序
 * 建立自动 fixture），被跳过的用例不启动浏览器。
 *
 * ## 用途核对（test-data-desensitization 需求 4.2）
 *
 * 用例按用途取书（`lib.role(name)`），书 id 取自 `roles.json`。worker fixture `libraryState` 打开
 * Fixture_Library 后，以 `checkLibraryRoles` 对 `BOOK_ROLES` 的每个用途核对一次，结果按 worker 缓存：
 *
 * 1. 书 id 列在 `books.json` 中（全部用途）；
 * 2. `_toc.json` 具备该用途的特征（`checkRoleFeature`；只有 `ROLE_FEATURES` 中有特征的用途）。
 *
 * `lib.role(name)` 返回书 id 之前先查这份结果（`roleBookId`），不成立即抛错，用例判失败而不是跳过。
 * 错误信息为 `[4.2] <用途> <书 id>：<特征>（实际：…）`，`<特征>` 是第一项不成立的核对。`books.json`
 * 或 `_toc.json` 读不出来时也记为该项不成立，"实际"写读取错误：只有取用该用途的用例失败，
 * worker 本身照常建立。
 *
 * ## 浏览器存储（6.1）
 *
 * 每个用例使用 Playwright 默认的全新上下文，本文件不复用上下文；`seedTheme` 写入的只是该用例
 * 自己上下文里的 localStorage。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test as base } from "@playwright/test";
import type { BrowserContext, CDPSession, ConsoleMessage, Locator, Page, TestInfo } from "@playwright/test";
import type { BookSummary, BooksCatalog, BookToc, ReaderThemeKey, ReadingProgress } from "../../src/types";
import { THEME_ATTRIBUTE } from "../../src/utils/theme";
import { parseBookLoadLine, type BookLoadLine } from "../perf/metrics";
import {
  REVIEW_DIR,
  describeViewport,
  pageMatchesShotUrl,
  resolveShotBook,
  resolveShotUrl,
  reviewShot,
  reviewShotFile,
  sameShotTest,
  shotTestRef,
  type ReviewShotName,
} from "../review/catalog";
import type { Mode } from "../server/resolve";
import {
  BOOK_ROLES,
  Library,
  ROLE_FEATURES,
  booksJsonPath,
  checkRoleFeature,
  fixtureFailedSkipReason,
  readFixtureFailed,
  repoRelative,
  type BookRole,
  type FixtureRoles,
  type LibraryProfile,
  type TocFacts,
} from "./library";
import { CLOCK_STEP_MS, CLOCK_T0, PORTS, THROTTLE_BYTES_PER_SEC, TIMEOUTS, VIEWPORTS } from "./settings";
import { step, stepAtEnd } from "./step";
import type { ProjectName } from "./summary";
import { THEME_COLOR_SCHEME, expectedDataTheme, themeToSeed } from "./theme";

export { expect, THEME_COLOR_SCHEME };

/** 仓库根（本文件位于 `e2e/support/`）。 */
const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

/**
 * App_Build 的 `index.html`，即 E2E_Server 的回退字节（5.6）。与 `build-app.ts` 的
 * `APP_BUILD_DIR` 是同一目录；不从那里导入，否则每个 worker 都会加载 Vite。
 */
const APP_INDEX_HTML = path.join(REPO_ROOT, "e2e", ".out", "app", "index.html");

/** E2E_Server 监听的地址（与 `server.ts` 的 `HOST` 相同，5.8）。 */
const E2E_HOST = "127.0.0.1";

/** 阅读器设置的 localStorage 键（`src/utils/storage.ts` 的 `SETTINGS_KEY`，未导出）。 */
export const READER_SETTINGS_KEY = "koodo_novel_reader_settings";

/** 离线缓存的库名与表名（`src/utils/indexedDB.ts` 的 `DB_NAME`、`STORE_NAME`，未导出）。 */
const CACHE_DB_NAME = "koodo_novel_cache_db";
const CACHE_STORE_NAME = "books";

/** 用例注解的类型名（5.5）。reporter 据此读出每个用例的 Library_Profile 与模式。 */
export const ANNOTATIONS = { profile: "profile", mode: "mode" } as const;

/** 本文件写出的附件名。reporter 按名称收集。 */
export const ATTACHMENTS = {
  /** 失败类用例的浏览器控制台日志：`path` 指向文件；写入失败时 `body` 为"未生成（原因）"（17.2）。 */
  consoleLog: "console-log",
  /** 失败类用例结束时所处的步骤，JSON 为 `StepAtEnd`（6.9、17.2）。 */
  stepAtEnd: "step-at-end",
  /** `perf` 项目下每条 `[book-load]` 行（或一次未采集的打开），JSON 为 `BookLoadAttachment`（14.2 (e)）。 */
  bookLoad: "book-load",
  /** 每次 `shot()` 拍摄一条，`body` 为 Review_Shot 名称（13.3、13.11）。 */
  reviewShot: "review-shot",
} as const;

/**
 * 每个 Library_Profile × 模式组合的实例端口（5.12）；端口号只取自 `settings.ts` 的 `PORTS`。
 * `perf` 项目与 `fixture` 项目共用 fixture 的 Opaque_Mode 实例。
 */
const INSTANCE_PORTS: Readonly<Record<LibraryProfile, Readonly<Record<Mode, number>>>> = {
  fixture: { opaque: PORTS.fixtureOpaque, transparent: PORTS.fixtureTransparent },
};

/**
 * 写 `book-load` 附件的 Playwright 项目（`playwright.config.ts`）：Perf_Metrics 的 (e) 只收 perf
 * 用例的 `[book-load]` 行（`e2e/perf/report.ts`），其余项目的 `bookLog` 只解析、不附件。
 */
const BOOK_LOAD_PROJECT: ProjectName = "perf";

/** 某个组合的 E2E_Server 实例的源（`http://127.0.0.1:<port>`，不带结尾 `/`）。`playwright.config.ts` 的 `baseURL` 取它。 */
export function serverOrigin(profile: LibraryProfile, mode: Mode): string {
  return `http://${E2E_HOST}:${INSTANCE_PORTS[profile][mode]}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 项目级选项（`playwright.config.ts` 的 `use`，或文件内的 `test.use`）。均为 worker 作用域。 */
export interface E2EWorkerOptions {
  /** 本项目的 Library_Profile；`null` 表示不属于任何 Library_Profile（tooling），此时不注解、不跳过。 */
  profile: LibraryProfile | null;
  /** 本项目的服务模式，默认 `opaque`（5.5）。 */
  mode: Mode;
}

/** 当前用例所用的 Library_Profile、模式与实例源（`target` fixture 的值）。 */
export interface RunTarget {
  profile: LibraryProfile;
  mode: Mode;
  /** `serverOrigin(profile, mode)`，已核对与 `baseURL` 相同。 */
  origin: string;
}

/** 一项不成立的用途核对（test-data-desensitization 需求 4.2）。 */
export interface RoleCheckFailure {
  /** 不成立的核对项：`LISTED_FEATURE`，或该用途在 `ROLE_FEATURES` 中的特征描述。 */
  feature: string;
  /** 实际情况，如 `checkRoleFeature` 的 `actual`，或读取 `books.json` / `_toc.json` 的错误。 */
  actual: string;
}

/** 一个用途的核对结果（`checkLibraryRoles`）。 */
export interface RoleCheck {
  role: BookRole;
  /** 承担该用途的书 id（`Library.role(role)`，取自 `roles.json`）。 */
  id: string;
  /** 第一项不成立的核对；全部成立时为 null。 */
  failure: RoleCheckFailure | null;
}

/** 每个用途的核对结果，键为 `BOOK_ROLES` 的全部用途。 */
export type RoleChecks = Readonly<Record<BookRole, RoleCheck>>;

/** 一个 worker 内当前书库的状态。 */
export interface LibraryState {
  profile: LibraryProfile;
  /** `[3.9]` 跳过原因；为 null 时书库可用。 */
  skipReason: string | null;
  /** 书库可用时的读取入口；`skipReason` 非 null 时为 null。 */
  library: Library | null;
  /** 书库可用时每个用途的核对结果（按 worker 缓存）；`skipReason` 非 null 时为 null。 */
  roles: RoleChecks | null;
}

/** `lib` fixture：当前 Library_Profile 的书库（只读）。期望值一律运行时推导（4.4）。 */
export interface Lib {
  readonly profile: LibraryProfile;
  /** `data/books.json`（按 worker 缓存，不要修改返回值）。 */
  books(): Promise<BooksCatalog>;
  /** `books.json` 中的一本书；未列出时 reject。 */
  book(id: string): Promise<BookSummary>;
  /** `data/<id>_toc.json`（按 worker 缓存）。 */
  toc(id: string): Promise<BookToc>;
  /** 由 `_toc.json` 推导的节点数、卷位置、标题等（4.4）。 */
  tocFacts(id: string): Promise<TocFacts>;
  /** `books/<id>.txt.gz` 的绝对路径（不核对是否存在）。 */
  gzPath(id: string): string;
  /** `.txt.gz` 的字节数。 */
  gzSize(id: string): Promise<number>;
  /** App_Build 的 `index.html` 字节，即 E2E_Server 的 SPA 回退响应体（5.6）。 */
  indexHtml(): Promise<Buffer>;
  /**
   * 承担某用途的书 id（`roles.json`）。返回之前查 worker 内缓存的用途核对结果：书 id 未列在
   * `books.json` 中，或该书不具备用途的特征时抛错，用例判失败（test-data-desensitization 需求 4.2），
   * 错误信息为 `[4.2] <用途> <书 id>：<特征>（实际：…）`。
   */
  role(name: BookRole): string;
  /** Fixture_Library 的 `roles.json`（同作者、最近阅读、检索词等非单本书的用途）。 */
  fixtureRoles(): FixtureRoles;
  /** 8.13 等条目所说的"可用的书"：Fixture_Library 的全部书，按 `books.json` 的顺序。 */
  candidateBookIds(): Promise<string[]>;
}

/** `book-load` 附件的内容（`perf` 项目下每条一份，按出现顺序）。reporter 据此写 Perf_Metrics 的 (e)。 */
export type BookLoadAttachment =
  | (BookLoadLine & {
      /** 该行出现时页面的视口；页面没有固定视口时为 null。 */
      viewport: { width: number; height: number } | null;
      /** 该行出现时 `<html>` 的 `data-theme`；读取失败时为 null。 */
      theme: string | null;
    })
  | { bookId: string; status: "uncollected"; reason: string };

export interface BookLogWaitOptions {
  /** 只看第 `since` 条（从 0 起）及以后的行；取 `bookLog.count` 作为标记，用于重载后等下一条。默认 0。 */
  since?: number;
  /** 等待上限（毫秒，真实时间），默认 `TIMEOUTS.wait`；等 gz ≥ 20 MB 的书时传 `TIMEOUTS.bigBookLoad`。 */
  timeout?: number;
}

/** `bookLog` fixture：当前页面的 `[book-load]` 行（14.2 (e)、19.2）。 */
export interface BookLog {
  /** 已收到的行数。 */
  readonly count: number;
  /** 已收到的全部行（副本），按出现顺序。 */
  all(): BookLoadLine[];
  /** 第 `since` 条及以后、书 id 为 `id`（且 `source` 相同，若给出）的第一条；没有时为 undefined。可用作 `advanceUntil` 的条件。 */
  find(id: string, source?: string, since?: number): BookLoadLine | undefined;
  /** 等到一条匹配的行（已收到的也算，见 `since`）；超时即 reject。 */
  waitFor(id: string, source?: string, options?: BookLogWaitOptions): Promise<BookLoadLine>;
  /** `perf` 项目下记一次未采集的打开（附为 `book-load`，`status: "uncollected"`，14.7）；其余项目不记录。 */
  uncollected(id: string, reason: string): void;
}

export interface AdvanceUntilOptions {
  /** Controlled_Clock 推进总量的上限（毫秒），默认 `TIMEOUTS.wait`。 */
  capMs?: number;
  /** 每步推进的时长（毫秒），默认 `CLOCK_STEP_MS`。 */
  stepMs?: number;
  /** 超出上限时报错信息里的条件说明。 */
  message?: string;
}

/** `clock` fixture：Controlled_Clock（6.4、6.5）。直接控制时钟（`pauseAt`、`runFor`）仍用 `page.clock`。 */
export interface ClockControl {
  /** 本用例是否已安装 Controlled_Clock。 */
  readonly installed: boolean;
  /** 安装 Controlled_Clock，起点默认 `CLOCK_T0`。须在首次导航之前调用，同一用例只调用一次。 */
  install(time?: number | string | Date): Promise<void>;
  /**
   * 以 `runFor(stepMs)` 为步长推进，直到 `pred()` 为真，返回推进的总毫秒数（条件一开始就成立时为 0）。
   * 推进满 `capMs` 仍不成立即抛错。`pred` 应立即给出结果（如 `locator.count()`、`bookLog.find()`），
   * 不要在其中做自动等待。
   */
  advanceUntil(pred: () => boolean | Promise<boolean>, options?: AdvanceUntilOptions): Promise<number>;
}

/** `idb.gzSizes()` 的一项：某条记录所存 `gz` 的字节长度。 */
export interface IdbGzSize {
  bookId: string;
  /** 记录中 `gz`（ArrayBuffer）的 `byteLength`，不是记录里的冗余字段 `bytes`。 */
  gzBytes: number;
}

/** `idb` fixture：只读查看当前页面源的离线缓存（`koodo_novel_cache_db` / `books`）。页面须已在应用的源上。 */
export interface IdbProbe {
  /** 全部记录的键（书 id），升序；库或表不存在时为空数组（不会因此创建库）。 */
  keys(): Promise<string[]>;
  /** 某条记录 `gz` 的 SHA-256（小写十六进制，`crypto.subtle`）；没有该记录时为 null。 */
  gzSha256(bookId: string): Promise<string | null>;
  /**
   * 全部记录所存 `gz` 的字节长度，按书 id 升序（11.6 的 S）；库或表不存在时为空数组。
   * 会把每条记录（含 gz）读进页面内存，只适合 fixture 这样的小书。
   */
  gzSizes(): Promise<IdbGzSize[]>;
}

/** `throttle` fixture：对当前页面施加 CDP 下行节流（默认 `THROTTLE_BYTES_PER_SEC`），不改响应头与字节。 */
export type Throttle = (bytesPerSecond?: number) => Promise<void>;

/** `step-at-end` 附件的内容（6.9、17.2）。 */
export interface StepAtEnd {
  /** 失败或超时所处的步骤路径（`外层 › 内层`），或"无具名步骤"。 */
  step: string;
  /** 生效的超时值（`test.setTimeout` 之后）。 */
  timeoutMs: number;
}

/** `shot()` 的选项。 */
export interface ShotOptions {
  /** 截取范围为 `element` 的条目必须给出要截取的元素（经 `locators.ts` 定位）；其余条目不得给出。 */
  element?: Locator;
}

/** `shot` fixture：拍摄 Review_Shot（需求 6.3、6.12、13.5、13.10）。条目见 `e2e/review/catalog.ts`。 */
export interface Shot {
  /**
   * 拍摄 `name`：写 `e2e/.out/review/<name>.png`，附一条 `review-shot` 附件（`body` 为名称），返回 true。
   * 条目的 Library_Profile 与当前项目不同时不拍摄、不附附件，返回 false（全部条目都是 fixture，
   * 只剩一个 Library_Profile 时这一分支只是兜底）。
   *
   * 以下情形使用例失败且不拍摄：调用它的用例不是条目的 `by`（与 profile 无关，每次都核对）；
   * 服务器模式、视口或页面 URL 与条目不符；条目为默认主题（`THEME_UNSET`）而本上下文调用过
   * `seedTheme`；页面不是 `prefers-reduced-motion: reduce`（6.3）或设备像素比不为 1（13.10）；
   * `data-theme` / `color-scheme` 断言不成立（6.12）。
   */
  (name: ReviewShotName, options?: ShotOptions): Promise<boolean>;
  /** 当前项目是否拍摄 `name`（Library_Profile 相同）。common 用例据此只在拍摄时准备画面。 */
  applies(name: ReviewShotName): boolean;
}

export interface E2ETestFixtures {
  target: RunTarget | null;
  lib: Lib;
  bookLog: BookLog;
  clock: ClockControl;
  idb: IdbProbe;
  throttle: Throttle;
  /** 在首次导航前把已存储主题写为 `theme`（`seedTheme(context, theme)`）。 */
  seedTheme: (theme: ReaderThemeKey) => Promise<void>;
  /** 断言当前页面的主题（`assertTheme(page, theme)`，6.12）。 */
  assertTheme: (theme: ReaderThemeKey) => Promise<void>;
  /** 拍摄 Review_Shot（`Shot`）。 */
  shot: Shot;
  diagnostics: void;
}

export interface E2EWorkerFixtures extends E2EWorkerOptions {
  libraryState: LibraryState | null;
}

// ---------------------------------------------------------------------------
// 书库（3.9）与用途核对（test-data-desensitization 4.2）
// ---------------------------------------------------------------------------

/** 每个用途都核对的一项：书 id 列在 `books.json` 中（`RoleCheckFailure.feature` 的取值之一）。 */
export const LISTED_FEATURE = "书 id 列在 books.json 中";

/** `books.json` 列出的书 id；读不出来时为读取错误的说明。 */
type ListedIds = { ok: true; ids: ReadonlySet<string> } | { ok: false; actual: string };

async function listedBookIds(library: Library): Promise<ListedIds> {
  try {
    return { ok: true, ids: new Set((await library.books()).books.map((b) => b.id)) };
  } catch (error) {
    return { ok: false, actual: `无法读取 books.json：${errorText(error)}` };
  }
}

/** 核对一个用途：先核对书 id 列在 `books.json` 中，再按 `checkRoleFeature` 核对特征（有特征时）。 */
async function checkRole(library: Library, role: BookRole, listed: ListedIds): Promise<RoleCheck> {
  const id = library.role(role);
  const failed = (feature: string, actual: string): RoleCheck => ({ role, id, failure: { feature, actual } });

  if (!listed.ok) return failed(LISTED_FEATURE, listed.actual);
  if (!listed.ids.has(id)) {
    return failed(LISTED_FEATURE, `${repoRelative(booksJsonPath(library.root))} 未列出该书`);
  }

  const feature = ROLE_FEATURES[role];
  if (feature === null) return { role, id, failure: null };
  let toc: BookToc;
  try {
    toc = await library.toc(id);
  } catch (error) {
    return failed(feature.label, `无法读取 _toc.json：${errorText(error)}`);
  }
  const check = checkRoleFeature(role, toc);
  return check === null || check.ok ? { role, id, failure: null } : failed(check.feature, check.actual);
}

/**
 * 对 `BOOK_ROLES` 的每个用途核对一次（test-data-desensitization 需求 4.2，见文件头"用途核对"）。
 * 只读：`books.json` 与各本 `_toc.json` 经 `library` 读取，解析结果随 `library` 缓存。不因核对不成立
 * 或读取失败而 reject，结果逐项记在返回值里，由 `roleBookId` 在取用时抛错。
 */
export async function checkLibraryRoles(library: Library): Promise<RoleChecks> {
  const listed = await listedBookIds(library);
  const checks = await Promise.all(BOOK_ROLES.map((role) => checkRole(library, role, listed)));
  return Object.fromEntries(checks.map((c) => [c.role, c])) as Record<BookRole, RoleCheck>;
}

/** 核对不成立时 `lib.role()` 抛出的错误信息：`[4.2] <用途> <书 id>：<特征>（实际：…）`；成立时为 null。 */
function roleCheckMessage({ role, id, failure }: RoleCheck): string | null {
  return failure === null ? null : `[4.2] ${role} ${id}：${failure.feature}（实际：${failure.actual}）`;
}

/**
 * `lib.role(name)` 的实现：核对成立时返回承担该用途的书 id（即 `Library.role(name)`），不成立时以
 * `[4.2] <用途> <书 id>：<特征>（实际：…）` 抛错（用例判失败，不跳过）。
 */
export function roleBookId(roles: RoleChecks, name: BookRole): string {
  const check = roles[name];
  const message = roleCheckMessage(check);
  if (message !== null) throw new Error(message);
  return check.id;
}

async function loadLibraryState(profile: LibraryProfile): Promise<LibraryState> {
  const failure = await readFixtureFailed();
  if (failure !== null) {
    return { profile, skipReason: fixtureFailedSkipReason(failure), library: null, roles: null };
  }
  const library = await Library.open(profile);
  return { profile, skipReason: null, library, roles: await checkLibraryRoles(library) };
}

function createLib(library: Library, roles: RoleChecks): Lib {
  let indexHtml: Promise<Buffer> | null = null;
  return {
    profile: library.profile,
    books: () => library.books(),
    book: (id) => library.book(id),
    toc: (id) => library.toc(id),
    tocFacts: (id) => library.tocFacts(id),
    gzPath: (id) => library.gzPath(id),
    gzSize: (id) => library.gzSize(id),
    indexHtml() {
      if (indexHtml === null) indexHtml = readFile(APP_INDEX_HTML);
      return indexHtml;
    },
    role: (name) => roleBookId(roles, name),
    fixtureRoles: () => library.fixtureRoles,
    candidateBookIds: () => library.candidateBookIds(),
  };
}

// ---------------------------------------------------------------------------
// [book-load] 日志（14.2 (e)）
// ---------------------------------------------------------------------------

/** `promise` 在 `ms` 内结算则取其值，否则（或 reject 时）取 `fallback`。只用于给读数设上限，不是等待。 */
function settleWithin<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/** 一条 `[book-load]` 行出现时的视口与主题（14.2 的"桌面视口、默认主题"条件由 reporter 过滤）。 */
async function describeBookLoad(page: Page, line: BookLoadLine): Promise<BookLoadAttachment> {
  const viewport = page.viewportSize();
  const theme = await settleWithin(
    page.evaluate((attr) => document.documentElement.getAttribute(attr), THEME_ATTRIBUTE),
    TIMEOUTS.wait,
    null,
  );
  return { ...line, viewport, theme };
}

function createBookLog(
  page: Page,
  recordAttachments: boolean,
): { log: BookLog; dispose(): Promise<BookLoadAttachment[]> } {
  const lines: BookLoadLine[] = [];
  const attachments: Promise<BookLoadAttachment>[] = [];
  const waiters = new Set<{ check(): void; cancel(): void }>();

  const find = (id: string, source?: string, since = 0): BookLoadLine | undefined =>
    lines.slice(since).find((l) => l.bookId === id && (source === undefined || l.source === source));

  const onConsole = (msg: ConsoleMessage): void => {
    const line = parseBookLoadLine(msg.text());
    if (line === null) return;
    lines.push(line);
    if (recordAttachments) attachments.push(describeBookLoad(page, line));
    for (const waiter of [...waiters]) waiter.check();
  };
  page.on("console", onConsole);

  const log: BookLog = {
    get count() {
      return lines.length;
    },
    all: () => [...lines],
    find,
    waitFor(id, source, options = {}) {
      const since = options.since ?? 0;
      const timeout = options.timeout ?? TIMEOUTS.wait;
      const hit = find(id, source, since);
      if (hit) return Promise.resolve(hit);
      return new Promise<BookLoadLine>((resolve, reject) => {
        const waiter = {
          check() {
            const found = find(id, source, since);
            if (found === undefined) return;
            waiter.cancel();
            resolve(found);
          },
          cancel() {
            clearTimeout(timer);
            waiters.delete(waiter);
          },
        };
        const timer = setTimeout(() => {
          waiter.cancel();
          const what = source === undefined ? id : `${id} source=${source}`;
          reject(new Error(`等待 [book-load] ${what} 超时（${timeout} ms，自第 ${since} 条起）`));
        }, timeout);
        waiters.add(waiter);
      });
    },
    uncollected(id, reason) {
      if (recordAttachments) attachments.push(Promise.resolve({ bookId: id, status: "uncollected", reason }));
    },
  };

  return {
    log,
    async dispose() {
      page.off("console", onConsole);
      // 用例已结束：未结算的 waitFor 不再结算（不 reject，免得被放弃的用例体留下未处理的拒绝）
      for (const waiter of [...waiters]) waiter.cancel();
      return Promise.all(attachments);
    },
  };
}

// ---------------------------------------------------------------------------
// Controlled_Clock（6.4、6.5）
// ---------------------------------------------------------------------------

function createClock(page: Page): ClockControl {
  let installed = false;
  return {
    get installed() {
      return installed;
    },
    async install(time = CLOCK_T0) {
      if (installed) throw new Error("Controlled_Clock 已安装；同一用例只安装一次");
      if (page.url() !== "about:blank") {
        throw new Error(`clock.install() 须在首次导航之前调用（需求 6.4）；页面已在 ${page.url()}`);
      }
      await page.clock.install({ time });
      installed = true;
    },
    async advanceUntil(pred, options = {}) {
      if (!installed) throw new Error("clock.advanceUntil() 之前须先 clock.install()");
      const capMs = options.capMs ?? TIMEOUTS.wait;
      const stepMs = options.stepMs ?? CLOCK_STEP_MS;
      if (!(stepMs > 0)) throw new Error(`stepMs 须为正数，实际为 ${stepMs}`);
      let advanced = 0;
      while (!(await pred())) {
        if (advanced >= capMs) {
          throw new Error(
            `${options.message ?? "等待的条件"}：Controlled_Clock 推进 ${advanced} ms 后仍未满足（上限 ${capMs} ms）`,
          );
        }
        const ms = Math.min(stepMs, capMs - advanced);
        await page.clock.runFor(ms);
        advanced += ms;
      }
      return advanced;
    },
  };
}

// ---------------------------------------------------------------------------
// IndexedDB（11.2、11.3、11.6–11.8）
// ---------------------------------------------------------------------------

type IdbQuery = { db: string; store: string } & (
  | { op: "keys" }
  | { op: "sha256"; id: string }
  | { op: "sizes" }
);

/**
 * 在页面内执行（`page.evaluate`），不得引用本模块的任何标识符。
 *
 * 不带版本号打开库：库已存在时按其当前版本打开，不触发升级；库不存在时 `onupgradeneeded` 会
 * 被调用，此时中止升级事务，浏览器随之删除这个刚建的空库，页面的 IndexedDB 保持原样。
 */
async function idbInPage(q: IdbQuery): Promise<string[] | string | null | IdbGzSize[]> {
  const empty = q.op === "sha256" ? null : [];
  const db = await new Promise<IDBDatabase | null>((resolve, reject) => {
    let creating = false;
    const req = indexedDB.open(q.db);
    req.onupgradeneeded = () => {
      creating = true;
      req.transaction?.abort();
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = (event) => {
      if (creating) {
        event.preventDefault();
        resolve(null);
      } else {
        reject(req.error ?? new Error(`indexedDB.open(${q.db}) 失败`));
      }
    };
  });
  if (db === null) return empty;
  try {
    if (!db.objectStoreNames.contains(q.store)) return empty;
    const store = db.transaction(q.store, "readonly").objectStore(q.store);
    const settle = <T>(r: IDBRequest<T>): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    if (q.op === "keys") {
      const keys = await settle(store.getAllKeys());
      return keys.map((k) => String(k)).sort();
    }
    if (q.op === "sizes") {
      const [keys, records] = await Promise.all([settle(store.getAllKeys()), settle(store.getAll())]);
      const sizes = records.map((record: unknown, i) => {
        const id = String(keys[i]);
        const gz = (record as { gz?: unknown }).gz;
        if (!(gz instanceof ArrayBuffer)) throw new Error(`记录 ${id} 的 gz 不是 ArrayBuffer`);
        return { bookId: id, gzBytes: gz.byteLength };
      });
      return sizes.sort((a, b) => (a.bookId < b.bookId ? -1 : a.bookId > b.bookId ? 1 : 0));
    }
    const record: unknown = await settle(store.get(q.id));
    if (record === undefined) return null;
    const gz = (record as { gz?: unknown }).gz;
    if (!(gz instanceof ArrayBuffer)) throw new Error(`记录 ${q.id} 的 gz 不是 ArrayBuffer`);
    const digest = await crypto.subtle.digest("SHA-256", gz);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  } finally {
    db.close();
  }
}

/**
 * `idb` fixture 的实现，也供不经 fixture 参数、只拿到 `page` 的代码使用（如 Pixel_Baseline 的
 * `prepare(page)`，`e2e/visual/baselines.ts`）。页面须已在应用的源上。
 */
export function createIdbProbe(page: Page): IdbProbe {
  const where = { db: CACHE_DB_NAME, store: CACHE_STORE_NAME };
  return {
    async keys() {
      const query: IdbQuery = { ...where, op: "keys" };
      return (await page.evaluate(idbInPage, query)) as string[];
    },
    async gzSha256(bookId) {
      const query: IdbQuery = { ...where, op: "sha256", id: bookId };
      return (await page.evaluate(idbInPage, query)) as string | null;
    },
    async gzSizes() {
      const query: IdbQuery = { ...where, op: "sizes" };
      return (await page.evaluate(idbInPage, query)) as IdbGzSize[];
    },
  };
}

// ---------------------------------------------------------------------------
// 主题（6.12）
// ---------------------------------------------------------------------------

/** 每个浏览器上下文最近一次 `seedTheme` 写入的主题键。 */
const seededThemes = new WeakMap<BrowserContext, ReaderThemeKey>();

/** 本上下文经 `seedTheme` 写入过的主题键（最近一次）；没有调用过时为 undefined。 */
export function seededTheme(context: BrowserContext): ReaderThemeKey | undefined {
  return seededThemes.get(context);
}

/**
 * 在 `context` 的首次导航之前，把已存储主题写为 `theme`（`addInitScript`，写入 `src/` 的设置键
 * `koodo_novel_reader_settings`）。
 *
 * 只在该键尚不存在时写入：初始脚本在每次导航（含重载）都会执行，应用或用例此后改过的设置不会被
 * 它覆盖回去。写入的只有 `theme` 一个字段，其余设置按应用的默认值浅合并（`getStoredSettings`）。
 *
 * 注意：存储为空时应用的主题是 `DEFAULT_SETTINGS.theme`（sepia），不是 `default`；需要 `default`
 * 主题的截图同样要调用本函数。反过来，定义为"默认主题"（`THEME_UNSET`）的截图不得调用本函数，
 * `shot()` 据 `seededTheme(context)` 核对（见 `./theme.ts`）。
 */
export async function seedTheme(context: BrowserContext, theme: ReaderThemeKey): Promise<void> {
  const navigated = context.pages().find((p) => p.url() !== "about:blank");
  if (navigated !== undefined) {
    throw new Error(`seedTheme() 须在首次导航之前调用；页面已在 ${navigated.url()}`);
  }
  seededThemes.set(context, theme);
  await context.addInitScript(
    ({ key, value }) => {
      try {
        if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, value);
      } catch {
        // about:blank 等不透明源没有 localStorage，跳过
      }
    },
    { key: READER_SETTINGS_KEY, value: JSON.stringify({ theme }) },
  );
}

/** `<html>` 的 `data-theme` 与计算样式 `color-scheme`。 */
function readThemeState(page: Page): Promise<{ theme: string | null; colorScheme: string }> {
  return page.evaluate((attr) => {
    const root = document.documentElement;
    return {
      theme: root.getAttribute(attr),
      colorScheme: getComputedStyle(root).getPropertyValue("color-scheme").trim(),
    };
  }, THEME_ATTRIBUTE);
}

/**
 * 断言 `<html>` 的 `data-theme` 等于 `theme`，且计算样式 `color-scheme` 与该主题的明暗一致
 * （6.12），与 `colorScheme: light` 的仿真无关。不成立即抛出断言错误（等待上限为 expect 超时）。
 * 拍摄 Pixel_Baseline 对比截图、Review_Shot 与对比度扫描前调用。
 */
export async function assertTheme(page: Page, theme: ReaderThemeKey): Promise<void> {
  const expected = { theme, colorScheme: THEME_COLOR_SCHEME[theme] };
  await step(`断言主题 ${theme}（data-theme 与 color-scheme）`, async () => {
    await expect
      .poll(() => readThemeState(page), {
        message: `<html> 的 data-theme 应为 ${theme}，color-scheme 应为 ${expected.colorScheme}（需求 6.12）`,
      })
      .toEqual(expected);
  });
}

// ---------------------------------------------------------------------------
// 阅读进度（7.13、7.14、7.16、7.17）
// ---------------------------------------------------------------------------

/** 阅读进度的 localStorage 键前缀（`src/utils/storage.ts` 的 `PROGRESS_PREFIX`，未导出）。 */
export const PROGRESS_KEY_PREFIX = "koodo_novel_progress_";

/**
 * 在 `context` 的首次导航之前写入阅读进度记录（`addInitScript`）：每条一个键
 * `koodo_novel_progress_<bookId>`，值为记录的 JSON。应用以键名里的书 id 为准（`readProgress`），
 * 这里的键名取自记录的 `bookId`，两者一致。
 *
 * 与 `seedTheme` 相同，只在键尚不存在时写入：初始脚本在每次导航（含重载）都会执行，应用此后
 * 改写的进度不会被它覆盖回去。同一本书给出多条记录即抛错（每书只有一个键）。
 */
export async function seedProgress(
  context: BrowserContext,
  records: readonly ReadingProgress[],
): Promise<void> {
  const navigated = context.pages().find((p) => p.url() !== "about:blank");
  if (navigated !== undefined) {
    throw new Error(`seedProgress() 须在首次导航之前调用；页面已在 ${navigated.url()}`);
  }
  const duplicated = records.map((r) => r.bookId).filter((id, i, ids) => ids.indexOf(id) !== i);
  if (duplicated.length > 0) {
    throw new Error(`seedProgress() 的记录中同一本书出现多次：${[...new Set(duplicated)].join("、")}`);
  }
  const pairs: [string, string][] = records.map((r) => [`${PROGRESS_KEY_PREFIX}${r.bookId}`, JSON.stringify(r)]);
  await context.addInitScript((entries) => {
    for (const [key, value] of entries) {
      try {
        if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, value);
      } catch {
        // about:blank 等不透明源没有 localStorage，跳过
      }
    }
  }, pairs);
}

// ---------------------------------------------------------------------------
// Review_Shot（6.3、6.12、13.5、13.10）
// ---------------------------------------------------------------------------

function decodedUrl(url: string): string {
  try {
    return decodeURI(url);
  } catch {
    return url;
  }
}

function createShot(
  page: Page,
  target: RunTarget | null,
  libraryState: LibraryState | null,
  testInfo: TestInfo,
): Shot {
  const requireTarget = (): RunTarget => {
    if (target === null) {
      throw new Error("shot 只能用在声明了 Library_Profile 的项目中（fixture、fixture-transparent、perf）");
    }
    return target;
  };

  const applies = (name: ReviewShotName): boolean => reviewShot(name).profile === requireTarget().profile;

  const capture = async (name: ReviewShotName, options: ShotOptions = {}): Promise<boolean> => {
    const def = reviewShot(name);
    const run = requireTarget();
    const here = shotTestRef(testInfo.file, testInfo.title);
    if (!sameShotTest(here, def.by)) {
      throw new Error(
        `${name}（${def.rs}）应由 ${def.by.file} 的「${def.by.title}」拍摄，` +
          `当前用例是 ${here.file} 的「${here.title}」；用例标题请取自 catalog.ts 的 SHOT_TESTS`,
      );
    }
    if (def.profile !== run.profile) return false;

    return step(`拍摄 Review_Shot ${name}`, async () => {
      const problems: string[] = [];

      if (def.mode !== run.mode) {
        problems.push(`服务器模式应为 ${def.mode}，当前项目为 ${run.mode}（5.5）`);
      }
      const want = VIEWPORTS[def.viewport];
      const viewport = page.viewportSize();
      if (viewport === null || viewport.width !== want.width || viewport.height !== want.height) {
        const actual = viewport === null ? "未固定" : `${viewport.width}×${viewport.height}`;
        problems.push(`视口应为 ${describeViewport(def.viewport)}，当前为 ${actual}（6.2）`);
      }
      if (def.scope === "element" && options.element === undefined) {
        problems.push("截取范围为元素，须以 options.element 给出要截取的元素");
      }
      if (def.scope !== "element" && options.element !== undefined) {
        problems.push(`截取范围为 ${def.scope}，不得给出 options.element`);
      }

      const seeded = seededTheme(page.context());
      if (themeToSeed(def.theme) === null && seeded !== undefined) {
        problems.push(`条目为默认主题（localStorage 中没有已存储的主题），本上下文却 seedTheme 过 ${seeded}`);
      }

      const bookId = resolveShotBook(def, libraryState?.library?.fixtureRoles ?? null);
      const url = resolveShotUrl(def, bookId);
      if (def.book !== null && bookId === null) {
        problems.push(`无法解析条目的书 id（${JSON.stringify(def.book)}）`);
      } else if (!pageMatchesShotUrl(page.url(), url)) {
        problems.push(`页面应在 ${url}（可多带查询参数），当前为 ${decodedUrl(page.url())}`);
      }

      const env = await page.evaluate(() => ({
        reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
        dpr: window.devicePixelRatio,
      }));
      if (!env.reducedMotion) {
        problems.push("页面不是 prefers-reduced-motion: reduce（6.3：以 no-preference 运行的用例不拍摄 Review_Shot）");
      }
      if (env.dpr !== 1) problems.push(`设备像素比应为 1，当前为 ${env.dpr}（13.10）`);

      if (problems.length > 0) {
        throw new Error(`不拍摄 ${name}（${def.rs}）：${problems.join("；")}`);
      }

      // 6.12：主题断言不成立即失败，不拍摄
      await assertTheme(page, expectedDataTheme(def.theme));

      const file = reviewShotFile(name);
      await mkdir(REVIEW_DIR, { recursive: true });
      // 6.3：有限动画直接呈现结束状态、无限动画取消；隐藏插入符。不加遮罩、不注入样式（13.5）
      const settings = { path: file, animations: "disabled", caret: "hide" } as const;
      if (options.element !== undefined) {
        await options.element.screenshot(settings);
      } else {
        await page.screenshot({ ...settings, fullPage: def.scope === "fullPage" });
      }
      await testInfo.attach(ATTACHMENTS.reviewShot, { body: name, contentType: "text/plain" });
      return true;
    });
  };

  return Object.assign(capture, { applies });
}

// ---------------------------------------------------------------------------
// 失败诊断（6.9、17.2）
// ---------------------------------------------------------------------------

/** 写 `console.log` 并附 `console-log`；写入失败时附一条"未生成（原因）"，不改变用例结果。 */
async function attachConsoleLog(testInfo: TestInfo, lines: readonly string[]): Promise<void> {
  const file = testInfo.outputPath("console.log");
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, lines.length > 0 ? `${lines.join("\n")}\n` : "", "utf8");
  } catch (error) {
    await testInfo.attach(ATTACHMENTS.consoleLog, {
      body: `未生成（${errorText(error)}）`,
      contentType: "text/plain",
    });
    return;
  }
  await testInfo.attach(ATTACHMENTS.consoleLog, { path: file, contentType: "text/plain" });
}

// ---------------------------------------------------------------------------
// test
// ---------------------------------------------------------------------------

export const test = base.extend<E2ETestFixtures, E2EWorkerFixtures>({
  profile: [null, { option: true, scope: "worker" }],
  mode: ["opaque", { option: true, scope: "worker" }],

  libraryState: [
    async ({ profile }, use) => {
      await use(profile === null ? null : await loadLibraryState(profile));
    },
    { scope: "worker" },
  ],

  // 须排在 diagnostics 之前：先判定跳过，被跳过的用例不创建浏览器上下文
  target: [
    async ({ profile, mode, baseURL, libraryState }, use, testInfo) => {
      if (profile === null) {
        await use(null);
        return;
      }
      testInfo.annotations.push(
        { type: ANNOTATIONS.profile, description: profile },
        { type: ANNOTATIONS.mode, description: mode },
      );
      const origin = serverOrigin(profile, mode);
      if (baseURL === undefined || new URL(baseURL).origin !== origin) {
        throw new Error(
          `项目配置不一致：profile=${profile}、mode=${mode} 应使用实例 ${origin}，` +
            `baseURL 却是 ${baseURL ?? "（未设置）"}（需求 5.5、6.11）`,
        );
      }
      if (libraryState?.skipReason) testInfo.skip(true, libraryState.skipReason);
      await use({ profile, mode, origin });
    },
    { auto: true },
  ],

  lib: async ({ target, libraryState }, use) => {
    if (target === null || libraryState === null) {
      throw new Error("lib 只能用在声明了 Library_Profile 的项目中（fixture、fixture-transparent、perf）");
    }
    if (libraryState.library === null || libraryState.roles === null) {
      // target 已按 skipReason 跳过，正常到不了这里
      throw new Error(`当前书库不可用：${libraryState.skipReason ?? "未知原因"}`);
    }
    await use(createLib(libraryState.library, libraryState.roles));
  },

  bookLog: async ({ page }, use, testInfo) => {
    const { log, dispose } = createBookLog(page, testInfo.project.name === BOOK_LOAD_PROJECT);
    await use(log);
    for (const body of await dispose()) {
      await testInfo.attach(ATTACHMENTS.bookLoad, {
        body: JSON.stringify(body),
        contentType: "application/json",
      });
    }
  },

  clock: async ({ page }, use) => {
    await use(createClock(page));
  },

  idb: async ({ page }, use) => {
    await use(createIdbProbe(page));
  },

  throttle: async ({ page }, use) => {
    const sessions: CDPSession[] = [];
    await use(async (bytesPerSecond = THROTTLE_BYTES_PER_SEC) => {
      if (!(bytesPerSecond > 0)) throw new Error(`节流速率须为正数，实际为 ${bytesPerSecond}`);
      const session = await page.context().newCDPSession(page);
      sessions.push(session);
      await session.send("Network.enable");
      await session.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 0,
        downloadThroughput: bytesPerSecond,
        uploadThroughput: -1,
      });
    });
    for (const session of sessions) await session.detach().catch(() => undefined);
  },

  seedTheme: async ({ context }, use) => {
    await use((theme) => seedTheme(context, theme));
  },

  assertTheme: async ({ page }, use) => {
    await use((theme) => assertTheme(page, theme));
  },

  shot: async ({ page, target, libraryState }, use, testInfo) => {
    await use(createShot(page, target, libraryState, testInfo));
  },

  diagnostics: [
    async ({ context }, use, testInfo) => {
      const lines: string[] = [];
      const onConsole = (msg: ConsoleMessage): void => {
        lines.push(`[${msg.type()}] ${msg.text()}`);
      };
      const watch = (page: Page): void => {
        page.on("console", onConsole);
      };
      context.pages().forEach(watch);
      context.on("page", watch);

      await use();

      context.off("page", watch);
      for (const page of context.pages()) page.off("console", onConsole);
      // 通过、跳过与预期失败不保留产物；失败、超时与意外通过才写（17.2）
      if (testInfo.status === testInfo.expectedStatus) return;
      await attachConsoleLog(testInfo, lines);
      const atEnd: StepAtEnd = { step: stepAtEnd(testInfo), timeoutMs: testInfo.timeout };
      await testInfo.attach(ATTACHMENTS.stepAtEnd, {
        body: JSON.stringify(atEnd),
        contentType: "application/json",
      });
    },
    { auto: true, box: true },
  ],
});
