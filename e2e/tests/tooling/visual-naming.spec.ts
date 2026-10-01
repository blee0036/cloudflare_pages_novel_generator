/**
 * 像素视觉回归纯函数的无浏览器测试（`tooling` 项目；设计"像素视觉回归"与 Testing Strategy）。
 *
 * - `baselineFile` / `parseBaselineFile` / `baselinePath`：属性 5（基线文件名往返且单射，需求 6.7、
 *   12.2）与定向例子。往返部分另以 `test.info().snapshotPath(`${n}.png`, { kind: "screenshot" })`
 *   核对：它按 `playwright.config.ts` 中 `toHaveScreenshot.pathTemplate` 的真实取值
 *   （`{arg}-{platform}{ext}`，`{arg}` 为去掉 `.png` 的名称、`{platform}` 为 `process.platform`）
 *   算出基线路径，与 `baselinePath(n, process.platform)` 相同，才说明两者"等价"不是只写在注释里。
 * - 属性 6（`maskAreaRatio`）与 `parseScreenshotFailure` 的例子由任务 18.3、18.7 各追加一个 describe。
 */
import { expect, test } from "@playwright/test";
import fc from "fast-check";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VIEWPORTS, VISUAL } from "../../support/settings";
import type { CaseAttachment, CaseFacts } from "../../support/summary";
import { REQUIRED_BASELINE_NAMES } from "../../visual/baselines";
import {
  BASELINE_EXT,
  PLATFORM_PATTERN,
  UPDATE_COMMAND,
  baselineFile,
  baselinePath,
  maskAreaOverLimit,
  maskAreaRatio,
  missingBaselineMessage,
  parseBaselineFile,
  parseMissingBaseline,
  parseScreenshotFailure,
  visualTestTitle,
  type BaselineName,
  type MaskBox,
} from "../../visual/naming";
import {
  VISUAL_SPEC_FILE,
  buildVisualSection,
  paddedSize,
  renderVisualSection,
  type VisualBaselineRef,
  type VisualResult,
} from "../../visual/report";

/** 仓库根（本文件位于 `e2e/tests/tooling/`），也是 `playwright.config.ts` 所在目录。 */
const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));

// ---------------------------------------------------------------------------
// 基线文件名（6.7、12.2）
// ---------------------------------------------------------------------------

/**
 * 属性 5 与参照解析用的格式，按设计原文写成字面量，不从被测代码取：
 * - 名称：`^px-[a-z0-9]+(-[a-z0-9]+)*$`（设计 `BaselineDef.name`）；
 * - 平台：设计写作"任意不含 `-` 的平台标识"，18.1 收窄为 `[a-z0-9]+`（覆盖 `process.platform`
 *   的全部取值），这里按收窄后的格式生成与判定；
 * - 基线目录与扩展名：`e2e/baselines/`、`.png`（6.7）。
 */
const NAME_RE = /^px-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PLATFORM_RE = /^[a-z0-9]+$/;
const BASELINE_DIR = "e2e/baselines";
const EXT = ".png";

/** `@types/node` 中 `NodeJS.Platform` 的全部取值。 */
const NODE_PLATFORMS = [
  "aix",
  "android",
  "darwin",
  "freebsd",
  "haiku",
  "linux",
  "openbsd",
  "sunos",
  "win32",
  "cygwin",
  "netbsd",
] as const satisfies readonly NodeJS.Platform[];

interface Pair {
  readonly name: string;
  readonly platform: string;
}

/**
 * 参照解析：`<name>-<platform>.png` 中平台不含 `-`，所以唯一可能的分法是去掉 `.png` 后在最后一个
 * `-` 处切开；两段都合格时才是 `baselineFile` 能产生的文件名，否则为 null。
 */
function referenceParse(fileName: string): Pair | null {
  if (!fileName.endsWith(EXT)) return null;
  const stem = fileName.slice(0, -EXT.length);
  const i = stem.lastIndexOf("-");
  if (i < 0) return null;
  const name = stem.slice(0, i);
  const platform = stem.slice(i + 1);
  return NAME_RE.test(name) && PLATFORM_RE.test(platform) ? { name, platform } : null;
}

/** Playwright 按 `toHaveScreenshot.pathTemplate` 为 `toHaveScreenshot(`${name}.png`)` 算出的基线绝对路径。 */
function playwrightBaselinePath(name: string): string {
  return test.info().snapshotPath(`${name}${EXT}`, { kind: "screenshot" });
}

/**
 * 属性 5 的正向判定（单个 (n, p)）：
 * - 文件名为 `${n}-${p}.png`，全小写（Windows 文件系统不区分大小写，大小写不同的两个名称会落到
 *   同一个文件，全小写才谈得上单射）；
 * - `parseBaselineFile` 取回 `{ name: n, platform: p }`，参照解析也如此；
 * - `baselinePath` 为 `e2e/baselines/<文件名>`；
 * - 与 Playwright 的 `pathTemplate` 等价：`snapshotPath(`${n}.png`)` 等于
 *   `baselinePath(n, process.platform)` 的绝对路径（`{platform}` 只能是本机平台）。
 *
 * 属性内用 `node:assert` 而不是 Playwright 的 `expect`，理由同 `server-resolve.spec.ts`：
 * 每次 `expect` 都会在报告里记一个步骤。
 */
function assertRoundTrip({ name, platform }: Pair): void {
  const where = `name=${JSON.stringify(name)} platform=${JSON.stringify(platform)}`;
  const file = baselineFile(name, platform);
  assert.equal(file, `${name}-${platform}${EXT}`, `文件名（${where}）`);
  assert.equal(file, file.toLowerCase(), `文件名应全小写（${where}）`);
  assert.deepEqual(parseBaselineFile(file), { name, platform }, `往返（${where}）`);
  assert.deepEqual(referenceParse(file), { name, platform }, `参照解析（${where}）`);
  assert.equal(baselinePath(name, platform), `${BASELINE_DIR}/${file}`, `baselinePath（${where}）`);

  const local = path.resolve(REPO_ROOT, baselinePath(name, process.platform));
  assert.equal(playwrightBaselinePath(name), local, `与 pathTemplate 等价（${where}）`);
}

// ---------------------------------------------------------------------------
// 生成器
// ---------------------------------------------------------------------------

const ALNUM = [..."abcdefghijklmnopqrstuvwxyz0123456789"];

function alnumArb(maxLength: number): fc.Arbitrary<string> {
  return fc.string({ unit: fc.constantFrom(...ALNUM), minLength: 1, maxLength });
}

/**
 * 名称的一段：随机字母数字，或容易诱使解析器切错的片段：平台名（名称末段与平台同形）、`px`、
 * `png`、真实基线名里的词与单个数字。
 */
const segmentArb = fc.oneof(
  alnumArb(8),
  fc.constantFrom(...NODE_PLATFORMS, "px", "png", "shelf", "reader", "desktop", "mobile", "0"),
);

/** 名称的各段（`px-` 之后以 `-` 连接）；保留分段，供单射部分构造"挪动分界"的对照。 */
const segmentsArb = fc.array(segmentArb, { minLength: 1, maxLength: 5 });

function toName(segments: readonly string[]): string {
  return `px-${segments.join("-")}`;
}

const nameArb = segmentsArb.map(toName);

