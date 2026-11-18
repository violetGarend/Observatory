const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 粒度阶梯：保证任意区间聚合后不超过 200 个点 */
const STEPS = [
  MINUTE,
  5 * MINUTE,
  10 * MINUTE,
  15 * MINUTE,
  30 * MINUTE,
  HOUR,
  2 * HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
  7 * DAY,
];

export function pickStep(spanMs, maxPoints = 200) {
  const span = Math.max(spanMs, MINUTE);
  for (const step of STEPS) {
    if (span / step <= maxPoints) return step;
  }
  return STEPS[STEPS.length - 1];
}

/** 本地时区的当天 00:00 */
export function localDayStart(ts) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** 本地日历加天数（不假定一天恰好 86400000ms） */
export function addLocalDays(ts, days) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days).getTime();
}

function zero() {
  return { messages: 0, output: 0, cacheRead: 0, skills: 0, tools: 0 };
}

/**
 * 把分钟桶聚合成固定步长的序列，并补零。
 * 没有零填充，稀疏数据在长区间里会被压缩成「连续几天都在活动」的假象。
 *
 * @param {Map<number, object>} minuteMap  store.timeline，key 是分钟序号
 * @param {number} from 毫秒
 * @param {number} to   毫秒
 * @param {number} stepMs pickStep() 的结果
 */
export function buildBuckets(minuteMap, from, to, stepMs) {
  const dayStep = stepMs >= DAY;
  const daysPerStep = dayStep ? Math.round(stepMs / DAY) : 0;

  const gridStart = dayStep ? localDayStart(from) : Math.floor(from / stepMs) * stepMs;
  const step = dayStep ? (ts) => addLocalDays(ts, daysPerStep) : (ts) => ts + stepMs;

  const acc = new Map();
  for (const b of minuteMap.values()) {
    // 区间按半开 [from, to) 处理：相邻区间拼接时边界桶不会被重复计算
    if (b.ts + MINUTE <= from || b.ts >= to) continue;
    const key = dayStep
      ? addLocalDays(
          gridStart,
          Math.floor(Math.round((localDayStart(b.ts) - gridStart) / DAY) / daysPerStep) * daysPerStep
        )
      : Math.floor(b.ts / stepMs) * stepMs;

    let cur = acc.get(key);
    if (!cur) {
      cur = zero();
      acc.set(key, cur);
    }
    cur.messages += b.messages;
    cur.output += b.output;
    cur.cacheRead += b.cacheRead;
    cur.skills += b.skills;
    cur.tools += b.tools;
  }

  const out = [];
  for (let ts = gridStart; ts <= to; ts = step(ts)) {
    out.push({ ts, ...(acc.get(ts) || zero()) });
  }
  return out;
}
