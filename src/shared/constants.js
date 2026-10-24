/**
 * 全局常量：应用标识、官方元数据入口与镜像规则。
 * 对外部地址的引用集中在此，便于换源或私有化部署。
 */

export const LAUNCHER_NAME = 'Aurora Launcher';
export const LAUNCHER_VERSION = '1.0.0';
export const LAUNCHER_BRAND_ID = 'aurora';

/** Mojang 官方元数据与资源入口 */
export const OFFICIAL = {
  versionManifest: 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json',
  versionManifestV1: 'https://launchermeta.mojang.com/mc/game/version_manifest.json',
  resources: 'https://resources.download.minecraft.net',
  libraries: 'https://libraries.minecraft.net',
  javaRuntime:
    'https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json',
};

/** BMCLAPI 镜像（国内加速），按路径前缀映射 */
export const BMCLAPI = {
  host: 'https://bmclapi2.bangbang93.com',
  /** 直接替换 host 即可 1:1 对应的官方域名 */
  passthroughHosts: ['launchermeta.mojang.com', 'piston-meta.mojang.com', 'piston-data.mojang.com'],
  libraries: 'https://bmclapi2.bangbang93.com/maven',
  assets: 'https://bmclapi2.bangbang93.com/assets',
};

/** 下载任务归类：用于进度面板分组展示与统计 */
export const TASK_KIND = {
  CLIENT: 'client',
  LIBRARY: 'library',
  NATIVE: 'native',
  ASSET_INDEX: 'assetIndex',
  ASSET: 'asset',
  LOG_CONFIG: 'logConfig',
  JAVA: 'java',
};

export const KIND_LABEL = {
  client: '游戏本体',
  library: '运行库',
  native: '本地库 (Natives)',
  assetIndex: '资源索引',
  asset: '游戏资源',
  logConfig: '日志配置',
  java: 'Java 运行时',
};

/** 网络相关默认值 */
export const NET = {
  concurrency: 8,
  maxConcurrency: 64,
  timeout: 45000,
  retries: 3,
  backoffBase: 800,
  progressInterval: 160,
};

/** 进度阶段定义，UI 依此渲染步骤条 */
export const PHASES = [
  { key: 'resolve', label: '解析版本' },
  { key: 'client', label: '游戏本体' },
  { key: 'libraries', label: '运行库' },
  { key: 'assets', label: '游戏资源' },
  { key: 'natives', label: '解压本地库' },
  { key: 'finalize', label: '写入版本文件' },
];
