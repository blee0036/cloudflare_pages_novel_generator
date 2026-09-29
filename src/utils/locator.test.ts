import { describe, expect, it } from "vitest";
import {
  NO_CHAPTER,
  NO_CONTENT_CHAPTER,
  bodyParagraphs,
  buildChapterViews,
  contentChapterAt,
  contentPositionOf,
  findChapterIndex,
  findParaIndex,
  normalizeTitle,
  previewAt,
  progressPercentAt,
  resolveContentChapter,
  resolveHighlight,
  resolveJumpTarget,
  splitParagraphs,
  stepContentChapter,
  tocUrl,
  txtUrl,
  upperBound,
  type Para,
} from "./locator";

/**
 * `src/utils/locator.ts`（任务 32，需求 2.1 / INV-1，design §3）。
 *
 * 这里全是差一位陷阱：算错了 `typecheck` 一无所知，症状是跳错段（design §11）。
 * 因此每个边界都单独钉一条，并对"偏移 → 段落"这类换算另加一条全量交叉验证
 * （二分结果必须与线性扫描逐个一致）。
 *
 * 夹具一律用 CRLF，与预处理产物（`scripts/tests/test_toc_split.py` 同口径）一致：
 * 段落偏移必须对 `\r\n` 与 `\n` 同样成立。
 */

const NL = "\r\n";
/** 中文 txt 的主流首行缩进：两个全角空格 U+3000。 */
const INDENT = "\u3000\u3000";

/**
 * 一段仿真全文：两章，range 含自身标题行（需求 8.15），章间有空行。
 * 用它来验证 `chapter.start + para.offset` 确实是有效的全局偏移。
 */
const CHAPTER_ONE = [
  "第一章 夜行",
  `${INDENT}他在夜里出门。`,
  "",
  `${INDENT}风很大。`,
  "",
].join(NL);

const CHAPTER_TWO = [
  "第二章 归来",
  `${INDENT}天亮时他回来了。`,
  "",
].join(NL);

const FULL_TEXT = CHAPTER_ONE + CHAPTER_TWO;

/** 与 `_toc.json` 同构的最小章节表：`start`/`end` 严格连续覆盖全文（需求 8.14）。 */
const CHAPTERS = [
  { start: 0, end: CHAPTER_ONE.length },
  { start: CHAPTER_ONE.length, end: FULL_TEXT.length },
];

describe("splitParagraphs", () => {
  it("每段的 offset 指向首个非空白字符，切片能原样取回该段", () => {
    const paras = splitParagraphs(CHAPTER_ONE);

    expect(paras.map((p) => p.text)).toEqual([
      "第一章 夜行",
      "他在夜里出门。",
      "风很大。",
    ]);
    for (const p of paras) {
      expect(CHAPTER_ONE.slice(p.offset, p.offset + p.text.length)).toBe(p.text);
    }
  });

  it("全角缩进被跳过：offset 落在正文首字而不是缩进上", () => {
    const [, body] = splitParagraphs(CHAPTER_ONE);

    expect(CHAPTER_ONE[body.offset]).toBe("他");
    // 缩进的两个全角空格在 offset 之前
    expect(CHAPTER_ONE.slice(body.offset - INDENT.length, body.offset)).toBe(INDENT);
  });

  it("空行与纯空白行不产出段落", () => {
    const paras = splitParagraphs(
      ["甲", "", "   ", "\u3000\u3000", "\t", "乙"].join(NL),
    );

    expect(paras.map((p) => p.text)).toEqual(["甲", "乙"]);
  });

  it("CRLF 的 \\r 不进入段落文本，也不错开后续偏移", () => {
    const text = `甲${NL}乙${NL}`;
    const paras = splitParagraphs(text);

    expect(paras).toEqual([
      { offset: 0, text: "甲" },
      { offset: 3, text: "乙" }, // "甲" + "\r\n" = 3 个字符
    ]);
    expect(paras.every((p) => !p.text.includes("\r"))).toBe(true);
  });

  it("空文本与纯空白文本返回空数组", () => {
    expect(splitParagraphs("")).toEqual([]);
    expect(splitParagraphs(`${NL}${NL}\u3000 \t`)).toEqual([]);
  });

  it("单段（无结尾换行）也能切出来", () => {
    expect(splitParagraphs("只有一段")).toEqual([{ offset: 0, text: "只有一段" }]);
  });

  it("offset 严格递增且落在文本范围内", () => {
    const paras = splitParagraphs(FULL_TEXT);

    for (let i = 1; i < paras.length; i++) {
      expect(paras[i].offset).toBeGreaterThan(paras[i - 1].offset);
    }
    for (const p of paras) {
      expect(p.offset).toBeGreaterThanOrEqual(0);
      expect(p.offset + p.text.length).toBeLessThanOrEqual(FULL_TEXT.length);
    }
  });

  it("前导空行不被吃掉：偏移按原文平移，不整体归零", () => {
    const paras = splitParagraphs(`${NL}${NL}甲`);

    // 两个 CRLF 共 4 个字符
    expect(paras).toEqual([{ offset: 4, text: "甲" }]);
  });

  it("chapter.start + para.offset 是有效的全局偏移（对真实章节切片验证）", () => {
    for (const chapter of CHAPTERS) {
      // 关键：切片**不** trim，否则所有偏移整体平移（design §3.1）
      const paras = splitParagraphs(FULL_TEXT.slice(chapter.start, chapter.end));
      expect(paras.length).toBeGreaterThan(0);

      for (const p of paras) {
        const globalOffset = chapter.start + p.offset;
        expect(FULL_TEXT.slice(globalOffset, globalOffset + p.text.length)).toBe(p.text);
      }
    }
  });

  it("trim 过的章节文本会让偏移整体平移、全局偏移失效（该约束为何存在）", () => {
    // 章内首行之前有空白时（兜底切分、序章），trim 会吃掉它
    const chapterStart = CHAPTER_ONE.length;
    const chapterText = NL + CHAPTER_TWO;
    const untrimmed = splitParagraphs(chapterText);
    const trimmed = splitParagraphs(chapterText.trim());

    expect(untrimmed).toHaveLength(trimmed.length);
    untrimmed.forEach((p, i) => {
      // 偏移整体前移了被 trim 掉的那 2 个字符
      expect(trimmed[i].offset).toBe(p.offset - NL.length);
    });

    // 把本章拼回一个仿真全文，验证两种偏移各自指向哪里
    const fullText = "前".repeat(chapterStart) + chapterText;
    const good = chapterStart + untrimmed[0].offset;
    const bad = chapterStart + trimmed[0].offset;
    expect(fullText.slice(good, good + untrimmed[0].text.length)).toBe(untrimmed[0].text);
    expect(fullText.slice(bad, bad + trimmed[0].text.length)).not.toBe(trimmed[0].text);
  });
});

