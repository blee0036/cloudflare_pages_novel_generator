# -*- coding: utf-8 -*-
r"""`scripts/lib/pinyin.py` 的拼音首字母（任务 22，需求 5.6，design §2.2 / §5）。

运行（仓库根目录）：`python -m pytest scripts/tests -q`

断言四组事实：

1. **转写本身**：原创样本《青石巷》（作者夜行）的 `青石巷` → `qsx`、`夜行` → `yx`，
   以及数字/拉丁保留（`1906青石巷` → `1906qsx`）、标点空白丢弃、全角与变音折叠。
2. **出口不变量**（组合枚举）：结果恒为半角小写字母数字、且幂等。
   前端把它直接拼进 `haystack` 后只做一次 `toLowerCase()`（design §5），
   所以"出口已经干净"是那边零清洗的前提。没有引 hypothesis——理由同
   `test_toc_title.py`：不给 `scripts/requirements.txt` 加只有测试用的依赖，
   改用把噪声拆片段后穷举组合。
3. **省略条件**（design §2.2 最后一条）：缩写与原文小写相同（纯 ASCII 书名 `XYZ`）
   或结果为空时不写该字段；全角 `ＸＹＺ` 反而要保留（缩写是这类书名唯一的半角检索入口）。
   `abbr_fields` 只返回该写出的键，且键序与 §2.2 的字段顺序一致。
4. **检索串**（design §5）：组合枚举的输入两两配成（书名, 作者），缩写字段都干净，
   拼成的检索串含小写书名与缩写。

样例都是自拟名或原创样本，期望的缩写按转写规则由样例逐字写出；本文件不读本机书库。
`books.json` 里字段是否真的写出来由 `scripts/preprocess.py` 的
`{**meta, **pinyin.abbr_fields(title, author)}` 一句完成，这里钉住它的输入输出契约。
"""

from __future__ import annotations

import itertools
import json
import re
from typing import Dict, List, Optional

import pytest

from scripts.lib.pinyin import (
    FIELD_AUTHOR,
    FIELD_TITLE,
    abbr,
    abbr_field,
    abbr_fields,
)

#: 出口白名单：半角小写字母数字（可能为空串）。
CLEAN = re.compile(r'^[a-z0-9]*$')


# ---------------------------------------------------------------------------
# 1. 转写本身
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('text,expected', [
    # 原创样本的书名与作者（scripts/fixtures/standard-cn.txt）
    ('青石巷', 'qsx'),
    ('夜行', 'yx'),
    # 需求 A14 的拉丁混排用例：原书名负责 `xyz歌`，缩写补上纯字母写法
    ('XYZ之歌', 'xyzzg'),
    ('槐南旧客', 'hnjk'),
    # 数字保留，使 `1906qs` 能连成一段（design §5 的 streak 加权）
    ('1906青石巷', '1906qsx'),
    ('2048雾港来信', '2048wglx'),
    ('雾港来信', 'wglx'),
    ('纸鸢与旧钟楼', 'zyyjzl'),
])
def test_known_abbreviations(text: str, expected: str):
    assert abbr(text) == expected


@pytest.mark.parametrize('text,expected', [
    ('《青石巷》', 'qsx'),               # 书名号：没人会输进搜索框
    ('雾港·来信', 'wglx'),               # 间隔号
    ('  雾港  来信 ', 'wglx'),           # 首尾与内部空白
    ('雾港\u3000来信', 'wglx'),          # 全角空格
    ('雾港\t来信', 'wglx'),
    ('第三章：夜行', 'dszyx'),            # 全角冒号
    ('😀', ''),                          # 一个字母数字都留不下
    ('---', ''),
    ('', ''),
])
def test_punctuation_and_whitespace_are_dropped(text: str, expected: str):
    assert abbr(text) == expected


@pytest.mark.parametrize('text,expected', [
    ('ＸＹＺ', 'xyz'),      # 全角拉丁 → 半角
    ('１９０６', '1906'),   # 全角数字
    ('Crème', 'creme'),    # 变音符号（NFKD 分解后丢掉组合记号）
    ('Noël', 'noel'),
])
def test_fullwidth_and_diacritics_are_folded(text: str, expected: str):
    # 这些字符在原书名里只能被原样输入，折叠后的缩写是它们唯一的半角检索入口
    assert abbr(text) == expected


@pytest.mark.parametrize('text', ['Kite', 'C3', 'm5n', 'LAMP'])
def test_latin_and_digits_are_kept_not_transliterated(text: str):
    # 保留而非丢弃：丢掉数字/字母会让 `1906qs` 一类的混合输入断成两段、排序变差
    assert abbr(text) == text.lower()


#: 纯汉字：每个字恰好贡献一个首字母。前半取自上面的自拟名，后面接几个多音字
#: （`行`/`长`/`乐`/`朝`）——这里只钉"字数守恒"，不钉某个多音字取哪个读音。
HANZI = '雾港来信夜行长乐朝纸鸢钟楼'


@pytest.mark.parametrize('n', [1, 2, 3, 4, 6, 8])
def test_pure_hanzi_yields_one_letter_per_character(n: int):
    text = HANZI[:n]
    assert len(abbr(text)) == n
    assert CLEAN.match(abbr(text))


# ---------------------------------------------------------------------------
# 2. 出口不变量（组合枚举，不引 hypothesis）
# ---------------------------------------------------------------------------

#: 把"书名里可能出现的排版噪声"拆成片段，三片一组穷举出 3000+ 个输入，
#: 覆盖"汉字 × 拉丁 × 数字 × 标点 × 空白 × 全角 × 变音 × 表情"的组合形态。
FRAGMENTS = (
    '', '第', '一', '青石', 'A', 'z', 'XYZ', '9', '1906',
    '·', '：', '《', '》', '(', ')', '-', '_',
    ' ', '\u3000', '\t', 'é', 'Ｂ', '１', '😀', 'ß', 'Ⅷ',
)

