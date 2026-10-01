/**
 * E2E_Server 的无浏览器测试（`tooling` 项目；设计"E2E_Server"一节与 Testing Strategy）。
 *
 * - `resolveRequest`：属性 1（路径解析不越出根目录，需求 5.2、5.7）与定向例子。只调用纯函数，
 *   不访问文件系统。
 * - 服务器逐例测试（5.3、5.4、5.6、5.8、5.13、405 与 403 日志，任务 5.4）：本文件末尾的第二个
 *   `test.describe`。在临时目录里自建 App_Build 与书库根，以端口 0 起 Opaque_Mode 与
 *   Transparent_Mode 各一个实例，用 `node:http.request` 发原样路径（`fetch` 会把 `%2e%2e`
 *   规范化掉）。期望的 Content-Type 按 5.13 写成字面量，独立于 `resolve.ts` 的表核对一遍。
 */
import { expect, test } from "@playwright/test";
import fc from "fast-check";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { resolveRequest, type Mode, type Resolved } from "../../server/resolve";
import { createE2EServer, type E2EServer } from "../../server/server";
import { TIMEOUTS } from "../../support/settings";

type Roots = { app: string; lib: string };

/**
 * 属性里判定越界的依据，与 `resolve.ts` 第 6 步一致：按路径分量比较，只有首个分量恰为 `..`
 * 才算越出。`...`、`..foo` 是合法名称，按 5.6 走回退，不能当成越界。
 */
function firstComponent(rel: string): string {
  return rel.split(/[\\/]/)[0];
}

/**
 * 属性 1 的判定：结果是 forbidden；或是 candidate，且
 * (a) `absPath` 是绝对路径，`path.relative(root, absPath)` 不是绝对路径、首个分量不是 `..`；
 * (b) 另以字符串前缀核对一次：`absPath` 等于根目录，或以"根目录 + 分隔符"开头；
 * (c) 根的选择符合 5.2：`absPath = path.join(root, ...segs)`，所以相对路径的首个分量就是
 *     规范化后的首段，它是 `books` 或 `data` 当且仅当 root 为 lib。
 *
 * 属性内用 `node:assert` 而不是 Playwright 的 `expect`：每次 `expect` 都会在报告里记一个步骤，
 * 100 次迭代加上收缩会刷出成百上千条。
 */
function assertWithinRoot(rawUrl: string, roots: Roots, r: Resolved): void {
  const where = `rawUrl=${JSON.stringify(rawUrl)}`;
  if (r.kind === "forbidden") {
    assert.ok(r.reason.length > 0, `forbidden 缺少原因（${where}）`);
    return;
  }
  assert.equal(r.kind, "candidate", `结果既不是 forbidden 也不是 candidate（${where}）`);

  const rootDir = path.resolve(roots[r.root]);
  assert.ok(path.isAbsolute(r.absPath), `absPath 不是绝对路径：${r.absPath}（${where}）`);

  const rel = path.relative(rootDir, r.absPath);
  const first = firstComponent(rel);
  assert.ok(
    !path.isAbsolute(rel) && first !== "..",
    `absPath 越出 ${r.root} 根目录：${r.absPath}，相对路径 ${JSON.stringify(rel)}（${where}）`,
  );
  assert.ok(
    r.absPath === rootDir || r.absPath.startsWith(rootDir + path.sep),
    `absPath 不以 ${r.root} 根目录开头：${r.absPath}（${where}）`,
  );

  const libFirst = first === "books" || first === "data";
  assert.equal(
    r.root === "lib",
    libFirst,
    `首段 ${JSON.stringify(first)} 被映射到 ${r.root}（${where}）`,
  );
}

// ---------------------------------------------------------------------------
// 生成器：按段拼出请求路径，字母表覆盖设计属性 1 所列的全部写法
// ---------------------------------------------------------------------------

