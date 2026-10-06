import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CHAPTER_PARAM, parseUrlChapter, withChapterParam } from "./readerUrl";

/**
 * 键与值的字母表（design Property 3）：`ch` 本身、会被手写拼串弄错的保留字符 `&` `=` `+` `%`、
 * 空格与中文。由 0–4 个片段拼成，故含空串；`"c"` 与 `"h"` 相邻也能拼出 `ch`。
 */
const piece = fc.string({
  unit: fc.constantFrom("ch", "c", "h", "a", "1", "&", "=", "+", "%", " ", "%20", "中", "文", "?"),
  maxLength: 4,
});

/** 键偏向 `ch`，保证多个 `ch`（替换第一个、删去其余）的情形经常出现。 */
const key = fc.oneof({ arbitrary: fc.constant(CHAPTER_PARAM), weight: 1 }, { arbitrary: piece, weight: 3 });

/** 由键值对列表经 `URLSearchParams` 序列化得到的良构查询串。 */
const serializedSearch = fc
  .array(fc.tuple(key, piece), { maxLength: 8 })
  .map((entries) => new URLSearchParams(entries).toString());

/**
 * 手写形态的查询串：`%20` 表示空格、`%68` 拼出 `c%68`（解码后即 `ch`）、残缺的 `%2`、
 * 连续的 `&&`、无值的键、值里再出现 `=` 等。解析口径与实现同为 `URLSearchParams`。
 */
const rawSearch = fc.string({
  unit: fc.constantFrom("ch", "c", "h", "a", "&", "=", "+", "%", "%2", "%20", "%68", "%E4%B8%AD", " ", "中", "?"),
  maxLength: 16,
});

/** 查询串 s：两种来源混合，可带前导 `?`。 */
const search = fc
  .tuple(fc.oneof(serializedSearch, rawSearch), fc.boolean())
  .map(([s, withQuestionMark]) => (withQuestionMark ? `?${s}` : s));

/** 非负整数：小下标为主，另含到 `Number.MAX_SAFE_INTEGER` 的大数。 */
const chapter = fc.oneof(fc.nat({ max: 20 }), fc.maxSafeNat());

/** 解码后的条目序列；比较条目而不是原串，因为编码会被规范化（`%20` 写成 `+`）。 */
const entriesOf = (s: string): [string, string][] => [...new URLSearchParams(s)];

const withoutCh = (entries: [string, string][]) => entries.filter(([k]) => k !== CHAPTER_PARAM);

describe("parseUrlChapter", () => {
  it("在 [0, chapterCount) 内的整数原样返回", () => {
    expect(parseUrlChapter("0", 10)).toBe(0);
    expect(parseUrlChapter("3", 10)).toBe(3);
    expect(parseUrlChapter("9", 10)).toBe(9);
  });

  it("沿用 parseInt 只读前缀：“3abc” 读作 3", () => {
    expect(parseUrlChapter("3abc", 10)).toBe(3);
  });

  it("负数无效：“-1” 返回 null", () => {
    expect(parseUrlChapter("-1", 10)).toBeNull();
  });

  it("越界无效：等于或大于章节数返回 null", () => {
    expect(parseUrlChapter("10", 10)).toBeNull();
    expect(parseUrlChapter("99", 10)).toBeNull();
    expect(parseUrlChapter("0", 0)).toBeNull();
  });

  it("缺省（null）、空串与非数字开头返回 null", () => {
    expect(parseUrlChapter(null, 10)).toBeNull();
    expect(parseUrlChapter("", 10)).toBeNull();
    expect(parseUrlChapter("abc", 10)).toBeNull();
  });

  it("-0 规整为 +0", () => {
    expect(Object.is(parseUrlChapter("-0", 10), 0)).toBe(true);
  });
});

describe("withChapterParam", () => {
  it("缺省时追加到末尾，接受前导 ?，返回不带 ?", () => {
    expect(withChapterParam("?a=1", 5)).toBe("a=1&ch=5");
    expect(withChapterParam("", 0)).toBe("ch=0");
  });

  it("替换第一个 ch 并删去其余同名项，位置保留", () => {
    expect(withChapterParam("a=1&ch=2&b=3&ch=4", 7)).toBe("a=1&ch=7&b=3");
  });

  it("其余参数的条目不变，编码按 URLSearchParams 规范化", () => {
    expect(withChapterParam("?q=a%20b&ch=1", 2)).toBe("q=a+b&ch=2");
  });

  // Feature: reader-defect-fixes, Property 3: 写回 URL 只改 `ch` 且幂等
  // **Validates: Requirements 7.2**
  it("对任意查询串 s 与非负整数 n：ch 恰为 [String(n)]，其余条目与顺序不变，再调用一次结果不变", () => {
    fc.assert(
      fc.property(search, chapter, (s, n) => {
        const r = withChapterParam(s, n);
        const before = entriesOf(s);
        const after = entriesOf(r);

        expect(new URLSearchParams(r).getAll(CHAPTER_PARAM)).toEqual([String(n)]);
        expect(withoutCh(after)).toEqual(withoutCh(before));

        // design §6：已有 ch 时留在第一个 ch 的位置，没有时追加到末尾
        const firstCh = before.findIndex(([k]) => k === CHAPTER_PARAM);
        const chIndex = after.findIndex(([k]) => k === CHAPTER_PARAM);
        expect(chIndex).toBe(firstCh === -1 ? after.length - 1 : firstCh);

        expect(withChapterParam(r, n)).toBe(r);
      }),
      { numRuns: 100 },
    );
  });
});
