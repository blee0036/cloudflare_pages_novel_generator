/**
 * Leak_Check：在进库文件的路径与内容里查找本机书目中的书名、作者与书 id
 * （test-data-desensitization 需求 5；设计"1. Leak_Check"）。
 *
 * 本文件同时是可导入模块与 `npm run leak-check` 的入口。纯函数层：
 *
 *   splitExemptText  豁免清单的文本 → 豁免行
 *   buildTerms       书目 + 豁免行 → 检索词表（去重、类别取并集、两类排除并计数）
 *   buildIndex       检索词表 → 按前 2 个 UTF-16 码元分桶的索引
 *   scanFile         一个文件的路径与已解码内容 → 命中记录
 *   analyze          整次分析：解码判定与计数、逐文件扫描、全局排序与去重
 *   formatReport     报告 → { stdout, stderr, exitCode }
 *
 * I/O 外壳：
 *
 *   runLeakCheck     读书目、豁免清单、git 给出的文件列表与各文件字节，交给 analyze 与
 *                    formatReport；错误分支（退出码 2）自己渲染
 *   main             只在本文件作为入口运行时执行：写出结果并设置 process.exitCode
 *
 * 纯函数不访问文件系统、不调用 git、不读环境变量与时钟，同一输入总得到逐字节相同的输出
 * （需求 5.1）。外壳只读：不写任何文件，不访问网络（需求 5.12）。本文件的源码与注释不写
 * 任何真实书名、作者或书 id（需求 5.3）。
 */
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";

/** @typedef {"title" | "author" | "id"} Category */

/**
 * @typedef {object} CatalogBook  books.json 中 books[i] 的三个字段，其余字段忽略
 * @property {string} title
 * @property {string} author
 * @property {string} id
 */

/**
 * @typedef {object} TermTable
 * @property {Map<string, Set<Category>>} terms  去重与两类排除之后的检索词 → 所属类别
 * @property {number} shortExcluded  码点数小于 2 的不同字符串个数（含空串）
 * @property {number} exemptExcluded  与某一豁免行完全相等、码点数不小于 2 的不同字符串个数
 */

/**
 * @typedef {object} TermIndex
 * @property {Map<string, string[]>} buckets  键为检索词的前 2 个 UTF-16 码元，值为以它开头的检索词（升序）
 * @property {Map<string, Category[]>} categories  检索词 → 类别（固定顺序）
 */

/**
 * @typedef {object} Hit
 * @property {string} path  git 给出的相对路径，以 / 分隔
 * @property {number | null} line  从 1 起；null 表示命中在路径里
 * @property {string} term  命中的检索词
 * @property {Category[]} categories  固定顺序
 */

/**
 * @typedef {object} FileInput
 * @property {string} path  git 给出的相对路径
 * @property {Uint8Array | null} bytes  文件的全部字节（Buffer 亦可）；null 表示已列出但工作区中不存在
 */

/**
 * @typedef {object} LeakReport
 * @property {Hit[]} hits  已去重、已排序
 * @property {{ total: number, text: number, binary: number, missing: number }} files  total = text + binary + missing
 * @property {number} terms  检索词数，等于 TermTable.terms.size
 * @property {number} shortExcluded
 * @property {number} exemptExcluded
 */

/** 类别的固定顺序（需求 5.8）。三者也正是书目项中参与检索的字段名。 */
const CATEGORY_ORDER = ["title", "author", "id"];

/** 类别在输出中的写法。 */
const CATEGORY_LABELS = { title: "书名", author: "作者", id: "书 id" };

/** 按 UTF-16 码元序比较两个字符串。不用 localeCompare，结果与区域设置无关。 */
function compareStrings(a, b) {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** 行号比较：路径命中（null）排在该文件所有行之前，其余按数值升序。 */
function compareLines(a, b) {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a - b;
}

/** 命中记录的全序：路径升序，再按行号，最后按命中词（需求 5.8）。 */
function compareHits(a, b) {
  return compareStrings(a.path, b.path) || compareLines(a.line, b.line) || compareStrings(a.term, b.term);
}

/** 按 Unicode 码点计的长度（需求 5.4）：增补平面字符算 1 个。 */
function codePointLength(s) {
  return [...s].length;
}

/** 按固定顺序列出 present 中出现的类别。 */
function orderedCategories(present) {
  return CATEGORY_ORDER.filter((category) => present.has(category));
}

/**
 * 把豁免清单的文本切成豁免行（设计"Exemption_File"）：按 "\n" 分行，去掉行尾的一个 "\r"，
 * 忽略空行；其余字符原样保留，不去首尾空白。
 *
 * 传入已解码的文本。开头的 BOM 由 I/O 外壳解码时去掉（TextDecoder 默认 ignoreBOM: false），
 * 这里不再处理。
 *
 * @param {string} text
 * @returns {string[]}  依原顺序，可能有重复
 */
export function splitExemptText(text) {
  const lines = [];
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line !== "") lines.push(line);
  }
  return lines;
}

