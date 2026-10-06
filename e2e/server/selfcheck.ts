/**
 * 服务器自检（设计"E2E_Server"一节的检查清单；需求 5.10、5.11）。
 *
 * globalSetup 在全部实例启动之后、任何 UI 用例之前，对每个实例调用一次 `runSelfcheck`，
 * 把返回值写入 `e2e/.out/selfcheck.json`；任一实例 `ok` 为 false 即以阶段"服务器自检"中止，
 * 并把 `selfcheckFailures()` 的结果作为 `abort.json` 的 `checks`（5.11）。
 *
 * 请求一律经 `node:http.request({ path })` 发出，路径原样进入请求行。WHATWG `fetch` 会先把
 * `%2e%2e` 规范化成 `..` 再消解，越界请求根本到不了服务器。每项请求自发出起
 * `TIMEOUTS.serverRequest` 内没有收完响应体即判失败（5.10），不再评估该请求的其余断言。
 *
 * 5 项请求及各自断言的条目：
 *
 * | 请求 | 断言 |
 * | --- | --- |
 * | `/books/<中文 id>.txt.gz` | 200；响应体与磁盘文件 SHA-256 相同、`Content-Length` 等于文件字节数（5.2、5.3/5.4）；`Content-Encoding` 在 Opaque_Mode 缺失、在 Transparent_Mode 为 `gzip`（5.3/5.4）；`Content-Type`（5.13） |
 * | `/data/books.json` | 200；与磁盘文件相同（5.2）；`Content-Type`；无 `Content-Encoding`（5.13） |
 * | `/books/__missing__.txt.gz` | 200；与 App_Build 的 `index.html` 相同（5.6）；`Content-Type` 为 html；无 `Content-Encoding`（5.13） |
 * | `/read/<中文 id>` | 同上（5.6、5.13） |
 * | `/%2e%2e/%2e%2e/package.json` | 403；响应体为空；无 `Content-Encoding`；`server.log` 新增一行记下原始路径（5.7、5.13） |
 *
 * 期望的 Content-Type 取自 `resolve.ts` 的 `contentTypeFor`，表只定义一份（5.13）。
 *
 * `selfcheck.json`（`SELFCHECK_FILE`）的格式即 `SelfcheckReport`，由 globalSetup 以
 * `writeSelfcheckReport` 写出，`tests/tooling/selfcheck.spec.ts`（`@selfcheck`）以
 * `readSelfcheckReport` 读取并断言。
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LIBRARY_PROFILES, type LibraryProfile } from "../support/library";
import { TIMEOUTS } from "../support/settings";
import { contentTypeFor, type Mode } from "./resolve";

/** 仓库根（本文件位于 `e2e/server/`）。 */
const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** globalSetup 第 5 步写出的逐项自检结果（5.10），在被 gitignore 的 `e2e/.out/` 内。 */
export const SELFCHECK_FILE = path.join(REPO_ROOT, "e2e", ".out", "selfcheck.json");

/** 与 server.ts 监听的地址相同（5.8）。 */
const HOST = "127.0.0.1";

/** 书库中一定不存在的 `.txt.gz`（5.6）。 */
const MISSING_TXT_GZ_PATH = "/books/__missing__.txt.gz";
/** `%2e%2e` 编码的越界路径：解码后两次 `..` 越过根目录（5.7）。 */
const TRAVERSAL_PATH = "/%2e%2e/%2e%2e/package.json";

/** 响应头缺失时在期望值 / 实际值里的写法。 */
const ABSENT = "（无）";

/** 被检查的一个 E2E_Server 实例。字段与 `createE2EServer` 的选项对应。 */
export interface SelfcheckTarget {
  /** 实例名，如 `fixture-opaque`；写入结果，便于在 `selfcheck.json` 与 Run_Summary 中区分实例。 */
  instance: string;
  /** 实际监听的端口（`E2EServer.port`）。 */
  port: number;
  mode: Mode;
  /** 该实例的 App_Build 目录：回退响应与其中的 `index.html` 比对（5.6）。 */
  appRoot: string;
  /** 该实例的书库根：`.txt.gz` 与 `books.json` 与其下的文件比对（5.2）。 */
  libRoot: string;
  /** 该实例的 `server.log` 路径（创建实例时传入的 `log`），用于核对 5.7 的日志行。 */
  log: string;
  /** 从该实例书库中取的一本书，id 须含中文字符（5.10）。 */
  bookId: string;
}

