import { beforeEach, describe, expect, it } from "vitest";
import {
  CachePutResult,
  CacheStore,
  DEFAULT_MAX_BOOKS,
  MAX_MAX_BOOKS,
  MIN_MAX_BOOKS,
  currentMaxBooks,
  isCacheDegraded,
  isQuotaExceeded,
  lruCandidates,
  normalizeMaxBooks,
  planCacheEviction,
  putCachedBook,
  resetCacheDegradation,
} from "./bookCache";
import { CachedBookMeta, CachedBookRecord, CacheUnavailableError } from "./indexedDB";
import { getStoredSettings } from "./storage";

/**
 * 覆盖策略层的两半（design §11）：
 *
 * - **纯函数**：`normalizeMaxBooks`、`isQuotaExceeded`、`lruCandidates`、`planCacheEviction`。
 *   淘汰口径里的差一位（写完到底是 10 本还是 11 本）和配额判定的三种浏览器写法，都是类型
 *   检查完全看不见、症状却是"缓存悄悄越界"或"配额满了直接放弃缓存"的地方。
 * - **状态机**：`putCachedBook` 的 淘汰 → 写 → 配额重试一次 → 降级落闩。用 `FakeStore`
 *   替掉存储层（`putCachedBook` 的 `store` 参数就是为此留的），被测的仍是本模块真实的策略
 *   逻辑，只是把 IndexedDB 这个 Node 下不存在的宿主换成了一个会按配额拒写的内存实现。
 *
 * 真正需要浏览器的部分明确不在这里：`onupgradeneeded` 删库重建、索引游标的实际顺序、
 * 以及"多大的书会真的触发 QuotaExceededError"。
 */

/** 按配额拒写的内存存储，行为对齐存储层契约：读静默、写抛出。 */
class FakeStore implements CacheStore {
  records = new Map<string, CachedBookRecord>();
  /** 容量（字节）。`Infinity` 即从不拒写。 */
  capacity = Infinity;
  /** 强制每次写都抛这个错误，用于试非配额失败与连续失败。 */
  writeError: unknown = null;
  /** 强制删除失败。 */
  removeError: unknown = null;
  writes: string[] = [];
  removes: string[] = [];
  lists = 0;

  async list(): Promise<CachedBookMeta[]> {
    this.lists++;
    // 存储层承诺按 lastAccess 升序返回；这里刻意反着给，以证明策略层不依赖入参顺序。
    return [...this.records.values()]
      .map(({ bookId, bytes, lastAccess, cachedAt }) => ({ bookId, bytes, lastAccess, cachedAt }))
      .sort((a, b) => b.lastAccess - a.lastAccess);
  }

  async write(record: CachedBookRecord): Promise<void> {
    this.writes.push(record.bookId);
    if (this.writeError) throw this.writeError;

    const others = [...this.records.values()]
      .filter((r) => r.bookId !== record.bookId)
      .reduce((sum, r) => sum + r.bytes, 0);
    if (others + record.bytes > this.capacity) {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    }

    this.records.set(record.bookId, record);
  }

  async remove(bookId: string): Promise<void> {
    this.removes.push(bookId);
    if (this.removeError) throw this.removeError;
    this.records.delete(bookId);
  }

  seed(specs: { bookId: string; bytes: number; lastAccess: number }[]): this {
    for (const { bookId, bytes, lastAccess } of specs) {
      this.records.set(bookId, {
        bookId,
        gz: new ArrayBuffer(0),
        bytes,
        lastAccess,
        cachedAt: lastAccess,
      });
    }
    return this;
  }

  get cached(): string[] {
    return [...this.records.keys()].sort();
  }
}

/** 造一批元数据：`lastAccess` 按给定顺序递增，即数组里越靠前越"久未访问"。 */
function metas(...bookIds: string[]): CachedBookMeta[] {
  return bookIds.map((bookId, i) => ({
    bookId,
    bytes: 1024,
    lastAccess: 1700000000000 + i,
    cachedAt: 1700000000000,
  }));
}

beforeEach(() => {
  // 降级闩是模块级单例，不复位会让前一个用例的降级污染后面的
  resetCacheDegradation();
});

