import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { ensureDir } from './fsutil.js';

/**
 * 极简 ZIP 读取器，只实现解压 natives 所需的能力。
 *
 * 目标产物是小体积、无 zip64、无加密的标准 ZIP，用 zlib.inflateRawSync
 * 解 deflate 段即可，因此不引入第三方解压库。
 */

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

function findEocd(buf) {
  const max = Math.min(buf.length, 66000);
  for (let i = buf.length - 22; i >= buf.length - max && i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

/** 列出 ZIP 条目 */
export function listEntries(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件');
  const total = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < total; i += 1) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== SIG_CENTRAL) break;
    const method = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const uncompSize = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen);
    entries.push({ name, method, compSize, uncompSize, localOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntryData(buf, entry) {
  const lo = entry.localOffset;
  if (lo + 30 > buf.length || buf.readUInt32LE(lo) !== SIG_LOCAL) throw new Error(`条目头损坏: ${entry.name}`);
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const start = lo + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compSize);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`不支持的压缩方式 ${entry.method}: ${entry.name}`);
}

/**
 * 解压 jar 到目录（跳过 exclude 前缀与目录项）。
 * @returns {Promise<number>} 解压出的文件数
 */
export async function extractJar(jarFile, destDir, exclude = ['META-INF/']) {
  const buf = await fsp.readFile(jarFile);
  const entries = listEntries(buf);
  await ensureDir(destDir);
  let count = 0;
  for (const entry of entries) {
    if (entry.name.endsWith('/')) continue;
    if (exclude.some((p) => entry.name.startsWith(p))) continue;
    // 防目录穿越
    const safeRel = entry.name.replace(/\\/g, '/').split('/').filter((s) => s && s !== '..').join(path.sep);
    if (!safeRel) continue;
    const target = path.join(destDir, safeRel);
    await ensureDir(path.dirname(target));
    await fsp.writeFile(target, readEntryData(buf, entry));
    count += 1;
  }
  return count;
}

export default { extractJar, listEntries };
