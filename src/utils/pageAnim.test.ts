import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAGE_ANIM,
  PAGE_ANIM,
  type PageAnim,
  effectiveTurnAnim,
  normalizePageAnim,
  renderFamilyOf,
  showsReducedMotionHint,
} from "./pageAnim";

/** 合法编号 0–4（Legado `PageAnim.kt` 的覆盖、滑动、仿真、滚动、无动画）。 */
const VALID: readonly number[] = [0, 1, 2, 3, 4];

/*
 * 参照模型（design Property 1 的归一部分）：raw 是 0–4 的整数时原样返回，否则为 3。
 * 用 `includes` 做成员判定（SameValueZero：-0 算 0，NaN 不算任何值），不走被测函数的
 * "整数 + 区间"判定，二者互相独立。
 */
function referenceNormalize(raw: unknown): unknown {
  return VALID.includes(raw as number) ? raw : 3;
}

/** 任意存储值：合法编号、越界整数、非整数、非有限数、数字串、其余 JSON 值与任意 JS 值。 */
const rawPageAnim: fc.Arbitrary<unknown> = fc.oneof(
  fc.constantFrom(...VALID),
  fc.integer(),
  fc.integer({ min: -2, max: 6 }),
  // 0–4 之间及附近的非整数（如 2.5）
  fc.double({ min: -1, max: 5, noNaN: true }),
  // 任意 double：含 NaN、±Infinity、-0 与极大极小值
  fc.double(),
  // 数字串不做宽松转换：`"2"` 也得 3
  fc.constantFrom(...VALID).map(String),
  fc.constantFrom<unknown>(null, undefined, true, false, 2n, [2], {}, Object(2)),
  fc.jsonValue(),
  fc.anything(),
);

describe("normalizePageAnim", () => {
  // Feature: reader-page-turn-modes, Property 1: pageAnim 归一与持久化往返（归一部分；往返见 storage.test.ts）
  // **Validates: Requirements 1.1, 1.2**
  it("Feature: reader-page-turn-modes, Property 1: pageAnim 归一与持久化往返（归一部分）——结果总在 0–4 内，0–4 的整数原样返回，其余为 3", () => {
    fc.assert(
      fc.property(rawPageAnim, (raw) => {
        const out = normalizePageAnim(raw);
        expect(VALID).toContain(out);
        expect(out).toBe(referenceNormalize(raw));
        // 归一后再归一不变
        expect(normalizePageAnim(out)).toBe(out);
      }),
      { numRuns: 200 },
    );
  });

  it("0–4 原样返回", () => {
    for (const anim of VALID) expect(normalizePageAnim(anim)).toBe(anim);
    expect(normalizePageAnim(PAGE_ANIM.cover)).toBe(0);
    expect(normalizePageAnim(PAGE_ANIM.none)).toBe(4);
  });

  it('缺失、字符串 "2"、2.5、NaN、-1、5、null 都得 3（滚动）', () => {
    expect(DEFAULT_PAGE_ANIM).toBe(3);
    for (const raw of ["2", 2.5, NaN, -1, 5, null, undefined]) {
      expect(normalizePageAnim(raw)).toBe(3);
    }
  });
});

/** 会播放水平翻页动画的模式（覆盖、滑动、仿真），参照模型自备一份，不复用被测模块的判定。 */
const ANIMATED: readonly number[] = [0, 1, 2];

/*
 * 参照模型（design Property 2）：
 * - reduced 且 anim ∈ {0, 1, 2} → 4；
 * - 否则 anim = 2 且不支持仿真 → 0；
 * - 其余原样返回（3 永远是 3，4 永远是 4）。
 */
function referenceEffective(anim: number, reduced: boolean, supported: boolean): number {
  if (reduced && ANIMATED.includes(anim)) return 4;
  if (anim === 2 && !supported) return 0;
  return anim;
}

const pageAnim: fc.Arbitrary<PageAnim> = fc.constantFrom<PageAnim>(0, 1, 2, 3, 4);

