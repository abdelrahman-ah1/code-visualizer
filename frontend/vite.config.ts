import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sessionTemplate } from './session-template.ts';
// The browser calls /api on its own origin; Vite forwards that to the local FastAPI backend.
// Same-origin means no CORS, and the backend only needs to accept this page's origin.
const backend = `http://127.0.0.1:${process.env.CODEVIZ_BACKEND_PORT ?? '8000'}`;
// The backend writes a random per-session token to this file at startup. The proxy adds it to every
// /api request (read on each request, so restarting the backend needs no Vite restart).
const tokenFile = process.env.CODEVIZ_TOKEN_FILE ?? fileURLToPath(new URL('../.codeviz-token', import.meta.url));
const proxy = { '/api': { target: backend, changeOrigin: false, configure: (p: any) => {
  p.on('proxyReq', (req: any) => { try { req.setHeader('x-codeviz-token', readFileSync(tokenFile, 'utf8').trim()); } catch { /* backend not started yet */ } });
} } };
export default defineConfig({ base: './', plugins: [sessionTemplate()], server: { proxy }, preview: { proxy }, test: { include: ['tests/**/*.test.ts'] } });
