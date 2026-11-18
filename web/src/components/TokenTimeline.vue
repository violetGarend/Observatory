<template>
  <section class="panel timeline-panel">
    <header class="panel-head">
      <div class="panel-title">活跃度时间线</div>

      <div class="head-controls">
        <div class="range-switch" role="group" aria-label="时间范围">
          <button
            v-for="p in PRESETS"
            :key="p.key"
            type="button"
            :class="{ active: mode === p.key }"
            :aria-pressed="mode === p.key"
            @click="selectPreset(p.key)"
          >
            {{ p.label }}
          </button>
        </div>

        <div v-if="mode === 'custom'" class="custom-range">
          <input v-model="fromDate" type="date" :min="minDate" :max="maxDate" aria-label="开始日期" />
          <span class="dash">–</span>
          <input v-model="toDate" type="date" :min="minDate" :max="maxDate" aria-label="结束日期" />
          <button type="button" class="apply" :disabled="!!customError" @click="applyCustom">应用</button>
        </div>

        <span v-if="customError" class="warn">{{ customError }}</span>
        <span v-else-if="error && hasData" class="warn">刷新失败</span>
        <span v-else-if="grain" class="hint">{{ grain }}</span>
      </div>
    </header>

    <p v-if="notice" class="notice">{{ notice }}</p>

    <BaseChart v-if="hasData" :option="option" height="100%" class="timeline-chart" />
    <div v-else class="empty">
      <template v-if="loading">加载时间线…</template>
      <template v-else-if="error">
        {{ error }}
        <button type="button" class="retry" @click="load()">重试</button>
      </template>
      <template v-else>{{ emptyText }}</template>
    </div>
  </section>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import BaseChart from './BaseChart.vue';
import {
  PRESETS,
  addLocalDays,
  fetchTimeline,
  formatBucketLabel,
  formatBucketTooltip,
  grainText,
  parseDateInput,
  presetRange,
  toDateInput,
  validateCustom,
} from '../lib/timeRange.js';

const props = defineProps({
  tick: { type: Number, default: 0 },
  connected: { type: Boolean, default: false },
});

const REFRESH_MS = 1000;

const mode = ref('24h');
const fromDate = ref('');
const toDate = ref('');
const data = ref(null);
const loading = ref(true);
const error = ref('');
const customError = ref('');

let seq = 0;
let ctrl = null;
let refreshTimer = null;
let lastFetchStart = 0;
let disposed = false;

const buckets = computed(() => data.value?.buckets || []);
const stepMs = computed(() => data.value?.granularity || 0);
const retentionDays = computed(() => data.value?.retentionDays || 90);
const grain = computed(() => grainText(stepMs.value));

// 零填充后 buckets 长度永远 > 0，只能看数值判断有没有活动
const hasData = computed(() =>
  buckets.value.some((b) => b.messages || b.output || b.skills || b.tools)
);

const minDate = computed(() => toDateInput(Date.now() - (retentionDays.value - 1) * 86400000));
const maxDate = computed(() => toDateInput(Date.now()));

const emptyText = computed(() => {
  const d = data.value;
  if (!d) return '暂无转录数据';
  if (d.outOfRetention) return `所选区间早于保留窗口（最近 ${retentionDays.value} 天）`;
  return '所选区间无活动';
});

const notice = computed(() => {
  const d = data.value;
  if (!d || d.outOfRetention) return '';
  if (d.availableFrom && d.from < d.availableFrom) return `数据从 ${shortDate(d.availableFrom)} 开始`;
  if (d.truncated) return `已截断至保留窗口：${shortDate(d.from)} 起`;
  return '';
});

function shortDate(ts) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function resolveRange() {
  const now = Date.now();
  if (mode.value === 'custom') {
    const from = parseDateInput(fromDate.value);
    const endDay = parseDateInput(toDate.value);
    return {
      from,
      to: Math.min(addLocalDays(endDay, 1), now),
      live: toDate.value === toDateInput(now),
    };
  }
  return { ...presetRange(mode.value, now), live: true };
}

async function load(range = resolveRange(), { silent = false } = {}) {
  if (disposed) return;
  const mySeq = ++seq;
  ctrl?.abort();
  ctrl = new AbortController();
  lastFetchStart = Date.now();

  if (!silent) {
    loading.value = true;
    error.value = '';
    data.value = null;
  }

  try {
    const res = await fetchTimeline(range, ctrl.signal);
    if (mySeq !== seq || disposed) return;
    data.value = res;
    error.value = '';
  } catch (err) {
    if (err.name === 'AbortError' || mySeq !== seq || disposed) return;
    error.value = '时间线加载失败';
  } finally {
    if (mySeq === seq) loading.value = false;
  }
}

/** 1 秒节流（leading + trailing）：持续事件下也必须保持刷新 */
function scheduleLiveRefresh() {
  if (disposed || !props.connected) return;
  const range = resolveRange();
  if (!range.live) return;

  // 刷新失败后放慢到 5 秒重试，等一次成功再恢复 1 秒节奏
  const interval = error.value ? 5000 : REFRESH_MS;
  const wait = interval - (Date.now() - lastFetchStart);
  if (wait <= 0) {
    load(range, { silent: true });
    return;
  }
  if (!refreshTimer) {
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      scheduleLiveRefresh();
    }, wait);
  }
}

