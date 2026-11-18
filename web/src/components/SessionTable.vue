<template>
  <section class="panel session-panel">
    <header class="panel-head">
      <div class="panel-title">会话</div>
      <span class="hint">{{ total }} 个 · 最近 30 分钟活跃 {{ active }}</span>
    </header>

    <div v-if="sessions.length" class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>项目</th>
            <th>跨度</th>
            <th class="num">消息</th>
            <th class="num">skill</th>
            <th class="num">输出</th>
            <th>最后活动</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in sessions" :key="s.id">
            <td class="project" :title="s.title ? `${s.title}\n${s.cwd || s.project}` : s.cwd || s.project">
              <div class="p-name">{{ shortProject(s.project, s.cwd) }}</div>
              <div v-if="s.title" class="p-title">{{ s.title }}</div>
            </td>
            <td class="muted">{{ duration(s.end - s.start) }}</td>
            <td class="num">{{ s.messages }}</td>
            <td class="num" :class="{ zero: !s.skillCalls }">{{ s.skillCalls }}</td>
            <td class="num">{{ compact(s.output) }}</td>
            <td class="muted">{{ relative(s.lastEventAt || s.end) }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-else class="empty">暂无会话</div>
  </section>
</template>

<script setup>
import { compact, duration, relative } from '../lib/format.js';

defineProps({
  sessions: { type: Array, default: () => [] },
  total: { type: Number, default: 0 },
  active: { type: Number, default: 0 },
});

function shortProject(p, cwd) {
  if (cwd) {
    const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
    const name = parts[parts.length - 1];
    if (name) return name.length > 22 ? name.slice(0, 22) + '…' : name;
  }
  if (!p) return '—';
  const clean = p.replace(/^[A-Z]--/, '').replace(/-+/g, '·');
  return clean.length > 22 ? clean.slice(0, 22) + '…' : clean;
}
</script>

<style scoped>
.session-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.table-wrap {
  flex: 1;
  overflow: auto;
  min-height: 0;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

thead th {
  position: sticky;
  top: 0;
  background: var(--panel);
  backdrop-filter: blur(8px);
  text-align: left;
  font-weight: 500;
  color: var(--text-3);
  font-size: 11px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--line);
  z-index: 1;
}

tbody td {
  padding: 7px 12px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.06);
  color: var(--text-1);
  white-space: nowrap;
}

.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.muted {
  color: var(--text-3);
}

.project {
  max-width: 230px;
}

.p-name {
  font-weight: 600;
  font-size: 12px;
}

.p-title {
  margin-top: 1px;
  font-size: 10.5px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 230px;
}

.zero {
  color: var(--text-3);
  opacity: 0.5;
}

.empty {
  flex: 1;
  display: grid;
  place-content: center;
  color: var(--text-3);
  font-size: 12px;
}
</style>
