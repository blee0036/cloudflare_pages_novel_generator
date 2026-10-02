import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildChapterViews } from "./locator";
import { initialPosition, type SavedPosition } from "./readerPosition";
import { parseUrlChapter } from "./readerUrl";

const VOL = { isVolume: true };
const BODY = { isVolume: false };

/** 下标 0、3 是卷节点，正文章节为 1、2、4。 */
const CHAPTERS = [VOL, BODY, BODY, VOL, BODY];
const VIEWS = buildChapterViews(CHAPTERS);
const N = CHAPTERS.length;

describe("initialPosition", () => {
  it("全部为卷节点时返回 null", () => {
    expect(initialPosition(buildChapterViews([VOL, VOL]), 2, null, null)).toBeNull();
    // 有 URL 章号与进度也一样：无章可定位，交给错误页（需求 12.6）
    expect(
      initialPosition(buildChapterViews([VOL, VOL, VOL]), 3, 1, { chapterId: 1, charOffset: 9 }),
    ).toBeNull();
    expect(initialPosition(buildChapterViews([]), 0, null, null)).toBeNull();
  });

  it("URL 章号与进度同章时恢复偏移（D3），不同章或无进度时章首", () => {
    const saved = { chapterId: 2, charOffset: 120 };
    expect(initialPosition(VIEWS, N, 2, saved)).toEqual({ chapterId: 2, charOffset: 120 });
    expect(initialPosition(VIEWS, N, 4, saved)).toEqual({ chapterId: 4, charOffset: 0 });
    expect(initialPosition(VIEWS, N, 2, null)).toEqual({ chapterId: 2, charOffset: 0 });
  });

  it("URL 章号指向卷节点时归一到其后第一个正文章节", () => {
    expect(initialPosition(VIEWS, N, 3, null)).toEqual({ chapterId: 4, charOffset: 0 });
  });

  it("URL 缺省时按进度恢复；进度停在卷节点则归一并作废偏移", () => {
    expect(initialPosition(VIEWS, N, null, { chapterId: 2, charOffset: 50 })).toEqual({
      chapterId: 2,
      charOffset: 50,
    });
    expect(initialPosition(VIEWS, N, null, { chapterId: 3, charOffset: 50 })).toEqual({
      chapterId: 4,
      charOffset: 0,
    });
  });

  it("进度缺省或越界时取第一个正文章节、偏移 0（RC 12.5）", () => {
    expect(initialPosition(VIEWS, N, null, null)).toEqual({ chapterId: 1, charOffset: 0 });
    expect(initialPosition(VIEWS, N, null, { chapterId: N, charOffset: 50 })).toEqual({
      chapterId: 1,
      charOffset: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// Property 4 的生成器与参照模型
// ---------------------------------------------------------------------------

/** 满足 `flags[i] === want` 的全部下标，升序。 */
function indicesWhere(flags: readonly boolean[], want: boolean): number[] {
  return flags.flatMap((flag, i) => (flag === want ? [i] : []));
}

/**
 * 参照模型的章号归一（RC 12.5）：从 `i` 起线性往后找第一个正文章节；其后没有正文章节
 * （书尾挂着卷节点）时退到最后一个正文章节。逐个节点扫描，不经 `locator` 的双视图与二分。
 * 调用方保证 `0 <= i < flags.length` 且表中至少有 1 个正文章节。
 */
function modelResolve(isVolume: readonly boolean[], i: number): number {
  for (let j = i; j < isVolume.length; j++) if (!isVolume[j]) return j;
  for (let j = isVolume.length - 1; j >= 0; j--) if (!isVolume[j]) return j;
  throw new Error("参照模型要求章节表至少含 1 个正文章节");
}

/** 参照模型：按需求 7.5–7.7 与 RC 12.5 逐条写出的初始定位。 */
function modelPosition(
  isVolume: readonly boolean[],
  urlChapter: number | null,
  saved: SavedPosition | null,
): { chapterId: number; charOffset: number } {
  // 进度章号越界（章节表重切过）视同缺省
  const valid = saved !== null && saved.chapterId < isVolume.length ? saved : null;

  if (urlChapter !== null) {
    const chapterId = modelResolve(isVolume, urlChapter);
    // D3：进度有效、进度章号本身是正文章节、且就是 URL 所指（归一后）那一章 → 恢复偏移（7.5）
    const restore = valid !== null && !isVolume[valid.chapterId] && valid.chapterId === chapterId;
    return { chapterId, charOffset: restore ? valid.charOffset : 0 }; // 否则章首（7.6）
  }

  if (valid !== null) {
    const chapterId = modelResolve(isVolume, valid.chapterId);
    // 进度停在卷节点、被归一到另一章 → 偏移是别处的坐标，作废
    return { chapterId, charOffset: chapterId === valid.chapterId ? valid.charOffset : 0 };
  }

  // 没有可用进度：第一个正文章节的章首（7.7、RC 12.5）
  return { chapterId: isVolume.indexOf(false), charOffset: 0 };
}

/**
 * 章节表的卷节点标记：长度 1–60，至少 1 个正文章节。
 *
 * 卷节点密度在 0–90% 间随机：稀疏时多为孤立的卷，密集时连续卷节点（实测《1852铁血中华》
 * 的 105、106）很常见。首尾两个节点另以一半的概率强制为卷，覆盖"书首即卷""书尾挂卷"
 * （后者没有"其后"的正文章节，要退到最后一章）。最后把随机一个下标设为正文，保证非空。
 */
const chapterTable: fc.Arbitrary<boolean[]> = fc
  .integer({ min: 1, max: 60 })
  .chain((length) =>
    fc.record({
      flags: fc
        .integer({ min: 0, max: 9 })
        .chain((density) =>
          fc.array(
            fc.integer({ min: 0, max: 9 }).map((r) => r < density),
            { minLength: length, maxLength: length },
          ),
        ),
      keep: fc.integer({ min: 0, max: length - 1 }),
      volumeHead: fc.boolean(),
      volumeTail: fc.boolean(),
    }),
  )
  .map(({ flags, keep, volumeHead, volumeTail }) => {
    const isVolume = [...flags];
    if (volumeHead) isVolume[0] = true;
    if (volumeTail) isVolume[isVolume.length - 1] = true;
    isVolume[keep] = false;
    return isVolume;
  });

/** URL 章号原文，及按需求 7 的判读口径**预先标注**的章号（`null` 表示缺省或无效）。 */
interface UrlCase {
  readonly raw: string | null;
  readonly chapter: number | null;
}

/** URL 章号原文：缺省、非数字、负数、越界、卷节点下标、正文下标、带非数字后缀的下标。 */
function urlCase(isVolume: readonly boolean[]): fc.Arbitrary<UrlCase> {
  const n = isVolume.length;
  const exactly = (indices: readonly number[]) =>
    fc.constantFrom(...indices).map((i): UrlCase => ({ raw: String(i), chapter: i }));

  const cases: fc.Arbitrary<UrlCase>[] = [
    fc.constant<UrlCase>({ raw: null, chapter: null }),
    fc
      .constantFrom("", " ", "abc", "NaN", "Infinity", "+", "第3章")
      .map((raw): UrlCase => ({ raw, chapter: null })),
    fc.integer({ min: 1, max: 1000 }).map((k): UrlCase => ({ raw: `-${k}`, chapter: null })),
    fc.integer({ min: 0, max: 1000 }).map((k): UrlCase => ({ raw: String(n + k), chapter: null })),
    exactly(indicesWhere(isVolume, false)),
    // parseInt 只读前缀："3abc" 读作 3（readerUrl 沿用的既有口径）
    fc.integer({ min: 0, max: n - 1 }).map((i): UrlCase => ({ raw: `${i}abc`, chapter: i })),
  ];
  const volumes = indicesWhere(isVolume, true);
  if (volumes.length > 0) cases.push(exactly(volumes));
  return fc.oneof(...cases);
}

/**
 * 已存进度：缺省，或章号在 `[0, 长度 + 10)` 内、偏移为任意非负安全整数。
 *
 * 章号均匀取值时与 URL 同章的概率只有约 1/长度，D3 那一支几乎碰不到，所以另加几路有偏的
 * 来源：越界段、卷节点、URL 原样的章号、URL 归一后的章号（URL 指向卷节点而进度在其后
 * 那一章，应当恢复偏移）。
 */
function savedCase(isVolume: readonly boolean[], url: UrlCase): fc.Arbitrary<SavedPosition | null> {
  const n = isVolume.length;
  const ids: fc.Arbitrary<number>[] = [
    fc.integer({ min: 0, max: n + 9 }),
    fc.integer({ min: n, max: n + 9 }), // 越界：章节表被重切过
  ];
  const volumes = indicesWhere(isVolume, true);
  if (volumes.length > 0) ids.push(fc.constantFrom(...volumes)); // 停在卷节点
  if (url.chapter !== null) {
    ids.push(fc.constant(url.chapter));
    ids.push(fc.constant(modelResolve(isVolume, url.chapter)));
  }
  return fc.option(
    fc.record({ chapterId: fc.oneof(...ids), charOffset: fc.maxSafeNat() }),
    { nil: null },
  );
}

const scenario = chapterTable.chain((isVolume) =>
  urlCase(isVolume).chain((url) =>
    savedCase(isVolume, url).map((saved) => ({ isVolume, url, saved })),
  ),
);

describe("initialPosition（属性）", () => {
  // Feature: reader-defect-fixes, Property 4: 初始定位符合 D3 与 RC 12.5
  // **Validates: Requirements 7.5, 7.6, 7.7**
  it("对任意含正文的章节表、URL 章号原文与已存进度，结果是正文章节且等于参照模型", () => {
    fc.assert(
      fc.property(scenario, ({ isVolume, url, saved }) => {
        const n = isVolume.length;
        const views = buildChapterViews(isVolume.map((v) => ({ isVolume: v })));
        const urlChapter = parseUrlChapter(url.raw, n);
        // 前提：生成器的预先标注与 URL 判读一致，否则下面的比对没有意义
        expect(urlChapter).toBe(url.chapter);

        const got = initialPosition(views, n, urlChapter, saved);
        if (got === null) throw new Error("含正文章节的章节表不应返回 null");
        expect(views.contentIdx).toContain(got.chapterId);
        expect(Number.isInteger(got.charOffset) && got.charOffset >= 0).toBe(true);
        expect(got).toEqual(modelPosition(isVolume, url.chapter, saved));
      }),
      { numRuns: 100 },
    );
  });
});
