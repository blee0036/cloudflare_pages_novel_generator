/**
 * 扫描使用保底规则的书籍，并从 manifest.json 中删除
 * 这样下次运行 preprocess 时会重新处理这些书
 */
const fs = require('fs-extra');
const path = require('path');

async function main() {
  const dataDir = path.resolve('dist', 'data');
  const manifestPath = path.resolve('generated', 'manifest.json');
  
  if (!await fs.pathExists(dataDir)) {
    console.error('❌ dist/data 目录不存在');
    return;
  }
  
  if (!await fs.pathExists(manifestPath)) {
    console.error('❌ manifest.json 不存在');
    return;
  }
  
  // 1. 扫描找出保底书籍
  const files = await fs.readdir(dataDir);
  const chapterFiles = files.filter(f => f.endsWith('_chapters.json'));
  
  console.log(`扫描 ${chapterFiles.length} 本书...\n`);
  
  const fallbackBookIds = [];
  const fallbackPattern = /^第\d+章 第\d+-\d+行$/;
  
  for (const file of chapterFiles) {
    const filePath = path.join(dataDir, file);
    const data = await fs.readJson(filePath);
    
    if (!data.chapters || data.chapters.length === 0) continue;
    
    const firstChapterTitle = data.chapters[0][1];
    
    if (fallbackPattern.test(firstChapterTitle)) {
      fallbackBookIds.push(data.book.id);
      console.log(`✓ 找到保底书籍: ${data.book.title} (${data.book.totalChapters} 章)`);
    }
  }
  
  if (fallbackBookIds.length === 0) {
    console.log('✓ 没有使用保底规则的书籍\n');
    return;
  }
  
  console.log(`\n找到 ${fallbackBookIds.length} 本保底书籍\n`);
  
  // 2. 从 manifest 中删除
  const manifest = await fs.readJson(manifestPath);
  let deletedCount = 0;
  
  for (const bookId of fallbackBookIds) {
    if (manifest.books[bookId]) {
      delete manifest.books[bookId];
      deletedCount++;
      console.log(`✓ 从 manifest 删除: ${bookId}`);
    }
  }
  
  // 3. 保存 manifest
  await fs.writeJson(manifestPath, manifest, { spaces: 2 });
  
  console.log(`\n========================================`);
  console.log(`✅ 已从 manifest 中删除 ${deletedCount} 本书`);
  console.log(`========================================`);
  console.log(`\n📝 下一步:`);
  console.log(`   1. 修改 scripts/preprocess.ts 中的 LINES_PER_CHAPTER（如果需要）`);
  console.log(`   2. 运行: npm run preprocess`);
  console.log(`   3. 这 ${deletedCount} 本书会被重新处理\n`);
}

main().catch(console.error);
