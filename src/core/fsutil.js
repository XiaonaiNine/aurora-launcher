import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';

export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

export async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function statOf(p) {
  try {
    return await fsp.stat(p);
  } catch {
    return null;
  }
}

export async function sizeOf(p) {
  const st = await statOf(p);
  return st && st.isFile() ? st.size : -1;
}

/** 流式计算文件 SHA1，避免大文件（client.jar）整读进内存 */
export function sha1File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export function sha1Text(text) {
  return crypto.createHash('sha1').update(text).digest('hex');
}

/** 原子写入：先写 .tmp 再 rename，避免半截文件污染版本目录 */
export async function atomicWrite(file, data) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, data);
  await removeFile(file);
  await fsp.rename(tmp, file);
}

export async function readJson(file, fallback = null) {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export async function writeJson(file, obj) {
  await atomicWrite(file, JSON.stringify(obj, null, 2));
}

export async function removeFile(p) {
  try {
    await fsp.rm(p, { force: true });
  } catch {
    /* ignore */
  }
}

export async function removeDir(p) {
  try {
    await fsp.rm(p, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* ignore */
  }
}

export async function listDir(p) {
  try {
    return await fsp.readdir(p, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** 目录占用体积（用于展示"已安装版本占多少空间"） */
export async function dirSize(dir) {
  let total = 0;
  const entries = await listDir(dir);
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(full);
    else {
      const st = await statOf(full);
      if (st) total += st.size;
    }
  }
  return total;
}

/** 跨设备/占用时的安全移动 */
export async function moveSafe(from, to) {
  await ensureDir(path.dirname(to));
  try {
    await fsp.rename(from, to);
    return;
  } catch (err) {
    if (err.code !== 'EXDEV' && err.code !== 'EPERM' && err.code !== 'EEXIST') throw err;
    await removeFile(to);
    await fsp.copyFile(from, to);
    await removeFile(from);
  }
}

export function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  const v = n / Math.pow(1024, i);
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
