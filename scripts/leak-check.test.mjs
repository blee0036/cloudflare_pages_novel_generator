/**
 * scripts/leak-check.mjs 的测试（test-data-desensitization 需求 5.14；设计"Testing Strategy"）。
 *
 * 文件按以下顺序组织，后续任务往相应位置追加：
 *   1. 共享部分：字母表与生成器、朴素参照，属性 1–4 共用；
 *   2. 属性测试：每个属性一个 describe，按编号排列，numRuns 取 200；
 *   3. 例子测试：I/O 外壳 runLeakCheck，在临时目录里进行。
 *
 * 源码只出现合成的字符串，不读取本机 public/data/books.json。
 */
import fc from "fast-check";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder, TextEncoder } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { analyze, buildTerms, formatReport, runLeakCheck, splitExemptText } from "./leak-check.mjs";

// ---------------------------------------------------------------------------
// 共享：字母表与生成器
// ---------------------------------------------------------------------------

/** 增补平面字符 U+20000：1 个码点、2 个 UTF-16 码元。 */
const ASTRAL = "\u{20000}";

/**
 * 小字母表：两个 ASCII 字母、两个汉字、换行与一个增补平面字符。字母少，重叠出现、跨行出现、
 * 分桶键切在代理对中间（如 "a" 加高代理）这几种情形都很常见。
 */
const ALPHABET = ["a", "b", "甲", "乙", "\n", ASTRAL];

/** 字母表中的 1 个字符，即 1 个码点。 */
const char = fc.constantFrom(...ALPHABET);

/** 路径用同一字母表，外加目录分隔符。 */
const pathChar = fc.constantFrom(...ALPHABET, "/");

/** 码点数小于 2 的字段值：空串或 1 个字符（含单个增补平面字符，它有 2 个码元）。 */
const shortValue = fc.string({ unit: char, maxLength: 1 });

/** 码点数不小于 2 的字段值。上限取得小，同一取值跨书、跨字段重复的机会才多。 */
const termValue = fc.string({ unit: char, minLength: 2, maxLength: 3 });

/** 书目项的一个字段：多为不短于 2 个码点的串，也有短串。 */
const fieldValue = fc.oneof({ arbitrary: termValue, weight: 3 }, { arbitrary: shortValue, weight: 1 });

/**
 * 0–maxLength 项的数组，空数组约占 1/8。直接写 fc.array 时长度偏向下限，空数组会占到近 1/5，
 * 而书目或文件列表为空时必然没有命中，那一次比对几乎什么也没验证。
 */
const mostlyNonEmpty = (item, maxLength) =>
  fc.oneof(
    { arbitrary: fc.constant([]), weight: 1 },
    { arbitrary: fc.array(item, { minLength: 1, maxLength, size: "max" }), weight: 7 },
  );

/**
 * 书目的生成器：先用 value 取 1–8 个字段值作为取值池，再取 0–5 本书，每个字段从池中选。同一
 * 取值因此经常跨书、跨字段重复，属于多个类别的词也就常见。
 *
 * @param {fc.Arbitrary<string>} value  字段值的生成器
 */
const catalogOf = (value) =>
  fc
    .tuple(
      fc.array(value, { minLength: 1, maxLength: 8 }),
      mostlyNonEmpty(fc.tuple(fc.nat(), fc.nat(), fc.nat()), 5),
    )
    .map(([pool, picks]) =>
      picks.map(([t, a, i]) => ({
        title: pool[t % pool.length],
        author: pool[a % pool.length],
        id: pool[i % pool.length],
      })),
    );

/** 书目，字段值取自 fieldValue。 */
const catalog = catalogOf(fieldValue);

/**
 * 偏重短串的字段值：长短各半。短串指码点数小于 2 的三种串，各占一份：空串、单个 BMP 字符、
 * 单个增补平面字符。
 */
const shortHeavyValue = fc.oneof(
  { arbitrary: termValue, weight: 3 },
  { arbitrary: fc.constant(""), weight: 1 },
  { arbitrary: fc.constantFrom(...ALPHABET.filter((c) => c.length === 1)), weight: 1 },
  { arbitrary: fc.constant(ASTRAL), weight: 1 },
);

/**
 * 偏重短串的书目，结构同 catalog，用于检验检索词表对短串的排除与计数。catalog 里短串偏少：
 * 约一半书目一个短串也没有，单个增补平面字符只出现在约 5% 的书目里。改用 shortHeavyValue 后，
 * 三种短串各出现在三成以上的书目里，跨书、跨字段的重复与 catalog 相当。
 */
const shortHeavyCatalog = catalogOf(shortHeavyValue);

const encoder = new TextEncoder();

/**
 * 一段内容：0–40 个字符，约 1/6 是换行。显式写 size: "max"，长度才会取满整个区间；
 * fast-check 默认的 size 会把上限压到 10。
 */
const contentText = fc.string({ unit: char, maxLength: 40, size: "max" });

/** 文本文件：一段内容的 UTF-8 编码。kind 是生成时的形态，不传给 analyze。 */
const textBody = contentText.map((text) => ({ kind: "text", bytes: encoder.encode(text) }));

