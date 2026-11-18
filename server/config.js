import os from 'node:os';
import path from 'node:path';

/** Claude Code 配置根目录。可用 CLAUDE_CONFIG_DIR 覆盖。 */
export const CLAUDE_DIR =
  process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

/** 会话转录目录：<projects>/<项目哈希>/<sessionId>.jsonl */
export const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

/** skill 安装目录 */
export const SKILLS_DIR = path.join(CLAUDE_DIR, 'skills');

/** 插件目录（插件自带 skill 的来源之一） */
export const PLUGINS_DIR = path.join(CLAUDE_DIR, 'plugins');

/** Claude Code 全局配置文件，MCP 服务器与按项目的覆盖项都在这里 */
export const CLAUDE_JSON = process.env.CLAUDE_JSON_PATH || path.join(path.dirname(CLAUDE_DIR), '.claude.json');

/** 输入历史：斜杠命令不产生 Skill tool_use，需要从这里补记 */
export const HISTORY_FILE =
  process.env.CLAUDE_HISTORY_PATH || path.join(CLAUDE_DIR, 'history.jsonl');

export const PORT = Number(process.env.PORT || 4317);

/** 扫描间隔，毫秒。同时决定“实时”的理论延迟上限。 */
export const SCAN_INTERVAL = Number(process.env.SCAN_INTERVAL || 400);

/** 时间线在内存中保留的天数（分钟桶）。自定义区间不能早于该窗口。 */
export const TIMELINE_RETENTION_DAYS = Number(process.env.TIMELINE_RETENTION_DAYS || 90);
