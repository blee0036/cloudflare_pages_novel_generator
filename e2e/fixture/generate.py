# -*- coding: utf-8 -*-
r"""Fixture_Generator：把 `books.py` 的规格合成为源压缩包，交给现有预处理管线生成 Fixture_Library
（e2e-visual-testing 需求 1.9 / 3.1 / 3.2 / 3.5–3.8，design「Fixture_Generator」「Data Models」、K3）。

    python e2e/fixture/generate.py                        # npm run e2e:fixture
    python e2e/fixture/generate.py --if-stale             # globalSetup：已是最新就直接返回 0（3.7）
    python e2e/fixture/generate.py --verify-determinism   # 属性 4：两次从零 + 一次增量，逐字节比对（3.5）

只用 Python 标准库；预处理管线（`scripts/preprocess.py`）在依赖检查通过之后才导入。

## 流程

    依赖检查 → 摘要 → 写源 zip → run(source_dir, books_dir, data_dir, manifest_path)
            → 核对管线结果（3.6）→ 校验 3.3 (a)–(i) → roles.json → record.json

1. **依赖检查**（需求 1.9）：`REQUIRED_DEPENDENCIES` 从 `scripts/preprocess.py` 的**源码**里读
   （`ast`），不导入它——导入即触发它自己的检查并 `SystemExit`，而这里要在调用管线之前、
   任何文件都还没动的时候，自己列出缺的包并以退出码 1 结束。
2. **摘要**（需求 3.7，design `record.json`）：`e2e/fixture/*.py` 按相对路径排序后的内容，
   加上 `scripts/lib/manifest.py` 的 `PIPELINE_VERSION`，取 SHA-256（`source_digest()`，
   验收助手 `acceptance.py` 复用它）。
3. **写源 zip**：每本书一个 `《书名》作者：作者.zip`，内含一个 `book.txt`（带 BOM 的 UTF-8），
   条目时间固定为 2020-01-01 00:00:00。内容没变的 zip 不重写，`src/` 里多出来的文件删掉。
4. **调用管线**（需求 3.1）：`run()` 的 `source_dir` / `books_dir` / `data_dir` /
   `manifest_path` 全部显式指向 `e2e/.out/fixture/` 下的目录。另把 `overrides_path` 指向该目录
   下一个**不存在**的文件（覆盖表缺失即空表，与 `scripts/tests/test_preprocess.py` 的 `Bench`
   同一做法）：仓库里那份 `scripts/toc-overrides.json` 是给真实书库的，不进摘要，不能让它
   影响夹具的切分；它的 21 项对夹具全部未命中，还会在每次生成时打出一条"覆盖表未命中"告警。
   管线的全部输出写入 `pipeline.log`，终端只留本脚本的进度与结论。
5. **核对管线结果**（需求 3.6）：退出码非 0，或 `books.json` 里缺了夹具源定义的书，就逐本
   列出源文件名与管线报告的原因。`books.json` 里多出夹具源没有定义的书同样算失败。
6. **校验 3.3 (a)–(i)**（需求 3.8）：对着 `roles.json` 将要指向的那几本书逐项核对，另核对
   `roles.json` 里的检索词（`volumesKeyword`、`fewKeyword`、`noHitKeyword`）与 crlf 书。
   期望值一律从产物读出，不硬编码书 id 或节点数。
7. 全部通过才写 `roles.json` 与 `record.json`（`{ digest, pipelineVersion, bookCount }`）。

## 输出目录（需求 3.2）

全部写在 `e2e/.out/fixture/`（gitignore）：`src/`、`books/`、`data/`、`manifest.json`、
`roles.json`、`record.json`、`pipeline.log`。`public/`、`zip-novel/` 与仓库根的
`.preprocess-manifest.json` 一个字节都不碰：四个路径参数全部显式给出，`Layout` 另拒绝
`e2e/.out/` 之外的根目录（`rmtree` 的保险）。

## 何时从零生成

生成记录缺失或摘要不一致时，先删掉整个 `e2e/.out/fixture/` 再生成；否则保留上次的产物增量
重跑（管线按源包摘要跳过没变的书）。增量不能用于规格变了的情形：改了书名的书在旧清单里
成了"源文件已删除的归档书"，产物与索引条目会被管线原样保留（`scripts/preprocess.py`
需求 7.5 修订），`books.json` 就多出一本夹具源里没有的书。

## 失败时不留生成记录（需求 3.6 / 3.8）

开始生成之前先删掉旧的 `record.json` 与 `roles.json`，成功后才重新写出。旧记录留着的话，
一次半途失败的增量重跑之后 `--if-stale` 仍会看到"摘要一致、产物齐全"（失败的书只是从
`books.json` 里消失了），直接放行一个残缺的书库。

失败清单写 stderr（globalSetup 据此写 `fixture-failed.json`，需求 3.9），退出码 1。

## `--verify-determinism`（属性 4，需求 3.5）

在 `e2e/.out/fixture-verify/` 下：`a` 从零生成 → 快照；`a` 保留产物增量重跑（必须跳过全部
书）→ 与快照比对；`b` 从零生成 → 与快照比对；`e2e/.out/fixture/` 已是最新时再与它比对。
快照含 `books/`、`data/` 下的全部文件与 `roles.json`；`books.json` 的 `generatedAt` 先替换为
同一占位串。全部一致时删掉 `fixture-verify/`，否则保留它并列出差异。不改 `e2e/.out/fixture/`。
"""

