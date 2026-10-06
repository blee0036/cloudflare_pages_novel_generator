# -*- coding: utf-8 -*-
r"""`scripts/preprocess.py` 编排层（任务 26，需求 7.1 / 7.2 / 7.9 / 5.1 / 5.2a / 5.2b / 10.7）。

运行（仓库根目录）：`python -m pytest scripts/tests -q`

断言五组事实：

1. **依赖是声明式硬依赖**（需求 7.9）：`zopfli` 在 `REQUIRED_DEPENDENCIES` 里，缺任何
   一个都非零退出，且报错明说不会降级运行——这条是"缺 zopfli 就退回 gz9"的反面，
   回退等于对一本已知越限的书静默写出 > 25MB 的产物。
2. **压缩器按源包体积二选一**（需求 10.7）：阈值 10 MiB 不含边界；两条分支的产物都是
   **标准 gzip 流**（魔数 `1f 8b` + `gzip.decompress` 逐字符回读），所以前端
   `DecompressionStream("gzip")` 零改动。
3. **`books.json` 的形状**（需求 5.1 / 5.2a / 5.2b）：无缩进、不含 `txtPath`/`tocPath`、
   字段用可读全名、含秒级 `generatedAt`、**不生成 `.gz`**，且能通过 `validate.check_books`。
4. **单本失败不终止整批**（需求 7.1 / 7.2）：坏书记账后继续，好书照样出产物，
   退出码为 1，坏书不进 `books.json`、不进清单。
5. **增量**（需求 7.3–7.5）：第二次运行全部跳过，但 `books.json` 仍是**全库**索引
   而不是"本次处理了什么"的日志；源文件删掉后书照样在索引里（第 9 组展开）。
6. **两条输出流都是 UTF-8**：stdout **与 stderr**。只重设 stdout 时，cp936 控制台下
   `Report.fail()` 写 stderr 抛出的编码错误会从逐本 `except` 里飞出去，终止剩下的书。
7. **流水线换版要重跑**（`manifest.PIPELINE_VERSION`）：源文件没变、但切分逻辑变了的书
   全部重做，且在输出里说清"为什么一次什么都没改的运行在重建全库"。
8. **兜底日志说对原因**（`build_toc`）：择一落空时点名真正挡掉候选的门槛；规则已选定时
   分清"过滤后不足 2 个标题"与"命中够多、但过不了篇幅门槛"。
9. **源文件删了，书还在；`--delete-source`**（需求 7.5 修订 / 7.12）：处理一本删一本、
   失败与越限的不删；归档书在换版/缺目录时从 `.txt.gz` 重切，两个产物都删掉才算移除；
   已分配的 id 不让给新来的同名书；改名不重做；清单丢失时点名孤儿产物。

夹具是合成的小书（5 章、每章约 1400 字），不依赖任何真实藏书：本任务要验的是
编排顺序与产物形状，章节识别本身由 `test_toc*.py` 对着合成书断言。
"""

from __future__ import annotations

import gzip
import io
import json
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path
from typing import Any, Dict, List, NamedTuple, Optional, Tuple

import pytest

from scripts import preprocess
from scripts.lib import manifest as manifest_mod
from scripts.lib import report as report_mod
from scripts.lib import toc_overrides
from scripts.lib import toc_rules
from scripts.lib import validate

REPO_ROOT = Path(__file__).resolve().parents[2]

CHAPTER_TITLES = ('第一章 起风了', '第二章 夜行', '第三章 旧事', '第四章 长街', '第五章 归途')


# ---------------------------------------------------------------------------
# 夹具
# ---------------------------------------------------------------------------


def novel_text(titles: Any = CHAPTER_TITLES, body_chars: int = 1400) -> str:
    """合成一本能被"标准章节"规则切开的小书。

    每章正文远超 `toc.GAP_CHAPTER`（1000 字），所以采样评分会把 5 个命中全记成有效
    章节；也远超 `VOLUME_BODY_MAX`（100 字），不会被误标成卷。
    """
    paragraph = '这是一段用于测试的正文内容，长度足够让相邻标题之间拉开距离。\n'
    body = paragraph * (body_chars // len(paragraph) + 1)
    return ''.join(f'{title}\n{body}' for title in titles)


class Bench:
    """一套完全落在 `tmp_path` 里的源目录 + 产物目录 + 清单。"""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.source_dir = root / 'zip-novel'
        self.books_dir = root / 'public' / 'books'
        self.data_dir = root / 'public' / 'data'
        self.manifest_path = root / '.preprocess-manifest.json'
        # 刻意指向一个不存在的文件：覆盖表缺失等价于空表，测试不受本机覆盖表影响。
        self.overrides_path = root / 'toc-overrides.json'
        self.source_dir.mkdir(parents=True, exist_ok=True)
        self.rep: Optional[report_mod.Report] = None

    def add(self, title: str, author: str, text: Optional[str] = None) -> Path:
        """放一本 `.zip` 源文件，返回它的路径。"""
        path = self.source_dir / f'《{title}》作者：{author}.zip'
        with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as zf:
            zf.writestr('book.txt', (text if text is not None else novel_text()).encode('utf-8'))
        return path

    def add_broken(self, title: str, author: str) -> Path:
        """放一个**不是 zip** 的 `.zip`：解压环节必然失败（需求 7.1 的被试者）。"""
        path = self.source_dir / f'《{title}》作者：{author}.zip'
        path.write_bytes(b'this is definitely not a zip archive')
        return path

    def run(self, delete_source: bool = False) -> int:
        """跑一批，两条输出流收进内存，返回退出码。"""
        self.rep = report_mod.Report(
            books_dir=self.books_dir,
            data_dir=self.data_dir,
            out=io.StringIO(),
            err=io.StringIO(),
        )
        return preprocess.run(
            source_dir=self.source_dir,
            books_dir=self.books_dir,
            data_dir=self.data_dir,
            manifest_path=self.manifest_path,
            overrides_path=self.overrides_path,
            rep=self.rep,
            delete_source=delete_source,
        )

    def err(self) -> str:
        return self.rep.err.getvalue() if self.rep else ''    # type: ignore[union-attr]

    def sources(self) -> List[str]:
        return sorted(path.name for path in self.source_dir.iterdir())

    # -- 产物 ---------------------------------------------------------------

    @property
    def index_path(self) -> Path:
        return self.data_dir / preprocess.INDEX_NAME

    def index_text(self) -> str:
        return self.index_path.read_text(encoding='utf-8')

    def index(self) -> Dict[str, Any]:
        return json.loads(self.index_text())

    def books(self) -> List[Dict[str, Any]]:
        return self.index()['books']

    def ids(self) -> List[str]:
        return [book['id'] for book in self.books()]

    def gz_text(self, book_id: str) -> str:
        data = (self.books_dir / manifest_mod.gz_name(book_id)).read_bytes()
        return gzip.decompress(data).decode('utf-8')

    def toc(self, book_id: str) -> Dict[str, Any]:
        path = self.data_dir / manifest_mod.toc_name(book_id)
        return json.loads(path.read_text(encoding='utf-8'))

    def manifest(self) -> manifest_mod.Manifest:
        return manifest_mod.load(
            self.manifest_path, books_dir=self.books_dir, data_dir=self.data_dir
        )


@pytest.fixture
def bench(tmp_path: Path) -> Bench:
    return Bench(tmp_path)


# ---------------------------------------------------------------------------
# ① 依赖是声明式硬依赖（需求 7.9）
# ---------------------------------------------------------------------------


def test_zopfli_is_a_declared_hard_dependency() -> None:
    """`zopfli` 在入口检查里，且用途文案点明"缺失即失败，不回退 gz9"。"""
    table = {module: (dist, purpose) for module, dist, purpose in preprocess.REQUIRED_DEPENDENCIES}
    assert 'zopfli' in table, '源包 >10MB 的书只能靠 zopfli 压进 25 MiB（需求 10.7）'
    dist, purpose = table['zopfli']
    assert dist == 'zopfli'
    assert '不回退' in purpose and 'gz9' in purpose


def test_missing_dependency_exits_without_degrading() -> None:
    """缺依赖 → 非零退出 + 指出包名与安装方式，并明说不会降级运行。"""
    stream = io.StringIO()
    with pytest.raises(SystemExit) as excinfo:
        preprocess.require_dependencies(
            (('a_module_that_does_not_exist', 'zopfli', '测试用途'),), stream=stream
        )
    assert excinfo.value.code == 1
    text = stream.getvalue()
    assert 'zopfli' in text
    assert 'requirements.txt' in text
    assert '不会在依赖缺失时降级运行' in text


def test_present_dependencies_pass() -> None:
    """全部可导入时 `require_dependencies` 静默返回（本仓库的正常状态）。"""
    preprocess.require_dependencies()


# ---------------------------------------------------------------------------
# ② 压缩器按源包体积二选一（需求 10.7）
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'source_bytes, expected',
    [
        (0, report_mod.GZ9),
        (1, report_mod.GZ9),
        (preprocess.ZOPFLI_SRC_BYTES - 1, report_mod.GZ9),
        (preprocess.ZOPFLI_SRC_BYTES, report_mod.GZ9),        # 阈值不含边界
        (preprocess.ZOPFLI_SRC_BYTES + 1, report_mod.ZOPFLI),
        (24 * 1024 * 1024, report_mod.ZOPFLI),                # 远超阈值的大源包
    ],
)
def test_pick_compressor_uses_source_size(source_bytes: int, expected: str) -> None:
    assert preprocess.pick_compressor(source_bytes) == expected


