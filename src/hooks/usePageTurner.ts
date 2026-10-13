/**
 * 分页翻页器：拖拽、Tap、按键与滚轮翻页的状态机与 rAF 循环（design §6.1–§6.9、G4；需求 2.6、2.7、
 * 3.1、3.2、3.5、3.6、4.2–4.5、4.7–4.9、5.6、8.7–8.10、9.1–9.3、9.7、11.4、11.7、14.1）。
 *
 * ## 职责划分
 *
 * 判定全部是 `utils/` 下的纯函数：拖拽方向与取消（`dragStep`）、相邻页（`stepPage`）、释放终点与时长
 * （`releaseTarget`、`turnDuration`）、插值（`runTouch`）、落定（`settleTarget`）、起点（`tapStart`、
 * `keyStart`）、仿真选角与触点固定（`simCorner`、`pinTouchY`）、本次实际动画（`effectiveTurnAnim`）。
 * 本 hook 只把它们串成状态机并管理 rAF，DOM 图层归视图（`PagedReader`）所有：
 *
 * - **React 状态 `turning`**：存在进行中的翻页（拖拽中或释放动画中）时非 null，视图据它挂图层栈
 *   （`anim` 决定哪套图层，`direction` / `from` / `to` 决定各层放哪一页），`<main data-turning>` 也由它
 *   派生。一次翻页里它只在开始与结束各变一次；拖拽中越过起点换向时多变一次（目标页变了，图层栈要换，
 *   对应 Legado `setDirection` → `setBitmap` 重新截图）。
 * - **帧回调 `applyFrame(turn, viewport)`**：视图据 `TurnState` 算出各层样式——覆盖 / 滑动用
 *   `coverLayout` / `slideLayout`（`offset = touch.x − start.x`），仿真用 `simGeometry` + `simFrame`——
 *   经 ref 写进 `style.transform` 与 `style.clipPath`。本 hook 在 rAF 里调用它，不触发 React 渲染
 *   （G4、需求 14.1）。图层栈首次提交时由本 hook 的 layout effect 在绘制前补写一帧，所以第一帧画面
 *   就是正确的位置；图层栈尚未提交（或已换向、新图层未提交）时不调用，免得写到不对应的图层上。
 *
 * ## 与 Legado 的对应
 *
 * | 本 hook | Legado（`ui/book/read/page/`） |
 * | --- | --- |
 * | `startDrag` / `moveDrag` | `HorizontalPageDelegate.onScroll`（逐行移植为 `dragStep`）；仿真另有 `SimulationPageDelegate.onTouch` 的 `ACTION_MOVE` 触点固定与 `setDirection` 里的 `calcCornerXY` |
 * | `moveDrag` 的 `hasPage` / `onBoundary` | `PageDelegate.hasPrev` / `hasNext` 及其 snackBar（去重在 `noticeStep`） |
 * | `endDrag` | `HorizontalPageDelegate.onTouch` 的 `ACTION_UP` → `onAnimStart(defaultAnimationSpeed = 300)` |
 * | `release` | 各委托的 `onAnimStart`（`releaseTarget`）→ `PageDelegate.startScroll`（`turnDuration`） |
 * | `onFrame` | `PageDelegate.computeScroll` + `Scroller(LinearInterpolator)`（`runTouch`）→ `invalidate` → `onDraw`（`applyFrame`） |
 * | `finish` | `onAnimStop`（`!isCancel` 时 `ReadView.fillPage`）+ `stopScroll` |
 * | `abort` | `HorizontalPageDelegate.abortAnim`，返回值即 `ReadView.isAbortAnim` |
 * | `tapTurn` | `HorizontalPageDelegate.nextPageByAnim` / `prevPageByAnim`：先 `abortAnim`，再 `hasNext` / `hasPrev`，再 `setStartPoint` + `onAnimStart(300)` |
 * | `keyTurn` | `PageDelegate.keyTurnPage`：`if (isRunning) return`，再以 100 调 `*PageByAnim` |
 * | `isAnimating` | `PageDelegate.isRunning`（拖拽越阈后与动画中都为真） |
 *
 * 与 Legado 的差别：
 * - **相邻章未分页**：Legado 在 `isRefreshingResources` 时 `hasNext` 直接返回 false。这里 `stepPage`
 *   返回 `"pending"` 时当场同步分页后重试（design §4.5），宁可一次长任务也不误报"没有下一页"。
 *   同步分页后仍拿不到页数（如视口为 0）时，本次不翻页，也不显示边界提示。
 * - **仿真卷起角与固定触点按按下点**：Legado 在 `ACTION_DOWN` 以按下点选角，但触点固定读的是越阈时
 *   被 `setStartPoint` 重置过的 `startY`；这里两者都按按下点（需求 8.1、8.2），换向后按新方向重选角。
 * - **按键 / 滚轮的仿真卷起角固定右下**（需求 8.8，design §0）：起点取 `keyStart`。
 * - **坐标保留小数**：Legado `setTouchPoint` 截掉纵向位移的小数、`startScroll` 用整数，这里不取整。
 *
 * ## 时序约定
 *
 * - 一次翻页的视口尺寸在开始时读一次（`viewport()`），整个翻页沿用。尺寸变化时视图必须先调用
 *   `settle()` 再重新分页（需求 2.6，design §4.5）。
 * - 当前页 `pos` 在翻页进行中被外部改掉（导航指令、重分页而视图没先 `settle()`）时，本 hook 丢弃这次
 *   翻页、不提交，以外部位置为准。正常路径不会走到这里。
 * - 翻页结束时先 `setTurning(null)` 再同步调用 `onCommit`，React 18 自动批处理把"拆除图层栈"与
 *   "目标页成为当前页"合成一次渲染（design §6.4），屏幕上不会出现空帧。
 *
 * 与本目录其他 hook 一样不做单元测试（项目不搭 jsdom）：判定在 `utils/` 的纯函数里测，运行时行为由
 * E2E 覆盖。
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { TurnDirection, TurnSource } from "../components/reader/types";
import { stepContentChapter, type ChapterViews } from "../utils/locator";
import { PAGE_ANIM, effectiveTurnAnim, type PageAnim } from "../utils/pageAnim";
import { dragStep, initialDragState, type DragState } from "../utils/pageGesture";
import { stepPage, type PagePos } from "../utils/paginate";
import { pinTouchY, simCorner } from "../utils/simulationGeometry";
import {
  keyStart,
  releaseTarget,
  runTouch,
  settleTarget,
  tapStart,
  turnBaseMs,
  turnDuration,
  type Pt,
  type TurnState,
} from "../utils/turnMotion";
import { useReducedMotion } from "./useReducedMotion";

/** Reader_Viewport 的宽高（CSS px），即 `<main>` 的内容盒。 */
export interface TurnViewport {
  w: number;
  h: number;
}

