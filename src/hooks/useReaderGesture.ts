/**
 * 指针手势层：把 `<main>` 上的 Pointer Events 分成 Tap / Long_Press / Drag（design §5.1–§5.5；
 * 需求 4.1、4.6、4.10、4.11、5.1、5.7、5.8、5.10）。
 *
 * 分类本身是纯函数 `gestureStep`，Tap 决策是 `tapZone` + `resolveTap`；这里只做 DOM 那一半：
 * - **挂载与排除**（§5.1）：监听器挂在视图自己的 `<main>` 上。控制栏与抽屉是 `fixed` 的兄弟节点，
 *   事件到不了这里；`<main>` 内的可交互元素按 `GESTURE_EXCLUDE_SELECTOR` 排除；只处理鼠标主键
 *   与 touch / pen；落在滚动条上的按下不处理；按下即 `setPointerCapture`，拖出视口手势仍连续。
 * - **长按定时器**：进入 `pressed` 时启动 600ms 定时器，离开时撤销，到期以 `timer` 事件喂回。
 * - **选区**（§5.3）：按压或拖拽期间拦截 `selectstart`、`dragstart` 与触摸的 `contextmenu`，
 *   原生选词因此不会启动；长按以 `caretPositionFromPoint`（回退 `caretRangeFromPoint`）自建选区。
 *   按下时已有选区则清除，并记下 `hadSelection`（需求 5.8）。
 * - **打断动画**：手势开始时调用视图的 `abort()`，结果即 `abortedAnimation`（需求 5.10）。
 *
 * 坐标约定：交给回调的点都以 `<main>` 的 `getBoundingClientRect()` 左上角为原点（需求 5.1），
 * 矩形在手势开始时读一次，整个手势沿用，移动路径上不读布局。
 *
 * 回调与选项取最新一次渲染的值（经 ref），监听器只在挂载时绑定一次。因此 `<main>` 必须在视图
 * 首次提交时就已存在，且在视图生命周期内不被替换。
 *
 * 与本目录其他 hook 一样不做单元测试（项目不搭 jsdom）；分类与决策在 `utils/pageGesture.ts`
 * 测，运行时行为由 E2E 覆盖。
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import type { RenderFamily } from "../utils/pageAnim";
import {
  GESTURE_IDLE,
  LONG_PRESS_MS,
  gestureStep,
  resolveTap,
  type GestureEvent,
  type GestureOutput,
  type GestureState,
  type TapDecision,
} from "../utils/pageGesture";
import { tapZone } from "../utils/tapZone";
import type { Pt } from "../utils/turnMotion";

/**
 * 按下目标落在这些元素内（且在 `<main>` 之内）时，手势交给元素自己（需求 4.11、5.7）。
 *
 * `[data-reader-chrome]` 留给以后放进 `<main>` 的浮层控件使用。
 */
export const GESTURE_EXCLUDE_SELECTOR = "a,button,input,select,textarea,label,[data-reader-chrome]";

export interface ReaderGestureOptions {
  /** 视图自己的 `<main>`（滚动模式下即滚动容器）。 */
  mainRef: RefObject<HTMLElement>;
  /** 视图所属渲染族，进 `TapContext.family`（design §5.5 规则 5）。 */
  family: RenderFamily;
  /** 控制栏是否可见。取按下那一刻的值（需求 5.9）。 */
  controlsVisible: boolean;
  /** 为 false 时忽略新的按下；由 true 变 false 时结束进行中的手势（拖拽中会收到 `onDragEnd`）。默认 true。 */
  enabled?: boolean;
  /**
   * 手势开始（首个指针按下）时调用：立即结束进行中的翻页动画（分页）或滚动动画 / 惯性（滚动），
   * 返回是否确实结束了一个（需求 4.9、5.10、10.13）。多指的后续指针按下不再调用。
   */
  abort: () => boolean;
  /**
   * 手势以 Tap 结束。`decision` 已按 design §5.5 归约（`none` 也会送达，视图忽略即可）；
   * `at` 是按下点。
   */
  onTap: (decision: TapDecision, at: Pt) => void;
  /**
   * 焦点越过 Touch_Slop，手势判为 Drag（需求 4.1）。`focus` 是多指焦点（需求 4.6）。
   *
   * `pointerType` 是本次手势首个指针的类型：滚动视图只自绘鼠标拖拽，触摸交给浏览器原生滚动
   * （design G6、§7.5），靠它区分。
   *
   * `start` 是按下点（首个指针按下时的坐标，与 `focus` 同一坐标系）。分页翻页器以它为
   * `dragStep` 的起点判定拖拽方向（需求 4.2），并据它选仿真卷起角与固定触点（需求 8.1、8.2）。
   */
  onDragStart: (focus: Pt, pointerType: string, start: Pt) => void;
  onDragMove: (focus: Pt) => void;
  /** 拖拽结束：最后一个指针抬起，或浏览器接管（`pointercancel`，如触摸原生滚动）。 */
  onDragEnd: () => void;
}

