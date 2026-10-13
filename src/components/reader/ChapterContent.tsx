/**
 * 章节标题区与正文（design §1.1、§4.2、§4.4、§7.1）。
 *
 * 分页视图（测量与显示）与连续滚动视图共用这一个组件，三种变体：
 *
 * | 变体 | 用途 | 正文 | 检索高亮 | 过渡动画 |
 * | --- | --- | --- | --- | --- |
 * | `measure` | `usePaginator` 的离屏 `MeasureBox` | 整章，每段恰好一个文本节点 | 无 | 无 |
 * | `scroll` | `ScrollReader` 的每个章节区段 | 整章 | `resolveHighlight` | 有 |
 * | `page` | `PagedReader` 的页面图层 | `pageView` 给出的页片段 | `fragmentHighlight` | 仅颜色 |
 *
 * **三种变体共用同一套排版类名与行内样式**：`<article>` 的版心宽、字体、字号、行高、字间距，
 * 标题区的类名，正文容器的 `space-y-6 text-justify`，段落的 `indent-[2em] wrap-anywhere`。
 * 分页靠"测量版式 = 显示版式"成立（design §4.3），任何一处类名或样式只改了一个变体，
 * 页内的行就会与页表对不上，表现为页底多出半行或少一行。类名因此集中在下方常量里。
 *
 * 标记与类名沿用 `ReaderPage` 原内联渲染的写法（`<article>` / `<header>` / `<h1>` /
 * "第 N / M 章" / `<p>` / `<mark>`），e2e 的定位器（`getByRole("article")`、一级标题、
 * `/^第 \d+ \/ \d+ 章$/`、`getByRole("paragraph")`、`<mark>`）与像素基线在视图改用本组件后
 * 依旧有效。
 *
 * 正文始终是普通 DOM 文本（D6），可选择、可复制（需求 2.10）；页片段也只是把段落文本切开，
 * 不引入任何替身节点。
 *
 * ### 段落上的数据属性
 *
 * 每个 `<p>` 带两个只读的数据属性，供测量与定位直接查询，不必另挂一组 ref：
 *
 * - `data-para`：该段在 `bodyParas` 中的下标（与 `ParaHighlight.paraIndex`、
 *   `PageFragment.para`、`LineBox.block` 同一坐标）。`usePaginator` 按它把行盒归到段，
 *   `ScrollReader` 按它测 `paraTops` 供 `locateAt` 使用（design §4.2、§7.3、§7.4）。
 * - `data-offset`：该 `<p>` 首字的**章内偏移**。整段渲染时等于 `para.offset`；页片段渲染时
 *   等于 `fragment.from`（续段即页界处的那个偏移）。
 *
 * 标题区不是段落，没有这两个属性；测量时按 `<article>` 下的 `<header>` 子元素取（design §4.2 第 1 步）。
 */

import { memo, type CSSProperties, type ReactNode, type Ref } from "react";
import type { ReaderSettings } from "../../types";
import { resolveHighlight, type Para } from "../../utils/locator";
import { fragmentHighlight, type PageFragment, type PageView } from "../../utils/paginate";
import type { HighlightTarget } from "./types";

/** 决定正文版式的五项排版设置（需求 2.5 的排版输入，`layoutKey` 的组成部分）。 */
export type ChapterTypography = Pick<
  ReaderSettings,
  "contentWidth" | "fontFamily" | "fontSize" | "lineHeight" | "letterSpacing"
>;

/** 渲染一章所需的数据。调用方按章算好传入（滚动视图窗口内每章一份）。 */
export interface ChapterContentChapter {
  /** `toc.chapters[]` 的原始下标，与 `HighlightTarget.chapterId` 同一坐标。 */
  chapterId: number;
  /** 章节标题（`<h1>`）。 */
  title: string;
  /** 本章字数，显示在"第 N / M 章"之后。 */
  length: number;
  /** 正文序号（0 起，卷节点不计入），显示为"第 position + 1 / total 章"（需求 10.1）。 */
  position: number;
  /** 正文章节总数（卷节点不计入）。 */
  total: number;
  /**
   * 本章的 **`bodyParas`**（已跳过与标题重复的首段）。`page` 变体的 `view` 必须由同一份
   * 数组经 `pageView` 得出，`fragment.para` 才能直接当下标用。
   */
  paras: readonly Para[];
}

interface CommonProps {
  chapter: ChapterContentChapter;
  typography: ChapterTypography;
  /** 挂到 `<article>` 上，供视图观察尺寸或取测量根节点。 */
  articleRef?: Ref<HTMLElement>;
}

/** 离屏测量用：不渲染 `<mark>`、每段一个文本节点、无过渡（design §4.2）。 */
export interface MeasureChapterContentProps extends CommonProps {
  variant: "measure";
}

/** 连续滚动视图的一章：整章正文，高亮按 `resolveHighlight`（design §7.1）。 */
export interface ScrollChapterContentProps extends CommonProps {
  variant: "scroll";
  /** 不属于本章（`chapterId` 不同）的高亮直接忽略，调用方可以把同一条高亮传给每个区段。 */
  highlight: HighlightTarget | null;
}

