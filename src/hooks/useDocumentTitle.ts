import { useEffect } from "react";
import { SITE } from "../utils/site";
import { documentTitleFor } from "../utils/siteConfig";

/**
 * 声明本页的标签页标题（需求 9.3）。
 *
 * 用法就两种：书架 `useDocumentTitle()`（只有站点名），阅读器
 * `useDocumentTitle(toc?.title)`（`书名 - 站点名`，书还没加载完时自动退回站点名）。
 *
 * ## 为什么是"各页声明"，而不是"进入时改、卸载时还原"
 *
 * 直觉做法是在阅读器里 `document.title = 书名`，卸载时还原成站点名。那需要两个页面就
 * "谁负责恢复"达成默契，而恢复与设置发生在同一次提交里（离开阅读器的那一帧，阅读器的
 * cleanup 与书架的 effect 都要跑），顺序一旦变化最终标题就变了——React 18 的 StrictMode
 * 还会把 effect 装载再卸载一遍，专门放大这类顺序依赖。
 *
 * 改成"每个页面只声明自己要什么、从不还原"之后，标题是**当前挂载页面的函数**：
 * 不论 effect 以什么顺序跑，最后落在 DOM 上的都是仍然挂载的那个页面写的值。
 * 阅读器 → 书架 → 阅读器来回走，每次都由到场的页面重新声明一次，没有需要维护的旧值。
 *
 * 同理，站点名不是"恢复"出来的，而是书架**本来就声明**的标题——需求 9.3 的后半句因此
 * 不需要任何额外机制，与前半句是同一条代码路径（`documentTitleFor` 的两个分支）。
 *
 * ## 为什么不用 `<title>` 组件 / react-helmet
 *
 * 全站只有两个标题，一个 effect 一行赋值够了；`index.html` 里的首屏标题已由构建期注入
 * （需求 9.2），运行时要做的只剩"打开书之后跟着书名走"这一件事。
 */
export function useDocumentTitle(bookTitle?: string | null): void {
  useEffect(() => {
    document.title = documentTitleFor(SITE.name, bookTitle);
  }, [bookTitle]);
}
