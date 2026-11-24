import { defineConfig } from 'vitest/config';
import { sessionTemplate } from './session-template.ts';
// The browser calls /api on its own origin; Vite forwards that to the local FastAPI backend.
// Same-origin means no CORS, and the backend only needs to accept this page's origin.
const backend = `http://127.0.0.1:${process.env.CODEVIZ_BACKEND_PORT ?? '8000'}`;
const proxy = { '/api': { target: backend, changeOrigin: false } };
export default defineConfig({ base: './', plugins: [sessionTemplate()], server: { proxy }, preview: { proxy }, test: { include: ['tests/**/*.test.ts'] } });
