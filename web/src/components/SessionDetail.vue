<template>
  <section class="session-page">
    <div class="page-head">
      <div class="head-actions">
        <button type="button" class="back" @click="$emit('back')">← 返回看板</button>
        <button
          v-if="session?.cwd"
          type="button"
          class="project-link"
          @click="$emit('open-project', session.cwd)"
        >
          项目历史（跨会话）→
        </button>
      </div>

      <div class="title-row">
        <h2 :title="title">{{ title }}</h2>
        <span v-if="session" class="status" :class="session.status">{{ statusLabel }}</span>
        <code class="sid">{{ sessionId }}</code>
      </div>

      <div class="sub">
        <span>{{ projectLabel }}</span>
        <span v-if="session?.model">{{ shortModel(session.model) }}</span>
        <span v-if="session?.cwd" :title="session.cwd">{{ shortPath(session.cwd) }}</span>
        <span class="conn" :class="{ on: connected }">{{ connected ? '实时连接' : '重连中' }}</span>
      </div>

      <div class="stats">
        <div class="stat"><b>{{ session?.messages ?? '—' }}</b><span>消息</span></div>
        <div class="stat"><b>{{ counts.executions }}</b><span>执行记录</span></div>
        <div class="stat"><b>{{ counts.skill }}</b><span>Skill</span></div>
        <div class="stat"><b>{{ counts.mcp }}</b><span>MCP</span></div>
        <div class="stat"><b class="err">{{ counts.error }}</b><span>失败</span></div>
        <div class="stat"><b>{{ session ? compact(session.output) : '—' }}</b><span>输出 token</span></div>
        <div class="stat"><b>{{ costText }}</b><span>成本</span></div>
        <div class="stat"><b>{{ relative(session?.lastEventAt || data?.lastAt) }}</b><span>最后活动</span></div>
      </div>

      <div v-if="latestTurn && !isFiltered" class="latest-result">
        <span class="lr-label">本次指令结果</span>
        <span class="lr-text">{{ latestTurn.summary.description }}</span>
        <span v-if="session && session.status !== 'idle'" class="lr-live">进行中</span>
        <span class="lr-meta">{{ latestTurn.summary.metrics }}</span>
      </div>
    </div>

    <article class="panel records-panel">
      <header class="panel-head">
        <div class="panel-title">执行记录 <span class="count">{{ counts.executions }}</span></div>
        <span class="hint">
          工具 {{ counts.tool }} · Skill {{ counts.skill }}
          <template v-if="counts.mcp"> · MCP {{ counts.mcp }}</template>
          <template v-if="counts.prompt"> · 用户指令 {{ counts.prompt }}</template>
          <template v-if="counts.history"> · 历史命令 {{ counts.history }}</template>
          <template v-if="data?.subagentFiles"> · 子代理 {{ data.subagentFiles }} 份</template>
        </span>
        <button type="button" class="refresh" :disabled="loading" @click="load()">刷新</button>
      </header>

      <div v-if="data" class="overview">
        <div class="ratio">
          <div class="ratio-bar" :title="`成功 ${statusCounts.ok} · 失败 ${statusCounts.error} · 未返回 ${statusCounts.pending}`">
            <span class="ok" :style="{ flex: statusCounts.ok }"></span>
            <span class="bad" :style="{ flex: statusCounts.error }"></span>
            <span class="pending" :style="{ flex: statusCounts.pending }"></span>
          </div>
          <div class="ratio-text">
            <span><i class="dot ok"></i>成功 {{ statusCounts.ok }}</span>
            <span><i class="dot bad"></i>失败 {{ statusCounts.error }}</span>
            <span><i class="dot pending"></i>未返回 {{ statusCounts.pending }}</span>
            <span class="muted">共 {{ counts.executions }} 次执行</span>
          </div>
        </div>

        <div class="top-tools">
          <span class="ov-label">全量最常见</span>
          <span v-for="t in data.topTools" :key="`${t.kind}-${t.name}`" class="tool-chip" :class="t.kind">
            {{ t.name }} <b>{{ t.count }}</b>
          </span>
        </div>
      </div>

      <div class="toolbar">
        <div class="filters" role="group" aria-label="筛选执行记录">
          <button
            v-for="f in FILTERS"
            :key="f.key"
            type="button"
            :class="{ active: filter === f.key }"
            :aria-pressed="filter === f.key"
            @click="setFilter(f.key)"
          >
            {{ f.label }}
          </button>
        </div>
        <input
          v-model="query"
          type="search"
          class="search"
          placeholder="搜索名称或摘要"
          aria-label="搜索执行记录"
          @input="onSearchInput"
        />
        <div class="view-switch" role="group" aria-label="展示方式">
          <button type="button" :class="{ active: view === 'timeline' }" @click="view = 'timeline'">
            时间线
          </button>
          <button type="button" :class="{ active: view === 'table' }" @click="view = 'table'">
            表格
          </button>
        </div>

        <span v-if="isFiltered" class="hint filter-hint">
          筛选结果 {{ data?.matched ?? 0 }} / {{ counts.total }}
        </span>
      </div>

      <div v-if="loading" class="state">正在解析会话转录…</div>
      <div v-else-if="error && !records.length" class="state">
        {{ error }}
        <button type="button" class="retry" @click="load()">重试</button>
      </div>

      <template v-else-if="records.length">
        <div v-if="view === 'timeline'" class="timeline-wrap">
          <section
            v-for="(group, gi) in timelineGroups"
            :key="group.key"
            class="turn"
            :class="{ latest: gi === 0 && !isFiltered }"
          >
            <div v-if="group.prompt" class="turn-prompt">
              <span class="t-dot"></span>
              <span class="t-time mono">{{ timeLabel(group.prompt.ts) }}</span>
              <span class="t-badge">用户指令</span>
              <p class="t-text" :title="group.prompt.summary">{{ group.prompt.summary }}</p>
            </div>
            <div v-else class="turn-prompt muted">
              <span class="t-dot"></span>
              <span class="t-time mono">{{ group.actions[0] ? timeLabel(group.actions[0].ts) : '' }}</span>
              <span class="t-badge muted">更早的动作</span>
            </div>

            <div class="turn-actions">
              <div
                v-for="r in group.actions"
                :key="r.seq"
                class="action-row"
                :class="{ failed: r.status === 'error' }"
              >
                <span class="a-dot" :class="r.kind"></span>
                <span class="a-time mono">{{ timeShort(r.ts) }}</span>
                <span class="a-kind" :class="r.kind">{{ kindLabel(r) }}</span>
                <span v-if="r.source === 'subagent'" class="a-src" :title="r.agent">子代理</span>
                <span v-if="r.source === 'history'" class="a-src">历史</span>
                <code class="a-name">{{ r.server ? `${r.server} · ` : '' }}{{ r.name }}</code>
                <span class="a-summary" :title="r.summary">{{ r.summary || '—' }}</span>
                <span class="a-status" :class="r.status">{{ statusText(r) }}</span>
                <span class="a-dur mono">{{ fmtDuration(r.durationMs) }}</span>
              </div>
            </div>

            <div class="turn-summary">
              <span class="ts-label">本段结果</span>
              <span class="ts-text">{{ group.summary.description }}</span>
              <span class="ts-metrics">{{ group.summary.metrics }}</span>
            </div>
          </section>
        </div>

        <div v-else class="table-wrap">
          <table>
            <caption>
              会话的全部工具与 Skill 执行记录；默认按用户指令分组、组内按时间正序，筛选时按时间倒序。一次加载
              {{ PAGE }} 条。
            </caption>
            <thead>
              <tr>
                <th scope="col">时间</th>
                <th scope="col">类型</th>
                <th scope="col">名称</th>
                <th scope="col">摘要</th>
                <th scope="col">状态</th>
                <th scope="col" class="num">耗时</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="r in displayRows"
                :key="r.seq"
                :class="{ failed: r.status === 'error', 'prompt-row': r.kind === 'prompt' }"
              >
                <td v-if="r.kind === 'prompt'" colspan="6" class="prompt-cell">
                  <div class="prompt-line">
                    <span class="p-badge">用户指令</span>
                    <span class="p-time mono">{{ timeLabel(r.ts) }}</span>
                    <span class="p-text" :title="r.summary">{{ r.summary }}</span>
                  </div>
                </td>

                <template v-else>
                  <td class="time mono">{{ timeLabel(r.ts) }}</td>
                  <td class="kind-cell">
                    <span class="kind" :class="r.kind">{{ kindLabel(r) }}</span>
                    <span v-if="r.source === 'subagent'" class="src" :title="r.agent">子代理</span>
                    <span v-if="r.source === 'history'" class="src">历史</span>
                  </td>
                  <td class="name">
                    <code v-if="r.server" class="server">{{ r.server }} ·</code>
                    <code>{{ r.name }}</code>
                  </td>
                  <td class="summary" :title="r.summary">{{ r.summary || '—' }}</td>
                  <td><span class="rec-status" :class="r.status">{{ statusText(r) }}</span></td>
                  <td class="num mono">{{ fmtDuration(r.durationMs) }}</td>
                </template>
              </tr>
            </tbody>
          </table>
        </div>

        <footer class="rec-foot">
          <span v-if="isFiltered">已显示 {{ records.length }} / {{ data?.matched ?? 0 }}（全量 {{ counts.total }}）</span>
          <span v-else>
            已显示 {{ records.length }} / {{ counts.total }}
            <template v-if="counts.prompt">（含 {{ counts.prompt }} 条用户指令）</template>
          </span>
          <button
            v-if="data?.hasMore"
            type="button"
            class="more"
            :disabled="loadingMore"
            @click="load({ more: true })"
          >
            {{ loadingMore ? '加载中…' : '加载更早的记录' }}
          </button>
          <span v-else class="muted">已到最早</span>
          <span v-if="error" class="warn">{{ error }}</span>
        </footer>
      </template>

      <div v-else class="state">
        {{ isFiltered ? '没有匹配的执行记录' : '这次会话没有工具或 Skill 调用记录' }}
      </div>
    </article>
  </section>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { compact, duration, relative } from '../lib/format.js';

