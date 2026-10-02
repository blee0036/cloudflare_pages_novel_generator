import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_PROGRESS_RECORDS,
  ProgressStamp,
  addBookmark,
  getAllReadingHistory,
  getBookProgress,
  getBookmarks,
  getStoredSettings,
  isChapterBookmarked,
  planProgressEviction,
  readBookmarks,
  readProgress,
  removeBookmark,
  saveBookProgress,
  saveBookmarks,
  saveStoredSettings,
} from "./storage";
import {
  SLIDER_SPECS,
  SliderKey,
  SliderSpec,
  normalizeSliderSettings,
} from "./sliderSettings";
import { DEFAULT_MAX_BOOKS, MAX_MAX_BOOKS, MIN_MAX_BOOKS } from "./bookCache";
import { READER_THEMES } from "./theme";

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

const SETTINGS_KEY = "koodo_novel_reader_settings";
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

describe("getStoredSettings 的滑杆归一（需求 6.5，D4）", () => {
  const DEFAULTS = {
    theme: "sepia",
    fontSize: 19,
    lineHeight: 1.85,
    letterSpacing: 1,
    fontFamily: "system",
    contentWidth: 820,
    cacheMaxBooks: 10,
  };

  it("没有记录、记录坏掉或不是对象时，返回的默认值不变", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(getStoredSettings()).toEqual(DEFAULTS);

    host.localStorage!.setItem(SETTINGS_KEY, "{ 不是 JSON");
    expect(getStoredSettings()).toEqual(DEFAULTS);

    putRaw(SETTINGS_KEY, 42);
    expect(getStoredSettings()).toEqual(DEFAULTS);
  });

  it("非数值、越界、不在网格上的取值都归一；缺失字段补默认值，遗留键被丢弃", () => {
    putRaw(SETTINGS_KEY, {
      theme: "dark",
      fontSize: "20", // 字符串不是有限数 → 默认值
      lineHeight: 1.83, // 1.80 与 1.85 之间，离 1.85 更近
      letterSpacing: -3, // 越下界 → 0
      contentWidth: 830, // 820 与 840 正中 → 取较小者
      cacheMaxBooks: 9999, // 越上界 → 50
      viewMode: "scroll",
    });

    expect(getStoredSettings()).toEqual({
      ...DEFAULTS,
      theme: "dark",
      lineHeight: 1.85,
      letterSpacing: 0,
      contentWidth: 820,
      cacheMaxBooks: 50,
    });
  });

  it("JSON 存不下 NaN / Infinity，落盘后是 null，同样回到默认值", () => {
    host.localStorage!.setItem(
      SETTINGS_KEY,
      JSON.stringify({ fontSize: NaN, lineHeight: Infinity, contentWidth: null }),
    );

    const s = getStoredSettings();
    expect(s.fontSize).toBe(19);
    expect(s.lineHeight).toBe(1.85);
    expect(s.contentWidth).toBe(820);
  });

  it("网格上的值原样保留，旧步长 40 可达的版心宽度无需迁移，浮点尾差被消除", () => {
    putRaw(SETTINGS_KEY, {
      fontSize: 36,
      lineHeight: 1.4 + 9 * 0.05, // 1.8500000000000003
      letterSpacing: 2.5,
      contentWidth: 600 + 40 * 7, // 880：旧网格上的点也在新网格上
      cacheMaxBooks: 1,
    });

    const s = getStoredSettings();
    expect(s.fontSize).toBe(36);
    expect(s.lineHeight).toBe(1.85);
    expect(s.letterSpacing).toBe(2.5);
    expect(s.contentWidth).toBe(880);
    expect(s.cacheMaxBooks).toBe(1);
  });

  it("cacheMaxBooks 的规格与 bookCache 的常量一致（两模块间不能 import，字面量靠这里钉住）", () => {
    expect(SLIDER_SPECS.cacheMaxBooks).toEqual({
      min: MIN_MAX_BOOKS,
      max: MAX_MAX_BOOKS,
      step: 1,
      fallback: DEFAULT_MAX_BOOKS,
    });
  });
});

