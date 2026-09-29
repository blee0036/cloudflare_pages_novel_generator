/**
 * 构建产物接入：把 `public/` 下已生成的书籍产物以**硬链接**接进 `dist/`（需求 11.1–11.4），
 * 并在同一处断言产物顶层不存在 `404.html`（需求 10.3）。
 *
 * ## 为什么不让 Vite 自己复制
 *
 * 预处理（`scripts/preprocess.py`）把 7 千多本书的 `.txt.gz` 与 `_toc.json` 写进 `public/`，
 * 体量以 GB 计。Vite 默认的 `copyPublicDir` 会在每次构建时把它们逐字节复制进 `dist/`，
 * 于是磁盘上同一份数据存两遍、每次构建多花几分钟 I/O——需求 11.1 明确禁止这种翻倍。
 *
 * 但也不能退回旧版那种"预处理直接写 `dist/`"的做法：`dist/` 是构建产物目录，`emptyOutDir`
 * 会清空它，数据放在那里意味着每次构建前都得重新预处理（需求 11.2 禁止）。
 *
 * 硬链接同时满足两边：`public/` 保留唯一一份真实数据（dev 下 Vite 直接从这里提供
 * `/books/*` 与 `/data/*`，需求 11.3 无需任何额外配置），`dist/` 里的同名文件与它共享
 * 同一个 inode——零字节复制、零额外占用，上传时 `wrangler` 看到的是一棵完整的普通目录树。
 *
 * ## 接入范围是整个 `public/`，不只是 `books/` 与 `data/`
 *
 * 设计稿里写的是遍历 `["books", "data"]` 两个目录。这里改成遍历整个 `public/`，因为
 * `copyPublicDir: false` 关掉的是**全部** `public/` 内容，不止那两个大目录：任何人往
 * `public/` 根下放一个 `robots.txt`、`icon.png`，dev 下都能正常访问，产物里却会静默缺失
 * ——线上 404，本机看不出来。按 `public/` 整棵树接入即等价于 `copyPublicDir: true` 的
 * 语义，只是把"复制"换成了"硬链接"，不会有漏项。
 *
 * （`site-config` 插件另外用 `emitFile` 把 favicon 送进产物。两者对同一个文件不冲突：
 * `emitFile` 先落盘，随后本插件发现目标已存在且不是同一个 inode，换成硬链接，内容一致。）
 *
 * ## 跨卷即失败，不静默退回复制
 *
 * 硬链接要求源与目标在同一个文件系统卷。跨卷时 `link(2)` 返回 `EXDEV`，此时唯一正确的
 * 反应是让构建带着可操作的错误停下（需求 11.4）：静默改成复制会悄悄把磁盘占用翻倍，
 * 而站主是因为磁盘不够才做这个改造的。
 */

import fs from "node:fs";
import path from "node:path";
import type { Logger, Plugin } from "vite";

/**
 * `fs.linkSync` 的形状。
 *
 * 只有这一个 syscall 做成可注入参数，`mkdir`/`readdir` 仍直连真实文件系统：需要用替身
 * 覆盖的失败路径只有一条——跨卷 `EXDEV`（需求 11.4）。它没法在测试机上稳定复现（取决于
 * 机器有几个卷、临时目录落在哪个卷），而它恰恰是本模块最该被钉住的行为。
 */
export type LinkFn = (src: string, dst: string) => void;

/** 单个文件的接入结果。三种路径都是正常结果，区分开只为日志与测试可读。 */
export type LinkResult =
  /** 目标原先不存在，新建链接。 */
  | "linked"
  /** 目标已存在但指向别的 inode（陈旧链接或真实副本），已换成指向当前源。 */
  | "relinked"
  /** 目标已经就是同一个 inode，什么都不用做。 */
  | "kept";

/** 一次接入的汇总，用于构建日志。 */
export interface LinkStats {
  /** 接入的文件总数。 */
  readonly files: number;
  /** 这些文件的字节总量——也就是本次**没有**复制的字节数。 */
  readonly bytes: number;
  /** 其中被重新链接的数量（上次构建的残留与源不一致）。 */
  readonly relinked: number;
  /** 其中原样保留的数量（已是同一 inode）。 */
  readonly kept: number;
}

/**
 * 产物顶层禁止出现的文件名（需求 10.3）。
 *
 * Cloudflare Pages 的 SPA 回退是"顶层没有 `404.html`"时的默认行为（需求附录 P2）：一旦
 * 顶层出现 `404.html`，Pages 转为按目录树找最近的 404 页，`BrowserRouter` 的深链接
 * `/read/<id>` 当场失效。这条约束不写在部署脚本里而是构建期断言，因为它的症状（只有深
 * 链接坏、首页正常）离原因太远，上线后极难定位。
 */
export const FORBIDDEN_OUTPUT_FILES: readonly string[] = ["404.html"];

