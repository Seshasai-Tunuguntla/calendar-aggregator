/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { defineConfig, type Plugin } from 'vite';
import { PRIVATE_PAGE_HEADERS, PRIVATE_PAGE_PREFIX } from './src/guest/privatePage.ts';

// Manage pages (/booking/<token>) carry a secret in their URL: send them with no-referrer and
// noindex, in development and preview as vercel.json does in production.
export function privatePageHeaders(req: IncomingMessage, res: ServerResponse, next: () => void): void {
  if (req.url?.startsWith(PRIVATE_PAGE_PREFIX)) {
    for (const [name, value] of Object.entries(PRIVATE_PAGE_HEADERS)) res.setHeader(name, value);
  }
  next();
}

const privatePages: Plugin = {
  name: 'private-page-headers',
  configureServer: (server) => void server.middlewares.use(privatePageHeaders),
  configurePreviewServer: (server) => void server.middlewares.use(privatePageHeaders),
};

// /api is proxied to the local API, so the browser sees one origin, exactly as in production.
// changeOrigin must stay false: the API's CSRF check compares the browser's Origin with the Host
// header, and changeOrigin (which Vite's string shorthand turns on) would rewrite Host to
// localhost:4200 and make every same-origin POST look cross-site. The end-to-end test serves the
// production build with `vite preview` next to its own API, named by API_PROXY_TARGET.
const apiProxy = { '/api': { target: process.env['API_PROXY_TARGET'] ?? 'http://localhost:4200', changeOrigin: false } };

// Port 5190 so the client can run next to the Landlord (5173) and Study Scheduler (5180) clients.
export default defineConfig({
  plugins: [react(), privatePages],
  server: { port: 5190, strictPort: true, proxy: apiProxy },
  preview: { strictPort: true, proxy: apiProxy },
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
  },
});
