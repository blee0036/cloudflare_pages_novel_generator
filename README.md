# 云端小说书架

纯静态的 Web 小说书库：构建期用 Python 把压缩包里的 TXT 切成章节、压成单文件 `.txt.gz`，运行期由浏览器流式解压、章节化渲染，进度精确到段落。没有后端、没有数据库、没有 Cloudflare Functions——部署产物就是一棵静态目录树。

- 构建期（Python）：解压 → 编码归一 → 择一章节规则切分 → 拼音缩写 → 压缩 → 产物自校验 → 增量清单 → 容量护栏
- 运行期（React + TypeScript）：`books.json` 驱动书架，`<id>.txt.gz` 存进 IndexedDB（存原始 gz，不存解压后的字符串），`<id>_toc.json` 提供章节的字符偏移

定位坐标系只有一个：**章号 + 章内字符偏移**。进度恢复、检索跳转、书签跳转三条功能都走 `src/utils/locator.ts`，不使用字节偏移或像素比例。

---

## 环境要求

| 依赖 | 说明 |
| --- | --- |
| Node.js | 本仓库验证于 v24.18.0（npm 11.16.0） |
| Python 3 | 本仓库验证于 3.14.6 |
| Python 包 | `python -m pip install -r scripts/requirements.txt` |
| 解压 `.rar` 的外部工具 | 见下方说明 |

`scripts/requirements.txt` 里的四个包都是**硬依赖**，缺任何一个 `preprocess.py` 在入口就报错退出，不静默降级：

```
charset-normalizer==3.4.8   # 编码探测
pypinyin==0.55.0            # 书名/作者拼音首字母
py7zr==1.0.0                # 解压 .7z
zopfli==0.2.3               # 源包 >10MB 的书用它压 gz
```

`.zip` / `.tar` / `.tar.gz` / `.tgz` 走标准库，无外部依赖。`.rar` 需要一个外部工具，`scripts/lib/archive.py` 按 `unar` → `unrar` → `7z` → `7zz` → `7za` → `bsdtar` → `tar` 的顺序在 PATH 上探测一次，选中后不再回退。Windows 10/11 自带的 `C:\Windows\System32\tar.exe` 即 bsdtar，可读 rar/rar5，无需额外安装；macOS 用 `brew install unar`，Linux 用 `apt install unar`。

---

## 快速开始

```bash
npm install
python -m pip install -r scripts/requirements.txt

# 把小说压缩包放进 zip-novel/，然后跑预处理
npm run preprocess

npm run dev      # http://localhost:3000
npm run build    # 产物在 dist/
```

预处理必须在 `npm run dev` / `npm run build` 之前至少跑一次，否则书架拿不到 `/data/books.json`。

---

