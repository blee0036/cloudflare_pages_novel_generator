/**
 * 阅读器 URL 上的章号参数 `?ch=`（需求 7，F-005；design §6）。
 *
 * 两个方向各一个纯函数：
 *
 * - `parseUrlChapter`：读。判定口径与改造前 `ReaderPage` 定位 effect 的写法逐字相同
 *   （`Number.parseInt(raw, 10)` 后为 `[0, chapterCount)` 内的整数才算有效），所以 `"3abc"`
 *   仍读作 3、`"-1"` 与越界仍视为无效——EV 9.12 等既有用例依赖这一口径。
 * - `withChapterParam`：写回。阅读器每次定位后都把当前章写回 URL（D2，`replace`），
 *   这里只负责算出新的查询串，导航由调用方经 `setSearchParams` 发起。
 *
 * 与 `bookshelfUrl.ts` 同理，一律返回字符串而不就地改 `URLSearchParams`：
 * `useSearchParams()` 交出的实例按 `location.search` memo 住，就地 `set` 会改掉 Hook 缓存的值
 * 却不触发导航。
 */

/** 章号的参数名。 */
export const CHAPTER_PARAM = "ch";

/**
 * URL 章号：`parseInt` 后为 `[0, chapterCount)` 内的整数时返回它，否则 `null`（沿用现有判定）。
 *
 * `raw` 为 `null`（参数缺省）、空串、非数字开头、负数、越界都返回 `null`。`parseInt` 只读前缀，
 * 故 `"3abc"`、`" 3"`、`"3.9"` 都读作 3——这是改造前就有的行为，保持不变。
 *
 * `"-0"` 经 `parseInt` 得 `-0`，按原判定是有效的 0 号章；这里把它规整成 `+0` 再交出，
 * 免得 `-0` 流进 `Object.is` 比较或状态比较里制造"同一章却不相等"。
 */
export function parseUrlChapter(raw: string | null, chapterCount: number): number | null {
  const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  const isValid = Number.isInteger(parsed) && parsed >= 0 && parsed < chapterCount;
  // `+ 0` 把 -0 变成 +0，其余整数不变
  return isValid ? parsed + 0 : null;
}

/**
 * 把查询串（可带前导 `"?"`）的 `ch` 设为 `n`，其余参数的键、值与顺序不变；返回不带 `"?"` 的串。
 *
 * 基于 `URLSearchParams.set`：已有 `ch` 时替换**第一个**并删去其余同名项（位置保留在第一个
 * `ch` 处），没有时追加到末尾。`n` 以 `String(n)` 写出——十进制、无前导零（需求 7.1）。
 *
 * 结果是 `URLSearchParams` 的规范序列化，因此对其以同一个 `n` 再调用一次返回值不变（7.2 的
 * 幂等）。其余参数的**条目**（键与值）不变，但编码可能被规范化（如 `%20` 写成 `+`）。
 */
export function withChapterParam(search: string, n: number): string {
  const params = new URLSearchParams(search);
  params.set(CHAPTER_PARAM, String(n));
  return params.toString();
}