from __future__ import annotations

import argparse
import ast
import contextlib
import gzip
import hashlib
import importlib.util
import io
import json
import os
import re
import shutil
import sys
import time
import traceback
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import IO, Dict, List, Mapping, Optional, Sequence, Tuple


def _force_utf8(stream: Optional[IO[str]]) -> None:
    """把输出流重设为 UTF-8（Windows 控制台默认 cp936，书名与告警都是 UTF-8 文本）。"""
    if stream is None or not hasattr(stream, 'reconfigure'):
        return
    try:
        stream.reconfigure(encoding='utf-8')          # type: ignore[attr-defined]
    except Exception:
        pass


_force_utf8(sys.stdout)
_force_utf8(sys.stderr)

FIXTURE_DIR = Path(__file__).resolve().parent
REPO_ROOT = FIXTURE_DIR.parent.parent

# 以脚本方式运行时 sys.path[0] 是 e2e/fixture/；`scripts.lib.*` 要仓库根。被别的脚本按路径
# 加载时（acceptance.py 复用 `source_digest()`）两者都可能不在，一并补上。
for _entry in (REPO_ROOT, FIXTURE_DIR):
    if str(_entry) not in sys.path:
        sys.path.insert(0, str(_entry))

import books as fixture  # noqa: E402  夹具规格与文本合成，只用标准库
from scripts.lib.manifest import PIPELINE_VERSION  # noqa: E402  manifest.py 只用标准库

__all__ = [
    'FIXTURE_OUT',
    'Layout',
    'VERIFY_OUT',
    'main',
    'missing_dependencies',
    'source_digest',
    'stale_reason',
]

# ---------------------------------------------------------------------------
# 常量
# ---------------------------------------------------------------------------

OUT_ROOT = REPO_ROOT / 'e2e' / '.out'
FIXTURE_OUT = OUT_ROOT / 'fixture'
VERIFY_OUT = OUT_ROOT / 'fixture-verify'
PREPROCESS_PATH = REPO_ROOT / 'scripts' / 'preprocess.py'
REQUIREMENTS_PATH = REPO_ROOT / 'scripts' / 'requirements.txt'

#: 源 zip 里唯一的条目名与它的时间戳（design「夹具书规格」）。
ZIP_MEMBER = 'book.txt'
ZIP_DATE_TIME = (2020, 1, 1, 0, 0, 0)

#: 摘要输入的版本前缀：改了摘要的拼法就换它，旧记录随之失效。
DIGEST_SCHEME = 'e2e-fixture-digest/1'

#: `--verify-determinism` 比对 `books.json` 前替换 `generatedAt` 用的占位串（需求 3.5）。
GENERATED_AT_PLACEHOLDER = '<generatedAt>'
_GENERATED_AT = re.compile(r'"generatedAt":"[^"]*"')

#: 需求 3.3 的数字门槛。
MIN_BOOKS = 51            # (a) 书架分页 50，第 51 本起才出现"加载更多"
MIN_HUGE_NODES = 3000     # (e)
MIN_ABBR_LENGTH = 3       # (f)
MIN_CAP_HITS = 151        # (h) 全文检索结果上限 150
MIN_PARAGRAPHS = 200      # (i)
SEARCH_LIMIT = 150        # 需求 9.1：fewKeyword 须 1 ≤ K < 150

EXIT_OK = 0
EXIT_FAILED = 1


def _rel(path: Path) -> str:
    """相对仓库根的 `/` 分隔路径，用于输出。"""
    try:
        return path.resolve().relative_to(REPO_ROOT).as_posix()
    except ValueError:
        return str(path)


# ---------------------------------------------------------------------------
# 目录布局
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Layout:
    """一套 Fixture_Library 的全部路径（design 目录表 `e2e/.out/fixture/{...}`）。"""

    root: Path

    def __post_init__(self) -> None:
        # 本脚本会 rmtree 这个目录：只接受 e2e/.out/ 之下的路径（需求 3.2）。
        resolved = self.root.resolve()
        if resolved == OUT_ROOT.resolve() or not resolved.is_relative_to(OUT_ROOT.resolve()):
            raise ValueError(f'夹具输出目录必须位于 {_rel(OUT_ROOT)}/ 之下，收到 {self.root}')

    @property
    def src(self) -> Path:
        return self.root / 'src'

    @property
    def books(self) -> Path:
        return self.root / 'books'

    @property
    def data(self) -> Path:
        return self.root / 'data'

    @property
    def manifest(self) -> Path:
        return self.root / 'manifest.json'

    @property
    def record(self) -> Path:
        return self.root / 'record.json'

    @property
    def roles(self) -> Path:
        return self.root / 'roles.json'

    @property
    def log(self) -> Path:
        return self.root / 'pipeline.log'

    @property
    def overrides(self) -> Path:
        """刻意不存在的覆盖表路径（模块 docstring「流程」第 4 条）。"""
        return self.root / 'toc-overrides.none.json'

    @property
    def index(self) -> Path:
        return self.data / 'books.json'

    def gz(self, book_id: str) -> Path:
        return self.books / f'{book_id}.txt.gz'

    def toc(self, book_id: str) -> Path:
        return self.data / f'{book_id}_toc.json'


# ---------------------------------------------------------------------------
# 依赖检查（需求 1.9）
# ---------------------------------------------------------------------------