describe("normalizeMaxBooks", () => {
  it("正常值原样通过", () => {
    expect(normalizeMaxBooks(10)).toBe(10);
    expect(normalizeMaxBooks(1)).toBe(1);
    expect(normalizeMaxBooks(50)).toBe(50);
  });

  it("越界收拢到 [1, 50]：既不会变成关闭缓存，也不会变成无上限", () => {
    expect(normalizeMaxBooks(0)).toBe(MIN_MAX_BOOKS);
    expect(normalizeMaxBooks(-7)).toBe(MIN_MAX_BOOKS);
    expect(normalizeMaxBooks(9999)).toBe(MAX_MAX_BOOKS);
  });

  it("小数向下取整（8.9 本没有意义）", () => {
    expect(normalizeMaxBooks(8.9)).toBe(8);
  });

  it("非数字与 NaN 回到默认值——手改过的 localStorage 不该让淘汰算错", () => {
    expect(normalizeMaxBooks(undefined)).toBe(DEFAULT_MAX_BOOKS);
    expect(normalizeMaxBooks("十本")).toBe(DEFAULT_MAX_BOOKS);
    expect(normalizeMaxBooks(null)).toBe(DEFAULT_MAX_BOOKS);
    expect(normalizeMaxBooks(NaN)).toBe(DEFAULT_MAX_BOOKS);
    expect(normalizeMaxBooks(Infinity)).toBe(DEFAULT_MAX_BOOKS);
  });

  it("可指定别的回退值", () => {
    expect(normalizeMaxBooks("x", 3)).toBe(3);
  });
});

describe("上限的默认值（需求 4.2）", () => {
  it("设置里的默认值与策略层的 DEFAULT_MAX_BOOKS 一致", () => {
    // localStorage 在 Node 下不存在，getStoredSettings() 因此返回 DEFAULT_SETTINGS——
    // 正好用来钉住两个模块间那个不敢 import（会成环）的字面量 10。
    expect(getStoredSettings().cacheMaxBooks).toBe(DEFAULT_MAX_BOOKS);
    expect(currentMaxBooks()).toBe(DEFAULT_MAX_BOOKS);
  });
});

describe("isQuotaExceeded", () => {
  it("现代浏览器：DOMException 的 name", () => {
    expect(isQuotaExceeded(new DOMException("full", "QuotaExceededError"))).toBe(true);
  });

  it("Firefox 的历史名字", () => {
    expect(isQuotaExceeded({ name: "NS_ERROR_DOM_QUOTA_REACHED" })).toBe(true);
  });

  it("只有数字 code 的老实现：22 与 1014", () => {
    expect(isQuotaExceeded({ name: "Error", code: 22 })).toBe(true);
    expect(isQuotaExceeded({ name: "Error", code: 1014 })).toBe(true);
  });

  it("丢了 name、只剩 message 的包装错误也认", () => {
    expect(isQuotaExceeded(new Error("Quota exceeded while writing book"))).toBe(true);
  });

  it("字符串 code 不误判（Node 风格错误的 code 是 \"ENOENT\" 这类）", () => {
    expect(isQuotaExceeded({ name: "Error", code: "22" })).toBe(false);
  });

  it("IndexedDB 不可用不是配额问题——淘汰再重试救不回来，该直接降级", () => {
    expect(isQuotaExceeded(new CacheUnavailableError())).toBe(false);
  });

  it("无关错误与非对象一律为 false", () => {
    expect(isQuotaExceeded(new DOMException("boom", "AbortError"))).toBe(false);
    expect(isQuotaExceeded(new TypeError("x is not a function"))).toBe(false);
    expect(isQuotaExceeded(null)).toBe(false);
    expect(isQuotaExceeded(undefined)).toBe(false);
    expect(isQuotaExceeded("QuotaExceededError")).toBe(false);
  });
});

describe("lruCandidates", () => {
  it("最久未访问在前，且不依赖入参顺序", () => {
    const [a, b, c] = metas("a", "b", "c"); // lastAccess 递增：a 最久未访问
    expect(lruCandidates([c, a, b])).toEqual(["a", "b", "c"]);
  });

  it("排除目标书：覆盖写不该先把自己删掉", () => {
    expect(lruCandidates(metas("a", "b", "c"), "a")).toEqual(["b", "c"]);
  });

  it("lastAccess 同刻时按 id 排，结果不随枚举顺序抖动", () => {
    const sameInstant: CachedBookMeta[] = [
      { bookId: "c", bytes: 1, lastAccess: 42, cachedAt: 1 },
      { bookId: "a", bytes: 1, lastAccess: 42, cachedAt: 1 },
      { bookId: "b", bytes: 1, lastAccess: 42, cachedAt: 1 },
    ];

    expect(lruCandidates(sameInstant)).toEqual(["a", "b", "c"]);
  });

  it("空缓存给空列表", () => {
    expect(lruCandidates([], "a")).toEqual([]);
  });
});