const PAGE = 300;

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'tool', label: '工具' },
  { key: 'skill', label: 'Skill' },
  { key: 'mcp', label: 'MCP' },
  { key: 'error', label: '失败' },
  { key: 'subagent', label: '子代理' },
  { key: 'prompt', label: '用户指令' },
];

const props = defineProps({
  sessionId: { type: String, required: true },
  session: { type: Object, default: null },
  connected: Boolean,
});

const emit = defineEmits(['back', 'open-project']);

const data = ref(null);
const records = ref([]);
const loading = ref(true);
const loadingMore = ref(false);
const error = ref('');
const filter = ref('all');
const query = ref('');
const view = ref('timeline');

let ctrl = null;
let seq = 0;
let disposed = false;
let searchTimer = null;

const counts = computed(
  () =>
    data.value?.counts || {
      total: 0,
      tool: 0,
      skill: 0,
      mcp: 0,
      error: 0,
      pending: 0,
      history: 0,
      subagent: 0,
    }
);

const isFiltered = computed(
  () => filter.value !== 'all' || query.value.trim().length > 0
);
const statusCounts = computed(
  () => data.value?.status || { ok: 0, error: 0, pending: 0 }
);

/** 默认把用户指令当作分隔符，让每条工具调用都落在具体任务下面 */
const displayRows = computed(() => {
  if (isFiltered.value) return records.value;

  const hasPrompt = records.value.some((r) => r.kind === 'prompt');
  if (!hasPrompt) return records.value;

  // records 是新→旧；每遇到一条用户指令，前面的动作就属于该回合
  const groups = [];
  let bucket = [];
  for (const record of records.value) {
    if (record.kind === 'prompt') {
      groups.push({ prompt: record, tools: bucket });
      bucket = [];
    } else {
      bucket.push(record);
    }
  }
  if (bucket.length) groups.push({ prompt: null, tools: bucket });

  const rows = [];
  for (const group of groups) {
    if (group.prompt) rows.push(group.prompt);
    rows.push(...group.tools.slice().reverse()); // 回合内按时间正序
  }
  return rows;
});

