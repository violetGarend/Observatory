import { EventEmitter } from 'node:events';
import { TIMELINE_RETENTION_DAYS } from './config.js';
import { buildBuckets, pickStep } from './timeline.js';

const RECENT_PER_PROJECT = 40;
const RECENT_TOTAL = 600;
const TIMELINE_RETENTION_MIN = TIMELINE_RETENTION_DAYS * 24 * 60;
const IDLE_MS = 5 * 60 * 1000; // 超过 5 分钟无活动视为空闲
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SKILL_TIMES = 512;
const MAX_MENTION_NAMES = 32;
// 同一次「斜杠命令 → Skill 工具调用」在历史与转录里各有一条，按会话+时间合并
const SLASH_DEDUP_MS = 2 * 60 * 1000;

export const STATUS = {
  running: '执行中',
  thinking: '思考中',
  waiting: '等待输入',
  idle: '空闲',
};

/** 技能名匹配的边界：标识符内部出现不算「提及」 */
const NAME_BOUNDARY = /[a-z0-9_.-]/;

function makeNameMatcher(needle) {
  const ascii = /^[\x20-\x7e]+$/.test(needle);
  if (!ascii) return (hay) => hay.includes(needle);

  return (hay) => {
    let i = hay.indexOf(needle);
    while (i !== -1) {
      const before = i > 0 ? hay[i - 1] : '';
      const after = hay[i + needle.length] || '';
      if (!NAME_BOUNDARY.test(before) && !NAME_BOUNDARY.test(after)) return true;
      i = hay.indexOf(needle, i + 1);
    }
    return false;
  };
}

/**
 * 内存聚合层。只保留聚合指标 + 每个 Agent 的当前状态 + 最近事件。
 */
export class Store extends EventEmitter {
  constructor() {
    super();
    this.reset();
  }

  reset() {
    this.totals = {
      messages: 0,
      toolCalls: 0,
      skillCalls: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreate: 0,
    };
    this.byModel = new Map();
    this.bySkill = new Map();
    this.byMcp = new Map();
    // 与 bySkill 分离：snapshot() 会展开 bySkill，时间戳数组不能混进去
    this.skillCallLog = new Map();
    this.mentions = new Map();
    this.mentionMatchers = [];
    this.mentionTracked = new Set();
    this.mentionTrackedSince = 0;
    this.mentionScanMs = 0;
    this.byProject = new Map();
    this.byTrigger = { user: 0, proactive: 0, nested: 0, unknown: 0 };
    this.sessions = new Map();
    this.timeline = new Map();
    this.timelineMinMinute = 0;
    this.timelineMaxMinute = 0;
    this.lastPruneMinute = 0;
    this.recentByProject = new Map();
    this.recentSeq = 0;
    this.lastEventAt = 0;
    this.startedAt = Date.now();
  }

  ingest(event) {
    if (event.kind === 'meta') return this.applyMeta(event);
    if (event.kind === 'user') return this.applyUser(event);
    return this.applyAssistant(event);
  }

  // ---------- meta：标题 / agent 名 / 任务 / 成本 ----------
  applyMeta(e) {
    const s = this.ensureSession(e.sessionId, e);
    switch (e.sub) {
      case 'title':
        s.aiTitle = e.value || s.aiTitle;
        break;
      case 'agentName':
        s.agentName = e.value || s.agentName;
        break;
      case 'lastPrompt':
        s.lastPrompt = e.value || s.lastPrompt;
        break;
      case 'cost':
        s.cost = e.value.usd;
        s.modelUsage = e.value.modelUsage;
        s.apiDuration = e.value.apiDuration;
        s.toolDuration = e.value.toolDuration;
        s.linesAdded = e.value.linesAdded;
        s.linesRemoved = e.value.linesRemoved;
        break;
      case 'turnDuration':
        s.turnDuration = e.value;
        break;
      case 'mode':
        s.mode = e.value;
        break;
    }
    if (e.tsMs > 0) s.lastEventAt = Math.max(s.lastEventAt, e.tsMs);
  }