/** 分页视图的一页：按 `pageView` 的片段渲染，高亮按 `fragmentHighlight`（design §4.4）。 */
export interface PageChapterContentProps extends CommonProps {
  variant: "page";
  /** `pageView(chapter.paras, table.starts, k)` 的结果。 */
  view: PageView;
  /** 同 `scroll` 变体：不属于本章的高亮直接忽略。命中被页界拆开时，两页各标自己那一截（需求 12.3）。 */
  highlight: HighlightTarget | null;
}

export type ChapterContentProps =
  | MeasureChapterContentProps
  | ScrollChapterContentProps
  | PageChapterContentProps;

// ───────────────────────────── 共享排版 ─────────────────────────────

/**
 * `<article>` 的版心与排版类名。`mx-auto` 配合行内 `maxWidth` 让版心水平居中（需求 2.1）。
 *
 * 版心宽、字号等设置变化时的 150ms 过渡只给 `scroll` 变体：`measure` 若带过渡会测到中间态；
 * `page` 若带过渡，这 150ms 里页内文字按中间字号排版，与刚算好的新页表对不上，页底会露出
 * 被裁掉的半行（需求 2.3）。过渡不改变静止时的版式，三种变体的终态版式完全一致。
 */
const ARTICLE_CLASS = "mx-auto";
const ARTICLE_TRANSITION_CLASS = "mx-auto transition-all duration-150";

/** 标题区（需求 2.2、10.1）。`text-xl` / `sm:text-2xl` / `text-xs` 各自声明行高，不受正文行高影响。 */
const HEADER_CLASS = "mb-10 pt-4 pb-6 border-b border-[var(--border)]";
const HEADING_CLASS = "text-xl sm:text-2xl font-bold tracking-tight mb-2";
const HEADER_META_CLASS = "flex items-center text-xs text-[var(--text-muted)] space-x-3";

/** 正文容器：段间距与两端对齐。 */
const BODY_CLASS = "space-y-6 text-justify";

/**
 * 段落。不设 `leading-*`：行高继承 `<article>` 行内的无单位 `lineHeight`，计算值即
 * "字号 × 行高"。`wrap-anywhere` 让没有断行机会的长串在版心内折行，且不把版心撑宽。
 *
 * `transition-colors` 只影响颜色（切主题时淡入），不改变任何几何量；`measure` 变体照样去掉，
 * 保证测量节点上没有任何进行中的过渡。
 */
const PARA_CLASS = "indent-[2em] wrap-anywhere select-text";
const PARA_TRANSITION_CLASS = "indent-[2em] wrap-anywhere transition-colors select-text";

/**
 * 检索高亮。只改底色与字色，不动内边距与字重：那些会改变字符宽度，进而可能改变本段的
 * 折行与高度，让已测好的段落几何（滚动视图的 `paraTops`、分页视图的页表）就地失真。
 * 字色取 `--text` 而非 `--accent`：琥珀底上强调色在四套主题下不足 4.5:1；底色 30% 时
 * 五套主题均 ≥ 4.63:1。
 */
const MARK_CLASS = "animate-fade-in rounded bg-[rgba(234,179,8,0.3)] text-[var(--text)]";

/** 续段（`continued`）：从原段某一行的行首开始，不再缩进（design §4.3）。 */
const CONTINUED_STYLE: CSSProperties = { textIndent: 0 };
/** 被页界截断的前段（`continues`）：末行在原段里是中间行，照原样两端对齐（design §4.3）。 */
const CONTINUES_STYLE: CSSProperties = { textAlignLast: "justify" };
/** 一段长到跨过整页时，两端都被截断。 */
const CONTINUED_CONTINUES_STYLE: CSSProperties = { ...CONTINUED_STYLE, ...CONTINUES_STYLE };

/** 字体设置 → `font-family` 字体栈。未知取值按系统字体处理。 */
function fontFamilyStack(family: ReaderSettings["fontFamily"]): string {
  switch (family) {
    case "serif":
      return "'Source Han Serif SC', 'Noto Serif SC', 'Songti SC', 'SimSun', serif";
    case "kaiti":
      return "'KaiTi', 'STKaiti', '楷体', serif";
    case "system":
    default:
      return "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei', sans-serif";
  }
}

/** `<article>` 的行内排版样式，三种变体共用（需求 2.1 的版心宽度）。 */
function articleStyle(typography: ChapterTypography): CSSProperties {
  return {
    maxWidth: `${typography.contentWidth}px`,
    fontFamily: fontFamilyStack(typography.fontFamily),
    fontSize: `${typography.fontSize}px`,
    lineHeight: typography.lineHeight,
    letterSpacing: `${typography.letterSpacing}px`,
  };
}

function fragmentStyle(fragment: PageFragment): CSSProperties | undefined {
  if (fragment.continued) return fragment.continues ? CONTINUED_CONTINUES_STYLE : CONTINUED_STYLE;
  return fragment.continues ? CONTINUES_STYLE : undefined;
}

