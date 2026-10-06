/**
 * `public/` 起止快照的无浏览器测试（`tooling` 项目；设计"public/ 快照（4.5、4.8）"与 Testing Strategy）。
 *
 * - `diffSnapshots`：属性 11（快照差异分类，需求 4.8）。只调用纯函数，不访问文件系统。
 * - `takeSnapshot(root)` + `diffSnapshots` 的例子（任务 6.3）：在临时目录里自建 `public/` 与
 *   `.preprocess-manifest.json`，改大小、`utimes` 改纳秒位、删文件、新增文件，核对 4.8 的各差异
 *   类型。`takeSnapshot` 一律传入临时根目录，从不以默认参数（仓库根）调用，不触碰真实 `public/`。
 */
import { expect, test } from "@playwright/test";
import fc from "fast-check";
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  MANIFEST_KEY,
  diffSnapshots,
  takeSnapshot,
  type DiffKind,
  type FileStat,
  type Snapshot,
  type SnapshotDiff,
} from "../../support/snapshot";

// ---------------------------------------------------------------------------
// 属性 11 的判定
// ---------------------------------------------------------------------------

const ALL_KINDS: readonly DiffKind[] = ["added", "removed", "size", "mtime"];

function has(files: Record<string, FileStat>, p: string): boolean {
  return Object.prototype.hasOwnProperty.call(files, p);
}

/**
 * 按属性 11 的定义逐条核对 `diffSnapshots(a, b)` 的结果 `d`：
 * - 路径 p 带 `added` ⇔ p ∈ B \ A；带 `removed` ⇔ p ∈ A \ B；
 *   带 `size` / `mtime` ⇔ p 同在两份中且对应字段的字符串不相等；
 * - 没有任何差异的路径不出现，出现的路径都来自 A ∪ B，`kinds` 非空且无重复；
 * - `entries` 按路径（UTF-16 码元序，即 JS 字符串的 `<`）严格递增，`total` 等于 `entries` 长度。
 *
 * 属性内用 `node:assert` 而不是 Playwright 的 `expect`，理由同 `server-resolve.spec.ts`：
 * 每次 `expect` 都会在报告里记一个步骤。
 */
function assertDiffClassification(a: Snapshot, b: Snapshot, d: SnapshotDiff): void {
  assert.equal(d.total, d.entries.length, "total 应等于 entries 长度");
  for (let i = 1; i < d.entries.length; i++) {
    const prev = d.entries[i - 1].path;
    const cur = d.entries[i].path;
    assert.ok(prev < cur, `entries 未按路径严格递增：${JSON.stringify(prev)} 之后是 ${JSON.stringify(cur)}`);
  }

  const union = new Set([...Object.keys(a.files), ...Object.keys(b.files)]);
  const actual = new Map<string, DiffKind[]>();
  for (const e of d.entries) {
    assert.ok(union.has(e.path), `差异路径 ${JSON.stringify(e.path)} 不在任何一份快照中`);
    assert.ok(e.kinds.length > 0, `路径 ${JSON.stringify(e.path)} 的 kinds 为空`);
    assert.equal(new Set(e.kinds).size, e.kinds.length, `路径 ${JSON.stringify(e.path)} 的 kinds 有重复`);
    actual.set(e.path, e.kinds);
  }

  for (const p of union) {
    const inA = has(a.files, p);
    const inB = has(b.files, p);
    const holds: Record<DiffKind, boolean> = {
      added: !inA && inB,
      removed: inA && !inB,
      size: inA && inB && a.files[p].size !== b.files[p].size,
      mtime: inA && inB && a.files[p].mtimeNs !== b.files[p].mtimeNs,
    };
    const expected = ALL_KINDS.filter((k) => holds[k]);
    const got = [...(actual.get(p) ?? [])].sort();
    assert.deepEqual(got, [...expected].sort(), `路径 ${JSON.stringify(p)} 的差异类型`);
  }
}

