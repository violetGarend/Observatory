<template>
  <div ref="el" class="chart" :style="{ height }"></div>
</template>

<script setup>
import { onMounted, onUnmounted, ref, watch } from 'vue';
import * as echarts from 'echarts';

const props = defineProps({
  option: { type: Object, required: true },
  height: { type: String, default: '100%' },
});

const emit = defineEmits(['click']);

const el = ref(null);
let chart = null;
let observer = null;

onMounted(() => {
  chart = echarts.init(el.value, null, { renderer: 'canvas' });
  chart.setOption(props.option);
  chart.on('click', (params) => emit('click', params));
  observer = new ResizeObserver(() => chart?.resize());
  observer.observe(el.value);
});

watch(
  () => props.option,
  (opt) => chart?.setOption(opt, { notMerge: true }),
  { deep: true }
);

onUnmounted(() => {
  observer?.disconnect();
  chart?.dispose();
  chart = null;
});
</script>

<style scoped>
.chart {
  width: 100%;
  min-height: 120px;
}
</style>
