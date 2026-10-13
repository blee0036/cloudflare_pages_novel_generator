import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  TAP_ZONE_SPLIT_1,
  TAP_ZONE_SPLIT_2,
  tapAction,
  tapZone,
  type TapZone,
  type TapZoneAction,
} from "./tapZone";

const COLS = ["L", "C", "R"] as const;
const ROWS = ["T", "M", "B"] as const;

/*
 * 参照模型（design Property 14）：位于第几段 = 有几条分界线 `s · extent` 不大于该坐标。
 * 比较式与被测函数同为 `v < s · extent`，保证浮点舍入不会让分界点在两边判法不一；
 * 但用计数而非三元链，二者结构互相独立。恰在分界线上的点不小于分界值，归右侧或下方。
 */
function referenceIndex(v: number, extent: number): number {
  return [TAP_ZONE_SPLIT_1, TAP_ZONE_SPLIT_2].filter((s) => !(v < s * extent)).length;
}

function referenceZone(x: number, y: number, width: number, height: number): TapZone {
  return `${ROWS[referenceIndex(y, height)]}${COLS[referenceIndex(x, width)]}`;
}

/** Legado `AppConfig` 默认映射，按动作列出区域（需求 5.2–5.4），不复用被测函数的查表。 */
const PREV_ZONES: readonly TapZone[] = ["TL", "TC", "ML", "BL"];
const NEXT_ZONES: readonly TapZone[] = ["TR", "MR", "BC", "BR"];

function referenceAction(zone: TapZone): TapZoneAction {
  if (PREV_ZONES.includes(zone)) return "prev";
  if (NEXT_ZONES.includes(zone)) return "next";
  return "menu";
}

/** 严格小于 v 的某个正数（v > 0 时 `v · (1 − ε)` 至少比 v 低一个 ulp）。 */
function justBelow(v: number): number {
  return v * (1 - Number.EPSILON);
}

/** 视口宽或高：含小数，覆盖窄屏到超宽屏。 */
const extentArb = fc.double({ min: 1, max: 10_000, noNaN: true, noDefaultInfinity: true });

/** `[0, extent)` 内的坐标：一般取值，外加两条分界线、其紧邻下方、0 与最右/最下一点。 */
function coordArb(extent: number): fc.Arbitrary<number> {
  return fc.oneof(
    fc.double({ min: 0, max: extent, maxExcluded: true, noNaN: true }),
    fc.constantFrom(
      0,
      TAP_ZONE_SPLIT_1 * extent,
      TAP_ZONE_SPLIT_2 * extent,
      justBelow(TAP_ZONE_SPLIT_1 * extent),
      justBelow(TAP_ZONE_SPLIT_2 * extent),
      justBelow(extent),
    ),
  );
}

const tapArb = fc
  .tuple(extentArb, extentArb)
  .chain(([width, height]) =>
    fc.record({
      width: fc.constant(width),
      height: fc.constant(height),
      x: coordArb(width),
      y: coordArb(height),
    }),
  );

describe("tapZone / tapAction", () => {
  // Feature: reader-page-turn-modes, Property 14: 九宫格判定与映射
  // **Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5**
  it("Feature: reader-page-turn-modes, Property 14: 九宫格判定与映射——列/行按 0.33、0.66 分界且分界点归右侧或下方，区域映射为 Legado 默认动作", () => {
    fc.assert(
      fc.property(tapArb, ({ width, height, x, y }) => {
        const zone = tapZone(x, y, width, height);
        expect(zone).toBe(referenceZone(x, y, width, height));
        expect(tapAction(zone)).toBe(referenceAction(zone));
      }),
      { numRuns: 300 },
    );
  });

  const W = 1000;
  const H = 600;
  /** 各列/行的中心：(0 + 0.33) / 2、(0.33 + 0.66) / 2、(0.66 + 1) / 2。 */
  const CENTER = [0.165, 0.495, 0.83] as const;

  it.each<[TapZone, TapZoneAction]>([
    ["TL", "prev"],
    ["TC", "prev"],
    ["TR", "next"],
    ["ML", "prev"],
    ["MC", "menu"],
    ["MR", "next"],
    ["BL", "prev"],
    ["BC", "next"],
    ["BR", "next"],
  ])("%s 区中心点归入该区并映射为 %s", (zone, action) => {
    const row = ROWS.indexOf(zone[0] as (typeof ROWS)[number]);
    const col = COLS.indexOf(zone[1] as (typeof COLS)[number]);
    expect(tapZone(CENTER[col] * W, CENTER[row] * H, W, H)).toBe(zone);
    expect(tapAction(zone)).toBe(action);
  });

  it.each([375, 414.5, 1000, 1366])("横向分界点 x = 0.33W、0.66W 归右侧（W = %s）", (width) => {
    const y = CENTER[1] * H;
    expect(tapZone(justBelow(TAP_ZONE_SPLIT_1 * width), y, width, H)).toBe("ML");
    expect(tapZone(TAP_ZONE_SPLIT_1 * width, y, width, H)).toBe("MC");
    expect(tapZone(justBelow(TAP_ZONE_SPLIT_2 * width), y, width, H)).toBe("MC");
    expect(tapZone(TAP_ZONE_SPLIT_2 * width, y, width, H)).toBe("MR");
  });

  it.each([667, 812.25, 600, 900])("纵向分界点 y = 0.33H、0.66H 归下方（H = %s）", (height) => {
    const x = CENTER[1] * W;
    expect(tapZone(x, justBelow(TAP_ZONE_SPLIT_1 * height), W, height)).toBe("TC");
    expect(tapZone(x, TAP_ZONE_SPLIT_1 * height, W, height)).toBe("MC");
    expect(tapZone(x, justBelow(TAP_ZONE_SPLIT_2 * height), W, height)).toBe("MC");
    expect(tapZone(x, TAP_ZONE_SPLIT_2 * height, W, height)).toBe("BC");
  });
});
