/**
 * R1 审计：核对 Fixture_Library 的产物满足阅读器的字数校验（e2e-visual-testing 任务 2.6、
 * 需求 19.3、19.10、设计"风险"R1、R3；test-data-desensitization 任务 11.10、需求 2.1、4.1）。
 *
 * F-001 修复后，阅读器要求全文的 Unicode 码点数等于 `_toc.json` 的 `charCount`，不符即显示
 * 错误页（19.3）。预处理管线写出的两者一旦口径不一（例如换行里的 CR 只算进其中一边，每行差
 * 1 个字符），这些书就打不开。本用例在 Node 里逐本解压 Fixture_Library（`FIXTURE_LIB_ROOT`，即
 * `e2e/.out/fixture/`）`books/` 下全部 `.txt.gz`，与 `data/` 下的 `_toc.json` 按阅读器的口径比对：
 *
 * - 解码：`TextDecoder("utf-8")` 的默认行为（非 fatal，剥掉 1 个开头的 BOM），与阅读器的
 *   `Response.text()` 相同（Opaque 分支 `DecompressionStream` 之后、Transparent 分支 HTTP
 *   层解码之后都是它）。
 * - 计数与规范化：直接导入阅读器用的 `countCodePoints`、`normalizeCharCount`、
 *   `hasGzipMagic`，不另写一份。
 *
 * Fixture_Library 出自部署用的同一条预处理管线（Fixture_Generator 调用 `scripts/preprocess.py`
 * 的 `run()`）。它的源文件都带 UTF-8 BOM，crlf 用途那本以 CR LF 换行：管线对 BOM 或 CR 的计法
 * 若与阅读器不一，会在这里表现为码点数不符。
 *
 * 只读 Fixture_Library，不读 `public/` 下的任何文件（test-data-desensitization 需求 2.1）。
 * Fixture_Library 由 globalSetup 第 2 步（`python e2e/fixture/generate.py --if-stale`）生成；缺
 * `books/` 或 `data/books.json` 时用例判失败并写明缺少的路径，不跳过。
 *
 * 结果写入 `e2e/.out/charcount-audit.json` 与 `charcount-audit.md`。以下任一项非空即判失败：
 * 码点数不符、gz 无效（缺魔数或解不开）、`_toc.json` 无法读取、gz 与 `_toc.json` 不成对、
 * `books.json` 所列的书缺文件——这些书在阅读器里都会显示错误页。以下只列出、不判失败：
 * `charCount` 不可用的书（19.10 跳过检查，已接受的限制）；正文以 U+FEFF 开头的书（R3，若与
 * `charCount` 不符已计入"不符"）；不在 `books.json` 中的 gz（书架不列出，不影响打开）。
 *
 * 标题带 `@audit`：`tooling` 项目以 `grepInvert` 排除它，只经
 * `npm run e2e:profile -- --profile fixture -g @audit` 按需运行。
 */
import { expect, test } from "@playwright/test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import zlib from "node:zlib";
import {
  countCodePoints,
  hasGzipMagic,
  normalizeCharCount,
} from "../../../src/utils/bookTextCheck";
import { FIXTURE_LIB_ROOT, booksJsonPath, repoRelative } from "../../support/library";
import { CHARCOUNT_AUDIT_CONCURRENCY, TIMEOUTS } from "../../support/settings";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
/** 审计对象：Fixture_Library 的 `books/` 与 `data/`（目录结构见 `e2e/support/library.ts`）。 */
const BOOKS_DIR = path.join(FIXTURE_LIB_ROOT, "books");
const DATA_DIR = path.join(FIXTURE_LIB_ROOT, "data");
const BOOKS_JSON = booksJsonPath(FIXTURE_LIB_ROOT);
const OUT_DIR = path.join(REPO_ROOT, "e2e", ".out");
const OUT_JSON = path.join(OUT_DIR, "charcount-audit.json");
const OUT_MD = path.join(OUT_DIR, "charcount-audit.md");

const GZ_SUFFIX = ".txt.gz";
const TOC_SUFFIX = "_toc.json";
/** 失败信息里最多列出的问题条数；完整清单在结果文件里。 */
const MESSAGE_LIST_LIMIT = 50;
/** 每处理这么多本打一行进度；处理完最后一本时也打一行。 */
const PROGRESS_EVERY = 500;

const gunzip = promisify(zlib.gunzip);

/** `charCount` 的原值，以 JSON 文本记录，缺失时为 `(缺失)`，便于看出 `"12"` 与 `12` 的区别。 */
function rawRepr(toc: Record<string, unknown>): string {
  return "charCount" in toc ? String(JSON.stringify(toc.charCount)) : "(缺失)";
}

