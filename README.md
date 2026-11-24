# Skill Observatory

Claude Code 技能的**可观测层**：实时 tail 会话转录，回答「哪个 skill 被触发了、谁触发的、从哪个项目、花了多少上下文」。

对应调研文档中「痛点四：为什么自动触发了 / 该触发的没触发」。不依赖 OTEL，不修改任何 Claude Code 配置。

## 快速开始

```bash
npm install
npm --prefix web install

# 开发（后端 4317 + Vite 5317，支持 HMR）
npm run dev

# 生产（先构建，再由后端单端口托管）
npm run build
npm start
```

打开 <http://127.0.0.1:4317>（生产）或 <http://127.0.0.1:5317>（开发）。

## 页面

| 路由 | 内容 |
|---|---|
| `/` | 实时看板：KPI、Agent 状态、触发来源、技能排行、活跃度时间线、技能账单、技能目录、MCP 服务器 |
| `/sessions/<sessionId>` | 单个会话的执行记录：时间线 / 表格、回合结果摘要、筛选与搜索 |
| `/projects?cwd=<encodeURIComponent(cwd)>` | 项目历史时间图：跨会话动作、用户指令泳道、会话轨道与定位 |

## 数据来源

直接读取 Claude Code 的会话转录，**零侵入**：

```
~/.claude/projects/<项目哈希>/<sessionId>.jsonl
```

每行是一条消息。我们从中提取：

| 字段 | 用途 |
|---|---|
| `message.content[].type === "tool_use"` | 工具调用与 skill 调用 |
| `tool_use.name === "Skill"` → `input.skill` | skill 名称 |
| `message.usage` | input / output / cache_read tokens |
| `timestamp`, `sessionId`, `cwd` | 时间线、会话、项目归属 |
| user 消息中的 `<command-name>` | 判断是否为用户显式触发 |
| assistant 文本块 | 执行记录页的「本段结果」（取该回合最后一条助手回复的第一段） |
| `<sessionId>/subagents/*.jsonl` | 执行记录页与项目历史中的子代理动作 |

另外读取 `~/.claude/history.jsonl`（输入历史）：

- 斜杠命令**不会产生** `Skill` tool_use，旧转录还会被 Claude Code 清理；
- 能精确匹配已安装技能名的 `/command` 会补记为一次 skill 调用（`/clear`、`/plugin` 等内建命令不计）；
- 同一会话里 2 分钟内与 Skill tool_use 重合的记录会去重，避免同一次调用算两遍；
- 只影响 KPI、触发来源、技能排行与时间线的 skill 计数；时间线的 token/消息、Agent 面板、会话表仍以转录为准。

可用环境变量覆盖：

```bash
CLAUDE_CONFIG_DIR=/path/to/.claude   # 默认 ~/.claude
CLAUDE_HISTORY_PATH=/path/history.jsonl  # 输入历史，默认 ~/.claude/history.jsonl
PORT=4317                             # 后端端口
SCAN_INTERVAL=400                     # 扫描间隔（ms）
TIMELINE_RETENTION_DAYS=90            # 时间线在内存里保留的天数
```

## 实时链路

```
JSONL 文件 ──增量读(字节 offset + 未成行 Buffer)──▶ 解析 ──▶ 内存聚合
                                                          │
                          每 250ms 合批 + 最新快照 ◀──────┘
                                    │
                              WebSocket /ws ──▶ Vue 3 看板
```

- 每个文件记录 `offset` 与未成行的 `Buffer` 尾巴，避免把半行当完整 JSON 解析；
- 文件被截断重写时自动重置 offset；
- 首次启动全量回放历史（只进聚合层，不往前端推历史事件），之后只处理新增字节；
- 端到端延迟约 **0.4–0.65 秒**；
- 每 250ms 的 `events` 帧附带完整快照，但**不包含时间线数组**——时间线按需走 REST，避免长区间把每帧撑到几 MB。

## 刷新与心跳

