/**
 * `?ch=` 的定位与写回（reader-url 需求 7、design §6 的 S3；本功能 design §1.1，需求 3.9、10.4）。
 *
 * 从 `ReaderPage.tsx` 原样迁出的两个 effect 与它们共用的两枚 ref，逻辑不变：
 *
 * - **定位 effect**：首次定位（URL 章号与已存进度合成唯一位置），以及响应外部改动的 `ch`
 *   （`popstate` 等）。
 * - **写回 effect**：位置已定后，把当前章以 `replace` 写进 URL；`history.replaceState` 限频抛出的
 *   `DOMException` 吞掉并回退 `urlChRef`。
 *
 * 跨章翻页（分页模式）与连续滚动跨章（滚动模式）都经 `useReadingPosition.reportPosition` 改
 * `currentChapterIndex`，写回仍只有本文件这一个出口，且始终是 `replace`，所以都不新增历史记录
 * （需求 3.9、10.4）。
 *
 * ## 为什么拆成两个 hook
 *
 * `currentChapterRef` 的契约是"**每一条**改 `currentChapterIndex` 的路径都先写它"（见下方
 * `ChapterUrlRefs`）。写它的 `jumpTo` 与 `reportPosition` 都定义在调用方，而定位 effect 又要调
 * `jumpTo`——ref 必须早于 `jumpTo` 存在，effect 必须晚于 `jumpTo` 声明（依赖数组在渲染时就要读
 * `jumpTo`，提前声明会撞上 `const` 的暂时性死区）。所以：
 *
 * ```ts
 * const urlRefs = useChapterUrlRefs();          // 早于 jumpTo / reportPosition
 * const jumpTo = useCallback((t) => {
 *   urlRefs.currentChapterRef.current = ...;    // 先于 state
 *   ...
 * }, [...]);
 * useChapterUrlSync(urlRefs, { ..., jumpTo }); // 晚于 jumpTo
 * ```
 *
 * ## 不测的原因
 *
 * 与本目录其他 hook 相同：测 React hook 需要 jsdom + testing-library，不在本项目测试范围内。
 * 依赖的判定（`parseUrlChapter`、`withChapterParam`、`initialPosition`）是 `utils/` 的纯函数，
 * 在那里测；运行时行为由 E2E（`reader-url.spec.ts`）覆盖。
 */