/** 一条断言的结果，即 5.11 要逐项报告的检查项。 */
export interface SelfcheckItem {
  /** `<请求>：<断言>`，如 `中文 id 的 .txt.gz：Content-Encoding`。 */
  name: string;
  /** 请求行里的原样路径。 */
  path: string;
  expected: string;
  actual: string;
  ok: boolean;
}

/** 一个实例的自检结果；`ok` 为全部 `items` 均通过。 */
export interface SelfcheckResult {
  instance: string;
  origin: string;
  mode: Mode;
  bookId: string;
  ok: boolean;
  items: SelfcheckItem[];
}

/**
 * 本次选中、但 globalSetup 没有启动的实例。它不算自检失败。
 *
 * Library_Profile 只有 fixture，globalSetup 在第 4 步启动它的两个实例之后才自检；书库不可用
 * （Fixture_Generator 失败，3.9）时第 2 步即中止，不写 `selfcheck.json`。所以写出的 `skipped`
 * 总是空数组，字段保留在文件格式中，读取方照常核对。
 */
export interface SelfcheckSkipped {
  instance: string;
  port: number;
  mode: Mode;
  /** 跳过原因，与用例的跳过原因相同（如 `[3.9] …`）。 */
  reason: string;
}

/** `selfcheck.json` 的内容。 */
export interface SelfcheckReport {
  /** 写入时刻，ISO 8601（UTC）。 */
  checkedAt: string;
  /** 本次选中的 Library_Profile。 */
  profiles: readonly LibraryProfile[];
  /** 已启动实例的自检结果，按启动顺序。 */
  results: SelfcheckResult[];
  /** 选中但未启动的实例（见 `SelfcheckSkipped`，现在总是空数组）。 */
  skipped: SelfcheckSkipped[];
  /** 自检未能进行（前置条件不成立，如读不到比对基准文件）时的实例与原因；正常时省略。 */
  error?: { instance: string; message: string };
  /** 没有 `error`，且 `results` 的每个实例都通过。 */
  ok: boolean;
}

