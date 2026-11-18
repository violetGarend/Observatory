import { addLocalDays, localDayStart } from './timeline.js';
import {
  cleanPromptText,
  historyFileSignature,
  readUserPromptHistory,
} from './history.js';
import { loadSessionRecords, sessionFileSignature } from './sessions.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MAX_BUCKETS = 120;
const MAX_SESSIONS = 30;
const CACHE_TTL = 30 * 1000;
const CACHE_FAST = 5 * 1000;
const CACHE_MAX = 6;

const STEPS = [
  HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
  7 * DAY,
  30 * DAY,
  90 * DAY,
  365 * DAY,
];

const cache = new Map();
const pending = new Map();

export function normalizeCwd(input) {
  let value = String(input || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
  if (/^[a-zA-Z]:/.test(value)) value = value[0].toUpperCase() + value.slice(1);
  return value;
}

export function projectName(cwd) {
  const parts = normalizeCwd(cwd).split('/').filter(Boolean);
  return parts[parts.length - 1] || cwd || '未知项目';
}

function fmtDate(ts, withTime = false) {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  if (!withTime) return `${mm}/${dd}`;
  const hh = String(d.getHours()).padStart(2, '0');
  return `${mm}/${dd} ${hh}:00`;
}

function pickStep(span) {
  const hours = span / HOUR;

  // 两天以内用小时级，否则优先按天；超过两个月再降到周/月
  if (hours <= 36) {
    for (const step of STEPS) {
      if (step >= DAY) break;
      if (Math.ceil(span / step) + 1 <= MAX_BUCKETS) return step;
    }
    return DAY;
  }

  if (Math.ceil(span / DAY) + 1 <= 60) return DAY;

  for (const step of STEPS) {
    if (step < DAY) continue;
    if (Math.ceil(span / step) + 1 <= MAX_BUCKETS) return step;
  }
  return STEPS[STEPS.length - 1];
}

function stepUnit(step) {
  if (step < DAY) return 'hour';
  if (step === DAY) return 'day';
  if (step === 7 * DAY) return 'week';
  return 'month';
}

function stepLabel(step) {
  if (step < DAY) return `按 ${step / HOUR} 小时`;
  if (step === DAY) return '按天';
  return `按 ${step / DAY} 天`;
}

function normalizedText(text) {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function truncate(text, limit = 300) {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

export async function buildProjectHistory({ cwd, store, now = Date.now(), refresh = false } = {}) {
  const key = normalizeCwd(cwd);
  if (!key) return null;

  const snapshot = store.snapshot();
  const allSessions = snapshot.sessions || [];
  const sessionCwd = new Map();
  for (const session of allSessions) {
    sessionCwd.set(session.id, normalizeCwd(session.cwd));
  }

  let sessions = allSessions.filter((session) => normalizeCwd(session.cwd) === key);
  if (!sessions.length) return null; // 只有 history、没有任何转录的项目不开放

  const warnings = [];
  let partial = false;

  // 最多保留最近 30 个真实会话
  if (sessions.length > MAX_SESSIONS) {
    sessions = sessions
      .slice()
      .sort((a, b) => (a.start || a.lastEventAt || 0) - (b.start || b.lastEventAt || 0))
      .slice(-MAX_SESSIONS);
    warnings.push(`项目会话超过 ${MAX_SESSIONS} 个，只统计最近 ${MAX_SESSIONS} 个`);
    partial = true;
  }

  const signature = [
    sessions.map((s) => `${s.id}:${s.cwd || ''}:${s.lastEventAt || 0}:${s.messages || 0}`).join('|'),
    sessions.map((s) => sessionFileSignature(s.id)).join('|'),
    historyFileSignature(),
  ].join('::');

  const hit = cache.get(key);
  if (!refresh && hit) {
    const age = now - hit.at;
    if (age < CACHE_FAST || (hit.signature === signature && age < CACHE_TTL)) {
      cache.delete(key);
      cache.set(key, hit);
      return hit.data;
    }
  }
  if (pending.has(key)) return pending.get(key);

  const task = build({
    cwd: key,
    sessions,
    allSessions,
    sessionCwd,
    now,
    warnings,
    partial,
  })
    .then((data) => {
      cache.set(key, { signature, at: now, data });
      while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
      return data;
    })
    .finally(() => pending.delete(key));

  pending.set(key, task);
  return task;
}

async function build({ cwd, sessions, allSessions, sessionCwd, now, warnings, partial }) {
  const realIds = new Set(sessions.map((s) => s.id));
  const recordsById = new Map();
  const transcriptPrompts = [];
  const realSessionStats = new Map();
  let minTs = 0;
  let maxTs = 0;

  function touch(ts) {
    if (!ts) return;
    if (!minTs || ts < minTs) minTs = ts;
    if (ts > maxTs) maxTs = ts;
  }

  for (const session of sessions) {
    touch(session.start || 0);
    touch(session.end || 0);

    let data = null;
    try {
      data = await loadSessionRecords(session.id);
    } catch (err) {
      warnings.push(`会话 ${session.id.slice(0, 8)} 解析失败：${err.message}`);
      partial = true;
    }
    recordsById.set(session.id, data);
    if (!data) continue;

    for (const record of data.records) {
      if (!record.ts) continue;
      touch(record.ts);
      if (record.kind === 'prompt') {
        transcriptPrompts.push({
          ts: record.ts,
          text: truncate(record.summary),
          sessionId: session.id,
          historyOnly: false,
        });
      }
    }

    const actions = data.records.filter((r) => r.kind !== 'prompt' && r.ts);
    realSessionStats.set(session.id, {
      actions: actions.length,
      firstAt: actions.length ? Math.min(...actions.map((r) => r.ts)) : 0,
      lastAt: actions.length ? Math.max(...actions.map((r) => r.ts)) : 0,
    });
  }

  // history prompt 归属：sessionId 优先，project 字段只做 fallback
  const historyRows = readUserPromptHistory();
  if (!historyRows) {
    warnings.push('未找到 history.jsonl，仅使用转录内用户指令');
    partial = true;
  }

  const historyPrompts = [];
  const seenHistory = new Set();
  for (const row of historyRows || []) {
    const ts = Number(row.timestamp);
    if (!ts) continue;
    const text = cleanPromptText(row.display);
    if (!text) continue;

    const sid = row.sessionId || '';
    const mapped = sid ? sessionCwd.get(sid) : null;
    const project = mapped || normalizeCwd(row.project);
    if (project !== cwd) continue;

    const historyOnly = !mapped || !realIds.has(sid);
    const key = `${sid}|${Math.floor(ts / 120000)}|${normalizedText(text)}`;
    if (seenHistory.has(key)) continue;
    seenHistory.add(key);
    historyPrompts.push({ ts, text: truncate(text), sessionId: sid, historyOnly });
    touch(ts);
  }

  // 真实会话：优先转录文本；history 只补转录缺失的输入
  const prompts = [];
  const pushPrompt = (prompt) => {
    const text = normalizedText(prompt.text);
    const near = prompts.some(
      (p) =>
        p.sessionId === prompt.sessionId &&
        Math.abs(p.ts - prompt.ts) <= 120000 &&
        (Math.abs(p.ts - prompt.ts) <= 15000 || normalizedText(p.text) === text)
    );
    if (!near) prompts.push(prompt);
  };
  for (const prompt of transcriptPrompts) pushPrompt(prompt);
  for (const prompt of historyPrompts) {
    if (prompt.historyOnly) pushPrompt(prompt);
    else pushPrompt(prompt);
  }
  prompts.sort((a, b) => a.ts - b.ts);

  if (!minTs || !maxTs) {
    for (const session of sessions) {
      touch(session.start || session.lastEventAt || 0);
      touch(session.end || session.lastEventAt || 0);
    }
  }

  if (!minTs || !maxTs) {
    return {
      generatedAt: now,
      cwd,
      key: cwd,
      projectName: projectName(cwd),
      range: { from: 0, to: 0 },
      granularity: { stepMs: DAY, unit: 'day', label: '按天' },
      buckets: [],
      prompts: [],
      sessions: [],
      totals: {
        sessions: sessions.length,
        historyOnlySessions: 0,
        historyOnlyPrompts: 0,
        prompts: 0,
        actions: 0,
        tools: 0,
        skills: 0,
        mcp: 0,
        subagent: 0,
        errors: 0,
        activeDays: 0,
        firstAt: null,
        lastAt: null,
      },
      partial,
      warnings,
    };
  }

  const span = Math.max(0, maxTs - minTs);
  const stepMs = pickStep(span);
  const stepDays = stepMs >= DAY ? Math.round(stepMs / DAY) : 0;
  const originDay = localDayStart(minTs);
  const first = stepMs < DAY
    ? originDay + Math.floor((minTs - originDay) / stepMs) * stepMs
    : originDay;

  const starts = [];
  let cursor = first;
  while (cursor <= maxTs) {
    starts.push(cursor);
    cursor = stepMs < DAY ? cursor + stepMs : addLocalDays(cursor, stepDays);
  }
  if (!starts.length) starts.push(first);
  const to = stepMs < DAY
    ? starts[starts.length - 1] + stepMs
    : addLocalDays(starts[starts.length - 1], stepDays);

  function bucketIndex(ts) {
    if (ts <= starts[0]) return 0;
    if (ts >= to) return starts.length - 1;
    let lo = 0;
    let hi = starts.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] <= ts) lo = mid + 1;
      else hi = mid - 1;
    }
    return Math.max(0, Math.min(starts.length - 1, hi));
  }

  const multiDay = localDayStart(starts[starts.length - 1]) !== localDayStart(starts[0]);
  const buckets = starts.map((ts) => ({
    ts,
    label: stepMs < DAY ? fmtDate(ts, multiDay) : fmtDate(ts, false),
    tools: 0,
    skills: 0,
    mcp: 0,
    subagent: 0,
    total: 0,
    errors: 0,
    prompts: 0,
  }));

  const sessionBuckets = new Map();
  const promptBuckets = new Map();
  for (const session of sessions) {
    sessionBuckets.set(session.id, new Array(starts.length).fill(0));
    promptBuckets.set(session.id, new Array(starts.length).fill(0));
  }

  for (const session of sessions) {
    const data = recordsById.get(session.id);
    if (!data) continue;
    const perBucket = sessionBuckets.get(session.id);
    for (const record of data.records) {
      if (record.kind === 'prompt' || !record.ts) continue;
      const index = bucketIndex(record.ts);
      const bucket = buckets[index];
      perBucket[index]++;
      bucket.total++;
      if (record.source === 'subagent') bucket.subagent++;
      else if (record.kind === 'skill') bucket.skills++;
      else if (record.kind === 'mcp') bucket.mcp++;
      else bucket.tools++;
      if (record.status === 'error') bucket.errors++;
    }
  }

  const historyOnlyGroups = new Map();
  for (const prompt of prompts) {
    const index = bucketIndex(prompt.ts);
    buckets[index].prompts++;
    prompt.bucket = index;
    if (prompt.historyOnly) {
      const sid = prompt.sessionId || 'history-only';
      let group = historyOnlyGroups.get(sid);
      if (!group) {
        group = { id: sid, prompts: [], promptBuckets: new Array(starts.length).fill(0) };
        historyOnlyGroups.set(sid, group);
      }
      group.prompts.push(prompt);
      group.promptBuckets[index]++;
    } else {
      const perBucket = promptBuckets.get(prompt.sessionId);
      if (perBucket) perBucket[index]++;
    }
  }

  const titleById = new Map();
  for (const session of allSessions) {
    titleById.set(
      session.id,
      session.aiTitle || session.agentName || session.title || session.task || session.id.slice(0, 8)
    );
  }

  for (const prompt of prompts) {
    prompt.sessionTitle = prompt.historyOnly
      ? '已清理会话'
      : titleById.get(prompt.sessionId) || prompt.sessionId.slice(0, 8);
  }

  const sessionEntries = sessions.map((session) => {
    const stats = realSessionStats.get(session.id) || { actions: 0, firstAt: 0, lastAt: 0 };
    return {
      id: session.id,
      title:
        session.aiTitle ||
        session.agentName ||
        session.title ||
        session.task ||
        session.id.slice(0, 8),
      start: session.start || stats.firstAt || session.lastEventAt || 0,
      end: session.end || stats.lastAt || session.lastEventAt || 0,
      firstAt: stats.firstAt || session.start || session.lastEventAt || 0,
      lastAt: stats.lastAt || session.end || session.lastEventAt || 0,
      messages: session.messages || 0,
      output: session.output || 0,
      actions: stats.actions,
      skillCalls: session.skillCalls || 0,
      model: session.model || '',
      status: session.status || 'idle',
      historyOnly: false,
      promptCount: prompts.filter((p) => p.sessionId === session.id && !p.historyOnly).length,
      buckets: sessionBuckets.get(session.id) || new Array(starts.length).fill(0),
      promptBuckets: promptBuckets.get(session.id) || new Array(starts.length).fill(0),
    };
  });

  for (const group of historyOnlyGroups.values()) {
    const list = group.prompts.sort((a, b) => a.ts - b.ts);
    sessionEntries.push({
      id: group.id,
      title: list[0]?.text.slice(0, 60) || '已清理会话',
      start: list[0]?.ts || 0,
      end: list[list.length - 1]?.ts || 0,
      firstAt: list[0]?.ts || 0,
      lastAt: list[list.length - 1]?.ts || 0,
      messages: null,
      output: null,
      actions: 0,
      skillCalls: 0,
      model: '',
      status: 'history',
      historyOnly: true,
      promptCount: list.length,
      buckets: new Array(starts.length).fill(0),
      promptBuckets: group.promptBuckets,
    });
  }

  sessionEntries.sort((a, b) => a.start - b.start || a.title.localeCompare(b.title));

  const totals = {
    sessions: sessionEntries.length,
    historyOnlySessions: sessionEntries.filter((s) => s.historyOnly).length,
    historyOnlyPrompts: prompts.filter((p) => p.historyOnly).length,
    prompts: prompts.length,
    actions: buckets.reduce((n, b) => n + b.total, 0),
    tools: buckets.reduce((n, b) => n + b.tools, 0),
    skills: buckets.reduce((n, b) => n + b.skills, 0),
    mcp: buckets.reduce((n, b) => n + b.mcp, 0),
    subagent: buckets.reduce((n, b) => n + b.subagent, 0),
    errors: buckets.reduce((n, b) => n + b.errors, 0),
    activeDays: 0,
    firstAt: minTs,
    lastAt: maxTs,
  };

  const activeDays = new Set();
  for (const bucket of buckets) {
    if (!bucket.total && !bucket.prompts) continue;
    activeDays.add(localDayStart(bucket.ts));
  }
  for (const prompt of prompts) activeDays.add(localDayStart(prompt.ts));
  totals.activeDays = activeDays.size;

  return {
    generatedAt: now,
    cwd,
    key: cwd,
    projectName: projectName(cwd),
    range: { from: starts[0], to },
    granularity: {
      stepMs,
      unit: stepUnit(stepMs),
      label: stepLabel(stepMs),
    },
    buckets,
    prompts,
    sessions: sessionEntries,
    totals,
    partial,
    warnings,
  };
}