@pytest.mark.parametrize(
    'source_bytes, expected',
    [
        (1024, report_mod.GZ9),
        (preprocess.ZOPFLI_SRC_BYTES + 1, report_mod.ZOPFLI),
    ],
)
def test_compress_text_always_emits_standard_gzip(source_bytes: int, expected: str) -> None:
    """两条分支都产出标准 gzip 流：魔数 `1f 8b` + 逐字符回读一致。

    这是前端零改动的全部依据——`zopfli` 同包的 zlib / 裸 deflate 接口压缩数据一样是
    DEFLATE，但容器不同，`DecompressionStream("gzip")` 会静默解不开。
    """
    text = novel_text()
    payload, compressor = preprocess.compress_text(text, source_bytes)
    assert compressor == expected
    assert payload[:2] == b'\x1f\x8b'
    assert gzip.decompress(payload).decode('utf-8') == text


def test_gz9_output_is_reproducible() -> None:
    """同一段文本压两次逐字节相同（`mtime=0`）：重跑不产生无意义的产物差异。"""
    text = novel_text()
    first, _ = preprocess.compress_text(text, 1024)
    second, _ = preprocess.compress_text(text, 1024)
    assert first == second


# ---------------------------------------------------------------------------
# ③ books.json 的形状（需求 5.1 / 5.2a / 5.2b）
# ---------------------------------------------------------------------------


def test_index_shape(bench: Bench) -> None:
    bench.add('测试书甲', '某甲')
    bench.add('测试书乙', '某乙')

    assert bench.run() == report_mod.EXIT_OK

    raw = bench.index_text()
    # 需求 5.1：无缩进。json.dumps(indent=2) 会产出换行 + 前导空格，这里一个都不该有。
    assert '\n' not in raw
    assert ': ' not in raw and ', ' not in raw
    # 需求 5.1：可由 id 推导的字段不写（前端按 id 派生两个 URL）。
    assert 'txtPath' not in raw and 'tocPath' not in raw

    data = bench.index()
    assert data['count'] == 2 == len(data['books'])
    assert validate.TIMESTAMP.match(data['generatedAt']), data['generatedAt']

    # 条目顺序即源文件名排序（`archive.scan_source_dir`），按 id 取而不是按下标。
    assert bench.ids() == ['测试书乙-某乙', '测试书甲-某甲']
    book = {item['id']: item for item in data['books']}['测试书甲-某甲']
    assert book['id'] == '测试书甲-某甲'
    assert book['title'] == '测试书甲'
    assert book['author'] == '某甲'
    # 需求 5.2b：可读全名，不用 tp/ap 这类缩写键。
    assert book['titleAbbr'] == 'cssj'
    assert 'tp' not in book and 'ap' not in book
    assert book['charCount'] == len(novel_text())
    assert book['totalChapters'] == len(CHAPTER_TITLES)
    assert book['gzSize'] > 0

    # 需求 7.10：写出来的这份自己能过校验。
    validate.check_books(data)

    # 需求 5.2a：索引不预压缩——透明解压是浏览器的事。
    assert not (bench.data_dir / f'{preprocess.INDEX_NAME}.gz').exists()
    assert sorted(p.name for p in bench.data_dir.iterdir()) == [
        'books.json',
        '测试书乙-某乙_toc.json',
        '测试书甲-某甲_toc.json',
    ]


def test_artifacts_match_the_index(bench: Bench) -> None:
    """`.txt.gz` 解出来的字符数与两份索引记的一致（INV-1 的唯一坐标系）。"""
    text = novel_text()
    bench.add('测试书甲', '某甲', text)

    assert bench.run() == report_mod.EXIT_OK

    book_id = '测试书甲-某甲'
    assert bench.gz_text(book_id) == text

    toc_data = bench.toc(book_id)
    assert toc_data['charCount'] == len(text)
    assert toc_data['tocRule'] == '标准章节'
    assert 'fallback' not in toc_data
    assert toc_data['chapters'][0]['start'] == 0
    assert toc_data['chapters'][-1]['end'] == len(text)

    index_book = bench.books()[0]
    assert index_book['charCount'] == toc_data['charCount']
    assert index_book['totalChapters'] == toc_data['totalChapters']
    assert index_book['gzSize'] == (bench.books_dir / manifest_mod.gz_name(book_id)).stat().st_size


def test_small_source_uses_gz9_and_records_it(bench: Bench) -> None:
    """合成夹具都是小包 → gz9，且压缩器记进清单（`books.json` 里没有这个键）。"""
    bench.add('测试书甲', '某甲')
    assert bench.run() == report_mod.EXIT_OK

    entry = bench.manifest().entry_for('《测试书甲》作者：某甲.zip')
    assert entry is not None
    assert entry.compressor == report_mod.GZ9
    assert 'compressor' not in bench.books()[0]


