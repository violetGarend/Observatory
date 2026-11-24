import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { PORT, PROJECTS_DIR, CLAUDE_DIR } from './config.js';
import { loadSkillCatalog } from './skills.js';
import { annotateStatuses, loadMcpCatalog } from './mcp.js';
import { MAX_DAYS, buildConstellation, parseDays } from './constellation.js';
import { readSlashSkillEvents } from './history.js';
import { loadSessionRecords, parseBefore, parseLimit, sliceRecords } from './sessions.js';
import { buildProjectHistory } from './projectHistory.js';
import { Store } from './store.js';
import { Watcher } from './watcher.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const store = new Store();
const watcher = new Watcher(store);

const app = express();

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    claudeDir: CLAUDE_DIR,
    projectsDir: PROJECTS_DIR,
    projectsDirExists: fs.existsSync(PROJECTS_DIR),
    uptime: process.uptime(),
  });
});

app.get('/api/snapshot', (_req, res) => {
  res.json(store.snapshot());
});

// 本机已安装的 skill 目录（用户技能 + 已启用插件），60 秒缓存
app.get('/api/skills', (_req, res) => {
  res.json(loadSkillCatalog());
});

// 本机配置的 MCP 服务器（用户 / 项目 / 已启用插件），60 秒缓存；运行状态 15 秒缓存
app.get('/api/mcp', async (_req, res) => {
  try {
    const catalog = loadMcpCatalog();
    const servers = await annotateStatuses(catalog.servers);
    res.json({ ...catalog, servers, statusedAt: Date.now() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 项目历史：同一 cwd 下所有会话的动作、用户指令与会话轨道
app.get('/api/projects/history', async (req, res) => {
  const cwd = typeof req.query.cwd === 'string' ? req.query.cwd.trim() : '';
  if (!cwd || cwd.length > 512 || /[\u0000-\u001f]/.test(cwd)) {
    return res.status(400).json({ error: 'cwd 必须是长度 1–512 的路径' });
  }

  try {
    const data = await buildProjectHistory({
      cwd,
      store,
      refresh: req.query.refresh === '1',
    });
    if (!data) return res.status(404).json({ error: '找不到该项目的会话' });
    res.set('Cache-Control', 'no-store').json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 单个会话的全部工具 / Skill 执行记录（含 subagent 转录，按需解析并缓存）
app.get('/api/sessions/:id/records', async (req, res) => {
  const id = String(req.params.id || '');
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) {
    return res.status(400).json({ error: '非法 sessionId' });
  }

  const limit = parseLimit(req.query.limit);
  const before = req.query.before == null ? null : parseBefore(req.query.before);
  if (req.query.before != null && before === null) {
    return res.status(400).json({ error: 'before 必须是非负整数' });
  }

  const kind = ['tool', 'skill', 'mcp', 'prompt'].includes(req.query.kind) ? req.query.kind : '';
  const status = ['ok', 'error', 'pending'].includes(req.query.status) ? req.query.status : '';
  const source = ['main', 'subagent', 'history'].includes(req.query.source) ? req.query.source : '';
  const q = String(req.query.q || '').slice(0, 120);

  try {
    const data = await loadSessionRecords(id);
    if (!data) return res.status(404).json({ error: '找不到该会话的转录' });
    res
      .set('Cache-Control', 'no-store')
      .json(sliceRecords(data, { limit, before, kind, status, source, q }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 技能账单：成本估算 + 30 天候选队列 + 星图数据（只读）
let constellationCache = { key: '', at: 0, data: null };
app.get('/api/constellation', (req, res) => {
  const days = parseDays(req.query.days);
  if (!days) {
    return res.status(400).json({ error: `days 必须是 1–${MAX_DAYS} 的整数` });
  }
  try {
    const catalog = loadSkillCatalog();
    const key = `${days}|${catalog.scannedAt}|${store.lastEventAt}`;
    if (constellationCache.key === key && Date.now() - constellationCache.at < 5000) {
      return res.set('Cache-Control', 'no-store').json(constellationCache.data);
    }
    const data = buildConstellation({ catalog, store, days });
    constellationCache = { key, at: Date.now(), data };
    res.set('Cache-Control', 'no-store').json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 时间线按区间查询：from/to 均为毫秒时间戳
app.get('/api/timeline', (req, res) => {
  const from = Number(req.query.from);
  const to = Number(req.query.to);
  if (!req.query.from || !req.query.to || !Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
    return res.status(400).json({ error: 'from/to 必须是毫秒时间戳，且 from < to' });
  }
  res.json(store.timelineRange(from, to));
});

// 生产模式：托管构建产物
const distDir = path.resolve(__dirname, '../web/dist');
const hasDist = fs.existsSync(path.join(distDir, 'index.html'));
if (hasDist) {
  app.use(express.static(distDir));
  app.get('*', (_req, res) => res.sendFile(path.join(distDir, 'index.html')));
} else {
  app.get('/', (_req, res) => {
    res.type('html').send(
      '<pre style="font:14px/1.6 monospace;padding:32px">前端尚未构建。\n开发模式：npm run dev\n生产构建：npm run build && npm start</pre>'
    );
  });
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(payload) {
  const data = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  }
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'snapshot', data: store.snapshot() }));
});

// ---- 事件批量推送（250ms 合批，避免高频 tool_use 打爆前端）----
let pending = [];
let flushTimer = null;

function compact(event) {
  return {
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
    toolCalls: event.toolCalls.slice(0, 4),
  };
}

function flush() {
  flushTimer = null;
  if (!pending.length) return;
  const events = pending;
  pending = [];
  broadcast({ type: 'events', data: events, snapshot: store.snapshot() });
}

watcher.on('event', (event) => {
  pending.push(compact(event));
  if (!flushTimer) flushTimer = setTimeout(flush, 250);
});

watcher.on('error', (err) => {
  console.error('[watcher]', err.message);
});

// 提及跟踪名单必须在回放前固定：只跟踪高成本技能，回放后新装的名字不补历史
const bootCatalog = loadSkillCatalog({ force: true });
store.setMentionTargets(
  bootCatalog.skills
    .filter((s) => s.tokensHigh >= 120)
    .sort((a, b) => b.tokensHigh - a.tokensHigh)
    .map((s) => s.name)
);

watcher.start();
// 回放会读入所有历史 JSONL，这里统一裁掉保留窗口以外的桶
store.pruneTimeline();

// 斜杠命令不产生 Skill tool_use，用输入历史补齐；同一次调用会按会话+2 分钟去重
const slash = readSlashSkillEvents(bootCatalog.skills.map((s) => s.name));
const slashAdded = store.ingestSlashSkills(slash.events);
console.log(
  slash.missing
    ? '  斜杠命令: 未找到 history.jsonl，仅统计 Skill 工具调用'
    : `  斜杠命令: ${slash.matched} 条匹配已安装技能，补记 ${slashAdded} 次调用`
);

server.listen(PORT, '127.0.0.1', () => {
  const s = store.snapshot();
  console.log(`\n  观星台 Observatory 已启动`);
  console.log(`  → http://127.0.0.1:${PORT}`);
  console.log(`  数据源: ${PROJECTS_DIR}`);
  console.log(
    `  已回放 ${s.totals.messages.toLocaleString()} 条消息 / ${s.sessionsTotal} 个会话 / ${s.totals.skillCalls} 次 skill 调用`
  );
  const mention = store.mentionTrackingInfo();
  if (mention.enabled) {
    console.log(`  提及跟踪: ${mention.trackedNames} 个高成本技能 / ${mention.scanMs}ms`);
  }
  console.log(`  ${hasDist ? '静态托管: web/dist' : '前端未构建（npm run dev 开发）'}\n`);
});

function shutdown() {
  watcher.stop();
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
