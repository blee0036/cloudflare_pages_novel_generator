/**
 * 翻页与章首/章末的滚动算术（需求 9.4、差异表 C13）。
 *
 * 阅读器只有"连续滚动"一种呈现（真分页已由 C11 舍弃），所以 `Space` 的"下翻"就是
 * **把滚动容器往下推一屏**。这里只做算术，不碰 DOM、不读 React——入参是一个
 * `{ scrollTop, clientHeight, scrollHeight }` 的快照（`HTMLElement` 天然满足这个形状），
 * 出参是一个目标 `scrollTop`。抽出来的理由与 `locator.ts` 相同：全是差一位与夹取的陷阱，
 * 错了 `typecheck` 一无所知，症状是"按一下 Space 跳过了两行"或"到章尾还能再按一下"
 * （design §11）。
 *
 * 两条不变量贯穿全文件，测试逐条钉住：
 *
 * 1. **不跳过未读内容**：一次下翻的位移恒 `<= clientHeight`，所以上一屏的底边之后没有
 *    任何像素被越过；
 * 2. **不越界**：返回值恒落在 `[0, maxScrollTop]`，脏输入（`NaN`、负数、尚未布局的 0）
 *    一律夹回这个区间。
 */

/**
 * 相邻两屏的重叠像素（需求 9.4 的"下翻"要留衔接）。
 *
 * 取 64 是因为屏幕上下各有一条浮动栏：顶栏 `h-14`（56px），底栏同高。正文滚到中段时
 * 底栏会压住最后一两行，重叠量若为 0，被压住的那几行就会在下一屏跑到顶栏后面——两次
 * 遮挡叠加，读者恰好丢掉一行。留一栏的高度再多一点，被遮过的行必然重新出现在正文区内。
 *
 * 不做成设置项：这是个"看不见才算对"的量，可调只会多一个没人会调的旋钮（C11 的教训）。
 */
export const PAGE_OVERLAP_PX = 64;

/**
 * 一屏最少要推进视口高度的多少（下翻步长的下限比例）。
 *
 * 只在极矮的视口上起作用：手机横屏 + 唤出输入法时 `clientHeight` 可能只有 120px，
 * 此时 `120 - 64 = 56` 的步长意味着按一下才走半屏，读者会以为快捷键坏了。比例下限
 * 让步长至少是半屏，代价是重叠量随之缩小——矮视口上"少重叠"比"几乎不动"好。
 */
export const MIN_PAGE_RATIO = 0.5;

/**
 * 判定"已在章首/章尾"的容差像素。
 *
 * `scrollHeight`、`clientHeight` 在缩放、subpixel 布局下都是小数，`scrollTop` 也可能
 * 停在 `max - 0.5`。没有容差时读者滚到底却被判成"还有 0.5px 可滚"，于是 `Space`
 * 原地不动而不是进入下一章——那是个只在某些缩放比下复现的"卡住"。
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

/** 翻页方向：`1` = 下翻（`Space`），`-1` = 上翻（`Shift+Space`）。 */
export type PageDirection = 1 | -1;

/** 章内的两端：`Home` 去章首，`End` 去章末（需求 9.4）。 */
export type ChapterEdge = "start" | "end";

/** 把可能为脏值的像素量夹成非负有限数。非有限数按 0 处理（尚未布局的容器即是如此）。 */
function asPx(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/**
 * 容器能滚到的最大 `scrollTop`，即"章末"对应的位置。
 *
 * 内容不超过一屏时为 0——短章节因此没有可翻的页，`pageScrollTarget` 会如实报告"已在尽头"。
 */
export function maxScrollTop(box: ScrollBox): number {
  return Math.max(0, asPx(box.scrollHeight) - asPx(box.clientHeight));
}

/**
 * 一次下翻/上翻的位移：视口高度减去重叠量，并保证至少走半屏。
 *
 * 恒 `<= clientHeight`（不变量 1）：两个候选值 `h * 0.5` 与 `h - 64` 都不大于 `h`，
 * 取整只会让它再小一点或多 0.5px（`Math.round` 在 `h >= 1` 时不会越过 `h`）。
 *
 * `clientHeight` 不足 1px（容器尚未布局、或传进来的是脏值）时返回 0，由调用方解释为
 * "没有可翻的页"，而不是让读者按一下 `Space` 挪动一个像素。
 */
export function pageStep(clientHeight: number): number {
  const height = asPx(clientHeight);
  if (height < 1) return 0;
  return Math.round(Math.max(height * MIN_PAGE_RATIO, height - PAGE_OVERLAP_PX));
}

/**
 * 下翻/上翻后的目标 `scrollTop`；**`null` 表示该方向已经没有可滚的像素**。
 *
 * `null` 是给调用方的分叉点，两个方向的处置有意不对称（需求 9.4 只规定了"下翻"）：
 *
 * - **下翻到尽头** → 阅读器进入下一章（`ReaderPage` 的 `pageScroll`）。koodo 把 `Space`
 *   绑在 `nextPage`（`rendition.next()`）上，与"上/下一章"是两个独立动作，翻页本身由
 *   渲染引擎连续推进；本阅读器没有分页引擎，等价做法就是"滚到章尾后再按一次才换章"。
 *   要两次按键才跨章，所以不会误跳；而且只在**一个像素都滚不动**时才换章，绝不会跳过
 *   未读内容。
 * - **上翻到章首** → 原地不动。"回到上一章末尾"需要一个渲染后才知道的偏移（末段的
 *   `offsetTop` 要等测量），而落在上一章章首又与 `←` 完全重复——`←`/`→` 本来就是章节
 *   导航（C13 保留），读者要回上一章用它即可。
 *
 * 返回值恒在 `[0, maxScrollTop]`（不变量 2），且与当前位置的距离恒 `<= clientHeight`
 * （不变量 1）。
 */
export function pageScrollTarget(box: ScrollBox, direction: PageDirection): number | null {
  const max = maxScrollTop(box);
  // 先把当前位置夹进合法区间：容器刚换章时 `scrollTop` 可能还是上一章那个更大的值。
  const from = Math.min(max, asPx(box.scrollTop));

  // 该方向剩余的可滚像素。容差见 `EDGE_EPSILON_PX`。
  const room = direction > 0 ? max - from : from;
  if (room <= EDGE_EPSILON_PX) return null;

  const step = pageStep(box.clientHeight);
  if (step === 0) return null;

  return Math.min(max, Math.max(0, from + direction * step));
}

/**
 * 章首 / 章末对应的 `scrollTop`（需求 9.4 的 `Home`/`End`）。
 *
 * 章首取 0 而不是 `tops[0] - TOP_BIAS`：0 让 `<h1>` 章节标题连同"第 N / 共 M 章"一起
 * 进入视野，这正是读者按 `Home` 想看到的东西。`TOP_BIAS` 是"视口首个可见段落"的判定线
 * （design §3.3），只用于段落级的定位与恢复，两端不需要它。
 *
 * 章末取 `maxScrollTop`，于是章末导航卡（上一章/下一章按钮）一并露出——按 `End` 的意图
 * 多半就是"这章还有多少"或"直接去下一章"。
 */
export function chapterEdgeScrollTop(box: ScrollBox, edge: ChapterEdge): number {
  return edge === "start" ? 0 : maxScrollTop(box);
}
