import { ReaderThemeKey } from "../types";
import { getStoredSettings } from "./storage";

/**
 * 主题的唯一施加点（需求 6.1，design §7.1）。
 *
 * 全站主题由根元素上的一个属性决定，颜色取值在 `src/index.css` 的
 * `:root[data-theme="..."]` 块里。本模块是**写这个属性的唯一地方**——两个写入点
 * （首屏初始化与阅读器内切换）都走 `applyTheme`，不存在第二条改主题的路径。
 *
 * ## 为什么副作用放在这里，而不是某个组件里
 *
 * 主题设置存在 `ReaderSettings`（localStorage），但它要影响的是**书架与阅读器两条
 * 路由**（需求 6.2）。两条路由不会同时挂载，所以副作用不能只挂在 `ReaderPage` 上：
 * 直接打开书架或在书架页上重新载入时 `ReaderPage` 从未挂载，属性就永远不会被写，书架会退化到裸
 * `:root`（默认明亮），而不是读者选的主题。
 *
 * 因此拆成两处，各管一段：
 *
 * 1. `initTheme()` 在 `main.tsx` 里于 `render()` **之前**同步调用一次。它与路由无关，
 *    所以刷新、深链接 `/read/<id>`、直接进书架都拿到正确主题；又因为发生在首次绘制前，
 *    不会出现"先白一帧再变 sepia"——那正是需求 6 要消掉的闪屏。
 *    （`useEffect` 在绘制后才跑，做不到这一点；`useLayoutEffect` 可以，但那样就得把
 *    主题状态提到 `App` 上，反而多一层穿透。）
 * 2. `ReaderPage` 用一个 effect 跟随 `settings.theme`，覆盖运行时切换。
 *
 * 属性写在 `<html>` 上而非 React 树里，所以阅读器卸载后它**留着**：从阅读器返回书架
 * 时书架直接就是新主题（需求 6.2），不需要 context、store 或任何 prop 穿透（需求 6.5）。
 */
export const THEME_ATTRIBUTE = "data-theme";

/**
 * 五套主题的键与给读者看的名字，按设置面板里的呈现顺序（任务 44）。
 *
 * 这是 `THEME_CONFIGS` 被删除后**唯一**留下的部分：颜色值已经全部收进
 * `src/index.css` 的 `[data-theme="..."]` 块（需求 6.1），但"默认明亮 / 复古羊皮 /
 * 护眼豆绿 / 暗色夜间 / 极夜纯黑"这几个名字是文案，CSS 里放不下，设置抽屉的色块
 * 要用它做标签与 `title`。
 *
 * 用**数组**而不是 `Record<ReaderThemeKey, string>`：面板要按固定顺序铺 5 个色块，
 * 顺序就是这里的数组顺序，而不是对象键的枚举顺序（那是实现细节，原先靠
 * `Object.keys(THEME_CONFIGS)` 取，等于把呈现顺序寄托在字面量的书写顺序上）。
 * 类型仍钉在 `ReaderThemeKey` 上，写错主题键过不了 `typecheck`；数组是否漏了某套
 * 主题则由 `theme.test.ts` 断言（键集合必须与 CSS 里的变量块一一对应）。
 *
 * 放在本模块而不是 `storage.ts`：它属于主题的呈现，与持久化无关。
 */
export const READER_THEMES: readonly { key: ReaderThemeKey; name: string }[] = [
  { key: "default", name: "默认明亮" },
  { key: "sepia", name: "复古羊皮" },
  { key: "eyecare", name: "护眼豆绿" },
  { key: "dark", name: "暗色夜间" },
  { key: "black", name: "极夜纯黑" },
];

/**
 * 把主题写到 `<html data-theme>`。
 *
 * 宿主没有 `document`（单元测试跑在 Node 上）时静默跳过：调用方都是"顺手同步一下"的
 * 位置，不该为了一个装饰性属性去感知运行环境。
 */
export function applyTheme(theme: ReaderThemeKey): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute(THEME_ATTRIBUTE, theme);
}

/**
 * 用持久化的阅读设置初始化主题。应在首次渲染前调用一次（见上面的说明）。
 *
 * 存储不可用时 `getStoredSettings()` 已经会回到 `DEFAULT_SETTINGS`，所以这里拿到的
 * 总是一个合法主题键，无需再判空。
 */
export function initTheme(): void {
  applyTheme(getStoredSettings().theme);
}
