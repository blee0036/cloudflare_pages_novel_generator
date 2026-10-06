# -*- coding: utf-8 -*-
r"""`scripts/lib/report.py` 批次汇总、容量护栏与 id 消歧（任务 25，
需求 7.1 / 7.2 / 7.9 / 7.11 / 10.1 / 10.2 / 10.7）。

运行（仓库根目录）：`python -m pytest scripts/tests -q`

断言六组事实：

1. **失败不终止批次，但会算进退出码**（需求 7.1 / 7.2）：`fail()` 不抛不退出、
   完整报错当场打全，摘要里每本一行、**不截断列表**；成功/失败/跳过三个数与
   压缩器分布都出现在汇总里。
2. **压缩器逐本记账**（需求 10.7）：成功的书取自 `meta['compressor']`，
   **被跳过的书取自 `manifest.Entry`**——那是它唯一还留存的记录，用真的 `Entry`
   而不是替身来钉住这条跨模块约定。
3. **id 消歧**（需求 7.9）：先到的拿裸 id，之后依次 `_2` / `_3`；`_2` 已被占用时
   继续往后找，不会二次冲突；每次消歧都有告警，绝不静默。
4. **源文件预警**（需求 7.11）：30MB 是不含边界的门槛，刚好 30MB 不报。
5. **护栏**（需求 10.1 / 10.2 / 10.7）：无论是否越限都报出最大单文件与文件总数；
   20–25 MiB 的 gz 只告警；> 25 MiB 指明具体文件并非零退出，且**文案按压缩器分岔**
   ——`zopfli` 是硬失败（指向分片、明说不要重试），`gz9` 是阈值适用性问题（指向改判重压）。
6. **不调 `sys.exit()`**：护栏与汇总都只返回退出码，两者同时不通过时取护栏那一档。
7. **输出本身不许杀掉批次**：stderr 编码不下这些字时降级输出，绝不向外抛
   `UnicodeEncodeError`——`fail()` 是从逐本 `except Exception` **里面**调用的，
   那里抛出去就是剩下几千本一起终止。

大文件用 `truncate` 造稀疏文件（`st_size` 就是要的值），所以"26MB 的产物"这类
断言是真的走了 `stat()`，而不是把阈值 monkeypatch 小。唯一 monkeypatch 的是
20000 文件数上限——造两万个文件的代价换不到任何额外信息。
"""

from __future__ import annotations

import io
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import pytest

from scripts.lib import report as report_mod
from scripts.lib.manifest import Entry
from scripts.lib.report import (
    EXIT_BOOK_FAILED,
    EXIT_GUARD_RAIL,
    EXIT_OK,
    FILE_MAX_BYTES,
    GZ9,
    GZ_WARN_BYTES,
    LARGE_SOURCE_BYTES,
    Report,
    ZOPFLI,
)
from scripts.lib.validate import ValidationError

# 作者占位值（作者未知）。Python 侧的字面量只在 preprocess 写一处，测试一律引用它。
# 导入 preprocess 会顺带跑它顶层的依赖检查——scripts/tests 本来就要求那几个包装好。
from scripts.preprocess import UNKNOWN_AUTHOR

#: 样例书：`scripts/fixtures/standard-cn.txt` 那本原创样本。
BOOK_ID = '青石巷-夜行'
SOURCE_NAME = '《青石巷》作者：夜行.rar'

#: 作者未知的书 id：作者部分取管线写入的占位值。前者的书名取自原创样本，后者是占位书名。
ANON_SAMPLE_ID = f'青石巷-{UNKNOWN_AUTHOR}'
ANON_ID = f'甲-{UNKNOWN_AUTHOR}'


# ---------------------------------------------------------------------------
# 夹具
# ---------------------------------------------------------------------------


@pytest.fixture
def rep(tmp_path: Path) -> Report:
    """一个把两条输出流都收进内存的账本，产物目录在 tmp_path 下。"""
    return Report(
        books_dir=tmp_path / 'public' / 'books',
        data_dir=tmp_path / 'public' / 'data',
        out=io.StringIO(),
        err=io.StringIO(),
    )


