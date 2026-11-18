import fs from 'node:fs';
import { HISTORY_FILE } from './config.js';

let cached = { key: '', rows: null };

/** 按 size+mtime 缓存 history.jsonl，避免每个会话/项目重复整读 */
export function readUserPromptHistory() {
  let stat;
  try {
    stat = fs.statSync(HISTORY_FILE);
  } catch {
    return null;
  }

  const key = `${stat.size}:${stat.mtimeMs}`;
  if (cached.key === key) return cached.rows;

  let text;
  try {
    text = fs.readFileSync(HISTORY_FILE, 'utf8');
  } catch {
    return null;
  }

  const rows = [];
  for (const line of text.split('\n')) {
    if (!line || !line.includes('"display"')) continue;
    try {
      const row = JSON.parse(line);
      rows.push({
        display: String(row.display || ''),
        timestamp: Number(row.timestamp) || 0,
        project: String(row.project || ''),
        sessionId: String(row.sessionId || ''),
      });
    } catch {
      // 跳过坏行
    }
  }

  cached = { key, rows };
  return rows;
}

export function historyFileSignature() {
  try {
    const stat = fs.statSync(HISTORY_FILE);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return 'missing';
  }
}

/** 用户输入的清洗与噪声过滤；转录与 history 共用同一套规则 */
export function cleanPromptText(raw) {
  let text = String(raw || '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ')
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/gi, ' ')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/gi, ' ')
    .replace(/<local-command-stderr>[\s\S]*?<\/local-command-stderr>/gi, ' ')
    .replace(/<command-name>([\s\S]*?)<\/command-name>/gi, ' $1 ')
    .replace(/<command-message>([\s\S]*?)<\/command-message>/gi, ' ')
    .replace(/<command-args>([\s\S]*?)<\/command-args>/gi, ' $1 ')
    .trim();

  if (!text) return '';
  if (text.toLowerCase() === 'exit' || text.toLowerCase() === 'clear' || text.toLowerCase() === 'q') {
    return '';
  }
  if (/^\/(exit|clear|config|permissions|plugin|hooks|tasks|new|remote-control|init)\b/i.test(text)) {
    return '';
  }
  if (/^This session is being continued/i.test(text)) return '';
  if (/^Base directory for this skill/i.test(text)) return '';
  if (/^# Environment you have been invoked/i.test(text)) return '';
  if (/^<environment/i.test(text)) return '';
  if (/^\[Request interrupted/i.test(text)) return '';
  return text;
}

/**
 * Claude Code 的斜杠命令不会产生 Skill tool_use：
 * 每条输入记在 ~/.claude/history.jsonl，转写里只有一条带 <command-name> 的 user 消息，
 * 而且转录会被清理。这里用输入历史补齐「用户显式调用技能」这一半。
 *
 * 只统计能精确对上已安装技能名的命令；/clear、/plugin 这类内建命令自然落选。
 */
export function readSlashSkillEvents(skillNames = []) {
  const rows = readUserPromptHistory();
  if (!rows) {
    return { events: [], total: 0, matched: 0, file: HISTORY_FILE, missing: true };
  }

  const exact = new Set(skillNames);
  const bare = new Map();
  for (const name of skillNames) {
    if (!name.includes(':')) continue;
    const short = name.split(':').slice(1).join(':');
    if (!short) continue;
    // 裸名只在全局唯一时才用于匹配，避免把不同插件的同名技能算错
    bare.set(short, bare.has(short) ? null : name);
  }

  function resolve(cmd) {
    if (exact.has(cmd)) return cmd;
    return bare.get(cmd) || null;
  }

  const events = [];
  let total = 0;

  for (const row of rows) {
    const display = row.display.trim();
    if (!display.startsWith('/')) continue;
    total++;

    const m = /^\/([A-Za-z0-9_:-]+)/.exec(display);
    if (!m) continue;
    const name = resolve(m[1]);
    if (!name) continue;

    const tsMs = row.timestamp;
    if (!Number.isFinite(tsMs) || tsMs <= 0) continue;

    events.push({
      name,
      tsMs,
      sessionId: row.sessionId || '',
      project: row.project || '',
    });
  }

  events.sort((a, b) => a.tsMs - b.tsMs);
  return { events, total, matched: events.length, file: HISTORY_FILE, missing: false };
}
