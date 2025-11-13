/**
 * 快速更新脚本：只更新 JSON 为无章节版本
 * 不重新处理 part 文件，节省时间
 */

import path from "node:path";
import fs from "fs-extra";

const DATA_DIR = path.resolve(__dirname, "../dist/data");
const BOOKS_DIR = path.resolve(__dirname, "../dist/books");

interface PartInfo {
  path: string;
  size: number;
}

async function main() {
  console.log("开始更新 JSON 文件...\n");
  
  // 读取所有现有的 _chapters.json 文件
  const files = await fs.readdir(DATA_DIR);
  const chapterFiles = files.filter(f => f.endsWith("_chapters.json") && f !== "books_chapters.json");
  
  console.log(`找到 ${chapterFiles.length} 个书籍JSON文件\n`);
  
  let updated = 0;
  
  for (const file of chapterFiles) {
    const filePath = path.join(DATA_DIR, file);
    const data = await fs.readJson(filePath);
    
    // 如果已经是空章节，跳过
    if (data.chapters && data.chapters.length === 0) {
      console.log(`✓ 跳过《${data.book.title}》（已经是无章节版本）`);
      continue;
    }
    
    // 检查 parts 是否存在
    if (!data.book.parts || data.book.parts.length === 0) {
      console.log(`⚠️  跳过《${data.book.title}》（缺少 parts 信息，需要完整重新处理）`);
      continue;
    }
    
    // 更新为无章节版本
    const newData = {
      book: {
        id: data.book.id,
        title: data.book.title,
        author: data.book.author,
        totalChapters: 0,
        parts: data.book.parts,
        totalSize: data.book.totalSize,
      },
      chapters: [],
    };
    
    await fs.writeJson(filePath, newData, { spaces: 2 });
    console.log(`✓ 已更新《${data.book.title}》`);
    updated++;
  }
  
  console.log(`\n✅ 完成！成功更新 ${updated} 本书的JSON文件`);
}

main().catch(err => {
  console.error("❌ 更新失败:", err);
  process.exit(1);
});
