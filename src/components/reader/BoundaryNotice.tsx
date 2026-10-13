import React from "react";

/**
 * 边界提示"没有上一页 / 没有下一页"（design §6.9，需求 3.5–3.8、10.14、10.15）。
 *
 * **实时区域常驻 DOM，只替换文字**：`role="status"` 的元素从挂载起就在，提示出现时只是往里
 * 写入文字、到期时清空。读屏软件只对"已存在的实时区域里的内容变化"可靠播报；若随提示一起
 * 插入整个区域，NVDA / VoiceOver 常常一个字也不念（需求 3.8）。
 *
 * **没有提示时屏幕上什么也没有**：实时区域本身不带任何盒子样式，空着时尺寸为 0；外层定位壳
 * 高度为 0 且 `pointer-events: none`，不挡正文的点击与选择，也不改变任何像素基线。提示出现时
 * 才给实时区域加上底色、边框与内边距。不用 `hidden` / `visibility: hidden` 来"藏"：那会把它
 * 移出无障碍树，再显示时同样可能不播报。
 *
 * 提示状态（至多一条、1.5 秒到期）由 `ReaderPage` 经 `useBoundaryNotice` 用 `noticeStep` 维护，
 * 这里只负责呈现。
 */
export interface BoundaryNoticeProps {
  /** 当前提示文字；`null` 表示没有提示。 */
  text: string | null;
}

/**
 * 提示可见时的样式。配色取 `--card-bg` 底、`--text` 字、`--border` 边框：五套主题下
 * `--text` 对 `--card-bg` 的对比度 ≥ 4.5:1（`palette.test.ts` 核对）。
 */
const VISIBLE_CLASS =
  "rounded-full border px-4 py-2 text-xs font-medium shadow-md bg-[var(--card-bg)] text-[var(--text)] border-[var(--border)]";

export const BoundaryNotice: React.FC<BoundaryNoticeProps> = ({ text }) => (
  /*
   * 位于底栏上方居中：底栏 `h-14`（56px）贴底，`bottom-20`（80px）在它上方留出 24px，并让开
   * 底栏右上方的页码标签（design §4.7，`-top-7 right-4`）。与顶栏、底栏同在 `z-30`，DOM 顺序
   * 在底栏之后，因而浮在底栏与正文之上；三个抽屉是 `z-40`，打开时盖住它。
   */
  <div className="pointer-events-none fixed inset-x-0 bottom-20 z-30 flex justify-center px-4">
    <div role="status" aria-live="polite" aria-atomic="true" className={text === null ? undefined : VISIBLE_CLASS}>
      {text}
    </div>
  </div>
);
