<template>
  <section class="project-page">
    <div class="page-head">
      <div class="head-actions">
        <button type="button" class="back" @click="$emit('back')">← 返回看板</button>
        <button type="button" class="refresh" :disabled="loading || refreshing" @click="load({ refresh: true })">
          {{ refreshing ? '刷新中…' : '刷新' }}
        </button>
      </div>

      <div class="title-row">
        <h2>项目历史 · {{ name }}</h2>
        <code class="path" :title="cwd">{{ cwd }}</code>
        <span v-if="connected" class="conn on">实时连接</span>
      </div>

      <div class="meta">
        <span v-if="data">{{ rangeText }}</span>
        <span v-if="data">{{ data.granularity.label }}</span>
        <span v-if="data">数据截至 {{ asOf }}</span>
        <span v-if="data?.totals?.historyOnlySessions">
          含 {{ data.totals.historyOnlySessions }} 个仅输入历史的会话
        </span>
      </div>

      <div v-if="data" class="stats">
        <div class="stat"><b>{{ totals.sessions }}</b><span>会话</span></div>
        <div class="stat"><b>{{ totals.prompts }}</b><span>用户指令</span></div>
        <div class="stat"><b>{{ totals.actions }}</b><span>动作</span></div>
        <div class="stat"><b>{{ totals.activeDays }}</b><span>活跃天</span></div>
        <div class="stat"><b class="err">{{ totals.errors }}</b><span>失败</span></div>
      </div>
    </div>

    <div v-if="data?.partial || warnings.length" class="warn-box">
      <strong>部分数据不可用</strong>
      <span v-for="(warning, i) in warnings" :key="i">{{ warning }}</span>
    </div>

    <article ref="chartPanel" class="panel chart-panel">
      <header class="panel-head">
        <div class="panel-title">历史进程</div>
        <span class="hint">工具 / 子代理为柱，Skill / MCP 为右轴折线；顶部菱形是用户指令</span>
        <span v-if="focusInfo" class="focus-chip">
          已定位 {{ focusInfo.label }} · {{ focusInfo.title }}
          <button type="button" aria-label="取消定位" @click="clearFocus">×</button>
        </span>
      </header>

      <div v-if="loading" class="state">正在汇总项目历史（首次需要解析转录）…</div>
      <div v-else-if="error && !data" class="state">
        {{ error }}
        <button type="button" class="retry" @click="load()">重试</button>
      </div>
      <div v-else-if="!data?.buckets?.length" class="state">该项目还没有可汇总的记录</div>
      <div v-else ref="chartScroll" class="chart-scroll">
        <div class="chart-inner">
          <BaseChart :option="option" height="360px" @click="onChartClick" />
        </div>
      </div>
    </article>

    <article v-if="data?.sessions?.length" class="panel track-panel">
      <header class="panel-head">
        <div class="panel-title">会话轨道</div>
        <span class="hint">点击会话/色块定位到上方时间轴；「打开会话」进入详情</span>
      </header>

      <div class="chart-scroll">
        <div class="track-inner" :style="{ minWidth: '760px' }">
          <div
            v-for="session in visibleSessions"
            :key="`${session.id}-${session.start}`"
            class="track-row"
            :class="{ historyOnly: session.historyOnly, focused: focus?.sessionId === session.id }"
            role="button"
            tabindex="0"
            @click="focusSession(session)"
            @keydown.enter.prevent="focusSession(session)"
            @keydown.space.prevent="focusSession(session)"
          >
            <div class="track-head">
              <span class="t-title" :title="session.title">{{ session.title }}</span>
              <span class="t-meta">
                <template v-if="session.historyOnly">仅输入历史 · {{ session.promptCount }} 条指令</template>
                <template v-else>
                  {{ session.actions }} 动作 · {{ session.messages }} 消息 · {{ session.promptCount }} 指令
                </template>
              </span>
              <button
                v-if="!session.historyOnly"
                type="button"
                class="open-session"
                @click.stop="openSessionRow(session)"
              >
                打开会话 →
              </button>
            </div>
            <div class="track-line">
              <span
                v-for="(block, i) in sessionBlocks(session)"
                :key="i"
                class="track-block"
                :class="{
                  hollow: block.hollow,
                  focused:
                    focus?.sessionId === session.id && focus?.bucket === block.bucket,
                }"
                :style="{ left: `${block.left}%`, width: `${block.width}%`, opacity: block.opacity }"
                :title="blockTitle(session, block)"
                @click.stop="focusBlock(session, block)"
              ></span>
            </div>
          </div>
        </div>
      </div>

      <div v-if="hiddenSessions > 0 || totals.historyOnlyPrompts" class="track-foot">
        <button v-if="hiddenSessions > 0" type="button" class="more" @click="showAllSessions = true">
          展开剩余 {{ hiddenSessions }} 个会话
        </button>
        <span v-if="totals.historyOnlyPrompts">
          另有 {{ totals.historyOnlyPrompts }} 条指令来自已清理会话（无转录，不可打开）
        </span>
      </div>
    </article>
  </section>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import BaseChart from './BaseChart.vue';
