import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CLAUDE_DIR, CLAUDE_JSON, PLUGINS_DIR } from './config.js';

const execFileAsync = promisify(execFile);

const CACHE_TTL = 60 * 1000;
const PROC_TTL = 15 * 1000;
let cache = null;
let cachedAt = 0;
let procCache = { at: 0, lines: [] };
let procPending = null;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** 工具名里的服务器前缀：mcp__<server>__<tool>，与配置名做归一化后比较 */
export function normalizeServer(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function describe(cfg) {
  const transport = cfg.type || (cfg.url ? 'http' : 'stdio');
  const args = Array.isArray(cfg.args) ? cfg.args : [];
  return {
    transport,
    command: cfg.url ? '' : [cfg.command, ...args].filter(Boolean).join(' '),
    url: cfg.url || '',
    envKeys: Object.keys(cfg.env || {}),
  };
}

/** 启动命令里的通用词：拿它们去匹配进程等于匹配一切 */
const WRAPPERS = new Set([
  'cmd',
  'cmd.exe',
  'powershell',
  'powershell.exe',
  'pwsh',
  'node',
  'node.exe',
  'npx',
  'npx.cmd',
  'npm',
  'npm.cmd',
  'yarn',
  'pnpm',
  'bunx',
  'env',
  'sh',
  'bash',
]);
const GENERIC = new Set(['mcp', 'server', 'start', 'run', 'main', 'index', 'bin', 'dist']);

/** 从配置的 command/args 里挑出能标识进程的包名或可执行名 */
function matchTokens(cfg) {
  const parts = [cfg.command, ...(Array.isArray(cfg.args) ? cfg.args : [])]
    .filter(Boolean)
    .map(String);
  const tokens = [];

  for (const raw of parts) {
    const part = raw.trim();
    // 跳过命令行开关（-y / --yes / cmd 的 /c）
    if (!part || part.startsWith('-') || part.startsWith('/')) continue;
    if (WRAPPERS.has(part.toLowerCase())) continue;

    // chrome-devtools-mcp@latest / rea-agents@6.7.0 去掉版本后缀
    let token = part.replace(/@(latest|\d[^/\\]*)$/, '');
    if (!token.startsWith('@')) token = token.split(/[\\/]/).pop().replace(/\.(cmd|exe|js|mjs|cjs)$/, '');
    if (token.length < 3 || GENERIC.has(token.toLowerCase())) continue;
    if (!tokens.includes(token)) tokens.push(token);
  }
  return tokens;
}

function addServer(out, seen, name, cfg, scope, scopeType, extra = {}) {
  if (!name || !cfg || typeof cfg !== 'object') return;
  const key = `${normalizeServer(name)}|${scope}`;
  if (seen.has(key)) return;
  seen.add(key);
  out.push({
    name,
    key: normalizeServer(name),
    scope,
    scopeType,
    ...describe(cfg),
    match: matchTokens(cfg),
    ...extra,
  });
}

/** 只读取已启用插件自带的 MCP 定义（插件根目录的 .mcp.json） */
function pluginServers(out, seen) {
  const settings = readJson(path.join(CLAUDE_DIR, 'settings.json'), {});
  const installed = readJson(path.join(PLUGINS_DIR, 'installed_plugins.json'), {});
  for (const [id, on] of Object.entries(settings.enabledPlugins || {})) {
    if (!on) continue;
    const recs = installed.plugins?.[id];
    const rec = Array.isArray(recs) ? recs[0] : recs;
    if (!rec?.installPath) continue;
    const manifest = readJson(path.join(rec.installPath, '.mcp.json'), null);
    const servers = manifest?.mcpServers || {};
    const plugin = id.split('@')[0];
    for (const [name, cfg] of Object.entries(servers)) {
      addServer(out, seen, name, cfg, `插件 · ${plugin}`, 'plugin', { path: rec.installPath });
    }
  }
}

export function loadMcpCatalog({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache && now - cachedAt < CACHE_TTL) return cache;

  const config = readJson(CLAUDE_JSON, {});
  const out = [];
  const seen = new Set();

  for (const [name, cfg] of Object.entries(config.mcpServers || {})) {
    addServer(out, seen, name, cfg, '用户', 'user', { path: CLAUDE_JSON });
  }

  // 项目级配置存在 ~/.claude.json 的 projects[路径].mcpServers 下
  for (const [projectPath, proj] of Object.entries(config.projects || {})) {
    const servers = proj?.mcpServers;
    if (!servers || typeof servers !== 'object') continue;
    const label = path.basename(projectPath) || projectPath;
    for (const [name, cfg] of Object.entries(servers)) {
      addServer(out, seen, name, cfg, `项目 · ${label}`, 'project', { path: projectPath });
    }
  }

  pluginServers(out, seen);

  const order = { user: 0, project: 1, plugin: 2 };
  out.sort((a, b) => {
    if (order[a.scopeType] !== order[b.scopeType]) return order[a.scopeType] - order[b.scopeType];
    return a.name.localeCompare(b.name);
  });

  cache = { scannedAt: now, configPath: CLAUDE_JSON, servers: out };
  cachedAt = now;
  return cache;
}

/**
 * 进程命令行列表。stdio 型 MCP 由客户端按会话拉起，所以「配置了」不等于「在跑」。
 * PowerShell CIM 查询约 0.5 秒，缓存 15 秒并合并并发请求。
 */
async function processCommands() {
  const now = Date.now();
  if (now - procCache.at < PROC_TTL) return procCache.lines;
  if (procPending) return procPending;

  procPending = (async () => {
    try {
      let lines;
      if (process.platform === 'win32') {
        const script =
          '[Console]::OutputEncoding=[Text.Encoding]::UTF8; ' +
          'Get-CimInstance Win32_Process | Where-Object { $_.CommandLine } | ' +
          'Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress';
        const { stdout } = await execFileAsync(
          'powershell',
          ['-NoProfile', '-NonInteractive', '-Command', script],
          { timeout: 8000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }
        );
        const parsed = JSON.parse(stdout.replace(/^﻿/, ''));
        const arr = Array.isArray(parsed) ? parsed : [parsed];
        lines = arr.map((p) => p.CommandLine).filter(Boolean);
      } else {
        const { stdout } = await execFileAsync('ps', ['-eo', 'args'], {
          timeout: 8000,
          maxBuffer: 8 * 1024 * 1024,
        });
        lines = stdout.split('\n').slice(1).filter(Boolean);
      }
      procCache = { at: Date.now(), lines };
      return lines;
    } catch {
      // 扫描失败时返回 null，让前端区分「没在跑」与「查不到」
      procCache = { at: Date.now(), lines: null };
      return null;
    } finally {
      procPending = null;
    }
  })();

  return procPending;
}

/** 给配置列表补上运行状态：running / stopped / unknown */
export async function annotateStatuses(servers) {
  const procs = await processCommands();
  const lower = procs ? procs.map((p) => p.toLowerCase()) : null;

  return servers.map((sv) => {
    if (sv.transport !== 'stdio') return { ...sv, status: 'unknown', procCount: null };
    if (!lower) return { ...sv, status: 'unknown', procCount: null };

    const tokens = (sv.match || []).map((t) => t.toLowerCase()).filter((t) => t.length >= 3);
    const hits = tokens.length
      ? lower.filter((line) => tokens.some((t) => line.includes(t))).length
      : 0;
    return { ...sv, status: hits > 0 ? 'running' : 'stopped', procCount: hits };
  });
}
