import { DEFAULT_SITE_CONFIG, SiteConfig } from "./siteConfig";

/**
 * 构建期注入的站点配置在运行时的读取口（需求 9.2 / 9.3）。
 *
 * `vite.config.ts` 的 `site-config` 插件用 `define` 把解析好的配置内联成这个标识符，
 * 于是它在产物里就是一个对象字面量——没有请求、没有 `JSON.parse`、也不占一次往返。
 *
 * 声明在模块内而不是全局 `.d.ts`：除了下面那一行，代码库里不该有第二处读它的地方，
 * 全局声明反而是在邀请别处直接引用这个只有构建期才存在的名字。
 */
declare const __SITE_CONFIG__: SiteConfig | undefined;

/**
 * 当前站点的标识值。
 *
 * `typeof` 守卫不是防御性编程的摆设：`define` 只在走 Vite 管线时生效，而本模块可能被
 * 其他宿主直接加载（Node 下的单元测试、将来的脚本）。那时这个标识符压根不存在，读它会
 * 抛 `ReferenceError`，而 `typeof` 是唯一能安全问出"它在不在"的写法。取不到就用内置
 * 默认值——与"配置文件缺失"完全同一条回落路径，不是特例。
 *
 * 常量而非函数：配置在构建期就固定了，运行时不存在会变的可能。
 */
export const SITE: SiteConfig =
  typeof __SITE_CONFIG__ === "undefined" ? DEFAULT_SITE_CONFIG : __SITE_CONFIG__;