  // ---------- user：任务上下文 + tool_result ----------
  applyUser(e) {
    this._touchMentions(e);
    const s = this.ensureSession(e.sessionId, e);
    if (e.task) {
      s.task = e.task;
      if (!s.title) s.title = e.task.slice(0, 60);
    }
    for (const id of e.toolResultIds) {
      const pending = s.pendingTools.get(id);
      if (pending) {
        pending.done = true;
        pending.doneAt = e.tsMs;
        pending.isError = e.isError;
        s.pendingTools.delete(id);
        s.lastTool = { name: pending.name, summary: pending.summary, isError: e.isError, ts: pending.ts };
      }
    }
    if (!e.toolResultIds.length && !e.task) return;

    s.lastKind = 'user';
    if (e.tsMs > 0) {
      s.start = s.start ? Math.min(s.start, e.tsMs) : e.tsMs;
      s.end = Math.max(s.end, e.tsMs);
      s.lastEventAt = Math.max(s.lastEventAt, e.tsMs);
    }
  }

  // ---------- assistant ----------
  applyAssistant(event) {
    this._touchMentions(event);
    // 没有 timestamp 的行（部分 meta / 异常转录）不能落到 1970 年桶里
    if (event.tsMs > 0) this._touchBucket(Math.floor(event.tsMs / 60000), event);

    const s = this.ensureSession(event.sessionId, event);

    this.totals.messages++;
    if (event.usage) {
      this.totals.input += event.usage.input;
      this.totals.output += event.usage.output;
      this.totals.cacheRead += event.usage.cacheRead;
      this.totals.cacheCreate += event.usage.cacheCreate;
    }
    this.totals.toolCalls += event.toolCalls.length;

    if (event.model) {
      const m = this.byModel.get(event.model) || { model: event.model, messages: 0, input: 0, output: 0, cacheRead: 0 };
      m.messages++;
      if (event.usage) {
        m.input += event.usage.input;
        m.output += event.usage.output;
        m.cacheRead += event.usage.cacheRead;
      }
      this.byModel.set(event.model, m);
    }

    if (event.tsMs > 0) {
      s.start = s.start ? Math.min(s.start, event.tsMs) : event.tsMs;
      s.end = Math.max(s.end, event.tsMs);
      s.lastEventAt = Math.max(s.lastEventAt, event.tsMs);
    }
    s.messages++;
    s.model = event.model || s.model;
    if (event.title) s.title = event.title;
    if (event.task) s.task = event.task;
    if (event.thinking) {
      s.thinking = event.thinking;
      s.thinkingAt = event.tsMs;
    }
    s.stopReason = event.stopReason;
    s.lastKind = 'assistant';
    s.lastEventAt = Math.max(s.lastEventAt, event.tsMs);
    if (event.usage) {
      s.output += event.usage.output;
      s.cacheRead += event.usage.cacheRead;
      s.input += event.usage.input;
    }

    // 配对 tool_use / tool_result：没有 result 的调用就是「正在执行」
    event.toolCalls.forEach((tc, i) => {
      const id = event.toolUseIds[i];
      if (!id) return;
      s.pendingTools.set(id, { name: tc.name, summary: tc.summary, ts: event.tsMs });
    });
    // 防御：异常情况下 pending 无限增长
    if (s.pendingTools.size > 50) {
      const keep = new Map([...s.pendingTools.entries()].slice(-20));
      s.pendingTools = keep;
    }

    // MCP 工具调用名形如 mcp__<server>__<tool>，按服务器聚合
    for (const tc of event.toolCalls) {
      if (!tc.name || !tc.name.startsWith('mcp__')) continue;
      const rest = tc.name.slice(5);
      const cut = rest.indexOf('__');
      const server = cut === -1 ? rest : rest.slice(0, cut);
      if (!server) continue;
      const tool = cut === -1 ? '' : rest.slice(cut + 2);

      const rec = this.byMcp.get(server) || {
        server,
        calls: 0,
        tools: new Set(),
        sessions: new Set(),
        lastAt: 0,
        lastTool: '',
      };
      rec.calls++;
      if (tool) rec.tools.add(tool);
      rec.lastAt = Math.max(rec.lastAt, event.tsMs);
      rec.sessions.add(event.sessionId);
      if (tool) rec.lastTool = tool;
      this.byMcp.set(server, rec);
    }

    const project = this.byProject.get(event.project) || { project: event.project, messages: 0, skillCalls: 0, output: 0 };
    project.messages++;
    if (event.usage) project.output += event.usage.output;

    if (event.skills.length) {
      this.totals.skillCalls += event.skills.length;
      project.skillCalls += event.skills.length;
      s.skillCalls += event.skills.length;

      for (const skill of event.skills) {
        this.trackSkillEvent(skill.name, event.tsMs, event.isSidechain, event.sessionId);
        const trigger = skill.trigger || 'unknown';
        this.byTrigger[trigger] = (this.byTrigger[trigger] || 0) + 1;

        const rec = this.bySkill.get(skill.name) || {
          name: skill.name,
          count: 0,
          firstAt: event.tsMs,
          lastAt: 0,
          triggers: { user: 0, proactive: 0, nested: 0, unknown: 0 },
          sessions: new Set(),
          projects: new Set(),
        };
        rec.count++;
        rec.lastAt = Math.max(rec.lastAt, event.tsMs);
        rec.firstAt = Math.min(rec.firstAt, event.tsMs);
        rec.triggers[trigger] = (rec.triggers[trigger] || 0) + 1;
        rec.sessions.add(event.sessionId);
        rec.projects.add(event.project);
        this.bySkill.set(skill.name, rec);
      }
    }

    // 实时流：按项目分配配额，避免最活跃的项目把历史回填全部吃掉
    if (event.skills.length || event.toolCalls.length) {
      this.recentSeq++;
      const item = {
        seq: this.recentSeq,
        ts: event.tsMs,
        sessionId: event.sessionId,
        project: event.project,
        cwd: event.cwd,
        model: event.model,
        task: event.task,
        title: event.title,
        isSidechain: event.isSidechain,
        skills: event.skills,
        trigger: event.trigger,
        text: event.text,
        thinking: event.thinking,
        toolCalls: event.toolCalls.slice(0, 4),
      };

      const key = event.project || 'unknown';
      let bucket = this.recentByProject.get(key);
      if (!bucket) {
        bucket = [];
        this.recentByProject.set(key, bucket);
      }
      bucket.unshift(item);
      if (bucket.length > RECENT_PER_PROJECT) bucket.length = RECENT_PER_PROJECT;
    }

    this.byProject.set(event.project, project);
    this.lastEventAt = Math.max(this.lastEventAt, event.tsMs);
  }

