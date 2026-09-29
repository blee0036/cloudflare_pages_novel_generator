/**
 * 离线缓存的**策略层**：本数 LRU 淘汰与配额降级（需求 4.2/4.3/4.4/4.6，design §8.2）。
 *
 * 分工：`utils/indexedDB.ts` 是存储层，只管"存得下、取得出、列得清"；本模块决定**写之前
 * 先删谁**、以及**写不进去时怎么继续正常阅读**。任务 48 的 `decompress.ts` 只需要调
 * `putCachedBook(bookId, gz)`，不必知道淘汰与降级的存在。
 *
 * ## 为什么按本数而不按字节总量
 *
 * "最近打开的 10 本"是读者能理解的语义；字节层面已经有浏览器配额兜住了，再加一个人为的
 * 总量上限就是第二个控制维度——两个维度会互相打架（本数没超但字节超了，该淘汰吗？），
 * 而且那条逻辑平时不跑、无人测试。需求 4.6 明确不设人为字节上限，配额不足由本模块的降级
 * 路径处理（这条路径每次配额真满时都会跑，不会腐烂成死代码）。
 *
 * ## 三条不变式
 *
 * 1. **写入后本数不超过上限**：写之前把「除目标书之外」的记录淘汰到 `maxBooks - 1`
 *    （design §8.2 的 `evictUntil(MAX_BOOKS - 1)`）。
 * 2. **配额失败只重试一次**：淘汰最久未访问的一本 → 重试 → 仍失败就降级。不做循环重试：
 *    比配额还大的单本书（《从零开始》22.36 MB）无论淘汰多少本都写不进去，循环只是把失败
 *    拖长到读者能感觉到。
 * 3. **`putCachedBook` 永不抛出**。缓存是可再生数据，写不进去的唯一后果是"下次打开要重新
 *    下载"，绝不能让它中断阅读（需求 4.4、design §10）。
 *
 * ## 降级闩（memory-only latch）
 *
 * 一旦判定写不进去，本会话内不再尝试写 IndexedDB。原因是代价不对称：一次失败的写入要把
 * 几十 MB 二进制送进事务再被 abort，而成功的可能性在同一会话里几乎没变。闩**只拦写路径**，
 * 读路径继续走 IndexedDB——读已经是静默失败的（存储层保证），命中了纯属净赚。
 * 任务 50 的一键清空会腾出空间，所以那里要走 `clearBookCache()` 顺手解闩。
 *
 * ## 上限存在哪里
 *
 * 存进 `ReaderSettings.cacheMaxBooks`（localStorage 的 `koodo_novel_reader_settings`），
 * 不另开一个键。理由：需求 4.2 要求"可在设置中调整"，而设置抽屉（任务 50）手里已经有
 * `ReaderSettings` 与它的持久化通路（`storage.ts` 的白名单 `pickSettings`），另开一个键
 * 就要再写一遍读取、写入、默认值与旧值兼容四段代码，换来的只是类型上的洁癖。代价是
 * `ReaderSettings` 从"排版设置"扩宽成了"阅读器设置"，已在类型定义处注明。
 *
 * 校验放在**用处**而不是存储处：`getStoredSettings()` 只做浅合并、不校验数值，手改过的
 * localStorage 完全可能给出 `-1` 或 `"十本"`，而淘汰计算不能接受脏值，所以每次用都过一遍
 * `normalizeMaxBooks`。
 */

import {
  CachedBookMeta,
  CachedBookRecord,
  clearCachedBooks,
  createCachedBookRecord,
  deleteCachedBook,
  listCachedBooks,
  writeCachedBook,
} from "./indexedDB";
import { getStoredSettings } from "./storage";

/** 缓存本数上限的默认值（需求 4.2）。 */
export const DEFAULT_MAX_BOOKS = 10;

