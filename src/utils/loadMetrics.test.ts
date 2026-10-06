import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BookLoadMetrics,
  LOAD_LOG_PREFIX,
  formatBookLoadMetrics,
  nowMs,
  reportBookLoad,
} from "./loadMetrics";

/** 一本大书的读数（自拟值）：18.34MB gz / 1699 万字 / 98ms 解压。 */
const BIGGEST: BookLoadMetrics = {
  bookId: "青石巷-夜行",
  source: "network",
  gzBytes: 19234567,
  chars: 16987654,
  decompressMs: 98,
  totalMs: 1175,
};

describe("formatBookLoadMetrics", () => {
  it("把三项指标都写进一行，字段名固定", () => {
    expect(formatBookLoadMetrics(BIGGEST)).toBe(
      `${LOAD_LOG_PREFIX} 青石巷-夜行 source=network gz=18.34MB ` +
        `chars=16987654 decompress=98ms total=1175ms`,
    );
  });

  it("观测不到的字段写 n/a，不用 0 冒充", () => {
    const line = formatBookLoadMetrics({
      ...BIGGEST,
      source: "memory",
      gzBytes: null,
      decompressMs: null,
      totalMs: 0.4,
    });

    expect(line).toContain("gz=n/a");
    expect(line).toContain("decompress=n/a");
    // 亚毫秒取整为 0ms：这条链路不需要更高精度
    expect(line).toContain("total=0ms");
  });

  it("gz=0 与 gz 未知是两回事，不能显示成同一个值", () => {
    expect(formatBookLoadMetrics({ ...BIGGEST, gzBytes: 0 })).toContain("gz=0B");
    expect(formatBookLoadMetrics({ ...BIGGEST, gzBytes: null })).toContain("gz=n/a");
  });

  it("字节数按量级换单位", () => {
    const gz = (bytes: number) =>
      formatBookLoadMetrics({ ...BIGGEST, gzBytes: bytes }).match(/gz=(\S+)/)![1];

    expect(gz(512)).toBe("512B");
    expect(gz(1024)).toBe("1.00KB");
    expect(gz(1024 * 1024)).toBe("1.00MB");
    expect(gz(1024 * 1024 - 1)).toMatch(/KB$/);
  });

  it("任何来源分支都能格式化出完整字段，不会漏项", () => {
    const sources = [
      "memory",
      "indexeddb",
      "network",
      "network-transparent",
    ] as const;

    for (const source of sources) {
      const line = formatBookLoadMetrics({ ...BIGGEST, source });
      expect(line).toContain(`source=${source}`);
      for (const field of ["gz=", "chars=", "decompress=", "total="]) {
        expect(line).toContain(field);
      }
    }
  });
});

describe("nowMs", () => {
  it("返回单调递增的毫秒读数", () => {
    const a = nowMs();
    const b = nowMs();
    expect(typeof a).toBe("number");
    expect(b).toBeGreaterThanOrEqual(a);
  });
});

describe("reportBookLoad", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("以 info 级别打出格式化后的那一行", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});

    reportBookLoad(BIGGEST);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(formatBookLoadMetrics(BIGGEST));
  });

  it("宿主的 console / performance 抛错时也不把异常带给加载流程", () => {
    vi.spyOn(console, "info").mockImplementation(() => {
      throw new Error("console 被禁用");
    });

    expect(() => reportBookLoad({ ...BIGGEST, startedAt: nowMs() })).not.toThrow();
  });

  it("带 startedAt 时落一条同名 performance 区间", () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const measure = vi.spyOn(performance, "measure");

    const startedAt = nowMs();
    reportBookLoad({ ...BIGGEST, startedAt });

    expect(measure).toHaveBeenCalledWith(
      "book-load:青石巷-夜行:network",
      expect.objectContaining({ start: startedAt, duration: BIGGEST.totalMs }),
    );
  });

  it("没有 startedAt 时只打日志，不落时间轴", () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const measure = vi.spyOn(performance, "measure");

    reportBookLoad(BIGGEST);

    expect(measure).not.toHaveBeenCalled();
  });
});
