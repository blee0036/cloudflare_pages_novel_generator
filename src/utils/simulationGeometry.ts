/**
 * 仿真翻页几何（design §6.6，需求 8.1–8.5）。
 *
 * 纯函数模块，逐式移植 Legado `SimulationPageDelegate` 的 `calcCornerXY`、`onTouch` 中间带固定、
 * `calcPoints` / `getCross` 与背面镜像矩阵。坐标系与 `Pt` 相同：CSS px，原点在 `<main>` 左上角，
 * y 向下。所有图层铺满视口，因此这里算出的点可以直接写进 `clip-path` 与 `transform`。
 *
 * 与 Legado 的有意偏离：
 * - 按下点恰在 `y = h/2` 时，Legado 卷起角取上角、触点却固定到下边（`viewHeight / 2` 整数除法所致）。
 *   这里 `simCorner` 与 `pinTouchY` 用同一条分界（`startY ≤ h/2` 归上），固定边恒与卷起角一致（design §0）。
 * - `getCross` 改用行列式形式求交。Legado 的斜截式在直线竖直时得到 NaN（触点恰在卷起角 45° 对角线上时
 *   "触点—control1"就是竖直线），会让那一帧整页变平；行列式形式在可解时结果相同，只在平行时无解。
 * - `mirrorMatrix` 的折线方向取"卷起角—触点"连线的垂直方向，平移取连线中点。见该函数注释。
 *
 * `simGeometry` 内部以 `corner − touch` 为变量计算，与 Legado 的绝对坐标写法代数上相同，只为数值精度。
 */

import type { TurnDirection } from "../components/reader/types";
import type { Pt } from "./turnMotion";

/** 触点距卷起角不足这个距离（CSS px）时视为平整，`simGeometry` 返回 null。 */
export const SIM_FLAT_EPS_PX = 1;

/** `corner.y − middle.y` 为 0 时代替它的分母，取值同 Legado `calcPoints`。 */
export const SIM_ZERO_DENOMINATOR = 0.1;

/**
 * 卷起角（需求 8.1、8.3）。
 *
 * NEXT 恒在右侧：`startY ≤ h/2` 取右上角 `(w, 0)`，否则取右下角 `(w, h)`。
 * PREV 恒为右下角（Legado `setDirection` 以 `viewHeight` 调 `calcCornerXY`，"上一页滑动不出现对角"）。
 *
 * Legado 在 NEXT 且按下点位于左半屏时以 `viewWidth − startX` 选角，结果同样落在右侧，这里直接取 `w`。
 */
export function simCorner(direction: TurnDirection, startY: number, w: number, h: number): Pt {
  if (direction === "prev") return { x: w, y: h };
  return { x: w, y: startY <= h / 2 ? 0 : h };
}

/**
 * 中间带的固定触点纵坐标（需求 8.2、8.3），对应 Legado `onTouch` 的 `ACTION_MOVE` 分支。
 *
 * - PREV：恒为 `h`，上一页沿竖直折线展开。
 * - NEXT 且 `h/3 < startY ≤ h/2`：为 1，即卷起角（右上）所在的上边。取 1 而不是 0，沿用 Legado
 *   "防止 mTouchY 最终变为 0"。
 * - NEXT 且 `h/2 < startY < 2h/3`：为 `h`，即卷起角（右下）所在的下边。
 * - 其余返回 null，触点不固定。
 *
 * 上下分界与 `simCorner` 相同（`startY ≤ h/2` 归上），非 null 时固定边恒为卷起角所在的水平边。
 */
export function pinTouchY(direction: TurnDirection, startY: number, h: number): number | null {
  if (direction === "prev") return h;
  if (startY > h / 3 && startY <= h / 2) return 1;
  if (startY > h / 2 && startY < (2 * h) / 3) return h;
  return null;
}

