import os from 'node:os';

/** Node 平台名 -> Minecraft 规则里的 os.name */
export function platformName() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'osx';
  return 'linux';
}

/** Node arch -> Minecraft 规则里的 os.arch */
export function platformArch() {
  if (process.arch === 'x64') return 'x86_64';
  if (process.arch === 'ia32') return 'x86';
  if (process.arch === 'arm64') return 'arm64';
  return process.arch;
}

export function osContext(extra = {}) {
  return {
    name: platformName(),
    arch: platformArch(),
    version: os.release(),
    ...extra,
  };
}

/** 用于规则匹配的上下文（含 features，供 --demo / 自定义分辨率等开关判断） */
export function ruleContext(features = {}) {
  return { os: osContext(), features: { ...features } };
}

function matchOs(cond, ctx) {
  if (!cond) return true;
  if (cond.name && cond.name !== ctx.os.name) return false;
  if (cond.arch && cond.arch !== ctx.os.arch) return false;
  if (cond.version) {
    try {
      if (!new RegExp(cond.version).test(ctx.os.version)) return false;
    } catch {
      /* 非法正则忽略 */
    }
  }
  return true;
}

function matchFeatures(cond, ctx) {
  if (!cond) return true;
  return Object.entries(cond).every(([k, v]) => Boolean(ctx.features[k]) === Boolean(v));
}

/**
 * Mojang 规则求值：无 rules = 允许；否则按顺序求值，最后命中者生效。
 */
export function evaluateRules(rules, ctx) {
  if (!Array.isArray(rules) || rules.length === 0) return true;
  let allowed = false;
  for (const rule of rules) {
    const osOk = matchOs(rule.os, ctx);
    const featOk = matchFeatures(rule.features, ctx);
    if (osOk && featOk) allowed = rule.action === 'allow';
  }
  return allowed;
}

/**
 * 处理 arguments 里 { rules, value } 形式的条件参数
 */
export function flattenArguments(list, ctx) {
  const out = [];
  for (const item of list || []) {
    if (typeof item === 'string') {
      out.push(item);
    } else if (item && typeof item === 'object') {
      if (evaluateRules(item.rules, ctx)) {
        if (Array.isArray(item.value)) out.push(...item.value);
        else if (typeof item.value === 'string') out.push(item.value);
      }
    }
  }
  return out;
}

/** 旧版本 minecraftArguments 是空格分隔字符串 */
export function splitLegacyArguments(str) {
  if (!str) return [];
  return str.split(/\s+/).filter(Boolean);
}
