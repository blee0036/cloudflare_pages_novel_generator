/**
 * 性能观测纯函数的无浏览器测试（`tooling` 项目；设计"性能观测（需求 14）"与 Testing Strategy）。
 *
 * - `parseBookLoadLine`：属性 9（`[book-load]` 行解析往返，需求 14.2 (e)）与定向例子。行一律由
 *   应用自己的 `formatBookLoadMetrics`（`src/utils/loadMetrics.ts`）生成，往返覆盖的就是应用
 *   实际打出的格式；期望的 gz / decompress / total 记号从格式化串本身切出，不在测试里重写一遍
 *   格式化规则。
 * - `evaluatePerfItem`：属性 7（预算判定，需求 14.3、14.4、14.5、14.7）与定向例子。
 * - `maxLongTask`：属性 8（最长长任务读数，需求 14.2、14.6）与定向例子。
 */
import { expect, test } from "@playwright/test";
import fc from "fast-check";
import assert from "node:assert/strict";
import {
  formatBookLoadMetrics,
  type BookLoadMetrics,
  type BookLoadSource,
} from "../../../src/utils/loadMetrics";
import {
  PERF_KEYS,
  evaluatePerfItem,
  maxLongTask,
  parseBookLoadLine,
  type BookLoadLine,
  type LongTaskEntry,
  type PerfEvaluated,
  type PerfItem,
} from "../../perf/metrics";
import { PERF } from "../../support/settings";

/** 属性 9 所说的行首记号，按设计原文写成字面量，不从被测代码取。 */
const HEAD = "[book-load] ";

// ---------------------------------------------------------------------------
// 属性 9 的判定
// ---------------------------------------------------------------------------

/** 取 `key=value` 片段的 value；片段的键不对即判失败。 */
function valueOf(kv: string, key: string, line: string): string {
  assert.ok(kv.startsWith(`${key}=`), `片段 ${JSON.stringify(kv)} 不是 ${key}=…（line=${JSON.stringify(line)}）`);
  return kv.slice(key.length + 1);
}

/**
 * 属性 9 的正向判定。bookId 不含空白，格式化串的每个记号也不含空白，所以按单个空格切分恰得
 * 7 段：行首记号、id 与 5 个 `key=value` 字段。由此得到的期望值独立于解析器的正则：
 * - id、source、chars 取自 m 本身；
 * - gz、decompress、total 取自格式化串中的对应记号。
 *
 * 属性内用 `node:assert` 而不是 Playwright 的 `expect`，理由同 `server-resolve.spec.ts`：
 * 每次 `expect` 都会在报告里记一个步骤。
 */
function assertRoundTrip(m: BookLoadMetrics): void {
  const line = formatBookLoadMetrics(m);
  const where = `line=${JSON.stringify(line)}`;
  assert.ok(line.startsWith(HEAD), `格式化串不以 ${JSON.stringify(HEAD)} 开头（${where}）`);

  const parts = line.split(" ");
  assert.equal(parts.length, 7, `格式化串应恰好切成 7 段（${where}）`);
  const [head, id, sourceKv, gzKv, charsKv, decompressKv, totalKv] = parts;
  assert.equal(`${head} `, HEAD, `行首记号（${where}）`);
  assert.equal(id, m.bookId, `id 段（${where}）`);
  assert.equal(valueOf(sourceKv, "source", line), m.source, `source 段（${where}）`);
  assert.equal(valueOf(charsKv, "chars", line), String(m.chars), `chars 段（${where}）`);

  const expected: BookLoadLine = {
    bookId: m.bookId,
    source: m.source,
    gz: valueOf(gzKv, "gz", line),
    chars: m.chars,
    decompress: valueOf(decompressKv, "decompress", line),
    total: valueOf(totalKv, "total", line),
  };
  assert.deepEqual(parseBookLoadLine(line), expected, `解析结果（${where}）`);
}

// ---------------------------------------------------------------------------
// 生成器
// ---------------------------------------------------------------------------

/** 应用的全部来源分支；F-001 修复后已没有 `network-fallback`（19.2）。 */
const SOURCES: readonly BookLoadSource[] = ["memory", "indexeddb", "network", "network-transparent"];

/**
 * 拼 id 的片段：Fixture_Library 式的合成书 id（中文、数字、连字符、下划线），形似字段或行首记号的
 * 子串，百分号编码串与代理对字符。拼接后仍不含空白，却能诱使按"首个 `source=`"切分的解析器出错。
 */
const ID_PIECES = [
  "2048云岭长歌-夹具作者甲",
  "浩瀚长卷_上部_下部_-夹具作者戊",
  "长夜书灯-夹具作者己",
  "黄沙古道-夹具作者辛",
  "source=network",
  "gz=n/a",
  "chars=12",
  "decompress=5ms",
  "total=0ms",
  "[book-load]",
  "=",
  "-",
  "%E4%B8%AD",
  "𠮷",
  "（二）",
  "·",
] as const;

