import { describe, expect, it } from "vitest";
import { BookSummary, ReadingProgress } from "../types";
import {
  RECENT_READS_LIMIT,
  UNKNOWN_CHAPTER_TITLE,
  buildRecentReads,
  formatRelativeTime,
} from "./recentReads";

function book(id: string, title = id, author = "某作者"): BookSummary {
  return { id, title, author, charCount: 1000, totalChapters: 10, gzSize: 2048 };
}

function progress(
  bookId: string,
  lastReadTime: number,
  chapterTitle = `${bookId} 的第一章`,
): ReadingProgress {
  return {
    bookId,
    chapterId: 3,
    chapterTitle,
    charOffset: 120,
    progressPercent: 12.5,
    lastReadTime,
    v: 2,
  };
}

/** 本地时区的某一刻，作为所有时间断言的"现在"。 */
const NOW = new Date(2026, 8, 24, 10, 30, 0).getTime();

/** n 天前的同一时刻（按本地日历日回退，交给 Date 处理跨月）。 */
function daysAgo(n: number, hour = 10, minute = 30): number {
  return new Date(2026, 8, 24 - n, hour, minute, 0).getTime();
}

describe("buildRecentReads", () => {
  const books = [book("甲"), book("乙"), book("丙")];

  it("把书名与作者从书目连接到进度记录上（记录里没有这两个字段）", () => {
    const rows = buildRecentReads(
      [progress("甲", 1000)],
      [book("甲", "青石巷", "夜行")],
    );

    expect(rows).toEqual([
      {
        bookId: "甲",
        title: "青石巷",
        author: "夜行",
        chapterTitle: "甲 的第一章",
        lastReadTime: 1000,
      },
    ]);
  });

  it("按 lastReadTime 降序，最近读的在最前（不依赖入参已排好序）", () => {
    const rows = buildRecentReads(
      [progress("乙", 200), progress("丙", 300), progress("甲", 100)],
      books,
    );
    expect(rows.map((r) => r.bookId)).toEqual(["丙", "乙", "甲"]);
  });

  it("不修改传入的历史数组", () => {
    const history = [progress("乙", 200), progress("甲", 900)];
    const snapshot = [...history];
    buildRecentReads(history, books);
    expect(history).toEqual(snapshot);
  });

  it("最多 5 条（需求 5.10）", () => {
    expect(RECENT_READS_LIMIT).toBe(5);

    const many = Array.from({ length: 12 }, (_, i) => progress(`书${i}`, 1000 + i));
    const catalog = Array.from({ length: 12 }, (_, i) => book(`书${i}`));

    const rows = buildRecentReads(many, catalog);
    expect(rows).toHaveLength(5);
    // 最新的 5 条：lastReadTime 1011..1007
    expect(rows.map((r) => r.bookId)).toEqual(["书11", "书10", "书9", "书8", "书7"]);
  });

  it("书目里已没有的书不渲染，且不占用 5 个名额", () => {
    const history = [
      progress("已删A", 900),
      progress("甲", 800),
      progress("已删B", 700),
      progress("乙", 600),
      progress("已删C", 500),
      progress("丙", 400),
    ];

    const rows = buildRecentReads(history, books, 3);
    // 三条孤儿记录被丢掉，仍凑满 3 行，而不是只剩 1 行
    expect(rows.map((r) => r.bookId)).toEqual(["甲", "乙", "丙"]);
  });

  it("空历史 / 空书目 / 上限为 0 都得到空数组（区块随之不渲染）", () => {
    expect(buildRecentReads([], books)).toEqual([]);
    expect(buildRecentReads([progress("甲", 1)], [])).toEqual([]);
    expect(buildRecentReads([progress("甲", 1)], books, 0)).toEqual([]);
  });

  it("上限是脏值时按 0 处理，不会渲染出负数条或全部条目", () => {
    for (const limit of [-3, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(buildRecentReads([progress("甲", 1)], books, limit)).toEqual([]);
    }
  });

  it("章节名为空的记录用占位文案，不伪造章序号", () => {
    const rows = buildRecentReads([progress("甲", 1, "   ")], books);
    expect(rows[0].chapterTitle).toBe(UNKNOWN_CHAPTER_TITLE);
  });

  it("同一本书只出一行，避免重复的 React key", () => {
    const rows = buildRecentReads([progress("甲", 200), progress("甲", 100)], books);
    expect(rows).toHaveLength(1);
    expect(rows[0].lastReadTime).toBe(200);
  });
});

describe("formatRelativeTime", () => {
  it("一分钟内说『刚刚』", () => {
    expect(formatRelativeTime(NOW, NOW)).toBe("刚刚");
    expect(formatRelativeTime(NOW - 59_000, NOW)).toBe("刚刚");
  });

  it("时间戳在未来（宿主时钟被回调）也说『刚刚』，不出现负数档位", () => {
    expect(formatRelativeTime(NOW + 5 * 60_000, NOW)).toBe("刚刚");
    expect(formatRelativeTime(NOW + 40 * 24 * 3_600_000, NOW)).toBe("刚刚");
  });

  it("一小时内报分钟", () => {
    expect(formatRelativeTime(NOW - 60_000, NOW)).toBe("1 分钟前");
    expect(formatRelativeTime(NOW - 3 * 60_000, NOW)).toBe("3 分钟前");
    expect(formatRelativeTime(NOW - 59 * 60_000, NOW)).toBe("59 分钟前");
  });

  it("当天之内报小时", () => {
    expect(formatRelativeTime(NOW - 3_600_000, NOW)).toBe("1 小时前");
    expect(formatRelativeTime(NOW - 9 * 3_600_000, NOW)).toBe("9 小时前");
  });

  it("按日历日判定跨天，而不是按 24 小时", () => {
    // 今天 01:00 看昨天 22:00：只隔 3 小时，但那是昨天的事
    const earlyToday = new Date(2026, 8, 24, 1, 0, 0).getTime();
    const lastNight = new Date(2026, 8, 23, 22, 0, 0).getTime();
    expect(formatRelativeTime(lastNight, earlyToday)).toBe("昨天");

    // 反过来：跨午夜但只差 20 分钟，仍按分钟说，不跳成"昨天"
    const justAfterMidnight = new Date(2026, 8, 24, 0, 10, 0).getTime();
    const beforeMidnight = new Date(2026, 8, 23, 23, 50, 0).getTime();
    expect(formatRelativeTime(beforeMidnight, justAfterMidnight)).toBe("20 分钟前");
  });

  it("昨天 / 前天 / 一周内报天", () => {
    expect(formatRelativeTime(daysAgo(1), NOW)).toBe("昨天");
    expect(formatRelativeTime(daysAgo(2), NOW)).toBe("前天");
    expect(formatRelativeTime(daysAgo(3), NOW)).toBe("3 天前");
    expect(formatRelativeTime(daysAgo(6), NOW)).toBe("6 天前");
  });

  it("更久的记录逐级放粗：周 → 月 → 年", () => {
    expect(formatRelativeTime(daysAgo(7), NOW)).toBe("1 周前");
    expect(formatRelativeTime(daysAgo(29), NOW)).toBe("4 周前");
    expect(formatRelativeTime(daysAgo(30), NOW)).toBe("1 个月前");
    expect(formatRelativeTime(daysAgo(200), NOW)).toBe("6 个月前");
    expect(formatRelativeTime(daysAgo(400), NOW)).toBe("1 年前");
  });

  it("时间戳缺失或坏掉时给空串，交由调用方不渲染", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(formatRelativeTime(bad, NOW)).toBe("");
    }
  });

  it("档位随时间推移单调向粗，不出现回跳", () => {
    const seen = new Set<string>();
    let prevDays = -1;
    for (const days of [0, 1, 2, 3, 6, 7, 14, 30, 90, 365, 800]) {
      const label = formatRelativeTime(daysAgo(days), NOW);
      expect(label).not.toBe("");
      expect(days).toBeGreaterThan(prevDays);
      prevDays = days;
      seen.add(label);
    }
    // 11 个取样点落在 11 个不同的文案上：没有两个相邻档位撞成同一句
    expect(seen.size).toBe(11);
  });
});