def required_dependencies() -> Tuple[Tuple[str, str, str], ...]:
    """读出 `scripts/preprocess.py` 的 `REQUIRED_DEPENDENCIES`（不导入，见模块 docstring）。"""
    tree = ast.parse(PREPROCESS_PATH.read_text(encoding='utf-8'), filename=str(PREPROCESS_PATH))
    for node in tree.body:
        if isinstance(node, ast.AnnAssign):
            target, value = node.target, node.value
        elif isinstance(node, ast.Assign) and len(node.targets) == 1:
            target, value = node.targets[0], node.value
        else:
            continue
        if isinstance(target, ast.Name) and target.id == 'REQUIRED_DEPENDENCIES' and value is not None:
            return tuple((str(m), str(d), str(p)) for m, d, p in ast.literal_eval(value))
    raise RuntimeError(f'{_rel(PREPROCESS_PATH)} 里找不到 REQUIRED_DEPENDENCIES')


def missing_dependencies() -> List[Tuple[str, str]]:
    """缺失的必需包：`(发行包名, 用途)`。"""
    missing: List[Tuple[str, str]] = []
    for module_name, dist_name, purpose in required_dependencies():
        try:
            found = importlib.util.find_spec(module_name) is not None
        except (ImportError, ValueError):
            found = False
        if not found:
            missing.append((dist_name, purpose))
    return missing


def _report_missing(missing: Sequence[Tuple[str, str]]) -> None:
    lines = ['[依赖缺失] 预处理管线所需的以下 Python 包未安装：']
    lines += [f'  - {dist}（用途：{purpose}）' for dist, purpose in missing]
    lines += [
        '在调用管线之前停下，已有的夹具书库未改动（需求 1.9）。请先安装后重试：',
        f'    python -m pip install -r {_rel(REQUIREMENTS_PATH)}',
    ]
    print('\n'.join(lines), file=sys.stderr)


# ---------------------------------------------------------------------------
# 摘要与生成记录（需求 3.7）
# ---------------------------------------------------------------------------


def fixture_sources() -> List[Path]:
    """摘要覆盖的夹具源：`e2e/fixture/*.py`，按相对路径排序。"""
    return sorted(FIXTURE_DIR.glob('*.py'), key=lambda path: _rel(path))


def source_digest() -> str:
    """夹具源全部文件的内容 + 当前 `PIPELINE_VERSION` 的 SHA-256（design `record.json`）。

    每个文件以"相对路径、字节数、内容"的形式进入摘要，文件之间的边界因此无歧义。
    """
    h = hashlib.sha256()
    h.update(f'{DIGEST_SCHEME}\n'.encode('utf-8'))
    for path in fixture_sources():
        data = path.read_bytes()
        h.update(f'{_rel(path)}\n{len(data)}\n'.encode('utf-8'))
        h.update(data)
        h.update(b'\n')
    h.update(f'PIPELINE_VERSION={PIPELINE_VERSION}\n'.encode('utf-8'))
    return h.hexdigest()


def _read_json(path: Path) -> Optional[object]:
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return None


def _write_json(path: Path, payload: object) -> None:
    """写 UTF-8、LF、两格缩进的 JSON，先写临时文件再替换。"""
    text = json.dumps(payload, ensure_ascii=False, indent=2) + '\n'
    tmp = path.with_name(f'{path.name}.tmp{os.getpid()}')
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(tmp, 'w', encoding='utf-8', newline='\n') as handle:
        handle.write(text)
    os.replace(tmp, path)


def _index_entries(index: object) -> Optional[List[Dict[str, object]]]:
    """`books.json` 的 `books` 数组；形状不对时 `None`。"""
    if not isinstance(index, dict):
        return None
    entries = index.get('books')
    if not isinstance(entries, list) or not all(isinstance(e, dict) for e in entries):
        return None
    return entries


def stale_reason(layout: Layout, digest: str) -> Optional[str]:
    """Fixture_Library 需要重新生成的原因；`None` 表示已是最新（需求 3.7）。

    最新 = 生成记录的摘要与当前一致，`books.json` 所列每本书的 `.txt.gz` 与 `_toc.json`
    都在，`roles.json` 也在。
    """
    record = _read_json(layout.record)
    if not isinstance(record, dict):
        return '生成记录缺失或无法解析'
    if record.get('digest') != digest:
        return '夹具源或 PIPELINE_VERSION 已变化（摘要与生成记录不一致）'
    entries = _index_entries(_read_json(layout.index))
    if entries is None:
        return 'books.json 缺失或无法解析'
    for entry in entries:
        book_id = str(entry.get('id', ''))
        if not layout.gz(book_id).is_file():
            return f'{book_id} 缺少 .txt.gz'
        if not layout.toc(book_id).is_file():
            return f'{book_id} 缺少 _toc.json'
    if record.get('bookCount') != len(entries):
        return f'生成记录的书数 {record.get("bookCount")} 与 books.json 的 {len(entries)} 不一致'
    if not layout.roles.is_file():
        return 'roles.json 缺失'
    return None


# ---------------------------------------------------------------------------
# 源 zip
# ---------------------------------------------------------------------------


