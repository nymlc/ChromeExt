#!/usr/bin/env node
/**
 * 极客百宝箱 - Chrome 扩展打包脚本
 * 用法: npm run build / npm run build:keep (不递增版本号)
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ---- 颜色 ----
const c = {
  green: s => `\x1b[32m${s}\x1b[0m`,
  cyan: s => `\x1b[36m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  red: s => `\x1b[31m${s}\x1b[0m`,
};

const ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(ROOT, 'manifest.json');
const DIST_DIR = path.join(ROOT, 'dist');

// 需要排除的文件/目录模式
const EXCLUDES = [
  '.git',
  '.gitignore',
  '.vscode',
  '.idea',
  '.tool-versions',
  '.DS_Store',
  'dist',
  'node_modules',
  'scripts',
  'package.json',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  '*.py',
  '__pycache__',
  '*.zip',
  '*.crx',
  '*.pem',
  '*.log',
  'tmp',
  'temp',
  'build.sh',
];

// ---- 读取 manifest ----
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
const oldVersion = manifest.version;

console.log(c.cyan('📦 极客百宝箱 - 打包工具'));
console.log(c.cyan(`   当前版本: v${oldVersion}`));
console.log('');

// ---- 版本号处理 ----
const noBump = process.argv.includes('--no-version-bump');

if (!noBump) {
  const parts = oldVersion.split('.').map(Number);
  parts[2] = (parts[2] || 0) + 1;
  manifest.version = parts.join('.');
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  console.log(c.green(`✅ 版本号已更新: v${oldVersion} → v${manifest.version}`));
} else {
  console.log(c.yellow('⏭  跳过版本号递增'));
}

const version = manifest.version;

// ---- 清理旧产物 ----
if (fs.existsSync(DIST_DIR)) {
  fs.rmSync(DIST_DIR, { recursive: true });
}
fs.mkdirSync(DIST_DIR, { recursive: true });

// ---- 收集文件 ----
console.log(c.cyan('📁 正在收集文件...'));

function shouldExclude(relativePath) {
  const basename = path.basename(relativePath);
  const parts = relativePath.split(path.sep);

  for (const pattern of EXCLUDES) {
    // 通配符匹配 *.ext
    if (pattern.startsWith('*.')) {
      const ext = pattern.slice(1);
      if (basename.endsWith(ext)) return true;
    }
    // 精确匹配目录名或文件名
    if (parts.includes(pattern) || basename === pattern) return true;
  }
  return false;
}

function collectFiles(dir, base) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = path.join(base, entry.name);
    if (shouldExclude(rel)) continue;

    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(full, rel));
    } else {
      results.push({ full, rel });
    }
  }
  return results;
}

const files = collectFiles(ROOT, '.');

// ---- 打包为 zip ----
const zipName = `GeekToolbox_v${version}.zip`;
const zipPath = path.join(DIST_DIR, zipName);

// 构建 zip 命令（用系统自带的 zip 命令，Mac/Linux 均可）
const fileList = files.map(f => f.rel).join('\n');
const listFile = path.join(DIST_DIR, '.filelist.tmp');
fs.writeFileSync(listFile, fileList, 'utf-8');

try {
  execSync(`cd "${ROOT}" && cat "${listFile}" | zip "${zipPath}" -@`, { stdio: 'pipe' });
} catch (err) {
  console.error(c.red('❌ 打包失败: ' + err.message));
  process.exit(1);
} finally {
  fs.unlinkSync(listFile);
}

// ---- 输出结果 ----
const stat = fs.statSync(zipPath);
const sizeKB = (stat.size / 1024).toFixed(1);
const sizeMB = (stat.size / 1024 / 1024).toFixed(2);
const sizeStr = stat.size > 1024 * 1024 ? `${sizeMB} MB` : `${sizeKB} KB`;

console.log('');
console.log(c.green('══════════════════════════════════════'));
console.log(c.green('  ✅ 打包成功！'));
console.log(c.green('══════════════════════════════════════'));
console.log(`  📄 文件: ${c.cyan('dist/' + zipName)}`);
console.log(`  📏 大小: ${c.cyan(sizeStr)}`);
console.log(`  📂 包含: ${c.cyan(files.length + ' 个文件')}`);
console.log(`  🏷  版本: ${c.cyan('v' + version)}`);
console.log('');
console.log(c.yellow('💡 提示: 在 Chrome 扩展管理页面 → 加载已解压的扩展程序'));
console.log(c.yellow('   或直接将 .zip 上传到 Chrome Web Store'));
