# -*- coding: utf-8 -*-
r"""`scripts/lib/manifest.py` 增量清单与失效清理（任务 23，需求 7.3 / 7.4 / 7.5）。

运行（仓库根目录）：`python -m pytest scripts/tests -q`

断言五件事：

1. **摘要**：`sha256_file` 与 `hashlib` 逐字节一致，且分块读取不影响结果。
2. **跳过判定（需求 7.4）**：摘要一致、**流水线版本一致**且产物完整存在才跳过。产物
   被删/写成零字节时必须重跑——只查一半就等于让站点带着 404 的资源上线。
3. **每本即落盘（需求 7.3）**：`update()` 之后立刻用一个**全新的 `load()`** 读回
   （这就是"中途中断"在单测里的形态），已完成的书必须还在；写入是原子的，
   不留临时文件；写不进去时抛 `ManifestError` 而不是沉默。
4. **清理（需求 7.5）**：源已删除的书，`.txt.gz`、`_toc.json` 与条目一起消失。
   连同三条护栏：空源列表拒绝执行、`book_id` 仍被占用时不删文件、删不掉就留条目。
5. **降级**：清单损坏/版本不符/条目字段缺失一律告警 + 重跑，不抛异常——它是可再生
   的缓存，不该把整批构建挡在门外。

6. **流水线版本（`PIPELINE_VERSION`）**：源文件没变、但产出它的切分逻辑变了的书必须
   重跑。清单只认源文件的 SHA-256，所以改了 `toc_rules.py` / `toc.py` 之后 7,681 本
   会被"正确地"全部跳过，静默发布上一版的切分结果——这一组就是那条漏洞的围栏。

另外钉住两条约定：产物命名（`<id>.txt.gz` / `<id>_toc.json`，与
`preprocess.process_book` 一致）与清单位置（不在 `public/` 下，且已 gitignore）。
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Dict, List

import pytest

from scripts.lib import manifest
from scripts.lib.manifest import (
    MANIFEST_VERSION,
    PIPELINE_VERSION,
    Entry,
    Manifest,
    ManifestError,
    gz_name,
    load,
    sha256_file,
    source_key,
    toc_name,
)

REPO_ROOT = Path(__file__).resolve().parents[2]

BOOK_ID = '从零开始-雷云风暴'
SOURCE_NAME = '《从零开始》作者：雷云风暴.rar'

#: 产物的最小可信形态：非空即可（结构层面由 validate.py 把关，任务 24）。
GZ_BYTES = b'\x1f\x8b\x08\x00fake'
TOC_TEXT = '{"id": "x", "chapters": []}'


# ---------------------------------------------------------------------------
# 夹具
# ---------------------------------------------------------------------------


@pytest.fixture
def mf(tmp_path: Path) -> Manifest:
    """一张空清单，产物目录都在 tmp_path 下。"""
    return load(
        tmp_path / '.preprocess-manifest.json',
        tmp_path / 'public' / 'books',
        tmp_path / 'public' / 'data',
    )


def reload(mf: Manifest) -> Manifest:
    """从磁盘重新读一遍——单测里"进程被打断后重跑"就是这个动作。"""
    return load(mf.path, mf.books_dir, mf.data_dir)


def make_source(tmp_path: Path, name: str = SOURCE_NAME, content: bytes = b'rar-bytes') -> Path:
    source_dir = tmp_path / 'zip-novel'
    source_dir.mkdir(parents=True, exist_ok=True)
    path = source_dir / name
    path.write_bytes(content)
    return path


def make_artifacts(
    mf: Manifest,
    book_id: str = BOOK_ID,
    gz: bytes = GZ_BYTES,
    toc: str = TOC_TEXT,
) -> List[Path]:
    gz_path, toc_path = mf.artifacts_for(book_id)
    gz_path.parent.mkdir(parents=True, exist_ok=True)
    toc_path.parent.mkdir(parents=True, exist_ok=True)
    gz_path.write_bytes(gz)
    toc_path.write_text(toc, encoding='utf-8')
    return [gz_path, toc_path]


def meta(book_id: str = BOOK_ID, **extra: Any) -> Dict[str, Any]:
    """`process_book` 返回值的形状（`books.json` 的条目）。"""
    return {
        'id': book_id,
        'title': '从零开始',
        'author': '雷云风暴',
        'charCount': 20532902,
        'totalChapters': 3221,
        'gzSize': 23446528,
        **extra,
    }


def raw_manifest(mf: Manifest) -> Dict[str, Any]:
    return json.loads(mf.path.read_text(encoding='utf-8'))


# ---------------------------------------------------------------------------
# 1. 摘要
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('content', [b'', b'x', b'rar-bytes', '中文源包'.encode('utf-8')])
def test_digest_matches_hashlib(tmp_path: Path, content: bytes):
    path = make_source(tmp_path, content=content)
    assert sha256_file(path) == hashlib.sha256(content).hexdigest()


def test_digest_is_unaffected_by_chunk_size(tmp_path: Path):
    # 分块只是为了不把 22MB 的包整包读进内存，不该影响结果
    content = bytes(range(256)) * 900          # 230 KB，跨多个小分块
    path = make_source(tmp_path, content=content)
    expected = hashlib.sha256(content).hexdigest()
    assert sha256_file(path, chunk_size=7) == expected
    assert sha256_file(path, chunk_size=1 << 20) == expected


def test_digest_changes_with_content(tmp_path: Path):
    path = make_source(tmp_path, content=b'v1')
    first = sha256_file(path)
    path.write_bytes(b'v2')
    assert sha256_file(path) != first


def test_digest_of_missing_file_raises(tmp_path: Path):
    # 编排层的 try/except 把它记成这一本的失败（需求 7.1），不影响其余的书
    with pytest.raises(OSError):
        sha256_file(tmp_path / 'nope.rar')


# ---------------------------------------------------------------------------
# 2. 跳过判定（需求 7.4）
# ---------------------------------------------------------------------------


def test_fresh_book_is_not_skipped(mf: Manifest, tmp_path: Path):
    src = make_source(tmp_path)
    assert len(mf) == 0
    assert mf.unchanged(src, sha256_file(src)) is False
    assert mf.should_skip(src, sha256_file(src)) is False


def test_unchanged_source_with_artifacts_is_skipped(mf: Manifest, tmp_path: Path):
    src = make_source(tmp_path)
    digest = sha256_file(src)
    make_artifacts(mf)
    mf.update(src, digest, meta())

    assert mf.unchanged(src, digest) is True
    assert mf.should_skip(src, digest) is True
    # 重新加载后依然成立：判定不依赖任何进程内状态
    assert reload(mf).should_skip(src, digest) is True


def test_changed_source_is_reprocessed(mf: Manifest, tmp_path: Path):
    src = make_source(tmp_path, content=b'v1')
    make_artifacts(mf)
    mf.update(src, sha256_file(src), meta())

    src.write_bytes(b'v2')                     # 源包换了新版本
    assert mf.unchanged(src, sha256_file(src)) is False
    assert mf.should_skip(src, sha256_file(src)) is False


@pytest.mark.parametrize('victim', [0, 1], ids=['txt.gz', '_toc.json'])
def test_missing_artifact_forces_reprocess(mf: Manifest, tmp_path: Path, victim: int):
    # 只查摘要就会漏掉这种情况：清单说处理过，产物却不在了——站点带着 404 上线
    src = make_source(tmp_path)
    digest = sha256_file(src)
    paths = make_artifacts(mf)
    mf.update(src, digest, meta())

    paths[victim].unlink()
    assert mf.unchanged(src, digest) is True   # 源确实没变
    assert mf.artifacts_exist(BOOK_ID) is False
    assert mf.should_skip(src, digest) is False


@pytest.mark.parametrize('victim', [0, 1], ids=['txt.gz', '_toc.json'])
def test_zero_byte_artifact_forces_reprocess(mf: Manifest, tmp_path: Path, victim: int):
    # 零字节是写入被打断的典型残留：文件在，但毫无用处
    src = make_source(tmp_path)
    digest = sha256_file(src)
    paths = make_artifacts(mf)
    mf.update(src, digest, meta())

    paths[victim].write_bytes(b'')
    assert mf.should_skip(src, digest) is False


def test_artifacts_exist_needs_both(mf: Manifest):
    assert mf.artifacts_exist(BOOK_ID) is False
    make_artifacts(mf)
    assert mf.artifacts_exist(BOOK_ID) is True


def test_source_is_keyed_by_filename_not_path(mf: Manifest, tmp_path: Path):
    # 清单要能跟着仓库搬家、源目录换挂载点后继续有效
    src = make_source(tmp_path)
    digest = sha256_file(src)
    make_artifacts(mf)
    mf.update(src, digest, meta())

    moved = tmp_path / 'elsewhere' / SOURCE_NAME
    assert source_key(moved) == source_key(src) == SOURCE_NAME
    assert mf.should_skip(moved, digest) is True
    assert SOURCE_NAME in mf and moved in mf


def test_entry_records_what_the_summary_needs(mf: Manifest, tmp_path: Path):
    src = make_source(tmp_path)
    entry = mf.update(src, sha256_file(src), meta(compressor='zopfli'))

    assert entry.book_id == BOOK_ID
    assert (entry.char_count, entry.total_chapters, entry.gz_size) == (20532902, 3221, 23446528)
    # 被跳过的书，压缩器只剩清单这一处记录（design §4.9 / 需求 10.7）
    assert entry.compressor == 'zopfli'
    assert entry.processed_at.endswith('Z')
    assert reload(mf).entry_for(src) == entry


def test_compressor_key_is_omitted_when_absent(mf: Manifest, tmp_path: Path):
    mf.update(make_source(tmp_path), 'd', meta())
    assert 'compressor' not in raw_manifest(mf)['books'][SOURCE_NAME]
    assert reload(mf).entry_for(SOURCE_NAME).compressor is None


# ---------------------------------------------------------------------------
# 3. 每本即落盘（需求 7.3）
# ---------------------------------------------------------------------------


def test_update_is_durable_immediately(mf: Manifest, tmp_path: Path):
    # "中途中断不丢已完成成果"在单测里的形态：写一本 → 丢掉内存对象 → 重新加载
    first = make_source(tmp_path, '书甲.zip')
    mf.update(first, sha256_file(first), meta('书甲-某人'))
    assert mf.path.is_file()
    assert reload(mf).entry_for(first).book_id == '书甲-某人'


def test_interrupt_after_two_books_keeps_both(mf: Manifest, tmp_path: Path):
    names = ['书甲.zip', '书乙.zip', '书丙.zip']
    for name in names[:2]:
        src = make_source(tmp_path, name)
        mf.update(src, sha256_file(src), meta(f'{Path(name).stem}-某人'))
    # 第三本处理到一半进程就没了：前两本必须还在，第三本不在
    survivor = reload(mf)
    assert sorted(survivor.entries) == ['书乙.zip', '书甲.zip']
    assert survivor.entry_for(names[2]) is None


def test_update_overwrites_the_previous_record(mf: Manifest, tmp_path: Path):
    src = make_source(tmp_path)
    mf.update(src, 'old-digest', meta())
    mf.update(src, 'new-digest', meta(gzSize=1))
    assert len(mf) == 1
    assert reload(mf).entry_for(src).digest == 'new-digest'


def test_update_without_an_id_raises(mf: Manifest, tmp_path: Path):
    src = make_source(tmp_path)
    for bad in ({}, {'id': ''}, {'id': None}, {'id': 123}):
        with pytest.raises(ManifestError, match='缺少可用的 id'):
            mf.update(src, 'd', bad)
    assert not mf.path.exists(), '写不成的记录不该留下半张清单'


def test_save_leaves_no_temp_files(mf: Manifest, tmp_path: Path):
    for name in ('书甲.zip', '书乙.zip'):
        src = make_source(tmp_path, name)
        mf.update(src, sha256_file(src), meta(f'{Path(name).stem}-某人'))
    leftovers = [p.name for p in mf.path.parent.iterdir() if '.tmp' in p.name]
    assert leftovers == []


def test_unwritable_manifest_raises_instead_of_going_quiet(tmp_path: Path):
    # 需求 7.3 一旦失效就必须出声：沉默会让人以为断点续跑还在保护他
    blocker = tmp_path / 'blocker'
    blocker.write_text('not a directory', encoding='utf-8')
    broken = load(blocker / '.preprocess-manifest.json', tmp_path / 'books', tmp_path / 'data')
    with pytest.raises(ManifestError, match='清单写入失败'):
        broken.update(tmp_path / 'x.zip', 'd', meta())


def test_manifest_file_is_human_readable_and_stable(mf: Manifest, tmp_path: Path):
    for name in ('书乙.zip', '书甲.zip', '书丙.zip'):
        src = make_source(tmp_path, name)
        mf.update(src, sha256_file(src), meta(f'{Path(name).stem}-某人'))

    text = mf.path.read_text(encoding='utf-8')
    raw = json.loads(text)
    assert raw['version'] == MANIFEST_VERSION
    assert list(raw['books']) == sorted(raw['books']), '按键排序，文件可直接 diff'
    assert '书甲' in text, '不转义非 ASCII，否则清单没法看'
    assert text.endswith('\n')


# ---------------------------------------------------------------------------
# 4. 清理（需求 7.5）
# ---------------------------------------------------------------------------


def test_prune_removes_artifacts_and_entry(mf: Manifest, tmp_path: Path):
    gone = make_source(tmp_path, '删掉的书.zip')
    kept = make_source(tmp_path, '留着的书.zip')
    gone_files = make_artifacts(mf, '删掉的书-某人')
    kept_files = make_artifacts(mf, '留着的书-某人')
    mf.update(gone, sha256_file(gone), meta('删掉的书-某人'))
    mf.update(kept, sha256_file(kept), meta('留着的书-某人'))

    gone.unlink()                                   # 源目录里这本被删了
    result = mf.prune([kept])

    assert [item.source_name for item in result.pruned] == ['删掉的书.zip']
    assert set(result.removed_files) == set(gone_files)
    assert not any(path.exists() for path in gone_files)
    assert all(path.exists() for path in kept_files), '活着的那本不许被碰'
    assert sorted(mf.entries) == ['留着的书.zip']
    assert sorted(reload(mf).entries) == ['留着的书.zip'], '条目的移除同样要落盘'
    assert result.warnings == () and result.refused_empty is False


def test_prune_accepts_paths_or_names(mf: Manifest, tmp_path: Path):
    src = make_source(tmp_path)
    make_artifacts(mf)
    mf.update(src, sha256_file(src), meta())
    assert mf.prune([SOURCE_NAME]).pruned == ()
    assert mf.prune([src]).pruned == ()
    assert len(mf) == 1


def test_prune_is_a_no_op_when_nothing_is_dead(mf: Manifest, tmp_path: Path):
    src = make_source(tmp_path)
    make_artifacts(mf)
    mf.update(src, sha256_file(src), meta())

    sentinel = mf.path.read_text(encoding='utf-8') + '\n// 没被重写过\n'
    mf.path.write_text(sentinel, encoding='utf-8')
    result = mf.prune([src])

    assert (result.pruned, result.warnings, result.refused_empty) == ((), (), False)
    assert mf.path.read_text(encoding='utf-8') == sentinel, '无事可做时不该重写文件'


def test_prune_refuses_an_empty_source_list(mf: Manifest, tmp_path: Path):
    # 源目录没挂上/路径写错同样会得到空列表，而那意味着"全库都该删"
    src = make_source(tmp_path)
    files = make_artifacts(mf)
    mf.update(src, sha256_file(src), meta())

    result = mf.prune([])

    assert result.refused_empty is True
    assert result.pruned == ()
    assert all(path.exists() for path in files)
    assert len(mf) == 1 and len(reload(mf)) == 1
    assert '源列表为空' in '\n'.join(result.warnings)


def test_prune_clears_everything_when_explicitly_allowed(mf: Manifest, tmp_path: Path):
    src = make_source(tmp_path)
    files = make_artifacts(mf)
    mf.update(src, sha256_file(src), meta())

    result = mf.prune([], allow_empty=True)

    assert result.refused_empty is False
    assert [item.book_id for item in result.pruned] == [BOOK_ID]
    assert not any(path.exists() for path in files)
    assert len(reload(mf)) == 0


def test_prune_tolerates_already_missing_artifacts(mf: Manifest, tmp_path: Path):
    src = make_source(tmp_path, '早就清干净的书.zip')
    keeper = make_source(tmp_path, '留着的书.zip')
    mf.update(src, sha256_file(src), meta('早就清干净的书-某人'))
    mf.update(keeper, sha256_file(keeper), meta('留着的书-某人'))

    src.unlink()
    result = mf.prune([keeper])

    # 产物早已不存在不是失败，是已经清干净了
    assert [item.removed for item in result.pruned] == [()]
    assert result.kept_for_retry == ()
    assert sorted(mf.entries) == ['留着的书.zip']


def test_prune_keeps_artifacts_claimed_by_a_surviving_source(mf: Manifest, tmp_path: Path):
    # id 冲突消歧（任务 25）之后两个源文件可能指向同一组产物名
    gone = make_source(tmp_path, '同名书-旧包.zip')
    kept = make_source(tmp_path, '同名书-新包.zip')
    files = make_artifacts(mf, '同名书-某人')
    mf.update(gone, sha256_file(gone), meta('同名书-某人'))
    mf.update(kept, sha256_file(kept), meta('同名书-某人'))

    gone.unlink()
    result = mf.prune([kept])

    assert [item.source_name for item in result.pruned] == ['同名书-旧包.zip']
    assert result.removed_files == ()
    assert set(result.pruned[0].kept) == set(files)
    assert all(path.exists() for path in files), '活着的那本的产物不许被带走'
    assert sorted(mf.entries) == ['同名书-新包.zip']
    assert 'book_id' in '\n'.join(result.warnings)


def test_prune_keeps_the_entry_when_deletion_fails(mf: Manifest, tmp_path: Path):
    # 条目一删，那两个文件就再没有任何记录指向它们，永远成为孤儿
    src = make_source(tmp_path)
    keeper = make_source(tmp_path, '留着的书.zip')
    mf.update(src, sha256_file(src), meta())
    mf.update(keeper, sha256_file(keeper), meta('留着的书-某人'))

    gz_path, toc_path = mf.artifacts_for(BOOK_ID)
    gz_path.parent.mkdir(parents=True, exist_ok=True)
    gz_path.write_bytes(GZ_BYTES)
    toc_path.mkdir(parents=True)                      # 删不掉：它是个目录
    (toc_path / 'occupied').write_text('x', encoding='utf-8')

    src.unlink()
    result = mf.prune([keeper])

    assert result.kept_for_retry == (SOURCE_NAME,)
    assert result.pruned == ()
    assert SOURCE_NAME in mf and SOURCE_NAME in reload(mf)
    assert toc_path.exists()
    assert '删不掉' in '\n'.join(result.warnings)


# ---------------------------------------------------------------------------
# 5. 降级：清单是可再生的缓存
# ---------------------------------------------------------------------------


def test_missing_manifest_is_empty_and_silent(tmp_path: Path):
    mf = load(tmp_path / 'nope.json', tmp_path / 'books', tmp_path / 'data')
    assert len(mf) == 0
    assert mf.warnings == [], '首次运行不是异常，不该刷告警'


@pytest.mark.parametrize('text,fragment', [
    ('{ "version": 1, ', '不是合法 JSON'),
    ('[]', '根必须是对象'),
    ('"nope"', '根必须是对象'),
    ('{"version": 1}', '必须是对象'),
    ('{"version": 1, "books": []}', '必须是对象'),
], ids=['truncated', 'list-root', 'str-root', 'no-books', 'books-not-object'])
def test_broken_manifest_degrades_with_a_warning(tmp_path: Path, text: str, fragment: str):
    path = tmp_path / '.preprocess-manifest.json'
    path.write_text(text, encoding='utf-8')
    mf = load(path, tmp_path / 'books', tmp_path / 'data')

    assert len(mf) == 0
    assert fragment in '\n'.join(mf.warnings)
    assert str(path) in '\n'.join(mf.warnings), '告警要指出该看哪个文件'


def test_unknown_version_invalidates_the_whole_table(tmp_path: Path):
    # 这个是**文件格式**版本：不认识就整张表作废。产物形态变了不走这条路，
    # 走 PIPELINE_VERSION（见下面第 7 节）——作废整张表会把 prune 要用的
    # bookId 一起丢掉，源文件已删除的书从此没人清得掉它的产物。
    path = tmp_path / '.preprocess-manifest.json'
    path.write_text(
        json.dumps({'version': MANIFEST_VERSION + 99, 'books': {
            SOURCE_NAME: {'bookId': BOOK_ID, 'digest': 'd'},
        }}),
        encoding='utf-8',
    )
    mf = load(path, tmp_path / 'books', tmp_path / 'data')

    assert len(mf) == 0
    assert '版本不符' in '\n'.join(mf.warnings)
    assert mf.should_skip(SOURCE_NAME, 'd') is False


@pytest.mark.parametrize('bad', [
    {},
    {'digest': 'd'},
    {'bookId': BOOK_ID},
    {'bookId': '', 'digest': 'd'},
    {'bookId': BOOK_ID, 'digest': 123},
    {'bookId': BOOK_ID, 'digest': 'd', 'charCount': 'many'},
    {'bookId': BOOK_ID, 'digest': 'd', 'gzSize': True},
    {'bookId': BOOK_ID, 'digest': 'd', 'compressor': 9},
    {'bookId': BOOK_ID, 'digest': 'd', 'pipelineVersion': 'two'},
    'not-an-object',
], ids=['empty', 'no-id', 'no-digest', 'blank-id', 'digest-type',
        'count-type', 'size-type', 'compressor-type', 'pipeline-type', 'not-object'])
def test_a_broken_entry_only_costs_that_one_book(tmp_path: Path, bad: Any):
    # 降级粒度尽量细：坏一条只重跑那一本，不是全部
    path = tmp_path / '.preprocess-manifest.json'
    path.write_text(
        json.dumps({'version': MANIFEST_VERSION, 'books': {
            '坏掉的书.zip': bad,
            '好的书.zip': {'bookId': '好的书-某人', 'digest': 'ok'},
        }}, ensure_ascii=False),
        encoding='utf-8',
    )
    mf = load(path, tmp_path / 'books', tmp_path / 'data')

    assert sorted(mf.entries) == ['好的书.zip']
    assert mf.unchanged('好的书.zip', 'ok') is True
    assert mf.should_skip('坏掉的书.zip', 'whatever') is False
    assert '坏掉的书.zip' in '\n'.join(mf.warnings)


def test_entry_roundtrips_through_json():
    entry = Entry(
        book_id=BOOK_ID,
        digest='9f2c',
        pipeline_version=PIPELINE_VERSION,
        char_count=20532902,
        total_chapters=3221,
        gz_size=23446528,
        compressor='zopfli',
        processed_at='2026-09-24T11:02:07Z',
    )
    assert Entry.from_json(json.loads(json.dumps(entry.to_json()))) == entry


def test_warnings_go_to_stderr(tmp_path: Path, capsys: pytest.CaptureFixture):
    path = tmp_path / '.preprocess-manifest.json'
    path.write_text('{', encoding='utf-8')
    load(path, tmp_path / 'books', tmp_path / 'data').emit_warnings()
    assert '清单损坏' in capsys.readouterr().err


# ---------------------------------------------------------------------------
# 6. 命名与位置约定
# ---------------------------------------------------------------------------


def test_artifact_names_match_preprocess():
    # 与 preprocess.process_book 写出的名字逐字相同，否则 prune 会删错文件
    assert gz_name(BOOK_ID) == f'{BOOK_ID}.txt.gz'
    assert toc_name(BOOK_ID) == f'{BOOK_ID}_toc.json'


def test_artifact_paths_sit_in_the_output_dirs(mf: Manifest):
    gz_path, toc_path = mf.artifacts_for(BOOK_ID)
    assert gz_path.parent == mf.books_dir
    assert toc_path.parent == mf.data_dir


def test_default_dirs_point_at_the_real_output():
    assert manifest.DEFAULT_BOOKS_DIR == REPO_ROOT / 'public' / 'books'
    assert manifest.DEFAULT_DATA_DIR == REPO_ROOT / 'public' / 'data'


def test_manifest_is_not_a_published_asset():
    # 放进 public/ 会被复制/硬链接进 dist 跟着部署，白占 20000 文件配额（需求 10.1）
    assert manifest.DEFAULT_PATH.parent == REPO_ROOT
    assert 'public' not in manifest.DEFAULT_PATH.parts


def test_manifest_is_gitignored():
    # 它描述的 public/books、public/data 本身也是 gitignore 的本机产物；进版本库会让
    # 新 clone 以为这些书已经处理过
    ignored = (REPO_ROOT / '.gitignore').read_text(encoding='utf-8')
    assert manifest.DEFAULT_PATH.name in ignored


# ---------------------------------------------------------------------------
# 7. 流水线版本（PIPELINE_VERSION）
# ---------------------------------------------------------------------------


def write_raw(mf: Manifest, entries: Dict[str, Any]) -> Manifest:
    """手写一张清单到磁盘再加载——"上一版流水线留下的清单"在单测里的形态。"""
    mf.path.write_text(
        json.dumps({'version': MANIFEST_VERSION, 'books': entries}, ensure_ascii=False),
        encoding='utf-8',
    )
    return reload(mf)


def old_entry(**extra: Any) -> Dict[str, Any]:
    """一条**字段齐全**的旧记录：只有 pipelineVersion 落后一版。"""
    data: Dict[str, Any] = {
        'bookId': BOOK_ID,
        'digest': 'digest-没变',
        'pipelineVersion': PIPELINE_VERSION - 1,
        'charCount': 20532902,
        'totalChapters': 3221,
        'gzSize': 23446528,
        'compressor': 'zopfli',
        'processedAt': '2026-09-24T11:02:07Z',
    }
    data.update(extra)
    return data


def test_update_stamps_the_current_pipeline_version(mf: Manifest, tmp_path: Path):
    src = make_source(tmp_path)
    entry = mf.update(src, sha256_file(src), meta())

    # 版本的唯一真值源是模块常量，不由调用方传进来：写清单的这一刻，产物必然
    # 就是当前这版流水线切出来的。
    assert entry.pipeline_version == PIPELINE_VERSION
    assert raw_manifest(mf)['books'][SOURCE_NAME]['pipelineVersion'] == PIPELINE_VERSION
    assert reload(mf).entry_for(src).pipeline_version == PIPELINE_VERSION


def test_same_digest_and_same_version_is_skipped(mf: Manifest, tmp_path: Path):
    src = make_source(tmp_path)
    digest = sha256_file(src)
    make_artifacts(mf)
    mf.update(src, digest, meta())

    assert mf.should_skip(src, digest) is True
    assert mf.pipeline_stale(src, digest) is False


def test_same_digest_but_a_different_version_is_reprocessed(mf: Manifest):
    """这一组的正题：源文件一个字节都没变，切分逻辑变了 → 必须重跑。"""
    make_artifacts(mf)
    reloaded = write_raw(mf, {SOURCE_NAME: old_entry()})

    assert reloaded.unchanged(SOURCE_NAME, 'digest-没变') is True      # 源确实没变
    assert reloaded.artifacts_exist(BOOK_ID) is True                   # 产物也都在
    assert reloaded.should_skip(SOURCE_NAME, 'digest-没变') is False    # 照样重跑
    assert reloaded.pipeline_stale(SOURCE_NAME, 'digest-没变') is True


def test_a_missing_version_counts_as_stale(mf: Manifest):
    """PIPELINE_VERSION 之前写出的清单里没有这个键：按"旧版"处理，且不许崩。"""
    make_artifacts(mf)
    raw = old_entry()
    del raw['pipelineVersion']
    reloaded = write_raw(mf, {SOURCE_NAME: raw})

    entry = reloaded.entry_for(SOURCE_NAME)
    assert entry is not None and entry.pipeline_version is None
    assert entry.char_count == 20532902, '旧清单的其余字段照旧读得出来'
    assert reloaded.should_skip(SOURCE_NAME, 'digest-没变') is False
    assert reloaded.pipeline_stale(SOURCE_NAME, 'digest-没变') is True


def test_pipeline_stale_is_only_about_the_version(mf: Manifest):
    """源文件真变了、或产物不齐时都不算"版本变更重做"——那些书另有重跑理由，
    算进这个数字只会把"为什么全库在重建"的答案搅浑。"""
    make_artifacts(mf)
    reloaded = write_raw(mf, {SOURCE_NAME: old_entry()})

    assert reloaded.pipeline_stale(SOURCE_NAME, '另一个摘要') is False
    assert reloaded.pipeline_stale('没进过清单的书.zip', 'd') is False

    reloaded.artifacts_for(BOOK_ID)[0].unlink()
    assert reloaded.pipeline_stale(SOURCE_NAME, 'digest-没变') is False


def test_a_version_mismatch_does_not_corrupt_the_other_fields(mf: Manifest, tmp_path: Path):
    """版本不符只影响"要不要跳过"：这条记录的其余字段、以及别的书，一个都不许动。"""
    other = old_entry(bookId='留着的书-某人', digest='d2')
    reloaded = write_raw(mf, {SOURCE_NAME: old_entry(), '留着的书.zip': other})

    kept = reloaded.entry_for('留着的书.zip')
    assert kept is not None
    assert (kept.book_id, kept.char_count, kept.total_chapters, kept.gz_size) == (
        '留着的书-某人', 20532902, 3221, 23446528
    )
    assert (kept.compressor, kept.processed_at) == ('zopfli', '2026-09-24T11:02:07Z')
    assert kept.pipeline_version == PIPELINE_VERSION - 1

    # 重做其中一本：它盖上新版本落盘，另一本连 pipelineVersion 都不许被顺手改掉
    src = make_source(tmp_path)
    make_artifacts(reloaded)
    reloaded.update(src, sha256_file(src), meta())

    raw = raw_manifest(reloaded)
    assert raw['books']['留着的书.zip'] == other
    assert raw['books'][SOURCE_NAME]['pipelineVersion'] == PIPELINE_VERSION
    assert len(reload(reloaded)) == 2


def test_load_warns_once_about_stale_records(tmp_path: Path):
    """整批告示只有**一条**：7,681 本各记一条会把汇总变成"告警 7681 条"，
    真正的信号全被压掉。"""
    path = tmp_path / '.preprocess-manifest.json'
    books: Dict[str, Any] = {
        f'旧书{index}.zip': {
            'bookId': f'旧书{index}-某人',
            'digest': 'd',
            'pipelineVersion': PIPELINE_VERSION - 1,
        }
        for index in range(3)
    }
    books['新书.zip'] = {
        'bookId': '新书-某人', 'digest': 'd', 'pipelineVersion': PIPELINE_VERSION,
    }
    path.write_text(
        json.dumps({'version': MANIFEST_VERSION, 'books': books}, ensure_ascii=False),
        encoding='utf-8',
    )

    mf = load(path, tmp_path / 'books', tmp_path / 'data')

    assert len(mf) == 4, '条目全部保留：prune 还要用它们'
    listed = [line for line in mf.warnings if '流水线版本变更' in line]
    assert len(listed) == 1
    assert '3/4' in listed[0]
    assert str(PIPELINE_VERSION) in listed[0]


def test_load_says_nothing_when_every_record_is_current(mf: Manifest, tmp_path: Path):
    src = make_source(tmp_path)
    mf.update(src, sha256_file(src), meta())
    assert reload(mf).warnings == []


def test_pipeline_version_was_bumped_for_this_change():
    """旧清单里没有这个键（→ 一律重跑），所以任何值都能触发全库重做；这条钉住
    "本次确实 +1 过"，也防止有人把它与 MANIFEST_VERSION 当成同一个数。"""
    assert isinstance(PIPELINE_VERSION, int) and not isinstance(PIPELINE_VERSION, bool)
    assert PIPELINE_VERSION >= 2


def test_pipeline_version_names_the_files_that_must_bump_it():
    """协调靠注释而不是 import（`toc.py` / `toc_rules.py` 反向依赖清单模块是不该有的
    耦合），所以那段注释必须点名这两个文件——否则改那边的人不会知道要回来 +1。"""
    source = (REPO_ROOT / 'scripts' / 'lib' / 'manifest.py').read_text(encoding='utf-8')
    # 只看紧贴赋值上面那段注释：模块 docstring 里也提到这两个文件，那不算
    nearby = '\n'.join(source.split('PIPELINE_VERSION = ')[0].splitlines()[-30:])
    assert 'toc_rules.py' in nearby and 'toc.py' in nearby
