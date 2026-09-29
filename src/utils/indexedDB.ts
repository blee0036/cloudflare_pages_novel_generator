/**
 * 离线缓存的存储层（需求 4.1，design §8.1）。
 *
 * ## Schema（version 2）
 *
 * ```
 * DB: koodo_novel_cache_db (version 2)
 * store: books   key = bookId
 *   { bookId, gz: ArrayBuffer, bytes: number, lastAccess: number, cachedAt: number }
 * ```
 *
 * 存 **原始 gz 二进制**而非解压后的字符串：《从零开始》22.36 MB vs 39.16 MB，省 43%，
 * 代价是每次从缓存打开多约 126 ms 解压（附录 M1）。
 *
 * v1 存的是解压后文本，键值结构与语义都变了，`onupgradeneeded` 里**直接删库重建**而不做
 * 迁移——缓存是可再生数据，迁移的代码量与风险都不值得（design §8.1）。
 *
 * ## 职责边界
 *
 * 本模块只提供 open / read / write / touch / delete / list / clear 这几个原语，**不含淘汰
 * 策略**：本数 LRU 与配额降级是任务 47 的事，缓存命中后的解压是任务 48 的事，占用显示与
 * 一键清空是任务 50 的事。策略留在上层，这里只负责"存得下、取得出、列得清"。
 *
 * ## 错误处理：读静默、写抛出（design §10）
 *
 * IndexedDB 不可用或配额满时，阅读**不得**中断，所以读路径（`readCachedBook`、
 * `listCachedBooks`）一律吞掉异常并返回"没有缓存"，调用方不需要写 try/catch。
 * 写路径（`writeCachedBook`、`deleteCachedBook`、`clearCachedBooks`、`touchCachedBook`）
 * 则把原始异常抛出去——任务 47 必须能从异常里认出配额错误，才能决定"淘汰一本再重试"还是
 * "降级为仅内存缓存"。把写失败也静默掉就等于把那条决策依据删了。
 */

const DB_NAME = "koodo_novel_cache_db";
const DB_VERSION = 2;
const STORE_NAME = "books";

/** LRU 索引名。 */
const LRU_INDEX = "by_lastAccess";

/**
 * LRU 索引的复合 keyPath。
 *
 * 为什么不是单字段 `lastAccess`：IndexedDB 没有"只取部分字段"的查询，用主键游标读记录会把
 * `gz` 一并反序列化进内存——10 本最大书就是 200 MB 以上，而任务 47 的淘汰决策和任务 50 的
 * 占用显示只需要元数据。复合索引的**索引键本身**就带着这三个数值，于是 `openKeyCursor()`
 * 在完全不触碰 `gz` 的前提下就能凑出整条元数据（`cursor.primaryKey` 给出 bookId）。
 *
 * 顺序有意义：`lastAccess` 放第一位，索引游标的默认升序即"最久未访问在前"，任务 47 的
 * 淘汰顺序不需要额外排序。后两位纯粹是为了让 key-only 读取够用，不参与排序语义。
 */
export const LRU_KEY_PATH = ["lastAccess", "bytes", "cachedAt"] as const;

/** 缓存记录：一本书的原始 gz 加三个元数据字段。 */
export interface CachedBookRecord {
  /** 书籍 id，同时是主键。 */
  bookId: string;
  /** 原始 gz 二进制，未解压。 */
  gz: ArrayBuffer;
  /** `gz.byteLength`，冗余存一份是为了不读 gz 也能算占用（需求 4.5）。 */
  bytes: number;
  /** 最近一次访问时间（`Date.now()`），LRU 的排序键（需求 4.3）。 */
  lastAccess: number;
  /** 首次写入时间（`Date.now()`）。 */
  cachedAt: number;
}

/**
 * 不含 `gz` 的元数据视图。任务 47 的淘汰决策与任务 50 的占用显示都只要这一层，
 * 拿它就不必把几十 MB 的二进制读进内存。
 */
export type CachedBookMeta = Omit<CachedBookRecord, "gz">;

/** IndexedDB 在当前宿主不可用时，`openCacheDB` 抛出的错误类型。 */
export class CacheUnavailableError extends Error {
  constructor(message = "IndexedDB 不可用") {
    super(message);
    this.name = "CacheUnavailableError";
  }
}