describe("findParaIndex", () => {
  const paras = splitParagraphs(CHAPTER_ONE);

  it("charOffset 恰好落在段首时返回该段本身，不是下一段", () => {
    paras.forEach((p, i) => {
      expect(findParaIndex(paras, p.offset)).toBe(i);
    });
  });

  it("段首前一个字符仍属于上一段", () => {
    for (let i = 1; i < paras.length; i++) {
      expect(findParaIndex(paras, paras[i].offset - 1)).toBe(i - 1);
    }
  });

  it("charOffset 为 0（章首，标题行之前）返回第 0 段", () => {
    expect(findParaIndex(paras, 0)).toBe(0);
  });

  it("charOffset 小于首段偏移（含负数）回落到第 0 段", () => {
    const shifted = splitParagraphs(`${NL}甲${NL}乙`);
    expect(findParaIndex(shifted, 0)).toBe(0);
    expect(findParaIndex(shifted, 1)).toBe(0);
    expect(findParaIndex(paras, -1)).toBe(0);
  });

  it("charOffset 超出末段时返回末段", () => {
    const last = paras.length - 1;
    expect(findParaIndex(paras, paras[last].offset + 1)).toBe(last);
    expect(findParaIndex(paras, CHAPTER_ONE.length)).toBe(last);
    expect(findParaIndex(paras, 10 ** 9)).toBe(last);
  });

  it("单段章节对任意偏移都返回 0", () => {
    const single: Para[] = [{ offset: 7, text: "只有一段" }];
    for (const offset of [-1, 0, 7, 8, 999]) {
      expect(findParaIndex(single, offset)).toBe(0);
    }
  });

  it("空章节返回 0（不可用的下标，调用方须先判空）", () => {
    expect(findParaIndex([], 0)).toBe(0);
    expect(findParaIndex([], 123)).toBe(0);
  });

  it("二分结果与线性扫描逐个一致（覆盖全章每个偏移）", () => {
    const linear = (offset: number) => {
      let ans = 0;
      paras.forEach((p, i) => {
        if (p.offset <= offset) ans = i;
      });
      return ans;
    };

    for (let offset = -2; offset <= CHAPTER_ONE.length + 2; offset++) {
      expect(findParaIndex(paras, offset)).toBe(linear(offset));
    }
  });
});

/**
 * 卷节点的双视图与导航（任务 37，需求 12.3 / 12.5 / 12.6，design §3.8 / §10）。
 *
 * 全是差一位陷阱：算错了 `typecheck` 一无所知，症状是点"下一章"连跳两章、或进了一页只有
 * 标题的空白（design §11）。组件与 DOM 不在测试范围内，这里只验下标算术。
 */

/** 与 `_toc.json` 同构的最小节点：只有"是不是卷"这一位参与判定。 */
const VOL = { isVolume: true };
const BODY = {};

/** 按卷节点的原始下标造一张 `length` 个节点的章节表。 */
const tocOf = (length: number, volumeIds: readonly number[]) =>
  Array.from({ length }, (_, i) => (volumeIds.includes(i) ? VOL : BODY));

/**
 * 实测布局：《1852铁血中华》1392 个节点、9 个卷，`totalChapters` 为 1383。
 * 含**相邻两个卷节点**（105、106）——"跳过一个就够了"的写法正是在这里翻车。
 */
const REAL_VOLUME_IDS = [1, 28, 54, 95, 105, 106, 219, 381, 746];
const REAL_TOC = tocOf(1392, REAL_VOLUME_IDS);

describe("buildChapterViews", () => {
  it("没有卷节点时 contentIdx 就是全部下标，contentPos 是恒等映射", () => {
    const views = buildChapterViews([BODY, BODY, BODY]);

    expect(views.contentIdx).toEqual([0, 1, 2]);
    expect([...views.contentPos]).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
    ]);
  });

  it("卷节点不进 contentIdx，其后的正文序号整体前移", () => {
    // 实测形态：`第一卷` 自成节点，range 只含标题行
    const views = buildChapterViews([VOL, BODY, BODY, VOL, BODY]);

    expect(views.contentIdx).toEqual([1, 2, 4]);
    expect(views.contentPos.get(1)).toBe(0);
    expect(views.contentPos.get(2)).toBe(1);
    expect(views.contentPos.get(4)).toBe(2);
    // 卷节点没有序号，而不是序号为 0
    expect(views.contentPos.has(0)).toBe(false);
    expect(views.contentPos.has(3)).toBe(false);
  });

  it("contentIdx 与 contentPos 互为反函数", () => {
    const views = buildChapterViews(REAL_TOC);

    views.contentIdx.forEach((raw, pos) => {
      expect(views.contentPos.get(raw)).toBe(pos);
    });
    expect(views.contentPos.size).toBe(views.contentIdx.length);
  });

  it("正文数与产物的 totalChapters 一致（实测 1392 个节点 / 9 个卷 / 1383 章）", () => {
    expect(buildChapterViews(REAL_TOC).contentIdx).toHaveLength(1383);
  });

  it("产物省略 isVolume 字段时算正文（读取一律按 !chapter.isVolume）", () => {
    const views = buildChapterViews([{ isVolume: undefined }, { isVolume: false }, VOL]);

    expect(views.contentIdx).toEqual([0, 1]);
  });

  it("空表与全卷表给出空视图（需求 12.6 的错误页据此触发）", () => {
    expect(buildChapterViews([]).contentIdx).toEqual([]);
    expect(buildChapterViews([VOL, VOL]).contentIdx).toEqual([]);
    expect(buildChapterViews([VOL, VOL]).contentPos.size).toBe(0);
  });
});

describe("resolveContentChapter", () => {
  it("目标已是正文章节时原样返回", () => {
    const views = buildChapterViews([VOL, BODY, BODY, VOL, BODY]);

    for (const raw of [1, 2, 4]) {
      expect(resolveContentChapter(views, raw)).toBe(raw);
    }
  });

  it("目标落在卷节点时改用其后第一个正文章节（需求 12.5）", () => {
    const views = buildChapterViews([VOL, BODY, BODY, VOL, BODY]);

    expect(resolveContentChapter(views, 0)).toBe(1);
    expect(resolveContentChapter(views, 3)).toBe(4);
  });

  it("连续的卷节点一次跳到底（实测 1852 的 105、106 相邻）", () => {
    const views = buildChapterViews(REAL_TOC);

    expect(resolveContentChapter(views, 105)).toBe(107);
    expect(resolveContentChapter(views, 106)).toBe(107);
    // 三连也一样
    expect(resolveContentChapter(buildChapterViews([VOL, VOL, VOL, BODY]), 0)).toBe(3);
  });

  it("其后没有正文章节（书尾挂着卷节点）时退到最后一个正文章节，不返回卷节点", () => {
    const views = buildChapterViews([BODY, BODY, VOL, VOL]);

    expect(resolveContentChapter(views, 2)).toBe(1);
    expect(resolveContentChapter(views, 3)).toBe(1);
  });

  it("越界的下标夹到两端的正文章节", () => {
    const views = buildChapterViews([VOL, BODY, BODY, VOL]);

    expect(resolveContentChapter(views, -1)).toBe(1);
    expect(resolveContentChapter(views, -(10 ** 9))).toBe(1);
    expect(resolveContentChapter(views, 4)).toBe(2);
    expect(resolveContentChapter(views, 10 ** 9)).toBe(2);
  });

  it("没有正文章节时返回 NO_CONTENT_CHAPTER，而不是 0（0 也是卷节点）", () => {
    for (const chapters of [[], [VOL], [VOL, VOL, VOL]]) {
      const views = buildChapterViews(chapters);
      for (const raw of [-1, 0, 1, 99]) {
        expect(resolveContentChapter(views, raw)).toBe(NO_CONTENT_CHAPTER);
      }
    }
  });

  it("任何下标的归一结果都是正文章节（对实测卷布局全量验证）", () => {
    const views = buildChapterViews(REAL_TOC);

    for (let raw = -3; raw < REAL_TOC.length + 3; raw++) {
      const resolved = resolveContentChapter(views, raw);
      expect(REAL_TOC[resolved]).toBe(BODY);
      expect(views.contentPos.has(resolved)).toBe(true);
    }
  });

  it("归一结果与线性向后扫描逐个一致", () => {
    const views = buildChapterViews(REAL_TOC);
    const linear = (raw: number) => {
      const from = Math.max(0, raw);
      for (let i = from; i < REAL_TOC.length; i++) {
        if (REAL_TOC[i] !== VOL) return i;
      }
      return views.contentIdx[views.contentIdx.length - 1];
    };

    for (let raw = -3; raw < REAL_TOC.length + 3; raw++) {
      expect(resolveContentChapter(views, raw)).toBe(linear(raw));
    }
  });

  it("幂等：归一过的下标再归一不变", () => {
    const views = buildChapterViews(REAL_TOC);

    for (let raw = -1; raw < REAL_TOC.length + 1; raw++) {
      const once = resolveContentChapter(views, raw);
      expect(resolveContentChapter(views, once)).toBe(once);
    }
  });
});