describe("planCacheEviction（需求 4.3）", () => {
  it("没满就不淘汰", () => {
    expect(planCacheEviction(metas("a", "b", "c"), "new", 10)).toEqual([]);
  });

  it("目标书不在缓存里：只淘汰 1 本，剩 9 本 + 新的 1 本 = 上限 10", () => {
    const ten = metas("b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8", "b9", "b10");

    expect(planCacheEviction(ten, "new", 10)).toEqual(["b1"]);
  });

  it("目标书已在缓存里（覆盖写）：不白淘汰一本", () => {
    const ten = metas("b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8", "b9", "b10");

    expect(planCacheEviction(ten, "b1", 10)).toEqual([]);
  });

  it("超额多本时一次性给出全部淘汰对象，按最久未访问排序", () => {
    const thirteen = metas(...Array.from({ length: 13 }, (_, i) => `b${i}`));

    expect(planCacheEviction(thirteen, "new", 10)).toEqual(["b0", "b1", "b2", "b3"]);
  });

  it("上限为 1 时清空其余全部", () => {
    expect(planCacheEviction(metas("a", "b", "c"), "new", 1)).toEqual(["a", "b", "c"]);
  });

  it("上限是脏值时按默认 10 处理，而不是把缓存清空", () => {
    const twelve = metas(...Array.from({ length: 12 }, (_, i) => `b${i}`));

    expect(planCacheEviction(twelve, "new", NaN)).toEqual(["b0", "b1", "b2"]);
    expect(planCacheEviction(twelve, "new", 0)).toEqual(
      Array.from({ length: 12 }, (_, i) => `b${i}`),
    );
  });
});

describe("putCachedBook：淘汰与写入（需求 4.3）", () => {
  it("有空位时直接写，不淘汰任何书", async () => {
    const store = new FakeStore().seed([{ bookId: "a", bytes: 10, lastAccess: 1 }]);

    const result = await putCachedBook("new", new ArrayBuffer(16), { store, maxBooks: 10 });

    expect(result).toEqual<CachePutResult>({ status: "written", evicted: [] });
    expect(store.cached).toEqual(["a", "new"]);
  });

  it("满了先淘汰最久未访问的一本再写，写完不超上限", async () => {
    const store = new FakeStore().seed([
      { bookId: "old", bytes: 10, lastAccess: 1 },
      { bookId: "mid", bytes: 10, lastAccess: 2 },
      { bookId: "fresh", bytes: 10, lastAccess: 3 },
    ]);

    const result = await putCachedBook("new", new ArrayBuffer(16), { store, maxBooks: 3 });

    expect(result.status).toBe("written");
    expect(result.evicted).toEqual(["old"]);
    expect(store.cached).toEqual(["fresh", "mid", "new"]);
  });

  it("写入的记录带真实字节数与给定时刻", async () => {
    const store = new FakeStore();

    await putCachedBook("a", new ArrayBuffer(4096), { store, now: 1700000000000 });

    expect(store.records.get("a")).toMatchObject({
      bytes: 4096,
      lastAccess: 1700000000000,
      cachedAt: 1700000000000,
    });
  });

  it("上限取自设置（未传 maxBooks 时）", async () => {
    const store = new FakeStore().seed(
      Array.from({ length: 10 }, (_, i) => ({ bookId: `b${i}`, bytes: 1, lastAccess: i })),
    );

    const result = await putCachedBook("new", new ArrayBuffer(1), { store });

    // 设置里的默认上限是 10 → 10 本里淘汰最久的 1 本
    expect(result.evicted).toEqual(["b0"]);
    expect(store.records.size).toBe(10);
  });
});

