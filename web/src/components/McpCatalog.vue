<template>
  <section class="panel mcp-panel">
    <header class="panel-head">
      <div class="panel-title">
        MCP 服务器
        <span v-if="catalog" class="count">{{ countText }}</span>
      </div>

      <div class="controls">
        <input
          v-model="query"
          type="search"
          class="search"
          placeholder="搜索名称或命令"
          aria-label="搜索 MCP 服务器"
        />
        <div class="filters" role="group" aria-label="筛选 MCP 服务器">
          <button
            v-for="f in FILTERS"
            :key="f.key"
            type="button"
            :class="{ active: filter === f.key }"
            :aria-pressed="filter === f.key"
            @click="filter = f.key"
          >
            {{ f.label }}
          </button>
        </div>
      </div>
    </header>

    <div class="mcp-body">
      <div v-if="loading" class="state">加载 MCP 配置…</div>
      <div v-else-if="error" class="state">
        {{ error }}
        <button type="button" class="retry" @click="load">重试</button>
      </div>
      <div v-else-if="!list.length" class="state">
        {{ total ? '没有匹配的服务器' : '未配置 MCP 服务器' }}
      </div>
      <ul v-else class="mcp-list">
        <li v-for="sv in list" :key="sv.name + sv.scope" class="mcp-row">
          <div class="mcp-top">
            <code class="mcp-name" :title="sv.path || sv.name">{{ sv.name }}</code>
            <span class="mcp-scope" :class="sv.scopeType">{{ sv.scope }}</span>
            <span class="mcp-transport">{{ sv.transport }}</span>
            <span class="mcp-status" :class="sv.status" :title="statusTitle(sv)">
              <span class="dot"></span>{{ statusText(sv) }}
            </span>
            <span class="mcp-use" :class="{ zero: !callsOf(sv) }" :title="useTitle(sv)">
              {{ callsOf(sv) ? `${callsOf(sv)} 次` : '未调用' }}
            </span>
          </div>
          <div class="mcp-cmd" :title="sv.command || sv.url || ''">
            {{ sv.command || sv.url || '—' }}
          </div>
        </li>
      </ul>
    </div>

    <p class="mcp-note">
      调用次数来自转录里的 mcp__ 工具调用；更早的转录被清理后不再计入。
    </p>

    <p v-if="missing.length" class="mcp-foot">
      历史调用中另有 {{ missing.length }} 个未配置：{{ missingNames }}
    </p>
  </section>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';

const props = defineProps({
  usage: { type: Array, default: () => [] },
});

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'user', label: '用户' },
  { key: 'project', label: '项目' },
  { key: 'running', label: '运行中' },
  { key: 'used', label: '已调用' },
];

const STATUS_TEXT = { running: '运行中', stopped: '未运行', unknown: '未知' };

const catalog = ref(null);
const loading = ref(true);
const error = ref('');
const query = ref('');
const filter = ref('all');

let ctrl = null;
let disposed = false;

const usageMap = computed(() => new Map((props.usage || []).map((u) => [u.server, u])));
const total = computed(() => catalog.value?.servers.length || 0);

function usageOf(sv) {
  return usageMap.value.get(sv.key) || usageMap.value.get(sv.name) || null;
}

function callsOf(sv) {
  return usageOf(sv)?.calls || 0;
}

function statusText(sv) {
  return STATUS_TEXT[sv.status] || '未知';
}

function statusTitle(sv) {
  if (sv.status === 'running') return `检测到 ${sv.procCount} 个相关进程`;
  if (sv.status === 'stopped') return '未检测到进程（stdio 服务器由客户端按会话拉起）';
  return '非 stdio 传输或进程列表不可用';
}

function useTitle(sv) {
  const u = usageOf(sv);
  if (!u) return '';
  const parts = [`${u.calls} 次调用 · ${u.tools} 个工具 · ${u.sessions} 个会话`];
  if (u.lastTool) parts.push(`最近：${u.lastTool}`);
  return parts.join('\n');
}

const list = computed(() => {
  let items = catalog.value?.servers || [];
  if (filter.value === 'user') items = items.filter((s) => s.scopeType === 'user');
  if (filter.value === 'project') items = items.filter((s) => s.scopeType === 'project');
  if (filter.value === 'running') items = items.filter((s) => s.status === 'running');
  if (filter.value === 'used') items = items.filter((s) => callsOf(s) > 0);

  const q = query.value.trim().toLowerCase();
  if (q) {
    items = items.filter((s) =>
      [s.name, s.scope, s.command, s.url].some((v) => (v || '').toLowerCase().includes(q))
    );
  }
  return items;
});

const countText = computed(() =>
  list.value.length === total.value ? total.value : `${list.value.length} / ${total.value}`
);

const missing = computed(() => {
  const known = new Set((catalog.value?.servers || []).flatMap((s) => [s.key, s.name]));
  return (props.usage || []).filter((u) => !known.has(u.server)).sort((a, b) => b.calls - a.calls);
});

const missingNames = computed(() => {
  const names = missing.value.map((m) => m.server);
  return names.length > 4 ? `${names.slice(0, 4).join('、')} 等` : names.join('、');
});

