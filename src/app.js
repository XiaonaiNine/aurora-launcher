import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { ConfigStore } from './core/config.js';
import { MojangApi } from './core/mojang.js';
import { VersionRepository } from './core/versionRepo.js';
import { JobManager } from './core/jobs.js';
import { createOfflineAccount, offlineUuid, isValidOfflineName } from './core/auth.js';
import {
  MsaLoginSession,
  refreshMsaToken,
  buildAccount,
  fetchSkinData,
  isAccountExpired,
  verifyClientId,
} from './core/msa.js';
import { detectJavaInstalled, probeJava } from './core/javaRuntime.js';
import { launchGame, chooseJava, requiredJavaMajor, buildLaunchCommand } from './core/launcher.js';
import { dirSize, removeDir, ensureDir, exists } from './core/fsutil.js';
import { logger } from './core/logger.js';

/**
 * 应用门面：组装各模块，向上提供 bootstrap / preview / install / verify / launch 等方法。
 * HTTP 层只做协议转换，因此换用 Electron IPC 时此处无需改动。
 */
export class LauncherApp {
  constructor(configStore) {
    this.config = configStore;
    this.paths = configStore.paths;
    this.processes = new Map();
    /** 当前进行中的微软登录会话（同一时间只允许一个） */
    this.authSession = null;
    this._rebind();
  }

  static async create(rootDir) {
    const config = await ConfigStore.load(rootDir);
    const app = new LauncherApp(config);
    logger.attach(app.paths.root);
    await ensureDir(app.paths.root);
    await app.normalizeAccount();
    logger.info('app', `启动器就绪，数据目录: ${app.paths.root}`);
    return app;
  }

  /**
   * 账户自愈。
   *
   * 离线账户：UUID 必须由用户名派生，否则启动参数里的 --uuid 是空串，部分版本拒绝启动。
   * 微软账户：如果 uuid / accessToken 缺失（配置文件被手改、或从没登录成功过），
   * 直接退回离线账户，避免用户点了启动才看到一堆鉴权报错。
   */
  async normalizeAccount() {
    const account = { ...this.config.get('account') };
    let changed = false;

    if (account.mode === 'microsoft' && (!account.uuid || !account.accessToken)) {
      logger.warn('auth', '微软账户信息不完整，已退回离线账户');
      const name = isValidOfflineName(account.name) ? String(account.name).trim() : 'Steve';
      Object.assign(account, createOfflineAccount(name));
      await this.config.patch({ account });
      return account;
    }

    if (account.mode !== 'microsoft') {
      const name = String(account.name || 'Steve').trim() || 'Steve';
      const uuid = String(account.uuid || '').replace(/-/g, '') || offlineUuid(name).replace(/-/g, '');
      if (account.name !== name) {
        account.name = name;
        changed = true;
      }
      if (account.uuid !== uuid) {
        account.uuid = uuid;
        changed = true;
      }
      if (account.accessToken !== '0') {
        account.accessToken = '0';
        changed = true;
      }
      if (account.userType !== 'legacy') {
        account.userType = 'legacy';
        changed = true;
      }
      if (account.mode !== 'offline') {
        account.mode = 'offline';
        changed = true;
      }
    }
    if (changed) await this.config.patch({ account });
    return account;
  }

  _rebind() {
    this.paths = this.config.paths;
    this.api = new MojangApi({ paths: this.paths, config: this.config });
    this.repo = new VersionRepository({ paths: this.paths, api: this.api, config: this.config });
    this.jobs = new JobManager({ paths: this.paths, api: this.api, repo: this.repo, config: this.config });
  }

  /** 根目录变更后重建所有依赖 paths 的对象 */
  async rebindIfNeeded() {
    if (this.paths !== this.config.paths) {
      this._rebind();
      logger.attach(this.paths.root);
      return true;
    }
    return false;
  }

  // ---------------- 启动器状态 ----------------