describe("contentPositionOf", () => {
  it("正文章节给出它在 contentIdx 里的序号（滑杆值域与计数用，需求 12.4）", () => {
    const views = buildChapterViews([VOL, BODY, BODY, VOL, BODY]);

    expect(contentPositionOf(views, 1)).toBe(0);
    expect(contentPositionOf(views, 2)).toBe(1);
    expect(contentPositionOf(views, 4)).toBe(2);
  });

  it("卷节点给出归一后那一章的序号", () => {
    const views = buildChapterViews([VOL, BODY, BODY, VOL, BODY]);

    expect(contentPositionOf(views, 0)).toBe(0);
    expect(contentPositionOf(views, 3)).toBe(2);
  });

  it("与 resolveContentChapter 始终自洽", () => {
    const views = buildChapterViews(REAL_TOC);

    for (let raw = -2; raw < REAL_TOC.length + 2; raw++) {
      const pos = contentPositionOf(views, raw);
      expect(views.contentIdx[pos]).toBe(resolveContentChapter(views, raw));
    }
  });

  it("序号落在 0 – (contentIdx.length - 1) 内，恰好是滑杆的值域", () => {
    const views = buildChapterViews(REAL_TOC);
    const max = views.contentIdx.length - 1;

    for (let raw = -2; raw < REAL_TOC.length + 2; raw++) {
      const pos = contentPositionOf(views, raw);
      expect(pos).toBeGreaterThanOrEqual(0);
      expect(pos).toBeLessThanOrEqual(max);
    }
    expect(contentPositionOf(views, 0)).toBe(0);
    expect(contentPositionOf(views, REAL_TOC.length - 1)).toBe(max);
  });

  it("没有正文章节时返回 NO_CONTENT_CHAPTER", () => {
    expect(contentPositionOf(buildChapterViews([]), 0)).toBe(NO_CONTENT_CHAPTER);
    expect(contentPositionOf(buildChapterViews([VOL, VOL]), 1)).toBe(NO_CONTENT_CHAPTER);
  });
});

/**
 * 滑杆的 `onChange` 换算（任务 39，需求 12.4）。
 *
 * 滑杆的 `value`/`max` 是正文序号，`goToChapter` 收原始下标——这一步换算漏掉时，
 * 偏移量恰好是卷节点数，在无卷的书上完全看不出来（实测 6 本里 2 本无卷）。
 */
describe("contentChapterAt", () => {
  it("正文序号映回原始下标（滑杆拖动的落点）", () => {
    const views = buildChapterViews([VOL, BODY, BODY, VOL, BODY]);

    expect(contentChapterAt(views, 0)).toBe(1);
    expect(contentChapterAt(views, 1)).toBe(2);
    expect(contentChapterAt(views, 2)).toBe(4);
  });

  it("与 contentPositionOf 互为反函数（两个方向都往返）", () => {
    const views = buildChapterViews(REAL_TOC);

    views.contentIdx.forEach((raw, pos) => {
      expect(contentChapterAt(views, pos)).toBe(raw);
      expect(contentPositionOf(views, contentChapterAt(views, pos))).toBe(pos);
      expect(contentChapterAt(views, contentPositionOf(views, raw))).toBe(raw);
    });
  });

  it("滑杆值域 0 – (contentTotal - 1) 恰好覆盖全部正文章节，一个不漏、不碰卷节点", () => {
    const views = buildChapterViews(REAL_TOC);
    const total = views.contentIdx.length;
    const reachable = Array.from({ length: total }, (_, pos) => contentChapterAt(views, pos));

    expect(reachable).toEqual([...views.contentIdx]);
    expect(new Set(reachable).size).toBe(total);
    expect(reachable.some((raw) => REAL_VOLUME_IDS.includes(raw))).toBe(false);
  });

  it("滑杆两端落在首/末正文章节，而不是首/末节点（实测末端序号 1382 → 原始 1391）", () => {
    const views = buildChapterViews(REAL_TOC);
    const max = views.contentIdx.length - 1;

    expect(max).toBe(1382);
    expect(contentChapterAt(views, max)).toBe(1391);
    // 把序号当原始下标直接用（漏掉换算）会停在倒数第 10 章附近
    expect(contentChapterAt(views, max)).not.toBe(max);
    expect(contentChapterAt(views, 0)).toBe(0);
  });

  it("越界的序号夹到两端", () => {
    const views = buildChapterViews([VOL, BODY, BODY, VOL]);

    expect(contentChapterAt(views, -1)).toBe(1);
    expect(contentChapterAt(views, -(10 ** 9))).toBe(1);
    expect(contentChapterAt(views, 2)).toBe(2);
    expect(contentChapterAt(views, 10 ** 9)).toBe(2);
  });

  it("非整数截断，NaN / Infinity 返回 NO_CONTENT_CHAPTER 而不是 undefined 下标", () => {
    const views = buildChapterViews([VOL, BODY, BODY, BODY]);

    expect(contentChapterAt(views, 1.9)).toBe(2);
    expect(contentChapterAt(views, -0.5)).toBe(1);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(contentChapterAt(views, bad)).toBe(NO_CONTENT_CHAPTER);
    }
  });

  it("没有正文章节时返回 NO_CONTENT_CHAPTER（需求 12.6 的错误页已接手）", () => {
    for (const chapters of [[], [VOL], [VOL, VOL]]) {
      const views = buildChapterViews(chapters);
      for (const pos of [-1, 0, 1, 99]) {
        expect(contentChapterAt(views, pos)).toBe(NO_CONTENT_CHAPTER);
      }
    }
  });

  it("结果永远是正文章节，且已归一（再过 resolveContentChapter 不变）", () => {
    const views = buildChapterViews(REAL_TOC);

    for (let pos = -2; pos < views.contentIdx.length + 2; pos++) {
      const raw = contentChapterAt(views, pos);
      expect(REAL_TOC[raw]).toBe(BODY);
      expect(resolveContentChapter(views, raw)).toBe(raw);
    }
  });

  it("单调不减：滑杆往右拖，落点不会往回走", () => {
    const views = buildChapterViews(REAL_TOC);
    let prev = -1;

    for (let pos = -2; pos < views.contentIdx.length + 2; pos++) {
      const raw = contentChapterAt(views, pos);
      expect(raw).toBeGreaterThanOrEqual(prev);
      prev = raw;
    }
  });
});

