/** 与服务端 projectHistory.normalizeCwd 保持一致 */
export function projectKey(cwd) {
  let value = String(cwd || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
  if (/^[a-zA-Z]:/.test(value)) value = value[0].toUpperCase() + value.slice(1);
  return value;
}

export function projectName(cwd) {
  const parts = projectKey(cwd).split('/').filter(Boolean);
  return parts[parts.length - 1] || cwd || '未知项目';
}

export function projectUrl(cwd) {
  return `/projects?cwd=${encodeURIComponent(String(cwd || ''))}`;
}
