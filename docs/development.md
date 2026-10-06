# 开发

## 目录结构

```
zip-novel/                  源压缩包（不进 git）
public/
  books/                    生成的 <id>.txt.gz（不进 git）
  data/                     生成的 <id>_toc.json 和 books.json（不进 git）
  favicon.svg               站点图标
scripts/                    预处理（Python）
  preprocess.py             主流程
  check_toc.py              章节质量报表
  toc-overrides.example.json  覆盖表的格式示例（本机的 toc-overrides.local.json 不进 git）
  leak-check.mjs            检查要提交的文件里有没有本机书库的书名
  lib/                      解压、编码、切章、拼音、格式检查、清单、汇总
  tests/                    pytest
  fixtures/                 切章测试样本
src/                        网站（React + TypeScript）
  pages/                    书架页、阅读页
  components/               界面组件
  hooks/                    自定义 hooks
  utils/                    定位、检索、缓存、解压、存储、主题、快捷键等，单测放在同目录
  index.css                 Tailwind 入口和主题变量
  types.ts                  生成文件的类型定义，与 scripts/lib/validate.py 对应
build/linkAssets.ts         构建插件：硬链接 public/，检查 404.html
e2e/                        E2E 测试，见 e2e.md
  tests/                    用例：common/、fixture/、fixture-transparent/、perf/、tooling/
vite.config.ts              Vite 配置，含站点配置插件
vitest.config.ts            Vitest 配置
playwright.config.ts        Playwright 配置
wrangler.toml               Cloudflare Pages 部署配置
site.config.example.json    站点配置样板
.preprocess-manifest.json   预处理清单（不进 git，要备份）
```

## 测试与检查

```bash
npm run typecheck                   # TypeScript 类型检查
npm run lint                        # ESLint
npm run test                        # Vitest 单测
npm run build                       # 构建，顺带检查 dist/ 顶层没有 404.html
python -m pytest scripts/tests -q   # 预处理的单测
python -m pytest e2e/acceptance -q  # 验收脚本的单测
npm run leak-check                  # 检查要提交的文件里有没有本机书库的书名、作者或书 id
```

- Vitest 的单测和源文件放在一起（`src/utils/*.test.ts`），构建插件的在 `build/linkAssets.test.ts`。单测只测纯函数，界面交给 E2E。
- `npm run test` 不包含 E2E，E2E 见 [E2E 测试](e2e.md)。
- `npm run leak-check` 读本机的 `public/data/books.json`，没有这个文件时不做检查。

## 依赖

- `package.json` 里的版本全部写死，和 `package-lock.json` 一致。安装用 `npm ci`。
- 升级：改版本号，运行 `npm install`，再跑一遍测试和 E2E。
- npm 11 默认拦截依赖的安装脚本，放行名单在 `package.json` 的 `allowScripts`，目前只有 esbuild。新依赖需要安装脚本时，用 `npm approve-scripts --allow-scripts-pending` 列出来，看过脚本内容再运行 `npm approve-scripts <包名>`。

## 主题

- Tailwind v4 通过 `@tailwindcss/postcss` 接入（见 `postcss.config.js`），没有 `tailwind.config.js`。入口是 `src/index.css`。
- 五套主题（`default`、`sepia`、`eyecare`、`dark`、`black`）是 `src/index.css` 里的 `[data-theme="..."]` 块，都声明同一组变量：`--bg`、`--card-bg`、`--text`、`--accent`、`--border`，以及 `color-scheme`。
- `src/utils/theme.ts` 在首次渲染前把 `data-theme` 写到根元素上。任何元素加上 `data-theme` 属性，里面就换成那套颜色。

派生变量写在主题块之后的 `:root` 里：

| 变量 | 算法 | 用途 |
| --- | --- | --- |
| `--hover` | `--text` 8% 叠在透明上 | 悬停底色 |
| `--selected` | `--accent` 15% 混进 `--bg` | 目录里的当前章 |
| `--text-muted` | `--text` 80% 混进 `--bg` | 次要文字：作者、字数、说明等 |

次要文字用 `--text-muted`，不要用 `opacity-*` 或 `text-slate-*` 调淡。

改颜色前后运行 `npx vitest --run src/utils/palette.test.ts`，它检查每套主题的文字对比度不低于 4.5:1。
