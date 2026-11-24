<template>
  <div class="shell">
    <header class="topbar">
      <div class="brand">
        <div class="logo">◎</div>
        <div>
          <h1>观星台 <span class="brand-en">Observatory</span></h1>
          <p>Claude Code 行为观测台 · 实时转录 tail</p>
        </div>
      </div>

      <div class="status-group">
        <div class="status" :class="{ on: connected }">
          <span class="pulse"></span>
          {{ connected ? '实时连接' : '重连中' }}
        </div>
        <div class="source" v-if="health">
          <span class="k">数据源</span>
          <code>{{ health.projectsDir }}</code>
        </div>
      </div>
    </header>

    <ProjectHistory
      v-if="projectCwd"
      :cwd="projectCwd"
      :connected="connected"
      @back="goBack"
      @open-session="openSession"
    />

    <SessionDetail
      v-else-if="sessionId"
      :session-id="sessionId"
      :session="currentSession"
      :connected="connected"
      @back="goBack"
      @open-project="openProject"
    />

    <main v-else-if="snapshot" class="content">
      <section class="kpis">
        <article class="kpi accent-teal">
          <span class="kpi-label">Skill 调用</span>
          <strong class="kpi-value">{{ fullNumber(s.totals.skillCalls) }}</strong>
          <span class="kpi-sub">
            {{ s.skills.length }} 个不同 skill ·
            {{ s.sessionsTotal }} 个会话
          </span>
        </article>

        <article class="kpi accent-violet">
          <span class="kpi-label">Assistant 消息</span>
          <strong class="kpi-value">{{ compact(s.totals.messages) }}</strong>
          <span class="kpi-sub">{{ fullNumber(s.totals.toolCalls) }} 次工具调用</span>
        </article>

        <article class="kpi accent-amber">
          <span class="kpi-label">输出 token</span>
          <strong class="kpi-value">{{ compact(s.totals.output) }}</strong>
          <span class="kpi-sub">输入 {{ compact(s.totals.input) }} · 缓存读 {{ compact(s.totals.cacheRead) }}</span>
        </article>

        <article class="kpi accent-blue">
          <span class="kpi-label">缓存命中率</span>
          <strong class="kpi-value">{{ percent(s.cacheHitRate) }}</strong>
          <span class="kpi-sub">cache_read / (input + cache_read)</span>
        </article>
      </section>

      <section class="layout">
        <AgentPanel
          class="cell stream"
          :sessions="s.sessions || []"
          :events="events"
          :connected="connected"
          @open-session="openSession"
          @open-project="openProject"
        />

        <TriggerDonut
          class="cell donut"
          :triggers="s.triggers"
          :selected="triggerFilter"
          @select="triggerFilter = $event"
        />

        <SkillRanking class="cell ranking" :skills="s.skills" :trigger="triggerFilter" />

        <TokenTimeline
          class="cell timeline"
          :tick="s.generatedAt || 0"
          :connected="connected"
        />

        <SessionTable
          class="cell sessions"
          :sessions="s.sessions"
          :total="s.sessionsTotal"
          :active="s.activeSessions"
        />
      </section>

      <ConstellationPanel :tick="s.lastEventAt || 0" />

      <section class="catalog-row">
        <SkillCatalog :usage="s.skills || []" />
        <McpCatalog :usage="s.mcp || []" />
      </section>

      <footer class="foot">
        <span>最后事件 {{ relative(s.lastEventAt) }}</span>
        <span>事件流上限 {{ events.length }} 条</span>
        <span>扫描间隔 400ms · 零配置 tail</span>
      </footer>
    </main>

    <div v-else class="booting">
      <div class="spinner"></div>
      <p>正在回放会话转录…</p>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { useLive } from './lib/useLive.js';
import { useRoute } from './lib/useRoute.js';
import { projectUrl } from './lib/project.js';
import { compact, fullNumber, percent, relative } from './lib/format.js';
import AgentPanel from './components/AgentPanel.vue';
import TriggerDonut from './components/TriggerDonut.vue';
import SkillRanking from './components/SkillRanking.vue';
import TokenTimeline from './components/TokenTimeline.vue';
import SessionTable from './components/SessionTable.vue';
import SkillCatalog from './components/SkillCatalog.vue';
import McpCatalog from './components/McpCatalog.vue';
import ConstellationPanel from './components/ConstellationPanel.vue';
import SessionDetail from './components/SessionDetail.vue';
import ProjectHistory from './components/ProjectHistory.vue';

const { snapshot, events, connected } = useLive();
const health = ref(null);
const triggerFilter = ref(null);

const { path, search, navigate } = useRoute();
const sessionId = computed(() => {
  const match = /^\/sessions\/([^/]+)\/?$/.exec(path.value);
  return match ? decodeURIComponent(match[1]) : null;
});
const currentSession = computed(
  () => (snapshot.value?.sessions || []).find((item) => item.id === sessionId.value) || null
);
const projectCwd = computed(() => {
  if (!/^\/projects\/?$/.test(path.value)) return null;
  const cwd = new URLSearchParams(search.value).get('cwd') || '';
  return cwd.trim() || null;
});

function openSession(id) {
  navigate(`/sessions/${encodeURIComponent(id)}`, { state: { fromApp: true } });
}

function openProject(cwd) {
  if (!cwd) return;
  navigate(projectUrl(cwd), { state: { fromApp: true } });
}

/** 应用内跳转用 back；直接刷新进入则回首页 */
function goBack() {
  if (window.history.state?.fromApp) window.history.back();
  else navigate('/');
}