import { projectName } from '../lib/project.js';

const props = defineProps({
  cwd: { type: String, required: true },
  connected: Boolean,
});

const emit = defineEmits(['back', 'open-session']);

const data = ref(null);
const loading = ref(true);
const refreshing = ref(false);
const error = ref('');
const showAllSessions = ref(false);
const chartPanel = ref(null);
const chartScroll = ref(null);
const focus = ref(null);

let ctrl = null;
let seq = 0;
let disposed = false;

const name = computed(() => projectName(props.cwd));
const warningList = computed(() => data.value?.warnings || []);
const warnings = warningList;

const totals = computed(
  () =>
    data.value?.totals || {
      sessions: 0,
      prompts: 0,
      actions: 0,
      activeDays: 0,
      errors: 0,
      historyOnlySessions: 0,
      historyOnlyPrompts: 0,
    }
);

const rangeText = computed(() => {
  if (!data.value?.range?.from) return '';
  const from = localDate(data.value.range.from);
  const to = localDate(data.value.range.to - 1);
  return `${from} → ${to}`;
});

const asOf = computed(() => (totals.value.lastAt ? localDateTime(totals.value.lastAt) : '—'));

const allSessions = computed(() => data.value?.sessions || []);
const visibleSessions = computed(() =>
  showAllSessions.value ? allSessions.value : allSessions.value.slice(0, 40)
);
const hiddenSessions = computed(() => Math.max(0, allSessions.value.length - visibleSessions.value.length));

const promptMap = computed(() => {
  const map = new Map();
  for (const prompt of data.value?.prompts || []) {
    let list = map.get(prompt.bucket);
    if (!list) {
      list = [];
      map.set(prompt.bucket, list);
    }
    list.push(prompt);
  }
  return map;
});

const promptScatter = computed(() => {
  return [...promptMap.value.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([bucket, prompts], i) => {
      const historyOnly = prompts.every((p) => p.historyOnly);
      return {
        value: [bucket, [0.24, 0.42, 0.6, 0.78][i % 4]],
        prompts,
        sessionId: prompts.length === 1 && !historyOnly ? prompts[0].sessionId : null,
        historyOnly,
        symbolSize: 7 + Math.min(5, prompts.length),
        itemStyle: historyOnly
          ? { color: 'rgba(15,23,42,0.85)', borderColor: '#94a3b8', borderWidth: 1.4 }
          : { color: '#f8fafc', borderColor: '#0f172a', borderWidth: 1.4 },
      };
    });
});

const focusInfo = computed(() => {
  if (!focus.value || !data.value) return null;
  const bucket = data.value.buckets[focus.value.bucket];
  const session = data.value.sessions.find((s) => s.id === focus.value.sessionId);
  if (!bucket) return null;
  return {
    bucket,
    label: bucket.label,
    title: focus.value.title || session?.title || '',
  };
});

function sessionRange(session) {
  const indexes = [];
  session.buckets.forEach((count, i) => {
    if (count > 0) indexes.push(i);
  });
  (session.promptBuckets || []).forEach((count, i) => {
    if (count > 0) indexes.push(i);
  });
  if (!indexes.length) return null;
  return [Math.min(...indexes), Math.max(...indexes)];
}

function focusSession(session) {
  const range = sessionRange(session);
  if (!range) return;
  focus.value = {
    sessionId: session.id,
    bucket: range[0],
    range,
    title: session.title,
  };
  scrollToChart();
}

function focusBlock(session, block) {
  const range = sessionRange(session) || [block.bucket, block.bucket];
  focus.value = {
    sessionId: session.id,
    bucket: block.bucket,
    range,
    title: session.title,
  };
  scrollToChart();
}

function clearFocus() {
  focus.value = null;
}

