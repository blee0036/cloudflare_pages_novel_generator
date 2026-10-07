import React from "react";
import { RefreshCw } from "lucide-react";
import type { FetchProgress } from "../utils/loadError";
import { readShelfLoad } from "../utils/shelfLoadProgress";

/**
 * 书架索引（`books.json`）加载中的全屏遮罩：覆盖整个书架页，中间一张卡片放转圈、标题、
 * 读数与进度条。
 *
 * 只有骨架时看不出页面在等数据——骨架画的是"书架长什么样"，脉冲又淡，慢网下读者面对的是
 * 一整页灰格子。遮罩把"正在加载、加载到哪了"放到屏幕正中。
 *
 * 几处取舍：
 *
 * - **半透明 + 2px 模糊，不是不透明**：骨架照旧在下面，透过遮罩看得出列数与卡片外形
 *   （RS-03 的两条审阅准则看的就是这个，模糊再重就认不出了）；数据到位时遮罩一撤，下面
 *   直接是书卡，骨架原有的"不跳动"也还在。
 * - **延迟 150ms 再淡入**（`.animate-overlay-in`）：有缓存或网快时 `books.json` 几十毫秒就
 *   到了，一闪而过的全屏遮罩比没有更难受。延迟期间骨架照常可见。
 * - **不用 `role="status"`**：骨架已经是这一页唯一的状态区（读屏会念它的"正在载入书架索引"，
 *   e2e 也按这个角色定位它）。这里只给进度条一个名字和 `aria-valuetext`，读屏软件聚焦到它时
 *   能读出"已载入 312 KB"。
 * - 进度条两态与阅读器的加载页同一套写法（`ReaderPage`）：确定态按百分比给宽度、
 *   `Math.max(5, …)` 让 0–4% 时仍有一截可见；不确定态是循环滑动的短条，不带 `aria-valuenow`。
 */
export const ShelfLoadingOverlay: React.FC<{ progress: FetchProgress | null }> = ({ progress }) => {
  const { bar, note } = readShelfLoad(progress);
  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center p-4 bg-[var(--bg)]/60 backdrop-blur-[2px] animate-overlay-in">
      <div className="w-full max-w-xs rounded-2xl bg-[var(--card-bg)] border border-[var(--border)] shadow-xl px-6 py-7 text-center">
        <div className="w-14 h-14 rounded-2xl bg-blue-500/10 flex items-center justify-center mx-auto mb-4">
          <RefreshCw aria-hidden="true" className="w-7 h-7 animate-spin text-blue-500" />
        </div>
        <h2 className="text-base font-semibold mb-1">正在载入书架...</h2>
        <p className="text-xs text-[var(--text-muted)] mb-4 tabular-nums">{note}</p>
        <div
          className="w-full bg-[var(--hover)] h-1.5 rounded-full overflow-hidden"
          role="progressbar"
          aria-label="书架索引加载进度"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={bar.kind === "determinate" ? bar.pct : undefined}
          aria-valuetext={note}
        >
          {bar.kind === "determinate" ? (
            <div
              className="bg-blue-500 h-full rounded-full transition-all duration-200"
              style={{ width: `${Math.max(5, bar.pct)}%` }}
            />
          ) : (
            <div className="bg-blue-500 h-full w-1/3 rounded-full animate-progress-loop" />
          )}
        </div>
      </div>
    </div>
  );
};