describe("putCachedBook：配额降级（需求 4.4）", () => {
  it("撞配额 → 淘汰最久未访问的一本 → 重试成功，不降级", async () => {
    const store = new FakeStore().seed([
      { bookId: "old", bytes: 60, lastAccess: 1 },
      { bookId: "fresh", bytes: 20, lastAccess: 2 },
    ]);
    store.capacity = 100; // 已占 80，新书 40 → 第一次必撞

    const result = await putCachedBook("new", new ArrayBuffer(40), { store, maxBooks: 10 });

    expect(result.status).toBe("evicted-and-written");
    expect(result.evicted).toEqual(["old"]);
    expect(store.cached).toEqual(["fresh", "new"]);
    expect(store.writes).toEqual(["new", "new"]); // 恰好重试一次
    expect(isCacheDegraded()).toBe(false);
  });

  it("重试仍失败 → 降级为仅内存缓存，不抛异常（阅读不中断）", async () => {
    const store = new FakeStore().seed([
      { bookId: "old", bytes: 10, lastAccess: 1 },
      { bookId: "fresh", bytes: 10, lastAccess: 2 },
    ]);
    store.capacity = 50; // 单本 200 比总配额还大，淘汰谁都写不进去

    const result = await putCachedBook("huge", new ArrayBuffer(200), { store, maxBooks: 10 });

    expect(result.status).toBe("degraded");
    expect(isQuotaExceeded(result.error)).toBe(true);
    expect(result.evicted).toEqual(["old"]);
    expect(store.writes).toEqual(["huge", "huge"]); // 只重试一次，不循环
    expect(store.cached).toEqual(["fresh"]); // 没写进去，但已有缓存仍可用
  });

  it("空缓存下撞配额：无可淘汰对象则不做无谓重试，直接降级", async () => {
    const store = new FakeStore();
    store.capacity = 10;

    const result = await putCachedBook("huge", new ArrayBuffer(200), { store });

    expect(result.status).toBe("degraded");
    expect(result.evicted).toEqual([]);
    expect(store.writes).toEqual(["huge"]);
  });

  it("非配额错误不触发淘汰重试，直接降级", async () => {
    const store = new FakeStore().seed([{ bookId: "old", bytes: 10, lastAccess: 1 }]);
    store.writeError = new DOMException("db is gone", "InvalidStateError");

    const result = await putCachedBook("new", new ArrayBuffer(8), { store, maxBooks: 10 });

    expect(result.status).toBe("degraded");
    expect(store.removes).toEqual([]); // 一本都没删
    expect(store.writes).toEqual(["new"]); // 没重试
  });

  it("淘汰阶段自身失败即按失败处理，不再尝试写入", async () => {
    const store = new FakeStore().seed([
      { bookId: "old", bytes: 10, lastAccess: 1 },
      { bookId: "fresh", bytes: 10, lastAccess: 2 },
    ]);
    store.removeError = new DOMException("cannot delete", "InvalidStateError");

    const result = await putCachedBook("new", new ArrayBuffer(8), { store, maxBooks: 2 });

    expect(result.status).toBe("degraded");
    expect(store.writes).toEqual([]);
  });

  it("降级后本会话不再碰存储层（失败的写入代价是几十 MB，不重复付）", async () => {
    const store = new FakeStore();
    store.capacity = 0;

    await putCachedBook("huge", new ArrayBuffer(200), { store });
    expect(isCacheDegraded()).toBe(true);
    const listsBefore = store.lists;

    const second = await putCachedBook("another", new ArrayBuffer(8), { store });

    expect(second).toEqual<CachePutResult>({ status: "skipped", evicted: [] });
    expect(store.writes).toEqual(["huge"]); // 第二次一次都没试
    expect(store.lists).toBe(listsBefore); // 连列表都没读
  });

  it("解闩后恢复写入（对应任务 50 清空缓存后的场景）", async () => {
    const store = new FakeStore();
    store.capacity = 0;
    await putCachedBook("huge", new ArrayBuffer(200), { store });

    resetCacheDegradation();
    store.capacity = Infinity;
    const result = await putCachedBook("small", new ArrayBuffer(8), { store });

    expect(result.status).toBe("written");
    expect(store.cached).toEqual(["small"]);
  });
});

describe("putCachedBook：宿主没有 IndexedDB（design §10）", () => {
  it("走真实存储层时降级而不抛，阅读继续", async () => {
    // Node 下全局没有 indexedDB，writeCachedBook 抛 CacheUnavailableError
    const result = await putCachedBook("从零开始-雷云风暴", new ArrayBuffer(8));

    expect(result.status).toBe("degraded");
    expect(result.error).toBeInstanceOf(CacheUnavailableError);
    expect(isCacheDegraded()).toBe(true);
  });
});
