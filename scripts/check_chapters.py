#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
章节数据质量检查工具
检查生成的章节JSON文件是否符合预期
"""

import json
import re
from pathlib import Path
from typing import List, Dict, Any, Tuple
from collections import Counter

# 配置
DATA_DIR = Path(__file__).parent.parent / "public" / "data"
CHAPTER_MARKERS = ["章", "节", "回", "集", "篇", "幕", "话", "段", "折", "品"]
UPPER_MARKERS = ["卷", "部", "册", "季"]
ALL_MARKERS = UPPER_MARKERS + CHAPTER_MARKERS

# 检查规则配置
MAX_TITLE_LENGTH = 80  # 标题最大长度
MAX_SENTENCE_PUNCTUATION = 3  # 标题中最多句子标点数
# 可疑模式：检测可能是正文误识别为标题的情况
SUSPICIOUS_PATTERNS = [
    (r"^[^第\d]*说[^！？。]*。", "正文语句（包含'说'并以句号结尾）"),  # "二话不说。直接..."
    (r"^[是这那][^第]*[了着]。", "疑似正文（以是/这/那开头，包含了/着，以句号结尾）"),
    (r"^[^第]*，[^！？。]{0,10}[。！？]", "包含逗号和结束标点的短句"),
]


class ChapterChecker:
    def __init__(self, file_path: Path):
        self.file_path = file_path
        self.book_id = file_path.stem.replace("_chapters", "")
        self.data: Dict[str, Any] = {}
        self.chapters: List[Tuple[str, str, int, int, int]] = []
        self.issues: List[Dict[str, Any]] = []
        
    def load(self) -> bool:
        """加载章节数据"""
        try:
            with open(self.file_path, "r", encoding="utf-8") as f:
                self.data = json.load(f)
            self.chapters = self.data.get("chapters", [])
            return True
        except Exception as e:
            print(f"❌ 加载失败 {self.file_path.name}: {e}")
            return False
    
    def check_merged_headings(self) -> int:
        """检查合并标题（一行中有多个章节标记）"""
        count = 0
        pattern = re.compile(
            r"第\s*[\d〇零一二三四五六七八九十百千]+\s*[" + "".join(CHAPTER_MARKERS) + r"]"
        )
        for idx, chapter in enumerate(self.chapters, 1):
            title = chapter[1]
            matches = pattern.findall(title)
            if len(matches) > 1:
                count += 1
                self.issues.append({
                    "type": "merged_heading",
                    "severity": "high",
                    "chapter": idx,
                    "title": title,
                    "detail": f"发现 {len(matches)} 个章节标记"
                })
        return count
    
    def check_title_length(self) -> int:
        """检查异常长度标题"""
        count = 0
        for idx, chapter in enumerate(self.chapters, 1):
            title = chapter[1]
            if len(title) > MAX_TITLE_LENGTH:
                count += 1
                self.issues.append({
                    "type": "long_title",
                    "severity": "medium",
                    "chapter": idx,
                    "title": title[:60] + "..." if len(title) > 60 else title,
                    "detail": f"标题长度 {len(title)} 字符"
                })
        return count
    
    def check_punctuation_density(self) -> int:
        """检查标题中的标点密度"""
        count = 0
        # 只检查逗号、句号、顿号、分号（排除感叹号和问号，它们在标题中很常见）
        sentence_punct = re.compile(r"[，。、；]")
        for idx, chapter in enumerate(self.chapters, 1):
            title = chapter[1]
            # 排除包含卷/部等上层标记的标题（它们可能较长）
            has_upper_marker = any(marker in title for marker in UPPER_MARKERS)
            if has_upper_marker:
                continue
            
            # 移除末尾感叹号和问号再检查
            title_cleaned = re.sub(r"[！!？?]+$", "", title)
            matches = sentence_punct.findall(title_cleaned)
            if len(matches) > MAX_SENTENCE_PUNCTUATION:
                count += 1
                self.issues.append({
                    "type": "high_punctuation",
                    "severity": "medium",
                    "chapter": idx,
                    "title": title,
                    "detail": f"包含 {len(matches)} 个句子标点"
                })
        return count
    
    def check_suspicious_titles(self) -> int:
        """检查可疑标题（可能是正文误识别）"""
        count = 0
        for idx, chapter in enumerate(self.chapters, 1):
            title = chapter[1]
            # 移除卷/部前缀进行检查
            title_without_prefix = title
            for marker in UPPER_MARKERS:
                pattern = f"第.*?{marker}\\s+"
                title_without_prefix = re.sub(pattern, "", title_without_prefix)
            
            # 检查是否匹配可疑模式
            for pattern, description in SUSPICIOUS_PATTERNS:
                if re.search(pattern, title_without_prefix):
                    count += 1
                    self.issues.append({
                        "type": "suspicious_title",
                        "severity": "medium",
                        "chapter": idx,
                        "title": title,
                        "detail": description
                    })
                    break
        return count
    
    def check_duplicate_titles(self) -> int:
        """检查重复标题"""
        count = 0
        title_counts = Counter(chapter[1] for chapter in self.chapters)
        duplicates = {title: cnt for title, cnt in title_counts.items() if cnt > 1}
        
        for title, cnt in duplicates.items():
            indices = [idx for idx, ch in enumerate(self.chapters, 1) if ch[1] == title]
            count += cnt - 1  # 重复次数
            self.issues.append({
                "type": "duplicate_title",
                "severity": "high",
                "chapter": indices[0],
                "title": title,
                "detail": f"重复 {cnt} 次，出现在章节: {', '.join(map(str, indices[:5]))}"
            })
        return count
    
    def check_hierarchy_issues(self) -> int:
        """检查层级问题"""
        count = 0
        # 检查是否有章节同时包含多个上层标记（仅在标记位置，非标题内容）
        upper_marker_regex = re.compile(r"第\s*\S+?\s*([" + "".join(UPPER_MARKERS) + r"])")
        for idx, chapter in enumerate(self.chapters, 1):
            title = chapter[1]
            # 只检查作为标记使用的上层marker（在"第X卷/部"格式中）
            upper_matches = upper_marker_regex.findall(title)
            if len(upper_matches) > 1:
                count += 1
                self.issues.append({
                    "type": "multiple_upper_markers",
                    "severity": "high",
                    "chapter": idx,
                    "title": title,
                    "detail": f"包含多个上层标记: {', '.join(upper_matches)}"
                })
        
        # 检查上层标记是否应该在主标记之前
        upper_marker_pattern = re.compile(r"第.*?([" + "".join(UPPER_MARKERS) + r"])")
        primary_marker_pattern = re.compile(r"第.*?([" + "".join(CHAPTER_MARKERS) + r"])")
        
        for idx, chapter in enumerate(self.chapters, 1):
            title = chapter[1]
            upper_match = upper_marker_pattern.search(title)
            primary_match = primary_marker_pattern.search(title)
            
            # 如果同时有上层和主标记，上层应该在前
            if upper_match and primary_match:
                if upper_match.start() > primary_match.start():
                    count += 1
                    self.issues.append({
                        "type": "reversed_hierarchy",
                        "severity": "high",
                        "chapter": idx,
                        "title": title,
                        "detail": f"上层标记 '{upper_match.group(1)}' 在主标记 '{primary_match.group(1)}' 之后"
                    })
        
        return count
    
    def check_missing_markers(self) -> int:
        """检查缺少章节标记的标题"""
        count = 0
        special_titles = ["楔子", "序章", "序言", "引子", "终章", "尾声", "尾记", "后记", "番外", "外传", "全文"]
        
        for idx, chapter in enumerate(self.chapters, 1):
            title = chapter[1]
            # 跳过特殊标题
            if any(special in title for special in special_titles):
                continue
            
            # 检查是否包含任何已知标记
            has_marker = any(marker in title for marker in ALL_MARKERS)
            if not has_marker:
                count += 1
                self.issues.append({
                    "type": "missing_marker",
                    "severity": "medium",
                    "chapter": idx,
                    "title": title,
                    "detail": "标题中未发现章节标记"
                })
        
        return count
    
    def analyze_statistics(self) -> Dict[str, Any]:
        """分析章节统计信息"""
        if not self.chapters:
            return {}
        
        titles = [ch[1] for ch in self.chapters]
        lengths = [len(title) for title in titles]
        
        # 统计标记使用情况
        marker_counts = {marker: 0 for marker in ALL_MARKERS}
        for title in titles:
            for marker in ALL_MARKERS:
                if marker in title:
                    marker_counts[marker] += 1
        
        # 统计有上层标记前缀的章节
        chapters_with_prefix = sum(1 for title in titles if any(m in title for m in UPPER_MARKERS))
        
        return {
            "total_chapters": len(self.chapters),
            "avg_title_length": sum(lengths) / len(lengths),
            "min_title_length": min(lengths),
            "max_title_length": max(lengths),
            "marker_usage": {k: v for k, v in marker_counts.items() if v > 0},
            "chapters_with_upper_prefix": chapters_with_prefix,
            "prefix_ratio": f"{chapters_with_prefix / len(self.chapters) * 100:.1f}%"
        }
    
    def run_all_checks(self) -> None:
        """运行所有检查"""
        if not self.load():
            return
        
        print(f"\n{'='*70}")
        print(f"📚 检查书籍: {self.data['book']['title']} - {self.data['book']['author']}")
        print(f"   文件: {self.file_path.name}")
        print(f"{'='*70}")
        
        # 运行各项检查
        checks = [
            ("合并标题", self.check_merged_headings),
            ("重复标题", self.check_duplicate_titles),
            ("异常长度", self.check_title_length),
            ("标点密度", self.check_punctuation_density),
            ("层级问题", self.check_hierarchy_issues),
            ("缺少标记", self.check_missing_markers),
            ("可疑标题", self.check_suspicious_titles),
        ]
        
        results = {}
        for name, func in checks:
            count = func()
            results[name] = count
        
        # 输出统计信息
        stats = self.analyze_statistics()
        print(f"\n📊 统计信息:")
        print(f"   总章节数: {stats['total_chapters']}")
        print(f"   平均标题长度: {stats['avg_title_length']:.1f} 字符")
        print(f"   标题长度范围: {stats['min_title_length']} - {stats['max_title_length']}")
        if stats['marker_usage']:
            print(f"   使用的标记: {', '.join(f'{k}({v})' for k, v in stats['marker_usage'].items())}")
        print(f"   带上层前缀的章节: {stats['chapters_with_upper_prefix']} ({stats['prefix_ratio']})")
        
        # 输出检查结果
        print(f"\n🔍 检查结果:")
        total_issues = sum(results.values())
        for name, count in results.items():
            status = "✅" if count == 0 else "⚠️" if count < 5 else "❌"
            print(f"   {status} {name}: {count}")
        
        # 输出问题详情
        if self.issues:
            print(f"\n📋 问题详情 (共 {len(self.issues)} 个):")
            # 按严重程度分组
            severity_order = {"high": 0, "medium": 1, "low": 2}
            sorted_issues = sorted(self.issues, key=lambda x: (severity_order[x["severity"]], x["chapter"]))
            
            for issue in sorted_issues[:20]:  # 只显示前20个
                severity_icon = {"high": "🔴", "medium": "🟡", "low": "🟢"}[issue["severity"]]
                print(f"   {severity_icon} 章节 {issue['chapter']}: {issue['type']}")
                print(f"      标题: {issue['title']}")
                print(f"      说明: {issue['detail']}")
            
            if len(self.issues) > 20:
                print(f"   ... 还有 {len(self.issues) - 20} 个问题未显示")
        else:
            print(f"\n✨ 未发现问题！")
        
        # 总结
        print(f"\n{'='*70}")
        if total_issues == 0:
            print(f"✅ 检查通过！章节数据质量良好。")
        elif total_issues < 10:
            print(f"⚠️  发现 {total_issues} 个问题，建议检查。")
        else:
            print(f"❌ 发现 {total_issues} 个问题，需要处理。")
        print(f"{'='*70}\n")


def main():
    """主函数"""
    print("🔎 章节数据质量检查工具")
    print("=" * 70)
    
    # 查找所有章节文件
    chapter_files = list(DATA_DIR.glob("*_chapters.json"))
    
    if not chapter_files:
        print(f"❌ 未找到章节文件，路径: {DATA_DIR}")
        return
    
    print(f"找到 {len(chapter_files)} 个章节文件\n")
    
    # 检查每个文件
    all_results = []
    for file_path in sorted(chapter_files):
        checker = ChapterChecker(file_path)
        checker.run_all_checks()
        all_results.append({
            "book": checker.data.get("book", {}).get("title", "未知"),
            "total_issues": len(checker.issues),
            "chapters": len(checker.chapters)
        })
    
    # 输出总体汇总
    if len(all_results) > 1:
        print(f"\n{'='*70}")
        print("📊 总体汇总")
        print(f"{'='*70}")
        total_chapters = sum(r["chapters"] for r in all_results)
        total_issues = sum(r["total_issues"] for r in all_results)
        print(f"总书籍数: {len(all_results)}")
        print(f"总章节数: {total_chapters}")
        print(f"总问题数: {total_issues}")
        print(f"平均质量: {(1 - total_issues / max(total_chapters, 1)) * 100:.1f}%")
        print(f"{'='*70}\n")


if __name__ == "__main__":
    main()