COMBOS: List[str] = [''.join(parts) for parts in itertools.product(FRAGMENTS, repeat=3)]


def test_combo_space_is_big_enough_to_mean_something():
    assert len(COMBOS) > 3000


def test_output_is_always_lowercase_alnum():
    bad = [text for text in COMBOS if not CLEAN.match(abbr(text))]
    assert bad == [], f'出口混进了非半角小写字母数字的字符：{bad[:5]}'


def test_abbr_is_idempotent():
    # 结果已经是干净的字母数字串，再转写一次必须原样返回。
    # 这条兼作"数字与拉丁保留"的守门人：若哪天改成丢弃数字，`1906` 会在第二遍消失。
    bad = [text for text in COMBOS if abbr(abbr(text)) != abbr(text)]
    assert bad == [], f'不幂等：{bad[:5]}'


def test_output_never_needs_further_cleaning_by_the_frontend():
    # design §5 的 haystack 只做一次 toLowerCase()，不做 trim、不删标点
    for text in COMBOS:
        value = abbr(text)
        assert value == value.strip() == value.lower()


# ---------------------------------------------------------------------------
# 3. 省略条件（design §2.2 最后一条）
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('text', ['XYZ', 'xyz', ' XYZ ', 'KITE', 'c3d4', '1906', 'lamp'])
def test_pure_ascii_names_omit_the_field(text: str):
    # 缩写与原文小写相同：写出来是把检索串里已有的内容抄第二遍
    assert abbr(text) == text.strip().lower()
    assert abbr_field(text) is None


@pytest.mark.parametrize('text', ['', '\u3000 \t', '🌙', '~~~', '【】', 'Æ'])
def test_empty_result_omits_the_field(text: str):
    # 空字段占键名的体积却一个字符都不提供
    assert abbr(text) == ''
    assert abbr_field(text) is None


@pytest.mark.parametrize('text,expected', [
    ('ＸＹＺ', 'xyz'),       # 全角：原文 `ｘｙｚ` 打不出，缩写是它唯一的检索入口
    ('Crème', 'creme'),
    ('青石巷', 'qsx'),
    ('XYZ之歌', 'xyzzg'),    # 混合：含汉字，缩写必然不同于原文
])
def test_field_is_kept_when_it_adds_something(text: str, expected: Optional[str]):
    assert abbr_field(text) == expected


def test_field_names_match_the_design():
    # design §2.2 的键名，需求 5.2b：可读全名，不缩写
    assert (FIELD_TITLE, FIELD_AUTHOR) == ('titleAbbr', 'authorAbbr')


def test_fields_keep_the_design_order():
    fields = abbr_fields('青石巷', '夜行')
    assert fields == {'titleAbbr': 'qsx', 'authorAbbr': 'yx'}
    assert list(fields) == [FIELD_TITLE, FIELD_AUTHOR]


@pytest.mark.parametrize('title,author,expected', [
    ('青石巷', '夜行', {'titleAbbr': 'qsx', 'authorAbbr': 'yx'}),
    ('XYZ', 'XYZ', {}),                                 # 两者都省略
    ('XYZ', '夜行', {'authorAbbr': 'yx'}),               # 只省略书名
    ('青石巷', 'XYZ', {'titleAbbr': 'qsx'}),             # 只省略作者
    ('', '', {}),
])
def test_fields_contain_only_what_should_be_written(
    title: str, author: str, expected: Dict[str, str]
):
    assert abbr_fields(title, author) == expected


def test_fields_merge_into_a_books_json_entry():
    # `preprocess.process_book` 就是这么用的：`{**meta, **abbr_fields(...)}`
    meta = {'id': '青石巷-夜行', 'title': '青石巷', 'author': '夜行'}
    entry = {**meta, **abbr_fields(meta['title'], meta['author'])}
    assert list(entry) == ['id', 'title', 'author', 'titleAbbr', 'authorAbbr']
    # 省略的字段是"键不存在"，不是 null——JSON 里 null 同样占体积却不提供检索价值
    assert 'titleAbbr' not in {**meta, **abbr_fields('XYZ', 'XYZ')}
    assert json.loads(json.dumps(entry, ensure_ascii=False))['titleAbbr'] == 'qsx'


def test_no_field_value_is_ever_empty_or_dirty():
    for text in COMBOS:
        value = abbr_field(text)
        assert value is None or (value and CLEAN.match(value))


# ---------------------------------------------------------------------------
# 4. 检索串（design §5）
# ---------------------------------------------------------------------------


def test_every_combo_name_gets_a_usable_haystack():
    # 两两配对：第 i 个组合与倒数第 i 个配成（书名, 作者），每个组合各当一次书名、一次作者。
    # 倒序配对让片段表前半（汉字、拉丁、数字）与后半（空白、全角、变音、表情）逐位相遇。
    for title, author in zip(COMBOS, reversed(COMBOS)):
        fields = abbr_fields(title, author)
        assert all(CLEAN.match(v) for v in fields.values()), (title, author, fields)
        # design §5：前端拼 haystack 时对缺失字段兜空值，拼完仍是可检索的小写串
        haystack = ' '.join([
            title,
            author,
            fields.get(FIELD_TITLE, ''),
            fields.get(FIELD_AUTHOR, ''),
        ]).lower()
        assert title.lower() in haystack
        if fields.get(FIELD_TITLE):
            assert fields[FIELD_TITLE] in haystack