export interface ReaderGesture {
  /**
   * 当前是否处于 Long_Press（按住满 600ms 未移动，之后的移动只扩展选区）。
   *
   * 供滚动视图的 `{ passive: false }` `touchmove` 监听使用：为真时 `preventDefault()`，
   * 否则 `touch-action: pan-y` 会把长按后的移动接管成原生滚动，选区扩展不下去（design §5.3）。
   */
  isLongPressing: () => boolean;
}

/** 选区里的一个字：`node` 中 `[start, end)` 这一段（代理对占两个码元）。 */
interface CharSpan {
  node: Text;
  start: number;
  end: number;
}

/** 一个插入点。 */
interface Caret {
  node: Node;
  offset: number;
}

/** 本次手势在按下那一刻收集的上下文（`TapContext` 的字段"均为按下那一刻的状态"）。 */
interface PressContext {
  /** `<main>` 的边框盒；本次手势的所有坐标都以它为原点。 */
  rect: DOMRect;
  pointerType: string;
  family: RenderFamily;
  controlsVisible: boolean;
  hadSelection: boolean;
  abortedAnimation: boolean;
  /** 长按选中的那个字，是扩展选区的固定端；未长按或没取到字时为 null。 */
  anchor: CharSpan | null;
}

export function useReaderGesture(options: ReaderGestureOptions): ReaderGesture {
  const { mainRef, enabled = true } = options;

  /** 最新一次渲染的选项；在 layout 时段刷新，早于任何事件回调。 */
  const latestRef = useRef(options);
  useLayoutEffect(() => {
    latestRef.current = options;
  });

  /** 分类状态。放在 ref 里而不是闭包里：`isLongPressing` 与 `enabled` 的处理都要读它。 */
  const gestureRef = useRef<GestureState>(GESTURE_IDLE);

  /** 结束进行中的手势（等同首个指针 `pointercancel`）；监听器绑定期间由挂载 effect 提供。 */
  const cancelGestureRef = useRef<() => void>(() => {});

  useEffect(() => {
    const main = mainRef.current;
    if (!main) return;

    let press: PressContext | null = null;
    let timer: number | null = null;

    const clearTimer = () => {
      if (timer === null) return;
      window.clearTimeout(timer);
      timer = null;
    };

    const toLocal = (e: PointerEvent, rect: DOMRect): Pt => ({ x: e.clientX - rect.left, y: e.clientY - rect.top });

    const emit = (out: GestureOutput) => {
      const ctx = press;
      if (!ctx) return;
      const opts = latestRef.current;
      switch (out.kind) {
        case "drag-start":
          // dispatch 先写回状态再 emit，此刻 gestureRef 已是 drag 阶段，start 仍是按下点
          opts.onDragStart(out.focus, ctx.pointerType, gestureRef.current.start);
          return;
        case "drag-move":
          opts.onDragMove(out.focus);
          return;
        case "drag-end":
          opts.onDragEnd();
          return;
        case "long-press":
          ctx.anchor = selectCharAt(main, ctx.rect.left + out.at.x, ctx.rect.top + out.at.y);
          return;
        case "select-extend":
          if (ctx.anchor) extendSelection(main, ctx.anchor, ctx.rect.left + out.to.x, ctx.rect.top + out.to.y);
          return;
        case "tap": {
          const decision = resolveTap({
            zone: tapZone(out.at.x, out.at.y, ctx.rect.width, ctx.rect.height),
            hadSelection: ctx.hadSelection,
            controlsVisible: ctx.controlsVisible,
            abortedAnimation: ctx.abortedAnimation,
            family: ctx.family,
          });
          opts.onTap(decision, out.at);
          return;
        }
        case "none":
          return;
      }
    };

    /** 喂一个事件给 `gestureStep`，按阶段变化启停长按定时器，再把输出交给视图。 */
    const dispatch = (event: GestureEvent) => {
      const prev = gestureRef.current;
      const { state, out } = gestureStep(prev, event);
      gestureRef.current = state;
      if (state.phase !== "pressed") clearTimer();
      else if (prev.phase === "idle") timer = window.setTimeout(onTimer, LONG_PRESS_MS);
      emit(out);
    };

    const onTimer = () => {
      timer = null;
      // setTimeout 与 performance.now() 的时钟粒度不同，回调可能比后者早到不足 1ms；
      // 回调既已执行，就以"已满 600ms"为准，否则 gestureStep 会把这次到期当成过早而丢掉。
      dispatch({ kind: "timer", t: Math.max(performance.now(), gestureRef.current.downAt + LONG_PRESS_MS) });
    };

    const cancelGesture = () => {
      const g = gestureRef.current;
      if (g.phase !== "idle") dispatch({ kind: "cancel", id: g.pointers[0].id });
    };
    cancelGestureRef.current = cancelGesture;

    const onPointerDown = (e: PointerEvent) => {
      const opts = latestRef.current;
      if (opts.enabled === false) return;
      // 只处理主键：右键不清选区，保留"右键 → 复制"（§5.1）
      if (e.button !== 0 && e.pointerType !== "touch" && e.pointerType !== "pen") return;
      if (e.target instanceof Element) {
        const hit = e.target.closest(GESTURE_EXCLUDE_SELECTOR);
        if (hit && main.contains(hit)) return;
      }
      // 滚动条上的按下：按相对边框盒的坐标判定（不用 offsetX，它相对的是事件目标）。
      // 否则点滚动条会被判成 MR 区的 Tap，拖滚动条会与自绘拖拽叠加。
      const rect = main.getBoundingClientRect();
      if (
        e.clientX - rect.left >= main.clientLeft + main.clientWidth ||
        e.clientY - rect.top >= main.clientTop + main.clientHeight
      ) {
        return;
      }

      // 已登记的指针又按下，说明它上一次的抬起丢了（如捕获失败）：先结束旧手势
      if (gestureRef.current.pointers.some((ptr) => ptr.id === e.pointerId)) cancelGesture();

      if (gestureRef.current.phase === "idle" || !press) {
        const sel = document.getSelection();
        const hadSelection = sel !== null && sel.rangeCount > 0 && !sel.isCollapsed;
        if (hadSelection) sel.removeAllRanges();
        press = {
          rect,
          pointerType: e.pointerType,
          family: opts.family,
          controlsVisible: opts.controlsVisible,
          hadSelection,
          abortedAnimation: opts.abort(),
          anchor: null,
        };
      }

      try {
        main.setPointerCapture(e.pointerId);
      } catch {
        // 指针已不活动（极少见）：不捕获，后续事件照常冒泡到这里
      }
      dispatch({ kind: "down", id: e.pointerId, p: toLocal(e, press.rect), t: performance.now() });
    };

    const onPointerMove = (e: PointerEvent) => {
      if (gestureRef.current.phase === "idle" || !press) return;
      dispatch({ kind: "move", id: e.pointerId, p: toLocal(e, press.rect), t: performance.now() });
    };

    const onPointerUp = (e: PointerEvent) => {
      if (gestureRef.current.phase === "idle") return;
      dispatch({ kind: "up", id: e.pointerId, t: performance.now() });
    };

    const onPointerCancel = (e: PointerEvent) => {
      if (gestureRef.current.phase === "idle") return;
      dispatch({ kind: "cancel", id: e.pointerId });
    };

    /** 按压或拖拽期间拦截原生选择与拖放；没有按压时不拦，`Ctrl+A` 与复制照常可用（需求 2.10）。 */
    const pressing = () => {
      const phase = gestureRef.current.phase;
      return phase === "pressed" || phase === "drag";
    };
    const blockNative = (e: Event) => {
      if (pressing()) e.preventDefault();
    };
    const onContextMenu = (e: Event) => {
      if (pressing() && press?.pointerType === "touch") e.preventDefault();
    };

    main.addEventListener("pointerdown", onPointerDown);
    main.addEventListener("pointermove", onPointerMove);
    main.addEventListener("pointerup", onPointerUp);
    main.addEventListener("pointercancel", onPointerCancel);
    main.addEventListener("selectstart", blockNative);
    main.addEventListener("dragstart", blockNative);
    main.addEventListener("contextmenu", onContextMenu);

    // iOS 长按不弹系统菜单（§5.3）；不支持该属性的浏览器忽略这一行
    const prevCallout = main.style.getPropertyValue("-webkit-touch-callout");
    main.style.setProperty("-webkit-touch-callout", "none");

    return () => {
      main.removeEventListener("pointerdown", onPointerDown);
      main.removeEventListener("pointermove", onPointerMove);
      main.removeEventListener("pointerup", onPointerUp);
      main.removeEventListener("pointercancel", onPointerCancel);
      main.removeEventListener("selectstart", blockNative);
      main.removeEventListener("dragstart", blockNative);
      main.removeEventListener("contextmenu", onContextMenu);
      if (prevCallout) main.style.setProperty("-webkit-touch-callout", prevCallout);
      else main.style.removeProperty("-webkit-touch-callout");
      clearTimer();
      gestureRef.current = GESTURE_IDLE;
      cancelGestureRef.current = () => {};
    };
  }, [mainRef]);

  // 禁用时结束进行中的手势，免得它在重新启用后带着旧状态继续
  useEffect(() => {
    if (!enabled) cancelGestureRef.current();
  }, [enabled]);

  const isLongPressing = useCallback(() => gestureRef.current.phase === "long-press", []);
  return useMemo(() => ({ isLongPressing }), [isLongPressing]);
}

