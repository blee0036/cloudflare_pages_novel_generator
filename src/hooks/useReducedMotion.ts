/**
 * 系统"减弱动态效果"开关（需求 9.3、9.7；design §6.8）。
 *
 * ## 为什么是 hook 而不是翻页时现查
 *
 * 翻页器在每次翻页开始时才读这个值（`effectiveTurnAnim(pageAnim, reduced, supported)`），
 * 看起来在那一刻 `matchMedia(...).matches` 现查一次就够。但设置抽屉要按它显示提示
 * （需求 9.6），提示必须跟着系统设置实时出现或消失——这需要订阅 `change` 并触发重渲染。
 * 两处共用同一个来源，翻页器读到的与抽屉显示的就不会不一致。
 *
 * ## 为什么用 `useSyncExternalStore`
 *
 * 媒体查询是标准的"外部可变源"：`useState` + `useEffect` 里先 `sync()` 再订阅的写法，
 * 首帧拿到的是初始值、要等 effect 跑完再渲染一次才对；`useSyncExternalStore` 首帧就读到
 * 真实值，且订阅与读数之间的变化不会漏掉（需求 9.7：运行中切换系统设置，下一次翻页即生效）。
 *
 * ## 不支持 `matchMedia` 时
 *
 * 返回 false，即按读者所选的模式照常播放动画——这与浏览器不认识该媒体特性时的语义一致
 * （读者没有表达过"减弱"的意愿）。
 *
 * ## 不测的原因
 *
 * 与本目录其他 hook 相同：测 React hook 需要 jsdom + testing-library，不在本项目测试范围内。
 * 依赖它的判定（`effectiveTurnAnim`、`showsReducedMotionHint`）是 `utils/pageAnim.ts` 的纯函数，
 * 在那里测；运行时行为由 E2E（全局 `reducedMotion: "reduce"`）覆盖。
 */

import { useSyncExternalStore } from "react";

/** Reduced_Motion 的媒体查询（需求术语表）。 */
export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** 同一个 `MediaQueryList` 供订阅与读数共用；不支持 `matchMedia` 时为 null。 */
let mediaQuery: MediaQueryList | null | undefined;

function getMediaQuery(): MediaQueryList | null {
  if (mediaQuery === undefined) {
    mediaQuery =
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia(REDUCED_MOTION_QUERY)
        : null;
  }
  return mediaQuery;
}

function subscribe(onChange: () => void): () => void {
  const mq = getMediaQuery();
  if (!mq) return () => {};
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

function getSnapshot(): boolean {
  return getMediaQuery()?.matches ?? false;
}

/** 无窗口环境（预渲染）按"未开启"处理，与不支持 `matchMedia` 一致。 */
function getServerSnapshot(): boolean {
  return false;
}

/** `prefers-reduced-motion: reduce` 当前是否成立；系统设置变化时触发重渲染。 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