/**
 * 由书目与豁免行得到检索词表（设计"处理步骤 3"；需求 5.2、5.4、5.5）。
 *
 * - 每本书取 title、author、id 三个字段；同一字符串只记一次，类别取并集。
 * - 码点数小于 2 的串（含空串）排除，计入 shortExcluded。
 * - 其余串中，与某一豁免行完全相等的排除，计入 exemptExcluded。只做整行相等比较，不比较子串；
 *   对不上任何字段取值的豁免行不计数，码点数小于 2 的串也不重复计入。
 *
 * 两个计数都按去重后的字符串计。
 *
 * @param {CatalogBook[]} books
 * @param {Iterable<string>} [exemptLines]  已切分的豁免行，即 splitExemptText 的结果：每项是去掉
 *   行尾换行后的一整行，按原样与字段取值比较。不传时视为没有豁免行。
 * @returns {TermTable}  terms 按 UTF-16 码元序插入；每个类别集合按固定顺序插入
 */
export function buildTerms(books, exemptLines = []) {
  /** @type {Map<string, Set<Category>>} */
  const values = new Map();
  books.forEach((book, i) => {
    for (const category of CATEGORY_ORDER) {
      const value = book[category];
      if (typeof value !== "string") {
        throw new TypeError(`buildTerms：books[${i}].${category} 不是字符串`);
      }
      const seen = values.get(value);
      if (seen === undefined) values.set(value, new Set([category]));
      else seen.add(category);
    }
  });

  const exempt = new Set(exemptLines);
  /** @type {Map<string, Set<Category>>} */
  const terms = new Map();
  let shortExcluded = 0;
  let exemptExcluded = 0;
  for (const value of [...values.keys()].sort(compareStrings)) {
    if (codePointLength(value) < 2) shortExcluded += 1;
    else if (exempt.has(value)) exemptExcluded += 1;
    else terms.set(value, new Set(orderedCategories(values.get(value))));
  }
  return { terms, shortExcluded, exemptExcluded };
}

/**
 * 把检索词表编成按前 2 个 UTF-16 码元分桶的索引（设计"匹配算法"）。
 *
 * 分桶要求每个词至少 2 个码元。码点数不小于 2 的词必然满足；不满足时抛 RangeError，
 * 以免这个词在扫描中被悄悄漏掉。
 *
 * @param {Map<string, Iterable<Category>>} terms  通常是 buildTerms(...).terms
 * @returns {TermIndex}
 */
export function buildIndex(terms) {
  /** @type {Map<string, string[]>} */
  const buckets = new Map();
  /** @type {Map<string, Category[]>} */
  const categories = new Map();
  for (const [term, termCategories] of terms) {
    if (codePointLength(term) < 2) {
      throw new RangeError("buildIndex：检索词至少要有 2 个码点");
    }
    const key = term.slice(0, 2);
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [term]);
    else bucket.push(term);
    categories.set(term, orderedCategories(new Set(termCategories)));
  }
  for (const bucket of buckets.values()) bucket.sort(compareStrings);
  return { buckets, categories };
}

/** text 中每个 "\n" 的下标，升序。 */
function newlineOffsets(text) {
  const offsets = [];
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) offsets.push(at);
  return offsets;
}

/** offset 所在的行号：1 + offset 之前 "\n" 的个数，在升序的换行下标数组里二分求得。 */
function lineAt(newlines, offset) {
  let lo = 0;
  let hi = newlines.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (newlines[mid] < offset) lo = mid + 1;
    else hi = mid;
  }
  return lo + 1;
}

