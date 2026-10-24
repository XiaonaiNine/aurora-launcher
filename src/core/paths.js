import path from 'node:path';
import os from 'node:os';

/**
 * 目录规范（遵循官方 .minecraft 布局，便于与现有实例 / 第三方工具互操作）
 *
 * <root>/
 *   versions/<id>/<id>.json     版本清单（已合并 inheritsFrom）
 *   versions/<id>/<id>.jar      游戏本体 client.jar
 *   versions/<id>/natives/      旧版本 natives 解压目录
 *   libraries/                  Maven 结构运行库
 *   assets/indexes/<id>.json    资源索引
 *   assets/objects/ab/<hash>    资源对象（哈希寻址，天然去重）
 *   assets/virtual/legacy/      旧版本虚拟资源目录
 *   assets/log_configs/         log4j 配置
 *   runtime/<component>/        Mojang 提供的 Java 运行时
 *   meta/                       远程元数据缓存
 *   logs/                       启动器日志
 *   aurora.config.json          启动器配置
 */
export function createPaths(root) {
  const versions = path.join(root, 'versions');
  const assets = path.join(root, 'assets');
  return {
    root,
    versions,
    libraries: path.join(root, 'libraries'),
    assets,
    objects: path.join(assets, 'objects'),
    indexes: path.join(assets, 'indexes'),
    virtual: path.join(assets, 'virtual'),
    logConfigs: path.join(assets, 'log_configs'),
    runtime: path.join(root, 'runtime'),
    logs: path.join(root, 'logs'),
    meta: path.join(root, 'meta'),
    configFile: path.join(root, 'aurora.config.json'),
    versionDir: (id) => path.join(versions, id),
    versionJson: (id) => path.join(versions, id, `${id}.json`),
    versionJar: (id) => path.join(versions, id, `${id}.jar`),
    nativesDir: (id) => path.join(versions, id, 'natives'),
    assetIndexFile: (id) => path.join(assets, 'indexes', `${id}.json`),
    objectFile: (hash) => path.join(assets, 'objects', hash.slice(0, 2), hash),
    metaFile: (name) => path.join(root, 'meta', name),
  };
}

export const DEFAULT_ROOT = path.join(os.homedir(), '.aurora-minecraft');
