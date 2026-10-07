# -*- coding: utf-8 -*-
r"""`scripts/lib/archive.py` 的 `extract_txt_members`：一个包里有好几个 `.txt`。

运行（仓库根目录）：`python -m pytest scripts/tests -q`

断言三件事：

1. **全部非空 `.txt` 都交出来**，按包内名排序、带体积；空 txt 与非 txt 不交。旧版只交
   最大的那个，合集包因此只剩一册（`extract_largest_txt` 仍按旧语义返回最大的那个）。
2. **zip 里按 GBK 编码、没设 UTF-8 标志位的成员名被还原**：排序与册名都看包内名，
   cp437 解出来的乱码两样都做不对。
3. **tar 同样适用**；包里一个可用 txt 都没有时照旧抛 `ArchiveError`。

`.rar` / `.7z` 走外部工具与第三方库，收集结果的那一段（`_collect_txt_files`）与这里
共用同一个出口，这里不重复造包。
"""

from __future__ import annotations

import io
import sys
import tarfile
import zipfile
from pathlib import Path
from typing import Dict, Iterator, Optional

import pytest

from scripts.lib import archive


def make_zip(path: Path, files: Dict[str, bytes]) -> Path:
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as zf:
        for name, data in files.items():
            zf.writestr(name, data)
    return path


def make_gbk_zip(path: Path, names: Dict[str, bytes]) -> Path:
    """成员名按 GBK 写进 zip、**不设** UTF-8 标志位——国内老工具打的包就是这样。

    `zipfile` 写非 ASCII 名字时一定按 UTF-8 写并设标志位，所以先用同字节长的 ASCII
    占位名写好，再把两处名字（本地头与中心目录）的字节换成 GBK。名字不进 CRC。
    """
    placeholders = {}
    for index, name in enumerate(names):
        raw = name.encode('gbk')
        placeholder = f'{index:0{len(raw)}d}'.encode('ascii')
        assert len(placeholder) == len(raw)
        placeholders[placeholder] = raw
    make_zip(path, {p.decode('ascii'): data for p, data in zip(placeholders, names.values())})
    blob = path.read_bytes()
    for placeholder, raw in placeholders.items():
        assert blob.count(placeholder) == 2
        blob = blob.replace(placeholder, raw)
    path.write_bytes(blob)
    return path


def test_every_non_empty_txt_is_returned_sorted_by_name(tmp_path: Path):
    src = make_zip(tmp_path / 'pack.zip', {
        '青石巷2.txt': '第二册'.encode('utf-8'),
        '青石巷1.txt': '第一册，长一些'.encode('utf-8'),
        '空的.txt': b'',
        'cover.jpg': b'\xff\xd8',
        '合集/青石巷3.TXT': '第三册'.encode('utf-8'),
    })
    members = archive.extract_txt_members(src, tmp_path / 'out')

    assert [m.name for m in members] == ['合集/青石巷3.TXT', '青石巷1.txt', '青石巷2.txt']
    assert [m.basename for m in members] == ['青石巷3.TXT', '青石巷1.txt', '青石巷2.txt']
    for member in members:
        assert member.size == member.path.stat().st_size > 0
        assert member.path.parent == tmp_path / 'out', '落盘仍是单层安全名'
    assert members[1].path.read_bytes() == '第一册，长一些'.encode('utf-8')


def test_largest_txt_keeps_its_old_meaning(tmp_path: Path):
    src = make_zip(tmp_path / 'pack.zip', {'a.txt': b'x' * 10, 'b.txt': b'x' * 30, 'c.txt': b'x'})
    assert archive.extract_largest_txt(src, tmp_path / 'out').read_bytes() == b'x' * 30


def test_gbk_member_names_are_restored(tmp_path: Path):
    src = make_gbk_zip(tmp_path / 'gbk.zip', {
        '青石巷1.txt': b'one',
        '青石巷2.txt': b'two',
    })
    with zipfile.ZipFile(src) as zf:
        raw_names = [info.filename for info in zf.infolist()]
        assert all(not info.flag_bits & 0x800 for info in zf.infolist())
    assert '青石巷1.txt' not in raw_names, 'zipfile 自己按 cp437 解出来的是乱码'

    members = archive.extract_txt_members(src, tmp_path / 'out')
    assert [m.name for m in members] == ['青石巷1.txt', '青石巷2.txt']
    assert [m.path.read_bytes() for m in members] == [b'one', b'two']


