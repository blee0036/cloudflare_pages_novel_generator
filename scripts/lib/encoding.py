# -*- coding: utf-8 -*-
"""编码规范化（design §4.2，需求 7.8）。

职责：管线里唯一的"字节 → 文本"出口，统一返回去除 BOM 的 UTF-8 `str`。
`decode()` 之后，管线中不再存在第二种文本形态。

流程与旧写法的三处差异（design §4.2）：

1. **BOM 优先嗅探** UTF-8、UTF-16 LE/BE、UTF-32 LE/BE——零歧义信号，旧写法完全没做。
2. **判定不只看前 32KB。**探测用跨全文的多点采样；**校验用全文 `errors="strict"`
   解码**——解不过就换下一个候选。旧写法拿前 32KB 猜一个编码，然后无条件
   `errors="replace"` 读全文："解得出来但满屏乱码"在日志里看不出任何异常。
3. **`is_plausible`**：替换字符占比 < 1%，且（CJK 占比 > 10% 或 ASCII 可见字符
   占比 > 80%）。回收旧版 `isValidDecoding` 的思路。

全部候选都不可信时才退回"最佳猜测 + `errors="replace"`"，并**记录告警**
（`DecodeResult.lossy` 为真、编码标签带 `(replace)` 后缀、`emit_warnings()`
往 stderr 打印替换字符个数）。这条路径存在，但它不再是静默的默认路径。

## 候选顺序为什么把 `utf-8` 钉在最前

GB18030 几乎能把任意字节流"成功"解出中文样的乱码，而长篇中文文本被误当
UTF-8 时几乎必然在头几百字节就撞上非法续字节。所以先试 `utf-8`：它的 strict
解码本身就是一个近乎零误判的判别器。反过来（先试探测结果）会让 UTF-8 的书有
概率被 GB18030 抢走并通过 `is_plausible`——乱码也是 CJK。

同理，密集型编码之间（GB18030 / Big5）无法靠 strict 解码互相否决，只能靠
探测结果排序。这是本方案的已知边界：探测把 Big5 认成 GB18030 时，产物是
CJK 乱码而非解码失败。需求 8.11 的度量工具是这类问题的观测手段。

注意：模块名 `encoding` 只在本包内生效（`scripts.lib.encoding`），
不会遮蔽标准库的 `encodings` 包与 `codecs` 查找机制。
"""

from __future__ import annotations

import codecs
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import IO, Dict, List, Optional, Sequence, Tuple

try:
    from charset_normalizer import from_bytes
except ImportError as exc:  # pragma: no cover - 入口脚本已前置检查
    raise ImportError(
        '编码探测需要 charset-normalizer（必需依赖，不做可选导入降级）：\n'
        '    python -m pip install -r scripts/requirements.txt'
    ) from exc

__all__ = [
    'BOM_TABLE',
    'DecodeResult',
    'FALLBACK_CANDIDATES',
    'REPLACEMENT_CHAR',
    'candidates',
    'decode',
    'decode_bytes',
    'decode_file',
    'detect',
    'detect_candidates',
    'is_plausible',
    'sniff_bom',
]

REPLACEMENT_CHAR = '\ufffd'
BOM_CHAR = '\ufeff'

#: BOM → 编码。**顺序即判定顺序**：UTF-32 必须排在 UTF-16 之前，
#: 因为 UTF-32 LE 的 BOM（FF FE 00 00）以 UTF-16 LE 的 BOM（FF FE）开头，
#: 反序会把 UTF-32 LE 文件误判成 UTF-16 LE。
BOM_TABLE: Tuple[Tuple[bytes, str], ...] = (
    (codecs.BOM_UTF32_LE, 'utf-32-le'),   # FF FE 00 00  ← 必须先于 utf-16-le
    (codecs.BOM_UTF32_BE, 'utf-32-be'),   # 00 00 FE FF
    (codecs.BOM_UTF8, 'utf-8'),           # EF BB BF
    (codecs.BOM_UTF16_LE, 'utf-16-le'),   # FF FE
    (codecs.BOM_UTF16_BE, 'utf-16-be'),   # FE FF
)

