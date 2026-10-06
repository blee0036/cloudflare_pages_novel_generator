# -*- coding: utf-8 -*-
"""`scripts/lib/toc_rules.py` 的回归断言（任务 16，需求 8.1 / 8.6）。

运行（仓库根目录）：`python -m pytest scripts/tests -q`

这里断言的是**规则表作为数据的性质**，不是扫描/评分行为（那属于 `toc.py`）：

- 表结构：条数、顺序、名字唯一、默认启用档位；
- 输入契约：规则吃"一行原文"，缩进/行尾 `\\r` 由规则自己吸收；
- `UNIT` 排除集：每个排除项对应的那一类正文误报都要被挡住；
- 第 1 条的 SPECIAL 分支：编号章节与特殊标题归同一条规则（需求 8.1 每本书只选一条）；
- 「按书成类的编号习惯」那四组形态（第 3、7、13 条与第 9 条的裸序号分支）：每一条
  "该中"都是全库实测到的一种真标题形态，每一条"不该中"都对应一类实测到的回退；
- 每条规则的 `example` 能被自己匹配。

样本一律自拟：单位字、序号写法、分隔符、标点、缩进与长度照实测的形态来，
字面不取自任何一本书（test-data-desensitization 需求 1.2）。
"""

from __future__ import annotations

import re

import pytest

from scripts.lib import toc_rules
from scripts.lib.toc_rules import RULES, TocRule, by_name

#: design §4.3 表格的顺序。顺序是评分器提前退出/取代门槛的前提，改动必须是自觉的。
#:
#: 「单位 序号」插在第 3 位、「大写数字 冒号 标题」插在第 7 位，都是**按精度归类**：
#: 前者要求行首是一个章节单位字 + 序号 + 与第 1 条同一份后缀白名单，精度与第 1、2 条
#: 同级；后者是第 6 条的 `：` 变体，紧跟在它后面。「纯序号行」进激进档（见 AGGRESSIVE）。
EXPECTED_ORDER = (
    '标准章节',
    '卷部册集',
    '单位 序号',
    '特殊章节',
    '数字 分隔符 标题',
    '大写数字 分隔符 标题',
    '大写数字 冒号 标题',
    '拉丁章节',
    '括号装饰',
    '符号装饰',
    '书名 序号',
    '分节阅读',
    '纯序号行',
    '顶格短行',
    '通用激进',
)

#: 默认关闭的激进规则（需求 8.6）。
#:
#: 「纯序号行」在这一档不是因为它不精确，而是因为它的**对错取决于整本书**：
#: 同一个「整行只有一个序号」的形态，16 本书里是章节标题、39 本书里是章内小节号，
#: 而两类之间没有任何行级差别。理由与实测数字见 `toc_rules` 模块 docstring。
AGGRESSIVE = ('纯序号行', '顶格短行', '通用激进')


def rule(name: str) -> TocRule:
    found = by_name(name)
    assert found is not None, f'规则表里没有 {name}'
    return found


# ---------------------------------------------------------------------------
# 表结构
# ---------------------------------------------------------------------------


def test_rule_order_matches_design_table():
    assert tuple(r.name for r in RULES) == EXPECTED_ORDER


def test_names_are_unique():
    names = [r.name for r in RULES]
    assert len(set(names)) == len(names)


def test_only_aggressive_rules_are_disabled_by_default():
    disabled = tuple(r.name for r in RULES if not r.enabled)
    assert disabled == AGGRESSIVE


def test_aggressive_rules_come_last():
    positions = [i for i, r in enumerate(RULES) if r.name in AGGRESSIVE]
    assert positions == list(range(len(RULES) - len(AGGRESSIVE), len(RULES)))


@pytest.mark.parametrize('toc_rule', RULES, ids=[r.name for r in RULES])
def test_every_pattern_is_anchored(toc_rule: TocRule):
    # 行首锚写进规则自己，误用 search() 也不会从行中间匹出标题
    assert toc_rule.pattern.pattern.startswith(('^', '(?:^')), toc_rule.name
    assert toc_rule.pattern.pattern.endswith('$'), toc_rule.name
    assert not toc_rule.pattern.flags & re.MULTILINE, f'{toc_rule.name} 不该开 MULTILINE'


def test_by_name_reaches_disabled_rules():
    # 覆盖表（任务 21）要靠它显式点名启用激进规则
    assert rule('顶格短行').enabled is False
    assert by_name('不存在的规则') is None


# ---------------------------------------------------------------------------
# example 字段既是文档也是数据
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('toc_rule', RULES, ids=[r.name for r in RULES])
def test_example_matches_its_own_rule(toc_rule: TocRule):
    assert toc_rule.example, f'{toc_rule.name} 缺 example'
    assert toc_rule.match(toc_rule.example), (
        f'{toc_rule.name} 的 example 匹配不上自己：{toc_rule.example!r}'
    )


# ---------------------------------------------------------------------------
# 输入契约：吃"一行原文"，不是 strip 过的候选
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('indent', ['', ' ', '  ', '\t', '\u3000', '\u3000\u3000'])
def test_indent_is_absorbed_by_the_rules(indent: str):
    assert rule('标准章节').match(f'{indent}第二十七章 夜行')


