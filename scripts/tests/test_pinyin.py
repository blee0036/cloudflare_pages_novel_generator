# -*- coding: utf-8 -*-
r"""`scripts/lib/pinyin.py` 的拼音首字母（任务 22，需求 5.6，design §2.2 / §5）。

运行（仓库根目录）：`python -m pytest scripts/tests -q`

断言四组事实：

1. **转写本身**：design §2.2 点名的 `从零开始` → `clks`、`雷云风暴` → `lyfb`，
   以及数字/拉丁保留（`1852铁血中华` → `1852txzh`）、标点空白丢弃、全角与变音折叠。
2. **出口不变量**（组合枚举）：结果恒为半角小写字母数字、且幂等。
   前端把它直接拼进 `haystack` 后只做一次 `toLowerCase()`（design §5），
   所以"出口已经干净"是那边零清洗的前提。没有引 hypothesis——理由同
   `test_toc_title.py`：不给 `scripts/requirements.txt` 加只有测试用的依赖，
   改用把噪声拆片段后穷举组合。
3. **省略条件**（design §2.2 最后一条）：缩写与原文小写相同（纯 ASCII 书名 `NB`）
   或结果为空时不写该字段；全角 `ＮＢ` 反而要保留（它是那本书唯一的半角检索入口）。
   `abbr_fields` 只返回该写出的键，且键序与 §2.2 的字段顺序一致。
4. **真实书**：本地 5 本的缩写基线，含《NB-NB》这个真实存在的"两个字段都省略"的样本。

`books.json` 里字段是否真的写出来由 `scripts/preprocess.py` 的
`{**meta, **pinyin.abbr_fields(title, author)}` 一句完成，这里钉住它的输入输出契约。
"""

from __future__ import annotations

import itertools
import json
import re
from pathlib import Path
from typing import Dict, List, Optional

import pytest

from scripts.lib.pinyin import (
    FIELD_AUTHOR,
    FIELD_TITLE,
    abbr,
    abbr_field,
    abbr_fields,
)

DATA_DIR = Path(__file__).resolve().parents[2] / 'public' / 'data'
BOOKS_JSON = DATA_DIR / 'books.json'

real_books = pytest.mark.skipif(
    not BOOKS_JSON.is_file(),
    reason='public/data 是 gitignore 的本地产物，缺失时跳过真实书基线',
)

#: 出口白名单：半角小写字母数字（可能为空串）。
CLEAN = re.compile(r'^[a-z0-9]*$')


# ---------------------------------------------------------------------------
# 1. 转写本身
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('text,expected', [
    # design §2.2 逐字点名的两个
    ('从零开始', 'clks'),
    ('雷云风暴', 'lyfb'),
    # 需求 A14 点名的 `bug神` 用例：原书名负责 `bug神`，缩写补上纯字母写法
    ('BUG之神', 'bugzs'),
    ('耳火大帝', 'ehdd'),
    # 数字保留，使 `1852tx` 能连成一段（design §5 的 streak 加权）
    ('1852铁血中华', '1852txzh'),
    ('1991从芯开始', '1991cxks'),
    ('绯红之月', 'fhzy'),
    ('极品全能高手', 'jpqngs'),
])
def test_known_abbreviations(text: str, expected: str):
    assert abbr(text) == expected


@pytest.mark.parametrize('text,expected', [
    ('《书名》', 'sm'),                  # 书名号：没人会输进搜索框
    ('斗破·苍穹', 'dpcq'),               # 间隔号
    ('  斗破  苍穹 ', 'dpcq'),           # 首尾与内部空白
    ('斗破\u3000苍穹', 'dpcq'),          # 全角空格
    ('斗破\t苍穹', 'dpcq'),
    ('第一章：夜行', 'dyzyx'),            # 全角冒号
    ('😀', ''),                          # 一个字母数字都留不下
    ('---', ''),
    ('', ''),
])
def test_punctuation_and_whitespace_are_dropped(text: str, expected: str):
    assert abbr(text) == expected


@pytest.mark.parametrize('text,expected', [
    ('ＮＢ', 'nb'),        # 全角拉丁 → 半角
    ('１９９１', '1991'),   # 全角数字
    ('Café', 'cafe'),      # 变音符号（NFKD 分解后丢掉组合记号）
    ('naïve', 'naive'),
])
def test_fullwidth_and_diacritics_are_folded(text: str, expected: str):
    # 这些字符在原书名里只能被原样输入，折叠后的缩写是它们唯一的半角检索入口
    assert abbr(text) == expected


@pytest.mark.parametrize('text', ['Bug', 'A1', 'x9y', 'ROOM'])
def test_latin_and_digits_are_kept_not_transliterated(text: str):
    # 保留而非丢弃：丢掉数字/字母会让 `1852tx` 一类的混合输入断成两段、排序变差
    assert abbr(text) == text.lower()


#: 纯汉字：每个字恰好贡献一个首字母。挑的都是本项目真实书名里出现过的字，
#: 含多音字（`曾`/`行`/`重`）——这里只钉"字数守恒"，不钉某个多音字取哪个读音。
HANZI = '从零开始铁血中华曾行重都极品全能高手夜行雨'


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
    '', '第', '一', '铁血', 'A', 'z', 'BUG', '9', '1852',
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
    # 这条兼作"数字与拉丁保留"的守门人：若哪天改成丢弃数字，`1852` 会在第二遍消失。
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