/**
 * 一帧仿真翻页的几何量，字段与 Legado `SimulationPageDelegate` 的同名成员一一对应。
 *
 * 构造上 `start1.y`、`control1.y` 恰为卷起角的 y，`start2.x`、`control2.x` 恰为卷起角的 x（直接赋值，
 * 不经运算），`simFrame` 据此精确还原卷起角。
 */
export interface SimGeometry {
  /** 经过书脊端点修正后的触点（`mTouchX`、`mTouchY`）。 */
  touch: Pt;
  start1: Pt;
  control1: Pt;
  vertex1: Pt;
  end1: Pt;
  start2: Pt;
  control2: Pt;
  vertex2: Pt;
  end2: Pt;
  /** 修正后触点到卷起角的距离（`mTouchToCornerDis`），背面阴影宽为它的 1/4（需求 8.6）。 */
  touchToCorner: number;
  /** 背面阴影绕 `start1` 的旋转角，单位度（`mDegrees`）。 */
  degrees: number;
  /** 卷起角是右上或左下（`mIsRtOrLb`），决定各条渐变的朝向。 */
  isRtOrLb: boolean;
}

/** 控制点到卷起角的距离：`q = corner.x − control1.x`，`r = corner.y − control2.y`。 */
interface ControlOffsets {
  q: number;
  r: number;
}

/**
 * `calcPoints` 中重复两次的那段：中点 → 两个控制点。
 *
 * `control1 = (middle.x − (corner.y − middle.y)² / (corner.x − middle.x), corner.y)`，
 * `control2 = (corner.x, middle.y − (corner.x − middle.x)² / (corner.y − middle.y))`，
 * 后者的分母为 0 时取 `SIM_ZERO_DENOMINATOR`。两者都在"卷起角—触点"连线的中垂线上。
 *
 * 入参是 `(dx, dy) = corner − touch`，于是 `corner − middle = (dx, dy) / 2`。直接返回控制点相对卷起角的
 * 偏移，与先算控制点坐标再减回去代数上相同，但不会在控制点贴近卷起角时因相消丢精度。
 */
function controlOffsetsOf(dx: number, dy: number): ControlOffsets {
  const hx = dx / 2; // corner.x − middle.x
  const hy = dy / 2; // corner.y − middle.y
  return {
    q: hx + (hy * hy) / hx,
    r: hy + (hx * hx) / (hy === 0 ? SIM_ZERO_DENOMINATOR : hy),
  };
}

/**
 * Legado 回拉时写 `v = |c − f|`，随后又用 `c − v`。这里直接给出 `c − v`，避免两个相近的大数相减：
 * `c − f ≥ 0` 时 `c − v = f`，否则 `c − v = 2c − f`。
 */
function gapAfterAbs(c: number, f: number): number {
  return c - f >= 0 ? f : 2 * c - f;
}

/**
 * 直线 P1P2 与直线 P3P4 的交点（Legado `getCross`）。
 *
 * 用行列式形式而不是斜截式：两者在可解时是同一个点，斜截式却在任一直线竖直时得到 NaN。
 * 两直线平行时分母为 0，结果非有限，由 `simGeometry` 统一按退化处理。
 */
function getCross(p1: Pt, p2: Pt, p3: Pt, p4: Pt): Pt {
  const d12x = p1.x - p2.x;
  const d12y = p1.y - p2.y;
  const d34x = p3.x - p4.x;
  const d34y = p3.y - p4.y;
  const den = d12x * d34y - d12y * d34x;
  const c12 = p1.x * p2.y - p1.y * p2.x;
  const c34 = p3.x * p4.y - p3.y * p4.x;
  return {
    x: (c12 * d34x - d12x * c34) / den,
    y: (c12 * d34y - d12y * c34) / den,
  };
}

function isFinitePt(p: Pt): boolean {
  return Number.isFinite(p.x) && Number.isFinite(p.y);
}

