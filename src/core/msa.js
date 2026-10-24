/**
 * 微软账户登录。
 *
 * 设备码授权 → MSA 令牌 → Xbox Live → XSTS → Minecraft 令牌 → 正版资格 → 角色档案。
 * 使用设备码而非授权码回调，不需要登记重定向 URI，也不需要在本机监听端口。
 * 前置条件是用户自行注册的 Azure 应用，校验逻辑见 verifyClientId()。
 */
import crypto from 'node:crypto';
import { logger } from './logger.js';

const BASE = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';

export const MSA_SCOPE = 'XboxLive.signin offline_access';

export const ENDPOINTS = {
  deviceCode: `${BASE}/devicecode`,
  token: `${BASE}/token`,
  xbl: 'https://user.auth.xboxlive.com/user/authenticate',
  xsts: 'https://xsts.auth.xboxlive.com/xsts/authorize',
  mcLogin: 'https://api.minecraftservices.com/authentication/login_with_xbox',
  entitlements: 'https://api.minecraftservices.com/entitlements/mcstore',
  profile: 'https://api.minecraftservices.com/minecraft/profile',
};

/* ---------------- 统一请求 ---------------- */

/**
 * @returns {Promise<{ok:boolean,status:number,data:any,text:string}>}
 * 不抛 HTTP 层面的错误，状态码交给调用方按业务语义处理。
 * 连接层失败会重试一次：微软登录端点在某些网络下首次连接会卡到超时。
 */
async function request(url, { method = 'GET', json, form, token, signal, timeout = 30000, attempts = 2 } = {}) {
  const headers = { accept: 'application/json' };
  let body;
  if (json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(json);
  } else if (form !== undefined) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form).toString();
  }
  if (token) headers.authorization = `Bearer ${token}`;

  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const signals = [AbortSignal.timeout(timeout)];
    if (signal) signals.push(signal);
    try {
      const res = await fetch(url, { method, headers, body, signal: AbortSignal.any(signals) });
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        /* 非 JSON 响应（例如 HTML 错误页） */
      }
      return { ok: res.ok, status: res.status, data, text };
    } catch (err) {
      if (err?.name === 'AbortError') throw err; // 用户主动取消，不重试
      lastErr = err;
      if (attempt < attempts) await new Promise((r) => setTimeout(r, 400));
    }
  }

  if (lastErr?.name === 'TimeoutError') throw new Error('连接微软服务超时，请检查网络或代理');
  // fetch 只抛 "fetch failed"，真正有用的原因在 cause 里（ENOTFOUND / ECONNRESET / 证书等）
  const cause = lastErr?.cause?.message || lastErr?.cause?.code || lastErr?.message || '';
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  })();
  throw new Error(`连接 ${host} 失败${cause ? `：${cause}` : ''}，请检查网络或代理设置`);
}

/* ---------------- 错误翻译 ---------------- */

/**
 * Azure 的 AADSTS 码对用户毫无意义，这里翻译成"下一步该干什么"。
 * 700016 / 7000218 是配置 clientId 时最常踩的两个坑，必须说清楚。
 */
export function describeAadError(data) {
  const code = data?.error_codes?.[0];
  const raw = String(data?.error_description || data?.error || '');
  const aad = raw.match(/AADSTS\d+/)?.[0] || (code ? `AADSTS${code}` : '');

  const table = {
    AADSTS700016: '应用 ID 不存在。请确认复制的是「应用程序(客户端) ID」，且该应用注册在个人 Microsoft 账户目录下',
    AADSTS7000218: '该应用未开启「允许公共客户端流」。请到 Azure 门户 → 身份验证 → 高级设置 → 允许公共客户端流 → 选「是」并保存',
    AADSTS7000215: '应用需要客户端密钥，请改用「公共客户端」类型的注册',
    AADSTS500011: '应用尚未完成同意授权，请稍后重试',
    AADSTS650052: '该应用缺少 XboxLive 权限，请检查注册时的账户类型是否为个人账户',
    AADSTS900144: '请求缺少必要参数，请检查应用 ID 格式',
    AADSTS900971: '应用 ID 格式不正确，应为 36 位 GUID',
  };
  if (table[aad]) return table[aad];

  if (data?.error === 'invalid_client') return '应用 ID 无效或不是公共客户端应用';
  if (/AADSTS\d+/.test(raw)) return `${aad || '微软返回错误'}：${raw.split(':').slice(2).join(':').trim() || raw}`;
  return raw || '微软服务返回了未知错误';
}

