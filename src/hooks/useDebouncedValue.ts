/**
 * 取值的防抖（需求 5.7：末次输入后 250ms 内给出结果）。
 *
 * ## 防的是检索，不是输入框
 *
 * 关键在于 `searchTerm` 这个受控值**不进防抖**——输入框必须逐键即时回显，否则光标会在
 * 慢打字时跳字。进防抖的只有"拿哪个词去跑 `searchBooks`"这一步。所以本 hook 的形状是
 * "跟随一个值、延迟落定"，而不是包装一个回调：调用方照常 `setSearchTerm(e.target.value)`，
 * 只把派生出来的落定值喂给 `useMemo` 的依赖。
 *
 * ## 250ms 的由来
 *
 * 实测 7000 本一次模糊检索 0.89–1.16 ms（design §5 / 附录 M4），本来不防抖也不卡；防抖
 * 在这里换来的是"结果列表不在打字途中每键重排一次"的观感，以及分页窗口不被半个词触发重置。
 * 旧版那 800ms 是给 FlexSearch 建索引留的余量，与现在的实现无关，故按需求收到 250ms。
 *
 * ## 不测的原因
 *
 * 这是个 React hook，测它要搭 jsdom + testing-library，design §11 已明确把 DOM/React
 * 渲染测试划在范围外。值得测的算术（分页钳位）另放在 `utils/pagination.ts`。
 */

import { useEffect, useState } from "react";

/** 书架搜索的防抖窗口（ms），需求 5.7 定值。 */
export const SEARCH_DEBOUNCE_MS = 250;

/**
 * 返回 `value` 的落定版本：`value` 停止变化 `delayMs` 之后才跟上。
 *
 * 初始值直接取 `value`，首屏不多等一个 `delayMs`——挂载时的"末次输入"就是初始值本身。
 * 每次 `value` 变化都会清掉上一个计时器，所以连续输入只会在最后一键之后触发一次落定
 * （需求 5.7 的"末次输入后"）。
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    // 已经落定的值不再排计时器：否则每次落定引发的重跑都会空转一个 250ms 的定时器，
    // 卸载时机也更难说清。
    if (Object.is(settled, value)) return;

    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs, settled]);

  return settled;
}
