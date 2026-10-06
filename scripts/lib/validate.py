# -*- coding: utf-8 -*-
r"""产物 schema 自校验（design §2.1 / §2.2 / §4.9，需求 7.10 / 8.14，任务 24）。

编排层只用一个口子（design §4.9）：

```python
meta = process_book(src)
validate.check(meta, toc_data)      # 不通过抛 ValidationError
manifest.update(src, digest, meta)  # 校验过了才记账
```

## 为什么要在运行期断言（需求 A8 / G7）

预处理选了 Python，代价是**失去"与前端共享类型"的编译期保障**——`_toc.json` 与
`src/types.ts` 的 `BookToc` 从此只靠人记得同步。旧版"下载接口对所有书 404"正是这种
schema 漂移造成的：产物少了一个前端要读的字段，构建全绿、部署成功、站点全坏。

本模块就是那份保障的运行期替身：产物写完立刻按 design §2.1 / §2.2 的形状逐项断言。
它防的不是"随机数据"，而是**我们自己改坏了写入侧**——改了字段名忘了改前端、切分逻辑
引入一个 off-by-one、卷标记把 `start`/`end` 动了。这些都不会让 `json.dump` 报错，
只会让站点安静地坏掉。

## 失败的语义：这一本算失败，且**不写清单**

`check` 抛 `ValidationError`，由 design §4.9 的 `try/except` 记成这一本的失败
（需求 7.1），批次继续。关键是异常打断了后面的 `manifest.update`——
**坏产物不会被记成"处理过"**，下次运行必然重跑它（需求 7.3 / 7.4）。
反过来说，如果这里只打一条告警，那本坏书会带着一条正常的清单记录躺在那儿，
从此每次运行都被跳过，直到有人手工删清单——这正是需求 7.10 要消掉的形态。

非零退出码（需求 7.10 的措辞）不在这里做：单本 `SystemExit` 会终止整批，与需求 7.1
直接冲突。批次结束时"有失败 → 非零退出"由 `report.py`（任务 25）统一负责。

## 校验的是**内存里的 dict**，不回头解析 JSON

`check` 收的是 `json.dump` 写出去的那两个对象本身。理由：

- 写入侧的错误都在对象里，重新解析一遍只是在测 `json` 模块；而 `json.dump`
  遇到不可序列化的值自己就会抛。
- 7000 本回头 re-parse 是几 GB 的额外 IO，换不到任何新信息。

于是这里只做纯数据检查、不碰文件系统。手里只有路径的调用方自己
`json.loads(path.read_text('utf-8'))` 再传进来即可（`check_toc` 接受任何 `Mapping`）。

## 一次报全部问题，但列表有上限

问题全部收集完再一次抛出：一个 off-by-one 往往同时破坏"相邻连续"与"末章 == charCount"，
只报第一条会让人修一轮再看一轮。但 3221 章的书里一个系统性错误能产出 3221 条同源问题，
所以消息最多列 `MAX_LISTED_PROBLEMS` 条，其余只报数量。

## 硬错误 vs 告警

**硬错误**是结构性的：字段缺失/类型不对/连续覆盖断了。它们会让前端直接坏掉
（`chapter.start` 是字符串就切不出文本），产物毫无价值，必须重跑。

**告警**是质量信号：产物能用，但有东西可疑。目前只有一条——`isVolume` 为真却很长
（design §2.1 不变量 6，阈值 `toc.VOLUME_BODY_MAX`）。它不能是硬错误，有两个原因：

1. 它说明"规则把正文误判成了卷"，而那是**识别质量**问题，不是 schema 问题。
   为此丢掉一本能读的书，是拿可用性换整洁。
2. 两侧量的东西本来就不同：`mark_volumes` 判卷量的是**去掉标题行之后的正文**
   （`body_length`），产物里记的 `length` 却含标题行与其后的空行。所以一个正文
   99 字符、标题行 12 字符、后面跟 3 个空行的合法卷节点，`length` 会越过 100。
   真实语料里卷节点是 6–11 字符（design §2.1 的样例），这条线离得很远；但把它
   做成硬错误就等于让上述边缘形态直接判死。

告警由 `Result.warnings` 返回，输出时机与文案归 `report.py`（任务 25）。

## 不变量 5 不在这里

design §2.1 的不变量 5「每个章节的 range 以自己的标题行起始」要拿**全文**才能验
（`text.startswith(标题行, start)`）。`check` 只看产物，全文早就压成 `.gz` 了。
那条不变量由构造保证（`toc.split_book` 直接用标题行行首偏移当 `start`）并由
`scripts/tests/test_toc_split.py::test_a_synthetic_long_book_split_is_a_strict_cover`
对着合成长书断言，重复搬到这里只会多一个 20MB 的参数。
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass
from typing import IO, Any, List, Mapping, Optional, Sequence, Tuple

from .toc import VOLUME_BODY_MAX, count_content_chapters

__all__ = [
    'BOOK_FIELDS',
    'DEPRECATED_BOOK_FIELDS',
    'MAX_LISTED_PROBLEMS',
    'Result',
    'TIMESTAMP',
    'TOC_FIELDS',
    'ValidationError',
    'check',
    'check_book',
    'check_books',
    'check_toc',
]

#: 一条消息里最多列出的问题数，其余只报数量（见模块 docstring）。
MAX_LISTED_PROBLEMS = 10

#: `_toc.json` 的必需根字段（design §2.1）。`fallback` 不在内——它"真时才出现"。
TOC_FIELDS: Tuple[str, ...] = (
    'id',
    'title',
    'author',
    'charCount',
    'totalChapters',
    'tocRule',
    'chapters',
)

#: `books.json` 条目的必需字段（design §2.2）。`titleAbbr` / `authorAbbr` 不在内——
#: 纯 ASCII 书名的缩写与书名小写相同，此时按需求 5.6 省略。
BOOK_FIELDS: Tuple[str, ...] = (
    'id',
    'title',
    'author',
    'charCount',
    'totalChapters',
    'gzSize',
)

#: 已废弃的 `books.json` 字段（design §2.2：前端按 `id` 派生路径）。存在即告警，
#: 不是硬错误——多两个键只是体积浪费，站点照样能跑。
DEPRECATED_BOOK_FIELDS: Tuple[str, ...] = ('txtPath', 'tocPath')

#: `generatedAt` 的形态：秒级 UTC ISO 8601，与 `manifest` 的时间戳同一口径。
TIMESTAMP = re.compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$')


class ValidationError(Exception):
    """产物结构不合 design §2.1 / §2.2。

    抛出即表示这一本计入失败、**不写清单**（见模块 docstring）。
    消息是多行的：首行说明主体与问题数，其后每行一条问题。
    """


@dataclass(frozen=True)
class Result:
    """校验通过的结果。唯一内容是告警——硬问题走异常，不走返回值。"""

    warnings: Tuple[str, ...] = ()
    """质量告警（目前只有"卷节点偏长"）。文案自带书名与章号，可直接输出。"""

    def emit_warnings(self, stream: Optional[IO[str]] = None) -> None:
        """把告警打到 stderr（默认）。无告警则什么都不做。"""
        if not self.warnings:
            return
        out = stream if stream is not None else sys.stderr
        for line in self.warnings:
            print(line, file=out)
        try:
            out.flush()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# 字段级基础检查
# ---------------------------------------------------------------------------


def _label(data: Any) -> str:
    """产物的 `id`，用于错误/告警定位；取不到时给一个占位。"""
    if isinstance(data, Mapping):
        book_id = data.get('id')
        if isinstance(book_id, str) and book_id.strip():
            return book_id
    return '<id 未知>'


def _title_of(data: Any) -> str:
    """产物里的书名，用于错误定位；取不到时给一个占位。"""
    if isinstance(data, Mapping):
        title = data.get('title')
        if isinstance(title, str) and title.strip():
            return title
    return '书名未知'


def _missing(prefix: str, key: str) -> str:
    """"缺少必需字段"的文案。

    字段级消息用点号路径（`chapters[1].start 必须是整数`），但"缺少"要读成
    `chapters[1] 缺少必需字段 start`——点号挂在"缺少"前面没法读。
    """
    where = f'{prefix[:-1]} ' if prefix.endswith('.') else prefix
    return f'{where}缺少必需字段 {key}'


def _req_str(
    data: Mapping[str, Any],
    key: str,
    problems: List[str],
    prefix: str = '',
) -> Optional[str]:
    """必需的非空字符串。不合格时记一条问题并返回 `None`。"""
    if key not in data:
        problems.append(_missing(prefix, key))
        return None
    value = data[key]
    if not isinstance(value, str):
        problems.append(
            f'{prefix}{key} 必须是字符串，实际是 {type(value).__name__}：{value!r}'
        )
        return None
    if not value.strip():
        problems.append(f'{prefix}{key} 不能为空字符串')
        return None
    return value


def _req_int(
    data: Mapping[str, Any],
    key: str,
    problems: List[str],
    prefix: str = '',
    minimum: int = 0,
) -> Optional[int]:
    """必需的整数，且 >= `minimum`。不合格时记一条问题并返回 `None`。

    `bool` 与 `float` 都算不合格。字符偏移进 JSON 之后前端要拿去切字符串、
    当数组下标用，`3.0` 或 `true` 在那里的行为没有任何人想过。
    """
    if key not in data:
        problems.append(_missing(prefix, key))
        return None
    value = data[key]
    if isinstance(value, bool) or not isinstance(value, int):
        problems.append(
            f'{prefix}{key} 必须是整数，实际是 {type(value).__name__}：{value!r}'
        )
        return None
    if value < minimum:
        problems.append(f'{prefix}{key} 必须 >= {minimum}，实际是 {value}')
        return None
    return value


def _raise(problems: Sequence[str], subject: str) -> None:
    """有问题就抛 `ValidationError`，最多列 `MAX_LISTED_PROBLEMS` 条。"""
    if not problems:
        return
    listed = list(problems[:MAX_LISTED_PROBLEMS])
    lines = [f'{subject} 未通过自校验（{len(problems)} 处问题，需求 7.10 / 8.14）：']
    lines += [f'    - {item}' for item in listed]
    rest = len(problems) - len(listed)
    if rest > 0:
        lines.append(f'    … 另有 {rest} 处未列出（同类问题通常同源，修一处往往全消）。')
    raise ValidationError('\n'.join(lines))


# ---------------------------------------------------------------------------
# `_toc.json`（design §2.1，需求 8.14）
# ---------------------------------------------------------------------------


def _collect_chapters(
    chapters: Sequence[Any],
    char_count: Optional[int],
    total_chapters: Optional[int],
    label: str,
    problems: List[str],
    warnings: List[str],
    prefix: str = '',
) -> None:
    """章节表的不变量 1–4 与 6（design §2.1）。一遍扫完，问题全收。"""
    prev_end: Optional[int] = None   # None = 首章，或上一章的 end 不可用

    for index, chapter in enumerate(chapters):
        at = f'{prefix}chapters[{index}].'
        if not isinstance(chapter, Mapping):
            problems.append(
                f'{prefix}chapters[{index}] 必须是对象，实际是 {type(chapter).__name__}'
            )
            prev_end = None
            continue

        chapter_id = _req_int(chapter, 'id', problems, at)
        if chapter_id is not None and chapter_id != index:
            problems.append(
                f'{at}id 应等于数组下标 {index}，实际是 {chapter_id}'
                '（不变量 1：id 即下标，从 0 连续递增）'
            )
        title = _req_str(chapter, 'title', problems, at)

        start = _req_int(chapter, 'start', problems, at)
        end = _req_int(chapter, 'end', problems, at, minimum=1)
        length = _req_int(chapter, 'length', problems, at, minimum=1)

        if start is not None and end is not None:
            if end <= start:
                problems.append(
                    f'{at}end 必须大于 start，实际 start={start}、end={end}'
                    '（不变量 3：零长度节点会让标题行字符无归属）'
                )
            elif length is not None and length != end - start:
                problems.append(
                    f'{at}length 应等于 end - start = {end - start}，实际是 {length}'
                    '（不变量 3）'
                )

        if index == 0:
            if start is not None and start != 0:
                problems.append(
                    f'{at}start 必须是 0，实际是 {start}'
                    '（不变量 2：章节表从全文开头覆盖）'
                )
        elif prev_end is not None and start is not None and start != prev_end:
            problems.append(
                f'{at}start 应等于上一章的 end {prev_end}，实际是 {start}'
                '（不变量 2：相邻章节严格衔接，卷节点也不例外）'
            )
        prev_end = end

        # 不变量 6 与"真时才出现"的写法（design §2.1）。
        if 'isVolume' in chapter:
            flag = chapter['isVolume']
            if flag is not True:
                problems.append(
                    f'{at}isVolume 只在为真时写入，实际是 {flag!r}'
                    '（正文章节不该有这个键）'
                )
            else:
                span = length if length is not None else (
                    end - start if start is not None and end is not None else None
                )
                if span is not None and span >= VOLUME_BODY_MAX:
                    warnings.append(
                        f'[卷节点偏长] {label} chapters[{index}]'
                        f'「{title if title else "?"}」标了 isVolume，'
                        f'但 length={span} >= {VOLUME_BODY_MAX}：'
                        '规则可能把正文误判成了卷（也可能只是标题行长、其后空行多——'
                        '卷标记量的是去掉标题行后的正文）。'
                    )

    if prev_end is not None and char_count is not None and prev_end != char_count:
        problems.append(
            f'{prefix}chapters[-1].end 应等于 charCount {char_count}，实际是 {prev_end}'
            '（不变量 2：章节表必须覆盖到全文末尾）'
        )

    if total_chapters is not None and all(isinstance(c, Mapping) for c in chapters):
        content = count_content_chapters(chapters)
        if total_chapters != content:
            problems.append(
                f'{prefix}totalChapters 应等于非卷节点数 {content}，实际是 {total_chapters}'
                f'（不变量 4；章节表共 {len(chapters)} 个节点）'
            )


def _collect_toc(
    data: Mapping[str, Any],
    problems: List[str],
    warnings: List[str],
    prefix: str = '',
) -> None:
    """`_toc.json` 的必需字段、类型与全部可验不变量。"""
    label = _label(data)

    _req_str(data, 'id', problems, prefix)
    _req_str(data, 'title', problems, prefix)
    _req_str(data, 'author', problems, prefix)
    # charCount 至少 1：末章 end 等于它，而每个章节 length > 0，空书没有合法产物。
    char_count = _req_int(data, 'charCount', problems, prefix, minimum=1)
    total_chapters = _req_int(data, 'totalChapters', problems, prefix)

    # tocRule 可以是 null（没有任何规则可用，走全书兜底），但键必须在——
    # "字段不存在"与"没选中规则"是两件事，前者是写入侧漏了。
    if 'tocRule' not in data:
        problems.append(f'{prefix}缺少必需字段 tocRule（无规则可用时写 null）')
    else:
        rule = data['tocRule']
        if rule is not None and (not isinstance(rule, str) or not rule.strip()):
            problems.append(
                f'{prefix}tocRule 必须是非空字符串或 null，实际是 {rule!r}'
            )

    # fallback 与 isVolume 同一约定：真时才出现（design §2.1）。
    if 'fallback' in data and data['fallback'] is not True:
        problems.append(
            f'{prefix}fallback 只在为真时写入，实际是 {data["fallback"]!r}'
        )

    if 'chapters' not in data:
        problems.append(f'{prefix}缺少必需字段 chapters')
        return
    chapters = data['chapters']
    if not isinstance(chapters, list):
        problems.append(
            f'{prefix}chapters 必须是数组，实际是 {type(chapters).__name__}'
        )
        return
    if not chapters:
        problems.append(
            f'{prefix}chapters 为空：一本书至少要有一个章节'
            '（空文本切不出章节表，那不是能上线的产物）'
        )
        return

    _collect_chapters(
        chapters, char_count, total_chapters, label, problems, warnings, prefix
    )


def check_toc(data: Any) -> Result:
    """校验一份 `_toc.json`（design §2.1 的不变量 1–4 与 6，需求 7.10 / 8.14）。

    Args:
        data: `_toc.json` 的内容（写入前的 dict，或 `json.loads` 的结果）。

    Returns:
        `Result`，只含质量告警。

    Raises:
        ValidationError: 任何必需字段缺失、类型不对，或连续覆盖被破坏。
    """
    label = _label(data)
    if not isinstance(data, Mapping):
        raise ValidationError(
            f'_toc.json 必须是对象，实际是 {type(data).__name__}（需求 7.10）'
        )
    problems: List[str] = []
    warnings: List[str] = []
    _collect_toc(data, problems, warnings)
    _raise(problems, f'_toc.json（{label}）')
    return Result(tuple(warnings))


# ---------------------------------------------------------------------------
# `books.json`（design §2.2）
# ---------------------------------------------------------------------------


def _collect_book(
    data: Mapping[str, Any],
    problems: List[str],
    warnings: List[str],
    prefix: str = '',
) -> None:
    """`books.json` 一条书目的必需字段与类型。"""
    label = _label(data)

    _req_str(data, 'id', problems, prefix)
    _req_str(data, 'title', problems, prefix)
    _req_str(data, 'author', problems, prefix)
    _req_int(data, 'charCount', problems, prefix, minimum=1)
    _req_int(data, 'totalChapters', problems, prefix)
    # gzSize 至少 1：零字节产物是写入被打断的残留，前端拿到它只会解压失败。
    _req_int(data, 'gzSize', problems, prefix, minimum=1)

    for key in ('titleAbbr', 'authorAbbr'):
        if key in data:
            _req_str(data, key, problems, prefix)

    for key in DEPRECATED_BOOK_FIELDS:
        if key in data:
            warnings.append(
                f'[字段已废弃] {label} 的 books.json 条目里还有 {key}：'
                '前端按 id 派生 /books/<id>.txt.gz 与 /data/<id>_toc.json'
                '（design §2.2），这个键只增体积。'
            )


def check_book(data: Any) -> Result:
    """校验 `books.json` 的**一条**书目（design §2.2）。

    Raises:
        ValidationError: 必需字段缺失或类型不对。
    """
    label = _label(data)
    if not isinstance(data, Mapping):
        raise ValidationError(
            f'books.json 条目必须是对象，实际是 {type(data).__name__}（需求 7.10）'
        )
    problems: List[str] = []
    warnings: List[str] = []
    _collect_book(data, problems, warnings)
    _raise(problems, f'books.json 条目（{label}）')
    return Result(tuple(warnings))


def check_books(data: Any) -> Result:
    """校验整份 `books.json`（design §2.2）。

    除逐条书目之外还管三件只有整份才看得见的事：

    - `count` 必须等于 `books` 的实际长度——前端用它显示总数，对不上是写入侧漏了一本；
    - `id` 不许重复：两本书共用一组产物名意味着后写的覆盖了先写的
      （需求 7.9 要求消歧到唯一，这里是那条要求的验收端）；
    - `generatedAt` 缺失/类型不对是硬错误，**格式**不对只告警——前端压根不读它。

    Raises:
        ValidationError: 必需字段缺失、类型不对、`count` 不符或 `id` 重复。
    """
    if not isinstance(data, Mapping):
        raise ValidationError(
            f'books.json 必须是对象，实际是 {type(data).__name__}（需求 7.10）'
        )
    problems: List[str] = []
    warnings: List[str] = []

    count = _req_int(data, 'count', problems)
    generated_at = _req_str(data, 'generatedAt', problems)
    if generated_at is not None and not TIMESTAMP.match(generated_at):
        warnings.append(
            f'[时间戳格式] books.json 的 generatedAt {generated_at!r} 不是'
            ' 2026-09-24T09:08:23Z 这样的秒级 UTC ISO 8601；前端不读该字段，故只告警。'
        )

    if 'books' not in data:
        problems.append('缺少必需字段 books')
    elif not isinstance(data['books'], list):
        problems.append(f'books 必须是数组，实际是 {type(data["books"]).__name__}')
    else:
        books: Sequence[Any] = data['books']
        if count is not None and count != len(books):
            problems.append(f'count 应等于 books 的长度 {len(books)}，实际是 {count}')

        seen: List[str] = []
        for index, entry in enumerate(books):
            if not isinstance(entry, Mapping):
                problems.append(
                    f'books[{index}] 必须是对象，实际是 {type(entry).__name__}'
                )
                continue
            _collect_book(entry, problems, warnings, f'books[{index}].')
            book_id = entry.get('id')
            if isinstance(book_id, str):
                if book_id in seen:
                    problems.append(
                        f'books[{index}].id "{book_id}" 与前面的条目重复：'
                        '同名产物会互相覆盖，book_id 必须消歧到唯一（需求 7.9）'
                    )
                else:
                    seen.append(book_id)

    _raise(problems, 'books.json')
    return Result(tuple(warnings))


# ---------------------------------------------------------------------------
# 编排层入口（design §4.9）
# ---------------------------------------------------------------------------

#: `books.json` 条目与 `_toc.json` 必须逐字相同的字段。两份产物各写一次同样的事实，
#: 抄漏一个就是"书架显示 3224 章、阅读器只有 3221 章"这类无人察觉的偏差。
_SHARED_FIELDS: Tuple[str, ...] = ('id', 'title', 'author', 'charCount', 'totalChapters')


def check(meta: Any, toc: Any = None) -> Result:
    """design §4.9 的 `validate.check(meta)`：一本书的两份产物一起验。

    Args:
        meta: 这本书在 `books.json` 里的条目（`process_book` 的返回值）。
        toc: 这本书的 `_toc.json` 内容。`None` 表示只验 `books.json` 条目
            （调用方手上只有 `meta` 时的退化用法）。

    Returns:
        `Result`，含两份产物的全部告警。

    Raises:
        ValidationError: 任一份不合 design §2.1 / §2.2，或两份对同一事实的记载不一致。
            抛出即表示这一本计入失败且不写清单（见模块 docstring）。

    两份一起验而不是各验一次，是为了能顺带比对 `_SHARED_FIELDS`：书架读
    `books.json`、阅读器读 `_toc.json`，两边数字不一致时页面之间会互相矛盾，
    而单独看任何一份都完全合法。
    """
    problems: List[str] = []
    warnings: List[str] = []

    if isinstance(meta, Mapping):
        _collect_book(meta, problems, warnings, '[books.json] ')
    else:
        problems.append(
            f'[books.json] 条目必须是对象，实际是 {type(meta).__name__}'
        )

    if toc is not None:
        if isinstance(toc, Mapping):
            _collect_toc(toc, problems, warnings, '[_toc.json] ')
        else:
            problems.append(
                f'[_toc.json] 必须是对象，实际是 {type(toc).__name__}'
            )
        if isinstance(meta, Mapping) and isinstance(toc, Mapping):
            for key in _SHARED_FIELDS:
                if key in meta and key in toc and meta[key] != toc[key]:
                    problems.append(
                        f'{key} 在两份产物里不一致：books.json 是 {meta[key]!r}、'
                        f'_toc.json 是 {toc[key]!r}'
                    )

    _raise(problems, f'《{_title_of(meta)}》（{_label(meta)}）的产物')
    return Result(tuple(warnings))
