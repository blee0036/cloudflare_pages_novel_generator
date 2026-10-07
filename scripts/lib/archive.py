# -*- coding: utf-8 -*-
"""源文件解压（design §4.1，需求 7.6 / 7.7）。

职责：

- 扫描源目录，接受 `.zip` / `.tar` / `.tar.gz` / `.tgz` / `.7z` / `.rar`
  （修正"目录名叫 `zip-novel` 却只 glob `*.rar`"的缺陷）。
- `.zip` / `.tar` / `.tar.gz` / `.tgz` 走标准库 `zipfile` / `tarfile`；
  `.7z` 走 `py7zr`；`.rar` 调外部工具。
- 解压后返回包里**全部**非空 `.txt`（`extract_txt_members`），连同包内名与体积。
- 依赖或外部工具不可用时抛出指向具体文件与修复建议的异常，
  不做多级回退、不静默降级。

## 只解压 `.txt` 成员

书名/作者来自**压缩包文件名**而非包内名，调用方要的只是正文。所以本模块只取包内
`.txt` 成员，其余（封面图、说明、广告）直接不落盘。

## 一个包里有好几个 `.txt`

旧版只返回体积最大的那个，理由是避开 `readme.txt` / 广告文件。实测全库 7,681 个包里
多 txt 的只有 6 个，没有一个是"正文 + 广告"：要么是分册合集（几册体量相当），要么是
"正文 + 外传/作品相关"。只留最大的那个，合集就只剩一册、续集合订本甚至只剩续集，
而且日志显示"成功"。所以现在全部交给调用方，定顺序、起册名是 `bundle` 模块的事。

zip 里没设 UTF-8 标志位的成员名会被 `zipfile` 按 cp437 解码，中文包里那几乎总是
GBK——排序与册名都要看包内名，所以这里先把它还原（`_zip_member_name`）。

## 路径穿越（zip slip / tar member escape）

`zipfile` / `tarfile` / `py7zr` 都按包内记录的成员名写盘，恶意包可以用
`../../x` 或 `C:\\x` 把文件写到解压根之外。三层防护：

1. `_check_member_name` 拒绝绝对路径、盘符、`..` 分段；
2. `zip`/`tar` 路径**不使用包内名写盘**，一律落到 `_flat_target()` 生成的
   单层安全名（穿越在构造上不可能，顺带绕开 zip 里 GBK 文件名被按 cp437
   解码后产生的非法字符）；
3. `.7z` 与 `.rar` 由第三方库 / 外部工具自己写盘，收集结果时用
   `_collect_txt_files` 逐个确认落在解压根内，并跳过符号链接。

`tarfile` 另外只接受 `isfile()` 成员，硬链接与符号链接成员直接忽略；
本模块不调用 `extractall`，因此不依赖 Python 3.12+ 的 `filter=` 参数
（本机 Python 3.14 有该参数，但流式取成员的写法对更老的版本同样安全）。
"""

from __future__ import annotations

import os
import re
import shutil
import stat
import subprocess
import tarfile
import zipfile
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path, PurePosixPath
from typing import Callable, Dict, List, Optional, Sequence, Tuple

__all__ = [
    'ARCHIVE_EXTENSIONS',
    'ArchiveError',
    'MissingExtractorError',
    'TxtMember',
    'archive_kind',
    'extract_largest_txt',
    'extract_txt_members',
    'is_supported_archive',
    'scan_source_dir',
    'unsupported_in',
]

# 需求 7.6 接受的源文件扩展名。顺序即文档展示顺序，判定见 `archive_kind`。
ARCHIVE_EXTENSIONS: Tuple[str, ...] = ('.zip', '.tar', '.tar.gz', '.tgz', '.7z', '.rar')

#: 解压外部工具的超时（秒）。最大的一本源包 ~22MB，本机 bsdtar 约 2s；
#: 留足余量，但不设为 None——卡死的子进程会让整批预处理无声挂起。
RAR_TIMEOUT_SECONDS = 600

_COPY_BUFFER = 1 << 20

