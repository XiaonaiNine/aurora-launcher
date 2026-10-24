import { execFile } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { promisify } from 'node:util';
import { TASK_KIND } from '../shared/constants.js';
import { ensureDir, exists, listDir } from './fsutil.js';
import { Downloader } from './downloader.js';
import { logger } from './logger.js';

const exec = promisify(execFile);

/** 各平台 Java 可执行文件名与常见安装位置 */
function javaBinaryName() {
  return process.platform === 'win32' ? 'java.exe' : 'java';
}

function runtimePlatformKey() {
  if (process.platform === 'win32') return process.arch === 'ia32' ? 'windows-x86' : 'windows-x64';
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'mac-os-arm64' : 'mac-os';
  return process.arch === 'ia32' ? 'linux-i386' : 'linux';
}

/** 解析 `java -version` 输出里的主版本号（1.8.0_301 -> 8，25.0.3 -> 25） */
export function parseJavaMajor(text) {
  const m = text.match(/version\s+"([^"]+)"/i) || text.match(/openjdk\s+([\d._]+)/i);
  if (!m) return 0;
  const raw = m[1];
  const parts = raw.split(/[._\-+]/);
  if (parts[0] === '1') return Number(parts[1]) || 0;
  return Number(parts[0]) || 0;
}

/**
 * 探测单个 Java：返回 { path, major, vendor, raw }
 */
export async function probeJava(javaPath) {
  try {
    const { stderr, stdout } = await exec(javaPath, ['-version'], { timeout: 8000, windowsHide: true });
    const text = `${stderr}\n${stdout}`;
    const major = parseJavaMajor(text);
    if (!major) return null;
    const vendorMatch = text.match(/(OpenJDK|Zulu|Temurin|Adoptium|Microsoft|Oracle|GraalVM|Corretto)/i);
    return {
      path: javaPath,
      major,
      vendor: vendorMatch ? vendorMatch[1] : 'Unknown',
      raw: text.trim().split('\n')[0],
    };
  } catch {
    return null;
  }
}

/** 生成候选路径列表（PATH 之外再扫一遍常见安装目录） */
function candidatePaths(rootDir) {
  const exe = javaBinaryName();
  const list = [];
  if (process.platform === 'win32') {
    const roots = [
      process.env['ProgramFiles'] || 'C:\\Program Files',
      process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
      process.env['LOCALAPPDATA'] ? path.join(process.env['LOCALAPPDATA'], 'Programs') : null,
      'C:\\Program Files\\Zulu',
      'C:\\Program Files\\Eclipse Adoptium',
      'C:\\Program Files\\Microsoft',
      'D:\\Program Files',
    ].filter(Boolean);
    const vendors = ['Java', 'Zulu', 'Eclipse Adoptium', 'Microsoft', 'Amazon Corretto', 'BellSoft', 'Semeru'];
    for (const r of roots) {
      for (const v of vendors) {
        const base = path.join(r, v);
        if (!fs.existsSync(base)) continue;
        // 只扫两层，避免大目录递归卡顿
        for (const dirent of safeReaddir(base)) {
          list.push(path.join(base, dirent, 'bin', exe));
          for (const d2 of safeReaddir(path.join(base, dirent))) {
            list.push(path.join(base, dirent, d2, 'bin', exe));
          }
        }
      }
    }
  } else if (process.platform === 'darwin') {
    list.push(
      '/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home/bin/java',
      '/usr/bin/java',
      '/opt/homebrew/bin/java'
    );
    for (const d of safeReaddir('/Library/Java/JavaVirtualMachines')) {
      list.push(path.join('/Library/Java/JavaVirtualMachines', d, 'Contents/Home/bin/java'));
    }
  } else {
    list.push('/usr/bin/java', '/usr/local/bin/java', '/opt/java/bin/java');
    for (const d of safeReaddir('/usr/lib/jvm')) list.push(path.join('/usr/lib/jvm', d, 'bin/java'));
  }
  // 启动器自己下载的 Mojang 运行时
  for (const comp of safeReaddir(path.join(rootDir, 'runtime'))) {
    for (const plat of safeReaddir(path.join(rootDir, 'runtime', comp))) {
      list.push(path.join(rootDir, 'runtime', comp, plat, 'bin', exe));
    }
  }
  return [...new Set(list)];
}

