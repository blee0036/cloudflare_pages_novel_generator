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
 * 夹具取自 `public/data/books.json` 的真实条目（拼音首字母即构建期 `pypinyin` 的产物），
 * 因为需求 5.3–5.5 举的例子（"从开始"、"clks"）只有在真实书名/拼音下才说明问题。
 * 《NB-NB》纯 ASCII，产物里省略了两个 `*Abbr` 字段——它是空缺分支的用例。
 */
const CLKS: BookSummary = {
  id: "从零开始-雷云风暴",
  title: "从零开始",
  author: "雷云风暴",
  titleAbbr: "clks",
  authorAbbr: "lyfb",
  charCount: 20532902,
  totalChapters: 3224,
  gzSize: 23448372,
};

const TXZH: BookSummary = {
  id: "1852铁血中华-绯红之月",
  title: "1852铁血中华",
  author: "绯红之月",
  titleAbbr: "1852txzh",
  authorAbbr: "fhzy",
  charCount: 4814326,
  totalChapters: 1395,
  gzSize: 5725736,
};

const CXKS: BookSummary = {
  id: "1991从芯开始-三分糊涂",
  title: "1991从芯开始",
  author: "三分糊涂",
  titleAbbr: "1991cxks",
  authorAbbr: "sfht",
  charCount: 3145587,
  totalChapters: 1025,
  gzSize: 3607101,
};

const BUGZS: BookSummary = {
  id: "BUG之神-耳火大帝",
  title: "BUG之神",
  author: "耳火大帝",
  titleAbbr: "bugzs",
  authorAbbr: "ehdd",
  charCount: 1842177,
  totalChapters: 660,
  gzSize: 2002877,
};

/** 纯 ASCII，无拼音首字母字段。 */
const NB: BookSummary = {
  id: "NB-NB",
  title: "NB",
  author: "NB",
  charCount: 1800239,
  totalChapters: 413,
  gzSize: 2191523,
};

const JPQNGS: BookSummary = {
  id: "极品全能高手(极品全能学生)-花都大少",
  title: "极品全能高手(极品全能学生)",
  author: "花都大少",
  titleAbbr: "jpqngsjpqnxs",
  authorAbbr: "hdds",
  charCount: 28476914,
  totalChapters: 4000,
  gzSize: 24267696,
};

const SHELF: BookSummary[] = [CLKS, TXZH, CXKS, BUGZS, NB, JPQNGS];
const INDEX = buildSearchIndex(SHELF);

/** 检索一次并取回书名，断言用的都是"谁排在前面"。 */
const titles = (query: string) => searchBooks(INDEX, query).map((b) => b.title);

describe("fuzzyScore", () => {
  it("不命中返 0：缺字符、顺序颠倒都算不命中", () => {
    expect(fuzzyScore("从零开始 雷云风暴 clks lyfb", "xyz")).toBe(0);
    // 子序列要求按序，"开零" 在 "从零开始" 里找不到
    expect(fuzzyScore("从零开始", "开零")).toBe(0);
  });

  it("空查询返 0（空串的处理交给调用方，不是命中）", () => {
    expect(fuzzyScore("从零开始", "")).toBe(0);
  });

  it("跳字子序列能命中并给出正分", () => {
    expect(fuzzyScore("从零开始", "从开始")).toBeGreaterThan(0);
    expect(fuzzyScore("从零开始 雷云风暴 clks lyfb", "雷风暴")).toBeGreaterThan(0);
  });

  it("连续命中分高于分散命中", () => {
    expect(fuzzyScore("从零开始", "从零")).toBeGreaterThan(
      fuzzyScore("从一二零开始", "从零"),
    );
  });

  it("连击越长加权越高：完整子串远高于同长度的跳字命中", () => {
    const contiguous = fuzzyScore("bug之神 耳火大帝 bugzs ehdd", "bugzs");
    const scattered = fuzzyScore("b1u2g3z4s5", "bugzs");
    expect(contiguous).toBeGreaterThan(scattered);
  });

  it("间隔扣分但扣到 4 个字符为止，长书名里的命中不会被压成负分", () => {
    const long = `${"零".repeat(400)}始`;
    expect(fuzzyScore(long, "始")).toBeGreaterThan(0);
  });

  it("单字符命中的最低分仍大于 0，与不命中的 0 不相撞", () => {
    expect(fuzzyScore("零零零零零始", "始")).toBeGreaterThan(0);
  });
});

describe("buildHaystack", () => {
  it("拼成「书名 作者 书名拼音 作者拼音」且全部小写", () => {
    expect(buildHaystack(CLKS)).toBe("从零开始 雷云风暴 clks lyfb");
    expect(buildHaystack(BUGZS)).toBe("bug之神 耳火大帝 bugzs ehdd");
  });

  it("缺拼音字段时不把 undefined 拼进检索串", () => {
    expect(buildHaystack(NB)).toBe("nb nb");
    expect(buildHaystack(NB)).not.toContain("undefined");
  });

  it("缺拼音字段的书不会被 undefined 里的字母误命中", () => {
    // 曾经的坑：模板字符串直接插入缺失字段，"und" 会匹配到每一本没有拼音的书
    expect(titles("und")).toEqual([]);
    expect(titles("undefined")).toEqual([]);
  });
});

describe("splitQuery", () => {
  it("按空白拆词并小写化，忽略多余空白", () => {
    expect(splitQuery("  CLKS   雷风暴 ")).toEqual(["clks", "雷风暴"]);
  });

  it("空串与纯空白得到空词表", () => {
    expect(splitQuery("")).toEqual([]);
    expect(splitQuery("   ")).toEqual([]);
  });
});

