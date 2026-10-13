/**
 * 阅读器视图的共享类型（design §1.2）。
 *
 * 分页视图（`PagedReader`）与连续滚动视图（`ScrollReader`）共用这一组类型：两者都以
 * `forwardRef` 暴露同一个 `ReaderViewHandle`，`ReaderPage` 的快捷键分发因此不需要知道
 * 当前挂的是哪种视图。
 *
 * 本模块只有类型，不产生运行时代码；`utils/` 下的纯函数模块也从这里取 `TurnDirection`，
 * 用 `import type` 引入即可，不会形成运行时的循环依赖。
 */

import type { RefObject } from "react";
import type { BookToc, ReaderSettings } from "../../types";
import type { ChapterViews } from "../../utils/locator";

/**
 * 翻页方向（需求 4.2、5.2、5.3）。`"prev"` 往回翻，`"next"` 往后翻。
 *
 * 用字符串而不是 ±1：它会进 `TurnState`、`onBoundary` 回调与测试钩子，可读性比省几个字节重要。
 */
export type TurnDirection = "prev" | "next";

/**
 * 一次翻页的触发来源。
 *
 * 不同来源的起点与卷起角不同（需求 8.1、8.7、8.8）：`drag` 取按下点，`tap` 按落点上下半区，
 * `key`/`wheel` 固定右下角。
 */
export type TurnSource = "drag" | "tap" | "key" | "wheel";

/**
 * 待渲染的命中高亮（design §3.6）。
 *
 * 存的是**章内字符偏移**而不是段落下标：段落集合会随排版重算（`bodyParas` 是 memo），
 * 而偏移是稳定的坐标。换算成"第几段 + 段内起点"由 `resolveHighlight` 在渲染时做
 * （分页模式下再经 `fragmentHighlight` 裁到页片段）。
 *
 * `chapterId` 是给自己定身份用的：读者翻到别的章时这条高亮就不该再出现，即便 5 秒还没到。
 */
export interface HighlightTarget {
  chapterId: number;
  charOffset: number;
  length: number;
}

/**
 * 一次导航指令（design §3.1）。
 *
 * 目录、滑杆、底栏上下章、`?ch=`、检索、书签、首次定位与切换渲染族都下发它；视图在
 * 挂载时与 `seq` 变化时消费：分页模式显示包含 `charOffset` 的那一页，滚动模式把该偏移
 * 所在段落置于判定线（需求 1.6、10.7、12.1–12.4）。章首（`charOffset = 0`）也下发，
 * 因为滚动模式下章首不再是 `scrollTop = 0`。
 *
 * `seq` 单调递增，同一目标连发两次也能被识别为新指令。
 */
export interface NavRequest {
  seq: number;
  /** 目标章的原始下标（`toc.chapters[]` 的下标），已经 `resolveJumpTarget` 归一为正文章。 */
  chapterId: number;
  /** 章内字符偏移（与 `Para.offset` 同一坐标）。 */
  charOffset: number;
}

/** 两种视图共用的 props（design §1.2）。 */
export interface ReaderViewProps {
  toc: BookToc;
  fullText: string;
  views: ChapterViews;
  settings: ReaderSettings;
  /**
   * 读者此刻的位置（含未提交的那一帧），只读。
   *
   * 切换渲染族时 `ReaderPage` 以它下发新的 `NavRequest`（需求 1.6、1.7）；视图自己不写它，
   * 位置变化一律经 `onPosition` 上报。
   */
  positionRef: RefObject<{ chapterId: number; charOffset: number }>;
  nav: NavRequest;
  highlight: HighlightTarget | null;
  controlsVisible: boolean;
  /** 读者移动后上报位置（design §3.2）：换章立即提交，同章只更新待落盘偏移。 */
  onPosition(chapterId: number, charOffset: number): void;
  /** 九宫格 Tap 的控制栏决策（需求 5.4、5.9）。翻页本身不调用它（需求 5.11、11.16）。 */
  onControls(action: "show" | "hide"): void;
  /** 请求的方向上没有可翻的页（需求 3.5、3.6、10.14、10.15）。 */
  onBoundary(direction: TurnDirection): void;
}

/**
 * 当前页在本章中的页码，供底栏显示"x / y"（需求 2.9）。
 *
 * `index` 从 0 起算（显示时 +1），`count ≥ 1`。页码只存在于运行时（需求 2.8）。
 */
export interface PageInfo {
  index: number;
  count: number;
}

/**
 * `PagedReader` 的 props：在公共契约之外多一个页码回调（design §1.2）。
 *
 * 当前章尚未完成分页时传 `null`，底栏据此不显示页码标签；滚动模式没有这个回调。
 */
export interface PagedReaderProps extends ReaderViewProps {
  onPageInfo(info: PageInfo | null): void;
}

/**
 * 两种视图经 `forwardRef` 暴露的句柄（design §1.2）。`ReaderPage` 只通过它驱动视图。
 *
 * 按下时打断动画用的 `abort()` 不在这里：它只在视图与自己的 `useReaderGesture` 之间
 * 传递（design §5.5、§6.3），`ReaderPage` 需要的是 `settle()`。
 */
export interface ReaderViewHandle {
  /** 按键或滚轮触发的一次翻页（分页 100ms 基准；滚动为"保留一行"的翻页滚动）。 */
  turn(direction: TurnDirection, source: "key" | "wheel"): void;
  /** 分页模式：本章首页/末页（需求 11.3）。滚动模式：本章章首/章末（需求 11.13）。 */
  edge(edge: "start" | "end"): void;
  /** 滚动模式：行滚动（需求 11.13）。分页模式下为空操作。 */
  line(direction: 1 | -1): void;
  /**
   * 加书签时记录的偏移（需求 12.5）：分页模式为当前页的 Page_Start_Offset，
   * 滚动模式为判定线处段落的章内偏移。
   */
  bookmarkOffset(): number;
  /** 立刻落定进行中的翻页（切模式、卸载前调用）。 */
  settle(): void;
  /**
   * 此刻是否有翻页动画在进行，只读，供 `keyGateStep` 的 `animating` 使用（需求 11.7，
   * design §8.2；任务 16.6、18.7）。
   *
   * 分页模式：存在进行中的翻页（拖拽中或释放动画中）时为真。滚动模式：翻页滚动动画
   * 进行中为真；鼠标拖拽与惯性不算，按键翻页会直接打断它们（design §7.5）。
   */
  isAnimating(): boolean;
}
