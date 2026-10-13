/**
 * 分页视图（design §4、§6，需求 2、3、4、6、7、9、12）。
 *
 * 一个不滚动的 `<main>`（`overflow: hidden`、`touch-action: none`），里面铺着一张或几张页面图层
 * （`PageSurface`）：静止时只有当前页；一次翻页进行中按本次实际动画挂上图层栈。分页、翻页、手势
 * 各由一个 hook 承担，本组件只做接线与图层渲染：
 *
 * | hook | 职责 |
 * | --- | --- |
 * | `usePaginator` | 离屏测量、页表缓存、相邻章调度（design §4.2、§4.5） |
 * | `usePageTurner` | 拖拽 / Tap / 按键的翻页状态机与 rAF（design §6.1–§6.3） |
 * | `useReaderGesture` | Pointer Events → Tap / Long_Press / Drag，Tap 决策（design §5） |
 *
 * hook 的调用顺序按 `usePaginator` 模块注释的约定：先 `usePageTurner`（分页器的 `paused` 要用到
 * 它的 `turning`），再 `usePaginator`；翻页器要的 `pageCount` / `ensurePaginated` / `viewport`
 * 经 `paginatorRef` 转到分页器上。
 *
 * ### 阅读位置（design §3.3）
 *
 * 位置状态是 `PagedPosState`（章 + 偏移 + 显示页），只经 `pagedPositionStep` 变化：
 *
 * - **导航指令**（`nav.seq` 变化）→ `nav`：位置换成指令里的 (章, 偏移)，偏移可以落在页中间
 *   （检索命中、切模式），不吸附到页首（需求 12.1–12.4）。
 * - **页表变化**（首次测量、重分页、导航后的目标章页表就绪）→ `relayout`：只重算显示页。
 * - **翻页提交**与 **`edge()`** → `turned`：位置改为新页的页首偏移，并经 `onPosition` 上报
 *   （需求 2.7）。其余两种事件都不上报，程序化定位因此不改变阅读位置（需求 1.7）。
 *
 * 前两种是"渲染输入变了"，按 React 的"渲染期间据上一次的值调整 state"写法在渲染里归约
 * （`applyNav` / `applyTable`），React 立即以新 state 重渲，不会先提交一帧旧页。
 *
 * ### 图层与逐帧样式（design §6.4、§6.5、§6.7，G4）
 *
 * 页面图层按页（章号 + 页下标）作 key：翻页开始时当前页沿用原 DOM，只多挂一张目标页；提交时
 * 目标页那张原样变成当前页，旧当前页卸下。屏幕上不会出现空帧，阴影与叠加层随图层栈一起移除
 * （需求 6.4、13.3）。
 *
 * 逐帧的 `transform` / `visibility` / `clip-path` 由 `applyFrame` 经 ref 直接写进 DOM，不经过
 * React：React 渲染的 `style` 里从不出现这几项（目标页与仿真叠加层初始的 `visibility: hidden`
 * 除外，它们在整次翻页里保持不变），所以翻页途中的重渲染不会把它们冲掉。翻页结束后由一个
 * layout effect 清掉当前页上残留的这几项。
 *
 * | 本次动画 | 图层栈 |
 * | --- | --- |
 * | 覆盖 | 静止层 + 移动层（`coverLayout`）+ 宽 30px 的阴影（需求 6.1–6.3） |
 * | 滑动 | 两层同步平移（`slideLayout`），无阴影（需求 7.1、7.2） |
 * | 仿真 | design §6.7 的 5 组图层（`SIM_Z`）：两张页面图层不平移，只写 `clip-path`；背面阴影、前景阴影、背面镜像副本由 `SimulationLayers` 挂出，每帧由 `simLayerFrame` 算出、`writeSimFrame` 一次写入（需求 8.4–8.6、13.2） |
 * | 无动画 | 不挂图层栈，只有当前页；提交时同一帧换页（需求 9.1、9.2） |
 *
 * 减弱动态效果与仿真降级由翻页器在每次翻页开始时按 `effectiveTurnAnim` 决定（`turning.anim`），
 * 这里只按它渲染（需求 9.3、9.7）。
 *
 * ### 测试钩子（design §4.5、§6.4）
 *
 * - `<main data-page-mode="cover|slide|simulation|none">`：读者所选的模式（不是本次实际动画）。
 * - `<main data-turning="true|false">`、`<main data-paginated="12,13,14">`。
 * - 当前页图层带 `data-current="true"`、`data-chapter-id`、`data-page-index`、`data-page-count`、
 *   `data-page-start`。非当前页图层没有这些属性（翻页途中定位器不会命中两张页），且设
 *   `aria-hidden` 与 `inert`。页码只存在于这些运行时属性与 `onPageInfo` 里（需求 2.8）。
 *
 * ### 滚轮（design §8.3）
 *
 * `<main>` 上以 `{ passive: false }` 监听 `wheel`（`usePagedWheel`）：Ctrl+滚轮与落在 `<main>` 内
 * 可交互元素上的事件交给浏览器（`wheelRoute`），其余 `preventDefault` 后经 `wheelGateStep` 做
 * 200ms 尾沿防抖，到期走按键翻页路径 `keyTurn(…, "wheel")`（需求 11.8、11.9）。
 *
 * 与本目录其他组件一样不做 DOM 单元测试（项目不搭 jsdom）；静态标记与本模块的纯函数见
 * `PagedReader.test.tsx`，运行时行为由 e2e 覆盖。
 */

