import fs from 'node:fs';
import path from 'node:path';
import { CLAUDE_DIR, PLUGINS_DIR, SKILLS_DIR } from './config.js';

const CACHE_TTL = 60 * 1000;
let cache = null;
let cachedAt = 0;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** 按码点分类统计：ASCII / 中日韩 / 其他（标点、箭头等） */
export function countScripts(text = '') {
  let ascii = 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp < 128) ascii++;
    else if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3040 && cp <= 0x30ff)) cjk++;
    else other++;
  }
  return { ascii, cjk, other };
}

/** 设计文档的估算器：给出精确到小数的区间 */
export function estimateTokens({ ascii = 0, cjk = 0 } = {}) {
  return { low: ascii / 4 + cjk / 2, high: ascii / 3 + cjk / 1.5 };
}

/** per-skill 成本：存储时取整，保证「全局 = per-skill 之和」可复算 */
export function costOfSkill(description = '') {
  const { ascii, cjk, other } = countScripts(description);
  const { low, high } = estimateTokens({ ascii, cjk });
  return {
    asciiChars: ascii,
    cjkChars: cjk,
    otherChars: other,
    descChars: ascii + cjk + other,
    tokensLow: Math.round(low),
    tokensHigh: Math.round(high),
  };
}

export function sumCost(skills = []) {
  let tokensLow = 0;
  let tokensHigh = 0;
  let asciiChars = 0;
  let cjkChars = 0;
  let otherChars = 0;

  for (const s of skills) {
    tokensLow += s.tokensLow || 0;
    tokensHigh += s.tokensHigh || 0;
    asciiChars += s.asciiChars || 0;
    cjkChars += s.cjkChars || 0;
    otherChars += s.otherChars || 0;
  }

  return {
    skills: skills.length,
    tokensLow,
    tokensHigh,
    asciiChars,
    cjkChars,
    otherChars,
    estimator: 'low=ascii/4+cjk/2; high=ascii/3+cjk/1.5',
    // 其他字符（标点、箭头等）不参与估算，显式记录以便对账
    otherCharsTokenRate: 0,
    denominator: '仅 user + plugin 的 SKILL.md description；不含内置技能、项目技能、MCP 与 CLAUDE.md',
    unit: '每次模型请求的上下文占用估算；prompt cache 会降低计费增量',
    rounding: 'per-skill Math.round；全局 = per-skill 整数之和',
  };
}

/**
 * 只解析 frontmatter 里的 name / description，避免为了两个字段引入 YAML 依赖。
 * 支持单行、引号包裹和 `>` / `|` 多行写法。
 */
export function parseFrontmatter(text) {
  const src = stripBom(text);
  if (!src.startsWith('---')) return {};
  const end = src.indexOf('\n---', 3);
  if (end === -1) return {};

  const out = {};
  let key = null;
  let buf = [];

  const flush = () => {
    if (key && buf.length) out[key] = buf.join(' ').replace(/\s+/g, ' ').trim();
    key = null;
    buf = [];
  };

  // CRLF 文件里 end 指向 \n，正文末尾会残留一个 \r；不剥掉它，(.*)$ 就匹配不到行尾
  for (const raw of src.slice(3, end).replace(/\r$/, '').split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(raw);
    if (m) {
      flush();
      key = m[1];
      const value = m[2].trim();
      buf = value && !/^[|>][+-]?$/.test(value) ? [value] : [];
      continue;
    }
    if (key && /^\s+\S/.test(raw)) buf.push(raw.trim());
  }
  flush();

  for (const k of ['name', 'description']) {
    if (typeof out[k] === 'string') out[k] = out[k].replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

function readSkill(root, dirName, meta) {
  const file = path.join(root, dirName, 'SKILL.md');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const fm = parseFrontmatter(text);
  const rawName = (fm.name || dirName).trim();
  const description = (fm.description || '').trim();

  return {
    name: meta.plugin ? `${meta.plugin}:${rawName}` : rawName,
    description,
    source: meta.source,
    sourceType: meta.sourceType,
    path: file,
    dirName,
    scope: meta.scope,
    plugin: meta.plugin || null,
    installedAt: meta.installedAt || null,
    installEvidence: meta.installedAt ? 'plugin_metadata' : 'unknown',
    ...costOfSkill(description),
  };
}

function scanDir(root, meta) {
  let entries;
  try {
    entries = fs.readdirSync(root);
  } catch {
    return [];
  }
  const out = [];
  for (const dirName of entries) {
    // existsSync 会跟随符号链接，~/.claude/skills 里有一部分是指向 ~/.agents/skills 的软链
    if (!fs.existsSync(path.join(root, dirName, 'SKILL.md'))) continue;
    const item = readSkill(root, dirName, meta);
    if (item) out.push(item);
  }
  return out;
}

/** 只读取 settings.json 里显式启用的插件，避免把 marketplace 缓存里的历史版本全扫进来 */
function enabledPlugins() {
  const settings = readJson(path.join(CLAUDE_DIR, 'settings.json'), {});
  const installed = readJson(path.join(PLUGINS_DIR, 'installed_plugins.json'), {});
  const out = [];

  for (const [id, on] of Object.entries(settings.enabledPlugins || {})) {
    if (!on) continue;
    const recs = installed.plugins?.[id];
    const rec = Array.isArray(recs) ? recs[0] : recs;
    if (!rec?.installPath) continue;
    out.push({
      id,
      name: id.split('@')[0],
      installPath: rec.installPath,
      installedAt: rec.installedAt || null,
    });
  }
  return out;
}

export function loadSkillCatalog({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache && now - cachedAt < CACHE_TTL) return cache;

  const skills = scanDir(SKILLS_DIR, { source: '用户', sourceType: 'user', scope: 'user' });

  for (const plugin of enabledPlugins()) {
    const meta = {
      source: `插件 · ${plugin.name}`,
      sourceType: 'plugin',
      scope: 'plugin',
      plugin: plugin.name,
      installedAt: plugin.installedAt,
    };
    for (const root of [
      path.join(plugin.installPath, 'skills'),
      path.join(plugin.installPath, '.claude', 'skills'),
    ]) {
      skills.push(...scanDir(root, meta));
    }
  }

  const seen = new Set();
  const unique = [];
  for (const skill of skills) {
    if (seen.has(skill.name)) continue;
    seen.add(skill.name);
    unique.push(skill);
  }
  unique.sort((a, b) => {
    if (a.sourceType !== b.sourceType) return a.sourceType === 'user' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  cache = { scannedAt: now, userDir: SKILLS_DIR, skills: unique, cost: sumCost(unique) };
  cachedAt = now;
  return cache;
}