def test_carriage_return_is_tolerated():
    # 规范做法是 splitlines()，但按 split('\n') 切 CRLF 文本时也不该全表失效
    assert rule('标准章节').match('第二十七章 夜行\r')
    assert rule('标准章节').match('第二十七章\r')
    assert rule('特殊章节').match('楔子\r')


def test_trailing_whitespace_is_absorbed():
    assert rule('标准章节').match('第二十七章 夜行   ')
    assert rule('标准章节').match('第二十七章\u3000')


def test_top_flush_rule_needs_the_unstripped_line():
    # 第 14 条靠 `^\S` 判顶格。喂 strip() 过的行会让每一行都"顶格"，
    # 这条断言把契约钉死：调用方不许预先 strip。
    top_flush = rule('顶格短行')
    assert top_flush.match('灯下')
    assert not top_flush.match('  灯下')
    assert not top_flush.match('\u3000灯下')


# ---------------------------------------------------------------------------
# UNIT 的后缀白名单：每条陷阱都对应一类真实的正文误报
#
# 旧版给每个单位字挂后继字黑名单（`节(?!课)`、`场(?![和合比电是])`、`幕` 不设防），
# 六个字挡不住开放集合的句子：7681 本库抽检出约 3400 个伪边界，受害最重的几本书里
# 将近一半的节点是正文行。现在改成"单位字后面必须是分隔符，或者 ≤6 个不含句读点的
# 字符再接行尾/开符号"（`toc_rules._UNIT_TAIL`）。
# 下面两组样本按实测形态自拟：`UNIT_TRAPS` 是旧黑名单挡得住的，`PROSE_HITS` 是它
# 漏掉的。两组新约束都要挡——它必须是旧黑名单的**超集**。
# ---------------------------------------------------------------------------

UNIT_TRAPS = [
    '第45节课留下的作业他一道没做',   # 旧：节(?!课)
    '第三集合点设在河对岸的林子里',    # 旧：集(?![合和团])
    # 实测误报的形态：`团` 少了这一项，这行会被当成"第五集"的标题
    '第五集团军，三天前就开到了城下，一直按兵不动。',   # 旧：集(?![合和团])
    '第五部分的证明放到附录',          # 旧：部(?![分赛游门落])
    '第四回合过后她已力竭',            # 旧：回(?![合来事去])
    '第二场和棋下完天已经黑了',        # 旧：场(?![和合比电是])
    '第九篇张贴在城门的布告',          # 旧：篇(?!张)
]

#: 按 100 本抽检里的正文误报形态自拟的句子，旧黑名单**全部漏掉**。
#: 每一行对应产物里一类真实的伪章节边界，触发单位集中在 节 / 场 / 幕 / 部。
PROSE_HITS = [
    '\u3000\u3000第一节读完，12个人里有9个已经开始打瞌睡了。',
    '\u3000\u3000第三场，客队换上了全部替补，最后还是以61比47赢了下来。',
    '\u3000\u3000第二节铃声响起，开考。',
    '\u3000\u3000第一场雨过后，河水涨了半尺，渡口停了三天。',
    '\u3000\u3000第二幕马上开演。',
    '\u3000\u3000第三节是自习，他趴在桌上睡了一整节。',
    '\u3000\u3000第一部录音她已经反复听了三遍，于是直接点开了第二部。',
    # 同批样本里的其他形态
    '\u3000\u3000第四节哨声一响，老周却连抬头看一眼的心思都没有。他还在想早上那通电话。',
    '\u3000\u3000第三节结束，4号拿了27分，替补席上的7号也有19分！',
    '\u3000\u3000第二场演出取消。',
    '\u3000\u3000第三场的对弈，关系到谁能留在山上继续学棋。',
    '\u3000\u3000第二节下课以后，小林跑到走廊上喊：“班长，老师叫你过去一趟。”',
]


@pytest.mark.parametrize('line', UNIT_TRAPS + PROSE_HITS,
                         ids=[line.strip()[:14] for line in UNIT_TRAPS + PROSE_HITS])
def test_unit_tail_rejects_body_lines(line: str):
    assert not rule('标准章节').match(line), f'后缀白名单漏了：{line}'


#: 全库实测到的真标题形态，按形态自拟，一条都不许丢。`第N节`/`第N回合`/`第N部分`
#: 在这里是**章节单位**而不是量词：有书整本都是 `第N节 标题`、`第N回合 标题`、
#: `第N部分 标题` 这样的写法。
SAMPLE_TITLES = [
    '第一章 雨夜来客（上）',
    '第0007章 赶集',
    '第003章：一觉醒来',
    '第一千一百二十四章 归来（大结局）',
    '第六集 山高水远',
    '第二卷 江上孤帆 第〇三章 赶路',
    '第517章',                       # 裸编号，没有标题
    '番外 重逢',
    '尾声',
    '第047节 北岭旧矿',              # `第N节` 就是这类书的章节形态
    '第六百二十八节',                # 同一形态的裸编号
    '第二回合 八十三',               # `回合` 是章节单位，旧黑名单把这种写法全否了
    '第二部分 入秦',                 # `部分` 同理
    '第四部回顾',                    # 单位字直接接短标题
    '第十九节雨夜里的车站',          # 漏了分隔符的真标题（尾巴恰好 6 个字）
    '第四十一回问剑',
    '第二卷【雪落孤城】',            # 装饰符号直接顶上来
    '第二十卷（完结卷） 长夜 第一章 旧城的灯火',   # 卷名带括注，再接章号与章名
    '第二卷江湖路远 第一章 三个约定',              # 卷名 + 章号的复合长标题
    '第五卷七章 旧日来信',                         # 卷号直接接章号
    '第四百零八章·二',               # `·` 是真分隔符
    '第三卷－长街夜话',              # 全角连字符同理
    '第0517章尘埃落定！',            # `章` 不设防：全库 24443 条这种真标题
    '第二幕 镜中花',
    '第三折 隔江听雨',
    '第47话-迷路的旅人',
]


