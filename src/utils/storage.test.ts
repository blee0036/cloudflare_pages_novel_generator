import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_PROGRESS_RECORDS,
  ProgressStamp,
  addBookmark,
  getAllReadingHistory,
  getBookProgress,
  getBookmarks,
  isChapterBookmarked,
  planProgressEviction,
  readBookmarks,
  readProgress,
  removeBookmark,
  saveBookProgress,
  saveBookmarks,
} from "./storage";

/**
 * 最小 localStorage 替身。`storage.ts` 只用到 `getItem` / `setItem` / `removeItem` /
 * `key` / `length`，一个 Map 就够——所以这组断言**不需要 jsdom**，仍然落在
 * design §11 划定的"只测纯 TS 逻辑"范围内（DOM / React 组件测试不在范围内）。
 */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, String(v));
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    clear: () => {
      map.clear();
    },
  } as Storage;
}

const host = globalThis as unknown as { localStorage?: Storage };

const PROGRESS_PREFIX = "koodo_novel_progress_";
const BOOKMARKS_PREFIX = "koodo_novel_bookmarks_";

/** 直接往"磁盘"塞一条原始记录，绕过写入侧的类型约束（模拟旧版本留下的数据）。 */
function putRaw(key: string, value: unknown) {
  host.localStorage!.setItem(key, JSON.stringify(value));
}

/** v1 进度记录的形状：无 `charOffset`、无 `v`，带一个从未被写入却声明过的 `scrollRatio`。 */
const V1_PROGRESS = {
  bookId: "从零开始-雷云风暴",
  chapterId: 1200,
  chapterTitle: "第一千两百章",
  scrollRatio: 0.42,
  progressPercent: 37.2,
  lastReadTime: 1_700_000_000_000,
};

beforeEach(() => {
  host.localStorage = memoryStorage();
});

afterEach(() => {
  delete host.localStorage;
  vi.restoreAllMocks();
});

describe("readProgress", () => {
  it("v1 记录视为偏移 0，不报错也不丢弃", () => {
    const p = readProgress(V1_PROGRESS);

    expect(p).not.toBeNull();
    expect(p!.charOffset).toBe(0);
    expect(p!.v).toBe(2);
    // 其余字段原样保留：兼容读取不是"重置进度"
    expect(p!.chapterId).toBe(1200);
    expect(p!.chapterTitle).toBe("第一千两百章");
    expect(p!.progressPercent).toBeCloseTo(37.2);
    expect(p!.lastReadTime).toBe(V1_PROGRESS.lastReadTime);
  });

  it("显式丢弃 scrollRatio，不让像素比例混进 v2 记录", () => {
    const p = readProgress(V1_PROGRESS)!;

    expect(p).not.toHaveProperty("scrollRatio");
    // 回写时磁盘上也不该再出现它
    saveBookProgress(p);
    expect(host.localStorage!.getItem(`${PROGRESS_PREFIX}${p.bookId}`)).not.toContain(
      "scrollRatio",
    );
  });

  it("没有章号的记录无从定位，返回 null", () => {
    expect(readProgress({ bookId: "x", lastReadTime: 1 })).toBeNull();
    expect(readProgress({ bookId: "x", chapterId: "3" })).toBeNull();
    expect(readProgress(undefined)).toBeNull();
    expect(readProgress(null)).toBeNull();
    expect(readProgress("不是对象")).toBeNull();
  });

  it("单个字段坏掉只补退化值，不丢整条记录", () => {
    const p = readProgress({ chapterId: 7.9 }, "书")!;

    expect(p.bookId).toBe("书");
    expect(p.chapterId).toBe(7); // 小数章号会索引出空白页，夹成整数
    expect(p.chapterTitle).toBe("");
    expect(p.charOffset).toBe(0);
    expect(p.progressPercent).toBe(0);
    expect(p.lastReadTime).toBe(0);
  });

  it("负数与小数偏移一律规范成非负整数", () => {
    expect(readProgress({ chapterId: 0, charOffset: -5 }, "书")!.charOffset).toBe(0);
    expect(readProgress({ chapterId: 0, charOffset: 12.7 }, "书")!.charOffset).toBe(12);
    expect(readProgress({ chapterId: 0, charOffset: "8" }, "书")!.charOffset).toBe(0);
  });

  it("键名里的 bookId 优先于记录内的冗余副本", () => {
    const p = readProgress({ ...V1_PROGRESS, bookId: "改名前的书" }, "改名后的书")!;
    expect(p.bookId).toBe("改名后的书");
  });
});

