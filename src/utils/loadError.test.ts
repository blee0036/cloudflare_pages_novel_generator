import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { BookTextInvalidError, type BookTextInvalidReason } from "./bookTextCheck";
import {
  HttpStatusError,
  NetworkError,
  READER_LOAD_ERROR_TEXT,
  ResponseFormatError,
  SHELF_LOAD_ERROR_TEXT,
  classifyLoadError,
  fetchJson,
  formatLoadErrorLog,
  type FetchProgress,
  type LoadErrorCategory,
  type LoadStage,
  type ShelfLoadErrorCategory,
} from "./loadError";

/**
 * `src/utils/loadError.ts`（reader-defect-fixes 需求 13，F-011、F-012）。
 *
 * `fetchJson` 的测试注入假 `fetch`，响应由 Node 的全局 `Response` 构造：`res.ok`、`res.status`
 * 与 `res.json()` 都走真实实现，假的只有"发请求"这一步。
 *
 * `classifyLoadError` 与两张文案表对照本文件里独立写下的参照：分类表抄自设计第 12 节，
 * 文案抄自需求 13.1 与 13.7 的原文，而不是从被测模块读取（Property 7）。
 * `formatLoadErrorLog` 以示例逐字断言整行日志。
 */

// ---------------------------------------------------------------------------
// fetchJson：假 fetch 与参照模型
// ---------------------------------------------------------------------------

/**
 * [200, 599] 内规定不带响应体的状态码。`Response` 构造时这些状态的响应体必须为 `null`
 * （连空串也不行，否则抛 TypeError）；[200, 599] 之外的状态码（含 1xx）构造时直接抛 RangeError。
 */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([204, 205, 304]);

/** 注入的 `fetch` 的行为：给出一个响应，或拒绝（异步拒绝 / 同步抛出）。 */
type FetchOutcome =
  | { kind: "respond"; status: number; body: string | null }
  | { kind: "reject"; sync: boolean; cause: unknown };

/** 按 `outcome` 构造假 `fetch`，并记下每次调用的参数。每次调用都新建 `Response`（响应体只能读一次）。 */
function fakeFetch(outcome: FetchOutcome): { fetchImpl: typeof fetch; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const fetchImpl: typeof fetch = (...args) => {
    calls.push(args);
    if (outcome.kind === "reject") {
      if (outcome.sync) throw outcome.cause;
      return Promise.reject(outcome.cause);
    }
    return Promise.resolve(new Response(outcome.body, { status: outcome.status }));
  };
  return { fetchImpl, calls };
}

type Expected =
  | { kind: "value"; value: unknown }
  | { kind: "http"; status: number }
  | { kind: "format" }
  | { kind: "network"; cause: unknown };

/**
 * 参照模型（design Property 6）：拒绝 → `NetworkError`；非 2xx → `HttpStatusError`；
 * 2xx 且响应体是合法 JSON → `JSON.parse(b)`；其余（无响应体、空串、非 JSON）→ `ResponseFormatError`。
 */
function expectedOutcome(outcome: FetchOutcome): Expected {
  if (outcome.kind === "reject") return { kind: "network", cause: outcome.cause };
  if (outcome.status < 200 || outcome.status > 299) return { kind: "http", status: outcome.status };
  // 无响应体按空字节序列解析，与空串一样不是 JSON
  if (outcome.body === null) return { kind: "format" };
  try {
    return { kind: "value", value: JSON.parse(outcome.body) as unknown };
  } catch {
    return { kind: "format" };
  }
}

type Settled = { ok: true; value: unknown } | { ok: false; error: unknown };

async function settle(promise: Promise<unknown>): Promise<Settled> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error };
  }
}

/** 断言以 `cls` 的实例拒绝，并取出该错误。 */
function rejectedWith<T>(got: Settled, cls: new (...args: never[]) => T): T {
  if (got.ok) throw new Error(`应以 ${cls.name} 拒绝，实际解析为 ${JSON.stringify(got.value)}`);
  expect(got.error).toBeInstanceOf(cls);
  return got.error as T;
}

// ---------------------------------------------------------------------------
// fetchJson：生成器
// ---------------------------------------------------------------------------