function baseName(filePath) {
  const parts = String(filePath || '').replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || String(filePath || '');
}

function summarizeActions(actions) {
  if (!actions.length) {
    return { description: '这段没有工具或 Skill 调用。', metrics: '0 个动作' };
  }

  let subagent = 0;
  let errors = 0;
  let first = 0;
  let last = 0;

  const modified = new Set();
  const read = new Set();
  const toolCounts = new Map();

  for (const action of actions) {
    if (action.source === 'subagent') subagent++;
    if (action.status === 'error') errors++;
    if (['Edit', 'Write', 'MultiEdit'].includes(action.name) && action.summary) {
      modified.add(action.summary);
    }
    if (action.name === 'Read' && action.summary) read.add(action.summary);
    toolCounts.set(action.name, (toolCounts.get(action.name) || 0) + 1);
    if (action.ts) {
      first = first ? Math.min(first, action.ts) : action.ts;
      last = Math.max(last, action.ts);
    }
  }

  const modifiedNames = [...new Set([...modified].map(baseName))];
  const readNames = [...new Set([...read].map(baseName))];
  const commands = actions
    .filter((action) => action.name === 'Bash' && action.summary)
    .map((action) => action.summary);
  const skillNames = [...new Set(actions.filter((a) => a.kind === 'skill').map((a) => a.name))];
  const usedBrowser = actions.some((a) => a.server === 'chrome-devtools');

  const did = [];
  if (modifiedNames.length) {
    did.push(
      `修改了 ${modifiedNames.slice(0, 3).join('、')}${modifiedNames.length > 3 ? ' 等文件' : ''}`
    );
  }
  if (readNames.length && !modifiedNames.length) {
    did.push(`阅读了 ${readNames.slice(0, 3).join('、')}${readNames.length > 3 ? ' 等文件' : ''}`);
  }

  const built = commands.some((c) => /build|构建/i.test(c));
  const tested = commands.some((c) => /test|测试/i.test(c));
  const started = commands.some((c) => /npm start|node server|server.*start|start.*server|启动服务/i.test(c));
  const checkedApi = commands.some((c) => /curl|接口|health|\bapi\b/i.test(c));
  const git = commands.some((c) => /\bgit\b/i.test(c));

  if (built) did.push('构建了前端');
  if (tested) did.push('运行了测试');
  if (started) did.push('启动/检查了本地服务');
  if (checkedApi) did.push('验证了接口');
  if (git) did.push('查看了 Git 状态');
  if (commands.length && !built && !tested && !started && !checkedApi && !git) {
    did.push(`执行了命令「${commands[0].slice(0, 40)}」`);
  }

  if (usedBrowser) did.push('在浏览器中检查/操作了页面');
  if (skillNames.length) did.push(`调用了 Skill：${skillNames.slice(0, 2).join('、')}`);
  if (subagent) did.push('派发了子代理任务');
  if (errors) did.push(`其中有 ${errors} 次调用失败`);

  const top = [...toolCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([name, count]) => `${name}×${count}`)
    .join(' · ');

  const duration = first ? last - first : 0;
  return {
    description: did.length
      ? `这次主要做了：${did.join('；')}。`
      : '完成了一组工具调用，具体过程见下方时间线。',
    metrics: [`${actions.length} 个动作`, duration ? fmtDuration(duration) : '', top]
      .filter(Boolean)
      .join(' · '),
  };
}

