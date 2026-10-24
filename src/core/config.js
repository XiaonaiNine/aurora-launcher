import path from 'node:path';
import { createPaths, DEFAULT_ROOT } from './paths.js';
import { readJson, writeJson, ensureDir } from './fsutil.js';

export const DEFAULT_CONFIG = {
  /** 游戏根目录；可在设置里改成官方 .minecraft 以复用旧实例 */
  rootDir: DEFAULT_ROOT,
  /** 留空 = 自动探测最适合的 Java */
  javaPath: '',
  /** 本机没有合适 Java 时，自动下载 Mojang 官方运行时 */
  autoDownloadJava: true,
  maxMemory: 4096,
  minMemory: 1024,
  /** 附加 JVM 参数（空格分隔），会追加在版本自带参数之后 */
  extraJvmArgs: '',
  width: 1280,
  height: 720,
  fullscreen: false,
  /** auto = 优先官方，失败自动切镜像；official；bmclapi */
  mirror: 'auto',
  concurrency: 8,
  /** 是否下载完整资源（约数百 MB）；关闭则只能启动但无音效/语言/贴图缺失 */
  downloadAssets: true,
  /** 校验策略：strict = 每个文件都核对 SHA1；fast = 仅比对大小 */
  verifyMode: 'strict',
  showSnapshot: false,
  showOld: false,
  /**
   * 微软正版登录用的 Azure 应用 ID（公共客户端）。
   * 一个应用 ID 对应一份"启动器身份"，用户自己注册即可，不需要密钥。
   * 留空时 UI 会引导注册，不会出现"按钮灰着点不动"的死路。
   */
  msaClientId: '',
  account: {
    mode: 'offline',
    name: 'Steve',
    uuid: '',
    accessToken: '',
    userType: 'legacy',
    xuid: '',
    refreshToken: '',
    /** 微软账户：Minecraft 访问令牌的过期时间戳；离线账户为 0 */
    expiresAt: 0,
  },
};

export class ConfigStore {
  constructor(paths) {
    this.paths = paths;
    this.data = structuredClone(DEFAULT_CONFIG);
  }

  /**
   * @param {string} [rootDir] 显式指定的根目录（命令行 --root）。优先级最高：
   *   --root > 配置文件中的 rootDir > 默认目录
   */
  static async load(rootDir) {
    const explicit = rootDir ? path.resolve(rootDir) : null;
    const readAt = async (dir) => readJson(path.join(dir, 'aurora.config.json'), null);

    if (explicit) {
      const store = new ConfigStore(createPaths(explicit));
      store.data = mergeDeep(structuredClone(DEFAULT_CONFIG), (await readAt(explicit)) || {});
      store.data.rootDir = explicit;
      await ensureDir(explicit);
      return store;
    }

    // 未显式指定时，允许上一次在 UI 里改过的根目录生效
    const base = new ConfigStore(createPaths(DEFAULT_ROOT));
    const saved = await readAt(DEFAULT_ROOT);
    if (saved?.rootDir && path.resolve(saved.rootDir) !== path.resolve(DEFAULT_ROOT)) {
      const target = path.resolve(saved.rootDir);
      const alt = new ConfigStore(createPaths(target));
      const altSaved = (await readAt(target)) || saved;
      alt.data = mergeDeep(structuredClone(DEFAULT_CONFIG), altSaved);
      alt.data.rootDir = target;
      await ensureDir(target);
      return alt;
    }

    base.data = mergeDeep(structuredClone(DEFAULT_CONFIG), saved || {});
    base.data.rootDir = base.paths.root;
    await ensureDir(base.paths.root);
    return base;
  }

  get all() {
    return this.data;
  }

  get(key) {
    return key.split('.').reduce((o, k) => (o == null ? o : o[k]), this.data);
  }

  async patch(patch) {
    this.data = mergeDeep(this.data, patch);
    // 根目录变更 -> 重新计算路径并迁移配置
    if (patch.rootDir && path.resolve(patch.rootDir) !== path.resolve(this.paths.root)) {
      this.paths = createPaths(patch.rootDir);
      await ensureDir(this.paths.root);
    }
    await this.save();
    return this.data;
  }

  async save() {
    await writeJson(this.paths.configFile, this.data);
  }
}

function mergeDeep(base, patch) {
  if (patch == null) return base;
  if (typeof base !== 'object' || Array.isArray(base)) return patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? mergeDeep(base?.[k] ?? {}, v) : v;
  }
  return out;
}
