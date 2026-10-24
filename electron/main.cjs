/**
 * Aurora Launcher 主进程。
 *
 * 在本机回环地址运行内置后端，用 BrowserWindow 加载该地址，并负责单实例、
 * 窗口生命周期与子进程回收。后端为 ESM，此处以动态 import() 加载，主进程
 * 本身保持 CJS。
 */
const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

const APP_DIR = __dirname; // .../resources/app
const SRC_DIR = path.join(APP_DIR, 'src');
const ICON = path.join(APP_DIR, 'icon.ico');

/**
 * 主进程会把 argv 中以 `--` 开头的未知参数当作自身选项并报 bad option 退出，
 * 因此调试开关统一走环境变量。
 */
const isDev = process.env.AURORA_DEV === '1';
const shotPath = process.env.AURORA_SHOT || '';

/* ---------------- 启动日志 ---------------- */
/**
 * GUI 子系统下 stdout 不可靠（双击启动时根本没有控制台），所以启动阶段的
 * 每一步都同步落盘。默认写到 exe 同级的 aurora-boot.log，失败再退到临时目录。
 */
let bootLogPath = null;
function bootLog(...parts) {
  const line = `${new Date().toISOString()}  ${parts.join(' ')}\n`;
  if (!bootLogPath) {
    const candidates = [];
    try {
      candidates.push(path.join(path.dirname(app.getPath('exe')), 'aurora-boot.log'));
    } catch {
      /* ignore */
    }
    candidates.push(path.join(os.tmpdir(), 'aurora-boot.log'));
    for (const file of candidates) {
      try {
        fs.appendFileSync(file, '');
        bootLogPath = file;
        break;
      } catch {
        /* try next */
      }
    }
    if (bootLogPath) {
      // 重启（兼容降级）会产生新一轮进程，日志接着写而不是清空，方便对照
      try {
        const size = fs.statSync(bootLogPath).size;
        if (size > 256 * 1024) fs.writeFileSync(bootLogPath, '');
        fs.appendFileSync(bootLogPath, `\n=== Aurora Launcher 启动 ${new Date().toISOString()} ===\n`);
      } catch {
        /* ignore */
      }
    }
  }
  if (!bootLogPath) return;
  try {
    fs.appendFileSync(bootLogPath, line);
  } catch {
    /* ignore */
  }
}

bootLog(
  'module loaded',
  `electron=${process.versions.electron}`,
  `node=${process.versions.node}`,
  `exe=${process.execPath}`,
  `argv=${JSON.stringify(process.argv.slice(1))}`
);

let mainWindow = null;
let httpServer = null;
let backendUrl = null;
let shuttingDown = false;
/** 界面是否已加载完成，用于区分加载期崩溃与运行期崩溃 */
let pageLoaded = false;

app.setAppUserModelId('com.aurora.launcher');

/* ---------------- 数据目录 ---------------- */
/**
 * 便携模式：数据放在 exe 同级的 data/ 里，整个文件夹拷走即迁移。
 * 可用环境变量 AURORA_ROOT 覆盖（调试、或指向已有的 .minecraft）。
 */
function resolveDataRoot() {
  if (process.env.AURORA_ROOT) return path.resolve(process.env.AURORA_ROOT);
  if (app.isPackaged) return path.join(path.dirname(app.getPath('exe')), 'data');
  return path.join(os.homedir(), '.aurora-minecraft');
}

/* ---------------- 渲染兼容降级链 ---------------- */
/**
 * 渲染兼容降级链。
 *
 * 虚拟机、远程桌面、旧显卡驱动、精简系统，以及带限制性 Job 对象的宿主进程上，
 * Chromium 可能以两种方式失败：GPU 进程反复崩溃（0xC0000005）导致 Chromium
 * 判定 GPU 不可用并 FATAL 退出；渲染进程崩溃（0x80000003）多因沙箱被系统拦住。
 * 两者都表现为窗口一闪而过，且 GUI 子系统不产生 stdout。
 *
 * 启动时按 stage 应用渲染配置，运行中检测到崩溃则升一级并重启：
 *   0  硬件加速 + 沙箱              正常机器
 *   1  软件渲染 + 沙箱              GPU 进程不可用
 *   2  软件渲染 + 关闭 Chromium 沙箱  沙箱在当前系统上无法运行
 * stage 记在 data/compat.json，随便携目录一起迁移；删除该文件即回到 stage 0。
 */
const COMPAT_LADDER = [
  { render: 'gpu', sandbox: true },
  { render: 'software', sandbox: true },
  { render: 'software', sandbox: false },
];

const COMPAT_FILE = path.join(resolveDataRoot(), 'compat.json');