function scrollToChart() {
  requestAnimationFrame(() => {
    chartPanel.value?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const wrap = chartScroll.value;
    if (!wrap || !focus.value || !data.value) return;
    const ratio = (focus.value.bucket + 0.5) / data.value.buckets.length;
    const left = Math.max(0, wrap.scrollWidth * ratio - wrap.clientWidth / 2);
    wrap.scrollTo({ left, behavior: 'smooth' });
  });
}

const option = computed(() => {
  const d = data.value;
  if (!d) return {};
  const labels = d.buckets.map((b) => b.label);
  const focusBucket = focus.value ? d.buckets[focus.value.bucket] : null;
  const focusRange = focus.value?.range;
  const markLine = focusBucket
    ? {
        silent: true,
        symbol: 'none',
        lineStyle: { color: '#fca5a5', width: 1, type: 'dashed' },
        label: {
          show: true,
          formatter: focusBucket.label,
          color: '#fca5a5',
          fontSize: 10,
        },
        data: [{ xAxis: focusBucket.label }],
      }
    : undefined;
  const markArea =
    focusRange && d.buckets[focusRange[0]] && d.buckets[focusRange[1]]
      ? {
          silent: true,
          itemStyle: { color: 'rgba(94,234,212,0.06)' },
          data: [
            [
              { xAxis: d.buckets[focusRange[0]].label },
              { xAxis: d.buckets[focusRange[1]].label },
            ],
          ],
        }
      : undefined;

  return {
    backgroundColor: 'transparent',
    animation: false,
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    legend: {
      top: 4,
      right: 8,
      itemWidth: 9,
      itemHeight: 9,
      textStyle: { color: '#94a3b8', fontSize: 10 },
      data: ['工具', '子代理', 'Skill', 'MCP', '用户指令'],
    },
    grid: [
      { left: 44, right: 76, top: 36, height: 54, containLabel: false },
      { left: 44, right: 76, top: 108, bottom: 26, containLabel: false },
    ],
    xAxis: [
      {
        type: 'category',
        gridIndex: 0,
        data: labels,
        boundaryGap: true,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { show: false },
      },
      {
        type: 'category',
        gridIndex: 1,
        data: labels,
        boundaryGap: true,
        axisLine: { lineStyle: { color: 'rgba(148,163,184,0.15)' } },
        axisTick: { show: false },
        axisLabel: { color: '#64748b', fontSize: 10, hideOverlap: true },
      },
    ],
    yAxis: [
      { gridIndex: 0, min: 0, max: 1, show: false },
      {
        gridIndex: 1,
        type: 'value',
        minInterval: 1,
        splitLine: { lineStyle: { color: 'rgba(148,163,184,0.07)' } },
        axisLabel: { color: '#64748b', fontSize: 10 },
      },
      {
        gridIndex: 1,
        type: 'value',
        position: 'right',
        offset: 0,
        minInterval: 1,
        splitLine: { show: false },
        axisLabel: { color: '#5eead4', fontSize: 9 },
      },
      {
        gridIndex: 1,
        type: 'value',
        position: 'right',
        offset: 34,
        minInterval: 1,
        splitLine: { show: false },
        axisLabel: { color: '#a78bfa', fontSize: 9 },
      },
    ],
    tooltip: {
      trigger: 'axis',
      confine: true,
      backgroundColor: 'rgba(15,20,30,0.96)',
      borderColor: 'rgba(255,255,255,0.1)',
      textStyle: { color: '#e2e8f0', fontSize: 11 },
      formatter: (params) => {
        const list = Array.isArray(params) ? params : [params];
        const first = list[0];
        if (!first) return '';
        const bucket = d.buckets[first.dataIndex];
        if (!bucket) return '';
        const prompts = promptMap.value.get(first.dataIndex) || [];
        const lines = [
          `<b>${escapeHtml(bucket.label)}</b>`,
          `工具 ${bucket.tools} · 子代理 ${bucket.subagent}`,
          `Skill ${bucket.skills} · MCP ${bucket.mcp} · 失败 ${bucket.errors}`,
        ];
        if (prompts.length) {
          lines.push('', `<span style="color:#fca5a5">用户指令 ${prompts.length}</span>`);
          for (const prompt of prompts.slice(0, 3)) {
            lines.push(
              `• ${localTime(prompt.ts)} <span style="color:#94a3b8">${escapeHtml(
                prompt.sessionTitle
              )}</span> ${escapeHtml(prompt.text.slice(0, 80))}`
            );
          }
          if (prompts.length > 3) lines.push(`… 另 ${prompts.length - 3} 条`);
        }
        return lines.join('<br/>');
      },
    },
    series: [
      {
        name: '工具',
        type: 'bar',
        stack: 'actions',
        xAxisIndex: 1,
        yAxisIndex: 1,
        barMaxWidth: 16,
        itemStyle: { color: '#38bdf8' },
        markLine,
        markArea,
        data: d.buckets.map((b) => b.tools),
      },
      {
        name: '子代理',
        type: 'bar',
        stack: 'actions',
        xAxisIndex: 1,
        yAxisIndex: 1,
        barMaxWidth: 16,
        itemStyle: { color: '#fbbf24' },
        data: d.buckets.map((b) => b.subagent),
      },
      {
        name: 'Skill',
        type: 'line',
        xAxisIndex: 1,
        yAxisIndex: 2,
        symbol: 'circle',
        symbolSize: 4,
        lineStyle: { width: 1.5, color: '#5eead4' },
        itemStyle: { color: '#5eead4' },
        data: d.buckets.map((b) => b.skills),
      },
      {
        name: 'MCP',
        type: 'line',
        xAxisIndex: 1,
        yAxisIndex: 3,
        symbol: 'circle',
        symbolSize: 4,
        lineStyle: { width: 1.5, color: '#a78bfa' },
        itemStyle: { color: '#a78bfa' },
        data: d.buckets.map((b) => b.mcp),
      },
      {
        name: '用户指令',
        type: 'scatter',
        xAxisIndex: 0,
        yAxisIndex: 0,
        symbol: 'diamond',
        z: 10,
        data: promptScatter.value,
      },
    ],
  };
});

