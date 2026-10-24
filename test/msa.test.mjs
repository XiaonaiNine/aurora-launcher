import test from 'node:test';
import assert from 'node:assert/strict';

import { logger } from '../src/core/logger.js';
import {
  describeAadError,
  requestDeviceCode,
  pollDeviceCode,
  refreshMsaToken,
  buildAccount,
  isAccountExpired,
  MsaLoginSession,
} from '../src/core/msa.js';

logger.level = 'error';

const CLIENT_ID = '11111111-2222-3333-4444-555555555555';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * 用固定响应替换 fetch。路由按顺序匹配 URL 子串，
 * 顺序有意义：login_with_xbox 与 minecraft/profile 都在 api.minecraftservices.com 下。
 */
function stubFetch(overrides = {}) {
  const routes = [
    ['devicecode', () => json({ device_code: 'dev-code', user_code: 'K7QP2XHD', verification_uri: 'https://microsoft.com/link', expires_in: 900, interval: 1 })],
    ['oauth2/v2.0/token', () => json({ access_token: 'msa-token', refresh_token: 'refresh-token', expires_in: 3600 })],
    ['xsts.auth.xboxlive.com', () => json({ Token: 'xsts-token', DisplayClaims: { xui: [{ uhs: 'uhs-123', xid: '2535400000000001' }] } })],
    ['user.auth.xboxlive.com', () => json({ Token: 'xbl-token' })],
    ['login_with_xbox', () => json({ access_token: 'mc-token', expires_in: 86400 })],
    ['entitlements', () => json({ items: [{ name: 'product_minecraft' }, { name: 'game_minecraft' }] })],
    ['minecraft/profile', () =>
      json({
        id: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
        name: 'Steve',
        skins: [{ state: 'ACTIVE', url: 'https://textures.minecraft.net/texture/abc' }],
        capes: [],
      })],
  ];

  const table = new Map(routes.map(([key, fn]) => [key, overrides[key] ?? fn]));
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const target = String(url);
    for (const [key, fn] of table) {
      if (target.includes(key)) return fn(target);
    }
    throw new Error(`未预期的请求：${target}`);
  };
  return () => {
    globalThis.fetch = original;
  };
}

test('AAD 错误码翻译成可操作的提示', () => {
  assert.match(describeAadError({ error_codes: [700016] }), /应用 ID 不存在/);
  assert.match(describeAadError({ error_description: 'AADSTS7000218: request body must contain client_assertion' }), /允许公共客户端流/);
  assert.match(describeAadError({ error: 'invalid_client' }), /无效或不是公共客户端/);
  assert.match(describeAadError({ error_description: 'AADSTS90099: tenant is disabled' }), /AADSTS90099/);
});

test('设备码申请前先拦住格式错误的应用 ID', async () => {
  await assert.rejects(() => requestDeviceCode(''), /未配置/);
  await assert.rejects(() => requestDeviceCode('not-a-guid'), /36 位 GUID/);
});

test('应用 ID 不存在时给出明确原因', async () => {
  const restore = stubFetch({
    devicecode: () => json({ error: 'unauthorized_client', error_codes: [700016] }, 400),
  });
  try {
    await assert.rejects(() => requestDeviceCode(CLIENT_ID), /应用 ID 不存在/);
  } finally {
    restore();
  }
});

test('轮询：待授权、过期、用户拒绝三种结果', async () => {
  let restore = stubFetch({ 'oauth2/v2.0/token': () => json({ error: 'authorization_pending' }, 400) });
  try {
    assert.deepEqual(await pollDeviceCode(CLIENT_ID, 'dev'), { pending: true });
  } finally {
    restore();
  }

  restore = stubFetch({ 'oauth2/v2.0/token': () => json({ error: 'expired_token' }, 400) });
  try {
    await assert.rejects(() => pollDeviceCode(CLIENT_ID, 'dev'), (err) => err.expired === true);
  } finally {
    restore();
  }

  restore = stubFetch({ 'oauth2/v2.0/token': () => json({ error: 'authorization_declined' }, 400) });
  try {
    await assert.rejects(() => pollDeviceCode(CLIENT_ID, 'dev'), /拒绝授权/);
  } finally {
    restore();
  }
});

test('刷新令牌失效时标记为需要重新登录', async () => {
  const restore = stubFetch({ 'oauth2/v2.0/token': () => json({ error: 'invalid_grant' }, 400) });
  try {
    await assert.rejects(() => refreshMsaToken(CLIENT_ID, 'stale'), (err) => err.relogin === true);
    await assert.rejects(() => refreshMsaToken(CLIENT_ID, ''), /没有可用的刷新令牌/);
  } finally {
    restore();
  }
});

