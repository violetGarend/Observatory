<template>
  <div ref="wrap" class="star-wrap">
    <div v-if="!nodes.length" class="star-empty">未扫描到技能</div>

    <template v-else>
      <svg
        viewBox="0 0 860 460"
        class="star-svg"
        aria-hidden="true"
        role="presentation"
        focusable="false"
      >
        <g class="sectors">
          <path v-for="s in sectorList" :key="s.key" :d="s.path" class="sector" />
        </g>

        <g class="group-labels">
          <text
            v-for="s in sectorList"
            :key="`${s.key}-label`"
            :x="s.labelX"
            :y="s.labelY"
            text-anchor="middle"
          >
            {{ s.label }} · {{ s.count }}
          </text>
        </g>

        <g class="nodes">
          <circle
            v-for="n in nodes"
            :key="n.name"
            :cx="n.x"
            :cy="n.y"
            :r="n.r"
            class="node"
            :class="{ observed: n.observed, candidate: candidateSet.has(n.name) }"
            @mouseenter="showTip(n, $event)"
            @mousemove="moveTip($event)"
            @mouseleave="hideTip"
          />
        </g>

        <g class="anchor-labels">
          <text
            v-for="l in labels"
            :key="l.name"
            :x="l.x"
            :y="l.y"
            :text-anchor="l.anchor"
            :class="{ candidate: l.candidate }"
          >
            {{ l.name }}
          </text>
        </g>
      </svg>

      <div v-if="tip" class="tip" :style="{ left: `${tip.left}px`, top: `${tip.top}px` }">
        <strong>{{ tip.name }}</strong>
        <span>{{ tip.source }} · tokens_high {{ tip.tokensHigh }}</span>
        <span>窗口调用 {{ tip.invocations }} · 提及 {{ tip.mentionStrong }}/{{ tip.mentionWeak }}</span>
        <span>{{ tip.observed ? '观测到' : '未观测到' }}</span>
      </div>

      <div class="star-legend">
        <span><i class="dot observed"></i>观测到</span>
        <span><i class="dot unobserved"></i>未观测到</span>
        <span>半径 = 0.4·√tokens_high，面积 ∝ tokens_high</span>
        <span>{{ nodes.length }} 节点 · {{ counts }}</span>
        <span>仅标注分组与锚点，完整事实见清单</span>
      </div>
    </template>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue';
import { layoutStarMap, sectorPath } from '../lib/starLayout.js';

const props = defineProps({
  skills: { type: Array, default: () => [] },
  candidates: { type: Array, default: () => [] },
});

const MAX_ANCHORS = 15;

const wrap = ref(null);
const layout = computed(() => layoutStarMap(props.skills));
const nodes = computed(() => layout.value.nodes);
const candidateSet = computed(() => new Set(props.candidates.map((c) => c.name)));

const sectorList = computed(() =>
  layout.value.sectors.map((s) => {
    const mid = (s.startAngle + s.endAngle) / 2;
    const radius = s.rOuter + 18;
    return {
      ...s,
      path: sectorPath(
        layout.value.center.x,
        layout.value.center.y,
        s.rInner,
        s.rOuter,
        s.startAngle,
        s.endAngle
      ),
      labelX: layout.value.center.x + radius * Math.cos(mid),
      labelY: layout.value.center.y + radius * Math.sin(mid) + 3,
    };
  })
);

const counts = computed(() =>
  sectorList.value.map((s) => `${s.label} ${s.count}`).join(' · ')
);