/** 二次贝塞尔曲线 `start → control → end` 在 t = 0.5 处的点（需求 8.4）。 */
function vertexOf(start: Pt, control: Pt, end: Pt): Pt {
  return {
    x: (start.x + 2 * control.x + end.x) / 4,
    y: (start.y + 2 * control.y + end.y) / 4,
  };
}

/**
 * 逐式移植 `calcPoints`（需求 8.4）。
 *
 * `corner` 必须是页面四角之一（x ∈ {0, w}，y ∈ {0, h}），通常来自 `simCorner`；
 * `touch` 是已按 `pinTouchY` 固定过的触点。
 *
 * 步骤：
 * 1. 中点与控制点（`controlOffsetsOf`），`start1.x = control1.x − (corner.x − control1.x) / 2`。
 * 2. 固定书脊端点：触点在页内（`0 < touch.x < w`）而 `start1.x` 越出 `[0, w]` 时，按 Legado 的比例公式
 *    沿"卷起角—触点"方向回拉触点，使 `start1.x` 落回页边，再重算第 1 步。
 * 3. `start2 = (corner.x, control2.y − (corner.y − control2.y) / 2)`；`end1`、`end2` 为"触点—控制点"
 *    与 `start1 start2` 的交点；`vertex` 为对应贝塞尔曲线的中点。
 *
 * 第 1、2 步以 `corner − touch` 为变量计算，与 Legado 用绝对坐标的写法代数上相同。差别只在精度：
 * 回拉后的触点可能横向贴近卷起角，用绝对坐标再相减会把 `corner.x − touch.x` 的误差放大到
 * `start1.x` 上（宽 4700px 时实测可达 3e-5px）。
 *
 * 触点（输入或修正后）距卷起角不足 `SIM_FLAT_EPS_PX`，或任一结果非有限（含平行线求交）时返回 null，
 * 调用方按平整页绘制（design §11）。
 */
export function simGeometry(touch: Pt, corner: Pt, w: number, h: number): SimGeometry | null {
  const cx = corner.x;
  const cy = corner.y;
  let dx = cx - touch.x;
  let dy = cy - touch.y;
  if (Math.hypot(dx, dy) < SIM_FLAT_EPS_PX) return null;

  let { q, r } = controlOffsetsOf(dx, dy);
  let s1x = cx - 1.5 * q; // control1.x − (corner.x − control1.x) / 2

  // 固定左边上下两个点（Legado 原注释）。f1 > 0：触点在页内而卷起角在页边。
  if (touch.x > 0 && touch.x < w && (s1x < 0 || s1x > w)) {
    const s = s1x < 0 ? w - s1x : s1x;
    const f1 = Math.abs(dx);
    const f2 = (w * f1) / s;
    dx = gapAfterAbs(cx, f2); // mTouchX = |cornerX − f2|
    const f3 = (Math.abs(dx) * Math.abs(dy)) / f1;
    dy = gapAfterAbs(cy, f3); // mTouchY = |cornerY − f3|
    ({ q, r } = controlOffsetsOf(dx, dy));
    s1x = cx - 1.5 * q;
  }

  const fixedTouch: Pt = { x: cx - dx, y: cy - dy };
  const start1: Pt = { x: s1x, y: cy };
  const control1: Pt = { x: cx - q, y: cy };
  const control2: Pt = { x: cx, y: cy - r };
  const start2: Pt = { x: cx, y: cy - 1.5 * r }; // control2.y − (corner.y − control2.y) / 2
  const touchToCorner = Math.hypot(dx, dy);
  const end1 = getCross(fixedTouch, control1, start1, start2);
  const end2 = getCross(fixedTouch, control2, start1, start2);
  const vertex1 = vertexOf(start1, control1, end1);
  const vertex2 = vertexOf(start2, control2, end2);
  // mDegrees = atan2(control1.x − corner.x, control2.y − corner.y)
  const degrees = (Math.atan2(-q, -r) * 180) / Math.PI;
  const isRtOrLb = (cx === 0 && cy === h) || (cy === 0 && cx === w);

  if (touchToCorner < SIM_FLAT_EPS_PX) return null;
  const points = [fixedTouch, start1, control1, vertex1, end1, start2, control2, vertex2, end2];
  if (!points.every(isFinitePt) || !Number.isFinite(degrees)) return null;

  return {
    touch: fixedTouch,
    start1,
    control1,
    vertex1,
    end1,
    start2,
    control2,
    vertex2,
    end2,
    touchToCorner,
    degrees,
    isRtOrLb,
  };
}

