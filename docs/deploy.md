# 构建与部署

推荐部署到 Cloudflare Pages。网站是纯静态的，也可以放到其他静态托管上。

## 构建

```bash
npm run build
```

产物在 `dist/`，这就是整个站点。构建前至少要跑过一次预处理，否则书架是空的。

书库文件（`public/books/`、`public/data/`）不进 git，平台从仓库自动构建时拿不到它们。所以不管部署到哪，都在本机构建，再把 `dist/` 上传。

`public/` 下的书库以硬链接的方式进入 `dist/`，不复制。因此：

- `public/` 和 `dist/` 必须在同一个磁盘分区上。跨分区，或者在 FAT/exFAT、部分网络盘、容器挂载目录上，构建会报错停下。
- `public/` 下的所有文件都会进 `dist/`，不只是 `books/` 和 `data/`。

`npm run dev` 直接读 `public/`，不受影响。

## 部署到 Cloudflare Pages（推荐）

- 项目自带 `wrangler.toml`，一条命令就能部署，之后只上传新增和改动的文件。
- 不用配置路由，直接打开 `/read/<id>` 就能用，见[路由](#路由)。
- 默认原样返回 `.txt.gz`，加载时有进度百分比，书能存进离线缓存。
- 预处理按 Pages 的上限检查书库，见[容量](#容量)。

```bash
npm run build
npx wrangler pages deploy
```

项目名和上传目录写在 `wrangler.toml` 里：

```toml
name = "novel-pages"                # Pages 项目名，网址是 novel-pages.pages.dev
pages_build_output_dir = "./dist"   # 上传的目录
```

要换项目名，改 `name` 即可。参数写全的命令是 `npx wrangler pages deploy dist --project-name novel-pages`。

### 第一次部署

1. 运行 `npx wrangler login`，在浏览器里登录 Cloudflare。
2. 运行 `npx wrangler pages deploy`。项目还不存在时会提示创建，生产分支填 `main`。
3. 等上传完成。第一次要传整个书库，比较久；之后只传新增和改动的文件。
4. 打开站点读一本书，按[部署后检查](#部署后检查)看一下 `.txt.gz` 的响应头。

### 其他

- 部署预览版、不动正式站：`npx wrangler pages deploy --branch preview`，会得到一个单独的预览网址。
- wrangler 没装进项目依赖，`npx` 每次用最新版，要求 Node.js 22+。想固定版本：`npx wrangler@4.143.0 pages deploy`。
- 站点是公开的，没有登录。只想自己看的话，可以在 Cloudflare 后台用 Cloudflare Access 加一道登录。
- `wrangler.toml` 的 `pages_build_output_dir` 要和 `vite.config.ts` 的 `build.outDir` 一致（都是 `dist`）。

### 路由

直接打开 `/read/<id>` 能用，靠的是 Pages 的默认行为：找不到的地址交给首页，由前端处理。所以：

- `dist/` 顶层不能有 `404.html`，否则 `/read/<id>` 会 404。构建会检查，发现就失败。
- 不要加 `/* /index.html 200` 这样的 `_redirects`，它会把书库文件也换成首页。真要加，只写 `/read/*`。

## 部署到其他静态托管

`dist/` 也可以放到 Netlify、对象存储加 CDN、自建 Nginx 等静态托管上，用平台的命令行工具或网页把整个目录上传。需要满足：

1. 部署在域名根路径。页面和书库都用 `/assets/`、`/books/`、`/data/` 开头的绝对路径，放在 `example.com/novel/` 这样的子路径下打不开。
2. 把 `/read/*` 重写到 `/index.html`，状态码 200。阅读页由前端路由处理，不重写的话，直接打开或刷新阅读页会 404。只重写 `/read/*`，不要让所有路径都回退到首页：有的平台不管文件存不存在都执行重写，书库文件会被换成首页。
3. `.txt.gz` 原样返回，不要再压缩一遍，见[部署后检查](#部署后检查)。
4. 确认平台的限制。书多的时候文件数和总容量都不小，部署前看清平台对总容量、文件数、单个文件大小和上传的限制。

GitHub Pages 这类不能配置重写规则的平台不适合：阅读页的链接直接打开会 404。

### 重写规则示例

Netlify：在 `public/` 下新建 `_redirects`，构建时会带进 `dist/`。

```text
/read/*  /index.html  200
```

部署到 Cloudflare Pages 时不需要这个文件，留着这一条也没关系。

Nginx：

```nginx
server {
    # 其余配置略
    root /srv/novel/dist;

    location /read/ {
        try_files $uri /index.html;
    }
}
```

其他平台：在重写（rewrite）设置里把 `/read/*` 指向 `/index.html`。

## 部署后检查

打开站点读一本书，在浏览器开发者工具的网络面板里看 `.txt.gz` 请求的响应头：

| 响应头 | 结果 |
| --- | --- |
| 没有 `Content-Encoding`，有 `Content-Length` | 正常：加载时显示百分比，书存进离线缓存 |
| 没有 `Content-Length` | 能读，也能离线缓存，只是加载时不显示百分比 |
| 有 `Content-Encoding: gzip` | 能读，但加载时不显示百分比，书也不进离线缓存，下次打开要重新下载 |

服务器要是把 `.txt.gz` 再压缩一遍，书会读不出来。

## 容量

预处理按 Cloudflare Pages 的上限检查书库：最多 20000 个文件，单个文件不超过 25 MiB，详见[容量上限](library.md#容量上限)。超出时预处理以退出码 2 结束，生成的文件照常保留。部署到其他平台时，以那个平台的限制为准。