const labels = computed(() => {
  const cand = nodes.value.filter((n) => candidateSet.value.has(n.name));
  const top = [...nodes.value].sort((a, b) => b.tokensHigh - a.tokensHigh).slice(0, 10);

  const seen = new Set();
  const pool = [];
  for (const n of [...cand, ...top]) {
    if (seen.has(n.name)) continue;
    seen.add(n.name);
    pool.push(n);
  }

  // 锚点超过 15 个时只保留候选，保证标签不打架
  const anchors = (pool.length > MAX_ANCHORS ? cand : pool)
    .slice()
    .sort((a, b) => b.tokensHigh - a.tokensHigh);

  const placed = [];
  const occupied = [];

  for (const n of anchors) {
    const right = Math.cos(n.angle) >= 0;
    const x = n.x + (right ? n.r + 5 : -(n.r + 5));
    const width = Math.min(168, n.name.length * 6.8 + 10);
    const baseY = n.y + 3.5;
    const isCandidate = candidateSet.value.has(n.name);

    let chosen = null;
    for (const dy of [0, -14, 14, -28, 28, -42, 42]) {
      const y = baseY + dy;
      // 外扩 4px，避免两个标签只是「刚好不重叠」却挤在一起
      const box = {
        x1: (right ? x : x - width) - 4,
        x2: (right ? x + width : x) + 4,
        y1: y - 9 - 4,
        y2: y + 3 + 4,
      };
      const hit = occupied.some(
        (o) => box.x1 < o.x2 && box.x2 > o.x1 && box.y1 < o.y2 && box.y2 > o.y1
      );
      if (hit) continue;
      occupied.push(box);
      chosen = { ...n, x, y, anchor: right ? 'start' : 'end', candidate: isCandidate };
      break;
    }
    if (chosen) placed.push(chosen);
  }

  return placed;
});

const tip = ref(null);

function showTip(node, event) {
  positionTip(event, node);
}

function moveTip(event) {
  if (tip.value) positionTip(event, tip.value);
}

function positionTip(event, node) {
  const box = wrap.value?.getBoundingClientRect();
  if (!box) return;
  const left = Math.min(Math.max(8, event.clientX - box.left + 12), Math.max(8, box.width - 196));
  const top = Math.max(8, event.clientY - box.top + 12);
  tip.value = { ...node, left, top };
}

function hideTip() {
  tip.value = null;
}
</script>

<style scoped>
.star-wrap {
  position: relative;
  min-width: 0;
}

.star-svg {
  display: block;
  width: 100%;
  min-width: 700px;
  height: auto;
}

.sector {
  fill: rgba(148, 163, 184, 0.035);
  stroke: rgba(148, 163, 184, 0.11);
  stroke-width: 0.6;
}

.group-labels text {
  fill: var(--text-3);
  font-size: 10px;
  letter-spacing: 0.04em;
}

.node {
  stroke: rgba(148, 163, 184, 0.55);
  stroke-width: 0.8;
  fill: rgba(148, 163, 184, 0.08);
}

.node.observed {
  fill: rgba(94, 234, 212, 0.82);
  stroke: rgba(94, 234, 212, 0.95);
}

.node.candidate {
  stroke-width: 1.4;
}

.anchor-labels text {
  fill: var(--text-3);
  font-family: ui-monospace, 'SF Mono', 'Cascadia Code', monospace;
  font-size: 10.5px;
  pointer-events: none;
}

.anchor-labels text.candidate {
  fill: var(--text-1);
  font-weight: 600;
}

.tip {
  position: absolute;
  z-index: 3;
  width: 184px;
  padding: 7px 9px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: rgba(10, 14, 22, 0.96);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 10.5px;
  color: var(--text-2);
  pointer-events: none;
}

.tip strong {
  font-family: ui-monospace, 'SF Mono', 'Cascadia Code', monospace;
  font-size: 11px;
  color: var(--text-1);
  font-weight: 600;
  overflow-wrap: anywhere;
}

.star-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  padding: 4px 2px 0;
  font-size: 10px;
  color: var(--text-3);
}

.star-legend span {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.dot.observed {
  background: #5eead4;
}

.dot.unobserved {
  background: transparent;
  border: 1px solid rgba(148, 163, 184, 0.55);
}

.star-empty {
  display: grid;
  place-content: center;
  min-height: 240px;
  color: var(--text-3);
  font-size: 12px;
}
</style>