const s = computed(() => snapshot.value || {});

onMounted(async () => {
  try {
    const res = await fetch('/api/health');
    if (res.ok) health.value = await res.json();
  } catch {
    /* 忽略：后端未就绪时由 WS 重连兜底 */
  }
});
</script>

<style scoped>
.shell {
  max-width: 1680px;
  margin: 0 auto;
  padding: 20px 24px 12px;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* ---------- topbar ---------- */
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  flex-wrap: wrap;
}

.brand {
  display: flex;
  align-items: center;
  gap: 12px;
}

.logo {
  width: 38px;
  height: 38px;
  display: grid;
  place-content: center;
  border-radius: 10px;
  font-size: 20px;
  color: #5eead4;
  background: radial-gradient(circle at 30% 30%, rgba(94, 234, 212, 0.22), rgba(94, 234, 212, 0.04));
  border: 1px solid rgba(94, 234, 212, 0.3);
  box-shadow: 0 0 24px rgba(94, 234, 212, 0.12);
}

h1 {
  margin: 0;
  font-size: 16px;
  font-weight: 650;
  letter-spacing: 0.01em;
}

.brand p {
  margin: 2px 0 0;
  font-size: 11px;
  color: var(--text-3);
}

.brand-en {
  margin-left: 5px;
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--text-3);
}

.status-group {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}

.status {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: var(--text-2);
  padding: 5px 11px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: rgba(148, 163, 184, 0.05);
}

.status.on {
  color: #7ff0dc;
  border-color: rgba(94, 234, 212, 0.3);
}

.pulse {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #64748b;
}

.status.on .pulse {
  background: #5eead4;
  box-shadow: 0 0 0 0 rgba(94, 234, 212, 0.6);
  animation: ping 1.8s infinite;
}

@keyframes ping {
  0% { box-shadow: 0 0 0 0 rgba(94, 234, 212, 0.5); }
  70% { box-shadow: 0 0 0 7px rgba(94, 234, 212, 0); }
  100% { box-shadow: 0 0 0 0 rgba(94, 234, 212, 0); }
}

.source {
  font-size: 11px;
  color: var(--text-3);
  display: flex;
  gap: 7px;
  align-items: center;
}

.source code {
  font-size: 11px;
  color: var(--text-2);
  background: rgba(148, 163, 184, 0.07);
  padding: 3px 7px;
  border-radius: 5px;
}

/* ---------- content ---------- */
.content {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.kpis {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
}

.kpi {
  position: relative;
  padding: 14px 16px;
  border-radius: var(--radius);
  background: var(--panel);
  border: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  gap: 3px;
  overflow: hidden;
}

.kpi::before {
  content: '';
  position: absolute;
  inset: 0 auto 0 0;
  width: 2px;
  opacity: 0.9;
}

.accent-teal::before { background: #5eead4; }
.accent-violet::before { background: #a78bfa; }
.accent-amber::before { background: #fbbf24; }
.accent-blue::before { background: #38bdf8; }

.kpi-label {
  font-size: 11px;
  color: var(--text-3);
  letter-spacing: 0.04em;
}

.kpi-value {
  font-size: 26px;
  line-height: 1.15;
  font-weight: 700;
  font-family: ui-monospace, 'SF Mono', 'Cascadia Code', monospace;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.02em;
}

.kpi-sub {
  font-size: 11px;
  color: var(--text-3);
}

/* ---------- grid ---------- */
.layout {
  /* 仪表盘占首屏，技能目录单独排在下方，整页纵向滚动 */
  flex: 0 0 auto;
  height: calc(100vh - 300px);
  min-height: 520px;
  display: grid;
  grid-template-columns: minmax(0, 1.55fr) minmax(0, 1fr);
  grid-template-rows: minmax(0, 0.8fr) minmax(0, 1fr) minmax(0, 1.1fr);
  gap: 14px;
  overflow: hidden;
}

.stream {
  grid-column: 1;
  grid-row: 1 / 3;
}

.donut {
  grid-column: 2;
  grid-row: 1;
}

.ranking {
  grid-column: 2;
  grid-row: 2;
}

.timeline {
  grid-column: 1;
  grid-row: 3;
}

.sessions {
  grid-column: 2;
  grid-row: 3;
}

.cell {
  min-width: 0;
  min-height: 0;
}

/* ---------- 目录行：技能 + MCP ---------- */
.catalog-row {
  display: grid;
  grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr);
  gap: 14px;
  align-items: start;
}

.catalog-row > * {
  min-width: 0;
}

/* ---------- footer ---------- */
.foot {
  display: flex;
  gap: 20px;
  font-size: 11px;
  color: var(--text-3);
  padding: 2px 2px 6px;
}

/* ---------- booting ---------- */
.booting {
  flex: 1;
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 14px;
  color: var(--text-2);
  font-size: 13px;
}

.spinner {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  border: 2px solid rgba(94, 234, 212, 0.2);
  border-top-color: #5eead4;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

@media (max-width: 1100px) {
  .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .layout {
    height: auto;
    min-height: 0;
    grid-template-columns: 1fr;
    grid-template-rows: none;
    grid-auto-rows: minmax(260px, auto);
  }
  .stream, .donut, .ranking, .timeline, .sessions {
    grid-column: auto;
    grid-row: auto;
  }
  .stream { min-height: 420px; }
  .catalog-row { grid-template-columns: 1fr; }
}
</style>