#: 由 BOM 确定后**不再试其他候选**的编码。
#: UTF-16/32 的字节流几乎能被 GB18030 之类的密集型编码"成功"解成纯乱码，
#: 且乱码全是 CJK、能骗过 `is_plausible`；BOM 已经是零歧义信号，
#: 它解不过说明文件损坏，此时报告损坏比"换个编码解出点什么"有用。
#: UTF-8 BOM 不在此列：候选表本来就把 `utf-8` 钉在第一位，
#: 它 strict 失败说明 BOM 与正文自相矛盾，这时继续往下试是合理的。
_BOM_EXCLUSIVE_CODECS = frozenset(('utf-16-le', 'utf-16-be', 'utf-32-le', 'utf-32-be'))

#: 探测失败或探测结果不可用时的兜底候选，顺序即尝试顺序。
#:
#: 不列 `gbk`：GB18030 是 GBK 的超集，凡 GBK 能 strict 解出的 GB18030 都能，
#: 多一个候选只是多一次无意义的全文解码。
#:
#: **不列 `utf-16` / `utf-32`**：任意偶数长度字节流都能被 `utf-16` strict
#: "解码成功"，且产物是满屏 CJK 乱码——恰好能骗过 `is_plausible`，把本该响的
#: replace 告警变成静默的错产物（实测：4000 个 0x80 被判成 utf-16 的 `肀肀肀…`）。
#: 无 BOM 的 UTF-16/32 改由 `_nul_hints` 按 NUL 字节的位置规律识别。
FALLBACK_CANDIDATES: Tuple[str, ...] = ('gb18030', 'big5hkscs')

#: 探测采样：最多取 `_SAMPLE_COUNT` 段、每段 `_SAMPLE_BYTES` 字节，跨全文均匀分布。
#: 文件小于总采样量时直接整篇送探测。
_SAMPLE_BYTES = 128 * 1024
_SAMPLE_COUNT = 5

#: `is_plausible` 的字符统计采样：最多 `_RATIO_WINDOWS` 段、每段 `_RATIO_WINDOW` 字符。
#: 上限 256K 字符，使 2000 万字的书也是常数开销——全文逐字符统计是 Python 层
#: 的循环，会比解码本身还慢。
_RATIO_WINDOW = 32 * 1024
_RATIO_WINDOWS = 8

#: `is_plausible` 的阈值（design §4.2）。
MAX_REPLACEMENT_RATIO = 0.01
MIN_CJK_RATIO = 0.10
MIN_ASCII_RATIO = 0.80

#: CJK 表意文字：扩展 A、基本区、兼容表意文字。
#: 不含全角标点——标点只会抬高占比，用它凑过 10% 门槛没有意义。
_CJK_RUN = re.compile(r'[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+')

#: ASCII 可见字符，含制表与换行：纯英文文本里换行占比不低，
#: 把它算作"正常文本"才符合"这堆字节解出来是不是像文本"的判断意图。
_ASCII_RUN = re.compile(r'[\t\n\r\x20-\x7e]+')


@dataclass(frozen=True)
class DecodeResult:
    """一次解码的结果与判定过程。"""

    text: str
    """去除 BOM 的文本。管线里唯一的文本形态。"""

    encoding: str
    """采用的编码标签；lossy 时带 `(replace)` 后缀，便于直接写进日志/报告。"""

    codec: str
    """实际用于解码的 codec 名（不带 `(replace)` 后缀）。"""

    from_bom: bool
    """编码是否由 BOM 确定（零歧义）。"""

    lossy: bool
    """是否走了 `errors="replace"` 兜底。为真即表示产物可能含乱码。"""

    replacement_count: int
    """文本中 U+FFFD 的个数。"""

    tried: Tuple[str, ...]
    """按顺序试过的候选。"""

    warnings: Tuple[str, ...]
    """告警文本；`emit_warnings()` 负责输出。"""

    @property
    def char_count(self) -> int:
        return len(self.text)

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
# 第一步：BOM 嗅探
# ---------------------------------------------------------------------------


def sniff_bom(raw: bytes) -> Optional[str]:
    """按 `BOM_TABLE` 嗅探 BOM，返回 codec 名；无 BOM 返回 `None`。

    返回的是显式字节序的 codec（如 `utf-16-le`），不靠 Python 的 `utf-16`
    自动识别——显式名字让日志能直接读出判定结果，BOM 字符由统一的
    `_strip_bom` 去掉。
    """
    for bom, name in BOM_TABLE:
        if raw.startswith(bom):
            return name
    return None