/**
 * 进行中的一次翻页需要挂的图层栈（design §6.4）。视图只据它渲染，逐帧样式走 `applyFrame`。
 *
 * `anim` 为无动画（4）时视图不挂图层栈，照常只显示当前页（需求 9.1、9.2：拖拽中静止）；
 * 此时 `turning` 仍非 null，`<main data-turning="true">` 表示有一次翻页尚未落定。
 */
export interface TurningLayers {
  /** 本次实际播放的动画（`effectiveTurnAnim` 的结果），翻页途中不变（需求 9.3、9.7）。 */
  anim: PageAnim;
  direction: TurnDirection;
  source: TurnSource;
  /** 翻页前的页，即图层里的 `cur`。 */
  from: PagePos;
  /** 目标页：NEXT 时是图层里的 `next`，PREV 时是 `prev`。 */
  to: PagePos;
}

/** 一次翻页的结局，交给 `onTurnSettled`。 */
export interface TurnOutcome {
  from: PagePos;
  to: PagePos;
  /** 是否落到目标页（`!cancel`）；为 false 时回到 `from`。 */
  committed: boolean;
  /** 落到的页：`settleTarget` 的结果，即 `committed ? to : from`。 */
  landed: PagePos;
}

export interface PageTurnerOptions {
  /** 当前显示的页（视图状态，翻页完成后由 `onCommit` 更新）。 */
  pos: PagePos;
  views: ChapterViews;
  /** 读者所选的翻页模式（`settings.pageAnim`，0、1、2、4）。每次翻页开始时读一次。 */
  pageAnim: PageAnim;
  /** 分页器：该章在当前 `layoutKey` 下的页数，未分页时为 undefined（`stepPage` 的入参）。 */
  pageCount: (chapterId: number) => number | undefined;
  /**
   * 分页器的兜底：当场同步完成该章分页，返回后 `pageCount(chapterId)` 应可用（design §4.5）。
   * 只在事件回调（指针、按键、滚轮定时器）里被调用，可以在内部 `flushSync`。做不到（视口为 0 等）
   * 时保持 undefined 即可。
   */
  ensurePaginated: (chapterId: number) => void;
  /** 视口尺寸。每次翻页开始时调用一次，宜返回 ResizeObserver 缓存的值。 */
  viewport: () => TurnViewport;
  /**
   * 把一帧写进图层（G4）：只写 `style`，不读布局、不 setState。`anim` 为无动画时不会被调用。
   *
   * 覆盖 / 滑动：`coverLayout` / `slideLayout(turn.direction, turn.touch.x − turn.start.x, w)`，
   * 返回 null 时静止显示当前页。仿真：`simGeometry(turn.touch, turn.corner, w, h)` + `simFrame`，
   * 返回 null 时按平整页绘制（design §6.7）。
   */
  applyFrame: (turn: Readonly<TurnState>, viewport: TurnViewport) => void;
  /**
   * 翻页落到目标页（未取消）。与拆除图层栈处于同一批更新（design §6.4）。
   *
   * 视图在这里把 `to` 设为当前页，并按 `pagedPositionStep({ kind: "turned", to, starts })` 的
   * `report` 调用 `onPosition(to.chapterId, starts[to.page])`（需求 2.7、3.1、3.2）。
   */
  onCommit: (to: PagePos, from: PagePos) => void;
  /** 请求的方向上没有可翻的页（需求 3.5、3.6、4.3）。拖拽冻结期间每步都会再报，去重交给 `noticeStep`。 */
  onBoundary: (direction: TurnDirection) => void;
  /**
   * 一次翻页结束（提交或还原），紧跟在 `onCommit` 之后调用。
   *
   * 视图在这里于跨章提交（`committed && to.chapterId !== from.chapterId`）后调度新相邻章的分页
   * （需求 14.3）。后台分页的暂停与恢复宜跟随 `turning`（非 null 即暂停，design §4.5）：
   * 被外部改页丢弃的翻页不经过这里。
   */
  onTurnSettled?: (outcome: TurnOutcome) => void;
}

