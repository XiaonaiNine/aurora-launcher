import { OFFICIAL } from '../shared/constants.js';
import { fetchJson } from './net.js';
import { readJson, writeJson, statOf } from './fsutil.js';
import { logger } from './logger.js';

const MANIFEST_TTL = 15 * 60 * 1000;
const META_TTL = 12 * 60 * 60 * 1000;

/**
 * Mojang 元数据客户端。
 *
 * 响应落盘到 <root>/meta/ 并带 TTL；请求失败时降级到过期缓存，
 * 返回值标记 stale，界面据此提示当前展示的是离线数据。
 */
export class MojangApi {
  constructor({ paths, config }) {
    this.paths = paths;
    this.config = config;
    this.mem = new Map();
  }

  get mirrorMode() {
    return this.config?.get?.('mirror') || 'auto';
  }

  async _cached(file, ttl, loader) {
    const cached = await readJson(file, null);
    const st = await statOf(file);
    const age = st ? Date.now() - st.mtimeMs : Infinity;
    if (cached && age < ttl) return { data: cached, stale: false };
    try {
      const fresh = await loader();
      await writeJson(file, fresh);
      return { data: fresh, stale: false };
    } catch (err) {
      if (cached) {
        logger.warn('mojang', `远程获取失败，使用本地缓存 ${file} (${err.message})`);
        return { data: cached, stale: true, error: err };
      }
      throw err;
    }
  }

  async manifest({ force = false } = {}) {
    const file = this.paths.metaFile('version_manifest_v2.json');
    if (force) return { data: await fetchJson(OFFICIAL.versionManifest, this._opts('版本清单')), stale: false };
    return this._cached(file, MANIFEST_TTL, () => fetchJson(OFFICIAL.versionManifest, this._opts('版本清单')));
  }

  async versionEntry(id) {
    const { data, stale } = await this.manifest();
    const entry = data.versions.find((v) => v.id === id);
    if (!entry) throw new Error(`版本清单中不存在 ${id}`);
    return { entry, stale };
  }

  /** 原始版本 JSON（未合并 inheritsFrom） */
  async versionJson(id, { force = false, url } = {}) {
    const file = this.paths.metaFile(`version-${sanitize(id)}.json`);
    const loader = async () => {
      const target = url || (await this.versionEntry(id)).entry.url;
      return fetchJson(target, this._opts(`版本 ${id}`));
    };
    if (force) return { data: await loader(), stale: false };
    return this._cached(file, META_TTL, loader);
  }

  async assetIndex(indexInfo) {
    const file = this.paths.metaFile(`assetindex-${sanitize(indexInfo.id)}.json`);
    return this._cached(file, META_TTL, () => fetchJson(indexInfo.url, this._opts(`资源索引 ${indexInfo.id}`)));
  }

  async javaRuntimeManifest() {
    const file = this.paths.metaFile('java_runtime_all.json');
    return this._cached(file, META_TTL, () => fetchJson(OFFICIAL.javaRuntime, this._opts('Java 运行时清单')));
  }

  _opts(label) {
    return { mirrorMode: this.mirrorMode, label, retries: 3, timeout: 30000 };
  }
}

function sanitize(s) {
  return String(s).replace(/[^\w.\-+]/g, '_');
}
