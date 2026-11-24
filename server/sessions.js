import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { PROJECTS_DIR } from './config.js';
import { cleanPromptText, readSlashSkillEvents } from './history.js';
import { loadSkillCatalog } from './skills.js';

const DEFAULT_LIMIT = 300;
const MAX_LIMIT = 1000;
const CACHE_MAX = 4;

/** key = sessionId；value = { signature, data } */
const cache = new Map();
const pending = new Map();

const SUMMARY_KEYS = [
  'description',
  'command',
  'function',
  'url',
  'file_path',
  'pattern',
  'query',
  'expression',
  'selector',
  'text',
  'value',
  'uid',
  'format',
  'path',
  'prompt',
  'old_string',
  'new_string',
];

function clean(text, limit = 160) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function describeTool(name, input = {}) {
  if (name === 'Skill') {
    return {
      kind: 'skill',
      name: input.skill || input.name || 'unknown',
      server: '',
      summary: clean(input.args),
    };
  }

  if (name.startsWith('mcp__')) {
    const rest = name.slice(5);
    const cut = rest.indexOf('__');
    const server = cut === -1 ? rest : rest.slice(0, cut);
    const tool = cut === -1 ? '' : rest.slice(cut + 2);
    return { kind: 'mcp', name: tool || server, server, summary: summarizeInput(input) };
  }

  return { kind: 'tool', name, server: '', summary: summarizeInput(input) };
}

function summarizeInput(input) {
  for (const key of SUMMARY_KEYS) {
    if (input?.[key]) return clean(input[key]);
  }
  try {
    return clean(JSON.stringify(input));
  } catch {
    return '';
  }
}

function resultText(content) {
  if (typeof content === 'string') return clean(content, 200);
  if (Array.isArray(content)) {
    return clean(
      content
        .filter((b) => b && b.type === 'text')
        .map((b) => b.text || '')
        .join(' '),
      200
    );
  }
  return '';
}

/** 用户真实输入，用于把执行记录按「回合」分组 */
function extractPrompt(d) {
  if (d.type !== 'user' || d.isMeta) return '';
  const content = d.message?.content;
  let text = '';

  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = content
      .filter((b) => b && b.type === 'text')
      .map((b) => b.text || '')
      .join('\n');
  }
  if (!text) return '';

  const cleaned = cleanPromptText(text);
  return cleaned ? clean(cleaned, 400) : '';
}

/** 找到主转录与它名下的 subagent 转录；找不到返回 [] */
function findSessionFiles(sessionId) {
  let dirs;
  try {
    dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const main = path.join(PROJECTS_DIR, dir.name, `${sessionId}.jsonl`);
    if (!fs.existsSync(main)) continue;

    const files = [{ file: main, project: dir.name, source: 'main', agent: 'main' }];
    const subDir = path.join(PROJECTS_DIR, dir.name, sessionId, 'subagents');
    let subs = [];
    try {
      subs = fs.readdirSync(subDir).filter((name) => name.endsWith('.jsonl'));
    } catch {
      // 没有子代理是正常情况
    }
    for (const name of subs) {
      files.push({
        file: path.join(subDir, name),
        project: dir.name,
        source: 'subagent',
        agent: name.replace(/\.jsonl$/, ''),
      });
    }
    return files;
  }

  return [];
}

function signature(files) {
  return files
    .map((entry) => {
      try {
        const st = fs.statSync(entry.file);
        return `${entry.file}:${st.size}:${st.mtimeMs}`;
      } catch {
        return `${entry.file}:missing`;
      }
    })
    .join('|');
}

/** 只 stat（不解析）主转录与子代理，供项目级缓存判断是否变化 */
export function sessionFileSignature(sessionId) {
  const files = findSessionFiles(sessionId);
  if (!files.length) return 'missing';
  return signature(files);
}