test('完整链路产出的账户可直接用于启动', async () => {
  const restore = stubFetch();
  try {
    const account = await buildAccount({
      msaAccessToken: 'msa-token',
      refreshToken: 'refresh-token',
      clientId: CLIENT_ID,
    });

    assert.equal(account.mode, 'microsoft');
    assert.equal(account.name, 'Steve');
    assert.equal(account.userType, 'msa');
    assert.equal(account.accessToken, 'mc-token');
    assert.equal(account.uuid, 'a1b2c3d4e5f60718293a4b5c6d7e8f90');
    // xuid 取自 XSTS 的 xid 声明
    assert.equal(account.xuid, '2535400000000001');
    assert.equal(account.skinUrl, 'https://textures.minecraft.net/texture/abc');
    // 到期时间提前 300 秒
    const expected = Date.now() + (86400 - 300) * 1000;
    assert.ok(Math.abs(account.expiresAt - expected) < 5000);
  } finally {
    restore();
  }
});

test('未购买 Java 版时给出针对性的提示', async () => {
  const restore = stubFetch({ entitlements: () => json({ items: [] }) });
  try {
    await assert.rejects(
      () => buildAccount({ msaAccessToken: 'msa-token' }),
      (err) => err.noEntitlement === true && /购买记录/.test(err.message),
    );
  } finally {
    restore();
  }
});

test('XSTS 拒绝时翻译 XErr', async () => {
  const restore = stubFetch({
    'xsts.auth.xboxlive.com': () => json({ XErr: 2148916233, Message: 'no xbox account' }, 401),
  });
  try {
    await assert.rejects(
      () => buildAccount({ msaAccessToken: 'msa-token' }),
      (err) => err.xerr === 2148916233 && /Xbox 档案/.test(err.message),
    );
  } finally {
    restore();
  }
});

test('尚未创建角色名时提示去官方启动器', async () => {
  const restore = stubFetch({ 'minecraft/profile': () => json({ error: 'NOT_FOUND' }, 404) });
  try {
    await assert.rejects(() => buildAccount({ msaAccessToken: 'msa-token' }), /角色名/);
  } finally {
    restore();
  }
});

test('过期判断：离线账户永不过期，微软账户提前 5 分钟算过期', () => {
  assert.equal(isAccountExpired({ mode: 'offline', expiresAt: 0 }), false);
  assert.equal(isAccountExpired({ mode: 'microsoft', expiresAt: 0 }), true);
  assert.equal(isAccountExpired({ mode: 'microsoft', expiresAt: Date.now() + 60 * 60_000 }), false);
  assert.equal(isAccountExpired({ mode: 'microsoft', expiresAt: Date.now() + 60_000 }), true);
});

test('登录会话按顺序推进状态并产出账户', async () => {
  const restore = stubFetch();
  const states = [];
  try {
    const session = new MsaLoginSession({
      clientId: CLIENT_ID,
      onChange: (snapshot) => states.push(snapshot.state),
    });

    const first = await session.start();
    assert.equal(first.state, 'waiting');
    assert.equal(first.userCode, 'K7QP2XHD');

    for (let i = 0; i < 40 && !session.isFinished; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
    }

    assert.equal(session.state, 'done');
    assert.equal(session.account.name, 'Steve');
    assert.deepEqual(states.slice(0, 2), ['waiting', 'authorized']);
    assert.ok(states.includes('xbox') && states.includes('xsts') && states.includes('minecraft'));
  } finally {
    restore();
  }
});

test('验证码过期是独立状态，不算出错', async () => {
  const restore = stubFetch({ 'oauth2/v2.0/token': () => json({ error: 'expired_token' }, 400) });
  try {
    const session = new MsaLoginSession({ clientId: CLIENT_ID });
    await session.start();

    for (let i = 0; i < 40 && !session.isFinished; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
    }

    assert.equal(session.state, 'expired');
    assert.equal(session.errorKind, 'expired');
  } finally {
    restore();
  }
});

test('取消登录后不再推进状态', async () => {
  const restore = stubFetch();
  try {
    const session = new MsaLoginSession({ clientId: CLIENT_ID });
    await session.start();
    session.cancel();

    assert.equal(session.state, 'cancelled');
    await new Promise((r) => setTimeout(r, 1400));
    assert.equal(session.state, 'cancelled');
    assert.equal(session.account, null);
  } finally {
    restore();
  }
});