/**
 * 背面镜像：关于折线的反射，以 CSS `matrix(a, b, c, d, e, f)` 的顺序返回（需求 8.5）。
 *
 * 设 u 为折线的单位方向，则 `M = [[1 − 2u_y², 2u_x·u_y], [2u_x·u_y, 1 − 2u_x²]]`，
 * 平移 `(e, f) = p − M·p`，p 为折线上任一点。M 对称，所以 `b = c`。
 *
 * 折线是"卷起角—触点"连线的中垂线：u 取该连线的垂直方向，p 取连线中点。这与 design §6.6 用
 * `(corner.x − control1.x, control2.y − corner.y)` 与 `control1` 写出的式子是同一个反射（两个控制点
 * 都在中垂线上，方向向量只差一个非零倍数），但有两处更稳：
 * - `corner.y − middle.y = 0` 时 `control2` 是按 0.1 分母近似出来的，不在中垂线上，照搬会让卷起角
 *   映到触点旁约 0.2px 处；中垂线方向是精确的竖直线。
 * - 触点横向贴近卷起角时 `control1.x` 可达 1e15 量级，`control1 − M·control1` 会因相消丢掉整数位精度；
 *   中点始终在页面附近。
 *
 * 结果满足：M 把卷起角映到 `g.touch`，`M² = I`，且保持距离。
 */
export function mirrorMatrix(
  g: SimGeometry,
  corner: Pt,
): [number, number, number, number, number, number] {
  const nx = corner.x - g.touch.x;
  const ny = corner.y - g.touch.y;
  const len = Math.hypot(nx, ny);
  const ux = -ny / len;
  const uy = nx / len;
  const a = 1 - 2 * uy * uy;
  const b = 2 * ux * uy;
  const d = 1 - 2 * ux * ux;
  const px = (corner.x + g.touch.x) / 2;
  const py = (corner.y + g.touch.y) / 2;
  const e = px - (a * px + b * py);
  const f = py - (b * px + d * py);
  return [a, b, b, d, e, f];
}

/** 前景阴影的宽度（CSS px），即 Legado `drawCurrentPageShadow` 中的 25（需求 8.6）。 */
export const SIM_FRONT_SHADOW_PX = 25;

/**
 * 渐变条的 CSS `linear-gradient` 方向，按"阴影色 → 透明"理解：
 * 写作 `linear-gradient(<direction>, <阴影色>, transparent)`。
 * 方向是渐变条自身（旋转前）的坐标，随条一起旋转，与 Legado `GradientDrawable.Orientation` 相同。
 */
export type SimGradientDirection = "to right" | "to left" | "to bottom" | "to top";

/**
 * 一条渐变条，对应 Legado 的"`canvas.rotate(deg, px, py)` + `drawable.setBounds(...)`"。
 *
 * 渲染方式：`position: absolute` 放进铺满视口的裁剪包裹层，`left/top/width/height` 取本对象（px），
 * `transform-origin: originX px originY px`，`transform: rotate(rotate deg)`。
 * 旋转中心 `(left + originX, top + originY)` 即 Legado 的 `(px, py)`。Canvas 与 CSS 都是 y 向下，
 * 正角都是顺时针，所以角度原样沿用。
 */
export interface SimShadowStrip {
  left: number;
  top: number;
  width: number;
  height: number;
  /** 旋转角，单位度。 */
  rotate: number;
  /** 旋转中心相对条左上角的偏移（px）。 */
  originX: number;
  originY: number;
  direction: SimGradientDirection;
}