  ensureSession(id, info) {
    let s = this.sessions.get(id);
    if (!s) {
      s = {
        id,
        project: info?.project || '',
        cwd: info?.cwd || '',
        model: info?.model || null,
        title: '',
        aiTitle: '',
        agentName: '',
        lastPrompt: '',
        task: '',
        mode: '',
        // meta 行没有 timestamp，绝不能回退到 Date.now()：
        // 否则每次重启回放都会把所有旧会话的「最后活动」刷成当前时间。
        start: info?.tsMs > 0 ? info.tsMs : 0,
        end: info?.tsMs > 0 ? info.tsMs : 0,
        lastEventAt: info?.tsMs > 0 ? info.tsMs : 0,
        messages: 0,
        output: 0,
        input: 0,
        cacheRead: 0,
        skillCalls: 0,
        cost: null,
        modelUsage: null,
        turnDuration: null,
        thinking: '',
        thinkingAt: 0,
        stopReason: null,
        lastKind: '',
        lastTool: null,
        pendingTools: new Map(),
      };
      this.sessions.set(id, s);
    } else {
      // cwd 取会话首次出现的值：转录里 cwd 会随 shell 的 cd 变化（如进到子目录），
      // 用最新值会让会话在项目分组间来回跳。
      if (!s.cwd && info?.cwd) s.cwd = info.cwd;
      if (info?.project) s.project = info.project;
      if (info?.model) s.model = info.model;
    }
    return s;
  }

  _touchBucket(minute, event) {
    let b = this.timeline.get(minute);
    if (!b) {
      b = { minute, ts: minute * 60000, messages: 0, output: 0, cacheRead: 0, skills: 0, tools: 0 };
      this.timeline.set(minute, b);
      if (!this.timelineMinMinute || minute < this.timelineMinMinute) this.timelineMinMinute = minute;
      if (minute > this.timelineMaxMinute) this.timelineMaxMinute = minute;
      // 每前进 30 分钟才扫一次，避免每个新桶都遍历整个 Map
      const nowMinute = Math.floor(Date.now() / 60000);
      if (nowMinute - this.lastPruneMinute >= 30) this.pruneTimeline(nowMinute);
    }
    b.messages++;
    b.tools += event.toolCalls.length;
    b.skills += event.skills.length;
    if (event.usage) {
      b.output += event.usage.output;
      b.cacheRead += event.usage.cacheRead;
    }
  }

