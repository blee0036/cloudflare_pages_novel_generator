import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CachedBookRecord,
  CacheUnavailableError,
  LRU_KEY_PATH,
  cacheMetaFromIndexKey,
  clearCachedBooks,
  createCachedBookRecord,
  deleteCachedBook,
  isCacheSupported,
  listCachedBooks,
  readCachedBook,
  touchCachedBook,
  writeCachedBook,
} from "./indexedDB";

/**
 * 只测不碰 DOM 的那部分（design §11）：记录成形、索引键的编解码，以及宿主没有 IndexedDB
 * 时的降级出口。真正的 open/put/游标行为需要浏览器，明确不在单测范围内——见文末说明。
 *
 * Node 环境下全局没有 `indexedDB`，这恰好就是 §10 那一行"IndexedDB 不可用 → 降级为仅内存
 * 缓存，阅读不中断"的现成夹具。
 */

/** 按索引声明的 keyPath 顺序，拼出该记录在 LRU 索引里的索引键。 */
function indexKeyOf(record: CachedBookRecord): number[] {
  return LRU_KEY_PATH.map((field) => record[field]);
}

describe("createCachedBookRecord", () => {
  it("bytes 取自 gz.byteLength，不由调用方传入", () => {
    const record = createCachedBookRecord("从零开始-雷云风暴", new ArrayBuffer(23446937));

    expect(record.bytes).toBe(23446937);
    expect(record.bytes).toBe(record.gz.byteLength);
  });

  it("两个时间戳初始相同，且用传入的时刻而非真实时钟", () => {
    const record = createCachedBookRecord("NB-NB", new ArrayBuffer(8), 1700000000000);

    expect(record.cachedAt).toBe(1700000000000);
    expect(record.lastAccess).toBe(1700000000000);
  });

  it("gz 原样引用，不复制几十 MB 的二进制", () => {
    const gz = new ArrayBuffer(16);
    expect(createCachedBookRecord("BUG之神-耳火大帝", gz).gz).toBe(gz);
  });

  it("空 gz 记为 0 字节而非 NaN", () => {
    expect(createCachedBookRecord("empty", new ArrayBuffer(0)).bytes).toBe(0);
  });

  it("字段齐备，主键即 bookId", () => {
    const record = createCachedBookRecord("1852铁血中华-绯红之月", new ArrayBuffer(4), 1);

    expect(Object.keys(record).sort()).toEqual(
      ["bookId", "bytes", "cachedAt", "gz", "lastAccess"].sort(),
    );
    expect(record.bookId).toBe("1852铁血中华-绯红之月");
  });
});

describe("cacheMetaFromIndexKey", () => {
  it("索引键与解码对位：round-trip 回原记录的元数据", () => {
    const record = createCachedBookRecord("从零开始-雷云风暴", new ArrayBuffer(1024), 1700000000000);
    record.lastAccess = 1700000009999; // 访问过一次，与 cachedAt 拉开

    expect(cacheMetaFromIndexKey(indexKeyOf(record), record.bookId)).toEqual({
      bookId: record.bookId,
      bytes: record.bytes,
      lastAccess: record.lastAccess,
      cachedAt: record.cachedAt,
    });
  });

  it("三个数值不串位", () => {
    // 三个值互不相等，任何一处错位都会被下面的断言逮住
    const meta = cacheMetaFromIndexKey([111, 222, 333], "book");

    expect(meta).toEqual({ bookId: "book", lastAccess: 111, bytes: 222, cachedAt: 333 });
  });

  it("主键不是非空字符串就判脏，返回 null", () => {
    expect(cacheMetaFromIndexKey([1, 2, 3], 42)).toBeNull();
    expect(cacheMetaFromIndexKey([1, 2, 3], "")).toBeNull();
    expect(cacheMetaFromIndexKey([1, 2, 3], undefined)).toBeNull();
  });

  it("索引键形状不符就判脏，返回 null", () => {
    expect(cacheMetaFromIndexKey([1, 2], "book")).toBeNull();
    expect(cacheMetaFromIndexKey([1, 2, 3, 4], "book")).toBeNull();
    expect(cacheMetaFromIndexKey(1700000000000, "book")).toBeNull();
    expect(cacheMetaFromIndexKey(null, "book")).toBeNull();
  });

  it("元素不是数字就判脏（不做隐式转换）", () => {
    expect(cacheMetaFromIndexKey(["1", 2, 3], "book")).toBeNull();
    expect(cacheMetaFromIndexKey([1, null, 3], "book")).toBeNull();
  });
});

describe("isCacheSupported", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("宿主没有 indexedDB 时为 false（Node、SSR、隐私模式）", () => {
    expect(isCacheSupported()).toBe(false);
  });

  it("宿主有 indexedDB 时为 true", () => {
    vi.stubGlobal("indexedDB", {} as IDBFactory);
    expect(isCacheSupported()).toBe(true);
  });
});

describe("IndexedDB 不可用时的降级（需求 4.4、design §10）", () => {
  it("读路径静默返回空，调用方不必写 try/catch", async () => {
    await expect(readCachedBook("从零开始-雷云风暴")).resolves.toBeNull();
    await expect(listCachedBooks()).resolves.toEqual([]);
  });

  it("写路径抛 CacheUnavailableError，供上层区分失败原因", async () => {
    const gz = new ArrayBuffer(8);

    await expect(writeCachedBook(createCachedBookRecord("book", gz))).rejects.toBeInstanceOf(
      CacheUnavailableError,
    );
    await expect(touchCachedBook("book")).rejects.toBeInstanceOf(CacheUnavailableError);
    await expect(deleteCachedBook("book")).rejects.toBeInstanceOf(CacheUnavailableError);
    await expect(clearCachedBooks()).rejects.toBeInstanceOf(CacheUnavailableError);
  });
});
