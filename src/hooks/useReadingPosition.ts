/**
 * 阅读位置：当前章号 + 章内字符偏移，以及它们的落盘（design §1.1、§3.2、§3.4）。
 *
 * 从 `ReaderPage.tsx` 迁出（任务 13.1），语义不变：
 * - `currentChapterIndex` 与 `charOffset` 一起构成阅读位置的唯一真相（INV-1）。页码只是
 *   分页视图的运行时派生物，不进这里，也不进进度、书签与 URL（需求 2.8）。
 * - 位置变化即落盘；读者移动产生的同章偏移先进 `pendingOffsetRef`，停止变化 1 秒后才提交
 *   成 state 并落盘；离开阅读器时补写还没提交的那一个（需求 12.6）。
 * - 阅读百分比只由字符偏移决定，与翻页模式无关（需求 12.7）。
 *
 * 新增的是 `reportPosition`（design §3.2）：两种视图在读者移动后都只调它，由它决定
 * "换章立即提交"还是"同章走防抖"。
 *
 * 与本目录其他 hook 一样不做单元测试（项目不搭 jsdom）；行为由 E2E 覆盖。
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BookToc, ChapterMeta } from "../types";
import { saveBookProgress } from "../utils/storage";
import { progressPercentAt } from "../utils/locator";

/**
 * 位置停止变化多久后落盘（需求 12.6 的"位置停止变化 1 秒后写入"）。
 *
 * 每次同章上报都重排这个定时器，所以连续翻阅期间一次都不会写；真正停下来才写一次。
 * 取值不宜再小：localStorage 是同步 API，写在滚动尾声更可能撞上读者继续滚动。
 */
export const SAVE_DEBOUNCE_MS = 1000;

export interface ReadingPositionOptions {
  /** 路由里的书 id；缺省时不落盘。 */
  bookId: string | undefined;
  /** 当前书的目录；换书期间为 null，此时不落盘、百分比为 0。 */
  toc: BookToc | null;
  /**
   * 初始位置已为哪本书解析完成（`ReaderPage` 的 `positionedBook` state）。
   *
   * 是落盘与卸载补写的闸门：`toc` 到位的那一次提交里章号还是 0、偏移还是 0，若此时就落盘，
   * 会把"第 500 章 / 偏移 12345"的记录覆盖成章首——正好在恢复它之前。它由定位 effect 写，
   * 所以从外面传进来，而不是由本 hook 持有。
   */
  positionedBook: string | null;
  /**
   * 每次经本 hook 决定新章号时（`setCurrentChapterIndex`，以及 `reportPosition` 换章），
   * 在写 state **之前**同步调用。
   *
   * 给 URL 同步用：它的 `currentChapterRef` 必须等于或领先 `currentChapterIndex`
   * （见 `useChapterUrlSync`）。`jumpTo` 与首次定位自己会先写那个 ref，但视图上报的换章
   * （跨章翻页、连续滚动越过章界）不经过它们；不在这里推进，写回 effect 会一直等不到
   * "ref 与 state 一致"，`?ch=` 就停在旧章（需求 3.9、10.4）。
   *
   * 取最新一次渲染传入的函数，传内联箭头函数不会改变 `reportPosition` 的 identity。
   */
  onChapterDecided?: (chapterId: number) => void;
}

export interface ReadingPosition {
  /** 当前章（原始下标，含卷节点的那套编号）。 */
  currentChapterIndex: number;
  /**
   * 直接定章：首次定位与 `jumpTo` 用。会先调 `onChapterDecided`，再写 state。
   * 不清待落盘偏移——那是调用方的事（`jumpTo` 自己清 `pendingOffsetRef`）。
   */
  setCurrentChapterIndex: (index: number) => void;
  /** 已提交的章内字符偏移（需求 2.1）。读者移动的最近一帧可能还在 `pendingOffsetRef` 里。 */
  charOffset: number;
  /** 直接定偏移：首次定位与 `jumpTo` 用。 */
  setCharOffset: React.Dispatch<React.SetStateAction<number>>;
  /** `toc.chapters[currentChapterIndex]`；目录未到位时为 undefined。 */
  currentChapter: ChapterMeta | undefined;
  /** `(chapter.start + charOffset) / charCount` 的百分比，顶栏显示与落盘写的是同一个数（需求 12.7）。 */
  progressPercent: number;
  /**
   * 读者移动算出、尚未提交成 state 的章内偏移；`null` = 没有未消费的结果。
   *
   * 提交成 state 后、换章时都会置回 null，卸载补写正是靠这个空值判断有没有漏掉的位置。
   * 暴露出来是因为 `jumpTo` 换章时要把它就地作废。
   */
  pendingOffsetRef: React.MutableRefObject<number | null>;
  /**
   * 视图在读者移动后上报位置（design §3.2）。
   *
   * - 换章：立即提交章号与偏移，清空待落盘偏移与防抖。目录高亮、滑杆、书签状态、`?ch=` 写回
   *   都由已有的依赖链随之更新（需求 3.10、10.5）。
   * - 同章：只更新待落盘偏移并重排 1 秒防抖，到时提交成 state 并落盘（需求 12.6）。
   *
   * identity 稳定。
   */
  reportPosition: (chapterId: number, offset: number) => void;
  /**
   * 立刻把待落盘偏移提交成 state（随后由落盘 effect 写盘），没有则什么也不做。
   * 防抖到期时调它；切换渲染族前也要先调它（design §3.1）。identity 稳定。
   */
  commitPendingOffset: () => void;
  /**
   * 读者此刻所在的章内偏移，**含尚未提交成 state 的那一帧**（需求 12.5，design §3.4）。
   * 只读不清。滚动视图的 `bookmarkOffset()` 返回它。
   */
  liveCharOffset: () => number;
  /**
   * 卸载补写：清掉防抖，把还没提交的偏移直接写盘（不经 state）。
   * 本 hook 卸载时自己会调一次；暴露出来供需要提前补写的场合使用。identity 稳定。
   */
  flushProgress: () => void;
}

