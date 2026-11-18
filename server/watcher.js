import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PROJECTS_DIR, SCAN_INTERVAL } from './config.js';

const SLASH_RE = /<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/i;
const THINKING_LIMIT = 400;
const TASK_LIMIT = 200;

/**
 * 增量 tail ~/.claude/projects/**\/*.jsonl。
 *
 * 读取策略：
 *  - 每个文件记录字节 offset + 未成行的 Buffer 尾巴，避免把半行当完整 JSON 解析；
 *  - 文件被截断重写（size < offset）时自动重置；
 *  - 只对 offset 之后的新字节做 JSON.parse，历史一次性回放后即转为增量。
 *
 * 产出三类事件：
 *  - meta：ai-title / agent-name / last-prompt / cost-state / turn_duration
 *  - user：用户输入（任务上下文）与 tool_result（标记工具完成）
 *  - assistant：消息、thinking、stop_reason、tool_use
 */
export class Watcher extends EventEmitter {
  constructor(store, { interval = SCAN_INTERVAL } = {}) {
    super();
    this.store = store;
    this.interval = interval;
    this.files = new Map(); // filePath -> { offset, pending: Buffer|null, project, sessionId }
    this.timer = null;
    this.scanning = false;
    this.replaying = false;
  }

  start() {
    if (this.timer) return;
    // 首次全量回放只喂给聚合层，不往前端推历史事件，避免开屏被上千条刷屏
    this.replaying = true;
    this.scanOnce();
    this.replaying = false;
    this.timer = setInterval(() => this.scanOnce(), this.interval);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  scanOnce() {
    if (this.scanning) return;
    this.scanning = true;
    try {
      const files = listTranscripts(PROJECTS_DIR);
      let newEvents = 0;
      for (const file of files) newEvents += this.readNew(file);
      if (newEvents > 0) this.emit('ingested', newEvents);
    } catch (err) {
      this.emit('error', err);
    } finally {
      this.scanning = false;
    }
  }

  /** @returns {number} 本次解析出的事件数 */
  readNew(file) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return 0;
    }

    const project = path.basename(path.dirname(file));
    const sessionId = path.basename(file, '.jsonl');

    let state = this.files.get(file);
    if (!state) {
      state = { offset: 0, pending: null, project, sessionId, firstSeenAt: stat.birthtimeMs || stat.ctimeMs };
      this.files.set(file, state);
    } else if (stat.size < state.offset) {
      state.offset = 0;
      state.pending = null;
    }

    if (stat.size === state.offset) return 0;

    const length = stat.size - state.offset;
    const buf = Buffer.allocUnsafe(length);
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      fs.readSync(fd, buf, 0, length, state.offset);
    } catch {
      return 0;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    state.offset = stat.size;

    const chunk = state.pending ? Buffer.concat([state.pending, buf]) : buf;
    const lastBreak = chunk.lastIndexOf(0x0a);
    if (lastBreak === -1) {
      state.pending = chunk;
      return 0;
    }
    state.pending = chunk.subarray(lastBreak + 1);

    const text = chunk.subarray(0, lastBreak).toString('utf8');
    let count = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const event = parseLine(line, state);
      if (!event) continue;
      this.store.ingest(event);
      count++;
      if (!this.replaying && event.kind === 'assistant' && (event.skills.length || event.toolCalls.length)) {
        this.emit('event', event);
      }
    }
    return count;
  }
}

function listTranscripts(root) {
  const out = [];
  let dirs;
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const dirPath = path.join(root, dir.name);
    let entries;
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        out.push(path.join(dirPath, entry.name));
      }
    }
  }
  return out;
}

const SKILL_TOOL_NAMES = new Set(['Skill', 'SlashCommand']);

function summarizeTool(name, input = {}) {
  switch (name) {
    case 'Bash':
      return String(input.description || input.command || '').slice(0, 90);
    case 'Read':
    case 'Write':
    case 'Edit':
      return path.basename(String(input.file_path || ''));
    case 'Grep':
    case 'Glob':
      return String(input.pattern || '');
    case 'Agent':
    case 'Task':
      return String(input.description || input.subagent_type || '').slice(0, 60);
    default:
      return String(input.description || '').slice(0, 60);
  }
}

function extractSkillName(name, input = {}) {
  if (name === 'Skill') return input.skill || input.name || null;
  if (name === 'SlashCommand') return input.command || null;
  return null;
}

/** 从 user 消息里提取可读文本，去掉系统注入的 XML 标记 */
function extractUserText(content) {
  let raw = '';
  if (typeof content === 'string') raw = content;
  else if (Array.isArray(content)) {
    raw = content
      .filter((b) => b?.type === 'text')
      .map((b) => b.text || '')
      .join('\n');
  }
  if (!raw) return '';

  raw = raw
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ')
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/gi, ' ')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/gi, ' ')
    .replace(/<local-command-stderr>[\s\S]*?<\/local-command-stderr>/gi, ' ');

  // 未闭合标记兜底：含工具调用 ID 的通知残片不是任务描述
  if (/call_[A-Za-z0-9_]+/.test(raw) && /(output-file|task-id)/.test(raw)) return '';

  const text = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (/^This session is being continued/i.test(text)) return '';
  if (/^Caveat: The messages below were generated/i.test(text)) return '';
  return text;
}

const lastUserSlash = new Map();
const lastUserText = new Map();
const sessionTitles = new Map();

/**
 * 把一行转录归一成事件。
 * - meta 行（标题 / agent 名 / 成本 / 轮次耗时）
 * - user 行（任务上下文 + tool_result）
 * - assistant 行（thinking / stop_reason / tool_use）
 */