/** 当前宿主是否有 IndexedDB（SSR、隐私模式、老浏览器都可能没有）。 */
export function isCacheSupported(): boolean {
  return typeof indexedDB !== "undefined" && indexedDB !== null;
}

/**
 * 依据 gz 二进制拼出一条完整记录。
 *
 * `bytes` 由 `gz.byteLength` 派生而不接受调用方传值：这是唯一的真相来源，允许外部传入就
 * 迟早出现"占用显示与实际不符"。两个时间戳初始相同——`cachedAt` 之后不再变，`lastAccess`
 * 由 `touchCachedBook` 推进。
 */
export function createCachedBookRecord(
  bookId: string,
  gz: ArrayBuffer,
  now: number = Date.now()
): CachedBookRecord {
  return {
    bookId,
    gz,
    bytes: gz.byteLength,
    lastAccess: now,
    cachedAt: now,
  };
}

/**
 * 把 LRU 索引游标的一对键还原成元数据。
 *
 * 纯函数，与 IndexedDB 无关，因此能在 Node 下直接单测——它正是那种"顺序写错了类型检查毫无
 * 察觉，症状却是淘汰错书"的地方（design §11）。形状不符时返回 `null` 而不是抛错：真出现
 * 手工改过的脏记录，跳过它继续列出其余的，比让整个列表失败更符合"缓存可再生"的定位。
 */
export function cacheMetaFromIndexKey(
  indexKey: unknown,
  primaryKey: unknown
): CachedBookMeta | null {
  if (typeof primaryKey !== "string" || primaryKey === "") return null;
  if (!Array.isArray(indexKey) || indexKey.length !== LRU_KEY_PATH.length) return null;

  const [lastAccess, bytes, cachedAt] = indexKey as unknown[];
  if (
    typeof lastAccess !== "number" ||
    typeof bytes !== "number" ||
    typeof cachedAt !== "number"
  ) {
    return null;
  }

  return { bookId: primaryKey, bytes, lastAccess, cachedAt };
}

/**
 * 缓存的数据库连接。
 *
 * 连接复用省掉每次操作的 open 往返；失败时立刻清空，使下一次调用能重新尝试而不是永久记住
 * 一个失败的 Promise。
 */
let dbPromise: Promise<IDBDatabase> | null = null;

/** 删掉现存的全部 store 再建新的 `books`——即 design §8.1 说的"删库重建"。 */
function recreateStore(db: IDBDatabase): void {
  for (const name of Array.from(db.objectStoreNames)) {
    db.deleteObjectStore(name);
  }

  const store = db.createObjectStore(STORE_NAME, { keyPath: "bookId" });
  store.createIndex(LRU_INDEX, [...LRU_KEY_PATH], { unique: false });
}

/**
 * 打开（或复用）缓存库。不可用时 reject，由调用方决定是静默降级还是上抛。
 *
 * `onblocked` 必须处理：另一个标签页仍持着 v1 连接时升级会被阻塞，此时 success 与 error
 * 都不会触发，不接这个事件就是一个永远 pending 的 Promise 挂在加载链路上——那等于让阅读卡
 * 死，直接违反 §10 的"阅读不中断"。这里 reject 让本次会话降级为仅内存缓存，升级会在对方
 * 标签页关闭后自然完成。
 */
function openCacheDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  if (!isCacheSupported()) {
    return Promise.reject(new CacheUnavailableError());
  }

  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => recreateStore(request.result);

    request.onsuccess = () => {
      const db = request.result;

      // 别的标签页要升级版本时让出连接，否则对方会一直 blocked。
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      db.onclose = () => {
        dbPromise = null;
      };

      resolve(db);
    };

    request.onerror = () =>
      reject(request.error ?? new CacheUnavailableError("IndexedDB 打开失败"));
    request.onblocked = () =>
      reject(new CacheUnavailableError("IndexedDB 升级被其他标签页阻塞"));
  });

  dbPromise = pending;
  pending.catch(() => {
    if (dbPromise === pending) dbPromise = null;
  });

  return pending;
}

/** 把一次请求包成 Promise。 */
function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB 请求失败"));
  });
}