# 生成落盘名时允许保留的字符（`\w` 在 str 模式下已含 CJK）
_SAFE_STEM_CHARS = re.compile(r'[^\w.\-]', re.UNICODE)
_MAX_STEM_LEN = 60

_DRIVE_PREFIX = re.compile(r'^[A-Za-z]:')

#: zip 通用标志位第 11 位：成员名是 UTF-8。没设时 `zipfile` 按 cp437 解码。
_ZIP_UTF8_FLAG = 0x800


@dataclass(frozen=True)
class TxtMember:
    """包里一个非空的 `.txt`，已解压到调用方给的目录里。"""

    name: str
    """包内路径，`/` 分隔。zip 里按 GBK 编码的名字已还原。只用于排序、册名与覆盖表
    匹配，**不用于写盘**（写盘名见模块 docstring"路径穿越"）。"""

    path: Path
    """落盘位置，在 `dest_dir` 之内。"""

    size: int
    """字节数，恒 > 0（空文件不返回）。"""

    @property
    def basename(self) -> str:
        """去掉目录的文件名。`.rar` 解压工具可能套一层以包名命名的目录，比对时看这个。"""
        return PurePosixPath(self.name).name


class ArchiveError(Exception):
    """单个源文件的解压失败。

    语义：**这一本**处理不了（包坏了、包里没有 txt、外部工具报错）。
    编排层应记录原因并继续下一本（需求 7.1）。
    """


class MissingExtractorError(ArchiveError):
    """解压所需的依赖/外部工具缺失。

    语义：**环境**不满足，换一本书也一样失败。编排层不应把它降级成
    "跳过这本"，而应报错退出（需求 7.7）。
    """


# ---------------------------------------------------------------------------
# 源目录扫描（需求 7.6）
# ---------------------------------------------------------------------------


def archive_kind(path: Path) -> Optional[str]:
    """返回 `'zip'` / `'tar'` / `'7z'` / `'rar'`，不认识则 `None`。

    `.tar.gz` 与 `.tgz` 归为 `'tar'`（`tarfile` 的 `r:*` 自动识别压缩层）。
    """
    name = Path(path).name.lower()
    if name.endswith('.tar.gz') or name.endswith('.tgz') or name.endswith('.tar'):
        return 'tar'
    if name.endswith('.zip'):
        return 'zip'
    if name.endswith('.7z'):
        return '7z'
    if name.endswith('.rar'):
        return 'rar'
    return None


def is_supported_archive(path: Path) -> bool:
    """`path` 的扩展名是否在 `ARCHIVE_EXTENSIONS` 内。"""
    return archive_kind(path) is not None


def scan_source_dir(source_dir: Path) -> List[Path]:
    """列出源目录下全部受支持的源文件，按文件名排序。

    排序而非依赖 `glob` 的目录返回顺序，使 `books.json` 的条目顺序在不同
    文件系统上一致。
    """
    source_dir = Path(source_dir)
    if not source_dir.is_dir():
        raise ArchiveError(f'源目录不存在或不是目录：{source_dir}')
    return sorted(
        (p for p in source_dir.iterdir() if p.is_file() and is_supported_archive(p)),
        key=lambda p: p.name,
    )


def unsupported_in(source_dir: Path) -> List[Path]:
    """列出源目录下扩展名不受支持的文件，按文件名排序。

    给编排层用来提示"这些文件被忽略了"——静默忽略正是本任务要消掉的缺陷。
    以 `.` 开头的隐藏文件（`.gitkeep`、`.DS_Store` 等）不是书，不列出。
    """
    source_dir = Path(source_dir)
    if not source_dir.is_dir():
        raise ArchiveError(f'源目录不存在或不是目录：{source_dir}')
    return sorted(
        (
            p
            for p in source_dir.iterdir()
            if p.is_file() and not p.name.startswith('.') and not is_supported_archive(p)
        ),
        key=lambda p: p.name,
    )


# ---------------------------------------------------------------------------
# 成员名安全检查与落盘名生成
# ---------------------------------------------------------------------------


def _is_txt_member(name: str) -> bool:
    return name.lower().endswith('.txt')


