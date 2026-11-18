<template>
  <article
    class="agent"
    :class="session.status"
    tabindex="0"
    role="button"
    :aria-label="`查看 ${displayName} 的执行记录`"
    @click="emit('open', session.id)"
    @keydown.enter.prevent="emit('open', session.id)"
    @keydown.space.prevent="emit('open', session.id)"
  >
    <header class="a-head">
      <span class="status-dot"></span>
      <span class="status-label">{{ statusLabel }}</span>
      <span class="a-name" :title="session.id">{{ displayName }}</span>
      <span class="a-sid">{{ shortId }}</span>
      <span class="a-model">{{ shortModel(session.model) }}</span>
    </header>

    <p v-if="session.task" class="line task">
      <span class="k">任务</span>
      <span class="v">{{ session.task }}</span>
    </p>

    <p v-if="session.thinking" class="line thinking">
      <span class="k">思考</span>
      <span class="v">{{ session.thinking }}</span>
    </p>

    <p v-if="session.currentTools?.length" class="line running">
      <span class="k">正在</span>
      <span class="v">
        <span v-for="(t, i) in session.currentTools" :key="i" class="chip tool">
          <b>{{ t.name }}</b><em v-if="t.summary">{{ t.summary }}</em>
        </span>
      </span>
    </p>

    <p v-else-if="session.lastTool" class="line last">
      <span class="k">刚才</span>
      <span class="v">
        <span class="chip tool" :class="{ err: session.lastTool.isError }">
          <b>{{ session.lastTool.name }}</b><em v-if="session.lastTool.summary">{{ session.lastTool.summary }}</em>
        </span>
      </span>
    </p>

    <p v-if="recentActions.length" class="line recent">
      <span class="k">轨迹</span>
      <span class="v">
        <span v-for="(a, i) in recentActions" :key="i" class="chip">
          <b>{{ a.name }}</b><em v-if="a.summary">{{ a.summary }}</em>
        </span>
      </span>
    </p>

    <footer class="a-foot">
      <span v-if="session.cost != null" class="cost" :title="`API ${fmtDur(session.apiDuration)} / 工具 ${fmtDur(session.toolDuration)}`">
        {{ formatCost(session.cost) }}
      </span>
      <span>输出 {{ compact(session.output) }}</span>
      <span>输入 {{ compact(session.input) }}</span>
      <span>缓存读 {{ compact(session.cacheRead) }}</span>
      <span class="when">{{ relative(session.lastEventAt) }}</span>
      <span class="open-hint">执行记录 →</span>
    </footer>
  </article>
</template>

<script setup>
import { computed } from 'vue';
import { compact, relative, duration } from '../lib/format.js';

const props = defineProps({
  session: { type: Object, required: true },
  events: { type: Array, default: () => [] },
});

const emit = defineEmits(['open']);

const STATUS_LABEL = {
  running: '执行中',
  thinking: '思考中',
  waiting: '等待输入',
  idle: '空闲',
};

const statusLabel = computed(() => STATUS_LABEL[props.session.status] || '未知');

const displayName = computed(() => {
  const s = props.session;
  return s.agentName || s.aiTitle || s.title || s.project || '未命名 Agent';
});

const shortId = computed(() => (props.session.id || '').slice(0, 6));

/** 最近的 3 条动作轨迹（events 已按时间倒序） */
const recentActions = computed(() => {
  const out = [];
  for (const ev of props.events) {
    for (const t of ev.toolCalls || []) {
      out.push(t);
      if (out.length >= 3) return out;
    }
    for (const s of ev.skills || []) {
      out.push({ name: `Skill: ${s.name}`, summary: s.trigger || '' });
      if (out.length >= 3) return out;
    }
  }
  return out;
});

function shortModel(m) {
  if (!m) return '';
  return m.replace(/^claude-/, '').slice(0, 18);
}