/** 写 `selfcheck.json`（覆盖已有文件，父目录不存在时创建）。 */
export async function writeSelfcheckReport(
  report: SelfcheckReport,
  file: string = SELFCHECK_FILE,
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 读 `selfcheck.json`。文件不存在时返回 null（本次运行没有走到自检）；内容不合法时抛错，
 * 错误信息含文件路径与第一处不合法的字段。只校验字段的类型，不校验字段之间是否一致
 * （如 `ok` 与逐项结果），那是读取方要断言的内容。
 */
export async function readSelfcheckReport(file: string = SELFCHECK_FILE): Promise<SelfcheckReport | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const bad = (what: string): Error => new Error(`${file} 格式无效：${what}`);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw bad(`不是合法 JSON（${errorText(error)}）`);
  }

  const obj = (v: unknown, where: string): Record<string, unknown> => {
    if (!isRecord(v)) throw bad(`${where} 不是对象`);
    return v;
  };
  const arr = (v: unknown, where: string): unknown[] => {
    if (!Array.isArray(v)) throw bad(`${where} 不是数组`);
    return v;
  };
  const str = (v: unknown, where: string): string => {
    if (typeof v !== "string") throw bad(`${where} 不是字符串`);
    return v;
  };
  const bool = (v: unknown, where: string): boolean => {
    if (typeof v !== "boolean") throw bad(`${where} 不是布尔值`);
    return v;
  };
  const mode = (v: unknown, where: string): Mode => {
    if (v !== "opaque" && v !== "transparent") throw bad(`${where} 为 ${JSON.stringify(v)}`);
    return v;
  };

  const top = obj(data, "顶层");
  const checkedAt = str(top.checkedAt, "checkedAt");
  if (Number.isNaN(Date.parse(checkedAt))) throw bad(`checkedAt 为 ${JSON.stringify(checkedAt)}`);
  const profiles = arr(top.profiles, "profiles").map((p, i): LibraryProfile => {
    const known = LIBRARY_PROFILES.find((profile) => profile === p);
    if (known === undefined) throw bad(`profiles[${i}] 为 ${JSON.stringify(p)}`);
    return known;
  });
  const results = arr(top.results, "results").map((raw, i): SelfcheckResult => {
    const where = `results[${i}]`;
    const r = obj(raw, where);
    return {
      instance: str(r.instance, `${where}.instance`),
      origin: str(r.origin, `${where}.origin`),
      mode: mode(r.mode, `${where}.mode`),
      bookId: str(r.bookId, `${where}.bookId`),
      ok: bool(r.ok, `${where}.ok`),
      items: arr(r.items, `${where}.items`).map((rawItem, j): SelfcheckItem => {
        const at = `${where}.items[${j}]`;
        const item = obj(rawItem, at);
        return {
          name: str(item.name, `${at}.name`),
          path: str(item.path, `${at}.path`),
          expected: str(item.expected, `${at}.expected`),
          actual: str(item.actual, `${at}.actual`),
          ok: bool(item.ok, `${at}.ok`),
        };
      }),
    };
  });
  const skipped = arr(top.skipped, "skipped").map((raw, i): SelfcheckSkipped => {
    const where = `skipped[${i}]`;
    const s = obj(raw, where);
    if (!Number.isInteger(s.port)) throw bad(`${where}.port 为 ${JSON.stringify(s.port)}`);
    return {
      instance: str(s.instance, `${where}.instance`),
      port: s.port as number,
      mode: mode(s.mode, `${where}.mode`),
      reason: str(s.reason, `${where}.reason`),
    };
  });
  const report: SelfcheckReport = { checkedAt, profiles, results, skipped, ok: bool(top.ok, "ok") };
  if (top.error !== undefined) {
    const e = obj(top.error, "error");
    report.error = { instance: str(e.instance, "error.instance"), message: str(e.message, "error.message") };
  }
  return report;
}

/** `abort.json` 中 `checks` 的一项（设计 Data Models 的 `AbortInfo.checks`）。 */
export interface SelfcheckFailure {
  name: string;
  path: string;
  expected: string;
  actual: string;
}

/** 收完的响应：只保留断言要用的部分，响应体只留摘要与字节数。 */
interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  sha256: string;
  size: number;
  ms: number;
}

interface Digest {
  sha256: string;
  size: number;
}

function digestOf(bytes: Buffer): Digest {
  return { sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
}

function describeDigest(d: Digest): string {
  return `sha256 ${d.sha256}，${d.size} 字节`;
}

/** 读取用作比对基准的磁盘文件。读不到说明书库或 App_Build 本身有问题，直接抛错。 */
async function digestFile(p: string, what: string): Promise<Digest> {
  try {
    return digestOf(await readFile(p, { flag: "r" }));
  } catch (error) {
    // 同 server.ts：原样重抛以保留 `code`（如 ENOENT），消息前加上是自检读哪个文件失败
    if (error instanceof Error) {
      error.message = `服务器自检无法读取${what} ${p}（${error.message}）`;
    }
    throw error;
  }
}

function headerText(value: string | string[] | undefined): string {
  if (value === undefined) return ABSENT;
  return Array.isArray(value) ? value.join(", ") : value;
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code ? `${code}：${error.message}` : error.message;
  }
  return String(error);
}

/**
 * 以 GET 发出原样路径，收完响应体后返回。自发出起 `timeoutMs` 内未收完即以超时 reject；
 * 连接失败、响应体不完整（服务器提前断开）同样 reject。
 *
 * `agent: false` 让每项请求独占一条 `Connection: close` 的连接，不在全局 agent 里留下
 * keep-alive 套接字。
 */
