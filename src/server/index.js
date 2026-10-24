import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { logger } from '../core/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RENDERER_DIR = path.join(__dirname, '..', 'renderer');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * HTTP 层：REST 与 SSE。
 *
 * 进度是单向推送，用 SSE 而非 WebSocket：自带断线重连，无需额外的握手与心跳协议。
 */
export function createServer(app) {
  const sseClients = new Set();

  app.jobs.on('event', (payload) => {
    broadcast(payload);
  });

  function broadcast(payload) {
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(data);
      } catch {
        sseClients.delete(res);
      }
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const { pathname } = url;

    // 只允许本机访问，避免局域网内被任意调用启动游戏
    const remote = req.socket.remoteAddress || '';
    if (!isLocalAddress(remote)) {
      return sendJson(res, 403, { error: '仅允许本机访问' });
    }

    if (pathname === '/api/stream') return handleSSE(req, res);

    if (pathname.startsWith('/api/')) {
      try {
        const handled = await handleApi(req, res, url);
        if (handled === false) sendJson(res, 404, { error: `未知接口 ${pathname}` });
      } catch (err) {
        logger.error('http', `${req.method} ${pathname} -> ${err.message}`);
        if (!res.headersSent) sendJson(res, 400, { error: err.message || '请求失败' });
        else res.end();
      }
      return;
    }

    serveStatic(res, pathname);
  });

  async function handleApi(req, res, url) {
    const p = url.pathname;
    const m = req.method;
    const body = async () => (m === 'POST' || m === 'PUT' ? await readJsonBody(req) : {});

    if (p === '/api/bootstrap' && m === 'GET') {
      return sendJson(res, 200, await app.bootstrap());
    }

    if (p === '/api/versions/remote' && m === 'GET') {
      const force = url.searchParams.get('force') === '1';
      return sendJson(res, 200, await app.remoteVersions({ force }));
    }

    if (p === '/api/versions/preview' && m === 'POST') {
      const b = await body();
      if (!b.versionId) throw new Error('缺少 versionId');
      return sendJson(res, 200, await app.preview(b.versionId, b));
    }

    if (p === '/api/install' && m === 'POST') {
      const b = await body();
      if (!b.versionId) throw new Error('缺少 versionId');
      return sendJson(res, 200, app.install(b.versionId, b.options || b));
    }

    if (p === '/api/verify' && m === 'POST') {
      const b = await body();
      if (!b.versionId) throw new Error('缺少 versionId');
      return sendJson(res, 200, app.verify(b.versionId, Boolean(b.repair)));
    }

    const delMatch = p.match(/^\/api\/versions\/([^/]+)$/);
    if (delMatch && m === 'DELETE') {
      return sendJson(res, 200, await app.deleteVersion(decodeURIComponent(delMatch[1])));
    }

    if (p === '/api/reveal' && m === 'POST') {
      const b = await body();
      if (!b.versionId) throw new Error('缺少 versionId');
      return sendJson(res, 200, await app.revealVersion(b.versionId));
    }

    if (p === '/api/storage' && m === 'GET') {
      return sendJson(res, 200, await app.storage());
    }

    if (p === '/api/jobs' && m === 'GET') {
      return sendJson(res, 200, { jobs: app.jobs.list() });
    }

    const jobAction = p.match(/^\/api\/jobs\/([^/]+)\/(pause|resume|cancel)$/);
    if (jobAction && m === 'POST') {
      const [, id, action] = jobAction;
      const job =
        action === 'pause' ? app.jobs.pause(id) : action === 'resume' ? app.jobs.resume(id) : app.jobs.cancel(id);
      if (!job) throw new Error('任务不存在');
      return sendJson(res, 200, job);
    }

    if (p === '/api/auth/offline' && m === 'POST') {
      const b = await body();
      return sendJson(res, 200, await app.setOfflineAccount(b.name));
    }

    // ---- 微软正版登录 ----
    if (p === '/api/auth/microsoft/start' && m === 'POST') {
      return sendJson(res, 200, await app.startMicrosoftLogin());
    }
    if (p === '/api/auth/microsoft/status' && m === 'GET') {
      return sendJson(res, 200, app.microsoftLoginStatus());
    }
    if (p === '/api/auth/microsoft/cancel' && m === 'POST') {
      return sendJson(res, 200, app.cancelMicrosoftLogin());
    }
    if (p === '/api/auth/microsoft/client-id' && m === 'POST') {
      const b = await body();
      return sendJson(res, 200, await app.setMsaClientId(b.clientId));
    }
    if (p === '/api/auth/microsoft/verify-client' && m === 'POST') {
      const b = await body();
      return sendJson(res, 200, await app.verifyMsaClientId(b.clientId));
    }
    if (p === '/api/auth/refresh' && m === 'POST') {
      const b = await body();
      return sendJson(res, 200, await app.refreshAccount({ force: b.force !== false }));
    }
    if (p === '/api/auth/logout' && m === 'POST') {
      return sendJson(res, 200, await app.logoutAccount());
    }
    if (p === '/api/auth/skin' && m === 'GET') {
      const skin = await app.accountSkin();
      return sendJson(res, 200, skin ? { dataUrl: skin.dataUrl, w: skin.w, h: skin.h } : { dataUrl: null });
    }

    if (p === '/api/config' && m === 'GET') {
      return sendJson(res, 200, { ...app.config.all, account: app.accountView() });
    }
    if (p === '/api/config' && m === 'POST') {
      const b = await body();
      const cfg = await app.setConfig(b);
      return sendJson(res, 200, { ...cfg, account: app.accountView() });
    }

    if (p === '/api/java/detect' && m === 'POST') {
      const b = await body();
      return sendJson(res, 200, { list: await app.detectJava(b.path) });
    }

    if (p === '/api/launch' && m === 'POST') {
      const b = await body();
      if (!b.versionId) throw new Error('缺少 versionId');
      return sendJson(res, 200, await app.launch(b.versionId, b));
    }

    const procMatch = p.match(/^\/api\/process\/([^/]+)(\/kill)?$/);
    if (procMatch) {
      const [, id, kill] = procMatch;
      if (kill && m === 'POST') return sendJson(res, 200, { ok: app.killProcess(id) });
      if (m === 'GET') {
        const proc = app.getProcess(id);
        if (!proc) throw new Error('进程不存在');
        return sendJson(res, 200, proc);
      }
    }

    if (p === '/api/logs' && m === 'GET') {
      const n = Number(url.searchParams.get('n') || 200);
      return sendJson(res, 200, { logs: app.launcherLogs(n) });
    }

    if (p === '/api/system' && m === 'GET') {
      return sendJson(res, 200, {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        cwd: process.cwd(),
        root: app.paths.root,
      });
    }

    return false;
  }

  function handleSSE(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(`retry: 2000\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'hello', ts: Date.now() })}\n\n`);
    sseClients.add(res);

    const heartbeat = setInterval(() => {
      try {
        res.write(`: ping\n\n`);
      } catch {
        /* ignore */
      }
    }, 20000);

    req.on('close', () => {
      clearInterval(heartbeat);
      sseClients.delete(res);
    });
  }

  function serveStatic(res, pathname) {
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = path.join(RENDERER_DIR, rel);
    if (!file.startsWith(RENDERER_DIR)) return notFound(res);
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return notFound(res);
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, {
        'content-type': MIME[ext] || 'application/octet-stream',
        'cache-control': 'no-cache',
      });
      fs.createReadStream(file).pipe(res);
    });
  }

  return { server, broadcast };
}

function notFound(res) {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('404 Not Found');
}

function sendJson(res, status, data) {
  if (res.headersSent || res.writableEnded) return;
  const text = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 2 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function isLocalAddress(addr) {
  if (!addr) return true;
  const a = addr.replace('::ffff:', '');
  return a === '127.0.0.1' || a === '::1' || a === 'localhost';
}

/** 端口占用时自动向后寻找可用端口 */
export async function listenWithFallback(server, startPort, tries = 20) {
  for (let i = 0; i < tries; i += 1) {
    const port = startPort + i;
    try {
      await new Promise((resolve, reject) => {
        const onError = (err) => {
          server.removeListener('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          server.removeListener('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, '127.0.0.1');
      });
      return port;
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
    }
  }
  throw new Error('找不到可用端口');
}

/**
 * 让操作系统分配空闲端口。桌面壳使用此方式启动服务，避免与用户机器上
 * 其他程序争抢固定端口。
 */
export function listenEphemeral(server) {
  return new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', onError);
      resolve(server.address().port);
    });
  });
}
