import crypto from 'node:crypto';

/**
 * 离线账户。
 *
 * 不联网、不需要授权，UUID 由用户名派生，因此同一个名字在任何机器上
 * 都对应同一个身份。微软账户见 ./msa.js，两者产出的账户对象结构一致，
 * 上层组装启动参数时无需区分来源。
 */

/** Java 版离线 UUID 算法：MD5("OfflinePlayer:<name>") 并置版本位 */
export function offlineUuid(name) {
  const hash = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  hash[6] = (hash[6] & 0x0f) | 0x30; // version 3
  hash[8] = (hash[8] & 0x3f) | 0x80; // variant RFC4122
  const hex = hash.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isValidOfflineName(name) {
  return /^[A-Za-z0-9_]{3,16}$/.test(String(name || '').trim());
}

export function createOfflineAccount(name) {
  const trimmed = String(name || '').trim();
  if (!isValidOfflineName(trimmed)) {
    throw new Error('用户名需为 3-16 位字母、数字或下划线');
  }
  return {
    mode: 'offline',
    name: trimmed,
    uuid: offlineUuid(trimmed).replace(/-/g, ''),
    accessToken: '0',
    userType: 'legacy',
    xuid: '',
    refreshToken: '',
    expiresAt: 0,
  };
}
