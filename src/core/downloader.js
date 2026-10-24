import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { NET, TASK_KIND, KIND_LABEL } from '../shared/constants.js';
import { AbortError, NetError, pickUrl, rawFetch, sleep } from './net.js';
import { ensureDir, removeFile, sha1File, sizeOf, statOf } from './fsutil.js';
import { logger } from './logger.js';

/**
 * 并发下载器。
 *
 * 已存在且校验通过的文件直接跳过；写入 .part 并按 Range 续传，服务器不支持
 * Range 时从头重下；单文件失败按策略重试并切换镜像，整体失败保留 .part。
 */
export class Downloader {
  constructor({
    concurrency = NET.concurrency,
    mirrorMode = 'auto',
    verifyMode = 'strict',
    retries = NET.retries,
    timeout = NET.timeout,
    onProgress = null,
    onFile = null,
  } = {}) {
    this.concurrency = Math.max(1, Math.min(concurrency, NET.maxConcurrency));
    this.mirrorMode = mirrorMode;
    this.verifyMode = verifyMode;
    this.retries = Math.max(1, retries);
    this.timeout = timeout;
    this.onProgress = onProgress;
    this.onFile = onFile;

    this.files = new Map();
    this.samples = [];
    this.lastEmit = 0;
    this.emitTimer = null;
  }

  /**
   * @param {Array} tasks 计划中的下载任务
   * @param {object} opts { signal, label }
   * @returns {Promise<{ok:boolean, aborted:boolean, stats:object}>}
   */
  async run(tasks, { signal, label = '下载' } = {}) {
    const stats = {
      total: tasks.length,
      completed: 0,
      skipped: 0,
      failed: 0,
      active: 0,
      bytesTotal: tasks.reduce((s, t) => s + (t.size || 0), 0),
      /** 已完成文件贡献的字节数（不包含在途文件） */
      bytesBase: 0,
      /** 仅统计"真正从网络下载"的字节，用于计算速度为：跳过/校验命中不应算作网速 */
      speedBase: 0,
      /** 对外展示的进度 = bytesBase + 在途文件已接收字节，由 _emit 计算 */
      bytesDone: 0,
      failedTasks: [],
      startedAt: Date.now(),
    };

    if (tasks.length === 0) {
      this._emit(stats, true);
      return { ok: true, aborted: false, stats };
    }

    // 预登记，便于 UI 立刻看到文件清单
    for (const t of tasks) {
      this.files.set(taskId(t), {
        label: t.label || path.basename(t.dest),
        kind: t.kind,
        kindLabel: KIND_LABEL[t.kind] || t.kind,
        size: t.size || 0,
        received: 0,
        status: 'pending',
      });
    }

    logger.info('download', `${label} 开始：${tasks.length} 个文件 / ${(stats.bytesTotal / 1048576).toFixed(1)} MB，并发 ${this.concurrency}`);

    // 立刻推一帧，让 UI 在切换阶段时马上显示新批次的总量，而不是沿用上一批的数字
    this.lastEmit = 0;
    this._emit(stats, true);

    let cursor = 0;
    let fatalError = null;

    const worker = async () => {
      while (true) {
        if (signal?.aborted) return;
        if (fatalError) return;
        const i = cursor++;
        if (i >= tasks.length) return;
        const task = tasks[i];
        const state = this.files.get(taskId(task));
        stats.active += 1;

        try {
          const result = await this._runTask(task, { signal, stats, state });
          // 统一口径：只有"文件完成"才计入 bytesBase，在途字节由 _emit 单独累加
          stats.bytesBase += task.size || state.received || 0;
          if (result === 'skipped') {
            stats.skipped += 1;
            state.status = 'skipped';
          } else {
            stats.completed += 1;
            stats.speedBase += task.size || state.received || 0;
            state.status = 'done';
          }
          this.onFile?.({ id: taskId(task), label: state.label, status: state.status, kind: task.kind });
        } catch (err) {
          if (isAbort(err)) {
            state.status = 'pending';
            return;
          }
          stats.failed += 1;
          state.status = 'failed';
          state.error = err.message;
          stats.failedTasks.push({
            label: state.label,
            kind: task.kind,
            url: task.url,
            dest: task.dest,
            error: err.message,
          });
          this.onFile?.({ id: taskId(task), label: state.label, status: 'failed', error: err.message, kind: task.kind });
          logger.error('download', `文件失败 ${state.label}: ${err.message}`);
          // 连续大量失败通常意味着整体网络不可用，早停避免刷屏
          if (stats.failed >= 12 && stats.completed === 0) {
            fatalError = new Error('连续失败过多，请检查网络连接或切换下载源');
          }
        } finally {
          stats.active -= 1;
          this._emit(stats);
        }
      }
    };

    const workers = Array.from({ length: Math.min(this.concurrency, tasks.length) }, () => worker());
    await Promise.all(workers);
    this._flush(stats, true);

    const aborted = Boolean(signal?.aborted);
    if (fatalError && !aborted) {
      return { ok: false, aborted: false, stats, error: fatalError };
    }
    const ok = stats.failed === 0;
    logger.info(
      'download',
      `${label} 结束：完成 ${stats.completed}，跳过 ${stats.skipped}，失败 ${stats.failed}，耗时 ${((Date.now() - stats.startedAt) / 1000).toFixed(1)}s`
    );
    return { ok, aborted, stats };
  }

