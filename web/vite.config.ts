import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const API = process.env.ZOEYBOT_API ?? 'http://localhost:8787';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@shared': fileURLToPath(new URL('../server/src', import.meta.url)) },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: API, changeOrigin: false, ws: true },
    },
  },
  // Modern browsers only (the app runs on the owner's Mac).
  build: { target: 'es2022', chunkSizeWarningLimit: 1200 },
});