const XERR_TABLE = {
  2148916233: '该微软账户还没有 Xbox 档案，通常意味着这个账户没有购买过 Minecraft。请先在 xbox.com 登录一次再回来',
  2148916235: '该账户所在地区不支持 Xbox Live',
  2148916236: '该账户需要先完成年龄验证',
  2148916237: '该账户已超出屏幕时间限制，被允许的游玩时段已结束',
  2148916238: '该账户未满 18 岁，需要先加入一个 Microsoft 家庭组，并由组织者允许使用 Minecraft',
  2148916227: '该账户因违反社区准则被封禁',
  2148916229: '该账户的 Xbox Live 功能已被限制',
};

/* ---------------- 第 1 步：设备码 ---------------- */

export async function requestDeviceCode(clientId, { signal } = {}) {
  const id = String(clientId || '').trim();
  if (!id) throw new Error('未配置微软应用 ID');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error('应用 ID 格式不正确，应为 36 位 GUID（形如 00000000-0000-0000-0000-000000000000）');
  }
  const res = await request(ENDPOINTS.deviceCode, { method: 'POST', form: { client_id: id, scope: MSA_SCOPE }, signal });
  if (!res.ok || !res.data?.device_code) throw new Error(describeAadError(res.data));
  logger.info('auth', '已获取微软设备码');
  return {
    deviceCode: res.data.device_code,
    userCode: res.data.user_code,
    verificationUri: res.data.verification_uri || 'https://microsoft.com/link',
    expiresIn: Number(res.data.expires_in) || 900,
    interval: Number(res.data.interval) || 5,
    message: res.data.message || '',
  };
}

/** 只校验应用 ID 能不能用（不发真实登录），用于配置引导时的即时反馈 */
export async function verifyClientId(clientId, { signal } = {}) {
  const code = await requestDeviceCode(clientId, { signal });
  return { ok: true, verificationUri: code.verificationUri, expiresIn: code.expiresIn };
}

/* ---------------- 第 2 步：轮询令牌 ---------------- */

export async function pollDeviceCode(clientId, deviceCode, { signal } = {}) {
  const res = await request(ENDPOINTS.token, {
    method: 'POST',
    form: {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: String(clientId).trim(),
      device_code: deviceCode,
    },
    signal,
  });
  if (res.ok && res.data?.access_token) {
    return { pending: false, accessToken: res.data.access_token, refreshToken: res.data.refresh_token || '' };
  }
  const err = res.data?.error;
  if (err === 'authorization_pending') return { pending: true };
  if (err === 'slow_down') return { pending: true, slowDown: true };
  if (err === 'expired_token') throw Object.assign(new Error('授权码已过期，请重新发起登录'), { expired: true });
  if (err === 'authorization_declined') throw new Error('你已拒绝授权，登录已取消');
  if (err === 'bad_verification_code') throw new Error('授权码无效，请重新发起登录');
  throw new Error(describeAadError(res.data));
}

/* ---------------- 第 3 步：刷新令牌 ---------------- */

export async function refreshMsaToken(clientId, refreshToken, { signal } = {}) {
  if (!refreshToken) throw new Error('没有可用的刷新令牌，请重新登录');
  const res = await request(ENDPOINTS.token, {
    method: 'POST',
    form: {
      grant_type: 'refresh_token',
      client_id: String(clientId).trim(),
      refresh_token: refreshToken,
      scope: MSA_SCOPE,
    },
    signal,
  });
  if (!res.ok || !res.data?.access_token) {
    const err = res.data?.error;
    if (err === 'invalid_grant') {
      throw Object.assign(new Error('登录已失效（刷新令牌过期或被吊销），请重新登录微软账户'), { relogin: true });
    }
    throw new Error(describeAadError(res.data));
  }
  return { accessToken: res.data.access_token, refreshToken: res.data.refresh_token || refreshToken };
}

/* ---------------- 第 4 步：Xbox Live → XSTS ---------------- */