/**
 * 非 UTF-8 文件：在一段内容的 UTF-8 字节中任选一处（可以落在多字节字符中间）插入 0xFF。
 * 0xFF 在 UTF-8 中永不合法，严格解码必然失败；其余字节仍是能命中的文本，实现若误把它当
 * 文本解码，就会多出内容命中。
 */
const binaryBody = fc.tuple(contentText, fc.nat()).map(([text, at]) => {
  const utf8 = encoder.encode(text);
  const cut = at % (utf8.length + 1);
  const bytes = new Uint8Array(utf8.length + 1);
  bytes.set(utf8.subarray(0, cut), 0);
  bytes[cut] = 0xff;
  bytes.set(utf8.subarray(cut), cut + 1);
  return { kind: "binary", bytes };
});

/** 已列出但工作区中不存在的文件。 */
const missingBody = fc.constant({ kind: "missing", bytes: null });

const body = fc.oneof(
  { arbitrary: textBody, weight: 3 },
  { arbitrary: binaryBody, weight: 1 },
  { arbitrary: missingBody, weight: 1 },
);

/**
 * 文件列表：先取 1–4 个互不相同的路径作为路径池，再取 0–6 个文件项，每项的路径从池中选。
 *
 * 所以同一路径可能出现多次，也可能一次都不出现。git ls-files 不会列出重复路径，但 analyze
 * 约定同一路径的多项"命中合并去重"。朴素参照把（路径，行号，命中词）收进同一个集合，天然
 * 符合这一约定；跨文件项的全局去重也因此受到检验，路径唯一时它永远不会被触发。
 */
const listedFiles = fc
  .tuple(
    fc.uniqueArray(fc.string({ unit: pathChar, minLength: 1, maxLength: 8 }), {
      minLength: 1,
      maxLength: 4,
    }),
    mostlyNonEmpty(fc.tuple(fc.nat(), body), 6),
  )
  .map(([paths, entries]) => entries.map(([k, file]) => ({ path: paths[k % paths.length], ...file })));

/** 书目三个字段的全部取值，按书目顺序，可能重复。 */
const fieldValues = (books) => books.flatMap(({ title, author, id }) => [title, author, id]);

/**
 * Exemption_File 的一行，不含行尾换行。多数取自 values，即书目的字段取值，豁免因此确实会排除
 * 一些词；其余是无关串与空行。values 为空时只有后两种。豁免行依赖书目，所以先生成书目，再用
 * chain 生成豁免行。
 *
 * 取自书目的行不一定排除得了检索词：取值短于 2 个码点时只计入 shortExcluded；取值含换行时，
 * 写进文本后会断成几行。无关串偶尔恰好等于某个取值，同样参与比对。
 *
 * 需要更多种行（如取值的真子串、超串）时，可以与本生成器用 fc.oneof 组合；行尾写 "\n" 还是
 * "\r\n"，由连成文本的一方决定。
 *
 * @param {string[]} values  通常是 fieldValues(books)
 */
const exemptFileLine = (values) =>
  fc.oneof(
    ...(values.length > 0 ? [{ arbitrary: fc.constantFrom(...values), weight: 3 }] : []),
    { arbitrary: termValue, weight: 1 },
    { arbitrary: fc.constant(""), weight: 1 },
  );

// ---------------------------------------------------------------------------
// 共享：朴素参照
// ---------------------------------------------------------------------------

/** 书目项参与检索的三个字段，也是类别的固定顺序（书名、作者、书 id）。 */
const CATEGORIES = ["title", "author", "id"];

/**
 * 检索词表的参照（豁免清单为空）：三个字段的全部取值中，码点数不小于 2 的不同字符串。
 * 每个词的类别是它作为取值出现过的字段，按固定顺序列出。
 *
 * @returns {Map<string, string[]>}
 */
function referenceTerms(books) {
  const terms = new Map();
  for (const book of books) {
    for (const category of CATEGORIES) {
      const value = book[category];
      if ([...value].length < 2 || terms.has(value)) continue;
      terms.set(value, CATEGORIES.filter((c) => books.some((other) => other[c] === value)));
    }
  }
  return terms;
}

/** shortExcluded 的参照：三个字段的全部取值中，码点数小于 2 的不同字符串个数（含空串）。 */
function referenceShortExcluded(books) {
  return new Set(fieldValues(books).filter((value) => [...value].length < 2)).size;
}

/**
 * 把检索词表统一成 [词, 类别数组] 的列表，按词的 UTF-16 码元序排列，以便比较。buildTerms 给出
 * Map<string, Set<类别>>，referenceTerms 给出 Map<string, string[]>；类别保留各自的顺序。
 *
 * @param {Map<string, Iterable<string>>} terms
 * @returns {[string, string[]][]}
 */