| 模块 | 频率 |
|---|---|
| JSONL 扫描 | 每 400ms（`SCAN_INTERVAL`） |
| WS 事件合批 | 每 250ms 最多一次；**只有新事件时才推送** |
| 端到端延迟 | 约 0.4–0.65 秒 |
| 看板 KPI / Agent / 会话表 | 跟随事件帧，持续活跃时约 2–3 次/秒 |
| 活跃度时间线（实时区间） | 1 秒；失败后 5 秒重试；历史区间不轮询 |
| MCP 运行状态 | 15 秒轮询，后端进程扫描同周期缓存 |
| 技能账单 / 星图 | 30 秒轮询；有新 skill 调用时最多 20 秒刷新一次 |
| 技能目录 | 页面加载一次（服务端缓存 60 秒） |
| 会话执行记录 | 手动刷新，不自动追加 |
| 项目历史时间图 | 手动刷新；服务端缓存 30 秒 |
| WS 断线重连 | 1 / 2 / 4 / 8 / 15 秒指数退避 |

空闲时没有心跳快照：页面上的「x 秒前」和 Agent 的「执行中 → 空闲」要等下一条事件或手动刷新才会更新。

## 活跃度时间线：可选区间

面板右上角可在「24 小时 / 7 天 / 30 天 / 自定义」之间切换，只影响时间线本身，其他面板仍是实时全量口径。

- `GET /api/timeline?from=<ms>&to=<ms>` 返回按区间聚合、**零填充**后的序列：
  `{ from, to, granularity, buckets, availableFrom, availableTo, truncated, outOfRetention, retentionDays }`；
- 粒度按跨度自动选择（1m/5m/…/12h/1d），保证不超过约 200 个点，前端不再二次聚合；
- 分钟桶按 `TIMELINE_RETENTION_DAYS`（默认 90 天）裁剪，超出窗口的请求会被钳制并返回 `truncated`；
- 所选区间包含「现在」时，时间线随实时事件以约 1 秒一次节流刷新；历史区间不轮询。

## 技能目录：所有已安装 skill

页面底部列出本机全部可调用的 skill（用户技能 + 已启用插件技能），每行包含名称、来源、一句话描述和历史调用次数；**默认按调用次数降序（同分按名称）**，支持按「全部 / 用户 / 插件 / 已调用」筛选，以及按名称或描述搜索。

- `GET /api/skills` 返回 `{ scannedAt, userDir, skills: [{ name, description, source, sourceType, path, tokensLow, tokensHigh, ... }], cost }`，服务端缓存 60 秒；
- 用户技能扫描 `~/.claude/skills/<name>/SKILL.md`（软链会被跟随）；
- 插件技能只扫描 `settings.json → enabledPlugins` 里显式启用、且能在 `installed_plugins.json` 解析到 `installPath` 的插件，目录为 `<installPath>/skills` 与 `<installPath>/.claude/skills`；
- 插件技能按实际调用名加前缀，例如 `ui-ux-pro-max:banner-design`；
- 描述取 `SKILL.md` frontmatter 的 `description`，兼容单行、引号包裹与 `>` / `|` 多行写法；
- 调用次数来自实时快照，含 `history.jsonl` 中匹配已安装技能名的斜杠命令；历史调用过但本机已卸载的 skill 会在面板底部单独列出。

## MCP 服务器：配置与调用次数

与技能目录并列，列出本机配置的所有 MCP 服务器：

- `GET /api/mcp` 返回 `{ scannedAt, statusedAt, configPath, servers: [{ name, key, scope, scopeType, transport, command, url, envKeys, path, status, procCount }] }`；配置缓存 60 秒，运行状态缓存 15 秒；
- 来源三处：`~/.claude.json` 的顶层 `mcpServers`（用户级）、`projects[*].mcpServers`（项目级）、已启用插件根目录的 `.mcp.json`（插件级）；
- 每行显示名称、作用域徽章、传输方式（`stdio` / `http`）、运行状态与启动命令或 URL；
- 运行状态由进程扫描得出：从 `command` / `args` 里取包名或可执行名（跳过 `cmd`、`npx` 等包装器），匹配系统进程命令行；`stdio` 服务器由客户端按会话拉起，所以「配置了」不等于「在跑」；`http` 传输或扫描失败时显示「未知」；
- 进程列表在 Windows 用 PowerShell CIM 查询、其他平台用 `ps`，缓存 15 秒，前端同周期轮询；
- 调用次数来自转录里的 `mcp__<server>__<tool>` 工具名，按服务器聚合（工具数、会话数与最近一次工具在悬浮提示里）；工具调用没有类似 `history.jsonl` 的历史源，旧转录被清理后更早的调用不会计入；
- 历史调用过但已从配置里删除的服务器会在面板底部单独提示。

## 技能账单与星图（近 30 天）

在实时面板与技能目录之间，回答「我为技能描述每轮付了多少、先处理哪几个」。只读，不生成归档/禁用命令。