/** 规范化后成为 `..` 的写法：字面、整体编码、半编码与大小写混用。 */
const DOT_DOT_FORMS = ["..", "%2e%2e", "%2E%2E", "%2E.", ".%2e", "%2e."] as const;
/** 规范化后成为 `.` 的写法。 */
const DOT_FORMS = [".", "%2e", "%2E"] as const;
/** 解码后是 `/` 或 `\` 的分隔符写法，以及重复的分隔符。 */
const SEP_FORMS = ["\\", "%2f", "%2F", "%5c", "%5C", "//", "/\\", "/./"] as const;
/** 解码后恰为 `books` / `data` 的首段（映射到书库根）。 */
const LIB_FORMS = ["books", "data", "%62ooks", "dat%61"] as const;
/** 与 `books` / `data` 相近但不相等的名称：大小写、尾随点与空格、前后缀（映射到 App_Build）。 */
const NEAR_LIB_FORMS = ["Books", "DATA", "books.", "data ", "book", "data2", "booksx"] as const;
/** 看似越界、实为合法名称的段；`%252e` 只解码一次，得到字面的 `%2e`。 */
const DOTTY_NAMES = ["...", "....", "..foo", "foo..", ".x", "%2e%2e%2e", "%252e%252e", "．．"] as const;
/** 解码失败、含 NUL 或含 `:` 的段（结果应为 forbidden）。 */
const HOSTILE_FORMS = [
  "%",
  "%zz",
  "%2",
  "%E4%B8", // 截断的 UTF-8
  "%C0%AE", // 过长编码的 `.`
  "%FF",
  "%00",
  "a%00b",
  "C:",
  "c%3a",
  "x.txt.gz::$DATA",
  "http:",
] as const;
/** 普通名称：前端路由、构建产物、仓库文件名与中文 id（含编码形式）。 */
const PLAIN_NAMES = [
  "index.html",
  "read",
  "assets",
  "package.json",
  "中文书",
  "%E4%B8%AD%E6%96%87.txt.gz",
  "%E4%B8%AD%E6%96%87_toc.json",
  "books.json",
  "a b",
  "a%20b",
] as const;

/** 随机名称：小字母表里的字符（含 `.`、`%` 与中文），可能拼出新的点段或非法转义。 */
const randomName = fc.string({
  unit: fc.constantFrom(..."ab09-_.~%2eE中文"),
  minLength: 1,
  maxLength: 6,
});
/** 任意良构文本经 `encodeURIComponent` 编码后的段。 */
const encodedName = fc
  .string({ unit: "grapheme", minLength: 1, maxLength: 4 })
  .map((s) => encodeURIComponent(s));

const segment = fc.oneof(
  { weight: 5, arbitrary: fc.constantFrom(...DOT_DOT_FORMS) },
  { weight: 1, arbitrary: fc.constantFrom(...DOT_FORMS) },
  { weight: 3, arbitrary: fc.constantFrom(...LIB_FORMS) },
  { weight: 1, arbitrary: fc.constantFrom(...NEAR_LIB_FORMS) },
  { weight: 2, arbitrary: fc.constantFrom(...DOTTY_NAMES) },
  { weight: 1, arbitrary: fc.constantFrom(...HOSTILE_FORMS) },
  { weight: 3, arbitrary: fc.constantFrom(...PLAIN_NAMES) },
  { weight: 2, arbitrary: randomName },
  { weight: 1, arbitrary: encodedName },
  { weight: 1, arbitrary: fc.string({ unit: "binary", maxLength: 3 }) },
);

const separator = fc.oneof(
  { weight: 6, arbitrary: fc.constant("/") },
  { weight: 2, arbitrary: fc.constantFrom(...SEP_FORMS) },
);

/** 查询串或片段：其中的 `..`、非法转义与 `/books/` 都不应影响结果。 */
const suffix = fc.oneof(
  { weight: 3, arbitrary: fc.constant("") },
  {
    weight: 1,
    arbitrary: fc
      .tuple(
        fc.constantFrom("?", "#"),
        fc.string({ unit: fc.constantFrom(..."/.%2ezZ:\\?#&=books中"), maxLength: 12 }),
      )
      .map(([mark, rest]) => mark + rest),
  },
);

