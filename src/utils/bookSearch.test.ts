import { describe, expect, it } from "vitest";
import { BookSummary } from "../types";
import {
  UNKNOWN_AUTHOR,
  buildHaystack,
  buildSearchIndex,
  filterByAuthor,
  fuzzyScore,
  isFilterableAuthor,
  scoreHaystack,
  searchBooks,
  splitQuery,
} from "./bookSearch";

/**
 * 夹具是自拟的合成书目，条目形状与 `public/data/books.json` 相同：
 * - 书 id 按预处理 `parse_filename_meta` 的拼法写成「书名-作者」，括号等标点换成 `_`；
 * - 拼音首字母按 `scripts/lib/pinyin.py` 的规则从自拟名推出：逐字取首字母，数字与拉丁字母
 *   原样保留，标点丢弃，统一小写；缩写与原文小写相同时省略该字段。
 * 字数、章数与体积是随手写的，没有断言依赖它们。
 *
 * 检索类断言比的是"谁命中、谁排在前面"，所以几本书之间的关系是按断言逐条构造的：
 * - BOOK_A 与 BOOK_C 的书名共用首字和末两字、只差第二个字（BOOK_C 另有数字前缀）。跳字查询
 *   两本都中，BOOK_A 的命中位置更靠前、排在前面；BOOK_A 缩写的第二个字母在 BOOK_C 的检索串里
 *   根本没有，所以缩写只中 BOOK_A。
 * - BOOK_D 的检索串含 BOOK_F 作者缩写的全部字母，只是次序不同：作者缩写只中 BOOK_F，
 *   靠的是子序列按序匹配。
 * - 除 BOOK_A 与 BOOK_C 有意共用的三个字外，各书之间没有共用的汉字；检索串里也凑不出 `xyz`、
 *   `zzz`、`und` 这几个子序列。
 * - BOOK_E 纯 ASCII，产物里省略了两个 `*Abbr` 字段——它是空缺分支的用例。
 */

/** 纯汉字的书名与作者。 */
const BOOK_A: BookSummary = {
  id: "归舟听雨-墨池钓叟",
  title: "归舟听雨",
  author: "墨池钓叟",
  titleAbbr: "gzty",
  authorAbbr: "mcds",
  charCount: 1260000,
  totalChapters: 420,
  gzSize: 1450000,
};

/** 数字打头的书名。 */
const BOOK_B: BookSummary = {
  id: "1936霜桥问渡-北岭樵夫",
  title: "1936霜桥问渡",
  author: "北岭樵夫",
  titleAbbr: "1936sqwd",
  authorAbbr: "blqf",
  charCount: 980000,
  totalChapters: 310,
  gzSize: 1130000,
};

/** BOOK_A 的近邻：数字前缀之后的书名与 BOOK_A 只差第二个字。 */
const BOOK_C: BookSummary = {
  id: "1987归帆听雨-半山闲人",
  title: "1987归帆听雨",
  author: "半山闲人",
  titleAbbr: "1987gfty",
  authorAbbr: "bsxr",
  charCount: 1530000,
  totalChapters: 505,
  gzSize: 1760000,
};

/** 大写拉丁字母与汉字混排。 */
const BOOK_D: BookSummary = {
  id: "PDF之谜-松下老翁",
  title: "PDF之谜",
  author: "松下老翁",
  titleAbbr: "pdfzm",
  authorAbbr: "sxlw",
  charCount: 640000,
  totalChapters: 212,
  gzSize: 735000,
};

/** 纯 ASCII，无拼音首字母字段。 */
const BOOK_E: BookSummary = {
  id: "QK-QK",
  title: "QK",
  author: "QK",
  charCount: 52000,
  totalChapters: 18,
  gzSize: 61000,
};

/** 书名带括号里的别名：缩写是正名与别名的首字母连写，括号被丢弃。 */
const BOOK_F: BookSummary = {
  id: "长街旧梦录_长街旧闻录_-石磨豆坊",
  title: "长街旧梦录(长街旧闻录)",
  author: "石磨豆坊",
  titleAbbr: "cjjmlcjjwl",
  authorAbbr: "smdf",
  charCount: 2310000,
  totalChapters: 760,
  gzSize: 2650000,
};

const SHELF: BookSummary[] = [BOOK_A, BOOK_B, BOOK_C, BOOK_D, BOOK_E, BOOK_F];
const INDEX = buildSearchIndex(SHELF);

/** 检索一次并取回书名，断言用的都是"谁排在前面"。 */
const titles = (query: string) => searchBooks(INDEX, query).map((b) => b.title);