function safeReaddir(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/**
 * 扫描本机所有可用 Java，按"是否满足需求"排序。
 * @param {number} requiredMajor 版本要求的 Java 主版本
 */
export async function detectJavaInstalled(rootDir, requiredMajor = 0) {
  const found = [];
  const seen = new Set();

  const candidates = [
    process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', javaBinaryName()) : null,
    ...candidatePaths(rootDir),
    javaBinaryName(), // PATH 中的 java
  ].filter(Boolean);

  for (const c of candidates) {
    const key = c.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (c !== javaBinaryName() && !(await exists(c))) continue;
    const info = await probeJava(c);
    if (info) found.push(info);
  }

  found.sort((a, b) => {
    const aOk = a.major === requiredMajor ? 0 : a.major > requiredMajor ? 1 : 2;
    const bOk = b.major === requiredMajor ? 0 : b.major > requiredMajor ? 1 : 2;
    if (aOk !== bOk) return aOk - bOk;
    return b.major - a.major;
  });
  return found;
}

/** 从已下载的运行时里定位 java 可执行文件 */
export async function resolveRuntimeJava(rootDir, component) {
  const platform = runtimePlatformKey();
  const base = path.join(rootDir, 'runtime', component, platform);
  const exe = path.join(base, 'bin', javaBinaryName());
  if (await exists(exe)) return exe;
  return null;
}

/**
 * 下载 Mojang 官方 Java 运行时（用户机器没有合适 JDK 时的兜底方案）。
 * @returns {Promise<string>} java 可执行文件路径
 */
export async function installJavaRuntime({ api, paths, component, signal, onProgress }) {
  const platform = runtimePlatformKey();
  const { data: all } = await api.javaRuntimeManifest();
  const platformData = all?.[platform];
  if (!platformData) throw new Error(`Mojang 未提供当前平台的 Java 运行时（${platform}）`);

  const comp = platformData[component];
  if (!comp || !comp.length) {
    // 回退：找一个可用的
    const fallback = Object.keys(platformData)[0];
    if (!fallback) throw new Error(`找不到 Java 运行时组件 ${component}`);
    logger.warn('java', `运行时 ${component} 不可用，回退到 ${fallback}`);
    return installJavaRuntime({ api, paths, component: fallback, signal, onProgress });
  }

  const { manifest } = comp[0];
  logger.info('java', `下载 Java 运行时 ${component} (${comp[0].version?.name || ''})`);
  const { fetchJson } = await import('./net.js');
  const manifestData = await fetchJson(manifest.url, { signal, label: 'Java 运行时清单' });

  const base = path.join(paths.runtime, component, platform);
  await ensureDir(base);

  const tasks = [];
  for (const [rel, info] of Object.entries(manifestData.files || {})) {
    if (info.type === 'directory') {
      await ensureDir(path.join(base, rel));
      continue;
    }
    if (info.type === 'link') continue;
    const dl = info.downloads?.raw;
    if (!dl) continue;
    tasks.push({
      kind: TASK_KIND.JAVA,
      url: dl.url,
      dest: path.join(base, ...rel.split('/')),
      sha1: dl.sha1,
      size: dl.size,
      label: rel,
    });
  }

  const downloader = new Downloader({
    concurrency: 6,
    mirrorMode: 'official', // Mojang 运行时镜像支持不稳定，固定走官方
    verifyMode: 'strict',
    onProgress,
  });
  const res = await downloader.run(tasks, { signal, label: 'Java 运行时' });
  if (!res.ok) throw res.error || new Error('Java 运行时下载失败');

  // 恢复可执行权限（macOS/Linux 必需）
  if (process.platform !== 'win32') {
    const binDir = path.join(base, 'bin');
    for (const f of await listDir(binDir)) {
      try {
        fs.chmodSync(path.join(binDir, f.name), 0o755);
      } catch {
        /* ignore */
      }
    }
  }

  const exe = await resolveRuntimeJava(paths.root, component);
  if (!exe) throw new Error('Java 运行时下载完成但未找到可执行文件');
  logger.info('java', `Java 运行时就绪: ${exe}`);
  return exe;
}
