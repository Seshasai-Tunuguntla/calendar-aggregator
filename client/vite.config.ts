/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Port 5190 so the client can run next to the Landlord (5173) and Study Scheduler (5180) clients.
// /api is proxied to the local API, so the browser sees one origin, exactly as in production.
// changeOrigin must stay false: the API's CSRF check compares the browser's Origin with the Host
// header, and changeOrigin (which Vite's string shorthand turns on) would rewrite Host to
// localhost:4200 and make every same-origin POST look cross-site.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5190,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://localhost:4200', changeOrigin: false },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
  },
});