function readCompatStage() {
  // 环境变量优先，便于排查（AURORA_COMPAT_STAGE=0/1/2）
  const forced = process.env.AURORA_COMPAT_STAGE;
  if (forced !== undefined && /^[012]$/.test(forced.trim())) {
    return Number(forced.trim());
  }
  if (process.env.AURORA_SOFTWARE_RENDER === '1') return 1;
  try {
    const saved = JSON.parse(fs.readFileSync(COMPAT_FILE, 'utf8'));
    const stage = Number(saved?.stage);
    if (Number.isInteger(stage) && stage >= 0 && stage < COMPAT_LADDER.length) return stage;
  } catch {
    /* 没配过或文件损坏 → 用默认值 */
  }
  return 0;
}

/** 当前进程实际生效的 stage。升级时靠它判断还能不能再降。 */
const compatStage = readCompatStage();

function applyCompatStage(stage) {
  const cfg = COMPAT_LADDER[stage] || COMPAT_LADDER[0];
  if (cfg.render === 'software') {
    app.disableHardwareAcceleration();
    app.commandLine.appendSwitch('disable-gpu');
    app.commandLine.appendSwitch('disable-gpu-compositing');
  }
  if (!cfg.sandbox) {
    app.commandLine.appendSwitch('no-sandbox');
  }
  bootLog(
    `渲染配置 stage=${stage}`,
    `render=${cfg.render}`,
    `sandbox=${cfg.sandbox}`
  );
}

applyCompatStage(compatStage);

/** 已因兼容问题重启过一次就不再重启，避免死循环 */
let compatEscalated = false;

/**
 * 升一级并重启。
 * @param {string} reason 触发原因，写进 compat.json 便于排查
 * @param {number} [target] 想直接跳到哪一级（不传就 +1）。渲染进程崩溃基本可以
 *   断定是 Chromium 沙箱被系统挡住，跳过"仅关 GPU"那一级省一次重启。
 */
function escalateCompat(reason, target) {
  if (compatEscalated) return;
  const last = COMPAT_LADDER.length - 1;
  if (compatStage >= last) {
    bootLog('兼容降级到底了，仍然失败：', reason);
    return;
  }
  compatEscalated = true;
  const next = Math.min(Math.max(target ?? compatStage + 1, compatStage + 1), last);
  try {
    fs.mkdirSync(path.dirname(COMPAT_FILE), { recursive: true });
    fs.writeFileSync(COMPAT_FILE, JSON.stringify({ stage: next, reason, at: new Date().toISOString() }, null, 2));
  } catch (err) {
    bootLog('写入兼容配置失败', String(err));
  }
  bootLog(`渲染异常（${reason}），降级到 stage=${next} 后重启`);
  app.releaseSingleInstanceLock();
  app.relaunch();
  app.exit(0);
}

/* ---------------- 单实例 ---------------- */
const gotLock = app.requestSingleInstanceLock();
bootLog('requestSingleInstanceLock ->', gotLock);
if (!gotLock) {
  bootLog('已有实例在运行，退出');
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  bootstrap();
}

function bootstrap() {
  bootLog('bootstrap() 进入');

  // 启动器自身的日志也写文件，出问题时用户能直接发给我们
  process.on('uncaughtException', (err) => {
    bootLog('uncaughtException', err?.stack || String(err));
    console.error('[main] uncaughtException', err);
  });
  process.on('unhandledRejection', (err) => {
    bootLog('unhandledRejection', err?.stack || String(err));
    console.error('[main] unhandledRejection', err);
  });

  app.on('will-quit', () => bootLog('will-quit'));
  app.on('quit', () => bootLog('quit'));

  // GPU 进程连续崩溃两次 → 降级（多半是显卡/驱动/远程桌面环境起不来 GPU 进程）
  let gpuCrashes = 0;
  app.on('child-process-gone', (event, details) => {
    bootLog('子进程退出', details.type, details.reason, `exitCode=${details.exitCode}`);
    if (details.type !== 'GPU') return;
    if (details.reason !== 'crashed' && details.reason !== 'abnormal-exit') return;
    gpuCrashes += 1;
    if (gpuCrashes < 2) return;
    escalateCompat('GPU 进程反复崩溃');
  });

  // 渲染进程崩在加载完成之前 → 同样是"开了个空窗口就没了"，直接降级
  app.on('render-process-gone', (event, contents, details) => {
    bootLog('渲染进程退出', details.reason, `exitCode=${details.exitCode}`);
    if (details.reason !== 'crashed') return;
    if (contents === mainWindow?.webContents && !pageLoaded) {
      escalateCompat('渲染进程在页面加载完成前崩溃', COMPAT_LADDER.length - 1);
    }
  });

  bootLog('等待 app.whenReady …');
  app
    .whenReady()
    .then(async () => {
      bootLog('app.whenReady 完成');
      Menu.setApplicationMenu(null);
      try {
        const url = await startBackend();
        bootLog('createWindow', url);
        createWindow(url);
      } catch (err) {
        bootLog('启动失败', err?.stack || String(err));
        console.error('[main] 启动失败', err);
        dialog.showErrorBox(
          'Aurora Launcher 启动失败',
          `${err?.stack || err?.message || err}\n\n数据目录：${resolveDataRoot()}\n\n启动日志：${bootLogPath || '(未能写入)'}`
        );
        app.quit();
      }
    })
    .catch((err) => {
      bootLog('whenReady 失败', err?.stack || String(err));
    });

  // macOS：点 dock 图标重开窗口
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && backendUrl) {
      createWindow(backendUrl);
    }
  });

  app.on('window-all-closed', () => {
    shutdown();
  });

  app.on('before-quit', shutdown);
}

