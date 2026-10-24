import path from 'node:path';
import { OFFICIAL, TASK_KIND } from '../shared/constants.js';
import { evaluateRules, ruleContext } from './rules.js';
import { mavenPath, mavenKey } from './maven.js';
import { logger } from './logger.js';
import { listDir, readJson, sizeOf, statOf, dirSize } from './fsutil.js';

const MAX_INHERIT_DEPTH = 6;

/**
 * 版本解析与下载计划构建。
 *
 * 计划是「需要哪些文件、落盘到哪里、多大、是否需要解压」的唯一来源，
 * 安装、校验与修复共用同一份，三者结论不会分歧。
 */
export class VersionRepository {
  constructor({ paths, api, config }) {
    this.paths = paths;
    this.api = api;
    this.config = config;
  }

  /**
   * 解析版本，沿 inheritsFrom 向上合并（Forge / Fabric / OptiFine 都依赖这个机制）。
   * @param {object} opts { fromLocal: boolean } 本地模式优先读已安装的 json，断网也能校验/启动
   */
  async resolve(id, { depth = 0, seen = new Set(), fromLocal = false } = {}) {
    if (depth > MAX_INHERIT_DEPTH) throw new Error('版本继承层级过深，可能存在循环引用');
    if (seen.has(id)) throw new Error(`版本继承出现循环：${id}`);
    seen.add(id);

    let raw = null;
    if (fromLocal) raw = await readJson(this.paths.versionJson(id), null);
    if (!raw) {
      const { data } = await this.api.versionJson(id);
      raw = data;
    }

    if (!raw.inheritsFrom) {
      return { ...raw, id, _chain: [id] };
    }

    const parent = await this.resolve(raw.inheritsFrom, { depth: depth + 1, seen, fromLocal });
    return mergeVersions(parent, raw, id);
  }