function sessionBlocks(session) {
  const length = data.value?.buckets.length || 0;
  if (!length) return [];
  const unit = 100 / length;
  const width = Math.max(0.35, unit * 0.72);
  const maxAction = Math.max(1, ...session.buckets);
  const blocks = [];

  session.buckets.forEach((count, bucket) => {
    if (count <= 0) return;
    blocks.push({
      bucket,
      left: bucket * unit,
      width,
      opacity: 0.22 + 0.78 * (Math.log(1 + count) / Math.log(1 + maxAction)),
      count,
      prompts: session.promptBuckets?.[bucket] || 0,
      hollow: false,
    });
  });

  (session.promptBuckets || []).forEach((count, bucket) => {
    if (count <= 0 || session.buckets[bucket] > 0) return;
    blocks.push({
      bucket,
      left: bucket * unit,
      width,
      opacity: 1,
      count: 0,
      prompts: count,
      hollow: true,
    });
  });

  return blocks;
}

function blockTitle(session, block) {
  const label = data.value?.buckets[block.bucket]?.label || '';
  return `${label} · 动作 ${block.count} · 用户指令 ${block.prompts}${
    session.historyOnly ? ' · 仅输入历史' : ''
  }`;
}

function openSessionRow(session) {
  if (session && !session.historyOnly) emit('open-session', session.id);
}

function onChartClick(params) {
  if (params.seriesName !== '用户指令') return;
  const item = params.data || promptScatter.value[params.dataIndex];
  if (item?.sessionId && !item.historyOnly) emit('open-session', item.sessionId);
}

async function load({ refresh = false } = {}) {
  if (disposed) return;
  const my = ++seq;
  ctrl?.abort();
  ctrl = new AbortController();

  if (refresh) refreshing.value = true;
  else {
    loading.value = true;
    error.value = '';
  }

  try {
    const params = new URLSearchParams({ cwd: props.cwd });
    if (refresh) params.set('refresh', '1');
    const res = await fetch(`/api/projects/history?${params}`, { signal: ctrl.signal });
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const json = await res.json();
        message = json.error || message;
      } catch {
        // ignore
      }
      throw new Error(message);
    }
    const json = await res.json();
    if (my !== seq || disposed) return;
    data.value = json;
    error.value = '';
    focus.value = null;
    showAllSessions.value = false;
  } catch (err) {
    if (err.name === 'AbortError' || my !== seq || disposed) return;
    error.value = err.message || '项目历史加载失败';
  } finally {
    if (my === seq && !disposed) {
      loading.value = false;
      refreshing.value = false;
    }
  }
}

watch(
  () => props.cwd,
  () => {
    data.value = null;
    error.value = '';
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
  ctrl?.abort();
  window.removeEventListener('keydown', onKeydown);
});

function pad(n) {
  return String(n).padStart(2, '0');
}

function localDate(ts) {
  const d = new Date(ts);
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
}

