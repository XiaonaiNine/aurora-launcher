import dns from 'node:dns';
import { BMCLAPI, NET } from '../shared/constants.js';
import { logger } from './logger.js';

/**
 * DNS 结果固定为 IPv4 优先。
 *
 * Mojang 与微软的 CDN 同时提供 A 与 AAAA 记录，DNS 通常把 IPv6 排在前面。
 * 当 IPv6 只有半截链路（能解析但连不通）时，Happy Eyeballs 会停在 AAAA 上
 * 直到连接超时，表现为间歇性失败。纯 IPv6 环境仍会回落到 AAAA。
 */
try {
  dns.setDefaultResultOrder('ipv4first');
} catch {
  /* 老版本 Node 没有这个 API，忽略即可 */
}

/** 可重试的失败类型：网络抖动 / 超时 / 5xx / 429 */
export class NetError extends Error {
  constructor(message, { retryable = true, status = 0, url = '', cause } = {}) {
    super(message);
    this.name = 'NetError';
    this.retryable = retryable;
    this.status = status;
    this.url = url;
    this.cause = cause;
  }
}

export class AbortError extends Error {
  constructor(msg = 'aborted') {
    super(msg);
    this.name = 'AbortError';
    this.aborted = true;
  }
}

/**
 * 把官方地址改写为镜像地址。镜像只在"重试"或"镜像策略"时启用，
 * 官方优先可以保证拿到最新数据，镜像负责兜底。
 */
export function mirrorUrl(url) {
  try {
    const u = new URL(url);
    if (BMCLAPI.passthroughHosts.includes(u.hostname)) {
      return `${BMCLAPI.host}${u.pathname}${u.search}`;
    }
    if (u.hostname === 'libraries.minecraft.net') {
      return `${BMCLAPI.libraries}${u.pathname}`;
    }
    if (u.hostname === 'resources.download.minecraft.net') {
      return `${BMCLAPI.assets}${u.pathname}`;
    }
    return url;
  } catch {
    return url;
  }
}

export function isMirrored(url) {
  return mirrorUrl(url) !== url;
}

/** 换源策略：mirror=auto 时第 2 次尝试开始走镜像 */
export function pickUrl(url, attempt, mirrorMode = 'auto') {
  if (mirrorMode === 'official') return url;
  if (mirrorMode === 'bmclapi') return mirrorUrl(url);
  return attempt >= 2 && isMirrored(url) ? mirrorUrl(url) : url;
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortError());
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new AbortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 带超时 + 组合信号的 fetch。任何一次调用都受两个信号约束：
 * 1) 用户取消（任务级 AbortController）
 * 2) 本请求的静默超时
 */
export async function rawFetch(url, { signal, timeout = NET.timeout, headers = {}, method = 'GET' } = {}) {
  const timeoutSignal = AbortSignal.timeout(timeout);
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  try {
    return await fetch(url, {
      method,
      headers: { 'user-agent': 'AuroraLauncher/1.0 (+https://localhost)', ...headers },
      signal: combined,
      redirect: 'follow',
    });
  } catch (err) {
    if (signal?.aborted) throw new AbortError();
    const isTimeout = err?.name === 'TimeoutError' || timeoutSignal.aborted;
    throw new NetError(isTimeout ? '请求超时' : `网络错误: ${err?.message || err}`, {
      retryable: true,
      url,
      cause: err,
    });
  }
}

/**
 * 统一的重试包装器。
 * - 4xx（除 408/429）视为永久失败，不重试
 * - 指数退避 + 抖动，避免弱网下并发任务同时打满
 */
export async function withRetry(fn, { retries = NET.retries, signal, onRetry, label = '' } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    if (signal?.aborted) throw new AbortError();
    try {
      return await fn(attempt);
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      lastErr = err;
      const retryable = err instanceof NetError ? err.retryable : true;
      if (!retryable || attempt === retries) break;
      const delay = Math.min(NET.backoffBase * 2 ** (attempt - 1), 8000) * (0.75 + Math.random() * 0.5);
      logger.warn('net', `${label || '请求'} 第 ${attempt} 次失败(${err.message})，${Math.round(delay)}ms 后重试`);
      onRetry?.({ attempt, error: err, delay });
      await sleep(delay, signal);
    }
  }
  throw lastErr;
}

export async function fetchJson(url, opts = {}) {
  const res = await withRetry(
    async (attempt) => {
      const target = pickUrl(url, attempt, opts.mirrorMode);
      const r = await rawFetch(target, opts);
      if (!r.ok) {
        throw new NetError(`HTTP ${r.status}`, {
          retryable: r.status === 408 || r.status === 429 || r.status >= 500,
          status: r.status,
          url: target,
        });
      }
      return r.json();
    },
    { ...opts, label: opts.label || url }
  );
  return res;
}

export async function fetchText(url, opts = {}) {
  return withRetry(
    async (attempt) => {
      const target = pickUrl(url, attempt, opts.mirrorMode);
      const r = await rawFetch(target, opts);
      if (!r.ok) {
        throw new NetError(`HTTP ${r.status}`, {
          retryable: r.status === 408 || r.status === 429 || r.status >= 500,
          status: r.status,
          url: target,
        });
      }
      return r.text();
    },
    { ...opts, label: opts.label || url }
  );
}