/** 在 text 中逐个报告检索词的出现（重叠的也算）：onMatch(起始下标, 检索词)。 */
function forEachMatch(text, buckets, onMatch) {
  for (let i = 0; i + 2 <= text.length; i++) {
    const bucket = buckets.get(text.slice(i, i + 2));
    if (bucket === undefined) continue;
    for (const term of bucket) {
      if (text.startsWith(term, i)) onMatch(i, term);
    }
  }
}

/**
 * 在一个文件里找命中（设计"处理步骤 5"与"匹配算法"；需求 5.7、5.8）。
 *
 * 路径与内容各跑一遍同一扫描：对每个下标 i 取 s.slice(i, i + 2) 查桶，桶里的词 t 满足
 * s.startsWith(t, i) 即为命中。匹配按 UTF-16 码元进行，与 String.prototype.includes 一致：
 * 区分大小写，不做全半角、繁简或空白归并。
 *
 * 内容命中的行号取起始位置所在的行，即 1 + 该位置之前 "\n" 的个数。只认 "\n"，CRLF 中的
 * "\r" 留在行尾；跨行的命中记在起始行。路径命中的 line 为 null。
 *
 * @param {string} path
 * @param {string | null} content  已解码的内容；null 表示二进制或不存在，只比对路径
 * @param {TermIndex} index  buildIndex 的结果
 * @returns {Hit[]}  同一（line, term）只出现一次；路径命中在前，其后按行号、命中词升序
 */
