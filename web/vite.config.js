import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5317,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:4317',
      '/ws': { target: 'ws://127.0.0.1:4317', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
