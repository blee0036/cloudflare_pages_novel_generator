/**
 * 加载失败的分类与中文说明（F-011、F-012；需求 13）。
 *
 * - `fetchJson` 把 JSON 请求的三种失败包装成三个错误类，调用方据此区分
 *   "找不到"（404 / 响应体不是 JSON）、"连不上"（网络错误、其他非 2xx）。
 * - `classifyLoadError` 只按出错阶段与错误类型给出类别，与消息文本无关（13.2、13.8）。
 * - 页面只显示类别对应的固定文案；原始异常经 `formatLoadErrorLog` 写成一行进控制台（13.4、13.10）。
 *
 * `tsconfig` 的 `lib` 为 ES2020，没有 `new Error(msg, { cause })`；
 * 三个错误类把 `cause` 存为自有只读属性，并显式设 `name`（压缩后类名会变）。
 */

/** 出错阶段：阅读器取 `_toc.json`、阅读器取并解出 `.txt.gz`、书架取 `books.json`。 */
export type LoadStage = "toc" | "text" | "catalog";

export type LoadErrorCategory = "not-found" | "unavailable" | "damaged" | "unknown";

/** 书架阶段（`catalog`）可能的类别：不含 `damaged`（13.8）。 */
export type ShelfLoadErrorCategory = Exclude<LoadErrorCategory, "damaged">;

/** 响应状态不在 2xx 内。 */
export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    readonly url: string
  ) {
    super(`HTTP ${status}（${url}）`);
    this.name = "HttpStatusError";
  }
}

/** 响应状态为 2xx，但响应体不能解析为 JSON（含 SPA 回退返回的 `index.html`）。 */
export class ResponseFormatError extends Error {
  constructor(
    readonly url: string,
    readonly cause: unknown
  ) {
    super(`响应体不是合法的 JSON（${url}）：${describeThrown(cause).message}`);
    this.name = "ResponseFormatError";
  }
}

/** `fetch` 本身被拒绝（通常是原生 `TypeError`，例如断网、DNS 失败、CORS）。 */
export class NetworkError extends Error {
  constructor(
    readonly url: string,
    readonly cause: unknown
  ) {
    super(`网络请求失败（${url}）：${describeThrown(cause).message}`);
    this.name = "NetworkError";
  }
}

/**
 * 默认的 `fetch`：以箭头函数转调全局 `fetch`，保证调用时 `this` 正确。
 * 若把全局 `fetch` 本身存进变量再无接收者地调用，浏览器会抛 "Illegal invocation"。
 */
const defaultFetch: typeof fetch = (input, init) => fetch(input, init);

/**
 * 响应体的下载进度：已收到的字节数，与总字节数（拿不到时为 `null`）。
 *
 * `received` 数的是浏览器交给 JS 的字节，也就是**解压后**的字节；`total` 只在响应没有
 * `Content-Encoding` 时取 `Content-Length`。有传输压缩时 `Content-Length` 是压缩后的长度
 * （多数时候干脆没有），拿它当分母会算出一条走过 100% 的进度条——Pages 对 `books.json`
 * 正是这样（需求 5.2a），所以线上只有已收字节数。与 `decompress.ts` 透明解压那条分支同一个原因。
 */
export interface FetchProgress {
  readonly received: number;
  readonly total: number | null;
}

/** `fetchJson` 的进度上报口。每收到一个分片调用一次，开始读响应体之前先报一次 `received: 0`。 */
export type FetchProgressReporter = (progress: FetchProgress) => void;

/**
 * 取 JSON：`fetch` 拒绝 → `NetworkError`；非 2xx → `HttpStatusError`；
 * 响应体解析失败 → `ResponseFormatError`。
 *
 * 返回值只做类型断言，不校验结构；处理数据时抛出的错误不在这里包装
 * （书架阶段按 13.7 判为 `unknown`）。
 *
 * 给了 `onProgress` 时自己逐片读响应体并上报进度（见 `FetchProgress`），读完再按 UTF-8 解码、
 * `JSON.parse`——与 `res.json()` 同一套解码（剥开头的 BOM、坏字节换成 U+FFFD），所以解析结果
 * 与报错和不给 `onProgress` 时相同。唯一的区别是读响应体途中断网：`res.json()` 把它报成解析
 * 失败（`ResponseFormatError`），这里能分清是读的时候断的，报 `NetworkError`。
 */
export async function fetchJson<T>(
  url: string,
  fetchImpl: typeof fetch = defaultFetch,
  onProgress?: FetchProgressReporter,
): Promise<T> {
  let res: Response;
  try {
    res = await fetchImpl(url);
  } catch (cause) {
    throw new NetworkError(url, cause);
  }
  if (!res.ok) {
    throw new HttpStatusError(res.status, url);
  }
  if (onProgress === undefined) {
    try {
      return (await res.json()) as T;
    } catch (cause) {
      throw new ResponseFormatError(url, cause);
    }
  }

  let text: string;
  try {
    text = await readTextWithProgress(res, onProgress);
  } catch (cause) {
    throw new NetworkError(url, cause);
  }
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw new ResponseFormatError(url, cause);
  }
}

