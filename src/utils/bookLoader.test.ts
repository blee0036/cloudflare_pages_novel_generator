import { gzipSync } from "node:zlib";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { BookTextInvalidError, type BookTextInvalidReason } from "./bookTextCheck";
import { createBookLoader, type BookLoaderDeps } from "./decompress";
import type { BookLoadMetrics } from "./loadMetrics";
import { INDETERMINATE, type LoadProgress } from "./loadProgress";

/**
 * 书籍加载流程的单测（e2e-visual-testing 需求 19.6 (a)–(i)、19.2、19.9）。
 *
 * 不启动浏览器、不 mock 解压：Node 自带 `Response` 与 `DecompressionStream`，gz 由
 * `zlib.gzipSync` 真压出来，所以字节层（魔数、截断）与内容层（码点数）的检查都是真跑的。
 * 替身只有 `createBookLoader` 注入的外部依赖：
 *
 * - IndexedDB → 内存里的 `Map<bookId, gz>`（`store`），读、删、写都记进 `events`；
 * - `fetch` → 按调用顺序交出预先造好的 `Response`（Opaque / Transparent / SPA 回退三种形态）；
 * - `report` → 收集 `[book-load]` 指标（`reports`），它就是日志行的唯一来源；
 * - `expectedCharCount` → 直接给出 `_toc.json` 的 `charCount` 原值。
 *
 * 每个用例新建自己的 loader（各自一份内存缓存），用例之间不共享状态。"新会话"用共享
 * `store` 的另一个 loader 表示：内存缓存清空，IndexedDB 还在。
 *
 * 文件结构：顶部是夹具与 `harness`，其后按 19.6 的情形分组。任务 2.5 的属性测试追加在
 * 文件末尾，复用同一套夹具。
 */

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const BOOK_ID = "测试之书";
const BOOK_URL = `/books/${BOOK_ID}.txt.gz`;

/** 只含基本平面字符的正文：码点数与 UTF-16 码元数相等。 */
const TEXT = "第一章 开端\n　　他抬头看了看天。\n\n第二章 离乡\n　　路很长。\n".repeat(20);

/** 含增补平面字符（emoji、CJK 扩展 B、音乐符号）的正文：码点数 < 码元数（19.6 (d)）。 */
const SUPPLEMENTARY_TEXT = "第一章 😀\n　　𠀀与𝄞同行。\n".repeat(10);

/** 产物更新前的旧正文：合法 gz，但码点数与现在的 `charCount` 对不上（19.9）。 */
const OLD_TEXT = "第一章 开端（旧版）\n　　旧的正文。\n".repeat(20);

/** 文件缺失时 SPA 回退返回的 `index.html`（F-001 的来源）。 */
const SPA_HTML =
  '<!doctype html>\n<html lang="zh-CN">\n  <head>\n    <meta charset="UTF-8" />\n' +
  "    <title>小说书架</title>\n  </head>\n  <body>\n    <div id=\"root\"></div>\n" +
  '    <script type="module" src="/assets/index.js"></script>\n  </body>\n</html>\n';

/** 码点数的独立口径（与 Python `len()` 相同），不依赖被测模块的 `countCodePoints`。 */
function codePoints(s: string): number {
  return Array.from(s).length;
}

/** 拷成一个独占的 `ArrayBuffer`：`Buffer` 常是池子上的一段视图，直接取 `.buffer` 会带出无关字节。 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out.buffer;
}

function utf8(text: string): ArrayBuffer {
  return toArrayBuffer(new TextEncoder().encode(text));
}

/** 与预处理管线同一容器格式的 gz。 */
function gzipText(text: string): ArrayBuffer {
  return toArrayBuffer(gzipSync(Buffer.from(text, "utf8")));
}

/** 去掉 gzip 尾部的 8 字节（CRC32 + ISIZE）：魔数还在，但无法完整解压（19.6 (b)）。 */
function truncatedGzip(text: string): ArrayBuffer {
  const gz = gzipText(text);
  return gz.slice(0, gz.byteLength - 8);
}

/** Opaque_Mode：原样返回文件字节，带 `content-length`，不带 `Content-Encoding`。 */
function opaqueResponse(body: ArrayBuffer): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-length": String(body.byteLength) },
  });
}

/** SPA 回退：状态 200、不带 `Content-Encoding` 的 `index.html`。 */
function spaFallbackResponse(): Response {
  const body = utf8(SPA_HTML);
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-length": String(body.byteLength),
    },
  });
}

