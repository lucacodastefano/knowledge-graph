import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: `npm run dev:web` proxies the API to a daemon started with `npm start`.
export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:7777',
      '/ws': { target: 'ws://127.0.0.1:7777', ws: true },
    },
  },
});