export interface PageTurner {
  /** 进行中的翻页需要挂的图层栈；null 表示静止，只显示当前页。 */
  turning: TurningLayers | null;
  /**
   * 手势判为 Drag（`useReaderGesture` 的 `onDragStart`）：`press` 是按下点，`focus` 是越阈时的焦点。
   * 起步方向上没有页时提示边界，本次拖拽全程静止（需求 4.3）。
   */
  startDrag: (press: Pt, focus: Pt) => void;
  /** 拖拽移动（`onDragMove`）：经 `dragStep` 更新触点并安排一次 rAF（需求 4.4、4.5）。 */
  moveDrag: (focus: Pt) => void;
  /** 拖拽结束（`onDragEnd`）：以 300ms 基准完成或撤销本次翻页（需求 4.7、4.8）。 */
  endDrag: () => void;
  /** 九宫格 Tap 翻页，`tapY` 是按下点纵坐标（`<main>` 坐标系）。300ms 基准（需求 5.6、8.7）。 */
  tapTurn: (direction: TurnDirection, tapY: number) => void;
  /** 按键或滚轮翻页。100ms 基准，有翻页进行中时忽略（需求 11.4、11.7、8.8）。 */
  keyTurn: (direction: TurnDirection, source: "key" | "wheel") => void;
  /**
   * 指针按下时调用（`useReaderGesture` 的 `abort`）：立即落定进行中的翻页，返回是否确实打断了一段
   * 释放动画（需求 4.9、5.10）。
   */
  abort: () => boolean;
  /** 立即落定进行中的翻页：视口尺寸变化、切模式、卸载前调用（需求 2.6，`ReaderViewHandle.settle`）。 */
  settle: () => void;
  /** 是否存在进行中的翻页（拖拽中或释放动画中），供 `keyGateStep` 的 `animating`（需求 11.7）。 */
  isAnimating: () => boolean;
}

