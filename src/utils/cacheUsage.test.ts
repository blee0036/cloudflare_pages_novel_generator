import { describe, expect, it } from "vitest";
import { CachedBookMeta } from "./indexedDB";
import { formatByteSize, summarizeCacheUsage } from "./cacheUsage";

/** 造一条元数据；`bytes` 用 unknown 是为了能塞脏值——真实记录能穿过存储层带 NaN 进来。 */
function meta(bookId: string, bytes: unknown): CachedBookMeta {
  return { bookId, bytes: bytes as number, lastAccess: 1700000000000, cachedAt: 1700000000000 };
}

describe("summarizeCacheUsage", () => {
  it("空列表汇总为 0 本 0 字节", () => {
    expect(summarizeCacheUsage([])).toEqual({ count: 0, bytes: 0 });
  });

  it("按真实藏书的 gz 体积求和（附录 M1 的三本）", () => {
    const usage = summarizeCacheUsage([
      meta("从零开始-雷云风暴", 23446937),
      meta("1852铁血中华-绯红之月", 5725224),
      meta("BUG之神-耳火大帝", 2002780),
    ]);

    expect(usage.count).toBe(3);
    expect(usage.bytes).toBe(23446937 + 5725224 + 2002780);
  });

  it("脏 bytes 只丢掉自己的字节贡献，本数仍如实计入", () => {
    // NaN 能穿过 cacheMetaFromIndexKey 的 typeof 检查；直接相加会让总数整体变成 NaN
    const usage = summarizeCacheUsage([
      meta("好记录", 1024),
      meta("NaN 记录", Number.NaN),
      meta("负数记录", -4096),
      meta("字符串记录", "1024"),
    ]);

    expect(usage.count).toBe(4);
    expect(usage.bytes).toBe(1024);
  });
});

describe("formatByteSize", () => {
  it("按量级换单位，一位小数，与书架卡片的写法一致", () => {
    expect(formatByteSize(0)).toBe("0B");
    expect(formatByteSize(512)).toBe("512B");
    expect(formatByteSize(1536)).toBe("1.5KB");
    expect(formatByteSize(23446937)).toBe("22.4MB");
    expect(formatByteSize(1288490189)).toBe("1.2GB");
  });

  it("单位边界取下一档而非 1024 前缀", () => {
    expect(formatByteSize(1023)).toBe("1023B");
    expect(formatByteSize(1024)).toBe("1.0KB");
    expect(formatByteSize(1024 * 1024)).toBe("1.0MB");
  });

  it("非法值与负数当 0B，不显示 n/a", () => {
    expect(formatByteSize(Number.NaN)).toBe("0B");
    expect(formatByteSize(-1)).toBe("0B");
  });
});
