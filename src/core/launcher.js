import { spawn } from 'node:child_process';
import path from 'node:path';
import { LAUNCHER_NAME, LAUNCHER_VERSION } from '../shared/constants.js';
import { evaluateRules, flattenArguments, splitLegacyArguments, ruleContext } from './rules.js';
import { mavenPath, mavenKey } from './maven.js';
import { exists, ensureDir } from './fsutil.js';
import { detectJavaInstalled, resolveRuntimeJava, installJavaRuntime } from './javaRuntime.js';
import { extractJar } from './zipReader.js';
import { logger } from './logger.js';

const PLACEHOLDER = /\$\{([^}]+)\}/g;

function substitute(str, vars) {
  if (typeof str !== 'string') return str;
  return str.replace(PLACEHOLDER, (_m, key) => (vars[key] === undefined || vars[key] === null ? '' : String(vars[key])));
}

/** 版本要求的 Java 主版本 */
export function requiredJavaMajor(resolved) {
  return resolved?.javaVersion?.majorVersion || (resolved?.minecraftArguments ? 8 : 21);
}

function isCompatible(major, required) {
  if (!major) return false;
  if (major === required) return true;
  if (required <= 8) return major === 8; // 1.16 及以前只稳定支持 Java 8
  return major > required && major <= required + 6;
}

/**
 * 选出最适合的 Java：
 * 配置显式指定 > 本机最佳匹配 > Mojang 官方运行时 > 自动下载
 */
export async function chooseJava({ paths, api, config, requiredMajor, signal, onProgress, emit }) {
  const raw = String(config.get('javaPath') || '').trim().replace(/^"+|"+$/g, '');
  // 用户手输路径常见问题：正反斜杠混用、多写斜杠，统一规范化后再探测
  const explicit = raw ? path.normalize(raw) : '';
  if (explicit && (await exists(explicit))) {
    return { path: explicit, source: 'config', major: null };
  }

  const installed = await detectJavaInstalled(paths.root, requiredMajor);
  const exact = installed.find((j) => j.major === requiredMajor);
  if (exact) return { path: exact.path, source: 'system', major: exact.major, all: installed };

  const compatible = installed.find((j) => isCompatible(j.major, requiredMajor));
  if (compatible && requiredMajor > 8) {
    logger.warn('java', `未找到 Java ${requiredMajor}，使用 Java ${compatible.major}（可能不完全兼容）`);
    return { path: compatible.path, source: 'system', major: compatible.major, all: installed };
  }

  const comp = runtimeComponentFor(requiredMajor);
  const local = await resolveRuntimeJava(paths.root, comp);
  if (local) return { path: local, source: 'runtime', major: requiredMajor, component: comp };

  if (!config.get('autoDownloadJava')) {
    throw new Error(
      `未找到兼容的 Java ${requiredMajor}。请在设置中指定 Java 路径，或开启"自动下载 Java 运行时"。`
    );
  }

  emit?.({ type: 'phase', phase: 'java', label: `下载 Java ${requiredMajor} 运行时` });
  const javaPath = await installJavaRuntime({ api, paths, component: comp, signal, onProgress });
  return { path: javaPath, source: 'downloaded', major: requiredMajor, component: comp };
}

/** 版本要求的主版本号 -> Mojang 运行时组件名 */
export function runtimeComponentFor(requiredMajor) {
  if (requiredMajor <= 8) return 'jre-legacy';
  if (requiredMajor <= 16) return 'java-runtime-alpha';
  if (requiredMajor <= 17) return 'java-runtime-gamma';
  return 'java-runtime-epsilon';
}

/**
 * 构建启动命令（纯函数式，方便 dry-run 校验与单元测试）
 */
