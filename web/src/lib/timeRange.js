const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export const PRESETS = [
  { key: '24h', label: '24 小时' },
  { key: '7d', label: '7 天' },
  { key: '30d', label: '30 天' },
  { key: 'custom', label: '自定义' },
];

/** 预设区间：24h 滚动；7d/30d 按本地自然日（含今天） */
export function presetRange(key, now = Date.now()) {
  if (key !== '7d' && key !== '30d') return { from: now - DAY, to: now };
  const days = key === '7d' ? 7 : 30;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  return { from: start.getTime(), to: now };
}

function pad(n) {
  return String(n).padStart(2, '0');
}

export function toDateInput(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 按本地年月日解析，避开 new Date('YYYY-MM-DD') 的 UTC 语义 */
export function parseDateInput(str) {
  const m = DATE_RE.exec(String(str || ''));
  if (!m) return NaN;
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const date = new Date(y, mo, d);
  if (date.getFullYear() !== y || date.getMonth() !== mo || date.getDate() !== d) return NaN;
  return date.getTime();
}

export function addLocalDays(ts, days) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days).getTime();
}

/** 本地自然日的序号，用于计算跨天数（不受时区偏移影响） */
function dayIndex(ts) {
  const d = new Date(ts);
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY);
}

export function validateCustom(fromStr, toStr, retentionDays = 90, now = Date.now()) {
  if (!fromStr || !toStr) return '请选择起止日期';
  const from = parseDateInput(fromStr);
  const to = parseDateInput(toStr);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return '日期格式不正确';
  if (from > to) return '开始日期不能晚于结束日期';
  const todayStart = parseDateInput(toDateInput(now));
  if (from > todayStart) return '开始日期不能晚于今天';
  const days = dayIndex(to) - dayIndex(from) + 1;
  if (days > retentionDays) return `跨度不能超过 ${retentionDays} 天`;
  return '';
}

export async function fetchTimeline({ from, to }, signal) {
  const url = `/api/timeline?from=${Math.round(from)}&to=${Math.round(to)}`;
  const res = await fetch(url, { signal });
  if (!res.ok) {
    const err = new Error(`timeline ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export function grainText(stepMs) {
  if (!stepMs) return '';
  if (stepMs >= DAY) return `按 ${Math.round(stepMs / DAY)} 天`;
  if (stepMs >= 60 * MINUTE) return `按 ${Math.round(stepMs / (60 * MINUTE))} 小时`;
  return `按 ${Math.round(stepMs / MINUTE)} 分钟`;
}

export function formatBucketLabel(ts, stepMs, now = Date.now()) {
  const d = new Date(ts);
  if (stepMs >= DAY) return `${d.getMonth() + 1}/${d.getDate()}`;
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay = new Date(now).toDateString() === d.toDateString();
  return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

export function formatBucketTooltip(ts, stepMs) {
  const d = new Date(ts);
  const date = `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
  if (stepMs >= DAY) return date;
  return `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
