# -*- coding: utf-8 -*-
r"""夹具书规格与确定性文本合成（e2e-visual-testing 需求 3.3 / 3.4，design「夹具书规格」、K3）。

本模块只有**数据与纯函数**：52 本夹具书的规格表、每本书的全文合成，以及 `roles.json`
的组装。写 `.zip`、调 `scripts/preprocess.py` 的 `run()`、校验 3.3 (a)–(j)、写
`roles.json` / `record.json` 都是 `generate.py` 的事（任务 4.2），这里一个文件都不写。
只用 Python 标准库：`generate.py` 要在调用管线之前做依赖检查（需求 1.9），导入本模块
不能先一步因为缺包而失败。

    from books import SPECS, synthesize, source_bytes, source_name, build_roles

## 为什么"合成"而不是"收录样本文本"

需求 3.4 给夹具源的预算是 1 MiB，而 3.3 要一本 ≥ 3,000 节点的书、一本约 30 万字的兜底书，
全库合成出来是一百多万字。所以仓库里只放生成规则：一个种子 PRNG、一张内置字表和下面的
规格表，全文在生成时现算。摘要（`record.json` 的 `digest`）覆盖 `e2e/fixture/*.py`，
本文件任何一个字节变了，下一次运行都会重新生成夹具（需求 3.7）。

## 确定性（需求 3.5，属性 4）

- **PRNG 自己写**（SplitMix64），不用 `random`：`random.Random` 的 `randrange` /
  `choice` 等上层方法的实现随 Python 版本变过，同一个种子在不同解释器上可能出不同的数。
  这里只用 64 位整数运算，结果与解释器版本无关。
- **种子只由规格键决定**（`_seed(key)`，SHA-256），不用内置 `hash()`——后者每个进程加盐。
  每本书各自一条随机流，改一本书的规格不会让其余 51 本的文本跟着变。
- 输出里没有时间、路径或任何环境信息。

## 正文为什么碰不到任何章节规则

管线对每本书"只选一条规则"（`scripts/lib/toc_rules.py`、`toc.pick_rule`），正文里只要
有一行被某条启用规则匹中，就可能改变择一结果或多切出一个节点，夹具的目录结构就不再由
规格表决定。所以正文行在**字符层面**就排除了所有启用规则的起手式：

- 字表 `BODY_CHARS` 不含中文与阿拉伯数字（`NUM`）、`第`、`SPECIAL` 系列的首字
  （正 序 楔 引 尾 终 后 番 外 前）、章节 / 卷级单位字、`阅`（第 12 条「分节阅读」）；
  拉丁字母、装饰符号（`※` 等）与括号也不在表里；
- 每个正文段落以 `。！？` 之一收尾，所以第 11 条「书名 序号」（整行汉字、以数字结尾）
  也不成立。

于是全书的标题行恰好就是规格表写进去的那些行，与段落长短无关。`_FORBIDDEN_BODY_CHARS`
把这份排除清单写成数据，模块导入时核对字表（`_check_tables`）。

检索词同理：`CAP_KEYWORD` 等四个词的每个字都不在字表里，也不出现在任何标题里，所以它们在
书中的出现次数**恰好**是插入的次数，互不重叠（每个词的字互不相同），也不会落在标题行上
（需求 9.1 / 9.2 / 9.11）。

## 与 design「夹具书规格」表的两处出入

1. **volumes 书的章数**：表上是"卷一 → 第 1–3 章 → 卷二、卷三 → 第 4–6 章 → 卷四 →
   第 7–8 章"。照这个写，「标准章节」规则在采样评分里是 9 个有效章节对 4 个疑似误报
   （卷节点之后紧跟的标题与它相距 < 100 字符，`toc.GAP_VOLUME`），过不了 3:1 的误报门槛
   （`toc.FALSE_RATIO`），整条规则被否决，于是「卷部册集」只凭 4 个卷标题胜出，目录里
   一个章节都没有。现在是第 1–5 / 6–10 / 11–14 章：15 个有效对 4 个误报，结构（楔子在
   下标 0、卷一在下标 1、卷二卷三相邻、每个卷前后都有正文章节）与表一致。
2. **卷标题写作 `第一卷 …`**：表里的"卷一"是简称。裸 `卷一` 只有「卷部册集」认得，
   「标准章节」认的是 `第N卷`（`UNIT` 的 `卷`），而楔子与章标题也只有「标准章节」能同时
   认得——三类标题必须落在同一条规则上。

stars 书"5 段，以 `※※※` 行分隔"落地为"5 段、每段以 `※※※` 行开头"：若第一段之前没有
`※※※`，管线会给它合成一个 `序章 / 前言` 节点，3.3 (d)"全部节点标题均为 `※※※`"就不成立。

crlf 书以 CR LF 换行，另有两处段落以单独的 LF 结尾（`BookSpec.lone_lf`），让需求 10.3 的
逐字节比对同时覆盖"CR LF 原样保留"与"单独的 LF 原样保留"。

3.3 (j)（reader-defect-fixes 需求 10.2）由填充书《黄沙古道》承担：第 2 章中段多出一行
`=` × 60（`BookSpec.long_run`）。这一行在合成之后插入、不消耗 PRNG，书里其余各行与不插时
逐字相同；其余 51 本不受影响。
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Callable, Dict, FrozenSet, List, Mapping, Optional, Sequence, Tuple

__all__ = [
    'BODY_CHARS',
    'BookSpec',
    'CAP_KEYWORD',
    'CAP_KEYWORD_COUNT',
    'FEW_KEYWORD',
    'FEW_KEYWORD_COUNT',
    'HUGE_CHAPTERS',
    'LONG_RUN_CHAPTER',
    'LONG_RUN_CHAR',
    'LONG_RUN_LENGTH',
    'LONG_RUN_MIN',
    'LONG_TEXT_CHAPTER',
    'LONG_TEXT_CHAPTER_TITLE',
    'LONG_TEXT_PARAGRAPHS',
    'LONG_TEXT_TITLES',
    'NO_HIT_KEYWORD',
    'PINYIN_ABBR',
    'PINYIN_TITLE',
    'ROLES',
    'RolePlan',
    'SAME_AUTHOR',
    'SOURCE_BOM',
    'SPECS',
    'SPECS_BY_KEY',
    'STARS_SECTIONS',
    'STARS_TITLE',
    'SplitMix64',
    'VOLUMES_KEYWORD',
    'VOLUMES_KEYWORD_COUNT',
    'build_roles',
    'cn_number',
    'source_bytes',
    'source_name',
    'synthesize',
]

# ---------------------------------------------------------------------------
# 字表与排版常量
# ---------------------------------------------------------------------------

#: 源文件写成带 BOM 的 UTF-8（design「夹具书规格」）：管线按"BOM 优先"判定编码，
#: 不走统计探测，判定结果不随正文内容漂移。BOM 在解码出口就被去掉，不进 `charCount`。
SOURCE_BOM = b'\xef\xbb\xbf'

#: 正文段落的缩进：两个全角空格，中文 txt 的主流排版（`scripts/fixtures/standard-cn.txt` 同款）。
INDENT = '\u3000\u3000'

#: 正文字表：400 个常用汉字，已剔除 `_FORBIDDEN_BODY_CHARS`（见模块 docstring）。
BODY_CHARS = (
    '的了是在不有这人他我们来到时大地为子你说生国着就那和要她出也得里以会家可过天去能对小多然于心学么之都'
    '好看发当没成只如事把还用样道想作种开美总从无情己面最女但现让此明同本手知经高见行长些主意因其走给方它'
    '头又进身日相已新动很民力工使法问理全点做实将什机自老与关通被路果山声完少光才反比先性原内门风平重分向'
    '常结解白别利合定表何放西真物东边文林化带受直代眼活求却北转收处海望水感住达叫满言近界色觉死书记快难打'
    '思安更马笑车信远青花象今阳站离吃拉拿往周金特认科流空各清病深云许位须父神即影朝音飞河底石房南任雨极保'
    '火根香落冷命计板阵观亲语衣园区告报立争切必况古吗月领越江器决乐楼急怕铁步谈湖传冰灯雪茶兵队洗鸟钱写桥'
    '短树剑帮草城丝客尽静识玉松夫田料哭诗船兰尘桃柳笔红黄黑绿蓝紫灰刀弓箭旗鼓钟琴画棋酒杯盆碗筷锅墙窗帘桌'
    '椅床枕灶炉柴米油盐菜饭汤粥饼糖叶枝籽苗芽瓣露霜雾虹电雷沙泥土岩峰岭谷溪泉潭湾岛洲滩岸堤渡舟帆浪潮涛波'
)

#: 章标题里的词（两个一组拼成四字标题）。不含任何检索词的字，也不以句读收尾。
TITLE_WORDS: Tuple[str, ...] = (
    '归舟', '远山', '孤灯', '晚钟', '残雪', '新柳', '旧梦', '长亭', '细雨', '清风',
    '明月', '落花', '流水', '寒潭', '暖阳', '微光', '晨雾', '暮云', '空城', '故园',
    '远行', '初见', '重逢', '别离', '归途', '问路', '泊岸', '听潮', '望乡', '踏歌',
    '剪烛', '煮茶', '温酒', '观棋', '抚琴', '画扇', '题诗', '寻梅', '探雪', '拾叶',
    '听蝉', '闻笛', '送客', '迎春', '守岁', '渡口', '山门', '石桥', '竹屋', '柴扉',
    '松径', '溪桥', '野店', '荒村', '古寺', '高楼', '深巷', '小院', '长街', '短笛',
    '江心', '湖畔', '林间', '云端', '雨后', '霜天', '雪原', '风起', '雷动', '潮生',
)

#: 正文里一个字都不许出现的字符（模块 docstring「正文为什么碰不到任何章节规则」）。
#: 最后一组是四个检索词的字：它们只能出现在插入的位置上。
_FORBIDDEN_BODY_CHARS: FrozenSet[str] = frozenset(
    '0123456789０１２３４５６７８９'
    '〇○零一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟'
    '第'
    '正序楔引尾终后番外前'
    '章卷节回集部篇场幕话折夜萌册段页'
    '阅'
    '☆★✦✧◆◇●◎※＊'
    '【】〖〗〔〕「」『』〈〉《》（）[]()'
    '星砂琉璃盏麒麟角铜罗盘'
)

#: 子句长度与段落里子句的分隔 / 收尾标点。
_CLAUSE_CHARS = (4, 13)
_CLAUSE_JOIN = '，，，，，，，；'
_PARAGRAPH_END = '。。。。。。！？'

#: 每隔多少个段落插一个空行（段落内的空行是全书兜底 `_paragraph_blocks` 优先使用的断点）。
_BLANK_EVERY = (4, 8)

# ---------------------------------------------------------------------------
# 检索词与各用途的数字（roles.json 与 generate.py 的校验都从这里取）
# ---------------------------------------------------------------------------

#: longText 书里出现 `CAP_KEYWORD_COUNT` 次：全文检索达到 150 条上限（需求 3.3 (h)、9.1）。
CAP_KEYWORD = '星砂'

#: longText 书里出现 `FEW_KEYWORD_COUNT` 次：1 ≤ K < 150（需求 9.1）。
FEW_KEYWORD = '琉璃盏'

#: longText 书里出现 0 次（需求 9.11）。
NO_HIT_KEYWORD = '麒麟角'

#: volumes 书里出现 `VOLUMES_KEYWORD_COUNT` 次，供 A11y_Scan 的检索抽屉（需求 15.1）。
VOLUMES_KEYWORD = '铜罗盘'

#: longText 书各章的段落数。第 3 章（下标 2）是 3.3 (i) 的 ≥ 200 段章节，也是需求 9.8
#: 与 10.9–10.22 的起始章节：既非首章也非末章，正文远高于 3 屏。
LONG_TEXT_PARAGRAPHS: Tuple[int, ...] = (40, 60, 240, 60, 40)

#: longText 书各章的标题。固定而不随机，`generate.py` 据此在 `_toc.json` 里找回 `chapterIndex`。
LONG_TEXT_TITLES: Tuple[str, ...] = (
    '第一章 初雪', '第二章 听潮', '第三章 长河', '第四章 晓色', '第五章 归鸿',
)

#: `roles.longText.chapterIndex` 预期的目录下标：书以第一章开头，没有合成的序章节点。
LONG_TEXT_CHAPTER = 2
LONG_TEXT_CHAPTER_TITLE = LONG_TEXT_TITLES[LONG_TEXT_CHAPTER]

#: 各章插入的检索词个数。每段至多插一次同一个词，所以个数不能超过该章段落数。
_CAP_PLAN: Tuple[int, ...] = (30, 45, 80, 35, 20)
_FEW_PLAN: Tuple[int, ...] = (1, 2, 2, 1, 1)
CAP_KEYWORD_COUNT = sum(_CAP_PLAN)
FEW_KEYWORD_COUNT = sum(_FEW_PLAN)

#: volumes 书的卷结构：`(卷标题, 该卷之后的正文章数)`。卷二之后 0 章，即卷二、卷三相邻
#: （需求 8.13）；章数取 5 / 5 / 4 的理由见模块 docstring「两处出入」第 1 条。
_VOLUME_PLAN: Tuple[Tuple[str, int], ...] = (
    ('第一卷 云起', 5),
    ('第二卷 雪落', 0),
    ('第三卷 江湖远', 5),
    ('第四卷 归来', 4),
)

#: volumes 书每个正文章节的段落数与段长。下限 20 段 × 50 字保证相邻章标题相距 > 1,000
#: 字符，每章都计为一个有效章节（`toc.GAP_CHAPTER`），误报门槛的余量不靠运气。
_VOLUME_PARAGRAPHS = (20, 26)
_VOLUME_LENGTHS = (50, 90)

#: volumes 书里插 `VOLUMES_KEYWORD` 的位置：正文章序号（0 = 楔子）→ 段落下标。
_VOLUMES_KEYWORD_AT: Mapping[int, int] = {0: 2, 2: 5, 8: 3}
VOLUMES_KEYWORD_COUNT = len(_VOLUMES_KEYWORD_AT)

#: huge 书的章数（需求 3.3 (e)：节点数 ≥ 3,000）。每章 3 段，每段 36–60 字，
#: 去掉标题行后的正文恒 > 100 字符，不会被 `toc.mark_volumes` 判成卷节点。
HUGE_CHAPTERS = 3200

#: stars 书：段数与每段开头那一行（需求 3.3 (d)）。
STARS_SECTIONS = 5
STARS_TITLE = '※※※'

#: fallback 书的目标字符数（design：约 30 万字）。全书按约 5,000 字符一块切，约 60 个节点。
_FALLBACK_CHARS = 300_000

#: 同作者的三本书的作者（需求 3.3 (g)）。
SAME_AUTHOR = '夹具作者甲'

#: pinyin 书的书名与它的拼音首字母（需求 3.3 (f)）。其余 51 本的书名与作者都不含声母为
#: q 的字，所以子序列检索 `qstxx` 只可能命中这一本；是否真的如此由 `generate.py` 对着
#: `books.json` 核对。
PINYIN_TITLE = '青山踏雪行'
PINYIN_ABBR = 'qstxx'

#: 3.3 (j)（reader-defect-fixes 需求 10.2）：longRun 书第 `LONG_RUN_CHAPTER` 个正文章节（0 起）
#: 的中段插入一个由 `LONG_RUN_LENGTH` 个 `LONG_RUN_CHAR` 构成的段落，没有任何断行机会，
#: 供 RDF 10.1 核对正文段落不横向溢出。`=` 不在字表与任何标题里，也不是任何章节规则的
#: 起手式（`_HEAD` 之后不是 `第`、序号、单位字、括号或 `_MARK` 装饰符），插进去不改变目录。
#: plain 书以第一章开头、没有卷节点，第 2 个正文章节在 `_toc.json` 中的下标就是 1。
LONG_RUN_CHAR = '='
LONG_RUN_LENGTH = 60
LONG_RUN_MIN = 58
LONG_RUN_CHAPTER = 1

# ---------------------------------------------------------------------------
# 种子 PRNG
# ---------------------------------------------------------------------------

_MASK64 = (1 << 64) - 1


class SplitMix64:
    """SplitMix64：64 位状态、纯整数运算，输出与 Python 版本无关（模块 docstring「确定性」）。"""

    __slots__ = ('_state',)

    def __init__(self, seed: int) -> None:
        self._state = seed & _MASK64

    def next64(self) -> int:
        """下一个 64 位无符号整数。"""
        self._state = (self._state + 0x9E3779B97F4A7C15) & _MASK64
        z = self._state
        z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & _MASK64
        z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & _MASK64
        return z ^ (z >> 31)

    def below(self, n: int) -> int:
        """`[0, n)` 内的整数。取模的偏差在 n ≪ 2^64 时可忽略，而且这里要的是确定，不是均匀。"""
        if n <= 0:
            raise ValueError(f'n 必须为正，收到 {n}')
        return self.next64() % n

    def between(self, low: int, high: int) -> int:
        """`[low, high]` 内的整数（两端都含）。"""
        return low + self.below(high - low + 1)

    def pick(self, options: Sequence[str]) -> str:
        """从序列里取一项。"""
        return options[self.below(len(options))]

    def chars(self, table: str, count: int) -> List[str]:
        """从 `table` 里取 `count` 个字。每次 `next64` 拆成 4 个 16 位下标，合成百万字只需二十几万次调用。"""
        out: List[str] = []
        size = len(table)
        while len(out) < count:
            value = self.next64()
            for _ in range(4):
                out.append(table[(value & 0xFFFF) % size])
                value >>= 16
        del out[count:]
        return out

    def sample(self, n: int, k: int) -> List[int]:
        """`range(n)` 里不重复地取 `k` 个，升序返回（部分 Fisher–Yates）。"""
        if not 0 <= k <= n:
            raise ValueError(f'无法从 {n} 个里取 {k} 个')
        pool = list(range(n))
        for i in range(k):
            j = i + self.below(n - i)
            pool[i], pool[j] = pool[j], pool[i]
        return sorted(pool[:k])


def _seed(key: str) -> int:
    """规格键 → 64 位种子。SHA-256 而不是 `hash()`：后者每个进程加盐。"""
    digest = hashlib.sha256(f'e2e-fixture:{key}'.encode('utf-8')).digest()
    return int.from_bytes(digest[:8], 'big')


# ---------------------------------------------------------------------------
# 中文数字
# ---------------------------------------------------------------------------

_CN_DIGITS = '零一二三四五六七八九'
_CN_UNITS: Tuple[Tuple[int, str], ...] = ((1000, '千'), (100, '百'), (10, '十'))


def cn_number(n: int) -> str:
    """1–9999 的中文小写数字：`十一`、`一百零一`、`一千零一十`、`三千二百`。

    最长 7 个字（`一千一百一十一`），落在章节规则 `NUM{1,8}` 的上限之内。
    """
    if not 0 < n < 10000:
        raise ValueError(f'只支持 1–9999，收到 {n}')
    if n < 10:
        return _CN_DIGITS[n]
    if n < 20:
        return '十' + (_CN_DIGITS[n - 10] if n > 10 else '')
    parts: List[str] = []
    rest = n
    started = zero = False
    for value, unit in _CN_UNITS:
        digit, rest = divmod(rest, value)
        if digit:
            if zero:
                parts.append('零')
                zero = False
            parts.append(_CN_DIGITS[digit] + unit)
            started = True
        elif started:
            zero = True
    if rest:
        if zero:
            parts.append('零')
        parts.append(_CN_DIGITS[rest])
    return ''.join(parts)


# ---------------------------------------------------------------------------
# 段落、章节与各类书的合成
#
# 书在这里是"行"的列表（不带行终止符），由 `synthesize` 统一接上换行符。标题行顶格、
# 正文行带 `INDENT`，章末留一个空行——与 `scripts/fixtures/standard-cn.txt` 同一种排版。
# ---------------------------------------------------------------------------

Lines = List[str]
Builder = Callable[[SplitMix64], Lines]


def _paragraph(rng: SplitMix64, low: int, high: int, words: Sequence[str] = ()) -> str:
    """一个正文段落（不含缩进）：若干子句以 `，`/`；` 相连，以 `。！？` 收尾。

    `words` 里的每个词整体插进某个子句的某个位置。先把子句拆成单字 token、词作为一个
    token 插入，后插的词只会落在 token 之间，不会把先插的词劈开。
    """
    target = rng.between(low, high)
    clauses: List[List[str]] = []
    size = 0
    while size < target:
        clause = rng.chars(BODY_CHARS, rng.between(*_CLAUSE_CHARS))
        clauses.append(clause)
        size += len(clause) + 1
    for word in words:
        clause = clauses[rng.below(len(clauses))]
        clause.insert(rng.below(len(clause) + 1), word)
    out: List[str] = []
    for index, clause in enumerate(clauses):
        if index:
            out.append(rng.pick(_CLAUSE_JOIN))
        out.extend(clause)
    out.append(rng.pick(_PARAGRAPH_END))
    return ''.join(out)


def _chapter(
    rng: SplitMix64,
    title: str,
    paragraphs: int,
    lengths: Tuple[int, int],
    words: Optional[Mapping[int, Sequence[str]]] = None,
) -> Lines:
    """一个章节：标题行 + `paragraphs` 个正文段落（段间偶有空行）+ 章末空行。

    Args:
        words: 段落下标 → 要插进该段的检索词。
    """
    words = words or {}
    lines = [title]
    countdown = rng.between(*_BLANK_EVERY)
    for index in range(paragraphs):
        lines.append(INDENT + _paragraph(rng, *lengths, words.get(index, ())))
        countdown -= 1
        if countdown == 0 and index + 1 < paragraphs:
            lines.append('')
            countdown = rng.between(*_BLANK_EVERY)
    lines.append('')
    return lines


def _chapter_title(rng: SplitMix64, number: int) -> str:
    """`第N章 词词`。"""
    return f'第{cn_number(number)}章 {rng.pick(TITLE_WORDS)}{rng.pick(TITLE_WORDS)}'


def _build_plain(rng: SplitMix64) -> Lines:
    """普通书：5–9 章，每章 12–20 段，段长 30–90 字。每章约 1,000 字以上，规则评分稳稳可用。"""
    lines: Lines = []
    for number in range(1, rng.between(5, 9) + 1):
        lines += _chapter(rng, _chapter_title(rng, number), rng.between(12, 20), (30, 90))
    return lines


def _build_volumes(rng: SplitMix64) -> Lines:
    """楔子 → 第一卷 → 第1–5章 → 第二卷、第三卷 → 第6–10章 → 第四卷 → 第11–14章（需求 3.3 (b)）。

    卷标题只占一行加一个空行：去掉标题行后的正文不足 100 字符，由 `toc.mark_volumes`
    判为卷节点。楔子在全文开头，所以它是下标 0、第一卷是下标 1。
    """
    def chapter(title: str, number: int) -> Lines:
        at = _VOLUMES_KEYWORD_AT.get(number)
        words = {} if at is None else {at: (VOLUMES_KEYWORD,)}
        return _chapter(rng, title, rng.between(*_VOLUME_PARAGRAPHS), _VOLUME_LENGTHS, words)

    lines = chapter('楔子', 0)
    number = 0
    for volume_title, count in _VOLUME_PLAN:
        lines += [volume_title, '']
        for _ in range(count):
            number += 1
            lines += chapter(_chapter_title(rng, number), number)
    return lines


def _build_fallback(rng: SplitMix64) -> Lines:
    """没有任何标题行的约 30 万字（需求 3.3 (c)）：择一时没有规则可用，全书按段落块切。"""
    lines: Lines = []
    size = 0
    countdown = rng.between(*_BLANK_EVERY)
    while size < _FALLBACK_CHARS:
        line = INDENT + _paragraph(rng, 40, 120)
        lines.append(line)
        size += len(line) + 1
        countdown -= 1
        if countdown == 0:
            lines.append('')
            size += 1
            countdown = rng.between(*_BLANK_EVERY)
    lines.append('')
    return lines


def _build_stars(rng: SplitMix64) -> Lines:
    """5 段，每段以 `※※※` 行开头（需求 3.3 (d)）。

    只有「符号装饰」一条规则认得这一行，它是唯一候选，于是被选中。每段约 2,500 字：
    相邻命中相距 > 1,000（计为有效章节），全书远小于 18 万字（命中 5 条 < 6 时，篇幅门槛
    要求平均节点 ≤ 3 万字，`toc.Coverage.sparse`）。
    """
    lines: Lines = []
    for _ in range(STARS_SECTIONS):
        lines += _chapter(rng, STARS_TITLE, rng.between(30, 40), (40, 90))
    return lines


def _build_huge(rng: SplitMix64) -> Lines:
    """3,200 章、每章 3 段（需求 3.3 (e)）。"""
    lines: Lines = []
    for number in range(1, HUGE_CHAPTERS + 1):
        lines += _chapter(rng, _chapter_title(rng, number), 3, (36, 60))
    return lines


def _build_long_text(rng: SplitMix64) -> Lines:
    """5 章，第 3 章 240 段；按 `_CAP_PLAN` / `_FEW_PLAN` 插检索词（需求 3.3 (h)(i)）。

    每章里被选中的段落由 PRNG 不重复地抽取，同一段至多各插一次；两个词可以落在同一段。
    """
    lines: Lines = []
    plan = zip(LONG_TEXT_TITLES, LONG_TEXT_PARAGRAPHS, _CAP_PLAN, _FEW_PLAN)
    for title, paragraphs, cap, few in plan:
        words: Dict[int, List[str]] = {}
        for index in rng.sample(paragraphs, cap):
            words.setdefault(index, []).append(CAP_KEYWORD)
        for index in rng.sample(paragraphs, few):
            words.setdefault(index, []).append(FEW_KEYWORD)
        lines += _chapter(rng, title, paragraphs, (30, 90), words)
    return lines


# ---------------------------------------------------------------------------
# 规格表
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class BookSpec:
    """一本夹具书。`key` 只在夹具内部使用，book id 由管线按文件名分配。"""

    key: str
    """规格键：种子的来源，也是 `build_roles` 的 `id_of` 的键。"""

    title: str
    """书名（写进源文件名的 `《》` 里）。"""

    author: str
    """作者（写进源文件名的 `作者：` 之后）。"""

    purpose: str
    """用途，对应 design「夹具书规格」表与需求 3.3 的条目。"""

    builder: Builder
    """全文的行列表合成器。"""

    newline: str = '\n'
    """行终止符。crlf 书为 `\\r\\n`。"""

    lone_lf: Tuple[int, ...] = ()
    """在 `newline` 为 CR LF 的书里，这几章（0 起的章序号）的首个正文段落改以单独的 LF 结尾。"""

    long_run: Optional[int] = None
    """这一章（0 起的章序号）的正文中段插入 3.3 (j) 的长串段落（`LONG_RUN_CHAR` × `LONG_RUN_LENGTH`）。"""


def _filler_key(index: int) -> str:
    return f'filler-{index:02d}'


#: 填充书的书名（46 本）。与 6 本专用书合计 52 本（需求 3.3 (a) 要 ≥ 51）。
#: 书名与作者都不含声母为 q 的字，见 `PINYIN_ABBR`。
_FILLER_TITLES: Tuple[str, ...] = (
    '白鹭洲头', '碧海潮生', '沧浪之水', '晨钟暮鼓', '春风十里', '丹心照月', '东篱采菊', '飞雪连天',
    '孤帆远影', '桂花深巷', '海上明月', '寒江独钓', '红尘客栈', '湖光山色', '花间一壶', '黄沙古道',
    '江南烟雨', '金戈铁马', '锦瑟华年', '空山新雨', '兰亭旧事', '柳岸闻莺', '落日长河', '梅花三弄',
    '暮色苍茫', '南山有鹤', '霓裳羽衣', '蓬莱仙境', '烟波江上', '山河故人', '松风竹韵', '桃李春风',
    '天涯孤客', '听雨小楼', '万壑松涛', '西风瘦马', '溪山远望', '夕照长亭', '小院闲窗', '雁字回时',
    '野渡无人', '云中锦书', '月满西楼', '竹林深处', '晓风残月', '疏影横斜',
)

#: 填充书轮流使用的作者。不含 `SAME_AUTHOR`：夹具作者甲恰好 3 本（需求 3.3 (g)）。
_FILLER_AUTHORS: Tuple[str, ...] = tuple(f'夹具作者{stem}' for stem in '乙丙丁戊己庚辛壬癸')

#: 填充书里承担用途的几本（1 起的序号）。
_SAME_AUTHOR_FILLERS = (5, 23)
_CRLF_FILLER = 10
_RECENT_FILLERS = (2, 8, 14, 20, 26, 32)

#: longRun 书（3.3 (j)）：《黄沙古道》。只承担这一项用途；源文件名在全库排最后
#: （`books.json` 第 52 本），不在书架首批 50 张书卡里，书架类截图不因它的字数变化而变。
_LONG_RUN_FILLER = 16


def _fillers() -> Tuple[BookSpec, ...]:
    specs: List[BookSpec] = []
    for index, title in enumerate(_FILLER_TITLES, 1):
        author = _FILLER_AUTHORS[(index - 1) % len(_FILLER_AUTHORS)]
        newline = '\n'
        lone_lf: Tuple[int, ...] = ()
        long_run: Optional[int] = None
        purpose = '填充（3.3 (a)）'
        if index in _SAME_AUTHOR_FILLERS:
            author = SAME_AUTHOR
            purpose = '同作者（3.3 (g)）'
        elif index == _CRLF_FILLER:
            newline = '\r\n'
            lone_lf = (1, 3)
            purpose = 'crlf：CR LF 换行，第 2、4 章首段以单独的 LF 结尾（10.3）'
        elif index in _RECENT_FILLERS:
            purpose = '最近阅读的种子之一（7.13）'
        elif index == _LONG_RUN_FILLER:
            long_run = LONG_RUN_CHAPTER
            purpose = (
                f'longRun（3.3 (j)，RDF 10.2）：第 {LONG_RUN_CHAPTER + 1} 章中段一段 '
                f'{LONG_RUN_LENGTH} 个 {LONG_RUN_CHAR}'
            )
        specs.append(
            BookSpec(
                key=_filler_key(index),
                title=title,
                author=author,
                purpose=purpose,
                builder=_build_plain,
                newline=newline,
                lone_lf=lone_lf,
                long_run=long_run,
            )
        )
    return tuple(specs)


#: 全部 52 本夹具书，顺序即 `generate.py` 写源文件的顺序（书架顺序由管线按源文件名排）。
SPECS: Tuple[BookSpec, ...] = (
    BookSpec(
        key='volumes',
        title='云岭长歌',
        author=SAME_AUTHOR,
        purpose='volumes（3.3 (b)、(g)）：楔子、卷一在第 2 节点、卷二卷三相邻',
        builder=_build_volumes,
    ),
    BookSpec(
        key='fallback',
        title='无题手记',
        author='夹具作者丙',
        purpose='fallback（3.3 (c)）：无标题行，约 30 万字',
        builder=_build_fallback,
    ),
    BookSpec(
        key='stars',
        title='雨巷拾遗',
        author='夹具作者丁',
        purpose='stars（3.3 (d)）：5 段，每段以 ※※※ 行开头',
        builder=_build_stars,
    ),
    BookSpec(
        key='huge',
        title='浩瀚长卷',
        author='夹具作者戊',
        purpose='huge（3.3 (e)）：3,200 章，每章 3 段',
        builder=_build_huge,
    ),
    BookSpec(
        key='pinyin',
        title=PINYIN_TITLE,
        author='夹具作者乙',
        purpose=f'pinyin（3.3 (f)）：书名拼音首字母 {PINYIN_ABBR}',
        builder=_build_plain,
    ),
    BookSpec(
        key='long-text',
        title='长夜书灯',
        author='夹具作者己',
        purpose='longText（3.3 (h)(i)）：第 3 章 240 段，capKeyword ≥ 200 次',
        builder=_build_long_text,
    ),
    *_fillers(),
)

SPECS_BY_KEY: Mapping[str, BookSpec] = {spec.key: spec for spec in SPECS}


# ---------------------------------------------------------------------------
# 对外接口：全文、源文件字节、源文件名
# ---------------------------------------------------------------------------


def _title_lines(lines: Sequence[str]) -> List[int]:
    """章标题所在的行号。标题行以 `第` 开头，正文行不可能（字表里没有）。"""
    return [index for index, line in enumerate(lines) if line.startswith('第')]


def _lone_lf_lines(lines: Sequence[str], chapters: Sequence[int]) -> FrozenSet[int]:
    """`chapters` 里每章首个正文段落所在的行号。"""
    titles = _title_lines(lines)
    return frozenset(titles[chapter] + 1 for chapter in chapters if chapter < len(titles))


def _insert_long_run(lines: Sequence[str], chapter: int) -> Lines:
    """在第 `chapter` 章（0 起）中间那个正文段落之前插入 3.3 (j) 的长串段落，返回新的行列表。

    插入的是独立的一行（与其他正文行一样带 `INDENT`），前后都还有本章的正文段落。
    不消耗 PRNG：这本书其余的每一行都与不插时逐字相同。
    """
    titles = _title_lines(lines)
    if not 0 <= chapter < len(titles):
        raise ValueError(f'书里只有 {len(titles)} 章，没有第 {chapter + 1} 章可插长串段落')
    end = titles[chapter + 1] if chapter + 1 < len(titles) else len(lines)
    body = [index for index in range(titles[chapter] + 1, end) if lines[index].strip()]
    if len(body) < 2:
        raise ValueError(f'第 {chapter + 1} 章只有 {len(body)} 个正文段落，插不出"中段"')
    at = body[len(body) // 2]
    return [*lines[:at], INDENT + LONG_RUN_CHAR * LONG_RUN_LENGTH, *lines[at:]]


def synthesize(spec: BookSpec) -> str:
    """合成一本书的全文（不含 BOM）。同一份规格恒得到同一个字符串。

    这就是管线解码之后看到的文本：`charCount` 是它的码点数，`.txt.gz` 是它的 UTF-8 编码。
    每一行都带行终止符，全文以换行结尾。
    """
    lines = spec.builder(SplitMix64(_seed(spec.key)))
    if spec.long_run is not None:
        lines = _insert_long_run(lines, spec.long_run)
    lone = _lone_lf_lines(lines, spec.lone_lf) if spec.lone_lf else frozenset()
    return ''.join(
        line + ('\n' if index in lone else spec.newline) for index, line in enumerate(lines)
    )


def source_bytes(spec: BookSpec) -> bytes:
    """源 `.txt` 的字节：UTF-8 BOM + 全文的 UTF-8 编码。"""
    return SOURCE_BOM + synthesize(spec).encode('utf-8')


def source_name(spec: BookSpec) -> str:
    """源压缩包的文件名 `《书名》作者：作者.zip`（与 `scripts/tests` 的命名一致，design K3）。"""
    return f'《{spec.title}》作者：{spec.author}.zip'


# ---------------------------------------------------------------------------
# roles.json
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RolePlan:
    """各用途由哪本书承担（规格键），以及随用途一起写进 `roles.json` 的检索词。"""

    volumes: str
    fallback: str
    stars: str
    huge: str
    crlf: str
    pinyin: str
    same_author: Tuple[str, ...]
    long_text: str
    recent: Tuple[str, ...]
    long_run: str


ROLES = RolePlan(
    volumes='volumes',
    fallback='fallback',
    stars='stars',
    huge='huge',
    crlf=_filler_key(_CRLF_FILLER),
    pinyin='pinyin',
    same_author=('volumes', *(_filler_key(index) for index in _SAME_AUTHOR_FILLERS)),
    long_text='long-text',
    recent=tuple(_filler_key(index) for index in _RECENT_FILLERS),
    long_run=_filler_key(_LONG_RUN_FILLER),
)


def build_roles(
    id_of: Mapping[str, str], long_text_chapter_index: int, long_run_chapter_index: int
) -> Dict[str, object]:
    """组装 `roles.json` 的内容（design Data Models 的 `FixtureRoles`）。

    Args:
        id_of: 规格键 → 管线实际分配的 book id（`generate.py` 对着 `books.json` 建立）。
            缺任何一个用到的键都抛 `KeyError`：用途指向一本不在书库里的书，测试会在
            莫名其妙的地方失败，不如生成时就停下。
        long_text_chapter_index: longText 书里 `LONG_TEXT_CHAPTER_TITLE` 在 `_toc.json`
            中的下标，由调用方从产物里读出（预期为 `LONG_TEXT_CHAPTER`）。
        long_run_chapter_index: longRun 书里插了长串段落的那一章在 `_toc.json` 中的下标，
            由调用方从产物里读出（预期为 `LONG_RUN_CHAPTER`）。

    Returns:
        可直接 `json.dump` 的字典，键名与 `FixtureRoles` 一致。
    """
    return {
        'volumes': id_of[ROLES.volumes],
        'fallback': id_of[ROLES.fallback],
        'stars': id_of[ROLES.stars],
        'huge': id_of[ROLES.huge],
        'crlf': id_of[ROLES.crlf],
        'pinyin': {'id': id_of[ROLES.pinyin], 'abbr': PINYIN_ABBR},
        'sameAuthor': {
            'author': SAME_AUTHOR,
            'ids': [id_of[key] for key in ROLES.same_author],
        },
        'longText': {
            'id': id_of[ROLES.long_text],
            'chapterIndex': long_text_chapter_index,
            'capKeyword': CAP_KEYWORD,
            'fewKeyword': FEW_KEYWORD,
            'noHitKeyword': NO_HIT_KEYWORD,
        },
        'recent': [id_of[key] for key in ROLES.recent],
        'volumesKeyword': VOLUMES_KEYWORD,
        'longRun': {
            'id': id_of[ROLES.long_run],
            'chapterIndex': long_run_chapter_index,
        },
    }


# ---------------------------------------------------------------------------
# 导入时核对规格表本身（廉价、与生成无关的不变量）
# ---------------------------------------------------------------------------


def _check_tables() -> None:
    """字表、检索词与规格表的静态不变量。违反即说明本文件被改坏了，导入就失败。"""
    problems: List[str] = []
    if len(BODY_CHARS) != 400 or len(set(BODY_CHARS)) != 400:
        problems.append(f'BODY_CHARS 应为 400 个互不相同的字，实际 {len(set(BODY_CHARS))} 个')
    bad = sorted(set(BODY_CHARS) & _FORBIDDEN_BODY_CHARS)
    if bad:
        problems.append(f'BODY_CHARS 含有会触发章节规则或检索词的字：{"".join(bad)}')
    keywords = (CAP_KEYWORD, FEW_KEYWORD, NO_HIT_KEYWORD, VOLUMES_KEYWORD)
    for word in keywords:
        if len(set(word)) != len(word):
            problems.append(f'检索词 {word} 有重复的字，出现次数会因重叠而不确定')
        if set(word) & set(BODY_CHARS):
            problems.append(f'检索词 {word} 的字出现在正文字表里')
    if len({ch for word in keywords for ch in word}) != sum(len(word) for word in keywords):
        problems.append('四个检索词之间有共用的字')
    titles = ''.join(TITLE_WORDS) + ''.join(LONG_TEXT_TITLES) + ''.join(t for t, _ in _VOLUME_PLAN)
    leaked = sorted({ch for word in keywords for ch in word} & set(titles))
    if leaked:
        problems.append(f'章标题里出现了检索词的字：{"".join(leaked)}')
    if any(cap > n or few > n for cap, few, n in zip(_CAP_PLAN, _FEW_PLAN, LONG_TEXT_PARAGRAPHS)):
        problems.append('某章插入的检索词个数超过了该章段落数')
    if len(SPECS_BY_KEY) != len(SPECS):
        problems.append('规格键重复')
    if len({(spec.title, spec.author) for spec in SPECS}) != len(SPECS):
        problems.append('书名 + 作者重复：管线会给同名书加后缀，用途就对不上了')
    if sum(1 for spec in SPECS if spec.author == SAME_AUTHOR) != len(ROLES.same_author):
        problems.append(f'作者为 {SAME_AUTHOR} 的书数与 ROLES.same_author 不一致')
    if len(LONG_RUN_CHAR) != 1 or LONG_RUN_CHAR in BODY_CHARS + titles + INDENT:
        problems.append(f'长串字符 {LONG_RUN_CHAR!r} 须为单个字符，且不出现在正文字表、标题或缩进里')
    if LONG_RUN_LENGTH < LONG_RUN_MIN:
        problems.append(f'长串段落 {LONG_RUN_LENGTH} 个字符，少于 3.3 (j) 的 {LONG_RUN_MIN} 个')
    if [spec.key for spec in SPECS if spec.long_run is not None] != [ROLES.long_run]:
        problems.append('插长串段落的书应恰好是 ROLES.long_run 这一本')
    if _LONG_RUN_FILLER in (*_SAME_AUTHOR_FILLERS, _CRLF_FILLER, *_RECENT_FILLERS):
        problems.append('longRun 书还承担了别的用途（3.3 (j) 要一本只作填充的书）')
    if problems:
        raise RuntimeError('books.py 规格表自相矛盾：\n  - ' + '\n  - '.join(problems))


_check_tables()