describe("设置的读写往返（需求 6.4、6.5）", () => {
  /** `ReaderSettings` 的白名单字段：读出的对象必须恰好是这 7 个键。 */
  const SETTING_KEYS = [
    "theme",
    "fontSize",
    "lineHeight",
    "letterSpacing",
    "fontFamily",
    "contentWidth",
    "cacheMaxBooks",
  ];
  const SLIDER_KEYS = Object.keys(SLIDER_SPECS) as SliderKey[];

  /**
   * 一个滑杆字段在"磁盘"上可能的原始值。均匀取任意 JSON 值几乎碰不到网格点与正中点，
   * 所以按来源混合：网格点（`min + k·step` 带浮点尾差）、两网格点正中（平局取较小者）、
   * 区间内外的任意实数、落盘后变成 `null` 的非有限数、数字字符串、任意 JSON 值。
   * 字段缺失由外层 `fc.record` 的 `requiredKeys: []` 覆盖。
   */
  const rawSliderValue = (spec: SliderSpec): fc.Arbitrary<unknown> => {
    const last = Math.round((spec.max - spec.min) / spec.step);
    const span = spec.max - spec.min;
    return fc.oneof(
      fc.integer({ min: 0, max: last }).map((k) => spec.min + k * spec.step),
      fc.integer({ min: 0, max: last - 1 }).map((k) => spec.min + (k + 0.5) * spec.step),
      fc.double({ min: spec.min - span, max: spec.max + span, noNaN: true }),
      fc.constantFrom(NaN, Infinity, -Infinity),
      fc.double({ min: spec.min, max: spec.max, noNaN: true }).map(String),
      fc.jsonValue(),
    );
  };

  /** `theme` / `fontFamily` 不归一，合法键、任意字符串、任意 JSON 值都要原样往返。 */
  const rawEnum = (valid: readonly string[]) =>
    fc.oneof(fc.constantFrom(...valid), fc.string(), fc.jsonValue());

  /** 旧版本遗留键（`viewMode`）与任意多余键；与白名单重名的键交给上面的字段生成器。 */
  const extraKeys = fc.dictionary(
    fc
      .oneof(fc.constant("viewMode"), fc.string({ minLength: 1, maxLength: 12 }))
      .filter((k) => !SETTING_KEYS.includes(k)),
    fc.jsonValue(),
    { maxKeys: 4 },
  );

  const rawSettings = fc
    .tuple(
      fc.record(
        {
          theme: rawEnum(READER_THEMES.map((t) => t.key)),
          fontFamily: rawEnum(["system", "serif", "kaiti"]),
          fontSize: rawSliderValue(SLIDER_SPECS.fontSize),
          lineHeight: rawSliderValue(SLIDER_SPECS.lineHeight),
          letterSpacing: rawSliderValue(SLIDER_SPECS.letterSpacing),
          contentWidth: rawSliderValue(SLIDER_SPECS.contentWidth),
          cacheMaxBooks: rawSliderValue(SLIDER_SPECS.cacheMaxBooks),
        },
        { requiredKeys: [] },
      ),
      extraKeys,
    )
    .map(([known, extra]) => ({ ...extra, ...known }));

  // Feature: reader-defect-fixes, Property 2: 设置读出后再存回再读出不变
  // **Validates: Requirements 6.4, 6.5**
  it("对任意落盘的设置对象：读出值的 5 个滑杆字段是归一的不动点，存回后再读出深等于读出值", () => {
    fc.assert(
      fc.property(rawSettings, (raw) => {
        putRaw(SETTINGS_KEY, raw);
        const s1 = getStoredSettings();

        // 白名单：多余键与遗留键不进返回值，缺失字段已补齐
        expect(Object.keys(s1).sort()).toEqual([...SETTING_KEYS].sort());

        const fixed = normalizeSliderSettings(s1);
        for (const key of SLIDER_KEYS) {
          expect(fixed[key]).toBe(s1[key]);
        }

        saveStoredSettings(s1);
        expect(getStoredSettings()).toStrictEqual(s1);
      }),
      { numRuns: 100 },
    );
  });
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