/**
 * 上限的可调范围，供任务 50 的滑杆直接使用。
 *
 * 下限取 1 而不是 0：0 等于"关闭持久缓存"，那是个功能开关而不是容量上限，需求里没有它，
 * 加了就得同时回答"关闭时要不要清掉已缓存的书"。上限取 50 是个软性护栏——真把 50 本大书
 * 塞进去会先撞上浏览器配额，那时走的是本模块的降级路径，而不是又一个人为字节阈值（需求 4.6）。
 */
export const MIN_MAX_BOOKS = 1;
export const MAX_MAX_BOOKS = 50;

/** 一次写入的结局。 */
export type CachePutStatus =
  /** 写入成功（`evicted` 里是为腾位置而正常淘汰的书）。 */
  | "written"
  /** 撞上配额 → 淘汰最久未访问的一本 → 重试成功（需求 4.4 前半句）。 */
  | "evicted-and-written"
  /** 本次写入失败并就此降级为仅内存缓存（需求 4.4 后半句）。 */
  | "degraded"
  /** 此前已降级，本次直接跳过，未触碰存储。 */
  | "skipped";

export interface CachePutResult {
  status: CachePutStatus;
  /** 本次实际删掉的书（按淘汰顺序），供日志与人工核对。 */
  evicted: string[];
  /** 导致降级的原始错误，仅 `status === "degraded"` 时有值。 */
  error?: unknown;
}

/**
 * 本模块用到的存储原语。默认实现就是 `utils/indexedDB.ts`，抽成接口只为一件事：
 * 让淘汰顺序、重试一次、降级闩这三段状态机能在 Node 下被直接单测（design §11 要求单测不
 * 碰 DOM，而 IndexedDB 在 Node 里根本不存在）。生产路径永远走 `defaultStore`。
 */
export interface CacheStore {
  list(): Promise<CachedBookMeta[]>;
  write(record: CachedBookRecord): Promise<void>;
  remove(bookId: string): Promise<void>;
}

const defaultStore: CacheStore = {
  list: listCachedBooks,
  write: writeCachedBook,
  remove: deleteCachedBook,
};

export interface CachePutOptions {
  /** 覆盖本数上限。省略时取 `ReaderSettings.cacheMaxBooks`。 */
  maxBooks?: number;
  /** 覆盖存储层（仅测试用）。 */
  store?: CacheStore;
  /** 写入时刻，透传给 `createCachedBookRecord`。 */
  now?: number;
}

/**
 * 降级闩。模块级单例：它描述的是"本会话的 IndexedDB 写不进去"这一宿主事实，
 * 与哪本书无关，所以不该跟着某个组件的生命周期走。
 */
let memoryOnly = false;

/** 是否已降级为仅内存缓存。任务 50 可以据此提示"本次会话未使用离线缓存"。 */
export function isCacheDegraded(): boolean {
  return memoryOnly;
}

/** 解除降级闩。清空缓存后（空间已腾出）与单测之间需要它。 */
export function resetCacheDegradation(): void {
  memoryOnly = false;
}

/**
 * 把任意值规范成合法的本数上限：非数字、NaN、越界、小数一律收拢到 `[1, 50]` 的整数。
 *
 * 纯函数，配合下面的 `planCacheEviction` 构成本模块可单测的那一半。
 */
export function normalizeMaxBooks(
  value: unknown,
  fallback: number = DEFAULT_MAX_BOOKS
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(MAX_MAX_BOOKS, Math.max(MIN_MAX_BOOKS, Math.floor(value)));
}

/** 当前生效的上限（读设置 + 规范化）。 */
export function currentMaxBooks(): number {
  return normalizeMaxBooks(getStoredSettings().cacheMaxBooks);
}

const QUOTA_ERROR_NAMES = new Set(["QuotaExceededError", "NS_ERROR_DOM_QUOTA_REACHED"]);

