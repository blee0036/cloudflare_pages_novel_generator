import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpStatusError, NetworkError, ResponseFormatError } from "./loadError";
import { tocUrl } from "./locator";
import { loadToc } from "./tocCache";

/**
 * `src/utils/tocCache.ts`（reader-defect-fixes 任务 14.4）。
 *
 * `fetchToc` 改走 `fetchJson` 之后：成功结果按 bookId 缓存 Promise、失败即逐出，这两条不变；
 * 失败的 rejection 是 `fetchJson` 的三个错误类，阅读器据此分类（需求 13.1）。
 *
 * 全局 `fetch` 换成按 URL 应答的假实现，响应由 Node 的全局 `Response` 构造，`res.ok`、
 * `res.json()` 走真实实现。缓存是模块级的，每个用例用各自的 bookId，互不串扰。
 */

type Reply = () => Response | Promise<Response>;

/** 依次应答的假 `fetch`：第 n 次调用取 `replies[n]`，并记下请求的 URL。 */
function stubFetch(...replies: Reply[]): string[] {
  const urls: string[] = [];
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    urls.push(String(input));
    const reply = replies[urls.length - 1];
    if (!reply) throw new Error(`未预期的第 ${urls.length} 次请求：${String(input)}`);
    return Promise.resolve().then(reply);
  });
  return urls;
}

const json = (value: unknown): Reply => () => new Response(JSON.stringify(value), { status: 200 });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadToc", () => {
  it("同一本书的并发与后续调用共用一个请求", async () => {
    const toc = { title: "甲", charCount: 3, chapters: [] };
    const urls = stubFetch(json(toc));

    const first = loadToc("cache-hit");
    const second = loadToc("cache-hit");
    expect(second).toBe(first);
    await expect(first).resolves.toEqual(toc);
    await expect(loadToc("cache-hit")).resolves.toEqual(toc);

    expect(urls).toEqual([tocUrl("cache-hit")]);
  });

  it("404 以 HttpStatusError 拒绝，并逐出缓存使下一次调用重新请求", async () => {
    const toc = { title: "乙", charCount: 1, chapters: [] };
    const urls = stubFetch(() => new Response("Not Found", { status: 404 }), json(toc));

    const failed = loadToc("evict-404");
    await expect(failed).rejects.toBeInstanceOf(HttpStatusError);
    await expect(failed).rejects.toMatchObject({ status: 404 });

    await expect(loadToc("evict-404")).resolves.toEqual(toc);
    expect(urls).toEqual([tocUrl("evict-404"), tocUrl("evict-404")]);
  });

  it("2xx 但响应体是 SPA 回退的 HTML 时以 ResponseFormatError 拒绝", async () => {
    stubFetch(
      () => new Response("<!DOCTYPE html><html><body></body></html>", { status: 200 })
    );
    await expect(loadToc("spa-fallback")).rejects.toBeInstanceOf(ResponseFormatError);
  });

  it("fetch 拒绝时以 NetworkError 拒绝，cause 为原始错误，并逐出缓存", async () => {
    const cause = new TypeError("Failed to fetch");
    const toc = { title: "丙", charCount: 2, chapters: [] };
    const urls = stubFetch(() => Promise.reject(cause), json(toc));

    const failed = loadToc("network");
    await expect(failed).rejects.toBeInstanceOf(NetworkError);
    await expect(failed).rejects.toMatchObject({ cause });

    await expect(loadToc("network")).resolves.toEqual(toc);
    expect(urls).toHaveLength(2);
  });
});
