#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""预处理编排层（design §1 / §4.8 / §4.9，需求 7.1 / 7.2 / 7.5 / 7.9 / 7.12 / 5.1 / 5.2a / 5.2b / 10.7，任务 26 / 65）。

    python scripts/preprocess.py                  # 或 python -m scripts.preprocess
    python scripts/preprocess.py --delete-source  # 处理完一本就删它的源包（需求 7.12）

一条流水线，每个环节都在 `scripts/lib/` 里（design §4.1），本文件只负责串起来：

    扫描源目录 → 改名识别 → 占住已分配的 id → 增量判定（摘要 + 流水线版本）
              → 解压 → 解码 → 择一规则 → 切分 → 卷标记 → 兜底 → 拼音
              → 压缩（源包 ≤10MB: gz9 / >10MB: zopfli）→ 自校验 → 更新清单 →（删源包）
              → 归档书（沿用 / 按 .txt.gz 重切 / 遗忘）→ 写 books.json → 孤儿产物
              → 汇总 → 容量护栏 → 退出码

## 逐本 try/except 是这一层存在的主要理由（需求 7.1 / 7.2）

改造前的版本**完全没有 try/except**：一本坏书（解压失败、编码诡异、切分越界）终止
整批；而 `books.json` 在循环之后才写，崩溃即本次全部成果丢失。7000 本的规模下这
等于"必须先保证 7000 本全都没问题，才能拿到任何产物"。

现在是三层：

1. 单本异常 → `rep.fail(src, e)` 记原因并当场打全完整报错，`continue` 下一本。
2. 每本成功 → `mf.update()` 立刻落盘（需求 7.3）；Ctrl-C / 断电后已完成的书下次被跳过。
3. 批次结束 → `rep.summary()` + `rep.guard_rails()` 算出退出码，入口 `raise SystemExit(...)`。

两个刻意的例外，它们不是"某一本书的问题"，继续跑只会把同一个错误重复 7000 次：

- **必需依赖缺失**（`require_dependencies()` / `archive.MissingExtractorError`）——
  环境问题，报错退出（需求 7.7）。
- **覆盖表写错**（`toc_overrides.OverrideError`）——配置问题，退出前列出全部合法规则名。
  本机覆盖表**缺失**不在此列：照常运行、全部自动判定，开头打印一行提示（`run()`）。

## 校验在写清单之前（需求 7.10）

顺序是 `validate.check(meta, toc_data)` → `mf.update(...)`，不可交换：产物结构坏掉的书
必须**不进清单**，否则它会带着一条"处理过"的记录躺在那儿，此后每次运行都被跳过，
直到有人手工删清单——那正是需求 7.10 要消掉的形态。

## `books.json` 的形状（需求 5.1 / 5.2a / 5.2b）

- **无缩进**（`separators=(',', ':')`）、**不含 `txtPath`/`tocPath`**：前端按 `id`
  派生两个 URL（design §2.2）。实测 7000 本从 324 B/本 降到 110 B/本（附录 M2）。
  约束的对象是客户端 `JSON.parse` 的耗时与常驻内存，不是传输体积——传输由平台压缩解决。
- **字段用可读全名**：`titleAbbr` 而非 `tp`。gzip 已把重复键名去重，长短键压缩后只差
  2 KB（附录 M2），缩写换不到体积只换来产物不可读。
- **不预压缩为 `.gz`**：依赖 Cloudflare Pages 自动 gzip/brotli（需求 5.2a、附录 P4）。
  自己压掉的是浏览器的透明解压，前端得手写一条解压路径，且没有收益。
- `generatedAt` 是秒级 UTC ISO 8601（`validate.TIMESTAMP` 的口径）。

**本次失败的书不进索引。**哪怕它上一轮成功过、产物还躺在磁盘上：索引里的每一条都必须
是这一轮亲自确认过的（自校验通过或清单记录完整）。代价是它会从书架上消失一轮——但那一轮
的退出码本来就是非零，构建红着、部署不该发生；反过来"把没验过的条目留在索引里"才是
旧版那种"页面在、资源 404"的来源。源文件没变的话，下一轮它会走跳过路径重新进索引。

**被跳过的书也必须出现在 `books.json` 里**，源文件已删除的书（归档书）同理。它是全库
索引而不是"本次处理了什么"的日志：只写本次处理的书，等于第二次运行之后书架上只剩改动过
的那几本。这两类书的规模数字取自清单记录（`manifest.Entry`），不回头解析 7000 个
`_toc.json`（report.py 的同一条理由）。清单记录不足以重建条目时（字段为 0、`bookId` 与
本次分配的 id 不一致）不硬撑，改为**重新处理这一本**（归档书则从 `.txt.gz` 重切）——宁可
多跑一本，也不写出一条数字可疑的索引。条目按源文件名排序，与源文件在不在无关。

## 源文件删了，书还在（需求 7.5 修订）

`zip-novel/` 只是输入，不是书库的名单。清单里有、源目录里没有的书是**归档书**：产物与
`books.json` 条目都沿用清单记录——源包可以删，站点不受影响。归档书同样走增量：

- 两个产物都在、记录完整、流水线版本是当前的 → 原样进索引（不逐本输出，汇总里记
  "归档 N"）；
- 流水线换版、`_toc.json` 缺失、或清单数字不可用 → 从 `.txt.gz` 解出全文**只重切章节**
  （`resplit_book`）。`.txt.gz` 就是当初解码后的全文、逐字符相同，重切不需要源包，
  `PIPELINE_VERSION` 也就不会在删源之后悄悄失效；
- 只缺 `.txt.gz` → 正文无从恢复：告警、不进索引、清单条目保留，把源包放回来即可重建；
- 两个产物都不在 → 这本书被人删掉了，清单遗忘它。**从书库移除一本书就是这样做的**：
  删掉它的源文件（如果还在）和两个产物。

另外两条配套：

- **改名识别**：新出现的源文件与某本归档书摘要相同 → 只是改了名，接管那条记录，
  `book_id` 不变、不重做（旧版靠 `prune` + 重跑做到同样的结果，现在不删东西了）。
- **已分配的 id 先占住**（`claim_recorded_ids`）：源包已删除的书没法重建，它的 id 一旦
  被新来的同名书拿走，产物就被覆盖、再也找不回来。见 report.py"`book_id` 一经分配就不变"。

批次末尾扫一遍产物目录，点名**孤儿产物**——磁盘上有、清单与本次索引里都没有的 id。
清单丢失/重置时源文件已删除的书只能从索引里消失，这条告警让它不再静默。

## `--delete-source`：处理一本删一本（需求 7.12）

一本书的产物写完、自校验通过、清单落盘之后，删掉它在 `zip-novel/` 里的源包；被增量判定
跳过的书（上一轮已经处理好的）同样删。三种情况**不删**：这本失败了；产物 gz 超过 25 MiB
（护栏会让本批失败，改判 zopfli 重压要用到源包）；删除本身出错（只告警，下次按跳过处理）。

删源之后，清单是这本书在产物之外唯一的记录——**不要把 `.preprocess-manifest.json` 当缓存
删掉**。`MANIFEST_VERSION` 同理，改它必须写迁移（manifest.py 模块 docstring）。

## 压缩器按源包体积二选一（需求 10.7，design §4.8）

`ZOPFLI_SRC_BYTES = 10 MiB`，判定输入是**源压缩包体积**：解压前就已知，判定零成本。
不按产物体积判定——那意味着"先 gz9 压一遍、超了再 zopfli 压一遍"，对一本 80MB 的书
白烧 1.7 秒还多一条分支状态；也不做逐本连续调级：level 9 已是 gzip 天花板，级别层面
没有余量可挖（附录 M5）。

API 钉死在 `zopfli.gzip.compress`。同一个包另有输出 zlib 与裸 deflate 的接口，压缩数据
一样是 DEFLATE 但容器不同，前端 `DecompressionStream("gzip")` 会**静默**解不开、构建期
毫无征兆。`zopfli` 因此是硬依赖：缺失即报错退出，**不回退 gz9**——回退等于对一本已知
越限的书静默写出 > 25MB 的产物，把构建期的硬错误换成部署后的资源 404。

