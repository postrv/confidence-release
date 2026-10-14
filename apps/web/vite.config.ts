import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true, configure(proxy) { proxy.on('proxyReq', (outgoing, incoming) => { if (incoming.headers.origin === 'http://127.0.0.1:5173') outgoing.setHeader('origin', 'http://127.0.0.1:8787'); }); } } },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