@pytest.mark.parametrize('line', SAMPLE_TITLES, ids=[t[:16] for t in SAMPLE_TITLES])
def test_unit_tail_keeps_real_titles(line: str):
    assert rule('标准章节').match(line), f'后缀白名单误杀真标题：{line}'


@pytest.mark.parametrize(
    'line',
    [
        '第38节 课后', '第二集 合体', '第六集 团圆', '第三部 分野',
        '第一回 合谋', '第五场 和棋', '第七篇 张三',
    ],
)
def test_unit_tail_does_not_over_reject(line: str):
    # 有分隔符的正常标题不受影响——即使标题正好以旧黑名单里的字开头
    assert rule('标准章节').match(line)


def test_the_tail_length_bound_is_the_line_between_title_and_sentence():
    # `_UNIT_TAIL_MAX` 取 6 的理由：UNIT_TRAPS 里最短的那条尾巴是 7 个字
    # （`第四回合过后她已力竭` → `合过后她已力竭`），放宽到 8 就会把
    # `第五部分的证明放到附录`（尾巴 8 个字）一起放进来。
    assert toc_rules._UNIT_TAIL_MAX == 6
    assert rule('标准章节').match('第一节' + '甲' * 6)
    assert not rule('标准章节').match('第一节' + '甲' * 7)
    # 句读点比字数先起作用：6 个字里带一个逗号就不算标题
    assert not rule('标准章节').match('第一节甲，乙')
    # 分隔符那一档不受字数限制（真标题可以很长）
    assert rule('标准章节').match('第一节 ' + '甲' * 30)


# 第 2 条走的是 `_VOL`（卷/部/册/集/篇），与 `UNIT` 各自成串。
# 只改一边就会漏：`_VOL` 的 `集(?![合和])` 曾少 `团`，于是 `第五集团军，…` 一类正文行
# 逃过第 1 条却被第 2 条当成标题。
VOL_TRAPS = [
    '第五集团军，三天前就开到了城下，一直按兵不动。',
    '第三集合点设在河对岸的林子里',
    '第五部分的证明放到附录',
    '第九篇张贴在城门的布告',
]


@pytest.mark.parametrize('line', VOL_TRAPS)
def test_volume_rule_shares_the_unit_tail(line: str):
    assert not rule('卷部册集').match(line), f'_VOL 的后缀白名单漏了：{line}'
    # 同一行也不该被第 1 条吃掉——两条规则的约束必须同时生效
    assert not rule('标准章节').match(line)


@pytest.mark.parametrize('line', ['第六集 团圆', '第二集 合体', '第三部 分野', '第七篇 张三'])
def test_volume_rule_tail_does_not_over_reject(line: str):
    assert rule('卷部册集').match(line)


#: `UNIT` 与 `_VOL` 共有的单位字。`章` 只在 `UNIT` 里，`册` 只在 `_VOL` 里。
SHARED_UNITS = ('卷', '部', '集', '篇')

#: 喂给共有单位字的后缀，正反两类都要有。
SHARED_TAILS = (
    '', ' 标题', '：标题', '·标题', '【标题】', '标题', '标题啊啊啊啊啊',
    '分的证明放到附录', '团军，三天前就开到了城下，一直按兵不动。', '，标题',
    '完。', '的第1页，第二卷的第2页，第三卷的第3页，依此类推。',
)


def test_vol_and_unit_agree_on_the_same_unit_chars():
    # 行为性断言：同一个单位字在两条规则上必须给出**同一个**答案。
    # 这比"两个片段的正则文本相同"更严——`集` 漂移那次就是文本不同、行为不同。
    for unit in SHARED_UNITS:
        for tail in SHARED_TAILS:
            line = f'第一{unit}{tail}'
            standard = bool(rule('标准章节').match(line))
            volume = bool(rule('卷部册集').match(line))
            assert standard == volume, (
                f'{line!r}：标准章节={standard} 卷部册集={volume}，'
                '同一个单位字在两条规则上判得不一样'
            )


