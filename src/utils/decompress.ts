import { putCachedBook } from "./bookCache";
import {
  BookTextInvalidError,
  countCodePoints,
  hasGzipMagic,
  normalizeCharCount,
} from "./bookTextCheck";
import { deleteCachedBook, readCachedBook, touchCachedBook } from "./indexedDB";
import { BookLoadMetrics, BookLoadSource, nowMs, reportBookLoad } from "./loadMetrics";
import {
  INDETERMINATE,
  ProgressReporter,
  deriveLoadProgress,
} from "./loadProgress";
import { loadToc } from "./tocCache";

/**
 * 一次加载的产物 + 该分支能观测到的指标槽位（需求 3.5）。
 *
 * 取文本与上报指标分开：每个分支只负责填自己知道的字段，loader 末尾统一上报一次。
 */
interface BookTextOutcome {
  text: string;
  source: BookLoadSource;
  gzBytes: number | null;
  decompressMs: number | null;
}

/**
 * 网络分支的产物，额外带出原始 gz 以便落库（需求 4.1）。
 *
 * `gz` 为 `null` 的是 `Content-Encoding: gzip` 透明解压分支，它**无法**缓存，这是事实限制
 * 而不是取舍：HTTP 层在 `fetch` 返回之前就把 gz 解掉了，响应体里只剩明文，压缩前的字节
 * 根本没有进过 JS。为了缓存而再发一次请求拿原始 gz 也不可行：没有任何请求头能要求服务器
 * "别压"，同一个 URL 拿回来的还是透明解压后的结果。
 *
 * 该分支仍有内存缓存（本次会话内二次打开是 0ms），代价只是跨会话要重新下载。
 */
interface FetchedBookText extends BookTextOutcome {
  gz: ArrayBuffer | null;
}

/** `loadGzipBookText` 的形状；`createBookLoader` 产出的每个实例都是它。 */
export type BookLoader = (
  url: string,
  bookId: string,
  onProgress?: ProgressReporter
) => Promise<string>;

/**
 * loader 的全部外部依赖（e2e-visual-testing 需求 19，design "F-001 修复"）。
 *
 * 做法同 `bookCache.ts` 的 `CacheStore`：生产路径永远走 `defaultDeps`，抽成接口只为让
 * 缓存命中、坏记录删除、单轮重取、码点检查这几段流程能在 Node 下直接单测——Node 里没有
 * IndexedDB，也没有 `_toc.json` 可取。
 *
 * 三个写缓存的副作用（`deleteCached`、`touchCached`、`putCached`）失败时一律被吞掉：
 * 缓存是可再生数据，它的失败不能成为打不开书的原因。
 */
export interface BookLoaderDeps {
  /** 取 `.txt.gz`。只以 URL 一个参数调用。 */
  fetch: typeof fetch;
  /** 单调时钟读数（ms），用于 `decompressMs` 与 `totalMs`。 */
  now(): number;
  /** 上报一次加载指标。只在成功返回全文之前调用，每次加载恰好一次。 */
  report(m: BookLoadMetrics): void;
  /** 读该书的 IndexedDB 记录；没有、或缓存不可用时为 `null`。 */
  readCached(bookId: string): Promise<{ gz: ArrayBuffer; bytes: number } | null>;
  /** 删除该书的记录（19.9：读到坏记录时）。会被等待，失败被吞掉。 */
  deleteCached(bookId: string): Promise<void>;
  /** 推进该书的 `lastAccess`（缓存命中时）。fire-and-forget。 */
  touchCached(bookId: string): Promise<void>;
  /** 写入网络取回的原始 gz。fire-and-forget。 */
  putCached(bookId: string, gz: ArrayBuffer): Promise<unknown>;
  /**
   * 该书 `_toc.json` 里的 `charCount`，原样返回、不必校验：loader 用 `normalizeCharCount`
   * 规范，不可用（含本函数 reject）时跳过码点检查（19.10）。
   */
  expectedCharCount(bookId: string): Promise<unknown>;
}