async function load({ silent = false } = {}) {
  ctrl?.abort();
  ctrl = new AbortController();
  if (!silent) {
    loading.value = true;
    error.value = '';
  }
  try {
    const res = await fetch('/api/mcp', { signal: ctrl.signal });
    if (!res.ok) throw new Error(`mcp ${res.status}`);
    catalog.value = await res.json();
    error.value = '';
  } catch (err) {
    if (err.name === 'AbortError' || disposed || silent) return;
    error.value = 'MCP 配置加载失败';
  } finally {
    if (!disposed && !silent) loading.value = false;
  }
}

// 运行状态来自进程扫描，15 秒轮询一次即可（与后端缓存同周期）
const POLL_MS = 15000;
let timer = null;

onMounted(() => {
  load();
  timer = setInterval(() => load({ silent: true }), POLL_MS);
});

onUnmounted(() => {
  disposed = true;
  clearInterval(timer);
  ctrl?.abort();
});
</script>

<style scoped>
.mcp-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.mcp-panel .panel-head {
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}

.count {
  font-size: 10.5px;
  font-weight: 500;
  color: var(--text-3);
  background: rgba(148, 163, 184, 0.1);
  padding: 1px 6px;
  border-radius: 99px;
}

.controls {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.search {
  width: 180px;
  background: rgba(148, 163, 184, 0.07);
  border: 1px solid var(--line);
  border-radius: 7px;
  color: var(--text-1);
  font: inherit;
  font-size: 11px;
  padding: 5px 9px;
  min-height: 26px;
}

.search::placeholder {
  color: var(--text-3);
}

.search:focus {
  outline: none;
  border-color: rgba(56, 189, 248, 0.45);
}

.filters {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: 9px;
  background: rgba(148, 163, 184, 0.07);
}

.filters button {
  appearance: none;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-3);
  font: inherit;
  font-size: 11px;
  line-height: 1;
  padding: 4px 9px;
  min-height: 26px;
  border-radius: 7px;
  cursor: pointer;
}

.filters button:hover {
  color: var(--text-2);
}

.filters button.active {
  color: var(--text-1);
  background: rgba(56, 189, 248, 0.14);
  border-color: rgba(56, 189, 248, 0.45);
}

.filters button:focus-visible {
  outline: 2px solid rgba(56, 189, 248, 0.6);
  outline-offset: 1px;
}

.mcp-body {
  flex: 1;
  min-height: 0;
  max-height: 440px;
  overflow-y: auto;
}

.mcp-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.mcp-row {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 9px 14px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.07);
}

.mcp-row:last-child {
  border-bottom: 0;
}

.mcp-row:hover {
  background: rgba(148, 163, 184, 0.04);
}

.mcp-top {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.mcp-name {
  font-family: ui-monospace, 'SF Mono', 'Cascadia Code', monospace;
  font-size: 11.5px;
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}

.mcp-scope {
  font-size: 10px;
  color: var(--text-3);
  background: rgba(148, 163, 184, 0.07);
  padding: 2px 7px;
  border-radius: 99px;
  white-space: nowrap;
}

.mcp-scope.project {
  color: #7dd3fc;
  background: rgba(56, 189, 248, 0.12);
}

.mcp-scope.plugin {
  color: #c4b5fd;
  background: rgba(167, 139, 250, 0.12);
}

.mcp-transport {
  font-size: 10px;
  color: var(--text-3);
  border: 1px solid var(--line);
  padding: 1px 6px;
  border-radius: 99px;
}

.mcp-status {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  color: var(--text-3);
  white-space: nowrap;
}

.mcp-status .dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #64748b;
}

.mcp-status.running {
  color: #6ee7b7;
}

.mcp-status.running .dot {
  background: #34d399;
  box-shadow: 0 0 6px rgba(52, 211, 153, 0.8);
}

.mcp-status.unknown {
  opacity: 0.75;
}

.mcp-use {
  margin-left: auto;
  font-family: ui-monospace, 'SF Mono', 'Cascadia Code', monospace;
  font-size: 10.5px;
  color: #5eead4;
  white-space: nowrap;
}

.mcp-use.zero {
  color: var(--text-3);
}

.mcp-cmd {
  font-family: ui-monospace, 'SF Mono', 'Cascadia Code', monospace;
  font-size: 10.5px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.state {
  display: grid;
  place-content: center;
  gap: 8px;
  min-height: 120px;
  color: var(--text-3);
  font-size: 12px;
}

.retry {
  appearance: none;
  border: 1px solid var(--line);
  background: rgba(148, 163, 184, 0.07);
  color: var(--text-2);
  font: inherit;
  font-size: 11px;
  padding: 4px 10px;
  border-radius: 7px;
  cursor: pointer;
  justify-self: center;
}

.mcp-note {
  margin: 0;
  padding: 8px 14px 4px;
  border-top: 1px solid var(--line);
  font-size: 10.5px;
  color: var(--text-3);
  line-height: 1.5;
}

.mcp-foot {
  margin: 0;
  padding: 8px 14px 10px;
  border-top: 1px solid var(--line);
  font-size: 10.5px;
  color: var(--text-3);
  line-height: 1.5;
}

.mcp-note + .mcp-foot {
  border-top: 0;
  padding-top: 0;
}
</style>
