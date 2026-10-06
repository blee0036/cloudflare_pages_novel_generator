import React from "react";
import { ChevronRight, Clock } from "lucide-react";
import { RecentRead, formatRelativeTime } from "../utils/recentReads";

interface RecentReadsProps {
  /** 已连接过书目并截到 5 条的行（`buildRecentReads()` 的产物）。 */
  items: RecentRead[];
  /**
   * 续读入口。实现必须导航到**不带 `?ch=`** 的 `/read/<id>`，理由见下方 JSX 处的注释。
   */
  onResume: (bookId: string) => void;
}

/**
 * 书架首屏的"最近阅读"区块（需求 5.10，差异表 B5）。
 *
 * ## 无记录时整块不渲染
 *
 * 需求 5.10 后半句是硬要求，这里直接 `return null`——不是渲染一个"还没有阅读记录"的空态。
 * 新访客的首屏不该先看到一块空壳；而区块一旦读过一本书就会自己出现，空态要传达的信息
 * （"这里将来会有东西"）没有价值。
 *
 * ## 续读入口为什么不带章号
 *
 * 阅读器在 URL **没有** `?ch=` 时才会去读进度记录并恢复到章内偏移（任务 36 的定位 effect）；
 * `?ch=N` 被它当作"显式的整章跳转"，会把 `charOffset` 归零、落在章首。也就是说带上章号
 * 恰好丢掉记录里最值钱的那半截位置。所以本区块的入口一律是裸 `/read/<id>`——
 * 书架上"章节目录"弹窗里点具体某章才用 `?ch=`，两者的语义不同。
 *
 * ## 时间在渲染时格式化
 *
 * 行数据里存的是原始 `lastReadTime`，文案由 `formatRelativeTime()` 在每次渲染时算。
 * 书架是个短命页面，不为"分钟数自己往上跳"再挂一个定时器：那要么每分钟唤醒一次全页重渲染，
 * 要么写一套只为这 5 行服务的订阅，而读者真正在意的"哪本最近读过"由排序而非文案表达。
 */
export const RecentReads: React.FC<RecentReadsProps> = ({ items, onResume }) => {
  if (items.length === 0) return null;

  return (
    <section aria-labelledby="recent-reads-heading" className="mb-8">
      <div className="flex items-baseline justify-between mb-3">
        <h2
          id="recent-reads-heading"
          className="text-sm font-bold tracking-tight flex items-center"
        >
          <Clock className="w-4 h-4 mr-1.5 text-[var(--accent)]" />
          最近阅读
        </h2>
        <span className="text-[11px] text-[var(--text-muted)]">{items.length} 本在读</span>
      </div>

      <ul className="rounded-2xl bg-[var(--card-bg)] border border-[var(--border)] divide-y divide-[var(--border)] overflow-hidden shadow-sm">
        {items.map((item) => {
          const when = formatRelativeTime(item.lastReadTime);

          return (
            <li key={item.bookId}>
              {/* 整行可点，而不是只把右端那枚"续读"做成按钮：行内没有第二个动作，
                  多留一片不可点的区域只会让人点了没反应。
                  焦点圈用 `outline` 加**负 offset** 画在元素内侧——`ul` 有
                  `overflow-hidden`（圆角要裁掉分隔线的两端），画在外侧的 `ring` 会被
                  裁掉上下两行的那一半。 */}
              <button
                type="button"
                onClick={() => onResume(item.bookId)}
                aria-label={`继续阅读《${item.title}》，上次读到 ${item.chapterTitle}`}
                className="w-full px-4 py-3 flex items-center gap-3 text-left hover:bg-[var(--hover)] focus:outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--accent)] transition-colors"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-semibold truncate">{item.title}</span>
                    {/* 作者跟着书名走：7000 本里同名书不罕见（A18），少了它两行可能长得一样 */}
                    <span className="text-[11px] text-[var(--text-muted)] shrink-0 max-w-[7rem] truncate">
                      {item.author}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
                    <span className="truncate">{item.chapterTitle}</span>
                    {/* 时间戳坏掉时 `formatRelativeTime` 给空串，此时连分隔点一起不渲染，
                        免得出现一个后面没有东西的"·" */}
                    {when && (
                      <>
                        <span aria-hidden="true">·</span>
                        <time
                          dateTime={new Date(item.lastReadTime).toISOString()}
                          className="shrink-0"
                        >
                          {when}
                        </time>
                      </>
                    )}
                  </div>
                </div>

                <span
                  aria-hidden="true"
                  className="shrink-0 flex items-center text-[11px] font-semibold text-[var(--accent)]"
                >
                  续读
                  <ChevronRight className="w-3.5 h-3.5" />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
};