/* ---------------- 后端 ---------------- */
async function startBackend() {
  const root = resolveDataRoot();
  bootLog('数据目录', root, 'isPackaged=', app.isPackaged);
  fs.mkdirSync(root, { recursive: true });

  bootLog('import app.js');
  const appMod = await import(pathToFileURL(path.join(SRC_DIR, 'app.js')).href);
  bootLog('import server/index.js');
  const serverMod = await import(pathToFileURL(path.join(SRC_DIR, 'server', 'index.js')).href);
  bootLog('import 完成, LauncherApp.create …');

  const launcherApp = await appMod.LauncherApp.create(root);
  bootLog('LauncherApp 就绪, createServer …');
  const { server } = serverMod.createServer(launcherApp);
  bootLog('listenEphemeral …');
  const port = await serverMod.listenEphemeral(server);
  bootLog('监听端口', port);

  httpServer = server;
  backendUrl = `http://127.0.0.1:${port}`;
  global.__auroraApp = launcherApp;
  console.log(`[main] 后端已就绪 ${backendUrl}  数据目录 ${root}`);
  return backendUrl;
}

/* ---------------- 窗口 ---------------- */
function createWindow(url) {
  if (!url) return;
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 920,
    minWidth: 1040,
    minHeight: 680,
    show: false,
    backgroundColor: '#eef1f6',
    title: 'Aurora Launcher',
    icon: fs.existsSync(ICON) ? ICON : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: (COMPAT_LADDER[compatStage] || COMPAT_LADDER[0]).sandbox,
      spellcheck: false,
      backgroundThrottling: false, // 最小化时不要拖慢下载进度推送
    },
  });

  mainWindow.__url = url;
  mainWindow.setMenuBarVisibility(false);
  // 居中偏上，看起来更像原生应用而不是网页
  mainWindow.center();

  mainWindow.webContents.on('did-finish-load', () => {
    pageLoaded = true;
    bootLog('页面加载完成');
  });
  mainWindow.webContents.on('did-fail-load', (event, code, desc, failedUrl) => {
    bootLog('页面加载失败', code, desc, failedUrl);
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  // 站外链接交给系统浏览器，不允许应用内导航（这是单页应用，导航一定异常）
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (!target.startsWith('http://127.0.0.1')) shell.openExternal(target);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, target) => {
    if (!target.startsWith(url)) {
      event.preventDefault();
      shell.openExternal(target);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.loadURL(url);

  // 兜底：万一 ready-to-show 迟迟不触发，也别让用户对着空气等
  const showTimer = setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      bootLog('ready-to-show 超时，强制显示窗口');
      mainWindow.show();
    }
  }, 8000);
  mainWindow.once('closed', () => clearTimeout(showTimer));

  // 截图模式：给构建/回归用，加载完成后抓图并退出
  if (shotPath) {
    mainWindow.webContents.once('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, Number(process.env.AURORA_SHOT_DELAY || 3200)));
      try {
        const image = await mainWindow.webContents.capturePage();
        fs.writeFileSync(shotPath, image.toPNG());
        console.log(`[main] 截图已保存 ${shotPath}`);
      } catch (err) {
        console.error('[main] 截图失败', err);
      }
      app.quit();
    });
  }
}

/* ---------------- 退出 ---------------- */
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    httpServer?.close();
  } catch {
    /* ignore */
  }
  // 结束真正在运行的游戏子进程，避免出现"启动器关了、游戏还在跑"的孤儿进程
  try {
    const launcher = global.__auroraApp;
    if (launcher?.processes) {
      for (const proc of launcher.processes.values()) {
        try {
          proc.child?.kill();
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
  setTimeout(() => app.exit(0), 120);
}