// ───────────────────────────── 仿真支持度 ─────────────────────────────

/** `effectiveTurnAnim` 的 `simulationSupported` 探针值（design §6.7 降级）。 */
const SIMULATION_CLIP_PROBE = 'path(evenodd, "M0 0")';

let simulationClipSupported: boolean | undefined;

/**
 * 浏览器是否支持 `clip-path: path(evenodd, …)`。不支持时仿真降级为覆盖（design §6.7）。
 * 结果不会在页面生命周期内变化，首次调用后缓存。
 */
export function supportsSimulationClip(): boolean {
  if (simulationClipSupported === undefined) {
    simulationClipSupported =
      typeof CSS !== "undefined" &&
      typeof CSS.supports === "function" &&
      CSS.supports("clip-path", SIMULATION_CLIP_PROBE);
  }
  return simulationClipSupported;
}

// ───────────────────────────── 内部状态 ─────────────────────────────

/** 进行中的一次翻页。 */
interface ActiveTurn {
  turn: TurnState;
  /** 翻页开始时的视口尺寸，整个翻页沿用。 */
  viewport: TurnViewport;
  /** 交给 React 的图层描述；与已提交的那份是同一对象时才写帧。 */
  layers: TurningLayers;
}

/** 一次拖拽手势（含起步无页而全程静止的拖拽）。 */
interface DragRecord {
  state: DragState;
  /** 按下点纵坐标：仿真卷起角与固定触点都以它为准（需求 8.1、8.2）。 */
  pressY: number;
}

/** 某方向上的相邻页探测结果。 */
type Probe = { kind: "page"; to: PagePos } | { kind: "boundary" } | { kind: "unavailable" };

const BOUNDARY: Probe = { kind: "boundary" };
const UNAVAILABLE: Probe = { kind: "unavailable" };

function samePos(a: PagePos, b: PagePos): boolean {
  return a.chapterId === b.chapterId && a.page === b.page;
}

/**
 * 拖拽中的触点：仿真时按中间带规则固定纵坐标（`pinTouchY`，Legado `onTouch` 的 `ACTION_MOVE`），
 * 其余模式原样返回。
 */
function dragTouch(anim: PageAnim, direction: TurnDirection, touch: Pt, pressY: number, h: number): Pt {
  if (anim !== PAGE_ANIM.simulation) return touch;
  const y = pinTouchY(direction, pressY, h);
  return y === null ? touch : { x: touch.x, y };
}

// ───────────────────────────── hook ─────────────────────────────