/**
 * 生产依赖。
 *
 * `charCount` 取自 `loadToc(bookId)`：`ReaderPage` 在调用 `loadGzipBookText` 之前已经
 * `await loadToc(bookId)`，而 `tocCache` 按 bookId 缓存的是 **Promise**、只在失败时摘除
 * 条目，所以这里拿到的是同一个已完成的 Promise，不多发 `_toc.json` 请求（需求 19.4、11.3
 * 的"恰好 1 次"）。这也是 `ReaderPage.tsx` 不必改动的原因（design K4）。
 */
const defaultDeps: BookLoaderDeps = {
  // 包一层而不是直接写 `fetch`：以 `deps.fetch(url)` 调用时 `this` 是 deps 对象，浏览器的
  // 原生 fetch 要求 `this` 为 Window 或 undefined，否则抛 "Illegal invocation"。
  fetch: (input, init) => fetch(input, init),
  now: nowMs,
  report: reportBookLoad,
  readCached: readCachedBook,
  deleteCached: deleteCachedBook,
  // 只传 bookId：`touchCachedBook` 的第二参是访问时刻，缺省取 `Date.now()`。
  touchCached: (bookId) => touchCachedBook(bookId),
  putCached: (bookId, gz) => putCachedBook(bookId, gz),
  expectedCharCount: (bookId) =>
    loadToc(bookId).then(
      (toc) => toc.charCount,
      () => undefined
    ),
};

/**
 * 造一个书籍正文 loader。每个实例各有一份内存缓存；生产代码只用 `loadGzipBookText`
 * 这一个实例，单测各自新建以免互相污染。
 *
 * 缓存层级：
 * 1. 内存一级缓存 (0ms 切换)
 * 2. IndexedDB 二级缓存（存**原始 gz 二进制**，命中后本地解压；需求 4.1）
 * 3. 网络：取回 gz → 解压 → 写入二级缓存
 *
 * ## 有效性检查（F-001，需求 19）
 *
 * 书的 `.txt.gz` 缺失时，站点的 SPA 回退以状态 200 返回 `index.html`。旧流程解压失败后
 * 以 `fetch().text()` 兜底（`source=network-fallback`），把这页 HTML 当成正文渲染。现在：
 *
 * - **不再兜底**（19.5，删除依据见 design "F-001 修复"）：Opaque 响应不是 gzip（缺魔数）即抛
 *   `not-gzip`，解压抛错即抛 `corrupt-gzip`（19.1）。
 * - **码点检查**（19.3）：`indexeddb`、`network`、`network-transparent` 三个分支的全文，其
 *   Unicode 码点数必须等于 `_toc.json` 的 `charCount`；`charCount` 不可用时跳过（19.10）。
 *   `memory` 分支只会命中已通过检查（或已跳过检查）的全文，不再检查。检查是对全文的一次
 *   线性扫描，大书也只是千万码元量级，远小于解压本身的成本。
 * - **坏记录**（19.9）：IndexedDB 的记录解不开或未通过检查时，先删除（删除失败也继续），
 *   再只走一轮网络；网络结果同样要过检查，此后不再回读 IndexedDB、也不做第二轮重取。
 * - **失败不留痕**（19.2）：以错误结束的加载不写内存缓存、不写 IndexedDB、不打
 *   `[book-load]` 日志，所以同一会话内再次打开会重新经 IndexedDB 与网络加载。
 *
 * 错误经 `ReaderPage` 现有的 `catch → setError(message)` 进入阅读器错误页；
 * `BookTextInvalidError` 的 `message` 就是写给读者的那行说明。
 *
 * 全程记录 gz 字节数、解压耗时与结果字符数（需求 3.5）。这些数字**只用于观察**：
 * 本函数不读取任何历史指标，也不因为某个读数大就改走别的分支——没有自动降级路径。
 * `chars` 仍是 `text.length`（UTF-16 码元数，需求 19.4），与检查用的码点数是两回事。
 *
 * ## `onProgress` 的契约（需求 10.5，design §8.3）
 *
 * 回调收到的是 `LoadProgress`（确定态带整数百分比 / 不确定态）而不是一对数字：本函数的
 * 四条分支里只有一条（网络取原始 gz 且响应带 `content-length`）能给出百分比，其余都拿
 * 不到分母，这在类型上必须说得出来，否则调用方只能把"拿不到"渲染成 0%。
 *
 * 两条调用方必须知道的边界：
 * - **回调可能一次都不触发**（内存命中时没有任何 I/O）。所以调用方的**初始状态就得是
 *   不确定态**，不能是 0%——不确定态是这条链路的默认值，确定态是拿到分母后的升级。
 * - 上报不保证单调覆盖全程：确定态的书在下载结束、开始本地解压时会**退回**不确定态；
 *   IndexedDB 记录损坏而改走网络时，会从不确定态再进入确定态。那几段确实没有百分比
 *   可言，让条子继续循环比冻在 100% 更诚实。
 */
