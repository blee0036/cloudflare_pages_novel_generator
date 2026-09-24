#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
小说预处理脚本 (Python 版)
功能：
1. 遍历压缩包/文本目录
2. 提取文本并自动检测编码转换为标准 UTF-8
3. 使用分级正则状态机智能识别章节目录与字符偏移
4. Gzip 高度压缩输出全本（满足 Cloudflare Pages 25MB 与 20,000 文件限制）
5. 生成全局索引 books.json 与单书章节索引 {book_id}_toc.json
"""

import os
import sys
import re
import json
import gzip
import shutil
import tempfile
import subprocess
from pathlib import Path
from typing import List, Dict, Tuple, Optional

# Ensure UTF-8 output on Windows terminal
if sys.stdout and hasattr(sys.stdout, 'reconfigure'):
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass

try:
    from charset_normalizer import from_bytes
except ImportError:
    from_bytes = None

# Legado (阅读 3.0) 工业级分级章节匹配正则
TOC_PATTERNS = [
    # 1. 标准中文章节：第一章、第123章、第一卷、第1回、第1节等（含大写繁体数字与常见单位）
    re.compile(r'^[ \t\u3000]*第[0-9零〇一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟]{1,8}[章回节卷集幕计部篇折话讲品][ :：\s\t\u3000].{0,40}$'),
    re.compile(r'^[ \t\u3000]*第[0-9零〇一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟]{1,8}[章回节卷集幕计部篇折话讲品]$'),
    
    # 2. 独立分卷/部/册/集（上位大纲）
    re.compile(r'^[ \t\u3000]*(?:卷|部|册|集|篇)[0-9零〇一二两三四五六七八九十百千万壹贰叁肆伍陆柒捌玖拾佰仟]{1,6}[ :：\s\t\u3000].{0,40}$'),
    
    # 3. 特殊章节标识（序章/楔子/番外/作品相关等）
    re.compile(r'^[ \t\u3000]*(?:正文|序[章言卷]?|楔子|引子|尾声|后记|番外|终章|写在前面的话|内容简介|作品相关|上架感言|完本感言|感言)[ :：\s\t\u3000]?.{0,40}$'),
    
    # 4. 英文与西式章节（Chapter 1, Section 2, Book 3, Episode 4）
    re.compile(r'^[ \t\u3000]*(?:Chapter|Section|Book|Episode|Act)\s*[0-9]{1,5}[ :：\s\t\u3000]?.{0,40}$', re.IGNORECASE),
    
    # 5. 简易序号格式（如：1. 标题、001 标题、一、标题）
    re.compile(r'^[ \t\u3000]*[0-9]{1,5}[、.\s\t\-][\u4e00-\u9fa5].{0,40}$'),
    re.compile(r'^[ \t\u3000]*[零〇一二两三四五六七八九十]{1,3}[、.][\u4e00-\u9fa5].{0,40}$')
]

# 严格过滤伪标题（正文行尾通常包含陈述句或对话标点）
END_PUNCT = set(r'。！？!?…”’.,;:：')

def parse_filename_meta(filename: str) -> Tuple[str, str, str]:
    """从文件名中提取书名和作者"""
    name = Path(filename).stem
    # 典型格式：《书名》（校对版全本）作者：作者名
    title = name
    author = "佚名"
    
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

def detect_encoding(raw_bytes: bytes) -> str:
    """快速可靠检测编码"""
    # 1. 尝试 UTF-8
    try:
        raw_bytes[:16384].decode('utf-8')
        return 'utf-8'
    except UnicodeDecodeError:
        pass
        
    # 2. 借助 charset-normalizer
    if from_bytes:
        try:
            res = from_bytes(raw_bytes[:32768]).best()
            if res and res.encoding:
                enc = res.encoding.lower()
                if 'gb' in enc:
                    return 'gb18030'
                return enc
        except Exception:
            pass
            
    # 3. 常用中文编码回退
    for enc in ['gb18030', 'gbk', 'big5', 'utf-16']:
        try:
            raw_bytes[:16384].decode(enc)
            return enc
        except Exception:
            continue
            
    return 'gb18030'

def extract_txt_from_archive(archive_path: Path, temp_dir: Path) -> Optional[Path]:
    """使用 Windows 内置 tar (bsdtar) 或相关工具解压出 txt 文件"""
    try:
        res = subprocess.run(
            ['tar', '-xf', str(archive_path.resolve()), '-C', str(temp_dir.resolve())],
            capture_output=True,
            timeout=60
        )
        if res.returncode == 0:
            txts = list(temp_dir.glob('**/*.txt'))
            if txts:
                # 选体积最大的 txt（防止里面有 readme.txt 或广告.txt）
                txts.sort(key=lambda p: p.stat().st_size, reverse=True)
                return txts[0]
    except Exception as e:
        print(f"  [解压错误] {archive_path.name}: {e}")
    return None

def split_chapters(text: str) -> List[Dict]:
    """
    智能切分章节：
    返回列表: [{'id': 0, 'title': '...', 'start': 0, 'end': 1234, 'length': 1234}]
    """
    lines = text.splitlines(keepends=True)
    chapters = []
    current_char_offset = 0
    
    # 预先扫描出所有命中的章节标题
    heading_indices = []
    
    for idx, line in enumerate(lines):
        line_len = len(line)
        stripped = line.strip()
        
        # 章节标题初筛：长度限制与标点过滤
        if stripped and len(stripped) <= 40 and stripped[-1] not in END_PUNCT:
            for pat in TOC_PATTERNS:
                if pat.match(stripped):
                    heading_indices.append((idx, current_char_offset, stripped))
                    break
                    
        current_char_offset += line_len
        
    total_len = len(text)
    
    # 如果识别到了标准章节
    if len(heading_indices) >= 2:
        # 如果第一章前面有前言/引言，作为"序章"或"前言"
        if heading_indices[0][1] > 0:
            chapters.append({
                'id': 0,
                'title': '序章 / 前言',
                'start': 0,
                'end': heading_indices[0][1],
                'length': heading_indices[0][1]
            })
            
        for i, (line_idx, char_offset, title) in enumerate(heading_indices):
            start = char_offset
            end = heading_indices[i + 1][1] if i + 1 < len(heading_indices) else total_len
            chapters.append({
                'id': len(chapters),
                'title': title,
                'start': start,
                'end': end,
                'length': end - start
            })
    else:
        # 保底策略：按自然段优雅分段（每 5000 字在换行处断开，绝不在汉字中间截断）
        print("  [提示] 未识别到充足的标准章节标记，启用自然段落平滑断节")
        target_chunk_size = 5000
        cur_start = 0
        part_num = 1
        
        while cur_start < total_len:
            cur_end = min(cur_start + target_chunk_size, total_len)
            if cur_end < total_len:
                # 寻找最近的换行符
                next_newline = text.find('\n', cur_end)
                if next_newline != -1 and next_newline - cur_start < target_chunk_size + 1500:
                    cur_end = next_newline + 1
                    
            chapters.append({
                'id': len(chapters),
                'title': f'第 {part_num} 部分',
                'start': cur_start,
                'end': cur_end,
                'length': cur_end - cur_start
            })
            cur_start = cur_end
            part_num += 1
            
    return chapters

def process_book(rar_path: Path, output_books_dir: Path, output_data_dir: Path) -> Optional[Dict]:
    """处理单本书籍"""
    safe_id, title, author = parse_filename_meta(rar_path.name)
    print(f"\n正在处理: 《{title}》 (作者: {author})")
    
    with tempfile.TemporaryDirectory() as td:
        temp_dir = Path(td)
        txt_path = extract_txt_from_archive(rar_path, temp_dir)
        if not txt_path:
            print(f"  ❌ 未能从压缩包提取到小说正文 TXT")
            return None
            
        raw_size = txt_path.stat().st_size
        print(f"  解压成功，原始体积: {raw_size / 1024 / 1024:.2f} MB")
        
        # 编码检测与读取
        with open(txt_path, 'rb') as f:
            header = f.read(32768)
            encoding = detect_encoding(header)
            
        print(f"  检测编码: {encoding}")
        with open(txt_path, 'r', encoding=encoding, errors='replace') as f:
            text = f.read()
            
        # 移除常见 BOM
        text = text.lstrip('\ufeff')
        char_count = len(text)
        print(f"  读取字符数: {char_count:,} 字")
        
        # 提取章节与偏移
        chapters = split_chapters(text)
        print(f"  章节提取完成: 共 {len(chapters)} 章")
        
        # 压缩为 gzip 文件: output_books_dir / f"{safe_id}.txt.gz"
        gz_path = output_books_dir / f"{safe_id}.txt.gz"
        with gzip.open(gz_path, 'wt', encoding='utf-8', compresslevel=9) as f:
            f.write(text)
            
        gz_size = gz_path.stat().st_size
        print(f"  Gzip 压缩完成: {gz_size / 1024 / 1024:.2f} MB (压缩比: {gz_size / raw_size * 100:.1f}%)")
        
        # 写入章节目录 JSON: output_data_dir / f"{safe_id}_toc.json"
        toc_data = {
            'id': safe_id,
            'title': title,
            'author': author,
            'charCount': char_count,
            'totalChapters': len(chapters),
            'chapters': chapters
        }
        toc_path = output_data_dir / f"{safe_id}_toc.json"
        with open(toc_path, 'w', encoding='utf-8') as f:
            json.dump(toc_data, f, ensure_ascii=False, indent=2)
            
        return {
            'id': safe_id,
            'title': title,
            'author': author,
            'charCount': char_count,
            'totalChapters': len(chapters),
            'gzSize': gz_size,
            'txtPath': f"/books/{safe_id}.txt.gz",
            'tocPath': f"/data/{safe_id}_toc.json"
        }

def main():
    source_dir = Path("zip-novel")
    if not source_dir.exists():
        print(f"错误: 目录 {source_dir} 不存在")
        return
        
    output_books_dir = Path("public/books")
    output_data_dir = Path("public/data")
    output_books_dir.mkdir(parents=True, exist_ok=True)
    output_data_dir.mkdir(parents=True, exist_ok=True)
    
    rar_files = list(source_dir.glob("*.rar"))
    print(f"找到 {len(rar_files)} 本待处理小说...")
    
    books_summary = []
    
    for idx, rar_path in enumerate(rar_files, 1):
        print(f"\n[{idx}/{len(rar_files)}]", end=" ")
        meta = process_book(rar_path, output_books_dir, output_data_dir)
        if meta:
            books_summary.append(meta)
            
    # 写入全局书籍列表
    books_list_path = output_data_dir / "books.json"
    with open(books_list_path, 'w', encoding='utf-8') as f:
        json.dump({
            'count': len(books_summary),
            'books': books_summary
        }, f, ensure_ascii=False, indent=2)
        
    print("\n" + "="*50)
    print(f"[完成] 全部预处理完成！成功处理 {len(books_summary)} 本书。")
    print(f"全局索引生成至: {books_list_path}")
    print("="*50)

if __name__ == '__main__':
    main()
