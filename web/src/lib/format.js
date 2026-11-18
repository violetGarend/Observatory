const UNITS = ['', 'K', 'M', 'B', 'T'];

export function compact(n) {
  if (n == null) return '—';
  let v = Math.abs(n);
  let i = 0;
  while (v >= 1000 && i < UNITS.length - 1) {
    v /= 1000;
    i++;
  }
  const s = v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
  return (n < 0 ? '-' : '') + s.replace(/\.0+$/, '') + UNITS[i];
}

export function fullNumber(n) {
  return n == null ? '—' : n.toLocaleString('zh-CN');
}

export function percent(x, digits = 1) {
  return `${(x * 100).toFixed(digits)}%`;
}

export function clock(ms) {
  const d = new Date(ms);
  return d.toLocaleTimeString('zh-CN', { hour12: false });
}

export function dateTime(ms) {
  const d = new Date(ms);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${clock(ms)}`;
}

export function relative(ms) {
  if (!ms) return '—';
  const diff = Date.now() - ms;
  if (diff < 0) return '刚刚';
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s} 秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return `${Math.floor(d / 30)} 个月前`;
}

export function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** 把 skill 名规范为 plugin:skill 或 skill */
export function skillLabel(name) {
  return name || '未知';
}

export const TRIGGER_META = {
  user: { label: '用户触发', color: '#5eead4' },
  proactive: { label: '自主触发', color: '#a78bfa' },
  nested: { label: '嵌套调用', color: '#fbbf24' },
  unknown: { label: '未识别', color: '#64748b' },
};