function rawGet(port: number, rawPath: string, timeoutMs: number): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    const started = performance.now();
    let req: http.ClientRequest;
    try {
      req = http.request({ host: HOST, port, path: rawPath, method: "GET", agent: false });
    } catch (error) {
      // 路径含请求行不允许的字符时同步抛出（ERR_UNESCAPED_CHARACTERS）
      reject(error);
      return;
    }
    // 先以超时 reject 再断开：断开引发的 "socket hang up" / "aborted" 等错误随后到达时
    // Promise 已定，报告里留下的是超时原因
    const timer = setTimeout(() => {
      reject(new Error(`${timeoutMs} ms 内未收到完整响应`));
      req.destroy();
    }, timeoutMs);
    const fail = (error: unknown) => {
      clearTimeout(timer);
      reject(error);
    };
    req.on("error", fail);
    req.on("response", (res) => {
      const hash = createHash("sha256");
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        hash.update(chunk);
        size += chunk.length;
      });
      res.on("error", fail);
      res.on("end", () => {
        clearTimeout(timer);
        if (!res.complete) {
          reject(new Error("响应体不完整：连接在收完之前断开"));
          return;
        }
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          sha256: hash.digest("hex"),
          size,
          ms: Math.round(performance.now() - started),
        });
      });
    });
    req.end();
  });
}

