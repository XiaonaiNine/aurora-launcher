import path from 'node:path';
import fs from 'node:fs/promises';
import { TASK_KIND, KIND_LABEL } from '../shared/constants.js';
import { Downloader } from './downloader.js';
import { ensureDir, exists, sha1File, sizeOf, writeJson } from './fsutil.js';
import { extractNatives } from './launcher.js';
import { logger } from './logger.js';

/**
 * 安装流程编排。
 *
 * 按 resolve → client → libraries → assets → natives → finalize 分阶段执行，
 * 每阶段可独立失败与重试。只有 finalize 阶段写 versions/<id>/<id>.json，
 * 因此中断不会留下可启动但内容残缺的版本。
 */
export async function runInstallJob({ job, ctx, options = {}, emit }) {
  const { paths, api, repo, config } = ctx;
  const versionId = job.versionId;
  const signal = job.signal;
  const onProgress = (p) => {
    job.progress = p;
    emit({ type: 'progress', job: serialize(job) });
  };
  const phase = (key, label) => {
    job.phase = key;
    emit({ type: 'phase', job: serialize(job), label });
  };

  try {
    // ---------- 1. 解析 ----------
    phase('resolve', '解析版本信息');
    const plan = await repo.buildPlan(versionId, {
      features: options.features || {},
      includeAssets: options.includeAssets !== false,
    });
    job.plan = { totals: plan.totals, includeAssets: plan.includeAssets };
    emit({ type: 'plan', job: serialize(job), plan: plan.totals });

    const mkDownloader = (label) =>
      new Downloader({
        concurrency: options.concurrency || config.get('concurrency'),
        mirrorMode: options.mirror || config.get('mirror'),
        verifyMode: options.verifyMode || config.get('verifyMode'),
        onProgress,
        onFile: (f) => emit({ type: 'file', jobId: job.id, file: f }),
      });

    // ---------- 2. 游戏本体 + 运行库（合并成一批，先保证"能启动"）----------
    const coreTasks = plan.tasks.filter((t) => t.kind !== TASK_KIND.ASSET);
    phase('client', '下载游戏本体与运行库');
    if (coreTasks.length) {
      const res = await mkDownloader('核心文件').run(coreTasks, { signal, label: '游戏本体与运行库' });
      if (res.aborted) throw makeAbort();
      if (!res.ok) {
        job.failedTasks = res.stats.failedTasks;
        throw new Error(`有 ${res.stats.failed} 个文件下载失败，可点击"重试失败项"继续`);
      }
    }

    // ---------- 3. 游戏资源 ----------
    if (plan.includeAssets && plan.assetIndexData) {
      const assetTasks = plan.tasks.filter((t) => t.kind === TASK_KIND.ASSET);
      phase('assets', `下载游戏资源（${assetTasks.length} 个对象）`);
      const res = await mkDownloader('游戏资源').run(assetTasks, { signal, label: '游戏资源' });
      if (res.aborted) throw makeAbort();
      if (!res.ok) {
        job.failedTasks = res.stats.failedTasks;
        throw new Error(`资源下载有 ${res.stats.failed} 个文件失败，可点击"重试失败项"继续`);
      }
    }

    // ---------- 4. 解压 natives ----------
    if (plan.natives.length) {
      phase('natives', '解压本地库');
      // 只解压当前平台需要的，且必须先确保 jar 已就位
      await extractNatives(plan.natives, paths.nativesDir(versionId), {
        log: (m) => logger.info('install', m),
      });
    }

    // ---------- 5. 旧版虚拟资源目录 ----------
    if (plan.assetIndexData?.virtual || plan.assetIndexData?.map_to_resources) {
      phase('natives', '构建旧版资源目录');
      await materializeVirtualAssets(paths, versionId, plan.assetIndexData, signal);
    }

    // ---------- 6. 落盘版本文件（成功标志）----------
    phase('finalize', '写入版本文件');
    await ensureDir(paths.versionDir(versionId));
    const persistable = stripInternal(plan.resolved);
    await writeJson(paths.versionJson(versionId), persistable);
    await writeJson(path.join(paths.versionDir(versionId), 'aurora.json'), {
      installedAt: new Date().toISOString(),
      chain: plan.resolved._chain,
      totals: plan.totals,
      includeAssets: plan.includeAssets,
    });

    job.status = 'done';
    emit({ type: 'done', job: serialize(job) });
    logger.info('install', `版本 ${versionId} 安装完成`);
    return job;
  } catch (err) {
    if (err.aborted || signal?.aborted) {
      job.status = 'paused';
      emit({ type: 'paused', job: serialize(job) });
      return job;
    }
    job.status = 'error';
    job.error = err.message;
    logger.error('install', `安装失败 ${versionId}: ${err.message}`);
    emit({ type: 'error', job: serialize(job), message: err.message });
    return job;
  }
}

/**
 * 校验 / 修复。
 * verify 模式只读扫描；repair 模式在扫描后只补下载损坏或缺失的文件。
 */