def test_vol_and_unit_are_built_from_the_same_guard():
    # 结构性断言：共有单位字的约束来自同一个入口 `_guarded`，
    # 所以不可能只改一边。`卷` 在 `_UNIT_FREE` 里（裸放），其余三个带白名单。
    assert toc_rules._UNIT_TAIL in toc_rules.UNIT
    assert toc_rules._UNIT_TAIL in toc_rules._VOL
    for unit in SHARED_UNITS:
        free = unit in toc_rules._UNIT_FREE
        assert free == (unit in toc_rules._VOL_FREE), f'{unit} 两边的档位不一致'
        assert (unit in toc_rules._UNIT_GUARDED) == (unit in toc_rules._VOL_GUARDED), (
            f'{unit} 两边的档位不一致'
        )
        assert free != (unit in toc_rules._UNIT_GUARDED), f'{unit} 必须恰好属于一档'


#: `第N日` / `第N天` / `第N扇` 永远不是章节标题（项目负责人的决定，理由与受影响的
#: 4 本书见 `toc_rules._UNIT_GUARDED` 上方的注释）。前四条是裸序数；后四条是序数后面
#: 接一个短词，正文里最常见的就是这种形态，正是这个决定要防的。
DAY_UNIT_LINES = (
    '第二日', '第二十日', '第三天', '第八天',
    '第三天傍晚', '第二日 黄昏', '第三天 报到', '第二扇窗',
)


@pytest.mark.parametrize('line', DAY_UNIT_LINES)
def test_day_units_are_never_chapter_headings(line: str):
    # 查**每一条**默认启用的规则，不只标准章节：`单位 序号`、`数字 分隔符 标题`
    # 之类任何一条认了它，这些书就会从兜底被拉回一张误报目录
    matched = [r.name for r in RULES if r.enabled and r.match(line)]
    assert matched == [], f'{line!r} 被 {matched} 当成了标题'


def test_only_the_counter_word_units_are_guarded():
    # `章` 与 `卷` 故意不设防，理由在 `_UNIT_FREE` 的注释里（实测收益为负）。
    assert toc_rules._UNIT_FREE == '章卷'
    # `夜`/`萌` 是后补的两个生僻章节单位，与其他量词同档带后缀白名单。
    assert set(toc_rules._UNIT_GUARDED) == set('节回集部篇场幕话折夜萌')
    # `第N章` + 直接接标题：全库 24443 条真标题是这个形态，不许否
    assert rule('标准章节').match('第二百章那年冬天的第一场雪')
    # `第N卷` + 卷名 + 章号：有书全书几百条都是这种写法，不许否
    assert rule('标准章节').match('第三卷山河故人 第一章 渡口')


# ---------------------------------------------------------------------------
# 第 1 条的 SPECIAL 分支
#
# 需求 8.1 对一本书只选一条规则，所以"`第N章` + 独立成行的 `楔子`/`番外`/`后记`"这种
# 常见排版必须由同一条规则全部认下来，否则选中第 1 条的书会整段丢标题。
# 第 3 条仍在表里，服务只有特殊标题、没有编号章节的书。
# ---------------------------------------------------------------------------

SPECIAL_TITLES = [
    '序',
    '序章 雪夜',
    '楔子',
    '引子',
    '尾声',
    '终章',
    '后记：写在最后',
    '番外1',
    '番外二 后来的事',
    '外传 少年游',
    '前言',
    '正文',
]


@pytest.mark.parametrize('line', SPECIAL_TITLES)
def test_standard_rule_also_takes_special_titles(line: str):
    assert rule('标准章节').match(line), f'第 1 条漏了特殊标题：{line}'


@pytest.mark.parametrize('line', SPECIAL_TITLES)
def test_special_rule_keeps_its_own_coverage(line: str):
    # 合并不是搬走：第 3 条的覆盖面一字未动
    assert rule('特殊章节').match(line), f'第 3 条漏了特殊标题：{line}'


@pytest.mark.parametrize(
    'line',
    [
        '序列号是这样的一串东西',      # 裸 `序` 后面必须是分隔符或行尾
        '正文完',
        '正文结束了',
        '楔子被塞进了轮子下面，这样有助于稳定车体',
    ],
)
def test_special_branch_does_not_eat_body_lines(line: str):
    # SPECIAL 分支沿用第 3 条的 _TAIL_SEP 契约，不是更宽松的 _TAIL
    assert not rule('标准章节').match(line), f'SPECIAL 分支吞了正文行：{line}'
    assert not rule('特殊章节').match(line)


def test_standard_rule_keeps_numbered_chapters():
    # 两个分支互不干扰
    assert rule('标准章节').match('第二十七章 夜行')
    assert rule('标准章节').match('第1024章 终局')


# ---------------------------------------------------------------------------
# 按书成类的编号习惯：第 3、7、13 条与第 9 条的裸序号分支
#
# 每条下面的"该中"都是全库扫描里实测到的一种真标题形态，"不该中"都是同一批扫描里
# 被挡掉的正文形态，或者是实测证明必须挡掉的形态。样本按形态自拟。
# ---------------------------------------------------------------------------