import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import { usePageTurner, type TurnViewport } from "../../hooks/usePageTurner";
import {
  PAGE_CONTENT_CLASS,
  PAGE_CONTENT_STYLE,
  usePaginator,
  type Paginator,
  type PaginatorViewport,
} from "../../hooks/usePaginator";
import { GESTURE_EXCLUDE_SELECTOR, useReaderGesture } from "../../hooks/useReaderGesture";
import { PAGE_ANIM, renderFamilyOf, type PageAnim } from "../../utils/pageAnim";
import type { TapDecision } from "../../utils/pageGesture";
import {
  pageIndexOf,
  pageView,
  pagedPositionStep,
  type PagePos,
  type PagedPosState,
  type PageTable,
  type PageView,
} from "../../utils/paginate";
import { simFrame, simGeometry, type SimFrame, type SimShadowStrip } from "../../utils/simulationGeometry";
import { COVER_SHADOW_PX, coverLayout, slideLayout, type Pt, type TurnState } from "../../utils/turnMotion";
import { wheelGateStep, type WheelEvent as WheelGateEvent, type WheelPending } from "../../utils/turnInput";
import { ChapterContent, type ChapterContentChapter, type ChapterTypography } from "./ChapterContent";
import type {
  HighlightTarget,
  NavRequest,
  PagedReaderProps,
  ReaderViewHandle,
  TurnDirection,
} from "./types";

// ───────────────────────────── 模式 ─────────────────────────────

/** `<main data-page-mode>` 的取值（按读者所选的模式）。 */
export const PAGE_MODE_NAMES: Readonly<Record<PageAnim, string>> = {
  [PAGE_ANIM.cover]: "cover",
  [PAGE_ANIM.slide]: "slide",
  [PAGE_ANIM.simulation]: "simulation",
  [PAGE_ANIM.scroll]: "scroll",
  [PAGE_ANIM.none]: "none",
};

/**
 * 本视图使用的模式。按契约只会收到分页族（0、1、2、4）；万一收到滚动（3），按无动画处理：
 * 翻页器的释放终点与图层布局都不认识滚动，无动画是唯一不依赖它们的分支。
 */
export function pagedAnimOf(anim: PageAnim): PageAnim {
  return renderFamilyOf(anim) === "paged" ? anim : PAGE_ANIM.none;
}

// ───────────────────────────── 图层栈 ─────────────────────────────

/** 一张页面图层在栈里的位置：叠放次序与是否移动（移动层设 `will-change: transform`）。 */
export interface LayerRole {
  z: number;
  moving: boolean;
}

/** 本视图的两个页面槽位：当前页（翻页前的页，`turning.from`）与目标页（`turning.to`）。 */
export type StackSlot = "cur" | "target";

/** 一次翻页的图层栈：当前页、目标页，是否有覆盖阴影，以及仿真里卷起的是哪个槽位。 */
export interface TurnStack {
  cur: LayerRole;
  target: LayerRole;
  shadow: boolean;
  /** 仿真：卷起的那一页所在的槽位（`simCurlSlot`），另需挂 `SimulationLayers`。其余模式为 null。 */
  curl: StackSlot | null;
}

/** 阴影叠在两张页面之上。 */
const SHADOW_Z = 2;

/**
 * 仿真图层栈的叠放次序（design §6.7 的表，自下而上）。① ③ 是两张页面图层（`TurnStack` 的两个
 * 槽位），② ④ ⑤ 是 `SimulationLayers` 的三组叠加层。
 */
export const SIM_Z = {
  /** ① 露出的页：NEXT 为下一页，PREV 为当前页。不裁剪。 */
  under: 0,
  /** ② 背面阴影：外层 curl、内层 reveal，取交集。 */
  backShadow: 1,
  /** ③ 卷起页的未卷部分：NEXT 为当前页，PREV 为上一页。裁剪为 curl 的补集。 */
  curling: 2,
  /** ④ 前景阴影 ×2：外层 curl 的补集，内层 front1 / front2。 */
  frontShadow: 3,
  /** ⑤ 背面：卷起页的镜像副本 + 折痕渐变，外层 curl、内层 back。 */
  back: 4,
} as const;

/**
 * 仿真里卷起的是哪个槽位（需求 8.1、8.3）：NEXT 卷起当前页、露出下一页；PREV 把上一页（目标页）
 * 从卷起状态展开、盖到当前页上，露出的是当前页。
 */
export function simCurlSlot(direction: TurnDirection): StackSlot {
  return direction === "next" ? "cur" : "target";
}

/**
 * 本次动画需要的图层栈（design §6.4、§6.5、§6.7）。无动画（以及不该出现的滚动）返回 `null`：
 * 不挂图层栈，只显示当前页。
 *
 * - 覆盖：移动层在上、静止层在下。NEXT 时当前页移走、露出下方的下一页；PREV 时上一页从左侧
 *   盖到静止的当前页上（需求 6.1、6.2）。哪一层移动取自 `coverLayout`（偏移 0 时恒有布局）。
 * - 滑动：两层都移动，互不重叠，叠放次序无关紧要（需求 7.1）；无阴影（需求 7.2）。
 * - 仿真：两张页面都不平移。卷起页在 ③、露出页在 ①（`SIM_Z`），其余三组叠加层另由
 *   `SimulationLayers` 挂出（`curl` 非 null）。
 */
export function turnStack(anim: PageAnim, direction: TurnDirection): TurnStack | null {
  switch (anim) {
    case PAGE_ANIM.slide:
      return { cur: { z: 1, moving: true }, target: { z: 0, moving: true }, shadow: false, curl: null };
    case PAGE_ANIM.cover: {
      const curMoving = (coverLayout(direction, 0, 1)?.moving ?? "cur") === "cur";
      return {
        cur: { z: curMoving ? 1 : 0, moving: curMoving },
        target: { z: curMoving ? 0 : 1, moving: !curMoving },
        shadow: true,
        curl: null,
      };
    }
    case PAGE_ANIM.simulation: {
      const curl = simCurlSlot(direction);
      const curling: LayerRole = { z: SIM_Z.curling, moving: false };
      const under: LayerRole = { z: SIM_Z.under, moving: false };
      return {
        cur: curl === "cur" ? curling : under,
        target: curl === "target" ? curling : under,
        shadow: false,
        curl,
      };
    }
    default:
      return null;
  }
}

/** 一帧里各层的 `translateX`（CSS px）。`null` 表示该层本帧隐藏。 */
export interface StackFrame {
  cur: number;
  target: number | null;
  shadow: number | null;
}

/** 方向与偏移矛盾时的画面：静止显示当前页（`coverLayout` / `slideLayout` 返回 null）。 */
const STILL_FRAME: StackFrame = { cur: 0, target: null, shadow: null };

