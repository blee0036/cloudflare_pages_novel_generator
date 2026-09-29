import { putCachedBook } from "./bookCache";
import { readCachedBook, touchCachedBook } from "./indexedDB";
import { BookLoadSource, nowMs, reportBookLoad } from "./loadMetrics";
import {
  INDETERMINATE,
  ProgressReporter,
  deriveLoadProgress,
} from "./loadProgress";

// In-memory cache for loaded books
const memoryBookCache = new Map<string, string>();

/**
 * 一次加载的产物 + 该分支能观测到的指标槽位（需求 3.5）。
 *
 * 取文本与上报指标分开：每个分支只负责填自己知道的字段，`loadGzipBookText` 末尾统一上报
 * 一次。
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
 * `gz` 为 `null` 的两个分支**无法**缓存，这是事实限制而不是取舍：
 * - `Content-Encoding: gzip` 透明解压——HTTP 层在 `fetch` 返回之前就把 gz 解掉了，响应体
 *   里只剩明文，压缩前的字节根本没有进过 JS。为了缓存而再发一次请求拿原始 gz 也不可行：
 *   没有任何请求头能要求服务器"别压"，同一个 URL 拿回来的还是透明解压后的结果。
 * - `DecompressionStream` 抛错后的 `fetch().text()` 兜底——手上的 gz 已经证明解不开，
 *   存进去只会让下次打开从缓存里读出同一份坏数据，比不缓存更糟。
 *
 * 两个分支都仍有内存缓存（本次会话内二次打开是 0ms），代价只是跨会话要重新下载。
 */
interface FetchedBookText extends BookTextOutcome {
  gz: ArrayBuffer | null;
}

/**
 * 加载并解压 gzip 压缩的小说文本文件
 * 缓存层级：
 * 1. 内存一级缓存 (0ms 切换)
 * 2. IndexedDB 二级缓存（存**原始 gz 二进制**，命中后本地解压；需求 4.1）
 * 3. 网络：取回 gz → 解压 → 写入二级缓存
 *
 * 全程记录 gz 字节数、解压耗时与结果字符数（需求 3.5）。这些数字**只用于观察**：
 * 本函数不读取任何历史指标，也不因为某个读数大就改走别的分支——没有自动降级路径。
 *
 * ## `onProgress` 的契约（需求 10.5，design §8.3）
 *
 * 回调收到的是 `LoadProgress`（确定态带整数百分比 / 不确定态）而不是一对数字：本函数的
 * 五条分支里只有一条（网络取原始 gz 且响应带 `content-length`）能给出百分比，其余都拿
 * 不到分母，这在类型上必须说得出来，否则调用方只能把"拿不到"渲染成 0%。
 *
 * 两条调用方必须知道的边界：
 * - **回调可能一次都不触发**（内存命中时没有任何 I/O）。所以调用方的**初始状态就得是
 *   不确定态**，不能是 0%——不确定态是这条链路的默认值，确定态是拿到分母后的升级。
 * - 上报不保证单调覆盖全程：确定态的书在下载结束、开始本地解压或走兜底重取时会**退回**
 *   不确定态。那两段确实没有百分比可言，让条子继续循环比冻在 100% 更诚实。
 */
export async function loadGzipBookText(
  url: string,
  bookId: string,
  onProgress?: ProgressReporter
): Promise<string> {
  const startedAt = nowMs();
  const outcome = await resolveBookText(url, bookId, onProgress);

  reportBookLoad({
    bookId,
    source: outcome.source,
    gzBytes: outcome.gzBytes,
    chars: outcome.text.length,
    decompressMs: outcome.decompressMs,
    totalMs: nowMs() - startedAt,
    startedAt,
  });

  return outcome.text;
}

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

  // 2. 检查 IndexedDB 持久缓存（存的是 gz，要在本地解压）
  const fromCache = await resolveFromCache(bookId, onProgress);
  if (fromCache) {
    // 解压结果进内存一级缓存：同一会话内再打开这本书就不必重解压那 126 ms。
    memoryBookCache.set(bookId, fromCache.text);
    return fromCache;
  }

  // 3. 网络请求
  const fetched = await fetchBookText(url, onProgress);

  memoryBookCache.set(bookId, fetched.text);

  if (fetched.gz) {
    // fire-and-forget：`putCachedBook` 永不抛出（任务 47），本数 LRU 与配额降级都在它内部
    // 处理完。不等它是有意的——缓存写入（最大书约 22 MB 的结构化克隆）不该挡在"书已经可以
    // 看了"的前面。写不进去的唯一后果是下次打开重新下载。
    void putCachedBook(bookId, fetched.gz);
  }

  return fetched;
}