function formatCost(usd) {
  if (usd == null) return '';
  if (usd >= 100) return `$${Math.round(usd)}`;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(3)}`;
}

function fmtDur(ms) {
  return ms == null ? '—' : duration(ms);
}
</script>

<style scoped>
.agent {
  --status: #64748b;
  padding: 9px 12px 7px;
  margin: 6px 12px 8px;
  border-radius: 9px;
  background: rgba(148, 163, 184, 0.035);
  border: 1px solid rgba(148, 163, 184, 0.1);
  border-left: 2px solid var(--status);
  display: flex;
  flex-direction: column;
  gap: 5px;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}

.agent:hover {
  border-color: rgba(94, 234, 212, 0.32);
  background: rgba(148, 163, 184, 0.07);
}

.agent:focus-visible {
  outline: 2px solid rgba(94, 234, 212, 0.65);
  outline-offset: 2px;
}

.agent.running {
  --status: #5eead4;
  background: rgba(94, 234, 212, 0.045);
  border-color: rgba(94, 234, 212, 0.18);
}
.agent.thinking {
  --status: #a78bfa;
  background: rgba(167, 139, 250, 0.045);
  border-color: rgba(167, 139, 250, 0.18);
}
.agent.waiting {
  --status: #38bdf8;
}
.agent.idle {
  --status: #475569;
  opacity: 0.72;
}

/* ---------- 头部 ---------- */
.a-head {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--status);
  flex: 0 0 auto;
}

.running .status-dot,
.thinking .status-dot {
  box-shadow: 0 0 0 0 var(--status);
  animation: ping 1.8s infinite;
}

@keyframes ping {
  0% { box-shadow: 0 0 0 0 rgba(94, 234, 212, 0.45); }
  70% { box-shadow: 0 0 0 6px rgba(94, 234, 212, 0); }
  100% { box-shadow: 0 0 0 0 rgba(94, 234, 212, 0); }
}

.status-label {
  font-size: 10px;
  font-weight: 600;
  color: var(--status);
  flex: 0 0 auto;
}

.a-name {
  font-size: 12.5px;
  font-weight: 650;
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.a-sid {
  font-family: ui-monospace, monospace;
  font-size: 9.5px;
  color: var(--text-3);
  flex: 0 0 auto;
}

.a-model {
  margin-left: auto;
  font-size: 10px;
  color: var(--text-3);
  white-space: nowrap;
  flex: 0 0 auto;
}

/* ---------- 信息行 ---------- */
.line {
  margin: 0;
  display: grid;
  grid-template-columns: 32px minmax(0, 1fr);
  gap: 7px;
  font-size: 11.5px;
  line-height: 1.45;
}

.k {
  font-size: 9.5px;
  color: var(--text-3);
  padding-top: 2px;
  letter-spacing: 0.04em;
}

.v {
  min-width: 0;
  color: var(--text-1);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.task .v {
  border-left: 2px solid rgba(94, 234, 212, 0.35);
  padding-left: 7px;
}

.thinking .v {
  color: var(--text-2);
  font-style: italic;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin: 0 4px 2px 0;
  padding: 1px 7px;
  border-radius: 5px;
  font-size: 10.5px;
  background: rgba(148, 163, 184, 0.09);
  color: var(--text-2);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chip b {
  color: var(--text-1);
  font-weight: 600;
}

.chip em {
  font-style: normal;
  opacity: 0.72;
}

.chip.err {
  background: rgba(248, 113, 113, 0.12);
  color: #fca5a5;
}

/* ---------- 底部 ---------- */
.a-foot {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 10px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
  flex-wrap: wrap;
}

.cost {
  color: #fbbf24;
  font-weight: 600;
}

.when {
  margin-left: auto;
}

.open-hint {
  color: #5eead4;
  opacity: 0.6;
  white-space: nowrap;
  transition: opacity 0.15s;
}

.agent:hover .open-hint {
  opacity: 1;
}
</style>