  async bootstrap() {
    const installed = await this.repo.listInstalled().catch(() => []);
    let javaList = [];
    try {
      javaList = await detectJavaInstalled(this.paths.root, 0);
    } catch (err) {
      logger.warn('app', `Java 探测失败: ${err.message}`);
    }
    const running = [...this.processes.values()]
      .filter((p) => p.status === 'running')
      .map((p) => ({ id: p.id, versionId: p.versionId, pid: p.pid, startedAt: p.startedAt }));

    // 打开界面时顺手续期，用户不用关心 24 小时有效期
    if (this.config.get('account')?.mode === 'microsoft') {
      this.refreshAccount().catch((err) => logger.warn('auth', `自动续期失败：${err.message}`));
    }

    return {
      launcher: { name: 'Aurora Launcher', version: '1.0.0', platform: process.platform, arch: process.arch },
      root: this.paths.root,
      // account 用脱敏快照覆盖，避免访问令牌随配置一起下发到界面
      config: { ...this.config.all, account: this.accountView() },
      account: this.accountView(),
      installed,
      java: {
        list: javaList,
        recommended: javaList[0] || null,
        total: javaList.length,
      },
      jobs: this.jobs.list(),
      running,
    };
  }

  // ---------------- 远程版本 ----------------

  async remoteVersions({ force = false } = {}) {
    const { data, stale } = await this.api.manifest({ force });
    return {
      stale,
      latest: data.latest,
      versions: data.versions.map((v) => ({
        id: v.id,
        type: v.type,
        releaseTime: v.releaseTime,
        complianceLevel: v.complianceLevel,
      })),
    };
  }

  /** 预检：告诉用户"要下多少、装到哪"，不让用户盲点安装 */
  async preview(versionId, options = {}) {
    const plan = await this.repo.buildPlan(versionId, {
      features: options.features || {},
      includeAssets: options.includeAssets !== false,
      fromLocal: false,
    });
    const breakdown = Object.entries(plan.totals.byKind).map(([kind, v]) => ({ kind, ...v }));
    return {
      versionId,
      type: plan.resolved.type,
      releaseTime: plan.resolved.releaseTime,
      javaVersion: plan.resolved.javaVersion || null,
      mainClass: plan.resolved.mainClass,
      chain: plan.resolved._chain,
      totals: plan.totals,
      breakdown,
      includeAssets: plan.includeAssets,
      assetCount: plan.assetIndexData ? Object.keys(plan.assetIndexData.objects || {}).length : 0,
      natives: plan.natives.length,
      installDir: this.paths.versionDir(versionId),
      alreadyInstalled: await exists(this.paths.versionJson(versionId)),
    };
  }

  install(versionId, options = {}) {
    return this.jobs.create({ type: 'install', versionId, options });
  }

  verify(versionId, repair = false) {
    return this.jobs.create({ type: 'verify', versionId, repair });
  }

  /** 在系统文件管理器中打开版本目录 */
  async revealVersion(versionId) {
    const dir = this.paths.versionDir(versionId);
    if (!(await exists(dir))) throw new Error('版本目录不存在');
    const opener =
      process.platform === 'win32'
        ? ['explorer.exe', [dir]]
        : process.platform === 'darwin'
          ? ['open', [dir]]
          : ['xdg-open', [dir]];
    spawn(opener[0], opener[1], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true, dir };
  }

  async deleteVersion(versionId) {
    const dir = this.paths.versionDir(versionId);
    if (!(await exists(dir))) throw new Error('版本不存在');
    const size = await dirSize(dir);
    await removeDir(dir);
    logger.info('app', `已删除版本 ${versionId}（释放 ${(size / 1048576).toFixed(1)} MB）`);
    return { ok: true, freed: size };
  }

  /** 磁盘占用概览（用于 UI 存储条） */
  async storage() {
    const [versions, libraries, assets, runtime] = await Promise.all([
      dirSize(this.paths.versions),
      dirSize(this.paths.libraries),
      dirSize(this.paths.assets),
      dirSize(this.paths.runtime),
    ]);
    return { versions, libraries, assets, runtime, total: versions + libraries + assets + runtime };
  }

  // ---------------- 账户 ----------------

  /**
   * 账户的对外快照。
   * accessToken / refreshToken 属于凭证，前端只在渲染时用到名字与头像，
   * 没有任何理由把这些下发给界面层。
   */
  accountView() {
    const acc = this.config.get('account') || {};
    const premium = acc.mode === 'microsoft';
    return {
      mode: acc.mode || 'offline',
      name: acc.name || 'Steve',
      uuid: acc.uuid || '',
      userType: acc.userType || 'legacy',
      xuid: acc.xuid || '',
      expiresAt: premium ? acc.expiresAt || 0 : 0,
      expired: premium ? isAccountExpired(acc) : false,
      canRefresh: premium && Boolean(acc.refreshToken),
      hasSkin: premium && Boolean(acc.skinUrl),
    };
  }

  async setOfflineAccount(name) {
    const account = createOfflineAccount(name);
    await this.config.patch({ account });
    logger.info('auth', `已切换离线账户 ${account.name}`);
    this.jobs.emit('event', { type: 'account', account: this.accountView() });
    return this.accountView();
  }