  async _runTask(task, ctx) {
    // ---- 幂等快速通道 ----
    const st = await statOf(task.dest);
    if (st && st.isFile()) {
      const valid = await this._verifyExisting(task, st.size, ctx.signal);
      if (valid) return 'skipped';
      logger.warn('download', `${task.label} 校验不通过，重新下载`);
      await removeFile(task.dest);
    }

    await this._downloadWithRetry(task, ctx);
    return 'done';
  }

  async _verifyExisting(task, size, signal) {
    if (task.size > 0 && size !== task.size) return false;
    if (!task.sha1) return size > 0;
    if (this.verifyMode === 'fast') return task.size > 0 ? size === task.size : true;
    if (signal?.aborted) throw new AbortError();
    const actual = await sha1File(task.dest);
    return actual.toLowerCase() === String(task.sha1).toLowerCase();
  }

  async _downloadWithRetry(task, ctx) {
    let lastError = null;
    for (let attempt = 1; attempt <= this.retries; attempt += 1) {
      if (ctx.signal?.aborted) throw new AbortError();
      try {
        await this._downloadOnce(task, ctx, attempt);
        const actual = await sha1File(task.dest);
        if (task.sha1 && actual.toLowerCase() !== String(task.sha1).toLowerCase()) {
          await removeFile(task.dest);
          throw new NetError('SHA1 校验失败', { retryable: true });
        }
        return;
      } catch (err) {
        if (isAbort(err)) throw err;
        lastError = err;
        const retryable = err instanceof NetError ? err.retryable : true;
        if (!retryable) break;
        // 403/404 多为 CDN 限流或边缘节点抖动：值得重试，但次数减半以免拖慢整体
        const cap = err.status === 404 || err.status === 403 ? Math.min(this.retries, 2) : this.retries;
        if (attempt >= cap) break;
        const delay = Math.min(NET.backoffBase * 2 ** (attempt - 1), 6000) * (0.7 + Math.random() * 0.6);
        logger.warn('download', `${task.label} 第 ${attempt} 次失败(${err.message})，${Math.round(delay)}ms 后重试`);
        await sleep(delay, ctx.signal);
      }
    }
    throw lastError || new Error('下载失败');
  }