def _check_member_name(name: str, archive_path: Path) -> None:
    """拒绝可能逃出解压根的成员名。"""
    normalized = name.replace('\\', '/')
    if not normalized or normalized.strip() in ('', '.', '..'):
        raise ArchiveError(f'压缩包内含非法成员名 {name!r}：{archive_path.name}')
    if normalized.startswith('/') or _DRIVE_PREFIX.match(normalized):
        raise ArchiveError(
            f'压缩包内含绝对路径成员 {name!r}，已拒绝解压：{archive_path.name}'
        )
    if any(part == '..' for part in normalized.split('/')):
        raise ArchiveError(
            f'压缩包内含向上穿越的成员 {name!r}，已拒绝解压：{archive_path.name}'
        )


def _flat_target(dest_dir: Path, index: int, member_name: str) -> Path:
    """把包内成员名折成解压根下的单层安全文件名。"""
    base = PurePosixPath(member_name.replace('\\', '/')).name
    stem, ext = os.path.splitext(base)
    stem = _SAFE_STEM_CHARS.sub('_', stem).strip('._')[:_MAX_STEM_LEN]
    if not stem:
        stem = 'member'
    return dest_dir / f'{index:04d}_{stem}{ext.lower()}'


def _stream_member(src, target: Path) -> None:
    with open(target, 'wb') as dst:
        shutil.copyfileobj(src, dst, _COPY_BUFFER)


def _zip_member_name(info: zipfile.ZipInfo) -> str:
    """还原 zip 成员名（见模块 docstring）。

    没设 UTF-8 标志位时，`zipfile` 把原始字节按 cp437 解码成了 `info.filename`；按 cp437
    编回去就是原始字节，再依次试 UTF-8（有些工具写 UTF-8 却不设标志位）与 GB18030。
    都不成就原样返回——名字只用于排序与展示，认不出来不该让这本书失败。
    """
    name = info.filename
    if info.flag_bits & _ZIP_UTF8_FLAG:
        return name
    try:
        raw = name.encode('cp437')
    except UnicodeEncodeError:
        return name
    for enc in ('utf-8', 'gb18030'):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return name


def _collect_txt_files(root: Path, archive_path: Path) -> List[Tuple[str, Path]]:
    """收集 `root` 下的 `.txt` 普通文件，确认都落在 `root` 内。

    用于 `.7z` / `.rar`——它们由第三方库/外部工具自己写盘，名字不由本模块决定，
    所以包内名就取相对 `root` 的路径。
    """
    root_resolved = root.resolve()
    found: List[Tuple[str, Path]] = []
    for dir_path, dir_names, file_names in os.walk(root, followlinks=False):
        # 不跟随目录符号链接，顺带不去遍历它
        dir_names[:] = [d for d in dir_names if not Path(dir_path, d).is_symlink()]
        for file_name in sorted(file_names):
            path = Path(dir_path, file_name)
            if path.is_symlink() or not path.is_file():
                continue
            if not _is_txt_member(file_name):
                continue
            if not path.resolve().is_relative_to(root_resolved):
                raise ArchiveError(
                    f'解压产物 {path} 逃出了解压目录 {root}，已拒绝使用：{archive_path.name}'
                )
            found.append((path.relative_to(root).as_posix(), path))
    return found


def _listing(root: Path) -> List[str]:
    """`root` 下的相对路径清单，仅用于错误信息。"""
    names: List[str] = []
    for dir_path, _dir_names, file_names in os.walk(root, followlinks=False):
        for file_name in sorted(file_names):
            names.append(str(Path(dir_path, file_name).relative_to(root)))
    return names


def _decode_output(raw: Optional[bytes]) -> str:
    if not raw:
        return ''
    for enc in ('utf-8', 'gb18030'):
        try:
            return raw.decode(enc).strip()
        except UnicodeDecodeError:
            continue
    return raw.decode('utf-8', errors='replace').strip()


# ---------------------------------------------------------------------------
# 各格式解压：返回 ([(txt 包内名, 落盘路径)], 包内成员名清单)
# ---------------------------------------------------------------------------

_Extracted = Tuple[List[Tuple[str, Path]], List[str]]