function selectPreset(key) {
  if (key === mode.value) return;
  mode.value = key;
  customError.value = '';

  if (key === 'custom') {
    if (!fromDate.value) fromDate.value = toDateInput(Date.now() - 6 * 86400000);
    if (!toDate.value) toDate.value = toDateInput(Date.now());
    customError.value = validateCustom(fromDate.value, toDate.value, retentionDays.value);
    // 进入自定义时先展示当前预填区间，避免输入框与图表对不上；后续改动仍要点「应用」
    if (!customError.value) load();
    return;
  }
  load();
}

function applyCustom() {
  customError.value = validateCustom(fromDate.value, toDate.value, retentionDays.value);
  if (customError.value) return;
  load();
}

watch([fromDate, toDate], () => {
  customError.value = validateCustom(fromDate.value, toDate.value, retentionDays.value);
});

watch(() => props.tick, scheduleLiveRefresh);

watch(
  () => props.connected,
  (on) => {
    if (!on) return;
    error.value = '';
    load();
  }
);

onMounted(() => load());

onUnmounted(() => {
  disposed = true;
  clearTimeout(refreshTimer);
  ctrl?.abort();
});

function label(ts) {
  return formatBucketLabel(ts, stepMs.value);
}

const option = computed(() => {
  const b = buckets.value;
  const step = stepMs.value;
  return {
    backgroundColor: 'transparent',
    animation: false,
    grid: { left: 10, right: 12, top: 24, bottom: 6, containLabel: true },
    legend: {
      right: 8,
      top: 0,
      itemWidth: 8,
      itemHeight: 8,
      textStyle: { color: '#94a3b8', fontSize: 11 },
      data: ['输出 token', 'skill 调用'],
    },
    tooltip: {
      trigger: 'axis',
      backgroundColor: 'rgba(15,20,30,0.95)',
      borderColor: 'rgba(255,255,255,0.1)',
      textStyle: { color: '#e2e8f0', fontSize: 12 },
      formatter: (params) => {
        const arr = Array.isArray(params) ? params : [params];
        const item = b[arr[0]?.dataIndex];
        if (!item) return '';
        return [
          `<div style="color:#94a3b8;font-size:11px;margin-bottom:4px">${formatBucketTooltip(item.ts, step)}</div>`,
          `输出 token：${item.output}`,
          `skill 调用：${item.skills}`,
          `消息：${item.messages}`,
        ].join('<br/>');
      },
    },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: b.map((x) => label(x.ts)),
      axisLine: { lineStyle: { color: 'rgba(148,163,184,0.15)' } },
      axisTick: { show: false },
      axisLabel: { color: '#64748b', fontSize: 10, hideOverlap: true },
    },
    yAxis: [
      {
        type: 'value',
        splitLine: { lineStyle: { color: 'rgba(148,163,184,0.07)' } },
        axisLabel: { color: '#64748b', fontSize: 10, formatter: (v) => (v >= 1000 ? `${v / 1000}k` : v) },
      },
      {
        type: 'value',
        minInterval: 1,
        splitLine: { show: false },
        axisLabel: { color: '#a78bfa', fontSize: 10 },
      },
    ],
    series: [
      {
        name: '输出 token',
        type: 'line',
        yAxisIndex: 0,
        smooth: 0.25,
        symbol: 'none',
        lineStyle: { width: 1.5, color: '#5eead4' },
        areaStyle: {
          color: {
            type: 'linear',
            x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: 'rgba(94,234,212,0.28)' },
              { offset: 1, color: 'rgba(94,234,212,0)' },
            ],
          },
        },
        data: b.map((x) => x.output),
      },
      {
        name: 'skill 调用',
        type: 'bar',
        yAxisIndex: 1,
        barMaxWidth: 10,
        itemStyle: { color: 'rgba(167,139,250,0.75)', borderRadius: [2, 2, 0, 0] },
        data: b.map((x) => x.skills),
      },
    ],
  };
});
</script>

<style scoped>
.timeline-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.timeline-panel .panel-head {
  align-items: center;
  flex-wrap: wrap;
}

.head-controls {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  flex-wrap: wrap;
}

.range-switch {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: 9px;
  background: rgba(148, 163, 184, 0.07);
}

.range-switch button {
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
  transition: color 0.15s, background 0.15s;
}

.range-switch button:hover {
  color: var(--text-2);
}

.range-switch button.active {
  color: var(--text-1);
  background: rgba(94, 234, 212, 0.14);
  border-color: rgba(94, 234, 212, 0.45);
}

.range-switch button:focus-visible {
  outline: 2px solid rgba(94, 234, 212, 0.6);
  outline-offset: 1px;
}

.custom-range {
  display: flex;
  align-items: center;
  gap: 6px;
}

.custom-range input[type='date'] {
  background: rgba(148, 163, 184, 0.07);
  border: 1px solid var(--line);
  border-radius: 7px;
  color: var(--text-1);
  font: inherit;
  font-size: 11px;
  padding: 3px 6px;
  min-height: 26px;
}

.custom-range .dash {
  color: var(--text-3);
  font-size: 11px;
}

.apply {
  appearance: none;
  border: 1px solid rgba(94, 234, 212, 0.45);
  background: rgba(94, 234, 212, 0.14);
  color: var(--text-1);
  font: inherit;
  font-size: 11px;
  padding: 4px 9px;
  min-height: 26px;
  border-radius: 7px;
  cursor: pointer;
}

.apply:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.warn {
  font-size: 11px;
  color: #fca5a5;
}

.notice {
  margin: 0;
  padding: 6px 14px 0;
  font-size: 11px;
  color: #fbbf24;
}

.timeline-chart {
  flex: 1;
  min-height: 0;
}

.empty {
  flex: 1;
  display: grid;
  place-content: center;
  gap: 8px;
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
}
</style>