# ---------------------------------------------------------------------------
# ④ 单本失败不终止整批（需求 7.1 / 7.2）
# ---------------------------------------------------------------------------


def test_one_bad_book_does_not_stop_the_batch(bench: Bench) -> None:
    bench.add('测试书甲', '某甲')
    bench.add_broken('坏书', '某丙')
    bench.add('测试书乙', '某乙')

    code = bench.run()

    # 需求 7.2：有失败 → 非零退出，但产物本身合规（不是护栏那一档）。
    assert code == report_mod.EXIT_BOOK_FAILED
    rep = bench.rep
    assert rep is not None
    assert (rep.n_ok, rep.n_failed, rep.n_skipped) == (2, 1, 0)
    assert [item.source for item in rep.failures] == ['《坏书》作者：某丙.zip']

    # 好书照样出产物、照样进索引；坏书既不进索引也不进清单。
    assert bench.ids() == ['测试书乙-某乙', '测试书甲-某甲']
    assert '坏书-某丙' not in bench.ids()
    assert not (bench.books_dir / manifest_mod.gz_name('坏书-某丙')).exists()
    assert '《坏书》作者：某丙.zip' not in bench.manifest()

    # 失败原因逐条进摘要（需求 7.2），完整报错在 stderr。
    summary = bench.rep.out.getvalue()      # type: ignore[union-attr]
    assert '失败 1' in summary
    assert '《坏书》作者：某丙.zip' in summary


def test_failed_validation_keeps_the_book_out_of_the_manifest(
    bench: Bench, monkeypatch: pytest.MonkeyPatch
) -> None:
    """自校验不过的书算失败且**不写清单**——否则它此后每次运行都被跳过（需求 7.10）。"""
    bench.add('测试书甲', '某甲')

    def boom(meta: Any, toc: Any = None) -> Any:
        raise validate.ValidationError('构造出来的产物结构错误')

    monkeypatch.setattr(preprocess.validate, 'check', boom)

    assert bench.run() == report_mod.EXIT_BOOK_FAILED
    assert len(bench.manifest()) == 0
    assert bench.books() == []
    assert bench.index()['count'] == 0


def test_id_collision_is_disambiguated(bench: Bench) -> None:
    """同名书不静默覆盖：后到的拿 `_2`，两组产物各自存在（需求 7.9）。"""
    # 文件名不同、书名与作者相同 → 同一个原始 book_id。
    for suffix in ('上册', '下册'):
        path = bench.source_dir / f'《同名书》作者：某甲（{suffix}）.zip'
        with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as zf:
            zf.writestr('book.txt', novel_text().encode('utf-8'))

    assert bench.run() == report_mod.EXIT_OK
    assert bench.ids() == ['同名书-某甲', '同名书-某甲_2']
    for book_id in bench.ids():
        assert (bench.books_dir / manifest_mod.gz_name(book_id)).is_file()
        assert (bench.data_dir / manifest_mod.toc_name(book_id)).is_file()


# ---------------------------------------------------------------------------
# ⑤ 增量与清理（需求 7.3 / 7.4 / 7.5）
# ---------------------------------------------------------------------------


def test_second_run_skips_but_index_stays_complete(bench: Bench) -> None:
    """全部跳过时 `books.json` 仍是全库索引，而不是"本次处理了什么"的日志。"""
    bench.add('测试书甲', '某甲')
    bench.add('测试书乙', '某乙')
    assert bench.run() == report_mod.EXIT_OK
    first = bench.index()

    assert bench.run() == report_mod.EXIT_OK
    rep = bench.rep
    assert rep is not None
    assert (rep.n_ok, rep.n_skipped, rep.n_failed) == (0, 2, 0)

    second = bench.index()
    assert second['books'] == first['books']       # 逐字段一致，含拼音与 gzSize
    assert second['count'] == 2


def test_changed_source_is_reprocessed(bench: Bench) -> None:
    """源文件变了就重跑那一本，另一本照旧跳过（需求 7.4）。"""
    bench.add('测试书甲', '某甲')
    bench.add('测试书乙', '某乙')
    assert bench.run() == report_mod.EXIT_OK

    longer = novel_text(CHAPTER_TITLES + ('第六章 新章',))
    bench.add('测试书乙', '某乙', longer)          # 覆盖同名源文件 → 摘要变了

    assert bench.run() == report_mod.EXIT_OK
    rep = bench.rep
    assert rep is not None
    assert (rep.n_ok, rep.n_skipped) == (1, 1)

    updated = {book['id']: book for book in bench.books()}
    assert updated['测试书乙-某乙']['charCount'] == len(longer)
    assert updated['测试书乙-某乙']['totalChapters'] == 6


def test_deleted_source_keeps_the_book(bench: Bench) -> None:
    """源文件删掉 → 书照样在索引里，产物与清单条目都不动（需求 7.5 修订）。"""
    bench.add('测试书甲', '某甲')
    source = bench.add('测试书乙', '某乙')
    assert bench.run() == report_mod.EXIT_OK
    first = bench.index()

    source.unlink()
    assert bench.run() == report_mod.EXIT_OK

    assert bench.index()['books'] == first['books'], '逐字段一致，含拼音与 gzSize'
    assert (bench.books_dir / manifest_mod.gz_name('测试书乙-某乙')).is_file()
    assert (bench.data_dir / manifest_mod.toc_name('测试书乙-某乙')).is_file()
    assert '《测试书乙》作者：某乙.zip' in bench.manifest()
    rep = bench.rep
    assert rep is not None
    assert (rep.n_ok, rep.n_skipped, rep.n_archived, rep.n_failed) == (0, 1, 1, 0)
    assert '归档 1' in rep.out.getvalue()      # type: ignore[union-attr]


def test_an_empty_source_dir_keeps_the_whole_library(bench: Bench) -> None:
    """源目录整个清空（删源模式的常态）：索引一本不少，什么都不删。"""
    bench.add('测试书甲', '某甲')
    bench.add('测试书乙', '某乙')
    assert bench.run() == report_mod.EXIT_OK
    first = bench.index()

    for path in bench.source_dir.iterdir():
        path.unlink()
    assert bench.run() == report_mod.EXIT_OK

    assert bench.index()['books'] == first['books']
    assert '[孤儿产物]' not in bench.err()


def test_missing_artifact_forces_reprocess(bench: Bench) -> None:
    """清单说处理过、但产物被删了 → 重跑这一本，不静默留一个 404 的资源（需求 7.4）。"""
    bench.add('测试书甲', '某甲')
    assert bench.run() == report_mod.EXIT_OK

    (bench.books_dir / manifest_mod.gz_name('测试书甲-某甲')).unlink()

    assert bench.run() == report_mod.EXIT_OK
    rep = bench.rep
    assert rep is not None
    assert (rep.n_ok, rep.n_skipped) == (1, 0)
    assert (bench.books_dir / manifest_mod.gz_name('测试书甲-某甲')).is_file()