def zip_bytes(spec: fixture.BookSpec) -> bytes:
    """一本书的源压缩包字节：固定条目名与时间戳，同一份规格恒得到同一串字节。"""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as zf:
        info = zipfile.ZipInfo(ZIP_MEMBER, date_time=ZIP_DATE_TIME)
        info.compress_type = zipfile.ZIP_DEFLATED
        info.create_system = 0                        # 不随平台变（ZipInfo 在非 Windows 上默认 3）
        info.external_attr = 0
        zf.writestr(info, fixture.source_bytes(spec), compresslevel=9)
    return buffer.getvalue()


def write_sources(layout: Layout) -> Tuple[int, int]:
    """把 `src/` 写成恰好是夹具源定义的那些 zip。返回 `(总数, 本次写入数)`。"""
    layout.src.mkdir(parents=True, exist_ok=True)
    expected = {fixture.source_name(spec): spec for spec in fixture.SPECS}
    for entry in layout.src.iterdir():
        if entry.name not in expected:
            if entry.is_dir():
                shutil.rmtree(entry)
            else:
                entry.unlink()
    written = 0
    for name, spec in expected.items():
        path = layout.src / name
        data = zip_bytes(spec)
        if path.is_file() and path.read_bytes() == data:
            continue
        path.write_bytes(data)
        written += 1
    return len(expected), written


# ---------------------------------------------------------------------------
# 调用管线（需求 3.1）
# ---------------------------------------------------------------------------


@dataclass
class PipelineResult:
    code: int
    failures: Dict[str, str]
    """源文件名 → 管线报告的原因（`report.Failure`）。"""
    skipped: int
    warnings: int
    seconds: float


def run_pipeline(layout: Layout) -> PipelineResult:
    """以显式的四个目录参数调用 `scripts/preprocess.py` 的 `run()`，输出写入 `pipeline.log`。"""
    from scripts import preprocess                  # 依赖检查已通过，这里才导入
    from scripts.lib import report

    rep = report.Report(books_dir=layout.books, data_dir=layout.data)
    started = time.perf_counter()
    with open(layout.log, 'w', encoding='utf-8', newline='\n') as log:
        with contextlib.redirect_stdout(log), contextlib.redirect_stderr(log):
            try:
                code = preprocess.run(
                    source_dir=layout.src,
                    books_dir=layout.books,
                    data_dir=layout.data,
                    manifest_path=layout.manifest,
                    overrides_path=layout.overrides,
                    rep=rep,
                )
            except Exception as exc:                # 管线本身抛错：当作整批失败，堆栈留在日志里
                traceback.print_exc()
                rep.fail('（管线）', exc)
                code = EXIT_FAILED
    failures: Dict[str, str] = {}
    for failure in rep.failures:
        failures.setdefault(failure.source, f'{failure.kind}：{failure.reason}')
    return PipelineResult(
        code=code,
        failures=failures,
        skipped=rep.n_skipped,
        warnings=len(rep.warnings),
        seconds=time.perf_counter() - started,
    )


# ---------------------------------------------------------------------------
# 核对与校验（需求 3.6 / 3.8）
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Problem:
    """一条未满足项。`item` 为 `管线`、`(a)`–`(i)` 或 `roles.<键>`。"""

    item: str
    book: str
    detail: str

    def line(self) -> str:
        who = f' {self.book}' if self.book else ''
        return f'  - {self.item}{who}：{self.detail}'


def check_pipeline(
    layout: Layout, result: PipelineResult
) -> Tuple[List[Problem], List[Dict[str, object]]]:
    """需求 3.6：管线退出码非 0，或 `books.json` 缺书 / 多书。返回 `(问题, books.json 条目)`。"""
    problems: List[Problem] = []
    entries = _index_entries(_read_json(layout.index))
    if result.code != EXIT_OK:
        problems.append(Problem('管线', '', f'run() 退出码 {result.code}'))
    if entries is None:
        problems.append(Problem('管线', '', f'{_rel(layout.index)} 缺失或无法解析'))
        entries = []

    listed = {(str(e.get('title')), str(e.get('author'))) for e in entries}
    spec_meta = {(spec.title, spec.author) for spec in fixture.SPECS}
    reported = set()
    for spec in fixture.SPECS:
        if (spec.title, spec.author) in listed:
            continue
        name = fixture.source_name(spec)
        reported.add(name)
        reason = result.failures.get(name, '未进入 books.json（管线没有报告这本书的失败）')
        problems.append(Problem('缺书', name, reason))
    for name, reason in result.failures.items():
        if name not in reported:
            problems.append(Problem('管线', name, reason))
    for entry in entries:
        if (str(entry.get('title')), str(entry.get('author'))) not in spec_meta:
            problems.append(Problem('多书', str(entry.get('id')), 'books.json 含夹具源没有定义的书'))
    return problems, entries