/** 交换参数后的期望：`added` 与 `removed` 互换，其余不变。 */
function swapKind(k: DiffKind): DiffKind {
  if (k === "added") return "removed";
  if (k === "removed") return "added";
  return k;
}

// ---------------------------------------------------------------------------
// 生成器
// ---------------------------------------------------------------------------

/**
 * 路径段的字母表：ASCII、空格、点、中文，以及一对 UTF-16 码元序与码点序相反的字符
 * （`𠮷` 是代理对，码元 0xD842 小于 `ｆ` 的 0xFF46，码点却更大）。
 */
const SEGMENT_UNITS = [..."ab zZ09-_.中文书库卷𠮷ｆ"];
const segmentArb = fc.string({ unit: fc.constantFrom(...SEGMENT_UNITS), minLength: 1, maxLength: 5 });

/** 与真实书库同形的路径，保证不同快照之间常有共同路径。 */
const REALISTIC_PATHS = [
  MANIFEST_KEY,
  "public/data/books.json",
  "public/data/中文书_toc.json",
  "public/books/中文书.txt.gz",
  "public/books/a b.txt.gz",
  "public/books/中文书 第二部.txt.gz",
  "public/深 层/二 级/三级/文件.txt",
] as const;

const pathArb = fc.oneof(
  { weight: 2, arbitrary: fc.constantFrom(...REALISTIC_PATHS) },
  {
    weight: 3,
    arbitrary: fc
      .array(segmentArb, { minLength: 1, maxLength: 4 })
      .map((segs) => ["public", ...segs].join("/")),
  },
);

/** 十进制串：小数值、贴近真实的纳秒时间戳、以及 64 位范围内的任意值（`mtimeNs` 可为负）。 */
const sizeArb = fc
  .oneof(
    fc.bigInt({ min: 0n, max: 1_000n }),
    fc.bigInt({ min: 0n, max: 9_223_372_036_854_775_807n }),
  )
  .map(String);
const mtimeArb = fc
  .oneof(
    fc.bigInt({ min: 1_600_000_000_000_000_000n, max: 1_800_000_000_000_000_000n }),
    fc.bigInt({ min: -9_223_372_036_854_775_808n, max: 9_223_372_036_854_775_807n }),
  )
  .map(String);

/**
 * B 中字段相对 A 的改动：保持不变；加一个小增量（`mtimeNs` 只动纳秒位，两串只在末几位不同）；
 * 或换成独立生成的值（可能碰巧相等，判定按字符串比较，照样成立）。
 */
type FieldEdit = { kind: "keep" } | { kind: "delta"; by: bigint } | { kind: "replace"; value: string };

function fieldEditArb(deltaArb: fc.Arbitrary<bigint>, valueArb: fc.Arbitrary<string>): fc.Arbitrary<FieldEdit> {
  return fc.oneof(
    { weight: 3, arbitrary: fc.constant<FieldEdit>({ kind: "keep" }) },
    { weight: 2, arbitrary: deltaArb.map((by): FieldEdit => ({ kind: "delta", by })) },
    { weight: 1, arbitrary: valueArb.map((value): FieldEdit => ({ kind: "replace", value })) },
  );
}

function applyEdit(value: string, edit: FieldEdit): string {
  if (edit.kind === "keep") return value;
  if (edit.kind === "replace") return edit.value;
  return (BigInt(value) + edit.by).toString();
}

const sizeEditArb = fieldEditArb(fc.bigInt({ min: 1n, max: 4_096n }), sizeArb);
const mtimeEditArb = fieldEditArb(
  fc.oneof(
    { weight: 3, arbitrary: fc.bigInt({ min: -99n, max: 99n }) }, // 只在纳秒位不同（含 0：不变）
    { weight: 1, arbitrary: fc.bigInt({ min: -1_000_000_000_000n, max: 1_000_000_000_000n }) },
  ),
  mtimeArb,
);

type Presence = "onlyA" | "onlyB" | "both";