/** 非空、不含空白（JS `\s` 的定义，含全角空格与 U+FEFF）的书 id。 */
const bookIdArb = fc.oneof(
  fc.array(fc.constantFrom(...ID_PIECES), { minLength: 1, maxLength: 4 }).map((ps) => ps.join("")),
  // 全 Unicode 码点；把空白换成 `_` 而不是过滤掉，长度不变，也就不会变空
  fc.string({ unit: "binary", minLength: 1, maxLength: 16 }).map((s) => s.replace(/\s/gu, "_")),
);

/**
 * gz 字节数：覆盖 `B`、`KB`、`MB` 三档（含 1024 与 1024² 两个分界），以及任意 double
 * （NaN、±Infinity、-0、负数、小数与极大值，格式化为 `n/a` 或指数记号）。
 */
const gzBytesArb = fc.oneof(
  fc.integer({ min: 0, max: 1023 }),
  fc.integer({ min: 1024, max: 1024 * 1024 - 1 }),
  fc.integer({ min: 1024 * 1024, max: 2 ** 40 }),
  fc.constantFrom(1023, 1024, 1024 * 1024 - 1, 1024 * 1024),
  fc.double(),
);

/** 毫秒：贴近真实的读数，与任意 double（NaN 与 ±Infinity 格式化为 `n/a`）。 */
const msArb = fc.oneof(fc.double({ min: 0, max: 600_000, noNaN: true }), fc.double());

/** `chars` 是 `String.length`，总是非负安全整数；两种生成器分别偏向小值与贴近上限的值。 */
const charsArb = fc.oneof(fc.nat(), fc.maxSafeNat());

const metricsArb: fc.Arbitrary<BookLoadMetrics> = fc.record({
  bookId: bookIdArb,
  source: fc.constantFrom(...SOURCES),
  gzBytes: fc.option(gzBytesArb, { nil: null }),
  chars: charsArb,
  decompressMs: fc.option(msArb, { nil: null }),
  totalMs: msArb,
});

/** 接近行首记号、但不以它开头的替换行首：缺空格、别的空白、大小写、少字符、多前缀等。 */
const NEAR_MISS_HEADS = [
  "",
  "[book-load]",
  "[book-load]\t",
  "[book-load]\u3000",
  "[book-load]\u00a0",
  "[book-load]\n",
  "[Book-load] ",
  "[BOOK-LOAD] ",
  "[book_load] ",
  "[book-load ",
  "book-load] ",
  "[bookload] ",
  " [book-load] ",
  "\ufeff[book-load] ",
  "info: [book-load] ",
  "[book-load]]",
] as const;

/** 一个合法行的行首替换为近似记号，其后的内容仍是合法的 id 与字段。 */
const headReplacedArb = fc
  .tuple(metricsArb, fc.constantFrom(...NEAR_MISS_HEADS))
  .map(([m, head]) => head + formatBookLoadMetrics(m).slice(HEAD.length));

/** 在合法行的前 12 个码元内删除、替换或插入一个字符。 */
const headEditedArb = fc
  .tuple(
    metricsArb,
    fc.nat({ max: HEAD.length - 1 }),
    fc.constantFrom("delete", "replace", "insert"),
    fc.string({ unit: "binary", minLength: 1, maxLength: 1 }),
  )
  .map(([m, i, op, ch]) => {
    const line = formatBookLoadMetrics(m);
    if (op === "delete") return line.slice(0, i) + line.slice(i + 1);
    if (op === "replace") return line.slice(0, i) + ch + line.slice(i + 1);
    return line.slice(0, i) + ch + line.slice(i);
  });

/** 属性 9 反向部分的输入：一切不以 `[book-load] ` 开头的字符串，偏重只差一点的近似行。 */
const notBookLoadArb = fc
  .oneof(
    { weight: 1, arbitrary: fc.string({ unit: "binary", maxLength: 40 }) },
    { weight: 1, arbitrary: fc.string({ unit: fc.constantFrom(..."[book-lad] sure=gzchtmp/0123456789"), maxLength: 40 }) },
    { weight: 2, arbitrary: headReplacedArb },
    { weight: 2, arbitrary: headEditedArb },
  )
  .filter((s) => !s.startsWith(HEAD));