describe("getBookProgress", () => {
  it("读出磁盘上的 v1 记录并补齐为 v2", () => {
    putRaw(`${PROGRESS_PREFIX}${V1_PROGRESS.bookId}`, V1_PROGRESS);

    const p = getBookProgress(V1_PROGRESS.bookId)!;
    expect(p.charOffset).toBe(0);
    expect(p.v).toBe(2);
  });

  it("没有记录或内容坏掉时返回 null 而不抛", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    host.localStorage!.setItem(`${PROGRESS_PREFIX}坏书`, "{ 不是 JSON");

    expect(getBookProgress("没读过的书")).toBeNull();
    expect(getBookProgress("坏书")).toBeNull();
  });

  it("存储不可用时退化为无进度，不影响调用方", () => {
    delete host.localStorage;
    expect(getBookProgress("任意书")).toBeNull();
    expect(getAllReadingHistory()).toEqual([]);
    expect(getBookmarks("任意书")).toEqual([]);
  });
});

describe("getAllReadingHistory", () => {
  it("按 lastReadTime 降序，并跳过读不出来的记录", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    putRaw(`${PROGRESS_PREFIX}旧`, { chapterId: 1, lastReadTime: 100 });
    putRaw(`${PROGRESS_PREFIX}新`, { chapterId: 2, lastReadTime: 300 });
    putRaw(`${PROGRESS_PREFIX}中`, { chapterId: 3, lastReadTime: 200 });
    putRaw(`${PROGRESS_PREFIX}缺章号`, { lastReadTime: 999 });
    host.localStorage!.setItem("koodo_novel_reader_settings", "{}");

    const history = getAllReadingHistory();

    expect(history.map((h) => h.bookId)).toEqual(["新", "中", "旧"]);
    // 记录里没写 bookId，全靠键名补出来
    expect(history.every((h) => h.bookId.length > 0)).toBe(true);
  });
});

describe("planProgressEviction", () => {
  const stamps = (times: number[]): ProgressStamp[] =>
    times.map((lastReadTime, i) => ({ bookId: `书${i}`, lastReadTime }));

  it("未超限时什么都不淘汰", () => {
    expect(planProgressEviction(stamps([3, 1, 2]), "书0", 3)).toEqual([]);
    expect(planProgressEviction([], undefined, 3)).toEqual([]);
  });

  it("超限时淘汰 lastReadTime 最旧的若干条", () => {
    expect(planProgressEviction(stamps([50, 10, 30, 20]), undefined, 2)).toEqual([
      "书1",
      "书3",
    ]);
  });

  it("刚写入的那本永不被淘汰，即使它看起来最旧", () => {
    const evicted = planProgressEviction(stamps([1, 50, 30]), "书0", 2);
    expect(evicted).not.toContain("书0");
    expect(evicted).toEqual(["书2"]);
  });

  it("同刻记录按 bookId 定序，结果不依赖枚举顺序", () => {
    const forward = planProgressEviction(stamps([5, 5, 5]), undefined, 1);
    const reversed = planProgressEviction([...stamps([5, 5, 5])].reverse(), undefined, 1);
    expect(forward).toEqual(reversed);
  });

  // 随机化不变式：不引 fast-check，用固定种子的线性同余发生器覆盖 200 组输入。
  it("任意输入下都满足：保留数不超上限、被留下的都比被淘汰的新", () => {
    let seed = 20250101;
    const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;

    for (let round = 0; round < 200; round++) {
      const limit = 1 + Math.floor(rand() * 6);
      const n = Math.floor(rand() * 15);
      const all = Array.from({ length: n }, (_, i) => ({
        bookId: `书${i}`,
        lastReadTime: Math.floor(rand() * 5) * 100,
      }));
      const keep = n > 0 && rand() < 0.7 ? `书${Math.floor(rand() * n)}` : undefined;

      const evicted = planProgressEviction(all, keep, limit);
      const evictedSet = new Set(evicted);
      const survivors = all.filter((s) => !evictedSet.has(s.bookId));

      expect(survivors.length).toBeLessThanOrEqual(Math.max(limit, keep ? 1 : 0));
      if (keep) expect(evictedSet.has(keep)).toBe(false);

      const newestEvicted = Math.max(...evicted.map((id) => timeOf(all, id)), -1);
      const oldestKept = Math.min(
        ...survivors.filter((s) => s.bookId !== keep).map((s) => s.lastReadTime),
        Number.POSITIVE_INFINITY,
      );
      expect(newestEvicted).toBeLessThanOrEqual(oldestKept);
    }
  });

  function timeOf(all: ProgressStamp[], bookId: string): number {
    return all.find((s) => s.bookId === bookId)!.lastReadTime;
  }
});