export function createBookLoader(deps: BookLoaderDeps): BookLoader {
  const memoryBookCache = new Map<string, string>();

  /** 按 内存 → IndexedDB → 网络 的顺序取文本。 */
  async function resolveBookText(
    url: string,
    bookId: string,
    onProgress?: ProgressReporter
  ): Promise<BookTextOutcome> {
    // 1. 检查内存缓存
    const inMemory = memoryBookCache.get(bookId);
    if (inMemory !== undefined) {
      // 命中内存时既没下载也没解压，gz 字节数与解压耗时都不可观测 → null，不用 0 冒充。
      //
      // 这条分支**不上报进度**：它在同一个微任务里就返回了，调用方的加载态根本没机会上屏，
      // 报一次不确定态只是徒增一轮渲染。契约里已说明"回调可能一次都不触发"，兜底靠的是
      // 调用方的初始态本就是不确定态。
      return { text: inMemory, source: "memory", gzBytes: null, decompressMs: null };
    }

    // 码点检查的期望值。`null` ⇒ 跳过检查（19.10）。
    const expected = await readExpectedCharCount(deps, bookId);

    // 2. 检查 IndexedDB 持久缓存（存的是 gz，要在本地解压）。坏记录在里面删掉并返回 null。
    const fromCache = await resolveFromCache(deps, bookId, expected, onProgress);
    if (fromCache) {
      // 解压结果进内存一级缓存：同一会话内再打开这本书就不必再解压一遍（大书是百毫秒量级）。
      memoryBookCache.set(bookId, fromCache.text);
      return fromCache;
    }

    // 3. 网络请求：只此一轮（19.9），此后不再回读 IndexedDB。
    const fetched = await fetchBookText(deps, url, onProgress);
    assertCharCount(fetched.text, expected);

    memoryBookCache.set(bookId, fetched.text);

    const { gz } = fetched;
    if (gz) {
      // fire-and-forget：`putCachedBook` 永不抛出（任务 47），本数 LRU 与配额降级都在它内部
      // 处理完。不等它是有意的——缓存写入（大书是几十 MB 的结构化克隆）不该挡在"书已经可以
      // 看了"的前面。写不进去的唯一后果是下次打开重新下载。
      detach(() => deps.putCached(bookId, gz));
    }

    return fetched;
  }

  return async function loadBookText(url, bookId, onProgress) {
    const startedAt = deps.now();
    // 抛错时直接冒出去：不上报、不写缓存（19.2）。
    const outcome = await resolveBookText(url, bookId, onProgress);

    deps.report({
      bookId,
      source: outcome.source,
      gzBytes: outcome.gzBytes,
      chars: outcome.text.length,
      decompressMs: outcome.decompressMs,
      totalMs: deps.now() - startedAt,
      startedAt,
    });

    return outcome.text;
  };
}

/**
 * 加载并解压 gzip 压缩的小说文本文件。流程、有效性检查与 `onProgress` 契约见
 * `createBookLoader`。签名与修复前相同，`ReaderPage` 无需改动（design K4）。
 */
export const loadGzipBookText: BookLoader = createBookLoader(defaultDeps);

/**
 * 取码点检查的期望值：`charCount` 缺失、不是非负安全整数、或取值本身失败时为 `null`，
 * 调用方据此跳过检查（19.10）。
 *
 * 取值失败也按"不可用"处理而不是让加载失败：默认实现已把 `loadToc` 的 reject 映射成
 * `undefined`，这里再兜一层是为了让"拿不到期望值 ⇒ 跳过检查"对任何依赖实现都成立。
 */