  /** 仅校验应用 ID 是否可用，不写入配置。供配置引导即时反馈使用 */
  verifyMsaClientId(clientId) {
    return verifyClientId(String(clientId || '').trim());
  }

  /** 校验通过才保存：存一个用不了的 ID 比不存更糟 */
  async setMsaClientId(clientId) {
    const id = String(clientId || '').trim();
    await verifyClientId(id);
    await this.config.patch({ msaClientId: id });
    logger.info('auth', '微软应用 ID 已更新');
    return { clientId: id };
  }

  /**
   * 发起微软登录。返回时设备码已经拿到，前端立刻就能展示；
   * 后续轮询在服务端继续，关掉弹窗再打开也能接上。
   */
  async startMicrosoftLogin() {
    const clientId = String(this.config.get('msaClientId') || '').trim();
    if (!clientId) throw new Error('尚未配置微软应用 ID，请先完成上面的三步配置');

    const running = this.authSession;
    if (running && !running.isFinished) running.cancel();

    let session;
    session = new MsaLoginSession({
      clientId,
      onChange: (snap) => this._onAuthChange(snap, session),
    });
    this.authSession = session;
    return session.start();
  }

  _onAuthChange(snap, session) {
    this.jobs.emit('event', { type: 'auth', session: snap });
    if (snap.state !== 'done' || !session?.account) return;
    // 登录成功 → 落库。写配置是异步的，失败也不能让 UI 卡在"成功"上
    this.config
      .patch({ account: session.account })
      .then(() => {
        logger.info('auth', `微软账户已保存：${session.account.name}`);
        this.jobs.emit('event', { type: 'account', account: this.accountView() });
      })
      .catch((err) => {
        logger.error('auth', `账户保存失败：${err.message}`);
        this.jobs.emit('event', { type: 'auth-warning', message: `账户保存失败：${err.message}` });
      });
  }

  microsoftLoginStatus() {
    if (!this.authSession) return { state: 'idle' };
    if (this.authSession.isStale) {
      this.authSession = null;
      return { state: 'idle' };
    }
    return this.authSession.toJSON();
  }

  cancelMicrosoftLogin() {
    this.authSession?.cancel();
    return this.microsoftLoginStatus();
  }

  /**
   * 刷新正版令牌。
   * MSA 令牌换来的 Minecraft 令牌只有 24 小时，过期后联机鉴权会失败，
   * 所以启动前与打开界面时都会尝试静默续期。
   */
  async refreshAccount({ force = false } = {}) {
    const acc = this.config.get('account');
    if (acc?.mode !== 'microsoft') return this.accountView();
    if (!force && !isAccountExpired(acc)) return this.accountView();

    const clientId = String(this.config.get('msaClientId') || acc.clientId || '').trim();
    if (!clientId) throw new Error('缺少微软应用 ID，请重新配置后再刷新');
    if (!acc.refreshToken) {
      throw Object.assign(new Error('没有可用的刷新令牌，需要重新登录微软账户'), { relogin: true });
    }

    const tokens = await refreshMsaToken(clientId, acc.refreshToken);
    const next = await buildAccount({
      msaAccessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      clientId,
      expectName: acc.name,
    });
    await this.config.patch({ account: next });
    logger.info('auth', `正版令牌已刷新：${next.name}`);
    this.jobs.emit('event', { type: 'account', account: this.accountView() });
    return this.accountView();
  }

  async logoutAccount() {
    const acc = this.config.get('account');
    const name = isValidOfflineName(acc?.name) ? acc.name : 'Steve';
    await this.config.patch({ account: createOfflineAccount(name) });
    logger.info('auth', '已退出微软账户');
    this.jobs.emit('event', { type: 'account', account: this.accountView() });
    return this.accountView();
  }

  /** 正版皮肤头像：本地裁切，不依赖第三方头像站 */
  async accountSkin() {
    const acc = this.config.get('account');
    if (acc?.mode !== 'microsoft' || !acc.skinUrl) return null;
    return fetchSkinData({ id: acc.uuid, skins: [{ url: acc.skinUrl, state: 'ACTIVE' }] });
  }

  /** 启动前静默续期；失败也不拦着启动（单人游戏仍然能进） */
  async ensureAccountFresh() {
    const acc = this.config.get('account');
    if (acc?.mode !== 'microsoft' || !isAccountExpired(acc)) return;
    try {
      await this.refreshAccount({ force: true });
    } catch (err) {
      logger.warn('auth', `启动前刷新令牌失败：${err.message}`);
      this.jobs.emit('event', { type: 'auth-warning', message: err.message });
    }
  }

