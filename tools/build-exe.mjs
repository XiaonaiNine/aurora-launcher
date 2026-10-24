/**
 * 打包为 Windows 便携版。
 *
 * 不使用 electron-builder 或 NSIS，直接组装官方 Electron 运行时与应用代码：
 *
 *   dist/Aurora Launcher/
 *     Aurora Launcher.exe        由 electron.exe 改名
 *     resources/app/             Electron 自动加载此目录
 *       main.cjs, package.json, icon.ico, src/
 *     data/                      首次运行时创建
 *
 * 用法：
 *   node tools/make-icon.mjs    生成图标（仓库已带一份，可选）
 *   node tools/build-exe.mjs
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const WORKSPACE = path.resolve(ROOT, '..');
const ELECTRON_DIR = path.join(WORKSPACE, '.build', 'electron');
const RCEDIT = path.join(WORKSPACE, '.build', 'rcedit', 'package', 'bin', 'rcedit-x64.exe');
const OUT_DIR = path.join(ROOT, 'dist', 'Aurora Launcher');
const APP_DIR = path.join(OUT_DIR, 'resources', 'app');
const EXE_NAME = 'Aurora Launcher.exe';
const APP_VERSION = '1.0.0';

const step = (m) => console.log(`\x1b[36m▸\x1b[0m ${m}`);
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

async function dirSize(dir) {
  let total = 0;
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(full);
    else total += (await fsp.stat(full)).size;
  }
  return total;
}

/* ---------------- 前置检查 ---------------- */
if (!fs.existsSync(path.join(ELECTRON_DIR, 'electron.exe'))) {
  console.error(
    `\x1b[31m✗ 找不到 Electron 运行时\x1b[0m\n  期望路径: ${ELECTRON_DIR}\n\n` +
      `  请先下载并解压：\n` +
      `    curl -L -o .build/electron.zip https://cdn.npmmirror.com/binaries/electron/38.0.0/electron-v38.0.0-win32-x64.zip\n` +
      `    然后解压到 .build/electron\n`
  );
  process.exit(1);
}

/* ---------------- 1. 复制 Electron 运行时 ---------------- */
step(`清理输出目录 ${path.relative(WORKSPACE, OUT_DIR)}`);
await fsp.rm(OUT_DIR, { recursive: true, force: true });
await fsp.mkdir(OUT_DIR, { recursive: true });

step('复制 Electron 运行时');
await fsp.cp(ELECTRON_DIR, OUT_DIR, { recursive: true });

/* ---------------- 2. 放入应用代码 ---------------- */
step('移除默认应用，装入 Aurora Launcher');
await fsp.rm(path.join(OUT_DIR, 'resources', 'default_app.asar'), { force: true });
await fsp.mkdir(APP_DIR, { recursive: true });

const appFiles = [
  ['electron/package.json', 'package.json'],
  ['electron/main.cjs', 'main.cjs'],
  ['build/icon.ico', 'icon.ico'],
];
for (const [from, to] of appFiles) {
  const src = path.join(ROOT, from);
  if (!fs.existsSync(src)) throw new Error(`缺少文件: ${from}`);
  await fsp.copyFile(src, path.join(APP_DIR, to));
}

// 后端与界面代码（src 内含 package.json，声明 type=module）
await fsp.cp(path.join(ROOT, 'src'), path.join(APP_DIR, 'src'), { recursive: true });