/**
 * 按段拼出的路径：每段前有一个分隔符，可去掉开头的分隔符，可带结尾分隔符与查询串。
 * 约一半以书库首段开头，后续的 `..` 再决定它是否仍映射到书库根，两种根的 candidate 都常见。
 */
const structuredUrl = fc
  .tuple(
    fc.boolean(),
    fc.constantFrom(...LIB_FORMS),
    fc.array(fc.tuple(separator, segment), { maxLength: 8 }),
    fc.boolean(),
    fc.constantFrom("", "", "", "/", "%2f", "\\"),
    suffix,
  )
  .map(([libLead, libSeg, rest, dropLead, trailing, tail]) => {
    const parts = libLead ? [["/", libSeg] as const, ...rest] : rest;
    const body = parts.map(([sep, seg]) => sep + seg).join("");
    const lead = dropLead && body.startsWith("/") ? body.slice(1) : body;
    return lead + trailing + tail;
  });

/** 逐字符的模糊输入：能拼出 `%2e`、`%5c`、`..` 等，但不受段结构约束。 */
const charFuzzUrl = fc.string({ unit: fc.constantFrom(..."./\\%2eEfFc5:0?#bdoksat中"), maxLength: 24 });

const rawUrlArb = fc.oneof(
  { weight: 4, arbitrary: structuredUrl },
  { weight: 1, arbitrary: charFuzzUrl },
  { weight: 1, arbitrary: fc.string({ unit: "binary", maxLength: 16 }) },
);

/**
 * 根目录组合：相对路径（按当前工作目录解析，与 fixture / real 的实际布局相同），
 * 以及含空格与中文的绝对路径。`resolveRequest` 不访问文件系统，这些目录无需存在。
 */
const ROOTS: readonly Roots[] = [
  { app: "e2e/.out/app", lib: "e2e/.out/fixture" },
  { app: "e2e/.out/app", lib: "public" },
  { app: path.join(os.tmpdir(), "e2e 书库", "app"), lib: path.join(os.tmpdir(), "e2e 书库", "lib") },
];

// ---------------------------------------------------------------------------
// 定向例子
// ---------------------------------------------------------------------------

const EX: Roots = { app: "e2e/.out/app", lib: "e2e/.out/fixture" };

/** 应判 forbidden 的请求：越界、解码失败、含 NUL、含 `:`。 */
const FORBIDDEN_URLS = [
  // 越过根目录（含服务器自检的那一项）
  "/%2e%2e/%2e%2e/package.json",
  "/..",
  "/../package.json",
  "/%2E./package.json",
  "/.%2e/package.json",
  "/..%5cpackage.json",
  "/..\\package.json",
  "/books/../../package.json",
  "/books/%2e%2e%2f%2e%2e%2fpackage.json",
  "/assets/../../books/x.txt.gz",
  // 百分号解码失败
  "/%",
  "/%zz",
  "/%E4%B8",
  "/%C0%AE%C0%AE/package.json",
  "/books/%FF.txt.gz",
  // NUL
  "/%00",
  "/index.html%00.js",
  // 盘符与备用数据流
  "/C:/Windows/win.ini",
  "/c%3a%5cWindows%5cwin.ini",
  "/books/x.txt.gz::$DATA",
  "/data/books.json%3a%3a$DATA",
] as const;