  /**
   * 已安装版本 = 存在 <id>/<id>.json 的目录。
   * 只有 finalize 阶段才写这个文件，所以"下了一半"的版本不会被误报为已安装。
   */
  async listInstalled() {
    const entries = await listDir(this.paths.versions);
    const out = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const id = e.name;
      const jsonFile = this.paths.versionJson(id);
      const meta = await readJson(jsonFile, null);
      if (!meta) continue;
      const st = await statOf(jsonFile);
      const jarSize = await sizeOf(this.paths.versionJar(id));
      out.push({
        id,
        type: meta?.type || 'unknown',
        releaseTime: meta?.releaseTime || null,
        mainClass: meta?.mainClass || null,
        javaVersion: meta?.javaVersion || null,
        inheritsFrom: meta?.inheritsFrom || null,
        loader: detectLoader(meta),
        hasJar: jarSize > 0,
        jarSize: Math.max(0, jarSize),
        size: await dirSize(this.paths.versionDir(id)),
        installedAt: st?.mtimeMs || null,
      });
    }
    out.sort((a, b) => String(b.releaseTime).localeCompare(String(a.releaseTime)));
    return out;
  }

  /**
   * 构建下载计划。
   * @param {string} id 版本 id
   * @param {object} opts { features, includeAssets, fromLocal }
   */
  async buildPlan(id, opts = {}) {
    const resolved = await this.resolve(id, { fromLocal: Boolean(opts.fromLocal) });
    const ctx = ruleContext(opts.features || {});
    const osName = ctx.os.name;
    const osArchBits = process.arch === 'ia32' ? '32' : '64';
    const includeAssets = opts.includeAssets !== false;

    const tasks = [];
    const natives = [];
    const seenDest = new Set();

    const push = (task) => {
      const key = path.resolve(task.dest).toLowerCase();
      if (seenDest.has(key)) return;
      seenDest.add(key);
      tasks.push(task);
    };

    // ---- 1. 游戏本体 client.jar ----
    let clientTask = null;
    if (resolved.downloads?.client) {
      const d = resolved.downloads.client;
      clientTask = {
        kind: TASK_KIND.CLIENT,
        url: d.url,
        dest: this.paths.versionJar(id),
        sha1: d.sha1,
        size: d.size,
        label: `${id}.jar`,
        optional: false,
      };
      push(clientTask);
    }

    // ---- 2. 运行库 ----
    const libs = [...(resolved.libraries || [])];
    // 去重：同 key 保留最后一次出现（子版本覆盖父版本）
    const byKey = new Map();
    for (const lib of libs) {
      if (!lib?.name) continue;
      if (!evaluateRules(lib.rules, ctx)) continue;
      byKey.set(mavenKey(lib.name), lib);
    }

    for (const lib of byKey.values()) {
      const artifact = lib.downloads?.artifact;
      // 2a. 旧版本 natives（需要解压，不进 classpath）
      if (lib.natives) {
        let classifierKey = lib.natives[osName];
        if (!classifierKey) continue;
        classifierKey = classifierKey.replace('${arch}', osArchBits);
        const nativeArtifact = lib.downloads?.classifiers?.[classifierKey];
        if (nativeArtifact) {
          push({
            kind: TASK_KIND.NATIVE,
            url: nativeArtifact.url,
            dest: path.join(this.paths.libraries, nativeArtifact.path),
            sha1: nativeArtifact.sha1,
            size: nativeArtifact.size,
            label: path.basename(nativeArtifact.path),
          });
          natives.push({
            jar: path.join(this.paths.libraries, nativeArtifact.path),
            exclude: lib.extract?.exclude || ['META-INF/'],
          });
        }
        continue;
      }
      // 2b. 普通运行库（含 LWJGL3 的 natives-* 构件，直接进 classpath）
      if (artifact) {
        push({
          kind: TASK_KIND.LIBRARY,
          url: artifact.url,
          dest: path.join(this.paths.libraries, artifact.path),
          sha1: artifact.sha1,
          size: artifact.size,
          label: path.basename(artifact.path),
        });
        continue;
      }
      // 2c. 只给了 Maven 坐标 + 仓库地址（Forge 系常见）
      if (lib.url && lib.name) {
        const rel = mavenPath(lib.name);
        push({
          kind: TASK_KIND.LIBRARY,
          url: `${lib.url.replace(/\/$/, '')}/${rel}`,
          dest: path.join(this.paths.libraries, rel),
          sha1: null,
          size: 0,
          label: path.basename(rel),
        });
      }
    }

    // ---- 3. 资源索引与资源对象 ----
    let assetIndexTask = null;
    let assetTasks = [];
    let assetIndexData = null;
    if (resolved.assetIndex) {
      const ai = resolved.assetIndex;
      assetIndexTask = {
        kind: TASK_KIND.ASSET_INDEX,
        url: ai.url,
        dest: this.paths.assetIndexFile(ai.id),
        sha1: ai.sha1,
        size: ai.size,
        label: `indexes/${ai.id}.json`,
      };
      push(assetIndexTask);

      const { data } = await this.api.assetIndex(ai);
      assetIndexData = data;
      if (includeAssets && data?.objects) {
        for (const obj of Object.values(data.objects)) {
          // 哈希寻址：不同版本共享同一对象，天然去重
          assetTasks.push({
            kind: TASK_KIND.ASSET,
            url: `${OFFICIAL.resources}/${obj.hash.slice(0, 2)}/${obj.hash}`,
            dest: this.paths.objectFile(obj.hash),
            sha1: obj.hash,
            size: obj.size,
            label: obj.hash.slice(0, 8),
          });
        }
        // 排序：大文件优先，避免末尾拖尾、进度条长时间不动
        assetTasks.sort((a, b) => (b.size || 0) - (a.size || 0));
        for (const t of assetTasks) push(t);
      }
    }

    // ---- 4. log4j 配置 ----
    let logTask = null;
    const logClient = resolved.logging?.client;
    if (logClient?.file?.url) {
      logTask = {
        kind: TASK_KIND.LOG_CONFIG,
        url: logClient.file.url,
        dest: path.join(this.paths.logConfigs, logClient.file.id),
        sha1: logClient.file.sha1,
        size: logClient.file.size,
        label: logClient.file.id,
      };
      push(logTask);
    }

    const totals = { count: tasks.length, bytes: 0, byKind: {} };
    for (const t of tasks) {
      totals.bytes += t.size || 0;
      totals.byKind[t.kind] = totals.byKind[t.kind] || { count: 0, bytes: 0 };
      totals.byKind[t.kind].count += 1;
      totals.byKind[t.kind].bytes += t.size || 0;
    }

    logger.info('plan', `版本 ${id} 计划：${totals.count} 个文件 / ${(totals.bytes / 1048576).toFixed(1)} MB`);

    return {
      id,
      resolved,
      tasks,
      clientTask,
      natives,
      logTask,
      assetIndexTask,
      assetIndexData,
      totals,
      ctx,
      includeAssets,
    };
  }
}

/** 合并 inheritsFrom 链：父在前，子覆盖 */
function mergeVersions(parent, child, id) {
  const merged = { ...parent, ...child, id };
  merged.libraries = [...(parent.libraries || []), ...(child.libraries || [])];
  merged.mainClass = child.mainClass || parent.mainClass;
  merged.minecraftArguments = child.minecraftArguments ?? parent.minecraftArguments;
  merged.assetIndex = child.assetIndex || parent.assetIndex;
  merged.assets = child.assets || parent.assets;
  merged.downloads = { ...(parent.downloads || {}), ...(child.downloads || {}) };
  merged.javaVersion = child.javaVersion || parent.javaVersion;
  merged.logging = child.logging || parent.logging;
  if (child.arguments || parent.arguments) {
    merged.arguments = {
      game: [...(parent.arguments?.game || []), ...(child.arguments?.game || [])],
      jvm: [...(parent.arguments?.jvm || []), ...(child.arguments?.jvm || [])],
    };
  }
  merged._chain = [...(parent._chain || []), id];
  return merged;
}

function detectLoader(meta) {
  if (!meta) return null;
  const main = meta.mainClass || '';
  if (/fabric/i.test(main)) return 'fabric';
  if (/quilt/i.test(main)) return 'quilt';
  if (/forge|minecraftforge/i.test(main)) return 'forge';
  if (/neoforge/i.test(main)) return 'neoforge';
  if (meta.inheritsFrom) return 'modded';
  return null;
}