/** 仿真的页面图层不平移，两页都在原位。 */
const SIM_STILL_FRAME: StackFrame = { cur: 0, target: 0, shadow: null };

/**
 * 一帧的图层位置（design §6.5）：`offset = touch.x − start.x`，`w` 为视口宽度。
 *
 * 把 `coverLayout` / `slideLayout` 按层名（prev / cur / next）给出的位置换成本视图的两个槽位：
 * 当前页（cur）与目标页（NEXT 时为 next，PREV 时为 prev）。覆盖模式的阴影左缘即 `shadowX`
 * （需求 6.3）；滑动模式没有阴影（需求 7.2）。
 *
 * 仿真不平移页面图层（逐帧样式见 `simLayerFrame`），返回两页都在原位、没有覆盖阴影。
 */
export function stackFrame(anim: PageAnim, direction: TurnDirection, offset: number, w: number): StackFrame {
  if (anim === PAGE_ANIM.simulation) return SIM_STILL_FRAME;
  if (anim === PAGE_ANIM.slide) {
    const layout = slideLayout(direction, offset, w);
    if (!layout) return STILL_FRAME;
    let cur = 0;
    let target = 0;
    for (const { layer, x } of layout.layers) {
      if (layer === "cur") cur = x;
      else target = x;
    }
    return { cur, target, shadow: null };
  }
  const layout = coverLayout(direction, offset, w);
  if (!layout) return STILL_FRAME;
  const curMoving = layout.moving === "cur";
  return {
    cur: curMoving ? layout.movingX : 0,
    target: curMoving ? 0 : layout.movingX,
    shadow: layout.shadowX,
  };
}

/** 把一层放到 `x`，或隐藏它（`x === null`）。只写 `style`，不读布局（G4）。 */
function place(el: HTMLElement | null, x: number | null): void {
  if (!el) return;
  if (x === null) {
    el.style.visibility = "hidden";
    return;
  }
  el.style.transform = `translate3d(${x}px, 0, 0)`;
  el.style.visibility = "visible";
}

// ───────────────────────────── 仿真帧 ─────────────────────────────

/**
 * 一帧仿真图层的样式（design §6.6、§6.7）：`simGeometry` 修正触点、算出贝塞尔几何，`simFrame`
 * 打包成裁剪路径、镜像矩阵与渐变条定位。
 *
 * 返回 null 表示按平整页绘制（design §11）：缺卷起角、触点距卷起角不足 1px（NEXT 取消回到
 * 原页角、PREV 完成展开到右下角的末帧都是这样），或几何非有限。此时 ③ 不裁剪、②④⑤ 隐藏。
 */
export function simLayerFrame(turn: Pick<TurnState, "touch" | "corner">, w: number, h: number): SimFrame | null {
  if (!turn.corner) return null;
  const g = simGeometry(turn.touch, turn.corner, w, h);
  return g ? simFrame(g, w, h) : null;
}

/**
 * 渐变条的 CSS `matrix(a, b, c, d, e, f)`：绕 `(left + originX, top + originY)` 旋转 `rotate` 度，
 * 再平移到 `(left, top)`。即 `SimShadowStrip` 说明的"`left/top` + `transform-origin` + `rotate`"，
 * 合成为一个矩阵，元素自身放在包裹层原点、`transform-origin: 0 0`。
 *
 * 在 JS 里以双精度合成，而不是交给浏览器：竖直折线（中间带与 PREV，触点纵坐标钉在卷起角所在的边）
 * 时 `control2.y ≈ −10·hx²`，第二条前景阴影的旋转中心远在数十万到千万像素之外，浏览器以单精度
 * 处理这样的旋转中心会让阴影抖动。合成后的平移 `(e, f)` 落在视口附近。
 */
