/**
 * 转换新格式为兼容格式
 * 从 ${bookId}.json 转为 ${bookId}_chapters.json
 */

import path from "node:path";
import fs from "fs-extra";

const DATA_DIR = path.resolve(__dirname, "../dist/data");

async function main() {
  console.log("转换为兼容格式...\n");
  
  const files = await fs.readdir(DATA_DIR);
  const jsonFiles = files.filter(f => f.endsWith(".json") && f !== "books.json");
  
  console.log(`找到 ${jsonFiles.length} 个书籍JSON文件\n`);
  
  for (const file of jsonFiles) {
    const filePath = path.join(DATA_DIR, file);
    const data = await fs.readJson(filePath);
    
    // 如果已经是 chapters 格式，跳过
    if (data.book && data.chapters !== undefined) {
      console.log(`✓ 跳过 ${file}（已经是兼容格式）`);
      continue;
    }
    
    // 转换为兼容格式
    const compatData = {
      book: {
        id: data.id,
        title: data.title,
        author: data.author,
        totalChapters: 0,
        parts: data.parts,
        totalSize: data.totalSize,
      },
      chapters: [],
    };
    
    // 新文件名：加上 _chapters
    const bookId = file.replace(".json", "");
    const newFilePath = path.join(DATA_DIR, `${bookId}_chapters.json`);
    
    await fs.writeJson(newFilePath, compatData, { spaces: 2 });
    await fs.remove(filePath); // 删除旧文件
    
    console.log(`✓ 已转换《${data.title}》`);
  }
  
  console.log("\n✅ 转换完成！");
}

main().catch(err => {
  console.error("❌ 转换失败:", err);
  process.exit(1);
});
