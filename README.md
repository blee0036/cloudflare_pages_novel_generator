# Cloudflare Pages 静态小说阅读站

一个完全运行在 **Cloudflare Pages** 上的小说阅读站：采用**无章节连续阅读**模式，正文按固定大小分块静态化，整本下载通过 Pages Function 串流拼接；浏览器本地存储记录阅读进度（字节位置），随时回到上次位置。

## 快速开始

```bash
# 1. 克隆项目并安装依赖
git clone https://github.com/blee0036/cloudflare_pages_novel_generator.git
cd cloudflare_pages_novel_generator
npm install

# 2. 将小说 RAR 文件放入 sourceRar/
cp /path/to/books/*.rar sourceRar/

# 3. 生成静态数据（分块文本与索引）
npm run preprocess

# 4. 构建，并自动拷贝 Functions
npm run build

# 5. 若尚未创建 Pages 项目，可先执行（一次即可）
npx wrangler pages project create <your-pages-project>

# 6. 部署到 Cloudflare Pages（指定项目名）
npx wrangler pages deploy dist --project-name <your-pages-project>
```

> 提示：首次使用 `wrangler` 需要运行 `npx wrangler login` 完成认证。

## 功能亮点

- **纯静态架构**：除下载接口外，所有页面与数据均为静态资源，可部署到任意静态托管平台。
- **无章节连续阅读**：整本书作为连续文本流，通过虚拟滚动动态加载内容（每次50KB），避免大文件卡顿，提供流畅的长篇阅读体验。
- **智能预处理**：自动解压 RAR、检测编码（UTF-8/UTF-16/GB18030/Big5等），按 20MB 切分 part 文件，**保留原始内容不做任何修改**。
- **高效内存管理**：阅读器最多保持 150KB 内容在内存，上下滚动自动加载/释放，适合超大小说（60MB+）。
- **本地阅读进度**：在浏览器 `localStorage` 中记录字节位置和阅读百分比，首页和书籍详情页支持"一键续读"。
- **一键部署**：`npm run build` 会自动复制 `functions/` 至 `dist/functions`，配合 `npx wrangler pages deploy dist --project-name ...` 即可上线。

## 环境准备

- Node.js 18+（推荐 20+）
- npm 8+（或兼容的包管理器）
- 若干 `.rar` 小说压缩包（放入 `sourceRar/`）

## 项目结构

```
cloudflare_pages_novel_generator/
├── functions/                 # Pages Function：整本下载串流
│   └── api/
│       └── books/
│           └── [bookId]/
│               └── download.ts
├── dist/
│   ├── books/                # 小说分块文件（preprocess 生成）
│   │   └── <bookId>/
│   │       ├── part_001.txt  # 每个 part ≤ 20MB
│   │       ├── part_002.txt
│   │       └── ...
│   └── data/                 # 索引 JSON（preprocess 生成）
│       ├── books.json        # 书籍列表
│       └── <bookId>_chapters.json  # 书籍元信息 + parts
├── scripts/
│   ├── preprocess.ts         # 预处理脚本
│   ├── copyFunctions.ts      # 构建后复制 functions → dist
│   ├── convert-to-compat.ts  # 格式转换工具（兼容性）
│   └── update-json-only.ts   # 快速更新JSON工具
├── sourceRar/                # 小说 RAR 包（忽略实际文件）
├── src/                      # React 前端源码
│   ├── api/
│   │   ├── hooks_simple.ts   # API hooks（无章节版）
│   │   └── types.ts
│   └── pages/
│       ├── SimpleReaderPage.tsx      # 连续阅读器
│       └── SimpleBookDetailPage.tsx  # 书籍详情
└── package.json
```

## 可选配置

如需自定义站点标题、简称、副标题（tagline）、描述或关键词，可将示例配置复制为 `config.json` 并调整：

```bash
cp config.example.json config.json
# 然后编辑 config.json 覆写所需字段
```