describe("fuzzyScore", () => {
  it("不命中返 0：缺字符、顺序颠倒都算不命中", () => {
    expect(fuzzyScore("归舟听雨 墨池钓叟 gzty mcds", "xyz")).toBe(0);
    // 子序列要求按序，"听舟" 在 "归舟听雨" 里找不到
    expect(fuzzyScore("归舟听雨", "听舟")).toBe(0);
  });

  it("空查询返 0（空串的处理交给调用方，不是命中）", () => {
    expect(fuzzyScore("归舟听雨", "")).toBe(0);
  });

  it("跳字子序列能命中并给出正分", () => {
    expect(fuzzyScore("归舟听雨", "归听雨")).toBeGreaterThan(0);
    expect(fuzzyScore("归舟听雨 墨池钓叟 gzty mcds", "墨钓叟")).toBeGreaterThan(0);
  });

  it("连续命中分高于分散命中", () => {
    expect(fuzzyScore("归舟听雨", "归舟")).toBeGreaterThan(
      fuzzyScore("归三四舟听雨", "归舟"),
    );
  });

  it("连击越长加权越高：完整子串远高于同长度的跳字命中", () => {
    const contiguous = fuzzyScore("pdf之谜 松下老翁 pdfzm sxlw", "pdfzm");
    const scattered = fuzzyScore("p1d2f3z4m5", "pdfzm");
    expect(contiguous).toBeGreaterThan(scattered);
  });

  it("间隔扣分但扣到 4 个字符为止，长书名里的命中不会被压成负分", () => {
    const long = `${"舟".repeat(400)}雨`;
    expect(fuzzyScore(long, "雨")).toBeGreaterThan(0);
  });

  it("单字符命中的最低分仍大于 0，与不命中的 0 不相撞", () => {
    expect(fuzzyScore("舟舟舟舟舟雨", "雨")).toBeGreaterThan(0);
  });
});

describe("buildHaystack", () => {
  it("拼成「书名 作者 书名拼音 作者拼音」且全部小写", () => {
    expect(buildHaystack(BOOK_A)).toBe("归舟听雨 墨池钓叟 gzty mcds");
    expect(buildHaystack(BOOK_D)).toBe("pdf之谜 松下老翁 pdfzm sxlw");
  });

  it("缺拼音字段时不把 undefined 拼进检索串", () => {
    expect(buildHaystack(BOOK_E)).toBe("qk qk");
    expect(buildHaystack(BOOK_E)).not.toContain("undefined");
  });

  it("缺拼音字段的书不会被 undefined 里的字母误命中", () => {
    // 曾经的坑：模板字符串直接插入缺失字段，"und" 会匹配到每一本没有拼音的书
    expect(titles("und")).toEqual([]);
    expect(titles("undefined")).toEqual([]);
  });
});

describe("splitQuery", () => {
  it("按空白拆词并小写化，忽略多余空白", () => {
    expect(splitQuery("  GZTY   墨钓叟 ")).toEqual(["gzty", "墨钓叟"]);
  });

  it("空串与纯空白得到空词表", () => {
    expect(splitQuery("")).toEqual([]);
    expect(splitQuery("   ")).toEqual([]);
  });
});

describe("scoreHaystack", () => {
  it("多词分数求和，比单词得分更高", () => {
    const hay = buildHaystack(BOOK_A);
    expect(scoreHaystack(hay, ["归舟", "钓叟"])).toBeCloseTo(
      fuzzyScore(hay, "归舟") + fuzzyScore(hay, "钓叟"),
    );
    expect(scoreHaystack(hay, ["归舟", "钓叟"])).toBeGreaterThan(
      scoreHaystack(hay, ["归舟"]),
    );
  });

  it("任一词落空即整体不命中", () => {
    expect(scoreHaystack(buildHaystack(BOOK_A), ["归舟", "xyz"])).toBe(0);
  });
});

