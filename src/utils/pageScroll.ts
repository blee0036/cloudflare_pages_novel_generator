/**
 * 滚动模式下的行滚动与章首章末算术（需求 11.13；沿革见 reader-consolidation 差异表 C13）。
 * 翻页滚动见 `scrollTurn.ts`，分页见 `paginate.ts`。
 *
 * 这里只做算术，不碰 DOM、不读 React——入参是一个 `{ scrollTop, clientHeight, scrollHeight }`
 * 的快照（`HTMLElement` 天然满足这个形状）或当前章的纵向区段，出参是一个目标 `scrollTop`。
 * 抽出来的理由与 `locator.ts` 相同：全是差一位与夹取的陷阱，错了 `typecheck` 一无所知，
 * 症状是"按一下 ↓ 跳过了两行"或"到章尾还能再按一下"（design §11）。
 *
 * 两条不变量贯穿全文件，测试逐条钉住：
 *
 * 1. **不跳过未读内容**：一次滚动的位移恒 `<= clientHeight`，所以上一屏的底边之后没有
 *    任何像素被越过；
 * 2. **不越界**：返回值恒落在 `[0, maxScrollTop]`，脏输入（`NaN`、负数、尚未布局的 0）
 *    一律夹回这个区间。
 */

/**
 * 判定"已在章首/章尾"的容差像素。
 *
 * `scrollHeight`、`clientHeight` 在缩放、subpixel 布局下都是小数，`scrollTop` 也可能
 * 停在 `max - 0.5`。没有容差时读者滚到底却被判成"还有 0.5px 可滚"，到了尽头仍被当作
 * 没到——那是个只在某些缩放比下复现的"卡住"。
 */
export const EDGE_EPSILON_PX = 2;

/**
 * 滚动容器的几何快照。`HTMLElement` 结构上即满足，因此调用处可以直接把 `<main>` 传进来，
 * 而测试只需给三个数字。
 */
export interface ScrollBox {
  readonly scrollTop: number;
  readonly clientHeight: number;
  readonly scrollHeight: number;
}

/**
 * 滚动方向：`1` = 向下（`↓`），`-1` = 向上（`↑`）。
 */
export type PageDirection = 1 | -1;

/** 章内的两端：`Home` 去章首，`End` 去章末（需求 9.4）。 */
export type ChapterEdge = "start" | "end";

/** 把可能为脏值的像素量夹成非负有限数。非有限数按 0 处理（尚未布局的容器即是如此）。 */
function asPx(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/**
 * 容器能滚到的最大 `scrollTop`，即容器内容的尽头。
 *
 * 内容不超过一屏时为 0——此时没有可滚的行，`lineScrollTarget` 会如实报告"已在尽头"。
 */
export function maxScrollTop(box: ScrollBox): number {
  return Math.max(0, asPx(box.scrollHeight) - asPx(box.clientHeight));
}

/**
 * 行滚动的步长（需求 4.3）。
 *
 * 取 40 与主流浏览器方向键的默认滚动量同一量级（约两行正文），读者按 `↑`/`↓` 的手感
 * 与文档滚动时相同。不做成设置项：这是个"看不见才算对"的量，可调只会多一个没人会调的
 * 旋钮（C11 的教训）。
 */
export const LINE_STEP_PX = 40;

/**
 * 一行的目标 `scrollTop`（需求 4.3 的 `↑`/`↓`）；该方向没有可滚像素（≤ `EDGE_EPSILON_PX`）
 * 时为 `null`。
 *
 * `null` 在两个方向上都只意味着"原地不动"：行滚动是细调，到容器尽头不触发换章或翻页
 * （需求 11.13）。
 *
 * 步长取 `LINE_STEP_PX` 与视口高度中的较小者：极矮的视口上一行也不越过一整屏
 * （与不变量 1 同一考虑）；`clientHeight` 不足 1px（尚未布局或脏值）时视为没有可滚的行，
 * 而不是让读者按一下 `↓` 挪动不到一个像素。返回值恒在 `[0, maxScrollTop]`（不变量 2）。
 */
export function lineScrollTarget(box: ScrollBox, direction: PageDirection): number | null {
  const height = asPx(box.clientHeight);
  if (height < 1) return null;

  const max = maxScrollTop(box);
  // 先把当前位置夹进合法区间：快照可能是脏值，或取自内容刚变矮的那一刻，`scrollTop` 大于 `max`。
  const from = Math.min(max, asPx(box.scrollTop));

  const room = direction > 0 ? max - from : from;
  if (room <= EDGE_EPSILON_PX) return null;

  const step = Math.min(LINE_STEP_PX, height);
  return Math.min(max, Math.max(0, from + direction * step));
}

/**
 * 当前章在滚动容器里占据的纵向区段（容器内容坐标，即 `scrollTop` 的坐标系）。
 *
 * `top` 是区段顶边，`bottom` 是区段底边。滚动模式的容器里首尾相接地挂着若干章，区段是当前章
 * （判定线所在章）那一个 `<section>`；容器里只挂着一章时，区段就是整个内容：
 * `{ top: 0, bottom: scrollHeight }`。
 */
export interface ChapterSpan {
  readonly top: number;
  readonly bottom: number;
}

/**
 * 章首 / 章末对应的 `scrollTop`（需求 9.4、11.13 的 `Home`/`End`）。
 *
 * 章首取区段顶边 `top` 而不是 `tops[0] - TOP_BIAS`：区段顶边对齐容器顶边时，`<h1>` 章节
 * 标题连同"第 N / 共 M 章"一起进入视野，这正是读者按 `Home` 想看到的东西。`TOP_BIAS` 是
 * "视口首个可见段落"的判定线（design §3.3），只用于段落级的定位与恢复，两端不需要它。
 *
 * 章末取 `max(top, bottom − clientHeight)`：区段底边贴住视口底边，本章最后一屏完整可见，
 * 下一章从视口下沿之外接着开始。区段不满一屏时两端重合在 `top`，不会为了贴底而滚进上一章。
 *
 * 脏值（`NaN`、负数）同 `maxScrollTop` 一样按 0 处理，所以 `{ top: 0, bottom: scrollHeight }`
 * 与旧版"章首 0、章末 `maxScrollTop`"逐值相同。
 */
export function chapterEdgeScrollTop(span: ChapterSpan, clientHeight: number, edge: ChapterEdge): number {
  const top = asPx(span.top);
  if (edge === "start") return top;
  return Math.max(top, asPx(span.bottom) - asPx(clientHeight));
}
