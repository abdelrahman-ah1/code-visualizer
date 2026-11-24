import { defineConfig } from '@playwright/test';
// Two servers: the Vite dev server (the app) and the FastAPI backend (/api, proxied by Vite).
// CODEVIZ_PYTHON picks the Python that has backend/requirements.txt installed (default: python3).
const python = process.env.CODEVIZ_PYTHON || 'python3';
export default defineConfig({
  testDir: './tests', testMatch: '**/*.spec.ts', workers: 1,
  use: { baseURL: 'http://127.0.0.1:5173', headless: true,
    launchOptions: { executablePath: process.env.CHROME_BIN || undefined } },
  webServer: [
    { command: 'npm run dev -- --port 5173 --strictPort', url: 'http://127.0.0.1:5173', reuseExistingServer: !process.env.CI },
    { command: `${python} -m uvicorn backend.app:app --host 127.0.0.1 --port 8000`, cwd: '..', url: 'http://127.0.0.1:8000/api/health', reuseExistingServer: !process.env.CI },
  ],
});