#: 第 3 条「单位 序号」：单位字在前、序号在后。5 本书、共 1775 条真标题。
UNIT_LEAD_TITLES = [
    '段二 灯下',
    '段四二 夜渡',               # 位置制中文数字（四二 = 42）
    '段七五 回营',
    '段二 风急雁声寒',
    '章二 归乡',
    '章二十九 议和',
    '章三 孤雁 上',
    '章七 最后的告别 下',
    '章四十一 取舍',
    '\u3000\u3000章二 别离',     # 缩进写法
    '章五',                      # 裸编号：后缀白名单的行尾那一档
    '章27 乙',                   # 阿拉伯序号同样认
    '段二【雪夜孤舟】',          # 开符号顶上来
]


@pytest.mark.parametrize('line', UNIT_LEAD_TITLES, ids=[t.strip()[:14] for t in UNIT_LEAD_TITLES])
def test_unit_lead_takes_real_titles(line: str):
    assert rule('单位 序号').match(line), f'第 3 条漏了真标题：{line}'


#: 第 3 条不许中的：`_UNIT_TAIL` 那份后缀白名单在序号之后同样生效。
UNIT_LEAD_TRAPS = [
    '段二章的写法她改了五遍',      # 尾巴 9 个字 > 6
    '段二，她没有作声',            # 句读点
    '章二十节课留下的作业他一道没做',
    '段二场和棋下完天已经黑了',
    '章四。',                      # 句读点，即便很短
    '章节目录',                    # `节` 不在 `_UNIT_LEAD` 里，且这里根本没有序号
    '卷二 雪夜归舟',               # 卷级单位是第 2 条的活，不许两条都中
    '话一说完，坐在对面的两个人都愣住了，谁也没有再开口',   # 正文：`话` 不在 `_UNIT_LEAD` 里
    '夜一：别回头，快跑！',        # `夜一` 是个角色名，后面接一句台词
    '折两百只纸鹤',                # 量词 `折`
]


@pytest.mark.parametrize('line', UNIT_LEAD_TRAPS, ids=[t[:14] for t in UNIT_LEAD_TRAPS])
def test_unit_lead_rejects_body_lines(line: str):
    assert not rule('单位 序号').match(line), f'第 3 条吞了正文行：{line}'


def test_a_unit_lead_prose_line_is_rejected():
    # 全库 1776 条 `章`/`段` + 序号命中里唯一的非标题，形态如下：`段一` 恰好是句首
    # 人名的前两个字，后面两个字接开符号 `《` 正好落进 `_UNIT_TAIL` 的②档。
    # 规则层认下了它；那本书有几百条 `第N章` 真命中，所以规则选择不受影响，
    # 而这一行缩进 + 句子形，会被 `toc.filter_prose_hits` 否掉——第二道防线。
    from scripts.lib.toc import is_indented, is_sentence_shaped

    line = '\u3000\u3000段一凡在《雪夜行舟》里只演了一个配角，却凭这场戏拿下了新人奖。'
    assert rule('单位 序号').match(line), '这条残留是量过的，不要悄悄改掉'
    assert is_indented(line) and is_sentence_shaped(line), '否则就没有第二道防线'


def test_unit_lead_is_limited_to_the_two_measured_unit_chars():
    # 把单位集扩成 `章段回节话折幕场夜` 之后全库只多出 25 条命中、一条真标题都没有，
    # 而且一本书都没换规则——纯增误报面。这条断言把那个结论钉住。
    assert toc_rules._UNIT_LEAD == r'[章段]'
    for unit in '回节话折幕场夜集篇部册':
        assert not rule('单位 序号').match(f'{unit}一 标题'), unit


def test_unit_lead_shares_the_unit_tail_with_the_standard_rule():
    # 结构性断言：判"序号后面像不像标题"用的是同一份 `_UNIT_TAIL`，不是复制一份。
    assert toc_rules._UNIT_TAIL in rule('单位 序号').pattern.pattern
    # 行为性：同一条尾巴，`第一节X` 与 `章一X` 给出同一个答案
    for tail in ('', ' 标题', '：标题', '甲' * 6, '甲' * 7, '甲，乙', '【甲】'):
        standard = bool(rule('标准章节').match(f'第一节{tail}'))
        lead = bool(rule('单位 序号').match(f'章一{tail}'))
        assert standard == lead, f'尾巴 {tail!r}：标准章节={standard} 单位 序号={lead}'


#: 第 1 条新收的两个章节单位。
EXOTIC_UNIT_TITLES = [
    '第三夜 纸伞妖',
    '第五夜 唐伞',
    '第二十八夜 旧校舍七不思议之镜中人',
    '第十二夜 古宅七怪谈之夜啼石〔二〕',
    '第二萌、误入剑修学堂',                 # 序号一路写到四位数，见下一条
    '第一零八二萌、完结篇',
    '第三○五回',                            # 白圈当"零"这个数位
    '第二○○章 乙',
]


@pytest.mark.parametrize('line', EXOTIC_UNIT_TITLES, ids=[t[:14] for t in EXOTIC_UNIT_TITLES])
def test_standard_rule_takes_the_exotic_units(line: str):
    assert rule('标准章节').match(line), f'第 1 条漏了：{line}'


