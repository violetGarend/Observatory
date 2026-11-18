import { onMounted, onUnmounted, ref } from 'vue';

/**
 * 极简 history 路由：这个看板只有「首页」「会话执行记录」「项目历史」三个视图，
 * 不值得引入 vue-router。服务器对未知路径回落到 index.html。
 */
export function useRoute() {
  const path = ref(window.location.pathname);
  const search = ref(window.location.search);

  const sync = () => {
    path.value = window.location.pathname;
    search.value = window.location.search;
  };

  function navigate(to, { replace = false, state = null } = {}) {
    if (to === window.location.pathname + window.location.search) return;
    if (replace) window.history.replaceState(state, '', to);
    else window.history.pushState(state, '', to);
    sync();
    window.scrollTo(0, 0);
  }

  onMounted(() => window.addEventListener('popstate', sync));
  onUnmounted(() => window.removeEventListener('popstate', sync));

  return { path, search, navigate };
}