/**
 * 等一次写事务真正落盘。
 *
 * 写路径等的是**事务**而不是请求：配额不足这类失败是以请求出错→事务 abort 的形式到达的，
 * 只等 `request.onsuccess` 会在事务还没提交时就当成功返回，任务 47 也就抓不到那个
 * `QuotaExceededError`。
 */
function promisifyTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB 事务被中止"));
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB 事务失败"));
  });
}

/** 取一本书的缓存记录；没有、或缓存整体不可用时返回 `null`。 */
export async function readCachedBook(bookId: string): Promise<CachedBookRecord | null> {
  try {
    const db = await openCacheDB();
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).get(bookId) as IDBRequest<
      CachedBookRecord | undefined
    >;
    return (await promisifyRequest(request)) ?? null;
  } catch {
    return null;
  }
}

/**
 * 写入（或覆盖）一条记录。**失败会抛出**，异常对象原样上抛供任务 47 判别配额错误。
 *
 * 本函数不做任何淘汰：写入前腾位置是任务 47 的职责。
 */
export async function writeCachedBook(record: CachedBookRecord): Promise<void> {
  const db = await openCacheDB();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const done = promisifyTransaction(tx);

  // 请求自身的 error 不单独接：让它冒泡成事务 abort，由 `done` 统一报出同一个错误对象。
  tx.objectStore(STORE_NAME).put(record);

  await done;
}

/**
 * 推进 `lastAccess`（任务 48 会在缓存命中时调用）。记录已不在时静默跳过。
 *
 * 代价说明：`lastAccess` 住在记录内部（§8.1 的形状），所以这是一次整条记录的重写，最大书
 * 约 22 MB。10 本的量级下每次打开多一次本地写入可以接受，且调用方可以 fire-and-forget，
 * 不占用打开书的关键路径。用游标 `update` 而不是先 `get` 再 `put`，省掉一次往返。
 */
export async function touchCachedBook(
  bookId: string,
  at: number = Date.now()
): Promise<void> {
  const db = await openCacheDB();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const done = promisifyTransaction(tx);

  const cursorRequest = tx.objectStore(STORE_NAME).openCursor(bookId);
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result;
    if (!cursor) return; // 已被淘汰：不重建，交给调用方下次写入
    const record = cursor.value as CachedBookRecord;
    cursor.update({ ...record, lastAccess: at });
  };

  await done;
}

/** 删除一本书的缓存。失败抛出——任务 47 的淘汰需要知道有没有真腾出位置。 */
export async function deleteCachedBook(bookId: string): Promise<void> {
  const db = await openCacheDB();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const done = promisifyTransaction(tx);

  tx.objectStore(STORE_NAME).delete(bookId);

  await done;
}

/**
 * 列出全部缓存的元数据，**按 `lastAccess` 升序**（最久未访问在最前）。
 *
 * 走 LRU 索引的 key-only 游标，全程不反序列化 `gz`（见 `LRU_KEY_PATH` 的说明）。
 * 任务 47 直接从头部取淘汰对象，任务 50 用 `length` 与 `bytes` 之和做显示。
 * 缓存不可用时返回空数组——"列不出来"与"没缓存"对调用方是同一种处理。
 */
export async function listCachedBooks(): Promise<CachedBookMeta[]> {
  try {
    const db = await openCacheDB();
    const tx = db.transaction(STORE_NAME, "readonly");
    const index = tx.objectStore(STORE_NAME).index(LRU_INDEX);

    return await new Promise<CachedBookMeta[]>((resolve, reject) => {
      const metas: CachedBookMeta[] = [];
      const request = index.openKeyCursor();

      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve(metas);
          return;
        }
        const meta = cacheMetaFromIndexKey(cursor.key, cursor.primaryKey);
        if (meta) metas.push(meta);
        cursor.continue();
      };

      request.onerror = () =>
        reject(request.error ?? new Error("IndexedDB 游标读取失败"));
    });
  } catch {
    return [];
  }
}

/** 清空全部缓存（需求 4.5 的一键清空）。失败抛出，便于 UI 提示。 */
export async function clearCachedBooks(): Promise<void> {
  const db = await openCacheDB();
  const tx = db.transaction(STORE_NAME, "readwrite");
  const done = promisifyTransaction(tx);

  tx.objectStore(STORE_NAME).clear();

  await done;
}