function parseLine(line, state) {
  let d;
  try {
    d = JSON.parse(line);
  } catch {
    return null;
  }

  // 部分 meta 行（ai-title / cost-state 等）没有 timestamp。
  // 此时置 0 而不是 Date.now()，否则历史会话会被误判成「刚刚活跃」。
  const ts = d.timestamp || null;
  const tsMs = ts ? Date.parse(ts) || 0 : 0;
  const sessionId = d.sessionId || state.sessionId;
  const base = {
    ts,
    tsMs,
    sessionId,
    project: state.project,
    cwd: d.cwd || '',
  };

  // ---------- meta 行 ----------
  switch (d.type) {
    case 'ai-title':
      return { ...base, kind: 'meta', sub: 'title', value: d.aiTitle || '' };
    case 'agent-name':
      return { ...base, kind: 'meta', sub: 'agentName', value: d.agentName || '' };
    case 'last-prompt':
      return { ...base, kind: 'meta', sub: 'lastPrompt', value: String(d.lastPrompt || '').slice(0, TASK_LIMIT) };
    case 'cost-state':
      return {
        ...base,
        kind: 'meta',
        sub: 'cost',
        value: {
          usd: d.totalCostUSD ?? null,
          duration: d.totalDuration ?? null,
          apiDuration: d.totalAPIDuration ?? null,
          toolDuration: d.totalToolDuration ?? null,
          linesAdded: d.totalLinesAdded ?? 0,
          linesRemoved: d.totalLinesRemoved ?? 0,
          modelUsage: d.modelUsage || null,
        },
      };
    case 'system':
      if (d.subtype === 'turn_duration') {
        return { ...base, kind: 'meta', sub: 'turnDuration', value: d.durationMs ?? null };
      }
      return null;
    case 'mode':
      return { ...base, kind: 'meta', sub: 'mode', value: d.mode || '' };
  }

  const msg = d.message;
  if (!msg) return null;

  const content = msg.content;

  // ---------- user：任务上下文 + tool_result ----------
  if (d.type === 'user') {
    let slash = null;
    const toolResultIds = [];
    let isError = false;

    if (typeof content === 'string') {
      if (content.trim().startsWith('/')) slash = content.trim().split(/\s+/)[0].slice(1);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text') {
          const m = SLASH_RE.exec(block.text || '') || /^<command-message>([^<]+)</.exec(block.text || '');
          if (m) slash = m[1].replace(/^\//, '').trim();
        } else if (block.type === 'tool_result') {
          if (block.tool_use_id) toolResultIds.push(block.tool_use_id);
          if (block.is_error) isError = true;
        }
      }
    }

    let task = '';
    if (!d.isMeta) {
      task = extractUserText(content);
      // 只有真实用户输入才更新「上一条输入」状态。
      // tool_result 行也是 type=user，但它不是用户打的字，不能把斜杠命令标记清掉。
      if (task || slash) {
        lastUserSlash.set(sessionId, slash);
        if (!task && slash) task = `/${slash}`;
        if (task) {
          lastUserText.set(sessionId, task);
          if (!sessionTitles.get(sessionId) && task.length >= 4) {
            sessionTitles.set(sessionId, task.slice(0, 60));
          }
        }
      }
    }

    if (!toolResultIds.length && !task) return null;

    return {
      ...base,
      kind: 'user',
      slash,
      task,
      isMeta: !!d.isMeta,
      toolResultIds,
      isError,
      isSidechain: !!d.isSidechain,
    };
  }

  // ---------- assistant ----------
  if (d.type !== 'assistant') return null;

  const event = {
    ...base,
    kind: 'assistant',
    model: msg.model || null,
    stopReason: msg.stop_reason || null,
    isSidechain: !!d.isSidechain,
    task: lastUserText.get(sessionId) || '',
    title: sessionTitles.get(sessionId) || '',
    thinking: '',
    text: '',
    usage: null,
    toolCalls: [],
    toolUseIds: [],
    skills: [],
    trigger: null,
  };

  if (msg.usage) {
    event.usage = {
      input: msg.usage.input_tokens || 0,
      output: msg.usage.output_tokens || 0,
      cacheRead: msg.usage.cache_read_input_tokens || 0,
      cacheCreate: msg.usage.cache_creation_input_tokens || 0,
    };
  }

  if (typeof content === 'string') {
    event.text = content.slice(0, 200);
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'thinking') {
        event.thinking = String(block.thinking || '').slice(0, THINKING_LIMIT);
      } else if (block.type === 'text') {
        if (!event.text) event.text = String(block.text || '').slice(0, 200);
      } else if (block.type === 'tool_use') {
        event.toolCalls.push({ name: block.name, summary: summarizeTool(block.name, block.input) });
        event.toolUseIds.push(block.id || null);
        if (SKILL_TOOL_NAMES.has(block.name)) {
          const skill = extractSkillName(block.name, block.input);
          if (skill) event.skills.push({ name: skill, args: String(block.input?.args || '').slice(0, 120) });
        }
      }
    }
  }

  if (event.skills.length) {
    const slash = lastUserSlash.get(sessionId);
    event.trigger = slash ? 'user' : 'proactive';
    if (event.skills.length > 1) {
      event.skills = event.skills.map((s, i) => ({ ...s, trigger: i === 0 ? event.trigger : 'nested' }));
    } else {
      event.skills[0].trigger = event.trigger;
    }
    lastUserSlash.set(sessionId, null);
  }

  return event;
}
