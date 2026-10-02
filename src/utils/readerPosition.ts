/**
 * 阅读器的首次定位（需求 7.5–7.7，RC 12.5；design §6）。
 *
 * 输入是三样东西：章节表的双视图、URL 上的章号（已经 `parseUrlChapter` 判过有效性）、
 * 已存的阅读进度。输出唯一的（章号, 章内偏移）。规则：
 *
 * - 进度**有效**当且仅当 `saved.chapterId < chapterCount`（下界由 `readProgress` 夹过）。
 *   有效进度的章号经 `resolveContentChapter` 归一为 `savedChapter`；归一改了章号（进度停在
 *   卷节点上）时偏移作废为 0——它是另一章里的位置。
 * - URL 章号不为 `null`：章号 = `resolveContentChapter(views, urlChapter)`。当进度有效、进度
 *   章号本身是正文章节（未经归一改变）且等于该章号时，恢复进度的偏移（D3）；否则章首（7.6，
 *   EV 9.12 按 D11 只覆盖"另一章"）。
 * - URL 章号为 `null`：进度有效时取（`savedChapter`, 归一后的偏移）；否则（第一个正文章节, 0）。
 *
 * D2 之后 URL 总带着当前章，重载时 URL 章号与进度章号相同，于是走 D3 那一支恢复章内位置，
 * 不会每次重载都回到章首（H3）。
 */

import { ChapterViews, JumpTarget, NO_CONTENT_CHAPTER, resolveContentChapter } from "./locator";

/** 首次定位关心的进度字段。`ReadingProgress`（`getBookProgress` 的返回值）结构上即满足。 */
export interface SavedPosition {
  readonly chapterId: number;
  readonly charOffset: number;
}

/** 首次定位（7.5–7.7，RC 12.5）。没有正文章节时返回 null（由错误页接手）。 */
export function initialPosition(
  views: ChapterViews,
  chapterCount: number,
  urlChapter: number | null,
  saved: SavedPosition | null,
): JumpTarget | null {
  // 全由卷节点构成（或空表）：无章可定位，交给错误页（需求 12.6）
  if (views.contentIdx.length === 0) return null;

  // 章号越界（章节表被重切过、记录被手改）的进度视同缺省（design §10）
  const validSaved = saved !== null && saved.chapterId < chapterCount ? saved : null;
  const savedChapter =
    validSaved === null ? NO_CONTENT_CHAPTER : resolveContentChapter(views, validSaved.chapterId);
  /** 进度章号本身就是正文章节（未经卷节点归一改变）。 */
  const savedIsExact = validSaved !== null && savedChapter === validSaved.chapterId;

  if (urlChapter !== null) {
    const chapterId = resolveContentChapter(views, urlChapter);
    // D3：URL 所指章节就是进度所在章 → 恢复章内偏移；否则章首（7.6）
    const charOffset = savedIsExact && chapterId === validSaved.chapterId ? validSaved.charOffset : 0;
    return { chapterId, charOffset };
  }

  if (validSaved !== null) {
    return { chapterId: savedChapter, charOffset: savedIsExact ? validSaved.charOffset : 0 };
  }

  // 没有进度或进度越界：第一个正文章节的章首（RC 12.5）
  return { chapterId: views.contentIdx[0], charOffset: 0 };
}