/**
 * IndexedDB 分支：取回 gz、本地解压、推进 `lastAccess`（需求 4.1/4.3）。
 *
 * 这条分支的 `decompressMs` 是**唯一干净的解压成本读数**：不含网络，纯 gz→文本
 * （附录 M1 实测最大书约 126 ms）。网络分支的同名读数含下载，两者不可直接比较
 * （见 loadMetrics 里的说明）。
 *
 * 没有缓存、缓存不可用（`readCachedBook` 静默返回 `null`）、或缓存里的 gz 解不开时一律
 * 返回 `null`，让调用方继续走网络。坏记录不单独删除：网络分支随后会以同一个 `bookId`
 * 覆盖写，多一次删除只是多一轮事务。
 *
 * 进度只能报不确定态（需求 10.5）：下载这一步没发生，剩下的是那约 126 ms 的纯 CPU 解压，
 * `DecompressionStream` 不报进展。这段时间不算短——恰好是"离线秒开"最该显得在动的时候。
 */
async function resolveFromCache(
  bookId: string,
  onProgress?: ProgressReporter
): Promise<BookTextOutcome | null> {
  const cached = await readCachedBook(bookId);
  if (!cached) return null;

  onProgress?.(INDETERMINATE);

  const startedAt = nowMs();
  let text: string;
  try {
    text = await decompressGzip(cached.gz);
  } catch {
    return null;
  }
  const decompressMs = nowMs() - startedAt;

  // 推进 LRU 的访问时刻。同样 fire-and-forget：它是一次整条记录的重写（存储层已注明），
  // 不能占着打开书的关键路径；失败了只影响淘汰顺序，不影响本次阅读，所以吞掉异常。
  void touchCachedBook(bookId).catch(() => {});

  return {
    text,
    source: "indexeddb",
    // 用记录里的 `bytes` 而不是 `gz.byteLength`：两者恒等（存储层由 byteLength 派生），
    // 取前者省一次对二进制的属性访问，也表明这是"当初存下的那个体积"。
    gzBytes: cached.bytes,
    decompressMs,
  };
}

/** 网络分支：取回 `.txt.gz` 并解压，顺带量出 gz 字节数与解压耗时。 */
async function fetchBookText(
  url: string,
  onProgress?: ProgressReporter
): Promise<FetchedBookText> {
  const response = await fetch(url);
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

    const startedAt = nowMs();
    const text = await response.text();
    return {
      text,
      source: "network-transparent",
      // 该分支拿不到解压前后的字节数，只能信 content-length（按 fetch 规范它是压缩后的
      // 长度）；头缺失时记 null。需求 10.7 的部署核对就是看这条日志出不出现。
      gzBytes: totalBytes > 0 ? totalBytes : null,
      decompressMs: nowMs() - startedAt,
      // 压缩前的字节没进过 JS，无从缓存（见 `FetchedBookText` 的说明）。
      gz: null,
    };
  }

  // 否则，响应体为原始 gzip 二进制流：先把 gz 收成一个连续的 ArrayBuffer（缓存要存的就是
  // 它），再交给 DecompressionStream。
  //
  // 这里放弃了"下载与解压重叠"的流式写法：任务 48 要求缓存原始 gz，而管进解压流的字节是
  // 不留存的，非要两者兼得就得 tee 一路出来另行累积——多一条并发分支、多一处取消逻辑，
  // 换来的只是最大书上约 126 ms 的重叠（附录 M1），而那本书的下载本身是秒级的。
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
  // 循环态，而不是冻在满格——最大书这一段约 126 ms，冻住的满格条会被当成卡住。
  onProgress?.(INDETERMINATE);

  const gz = concatChunks(chunks);
  // 立刻放开分片引用：拼接瞬间 gz 在内存里存在两份（最大书 2 × 22.36 MB），而紧接着的
  // 解压又要再分配约 39 MB 的文本。丢掉分片让那 22 MB 在解压开始前就可回收，于是本流程的
  // 峰值停在「gz 一份 + 文本一份」（约 62 MB，A7 认可的量级），而不是三者叠加。
  chunks.length = 0;

  const startedAt = nowMs();
  try {
    const text = await decompressGzip(gz);
    return {
      text,
      source: "network",
      // 累加的实际到达字节数，比 content-length 可靠（头可能缺失或被代理改写）。
      gzBytes: loadedBytes,
      decompressMs: nowMs() - startedAt,
      gz,
    };
  } catch {
    // 降级兜底：重新发一次请求整份读成文本。已经报过的不确定态继续有效——这一段同样
    // 观测不到进展，而且此刻退回 0% 会像是"重新开始下载"。
    const fallbackResponse = await fetch(url);
    const text = await fallbackResponse.text();
    return {
      text,
      source: "network-fallback",
      // 解压失败时 `loadedBytes` 虽然是完整的，但这份 gz 已被证明解不开，记上去会污染
      // 压缩率统计 → null。
      gzBytes: null,
      decompressMs: null,
      // 解不开的 gz 不入缓存（见 `FetchedBookText` 的说明）。
      gz: null,
    };
  }
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
 * gz 损坏、截断或根本不是 gzip 时 reject（`DecompressionStream` 的原生行为），由调用方
 * 决定是回退到网络（缓存分支）还是 `fetch().text()`（网络分支，design §10）。
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