@pytest.mark.parametrize('text', ['NB', 'nb', ' NB ', 'BUG', 'a1b2', '1991', 'room'])
def test_pure_ascii_names_omit_the_field(text: str):
    # 缩写与原文小写相同：写出来是把检索串里已有的内容抄第二遍
    assert abbr(text) == text.strip().lower()
    assert abbr_field(text) is None


@pytest.mark.parametrize('text', ['', '   ', '😀', '---', '《》', 'ß'])
def test_empty_result_omits_the_field(text: str):
    # 空字段占键名的体积却一个字符都不提供
    assert abbr(text) == ''
    assert abbr_field(text) is None


@pytest.mark.parametrize('text,expected', [
    ('ＮＢ', 'nb'),          # 全角：原文 `ｎｂ` 打不出，缩写是它唯一的检索入口
    ('Café', 'cafe'),
    ('从零开始', 'clks'),
    ('BUG之神', 'bugzs'),    # 混合：含汉字，缩写必然不同于原文
])
def test_field_is_kept_when_it_adds_something(text: str, expected: Optional[str]):
    assert abbr_field(text) == expected


def test_field_names_match_the_design():
    # design §2.2 的键名，需求 5.2b：可读全名，不缩写
    assert (FIELD_TITLE, FIELD_AUTHOR) == ('titleAbbr', 'authorAbbr')


def test_fields_keep_the_design_order():
    fields = abbr_fields('从零开始', '雷云风暴')
    assert fields == {'titleAbbr': 'clks', 'authorAbbr': 'lyfb'}
    assert list(fields) == [FIELD_TITLE, FIELD_AUTHOR]


@pytest.mark.parametrize('title,author,expected', [
    ('从零开始', '雷云风暴', {'titleAbbr': 'clks', 'authorAbbr': 'lyfb'}),
    ('NB', 'NB', {}),                                   # 两者都省略
    ('NB', '雷云风暴', {'authorAbbr': 'lyfb'}),           # 只省略书名
    ('从零开始', 'NB', {'titleAbbr': 'clks'}),            # 只省略作者
    ('', '', {}),
])
def test_fields_contain_only_what_should_be_written(
    title: str, author: str, expected: Dict[str, str]
):
    assert abbr_fields(title, author) == expected


def test_fields_merge_into_a_books_json_entry():
    # `preprocess.process_book` 就是这么用的：`{**meta, **abbr_fields(...)}`
    meta = {'id': '从零开始-雷云风暴', 'title': '从零开始', 'author': '雷云风暴'}
    entry = {**meta, **abbr_fields(meta['title'], meta['author'])}
    assert list(entry) == ['id', 'title', 'author', 'titleAbbr', 'authorAbbr']
    # 省略的字段是"键不存在"，不是 null——JSON 里 null 同样占体积却不提供检索价值
    assert 'titleAbbr' not in {**meta, **abbr_fields('NB', 'NB')}
    assert json.loads(json.dumps(entry, ensure_ascii=False))['titleAbbr'] == 'clks'


def test_no_field_value_is_ever_empty_or_dirty():
    for text in COMBOS:
        value = abbr_field(text)
        assert value is None or (value and CLEAN.match(value))


# ---------------------------------------------------------------------------
# 4. 真实书基线
# ---------------------------------------------------------------------------

#: 本地 5 本的期望缩写字段。《NB-NB》是真实存在的"两个字段都省略"的样本——
#: design §2.2 的省略条件不是为假想情况写的。
BASELINE: Dict[str, Dict[str, str]] = {
    '1852铁血中华-绯红之月': {'titleAbbr': '1852txzh', 'authorAbbr': 'fhzy'},
    '1991从芯开始-三分糊涂': {'titleAbbr': '1991cxks', 'authorAbbr': 'sfht'},
    'BUG之神-耳火大帝': {'titleAbbr': 'bugzs', 'authorAbbr': 'ehdd'},
    'NB-NB': {},
    '从零开始-雷云风暴': {'titleAbbr': 'clks', 'authorAbbr': 'lyfb'},
}


def local_books() -> Dict[str, Dict[str, str]]:
    raw = json.loads(BOOKS_JSON.read_text(encoding='utf-8'))
    return {book['id']: book for book in raw['books']}


@real_books
@pytest.mark.parametrize('book_id,expected', sorted(BASELINE.items()))
def test_real_book_baseline(book_id: str, expected: Dict[str, str]):
    books = local_books()
    if book_id not in books:
        pytest.skip(f'{book_id} 不在本地 books.json 里')
    book = books[book_id]
    assert abbr_fields(book['title'], book['author']) == expected


@real_books
def test_every_local_book_gets_a_usable_haystack():
    for book in local_books().values():
        fields = abbr_fields(book['title'], book['author'])
        assert all(CLEAN.match(v) for v in fields.values())
        # design §5：前端拼 haystack 时对缺失字段兜空值，拼完仍是可检索的小写串
        haystack = ' '.join([
            book['title'],
            book['author'],
            fields.get(FIELD_TITLE, ''),
            fields.get(FIELD_AUTHOR, ''),
        ]).lower()
        assert book['title'].lower() in haystack
        if fields.get(FIELD_TITLE):
            assert fields[FIELD_TITLE] in haystack