describe("searchBooks", () => {
  it("跳字匹配书名：「归听雨」找到《归舟听雨》并排在最前", () => {
    const found = titles("归听雨");
    expect(found[0]).toBe("归舟听雨");
    expect(found).toContain("1987归帆听雨");
  });

  it("跳字匹配书名：「霜问渡」找到《1936霜桥问渡》", () => {
    expect(titles("霜问渡")).toEqual(["1936霜桥问渡"]);
  });

  it("跳字匹配作者：「墨钓叟」找到墨池钓叟的书", () => {
    expect(titles("墨钓叟")).toEqual(["归舟听雨"]);
  });

  it("中英混排也能跳字：「pdf谜」找到《PDF之谜》", () => {
    expect(titles("pdf谜")).toEqual(["PDF之谜"]);
  });

  it("拼音首字母：「gzty」找到《归舟听雨》，不误中《1987归帆听雨》", () => {
    expect(titles("gzty")).toEqual(["归舟听雨"]);
  });

  it("拼音首字母匹配作者与别名：「cjjml」「smdf」都找到同一本", () => {
    expect(titles("cjjml")).toEqual(["长街旧梦录(长街旧闻录)"]);
    expect(titles("smdf")).toEqual(["长街旧梦录(长街旧闻录)"]);
  });

  it("多词按空白拆分，要求每词都命中", () => {
    expect(titles("归 钓叟")).toEqual(["归舟听雨"]);
    // 第二个词无处可寻，整条查询不命中
    expect(titles("归舟 xyz")).toEqual([]);
  });

  it("完全不命中时返回空列表", () => {
    expect(titles("zzz")).toEqual([]);
  });

  it("空查询返回全部书籍，保持产物原序", () => {
    expect(searchBooks(INDEX, "")).toEqual(SHELF);
    expect(searchBooks(INDEX, "   ")).toEqual(SHELF);
  });

  it("结果按分数降序：连续命中的书排在跳字命中的书前面", () => {
    const found = titles("听雨");
    expect(found).toEqual(["归舟听雨", "1987归帆听雨"]);
  });

  it("同分条目保持产物原序（排序需稳定）", () => {
    const twins: BookSummary[] = [
      { ...BOOK_E, id: "QK-A", author: "A" },
      { ...BOOK_E, id: "QK-B", author: "B" },
      { ...BOOK_E, id: "QK-C", author: "C" },
    ];
    expect(searchBooks(buildSearchIndex(twins), "qk").map((b) => b.id)).toEqual([
      "QK-A",
      "QK-B",
      "QK-C",
    ]);
  });

  it("空书架不炸", () => {
    expect(searchBooks(buildSearchIndex([]), "归舟")).toEqual([]);
  });
});

describe("isFilterableAuthor", () => {
  it("正常作者名可筛", () => {
    expect(isFilterableAuthor("墨池钓叟")).toBe(true);
    expect(isFilterableAuthor("QK")).toBe(true);
  });

  it("佚名不可筛：它是「作者未知」而不是一个作者", () => {
    expect(isFilterableAuthor(UNKNOWN_AUTHOR)).toBe(false);
    expect(isFilterableAuthor(` ${UNKNOWN_AUTHOR} `)).toBe(false);
  });

  it("空值与纯空白不可筛", () => {
    expect(isFilterableAuthor("")).toBe(false);
    expect(isFilterableAuthor("   ")).toBe(false);
    expect(isFilterableAuthor(null)).toBe(false);
    expect(isFilterableAuthor(undefined)).toBe(false);
  });
});

describe("filterByAuthor", () => {
  /** 同一作者的第二本，用来断言"全部作品"而不是"被点的那一本"。 */
  const BOOK_A2: BookSummary = { ...BOOK_A, id: "另一本-墨池钓叟", title: "另一本" };
  const ANON_A: BookSummary = {
    ...BOOK_E,
    id: `甲-${UNKNOWN_AUTHOR}`,
    title: "甲",
    author: UNKNOWN_AUTHOR,
  };
  const ANON_B: BookSummary = {
    ...BOOK_E,
    id: `乙-${UNKNOWN_AUTHOR}`,
    title: "乙",
    author: UNKNOWN_AUTHOR,
  };
  const SHELF2: BookSummary[] = [BOOK_A, BOOK_B, BOOK_A2, ANON_A, ANON_B];

  it("筛出该作者的全部作品，保持输入顺序", () => {
    expect(filterByAuthor(SHELF2, "墨池钓叟").map((b) => b.id)).toEqual([
      "归舟听雨-墨池钓叟",
      "另一本-墨池钓叟",
    ]);
  });

  it("无筛选（null / 空串）时原样返回", () => {
    expect(filterByAuthor(SHELF2, null)).toBe(SHELF2);
    expect(filterByAuthor(SHELF2, "")).toBe(SHELF2);
  });

  it("精确相等，不做模糊也不做前缀匹配", () => {
    expect(filterByAuthor(SHELF2, "墨池")).toEqual([]);
    expect(filterByAuthor(SHELF2, "墨池钓叟2")).toEqual([]);
    expect(filterByAuthor(SHELF2, "北岭樵夫").map((b) => b.title)).toEqual(["1936霜桥问渡"]);
  });

  it("和检索词是 AND：两个条件同时收窄", () => {
    const index = buildSearchIndex(SHELF2);
    // 作者下的两本书，检索词只留下一本
    expect(filterByAuthor(searchBooks(index, "归舟"), "墨池钓叟").map((b) => b.title)).toEqual([
      "归舟听雨",
    ]);
    // 检索命中的书不属于该作者时，交集为空
    expect(filterByAuthor(searchBooks(index, "霜问渡"), "墨池钓叟")).toEqual([]);
  });

  it("空书架不炸", () => {
    expect(filterByAuthor([], "墨池钓叟")).toEqual([]);
  });
});