import { MutableRefObject, useEffect, useMemo, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { BookToc } from "../types";
import { ChapterViews, JumpTarget } from "../utils/locator";
import { initialPosition } from "../utils/readerPosition";
import { CHAPTER_PARAM, parseUrlChapter, withChapterParam } from "../utils/readerUrl";
import { getBookProgress } from "../utils/storage";

/** 定位 effect 与写回 effect 共用的两枚 ref。对象与其中的 ref identity 都跨渲染稳定。 */
export interface ChapterUrlRefs {
  /**
   * **最近一次决定的**当前章号：每一条改 `currentChapterIndex` 的路径（首次定位、`jumpTo`、
   * `reportPosition` 的换章分支，design §3.2）都先写这里再写 state，于是它要么等于
   * `currentChapterIndex`，要么领先它一次提交。漏写的路径会让写回 effect 永远等不到二者相等，
   * URL 就此停在旧章。
   *
   * 领先的那一拍正是它存在的理由（design §6，需求 7.9）：定位 effect 因外部改动的 `ch` 调了
   * `jumpTo` 之后，同一次 effect 冲刷里紧接着跑的写回 effect 闭包里还是旧章号；若照旧章号
   * 写回，会把读者刚要跳去的 `ch` 改回去，随后两边来回拉扯。写回 effect 见到二者不等就等下一次
   * 提交；定位 effect 用它判断"外部给的章是不是当前章"，不必把 `currentChapterIndex` 列进依赖。
   */
  readonly currentChapterRef: MutableRefObject<number>;
  /**
   * 本组件最后一次处理过、或写回的 `ch` 原文（`null` = 参数缺省），design §6 的 S3。
   *
   * 用来区分"自己的写回"与"外部改动"：写回 effect 发起导航之前先把目标值记在这里，导航落地后
   * `searchParams` 变化回到定位 effect，命中 `raw === urlChRef.current` 原地返回（需求 7.3）；
   * 外部改出来的值对不上它，才当作一次跳转请求处理（需求 7.9）。
   *
   * 写回 effect 也拿它（而不是渲染时的 `searchParams`）判断 URL 是否已是当前章：`replace` 导航
   * 包在 transition 里，落地前的渲染读到的 `searchParams` 还是旧值。连按 `→` `←` 时当前章恰好
   * 回到旧值，按 `searchParams` 判会以为"已一致"而不写，随后落地的 `→` 那次写回就被误当成外部
   * 改动、把读者拽回去。
   */
  readonly urlChRef: MutableRefObject<string | null>;
}

/** 建立两枚 ref。须早于任何会写 `currentChapterRef` 的回调（`jumpTo`、`reportPosition`）调用。 */
export function useChapterUrlRefs(): ChapterUrlRefs {
  const currentChapterRef = useRef(0);
  const urlChRef = useRef<string | null>(null);
  return useMemo(() => ({ currentChapterRef, urlChRef }), []);
}

export interface ChapterUrlSyncOptions {
  /** 路由里的书 id。 */
  bookId: string | undefined;
  /** 本书目录；换书时先置 null，免得拿上一本书的章节表校验章号。 */
  toc: BookToc | null;
  /** `buildChapterViews(toc.chapters)`，随 `toc` 换。 */
  chapterViews: ChapterViews;
  /**
   * 已完成首次定位的书 id（`null` = 尚未定位）。写回 effect 的闸门（需求 7.1）：初始位置定下来
   * 之前，`currentChapterIndex` 还是占位的 0，此时写回会把 URL 上的 `?ch=` 冲掉。
   */
  positionedBook: string | null;
  /** 当前章号（state，`useReadingPosition` 持有）。 */
  currentChapterIndex: number;
  /**
   * 首次定位落地：立起 `positionedBook = bookId`，把 `target` 写成当前位置，清检索高亮，并下发
   * 导航指令（`NavRequest`，章首也下发）让视图显示该位置。
   *
   * 调用前本 hook 已写好 `urlChRef` 与 `currentChapterRef`。须 identity 稳定（列在定位 effect 的
   * 依赖里）。
   */
  onInitialPosition: (bookId: string, target: JumpTarget) => void;
  /**
   * 统一跳转入口：清高亮、下发导航指令（`NavRequest`），并先行更新 `currentChapterRef`。
   * 须 identity 稳定——只随 `chapterViews` 等不随换章变化的值变化，换章才不会让定位 effect 重跑；
   * 即使重跑，也因 `raw === urlChRef.current` 直接返回。
   */
  jumpTo: (target: JumpTarget) => void;
}

/**
 * 定位与 URL 写回（design §6，需求 7；S3）。须晚于 `jumpTo` 调用。
 *
 * 两个 effect 各管一个方向，以 `urlChRef` 区分"自己的写回"与"外部改动"：
 * - 定位 effect 只处理**外部给出**的 `ch`：首次定位时 URL 上的那个，以及之后经应用内导航
 *   改出来的（`popstate` 等，需求 7.9）。读者自己换章不经过这里——那些路径直接走 `jumpTo`
 *   或 `reportPosition`。
 * - 写回 effect 只负责把当前章以 `replace` 写进 URL（需求 7.1、D2）。全部换章路径最终都改
 *   `currentChapterIndex`，写回因此只有这一个出口。
 *
 * 声明顺序有意义：同一次 effect 冲刷里定位先跑、写回后跑，写回读到的 `urlChRef` /
 * `currentChapterRef` 已是定位 effect 处理过本次 `searchParams` 之后的值。
 */
export function useChapterUrlSync(refs: ChapterUrlRefs, options: ChapterUrlSyncOptions): void {
  const { currentChapterRef, urlChRef } = refs;
  const {
    bookId,
    toc,
    chapterViews,
    positionedBook,
    currentChapterIndex,
    onInitialPosition,
    jumpTo,
  } = options;
  const [searchParams, setSearchParams] = useSearchParams();

  /** 本书有没有正文章节。全由卷节点构成的异常数据走错误页，不渲染空白（需求 12.6）。 */
  const hasContentChapters = chapterViews.contentIdx.length > 0;

  // 定位：首次定位，或响应外部改动的 `ch`。
  //
  // 依赖里有 `searchParams`，同一本书内改 `?ch=` 会重新定位而不重新下载（RC 1.5）；加载 effect
  // 只认 `bookId`。`jumpTo` 与 `onInitialPosition` identity 稳定，换章不会让本 effect 重跑；
  // 即使重跑，也因 `raw === urlChRef.current` 直接返回。
  useEffect(() => {
    if (!bookId || !toc) return;
    // 全是卷节点的异常数据：没有任何章可定位，一个字也不写（包括不动已存的进度记录、不写回
    // URL——`positionedBook` 不立起来），由错误页接手（需求 12.6）。
    if (!hasContentChapters) return;

    const raw = searchParams.get(CHAPTER_PARAM);
    const chapterCount = toc.chapters.length;

    if (positionedBook !== bookId) {
      // 首次定位：URL 章号与已存进度按 D3 / RC 12.5 合成唯一的（章号, 偏移）——有效 `?ch=`
      // 指向进度所在章时恢复章内偏移（7.5），指向另一章或没有进度时落在章首（7.6、EV 9.12），
      // 缺省或无效时按进度恢复；卷节点一律归一到其后第一个正文章节。
      const target = initialPosition(
        chapterViews,
        chapterCount,
        parseUrlChapter(raw, chapterCount),
        getBookProgress(bookId)
      );
      // 上面已判过 `hasContentChapters`，这里不会是 null；判一次只为类型收窄
      if (target === null) return;

      // 记下这次处理过的原文：写回 effect 随后若要改写它（无效、卷节点、或缺省），改写后的
      // 值也会先记在这里，落地时本 effect 原地返回，不会把首次定位再做一遍。
      urlChRef.current = raw;
      currentChapterRef.current = target.chapterId;
      // 立起 `positionedBook`、写入位置、清高亮、让视图显示该位置（见 `onInitialPosition`）
      onInitialPosition(bookId, target);
      return;
    }

    // 自己的写回落地，或 `ch` 没变：不碰视口、高亮，也不下发导航指令（需求 7.3）
    if (raw === urlChRef.current) return;
    urlChRef.current = raw;

    const urlChapter = parseUrlChapter(raw, chapterCount);
    // 无效（缺省、非数字、负数、越界）：位置不动，写回 effect 随后把 URL 改回当前章
    if (urlChapter === null) return;

    // 章内位置与首次定位同一套规则（7.9 的"按第 5、6 条确定"）
    const target = initialPosition(chapterViews, chapterCount, urlChapter, getBookProgress(bookId));
    // 归一后就是当前章（含指向当前章之前那个卷节点）：不改变当前位置（7.9）。URL 原文若与
    // 当前章号的规范写法不同（"03"、卷节点下标），由写回 effect 规整。
    if (target === null || target.chapterId === currentChapterRef.current) return;

    // 清高亮、下发导航指令，并先行更新 `currentChapterRef`
    jumpTo(target);
  }, [
    bookId,
    toc,
    searchParams,
    positionedBook,
    chapterViews,
    hasContentChapters,
    jumpTo,
    onInitialPosition,
    urlChRef,
    currentChapterRef,
  ]);

  // 写回：位置已定后，URL 的 `ch` 与当前章不一致即以 `replace` 写回（需求 7.1、D2）。
  //
  // `replace` 不新增历史记录，`history.length` 不变；书架进入阅读器那一次 push 之后，一次后退
  // 仍回到进入前的页面（7.8）。跨章翻页与连续滚动跨章同走这里，同样不新增记录（需求 3.9、10.4）。
  // 函数式更新器只改 `ch`，路径与其余参数（键、值、顺序）不变（`withChapterParam`，7.2）。
  //
  // 本 effect 不碰 `scrollTop`、高亮与待恢复的位置；导航落地后的那次渲染里，定位 effect
  // 命中 `raw === urlChRef.current` 原地返回（7.3）。
  //
  // `searchParams` 在依赖里但不在函数体里：外部把 `ch` 改成无效值时当前章不变，要靠它让本 effect
  // 重跑、把 URL 改回当前章。
  useEffect(() => {
    if (positionedBook !== bookId) return;
    // 定位 effect 刚在本次冲刷里调了 `jumpTo`，state 还是旧章：此刻写回会把读者要去的 `ch`
    // 改回旧章。`jumpTo` 那次提交会带着新的 `currentChapterIndex` 让本 effect 重跑。
    if (currentChapterRef.current !== currentChapterIndex) return;

    const want = String(currentChapterIndex);
    if (urlChRef.current === want) return;

    // 先记下要写出的值，再发起导航：导航落地时定位 effect 凭它认出这是自己的写回
    const previous = urlChRef.current;
    urlChRef.current = want;
    try {
      setSearchParams((prev) => withChapterParam(prev.toString(), currentChapterIndex), {
        replace: true,
      });
    } catch (err) {
      // Safari / Firefox 对 `history.replaceState` 限频，超限时抛 `SecurityError`（DOMException），
      // React Router 的 `replace` 不接这个异常。拖章节滑杆划过上百章就可能撞上；任它从 effect 里
      // 抛出会卸掉整个应用。这里只吞这一类：URL 没变，`urlChRef` 退回原值，下一次换章照常写回。
      if (!(err instanceof DOMException)) throw err;
      urlChRef.current = previous;
    }
  }, [
    positionedBook,
    bookId,
    currentChapterIndex,
    searchParams,
    setSearchParams,
    urlChRef,
    currentChapterRef,
  ]);
}
