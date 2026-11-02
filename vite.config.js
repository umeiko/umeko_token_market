import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  base: process.env.VITE_BASE || '/',
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:3000',
      '/v1': 'http://127.0.0.1:3000',
      '/agent': { target: 'ws://127.0.0.1:3000', ws: true },
    },
  },
});