/**
 * `DOMException` 的历史遗留数字码：22 是 `QUOTA_EXCEEDED_ERR`，
 * 1014 是 Firefox 的 `NS_ERROR_DOM_QUOTA_REACHED`。
 */
const QUOTA_ERROR_CODES = new Set([22, 1014]);

/**
 * 判断一个错误是否"配额不足"——即需求 4.4 那条"先淘汰再重试"值得一试的唯一情形。
 *
 * 必须三种写法都认，因为浏览器报法不统一：现代浏览器给 `name === "QuotaExceededError"`
 * 的 `DOMException`；老实现只有数字 `code`（22 / 1014）；Firefox 的历史名字是
 * `NS_ERROR_DOM_QUOTA_REACHED`。只认其中一种，在另一种浏览器上的症状是"配额满了却直接
 * 降级、一本都不淘汰"——缓存永久失效而且无人察觉。
 *
 * 判错方向的取舍：认宽一点无害（多删一本最久未访问的书，缓存本就可再生），认窄了才伤，
 * 所以最后还留了一层 `message` 里带 "quota" 的兜底，接住被包装过、丢了 `name` 的错误。
 * 反过来，`CacheUnavailableError`（IndexedDB 根本不可用）不会命中任何一条——它确实不是
 * 配额问题，淘汰再重试也救不回来，该直接降级。
 *
 * 纯函数，宿主无关，可直接单测。
 */
export function isQuotaExceeded(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;

  const e = error as { name?: unknown; code?: unknown; message?: unknown };

  if (typeof e.name === "string" && QUOTA_ERROR_NAMES.has(e.name)) return true;
  // 只认数字 code：Node 风格的错误用字符串 code（"ENOENT"），不该被 22 误伤。
  if (typeof e.code === "number" && QUOTA_ERROR_CODES.has(e.code)) return true;

  return typeof e.message === "string" && /quota/i.test(e.message);
}

/**
 * 按 LRU 顺序（最久未访问在前）列出可淘汰的书 id，`keepBookId` 被排除在外。
 *
 * 排除目标书有两个作用：① 覆盖写同一本时不会先把它删掉再写回去（白跑一轮几十 MB 的删+写）；
 * ② 它让"写入后本数不超上限"的计算变成"其余书不超 `max - 1`"，见 `planCacheEviction`。
 *
 * 虽然 `listCachedBooks()` 已按 `lastAccess` 升序返回，这里仍显式排序：本函数是纯函数，
 * 结论不该依赖调用方的输入顺序；同刻的记录再按 id 排，使淘汰对象稳定可断言。
 */
export function lruCandidates(metas: CachedBookMeta[], keepBookId?: string): string[] {
  return metas
    .filter((m) => m.bookId !== keepBookId)
    .slice()
    .sort((a, b) => a.lastAccess - b.lastAccess || (a.bookId < b.bookId ? -1 : 1))
    .map((m) => m.bookId);
}

/**
 * 算出为了给 `bookId` 腾出位置该淘汰哪些书（需求 4.3，design §8.2 的 `evictUntil`）。
 * 纯函数，返回按淘汰顺序（最久未访问在前）排列的 id。
 *
 * 口径是「除目标书之外的记录 ≤ maxBooks - 1」：
 * - 目标书**不在**缓存里 → 其余 10 本、上限 10 → 淘汰 1 本 → 写完正好 10 本。
 * - 目标书**已在**缓存里（覆盖写）→ 其余 9 本、上限 10 → 不淘汰 → 写完仍是 10 本。
 *
 * 若换成"总数 ≤ maxBooks - 1"，第二种情况会白白淘汰一本；若换成"总数 ≤ maxBooks"，
 * 第一种情况写完就是 11 本。这两个差一位都不会被类型检查发现，症状是缓存缓慢地越界或
 * 反复重下——所以它有单测。
 */
