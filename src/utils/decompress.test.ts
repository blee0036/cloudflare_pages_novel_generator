import { describe, expect, it } from "vitest";
import { concatChunks, decompressGzip } from "./decompress";

/**
 * 只测 `decompress.ts` 里不碰 DOM 的那两块（design §11）：分片拼接与 gz→文本。
 *
 * 这两个都是真跑的——Node 自带 `CompressionStream`/`DecompressionStream`，所以夹具里的 gz
 * 是真压出来的、解压也是真走原生流，没有任何 mock。缓存命中、LRU 推进那些需要 IndexedDB
 * 的分支不在单测范围内（Node 里没有 `indexedDB`），靠浏览器人工核对。
 */

/** 用原生 CompressionStream 压出一份真 gz，与预处理 `gzip -9` 的容器格式相同。 */
async function gzip(text: string): Promise<ArrayBuffer> {
  const bytes = new TextEncoder().encode(text);
  // 分片类型同 `decompressGzip`：对上 `CompressionStream.writable` 的 `BufferSource`
  const source = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

  return await new Response(
    source.pipeThrough(new CompressionStream("gzip")),
  ).arrayBuffer();
}

describe("concatChunks", () => {
  it("按到达顺序拼接，一个字节不错位", () => {
    const out = new Uint8Array(
      concatChunks([new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4, 5])]),
    );

    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5]);
  });

  it("产物独占整个 ArrayBuffer：长度恰为数据长度", () => {
    // 分片是大池子上的一段视图（fetch 给出的就是这种形状），拼接必须只取视图范围内的字节
    const pool = new Uint8Array([9, 9, 1, 2, 3, 9, 9]);
    const view = pool.subarray(2, 5);

    const buffer = concatChunks([view]);

    expect(buffer.byteLength).toBe(3);
    expect(Array.from(new Uint8Array(buffer))).toEqual([1, 2, 3]);
  });

  it("空输入给出 0 字节 buffer，而不是抛错", () => {
    expect(concatChunks([]).byteLength).toBe(0);
  });

  it("不与输入共享内存：改动分片不影响已拼好的结果", () => {
    const chunk = new Uint8Array([1, 2, 3]);
    const buffer = concatChunks([chunk]);

    chunk[0] = 99;

    expect(new Uint8Array(buffer)[0]).toBe(1);
  });
});

describe("decompressGzip", () => {
  it("中文正文 round-trip 逐字符相同", async () => {
    const text = "第一章 开端\n　　他抬头看了看天。\n\n第二章 离乡\n　　路很长。\n";

    await expect(decompressGzip(await gzip(text))).resolves.toBe(text);
  });

  it("跨多个内部分片的长文本不丢尾巴也不串段", async () => {
    // 1MB 量级足以让解压流分多次输出，正好验证 Response.text() 的拼接
    const text = "章节内容测试 ".repeat(100000);
    const gz = await gzip(text);

    // 顺带确认夹具本身是压缩过的，否则这条测试等于在测明文搬运
    expect(gz.byteLength).toBeLessThan(new TextEncoder().encode(text).byteLength);
    await expect(decompressGzip(gz)).resolves.toBe(text);
  });

  it("空文本也能 round-trip", async () => {
    await expect(decompressGzip(await gzip(""))).resolves.toBe("");
  });

  it("不是 gzip 的数据要 reject——这是缓存分支回退到网络的依据", async () => {
    const notGz = new TextEncoder().encode("这是明文，没有 1f 8b 魔数").buffer;

    await expect(decompressGzip(notGz as ArrayBuffer)).rejects.toThrow();
  });

  it("截断的 gz 要 reject，不能返回半截文本", async () => {
    const full = await gzip("完整的一段正文，用来验证截断后的行为。".repeat(100));
    const truncated = full.slice(0, Math.floor(full.byteLength / 2));

    await expect(decompressGzip(truncated)).rejects.toThrow();
  });
});