class Library:
    """一份已生成的 Fixture_Library：`books.json` 条目、规格键 → id，以及按需读取的产物。"""

    def __init__(self, layout: Layout, entries: List[Dict[str, object]]) -> None:
        self.layout = layout
        self.entries = entries
        by_meta = {(str(e['title']), str(e['author'])): str(e['id']) for e in entries}
        self.id_of: Dict[str, str] = {
            spec.key: by_meta[(spec.title, spec.author)] for spec in fixture.SPECS
        }
        self._tocs: Dict[str, Dict[str, object]] = {}
        self._texts: Dict[str, str] = {}

    def label(self, key: str) -> str:
        """`<id>（<源文件名>）`：问题清单里"涉及的书"。"""
        return f'{self.id_of[key]}（{fixture.source_name(fixture.SPECS_BY_KEY[key])}）'

    def entry(self, key: str) -> Dict[str, object]:
        book_id = self.id_of[key]
        return next(e for e in self.entries if e['id'] == book_id)

    def toc(self, key: str) -> Dict[str, object]:
        book_id = self.id_of[key]
        if book_id not in self._tocs:
            data = json.loads(self.layout.toc(book_id).read_text(encoding='utf-8'))
            if not isinstance(data, dict) or not isinstance(data.get('chapters'), list):
                raise ValueError(f'{self.layout.toc(book_id).name} 没有 chapters 数组')
            self._tocs[book_id] = data
        return self._tocs[book_id]

    def chapters(self, key: str) -> List[Dict[str, object]]:
        return list(self.toc(key)['chapters'])          # type: ignore[arg-type]

    def text(self, key: str) -> str:
        book_id = self.id_of[key]
        if book_id not in self._texts:
            self._texts[book_id] = gzip.decompress(self.layout.gz(book_id).read_bytes()).decode('utf-8')
        return self._texts[book_id]


def _is_volume(chapter: Mapping[str, object]) -> bool:
    return bool(chapter.get('isVolume'))


def count_hits(text: str, word: str) -> int:
    """不区分大小写、互不重叠的出现次数（需求 9.1 的 K）。"""
    return text.lower().count(word.lower())


def haystack(entry: Mapping[str, object]) -> str:
    """书架检索串，与 `src/utils/bookSearch.ts` 的 `buildHaystack` 同一拼法。"""
    parts = [entry.get('title'), entry.get('author'), entry.get('titleAbbr'), entry.get('authorAbbr')]
    return ' '.join(str(part) for part in parts if part).lower()


def is_subsequence(needle: str, hay: str) -> bool:
    """`fuzzyScore > 0` 的判据：`needle` 的每个字符都能在 `hay` 里按序找到。"""
    position = 0
    for ch in needle:
        position = hay.find(ch, position)
        if position < 0:
            return False
        position += len(ch)
    return True


def _check_volumes(lib: Library) -> List[str]:
    """(b)：≥ 2 个卷节点，下标 1 是卷节点，每个卷节点前后都至少各有 1 个正文章节。"""
    chapters = lib.chapters(fixture.ROLES.volumes)
    volumes = [i for i, c in enumerate(chapters) if _is_volume(c)]
    content = [i for i, c in enumerate(chapters) if not _is_volume(c)]
    issues: List[str] = []
    if len(volumes) < 2:
        issues.append(f'卷节点 {len(volumes)} 个，需要 ≥ 2')
    if 1 not in volumes:
        issues.append('第 2 个节点（下标 1）不是卷节点')
    lonely = [i for i in volumes if not content or content[0] > i or content[-1] < i]
    if lonely:
        issues.append(f'下标 {lonely} 的卷节点之前或之后没有正文章节')
    return issues


def _check_fallback(lib: Library) -> List[str]:
    """(c)：节点数 ≥ 2 且 `fallback: true`。"""
    toc = lib.toc(fixture.ROLES.fallback)
    issues: List[str] = []
    if toc.get('fallback') is not True:
        issues.append('_toc.json 没有 fallback: true')
    if len(lib.chapters(fixture.ROLES.fallback)) < 2:
        issues.append('节点数 < 2')
    return issues


def _check_stars(lib: Library) -> List[str]:
    """(d)：节点数 ≥ 2，全部节点标题为 `※※※`。"""
    chapters = lib.chapters(fixture.ROLES.stars)
    issues: List[str] = []
    if len(chapters) < 2:
        issues.append(f'节点数 {len(chapters)}，需要 ≥ 2')
    others = [str(c.get('title')) for c in chapters if c.get('title') != fixture.STARS_TITLE]
    if others:
        issues.append(f'{len(others)} 个节点的标题不是 {fixture.STARS_TITLE}，如 {others[:3]}')
    return issues


def _check_huge(lib: Library) -> List[str]:
    """(e)：节点数 ≥ 3,000。"""
    count = len(lib.chapters(fixture.ROLES.huge))
    return [] if count >= MIN_HUGE_NODES else [f'节点数 {count}，需要 ≥ {MIN_HUGE_NODES}']


def _check_pinyin(lib: Library) -> List[str]:
    """(f)：书名拼音首字母串长度 ≥ 3，以它作书架检索词时只命中这一本。"""
    entry = lib.entry(fixture.ROLES.pinyin)
    abbr = fixture.PINYIN_ABBR
    issues: List[str] = []
    if len(abbr) < MIN_ABBR_LENGTH:
        issues.append(f'检索词 {abbr} 长度 < {MIN_ABBR_LENGTH}')
    if entry.get('titleAbbr') != abbr:
        issues.append(f'books.json 的 titleAbbr 为 {entry.get("titleAbbr")!r}，roles.json 写的是 {abbr!r}')
    hits = [str(e['id']) for e in lib.entries if is_subsequence(abbr.lower(), haystack(e))]
    if hits != [lib.id_of[fixture.ROLES.pinyin]]:
        issues.append(f'以 {abbr} 检索命中 {len(hits)} 本：{hits[:5]}')
    return issues


