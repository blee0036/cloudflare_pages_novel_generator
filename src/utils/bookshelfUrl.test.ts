import { describe, expect, it } from "vitest";
import {
  TOC_BOOK_PARAM,
  readTocBookId,
  withTocBookId,
  withoutTocBookId,
} from "./bookshelfUrl";

/**
 * book id 的实际形态（design §2.2：`书名-作者`；样例均为自拟），外加几个只在理论上会出现但
 * 一旦出现就会把手写拼串的实现打穿的形状。
 */
const IDS = [
  "青石巷-夜行",
  "QX-QX",
  "竹影听潮-夹具作者乙",
  "带 空格的书-作者",
  "带&号与=号-作者",
  "带#号-作者",
  "百分号%20不是空格-作者",
  "带+号-作者",
  "重名书-作者-2",
];

describe("readTocBookId", () => {
  it("没有参数时弹窗关闭", () => {
    expect(readTocBookId("")).toBeNull();
    expect(readTocBookId("?")).toBeNull();
    expect(readTocBookId("?q=青石&author=夜行")).toBeNull();
  });

  it("读出 id，前导 ? 可有可无", () => {
    expect(readTocBookId("?book=abc")).toBe("abc");
    expect(readTocBookId("book=abc")).toBe("abc");
    expect(readTocBookId(new URLSearchParams({ book: "abc" }))).toBe("abc");
  });

  it("空值与纯空白视同缺失，不会交出一个查不到的空 id", () => {
    expect(readTocBookId("?book=")).toBeNull();
    expect(readTocBookId("?book=%20%20")).toBeNull();
    expect(readTocBookId("?book=+")).toBeNull();
  });

  it("重复参数取第一个，与 URLSearchParams.get 同口径", () => {
    expect(readTocBookId("?book=a&book=b")).toBe("a");
  });

  it("百分号编码被解回原始 id", () => {
    expect(readTocBookId("?book=%E9%9D%92%E7%9F%B3%E5%B7%B7-%E5%A4%9C%E8%A1%8C")).toBe(
      "青石巷-夜行",
    );
  });
});

describe("withTocBookId", () => {
  it("写进去的 id 都能原样读回来（含中文与保留字符）", () => {
    for (const id of IDS) {
      expect(readTocBookId(withTocBookId("", id))).toBe(id);
      // 已有其他参数时同样成立
      expect(readTocBookId(withTocBookId("?q=x", id))).toBe(id);
    }
  });

  it("保留其他参数", () => {
    const next = withTocBookId("?q=青石&page=3", "青石巷-夜行");
    const params = new URLSearchParams(next);
    expect(params.get("q")).toBe("青石");
    expect(params.get("page")).toBe("3");
    expect(params.get(TOC_BOOK_PARAM)).toBe("青石巷-夜行");
  });

  it("换书是覆盖，不是追加第二个 book", () => {
    const next = withTocBookId("?book=a", "b");
    expect(new URLSearchParams(next).getAll(TOC_BOOK_PARAM)).toEqual(["b"]);
    expect(readTocBookId(next)).toBe("b");
  });

  it("空 id 等同于关闭弹窗", () => {
    expect(withTocBookId("?book=a", "")).toBe("");
    expect(withTocBookId("?book=a&q=x", "   ")).toBe("q=x");
  });

  it("同一个 id 写两次得到同一个查询串（幂等，可用于跳过多余导航）", () => {
    const once = withTocBookId("?q=x", "青石巷-夜行");
    expect(withTocBookId(once, "青石巷-夜行")).toBe(once);
  });

  it("不改动传入的 URLSearchParams 实例（Hook 缓存的那个不能被就地改）", () => {
    const params = new URLSearchParams("q=x");
    withTocBookId(params, "青石巷-夜行");
    expect(params.has(TOC_BOOK_PARAM)).toBe(false);
    expect(params.toString()).toBe("q=x");
  });
});

describe("withoutTocBookId", () => {
  it("移除参数后读回 null", () => {
    expect(readTocBookId(withoutTocBookId("?book=青石巷-夜行"))).toBeNull();
  });

  it("只剩这一个参数时得到空串，交给 setSearchParams 后地址栏落回 /", () => {
    expect(withoutTocBookId("?book=a")).toBe("");
    expect(withoutTocBookId("")).toBe("");
  });

  it("保留其他参数", () => {
    expect(withoutTocBookId("?q=x&book=a&page=3")).toBe("q=x&page=3");
  });

  it("重复参数被一并清掉", () => {
    expect(withoutTocBookId("?book=a&book=b")).toBe("");
  });

  it("幂等：没有参数时再移除一次不变", () => {
    const once = withoutTocBookId("?q=x&book=a");
    expect(withoutTocBookId(once)).toBe(once);
  });

  it("不改动传入的 URLSearchParams 实例", () => {
    const params = new URLSearchParams("book=a&q=x");
    withoutTocBookId(params);
    expect(params.get(TOC_BOOK_PARAM)).toBe("a");
  });
});

describe("开关一轮之后 URL 回到原样", () => {
  it("打开再关闭不残留任何痕迹", () => {
    for (const search of ["", "?q=青石", "?q=青石&page=3"]) {
      const opened = withTocBookId(search, "青石巷-夜行");
      const closed = withoutTocBookId(opened);
      expect(closed).toBe(new URLSearchParams(search).toString());
    }
  });
});