describe("stepContentChapter", () => {
  it("上下章跳过卷节点，落到相邻的正文章节（需求 12.3）", () => {
    const views = buildChapterViews([VOL, BODY, BODY, VOL, BODY]);

    expect(stepContentChapter(views, 2, 1)).toBe(4); // 越过下标 3 的卷节点
    expect(stepContentChapter(views, 4, -1)).toBe(2);
    expect(stepContentChapter(views, 1, 1)).toBe(2);
    expect(stepContentChapter(views, 2, -1)).toBe(1); // 不退回下标 0 的卷节点
  });

  it("相邻的卷节点一步跨过（实测 1852 的 105、106）", () => {
    const views = buildChapterViews(REAL_TOC);

    expect(stepContentChapter(views, 104, 1)).toBe(107);
    expect(stepContentChapter(views, 107, -1)).toBe(104);
  });

  it("首/末正文章节处夹住并返回自身（按钮据此置灰，不绕回另一端）", () => {
    const views = buildChapterViews([VOL, BODY, BODY, VOL]);

    expect(stepContentChapter(views, 1, -1)).toBe(1);
    expect(stepContentChapter(views, 1, -(10 ** 9))).toBe(1);
    expect(stepContentChapter(views, 2, 1)).toBe(2);
    expect(stepContentChapter(views, 2, 10 ** 9)).toBe(2);
  });

  it("delta 为 0 时归一到正文章节但不移动", () => {
    const views = buildChapterViews([VOL, BODY, BODY]);

    expect(stepContentChapter(views, 2, 0)).toBe(2);
    expect(stepContentChapter(views, 0, 0)).toBe(1);
  });

  it("当前下标是卷节点时，前后各一步落在它两侧的正文章节（不连跳两章）", () => {
    const views = buildChapterViews([BODY, VOL, BODY, BODY]);

    expect(stepContentChapter(views, 1, 1)).toBe(2);
    expect(stepContentChapter(views, 1, -1)).toBe(0);
    // 书首的卷节点：往前一步无处可去，夹在第一个正文章节
    expect(stepContentChapter(buildChapterViews([VOL, BODY]), 0, -1)).toBe(1);
    expect(stepContentChapter(buildChapterViews([VOL, BODY]), 0, 1)).toBe(1);
  });

  it("没有正文章节时返回 NO_CONTENT_CHAPTER", () => {
    const views = buildChapterViews([VOL, VOL]);

    expect(stepContentChapter(views, 0, 1)).toBe(NO_CONTENT_CHAPTER);
    expect(stepContentChapter(buildChapterViews([]), 0, -1)).toBe(NO_CONTENT_CHAPTER);
  });

  it("+1 / -1 往返回到原处（两端除外）", () => {
    const views = buildChapterViews(REAL_TOC);
    const last = views.contentIdx.length - 1;

    views.contentIdx.forEach((raw, pos) => {
      if (pos < last) expect(stepContentChapter(views, stepContentChapter(views, raw, 1), -1)).toBe(raw);
      if (pos > 0) expect(stepContentChapter(views, stepContentChapter(views, raw, -1), 1)).toBe(raw);
    });
  });

  it("从首章连续 +1 能走遍全部正文章节，一个不漏、一个不重、不碰卷节点", () => {
    const views = buildChapterViews(REAL_TOC);
    const visited: number[] = [];

    let current = resolveContentChapter(views, 0);
    for (;;) {
      visited.push(current);
      const next = stepContentChapter(views, current, 1);
      if (next === current) break;
      current = next;
    }

    expect(visited).toEqual([...views.contentIdx]);
    expect(new Set(visited).size).toBe(visited.length);
    expect(visited.some((raw) => REAL_VOLUME_IDS.includes(raw))).toBe(false);
  });
});

describe("upperBound", () => {
  it("返回第一个严格大于目标的下标", () => {
    const tops = [0, 100, 260, 420];

    expect(upperBound(tops, -1)).toBe(0);
    expect(upperBound(tops, 0)).toBe(1); // 命中时越过相等项
    expect(upperBound(tops, 99)).toBe(1);
    expect(upperBound(tops, 100)).toBe(2);
    expect(upperBound(tops, 419)).toBe(3);
    expect(upperBound(tops, 420)).toBe(4);
    expect(upperBound(tops, 10 ** 9)).toBe(4); // 全都不大于 → length
  });

  it("空数组返回 0", () => {
    expect(upperBound([], 0)).toBe(0);
    expect(upperBound([], -5)).toBe(0);
  });

  it("重复值时越过全部相等项", () => {
    expect(upperBound([0, 0, 0, 5], 0)).toBe(3);
    expect(upperBound([7, 7], 7)).toBe(2);
    expect(upperBound([7, 7], 6)).toBe(0);
  });

  it("与线性计数逐个一致", () => {
    const tops = [0, 56, 56, 140, 300, 301, 900];
    const linear = (y: number) => tops.filter((v) => v <= y).length;

    for (let y = -5; y <= 905; y++) {
      expect(upperBound(tops, y)).toBe(linear(y));
    }
  });

  it("design §3.3 的用法：upperBound(tops, y) - 1 取视口首个可见段落", () => {
    const tops = [0, 100, 260, 420];
    const firstVisible = (y: number) => Math.max(0, upperBound(tops, y) - 1);

    expect(firstVisible(0)).toBe(0);
    expect(firstVisible(99)).toBe(0);
    expect(firstVisible(100)).toBe(1); // 顶端正好贴着视口线的那段就是它
    expect(firstVisible(259)).toBe(1);
    expect(firstVisible(1000)).toBe(3);
    // 视口线在首段之上（TOP_BIAS 未满）时不产生负下标
    expect(firstVisible(-30)).toBe(0);
  });
});

describe("保存 ↔ 恢复的往返（design §3.3 / §3.4，需求 2.3 / 2.4）", () => {
  /**
   * 下面两个 helper 是 `ReaderPage` 两条路径的镜像，**必须与它一起改**：
   *
   * - `save`：滚动时 `upperBound(tops, scrollTop + TOP_BIAS) - 1` 取视口首个可见段落；
   * - `restore`：恢复时 `scrollTop = tops[findParaIndex(paras, charOffset)] - TOP_BIAS`。
   *
   * 钉住的是"两个方向共用同一条判定线"这条不变式——只改其中一侧的 `TOP_BIAS` 用法，
   * `typecheck` 一无所知，症状是每次打开书都偏一段（design §11）。
   * 组件与 DOM 不在测试范围内，这里只验算术。
   */
  const TOP_BIAS = 56;

  const PARAS: Para[] = [
    { offset: 0, text: "第一章 夜行" },
    { offset: 8, text: "他在夜里出门。" },
    { offset: 20, text: "风很大。" },
    { offset: 33, text: "他走了很久。" },
  ];

  /** 同一章在两种排版下的段落顶端位置：字号/行高/版心一变，像素全变，偏移不变。 */
  const SMALL = [120, 180, 260, 400];
  const LARGE = [200, 320, 480, 760];

  const save = (tops: readonly number[], scrollTop: number) =>
    PARAS[Math.max(0, upperBound(tops, scrollTop + TOP_BIAS) - 1)].offset;

  const restore = (tops: readonly number[], charOffset: number) =>
    Math.max(0, tops[findParaIndex(PARAS, charOffset)] - TOP_BIAS);

  it("恢复后再保存得回同一个偏移（判定线在两个方向上自洽）", () => {
    for (const tops of [SMALL, LARGE]) {
      for (const p of PARAS) {
        expect(save(tops, restore(tops, p.offset))).toBe(p.offset);
      }
    }
  });

  it("段落内部任意偏移都恢复到该段段首，再保存即段首偏移（归一化，不漂移）", () => {
    // 第 1 段覆盖 8–19，取其中一个中间位置
    expect(restore(SMALL, 15)).toBe(restore(SMALL, PARAS[1].offset));
    expect(save(SMALL, restore(SMALL, 15))).toBe(PARAS[1].offset);
  });

  it("换字号/行高/版心后，同一个偏移仍落在同一段落（需求 2.4）", () => {
    PARAS.forEach((p, i) => {
      // 像素目标随排版变
      expect(restore(SMALL, p.offset)).not.toBe(restore(LARGE, p.offset));
      // 段落身份不变——findParaIndex 只看字符偏移，根本不碰 tops
      expect(findParaIndex(PARAS, p.offset)).toBe(i);
      expect(save(LARGE, restore(LARGE, p.offset))).toBe(p.offset);
    });
  });

  it("像素比例（旧版做法）在同样的排版变化下会漂移——这是为何存字符偏移", () => {
    const contentHeight = (tops: readonly number[]) => tops[tops.length - 1] + 200;
    // 旧版：存"读到 scrollHeight 的百分之几"，换字号后同一比例对应的像素位置变了
    const ratio = restore(SMALL, PARAS[2].offset) / contentHeight(SMALL);
    const pixelRestored = ratio * contentHeight(LARGE);

    // 按比例恢复落在第 3 段，而正确答案是第 2 段
    expect(save(LARGE, pixelRestored)).not.toBe(PARAS[2].offset);
    expect(save(LARGE, restore(LARGE, PARAS[2].offset))).toBe(PARAS[2].offset);
  });
});

