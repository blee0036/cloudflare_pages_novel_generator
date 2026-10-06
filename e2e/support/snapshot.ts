/**
 * `public/` 起止快照（设计"public/ 快照（4.5、4.8）"；需求 4.5、4.8）。
 *
 * globalSetup 在运行 Fixture_Generator 与构建 App_Build 之前取开始快照，reporter 在 `onEnd`
 * 开头取结束快照（中止的运行同样取），两者经 `diffSnapshots` 比对，任何差异都记为运行级失败。
 *
 * 快照范围与取法：
 * - `<root>/public/` 下递归的全部非目录条目，加上 `<root>/.preprocess-manifest.json`。`root`
 *   是"含 `public/` 与 `.preprocess-manifest.json` 的目录"，默认即仓库根；测试（任务 6.3）传入
 *   临时目录，在其中自建 `public/` 与清单文件。
 * - 键为相对 `root`、以 `/` 分隔的路径，如 `public/books/xxx.txt.gz`；清单文件的键为
 *   `.preprocess-manifest.json`。`files` 的键按 UTF-16 码元序（`Array#sort` 默认序）排列。
 * - 只调用 `opendir` 与 `lstat(p, { bigint: true })`，只取 `size` 与 `mtimeNs`，不打开、不读取
 *   任何文件内容，不改变任何文件的元数据。`mtimeNs` 保留文件系统报告的完整精度（NTFS 为
 *   100 ns），比较时按十进制串逐字比较，不做取整（4.8）。
 * - 不跟随符号链接：目录项是符号链接或 Windows junction 时只记录链接本身的 `lstat`，
 *   不进入其目标。`public` 本身若存在但不是真实目录（文件、符号链接、junction），快照直接
 *   失败，因为此时既无法在不跟随链接的前提下覆盖书库，也不应悄悄只记一个链接条目。
 * - 目录本身不作为条目记录（需求只要求文件）；空目录的增删不会出现在差异中，目录内文件的
 *   增删则以 `added` / `removed` 出现。
 *
 * 不存在的情形：
 * - `.preprocess-manifest.json` 不存在时 `files` 中没有这个键；运行期间被创建或删除时，差异里
 *   相应地出现 `added` 或 `removed`。
 * - `public/` 不存在时（例如只跑 `fixture` 的全新克隆，`public/` 被 gitignore）不记录任何
 *   `public/` 条目，同样由差异发现运行期间的新增。
 * - 遍历途中条目或子目录消失（`ENOENT`）时跳过它：快照反映的是遍历时刻的状态，与开始快照
 *   比对时照样显示为 `removed`。其余任何错误（`EACCES`、`EPERM` 等）都让 `takeSnapshot`
 *   整体 reject，由调用方按"快照失败"处理。
 *
 * 规模与并发：真实书库约 2.3 万个文件、21 GiB，全部在 `public/books/` 一层。遍历逐层进行，
 * 同时打开的目录不超过 `DIR_CONCURRENCY` 个，同时在途的 `lstat` 不超过 `STAT_CONCURRENCY` 个
 * （libuv 线程池默认 4 个线程，更高的并发只会排队）。Windows 长路径无须特别处理：Node 的 fs
 * 在调用前把绝对路径转成 `\\?\` 命名空间形式，超过 260 字符的路径同样可用。
 */