async function parseFile(entry, state) {
  let stream;
  try {
    stream = fs.createReadStream(entry.file, 'utf8');
  } catch {
    return;
  }

  const local = new Map();
  let activePrompt = null;
  let lineNo = 0;
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      lineNo++;
      if (
        !line.includes('tool_use') &&
        !line.includes('tool_result') &&
        !line.includes('"type":"user"') &&
        !line.includes('"type": "user"') &&
        !line.includes('"type":"text"') &&
        !line.includes('"type": "text"')
      ) {
        continue;
      }

      let d;
      try {
        d = JSON.parse(line);
      } catch {
        continue;
      }

      const msg = d.message;
      if (!msg) continue;
      const tsMs = d.timestamp ? Date.parse(d.timestamp) || 0 : 0;
      const sidechain = !!d.isSidechain;

      if (d.type === 'assistant') {
        let assistantText = '';
        if (typeof msg.content === 'string') {
          assistantText = msg.content;
        } else if (Array.isArray(msg.content)) {
          assistantText = msg.content
            .filter((block) => block && block.type === 'text')
            .map((block) => block.text || '')
            .join('\n');
        }
        if (assistantText.trim() && activePrompt) {
          // 同一回合可能有多条助手文本，最后一条即本段最终答复
          activePrompt.resultText = assistantText.replace(/\r/g, '').trim().slice(0, 1600);
        }

        if (!Array.isArray(msg.content)) continue;
        for (let i = 0; i < msg.content.length; i++) {
          const block = msg.content[i];
          if (!block || block.type !== 'tool_use') continue;

          const info = describeTool(block.name, block.input || {});
          const record = {
            order: state.order++,
            ts: tsMs,
            kind: info.kind,
            name: info.name,
            tool: block.name,
            server: info.server,
            summary: info.summary,
            status: 'pending',
            durationMs: null,
            result: '',
            source: entry.source,
            agent: entry.agent,
            sidechain,
          };
          state.records.push(record);
          if (block.id) local.set(block.id, record);
        }
      } else if (d.type === 'user') {
        // 只从主转录取用户指令；子代理的输入通常是任务书，会把页面刷满
        if (entry.source === 'main') {
          const prompt = extractPrompt(d);
          if (prompt) {
            const record = {
              order: state.order++,
              ts: tsMs,
              kind: 'prompt',
              name: '用户',
              tool: '',
              server: '',
              summary: prompt,
              status: 'ok',
              durationMs: null,
              result: '',
              resultText: '',
              source: 'main',
              agent: 'main',
              sidechain,
            };
            state.records.push(record);
            activePrompt = record;
          }
        }

        if (!Array.isArray(msg.content)) continue;
        for (const block of msg.content) {
          if (!block || block.type !== 'tool_result') continue;
          const record = local.get(block.tool_use_id);
          if (!record) continue;
          record.status = block.is_error ? 'error' : 'ok';
          if (tsMs && record.ts) record.durationMs = Math.max(0, tsMs - record.ts);
          record.result = resultText(block.content);
        }
      }
    }
  } finally {
    stream.destroy();
  }
}

function summarize(records, files) {
  const counts = {
    total: records.length,
    executions: 0,
    prompt: 0,
    tool: 0,
    skill: 0,
    mcp: 0,
    error: 0,
    pending: 0,
    history: 0,
    subagent: 0,
  };
  const status = { ok: 0, error: 0, pending: 0 };
  const sources = { main: 0, subagent: 0, history: 0 };
  const toolCounts = new Map();
  let firstAt = 0;
  let lastAt = 0;

  for (const r of records) {
    counts[r.kind] = (counts[r.kind] || 0) + 1;
    if (r.source in sources) sources[r.source]++;

    if (r.kind !== 'prompt') {
      counts.executions++;
      if (r.status in status) status[r.status]++;
      if (r.status === 'error') counts.error++;
      if (r.status === 'pending') counts.pending++;
      if (r.source === 'history') counts.history++;
      if (r.source === 'subagent') counts.subagent++;

      const label = r.kind === 'mcp' ? `${r.server} · ${r.name}` : r.name;
      const prev = toolCounts.get(label) || { name: label, kind: r.kind, count: 0 };
      prev.count++;
      toolCounts.set(label, prev);
    }

    if (r.ts) {
      if (!firstAt || r.ts < firstAt) firstAt = r.ts;
      if (r.ts > lastAt) lastAt = r.ts;
    }
  }

  const topTools = [...toolCounts.values()]
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 6);

  return {
    counts,
    status,
    sources,
    topTools,
    firstAt: firstAt || null,
    lastAt: lastAt || null,
    files: files.filter((f) => f.source === 'main').length,
    subagentFiles: files.filter((f) => f.source === 'subagent').length,
    project: files[0]?.project || '',
  };
}