def test_utf8_flagged_names_are_left_alone(tmp_path: Path):
    src = make_zip(tmp_path / 'utf8.zip', {'青石巷.txt': b'x', 'readme.txt': b'y'})
    assert [m.name for m in archive.extract_txt_members(src, tmp_path / 'out')] == [
        'readme.txt', '青石巷.txt',
    ]


def test_tar_members(tmp_path: Path):
    src = tmp_path / 'pack.tar.gz'
    with tarfile.open(src, 'w:gz') as tf:
        for name, data in (('青石巷2.txt', b'two'), ('青石巷1.txt', b'one!'), ('空.txt', b'')):
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tf.addfile(info, io.BytesIO(data))
    members = archive.extract_txt_members(src, tmp_path / 'out')
    assert [(m.name, m.size) for m in members] == [('青石巷1.txt', 4), ('青石巷2.txt', 3)]


@pytest.mark.parametrize(
    ('files', 'fragment'),
    [({'a.txt': b'', 'b.txt': b''}, '全是空文件'), ({'a.jpg': b'x'}, '没有 .txt 正文')],
    ids=['all-empty', 'no-txt'],
)
def test_no_usable_txt_still_raises(tmp_path: Path, files: Dict[str, bytes], fragment: str):
    src = make_zip(tmp_path / 'pack.zip', files)
    with pytest.raises(archive.ArchiveError, match=fragment):
        archive.extract_txt_members(src, tmp_path / 'out')


# ---------------------------------------------------------------------------
# .rar 外部工具的探测顺序
#
# 只探测一次、选中就不换（不做多级回退），所以顺序就是推荐顺序：p7zip 的 7z 排第一，
# unar 排最后（它解部分 RAR5 包会失败，同样的包 bsdtar 解得开）。
# ---------------------------------------------------------------------------


@pytest.fixture
def fresh_probe() -> Iterator[None]:
    """探测结果有缓存：前后各清一次，免得测试之间、测试与真实环境之间互相串。"""
    archive._rar_tool.cache_clear()
    yield
    archive._rar_tool.cache_clear()


def test_probe_order_prefers_7z_and_puts_unar_last():
    names = [name for name, _ in archive._RAR_CANDIDATES]
    assert names[0] == '7z'
    assert names[-1] == 'unar'
    assert '7za' not in names, '7za 是不带插件的独立版，解不了 .rar'


@pytest.mark.parametrize(
    ('installed', 'expected'),
    [
        ({'unar', '7z', 'tar'}, '7z'),
        ({'unar', 'bsdtar'}, 'bsdtar'),
        ({'unar', 'tar'}, 'tar'),
        ({'unar'}, 'unar'),
        (set(), None),
    ],
    ids=['7z-over-unar', 'bsdtar-over-unar', 'tar-over-unar', 'unar-only', 'none'],
)
def test_unar_is_used_only_when_nothing_else_is_installed(
    monkeypatch: pytest.MonkeyPatch, fresh_probe: None, installed: set, expected: Optional[str]
):
    monkeypatch.setattr(
        archive.shutil, 'which', lambda name: f'/usr/bin/{name}' if name in installed else None
    )
    tool = archive._rar_tool()
    assert (tool.name if tool else None) == expected


def test_a_7z_failure_points_at_p7zip_rar(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    # p7zip 没装 p7zip-rar 时 7z 解不了 .rar：报错里直接说该装什么
    failing = archive._RarTool('7z', sys.executable, lambda exe, *_: [exe, '-c', 'raise SystemExit(2)'])
    monkeypatch.setattr(archive, '_rar_tool', lambda: failing)
    src = tmp_path / 'pack.rar'
    src.write_bytes(b'Rar!\x1a\x07\x01\x00')

    with pytest.raises(archive.ArchiveError) as excinfo:
        archive.extract_txt_members(src, tmp_path / 'out')
    message = str(excinfo.value)
    assert '退出码 2' in message and 'p7zip-rar' in message


def test_the_missing_tool_message_recommends_p7zip(tmp_path: Path):
    message = archive._rar_missing_message(tmp_path / 'pack.rar')
    assert 'p7zip-full p7zip-rar' in message
    assert '7z / 7zz / unrar / bsdtar / tar / unar' in message