# ---------------------------------------------------------------------------
# 第二步：无 BOM 时的采样探测
# ---------------------------------------------------------------------------


def _samples(raw: bytes) -> List[bytes]:
    """跨全文均匀取样，供探测用。

    每段起点对齐到 4 字节，使无 BOM 的 UTF-16/32 不会因为采样把码元切半
    而整段变成噪声。段与段之间**不拼接**——拼接会在接缝处造出不存在的非法
    序列，反而误导探测；改为逐段独立探测后投票（见 `detect_candidates`）。
    """
    total = len(raw)
    if total == 0:
        return []
    if total <= _SAMPLE_BYTES * _SAMPLE_COUNT:
        return [raw]

    span = total - _SAMPLE_BYTES
    step = span // (_SAMPLE_COUNT - 1)
    chunks: List[bytes] = []
    for i in range(_SAMPLE_COUNT):
        start = (i * step) & ~3  # 4 字节对齐：UTF-32 也不会被切半
        chunks.append(raw[start:start + _SAMPLE_BYTES])
    return chunks


def _normalize_codec(name: Optional[str]) -> Optional[str]:
    """把探测器给的编码名收敛成本管线使用的 codec 名。

    - `utf_8` 这类下划线写法统一成连字符；
    - 各种 GB 家族（gbk/gb2312/cp936/hz…）统一到 GB18030：它是超集，
      用超集解码不会比子集差，还少一轮候选；
    - `codecs.lookup` 认不出的名字直接丢弃。
    """
    if not name:
        return None
    normalized = name.strip().lower().replace('_', '-')
    if not normalized:
        return None
    if normalized.startswith('gb') or normalized in ('cp936', 'hz', 'ms936'):
        normalized = 'gb18030'
    elif normalized == 'big5':
        # HKSCS 是 Big5 的扩展，能多解出港澳增补字；对纯 Big5 内容结果一致。
        normalized = 'big5hkscs'
    try:
        codecs.lookup(normalized)
    except LookupError:
        return None
    return normalized


def detect_candidates(raw: bytes) -> List[str]:
    """用 `charset-normalizer` 对多段采样分别探测，按票数返回候选（去重）。

    投票而非只信一段：只看开头的书，正文换编码/前面一大段 ASCII 广告都会
    让单段判定失准。
    """
    votes: Dict[str, int] = {}
    order: Dict[str, int] = {}
    for index, chunk in enumerate(_samples(raw)):
        try:
            best = from_bytes(chunk).best()
        except Exception:
            # 探测器不是判据，只是排序依据；它自己出错不该中断解码
            continue
        if best is None:
            continue
        name = _normalize_codec(best.encoding)
        if name is None:
            continue
        votes[name] = votes.get(name, 0) + 1
        order.setdefault(name, index)
    return sorted(votes, key=lambda name: (-votes[name], order[name]))


def _nul_hints(raw: bytes) -> List[str]:
    """按 NUL 字节的**位置规律**识别无 BOM 的 UTF-16/32；判不出来返回空表。

    文本的 BMP 码位在 16/32 位编码里会留下固定的 NUL 位置，这是机械信号，
    比统计式探测更硬：

    - 触发条件：NUL 占比 ≥ 0.5%。单字节编码的文本文件里 NUL 字节的正常个数是
      **零**，所以这一条本身就足以判定"这不是单字节编码"。
    - UTF-32 LE（BMP 码位形如 `xx xx 00 00`）：第 2、3 位几乎全是 NUL；BE 是第 0、1 位。
    - UTF-16：NUL 偏向哪个奇偶位就先试对应字节序，另一个字节序垫在后面
      交给 `is_plausible` 裁决——字节序搞反的中文会解成既非 CJK 也非 ASCII 的
      噪声，是能被否决的。

    不用"一侧几乎为零"作硬判据：`一`（U+4E00）的低位字节就是 0x00，而它是最常用的
    汉字，会在"另一侧"稳定贡献 NUL，偏向性只有几倍而非几十倍。
    """
    sample = raw[:_SAMPLE_BYTES]
    usable = len(sample) - len(sample) % 4
    if usable < 32:
        return []
    sample = sample[:usable]
    if sample.count(0) / usable < 0.005:
        return []

    quarter = usable // 4
    # 四个 4 字节对齐位置上的 NUL 占比；切片只作用在有界样本上
    at = [sample[i::4].count(0) / quarter for i in range(4)]

    if at[2] > 0.9 and at[3] > 0.9:
        return ['utf-32-le']
    if at[0] > 0.9 and at[1] > 0.9:
        return ['utf-32-be']
    if at[1] + at[3] >= at[0] + at[2]:
        return ['utf-16-le', 'utf-16-be']
    return ['utf-16-be', 'utf-16-le']