def _check_same_author(lib: Library) -> List[str]:
    """(g)：两本及以上作者相同；`roles.sameAuthor.ids` 恰好是该作者的全部书。"""
    same = sorted(str(e['id']) for e in lib.entries if e.get('author') == fixture.SAME_AUTHOR)
    expected = sorted(lib.id_of[key] for key in fixture.ROLES.same_author)
    issues: List[str] = []
    if len(same) < 2:
        issues.append(f'作者为 {fixture.SAME_AUTHOR} 的书 {len(same)} 本，需要 ≥ 2')
    if same != expected:
        issues.append(f'books.json 中作者为 {fixture.SAME_AUTHOR} 的书 {same} 与 roles 的 {expected} 不一致')
    return issues


def _check_cap_keyword(lib: Library) -> List[str]:
    """(h)：capKeyword 在全书出现 ≥ 151 次。"""
    hits = count_hits(lib.text(fixture.ROLES.long_text), fixture.CAP_KEYWORD)
    if hits >= MIN_CAP_HITS:
        return []
    return [f'{fixture.CAP_KEYWORD} 出现 {hits} 次，需要 ≥ {MIN_CAP_HITS}']


def long_text_chapter(lib: Library) -> Optional[int]:
    """longText 书里标题为 `LONG_TEXT_CHAPTER_TITLE` 的正文章节下标；不唯一时 `None`。"""
    chapters = lib.chapters(fixture.ROLES.long_text)
    found = [
        i for i, c in enumerate(chapters)
        if not _is_volume(c) and c.get('title') == fixture.LONG_TEXT_CHAPTER_TITLE
    ]
    return found[0] if len(found) == 1 else None


def paragraph_count(text: str, chapter: Mapping[str, object]) -> int:
    """章节里标题行之外的非空行数。range 以标题行起始（`src/types.ts` 的 `ChapterMeta`）。"""
    body = text[int(chapter['start']):int(chapter['end'])]      # type: ignore[call-overload]
    return sum(1 for line in body.splitlines()[1:] if line.strip())


def _check_long_chapter(lib: Library) -> List[str]:
    """(i)：`roles.longText.chapterIndex` 指向的正文章节含 ≥ 200 个段落。"""
    index = long_text_chapter(lib)
    if index is None:
        return [f'目录里找不到唯一一个标题为 {fixture.LONG_TEXT_CHAPTER_TITLE} 的正文章节']
    chapter = lib.chapters(fixture.ROLES.long_text)[index]
    count = paragraph_count(lib.text(fixture.ROLES.long_text), chapter)
    if count >= MIN_PARAGRAPHS:
        return []
    return [f'下标 {index} 的章节 {count} 段，需要 ≥ {MIN_PARAGRAPHS}']


def _check_role_keywords(lib: Library) -> List[Problem]:
    """`roles.json` 里的检索词与 crlf 书：design `FixtureRoles`、需求 9.1 / 9.11 / 10.3 / 15.1。"""
    problems: List[Problem] = []
    volumes = count_hits(lib.text(fixture.ROLES.volumes), fixture.VOLUMES_KEYWORD)
    if volumes < 1:
        problems.append(Problem(
            'roles.volumesKeyword', lib.label(fixture.ROLES.volumes),
            f'{fixture.VOLUMES_KEYWORD} 出现 {volumes} 次，需要 ≥ 1'))
    long_text = lib.text(fixture.ROLES.long_text)
    few = count_hits(long_text, fixture.FEW_KEYWORD)
    if not 1 <= few < SEARCH_LIMIT:
        problems.append(Problem(
            'roles.longText.fewKeyword', lib.label(fixture.ROLES.long_text),
            f'{fixture.FEW_KEYWORD} 出现 {few} 次，需要 1 ≤ K < {SEARCH_LIMIT}'))
    none = count_hits(long_text, fixture.NO_HIT_KEYWORD)
    if none != 0:
        problems.append(Problem(
            'roles.longText.noHitKeyword', lib.label(fixture.ROLES.long_text),
            f'{fixture.NO_HIT_KEYWORD} 出现 {none} 次，需要 0 次'))
    if '\r\n' not in lib.text(fixture.ROLES.crlf):
        problems.append(Problem('roles.crlf', lib.label(fixture.ROLES.crlf), '.txt.gz 的正文里没有 CR LF'))
    return problems


#: 3.3 各项：`(项编号, 涉及的书的规格键, 校验函数)`。(a) 不涉及具体的书。
_REQUIREMENT_CHECKS = (
    ('(b)', fixture.ROLES.volumes, _check_volumes),
    ('(c)', fixture.ROLES.fallback, _check_fallback),
    ('(d)', fixture.ROLES.stars, _check_stars),
    ('(e)', fixture.ROLES.huge, _check_huge),
    ('(f)', fixture.ROLES.pinyin, _check_pinyin),
    ('(g)', fixture.ROLES.same_author[0], _check_same_author),
    ('(h)', fixture.ROLES.long_text, _check_cap_keyword),
    ('(i)', fixture.ROLES.long_text, _check_long_chapter),
)

_READ_ERRORS = (OSError, ValueError, KeyError, TypeError, EOFError, gzip.BadGzipFile)