export async function xboxLiveAuth(msaAccessToken, { signal } = {}) {
  const res = await request(ENDPOINTS.xbl, {
    method: 'POST',
    json: {
      Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: `d=${msaAccessToken}` },
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType: 'JWT',
    },
    signal,
  });
  if (!res.ok || !res.data?.Token) {
    throw new Error(`Xbox Live 认证失败 (HTTP ${res.status})${res.data?.Message ? `：${res.data.Message}` : ''}`);
  }
  return res.data.Token;
}

export async function xstsAuth(xblToken, { signal } = {}) {
  const res = await request(ENDPOINTS.xsts, {
    method: 'POST',
    json: {
      Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] },
      RelyingParty: 'rp://api.minecraftservices.com/',
      TokenType: 'JWT',
    },
    signal,
  });
  if (res.ok && res.data?.Token) {
    const claim = res.data.DisplayClaims?.xui?.[0] || {};
    return { token: res.data.Token, uhs: claim.uhs, xuid: claim.xid };
  }
  const xerr = res.data?.XErr;
  const hint = XERR_TABLE[xerr];
  if (hint) throw Object.assign(new Error(hint), { xerr });
  if (res.status === 401 && !xerr) {
    throw new Error('XSTS 授权被拒绝：该账户可能没有 Xbox 档案，或所在地区不支持');
  }
  throw new Error(`XSTS 授权失败 (HTTP ${res.status}${xerr ? `，XErr ${xerr}` : ''})`);
}

/* ---------------- 第 5 步：Minecraft 服务 ---------------- */

export async function minecraftLogin(uhs, xstsToken, { signal } = {}) {
  const res = await request(ENDPOINTS.mcLogin, {
    method: 'POST',
    json: { identityToken: `XBL3.0 x=${uhs};${xstsToken}` },
    signal,
  });
  if (!res.ok || !res.data?.access_token) {
    if (res.status === 401) throw new Error('Minecraft 服务拒绝登录，请确认该账户拥有 Minecraft Java 版');
    if (res.status === 429) throw new Error('Minecraft 服务限流，请稍等一分钟再试');
    throw new Error(`Minecraft 服务登录失败 (HTTP ${res.status})`);
  }
  return {
    accessToken: res.data.access_token,
    expiresIn: Number(res.data.expires_in) || 86400,
  };
}

/** 正版资格：没有 items 说明这个账户没买过 Minecraft */
export async function checkEntitlements(mcToken, { signal } = {}) {
  const res = await request(ENDPOINTS.entitlements, { token: mcToken, signal });
  if (!res.ok) return { owns: null, items: [] }; // 接口异常不作为拒绝理由
  const items = Array.isArray(res.data?.items) ? res.data.items : [];
  const owns = items.some((it) => /^product_minecraft$|^game_minecraft$/.test(it.name || ''));
  return { owns, items: items.map((it) => it.name) };
}

export async function fetchProfile(mcToken, { signal } = {}) {
  const res = await request(ENDPOINTS.profile, { token: mcToken, signal });
  if (!res.ok || !res.data?.id) {
    if (res.status === 404) {
      throw new Error('该账户尚未创建 Minecraft 角色名，请先在官方启动器里登录并完成角色创建');
    }
    throw new Error(`获取 Minecraft 档案失败 (HTTP ${res.status})`);
  }
  return {
    id: res.data.id,
    name: res.data.name,
    skins: Array.isArray(res.data.skins) ? res.data.skins : [],
    capes: Array.isArray(res.data.capes) ? res.data.capes : [],
  };
}

/* ---------------- 第 6 步：皮肤 ---------------- */

const skinCache = new Map(); // uuid -> { dataUrl, w, h, at }

/**
 * 把皮肤 PNG 取回来转成 data URL，前端用 CSS 裁出正面头像。
 * 不走第三方头像站（mc-heads / crafatar 在国内经常连不上）。
 */
