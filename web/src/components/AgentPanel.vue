<template>
  <section class="panel agent-panel">
    <header class="panel-head">
      <div class="panel-title">
        <span class="dot" :class="{ live: connected }"></span>
        Agent 状态 · 按项目
      </div>
      <span class="hint">
        {{ sessions.length }} 个 Agent · {{ activeCount }} 活跃 · 点击卡片看执行记录
      </span>
    </header>

    <div v-if="groups.length" class="stream">
      <section v-for="g in groups" :key="g.key" class="group">
        <header class="group-head" @click="toggle(g)">
          <span class="caret" :class="{ closed: !isOpen(g) }">▾</span>
          <span class="g-name">{{ g.name }}</span>
          <span class="g-meta">
            {{ g.agents.length }} Agent<template v-if="g.active"> · {{ g.active }} 活跃</template>
          </span>
          <button
            v-if="g.cwd"
            type="button"
            class="g-history"
            title="查看项目历史时间图"
            @click.stop="emit('open-project', g.cwd)"
          >
            历史
          </button>
          <span class="g-time">
            <span class="live-dot" :class="{ on: isRecent(g.lastTs) }"></span>
            {{ relative(g.lastTs) }}
          </span>
        </header>

        <div v-show="isOpen(g)" class="group-body">
          <AgentCard
            v-for="s in g.agents"
            :key="s.id"
            :session="s"
            :events="eventsBySession.get(s.id) || []"
            @open="openAgent"
          />
        </div>
      </section>
    </div>

    <div v-else class="empty">
      <p>正在回放会话转录…</p>
      <small>每个 JSONL 转录对应一个 Agent 会话</small>
    </div>
  </section>
</template>

<script setup>
import { computed, reactive } from 'vue';
import { relative } from '../lib/format.js';
import { projectKey } from '../lib/project.js';
import AgentCard from './AgentCard.vue';

const props = defineProps({
  sessions: { type: Array, default: () => [] },
  events: { type: Array, default: () => [] },
  connected: Boolean,
});

const emit = defineEmits(['open-session', 'open-project']);

function openAgent(id) {
  if (id) emit('open-session', id);
}

const opened = reactive(new Set());
const collapsed = reactive(new Set());

const activeCount = computed(() => props.sessions.filter((s) => s.status !== 'idle').length);

/** 每个会话最近 3 条事件，供 AgentCard 展示动作轨迹 */
const eventsBySession = computed(() => {
  const m = new Map();
  for (const ev of props.events) {
    let arr = m.get(ev.sessionId);
    if (!arr) {
      arr = [];
      m.set(ev.sessionId, arr);
    }
    if (arr.length < 3) arr.push(ev);
  }
  return m;
});

const groups = computed(() => {
  const map = new Map();

  for (const s of props.sessions) {
    const key = s.cwd ? projectKey(s.cwd) : s.project || 'unknown';
    let g = map.get(key);
    if (!g) {
      g = { key, cwd: s.cwd || '', name: projectName(s), agents: [], active: 0, lastTs: 0 };
      map.set(key, g);
    }
    g.agents.push(s);
    if (s.status !== 'idle') g.active++;
    g.lastTs = Math.max(g.lastTs, s.lastEventAt || 0);
  }

  for (const g of map.values()) {
    // 活跃 Agent 排在组内最前
    g.agents.sort((a, b) => {
      const rank = (x) => (x.status === 'idle' ? 1 : 0);
      return rank(a) - rank(b) || (b.lastEventAt || 0) - (a.lastEventAt || 0);
    });
  }

  return [...map.values()].sort((a, b) => b.lastTs - a.lastTs);
});

function isOpen(g) {
  if (opened.has(g.key)) return true;
  if (collapsed.has(g.key)) return false;
  return g.active > 0; // 默认展开有活跃 Agent 的项目
}

function toggle(g) {
  if (isOpen(g)) {
    opened.delete(g.key);
    collapsed.add(g.key);
  } else {
    collapsed.delete(g.key);
    opened.add(g.key);
  }
}

function projectName(s) {
  if (s.cwd) {
    const norm = s.cwd.replace(/\\/g, '/');
    const parts = norm.split('/').filter(Boolean);
    // 盘符根目录（C:\）只有一段，直接显示完整路径
    if (parts.length > 1) return parts[parts.length - 1];
    if (parts.length === 1) return norm;
  }
  if (!s.project) return '未知项目';
  return s.project.replace(/^[A-Z]--/, '').replace(/-+/g, '·') || s.project;
}

function isRecent(ts) {
  return ts && Date.now() - ts < 60_000;
}
</script>

<style scoped>
.agent-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.stream {
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}

.group {
  border-bottom: 1px solid rgba(148, 163, 184, 0.1);
}

.group:last-child {
  border-bottom: none;
}

.group-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 8px 14px 7px;
  cursor: pointer;
  user-select: none;
  background: #0f141d;
  border-left: 2px solid rgba(94, 234, 212, 0.3);
  position: sticky;
  top: 0;
  z-index: 2;
  box-shadow: 0 1px 0 rgba(148, 163, 184, 0.08);
}

.group-head:hover {
  background: #121823;
}

.caret {
  font-size: 10px;
  color: var(--text-3);
  transition: transform 0.15s ease;
  display: inline-block;
}

.caret.closed {
  transform: rotate(-90deg);
}

.g-name {
  font-size: 12px;
  font-weight: 650;
  color: var(--text-1);
}

.g-meta {
  font-size: 10.5px;
  color: var(--text-3);
}

.g-history {
  appearance: none;
  border: 1px solid var(--line);
  background: rgba(148, 163, 184, 0.06);
  color: var(--text-3);
  font: inherit;
  font-size: 10px;
  line-height: 1;
  padding: 3px 8px;
  border-radius: 99px;
  cursor: pointer;
}

.g-history:hover {
  color: #5eead4;
  border-color: rgba(94, 234, 212, 0.35);
}

.g-time {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 10.5px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

.live-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: rgba(100, 116, 139, 0.6);
}

.live-dot.on {
  background: #5eead4;
  box-shadow: 0 0 7px rgba(94, 234, 212, 0.9);
}

.group-body {
  padding-bottom: 3px;
}

.empty {
  flex: 1;
  display: grid;
  place-content: center;
  text-align: center;
  color: var(--text-3);
  gap: 6px;
}

.empty p {
  margin: 0;
  font-size: 13px;
}

.empty small {
  font-size: 11px;
  opacity: 0.7;
}
</style>
