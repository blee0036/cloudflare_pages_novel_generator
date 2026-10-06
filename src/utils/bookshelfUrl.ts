/**
 * 书架 URL 上的"章节目录弹窗"状态（需求 5.12，差异表 B8）。
 *
 * B8 的定案是"**保留弹窗 + URL 同步**"：旧版把书籍详情做成独立路由 `/books/:id`，新版做成
 * 无 URL 的弹窗；两者各丢一半——前者按后退回到书架但详情是整页跳转（弹窗那种"目录浮在书架
 * 之上"的体感没了），后者体验好但地址栏毫无痕迹，于是不可分享、按后退直接离开书架。
 *
 * ## 为什么是查询参数 `/?book=<id>`，不是嵌套路由 `/books/:id`
 *
 * 定案说的是"弹窗留着"，那么承载它的 URL 就不能是另一条路由：
 *
 * 1. **不重新挂载书架**。`/` → `/?book=x` 在 React Router 里匹配的仍是同一条 `path="/"`，
 *    `BookshelfPage` 只是收到新的 `location`，组件实例与全部本地状态（检索词、作者筛选、
 *    已按了几次"继续加载"、滚动位置）原地保留。换成 `/books/:id` 则是另一条路由，书架整棵
 *    子树卸载：开个目录再关掉就会把作者筛选（需求 5.11）与分页（需求 5.8）清空，读者还得
 *    从头翻回去。这一条单独就足以定下形式。
 * 2. **不新增路由文件**。需求 A12/F4 保留 `BrowserRouter` 并依赖 Cloudflare Pages 的 SPA
 *    回退（附录 P2），路由表越小越不容易在部署形态上出岔子；查询参数连 `App.tsx` 都不用动。
 * 3. **与阅读器的 URL 形态不冲突**。阅读器是 `/read/:bookId`（章号走 `?ch=`），"书籍 id
 *    落在路径上"这个位置已经被它占了；再来一条 `/books/:id` 只会让两个都带 id 的路径看着
 *    像同一层东西，而它们一个是页面一个是弹窗。
 *
 * 代价是分享出去的链接长得像"带参数的书架"而不是"某本书的页面"，且弹窗状态原则上可被别的
 * 查询参数扰动。后者由本模块只碰 `book` 这一个键来兜住：书架日后要把检索词或作者筛选也放进
 * URL，与这里互不干扰（那是另一项改动，需求 5.12 只要求同步"当前书籍"）。
 *
 * ## 为什么把读写单独抽成纯函数
 *
 * 全部返回**查询串**而不直接改 `URLSearchParams`：`useSearchParams()` 交出来的那个实例是
 * 按 `location.search` memo 住的，就地 `set`/`delete` 会改掉 Hook 缓存的值却不触发导航——
 * 表现为"URL 没变但下次读到的参数变了"，一个没有任何类型错误的静默 bug。这里一律先复制、
 * 后返回字符串，调用方只能通过导航落盘。
 *
 * 编解码交给 `URLSearchParams`：book id 形如 `青石巷-夜行`（中文 + 连字符，见
 * design §2.2），理论上还可能带空格或 `&`，手写 `encodeURIComponent` 拼串迟早在某本书上
 * 漏一处。
 */

/** 弹窗当前书籍的参数名。 */
export const TOC_BOOK_PARAM = "book";

/** 查询串可以用原始字符串（带不带 `?` 都行）或现成的 `URLSearchParams` 传入。 */
export type SearchInput = string | URLSearchParams;

/**
 * 复制一份可安全修改的参数集。
 *
 * 即便入参已经是 `URLSearchParams` 也复制——理由见模块说明（Hook 缓存的实例不可就地改）。
 */
function copyParams(search: SearchInput): URLSearchParams {
  return new URLSearchParams(search);
}

/**
 * 读出 URL 里的弹窗书籍 id；没有、或只有空白时返回 `null`（表示弹窗关闭）。
 *
 * 空白视同缺失：`?book=`、`?book=%20` 这类空值只会出现在手改的地址栏或被截断的分享链接里，
 * 把它当成"一个 id 叫空串"会让调用方去书目里查一个永远查不到的键，随后触发清理逻辑改写
 * URL——多绕一圈得到同样的结果。
 *
 * 同名参数重复（`?book=a&book=b`）取第一个，与 `URLSearchParams.get` 同一口径；写入时
 * `set` 会把重复项收敛成一个，所以这种 URL 只可能来自外部。
 */
export function readTocBookId(search: SearchInput): string | null {
  const raw = copyParams(search).get(TOC_BOOK_PARAM);
  if (raw === null) return null;
  const id = raw.trim();
  return id === "" ? null : id;
}

/**
 * 写入弹窗书籍 id，返回新的查询串（不含前导 `?`）。其余参数原样保留，已有的 `book` 被覆盖
 * 而不是追加第二个。
 *
 * 空 id 等同于关闭：与 `readTocBookId` 的空白判定对称，使 `read(with(s, id))` 对任何输入
 * 都成立（空 id 写进去再读出来是 `null`，而不是一个读不回来的空串）。
 */
export function withTocBookId(search: SearchInput, bookId: string): string {
  const id = bookId.trim();
  if (id === "") return withoutTocBookId(search);

  const params = copyParams(search);
  params.set(TOC_BOOK_PARAM, id);
  return params.toString();
}

/**
 * 移除弹窗书籍 id，返回新的查询串。
 *
 * 结果为空串时调用方把它交给 `setSearchParams("")` 即可——React Router 内部走
 * `navigate("?")`，而 `createPath` 显式忽略孤零零的 `?`，地址栏落到干净的 `/`。
 */
export function withoutTocBookId(search: SearchInput): string {
  const params = copyParams(search);
  params.delete(TOC_BOOK_PARAM);
  return params.toString();
}