def test_empty_source_dir_is_not_a_crash(bench: Bench) -> None:
    """空源目录：干净退出，索引写成 0 本，什么都不删。"""
    assert bench.run() == report_mod.EXIT_OK
    assert bench.index() == {
        'count': 0,
        'generatedAt': bench.index()['generatedAt'],
        'books': [],
    }


def test_missing_source_dir_is_a_config_error(tmp_path: Path) -> None:
    """源目录不存在是配置错误：非零退出，不写任何产物。"""
    code = preprocess.run(
        source_dir=tmp_path / 'nope',
        books_dir=tmp_path / 'public' / 'books',
        data_dir=tmp_path / 'public' / 'data',
        manifest_path=tmp_path / '.manifest.json',
        overrides_path=tmp_path / 'toc-overrides.json',
    )
    assert code == preprocess.EXIT_CONFIG
    assert not (tmp_path / 'public').exists()


def test_unsupported_files_are_reported_not_silently_ignored(
    bench: Bench, capsys: pytest.CaptureFixture[str]
) -> None:
    """`.txt` 之类不受支持的扩展名要被点名列出（旧写法只 glob `*.rar`，其余静默忽略）。"""
    bench.add('测试书甲', '某甲')
    (bench.source_dir / '随手放的笔记.md').write_text('noop', encoding='utf-8')

    assert bench.run() == report_mod.EXIT_OK
    assert '随手放的笔记.md' in capsys.readouterr().out


def test_hidden_files_in_the_source_dir_are_not_listed(
    bench: Bench, capsys: pytest.CaptureFixture[str]
) -> None:
    """`.gitkeep`、`.DS_Store` 这类隐藏文件不是书，不出现在"忽略"提示里。"""
    bench.add('测试书甲', '某甲')
    (bench.source_dir / '.gitkeep').write_bytes(b'')
    (bench.source_dir / '.DS_Store').write_bytes(b'\x00')

    assert bench.run() == report_mod.EXIT_OK
    out = capsys.readouterr().out
    assert '[忽略]' not in out
    assert '.gitkeep' not in out and '.DS_Store' not in out


# ---------------------------------------------------------------------------
# ⑥ 两条输出流都重设为 UTF-8
# ---------------------------------------------------------------------------


def test_force_utf8_reconfigures_a_stream() -> None:
    raw = io.BytesIO()
    stream = io.TextIOWrapper(raw, encoding='ascii', errors='strict', newline='\n')
    with pytest.raises(UnicodeEncodeError):
        stream.write('《坏书》')                    # 重设之前：写中文就炸

    preprocess._force_utf8(stream)

    assert stream.encoding.replace('-', '').lower() == 'utf8'
    stream.write('《坏书》 ❌')
    stream.flush()
    assert '坏书' in raw.getvalue().decode('utf-8')


def test_force_utf8_tolerates_streams_it_cannot_reconfigure() -> None:
    """`None` 与没有 `reconfigure` 的流（`io.StringIO` 就是）都不该让入口炸掉——
    重设不了时兜底的是 `report._emit` 的降级输出。"""
    preprocess._force_utf8(None)
    preprocess._force_utf8(io.StringIO())


def test_importing_preprocess_reconfigures_stdout_and_stderr() -> None:
    """真跑一次 import：**两条**流都要变成 UTF-8。

    只重设 stdout 的那一版在这里输出 `utf-8 ascii`。而 stderr 正是 `Report.fail()`
    与全部告警走的那条流，`fail()` 又是在编排层逐本的 `except Exception` 里面被调用
    的——那里抛出 `UnicodeEncodeError` 不会被这一本的 `try` 接住，剩下几千本一起终止。
    所以这条断言就是那个漏洞的回归锚点。
    """
    probe = (
        'import io, sys\n'
        "sys.stdout = io.TextIOWrapper(io.BytesIO(), encoding='ascii')\n"
        "sys.stderr = io.TextIOWrapper(io.BytesIO(), encoding='ascii')\n"
        'try:\n'
        '    import scripts.preprocess\n'
        'except BaseException as exc:\n'
        "    sys.__stdout__.write(f'IMPORT-FAILED {exc!r}')\n"
        'else:\n'
        "    sys.__stdout__.write(f'{sys.stdout.encoding} {sys.stderr.encoding}')\n"
    )
    result = subprocess.run(
        [sys.executable, '-c', probe],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
    )
    assert result.stdout.strip() == 'utf-8 utf-8', result.stdout


# ---------------------------------------------------------------------------
# ⑦ 流水线换版要重跑（manifest.PIPELINE_VERSION）
# ---------------------------------------------------------------------------


def stale_the_manifest(bench: Bench) -> None:
    """把清单里每条记录的 `pipelineVersion` 改回上一版。

    "有人改了 `toc_rules.py` 的规则表 / `toc.py` 的择一逻辑并把 `PIPELINE_VERSION`
    +1"在单测里的等价形态——源文件一个字节都没动，摘要也就一个都没变。
    """
    raw = json.loads(bench.manifest_path.read_text(encoding='utf-8'))
    for entry in raw['books'].values():
        entry['pipelineVersion'] = manifest_mod.PIPELINE_VERSION - 1
    bench.manifest_path.write_text(
        json.dumps(raw, ensure_ascii=False, indent=2) + '\n', encoding='utf-8'
    )


def test_pipeline_version_bump_reprocesses_untouched_books(
    bench: Bench, capsys: pytest.CaptureFixture[str]
) -> None:
    bench.add('测试书甲', '某甲')
    bench.add('测试书乙', '某乙')
    assert bench.run() == report_mod.EXIT_OK
    first = bench.index()
    capsys.readouterr()                          # 丢掉第一轮的输出

    stale_the_manifest(bench)

    assert bench.run() == report_mod.EXIT_OK
    rep = bench.rep
    assert rep is not None
    assert (rep.n_ok, rep.n_skipped, rep.n_failed) == (2, 0, 0)

    text = capsys.readouterr().out
    assert text.count('[流水线版本]') == 2, '逐本一行：这一本为什么被重做'
    assert '[流水线版本变更] 本次有 2 本' in text, '整批一笔：操作者要的那个数字'
    # 开跑之前就有一条告示（清单加载期），走的是 stderr
    assert '[流水线版本变更]' in rep.err.getvalue()      # type: ignore[union-attr]

    # 产物照旧完整，且与第一轮逐字段一致——本次只是重切，不是改数据
    assert bench.index()['books'] == first['books']


def test_after_the_bump_the_next_run_skips_again(bench: Bench) -> None:
    """重做时盖上的是当前版本：第三次运行又回到"全部跳过"。"""
    bench.add('测试书甲', '某甲')
    assert bench.run() == report_mod.EXIT_OK
    stale_the_manifest(bench)
    assert bench.run() == report_mod.EXIT_OK

    entry = bench.manifest().entry_for('《测试书甲》作者：某甲.zip')
    assert entry is not None
    assert entry.pipeline_version == manifest_mod.PIPELINE_VERSION

    assert bench.run() == report_mod.EXIT_OK
    rep = bench.rep
    assert rep is not None
    assert (rep.n_ok, rep.n_skipped) == (0, 1)