describe("progressPercentAt", () => {
  it("按全局字符偏移占全书字符数计算（需求 2.7、design §3.7）", () => {
    expect(progressPercentAt(0, 200)).toBe(0);
    expect(progressPercentAt(50, 200)).toBe(25);
    expect(progressPercentAt(100, 200)).toBe(50);
    expect(progressPercentAt(199, 200)).toBeCloseTo(99.5, 10);
  });

  it("chapter.start + charOffset 才是入参（章内偏移单独喂进来是错的）", () => {
    const chapter = { start: 4_000, end: 5_000 };
    const charCount = 10_000;

    expect(progressPercentAt(chapter.start + 0, charCount)).toBe(40);
    expect(progressPercentAt(chapter.start + 500, charCount)).toBe(45);
    // 只喂章内偏移会算成 5%，与读者的真实位置相差 40 个百分点
    expect(progressPercentAt(500, charCount)).toBe(5);
  });

  it("不再是章号比例：章长悬殊时两种口径给出完全不同的数", () => {
    // 实测最大书的章长从 23 字到 26375 字，这里用一本"头轻尾重"的书复现失真
    const chapters = [
      { start: 0, end: 23 },
      { start: 23, end: 46 },
      { start: 46, end: 10_046 },
    ];
    const charCount = 10_046;

    // 读到第 2 章（共 3 章）章首：章号比例说 66.7%，实际只读了 0.23%
    expect((2 / chapters.length) * 100).toBeCloseTo(66.67, 2);
    expect(progressPercentAt(chapters[1].start, charCount)).toBeCloseTo(0.23, 2);
  });

  it("末章读到最后一段是 99.x%，不是 100%", () => {
    const charCount = 1_000;
    const percent = progressPercentAt(charCount - 1, charCount);

    expect(percent).toBeLessThan(100);
    expect(percent).toBeGreaterThan(99);
  });

  it("charCount 非正或非法时返回 0，不产出 Infinity / NaN", () => {
    // 前三个走 `charCount <= 0` 的短路；Infinity 走除法后得 0，同样是有限值
    for (const charCount of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const percent = progressPercentAt(1_234, charCount);
      expect(Number.isFinite(percent)).toBe(true);
      expect(percent).toBe(0);
    }
  });

  it("偏移非法（NaN / Infinity）时返回 0", () => {
    expect(progressPercentAt(Number.NaN, 200)).toBe(0);
    expect(progressPercentAt(Number.POSITIVE_INFINITY, 200)).toBe(0);
  });

  it("偏移越界夹到 0–100（进度条宽度与 localStorage 都要求这个区间）", () => {
    expect(progressPercentAt(-1, 200)).toBe(0);
    expect(progressPercentAt(-(10 ** 9), 200)).toBe(0);
    expect(progressPercentAt(200, 200)).toBe(100);
    expect(progressPercentAt(10 ** 9, 200)).toBe(100);
  });

  it("单调不减：偏移前进，百分比不会退", () => {
    const charCount = 997;
    let prev = -1;
    for (let offset = -5; offset <= charCount + 5; offset += 1) {
      const percent = progressPercentAt(offset, charCount);
      expect(percent).toBeGreaterThanOrEqual(prev);
      prev = percent;
    }
  });

  it("在真实章节表上逐章递增（连续覆盖全文时百分比也连续）", () => {
    const charCount = FULL_TEXT.length;
    const percents = CHAPTERS.map((c) => progressPercentAt(c.start, charCount));

    expect(percents[0]).toBe(0);
    expect(percents[1]).toBeGreaterThan(0);
    expect(percents[1]).toBeLessThan(100);
    // 章内推进同样反映出来
    const inChapterTwo = splitParagraphs(FULL_TEXT.slice(CHAPTERS[1].start, CHAPTERS[1].end));
    const deeper = progressPercentAt(
      CHAPTERS[1].start + inChapterTwo[inChapterTwo.length - 1].offset,
      charCount,
    );
    expect(deeper).toBeGreaterThan(percents[1]);
  });
});

describe("normalizeTitle", () => {
  it("折叠内部空白为单个半角空格（Python clean_title 同口径）", () => {
    expect(normalizeTitle("第一章 甲")).toBe("第一章 甲");
    expect(normalizeTitle("第一章  甲")).toBe("第一章 甲");
    expect(normalizeTitle("第十回\u3000青光之眼")).toBe("第十回 青光之眼");
    expect(normalizeTitle("第一回  春寒露沾衣")).toBe("第一回 春寒露沾衣");
    expect(normalizeTitle("第一章\t甲")).toBe("第一章 甲");
    expect(normalizeTitle("第一章\xa0甲")).toBe("第一章 甲");
    expect(normalizeTitle("\u3000\u3000第一章 甲  ")).toBe("第一章 甲");
  });

  it("剥除包住整行的成对装饰符号，含嵌套", () => {
    expect(normalizeTitle("【第一章 夜行】")).toBe("第一章 夜行");
    expect(normalizeTitle("『「第一章 夜行」』")).toBe("第一章 夜行");
    expect(normalizeTitle("（（第一章））")).toBe("第一章");
    expect(normalizeTitle("\u3000【 第一章\u3000\u3000夜行 】 ")).toBe("第一章 夜行");
  });

  it("剥除孤悬的半边（配对符号整行未出现）", () => {
    expect(normalizeTitle("【第一章 夜行")).toBe("第一章 夜行");
    expect(normalizeTitle("第一章 夜行】")).toBe("第一章 夜行");
  });

  it("行内已配对的括号原样保留（不剥成半边）", () => {
    for (const raw of ["青石巷(12)", "第一章（上）", "第一章 甲(1)", "（甲）乙（丙）"]) {
      expect(normalizeTitle(raw)).toBe(raw);
    }
  });

  it("书名号与尖括号不是装饰，不剥", () => {
    expect(normalizeTitle("《青石巷》")).toBe("《青石巷》");
    expect(normalizeTitle("〈第一章〉")).toBe("〈第一章〉");
  });

  it("整行都是装饰或空白时返回空串，不造 `第 N 节`", () => {
    for (const raw of ["【】", "（）", "()", "【", "】", "\u3000 \t", ""]) {
      expect(normalizeTitle(raw)).toBe("");
    }
  });

  it("幂等：净化过的文本再净化不变（design §3.2 严格相等的依据）", () => {
    const inputs = [
      "第一章 甲",
      "第一章  甲",
      "【第一章\u3000夜行】",
      "『「甲」』",
      "青石巷(12)",
      "《青石巷》",
      "【第一章 夜行",
      "（（甲））",
      "【】",
    ];
    for (const raw of inputs) {
      const once = normalizeTitle(raw);
      expect(normalizeTitle(once)).toBe(once);
    }
  });

  it("用于跳过重复首段：净化后的标题行与 chapter.title 严格相等", () => {
    const rawTitleLine = "第一章\u3000夜行"; // 原文用全角空格
    const chapterTitle = "第一章 夜行"; // 产物里已净化
    const paras = splitParagraphs(`${rawTitleLine}${NL}${INDENT}正文。`);

    expect(normalizeTitle(paras[0].text)).toBe(chapterTitle);
    // 直接比行原文会假阴性 → 标题重复显示（design §3.2）
    expect(paras[0].text).not.toBe(chapterTitle);
  });
});