  async _downloadOnce(task, ctx, attempt) {
    const self = this;
    const part = `${task.dest}.part`;
    await ensureDir(path.dirname(task.dest));

    // ---- 断点续传准备 ----
    let start = 0;
    const partSize = await sizeOf(part);
    if (partSize > 0) {
      if (task.size > 0 && partSize < task.size) start = partSize;
      else if (task.size === 0) start = partSize;
      else await removeFile(part);
    }

    const url = pickUrl(task.url, attempt, this.mirrorMode);
    if (attempt > 1 && url !== task.url) logger.info('download', `${task.label} 切换到镜像源`);

    const res = await rawFetch(url, {
      signal: ctx.signal,
      timeout: this.timeout,
      headers: start > 0 ? { Range: `bytes=${start}-` } : {},
    });

    if (res.status === 416) {
      await removeFile(part);
      throw new NetError('断点位置无效，重新下载', { retryable: true, status: 416, url });
    }
    if (!res.ok) {
      // 403/404 在 CDN 上常常是限流或边缘节点抖动，不是真正的"文件不存在"，因此也纳入重试
      const transient = res.status === 403 || res.status === 404;
      throw new NetError(`HTTP ${res.status}`, {
        retryable: transient || res.status === 408 || res.status === 429 || res.status >= 500,
        status: res.status,
        url,
      });
    }

    // 服务器忽略 Range 时必须从 0 覆盖写，否则文件会拼接错位
    let writeStart = start;
    if (start > 0 && res.status !== 206) {
      logger.warn('download', `${task.label} 服务器不支持断点续传，改为完整下载`);
      writeStart = 0;
      await removeFile(part);
    }

    const state = ctx.state;
    state.status = 'downloading';
    state.received = writeStart;
    this.onFile?.({ id: taskId(task), label: state.label, status: 'downloading', kind: task.kind });

    const expected = res.headers.get('content-length');
    let received = 0;

    if (!res.body) {
      // 极少数环境没有流式 body，退回缓冲写入
      const buf = Buffer.from(await res.arrayBuffer());
      await fsp.writeFile(part, buf, { flag: writeStart > 0 ? 'a' : 'w' });
      received = buf.length;
    } else {
      const stats = ctx.stats;
      const counter = new Transform({
        transform(chunk, _enc, cb) {
          received += chunk.length;
          state.received = writeStart + received;
          // _emit 内部节流到 ~160ms，逐块调用可让大文件下载期间进度条持续前进
          self._emit(stats);
          cb(null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(res.body),
        counter,
        fs.createWriteStream(part, { flags: writeStart > 0 ? 'a' : 'w' })
      );
      this._emit(ctx.stats);
    }

    if (expected && Number(expected) !== received) {
      throw new NetError(`传输中断（期望 ${expected} 字节，实际 ${received}）`, { retryable: true, url });
    }

    // 原子落位：先校验后改名，避免半截文件被后续"快速通道"误判为有效
    await removeFile(task.dest);
    await fsp.rename(part, task.dest);
  }

  _emit(stats, force = false) {
    if (!this.onProgress) return;
    const now = Date.now();
    if (!force && now - this.lastEmit < NET.progressInterval) return;
    this.lastEmit = now;

    // 在途文件已接收的字节：让进度条在大文件下载期间也能平滑前进
    let live = 0;
    const active = [];
    for (const [id, f] of this.files) {
      if (f.status !== 'downloading') continue;
      live += f.received || 0;
      if (active.length < 8) {
        active.push({ id, label: f.label, kindLabel: f.kindLabel, received: f.received, size: f.size });
      }
    }
    const bytesDone = stats.bytesTotal > 0 ? Math.min(stats.bytesBase + live, stats.bytesTotal) : stats.bytesBase + live;
    stats.bytesDone = bytesDone;
    // 速度只按真实网络流量算，避免"校验命中/跳过"的文件把网速算成几百 MB/s
    const speedBytes = stats.speedBase + live;

    this.samples.push({ t: now, b: speedBytes });
    while (this.samples.length > 2 && now - this.samples[0].t > 3000) this.samples.shift();
    const first = this.samples[0];
    const dt = (now - first.t) / 1000;
    const speed = dt > 0.2 ? Math.max(0, (speedBytes - first.b) / dt) : 0;

    const remaining = Math.max(0, stats.bytesTotal - bytesDone);
    const percent = stats.bytesTotal > 0 ? Math.min(100, (bytesDone / stats.bytesTotal) * 100) : 0;

    this.onProgress({
      ...stats,
      percent,
      speed,
      eta: speed > 1024 ? Math.round(remaining / speed) : null,
      files: active,
      failedTasks: stats.failedTasks.slice(-10),
    });
  }

  _flush(stats, force) {
    if (this.emitTimer) {
      clearTimeout(this.emitTimer);
      this.emitTimer = null;
    }
    this._emit(stats, force);
  }
}

function taskId(task) {
  return `${task.kind}:${task.dest}`;
}

export function isAbort(err) {
  return err?.name === 'AbortError' || err?.aborted === true || err?.code === 'ABORT_ERR';
}

export { TASK_KIND };