/**
 * 把 `text` 的 `[from, to)` 包进 `<mark>`，前后两截保持为普通文本。
 *
 * 高亮是渲染的一部分，不做 DOM 手术：换章、翻页、改字号、清除高亮都只是重新渲染。
 */
function withMark(text: string, from: number, to: number): ReactNode {
  return (
    <>
      {text.slice(0, from)}
      <mark className={MARK_CLASS}>{text.slice(from, to)}</mark>
      {text.slice(to)}
    </>
  );
}

/** 只认本章的高亮；别的章的高亮（或没有高亮）一律为 `null`。 */
function ownHighlight(highlight: HighlightTarget | null, chapterId: number): HighlightTarget | null {
  return highlight && highlight.chapterId === chapterId ? highlight : null;
}

// ───────────────────────────── 组成部分 ─────────────────────────────

/** 标题区：章节标题与"第 N / M 章 · K 字"（需求 2.2、10.1）。 */
function ChapterHeader({ chapter }: { chapter: ChapterContentChapter }) {
  return (
    <header className={HEADER_CLASS}>
      <h1 className={HEADING_CLASS}>{chapter.title}</h1>
      <div className={HEADER_META_CLASS}>
        {/* 正文序号，卷节点不计入 */}
        <span>
          第 {chapter.position + 1} / {chapter.total} 章
        </span>
        <span>·</span>
        <span>{chapter.length} 字</span>
      </div>
    </header>
  );
}

/** 整章正文（`measure` / `scroll`）。key 用章内偏移：章内唯一且稳定，不用下标。 */
function WholeChapterBody({
  paras,
  paraClass,
  highlight,
}: {
  paras: readonly Para[];
  paraClass: string;
  highlight: HighlightTarget | null;
}) {
  // 命中落在被跳过的标题行、段间空白，或长度非正时为 null：位置照跳，只是不标
  const hit = highlight ? resolveHighlight(paras, highlight.charOffset, highlight.length) : null;
  return (
    <div className={BODY_CLASS}>
      {paras.map((para, index) => (
        <p key={para.offset} data-para={index} data-offset={para.offset} className={paraClass}>
          {hit && hit.paraIndex === index
            ? withMark(para.text, hit.offsetInPara, hit.offsetInPara + hit.length)
            : para.text}
        </p>
      ))}
    </div>
  );
}

/** 一页的正文片段（`page`）。key 用片段起点的章内偏移，页内唯一。 */
function PageBody({
  paras,
  view,
  highlight,
}: {
  paras: readonly Para[];
  view: PageView;
  highlight: HighlightTarget | null;
}) {
  return (
    <div className={BODY_CLASS}>
      {view.fragments.map((fragment) => {
        const para = paras[fragment.para];
        // 契约要求 view 与 paras 同源；万一错配，宁可少渲染一段，也不让整个阅读区崩掉
        if (!para) return null;
        const text = para.text.slice(fragment.from - para.offset, fragment.to - para.offset);
        // 返回章内偏移；减去 fragment.from 得片段文本内的下标
        const mark = highlight ? fragmentHighlight(paras, fragment, highlight) : null;
        return (
          <p
            key={fragment.from}
            data-para={fragment.para}
            data-offset={fragment.from}
            className={PARA_TRANSITION_CLASS}
            style={fragmentStyle(fragment)}
          >
            {mark ? withMark(text, mark.from - fragment.from, mark.to - fragment.from) : text}
          </p>
        );
      })}
    </div>
  );
}

// ───────────────────────────── 组件 ─────────────────────────────

/**
 * 一章（或一章中的一页）的标题区与正文。见模块注释的变体表。
 *
 * `memo`：滚动视图窗口变化、分页视图开始或结束一次翻页时，未变的章节与页面不必重渲染。
 * 调用方应让 `chapter`、`typography`、`view` 保持引用稳定（`useMemo`）。
 */
export const ChapterContent = memo(function ChapterContent(props: ChapterContentProps) {
  const { chapter, typography, articleRef } = props;

  let header = true;
  let body: ReactNode;
  switch (props.variant) {
    case "measure":
      body = <WholeChapterBody paras={chapter.paras} paraClass={PARA_CLASS} highlight={null} />;
      break;
    case "scroll":
      body = (
        <WholeChapterBody
          paras={chapter.paras}
          paraClass={PARA_TRANSITION_CLASS}
          highlight={ownHighlight(props.highlight, chapter.chapterId)}
        />
      );
      break;
    case "page":
      // 标题区只在本章第 1 页（需求 2.2）
      header = props.view.header;
      body = (
        <PageBody
          paras={chapter.paras}
          view={props.view}
          highlight={ownHighlight(props.highlight, chapter.chapterId)}
        />
      );
      break;
  }

  return (
    <article
      ref={articleRef}
      className={props.variant === "scroll" ? ARTICLE_TRANSITION_CLASS : ARTICLE_CLASS}
      style={articleStyle(typography)}
    >
      {header && <ChapterHeader chapter={chapter} />}
      {body}
    </article>
  );
});
