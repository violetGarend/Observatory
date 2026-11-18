import { TIMELINE_RETENTION_DAYS } from './config.js';

export const CANDIDATE_TOKEN_THRESHOLD = 120;
export const CANDIDATE_DISPLAY_LIMIT = 10;
export const TRIAL_DAYS = 30;
export const DEFAULT_DAYS = 30;
export const MAX_DAYS = TIMELINE_RETENTION_DAYS;
export const CONFIDENCE_LOW_MAX = 20;
export const CONFIDENCE_HIGH_MIN = 100;

const DAY_MS = 24 * 60 * 60 * 1000;

export function parseDays(raw) {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_DAYS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_DAYS) return null;
  return n;
}

export function confidenceFor(events) {
  if (events >= CONFIDENCE_HIGH_MIN) return 'high';
  if (events >= CONFIDENCE_LOW_MAX) return 'medium';
  return 'low';
}

function fmt(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function buildHeadline({
  days,
  skillsTotal,
  tokensLow,
  tokensHigh,
  candidateCount,
  candidateTokensHigh,
  names = [],
}) {
  const base = `近 ${days} 天里，你为 ${skillsTotal} 个技能每轮付约 ${fmt(tokensLow)}–${fmt(
    tokensHigh
  )} tokens（仅 user + plugin 技能描述，不含内置技能、项目技能与 MCP；估算）`;

  if (!candidateCount) {
    return `${base}，窗口内没有满足条件的候选。`;
  }

  const list = names.slice(0, 3).join('、');
  const suffix = candidateCount > 3 ? ' 等' : '';
  return `${base}，其中 ${candidateCount} 个候选（零调用 + 高成本 + 文本未提及）合计约 ${fmt(
    candidateTokensHigh
  )} tokens：${list}${suffix}。`;
}

function trialProtected(skill, now) {
  if (!skill.installedAt) return false;
  const t = Date.parse(skill.installedAt);
  if (!Number.isFinite(t)) return false;
  return now - t < TRIAL_DAYS * DAY_MS;
}

function byTokenDesc(a, b) {
  return b.tokensHigh - a.tokensHigh || a.name.localeCompare(b.name);
}

export function buildConstellation({ catalog, store, days = DEFAULT_DAYS, now = Date.now() }) {
  if (!catalog || !Array.isArray(catalog.skills)) throw new Error('技能目录不可用');

  const cutoff = now - days * DAY_MS;
  const usage = store.skillWindowStats(cutoff);
  const mentions = store.mentionStats(cutoff);
  const mentionInfo = store.mentionTrackingInfo();

  const skills = catalog.skills.map((s) => {
    const u = usage.byName.get(s.name);
    const m = mentions.get(s.name);
    const invocations = u?.invocations || 0;
    const mentionTracked = store.mentionTracked.has(s.name);
    const highCost = s.tokensHigh >= CANDIDATE_TOKEN_THRESHOLD;
    const zeroUse = invocations === 0;

    return {
      name: s.name,
      source: s.source,
      sourceType: s.sourceType,
      plugin: s.plugin,
      dirName: s.dirName,
      asciiChars: s.asciiChars,
      cjkChars: s.cjkChars,
      otherChars: s.otherChars,
      descChars: s.descChars,
      tokensLow: s.tokensLow,
      tokensHigh: s.tokensHigh,
      invocations,
      lastUsed: u?.lastUsed || null,
      origin: u?.origin || 'none',
      observed: invocations > 0,
      mentionStrong: m?.strong || 0,
      mentionWeak: m?.weak || 0,
      mentionTracked,
      installedAt: s.installedAt,
      trialProtected: trialProtected(s, now),
      // 候选资格（最终前 10 名才叫候选）
      eligible:
        highCost &&
        zeroUse &&
        mentionTracked &&
        (m?.strong || 0) === 0 &&
        (m?.weak || 0) === 0 &&
        !trialProtected(s, now),
      highCostZeroUse: highCost && zeroUse,
      candidate: false,
    };
  });

  const eligible = skills.filter((s) => s.eligible).sort(byTokenDesc).slice(0, CANDIDATE_DISPLAY_LIMIT);
  const candidateNames = new Set(eligible.map((s) => s.name));

  for (const skill of skills) {
    skill.candidate = candidateNames.has(skill.name);
    delete skill.eligible;
  }

  skills.sort(byTokenDesc);

  const known = new Set(catalog.skills.map((s) => s.name));
  const unmatched = [...usage.byName.entries()]
    .filter(([name]) => !known.has(name))
    .map(([name, u]) => ({ name, invocations: u.invocations, lastUsed: u.lastUsed }))
    .sort((a, b) => b.invocations - a.invocations || a.name.localeCompare(b.name));

  const candidateTokensHigh = eligible.reduce((sum, s) => sum + s.tokensHigh, 0);
  const candidates = eligible.map((s) => ({
    name: s.name,
    source: s.source,
    sourceType: s.sourceType,
    plugin: s.plugin,
    tokensLow: s.tokensLow,
    tokensHigh: s.tokensHigh,
    invocations: s.invocations,
    lastUsed: s.lastUsed,
    mentionStrong: s.mentionStrong,
    mentionWeak: s.mentionWeak,
    mentionTracked: s.mentionTracked,
    installedAt: s.installedAt,
    trialProtected: s.trialProtected,
    candidateSignals: ['zero_invocations', 'high_cost', 'absent_from_text'],
  }));

  const cost = catalog.cost || {
    skills: catalog.skills.length,
    tokensLow: 0,
    tokensHigh: 0,
  };

  return {
    generatedAt: now,
    windowDays: days,
    scope: 'user+plugin',
    headline: {
      sentence: buildHeadline({
        days,
        skillsTotal: catalog.skills.length,
        tokensLow: cost.tokensLow,
        tokensHigh: cost.tokensHigh,
        candidateCount: candidates.length,
        candidateTokensHigh,
        names: candidates.map((c) => c.name),
      }),
      skillsTotal: catalog.skills.length,
      tokensLow: cost.tokensLow,
      tokensHigh: cost.tokensHigh,
      candidateCount: candidates.length,
      candidateTokensHigh,
      candidateNames: candidates.map((c) => c.name),
    },
    cost: {
      ...cost,
      estimator: cost.estimator || 'low=ascii/4+cjk/2; high=ascii/3+cjk/1.5',
      denominator:
        cost.denominator ||
        '仅 user + plugin 的 SKILL.md description；不含内置技能、项目技能、MCP 与 CLAUDE.md',
      unit: cost.unit || '每次模型请求的上下文占用估算；prompt cache 会降低计费增量',
      rounding: cost.rounding || 'per-skill Math.round；全局 = per-skill 整数之和',
    },
    quality: {
      confidence: confidenceFor(usage.events),
      observedEvents: usage.events,
      observedSkills: skills.filter((s) => s.observed).length,
      skillsTotal: catalog.skills.length,
      thresholds: { lowMax: CONFIDENCE_LOW_MAX, highMin: CONFIDENCE_HIGH_MIN },
      mentionTracking: {
        ...mentionInfo,
        mode: 'event_fields',
        caveat: '仅用户任务文本与工具调用摘要，不覆盖助手正文、工具返回、文件内容与完整路径',
      },
      callLogTruncated: usage.truncated,
      scopeNote: 'user + plugin；项目作用域未扫描',
      eventNote: '来自 Skill tool_use 与 history.jsonl 中匹配已安装技能名的斜杠命令（同会话 2 分钟内去重）',
    },
    candidates,
    skills,
    unmatched,
  };
}