function termEntries(terms) {
  return [...terms]
    .map(([term, categories]) => [term, [...categories]])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** 与实现相同的解码方式：严格按 UTF-8、保留 BOM；不是合法的 UTF-8 时返回 null。 */
function decodeStrict(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** 记录的参照顺序：路径升序（UTF-16 码元序），同一路径的路径命中在前，再按行号、命中词升序。 */
function compareRecords(a, b) {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  if (a.line !== b.line) {
    if (a.line === null) return -1;
    if (b.line === null) return 1;
    return a.line - b.line;
  }
  if (a.term !== b.term) return a.term < b.term ? -1 : 1;
  return 0;
}

/**
 * 朴素子串匹配（设计"Property 1"）：
 * - 对每个文件项、每个检索词，用 indexOf 逐个找出全部出现位置（含重叠），每处记
 *   （路径，起始行号，词），起始行号 = 1 + 起始位置之前 "\n" 的个数；
 * - 只有能按 UTF-8 严格解码的文件比对内容，二进制与不存在的文件只比对路径；
 * - 词出现在路径里时记（路径，null，词），null 表示路径命中；
 * - 同一（路径，行号，词）只记一次，同一路径的多个文件项因此合并；
 * - 每条记录带上该词的类别，取自 referenceTerms。
 *
 * @param {Map<string, string[]>} terms  referenceTerms 的结果
 * @param {{ path: string, bytes: Uint8Array | null }[]} files
 * @returns 按 compareRecords 排好的记录
 */
function referenceHits(terms, files) {
  const records = new Map();
  const add = (path, line, term) => {
    records.set(JSON.stringify([path, line, term]), { path, line, term, categories: terms.get(term) });
  };
  for (const { path, bytes } of files) {
    const content = bytes === null ? null : decodeStrict(bytes);
    for (const term of terms.keys()) {
      if (path.includes(term)) add(path, null, term);
      if (content === null) continue;
      for (let at = content.indexOf(term); at !== -1; at = content.indexOf(term, at + 1)) {
        add(path, content.slice(0, at).split("\n").length, term);
      }
    }
  }
  return [...records.values()].sort(compareRecords);
}

/** 按生成时的形态给文件项计数，total = text + binary + missing。 */
function countKinds(files) {
  const counts = { total: files.length, text: 0, binary: 0, missing: 0 };
  for (const { kind } of files) counts[kind] += 1;
  return counts;
}

// ---------------------------------------------------------------------------
// 属性测试
// ---------------------------------------------------------------------------

describe("属性 1：匹配结果等于朴素子串匹配", () => {
  // Feature: test-data-desensitization, Property 1: 匹配结果等于朴素子串匹配
  // **Validates: Requirements 5.7, 5.8, 5.9**
  it("对任意书目与文件列表：命中记录逐条等于朴素参照且严格升序；退出码、命中数与各类文件数与输入一致", () => {
    fc.assert(
      fc.property(catalog, listedFiles, (books, files) => {
        // 前提：生成时的形态与严格解码的判定一致，否则下面的比对没有意义
        for (const { kind, bytes } of files) {
          if (kind !== "missing") expect(decodeStrict(bytes) === null).toBe(kind === "binary");
        }

        const terms = referenceTerms(books);
        const expected = referenceHits(terms, files);
        const report = analyze({ books, files: files.map(({ path, bytes }) => ({ path, bytes })) });

        expect(report.hits).toEqual(expected);
        for (let i = 1; i < report.hits.length; i++) {
          expect(compareRecords(report.hits[i - 1], report.hits[i])).toBeLessThan(0);
        }

        const { stdout, stderr, exitCode } = formatReport(report);
        expect(exitCode).toBe(expected.length > 0 ? 1 : 0);
        expect(stderr).toBe("");

        // 汇总是 stdout 的最后 3 行。记录里的路径与命中词可能含 "\n"，所以从末尾往前取。
        const counts = countKinds(files);
        expect(stdout.endsWith("\n")).toBe(true);
        const [found, scanned] = stdout.split("\n").slice(-4, -2);
        expect(found).toBe(
          expected.length > 0 ? `leak-check: 命中 ${expected.length} 处。` : "leak-check: 未发现命中。",
        );
        expect(scanned).toBe(
          `leak-check: 扫描 ${counts.total} 个文件（文本 ${counts.text}、二进制 ${counts.binary}、` +
            `不存在 ${counts.missing}），检索词 ${terms.size} 个。`,
        );
      }),
      { numRuns: 200 },
    );
  });
});

describe("属性 2：输出确定且与输入顺序无关", () => {
  /** 数组的任一排列，可能就是原顺序。fc.shuffledSubarray 取满长度时，各排列等概率出现。 */
  const permutationOf = (items) =>
    fc.shuffledSubarray(items, { minLength: items.length, maxLength: items.length });

  /**
   * 一次分析的输入：书目、Exemption_File 的各行（未切分，可含空行）与文件列表。
   * 文件列表可能有重复路径，见 listedFiles。
   */
  const analysisInput = catalog.chain((books) =>
    fc.record({
      books: fc.constant(books),
      exemptFileLines: mostlyNonEmpty(exemptFileLine(fieldValues(books)), 6),
      files: listedFiles,
    }),
  );

  /** 原输入，以及书目条目、豁免行、文件列表各自重排后的输入。两者的元素是同一批对象。 */
  const originalAndReordered = analysisInput.chain((input) =>
    fc.tuple(
      fc.constant(input),
      fc.record({
        books: permutationOf(input.books),
        exemptFileLines: permutationOf(input.exemptFileLines),
        files: permutationOf(input.files),
      }),
    ),
  );

  /**
   * 豁免行以 "\n" 连成 Exemption_File 的文本，经 splitExemptText 切分后，连同书目与文件列表
   * 交给 analyze，再由 formatReport 渲染。
   */
  const analyzeAndRender = ({ books, exemptFileLines, files }) =>
    formatReport(
      analyze({
        books,
        exemptLines: splitExemptText(exemptFileLines.join("\n")),
        files: files.map(({ path, bytes }) => ({ path, bytes })),
      }),
    );

  // Feature: test-data-desensitization, Property 2: 输出确定且与输入顺序无关
  // **Validates: Requirements 5.1, 5.8**
  it("对任意书目、豁免行与文件列表：连续两次分析并渲染，结果逐字节相同；三者各自重排后，结果仍与原输入逐字节相同", () => {
    fc.assert(
      fc.property(originalAndReordered, ([input, reordered]) => {
        const first = analyzeAndRender(input);

        const again = analyzeAndRender(input);
        expect(again.stdout).toBe(first.stdout);
        expect(again.stderr).toBe(first.stderr);
        expect(again.exitCode).toBe(first.exitCode);

        const shuffled = analyzeAndRender(reordered);
        expect(shuffled.stdout).toBe(first.stdout);
        expect(shuffled.stderr).toBe(first.stderr);
        expect(shuffled.exitCode).toBe(first.exitCode);
      }),
      { numRuns: 200 },
    );
  });
});

describe("属性 3：检索词表由书目去重得到，短词排除并计数", () => {
  // Feature: test-data-desensitization, Property 3: 检索词表由书目去重得到，短词排除并计数
  // **Validates: Requirements 5.2, 5.4**
  it("对任意书目（豁免清单为空）：检索词恰为码点数不小于 2 的不同取值，类别恰为各词出现过的字段且按固定顺序；shortExcluded 等于码点数小于 2 的不同取值个数，exemptExcluded 为 0", () => {
    fc.assert(
      fc.property(shortHeavyCatalog, (books) => {
        const table = buildTerms(books, []);

        expect(termEntries(table.terms)).toEqual(termEntries(referenceTerms(books)));
        expect(table.shortExcluded).toBe(referenceShortExcluded(books));
        expect(table.exemptExcluded).toBe(0);

        // 附加核对，不属于属性 3：buildTerms 的 JSDoc 约定 terms 按 UTF-16 码元序插入。
        // 字母表里的 BMP 字符都在代理区之前，码元序与码点序在这里一致，这一步分不出两者。
        const keys = [...table.terms.keys()];
        expect(keys).toEqual([...keys].sort());
      }),
      { numRuns: 200 },
    );
  });
});

describe("属性 4：豁免只按整行相等排除", () => {
  /**
   * terms 中某个词的真子串：按码点截取，长 1 至（码点数 − 1）个。terms 中的词都不短于 2 个码点，
   * 截出的串因此非空、不等于原词，但可能恰好等于别的取值。
   *
   * @param {string[]} terms
   */
  const properSubstringOf = (terms) =>
    fc.tuple(fc.constantFrom(...terms), fc.nat(), fc.nat()).map(([term, a, b]) => {
      const chars = [...term];
      const length = 1 + (a % (chars.length - 1));
      const start = b % (chars.length - length + 1);
      return chars.slice(start, start + length).join("");
    });

  /**
   * 超串补的字：一半取字母表中除换行以外的字符，一半取空格或 "\r"。不补换行，超串写进文本后
   * 仍是一整行。空格与 "\r" 检验整行原样比较：行首、行尾的空白都不去掉，"\r" 也不当作换行。
   */
  const padChar = fc.oneof(fc.constantFrom(...ALPHABET.filter((c) => c !== "\n")), fc.constantFrom(" ", "\r"));

  /**
   * terms 中某个词的超串，四种写法各约占 1/4：在词前、词后或两头各补 1 个字，或者只在词后补 "\r"。
   * 最后一种检验行尾只去掉一个 "\r"：行尾是 "\n"，或它是不带行尾的最后一行时，切分后恰好等于
   * 原词；行尾是 "\r\n" 时只去掉一个 "\r"，仍是超串。
   *
   * @param {string[]} terms
   */
  const superstringOf = (terms) =>
    fc
      .tuple(
        fc.constantFrom(...terms),
        fc.oneof(
          padChar.map((before) => [before, ""]),
          padChar.map((after) => ["", after]),
          fc.tuple(padChar, padChar),
          fc.constant(["", "\r"]),
        ),
      )
      .map(([term, [before, after]]) => before + term + after);

  /**
   * Exemption_File 的一行，不含行尾。五种行：
   * - 取值本身：exemptFileLine 从全部取值中选，含短串与含换行的取值；另从不含换行的检索词中
   *   直接选，这些词写进文本后仍是一整行，会被排除；
   * - 检索词的真子串与超串；
   * - 无关串与空行：由 exemptFileLine 给出。
   *
   * 各种都可选时，五种行依次约占 5/13、2/13、4/13、1/13、1/13。书目中没有检索词时，只剩
   * exemptFileLine 给出的行。
   *
   * @param {string[]} values  fieldValues(books)
   */
  const exemptionLine = (values) => {
    const terms = [...new Set(values)].filter((value) => [...value].length >= 2);
    const wholeLineTerms = terms.filter((term) => !term.includes("\n"));
    return fc.oneof(
      { arbitrary: exemptFileLine(values), weight: 5 },
      ...(wholeLineTerms.length > 0 ? [{ arbitrary: fc.constantFrom(...wholeLineTerms), weight: 2 }] : []),
      ...(terms.length > 0
        ? [
            { arbitrary: properSubstringOf(terms), weight: 2 },
            { arbitrary: superstringOf(terms), weight: 4 },
          ]
        : []),
    );
  };

  /**
   * 书目与 Exemption_File 的各行（0–12 行）。书目一半取 catalog，一半取 shortHeavyCatalog：前者
   * 检索词多，排除与近似的行常见；后者短串多，短串常出现在豁免行里。每行的行尾独立地取 "\n"
   * 或 "\r\n"，同一文本里两种行尾因此常常混用；finalNewline 为 false 时，最后一行不带行尾。
   */
  const exemptionInput = fc.oneof(catalog, shortHeavyCatalog).chain((books) =>
    fc.record({
      books: fc.constant(books),
      lines: mostlyNonEmpty(fc.tuple(exemptionLine(fieldValues(books)), fc.constantFrom("\n", "\r\n")), 12),
      finalNewline: fc.boolean(),
    }),
  );

  /** 各行连同行尾连成 Exemption_File 的文本。 */
  const exemptText = ({ lines, finalNewline }) =>
    lines.map(([line, ending], i) => (finalNewline || i < lines.length - 1 ? line + ending : line)).join("");

  /**
   * 应排除的检索词（设计"处理步骤 2"与"Exemption_File"）：文本按 "\n" 分行，每行去掉行尾的
   * 一个 "\r"，忽略空行；terms 中与某一行完全相等的词。
   *
   * 比对用切分后的行，不用生成时的各行：取值含换行时，写进文本后会断成几行；超串"词 + \r"在
   * 行尾是 "\n"、或它是不带行尾的最后一行时，切分后就等于原词。
   *
   * @param {Map<string, string[]>} terms  referenceTerms 的结果
   * @param {string} text
   * @returns {Set<string>}
   */
  const referenceExempted = (terms, text) => {
    const lines = new Set(
      text
        .split("\n")
        .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
        .filter((line) => line !== ""),
    );
    return new Set([...terms.keys()].filter((term) => lines.has(term)));
  };

  // Feature: test-data-desensitization, Property 4: 豁免只按整行相等排除
  // **Validates: Requirements 5.5**
  it("对任意书目与豁免文本（各行为取值本身、检索词的真子串或超串、无关串或空行，行尾为 LF 或 CRLF）：排除的检索词恰为与某一非空行完全相等的那些，其余检索词与类别不变；exemptExcluded 等于排除的词数，shortExcluded 与无豁免时相同", () => {
    fc.assert(
      fc.property(exemptionInput, (input) => {
        const text = exemptText(input);
        const terms = referenceTerms(input.books);
        const exempted = referenceExempted(terms, text);

        const table = buildTerms(input.books, splitExemptText(text));

        // 排除的恰为 exempted；其余检索词连同类别与无豁免时相同
        expect(termEntries(table.terms)).toEqual(termEntries(terms).filter(([term]) => !exempted.has(term)));
        // 按去重后的检索词计数：对不上任何取值的行、码点数小于 2 的取值都不计入
        expect(table.exemptExcluded).toBe(exempted.size);
        // 短串只计入 shortExcluded，它也出现在豁免行里时同样如此
        expect(table.shortExcluded).toBe(referenceShortExcluded(input.books));
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// 例子测试：I/O 外壳 runLeakCheck
// ---------------------------------------------------------------------------

/** 本机书目与 Exemption_File 在仓库内的位置，即 runLeakCheck 的默认值。 */
const BOOKS_JSON = "public/data/books.json";
const EXEMPT_FILE = "scripts/leak-check-exempt.local.txt";

/**
 * 合成书目，写成 public/data/books.json 的形状。顶层的 count、generatedAt 与书目项的
 * totalChapters 都不是检索词的来源，Leak_Check 应当忽略。四本书各有用途：
 * - A：书名、作者、书 id 各不相同，书 id 含书名与作者；
 * - B：同一字符串既是书名又是作者，记录写作 [书名、作者]；
 * - C：书名只有 1 个字符；作者与 A 相同，只算 1 个检索词；
 * - D：作者为空串；书名留给豁免清单的用例。
 * 检索词共 8 个；C 的书名与 D 的作者短于 2 个字符，排除 2 个。
 */
const CATALOG = {
  count: 4,
  generatedAt: "2000-01-01T00:00:00Z",
  books: [
    { id: "合成书名甲-虚构作者乙", title: "合成书名甲", author: "虚构作者乙", totalChapters: 3 },
    { id: "同名词丙丁-同名词丙丁", title: "同名词丙丁", author: "同名词丙丁", totalChapters: 2 },
    { id: "戊-虚构作者乙", title: "戊", author: "虚构作者乙", totalChapters: 1 },
    { id: "豁免词己庚-无作者", title: "豁免词己庚", author: "", totalChapters: 1 },
  ],
};

/**
 * 临时仓库的 .gitignore：与仓库根的写法一致，忽略本机书目与 Exemption_File。两者的内容
 * 就是检索词，不在扫描范围内。
 */
const REPO_GITIGNORE = `public/data/\n${EXEMPT_FILE}\n`;

/**
 * 临时仓库的 .gitattributes：关掉换行转换，git add 因此不受本机 core.autocrlf、core.safecrlf
 * 的影响（safecrlf 为 true 时，git add 可能拒收需要转换换行的文件）。工作区文件的字节本来
 * 就不受这些设置影响。
 */
const REPO_GITATTRIBUTES = "* -text\n";

/** 本仓库的根目录：本文件在 scripts/ 下。 */
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** 各行连同行尾的 "\n" 连成一段文本，即期望的 stdout。 */
const joinLines = (...lines) => lines.map((line) => `${line}\n`).join("");

/** 本组用例建的临时目录，afterEach 中删除。 */
const tempDirs = [];

/** 在 os.tmpdir() 下新建一个空目录。 */
function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "leak-check-"));
  tempDirs.push(dir);
  return dir;
}

/**
 * 在 root 下写入文件。键是以 / 分隔的相对路径，值是字符串（按 UTF-8 写入）或字节数组；
 * 上级目录按需创建。
 */
function writeFiles(root, files) {
  for (const [rel, data] of Object.entries(files)) {
    const file = join(root, ...rel.split("/"));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, data);
  }
}

/**
 * 在 cwd 下运行 git。stdout 与 stderr 都收下、不打印；失败时 execFileSync 抛出的错误带有
 * git 的 stderr。例子测试只用 init -q 与 add：不提交，不改 config。
 */
function git(cwd, ...args) {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
}

/**
 * 新建临时 git 仓库：git init -q，写入 .gitignore、.gitattributes 与合成书目，再写入 files。
 * 这里不 add 任何文件，files 都是未跟踪的；需要已跟踪的文件时由调用方 add。
 */
function makeRepo(files = {}) {
  const root = makeTempDir();
  git(root, "init", "-q");
  writeFiles(root, {
    ".gitignore": REPO_GITIGNORE,
    ".gitattributes": REPO_GITATTRIBUTES,
    [BOOKS_JSON]: JSON.stringify(CATALOG),
    ...files,
  });
  return root;
}

/**
 * 扫描范围内各类文件都有的临时仓库，5.7 的用例与 5.1、5.12 共用：
 * - tracked.txt：已跟踪，内容含 A 的书名；
 * - untracked.txt：未跟踪、未被忽略，内容含 A 的作者；
 * - gone/合成书名甲.txt：add 之后从工作区删除，路径含 A 的书名，删除前的内容含 A 的作者；
 * - blob/虚构作者乙.bin：已跟踪，路径含 A 的作者，内容是 0xFF 加 A 的书名的 UTF-8；
 * - .gitignore、.gitattributes：未跟踪，不含检索词；
 * - 本机书目，以及 extraFiles 中的 Exemption_File：被忽略，不扫描。
 *
 * @param {Record<string, string | Uint8Array>} [extraFiles]  另外写入的文件，例如 Exemption_File
 */
function makeScanRepo(extraFiles = {}) {
  const root = makeRepo({
    "tracked.txt": "合成书名甲\n",
    "untracked.txt": "虚构作者乙\n",
    "gone/合成书名甲.txt": "虚构作者乙\n",
    "blob/虚构作者乙.bin": new Uint8Array([0xff, ...encoder.encode("合成书名甲\n")]),
    ...extraFiles,
  });
  git(root, "add", "--", "tracked.txt", "gone/合成书名甲.txt", "blob/虚构作者乙.bin");
  unlinkSync(join(root, "gone", "合成书名甲.txt"));
  return root;
}

/**
 * 目录树中每个文件的相对路径（以 / 分隔）、大小、mtimeMs 与 SHA-256，按路径升序，含 .git。
 *
 * @returns {{ path: string, size: number, mtimeMs: number, sha256: string }[]}
 */
function snapshotTree(root) {
  const entries = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(file, path);
      } else {
        const { size, mtimeMs } = statSync(file);
        const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
        entries.push({ path, size, mtimeMs, sha256 });
      }
    }
  };
  walk(root, "");
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** 合法书目中的 A，用来拼出只有一处不合法的书目。 */
const [BOOK_A] = CATALOG.books;

/**
 * 需求 5.11 的 7 种坏输入：[说明, 写入临时目录的文件, 期望的 stderr 中"错误："之后的部分]。
 * 前 6 种坏在 books.json；最后一种的 books.json 合法，坏在 Exemption_File。临时目录都不是
 * git 仓库：这些检查早于取文件列表，若实现先调用 git，得到的会是另一条错误。
 */
const BAD_INPUTS = [
  ["books.json 不是合法的 UTF-8", { [BOOKS_JSON]: new Uint8Array([0x7b, 0xff, 0x7d]) }, `${BOOKS_JSON}：不是合法的 UTF-8`],
  // 截断：少了末尾的 }
  ["books.json 不是合法的 JSON", { [BOOKS_JSON]: JSON.stringify(CATALOG).slice(0, -1) }, `${BOOKS_JSON}：不是合法的 JSON`],
  ["books.json 顶层是数组", { [BOOKS_JSON]: JSON.stringify(CATALOG.books) }, `${BOOKS_JSON}：顶层不是对象`],
  ["books.json 缺 books", { [BOOKS_JSON]: JSON.stringify({ count: 1, items: [BOOK_A] }) }, `${BOOKS_JSON}：顶层没有 books 数组`],
  [
    "books 中有非对象",
    { [BOOKS_JSON]: JSON.stringify({ books: [BOOK_A, BOOK_A.title] }) },
    `${BOOKS_JSON}：books[1] 不是对象`,
  ],
  [
    "books 中有字段不是字符串",
    { [BOOKS_JSON]: JSON.stringify({ books: [{ ...BOOK_A, author: 7 }] }) },
    `${BOOKS_JSON}：books[0].author 不是字符串`,
  ],
  [
    "Exemption_File 不是合法的 UTF-8",
    {
      [BOOKS_JSON]: JSON.stringify(CATALOG),
      [EXEMPT_FILE]: new Uint8Array([...encoder.encode("豁免词己庚\n"), 0xff]),
    },
    `${EXEMPT_FILE}：不是合法的 UTF-8`,
  ],
];

// 每个用例都起 git 子进程；Windows 上进程启动慢，又与其他测试文件并行，超时放宽到 30 秒
describe("runLeakCheck 的例子测试", { timeout: 30_000 }, () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("5.7 已 add 后又删除的文件计入不存在，含 0xFF 的文件计入二进制：两者都只比对路径，内容里的检索词不报，路径里的照报", () => {
    const root = makeScanRepo();

    const result = runLeakCheck({ root });

    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      joinLines(
        "blob/虚构作者乙.bin:(路径): [作者] 虚构作者乙",
        "gone/合成书名甲.txt:(路径): [书名] 合成书名甲",
        "tracked.txt:1: [书名] 合成书名甲",
        "untracked.txt:1: [作者] 虚构作者乙",
        "leak-check: 命中 4 处。",
        "leak-check: 扫描 6 个文件（文本 4、二进制 1、不存在 1），检索词 8 个。",
        "leak-check: 排除短于 2 个字符的词 2 个，按豁免清单排除 0 个。",
      ),
    );
    expect(result.exitCode).toBe(1);
  });

  it("5.8 渲染格式：行号记录、(路径) 记录、多类别写作 [书名、作者]，最后是 3 行汇总；stdout 逐字节等于期望文本，exit 1", () => {
    const root = makeRepo({
      // 一行里是 A 的书 id，书名与作者都是它的子串：同一行 3 条记录，按命中词排序
      "ids.txt": "合成书名甲-虚构作者乙\n",
      "multi.txt": "同名词丙丁\n",
      // CRLF 换行：行号只按 \n 计
      "notes.txt": "plain line\r\nsee 合成书名甲 here\r\nplain line\r\nby 虚构作者乙\r\n",
      // 路径与内容都命中：路径命中排在该文件各行之前
      "合成书名甲.md": "虚构作者乙\n",
    });

    const result = runLeakCheck({ root });

    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      joinLines(
        "ids.txt:1: [书名] 合成书名甲",
        "ids.txt:1: [书 id] 合成书名甲-虚构作者乙",
        "ids.txt:1: [作者] 虚构作者乙",
        "multi.txt:1: [书名、作者] 同名词丙丁",
        "notes.txt:2: [书名] 合成书名甲",
        "notes.txt:4: [作者] 虚构作者乙",
        "合成书名甲.md:(路径): [书名] 合成书名甲",
        "合成书名甲.md:1: [作者] 虚构作者乙",
        "leak-check: 命中 8 处。",
        "leak-check: 扫描 6 个文件（文本 6、二进制 0、不存在 0），检索词 8 个。",
        "leak-check: 排除短于 2 个字符的词 2 个，按豁免清单排除 0 个。",
      ),
    );
    expect(result.exitCode).toBe(1);
  });

  it("5.9 无命中（文件里只有短于 2 个字符的书名与中间加了空格的书名）：stdout 只有 3 行汇总，第一行写作未发现命中，exit 0", () => {
    const root = makeRepo({ "readme.txt": "戊\n合成书名 甲\n" });

    expect(runLeakCheck({ root })).toEqual({
      stdout: joinLines(
        "leak-check: 未发现命中。",
        "leak-check: 扫描 3 个文件（文本 3、二进制 0、不存在 0），检索词 8 个。",
        "leak-check: 排除短于 2 个字符的词 2 个，按豁免清单排除 0 个。",
      ),
      stderr: "",
      exitCode: 0,
    });
  });

  it("5.4、5.5 短于 2 个字符的词与豁免词不参与匹配，汇总第三行报出两类排除数；豁免清单开头有 BOM，含 CRLF 与空行", () => {
    const root = makeRepo({
      // 依次为：D 的书名（前有 BOM、后为 CRLF）、空行、D 的书名的真子串、无关串、C 的书名（短于 2 个字符）
      [EXEMPT_FILE]: "\uFEFF豁免词己庚\r\n\r\n豁免词\nunrelated line\n戊\n",
      "exempt.txt": "豁免词己庚\n豁免词己庚-无作者\n戊\n",
    });

    // 第 1 行是已豁免的书名；第 2 行是含该书名的书 id，照报；第 3 行的书名短于 2 个字符。
    // 豁免行中只有 D 的书名计入豁免数：真子串与无关串对不上任何取值，短词只计入短词数。
    expect(runLeakCheck({ root })).toEqual({
      stdout: joinLines(
        "exempt.txt:2: [书 id] 豁免词己庚-无作者",
        "leak-check: 命中 1 处。",
        "leak-check: 扫描 3 个文件（文本 3、二进制 0、不存在 0），检索词 7 个。",
        "leak-check: 排除短于 2 个字符的词 2 个，按豁免清单排除 1 个。",
      ),
      stderr: "",
      exitCode: 1,
    });
  });

  it("5.10 没有 books.json：stdout 恰为一行说明，stderr 为空，exit 0；root 不是 git 仓库也是如此", () => {
    const root = makeTempDir();

    expect(runLeakCheck({ root })).toEqual({
      stdout: "leak-check: 未找到 public/data/books.json，检查未执行。\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it.each(BAD_INPUTS)("5.11 %s：exit 2，stdout 为空，stderr 一行写明出错文件与原因", (_label, files, problem) => {
    const root = makeTempDir();
    writeFiles(root, files);

    expect(runLeakCheck({ root })).toEqual({ stdout: "", stderr: `leak-check: 错误：${problem}\n`, exitCode: 2 });
  });

  it("5.12 运行前后，临时目录（含 .git）中每个文件的路径、大小、mtimeMs 与 SHA-256 都不变", () => {
    const root = makeScanRepo({ [EXEMPT_FILE]: "豁免词己庚\n" });

    const before = snapshotTree(root);
    const result = runLeakCheck({ root });
    const after = snapshotTree(root);

    // 前提：确实完成了一次扫描；快照覆盖本机书目、豁免清单、各类被扫描的文件与 .git
    expect(result.exitCode).toBe(1);
    expect(before.map(({ path }) => path)).toEqual(
      expect.arrayContaining([BOOKS_JSON, EXEMPT_FILE, "tracked.txt", "untracked.txt", ".git/HEAD", ".git/index"]),
    );
    expect(after).toEqual(before);
  });

  it("5.13 root 不是 git 仓库：exit 2，stdout 为空，stderr 一行写明 git 的退出码与 stderr 首行", () => {
    const root = makeTempDir();
    writeFiles(root, { [BOOKS_JSON]: JSON.stringify(CATALOG) });

    const result = runLeakCheck({ root });

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    // git 的消息随语言设置而变，这里只核对格式：前缀、退出码 128，以及非空的一行原因
    expect(result.stderr).toMatch(/^leak-check: 错误：无法取得提交文件列表：git 退出码 128：\S[^\n]*\n$/u);
  });

  it("5.13 git 选项指向不存在的可执行文件：exit 2，stdout 为空，stderr 写明 ENOENT", () => {
    const root = makeRepo();
    const missingGit = `no-such-git-${randomBytes(4).toString("hex")}`;

    expect(runLeakCheck({ root, git: missingGit })).toEqual({
      stdout: "",
      stderr: `leak-check: 错误：无法取得提交文件列表：运行 ${missingGit} 失败（ENOENT）\n`,
      exitCode: 2,
    });
  });

  it("5.1 同一临时仓库连续运行两次：stdout、stderr 与退出码逐字节相同", () => {
    const root = makeScanRepo({ [EXEMPT_FILE]: "豁免词己庚\n" });

    const first = runLeakCheck({ root });
    const second = runLeakCheck({ root });

    // 有命中：比较的是一次完整扫描的输出，不是提前退出的一行
    expect(first.exitCode).toBe(1);
    expect(second.stdout).toBe(first.stdout);
    expect(second.stderr).toBe(first.stderr);
    expect(second.exitCode).toBe(first.exitCode);
  });

  // 3.2 的本机覆盖表与 Exemption_File 写在 .gitignore 的同一处，顺带核对
  it.each([
    ["5.6", EXEMPT_FILE],
    ["3.2", "scripts/toc-overrides.local.json"],
  ])("%s 仓库根的 .gitignore 忽略本机文件 %s：git check-ignore -q 以 0 退出，文件不必存在", (_requirement, file) => {
    const result = spawnSync("git", ["check-ignore", "-q", file], {
      cwd: REPO_ROOT,
      stdio: "ignore",
      windowsHide: true,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
  });
});