describe("saveBookProgress 的条数上限", () => {
  const record = (bookId: string, lastReadTime: number) => ({
    bookId,
    chapterId: 1,
    chapterTitle: "章",
    charOffset: 0,
    progressPercent: 1,
    lastReadTime,
    v: 2 as const,
  });

  it("不超上限时一条都不淘汰", () => {
    for (let i = 0; i < MAX_PROGRESS_RECORDS; i++) {
      saveBookProgress(record(`书${i}`, 1000 + i));
    }
    expect(getAllReadingHistory()).toHaveLength(MAX_PROGRESS_RECORDS);
  });

  it("超限时按 lastReadTime 淘汰最旧的，刚保存的那本必定留下", () => {
    for (let i = 0; i < MAX_PROGRESS_RECORDS + 5; i++) {
      saveBookProgress(record(`书${i}`, 1000 + i)); // 序号越大越新
    }

    const history = getAllReadingHistory();
    expect(history).toHaveLength(MAX_PROGRESS_RECORDS);
    expect(history.map((h) => h.bookId)).toContain(`书${MAX_PROGRESS_RECORDS + 4}`);
    // 最早的 5 本被淘汰
    for (let i = 0; i < 5; i++) {
      expect(getBookProgress(`书${i}`)).toBeNull();
    }
  });

  it("淘汰只动进度键，不碰书签与设置", () => {
    saveBookmarks("书0", [
      {
        id: "bm",
        bookId: "书0",
        chapterId: 1,
        chapterTitle: "章",
        charOffset: 10,
        previewText: "预览",
        createdAt: 1,
      },
    ]);
    host.localStorage!.setItem("koodo_novel_reader_settings", '{"theme":"sepia"}');

    for (let i = 0; i < MAX_PROGRESS_RECORDS + 5; i++) {
      saveBookProgress(record(`书${i}`, 1000 + i));
    }

    expect(getBookmarks("书0")).toHaveLength(1);
    expect(host.localStorage!.getItem("koodo_novel_reader_settings")).toBe(
      '{"theme":"sepia"}',
    );
  });
});

describe("书签的兼容读取", () => {
  /** v1 书签：没有 charOffset。 */
  const V1_BOOKMARK = {
    id: "书_12_1700000000000",
    bookId: "书",
    chapterId: 12,
    chapterTitle: "第十二章",
    previewText: "那一天……",
    createdAt: 1_700_000_000_000,
  };

  it("缺 charOffset 的旧书签补 0", () => {
    putRaw(`${BOOKMARKS_PREFIX}书`, [V1_BOOKMARK]);

    const list = getBookmarks("书");
    expect(list).toHaveLength(1);
    expect(list[0].charOffset).toBe(0);
    expect(list[0].id).toBe(V1_BOOKMARK.id);
    expect(list[0].previewText).toBe("那一天……");
  });

  it("非数组内容当空列表，不抛", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(readBookmarks(undefined, "书")).toEqual([]);
    expect(readBookmarks({ chapterId: 1 }, "书")).toEqual([]);

    host.localStorage!.setItem(`${BOOKMARKS_PREFIX}坏书`, "[不是 JSON");
    expect(getBookmarks("坏书")).toEqual([]);
  });

  it("每章至多一个书签：重复项在读取侧就被折掉，保留先出现的", () => {
    putRaw(`${BOOKMARKS_PREFIX}书`, [
      { ...V1_BOOKMARK, id: "新", charOffset: 500 },
      { ...V1_BOOKMARK, id: "旧", charOffset: 100 },
      { ...V1_BOOKMARK, id: "别章", chapterId: 13 },
      { chapterId: "坏" },
    ]);

    const list = getBookmarks("书");
    expect(list.map((b) => b.id)).toEqual(["新", "别章"]);
    expect(list[0].charOffset).toBe(500);
  });

  it("缺 id 的书签拿到稳定句柄，删除仍然有效", () => {
    const { id: _id, ...noId } = V1_BOOKMARK;
    putRaw(`${BOOKMARKS_PREFIX}书`, [noId]);

    const first = getBookmarks("书")[0];
    expect(first.id).toBe("书_12");
    expect(getBookmarks("书")[0].id).toBe(first.id); // 多次读取不变

    removeBookmark("书", first.id);
    expect(getBookmarks("书")).toEqual([]);
  });

  it("isChapterBookmarked 与 addBookmark 的 toggle 语义不变", () => {
    expect(isChapterBookmarked("书", 12)).toBe(false);

    addBookmark({ ...V1_BOOKMARK, charOffset: 320 });
    expect(isChapterBookmarked("书", 12)).toBe(true);
    expect(getBookmarks("书")[0].charOffset).toBe(320);

    // 同章重复添加不生效，toggle 的"已加/未加"才有唯一含义
    addBookmark({ ...V1_BOOKMARK, id: "另一个", charOffset: 999 });
    expect(getBookmarks("书")).toHaveLength(1);
    expect(getBookmarks("书")[0].id).toBe(V1_BOOKMARK.id);

    removeBookmark("书", V1_BOOKMARK.id);
    expect(isChapterBookmarked("书", 12)).toBe(false);
  });
});
