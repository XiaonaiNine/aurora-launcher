/** Maven 坐标工具：Minecraft 运行库全部以 group:artifact:version[:classifier][@ext] 描述 */

export function parseName(name) {
  const atIdx = name.indexOf('@');
  const ext = atIdx >= 0 ? name.slice(atIdx + 1) : 'jar';
  const coords = atIdx >= 0 ? name.slice(0, atIdx) : name;
  const parts = coords.split(':');
  return {
    group: parts[0] || '',
    artifact: parts[1] || '',
    version: parts[2] || '',
    classifier: parts[3] || '',
    ext,
  };
}

/** 生成 libraries/ 下的相对路径 */
export function mavenPath(name) {
  const { group, artifact, version, classifier, ext } = parseName(name);
  const file = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.${ext}`;
  return `${group.replace(/\./g, '/')}/${artifact}/${version}/${file}`;
}

/**
 * 去重键：同一个 group:artifact:classifier 只保留一份（子版本覆盖父版本），
 * 这样 Forge/Fabric 这类 inheritsFrom 链不会重复下载。
 */
export function mavenKey(name) {
  const { group, artifact, classifier } = parseName(name);
  return `${group}:${artifact}${classifier ? `:${classifier}` : ''}`;
}
