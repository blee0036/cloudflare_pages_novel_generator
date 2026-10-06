/**
 * E2E_Server（设计"E2E_Server"一节；需求 4.1、5.2–5.4、5.6–5.9、5.12–5.14）。
 *
 * 一个实例服务一份 App_Build 与一个书库根，模式（Opaque_Mode / Transparent_Mode）在创建时
 * 确定，生命周期内不变（5.12）。路径解析与 Content-Type 表都在 `resolve.ts`，这里只做 I/O：
 *
 * - 只接受 GET 与 HEAD，其余方法返回 405 并带 `Allow: GET, HEAD`（4.1、5.8）。
 * - `resolveRequest` 判为 forbidden 时返回 403，响应体为空，原始路径追加写入 `server.log`；
 *   日志写完才发出响应，客户端收到 403 时日志行已落盘（5.7）。
 * - candidate 经 `stat` 确认是文件时以 `createReadStream(p, { flags: "r" })` 流式返回；
 *   不存在、是目录或 `stat` 失败时，以 200 返回启动时读入内存的 `index.html` 字节（5.6）。
 * - 每个响应都带 `Content-Length` 与 `Cache-Control: no-store`；只有 Transparent_Mode 下的
 *   `.txt.gz` 带 `Content-Encoding: gzip`，响应体仍是磁盘上的 gz 字节（5.3、5.4、5.13）。
 * - 响应头只取决于解析结果与实例模式，不读取请求所带的查询串或请求头（5.12）。
 * - 只监听 `127.0.0.1`；端口被占用时以 `PortInUseError` 报出端口号（5.9）。
 * - `close()` 在 `server.close()` 之后调用 `closeAllConnections()`，不等 keep-alive 连接
 *   自然超时，超过 `TIMEOUTS.serverShutdown` 仍未关闭即报错（5.14）。
 *
 * 全部文件以只读方式打开；服务器唯一会写的文件是 `server.log`，它不得位于两个根目录之内
 * （4.1、5.8）。不带鉴权，仅供本机测试使用。
 */
import { createReadStream, type Stats } from "node:fs";
import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { pipeline } from "node:stream";
import { TIMEOUTS } from "../support/settings";
import { contentTypeFor, isTxtGz, resolveRequest, type Mode } from "./resolve";

/** 只在该地址上监听（5.8）。 */
const HOST = "127.0.0.1";
const ALLOWED_METHODS = "GET, HEAD";
const CACHE_CONTROL = "no-store";
const INDEX_HTML = "index.html";

export interface E2EServerOptions {
  /** 监听端口，取自 `settings.ts` 的 `PORTS`；传 0 时由系统分配（仅供测试）。 */
  port: number;
  mode: Mode;
  /** App_Build 目录，须含 `index.html`。 */
  appRoot: string;
  /** 书库根（5.2）：E2E 运行中为 Fixture_Library 目录（`e2e/.out/fixture/`）。 */
  libRoot: string;
  /** `server.log` 的路径；forbidden 请求的原始路径追加写入此文件（5.7）。多个实例可共用一份。 */
  log: string;
}

export interface E2EServer {
  /** 实际监听的端口（`port: 0` 时为系统分配的端口）。 */
  readonly port: number;
  readonly mode: Mode;
  /** `http://127.0.0.1:<port>`，不带结尾 `/`。 */
  readonly origin: string;
  /** 停止监听并断开全部连接，等待已排队的日志写完（5.14）。可重复调用，返回同一个 Promise。 */
  close(): Promise<void>;
}

/** 配置的端口已被占用（5.9）。globalSetup 据 `port` 报告被占用的端口号。 */
export class PortInUseError extends Error {
  readonly port: number;

  constructor(port: number) {
    super(`E2E_Server 无法监听 ${HOST}:${port}：端口 ${port} 已被占用`);
    this.name = "PortInUseError";
    this.port = port;
  }
}

/** `child` 是否等于 `parent` 或位于其下（两者均为绝对路径）。 */
function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!path.isAbsolute(rel) && rel.split(/[\\/]/)[0] !== "..");
}