export async function runVerifyJob({ job, ctx, repair = false, emit }) {
  const { paths, repo, config } = ctx;
  const versionId = job.versionId;
  const signal = job.signal;

  try {
    job.phase = 'resolve';
    emit({ type: 'phase', job: serialize(job), label: '构建文件清单' });

    // 优先用本地已安装的 json 构建清单：断网也能校验
    const includeAssets = config.get('downloadAssets');
    let plan;
    try {
      plan = await repo.buildPlan(versionId, { includeAssets, fromLocal: true });
    } catch (localErr) {
      try {
        plan = await repo.buildPlan(versionId, { includeAssets });
      } catch (err) {
        throw new Error(`无法获取版本 ${versionId} 的文件清单：${err.message}`);
      }
    }

    const tasks = plan.tasks;
    job.progress = { total: tasks.length, completed: 0, failed: 0, bytesTotal: plan.totals.bytes, bytesDone: 0, percent: 0 };
    emit({ type: 'progress', job: serialize(job) });

    const broken = [];
    let checked = 0;
    for (const task of tasks) {
      if (signal?.aborted) throw makeAbort();
      const size = await sizeOf(task.dest);
      let ok = size >= 0;
      if (ok && task.size > 0) ok = size === task.size;
      if (ok && task.sha1 && config.get('verifyMode') === 'strict') {
        ok = (await sha1File(task.dest)).toLowerCase() === String(task.sha1).toLowerCase();
      }
      if (!ok) broken.push({ ...task, reason: size < 0 ? '文件缺失' : '内容损坏' });
      checked += 1;
      if (checked % 20 === 0 || checked === tasks.length) {
        job.progress = {
          total: tasks.length,
          completed: checked,
          failed: broken.length,
          bytesTotal: tasks.length,
          bytesDone: checked,
          percent: (checked / tasks.length) * 100,
        };
        emit({ type: 'progress', job: serialize(job) });
      }
    }

    job.result = {
      checked: tasks.length,
      broken: broken.length,
      files: broken.slice(0, 50).map((b) => ({ label: b.label, kind: KIND_LABEL[b.kind] || b.kind, reason: b.reason })),
    };
    emit({ type: 'verified', job: serialize(job), result: job.result });

    if (repair && broken.length) {
      job.phase = 'repair';
      emit({ type: 'phase', job: serialize(job), label: `修复 ${broken.length} 个损坏文件` });
      const downloader = new Downloader({
        concurrency: config.get('concurrency'),
        mirrorMode: config.get('mirror'),
        verifyMode: 'strict',
        onProgress: (p) => {
          job.progress = p;
          emit({ type: 'progress', job: serialize(job) });
        },
      });
      const res = await downloader.run(broken, { signal, label: '修复' });
      if (res.aborted) throw makeAbort();
      if (!res.ok) throw new Error(`${res.stats.failed} 个文件修复失败`);
      job.result.repaired = broken.length;
    }

    job.status = 'done';
    emit({ type: 'done', job: serialize(job) });
    return job;
  } catch (err) {
    if (err.aborted || signal?.aborted) {
      job.status = 'paused';
      emit({ type: 'paused', job: serialize(job) });
      return job;
    }
    job.status = 'error';
    job.error = err.message;
    emit({ type: 'error', job: serialize(job), message: err.message });
    return job;
  }
}

/** 1.6 及更早版本的资源目录结构 */
async function materializeVirtualAssets(paths, versionId, indexData, signal) {
  const raw = await fs.readFile(paths.assetIndexFile(indexData.id), 'utf8').catch(() => null);
  if (!raw) return;
  const index = JSON.parse(raw);
  const target = path.join(paths.virtual, index.virtual ? index.id : 'legacy');
  await ensureDir(target);
  let n = 0;
  for (const [name, obj] of Object.entries(index.objects || {})) {
    if (signal?.aborted) return;
    const src = paths.objectFile(obj.hash);
    if (!(await exists(src))) continue;
    const dest = path.join(target, ...name.split('/'));
    if (await exists(dest)) continue;
    await ensureDir(path.dirname(dest));
    try {
      await fs.link(src, dest);
    } catch {
      await fs.copyFile(src, dest).catch(() => {});
    }
    n += 1;
  }
  if (n) logger.info('install', `旧版资源目录已构建：${target}（${n} 个文件）`);
}

/** 移除启动器内部字段，保证写出的版本 json 与官方格式一致 */
function stripInternal(resolved) {
  const { _chain, ...rest } = resolved;
  void _chain;
  return rest;
}

function serialize(job) {
  return {
    id: job.id,
    type: job.type,
    versionId: job.versionId,
    status: job.status,
    phase: job.phase,
    error: job.error || null,
    progress: job.progress || null,
    plan: job.plan || null,
    result: job.result || null,
    failedTasks: (job.failedTasks || []).slice(0, 10),
    createdAt: job.createdAt,
  };
}

function makeAbort() {
  const e = new Error('已取消');
  e.aborted = true;
  return e;
}

export { serialize as serializeJob };