export function useReadingPosition({
  bookId,
  toc,
  positionedBook,
  onChapterDecided,
}: ReadingPositionOptions): ReadingPosition {
  const [currentChapterIndex, setChapterState] = useState<number>(0);
  /**
   * **最近一次决定的**当前章号：每次经 `setCurrentChapterIndex` 定章都先写这里再写 state，
   * 于是它要么等于 `currentChapterIndex`，要么领先它一次提交。
   *
   * `reportPosition` 用它判断"是不是换章"：连着两次上报落在 state 提交之前时，第二次读到的
   * 是第一次刚决定的章，而不是渲染闭包里那个还没跟上的旧章。
   */
  const decidedChapterRef = useRef(0);

  /**
   * 当前位置的章内字符偏移（需求 2.1）。与 `currentChapterIndex` 一起构成阅读位置的
   * 唯一真相：谁移动了位置就改这两个 state（章节导航、`?ch=` 跳转、进度恢复、视图上报），
   * 落盘则统一由下面那个 effect 负责，因此不会有两条路径写出互相矛盾的记录。
   *
   * 同章移动**不立即进** state：上报只更新 `pendingOffsetRef`，停止变化 1 秒后才提交一次，
   * 所以连续滚动期间零渲染。
   *
   * 它表示"读者在哪"，**不**表示"该把视口移到哪"——后者是一次性的导航指令。两者分开，
   * 才使改字号时重新测量不会顺手把读者拽回打开时的位置。
   */
  const [charOffset, setCharOffset] = useState<number>(0);

  /** 见 `ReadingPosition.pendingOffsetRef`。 */
  const pendingOffsetRef = useRef<number | null>(null);

  /** "停止变化 1 秒"的防抖句柄。每次同章上报重排，换章、卸载与提交时清掉。 */
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** `onChapterDecided` 的最新值；在 layout 时段刷新，早于任何事件回调。 */
  const onChapterDecidedRef = useRef(onChapterDecided);
  useLayoutEffect(() => {
    onChapterDecidedRef.current = onChapterDecided;
  });

  const currentChapter: ChapterMeta | undefined = toc?.chapters[currentChapterIndex];

  const setCurrentChapterIndex = useCallback((index: number) => {
    onChapterDecidedRef.current?.(index);
    decidedChapterRef.current = index;
    setChapterState(index);
  }, []);

  /**
   * 把待落盘偏移提交成 state，随后由落盘 effect 写盘。
   *
   * 提交前把 `pendingOffsetRef` 置空，于是"已消费"这件事只有一个表示。偏移与当前 state
   * 相同时 React 自行 bail out，不重渲染也不落盘——在同一段内来回小幅滚动因此完全免费。
   */
  const commitPendingOffset = useCallback(() => {
    const pending = pendingOffsetRef.current;
    if (pending === null) return;
    pendingOffsetRef.current = null;
    setCharOffset(pending);
  }, []);

  const reportPosition = useCallback(
    (chapterId: number, offset: number) => {
      if (chapterId !== decidedChapterRef.current) {
        // 换章立即提交。旧章的待落盘偏移就地作废：每书只有一条进度记录，新章这次落盘会
        // 覆盖它；留着反而可能被随后到期的防抖带进新章。
        if (saveTimerRef.current !== null) {
          clearTimeout(saveTimerRef.current);
          saveTimerRef.current = null;
        }
        pendingOffsetRef.current = null;
        setCurrentChapterIndex(chapterId);
        setCharOffset(offset);
        return;
      }

      pendingOffsetRef.current = offset;
      // 停止变化 1 秒后落盘（需求 12.6）。每次上报都重排：要保存的是"最后一次上报的那个
      // 位置"，所以定时器与偏移在同一处更新。
      if (saveTimerRef.current !== null) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        saveTimerRef.current = null;
        commitPendingOffset();
      }, SAVE_DEBOUNCE_MS);
    },
    [setCurrentChapterIndex, commitPendingOffset]
  );

  /**
   * 当前位置的阅读百分比：`(chapter.start + charOffset) / charCount`（需求 12.7）。
   *
   * 顶栏显示与落盘写入的是同一个数，两处口径不可能漂移。同一本书的章长可以相差几个数量级，
   * 所以不用章号比例。
   */
  const progressPercent = useMemo(() => {
    if (!toc || !currentChapter) return 0;
    return progressPercentAt(currentChapter.start + charOffset, toc.charCount);
  }, [toc, currentChapter, charOffset]);

  /**
   * 写一条进度记录（design §2.3）。
   *
   * `offset` 显式传入而不是直接读 `charOffset`：卸载补写要写的是尚未提交成 state 的那个
   * 待落盘偏移，那时 state 已经不会再更新了。
   *
   * 条数上限与淘汰由 `saveBookProgress` 负责，这里不管。
   */
  const writeProgress = useCallback(
    (offset: number) => {
      if (!bookId || !currentChapter || !toc) return;
      saveBookProgress({
        bookId,
        chapterId: currentChapter.id,
        chapterTitle: currentChapter.title,
        charOffset: offset,
        // 保存时就算好，书架因此无需为了显示百分比去加载 toc（design §2.3）
        progressPercent: progressPercentAt(currentChapter.start + offset, toc.charCount),
        lastReadTime: Date.now(),
        v: 2,
      });
    },
    [bookId, currentChapter, toc]
  );

  // 位置变化即落盘：防抖到期后的提交走这里，章节切换也走这里——短章节读者可能一次都没移动过，
  // 但"上次读到哪一章"仍必须进书架。
  //
  // `positionedBook` 是闸门（见其选项说明）：初始位置还没解析出来时一个字也不写，免得把
  // 待恢复的记录覆盖成"第 0 章 / 章首"。
  useEffect(() => {
    if (positionedBook !== bookId) return;
    writeProgress(charOffset);
  }, [positionedBook, bookId, charOffset, writeProgress]);

  /**
   * 卸载补写用的镜像。每次渲染刷新，因此闭包里的章与偏移永远是最新的，
   * 而下面那个 effect 的 deps 可以是 `[]`（只想在卸载时跑一次）。
   */
  const flushProgressRef = useRef<() => void>(() => {});
  useEffect(() => {
    flushProgressRef.current = () => {
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      const pending = pendingOffsetRef.current;
      pendingOffsetRef.current = null;
      // 没有未消费的移动结果，或它与已落盘的偏移相同 → 落盘 effect 已经写过了
      if (pending === null || pending === charOffset) return;
      if (positionedBook !== bookId) return;
      writeProgress(pending);
    };
  });

  // 离开阅读器（返回书架 / 切到另一本书）时补写：防抖那 1 秒不该让读者丢掉最后一屏的位置。
  //
  // 换章不需要补写：换章时待落盘偏移已被清空（`reportPosition`、`jumpTo`、段落集合变化），
  // 而每书只有一条记录，旧章的偏移写出去也会立刻被新章那次落盘覆盖。
  useEffect(() => () => flushProgressRef.current(), []);

  const flushProgress = useCallback(() => flushProgressRef.current(), []);

  /**
   * 读者此刻所在的章内偏移，**含尚未提交成 state 的那一帧**（需求 12.5）。
   *
   * 同章移动要等"停止变化 1 秒"才进 `charOffset`，而按书签这个动作往往紧跟在滚动之后——
   * 那一秒里 state 还是上一次提交的旧位置，直接读它会把书签存到读者刚刚划过的某一段上。
   * 卸载补写是同一个道理（`flushProgressRef`）。
   *
   * 只读不清：清空 `pendingOffsetRef` 是防抖提交与换章的职责，这里顺手清掉会让本该落盘的
   * 那次进度更新丢一拍。
   */
  const liveCharOffset = useCallback((): number => {
    const pending = pendingOffsetRef.current;
    return pending === null ? charOffset : pending;
  }, [charOffset]);

  return {
    currentChapterIndex,
    setCurrentChapterIndex,
    charOffset,
    setCharOffset,
    currentChapter,
    progressPercent,
    pendingOffsetRef,
    reportPosition,
    commitPendingOffset,
    liveCharOffset,
    flushProgress,
  };
}
