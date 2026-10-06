# -*- coding: utf-8 -*-
r"""章节识别与切分（design §4.4–§4.7，需求 8.1–8.9 / 8.14 / 8.15）。

本模块分四批落地，当前进度：

- **任务 17（已实现）**：按行扫描器 `iter_lines` / `scan`，规则择一评分 `score_rule` /
  `pick_rule`。
- **任务 18（已实现）**：`split_chapters` 切分与 `mark_volumes` 卷标记。
- **任务 19（已实现）**：`split_overlong` 逐章兜底与 `fallback_split` 全书兜底，
  两者共用同一个块切分原语 `_paragraph_blocks`（优先空行、退而换行）。
  `split_book` 是带"是否兜底"标志的出口，`split_chapters` 是只要章节表的便捷写法。
- **任务 20（已实现）**：`clean_title` / `normalize_title` 标题净化。接入点是 `split_book`
  的切分循环，`_title_line_end` 同步改用 `clean_title` 比对源行，见下面「净化与严格相等」。
- **篇幅门槛（已实现）**：`Coverage` / `coverage()`，接在 `score_rule`（采样尺度）与
  `split_book`（全书尺度，过滤之后）两处。见下面「篇幅门槛」那一节。
- **任务 21（已实现，不在本模块）**：本机覆盖表 `toc-overrides.local.json` 的人工覆盖落在
  `toc_overrides.py`——查表要读文件、要认 `book_id`，而本模块的评分器只认规则表与文本，
  保持纯函数好断言。
  编排层因此不再直接调 `pick_rule`，改调 `toc_overrides.pick_rule_for(text, book_id, overrides)`：
  命中覆盖就跳过自动判定（`RulePick.overridden=True`），未命中才落回 `pick_rule`。

`scan()` 产出的 `title` 是**行原文**（未 strip、未净化）；按 design §4.5 的流程，
`normalize_title(raw, index, prev)` 才是拿到最终标题的地方，`split_book` 在造章节时调用它。
净化**只动 `title` 字段**，`start`/`end` 一个字符都不动。

## 净化与严格相等（任务 20 的核心约束）

`_title_line_end`（继而 `body_length` / `mark_volumes` / `split_overlong`）要判断
"章节的第一行是不是它自己的标题行"，判据是**严格相等**；前端跳过重复首段用的是同一个
判据（design §3.2 的 `paras[0].text === chapter.title`）。净化会改写标题文本，于是这个
等式天然会失效——后果是 `body_length` 把整章都算成正文，方向是**少标卷**（安全，但错）。

这里不接受那个降级。解法是让净化**在源行上可证幂等**，并把比对从"源行 strip"改成
"源行净化"：

- `clean_title` 是纯函数且 `clean_title(clean_title(x)) == clean_title(x)`——空白折叠
  之后再折叠是恒等，成对符号每剥一层长度严格变短、剥到不能剥才返回。于是
  `clean_title(源行) == title` 对任何"标题取自这一行"的章节恒成立，等式回到精确。
- 唯一不精确的情形是净化成空之后的 `第 N 节`（`section_title`）：它在原文里没有对应文本，
  与 `序章 / 前言`、`第 N 部分`、`原标题(N)` 同类——"标题不是原文里的行"，比对失败正是
  正确答案，而不是漏判。
- 另一条路（把行原文与净化标题一起存进产物、前端读 `rawTitle ?? title`）被否决：它要往
  `_toc.json` 的 schema 里加字段、并在前端开第二条数据通道；幂等这条路一个字节都不多写，
  代价只是前端要镜像同一个净化函数（两条正则，见 design §3.2），类型定义与产物都不必动。

实测口径：抽查过的真书里，被净化改写的标题只占极少数（都是内部空白折叠），卷节点的
标题一个都没变——所以这条约束在当前语料上是"防患"，不是"救火"。

## 偏移的基准（design §0 修订一）

`scan()` 给出的 `char_offset` 是**标题行行首**在全文中的偏移，含该行的缩进。
不是 strip 之后的标题首字符偏移——本项目的章节 range **包含自己的标题行**
（`chapters[i].start` 就是标题行行首），这条不变量同时支撑需求 8.14 的严格连续覆盖
与 8.15 的"前端跳过与标题相同的首段"。若这里取了 strip 后的偏移，整条链路的
`start`/`end` 会集体平移几个字符，连续覆盖自校验会当场失败。

## 行边界的选择：`splitlines()` 语义 + `keepends` 级的偏移精度

`toc_rules` 的输入契约是"`str.splitlines()` 的产物"：去掉行终止符、其余原样保留、
**不预先 strip**（第 14 条「顶格短行」靠 `^\S` 判顶格，喂 strip 过的行会让每一行都顶格）。

本模块按该契约实现，但不调用 `text.splitlines()`：

- **偏移必须精确到字符。**用 `_LINE_BREAK` 正则自己找行边界，等价于
  `splitlines(keepends=True)` 的切法——每个字符都归属某一行，
  `sum(len(终止符) + len(行内容)) == len(text)` 恒成立。于是 CRLF 文本（任务 15 确立：
  解码结果保留 CRLF，且与产物 `.gz` 的内容逐字节一致）不会出现"按 LF 记偏移、
  按 CRLF 存产物"的每行差 1 个字符——现有产物正是踩了这个坑
  （gz 解出的字符数比 `_toc.json` 的 charCount 多出一个行数）。
- **生成器，不materialize。**书库里有千万字符级、几十万行的书，
  `splitlines()` 一次性建表是百 MB 级；评分只需要前 100 万字符，全文切分只需要一遍流式遍历。

`_LINE_BREAK` 覆盖 CPython `str.splitlines()` 的全部边界：`\r\n` `\n` `\r` `\v` `\f`
`\x1c` `\x1d` `\x1e` `\x85` `\u2028` `\u2029`。**这里是自觉地照抄，不是照搬失误**：
这些冷门分隔符（垂直制表、换页、NEL、行/段分隔符）在中文 txt 里偶有出现，
把它们当行边界与规则表的契约一致；而且既然每个字符都仍被计入偏移，
即便某本书里 `\f` 只是排版噪声，最坏结果也只是多切出一行候选，偏移不会错位。
`scripts/tests/test_toc.py` 对着 `str.splitlines()` 逐字符断言这份等价性。

## 篇幅门槛：一条规则凭什么算"选得出目录"

需求 8.3–8.5 的三道门槛全是命中之间的**相对**关系（间隔分档、误报比例、取代差额），
没有一条把命中数与**这本书有多长**放在一起比。于是 2 条命中就能选中一条规则，
`split_overlong` 再按 10 万字符凭空编出一张章节表——7681 本全库审计里有 12 本这样的书，
赢的命中要么是卷标记（`第一部`/`上部`），要么是首尾杂项（`番外`/`后记`/`尾声`），
要么是书末附录里的条目清单。

`Coverage` 就是补上的那一道，判据是"这批命中把多少篇幅切成了读者能用的节点"，
参数三个（`MIN_RULE_HITS` / `MAX_MEAN_NODE` / `MIN_USEFUL_SHARE`），阈值来历写在各自
注释里。它在**两个尺度**上用同一份判据，分工不同：

- `score_rule` / `pick_rule`：采样窗口尺度，作用是把"压根不像目录"的候选排除在取代
  竞争之外，于是择一会继续往后看别的规则——"先试次优规则"就是这么实现的，零额外成本；
- `split_book`：全书尺度、且在 `filter_prose_hits` **之后**，这一道是最终判决。
  不过就整本走全书兜底，不回头试次优规则（理由见 `split_book` 的 docstring）。

两个尺度的结论在全库上只有 1 本书不一致，而且是全书那一道更严。

装饰规则的取代限制（`TocRule.decorative`）与这道门槛是一对：前者管"凭什么赢"，
后者管"赢了之后算不算数"，缺任何一个都会有书变差，见 `pick_rule` 的 docstring。

## 为什么没有"标点预筛"，却有 `filter_prose_hits`

旧版 `preprocess.py` 在正则之前加了一道 `END_PUNCT` 预筛：行尾是 `。！？…` 之类就
不当标题。任务 16 实测这道筛子**是错的**——它会在大书里成批丢掉真标题，
形如 `第八章 快跑！快跑！`。所以"标点"在本模块里**从来不单独成立**为否决理由。

`filter_prose_hits` 不是那道预筛回来了，两处差三件事：

1. 它在规则**之后**跑，判的是"这条命中可信吗"，不是"这一行要不要送去匹配"；
2. 它的判据是**合取**——缩进 **且** 句子形。`第八章 快跑！快跑！` 顶格，不受影响；
3. 它按**每本书**自己的排版习惯决定要不要启用，而 `END_PUNCT` 是全局无条件的。

详见 `filter_prose_hits` 上方那一节。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Dict, Iterable, Iterator, List, Optional, Sequence, Tuple, Union

from .toc_rules import RULES, TocRule

__all__ = [
    'CHAPTER_MAX',
    'Chapter',
    'Coverage',
    'EARLY_EXIT',
    'FALLBACK_BLOCK',
    'FALLBACK_TAIL_MIN',
    'FALSE_RATIO',
    'FLUSH_DOMINANT',
    'GAP_CHAPTER',
    'GAP_VOLUME',
    'Heading',
    'INDENT_CHARS',
    'Line',
    'MAX_MEAN_NODE',
    'MIN_CLEAN_HITS',
    'MIN_FILTERED_HITS',
    'MIN_RULE_HITS',
    'MIN_USEFUL_SHARE',
    'OVER_RULE',
    'PREFACE_TITLE',
    'RulePick',
    'RuleScore',
    'SAMPLE_CHARS',
    'SENTENCE_END',
    'SENTENCE_MID',
    'SplitResult',
    'TITLE_PAIRS',
    'VOLUME_BODY_MAX',
    'body_length',
    'clean_title',
    'count_content_chapters',
    'coverage',
    'fallback_split',
    'fallback_title',
    'filter_prose_hits',
    'flush_left_share',
    'is_indented',
    'is_sentence_shaped',
    'iter_lines',
    'mark_volumes',
    'normalize_title',
    'pick_rule',
    'renumber',
    'sample_lines',
    'scan',
    'scan_text',
    'score_rule',
    'section_title',
    'split_book',
    'split_chapters',
    'split_overlong',
]

# ---------------------------------------------------------------------------
# 评分器阈值（design §4.4）
# ---------------------------------------------------------------------------

#: 采样长度：只用前 100 万字符选规则（需求 8.2）。
#: 理由是成本——书库里有千万字符级的书，十几条正则各扫一遍全文是几十秒级；
#: 采样把"选规则"压成常数开销，选定后全文只扫一遍。
SAMPLE_CHARS = 1_000_000

#: 相邻命中间隔 > 此值 → 计一个有效章节（需求 8.3）。
GAP_CHAPTER = 1_000

#: 相邻命中间隔 < 此值 → 计一个疑似卷/误报（需求 8.3）。
#: 落在 [GAP_VOLUME, GAP_CHAPTER] 之间的命中两边都不计——那是"说不清"的区间，
#: 既不能证明规则好，也不足以证明它坏。
GAP_VOLUME = 100

#: 规则可用门槛：`n_ok >= n_bad * FALSE_RATIO`（需求 8.3 的"误报超过有效数 1/3 即不可用"）。
#: 这一行是空章问题（D5）的直接解药：一条规则若匹出大量"几乎没有正文"的命中，
#: **整条规则被否决**，而不是让这些空章混进产物。旧版把 7 条正则同时套用、命中即取，
#: 没有任何环节能做这个否决，这是所有误判的根因。
FALSE_RATIO = 3

#: 取代门槛：靠后的规则要多出 **> OVER_RULE** 个有效章节才能取代当前最优（需求 8.4）。
#: 规则表是"精确在前、激进在后"排序的，所以平手或微弱领先时保留靠前的保守规则。
OVER_RULE = 2

#: 提前退出：采样内有效章节数 > 此值即停止评估后续规则（需求 8.5）。
EARLY_EXIT = 70

# --- 篇幅门槛（`Coverage`）的三个参数 ------------------------------------------
#
# 上面三道门槛全是"命中之间的相对关系"，没有一条把命中数与**这本书有多长**放在一起比。
# 于是只要有 2 条命中就能选中一条规则，`split_overlong` 再按 10 万字符凭空编出章节表。
# 7681 本全库审计里这样的书有 12 本，形态高度一致：赢的那几条命中根本不是目录——
# 是卷标记（`第一部` / `上部`）、是首尾杂项（`番外` / `后记` / `尾声`）、
# 或者是书末附录里的条目清单（一串 `〔一、标题〕` 形态的条目，全挤在书尾）。
#
# 下面三个参数就是"这批命中到底像不像一张目录"的判据，阈值的来历各自写在注释里。

#: 一张目录至少要有多少条命中（全书口径）。
#:
#: 全库 7681 本里命中数 < 6 的书一共 13 本（分布 2 条 3 本 / 3 条 4 本 / 4 条 1 本 /
#: 5 条 5 本），其余 7650 本都在 6 条以上——这条线落在一个几乎空的区间里。
#:
#: 单独用它会误伤短书：有的短书全书只有寥寥几条真章标题，平均节点却远低于
#: `MAX_MEAN_NODE`，读起来完全正常。
#: 所以它必须与 `MAX_MEAN_NODE` **合取**，见 `Coverage.sparse`。
#:
#: 取 6 的余量：改成 4 或 5 只少否 2 本书（命中只有 序/引子/番外/尾声 外加正文误报，
#: 误报形如 `第五章的伏笔是这样埋下的——`）；改成 8 会多否 1 本"真章标题不多、
#: 全书无盲区、只是每章都很长"的书，那属于"真章节就是长"，不该否。
MIN_RULE_HITS = 6

#: 与 `MIN_RULE_HITS` 合取用的平均节点长度上限：命中少**且**每个节点都这么大，
#: 才算"这几条命中不是目录"。
#:
#: 拿全库那 13 本低命中书逐本量过平均节点长度：阈值上下挪到 25,000 或 33,000，
#: 全库结果**完全相同**，30,000 落在这段空档的中间。再往上抬就会放过一本命中寥寥、
#: 其中还夹着"书名 + 万"误报的书（形如 `观众来了成千上万` 的叙述句被第 11 条读成
#: 「书名 序号」，见 `toc_rules`），阈值再往下压就会误伤上面那类短书。
MAX_MEAN_NODE = 30_000

#: "可读节点"至少要覆盖全书的多少比例。
#:
#: 可读 = 相邻命中间隔落在 `(VOLUME_BODY_MAX, CHAPTER_MAX]`，两端都是既有常量：
#:
#: - 下界 `VOLUME_BODY_MAX`（100）是本模块"这个节点没有正文"的定义（`mark_volumes`）。
#:   一串没有正文的存根不能算覆盖——书末附录里的条目彼此只隔几百字符，合起来只占
#:   全书一小截，其余篇幅是无命中的巨块。
#: - 上界 `CHAPTER_MAX`（10 万）是 `split_overlong` 的就地再切线。间隔超过它，
#:   读者拿到的就不是章节而是 `原标题(N)` 这种凭空编出来的片段——那正是要治的病。
#:
#: 阈值取 0.3，同样落在一个空档里：全库实测被否的书这一项全都不到 0.26，紧挨着门槛
#: 之上的几本都在 0.34 以上，0.26 与 0.34 之间全库一本书都没有，所以在这一段里任取
#: 一个值结果相同。
#:
#: 往上挪到 0.4 会否掉门槛之上那几本"真章标题只覆盖前三分之一、后面是一个巨块"的书——
#: 逐本读过原文：它们的命中是连号的真章标题，退回兜底等于把确定正确的信息换成
#: 一堆 `第 N 部分`，是亏的。往下挪到 0.2 会放过 2 本该否的书（其中一本的命中全是
#: `※※※`，中间夹着几十万字符的无命中区）。
#:
#: 下界为什么不取 `GAP_CHAPTER`（1000）：那会把"章节本来就短"的书一起否掉——
#: 有书几千条真章标题、中位长度不到 1000 字符，按这个下界算出来就跌到门槛以下。
#: 这类书的目录是对的，只是条目短。`VOLUME_BODY_MAX` 只排除"连正文都没有"的存根，不判"短"。
MIN_USEFUL_SHARE = 0.3

#: 行终止符。顺序关键：`\r\n` 必须排在单字符类之前，否则 CRLF 会被切成两个空行
#: （偏移仍然正确，但会多出一堆空行候选，且与 `splitlines()` 语义不一致）。
#: 字符集等于 CPython `str.splitlines()` 的边界集合，见模块 docstring。
_LINE_BREAK = re.compile(r'\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]')

#: `(行首偏移, 行内容)`。行内容已去掉行终止符，其余原样——即规则表的输入契约。
Line = Tuple[int, str]

#: `(标题行行首偏移, 行原文)`。`title` 未 strip、未净化（净化见任务 20）。
Heading = Tuple[int, str]


# ---------------------------------------------------------------------------
# 按行扫描器
# ---------------------------------------------------------------------------


def iter_lines(text: str, *, limit: Optional[int] = None) -> Iterator[Line]:
    """逐行产出 `(行首偏移, 行内容)`，偏移以 `text` 起点为基准。

    行内容与 `text.splitlines()` 的对应项逐字符相等：去掉行终止符、缩进与行尾空白
    一律保留（规则表的输入契约）。偏移与 `splitlines(keepends=True)` 的累加一致，
    所以 CRLF、`\\r`、`\\f` 等多字符/冷门终止符都不会让偏移漂移。

    Args:
        text: 全文（`encoding.decode` 的出口，UTF-8 `str`）。
        limit: 只产出**行首偏移** < `limit` 的行；跨越边界的那一行整行产出，
            不会被截断。`None` 表示扫到结尾。

    Yields:
        `(offset, line)`，`text[offset:offset + len(line)] == line` 恒成立。
    """
    total = len(text)
    stop = total if limit is None else min(limit, total)
    pos = 0
    for match in _LINE_BREAK.finditer(text):
        if pos >= stop:
            return
        yield pos, text[pos:match.start()]
        pos = match.end()
    # 末行没有终止符时才补这一次；有终止符的文本到此 pos == total，不产出空尾行
    # （与 `'a\n'.splitlines() == ['a']` 一致）。
    if pos < total and pos < stop:
        yield pos, text[pos:]


def sample_lines(text: str, limit: int = SAMPLE_CHARS) -> List[Line]:
    """把前 `limit` 个字符的行**一次性**取出来，供多条规则复用（需求 8.2）。

    `pick_rule` 要对同一批行跑最多 10 条启用规则；每条规则都重新切一遍行是纯浪费。
    采样上限 100 万字符 ≈ 3 万行，列表开销可忽略。
    """
    return list(iter_lines(text, limit=limit))


def scan(lines: Iterable[Line], rule: TocRule) -> Iterator[Heading]:
    """用一条规则扫过若干行，产出命中的 `(行首偏移, 行原文)`。

    Args:
        lines: `iter_lines` 或 `sample_lines` 的产物（任何 `(offset, line)` 可迭代）。
        rule: 规则表里的一条。传入 `enabled=False` 的规则也照样跑——
            是否参与自动择一由 `pick_rule` 决定，不在这里过滤。

    Yields:
        `(char_offset, title)`，`title` 是行原文（未 strip）。
    """
    match = rule.match
    for offset, line in lines:
        # 空行快路径：每一条规则都要求至少一个实体字符（标记/汉字/数字/`\S`），
        # 没有任何一条能匹配 ''。中文 txt 里空行占三成以上，省掉这些调用是纯收益。
        # `test_toc.py::test_no_rule_matches_an_empty_line` 把这个前提钉住。
        if not line:
            continue
        if match(line):
            yield offset, line


def scan_text(text: str, rule: TocRule, *, limit: Optional[int] = None) -> Iterator[Heading]:
    """`scan(iter_lines(text, limit=limit), rule)` 的便捷写法（全文流式扫描）。"""
    return scan(iter_lines(text, limit=limit), rule)


# ---------------------------------------------------------------------------
# 择一评分（design §4.4）
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Coverage:
    """一批命中把多少篇幅切成了"读者能用的节点"。

    这是 `MIN_RULE_HITS` / `MAX_MEAN_NODE` / `MIN_USEFUL_SHARE` 三个参数的载体，
    纯数据、纯算术，不认规则也不认文本——所以它能在两个不同的尺度上用同一份判据：

    - **采样尺度**（`score_rule`）：`total` 是采样窗口的长度，命中是窗口内的命中。
      作用是让 `pick_rule` 把"压根不像目录"的候选排除在取代竞争之外，从而继续往下
      看后面的规则（"先试次优规则"就是这么实现的，不需要任何额外扫描）。
    - **全书尺度**（`split_book`）：`total` 是全文长度，命中是 `filter_prose_hits`
      **之后**的命中。这一道才是准的，也是最终判决。

    两个尺度会不会打架？全库 7681 本逐本实测：对各自选中的那条规则，
    两个尺度的结论有分歧的只有 1 本（采样尺度通过、全书尺度不通过，
    由全书那一道否掉），而"采样说否、全书说可以"的一本都没有。所以采样那一道是安全的
    早筛，全书那一道是兜底判决——顺序不能反：过滤器只在全书尺度上跑
    （理由见 `filter_prose_hits` 上面那一节），而正文误报会让覆盖率虚高。
    """

    total: int
    """被度量的篇幅（采样窗口长度或全文长度）。"""

    hits: int
    """命中数。"""

    useful: int
    """落在 `(VOLUME_BODY_MAX, CHAPTER_MAX]` 的相邻间隔之和（含首尾两段）。"""

    @property
    def mean_node(self) -> float:
        """平均节点长度。`hits` 条命中把 `total` 切成 `hits + 1` 段，所以分母恒 >= 1。"""
        return self.total / (self.hits + 1)

    @property
    def useful_share(self) -> float:
        """可读节点覆盖的篇幅占比。`total == 0` 时为 0.0（无从判断）。"""
        return self.useful / self.total if self.total > 0 else 0.0

    @property
    def sparse(self) -> bool:
        """命中太少**且**每段都太长——这几条命中不是目录，是几个标记。"""
        return self.hits < MIN_RULE_HITS and self.mean_node > MAX_MEAN_NODE

    @property
    def blind(self) -> bool:
        """可读节点覆盖不到 `MIN_USEFUL_SHARE`——大半本书落在无命中的巨块里。"""
        return self.useful_share < MIN_USEFUL_SHARE

    @property
    def ok(self) -> bool:
        """通过篇幅门槛。`total == 0`（空文本）时为假：没有篇幅可言，也没有目录可言。"""
        return self.total > 0 and not self.sparse and not self.blind


def coverage(offsets: Sequence[int], total: int) -> Coverage:
    """按命中偏移算出 `Coverage`。

    Args:
        offsets: 命中的行首偏移，**必须升序**（`scan` 的产出天然如此）。
        total: 被度量的篇幅。

    Returns:
        `Coverage`。间隔的切法与 `split_book` 造章节表的切法一致：
        `[0, offsets[0])` 是序章那一段，`[offsets[i], offsets[i+1])` 是各章，
        `[offsets[-1], total)` 是末章。所以 `useful` 量的就是"读者真正能跳进去的篇幅"，
        而不是某个抽象的间隔分布。
    """
    bounds = [0, *offsets, total]
    useful = 0
    for start, end in zip(bounds, bounds[1:]):
        gap = end - start
        if VOLUME_BODY_MAX < gap <= CHAPTER_MAX:
            useful += gap
    return Coverage(total=total, hits=len(offsets), useful=useful)


@dataclass(frozen=True)
class RuleScore:
    """一条规则在采样上的得分。`check_toc.py`（任务 27）逐条打印这个。"""

    name: str
    """规则名。"""

    n_ok: int
    """有效章节数：与上一个**被采纳**的命中间隔 > `GAP_CHAPTER`（首个命中无条件计入）。"""

    n_bad: int
    """疑似卷/误报数：与上一个被采纳的命中间隔 < `GAP_VOLUME`。"""

    hits: int
    """总命中行数。`hits - n_ok - n_bad` 就是落在灰区、两边都不计的那些。"""

    cover: Optional[Coverage] = None
    """采样窗口上的篇幅度量；`None` 表示没有度量（只在手写 `RuleScore` 的测试里出现）。"""

    @property
    def usable(self) -> bool:
        """是否通过误报门槛（需求 8.3）。注意零命中也算"通过"——它只是赢不了。"""
        return self.n_ok >= self.n_bad * FALSE_RATIO

    @property
    def covers(self) -> bool:
        """是否通过篇幅门槛。没有度量时返回 `True`——不知道就不否决。"""
        return self.cover is None or self.cover.ok


@dataclass(frozen=True)
class RulePick:
    """择一结果。比 design §4.4 的 `(best, best_n)` 多带诊断字段——

    `tocRule` 要写进产物、`n_ok`/`n_bad` 要进度量报告、`scores` 要支撑
    "改规则表前后对比指标"（需求 8.12），都从这里取。
    """

    rule: Optional[TocRule]
    """选中的规则；无规则可用时为 `None`（此时走全书兜底，任务 19）。"""

    n_ok: int
    """选中规则的有效章节数；未选中为 0。"""

    n_bad: int
    """选中规则的疑似误报数；未选中为 0。"""

    scores: Tuple[RuleScore, ...] = ()
    """实际评估过的规则得分，顺序同规则表。提前退出时短于启用规则总数。"""

    early_exit: bool = False
    """是否因 `n_ok > EARLY_EXIT` 提前停止评估（需求 8.5）。"""

    overridden: bool = False
    """这条规则是否来自本机覆盖表（`toc-overrides.local.json`）的人工点名（需求 8.10）。

    为真时 `n_ok`/`n_bad`/`scores` 全是空值——覆盖命中就跳过评分，没有得分可报。
    `pick_rule` 永远不会产出为真的这个字段，构造它的是 `toc_overrides.pick_rule_for`。
    """

    @property
    def name(self) -> Optional[str]:
        """写入 `_toc.json` 的 `tocRule` 字段的值；无规则可用时为 `None`。"""
        return self.rule.name if self.rule is not None else None


def score_rule(lines: Sequence[Line], rule: TocRule) -> RuleScore:
    """按相邻命中间隔给一条规则打分（需求 8.3）。

    分档口径（design §4.4）：

    - 间隔 > `GAP_CHAPTER`（1000）→ 有效章节，并把基准推到本次命中；
    - 间隔 < `GAP_VOLUME`（100）→ 疑似卷/误报，**不**推进基准；
    - 两者之间 → 不计，也不推进基准。

    基准只在"有效"时推进，所以一串密集的误报会相对同一个基准逐个记账，
    不会因为彼此间隔大而互相洗白。

    顺带在同一遍里算出采样窗口上的 `Coverage`（`cover` 字段）——命中偏移本来就在手里，
    多记一个列表不花第二遍扫描。窗口长度取**最后一行的末尾**而不是 `SAMPLE_CHARS`：
    短书的采样就是全书，拿 100 万当分母会把它的平均节点长度算大几十倍。
    """
    n_ok = n_bad = hits = 0
    offsets: List[int] = []
    last: Optional[int] = None   # None = 还没有被采纳的命中
    for offset, _title in scan(lines, rule):
        hits += 1
        offsets.append(offset)
        if last is None:
            # 首个命中无条件计入：它没有"上一个命中"可比。
            # design 的伪码用 `last == 0` 表达这个状态，但那会让"首个标题恰在偏移 0"
            # 的书（`第一章` 就是第一行，很常见）白送第二个命中一次免检。
            # 用显式哨兵表达同一个意图，行为只在那个边缘情形上更严。
            n_ok += 1
            last = offset
            continue
        gap = offset - last
        if gap > GAP_CHAPTER:
            n_ok += 1
            last = offset
        elif gap < GAP_VOLUME:
            n_bad += 1
    window = lines[-1][0] + len(lines[-1][1]) if lines else 0
    return RuleScore(
        name=rule.name,
        n_ok=n_ok,
        n_bad=n_bad,
        hits=hits,
        cover=coverage(offsets, window),
    )


def pick_rule(
    source: Union[str, Sequence[Line]],
    rules: Sequence[TocRule] = RULES,
    *,
    limit: int = SAMPLE_CHARS,
) -> RulePick:
    """对一本书**只选一条**规则（需求 8.1–8.5）。

    Args:
        source: 全文 `str`（内部按 `limit` 采样），或已经切好的行序列。
        rules: 候选规则表，顺序即优先权；`enabled=False` 的被跳过（需求 8.6）。
        limit: `source` 为 `str` 时的采样长度。

    Returns:
        `RulePick`。`rule is None` 表示没有任何规则可用，调用方走全书兜底（需求 8.9）。

    判定顺序（五道门槛缺一不可）：

    1. 误报门槛 `n_ok >= n_bad * FALSE_RATIO`——不过就整条否决（需求 8.3）；
    2. 取代门槛 `n_ok > best_n + OVER_RULE`——给靠前的保守规则优先权（需求 8.4）；
    3. **装饰门槛**：`rule.decorative` 的规则不许取代已经选中的规则。它匹出来的
       "标题"可能整行都是装饰（`※※※`），而分场分隔线在结构上必然比章节多，
       按命中数硬比就必然赢——分场符号的命中数可以是章标题的数倍。没有在选人时
       禁用它：原文压根没有标题行的书靠它才有目录，那时它是唯一候选，也就无人可取代；
    4. **篇幅门槛** `score.covers`：命中的分布得像一张目录（`Coverage`）。不像的候选
       不进入取代竞争，循环继续往后看——这就是"先试次优规则"，而且不花任何额外扫描。
       它跑在采样窗口上，最终判决在 `split_book` 里按全书重做一遍；
    5. 提前退出 `best_n > EARLY_EXIT`——采样里已有 70 章以上，后面的激进规则不必再看（需求 8.5）。

    第 3、4 条的联动是刻意的：把 3 单独加上会有 3 本书从"上百条分场分隔线"掉到
    "寥寥几条挤在一处的精确命中"——那些精确规则过不了第 4 条，于是根本当不上
    "已经选中的规则"，装饰规则照旧胜出。
    """
    lines: Sequence[Line]
    if isinstance(source, str):
        lines = sample_lines(source, limit)
    else:
        lines = source

    best: Optional[TocRule] = None
    best_n = -1
    best_bad = 0
    scores: List[RuleScore] = []
    early_exit = False

    for rule in rules:
        if not rule.enabled:
            continue
        score = score_rule(lines, rule)
        scores.append(score)
        if not score.usable or score.n_ok <= best_n + OVER_RULE:
            continue
        if rule.decorative and best is not None:
            continue
        if not score.covers:
            continue
        best, best_n, best_bad = rule, score.n_ok, score.n_bad
        if best_n > EARLY_EXIT:
            early_exit = True
            break

    return RulePick(
        rule=best,
        n_ok=best_n if best is not None else 0,
        n_bad=best_bad if best is not None else 0,
        scores=tuple(scores),
        early_exit=early_exit,
    )


# ---------------------------------------------------------------------------
# 按书自适应的正文命中过滤（需求 8.3 的同族问题）
#
# `toc_rules.UNIT` 的后缀白名单管的是"单位字后面长得像不像标题"，它只看一行。
# 剩下的一半误报是**带了分隔符的句子**——`第四场 风停了。`、`第二章的结尾是这样
# 安排的——`——单看一行分不出来，要看**整本书的排版习惯**：
#
# 7681 本库抽检实测，受害书里真标题一律顶格、正文误报一律带 `\u3000\u3000` 缩进；
# 抽检的 7 本受害书、上万个节点里，"缩进但确实是标题"的桶是 **0**。
#
# 但缩进**不能**当全局判据：有的书命中全是缩进的、且全是真标题
# （那本书的真标题就是缩进的）；全库 7681 本里有 **496 本**属于这一类（6.5%）。
# 一条 `^\S` 全局锚会把它们整批毁掉。
#
# 所以判据必须**按书自适应**：先从这本书自己的命中里判断"它到底缩不缩进标题"，
# 再否决少数派形态。下面三个常量就是这个判断的全部参数，阈值的来历写在各自的注释里。
#
# 这里是纯函数、不认 `book_id`、不读文件——与评分器同一个理由（好断言）。
# 接入点只有一个：`split_book` 拿到 `heads` 之后、造章节表之前。
# **故意不接进 `score_rule`/`pick_rule`**：那两个跑在 100 万字符的采样上，
# 采样里的命中分布和全书不一样，按采样判"这本书缩不缩进"是拿偏样本下结论；
# 而且过滤只会减少误报、不会增加有效章节，选规则的结论不会因此变好。
# ---------------------------------------------------------------------------

#: 行首缩进字符。`^[ \t\u3000]{0,4}`（`toc_rules._HEAD`）允许的那几个。
INDENT_CHARS = ' \t\u3000'

#: 句末标点。真标题几乎不以它们收尾——注意"几乎"：`第八章 快跑！快跑！` 是真标题的写法，
#: 所以这一条**单独不足以**否决任何命中，必须与缩进同时成立（见 `filter_prose_hits`）。
SENTENCE_END = '。！？…；'

#: 句中标点。只取全角逗号：它是叙述句的标志，而真标题里也有
#: （有书成批的顶格真标题带 `，`/`！`）——同样只在与缩进合取时才生效。
SENTENCE_MID = '，'

#: "这本书的标题是顶格的"判定线：**形状明确是标题**的那批命中里，顶格的占比。
#:
#: 阈值取 0.9，因为实测分布是压倒性双峰的（7681 本书，统计「标准章节」的命中）：
#:
#:     == 1.00        6648 本        == 0.00（整本缩进）   496 本
#:     [0.99, 1.00)    336 本        (0, 0.50)             21 本
#:     [0.95, 0.99)     77 本        [0.50, 0.80)          10 本
#:     [0.90, 0.95)     19 本        [0.80, 0.90)           8 本
#:
#: 7080 本在 0.90 以上、496 本恰好 0，(0, 0.90) 这整个区间散着 39 本。0.9 落在空档里：
#: 把它挪到 0.85 或 0.95，全库只有 4 本书的幸存命中数会变、合计 32 条命中；
#: 要到 0.99 才开始有实质差别（24 本 / 150 条）。
#:
#: 为什么不用"顶格命中占全部命中的比例"：那个量在受害最重的书上只有五成出头，与
#: "整本缩进"的 0% 之间几乎没有余量，阈值得卡在 0.5 上下才管用。改成只统计
#: **形状明确是标题**的那批，同一批书就变成 ~1.00 vs 0.00，判据从"擦边"变成"两极"。
FLUSH_DOMINANT = 0.9

#: 做上面那个判定至少要有多少个"形状明确是标题"的命中。样本太少时"占比 1.00"
#: 说明不了任何事——1 个命中就能凑出 1.00。
#:
#: 取 8 是因为结论对这个数极不敏感：以 8 为基准，改成 5 全库结果**完全相同**，
#: 改成 2 只多影响 1 本书 2 条命中，收紧到 20 少影响 2 本 6 条、收紧到 50 少影响
#: 5 本 9 条。既然 2–50 之间怎么取都差不多，就取一个"占比跨过 0.9 时至少要有
#: 8 个样本、其中一个反例都不能有"的直觉值。
#: 全库有 205 本书的样本不足 8 个（多为几十章的短篇集），它们一律不过滤。
MIN_CLEAN_HITS = 8

#: 过滤后至少要剩下多少个命中。低于此值就整批退回不过滤——
#: 判断失手时宁可保持原样，也不能把一本书压成一张空目录。
#:
#: 2 与 `split_book` 的第一道兜底门槛同一个数：命中不足 2 条时 `split_book` 会走
#: 全书兜底（需求 8.9），所以"退回原样"之后该兜底的书照旧兜底，行为与改动前一致。
#: （`split_book` 还有第二道门槛——`Coverage` 的篇幅判据，那一道跑在过滤**之后**，
#: 所以它看到的正是本函数的输出，与这里的下限不冲突：结构上幸存数恒 >= 8。）
#: 实测这条线一次都没被触发，而且结构上也触发不了：被否决的命中一定是"句子形"的，
#: 而判定用的那 `MIN_CLEAN_HITS` 个非句子形命中一个都不会被否决，
#: 所以幸存数恒 >= 8 > 2。留着它是为了让这个不变量写在代码里而不是只写在注释里。
MIN_FILTERED_HITS = 2


def is_indented(line: str) -> bool:
    """这一行是不是带排版缩进（行首有空白）。

    判据与 `toc_rules` 第 14 条「顶格短行」的 `^\\S` 互为反面，也是同一个前提：
    调用方喂进来的是**行原文**，没有预先 strip 过。
    """
    return bool(line) and line[0] in INDENT_CHARS


def is_sentence_shaped(line: str) -> bool:
    """这一行像不像一句叙述：以句末标点收尾，或者中间有逗号。

    两个条件是"或"：`第三幕终于开场。` 靠前者，
    `第二场，客队开局连丢十一分，看台上嘘声四起。` 两者都中。
    """
    text = line.strip()
    if not text:
        return False
    if text[-1] in SENTENCE_END:
        return True
    return any(char in text for char in SENTENCE_MID)


def flush_left_share(lines: Sequence[str]) -> Tuple[Optional[float], int]:
    """在**非句子形**的那批行里，顶格的占多少。

    只看非句子形的行，是这套判据的关键：句子形的行里混着待判决的误报，
    拿它们一起算比例等于用嫌疑人给自己作证。非句子形的行基本可以认定是真标题，
    "它们顶不顶格"就是"这本书缩不缩进标题"的直接答案。

    Returns:
        `(顶格占比, 非句子形行数)`。一条非句子形的行都没有时占比为 `None`
        ——没有可信样本，调用方不该下结论。
    """
    clean = [line for line in lines if not is_sentence_shaped(line)]
    if not clean:
        return None, 0
    flush = sum(1 for line in clean if not is_indented(line))
    return flush / len(clean), len(clean)


def filter_prose_hits(heads: Sequence[Heading]) -> List[Heading]:
    """按本书自己的排版习惯剔掉规则在正文里匹出的命中。

    Args:
        heads: 一条规则在**这一本书**上的全部命中（`scan` 的产物，`title` 是行原文）。
            顺序无关，也不要求来自哪条规则——判据只用行本身的形状。

    Returns:
        新列表（保持原顺序）。不满足"这本书的标题顶格"这个前提时**原样返回内容**，
        所以调用方可以无条件套用它。

    判决只有一条：**缩进 且 句子形** → 否决。两个条件都是必要的：

    - 只看缩进，会毁掉那 442 本"真标题本来就缩进"的书；
    - 只看句子形，会毁掉 `第八章 快跑！快跑！` 这类带感叹号的真标题
      （有书一本就有成批的顶格真标题带 `，`/`！`），
      实测在一本标题整本缩进的书上单用这一条就会误杀真标题。

    合取之后对照几本书的人工标注，合计只漏 1 个、差 1 个，没有误杀。

    前提（`FLUSH_DOMINANT` / `MIN_CLEAN_HITS`）不成立时一律不过滤：判不出这本书的
    排版习惯，就不要替它做决定。这类书的误报交给 `toc_rules.UNIT` 的后缀白名单，
    以及评分器的误报门槛（需求 8.3）。
    """
    lines = [title for _offset, title in heads]
    share, n_clean = flush_left_share(lines)
    if share is None or n_clean < MIN_CLEAN_HITS or share < FLUSH_DOMINANT:
        return list(heads)
    kept = [
        head for head in heads
        if not (is_indented(head[1]) and is_sentence_shaped(head[1]))
    ]
    if len(kept) < MIN_FILTERED_HITS:
        # 见 MIN_FILTERED_HITS：结构上到不了这里，到了就说明判据本身错了，
        # 此时保持原样、把决定权交回 `split_book` 的兜底逻辑。
        return list(heads)
    return kept


# ---------------------------------------------------------------------------
# 切分与卷标记（design §4.5，需求 8.7 / 8.7a / 8.14 / 8.15）
# ---------------------------------------------------------------------------

#: 首个标题之前那段内容的标题。它是**合成**的，原文里没有对应的标题行——
#: `body_length` 依赖这一点，见那里的说明。
PREFACE_TITLE = '序章 / 前言'

#: 去掉标题行后正文不足此字符数 → 判为卷节点（需求 8.7a）。
#: 实测最短的正文章节远大于 100 字符（`check_toc.py` 的"最短"一列），不会误伤。
VOLUME_BODY_MAX = 100

#: 单章上限：超过此字符数就地再切（需求 8.8，design §4.5 ②）。
#: 对齐 Legado 的 `maxLengthWithToc = 100KB`，我方按 10 万**字符**计
#: （中文按字节算会把同一本书的门槛压到三分之一）。
#: 也是 `check_toc.py`（任务 27）判"疑似误判"的上界，两处必须同一个常量。
CHAPTER_MAX = 100_000

#: 全书兜底的目标块长（需求 8.9）。沿用旧版的 5000 字符：一屏多页、可翻可跳，
#: 与"约 5000 字符"的措辞一致。块长只是目标值，实际断点由段落/换行边界决定。
FALLBACK_BLOCK = 5_000

#: 全书兜底的末块下限：不足此长度就并入前一块，免得产出 3 个字符的"章节"
#: （余数完全取决于全文长度，1% 左右的书会摊上一个几十字符的尾块，
#: 而 `check_toc.py` 会把 length < 50 的非卷章节记成疑似误判）。
FALLBACK_TAIL_MIN = FALLBACK_BLOCK // 10

#: 一个章节。字段顺序即写进 `_toc.json` 的顺序（design §2.1）：
#: `id` / `title` / `start` / `end` / `length`，`isVolume` 只在为真时出现。
Chapter = Dict[str, Any]

#: 标题净化要去掉的成对装饰符号：开 → 闭（design §4.6，需求 8.1）。
#:
#: 草图给的集合是 `【】〖〗「」『』[]()`，这里补上 `〔〕` 与全角 `（）`——它们是同一类
#: 方头/圆括号的全角写法，中文 txt 里一样常见。
#:
#: **故意不含 `《》` 与 `〈〉`**：书名号与尖括号承载语义而不是装饰（`《青石巷》` 是书名），
#: 剥掉它们是改写标题。`toc_rules._OPEN` 为了**匹配**把它们算进开符号，那是另一回事——
#: 认得出这一行是标题，不等于该把这对符号从标题里删掉。
TITLE_PAIRS: Dict[str, str] = {
    '【': '】',
    '〖': '〗',
    '〔': '〕',
    '「': '」',
    '『': '』',
    '（': '）',
    '(': ')',
    '［': '］',
    '[': ']',
}

#: 闭 → 开。判"孤悬的行尾闭符号"用它，见 `clean_title`。
_TITLE_CLOSERS: Dict[str, str] = {close: open_ for open_, close in TITLE_PAIRS.items()}

#: 内部空白折叠。Python 的 `\s` 认全角空格 U+3000 与 NBSP，正是中文排版的主流空白。
_WHITESPACE = re.compile(r'\s+')


@dataclass(frozen=True)
class SplitResult:
    """切分结果：章节表 + 这本书是否走了全书兜底。

    `fallback` 是**书级**事实而不是章节字段，所以它在这里，不在任何 `Chapter` 里
    ——`_toc.json` 也是把它放在根上（design §2.1）。`preprocess.py` 据此决定是否
    往产物里写 `fallback: true`（与 `isVolume` 同一约定：真时才输出）。
    """

    chapters: List[Chapter]
    """章节表，`id` 从 0 连续递增，`start`/`end` 严格连续覆盖全文（需求 8.14）。"""

    fallback: bool = False
    """是否触发了全书兜底（需求 8.9）。逐章兜底（需求 8.8）**不**算——
    那是正常路径里的局部修补，规则依然可用，`tocRule` 依然有意义。"""

    cover: Optional[Coverage] = None
    """全书尺度的篇幅度量（`filter_prose_hits` **之后**的命中）；`rule is None` 时为 `None`。

    纯诊断字段，不参与任何判定的输出：`preprocess.build_toc` 靠它在日志里分清
    "过滤后命中不足 2 个"与"命中够多、但不像一张目录（篇幅门槛）"这两种兜底。"""


def _mk(start: int, end: int, title: str) -> Chapter:
    """造一个章节。`id` 先占位，最后由 `renumber` 统一写。"""
    return {'id': 0, 'title': title, 'start': start, 'end': end, 'length': end - start}


def section_title(index: int) -> str:
    """标题净化成空时的回退（`index` 0 起，输出 1 起）。

    与全书兜底的 `fallback_title`（`第 N 部分`）**故意不同名**：那个是"这本书压根没有
    目录"，这个是"这一行的标题净化之后什么都不剩"。两者混用会让 `check_toc.py`（任务 27）
    分不清"兜底书"和"标题被净化光的书"。

    `index` 是**标题序号**（`heads` 里的下标），不是章节 `id`——调用点在 `renumber` 之前，
    而且有序章时两者会差 1。既然这个回退只在"原文里没有可读标题"时出现，用哪个口径都只是
    个编号，取更稳定的那个（标题序号不随序章的有无平移）。
    """
    return f'第 {index + 1} 节'


def clean_title(raw: str) -> str:
    """净化标题文本：折叠内部空白 + 去除成对装饰符号（需求 8.1 / D16，design §4.6）。

    Args:
        raw: 标题行原文（`scan` 产出的那个，未 strip）。

    Returns:
        净化后的标题，**可能是空串**（整行都是装饰符号时）。空串的回退是 `normalize_title`
        的事，不在这里——`_title_line_end` 要的是一个不依赖 `index` 的纯函数。

    **幂等**：`clean_title(clean_title(x)) == clean_title(x)`。这是 `_title_line_end`
    的严格相等能重新成立的全部依据（见模块 docstring「净化与严格相等」），
    `test_toc_title.py` 在一个组合枚举出来的输入空间上逐个钉住它。

    两步都按 design §4.6，但第二步与那份草图有实质偏差：

    1. **折叠内部空白**：`\\s+` → 单个半角空格，再去首尾。Python 的 `\\s` 认全角空格
       U+3000 与 NBSP，这正是中文 txt 里的主流排版空白（实测见过 `第十回  标题` 的
       双半角空格，也见过 `第十回\\u3000标题` 的全角空格）。
    2. **去除成对装饰符号**：草图写的是
       `re.sub(r'^[【〖「『\\[(]|[】〗」』\\])]$', '', t)`——两个分支彼此独立，于是**只有半边
       的行尾括号也会被剥掉**：`青石巷(12)`（规则 9「书名 序号」的主力形态）会变成
       `青石巷(12`，`第一章（上）` 会变成 `第一章（上`。任务 20 的措辞是"去除**成对**装饰
       符号"，所以这里按成对处理，三种情形循环到不能再剥：

       - 行首的开符号**当真闭合在行尾** → 两边一起剥（`『「甲」』` → `甲`）；
         判据是配对深度（`_encloses`），不是"首字符是开符号、尾字符是它的闭符号"——
         后者会把 `（甲）乙（丙）` 剥成 `甲）乙（丙`，与草图那个 bug 同一类；
       - 首字符是开符号、而它的闭符号**整行都没出现** → 剥掉这个孤悬的开符号
         （`【第一章 标题`——`toc_rules._OPEN` 明确说很多书只写左半）；
       - 尾字符是闭符号、而它的开符号整行都没出现 → 同理剥掉（`第一章 标题】`）。

       "配对的另一半没出现" 这个前提就是 `青石巷(12)` / `第一章（上）` 的保险：`)` 的
       `(` 在行里，第三种情形不适用，标题原样保留。

    前端（任务 33）要镜像这个函数才能保住 design §3.2 的严格相等。JS 的 `\\s` 与 Python 的
    在冷门码位上略有出入（JS 多 U+FEFF，Python 多 C1 区几个），但两边都认空格/制表/
    U+3000/NBSP，中文标题用不到差集。
    """
    title = _WHITESPACE.sub(' ', raw).strip()
    while title:
        closer = TITLE_PAIRS.get(title[0])
        if closer is not None:
            if _encloses(title, title[0], closer):
                title = title[1:-1].strip()
                continue
            if closer not in title:
                title = title[1:].strip()
                continue
        opener = _TITLE_CLOSERS.get(title[-1])
        if opener is not None and opener not in title:
            title = title[:-1].strip()
            continue
        break
    return title


def _encloses(title: str, open_: str, close: str) -> bool:
    """`title[0]` 这个开符号是否**恰好闭合在** `title[-1]`（整行被这一对符号包住）。

    按配对深度数，所以嵌套同型符号也判得对：`（（甲））` 是包住的（剥两层得 `甲`），
    而 `（甲）乙（丙）` 不是——行首那个 `（` 在中间就闭合了，把两端剥掉会得到
    `甲）乙（丙`，与 design §4.6 草图那个 bug 同一类。
    """
    if len(title) < 2 or title[-1] != close:
        return False
    depth = 0
    for index, char in enumerate(title):
        if char == open_:
            depth += 1
        elif char == close:
            depth -= 1
            if depth == 0:
                return index == len(title) - 1
    return False


def normalize_title(
    raw: str,
    index: int = 0,
    prev: Optional[Sequence[Chapter]] = None,
) -> str:
    """`clean_title` 加上"净化成空则回退 `第 N 节`"（design §4.6，需求 8.1）。

    Args:
        raw: 标题行原文。
        index: 标题序号（0 起），只用于空标题的回退编号。
        prev: 已经造好的章节（design §4.5 的调用点传 `chs`）。**当前实现不读它**——
            需求 D16 只要求净化环节"能看见" `index`/`prevTitle`/`lastVolumeTitle`，
            Legado 用它们是因为净化是用户脚本；本项目的净化是固定的两步，用不上上下文。
            保留这个形参是为了让"以后真要按上一个标题做决策"时不必改所有调用点，
            也为了签名与 design 的草图对得上。

    Returns:
        最终写进 `_toc.json` 的 `title`。

    不引 JS 引擎（需求附录 L2）：Legado 在这一环跑 Rhino 执行用户脚本，本项目就是一个
    普通函数 + 两段正则，规则要改就改代码，改完 `test_toc_title.py` 的语料与合成书用例
    会立刻告诉你影响面。
    """
    return clean_title(raw) or section_title(index)


def split_book(text: str, rule: Optional[TocRule]) -> SplitResult:
    """把全文切成章节表（design §4.5，需求 8.8 / 8.9 / 8.14 / 8.15）。

    Args:
        text: 全文（`encoding.decode` 的出口，CRLF 原样保留）。
        rule: `pick_rule` 选中的那一条；`None` 表示没有任何规则可用，直接走全书兜底。

    Returns:
        `SplitResult`。`chapters` 的 `id` 从 0 连续递增，`start`/`end` 严格连续覆盖
        `[0, len(text))`；卷节点带 `isVolume: True`，正文章节**没有这个键**（不是
        `False`）。`fallback` 为真表示这本书没能用规则切出章节表（需求 8.9）。

    命中先过一遍 `filter_prose_hits`（按书自适应剔掉正文命中），再进入下面的切分。
    过滤只删命中，不改任何偏移，所以连续覆盖照旧由构造保证。

    过滤之后、造章节表之前还有一道**篇幅门槛**（`Coverage`，见那里的三个参数）：
    这批命中得像一张目录，否则整本走全书兜底。这是最终判决，`pick_rule` 里那一道
    只是采样尺度上的早筛——两者共用同一份判据，但只有这里能做准：

    - 过滤器故意不在评分器里跑（理由见 `filter_prose_hits` 上面那一节），
      而正文误报会让覆盖率虚高，所以门槛必须排在过滤之后；
    - 评分只看前 `SAMPLE_CHARS` 个字符，而"覆盖了多少篇幅"是全书属性。
      全库 7681 本实测，两个尺度的结论只有 1 本书不一致（采样尺度通过、全书尺度
      不通过），而且方向就是这一道更严。

    门槛不过时**直接走全书兜底，不回头试次优规则**。理由有两条，一条是结构的、
    一条是实测的：

    - 结构上，编排层（`preprocess.build_toc`）交给本函数的是**一条**规则；在这里重做
      择一意味着为每个候选再全文扫一遍加过滤一遍，而择一本来就有自己的次优机制
      （`pick_rule` 的第 4 道门槛，跑在采样上、零额外成本）；
    - 实测上，被这一道否掉的书里**没有一本**有"通过误报门槛、又能通过篇幅门槛"的
      次优规则可用：次优规则要么同样只有两三条命中，要么误报多到过不了 3:1。
      回头试一遍的收益实测为零。

    唯一的例外是"精确规则被误报门槛否了、篇幅却完全正常"这一类（真章标题被成百条
    问卷条目压过，或者被书前那张目录清单拖得误报超标）。那不是篇幅门槛能解决的问题，
    解法是在本机覆盖表（`scripts/toc-overrides.local.json`）里逐本点名。

    切法：

    - 相邻标题之间构成一个章节，最后一个标题到文末构成末章；
    - 每个章节的 range **以自身标题行行首起始**（需求 8.15，design §0 修订一）——
      `scan` 给的偏移就是行首，含缩进，所以这里不需要任何修正；
    - 首个标题之前若有内容，产出 `序章 / 前言`；
    - 于是 `chapters[i].end == chapters[i+1].start` 自动成立，无需事后缝合。

    两级兜底（需求 8.8 / 8.9）：全文凑不出 2 个标题 → 整本按段落块切
    （`fallback=True`）；否则正常切，再对个别超长章就地再切（`fallback` 仍为假，
    规则依然可用）。
    """
    if rule is None:
        return SplitResult(fallback_split(text), True)

    # 先按书自适应地剔掉正文命中，再判"够不够两条标题"——过滤器承诺过滤后不少于
    # `MIN_FILTERED_HITS`（= 2）条，否则原样退回，所以这里的兜底门槛与过滤前同义。
    heads: List[Heading] = filter_prose_hits(list(scan_text(text, rule)))
    # 篇幅度量先算好、三条出口都带上（纯算术，不改任何判定）：日志要靠它说清兜底的原因。
    cover = coverage([offset for offset, _title in heads], len(text))
    if len(heads) < 2:
        # 需求 8.9：一条标题撑不起一张目录，整本按段落块切。
        return SplitResult(fallback_split(text), True, cover)
    if not cover.ok:
        # 篇幅门槛不过：这批命中不是目录（太少太疏，或者大半本书落在无命中的巨块里）。
        # 与其让 `split_overlong` 按 10 万字符编一张出来，不如按段落块切——
        # 后者至少每 5000 字符就有一个可跳的位置，且不假称那是章节标题。
        return SplitResult(fallback_split(text), True, cover)

    total = len(text)
    chapters: List[Chapter] = []

    first_offset = heads[0][0]
    if first_offset > 0:
        # 首个标题之前的内容。length > 0 由 `> 0` 这个条件本身保证。
        chapters.append(_mk(0, first_offset, PREFACE_TITLE))

    for i, (offset, raw) in enumerate(heads):
        end = heads[i + 1][0] if i + 1 < len(heads) else total
        chapters.append(_mk(offset, end, normalize_title(raw, i, chapters)))

    mark_volumes(chapters, text)
    # 必须排在 mark_volumes 之后（需求 8.8）——`split_overlong` 产出的片段标题
    # `原标题(N)` 在原文里没有对应的标题行，`body_length` 的首行比对会把整段当正文，
    # 那对片段是错的判断（片段动辄几万字，标不标卷都不影响结果，但白跑一遍无意义的比对）。
    chapters = split_overlong(chapters, text)
    return SplitResult(renumber(chapters), False, cover)


def split_chapters(text: str, rule: Optional[TocRule]) -> List[Chapter]:
    """`split_book(text, rule).chapters`——只要章节表时的便捷写法。

    丢掉的是"是否兜底"这一位。写产物的 `preprocess.py` 与度量工具 `check_toc.py`
    需要那一位（`_toc.json` 的根字段 `fallback`），它们用 `split_book`。
    """
    return split_book(text, rule).chapters


# ---------------------------------------------------------------------------
# 两级兜底（design §4.5 ②③，需求 8.8 / 8.9）
# ---------------------------------------------------------------------------


def _iter_lines_in(text: str, start: int, end: int) -> Iterator[Tuple[int, int, str]]:
    """逐行铺满 `[start, end)`，产出 `(行首偏移, 下一行行首偏移, 行内容)`。

    与 `iter_lines` 的区别是这里**按区间截断**、并额外给出行尾偏移：

    - `iter_lines(limit=…)` 的 `limit` 只筛行首，跨越边界的那一行整行产出——
      它服务于"采样前 100 万字符选规则"，多读半行无所谓；
    - 切块必须严丝合缝落在 `[start, end)` 里，否则块会伸出章节范围、破坏连续覆盖。

    `next_start` 就是行终止符之后的位置，块边界只取这个值，所以 CRLF 不会被切成两半。
    末行没有终止符时 `next_start == end`。
    """
    pos = start
    while pos < end:
        match = _LINE_BREAK.search(text, pos, end)
        if match is None:
            yield pos, end, text[pos:end]
            return
        yield pos, match.end(), text[pos:match.start()]
        pos = match.end()


def _paragraph_blocks(
    text: str,
    start: int,
    end: int,
    target: int,
    *,
    min_tail: int = 0,
) -> List[Tuple[int, int]]:
    """把 `[start, end)` 铺成若干块，块长约 `target`，**优先在空行之后断开**。

    这是两级兜底共用的唯一原语：逐章兜底传 `target=CHAPTER_MAX`，
    全书兜底传 `target=FALLBACK_BLOCK`。需求 8.9 的"优先按空行、无空行再按字数在
    换行处断"在这里是**同一次遍历里的两档**，而不是两种模式：

    - 累积长度够 `target` 时，回到本块内最近的段落边界（连续空行之后）断开；
    - 本块内没有**可用**段落边界（整块就是一个长段落，或全文压根没有空行）→
      在当前行的换行处断开。

    按区域而不是按全书选档，是因为"绝大多数地方有空行、偏偏某一段几万字没有"
    是真实存在的排版；按全书二选一会为了那一段丢掉其余地方的段落边界。

    Args:
        text: 全文。
        start: 区间起点（含）。
        end: 区间终点（不含）。
        target: 目标块长，必须 > 0。
        min_tail: 末块短于此值就并入前一块；0 表示不并。

    Returns:
        `[(start0, end0), (start1, end1), …]`，首块起点 == `start`、末块终点 == `end`、
        相邻块首尾相接、每块长度 > 0。`end <= start` 时返回 `[]`。

        块长只是"约 `target`"：除末块（余数，可能很短）之外一律 >= `target // 2`，
        段落档通常不超过 `target`（顶多多出末尾那一段空行），换行档为
        `target` + 跨线那一行的长度。整段没有换行时只有一块——断点一律取行终止符
        之后的位置，不切在 CRLF 中间，更不切在一行文字中间。
    """
    if target <= 0:
        raise ValueError(f'target 必须为正，收到 {target}')
    if end <= start:
        return []

    # 段落边界档的下限：这一刀切下来不足目标的一半就不算"可用边界"，改在换行处断。
    # 没有这条线的话，"块首恰好是空行、紧跟一个几万字不分段的长段落"会切出一个
    # 2 个字符的块——实测有书整本按段落块切时切出过只有几个字符的块，就是这么来的。
    # `max(1, …)` 只为守住 `cut > block_start`（target=1 时 floor 会算成 0 而死循环）。
    floor = max(1, target // 2)

    cuts: List[int] = []
    block_start = start
    para_end: Optional[int] = None   # 本块内最近一个"连续空行之后"的偏移

    for _line_start, next_start, line in _iter_lines_in(text, start, end):
        if not line.strip():
            # 连续空行算一个段落边界，一路延到最后一个空行之后：
            # 下一块从实体文字开头，而不是从一串空行开头。
            # （strip 已覆盖 CRLF——`'\r'` 不会留在 `line` 里，它是终止符的一部分；
            #   全角空格排版的"空行"也一并算上，`str.strip()` 认 `\u3000` 是空白。）
            para_end = next_start
            continue
        # 只在非空行上判断"积够了"。空行本身不触发断开，它只是记下一个候选边界。
        while next_start - block_start >= target:
            if para_end is not None and para_end - block_start >= floor:
                cut = para_end          # 优先：段落边界
            else:
                cut = next_start        # 退而：本行的换行处
            if cut >= end:
                break                   # 已经到头，不需要在 end 处再断一刀
            cuts.append(cut)
            block_start = cut
            para_end = None
            if cut == next_start:
                break
            # 在段落边界断过之后，当前这一行归了新块，可能自己就超了 target
            # （典型：段落边界之后紧跟一个几万字的单行），所以回到 while 再判一次。

    bounds = [start, *cuts, end]
    blocks = list(zip(bounds, bounds[1:]))
    if min_tail and len(blocks) > 1 and blocks[-1][1] - blocks[-1][0] < min_tail:
        tail = blocks.pop()
        blocks[-1] = (blocks[-1][0], tail[1])
    return blocks


def _title_line_end(text: str, chapter: Chapter) -> Optional[int]:
    """章节自身标题行（含行终止符）之后的偏移；首行不是本章标题时返回 `None`。

    首行不等于 `title` 意味着"这个章节的标题不是原文里的行"——合成的
    `序章 / 前言` 与兜底块的 `第 N 部分` 都是这种。判据是严格相等，与前端跳过重复
    首段的口径一致（design §3.2 的 `paras[0].text === chapter.title`）。

    比对的左边是 `clean_title(首行)` 而不是 `首行.strip()`：`title` 本身就是
    `normalize_title` 的产物，而 `clean_title` 幂等，所以"标题取自这一行"时
    两边逐字符相等。改用 `strip()` 会在标题被净化改写的那些章上假阴性，
    把整章算成正文（少标卷）——见模块 docstring「净化与严格相等」。
    """
    start = int(chapter['start'])
    end = int(chapter['end'])
    match = _LINE_BREAK.search(text, start, end)
    if match is None:
        # 整个章节只有一行且没有终止符（末章末行）：标题行就是全部，后面没有正文。
        return end
    if clean_title(text[start:match.start()]) != chapter['title']:
        return None
    return match.end()


def split_overlong(chapters: List[Chapter], text: str) -> List[Chapter]:
    """超过 `CHAPTER_MAX` 的章节就地再切，原标题降为卷节点（需求 8.8，design §4.5 ②）。

    这是"逐章兜底"：相比旧版的全书级 all-or-nothing（命中 < 2 条才整本按字数硬切），
    90% 章节识别正确、10% 漏掉时这里只修那 10%，其余章节原样通过。

    产物形态（以 `第七章 甲` 超长为例）：

        第七章 甲          isVolume=True   ← 只覆盖原来的标题行
        第七章 甲(1)                       ← 正文按段落切出的片段
        第七章 甲(2)
        …

    降为卷节点而不是保留为可读章节，是因为它已经没有正文了（range 只剩标题行）；
    前端把 `isVolume` 渲染成不可点击的分组表头（需求 12.2），正好是这个语义。

    Args:
        chapters: `split_book` 造出的章节列表，**不就地修改**（超长章要一变多）。
        text: 全文。

    Returns:
        新列表。`id` 还是占位值，由调用方的 `renumber` 统一重写。
        连续覆盖保持不变：卷节点头 + 各片段恰好铺满原章节的 `[start, end)`。
    """
    out: List[Chapter] = []
    for chapter in chapters:
        # 卷节点跳过：它本来就只有标题行，不可能超长（真超长说明它不该被标成卷）。
        if chapter.get('isVolume') or int(chapter['length']) <= CHAPTER_MAX:
            out.append(chapter)
            continue

        start = int(chapter['start'])
        end = int(chapter['end'])
        title_end = _title_line_end(text, chapter)
        # 标题行不在原文里（合成标题），或整章就是一行没有终止符 → 没有可降级的标题行，
        # 片段直接铺满整段，不产出卷节点头。
        body_start = title_end if title_end is not None and title_end < end else start

        blocks = _paragraph_blocks(text, body_start, end, CHAPTER_MAX)
        head_length = body_start - start
        if len(blocks) == 1 and not (
            head_length > 0 and blocks[0][1] - blocks[0][0] <= CHAPTER_MAX
        ):
            # 切不出第二块，而且扣掉标题行也还是超长（整段正文是一个没有换行的
            # 超长单行）。与其产出"一个空壳卷 + 一个同样超长的 (1)"，不如原样留着，
            # 让 `check_toc.py` 的疑似误判计数把它报出来交人处理。
            #
            # 反过来，只差一点点超线的章（length 100_001、扣掉 20 字符的标题行后
            # 正文 99_981）确实只切出一块，但那一块已经合规，照常降级——否则它会
            # 永远挂在疑似误判里。
            out.append(chapter)
            continue

        if head_length > 0:
            head = dict(chapter, end=body_start, isVolume=True)
            head['length'] = head_length
            out.append(head)
        for number, (block_start, block_end) in enumerate(blocks, 1):
            out.append(_mk(block_start, block_end, f'{chapter["title"]}({number})'))
    return out


def fallback_title(number: int) -> str:
    """全书兜底块的标题（1 起）。

    沿用旧版的 `第 N 部分`，不用 `section_title` 的 `第 N 节`——后者是"标题净化成空"的
    回退，两者混用会让 `check_toc.py` 分不清"兜底书"和"标题被净化光的书"。
    """
    return f'第 {number} 部分'


def fallback_split(text: str) -> List[Chapter]:
    """全书兜底：没有规则可用时按段落块切分（需求 8.9，design §4.5 ③）。

    先按空行聚合成约 `FALLBACK_BLOCK` 字符的块并在段落边界断开，某一段没有空行时
    在换行处断——两档都在 `_paragraph_blocks` 里，见那里的说明。

    Returns:
        章节列表，标题为 `第 1 部分`、`第 2 部分`…，`id` 已经写好。
        **不含卷节点**：兜底意味着全文一个标题都没认出来，没有任何东西可以降级为卷；
        块标题是合成的，拿 `VOLUME_BODY_MAX` 去量它们只会把偶然偏短的尾块误标成卷。

        `text` 为空时返回 `[]`——空书没有章节可言，这是唯一不满足
        "`chapters[0].start == 0`" 的情形，由 `validate.py`（任务 24）判为坏产物。
    """
    blocks = _paragraph_blocks(
        text, 0, len(text), FALLBACK_BLOCK, min_tail=FALLBACK_TAIL_MIN
    )
    return renumber([
        _mk(start, end, fallback_title(number))
        for number, (start, end) in enumerate(blocks, 1)
    ])


def body_length(text: str, chapter: Chapter) -> int:
    """章节去掉自己标题行（含行终止符）之后剩下的字符数。

    design §4.5 写的是 `c["length"] - len(c["title"]) - 1`，`-1` 是标题行的换行。
    **这里不用那个式子**，两处对不上：

    1. 产物是 CRLF（任务 15），行终止符是 2 个字符而不是 1 个；
    2. `title` 已经 strip 过，而标题行可能带最多 4 个字符的缩进（`^[ \\t\\u3000]{0,4}`）。

    两项都让式子把正文算多——在 100 字符这条线上是错的方向（漏标卷节点）。
    所以从原文里实际找出标题行的终止符，直接量（见 `_title_line_end`）。

    首行不等于 `title` 时（合成的 `序章 / 前言`、兜底块 `第 N 部分`、超长章的片段
    `原标题(N)`、净化成空后的 `第 N 节`）整段都算正文。这与前端跳过重复首段的判据完全一致
    （design §3.2 也是 `paras[0].text === chapter.title` 的严格相等）。

    **标题净化不会触发这个分支**：比对左边走 `clean_title`，而 `title` 就是它的产物
    （幂等），所以被净化改写过的标题照样能认出自己的标题行、照样能被标成卷。
    这是任务 20 特意保住的等式，见模块 docstring「净化与严格相等」。
    """
    body_start = _title_line_end(text, chapter)
    if body_start is None:
        return int(chapter['end']) - int(chapter['start'])
    return int(chapter['end']) - body_start


def mark_volumes(chapters: List[Chapter], text: str) -> List[Chapter]:
    """去掉标题行后正文不足 `VOLUME_BODY_MAX` 的章节标记为卷节点（需求 8.7 / 8.7a）。

    **不修改 `start`/`end`**（design §0 修订一）：卷节点的 range 恰好覆盖它自己的
    标题行（外加后面那几个空行），照样参与需求 8.14 的严格连续覆盖。Legado 用
    `start == end` 的零长度节点，本项目不能——章节 range 含自身标题行，
    零长度会让那 6–11 个字符无归属。

    `isVolume` 只在为真时写入（design §2.1）：7000 本书 × 每章一个冗余 `false`
    是纯体积浪费，前端按 `!!c.isVolume` 读取。

    Args:
        chapters: `split_chapters` 造出的章节列表，**就地修改**。
        text: 全文，用来量真实的正文长度（见 `body_length`）。

    Returns:
        同一个列表，方便链式写。
    """
    for chapter in chapters:
        if body_length(text, chapter) < VOLUME_BODY_MAX:
            chapter['isVolume'] = True
    return chapters


def renumber(chapters: List[Chapter]) -> List[Chapter]:
    """把 `id` 重写为数组下标（design §2.1 不变量 1）。就地修改并返回同一个列表。"""
    for index, chapter in enumerate(chapters):
        chapter['id'] = index
    return chapters


def count_content_chapters(chapters: Sequence[Chapter]) -> int:
    """非卷节点的数量——这就是 `_toc.json` 的 `totalChapters`（design §2.1 不变量 4）。

    单独成函数是为了让 `preprocess.py`（写产物）与 `validate.py`（校验产物，任务 24）
    用同一个口径，避免两边各写一遍 `not c.get('isVolume')` 而漂移。
    """
    return sum(1 for chapter in chapters if not chapter.get('isVolume'))
