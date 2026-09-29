import React from "react";

/**
 * 书架索引加载期间的骨架占位（需求 5.9，差异表 B4）。
 *
 * B4 的抉择是"取旧版骨架屏"，理由是"感知更快，成本极低"。这里的**感知**具体指两件事，
 * 缺哪件都只是把 spinner 换了个形状：
 *
 * 1. 占位卡的盒子要跟 `BookCard` 真卡对齐（同一套网格类、同样的 `h-36` 封面、同样的
 *    两行元信息 + 两枚按钮），数据到位时整页不发生纵向跳动；
 * 2. 骨架本身要立刻可见，不能再有"先空白再出现"的中间态——所以它直接顶替 `loading`
 *    分支，而不是和 spinner 并存。
 *
 * ## 为什么是 8 张，不是 `PAGE_SIZE` 的 50 张
 *
 * 骨架的用途是"把首屏的形状先画出来"，折叠线以下的占位没人看见，却要为此挂 50 套
 * 空节点——那正是差异表 B3（"7000 本一次性挂载会卡死"）在提防的成本，只是换成了
 * 加载态。8 张在 `lg` 的四列下正好铺满两行、在 `sm` 的两列下四行，两种宽度都能把
 * 首屏撑到大致正确的高度，再多也只是加节点不加信息。
 *
 * ## 为什么用 Tailwind 自带的 `animate-pulse`，不自己写 shimmer
 *
 * `index.css` 里 `fadeIn` / `progressLoop` 那两条是自定义关键帧，这条不需要：
 *
 * - `animate-pulse` 只动 `opacity`，进合成层、不触发布局，和 `progressLoop` 选
 *   `transform` 是同一个理由；
 * - shimmer 要一道扫过去的高光渐变，而高光色必须比底色**亮一档**——五套主题里有两套
 *   是深色（`dark` / `black`），同一个高光在明亮主题上会发灰、在纯黑上会发白得刺眼，
 *   等于要为此再派生一个主题变量。脉冲只调既有填充（`--hover` / `--border`）的透明度，
 *   任何调色板都自动成立，配色的唯一真相仍然只在 `index.css`（需求 6.1）。
 *
 * 动画挂在**网格容器**上而不是每张卡上：`opacity` 对整棵子树生效，一条动画即可，
 * 顺带保证 8 张卡同相位（各挂一条也会同相位，但那是 8 条动画）。用 `motion-safe:`
 * 收口，系统开了"减少动态效果"时骨架静止显示——它靠形状而非闪烁传达信息，静止不损功能。
 */

/** 首屏骨架卡数量。取值理由见文件头注释。 */
const SKELETON_COUNT = 8;

/**
 * 单张占位卡：逐块对应 `BookCard` 的真实结构。
 *
 * 高度上唯一需要算一下的是按钮：真卡是 `py-2.5` + `text-xs`（行高 1rem）+ 1px 边框
 * = 38px，所以这里写 `h-9 border border-transparent`（36 + 2）而不是裸 `h-9`，
 * 省下每行 2px 的跳动。真卡在"已有阅读进度"时会多出一块进度条、比无进度时高一截，
 * 网格行本就按最高的卡拉伸——骨架按无进度形态对齐，是那两种高度里保守的一个。
 */
const SkeletonCard: React.FC = () => (
  <div className="bg-[var(--card-bg)] rounded-2xl shadow-sm border border-[var(--border)] flex flex-col overflow-hidden">
    {/* 封面区：对应真卡的 h-36 渐变头（左上"全本精校"徽标、右上体积、底部书名 + 作者） */}
    <div className="h-36 bg-[var(--hover)] p-4 flex flex-col justify-between">
      <div className="flex justify-between items-start">
        <div className="h-4 w-20 rounded-full bg-[var(--border)]" />
        <div className="h-4 w-14 rounded-full bg-[var(--border)]" />
      </div>
      <div className="space-y-2">
        <div className="h-5 w-3/4 rounded bg-[var(--border)]" />
        <div className="h-3 w-1/3 rounded bg-[var(--border)]" />
      </div>
    </div>

    {/* 信息区：章数/字数一行 + 进度或"尚未阅读"一行，再压上两枚等宽按钮 */}
    <div className="p-4 flex-1 flex flex-col justify-between space-y-4">
      <div className="space-y-2">
        <div className="h-4 w-2/5 rounded bg-[var(--hover)]" />
        <div className="h-4 w-4/5 rounded bg-[var(--hover)]" />
      </div>
      <div className="flex items-center space-x-2">
        <div className="h-9 flex-1 rounded-xl border border-transparent bg-[var(--hover)]" />
        <div className="h-9 flex-1 rounded-xl border border-transparent bg-[var(--hover)]" />
      </div>
    </div>
  </div>
);

export const BookshelfSkeleton: React.FC = () => (
  /**
   * `role="status"` + `aria-busy` 让读屏软件知道这一块正在等数据；里面那行 `sr-only`
   * 文案承接原先 spinner 下面那句可见提示——骨架的形状只对眼睛说话，它得有个说法。
   * 占位方块全部包在 `aria-hidden` 里：它们是装饰，逐个读出来就是一串无意义的空节点。
   */
  <div role="status" aria-busy="true" className="py-2">
    <span className="sr-only">正在载入书架索引...</span>
    <div
      aria-hidden="true"
      className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6 motion-safe:animate-pulse"
    >
      {Array.from({ length: SKELETON_COUNT }, (_, i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  </div>
);
