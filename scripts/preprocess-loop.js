/**
 * 循环调用预处理脚本，直到所有书籍处理完成
 * 每批处理完退出进程，彻底释放内存
 */
const { spawn } = require('child_process');
const fs = require('fs-extra');
const path = require('path');

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

console.log('========================================');
console.log('自动批处理模式');
console.log(`批次大小: ${batchSize} 本/批`);
console.log(`内存限制: ${memoryLimit}MB`);
console.log('========================================\n');

const pendingListPath = path.resolve('generated', 'pending_books.json');
let iteration = 0;
const startTime = Date.now();

function runPreprocess() {
  return new Promise((resolve, reject) => {
    iteration++;
    console.log(`\n>>> 第 ${iteration} 批 <<<\n`);
    
    const isWindows = process.platform === 'win32';
    const command = 'node';
    const spawnArgs = [
      '--expose-gc',
      `--max-old-space-size=${memoryLimit}`,
      '-r',
      'tsx/cjs',
      'scripts/preprocess.ts'
    ];
    
    const child = spawn(command, spawnArgs, {
      stdio: 'inherit',
      shell: isWindows,
      env: { ...process.env, BATCH_SIZE: batchSize }
    });
    
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
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
  try {
    const maxIterations = 1000; // 防护
    
    while (iteration < maxIterations) {
      await runPreprocess();
      
      // 检查是否还有待处理的书籍
      const hasPending = await fs.pathExists(pendingListPath);
      
      if (!hasPending) {
        console.log('\n✅ 所有书籍已处理完成！\n');
        break;
      }
      
      // 等待3秒后继续下一批
      console.log('\n⏳ 等待3秒后继续下一批...\n');
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
    
    if (iteration >= maxIterations) {
      console.warn('\n⚠️  已达到最大迭代次数限制\n');
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
