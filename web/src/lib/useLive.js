import { onMounted, onUnmounted, ref, shallowRef } from 'vue';

const MAX_STREAM = 600;

/**
 * WebSocket 实时通道。
 * - 首连收到 snapshot（全量聚合）
 * - 后续 events 批次同时附带最新 snapshot，前端只需覆盖，无需增量合并
 */
export function useLive() {
  const snapshot = shallowRef(null);
  const events = ref([]);
  const connected = ref(false);
  const error = ref(null);

  let ws = null;
  let retry = 0;
  let retryTimer = null;
  let disposed = false;
  let seq = 0;

  function connect() {
    if (disposed) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws`);

    ws.onopen = () => {
      connected.value = true;
      error.value = null;
      retry = 0;
    };

    ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type === 'snapshot') {
        snapshot.value = msg.data;
        // 首次连接：用服务端保留的历史事件回填，避免开屏空白
        if (!events.value.length && msg.data.recent?.length) {
          events.value = msg.data.recent.map((ev) => ({ ...ev, _id: ++seq }));
        }
      } else if (msg.type === 'events') {
        if (msg.snapshot) snapshot.value = msg.snapshot;
        // 服务端按时间正序发来，前端倒序插入以保持最新在顶部
        const incoming = msg.data
          .slice()
          .reverse()
          .map((ev) => ({ ...ev, _id: ++seq }));
        for (const ev of incoming) events.value.unshift(ev);
        if (events.value.length > MAX_STREAM) events.value.length = MAX_STREAM;
      }
    };

    ws.onclose = () => {
      connected.value = false;
      if (disposed) return;
      const delay = Math.min(1000 * 2 ** retry, 15000);
      retry++;
      retryTimer = setTimeout(connect, delay);
    };

    ws.onerror = () => {
      error.value = '连接失败，正在重试…';
      ws.close();
    };
  }

  onMounted(connect);
  onUnmounted(() => {
    disposed = true;
    clearTimeout(retryTimer);
    ws?.close();
  });

  return { snapshot, events, connected, error };
}