async function readExpectedCharCount(
  deps: BookLoaderDeps,
  bookId: string
): Promise<number | null> {
  try {
    return normalizeCharCount(await deps.expectedCharCount(bookId));
  } catch {
    return null;
  }
}

/**
 * 码点检查（19.3）：`expected` 为 `null` 时跳过；否则全文的 Unicode 码点数必须与之相等，
 * 不等即抛 `char-count-mismatch`。
 *
 * 用码点数而不是 `text.length`：预处理管线以 Python `len()` 写入 `charCount`，含增补平面
 * 字符的书两者不相等。
 */
function assertCharCount(text: string, expected: number | null): void {
  if (expected === null) return;

  const actual = countCodePoints(text);
  if (actual !== expected) {
    throw new BookTextInvalidError(
      "char-count-mismatch",
      `码点数 ${actual}，目录记录 ${expected}`
    );
  }
}

/**
 * 执行一个可失败的缓存副作用并等它结束；失败（含同步抛错）一律吞掉。
 *
 * `task` 在本函数被调用的同一时刻同步发出（async 函数体在第一个 `await` 之前同步执行），
 * 所以 `detach` 之后副作用已经开始，而不是推迟到下一个微任务。
 */
async function settle(task: () => Promise<unknown>): Promise<void> {
  try {
    await task();
  } catch {
    // 缓存是可再生数据：删不掉、写不进、推不动 lastAccess，都不影响本次阅读。
  }
}

/** 发出一个可失败的缓存副作用，不等它；失败一律吞掉。 */
function detach(task: () => Promise<unknown>): void {
  void settle(task);
}

/**
 * IndexedDB 分支：取回 gz、本地解压、过码点检查、推进 `lastAccess`（需求 4.1/4.3、19.3）。
 *
 * 这条分支的 `decompressMs` 是**唯一干净的解压成本读数**：不含网络，纯 gz→文本
 * （附录 M1 有实测，大书在百毫秒量级）。网络分支的同名读数含下载，两者不可直接比较
 * （见 loadMetrics 里的说明）。码点检查不计入 `decompressMs`，只计入 `totalMs`。
 *
 * 返回 `null` 让调用方继续走网络，有两种情形：
 * - 没有记录，或缓存不可用（`readCached` 静默返回 `null`）；
 * - 记录是坏的：gz 解不开，或全文未通过码点检查（修复前写入的 HTML 记录、服务器产物更新后
 *   遗留的旧记录）。此时**先删除再返回**（19.9）：若网络结果也不通过，加载结束时该书在
 *   IndexedDB 里就没有记录，而不是留着一条每次都要白解压一遍的坏数据。删除会被等待，
 *   但失败不阻止随后的网络重取。
 *
 * 坏记录不上报 `source=indexeddb`（19.9），也不推进它的 `lastAccess`。
 *
 * 进度只能报不确定态（需求 10.5）：下载这一步没发生，剩下的是百毫秒量级的纯 CPU 解压，
 * `DecompressionStream` 不报进展。这段时间不算短——恰好是"离线秒开"最该显得在动的时候。
 */
async function resolveFromCache(
  deps: BookLoaderDeps,
  bookId: string,
  expected: number | null,
  onProgress?: ProgressReporter
): Promise<BookTextOutcome | null> {
  const cached = await deps.readCached(bookId);
  if (!cached) return null;

  onProgress?.(INDETERMINATE);

  const startedAt = deps.now();
  let text: string;
  let decompressMs: number;
  try {
    text = await decompressGzip(cached.gz);
    decompressMs = deps.now() - startedAt;
    assertCharCount(text, expected);
  } catch {
    await settle(() => deps.deleteCached(bookId));
    return null;
  }

  // 推进 LRU 的访问时刻。fire-and-forget：它是一次整条记录的重写（存储层已注明），
  // 不能占着打开书的关键路径；失败了只影响淘汰顺序，不影响本次阅读，所以吞掉异常。
  detach(() => deps.touchCached(bookId));

  return {
    text,
    source: "indexeddb",
    // 用记录里的 `bytes` 而不是 `gz.byteLength`：两者恒等（存储层由 byteLength 派生），
    // 取前者省一次对二进制的属性访问，也表明这是"当初存下的那个体积"。
    gzBytes: cached.bytes,
    decompressMs,
  };
}