export function scanFile(path, content, index) {
  /** @type {Hit[]} */
  const hits = [];
  const seen = new Set();
  const record = (line, term) => {
    const key = `${line === null ? "" : line}\n${term}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({ path, line, term, categories: [...index.categories.get(term)] });
  };

  forEachMatch(path, index.buckets, (_at, term) => record(null, term));
  if (content !== null) {
    const newlines = newlineOffsets(content);
    forEachMatch(content, index.buckets, (at, term) => record(lineAt(newlines, at), term));
  }
  return hits.sort(compareHits);
}

/**
 * 被扫描文件内容的解码（需求 5.7）：严格按 UTF-8，不能解码时返回 null，即视为二进制。
 *
 * 保留开头的 BOM（ignoreBOM: true），解码结果与文件字节逐码点对应，匹配按原样进行。
 * 只有"数据不是合法的 UTF-8"才算二进制；参数类型不对等其他错误照常抛出，不当作二进制吞掉。
 *
 * @param {Uint8Array} bytes
 * @returns {string | null}
 */
function decodeContent(bytes) {
  // TextDecoder 把 undefined 解成空串，不会报错，所以单独拦下。
  if (bytes === undefined) {
    throw new TypeError("analyze：files[].bytes 应为字节数组，或以 null 表示文件不存在");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    if (error?.code === "ERR_ENCODING_INVALID_ENCODED_DATA") return null;
    throw error;
  }
}

/**
 * 整次分析（设计"处理步骤 3、5、6"；需求 5.2–5.5、5.7–5.9）。
 *
 * 每个文件按 bytes 归入一类：
 * - null：已列出但工作区中不存在，只比对路径，计入 missing；
 * - 不能按 UTF-8 严格解码（TextDecoder 的 fatal: true）：视为二进制，只比对路径，计入 binary；
 * - 其余：计入 text，路径与内容都比对。
 *
 * BOM：解码时保留文件开头的 BOM（ignoreBOM: true），不像豁免清单那样去掉。这样内容与文件
 * 字节逐码点对应，"按原样匹配"（需求 5.7）不丢任何字符。BOM 不是换行符，保留与否不影响
 * 行号，只影响以 U+FEFF 开头的检索词能否在文件开头命中。逐条比对的朴素参照（属性 1）应以
 * 同样方式解码：new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })。
 *
 * 命中先逐文件收集，再按（路径，行号，命中词）全局排序并去重：路径按 UTF-16 码元升序，
 * 同一路径的路径命中排在各行之前，其后行号升序，最后命中词按 UTF-16 码元升序。结果因此
 * 与 books、exemptLines、files 的排列顺序无关；files 中有同一路径的多项时，各项的命中合并去重。
 *
 * @param {{ books: CatalogBook[], exemptLines?: Iterable<string>, files: FileInput[] }} input
 *   exemptLines 的约定同 buildTerms：已切分的豁免行（splitExemptText 的结果）。
 * @returns {LeakReport}
 */
export function analyze({ books, exemptLines = [], files }) {
  const table = buildTerms(books, exemptLines);
  const index = buildIndex(table.terms);
  const counts = { total: 0, text: 0, binary: 0, missing: 0 };
  /** @type {Hit[]} */
  const collected = [];
  for (const { path, bytes } of files) {
    counts.total += 1;
    let content = null;
    if (bytes === null) {
      counts.missing += 1;
    } else {
      content = decodeContent(bytes);
      if (content === null) counts.binary += 1;
      else counts.text += 1;
    }
    for (const hit of scanFile(path, content, index)) collected.push(hit);
  }

  collected.sort(compareHits);
  const hits = collected.filter((hit, i) => i === 0 || compareHits(collected[i - 1], hit) !== 0);
  return {
    hits,
    files: counts,
    terms: table.terms.size,
    shortExcluded: table.shortExcluded,
    exemptExcluded: table.exemptExcluded,
  };
}

/** 一条命中记录的输出行（不含换行符）。 */
function formatHit({ path, line, term, categories }) {
  const where = line === null ? "(路径)" : String(line);
  const labels = CATEGORY_ORDER.filter((category) => categories.includes(category)).map(
    (category) => CATEGORY_LABELS[category],
  );
  return `${path}:${where}: [${labels.join("、")}] ${term}`;
}

/**
 * 渲染报告（设计"输出与退出码"；需求 5.8、5.9）。stdout 的每一行都以 "\n" 结尾：
 *
 *   <路径>:<行号>: [<类别>] <命中词>
 *   <路径>:(路径): [<类别>] <命中词>
 *   leak-check: 命中 <H> 处。
 *   leak-check: 扫描 <N> 个文件（文本 <T>、二进制 <B>、不存在 <M>），检索词 <S> 个。
 *   leak-check: 排除短于 2 个字符的词 <K> 个，按豁免清单排除 <E> 个。
 *
 * 记录按 report.hits 的顺序逐条输出，其后是 3 行汇总；无命中时汇总的第一行写作
 * "leak-check: 未发现命中。"。类别按"书名、作者、书 id"的固定顺序，以"、"连接。
 * 输出只由报告决定，不含时间、耗时或绝对路径（需求 5.1）。
 *
 * @param {LeakReport} report
 * @returns {{ stdout: string, stderr: string, exitCode: 0 | 1 }}  有命中时 exitCode 为 1，否则为 0；
 *   stderr 恒为空串
 */
export function formatReport(report) {
  const { hits, files, terms, shortExcluded, exemptExcluded } = report;
  const lines = hits.map(formatHit);
  lines.push(
    hits.length > 0 ? `leak-check: 命中 ${hits.length} 处。` : "leak-check: 未发现命中。",
    `leak-check: 扫描 ${files.total} 个文件（文本 ${files.text}、二进制 ${files.binary}、不存在 ${files.missing}），检索词 ${terms} 个。`,
    `leak-check: 排除短于 2 个字符的词 ${shortExcluded} 个，按豁免清单排除 ${exemptExcluded} 个。`,
  );
  return {
    stdout: lines.map((line) => `${line}\n`).join(""),
    stderr: "",
    exitCode: hits.length > 0 ? 1 : 0,
  };
}

// ---------------------------------------------------------------------------
// I/O 外壳（设计"处理步骤与判定顺序"与"输出与退出码"；Error Handling 的 Leak_Check 表）
// ---------------------------------------------------------------------------

/**
 * @typedef {object} LeakCheckOptions
 * @property {string} [root]  在其中执行 git 的目录，默认 process.cwd()：npm 总在包根执行脚本
 * @property {string} [booksJsonPath]  本机书目，默认 <root>/public/data/books.json
 * @property {string} [exemptPath]  Exemption_File，默认 <root>/scripts/leak-check-exempt.local.txt
 * @property {string} [git]  git 可执行文件，默认 "git"，由 PATH 解析
 */

/**
 * @typedef {object} LeakCheckResult
 * @property {string} stdout
 * @property {string} stderr
 * @property {0 | 1 | 2} exitCode  0：无命中，或缺 books.json、检查未执行；1：有命中；2：出错，未扫描
 */

/** 取 Committable_File 列表（需求 5.7）：已跟踪的文件，加上未被忽略的未跟踪文件，以 NUL 分隔。 */
const LS_FILES_ARGS = ["ls-files", "--cached", "--others", "--exclude-standard", "-z"];

/** git 输出的上限。execFileSync 默认只收 1 MiB，大仓库的文件列表会被截断成错误。 */
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

/** 缺 books.json 时唯一的一行输出（需求 5.10）。按设计固定写仓库内的默认位置。 */
const CATALOG_MISSING_NOTICE = "leak-check: 未找到 public/data/books.json，检查未执行。\n";

/**
 * 读本机输入文件时，表示"这个路径上没有文件"的错误码。路径中间一段是普通文件时，
 * POSIX 报 ENOTDIR，Windows 报 ENOENT，两者同义。
 */
const ABSENT_CODES = new Set(["ENOENT", "ENOTDIR"]);

/**
 * 读列出的文件时，表示"工作区中没有这个普通文件"的错误码：除 ABSENT_CODES 外，还有路径上是
 * 目录的 EISDIR，例如子模块，或 git 以 "/" 结尾列出的未跟踪嵌套仓库。这些都只比对路径，
 * 计入"不存在"（需求 5.7）。
 */
const NOT_A_FILE_CODES = new Set([...ABSENT_CODES, "EISDIR"]);

/**
 * 退出码 2 的结果：stderr 一行 "leak-check: 错误：<原因>"，stdout 为空。
 * @param {string} reason
 * @returns {LeakCheckResult}
 */
function failure(reason) {
  return { stdout: "", stderr: `leak-check: 错误：${reason}\n`, exitCode: 2 };
}

/** 错误的简短代号，例如 EACCES。不用 error.message：Node 的消息里带绝对路径（需求 5.1）。 */
function errorCode(error) {
  if (typeof error?.code === "string" && error.code !== "") return error.code;
  if (typeof error?.name === "string" && error.name !== "") return error.name;
  return "未知错误";
}

/**
 * 严格按 UTF-8 解码（fatal: true），不能解码时返回 null；其余错误照常抛出。
 * keepBOM 为 false 时去掉开头的 BOM，即 TextDecoder 的默认行为。
 *
 * @param {Uint8Array} bytes
 * @param {boolean} keepBOM
 * @returns {string | null}
 */
function decodeUtf8(bytes, keepBOM) {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: keepBOM }).decode(bytes);
  } catch (error) {
    if (error?.code === "ERR_ENCODING_INVALID_ENCODED_DATA") return null;
    throw error;
  }
}

/**
 * 报错时显示的输入文件路径。在 root 里时写相对 root 的路径，以 "/" 分隔，如
 * public/data/books.json；在 root 外时只写 basename，例如以另一处目录为 root、核对本机
 * 书目时。两种写法都不含绝对路径，也不随运行目录变化（需求 5.1）。
 *
 * @param {string} root
 * @param {string} file
 * @returns {string}
 */
function displayPath(root, file) {
  const rel = relative(root, file);
  // Windows 上跨盘符时 relative 返回绝对路径
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return basename(file);
  return rel.split(sep).join("/");
}

/**
 * 读本机输入文件（books.json 或 Exemption_File）的全部字节。
 * @param {string} file
 * @returns {{ bytes: Uint8Array } | { absent: true } | { problem: string }}
 */
function readInputFile(file) {
  try {
    return { bytes: readFileSync(file) };
  } catch (error) {
    if (ABSENT_CODES.has(error?.code)) return { absent: true };
    return { problem: `无法读取（${errorCode(error)}）` };
  }
}

/** 普通对象：不是 null，也不是数组。 */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 把 books.json 的字节解析为书目（需求 5.2、5.11）。依次检查：能按 UTF-8 解码（开头的 BOM
 * 去掉）、是合法的 JSON、顶层是对象、有 books 数组、每项是对象且 title、author、id 都是字符串。
 * 返回第一处问题。原因里不引用文件内容：JSON.parse 的错误消息会带出原文片段，可能就是真实书名。
 *
 * @param {Uint8Array} bytes
 * @returns {{ books: CatalogBook[] } | { problem: string }}
 */
function parseCatalog(bytes) {
  const text = decodeUtf8(bytes, false);
  if (text === null) return { problem: "不是合法的 UTF-8" };
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { problem: "不是合法的 JSON" };
  }
  if (!isPlainObject(data)) return { problem: "顶层不是对象" };
  const { books } = data;
  if (!Array.isArray(books)) return { problem: "顶层没有 books 数组" };
  for (let i = 0; i < books.length; i++) {
    const book = books[i];
    if (!isPlainObject(book)) return { problem: `books[${i}] 不是对象` };
    for (const field of CATEGORY_ORDER) {
      if (typeof book[field] !== "string") return { problem: `books[${i}].${field} 不是字符串` };
    }
  }
  return { books };
}

/**
 * 读 Exemption_File 并切成豁免行（需求 5.5、5.11）。不存在时视为没有豁免行；存在但无法读取
 * （权限等）或不能按 UTF-8 解码时返回原因。开头的 BOM 在解码时去掉，切分规则见 splitExemptText。
 *
 * @param {string} exemptPath
 * @returns {{ lines: string[] } | { problem: string }}
 */
function readExemptLines(exemptPath) {
  const read = readInputFile(exemptPath);
  if ("absent" in read) return { lines: [] };
  if ("problem" in read) return read;
  const text = decodeUtf8(read.bytes, false);
  if (text === null) return { problem: "不是合法的 UTF-8" };
  return { lines: splitExemptText(text) };
}

/** 输出中的首个非空行，去掉首尾空白；没有时为空串。 */
function firstLine(output) {
  if (output === undefined || output === null) return "";
  const text = typeof output === "string" ? output : new TextDecoder("utf-8").decode(output);
  return text.split("\n").map((line) => line.trim()).find((line) => line !== "") ?? "";
}

/**
 * git 失败的原因（需求 5.13）：
 * - 进程没能启动时（git 不在 PATH 上等），写系统错误码，例如 "运行 git 失败（ENOENT）"；
 * - git 以非 0 退出时，写退出码与 stderr 的首行，例如 root 不在工作区中时的
 *   "git 退出码 128：fatal: not a git repository (or any of the parent directories): .git"。
 *
 * @param {string} git
 * @param {any} error  execFileSync 抛出的错误
 * @returns {string}
 */
function gitFailureReason(git, error) {
  if (typeof error?.code === "string") return `运行 ${basename(git)} 失败（${error.code}）`;
  const exit = typeof error?.status === "number" ? `退出码 ${error.status}` : `被信号 ${error?.signal} 终止`;
  const detail = firstLine(error?.stderr);
  return detail === "" ? `git ${exit}` : `git ${exit}：${detail}`;
}

/**
 * 取 Committable_File 列表（需求 5.7、5.13）：在 root 下执行
 * git ls-files --cached --others --exclude-standard -z，按 UTF-8 严格解码（保留 BOM，路径与
 * git 的输出逐码点对应），以 NUL 切分并去掉空串。
 *
 * 合并冲突期间，同一路径会按暂存阶段重复列出；这里只留第一次出现，免得同一文件计数两次。
 *
 * @param {string} root
 * @param {string} git
 * @returns {{ paths: string[] } | { reason: string }}
 */
function listCommittableFiles(root, git) {
  let stdout;
  try {
    stdout = execFileSync(git, LS_FILES_ARGS, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: GIT_MAX_BUFFER,
      windowsHide: true,
    });
  } catch (error) {
    return { reason: gitFailureReason(git, error) };
  }
  const text = decodeUtf8(stdout, true);
  if (text === null) return { reason: "git 列出的路径不是合法的 UTF-8" };
  return { paths: [...new Set(text.split("\0").filter((p) => p !== ""))] };
}

/**
 * Leak_Check 的 I/O 外壳（需求 5.1、5.2、5.7、5.10–5.13）。判定顺序：
 *
 * 1. 读 booksJsonPath。不存在时输出一行说明，退出码 0，不读豁免清单，也不调用 git。
 *    没有书目的机器（如 Isolated_Checkout）即使不在 git 工作区中，也只得到"检查未执行"（需求 5.10）。
 * 2. 解析书目：UTF-8（fatal: true）、JSON、结构。任一项不成立时以退出码 2 报出第一处问题（需求 5.11）。
 * 3. 读豁免清单：不存在时视为空；无法读取或不能按 UTF-8 解码时退出码 2（需求 5.5、5.11）。
 * 4. 在 root 下执行 git ls-files 取文件列表，失败时退出码 2（需求 5.13）。
 * 5. 逐文件读取字节。工作区中没有该普通文件时只比对路径；其余读取错误以退出码 2 报出，
 *    不跳过：静默跳过会让检查漏掉文件。
 * 6. 交给 analyze 与 formatReport：有命中时退出码 1，否则 0（需求 5.8、5.9）。
 *
 * 错误分支的 stderr 只有一行，不含绝对路径、时间或耗时，同一输入重复运行逐字节相同（需求 5.1）：
 *
 *   leak-check: 错误：<相对路径>：<原因>            books.json、豁免清单或列出的文件
 *   leak-check: 错误：无法取得提交文件列表：<原因>   git 失败
 *
 * 只读：不写任何文件，不调用 process.exit，结果由调用方输出（需求 5.12）。
 *
 * @param {LeakCheckOptions} [options]
 * @returns {LeakCheckResult}
 */
export function runLeakCheck({
  root = process.cwd(),
  booksJsonPath = join(root, "public/data/books.json"),
  exemptPath = join(root, "scripts/leak-check-exempt.local.txt"),
  git = "git",
} = {}) {
  const catalogFile = readInputFile(booksJsonPath);
  if ("absent" in catalogFile) return { stdout: CATALOG_MISSING_NOTICE, stderr: "", exitCode: 0 };
  const catalog = "problem" in catalogFile ? catalogFile : parseCatalog(catalogFile.bytes);
  if ("problem" in catalog) return failure(`${displayPath(root, booksJsonPath)}：${catalog.problem}`);

  const exempt = readExemptLines(exemptPath);
  if ("problem" in exempt) return failure(`${displayPath(root, exemptPath)}：${exempt.problem}`);

  const listing = listCommittableFiles(root, git);
  if ("reason" in listing) return failure(`无法取得提交文件列表：${listing.reason}`);

  /** @type {FileInput[]} */
  const files = [];
  for (const rel of listing.paths) {
    let bytes = null;
    try {
      bytes = readFileSync(join(root, rel));
    } catch (error) {
      if (!NOT_A_FILE_CODES.has(error?.code)) return failure(`${rel}：读取失败（${errorCode(error)}）`);
    }
    files.push({ path: rel, bytes });
  }

  return formatReport(analyze({ books: catalog.books, exemptLines: exempt.lines, files }));
}

/**
 * 本文件是否作为入口运行（`node scripts/leak-check.mjs`、`npm run leak-check`）。
 *
 * 先按设计比较 import.meta.url 与 pathToFileURL(process.argv[1]).href。本机实测（Node 24、
 * Windows）：盘符写成大写或小写，从 PowerShell、cmd 或 npm 启动，两边的大小写都一致，字面比较成立。
 *
 * 字面不等时再比较两边的真实路径。Node 生成入口模块的 import.meta.url 之前会解析目录联接
 * （junction）与符号链接，process.argv[1] 却只做 path.resolve，所以经联接启动时两者字面不同。
 * 若此时不执行 main()，脚本什么也不输出并以 0 退出，看上去就像"未发现命中"。
 * realpathSync.native 在 Windows 上还会统一盘符与各级目录名的大小写。
 *
 * 被导入时（Vitest、node --input-type=module -e），argv[1] 是别的文件或不存在，两种比较都不成立。
 *
 * @returns {boolean}
 */
function isEntryPoint() {
  const entry = process.argv[1];
  if (typeof entry !== "string" || entry === "") return false;
  try {
    if (pathToFileURL(entry).href === import.meta.url) return true;
    return realpathSync.native(entry) === realpathSync.native(fileURLToPath(import.meta.url));
  } catch {
    // argv[1] 不是现存的文件，或 import.meta.url 不是 file: URL：都不是从本文件启动
    return false;
  }
}

/**
 * CLI 入口：把 runLeakCheck() 的结果写到 stdout 与 stderr，再设置 process.exitCode。
 * 不调用 process.exit，Node 在输出写完后自行退出；不写任何文件（需求 5.12）。
 *
 * 意外异常改报退出码 2：未捕获的异常会让 Node 以 1 退出，与"有命中"混淆。
 */
function main() {
  let result;
  try {
    result = runLeakCheck();
  } catch (error) {
    process.stderr.write(`leak-check: 内部错误：${error?.stack ?? String(error)}\n`);
    process.exitCode = 2;
    return;
  }
  if (result.stdout !== "") process.stdout.write(result.stdout);
  if (result.stderr !== "") process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}

if (isEntryPoint()) main();
