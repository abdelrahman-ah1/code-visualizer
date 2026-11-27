// Adjacency-list graph view in the browser, from real runs (Python and C++). Screenshots go to SHOTS_DIR (default test-results/screens).
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';
const SHOTS = process.env.SHOTS_DIR || 'test-results/screens';
mkdirSync(SHOTS, { recursive: true });
const prog = (n: string, ext = 'py') => readFileSync(new URL(`./programs/m6/${n}.${ext}`, import.meta.url), 'utf8');
async function run(page: Page, code: string, lang: 'python' | 'cpp' = 'python') {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await expect(page.getByTestId('backend-state')).toContainText('Backend online');
  if (lang === 'cpp') await page.getByLabel('Language').selectOption('cpp');
  await page.getByLabel(lang === 'cpp' ? 'C++ source code' : /source code/).fill(code);
  await page.getByRole('button', { name: 'Run and record' }).click();
  await expect(page.getByText(/Event 1 of \d+/)).toBeVisible({ timeout: 30000 });
  await page.waitForTimeout(300);
}
const count = async (page: Page) => Number((await page.getByText(/Event 1 of (\d+)/).textContent())!.match(/of (\d+)/)![1]);
const seek = async (page: Page, i: number) => { await page.getByLabel('Event timeline').fill(String(i)); await page.waitForTimeout(15); };
const settle = (page: Page) => page.waitForFunction(() => document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity && a.playState === 'running').length === 0, null, { timeout: 5000 }).then(() => page.waitForTimeout(150));

test('Python adjacency list: circles, arrows, caption; the lists themselves are not drawn', async ({ page }) => {
  test.setTimeout(80000);
  await run(page, prog('adjlist'));
  await page.getByRole('button', { name: 'Last', exact: true }).click(); await settle(page);
  const circles = page.locator('.adjv');
  await expect(circles).toHaveCount(5);
  await expect(page.locator('.adjv .vertex-circle')).toHaveCount(5);
  const labels = await page.locator('.adjv .node-main').allTextContents();
  expect(labels.sort()).toEqual(['0', '1', '2', '3', '4']);
  await expect(page.locator('[data-testid^="adj-caption-"]')).toHaveCount(1);
  await expect(page.locator('[data-testid^="adj-caption-"]')).toContainText('adj');
  await expect(page.locator('[data-testid^="adj-caption-"]')).toContainText('5 vertices');
  const edges = page.locator('[data-testid^="edge-"]');
  await expect(edges).toHaveCount(6);                                   // 0->1, 0->2, 1->3, 2->3, 2->4, 3->4
  expect(await edges.locator('path[marker-end]').count()).toBe(6);
  await expect(page.locator('.cell')).toHaveCount(6);                   // seen (5 cells) + the empty queue (1): the adjacency arrays draw none
  const titles = await page.locator('.adjv > title').allTextContents();
  expect(titles.every((t) => /vertex \d/.test(t) && /adjacency list/.test(t))).toBe(true);
  // Circles do not overlap.
  const rects = await page.locator('.adjv .vertex-circle').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }));
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) { const a = rects[i], b = rects[j]; expect(a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3]).toBe(false); }
  await page.locator('.structures').screenshot({ path: `${SHOTS}/adjgraph-py-dark.png` });
  await page.getByRole('button', { name: 'Light mode', exact: true }).click(); await page.waitForTimeout(300);
  await page.locator('.structures').screenshot({ path: `${SHOTS}/adjgraph-py-light.png` });
});

test('C++ vector<vector<int>> draws the same circles; stepping keeps positions stable', async ({ page }) => {
  test.setTimeout(80000);
  await run(page, prog('adjlist', 'cpp'), 'cpp');
  const total = await count(page);
  await seek(page, Math.floor(total / 2)); await settle(page);
  const circles = page.locator('.adjv');
  await expect(circles).toHaveCount(5);
  await expect(page.locator('[data-testid^="edge-"]')).toHaveCount(6);
  await expect(page.locator('[data-testid^="adj-caption-"]')).toContainText('std::vector');
  const pos = () => page.locator('.adjv').evaluateAll((els) => els.map((e) => `${e.getAttribute('data-x')},${e.getAttribute('data-y')}`));
  const before = await pos();
  await seek(page, Math.floor(total / 2) + 3); await settle(page);
  await seek(page, Math.floor(total / 2) + 6); await settle(page);
  expect(await pos()).toEqual(before);                                  // same graph, same places, while the loop runs
  await page.locator('.structures').screenshot({ path: `${SHOTS}/adjgraph-cpp-dark.png` });
});

test('a matrix keeps its plain grid of cells (no false graph)', async ({ page }) => {
  test.setTimeout(80000);
  await run(page, prog('matrix'));
  await page.getByRole('button', { name: 'Last', exact: true }).click(); await settle(page);
  await expect(page.locator('.adjv')).toHaveCount(0);
  await expect(page.locator('[data-testid^="adj-caption-"]')).toHaveCount(0);
  await expect(page.locator('.cell').first()).toBeVisible();            // grid stays a cell strip
});