  /** 斜杠命令补记：只给分钟桶的 skill 计数 +1 */
  _touchTimelineSkill(tsMs) {
    if (!(tsMs > 0)) return;
    const cutoff = Date.now() - TIMELINE_RETENTION_MIN * 60000;
    if (tsMs < cutoff) return;

    const minute = Math.floor(tsMs / 60000);
    let b = this.timeline.get(minute);
    if (!b) {
      b = { minute, ts: minute * 60000, messages: 0, output: 0, cacheRead: 0, skills: 0, tools: 0 };
      this.timeline.set(minute, b);
      if (!this.timelineMinMinute || minute < this.timelineMinMinute) this.timelineMinMinute = minute;
      if (minute > this.timelineMaxMinute) this.timelineMaxMinute = minute;
      const nowMinute = Math.floor(Date.now() / 60000);
      if (nowMinute - this.lastPruneMinute >= 30) this.pruneTimeline(nowMinute);
    }
    b.skills++;
  }

  /** 只保留最近 TIMELINE_RETENTION_DAYS 天的分钟桶 */
  pruneTimeline(nowMinute = Math.floor(Date.now() / 60000)) {
    const cutoff = nowMinute - TIMELINE_RETENTION_MIN;
    for (const key of this.timeline.keys()) if (key < cutoff) this.timeline.delete(key);
    this.lastPruneMinute = nowMinute;

    if (!this.timeline.size) {
      this.timelineMinMinute = 0;
      this.timelineMaxMinute = 0;
    } else if (this.timelineMinMinute < cutoff) {
      let min = Infinity;
      for (const key of this.timeline.keys()) if (key < min) min = key;
      this.timelineMinMinute = min;
    }
  }

  /** 按区间聚合时间线；超出保留窗口的部分被钳制 */
  timelineRange(from, to, now = Date.now()) {
    const retentionStart = now - TIMELINE_RETENTION_MIN * 60000;
    const toMs = Math.min(to, now);
    const availableFrom = this.timelineMinMinute ? this.timelineMinMinute * 60000 : null;
    const availableTo = this.timelineMaxMinute ? this.timelineMaxMinute * 60000 + 59999 : null;

    if (toMs <= retentionStart) {
      return {
        from,
        to: toMs,
        granularity: 0,
        buckets: [],
        availableFrom,
        availableTo,
        truncated: true,
        outOfRetention: true,
        retentionDays: TIMELINE_RETENTION_DAYS,
      };
    }

    const fromMs = Math.max(Math.min(from, toMs), retentionStart);
    const stepMs = pickStep(toMs - fromMs);
    return {
      from: fromMs,
      to: toMs,
      granularity: stepMs,
      buckets: buildBuckets(this.timeline, fromMs, toMs, stepMs),
      availableFrom,
      availableTo,
      truncated: fromMs > from,
      outOfRetention: false,
      retentionDays: TIMELINE_RETENTION_DAYS,
    };
  }

  // ---------- 技能账单：窗口调用日志 + 第二信号 ----------
  /** 只记录保留窗口内的调用；时间戳数组与 bySkill 分离，避免进 250ms 快照 */
  trackSkillEvent(name, tsMs, isSidechain = false, sessionId = '', source = 'skill') {
    if (!name || !(tsMs > 0)) return;

    // 不做时间裁剪：这份日志还承担「斜杠命令 vs Skill tool_use」的去重索引。
    // 每个技能最多 512 条，sparse 调用下内存可忽略。
    let entries = this.skillCallLog.get(name);
    if (!entries) {
      entries = [];
      this.skillCallLog.set(name, entries);
    }
    entries.push({ ts: tsMs, side: !!isSidechain, sessionId, source });
    if (entries.length > MAX_SKILL_TIMES) entries.splice(0, entries.length - MAX_SKILL_TIMES);
  }

  /**
   * 补记一次斜杠命令触发的技能调用。
   * 同一会话里 2 分钟内已有同名 Skill tool_use 时视为同一次调用，避免双计。
   */
  recordSlashSkill({ name, tsMs, sessionId = '', project = '' } = {}) {
    if (!name || !(tsMs > 0)) return false;

    const entries = this.skillCallLog.get(name) || [];
    if (
      sessionId &&
      entries.some(
        (e) =>
          e.source === 'skill' &&
          e.sessionId === sessionId &&
          Math.abs(e.ts - tsMs) <= SLASH_DEDUP_MS
      )
    ) {
      return false;
    }

    this.totals.skillCalls++;
    this.byTrigger.user++;

    const rec = this.bySkill.get(name) || {
      name,
      count: 0,
      firstAt: tsMs,
      lastAt: 0,
      triggers: { user: 0, proactive: 0, nested: 0, unknown: 0 },
      sessions: new Set(),
      projects: new Set(),
    };
    rec.count++;
    rec.firstAt = rec.firstAt ? Math.min(rec.firstAt, tsMs) : tsMs;
    rec.lastAt = Math.max(rec.lastAt, tsMs);
    rec.triggers.user++;
    if (sessionId) rec.sessions.add(sessionId);
    if (project) rec.projects.add(project);
    this.bySkill.set(name, rec);

    this.trackSkillEvent(name, tsMs, false, sessionId, 'slash');
    // 时间线只记 skill 计数，不伪造消息与 token
    this._touchTimelineSkill(tsMs);

    // 会话仍在内存里时同步会话级计数；被清理掉的旧会话不重建，避免伪造「最近活动」
    const session = sessionId ? this.sessions.get(sessionId) : null;
    if (session) session.skillCalls++;

    return true;
  }

