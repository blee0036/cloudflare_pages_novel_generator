# -*- coding: utf-8 -*-
r"""按 `book_id` 的章节规则人工覆盖表（design §4.7，需求 8.10）。

覆盖表是一张扁平映射：

```json
{
  "某本判错的书-作者": "顶格短行",
  "某个合集-作者": {"order": ["前传.txt", "正篇.txt"], "rule": "标准章节"}
}
```

键是 `book_id`（即 `书名-作者`，与 `public/books/<id>.txt.gz` 同名）。值有两种写法：

- **字符串**：`scripts/lib/toc_rules.py` 里的规则名。命中此表的书**跳过采样评分**，
  直接用点名的规则切分。
- **对象**：`rule`（同上）与 `order` 至少写一个。`order` 给合集包（一个源包里有多个
  `.txt`）指定并入顺序，列的是包里的文件名；没列出的文件不并入（`bundle` 模块 docstring）。
  对象里同样可以有以 `//` 开头的注释键。

## 表在本机，不进版本库

表的键点名的是真实书，所以表只存在本机（test-data-desensitization 需求 3）：

- **本机表** `scripts/toc-overrides.local.json`（`DEFAULT_PATH`），已被 `.gitignore` 排除。
  预处理只读这一个路径，按本模块的文件位置解析，与从哪个目录启动无关；它缺失时
  也不改读示例文件或旧文件名 `toc-overrides.json`。
- **格式示例** `scripts/toc-overrides.example.json`（`EXAMPLE_PATH`），进版本库，
  只点名原创样本的书。预处理从不读它，只有测试加载它来核对格式。
- **缺失时照常运行**：`load()` 返回空表、`found=False`，全部书走自动判定；编排层在
  处理第 1 本书之前打印一行 `missing_notice()`。不改成报错，因为"没有覆盖"本身是
  合法状态；但部署机上漏放这个文件，被点名的书会悄悄换回自动判定的切法，这一行提示
  就是为了让部署者察觉（test-data-desensitization D4）。

## 为什么要有这张表

自动判定总会有判错的个例。没有覆盖表时，唯一的修法是去改全局正则——旧版正是
因为"改一处影响全局"而不敢动，最后整套章节识别逻辑被整体废弃。一本书判错就改
一本书，这是这张表存在的全部理由。

另一半理由是那三条**默认不启用**的激进规则（`纯序号行`、`顶格短行`、`通用激进`，
需求 8.6）：它们在多数书上会把正文行当标题，所以不参与自动择一；但确实有书只能靠
它们切开。`toc_rules.by_name()` 明确连 `enabled=False` 的规则一起返回，就是为了让这张
表能点名启用它们——这是本模块最主要的用途。

`纯序号行` 是这个用途最纯的例子。它匹的是"整行只有一个序号"（`一` / `壹` / `　　1` /
`【一】`），而同一个形态在有的书里是章节标题、在另一些书里是章内小节号——**没有任何
行级特征能分开这两类**，区别是"这本书还有没有别的章节标记"这个书级事实，而评分器
只看单条规则的命中分布。所以它只能默认关闭 + 逐本点名。点名时的实测前后对比写在
本机表里该项旁边的注释键上：单本书的数据跟着表留在本机，不进版本库。

## 为什么校验在加载期、且是硬失败

规则名写错了必须**当场报错并列出全部合法名**，不能退回自动判定。理由很直接：
写这张表的人已经确认过自动判定是错的，"覆盖悄悄没生效"等于把他明确否决过的结果
又装回去，而日志一片正常。这正是这个功能要消掉的失败模式，不能由它自己再造一个。
这与表缺失是两回事：文件不存在照常运行（见上），文件存在却写错才硬失败。

校验发生在**加载期**而不是查表期，所以整张表的规则名在第一本书开始处理之前就全部
验证完毕——7000 本的批次里，第 5000 本的覆盖写错了不该等到跑完前 4999 本才发现。

键（`book_id`）没法在加载期校验：那时还不知道源目录里有哪些书。对应的信号是
`unused()`——编排层拿到全部源文件的 `book_id` 后，把一条也匹配不上的覆盖项打成
告警（不是硬失败：书被合法删掉时批次不该停）。

## 重跑仍然生效（需求 8.10 的后半句）

表是**每次运行从磁盘重读**的，键是 `book_id` 而不是任何一次运行的临时状态，
产物里也不存"上次选了哪条规则"。所以"覆盖在重跑后失效"这件事没有存放的地方——
只要本机表还在，每次预处理都会重新读到它。

## 注释键

JSON 没有注释，而这张表是给人手写的，必须自带用法说明。约定：
**键以 `//` 开头的条目是注释，加载时跳过**。这不会与真实 `book_id` 冲突——
`preprocess.parse_filename_meta` 生成 `safe_id` 时把 `[^\w\u4e00-\u9fa5\-]`
全部替换成 `_`，`/` 一定活不下来。
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Mapping, Optional, Sequence, Set, Tuple

from . import toc
from .toc_rules import RULES, TocRule, by_name

__all__ = [
    'COMMENT_PREFIX',
    'DEFAULT_PATH',
    'EXAMPLE_PATH',
    'OverrideError',
    'Overrides',
    'load',
    'missing_notice',
    'pick_rule_for',
]

#: `scripts/`：本文件在 `scripts/lib/`，本机表与格式示例都放在它的上一级。
_SCRIPTS_DIR: Path = Path(__file__).resolve().parent.parent

#: 覆盖表的默认位置：本机的 `scripts/toc-overrides.local.json`（已被 `.gitignore` 排除）。
#: 按**模块文件位置**解析而不是按 `cwd`——预处理从哪个目录发起都该读到同一张表。
DEFAULT_PATH: Path = _SCRIPTS_DIR / 'toc-overrides.local.json'

#: 进版本库的格式示例。预处理从不读它（`DEFAULT_PATH` 缺失时也不改读），只有测试加载它。
EXAMPLE_PATH: Path = _SCRIPTS_DIR / 'toc-overrides.example.json'

#: 以此开头的键是注释，加载时跳过（见模块 docstring）。
COMMENT_PREFIX = '//'

#: 对象写法里认得的字段。
_RULE_KEY = 'rule'
_ORDER_KEY = 'order'
_OBJECT_KEYS = (_RULE_KEY, _ORDER_KEY)


class OverrideError(Exception):
    """覆盖表本身有问题：不是合法 JSON、根不是对象、值的形状不对、规则名不存在。

    一律由编排层打印后以非零码退出——这是配置错误，不是"某一本书的问题"，
    换一本书继续跑只会把同一个错误重复 7000 次。
    """


@dataclass(frozen=True)
class Overrides:
    """加载并校验完毕的覆盖表。值已解析成 `TocRule`，查表不会再失败。"""

    path: Path
    """表的来源路径。写进告警/报错信息，让人知道该去改哪个文件。"""

    table: Mapping[str, TocRule]
    """`book_id` → 点名的规则。空表是完全正常的状态（多数时候就是空的）。"""

    found: bool = True
    """表文件是否存在。只有 `load()` 在文件不存在时给出 `False`，此时 `table` 必为空，
    编排层据此打印一行 `missing_notice()`。带默认值，直接构造（测试里常见）不必写它。"""

    orders: Mapping[str, Tuple[str, ...]] = field(default_factory=dict)
    """`book_id` → 合集包里各 `.txt` 的并入顺序（文件名）。带默认值，理由同 `found`。"""

    @property
    def book_ids(self) -> Set[str]:
        """表里点名的全部书（规则与顺序两种覆盖的并集）。"""
        return set(self.table) | set(self.orders)

    def __len__(self) -> int:
        return len(self.book_ids)

    def __contains__(self, book_id: str) -> bool:
        return book_id in self.table or book_id in self.orders

    def rule_for(self, book_id: str) -> Optional[TocRule]:
        """取这本书被点名的规则；没点名返回 `None`（调用方走自动判定）。"""
        return self.table.get(book_id)

    def order_for(self, book_id: str) -> Optional[Tuple[str, ...]]:
        """取这本书被指定的合集并入顺序；没指定返回 `None`（调用方自动排序）。"""
        return self.orders.get(book_id)

    def unused(self, known_book_ids: Sequence[str]) -> List[str]:
        """返回一条源文件都匹配不上的覆盖键（排序后）。

        键写错时唯一能拿到的信号。编排层据此告警——不硬失败，因为"书被删了但
        覆盖项还留着"是合法状态，不该让整批停下。
        """
        known = set(known_book_ids)
        return sorted(key for key in self.book_ids if key not in known)


def _valid_rule_names() -> str:
    """全部合法规则名，逐条列出（含默认不启用的激进规则）。"""
    return '\n'.join(
        f'  - {rule.name}' + ('（默认不启用，只能在此表点名）' if not rule.enabled else '')
        for rule in RULES
    )


def load(path: Optional[Path] = None) -> Overrides:
    """读取并**整表校验**覆盖表。

    Args:
        path: 表路径，默认 `DEFAULT_PATH`。

    Returns:
        `Overrides`。文件不存在时返回空表且 `found=False`——"没有覆盖"是正常状态，
        不该因为一个可选配置缺失就让整批失败；要不要提示由编排层按 `found` 决定
        （`missing_notice()`）。本函数自己不打印任何东西。

    Raises:
        OverrideError: 文件读取失败、不是合法的 UTF-8、不是合法 JSON、根不是对象、键为空、
            值既不是非空字符串也不是合法的对象写法、或规则名不存在。报错信息一律带上文件路径
            与出问题的那一项。
    """
    target = Path(path) if path is not None else DEFAULT_PATH

    if not target.exists():
        return Overrides(path=target, table={}, found=False)

    try:
        raw = json.loads(target.read_text(encoding='utf-8'))
    except json.JSONDecodeError as e:
        raise OverrideError(f'{target} 不是合法 JSON：第 {e.lineno} 行第 {e.colno} 列 {e.msg}') from e
    except UnicodeDecodeError as e:
        # 既不是 OSError 也不是 JSONDecodeError：不接住的话，编排层只认 OverrideError，
        # 打出来的是一段不带文件路径的 traceback。
        raise OverrideError(f'{target} 不是合法的 UTF-8：字节偏移 {e.start} 处 {e.reason}') from e
    except OSError as e:
        raise OverrideError(f'{target} 读取失败：{e}') from e

    if not isinstance(raw, dict):
        raise OverrideError(
            f'{target} 的根必须是对象（形如 {{"书名-作者": "规则名"}}），实际是 {type(raw).__name__}'
        )

    table: Dict[str, TocRule] = {}
    orders: Dict[str, Tuple[str, ...]] = {}
    for key, value in raw.items():
        if key.startswith(COMMENT_PREFIX):
            continue                                  # 注释键，见模块 docstring
        book_id = key
        if not book_id.strip():
            raise OverrideError(f'{target} 里有一项的键（book_id）是空白；空键永远匹配不上任何书')
        if isinstance(value, dict):
            rule, order = _parse_object(target, book_id, value)
            if rule is not None:
                table[book_id] = rule
            if order is not None:
                orders[book_id] = order
            continue
        if not isinstance(value, str):
            raise OverrideError(
                f'{target} 里 "{book_id}" 的值必须是规则名字符串，'
                f'或形如 {{"rule": "规则名", "order": ["文件名.txt", …]}} 的对象，'
                f'实际是 {type(value).__name__}：{value!r}'
            )
        table[book_id] = _parse_rule(target, book_id, value)

    return Overrides(path=target, table=table, orders=orders)


def _parse_rule(target: Path, book_id: str, value: str) -> TocRule:
    """规则名字符串 → `TocRule`；不存在时列出全部合法名并抛错。"""
    name = value.strip()                              # 容忍手写时多打的空格
    if not name:
        raise OverrideError(f'{target} 里 "{book_id}" 的规则名是空白')
    rule = by_name(name)                              # 连 enabled=False 的一起取
    if rule is None:
        raise OverrideError(
            f'{target} 里 "{book_id}" 指定的规则名 "{name}" 不存在。\n'
            f'合法规则名：\n{_valid_rule_names()}\n'
            '（覆盖表不会在规则名写错时退回自动判定——那等于把你已经否决过的结果装回去。）'
        )
    return rule


def _parse_object(
    target: Path,
    book_id: str,
    value: Mapping[str, object],
) -> Tuple[Optional[TocRule], Optional[Tuple[str, ...]]]:
    """对象写法 `{"rule": …, "order": […]}` → `(规则, 并入顺序)`，两者至少有一个。

    `order` 里的文件名能不能对上包里的文件，要到处理这本书时才知道（`bundle.plan`）；
    这里只验形状：非空列表、每项是非空字符串、不重复。
    """
    fields = {k: v for k, v in value.items() if not k.startswith(COMMENT_PREFIX)}
    unknown = sorted(k for k in fields if k not in _OBJECT_KEYS)
    if unknown:
        raise OverrideError(
            f'{target} 里 "{book_id}" 的对象有不认识的字段 {"、".join(unknown)}；'
            f'只认 {"、".join(_OBJECT_KEYS)}'
        )
    if not fields:
        raise OverrideError(
            f'{target} 里 "{book_id}" 的对象是空的：{_RULE_KEY} 与 {_ORDER_KEY} 至少写一个'
        )

    rule: Optional[TocRule] = None
    if _RULE_KEY in fields:
        raw_rule = fields[_RULE_KEY]
        if not isinstance(raw_rule, str):
            raise OverrideError(
                f'{target} 里 "{book_id}" 的 {_RULE_KEY} 必须是规则名字符串，'
                f'实际是 {type(raw_rule).__name__}：{raw_rule!r}'
            )
        rule = _parse_rule(target, book_id, raw_rule)

    order: Optional[Tuple[str, ...]] = None
    if _ORDER_KEY in fields:
        raw_order = fields[_ORDER_KEY]
        if not isinstance(raw_order, list) or not raw_order:
            raise OverrideError(
                f'{target} 里 "{book_id}" 的 {_ORDER_KEY} 必须是非空的文件名列表，'
                f'实际是 {raw_order!r}'
            )
        names: List[str] = []
        for item in raw_order:
            if not isinstance(item, str) or not item.strip():
                raise OverrideError(
                    f'{target} 里 "{book_id}" 的 {_ORDER_KEY} 里有一项不是非空字符串：{item!r}'
                )
            name = item.strip()
            if name in names:
                raise OverrideError(
                    f'{target} 里 "{book_id}" 的 {_ORDER_KEY} 把 "{name}" 列了两次'
                )
            names.append(name)
        order = tuple(names)

    return rule, order


def missing_notice(path: Path) -> str:
    """表文件不存在（`found=False`）时，编排层打印的那一行提示（test-data-desensitization 需求 3.12）。

    返回值不带换行符，行尾由调用方的 `print` 补上，所以恰好占 1 行。路径经
    `Path.resolve()` 写成绝对路径：与 `DEFAULT_PATH` 的解析方式一致；传入相对路径
    或带 `..` 的路径时，给出的也是部署者该把文件放过去的那个位置。

    Args:
        path: 期望的表路径，通常就是 `Overrides.path`。
    """
    where = Path(path).resolve()
    return (
        f'  [覆盖] 未找到本机覆盖表 {where}：本次不做人工覆盖，全部按自动判定'
        f'（格式见 scripts/{EXAMPLE_PATH.name}）'
    )


def pick_rule_for(
    text: str,
    book_id: str,
    overrides: Optional[Overrides] = None,
) -> toc.RulePick:
    """选规则的唯一入口：先查覆盖表，未命中才走自动判定（需求 8.10）。

    这是 design §4.7 说的"`pick_rule` 前先查覆盖表"。查表放在这一层而不是塞进
    `pick_rule`：评分器只认规则表、不认 `book_id`，也不读文件，这样它在
    `scripts/tests/test_toc.py` 里能被单独喂合成文本来断言（保持纯函数）。

    Args:
        text: 全文。命中覆盖时**完全不读**——跳过采样评分也顺带省下这遍扫描。
        book_id: 这本书的 id，即覆盖表的键。
        overrides: 已加载的覆盖表；`None` 等价于空表。

    Returns:
        `toc.RulePick`。命中覆盖时 `overridden=True`、`scores` 为空、
        `n_ok`/`n_bad` 为 0——那些是评分产出的诊断数据，这里根本没评分，
        填任何非零值都是编造。
    """
    forced = overrides.rule_for(book_id) if overrides is not None else None
    if forced is not None:
        return toc.RulePick(rule=forced, n_ok=0, n_bad=0, scores=(), early_exit=False, overridden=True)
    return toc.pick_rule(text)