## 写 `.txt.gz` 的字节就是解码结果的字节

`text.encode('utf-8')` 之后直接 `gzip.compress`，全链路不再经过任何文本模式的写入。
旧写法用 `gzip.open(..., 'wt')` 依赖"读时把 CRLF 归一成 LF、写时再换回 CRLF"两次翻译
互相抵消，代价是 `charCount` 与章节偏移按归一后的文本算、产物里却是 CRLF——实测现有
产物 gz 解出的字符数比 `_toc.json` 的 `charCount` 多出一个行数，每行差 1 个字符。
INV-1 只有一个坐标系，就是这里压进去的那串字符。反过来这也是归档书能从 `.txt.gz`
重切的前提：解压出来的就是当初切章用的那串字符，`charCount` 一个都不差
（`resplit_book` 会核对）。
"""

from __future__ import annotations

import argparse
import gzip
import importlib.util
import json
import re
import sys
import tempfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, IO, List, Optional, Sequence, Set, Tuple

# ---------------------------------------------------------------------------
# 输出流一律重设为 UTF-8（stdout **与** stderr）
#
# Windows 控制台默认 cp936（GBK），而这条流水线里的一切——书名、告警、报错——都是
# UTF-8 文本。只重设 stdout 是个会吃掉整批的漏洞：告警与失败走的是 **stderr**，而
# `report.Report.fail()` 是在逐本的 `except Exception` **里面**被调用的（见模块
# docstring 的三层容错）。那里抛出的 `UnicodeEncodeError` 不会被本书的 `try` 接住
# ——它就是从 handler 里飞出来的——于是剩下的几千本一起终止，正是三层容错要消掉的形态。
#
# 这不是"运气不好的书名才触发"：`fail()` 的行首是 "❌"（U+274C），它本身就不在 GBK
# 里。stock cp936 控制台下，**第一本失败的书**就会把整批带走。7,681 本那次能跑完，
# 只是因为命令行上带了 PYTHONIOENCODING=utf-8。
#
# 第二道防线在 `report._emit`：流重设不了时（编码写死的管道、嵌入式 runner）按
# backslashreplace 降级输出。打得歪的告警远好过死掉的批次。
# ---------------------------------------------------------------------------


def _force_utf8(stream: Optional[IO[str]]) -> None:
    """把一条输出流重设为 UTF-8；不支持重设就静默放过（`report._emit` 兜着）。"""
    if stream is None or not hasattr(stream, 'reconfigure'):
        return
    try:
        stream.reconfigure(encoding='utf-8')          # type: ignore[attr-defined]
    except Exception:
        pass


_force_utf8(sys.stdout)
_force_utf8(sys.stderr)

REPO_ROOT = Path(__file__).resolve().parent.parent

# 以脚本方式运行时（`python scripts/preprocess.py`），sys.path[0] 是 scripts/，
# 仓库根目录不在搜索路径上，`scripts.lib.*` 无法导入。补上根目录，使
# `python scripts/preprocess.py` 与 `python -m scripts.preprocess` 等价。
if __package__ in (None, ''):
    sys.path.insert(0, str(REPO_ROOT))

# ---------------------------------------------------------------------------
# 必需依赖前置检查（需求 7.7 / 7.9）
#
# 这些依赖一律按"声明即必需"处理：缺失就报错退出，不静默降级、不多级回退。
# 旧写法把 charset-normalizer 做成可选导入，缺失时悄悄退回"猜 gb18030"，
# 结果是产物满屏乱码而日志一片正常——正是这条要消掉的行为。
# ---------------------------------------------------------------------------

REQUIRED_DEPENDENCIES: Tuple[Tuple[str, str, str], ...] = (
    ('charset_normalizer', 'charset-normalizer', '编码探测（BOM 之外的候选判定）'),
    ('pypinyin', 'pypinyin', '书名/作者拼音首字母'),
    ('py7zr', 'py7zr', '解压 .7z 源文件'),
    # 源包 >10MB 的书只能靠它压进 25 MiB（需求 10.7）。缺失时**不得回退 gz9**：
    # 实测有书的 gz9 产物超出 25 MiB 上限，回退就是静默写出一个部署不上去的文件。
    ('zopfli', 'zopfli', '源包 >10MB 的书用 zopfli.gzip 压缩（缺失即失败，不回退 gz9）'),
)


def require_dependencies(
    dependencies: Sequence[Tuple[str, str, str]] = REQUIRED_DEPENDENCIES,
    stream: Optional[IO[str]] = None,
) -> None:
    """确认全部必需依赖可导入；缺失则打印修复方式并以非零码退出。

    Args:
        dependencies: `(模块名, 发行包名, 用途)` 三元组；默认 `REQUIRED_DEPENDENCIES`。
        stream: 报错输出流，默认 `sys.stderr`。

    Raises:
        SystemExit: 有依赖缺失。入口检查就该在这里终止——不是"某一本书失败"，
            换一本继续跑只会把同一个错误重复 7000 次。
    """
    missing: List[Tuple[str, str]] = []
    for module_name, dist_name, purpose in dependencies:
        try:
            found = importlib.util.find_spec(module_name) is not None
        except (ImportError, ValueError):
            found = False
        if not found:
            missing.append((dist_name, purpose))

    if not missing:
        return

    req_file = REPO_ROOT / 'scripts' / 'requirements.txt'
    lines = ['', '[依赖缺失] 预处理所需的以下 Python 包未安装：']
    for dist_name, purpose in missing:
        lines.append(f'  - {dist_name}（用途：{purpose}）')
    lines += [
        '',
        '请先安装后重试：',
        f'    python -m pip install -r {req_file}',
        f'  或：python -m pip install {" ".join(name for name, _ in missing)}',
        '',
        '预处理不会在依赖缺失时降级运行——降级只会产出看起来正常、实际错误的产物。',
        '',
    ]
    print('\n'.join(lines), file=stream if stream is not None else sys.stderr)
    raise SystemExit(1)


require_dependencies()

# 依赖检查之后再导入：lib.encoding 顶层就 import charset-normalizer、
# 本文件顶层就 import zopfli，缺失时应该由上面那份带修复指引的报错先说话。
from zopfli import gzip as zopfli_gzip  # noqa: E402  只用 .gzip.compress，见模块 docstring

from scripts.lib import archive  # noqa: E402  解压与源目录扫描（需求 7.6 / 7.7）
from scripts.lib import encoding  # noqa: E402  BOM → 探测 → 全文 strict 试解（需求 7.8）
from scripts.lib import manifest  # noqa: E402  SHA-256 增量清单与归档书（需求 7.3–7.5）
from scripts.lib import pinyin  # noqa: E402  书名/作者拼音首字母（需求 5.6）
from scripts.lib import report  # noqa: E402  逐本记账、id 消歧、汇总与护栏（需求 7.1/7.2/10.1）
from scripts.lib import toc  # noqa: E402  规则择一 + 全文切分 + 卷标记（需求 8.1–8.7a / 8.14）
from scripts.lib import toc_overrides  # noqa: E402  按 book_id 的规则人工覆盖（需求 8.10）
from scripts.lib import validate  # noqa: E402  产物 schema 自校验（需求 7.10 / 8.14）

# 章节识别的全部逻辑都在 scripts/lib/toc_rules.py（15 条具名规则，其中 3 条默认关闭、
# 只能由本机覆盖表点名）与 scripts/lib/toc.py（择一评分、篇幅门槛、切分、
# 卷标记）里，这里只负责编排。
#
# 原先内联在本文件的 7 条正则 + `END_PUNCT` 预筛 + `split_chapters` 已删除，原因：
#   - 7 条正则**同时套用、命中即取**，没有任何环节能否决一条明显在正文里乱匹的规则，
#     这是空章问题（D5）的根因。实测旧产物里有书出现成批 length < 35 的
#     "章节"（人物属性表的每一行都被当成了标题）；换成"一本书只选一条规则"后归零。
#   - `END_PUNCT`（行尾是 `。！？…` 就不算标题）实测会成批丢掉真标题，
#     形如 `第八章 快跑！快跑！`。规则表自带长度与排除集，不需要这道启发式预筛。
#   - 全书级 all-or-nothing 兜底（命中 < 2 条才整本按字数硬切）挪进 toc.py，
#     改为需求 8.8 / 8.9 的两级兜底：个别超长章就地再切（其余章节不受影响），
#     整本确实无规则可用（或选中规则的命中过不了全书篇幅门槛）时才按段落块切
#     并在产物上标 `fallback: true`。

__all__ = [
    'BOOKS_DIR',
    'DATA_DIR',
    'EXIT_CONFIG',
    'INDEX_NAME',
    'Processed',
    'REQUIRED_DEPENDENCIES',
    'SOURCE_DIR',
    'UNKNOWN_AUTHOR',
    'ZOPFLI_SRC_BYTES',
    'adopt_renamed',
    'build_index',
    'build_toc',
    'claim_recorded_ids',
    'compress_text',
    'consume_source',
    'find_orphans',
    'main',
    'parse_args',
    'parse_filename_meta',
    'pick_compressor',
    'process_book',
    'require_dependencies',
    'resplit_book',
    'run',
    'skipped_meta',
    'write_index',
]

#: 源目录（需求 A9：目录名保持 `zip-novel/`，但接受多种压缩格式）。
SOURCE_DIR: Path = REPO_ROOT / 'zip-novel'

#: 产物目录。直接取 `manifest` 的默认值，保证"清单查的"与"护栏扫的"是同两个目录
#: ——各写一份常量才是真正会漂的地方。
BOOKS_DIR: Path = manifest.DEFAULT_BOOKS_DIR
DATA_DIR: Path = manifest.DEFAULT_DATA_DIR

#: 全库索引的文件名（design §2.2）。**不生成 `books.json.gz`**（需求 5.2a）。
INDEX_NAME = 'books.json'

#: 压缩器选择的源包阈值（需求 10.7，design §4.8）。全库 7,681 本里仅 9 本越过它。
ZOPFLI_SRC_BYTES = 10 * 1024 * 1024

#: 配置/环境错误的退出码：源目录不存在、覆盖表写错、解压工具缺失。
#: 与 `report.EXIT_BOOK_FAILED` 同为 1——两者都是"重跑前得先动手改点什么"。
EXIT_CONFIG = 1


def _now_iso() -> str:
    """UTC 的秒级 ISO 8601 时间戳，形如 `2026-09-24T09:08:23Z`（`validate.TIMESTAMP`）。"""
    return datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


# ---------------------------------------------------------------------------
# 文件名 → 书名 / 作者 / book_id
# ---------------------------------------------------------------------------

#: 文件名里取不到作者时写入的作者占位值，意思是"作者未知"。它是本产品自己的占位值，
#: 不指向任何一位真实作者（test-data-desensitization S7）。前端 `src/utils/bookSearch.ts`
#: 的 `UNKNOWN_AUTHOR` 与它同名同值，改一边就得改另一边。Python 侧只在这里写一次字面量：
#: 测试与其他模块需要这个值时一律引用本常量，不再自己写一遍。
UNKNOWN_AUTHOR = '佚名'


def parse_filename_meta(filename: str) -> Tuple[str, str, str]:
    """从文件名中提取书名和作者，返回 `(book_id, 书名, 作者)`。

    返回的 `book_id` 是**未消歧**的原始 id：同名书的后缀由
    `report.Report.unique_id()` 在扫描顺序上决定（需求 7.9）。
    """
    name = Path(filename).stem
    # 典型格式：《书名》（校对版全本）作者：作者名
    title = name
    author = UNKNOWN_AUTHOR

    # 匹配 《书名》
    title_match = re.search(r'《(.*?)》', name)
    if title_match:
        title = title_match.group(1).strip()
    else:
        # 去掉常见后缀
        cleaned = re.sub(r'（.*?）|\(.*?\)|【.*?】', '', name)
        if "作者" in cleaned:
            parts = re.split(r'作者[：:]', cleaned)
            title = parts[0].strip()
        else:
            title = cleaned.strip()

    # 匹配 作者：xxx
    author_match = re.search(r'作者[：:]([^\s_（(]+)', name)
    if author_match:
        author = author_match.group(1).strip()

    # 生成安全的 book_id
    safe_id = re.sub(r'[^\w\u4e00-\u9fa5\-]', '_', f"{title}-{author}").strip('_')
    return safe_id, title, author


# ---------------------------------------------------------------------------
# 压缩器二选一（需求 10.7，design §4.8）
# ---------------------------------------------------------------------------


def pick_compressor(source_bytes: int) -> str:
    """按**源压缩包体积**选压缩器：`> 10MB` 用 `zopfli`，否则 `gz9`（需求 10.7）。

    阈值不含边界：刚好 10 MiB 的包走 gz9。判定输入是源包而不是产物，理由见模块
    docstring——源包体积在解压前就已知，不需要"先压一遍看超没超"。
    """
    return report.ZOPFLI if source_bytes > ZOPFLI_SRC_BYTES else report.GZ9


def compress_text(text: str, source_bytes: int) -> Tuple[bytes, str]:
    """把全文压成**标准 gzip 流**，返回 `(字节, 压缩器名)`。

    Args:
        text: 解码后的全文（管线里唯一的文本形态）。
        source_bytes: 源压缩包的体积，用于选压缩器（见 `pick_compressor`）。

    Returns:
        `(gzip 字节, 'gz9' | 'zopfli')`。两条分支的产物都以 gzip 魔数 `1f 8b` 起头、
        都能被 `gzip.decompress` 与前端 `DecompressionStream("gzip")` 读出，
        所以前端一行都不用改（附录 M5）。

    这里只允许 `zopfli.gzip.compress`。同包的 zlib / 裸 deflate 接口产物容器不同，
    前端会**静默**解不开——构建期没有任何征兆，所以这个调用点不接受"换个 zopfli
    接口也一样"的改动。
    """
    data = text.encode('utf-8')
    compressor = pick_compressor(source_bytes)
    if compressor == report.ZOPFLI:
        return zopfli_gzip.compress(data), compressor
    # mtime=0：产物只由文本内容决定，重跑同一本书得到逐字节相同的 gz。
    return gzip.compress(data, compresslevel=9, mtime=0), compressor


# ---------------------------------------------------------------------------
# 章节识别（覆盖表 → 择一 → 切分 → 卷标记 → 两级兜底）
# ---------------------------------------------------------------------------


def build_toc(
    text: str,
    book_id: str,
    overrides: Optional[toc_overrides.Overrides] = None,
) -> Tuple[List[Dict], Optional[str], bool]:
    """查覆盖表/择一规则 → 全文切分 → 卷标记 → 两级兜底，返回 `(chapters, 规则名, 是否兜底)`。

    规则名为 `None` 表示采样里一条规则都不可用（此时必然走了全书兜底）。
    `是否兜底` 只对**全书**兜底为真（需求 8.9）：选中规则在全文凑不出 2 个标题、
    或者命中过不了全书篇幅门槛（`toc.Coverage`），整本按段落块切。
    逐章兜底（需求 8.8，个别超长章就地再切）不算——规则依然可用，`tocRule` 依然有意义。
    """
    # 需求 8.10：本机覆盖表点了名就用那条规则，跳过自动判定；
    # 否则按需求 8.1–8.5 采样择一（只看前 100 万字符）。
    pick = toc_overrides.pick_rule_for(text, book_id, overrides)
    if pick.overridden:
        print(f'  [覆盖] 本机覆盖表为本书点名规则: {pick.name}（跳过自动判定）')
    elif pick.rule is None:
        print(f'  [兜底] {_no_rule_reason(pick)}，全书按段落块切分（需求 8.9）')
    else:
        print(
            f'  命中规则: {pick.name}'
            f'（采样内有效 {pick.n_ok} 章 / 疑似误报 {pick.n_bad}'
            f'{"，提前退出" if pick.early_exit else ""}）'
        )
    result = toc.split_book(text, pick.rule)         # 需求 8.7–8.9 / 8.14 / 8.15
    if result.fallback and pick.name is not None:
        # 采样里像有章节、全书却不成目录：要么过滤后凑不出 2 个标题（命中全挤在
        # 前 100 万字符里），要么命中够多、却过不了全书尺度的篇幅门槛。
        print(f'  [兜底] {_whole_book_reason(pick.name, result.cover)}，全书按段落块切分（需求 8.9）')
    return result.chapters, pick.name, result.fallback


def _no_rule_reason(pick: toc.RulePick) -> str:
    """`pick.rule is None` 时，说清采样里有命中的规则各是被哪道门槛挡掉的。

    分档顺序即 `toc.pick_rule` 的判定顺序。无人选中时装饰门槛与提前退出都不适用，
    取代门槛退化成"有效章节 > -1 + OVER_RULE"，所以每条有命中的规则恰好落进一档；
    零命中的规则不是候选，不列。
    """
    gates: Dict[str, List[str]] = {
        '误报门槛否决': [],
        f'有效章节不足 {toc.OVER_RULE} 个': [],
        '篇幅门槛否决（命中不像目录）': [],
    }
    labels = list(gates)
    for score in pick.scores:
        if score.hits == 0:
            continue
        if not score.usable:
            gates[labels[0]].append(score.name)
        elif score.n_ok < toc.OVER_RULE:
            gates[labels[1]].append(score.name)
        elif not score.covers:
            gates[labels[2]].append(score.name)
    parts = [f'{label}：{"、".join(names)}' for label, names in gates.items() if names]
    if not parts:
        return '采样内没有任何规则命中'
    return f'采样内没有规则可用（{"；".join(parts)}）'


def _whole_book_reason(name: str, cover: Optional[toc.Coverage]) -> str:
    """选中规则在全书尺度上被否掉的原因（`toc.split_book` 的两道门槛，哪道挡的说哪道）。"""
    if cover is None or cover.hits < 2:
        hits = cover.hits if cover is not None else 0
        return f'规则 {name} 在全文（剔除正文命中后）只有 {hits} 个标题，不足 2 个'
    details: List[str] = []
    if cover.sparse:
        details.append(
            f'命中少于 {toc.MIN_RULE_HITS} 个且平均节点 {cover.mean_node:,.0f} 字符'
            f' > {toc.MAX_MEAN_NODE:,}'
        )
    if cover.blind:
        details.append(
            f'可读节点只覆盖全书 {cover.useful_share:.3f} < {toc.MIN_USEFUL_SHARE}'
        )
    return (
        f'规则 {name} 在全文命中 {cover.hits} 个标题，但不像一张目录'
        f'（篇幅门槛：{"；".join(details)}）'
    )


# ---------------------------------------------------------------------------
# 单本处理
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Processed:
    """一本书处理成功后的全部产出。"""

    meta: Dict[str, object]
    """这本书在 `books.json` 里的条目，**就是写进产物的那个形状**（design §2.2）。"""

    toc_data: Dict[str, object]
    """已写出的 `_toc.json` 内容（design §2.1）。"""

    compressor: Optional[str]
    """`gz9` / `zopfli`（需求 10.7）。归档书重切时沿用清单记录，旧清单没记就是 `None`。"""

    def tagged(self) -> Dict[str, object]:
        """给 `manifest` / `report` 用的形态：`meta` + 压缩器标签。

        压缩器**不进 `books.json`**：前端不读它，7000 本 × 一个键只是体积浪费。
        但清单必须记——`.txt.gz` 本身看不出是 gz9 还是 zopfli 压的（两者都是标准
        gzip 流），而越限报错时第一个要回答的就是"zopfli 是不是已经上过了"
        （design §4.9）。被跳过的书的这个标签只剩清单里这一份。
        """
        return {**self.meta, 'compressor': self.compressor}


def process_book(
    source_path: Path,
    book_id: str,
    title: str,
    author: str,
    *,
    books_dir: Path,
    data_dir: Path,
    rep: report.Report,
    overrides: Optional[toc_overrides.Overrides] = None,
) -> Processed:
    """处理单本书籍：解压 → 解码 → 切章 → 压缩 → 写两份产物。

    Args:
        source_path: 源压缩包。
        book_id: 本批分配到的 id（`claim_recorded_ids` 沿用的，或 `unique_id` 新分配的）。
        title: 书名。
        author: 作者。
        books_dir: `.txt.gz` 的输出目录。
        data_dir: `_toc.json` 的输出目录。
        rep: 批次账本，用于收集本书的告警（解码 lossy 等）。
        overrides: 规则覆盖表。

    Returns:
        `Processed`。

    Raises:
        Exception: 任一环节的失败都原样抛出，由编排层记成这一本的失败并继续下一本
            （需求 7.1）。唯一的例外是 `archive.MissingExtractorError`——那是环境
            问题，编排层会据此终止整批（需求 7.7）。
    """
    print(f"\n正在处理: 《{title}》 (作者: {author}) → {book_id}")
    source_bytes = source_path.stat().st_size

    with tempfile.TemporaryDirectory() as td:
        # 解压出的 .txt 只在这个块里活着：出块即删，7000 本不会在磁盘上堆出第二份库。
        txt_path = archive.extract_largest_txt(source_path, Path(td))
        raw_size = txt_path.stat().st_size
        print(f"  解压成功，原始体积: {raw_size / 1024 / 1024:.2f} MB")

        # 编码规范化（需求 7.8）：BOM 优先 → 采样探测 → 全文 strict 试解 + 有效性校验。
        # 出口已是去除 BOM 的 UTF-8 str，此处不再有第二种文本形态。
        decoded = encoding.decode_file(txt_path)

    # 告警交给账本而不是 `decoded.emit_warnings()`：这样它们会计进批次汇总的条数。
    rep.warn_all(decoded.warnings)
    source = 'BOM' if decoded.from_bom else '探测'
    print(f"  检测编码: {decoded.encoding}（来源: {source}，候选序: {' → '.join(decoded.tried)}）")

    text = decoded.text
    char_count = len(text)
    if not text.strip():
        # 空文本切不出章节表，产物也没有意义。当场给一句能读的失败原因，
        # 而不是让它掉进 validate 的"chapters 为空"（那读起来像切分逻辑坏了）。
        raise ValueError(
            f'解压出的文本为空（{char_count} 字符）：源文件里那个 .txt 可能是占位文件。'
        )
    print(f"  读取字符数: {char_count:,} 字")

    # 章节识别：覆盖表/采样择一规则 → 全文切分（range 含自身标题行）→ 卷标记 → 两级兜底
    toc_data = _toc_data(text, book_id, title, author, overrides)

    # 压缩（需求 10.7）：按源包体积二选一，写入的字节即解码结果的 UTF-8 编码，
    # 不经任何文本模式翻译（模块 docstring 末节）。
    payload, compressor = compress_text(text, source_bytes)
    books_dir.mkdir(parents=True, exist_ok=True)
    gz_path = books_dir / manifest.gz_name(book_id)
    gz_path.write_bytes(payload)
    gz_size = len(payload)
    print(
        f"  压缩完成（{compressor}）: {gz_size / 1024 / 1024:.2f} MB"
        f"（压缩比: {gz_size / raw_size * 100:.1f}%）"
    )

    _write_toc(toc_data, data_dir)
    return Processed(meta=_index_meta(toc_data, gz_size), toc_data=toc_data, compressor=compressor)


def resplit_book(
    entry: manifest.Entry,
    title: str,
    author: str,
    *,
    books_dir: Path,
    data_dir: Path,
    overrides: Optional[toc_overrides.Overrides] = None,
) -> Processed:
    """源文件已删除的书：从现有 `.txt.gz` 解出全文，**只重切章节**、重写 `_toc.json`。

    `.txt.gz` 一个字节都不动：正文没变，压缩器也就不必重选（源包都没了，本来也无从按
    源包体积选），压缩器标签沿用清单记录。能这样做的前提见模块 docstring 末节——gz 里
    就是当初切章用的那串字符。

    Args:
        entry: 这本书的清单记录，`book_id` 与规模数字取自它。
        title: 书名（由清单键即当初的源文件名推出）。
        author: 作者。
        books_dir: `.txt.gz` 所在目录。
        data_dir: `_toc.json` 的输出目录。
        overrides: 规则覆盖表——点名规则对归档书同样生效。

    Raises:
        OSError / EOFError / gzip.BadGzipFile / UnicodeDecodeError: gz 读不了或坏了。
        ValueError: 解出的文本为空，或字符数与清单记录不符（这份 gz 不是清单描述的那本书）。
        以上都由编排层记成这一本的失败（需求 7.1）。
    """
    book_id = entry.book_id
    print(f"\n正在重切: 《{title}》 (作者: {author}) → {book_id}（源文件已不在，按 .txt.gz 重切章节）")
    gz_path = books_dir / manifest.gz_name(book_id)
    payload = gz_path.read_bytes()
    text = gzip.decompress(payload).decode('utf-8')
    char_count = len(text)
    if not text.strip():
        raise ValueError(f'{gz_path.name} 解出的文本为空（{char_count} 字符），无从重切。')
    if entry.char_count > 0 and char_count != entry.char_count:
        # 清单数字为 0（不可用）时没有可比的对象，那正是要靠重切来修的情形。
        raise ValueError(
            f'{gz_path.name} 解出 {char_count:,} 字符，清单记的是 {entry.char_count:,}：'
            '这份 gz 不是清单描述的那本书，不拿它重切。'
        )
    print(f"  读取字符数: {char_count:,} 字（自 {gz_path.name}）")

    toc_data = _toc_data(text, book_id, title, author, overrides)
    _write_toc(toc_data, data_dir)
    return Processed(
        meta=_index_meta(toc_data, len(payload)),
        toc_data=toc_data,
        compressor=entry.compressor,
    )


def _toc_data(
    text: str,
    book_id: str,
    title: str,
    author: str,
    overrides: Optional[toc_overrides.Overrides],
) -> Dict[str, object]:
    """切章并组装 `_toc.json` 的内容（design §2.1）。`process_book` 与 `resplit_book` 共用。

    字段顺序即 design §2.1 的顺序。`fallback` 与 `isVolume` 同一约定——"真时才输出"，
    避免 7000 本 × 冗余 false 的体积浪费（前端按 `!!c.isVolume` 与 `!!toc.fallback`
    读取）。`tocRule` 在兜底且无规则可用时是 null："选中了哪条规则"与"是否兜底"是两件
    独立的事，各自记各自的。
    """
    chapters, toc_rule, fallback = build_toc(text, book_id, overrides)
    # totalChapters 只数非卷节点（design §2.1 不变量 4）
    total_chapters = toc.count_content_chapters(chapters)
    volume_count = len(chapters) - total_chapters
    print(f"  章节提取完成: 正文 {total_chapters} 章 + 卷节点 {volume_count} 个")

    toc_data: Dict[str, object] = {
        'id': book_id,
        'title': title,
        'author': author,
        'charCount': len(text),
        'totalChapters': total_chapters,
        'tocRule': toc_rule,
    }
    if fallback:
        toc_data['fallback'] = True
    toc_data['chapters'] = chapters
    return toc_data


def _write_toc(toc_data: Dict[str, object], data_dir: Path) -> Path:
    """写出 `<data_dir>/<id>_toc.json`。

    这份保留 `indent=2`：它是 INV-2 要求"可直接打开审查"的那个产物，单书最大
    494 KB、压缩后 89 KB（附录 M2），代价可接受。需求 5.1 的去缩进只针对
    `books.json`——那份是**每次开书架都要 parse** 的全库索引。
    """
    data_dir.mkdir(parents=True, exist_ok=True)
    toc_path = data_dir / manifest.toc_name(str(toc_data['id']))
    with open(toc_path, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(toc_data, f, ensure_ascii=False, indent=2)
    return toc_path


def _index_meta(toc_data: Dict[str, object], gz_size: int) -> Dict[str, object]:
    """这本书在 `books.json` 里的条目（design §2.2），与 `_toc.json` 的共享字段同源。

    字段顺序即 design §2.2 的顺序：拼音首字母紧跟 author。`abbr_fields` 只返回该写出的
    键——纯 ASCII 书名（如《XYZ》）的缩写与书名小写相同，写出来是把检索串里已有的内容
    抄第二遍（需求 5.6）。
    """
    title = str(toc_data['title'])
    author = str(toc_data['author'])
    abbrs = pinyin.abbr_fields(title, author)
    if abbrs:
        print(f"  拼音首字母: {', '.join(f'{k}={v}' for k, v in abbrs.items())}")
    return {
        'id': toc_data['id'],
        'title': title,
        'author': author,
        **abbrs,
        'charCount': toc_data['charCount'],
        'totalChapters': toc_data['totalChapters'],
        'gzSize': gz_size,
    }


def skipped_meta(
    entry: Optional[manifest.Entry],
    book_id: str,
    title: str,
    author: str,
) -> Optional[Dict[str, object]]:
    """用清单记录重建**被跳过**那本书（或归档书）在 `books.json` 里的条目。

    `books.json` 是全库索引，跳过的书与归档书同样要在里面（见模块 docstring）。规模数字
    取自清单而不是回头解析 `_toc.json`：7000 本那是几 GB 的额外 IO，换不到任何新信息。

    Returns:
        条目；`None` 表示**这条记录不足以重建索引，应当改为重新处理这一本**
        （归档书没有源包，改为从 `.txt.gz` 重切）。两种情形：

        - 数字字段为 0/负（清单是手工改过的、或上一次写入被打断）：写进 `books.json`
          会当场被 `validate.check_books` 判死，整批索引作废。宁可多跑一本。
        - `bookId` 与本次分配的 `book_id` 不一致：清单里的 id 已经不能由文件名推出
          （`claim_recorded_ids` 没有沿用它），磁盘上那组产物属于"上一轮的命名"，
          按新 id 重建一次才对得上。
    """
    if entry is None or entry.book_id != book_id:
        return None
    if entry.char_count < 1 or entry.gz_size < 1 or entry.total_chapters < 0:
        return None
    return {
        'id': book_id,
        'title': title,
        'author': author,
        **pinyin.abbr_fields(title, author),
        'charCount': entry.char_count,
        'totalChapters': entry.total_chapters,
        'gzSize': entry.gz_size,
    }


# ---------------------------------------------------------------------------
# books.json（需求 5.1 / 5.2a / 5.2b）
# ---------------------------------------------------------------------------


def build_index(books: Sequence[Dict[str, object]]) -> Dict[str, object]:
    """组装 `books.json` 的内容（design §2.2）。字段顺序即文档里的顺序。"""
    return {
        'count': len(books),
        'generatedAt': _now_iso(),
        'books': list(books),
    }


def write_index(payload: Dict[str, object], data_dir: Path) -> Path:
    """写出 `books.json`：**无缩进、无 `txtPath`/`tocPath`、不预压缩**（需求 5.1 / 5.2a）。

    `separators=(',', ':')` 连键值之间的空格都不留。约束的对象是客户端 `JSON.parse`
    的耗时与常驻内存（附录 M2：324 → 110 B/本），传输体积由 Pages 的自动压缩解决
    ——所以这里**不**顺手生成一个 `.gz`（需求 5.2a：自己压掉的是浏览器的透明解压）。
    """
    data_dir.mkdir(parents=True, exist_ok=True)
    path = data_dir / INDEX_NAME
    text = json.dumps(payload, ensure_ascii=False, separators=(',', ':'))
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)
    return path


# ---------------------------------------------------------------------------
# 编排的几个环节（design §4.9，需求 7.5 修订 / 7.12）
# ---------------------------------------------------------------------------


@dataclass
class Batch:
    """一批里跨环节的账。"""

    books: Dict[str, Dict[str, object]] = field(default_factory=dict)
    """源文件名（清单键）→ `books.json` 条目。按键排序写出，与源文件在不在无关。"""

    unindexed: Set[str] = field(default_factory=set)
    """产物可能还在磁盘上、但本批**故意**不进索引的 id（失败的书、缺正文的归档书）。
    孤儿产物扫描把它们排除在外——它们各自已经有一条更具体的报错。"""

    pipeline_redone: List[str] = field(default_factory=list)
    """只因流水线版本变更而重做的书（`manifest.PIPELINE_VERSION`），含按 `.txt.gz` 重切的归档书。"""

    deleted: int = 0
    """`--delete-source` 删掉的源文件数。"""

    freed: int = 0
    """`--delete-source` 释放的字节数。"""


def _id_derivable(raw_id: str, book_id: str) -> bool:
    """`book_id` 能否由这个文件名推出：就是裸 id，或它的消歧形态 `<裸 id>_N`。"""
    if book_id == raw_id:
        return True
    prefix = f'{raw_id}_'
    suffix = book_id[len(prefix):]
    return book_id.startswith(prefix) and suffix.isascii() and suffix.isdigit()


def adopt_renamed(
    mf: manifest.Manifest,
    sources: Sequence[Path],
    rep: report.Report,
) -> Dict[str, str]:
    """源文件改了名：摘要与某本归档书相同的**新**源文件，接管那条清单记录。

    内容一个字节没变，`book_id` 与产物原样沿用、不重做。旧版靠 `prune` 删掉旧名那组产物、
    再按新名重跑达到同样的结果；现在源文件消失不再删任何东西（需求 7.5 修订），不做这一步
    的话，改名会在书架上多出一本同名书。

    Returns:
        本步算过的摘要（源文件名 → SHA-256），主循环直接复用、不读第二遍。没有归档书、
        或没有新源文件时什么都不算，返回空表。
    """
    fresh = [src for src in sources if src not in mf]
    by_digest = {entry.digest: key for key, entry in mf.archived(sources)}
    digests: Dict[str, str] = {}
    if not fresh or not by_digest:
        return digests

    for src in fresh:
        try:
            digest = manifest.sha256_file(src)
        except OSError:
            continue              # 主循环会再读一次，把它记成这一本的失败（需求 7.1）
        digests[src.name] = digest
        old = by_digest.pop(digest, None)
        if old is None:
            continue
        try:
            entry = mf.rekey(old, src)
        except manifest.ManifestError as exc:
            rep.warn(f'[改名] {old} → {src.name}：清单记录没能挪过去（{exc}），这本按新书处理。')
            continue
        print(f'  [改名] {old} → {src.name}：摘要一致，沿用 book_id "{entry.book_id}"')
    return digests


def claim_recorded_ids(
    mf: manifest.Manifest,
    parsed: Sequence[Tuple[Path, Tuple[str, str, str]]],
    rep: report.Report,
) -> Dict[str, str]:
    """逐本处理之前，把清单里已分配的 `book_id` 先占住（report.py"一经分配就不变"）。

    - 归档书的 id 一律占：它没有源包可重建，被新来的同名书拿走就是产物被覆盖、找不回来。
    - 源文件还在的书，id 仍能由文件名推出时占（`_id_derivable`）；推不出（文件名里的
      书名/作者变了）就不沿用，让它按新 id 重做。

    清单里 `book_id` 唯一（manifest.py），所以这些占位之间不会互相冲突。

    Returns:
        源文件名 → 沿用的 id。不在表里的书走 `rep.unique_id()`。
    """
    for key, entry in mf.archived(src for src, _meta in parsed):
        rep.claim(entry.book_id, key)

    sticky: Dict[str, str] = {}
    for src, (raw_id, _title, _author) in parsed:
        entry = mf.entry_for(src)
        if entry is None or not _id_derivable(raw_id, entry.book_id):
            continue
        if rep.claim(entry.book_id, src):
            sticky[src.name] = entry.book_id
    return sticky


def consume_source(src: Path, gz_size: int, rep: report.Report, batch: Batch) -> bool:
    """`--delete-source`（需求 7.12）：这本书的产物与清单记录都已落盘，删掉它的源包。

    只在两处调用：处理成功且清单写完之后，以及增量判定跳过之后。失败的书走不到这里。

    Returns:
        是否删掉了。产物 gz 超过 25 MiB 时**故意不删**：护栏会让本批失败，而改判 zopfli
        重压要用到源包（report.py"越限的两种情形"）。删除出错只告警——产物与清单都已
        写好，这本书下次按跳过处理，届时再删。
    """
    if gz_size > report.FILE_MAX_BYTES:
        rep.warn(
            f'[保留源文件] {src.name}：产物 gz {gz_size:,} B 超过单文件上限 '
            f'{report.FILE_MAX_BYTES:,} B，本批护栏会失败；改判重压要用到源包，这本不删。'
        )
        return False
    try:
        size = src.stat().st_size
        src.unlink()
    except OSError as exc:
        rep.warn(
            f'[删源失败] {src.name}（{exc}）：产物与清单都已写好，源包留在原处，'
            '下次运行按跳过处理时再删。'
        )
        return False
    batch.deleted += 1
    batch.freed += size
    print(f'  [删源] 已删除源文件，释放 {size / 1024 / 1024:.2f} MB')
    return True


def process_archived(
    key: str,
    entry: manifest.Entry,
    batch: Batch,
    *,
    mf: manifest.Manifest,
    rep: report.Report,
    books_dir: Path,
    data_dir: Path,
    overrides: Optional[toc_overrides.Overrides],
) -> None:
    """一本归档书（源文件已不在）：沿用、按 `.txt.gz` 重切、遗忘，或告警不进索引。

    决策表见模块 docstring"源文件删了，书还在"。异常只可能来自重切那一支，与主循环
    一样逐本记账、继续下一本（需求 7.1）。
    """
    _raw_id, title, author = parse_filename_meta(key)
    book_id = entry.book_id
    gz_ok, toc_ok = mf.artifact_state(book_id)

    if not gz_ok and not toc_ok:
        try:
            mf.forget(key)
        except manifest.ManifestError as exc:
            rep.warn(f'[移除] {key} → {book_id}：{exc}')
            return
        print(f'\n[移除] {key} → {book_id}：源文件与两个产物都已不在，清单遗忘这本书')
        return

    if not gz_ok:
        batch.unindexed.add(book_id)
        rep.warn(
            '\n'.join(
                [
                    f'[归档书缺正文] {key} → {book_id}：源文件已不在，'
                    f'{manifest.gz_name(book_id)} 也缺失或为空，正文无从恢复；'
                    f'本次不进 {INDEX_NAME}。',
                    '  把源包放回 zip-novel/ 重跑即可重建；确实不要这本书，就把剩下的 '
                    f'{manifest.toc_name(book_id)} 也删掉，下次运行清单会遗忘它。',
                ]
            )
        )
        return

    if entry.current and toc_ok:
        cached = skipped_meta(entry, book_id, title, author)
        if cached is not None:
            batch.books[key] = cached
            rep.archived(key, entry)
            return

    print(f'\n[归档] {key}')
    if not entry.current:
        batch.pipeline_redone.append(key)
        recorded = entry.pipeline_version
        print(
            f'  [流水线版本] 清单记的是 {recorded if recorded is not None else "未记录"}'
            f'、当前 {manifest.PIPELINE_VERSION}：源文件已不在，按 .txt.gz 重切章节'
        )
    elif not toc_ok:
        print(f'  [补切] {manifest.toc_name(book_id)} 缺失或为空，按 .txt.gz 重切章节')
    else:
        rep.warn(
            f'[清单记录不足] {key}（bookId={book_id!r}）凑不出一条完整的 {INDEX_NAME} 条目；'
            '源文件已不在，改为按 .txt.gz 重切。'
        )

    try:
        processed = resplit_book(
            entry, title, author,
            books_dir=books_dir,
            data_dir=data_dir,
            overrides=overrides,
        )
        # 与主循环同一个顺序：自校验在写清单之前（需求 7.10）。
        rep.warn_all(validate.check(processed.meta, processed.toc_data).warnings)
        mf.update(key, entry.digest, processed.tagged())
        rep.warn_all(mf.drain_warnings())
        rep.ok(key, processed.tagged())
        batch.books[key] = processed.meta
    except Exception as e:                          # 需求 7.1：记原因，继续下一本
        batch.unindexed.add(book_id)
        rep.fail(key, e)


def find_orphans(books_dir: Path, data_dir: Path, known: Set[str]) -> List[str]:
    """产物目录里 `known` 之外的 book_id（两种产物按后缀截出 id），排序返回。

    只报、不删：删除从未记录过的文件是数据丢失的常见来源，而这里最可能的成因恰恰是
    "清单丢了"——那些产物是源文件已删除的书仅剩的正文。
    """
    found: Set[str] = set()
    for directory, suffix in ((books_dir, manifest.GZ_SUFFIX), (data_dir, manifest.TOC_SUFFIX)):
        if not directory.is_dir():
            continue
        for path in directory.glob(f'*{suffix}'):
            if path.is_file():
                found.add(path.name[: -len(suffix)])
    return sorted(found - known)


def _warn_orphans(orphans: Sequence[str], rep: report.Report) -> None:
    listed = list(orphans[: report.MAX_LISTED])
    lines = [
        f'[孤儿产物] {len(orphans)} 本书的产物在磁盘上，但清单与本次 {INDEX_NAME} 里都没有它们：',
        *(f'    - {book_id}' for book_id in listed),
    ]
    if len(orphans) > len(listed):
        lines.append(f'    … 另有 {len(orphans) - len(listed)} 本，未逐条列出。')
    lines += [
        '  清单丢过或被重置（损坏、MANIFEST_VERSION 变更）时这个数字会突然变大：源文件已删除'
        '的书只能靠清单进索引，把 .preprocess-manifest.json 从备份恢复后重跑即可。',
        '  确实不要的就把这些文件删掉——它们照样占 20000 文件配额（需求 10.1）。',
    ]
    rep.warn('\n'.join(lines))


# ---------------------------------------------------------------------------
# 编排（design §4.9）
# ---------------------------------------------------------------------------


def run(
    source_dir: Optional[Path] = None,
    books_dir: Optional[Path] = None,
    data_dir: Optional[Path] = None,
    manifest_path: Optional[Path] = None,
    overrides_path: Optional[Path] = None,
    rep: Optional[report.Report] = None,
    delete_source: bool = False,
) -> int:
    """跑一整批，返回退出码（**不抛 `SystemExit`**，由 `main()` 负责）。

    Args:
        source_dir: 源目录，默认 `SOURCE_DIR`。
        books_dir: `.txt.gz` 输出目录，默认 `BOOKS_DIR`。
        data_dir: `_toc.json` / `books.json` 输出目录，默认 `DATA_DIR`。
        manifest_path: 增量清单路径，默认 `manifest.DEFAULT_PATH`。
        overrides_path: 规则覆盖表路径，默认 `toc_overrides.DEFAULT_PATH`（本机表，不进
            版本库）。文件不存在时照常运行、全部自动判定，开头打印一行提示。
        rep: 现成的账本（测试注入输出流用）；`None` 时按上面的目录新建一个。
        delete_source: `--delete-source`：每本书完成后删掉它的源包（需求 7.12，
            见 `consume_source`）。

    Returns:
        退出码：`0` 干净 / `1` 有书失败或配置错误 / `2` 产物不合规（越限、索引自校验
        失败）——这批部署不上去。两者同时发生取 2（`report` 模块的分档）。
    """
    # 规则人工覆盖表（需求 8.10）。每次运行重读，所以覆盖在重跑后自然仍然生效。
    # 表里的规则名在这里就全部校验完毕：写错了当场退出，不拖到第 N 本才发现，
    # 更不会静默退回自动判定。
    #
    # 放在一切之前（test-data-desensitization 需求 3.10 / 3.12）：表写错时，退出早于源目录
    # 检查，也早于任何产物目录与清单的创建，磁盘上什么都不留下。本机表缺失时照常运行、
    # 全部自动判定，但那一行提示必须恰好打印一次且早于第 1 本书，不论后面因何退出——
    # 部署机上漏放了这个文件，被点名的书会悄悄换回自动判定的切法，这一行是唯一的信号。
    try:
        overrides = toc_overrides.load(overrides_path)
    except toc_overrides.OverrideError as e:
        print(f'\n[覆盖表错误] {e}', file=sys.stderr)
        return EXIT_CONFIG
    if not overrides.found:
        print(toc_overrides.missing_notice(overrides.path))

    source_dir = SOURCE_DIR if source_dir is None else Path(source_dir)
    books_dir = BOOKS_DIR if books_dir is None else Path(books_dir)
    data_dir = DATA_DIR if data_dir is None else Path(data_dir)

    if not source_dir.is_dir():
        print(
            f'[错误] 源目录不存在: {source_dir}\n'
            '  预处理读的是 zip-novel/（需求 A9：目录名不变，格式扩展到 '
            f'{", ".join(archive.ARCHIVE_EXTENSIONS)}）。',
            file=sys.stderr,
        )
        return EXIT_CONFIG

    # 两个产物目录先建好：护栏要扫它们，`书一本都没处理` 时目录不存在会被报成问题。
    books_dir.mkdir(parents=True, exist_ok=True)
    data_dir.mkdir(parents=True, exist_ok=True)

    if rep is None:
        rep = report.Report(books_dir=books_dir, data_dir=data_dir)

    # 接受 .zip/.tar/.tar.gz/.tgz/.7z/.rar（需求 7.6）。
    # 旧写法只 glob "*.rar"，目录里其他格式的书被静默忽略。
    sources = archive.scan_source_dir(source_dir)
    ignored = archive.unsupported_in(source_dir)
    print(f"找到 {len(sources)} 本待处理小说...")
    if ignored:
        print(
            f"  [忽略] {len(ignored)} 个扩展名不受支持的文件"
            f"（仅接受 {', '.join(archive.ARCHIVE_EXTENSIONS)}）："
        )
        for path in ignored:
            print(f"    - {path.name}")
    if delete_source:
        print('  [删源] --delete-source：每本书的产物与清单落盘之后，删掉它的源文件（需求 7.12）')

    # 文件名解析一次用到底：`overrides.unused()` 与逐本处理要的是同一份 id。
    parsed = [(src, parse_filename_meta(src.name)) for src in sources]

    # 增量清单（需求 7.3–7.5）。读取问题一律降级为告警：挡住整批也找不回丢掉的记录
    # （源文件已删除的书），而源文件还在的书丢了记录只是退化成重跑。
    mf = manifest.load(manifest_path, books_dir=books_dir, data_dir=data_dir)
    rep.warn_all(mf.drain_warnings())

    # 改名识别要在归档名单之前：接管了记录的书就不再是归档书。
    known_digests = adopt_renamed(mf, sources, rep)
    archived = mf.archived(sources)
    if archived:
        print(
            f"  [归档] 清单里另有 {len(archived)} 本书的源文件已不在源目录："
            "产物与索引条目沿用清单记录（需求 7.5）"
        )

    if len(overrides):
        print(f"  [覆盖] {overrides.path.name} 指定了 {len(overrides)} 本书的规则")
        # 键写错是这张表唯一无法在加载期校验的部分（那时还不知道有哪些书）。
        # 告警而非失败：书被合法删掉时批次不该停。归档书的 id 同样算"有这本书"。
        known_ids = [meta[0] for _, meta in parsed] + [entry.book_id for _, entry in archived]
        unused = overrides.unused(known_ids)
        if unused:
            rep.warn(
                '\n'.join(
                    [
                        f'[覆盖表未命中] {overrides.path} 里有 {len(unused)} 项匹配不到'
                        '任何源文件（book_id 写错了？）：',
                        *(f'    - {key}' for key in unused),
                    ]
                )
            )

    # id 分配必须在跳过判定**之前**对每本书都做一次（report.py）：id 命名空间的占用
    # 与这本要不要重跑无关。清单里已分配的先整体占住，新书才从剩下的里挑。
    sticky = claim_recorded_ids(mf, parsed, rep)
    batch = Batch()

    for index, (src, (raw_id, title, author)) in enumerate(parsed, 1):
        print(f"\n[{index}/{len(parsed)}] {src.name}")
        book_id = sticky.get(src.name) or rep.unique_id(raw_id, src)   # 需求 7.9
        rep.check_source(src)                      # 需求 7.11：源包 > 30MB 预警

        try:
            digest = known_digests.get(src.name) or manifest.sha256_file(src)
            if mf.should_skip(src, digest):         # 需求 7.4：摘要一致且产物完整存在
                entry = mf.entry_for(src)
                cached = skipped_meta(entry, book_id, title, author)
                if cached is not None and entry is not None:
                    batch.books[src.name] = cached
                    rep.skipped(src, entry)
                    if delete_source:               # 需求 7.12：上一轮已处理好的同样删
                        consume_source(src, entry.gz_size, rep, batch)
                    continue
                recorded_id = entry.book_id if entry is not None else None
                rep.warn(
                    f'[清单记录不足] {src.name} 的源文件与产物都没变，但清单记录'
                    f'（bookId={recorded_id!r}）凑不出一条完整的 books.json 条目；'
                    f'本次改为重新处理，按 "{book_id}" 写产物。'
                )
            elif mf.pipeline_stale(src, digest):
                # 摘要一致、产物齐全，只是那份产物出自另一版切分逻辑。逐本打一行进度
                # 而不是 `rep.warn`：7,681 本各记一条告警，汇总会变成"告警 7681 条"，
                # 真正的信号全被压掉。整批的那一笔在循环之后统一报。
                entry = mf.entry_for(src)
                recorded = entry.pipeline_version if entry is not None else None
                batch.pipeline_redone.append(src.name)
                print(
                    f'  [流水线版本] 清单记的是 {recorded if recorded is not None else "未记录"}'
                    f'、当前 {manifest.PIPELINE_VERSION}：源文件没变，但切分逻辑变了，'
                    '重新处理这一本'
                )

            processed = process_book(
                src, book_id, title, author,
                books_dir=books_dir,
                data_dir=data_dir,
                rep=rep,
                overrides=overrides,
            )
            # 自校验在写清单之前（需求 7.10）：坏产物不许拿到"处理过"的记录，
            # 否则它此后每次运行都被跳过。
            rep.warn_all(validate.check(processed.meta, processed.toc_data).warnings)
            mf.update(src, digest, processed.tagged())    # 需求 7.3：每本成功即落盘
            rep.warn_all(mf.drain_warnings())
            rep.ok(src, processed.tagged())
            batch.books[src.name] = processed.meta
            if delete_source:                       # 需求 7.12：产物与清单都已落盘
                consume_source(src, int(processed.meta['gzSize']), rep, batch)

        except archive.MissingExtractorError as e:
            # 解压依赖缺失是环境问题，继续跑下去只会把整批都判成失败（需求 7.7）。
            rep.fail(src, e)
            print(
                '\n[依赖缺失] 解压工具不可用，整批到此为止（需求 7.7）。\n'
                '  已完成的书都已写进清单，装好工具后重跑会自动跳过它们；\n'
                f'  本次**没有**重写 {INDEX_NAME}，磁盘上那份仍是上一次的索引。',
                file=sys.stderr,
            )
            return EXIT_CONFIG

        except Exception as e:                      # 需求 7.1：记原因，继续下一本
            batch.unindexed.add(book_id)
            rep.fail(src, e)
            continue

    # 需求 7.5（修订）：源文件已删除的书，产物与索引条目照旧；换版/缺目录时按 .txt.gz 重切。
    for key, _entry in archived:
        entry = mf.entry_for(key)
        if entry is None:
            continue          # 主循环里被别的书挤掉了（`manifest.update` 的去重），已告警
        process_archived(
            key, entry, batch,
            mf=mf,
            rep=rep,
            books_dir=books_dir,
            data_dir=data_dir,
            overrides=overrides,
        )

    # 流水线换版的整批账（`manifest.PIPELINE_VERSION`）。没有这一笔，一次"什么都没改"
    # 的运行突然重建 7,681 本就没有任何解释——而"跳过 0 本"恰恰是清单失效时的表现，
    # 两者在日志里长得一模一样。
    if batch.pipeline_redone:
        print(
            f'\n[流水线版本变更] 本次有 {len(batch.pipeline_redone)} 本书的源文件与产物都没变，'
            f'只因清单记录的流水线版本不是 {manifest.PIPELINE_VERSION} 而重做'
            '（源文件已删除的书按 .txt.gz 重切）。\n'
            '    改了 scripts/lib/toc_rules.py 的规则表或 scripts/lib/toc.py 的择一/切分'
            '逻辑就必须把 manifest.PIPELINE_VERSION +1，\n'
            '    否则重跑会把它们全部跳过、静默发布上一版的切分结果。这条输出就是那次'
            '+1 的回声。'
        )

    books = [batch.books[key] for key in sorted(batch.books)]
    payload = build_index(books)
    index_path = write_index(payload, data_dir)
    print(f"\n全局索引已写出: {index_path}（{len(books)} 本，无缩进、不预压缩）")

    # 需求 7.13：清单丢失/重置时，源文件已删除的书只能从索引里消失——点名它们，
    # 别让这件事静默发生。
    known = (
        {str(book['id']) for book in books}
        | batch.unindexed
        | {entry.book_id for entry in mf.entries.values()}
    )
    orphans = find_orphans(books_dir, data_dir, known)
    if orphans:
        _warn_orphans(orphans, rep)

    if delete_source:
        print(
            f'\n[删源] 本次删除 {batch.deleted} 个源文件，'
            f'释放 {batch.freed / 1024 / 1024 / 1024:.2f} GB（--delete-source）。'
        )

    # 需求 7.10：写完就校验。失败不是"某一本的问题"——书架读的是这一份，
    # 它不合 schema 整站就是坏的，所以按产物护栏那一档退出（部署不上去）。
    index_invalid = False
    try:
        rep.warn_all(validate.check_books(payload).warnings)
    except validate.ValidationError as e:
        index_invalid = True
        print(f'\n[索引自校验失败] {e}', file=sys.stderr)

    rep.summary()                                   # 需求 7.2
    rep.guard_rails()                               # 需求 10.1 / 10.2 / 10.7

    code = rep.exit_code
    if index_invalid:
        code = max(code, report.EXIT_GUARD_RAIL)
    return code


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    """命令行参数。只有一个开关，默认行为与不带参数时完全相同。"""
    parser = argparse.ArgumentParser(
        prog='preprocess.py',
        description=(
            '把 zip-novel/ 里的小说压缩包切章、压缩成 public/books/<id>.txt.gz 与 '
            'public/data/<id>_toc.json，并写出全库索引 public/data/books.json。'
            '增量运行：没变的书跳过；源文件已删除的书，产物与索引照旧。'
        ),
    )
    parser.add_argument(
        '--delete-source',
        action='store_true',
        help=(
            '每本书的产物写完、自校验通过、清单落盘之后，删掉它在 zip-novel/ 里的源压缩包'
            '（被跳过的、上次已处理好的书同样删）。失败的书与产物超过 25 MiB 的书不删。'
            '删源之后书照样留在书库里，但 .preprocess-manifest.json 就成了它在产物之外'
            '唯一的记录，不要删它。'
        ),
    )
    return parser.parse_args(argv)


def main(argv: Optional[Sequence[str]] = None) -> int:
    """入口：解析参数、跑一批并返回退出码。非零退出由 `raise SystemExit(...)` 在模块末尾给出。"""
    args = parse_args(argv)
    return run(delete_source=args.delete_source)


if __name__ == '__main__':
    raise SystemExit(main())