export function stripMatrix(strip: SimShadowStrip): [number, number, number, number, number, number] {
  const rad = (strip.rotate * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const { originX: ox, originY: oy } = strip;
  const px = strip.left + ox;
  const py = strip.top + oy;
  return [cos, sin, -sin, cos, px - (cos * ox - sin * oy), py - (sin * ox + cos * oy)];
}

/** 一条渐变条每帧要写的样式（design §6.7 的 ②④⑤ 内部）。 */
export interface StripStyle {
  width: string;
  height: string;
  transform: string;
  backgroundImage: string;
}

/**
 * 渐变条的样式：尺寸、合成后的变换（`stripMatrix`），以及"`color` → 透明"的线性渐变，朝向取
 * `strip.direction`（`simFrame` 已按 `isRtOrLb` 与折痕的反向选好）。
 */
export function stripStyle(strip: SimShadowStrip, color: string): StripStyle {
  return {
    width: `${strip.width}px`,
    height: `${strip.height}px`,
    transform: `matrix(${stripMatrix(strip).join(", ")})`,
    backgroundImage: `linear-gradient(${strip.direction}, ${color}, transparent)`,
  };
}

/** 背面阴影与两条前景阴影的起始色（design §2.4）。 */
const TURN_SHADOW_COLOR = "var(--turn-shadow)";
/** 背面折痕的起始色（design §2.4）。 */
const TURN_FOLD_SHADOW_COLOR = "var(--turn-fold-shadow)";

/** `SimulationLayers` 里逐帧要写样式的元素。 */
const SIM_ELEMENT_KEYS = [
  "backShadow",
  "backShadowClip",
  "backShadowStrip",
  "front",
  "front1Clip",
  "front1Strip",
  "front2Clip",
  "front2Strip",
  "back",
  "backClip",
  "mirror",
  "foldStrip",
] as const;

type SimElementKey = (typeof SIM_ELEMENT_KEYS)[number];

/**
 * 仿真叠加层的元素登记表：`SimulationLayers` 经回调 ref 填入，`writeSimFrame` 读取。
 *
 * - ② `backShadow`（外层，curl）› `backShadowClip`（内层，reveal）› `backShadowStrip`
 * - ④ `front`（外层，curl 的补集）› `front1Clip` / `front2Clip`（内层，front1 / front2）›
 *   `front1Strip` / `front2Strip`
 * - ⑤ `back`（外层，curl）› `backClip`（内层，back）› `mirror`（镜像副本）+ `foldStrip`（折痕）
 */
export type SimElements = Record<SimElementKey, HTMLDivElement | null>;

export function emptySimElements(): SimElements {
  const els = {} as SimElements;
  for (const key of SIM_ELEMENT_KEYS) els[key] = null;
  return els;
}

function setClip(el: HTMLElement | null, clip: string): void {
  if (el) el.style.clipPath = clip;
}

function setStrip(el: HTMLElement | null, strip: SimShadowStrip, color: string): void {
  if (!el) return;
  const s = stripStyle(strip, color);
  el.style.width = s.width;
  el.style.height = s.height;
  el.style.transform = s.transform;
  el.style.backgroundImage = s.backgroundImage;
}

/**
 * 写一帧仿真图层（design §6.7，G4）：只写 `style`，不读布局。
 *
 * - ① 露出页：不裁剪（清掉换向前作为卷起页时留下的裁剪），可见。
 * - ③ 卷起页：裁剪为 curl 的补集；`frame` 为 null 时不裁剪，整页平整地盖住 ①。
 * - ②④⑤：`frame` 为 null 时连同内部一起隐藏，否则写入各层裁剪、镜像矩阵与渐变条。
 */
function writeSimFrame(
  frame: SimFrame | null,
  under: HTMLElement | null,
  curling: HTMLElement | null,
  els: SimElements,
): void {
  if (under) {
    under.style.removeProperty("clip-path");
    under.style.visibility = "visible";
  }
  if (curling) {
    if (frame) curling.style.clipPath = frame.clip.curlOutside;
    else curling.style.removeProperty("clip-path");
    curling.style.visibility = "visible";
  }
  const shown = frame ? "visible" : "hidden";
  for (const el of [els.backShadow, els.front, els.back]) {
    if (el) el.style.visibility = shown;
  }
  if (!frame) return;

  // ② 背面阴影：curl ∩ reveal，宽 touchToCorner / 4（需求 8.6）
  setClip(els.backShadow, frame.clip.curl);
  setClip(els.backShadowClip, frame.clip.reveal);
  setStrip(els.backShadowStrip, frame.backShadow, TURN_SHADOW_COLOR);

  // ④ 前景阴影：curl 的补集 ∩ front1 / front2，宽 25px（需求 8.6）
  setClip(els.front, frame.clip.curlOutside);
  setClip(els.front1Clip, frame.clip.front1);
  setStrip(els.front1Strip, frame.frontShadow1, TURN_SHADOW_COLOR);
  setClip(els.front2Clip, frame.clip.front2);
  setStrip(els.front2Strip, frame.frontShadow2, TURN_SHADOW_COLOR);

  // ⑤ 背面：curl ∩ back，卷起页沿折线的镜像 + 折痕渐变（需求 8.5）
  setClip(els.back, frame.clip.curl);
  setClip(els.backClip, frame.clip.back);
  if (els.mirror) els.mirror.style.transform = frame.mirror;
  setStrip(els.foldStrip, frame.foldShadow, TURN_FOLD_SHADOW_COLOR);
}

// ───────────────────────────── 位置状态 ─────────────────────────────

/** 视图状态：已消费的导航指令、已归约过的当前章页表，以及位置（design §3.3）。 */
export interface PagedViewState {
  navSeq: number;
  /** 最近一次喂给 `relayout` 的页表；导航后置空，好让同一张页表也再归约一次。 */
  table: PageTable | null;
  pos: PagedPosState;
}

const ORIGIN: PagedPosState = { chapterId: 0, charOffset: 0, page: 0 };

/**
 * 消费导航指令：`seq` 未变时原样返回。
 *
 * 页表置空：即便目标章就是当前章、页表也没变（同章的检索命中、书签），随后的 `applyTable`
 * 也会按新偏移重算显示页。
 */
export function applyNav(state: PagedViewState | null, nav: NavRequest): PagedViewState {
  if (state && state.navSeq === nav.seq) return state;
  const { state: pos } = pagedPositionStep(state?.pos ?? ORIGIN, {
    kind: "nav",
    chapterId: nav.chapterId,
    charOffset: nav.charOffset,
  });
  return { navSeq: nav.seq, table: null, pos };
}

/** 当前章的页表变了（含置空后再次就绪）：经 `relayout` 重算显示页，偏移不动。页表未变时原样返回。 */
export function applyTable(state: PagedViewState, table: PageTable | null): PagedViewState {
  if (table === state.table) return state;
  if (!table) return { ...state, table };
  const { state: pos } = pagedPositionStep(state.pos, { kind: "relayout", table });
  return { ...state, table, pos };
}

// ───────────────────────────── 页面图层 ─────────────────────────────

/**
 * `<main>`：定位元素（`MeasureBox` 与页面图层的包含块），不滚动（测量那一整章不会撑出滚动条）。
 * `flex-1 min-h-0` 让它恰好占满 `ReaderPage` 根容器剩下的那一屏。
 */
const MAIN_CLASS = "relative flex-1 min-h-0 overflow-hidden";

/**
 * 分页模式由本视图接管全部触摸手势（design G7，待评审）：多指取平均（需求 4.6）要求浏览器不接管
 * 双指缩放。文字放大走设置里的字号。
 */
const MAIN_STYLE: CSSProperties = { touchAction: "none" };

/** 页面图层：铺满 `<main>`、裁掉页外内容、不透明底色（需求 2.1、13.2）。 */
const SURFACE_CLASS = "absolute inset-0 overflow-hidden bg-[var(--bg)]";

/** 静止的当前页。`contain: strict`：尺寸由包含块决定，一页的布局与绘制不波及其他图层。 */
const STATIC_STYLE: CSSProperties = { contain: "strict" };

const layerStyles = new Map<string, CSSProperties>();

/**
 * 翻页图层栈里一张页面的 `style`。按参数缓存，同一角色在整次翻页里引用不变，翻页途中的重渲染
 * 不会改动 DOM 上的样式（逐帧写入的 `transform` / `visibility` 因此不被冲掉）。
 *
 * `hidden` 只给目标页：首帧由翻页器在绘制前写入，在那之前它不该露出来。
 */
function layerStyle(role: LayerRole, hidden: boolean): CSSProperties {
  const key = `${role.z}|${role.moving}|${hidden}`;
  let style = layerStyles.get(key);
  if (!style) {
    style = { contain: "strict", zIndex: role.z };
    if (role.moving) style.willChange = "transform";
    if (hidden) style.visibility = "hidden";
    layerStyles.set(key, style);
  }
  return style;
}

/** 覆盖模式的阴影：宽 30px，从翻页阴影色渐变到透明，左缘贴着移动页右缘外侧（需求 6.3）。 */
const SHADOW_STYLE: CSSProperties = {
  position: "absolute",
  top: 0,
  bottom: 0,
  left: 0,
  width: COVER_SHADOW_PX,
  background: "linear-gradient(to right, var(--turn-shadow), transparent)",
  zIndex: SHADOW_Z,
  pointerEvents: "none",
  willChange: "transform",
  visibility: "hidden",
};

export interface PageSurfaceProps {
  chapter: ChapterContentChapter;
  /** `pageView(chapter.paras, starts, pageIndex)`，引用宜稳定（`ChapterContent` 是 memo 组件）。 */
  view: PageView;
  typography: ChapterTypography;
  highlight: HighlightTarget | null;
  /** 是否为当前页：带测试钩子属性；否则 `aria-hidden` + `inert`。 */
  current: boolean;
  pageIndex: number;
  pageCount: number;
  pageStart: number;
  style: CSSProperties;
  /** 交给视图写逐帧样式用。 */
  surfaceRef?: (el: HTMLDivElement | null) => void;
}

/**
 * 一张页面图层（design §4.1）：铺满 `<main>` 的绝对定位层，内容盒与 `MeasureBox` 同用
 * `PAGE_CONTENT_CLASS`（水平内边距）并加上下各 32px 内边距；`<article>` 由 `ChapterContent`
 * 以 `mx-auto` + `maxWidth = contentWidth` 水平居中（需求 2.1）。标题区只在本章第 1 页
 * （`view.header`，需求 2.2）。正文是普通 DOM 文本，可选择、可复制（需求 2.10）。
 */
export const PageSurface = memo(function PageSurface(props: PageSurfaceProps) {
  const { chapter, view, typography, highlight, current, pageIndex, pageCount, pageStart, style, surfaceRef } =
    props;

  const elRef = useRef<HTMLDivElement | null>(null);
  const setEl = useCallback(
    (el: HTMLDivElement | null) => {
      elRef.current = el;
      surfaceRef?.(el);
    },
    [surfaceRef],
  );

  // React 18 不认识 `inert` 属性，经 DOM 设置。非当前页不可聚焦、不可交互（翻页途中的目标页）
  useLayoutEffect(() => {
    const el = elRef.current;
    if (!el) return;
    if (current) el.removeAttribute("inert");
    else el.setAttribute("inert", "");
  }, [current]);

  return (
    <div
      ref={setEl}
      className={SURFACE_CLASS}
      style={style}
      aria-hidden={current ? undefined : true}
      data-current={current ? "true" : undefined}
      data-chapter-id={current ? chapter.chapterId : undefined}
      data-page-index={current ? pageIndex : undefined}
      data-page-count={current ? pageCount : undefined}
      data-page-start={current ? pageStart : undefined}
    >
      <div className={PAGE_CONTENT_CLASS} style={PAGE_CONTENT_STYLE}>
        <ChapterContent variant="page" chapter={chapter} view={view} typography={typography} highlight={highlight} />
      </div>
    </div>
  );
});

// ───────────────────────────── 仿真叠加层 ─────────────────────────────

/** 仿真的包裹层：铺满 `<main>`，所以 `clip-path` 的坐标就是视口坐标（design §6.7）。 */
const SIM_WRAP_CLASS = "absolute inset-0 pointer-events-none";

const SIM_INNER_STYLE: CSSProperties = { contain: "strict" };

/** 外层：带叠放次序；几何退化前不露出，首帧由翻页器在绘制前写入。 */
function simOuterStyle(z: number): CSSProperties {
  return { contain: "strict", zIndex: z, visibility: "hidden" };
}

const SIM_BACK_SHADOW_STYLE = simOuterStyle(SIM_Z.backShadow);
const SIM_FRONT_SHADOW_STYLE = simOuterStyle(SIM_Z.frontShadow);
const SIM_BACK_STYLE = simOuterStyle(SIM_Z.back);

/** 渐变条：放在包裹层原点，尺寸、变换与渐变逐帧写入（`stripStyle`）。 */
const SIM_STRIP_STYLE: CSSProperties = { position: "absolute", left: 0, top: 0, transformOrigin: "0 0" };

/**
 * ⑤ 背面镜像副本：铺满视口、`transform-origin: 0 0`（镜像矩阵以视口原点为基准），不可选中。
 * `var(--bg)` 底色来自 `PageSurface` 的类名，下层文字不会透出（需求 13.2）。
 */
const SIM_MIRROR_STYLE: CSSProperties = {
  contain: "strict",
  transformOrigin: "0 0",
  userSelect: "none",
  WebkitUserSelect: "none",
};

export interface SimulationLayersProps {
  /** 逐帧写样式用的元素登记表，引用在视图生命周期内不变。 */
  els: SimElements;
  /** 以下是卷起那一页的渲染数据，⑤ 的镜像副本显示它（NEXT 为当前页，PREV 为上一页）。 */
  chapter: ChapterContentChapter;
  view: PageView;
  typography: ChapterTypography;
  highlight: HighlightTarget | null;
  pageIndex: number;
  pageCount: number;
  pageStart: number;
}

/**
 * 仿真的三组叠加层（design §6.7 的 ②④⑤）。两张页面图层（①③）仍是视图里的 `PageSurface`，
 * 这里只挂叠在它们之间与之上的部分；嵌套的两层裁剪取交集。
 *
 * 全部 `aria-hidden`；⑤ 的镜像副本另设 `inert`（`PageSurface` 的非当前页）与 `user-select: none`。
 * 本组件只渲染结构，逐帧样式由 `writeSimFrame` 写入（G4）。
 */
export const SimulationLayers = memo(function SimulationLayers(props: SimulationLayersProps) {
  const { els, chapter, view, typography, highlight, pageIndex, pageCount, pageStart } = props;

  const refs = useMemo(() => {
    const bound = {} as Record<SimElementKey, (el: HTMLDivElement | null) => void>;
    for (const key of SIM_ELEMENT_KEYS) {
      bound[key] = (el) => {
        els[key] = el;
      };
    }
    return bound;
  }, [els]);

  return (
    <>
      <div ref={refs.backShadow} aria-hidden="true" className={SIM_WRAP_CLASS} style={SIM_BACK_SHADOW_STYLE}>
        <div ref={refs.backShadowClip} className={SIM_WRAP_CLASS} style={SIM_INNER_STYLE}>
          <div ref={refs.backShadowStrip} style={SIM_STRIP_STYLE} />
        </div>
      </div>
      <div ref={refs.front} aria-hidden="true" className={SIM_WRAP_CLASS} style={SIM_FRONT_SHADOW_STYLE}>
        <div ref={refs.front1Clip} className={SIM_WRAP_CLASS} style={SIM_INNER_STYLE}>
          <div ref={refs.front1Strip} style={SIM_STRIP_STYLE} />
        </div>
        <div ref={refs.front2Clip} className={SIM_WRAP_CLASS} style={SIM_INNER_STYLE}>
          <div ref={refs.front2Strip} style={SIM_STRIP_STYLE} />
        </div>
      </div>
      <div ref={refs.back} aria-hidden="true" className={SIM_WRAP_CLASS} style={SIM_BACK_STYLE}>
        <div ref={refs.backClip} className={SIM_WRAP_CLASS} style={SIM_INNER_STYLE}>
          <PageSurface
            surfaceRef={refs.mirror}
            style={SIM_MIRROR_STYLE}
            chapter={chapter}
            view={view}
            typography={typography}
            highlight={highlight}
            current={false}
            pageIndex={pageIndex}
            pageCount={pageCount}
            pageStart={pageStart}
          />
          <div ref={refs.foldStrip} style={SIM_STRIP_STYLE} />
        </div>
      </div>
    </>
  );
});

function pageKey(chapterId: number, page: number): string {
  return `${chapterId}:${page}`;
}

// ───────────────────────────── 滚轮 ─────────────────────────────

/**
 * `<main>` 收到的一次滚轮事件归谁处理（design §8.3，需求 11.8、11.9）：
 *
 * - `ctrlKey`：Ctrl+滚轮是浏览器缩放（触控板双指捏合也以 `ctrlKey` 报告），交给浏览器。
 * - `excluded`：目标落在 `<main>` 内的可交互元素上（与手势层同一条 `GESTURE_EXCLUDE_SELECTOR`），
 *   交给元素自己。面板与控制栏是 `<main>` 之外的 `fixed` 兄弟节点，事件本就到不了这里。
 * - 其余由本视图接管（`"turn"`）：`preventDefault`，送进滚轮闸门。`deltaY` 为 0 的事件也接管
 *   （`<main>` 不滚动，没有默认行为可留），闸门会忽略它。
 */
export function wheelRoute(e: { ctrlKey: boolean; excluded: boolean }): "browser" | "turn" {
  return e.ctrlKey || e.excluded ? "browser" : "turn";
}

/**
 * 分页模式的滚轮翻页（design §8.3，需求 11.8、11.9）：`<main>` 上以 `{ passive: false }` 监听
 * `wheel`，接管的事件经 `wheelGateStep` 做 200ms 尾沿防抖，`fire` 时调用 `turn`。
 *
 * 闸门状态与定时器都在 effect 闭包里，不进 React state：每次滚轮事件只改闭包变量。待执行项
 * 换了对象（新登记或被 `tick` 清空）时按它的 `due` 重排定时器；`deltaY` 为 0 时闸门原样返回，
 * 定时器不动。`tick` 的时刻取 `max(now, due)`，理由同 `useBoundaryNotice`：计时器与
 * `performance.now()` 的亚毫秒取整可能让回调恰好早于 `due`，闸门判为未到期就再也不会执行。
 *
 * `turn` 取最新一次渲染的值，监听器只在挂载时绑定一次（`<main>` 在视图生命周期内不替换）。
 * 卸载时清掉定时器，未执行的那次翻页随之丢弃。
 */
function usePagedWheel(mainRef: RefObject<HTMLElement>, turn: (direction: TurnDirection) => void): void {
  const turnRef = useRef(turn);
  useLayoutEffect(() => {
    turnRef.current = turn;
  });

  useEffect(() => {
    const main = mainRef.current;
    if (!main) return;

    let pending: WheelPending | null = null;
    let timer: number | null = null;

    const clearTimer = () => {
      if (timer === null) return;
      window.clearTimeout(timer);
      timer = null;
    };

    const step = (event: WheelGateEvent) => {
      const out = wheelGateStep(pending, event);
      if (out.pending !== pending) {
        pending = out.pending;
        clearTimer();
        if (pending) {
          const { due } = pending;
          timer = window.setTimeout(
            () => {
              timer = null;
              step({ kind: "tick", t: Math.max(performance.now(), due) });
            },
            Math.max(0, due - performance.now()),
          );
        }
      }
      // 按键翻页路径：100ms 基准，有翻页进行中时忽略，不动控制栏（需求 11.4、11.7、11.16）
      if (out.fire) turnRef.current(out.fire);
    };

    const onWheel = (e: WheelEvent) => {
      let excluded = false;
      if (e.target instanceof Element) {
        const hit = e.target.closest(GESTURE_EXCLUDE_SELECTOR);
        excluded = hit !== null && main.contains(hit);
      }
      if (wheelRoute({ ctrlKey: e.ctrlKey, excluded }) === "browser") return;
      e.preventDefault();
      step({ kind: "wheel", deltaY: e.deltaY, t: performance.now() });
    };

    main.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      main.removeEventListener("wheel", onWheel);
      clearTimer();
    };
  }, [mainRef]);
}