  async setConfig(patch) {
    const data = await this.config.patch(patch);
    await this.rebindIfNeeded();
    if (patch?.account) await this.normalizeAccount();
    return this.config.all;
  }

  async detectJava(explicitPath) {
    if (explicitPath) {
      const info = await probeJava(explicitPath);
      if (!info) throw new Error('该路径不是可用的 java 可执行文件');
      return [info];
    }
    return detectJavaInstalled(this.paths.root, 0);
  }

  // ---------------- 启动 ----------------

  async launch(versionId, options = {}) {
    const resolved = await this.repo.resolve(versionId, { fromLocal: true });
    const required = requiredJavaMajor(resolved);

    // 启动前先确认 Java 可用（缺则按配置自动下载运行时）
    const java = await chooseJava({
      paths: this.paths,
      api: this.api,
      config: this.config,
      requiredMajor: required,
      emit: (e) => this.jobs.emit('event', { type: 'launch-phase', versionId, ...e }),
    });

    // 正版账户：令牌过期先静默续期，否则联机鉴权会失败。
    // dry-run 只看参数长什么样，没必要为此跑一趟网络。
    if (!options.dryRun) await this.ensureAccountFresh();

    const account = this.config.get('account');
    const launchOptions = {
      maxMemory: options.maxMemory ?? this.config.get('maxMemory'),
      minMemory: options.minMemory ?? this.config.get('minMemory'),
      extraJvmArgs: options.extraJvmArgs ?? this.config.get('extraJvmArgs'),
      width: options.width ?? this.config.get('width'),
      height: options.height ?? this.config.get('height'),
      fullscreen: options.fullscreen ?? this.config.get('fullscreen'),
      server: options.server || '',
      port: options.port || '',
      demo: Boolean(options.demo),
      dryRun: Boolean(options.dryRun),
      gameDir: this.paths.root,
    };

    const id = `proc_${crypto.randomBytes(4).toString('hex')}`;
    const logs = [];

    const record = {
      id,
      versionId,
      pid: null,
      status: 'starting',
      startedAt: Date.now(),
      exitCode: null,
      logs,
      java: java.path,
      javaSource: java.source,
    };

    if (launchOptions.dryRun) {
      const cmd = await buildLaunchCommand({
        paths: this.paths,
        resolved,
        profileId: versionId,
        options: launchOptions,
        account,
      });
      record.status = 'dry-run';
      return { ...record, command: { java: java.path, args: cmd.args, cwd: cmd.gameDir, missing: cmd.missing } };
    }

    this.processes.set(id, record);
    const pushLog = (stream, chunk) => {
      const lines = String(chunk).split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        logs.push({ t: Date.now(), stream, line });
        if (logs.length > 2000) logs.shift();
        this.jobs.emit('event', { type: 'game-log', procId: id, stream, line });
      }
    };

    const result = await launchGame({
      paths: this.paths,
      api: this.api,
      config: this.config,
      resolved,
      profileId: versionId,
      options: launchOptions,
      account,
      onLog: pushLog,
      onExit: ({ code, signal }) => {
        record.status = code === 0 ? 'exited' : 'crashed';
        record.exitCode = code;
        record.signal = signal;
        logger.info('launch', `游戏进程结束，退出码 ${code}`);
        this.jobs.emit('event', { type: 'game-exit', procId: id, code, versionId });
      },
    });

    record.pid = result.pid;
    record.status = 'running';
    record.child = result.child;
    logger.info('launch', `已启动 ${versionId}，PID ${result.pid}`);
    return { id, versionId, pid: result.pid, status: 'running', startedAt: record.startedAt, java: java.path };
  }

  getProcess(id) {
    const p = this.processes.get(id);
    if (!p) return null;
    return {
      id: p.id,
      versionId: p.versionId,
      pid: p.pid,
      status: p.status,
      exitCode: p.exitCode,
      startedAt: p.startedAt,
      java: p.java,
      logs: p.logs.slice(-300),
    };
  }

  killProcess(id) {
    const p = this.processes.get(id);
    if (!p?.child) return false;
    p.child.kill('SIGTERM');
    p.status = 'killed';
    return true;
  }

  // ---------------- 日志 ----------------

  launcherLogs(n = 200) {
    return logger.recent(n);
  }
}