test.describe("parseBookLoadLine（需求 14.2）", () => {
  // Feature: e2e-visual-testing, Property 9: `[book-load]` 行解析往返
  // **Validates: Requirements 14.2**
  test("属性 9：格式化后再解析，id、source、chars 等于原值，gz、decompress、total 等于格式化串中的记号；不以 `[book-load] ` 开头的串解析为 null", () => {
    fc.assert(
      fc.property(metricsArb, (m) => {
        assertRoundTrip(m);
      }),
      { numRuns: 100 },
    );
    fc.assert(
      fc.property(notBookLoadArb, (s) => {
        assert.equal(parseBookLoadLine(s), null, `s=${JSON.stringify(s)}`);
      }),
      { numRuns: 100 },
    );
  });

  // -------------------------------------------------------------------------
  // 例子
  // -------------------------------------------------------------------------

  test("解析网络分支的一条典型日志：中文 id，gz 与耗时保留原样记号，chars 为数值", () => {
    // 书 id 取 Fixture_Library 式的合成 id，读数是自拟的
    const line = "[book-load] 长夜书灯-夹具作者己 source=network gz=6.73MB chars=2345678 decompress=87ms total=196ms";
    expect(parseBookLoadLine(line)).toEqual({
      bookId: "长夜书灯-夹具作者己",
      source: "network",
      gz: "6.73MB",
      chars: 2345678,
      decompress: "87ms",
      total: "196ms",
    });
  });

  test("内存命中的行：formatBookLoadMetrics 写出的 n/a 原样保留", () => {
    // 书 id 取 Fixture_Library 式的合成 id，读数是自拟的
    const line = formatBookLoadMetrics({
      bookId: "黄沙古道-夹具作者辛",
      source: "memory",
      gzBytes: null,
      chars: 654_321,
      decompressMs: null,
      totalMs: 0.3,
    });
    expect(parseBookLoadLine(line)).toEqual({
      bookId: "黄沙古道-夹具作者辛",
      source: "memory",
      gz: "n/a",
      chars: 654_321,
      decompress: "n/a",
      total: "0ms",
    });
  });

  test("枚举外的 source 原样返回，不被吞掉（19.2 回归时调用方能看到 network-fallback）", () => {
    const line = "[book-load] x source=network-fallback gz=812B chars=5 decompress=n/a total=3ms";
    expect(parseBookLoadLine(line)?.source).toBe("network-fallback");
  });

  test("id 含空格与形似字段的子串时，按行尾 5 个字段切分，id 取其前的全部内容", () => {
    const bookId = "a source=x gz=1B b chars=2 decompress=3ms total=4ms";
    const line = formatBookLoadMetrics({
      bookId,
      source: "indexeddb",
      gzBytes: 1536,
      chars: Number.MAX_SAFE_INTEGER,
      decompressMs: 12.6,
      totalMs: 40,
    });
    expect(parseBookLoadLine(line)).toEqual({
      bookId,
      source: "indexeddb",
      gz: "1.50KB",
      chars: Number.MAX_SAFE_INTEGER,
      decompress: "13ms",
      total: "40ms",
    });
  });

  test("格式不符时返回 null，从不抛错", () => {
    const tail = "source=memory gz=n/a chars=1 decompress=n/a total=0ms";
    const malformed = [
      "",
      "[book-load]",
      "[book-load] ",
      `[book-load]  ${tail}`, // id 为空
      "[book-load] x source=memory gz=n/a chars=1 decompress=n/a", // 缺 total
      `[book-load] x ${tail} extra`, // 行尾多余内容
      `[book-load] x ${tail} `, // 行尾多余空格
      `[book-load] x ${tail}\n`, // 行尾换行
      "[book-load] x source=memory gz=n/a decompress=n/a chars=1 total=0ms", // 字段顺序不对
      "[book-load] x source=memory gz=n/a  chars=1 decompress=n/a total=0ms", // 字段间两个空格
      "[book-load] x source= gz=n/a chars=1 decompress=n/a total=0ms", // source 为空
      "[book-load] x source=memory gz=n/a chars=-1 decompress=n/a total=0ms",
      "[book-load] x source=memory gz=n/a chars=1.5 decompress=n/a total=0ms",
      "[book-load] x source=memory gz=n/a chars=1e+21 decompress=n/a total=0ms",
      "[book-load] x source=memory gz=n/a chars=9007199254740992 decompress=n/a total=0ms", // 2^53，超出安全整数
    ];
    for (const text of malformed) {
      expect(parseBookLoadLine(text), JSON.stringify(text)).toBeNull();
    }
    // 运行时传入非字符串（如控制台消息取值出错）同样返回 null
    expect(parseBookLoadLine(null as unknown as string)).toBeNull();
    expect(parseBookLoadLine(undefined as unknown as string)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 预算判定（14.3、14.4、14.5、14.7）
// ---------------------------------------------------------------------------

/** 每项的取样次数，按设计原文（"长度为 5 的读数序列"）写成字面量，不从被测代码取。 */
const SAMPLES = 5;

/**
 * 与 x 相邻的下一个（dir = 1）或上一个（dir = -1）双精度数，用来把预算放在读数"恰好相等"的两侧。
 * x 须为有限非负数；结果越出 [0, Number.MAX_VALUE] 时返回 x 本身（仍是合法预算）。
 */
function adjacentDouble(x: number, dir: 1 | -1): number {
  if (x === 0 && dir === -1) return 0;
  const buf = new Float64Array([x]);
  new BigInt64Array(buf.buffer)[0] += BigInt(dir);
  return Number.isFinite(buf[0]) ? buf[0] : x;
}

/**
 * 属性 7 的判定（单个读数序列与预算 b），返回判定结果供重排比较：
 * - 含 null：状态为 uncollected，中位数与最大值为 null（不用其余读数凑，也不以 0 填充），并附非空
 *   原因（14.7）；`item.reason` 非空时原样沿用；
 * - 否则：中位数等于升序排列后的第 3 个值，最大值等于最大读数，状态为 over 当且仅当中位数 > b
 *   （等于预算不算超预算，14.4）；
 * - 无论哪种，结果一行都带回原样的 5 次读数与所用预算（14.5 表格的列），且不修改输入。
 *
 * 属性内用 `node:assert` 而不是 Playwright 的 `expect`，理由同上。`assert.equal` 按 `Object.is`
 * 比较，读数生成器因此不产生 -0（`fc.double({ min: 0 })` 不含 -0）。
 */
function assertBudgetVerdict(item: PerfItem, budget: number): PerfEvaluated {
  const where = `item=${JSON.stringify(item)} budget=${budget}`;
  const snapshot = [...item.readings];
  const out = evaluatePerfItem(item, budget);

  assert.deepEqual(item.readings, snapshot, `不修改输入（${where}）`);
  assert.notEqual(out.readings, item.readings, `readings 应为副本（${where}）`);
  assert.deepEqual(out.readings, snapshot, `readings 原样带回（${where}）`);
  assert.equal(out.key, item.key, `key（${where}）`);
  assert.equal(out.budgetMs, budget, `budgetMs（${where}）`);

  if (item.readings.includes(null)) {
    assert.equal(out.status, "uncollected", `含 null 应为 uncollected（${where}）`);
    assert.equal(out.median, null, `uncollected 的中位数（${where}）`);
    assert.equal(out.max, null, `uncollected 的最大值（${where}）`);
    assert.ok(typeof out.reason === "string" && out.reason.length > 0, `uncollected 应附原因（${where}）`);
    if (item.reason !== undefined && item.reason !== "") {
      assert.equal(out.reason, item.reason, `沿用 item.reason（${where}）`);
    }
  } else {
    const values = item.readings as number[];
    const median = [...values].sort((x, y) => x - y)[2];
    assert.equal(out.median, median, `中位数为排序后第 3 个值（${where}）`);
    assert.equal(out.max, Math.max(...values), `最大值（${where}）`);
    assert.equal(out.status, median > budget ? "over" : "within", `over 当且仅当中位数 > b（${where}）`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 生成器
// ---------------------------------------------------------------------------

/**
 * 一次读数（有限非负毫秒）：大量并列的小整数、贴近真实的整数毫秒（含长任务的 0 与 ≥ 50）、
 * 四项预算上下各 1 ms 的值，以及任意有限非负 double（含次正规数与 Number.MAX_VALUE）。
 */
const readingArb: fc.Arbitrary<number> = fc.oneof(
  fc.nat(3),
  fc.integer({ min: 0, max: 1000 }),
  fc.constantFrom(0, 50, 99, 100, 101, 349, 350, 351, 499, 500, 501),
  fc.double({ min: 0, max: 1000, noNaN: true }),
  fc.double({ min: 0, max: Number.MAX_VALUE, noNaN: true }),
);

const completeReadingsArb = fc.array(readingArb, { minLength: SAMPLES, maxLength: SAMPLES });

/** 5 次读数中任意非空的一组位置为 null（含全部为 null）。 */
const partialReadingsArb = fc
  .tuple(completeReadingsArb, fc.uniqueArray(fc.nat({ max: SAMPLES - 1 }), { minLength: 1, maxLength: SAMPLES }))
  .map(([readings, holes]) => readings.map((r, i) => (holes.includes(i) ? null : r)));

/** `reason` 可缺省、可为空串（按缺失处理）或任意串。 */
const perfItemArb: fc.Arbitrary<PerfItem> = fc.record(
  {
    key: fc.constantFrom(...PERF_KEYS),
    readings: fc.oneof(
      { weight: 3, arbitrary: completeReadingsArb },
      { weight: 2, arbitrary: partialReadingsArb },
    ),
    reason: fc.oneof(fc.constant(""), fc.string({ maxLength: 20 })),
  },
  { requiredKeys: ["key", "readings"] },
);

/**
 * 与读数无关的预算：14.3 的四个取值、0、整数毫秒与任意有限非负 double。设计写"任意非负预算"；
 * +Infinity 不是可配置的预算，`evaluatePerfItem` 对它抛 RangeError（见下方例子），不在此生成。
 */
const independentBudgetArb: fc.Arbitrary<number> = fc.oneof(
  fc.constantFrom(0, 100, 350, 500),
  fc.integer({ min: 0, max: 1000 }),
  fc.double({ min: 0, max: Number.MAX_VALUE, noNaN: true }),
);

/**
 * 属性 7 的输入：一项读数、预算 b 与 5 个位置的一个排列。b 偏向判定翻转处：等于某个读数或
 * 其相邻 double，读数齐全时另偏向中位数本身及其相邻 double（等于中位数应为 within，大一个 ulp 为 over）。
 */
const budgetScenarioArb = fc
  .tuple(perfItemArb, fc.shuffledSubarray([0, 1, 2, 3, 4], { minLength: SAMPLES, maxLength: SAMPLES }))
  .chain(([item, perm]) => {
    const values = item.readings.filter((r): r is number => r !== null);
    const near: fc.Arbitrary<number>[] = [];
    if (values.length > 0) {
      const pick = fc.constantFrom(...values);
      near.push(pick, pick.map((v) => adjacentDouble(v, 1)), pick.map((v) => adjacentDouble(v, -1)));
    }
    if (values.length === SAMPLES) {
      const median = [...values].sort((x, y) => x - y)[2];
      near.push(fc.constantFrom(median, adjacentDouble(median, 1), adjacentDouble(median, -1)));
    }
    const budget = fc.oneof(
      { weight: 2, arbitrary: independentBudgetArb },
      ...near.map((arbitrary) => ({ weight: 1, arbitrary })),
    );
    return fc.record({ item: fc.constant(item), budget, perm: fc.constant(perm) });
  });

test.describe("evaluatePerfItem（需求 14.3、14.4、14.5、14.7）", () => {
  // Feature: e2e-visual-testing, Property 7: 预算判定
  // **Validates: Requirements 14.3, 14.4, 14.5, 14.7**
  test("属性 7：任意 5 个读数（非负数或 null）与任意非负预算 b，含 null 时为 uncollected；否则中位数为排序后第 3 个值、最大值为最大读数，over 当且仅当中位数 > b；对读数任意重排，中位数、最大值与状态不变", () => {
    fc.assert(
      fc.property(budgetScenarioArb, ({ item, budget, perm }) => {
        const out = assertBudgetVerdict(item, budget);

        const permuted: PerfItem = { ...item, readings: perm.map((i) => item.readings[i]) };
        const where = `item=${JSON.stringify(item)} perm=${JSON.stringify(perm)} budget=${budget}`;
        const outPermuted = assertBudgetVerdict(permuted, budget);
        assert.equal(outPermuted.median, out.median, `重排后中位数不变（${where}）`);
        assert.equal(outPermuted.max, out.max, `重排后最大值不变（${where}）`);
        assert.equal(outPermuted.status, out.status, `重排后状态不变（${where}）`);

        // 缺省预算即 PERF.budgetsMs 中该项的取值（14.3：预算只在一处配置）
        assert.deepEqual(
          evaluatePerfItem(item),
          evaluatePerfItem(item, PERF.budgetsMs[item.key]),
          `缺省预算取 PERF.budgetsMs.${item.key}（${where}）`,
        );
      }),
      { numRuns: 100 },
    );
  });

  // -------------------------------------------------------------------------
  // 例子
  // -------------------------------------------------------------------------

  test("预算取自 14.3：(a) 500、(b) 100、(c) 350、(d) 100 ms；四项按 (a)–(d) 排列，每项取样 5 次", () => {
    expect(PERF.budgetsMs).toEqual({ tocOpen: 500, tocScrollLongTask: 100, shelfSearch: 350, readerSearchLongTask: 100 });
    expect(PERF_KEYS).toEqual(["tocOpen", "tocScrollLongTask", "shelfSearch", "readerSearchLongTask"]);
    expect(PERF.samples).toBe(SAMPLES);
  });

  test("中位数等于预算不算超预算，大 1 ms 即超预算；单次读数超预算不影响判定", () => {
    expect(evaluatePerfItem({ key: "tocOpen", readings: [900, 120, 500, 480, 510] })).toMatchObject({
      median: 500,
      max: 900,
      budgetMs: 500,
      status: "within",
    });
    expect(evaluatePerfItem({ key: "tocOpen", readings: [900, 120, 501, 480, 510] })).toMatchObject({
      median: 501,
      max: 900,
      budgetMs: 500,
      status: "over",
    });
    // 长任务读数只会是 0 或 ≥ 50（14.6）：3 次为 0 时中位数为 0
    expect(evaluatePerfItem({ key: "tocScrollLongTask", readings: [0, 300, 0, 120, 0] })).toMatchObject({
      median: 0,
      max: 300,
      budgetMs: 100,
      status: "within",
    });
    expect(evaluatePerfItem({ key: "readerSearchLongTask", readings: [0, 120, 150, 180, 0] })).toMatchObject({
      median: 120,
      max: 180,
      budgetMs: 100,
      status: "over",
    });
  });

  test("含 null 即未采集：中位数与最大值为 null，不以 0 填充；原因取 item.reason，缺失或为空串时按读数写出", () => {
    const reason = "第 2 次在用例超时内未到达终止条件";
    expect(evaluatePerfItem({ key: "shelfSearch", readings: [300, null, 310, 320, 330], reason })).toEqual({
      key: "shelfSearch",
      readings: [300, null, 310, 320, 330],
      reason,
      median: null,
      max: null,
      budgetMs: 350,
      status: "uncollected",
    });
    for (const item of [
      { key: "readerSearchLongTask", readings: [null, 0, null, 0, 0] },
      { key: "readerSearchLongTask", readings: [null, 0, null, 0, 0], reason: "" },
    ] satisfies PerfItem[]) {
      const out = evaluatePerfItem(item);
      expect(out).toMatchObject({ median: null, max: null, status: "uncollected" });
      expect(out.reason).toContain("第 1、3 次");
    }
    expect(evaluatePerfItem({ key: "tocOpen", readings: [null, null, null, null, null], reason: "无法建立 longtask 观测" }))
      .toMatchObject({ median: null, max: null, status: "uncollected", reason: "无法建立 longtask 观测" });
  });

  test("读数不是 5 个，或含负数、NaN、Infinity 时同样未采集并附原因；预算不是有限非负数时抛 RangeError", () => {
    const badReadings: (number | null)[][] = [
      [],
      [1, 2, 3, 4],
      [1, 2, 3, 4, 5, 6],
      [1, 2, -1, 4, 5],
      [1, 2, Number.NaN, 4, 5],
      [1, 2, Number.POSITIVE_INFINITY, 4, 5],
    ];
    for (const readings of badReadings) {
      const out = evaluatePerfItem({ key: "tocOpen", readings });
      expect(out, String(readings)).toMatchObject({ median: null, max: null, status: "uncollected" });
      expect(out.reason, String(readings)).toBeTruthy();
    }
    for (const budget of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => evaluatePerfItem({ key: "tocOpen", readings: [1, 2, 3, 4, 5] }, budget), String(budget)).toThrow(RangeError);
    }
  });
});

// ---------------------------------------------------------------------------
// 最长长任务读数（14.2 (b)(d)、14.6）
// ---------------------------------------------------------------------------

/** Long Tasks API 只报告持续 ≥ 50 ms 的任务（14.6），按需求原文写成字面量，不从被测代码取。 */
const LONG_TASK_MIN_MS = 50;

/** 观测窗口 [t0, t1]，t0 <= t1。 */
type LongTaskWindow = readonly [t0: number, t1: number];

/**
 * 属性 8 的参照：条目占据闭区间 [s, s + d]，与窗口闭区间 [t0, t1] 有公共点即算相交。这里按
 * "两区间交集非空 ⇔ 较大的左端 <= 较小的右端"写出，与被测代码的两条比较是不同的写法；
 * 端点恰好相接（s + d === t0 或 s === t1）也算相交。
 */
function overlapsWindow({ startTime, duration }: LongTaskEntry, t0: number, t1: number): boolean {
  return Math.max(startTime, t0) <= Math.min(startTime + duration, t1);
}

/** 属性 8 的期望读数：相交条目中 duration 的最大值，没有相交条目时为 0。 */
function expectedLongest(entries: readonly LongTaskEntry[], t0: number, t1: number): number {
  return entries.filter((e) => overlapsWindow(e, t0, t1)).reduce((m, e) => Math.max(m, e.duration), 0);
}

// ---------------------------------------------------------------------------
// 生成器
// ---------------------------------------------------------------------------

/**
 * 页面时间原点起的毫秒（`performance.now()` 与条目的 `startTime` 同一时基，总 ≥ 0）：稠密的
 * 小整数（大量端点重合、运算精确）、贴近真实的小数，以及大到 2^53 的值（ulp ≥ 1，s + d 会舍入）。
 */
const pageTimeArb: fc.Arbitrary<number> = fc.oneof(
  fc.integer({ min: 0, max: 2000 }),
  fc.double({ min: 0, max: 1e6, noNaN: true }),
  fc.double({ min: 0, max: 2 ** 53, noNaN: true }),
);

/** 长任务时长（≥ 50 ms，14.6）：恰为 50、常见的整数毫秒、小数，以及远长于窗口的值。 */
const longTaskDurationArb: fc.Arbitrary<number> = fc.oneof(
  fc.constant(LONG_TASK_MIN_MS),
  fc.integer({ min: LONG_TASK_MIN_MS, max: 600 }),
  fc.double({ min: LONG_TASK_MIN_MS, max: 1e5, noNaN: true }),
  fc.double({ min: LONG_TASK_MIN_MS, max: 2 ** 53, noNaN: true }),
);

const longTaskEntryArb: fc.Arbitrary<LongTaskEntry> = fc.record({
  startTime: pageTimeArb,
  duration: longTaskDurationArb,
});

const sortedWindow = ([a, b]: readonly [number, number]): LongTaskWindow => (a <= b ? [a, b] : [b, a]);

/**
 * 给定条目列表的观测窗口：与条目无关的任意窗口与单点窗口（t0 === t1），以及端点取自某条目
 * 起止时刻或其相邻 double 的窗口。后者让条目恰好在 t0 处结束、恰好在 t1 处开始（应计入），
 * 或差一个 ulp 错开（不应计入）。
 */
function longTaskWindowArb(entries: readonly LongTaskEntry[]): fc.Arbitrary<LongTaskWindow> {
  const options: { weight: number; arbitrary: fc.Arbitrary<LongTaskWindow> }[] = [
    { weight: 2, arbitrary: fc.tuple(pageTimeArb, pageTimeArb).map(sortedWindow) },
    { weight: 1, arbitrary: pageTimeArb.map((t): LongTaskWindow => [t, t]) },
  ];
  if (entries.length > 0) {
    const edge = fc.constantFrom(...entries).chain(({ startTime: s, duration: d }) => {
      const end = s + d;
      return fc.constantFrom(s, adjacentDouble(s, -1), adjacentDouble(s, 1), end, adjacentDouble(end, -1), adjacentDouble(end, 1));
    });
    options.push(
      { weight: 3, arbitrary: fc.tuple(edge, edge).map(sortedWindow) },
      { weight: 1, arbitrary: fc.tuple(edge, pageTimeArb).map(sortedWindow) },
      { weight: 1, arbitrary: edge.map((t): LongTaskWindow => [t, t]) },
    );
  }
  return fc.oneof(...options);
}

/**
 * 与窗口 [t0, t1] 不相交的条目：整段在 t0 之前（结束时刻 < t0），或在 t1 之后开始（含 t1 之后
 * 相邻的 double）。时长可远大于窗口内的条目，被误计入即会改变读数。按上式构造后仍以参照谓词
 * 过滤，排除大数值下 s + d 舍入到 t0 的情形。
 */
function outsideEntryArb(t0: number, t1: number): fc.Arbitrary<LongTaskEntry> {
  const gapArb = fc.oneof(fc.integer({ min: 1, max: 1000 }), fc.double({ min: 1e-3, max: 1e6, noNaN: true }));
  return fc
    .oneof(
      fc.tuple(longTaskDurationArb, gapArb).map(([d, g]): LongTaskEntry => ({ startTime: t0 - d - g, duration: d })),
      fc.tuple(longTaskDurationArb, gapArb).map(([d, g]): LongTaskEntry => ({ startTime: t1 + g, duration: d })),
      longTaskDurationArb.map((d): LongTaskEntry => ({ startTime: adjacentDouble(t1, 1), duration: d })),
    )
    .filter((e) => !overlapsWindow(e, t0, t1));
}

/**
 * 属性 8 的输入：条目列表、窗口、一组不相交的追加条目，以及"条目 + 追加条目"的任意重排。
 */
const longTaskScenarioArb = fc
  .array(longTaskEntryArb, { maxLength: 12 })
  .chain((entries) => fc.tuple(fc.constant(entries), longTaskWindowArb(entries)))
  .chain(([entries, [t0, t1]]) =>
    fc.array(outsideEntryArb(t0, t1), { maxLength: 6 }).chain((extras) => {
      const combined = [...entries, ...extras];
      return fc.record({
        entries: fc.constant(entries),
        t0: fc.constant(t0),
        t1: fc.constant(t1),
        extras: fc.constant(extras),
        shuffled: fc.shuffledSubarray(combined, { minLength: combined.length, maxLength: combined.length }),
      });
    }),
  );

test.describe("maxLongTask（需求 14.2、14.6）", () => {
  // Feature: e2e-visual-testing, Property 8: 最长长任务读数
  // **Validates: Requirements 14.2, 14.6**
  test("属性 8：任意条目列表（duration ≥ 50）与任意窗口 [t0, t1]，读数等于与窗口相交（端点相接也算）的条目中 duration 的最大值，没有相交条目时为 0，因此只会是 0 或 ≥ 50；追加任意不相交条目或重排条目，读数不变", () => {
    fc.assert(
      fc.property(longTaskScenarioArb, ({ entries, t0, t1, extras, shuffled }) => {
        const where = `entries=${JSON.stringify(entries)} window=[${t0}, ${t1}] extras=${JSON.stringify(extras)}`;
        const snapshot = entries.map((e) => ({ ...e }));

        const got = maxLongTask(entries, t0, t1);
        assert.deepEqual(entries, snapshot, `不修改输入（${where}）`);
        assert.equal(got, expectedLongest(entries, t0, t1), `相交条目 duration 的最大值，没有相交条目时为 0（${where}）`);
        assert.ok(got === 0 || got >= LONG_TASK_MIN_MS, `读数只会是 0 或 ≥ ${LONG_TASK_MIN_MS}，实得 ${got}（${where}）`);

        assert.equal(maxLongTask([...entries, ...extras], t0, t1), got, `追加不相交条目后不变（${where}）`);
        assert.equal(maxLongTask(shuffled, t0, t1), got, `与条目顺序无关（${where} shuffled=${JSON.stringify(shuffled)}）`);
      }),
      { numRuns: 100 },
    );
  });

  // -------------------------------------------------------------------------
  // 例子
  // -------------------------------------------------------------------------

  test("端点相接也算相交：恰在 t0 结束、恰在 t1 开始的条目计入，错开 1 ms 即不计入；跨越整个窗口与单点窗口内的条目计入", () => {
    const [t0, t1] = [1000, 2000];
    expect(maxLongTask([{ startTime: 900, duration: 100 }], t0, t1)).toBe(100); // 结束于 t0
    expect(maxLongTask([{ startTime: 2000, duration: 80 }], t0, t1)).toBe(80); // 开始于 t1
    expect(maxLongTask([{ startTime: 899, duration: 100 }], t0, t1)).toBe(0); // 结束于 t0 前 1 ms
    expect(maxLongTask([{ startTime: 2001, duration: 80 }], t0, t1)).toBe(0); // 开始于 t1 后 1 ms
    expect(maxLongTask([{ startTime: 500, duration: 3000 }], t0, t1)).toBe(3000); // 窗口前开始、窗口后结束
    expect(maxLongTask([{ startTime: 950, duration: 60 }], 1000, 1000)).toBe(60); // 单点窗口落在任务中
    expect(maxLongTask([{ startTime: 1000, duration: 60 }], 1000, 1000)).toBe(60); // 单点窗口恰为任务起点
    expect(maxLongTask([{ startTime: 940, duration: 60 }], 1000, 1000)).toBe(60); // 单点窗口恰为任务终点
  });

  test("读数取相交条目中 duration 的最大值，窗口外更长的条目不计入；空列表或全在窗口外时为 0", () => {
    const [t0, t1] = [6000, 7000];
    const entries: LongTaskEntry[] = [
      { startTime: 100, duration: 5000 }, // 5100 结束，窗口前
      { startTime: 6100, duration: 70 },
      { startTime: 6500, duration: 180 },
      { startTime: 6950, duration: 120 }, // 延续到窗口后
      { startTime: 7200, duration: 900 }, // 窗口后
    ];
    expect(maxLongTask(entries, t0, t1)).toBe(180);
    expect(maxLongTask([...entries].reverse(), t0, t1)).toBe(180);
    expect(maxLongTask([], t0, t1)).toBe(0);
    expect(maxLongTask([entries[0], entries[4]], t0, t1)).toBe(0);
  });

  test("窗口无效时抛 RangeError（t0 > t1，或任一端为 NaN、±Infinity），不返回看似正常的 0", () => {
    const windows: [number, number][] = [
      [2000, 1000],
      [1, 1 - Number.EPSILON],
      [Number.NaN, 1000],
      [1000, Number.NaN],
      [Number.NEGATIVE_INFINITY, 1000],
      [1000, Number.POSITIVE_INFINITY],
      [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY],
    ];
    for (const [t0, t1] of windows) {
      expect(() => maxLongTask([], t0, t1), `[${t0}, ${t1}]`).toThrow(RangeError);
      expect(() => maxLongTask([{ startTime: 1000, duration: 60 }], t0, t1), `[${t0}, ${t1}]`).toThrow(RangeError);
    }
  });
});