构建与运行时会优先读取 `config.json`，未提供则沿用示例默认值。

## 数据预处理流程

执行 `npm run preprocess` 会完成以下步骤：

1. **扫描源目录**：遍历 `sourceRar/` 中的 `.rar` 文件，解析文件名推断书名与作者。
2. **解压与转码**：在临时目录解压 `.txt` 正文，使用 `jschardet` + `iconv-lite` 自动检测编码并转为 UTF-8。
3. **固定大小分块**：
   - 按 **20MB** 切割原始文本为 `part_001.txt`、`part_002.txt` 等
   - **不修改任何内容**，保持原文完整（包括空格、换行、标点）
   - 每个 part 文件独立，可单独通过 HTTP Range 请求
4. **生成索引 JSON**：
   ```json
   {
     "book": {
       "id": "从零开始-雷云风暴",
       "title": "从零开始",
       "author": "雷云风暴",
       "totalChapters": 0,
       "parts": [
         {"path": "/books/从零开始-雷云风暴/part_001.txt", "size": 26213376},
         {"path": "/books/从零开始-雷云风暴/part_002.txt", "size": 26213376},
         {"path": "/books/从零开始-雷云风暴/part_003.txt", "size": 8121596}
       ],
       "totalSize": 60548348
     },
     "chapters": []
   }
   ```
5. **增量处理**：基于 SHA-256 判断文件是否变化，跳过未修改的书籍。
6. **进度日志**：输出 `[当前/总数] 正在处理《xxx》` 等实时进度。

### 批量处理性能

- **内存占用**：每批最多 20 本书，峰值约 200MB
- **处理速度**：约 1 秒/本（小说）
- **示例**：7000 本书约需 2 小时（实际时间取决于文件大小和磁盘速度）

## 本地开发

```bash
npm run preprocess   # 初始化/更新静态数据
npm run dev          # 启动 Vite 开发服务器
npm run typecheck    # TypeScript 类型检查
npm run lint         # ESLint 规则校验
npm run build        # 生产构建（包含 Functions 拷贝到 dist）
```

开发模式下，前端直接读取 `dist/data` 与 `dist/books`，无需额外 API。

## 构建与部署详解

### 1. 构建产物

```bash
npm run preprocess  # 生成 dist/books/ 和 dist/data/
npm run build       # 生成前端代码 + 复制 Functions
```

生成的 `dist/` 目录结构：
```
dist/
├── index.html
├── assets/
│   ├── index-xxx.js
│   └── index-xxx.css
├── books/          # 小说分块（preprocess 生成）
├── data/           # JSON索引（preprocess 生成）
└── functions/      # Pages Function（自动复制）
```

### 2. 部署到 Cloudflare Pages

```bash
npx wrangler pages deploy dist --project-name <your-pages-project>
```

`wrangler` 会同步上传静态文件和 Functions，确保下载接口可用。

### 3. 验证部署

访问 `https://<your-pages-project>.pages.dev/`，应该能看到：
- 首页：书籍列表 + 搜索
- 详情页：书籍信息 + 开始阅读 + 下载按钮
- 阅读器：连续滚动阅读，显示文件大小

## 阅读器使用说明

### 虚拟滚动机制

1. **初次加载**：加载开头 50KB 内容
2. **向下滚动**：距离底部 5000px 时自动加载下一个 50KB
3. **向上滚动**：距离顶部 5000px 时自动加载上一个 50KB
4. **内存管理**：最多保持 3 个 chunk（150KB），超出部分自动释放

### 阅读进度保存

- **自动保存**：滚动停止 1 秒后保存当前字节位置
- **显示格式**：首页显示 "《书名》· 已读 25.3%"
- **恢复位置**：点击继续阅读后，自动加载到上次的位置（居中显示）
- **存储位置**：浏览器 `localStorage`（清理缓存会丢失）

### 跨 part 加载