// 便携目录附一份简短说明
await fsp.writeFile(
  path.join(OUT_DIR, '使用说明.txt'),
  [
    'Aurora Launcher（极光启动器）· 便携版',
    '',
    '■ 启动',
    '  双击 "Aurora Launcher.exe" 即可，无需安装 Node.js 或其他运行环境。',
    '',
    '■ 数据位置',
    '  首次启动会在本文件同级创建 data/ 目录，存放 versions / libraries / assets /',
    '  runtime 与配置文件。整个文件夹拷到别处即可迁移，删除 data/ 即恢复初始状态。',
    '',
    '  data/ 里的 versions、libraries、assets 遵循官方 .minecraft 结构，',
    '  如果已有官方启动器的游戏目录，也可以把 data/ 换成指向它的符号链接。',
    '',
    '■ 运行要求',
    '  · Windows 10 / 11 64 位',
    '  · 启动游戏需要 Java：本机没有合适版本时，启动器会自动下载 Mojang 官方运行时',
    '',
    '■ 常见问题',
    '  · 下载慢或频繁失败：设置 → 下载源 → 仅镜像（国内加速）',
    '  · 启动报错：查看主界面底部「运行日志」，或 data/logs/ 下的日志文件',
    '  · 只想要能启动：下载版本时取消勾选「下载完整游戏资源」，之后可用「校验并修复」补齐',
    '',
    '■ 界面起不来时',
    '  · 程序会自动切换渲染模式并重启（硬件加速 → 软件渲染 → 关闭 Chromium 沙箱），',
    '    最多重启两次即可正常显示，无需手动干预。',
    '  · 启动过程记录在同级 aurora-boot.log，反馈问题时可一并提供。',
    '  · 想复位渲染设置：删除 data/compat.json（下次启动重新从硬件加速开始尝试）。',
    '',
    `构建时间：${new Date().toISOString()}`,
    '',
  ].join('\r\n'),
  'utf8'
);

/* ---------------- 3. 重命名可执行文件 ---------------- */
step(`重命名 electron.exe -> ${EXE_NAME}`);
const exePath = path.join(OUT_DIR, EXE_NAME);
await fsp.rename(path.join(OUT_DIR, 'electron.exe'), exePath);

/* ---------------- 4. 写入图标与版本信息 ---------------- */
/**
 * Electron 自带的 exe 里是 Electron 的原子图标和 "Electron" 版本信息，
 * 不改的话资源管理器里一眼就能看出是套壳。用 rcedit 把 PE 资源换掉。
 * 没有 rcedit 也不影响运行，只是图标和属性页保持原样。
 */
const icoPath = path.join(ROOT, 'build', 'icon.ico');
if (fs.existsSync(RCEDIT) && fs.existsSync(icoPath)) {
  step('写入图标与版本信息');
  const args = [
    exePath,
    '--set-icon',
    icoPath,
    '--set-file-version',
    APP_VERSION,
    '--set-product-version',
    APP_VERSION,
    // 版本字符串用纯 ASCII：rcedit 在中文 locale 下传非 ASCII 参数容易乱码
    '--set-version-string',
    'ProductName',
    'Aurora Launcher',
    '--set-version-string',
    'FileDescription',
    'Aurora Launcher - Minecraft Launcher',
    '--set-version-string',
    'CompanyName',
    'Aurora',
    '--set-version-string',
    'LegalCopyright',
    'MIT License',
    '--set-version-string',
    'OriginalFilename',
    EXE_NAME,
    '--set-version-string',
    'InternalName',
    'Aurora Launcher',
  ];
  try {
    execFileSync(RCEDIT, args, { stdio: 'pipe' });
    console.log(`  图标已嵌入 ${path.relative(WORKSPACE, icoPath)}`);
  } catch (err) {
    console.warn(`\x1b[33m! rcedit 执行失败，跳过图标写入：${err.message}\x1b[0m`);
  }
} else {
  console.warn(`\x1b[33m! 未找到 rcedit 或图标，跳过 PE 资源替换\x1b[0m`);
  console.warn(`  rcedit: ${RCEDIT}`);
  console.warn(`  icon  : ${icoPath}`);
}

/* ---------------- 5. 汇报 ---------------- */
const size = await dirSize(OUT_DIR);
const exeSize = (await fsp.stat(exePath)).size;
const appSize = await dirSize(APP_DIR);

console.log('');
console.log(`\x1b[32m✔ 打包完成\x1b[0m`);
console.log(`  输出目录  ${OUT_DIR}`);
console.log(`  可执行    ${EXE_NAME}  ${mb(exeSize)}`);
console.log(`  应用代码  ${kb(appSize)}`);
console.log(`  总计      ${mb(size)}`);
console.log('');
console.log(`  双击运行，或命令行：`);
console.log(`    "${path.join(OUT_DIR, EXE_NAME)}"`);
console.log('');