/**
 * 一帧仿真图层的全部可写样式（design §6.7），供 rAF 一次性写入。
 *
 * `clip` 里是可直接赋给 `style.clipPath` 的值。层号对应 design §6.7 的表（自下而上）：
 * ② 外层 `curl`、内层 `reveal`；③ `curlOutside`；④ 外层 `curlOutside`、内层 `front1` / `front2`；
 * ⑤ 外层 `curl`、内层 `back`。嵌套的两层裁剪取交集。
 */
export interface SimFrame {
  clip: {
    /** `path("curl")`：卷起区域（含背面与露出的目标页）。 */
    curl: string;
    /** `path(evenodd, "视口矩形 curl")`：curl 在视口内的补集，即卷起页未卷部分。 */
    curlOutside: string;
    /** `path("reveal")`：露出的目标页（与 curl 取交集）。 */
    reveal: string;
    /** `path("back")`：卷起部分的背面（与 curl 取交集）。 */
    back: string;
    /** `path("front1")`：沿 `start1 → control1` 一侧的前景阴影四边形。 */
    front1: string;
    /** `path("front2")`：沿 `start2 → control2` 一侧的前景阴影四边形。 */
    front2: string;
  };
  /**
   * ⑤ 背面副本的 `transform` 值 `matrix(a, b, c, d, e, f)`，即 `mirrorMatrix`。
   * 矩阵以视口原点为基准，背面副本须铺满视口并设 `transform-origin: 0 0`。
   */
  mirror: string;
  /** ② 背面阴影：宽 `touchToCorner / 4`，绕 `start1` 旋转 `degrees`（需求 8.6）。 */
  backShadow: SimShadowStrip;
  /** ④ 第一条前景阴影：宽 25，绕 `control1` 旋转（需求 8.6）。 */
  frontShadow1: SimShadowStrip;
  /** ④ 第二条前景阴影：高 25，绕 `control2` 旋转（需求 8.6）。 */
  frontShadow2: SimShadowStrip;
  /** ⑤ 折痕渐变：宽 `min(f1, f2)`，绕 `start1` 旋转 `degrees`，颜色取 `--turn-fold-shadow`（需求 8.5）。 */
  foldShadow: SimShadowStrip;
}

/** 由 `SimGeometry` 精确还原卷起角，见 `SimGeometry` 的说明。 */
function cornerOf(g: SimGeometry): Pt {
  return { x: g.control2.x, y: g.control1.y };
}

/**
 * path 字符串里的数字：保留 2 位小数（0.01 CSS px 远低于设备像素）。
 * `toFixed` 对任意有限数都给出合法的 SVG 数字（≥ 1e21 时为指数形式），不会溢出成 `Infinity`。
 */
function num(v: number): string {
  return v.toFixed(2);
}

function pt(p: Pt): string {
  return `${num(p.x)} ${num(p.y)}`;
}

function toDegrees(rad: number): number {
  return (rad * 180) / Math.PI;
}

function stripNumbers(s: SimShadowStrip): number[] {
  return [s.left, s.top, s.width, s.height, s.rotate, s.originX, s.originY];
}