@pytest.mark.parametrize('line', [
    '第二夜她坐在窗前一直等到天亮',         # 尾巴超长
    '第三夜，她还是没有来。',               # 句读点
    '第二萌犹豫了半天还是没有说出口',
])
def test_exotic_units_still_obey_the_tail_whitelist(line: str):
    assert not rule('标准章节').match(line), f'新单位字绕过了后缀白名单：{line}'


#: 收进 `夜` 之后全库多出来的**全部**正文命中，一条不漏（`萌` 一条都没有）：
#: 3 本书各 1 条。它们绕过后缀白名单不是因为 `夜` 特殊，而是因为 `_UNIT_TAIL` 本来就有
#: 两个宽口子——分隔符那一档（`、` 之后标题不限长）与开符号那一档（`《`）；
#: `第N节`/`第N场` 也有同样的残留。
#:
#: 前两条是句子形 + 缩进，交给 `toc.filter_prose_hits` 的第二道防线。第三条
#: **两道都挡不住**：它缩进、但既没有句读点也不长。那本书有几百条
#: `第N章` 真命中，所以规则选择与 `n_ok` 都不动，代价是产物里多一个伪边界。
#: 一个伪边界换来一本书从寥寥几个巨型节点变成几十个真章节——收下。
#:
#: 下面三条按那 3 行的形态自拟。
EXOTIC_UNIT_RESIDUE_FILTERED = [
    '\u3000\u3000第三夜、阿青、小满，各守擂台一角，谁也不肯先出手。',   # `、` 之后接人名
    '\u3000\u3000第二夜、第三夜、第四夜……转眼就是一个月。',            # 一串序数
]

#: 两道防线都挡不住的那一类。按它的形态自拟一条列在这里，让这个代价有据可查，
#: 而不是"不知道有多少"。
EXOTIC_UNIT_RESIDUE_SURVIVING = '\u3000\u3000第九夜工坊《长歌》美术设计组'   # 开符号那一档


@pytest.mark.parametrize('line', EXOTIC_UNIT_RESIDUE_FILTERED,
                         ids=[t.strip()[:14] for t in EXOTIC_UNIT_RESIDUE_FILTERED])
def test_the_exotic_unit_residue_is_left_to_the_prose_filter(line: str):
    from scripts.lib.toc import is_indented, is_sentence_shaped
    assert rule('标准章节').match(line), '这条残留的存在本身就是量过的，不要悄悄改掉'
    assert is_indented(line) and is_sentence_shaped(line), (
        f'残留必须落在 filter_prose_hits 的合取条件里，否则就没有第二道防线：{line}'
    )


def test_the_one_residue_that_both_layers_miss_is_named():
    from scripts.lib.toc import is_indented, is_sentence_shaped
    line = EXOTIC_UNIT_RESIDUE_SURVIVING
    assert rule('标准章节').match(line)
    assert is_indented(line) and not is_sentence_shaped(line), (
        '如果这一行变成句子形了，说明判据动过，请重新实测 `夜` 的代价'
    )


def test_the_white_circle_digit_stays_out_of_the_global_num():
    # `○` 同时是 `_MARK` 里的装饰符号，放进全局 `NUM` 会让第 11 条把装饰行当标题。
    assert '○' not in toc_rules.NUM
    assert '○' in toc_rules._NUM_O
    assert not rule('书名 序号').match('丁戊己○○○')
    assert rule('符号装饰').match('○○○ 巷口')


#: 第 7 条「大写数字 冒号 标题」：有书全书几十条都是这种写法。
CNUM_COLON_TITLES = [
    '\u3000\u3000一：旧城',
    '\u3000\u3000三：归途',
    '十五：远行',
    '二十八：灯火',
    '九：余数',            # 第 6 条的 MISSES 之一，正是这一条规则的目标
    '二:半角冒号也认',
]


@pytest.mark.parametrize('line', CNUM_COLON_TITLES, ids=[t.strip()[:12] for t in CNUM_COLON_TITLES])
def test_cnum_colon_takes_real_titles(line: str):
    assert rule('大写数字 冒号 标题').match(line)


@pytest.mark.parametrize('line', [
    '一：',                      # 标题必须非空
    '\u3000\u3000一：\u3000',    # `\S.{0,39}` 而不是 `_TITLE_REQ`：全角空格不算标题
    '他说：你好',                # 行首必须是中文数字
    '2：1',                      # 阿拉伯数字归第 5 条，这条只认中文数字
    '第一章：甲',                # 有 `第` 就是第 1 条的活
    '一，他没有回答',            # 逗号不是冒号
])
def test_cnum_colon_misses(line: str):
    assert not rule('大写数字 冒号 标题').match(line)


def test_cnum_colon_does_not_leak_into_the_separator_rule():
    # 第 6 条的 `_SEP_CN` 必须仍然排掉 `：`/`，`——它服务 1094 本书，不能动。
    assert '：' not in toc_rules._SEP_CN
    assert not rule('大写数字 分隔符 标题').match('十：整数')
    assert not rule('大写数字 分隔符 标题').match('一，他没有回答')