- **成本**只估算 `SKILL.md` 的 `description`：`low = ascii/4 + cjk/2`、`high = ascii/3 + cjk/1.5`；非 ASCII 非 CJK 字符记录但不计入；per-skill 取整后求和，全局 = per-skill 整数之和。分母不含内置技能、项目技能、MCP 与 `CLAUDE.md`；单位是每次模型请求的上下文占用（prompt cache 会降低计费增量）。
- **候选**三条件：近 30 天调用 0 次 + `tokens_high ≥ 120` + 第二信号（用户任务文本与工具调用摘要里未出现该名）。插件技能另有 30 天试用期（`installed_plugins.json` 的 `installedAt`）；用户技能安装日期未知，不受保护。最多展示 10 个，第 11 名以后只进清单。
- **第二信号是近似**：只扫 watcher 清洗后的用户任务文本与工具调用摘要，不扫原始 JSONL——system prompt / 上下文摘要里含整份技能清单，全文匹配会把所有技能判成「提及」；也不扫助手正文，否则助手推荐一次就会压掉候选。
- **置信度**只看样本量：<20 次事件 `low` / 20–99 `medium` / ≥100 `high`，不代表使用概率。
- **星图**节点圆半径 `0.4·√tokens_high`，面积严格 ∝ 成本；按安装来源分扇区（用户 / 插件）；颜色只分观测/未观测；只标注分组、候选与成本前 10，标签两两不重叠；星图 `aria-hidden`，全部事实由清单表格承载。
- `GET /api/constellation?days=30`（1–90 天）返回判决句、数据质量、候选、清单与未匹配调用，服务端 5 秒缓存。
- **范围**：user + 已启用插件；项目作用域未扫描（本机为 0）。转录里出现但目录里没有的调用（已卸载/内置）在清单下方单列。
- 原始设计见 `../工具可视化/docs/designs/skill-constellation.md`（独立 Bun CLI + 亮色单页）；本看板只采纳星图与决策队列，未实现归档/禁用命令。

## Agent 状态面板：按项目分组

每个会话对应一张 Agent 卡片，卡片直接回答「这个 Agent 现在在干嘛」。面板以项目（`cwd` 末段）分组：

- 组按**最近活动倒序**排列；有活跃 Agent 的项目默认展开，其余折叠；
- 组内活跃 Agent 置顶，其次按最近活动时间倒序；
- 组头吸顶，点击可折叠整组。

卡片信息层：

| 层 | 来源 | 展示 |
|---|---|---|
| 谁 | `agent-name` → `ai-title` → 任务首句，附 `sessionId` 前 6 位 | 卡片标题 |
| 状态 | 未完成 `tool_use` / `stop_reason` / 最后一条消息类型 | 执行中 · 思考中 · 等待输入 · 空闲 |
| 任务 | `last-prompt`，缺失时回退到清洗过的用户输入 | 任务行 |
| 思考 | 最近一条 `thinking` 块 | 思考行（斜体，两行截断） |
| 正在 | 已发出但未收到 `tool_result` 的 `tool_use` | 「正在」行 |
| 刚才 | 最近一次完成的工具调用（`is_error` 标红） | 「刚才」行 |
| 轨迹 | 最近 3 次工具 / skill 调用 | 「轨迹」行 |
| 成本 | `cost-state.totalCostUSD` | 底部 `$` |

状态判定（最近事件超过 `IDLE_MS = 5 分钟` 即为空闲）：

| 状态 | 条件 |
|---|---|
| 执行中 `running` | 存在未返回的 `tool_use` |
| 思考中 `thinking` | 刚收到 `tool_result`，或最后一条 assistant 消息的 `stop_reason` 不是 `end_turn` |
| 等待输入 `waiting` | 最后一条 assistant 消息 `stop_reason === "end_turn"` |
| 空闲 `idle` | 超过 5 分钟无新事件 |

注意：`ai-title` / `agent-name` / `cost-state` 等 meta 行没有 `timestamp`，解析时必须保持时间戳为空，不能回退成 `Date.now()`——否则所有历史会话都会被误判成「刚刚活跃」。

任务文本清洗会移除 `<system-reminder>`、`<task-notification>`、`<local-command-stdout/stderr>` 等系统注入块；含 `call_*` 调用 ID 且带 `output-file` / `task-id` 的残片整行丢弃。

## Agent 执行记录页