function resultExcerpt(text, limit = 200) {
  const cleaned = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\r/g, '');

  const lines = cleaned
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  // 取第一段非标题/列表/引用/表格的正文，最终答复的第一段通常是结果概述
  let first =
    lines.find((line) => !/^(#{1,6}\s|>|\||[-*+]\s|\d+\.\s)/.test(line)) || lines[0] || '';

  first = first
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();

  return first.length > limit ? `${first.slice(0, limit - 1)}…` : first;
}

function makeTurn(prompt, actionsDesc) {
  const actions = actionsDesc.slice().reverse(); // records 是新→旧，回合内按时间正序
  const summary = summarizeActions(actions);
  const excerpt = prompt?.resultText ? resultExcerpt(prompt.resultText) : '';
  if (excerpt.length >= 4) summary.description = excerpt;
  return {
    key: prompt ? `prompt-${prompt.seq}` : `tail-${actionsDesc[0]?.seq ?? 'empty'}`,
    prompt,
    actions,
    summary,
  };
}

const timelineGroups = computed(() => {
  const groups = [];
  let bucket = [];
  for (const record of records.value) {
    if (record.kind === 'prompt') {
      groups.push(makeTurn(record, bucket));
      bucket = [];
    } else {
      bucket.push(record);
    }
  }
  if (bucket.length) groups.push(makeTurn(null, bucket));
  return groups;
});

const latestTurn = computed(() => {
  if (isFiltered.value) return null;
  return timelineGroups.value.find((group) => group.prompt) || null;
});

const title = computed(() => {
  const s = props.session;
  return (
    s?.aiTitle ||
    s?.agentName ||
    s?.title ||
    s?.task ||
    `会话 ${props.sessionId.slice(0, 8)}`
  );
});

const projectLabel = computed(() => {
  const cwd = props.session?.cwd;
  if (cwd) {
    const parts = String(cwd).replace(/\\/g, '/').split('/').filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  const raw = data.value?.project || '';
  return raw ? raw.replace(/^[A-Z]--/, '').replace(/-+/g, '·') || raw : '—';
});

const statusLabel = computed(() => {
  const map = { running: '执行中', thinking: '思考中', waiting: '等待输入', idle: '空闲' };
  return map[props.session?.status] || '未知';
});

const costText = computed(() => {
  const usd = props.session?.cost;
  if (usd == null) return '—';
  if (usd >= 100) return `$${Math.round(usd)}`;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(3)}`;
});

async function readError(res) {
  try {
    const json = await res.json();
    return json.error || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

async function load({ more = false } = {}) {
  if (disposed) return;
  if (more && !data.value?.hasMore) return;

  const mySeq = ++seq;
  ctrl?.abort();
  ctrl = new AbortController();

  if (more) loadingMore.value = true;
  else {
    loading.value = true;
    loadingMore.value = false;
    error.value = '';
  }

  try {
    const params = new URLSearchParams({ limit: String(PAGE) });
    if (more && data.value?.nextBefore != null) {
      params.set('before', String(data.value.nextBefore));
    }
    if (['tool', 'skill', 'mcp', 'prompt'].includes(filter.value)) {
      params.set('kind', filter.value);
    } else if (filter.value === 'error') {
      params.set('status', 'error');
    } else if (filter.value === 'subagent') {
      params.set('source', 'subagent');
    }
    const q = query.value.trim();
    if (q) params.set('q', q);
    const res = await fetch(
      `/api/sessions/${encodeURIComponent(props.sessionId)}/records?${params}`,
      { signal: ctrl.signal }
    );
    if (!res.ok) throw new Error(await readError(res));
    const json = await res.json();
    if (mySeq !== seq || disposed) return;

    if (more) {
      const seen = new Set(records.value.map((r) => r.seq));
      records.value = [...records.value, ...json.records.filter((r) => !seen.has(r.seq))];
    } else {
      records.value = json.records;
    }

    data.value = { ...json, returned: records.value.length };
    error.value = '';
  } catch (err) {
    if (err.name === 'AbortError' || mySeq !== seq || disposed) return;
    error.value = more ? '加载更早的记录失败' : err.message || '执行记录加载失败';
  } finally {
    if (mySeq === seq && !disposed) {
      if (!more) loading.value = false;
      loadingMore.value = false;
    }
  }
}

function setFilter(key) {
  if (filter.value === key) return;
  clearTimeout(searchTimer);
  filter.value = key;
  load();
}

function onSearchInput() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => load(), 300);
}

watch(
  () => props.sessionId,
  () => {
    records.value = [];
    data.value = null;
    error.value = '';
    filter.value = 'all';
    query.value = '';
    load();
  }
);

function onKeydown(event) {
  if (event.key === 'Escape') emit('back');
}

onMounted(() => {
  load();
  window.addEventListener('keydown', onKeydown);
});

onUnmounted(() => {
  disposed = true;
  clearTimeout(searchTimer);
  ctrl?.abort();
  window.removeEventListener('keydown', onKeydown);
});

function shortModel(model) {
  return String(model).replace(/^claude-/, '').slice(0, 22);
}

function shortPath(cwd) {
  const parts = String(cwd).replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length <= 2) return cwd;
  return `…/${parts.slice(-2).join('/')}`;
}

function kindLabel(record) {
  if (record.kind === 'skill') return 'Skill';
  if (record.kind === 'mcp') return 'MCP';
  return '工具';
}

function statusText(record) {
  if (record.source === 'history') return '已执行';
  if (record.status === 'error') return '失败';
  if (record.status === 'pending') return '未返回';
  return '成功';
}

function fmtDuration(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return duration(ms);
}

function timeLabel(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function timeShort(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
</script>

<style scoped>
.session-page {
  height: calc(100vh - 110px);
  min-height: 520px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.page-head {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.back,
.project-link {
  align-self: flex-start;
  appearance: none;
  border: 1px solid var(--line);
  background: rgba(148, 163, 184, 0.06);
  color: var(--text-2);
  font: inherit;
  font-size: 11px;
  padding: 4px 10px;
  border-radius: 7px;
  cursor: pointer;
}

.back:hover {
  color: var(--text-1);
  border-color: rgba(94, 234, 212, 0.35);
}

.project-link {
  color: #5eead4;
  border-color: rgba(94, 234, 212, 0.3);
}

.project-link:hover {
  color: #99f6e4;
  border-color: rgba(94, 234, 212, 0.55);
}

.title-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.title-row h2 {
  margin: 0;
  font-size: 20px;
  line-height: 1.3;
  font-weight: 650;
  color: var(--text-1);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status {
  font-size: 10.5px;
  font-weight: 600;
  padding: 2px 9px;
  border-radius: 99px;
  border: 1px solid var(--line);
  color: var(--text-3);
}

.status.running {
  color: #6ee7b7;
  border-color: rgba(52, 211, 153, 0.4);
  background: rgba(52, 211, 153, 0.08);
}

.status.thinking {
  color: #c4b5fd;
  border-color: rgba(167, 139, 250, 0.4);
  background: rgba(167, 139, 250, 0.08);
}

.status.waiting {
  color: #7dd3fc;
  border-color: rgba(56, 189, 248, 0.4);
  background: rgba(56, 189, 248, 0.08);
}

.sid {
  font-family: ui-monospace, 'SF Mono', 'Cascadia Code', monospace;
  font-size: 10.5px;
  color: var(--text-3);
  background: rgba(148, 163, 184, 0.07);
  padding: 2px 7px;
  border-radius: 5px;
}

.sub {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  font-size: 11px;
  color: var(--text-3);
}

.conn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.conn.on {
  color: #6ee7b7;
}

.stats {
  display: grid;
  grid-template-columns: repeat(8, minmax(0, 1fr));
  gap: 10px;
  margin-top: 4px;
}

.stat {
  padding: 9px 12px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: rgba(148, 163, 184, 0.035);
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.stat b {
  font-family: ui-monospace, 'SF Mono', 'Cascadia Code', monospace;
  font-size: 16px;
  font-variant-numeric: tabular-nums;
  color: var(--text-1);
  font-weight: 650;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.stat b.err {
  color: #fca5a5;
}

.stat span {
  font-size: 10px;
  color: var(--text-3);
}

.records-panel {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.records-panel .panel-head {
  align-items: center;
}

.count {
  font-size: 10.5px;
  font-weight: 500;
  color: var(--text-3);
  background: rgba(148, 163, 184, 0.1);
  padding: 1px 6px;
  border-radius: 99px;
}

.latest-result {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 10px;
  padding: 9px 12px;
  border: 1px solid rgba(94, 234, 212, 0.24);
  border-radius: 9px;
  background: rgba(94, 234, 212, 0.045);
}

.lr-label {
  font-size: 10.5px;
  font-weight: 600;
  color: #5eead4;
  white-space: nowrap;
}

.lr-text {
  font-size: 11.5px;
  color: var(--text-1);
  min-width: 0;
}

.lr-live {
  font-size: 10px;
  color: #fbbf24;
}

.lr-meta {
  margin-left: auto;
  font-size: 10px;
  color: var(--text-3);
}

.view-switch {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: 9px;
  background: rgba(148, 163, 184, 0.07);
}

.view-switch button {
  appearance: none;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-3);
  font: inherit;
  font-size: 11px;
  line-height: 1;
  padding: 4px 9px;
  min-height: 25px;
  border-radius: 7px;
  cursor: pointer;
}

.view-switch button.active {
  color: var(--text-1);
  background: rgba(94, 234, 212, 0.14);
  border-color: rgba(94, 234, 212, 0.45);
}

.timeline-wrap {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 14px 18px 16px;
}

.turn {
  position: relative;
  margin: 0 0 18px 10px;
  padding-left: 20px;
  border-left: 1px solid rgba(148, 163, 184, 0.16);
}

.turn:last-child {
  margin-bottom: 0;
}

.turn-prompt {
  position: relative;
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 8px;
  padding: 0 0 8px;
}

.t-dot {
  position: absolute;
  left: -26px;
  top: 5px;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: #5eead4;
  box-shadow: 0 0 8px rgba(94, 234, 212, 0.7);
}

.turn-prompt.muted .t-dot {
  background: #64748b;
  box-shadow: none;
}

.t-time {
  font-size: 10px;
  color: var(--text-3);
}

.t-badge {
  font-size: 9.5px;
  color: #6ee7b7;
  border: 1px solid rgba(52, 211, 153, 0.35);
  border-radius: 99px;
  padding: 1px 7px;
}

.t-badge.muted {
  color: var(--text-3);
  border-color: var(--line);
}

.t-text {
  flex: 1 1 100%;
  margin: 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--text-1);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.turn-actions {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.action-row {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 8px;
  padding: 4px 8px;
  border-radius: 6px;
  font-size: 11px;
}

.action-row:hover {
  background: rgba(148, 163, 184, 0.04);
}

.action-row.failed {
  background: rgba(248, 113, 113, 0.045);
}

.a-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #64748b;
  flex: 0 0 auto;
}

.a-dot.skill {
  background: #5eead4;
}

.a-dot.mcp {
  background: #a78bfa;
}

.a-time {
  font-size: 9.5px;
  color: var(--text-3);
  flex: 0 0 auto;
}

.a-kind {
  font-size: 9px;
  color: var(--text-3);
  border: 1px solid var(--line);
  border-radius: 99px;
  padding: 0 6px;
  flex: 0 0 auto;
}

.a-kind.skill {
  color: #6ee7b7;
  border-color: rgba(52, 211, 153, 0.3);
}

.a-kind.mcp {
  color: #c4b5fd;
  border-color: rgba(167, 139, 250, 0.3);
}

.a-src {
  font-size: 9px;
  color: var(--text-3);
  border: 1px dashed rgba(148, 163, 184, 0.3);
  border-radius: 4px;
  padding: 0 4px;
}

.a-name {
  font-family: ui-monospace, 'SF Mono', 'Cascadia Code', monospace;
  color: var(--text-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 220px;
}

.a-summary {
  flex: 1 1 180px;
  min-width: 0;
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.a-status {
  font-size: 10px;
  color: #6ee7b7;
  flex: 0 0 auto;
}

.a-status.error {
  color: #fca5a5;
}

.a-status.pending {
  color: #fbbf24;
}

.a-dur {
  font-size: 9.5px;
  color: var(--text-3);
  flex: 0 0 auto;
}

.turn-summary {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 7px;
  padding: 7px 10px;
  border: 1px dashed rgba(148, 163, 184, 0.18);
  border-radius: 7px;
  background: rgba(148, 163, 184, 0.035);
}

.turn.latest .turn-summary {
  border-color: rgba(94, 234, 212, 0.28);
  background: rgba(94, 234, 212, 0.035);
}

.ts-label {
  font-size: 10px;
  font-weight: 600;
  color: #5eead4;
  white-space: nowrap;
}

.ts-text {
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--text-1);
  min-width: 0;
}

.ts-metrics {
  margin-left: auto;
  font-size: 10px;
  color: var(--text-3);
}

.overview {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--line);
}

.ratio-bar {
  display: flex;
  height: 6px;
  margin-bottom: 7px;
  border-radius: 99px;
  overflow: hidden;
  background: rgba(148, 163, 184, 0.12);
}

.ratio-bar .ok {
  background: #34d399;
}

.ratio-bar .bad {
  background: #f87171;
}

.ratio-bar .pending {
  background: #fbbf24;
}

.ratio-text {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  font-size: 10.5px;
  color: var(--text-3);
}

.dot {
  display: inline-block;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  margin-right: 4px;
  vertical-align: 1px;
}

.dot.ok {
  background: #34d399;
}

.dot.bad {
  background: #f87171;
}

.dot.pending {
  background: #fbbf24;
}

.top-tools {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 10.5px;
}

.ov-label {
  color: var(--text-3);
}

.tool-chip {
  font-family: ui-monospace, 'SF Mono', 'Cascadia Code', monospace;
  font-size: 10px;
  color: var(--text-2);
  border: 1px solid var(--line);
  border-radius: 99px;
  padding: 1px 8px;
  background: rgba(148, 163, 184, 0.05);
  white-space: nowrap;
}

.tool-chip b {
  color: var(--text-1);
  font-weight: 600;
  margin-left: 3px;
}

.tool-chip.mcp {
  color: #c4b5fd;
  border-color: rgba(167, 139, 250, 0.3);
  background: rgba(167, 139, 250, 0.06);
}

.tool-chip.skill {
  color: #6ee7b7;
  border-color: rgba(52, 211, 153, 0.3);
  background: rgba(52, 211, 153, 0.06);
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 8px 14px;
  border-bottom: 1px solid var(--line);
}

.filters {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: 9px;
  background: rgba(148, 163, 184, 0.07);
  flex-wrap: wrap;
}

.filters button {
  appearance: none;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-3);
  font: inherit;
  font-size: 11px;
  line-height: 1;
  padding: 4px 8px;
  min-height: 25px;
  border-radius: 7px;
  cursor: pointer;
}

.filters button:hover {
  color: var(--text-2);
}

.filters button.active {
  color: var(--text-1);
  background: rgba(94, 234, 212, 0.14);
  border-color: rgba(94, 234, 212, 0.45);
}

.filters button:focus-visible {
  outline: 2px solid rgba(94, 234, 212, 0.6);
  outline-offset: 1px;
}

.search {
  width: 190px;
  background: rgba(148, 163, 184, 0.07);
  border: 1px solid var(--line);
  border-radius: 7px;
  color: var(--text-1);
  font: inherit;
  font-size: 11px;
  padding: 4px 9px;
  min-height: 25px;
}

.search::placeholder {
  color: var(--text-3);
}

.search:focus {
  outline: none;
  border-color: rgba(94, 234, 212, 0.45);
}

.filter-hint {
  margin-left: auto;
}

.refresh,
.more,
.retry {
  appearance: none;
  border: 1px solid var(--line);
  background: rgba(148, 163, 184, 0.06);
  color: var(--text-2);
  font: inherit;
  font-size: 11px;
  padding: 4px 10px;
  border-radius: 7px;
  cursor: pointer;
  white-space: nowrap;
}

.refresh {
  margin-left: auto;
}

.refresh:hover,
.more:hover,
.retry:hover {
  color: var(--text-1);
  border-color: rgba(94, 234, 212, 0.35);
}

.refresh:disabled,
.more:disabled {
  opacity: 0.45;
  cursor: default;
}

.table-wrap {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  font-size: 11.5px;
}

th:nth-child(1) { width: 112px; }
th:nth-child(2) { width: 104px; }
th:nth-child(3) { width: 30%; }
th:nth-child(5) { width: 82px; }
th:nth-child(6) { width: 82px; }

caption {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}

thead th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: #0d121b;
  text-align: left;
  font-weight: 600;
  color: var(--text-3);
  font-size: 10.5px;
  letter-spacing: 0.03em;
  padding: 7px 12px;
  border-bottom: 1px solid var(--line);
  white-space: nowrap;
}

th.num,
td.num {
  text-align: right;
}

tbody td {
  padding: 6px 12px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.06);
  color: var(--text-2);
  vertical-align: middle;
}

tbody tr:hover {
  background: rgba(148, 163, 184, 0.04);
}

tbody tr.failed {
  background: rgba(248, 113, 113, 0.045);
}

tbody tr.prompt-row td {
  padding: 8px 12px;
  background: rgba(94, 234, 212, 0.035);
  border-top: 1px solid rgba(94, 234, 212, 0.14);
  border-bottom: 1px solid rgba(94, 234, 212, 0.14);
}

.prompt-line {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}

.p-badge {
  flex: 0 0 auto;
  font-size: 9.5px;
  color: #6ee7b7;
  border: 1px solid rgba(52, 211, 153, 0.35);
  border-radius: 99px;
  padding: 1px 7px;
}

.p-time {
  flex: 0 0 auto;
  font-size: 10px;
  color: var(--text-3);
}

.p-text {
  min-width: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-1);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.mono {
  font-family: ui-monospace, 'SF Mono', 'Cascadia Code', monospace;
  font-variant-numeric: tabular-nums;
}

.time {
  color: var(--text-3);
  white-space: nowrap;
}

.kind-cell {
  white-space: nowrap;
}

.kind {
  display: inline-block;
  font-size: 9.5px;
  line-height: 1.5;
  padding: 1px 7px;
  border-radius: 99px;
  border: 1px solid var(--line);
  color: var(--text-3);
}

.kind.skill {
  color: #6ee7b7;
  border-color: rgba(52, 211, 153, 0.35);
  background: rgba(52, 211, 153, 0.07);
}

.kind.mcp {
  color: #c4b5fd;
  border-color: rgba(167, 139, 250, 0.35);
  background: rgba(167, 139, 250, 0.07);
}

.src {
  margin-left: 4px;
  font-size: 9px;
  color: var(--text-3);
  border: 1px dashed rgba(148, 163, 184, 0.3);
  border-radius: 4px;
  padding: 0 4px;
}

.name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.name code {
  font-family: ui-monospace, 'SF Mono', 'Cascadia Code', monospace;
  color: var(--text-1);
}

.name .server {
  color: var(--text-3);
  margin-right: 4px;
}

.summary {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-2);
}

.rec-status {
  font-size: 10px;
  white-space: nowrap;
}

.rec-status.ok {
  color: #6ee7b7;
}

.rec-status.error {
  color: #fca5a5;
}

.rec-status.pending {
  color: #fbbf24;
}

.rec-foot {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 8px 14px;
  border-top: 1px solid var(--line);
  font-size: 10.5px;
  color: var(--text-3);
}

.muted {
  color: var(--text-3);
}

.warn {
  color: #fca5a5;
}

.state {
  flex: 1;
  display: grid;
  place-content: center;
  gap: 8px;
  min-height: 220px;
  color: var(--text-3);
  font-size: 12px;
}

@media (max-width: 1100px) {
  .stats {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }

  .session-page {
    height: auto;
    min-height: auto;
  }

  .records-panel {
    height: auto;
  }

  .table-wrap {
    max-height: 60vh;
    overflow: auto;
  }

  table {
    min-width: 820px;
  }
}
</style>