#: 第 9 条新增的裸序号分支：括号里只有序号，后面**必须**跟标题。
BRACKET_SERIAL_TITLES = [
    '【017】旧馆疑云',                 # 三位补零的阿拉伯序号
    '【246】棋局初开',
    '【308】阿青和小满',
    '【二、旧书店的来信】',            # 序号与标题都在括号里
    '【七、新的守夜人】',
    '\u3000\u3000〔二〕梅雪争春',      # 缩进 + 六角括号
    '\u3000\u3000〔三七〕过江龙',
    '\u3000\u3000〔一五六〕问归途',
    '\u3000\u3000〔二○○〕守城之策',   # 白圈当"零"
    '\u3000\u3000【二 城门夜开】',
    '\u3000\u3000【2.灯下说旧事】',
    '\u3000\u3000【3、沉默是金】',
    '（2） 心急吃不了热豆腐',
    '\u3000\u3000[二]他真的忘了吗？',
    '    [2]雨停了，我们再出发。',
]


@pytest.mark.parametrize('line', BRACKET_SERIAL_TITLES,
                         ids=[t.strip()[:16] for t in BRACKET_SERIAL_TITLES])
def test_bracket_serial_takes_bracketed_titles(line: str):
    assert rule('括号装饰').match(line), f'第 9 条漏了：{line}'


#: 第 9 条不许中的。前四条是"括号里只有序号、后面没有标题"——实测允许它们会让
#: 13 本书把章内小节号当章节标题（带标题的章被数量多出好几倍的 `【1】` 取代，
#: 有的还会切出巨型节点）。
BRACKET_SERIAL_MISSES = [
    '\u3000\u3000【2】',
    '\u3000\u3000（二）',
    '\u3000\u3000〔五〕',
    '\u3000\u3000【2.3】',           # 章内小节号：序号 2 + `.` + "标题" 3】，标题不许以数字开头
    '（一只猫趴在窗台上）',         # `只` 既不是闭符号也不是分隔符
    '《五百零一问》',               # 书名号里不是纯序号
    '（三，四）',                   # 逗号不在 `_SEP_CN` 里
    '【1998年的那场雪】',           # 年份：`年` 既不是闭符号也不是分隔符
]


@pytest.mark.parametrize('line', BRACKET_SERIAL_MISSES,
                         ids=[t.strip()[:16] for t in BRACKET_SERIAL_MISSES])
def test_bracket_serial_requires_a_title(line: str):
    assert not rule('括号装饰').match(line), f'第 9 条不该中：{line}'


def test_bracket_rule_keeps_its_original_coverage():
    # 新分支是并列加的，旧的三种形态一字未动
    for line in ('【第一章 夜行】', '（楔子）', '「第十二回 夜宴', '【Chapter 3】'):
        assert rule('括号装饰').match(line), line


#: 第 13 条「纯序号行」：整行只有一个序号，裸写或者裹在一对装饰括号里。
NUMERAL_LINE_TITLES = [
    '\u3000\u3000二',              # 缩进的中文数字
    '    九',
    '\u3000\u3000四十二',
    '肆', '伍', '陆', '玖',        # 大写数字
    '\u3000\u30002',               # 缩进的阿拉伯数字
    '\u3000\u300047',
    '02',                          # 补零写法
    '987',
    '【二】', '【十七】',          # 裹在一对装饰括号里
    '\u3000\u3000【02】',
    '〔六〕',
    '（2）',
    '零',
]


@pytest.mark.parametrize('line', NUMERAL_LINE_TITLES, ids=[t.strip() for t in NUMERAL_LINE_TITLES])
def test_numeral_line_takes_real_titles(line: str):
    assert rule('纯序号行').match(line)


#: 第 13 条的对抗样本。一行只有 `一` 在中文里极其常见，所以这条规则本来就危险到
#: 必须 opt-in；即便如此，"整行**只有**序号"这个边界也要卡死——多一个字符都不算。
NUMERAL_LINE_MISSES = [
    '一。',                  # 句读点
    '一、',                  # 分隔符：那是第 6 条的形态（`一、标题`）
    '一个人',                # 序号后面还有字
    '第一',                  # `第` 不是序号字符
    '一 甲',                 # 序号后面有标题 → 第 6 条 / 第 11 条的活
    '2010',                  # 4 位阿拉伯数字：独占一行时是年份
    '1234',
    '一2',                   # 中文与阿拉伯混写不是序号
    '【一',                  # 半边括号
    '一】',
    '【一】甲',              # 括号后面有标题 → 第 9 条的活
    '（一）（二）',          # 两组括号
    '一\u3000二',            # 两个序号
    '',
    '\u3000\u3000\u3000\u3000\u3000一',   # 缩进超过 `_HEAD` 的 4 个字符
]


@pytest.mark.parametrize('line', NUMERAL_LINE_MISSES, ids=[t.strip() or 'empty' for t in NUMERAL_LINE_MISSES])
def test_numeral_line_misses(line: str):
    assert not rule('纯序号行').match(line), f'第 13 条不该中：{line!r}'


def test_numeral_line_arabic_is_capped_at_three_digits():
    # 1–999 覆盖了所有需要它的书（实测这类书的序号最多只到两位数）；
    # 4 位的裸数字行几乎总是年份，收进来只会给年表类文本刷命中。
    assert rule('纯序号行').match('999')
    assert not rule('纯序号行').match('1000')
    # 中文数字放到 8 位（`九千八百七十六` 只有 7 个字）
    assert rule('纯序号行').match('九千八百七十六')