/** 应得到 candidate 的请求：[原始路径, 根, 规范化后的段]。 */
const CANDIDATE_URLS: ReadonlyArray<readonly [string, "app" | "lib", readonly string[]]> = [
  ["/", "app", []],
  ["", "app", []],
  ["/index.html", "app", ["index.html"]],
  ["/read/%E4%B8%AD%E6%96%87?from=shelf", "app", ["read", "中文"]],
  ["/books/%E4%B8%AD%E6%96%87.txt.gz", "lib", ["books", "中文.txt.gz"]],
  ["/data/%E4%B8%AD%E6%96%87_toc.json?v=%zz#/../..", "lib", ["data", "中文_toc.json"]],
  ["/data/books.json?../../package.json", "lib", ["data", "books.json"]],
  ["//books//./x.txt.gz", "lib", ["books", "x.txt.gz"]],
  ["\\books\\x.txt.gz", "lib", ["books", "x.txt.gz"]],
  ["/%2fbooks%2fx.txt.gz", "lib", ["books", "x.txt.gz"]],
  ["/%62ooks/x.txt.gz", "lib", ["books", "x.txt.gz"]],
  ["/a/../books/x.txt.gz", "lib", ["books", "x.txt.gz"]],
  ["/books/../index.html", "app", ["index.html"]],
  ["/books", "lib", ["books"]],
  ["/Books/x.txt.gz", "app", ["Books", "x.txt.gz"]],
  ["/booksx/y", "app", ["booksx", "y"]],
  ["/...", "app", ["..."]],
  ["/..foo/bar..", "app", ["..foo", "bar.."]],
  ["/%252e%252e/package.json", "app", ["%2e%2e", "package.json"]],
];

test.describe("resolveRequest（需求 5.2、5.7）", () => {
  // Feature: e2e-visual-testing, Property 1: 路径解析不越出根目录
  // **Validates: Requirements 5.2, 5.7**
  test("属性 1：任意请求路径的结果为 forbidden，或是落在所选根目录之内的 candidate", () => {
    fc.assert(
      fc.property(rawUrlArb, fc.constantFrom(...ROOTS), (rawUrl, roots) => {
        assertWithinRoot(rawUrl, roots, resolveRequest(rawUrl, roots));
      }),
      { numRuns: 100 },
    );
  });

  test("越界、解码失败、含 NUL 或 `:` 的路径判为 forbidden（5.7）", () => {
    for (const rawUrl of FORBIDDEN_URLS) {
      expect(resolveRequest(rawUrl, EX), rawUrl).toMatchObject({
        kind: "forbidden",
        reason: expect.any(String),
      });
    }
  });

  test("合法路径忽略查询串、解码一次后映射到书库根或 App_Build（5.2）", () => {
    for (const [rawUrl, root, segs] of CANDIDATE_URLS) {
      expect(resolveRequest(rawUrl, EX), rawUrl).toEqual({
        kind: "candidate",
        root,
        absPath: path.join(path.resolve(EX[root]), ...segs),
      });
    }
  });
});

// ---------------------------------------------------------------------------
// 服务器逐例测试（任务 5.4）
// ---------------------------------------------------------------------------

/** 5.13 的 Content-Type 表，照需求原文写成字面量，不从 `resolve.ts` 导入。 */
const CT = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  gzOpaque: "application/gzip",
  gzTransparent: "text/plain; charset=utf-8",
  other: "application/octet-stream",
} as const;

const MODES: readonly Mode[] = ["opaque", "transparent"];

const BOOK_ID = "中文书";
const ENC_ID = encodeURIComponent(BOOK_ID);
const TXT_GZ_FILE = `lib/books/${BOOK_ID}.txt.gz`;
const TXT_GZ_PATH = `/books/${ENC_ID}.txt.gz`;

/**
 * 约 190 KB 的正文以 level 0 压缩：gz 比 `createReadStream` 的一个读取块（64 KiB）大，
 * 响应体要分多块流出。Transparent_Mode 下另解压一次，确认返回的是压缩后的字节。
 */
const BOOK_TEXT = "第一章　开端\n这是 E2E_Server 逐例测试用的正文。\n".repeat(3000);