/** 响应头给出的未压缩总长；有传输压缩、头缺失或解析不出正整数时为 `null`。 */
function uncompressedLength(res: Response): number | null {
  const encoding = (res.headers.get("content-encoding") ?? "").trim().toLowerCase();
  if (encoding !== "" && encoding !== "identity") return null;
  const raw = res.headers.get("content-length");
  if (raw === null || !/^\s*\d+\s*$/.test(raw)) return null;
  const length = Number(raw);
  return Number.isSafeInteger(length) && length > 0 ? length : null;
}

/** 逐片读完响应体，每片上报一次进度，返回 UTF-8 解码后的文本。 */
async function readTextWithProgress(res: Response, onProgress: FetchProgressReporter): Promise<string> {
  const total = uncompressedLength(res);
  onProgress({ received: 0, total });
  if (res.body === null) return "";

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress({ received, total });
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder("utf-8").decode(bytes);
}

/**
 * 按阶段与错误类型分类（设计第 12 节分类表）。
 *
 * | stage            | HttpStatusError 404 | 其他 HttpStatusError | ResponseFormatError | NetworkError | TypeError（未包装） | 其余      |
 * | ---------------- | ------------------- | -------------------- | ------------------- | ------------ | ------------------- | --------- |
 * | `toc`、`catalog` | not-found           | unavailable          | not-found           | unavailable  | unknown             | unknown   |
 * | `text`           | damaged             | damaged              | damaged             | unavailable  | unavailable         | damaged   |
 *
 * `text` 阶段的错误来自 `loadGzipBookText`，网络错误以原生 `TypeError` 抛出、无法在调用方包装，
 * 因此该阶段把 `TypeError` 判为 `unavailable`。`toc`、`catalog` 的网络错误已由 `fetchJson`
 * 包装成 `NetworkError`，未包装的 `TypeError` 只可能来自处理数据的代码，判为 `unknown`。
 *
 * 三个自定义错误类都直接继承 `Error`（不是 `TypeError`），先于 `TypeError` 判断。
 */
export function classifyLoadError(stage: "catalog", error: unknown): ShelfLoadErrorCategory;
export function classifyLoadError(stage: LoadStage, error: unknown): LoadErrorCategory;
export function classifyLoadError(stage: LoadStage, error: unknown): LoadErrorCategory {
  if (stage === "text") {
    if (error instanceof NetworkError || error instanceof TypeError) return "unavailable";
    return "damaged";
  }
  if (error instanceof HttpStatusError) {
    return error.status === 404 ? "not-found" : "unavailable";
  }
  if (error instanceof ResponseFormatError) return "not-found";
  if (error instanceof NetworkError) return "unavailable";
  return "unknown";
}

/** 阅读器 Error_Page 的说明（需求 13.1）。 */
export const READER_LOAD_ERROR_TEXT: Readonly<Record<LoadErrorCategory, string>> = Object.freeze({
  "not-found": "书库里找不到这本书，可能已被移除，或链接有误。",
  unavailable: "暂时无法连接书库，请检查网络后重试。",
  damaged: "这本书的正文文件缺失或已损坏，暂时无法打开。",
  unknown: "打开这本书时出了点问题，请稍后重试。",
});

/** 书架 Shelf_Error_State 的失败说明（需求 13.7）。 */
export const SHELF_LOAD_ERROR_TEXT: Readonly<Record<ShelfLoadErrorCategory, string>> = Object.freeze({
  "not-found": "暂时找不到书库目录，站点可能正在更新，请稍后再试。",
  unavailable: "暂时无法连接书库，请检查网络后重试。",
  unknown: "加载书架时出了点问题，请稍后重试。",
});

/**
 * 控制台日志行：
 * `[load-error] stage=<stage> id=<bookId|-> status=<n|-> name=<name> message=<message>`。
 *
 * `status` 只在 `HttpStatusError` 时有值。消息中的换行折成空格，保证整条日志是一行。
 */
export function formatLoadErrorLog(stage: LoadStage, bookId: string | null, error: unknown): string {
  const { name, message } = describeThrown(error);
  const status = error instanceof HttpStatusError ? String(error.status) : "-";
  const id = bookId ? bookId : "-";
  return `[load-error] stage=${stage} id=${id} status=${status} name=${oneLine(name)} message=${oneLine(message)}`;
}

/**
 * 取任意抛出值的名称与消息，不会再抛错。
 *
 * - `Error`：取 `name`（为空时记为 `Error`）与 `message`。
 * - 非 `Error`：名称为 `null` 或 `typeof` 的结果；字符串原样作消息，
 *   对象优先用 `JSON.stringify`，其余用 `String()`；都失败时记为 `<unprintable>`。
 */
function describeThrown(value: unknown): { name: string; message: string } {
  if (value instanceof Error) {
    const name = safeText(() => value.name);
    return { name: name ? name : "Error", message: safeText(() => value.message) };
  }
  const name = value === null ? "null" : typeof value;
  if (typeof value === "string") return { name, message: value };
  if (typeof value === "object" && value !== null) {
    const json = safeText(() => JSON.stringify(value));
    if (json) return { name, message: json };
  }
  return { name, message: safeText(() => String(value)) || "<unprintable>" };
}

/** 调用取值函数并转成字符串；取值或转换抛错时返回空串。 */
function safeText(read: () => unknown): string {
  try {
    const v = read();
    return v === undefined || v === null ? "" : String(v);
  } catch {
    return "";
  }
}

function oneLine(s: string): string {
  return s.replace(/\s*[\r\n]+\s*/g, " ");
}