  ingestSlashSkills(events = []) {
    let added = 0;
    for (const event of events) if (this.recordSlashSkill(event)) added++;
    return added;
  }

  skillWindowStats(cutoffMs = Date.now() - 30 * DAY_MS) {
    const byName = new Map();
    let events = 0;
    let truncated = false;

    for (const [name, entries] of this.skillCallLog) {
      if (entries.length >= MAX_SKILL_TIMES) truncated = true;
      let invocations = 0;
      let lastUsed = 0;
      let main = false;
      let sidechain = false;

      for (const e of entries) {
        if (e.ts < cutoffMs) continue;
        invocations++;
        if (e.ts > lastUsed) lastUsed = e.ts;
        if (e.side) sidechain = true;
        else main = true;
      }
      if (!invocations) continue;

      events += invocations;
      byName.set(name, {
        invocations,
        lastUsed: lastUsed || null,
        origin: main && sidechain ? 'both' : main ? 'main' : 'sidechain',
      });
    }

    return { events, byName, truncated };
  }

  /**
   * 第二信号的匹配名单：只跟踪高成本技能（潜在候选），启动时固定。
   * 完整名是 strong；插件裸后缀（≥8 字符且含连字符）是 weak。
   */
  setMentionTargets(names = []) {
    const unique = [...new Set(names.filter((n) => typeof n === 'string' && n.trim()))].slice(
      0,
      MAX_MENTION_NAMES
    );

    this.mentionTracked = new Set(unique);
    this.mentionTrackedSince = Date.now();
    this.mentionMatchers = unique.map((name) => {
      const full = name.toLowerCase();
      const bare = full.includes(':') ? full.split(':').slice(1).join(':') : '';
      const weak = bare && bare.length >= 8 && bare.includes('-') ? bare : null;
      return { name, strong: makeNameMatcher(full), weak: weak ? makeNameMatcher(weak) : null };
    });

    return this.mentionMatchers.length;
  }

  /** 清洗后的消息字段拼成一段文本，按天记录强/弱提及 */
  _touchMentions(event) {
    if (!this.mentionMatchers.length) return;
    const ts = event?.tsMs;
    if (!(ts > 0)) return;

    const cutoff = Date.now() - TIMELINE_RETENTION_MIN * 60000;
    if (ts < cutoff) return;

    // 只看「用户实际说的话」与工具调用摘要，不看 Claude 自己的正文/思考：
    // 否则助手在回复里推荐过一次技能，就会把所有候选永久压掉。
    const parts = [event.task];
    for (const tc of event.toolCalls || []) parts.push(tc.name, tc.summary);
    const hay = parts.filter(Boolean).join('\n').toLowerCase();
    if (!hay) return;

    const started = performance.now();
    const day = Math.floor(ts / DAY_MS);
    const cutoffDay = Math.floor(cutoff / DAY_MS);

    for (const matcher of this.mentionMatchers) {
      let level = '';
      if (matcher.strong(hay)) level = 'strong';
      else if (matcher.weak && matcher.weak(hay)) level = 'weak';
      if (!level) continue;

      let days = this.mentions.get(matcher.name);
      if (!days) {
        days = new Map();
        this.mentions.set(matcher.name, days);
      }
      const rec = days.get(day) || { strong: false, weak: false, lastAt: 0 };
      if (level === 'strong') rec.strong = true;
      else rec.weak = true;
      if (ts > rec.lastAt) rec.lastAt = ts;
      days.set(day, rec);

      if (days.size > 95) {
        for (const key of days.keys()) if (key < cutoffDay) days.delete(key);
      }
    }

    this.mentionScanMs += performance.now() - started;
  }