/** 临时目录里的文件：相对临时目录、以 `/` 分隔的路径 → 内容。`secret.txt` 在两个根目录之外。 */
const SERVER_FILES: Readonly<Record<string, Buffer>> = {
  "app/index.html": Buffer.from(
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>回退</title></head>' +
      "<body>单页应用回退</body></html>\n",
    "utf8",
  ),
  "app/assets/app.js": Buffer.from("console.log('e2e');\n", "utf8"),
  "app/assets/app.css": Buffer.from("body { color: #123456; }\n", "utf8"),
  "app/favicon.svg": Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>\n', "utf8"),
  "app/assets/font.woff2": Buffer.from([0x77, 0x4f, 0x46, 0x32, 0x00, 0x01, 0xfe, 0xff]),
  "app/LICENSE": Buffer.from("MIT\n", "utf8"),
  [TXT_GZ_FILE]: gzipSync(Buffer.from(BOOK_TEXT, "utf8"), { level: 0 }),
  "lib/data/books.json": Buffer.from(JSON.stringify([{ id: BOOK_ID, title: "中文书" }]), "utf8"),
  [`lib/data/${BOOK_ID}_toc.json`]: Buffer.from(JSON.stringify({ nodes: [] }), "utf8"),
  "secret.txt": Buffer.from("E2E-SECRET：根目录之外的文件\n", "utf8"),
};

/** 空目录：请求目录路径时回退 index.html（5.6）。 */
const SERVER_EMPTY_DIRS = ["app/empty", "lib/books/空目录"] as const;

/** 命中文件的请求：[原始路径, 磁盘文件（`SERVER_FILES` 的键）, Opaque_Mode 与 Transparent_Mode 的 Content-Type]。 */
const HIT_CASES: ReadonlyArray<readonly [string, string, string, string]> = [
  ["/index.html", "app/index.html", CT.html, CT.html],
  ["/assets/app.js", "app/assets/app.js", CT.js, CT.js],
  ["/assets/app.css", "app/assets/app.css", CT.css, CT.css],
  ["/favicon.svg", "app/favicon.svg", CT.svg, CT.svg],
  ["/assets/font.woff2", "app/assets/font.woff2", CT.other, CT.other],
  ["/LICENSE", "app/LICENSE", CT.other, CT.other],
  ["/data/books.json?v=%zz", "lib/data/books.json", CT.json, CT.json],
  [`/data/${ENC_ID}_toc.json`, `lib/data/${BOOK_ID}_toc.json`, CT.json, CT.json],
  [TXT_GZ_PATH, TXT_GZ_FILE, CT.gzOpaque, CT.gzTransparent],
];

/**
 * 未命中文件的请求（5.6）：前端路由、书库下不存在的路径、两个根里的目录，以及只在根目录
 * 之外存在的 `secret.txt`（映射到 App_Build 下不存在的同名文件）。
 */
const FALLBACK_PATHS = [
  "/",
  `/read/${ENC_ID}`,
  `/read/${ENC_ID}?ch=3`,
  "/books/__missing__.txt.gz",
  "/data/__missing__.json",
  "/data",
  "/data/",
  `/books/${encodeURIComponent("空目录")}/`,
  "/assets",
  "/empty",
  "/secret.txt",
  "/...",
] as const;

/** 应返回 403 的请求（5.7）：`..` 的各种写法越过根目录（含指向 `secret.txt` 的）、解码失败、盘符。 */
const FORBIDDEN_PATHS = [
  "/%2e%2e/%2e%2e/package.json",
  "/%2e%2e/secret.txt",
  "/books/..%2f..%2fsecret.txt",
  "/..%5csecret.txt",
  "/%zz",
  "/C:/Windows/win.ini",
] as const;

/** GET 与 HEAD 以外的方法（5.8）；带请求体发出。 */
const REJECTED_METHODS = ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"] as const;

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/**
 * 以 `node:http.request` 发出原样路径并收完响应体。`agent: false`：每个请求独占一条
 * `Connection: close` 的连接，不留 keep-alive 套接字。连接空闲超过 `TIMEOUTS.serverRequest` 即失败。
 */