/**
 * 把 `srcDir` 整棵树硬链接进 `dstDir`，返回汇总。
 *
 * 目录按需创建（目录本身无法硬链接，只有文件可以），文件逐个交给 `hardLink`。
 * 任何一个文件失败即整体抛错：产物少一个 gz 就是线上一本书打不开，没有"部分成功"这种
 * 可接受的中间态。
 */
export function linkTree(srcDir: string, dstDir: string, link: LinkFn = fs.linkSync): LinkStats {
  const stats = { files: 0, bytes: 0, relinked: 0, kept: 0 };

  const walk = (src: string, dst: string): void => {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const from = path.join(src, entry.name);
      const to = path.join(dst, entry.name);
      if (entry.isDirectory()) {
        walk(from, to);
        continue;
      }
      const result = hardLink(from, to, link);
      stats.files += 1;
      stats.bytes += sizeOf(from);
      if (result === "relinked") stats.relinked += 1;
      if (result === "kept") stats.kept += 1;
    }
  };

  walk(srcDir, dstDir);
  return stats;
}

/**
 * 建立单个硬链接，幂等。
 *
 * `EEXIST` 不能一律当成"已经好了"就跳过：`emptyOutDir` 默认为 true，正常构建下 `dist/`
 * 是空的，能撞上已存在的目标只有两种情况——
 * - 目标已经指向同一个 inode（上次构建的链接还在，`emptyOutDir` 被关掉了）：跳过是对的；
 * - 目标是别的 inode：可能是 `site-config` 刚 `emitFile` 出来的真实文件，也可能是重新
 *   预处理后源文件被换掉、而 `dist/` 里的旧链接还指着已经没人认领的旧 inode。后者若跳过，
 *   产物就是**陈旧内容**，且看起来一切正常。所以一律删掉重链。
 */
export function hardLink(src: string, dst: string, link: LinkFn = fs.linkSync): LinkResult {
  try {
    link(src, dst);
    return "linked";
  } catch (err) {
    if (errorCode(err) !== "EEXIST") throw linkError(err, src, dst);
  }

  if (isSameFile(src, dst)) return "kept";

  fs.rmSync(dst, { force: true });
  try {
    link(src, dst);
  } catch (err) {
    throw linkError(err, src, dst);
  }
  return "relinked";
}

/**
 * 断言 `outDir` 顶层没有 `FORBIDDEN_OUTPUT_FILES` 里的文件（需求 10.3）。
 *
 * 只看顶层：Pages 的判定条件就是顶层文件，子目录里的 `404.html` 是普通静态资源，无害。
 */
export function assertNoForbiddenOutputs(outDir: string): void {
  if (!fs.existsSync(outDir)) return;
  const found = findForbiddenOutputs(fs.readdirSync(outDir));
  if (found.length > 0) throw new Error(forbiddenOutputMessage(found, outDir));
}

/**
 * 从一组顶层文件名里挑出禁止项。
 *
 * 比较时统一小写：Windows 文件系统大小写不敏感，`404.HTML` 与 `404.html` 是同一个文件，
 * 而上传后 Pages 看到的就是磁盘上的那个名字。宁可多拦一个不该存在的文件。
 */
export function findForbiddenOutputs(entries: readonly string[]): string[] {
  const forbidden = new Set(FORBIDDEN_OUTPUT_FILES.map((name) => name.toLowerCase()));
  return entries.filter((entry) => forbidden.has(entry.toLowerCase()));
}

/** 顶层出现禁止文件时的错误文案：说清后果与处置，不只报"检测到"。 */
export function forbiddenOutputMessage(found: readonly string[], outDir: string): string {
  return (
    `构建产物顶层出现了 ${found.join("、")}（需求 10.3 禁止）：${outDir}\n` +
    `Cloudflare Pages 只在顶层不存在 404.html 时才按单页应用处理请求，把未命中的路径交给 /；\n` +
    `一旦顶层有 404.html，它改为按目录树返回最近的 404 页，深链接 /read/<id> 会直接 404。\n` +
    `请删掉它（连带检查 public/ 下与生成它的插件），未匹配路由已由前端统一跳回书架。`
  );
}

/**
 * 把 `link(2)` 的失败翻译成可操作的构建错误文案。
 *
 * `EXDEV` 单独成一条并写明"不退回复制"，因为那正是需求 11.4 要求的行为，也是站主唯一
 * 需要动手的情形。
 */