/** 平台：Node 的全部取值，或任意非空字母数字串（含与名称段同形的串）。 */
const platformArb = fc.oneof(fc.constantFrom(...NODE_PLATFORMS), alnumArb(10));

const pairArb: fc.Arbitrary<Pair> = fc.record({ name: nameArb, platform: platformArb });

/**
 * 单射部分的输入：一对 (a, b)，b 由 a 派生，偏向文件名相近的情形：
 * 同一对、只换平台、只换名称、名称吞下原平台作为末段、名称让出末段作为平台，或完全独立的一对。
 */
const pairPairArb: fc.Arbitrary<[Pair, Pair]> = fc
  .tuple(segmentsArb, platformArb)
  .chain(([segments, platform]) => {
    const a: Pair = { name: toName(segments), platform };
    const variants: fc.Arbitrary<Pair>[] = [
      fc.constant(a),
      platformArb.map((q) => ({ name: a.name, platform: q })),
      nameArb.map((m) => ({ name: m, platform })),
      platformArb.map((q) => ({ name: `${a.name}-${platform}`, platform: q })),
      pairArb,
    ];
    if (segments.length > 1) {
      variants.push(fc.constant({ name: toName(segments.slice(0, -1)), platform: segments[segments.length - 1] }));
    }
    return fc.tuple(fc.constant(a), fc.oneof(...variants));
  });

/** 在合法文件名中删除、替换或插入一个字符（替换与插入的字符偏向 `-`、`.`、大写与空白）。 */
const editedFileArb = fc
  .tuple(
    pairArb,
    fc.nat(),
    fc.constantFrom("delete", "replace", "insert"),
    fc.oneof(fc.constantFrom("-", ".", "_", "/", "\\", " ", "\n", "P", "X", "G"), fc.string({ unit: "binary", minLength: 1, maxLength: 1 })),
  )
  .map(([pair, n, op, ch]) => {
    const file = baselineFile(pair.name, pair.platform);
    const i = n % (file.length + 1);
    if (op === "delete") return file.slice(0, i) + file.slice(i + 1);
    if (op === "replace") return file.slice(0, i) + ch + file.slice(i + 1);
    return file.slice(0, i) + ch + file.slice(i);
  });

/** 合法文件名前后加东西：目录、重复扩展名、行尾换行、大写扩展名等。 */
const wrappedFileArb = fc
  .tuple(pairArb, fc.constantFrom("dir/", "e2e/baselines/", " ", "\ufeff", ""), fc.constantFrom(".png", "\n", " ", "", "x"))
  .map(([pair, prefix, suffix]) => prefix + baselineFile(pair.name, pair.platform) + suffix);

/** 反向部分的输入：任意串、近似字母表上的串、合法文件名及其单字符编辑与包装。 */
const anyFileNameArb = fc.oneof(
  { weight: 1, arbitrary: fc.string({ unit: "binary", maxLength: 30 }) },
  { weight: 2, arbitrary: fc.string({ unit: fc.constantFrom(..."px-a09.ngPX_ \n"), maxLength: 30 }) },
  { weight: 1, arbitrary: pairArb.map((pair) => baselineFile(pair.name, pair.platform)) },
  { weight: 2, arbitrary: editedFileArb },
  { weight: 1, arbitrary: wrappedFileArb },
);

