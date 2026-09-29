# -*- coding: utf-8 -*-
r"""预处理夹具的端到端断言（任务 28，需求 8.13，design §11 验证层 3）。

运行（仓库根目录）：`python -m pytest scripts/tests -q`

## 夹具是什么、为什么必须是**提交进仓库的文件**

需求 8.13 的措辞是「THE 仓库 SHALL 包含至少 3 个预处理夹具样本」。所以这三个样本不是
在 `tmp_path` 里拼出来的字符串，而是 `scripts/fixtures/` 下三个真实的 `.txt`：

| 文件 | 形态 | 该走的路 |
| --- | --- | --- |
| `standard-cn.txt` | 标准中文章节，带一个卷节点、一个全角空格标题、一个缩进标题 | 规则 `标准章节` |
| `latin-chapter.txt` | 英文 `Chapter N` | 规则 `拉丁章节` |
| `unmarked-fallback.txt` | 通篇散记，一条章节标记都没有 | 无规则 → 全书兜底 |

它们与 `test_toc_split.py` / `test_toc_fallback.py` 里的合成夹具是两件事：

- 那边的字符串是**为某一条断言量身造的**（`'雨' * 99` 恰好压在卷门槛上），读起来不像书；
- 这三个文件是**像书的最小样本**，一次跑完"解码 → 择一规则 → 切分 → 卷标记 → 兜底 →
  自校验"整条链，并且干净检出就能跑——不依赖 `public/books/` 那批 gitignore 的本地产物
  （`test_toc_split.py` 的真书基线整组是 `skipif` 的，CI 上等于不存在）。

## 与 design §11 的偏差：入口是 pytest，不是 `python -m scripts.test_toc`

design §11 验证层 3 把断言脚本命名为 `python -m scripts.test_toc`。那份文档写在
`scripts/tests/` 这套 pytest 套件成形之前；如今 `scripts/` 下的 12 个模块各有一份
`scripts/tests/test_*.py`，再单起一个只能手工运行、不进套件的脚本，等于给同一批断言
开第二条门。**夹具本身照 design 放在 `scripts/fixtures/`（需求 8.13 要的就是这些文件），
断言改由本模块承载**，于是 `python -m pytest scripts/tests -q` 一条命令覆盖全部预处理断言。

另外没有起名 `scripts/test_toc.py`：那个名字会被仓库根目录的 `pytest` 当测试文件收集，
而 `scripts/tests/test_toc.py` 已经存在（任务 17 的评分器测试），两个同名模块在
非 `importlib` 模式下会撞车。

## 断言的五项（任务 28 逐项）

1. **命中的规则名** —— `pick_rule(text).name` 等于表里写死的那一个（兜底样本是 `None`）。
2. **章数落在预期区间** —— `Fixture.chapters` 是闭区间。前两个样本区间宽度为 0
   （文件定了，章数就定了；标题还逐个钉住），兜底那个留了一格余量：块数由
   `FALLBACK_BLOCK` / `FALLBACK_TAIL_MIN` 与行终止符共同决定，改那两个常量时
   这里该报的是"块数变了"，不是"多了一块就红"。
3. **`start`/`end` 严格连续覆盖** —— 逐项手写一遍（`assert_covers`），再把整份产物交给
   `validate.check_toc`。两道是有意重复的：手写那道说得清是哪一条不变量断了，
   `validate` 那道保证夹具与**真实写入路径**同一把尺子（产物就是它把关的）。
4. **末章 `end == charCount`** —— 在 `assert_covers` 与 `validate` 里各出现一次，
   口径都是 `charCount == len(text)`（任务 15：CRLF 原样计入，不做行终止符归一）。
5. **卷节点被正确标记** —— 卷数、`isVolume` 只在为真时出现、卷节点去掉标题行后确实
   没有正文、正文章节一个都没被误标。

## 夹具文件的两条硬约束

- **CRLF**：真实源 txt 是 CRLF，任务 15 把"偏移按 CRLF 算"定成了唯一坐标系。仓库的
  `core.autocrlf=true` 会让普通文本文件的行终止符跟平台走，所以 `.gitattributes` 用
  `scripts/fixtures/*.txt -text` 关掉转换。本模块断言 CRLF 确实在，一旦有人删掉那条
  attributes 规则，这里会立刻红。
- **UTF-8 无 BOM**：读法与管线完全一致（`encoding.decode_file`），而不是
  `open(..., encoding='utf-8')`。于是"解码环节把 CRLF 吞掉"这类回归也被这三个文件挡住，
  而无 BOM 让解码走的是采样探测那条主路（需求 7.8），不是 BOM 的零歧义快路径。
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

import pytest

from scripts.check_toc import measure
from scripts.lib import validate
from scripts.lib.encoding import decode_file
from scripts.lib.toc import (
    VOLUME_BODY_MAX,
    Chapter,
    body_length,
    count_content_chapters,
    fallback_title,
    pick_rule,
    split_book,
)

#: 夹具目录（需求 8.13 点名的 `scripts/fixtures/`）。
FIXTURES_DIR = Path(__file__).resolve().parents[1] / 'fixtures'

#: 需求 8.13 的下限：仓库至少要有这么多个夹具样本。
MIN_FIXTURES = 3


@dataclass(frozen=True)
class Fixture:
    """一个夹具样本的全部预期。"""

    name: str
    """文件名（`scripts/fixtures/` 下）。"""

    rule: Optional[str]
    """期望命中的规则名；`None` = 一条规则都不该通过门槛（走全书兜底）。"""

    chapters: Tuple[int, int]
    """正文章数（非卷节点数，即 `totalChapters` 的口径）的**闭区间**。"""

    volumes: int
    """卷节点数。夹具是定值，不给区间——卷标记错一个就该红。"""

    fallback: bool
    """是否期望触发全书兜底（需求 8.9）。"""

    titles: Optional[Tuple[str, ...]] = None
    """全部节点的标题（含卷节点），`None` = 不逐个钉。

    兜底样本不钉：它的标题是 `第 N 部分`，个数跟着块数走，钉死等于把区间断言又收成定值。
    """


#: 三个夹具的预期。数值来自实测，不是估的；改规则表/阈值后这张表就是"影响面"的第一眼。
FIXTURES: Tuple[Fixture, ...] = (
    Fixture(
        name='standard-cn.txt',
        rule='标准章节',
        # 序章 / 前言 + 4 章正文 = 5 个非卷节点，另有 1 个卷节点。
        chapters=(5, 5),
        volumes=1,
        fallback=False,
        titles=(
            '序章 / 前言',
            '第一卷 少年篇',
            '第一章 夜行',
            # 原文是 `第二章　雨停`（全角空格）→ 净化折叠成半角空格（任务 20）。
            '第二章 雨停',
            # 原文带两个全角空格的缩进 → 标题去掉缩进，但 start 仍指向缩进首字符。
            '第三章 归途',
            '第四章 灯下',
        ),
    ),
    Fixture(
        name='latin-chapter.txt',
        rule='拉丁章节',
        # `Chapter 1` 就在偏移 0，没有序章。
        chapters=(4, 4),
        volumes=0,
        fallback=False,
        titles=(
            'Chapter 1 The Long Road',
            'Chapter 2 A Letter from the North',
            'Chapter 3 The Ferry at Dawn',
            'Chapter 4 Homecoming',
        ),
    ),
    Fixture(
        name='unmarked-fallback.txt',
        rule=None,
        # 5,727 字符按 5,000 字符一块切，末块 751 字符（> FALLBACK_TAIL_MIN，不并入前块）。
        # 区间留一格：块数由块长常量与行终止符共同决定，见模块 docstring 第 2 项。
        chapters=(2, 3),
        volumes=0,
        fallback=True,
    ),
)

#: `pytest -k` 里能读的用例名。
IDS: Tuple[str, ...] = tuple(fx.name for fx in FIXTURES)

#: 夹具当书处理时的作者字段。产物 schema 要求非空字符串（design §2.2）。
FIXTURE_AUTHOR = '夹具'


@dataclass(frozen=True)
class Product:
    """一个夹具跑完管线之后的产物，形状与 `preprocess.process_book` 写出的一致。"""

    text: str
    rule_name: Optional[str]
    chapters: List[Chapter]
    fallback: bool
    toc_data: Dict[str, Any]


@lru_cache(maxsize=None)
def build(name: str) -> Product:
    """解码 → 择一规则 → 切分 → 卷标记 → 两级兜底 → 组装 `_toc.json`。

    与 `preprocess.process_book` 的差别只有两处，都是刻意的：

    - 不走 `toc_overrides.pick_rule_for`：覆盖表按 `book_id` 点名，夹具不在表里，
      而多导入一层只会让"规则是自动选出来的"这件事变得需要额外证明
      （覆盖层自己在 `test_toc_overrides.py` 里验）。
    - 不压缩、不落盘：`charCount` 取 `len(text)`，与写进 `.txt.gz` 的字符数同一个值
      （任务 15：解码结果的 UTF-8 编码就是压进去的字节）。

    `lru_cache`：同一个夹具会被十来个用例读，解码与择一各跑一次就够。
    """
    path = FIXTURES_DIR / name
    decoded = decode_file(path)
    assert not decoded.lossy, f'{name} 解码走了 replace 兜底：{decoded.warnings}'
    text = decoded.text

    pick = pick_rule(text)
    result = split_book(text, pick.rule)
    book_id = Path(name).stem

    toc_data: Dict[str, Any] = {
        'id': book_id,
        'title': book_id,
        'author': FIXTURE_AUTHOR,
        'charCount': len(text),
        'totalChapters': count_content_chapters(result.chapters),
        'tocRule': pick.name,
    }
    if result.fallback:
        toc_data['fallback'] = True
    toc_data['chapters'] = result.chapters

    return Product(
        text=text,
        rule_name=pick.name,
        chapters=result.chapters,
        fallback=result.fallback,
        toc_data=toc_data,
    )


def assert_covers(chapters: Sequence[Chapter], text: str) -> None:
    """需求 8.14：`start`/`end` 严格连续覆盖全文，卷节点同样参与。

    与 `test_toc_split.py` / `test_toc_fallback.py` 里的同名物一致。宁可重复这十行，
    也不让 `scripts/tests` 下的模块互相 import——那个目录没有 `__init__.py`，
    跨模块 import 能不能用取决于 pytest 的 import 模式。
    """
    assert chapters, '切分结果不许为空'
    assert chapters[0]['start'] == 0, '章节表必须从全文开头覆盖'
    assert chapters[-1]['end'] == len(text), '末章 end 必须等于 charCount'
    for index, chapter in enumerate(chapters):
        assert chapter['id'] == index, 'id 即数组下标'
        assert chapter['length'] == chapter['end'] - chapter['start']
        assert chapter['length'] > 0, '零长度节点会让标题行字符无归属'
    for left, right in zip(chapters, chapters[1:]):
        assert left['end'] == right['start'], '相邻章节必须无缝衔接，卷节点也不例外'
    joined = ''.join(text[c['start']:c['end']] for c in chapters)
    assert joined == text, '拼回去必须逐字符等于原文'


def volumes_of(chapters: Sequence[Chapter]) -> List[Chapter]:
    return [c for c in chapters if c.get('isVolume')]


# ---------------------------------------------------------------------------
# 0. 夹具本身（需求 8.13：仓库里得有这些文件）
# ---------------------------------------------------------------------------


def test_the_repository_ships_at_least_three_fixtures():
    assert FIXTURES_DIR.is_dir(), f'夹具目录不存在：{FIXTURES_DIR}'
    on_disk = sorted(path.name for path in FIXTURES_DIR.glob('*.txt'))
    assert len(on_disk) >= MIN_FIXTURES, f'需求 8.13 要求至少 {MIN_FIXTURES} 个样本'
    # 表与目录必须一一对应：多放一个文件却不写预期，等于放了个没人量的样本。
    assert on_disk == sorted(IDS), '新增夹具时请同时在 FIXTURES 里写上它的预期'


@pytest.mark.parametrize('fx', FIXTURES, ids=IDS)
def test_fixture_bytes_are_utf8_without_bom_and_crlf(fx: Fixture):
    raw = (FIXTURES_DIR / fx.name).read_bytes()
    assert raw, '夹具不许是空文件'
    # 刻意不带 BOM：这样解码走的是"采样探测 + 全文 strict 试解"那条主路（需求 7.8），
    # 而不是 BOM 的零歧义快路径——后者对夹具没有信息量。
    assert not raw.startswith(b'\xef\xbb\xbf'), '夹具不带 BOM'
    raw.decode('utf-8')          # 不是合法 UTF-8 就当场炸，省掉后面一堆看不懂的失败
    assert b'\r\n' in raw, (
        '夹具必须是 CRLF：真实源 txt 就是 CRLF，偏移基线建立在它上面（任务 15）。'
        '这条断言红了先看 .gitattributes 里的 `scripts/fixtures/*.txt -text` 还在不在。'
    )
    assert b'\n' not in raw.replace(b'\r\n', b''), '行终止符必须统一，不许 CRLF/LF 混用'


@pytest.mark.parametrize('fx', FIXTURES, ids=IDS)
def test_decoding_a_fixture_keeps_crlf(fx: Fixture):
    # 管线里唯一的文本形态就是 `decode_file` 的出口；它若把 CRLF 归一成 LF，
    # 全部偏移会整体平移（现有产物正是踩了这个坑：gz 里 CRLF、_toc.json 按 LF 算）。
    product = build(fx.name)
    assert '\r\n' in product.text
    assert '\ufeff' not in product.text, 'BOM 字符必须被去掉'
    # `newline=''` 才是"不翻译行终止符"的读法；两边字符数必须一致，
    # 否则解码环节吞掉了 `\r`（每行差 1 个字符，全文差几万）。
    with (FIXTURES_DIR / fx.name).open('r', encoding='utf-8', newline='') as handle:
        assert len(product.text) == len(handle.read())


# ---------------------------------------------------------------------------
# 1. 命中的规则名（需求 8.1–8.5）
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('fx', FIXTURES, ids=IDS)
def test_picked_rule_name(fx: Fixture):
    product = build(fx.name)
    assert product.rule_name == fx.rule
    # `tocRule` 是写进产物的那个字段，两处必须是同一个值（design §2.1）。
    assert product.toc_data['tocRule'] == fx.rule


@pytest.mark.parametrize('fx', FIXTURES, ids=IDS)
def test_fallback_flag_matches_the_rule(fx: Fixture):
    product = build(fx.name)
    assert product.fallback is fx.fallback
    # "真时才输出"（design §2.1）：不兜底的产物里压根没有这个键。
    assert ('fallback' in product.toc_data) is fx.fallback
    if fx.rule is None:
        assert product.fallback, '一条规则都没选中时只能走全书兜底（需求 8.9）'


# ---------------------------------------------------------------------------
# 2. 章数落在预期区间
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('fx', FIXTURES, ids=IDS)
def test_chapter_count_is_within_the_expected_range(fx: Fixture):
    product = build(fx.name)
    low, high = fx.chapters
    content = count_content_chapters(product.chapters)
    assert low <= content <= high, f'正文章数 {content} 落在 [{low}, {high}] 之外'
    # `totalChapters` 是产物里的那一份，口径必须一致（design §2.1 不变量 4）。
    assert product.toc_data['totalChapters'] == content
    assert len(product.chapters) == content + fx.volumes


@pytest.mark.parametrize('fx', FIXTURES, ids=IDS)
def test_titles_are_normalized(fx: Fixture):
    if fx.titles is None:
        pytest.skip('兜底样本的标题个数跟着块数走，由 test_fallback_titles 另验')
    product = build(fx.name)
    assert [c['title'] for c in product.chapters] == list(fx.titles)


def test_fallback_titles_are_numbered_parts():
    product = build('unmarked-fallback.txt')
    expected = [fallback_title(n) for n in range(1, len(product.chapters) + 1)]
    assert [c['title'] for c in product.chapters] == expected


# ---------------------------------------------------------------------------
# 3. start / end 严格连续覆盖 + 4. 末章 end == charCount（需求 8.14）
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('fx', FIXTURES, ids=IDS)
def test_offsets_strictly_cover_the_text(fx: Fixture):
    product = build(fx.name)
    assert_covers(product.chapters, product.text)


@pytest.mark.parametrize('fx', FIXTURES, ids=IDS)
def test_last_chapter_ends_at_char_count(fx: Fixture):
    product = build(fx.name)
    assert product.toc_data['charCount'] == len(product.text)
    assert product.chapters[-1]['end'] == product.toc_data['charCount']


@pytest.mark.parametrize('fx', FIXTURES, ids=IDS)
def test_product_passes_the_shipped_validator(fx: Fixture):
    # 手写断言说得清"哪条不变量断了"，这一道保证夹具与真实写入路径同一把尺子：
    # `validate.check_toc` 就是 preprocess 写产物前调的那个（需求 7.10 / 8.14）。
    result = validate.check_toc(build(fx.name).toc_data)
    assert result.warnings == (), f'夹具不该产生质量告警：{result.warnings}'


# ---------------------------------------------------------------------------
# 5. 卷节点被正确标记（需求 8.7 / 8.7a）
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('fx', FIXTURES, ids=IDS)
def test_volume_nodes_are_marked(fx: Fixture):
    product = build(fx.name)
    marked = volumes_of(product.chapters)
    assert len(marked) == fx.volumes

    for chapter in product.chapters:
        # "真时才输出"：正文章节压根没有这个键，不是 `False`（design §2.1）。
        assert chapter.get('isVolume', True) is True

    for chapter in marked:
        assert body_length(product.text, chapter) < VOLUME_BODY_MAX
        # 不改 start/end：卷节点的 range 恰好覆盖自己的标题行（外加其后的空行）。
        assert product.text.startswith(chapter['title'], chapter['start'])
        span = product.text[chapter['start']:chapter['end']]
        assert span.strip() == chapter['title'], f'被标为卷却还有正文：{chapter!r}'


@pytest.mark.parametrize('fx', FIXTURES, ids=IDS)
def test_no_content_chapter_is_mistaken_for_a_volume(fx: Fixture):
    product = build(fx.name)
    content = [c for c in product.chapters if not c.get('isVolume')]
    assert content, '正文章节不许为空'
    shortest = min(content, key=lambda c: body_length(product.text, c))
    assert body_length(product.text, shortest) >= VOLUME_BODY_MAX, (
        f'差一点被误标成卷：{shortest!r}'
    )


def test_the_standard_fixture_pins_the_volume_and_the_indented_title():
    """`standard-cn.txt` 是三个样本里唯一同时带卷节点、全角空格标题与缩进标题的。"""
    product = build('standard-cn.txt')
    by_title = {c['title']: c for c in product.chapters}

    volume = by_title['第一卷 少年篇']
    assert volume.get('isVolume') is True
    assert volume['length'] > 0, '卷节点不是零长度节点（design §0 修订一）'
    assert body_length(product.text, volume) < VOLUME_BODY_MAX

    # 需求 8.15：range 以自身标题行起始，缩进算在本章里。
    indented = by_title['第三章 归途']
    assert product.text.startswith('\u3000\u3000第三章 归途', indented['start'])
    assert product.text[indented['start'] - 1] in '\r\n', 'start 必须落在行首'

    # 任务 20：全角空格被折叠成半角，但偏移一个字符都不动。
    folded = by_title['第二章 雨停']
    assert product.text.startswith('第二章\u3000雨停', folded['start'])

    # 序章是合成标题，原文里没有对应的标题行，整段都算正文。
    preface = product.chapters[0]
    assert preface['title'] == '序章 / 前言'
    assert body_length(product.text, preface) == preface['length']


# ---------------------------------------------------------------------------
# 6. 度量工具读得出同一批数（需求 8.11 / 8.12）
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('fx', FIXTURES, ids=IDS)
def test_metrics_tool_agrees_with_the_expectations(fx: Fixture):
    # 夹具同时是 `check_toc.py` 的最小基线：需求 8.12 的"前后对比"要有东西可对。
    metrics = measure(build(fx.name).toc_data, Path(fx.name).stem)
    low, high = fx.chapters
    assert low <= metrics.chapters <= high
    assert metrics.volumes == fx.volumes
    assert metrics.fallback is fx.fallback
    assert metrics.rule_label == (fx.rule if fx.rule else '无规则')
    assert metrics.misjudged == 0, '夹具里不该有过短/过长的疑似误判章节'
    assert metrics.broken == 0
    assert metrics.duplicate_titles == 0, '夹具的标题互不相同'