/** 请求地址：站内两种 JSON 路径、任意绝对 URL、任意文本（`fetchJson` 只是原样转交并记入错误）。 */
const requestUrl = fc.oneof(
  fc.constantFrom("/books.json", "/books/abc/_toc.json", "./books.json"),
  fc.webUrl(),
  fc.string({ unit: "grapheme", maxLength: 20 }),
);

/**
 * 状态码 ∈ [200, 599]。2xx 只占全区间约四分之一，另加一路 2xx 让解析分支常被覆盖；
 * 再加一路边界与常见值（2xx / 3xx 的两端、无响应体的 204 / 205 / 304、404、5xx）。
 */
const status = fc.oneof(
  fc.integer({ min: 200, max: 599 }),
  fc.integer({ min: 200, max: 299 }),
  fc.constantFrom(200, 204, 205, 299, 300, 304, 399, 400, 404, 500, 503, 599),
);

const whitespace = fc.string({ unit: fc.constantFrom(" ", "\t", "\n", "\r"), maxLength: 3 });

/**
 * 合法 JSON 文本：任意 JSON 值的序列化（含中文等非 ASCII 字符串）、首尾带 JSON 空白的序列化，
 * 以及几个边角值（`-0`、超出范围读作 Infinity 的 `1e400`、重复键）。
 *
 * `JSON.stringify` 会把孤立代理项转义成 `\uXXXX`，输出总是良构的 UTF-16，经 `Response`
 * 的 UTF-8 编解码往返后不变，所以 `res.json()` 与 `JSON.parse(b)` 读到的是同一段文本。
 */
const jsonText = fc.oneof(
  fc.json({ maxDepth: 3, stringUnit: "grapheme" }),
  fc.tuple(whitespace, fc.json({ maxDepth: 2 }), whitespace).map(([lead, json, trail]) => lead + json + trail),
  fc.constantFrom("null", "0", "-0", "1e400", '""', "[]", "{}", '{"a":1,"a":2}'),
);

/** SPA 回退返回的 `index.html` 一类 HTML 文本。 */
const htmlText = fc.oneof(
  fc.constant(
    '<!DOCTYPE html>\n<html lang="zh-CN"><head><meta charset="UTF-8" /></head><body><div id="root"></div></body></html>',
  ),
  fc.string({ unit: "grapheme", maxLength: 20 }).map((s) => `<!DOCTYPE html><title>${s}</title>`),
);

/**
 * 截断的 JSON：取序列化结果的真前缀。默认的 `fc.json()` 只含 ASCII，截断不会切开代理对。
 * 某些前缀仍是合法 JSON（`"12"` 取自 `"123"`），期望值由参照模型判定。
 */
const truncatedJson = fc
  .json({ maxDepth: 2 })
  .chain((json) => fc.nat({ max: json.length - 1 }).map((k) => json.slice(0, k)));

/**
 * 任意文本：可打印 ASCII 与 Unicode 字素（字素不含孤立代理项）。
 *
 * 去掉以 U+FEFF 开头的文本：`res.json()` 按 UTF-8 解码时会剥掉开头的 BOM，`JSON.parse` 不会，
 * 二者对这类文本本来就不同，不属于 `fetchJson` 的行为。
 */
const arbitraryText = fc
  .oneof(fc.string({ maxLength: 30 }), fc.string({ unit: "grapheme", maxLength: 30 }))
  .filter((s) => !s.startsWith("\uFEFF"));

const bodyText = fc.oneof(
  { arbitrary: jsonText, weight: 3 },
  { arbitrary: htmlText, weight: 1 },
  { arbitrary: truncatedJson, weight: 1 },
  { arbitrary: arbitraryText, weight: 2 },
  { arbitrary: fc.constant(""), weight: 1 },
);

/** 无响应体的状态只能配 `null`；其余状态多数带文本，约 1/8 的情形也不带响应体。 */
const bodyFor = (st: number): fc.Arbitrary<string | null> =>
  NULL_BODY_STATUSES.has(st) ? fc.constant(null) : fc.option(bodyText, { nil: null, freq: 8 });

const message = fc.string({ unit: "grapheme", maxLength: 20 });

/**
 * `fetch` 拒绝的原因：原生 `TypeError`（断网、DNS 失败、CORS）、其他 `Error` 子类、
 * `AbortError`，以及字符串、数字、`null`、`undefined`、普通对象等非 `Error` 值。
 */
