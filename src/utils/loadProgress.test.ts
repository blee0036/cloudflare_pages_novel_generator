import { describe, expect, it } from "vitest";
import {
  INDETERMINATE,
  LoadProgress,
  deriveLoadProgress,
  sameLoadProgress,
} from "./loadProgress";

/** 自拟的大书 gz 字节数（约 20.6 MiB）：进度条真正要走的那条量级。 */
const BIGGEST_GZ = 20.6 * 1024 * 1024;

describe("deriveLoadProgress", () => {
  it("分母可用时给出四舍五入的整数百分比", () => {
    expect(deriveLoadProgress(50, 200)).toEqual({ kind: "determinate", pct: 25 });
    // 33.333… → 33，而不是一个会被当宽度用的小数
    expect(deriveLoadProgress(1, 3)).toEqual({ kind: "determinate", pct: 33 });
  });

  it("缺 content-length（total 0）时是不确定态，不是 0%", () => {
    // 这条就是需求 10.5 的第一条路径：分母未知 ≠ 进度为零
    expect(deriveLoadProgress(1024, 0)).toBe(INDETERMINATE);
  });

  it("分母为负或非有限数时同样不确定，不产出荒谬百分比", () => {
    expect(deriveLoadProgress(1024, -1)).toBe(INDETERMINATE);
    expect(deriveLoadProgress(1024, Number.NaN)).toBe(INDETERMINATE);
    expect(deriveLoadProgress(1024, Number.POSITIVE_INFINITY)).toBe(INDETERMINATE);
  });

  it("分子非有限数时不确定，不返回 NaN%", () => {
    expect(deriveLoadProgress(Number.NaN, 100)).toBe(INDETERMINATE);
  });

  it("分子超过分母时钳在 100%：content-length 被代理改短过也不会报出 103%", () => {
    expect(deriveLoadProgress(300, 200)).toEqual({ kind: "determinate", pct: 100 });
  });

  it("分子为负时钳在 0%", () => {
    expect(deriveLoadProgress(-5, 200)).toEqual({ kind: "determinate", pct: 0 });
  });

  it("分母已知而一个字节都没到时是确定的 0%——与不确定态是两回事", () => {
    expect(deriveLoadProgress(0, 200)).toEqual({ kind: "determinate", pct: 0 });
  });

  it("满载给出恰好 100%", () => {
    expect(deriveLoadProgress(BIGGEST_GZ, BIGGEST_GZ)).toEqual({
      kind: "determinate",
      pct: 100,
    });
  });

  it("最大书那条量级上：百分比随到达字节单调不减且恒在 0–100 内", () => {
    // 按 64KB 分片扫一遍这条量级，逐位验证——差一位与溢出在这里才暴露得出来
    const chunk = 64 * 1024;
    let prev = 0;

    for (let loaded = 0; loaded <= BIGGEST_GZ; loaded += chunk) {
      const progress = deriveLoadProgress(loaded, BIGGEST_GZ);
      expect(progress.kind).toBe("determinate");
      if (progress.kind !== "determinate") return;

      expect(progress.pct).toBeGreaterThanOrEqual(prev);
      expect(progress.pct).toBeLessThanOrEqual(100);
      prev = progress.pct;
    }

    expect(prev).toBe(100);
  });
});

describe("INDETERMINATE", () => {
  it("是同一个实例：React 靠引用相等跳过重渲染", () => {
    expect(deriveLoadProgress(1, 0)).toBe(deriveLoadProgress(999, 0));
  });

  it("冻结，改不坏共享单例", () => {
    expect(Object.isFrozen(INDETERMINATE)).toBe(true);
  });
});

describe("sameLoadProgress", () => {
  it("两个不确定态视为同一状态", () => {
    expect(sameLoadProgress(INDETERMINATE, { kind: "indeterminate" })).toBe(true);
  });

  it("确定与不确定不同，两个方向都要判出来", () => {
    const determinate: LoadProgress = { kind: "determinate", pct: 100 };
    expect(sameLoadProgress(INDETERMINATE, determinate)).toBe(false);
    expect(sameLoadProgress(determinate, INDETERMINATE)).toBe(false);
  });

  it("同百分比按取值相等，尽管每次上报都是新对象", () => {
    expect(sameLoadProgress(deriveLoadProgress(1, 3), deriveLoadProgress(1, 3))).toBe(true);
  });

  it("百分比不同即不同", () => {
    expect(sameLoadProgress(deriveLoadProgress(1, 3), deriveLoadProgress(2, 3))).toBe(false);
  });

  it("相邻字节大多落在同一个百分比上——这正是它要拦掉的重渲染", () => {
    const a = deriveLoadProgress(BIGGEST_GZ / 2, BIGGEST_GZ);
    const b = deriveLoadProgress(BIGGEST_GZ / 2 + 64 * 1024, BIGGEST_GZ);
    expect(sameLoadProgress(a, b)).toBe(true);
  });
});