def check_library(lib: Library) -> List[Problem]:
    """需求 3.8：逐项核对 3.3 (a)–(i)，再核对 `roles.json` 的检索词。"""
    problems: List[Problem] = []
    if len(lib.entries) < MIN_BOOKS:
        problems.append(Problem('(a)', '', f'books.json 共 {len(lib.entries)} 本，需要 ≥ {MIN_BOOKS}'))
    for item, key, check in _REQUIREMENT_CHECKS:
        label = f'作者 {fixture.SAME_AUTHOR}' if item == '(g)' else lib.label(key)
        try:
            issues = check(lib)
        except _READ_ERRORS as exc:
            issues = [f'读取产物失败：{type(exc).__name__}：{exc}']
        problems += [Problem(item, label, issue) for issue in issues]
    try:
        problems += _check_role_keywords(lib)
    except _READ_ERRORS as exc:
        problems.append(Problem('roles', '', f'读取产物失败：{type(exc).__name__}：{exc}'))
    return problems


# ---------------------------------------------------------------------------
# 一次生成
# ---------------------------------------------------------------------------


@dataclass
class Outcome:
    ok: bool
    headline: str
    problems: List[Problem] = field(default_factory=list)
    pipeline: Optional[PipelineResult] = None


def generate(layout: Layout, digest: str, *, from_scratch: bool, tag: str = '[夹具]') -> Outcome:
    """在 `layout` 下生成一次 Fixture_Library。成功时写 `roles.json` 与 `record.json`。"""
    if from_scratch and layout.root.exists():
        shutil.rmtree(layout.root)
    layout.root.mkdir(parents=True, exist_ok=True)
    # 只描述成功生成的两个文件先作废（模块 docstring「失败时不留生成记录」）。
    layout.record.unlink(missing_ok=True)
    layout.roles.unlink(missing_ok=True)

    total, written = write_sources(layout)
    print(f'{tag} 源压缩包 {total} 个（本次写入 {written} 个）→ {_rel(layout.src)}/')

    print(f'{tag} 调用 scripts/preprocess.py 的 run()，管线输出见 {_rel(layout.log)}')
    result = run_pipeline(layout)
    print(
        f'{tag} 管线退出码 {result.code}，用时 {result.seconds:.1f} s'
        f'（跳过 {result.skipped} 本，告警 {result.warnings} 条）'
    )

    problems, entries = check_pipeline(layout, result)
    if problems:
        return Outcome(False, '管线未能产出夹具源定义的全部书（需求 3.6）', problems, result)

    lib = Library(layout, entries)
    problems = check_library(lib)
    if problems:
        return Outcome(False, '产出的夹具书库不满足需求 3.3 的以下各项（需求 3.8）', problems, result)

    chapter_index = long_text_chapter(lib)
    assert chapter_index is not None                  # (i) 已通过
    _write_json(layout.roles, fixture.build_roles(lib.id_of, chapter_index))
    _write_json(
        layout.record,
        {'digest': digest, 'pipelineVersion': PIPELINE_VERSION, 'bookCount': len(entries)},
    )
    return Outcome(True, f'{len(entries)} 本，3.3 (a)–(i) 全部满足', [], result)


def _report_failure(outcome: Outcome, layout: Layout, tag: str = '[夹具生成失败]') -> None:
    lines = [f'{tag} {outcome.headline}：', *(p.line() for p in outcome.problems)]
    lines.append(f'生成记录未更新；管线完整输出见 {_rel(layout.log)}')
    sys.stdout.flush()                                # 管道里 stdout 是块缓冲，先冲掉进度行
    print('\n'.join(lines), file=sys.stderr)


def run_generate(digest: str, *, if_stale: bool) -> int:
    """`npm run e2e:fixture`（及 `--if-stale`）的主体。"""
    layout = Layout(FIXTURE_OUT)
    reason = stale_reason(layout, digest)
    if reason is None and if_stale:
        print(f'[夹具] 已是最新（摘要 {digest[:12]}…），不重新生成：{_rel(layout.root)}/')
        return EXIT_OK

    record = _read_json(layout.record)
    from_scratch = not isinstance(record, dict) or record.get('digest') != digest
    mode = f'从零生成（{reason}）' if from_scratch else f'保留上次产物增量重跑（{reason or "已是最新"}）'
    print(f'[夹具] 摘要 {digest[:12]}…（PIPELINE_VERSION {PIPELINE_VERSION}）：{mode}')

    started = time.perf_counter()
    outcome = generate(layout, digest, from_scratch=from_scratch)
    if not outcome.ok:
        _report_failure(outcome, layout)
        return EXIT_FAILED
    print(
        f'[夹具] 完成：{outcome.headline}；已写 {_rel(layout.roles)} 与 {_rel(layout.record)}'
        f'（共 {time.perf_counter() - started:.1f} s）'
    )
    return EXIT_OK


# ---------------------------------------------------------------------------
# 确定性核对（属性 4，需求 3.5）
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Snapshot:
    ids: Tuple[str, ...]
    files: Mapping[str, bytes]


def normalize_index(data: bytes) -> bytes:
    """把 `books.json` 的 `generatedAt` 值替换为占位串（需求 3.5）。"""
    text = _GENERATED_AT.sub(f'"generatedAt":"{GENERATED_AT_PLACEHOLDER}"', data.decode('utf-8'), count=1)
    return text.encode('utf-8')


def snapshot(layout: Layout) -> Snapshot:
    """`books/`、`data/` 下的全部文件与 `roles.json` 的字节，以及 `books.json` 的书 id 集合。"""
    files: Dict[str, bytes] = {}
    for folder in (layout.books, layout.data):
        for path in sorted(folder.rglob('*')):
            if path.is_file():
                data = path.read_bytes()
                files[path.relative_to(layout.root).as_posix()] = (
                    normalize_index(data) if path == layout.index else data
                )
    if layout.roles.is_file():
        files['roles.json'] = layout.roles.read_bytes()
    entries = _index_entries(_read_json(layout.index)) or []
    return Snapshot(tuple(sorted(str(e.get('id')) for e in entries)), files)


