import React from "react";
import type { PageInfo } from "./types";

/**
 * 底栏的页码标签（design §4.7，需求 2.9）。
 *
 * **挂在底栏 `<footer>` 里、绝对定位在它的右上方**（`absolute -top-7 right-4`）：随底栏一起滑入
 * 滑出，又不占底栏那一行的宽度——390px 宽时章节滑杆只剩约 62px，再挤就不能用了
 * （reader-defect-fixes 需求 8）。`<footer>` 是 `fixed`，正是它的包含块；绝对定位的子项不参与
 * 底栏的 flex 排布。底栏隐藏时的平移量要盖过这 28px，见 `ReaderPage` 的底栏。
 *
 * **可见文字与读屏文字分开**：可见的 `x / y` 设 `aria-hidden`，另附一段视觉隐藏的
 * "本章第 x 页，共 y 页"，读屏软件只念后者，不会念成"1 斜杠 3"。它不是实时区域：每翻一页都
 * 播报一次太吵，读屏用户需要时自己读到底栏即可。
 *
 * **不可交互**：`pointer-events: none`，点在它上面等于点在下面的正文上（底栏本身 `stopPropagation`，
 * 标签又浮在底栏之外，拦下点击反而会吞掉一次九宫格 Tap）。
 *
 * 配色取底栏自己的那一对：`--bg` 底、`--text-muted` 字（与章节滑杆两侧的数字相同），边框
 * `--border`。五套主题下 `--text-muted` 对 `--bg` 的对比度 ≥ 4.5:1（`palette.test.ts` 核对）。
 *
 * `info` 为 null（当前章尚未分页，或挂的是滚动视图）时什么也不渲染。`index` 从 0 起算，显示时 +1。
 */
export interface PageNumberBadgeProps {
  info: PageInfo | null;
}

export const PageNumberBadge: React.FC<PageNumberBadgeProps> = ({ info }) => {
  if (info === null) return null;
  const x = info.index + 1;
  const y = info.count;
  return (
    <div className="pointer-events-none absolute -top-7 right-4 rounded-md border px-2 py-0.5 text-xs font-mono shadow-sm bg-[var(--bg)] text-[var(--text-muted)] border-[var(--border)]">
      {/* 用模板字符串拼成一个文本节点：`{x} / {y}` 会拆成三个，静态渲染时夹着注释分隔符 */}
      <span aria-hidden="true">{`${x} / ${y}`}</span>
      <span className="sr-only">{`本章第 ${x} 页，共 ${y} 页`}</span>
    </div>
  );
};
