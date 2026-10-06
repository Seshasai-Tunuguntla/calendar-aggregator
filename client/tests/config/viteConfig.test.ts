import { describe, expect, it } from 'vitest';
import config from '../../vite.config.ts';

describe('vite dev proxy', () => {
  it("keeps the browser's Host header, so the API's same-origin check passes in development", () => {
    expect(config.server?.proxy?.['/api']).toEqual({ target: 'http://localhost:4200', changeOrigin: false });
  });
});
