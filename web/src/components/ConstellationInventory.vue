<template>
  <article class="panel inventory-panel">
    <header class="panel-head">
      <div class="panel-title">清单 · {{ rows.length }} 个技能</div>
      <span class="hint">tokens_high 降序 · 同分按窗口调用升序</span>
    </header>

    <div class="table-scroll">
      <table>
        <caption>全部技能的成本、窗口调用与观测状态。排序：tokens_high 降序，同分按窗口调用升序。</caption>
        <thead>
          <tr>
            <th scope="col">技能</th>
            <th scope="col">来源</th>
            <th scope="col" class="num">tokens_low–high</th>
            <th scope="col" class="num">窗口调用</th>
            <th scope="col">最近使用</th>
            <th scope="col">观测</th>
            <th scope="col" class="num">提及 强/弱</th>
            <th scope="col">事实</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in rows" :key="s.name">
            <td><code class="name" :title="s.name">{{ s.name }}</code></td>
            <td><span class="src" :class="s.sourceType">{{ s.source }}</span></td>
            <td class="num mono">{{ s.tokensLow }}–{{ s.tokensHigh }}</td>
            <td class="num mono">{{ s.invocations }}</td>
            <td class="muted">{{ lastUsedText(s.lastUsed) }}</td>
            <td>
              <span class="state" :class="{ on: s.observed }">{{ s.observed ? '已观测' : '未观测' }}</span>
            </td>
            <td class="num mono" :class="{ muted: !s.mentionTracked }">
              {{ mentionText(s) }}
            </td>
            <td class="facts">
              <span v-if="s.candidate" class="badge accent">候选</span>
              <span v-else-if="s.highCostZeroUse" class="badge">零调用 · 高成本</span>
              <span v-if="s.trialProtected" class="badge">试用期</span>
              <span v-if="!s.mentionTracked" class="badge">提及未知</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <p v-if="unmatched.length" class="unmatched">
      另有 {{ unmatchedEvents }} 次调用指向 {{ unmatched.length }} 个未安装/内置技能：{{ unmatchedNames }}
    </p>
  </article>
</template>

<script setup>
import { computed } from 'vue';
import { lastUsedText, mentionText } from '../lib/constellation.js';

const props = defineProps({
  skills: { type: Array, default: () => [] },
  unmatched: { type: Array, default: () => [] },
});

const rows = computed(() =>
  [...props.skills].sort(
    (a, b) =>
      b.tokensHigh - a.tokensHigh ||
      a.invocations - b.invocations ||
      a.name.localeCompare(b.name)
  )
);

const unmatchedEvents = computed(() =>
  props.unmatched.reduce((sum, u) => sum + u.invocations, 0)
);

const unmatchedNames = computed(() => {
  const names = props.unmatched.map((u) => `${u.name}(${u.invocations})`);
  return names.length > 6 ? `${names.slice(0, 6).join('、')} 等` : names.join('、');
});
</script>

<style scoped>
.inventory-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.table-scroll {
  max-height: 360px;
  overflow: auto;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11.5px;
}

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

tbody td {
  padding: 6px 12px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.06);
  color: var(--text-2);
  vertical-align: middle;
}

tbody tr:hover {
  background: rgba(148, 163, 184, 0.04);
}

th.num,
td.num {
  text-align: right;
}

.mono {
  font-family: ui-monospace, 'SF Mono', 'Cascadia Code', monospace;
  font-variant-numeric: tabular-nums;
}

.name {
  font-family: ui-monospace, 'SF Mono', 'Cascadia Code', monospace;
  color: var(--text-1);
}

.src {
  font-size: 10px;
  color: var(--text-3);
  background: rgba(148, 163, 184, 0.07);
  padding: 2px 7px;
  border-radius: 99px;
  white-space: nowrap;
}

.src.plugin {
  color: #c4b5fd;
  background: rgba(167, 139, 250, 0.12);
}

.muted {
  color: var(--text-3);
}

.state {
  font-size: 10px;
  color: var(--text-3);
}

.state.on {
  color: #6ee7b7;
}

.facts {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.badge {
  font-size: 9.5px;
  line-height: 1.4;
  color: var(--text-3);
  border: 1px solid var(--line);
  border-radius: 99px;
  padding: 1px 7px;
  white-space: nowrap;
}

.badge.accent {
  color: #fca5a5;
  border-color: rgba(252, 165, 165, 0.4);
  background: rgba(252, 165, 165, 0.08);
}

.unmatched {
  margin: 0;
  padding: 8px 14px 10px;
  border-top: 1px solid var(--line);
  font-size: 10.5px;
  color: var(--text-3);
  line-height: 1.5;
}
</style>