/**
 * Transparent_Mode：带 `Content-Encoding: gzip`，响应体是 HTTP 层解码后的明文。
 * 手工构造的 `Response` 不会再解压，`text()` 拿到的就是 `text`，与浏览器透明解压后的形态相同。
 */
function transparentResponse(text: string): Response {
  return new Response(text, {
    status: 200,
    headers: { "content-encoding": "gzip", "content-type": "text/plain; charset=utf-8" },
  });
}

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

/** 依赖被调用的记录，按发生顺序。`events` 断言"只走一轮网络、之后不再回读 IndexedDB"。 */
type DepEvent = "readCached" | "deleteCached" | "touchCached" | "putCached" | "fetch";

interface Setup {
  /** `_toc.json` 里的 `charCount` 原值，原样交给 loader（可以是不可用的值，19.10）。 */
  charCount: unknown;
  /** `expectedCharCount` 本身 reject（取 `_toc.json` 失败）。 */
  charCountRejects?: boolean;
  /** 每次 `fetch` 依次取一个；次数超出时重复最后一个。缺省时 `fetch` 抛错。 */
  responses?: Array<() => Response>;
  /** 开始前 IndexedDB 中该书的记录（原始 gz）。 */
  cached?: ArrayBuffer;
  /** 与另一个 harness 共用 IndexedDB，表示"同一浏览器的新会话"。 */
  store?: Map<string, ArrayBuffer>;
  /** `deleteCached` 失败的方式：返回 rejected Promise，或同步抛错。 */
  deleteFails?: "reject" | "throw";
}

interface Harness {
  /** 以固定的 url 与 bookId 加载一次；进度上报收进 `progress`。 */
  load(): Promise<string>;
  /** 假 IndexedDB：bookId → 原始 gz。 */
  store: Map<string, ArrayBuffer>;
  /** `[book-load]` 的全部上报，每条对应一行日志。 */
  reports: BookLoadMetrics[];
  events: DepEvent[];
  progress: LoadProgress[];
  count(event: DepEvent): number;
}

function harness(setup: Setup): Harness {
  const store = setup.store ?? new Map<string, ArrayBuffer>();
  if (setup.cached) store.set(BOOK_ID, setup.cached);

  const reports: BookLoadMetrics[] = [];
  const events: DepEvent[] = [];
  const progress: LoadProgress[] = [];
  const responses = setup.responses ?? [];
  let fetches = 0;
  let clock = 0;

  const deps: BookLoaderDeps = {
    fetch: async () => {
      events.push("fetch");
      const make = responses[Math.min(fetches++, responses.length - 1)];
      if (!make) throw new Error("本用例不应发出网络请求");
      return make();
    },
    now: () => (clock += 1),
    report: (m) => {
      reports.push(m);
    },
    readCached: async (bookId) => {
      events.push("readCached");
      const gz = store.get(bookId);
      // 返回拷贝：真实 IndexedDB 读出的是结构化克隆，loader 不可能改到库里那份。
      return gz ? { gz: gz.slice(0), bytes: gz.byteLength } : null;
    },
    deleteCached: (bookId) => {
      events.push("deleteCached");
      if (setup.deleteFails === "throw") throw new Error("模拟 IndexedDB 删除失败（同步）");
      if (setup.deleteFails === "reject") {
        return Promise.reject(new Error("模拟 IndexedDB 删除失败"));
      }
      store.delete(bookId);
      return Promise.resolve();
    },
    touchCached: async () => {
      events.push("touchCached");
    },
    putCached: async (bookId, gz) => {
      events.push("putCached");
      store.set(bookId, gz.slice(0));
    },
    expectedCharCount: async () => {
      if (setup.charCountRejects) throw new Error("模拟 _toc.json 取值失败");
      return setup.charCount;
    },
  };

  const loader = createBookLoader(deps);

  return {
    load: () => loader(BOOK_URL, BOOK_ID, (p) => progress.push(p)),
    store,
    reports,
    events,
    progress,
    count: (event) => events.filter((e) => e === event).length,
  };
}

/**
 * 等 fire-and-forget 的缓存副作用（`putCached`、`touchCached`）落定再断言 IndexedDB。
 * 一个宏任务足够：这些副作用只经过若干微任务。
 */
