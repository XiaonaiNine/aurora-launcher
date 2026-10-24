import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { runInstallJob, runVerifyJob, serializeJob } from './installer.js';
import { logger } from './logger.js';

/**
 * 长任务管理：安装、校验与修复。
 *
 * 每个任务持有独立的 AbortController，暂停与取消互不影响。状态通过
 * EventEmitter 广播，SSE 层订阅后直接推送，不做轮询。
 * 重试以同样的语义重新执行，下载器的快速通道会跳过已完成文件。
 */
export class JobManager extends EventEmitter {
  constructor(context) {
    super();
    this.setMaxListeners(50);
    this.ctx = context;
    this.jobs = new Map();
  }

  create({ type, versionId, options = {}, repair = false }) {
    const job = {
      id: `job_${crypto.randomBytes(5).toString('hex')}`,
      type, // install | verify | repair
      versionId,
      status: 'running',
      phase: 'pending',
      progress: null,
      error: null,
      failedTasks: [],
      result: null,
      createdAt: Date.now(),
      options,
      repair,
      controller: new AbortController(),
    };
    this.jobs.set(job.id, job);
    logger.info('job', `创建任务 ${job.id} (${type} ${versionId})`);
    this._run(job);
    return serializeJob(job);
  }

  async _run(job) {
    job.status = 'running';
    job.error = null;
    job.signal = job.controller.signal;
    const emit = (payload) => this.emit('event', payload);
    try {
      if (job.type === 'install') {
        await runInstallJob({ job, ctx: this.ctx, options: job.options, emit });
      } else {
        await runVerifyJob({ job, ctx: this.ctx, repair: job.repair, emit });
      }
    } catch (err) {
      job.status = 'error';
      job.error = err.message;
      emit({ type: 'error', job: serializeJob(job), message: err.message });
    }
  }

  get(id) {
    const job = this.jobs.get(id);
    return job ? serializeJob(job) : null;
  }

  list() {
    return [...this.jobs.values()].map(serializeJob).sort((a, b) => b.createdAt - a.createdAt);
  }

  /** 暂停：中断所有在途请求，.part 文件保留，下次继续 */
  pause(id) {
    const job = this.jobs.get(id);
    if (!job || job.status !== 'running') return null;
    job.controller.abort();
    job.status = 'paused';
    this.emit('event', { type: 'paused', job: serializeJob(job) });
    return serializeJob(job);
  }

  /** 继续：重跑同一任务，已完成文件走快速通道跳过 */
  resume(id) {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (!['paused', 'error', 'cancelled'].includes(job.status)) return serializeJob(job);
    job.controller = new AbortController();
    job.failedTasks = [];
    this._run(job);
    return serializeJob(job);
  }

  /** 取消：中断并标记，不留半成品版本 */
  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return null;
    job.controller.abort();
    job.status = 'cancelled';
    this.emit('event', { type: 'cancelled', job: serializeJob(job) });
    return serializeJob(job);
  }

  remove(id) {
    const job = this.jobs.get(id);
    if (job && job.status === 'running') this.cancel(id);
    this.jobs.delete(id);
    return true;
  }

  /** 清理已完成/已取消的历史任务，防止内存膨胀 */
  prune() {
    for (const [id, job] of this.jobs) {
      if (['done', 'cancelled', 'error'].includes(job.status) && Date.now() - job.createdAt > 3600_000) {
        this.jobs.delete(id);
      }
    }
  }
}
