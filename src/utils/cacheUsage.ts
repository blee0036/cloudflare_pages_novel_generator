/**
 * 离线缓存占用的**呈现层算术**（需求 4.5，design §8.2 末段）。
 *
 * 只有两件事：把元数据列表加成「几本 + 多少字节」，以及把字节数写成人能读的形式。
 * 抽成独立模块而不写在 `SettingDrawer` 里，是因为这两段是纯算术——求和会遇到脏 `bytes`、
 * 单位换算有边界，都属于"算错了 typecheck 一无所知"的地方，而组件测试明确不在范围内
 * （design §11）。留在这里它们就能被直接单测。
 *
 * ## 为什么不复用 `loadMetrics.ts` 里的 `formatBytes`
 *
 * 那个是模块私有的**日志**格式化器：字段缺失写 `n/a`、保留两位小数（为的是在日志里分辨
 * 11.77MB 与 11.8MB）。把它导出给 UI 用，等于让一条控制台日志的格式和设置抽屉里的文案
 * 共用一个契约——以后任一侧想改精度都会牵动另一侧。这里的口径不同：面向读者、一位小数、
 * 与书架卡片上已有的 `(gzSize / 1024 / 1024).toFixed(1)}MB` 对齐，且空缓存要显示 `0B`
 * 而不是 `n/a`。两个二十行的函数各管一处，比一个要同时满足两种口径的共享函数更省事。
 */

import { CachedBookMeta } from "./indexedDB";

/** 缓存占用的汇总结果。 */
export interface CacheUsage {
  /** 已缓存的书本数。 */
  count: number;
  /** 占用字节数之和。 */
  bytes: number;
}

/**
 * 把 `listCachedBooks()` 的元数据加成「本数 + 总字节」。
 *
 * `bytes` 非有限数或为负时**只跳过它的字节贡献，仍计入本数**：记录确实在库里占着一个
 * LRU 位置，本数得如实报；而它的字节数不可信，加进去会让整个总数变成 `NaN`，把一句
 * "占用 11.8MB" 变成 "占用 0B"。这条路径不是假想——`cacheMetaFromIndexKey` 的
 * `typeof x === "number"` 挡不住 `NaN`，手改过的记录能原样穿过存储层到这里。
 */
export function summarizeCacheUsage(metas: CachedBookMeta[]): CacheUsage {
  let bytes = 0;
  for (const meta of metas) {
    if (Number.isFinite(meta.bytes) && meta.bytes > 0) bytes += meta.bytes;
  }
  return { count: metas.length, bytes };
}

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

/**
 * 字节数的人读形式：`0B` / `512B` / `1.5KB` / `11.8MB` / `1.2GB`。
 *
 * 不带空格、一位小数，与书架卡片和详情弹窗上已有的体积文案保持一致（需求 6.4 的精神：
 * 不为新增一处显示引入第二种写法）。非法值与负数一律当 `0B`——设置抽屉里没有"未知"这个
 * 语义可显示，而脏数据的正确呈现是"看起来没占地方"，不是一个突兀的 `n/a`。
 *
 * GB 档留着是因为上限可调到 50 本（`MAX_MAX_BOOKS`），50 本大书确实能越过 1GB；
 * 再往上不设档：比 GB 更大的量级在浏览器配额下不会出现。
 */
export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0B";
  if (bytes < KB) return `${Math.round(bytes)}B`;
  if (bytes < MB) return `${(bytes / KB).toFixed(1)}KB`;
  if (bytes < GB) return `${(bytes / MB).toFixed(1)}MB`;
  return `${(bytes / GB).toFixed(1)}GB`;
}