const pathCaseArb = fc.record({
  presence: fc.oneof(
    { weight: 1, arbitrary: fc.constant<Presence>("onlyA") },
    { weight: 1, arbitrary: fc.constant<Presence>("onlyB") },
    { weight: 3, arbitrary: fc.constant<Presence>("both") },
  ),
  stat: fc.record({ size: sizeArb, mtimeNs: mtimeArb }),
  sizeEdit: sizeEditArb,
  mtimeEdit: mtimeEditArb,
});

function snapshotOf(files: Record<string, FileStat>, meta: { takenAt: string; root: string; ms: number }): Snapshot {
  return { ...meta, files, count: Object.keys(files).length };
}

/**
 * 两份快照：路径互不重复，`files` 的键按生成顺序插入（不预先排序，`diffSnapshots` 不应依赖
 * 输入顺序）。两份的 `takenAt`、`root`、`ms` 也各不相同，它们不参与比较。
 */
const snapshotPairArb = fc
  .uniqueArray(fc.tuple(pathArb, pathCaseArb), { selector: ([p]) => p, maxLength: 16 })
  .map((cases) => {
    const aFiles: Record<string, FileStat> = {};
    const bFiles: Record<string, FileStat> = {};
    for (const [p, c] of cases) {
      if (c.presence !== "onlyB") aFiles[p] = { ...c.stat };
      if (c.presence === "onlyB") bFiles[p] = { ...c.stat };
      if (c.presence === "both") {
        bFiles[p] = { size: applyEdit(c.stat.size, c.sizeEdit), mtimeNs: applyEdit(c.stat.mtimeNs, c.mtimeEdit) };
      }
    }
    const a = snapshotOf(aFiles, { takenAt: "2024-01-01T00:00:00.000Z", root: "D:\\仓库 A", ms: 12 });
    const b = snapshotOf(bFiles, { takenAt: "2024-01-01T00:05:00.000Z", root: "E:\\仓库 B", ms: 34 });
    return { a, b };
  });