/** 字符串中某个码元出现的次数。只对不符的书调用，用于判断差值是否来自换行（R1）。 */
function countUnit(s: string, unit: string): number {
  let n = 0;
  for (let i = s.indexOf(unit); i !== -1; i = s.indexOf(unit, i + 1)) n++;
  return n;
}

interface Mismatch {
  id: string;
  charCountRaw: string;
  charCount: number;
  /** 阅读器口径（剥掉 1 个开头 BOM 后）的码点数。 */
  codePoints: number;
  /** `codePoints - charCount`。 */
  delta: number;
  utf16Length: number;
  /** 解压后的字节以 EF BB BF 开头（R3）。 */
  leadingBom: boolean;
  lfCount: number;
  crCount: number;
}

interface BomBook {
  id: string;
  charCountRaw: string;
  /** 阅读器口径的码点数（已剥掉 1 个 BOM）。 */
  codePoints: number;
  /** 剥掉 1 个 BOM 后仍以 U+FEFF 开头（双 BOM）。 */
  stillStartsWithBom: boolean;
  /** 码点数加回被剥掉的 BOM 后是否等于 `charCount`（即 Python `len()` 口径下相符）。 */
  matchesWithBom: boolean | null;
}

interface InvalidGz {
  id: string;
  reason: "not-gzip" | "corrupt-gzip";
  detail: string;
}

interface AuditResult {
  generatedAt: string;
  durationMs: number;
  booksDir: string;
  dataDir: string;
  concurrency: number;
  totals: {
    gzFiles: number;
    tocFiles: number;
    booksJsonEntries: number;
    audited: number;
    checked: number;
    gzBytes: number;
    decompressedBytes: number;
    codePoints: number;
  };
  mismatches: Mismatch[];
  unusableCharCount: { id: string; charCountRaw: string }[];
  leadingBom: BomBook[];
  invalidGz: InvalidGz[];
  unreadableToc: { id: string; detail: string }[];
  missing: {
    /** 有 gz、没有 `_toc.json`：无法比对。 */
    tocForGz: string[];
    /** 有 `_toc.json`、没有 gz。 */
    gzForToc: string[];
    /** `books.json` 列出、缺 gz 或 `_toc.json`。 */
    filesForBooksJson: { id: string; gz: boolean; toc: boolean }[];
    /** 有 gz、不在 `books.json` 中。 */
    booksJsonForGz: string[];
  };
}

async function listIds(dir: string, suffix: string): Promise<string[]> {
  const names = await fs.readdir(dir);
  return names
    .filter((n) => n.endsWith(suffix))
    .map((n) => n.slice(0, -suffix.length))
    .sort();
}