export function explainLinkFailure(code: string | undefined, src: string, dst: string): string {
  const where = `  源   ${src}\n  目标 ${dst}`;

  if (code === "EXDEV") {
    return (
      `public/ 与 dist/ 不在同一个文件系统卷，无法建立硬链接（EXDEV）：\n${where}\n` +
      `构建不会退回复制——那会把整个书库在磁盘上存成两份，正是需求 11.1 要消除的开销。\n` +
      `请改成同卷后重试：把仓库整体放在一个卷上，或用 build.outDir 把产物目录指到与\n` +
      `public/ 同卷的路径；若 public/books、public/data 本身是指向别卷的挂载点或符号\n` +
      `链接，则改为同卷存放。`
    );
  }

  if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP" || code === "EOPNOTSUPP") {
    return (
      `没有权限或文件系统不支持硬链接（${code}）：\n${where}\n` +
      `FAT/exFAT、部分网络盘与容器挂载点都不支持硬链接，请把 public/ 与 dist/ 放到 NTFS\n` +
      `或 ext4/APFS 等支持硬链接的本地卷上。`
    );
  }

  if (code === "ENOENT") {
    return (
      `源文件在构建期间消失了（ENOENT）：\n${where}\n` +
      `构建过程中不要同时跑 npm run preprocess——它会改写 public/ 下的文件。`
    );
  }

  return `硬链接失败${code ? `（${code}）` : ""}：\n${where}`;
}

/** 人类可读的字节量，用于日志里报"省掉了多少复制"。 */
export function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // 整数字节不加小数点；其余保留一位，够看出量级又不吵。
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

/**
 * Vite 插件本体（需求 11.1–11.4、10.3）。
 *
 * 只挂 `closeBundle`：那时 Rollup 已经把 `index.html` 与 `assets/` 都写完了，`dist/` 的
 * 形状是最终形状——顶层 `404.html` 的断言必须在这个时点做才算数，接入书籍产物也不会与
 * `emptyOutDir` 的清空时机打架。`apply: "build"` 是因为 dev 下 Vite 直接从 `public/`
 * 提供静态文件（需求 11.3），没有产物目录，本插件无事可做。
 */
export function linkAssets(): Plugin {
  let publicDir = "";
  let outDir = "";
  let logger: Logger | undefined;

  return {
    name: "link-assets",
    apply: "build",

    configResolved(config) {
      // `publicDir` 为绝对路径；`publicDir: false` 时 Vite 把它解析成空串。
      publicDir = config.publicDir;
      outDir = path.resolve(config.root, config.build.outDir);
      logger = config.logger;

      if (config.build.copyPublicDir) {
        // 复制已经发生过一遍才走到这里就太晚了，所以在配置阶段直接拦下。
        throw new Error(
          `link-assets 插件要求 build.copyPublicDir: false（需求 11.1）。\n` +
            `当前配置仍为 true：Vite 会先把 public/ 下的整个书库复制进 ${outDir}，` +
            `磁盘占用翻倍，本插件的硬链接也就失去意义。`,
        );
      }
    },

    closeBundle() {
      if (!publicDir) {
        logger?.warn(`[link-assets] publicDir 已关闭，没有预处理产物可接入 ${outDir}`);
      } else if (!fs.existsSync(publicDir)) {
        logger?.warn(
          `[link-assets] ${publicDir} 不存在，产物里不会有 books/ 与 data/；` +
            `先跑 npm run preprocess`,
        );
      } else {
        const stats = linkTree(publicDir, outDir);
        const extra = [
          stats.relinked > 0 ? `重链 ${stats.relinked}` : "",
          stats.kept > 0 ? `已是链接 ${stats.kept}` : "",
        ].filter(Boolean);
        logger?.info(
          `[link-assets] 已硬链接 ${stats.files} 个文件（${formatBytes(stats.bytes)}）` +
            `进 ${outDir}，零字节复制` +
            (extra.length > 0 ? `（${extra.join("，")}）` : ""),
        );
      }

      assertNoForbiddenOutputs(outDir);
    },
  };
}

/**
 * 源与目标是否已经是同一个文件（同卷同 inode）。取不到状态就当作不同，宁可多做一次重链。
 *
 * 用 `bigint: true` 而不是默认的 number：Windows 的文件编号是 64 位的，落进 JS number
 * 会被截断，比较两个**不同**文件时理论上可能撞上同一个截断值——那会让陈旧链接被判成
 * "已是同一个文件"而跳过，产物里留下旧内容。
 */
function isSameFile(src: string, dst: string): boolean {
  try {
    const a = fs.statSync(src, { bigint: true });
    const b = fs.statSync(dst, { bigint: true });
    // ino 为 0 表示该文件系统没给出可用的编号，此时无法判定"同一个文件"。
    return a.ino !== 0n && a.ino === b.ino && a.dev === b.dev;
  } catch {
    return false;
  }
}

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function linkError(err: unknown, src: string, dst: string): Error {
  // 原始的 Node 系统错误挂在 `cause` 上：翻译后的文案是给站主看的，排查时还得看得到
  // 原始 errno 与 syscall。写成 `Object.assign` 而不是 `new Error(msg, { cause })` 是因为
  // 后者的类型要 lib ES2022，本项目 lib 定在 ES2020；运行时（Node 16+）两者等价。
  return Object.assign(new Error(explainLinkFailure(errorCode(err), src, dst)), { cause: err });
}

/** 取 Node 系统错误的 `code`，非系统错误返回 `undefined`。 */
function errorCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}