def detect(raw: bytes) -> str:
    """返回最佳猜测（design §4.2 的 `detect`）。探测不出结果时给 `gb18030`。

    兜底给 GB18030 而不是 UTF-8：中文小说站的源文件以 GB 系为主，且这个值
    只用于"全部候选失败后 replace 兜底"的那一步。
    """
    found = detect_candidates(raw)
    return found[0] if found else FALLBACK_CANDIDATES[0]


def candidates(enc: Optional[str], detected: Optional[Sequence[str]] = None) -> List[str]:
    """给出按可信度排序、去重的候选列表。

    Args:
        enc: BOM 嗅探结果（零歧义）或探测出的最佳猜测。
        detected: 探测投票出的其余候选；`None` 时只用 `enc` 与兜底表。

    命中 UTF-16/32 的 BOM 时**只返回该编码**，理由见 `_BOM_EXCLUSIVE_CODECS`。
    """
    if enc is not None and enc in _BOM_EXCLUSIVE_CODECS:
        return [enc]

    ordered: List[str] = ['utf-8']  # 见模块 docstring：strict UTF-8 是最强判别器
    for name in (enc, *(detected or ()), *FALLBACK_CANDIDATES):
        normalized = _normalize_codec(name)
        if normalized and normalized not in ordered:
            ordered.append(normalized)
    return ordered


# ---------------------------------------------------------------------------
# 第三步：有效性校验
# ---------------------------------------------------------------------------


def _ratio_sample(text: str) -> str:
    """取用于字符占比统计的样本（上限 256K 字符）。"""
    total = len(text)
    budget = _RATIO_WINDOW * _RATIO_WINDOWS
    if total <= budget:
        return text
    span = total - _RATIO_WINDOW
    step = span // (_RATIO_WINDOWS - 1)
    return ''.join(
        text[i * step:i * step + _RATIO_WINDOW] for i in range(_RATIO_WINDOWS)
    )


def _run_ratio(pattern: re.Pattern[str], sample: str) -> float:
    """样本中匹配 `pattern`（连续段写法）的字符占比。

    按"连续段"匹配再求长度和：中文正文里一行就是一段，`findall` 只会返回
    很少的几个大字符串，统计完全落在 C 层，不是逐字符的 Python 循环。
    """
    if not sample:
        return 0.0
    matched = sum(len(run) for run in pattern.findall(sample))
    return matched / len(sample)


def is_plausible(text: str) -> bool:
    """解码结果是否像"正常文本"（design §4.2）。

    判据：替换字符占比 < 1%，且（CJK 占比 > 10% 或 ASCII 可见字符占比 > 80%）。

    替换字符按**全文精确**计数（`str.count` 在 C 层，一次扫描）；两个占比按
    跨全文采样估计，使 2000 万字的书与 2 万字的书开销相同。
    """
    if not text:
        # 空文本没有可否证的地方；空文件在 archive 层就已经被拒了
        return True

    if text.count(REPLACEMENT_CHAR) / len(text) >= MAX_REPLACEMENT_RATIO:
        return False

    sample = _ratio_sample(text)
    if _run_ratio(_CJK_RUN, sample) > MIN_CJK_RATIO:
        return True
    return _run_ratio(_ASCII_RUN, sample) > MIN_ASCII_RATIO


# ---------------------------------------------------------------------------
# 对外入口
# ---------------------------------------------------------------------------


def _strip_bom(text: str) -> str:
    """去掉解码后残留的 BOM 字符（U+FEFF）。

    显式字节序 codec（`utf-16-le` 等）不会吃掉 BOM，`utf-8` 对 EF BB BF
    也只是解成 U+FEFF；统一在这里去掉，使出口恒为无 BOM 文本。
    """
    return text.lstrip(BOM_CHAR)