async function readBooksJsonIds(): Promise<string[]> {
  const raw = JSON.parse(await fs.readFile(BOOKS_JSON, "utf8")) as {
    books?: { id?: unknown }[];
  };
  const books = Array.isArray(raw.books) ? raw.books : [];
  return books.map((b) => String(b.id)).sort();
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

/**
 * 审计要读、却不存在的 Fixture_Library 路径（相对仓库根）。`data/books.json` 在，`data/` 也就在；
 * 整个书库都没生成时两项都列出。
 */
async function missingLibraryPaths(): Promise<string[]> {
  const required = [BOOKS_DIR, BOOKS_JSON];
  const present = await Promise.all(required.map(exists));
  return required.filter((_, i) => !present[i]).map(repoRelative);
}

async function audit(): Promise<AuditResult> {
  const startedAt = performance.now();
  const [gzIds, tocIds, booksJsonIds] = await Promise.all([
    listIds(BOOKS_DIR, GZ_SUFFIX),
    listIds(DATA_DIR, TOC_SUFFIX),
    readBooksJsonIds(),
  ]);
  const gzSet = new Set(gzIds);
  const tocSet = new Set(tocIds);
  const booksJsonSet = new Set(booksJsonIds);

  const result: AuditResult = {
    generatedAt: new Date().toISOString(),
    durationMs: 0,
    booksDir: repoRelative(BOOKS_DIR),
    dataDir: repoRelative(DATA_DIR),
    concurrency: CHARCOUNT_AUDIT_CONCURRENCY,
    totals: {
      gzFiles: gzIds.length,
      tocFiles: tocIds.length,
      booksJsonEntries: booksJsonIds.length,
      audited: 0,
      checked: 0,
      gzBytes: 0,
      decompressedBytes: 0,
      codePoints: 0,
    },
    mismatches: [],
    unusableCharCount: [],
    leadingBom: [],
    invalidGz: [],
    unreadableToc: [],
    missing: {
      tocForGz: gzIds.filter((id) => !tocSet.has(id)),
      gzForToc: tocIds.filter((id) => !gzSet.has(id)),
      filesForBooksJson: booksJsonIds
        .filter((id) => !gzSet.has(id) || !tocSet.has(id))
        .map((id) => ({ id, gz: gzSet.has(id), toc: tocSet.has(id) })),
      booksJsonForGz: gzIds.filter((id) => !booksJsonSet.has(id)),
    },
  };

  // 阅读器 `Response.text()` 的解码口径：UTF-8、非 fatal、剥掉 1 个开头 BOM。
  // `decode()` 是同步调用，多路并发共用一个实例没有交错问题。
  const decoder = new TextDecoder("utf-8");
  const work = gzIds.filter((id) => tocSet.has(id));

  async function auditBook(id: string): Promise<void> {
    let toc: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(
        await fs.readFile(path.join(DATA_DIR, id + TOC_SUFFIX), "utf8"),
      );
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("顶层不是对象");
      }
      toc = parsed as Record<string, unknown>;
    } catch (e) {
      result.unreadableToc.push({ id, detail: String(e) });
      return;
    }

    const gz = await fs.readFile(path.join(BOOKS_DIR, id + GZ_SUFFIX));
    result.totals.gzBytes += gz.length;
    if (!hasGzipMagic(gz)) {
      result.invalidGz.push({ id, reason: "not-gzip", detail: `前 2 字节 ${gz.subarray(0, 2).toString("hex")}` });
      return;
    }

    let raw: Buffer;
    try {
      raw = await gunzip(gz);
    } catch (e) {
      result.invalidGz.push({ id, reason: "corrupt-gzip", detail: String(e) });
      return;
    }
    result.totals.decompressedBytes += raw.length;

    const leadingBom = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
    const text = decoder.decode(raw);
    const codePoints = countCodePoints(text);
    result.totals.codePoints += codePoints;
    result.totals.audited++;

    const charCountRaw = rawRepr(toc);
    const expected = normalizeCharCount(toc.charCount);

    if (leadingBom) {
      result.leadingBom.push({
        id,
        charCountRaw,
        codePoints,
        stillStartsWithBom: text.charCodeAt(0) === 0xfeff,
        matchesWithBom: expected === null ? null : codePoints + 1 === expected,
      });
    }

    if (expected === null) {
      result.unusableCharCount.push({ id, charCountRaw });
      return;
    }
    result.totals.checked++;

    if (codePoints !== expected) {
      result.mismatches.push({
        id,
        charCountRaw,
        charCount: expected,
        codePoints,
        delta: codePoints - expected,
        utf16Length: text.length,
        leadingBom,
        lfCount: countUnit(text, "\n"),
        crCount: countUnit(text, "\r"),
      });
    }
  }

  let next = 0;
  let done = 0;
  async function runLane(): Promise<void> {
    while (next < work.length) {
      const id = work[next++];
      await auditBook(id);
      done++;
      if (done % PROGRESS_EVERY === 0 || done === work.length) {
        const sec = ((performance.now() - startedAt) / 1000).toFixed(0);
        console.log(`[charcount-audit] ${done}/${work.length}，${sec} s，不符 ${result.mismatches.length}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CHARCOUNT_AUDIT_CONCURRENCY }, runLane));

  const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  result.mismatches.sort(byId);
  result.unusableCharCount.sort(byId);
  result.leadingBom.sort(byId);
  result.invalidGz.sort(byId);
  result.unreadableToc.sort(byId);
  result.durationMs = Math.round(performance.now() - startedAt);
  return result;
}

/** 判为失败的问题，每条一行。 */
function problemLines(r: AuditResult): string[] {
  return [
    ...r.mismatches.map(
      (m) => `不符 ${m.id}：码点数 ${m.codePoints}，charCount ${m.charCount}（差 ${m.delta}）`,
    ),
    ...r.invalidGz.map((g) => `gz 无效 ${g.id}：${g.reason}，${g.detail}`),
    ...r.unreadableToc.map((t) => `_toc.json 无法读取 ${t.id}：${t.detail}`),
    ...r.missing.tocForGz.map((id) => `缺 _toc.json ${id}`),
    ...r.missing.gzForToc.map((id) => `缺 .txt.gz ${id}`),
    ...r.missing.filesForBooksJson.map(
      (b) => `books.json 所列 ${b.id} 缺${[b.gz ? "" : " .txt.gz", b.toc ? "" : " _toc.json"].join("")}`,
    ),
  ];
}

function renderMarkdown(r: AuditResult, problems: string[]): string {
  const t = r.totals;
  const lines = [
    "# R1 审计：charCount 与 gz 码点数",
    "",
    `- 书库：Fixture_Library（${r.booksDir}、${r.dataDir}）`,
    `- 生成时间：${r.generatedAt}`,
    `- 耗时：${(r.durationMs / 1000).toFixed(1)} s（并发 ${r.concurrency}）`,
    `- gz 文件 ${t.gzFiles}、_toc.json ${t.tocFiles}、books.json 条目 ${t.booksJsonEntries}`,
    `- 已解压 ${t.audited} 本（gz ${t.gzBytes} 字节，解压后 ${t.decompressedBytes} 字节，码点 ${t.codePoints}）；其中 ${t.checked} 本 charCount 可用并已比对`,
    `- 不符 ${r.mismatches.length}；gz 无效 ${r.invalidGz.length}；_toc.json 无法读取 ${r.unreadableToc.length}`,
    `- charCount 不可用（19.10，跳过检查）${r.unusableCharCount.length}；正文以 U+FEFF 开头（R3）${r.leadingBom.length}`,
    `- 缺 _toc.json ${r.missing.tocForGz.length}；缺 .txt.gz ${r.missing.gzForToc.length}；books.json 所列缺文件 ${r.missing.filesForBooksJson.length}；不在 books.json 中 ${r.missing.booksJsonForGz.length}`,
    `- 结论：${problems.length === 0 ? "通过" : `不通过（${problems.length} 项）`}`,
    "",
  ];

  if (r.mismatches.length > 0) {
    lines.push(
      "## 码点数不符",
      "",
      "| id | charCount 原值 | 码点数 | 差 | UTF-16 码元 | 开头 BOM | LF 数 | CR 数 |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
      ...r.mismatches.map(
        (m) =>
          `| ${m.id} | ${m.charCountRaw} | ${m.codePoints} | ${m.delta} | ${m.utf16Length} | ${m.leadingBom ? "是" : "否"} | ${m.lfCount} | ${m.crCount} |`,
      ),
      "",
    );
  }
  if (r.leadingBom.length > 0) {
    lines.push(
      "## 正文以 U+FEFF 开头（R3）",
      "",
      "| id | charCount 原值 | 码点数（剥 BOM 后） | 双 BOM | 计入 BOM 后相符 |",
      "| --- | --- | --- | --- | --- |",
      ...r.leadingBom.map(
        (b) =>
          `| ${b.id} | ${b.charCountRaw} | ${b.codePoints} | ${b.stillStartsWithBom ? "是" : "否"} | ${b.matchesWithBom === null ? "—" : b.matchesWithBom ? "是" : "否"} |`,
      ),
      "",
    );
  }
  if (r.unusableCharCount.length > 0) {
    lines.push(
      "## charCount 不可用（19.10）",
      "",
      ...r.unusableCharCount.map((u) => `- ${u.id}：${u.charCountRaw}`),
      "",
    );
  }
  const other = problems.filter((p) => !p.startsWith("不符 "));
  if (other.length > 0) {
    lines.push("## 其他问题", "", ...other.map((p) => `- ${p}`), "");
  }
  if (r.missing.booksJsonForGz.length > 0) {
    lines.push(
      "## 不在 books.json 中的 gz（只列出）",
      "",
      ...r.missing.booksJsonForGz.map((id) => `- ${id}`),
      "",
    );
  }
  return lines.join("\n");
}

test("R1 审计：Fixture_Library 全部 .txt.gz 的码点数等于 _toc.json 的 charCount @audit", async () => {
  test.setTimeout(TIMEOUTS.charCountAudit);

  // 前置条件：Fixture_Library 已生成。缺失时判失败（不跳过），写明缺什么、怎样生成
  const missing = await missingLibraryPaths();
  expect(
    missing,
    `Fixture_Library 不完整，缺 ${missing.join("、")}。它由 globalSetup 第 2 步生成：` +
      "请经 npm run e2e:profile -- --profile fixture -g @audit 运行本用例，或先执行 npm run e2e:fixture",
  ).toEqual([]);

  const result = await audit();
  const problems = problemLines(result);

  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.writeFile(OUT_JSON, JSON.stringify(result, null, 2) + "\n", "utf8");
  await fs.writeFile(OUT_MD, renderMarkdown(result, problems), "utf8");

  const shown = problems.slice(0, MESSAGE_LIST_LIMIT);
  const more = problems.length - shown.length;
  const message = [
    `R1 审计发现 ${problems.length} 项问题，完整清单见 ${repoRelative(OUT_JSON)}`,
    ...shown,
    ...(more > 0 ? [`……另有 ${more} 项`] : []),
  ].join("\n");

  expect(result.totals.gzFiles, `${result.booksDir}/ 下没有 .txt.gz，无从审计`).toBeGreaterThan(0);
  expect(problems.length, message).toBe(0);
});
