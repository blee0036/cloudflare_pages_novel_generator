import { useCallback, useEffect, useState } from "react";
import type { TurnDirection } from "../components/reader/types";
import { NOTICE_IDLE, noticeStep, type NoticeState } from "../utils/turnInput";

/**
 * 边界提示的状态与到期定时器（design §6.9，需求 3.5–3.7、10.14、10.15）。
 *
 * 由 `ReaderPage` 调用，状态因此挂在阅读器页面上：两种视图（`ScrollReader`、`PagedReader`）
 * 共用同一条提示，切换翻页模式时提示不会因视图重挂而丢失或重复。
 *
 * 显示与去重的规则全在纯函数 `noticeStep` 里（Property 8）：提示可见时再次 `hit` 原样返回，
 * 所以视图可以放心地每次撞边界都报一次（拖拽冻结期间每步都会报），屏幕上始终至多一条
 * （需求 3.7）。这里只做两件 `noticeStep` 不管的事：取时间、按 `until` 安排一次 `tick`。
 *
 * 时间取 `performance.now()`：单调时钟，不受系统改时间影响，与 `noticeStep` 要求的
 * "同一时钟"一致。
 */
export interface BoundaryNoticeApi {
  /** 当前提示文字；`null` 表示没有提示。交给 `<BoundaryNotice text>`。 */
  text: string | null;
  /**
   * 请求的方向上没有可翻的页。identity 恒定，可直接作为视图的 `onBoundary` prop
   * （`ReaderViewProps.onBoundary`），不会让视图的 effect 因它重跑。
   */
  onBoundary: (direction: TurnDirection) => void;
}

export function useBoundaryNotice(): BoundaryNoticeApi {
  const [notice, setNotice] = useState<NoticeState>(NOTICE_IDLE);

  const onBoundary = useCallback((direction: TurnDirection) => {
    const t = performance.now();
    // `noticeStep` 在状态不变时返回同一个对象，React 据此跳过这次渲染
    setNotice((prev) => noticeStep(prev, { kind: "hit", direction, t }));
  }, []);

  /**
   * 到期清除：每出现一条新提示（`notice` 换了对象）就按它的 `until` 排一次 `tick`。
   *
   * 可见期间的重复 `hit` 不产生新对象，所以不会重排定时器、不会延长显示时间——与
   * `noticeStep` 的"文字与到期时刻都不变"一致。卸载、或被新提示取代时清掉旧定时器。
   *
   * `tick` 的时刻取 `max(now, until)`：定时器就是按 `until` 排的，到点即到期。若直接用
   * `now`，计时器与 `performance.now()` 之间的亚毫秒取整可能让它恰好早于 `until`，
   * `noticeStep` 判为未到期而原样返回，本 effect 也就不会再跑，提示会一直挂着。
   */
  useEffect(() => {
    if (notice.text === null) return;
    const { until } = notice;
    const timer = setTimeout(
      () => {
        const t = Math.max(performance.now(), until);
        setNotice((prev) => noticeStep(prev, { kind: "tick", t }));
      },
      Math.max(0, until - performance.now()),
    );
    return () => clearTimeout(timer);
  }, [notice]);

  return { text: notice.text, onBoundary };
}
