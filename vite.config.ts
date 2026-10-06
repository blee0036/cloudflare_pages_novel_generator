import fs from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { linkAssets } from "./build/linkAssets";
import {
  DEFAULT_SITE_CONFIG,
  SITE_CONFIG_FILE,
  faviconPublicPath,
  resolveSiteConfig,
  siteHtmlPlaceholderPattern,
  siteHtmlPlaceholders,
  type SiteConfig,
} from "./src/utils/siteConfig";

export default defineConfig({
  plugins: [react(), siteConfig(), linkAssets()],
  server: {
    port: 3000,
    open: false,
  },
  build: {
    target: "es2020",
    outDir: "dist",
    /**
     * 关掉 `public/` 的复制（需求 11.1）。`public/` 下是预处理生成的整个书库（GB 级），
     * 逐字节复制进 `dist/` 等于在磁盘上存两份、每次构建再付一遍 I/O。产物由
     * `linkAssets()` 在 `closeBundle` 阶段以硬链接接入，见 `build/linkAssets.ts`。
     *
     * 这一项与 `linkAssets()` 是一对，不能只留其一：单独关掉复制，产物里就没有
     * `books/` 与 `data/`；单独留着复制，硬链接就毫无意义（插件会在配置阶段直接报错）。
     * dev 不受影响——`copyPublicDir` 只作用于构建，dev 下 Vite 仍直接从 `public/`
     * 提供 `/books/*` 与 `/data/*`（需求 11.3）。
     */
    copyPublicDir: false,
  },
});

/**
 * 把站点标识注入构建产物（需求 9.2）。
 *
 * 插件本身只做三件很薄的事，判定逻辑全在 `src/utils/siteConfig.ts`（纯函数、有单测）：
 *
 * 1. `config`：读一次可选的 `site.config.json`，把解析结果经 `define` 内联成
 *    `__SITE_CONFIG__`，供 `src/utils/site.ts` 在运行时读出（需求 9.3 的站点名来源）。
 * 2. `transformIndexHtml`：替换 `index.html` 里的 `%SITE_*%` 占位符（title / description /
 *    keywords / favicon），这样首帧与爬虫看到的就是最终值。
 * 3. `generateBundle`：favicon 指向 `public/` 下的文件时，把它 `emitFile` 进产物——
 *    构建开着 `copyPublicDir: false`（需求 11.1），`public/` 下的文件不再由 Vite 复制，
 *    图标必须自己进 dist。`linkAssets` 随后也会把它硬链接过去，两条路径结果一致；这里
 *    保留 `emitFile` 是因为它顺带把"配置写了路径却没有文件"变成一条明确的构建错误。
 *
 * 读盘只发生在 `config` 这一次：dev 与 build 走的都是它，两边不可能读出不同的值。
 */
function siteConfig(): Plugin {
  let site: SiteConfig = DEFAULT_SITE_CONFIG;
  let root = process.cwd();

  return {
    name: "site-config",

    config(userConfig) {
      // `configResolved` 才有权威的 `config.root`，但 `define` 必须在这一步交出去，
      // 所以按 Vite 解析 root 的同一规则自己算一次（未指定即 cwd）。
      root = userConfig.root ? path.resolve(userConfig.root) : process.cwd();
      site = readSiteConfigFile(root);
      return { define: { __SITE_CONFIG__: JSON.stringify(site) } };
    },

    /**
     * `order: "pre"` 是必须的，不是风格选择：Vite 的 `vite:build-html` 会把
     * `<link href>` 当资源引用处理（对它 `decodeURI`），而 `%SITE_FAVICON%` 里的 `%SI`
     * 不是合法的百分号转义，构建会以 "URI malformed" 失败。普通（normal）时序的
     * `transformIndexHtml` 跑在那次资源遍历**之后**，救不了；`pre` 则在遍历前就把
     * 占位符换成真地址，图标随后作为普通资源被正常处理。
     */
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        const values = siteHtmlPlaceholders(site);
        // 认不出的占位符原样留下（见 `siteHtmlPlaceholderPattern` 的注释）。
        return html.replace(siteHtmlPlaceholderPattern(), (token) => values[token] ?? token);
      },
    },

    generateBundle() {
      const relative = faviconPublicPath(site.favicon);
      if (relative === null) return; // data URI / 绝对 URL：没有文件要搬

      const source = path.join(root, "public", relative);
      if (!fs.existsSync(source)) {
        // 硬失败而不是告警：产物里缺图标在本机 dev 下看不出来（dev 由 Vite 直接从
        // public/ 提供），线上却是一个 404。配置写了一个路径就必须能兑现。
        throw new Error(
          `${SITE_CONFIG_FILE} 的 favicon 指向 "${site.favicon}"，但找不到文件：${source}\n` +
            `把图标放到 public/ 下（路径相对 public/），或改用 data URI / 绝对 URL。`,
        );
      }

      // 走 Rollup 的产物通道而不是自己拷贝：文件名不带 hash（`href` 是配置里写死的路径），
      // 且与 `emptyOutDir` 的清空时机天然无冲突。
      this.emitFile({
        type: "asset",
        fileName: relative,
        source: fs.readFileSync(source),
      });
    },

    configureServer(server) {
      // 改配置要能立刻看到效果：站点名进了 HTML 与 `define`，两者都只在启动时算一次，
      // 所以这里只能重启 dev server（Vite 对 vite.config.ts 自身也是这么做的）。
      const file = path.join(root, SITE_CONFIG_FILE);
      server.watcher.add(file);
      server.watcher.on("all", (_event, changed) => {
        if (path.resolve(changed) === file) {
          server.config.logger.info(`[site-config] ${SITE_CONFIG_FILE} 已变更，重启 dev server`);
          void server.restart();
        }
      });
    },
  };
}

/**
 * 读取可选的 `site.config.json`。
 *
 * 两种"不正常"分明地区别对待：
 * - **文件不存在**：正常分支，用内置默认值，一个字也不打印（需求 9.2）。
 * - **文件存在但不是合法 JSON**：硬失败。站主刚刚编辑过它，多一个逗号就静默回落成默认
 *   站名的话，他会带着一份自认为生效了的配置部署上线。
 *
 * 字段级问题（类型写错、键名拼错）由 `resolveSiteConfig` 逐字段回落并给出告警，这里
 * 只负责把告警打到构建日志上。
 */
function readSiteConfigFile(root: string): SiteConfig {
  const file = path.join(root, SITE_CONFIG_FILE);
  if (!fs.existsSync(file)) return DEFAULT_SITE_CONFIG;

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(
      `${SITE_CONFIG_FILE} 不是合法的 JSON：${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  const { config, warnings } = resolveSiteConfig(raw);
  for (const warning of warnings) {
    console.warn(`[site-config] ${warning}`);
  }
  return config;
}