def _fallback_warning(
    origin: str,
    best_guess: str,
    tried: Sequence[str],
    implausible: Sequence[str],
    text: str,
    replacements: int,
) -> str:
    """replace 兜底的告警文本。结论按损坏比例分档，不搞一律"很可能乱码"。

    告警要响，但也要准：一个 3.1M 字的 GB 文本里混进 1 个 CP1252 的 `0x80`，
    与"整篇字节序/编码判错"是两件事，混在一句话里说会让告警失去可信度。
    """
    ratio = replacements / len(text) if text else 0.0
    lines = [
        f'  ⚠ [编码告警] 没有任何候选编码能通过校验：{origin}',
        f'    已试候选：{", ".join(tried) or "（无）"}',
        f'    其中 strict 解码成功但内容不可信：{", ".join(implausible) or "（无）"}',
        f'    退回最佳猜测 {best_guess} + errors="replace"：'
        f'产生 {replacements:,} 个替换字符（占 {ratio:.4%}）',
    ]
    if replacements == 0:
        lines.append(
            f'    注意：{best_guess} 能覆盖全部字节，但解出的内容没通过有效性校验'
            '（既不像中文也不像英文文本）——编码很可能整个判错了，请人工核对产物。'
        )
    elif ratio < 0.0001:
        lines.append(
            '    损坏仅限个别字符，其余正文可用；常见成因是 CP1252 的 € / ￥ 等'
            '单字节被混入 GB 文本。要消掉这条告警需修源文件，不是改探测。'
        )
    else:
        lines.append(
            '    产物很可能大面积含乱码。请确认源文件编码，'
            '或把它转成 UTF-8 后重新导出。'
        )
    return '\n'.join(lines)


def decode_bytes(raw: bytes, *, origin: str = '<bytes>') -> DecodeResult:
    """把字节解成去除 BOM 的文本，并说明判定过程。

    Args:
        raw: 全部字节（不是采样——校验要求全文 strict 解码）。
        origin: 出现在告警里的来源描述，通常是文件名。
    """
    bom_encoding = sniff_bom(raw)
    # NUL 位置规律排在统计式探测之前：前者是机械信号，后者是概率判断
    detected = [] if bom_encoding else [*_nul_hints(raw), *detect_candidates(raw)]
    best_guess = bom_encoding or (detected[0] if detected else FALLBACK_CANDIDATES[0])

    tried: List[str] = []
    implausible: List[str] = []
    for cand in candidates(best_guess, detected):
        tried.append(cand)
        try:
            text = raw.decode(cand, errors='strict')
        except (UnicodeDecodeError, LookupError):
            continue
        text = _strip_bom(text)
        if not is_plausible(text):
            # 解得出来 ≠ 解对了：GB18030 能把 Big5 字节"成功"解成乱码
            implausible.append(cand)
            continue
        return DecodeResult(
            text=text,
            encoding=cand,
            codec=cand,
            from_bom=bom_encoding is not None,
            lossy=False,
            replacement_count=text.count(REPLACEMENT_CHAR),
            tried=tuple(tried),
            warnings=(),
        )

    # 全部候选失败：最佳猜测 + replace，并把告警说满（需求 7.8）
    text = _strip_bom(raw.decode(best_guess, errors='replace'))
    replacements = text.count(REPLACEMENT_CHAR)
    warnings = (_fallback_warning(origin, best_guess, tried, implausible, text, replacements),)
    return DecodeResult(
        text=text,
        encoding=f'{best_guess}(replace)',
        codec=best_guess,
        from_bom=bom_encoding is not None,
        lossy=True,
        replacement_count=replacements,
        tried=tuple(tried),
        warnings=warnings,
    )


def decode_file(path: Path) -> DecodeResult:
    """读入整个文件并解码。调用方拿 `DecodeResult` 打日志/做汇总。"""
    path = Path(path)
    return decode_bytes(path.read_bytes(), origin=path.name)


def decode(path: Path) -> Tuple[str, str]:
    """design §4.2 的窄接口：返回 `(去除 BOM 的文本, 编码标签)`。

    告警直接打到 stderr——这条路径必须是响的，不能靠调用方记得去查字段。
    """
    result = decode_file(path)
    result.emit_warnings()
    return result.text, result.encoding