/** `server.log` 当前的字节数；文件尚不存在时为 0。 */
async function logSize(log: string): Promise<number> {
  try {
    return (await stat(log)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

/** 一项请求的断言收集器：先发请求，再逐条记下断言结果。 */
class RequestCheck {
  readonly items: SelfcheckItem[] = [];
  private readonly label: string;
  readonly path: string;

  constructor(label: string, rawPath: string) {
    this.label = label;
    this.path = rawPath;
  }

  add(aspect: string, expected: string, actual: string): void {
    this.items.push({
      name: `${this.label}：${aspect}`,
      path: this.path,
      expected,
      actual,
      ok: expected === actual,
    });
  }

  /** 发出请求并记"完整响应"一条；失败时返回 null，调用方不再评估其余断言。 */
  async fetch(port: number): Promise<RawResponse | null> {
    const expected = `${TIMEOUTS.serverRequest} ms 内收到`;
    try {
      const res = await rawGet(port, this.path, TIMEOUTS.serverRequest);
      this.items.push({
        name: `${this.label}：完整响应`,
        path: this.path,
        expected,
        actual: `${res.ms} ms 内收到，${res.size} 字节`,
        ok: true,
      });
      return res;
    } catch (error) {
      this.add("完整响应", expected, `未收到：${errorText(error)}`);
      return null;
    }
  }

  status(res: RawResponse, expected: number): void {
    this.add("状态码", String(expected), String(res.status));
  }

  body(res: RawResponse, expected: Digest, what: string): void {
    this.add(`响应体与${what}相同`, describeDigest(expected), describeDigest(res));
  }

  header(res: RawResponse, name: string, expected: string): void {
    this.add(name, expected, headerText(res.headers[name.toLowerCase()]));
  }
}

/**
 * 对一个实例执行 5 项自检请求，按清单顺序返回每条断言的结果。
 *
 * 请求依次发出（不并发）。检查项失败不抛错，只体现在 `ok` 与各条 `items` 上；只有前置条件
 * 不成立时才抛错：`bookId` 不含中文字符，或读不到作为比对基准的磁盘文件
 * （`<libRoot>/books/<id>.txt.gz`、`<libRoot>/data/books.json`、`<appRoot>/index.html`）。
 *
 * 5.7 的日志核对只看本次请求之后 `server.log` 新增的部分，并按端口筛选日志行，
 * 多个实例共用一份日志时同样成立。
 */
export async function runSelfcheck(target: SelfcheckTarget): Promise<SelfcheckResult> {
  const { instance, port, mode, bookId } = target;
  if (!/\p{Script=Han}/u.test(bookId)) {
    throw new Error(`服务器自检须取 id 含中文字符的书（5.10），实例 ${instance} 收到的是 ${JSON.stringify(bookId)}`);
  }

  const libRoot = path.resolve(target.libRoot);
  const txtGzFile = path.join(libRoot, "books", `${bookId}.txt.gz`);
  const [txtGz, booksJson, indexHtml] = await Promise.all([
    digestFile(txtGzFile, "书库中的"),
    digestFile(path.join(libRoot, "data", "books.json"), "书库中的"),
    digestFile(path.join(path.resolve(target.appRoot), "index.html"), " App_Build 的"),
  ]);
  const htmlType = contentTypeFor("index.html", mode);
  const encodedId = encodeURIComponent(bookId);
  const checks: RequestCheck[] = [];

  // 1. 中文 id 的 .txt.gz：命中书库文件，头部按模式区分（5.2、5.3 / 5.4、5.13）
  {
    const c = new RequestCheck("中文 id 的 .txt.gz", `/books/${encodedId}.txt.gz`);
    checks.push(c);
    const res = await c.fetch(port);
    if (res) {
      c.status(res, 200);
      c.body(res, txtGz, "磁盘文件");
      c.header(res, "Content-Length", String(txtGz.size));
      c.header(res, "Content-Encoding", mode === "transparent" ? "gzip" : ABSENT);
      c.header(res, "Content-Type", contentTypeFor(txtGzFile, mode));
    }
  }

  // 2. /data/books.json：命中书库文件（5.2、5.13）
  {
    const c = new RequestCheck("/data/books.json", "/data/books.json");
    checks.push(c);
    const res = await c.fetch(port);
    if (res) {
      c.status(res, 200);
      c.body(res, booksJson, "磁盘文件");
      c.header(res, "Content-Type", contentTypeFor("books.json", mode));
      c.header(res, "Content-Encoding", ABSENT);
    }
  }

  // 3、4. 未命中的书库路径与前端路由：回退 index.html，两种模式相同（5.6、5.13）
  for (const [label, rawPath] of [
    ["不存在的 .txt.gz", MISSING_TXT_GZ_PATH],
    ["/read/<中文 id> 深链接", `/read/${encodedId}`],
  ] as const) {
    const c = new RequestCheck(label, rawPath);
    checks.push(c);
    const res = await c.fetch(port);
    if (res) {
      c.status(res, 200);
      c.body(res, indexHtml, " index.html ");
      c.header(res, "Content-Type", htmlType);
      c.header(res, "Content-Encoding", ABSENT);
    }
  }

  // 5. %2e%2e 越界：403、空响应体、日志记下原始路径（5.7、5.13）
  {
    const c = new RequestCheck("%2e%2e 越界路径", TRAVERSAL_PATH);
    checks.push(c);
    const logPath = path.resolve(target.log);
    const offset = await logSize(logPath);
    const res = await c.fetch(port);
    if (res) {
      c.status(res, 403);
      c.add("响应体字节数", "0", String(res.size));
      c.header(res, "Content-Encoding", ABSENT);
      // server.ts 在发出 403 之前写完日志行，此时新增部分应已落盘
      const expected = `新增一行含 :${port} 与 ${TRAVERSAL_PATH}`;
      let actual: string;
      try {
        const added = (await readFile(logPath, { flag: "r" })).subarray(offset).toString("utf8");
        const lines = added.split("\n").filter((l) => l !== "");
        const hit = lines.find((l) => l.includes(`:${port} `) && l.includes(` ${TRAVERSAL_PATH} `));
        actual = hit === undefined ? `未找到（新增 ${lines.length} 行）` : expected;
      } catch (error) {
        actual = `无法读取 ${logPath}：${errorText(error)}`;
      }
      c.add("server.log 记录原始路径", expected, actual);
    }
  }

  const items = checks.flatMap((c) => c.items);
  return {
    instance,
    origin: `http://${HOST}:${port}`,
    mode,
    bookId,
    ok: items.every((item) => item.ok),
    items,
  };
}

/**
 * 取出全部未通过的检查项，作为 `abort.json` 的 `checks`（5.11）。
 * 名称前加 `[实例名]`，多个实例的失败合在一张表里时仍能区分。
 */
export function selfcheckFailures(results: readonly SelfcheckResult[]): SelfcheckFailure[] {
  return results.flatMap((r) =>
    r.items
      .filter((item) => !item.ok)
      .map(({ name, path: p, expected, actual }) => ({
        name: `[${r.instance}] ${name}`,
        path: p,
        expected,
        actual,
      })),
  );
}