function rawRequest(
  port: number,
  method: string,
  rawPath: string,
  options: { host?: string; body?: Buffer } = {},
): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    const req = http.request({
      host: options.host ?? "127.0.0.1",
      port,
      method,
      path: rawPath,
      agent: false,
    });
    req.setTimeout(TIMEOUTS.serverRequest, () => {
      req.destroy(new Error(`${TIMEOUTS.serverRequest} ms 内未收到完整响应：${method} ${rawPath}`));
    });
    req.on("error", reject);
    req.on("response", (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => {
        if (!res.complete) {
          reject(new Error(`响应体不完整：${method} ${rawPath}`));
          return;
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) });
      });
    });
    req.end(options.body);
  });
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 目录树的状态：相对路径 → 类型、字节数与纳秒精度的修改时间（5.8 的只读核对）。 */
async function treeState(root: string): Promise<Record<string, string>> {
  const state: Record<string, string> = {};
  for (const rel of (await readdir(root, { recursive: true })).sort()) {
    const st = await lstat(path.join(root, rel), { bigint: true });
    state[rel] = `${st.isDirectory() ? "dir" : "file"} ${st.size} ${st.mtimeNs}`;
  }
  return state;
}

test.describe("E2E_Server 逐例（需求 5.3、5.4、5.6、5.8、5.13）", () => {
  let tmp = "";
  let appRoot = "";
  let libRoot = "";
  let logPath = "";
  const servers = new Map<Mode, E2EServer>();

  function server(mode: Mode): E2EServer {
    const s = servers.get(mode);
    if (!s) throw new Error(`${mode} 实例未启动`);
    return s;
  }

  /** 磁盘上的文件内容（`rel` 为 `SERVER_FILES` 的键）。 */
  function disk(rel: string): Promise<Buffer> {
    return readFile(path.join(tmp, ...rel.split("/")));
  }

  /** `server.log` 当前的字节数；尚未创建时为 0。 */
  async function logSize(): Promise<number> {
    try {
      return (await stat(logPath)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
  }

  /** 自 `offset` 起 `server.log` 新增的非空行。 */
  async function logLinesSince(offset: number): Promise<string[]> {
    const added = (await readFile(logPath)).subarray(offset).toString("utf8");
    return added.split("\n").filter((line) => line !== "");
  }

  test.beforeAll(async () => {
    // 目录名含空格与中文，与真实仓库路径的难点相同
    tmp = await mkdtemp(path.join(os.tmpdir(), "e2e 服务器-"));
    appRoot = path.join(tmp, "app");
    libRoot = path.join(tmp, "lib");
    logPath = path.join(tmp, "logs", "server.log");
    for (const [rel, bytes] of Object.entries(SERVER_FILES)) {
      const p = path.join(tmp, ...rel.split("/"));
      await mkdir(path.dirname(p), { recursive: true });
      await writeFile(p, bytes);
    }
    for (const rel of SERVER_EMPTY_DIRS) {
      await mkdir(path.join(tmp, ...rel.split("/")), { recursive: true });
    }
    // 两个实例共用一份 server.log，与 globalSetup 的用法相同
    for (const mode of MODES) {
      servers.set(mode, await createE2EServer({ port: 0, mode, appRoot, libRoot, log: logPath }));
    }
  });

  test.afterAll(async () => {
    await Promise.all([...servers.values()].map((s) => s.close()));
    servers.clear();
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  test("5.3 Opaque_Mode：.txt.gz 与磁盘文件逐字节相同，Content-Length 为文件字节数，不带 Content-Encoding", async () => {
    const { port } = server("opaque");
    const gz = await disk(TXT_GZ_FILE);
    expect(gz.length, "夹具 gz 应大于一个读取块").toBeGreaterThan(64 * 1024);

    const res = await rawRequest(port, "GET", TXT_GZ_PATH);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(gz.length);
    expect(sha256(res.body)).toBe(sha256(gz));
    expect(res.headers["content-length"]).toBe(String(gz.length));
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(res.headers["content-type"]).toBe(CT.gzOpaque);
    expect(res.headers["cache-control"]).toBe("no-store");

    const head = await rawRequest(port, "HEAD", TXT_GZ_PATH);
    expect(head.status).toBe(200);
    expect(head.body.length).toBe(0);
    expect(head.headers["content-length"]).toBe(String(gz.length));
    expect(head.headers["content-encoding"]).toBeUndefined();
    expect(head.headers["content-type"]).toBe(CT.gzOpaque);
  });

  test("5.4 Transparent_Mode：.txt.gz 返回压缩后的原始字节，带 Content-Encoding: gzip，Content-Length 为文件字节数", async () => {
    const { port } = server("transparent");
    const gz = await disk(TXT_GZ_FILE);

    const res = await rawRequest(port, "GET", TXT_GZ_PATH);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(gz.length);
    expect(sha256(res.body)).toBe(sha256(gz));
    // node:http 不做解压：收到的就是磁盘上的 gz 字节，解压后才是正文
    expect(gunzipSync(res.body).toString("utf8")).toBe(BOOK_TEXT);
    expect(res.headers["content-length"]).toBe(String(gz.length));
    expect(res.headers["content-encoding"]).toBe("gzip");
    expect(res.headers["content-type"]).toBe(CT.gzTransparent);
    expect(res.headers["cache-control"]).toBe("no-store");

    const head = await rawRequest(port, "HEAD", TXT_GZ_PATH);
    expect(head.status).toBe(200);
    expect(head.body.length).toBe(0);
    expect(head.headers["content-length"]).toBe(String(gz.length));
    expect(head.headers["content-encoding"]).toBe("gzip");
    expect(head.headers["content-type"]).toBe(CT.gzTransparent);
  });

  test("5.13 按扩展名设置 Content-Type；只有 Transparent_Mode 的 .txt.gz 带 Content-Encoding", async () => {
    for (const mode of MODES) {
      const { port } = server(mode);
      for (const [rawPath, file, opaqueType, transparentType] of HIT_CASES) {
        const label = `${mode} ${rawPath}`;
        const bytes = await disk(file);
        const res = await rawRequest(port, "GET", rawPath);
        expect(res.status, label).toBe(200);
        expect(sha256(res.body), label).toBe(sha256(bytes));
        expect(res.headers["content-length"], label).toBe(String(bytes.length));
        expect(res.headers["cache-control"], label).toBe("no-store");
        expect(res.headers["content-type"], label).toBe(
          mode === "opaque" ? opaqueType : transparentType,
        );
        expect(res.headers["content-encoding"], label).toBe(
          mode === "transparent" && file.endsWith(".txt.gz") ? "gzip" : undefined,
        );
      }
    }
  });

  test("5.6 未命中文件（不存在的路径、目录、前端路由）时以 200 返回 index.html 的字节，两种模式相同", async () => {
    const index = await disk("app/index.html");
    for (const mode of MODES) {
      const { port } = server(mode);
      for (const rawPath of FALLBACK_PATHS) {
        const label = `${mode} ${rawPath}`;
        const res = await rawRequest(port, "GET", rawPath);
        expect(res.status, label).toBe(200);
        expect(sha256(res.body), label).toBe(sha256(index));
        expect(res.headers["content-length"], label).toBe(String(index.length));
        expect(res.headers["content-type"], label).toBe(CT.html);
        expect(res.headers["content-encoding"], label).toBeUndefined();
        expect(res.headers["cache-control"], label).toBe("no-store");
      }

      const head = await rawRequest(port, "HEAD", `/read/${ENC_ID}`);
      expect(head.status, `${mode} HEAD`).toBe(200);
      expect(head.body.length, `${mode} HEAD`).toBe(0);
      expect(head.headers["content-length"], `${mode} HEAD`).toBe(String(index.length));
      expect(head.headers["content-type"], `${mode} HEAD`).toBe(CT.html);
      expect(head.headers["content-encoding"], `${mode} HEAD`).toBeUndefined();
    }
  });

  test("5.8 GET 与 HEAD 以外的方法返回 405，带 Allow: GET, HEAD，响应体为空", async () => {
    for (const mode of MODES) {
      const { port } = server(mode);
      for (const method of REJECTED_METHODS) {
        for (const rawPath of [TXT_GZ_PATH, "/index.html", "/new.txt"]) {
          const label = `${mode} ${method} ${rawPath}`;
          const res = await rawRequest(port, method, rawPath, { body: Buffer.from("x=1", "utf8") });
          expect(res.status, label).toBe(405);
          expect(res.headers["allow"], label).toBe("GET, HEAD");
          expect(res.body.length, label).toBe(0);
          expect(res.headers["content-length"], label).toBe("0");
          expect(res.headers["content-encoding"], label).toBeUndefined();
          expect(res.headers["cache-control"], label).toBe("no-store");
        }
      }
    }
  });

  test("5.7 越界或解码失败返回 403，响应体为空；响应到达时 server.log 已记下原始路径", async () => {
    for (const mode of MODES) {
      const { port } = server(mode);
      const requests = [
        ...FORBIDDEN_PATHS.map((rawPath) => ["GET", rawPath] as const),
        ["HEAD", FORBIDDEN_PATHS[0]] as const,
      ];
      for (const [method, rawPath] of requests) {
        const label = `${mode} ${method} ${rawPath}`;
        const offset = await logSize();
        const res = await rawRequest(port, method, rawPath);
        expect(res.status, label).toBe(403);
        expect(res.body.length, label).toBe(0);
        expect(res.headers["content-length"], label).toBe("0");
        expect(res.headers["content-encoding"], label).toBeUndefined();
        expect(res.headers["cache-control"], label).toBe("no-store");

        // 请求依次发出，这段时间内只有这一条 403，日志应恰好新增一行
        const lines = await logLinesSince(offset);
        expect(lines, label).toHaveLength(1);
        expect(lines[0], label).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /);
        expect(lines[0], label).toContain(` 127.0.0.1:${port} ${mode} 403 ${method} ${rawPath} `);
      }
    }
  });

  test("5.8 只在 127.0.0.1 上监听：经 ::1 连不上", async () => {
    for (const mode of MODES) {
      const s = server(mode);
      expect(s.origin).toBe(`http://127.0.0.1:${s.port}`);
      expect(s.mode).toBe(mode);
      await expect(rawRequest(s.port, "GET", "/", { host: "::1" }), mode).rejects.toThrow();
    }
  });

  test("5.8 server.log 位于被服务的目录之内时拒绝启动，且不创建该文件", async () => {
    for (const log of [path.join(appRoot, "server.log"), path.join(libRoot, "data", "server.log")]) {
      await expect(
        createE2EServer({ port: 0, mode: "opaque", appRoot, libRoot, log }),
        log,
      ).rejects.toThrow(/server\.log 不能位于被服务的目录之内/);
      const code = await stat(log).then(
        () => "已创建",
        (error: NodeJS.ErrnoException) => error.code,
      );
      expect(code, log).toBe("ENOENT");
    }
  });

  test("5.8 各类请求前后，App_Build 与书库根下的文件列表、字节数与修改时间不变", async () => {
    const before = { app: await treeState(appRoot), lib: await treeState(libRoot) };
    const body = Buffer.from("overwrite", "utf8");
    for (const mode of MODES) {
      const { port } = server(mode);
      for (const [rawPath] of HIT_CASES) {
        await rawRequest(port, "GET", rawPath);
        await rawRequest(port, "HEAD", rawPath);
      }
      for (const rawPath of [...FALLBACK_PATHS, ...FORBIDDEN_PATHS]) {
        await rawRequest(port, "GET", rawPath);
      }
      for (const method of REJECTED_METHODS) {
        for (const rawPath of [TXT_GZ_PATH, "/data/books.json", "/index.html", "/new.txt", "/books/new.txt.gz"]) {
          await rawRequest(port, method, rawPath, { body });
        }
      }
    }
    const after = { app: await treeState(appRoot), lib: await treeState(libRoot) };
    expect(after).toEqual(before);
  });
});
