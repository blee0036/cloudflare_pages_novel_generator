<p align="center">
  <img src="public/favicon.svg" width="120" height="120" alt="CloudflarePagesNovel 的图标：一只扒着书读的蓝猫">
</p>

<h1 align="center">CloudflarePagesNovel</h1>

<p align="center">
  把一堆小说压缩包变成一个在浏览器里读的书库，打包成纯静态网站，直接部署到 Cloudflare Pages。
</p>

<p align="center">
  React 18 · TypeScript · Vite 6 · Tailwind CSS 4 · Python 3 · Cloudflare Pages
</p>

<p align="center">
  <img src="e2e/baselines/px-shelf-desktop-win32.png" width="860" alt="书架首页：顶部是站名和检索框，下面是一条介绍横幅，再往下是四列书卡，每张卡片有书名、作者、章数、字数和“章节目录”“开始阅读”两个按钮">
</p>

<p align="center"><sub>本文所有截图都是 E2E 的像素基线。书名、作者和正文由测试脚本随机合成，不是真实作品。</sub></p>

---

## 目录

- [这是什么](#这是什么)
- [界面一览](#界面一览)
- [准备环境](#准备环境)
- [快速上手](#快速上手)
- [管理书库](#管理书库)
- [常用命令](#常用命令)
- [预处理具体做了什么](#预处理具体做了什么)
- [章节识别](#章节识别)
- [网站功能](#网站功能)
- [站点配置（可选）](#站点配置可选)
- [构建与部署](#构建与部署)
- [开发](#开发)
- [E2E 测试](#e2e-测试)
- [关于内容与版权](#关于内容与版权)

---

## 这是什么

你把小说压缩包（`.zip`、`.rar`、`.7z` 等）放进 `zip-novel/`，跑一条命令，每本书会被：

- 解压，自动识别编码，统一转成 UTF-8；
- 自动切出章节目录，"第一卷"这类分卷也能认出来；
- 压成一个 `.txt.gz`，再配一份章节目录 `_toc.json`；
- 汇总进一份全库书单 `books.json`。

然后 `npm run build` 打包成网站。网站没有后端、没有数据库，就是一堆静态文件：

- **浏览器自己解压**：下载 `.txt.gz` 后用 `DecompressionStream` 流式解压，按章显示，大书也有加载进度。
- **续读精确到段落**：阅读进度、书签、检索跳转都记"第几章 + 章内第几个字"，换字号、换设备也能回到同一段。
- **能离线**：读过的书原样存进 IndexedDB，下次打开不再下载。
- **搜得到**：书架按书名、作者或拼音首字母模糊搜索，阅读器里能全文检索。
- **读得舒服**：五套主题，字号、行高、字间距、版心宽度都可调，手机上也能用。

网站上默认显示的站名是"云端小说书架"，可以在[站点配置](#站点配置可选)里改。

项目分两半：

| | 干什么 | 语言 | 代码 |
| --- | --- | --- | --- |
| 预处理 | 把压缩包变成书库文件 | Python | `scripts/` |
| 网站 | 书架 + 阅读器 | React + TypeScript | `src/` |

---

## 界面一览

<table>
  <tr>
    <td width="50%"><img src="e2e/baselines/px-reader-sepia-win32.png" alt="阅读器，复古羊皮主题：顶栏是返回、书名、已读百分比和书签、目录、检索、设置、全屏五个按钮，中间是章节标题“楔子”和正文，底栏是上一章、目录、章节进度滑杆、全书搜索和下一章"></td>
    <td width="50%"><img src="e2e/baselines/px-settings-drawer-win32.png" alt="阅读设置抽屉：五个主题色块，字号、字体、行高、字间距、版心宽度的滑杆，离线缓存占用与上限，以及下载整本"></td>
  </tr>
  <tr>
    <td><b>阅读器</b>：按章显示。顶栏和底栏放常用操作，停止操作 4.5 秒后自动隐藏。</td>
    <td><b>阅读设置</b>：主题、字号、字体、行高、字间距、版心宽度、离线缓存、下载整本。</td>
  </tr>
  <tr>
    <td><img src="e2e/baselines/px-toc-volumes-win32.png" alt="目录抽屉：顶部是书名、章节目录与我的书签两个页签和章节搜索框；列表里“第一卷 云起”等卷标题是带竖线的分组表头，当前章“楔子”用更深的底色和强调色标出"></td>
    <td><img src="e2e/baselines/px-search-results-win32.png" alt="全书内容检索抽屉：检索框里是“琉璃盏”，下方显示找到 7 条匹配，每条结果有章节名和带高亮命中词的上下文"></td>
  </tr>
  <tr>
    <td><b>目录</b>：分卷显示成不能点的分组表头，当前章另有底色，还能按章名过滤、管理书签。</td>
    <td><b>全书检索</b>：命中词高亮，点一条直接跳到那一段，正文里的命中处高亮 5 秒。</td>
  </tr>
  <tr>
    <td><img src="e2e/baselines/px-detail-modal-win32.png" alt="书架上的章节目录弹窗：书名、作者、章数、字数和压缩后大小，一个章节过滤框和“从第 1 章开始阅读”按钮，下面两列列出全部章节和卷"></td>
    <td><img src="e2e/baselines/px-reader-dark-win32.png" alt="阅读器，暗色夜间主题：深蓝灰底、浅色正文，布局与复古羊皮主题相同"></td>
  </tr>
  <tr>
    <td><b>章节目录弹窗</b>：不进阅读器就能看全书目录、挑一章开读，浏览器后退即关闭。</td>
    <td><b>暗色夜间</b>：五套主题之一，顶栏、底栏和抽屉跟着一起换色。</td>
  </tr>
</table>

**手机上**

<p>
  <img src="e2e/baselines/px-shelf-mobile-win32.png" width="260" alt="手机上的书架：站名和检索框在顶部，介绍横幅与藏书数纵向排列，书卡单列显示">
  &nbsp;&nbsp;
  <img src="e2e/baselines/px-reader-mobile-win32.png" width="260" alt="手机上的阅读器：顶栏只留返回、书签、目录、检索、设置，底栏的上一章、目录、进度滑杆、检索、下一章五个控件都完整显示在屏幕内">
</p>

**五套主题**

<table>
  <tr>
    <td><img src="e2e/baselines/px-reader-default-win32.png" alt="默认明亮主题的阅读器：白底深灰字"></td>
    <td><img src="e2e/baselines/px-reader-sepia-win32.png" alt="复古羊皮主题的阅读器：米黄底深褐字"></td>
    <td><img src="e2e/baselines/px-reader-eyecare-win32.png" alt="护眼豆绿主题的阅读器：浅绿底深绿字"></td>
    <td><img src="e2e/baselines/px-reader-dark-win32.png" alt="暗色夜间主题的阅读器：深蓝灰底浅灰字"></td>
    <td><img src="e2e/baselines/px-reader-black-win32.png" alt="极夜纯黑主题的阅读器：纯黑底灰字"></td>
  </tr>
  <tr>
    <td align="center">默认明亮</td>
    <td align="center">复古羊皮（默认）</td>
    <td align="center">护眼豆绿</td>
    <td align="center">暗色夜间</td>
    <td align="center">极夜纯黑</td>
  </tr>
</table>

截图在 Windows 上用 Chromium 拍摄，取自 `e2e/baselines/`。界面改动后跑 `npm run e2e:update` 重新生成基线，这里的图会跟着更新（见[像素基线](#像素基线)）。

---

## 准备环境

| 需要 | 说明 |
| --- | --- |
| Node.js | 20.19 以上、22.13 以上或 24 以上（ESLint 10 的 `engines` 要求最严；Vitest 4 不支持 21、23）。验证过的版本：v24.18.0（npm 11.16.0） |
| Python 3 | 验证过的版本：3.14.6 |
| Python 包 | `python -m pip install -r scripts/requirements.txt` |
| 解压 `.rar` 的工具 | 见下文 |

```
charset-normalizer==3.4.8   # 识别文本编码
pypinyin==0.55.0            # 书名、作者的拼音首字母（搜索用）
py7zr==1.0.0                # 解压 .7z
zopfli==0.2.3               # 压缩大于 10MB 的书
```

`.zip`、`.tar`、`.tar.gz`、`.tgz` 用 Python 自带功能解压。`.rar` 要借外部工具，预处理会在 PATH 里按 `unar` → `unrar` → `7z` → `7zz` → `7za` → `bsdtar` → `tar` 的顺序找第一个能用的：

- **Windows 10/11**：系统自带的 `C:\Windows\System32\tar.exe` 就能解 rar/rar5，不用装别的。
- **macOS**：`brew install unar`
- **Linux**：`apt install unar`

---

## 快速上手

```bash
npm ci                                            # 按 package-lock.json 原样安装
python -m pip install -r scripts/requirements.txt

# 1. 把小说压缩包放进 zip-novel/
# 2. 生成书库。第一次比较久，之后只处理有变化的书
npm run preprocess
# 3. 本地预览：http://localhost:3000
npm run dev
# 4. 打包网站，结果在 dist/
npm run build
# 5. 把 dist/ 部署到 Cloudflare Pages（第一次要登录，见"部署"一节）
npx wrangler pages deploy
```

`dev` 和 `build` 之前至少要跑过一次预处理，否则书架是空的（找不到 `/data/books.json`），页面上会显示"加载遇到问题"和"重新加载"按钮。

---
## 管理书库

### 加书、换新版本

把压缩包放进（或覆盖进）`zip-novel/`，再跑 `npm run preprocess`。它会比对每个文件的指纹（SHA-256），只处理新增的和内容变了的，其余跳过。

书名和作者取自**压缩包的文件名**，推荐 `《书名》作者：某某.rar` 这种写法。包里有好几个 `.txt` 时，取最大的那个当正文，避开 readme 和广告文件。

两本书算出同一个 id（书名和作者都一样）时，后来的那本自动加 `_2`、`_3` 后缀，并打一条提示。id 一旦分配就不再变，新来的书不会挤掉老书的名字。

### 处理完就删源包，省磁盘

```bash
npm run preprocess-clean
```

和 `preprocess` 一样，但每本书的文件都写好、检查通过、记进清单之后，就删掉它在 `zip-novel/` 里的压缩包。以前已经处理过的书这次也会顺手删掉，所以对现有书库跑一次就能把 `zip-novel/` 腾空。

这两种情况不删：

- 这本书处理失败了；
- 压出来的文件超过 25 MiB（部署不上去，之后换压缩方式重压还要用原包）。

**源包删了，书不会从网站上消失。**`zip-novel/` 只是"待处理的输入"，不是书库的名单。

### 删掉一本书

删掉它的两个文件：`public/books/<id>.txt.gz` 和 `public/data/<id>_toc.json`；源包还在的话也一起删。下次跑预处理，这本书就会从书单和清单里去掉。

如果只删了 `.txt.gz`、留着 `_toc.json`，这本书会暂时移出书单并打提示；把源包放回 `zip-novel/` 重跑就能恢复。

### 给压缩包改名

内容不变、只改文件名，预处理能认出来（指纹相同），沿用原来的 id，不重新处理。

### 别删 `.preprocess-manifest.json`

这是预处理的账本，记着每本书的指纹、id、字数、章数、用的压缩方式。它决定哪些书可以跳过；源包删掉之后，书单里这本书的信息也全靠它。

所以用过 `preprocess-clean` 之后，它就不再是能随手重建的缓存了，建议和 `public/` 一起备份。万一丢了，已删源包的书会从书单里消失（文件还在磁盘上），预处理最后会列出这些"有文件、没记录"的书提醒你。从备份恢复清单后重跑即可。

---

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run preprocess` | 生成或更新书库 |
| `npm run preprocess-clean` | 同上，每本处理完删掉源压缩包 |
| `npm run dev` | 本地开发服务器，端口 3000 |
| `npm run build` | 打包网站到 `dist/` |
| `npm run preview` | 本地预览 `dist/` |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm run lint` | ESLint |
| `npm run test` | 前端和构建插件的单测（Vitest） |
| `npm run e2e` 等 | 浏览器里的 E2E 测试，见 [E2E 测试](#e2e-测试) |

也可以直接调 Python：

```bash
python scripts/preprocess.py                 # = npm run preprocess
python scripts/preprocess.py --delete-source # = npm run preprocess-clean
python scripts/check_toc.py                  # 全库章节质量报表
python scripts/check_toc.py --book <id>      # 只看一本
python scripts/check_toc.py --data-dir <path>
python -m pytest scripts/tests -q            # Python 单测
```

---

## 预处理具体做了什么

每本书依次：

1. 解压，取最大的 `.txt`；
2. 识别编码：先看文件头的 BOM，再自动探测，最后拿候选编码把全文试解一遍、确认没有乱码，统一成 UTF-8；
3. 切章节（见下一节）；
4. 生成书名、作者的拼音首字母，用来搜索，比如输入 `qstxx` 能搜到《青山踏雪行》；
5. 压成 `.txt.gz`；
6. 检查生成的两个文件格式对不对；
7. 记进清单。

全部处理完，再处理源包已删除的书，写出 `books.json`，打印汇总，最后检查容量。

### 一本出错不耽误别的

某本书在任何一步出错，记下原因，接着处理下一本。汇总里逐条列出失败的书和原因，退出码为 1。失败的书这次不进书单。

只有三种情况会直接停下：缺 Python 依赖、缺解压 rar 的工具、`toc-overrides.json` 里写错了规则名。这些是环境或配置问题，继续跑只会每本都报同一个错。

### 什么时候跳过一本书

三条同时满足才跳过：

- 压缩包指纹和上次一样；
- 两个生成文件都还在，而且不是空文件；
- 上次是用当前版本的切章逻辑处理的（`PIPELINE_VERSION`，见下一节）。

手动删过生成文件的书会重新处理。格式检查没通过的书不会记进清单，下次会重来。

### 源包已删除的书

| 情况 | 预处理怎么做 |
| --- | --- |
| 两个文件都在 | 照常进书单，不逐本打印，汇总里记"归档 N 本" |
| 切章逻辑升级了，或 `_toc.json` 丢了 | 从 `.txt.gz` 解出全文，只重新切章节，`.txt.gz` 不动 |
| `.txt.gz` 丢了 | 正文没法恢复：打提示、不进书单、清单保留记录，放回源包就能重建 |
| 两个文件都没了 | 当作这本书已删除，从清单里去掉 |

### 压缩方式

源包不超过 10MB 用 gzip 最高级（9 级）；超过 10MB 用 zopfli，能再省 8% 左右，但慢得多，一本大书可能要两分钟。按源包大小来选，是因为解压之前就知道它多大。

两种方式都输出标准 gzip，浏览器那边解压方式完全一样。zopfli 没装就报错退出，不会悄悄退回 gzip：那样可能产出超过 25 MiB、部署不上去的文件。

### 容量限制与退出码

Cloudflare Pages 单个文件最大 25 MiB，总共最多 20000 个文件。每本书占 2 个文件，所以大约 9999 本就到顶了。

| 情况 | 结果 |
| --- | --- |
| 源压缩包 > 30MB | 提示（解压后是它的 3 到 5 倍，而且一定走 zopfli，会比较慢） |
| 某本书的 `.txt.gz` 在 20 到 25 MiB 之间 | 提示，照样通过 |
| 任一文件 > 25 MiB | 失败，并指出是哪个文件 |
| 文件总数 > 20000 | 失败 |

检查范围是 `public/books` 和 `public/data` 下的所有文件，不只是这次处理的书。源包删除不会自动清理文件，书库只会越来越大，快到 20000 个文件时要自己删掉不要的书。

退出码：`0` 一切正常；`1` 有书处理失败，或配置、环境有问题；`2` 超出容量限制，这批文件部署不上去。

### `books.json` 长什么样

每本书一条，只有 id、书名、作者、拼音缩写、字数、章数、`.txt.gz` 大小。没有缩进，按源文件名排序。两个文件的地址由 id 拼出来，所以不单独存路径；id 由书名和作者拼成（如 `《青石巷》作者：夜行.zip` 得到 `青石巷-夜行`），特殊符号换成下划线。

这个文件不预先压缩，传输时交给 Pages 自动压缩。去掉缩进是为了让浏览器解析 7000 本的书单更快、占内存更少。

---

## 章节识别

每本书只选**一条**规则来切章，不是几条规则一起上。规则表在 `scripts/lib/toc_rules.py`，共 15 条，排在前面的优先。其中 `纯序号行`、`顶格短行`、`通用激进` 三条太容易误判，默认不用，只能在覆盖表里点名给某本书用。

选规则时有几道把关：

- **得像一份目录**：命中太少又隔得太远（少于 6 条、平均每章超过 3 万字），或者长度正常的章节（100 字到 10 万字之间）加起来不到全书 30%，就认为这批"标题"不是真目录，换下一条规则。选定后在全书上再核一次，还不行就整本按约 5000 字一段切开，标上 `fallback: true`。
- **分隔线不抢位**：`符号装饰` 规则可能把 `※※※` 这种分隔线当成标题，所以它不能顶替已经选中的正经规则。全书真的没有标题行时，才会用它。
- **剔除正文里的误命中**：一本书里明确的标题至少 8 条、90% 以上顶格写，那么缩进、又像句子（以 `。！？…；` 结尾或带逗号）的命中就当正文剔掉。标题本来就缩进写的书不做这一步。
- **超长章再切**：个别章节太长时就地再切开，其他章节不受影响。
- **分卷**：`第一卷` 这类卷标题单独成一个节点，标 `isVolume: true`，只占它自己那一行。章数 `totalChapters` 不算卷；阅读器里卷显示成不能点的分组标题，上一章、下一章会跳过它。

### 自动选错了怎么办

在 `scripts/toc-overrides.json` 里按 id 指定规则。现在有 21 条（18 本 `纯序号行`、2 本 `标准章节`、1 本 `顶格短行`），每条旁边有一个以 `// <id>` 为键的注释条目，记着指定前后的效果对比。`//` 开头的键加载时会跳过。规则名写错会直接报错，并列出所有合法的名字。

### 改了切章逻辑，一定要把 `PIPELINE_VERSION` +1

它在 `scripts/lib/manifest.py`。清单判断"要不要重新处理"只看源文件指纹，而改规则不会改变任何源文件。改了 `toc_rules.py` 或 `toc.py` 的切章逻辑却不 +1，预处理会把所有书都跳过，网站上还是旧的切章结果，日志里却一切正常。

+1 之后下次运行会重切全库（源包已删的书从 `.txt.gz` 重切），输出里会有一行 `[流水线版本变更] 本次有 N 本…`。

反过来，只改提示文案、注释、文档就别动它，白 +1 一次就是全库重跑好几个小时。

### 看改动效果

`check_toc.py` 只读 `public/data/*_toc.json`，打一张表：规则名、章数、卷数、章节字数分布、疑似误判、标题重复率、是否整本兜底。它不评好坏，也不重跑预处理。退出码 0 表示读到了数据，1 表示没读到。

```bash
python scripts/check_toc.py > before.txt
# 改规则，PIPELINE_VERSION +1，然后 npm run preprocess
python scripts/check_toc.py > after.txt
# 对比 before.txt 和 after.txt
```

---
## 网站功能

只有两个页面：`/` 是书架，`/read/<id>` 是阅读器，其他地址一律跳回书架。

### 书架

- 模糊搜索：书名、作者原文都能搜，拼音首字母也行；
- 按作者筛选，"加载更多"分批展开；
- 最近在读，最多 5 本；
- 章节目录弹窗：打开时地址栏会带上 `?book=<id>`，按浏览器后退就关掉弹窗，不会离开书架。

长列表只渲染看得见的那一段（`src/utils/listWindow.ts`，自己写的，没引虚拟列表库）。

### 阅读器

- 按章显示，全文检索，书签（每章最多一个）；
- 地址栏的 `?ch=` 始终是当前章。换章时替换当前历史记录、不多出后退步骤，复制链接就能直接分享到这一章；
- 下载整本书：用已经在内存里的文本生成 UTF-8 `.txt`，不再请求服务器；
- 排版设置与五套主题，可调范围见下表。

| 设置 | 范围 | 步长 | 默认 |
| --- | --- | --- | --- |
| 字号 | 14–36 px | 1 | 19 px |
| 行高 | 1.4–2.5 倍 | 0.05 | 1.85 倍 |
| 字间距 | 0–4 px | 0.5 | 1 px |
| 版心宽度 | 600–1200 px | 20 | 820 px |
| 离线缓存上限 | 1–50 本 | 1 | 10 本 |

另有三种字体：系统黑体、宋体/明体、楷体/手写。存下来的设置每次读出时都会归一：不是数字的换回默认值，越界的夹到两端，不在步长网格上的取最近的格点。

### 快捷键

| 键 | 作用 |
| --- | --- |
| `←` / `→` | 上一章 / 下一章 |
| `↑` / `↓` | 向上 / 向下滚一行（40 px） |
| `PageUp` / `PageDown` | 向上 / 向下滚一屏 |
| `Space` / `Shift+Space` | 向下 / 向上翻一屏（相邻两屏留 64 px 重叠）；已到章末时再按 `Space` 进入下一章 |
| `Home` / `End` | 章首 / 章末 |
| `T` | 目录 |
| `F` | 检索 |
| `S` | 设置 |
| `Esc` | 关闭面板 |

这些情况下快捷键不生效：焦点在输入框或滑杆里，按着 Ctrl/Alt/Meta，焦点在按钮上按空格。目录、检索、设置面板打开时，滚动类按键留给面板自己的列表。`↑`、`↓`、`PageUp`、`PageDown` 到了章首或章末就停住，不会换章。

### 加载出错时

| 页面 | 显示 | 说明文字 |
| --- | --- | --- |
| 阅读器 | "未能打开书籍"和"返回书架" | 按原因四选一：书库里找不到这本书、暂时连不上书库、正文文件缺失或损坏、其他问题 |
| 书架 | "加载遇到问题"和"重新加载" | 按原因三选一：找不到书库目录、暂时连不上书库、其他问题 |

页面上只显示固定的中文说明。原始错误写进浏览器控制台，一行，以 `[load-error]` 开头，带出错阶段、书 id 和 HTTP 状态，排查时看这一行就够了。

### 数据存在浏览器哪里

- **书的缓存**：IndexedDB `koodo_novel_cache_db`（v2）的 `books` 表，存下载下来的 `.txt.gz` 原样，不存解压后的文字。按最近读的时间淘汰，默认留 10 本，可在设置里改成 1 到 50。
- **设置、进度、书签**：localStorage 的 `koodo_novel_reader_settings`、`koodo_novel_progress_<id>`、`koodo_novel_bookmarks_<id>`。进度最多记 50 本，超了删最久没读的。

阅读进度、检索跳转、书签跳转用的是同一种定位："第几章 + 章内第几个字"，都走 `src/utils/locator.ts`。不用字节位置，也不用滚动比例，所以换字号、换设备也能回到同一段。重新打开时，地址栏的 `?ch=` 若正好是上次读到的那一章，就回到章内原来的位置；指向别的章，则从那一章章首开始。

---

## 站点配置（可选）

仓库根目录放一个 `site.config.json`，可以改站点名、简介、关键词和图标。样板是 `site.config.example.json`：

```json
{
  "name": "云端小说书架",
  "description": "纯静态的 Web 小说书库：单书 Gzip 压缩存储，浏览器流式解压，章节化阅读与精确续读。",
  "keywords": ["小说", "在线阅读", "电子书", "静态网站", "Cloudflare Pages"],
  "favicon": "/favicon.svg"
}
```

- **没有这个文件也行**，用内置默认值，什么都不打印。默认图标是一个 📖。想用仓库自带的蓝猫（`public/favicon.svg`），把样板复制一份就行：`Copy-Item site.config.example.json site.config.json`（macOS/Linux 用 `cp`）。
- **文件写坏了（不是合法 JSON）会让构建失败。**悄悄退回默认站名的话，你会带着一份以为生效了的配置上线。单个字段写错（类型不对、键名拼错）只退回那个字段的默认值，并打提示。
- **图标写成路径时，文件必须在 `public/` 下真实存在**，否则构建报错。也可以写 data URI 或完整网址。
- **这个文件要提交进仓库**，别加进 `.gitignore`：Pages 在云端构建时要读它，读不到就用默认值发布。
- 改了它，开发服务器会自动重启。

---

## 构建与部署

### 书库文件是硬链接进 `dist/` 的，不是复制

`public/` 下是整个书库，现在有二十多 GB。构建时要是再复制一份进 `dist/`，磁盘上就存了两份，每次构建还得再写一遍。所以 `vite.config.ts` 关掉了 Vite 自带的复制（`copyPublicDir: false`），改由 `build/linkAssets.ts` 把整个 `public/` 硬链接进 `dist/`。预处理只写 `public/`，从不碰 `dist/`，因为每次构建都会清空 `dist/`。

这样做有两个后果：

- **`public/` 和 `dist/` 必须在同一个磁盘分区上。**跨分区没法硬链接，构建会带着明确的错误停下，不会偷偷退回复制。FAT/exFAT、一些网络盘和容器挂载目录也不支持硬链接。
- **链接的是整个 `public/`**，不只是 `books/` 和 `data/`。放在 `public/` 根下的其他文件（比如 `favicon.svg`）一样会进 `dist/`。

`npm run dev` 不受影响，开发时 Vite 直接从 `public/` 读文件。

### 两个会让"打开书的链接 404"的坑

- **`dist/` 顶层不能有 `404.html`。**Pages 只在没有这个文件时，才会把找不到的地址交给首页、由前端处理。一旦有了它，直接打开 `/read/<id>` 就是 404。构建插件会检查这件事，发现就失败。前端已经会把未知地址跳回书架，用不着这个文件。
- **要写 `_redirects` 的话，只能写 `/read/*`，不能写 `/*`。**Pages 的重定向规则不管文件存不存在都会生效，`/* /index.html 200` 会把 `/data/*.json` 和 `/books/*.txt.gz` 也返回成首页。现在仓库里没有 `_redirects`，靠的是上面那条默认行为。

### 部署

先打包，再上传：

```bash
npm run build
npx wrangler pages deploy
```

`npx wrangler pages deploy` 不用带参数，因为 `wrangler.toml` 里已经写好了传哪个目录、传给哪个项目：

```toml
name = "novel-pages"                # Pages 上的项目名，网址是 novel-pages.pages.dev
pages_build_output_dir = "./dist"   # 上传这个目录
```

把参数写全就是：

```bash
npx wrangler pages deploy dist --project-name novel-pages
```

**第一次部署**

- 会打开浏览器让你登录 Cloudflare 账号（也可以先单独跑 `npx wrangler login`）。
- Pages 上还没有这个项目的话，会提示你创建，问生产分支时填 `main`。之后的部署都沿用这些设置。
- 要上传整个书库，现在大约 1.5 万个文件、二十多 GB，会比较久。之后再部署，没变的文件不会重传，只传新增和改动的书。

**其他**

- wrangler 没装进项目依赖，`npx` 每次用的是最新版，它要求 Node.js 22 或更高。想固定版本，就写成 `npx wrangler@4.143.0 pages deploy`。
- 想先传一个预览版、不动正式站：`npx wrangler pages deploy --branch preview`，会得到一个单独的预览网址。
- 部署上去的站点是公开的，没有登录，拿到网址的人都能看、能下载整本书。只想自己看的话，可以在 Cloudflare 后台用 Cloudflare Access 给它加一道登录。
- `pages_build_output_dir` 要和 `vite.config.ts` 里的 `build.outDir` 一致（都是 `dist`）。`wrangler.toml` 没写 `compatibility_date`、绑定和 `[env.*]`，因为这是纯静态站，没有服务端代码会用到它们。

**第一次部署后，检查一下 `.txt.gz` 的响应头**（`Content-Type` 和 `Content-Encoding`）。如果 Pages 在传输时已经帮浏览器解压了，前端（`loadGzipBookText`）会走不再解压的那条分支，值得确认一次两边对得上。

---
## 开发

### 目录结构

```
zip-novel/                  放源压缩包（内容不进 git）；处理完可以删
public/
  books/                    生成的 <id>.txt.gz（不进 git）
  data/                     生成的 <id>_toc.json 和 books.json（不进 git）
  favicon.svg               站点图标
scripts/                    预处理（Python）
  preprocess.py             主流程
  check_toc.py              章节质量报表
  toc-overrides.json        按书指定切章规则（进 git）
  requirements.txt          Python 依赖
  lib/                      各环节：解压、编码、切章规则、切章、拼音、格式检查、清单、汇总
  tests/                    pytest
  fixtures/                 切章测试用的小样本（为测试专门写的文本）
src/                        网站（React + TypeScript）
  pages/                    书架页、阅读页
  components/               界面组件
  hooks/                    自定义 hooks
  utils/                    定位、检索、缓存、解压、存储、主题、快捷键、翻页滚动、
                            设置归一、URL 章号、加载错误分类、对比度等，单测放在同目录
  index.css                 Tailwind 入口和主题变量
  types.ts                  生成文件的类型定义，与 scripts/lib/validate.py 对应
build/linkAssets.ts         构建插件：硬链接 public/，检查 404.html
e2e/                        E2E 测试（Playwright），见"E2E 测试"一节
  tests/                    用例：common/（两种书库都跑）、fixture/、real/、tooling/ 等
  support/                  定位器、夹具、阅读器辅助、运行汇总（reporter）
  server/                   本地静态服务器与自检
  fixture/                  夹具书库的合成脚本（进 git）
  visual/                   像素基线的定义
  baselines/                像素基线（进 git，本文的截图就是它们）
  review/                   评审截图的清单与评审报告
  perf/                     性能读数
  a11y/                     无障碍扫描的定义、执行与汇总
  acceptance/               验收与收尾核对脚本（Python，只用标准库）
  run.mjs                   E2E 入口
  .out/                     运行产物（不进 git）
vite.config.ts              Vite 配置，含站点配置插件
vitest.config.ts            Vitest 配置，不收 e2e/
playwright.config.ts        Playwright 配置
wrangler.toml               Cloudflare Pages 部署配置
site.config.example.json    站点配置样板
.preprocess-manifest.json   预处理清单（不进 git，要备份）
.kiro/specs/                需求、设计、任务文档（本地）
```

另有三个不进 git、和构建无关的目录：`koodo-reader/` 和 `legado/` 是只读的参考项目，`wait-novel/` 是还没用上的源包储备。

### 依赖

`package.json` 里的直接依赖全部钉成精确版本（没有 `^`、`~`），和 `package-lock.json` 一致，所以装依赖用 `npm ci`。升级时改版本号、`npm install`，再把下面的测试和 E2E 跑一遍。

npm 11 会拦下依赖的安装脚本，放行的包记在 `package.json` 的 `allowScripts` 里，目前只有 esbuild（Vite 用它）。新依赖带安装脚本时，`npm approve-scripts --allow-scripts-pending` 会列出来，看过脚本内容再用 `npm approve-scripts <包名>` 放行。

### 主题（Tailwind v4）

仓库里**没有 `tailwind.config.js`，也不需要**。Tailwind v4 通过 PostCSS 插件 `@tailwindcss/postcss` 接入（见 `postcss.config.js`），入口是 `src/index.css` 开头的 `@import "tailwindcss"`。

主题靠根元素上的 `data-theme` 属性加一组 CSS 变量实现，`src/utils/theme.ts` 在页面第一次渲染前写入。五套主题（`default` / `sepia` / `eyecare` / `dark` / `black`）各是 `src/index.css` 里的一个 `[data-theme="..."]` 块，声明同一组变量（`--bg`、`--card-bg`、`--text`、`--accent`、`--border`），并带上 `color-scheme`（前三套 `light`，后两套 `dark`），让浏览器原生控件也跟着变色。

选择器故意写成 `[data-theme="..."]` 而不是 `:root[data-theme="..."]`：任何元素加上这个属性，它里面就换成那套颜色。设置面板里同时显示五个主题色块，靠的就是这个，组件不用接收任何主题参数。

主题块之后的裸 `:root` 里还有三个派生量，由上面那组变量算出来。组件该用它们的地方就用它们，不要再拿 `opacity-*` 或 `text-slate-*` 去调淡文字：

| 变量 | 算法 | 用在哪 |
| --- | --- | --- |
| `--hover` | `--text` 8% 叠在透明上 | 悬停底色 |
| `--selected` | `--accent` 15% 混进 `--bg` | 目录里当前章那一行 |
| `--text-muted` | `--text` 80% 混进 `--bg` | 次要文字：作者、字数、说明等 |

改颜色之前先跑 `npx vitest --run src/utils/palette.test.ts`。它解析 `src/index.css`，逐套主题核对：`--text`、`--accent`、`--text-muted` 对 `--bg` 和 `--card-bg` 的对比度不低于 4.5:1，`--accent` 对 `--selected` 不低于 4.5:1，`--selected` 和卷标题用的 `--card-bg` 分得开。

### 测试

```bash
npm run typecheck
npm run lint
npm run build                      # 顺带检查顶层没有 404.html
npm run test
python -m pytest scripts/tests -q
python -m pytest e2e/acceptance -q # 验收脚本自身的测试
```

目前：Vitest 28 个文件、710 项通过；pytest 1871 项通过、1 项跳过；`e2e/acceptance` 119 项通过。

前端单测和源文件放在一起（`src/utils/*.test.ts`），构建插件的测试在 `build/linkAssets.test.ts`。没有搭 jsdom，不测 DOM 事件；需要测的判断逻辑（定位、检索、快捷键、翻页滚动、设置归一、URL 章号、首次定位、加载错误分类、调色板对比度、缓存淘汰）都抽成了纯函数，其中不少用 fast-check 写成了属性测试。DOM 和画面交给下一节的 E2E。

---
## E2E 测试

用 Playwright 在 Chromium 里把书架和阅读器真正跑一遍：检索、翻章、滚动、目录、书签、主题、快捷键、地址栏写回、离线缓存、加载出错，另外还有像素截图比对、给人看的评审截图、性能读数和无障碍扫描。代码在 `e2e/`，配置在 `playwright.config.ts`。它和上面的单测互不串收，`npm run test` 不会跑到 E2E。

### 准备

| 需要 | 说明 |
| --- | --- |
| Node.js | 验证过的主版本：24（v24.18.0） |
| Python 包 | `python -m pip install -r scripts/requirements.txt`（夹具书库要用预处理管线生成） |
| Chromium | `npm run e2e:install`，一次性下载，装好后占磁盘约 700 MB |

只装与 `@playwright/test` 1.62.1 对应的那一版 Chromium（`chromium-1234` 约 430 MB，`chromium_headless_shell-1234` 约 270 MB），放在 `%LOCALAPPDATA%\ms-playwright\`，不装 Firefox 和 WebKit。`npm ci` 不下载浏览器；已经装过的话，`e2e:install` 不会重复下载。没装就跑 E2E，会立刻停下、提示这条命令，退出码 3。

### 命令

每条都能原样粘贴进 PowerShell（5.1 也行）：

```powershell
npm run e2e:install                         # 安装 Chromium
npm run e2e:fixture                         # 生成夹具书库
npm run e2e                                 # 全部用例，fixture 和 real 一起跑
npm run e2e:profile -- --profile fixture    # 只跑 fixture
npm run e2e:profile -- --profile real       # 只跑 real
npm run e2e:update                          # 更新像素基线
```

- `e2e:fixture` 平时不用手动跑：夹具书库缺文件，或者夹具源、`PIPELINE_VERSION` 变了，fixture 运行开始时会自动重新生成。
- `e2e:profile` 后面可以接 Playwright 自己的参数，比如只跑一个文件：`npm run e2e:profile -- --profile fixture visual.spec`。`--profile` 只认 `fixture` 和 `real`。
- 带 real 的运行会先单独跑完 3 个性能用例（`real-perf`），`-g` 和文件过滤管不到它们；想跳过就再加 `--no-deps`。
- `-g` 的取值以 `@` 开头时必须加引号，否则 PowerShell 会把它当成变量：

```powershell
npm run e2e -- -g '@selfcheck'                           # 只跑服务器自检
npm run e2e:profile -- --profile real -g '@audit'        # 解压整个真实书库核对字数，本机约 2 分钟
npm run e2e:profile -- --profile fixture -g '@selftest'  # 运行汇总的自检，故意失败，退出码不为 0
```

`@audit` 和 `@selftest` 平时不跑，只有 `-g` 点名才跑。

**退出码**：`0` 每个用例都是通过、跳过或预期失败；`1` 有用例失败、预期失败的用例意外通过，或运行中途中止（构建失败、端口被占、服务器自检失败等）；`2` 参数不对；`3` 没装 Chromium。无障碍扫描报出任何违规，所在用例就判失败，退出码随之为 `1`；incomplete 结果只列出，不影响退出码。性能超预算只写进汇总，不影响退出码。

每次运行先把当前 `src/` 构建到 `e2e/.out/app/`（不碰 `dist/`），再在 `127.0.0.1` 上起本地服务器：fixture 用 4611、4612，real 用 4621、4622。每组一个把 `.txt.gz` 原样返回（预期中 Pages 的做法），一个带 `Content-Encoding: gzip` 返回，前端的两条解压分支都能测到。服务器只读、只接受 GET 和 HEAD、只监听本机，没有鉴权。

### fixture 和 real

| | fixture | real |
| --- | --- | --- |
| 数据来源 | `e2e/fixture/` 的 Python 脚本合成 52 本小书（固定种子，从字表里随机组字，书名、作者都是编的），交给预处理管线生成到 `e2e/.out/fixture/` | 本机 `public/books/` 和 `public/data/` 的真实书库，只读 |
| 干净 clone 上能跑吗 | 能 | 不能：要先跑过预处理，书库里还要有 6 本测试用书（`e2e/support/library.ts` 的 `TEST_BOOKS`）。缺了的话 real 用例整体跳过，汇总里写明原因，不算失败 |
| 像素基线比对 | 做，13 张 | 不做，也不读写基线 |

real 负责和规模有关的部分：7000 多本的书架、3000 多个节点的目录、20 MB 级的加载进度、性能读数，以及真实书库的评审截图。这些截图只留在本机的 `e2e/.out/` 里，不进版本库。

不管跑哪种，运行前后都会给 `public/` 和 `.preprocess-manifest.json` 记一次文件清单（路径、大小、修改时间），有任何变化本次运行就判失败。

### 产物在哪

运行产物都在 `e2e/.out/`（不进 git）。除 `e2e:update` 以外，跑 E2E 不会改动版本库里的任何文件。

| 产物 | 路径 |
| --- | --- |
| 运行汇总：用例统计、失败原因，以及视觉回归、性能读数、无障碍扫描三节 | `e2e/.out/summary.md`；机器可读版 `e2e/.out/results.json` |
| Playwright HTML 报告 | `e2e/.out/report/index.html`，用 `npx playwright show-report e2e/.out/report` 打开 |
| 评审截图（每次运行开始时清空） | `e2e/.out/review/<名称>.png` |
| 评审报告：逐张列出场景和验收准则 | `e2e/.out/review/review-report.md` |
| 性能读数 | `e2e/.out/perf.json` |
| 无障碍扫描结果 | `e2e/.out/a11y/` |
| 失败用例的 trace 和截图，视觉回归的实际图与差异图 | `e2e/.out/test-results/` |
| 夹具书库 | `e2e/.out/fixture/`，里面的 `books/`、`data/` 和 `public/` 布局相同 |
| 像素基线（进 git） | `e2e/baselines/<名称>-win32.png` |

### 像素基线

13 张基线覆盖书架（桌面、移动、骨架）、详情弹窗、阅读器的五套主题和移动端、分卷目录、检索结果、设置抽屉，定义都在 `e2e/visual/baselines.ts`，全部取自 fixture 的合成书库。[界面一览](#界面一览)里的图就是它们。

**基线只对 Windows + 本机字体有效**。应用只用系统字体，换系统或换字体截图就会变。文件名带平台后缀（`-win32`），在别的平台上跑会因为找不到同名基线而失败。

只有 `e2e:update` 会写基线。其他命令遇到缺失的基线，对应用例直接失败并提示 `npm run e2e:update`，不会拿本次截图补上。更新流程：

1. 跑 `npm run e2e:update`。它只跑 fixture 的 `visual.spec`：写入缺失的基线，覆盖差异超出容差的基线，其余文件逐字节不动。想重拍一张差异还在容差内的基线，先删掉那个 PNG 再跑。
2. 用 `git status e2e/baselines` 找出新增和改动的文件，逐张打开看，判为以下三种之一：
   - 接受：画面就是这个视图该有的状态。除书架骨架那张以外，没有骨架、加载进度条或加载失败提示，也不是空白页。
   - 含已知缺陷接受：画面不对，但问题出在应用本身。在 `.kiro/specs/e2e-visual-testing/findings.md` 记一条 Finding，并在 `baselines.ts` 里这张基线定义的 `knownDefects` 处标注编号。
   - 重拍：画面不对，问题出在测试代码。修好后回到第 1 步。

   判定记在 `.kiro/specs/` 下的 `baseline-review.md`，只存本机。
3. 没有"重拍"了就提交：`git add e2e/baselines`，再 `git commit`。

### 无障碍扫描

fixture 下用 axe 扫 31 次，每次一个用例：

- 6 个视图（书架、详情弹窗、阅读器正文、目录、检索、设置抽屉）各扫一次，用应用默认的主题（不存主题，实际是 sepia）。
- 阅读器正文在五套主题下各查一次颜色对比度，共 5 次。
- 另外 5 个视图（书架、详情弹窗、目录、检索、设置抽屉）在其余 4 套主题（default、eyecare、dark、black）下各查一次颜色对比度，共 20 次。

任一次扫描报出违规，不论影响级别，所在用例就判失败。失败信息和运行汇总都列出规则 id、影响级别和每个节点的明细：选择器、HTML 片段、失败说明，颜色对比度另列前景色、背景色、实测和要求的对比度、字号、字重。critical 和 serious 在汇总里另标"待记入 Findings_Log"。axe 判为需人工复核的 incomplete 结果只在汇总里列出规则 id 和节点数，不让用例失败；节点明细在 `e2e/.out/a11y/<名称>.json`。书卡封面上压在渐变上的白字，axe 只能报 incomplete，需要人看一眼。

**这只是自动化冒烟**。axe 只能查出一部分问题，完整的 WCAG 合规验证需要用读屏软件等辅助技术做人工测试，并请专家评审。

---

## 关于内容与版权

- **仓库里不含任何小说。**`zip-novel/`、`public/books/`、`public/data/` 和 `.preprocess-manifest.json` 都不进 git，书库内容只存在于你自己的机器和你部署的站点上。
- **文档和测试里的文字都是为本项目专门写的或随机合成的**：本文的截图来自 `e2e/fixture/` 合成的夹具书库，`scripts/fixtures/` 是专门写的切章样本。真实书库上跑出来的截图只留在本机的 `e2e/.out/`，不进版本库。
- **请只放你有权使用的文本**，比如自己的作品、已进入公有领域的作品，或获得授权的内容。部署后的站点默认公开，任何人都能读、能下载整本书（见[部署](#部署)一节关于 Cloudflare Access 的说明）。
