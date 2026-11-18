<template>
  <section class="constellation">
    <article class="panel bill-panel">
      <header class="panel-head">
        <div class="panel-title">技能账单 · 近 30 天</div>
        <span class="hint">只读 · 不生成归档/禁用命令</span>
      </header>

      <div v-if="!data && loading" class="state">正在估算技能成本…</div>
      <div v-else-if="!data && error" class="state">
        {{ error }}
        <button type="button" class="retry" @click="load()">重试</button>
      </div>

      <template v-else-if="data">
        <p class="headline">{{ data.headline.sentence }}</p>

        <div class="quality">
          <span class="conf" :class="conf.tone">数据质量 {{ conf.label }}</span>
          <span class="q-hint">
            近 {{ data.windowDays }} 天 {{ data.quality.observedEvents }} 次事件 /
            {{ data.quality.skillsTotal }} 个技能 · 已观测 {{ data.quality.observedSkills }} 个
          </span>
          <span v-if="error" class="warn">刷新失败</span>
          <span v-else class="q-hint right">更新于 {{ relative(data.generatedAt) }}</span>
        </div>

        <div class="billing-row">
          <section class="candidates">
            <div class="sub-head">
              <span>候选（{{ data.candidates.length }}）</span>
              <span class="hint">零调用 · tokens_high ≥ 120 · 文本未提及</span>
            </div>

            <table v-if="data.candidates.length" class="cand-table" aria-label="候选技能">
              <thead>
                <tr>
                  <th scope="col">技能</th>
                  <th scope="col">来源</th>
                  <th scope="col" class="num">tokens_high</th>
                  <th scope="col" class="num">窗口调用</th>
                  <th scope="col">事实</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="c in data.candidates" :key="c.name">
                  <td><code class="name" :title="c.name">{{ c.name }}</code></td>
                  <td><span class="src" :class="c.sourceType">{{ c.source }}</span></td>
                  <td class="num mono">{{ c.tokensHigh }}</td>
                  <td class="num mono">{{ c.invocations }}</td>
                  <td class="facts">
                    <span class="badge accent">零调用</span>
                    <span class="badge">高成本</span>
                    <span v-if="!c.installedAt" class="badge">安装日期未知</span>
                  </td>
                </tr>
              </tbody>
            </table>

            <p v-else class="empty">
              窗口内没有满足条件的候选（零调用 / tokens_high ≥ 120 / 文本未提及）·
              已观测 {{ data.quality.observedSkills }} 个技能
            </p>

            <p v-if="data.candidates.length" class="cand-note">
              候选只列同时满足三个条件的技能；其余高成本零调用技能见下方清单（带"零调用 · 高成本"徽标）。
            </p>
          </section>

          <section class="map-panel">
            <div class="sub-head">
              <span>技能星图</span>
              <span class="hint">{{ data.skills.length }} 节点</span>
            </div>
            <div class="map-scroll">
              <StarMap :skills="data.skills" :candidates="data.candidates" />
            </div>
          </section>
        </div>

        <p class="caveat">
          {{ data.cost.denominator }}；{{ data.cost.unit }}。数据质量只表达样本量，不代表使用概率。
          <template v-if="data.quality.mentionTracking.enabled">
            提及匹配：{{ data.quality.mentionTracking.caveat }}。
          </template>
          {{ data.quality.scopeNote }}；{{ data.quality.eventNote }}。
        </p>
      </template>
    </article>

    <ConstellationInventory
      v-if="data"
      :skills="data.skills"
      :unmatched="data.unmatched"
    />
  </section>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import StarMap from './StarMap.vue';
import ConstellationInventory from './ConstellationInventory.vue';
import { confidenceMeta } from '../lib/constellation.js';
import { relative } from '../lib/format.js';

const props = defineProps({
  tick: { type: Number, default: 0 },
});

const POLL_MS = 30000;
const TICK_THROTTLE_MS = 20000;

const data = ref(null);
const loading = ref(true);
const error = ref('');

let ctrl = null;
let timer = null;
let seq = 0;
let lastFetch = 0;
let disposed = false;

const conf = computed(() => confidenceMeta(data.value?.quality?.confidence));