describe("bodyParagraphs", () => {
  /** 一章原文 + 它在 `_toc.json` 里那条已净化的标题。 */
  const chapter = (rawTitleLine: string, ...body: string[]) =>
    splitParagraphs([rawTitleLine, ...body.map((b) => `${INDENT}${b}`), ""].join(NL));

  it("跳过与 chapter.title 重复的首段（修复 E10：标题显示两次）", () => {
    const paras = chapter("第一章 夜行", "他在夜里出门。", "风很大。");

    expect(bodyParagraphs(paras, "第一章 夜行").map((p) => p.text)).toEqual([
      "他在夜里出门。",
      "风很大。",
    ]);
  });

  it("标题行被净化改写过（全角空格、装饰符号）时同样跳过", () => {
    for (const rawTitleLine of [
      "第一章\u3000夜行",
      "第一章  夜行",
      "【第一章 夜行】",
      "\u3000\u3000第一章 夜行 ",
    ]) {
      const paras = chapter(rawTitleLine, "正文。");
      expect(bodyParagraphs(paras, "第一章 夜行").map((p) => p.text)).toEqual(["正文。"]);
    }
  });

  it("跳过后每段仍带原本的章内偏移（chapter.start + offset 依旧有效）", () => {
    const chapterStart = 4096;
    const chapterText = ["第一章 夜行", `${INDENT}他在夜里出门。`, "", `${INDENT}风很大。`].join(
      NL,
    );
    const fullText = "前".repeat(chapterStart) + chapterText;
    const paras = splitParagraphs(chapterText);
    const body = bodyParagraphs(paras, "第一章 夜行");

    // 偏移没有被"跳过首段"平移：与原 paras 的第 1 段起逐个相等
    expect(body).toEqual(paras.slice(1));
    for (const p of body) {
      const globalOffset = chapterStart + p.offset;
      expect(fullText.slice(globalOffset, globalOffset + p.text.length)).toBe(p.text);
    }
  });

  it("以标题开头的正文首段不被吞掉（=== 而非 startsWith）", () => {
    // 合成标题（兜底片段、卷降级）时 paras[0] 可能是"标题 + 后续文字"的长行
    const paras = splitParagraphs("第一章 夜行 之后他又出了一次门。");

    expect(bodyParagraphs(paras, "第一章 夜行")).toBe(paras);
  });

  it("合成标题（序章 / 前言、第 N 部分、第 N 节、兜底片段）不跳过任何段", () => {
    const cases: [string, string][] = [
      ["序章 / 前言", "很久以前……"],
      ["第 3 部分", "承接上文。"],
      ["第 7 节", "承接上文。"],
      ["第一章 夜行(2)", "接着说。"],
    ];
    for (const [title, firstLine] of cases) {
      const paras = splitParagraphs(`${INDENT}${firstLine}`);
      expect(bodyParagraphs(paras, title)).toBe(paras);
      expect(bodyParagraphs(paras, title).map((p) => p.text)).toEqual([firstLine]);
    }
  });

  it("卷节点（正文只有标题行）跳过后为空，调用方据此不渲染正文", () => {
    const paras = splitParagraphs(`第一卷${NL}`);

    expect(paras.map((p) => p.text)).toEqual(["第一卷"]);
    expect(bodyParagraphs(paras, "第一卷")).toEqual([]);
  });

  it("只检查首段：正文里重复出现的同名行照常渲染", () => {
    const paras = chapter("第一章 夜行", "正文。", "第一章 夜行");

    expect(bodyParagraphs(paras, "第一章 夜行").map((p) => p.text)).toEqual([
      "正文。",
      "第一章 夜行",
    ]);
  });

  it("空段落表、空标题、缺标题都原样返回（引用不变）", () => {
    const empty: Para[] = [];
    const paras = splitParagraphs(`第一章 夜行${NL}${INDENT}正文。`);

    expect(bodyParagraphs(empty, "第一章 夜行")).toBe(empty);
    expect(bodyParagraphs(paras, undefined)).toBe(paras);
    expect(bodyParagraphs(paras, "")).toBe(paras);
  });
});

describe("txtUrl / tocUrl", () => {
  it("由 id 派生，与预处理落盘的文件名一致", () => {
    expect(txtUrl("NB-NB")).toBe("/books/NB-NB.txt.gz");
    expect(tocUrl("NB-NB")).toBe("/data/NB-NB_toc.json");
  });

  it("中文 id 走 encodeURIComponent", () => {
    const id = "从零开始-雷云风暴";
    expect(txtUrl(id)).toBe(`/books/${encodeURIComponent(id)}.txt.gz`);
    expect(tocUrl(id)).toBe(`/data/${encodeURIComponent(id)}_toc.json`);
  });

  it("会截断 URL 的字符被转义", () => {
    for (const url of [txtUrl("甲#乙?丙 丁"), tocUrl("甲#乙?丙 丁")]) {
      expect(url).not.toContain("#");
      expect(url).not.toContain("?");
      expect(url).not.toContain(" ");
    }
  });
});

// =============================================================================
// 检索跳转与命中高亮（任务 40，需求 2.5 / 12.5，design §3.5 / §3.6）
// =============================================================================

/**
 * 与 `_toc.json` 同构的一本小书：一个卷节点 + 两章，`start`/`end` 严格连续覆盖全文
 * （需求 8.14），卷节点的 range 恰好覆盖自己的标题行（design §0 修订一）。
 */
const VOLUME_LINE = `第一卷 少年${NL}`;
const BOOK_TEXT = VOLUME_LINE + FULL_TEXT;
const BOOK_CHAPTERS = [
  { title: "第一卷 少年", start: 0, end: VOLUME_LINE.length, isVolume: true },
  {
    title: "第一章 夜行",
    start: VOLUME_LINE.length,
    end: VOLUME_LINE.length + CHAPTER_ONE.length,
  },
  {
    title: "第二章 归来",
    start: VOLUME_LINE.length + CHAPTER_ONE.length,
    end: BOOK_TEXT.length,
  },
];

describe("findChapterIndex", () => {
  it("全局偏移落在 [start, end) 的那个节点，返回数组下标（= chapter.id）", () => {
    expect(findChapterIndex(CHAPTERS, 0)).toBe(0);
    expect(findChapterIndex(CHAPTERS, CHAPTER_ONE.length - 1)).toBe(0);
    // 边界归下一章：end 是开区间
    expect(findChapterIndex(CHAPTERS, CHAPTER_ONE.length)).toBe(1);
    expect(findChapterIndex(CHAPTERS, FULL_TEXT.length - 1)).toBe(1);
  });

  it("越界与脏值返回 NO_CHAPTER，不是 0", () => {
    expect(findChapterIndex(CHAPTERS, -1)).toBe(NO_CHAPTER);
    expect(findChapterIndex(CHAPTERS, FULL_TEXT.length)).toBe(NO_CHAPTER);
    expect(findChapterIndex(CHAPTERS, 10 ** 9)).toBe(NO_CHAPTER);
    expect(findChapterIndex(CHAPTERS, Number.NaN)).toBe(NO_CHAPTER);
    expect(findChapterIndex([], 0)).toBe(NO_CHAPTER);
  });

  it("章节表被手改出空隙时，落在空隙里的偏移也返回 NO_CHAPTER", () => {
    const holed = [
      { start: 0, end: 10 },
      { start: 20, end: 30 },
    ];

    expect(findChapterIndex(holed, 9)).toBe(0);
    expect(findChapterIndex(holed, 10)).toBe(NO_CHAPTER);
    expect(findChapterIndex(holed, 19)).toBe(NO_CHAPTER);
    expect(findChapterIndex(holed, 20)).toBe(1);
  });

  it("卷节点不在这里跳过：命中落在卷标题行上就如实返回那个卷节点", () => {
    // 跳过卷节点是 `resolveContentChapter` 的职责，分层刻意保留（design §3.5）
    expect(findChapterIndex(BOOK_CHAPTERS, 0)).toBe(0);
    expect(findChapterIndex(BOOK_CHAPTERS, BOOK_TEXT.indexOf("少年"))).toBe(0);
  });

  it("与线性扫描逐点一致（全书每个偏移都对一遍）", () => {
    const linear = (offset: number) =>
      BOOK_CHAPTERS.findIndex((c) => offset >= c.start && offset < c.end);

    for (let offset = -2; offset <= BOOK_TEXT.length + 2; offset++) {
      expect(findChapterIndex(BOOK_CHAPTERS, offset)).toBe(linear(offset));
    }
  });
});