def test_numeral_line_is_opt_in():
    # 这条断言是整个决定的锚：默认参与自动判定会让 39 本书变坏、16 本变好。
    assert rule('纯序号行').enabled is False


# ---------------------------------------------------------------------------
# 逐条：该中的中、不该中的不中
# ---------------------------------------------------------------------------

HITS = [
    ('标准章节', '第一章'),
    ('标准章节', '第1024章 终局'),
    ('标准章节', '第 十二 回 夜宴'),
    ('标准章节', '第三话：出发'),
    ('卷部册集', '第一卷'),
    ('卷部册集', '第三卷 雪原远征'),
    ('卷部册集', '卷五 归途'),
    ('卷部册集', '上部'),
    ('特殊章节', '序'),
    ('特殊章节', '楔子'),
    ('特殊章节', '序章 雪夜'),
    ('特殊章节', '后记：写在最后'),
    ('特殊章节', '番外1'),
    ('数字 分隔符 标题', '001、青石巷'),
    ('数字 分隔符 标题', '1. 青石巷'),
    ('数字 分隔符 标题', '12 青石巷'),
    ('大写数字 分隔符 标题', '一、青石巷'),
    ('大写数字 分隔符 标题', '二十四章 青石巷'),
    ('拉丁章节', 'Chapter 1'),
    ('拉丁章节', 'CHAPTER 12 The Long Road'),
    ('拉丁章节', 'Part 2'),
    ('拉丁章节', 'Episode 3 Homecoming'),
    ('拉丁章节', 'No.4'),
    ('单位 序号', '章二 归乡'),
    ('单位 序号', '段四二 夜渡'),
    ('大写数字 冒号 标题', '三：归途'),
    ('括号装饰', '【第一章 夜行】'),
    ('括号装饰', '（楔子）'),
    ('括号装饰', '「第十二回 夜宴'),
    ('括号装饰', '【017】旧馆疑云'),
    ('括号装饰', '〔三七〕过江龙'),
    ('符号装饰', '☆、青石巷'),
    ('符号装饰', '★ 青石巷'),
    ('书名 序号', '青石巷(12)'),
    ('书名 序号', '青石巷 12'),
    ('书名 序号', '青石巷（一百二十）'),
    ('分节阅读', '第一页'),
    ('分节阅读', '分节阅读-3'),
    ('分节阅读', '青石巷 分页阅读_7'),
    ('纯序号行', '二十五'),
    ('纯序号行', '【一】'),
    ('通用激进', '＝＝第一章 夜行'),
    ('通用激进', '卷首语'),
    ('通用激进', '3. 青石巷'),
]

MISSES = [
    # 裸 `序` 后面必须是分隔符或行尾，否则正文行会被吞掉
    ('特殊章节', '序列里排第一的那个数'),
    ('特殊章节', '正文完了'),
    ('特殊章节', '正文结束'),
    # 纯数字行不是第 4 条的目标（那是激进规则的活）
    ('数字 分隔符 标题', '34'),
    ('数字 分隔符 标题', '002、'),
    # 中文数字用窄分隔符：正文里的"一，""十："不算标题
    ('大写数字 分隔符 标题', '二，她没有接话'),
    ('大写数字 分隔符 标题', '九：余数'),
    # `no` 必须带标点
    ('拉丁章节', 'No one knew where she went'),
    ('拉丁章节', 'Chapter two'),
    # 第 11 条只认"汉字 + 序号"，序号后不许再有内容
    ('书名 序号', '青石巷 8 号楼'),
    ('书名 序号', '第二章'),
    # 第 3 条不吃卷级单位（那是第 2 条的活），也不吃没有序号的行
    ('单位 序号', '卷二 雪夜归舟'),
    ('单位 序号', '章节目录'),
    # 第 13 条：整行只有序号，多一个字符都不算
    ('纯序号行', '二、'),
    ('纯序号行', '一只猫'),
    ('纯序号行', '2024'),
    # 超长行谁都不该中
    ('标准章节', '第二十九章的故事还得从头讲起' + '呀' * 60),
    ('顶格短行', '灯' * 40),
]


@pytest.mark.parametrize('name,line', HITS, ids=[f'{n}:{line}' for n, line in HITS])
def test_expected_hits(name: str, line: str):
    assert rule(name).match(line)


@pytest.mark.parametrize('name,line', MISSES, ids=[f'{n}:{line[:16]}' for n, line in MISSES])
def test_expected_misses(name: str, line: str):
    assert not rule(name).match(line)


# ---------------------------------------------------------------------------
# 共享片段本身
# ---------------------------------------------------------------------------


def test_shared_fragments_are_exported():
    # design §4.3 指定的三个片段是对外契约，check_toc.py / 文档都引用它们
    for fragment in (toc_rules.NUM, toc_rules.UNIT, toc_rules.SPECIAL):
        assert isinstance(fragment, str) and fragment


def test_rules_are_immutable_data():
    with pytest.raises(Exception):
        RULES[0].name = '改不了'  # type: ignore[misc]