## 命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | Vite dev server，端口 3000。`/books/*` 与 `/data/*` 由 Vite 直接从 `public/` 提供 |
| `npm run build` | `vite build`。产物写入 `dist/`，书籍产物以硬链接接入（见「构建与部署」） |
| `npm run preview` | 预览 `dist/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | `eslint .` |
| `npm run test` | `vitest --run`（前端与构建插件的单测） |
| `npm run preprocess` | `python scripts/preprocess.py` |

Python 侧直接调用的入口：

```bash
python scripts/preprocess.py                 # 等价于 python -m scripts.preprocess
python scripts/check_toc.py                  # 章节质量度量，全库
python scripts/check_toc.py --book <id>      # 只量一本
python scripts/check_toc.py --data-dir <path>
python -m pytest scripts/tests -q            # Python 侧单测
```

`check_toc.py` 不评好坏、不重跑管线，只读 `public/data/*_toc.json` 输出一张定宽表（规则名、章数、卷数、章字数分布、疑似误判、标题重复率、是否兜底）。改章节规则表前后各跑一次、diff 两份输出，就是规则改动的前后对比。它的退出码只回答"有没有读到东西"（0 = 读到，1 = 没有数据）。

---

## 目录结构

```
zip-novel/            源压缩包放这里（.zip/.tar/.tar.gz/.tgz/.7z/.rar；目录内容整体 gitignore）
public/books/         产物：<id>.txt.gz            ┐ gitignore
public/data/          产物：<id>_toc.json、books.json ┘
scripts/              预处理管线（Python）
  preprocess.py       编排层：扫描 → 增量判定 → 逐本处理 → 护栏 → 退出码
  check_toc.py        章节质量度量工具
  toc-overrides.json  按 book_id 人工点名章节规则（进版本库）
  requirements.txt    Python 依赖
  lib/                archive / encoding / toc_rules / toc / toc_overrides / pinyin / validate / manifest / report
  tests/              pytest
  fixtures/           切章用的小样本 txt
src/                  前端
  pages/              BookshelfPage、ReaderPage
  components/         书架与阅读器的 UI 组件
  hooks/              useDebouncedValue、useDocumentTitle
  utils/              locator / bookSearch / bookCache / indexedDB / decompress / storage / theme / shortcuts …（同目录 *.test.ts）
  index.css           Tailwind 入口 + 主题 CSS 变量
  types.ts            产物类型，是 scripts/lib/validate.py 的 TypeScript 镜像
build/linkAssets.ts   Vite 插件：把 public/ 硬链接进 dist/，并断言产物顶层无 404.html
vite.config.ts        含 site-config 插件（注入站点标识）
wrangler.toml         Cloudflare Pages 部署配置
site.config.example.json  站点配置样板
.kiro/specs/          需求 / 设计 / 任务文档（gitignore，本地）
.preprocess-manifest.json  增量清单，本机构建状态（gitignore）
```

`public/books/` 与 `public/data/` 都是 gitignore 的**本地产物**，clone 下来后必须自己跑一次预处理。`.preprocess-manifest.json` 描述的正是这两个目录，同样不进版本库。

工作副本里另有三个 gitignore 的目录，与构建无关：`koodo-reader/` 与 `legado/` 是只读的参考实现，`wait-novel/` 是未动用的源包储备池。

---

## 预处理管线

一条流水线，每个环节在 `scripts/lib/` 里，`preprocess.py` 只负责串起来：

```
扫描 zip-novel/ → 增量判定 → 解压出最大的 .txt → 编码探测归一为 UTF-8
  → 采样择一章节规则 → 全文切分（正文命中过滤 + 篇幅门槛）+ 卷标记 → 超长章就地再切 → 兜底
  → 拼音缩写 → 压缩 → 产物自校验 → 更新清单 → 清理失效产物
  → 写 books.json → 汇总 → 容量护栏 → 退出码
```

几条值得知道的行为：

- **书名与作者取自压缩包文件名**，不是包内文件名；包内只解压 `.txt` 成员并取**体积最大**的那个当正文（避开 `readme.txt` 与广告文件）。同名冲突时 `book_id` 加后缀消歧并打告警。
- **逐本容错**：某本书在任一环节抛异常时记录原因并继续下一本，不终止整批。两个例外是"继续跑只会把同一个错误重复几千次"的环境问题——必需依赖缺失、`toc-overrides.json` 里的规则名写错——直接报错退出。
- **增量**：每本成功后立刻把记录落盘，下次运行按"源文件摘要未变、两个产物都还在、**且**清单记录的流水线版本等于当前值"跳过。手工删过产物的书会被重新处理。
- **改了切分逻辑必须 bump `PIPELINE_VERSION`**（`scripts/lib/manifest.py`）：改了 `scripts/lib/toc_rules.py` 的规则表、或 `scripts/lib/toc.py` 的择一/切分/卷标记/兜底逻辑，源文件摘要一个都不会变——不把这个常量 +1，增量运行会跳过全部书、静默发布上一版的切分结果。+1 之后下一次运行重切全库，输出里单独记一笔 `[流水线版本变更] 本次有 N 本…`。反过来，只改日志文案、注释或文档**不要**动它，白 +1 一次就是全库重跑。
- **自校验在写清单之前**：结构坏掉的书不进清单，否则它会带着一条"处理过"的记录被永远跳过。
- **`books.json` 无缩进、不含 `txtPath`/`tocPath`**：两个 URL 由 `id` 派生（`book_id` 即 `书名-作者`，与产物文件名同源）。约束的是客户端 `JSON.parse` 的耗时与常驻内存，不是传输体积——传输由平台压缩解决。
- **压缩器按源包体积二选一**：源包 ≤10MB 用 gzip level 9，>10MB 用 `zopfli.gzip.compress`（输出标准 gzip 流，前端 `DecompressionStream("gzip")` 零改动）。判定输入是源包体积而非产物体积，因为它在解压前就已知。`zopfli` 缺失时报错退出，**不回退 gz9**。
- **章节规则是具名规则表**（`scripts/lib/toc_rules.py`，15 条，顺序即优先级）：对一本书只选用其中一条，不是"套多条取先命中"。其中 `纯序号行`、`顶格短行`、`通用激进` 三条默认关闭、不参与自动判定，只能在 `scripts/toc-overrides.json` 里按 `book_id` 点名启用。规则名写错是硬失败并列出全部合法名。
- **覆盖表有 21 条真实点名**（18 本 `纯序号行`、2 本 `标准章节`、1 本 `顶格短行`），每条都配一个 `// <book_id>` 注释键，记下点名前后的实测（节点数 / 中位节点长度 / 最长节点）。键以 `//` 开头的条目加载时跳过。
- **择一时的两道保险**（`scripts/lib/toc.py`）：
  - **篇幅门槛**（`Coverage`）：命中少于 6 条且平均节点超过 3 万字符，或可读节点（100 < 长度 ≤ 10 万字符）覆盖不到全书 30%，就判"这批命中不是目录"。采样阶段不过关的候选退出竞争、继续看后面的规则；选定后在全书上（正文命中过滤之后）再判一次，不过关就整本走全书兜底（约 5000 字符一块的段落块，`fallback: true`），不回头试次优规则。
  - **装饰降级**：`符号装饰` 的"标题"可能整行都是 `※※※`，它不许取代已经选中的精确规则；原文压根没有标题行的书，它仍可作为唯一候选当选。
- **按书自适应的正文命中过滤**（`toc.filter_prose_hits`）：一本书里形状明确是标题的命中至少 8 条、且 ≥ 90% 顶格时，判定这本书的真标题顶格，**缩进且句子形**（以 `。！？…；` 收尾或含 `，`）的命中被当成正文剔除。标题本来就缩进的书不过滤。
- **卷节点不是零长度节点**：它的 range 恰好覆盖自己的标题行，带 `isVolume: true` 标记。`totalChapters` 只计正文章节；前端把卷渲染成不可点击的分组表头，上下章导航跳过它。

### 容量护栏与退出码

| 阈值 | 行为 |
| --- | --- |
| 源文件 > 30MB | 告警（解压后文本是它的 3–5 倍，且必然走 zopfli，单本约两分钟） |
| 单本 gz 20–25 MiB | 告警，仍然通过 |
| 单文件 > 25 MiB | 硬失败并指明文件（Cloudflare Pages 单文件上限 25 MiB = 26,214,400 B） |
| 产物总文件数 > 20000 | 硬失败（Pages 文件数配额） |

退出码：`0` 通过，`1` 有书处理失败或配置/环境错误，`2` 撞上容量护栏。护栏扫的是整个产物目录而不是"本次处理过的书"——上次留下的、本次被跳过的文件同样占配额。

---

## 前端

路由只有两条，`/` 是书架，`/read/:bookId` 是阅读器，其余路径由前端跳回书架。

- **书架**：`books.json` 驱动，支持模糊搜索（书名/作者原文 + 拼音首字母缩写，如"clks"命中《从零开始》）、按作者名筛选、"加载更多"分批展开、最近在读（最多 5 条）、章节目录弹窗（打开时把当前书籍反映到 URL，浏览器后退即关闭弹窗且不离开书架）。长章节列表与章节网格用自己的窗口化原语（`src/utils/listWindow.ts`，定长行高 + spacer 撑总高），不引虚拟列表库。
- **阅读器**：章节化渲染、全文检索、书签（每章至多一个）、整本下载（由内存中已持有的文本生成 UTF-8 `.txt`，不发任何服务端请求）、排版设置。
- **离线缓存**：IndexedDB `koodo_novel_cache_db`（v2），store `books` 存**原始 gz 二进制**，按最近访问时间 LRU 淘汰，本数上限存在 `ReaderSettings.cacheMaxBooks`（默认 10，取值收拢到 `[1, 50]`），可在设置抽屉里调。不额外设人为的字节总量上限。
- **localStorage 键**：`koodo_novel_reader_settings`、`koodo_novel_progress_<bookId>`（总数上限 50，超限按 `lastReadTime` 淘汰最旧）、`koodo_novel_bookmarks_<bookId>`。
- **快捷键**：`←`/`→` 上一章/下一章，`Space`/`Shift+Space` 下翻/上翻，`Home`/`End` 章首/章末，`T` 目录，`F` 检索，`S` 设置，`Esc` 关闭面板。焦点在输入类元素上、带 Ctrl/Alt/Meta、或 `Space` 落在按钮上时一律不接管。

### 主题：Tailwind v4 的 CSS-first 用法

**本仓库没有 `tailwind.config.js`，也不需要。** Tailwind v4 通过 PostCSS 插件 `@tailwindcss/postcss`（见 `postcss.config.js`）接入，入口是 `src/index.css` 顶部的 `@import "tailwindcss"`。

主题由根元素上的 `data-theme` 属性 + CSS 自定义属性实现，`src/utils/theme.ts` 在首屏渲染前写入该属性。五套主题（`default` / `sepia` / `eyecare` / `dark` / `black`）各是 `src/index.css` 里的一个 `[data-theme="..."]` 块，每块声明同一组变量并带上 `color-scheme`（明亮三套 `light`，深色两套 `dark`，原生控件跟着同一个开关走）。

选择器刻意写成 `[data-theme="..."]` 而不是 `:root[data-theme="..."]`：任何元素带上该属性都能就地重声明整组变量，其子树随之换色。设置抽屉里同时显示五个主题色块就是靠这一点——组件不接收任何主题 prop，颜色值也不必搬回 TS。

---

## 站点配置（可选）

仓库根的 `site.config.json` 可覆盖站点名、简介、关键词、favicon，样板见 `site.config.example.json`：

```json
{
  "name": "云端小说书架",
  "description": "纯静态的 Web 小说书库：单书 Gzip 压缩存储，浏览器流式解压，章节化阅读与精确续读。",
  "keywords": ["小说", "在线阅读", "电子书", "静态网站", "Cloudflare Pages"],
  "favicon": "/favicon.svg"
}
```

- 文件**不存在是正常分支**，用 `src/utils/siteConfig.ts` 里的内置默认值，一个字也不打印。默认 favicon 是一段自包含的 SVG data URI，不引用任何文件。
- 文件存在但不是合法 JSON 是**硬失败**——静默回落成默认站名会让人带着一份自认为生效了的配置部署上线。字段级问题（类型写错、键名拼错）逐字段回落并打告警。
- `favicon` 写成相对路径时，该文件必须真实存在于 `public/` 下，否则构建报错。**样板里的 `/favicon.svg` 在本仓库并不存在**，照抄后需要自己往 `public/` 放一个同名文件，或改用 data URI / 绝对 URL。
- `site.config.json` **刻意不在 `.gitignore` 里**：它是部署的一部分，构建期注入进 `index.html` 的 `%SITE_*%` 占位符与 `__SITE_CONFIG__`。忽略掉会让 Pages 的 CI 读不到它，从而静默用默认值发布。
- 改动 `site.config.json` 会重启 dev server（站点名进了 HTML 与 `define`，两者都只在启动时算一次）。

---

## 构建与部署

### 硬链接接入，不复制

`vite.config.ts` 设 `build.copyPublicDir: false`，`build/linkAssets.ts` 在 `closeBundle` 阶段把整棵 `public/` 树**硬链接**进 `dist/`。

理由是体量：`public/` 下是预处理生成的整个书库，逐字节复制进 `dist/` 等于磁盘上存两份、每次构建再付一遍 I/O。反过来也不能让预处理直接写 `dist/`——`emptyOutDir` 会清空它，那意味着每次构建前都得重新预处理。**预处理只写 `public/`，永不写 `dist/`。**

两条必须知道的后果：

- **`public/` 与 `dist/` 必须在同一个文件系统卷。** 跨卷时 `link(2)` 返回 `EXDEV`，构建**带着明确错误停下，不静默退回复制**（退回等于把书库在磁盘上存成两份，正是这套机制要消除的开销）。FAT/exFAT、部分网络盘与容器挂载点不支持硬链接，同样会失败。
- **接入范围是整个 `public/`**，不只是 `books/` 与 `data/`：`copyPublicDir: false` 关掉的是全部 `public/` 内容，漏掉根下的 `robots.txt`、`icon.png` 会表现为"本机 dev 正常、线上 404"。

`npm run dev` 不受影响：`copyPublicDir` 只作用于构建，dev 下 Vite 仍直接从 `public/` 提供 `/books/*` 与 `/data/*`。

### 平台约束（两条，都会表现为"首页正常、深链接 404"）

**1. 产物顶层不得存在 `404.html`。** Cloudflare Pages 只在顶层不存在 `404.html` 时才按单页应用处理请求、把未命中的路径交给 `/`；一旦顶层出现 `404.html`，它改为按目录树返回最近的 404 页，`BrowserRouter` 的深链接 `/read/<id>` 当场失效。本仓库当前**没有**这个文件，`linkAssets` 插件在 `closeBundle` 里断言顶层没有它（比较时统一小写，因为 Windows 文件系统大小写不敏感），撞上即构建失败。未匹配的路由已由前端统一跳回书架，不需要这个文件。

**2. 若要用 `_redirects`，规则必须窄化到 `/read/*`，不可用 `/*`。** Pages 的重定向**总是被执行，与请求是否命中静态资源无关**，所以 `/* /index.html 200` 会连带劫持 `/data/*.json` 与 `/books/*.txt.gz`，返回 `index.html` 而不是资源本身。本仓库当前**没有** `_redirects` 文件，靠的是上面那条默认 SPA 回退；只有在需要显式声明回退时才加它，并且只写应用路由前缀。

### 部署

`wrangler.toml` 只有两项，有了它们 `wrangler pages deploy` 不带参数就能跑：

```toml
name = "novel-pages"
pages_build_output_dir = "./dist"
```

`pages_build_output_dir` 必须与 `vite.config.ts` 的 `build.outDir` 保持一致（均为 `dist`）。刻意不写 `compatibility_date`、绑定与 `[env.*]`：本站是纯静态站点，没有运行时代码会读它们。

`.txt.gz` 依赖平台按静态资源原样返回，前端用 `DecompressionStream("gzip")` 解压；`books.json` 不预压缩，依赖 Pages 自动 gzip/brotli。首次部署后值得核对一次 Pages 对 `.txt.gz` 返回的 `Content-Type` 与 `Content-Encoding`——它决定 `loadGzipBookText` 走哪条分支（HTTP 层已透明解压时不能再解一次）。

---

## 检查与测试

```bash
npm run typecheck                  # tsc --noEmit
npm run lint                       # eslint .
npm run build                      # 含顶层 404.html 断言
npm run test                       # vitest --run
python -m pytest scripts/tests -q
```

当前基线：Vitest 19 个文件 / 469 项通过，pytest 1834 项通过 / 1 项跳过，四条 npm 门全部退出码 0。

前端单测与源文件同目录（`src/utils/*.test.ts`），构建插件的测试在 `build/linkAssets.test.ts`。不搭 jsdom：组件里的 DOM 事件不在测试范围内，需要钉住的判定逻辑（定位、检索、快捷键映射、缓存淘汰、设置读写）都抽成了纯函数。