export async function fetchSkinData(profile, { signal } = {}) {
  const url = profile?.skins?.find((s) => s.state === 'ACTIVE')?.url || profile?.skins?.[0]?.url;
  if (!url) return null;
  const cached = skinCache.get(profile.id);
  if (cached && Date.now() - cached.at < 10 * 60_000) return cached;

  try {
    const signals = [AbortSignal.timeout(15000)];
    if (signal) signals.push(signal);
    const res = await fetch(url, { signal: AbortSignal.any(signals) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 4 * 1024 * 1024) return null; // 异常大的响应直接放弃
    // 从 PNG IHDR 里读真实尺寸，决定前端怎么裁
    const w = buf.length > 24 ? buf.readUInt32BE(16) : 64;
    const h = buf.length > 24 ? buf.readUInt32BE(20) : 64;
    const entry = { dataUrl: `data:image/png;base64,${buf.toString('base64')}`, w, h, at: Date.now() };
    skinCache.set(profile.id, entry);
    return entry;
  } catch (err) {
    if (err?.name === 'AbortError') return null;
    logger.warn('auth', `皮肤获取失败: ${err.message}`);
    return null;
  }
}

/* ---------------- 组合：MSA 令牌 → 启动器账户 ---------------- */

/**
 * 把一枚 MSA access_token 一路换成可直接用于启动的账户对象。
 * 首次登录与令牌刷新共用这条路径，保证两种情况下产出的账户结构完全一致。
 */
export async function buildAccount({
  msaAccessToken,
  refreshToken = '',
  clientId = '',
  expectName = '',
  signal,
  onStep = () => {},
}) {
  onStep('xbox', '正在验证 Xbox Live 账户…');
  const xblToken = await xboxLiveAuth(msaAccessToken, { signal });

  onStep('xsts', '正在获取 XSTS 授权…');
  const xsts = await xstsAuth(xblToken, { signal });

  onStep('minecraft', '正在登录 Minecraft 服务…');
  const mc = await minecraftLogin(xsts.uhs, xsts.token, { signal });

  onStep('entitlement', '正在校验正版资格…');
  const ent = await checkEntitlements(mc.accessToken, { signal });
  if (ent.owns === false) {
    throw Object.assign(
      new Error('这个微软账户没有 Minecraft Java 版的购买记录。如果确定已购买，请确认登录的是购买时使用的账户'),
      { noEntitlement: true }
    );
  }

  onStep('profile', '正在读取角色档案…');
  const profile = await fetchProfile(mc.accessToken, { signal });
  if (expectName && profile.name && profile.name.toLowerCase() !== expectName.toLowerCase()) {
    logger.warn('auth', `角色名与本地记录不一致：${expectName} -> ${profile.name}`);
  }

  logger.info('auth', `微软账户登录成功：${profile.name}`);

  return {
    mode: 'microsoft',
    name: profile.name,
    uuid: profile.id,
    accessToken: mc.accessToken,
    userType: 'msa',
    xuid: xsts.xuid || '',
    refreshToken,
    clientId,
    // 提前 5 分钟视为过期，避免"刚点启动就 401"
    expiresAt: Date.now() + (mc.expiresIn - 300) * 1000,
    skins: profile.skins.length,
    capes: profile.capes.length,
    /** 皮肤贴图地址，UI 用来渲染正版头像（不依赖第三方头像站） */
    skinUrl: profile.skins.find((s) => s.state === 'ACTIVE')?.url || profile.skins[0]?.url || '',
    loggedInAt: Date.now(),
  };
}

export function isAccountExpired(account, skewMs = 5 * 60_000) {
  if (account?.mode !== 'microsoft') return false;
  if (!account.expiresAt) return true;
  return Date.now() + skewMs >= account.expiresAt;
}

/* ---------------- 登录会话 ---------------- */

const SESSION_TTL = 20 * 60_000;

/**
 * 一次登录尝试就是一个会话：start() 之后在后台轮询，状态存在服务端，
 * 前端关掉弹窗再打开也能接上（轮询 /api/auth/microsoft/status 即可）。
 */
export class MsaLoginSession {
  constructor({ clientId, onChange = () => {} }) {
    this.id = `msa_${crypto.randomBytes(5).toString('hex')}`;
    this.clientId = clientId;
    this.onChange = onChange;
    this.state = 'starting'; // starting|waiting|authorized|xbox|xsts|minecraft|entitlement|profile|done|error|cancelled|expired
    this.hint = '正在向微软申请设备码…';
    this.error = '';
    this.errorKind = '';
    this.userCode = '';
    this.verificationUri = 'https://microsoft.com/link';
    this.message = '';
    this.interval = 5;
    this.expiresAt = 0;
    this.account = null;
    this.createdAt = Date.now();
    this.controller = new AbortController();
    this._timer = null;
  }

  /** 给前端看的状态快照（不包含内部对象） */
  toJSON() {
    return {
      id: this.id,
      state: this.state,
      hint: this.hint,
      error: this.error,
      errorKind: this.errorKind,
      userCode: this.userCode,
      verificationUri: this.verificationUri,
      message: this.message,
      expiresAt: this.expiresAt,
      account: this.account
        ? {
            mode: this.account.mode,
            name: this.account.name,
            uuid: this.account.uuid,
            xuid: this.account.xuid,
            expiresAt: this.account.expiresAt,
            skins: this.account.skins,
            capes: this.account.capes,
          }
        : null,
    };
  }

  _set(patch) {
    Object.assign(this, patch);
    this.onChange(this.toJSON());
  }

  /**
   * 申请设备码后立即返回（前端要马上看到验证码），轮询在后台继续跑。
   * 状态变化通过 onChange 往外推，调用方不需要 await 到登录结束。
   */
  async start() {
    try {
      const device = await requestDeviceCode(this.clientId, { signal: this.controller.signal });
      this.interval = Math.max(1, device.interval || 5);
      this._set({
        state: 'waiting',
        userCode: device.userCode,
        verificationUri: device.verificationUri,
        message: device.message,
        expiresAt: Date.now() + device.expiresIn * 1000,
        hint: '请打开下方网址，输入验证码完成授权',
      });
      // 后台轮询，不阻塞调用方；异常已在内部转成 error 状态
      this._poll(device.deviceCode).catch((err) => {
        if (!this.controller.signal.aborted) this._fail(err);
      });
      return this.toJSON();
    } catch (err) {
      if (this.controller.signal.aborted) return this.toJSON();
      this._fail(err);
      return this.toJSON();
    }
  }

  async _poll(deviceCode) {
    let interval = this.interval;
    while (!this.controller.signal.aborted) {
      if (Date.now() > this.expiresAt) {
        this._set({ state: 'expired', error: '验证码已过期，请重新发起登录', errorKind: 'expired' });
        return;
      }
      await sleep(interval * 1000, this.controller.signal);
      if (this.controller.signal.aborted) return;

      let result;
      try {
        result = await pollDeviceCode(this.clientId, deviceCode, { signal: this.controller.signal });
      } catch (err) {
        if (this.controller.signal.aborted) return;
        this._fail(err);
        return;
      }
      if (result.pending) {
        if (result.slowDown) interval += 5;
        continue;
      }

      // 已拿到微软令牌，进入换取游戏身份的阶段
      this._set({ state: 'authorized', hint: '授权成功，正在换取游戏身份…' });
      try {
        const account = await buildAccount({
          msaAccessToken: result.accessToken,
          refreshToken: result.refreshToken,
          clientId: this.clientId,
          signal: this.controller.signal,
          onStep: (state, hint) => this._set({ state, hint }),
        });
        this._set({ state: 'done', hint: '登录成功', account });
      } catch (err) {
        if (!this.controller.signal.aborted) this._fail(err);
      }
      return;
    }
  }

  _fail(err) {
    // 验证码过期是"正常结束"，单独一个状态，UI 才能给出"重新发起"而不是"出错"
    if (err?.expired) {
      logger.info('auth', '验证码已过期');
      this._set({ state: 'expired', error: err.message, errorKind: 'expired', hint: '' });
      return;
    }
    const kind = err?.noEntitlement ? 'no-entitlement' : err?.xerr ? 'xbox' : err?.relogin ? 'relogin' : 'error';
    logger.warn('auth', `微软登录失败：${err.message}`);
    this._set({ state: 'error', error: err?.message || String(err), errorKind: kind, hint: '' });
  }

  cancel() {
    this.controller.abort();
    if (this._timer) clearTimeout(this._timer);
    if (this.state !== 'done') this._set({ state: 'cancelled', hint: '', error: '' });
  }

  get isFinished() {
    return ['done', 'error', 'cancelled', 'expired'].includes(this.state);
  }

  get isStale() {
    return this.isFinished && Date.now() - this.createdAt > SESSION_TTL;
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

export { sleep as __sleep };