/** 是文件时返回其 `Stats`；不存在、是目录或其他任何 `stat` 失败都算未命中（5.6）。 */
async function statFile(absPath: string): Promise<Stats | null> {
  try {
    const st = await stat(absPath);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

/** 空响应体的状态响应（403、405、500）。 */
function sendEmpty(
  res: http.ServerResponse,
  status: number,
  extra: http.OutgoingHttpHeaders = {},
): void {
  res.writeHead(status, { ...extra, "Content-Length": 0, "Cache-Control": CACHE_CONTROL });
  res.end();
}

/**
 * 创建并启动一个 E2E_Server 实例，监听成功后返回。
 *
 * 先读入 `appRoot/index.html`（缺失即抛错，不开始监听），再监听 `127.0.0.1:<port>`。
 * 端口被占用时抛 `PortInUseError`，其他监听错误原样抛出。
 */
export async function createE2EServer(options: E2EServerOptions): Promise<E2EServer> {
  const { mode } = options;
  const roots = { app: path.resolve(options.appRoot), lib: path.resolve(options.libRoot) };
  const logPath = path.resolve(options.log);

  for (const root of [roots.app, roots.lib]) {
    if (isWithin(root, logPath)) {
      throw new Error(`server.log 不能位于被服务的目录之内（${logPath} 在 ${root} 下）`);
    }
  }

  const indexPath = path.join(roots.app, INDEX_HTML);
  let indexBytes: Buffer;
  try {
    indexBytes = await readFile(indexPath, { flag: "r" });
  } catch (error) {
    // 原样重抛，保留 `code`（如 ENOENT）；消息前加上是哪个实例缺了什么
    if (error instanceof Error) {
      error.message = `App_Build 缺少可读的 ${INDEX_HTML}：${indexPath}（${error.message}）`;
    }
    throw error;
  }
  await mkdir(path.dirname(logPath), { recursive: true });

  let port = options.port;

  // 日志按到达顺序串行追加；写失败只报到 stderr，不影响 403 响应。
  let logChain: Promise<void> = Promise.resolve();
  function appendLog(method: string, rawUrl: string, reason: string): Promise<void> {
    const line = `${new Date().toISOString()} ${HOST}:${port} ${mode} 403 ${method} ${rawUrl} ${reason}\n`;
    logChain = logChain
      .then(() => appendFile(logPath, line, { encoding: "utf8", flag: "a" }))
      .catch((error: unknown) => {
        console.error(`[e2e-server] 写入 ${logPath} 失败：`, error);
      });
    return logChain;
  }

  function sendIndex(res: http.ServerResponse, head: boolean): void {
    res.writeHead(200, {
      "Content-Type": contentTypeFor(INDEX_HTML, mode),
      "Content-Length": indexBytes.length,
      "Cache-Control": CACHE_CONTROL,
    });
    res.end(head ? undefined : indexBytes);
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method ?? "";
    const rawUrl = req.url ?? "";

    if (method !== "GET" && method !== "HEAD") {
      sendEmpty(res, 405, { Allow: ALLOWED_METHODS });
      return;
    }
    const head = method === "HEAD";

    // 越界判定先于回退（5.7）
    const resolved = resolveRequest(rawUrl, roots);
    if (resolved.kind === "forbidden") {
      await appendLog(method, rawUrl, resolved.reason);
      sendEmpty(res, 403);
      return;
    }

    const st = await statFile(resolved.absPath);
    if (!st) {
      sendIndex(res, head);
      return;
    }

    const headers: http.OutgoingHttpHeaders = {
      "Content-Type": contentTypeFor(resolved.absPath, mode),
      "Content-Length": st.size,
      "Cache-Control": CACHE_CONTROL,
    };
    if (mode === "transparent" && isTxtGz(resolved.absPath)) {
      headers["Content-Encoding"] = "gzip";
    }
    res.writeHead(200, headers);
    if (head) {
      res.end();
      return;
    }
    // 状态行与响应头已排队，读取中途出错时只能断开连接
    pipeline(createReadStream(resolved.absPath, { flags: "r" }), res, (error) => {
      if (error) res.destroy(error);
    });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      console.error(`[e2e-server] ${HOST}:${port} 处理 ${req.method} ${req.url} 失败：`, error);
      if (res.headersSent) res.destroy();
      else sendEmpty(res, 500);
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      reject(error.code === "EADDRINUSE" ? new PortInUseError(options.port) : error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ port: options.port, host: HOST });
  });
  port = (server.address() as AddressInfo).port;

  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    if (!closing) {
      closing = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`E2E_Server ${HOST}:${port} 未能在 ${TIMEOUTS.serverShutdown} ms 内关闭`));
        }, TIMEOUTS.serverShutdown);
        timer.unref();
        server.close((error) => {
          clearTimeout(timer);
          if (error) reject(error);
          else resolve();
        });
        // 断开 keep-alive 与进行中的连接，否则 close 要等它们自然结束
        server.closeAllConnections();
      }).then(() => logChain);
    }
    return closing;
  }

  return { port, mode, origin: `http://${HOST}:${port}`, close };
}