test.describe("diffSnapshots（需求 4.8）", () => {
  // Feature: e2e-visual-testing, Property 11: 快照差异分类
  // **Validates: Requirements 4.8**
  test("属性 11：差异类型按定义归类，entries 严格递增，自比为空，交换参数后 added 与 removed 互换", () => {
    fc.assert(
      fc.property(snapshotPairArb, ({ a, b }) => {
        const aBefore = structuredClone(a);
        const bBefore = structuredClone(b);

        const d = diffSnapshots(a, b);
        assertDiffClassification(a, b, d);

        // 纯函数：不修改参数
        assert.deepEqual(a, aBefore, "diffSnapshots 修改了 start");
        assert.deepEqual(b, bBefore, "diffSnapshots 修改了 end");

        // 自比没有差异（与 takenAt、root 无关）
        assert.deepEqual(diffSnapshots(a, a), { total: 0, entries: [] }, "diffSnapshots(A, A) 应为空");
        assert.deepEqual(diffSnapshots(b, structuredClone(b)), { total: 0, entries: [] }, "diffSnapshots(B, B') 应为空");

        // 交换参数：同一组路径、同样的顺序，added 与 removed 互换，size / mtime 不变
        const swapped = diffSnapshots(b, a);
        assertDiffClassification(b, a, swapped);
        assert.deepEqual(
          swapped.entries.map((e) => ({ path: e.path, kinds: [...e.kinds].sort() })),
          d.entries.map((e) => ({ path: e.path, kinds: e.kinds.map(swapKind).sort() })),
          "交换参数后应只有 added 与 removed 互换",
        );
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// 例子：临时目录里的 takeSnapshot + diffSnapshots（任务 6.3）
// ---------------------------------------------------------------------------

/** 各文件的修改时间取整秒（`utimes` 按 double 秒传入，整秒可精确写入与还原）。 */
const BASE_S = 1_700_000_000;
const NS_PER_S = 1_000_000_000n;

/** 快照范围内的文件：[相对临时根、`/` 分隔的路径, 内容, 修改时间（秒）]。 */
const IN_SCOPE: ReadonlyArray<readonly [string, string, number]> = [
  [MANIFEST_KEY, '{"version":1,"books":{}}\n', BASE_S],
  ["public/data/books.json", '[{"id":"中文书"}]\n', BASE_S + 10],
  ["public/data/中文书_toc.json", '{"nodes":[]}\n', BASE_S + 20],
  ["public/books/中文书.txt.gz", "并非真正的 gzip，快照不读内容", BASE_S + 30],
  ["public/books/a b.txt.gz", "另一本", BASE_S + 40],
  ["public/深 层/二 级/三级/文件.txt", "多级目录下的文件", BASE_S + 50],
];

/** 快照范围之外的文件：它们的任何变化都不应出现在差异中。 */
const OUT_OF_SCOPE: ReadonlyArray<readonly [string, string]> = [
  ["zip-novel/源.zip", "源压缩包"],
  ["其他.txt", "仓库根下的其他文件"],
  ["public-extra/x.txt", "名字以 public 开头的兄弟目录"],
];

/** 空目录：目录本身不作为条目记录。 */
const EMPTY_DIRS = ["public/空 目录"] as const;

test.describe("takeSnapshot 与 diffSnapshots：临时目录中的例子（需求 4.5、4.8）", () => {
  let root = "";

  const abs = (rel: string): string => path.join(root, ...rel.split("/"));

  async function put(rel: string, content: string): Promise<void> {
    await mkdir(path.dirname(abs(rel)), { recursive: true });
    await writeFile(abs(rel), content, "utf8");
  }

  test.beforeEach(async () => {
    // 目录名含空格与中文，与真实仓库路径的难点相同
    root = await mkdtemp(path.join(os.tmpdir(), "e2e 快照-"));
    for (const [rel, content, mtime] of IN_SCOPE) {
      await put(rel, content);
      await utimes(abs(rel), mtime, mtime);
    }
    for (const [rel, content] of OUT_OF_SCOPE) await put(rel, content);
    for (const rel of EMPTY_DIRS) await mkdir(abs(rel), { recursive: true });
  });

  test.afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = "";
  });

  test("记录 public/ 递归的全部文件与清单文件：`/` 分隔的相对路径按码元序排列，size 与 mtimeNs 为完整精度", async () => {
    const s0 = await takeSnapshot(root);

    const expected: Record<string, FileStat> = {};
    for (const [rel, content, mtime] of IN_SCOPE) {
      expected[rel] = {
        size: String(Buffer.byteLength(content, "utf8")),
        mtimeNs: (BigInt(mtime) * NS_PER_S).toString(),
      };
    }
    const keys = Object.keys(s0.files);
    expect(keys).toEqual(Object.keys(expected).sort());
    expect(s0.files).toEqual(expected);
    expect(s0.count).toBe(IN_SCOPE.length);
    expect(s0.root).toBe(path.resolve(root));
    expect(Number.isNaN(Date.parse(s0.takenAt))).toBe(false);

    // 范围之外的改动（其他目录的文件、新的空目录）不产生差异；取快照本身也不改变元数据
    await writeFile(abs(OUT_OF_SCOPE[0][0]), "改过的源压缩包", "utf8");
    await rm(abs(OUT_OF_SCOPE[1][0]));
    await put("public-extra/新.txt", "兄弟目录里的新文件");
    await mkdir(abs("public/又一个空目录/更深"), { recursive: true });
    const s1 = await takeSnapshot(root);
    expect(s1.files).toEqual(s0.files);
    expect(diffSnapshots(s0, s1)).toEqual({ total: 0, entries: [] });
  });

  test("改大小：只改大小（修改时间还原）记 size；大小与修改时间都变记 size 与 mtime", async () => {
    const s0 = await takeSnapshot(root);

    // 内容变长后把修改时间还原成原来的整秒：只剩大小变化
    const [sizeOnly, , sizeOnlyMtime] = IN_SCOPE[3];
    await writeFile(abs(sizeOnly), "并非真正的 gzip，快照不读内容——追加一段", "utf8");
    await utimes(abs(sizeOnly), sizeOnlyMtime, sizeOnlyMtime);

    // 截成空文件，修改时间随写入变为当前时间：大小与修改时间都变
    const [both] = IN_SCOPE[1];
    await writeFile(abs(both), "", "utf8");

    const s1 = await takeSnapshot(root);
    expect(s1.files[sizeOnly].mtimeNs).toBe(s0.files[sizeOnly].mtimeNs);
    expect(s1.files[sizeOnly].size).not.toBe(s0.files[sizeOnly].size);
    expect(s1.files[both].size).toBe("0");

    expect(diffSnapshots(s0, s1)).toEqual({
      total: 2,
      entries: [
        { path: "public/books/中文书.txt.gz", kinds: ["size"] },
        { path: "public/data/books.json", kinds: ["size", "mtime"] },
      ],
    });
  });

  test("utimes 只改纳秒位：修改时间相差不到 1 ms 也记 mtime，不做取整", async () => {
    const [rel, , mtime] = IN_SCOPE[5];
    const s0 = await takeSnapshot(root);

    // 整秒 + 5 µs：只改 mtimeNs 十进制串的亚毫秒各位。实测 Node 24 在 Windows 上 `utimes`
    // 以微秒为最小单位写入（+900 ns 读回为 +1 µs），所以不取更小的增量；5 µs 远大于
    // double 秒在 1.7e9 附近约 238 ns 的分辨率，截断与四舍五入都得到同一个值
    await utimes(abs(rel), mtime + 5e-6, mtime + 5e-6);
    const readBack = (await lstat(abs(rel), { bigint: true })).mtimeNs;

    const s1 = await takeSnapshot(root);
    const before = BigInt(s0.files[rel].mtimeNs);
    const after = BigInt(s1.files[rel].mtimeNs);
    expect(after, "快照应记下 lstat 报告的完整精度").toBe(readBack);
    expect(after - before, "修改时间应晚于原值").toBeGreaterThan(0n);
    expect(after - before, "两次修改时间应只在毫秒以下的位不同").toBeLessThan(1_000_000n);
    expect(after / 1_000_000n, "按毫秒取整后两者相同，取整比较会漏掉这个差异").toBe(before / 1_000_000n);
    expect(s1.files[rel].size).toBe(s0.files[rel].size);

    expect(diffSnapshots(s0, s1)).toEqual({ total: 1, entries: [{ path: rel, kinds: ["mtime"] }] });
    expect(diffSnapshots(s1, s0)).toEqual({ total: 1, entries: [{ path: rel, kinds: ["mtime"] }] });
  });

  test("删文件与新增文件：删除的文件（含清单文件、整个子目录下的文件）记 removed，新文件记 added", async () => {
    const s0 = await takeSnapshot(root);

    await rm(abs("public/data/中文书_toc.json"));
    await rm(abs(MANIFEST_KEY));
    await rm(abs("public/深 层"), { recursive: true });
    await rm(abs(EMPTY_DIRS[0]), { recursive: true }); // 空目录的删除不产生差异
    await put("public/新 目录/新文件.txt.gz", "新");

    const s1 = await takeSnapshot(root);
    expect(s1.count).toBe(IN_SCOPE.length - 3 + 1);

    // 码元序：`.`（0x2E）< `d`（0x64）< `新`（0x65B0）< `深`（0x6DF1）
    expect(diffSnapshots(s0, s1)).toEqual({
      total: 4,
      entries: [
        { path: MANIFEST_KEY, kinds: ["removed"] },
        { path: "public/data/中文书_toc.json", kinds: ["removed"] },
        { path: "public/新 目录/新文件.txt.gz", kinds: ["added"] },
        { path: "public/深 层/二 级/三级/文件.txt", kinds: ["removed"] },
      ],
    });
  });
});