describe("scoreHaystack", () => {
  it("多词分数求和，比单词得分更高", () => {
    const hay = buildHaystack(CLKS);
    expect(scoreHaystack(hay, ["从零", "风暴"])).toBeCloseTo(
      fuzzyScore(hay, "从零") + fuzzyScore(hay, "风暴"),
    );
    expect(scoreHaystack(hay, ["从零", "风暴"])).toBeGreaterThan(
      scoreHaystack(hay, ["从零"]),
    );
  });

  it("任一词落空即整体不命中", () => {
    expect(scoreHaystack(buildHaystack(CLKS), ["从零", "xyz"])).toBe(0);
  });
});

describe("searchBooks", () => {
  it("跳字匹配书名：「从开始」找到《从零开始》并排在最前", () => {
    const found = titles("从开始");
    expect(found[0]).toBe("从零开始");
    expect(found).toContain("1991从芯开始");
  });

  it("跳字匹配书名：「铁中华」找到《1852铁血中华》", () => {
    expect(titles("铁中华")).toEqual(["1852铁血中华"]);
  });

  it("跳字匹配作者：「雷风暴」找到雷云风暴的书", () => {
    expect(titles("雷风暴")).toEqual(["从零开始"]);
  });

  it("中英混排也能跳字：「bug神」找到《BUG之神》", () => {
    expect(titles("bug神")).toEqual(["BUG之神"]);
  });

  it("拼音首字母：「clks」找到《从零开始》，不误中《1991从芯开始》", () => {
    expect(titles("clks")).toEqual(["从零开始"]);
  });

  it("拼音首字母匹配作者与别名：「jpqngs」「hdds」都找到同一本", () => {
    expect(titles("jpqngs")).toEqual(["极品全能高手(极品全能学生)"]);
    expect(titles("hdds")).toEqual(["极品全能高手(极品全能学生)"]);
  });

  it("多词按空白拆分，要求每词都命中", () => {
    expect(titles("从 风暴")).toEqual(["从零开始"]);
    // 第二个词无处可寻，整条查询不命中
    expect(titles("从零 xyz")).toEqual([]);
  });

  it("完全不命中时返回空列表", () => {
    expect(titles("zzz")).toEqual([]);
  });

  it("空查询返回全部书籍，保持产物原序", () => {
    expect(searchBooks(INDEX, "")).toEqual(SHELF);
    expect(searchBooks(INDEX, "   ")).toEqual(SHELF);
  });

  it("结果按分数降序：连续命中的书排在跳字命中的书前面", () => {
    const found = titles("开始");
    expect(found).toEqual(["从零开始", "1991从芯开始"]);
  });

  it("同分条目保持产物原序（排序需稳定）", () => {
    const twins: BookSummary[] = [
      { ...NB, id: "NB-A", author: "A" },
      { ...NB, id: "NB-B", author: "B" },
      { ...NB, id: "NB-C", author: "C" },
    ];
    expect(searchBooks(buildSearchIndex(twins), "nb").map((b) => b.id)).toEqual([
      "NB-A",
      "NB-B",
      "NB-C",
    ]);
  });

  it("空书架不炸", () => {
    expect(searchBooks(buildSearchIndex([]), "从零")).toEqual([]);
  });
});

describe("isFilterableAuthor", () => {
  it("正常作者名可筛", () => {
    expect(isFilterableAuthor("雷云风暴")).toBe(true);
    expect(isFilterableAuthor("NB")).toBe(true);
  });

  it("佚名不可筛：它是「作者未知」而不是一个作者", () => {
    expect(isFilterableAuthor(UNKNOWN_AUTHOR)).toBe(false);
    expect(isFilterableAuthor(" 佚名 ")).toBe(false);
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
  const CLKS2: BookSummary = { ...CLKS, id: "另一本-雷云风暴", title: "另一本" };
  const ANON_A: BookSummary = { ...NB, id: "甲-佚名", title: "甲", author: UNKNOWN_AUTHOR };
  const ANON_B: BookSummary = { ...NB, id: "乙-佚名", title: "乙", author: UNKNOWN_AUTHOR };
  const SHELF2: BookSummary[] = [CLKS, TXZH, CLKS2, ANON_A, ANON_B];

  it("筛出该作者的全部作品，保持输入顺序", () => {
    expect(filterByAuthor(SHELF2, "雷云风暴").map((b) => b.id)).toEqual([
      "从零开始-雷云风暴",
      "另一本-雷云风暴",
    ]);
  });

  it("无筛选（null / 空串）时原样返回", () => {
    expect(filterByAuthor(SHELF2, null)).toBe(SHELF2);
    expect(filterByAuthor(SHELF2, "")).toBe(SHELF2);
  });

  it("精确相等，不做模糊也不做前缀匹配", () => {
    expect(filterByAuthor(SHELF2, "雷云")).toEqual([]);
    expect(filterByAuthor(SHELF2, "雷云风暴2")).toEqual([]);
    expect(filterByAuthor(SHELF2, "绯红之月").map((b) => b.title)).toEqual(["1852铁血中华"]);
  });

  it("和检索词是 AND：两个条件同时收窄", () => {
    const index = buildSearchIndex(SHELF2);
    // 作者下的两本书，检索词只留下一本
    expect(filterByAuthor(searchBooks(index, "从零"), "雷云风暴").map((b) => b.title)).toEqual([
      "从零开始",
    ]);
    // 检索命中的书不属于该作者时，交集为空
    expect(filterByAuthor(searchBooks(index, "铁中华"), "雷云风暴")).toEqual([]);
  });

  it("空书架不炸", () => {
    expect(filterByAuthor([], "雷云风暴")).toEqual([]);
  });
});