export function usePageTurner(options: PageTurnerOptions): PageTurner {
  const reduced = useReducedMotion();
  const [turning, setTurning] = useState<TurningLayers | null>(null);

  /** 最新一次渲染的选项与减弱动态效果状态；在 layout 时段刷新，早于任何事件回调与 rAF。 */
  const latestRef = useRef({ ...options, reduced });
  useLayoutEffect(() => {
    latestRef.current = { ...options, reduced };
  });

  const activeRef = useRef<ActiveTurn | null>(null);
  const dragRef = useRef<DragRecord | null>(null);
  const frameRef = useRef<number | null>(null);
  /**
   * 翻页的出发页。提交时立即改为目标页，不等视图重渲染：rAF 里提交之后、React 渲染之前到达的
   * 按键仍从正确的页起步。`pos` 变化时再与之对齐。
   */
  const posRef = useRef<PagePos>(options.pos);
  /** 上一次看到的 `options.pos`，用来分辨"外部改了当前页"。 */
  const propPosRef = useRef<PagePos>(options.pos);
  /** 已提交到 DOM 的图层描述（`turning` 的提交值）。 */
  const committedLayersRef = useRef<TurningLayers | null>(null);

  const machine = useMemo(() => {
    function requestFrame(): void {
      if (frameRef.current === null) frameRef.current = requestAnimationFrame(onFrame);
    }

    function cancelFrame(): void {
      if (frameRef.current === null) return;
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }

    /** 本次翻页实际播放的动画（design §6.8）：每次翻页开始时按此刻的设置与系统状态取（需求 9.7）。 */
    function currentAnim(): PageAnim {
      const { pageAnim, reduced: reducedNow } = latestRef.current;
      return effectiveTurnAnim(pageAnim, reducedNow, supportsSimulationClip());
    }

    function stepFrom(from: PagePos, direction: TurnDirection): PagePos | "pending" | null {
      const { views, pageCount } = latestRef.current;
      return stepPage(from, direction, views, pageCount);
    }

    /**
     * `stepPage` 返回 `"pending"` 时缺的那一章：往后翻且当前章页数未知时是当前章，否则是相邻正文章。
     * 相邻章由 `stepContentChapter` 求，与 `stepPage` 同一口径（跳过卷节点）。
     */
    function missingChapter(from: PagePos, direction: TurnDirection): number {
      const { views, pageCount } = latestRef.current;
      if (direction === "next" && !((pageCount(from.chapterId) ?? 0) >= 1)) return from.chapterId;
      return stepContentChapter(views, from.chapterId, direction === "next" ? 1 : -1);
    }

    /**
     * `from` 往 `direction` 的相邻页（Legado `hasNext` / `hasPrev`，不含提示）。
     *
     * `"pending"` 视为有页并当场补分页（design §4.5、§6.1）：往后跨章最多缺两章的页数（当前章、
     * 下一章），所以至多补两次。补完仍未知时为 `unavailable`，调用方不翻页、不提示。
     */
    function probe(from: PagePos, direction: TurnDirection): Probe {
      let r = stepFrom(from, direction);
      for (let i = 0; i < 2 && r === "pending"; i++) {
        latestRef.current.ensurePaginated(missingChapter(from, direction));
        r = stepFrom(from, direction);
      }
      if (r === null) return BOUNDARY;
      if (r === "pending") return UNAVAILABLE;
      return { kind: "page", to: r };
    }

    /** 写一帧（`onDraw`）。图层栈还没提交、或提交的不是这一份时跳过，提交时由 layout effect 补写。 */
    function writeFrame(active: ActiveTurn): void {
      if (active.turn.anim === PAGE_ANIM.none) return;
      if (committedLayersRef.current !== active.layers) return;
      latestRef.current.applyFrame(active.turn, active.viewport);
    }

    /** rAF 回调（`computeScroll`）：释放后按时间插值推进触点，拖拽中只把最新触点画出来。 */
    function onFrame(now: number): void {
      frameRef.current = null;
      const active = activeRef.current;
      if (!active) return;
      const { run } = active.turn;
      if (!run) {
        writeFrame(active);
        return;
      }
      const { touch, done } = runTouch(run, now);
      active.turn = { ...active.turn, last: active.turn.touch, touch };
      // 末帧也写：它与目标页静止时的画面一致，拆除图层栈之前不会退回上一帧
      writeFrame(active);
      if (done) finish();
      else requestFrame();
    }

    /** 建立（或换向后重建）一次翻页，并让 React 挂上对应的图层栈。 */
    function begin(turn: TurnState, viewport: TurnViewport): ActiveTurn {
      const layers: TurningLayers = {
        anim: turn.anim,
        direction: turn.direction,
        source: turn.source,
        from: turn.from,
        to: turn.to,
      };
      const active: ActiveTurn = { turn, viewport, layers };
      activeRef.current = active;
      setTurning(layers);
      return active;
    }

    /**
     * 释放（`onAnimStart` → `startScroll`）：算终点与 Turn_Duration，进入线性插值动画。
     * 无动画模式（终点即触点）与零位移时时长为 0，当场落定（需求 9.1、9.2）。
     */
    function release(active: ActiveTurn): void {
      const { turn } = active;
      const { w, h } = active.viewport;
      const to = releaseTarget(turn.anim, turn.direction, turn.cancel, turn.start, turn.touch, turn.corner, w, h);
      const duration = turnDuration(turnBaseMs(turn.source), to.x - turn.touch.x, to.y - turn.touch.y, w, h);
      // 视口为 0 时会得到 NaN 或 Infinity，同样当场落定
      if (!(duration > 0) || !Number.isFinite(duration)) {
        finish();
        return;
      }
      active.turn = { ...turn, run: { from: turn.touch, to, t0: performance.now(), duration } };
      requestFrame();
    }

    /**
     * 结束当前翻页（`onAnimStop` + `stopScroll`）：按 `settleTarget` 提交或还原，在同一批更新里拆除
     * 图层栈（需求 4.9、2.6、6.4、13.3）。
     *
     * 不清拖拽记录：按键翻页可能与一次尚未定向（或起步无页）的拖拽并存，翻页结束后拖拽照常继续。
     * 需要连拖拽一起结束的入口（`abort`、`settle`）自己清。
     */
    function finish(): void {
      const active = activeRef.current;
      if (!active) return;
      cancelFrame();
      activeRef.current = null;
      const { turn } = active;
      const landed = settleTarget(turn);
      const committed = !turn.cancel;
      setTurning(null);
      const opts = latestRef.current;
      if (committed) {
        posRef.current = turn.to;
        opts.onCommit(turn.to, turn.from);
      }
      opts.onTurnSettled?.({ from: turn.from, to: turn.to, committed, landed });
    }

    /** 外部改了当前页：丢弃进行中的翻页，不提交、不回调。 */
    function discard(): void {
      cancelFrame();
      activeRef.current = null;
      dragRef.current = null;
      setTurning(null);
    }

    /** Tap、按键、滚轮的翻页：从 `start` 起步、`cancel = false`，立即进入释放动画（design §6.3）。 */
    function startProgrammatic(direction: TurnDirection, source: TurnSource, startOf: (vp: TurnViewport) => Pt): void {
      const from = posRef.current;
      const target = probe(from, direction);
      if (target.kind === "boundary") {
        latestRef.current.onBoundary(direction);
        return;
      }
      if (target.kind === "unavailable") return;
      const viewport = latestRef.current.viewport();
      const anim = currentAnim();
      const start = startOf(viewport);
      const active = begin(
        {
          anim,
          direction,
          source,
          start,
          touch: start,
          last: start,
          cancel: false,
          // 起点纵坐标与选角在同一侧（`tapStart` 注释），按键起点 y = h 恒为右下角（需求 8.7、8.8）
          corner: anim === PAGE_ANIM.simulation ? simCorner(direction, start.y, viewport.w, viewport.h) : null,
          from,
          to: target.to,
          run: null,
        },
        viewport,
      );
      release(active);
    }

    function startDrag(press: Pt, focus: Pt): void {
      // 按下时手势层已 abort()；仍有拖拽翻页说明上一次拖拽没收到结束，先落定它
      if (activeRef.current?.turn.source === "drag") finish();
      dragRef.current = { state: initialDragState(press), pressY: press.y };
      moveDrag(focus);
    }

    function moveDrag(focus: Pt): void {
      const drag = dragRef.current;
      if (!drag) return;
      const active = activeRef.current;
      // 按下之后、越阈之前插进来的按键翻页：等它播完，拖拽再从新的当前页起步
      if (active && active.turn.source !== "drag") return;

      const from = active ? active.turn.from : posRef.current;
      const probes = new Map<TurnDirection, Probe>();
      const probeOnce = (direction: TurnDirection): Probe => {
        let p = probes.get(direction);
        if (!p) {
          p = probe(from, direction);
          probes.set(direction, p);
        }
        return p;
      };

      const { state, notice } = dragStep(drag.state, focus, (direction) => probeOnce(direction).kind === "page");
      drag.state = state;
      // 只为真正的边界提示；同步分页也拿不到页数时静默
      if (notice !== null && probes.get(notice)?.kind === "boundary") latestRef.current.onBoundary(notice);

      const { direction } = state;
      if (state.blocked || direction === null) return;

      let current: ActiveTurn;
      if (active && active.turn.direction === direction) {
        // 跟随：只更新触点（`setTouchPoint`）
        current = active;
        current.turn = {
          ...active.turn,
          start: state.start,
          touch: dragTouch(active.turn.anim, direction, state.touch, drag.pressY, active.viewport.h),
          last: state.last,
          cancel: state.cancel,
        };
      } else {
        // 起步或越过起点换向（`setDirection`）：目标页变了，重建图层栈
        const target = probeOnce(direction);
        if (target.kind !== "page") return; // dragStep 只在有页时定向，不会走到这里
        const viewport = active ? active.viewport : latestRef.current.viewport();
        const anim = active ? active.turn.anim : currentAnim();
        current = begin(
          {
            anim,
            direction,
            source: "drag",
            start: state.start,
            touch: dragTouch(anim, direction, state.touch, drag.pressY, viewport.h),
            last: state.last,
            cancel: state.cancel,
            corner: anim === PAGE_ANIM.simulation ? simCorner(direction, drag.pressY, viewport.w, viewport.h) : null,
            from,
            to: target.to,
            run: null,
          },
          viewport,
        );
      }
      // 无动画模式拖拽中页面静止（需求 9.2），不必画
      if (current.turn.anim !== PAGE_ANIM.none) requestFrame();
    }

    function endDrag(): void {
      const drag = dragRef.current;
      dragRef.current = null;
      const active = activeRef.current;
      if (!drag || !active || active.turn.source !== "drag" || active.turn.run) return;
      release(active);
    }

    function tapTurn(direction: TurnDirection, tapY: number): void {
      abort();
      startProgrammatic(direction, "tap", ({ w, h }) => tapStart(direction, tapY, w, h));
    }

    function keyTurn(direction: TurnDirection, source: "key" | "wheel"): void {
      if (activeRef.current) return;
      startProgrammatic(direction, source, ({ w, h }) => keyStart(direction, w, h));
    }

    function abort(): boolean {
      dragRef.current = null;
      const active = activeRef.current;
      if (!active) return false;
      const animating = active.turn.run !== null;
      finish();
      return animating;
    }

    function settle(): void {
      dragRef.current = null;
      finish();
    }

    function isAnimating(): boolean {
      return activeRef.current !== null;
    }

    /** 卸载：停掉 rAF 即可。落定由 `ReaderPage` 在卸载前经 `settle()` 完成，这里不再 setState。 */
    function dispose(): void {
      cancelFrame();
      activeRef.current = null;
      dragRef.current = null;
    }

    return {
      api: { startDrag, moveDrag, endDrag, tapTurn, keyTurn, abort, settle, isAnimating },
      writeFrame,
      discard,
      dispose,
    };
  }, []);

  // 当前页被外部改掉：与之对齐；翻页还在进行且出发页不是它，就丢弃这次翻页
  const { chapterId, page } = options.pos;
  useLayoutEffect(() => {
    const pos: PagePos = { chapterId, page };
    if (samePos(pos, propPosRef.current)) return;
    propPosRef.current = pos;
    posRef.current = pos;
    const active = activeRef.current;
    if (active && !samePos(active.turn.from, pos)) machine.discard();
  }, [chapterId, page, machine]);

  // 图层栈提交后、绘制前补写当前帧，第一帧画面即正确位置（G4）
  useLayoutEffect(() => {
    committedLayersRef.current = turning;
    const active = activeRef.current;
    if (turning && active) machine.writeFrame(active);
  }, [turning, machine]);

  useEffect(() => machine.dispose, [machine]);

  return useMemo(() => ({ turning, ...machine.api }), [turning, machine]);
}