/**
 * 把一帧几何打包成图层样式（design §6.7，需求 8.4、8.5、8.6）。
 *
 * 签名保持 design 的 `(g, w, h)`：卷起角 `(control2.x, control1.y)` 在 `simGeometry` 中是直接赋值的，
 * 可以从 `g` 精确还原，再传一次只会多一个可能与 `g` 不一致的入参。`w`、`h` 用于视口矩形
 * （curl 的补集）、渐变条长度 `hypot(w, h)`（Legado `mMaxLength`）和第二条前景阴影的避让判断。
 *
 * 路径（SVG 语法）：
 * - `curl   = M start1 Q control1 end1 L touch L end2 Q control2 start2 L corner Z`（`drawCurrentPageArea`）
 * - `reveal = M start1 L vertex1 L vertex2 L start2 L corner Z`（`drawNextPageAreaAndShadow`）
 * - `back   = M vertex2 L vertex1 L end1 L touch L end2 Z`（`drawCurrentBackArea`）
 * - `front1 = M p L touch L control1 L start1 Z`、`front2 = M p L touch L control2 L start2 Z`
 *   （`drawCurrentPageShadow`），`p = touch + 25·√2·(cos θ, ±sin θ)`，
 *   `θ = π/4 − atan2(±(control1.y − touch.y), touch.x − control1.x)`，右上/左下取 `+`。
 *
 * 渐变条逐式移植各函数的 `rotate` 与 `setBounds`，朝向随 `isRtOrLb` 取 LR/RL（或 TB/BT）：
 * - 背面阴影：`[start1.x, start1.x + ttc/4]` 或 `[start1.x − ttc/4, start1.x]` × `[start1.y, start1.y + L]`，
 *   绕 `start1` 转 `degrees`，阴影色在折线一侧。
 * - 前景阴影 1：`[control1.x, +25]` 或 `[control1.x − 25, control1.x]` × `[control1.y − L, control1.y]`，
 *   绕 `control1` 转 `atan2(touch.x − control1.x, control1.y − touch.y)`。
 * - 前景阴影 2：纵向 `[control2.y, +25]` 或 `[control2.y − 25, control2.y]`；横向通常为
 *   `[control2.x − L, control2.x]`，`control2` 远离页面（`hmg > L`）时改为 `[control2.x − 25 − hmg, control2.x + L − hmg]`；
 *   绕 `control2` 转 `atan2(control2.y − touch.y, control2.x − touch.x)`。
 * - 折痕：`f1 = |start1.x − control1.x| / 2`、`f2 = |start2.y − control2.y| / 2`（即 Legado 的
 *   `|(start + control)/2 − control|`），条宽 `min(f1, f2)`，定位同背面阴影，渐变朝向与之相反。
 *
 * 与 Legado 的偏离：
 * - Legado 的 `toInt()` 与 ±1px 外扩只为对齐 Android 的整数 `Rect`，这里保留小数、不外扩，
 *   于是各条宽度恰为 `touchToCorner / 4`、25 与 `min(f1, f2)`（Property 19）。
 * - 阴影顶点用 `Math.SQRT2` 代替 `1.414`。
 *
 * `g` 来自 `simGeometry`，各坐标已保证有限；若派生量（极端坐标下的和或 `hypot`）溢出，返回 null，
 * 调用方与 `simGeometry` 返回 null 时一样按平整页绘制。返回值里的字符串从不含 `NaN` 或 `Infinity`。
 */
