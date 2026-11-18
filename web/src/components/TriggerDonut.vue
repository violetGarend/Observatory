<template>
  <section class="panel">
    <header class="panel-head">
      <div class="panel-title">触发来源</div>
      <span class="hint">{{ hintText }}</span>
    </header>

    <div class="donut-body">
      <div class="ring">
        <BaseChart :option="option" height="100%" @click="onSliceClick" />
        <div class="center">
          <strong>{{ displayCount }}</strong>
          <span>{{ displayLabel }}</span>
        </div>
      </div>

      <ul class="legend">
        <li v-for="row in rows" :key="row.key">
          <button
            type="button"
            class="legend-item"
            :class="{ active: selected === row.key, disabled: !row.count }"
            :disabled="!row.count"
            :aria-pressed="selected === row.key"
            :title="row.count ? (selected === row.key ? '再次点击取消筛选' : `只看${row.label}`) : '暂无调用'"
            @click="pick(row)"
          >
            <span class="swatch" :style="{ background: row.color }"></span>
            <span class="label">{{ row.label }}</span>
            <span class="value">{{ row.count }}</span>
            <span class="pct">{{ row.pct }}</span>
          </button>
        </li>
      </ul>
    </div>
  </section>
</template>

<script setup>
import { computed } from 'vue';
import BaseChart from './BaseChart.vue';
import { TRIGGER_META, percent } from '../lib/format.js';

const props = defineProps({
  triggers: { type: Object, default: () => ({}) },
  selected: { type: String, default: null },
});

const emit = defineEmits(['select']);

const total = computed(() =>
  Object.values(props.triggers).reduce((a, b) => a + (b || 0), 0)
);

const rows = computed(() =>
  Object.entries(TRIGGER_META).map(([key, meta]) => {
    const count = props.triggers[key] || 0;
    return {
      key,
      label: meta.label,
      color: meta.color,
      count,
      pct: total.value ? percent(count / total.value, 0) : '0%',
    };
  })
);

const selectedRow = computed(() => rows.value.find((r) => r.key === props.selected) || null);
const displayCount = computed(() => (selectedRow.value ? selectedRow.value.count : total.value));
const displayLabel = computed(() => (selectedRow.value ? selectedRow.value.label : 'skill 调用'));
const hintText = computed(() =>
  selectedRow.value ? `已筛选 · ${selectedRow.value.label} · 再点一次取消` : '谁让 skill 跑起来的 · 点击图例筛选'
);

function pick(row) {
  if (!row.count) return;
  emit('select', props.selected === row.key ? null : row.key);
}

function onSliceClick(params) {
  const key = params?.data?.key;
  const row = rows.value.find((r) => r.key === key);
  if (row) pick(row);
}

const option = computed(() => ({
  backgroundColor: 'transparent',
  tooltip: {
    trigger: 'item',
    backgroundColor: 'rgba(15,20,30,0.95)',
    borderColor: 'rgba(255,255,255,0.1)',
    textStyle: { color: '#e2e8f0', fontSize: 12 },
    formatter: '{b}: {c} 次 ({d}%)',
  },
  series: [
    {
      type: 'pie',
      radius: ['62%', '84%'],
      center: ['50%', '50%'],
      avoidLabelOverlap: true,
      cursor: 'pointer',
      itemStyle: { borderColor: '#0c1119', borderWidth: 2, borderRadius: 4 },
      label: { show: false },
      labelLine: { show: false },
      emphasis: { scale: true, scaleSize: 4 },
      data: rows.value
        .filter((r) => r.count > 0)
        .map((r) => ({
          key: r.key,
          name: r.label,
          value: r.count,
          itemStyle: {
            color: r.color,
            opacity: props.selected && props.selected !== r.key ? 0.3 : 1,
          },
        })),
    },
  ],
}));
</script>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.donut-body {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px 10px;
}

.ring {
  position: relative;
  flex: 0 0 46%;
  height: 100%;
  min-height: 110px;
}

.center {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}

.center strong {
  font-size: 24px;
  font-weight: 700;
  font-family: ui-monospace, monospace;
  font-variant-numeric: tabular-nums;
  color: #f1f5f9;
  line-height: 1;
}

.center span {
  margin-top: 3px;
  font-size: 10px;
  color: var(--text-3);
}

.legend {
  list-style: none;
  margin: 0;
  padding: 0;
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.legend li {
  min-width: 0;
}

.legend-item {
  appearance: none;
  width: 100%;
  display: grid;
  grid-template-columns: 10px 1fr auto 44px;
  align-items: center;
  gap: 8px;
  font: inherit;
  font-size: 12px;
  text-align: left;
  color: inherit;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 7px;
  padding: 2px 6px;
  margin: 0 -6px;
  cursor: pointer;
}

.legend-item:hover {
  background: rgba(148, 163, 184, 0.06);
}

.legend-item.active {
  background: rgba(148, 163, 184, 0.1);
  border-color: rgba(148, 163, 184, 0.3);
}

.legend-item.disabled {
  cursor: default;
  opacity: 0.45;
}

.legend-item:focus-visible {
  outline: 2px solid rgba(94, 234, 212, 0.6);
  outline-offset: 1px;
}

.swatch {
  width: 8px;
  height: 8px;
  border-radius: 2px;
}

.label {
  color: var(--text-2);
}

.value {
  font-variant-numeric: tabular-nums;
  color: var(--text-1);
  font-weight: 600;
}

.pct {
  text-align: right;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
</style>