/**
 * 网络分支：取回 `.txt.gz` 并解压，顺带量出 gz 字节数与解压耗时。
 *
 * 只负责字节层的有效性（不是 gzip、解不开即抛）；码点检查由调用方在拿到全文后做，两种
 * 响应形态（Opaque / Transparent）共用那一处。
 */
async function fetchBookText(
  deps: BookLoaderDeps,
  url: string,
  onProgress?: ProgressReporter
): Promise<FetchedBookText> {
  const response = await deps.fetch(url);
  if (!response.ok) {
    throw new Error(`无法获取书籍文件: HTTP ${response.status} ${response.statusText}`);
  }

  if (!response.body) {
    throw new Error("浏览器响应体不可读取");
  }

  const contentLength = response.headers.get("content-length");
  // 解析不出数字的头（被代理写成 `unknown`、多个逗号分隔值）归一为 0，与"没有这个头"
  // 同一处理：下游只做 `> 0` / `<= 0` 两分，NaN 会让这两个判断同时为假，于是既不报确定态
  // 也不报不确定态——进度条一次上报都收不到。
  const parsedLength = contentLength ? Number.parseInt(contentLength, 10) : 0;
  const totalBytes = Number.isFinite(parsedLength) && parsedLength > 0 ? parsedLength : 0;
  const contentEncoding = (response.headers.get("content-encoding") || "").toLowerCase();

  // 如果服务器已经返回 Content-Encoding: gzip，浏览器 HTTP 层已自动透明解压
  if (contentEncoding.includes("gzip")) {
    // 这条分支结构性地拿不到百分比（需求 10.5）：HTTP 层在 fetch 返回前就把流吃掉了，
    // `response.text()` 是一次不可观测的等待。`content-length` 在此是**压缩后**的长度，
    // 拿它当分母会得出一条走到 250% 的进度条，所以只能报不确定态。
    onProgress?.(INDETERMINATE);

    // 这里拿到的已是明文，字节层无从检查；解码出来的是不是正文（例如代理把自身的错误页
    // 压缩后返回），只能靠调用方的码点检查识别（19.3）。
    const startedAt = deps.now();
    const text = await response.text();
    return {
      text,
      source: "network-transparent",
      // 该分支拿不到解压前后的字节数，只能信 content-length（按 fetch 规范它是压缩后的
      // 长度）；头缺失时记 null。需求 10.7 的部署核对就是看这条日志出不出现。
      gzBytes: totalBytes > 0 ? totalBytes : null,
      decompressMs: deps.now() - startedAt,
      // 压缩前的字节没进过 JS，无从缓存（见 `FetchedBookText` 的说明）。
      gz: null,
    };
  }

  // 否则，响应体为原始 gzip 二进制流：先把 gz 收成一个连续的 ArrayBuffer（缓存要存的就是
  // 它），再交给 DecompressionStream。
  //
  // 这里放弃了"下载与解压重叠"的流式写法：任务 48 要求缓存原始 gz，而管进解压流的字节是
  // 不留存的，非要两者兼得就得 tee 一路出来另行累积——多一条并发分支、多一处取消逻辑，
  // 换来的只是大书上百毫秒量级的重叠（附录 M1），而那本书的下载本身是秒级的。
  // 进度回调的语义不变：报的一直是 gz 到达字节数。
  const chunks: Uint8Array[] = [];
  let loadedBytes = 0;
  const reader = response.body.getReader();

  // 唯一可能给出百分比的分支，前提是响应带了 `content-length`。头缺失时（代理改写、分块
  // 传输）在进入循环前报一次不确定态，此后循环内不再上报——分母不会中途出现，而复报
  // 只会让进度条每收一个分片重渲染一次（需求 10.5）。
  if (totalBytes <= 0) {
    onProgress?.(INDETERMINATE);
  }

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loadedBytes += value.length;
    if (onProgress && totalBytes > 0) {
      onProgress(deriveLoadProgress(loadedBytes, totalBytes));
    }
  }

  // 下载完了，接下来是本地解压：同 IndexedDB 分支，没有百分比可言。让条子从 100% 退回
  // 循环态，而不是冻在满格——大书这一段有百毫秒量级，冻住的满格条会被当成卡住。
  onProgress?.(INDETERMINATE);

  const gz = concatChunks(chunks);
  // 立刻放开分片引用：拼接瞬间 gz 在内存里存在两份（分片与拼接结果），而紧接着的
  // 解压又要再分配一份更大的文本。丢掉分片让那一份 gz 在解压开始前就可回收，于是本流程的
  // 峰值停在「gz 一份 + 文本一份」（A7 认可的量级），而不是三者叠加。
  chunks.length = 0;

  // 字节层检查（19.1）：SPA 回退的 `index.html` 以 `<` 开头，在解压之前就认出来，给出比
  // "解压失败"更能说明问题的错误。
  if (!hasGzipMagic(new Uint8Array(gz))) {
    throw new BookTextInvalidError(
      "not-gzip",
      "不是 gzip 数据，可能是文件缺失时站点返回的页面"
    );
  }

  const startedAt = deps.now();
  let text: string;
  try {
    text = await decompressGzip(gz);
  } catch {
    // 不再兜底重取（19.5）：同一 URL 再取一次拿回的还是这批字节，按 UTF-8 解码出来只会是
    // 乱码或那页 HTML。截断的 gz、浏览器不支持 `DecompressionStream` 都落在这里。
    throw new BookTextInvalidError("corrupt-gzip", "无法完整解压，文件可能不完整");
  }

  return {
    text,
    source: "network",
    // 累加的实际到达字节数，比 content-length 可靠（头可能缺失或被代理改写）。
    gzBytes: loadedBytes,
    decompressMs: deps.now() - startedAt,
    gz,
  };
}