def test_an_old_manifest_without_the_field_does_not_crash(bench: Bench) -> None:
    """`PIPELINE_VERSION` 之前写出的清单里根本没有这个键：按"旧版"处理 → 重跑，
    而不是崩在 KeyError 上。"""
    bench.add('测试书甲', '某甲')
    assert bench.run() == report_mod.EXIT_OK

    raw = json.loads(bench.manifest_path.read_text(encoding='utf-8'))
    for entry in raw['books'].values():
        del entry['pipelineVersion']
    bench.manifest_path.write_text(
        json.dumps(raw, ensure_ascii=False, indent=2) + '\n', encoding='utf-8'
    )

    assert bench.run() == report_mod.EXIT_OK
    rep = bench.rep
    assert rep is not None
    assert (rep.n_ok, rep.n_skipped) == (1, 0)


def test_a_source_change_is_not_reported_as_a_version_bump(
    bench: Bench, capsys: pytest.CaptureFixture[str]
) -> None:
    """源文件真的变了就是源文件变了：那本书不该被算进"版本变更重做"的账。"""
    bench.add('测试书甲', '某甲')
    assert bench.run() == report_mod.EXIT_OK
    capsys.readouterr()

    bench.add('测试书甲', '某甲', novel_text(CHAPTER_TITLES + ('第六章 新章',)))

    assert bench.run() == report_mod.EXIT_OK
    text = capsys.readouterr().out
    assert '流水线版本' not in text


# ---------------------------------------------------------------------------
# 8. 全书兜底的日志要说对原因（`build_toc`）
#
# 篇幅门槛（`toc.Coverage`）落地之后，兜底有了第二种来路：命中够多、却不像一张目录。
# 旧文案只认得"误报门槛"与"不足 2 个标题"，操作者会被它指到错误的方向上去。
# ---------------------------------------------------------------------------

TOC_BOOK_ID = '测试书-某甲'