const rejectionCause: fc.Arbitrary<unknown> = fc.oneof(
  message.map((m) => new TypeError(m)),
  fc.constant(new TypeError("Failed to fetch")),
  message.map((m) => new Error(m)),
  message.map((m) => new RangeError(m)),
  fc.constant(new DOMException("The operation was aborted.", "AbortError")),
  fc.constantFrom<unknown>(null, undefined, "offline", 0),
  fc.anything(),
);

const fetchOutcome: fc.Arbitrary<FetchOutcome> = fc.oneof(
  {
    arbitrary: status.chain((st) =>
      bodyFor(st).map((body): FetchOutcome => ({ kind: "respond", status: st, body })),
    ),
    weight: 4,
  },
  {
    arbitrary: fc
      .tuple(fc.boolean(), rejectionCause)
      .map(([sync, cause]): FetchOutcome => ({ kind: "reject", sync, cause })),
    weight: 1,
  },
);

// ---------------------------------------------------------------------------
// fetchJson
// ---------------------------------------------------------------------------

describe("fetchJson", () => {
  it("2xx 且响应体是 JSON：解析为该值", async () => {
    const { fetchImpl, calls } = fakeFetch({ kind: "respond", status: 200, body: '{"books":[]}' });
    await expect(fetchJson("/books.json", fetchImpl)).resolves.toEqual({ books: [] });
    expect(calls).toEqual([["/books.json"]]);
  });

  it("404：以 HttpStatusError 拒绝，带状态码与地址", async () => {
    const { fetchImpl } = fakeFetch({ kind: "respond", status: 404, body: "Not Found" });
    const e = rejectedWith(await settle(fetchJson("/books/x/_toc.json", fetchImpl)), HttpStatusError);
    expect(e.status).toBe(404);
    expect(e.url).toBe("/books/x/_toc.json");
  });

  it("200 但响应体是 SPA 回退的 index.html：以 ResponseFormatError 拒绝", async () => {
    const html = '<!DOCTYPE html><html><body><div id="root"></div></body></html>';
    const { fetchImpl } = fakeFetch({ kind: "respond", status: 200, body: html });
    const e = rejectedWith(await settle(fetchJson("/books/x/_toc.json", fetchImpl)), ResponseFormatError);
    expect(e.url).toBe("/books/x/_toc.json");
    expect((e.cause as Error).name).toBe("SyntaxError");
  });

  it("fetch 以 TypeError 拒绝：以 NetworkError 拒绝，cause 为原错误", async () => {
    const cause = new TypeError("Failed to fetch");
    const { fetchImpl } = fakeFetch({ kind: "reject", sync: false, cause });
    const e = rejectedWith(await settle(fetchJson("/books.json", fetchImpl)), NetworkError);
    expect(e.cause).toBe(cause);
    expect(e.url).toBe("/books.json");
  });

  // Feature: reader-defect-fixes, Property 6: `fetchJson` 按状态码与响应体抛出对应错误
  // **Validates: Requirements 13.1, 13.7**
  it("对任意状态码 ∈ [200, 599]、响应体与 fetch 拒绝：结果等于参照模型，错误带正确的 status / url / cause", async () => {
    await fc.assert(
      fc.asyncProperty(requestUrl, fetchOutcome, async (url, outcome) => {
        const { fetchImpl, calls } = fakeFetch(outcome);
        const got = await settle(fetchJson<unknown>(url, fetchImpl));

        // 恰好请求一次，地址原样转交
        expect(calls).toHaveLength(1);
        expect(calls[0][0]).toBe(url);

        const want = expectedOutcome(outcome);
        switch (want.kind) {
          case "value":
            expect(got).toEqual({ ok: true, value: want.value });
            break;
          case "http": {
            const e = rejectedWith(got, HttpStatusError);
            expect(e.name).toBe("HttpStatusError");
            expect(e.status).toBe(want.status);
            expect(e.url).toBe(url);
            break;
          }
          case "format": {
            const e = rejectedWith(got, ResponseFormatError);
            expect(e.name).toBe("ResponseFormatError");
            expect(e.url).toBe(url);
            // 原因是 res.json() 的解析错误，而不是别的什么
            expect((e.cause as Error).name).toBe("SyntaxError");
            break;
          }
          case "network": {
            const e = rejectedWith(got, NetworkError);
            expect(e.name).toBe("NetworkError");
            expect(e.url).toBe(url);
            expect(e.cause).toBe(want.cause);
            break;
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// fetchJson：带进度上报（书架加载遮罩用）
// ---------------------------------------------------------------------------

/** 按给定分片构造响应体流：分片边界由测试控制，进度上报就能逐片核对。 */
function chunkedResponse(chunks: Uint8Array[], init: ResponseInit = {}): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Response(body, init);
}

/** 把 UTF-8 字节切成大小不等的若干片（可能切开多字节字符，解码要拼完再做）。 */
function splitBytes(bytes: Uint8Array, cuts: number[]): Uint8Array[] {
  const points = [...new Set(cuts.map((c) => c % (bytes.length + 1)))].sort((a, b) => a - b);
  const out: Uint8Array[] = [];
  let start = 0;
  for (const point of [...points, bytes.length]) {
    if (point > start) out.push(bytes.slice(start, point));
    start = Math.max(start, point);
  }
  return out;
}

describe("fetchJson 带 onProgress", () => {
  it("逐片上报已收字节数，先报一次 0；结果与不带进度时相同", async () => {
    const text = JSON.stringify({ books: [{ id: "青石巷-夜行", title: "青石巷" }] });
    const bytes = new TextEncoder().encode(text);
    const chunks = splitBytes(bytes, [5, 17, 30]);
    const reports: FetchProgress[] = [];
    const fetchImpl: typeof fetch = () => Promise.resolve(chunkedResponse(chunks));

    const got = await fetchJson("/data/books.json", fetchImpl, (p) => reports.push(p));

    expect(got).toEqual(JSON.parse(text));
    let sum = 0;
    const expected = [0, ...chunks.map((c) => (sum += c.length))];
    expect(reports.map((r) => r.received)).toEqual(expected);
    expect(reports.every((r) => r.total === null)).toBe(true);
  });

  it.each<[string, Record<string, string>, number | null]>([
    ["没有 Content-Encoding：取 Content-Length", { "content-length": "42" }, 42],
    ["Content-Encoding: identity 同上", { "content-length": "42", "content-encoding": "identity" }, 42],
    ["有传输压缩：Content-Length 是压缩后的长度，不用", { "content-length": "42", "content-encoding": "br" }, null],
    ["Content-Length 不是数字", { "content-length": "unknown" }, null],
    ["Content-Length 为 0", { "content-length": "0" }, null],
    ["没有 Content-Length", {}, null],
  ])("total：%s", async (_label, headers, total) => {
    const reports: FetchProgress[] = [];
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(chunkedResponse([new TextEncoder().encode("[]")], { headers }));
    await fetchJson("/data/books.json", fetchImpl, (p) => reports.push(p));
    expect(reports.length).toBeGreaterThan(0);
    expect(reports.every((r) => r.total === total)).toBe(true);
  });

  it("读响应体途中出错：以 NetworkError 拒绝，cause 为原错误", async () => {
    const cause = new TypeError("network error");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"books":'));
        controller.error(cause);
      },
    });
    const fetchImpl: typeof fetch = () => Promise.resolve(new Response(body));
    const e = rejectedWith(await settle(fetchJson("/data/books.json", fetchImpl, () => {})), NetworkError);
    expect(e.cause).toBe(cause);
    expect(e.url).toBe("/data/books.json");
  });

  // 与上面 Property 6 同一个参照模型：带不带进度，解析结果与三种错误都一样
  it("对任意状态码、响应体与 fetch 拒绝：结果等于参照模型；任意切片方式下最后一次上报等于响应体字节数", async () => {
    await fc.assert(
      fc.asyncProperty(
        requestUrl,
        fetchOutcome,
        fc.array(fc.nat(), { maxLength: 4 }),
        async (url, outcome, cuts) => {
          const reports: FetchProgress[] = [];
          let bodyBytes = 0;
          const fetchImpl: typeof fetch = () => {
            if (outcome.kind === "reject") {
              if (outcome.sync) throw outcome.cause;
              return Promise.reject(outcome.cause);
            }
            if (outcome.body === null) return Promise.resolve(new Response(null, { status: outcome.status }));
            const bytes = new TextEncoder().encode(outcome.body);
            bodyBytes = bytes.length;
            return Promise.resolve(chunkedResponse(splitBytes(bytes, cuts), { status: outcome.status }));
          };
          const got = await settle(fetchJson<unknown>(url, fetchImpl, (p) => reports.push(p)));

          const want = expectedOutcome(outcome);
          switch (want.kind) {
            case "value":
              expect(got).toEqual({ ok: true, value: want.value });
              expect(reports.at(-1)?.received).toBe(bodyBytes);
              break;
            case "http":
              expect(rejectedWith(got, HttpStatusError).status).toBe(want.status);
              expect(reports).toEqual([]);
              break;
            case "format": {
              const e = rejectedWith(got, ResponseFormatError);
              expect(e.url).toBe(url);
              expect((e.cause as Error).name).toBe("SyntaxError");
              expect(reports.at(-1)?.received).toBe(bodyBytes);
              break;
            }
            case "network":
              expect(rejectedWith(got, NetworkError).cause).toBe(want.cause);
              expect(reports).toEqual([]);
              break;
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// classifyLoadError 与文案：参照
// ---------------------------------------------------------------------------

/** 需求 13.1 的阅读器文案原文。 */
const READER_TEXT: Readonly<Record<LoadErrorCategory, string>> = {
  "not-found": "书库里找不到这本书，可能已被移除，或链接有误。",
  unavailable: "暂时无法连接书库，请检查网络后重试。",
  damaged: "这本书的正文文件缺失或已损坏，暂时无法打开。",
  unknown: "打开这本书时出了点问题，请稍后重试。",
};

/** 需求 13.7 的书架文案原文。 */
const SHELF_TEXT: Readonly<Record<ShelfLoadErrorCategory, string>> = {
  "not-found": "暂时找不到书库目录，站点可能正在更新，请稍后再试。",
  unavailable: "暂时无法连接书库，请检查网络后重试。",
  unknown: "加载书架时出了点问题，请稍后重试。",
};

/** 分类表的六列（设计第 12 节）：抛出值按类型落入其中一列。 */
type ThrownKind = "http-404" | "http-other" | "format" | "network" | "type-error" | "other";

/** 设计第 12 节的分类表。`catalog` 一行的类型本身就排除了 `damaged`（13.8）。 */
const EXPECTED_CATEGORY: {
  readonly toc: Readonly<Record<ThrownKind, LoadErrorCategory>>;
  readonly text: Readonly<Record<ThrownKind, LoadErrorCategory>>;
  readonly catalog: Readonly<Record<ThrownKind, ShelfLoadErrorCategory>>;
} = {
  toc: {
    "http-404": "not-found",
    "http-other": "unavailable",
    format: "not-found",
    network: "unavailable",
    "type-error": "unknown",
    other: "unknown",
  },
  catalog: {
    "http-404": "not-found",
    "http-other": "unavailable",
    format: "not-found",
    network: "unavailable",
    "type-error": "unknown",
    other: "unknown",
  },
  text: {
    "http-404": "damaged",
    "http-other": "damaged",
    format: "damaged",
    network: "unavailable",
    "type-error": "unavailable",
    other: "damaged",
  },
};

const STAGES: readonly LoadStage[] = ["toc", "text", "catalog"];

/** 页面显示的说明：阅读器两阶段查 `READER_LOAD_ERROR_TEXT`，书架查 `SHELF_LOAD_ERROR_TEXT`。 */
function displayedText(stage: LoadStage, error: unknown): string {
  // `catalog` 走 classifyLoadError 的书架重载，返回值可直接索引书架文案表
  if (stage === "catalog") return SHELF_LOAD_ERROR_TEXT[classifyLoadError(stage, error)];
  return READER_LOAD_ERROR_TEXT[classifyLoadError(stage, error)];
}

/** 参照：分类表给出类别，再查需求原文。 */
function expectedText(stage: LoadStage, kind: ThrownKind): string {
  if (stage === "catalog") return SHELF_TEXT[EXPECTED_CATEGORY.catalog[kind]];
  return READER_TEXT[EXPECTED_CATEGORY[stage][kind]];
}

// ---------------------------------------------------------------------------
// classifyLoadError：生成器
// ---------------------------------------------------------------------------

/**
 * 抛出值的"形状"：类型与消息以外的字段都已定下，`make(m)` 以消息文本 m 新建一个抛出值。
 * 同一形状的两次 `make` 只有消息文本不同；没有消息的非 `Error` 值两次得到同一个值。
 * `kind` 是构造时就知道的分类表列，不经过被测代码推断。
 */
interface ThrownShape {
  readonly kind: ThrownKind;
  readonly make: (message: string) => unknown;
  readonly [fc.toStringMethod]: () => string;
}

function defineShape(kind: ThrownKind, label: string, make: (message: string) => unknown): ThrownShape {
  return { kind, make, [fc.toStringMethod]: () => `${kind}：${label}` };
}

/**
 * 把 `Error` 的消息换成 m。以自有数据属性覆盖：`DOMException` 的 `message` 是原型上的只读访问器，
 * 直接赋值会抛错。
 */
function withMessage<E extends Error>(error: E, m: string): E {
  Object.defineProperty(error, "message", { value: m, writable: true, configurable: true });
  return error;
}

class CustomError extends Error {
  constructor(m: string) {
    super(m);
    this.name = "CustomError";
  }
}

class CustomTypeError extends TypeError {
  constructor(m: string) {
    super(m);
    this.name = "CustomTypeError";
  }
}

/**
 * 消息文本：任意字素串，另加英文异常、HTTP 状态、HTML 片段、带换行的栈信息，以及需求里的
 * 全部文案（消息恰为另一类别的文案时，类别也不随之改变）。
 */
const thrownMessage = fc.oneof(
  fc.string({ unit: "grapheme", maxLength: 30 }),
  fc.constantFrom(
    "",
    "Failed to fetch",
    "HTTP 500",
    "Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON",
    '<!DOCTYPE html><html><body><div id="root"></div></body></html>',
    "404 Not Found\n    at fetchToc (tocCache.ts:12:5)",
    ...Object.values(READER_TEXT),
    ...Object.values(SHELF_TEXT),
  ),
);

/** 包装错误的 `cause`：`fetch` 拒绝的各种原因，加上 `res.json()` 的 `SyntaxError`。 */
const wrappedCause: fc.Arbitrary<unknown> = fc.oneof(
  rejectionCause,
  message.map((m) => new SyntaxError(m)),
);

/** 404 以外的任意整数状态码：常见区间 [100, 599]，以及 0、负数、超出 599 的值。 */
const non404Status = fc.oneof(fc.integer({ min: 100, max: 599 }), fc.integer()).filter((st) => st !== 404);

const http404Shape = requestUrl.map((url) =>
  defineShape("http-404", `HttpStatusError(404, ${fc.stringify(url)})`, (m) =>
    withMessage(new HttpStatusError(404, url), m),
  ),
);

const httpOtherShape = fc
  .tuple(non404Status, requestUrl)
  .map(([st, url]) =>
    defineShape("http-other", `HttpStatusError(${st}, ${fc.stringify(url)})`, (m) =>
      withMessage(new HttpStatusError(st, url), m),
    ),
  );

const formatShape = fc
  .tuple(requestUrl, wrappedCause)
  .map(([url, cause]) =>
    defineShape("format", `ResponseFormatError(${fc.stringify(url)}, ${fc.stringify(cause)})`, (m) =>
      withMessage(new ResponseFormatError(url, cause), m),
    ),
  );

const networkShape = fc
  .tuple(requestUrl, wrappedCause)
  .map(([url, cause]) =>
    defineShape("network", `NetworkError(${fc.stringify(url)}, ${fc.stringify(cause)})`, (m) =>
      withMessage(new NetworkError(url, cause), m),
    ),
  );

/** 未包装的 `TypeError`：原生、子类，以及 `name` 被改成别的名字的 `TypeError`（按 `instanceof` 判定）。 */
const typeErrorShape = fc.constantFrom(
  defineShape("type-error", "TypeError", (m) => new TypeError(m)),
  defineShape("type-error", "CustomTypeError extends TypeError", (m) => new CustomTypeError(m)),
  defineShape("type-error", 'TypeError，name 改为 "NetworkError"', (m) =>
    Object.assign(new TypeError(m), { name: "NetworkError" }),
  ),
);

/**
 * 其余 `Error`：内置子类、`BookTextInvalidError`、自定义子类、`AbortError`，
 * 以及只在 `name` 或 `status` 上模仿 `TypeError` / 三个错误类、实际并非其实例的 `Error`。
 */
const otherErrorShape = fc.oneof(
  fc.constantFrom(
    defineShape("other", "Error", (m) => new Error(m)),
    defineShape("other", "SyntaxError", (m) => new SyntaxError(m)),
    defineShape("other", "RangeError", (m) => new RangeError(m)),
    defineShape("other", "ReferenceError", (m) => new ReferenceError(m)),
    defineShape("other", "EvalError", (m) => new EvalError(m)),
    defineShape("other", "URIError", (m) => new URIError(m)),
    defineShape("other", "CustomError extends Error", (m) => new CustomError(m)),
    defineShape("other", 'DOMException("AbortError")', (m) => new DOMException(m, "AbortError")),
    defineShape("other", "Error，带 status: 404", (m) => Object.assign(new Error(m), { status: 404 })),
  ),
  fc
    .tuple(fc.constantFrom<BookTextInvalidReason>("not-gzip", "corrupt-gzip", "char-count-mismatch"), message)
    .map(([reason, detail]) =>
      defineShape("other", `BookTextInvalidError(${reason}, ${fc.stringify(detail)})`, (m) =>
        withMessage(new BookTextInvalidError(reason, detail), m),
      ),
    ),
  fc
    .constantFrom("TypeError", "NetworkError", "HttpStatusError", "ResponseFormatError")
    .map((name) =>
      defineShape("other", `Error，name 为 "${name}"`, (m) => Object.assign(new Error(m), { name })),
    ),
);

/** 非 `Error` 值：字符串（即消息本身）、模仿错误的普通对象、`null` / `undefined` / 数字等，以及任意值。 */
const nonErrorShape = fc.oneof(
  fc.constantFrom(
    defineShape("other", "字符串", (m) => m),
    defineShape("other", "{ message }", (m) => ({ message: m })),
    defineShape("other", '{ name: "TypeError", message }', (m) => ({ name: "TypeError", message: m })),
    defineShape("other", '{ name: "HttpStatusError", status: 404, url, message }', (m) => ({
      name: "HttpStatusError",
      status: 404,
      url: "/data/books.json",
      message: m,
    })),
  ),
  fc
    .constantFrom<unknown>(null, undefined, 0, Number.NaN, 404, true, "")
    .map((v) => defineShape("other", fc.stringify(v), () => v)),
  fc.anything().map((v) => defineShape("other", fc.stringify(v), () => v)),
);

const thrownShape: fc.Arbitrary<ThrownShape> = fc.oneof(
  http404Shape,
  httpOtherShape,
  formatShape,
  networkShape,
  typeErrorShape,
  otherErrorShape,
  nonErrorShape,
);

// ---------------------------------------------------------------------------
// classifyLoadError 与文案
// ---------------------------------------------------------------------------

describe("classifyLoadError 与文案", () => {
  it("两张文案表恰为需求 13.1、13.7 的原文（书架表没有 damaged）", () => {
    expect(READER_LOAD_ERROR_TEXT).toEqual(READER_TEXT);
    expect(SHELF_LOAD_ERROR_TEXT).toEqual(SHELF_TEXT);
  });

  const tocUrl = "/books/x/_toc.json";
  const catalogUrl = "/data/books.json";

  it.each<[LoadStage, string, LoadErrorCategory, unknown]>([
    ["toc", "HttpStatusError 404", "not-found", new HttpStatusError(404, tocUrl)],
    ["toc", "ResponseFormatError（SPA 回退的 index.html）", "not-found", new ResponseFormatError(tocUrl, new SyntaxError("x"))],
    ["toc", "NetworkError", "unavailable", new NetworkError(tocUrl, new TypeError("Failed to fetch"))],
    ["text", "原生 TypeError（fetch 失败）", "unavailable", new TypeError("Failed to fetch")],
    ["text", "BookTextInvalidError", "damaged", new BookTextInvalidError("not-gzip", "")],
    ["catalog", "HttpStatusError 500", "unavailable", new HttpStatusError(500, catalogUrl)],
    ["catalog", "处理书目时的 TypeError", "unknown", new TypeError("Cannot read properties of undefined")],
  ])("%s 阶段，%s → %s", (stage, _label, want, error) => {
    expect(classifyLoadError(stage, error)).toBe(want);
  });

  // Feature: reader-defect-fixes, Property 7: 错误类别只由阶段与错误类型决定，文案只由类别决定
  // **Validates: Requirements 13.1, 13.2, 13.7, 13.8**
  it("对任意阶段与抛出值：类别等于分类表、与消息文本无关；说明恰为该类别的固定文案", () => {
    fc.assert(
      fc.property(thrownShape, thrownMessage, thrownMessage, (shape, m1, m2) => {
        const a = shape.make(m1);
        const b = shape.make(m2);
        for (const stage of STAGES) {
          const category = classifyLoadError(stage, a);
          expect(category, stage).toBe(EXPECTED_CATEGORY[stage][shape.kind]);
          // 值域：text 阶段没有 not-found，toc 与 catalog 阶段没有 damaged
          if (stage === "text") expect(category, stage).not.toBe("not-found");
          else expect(category, stage).not.toBe("damaged");

          // 只有消息文本不同的两个值：类别相同
          expect(classifyLoadError(stage, b), stage).toBe(category);

          // 说明只由类别决定，恰为需求原文，因此不会带出所抛值的消息
          const text = displayedText(stage, a);
          expect(text, stage).toBe(expectedText(stage, shape.kind));
          expect(displayedText(stage, b), stage).toBe(text);
        }
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// formatLoadErrorLog
// ---------------------------------------------------------------------------

describe("formatLoadErrorLog", () => {
  it("HttpStatusError：记下书 id 与状态码", () => {
    expect(formatLoadErrorLog("toc", "abc", new HttpStatusError(404, "/books/abc/_toc.json"))).toBe(
      "[load-error] stage=toc id=abc status=404 name=HttpStatusError message=HTTP 404（/books/abc/_toc.json）",
    );
  });

  it("NetworkError 且书 id 为 null：id 与 status 记为 -，消息含原因", () => {
    const e = new NetworkError("/data/books.json", new TypeError("Failed to fetch"));
    expect(formatLoadErrorLog("catalog", null, e)).toBe(
      "[load-error] stage=catalog id=- status=- name=NetworkError message=网络请求失败（/data/books.json）：Failed to fetch",
    );
  });

  it("BookTextInvalidError：取它自己的 name 与 message", () => {
    const e = new BookTextInvalidError("char-count-mismatch", "码点数 12，目录记录 13");
    expect(formatLoadErrorLog("text", "abc", e)).toBe(
      "[load-error] stage=text id=abc status=- name=BookTextInvalidError message=书籍正文与目录不符（码点数 12，目录记录 13）",
    );
  });

  it("书 id 为空串记为 -；name 为空串的 Error 记为 Error", () => {
    const e = Object.assign(new Error("boom"), { name: "" });
    expect(formatLoadErrorLog("text", "", e)).toBe("[load-error] stage=text id=- status=- name=Error message=boom");
  });

  it("消息中的换行连同两侧空白折成一个空格，整条日志是一行", () => {
    const e = new SyntaxError("Unexpected token '<'\n    at JSON.parse\r\n\r\nat fetchJson");
    const line = formatLoadErrorLog("toc", "abc", e);
    expect(line).toBe(
      "[load-error] stage=toc id=abc status=- name=SyntaxError message=Unexpected token '<' at JSON.parse at fetchJson",
    );
    expect(line).not.toMatch(/[\r\n]/);
  });

  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const unprintable = {
    toJSON(): never {
      throw new Error("toJSON");
    },
    toString(): never {
      throw new Error("toString");
    },
  };

  it.each<[string, unknown, string]>([
    ["字符串", "offline", "name=string message=offline"],
    ["undefined", undefined, "name=undefined message=undefined"],
    ["null", null, "name=null message=null"],
    ["数字", 42, "name=number message=42"],
    ["带 status 的普通对象", { status: 404, message: "Not Found" }, 'name=object message={"status":404,"message":"Not Found"}'],
    ["循环引用的对象", circular, "name=object message=[object Object]"],
    ["无法转成文本的对象", unprintable, "name=object message=<unprintable>"],
  ])("非 Error 值（%s）：status 记为 -，name 为类型名", (_label, value, tail) => {
    expect(formatLoadErrorLog("catalog", null, value)).toBe(`[load-error] stage=catalog id=- status=- ${tail}`);
  });
});