describe("effectiveTurnAnim / showsReducedMotionHint", () => {
  // Feature: reader-page-turn-modes, Property 2: 减弱动态效果下的有效动画
  // **Validates: Requirements 9.3, 9.5, 9.6**
  it("Feature: reader-page-turn-modes, Property 2: 减弱动态效果下的有效动画——有效动画与提示判定符合参照模型，且不改设置", () => {
    fc.assert(
      fc.property(pageAnim, fc.boolean(), fc.boolean(), (anim, reduced, supported) => {
        // 需求 9.5：把设置对象冻结后取值传入，调用前后设置不变
        const settings = Object.freeze({ pageAnim: anim });
        const eff = effectiveTurnAnim(settings.pageAnim, reduced, supported);
        const hint = showsReducedMotionHint(settings.pageAnim, reduced);
        expect(settings.pageAnim).toBe(anim);

        // 需求 9.3：总在 0–4 内且与参照模型一致
        expect(VALID).toContain(eff);
        expect(eff).toBe(referenceEffective(anim, reduced, supported));
        if (reduced && ANIMATED.includes(anim)) expect(eff).toBe(PAGE_ANIM.none);
        if (!reduced) {
          expect(eff).toBe(anim === PAGE_ANIM.simulation && !supported ? PAGE_ANIM.cover : anim);
        }
        if (anim === PAGE_ANIM.scroll) expect(eff).toBe(PAGE_ANIM.scroll);

        // 有效动画不跨渲染族：降级只在分页族内发生，滚动族不受影响（不重挂视图）
        expect(renderFamilyOf(eff)).toBe(renderFamilyOf(anim));

        // 需求 9.6：提示当且仅当 reduced 且所选模式为覆盖、滑动、仿真
        expect(hint).toBe(reduced && ANIMATED.includes(anim));
      }),
      { numRuns: 200 },
    );
  });

  it("具体取值：减弱动态效果、仿真降级与不受影响的模式", () => {
    // reduced：覆盖、滑动、仿真都按无动画；仿真即便不支持也是 4 而不是 0
    expect(effectiveTurnAnim(PAGE_ANIM.cover, true, true)).toBe(PAGE_ANIM.none);
    expect(effectiveTurnAnim(PAGE_ANIM.slide, true, true)).toBe(PAGE_ANIM.none);
    expect(effectiveTurnAnim(PAGE_ANIM.simulation, true, false)).toBe(PAGE_ANIM.none);
    // 非 reduced：仅仿真在不支持 clip-path: path() 时降级为覆盖
    expect(effectiveTurnAnim(PAGE_ANIM.simulation, false, false)).toBe(PAGE_ANIM.cover);
    expect(effectiveTurnAnim(PAGE_ANIM.simulation, false, true)).toBe(PAGE_ANIM.simulation);
    // 滚动与无动画任何情况下都不变
    for (const reduced of [false, true]) {
      for (const supported of [false, true]) {
        expect(effectiveTurnAnim(PAGE_ANIM.scroll, reduced, supported)).toBe(PAGE_ANIM.scroll);
        expect(effectiveTurnAnim(PAGE_ANIM.none, reduced, supported)).toBe(PAGE_ANIM.none);
      }
    }
    // 提示：滚动与无动画模式下不显示
    expect(showsReducedMotionHint(PAGE_ANIM.scroll, true)).toBe(false);
    expect(showsReducedMotionHint(PAGE_ANIM.none, true)).toBe(false);
    expect(showsReducedMotionHint(PAGE_ANIM.cover, false)).toBe(false);
    expect(showsReducedMotionHint(PAGE_ANIM.simulation, true)).toBe(true);
  });

  it("renderFamilyOf：只有 3 属于滚动族，0、1、2、4 属于分页族", () => {
    expect(renderFamilyOf(PAGE_ANIM.scroll)).toBe("scroll");
    for (const anim of [PAGE_ANIM.cover, PAGE_ANIM.slide, PAGE_ANIM.simulation, PAGE_ANIM.none]) {
      expect(renderFamilyOf(anim)).toBe("paged");
    }
  });
});