export async function buildLaunchCommand({ paths, resolved, profileId, options = {}, account }) {
  const features = {
    is_demo_user: Boolean(options.demo),
    has_custom_resolution: Boolean(options.width && options.height),
    has_quick_plays_support: false,
    is_quick_play_singleplayer: false,
    is_quick_play_multiplayer: false,
    is_quick_play_realms: false,
  };
  const ctx = ruleContext(features);

  const nativesDir = paths.nativesDir(profileId);
  await ensureDir(nativesDir);

  // ---- classpath ----
  const cpEntries = [];
  const byKey = new Map();
  for (const lib of resolved.libraries || []) {
    if (!lib?.name) continue;
    if (!evaluateRules(lib.rules, ctx)) continue;
    if (lib.natives) continue; // 旧版 natives 走解压，不进 classpath
    byKey.set(mavenKey(lib.name), lib);
  }
  const missing = [];
  for (const lib of byKey.values()) {
    const rel = lib.downloads?.artifact?.path || mavenPath(lib.name);
    const full = path.join(paths.libraries, rel);
    if (await exists(full)) cpEntries.push(full);
    else missing.push(rel);
  }
  const jar = paths.versionJar(profileId);
  if (await exists(jar)) cpEntries.unshift(jar);
  else missing.push(`${profileId}.jar`);

  const sep = process.platform === 'win32' ? ';' : ':';
  const classpath = cpEntries.join(sep);

  // ---- 占位符变量 ----
  const gameDir = options.gameDir || paths.root;
  const assetIndexId = resolved.assetIndex?.id || resolved.assets || 'legacy';
  const vars = {
    auth_player_name: account?.name || 'Player',
    version_name: profileId,
    game_directory: gameDir,
    assets_root: paths.assets,
    game_assets: path.join(paths.virtual, 'legacy'),
    assets_index_name: assetIndexId,
    auth_uuid: account?.uuid || '',
    auth_access_token: account?.accessToken || '0',
    auth_session: account?.accessToken ? `token:${account.accessToken}` : '-',
    clientid: account?.clientId || '',
    auth_xuid: account?.xuid || '',
    user_type: account?.userType || 'legacy',
    version_type: resolved.type || 'release',
    natives_directory: nativesDir,
    launcher_name: LAUNCHER_NAME,
    launcher_version: LAUNCHER_VERSION,
    classpath,
    resolution_width: options.width || '',
    resolution_height: options.height || '',
    quickPlayPath: '',
    user_properties: '{}',
    game_library_directory: paths.libraries,
    library_directory: paths.libraries,
  };

  // ---- JVM 参数 ----
  let jvmArgs = [];
  if (Array.isArray(resolved.arguments?.jvm) && resolved.arguments.jvm.length) {
    jvmArgs = flattenArguments(resolved.arguments.jvm, ctx).map((a) => substitute(a, vars));
  } else {
    jvmArgs = [
      `-Djava.library.path=${nativesDir}`,
      '-cp',
      classpath,
      '-Dminecraft.launcher.brand=' + LAUNCHER_NAME,
      '-Dminecraft.launcher.version=' + LAUNCHER_VERSION,
    ];
  }

  // log4j 配置
  const logClient = resolved.logging?.client;
  if (logClient?.argument) {
    const logPath = path.join(paths.logConfigs, logClient.file.id);
    if (await exists(logPath)) {
      jvmArgs.unshift(substitute(logClient.argument, { ...vars, path: logPath }));
    }
  }

  // 内存与用户参数：先剔除版本自带的同类项，避免重复/冲突
  const userJvm = [
    `-Xmx${options.maxMemory || 4096}M`,
    `-Xms${options.minMemory || 1024}M`,
    ...(options.extraJvmArgs ? options.extraJvmArgs.split(/\s+/).filter(Boolean) : []),
  ];
  const cleaned = jvmArgs.filter((a) => !/^-Xmx|^-Xms/.test(a));
  // -Xmx/-Xms 必须出现在主类之前，插到 version 参数头部即可
  jvmArgs = [...userJvm, ...cleaned];

  // ---- 主类与游戏参数 ----
  const gameFlattened = Array.isArray(resolved.arguments?.game)
    ? flattenArguments(resolved.arguments.game, ctx)
    : splitLegacyArguments(resolved.minecraftArguments);

  const gameArgs = gameFlattened.map((a) => substitute(a, vars));
  if (options.server) {
    gameArgs.push('--server', String(options.server));
    if (options.port) gameArgs.push('--port', String(options.port));
  }
  if (options.fullscreen) gameArgs.push('--fullscreen');
  if (options.extraGameArgs) gameArgs.push(...options.extraGameArgs.split(/\s+/).filter(Boolean));

  const args = [...jvmArgs, resolved.mainClass, ...gameArgs];

  return { args, classpath, nativesDir, gameDir, missing, mainClass: resolved.mainClass, assetIndexId };
}

/** 解压旧版 natives（现代版本无需解压，由 LWJGL 自行抽取） */
export async function extractNatives(plan, nativesDir, { log } = {}) {
  await ensureDir(nativesDir);
  let n = 0;
  for (const entry of plan) {
    if (!(await exists(entry.jar))) continue;
    try {
      n += await extractJar(entry.jar, nativesDir, entry.exclude || ['META-INF/']);
    } catch (err) {
      logger.warn('natives', `解压 ${path.basename(entry.jar)} 失败: ${err.message}`);
    }
  }
  log?.(`解压 natives: ${n} 个文件`);
  return { extracted: n };
}

/**
 * 启动游戏进程
 */
export async function launchGame({ paths, api, config, resolved, profileId, options, account, onLog, onExit, signal }) {
  const requiredMajor = requiredJavaMajor(resolved);
  const java = await chooseJava({ paths, api, config, requiredMajor, signal });
  const cmd = await buildLaunchCommand({ paths, resolved, profileId, options, account });

  if (cmd.missing.length) {
    logger.warn('launch', `缺少 ${cmd.missing.length} 个运行库文件，游戏可能启动失败`);
  }

  logger.info('launch', `Java: ${java.path} (来源 ${java.source})`);
  logger.info('launch', `命令: ${java.path} ${cmd.args.slice(0, 6).join(' ')} ... ${cmd.mainClass}`);

  if (options.dryRun) {
    return { dryRun: true, java: java.path, ...cmd };
  }

  const child = spawn(java.path, cmd.args, {
    cwd: cmd.gameDir,
    windowsHide: false,
    env: { ...process.env },
  });

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => onLog?.('stdout', d));
  child.stderr.on('data', (d) => onLog?.('stderr', d));
  child.on('error', (err) => onLog?.('error', `进程启动失败: ${err.message}`));
  child.on('close', (code, sig) => onExit?.({ code, signal: sig }));

  return { pid: child.pid, java: java.path, child, ...cmd };
}