import type { BigIntStats, Dir } from "node:fs";
import { lstat, mkdir, opendir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 仓库根（本文件位于 `e2e/support/`）。 */
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** 快照根下被递归记录的目录名，也是其条目键的前缀。 */
const PUBLIC_DIR = "public";
/** 预处理清单文件的键，也是它相对快照根的路径。 */
export const MANIFEST_KEY = ".preprocess-manifest.json";

/** 同时打开的目录数上限。 */
const DIR_CONCURRENCY = 4;
/** 同时在途的 `lstat` 数上限。 */
const STAT_CONCURRENCY = 32;
/** `opendir` 每批从系统读取的目录项数（默认 32；`public/books/` 一层就有 2 万余项）。 */
const DIR_BUFFER_SIZE = 256;

/** globalSetup 写入的开始快照（4.5）。 */
export const SNAPSHOT_START_FILE = path.join(REPO_ROOT, "e2e", ".out", "public-snapshot-start.json");
/** reporter 在 `onEnd` 写入的结束快照（4.5）。 */
export const SNAPSHOT_END_FILE = path.join(REPO_ROOT, "e2e", ".out", "public-snapshot-end.json");

/** 单个条目的元数据；bigint 转十进制串，保全精度。 */
export interface FileStat {
  size: string;
  mtimeNs: string;
}

export interface Snapshot {
  /** 开始遍历的时刻，ISO 8601（UTC）。 */
  takenAt: string;
  /** 快照根的绝对路径。 */
  root: string;
  /** 键为相对 `root` 的 `/` 分隔路径，按 UTF-16 码元序排列。 */
  files: Record<string, FileStat>;
  /** `files` 的键数。 */
  count: number;
  /** 取快照耗时（毫秒，取整）。 */
  ms: number;
}

export type DiffKind = "added" | "removed" | "size" | "mtime";

export interface SnapshotDiffEntry {
  path: string;
  /** `added` 与 `removed` 单独出现；同一路径大小与修改时间都变时依次含 `size`、`mtime`。 */
  kinds: DiffKind[];
}

export interface SnapshotDiff {
  /** 有差异的路径数（按路径计，一个路径多种差异只算一次）。 */
  total: number;
  /** 按路径的 UTF-16 码元序严格递增，无重复。 */
  entries: SnapshotDiffEntry[];
}

/** Run_Summary 中差异类型的写法（4.8：新增 / 删除 / 大小变化 / 修改时间变化）。 */
export const DIFF_KIND_LABEL: Readonly<Record<DiffKind, string>> = {
  added: "新增",
  removed: "删除",
  size: "大小变化",
  mtime: "修改时间变化",
};

interface Entry {
  /** 绝对路径。 */
  abs: string;
  /** 相对快照根的 `/` 分隔路径。 */
  key: string;
}

function isErrno(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && (err as NodeJS.ErrnoException).code === code;
}

function toFileStat(st: BigIntStats): FileStat {
  return { size: st.size.toString(), mtimeNs: st.mtimeNs.toString() };
}

/** `lstat`（bigint）；路径不存在时返回 null，其余错误照常抛出。 */
async function lstatOrNull(abs: string): Promise<BigIntStats | null> {
  try {
    return await lstat(abs, { bigint: true });
  } catch (err) {
    if (isErrno(err, "ENOENT")) return null;
    throw err;
  }
}

/** `opendir`；目录已不存在时返回 null，其余错误照常抛出。 */
async function opendirOrNull(abs: string): Promise<Dir | null> {
  try {
    return await opendir(abs, { bufferSize: DIR_BUFFER_SIZE });
  } catch (err) {
    if (isErrno(err, "ENOENT")) return null;
    throw err;
  }
}

/**
 * 以不超过 `limit` 的并发对 `items` 逐个执行 `fn`。任一次失败即不再领取新项，
 * 等在途的调用结束后以第一个错误 reject。
 */
async function forEachLimit<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const item = items[next++];
      try {
        await fn(item);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  const results = await Promise.allSettled(workers);
  const rejected = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  if (rejected) throw rejected.reason;
}

/**
 * 对 `<root>/public/` 递归与 `<root>/.preprocess-manifest.json` 取一次元数据快照（4.5）。
 *
 * @param root 含 `public/` 与 `.preprocess-manifest.json` 的目录，默认仓库根。
 * @throws `public` 存在但不是真实目录时，或遍历中遇到 `ENOENT` 以外的任何文件系统错误时。
 */
export async function takeSnapshot(root: string = REPO_ROOT): Promise<Snapshot> {
  const absRoot = path.resolve(root);
  const takenAt = new Date().toISOString();
  const t0 = performance.now();
  const found = new Map<string, FileStat>();

  const manifest = await lstatOrNull(path.join(absRoot, MANIFEST_KEY));
  if (manifest) found.set(MANIFEST_KEY, toFileStat(manifest));

  const publicAbs = path.join(absRoot, PUBLIC_DIR);
  const publicStat = await lstatOrNull(publicAbs);
  let level: Entry[] = [];
  if (publicStat) {
    if (!publicStat.isDirectory()) {
      throw new Error(
        `${publicAbs} 存在但不是目录（文件、符号链接或 junction）；快照不跟随符号链接，无法覆盖 public/`,
      );
    }
    level = [{ abs: publicAbs, key: PUBLIC_DIR }];
  }

  while (level.length > 0) {
    const nextLevel: Entry[] = [];
    const others: Entry[] = [];

    // 读本层全部目录：目录项的类型来自 readdir 本身（不跟随链接），
    // 目录进下一层，其余（文件、符号链接、junction、类型未知）留待 lstat。
    await forEachLimit(level, DIR_CONCURRENCY, async (dir) => {
      const handle = await opendirOrNull(dir.abs);
      if (!handle) return;
      // for await 在迭代结束或抛错时自动关闭目录句柄
      for await (const dirent of handle) {
        const child: Entry = { abs: path.join(dir.abs, dirent.name), key: `${dir.key}/${dirent.name}` };
        (dirent.isDirectory() ? nextLevel : others).push(child);
      }
    });

    await forEachLimit(others, STAT_CONCURRENCY, async (entry) => {
      const st = await lstatOrNull(entry.abs);
      if (!st) return;
      // readdir 报不出类型的条目以 lstat 为准；lstat 不跟随链接，这里只可能是真实目录
      if (st.isDirectory()) nextLevel.push(entry);
      else found.set(entry.key, toFileStat(st));
    });

    level = nextLevel;
  }

  const files: Record<string, FileStat> = {};
  for (const key of [...found.keys()].sort()) {
    files[key] = found.get(key) as FileStat;
  }
  return { takenAt, root: absRoot, files, count: found.size, ms: Math.round(performance.now() - t0) };
}

function ownStat(files: Record<string, FileStat>, key: string): FileStat | undefined {
  return Object.prototype.hasOwnProperty.call(files, key) ? files[key] : undefined;
}

/**
 * 比较开始与结束快照（4.8）。纯函数，不读写文件系统，不修改参数。
 *
 * 路径 p 带 `added` 当且仅当只在 `end` 中；带 `removed` 当且仅当只在 `start` 中；两者都有时，
 * `size` / `mtimeNs` 的十进制串不相等即分别带 `size` / `mtime`。不比较 `root`、`takenAt` 等字段。
 */
export function diffSnapshots(start: Snapshot, end: Snapshot): SnapshotDiff {
  const paths = [...new Set([...Object.keys(start.files), ...Object.keys(end.files)])].sort();
  const entries: SnapshotDiffEntry[] = [];
  for (const p of paths) {
    const a = ownStat(start.files, p);
    const b = ownStat(end.files, p);
    const kinds: DiffKind[] = [];
    if (a === undefined) {
      kinds.push("added");
    } else if (b === undefined) {
      kinds.push("removed");
    } else {
      if (a.size !== b.size) kinds.push("size");
      if (a.mtimeNs !== b.mtimeNs) kinds.push("mtime");
    }
    if (kinds.length > 0) entries.push({ path: p, kinds });
  }
  return { total: entries.length, entries };
}

/** 把快照写成 JSON（父目录不存在时创建）。 */
export async function writeSnapshot(file: string, snapshot: Snapshot): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

const INT_STRING = /^-?\d+$/;
const UINT_STRING = /^\d+$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 读取 `writeSnapshot` 写出的快照。文件不存在时返回 null（reporter 据此判"开始快照缺失"）；
 * 内容不是合法快照时抛错，错误信息含文件路径与第一处不合法的字段。
 */
export async function readSnapshot(file: string): Promise<Snapshot | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if (isErrno(err, "ENOENT")) return null;
    throw err;
  }
  const bad = (what: string): Error => new Error(`快照文件 ${file} 格式无效：${what}`);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw bad(`不是合法 JSON（${(err as Error).message}）`);
  }
  if (!isRecord(data)) throw bad("顶层不是对象");
  const { takenAt, root, files, count, ms } = data;
  if (typeof takenAt !== "string" || Number.isNaN(Date.parse(takenAt))) throw bad("takenAt");
  if (typeof root !== "string") throw bad("root");
  if (!isRecord(files)) throw bad("files");
  const keys = Object.keys(files);
  for (const key of keys) {
    const st = files[key];
    if (!isRecord(st) || typeof st.size !== "string" || !UINT_STRING.test(st.size)) {
      throw bad(`files[${JSON.stringify(key)}].size`);
    }
    if (typeof st.mtimeNs !== "string" || !INT_STRING.test(st.mtimeNs)) {
      throw bad(`files[${JSON.stringify(key)}].mtimeNs`);
    }
  }
  if (count !== keys.length) throw bad(`count 为 ${String(count)}，files 有 ${keys.length} 个键`);
  if (typeof ms !== "number" || !Number.isFinite(ms)) throw bad("ms");
  return { takenAt, root, files: files as unknown as Record<string, FileStat>, count: keys.length, ms };
}