const ZERO_VIEWPORT: PaginatorViewport = { w: 0, h: 0 };

// ───────────────────────────── 组件 ─────────────────────────────

export const PagedReader = forwardRef<ReaderViewHandle, PagedReaderProps>(function PagedReader(props, ref) {
  const { toc, fullText, views, settings, nav, highlight, controlsVisible, onBoundary } = props;
  const pageAnim = pagedAnimOf(settings.pageAnim);

  /** 视图自己的 `<main>`。首次提交时就存在，生命周期内不替换（分页器与手势层的前提）。 */
  const mainRef = useRef<HTMLElement>(null);

  // 引用稳定：分页器只按字段取值，`ChapterContent` 是 memo 组件
  const typography = useMemo<ChapterTypography>(
    () => ({
      contentWidth: settings.contentWidth,
      fontFamily: settings.fontFamily,
      fontSize: settings.fontSize,
      lineHeight: settings.lineHeight,
      letterSpacing: settings.letterSpacing,
    }),
    [settings.contentWidth, settings.fontFamily, settings.fontSize, settings.lineHeight, settings.letterSpacing],
  );

  /** 最新一次提交的 props，供事件回调读取（`onPosition`、`onControls`、`onPageInfo`）。 */
  const propsRef = useRef(props);
  useLayoutEffect(() => {
    propsRef.current = props;
  });

  // ── 位置状态（design §3.3）──

  const [viewState, setViewState] = useState<PagedViewState>(() => applyNav(null, nav));
  // 导航指令在渲染里归约，分页器本次渲染就拿到目标章（见模块注释）
  const navigated = applyNav(viewState, nav);

  /** 事件回调读的位置。提交翻页时立即更新，不等重渲染；每次提交后再与 state 对齐。 */
  const posRef = useRef<PagedPosState>(viewState.pos);
  useLayoutEffect(() => {
    posRef.current = viewState.pos;
  }, [viewState.pos]);

  const paginatorRef = useRef<Paginator | null>(null);

  // ── 图层元素（逐帧写样式用）──

  const curElRef = useRef<HTMLDivElement | null>(null);
  const targetElRef = useRef<HTMLDivElement | null>(null);
  const shadowElRef = useRef<HTMLDivElement | null>(null);
  const setCurEl = useCallback((el: HTMLDivElement | null) => {
    curElRef.current = el;
  }, []);
  const setTargetEl = useCallback((el: HTMLDivElement | null) => {
    targetElRef.current = el;
  }, []);
  const setShadowEl = useCallback((el: HTMLDivElement | null) => {
    shadowElRef.current = el;
  }, []);
  /** 仿真叠加层的元素（`SimulationLayers` 填入）。lazy 初始值保证整个生命周期是同一个对象。 */
  const [simEls] = useState(emptySimElements);

  /** 写一帧（G4）：只写 `style`，不 setState。 */
  const applyFrame = useCallback(
    (turn: Readonly<TurnState>, viewport: TurnViewport) => {
      if (turn.anim === PAGE_ANIM.simulation) {
        const curCurls = simCurlSlot(turn.direction) === "cur";
        const cur = curElRef.current;
        const target = targetElRef.current;
        writeSimFrame(
          simLayerFrame(turn, viewport.w, viewport.h),
          curCurls ? target : cur,
          curCurls ? cur : target,
          simEls,
        );
        return;
      }
      const frame = stackFrame(turn.anim, turn.direction, turn.touch.x - turn.start.x, viewport.w);
      place(curElRef.current, frame.cur);
      place(targetElRef.current, frame.target);
      place(shadowElRef.current, frame.shadow);
    },
    [simEls],
  );

  /**
   * 落到新页（翻页提交或 `edge()`）：`turned` 事件，位置改为新页页首并上报（需求 2.7、11.3）。
   * 跨章时 `?ch=`、目录高亮、滑杆与书签状态由 `ReaderPage` 随上报的换章更新（需求 3.9、3.10）。
   */
  const commitTurned = useCallback((to: PagePos, starts: readonly number[]) => {
    const { state: pos, report } = pagedPositionStep(posRef.current, { kind: "turned", to, starts });
    posRef.current = pos;
    setViewState((prev) => ({ ...prev, pos }));
    if (report) propsRef.current.onPosition(pos.chapterId, pos.charOffset);
  }, []);

  const onCommit = useCallback(
    (to: PagePos) => commitTurned(to, paginatorRef.current?.startsOf(to.chapterId) ?? []),
    [commitTurned],
  );

  // 分页器的三个入口（引用稳定，读最新值）。翻页器只在事件回调与 rAF 里调用它们
  const pageCount = useCallback((id: number) => paginatorRef.current?.pageCount(id), []);
  const ensurePaginated = useCallback((id: number) => paginatorRef.current?.ensurePaginated(id), []);
  const readViewport = useCallback(() => paginatorRef.current?.viewport() ?? ZERO_VIEWPORT, []);

  const turner = usePageTurner({
    pos: { chapterId: navigated.pos.chapterId, page: navigated.pos.page },
    views,
    pageAnim,
    pageCount,
    ensurePaginated,
    viewport: readViewport,
    applyFrame,
    onCommit,
    onBoundary,
  });
  const { turning, startDrag, moveDrag, endDrag, tapTurn, keyTurn, abort, settle, isAnimating } = turner;

  const paginator = usePaginator({
    mainRef,
    toc,
    fullText,
    views,
    typography,
    chapterId: navigated.pos.chapterId,
    paused: turning !== null,
    // 排版变化（含视口尺寸）前先落定进行中的翻页（需求 2.6）
    beforeRelayout: settle,
  });
  useLayoutEffect(() => {
    paginatorRef.current = paginator;
  });

  // 页表变化 → relayout；与导航一起在渲染里归约（React 立即以新 state 重渲，不提交这一遍）
  const next = applyTable(navigated, paginator.table);
  if (next !== viewState) setViewState(next);
  const { pos } = next;

  // ── 手势（design §5）──

  const onTap = useCallback(
    (decision: TapDecision, at: Pt) => {
      switch (decision.kind) {
        case "turn":
          // 300ms 基准（需求 5.6）；翻页不动控制栏（需求 5.11）
          tapTurn(decision.direction, at.y);
          return;
        case "show-controls":
          propsRef.current.onControls("show");
          return;
        case "hide-controls":
          propsRef.current.onControls("hide");
          return;
        case "none":
          return;
      }
    },
    [tapTurn],
  );

  const onDragStart = useCallback((focus: Pt, _pointerType: string, start: Pt) => startDrag(start, focus), [startDrag]);

  useReaderGesture({
    mainRef,
    family: "paged",
    controlsVisible,
    abort,
    onTap,
    onDragStart,
    onDragMove: moveDrag,
    onDragEnd: endDrag,
  });

  // ── 滚轮（design §8.3）──

  const wheelTurn = useCallback((direction: TurnDirection) => keyTurn(direction, "wheel"), [keyTurn]);
  usePagedWheel(mainRef, wheelTurn);

  // 翻页结束：清掉当前页上残留的逐帧样式（提交时它是原目标页，取消时是原当前页）
  useLayoutEffect(() => {
    if (turning) return;
    const el = curElRef.current;
    if (!el) return;
    el.style.removeProperty("transform");
    el.style.removeProperty("visibility");
    // 仿真：PREV 提交后的当前页、NEXT 取消后的当前页都当过卷起页
    el.style.removeProperty("clip-path");
  }, [turning]);

  // ── 句柄（design §1.2）──

  /** 本章首页 / 末页（需求 11.3）。不播动画；与翻页一样算读者移动，上报位置。 */
  const edge = useCallback(
    (which: "start" | "end") => {
      settle();
      const pag = paginatorRef.current;
      if (!pag) return;
      const { chapterId } = posRef.current;
      pag.ensurePaginated(chapterId);
      const starts = pag.startsOf(chapterId);
      if (!starts?.length) return;
      commitTurned({ chapterId, page: which === "start" ? 0 : starts.length - 1 }, starts);
    },
    [settle, commitTurned],
  );

  /** 加书签时记录的偏移：当前页的页首（需求 12.5）。页表还没有时退回阅读位置本身。 */
  const bookmarkOffset = useCallback(() => {
    const { chapterId, charOffset } = posRef.current;
    const starts = paginatorRef.current?.startsOf(chapterId);
    return starts?.length ? starts[pageIndexOf(starts, charOffset)] : charOffset;
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      turn: keyTurn,
      edge,
      line: () => {},
      bookmarkOffset,
      settle,
      isAnimating,
    }),
    [keyTurn, edge, bookmarkOffset, settle, isAnimating],
  );

  // ── 当前页与目标页 ──

  const curStarts = paginator.table?.starts;
  const curPage = curStarts ? Math.min(Math.max(0, pos.page), curStarts.length - 1) : 0;
  const curCount = curStarts?.length ?? 0;
  const curChapter = paginator.chapterOf(pos.chapterId);
  const curView = useMemo(
    () => (curChapter && curStarts ? pageView(curChapter.paras, curStarts, curPage) : null),
    [curChapter, curStarts, curPage],
  );

  const stack = turning ? turnStack(turning.anim, turning.direction) : null;
  const target = stack && turning ? turning.to : null;
  const targetChapter = target ? paginator.chapterOf(target.chapterId) : null;
  const targetStarts = target
    ? target.chapterId === pos.chapterId
      ? curStarts
      : paginator.tableOf(target.chapterId)?.starts
    : undefined;
  const targetPage = target?.page ?? 0;
  const targetView = useMemo(
    () => (targetChapter && targetStarts ? pageView(targetChapter.paras, targetStarts, targetPage) : null),
    [targetChapter, targetStarts, targetPage],
  );

  // 仿真：卷起那一页（⑤ 的镜像副本显示它）。换向时只换内容，叠加层留在同一位置不重挂
  const curlSlot = stack?.curl ?? null;
  const curl =
    curlSlot === "cur"
      ? { chapter: curChapter, view: curView, starts: curStarts, page: curPage }
      : curlSlot === "target"
        ? { chapter: targetChapter, view: targetView, starts: targetStarts, page: targetPage }
        : null;

  // 底栏页码（需求 2.9）。只依赖数值，宿主传内联回调也不会反复触发
  useEffect(() => {
    propsRef.current.onPageInfo(curCount > 0 ? { index: curPage, count: curCount } : null);
  }, [curPage, curCount]);
  useEffect(() => {
    const latest = propsRef;
    return () => latest.current.onPageInfo(null);
  }, []);

  return (
    <main
      ref={mainRef}
      data-page-mode={PAGE_MODE_NAMES[pageAnim]}
      data-turning={turning ? "true" : "false"}
      data-paginated={paginator.paginatedIds.join(",")}
      className={MAIN_CLASS}
      style={MAIN_STYLE}
    >
      {paginator.measureBox}
      {curChapter && curView && curStarts && (
        <PageSurface
          key={pageKey(pos.chapterId, curPage)}
          surfaceRef={setCurEl}
          style={stack ? layerStyle(stack.cur, false) : STATIC_STYLE}
          chapter={curChapter}
          view={curView}
          typography={typography}
          highlight={highlight}
          current
          pageIndex={curPage}
          pageCount={curCount}
          pageStart={curStarts[curPage]}
        />
      )}
      {stack && target && targetChapter && targetView && targetStarts && (
        <PageSurface
          key={pageKey(target.chapterId, target.page)}
          surfaceRef={setTargetEl}
          style={layerStyle(stack.target, true)}
          chapter={targetChapter}
          view={targetView}
          typography={typography}
          highlight={highlight}
          current={false}
          pageIndex={target.page}
          pageCount={targetStarts.length}
          pageStart={targetStarts[target.page] ?? 0}
        />
      )}
      {stack?.shadow && <div ref={setShadowEl} aria-hidden="true" style={SHADOW_STYLE} />}
      {curl?.chapter && curl.view && curl.starts && (
        <SimulationLayers
          els={simEls}
          chapter={curl.chapter}
          view={curl.view}
          typography={typography}
          highlight={highlight}
          pageIndex={curl.page}
          pageCount={curl.starts.length}
          pageStart={curl.starts[curl.page] ?? 0}
        />
      )}
    </main>
  );
});
