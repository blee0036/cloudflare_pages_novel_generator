/**
 * 书籍正文的有效性检查（e2e-visual-testing 需求 19，修复 F-001）。
 *
 * F-001：书的 `.txt.gz` 缺失时，站点的 SPA 回退以状态 200 返回 `index.html`，旧的
 * `decompress.ts` 解压失败后走 `fetch().text()` 兜底，把这页 HTML 当成正文渲染。修复分两层：
 *
 * 1. **字节层**：Opaque 响应收齐后先看 gzip 魔数（`hasGzipMagic`），不是 gzip 就不解压；
 *    解压抛错也不再兜底（19.1）。
 * 2. **内容层**：全文的 Unicode 码点数必须等于 `_toc.json` 里的 `charCount`（19.3）。这一层
 *    接住字节层看不见的情形——Transparent_Mode 下 HTTP 层解码出来的 HTML、IndexedDB 里修复前
 *    写入的坏记录、服务器产物更新后遗留的旧记录。
 *
 * 本模块只放判定用的纯函数与错误类型，不碰网络、IndexedDB 与内存缓存；加载流程怎么用它们
 * 由 `decompress.ts` 决定。纯函数与宿主无关，可直接在 Node 下单测。
 */

/**
 * 统计字符串的 Unicode 码点数，与预处理管线写入 `charCount` 时用的 Python `len()` 同一口径。
 *
 * 不能用 `String.length`：那是 UTF-16 码元数，含增补平面字符（emoji、CJK 扩展 B 等）的书
 * 两者不相等，拿它比对会把正常的书误判为不符（19.3）。
 *
 * 规则：高代理项后紧跟低代理项计 1，其余每个码元（含孤立的高、低代理项）各计 1。这与
 * `Array.from(s).length` 一致——字符串迭代器对孤立代理项同样按单个码元产出。
 *
 * 用逐码元扫描而不是 `Array.from`：最大的书约 4 千万码元，`Array.from` 要先分配同样长度的
 * 字符串数组，峰值内存翻几倍，而这里只需要一个计数。
 */
export function countCodePoints(s: string): number {
  const n = s.length;
  let count = 0;

  for (let i = 0; i < n; i++) {
    const unit = s.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < n) {
      const next = s.charCodeAt(i + 1);
      // 合法代理对：跳过低代理项，这一对只计一次。
      if (next >= 0xdc00 && next <= 0xdfff) i++;
    }
    count++;
  }

  return count;
}

/**
 * 把 `_toc.json` 里的 `charCount` 规范成"可用于比对的码点数"，不可用时返回 `null`（19.10）。
 *
 * 只接受非负的安全整数。缺失、`null`、字符串（哪怕是 `"12"`）、负数、小数、`NaN`、超出
 * 安全整数范围的数一律视为不可用：调用方据此**跳过**码点检查，而不是拿脏值去比对然后把
 * 一本正常的书判成损坏。代价是这类书失去内容层的保护，已在需求 19.10 中接受。
 */
export function normalizeCharCount(v: unknown): number | null {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

/**
 * 字节是否以 gzip 魔数 `1f 8b` 开头（RFC 1952）。
 *
 * 只是必要条件：通过了也可能在尾部之前被截断，那由解压抛错来发现（`corrupt-gzip`）。
 * 它的用处是在解压之前就把 SPA 回退的 HTML（以 `<` 开头）认出来，给出比"解压失败"更能
 * 说明问题的错误信息。
 */
export function hasGzipMagic(b: Uint8Array): boolean {
  return b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;
}

/** 正文无效的原因。 */
export type BookTextInvalidReason =
  /** 响应体不是 gzip 数据（缺魔数），典型是文件缺失时站点返回的 `index.html`。 */
  | "not-gzip"
  /** 有 gzip 魔数但无法完整解压，例如在尾部之前截断。 */
  | "corrupt-gzip"
  /** 解出的全文码点数与 `_toc.json` 的 `charCount` 不符。 */
  | "char-count-mismatch";

/**
 * 各原因的错误标题。错误经 `ReaderPage` 的 `catch → setError(message)` 显示在错误页的说明行，
 * 所以写给读者看，而不是写给开发者看。
 */
const REASON_SUMMARY: Record<BookTextInvalidReason, string> = {
  "not-gzip": "书籍正文文件无效",
  "corrupt-gzip": "书籍正文文件损坏",
  "char-count-mismatch": "书籍正文与目录不符",
};

/**
 * 正文未通过有效性检查时抛出的错误（19.1、19.3）。
 *
 * `message` 由原因对应的标题与 `detail` 拼成，例如
 * `书籍正文与目录不符（码点数 12，目录记录 13）`；`detail` 为空串时只有标题。
 * `reason` 供调用方与单测区分三种情形，不必解析文案。
 */
export class BookTextInvalidError extends Error {
  constructor(
    readonly reason: BookTextInvalidReason,
    readonly detail: string
  ) {
    super(detail ? `${REASON_SUMMARY[reason]}（${detail}）` : REASON_SUMMARY[reason]);
    this.name = "BookTextInvalidError";
  }
}