def filler(chars: int) -> str:
    """约 `chars` 个字符的正文：每行 399 个 `雨`，长到任何规则都不会把它当标题。"""
    return ('雨' * 399 + '\n') * (chars // 400)


#: 两条相隔 24 万字符的真标题：误报门槛过得去，但命中太少太疏、没有一段可读节点。
SPARSE_BOOK = '第一章 甲\n' + filler(240_000) + '第二章 乙\n' + filler(220_000)

#: 十条紧挨着的标题（间隔 < GAP_VOLUME）：1 条有效 / 9 条疑似误报，过不了 3:1。
DENSE_BOOK = ''.join(f'第{i}章 标题\n' for i in range(1, 11)) + filler(8_000)


def toc_log(capsys: pytest.CaptureFixture[str], text: str, override: Optional[str] = None):
    """跑一遍 `build_toc`，返回 `(是否兜底, 那一行 [兜底] 日志)`。"""
    from scripts.lib import toc_overrides
    from scripts.lib.toc_rules import by_name

    table = {TOC_BOOK_ID: by_name(override)} if override else {}
    overrides = toc_overrides.Overrides(path=Path('toc-overrides.json'), table=table)
    _chapters, _rule, fallback = preprocess.build_toc(text, TOC_BOOK_ID, overrides)
    lines = [line for line in capsys.readouterr().out.splitlines() if '[兜底]' in line]
    assert len(lines) <= 1
    return fallback, (lines[0] if lines else '')


@pytest.mark.parametrize(
    'text,gate,other',
    [
        (SPARSE_BOOK, '篇幅门槛否决', '误报门槛'),
        (DENSE_BOOK, '误报门槛否决', '篇幅门槛'),
    ],
    ids=['coverage-floor', 'false-ratio'],
)
def test_no_rule_fallback_names_the_gate_that_excluded_the_candidates(
    capsys: pytest.CaptureFixture[str], text: str, gate: str, other: str
) -> None:
    """择一选不出规则时，日志点名真正挡掉候选的那道门槛，而不是一律归给误报门槛。"""
    fallback, line = toc_log(capsys, text)
    assert fallback is True
    assert gate in line and '标准章节' in line, line
    assert other not in line, line


@pytest.mark.parametrize(
    'text,expected,absent',
    [
        ('第一章 开端\n' + filler(20_000), '只有 1 个标题，不足 2 个', '不像一张目录'),
        (SPARSE_BOOK, '命中 2 个标题，但不像一张目录（篇幅门槛', '不足 2 个'),
    ],
    ids=['fewer-than-two', 'coverage-floor'],
)
def test_whole_book_fallback_tells_too_few_hits_from_not_a_toc(
    capsys: pytest.CaptureFixture[str], text: str, expected: str, absent: str
) -> None:
    """规则已选定、全书却兜底：分清"过滤后不足 2 个标题"与"命中够多但过不了篇幅门槛"。

    用覆盖表点名是为了绕过采样择一——采样是全文的前缀，没有点名的话"采样里有 2 个
    有效章节、全文却不足 2 个"构造不出来；两种兜底走的是 `build_toc` 的同一条分支。
    """
    fallback, line = toc_log(capsys, text, override='标准章节')
    assert fallback is True
    assert '规则 标准章节' in line and expected in line, line
    assert absent not in line, line


# ---------------------------------------------------------------------------
# 9. 源文件删了，书还在；--delete-source（需求 7.5 修订 / 7.12）
# ---------------------------------------------------------------------------

SRC_A = '《测试书甲》作者：某甲.zip'
ID_A = '测试书甲-某甲'


def put_zip(bench: Bench, name: str, text: Optional[str] = None) -> Path:
    """按给定文件名放一本 `.zip`（同名书的几个变体要自己起名）。"""
    path = bench.source_dir / name
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as zf:
        zf.writestr('book.txt', (text if text is not None else novel_text()).encode('utf-8'))
    return path


def gz_bytes(bench: Bench, book_id: str) -> bytes:
    return (bench.books_dir / manifest_mod.gz_name(book_id)).read_bytes()


def archive_everything(bench: Bench) -> None:
    """带 `--delete-source` 跑一遍：之后源目录是空的，书全是归档书。"""
    assert bench.run(delete_source=True) == report_mod.EXIT_OK
    assert bench.sources() == []


def test_delete_source_consumes_each_finished_book(bench: Bench) -> None:
    bench.add('测试书甲', '某甲')
    bench.add('测试书乙', '某乙')

    assert bench.run(delete_source=True) == report_mod.EXIT_OK

    assert bench.sources() == [], '处理一本删一本'
    assert bench.ids() == ['测试书乙-某乙', ID_A]
    for book_id in bench.ids():
        assert (bench.books_dir / manifest_mod.gz_name(book_id)).is_file()
        assert (bench.data_dir / manifest_mod.toc_name(book_id)).is_file()
    assert len(bench.manifest()) == 2

    # 下一轮：源目录空了，书架一本不少
    first = bench.index()
    assert bench.run() == report_mod.EXIT_OK
    assert bench.index()['books'] == first['books']
    rep = bench.rep
    assert rep is not None and rep.n_archived == 2


def test_delete_source_also_consumes_books_done_by_an_earlier_run(bench: Bench) -> None:
    """上一轮已处理好、这一轮被跳过的书同样删——存量源包就是这样腾出来的。"""
    bench.add('测试书甲', '某甲')
    bench.add('测试书乙', '某乙')
    assert bench.run() == report_mod.EXIT_OK
    assert len(bench.sources()) == 2

    assert bench.run(delete_source=True) == report_mod.EXIT_OK

    rep = bench.rep
    assert rep is not None
    assert (rep.n_ok, rep.n_skipped) == (0, 2)
    assert bench.sources() == []


def test_without_the_flag_no_source_is_deleted(bench: Bench) -> None:
    bench.add('测试书甲', '某甲')
    assert bench.run() == report_mod.EXIT_OK
    assert bench.sources() == [SRC_A]


def test_delete_source_keeps_failed_books(bench: Bench) -> None:
    bench.add('测试书甲', '某甲')
    bench.add_broken('坏书', '某丙')

    assert bench.run(delete_source=True) == report_mod.EXIT_BOOK_FAILED
    assert bench.sources() == ['《坏书》作者：某丙.zip']


def test_delete_source_keeps_a_source_whose_gz_is_over_the_limit(
    bench: Bench, monkeypatch: pytest.MonkeyPatch
) -> None:
    """越限的书护栏会让本批失败，而改判重压要用到源包：这本不删。"""
    bench.add('测试书甲', '某甲')
    monkeypatch.setattr(report_mod, 'FILE_MAX_BYTES', 64)

    assert bench.run(delete_source=True) == report_mod.EXIT_GUARD_RAIL
    assert bench.sources() == [SRC_A]
    assert '[保留源文件]' in bench.err()


def test_parse_args_defaults_to_keeping_sources() -> None:
    assert preprocess.parse_args([]).delete_source is False
    assert preprocess.parse_args(['--delete-source']).delete_source is True


def test_archived_book_is_resplit_from_its_gz_after_a_pipeline_bump(
    bench: Bench, capsys: pytest.CaptureFixture[str]
) -> None:
    """源包没了，换版照样生效：从 `.txt.gz` 只重切章节，gz 一个字节不动。"""
    bench.add('测试书甲', '某甲')
    archive_everything(bench)
    first = bench.index()
    first_toc = bench.toc(ID_A)
    gz_before = gz_bytes(bench, ID_A)

    stale_the_manifest(bench)
    toc_path = bench.data_dir / manifest_mod.toc_name(ID_A)
    toc_path.write_text(
        json.dumps({**first_toc, 'tocRule': '旧规则'}, ensure_ascii=False), encoding='utf-8'
    )
    capsys.readouterr()

    assert bench.run() == report_mod.EXIT_OK

    rep = bench.rep
    assert rep is not None
    assert (rep.n_ok, rep.n_archived, rep.n_failed) == (1, 0, 0)
    assert bench.toc(ID_A) == first_toc, '按当前流水线重切，覆盖掉旧的那份'
    assert gz_bytes(bench, ID_A) == gz_before
    assert bench.index()['books'] == first['books']
    entry = bench.manifest().entry_for(SRC_A)
    assert entry is not None
    assert entry.pipeline_version == manifest_mod.PIPELINE_VERSION
    assert entry.compressor == report_mod.GZ9, '压缩器标签沿用清单记录'

    text = capsys.readouterr().out
    assert '按 .txt.gz 重切章节' in text
    assert '[流水线版本变更] 本次有 1 本' in text

    # 重切时盖上了当前版本：再跑一次回到"沿用"
    assert bench.run() == report_mod.EXIT_OK
    assert (bench.rep.n_ok, bench.rep.n_archived) == (0, 1)      # type: ignore[union-attr]


def test_archived_book_with_a_missing_toc_is_resplit(bench: Bench) -> None:
    bench.add('测试书甲', '某甲')
    archive_everything(bench)
    first_toc = bench.toc(ID_A)

    (bench.data_dir / manifest_mod.toc_name(ID_A)).unlink()
    assert bench.run() == report_mod.EXIT_OK

    assert bench.toc(ID_A) == first_toc
    assert bench.ids() == [ID_A]
    assert bench.rep is not None and bench.rep.n_ok == 1


def test_a_gz_that_does_not_match_the_record_is_not_resplit(bench: Bench) -> None:
    """gz 解出的字符数与清单对不上：那不是这本书，失败且不进索引，而不是切一份错的目录。"""
    bench.add('测试书甲', '某甲')
    archive_everything(bench)

    (bench.data_dir / manifest_mod.toc_name(ID_A)).unlink()
    (bench.books_dir / manifest_mod.gz_name(ID_A)).write_bytes(
        gzip.compress(novel_text(CHAPTER_TITLES[:2]).encode('utf-8'))
    )

    assert bench.run() == report_mod.EXIT_BOOK_FAILED
    assert bench.ids() == []
    assert '不是清单描述的那本书' in bench.err()
    assert SRC_A in bench.manifest()


def test_removing_an_archived_book_means_deleting_its_artifacts(bench: Bench) -> None:
    """从书库移除一本书：删掉它的两个产物（源文件早已删掉），清单随之遗忘它。"""
    bench.add('测试书甲', '某甲')
    bench.add('测试书乙', '某乙')
    archive_everything(bench)

    (bench.books_dir / manifest_mod.gz_name(ID_A)).unlink()
    (bench.data_dir / manifest_mod.toc_name(ID_A)).unlink()
    assert bench.run() == report_mod.EXIT_OK

    assert bench.ids() == ['测试书乙-某乙']
    assert SRC_A not in bench.manifest()
    assert '[孤儿产物]' not in bench.err()


def test_archived_book_missing_its_gz_is_left_out_but_remembered(bench: Bench) -> None:
    bench.add('测试书甲', '某甲')
    archive_everything(bench)

    (bench.books_dir / manifest_mod.gz_name(ID_A)).unlink()
    assert bench.run() == report_mod.EXIT_OK

    assert bench.ids() == [], '索引里不许有一本 404 的书'
    assert SRC_A in bench.manifest(), '把源包放回来还能重建'
    assert '[归档书缺正文]' in bench.err()
    assert '[孤儿产物]' not in bench.err(), '已有更具体的告警，不重复报'

    # 源包放回来：按原 id 重建
    bench.add('测试书甲', '某甲')
    assert bench.run() == report_mod.EXIT_OK
    assert bench.ids() == [ID_A]
    assert (bench.books_dir / manifest_mod.gz_name(ID_A)).is_file()


def test_a_new_namesake_never_takes_an_archived_books_id(bench: Bench) -> None:
    """源包已删除的书占着 id：新来的同名书拿后缀，不覆盖它的产物（需求 7.9）。"""
    put_zip(bench, '《同名书》作者：某甲（上册）.zip')
    archive_everything(bench)
    gz_before = gz_bytes(bench, '同名书-某甲')

    put_zip(bench, '《同名书》作者：某甲（下册）.zip', novel_text(CHAPTER_TITLES + ('第六章 新章',)))
    assert bench.run() == report_mod.EXIT_OK

    assert bench.ids() == ['同名书-某甲', '同名书-某甲_2']
    assert gz_bytes(bench, '同名书-某甲') == gz_before, '归档书的产物不许被覆盖'


def test_ids_stay_put_when_a_namesake_sorts_in_front(bench: Bench) -> None:
    """id 一经分配就不变：排在前面新来的同名书，不会让已有的两本换名重建。"""
    put_zip(bench, '《同名书》作者：某甲（下册）.zip')
    put_zip(bench, '《同名书》作者：某甲（中册）.zip')
    assert bench.run() == report_mod.EXIT_OK
    before = {key: entry.book_id for key, entry in bench.manifest().entries.items()}
    assert sorted(before.values()) == ['同名书-某甲', '同名书-某甲_2']

    put_zip(bench, '《同名书》作者：某甲（上册）.zip')      # 文件名排序在最前
    assert bench.run() == report_mod.EXIT_OK

    rep = bench.rep
    assert rep is not None
    assert (rep.n_ok, rep.n_skipped) == (1, 2), '只处理新来的那本'
    after = {key: entry.book_id for key, entry in bench.manifest().entries.items()}
    assert {key: after[key] for key in before} == before
    assert after['《同名书》作者：某甲（上册）.zip'] == '同名书-某甲_3'


def test_renamed_source_keeps_its_id_and_is_not_rebuilt(bench: Bench) -> None:
    """改名 = 摘要相同的新文件：接管旧记录，不重做、也不在书架上多出一本。"""
    src = bench.add('测试书甲', '某甲')
    assert bench.run() == report_mod.EXIT_OK

    renamed = src.with_name('《测试书甲》（精校版）作者：某甲.zip')
    src.rename(renamed)
    assert bench.run() == report_mod.EXIT_OK

    rep = bench.rep
    assert rep is not None
    assert (rep.n_ok, rep.n_skipped, rep.n_archived) == (0, 1, 0)
    assert bench.ids() == [ID_A]
    mf = bench.manifest()
    assert renamed.name in mf and src.name not in mf


def test_losing_the_manifest_is_reported_as_orphans(bench: Bench) -> None:
    """源包已删、清单又丢了：书只能从索引里消失——但必须被点名，不能静默。"""
    bench.add('测试书甲', '某甲')
    bench.add('测试书乙', '某乙')
    archive_everything(bench)

    bench.manifest_path.unlink()
    assert bench.run() == report_mod.EXIT_OK

    assert bench.ids() == []
    text = bench.err()
    assert '[孤儿产物] 2 本' in text
    assert ID_A in text and '测试书乙-某乙' in text


# ---------------------------------------------------------------------------
# 10. 本机覆盖表缺失（test-data-desensitization 需求 3.9）
#
# 部署机上没放 `scripts/toc-overrides.local.json` 是合法状态：照常运行、全部按自动判定，
# 只在开头多打一行提示（需求 3.12）。下面的属性把"照常"钉死：除了那一行，缺失时与表为
# `{}` 时的退出码、两条输出流与全部产物都相同。
# ---------------------------------------------------------------------------

#: Original_Sample：仓库里的原创样本（`scripts/fixtures/*.txt`，切分结果由 test_fixtures.py 钉住）。
SAMPLES_DIR = REPO_ROOT / 'scripts' / 'fixtures'
SAMPLES: Tuple[str, ...] = tuple(sorted(path.name for path in SAMPLES_DIR.glob('*.txt')))

#: 样本放进源目录时的作者。书名取样本文件名去掉扩展名，如 `《standard-cn》作者：某甲.zip`。
SAMPLE_AUTHOR = '某甲'

#: `books.json` 的 `generatedAt` 固定成这个值，两次运行的索引才能逐字节比较。
FIXED_NOW = '2000-01-01T00:00:00Z'


class Outcome(NamedTuple):
    """一次 `preprocess.run` 的可观测结果。`files`：两个产物目录下每个文件的相对路径 → 字节。"""

    code: int
    out: str
    err: str
    files: Dict[str, bytes]


def run_observed(bench: Bench, overrides_path: Path, capsys: pytest.CaptureFixture[str]) -> Outcome:
    """跑一批，收下退出码、stdout、stderr 与全部产物。

    不注入账本（`rep=None`）：账本的逐本记录、汇总与护栏和 `print` 落在同一条 stdout 上，
    行序与命令行运行时一致。`Bench.run()` 把账本的输出收进单独的 `StringIO`，要比较
    stdout 就得拼两份，还丢了先后。
    """
    capsys.readouterr()                           # 丢掉此前的输出
    code = preprocess.run(
        source_dir=bench.source_dir,
        books_dir=bench.books_dir,
        data_dir=bench.data_dir,
        manifest_path=bench.manifest_path,
        overrides_path=overrides_path,
    )
    captured = capsys.readouterr()
    files = {
        path.relative_to(bench.root).as_posix(): path.read_bytes()
        for directory in (bench.books_dir, bench.data_dir)
        if directory.is_dir()
        for path in sorted(directory.rglob('*'))
        if path.is_file()
    }
    return Outcome(code, captured.out, captured.err, files)


def clear_outputs(bench: Bench) -> None:
    """删掉两个产物目录与清单：下一次运行开跑时，产物与清单都不存在，与第一次一样。源目录不动。"""
    for directory in (bench.books_dir, bench.data_dir):
        if directory.exists():
            shutil.rmtree(directory)
    bench.manifest_path.unlink(missing_ok=True)


# Feature: test-data-desensitization, Property 5: 覆盖表缺失等价于空表
# **Validates: Requirements 3.9**
@pytest.mark.parametrize(
    'samples',
    [(name,) for name in SAMPLES] + [SAMPLES],
    ids=[*SAMPLES, 'all-samples'],
)
def test_missing_override_file_equals_an_empty_table(
    bench: Bench,
    samples: Tuple[str, ...],
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """对 Original_Sample 的每个样本、以及全部样本一起：本机覆盖表不存在时，与内容为 `{}`
    时相比，退出码相同，产物的文件名集合与逐文件字节相同（`generatedAt` 固定），stdout
    只多 1 行 `missing_notice`，stderr 相同。

    **Validates: Requirements 3.9**
    """
    assert samples, f'{SAMPLES_DIR} 下没有样本'
    monkeypatch.setattr(preprocess, '_now_iso', lambda: FIXED_NOW)
    for name in samples:
        # 按字节读再解码：`read_text()` 会把样本的 CRLF 翻成 LF，那就不是同一本书了。
        text = (SAMPLES_DIR / name).read_bytes().decode('utf-8')
        bench.add(Path(name).stem, SAMPLE_AUTHOR, text)

    # 两次只差覆盖表：同一个路径，一次不存在、一次写着 `{}`。其余目录也用同一套：stdout
    # 里有临时目录的绝对路径（索引的写出位置、护栏的最大单文件），换一套目录就会多出与
    # 覆盖表无关的差异。所以第一次跑完、收好输出与产物之后，清掉产物与清单（两次的清单
    # 起始都不存在）再跑第二次，比较时不必替换占位符。
    overrides_path = bench.root / 'toc-overrides.local.json'
    assert not overrides_path.exists()
    missing = run_observed(bench, overrides_path, capsys)

    clear_outputs(bench)
    overrides_path.write_text('{}', encoding='utf-8')
    empty = run_observed(bench, overrides_path, capsys)

    assert missing.code == empty.code
    assert sorted(missing.files) == sorted(empty.files)
    for rel in sorted(missing.files):
        assert missing.files[rel] == empty.files[rel], f'{rel} 两次的字节不同'

    # stdout：缺失那次去掉恰好 1 行缺失提示之后，与 `{}` 那次逐行相同。
    notice = toc_overrides.missing_notice(overrides_path)
    lines = missing.out.split('\n')
    assert lines.count(notice) == 1, missing.out
    lines.remove(notice)
    assert lines == empty.out.split('\n')
    assert missing.err == empty.err

    # 两次都真的处理出了每个样本：否则两边都是空索引，"相同"什么也没证明。
    index_rel = (bench.data_dir / preprocess.INDEX_NAME).relative_to(bench.root).as_posix()
    index = json.loads(empty.files[index_rel])
    assert empty.code == report_mod.EXIT_OK, empty.err
    assert index['count'] == len(samples)
    assert index['generatedAt'] == FIXED_NOW


# ---------------------------------------------------------------------------
# 11. 覆盖表在批次开头的两种结局（test-data-desensitization 需求 3.10 / 3.12）
#
# 加载是 `run()` 的第一条语句：早于源目录检查，更早于任何产物目录与清单的创建。
# - 表在却写错：stderr 写明路径与原因，exit 1，磁盘上什么都不留下（3.10）；
# - 表缺失：照常运行，在第 1 本书之前恰好打印 1 行提示，写明期望的绝对路径（3.12）。
# ---------------------------------------------------------------------------

#: `toc_rules.py` 的全部规则名（含默认不启用的）。规则名写错时，报错要逐条列出它们。
RULE_NAMES: Tuple[str, ...] = tuple(rule.name for rule in toc_rules.RULES)


def json_bytes(value: Any) -> bytes:
    """写成 UTF-8 的 JSON，中文不转义：与手写的表是同一种字节。"""
    return json.dumps(value, ensure_ascii=False).encode('utf-8')


#: 需求 3.10 列出的每一种坏表：`(写进覆盖表路径的字节, stderr 里必须出现的片段)`。字节为
#: `None` 时把这个路径建成目录：文件"存在"，读取却必然失败。键都是源目录里那本书的 id。
INVALID_OVERRIDE_TABLES = [
    pytest.param(None, ('读取失败',), id='unreadable'),
    pytest.param(
        f'{{"{ID_A}": "标准章节",}}'.encode('utf-8'),                       # 尾逗号
        ('不是合法 JSON',),
        id='not-json',
    ),
    pytest.param(
        json.dumps({ID_A: '标准章节'}, ensure_ascii=False).encode('gbk'),   # 编辑器按 GBK 另存
        ('不是合法的 UTF-8',),
        id='not-utf8',
    ),
    pytest.param(json_bytes([{ID_A: '标准章节'}]), ('根必须是对象',), id='root-not-object'),
    pytest.param(json_bytes({' ': '标准章节'}), ('键（book_id）是空白',), id='blank-key'),
    pytest.param(
        json_bytes({ID_A: ['标准章节', '顶格短行']}),
        ('值必须是规则名字符串',),
        id='non-string-rule',
    ),
    pytest.param(json_bytes({ID_A: ' '}), ('规则名是空白',), id='blank-rule'),
    pytest.param(
        json_bytes({ID_A: '顶格短句'}),                                     # `顶格短行` 错了一个字
        ('"顶格短句" 不存在', *RULE_NAMES),
        id='unknown-rule',
    ),
]


@pytest.mark.parametrize('content,expected', INVALID_OVERRIDE_TABLES)
def test_invalid_override_file_writes_nothing(
    bench: Bench,
    content: Optional[bytes],
    expected: Tuple[str, ...],
    capsys: pytest.CaptureFixture[str],
) -> None:
    """覆盖表存在却写错：exit 1；stderr 写明表的路径与原因，规则名不存在时另列出全部合法
    规则名；第 1 本书没有开始处理；两个产物目录与清单都不存在（需求 3.10）。

    `Bench` 只建源目录，`public/books`、`public/data` 与清单起始都不存在：所以"都不存在"
    断言的正是 `run()` 没有创建它们，更没有往里写 `.txt.gz`、`_toc.json` 或 `books.json`。
    """
    bench.add('测试书甲', '某甲')
    overrides_path = bench.root / 'toc-overrides.local.json'
    if content is None:
        overrides_path.mkdir()
    else:
        overrides_path.write_bytes(content)
    outputs = (bench.books_dir, bench.data_dir, bench.manifest_path)
    assert not any(path.exists() for path in outputs)

    outcome = run_observed(bench, overrides_path, capsys)

    assert outcome.code == preprocess.EXIT_CONFIG
    assert '[覆盖表错误]' in outcome.err and str(overrides_path) in outcome.err, outcome.err
    for fragment in expected:
        assert fragment in outcome.err, fragment
    assert '[1/' not in outcome.out, outcome.out                       # 第 1 本书没有开始处理
    assert [path for path in outputs if path.exists()] == []


def test_missing_override_file_prints_exactly_one_notice_first(
    bench: Bench,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """本机覆盖表不存在：stdout 恰好 1 行缺失提示，写明期望的绝对路径，且在第 1 本书的
    进度行之前；批次照常跑完（需求 3.12）。

    放两本书：提示若随逐本处理打印，就不止 1 行。覆盖表传相对路径、工作目录切到
    `tmp_path`：提示里得是解析后的绝对路径，即部署者该把文件放过去的位置。
    """
    bench.add('测试书甲', '某甲')
    bench.add('测试书乙', '某乙')
    monkeypatch.chdir(bench.root)
    overrides_path = Path('toc-overrides.local.json')
    expected = str((bench.root / overrides_path).resolve())
    assert not (bench.root / overrides_path).exists()

    outcome = run_observed(bench, overrides_path, capsys)

    assert outcome.code == report_mod.EXIT_OK, outcome.err
    lines = outcome.out.split('\n')
    notices = [i for i, line in enumerate(lines) if '未找到本机覆盖表' in line]
    assert len(notices) == 1, outcome.out
    notice = lines[notices[0]]
    assert expected in notice, notice
    # 整条提示都在这一行里：`missing_notice` 不折行，编排层也没有拆开打印。
    assert notice == toc_overrides.missing_notice(overrides_path)

    # 逐本进度行是 `print(f'\n[{i}/{n}] {源文件名}')`：按 `\n` 拆开后，以 `[1/` 开头的
    # 第一行就是第 1 本书开始处理的位置。
    first_book = [i for i, line in enumerate(lines) if line.startswith('[1/')]
    assert first_book, outcome.out
    assert notices[0] < first_book[0], outcome.out