点击 Agent 卡片进入 `/sessions/<sessionId>`，查看这次会话的全部执行记录：

- 数据来自主转录 + 该会话的 `subagents/*.jsonl` + `history.jsonl` 中属于该会话的斜杠命令；子代理记录带「子代理」标签，历史命令带「历史」标签。
- 每条工具调用与对应的 `tool_result` 配对，显示成功 / 失败 / 未返回、耗时和结果摘要；Skill 与 MCP 调用单独标记。
- 默认是**时间线视图**：按用户指令分段，段内按时间正序展示动作；每段末尾附「本段结果」，优先取该回合最后一条助手回复的第一段（项目层面的结论/交付），没有可用回复时退回动作描述。动作数与耗时只作为右侧小字元信息，顶部另有「本次指令结果」摘要。每条用户指令的最右侧显示该回合的**总耗时**（从指令到最后一次动作完成），并与「本段结果」右侧的耗时保持同一口径。
- 工具栏下方有一条横向**指令时间线**：每个用户指令是一根无圆角的长方形刻度，按时间分布；下方按时间间隔标注日期/时间。短时间内连续多条指令时保持最小间距并整体压回时间范围，避免方块重叠；指令多、超出可视宽度时默认对齐最新，可横向滚动或点「‹ / ›」查看更早/更晚的指令。悬停显示该指令与对应结果，点击会按需加载更早分页并定位到对应回合。
- 可在工具栏切换到表格视图；两种视图共用筛选与搜索。时间线依靠回合分组与悬停反馈，不加斑马纹；表格视图保留低对比度斑马纹辅助横向扫列。
- 支持「全部 / 工具 / Skill / MCP / 失败 / 子代理 / 用户指令」筛选与名称/摘要搜索，筛选在服务端完成，翻页基于筛选结果。
- 默认加载最近 300 条，可继续「加载更早的记录」；「加载全部」会连续翻页直到取完当前筛选下的所有记录。服务端按文件 mtime/size 缓存解析结果，翻页不会重复解析大文件。
- 接口：`GET /api/sessions/:id/records?limit=300&before=<seq>&kind=&status=&source=&q=`；prompt 记录额外带 `resultText`（该回合最后一条助手回复，前端取第一段作为「本段结果」）。响应顶层还有独立的 `turns` 数组（全部指令 seq/ts/summary/resultText），供顶部横向指令时间线使用，不受分页与筛选影响。
- 页面顶部汇总消息、执行记录、Skill/MCP、失败数、输出 token、成本与最后活动；直接刷新该 URL 也能打开。
- 全局 KPI / MCP 面板仍只统计顶层转录；执行记录页额外包含子代理与历史斜杠命令，因此单会话页的数量可能大于全局口径。

## 项目历史时间图（跨会话）

入口：Agent 项目组头的「历史」按钮，或会话执行记录页的「项目历史（跨会话）→」。页面 URL 为 `/projects?cwd=<encodeURIComponent(cwd)>`。

- **数据**：同一 `cwd` 下所有仍存在于快照里的会话；动作来自 `loadSessionRecords`（含主转录、子代理、历史斜杠命令）；用户指令来自转录 prompt 与 `history.jsonl`。
- **归属规则**：`history.jsonl` 的 `project` 字段会随 shell cwd 漂移，所以先按 `sessionId` 反查 store 会话的 cwd，找不到才回退 `project`。同一编码转录目录下的不同 cwd 不会被合并。
- **图表**：顶部泳道是用户指令（同桶聚合，空心=已清理会话）；下方堆叠柱是 `工具 + 子代理`，右轴两条折线分别是 `Skill` 与 `MCP`（分开轴，避免小数量被压扁）；tooltip 里带失败数与当天指令。
- **会话轨道**：每个会话一行，按“有动作的桶”画实心块，仅有指令的桶画空心块；空窗不画。点击会话或色块会把上方时间轴定位到对应时间并高亮；「打开会话」按钮进入会话详情；history-only 会话只显示、只可定位。
- **粒度**：自动在 `1h / 3h / 6h / 12h / 1d / 1w / 30d / 90d / 365d` 中选择，保证不超过约 120 个桶；两天以内用小时级，两个月以内优先按天。
- **范围**：由数据决定，不补到“今天”；页头显示「数据截至」。统计里的“活跃天”按本地自然日计算，与桶粒度无关。
- `GET /api/projects/history?cwd=<raw>&refresh=1`：返回 `range / granularity / buckets / prompts / sessions / totals / warnings`；服务端 30 秒缓存，`refresh=1` 绕过。
- **边界**：只有 `history.jsonl`、没有任何转录的项目不开放（404）；已清理会话的指令计入总数但不可打开；项目统计与全局 KPI 口径可能不同。