def out(rep: Report) -> str:
    return rep.out.getvalue()      # type: ignore[union-attr]


def err(rep: Report) -> str:
    return rep.err.getvalue()      # type: ignore[union-attr]


def meta(book_id: str = BOOK_ID, **extra: Any) -> Dict[str, Any]:
    """`process_book` 返回值的形状（`books.json` 的条目）。"""
    data: Dict[str, Any] = {
        'id': book_id,
        'title': '青石巷',
        'author': '夜行',
        'charCount': 12345678,
        'totalChapters': 2468,
        'gzSize': 13579246,
    }
    data.update(extra)
    return data


def entry(book_id: str = BOOK_ID, compressor: Optional[str] = ZOPFLI, **extra: Any) -> Entry:
    """清单记录——被跳过的书在汇总里唯一的信息来源。"""
    return Entry(
        book_id=book_id,
        digest='d' * 64,
        char_count=extra.get('char_count', 12345678),
        total_chapters=extra.get('total_chapters', 2468),
        gz_size=extra.get('gz_size', 13579246),
        compressor=compressor,
        processed_at='2026-09-24T11:02:07Z',
    )


def sized_file(path: Path, size: int) -> Path:
    """造一个 `st_size == size` 的稀疏文件（不真写 26MB 数据）。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, 'wb') as handle:
        handle.truncate(size)
    return path


def gz_artifact(rep: Report, book_id: str, size: int) -> Path:
    return sized_file(rep.books_dir / f'{book_id}.txt.gz', size)


def toc_artifact(rep: Report, book_id: str, size: int = 512) -> Path:
    return sized_file(rep.data_dir / f'{book_id}_toc.json', size)


# ---------------------------------------------------------------------------
# 1. 逐本记账与批次汇总（需求 7.1 / 7.2）
# ---------------------------------------------------------------------------


def test_summary_reports_three_counts(rep: Report, tmp_path: Path):
    rep.ok('a.rar', meta('甲-作者'))
    rep.ok('b.zip', meta('乙-作者'))
    rep.skipped('c.7z', entry('丙-作者'))
    rep.fail('d.rar', RuntimeError('解压失败'))

    summary = rep.summary()

    assert (summary.n_ok, summary.n_skipped, summary.n_failed, summary.n_total) == (2, 1, 1, 4)
    assert '成功 2 · 跳过 1 · 失败 1' in out(rep)


def test_failure_never_stops_the_batch(rep: Report):
    """需求 7.1：记原因、继续下一本。`fail()` 不抛、不退出。"""
    failure = rep.fail(SOURCE_NAME, ValueError('章节表为空'))

    assert failure.kind == 'ValueError'
    assert failure.reason == '章节表为空'
    # 之后还能继续记账，说明批次没被打断
    rep.ok('next.rar', meta('下一本-作者'))
    assert rep.n_ok == 1 and rep.n_failed == 1
    assert '继续处理下一本' in err(rep)


def test_failed_batch_exits_non_zero(rep: Report):
    """需求 7.1/7.2：单本失败不终止批次，但批次结束要非零退出。"""
    rep.ok('a.rar', meta('甲-作者'))
    assert rep.exit_code == EXIT_OK

    rep.fail('b.rar', RuntimeError('boom'))

    assert rep.summary().exit_code == EXIT_BOOK_FAILED
    assert rep.exit_code == EXIT_BOOK_FAILED


def test_clean_batch_exits_zero(rep: Report):
    rep.ok('a.rar', meta('甲-作者'))
    rep.skipped('b.rar', entry('乙-作者', compressor=GZ9))

    assert rep.summary().exit_code == EXIT_OK
    assert rep.exit_code == EXIT_OK


def test_every_failure_is_listed_in_the_summary(rep: Report):
    """需求 7.2 要的是"逐条"原因：失败列表不截断。"""
    for index in range(15):
        rep.fail(f'bad{index}.rar', RuntimeError(f'第 {index} 号毛病'))

    summary = rep.summary()
    text = '\n'.join(summary.lines)

    assert len(summary.failures) == 15
    for index in range(15):
        assert f'bad{index}.rar' in text
        assert f'第 {index} 号毛病' in text


def test_multiline_error_is_printed_whole_then_summarised_to_one_line(rep: Report):
    """`ValidationError` 一次能报十几行：当场打全，摘要里只留首行。"""
    error = ValidationError('_toc.json（x）未通过自校验（2 处问题）：\n    - 甲\n    - 乙')
    rep.fail(SOURCE_NAME, error)

    # 当场：完整消息逐行都在
    assert '- 甲' in err(rep) and '- 乙' in err(rep)

    lines = rep.summary().lines
    listed = [line for line in lines if SOURCE_NAME in line and 'ValidationError' in line]
    assert len(listed) == 1
    assert '- 甲' not in listed[0]
    assert '未通过自校验' in listed[0]


def test_reason_falls_back_to_the_exception_type_when_there_is_no_message(rep: Report):
    """`str(e)` 可能是空的；类名至少说明了是哪一层坏的。"""
    failure = rep.fail('a.rar', KeyError())

    assert failure.kind == 'KeyError'
    assert failure.reason  # 不能是空串
    assert 'KeyError' in '\n'.join(rep.summary().lines)


def test_warnings_are_emitted_once_and_counted(rep: Report):
    rep.warn('书名里有奇怪字符')
    rep.warn_all(['[卷节点偏长] 甲 chapters[3]', '[字段已废弃] 乙 的 txtPath'])

    assert len(rep.warnings) == 3
    assert err(rep).count('书名里有奇怪字符') == 1
    # 没有方括号标签的消息会被补上，与 manifest/validate 的输出风格一致
    assert '[告警] 书名里有奇怪字符' in err(rep)
    assert '告警 3 条' in '\n'.join(rep.summary().lines)


# ---------------------------------------------------------------------------
# 2. 压缩器逐本记账（需求 10.7）
# ---------------------------------------------------------------------------


def test_compressor_is_recorded_per_book_and_summarised(rep: Report):
    rep.ok('a.rar', meta('甲-作者', compressor=GZ9))
    rep.ok('b.rar', meta('乙-作者', compressor=GZ9))
    rep.ok('c.rar', meta('丙-作者', title='测试书丙', compressor=ZOPFLI))

    summary = rep.summary()
    text = '\n'.join(summary.lines)

    assert summary.compressors == {GZ9: 2, ZOPFLI: 1}
    assert f'{GZ9} 2 本' in text and f'{ZOPFLI} 1 本' in text
    # zopfli 的书按分布只有个位数，逐本列出来：它们就是最贴近上限的那几本
    assert '《测试书丙》' in text


def test_skipped_books_take_their_compressor_from_the_manifest(rep: Report):
    """被跳过的书，清单是"当初用的是 gz9 还是 zopfli"唯一还留存的记录。"""
    rep.skipped(SOURCE_NAME, entry(BOOK_ID, compressor=ZOPFLI))

    book = rep.books[0]
    assert book.skipped is True
    assert (book.book_id, book.compressor, book.gz_size) == (BOOK_ID, ZOPFLI, 13579246)
    assert rep.compressor_counts() == {ZOPFLI: 1}
    assert '（本次跳过）' in '\n'.join(rep.summary().lines)


def test_missing_compressor_is_visible_not_silent(rep: Report):
    rep.ok('a.rar', meta('甲-作者'))          # 没有 compressor 键
    assert rep.compressor_counts() == {'未记录': 1}
    assert '压缩器未记录' in out(rep)


def test_skipped_without_manifest_entry_still_counts(rep: Report):
    """`report.skipped(src)` 的退化用法（design §4.9 的原始签名）不能炸。"""
    rep.skipped(SOURCE_NAME)
    assert rep.n_skipped == 1
    assert rep.books[0].book_id == ''


# ---------------------------------------------------------------------------
# 3. book_id 消歧（需求 7.9）
# ---------------------------------------------------------------------------


def test_conflicting_ids_get_numeric_suffixes(rep: Report):
    first = rep.unique_id(ANON_SAMPLE_ID, 'a.rar')
    second = rep.unique_id(ANON_SAMPLE_ID, 'b.rar')
    third = rep.unique_id(ANON_SAMPLE_ID, 'c.rar')

    assert (first, second, third) == (ANON_SAMPLE_ID, f'{ANON_SAMPLE_ID}_2', f'{ANON_SAMPLE_ID}_3')


def test_disambiguation_always_warns(rep: Report):
    """需求 7.9：告警，不静默覆盖。"""
    rep.unique_id(ANON_SAMPLE_ID, 'a.rar')
    assert rep.warnings == []

    rep.unique_id(ANON_SAMPLE_ID, 'b.rar')

    assert len(rep.warnings) == 1
    text = rep.warnings[0]
    assert '[id 冲突]' in text
    assert 'a.rar' in text and 'b.rar' in text
    assert f'{ANON_SAMPLE_ID}_2' in text


def test_suffix_never_collides_with_an_existing_id(rep: Report):
    """`_2` 本身就是一本书的 id 时，消歧必须继续往后找。"""
    rep.unique_id(ANON_ID, 'a.rar')
    rep.unique_id(f'{ANON_ID}_2', 'b.rar')       # 源文件名恰好推出了这个 id

    assert rep.unique_id(ANON_ID, 'c.rar') == f'{ANON_ID}_3'
    assert sorted(rep.claimed) == [ANON_ID, f'{ANON_ID}_2', f'{ANON_ID}_3']


def test_unique_id_works_without_a_source(rep: Report):
    rep.unique_id(ANON_ID)
    assert rep.unique_id(ANON_ID) == f'{ANON_ID}_2'


def test_claim_keeps_a_recorded_id_as_is_and_quietly(rep: Report):
    """清单里已分配的 id 原样占住：不加后缀、不告警（report.py"一经分配就不变"）。"""
    assert rep.claim(f'{ANON_ID}_2', 'b.rar') is True
    assert rep.claim(f'{ANON_ID}_2', 'b.rar') is True, '同一个源文件再占一次不算冲突'
    assert rep.warnings == []
    # 裸 id 空着，新来的书拿裸 id；`_2` 被占着，再下一本跳到 `_3`
    assert rep.unique_id(ANON_ID, 'a.rar') == ANON_ID
    assert rep.unique_id(ANON_ID, 'c.rar') == f'{ANON_ID}_3'


def test_claim_refuses_an_id_held_by_another_source(rep: Report):
    rep.claim(ANON_ID, 'old.rar')
    assert rep.claim(ANON_ID, 'new.rar') is False
    assert rep.claimed[ANON_ID] == 'old.rar'


def test_a_new_book_never_takes_an_archived_books_id(rep: Report):
    """源包已删除的书占着裸 id 时，新来的同名书只能拿后缀——否则会覆盖它的产物。"""
    rep.claim('同名书-某甲', '《同名书》作者：某甲（上册）.zip')
    assert rep.unique_id('同名书-某甲', '《同名书》作者：某甲（下册）.zip') == '同名书-某甲_2'
    assert '上册' in rep.warnings[0], '告警指出是被谁占着'


def test_archived_books_have_their_own_count(rep: Report):
    """归档书（源文件已不在）不算"跳过"，也不逐本输出，但进汇总与护栏的账。"""
    rep.ok('a.rar', meta('甲-作者'))
    rep.skipped('b.rar', entry('乙-作者'))
    before = out(rep)
    rep.archived('c.rar', entry('丙-作者', compressor=GZ9))
    assert out(rep) == before, '归档书不逐本输出'

    summary = rep.summary()

    assert (summary.n_ok, summary.n_skipped, summary.n_archived, summary.n_failed) == (1, 1, 1, 0)
    assert summary.n_total == 3
    assert '成功 1 · 跳过 1 · 归档 1 · 失败 0' in out(rep)
    assert rep.books[-1].archived and rep.books[-1].compressor == GZ9


def test_summary_header_is_unchanged_without_archived_books(rep: Report):
    rep.ok('a.rar', meta('甲-作者'))
    rep.summary()
    assert '成功 1 · 跳过 0 · 失败 0' in out(rep)
    assert '归档' not in out(rep)


# ---------------------------------------------------------------------------
# 4. 源文件预警（需求 7.11）
# ---------------------------------------------------------------------------


def test_large_source_warns(rep: Report, tmp_path: Path):
    src = sized_file(tmp_path / 'zip-novel' / '体积偏大的源包.rar', LARGE_SOURCE_BYTES + 1)

    warning = rep.check_source(src)

    assert warning is not None
    assert '体积偏大的源包.rar' in warning
    assert '30.00 MB' in warning
    assert rep.warnings == [warning]


def test_thirty_megabytes_exactly_is_not_a_warning(rep: Report, tmp_path: Path):
    src = sized_file(tmp_path / 'zip-novel' / 'just-under.rar', LARGE_SOURCE_BYTES)

    assert rep.check_source(src) is None
    assert rep.warnings == []


def test_unreadable_source_is_not_this_modules_business(rep: Report, tmp_path: Path):
    assert rep.check_source(tmp_path / 'nope.rar') is None
    assert rep.warnings == []


# ---------------------------------------------------------------------------
# 5. 容量护栏（需求 10.1 / 10.2 / 10.7）
# ---------------------------------------------------------------------------


def test_guard_rails_reports_scale_even_when_everything_is_fine(rep: Report):
    """需求 10.1 的前半句：报告最大单文件与总文件数。"""
    rep.ok('a.rar', meta('甲-作者', compressor=GZ9))
    gz_artifact(rep, '甲-作者', 5 * 1024 * 1024)
    toc_artifact(rep, '甲-作者')
    sized_file(rep.data_dir / 'books.json', 1024)

    guard = rep.guard_rails()

    assert guard.ok is True
    assert guard.exit_code == EXIT_OK
    assert guard.file_count == 3               # gz + toc + books.json
    assert guard.largest is not None
    assert guard.largest.path.name == '甲-作者.txt.gz'
    assert guard.largest.compressor == GZ9
    assert '最大单文件' in out(rep)


def test_gz_over_twenty_megabytes_only_warns(rep: Report):
    """需求 10.2：接近上限是告警，不是失败。"""
    rep.ok(SOURCE_NAME, meta(BOOK_ID, compressor=GZ9))
    gz_artifact(rep, BOOK_ID, GZ_WARN_BYTES + 1)

    guard = rep.guard_rails()

    assert guard.exit_code == EXIT_OK
    assert [item.path.name for item in guard.near_limit] == [f'{BOOK_ID}.txt.gz']
    text = '\n'.join(guard.lines)
    assert '[接近上限]' in text
    # gz9 的书还有换 zopfli 这一档余量
    assert ZOPFLI in text


def test_near_limit_zopfli_book_is_told_it_has_no_headroom_left(rep: Report):
    rep.ok(SOURCE_NAME, meta(BOOK_ID, compressor=ZOPFLI))
    gz_artifact(rep, BOOK_ID, FILE_MAX_BYTES - 1)

    guard = rep.guard_rails()
    text = '\n'.join(guard.lines)

    assert guard.exit_code == EXIT_OK
    assert '分片' in text
    assert '8%' in text


def test_twenty_megabytes_exactly_is_not_near_limit(rep: Report):
    rep.ok(SOURCE_NAME, meta(BOOK_ID, compressor=GZ9))
    gz_artifact(rep, BOOK_ID, GZ_WARN_BYTES)

    assert rep.guard_rails().near_limit == ()


def test_oversize_file_fails_and_names_the_file(rep: Report):
    """需求 10.1：非零退出并指明具体文件。"""
    rep.ok(SOURCE_NAME, meta(BOOK_ID, compressor=ZOPFLI))
    path = gz_artifact(rep, BOOK_ID, FILE_MAX_BYTES + 1)

    guard = rep.guard_rails()

    assert guard.ok is False
    assert guard.exit_code == EXIT_GUARD_RAIL
    assert [item.path for item in guard.oversize] == [path]
    assert path.name in '\n'.join(guard.lines)
    # 越限的文件不再重复算一条"接近上限"告警
    assert guard.near_limit == ()


def test_oversize_after_zopfli_is_a_hard_failure(rep: Report):
    """需求 10.7：已用 zopfli 仍越限 —— 没有下一档，报错直指分片，不提重试调参。"""
    rep.ok(SOURCE_NAME, meta(BOOK_ID, compressor=ZOPFLI))
    gz_artifact(rep, BOOK_ID, FILE_MAX_BYTES + 1)

    text = '\n'.join(rep.guard_rails().lines)

    assert ZOPFLI in text
    assert '硬失败' in text
    assert '分片' in text
    assert '不要重试' in text
    # 不能建议"改判 zopfli 重压"——它已经是 zopfli 了
    assert '改判' not in text


def test_oversize_with_gz9_points_at_recompressing_with_zopfli(rep: Report):
    """需求 10.7：gz9 就越限属阈值适用性问题，按源包阈值改判 zopfli 重压。"""
    rep.ok(SOURCE_NAME, meta(BOOK_ID, compressor=GZ9))
    gz_artifact(rep, BOOK_ID, FILE_MAX_BYTES + 1)

    guard = rep.guard_rails()
    text = '\n'.join(guard.lines)

    assert guard.exit_code == EXIT_GUARD_RAIL
    assert '改判' in text and ZOPFLI in text
    assert '不是硬失败' in text
    assert '分片' not in text


def test_leftover_artifact_is_still_checked(rep: Report):
    """本批没处理过的文件同样占配额、同样会让部署失败——护栏量的是磁盘。"""
    stale = gz_artifact(rep, f'上次构建的残留-{UNKNOWN_AUTHOR}', FILE_MAX_BYTES + 1)

    guard = rep.guard_rails()

    assert [item.path for item in guard.oversize] == [stale]
    assert guard.oversize[0].compressor is None
    assert '压缩器未记录' in '\n'.join(guard.lines)


def test_too_many_files_fails(rep: Report, monkeypatch: pytest.MonkeyPatch):
    """需求 10.1：总文件数越限同样非零退出。上限 monkeypatch 到 2，理由见模块 docstring。"""
    monkeypatch.setattr(report_mod, 'FILE_COUNT_MAX', 2)
    for name in ('甲-作者', '乙-作者'):
        gz_artifact(rep, name, 1024)
        toc_artifact(rep, name)

    guard = rep.guard_rails()

    assert guard.file_count == 4
    assert guard.count_exceeded is True
    assert guard.exit_code == EXIT_GUARD_RAIL
    assert '产物文件数' in '\n'.join(guard.lines)


def test_extra_files_count_towards_the_limit(rep: Report, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(report_mod, 'FILE_COUNT_MAX', 3)
    gz_artifact(rep, '甲-作者', 1024)
    toc_artifact(rep, '甲-作者')

    assert rep.guard_rails(extra_files=1).count_exceeded is False
    assert rep.guard_rails(extra_files=2).count_exceeded is True


def test_missing_artifact_dirs_warn_instead_of_crashing(rep: Report):
    guard = rep.guard_rails()

    assert guard.file_count == 0
    assert guard.largest is None
    assert guard.exit_code == EXIT_OK
    assert '产物目录不存在' in '\n'.join(guard.lines)


# ---------------------------------------------------------------------------
# 6. 退出码的合成（不调 sys.exit）
# ---------------------------------------------------------------------------


def test_guard_rail_outranks_book_failures(rep: Report):
    """两者同时不通过时取护栏那一档：失败的书重跑就好，越限的产物根本上不去。"""
    rep.ok(SOURCE_NAME, meta(BOOK_ID, compressor=ZOPFLI))
    rep.fail('bad.rar', RuntimeError('boom'))
    gz_artifact(rep, BOOK_ID, FILE_MAX_BYTES + 1)

    assert rep.summary().exit_code == EXIT_BOOK_FAILED
    rep.guard_rails()
    assert rep.exit_code == EXIT_GUARD_RAIL


def test_guard_rails_does_not_exit_the_process(rep: Report):
    """护栏只返回退出码——否则单测只能靠 `pytest.raises(SystemExit)` 反推。"""
    gz_artifact(rep, BOOK_ID, FILE_MAX_BYTES + 1)

    guard = rep.guard_rails()          # 没有 SystemExit

    assert guard.exit_code == EXIT_GUARD_RAIL
    assert rep.guard is guard


# ---------------------------------------------------------------------------
# 7. 输出本身不许杀掉批次（编码降级）
# ---------------------------------------------------------------------------


class PickyStream:
    """`write` 遇到目标编码表示不了的字符就抛 `UnicodeEncodeError` 的流。

    stock Windows 控制台（cp936）的替身。真实的 `TextIOWrapper` 也正是在 `write`
    这一步抛，抛的时候缓冲区里一个字节都没写进去——所以降级重写一遍是安全的。
    """

    def __init__(self, encoding: str = 'ascii') -> None:
        self.encoding = encoding
        self.chunks: List[str] = []

    def write(self, text: str) -> int:
        text.encode(self.encoding)        # 表示不了就抛，与 TextIOWrapper 一致
        self.chunks.append(text)
        return len(text)

    def flush(self) -> None:
        pass

    def getvalue(self) -> str:
        return ''.join(self.chunks)


def picky_report(tmp_path: Path, encoding: str = 'ascii') -> Tuple[Report, PickyStream]:
    """一个 stderr 挑编码的账本。stdout 照旧收进内存——本节只关心 stderr。"""
    stream = PickyStream(encoding)
    rep = Report(
        books_dir=tmp_path / 'public' / 'books',
        data_dir=tmp_path / 'public' / 'data',
        out=io.StringIO(),
        err=stream,                       # type: ignore[arg-type]
    )
    return rep, stream


def test_fail_survives_a_console_that_cannot_encode(tmp_path: Path):
    """cp936 控制台下 `fail()` 必须不抛，否则这一本的 `except` 里飞出的编码错误会
    把剩下几千本一起带走（需求 7.1 的三层容错就是为了不让这种事发生）。"""
    rep, stream = picky_report(tmp_path)

    failure = rep.fail(SOURCE_NAME, RuntimeError('解压失败：这本书的名字超出了编码范围'))

    assert failure.kind == 'RuntimeError'
    # 批次还能继续记账 —— "不终止"在单测里就是这个形态
    rep.ok('next.rar', meta('下一本-作者'))
    assert (rep.n_ok, rep.n_failed) == (1, 1)

    text = stream.getvalue()
    assert text, '降级输出不该是空的：静默丢掉告警等于没有这道防线'
    # 纯 ASCII 的流：整行都转义了，但仍然认得出是哪一本、哪一层坏的
    assert SOURCE_NAME.encode('ascii', 'backslashreplace').decode('ascii') in text
    assert 'RuntimeError' in text and '.rar' in text


def test_gbk_console_escapes_only_what_gbk_cannot_hold(tmp_path: Path):
    r"""降级按流**自己的**编码做：cp936 下汉字照旧是汉字，只有 `❌` 变成 `\u274c`。

    顺带记下这道防线为什么非有不可：`fail()` 行首那个 "❌"（U+274C）本身就不在 GBK
    里，所以在 stock cp936 控制台上，触发条件不是"某本书的书名里恰好有 GBK 编不了的字"，而是
    "第一本失败的书"。
    """
    rep, stream = picky_report(tmp_path, encoding='cp936')

    rep.fail(SOURCE_NAME, RuntimeError('解压失败'))

    text = stream.getvalue()
    assert SOURCE_NAME in text, 'GBK 表示得了的字不该被逃成 \\uXXXX'
    assert '解压失败' in text
    assert '\\u274c' in text and '❌' not in text


def test_warnings_survive_an_unprintable_console(tmp_path: Path):
    rep, stream = picky_report(tmp_path)

    rep.warn('书名里有奇怪字符')
    rep.warn_all(['[卷节点偏长] 甲 chapters[3]'])

    assert len(rep.warnings) == 2, '记账与能不能打出来是两件事'
    assert stream.getvalue()


def test_summary_and_guard_rails_survive_it_too(tmp_path: Path):
    """告警与越限也走 stderr：护栏那几行同样不许在 cp936 上把批次带走。"""
    rep, stream = picky_report(tmp_path)
    rep.ok(SOURCE_NAME, meta(BOOK_ID, compressor=ZOPFLI))
    rep.fail('坏书.rar', RuntimeError('boom'))
    gz_artifact(rep, BOOK_ID, FILE_MAX_BYTES + 1)

    summary = rep.summary()
    guard = rep.guard_rails()

    assert summary.exit_code == EXIT_BOOK_FAILED
    assert guard.exit_code == EXIT_GUARD_RAIL      # 判定照旧准确
    assert stream.getvalue()


def test_a_real_strict_ascii_stream_does_not_raise(tmp_path: Path):
    """不靠替身也成立：真的 `TextIOWrapper(encoding='ascii')` 同样不炸。"""
    raw = io.BytesIO()
    stream = io.TextIOWrapper(raw, encoding='ascii', errors='strict', newline='\n')
    rep = Report(
        books_dir=tmp_path / 'books',
        data_dir=tmp_path / 'data',
        out=io.StringIO(),
        err=stream,
    )

    rep.fail(SOURCE_NAME, ValueError('章节表为空'))

    assert b'ValueError' in raw.getvalue()


def test_a_stream_that_refuses_everything_still_lets_the_batch_go_on(tmp_path: Path):
    """连降级都写不出去时就丢掉这一行——这是最后一格，批次仍然继续。"""

    class DeadStream:
        encoding = 'ascii'

        def write(self, text: str) -> int:
            raise UnicodeEncodeError('ascii', text or ' ', 0, 1, '什么都写不出去')

        def flush(self) -> None:
            raise OSError('流已经坏了')

    rep = Report(
        books_dir=tmp_path / 'books',
        data_dir=tmp_path / 'data',
        out=io.StringIO(),
        err=DeadStream(),                 # type: ignore[arg-type]
    )

    rep.fail(SOURCE_NAME, RuntimeError('boom'))
    rep.warn('打不出来的告警')

    assert rep.n_failed == 1
    assert rep.exit_code == EXIT_BOOK_FAILED


@pytest.mark.parametrize(
    'encoding', [None, '', 'no-such-codec', 123], ids=['absent', 'blank', 'bogus', 'not-a-str']
)
def test_degrade_falls_back_to_pure_ascii(encoding: Any):
    r"""流没有可用编码时退到纯 ASCII：`io.StringIO.encoding` 就是 `None`，而写死
    编码的管道给出的名字未必查得到。纯 ASCII 是任何编码都收得下的那一档。"""

    class Stream:
        pass

    stream = Stream()
    if encoding is not None:
        stream.encoding = encoding        # type: ignore[attr-defined]

    degraded = report_mod._degrade('《坏书》 ❌', stream)      # type: ignore[arg-type]

    degraded.encode('ascii')              # 不抛即证明"任何编码都收得下"
    assert '\\u274c' in degraded and '\\u574f' in degraded
