# -*- coding: utf-8 -*-
r"""拼音首字母（design §2.2 / §5，需求 5.6，任务 22）。

书名与作者各生成一串首字母缩写，写进 `books.json` 的 `titleAbbr` / `authorAbbr`：

```jsonc
{ "title": "青石巷", "author": "夜行", "titleAbbr": "qsx", "authorAbbr": "yx" }
```

前端把它们拼进检索串（design §5）：

```ts
const haystack = `${title} ${author} ${titleAbbr} ${authorAbbr}`.toLowerCase();
```

所以本模块的产出必须满足两件事：**可键入**（一串半角小写字母数字，任何键盘都打得出）
与**不重复**（与 `title`/`author` 相同的内容不占第二份体积）。

## 为什么在构建期做（INV-2 / 需求 5.6）

`pypinyin` 带一份几 MB 的汉字读音表，前端引它等于为一个搜索框付整包体积；而首字母
一本书只有十几个字节、7000 本压缩后共 78 KB（附录 M2：247 KB → 325 KB）。这是典型的
"重计算只在构建期做"：产物是可直接打开审查的 JSON，运行时零依赖零计算。

## 转写规则

`lazy_pinyin(..., style=Style.FIRST_LETTER)` 逐字取拼音首字母；`errors='default'`
让 `pypinyin` 把**非汉字原样留下**（它会把连续的非汉字并成一段）：

    '1906青石巷' -> ['1906', 'q', 's', 'x']   -> '1906qsx'
    'XYZ之歌'    -> ['XYZ', 'z', 'g']         -> 'xyzzg'

### 数字与拉丁字母：保留

保留是 `pypinyin` 的默认行为，也是这里想要的结果。检索串里已经有原始书名，
单看"能不能命中"两种做法等价（子序列匹配会跨字段跳字：查 `1906qs` 在
`1906青石巷 … qsx` 里照样命中）；差别在**排序**——design §5 的 `fuzzyScore`
对连续命中加权（`streak * 2`），`1906qsx` 能让 `1906qs` 连成一段，丢掉数字则断成
两段、分数明显更低。代价是每本书多几个字节，换混合输入的排序正确，值得。

这也顺带让需求 A14 的两类用例都落在最自然的实现上：纯汉字书名靠转写命中
（`qsx` → 《青石巷》），拉丁字母混排的书名直接命中原书名（`xyz歌` → 《XYZ之歌》：
`x`→`X`、`y`、`z`、`歌`），缩写 `xyzzg` 再补上 `xzg` 一类的纯字母写法。

### 标点与空白：丢弃

`·`、`：`、`《》`、空格这些东西没人会输进搜索框，留着只会在缩写里制造
"必须精确跳过"的杂音（`fuzzyScore` 按字符逐个 `indexOf`，多一个字符就多一处间隔
扣分）。做法是转写完把 `[^a-z0-9]` 全部删掉，于是本模块的出口恒为
**半角小写字母数字**，前端无需再做任何清洗。

### 全角与变音符号：先折叠再转写

`_fold` 做 NFKD 分解 + 去组合记号，把 `ＸＹＺ` 折成 `XYZ`、`Café` 折成 `Cafe`、
兼容区汉字（U+F9xx 一类）折成统一汉字。理由：这些字符在原书名里**只能被原样输入**，
折叠后的缩写是它们唯一的半角检索入口；若不折叠，它们会被上面那条过滤直接删掉，
`Café` 变成 `caf`（错得不明显，更难发现）。

## 省略条件（design §2.2 最后一条）

缩写与原文小写**完全相同**时省略该字段——纯 ASCII 书名（如《XYZ》）就是这种情况：
`abbr('XYZ') == 'xyz' == 'XYZ'.lower()`，写出来是把检索串里已有的内容抄第二遍。
空结果（书名只有标点/表情符号）同样省略：空字段占键名的体积却一个字符都不提供。

判定用**原文**而不是折叠后的文本比较，这是有意的：全角 `ＸＹＺ` 的缩写 `xyz` 与原文
`ｘｙｚ` 不同，会被保留——那正是它需要被保留的原因（见上一节）。

字段"真时才出现"与 `isVolume`/`fallback` 同一约定。因此前端读取时必须兜空值
（`${b.titleAbbr ?? ''}`），否则 JS 模板串会把 `undefined` 拼进检索串，
让 `undefined` 这几个字母变成 7000 本书的共同命中项。
"""

from __future__ import annotations

import re
import unicodedata
from typing import Dict, Optional

from pypinyin import Style, lazy_pinyin

__all__ = [
    'FIELD_AUTHOR',
    'FIELD_TITLE',
    'abbr',
    'abbr_field',
    'abbr_fields',
]

#: `books.json` 里的字段名。用可读全名，不缩写（需求 5.2b：实测长短键仅差 2 KB）。
FIELD_TITLE = 'titleAbbr'
FIELD_AUTHOR = 'authorAbbr'

#: 出口白名单的补集：转写完删掉一切非"半角小写字母数字"的字符。
_NOISE = re.compile(r'[^a-z0-9]+')


def _fold(text: str) -> str:
    """NFKD 分解后去掉组合记号：全角→半角、去变音符号、兼容汉字→统一汉字。

    只做这一层归一，不碰大小写（交给下面统一 `lower()`），也不做任何语言相关的
    音译（`ß` 仍是 `ß`，随后被过滤掉——猜它等于 `ss` 不是本模块该做的事）。
    """
    return ''.join(
        ch for ch in unicodedata.normalize('NFKD', text)
        if not unicodedata.combining(ch)
    )


def abbr(text: str) -> str:
    """生成首字母缩写，结果恒为半角小写字母数字（可能为空串）。

    Args:
        text: 书名或作者名（原始形态，不必预先清洗）。

    Returns:
        缩写。例：`青石巷` → `qsx`、`XYZ之歌` → `xyzzg`、
        `1906青石巷` → `1906qsx`、`《书名》` → `sm`。
        文本里一个字母数字都留不下时返回空串（调用方按"省略字段"处理）。
    """
    if not text:
        return ''
    # errors='default'：非汉字原样保留（见模块 docstring "数字与拉丁字母"）。
    letters = ''.join(lazy_pinyin(_fold(text), style=Style.FIRST_LETTER, errors='default'))
    return _NOISE.sub('', letters.lower())


def abbr_field(text: str) -> Optional[str]:
    """按 design §2.2 的省略条件返回字段值，`None` 表示**不写这个字段**。

    省略两种情况：结果为空，或结果与原文小写完全相同（纯 ASCII 书名，如 `XYZ`）——
    两者写进 `books.json` 都只是重复检索串里已有的内容。
    """
    value = abbr(text)
    if not value or value == text.strip().lower():
        return None
    return value


def abbr_fields(title: str, author: str) -> Dict[str, str]:
    """书名与作者的缩写字段，只含**该写出**的那些，可直接并入 `books.json` 的条目。

    Args:
        title: 书名。
        author: 作者名。

    Returns:
        形如 `{'titleAbbr': 'qsx', 'authorAbbr': 'yx'}`；被省略的键不出现，
        两者都省略时是空字典（`{**meta, **abbr_fields(...)}` 照样成立）。
        插入顺序为 `titleAbbr` → `authorAbbr`，与 design §2.2 的字段顺序一致。
    """
    fields: Dict[str, str] = {}
    title_abbr = abbr_field(title)
    if title_abbr is not None:
        fields[FIELD_TITLE] = title_abbr
    author_abbr = abbr_field(author)
    if author_abbr is not None:
        fields[FIELD_AUTHOR] = author_abbr
    return fields
