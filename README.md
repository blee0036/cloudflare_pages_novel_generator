# Cloudflare Pages 静态小说阅读站

一个完全运行在 **Cloudflare Pages** 上的小说阅读站：正文、目录、章节索引全部静态化，整本下载通过 Pages Function 串流拼接；浏览器本地存储记录最近阅读进度，随时回到上次位置。

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
- **智能预处理**：自动解压 RAR、识别编码与章节（支持“第 N 卷/章”“番外”“Book 2”等模式），生成紧凑 JSON 索引与 25 MiB 内的文本分块。
- **高效阅读体验**：阅读页使用 Range 请求按需拉取章节，无需下载整块文本；提供章节下拉、键盘快捷键、上下章按钮等导航方式。
- **本地阅读进度**：在浏览器 `localStorage` 中记录最近阅读书籍与章节，首页和书籍详情页支持“一键续读”。
- **一键部署**：`npm run build` 会自动复制 `functions/` 至 `dist/functions`，配合 `npx wrangler pages deploy dist --project-name ...` 即可上线。

## 环境准备
- Node.js 18+（推荐 20+）
- npm 8+（或兼容的包管理器）
- 若干 `.rar` 小说压缩包（放入 `sourceRar/`）

## 项目结构
```
cloudflare_pages_novel_generator/
├── functions/                 # Pages Function：整本下载串流
├── public/
│   ├── books/                # 章节分块（运行预处理后生成）
│   └── data/                 # 索引 JSON（运行预处理后生成）
├── scripts/
│   ├── preprocess.ts         # 预处理脚本
│   └── copyFunctions.ts      # 构建后复制 functions → dist
├── sourceRar/                # 小说 RAR 包（忽略实际文件，仅保留占位符）
├── src/                      # React 前端源码
├── dist/                     # 生产构建结果（自动生成）
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
3. **章节与卷识别**：匹配“第 N 卷/章”“番外”“Book 2”等格式，将上位标题自动拼接到章节标题。
4. **分块写入**：按章节拼接文本生成 `part_001.txt` 等分块（每块 <25 MiB），记录每章在分块中的字节偏移与长度。
5. **紧凑索引**：
   - `public/data/books.json`：以表头 + 行形式存储书籍列表。
   - `public/data/<bookId>_chapters.json`：保存章节条目 `[chapterId, title, assetIndex, start, length]` 与分块路径数组。
6. **增量处理与进度**：基于 SHA-256 判断是否需要重新生成，输出 `[当前/总数]` 进度日志，并清理已被删除书籍的旧资源。

## 本地开发
```bash
npm run preprocess   # 初始化/更新静态数据
npm run dev          # 启动 Vite 开发服务器
npm run typecheck    # TypeScript 类型检查
npm run lint         # ESLint 规则校验
npm run build        # 生产构建（包含 Functions 拷贝到 dist）
```

开发模式下，前端直接读取 `public/data` 与 `public/books`，无需额外 API。

## 构建与部署详解
1. **构建产物**（参考快速开始第 3、4 步）：
   ```bash
   npm run preprocess
   npm run build
   ```
   生成的 `dist/` 目录将包含静态资源以及 `dist/functions/`。

2. **部署到 Cloudflare Pages**：
   ```bash
   npx wrangler pages deploy dist --project-name <your-pages-project>
   ```
   `wrangler` 会同步上传静态文件和 Functions，确保下载接口可用。

## 阅读进度存储说明
- 阅读页加载章节时会将当前书籍、章节及时间戳写入浏览器 `localStorage`。
- 首页显示最近阅读记录，可直接跳转继续阅读；书籍详情页提供一键续读按钮。
- 数据仅存于用户浏览器，清理缓存或更换设备后需要重新阅读生成进度。

## 常见问题

### 为什么整本下载需要 Function？
Cloudflare Pages 对单个静态文件有 25 MiB 限制。下载接口会串流拼接章节分块，既绕过大小限制，也避免生成超大静态文件。

### 章节是如何按需加载的？
预处理时将正文拆分为多个 `part_xxx.txt`，并在章节索引里记录每章所属分块及字节范围。前端只需根据这些元数据发送带 `Range` 头的请求即可获取对应章节，而无需下载整块文件。

### 可以同步阅读进度到云端吗？
当前实现仅使用前端存储。如果需要多设备同步，可在此基础上接入 KV、D1 或第三方服务扩展 API。

### 预处理找不到章节怎么办？
脚本会将整本小说视作单章，并在日志中提示“未检测到任何章节”。可在 `scripts/preprocess.ts` 中扩展匹配规则以兼容更多文本格式。