describe("resolveJumpTarget", () => {
  const views = buildChapterViews([VOL, BODY, BODY, VOL, BODY]);

  it("目标已是正文章节时偏移与高亮原样保留", () => {
    expect(resolveJumpTarget(views, { chapterId: 2, charOffset: 137 })).toEqual({
      chapterId: 2,
      charOffset: 137,
    });
    expect(
      resolveJumpTarget(views, { chapterId: 2, charOffset: 137, highlightLength: 3 })
    ).toEqual({ chapterId: 2, charOffset: 137, highlightLength: 3 });
  });

  it("落在卷节点时改用其后第一个正文章节，并作废偏移与高亮（需求 12.5）", () => {
    // 偏移是**那个卷节点**里的坐标，带进新的一章会把读者扔到无关的段落，
    // 还在那里标一段无关文字——这是本函数存在的理由
    expect(
      resolveJumpTarget(views, { chapterId: 0, charOffset: 4, highlightLength: 2 })
    ).toEqual({ chapterId: 1, charOffset: 0 });
    expect(
      resolveJumpTarget(views, { chapterId: 3, charOffset: 999, highlightLength: 5 })
    ).toEqual({ chapterId: 4, charOffset: 0 });
  });

  it("章号越界时夹到两端的正文章节，同样作废偏移", () => {
    expect(resolveJumpTarget(views, { chapterId: -3, charOffset: 88 })).toEqual({
      chapterId: 1,
      charOffset: 0,
    });
    expect(resolveJumpTarget(views, { chapterId: 99, charOffset: 88 })).toEqual({
      chapterId: 4,
      charOffset: 0,
    });
  });

  it("没有正文章节时返回 null（需求 12.6 的错误页接手）", () => {
    for (const chapters of [[], [VOL], [VOL, VOL]]) {
      const empty = buildChapterViews(chapters);
      expect(resolveJumpTarget(empty, { chapterId: 0, charOffset: 0 })).toBeNull();
      expect(resolveJumpTarget(empty, { chapterId: 5, charOffset: 9 })).toBeNull();
    }
  });

  it("脏偏移归一：负数夹到 0、小数取整", () => {
    expect(resolveJumpTarget(views, { chapterId: 2, charOffset: -7 })?.charOffset).toBe(0);
    expect(resolveJumpTarget(views, { chapterId: 2, charOffset: 12.9 })?.charOffset).toBe(12);
    expect(resolveJumpTarget(views, { chapterId: 2, charOffset: Number.NaN })?.charOffset).toBe(
      0
    );
  });

  it("非正 / 非有限的 highlightLength 直接去掉（缺省即不高亮）", () => {
    for (const highlightLength of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const resolved = resolveJumpTarget(views, { chapterId: 2, charOffset: 5, highlightLength });
      expect(resolved).toEqual({ chapterId: 2, charOffset: 5 });
      expect(resolved && "highlightLength" in resolved).toBe(false);
    }
  });
});

describe("resolveHighlight", () => {
  const paras = splitParagraphs(CHAPTER_ONE);
  const body = bodyParagraphs(paras, "第一章 夜行");

  it("命中段落内时标出的正是命中那几个字（design §3.6 的三段拆分）", () => {
    const term = "风很大";
    const charOffset = CHAPTER_ONE.indexOf(term);
    const h = resolveHighlight(body, charOffset, term.length);

    expect(h).not.toBeNull();
    expect(body[h!.paraIndex].text).toBe("风很大。");
    expect(h!.offsetInPara).toBe(0);
    // offsetInPara = charOffset - para.offset（design §3.6）
    expect(h!.offsetInPara).toBe(charOffset - body[h!.paraIndex].offset);
    expect(
      body[h!.paraIndex].text.slice(h!.offsetInPara, h!.offsetInPara + h!.length)
    ).toBe(term);
  });

  it("段中间的命中：前 / 命中 / 后三段拼回原段落", () => {
    const term = "夜里";
    const charOffset = CHAPTER_ONE.indexOf(term);
    const h = resolveHighlight(body, charOffset, term.length)!;
    const text = body[h.paraIndex].text;
    const end = h.offsetInPara + h.length;

    expect(text.slice(h.offsetInPara, end)).toBe(term);
    expect(text.slice(0, h.offsetInPara) + term + text.slice(end)).toBe(text);
    expect(h.offsetInPara).toBeGreaterThan(0);
  });

  it("命中落在被跳过的标题行里 → null（那一行没有渲染出来）", () => {
    // 首段即标题、已被 bodyParagraphs 跳掉，屏幕上无处可标（design §3.2）
    const inTitle = CHAPTER_ONE.indexOf("夜行");
    expect(inTitle).toBeGreaterThanOrEqual(0);
    expect(resolveHighlight(body, inTitle, 2)).toBeNull();
    expect(resolveHighlight(body, 0, 3)).toBeNull();

    // 反证：标题没被跳过时（合成标题）同一个偏移是能标的
    expect(resolveHighlight(paras, inTitle, 2)).not.toBeNull();
  });

  it("命中起点落在段间空白 / 空行里 → null", () => {
    const first = body[0];
    const afterFirst = first.offset + first.text.length; // 行尾的 \r
    expect(resolveHighlight(body, afterFirst, 2)).toBeNull();
    expect(resolveHighlight(body, afterFirst + 1, 2)).toBeNull();
  });

  it("命中长度跨过段尾时夹到本段（不拆成多个 mark）", () => {
    const first = body[0];
    const h = resolveHighlight(body, first.offset, first.text.length + 50)!;

    expect(h.paraIndex).toBe(0);
    expect(h.offsetInPara).toBe(0);
    expect(h.length).toBe(first.text.length);
    expect(first.text.slice(0, h.length)).toBe(first.text);
  });

  it("空段落集合、非正长度、脏值一律 null（跳转仍发生，只是不高亮）", () => {
    expect(resolveHighlight([], 0, 3)).toBeNull();
    expect(resolveHighlight(body, body[0].offset, 0)).toBeNull();
    expect(resolveHighlight(body, body[0].offset, -2)).toBeNull();
    expect(resolveHighlight(body, body[0].offset, Number.NaN)).toBeNull();
    expect(resolveHighlight(body, Number.NaN, 3)).toBeNull();
    expect(resolveHighlight(body, -5, 3)).toBeNull();
  });
});

/**
 * `SearchDrawer` → `ReaderPage` → 渲染的完整链路镜像，**必须与三者一起改**：
 *
 * 1. 抽屉：`findChapterIndex(chapters, matchOffset)` 二分定章；
 * 2. 阅读器：`charOffset = matchOffset - chapter.start`，连同关键词长度发一条 `JumpTarget`；
 * 3. 归一：`resolveJumpTarget`（卷节点 → 其后第一个正文章节，并作废错位的偏移）；
 * 4. 渲染：`resolveHighlight(bodyParas, ...)` 给出 `<mark>` 的落点。
 *
 * 钉住的不变式只有一条，但它是需求 2.5 的全部：**被标出来的字符恰好是命中的那几个字**。
 * 链路上任一处差一位，这条就会失败。
 */