function flushSideEffects(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** 断言以 `BookTextInvalidError` 结束且原因相符；返回全文即判失败。 */
async function expectInvalid(
  pending: Promise<string>,
  reason: BookTextInvalidReason
): Promise<void> {
  const error = await pending.then(
    () => {
      throw new Error(`应以 ${reason} 结束，却返回了全文`);
    },
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(BookTextInvalidError);
  expect((error as BookTextInvalidError).reason).toBe(reason);
}

/** IndexedDB 中该书记录的字节；没有记录时为 `null`。 */
function recordOf(h: Harness): Uint8Array | null {
  const gz = h.store.get(BOOK_ID);
  return gz ? new Uint8Array(gz) : null;
}

function sources(h: Harness): string[] {
  return h.reports.map((r) => r.source);
}

/** 进度上报的 kind 序列，相邻相同的合并为一个（分片数随运行时而变，不作断言对象）。 */
function progressKinds(h: Harness): string[] {
  const kinds: string[] = [];
  for (const p of h.progress) {
    if (kinds[kinds.length - 1] !== p.kind) kinds.push(p.kind);
  }
  return kinds;
}

// ---------------------------------------------------------------------------
// 19.6 (a)–(e)：网络分支得到的内容无效
// ---------------------------------------------------------------------------

describe("网络分支拒绝无效内容（19.1、19.3、19.2）", () => {
  it("(a) 状态 200 的 HTML 冒充 gz：not-gzip，无记录、无日志", async () => {
    const h = harness({ charCount: codePoints(TEXT), responses: [spaFallbackResponse] });

    await expectInvalid(h.load(), "not-gzip");
    await flushSideEffects();

    expect(recordOf(h)).toBeNull();
    expect(h.count("putCached")).toBe(0);
    expect(h.reports).toEqual([]);
  });

  it("(b) 截断的 gz（去掉 8 字节尾部）：corrupt-gzip，无记录、无日志", async () => {
    const h = harness({
      charCount: codePoints(TEXT),
      responses: [() => opaqueResponse(truncatedGzip(TEXT))],
    });

    await expectInvalid(h.load(), "corrupt-gzip");
    await flushSideEffects();

    expect(recordOf(h)).toBeNull();
    expect(h.count("putCached")).toBe(0);
    expect(h.reports).toEqual([]);
  });

  it("(c) 合法 gz，但 charCount 比码点数少 1：char-count-mismatch，无记录、无日志", async () => {
    const h = harness({
      charCount: codePoints(TEXT) - 1,
      responses: [() => opaqueResponse(gzipText(TEXT))],
    });

    await expectInvalid(h.load(), "char-count-mismatch");
    await flushSideEffects();

    expect(recordOf(h)).toBeNull();
    expect(h.count("putCached")).toBe(0);
    expect(h.reports).toEqual([]);
  });

  it("(e) Transparent 响应头、解码后为 HTML 且码点数不符：char-count-mismatch，不写缓存、无日志", async () => {
    expect(codePoints(SPA_HTML)).not.toBe(codePoints(TEXT));
    const h = harness({
      charCount: codePoints(TEXT),
      responses: [() => transparentResponse(SPA_HTML)],
    });

    await expectInvalid(h.load(), "char-count-mismatch");
    await flushSideEffects();

    expect(recordOf(h)).toBeNull();
    expect(h.count("putCached")).toBe(0);
    expect(h.reports).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 19.6 (d)：码点口径
// ---------------------------------------------------------------------------

describe("码点数而非 UTF-16 码元数（19.3、19.4）", () => {
  it("(d) 含增补平面字符、码点数与 charCount 相符：返回全文，chars 仍是码元数", async () => {
    // 夹具自检：两种口径确实不同，否则这条测试分辨不出用的是哪一种。
    expect(SUPPLEMENTARY_TEXT.length).not.toBe(codePoints(SUPPLEMENTARY_TEXT));

    const gz = gzipText(SUPPLEMENTARY_TEXT);
    const h = harness({
      charCount: codePoints(SUPPLEMENTARY_TEXT),
      responses: [() => opaqueResponse(gz)],
    });

    await expect(h.load()).resolves.toBe(SUPPLEMENTARY_TEXT);
    await flushSideEffects();

    expect(sources(h)).toEqual(["network"]);
    expect(h.reports[0].chars).toBe(SUPPLEMENTARY_TEXT.length);
    expect(recordOf(h)).toEqual(new Uint8Array(gz));

    // 新会话从 IndexedDB 读回同一份 gz：该分支同样按码点检查，照常命中、不发请求。
    const next = harness({ charCount: codePoints(SUPPLEMENTARY_TEXT), store: h.store });

    await expect(next.load()).resolves.toBe(SUPPLEMENTARY_TEXT);
    await flushSideEffects();

    expect(sources(next)).toEqual(["indexeddb"]);
    expect(next.reports[0].chars).toBe(SUPPLEMENTARY_TEXT.length);
    expect(next.events).toEqual(["readCached", "touchCached"]);
    expect(next.progress).toEqual([INDETERMINATE]);
    expect(recordOf(next)).toEqual(new Uint8Array(gz));
  });
});

// ---------------------------------------------------------------------------
// 19.6 (f)(g)：IndexedDB 坏记录（19.9）
// ---------------------------------------------------------------------------

/** 两类坏记录：gz 本身解不开；gz 合法但全文码点数与现在的 charCount 不符。 */
const BAD_RECORDS: Array<[string, () => ArrayBuffer]> = [
  ["gz 无法完整解压", () => truncatedGzip(TEXT)],
  ["全文码点数不符（产物更新前的旧记录）", () => gzipText(OLD_TEXT)],
];

describe("IndexedDB 坏记录：删除后只走一轮网络（19.9）", () => {
  it.each(BAD_RECORDS)("(f) 记录%s、网络结果通过：删除后重取，source=network 并写入新记录", async (_label, bad) => {
    const gz = gzipText(TEXT);
    const h = harness({
      charCount: codePoints(TEXT),
      cached: bad(),
      responses: [() => opaqueResponse(gz)],
    });

    await expect(h.load()).resolves.toBe(TEXT);
    await flushSideEffects();

    // 读一次 → 删 → 一轮网络 → 写新记录；网络之后没有第二次 readCached，也没有第二次 fetch。
    expect(h.events).toEqual(["readCached", "deleteCached", "fetch", "putCached"]);
    // 坏记录不打 source=indexeddb。
    expect(sources(h)).toEqual(["network"]);
    expect(recordOf(h)).toEqual(new Uint8Array(gz));
  });

  it.each(BAD_RECORDS)("(g) 记录%s、网络结果也不通过：以错误结束，IndexedDB 不留该书记录", async (_label, bad) => {
    const h = harness({
      charCount: codePoints(TEXT),
      cached: bad(),
      responses: [spaFallbackResponse],
    });

    await expectInvalid(h.load(), "not-gzip");
    await flushSideEffects();

    expect(h.events).toEqual(["readCached", "deleteCached", "fetch"]);
    expect(h.reports).toEqual([]);
    expect(recordOf(h)).toBeNull();
  });

  it("deleteCached 失败（reject 与同步抛错）不阻止重取", async () => {
    for (const deleteFails of ["reject", "throw"] as const) {
      const gz = gzipText(TEXT);
      const h = harness({
        charCount: codePoints(TEXT),
        cached: gzipText(OLD_TEXT),
        responses: [() => opaqueResponse(gz)],
        deleteFails,
      });

      await expect(h.load()).resolves.toBe(TEXT);
      await flushSideEffects();

      expect(h.events).toEqual(["readCached", "deleteCached", "fetch", "putCached"]);
      expect(sources(h)).toEqual(["network"]);
      // 删不掉的旧记录被网络结果按原有规则覆盖。
      expect(recordOf(h)).toEqual(new Uint8Array(gz));
    }
  });
});

// ---------------------------------------------------------------------------
// 19.6 (h)：charCount 不可用（19.10）
// ---------------------------------------------------------------------------

/** 各种不可用的 charCount；`reject` 表示取 `_toc.json` 本身失败。 */
const UNAVAILABLE_CHAR_COUNTS: Array<[string, Pick<Setup, "charCount" | "charCountRejects">]> = [
  ["缺失", { charCount: undefined }],
  ["null", { charCount: null }],
  ['字符串 "12"', { charCount: "12" }],
  ["负数 -1", { charCount: -1 }],
  ["小数 1.5", { charCount: 1.5 }],
  ["取值失败", { charCount: undefined, charCountRejects: true }],
];

describe("charCount 不可用时跳过码点检查（19.10）", () => {
  it.each(UNAVAILABLE_CHAR_COUNTS)("(h) charCount %s：合法 gz 照常加载", async (_label, toc) => {
    const gz = gzipText(TEXT);
    const h = harness({ ...toc, responses: [() => opaqueResponse(gz)] });

    await expect(h.load()).resolves.toBe(TEXT);
    await flushSideEffects();

    expect(sources(h)).toEqual(["network"]);
    expect(recordOf(h)).toEqual(new Uint8Array(gz));
  });

  it.each(UNAVAILABLE_CHAR_COUNTS)("(h) charCount %s：HTML 冒充 gz 仍以错误结束", async (_label, toc) => {
    const h = harness({ ...toc, responses: [spaFallbackResponse] });

    await expectInvalid(h.load(), "not-gzip");
    await flushSideEffects();

    expect(h.reports).toEqual([]);
    expect(recordOf(h)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 19.6 (i)：合法 gz 的可观测行为与修复前相同（19.4）
// ---------------------------------------------------------------------------

describe("合法内容的可观测行为不变（19.4）", () => {
  it("(i) Opaque：source=network，进度确定态到 100% 后退回不确定态，写入原始 gz", async () => {
    const gz = gzipText(TEXT);
    const h = harness({ charCount: codePoints(TEXT), responses: [() => opaqueResponse(gz)] });

    await expect(h.load()).resolves.toBe(TEXT);
    await flushSideEffects();

    expect(sources(h)).toEqual(["network"]);
    expect(h.reports[0]).toMatchObject({ gzBytes: gz.byteLength, chars: TEXT.length });

    expect(progressKinds(h)).toEqual(["determinate", "indeterminate"]);
    const determinate = h.progress.filter((p) => p.kind === "determinate");
    expect(determinate[determinate.length - 1]).toEqual({ kind: "determinate", pct: 100 });

    expect(h.count("putCached")).toBe(1);
    expect(recordOf(h)).toEqual(new Uint8Array(gz));
  });

  it("(i) Transparent：source=network-transparent，只报不确定态，不写 IndexedDB", async () => {
    const h = harness({
      charCount: codePoints(TEXT),
      responses: [() => transparentResponse(TEXT)],
    });

    await expect(h.load()).resolves.toBe(TEXT);
    await flushSideEffects();

    expect(sources(h)).toEqual(["network-transparent"]);
    expect(h.reports[0].chars).toBe(TEXT.length);
    expect(h.progress).toEqual([INDETERMINATE]);
    expect(h.count("putCached")).toBe(0);
    expect(recordOf(h)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 附加：失败不留痕（19.2）
// ---------------------------------------------------------------------------

describe("失败的加载不进内存缓存（19.2）", () => {
  it("失败后再次调用不命中 memory，而是重新经 IndexedDB 与网络加载", async () => {
    const gz = gzipText(TEXT);
    const h = harness({
      charCount: codePoints(TEXT),
      responses: [spaFallbackResponse, () => opaqueResponse(gz)],
    });

    await expectInvalid(h.load(), "not-gzip");
    await expect(h.load()).resolves.toBe(TEXT);
    await flushSideEffects();

    expect(h.events).toEqual(["readCached", "fetch", "readCached", "fetch", "putCached"]);
    expect(sources(h)).toEqual(["network"]);
    expect(recordOf(h)).toEqual(new Uint8Array(gz));

    // 成功之后才有内存缓存：第三次打开是 memory，不再碰 IndexedDB 与网络。
    await expect(h.load()).resolves.toBe(TEXT);
    expect(sources(h)).toEqual(["network", "memory"]);
    expect(h.count("readCached")).toBe(2);
    expect(h.count("fetch")).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 任务 2.5：属性测试（design Property 3）
// ---------------------------------------------------------------------------

/**
 * 正文 t：任意良构的全 Unicode 串（`unit: "binary"` 即 `fullUnicodeString`，不含代理项码点，
 * 大部分字符落在增补平面，码点数与码元数通常不等）。
 *
 * 不以 U+FEFF 开头（风险 R3）：`Response.text()` 会剥掉开头的 1 个 BOM，这类串经两种网络
 * 分支、IndexedDB 分支都回不到原样，不是本属性要检查的东西。
 */
const bookText = fc.string({ unit: "binary" }).filter((t) => !t.startsWith("\ufeff"));

/**
 * `charCount` 的取法，写成数据而不是直接生成值：取值依赖 t，而数据形式的反例读得懂、也好收缩。
 *
 * 前四种是有效值（非负安全整数），后三种不可用（19.10）。有效值里 `utf16` 专门对准"拿
 * `text.length` 当码点数"的错误口径；无效值里 `string` 与 `fraction` 围绕正确计数取值，
 * 对准"先把字符串转成数字、把小数取整再比"的错误宽容。
 */
type CharCountSpec =
  | { kind: "exact" }
  | { kind: "utf16" }
  | { kind: "offset"; delta: number }
  | { kind: "nat"; value: number }
  | { kind: "invalid"; value: undefined | null | number }
  | { kind: "string"; delta: number }
  | { kind: "fraction"; delta: number };

const USABLE_KINDS: ReadonlySet<CharCountSpec["kind"]> = new Set(["exact", "utf16", "offset", "nat"]);

const smallDelta = fc.integer({ min: -3, max: 3 });

const charCountSpec: fc.Arbitrary<CharCountSpec> = fc.oneof(
  fc.constant({ kind: "exact" } as const),
  fc.constant({ kind: "utf16" } as const),
  fc.record({ kind: fc.constant("offset" as const), delta: smallDelta }),
  fc.record({ kind: fc.constant("nat" as const), value: fc.nat() }),
  fc.record({
    kind: fc.constant("invalid" as const),
    value: fc.oneof(
      fc.constantFrom(undefined, null, NaN, Infinity, -Infinity, 2 ** 53),
      fc.integer({ min: Number.MIN_SAFE_INTEGER, max: -1 })
    ),
  }),
  fc.record({ kind: fc.constant("string" as const), delta: smallDelta }),
  fc.record({ kind: fc.constant("fraction" as const), delta: smallDelta })
);

/** 按取法算出交给 loader 的 `charCount` 原值。偏移后为负的有效取法钳到 0，仍是有效值。 */
function charCountFor(spec: CharCountSpec, t: string): unknown {
  const exact = codePoints(t);
  switch (spec.kind) {
    case "exact":
      return exact;
    case "utf16":
      return t.length;
    case "offset":
      return Math.max(0, exact + spec.delta);
    case "nat":
      return spec.value;
    case "invalid":
      return spec.value;
    case "string":
      return String(exact + spec.delta);
    case "fraction":
      return Math.max(0, exact + spec.delta) + 0.5;
  }
}

/** 三个会做码点检查的分支；`indexeddb` 表示开始前库里已有该书的 gz。 */
type Branch = "opaque" | "transparent" | "indexeddb";

const EXPECTED_SOURCE: Record<Branch, string> = {
  opaque: "network",
  transparent: "network-transparent",
  indexeddb: "indexeddb",
};

describe("属性：加载器不返回码点数与有效 charCount 不符的全文", () => {
  // Feature: e2e-visual-testing, Property 3: 加载器不返回码点数与有效 `charCount` 不符的全文
  // **Validates: Requirements 19.1, 19.2, 19.3, 19.10**
  it("c 有效时当且仅当码点数相等才返回 t，否则 char-count-mismatch 且不写缓存、不上报；c 无效时一律返回 t", async () => {
    await fc.assert(
      fc.asyncProperty(
        bookText,
        charCountSpec,
        fc.constantFrom<Branch>("opaque", "transparent", "indexeddb"),
        async (t, spec, branch) => {
          const charCount = charCountFor(spec, t);
          const accepts = !USABLE_KINDS.has(spec.kind) || charCount === codePoints(t);

          const gz = gzipText(t);
          const h = harness({
            charCount,
            // IndexedDB 分支：记录与服务器上的文件是同一份 gz。记录未通过检查时 loader 删掉它、
            // 重取一轮，拿回的仍是这份内容，于是同样不通过。
            cached: branch === "indexeddb" ? gz.slice(0) : undefined,
            responses: [
              branch === "transparent" ? () => transparentResponse(t) : () => opaqueResponse(gz),
            ],
          });

          if (accepts) {
            await expect(h.load()).resolves.toBe(t);
            await flushSideEffects();
            // 确认真的走了抽中的分支，否则这一例检查的不是它。
            expect(sources(h)).toEqual([EXPECTED_SOURCE[branch]]);
          } else {
            await expectInvalid(h.load(), "char-count-mismatch");
            await flushSideEffects();
            expect(h.count("putCached")).toBe(0);
            expect(h.reports).toEqual([]);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
