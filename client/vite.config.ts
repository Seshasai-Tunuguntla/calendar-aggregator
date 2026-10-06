/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Port 5190 so the client can run next to the Landlord (5173) and Study Scheduler (5180) clients.
// /api is proxied to the local API, so the browser sees one origin, exactly as in production.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5190,
    strictPort: true,
    proxy: {
      '/api': 'http://localhost:4200',
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
  },
});