// ---------------------------------------------------------------------------
// 长按选区（design §5.3）
// ---------------------------------------------------------------------------

/** 视口坐标处的插入点。`caretPositionFromPoint` 优先，回退 `caretRangeFromPoint`；都不支持时为 null。 */
function caretAt(x: number, y: number): Caret | null {
  if (typeof document.caretPositionFromPoint === "function") {
    const pos = document.caretPositionFromPoint(x, y);
    return pos ? { node: pos.offsetNode, offset: pos.offset } : null;
  }
  if (typeof document.caretRangeFromPoint === "function") {
    const range = document.caretRangeFromPoint(x, y);
    return range ? { node: range.startContainer, offset: range.startOffset } : null;
  }
  return null;
}

/** 下标 `index` 处的那个字；落在代理对的任一半上时取整个代理对。 */
function charSpanAt(node: Text, index: number): CharSpan {
  const code = node.data.charCodeAt(index);
  if (code >= 0xdc00 && code <= 0xdfff && index > 0) return { node, start: index - 1, end: index + 1 };
  if (code >= 0xd800 && code <= 0xdbff && index + 1 < node.length) return { node, start: index, end: index + 2 };
  return { node, start: index, end: index + 1 };
}

/**
 * 长按开始选择：选中视口坐标 `(x, y)` 处的那一个字，返回它作为后续扩展的固定端。
 *
 * 插入点落在字的右半边时位于该字之后，所以插入点前后两个字都按字框试一次，取包含按下点的那个；
 * 都不包含（按在行尾空白处等）时取插入点之后的字。取不到 `<main>` 内的文本节点时什么也不做。
 */
