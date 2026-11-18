<template>
  <section class="panel catalog-panel">
    <header class="panel-head">
      <div class="panel-title">
        技能目录
        <span v-if="catalog" class="count">{{ countText }}</span>
        <span class="hint">按调用次数排序</span>
      </div>

      <div class="controls">
        <input
          v-model="query"
          type="search"
          class="search"
          placeholder="搜索名称或描述"
          aria-label="搜索技能"
        />
        <div class="filters" role="group" aria-label="筛选技能">
          <button
            v-for="f in FILTERS"
            :key="f.key"
            type="button"
            :class="{ active: filter === f.key }"
            :aria-pressed="filter === f.key"
            @click="filter = f.key"
          >
            {{ f.label }}
          </button>
        </div>
      </div>
    </header>

    <div class="catalog-body">
      <div v-if="loading" class="state">加载技能目录…</div>
      <div v-else-if="error" class="state">
        {{ error }}
        <button type="button" class="retry" @click="load">重试</button>
      </div>
      <div v-else-if="!list.length" class="state">没有匹配的技能</div>
      <ul v-else class="skill-list">
        <li v-for="sk in list" :key="sk.name" class="skill-row">
          <code class="skill-name" :title="sk.name">{{ sk.name }}</code>
          <span class="skill-src" :class="sk.sourceType">{{ sk.source }}</span>
          <span class="skill-desc" :title="sk.description">{{ sk.description || '（无描述）' }}</span>
          <span class="skill-use" :class="{ zero: !usageOf(sk.name) }">
            {{ usageOf(sk.name) ? `${usageOf(sk.name)} 次` : '未调用' }}
          </span>
        </li>
      </ul>
    </div>

    <p v-if="missing.length" class="catalog-foot">
      历史调用中另有 {{ missing.length }} 个已不在本机：{{ missingNames }}
    </p>
  </section>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';

const props = defineProps({
  usage: { type: Array, default: () => [] },
});

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'user', label: '用户' },
  { key: 'plugin', label: '插件' },
  { key: 'used', label: '已调用' },
];

const catalog = ref(null);
const loading = ref(true);
const error = ref('');
const query = ref('');
const filter = ref('all');

let ctrl = null;
let disposed = false;

const usageMap = computed(() => new Map((props.usage || []).map((u) => [u.name, u.count])));
const total = computed(() => catalog.value?.skills.length || 0);

const list = computed(() => {
  let items = catalog.value?.skills || [];
  if (filter.value === 'user') items = items.filter((s) => s.sourceType === 'user');
  if (filter.value === 'plugin') items = items.filter((s) => s.sourceType === 'plugin');
  if (filter.value === 'used') items = items.filter((s) => usageOf(s.name) > 0);

  const q = query.value.trim().toLowerCase();
  if (q) {
    items = items.filter(
      (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)
    );
  }

  return items
    .slice()
    .sort(
      (a, b) => usageOf(b.name) - usageOf(a.name) || a.name.localeCompare(b.name)
    );
});

const countText = computed(() =>
  list.value.length === total.value ? total.value : `${list.value.length} / ${total.value}`
);

const missing = computed(() => {
  const known = new Set((catalog.value?.skills || []).map((s) => s.name));
  return (props.usage || []).filter((u) => !known.has(u.name)).sort((a, b) => b.count - a.count);
});

const missingNames = computed(() => {
  const names = missing.value.map((m) => m.name);
  return names.length > 6 ? `${names.slice(0, 6).join('、')} 等` : names.join('、');
});

function usageOf(name) {
  return usageMap.value.get(name) || 0;
}

async function load() {
  ctrl?.abort();
  ctrl = new AbortController();
  loading.value = true;
  error.value = '';
  try {
    const res = await fetch('/api/skills', { signal: ctrl.signal });
    if (!res.ok) throw new Error(`skills ${res.status}`);
    catalog.value = await res.json();
  } catch (err) {
    if (err.name === 'AbortError' || disposed) return;
    error.value = '技能目录加载失败';
  } finally {
    if (!disposed) loading.value = false;
  }
}

onMounted(load);
onUnmounted(() => {
  disposed = true;
  ctrl?.abort();
});
</script>

<style scoped>
.catalog-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.catalog-panel .panel-head {
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
}

.count {
  font-size: 10.5px;
  font-weight: 500;
  color: var(--text-3);
  background: rgba(148, 163, 184, 0.1);
  padding: 1px 6px;
  border-radius: 99px;
}

.controls {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.search {
  width: 220px;
  background: rgba(148, 163, 184, 0.07);
  border: 1px solid var(--line);
  border-radius: 7px;
  color: var(--text-1);
  font: inherit;
  font-size: 11px;
  padding: 5px 9px;
  min-height: 26px;
}

.search::placeholder {
  color: var(--text-3);
}

.search:focus {
  outline: none;
  border-color: rgba(94, 234, 212, 0.45);
}

.filters {
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: 9px;
  background: rgba(148, 163, 184, 0.07);
}

.filters button {
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
}

.filters button:hover {
  color: var(--text-2);
}

.filters button.active {
  color: var(--text-1);
  background: rgba(94, 234, 212, 0.14);
  border-color: rgba(94, 234, 212, 0.45);
}

.filters button:focus-visible {
  outline: 2px solid rgba(94, 234, 212, 0.6);
  outline-offset: 1px;
}

.catalog-body {
  max-height: 440px;
  overflow-y: auto;
}

.skill-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.skill-row {
  display: grid;
  grid-template-columns: minmax(160px, 220px) 152px minmax(0, 1fr) 60px;
  gap: 12px;
  align-items: baseline;
  padding: 9px 14px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.07);
}

.skill-row:last-child {
  border-bottom: 0;
}

.skill-row:hover {
  background: rgba(148, 163, 184, 0.04);
}

.skill-name {
  font-family: ui-monospace, 'SF Mono', 'Cascadia Code', monospace;
  font-size: 11.5px;
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.skill-src {
  font-size: 10px;
  color: var(--text-3);
  background: rgba(148, 163, 184, 0.07);
  padding: 2px 7px;
  border-radius: 99px;
  justify-self: start;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.skill-src.plugin {
  color: #c4b5fd;
  background: rgba(167, 139, 250, 0.12);
}

.skill-desc {
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--text-2);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.skill-use {
  font-family: ui-monospace, 'SF Mono', 'Cascadia Code', monospace;
  font-size: 10.5px;
  color: #5eead4;
  text-align: right;
  white-space: nowrap;
}

.skill-use.zero {
  color: var(--text-3);
}

.state {
  display: grid;
  place-content: center;
  gap: 8px;
  min-height: 120px;
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

.catalog-foot {
  margin: 0;
  padding: 8px 14px 10px;
  border-top: 1px solid var(--line);
  font-size: 10.5px;
  color: var(--text-3);
  line-height: 1.5;
}

@media (max-width: 900px) {
  .skill-row {
    grid-template-columns: auto minmax(0, 1fr) auto;
    row-gap: 4px;
  }

  .skill-name {
    grid-column: 1;
    grid-row: 1;
    max-width: 100%;
    white-space: normal;
    overflow-wrap: anywhere;
  }

  .skill-src {
    grid-column: 2;
    grid-row: 1;
  }

  .skill-use {
    grid-column: 3;
    grid-row: 1;
    text-align: right;
  }

  .skill-desc {
    grid-column: 1 / -1;
    grid-row: 2;
  }
}
</style>
