import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "fs-extra";
import path from "node:path";

// 构建时读取 config.json
const configPath = path.resolve(__dirname, "config.json");
const exampleConfigPath = path.resolve(__dirname, "config.example.json");

let userConfig = {};
if (fs.existsSync(configPath)) {
  userConfig = fs.readJsonSync(configPath);
}

const defaultConfig = fs.readJsonSync(exampleConfigPath);
const siteConfig = { ...defaultConfig, ...userConfig };

export default defineConfig({
  define: {
    // 硬编码配置，构建时替换
    // 注意：define 要求值本身就是代码，所以要双层 stringify
    '__SITE_CONFIG__': JSON.stringify(JSON.stringify(siteConfig)),
  },
  plugins: [
    react(),
    {
      name: "clean-dist-selectively",
      buildStart() {
        // 构建开始前，只删除旧的构建产物，保留 books 和 data
        const distDir = path.resolve(__dirname, "dist");
        if (!fs.existsSync(distDir)) return;
        
        const entries = fs.readdirSync(distDir);
        for (const entry of entries) {
          // 保留 books 和 data 目录，删除其他所有内容
          if (entry !== "books" && entry !== "data") {
            const fullPath = path.join(distDir, entry);
            fs.removeSync(fullPath);
          }
        }
      },
    },
  ],
  publicDir: false, // 禁用自动复制 public/，避免复制大量书籍数据
  server: {
    port: 5173,
    fs: {
      // 允许访问 dist/ 中的书籍数据（开发模式）
      allow: [".."],
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    emptyOutDir: false, // 不清空 dist/，由插件选择性清理
  },
});