/**
 * 把若干分片拼成一个**独占**的连续 ArrayBuffer。
 *
 * 返回 `ArrayBuffer` 而不是 `Uint8Array`：IndexedDB 记录存的就是 `ArrayBuffer`，而
 * `TypedArray.buffer` 只保证"底层缓冲"，分片视图往往是大池子上的一段，直接把它的 buffer
 * 存进去会连带几百 KB 无关字节。这里自己分配，所以返回值的每一个字节都是数据本身。
 *
 * 不为"只有一个分片"做零拷贝特例：那要求该分片恰好独占整个 buffer（`byteOffset === 0`
 * 且长度相等），而 fetch 的分片并不保证这点，判断条件比省下的一次拷贝更容易写错。
 *
 * 纯函数，可直接单测。
 */
export function concatChunks(chunks: Uint8Array[]): ArrayBuffer {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;

  const buffer = new ArrayBuffer(total);
  const out = new Uint8Array(buffer);

  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }

  return buffer;
}

/**
 * 用原生 `DecompressionStream("gzip")` 把一段 gz 解成 UTF-8 文本。
 *
 * 用一次性入队的 `ReadableStream` 而不是 `new Blob([gz]).stream()`：Blob 构造会把这几十 MB
 * 再拷一份（可能还落进 blob 存储），而这里的字节已经在内存里且形状正好。
 *
 * gz 损坏、截断或根本不是 gzip 时 reject（`DecompressionStream` 的原生行为）。调用方据此
 * 判定：缓存分支把它当坏记录删掉再走网络，网络分支抛 `corrupt-gzip`（需求 19.1、19.9）。
 */
export async function decompressGzip(gz: ArrayBuffer): Promise<string> {
  // 分片类型写 `BufferSource` 而不是 `Uint8Array`，是为了对上 `DecompressionStream.writable`
  // 的声明（`WritableStream<BufferSource>`）。写成 `Uint8Array` 时 `pipeThrough` 的两个流在
  // 类型上对不齐，得靠 `as unknown as` 硬转才能过——用宽一点的入参类型就不必了。
  const source = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(new Uint8Array(gz));
      controller.close();
    },
  });

  return await new Response(source.pipeThrough(new DecompressionStream("gzip"))).text();
}