test.describe("基线文件名：baselineFile、parseBaselineFile、baselinePath（需求 6.7、12.2）", () => {
  // Feature: e2e-visual-testing, Property 5: 基线文件名往返且单射
  // **Validates: Requirements 6.7, 12.2**
  test("属性 5：parseBaselineFile(baselineFile(n, p)) 等于 { name: n, platform: p }，且与 pathTemplate 等价；不同的 (n, p) 得到不同的文件名；任意串解析为 null 或能原样生成它的 (n, p)", () => {
    fc.assert(
      fc.property(pairArb, (pair) => {
        assertRoundTrip(pair);
      }),
      { numRuns: 100 },
    );
    fc.assert(
      fc.property(pairPairArb, ([a, b]) => {
        const fa = baselineFile(a.name, a.platform);
        const fb = baselineFile(b.name, b.platform);
        const samePair = a.name === b.name && a.platform === b.platform;
        assert.equal(fa === fb, samePair, `a=${JSON.stringify(a)} → ${fa}，b=${JSON.stringify(b)} → ${fb}`);
      }),
      { numRuns: 100 },
    );
    fc.assert(
      fc.property(anyFileNameArb, (s) => {
        const where = `s=${JSON.stringify(s)}`;
        const parsed = parseBaselineFile(s);
        assert.deepEqual(parsed, referenceParse(s), `与参照解析一致（${where}）`);
        if (parsed !== null) assert.equal(baselineFile(parsed.name, parsed.platform), s, `解析结果应原样生成 s（${where}）`);
      }),
      { numRuns: 100 },
    );
  });

  // -------------------------------------------------------------------------
  // 例子
  // -------------------------------------------------------------------------

  test("12.2 的 13 个名称以本机平台生成 13 个不同的文件名，均能往返，且与 pathTemplate 等价", () => {
    expect(REQUIRED_BASELINE_NAMES).toHaveLength(13);
    expect(process.platform).toMatch(PLATFORM_RE);
    for (const name of REQUIRED_BASELINE_NAMES) {
      expect(name, name).toMatch(NAME_RE);
      assertRoundTrip({ name, platform: process.platform });
    }
    const files = REQUIRED_BASELINE_NAMES.map((name) => baselineFile(name, process.platform));
    expect(new Set(files).size).toBe(REQUIRED_BASELINE_NAMES.length);
  });

  test("文件名与路径的字面量：<name>-<platform>.png，位于 e2e/baselines/", () => {
    expect(BASELINE_EXT).toBe(EXT);
    expect(baselineFile("px-shelf-desktop", "win32")).toBe("px-shelf-desktop-win32.png");
    expect(baselineFile("px-reader-dark", "linux")).toBe("px-reader-dark-linux.png");
    expect(baselinePath("px-toc-volumes", "darwin")).toBe("e2e/baselines/px-toc-volumes-darwin.png");
    expect(parseBaselineFile("px-shelf-desktop-win32.png")).toEqual({ name: "px-shelf-desktop", platform: "win32" });
    expect(parseBaselineFile("px-a-0.png")).toEqual({ name: "px-a", platform: "0" });
  });

  test("Node 的全部平台取值都符合 PLATFORM_PATTERN，baselineFile 不对它们抛错", () => {
    for (const platform of NODE_PLATFORMS) {
      expect(PLATFORM_PATTERN.test(platform), platform).toBe(true);
      expect(parseBaselineFile(baselineFile("px-x", platform))).toEqual({ name: "px-x", platform });
    }
  });

  test("名称或平台不合格时 baselineFile 与 baselinePath 抛 RangeError", () => {
    const badNames = [
      "",
      "px",
      "px-",
      "px--a",
      "px-a-",
      "px-a--b",
      "PX-a",
      "px-A",
      "px-a_b",
      "px-a.b",
      "px-a b",
      "px-a/b",
      "px-阅读",
      "px-a\n",
      " px-a",
      "qx-a",
      "a-px-b",
      "px-a.png",
    ];
    for (const name of badNames) {
      expect(() => baselineFile(name, "win32"), JSON.stringify(name)).toThrow(RangeError);
      expect(() => baselinePath(name, "win32"), JSON.stringify(name)).toThrow(RangeError);
    }
    const badPlatforms = ["", "win-32", "Win32", "win32 ", " linux", "linux\n", "a.b", "x/y", "x_y", "平台"];
    for (const platform of badPlatforms) {
      expect(() => baselineFile("px-shelf-desktop", platform), JSON.stringify(platform)).toThrow(RangeError);
      expect(() => baselinePath("px-shelf-desktop", platform), JSON.stringify(platform)).toThrow(RangeError);
    }
  });

  test("parseBaselineFile 对 baselineFile 不会产生的文件名返回 null，从不抛错", () => {
    const notBaselineFiles = [
      "",
      ".png",
      "px-win32.png", // 名称只有 px，缺少 `px-` 之后的段
      "px-shelf-desktop-win32", // 缺扩展名
      "px-shelf-desktop-win32.PNG",
      "px-shelf-desktop-Win32.png",
      "PX-shelf-desktop-win32.png",
      "px-shelf-desktop-win32.png.png",
      "px-shelf-desktop-win32.png\n",
      "px-shelf--win32.png",
      "px-shelf-desktop-.png",
      "px-shelf_desktop-win32.png",
      "e2e/baselines/px-shelf-desktop-win32.png",
      "e2e\\baselines\\px-shelf-desktop-win32.png",
      "px-shelf-desktop-win32.jpg",
    ];
    for (const fileName of notBaselineFiles) {
      expect(parseBaselineFile(fileName), JSON.stringify(fileName)).toBeNull();
    }
    // 运行时传入非字符串（如目录项取值出错）同样返回 null
    expect(parseBaselineFile(null as unknown as string)).toBeNull();
    expect(parseBaselineFile(undefined as unknown as string)).toBeNull();
    expect(parseBaselineFile(42 as unknown as string)).toBeNull();
  });

  test("缺平台段的文件名按最后一个 `-` 切分，平台落在名称的末段上：目录核对须比对平台是否为本机平台", () => {
    // `px-shelf-desktop.png` 形如合法文件名 `px-shelf` + `desktop` 平台；这不违背单射，但说明
    // 目录核对（12.2、任务 18.9）不能只看解析结果是否为 null
    expect(parseBaselineFile("px-shelf-desktop.png")).toEqual({ name: "px-shelf", platform: "desktop" });
    expect(parseBaselineFile("px-shelf.png")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 遮罩面积（12.3）
// ---------------------------------------------------------------------------

/**
 * 逐像素参照模型：像素 (px, py) 占据单位方格 [px, px+1) × [py, py+1)，整数框
 * [x, x+width) × [y, y+height) 覆盖它当且仅当 x ≤ px < x+width 且 y ≤ py < y+height。
 * 先在视口大小的栅格上逐框累加每个像素被覆盖的次数，再求和：重叠像素按框分别计入
 * （12.3 的"合计面积"），视口外与宽高 ≤ 0 的框自然不覆盖任何像素。不做任何区间裁剪计算，
 * 与被测实现的写法无关。
 */
function rasterCount(boxes: readonly MaskBox[], w: number, h: number): number {
  const cover = new Uint32Array(w * h);
  for (const b of boxes) {
    for (let py = 0; py < h; py++) {
      if (py < b.y || py >= b.y + b.height) continue;
      for (let px = 0; px < w; px++) {
        if (px >= b.x && px < b.x + b.width) cover[py * w + px] += 1;
      }
    }
  }
  let n = 0;
  for (const c of cover) n += c;
  return n;
}

/**
 * 12.3 的上限"不得超过截图面积的 5%"以整数表述：count / (w·h) > 1/20 ⟺ 20·count > w·h。
 * 本文件的视口至多 1280×800，两侧之差至少 1/(20·w·h) ≈ 5e-8，远大于 0.05 附近的浮点间距，
 * 所以浮点比较 `ratio > 0.05` 与这个整数判定不会因舍入而分歧。
 */
function overLimitReference(count: number, w: number, h: number): boolean {
  return 20 * count > w * h;
}

/**
 * 属性 6 的判定（单个视口与整数框列表）：
 * - `maskAreaRatio` 严格等于逐像素计数除以 w·h（两边都是整数除以同一整数，舍入相同）；
 * - `maskAreaOverLimit` 与整数判定 `20·count > w·h` 一致，也与 `ratio > 0.05` 一致（等于上限不算超限）。
 */
function assertMaskModel(boxes: readonly MaskBox[], w: number, h: number): void {
  const where = `viewport=${w}×${h} boxes=${JSON.stringify(boxes)}`;
  const count = rasterCount(boxes, w, h);
  const ratio = maskAreaRatio(boxes, { width: w, height: h });
  assert.equal(ratio, count / (w * h), `面积比等于逐像素计数 ${count} / ${w * h}（${where}）`);
  const over = maskAreaOverLimit(ratio);
  assert.equal(over, overLimitReference(count, w, h), `超限判定与 20·count > w·h 一致（${where}）`);
  assert.equal(over, ratio > 0.05, `超限判定当且仅当 ratio > 0.05（${where}）`);
}

/** 与 x 相邻的下一个（dir = 1）或上一个（dir = -1）双精度数；只用于正有限数。 */
function adjacentDouble(x: number, dir: 1 | -1): number {
  const buf = new Float64Array([x]);
  new BigInt64Array(buf.buffer)[0] += BigInt(dir);
  return buf[0];
}

// ---------------------------------------------------------------------------
// 生成器
// ---------------------------------------------------------------------------

/**
 * 小视口（至多 64×64），逐像素参照模型因此足够快。宽取 20、40、60 时 w·h 是 20 的倍数，
 * 恰好 5% 的像素数是整数，边界生成器才能落在"等于上限"上。
 */
const viewportArb = fc.record({
  width: fc.oneof(fc.integer({ min: 1, max: 64 }), fc.constantFrom(20, 40, 60)),
  height: fc.integer({ min: 1, max: 64 }),
});

/**
 * 一个整数框，偏向四类情形：
 * - 小框（边长至多视口的 1/4，也可为 0 或负），使面积比常落在 5% 上下；
 * - 任意框（起点可在视口外两倍处，边长可达视口三倍），常越出视口、互相重叠；
 * - 完全在视口外（左、右、上、下，另一轴上的范围可以很大）；
 * - 宽或高为负（含起点在视口右侧、"向左延伸"会盖住视口的情形），应视为空框。
 */
function boxArb(w: number, h: number): fc.Arbitrary<MaskBox> {
  const small = fc.record({
    x: fc.integer({ min: -8, max: w + 8 }),
    y: fc.integer({ min: -8, max: h + 8 }),
    width: fc.integer({ min: -2, max: Math.ceil(w / 4) }),
    height: fc.integer({ min: -2, max: Math.ceil(h / 4) }),
  });
  const any = fc.record({
    x: fc.integer({ min: -2 * w, max: 2 * w }),
    y: fc.integer({ min: -2 * h, max: 2 * h }),
    width: fc.integer({ min: 0, max: 3 * w }),
    height: fc.integer({ min: 0, max: 3 * h }),
  });
  const outside = fc
    .tuple(
      fc.constantFrom("left", "right", "above", "below"),
      fc.nat(8),
      fc.nat(8),
      fc.integer({ min: -2 * Math.max(w, h), max: 2 * Math.max(w, h) }),
      fc.integer({ min: 0, max: 3 * Math.max(w, h) }),
    )
    .map(([side, gap, size, offset, span]): MaskBox => {
      switch (side) {
        case "left":
          return { x: -gap - size, y: offset, width: size, height: span }; // 右边缘 ≤ 0
        case "right":
          return { x: w + gap, y: offset, width: size, height: span }; // 左边缘 ≥ w
        case "above":
          return { x: offset, y: -gap - size, width: span, height: size };
        default:
          return { x: offset, y: h + gap, width: span, height: size };
      }
    });
  const negative = fc
    .record({
      x: fc.integer({ min: -w, max: 2 * w }),
      y: fc.integer({ min: -h, max: 2 * h }),
      width: fc.integer({ min: -3 * w, max: 3 * w }),
      height: fc.integer({ min: -3 * h, max: 3 * h }),
    })
    .filter((b) => b.width < 0 || b.height < 0);
  return fc.oneof(
    { weight: 3, arbitrary: small },
    { weight: 3, arbitrary: any },
    { weight: 1, arbitrary: outside },
    { weight: 1, arbitrary: negative },
  );
}

/** 视口与至多 8 个框（可为空列表）。 */
const maskScenarioArb = viewportArb.chain(({ width: w, height: h }) =>
  fc.tuple(fc.constant({ w, h }), fc.array(boxArb(w, h), { maxLength: 8 })),
);

/**
 * 边界情形：覆盖像素数 k 取 ⌊w·h/20⌋ + δ（δ ∈ [-2, 2]，截到 [0, w·h]），即 5% 上下几个像素。
 * 以"整行框 + 余数框"铺出恰好 k 个像素：整行框左右各越出视口若干像素（越出部分不计），
 * 另混入若干完全在视口外或宽高为负的框（都不计）。生成器自身的正确性由逐像素计数核对。
 */
const boundaryScenarioArb = viewportArb.chain(({ width: w, height: h }) =>
  fc
    .tuple(
      fc.integer({ min: -2, max: 2 }),
      fc.nat(4),
      fc.nat(4),
      fc.array(
        fc.constantFrom<MaskBox>(
          { x: w, y: 0, width: 5, height: h },
          { x: -5, y: 0, width: 5, height: h },
          { x: 0, y: h + 1, width: w, height: 3 },
          { x: w - 1, y: 0, width: -w, height: h },
          { x: 0, y: 0, width: w, height: -1 },
        ),
        { maxLength: 3 },
      ),
    )
    .map(([delta, overLeft, overRight, zeroBoxes]) => {
      const k = Math.min(Math.max(Math.floor((w * h) / 20) + delta, 0), w * h);
      const rows = Math.floor(k / w);
      const rest = k % w;
      const boxes: MaskBox[] = [...zeroBoxes];
      if (rows > 0) boxes.push({ x: -overLeft, y: 0, width: w + overLeft + overRight, height: rows });
      if (rest > 0) boxes.push({ x: 0, y: rows, width: rest, height: 1 });
      return { w, h, k, boxes };
    }),
);

test.describe("遮罩面积：maskAreaRatio、maskAreaOverLimit（需求 12.3）", () => {
  // Feature: e2e-visual-testing, Property 6: 遮罩面积比与逐像素模型一致
  // **Validates: Requirements 12.3**
  test("属性 6：任意视口与整数框列表（越出视口、重叠、完全在视口外、宽高为负），面积比等于各框落在视口内的像素数之和除以 w·h；超限当且仅当面积比 > 5%", () => {
    fc.assert(
      fc.property(maskScenarioArb, ([{ w, h }, boxes]) => {
        assertMaskModel(boxes, w, h);
      }),
      { numRuns: 100 },
    );
    fc.assert(
      fc.property(boundaryScenarioArb, ({ w, h, k, boxes }) => {
        assert.equal(rasterCount(boxes, w, h), k, `边界生成器应恰好覆盖 ${k} 个像素（${w}×${h}，${JSON.stringify(boxes)}）`);
        assertMaskModel(boxes, w, h);
      }),
      { numRuns: 100 },
    );
  });

  // -------------------------------------------------------------------------
  // 例子
  // -------------------------------------------------------------------------

  test("上限取自 12.3 的 5%；等于上限不算超限，上限之上的下一个浮点数算超限", () => {
    expect(VISUAL.maxMaskRatio).toBe(0.05);
    expect(maskAreaOverLimit(0)).toBe(false);
    expect(maskAreaOverLimit(adjacentDouble(0.05, -1))).toBe(false);
    expect(maskAreaOverLimit(0.05)).toBe(false);
    expect(maskAreaOverLimit(adjacentDouble(0.05, 1))).toBe(true);
    expect(maskAreaOverLimit(1)).toBe(true);
    expect(maskAreaOverLimit(2)).toBe(true);
  });

  test("真实视口的 5% 边界：桌面 1280×800 为 51,200 像素，移动 390×844 为 16,458 像素；多 1 像素即超限", () => {
    const { desktop, mobile } = VIEWPORTS;
    const cases: { label: string; w: number; h: number; boxes: MaskBox[]; ratio: number; over: boolean }[] = [
      // 桌面：整 40 行恰为 5%
      { label: "桌面整 40 行", w: desktop.width, h: desktop.height, boxes: [{ x: 0, y: 0, width: 1280, height: 40 }], ratio: 0.05, over: false },
      {
        label: "桌面整 40 行 + 1 像素",
        w: desktop.width,
        h: desktop.height,
        boxes: [
          { x: 0, y: 0, width: 1280, height: 40 },
          { x: 0, y: 40, width: 1, height: 1 },
        ],
        ratio: 51_201 / 1_024_000,
        over: true,
      },
      // 越出视口的部分不计：裁剪后仍是 1280×40
      { label: "桌面越界框", w: desktop.width, h: desktop.height, boxes: [{ x: -100, y: -100, width: 1480, height: 140 }], ratio: 0.05, over: false },
      // 重叠按框分别计入：两个相同的 1280×20 合计 51,200（取并集只有 2.5%）
      {
        label: "桌面两框完全重叠",
        w: desktop.width,
        h: desktop.height,
        boxes: [
          { x: 0, y: 0, width: 1280, height: 20 },
          { x: 0, y: 0, width: 1280, height: 20 },
        ],
        ratio: 0.05,
        over: false,
      },
      // 移动：78 × 211 = 16,458 恰为 5%
      { label: "移动 78×211", w: mobile.width, h: mobile.height, boxes: [{ x: 0, y: 0, width: 78, height: 211 }], ratio: 0.05, over: false },
      {
        label: "移动 78×211 + 1 像素",
        w: mobile.width,
        h: mobile.height,
        boxes: [
          { x: 0, y: 0, width: 78, height: 211 },
          { x: 200, y: 500, width: 1, height: 1 },
        ],
        ratio: 16_459 / 329_160,
        over: true,
      },
    ];
    for (const c of cases) {
      const ratio = maskAreaRatio(c.boxes, { width: c.w, height: c.h });
      expect(ratio, c.label).toBe(c.ratio);
      expect(maskAreaOverLimit(ratio), c.label).toBe(c.over);
      expect(rasterCount(c.boxes, c.w, c.h) / (c.w * c.h), `${c.label}：逐像素参照`).toBe(c.ratio);
    }
  });

  test("合计面积可超过 1；空列表、完全在视口外、宽或高为 0 或负的框计 0", () => {
    const vp = VIEWPORTS.desktop;
    const full: MaskBox = { x: -10, y: -10, width: 2000, height: 2000 };
    expect(maskAreaRatio([], vp)).toBe(0);
    expect(maskAreaRatio([full], vp)).toBe(1);
    expect(maskAreaRatio([full, full], vp)).toBe(2);
    const zeroBoxes: MaskBox[] = [
      { x: 1280, y: 0, width: 10, height: 800 }, // 右侧紧贴视口
      { x: -10, y: 0, width: 10, height: 800 }, // 左侧紧贴视口
      { x: 0, y: 800, width: 1280, height: 5 }, // 下方紧贴视口
      { x: 10, y: 10, width: 0, height: 100 },
      { x: 10, y: 10, width: 100, height: 0 },
      { x: 1290, y: 0, width: -2000, height: 800 }, // 负宽：不当作 [-710, 1290)
      { x: 0, y: 900, width: 1280, height: -2000 },
      { x: 10, y: 10, width: -5, height: -5 },
    ];
    for (const box of zeroBoxes) expect(maskAreaRatio([box], vp), JSON.stringify(box)).toBe(0);
    expect(maskAreaRatio(zeroBoxes, vp)).toBe(0);
  });

  test("小数框按连续面积计：坐标为 1/4 的整数倍时，等于放大 4 倍后逐像素计数的结果", () => {
    const vp = { width: 100, height: 100 };
    expect(maskAreaRatio([{ x: 0.5, y: 0.5, width: 10, height: 10 }], vp)).toBe(0.01);
    expect(maskAreaRatio([{ x: -0.5, y: -0.25, width: 1, height: 1 }], vp)).toBe((0.5 * 0.75) / 10_000);
    expect(maskAreaRatio([{ x: 99.5, y: 0, width: 5, height: 2 }], vp)).toBe(1 / 10_000);

    const small = { width: 10, height: 6 };
    const quarterBoxes: MaskBox[] = [
      { x: 0.25, y: 0.5, width: 2.75, height: 1.25 },
      { x: -1.5, y: 4.75, width: 3, height: 2 },
      { x: 9.5, y: -0.25, width: 0.75, height: 3 },
      { x: 3.75, y: 1, width: 2.5, height: 2.5 },
      { x: 4, y: 2, width: 1.25, height: 0.75 }, // 与上一框重叠
    ];
    const scaled = quarterBoxes.map((b) => ({ x: b.x * 4, y: b.y * 4, width: b.width * 4, height: b.height * 4 }));
    expect(maskAreaRatio(quarterBoxes, small)).toBe(rasterCount(scaled, 40, 24) / (40 * 24));
  });

  test("视口宽高不是正的有限数，或框含非有限值时抛 RangeError", () => {
    const box: MaskBox = { x: 0, y: 0, width: 10, height: 10 };
    const badViewports = [
      { width: 0, height: 800 },
      { width: 1280, height: 0 },
      { width: -1280, height: 800 },
      { width: 1280, height: -800 },
      { width: Number.NaN, height: 800 },
      { width: 1280, height: Number.NaN },
      { width: Number.POSITIVE_INFINITY, height: 800 },
      { width: 1280, height: Number.POSITIVE_INFINITY },
    ];
    for (const vp of badViewports) {
      expect(() => maskAreaRatio([box], vp), JSON.stringify(vp)).toThrow(RangeError);
      expect(() => maskAreaRatio([], vp), `${JSON.stringify(vp)}，空列表`).toThrow(RangeError);
    }
    const badBoxes: MaskBox[] = [
      { ...box, x: Number.NaN },
      { ...box, y: Number.NaN },
      { ...box, width: Number.NaN },
      { ...box, height: Number.NaN },
      { ...box, x: Number.NEGATIVE_INFINITY },
      { ...box, width: Number.POSITIVE_INFINITY },
      { ...box, height: Number.NEGATIVE_INFINITY },
    ];
    for (const bad of badBoxes) {
      // 非有限值的框排在合法框之后也要报错，不能被前面的累加掩盖
      expect(() => maskAreaRatio([box, bad], VIEWPORTS.desktop), String(Object.values(bad))).toThrow(RangeError);
    }
  });
});

// ---------------------------------------------------------------------------
// toHaveScreenshot 的报错（12.5）
// ---------------------------------------------------------------------------

/*
 * 以下报错串与附件录自锁定版本 @playwright/test 1.62.1 的真实运行（Windows、Chromium），是
 * `TestResult.errors[].message` 的原文（含 ANSI 转义，与 `support/reporter.ts` 交给 `CaseFacts` 的
 * 内容同源）。录取方式：在 `e2e/.out/` 下用一次性配置（容差、`animations`、`caret`、`scale` 同
 * `playwright.config.ts`，视口 1280×800，`updateSnapshots: "none"`）与用例，在 `page.setContent`
 * 的纯色页面上先以 `page.screenshot` 写出基线，再改页面或视口后调用
 * `expect(page).toHaveScreenshot("<名称>.png")`；一次性 reporter 把报错与附件写成 JSON，这里逐行
 * `JSON.stringify` 抄入，`join("\n")` 还原原文。录完即删，未触及 `e2e/baselines/`。基线名为录取时的
 * `px-capture-*`；附件路径保留其相对仓库根的原值（录取目录 `e2e/.out/tmp-capture/`），用时以本机
 * 仓库根补成绝对路径。
 */

/** 白底基线；实际在 (100, 100) 处多一块 150×100 的红块：15,000 个差异像素，1,024,000 像素中占 1.46%。 */
const PIXELS_ERROR = [
  "Error: \u001b[2mexpect(\u001b[22m\u001b[31mpage\u001b[39m\u001b[2m).\u001b[22mtoHaveScreenshot\u001b[2m(\u001b[22m\u001b[32mexpected\u001b[39m\u001b[2m)\u001b[22m failed",
  "",
  "  15000 pixels (ratio 0.02 of all image pixels) are different.",
  "",
  "  Snapshot: px-capture-pixels.png",
  "",
  "Call log:",
  "\u001b[2m  - Expect \"toHaveScreenshot(px-capture-pixels.png)\" with timeout 10000ms\u001b[22m",
  "\u001b[2m    - verifying given screenshot expectation\u001b[22m",
  "\u001b[2m  - taking page screenshot\u001b[22m",
  "\u001b[2m    - disabled all CSS animations\u001b[22m",
  "\u001b[2m  - waiting for fonts to load...\u001b[22m",
  "\u001b[2m  - fonts loaded\u001b[22m",
  "\u001b[2m  - 15000 pixels (ratio 0.02 of all image pixels) are different.\u001b[22m",
  "\u001b[2m  - waiting 100ms before taking screenshot\u001b[22m",
  "\u001b[2m  - taking page screenshot\u001b[22m",
  "\u001b[2m    - disabled all CSS animations\u001b[22m",
  "\u001b[2m  - waiting for fonts to load...\u001b[22m",
  "\u001b[2m  - fonts loaded\u001b[22m",
  "\u001b[2m  - captured a stable screenshot\u001b[22m",
  "\u001b[2m  - 15000 pixels (ratio 0.02 of all image pixels) are different.\u001b[22m",
  "",
].join("\n");

const PIXELS_ATTACHMENTS: readonly CaseAttachment[] = [
  { name: "px-capture-pixels-expected.png", path: "e2e/.out/tmp-capture/snap/px-capture-pixels-win32.png" },
  { name: "px-capture-pixels-actual.png", path: "e2e/.out/tmp-capture/test-results/capture-pixels/px-capture-pixels-actual.png" },
  { name: "px-capture-pixels-diff.png", path: "e2e/.out/tmp-capture/test-results/capture-pixels/px-capture-pixels-diff.png" },
  { name: "error-context", path: "e2e/.out/tmp-capture/test-results/capture-pixels/error-context.md" },
];

/**
 * 深色底基线 1280×800；实际视口改为 1280×810，另在 (100, 100) 处多一块 78×100 的红块。补齐出的
 * 10 行（透明，按白色参与比对）与红块合计 12,800 + 7,800 = 20,600 个差异像素。
 */
const SIZE_PIXELS_ERROR = [
  "Error: \u001b[2mexpect(\u001b[22m\u001b[31mpage\u001b[39m\u001b[2m).\u001b[22mtoHaveScreenshot\u001b[2m(\u001b[22m\u001b[32mexpected\u001b[39m\u001b[2m)\u001b[22m failed",
  "",
  "  Expected an image 1280px by 800px, received 1280px by 810px. 20600 pixels (ratio 0.02 of all image pixels) are different.",
  "",
  "  Snapshot: px-capture-size-pixels.png",
  "",
  "Call log:",
  "\u001b[2m  - Expect \"toHaveScreenshot(px-capture-size-pixels.png)\" with timeout 10000ms\u001b[22m",
  "\u001b[2m    - verifying given screenshot expectation\u001b[22m",
  "\u001b[2m  - taking page screenshot\u001b[22m",
  "\u001b[2m    - disabled all CSS animations\u001b[22m",
  "\u001b[2m  - waiting for fonts to load...\u001b[22m",
  "\u001b[2m  - fonts loaded\u001b[22m",
  "\u001b[2m  - Expected an image 1280px by 800px, received 1280px by 810px. 20600 pixels (ratio 0.02 of all image pixels) are different.\u001b[22m",
  "\u001b[2m  - waiting 100ms before taking screenshot\u001b[22m",
  "\u001b[2m  - taking page screenshot\u001b[22m",
  "\u001b[2m    - disabled all CSS animations\u001b[22m",
  "\u001b[2m  - waiting for fonts to load...\u001b[22m",
  "\u001b[2m  - fonts loaded\u001b[22m",
  "\u001b[2m  - captured a stable screenshot\u001b[22m",
  "\u001b[2m  - Expected an image 1280px by 800px, received 1280px by 810px. 20600 pixels (ratio 0.02 of all image pixels) are different.\u001b[22m",
  "",
].join("\n");

const SIZE_PIXELS_ATTACHMENTS: readonly CaseAttachment[] = [
  { name: "px-capture-size-pixels-expected.png", path: "e2e/.out/tmp-capture/snap/px-capture-size-pixels-win32.png" },
  {
    name: "px-capture-size-pixels-actual.png",
    path: "e2e/.out/tmp-capture/test-results/capture-size-and-pixels/px-capture-size-pixels-actual.png",
  },
  {
    name: "px-capture-size-pixels-diff.png",
    path: "e2e/.out/tmp-capture/test-results/capture-size-and-pixels/px-capture-size-pixels-diff.png",
  },
  { name: "error-context", path: "e2e/.out/tmp-capture/test-results/capture-size-and-pixels/error-context.md" },
];

/** 白底基线 1280×800；实际视口改为 1280×810、内容不变。补齐的透明行按白色比对，差异为 0，只有尺寸句。 */
const SIZE_ONLY_ERROR = [
  "Error: \u001b[2mexpect(\u001b[22m\u001b[31mpage\u001b[39m\u001b[2m).\u001b[22mtoHaveScreenshot\u001b[2m(\u001b[22m\u001b[32mexpected\u001b[39m\u001b[2m)\u001b[22m failed",
  "",
  "  Expected an image 1280px by 800px, received 1280px by 810px. ",
  "",
  "  Snapshot: px-capture-size-only.png",
  "",
  "Call log:",
  "\u001b[2m  - Expect \"toHaveScreenshot(px-capture-size-only.png)\" with timeout 10000ms\u001b[22m",
  "\u001b[2m    - verifying given screenshot expectation\u001b[22m",
  "\u001b[2m  - taking page screenshot\u001b[22m",
  "\u001b[2m    - disabled all CSS animations\u001b[22m",
  "\u001b[2m  - waiting for fonts to load...\u001b[22m",
  "\u001b[2m  - fonts loaded\u001b[22m",
  "\u001b[2m  - Expected an image 1280px by 800px, received 1280px by 810px.\u001b[22m",
  "\u001b[2m  - waiting 100ms before taking screenshot\u001b[22m",
  "\u001b[2m  - taking page screenshot\u001b[22m",
  "\u001b[2m    - disabled all CSS animations\u001b[22m",
  "\u001b[2m  - waiting for fonts to load...\u001b[22m",
  "\u001b[2m  - fonts loaded\u001b[22m",
  "\u001b[2m  - captured a stable screenshot\u001b[22m",
  "\u001b[2m  - Expected an image 1280px by 800px, received 1280px by 810px.\u001b[22m",
  "",
].join("\n");

const SIZE_ONLY_ATTACHMENTS: readonly CaseAttachment[] = [
  { name: "px-capture-size-only-expected.png", path: "e2e/.out/tmp-capture/snap/px-capture-size-only-win32.png" },
  { name: "px-capture-size-only-actual.png", path: "e2e/.out/tmp-capture/test-results/capture-size-only/px-capture-size-only-actual.png" },
  { name: "px-capture-size-only-diff.png", path: "e2e/.out/tmp-capture/test-results/capture-size-only/px-capture-size-only-diff.png" },
  { name: "error-context", path: "e2e/.out/tmp-capture/test-results/capture-size-only/error-context.md" },
];

/**
 * 白底基线；实际页面上一块 40×40 的蓝块每 30 ms 移动一次，`toHaveScreenshot(…, { timeout: 2_000 })`
 * 连拍两张始终不同而超时。报错正文只有"Failed to take two consecutive stable screenshots."，
 * 像素句都在 `Call log:` 之后（相邻两张之间的比对），另附 `-previous`。
 */
const UNSTABLE_ERROR = [
  "Error: \u001b[2mexpect(\u001b[22m\u001b[31mpage\u001b[39m\u001b[2m).\u001b[22mtoHaveScreenshot\u001b[2m(\u001b[22m\u001b[32mexpected\u001b[39m\u001b[2m)\u001b[22m failed",
  "",
  "Timeout: 2000ms",
  "  Failed to take two consecutive stable screenshots.",
  "",
  "  Snapshot: px-capture-unstable.png",
  "",
  "Call log:",
  "\u001b[2m  - Expect \"toHaveScreenshot(px-capture-unstable.png)\" with timeout 2000ms\u001b[22m",
  "\u001b[2m    - verifying given screenshot expectation\u001b[22m",
  "\u001b[2m  - taking page screenshot\u001b[22m",
  "\u001b[2m    - disabled all CSS animations\u001b[22m",
  "\u001b[2m  - waiting for fonts to load...\u001b[22m",
  "\u001b[2m  - fonts loaded\u001b[22m",
  "\u001b[2m  - 1600 pixels (ratio 0.01 of all image pixels) are different.\u001b[22m",
  "\u001b[2m  - waiting 100ms before taking screenshot\u001b[22m",
  "\u001b[2m  - taking page screenshot\u001b[22m",
  "\u001b[2m    - disabled all CSS animations\u001b[22m",
  "\u001b[2m  - waiting for fonts to load...\u001b[22m",
  "\u001b[2m  - fonts loaded\u001b[22m",
  "\u001b[2m  - 3200 pixels (ratio 0.01 of all image pixels) are different.\u001b[22m",
  "\u001b[2m  - waiting 250ms before taking screenshot\u001b[22m",
  "\u001b[2m  - taking page screenshot\u001b[22m",
  "\u001b[2m    - disabled all CSS animations\u001b[22m",
  "\u001b[2m  - waiting for fonts to load...\u001b[22m",
  "\u001b[2m  - fonts loaded\u001b[22m",
  "\u001b[2m  - 3200 pixels (ratio 0.01 of all image pixels) are different.\u001b[22m",
  "\u001b[2m  - waiting 500ms before taking screenshot\u001b[22m",
  "\u001b[2m  - taking page screenshot\u001b[22m",
  "\u001b[2m    - disabled all CSS animations\u001b[22m",
  "\u001b[2m  - waiting for fonts to load...\u001b[22m",
  "\u001b[2m  - fonts loaded\u001b[22m",
  "\u001b[2m  - 3200 pixels (ratio 0.01 of all image pixels) are different.\u001b[22m",
  "\u001b[2m  - waiting 1000ms before taking screenshot\u001b[22m",
  "\u001b[2m  - Timeout 2000ms exceeded.\u001b[22m",
  "",
].join("\n");

const UNSTABLE_ATTACHMENTS: readonly CaseAttachment[] = [
  { name: "px-capture-unstable-expected.png", path: "e2e/.out/tmp-capture/snap/px-capture-unstable-win32.png" },
  { name: "px-capture-unstable-previous.png", path: "e2e/.out/tmp-capture/test-results/capture-unstable/px-capture-unstable-previous.png" },
  { name: "px-capture-unstable-actual.png", path: "e2e/.out/tmp-capture/test-results/capture-unstable/px-capture-unstable-actual.png" },
  { name: "px-capture-unstable-diff.png", path: "e2e/.out/tmp-capture/test-results/capture-unstable/px-capture-unstable-diff.png" },
  { name: "error-context", path: "e2e/.out/tmp-capture/test-results/capture-unstable/error-context.md" },
];

/** 基线文件不存在、`updateSnapshots: "none"` 时 `toHaveScreenshot` 自身的报错（`visual.spec.ts` 第 6 步先于它拦下）。 */
const NATIVE_MISSING_ERROR = [
  "Error: A snapshot doesn't exist at D:\\git-project\\cloudflare_pages_novel_generator\\e2e\\.out\\tmp-capture\\snap\\px-capture-missing-win32.png.",
].join("\n");

/** 与 `visual.spec.ts` 第 6 步相同，在 `test.step` 内 `throw new Error(missingBaselineMessage(…))` 的报错。 */
const MISSING_12_6_ERROR = [
  "Error: 缺少 Pixel_Baseline e2e/baselines/px-capture-missing-win32.png；运行 npm run e2e:update",
].join("\n");

/** Playwright 的 ratio：差异像素数 ÷ 比对面积，向上取整到两位小数（1.62.1 `compareImages`）。 */
function playwrightRatio(count: number, size: { width: number; height: number }): number {
  return Math.ceil((count / (size.width * size.height)) * 100) / 100;
}

/** 录取样例的 `CaseFacts`：`visual.spec.ts` 中桌面组的一个失败用例，附件路径以本机仓库根补全。 */
function capturedFacts(name: BaselineName, error: string, attachments: readonly CaseAttachment[]): CaseFacts {
  return {
    id: `captured-${name}`,
    file: path.join(REPO_ROOT, VISUAL_SPEC_FILE),
    titlePath: ["桌面 1280×800", visualTestTitle(name, "录取样例")],
    project: "fixture",
    expectedStatus: "passed",
    timeoutMs: 60_000,
    annotations: [],
    result: {
      status: "failed",
      startMs: 0,
      durationMs: 1,
      errors: [error],
      attachments: attachments.map((a) => (a.path === undefined ? a : { ...a, path: path.join(REPO_ROOT, a.path) })),
    },
  };
}

/** 三张图应取的附件路径（相对仓库根）：`-expected`、`-actual`、`-diff`，不取 `-previous` 与 `error-context`。 */
function expectedImages(name: string, attachments: readonly CaseAttachment[]) {
  const pathOf = (suffix: string) => ({ path: attachments.find((a) => a.name === `${name}-${suffix}.png`)?.path });
  return { expected: pathOf("expected"), actual: pathOf("actual"), diff: pathOf("diff") };
}

test.describe("toHaveScreenshot 的报错：parseScreenshotFailure、parseMissingBaseline（需求 12.5、12.6）", () => {
  test("12.5 超出容差：取差异像素数与 Playwright 的 ratio；尺寸相同时 ratio 按基线面积向上取整", () => {
    expect(parseScreenshotFailure(PIXELS_ERROR)).toEqual({ kind: "pixels", count: 15_000, ratio: 0.02 });
    // 15,000 / 1,024,000 = 1.46%，向上取整为 0.02
    expect(playwrightRatio(15_000, VIEWPORTS.desktop)).toBe(0.02);
  });

  test("12.5 尺寸不符且超出容差：取两组宽高与差异像素；ratio 按补齐后的 1280×810 计，不按基线 1280×800", () => {
    expect(parseScreenshotFailure(SIZE_PIXELS_ERROR)).toEqual({
      kind: "size",
      expected: { width: 1280, height: 800 },
      actual: { width: 1280, height: 810 },
      pixels: { count: 20_600, ratio: 0.02 },
    });
    // 20,600 / 1,036,800 = 1.99% → 0.02（与原文一致）；20,600 / 1,024,000 = 2.01% → 0.03（与原文不符）
    const padded = paddedSize({ width: 1280, height: 800 }, { width: 1280, height: 810 });
    expect(padded).toEqual({ width: 1280, height: 810 });
    expect(playwrightRatio(20_600, padded)).toBe(0.02);
    expect(playwrightRatio(20_600, VIEWPORTS.desktop)).toBe(0.03);
  });

  test("12.5 尺寸不符而补齐后未超出容差：只有尺寸句（末尾带空格），pixels 为 null", () => {
    expect(parseScreenshotFailure(SIZE_ONLY_ERROR)).toEqual({
      kind: "size",
      expected: { width: 1280, height: 800 },
      actual: { width: 1280, height: 810 },
      pixels: null,
    });
  });

  test("只解析 Call log: 之前的部分：日志里的像素句（连拍比对）不当作与基线的比对", () => {
    // 连拍不稳定：正文没有像素句，日志里有 1600 与 3200 两种
    expect(parseScreenshotFailure(UNSTABLE_ERROR)).toEqual({
      kind: "unknown",
      detail: "Failed to take two consecutive stable screenshots.",
    });
    // 从真实报错中删去正文的像素句、保留日志：日志里同样的句子不得被取用
    const headSentence = "  15000 pixels (ratio 0.02 of all image pixels) are different.\n";
    expect(PIXELS_ERROR).toContain(headSentence);
    const logOnly = PIXELS_ERROR.replace(headSentence, "");
    expect(logOnly).toContain("15000 pixels (ratio 0.02 of all image pixels) are different.");
    // 正文只剩 matcher 首行与 `Snapshot:` 标注，没有可写的 detail
    expect(parseScreenshotFailure(logOnly)).toEqual({ kind: "unknown", detail: null });
    // 反过来，日志里改写成别的数不影响正文的解析
    const alteredLog = PIXELS_ERROR.replace(/- 15000 pixels \(ratio 0\.02/g, "- 99 pixels (ratio 0.99");
    expect(alteredLog).not.toBe(PIXELS_ERROR);
    expect(parseScreenshotFailure(alteredLog)).toEqual({ kind: "pixels", count: 15_000, ratio: 0.02 });
  });

  test("CRLF 换行与去掉 ANSI 转义后结果不变", () => {
    const esc = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, "g");
    for (const error of [PIXELS_ERROR, SIZE_PIXELS_ERROR, SIZE_ONLY_ERROR, UNSTABLE_ERROR]) {
      const parsed = parseScreenshotFailure(error);
      expect(parseScreenshotFailure(error.replace(/\n/g, "\r\n"))).toEqual(parsed);
      expect(error).toMatch(esc);
      expect(parseScreenshotFailure(error.replace(esc, ""))).toEqual(parsed);
    }
  });

  test("两种句式都没有时为 unknown，detail 取正文第一条有内容的行（跳过 matcher 首行与 Timeout: 标注）", () => {
    expect(parseScreenshotFailure(NATIVE_MISSING_ERROR)).toEqual({
      kind: "unknown",
      detail:
        "Error: A snapshot doesn't exist at D:\\git-project\\cloudflare_pages_novel_generator\\e2e\\.out\\tmp-capture\\snap\\px-capture-missing-win32.png.",
    });
    expect(parseScreenshotFailure(MISSING_12_6_ERROR)).toEqual({
      kind: "unknown",
      detail: "Error: 缺少 Pixel_Baseline e2e/baselines/px-capture-missing-win32.png；运行 npm run e2e:update",
    });
    // 只剩 matcher 首行与 Timeout: 时没有可写的正文
    const headerOnly = UNSTABLE_ERROR.split("\n").slice(0, 3).join("\n");
    expect(parseScreenshotFailure(headerOnly)).toEqual({ kind: "unknown", detail: null });
    expect(parseScreenshotFailure("")).toEqual({ kind: "unknown", detail: null });
  });

  test("12.6：parseMissingBaseline 只认 missingBaselineMessage 的信息，取回基线路径与更新命令原文", () => {
    const file = "e2e/baselines/px-capture-missing-win32.png";
    expect(MISSING_12_6_ERROR).toBe(`Error: ${missingBaselineMessage(file)}`);
    expect(parseMissingBaseline(MISSING_12_6_ERROR)).toEqual({ file, command: UPDATE_COMMAND });
    expect(UPDATE_COMMAND).toBe("npm run e2e:update");
    for (const error of [NATIVE_MISSING_ERROR, PIXELS_ERROR, SIZE_PIXELS_ERROR, SIZE_ONLY_ERROR, UNSTABLE_ERROR]) {
      expect(parseMissingBaseline(error)).toBeNull();
    }
  });

  test("12.5 三张图：Run_Summary 取 -expected、-actual、-diff 附件的路径（相对仓库根），占比与容差按比对尺寸计", () => {
    const desktop = VIEWPORTS.desktop;
    const cases: { name: BaselineName; error: string; attachments: readonly CaseAttachment[] }[] = [
      { name: "px-capture-pixels", error: PIXELS_ERROR, attachments: PIXELS_ATTACHMENTS },
      { name: "px-capture-size-pixels", error: SIZE_PIXELS_ERROR, attachments: SIZE_PIXELS_ATTACHMENTS },
      { name: "px-capture-size-only", error: SIZE_ONLY_ERROR, attachments: SIZE_ONLY_ATTACHMENTS },
      { name: "px-capture-unstable", error: UNSTABLE_ERROR, attachments: UNSTABLE_ATTACHMENTS },
    ];
    const defs: VisualBaselineRef[] = cases.map((c) => ({
      name: c.name,
      viewport: desktop,
      file: baselinePath(c.name, "win32"),
    }));
    const section = buildVisualSection(
      defs,
      cases.map((c) => capturedFacts(c.name, c.error, c.attachments)),
    );
    expect(section.collected).toBe(cases.length);
    expect(section.unmatched).toEqual([]);

    const results = new Map(section.entries.map((e) => [e.name, e.result]));
    const mismatch = (name: string): Extract<VisualResult, { kind: "mismatch" }> => {
      const r = results.get(name);
      if (r?.kind !== "mismatch") throw new Error(`${name}：应为 mismatch，实为 ${JSON.stringify(r)}`);
      return r;
    };
    for (const c of cases) {
      expect(mismatch(c.name).images, c.name).toEqual(expectedImages(c.name, c.attachments));
    }

    expect(mismatch("px-capture-pixels").pixels).toEqual({
      count: 15_000,
      ratio: 15_000 / 1_024_000,
      reportedRatio: 0.02,
      basis: { width: 1280, height: 800 },
      maxPixels: 1024,
    });
    // 尺寸不符：与 Playwright 一样按补齐后的 1280×810 计，容差上限 ⌊1,036,800 × 0.001⌋ = 1,036
    expect(mismatch("px-capture-size-pixels").pixels).toEqual({
      count: 20_600,
      ratio: 20_600 / 1_036_800,
      reportedRatio: 0.02,
      basis: { width: 1280, height: 810 },
      maxPixels: 1036,
    });
    expect(mismatch("px-capture-size-only").pixels).toBeNull();
    expect(mismatch("px-capture-unstable").failure).toEqual({
      kind: "unknown",
      detail: "Failed to take two consecutive stable screenshots.",
    });
    expect(mismatch("px-capture-unstable").pixels).toBeNull();

    const text = renderVisualSection(section).join("\n");
    for (const c of cases) {
      for (const ref of Object.values(expectedImages(c.name, c.attachments))) {
        expect(text, c.name).toContain(`\`${ref.path}\``);
      }
    }
    expect(text).not.toContain("-previous.png");
    expect(text).toContain("- 尺寸：基线 1280×800，实际 1280×810");
    expect(text).toContain("按两图补齐后的尺寸 1280×810 计；容差上限 1,036 个");
    expect(text).toContain("按基线 1280×800 计；容差上限 1,024 个");
    expect(text).toContain("补齐到 1280×810 后未超过容差上限 1,036 个");
    expect(text).toContain("- 报错：Failed to take two consecutive stable screenshots.");
  });
});
