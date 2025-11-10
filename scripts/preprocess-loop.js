/**
 * 循环执行预处理，直到所有书籍处理完毕
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs-extra');

// 解析命令行参数
const args = process.argv.slice(2);
let batchSize = '50';
let memoryLimit = '512';

for (const arg of args) {
  if (arg.startsWith('--batch=')) {
    batchSize = arg.split('=')[1];
  } else if (arg.startsWith('--memory=')) {
    memoryLimit = arg.split('=')[1];
  }
}

const BATCH_SIZE = process.env.BATCH_SIZE || batchSize;
const MEMORY_LIMIT = process.env.MEMORY_LIMIT || memoryLimit;

console.log('========================================');
console.log('自动批处理模式');
console.log(`批次大小: ${BATCH_SIZE} 本/批`);
console.log(`内存限制: ${MEMORY_LIMIT}MB`);
console.log('========================================\n');

let iteration = 0;

function runPreprocess() {
  return new Promise((resolve, reject) => {
    iteration++;
    console.log(`\n>>> 开始第 ${iteration} 批处理 <<<\n`);
    
    const isWindows = process.platform === 'win32';
    const command = 'node';
    const args = [
      '--expose-gc',
      `--max-old-space-size=${MEMORY_LIMIT}`,
      '-r',
      'tsx/cjs',
      'scripts/preprocess.ts'
    ];
    
    let output = '';
    const child = spawn(command, args, {
      shell: isWindows,
      env: { ...process.env, BATCH_SIZE }
    });
    
    // 捕获输出以检测是否还有待处理的书
    child.stdout.on('data', (data) => {
      const str = data.toString();
      output += str;
      process.stdout.write(str);
    });
    
    child.stderr.on('data', (data) => {
      process.stderr.write(data);
    });
    
    child.on('close', (code) => {
      if (code === 0) {
        // 检查输出中是否包含"还有X本书待处理"
        const hasMoreBooks = /还有\s+\d+\s+本书待处理/.test(output);
        resolve({ hasMoreBooks });
      } else {
        reject(new Error(`预处理退出码: ${code}`));
      }
    });
    
    child.on('error', (error) => {
      reject(error);
    });
  });
}

async function main() {
  const startTime = Date.now();
  
  try {
    const maxIterations = 10000; // 防护：最多10000批（理论上足够了）
    let hasMore = true;
    
    while (hasMore && iteration < maxIterations) {
      const result = await runPreprocess();
      hasMore = result.hasMoreBooks;
      
      if (hasMore) {
        console.log('\n⏳ 等待3秒后继续下一批...\n');
        await new Promise(resolve => setTimeout(resolve, 3000));
      } else {
        console.log('\n✅ 所有书籍处理完成！\n');
        break;
      }
    }
    
    if (iteration >= maxIterations) {
      console.warn('\n⚠️  已达到最大迭代次数限制，可能还有书籍未处理\n');
    }
    
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;
    
    console.log(`========================================`);
    console.log(`批处理完成！`);
    console.log(`共执行: ${iteration} 批`);
    console.log(`总耗时: ${minutes > 0 ? `${minutes}分${seconds}秒` : `${seconds}秒`}`);
    console.log(`========================================\n`);
    
  } catch (error) {
    console.error('\n❌ 批处理失败:', error.message);
    process.exit(1);
  }
}

main();