/** 斜杠命令只存在于输入历史；补进同一个会话的执行记录，按技能名+2 分钟与转录去重 */
function mergeHistory(records, state, sessionId) {
  if (!sessionId) return;
  let events = [];
  try {
    const catalog = loadSkillCatalog();
    events = readSlashSkillEvents(catalog.skills.map((s) => s.name)).events;
  } catch {
    return;
  }

  for (const ev of events) {
    if (ev.sessionId !== sessionId) continue;
    const duplicate = records.some(
      (r) =>
        r.kind === 'skill' &&
        r.name === ev.name &&
        Math.abs((r.ts || 0) - ev.tsMs) <= 2 * 60 * 1000
    );
    if (duplicate) continue;

    records.push({
      order: state.order++,
      ts: ev.tsMs,
      kind: 'skill',
      name: ev.name,
      tool: 'SlashCommand',
      server: '',
      summary: '斜杠命令',
      status: 'ok',
      durationMs: null,
      result: '',
      source: 'history',
      agent: 'main',
      sidechain: false,
    });
  }
}

async function parseSession(files, sessionId) {
  const state = { records: [], order: 0 };
  for (const entry of files) await parseFile(entry, state);
  mergeHistory(state.records, state, sessionId);

  state.records.sort((a, b) => (a.ts || 0) - (b.ts || 0) || a.order - b.order);
  state.records.forEach((record, index) => {
    record.seq = index;
    delete record.order;
  });

  return { records: state.records, ...summarize(state.records, files) };
}

/** 带 mtime/size 签名的内存缓存；同会话翻页不会重复解析大文件 */
export async function loadSessionRecords(sessionId) {
  const files = findSessionFiles(sessionId);
  if (!files.length) return null;

  const sig = signature(files);
  const hit = cache.get(sessionId);
  if (hit && hit.signature === sig) {
    // LRU：命中的挪到末尾
    cache.delete(sessionId);
    cache.set(sessionId, hit);
    return hit.data;
  }

  if (pending.has(sessionId)) return pending.get(sessionId);

  const task = parseSession(files, sessionId)
    .then((data) => {
      data.sessionId = sessionId;
      cache.set(sessionId, { signature: sig, data });
      while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
      return data;
    })
    .finally(() => pending.delete(sessionId));

  pending.set(sessionId, task);
  return task;
}

export function parseLimit(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(n)));
}

export function parseBefore(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

export function sliceRecords(
  data,
  { limit = DEFAULT_LIMIT, before = null, kind = '', status = '', source = '', q = '' } = {}
) {
  const query = String(q || '').trim().toLowerCase();

  const matches = (r) => {
    if (kind && r.kind !== kind) return false;
    if (status && r.status !== status) return false;
    if (source && r.source !== source) return false;
    if (query) {
      const hay = `${r.name} ${r.server} ${r.summary} ${r.tool} ${r.agent}`.toLowerCase();
      if (!hay.includes(query)) return false;
    }
    return true;
  };

  const matchedAll = data.records.filter(matches);
  const pool = before == null ? matchedAll : matchedAll.filter((r) => r.seq < before);
  const page = pool.slice(-limit).reverse();
  const hasMore = pool.length > limit;
  const nextBefore = page.length ? page[page.length - 1].seq : null;

  return {
    sessionId: data.sessionId,
    project: data.project,
    files: data.files,
    subagentFiles: data.subagentFiles,
    counts: data.counts,
    status: data.status,
    sources: data.sources,
    topTools: data.topTools,
    firstAt: data.firstAt,
    lastAt: data.lastAt,
    total: data.records.length,
    matched: matchedAll.length,
    returned: page.length,
    hasMore,
    nextBefore,
    records: page,
  };
}