## 指标口径

| 指标 | 定义 |
|---|---|
| Skill 调用 | 转录里的 `Skill` tool_use + `history.jsonl` 中能匹配已安装技能名的斜杠命令（同会话 2 分钟内去重） |
| 触发来源 `user` | 同一会话中上一条用户消息是 `/command`，或来自斜杠命令历史 |
| 触发来源 `proactive` | Claude 自主选择，无斜杠命令上下文 |
| 触发来源 `nested` | 同一条 assistant 消息里的第 2 个及之后的 skill 调用 |
| 缓存命中率 | `cache_read / (input + cache_read)` |
| 活跃会话 | 状态为执行中 / 思考中 / 等待输入（即最近 5 分钟内有事件） |

## 触发来源筛选

点击「触发来源」的图例行或环形扇区，下方「Skill 调用排行」会切换到该来源：按该来源的调用次数排序，只保留次数 >0 的技能；再次点击同一个来源恢复默认总排行。0 次的来源不可选。筛选中时圆环中心显示该来源的调用数，排行柱颜色与来源颜色一致。

## 已知局限

1. **触发来源是启发式的**。Claude Code 转录里没有官方的 `invocation_trigger` 字段；`user` 依赖 `<command-name>` 标记与输入历史，部分斜杠命令会被展开成普通 prompt，因而被归为 `proactive`。要拿到权威值需要开启 OTEL。
2. **斜杠命令与转录的口径不同**。`history.jsonl` 保留已清理会话的输入，因此技能排行/总数可能包含会话表里不存在的会话；去重窗口是「同会话 + 2 分钟」，两次同技能调用间隔小于 2 分钟时可能只算一次。
3. **转录格式非公开 API**，Claude Code 升级后字段可能变化。解析失败的行会被静默跳过，不会中断服务。
4. **无成本换算**。不同模型定价不一，当前只展示 token 原值；后续可加价格表配置。
5. `cache_read` 极高（本机约 98%）是模型侧 prompt cache 的结果，不等于费用节省比例。
6. **时间线按自然日对齐使用服务器本地时区**，前端标签用浏览器本地时区。同机访问时一致；远程浏览器跨时区访问时，日边界可能与标签相差若干小时。
7. 进程重启后从头回放全部 JSONL 才 `listen`，回放期间 `/api/timeline` 不可用（前端仍显示「正在回放会话转录…」）。
8. **WS 没有应用层 ping/pong**：正常停止/断开能触发重连，但中间网络静默断链可能不会立即发现；重连最长等待 15 秒。
9. **空闲页面不会自己跳秒**：没有新事件时不会推送快照，「x 秒前」和 Agent 状态要等下一条事件或手动刷新。
10. **项目历史严格按 cwd 分组**：同一项目如果换过工作目录（例如 `工具可视化` 与 `可视化工具`）会显示成两个项目，不做跨 cwd 合并。

## 后续路线

- [x] **目录层**：扫描 `~/.claude/skills` 与已启用插件，展示全部 skill 的描述与历史调用次数
- [x] **审计层（v1）**：成本估算 + 候选队列 + 星图；Dead / Active / Missing 见清单与未匹配行
- [x] **执行轨迹**：单会话时间线、回合结果摘要、跨会话项目历史时间图与会话轨道
- [ ] **审计层（v2）**：可逆归档命令与恢复清单（当前只读，不生成禁用命令）
- [ ] **路由层**：输入任务描述，按交付物推荐 skill（含 runner-up 与理由）
- [ ] **发现层**：当前项目上下文触发的 skill 缺口提示
- [ ] 成本换算与价格表
- [ ] ECharts 按需引入，压缩 bundle

## 版本管理

仓库已初始化为 Git，默认分支 `main`。`.gitignore` 排除 `node_modules/`、`web/dist/`、`_snap.json`、`*.log` 与系统文件；当前未配置远程仓库，推送前需要先确认。

## 技术栈

- 后端：Node 24 · Express 4 · ws
- 前端：Vue 3.5 · Vite 6 · ECharts 5
- 无数据库，全部内存聚合（重启即重新回放）