export function simFrame(g: SimGeometry, w: number, h: number): SimFrame | null {
  const { touch, start1, control1, vertex1, end1, start2, control2, vertex2, end2, isRtOrLb } = g;
  const corner = cornerOf(g);
  const maxLength = Math.hypot(w, h);
  const S = SIM_FRONT_SHADOW_PX;

  // drawCurrentPageShadow：阴影顶点 p。
  const base = isRtOrLb
    ? Math.atan2(control1.y - touch.y, touch.x - control1.x)
    : Math.atan2(touch.y - control1.y, touch.x - control1.x);
  const theta = Math.PI / 4 - base;
  const d1 = S * Math.SQRT2 * Math.cos(theta);
  const d2 = S * Math.SQRT2 * Math.sin(theta);
  const apex: Pt = { x: touch.x + d1, y: isRtOrLb ? touch.y + d2 : touch.y - d2 };

  // drawNextPageAreaAndShadow：背面阴影。
  const backWidth = g.touchToCorner / 4;
  const backShadow: SimShadowStrip = {
    left: isRtOrLb ? start1.x : start1.x - backWidth,
    top: start1.y,
    width: backWidth,
    height: maxLength,
    rotate: g.degrees,
    originX: isRtOrLb ? 0 : backWidth,
    originY: 0,
    direction: isRtOrLb ? "to right" : "to left",
  };

  // drawCurrentPageShadow：沿 control1 的竖条。
  const frontShadow1: SimShadowStrip = {
    left: isRtOrLb ? control1.x : control1.x - S,
    top: control1.y - maxLength,
    width: S,
    height: maxLength,
    rotate: toDegrees(Math.atan2(touch.x - control1.x, control1.y - touch.y)),
    originX: isRtOrLb ? 0 : S,
    originY: maxLength,
    direction: isRtOrLb ? "to right" : "to left",
  };

  // drawCurrentPageShadow：沿 control2 的横条。control2 远离页面时整条平移，保证能延伸进视口。
  const temp = control2.y < 0 ? control2.y - h : control2.y;
  const hmg = Math.hypot(control2.x, temp);
  const far = hmg > maxLength;
  const frontShadow2: SimShadowStrip = {
    left: far ? control2.x - S - hmg : control2.x - maxLength,
    top: isRtOrLb ? control2.y : control2.y - S,
    width: far ? maxLength + S : maxLength,
    height: S,
    rotate: toDegrees(Math.atan2(control2.y - touch.y, control2.x - touch.x)),
    originX: far ? S + hmg : maxLength,
    originY: isRtOrLb ? 0 : S,
    direction: isRtOrLb ? "to bottom" : "to top",
  };

  // drawCurrentBackArea：折痕渐变。Legado 的颜色是"透明 → 折痕色"，所以朝向与背面阴影相反。
  const f1 = Math.abs(start1.x - control1.x) / 2;
  const f2 = Math.abs(start2.y - control2.y) / 2;
  const foldWidth = Math.min(f1, f2);
  const foldShadow: SimShadowStrip = {
    left: isRtOrLb ? start1.x : start1.x - foldWidth,
    top: start1.y,
    width: foldWidth,
    height: maxLength,
    rotate: g.degrees,
    originX: isRtOrLb ? 0 : foldWidth,
    originY: 0,
    direction: isRtOrLb ? "to left" : "to right",
  };

  const matrix = mirrorMatrix(g, corner);

  const numbers = [
    w,
    h,
    apex.x,
    apex.y,
    ...matrix,
    ...stripNumbers(backShadow),
    ...stripNumbers(frontShadow1),
    ...stripNumbers(frontShadow2),
    ...stripNumbers(foldShadow),
  ];
  if (!numbers.every(Number.isFinite)) return null;

  const curl =
    `M${pt(start1)} Q${pt(control1)} ${pt(end1)} L${pt(touch)} ` +
    `L${pt(end2)} Q${pt(control2)} ${pt(start2)} L${pt(corner)} Z`;
  const reveal = `M${pt(start1)} L${pt(vertex1)} L${pt(vertex2)} L${pt(start2)} L${pt(corner)} Z`;
  const back = `M${pt(vertex2)} L${pt(vertex1)} L${pt(end1)} L${pt(touch)} L${pt(end2)} Z`;
  const front1 = `M${pt(apex)} L${pt(touch)} L${pt(control1)} L${pt(start1)} Z`;
  const front2 = `M${pt(apex)} L${pt(touch)} L${pt(control2)} L${pt(start2)} Z`;
  const viewport = `M0 0 L${num(w)} 0 L${num(w)} ${num(h)} L0 ${num(h)} Z`;

  return {
    clip: {
      curl: `path("${curl}")`,
      curlOutside: `path(evenodd, "${viewport} ${curl}")`,
      reveal: `path("${reveal}")`,
      back: `path("${back}")`,
      front1: `path("${front1}")`,
      front2: `path("${front2}")`,
    },
    mirror: `matrix(${matrix.join(", ")})`,
    backShadow,
    frontShadow1,
    frontShadow2,
    foldShadow,
  };
}
