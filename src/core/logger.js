import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from './fsutil.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const COLORS = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' };

/**
 * 结构化日志：同时输出到控制台、内存环形缓冲（供界面拉取）与磁盘文件（按天切分）。
 * 下载与鉴权问题依靠 traceId 与重试记录定位。
 */
class Logger {
  constructor() {
    this.buffer = [];
    this.limit = 800;
    this.level = process.env.AURORA_LOG_LEVEL || 'info';
    this.stream = null;
    this.file = null;
  }

  attach(rootDir) {
    const dir = path.join(rootDir, 'logs');
    ensureDir(dir).then(() => {
      this.file = path.join(dir, `launcher-${new Date().toISOString().slice(0, 10)}.log`);
      this.stream = fs.createWriteStream(this.file, { flags: 'a' });
    }).catch(() => {});
  }

  log(level, scope, ...args) {
    if ((LEVELS[level] ?? 20) < (LEVELS[this.level] ?? 20)) return;
    const time = new Date().toISOString();
    const msg = args
      .map((a) => (typeof a === 'string' ? a : safeJson(a)))
      .join(' ');
    const line = { time, level, scope, msg };
    this.buffer.push(line);
    if (this.buffer.length > this.limit) this.buffer.shift();
    const color = COLORS[level] || '';
    process.stdout.write(`${color}[${time.slice(11, 23)}] ${level.toUpperCase().padEnd(5)} ${scope}\x1b[0m ${msg}\n`);
    if (this.stream) this.stream.write(`${JSON.stringify(line)}\n`);
  }

  debug(scope, ...a) { this.log('debug', scope, ...a); }
  info(scope, ...a) { this.log('info', scope, ...a); }
  warn(scope, ...a) { this.log('warn', scope, ...a); }
  error(scope, ...a) { this.log('error', scope, ...a); }

  recent(n = 300) {
    return this.buffer.slice(-n);
  }
}

function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export const logger = new Logger();