function localTime(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localDateTime(ts) {
  return `${localDate(ts)} ${localTime(ts)}`;
}

const HTML_ESCAPE = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => HTML_ESCAPE[ch]);
}
</script>

<style scoped>
.project-page {
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
.refresh,
.retry,
.more {
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

.back:hover,
.refresh:hover,
.retry:hover,
.more:hover {
  color: var(--text-1);
  border-color: rgba(94, 234, 212, 0.35);
}

.refresh:disabled,
.more:disabled {
  opacity: 0.45;
  cursor: default;
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
  font-weight: 650;
  color: var(--text-1);
}

.path {
  font-family: ui-monospace, 'SF Mono', 'Cascadia Code', monospace;
  font-size: 10.5px;
  color: var(--text-3);
  background: rgba(148, 163, 184, 0.07);
  padding: 2px 7px;
  border-radius: 5px;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conn {
  font-size: 10.5px;
  color: var(--text-3);
}

.conn.on {
  color: #6ee7b7;
}

.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  font-size: 11px;
  color: var(--text-3);
}

.stats {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 10px;
  max-width: 780px;
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
}

.stat b {
  font-family: ui-monospace, 'SF Mono', 'Cascadia Code', monospace;
  font-size: 17px;
  font-variant-numeric: tabular-nums;
  color: var(--text-1);
  font-weight: 650;
}

.stat b.err {
  color: #fca5a5;
}

.stat span {
  font-size: 10px;
  color: var(--text-3);
}

.warn-box {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  align-items: baseline;
  padding: 8px 12px;
  border: 1px solid rgba(251, 191, 36, 0.28);
  border-radius: 9px;
  background: rgba(251, 191, 36, 0.06);
  color: #fbbf24;
  font-size: 10.5px;
}

.warn-box strong {
  font-weight: 600;
}

.chart-panel,
.track-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.chart-scroll {
  overflow-x: auto;
  padding: 0 8px 8px;
}

.chart-inner {
  min-width: 760px;
}

.focus-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  padding: 2px 7px;
  border-radius: 99px;
  border: 1px solid rgba(252, 165, 165, 0.35);
  background: rgba(252, 165, 165, 0.07);
  color: #fca5a5;
  font-size: 10px;
}

.focus-chip button {
  appearance: none;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  line-height: 1;
  cursor: pointer;
  padding: 0 1px;
}

.track-inner {
  padding: 6px 0 8px;
}

.open-session {
  appearance: none;
  border: 1px solid var(--line);
  background: transparent;
  color: #5eead4;
  font: inherit;
  font-size: 10px;
  line-height: 1;
  padding: 3px 8px;
  border-radius: 99px;
  cursor: pointer;
  white-space: nowrap;
}

.open-session:hover {
  border-color: rgba(94, 234, 212, 0.4);
  color: #99f6e4;
}

.track-row.focused {
  background: rgba(94, 234, 212, 0.045);
  border-radius: 7px;
}

.track-row {
  padding: 6px 6px 8px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.06);
  cursor: pointer;
}

.track-row:last-child {
  border-bottom: 0;
}

.track-row.historyOnly {
  cursor: default;
  opacity: 0.68;
}

.track-row:focus-visible {
  outline: 2px solid rgba(94, 234, 212, 0.6);
  outline-offset: -1px;
  border-radius: 6px;
}

.track-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}

.t-title {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 55%;
}

.track-row:hover .t-title {
  color: #5eead4;
}

.t-meta {
  margin-left: auto;
  font-size: 10px;
  color: var(--text-3);
  white-space: nowrap;
}

.track-line {
  position: relative;
  height: 12px;
  margin: 4px 76px 0 44px;
  border-radius: 4px;
  background: rgba(148, 163, 184, 0.06);
}

.track-block {
  position: absolute;
  top: 2px;
  height: 8px;
  border-radius: 2px;
  background: #5eead4;
}

.track-block.hollow {
  background: transparent;
  border: 1px solid #94a3b8;
  opacity: 0.7 !important;
}

.track-block.focused {
  outline: 2px solid #fca5a5;
  outline-offset: 1px;
  z-index: 1;
}

.track-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding: 0 14px 10px;
  font-size: 10.5px;
  color: var(--text-3);
}

.state {
  display: grid;
  place-content: center;
  gap: 8px;
  min-height: 220px;
  color: var(--text-3);
  font-size: 12px;
}

@media (max-width: 1100px) {
  .stats {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    max-width: none;
  }
}
</style>
