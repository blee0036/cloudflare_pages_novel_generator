import type { SiteConfig } from "./types";

// 构建时从 config.json 硬编码配置，提升 SEO 和首屏性能
// Vite 通过 define 在构建时替换 __SITE_CONFIG__
declare const __SITE_CONFIG__: string;

let parsedConfig: SiteConfig;
try {
  parsedConfig = JSON.parse(__SITE_CONFIG__);
} catch {
  // 开发模式降级配置
  parsedConfig = {
    siteName: "Cloudflare 边缘小说库",
    shortName: "CF",
    tagline: "纯静态 Cloudflare Pages 小说阅读器",
    description: "一个部署在 Cloudflare Pages 上的纯静态小说阅读站点",
    keywords: ["小说", "阅读", "Cloudflare Pages"],
    favicon: "/favicon.svg",
  };
}

export const siteConfig: SiteConfig = parsedConfig;