export function planCacheEviction(
  metas: CachedBookMeta[],
  bookId: string,
  maxBooks: number = DEFAULT_MAX_BOOKS
): string[] {
  const candidates = lruCandidates(metas, bookId);
  const keepSlots = normalizeMaxBooks(maxBooks) - 1;
  const overflow = candidates.length - keepSlots;

  return overflow > 0 ? candidates.slice(0, overflow) : [];
}

/**
 * 把一本书的原始 gz 写进持久缓存，带本数 LRU 与配额降级（design §8.2）。
 *
 * **永不抛出**，也永不阻塞阅读：调用方可以 `void putCachedBook(...)` 发出去不管结果，
 * 想记日志就看返回的 `status`。
 *
 * 流程即需求 4.3 + 4.4：淘汰到 `maxBooks - 1` → 写；撞配额则淘汰最久未访问的一本再写一次；
 * 还不行就落闩降级，本会话此后只用内存缓存。
 *
 * 一处有意的简化：淘汰阶段自身失败（删不掉）时不再尝试写入，直接按失败处理。理由是删不掉
 * 通常意味着存储层整体有问题，紧跟着的写入大概率也失败，而多试一次要多送一遍几十 MB 数据。
 *
 * 另一处：多本书同时 put 不加锁。阅读器一次只打开一本书，真撞上的后果也只是多淘汰一本
 * （缓存可再生），不值得为它引入一条串行队列。
 */
export async function putCachedBook(
  bookId: string,
  gz: ArrayBuffer,
  options: CachePutOptions = {}
): Promise<CachePutResult> {
  if (memoryOnly) return { status: "skipped", evicted: [] };

  const store = options.store ?? defaultStore;
  const maxBooks = normalizeMaxBooks(options.maxBooks ?? currentMaxBooks());
  const evicted: string[] = [];

  try {
    for (const victim of planCacheEviction(await store.list(), bookId, maxBooks)) {
      await store.remove(victim);
      evicted.push(victim);
    }

    await store.write(createCachedBookRecord(bookId, gz, options.now));
    return { status: "written", evicted };
  } catch (error) {
    if (isQuotaExceeded(error)) {
      const retried = await evictOldestAndRetry(store, bookId, gz, options, evicted);
      if (retried) return { status: "evicted-and-written", evicted };
    }

    memoryOnly = true;
    return { status: "degraded", evicted, error };
  }
}

/**
 * 配额失败后的唯一一次重试：淘汰最久未访问的一本，再写一次（需求 4.4）。
 *
 * 没有可淘汰的书时直接放弃而不重试——那说明这一本自己就比剩余配额大（《从零开始》22.36 MB
 * 就有这个量级），重试只会原样失败一次，白等一轮几十 MB 的写入。
 *
 * @returns 是否写成功。失败原因一律吞掉：调用方要报的是**第一次**那个配额错误，
 *   它才说明降级的真正缘由。
 */
async function evictOldestAndRetry(
  store: CacheStore,
  bookId: string,
  gz: ArrayBuffer,
  options: CachePutOptions,
  evicted: string[]
): Promise<boolean> {
  try {
    const [oldest] = lruCandidates(await store.list(), bookId);
    if (oldest === undefined) return false;

    await store.remove(oldest);
    evicted.push(oldest);

    await store.write(createCachedBookRecord(bookId, gz, options.now));
    return true;
  } catch {
    return false;
  }
}

/**
 * 清空持久缓存并解除降级闩（需求 4.5 的一键清空，任务 50 的按钮走这里）。
 *
 * 之所以不让 UI 直接调存储层的 `clearCachedBooks()`：空间刚被腾出来，此时不解闩，
 * 本会话剩下的时间里缓存仍然是关着的——读者点了"清空"，得到的却是"缓存彻底不工作了"。
 *
 * 失败照常抛出（存储层语义），便于 UI 提示；此时空间没腾出来，闩也就该保持原状。
 */
export async function clearBookCache(): Promise<void> {
  await clearCachedBooks();
  resetCacheDegradation();
}
