/**
 * E2E_Server 的纯函数部分（设计"E2E_Server"一节；需求 5.2、5.7、5.13）。
 *
 * - `resolveRequest`：把请求行里的原始路径解码、规范化并映射到书库根或 App_Build，
 *   只做字符串运算，不访问文件系统。命中与否由 `server.ts` 对 candidate 再 `stat` 决定：
 *   是文件就返回，否则回退 `index.html`（5.6）。越界判定因此先于回退（5.7）。
 * - `contentTypeFor`：Content-Type 表（5.13）只在这里定义一份，服务器的文件响应与
 *   `index.html` 回退都从这里取。
 */
import path from "node:path";

/** 实例的服务模式，启动时确定、生命周期内不变（5.12）。 */
export type Mode = "opaque" | "transparent";

export type Resolved =
  /** 规范化后的路径，落在 `root` 所指的根目录之内；由 server 再 stat：是文件就返回，否则回退。 */
  | { kind: "candidate"; root: "app" | "lib"; absPath: string }
  /** 解码失败或越界：返回 403，响应体为空，原始路径写入 `server.log`（5.7）。 */
  | { kind: "forbidden"; reason: string };

/** 首段为这些名称的路径映射到书库根（`fixture` 为 Fixture_Library，`real` 为 `public/`），其余映射到 App_Build（5.2）。 */
const LIB_FIRST_SEGMENTS: ReadonlySet<string> = new Set(["books", "data"]);

/**
 * 按设计的 6 步解析请求路径：
 *
 * 1. 取第一个 `?` 或 `#` 之前的部分（忽略查询串）。
 * 2. 对整段做 `decodeURIComponent`（按 UTF-8），失败即 forbidden。`%2f`、`%5c` 由此成为分隔符。
 * 3. 含 `\0` 即 forbidden。把 `\` 换成 `/` 后按 `/` 切段，丢掉空段与 `.`；遇 `..` 弹栈，
 *    栈已空仍遇 `..` 即 forbidden。
 * 4. 任一段含 `:` 即 forbidden（Windows 盘符与 `::$DATA` 等备用数据流）。
 * 5. 首段是 `books` 或 `data` 时 root 取 lib，否则取 app；`absPath = path.join(root, ...segs)`。
 * 6. 防御性核对：`path.relative(root, absPath)` 的首个路径分量是 `..`，或结果是绝对路径时
 *    forbidden。按分量比较，`...`、`..foo` 这类合法名称不受影响，仍按 5.6 走回退。
 *
 * `roots` 中的相对路径先按当前工作目录解析为绝对路径，`absPath` 因此总是绝对路径。
 */
export function resolveRequest(rawUrl: string, roots: { app: string; lib: string }): Resolved {
  // 1. 忽略查询串与片段
  const cut = rawUrl.search(/[?#]/);
  const rawPath = cut === -1 ? rawUrl : rawUrl.slice(0, cut);

  // 2. 百分号解码
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return { kind: "forbidden", reason: "百分号解码失败" };
  }

  // 3. 规范化：消解 `\`、重复的 `/`、`.` 与 `..`
  if (decoded.includes("\0")) {
    return { kind: "forbidden", reason: "路径含 NUL 字符" };
  }
  const segs: string[] = [];
  for (const seg of decoded.replace(/\\/g, "/").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (segs.length === 0) return { kind: "forbidden", reason: "`..` 越过根目录" };
      segs.pop();
      continue;
    }
    segs.push(seg);
  }

  // 4. 盘符与备用数据流
  if (segs.some((seg) => seg.includes(":"))) {
    return { kind: "forbidden", reason: "路径段含 `:`" };
  }

  // 5. 根映射
  const root: "app" | "lib" = segs.length > 0 && LIB_FIRST_SEGMENTS.has(segs[0]) ? "lib" : "app";
  const rootDir = path.resolve(roots[root]);
  const absPath = path.join(rootDir, ...segs);

  // 6. 防御性核对
  const rel = path.relative(rootDir, absPath);
  if (path.isAbsolute(rel) || rel.split(/[\\/]/)[0] === "..") {
    return { kind: "forbidden", reason: "规范化后越出根目录" };
  }
  return { kind: "candidate", root, absPath };
}

const TXT_GZ_SUFFIX = ".txt.gz";

/** `.txt.gz` 两种模式下的 Content-Type（5.13）。 */
const TXT_GZ_CONTENT_TYPE: Readonly<Record<Mode, string>> = {
  opaque: "application/gzip",
  transparent: "text/plain; charset=utf-8",
};

/** 其余扩展名的 Content-Type（5.13），两种模式相同。键为小写扩展名。 */
const CONTENT_TYPE_BY_EXT: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const DEFAULT_CONTENT_TYPE = "application/octet-stream";

/** 文件名（或路径）是否以 `.txt.gz` 结尾，不区分大小写。 */
export function isTxtGz(fileName: string): boolean {
  return fileName.toLowerCase().endsWith(TXT_GZ_SUFFIX);
}

/**
 * 按扩展名给出 Content-Type（5.13），扩展名不区分大小写。`fileName` 可以是文件名或完整路径。
 * 5.6 的回退响应以 `contentTypeFor("index.html", mode)` 取值，与 `.html` 相同。
 *
 * `Content-Encoding` 不在这里决定：只有 Transparent_Mode 下的 `.txt.gz` 带 `gzip`（5.4），
 * 由 server 以 `isTxtGz` 判断。
 */
export function contentTypeFor(fileName: string, mode: Mode): string {
  if (isTxtGz(fileName)) return TXT_GZ_CONTENT_TYPE[mode];
  return CONTENT_TYPE_BY_EXT[path.extname(fileName).toLowerCase()] ?? DEFAULT_CONTENT_TYPE;
}
