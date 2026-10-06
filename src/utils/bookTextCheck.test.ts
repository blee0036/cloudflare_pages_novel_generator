import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  BookTextInvalidError,
  countCodePoints,
  hasGzipMagic,
  normalizeCharCount,
} from "./bookTextCheck";

/**
 * 字符串由若干"片段"拼成，每个片段偏向代理项区域取值。均匀取 0–0xFFFF 的码元时代理项
 * 只占约 3%，高代理后紧跟低代理的组合更少；按片段拼接才能稳定覆盖孤立高代理、孤立低代理、
 * 反序的低高、末尾悬空的高代理、高高低这类边界。
 */
const codeUnit = (min: number, max: number) =>
  fc.integer({ min, max }).map((u) => String.fromCharCode(u));

const segment = fc.oneof(
  codeUnit(0x0000, 0xffff), // 任意码元，含代理项
  codeUnit(0xd800, 0xdbff), // 孤立（或与后一片段凑对的）高代理
  codeUnit(0xdc00, 0xdfff), // 孤立（或与前一片段凑对的）低代理
  codeUnit(0x4e00, 0x9fff), // 常用 CJK，书库正文的主体
  fc.integer({ min: 0x10000, max: 0x10ffff }).map((cp) => String.fromCodePoint(cp)), // 合法代理对
);

/** 任意码元序列：片段拼接、良构的全 Unicode 串、均匀取值的码元数组三种来源混合。 */
const anyCodeUnitString = fc.oneof(
  fc.string({ unit: segment, maxLength: 64 }),
  fc.string({ unit: "binary", maxLength: 64 }),
  fc
    .array(fc.integer({ min: 0, max: 0xffff }), { maxLength: 64 })
    .map((units) => String.fromCharCode(...units)),
);

describe("countCodePoints", () => {
  // Feature: e2e-visual-testing, Property 2: 码点计数与 `Array.from` 一致
  // **Validates: Requirements 19.3**
  it("对任意由 0–0xFFFF 码元组成的字符串（含孤立代理项）都等于 Array.from(s).length", () => {
    fc.assert(
      fc.property(anyCodeUnitString, (s) => {
        expect(countCodePoints(s)).toBe(Array.from(s).length);
      }),
      { numRuns: 100 },
    );
  });

  it("增补平面字符计 1，与 UTF-16 码元数不同（19.6 (d) 的口径）", () => {
    const s = "第一章𠀀𝄞";
    expect(s.length).toBe(7);
    expect(countCodePoints(s)).toBe(5);
  });

  it("孤立与错位的代理项各计 1", () => {
    expect(countCodePoints("")).toBe(0);
    expect(countCodePoints("\ud800")).toBe(1); // 孤立高代理
    expect(countCodePoints("\udc00")).toBe(1); // 孤立低代理
    expect(countCodePoints("\udc00\ud800")).toBe(2); // 低在前、高在后，不成对
    expect(countCodePoints("a\ud800")).toBe(2); // 末尾悬空的高代理
    expect(countCodePoints("\ud800\ud800\udc00")).toBe(2); // 高 + 合法对
  });
});

describe("normalizeCharCount", () => {
  it("非负安全整数原样返回", () => {
    expect(normalizeCharCount(0)).toBe(0);
    expect(normalizeCharCount(18765432)).toBe(18765432);
    expect(normalizeCharCount(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("缺失、null、字符串、负数、小数与非安全整数视为不可用（19.10）", () => {
    for (const v of [undefined, null, "12", -1, 1.5, NaN, Infinity, 2 ** 53, {}]) {
      expect(normalizeCharCount(v)).toBeNull();
    }
  });
});

describe("hasGzipMagic", () => {
  it("以 1f 8b 开头才算 gzip", () => {
    expect(hasGzipMagic(new Uint8Array([0x1f, 0x8b]))).toBe(true);
    expect(hasGzipMagic(new Uint8Array([0x1f, 0x8b, 0x08, 0x00]))).toBe(true);
  });

  it("空字节、只有一个字节与 SPA 回退的 HTML 都不是 gzip", () => {
    expect(hasGzipMagic(new Uint8Array([]))).toBe(false);
    expect(hasGzipMagic(new Uint8Array([0x1f]))).toBe(false);
    expect(hasGzipMagic(new TextEncoder().encode("<!doctype html>"))).toBe(false);
  });
});

describe("BookTextInvalidError", () => {
  it("message 由原因标题与 detail 拼成，reason 可直接区分", () => {
    const err = new BookTextInvalidError("char-count-mismatch", "码点数 12，目录记录 13");

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("BookTextInvalidError");
    expect(err.reason).toBe("char-count-mismatch");
    expect(err.message).toBe("书籍正文与目录不符（码点数 12，目录记录 13）");
  });

  it("detail 为空串时只有标题", () => {
    expect(new BookTextInvalidError("not-gzip", "").message).toBe("书籍正文文件无效");
    expect(new BookTextInvalidError("corrupt-gzip", "").message).toBe("书籍正文文件损坏");
  });
});