def _extract_zip(archive_path: Path, dest_dir: Path) -> _Extracted:
    found: List[Tuple[str, Path]] = []
    try:
        with zipfile.ZipFile(archive_path) as zf:
            infos = zf.infolist()
            names = [info.filename for info in infos]
            for index, info in enumerate(infos):
                if info.is_dir() or not _is_txt_member(info.filename):
                    continue
                _check_member_name(info.filename, archive_path)
                if stat.S_ISLNK(info.external_attr >> 16):
                    raise ArchiveError(
                        f'压缩包内 {info.filename!r} 是符号链接，已拒绝解压：{archive_path.name}'
                    )
                target = _flat_target(dest_dir, index, info.filename)
                with zf.open(info) as src:
                    _stream_member(src, target)
                found.append((_zip_member_name(info).replace('\\', '/'), target))
    except (zipfile.BadZipFile, EOFError, OSError) as exc:
        raise ArchiveError(f'解压 .zip 失败：{archive_path.name}（{exc}）') from exc
    return found, names


def _extract_tar(archive_path: Path, dest_dir: Path) -> _Extracted:
    found: List[Tuple[str, Path]] = []
    try:
        with tarfile.open(archive_path, 'r:*') as tf:
            members = tf.getmembers()
            names = [member.name for member in members]
            for index, member in enumerate(members):
                # 只要普通文件：硬链接/符号链接/设备节点一律忽略
                if not member.isfile() or not _is_txt_member(member.name):
                    continue
                _check_member_name(member.name, archive_path)
                src = tf.extractfile(member)
                if src is None:
                    continue
                target = _flat_target(dest_dir, index, member.name)
                with src:
                    _stream_member(src, target)
                found.append((member.name.replace('\\', '/'), target))
    except (tarfile.TarError, EOFError, OSError) as exc:
        raise ArchiveError(f'解压 tar 失败：{archive_path.name}（{exc}）') from exc
    return found, names


def _extract_7z(archive_path: Path, dest_dir: Path) -> _Extracted:
    try:
        import py7zr
        from py7zr import exceptions as py7zr_exceptions
    except ImportError as exc:
        raise MissingExtractorError(
            '\n'.join(
                [
                    f'解压 .7z 需要 py7zr，但它没有安装：{archive_path.name}',
                    '修复：python -m pip install -r scripts/requirements.txt',
                    '预处理不会在依赖缺失时降级或跳过这本书。',
                ]
            )
        ) from exc

    stage = dest_dir / '_7z'
    stage.mkdir(parents=True, exist_ok=True)
    try:
        with py7zr.SevenZipFile(archive_path, mode='r') as zf:
            names = list(zf.getnames())
            for name in names:
                _check_member_name(name, archive_path)
            targets = [name for name in names if _is_txt_member(name)]
            if not targets:
                # py7zr 的 targets=[] 在部分版本上等价于"全取"，必须提前返回
                return [], names
            zf.extract(path=stage, targets=targets)
    except (
        py7zr_exceptions.ArchiveError,
        py7zr_exceptions.PasswordRequired,
        py7zr_exceptions.AbsolutePathError,
        EOFError,
        OSError,
    ) as exc:
        raise ArchiveError(f'解压 .7z 失败：{archive_path.name}（{exc}）') from exc
    return _collect_txt_files(stage, archive_path), names