function selectCharAt(main: HTMLElement, x: number, y: number): CharSpan | null {
  const caret = caretAt(x, y);
  if (!caret || !(caret.node instanceof Text) || !main.contains(caret.node)) return null;
  const node = caret.node;
  if (node.length === 0) return null;
  const sel = document.getSelection();
  if (!sel) return null;

  let span = charSpanAt(node, Math.min(caret.offset, node.length - 1));
  const range = document.createRange();
  for (const index of [caret.offset, caret.offset - 1]) {
    if (index < 0 || index >= node.length) continue;
    const candidate = charSpanAt(node, index);
    range.setStart(node, candidate.start);
    range.setEnd(node, candidate.end);
    const box = range.getBoundingClientRect();
    if (x >= box.left && x < box.right && y >= box.top && y < box.bottom) {
      span = candidate;
      break;
    }
  }
  sel.setBaseAndExtent(node, span.start, node, span.end);
  return span;
}

/**
 * 把选区的焦点端扩展到视口坐标 `(x, y)` 处，固定端是长按选中的那个字。
 *
 * 焦点在该字之前时以字尾为固定端、之后时以字首为固定端，于是长按选中的字始终在选区内；
 * 焦点落在字内时只选这个字。指针下没有 `<main>` 内的插入点时保持现有选区。
 */
function extendSelection(main: HTMLElement, anchor: CharSpan, x: number, y: number): void {
  if (!anchor.node.isConnected) return;
  const caret = caretAt(x, y);
  if (!caret || !main.contains(caret.node)) return;
  const sel = document.getSelection();
  if (!sel) return;

  const range = document.createRange();
  range.setStart(anchor.node, anchor.start);
  range.setEnd(anchor.node, anchor.end);
  let order: number;
  try {
    order = range.comparePoint(caret.node, caret.offset);
  } catch {
    return;
  }
  if (order < 0) sel.setBaseAndExtent(anchor.node, anchor.end, caret.node, caret.offset);
  else if (order > 0) sel.setBaseAndExtent(anchor.node, anchor.start, caret.node, caret.offset);
  else sel.setBaseAndExtent(anchor.node, anchor.start, anchor.node, anchor.end);
}