def compare(expected: Snapshot, actual: Snapshot, limit: int = 20) -> List[str]:
    """两份快照的差异，每条一行；一致时为空。"""
    diffs: List[str] = []
    for book_id in sorted(set(expected.ids) - set(actual.ids)):
        diffs.append(f'书 id 缺失：{book_id}')
    for book_id in sorted(set(actual.ids) - set(expected.ids)):
        diffs.append(f'书 id 多出：{book_id}')
    for key in sorted(set(expected.files) | set(actual.files)):
        before, after = expected.files.get(key), actual.files.get(key)
        if before is None:
            diffs.append(f'多出文件：{key}')
        elif after is None:
            diffs.append(f'缺少文件：{key}')
        elif before != after:
            diffs.append(f'字节不同：{key}（{len(before):,} B → {len(after):,} B）')
    if len(diffs) > limit:
        diffs = diffs[:limit] + [f'……另有 {len(diffs) - limit} 处差异']
    return diffs


def run_verify(digest: str) -> int:
    """`--verify-determinism`：见模块 docstring 同名一节。"""
    reference_layout = Layout(FIXTURE_OUT)
    reference = snapshot(reference_layout) if stale_reason(reference_layout, digest) is None else None
    if VERIFY_OUT.exists():
        shutil.rmtree(VERIFY_OUT)
    first, second = Layout(VERIFY_OUT / 'a'), Layout(VERIFY_OUT / 'b')
    print(f'[确定性] 摘要 {digest[:12]}…（PIPELINE_VERSION {PIPELINE_VERSION}），工作目录 {_rel(VERIFY_OUT)}/')

    failures: List[str] = []

    def attempt(layout: Layout, from_scratch: bool, label: str) -> Optional[Outcome]:
        print(f'[确定性] {label}：{_rel(layout.root)}/')
        outcome = generate(layout, digest, from_scratch=from_scratch, tag='[确定性]  ')
        if not outcome.ok:
            _report_failure(outcome, layout, tag=f'[确定性] {label}失败')
            failures.append(f'{label}失败')
            return None
        return outcome

    def check(label: str, expected: Snapshot, actual: Snapshot) -> None:
        diffs = compare(expected, actual)
        if diffs:
            failures.append(f'{label}：{len(diffs)} 处差异')
            print('\n'.join([f'[确定性] {label}与第一次从零生成不一致：', *(f'  - {d}' for d in diffs)]),
                  file=sys.stderr)
        else:
            print(f'[确定性] {label}：{len(expected.ids)} 本、{len(expected.files)} 个文件逐字节一致')

    if attempt(first, True, '第一次从零生成') is not None:
        baseline = snapshot(first)
        rerun = attempt(first, False, '保留产物增量重跑')
        if rerun is not None:
            skipped = rerun.pipeline.skipped if rerun.pipeline else 0
            if skipped != len(fixture.SPECS):
                failures.append(f'增量重跑只跳过了 {skipped} / {len(fixture.SPECS)} 本')
                print(f'[确定性] 增量重跑只跳过了 {skipped} / {len(fixture.SPECS)} 本，'
                      '没有走到清单跳过的路径', file=sys.stderr)
            check('增量重跑', baseline, snapshot(first))
        if attempt(second, True, '第二次从零生成') is not None:
            check('第二次从零生成', baseline, snapshot(second))
        if reference is not None:
            check(f'{_rel(FIXTURE_OUT)}/ 现有产物', baseline, reference)
        else:
            print(f'[确定性] {_rel(FIXTURE_OUT)}/ 不是最新，跳过与它的比对')

    if failures:
        print(f'[确定性] 不通过（{"；".join(failures)}）；保留 {_rel(VERIFY_OUT)}/ 供排查', file=sys.stderr)
        return EXIT_FAILED
    shutil.rmtree(VERIFY_OUT)
    print('[确定性] 通过：两次从零生成与一次增量重跑的产物逐字节一致（books.json 的 generatedAt 除外）')
    return EXIT_OK


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog='generate.py',
        description=(
            '从 e2e/fixture/books.py 合成夹具源，调用 scripts/preprocess.py 的 run() 生成 '
            'e2e/.out/fixture/ 下的 Fixture_Library，并写出 roles.json 与 record.json。'
        ),
    )
    group = parser.add_mutually_exclusive_group()
    group.add_argument(
        '--if-stale',
        action='store_true',
        help='生成记录的摘要与当前一致、且 books.json 所列书的产物齐全时不重新生成，直接返回 0。',
    )
    group.add_argument(
        '--verify-determinism',
        action='store_true',
        help=(
            '在 e2e/.out/fixture-verify/ 下从零生成两次、增量重跑一次，逐字节比对产物'
            '（books.json 的 generatedAt 除外）；不改 e2e/.out/fixture/。'
        ),
    )
    return parser.parse_args(argv)


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = parse_args(argv)
    missing = missing_dependencies()
    if missing:
        _report_missing(missing)
        return EXIT_FAILED
    digest = source_digest()
    if args.verify_determinism:
        return run_verify(digest)
    return run_generate(digest, if_stale=args.if_stale)


if __name__ == '__main__':
    raise SystemExit(main())