def _extract_rar(archive_path: Path, dest_dir: Path) -> _Extracted:
    tool = _rar_tool()
    if tool is None:
        raise MissingExtractorError(_rar_missing_message(archive_path))

    stage = dest_dir / '_rar'
    stage.mkdir(parents=True, exist_ok=True)
    argv = tool.argv(archive_path.resolve(), stage.resolve())
    try:
        proc = subprocess.run(argv, capture_output=True, timeout=RAR_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired as exc:
        raise ArchiveError(
            f'解压 .rar 超时（{RAR_TIMEOUT_SECONDS}s）：{archive_path.name}'
            f'（工具 {tool.name}）'
        ) from exc
    except OSError as exc:
        raise ArchiveError(
            f'调用 {tool.name} 解压 .rar 失败：{archive_path.name}（{exc}）'
        ) from exc

    if proc.returncode != 0:
        detail = _decode_output(proc.stderr) or _decode_output(proc.stdout)
        raise ArchiveError(
            '\n'.join(
                [
                    f'解压 .rar 失败：{archive_path}',
                    f'  工具：{tool.name}（{tool.executable}）退出码 {proc.returncode}',
                    f'  输出：{detail or "（无）"}',
                    *([_RAR_FAILURE_HINTS[tool.name]] if tool.name in _RAR_FAILURE_HINTS else []),
                    '  该包可能损坏、加密或用了此工具不支持的 RAR 变体；'
                    '请换一个工具手工确认后再处理。不做多级回退。',
                ]
            )
        )

    return _collect_txt_files(stage, archive_path), _listing(stage)


_EXTRACTORS: Dict[str, Callable[[Path, Path], _Extracted]] = {
    'zip': _extract_zip,
    'tar': _extract_tar,
    '7z': _extract_7z,
    'rar': _extract_rar,
}


# ---------------------------------------------------------------------------
# .rar 外部工具探测（需求 7.7）
# ---------------------------------------------------------------------------


class _RarTool:
    """一个可用的 rar 解压外部工具。"""

    __slots__ = ('name', 'executable', '_build')

    def __init__(
        self,
        name: str,
        executable: str,
        build: Callable[[str, Path, Path], List[str]],
    ) -> None:
        self.name = name
        self.executable = executable
        self._build = build

    def argv(self, archive_path: Path, dest_dir: Path) -> List[str]:
        return self._build(self.executable, archive_path, dest_dir)


#: 候选工具，按"对 RAR 支持度"排序。**探测只做一次**：选中的那个若解压失败就直接
#: 报错，不再换下一个（需求 7.7 的"不做多级回退"）——所以顺序本身就是推荐顺序。
#:
#: - `7z`（p7zip-full + p7zip-rar）排第一，是推荐的工具；`7zz` 是 7-Zip 官方 Linux 版。
#: - `unar` 排最后：实测它在一批 RAR5 包上报 "Attempted to read more data than was
#:   available" 失败，而同一批包用 bsdtar 解出的大小与 CRC32 都和包头记录一致——包是好的，
#:   是它的 RAR5 解码有问题。只在别的工具都没有时才用它。
#: - 不收 `7za`：它是不带插件的独立版，不支持 RAR，选中它只会每本都失败。
#: - Windows 10/11 自带的 tar.exe 是 bsdtar，libarchive 能读 rar/rar5；7-Zip 的安装程序
#:   默认不把 7z.exe 加进 PATH，所以 Windows 上通常选中的是它。
_RAR_CANDIDATES: Sequence[Tuple[str, Callable[[str, Path, Path], List[str]]]] = (
    ('7z', lambda exe, archive, dest: [exe, 'x', '-y', f'-o{dest}', str(archive)]),
    ('7zz', lambda exe, archive, dest: [exe, 'x', '-y', f'-o{dest}', str(archive)]),
    ('unrar', lambda exe, archive, dest: [exe, 'x', '-y', str(archive), str(dest) + os.sep]),
    ('bsdtar', lambda exe, archive, dest: [exe, '-xf', str(archive), '-C', str(dest)]),
    ('tar', lambda exe, archive, dest: [exe, '-xf', str(archive), '-C', str(dest)]),
    (
        'unar',
        lambda exe, archive, dest: [
            exe, '-quiet', '-force-overwrite', '-output-directory', str(dest), str(archive),
        ],
    ),
)

#: 选中的工具解压失败时，按工具名补的一句排查提示。
_RAR_FAILURE_HINTS: Dict[str, str] = {
    '7z': '  p7zip 的 7z 要另装 p7zip-rar 才能解 .rar（Debian 在 non-free、Ubuntu 在 multiverse）；'
          '没装时报 "Can not open the file as archive" 或 "Unsupported Method"。',
    'unar': '  unar 解部分 RAR5 包会失败（"Attempted to read more data than was available"），'
            '包本身多半是好的：装 p7zip-full + p7zip-rar 后重跑，预处理会优先用 7z。',
}


@lru_cache(maxsize=1)
def _rar_tool() -> Optional[_RarTool]:
    """探测一次并缓存结果；没有任何可用工具时返回 `None`。"""
    for name, build in _RAR_CANDIDATES:
        executable = shutil.which(name)
        if executable:
            return _RarTool(name, executable, build)
    return None


def _rar_missing_message(archive_path: Path) -> str:
    probed = ' / '.join(name for name, _ in _RAR_CANDIDATES)
    return '\n'.join(
        [
            f'解压 .rar 需要外部工具，但系统上一个都没找到：{archive_path}',
            f'  已在 PATH 上探测：{probed}',
            '  修复（任选其一，装好后确认在 PATH 上）：',
            '    - Linux（推荐）：apt install p7zip-full p7zip-rar'
            '（p7zip-rar 在 Debian non-free / Ubuntu multiverse）；'
            '或 apt install libarchive-tools（bsdtar）',
            '    - macOS：brew install sevenzip（7zz）',
            '    - Windows：系统自带 C:\\Windows\\System32\\tar.exe（bsdtar）即可；'
            '若缺失可 winget install 7zip.7zip 并把 7z.exe 加进 PATH',
            '  这本书不会被跳过：缺依赖就报错退出，不静默降级、不做多级回退。',
        ]
    )


# ---------------------------------------------------------------------------
# 对外入口
# ---------------------------------------------------------------------------


def extract_txt_members(archive_path: Path, dest_dir: Path) -> List[TxtMember]:
    """解压 `archive_path` 到 `dest_dir`，返回其中**全部**非空 `.txt`，按包内名排序。

    包里只有一个 txt 是常态；多个时怎么排、要不要全收，由调用方（`bundle.plan`）决定，
    本函数不做取舍（见模块 docstring"一个包里有好几个 `.txt`"）。

    Raises:
        MissingExtractorError: 解压该格式所需的依赖或外部工具缺失（环境问题）。
        ArchiveError: 该源文件本身的问题（不受支持、损坏、包内无可用 txt）。
    """
    archive_path = Path(archive_path)
    dest_dir = Path(dest_dir)

    if not archive_path.is_file():
        raise ArchiveError(f'源文件不存在：{archive_path}')

    kind = archive_kind(archive_path)
    if kind is None:
        raise ArchiveError(
            f'不受支持的源文件扩展名：{archive_path.name}'
            f'（接受 {", ".join(ARCHIVE_EXTENSIONS)}）'
        )

    dest_dir.mkdir(parents=True, exist_ok=True)
    found, member_names = _EXTRACTORS[kind](archive_path, dest_dir)

    sized = [TxtMember(name, path, path.stat().st_size) for name, path in found]
    usable = [member for member in sized if member.size > 0]
    if not usable:
        raise ArchiveError(_no_txt_message(archive_path, len(sized), member_names))

    # 同名（不同目录下的同名文件）再按落盘名排，使结果可复现
    usable.sort(key=lambda member: (member.name, member.path.name))
    return usable


def extract_largest_txt(archive_path: Path, dest_dir: Path) -> Path:
    """解压 `archive_path` 到 `dest_dir`，返回其中体积最大的 `.txt`。

    旧接口，预处理已不用它（多 txt 的包会丢册，见模块 docstring）；留给只要"正文那一个"
    的调试脚本。同体积按落盘名取第一个，结果可复现。

    Raises:
        与 `extract_txt_members` 相同。
    """
    members = extract_txt_members(archive_path, dest_dir)
    return min(members, key=lambda member: (-member.size, member.path.name)).path


def _no_txt_message(
    archive_path: Path,
    n_empty: int,
    member_names: Sequence[str],
) -> str:
    if n_empty:
        return (
            f'压缩包内的 .txt 全是空文件，没有可用正文：{archive_path}'
            f'（{n_empty} 个 0 字节 .txt）'
        )
    preview = ', '.join(member_names[:10]) or '（空包）'
    more = f' …共 {len(member_names)} 项' if len(member_names) > 10 else ''
    return (
        f'压缩包内没有 .txt 正文：{archive_path}\n'
        f'  包内成员：{preview}{more}\n'
        '  请确认导出的是 txt 文本而非 epub/mobi/图片。'
    )
