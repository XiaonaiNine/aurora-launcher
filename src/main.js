import { spawn } from 'node:child_process';
import { LauncherApp } from './app.js';
import { createServer, listenWithFallback } from './server/index.js';
import { logger } from './core/logger.js';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const PORT = Number(value('--port', 4571));
const SHOULD_OPEN = !flag('--no-open');
const ROOT = value('--root', undefined);

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch (err) {
    logger.warn('main', `自动打开浏览器失败: ${err.message}`);
  }
}

async function main() {
  const app = await LauncherApp.create(ROOT);
  const { server } = createServer(app);
  const port = await listenWithFallback(server, PORT);
  const url = `http://127.0.0.1:${port}`;

  logger.info('main', `Aurora Launcher 已启动 -> ${url}`);
  logger.info('main', `数据目录: ${app.paths.root}`);
  process.stdout.write(`\n  Aurora Launcher 运行中\n  界面地址: ${url}\n  按 Ctrl+C 停止\n\n`);

  if (SHOULD_OPEN) setTimeout(() => openBrowser(url), 400);

  // 记录异常后继续提供服务，避免单个请求的失败导致进程退出
  process.on('uncaughtException', (err) => {
    logger.error('main', `未捕获异常: ${err?.stack || err?.message || err}`);
  });
  process.on('unhandledRejection', (err) => {
    logger.error('main', `未处理的 Promise 拒绝: ${err?.stack || err?.message || err}`);
  });

  const shutdown = () => {
    logger.info('main', '正在关闭启动器...');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error('main', `启动失败: ${err.stack || err.message}`);
  process.exitCode = 1;
});
