<template>
  <section class="panel ranking-panel">
    <header class="panel-head">
      <div class="panel-title">Skill 调用排行</div>
      <span class="hint">
        {{ sourceHint }}
        <template v-if="total > TOP"> · 滚轮浏览 {{ rangeText }}</template>
      </span>
    </header>

    <div v-if="total" class="ranking-wrap" @wheel="onWheel">
      <BaseChart :option="option" height="100%" class="ranking-chart" />
    </div>

    <div v-else class="empty">
      {{ triggerMeta ? '该触发来源下还没有调用记录' : '还没有任何 skill 调用记录' }}
    </div>
  </section>
</template>

<script setup>
import { computed, ref, watch } from 'vue';
import BaseChart from './BaseChart.vue';
import { TRIGGER_META } from '../lib/format.js';

const props = defineProps({
  skills: { type: Array, default: () => [] },
  trigger: { type: String, default: null },
});

const TOP = 10;

const triggerMeta = computed(() => (props.trigger ? TRIGGER_META[props.trigger] : null));

// 选中某个触发来源时，按该来源的次数排序并过滤掉 0 次的技能
const ranked = computed(() => {
  if (!triggerMeta.value) return props.skills.map((s) => ({ ...s, score: s.count }));
  return props.skills
    .map((s) => ({ ...s, score: s.triggers?.[props.trigger] || 0 }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
});

const offset = ref(0);
const total = computed(() => ranked.value.length);
const maxOffset = computed(() => Math.max(0, total.value - TOP));
const rangeText = computed(
  () => `${offset.value + 1}–${Math.min(offset.value + TOP, total.value)} / ${total.value}`
);
const sourceHint = computed(() =>
  triggerMeta.value
    ? `${triggerMeta.value.label} · 再点图例取消`
    : '历史调用 · 含斜杠命令'
);

const visible = computed(() => ranked.value.slice(offset.value, offset.value + TOP));

// 数据变短时把窗口拉回合法范围
watch(total, () => {
  if (offset.value > maxOffset.value) offset.value = maxOffset.value;
});

// 切换筛选时回到榜首
watch(
  () => props.trigger,
  () => {
    offset.value = 0;
  }
);

/** 只在真的能翻页时拦截滚轮；到顶/到底后把滚动交还给页面 */
function onWheel(e) {
  if (maxOffset.value <= 0) return;
  const dir = e.deltaY > 0 ? 1 : -1;
  const next = Math.min(maxOffset.value, Math.max(0, offset.value + dir));
  if (next === offset.value) return;
  e.preventDefault();
  offset.value = next;
}

const option = computed(() => {
  const data = visible.value.slice().reverse();
  return {
    backgroundColor: 'transparent',
    grid: { left: 8, right: 40, top: 6, bottom: 6, containLabel: true },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      backgroundColor: 'rgba(15,20,30,0.95)',
      borderColor: 'rgba(255,255,255,0.1)',
      textStyle: { color: '#e2e8f0', fontSize: 12 },
      formatter: (p) => {
        const i = p[0].dataIndex;
        const s = data[i];
        const main = triggerMeta.value
          ? `${triggerMeta.value.label} ${s.score} 次 · 总计 ${s.count} 次`
          : `调用 ${s.count} 次`;
        return `<b>${s.name}</b><br/>${main} · ${s.sessions} 个会话<br/>来源：用户 ${s.triggers.user} / 自主 ${s.triggers.proactive} / 嵌套 ${s.triggers.nested}`;
      },
    },
    xAxis: {
      type: 'value',
      minInterval: 1,
      splitLine: { lineStyle: { color: 'rgba(148,163,184,0.08)' } },
      axisLabel: { color: '#64748b', fontSize: 10 },
    },
    yAxis: {
      type: 'category',
      data: data.map((s) => s.name),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: '#cbd5e1',
        fontSize: 10,
        width: 150,
        overflow: 'truncate',
        interval: 0,
      },
    },
    series: [
      {
        type: 'bar',
        data: data.map((s) => s.score),
        barWidth: '58%',
        itemStyle: {
          borderRadius: [0, 4, 4, 0],
          color: {
            type: 'linear',
            x: 0, y: 0, x2: 1, y2: 0,
            colorStops: triggerMeta.value
              ? [
                  { offset: 0, color: `${triggerMeta.value.color}55` },
                  { offset: 1, color: triggerMeta.value.color },
                ]
              : [
                  { offset: 0, color: 'rgba(94,234,212,0.35)' },
                  { offset: 1, color: '#5eead4' },
                ],
          },
        },
        label: {
          show: true,
          position: 'right',
          color: '#94a3b8',
          fontSize: 11,
          fontFamily: 'ui-monospace, monospace',
        },
      },
    ],
  };
});
</script>

<style scoped>
.ranking-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.ranking-wrap {
  flex: 1;
  min-height: 0;
}

.ranking-chart {
  height: 100%;
  min-height: 0;
  cursor: default;
}

.empty {
  flex: 1;
  display: grid;
  place-content: center;
  color: var(--text-3);
  font-size: 12px;
}
</style>