  mentionStats(cutoffMs = Date.now() - 30 * DAY_MS) {
    const cutoffDay = Math.floor(cutoffMs / DAY_MS);
    const out = new Map();

    for (const [name, days] of this.mentions) {
      let strong = 0;
      let weak = 0;
      let lastAt = 0;
      for (const [day, rec] of days) {
        if (day < cutoffDay) continue;
        if (rec.strong) strong++;
        if (rec.weak) weak++;
        if (rec.lastAt > lastAt) lastAt = rec.lastAt;
      }
      out.set(name, { strong, weak, lastAt: lastAt || null });
    }

    return out;
  }

  mentionTrackingInfo() {
    return {
      enabled: this.mentionMatchers.length > 0,
      trackedNames: this.mentionMatchers.length,
      trackedSince: this.mentionTrackedSince || null,
      scanMs: Math.round(this.mentionScanMs),
    };
  }

  snapshot() {
    const recent = [...this.recentByProject.values()]
      .flat()
      .sort((a, b) => b.ts - a.ts)
      .slice(0, RECENT_TOTAL);
    const now = Date.now();

    const sessions = [...this.sessions.values()]
      .map((s) => this.serializeSession(s, now))
      .sort((a, b) => b.lastEventAt - a.lastEventAt);

    const activeSessions = sessions.filter((s) => s.status !== 'idle').length;

    return {
      generatedAt: now,
      startedAt: this.startedAt,
      lastEventAt: this.lastEventAt,
      totals: this.totals,
      cacheHitRate:
        this.totals.input + this.totals.cacheRead > 0
          ? this.totals.cacheRead / (this.totals.input + this.totals.cacheRead)
          : 0,
      models: [...this.byModel.values()].sort((a, b) => b.messages - a.messages),
      skills: [...this.bySkill.values()]
        .map((s) => ({
          ...s,
          sessions: s.sessions.size,
          projects: s.projects.size,
          lastAt: s.lastAt || null,
        }))
        .sort((a, b) => b.count - a.count || b.lastAt - a.lastAt),
      mcp: [...this.byMcp.values()]
        .map((m) => ({
          server: m.server,
          calls: m.calls,
          tools: m.tools.size,
          sessions: m.sessions.size,
          lastAt: m.lastAt || null,
          lastTool: m.lastTool,
        }))
        .sort((a, b) => b.calls - a.calls || b.lastAt - a.lastAt),
      triggers: { ...this.byTrigger },
      projects: [...this.byProject.values()].sort((a, b) => b.messages - a.messages),
      sessions,
      sessionsTotal: this.sessions.size,
      activeSessions,
      timelineAvailableFrom: this.timelineMinMinute ? this.timelineMinMinute * 60000 : null,
      timelineAvailableTo: this.timelineMaxMinute ? this.timelineMaxMinute * 60000 + 59999 : null,
      timelineRetentionDays: TIMELINE_RETENTION_DAYS,
      recent,
    };
  }

  serializeSession(s, now) {
    const idleMs = s.lastEventAt ? now - s.lastEventAt : Infinity;
    let status = 'idle';
    if (idleMs <= IDLE_MS) {
      if (s.pendingTools.size > 0) status = 'running';
      else if (s.lastKind === 'user') status = 'thinking';
      else if (s.lastKind === 'assistant') status = s.stopReason === 'end_turn' ? 'waiting' : 'thinking';
      else status = 'idle';
    }

    const start = s.start || s.lastEventAt || 0;
    const end = s.end || s.lastEventAt || 0;

    return {
      id: s.id,
      project: s.project,
      cwd: s.cwd,
      model: s.model,
      title: s.aiTitle || s.title || s.agentName || '',
      aiTitle: s.aiTitle,
      agentName: s.agentName,
      lastPrompt: s.lastPrompt,
      task: s.lastPrompt || s.task,
      mode: s.mode,
      start,
      end,
      lastEventAt: s.lastEventAt,
      idleMs: idleMs === Infinity ? null : idleMs,
      messages: s.messages,
      output: s.output,
      input: s.input,
      cacheRead: s.cacheRead,
      skillCalls: s.skillCalls,
      cost: s.cost,
      modelUsage: s.modelUsage,
      turnDuration: s.turnDuration,
      thinking: s.thinking,
      thinkingAt: s.thinkingAt,
      stopReason: s.stopReason,
      status,
      lastTool: s.lastTool,
      currentTools:
        status === 'idle'
          ? []
          : [...s.pendingTools.values()].map((t) => ({
              name: t.name,
              summary: t.summary,
              ts: t.ts,
            })),
    };
  }
}