async function load({ silent = false } = {}) {
  if (disposed) return;
  const mySeq = ++seq;
  ctrl?.abort();
  ctrl = new AbortController();
  lastFetch = Date.now();

  if (!silent) {
    loading.value = true;
    error.value = '';
  }

  try {
    const res = await fetch('/api/constellation?days=30', { signal: ctrl.signal });
    if (!res.ok) throw new Error(`constellation ${res.status}`);
    const json = await res.json();
    if (mySeq !== seq || disposed) return;
    data.value = json;
    error.value = '';
  } catch (err) {
    if (err.name === 'AbortError' || mySeq !== seq || disposed) return;
    error.value = '账单加载失败';
  } finally {
    if (mySeq === seq && !disposed && !silent) loading.value = false;
  }
}

watch(
  () => props.tick,
  () => {
    if (Date.now() - lastFetch >= TICK_THROTTLE_MS) load({ silent: true });
  }
);

onMounted(() => {
  load();
  timer = setInterval(() => {
    if (!document.hidden) load({ silent: true });
  }, POLL_MS);
});

onUnmounted(() => {
  disposed = true;
  clearInterval(timer);
  ctrl?.abort();
});
</script>

<style scoped>
.constellation {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.bill-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.headline {
  margin: 0;
  padding: 14px 16px 6px;
  font-size: 17px;
  line-height: 1.55;
  font-weight: 600;
  color: var(--text-1);
}

.quality {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  padding: 0 16px 10px;
}

.conf {
  font-size: 10.5px;
  font-weight: 600;
  padding: 2px 9px;
  border-radius: 99px;
  border: 1px solid var(--line);
  color: var(--text-2);
}

.conf.low {
  color: #fbbf24;
  border-color: rgba(251, 191, 36, 0.4);
  background: rgba(251, 191, 36, 0.08);
}

.conf.medium {
  color: #7dd3fc;
  border-color: rgba(56, 189, 248, 0.4);
  background: rgba(56, 189, 248, 0.08);
}

.conf.high {
  color: #6ee7b7;
  border-color: rgba(52, 211, 153, 0.4);
  background: rgba(52, 211, 153, 0.08);
}

.q-hint {
  font-size: 10.5px;
  color: var(--text-3);
}

.q-hint.right {
  margin-left: auto;
}

.warn {
  font-size: 10.5px;
  color: #fca5a5;
  margin-left: auto;
}

.billing-row {
  display: grid;
  grid-template-columns: minmax(420px, 0.9fr) minmax(700px, 1.25fr);
  gap: 16px;
  padding: 2px 16px 14px;
  border-top: 1px solid var(--line);
  padding-top: 12px;
}

.candidates {
  min-width: 0;
}

.sub-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  padding-bottom: 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-1);
}

.sub-head .hint {
  font-weight: 400;
}

.map-panel {
  min-width: 0;
  border-left: 1px solid var(--line);
  padding-left: 16px;
}

.map-scroll {
  overflow-x: auto;
}

.cand-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11.5px;
}

.cand-table th {
  text-align: left;
  font-weight: 600;
  color: var(--text-3);
  font-size: 10.5px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--line);
  white-space: nowrap;
}

.cand-table th:nth-child(1) { width: 34%; }
.cand-table th:nth-child(2) { width: 22%; }
.cand-table th:nth-child(3) { width: 11%; }
.cand-table th:nth-child(4) { width: 11%; }
.cand-table th:nth-child(5) { width: 22%; }

.cand-note {
  margin: 12px 0 0;
  font-size: 10.5px;
  line-height: 1.6;
  color: var(--text-3);
}

.cand-table td {
  padding: 8px 10px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.06);
  color: var(--text-2);
  vertical-align: middle;
}

.cand-table tr:hover {
  background: rgba(148, 163, 184, 0.04);
}

.cand-table th.num,
.cand-table td.num {
  text-align: right;
}

.mono {
  font-family: ui-monospace, 'SF Mono', 'Cascadia Code', monospace;
  font-variant-numeric: tabular-nums;
}

.name {
  font-family: ui-monospace, 'SF Mono', 'Cascadia Code', monospace;
  color: var(--text-1);
  overflow-wrap: anywhere;
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

.empty {
  margin: 0;
  padding: 18px 4px;
  color: var(--text-3);
  font-size: 11.5px;
  line-height: 1.6;
}

.caveat {
  margin: 0;
  padding: 9px 16px 11px;
  border-top: 1px solid var(--line);
  font-size: 10.5px;
  line-height: 1.6;
  color: var(--text-3);
}

.state {
  display: grid;
  place-content: center;
  gap: 8px;
  min-height: 180px;
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

@media (max-width: 1100px) {
  .billing-row {
    grid-template-columns: 1fr;
  }

  .map-panel {
    border-left: 0;
    padding-left: 0;
    border-top: 1px solid var(--line);
    padding-top: 12px;
  }
}
</style>
