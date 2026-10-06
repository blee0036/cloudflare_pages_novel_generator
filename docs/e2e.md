# E2E 测试

用 Playwright 在 Chromium 里测书架和阅读器，另外有像素截图比对、评审截图、性能读数和无障碍扫描。代码在 `e2e/`，配置在 `playwright.config.ts`。

## 准备

```powershell
npm run e2e:install
```

下载 Chromium，约 700 MB，只需一次。夹具书库要用预处理生成，所以也要装好 Python 依赖。已验证 Node.js 24。

## 运行

```powershell
npm run e2e                                            # 全部
npm run e2e:profile -- --profile fixture               # 与上一条相同
npm run e2e:profile -- --profile fixture visual.spec   # 只跑一个文件
npm run e2e:update                                     # 更新像素基线
```

- `--profile` 只接受 `fixture`。
- `--profile` 之后可以接 Playwright 自己的参数。
- 在 PowerShell 里，`-g` 的值以 `@` 开头时要加引号，比如 `-g '@selfcheck'`。
- 每次运行都会先完整跑一遍 `perf` 项目的 3 个性能用例，带 `-g` 或文件过滤时也一样。加 `--no-deps` 可以跳过。`npm run e2e:update` 已经带了 `--no-deps`，只跑 `fixture` 项目的 `visual.spec`。

下面两组用例只在 `-g` 点名时才跑，跑之前同样会先跑 `perf`，加 `--no-deps` 可以跳过：

```powershell
npm run e2e:profile -- --profile fixture -g '@audit'     # 解压夹具书库核对字数，时限 60 s
npm run e2e:profile -- --profile fixture -g '@selftest'  # 运行汇总的自检，故意失败
```

## 项目与书库

E2E 用 `e2e/fixture/` 生成的 52 本示例书，不读本机 `public/` 下的书库，所以干净 clone 也能跑，不用先跑预处理。

| 项目 | 用例目录 | 服务器端口 |
| --- | --- | --- |
| `fixture` | `e2e/tests/common/`、`e2e/tests/fixture/` | 4611 |
| `fixture-transparent` | `e2e/tests/fixture-transparent/` | 4612 |
| `perf` | `e2e/tests/perf/`。其余项目都依赖它，它最先单独跑完 | 4611 |
| `tooling` | `e2e/tests/tooling/`，不开浏览器 | 无 |

- 夹具书库生成在 `e2e/.out/fixture/`。缺文件，或者夹具源、`PIPELINE_VERSION` 变了，运行时会自动重新生成。也可以手动跑 `npm run e2e:fixture`。
- E2E 不会改动 `public/` 和 `.preprocess-manifest.json`。运行前后会核对，有变化就判失败。

## 退出码

| 退出码 | 含义 |
| --- | --- |
| 0 | 用例都通过、跳过或预期失败 |
| 1 | 有用例失败、预期失败的用例意外通过，或运行中止（构建失败、端口被占等） |
| 2 | 参数不对 |
| 3 | 没装 Chromium |

无障碍扫描有违规算失败。性能超预算只记进汇总，不影响退出码。

## 结果在哪

都在 `e2e/.out/`，不进 git：

| 内容 | 路径 |
| --- | --- |
| 运行汇总 | `summary.md`，机器可读版 `results.json` |
| HTML 报告 | `report/index.html`，用 `npx playwright show-report e2e/.out/report` 打开 |
| 评审截图和评审报告 | `review/` |
| 性能读数 | `perf.json` |
| 无障碍扫描结果 | `a11y/` |
| 失败用例的 trace、截图和差异图 | `test-results/` |

## 本地服务器

每次运行先把 `src/` 构建到 `e2e/.out/app/`（不碰 `dist/`），再在 `127.0.0.1` 上起两个只读的静态服务器，都服务夹具书库：4611 原样返回 `.txt.gz`，4612 带 `Content-Encoding: gzip` 返回。服务器没有鉴权，只监听本机。

## 像素基线

- 13 张，覆盖书架、详情弹窗、阅读器的五套主题和手机版、分卷目录、检索结果、设置抽屉。定义在 `e2e/visual/baselines.ts`，图片在 `e2e/baselines/`（进 git）。[README](../README.md) 里的截图就是这些图。
- 只在 Windows 上有效。在其他平台跑会因为找不到同名基线而失败。
- 只有 `npm run e2e:update` 会写基线：补上缺失的，覆盖差异超出容差的，其余不动。要重拍一张差异在容差内的，先删掉那个 PNG。

更新步骤：

1. 运行 `npm run e2e:update`。
2. 用 `git status e2e/baselines` 找出变动的图，逐张打开看。
3. 画面不对时：问题在测试代码，就修好后回到第 1 步；问题在应用本身，在 `e2e/visual/baselines.ts` 里这张基线的 `knownDefects` 处注明。
4. 提交 `e2e/baselines`。

## 无障碍扫描

fixture 下用 axe 扫 31 次：6 个视图在默认主题下完整扫描，并在全部 5 套主题下检查颜色对比度。

- 任一次扫描报出违规就判失败，汇总里列出规则、影响级别和节点明细。
- axe 判为需要人工复核（incomplete）的结果只列出，不判失败。明细在 `e2e/.out/a11y/`。

自动扫描只能发现一部分问题。完整的 WCAG 合规需要用读屏软件等辅助技术人工测试，并请专家评审。
