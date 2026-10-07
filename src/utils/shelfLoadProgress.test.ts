import { describe, expect, it } from "vitest";
import { INDETERMINATE } from "./loadProgress";
import { formatReceived, readShelfLoad, sameShelfLoad } from "./shelfLoadProgress";

/** 书架加载遮罩的读数：三种到达方式各自的进度条形态与说明（`shelfLoadProgress.ts`）。 */

describe("formatReceived", () => {
  it.each<[number, string]>([
    [0, "0 KB"],
    [400, "0 KB"],
    [512, "1 KB"],
    [319_488, "312 KB"],
    [1024 * 1024 - 1, "1024 KB"],
    [1024 * 1024, "1.0 MB"],
    [1_887_437, "1.8 MB"],
    [-5, "0 KB"],
    [Number.NaN, "0 KB"],
  ])("%d 字节 → %s", (bytes, text) => {
    expect(formatReceived(bytes)).toBe(text);
  });
});

describe("readShelfLoad", () => {
  it("响应还没到：循环态，正在连接", () => {
    expect(readShelfLoad(null)).toEqual({ bar: INDETERMINATE, note: "正在连接书库…" });
  });

  it("知道总长：确定态，说明写百分比", () => {
    expect(readShelfLoad({ received: 450, total: 1000 })).toEqual({
      bar: { kind: "determinate", pct: 45 },
      note: "已载入 45%",
    });
  });

  it("收到的比声明的多（Content-Length 被代理改短）：停在 100%，不报 103%", () => {
    expect(readShelfLoad({ received: 1030, total: 1000 }).note).toBe("已载入 100%");
  });

  it("不知道总长（线上传输压缩）：循环态，说明写已收字节数而不是 0%", () => {
    expect(readShelfLoad({ received: 319_488, total: null })).toEqual({
      bar: INDETERMINATE,
      note: "已载入 312 KB",
    });
  });
});

describe("sameShelfLoad", () => {
  it("显示一样就算一样：同一个 KB 数、同一个百分比", () => {
    expect(sameShelfLoad({ received: 319_000, total: null }, { received: 319_400, total: null })).toBe(true);
    expect(sameShelfLoad({ received: 451, total: 1000 }, { received: 449, total: 1000 })).toBe(true);
  });

  it("显示变了就不一样", () => {
    expect(sameShelfLoad({ received: 300_000, total: null }, { received: 330_000, total: null })).toBe(false);
    expect(sameShelfLoad({ received: 450, total: 1000 }, { received: 470, total: 1000 })).toBe(false);
    expect(sameShelfLoad(null, { received: 0, total: null })).toBe(false);
    expect(sameShelfLoad(null, null)).toBe(true);
  });
});