describe("检索跳转链路（需求 2.5，design §3.5 / §3.6）", () => {
  const views = buildChapterViews(BOOK_CHAPTERS);

  const searchJump = (term: string, from = 0) => {
    const matchOffset = BOOK_TEXT.indexOf(term, from);
    expect(matchOffset).toBeGreaterThanOrEqual(0);

    const chapterId = findChapterIndex(BOOK_CHAPTERS, matchOffset);
    expect(chapterId).not.toBe(NO_CHAPTER);

    const target = resolveJumpTarget(views, {
      chapterId,
      charOffset: matchOffset - BOOK_CHAPTERS[chapterId].start,
      highlightLength: term.length,
    })!;
    expect(target).not.toBeNull();

    const chapter = BOOK_CHAPTERS[target.chapterId];
    const bodyParas = bodyParagraphs(
      splitParagraphs(BOOK_TEXT.slice(chapter.start, chapter.end)),
      chapter.title
    );
    const highlight =
      target.highlightLength === undefined
        ? null
        : resolveHighlight(bodyParas, target.charOffset, target.highlightLength);
    const marked = highlight
      ? bodyParas[highlight.paraIndex].text.slice(
          highlight.offsetInPara,
          highlight.offsetInPara + highlight.length
        )
      : null;

    return { matchOffset, target, bodyParas, highlight, marked };
  };

  it("命中正文时跳对章、标对字", () => {
    const { target, marked, highlight, bodyParas } = searchJump("风很大");

    expect(target.chapterId).toBe(1);
    expect(target.charOffset).toBe(
      BOOK_TEXT.indexOf("风很大") - BOOK_CHAPTERS[1].start
    );
    expect(marked).toBe("风很大");
    // 命中段落是该章第二段正文（标题行已跳过）
    expect(highlight!.paraIndex).toBe(1);
    expect(bodyParas[highlight!.paraIndex].text).toBe("风很大。");
  });

  it("跨章命中各自落在自己那一章", () => {
    const { target, marked } = searchJump("天亮时");

    expect(target.chapterId).toBe(2);
    expect(marked).toBe("天亮时");
  });

  it("命中落在卷标题上时改用其后第一个正文章节，且不高亮（需求 12.5）", () => {
    const { target, highlight } = searchJump("少年");

    expect(target.chapterId).toBe(1);
    expect(target.charOffset).toBe(0);
    expect(target.highlightLength).toBeUndefined();
    expect(highlight).toBeNull();
  });

  it("命中落在章节标题行上时跳到该章，但没有可标的段落", () => {
    const { target, highlight } = searchJump("夜行");

    expect(target.chapterId).toBe(1);
    expect(target.charOffset).toBeGreaterThan(0);
    expect(highlight).toBeNull();
  });

  it("全书每一处命中都能标回原文（逐个匹配交叉验证）", () => {
    for (const term of ["他", "。", "风", "第", "他在夜里出门"]) {
      for (let from = 0; ; ) {
        const at = BOOK_TEXT.indexOf(term, from);
        if (at === -1) break;
        const { marked } = searchJump(term, from);
        // 标出来的要么是命中原文，要么因落在标题行/卷节点上而不标——绝不能标成别的字
        expect(marked === null || marked === term).toBe(true);
        from = at + 1;
      }
    }
  });
});

describe("previewAt", () => {
  const paras = splitParagraphs(CHAPTER_ONE);
  const body = bodyParagraphs(paras, "第一章 夜行");

  it("取偏移所在那一段，不是全章首段", () => {
    const second = body[1];

    expect(previewAt(body, second.offset, 100)).toBe(second.text);
    expect(previewAt(body, second.offset, 100)).not.toBe(body[0].text);
  });

  it("偏移落在段中间时仍从段首截起（不截出读不通的半句）", () => {
    const para = body[0];

    for (let i = 0; i < para.text.length; i++) {
      expect(previewAt(body, para.offset + i, 100)).toBe(para.text);
    }
  });

  it("超过 maxLength 的段落被截断", () => {
    const long: Para[] = [{ offset: 0, text: "甲".repeat(250) }];

    expect(previewAt(long, 0, 100)).toHaveLength(100);
    expect(previewAt(long, 0, 100)).toBe("甲".repeat(100));
    expect(previewAt(long, 0, 1)).toBe("甲");
  });

  it("偏移落在被跳过的标题行 / 章首之前时给出首段（章首书签的预期行为）", () => {
    expect(previewAt(body, 0, 100)).toBe(body[0].text);
    expect(previewAt(body, -5, 100)).toBe(body[0].text);
  });

  it("偏移超出末段时给出末段", () => {
    const last = body[body.length - 1];

    expect(previewAt(body, last.offset + 999, 100)).toBe(last.text);
  });

  it("空段落集合（卷节点、空章）与非正 maxLength 一律空串", () => {
    expect(previewAt([], 0, 100)).toBe("");
    expect(previewAt(body, 0, 0)).toBe("");
    expect(previewAt(body, 0, -3)).toBe("");
    expect(previewAt(body, 0, Number.NaN)).toBe("");
  });

  it("脏偏移按 0 处理，不产出 undefined", () => {
    for (const offset of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(previewAt(body, offset, 100)).toBe(body[0].text);
    }
  });
});

/**
 * `ReaderPage` → 书签记录 → `NavigationDrawer` → 跳回的完整链路镜像，**必须与三者一起改**
 * （需求 2.6，design §2.4 / §3.5）：
 *
 * 1. 按下书签：把当前章内偏移原样存进记录，预览取 `previewAt(bodyParas, offset, 100)`；
 * 2. 点书签：抽屉交出 `(chapterId, charOffset)`，阅读器包成 `JumpTarget` 过
 *    `resolveJumpTarget`——与检索、进度恢复同一个入口；
 * 3. 落位：`findParaIndex(bodyParas, charOffset)` 求出该偏移所在段落，滚到它。
 *
 * 钉住的不变式是需求 2.6 的全部：**跳回去落到的那一段，正是按下书签时所在的那一段**。
 */
describe("书签链路（需求 2.6，design §2.4 / §3.5）", () => {
  const views = buildChapterViews(BOOK_CHAPTERS);

  const bodyOf = (chapterId: number) => {
    const chapter = BOOK_CHAPTERS[chapterId];
    return bodyParagraphs(
      splitParagraphs(BOOK_TEXT.slice(chapter.start, chapter.end)),
      chapter.title
    );
  };

  /** 在某章某偏移处按下书签，得到一条与 `Bookmark` 同形的最小记录。 */
  const addAt = (chapterId: number, charOffset: number) => ({
    chapterId,
    charOffset,
    previewText: previewAt(bodyOf(chapterId), charOffset, 100),
  });

  /** 点这条书签，得到落位的段落下标与归一后的目标。 */
  const jumpBack = (bm: { chapterId: number; charOffset: number }) => {
    const target = resolveJumpTarget(views, {
      chapterId: bm.chapterId,
      charOffset: bm.charOffset,
    })!;
    expect(target).not.toBeNull();
    const body = bodyOf(target.chapterId);
    return { target, body, paraIndex: findParaIndex(body, target.charOffset) };
  };

  it("跳回去落在按下时那一段，预览也取自同一段（逐段全量验证）", () => {
    for (const chapterId of [1, 2]) {
      bodyOf(chapterId).forEach((para, index) => {
        // 段首（滚动落盘的口径）与段中间（记录可能来自任意偏移）都验一遍
        for (const offset of [para.offset, para.offset + 1]) {
          const bm = addAt(chapterId, offset);
          const { target, paraIndex, body } = jumpBack(bm);

          expect(target.chapterId).toBe(chapterId);
          expect(paraIndex).toBe(index);
          expect(body[paraIndex].text).toBe(para.text);
          expect(bm.previewText).toBe(para.text.slice(0, 100));
        }
      });
    }
  });

  it("v1 书签（偏移补 0，任务 31）跳回章首第一段，不报错", () => {
    const { target, paraIndex, body } = jumpBack({ chapterId: 1, charOffset: 0 });

    expect(target.charOffset).toBe(0);
    expect(paraIndex).toBe(0);
    expect(body[0].text).toBe("他在夜里出门。");
  });

  it("书签指向卷节点时改用其后第一个正文章节，偏移作废（需求 12.5）", () => {
    const { target, paraIndex } = jumpBack({ chapterId: 0, charOffset: 4 });

    expect(target.chapterId).toBe(1);
    expect(target.charOffset).toBe(0);
    expect(paraIndex).toBe(0);
  });

  it("书签不带 highlightLength：跳回去不标任何字（书签标的是位置，不是命中）", () => {
    const { target } = jumpBack(addAt(1, bodyOf(1)[1].offset));

    expect(target.highlightLength).toBeUndefined();
  });
});