阅读器会自动处理跨文件读取：
```
part_001.txt: 0 - 26213376 字节
part_002.txt: 26213376 - 52426752 字节

用户读到 26200000 字节时：
- 从 part_001 读取最后 13376 字节
- 从 part_002 读取开头 36624 字节
- 无缝合并显示
```

## 兼容性说明

### JSON 格式兼容

当前版本使用 **兼容格式**，保留 `chapters` 字段（设为空数组）：

```json
{
  "book": {...},
  "chapters": []  // 空数组表示无章节模式
}
```

如果有旧版本数据（包含章节信息），可以使用转换工具：

```bash
# 转换为兼容格式（移除章节，保留 parts）
npx tsx scripts/convert-to-compat.ts

# 或快速更新 JSON（不重新处理 part 文件）
npx tsx scripts/update-json-only.ts
```

### 浏览器兼容性

- Chrome 90+
- Firefox 88+
- Safari 14+
- Edge 90+

需要支持：
- ES2020
- Fetch API with Range headers
- localStorage
- CSS Grid & Flexbox

## 常见问题

### Q: 为什么采用无章节模式？

**A:** 章节识别准确率问题：
- 不同小说的章节格式千差万别（"第X章"、"Chapter X"、"卷X"等）
- 识别错误会导致章节和内容对不上
- 无章节模式直接读取原文，100%准确

### Q: 如何快速跳转到某个位置？

**A:** 当前版本支持：
- 连续滚动阅读
- 自动保存/恢复位置
- 显示阅读百分比

未来可以扩展：
- 添加"跳转到 X%"功能
- 添加书签功能

### Q: 整本下载为什么需要 Function？

**A:** Cloudflare Pages 对单个静态文件有 25MB 限制。下载接口会串流拼接 part 文件，既绕过大小限制，也保证用户下载的是完整原文。

### Q: 可以同步阅读进度到云端吗？

**A:** 当前实现仅使用前端存储。如果需要多设备同步，可在此基础上接入 KV、D1 或第三方服务扩展 API。

### Q: 预处理速度太慢怎么办？

**A:** 优化建议：
- 调整批次大小（修改 `scripts/preprocess.ts` 中的 `BATCH_SIZE`）
- 使用 SSD 硬盘
- 确保 Node.js 版本 >= 20

### Q: 支持哪些编码格式？

**A:** 自动检测并支持：
- UTF-8 / UTF-8 BOM
- UTF-16 LE / UTF-16 BE
- UTF-32 LE / UTF-32 BE
- GB18030 / GBK
- Big5
- Shift_JIS
- EUC-KR

### Q: 可以处理 ZIP 格式吗？

**A:** 当前仅支持 RAR。如需支持 ZIP，需要修改 `scripts/preprocess.ts` 中的解压逻辑（替换 `node-unrar-js` 为 `adm-zip` 或 `yauzl`）。

## 技术栈

### 前端
- React 18
- React Router 6
- TanStack Query (React Query)
- TypeScript
- Vite

### 后端
- Cloudflare Pages Functions
- Node.js 20+

### 工具
- jschardet (编码检测)
- iconv-lite (编码转换)
- node-unrar-js (RAR解压)
- fs-extra (文件操作)

## 许可证

MIT

## 贡献指南

欢迎提交 Issue 和 Pull Request！

改进方向：
- [ ] 支持 ZIP 格式
- [ ] 添加书签功能
- [ ] 添加"跳转到 X%"功能
- [ ] 支持夜间模式
- [ ] 字体大小调节
- [ ] 云端进度同步

## 更新日志

### v2.0.0 (2025-01-12)
- 🎉 重构为无章节连续阅读模式
- ✨ 虚拟滚动优化内存占用
- ✨ 跨 part 无缝加载
- ✨ 阅读进度显示百分比
- 🐛 修复章节识别导致的内容错位问题
- ⚡ 预处理速度提升（移除章节识别）

### v1.0.0 (2024-XX-XX)
- 初始版本
- 支持章节识别和跳转
- 基础阅读功能
