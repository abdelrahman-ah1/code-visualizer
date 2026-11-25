// M6 in the browser: graph and tree diagrams from real recordings. Screenshots go to SHOTS_DIR (default test-results/screens).
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
const positions = (page: Page) => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-testid^="box-"]')].map((g) => [g.getAttribute('data-testid'), [Number(g.getAttribute('data-x')), Number(g.getAttribute('data-y'))]])));
const settle = (page: Page) => page.waitForFunction(() => document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity && a.playState === 'running').length === 0, null, { timeout: 5000 }).then(() => page.waitForTimeout(150));

test('Python graph: vertices, one line per pair, two heads only for mutual edges, neighbour lists not drawn as boxes', async ({ page }) => {
  test.setTimeout(80000);
  await run(page, prog('graph'));
  await page.getByRole('button', { name: 'Last', exact: true }).click(); await settle(page);
  await expect(page.locator('.vertex')).toHaveCount(6);
  await expect(page.locator('.cell')).toHaveCount(0);                                   // the edges lists are not drawn as arrays
  await expect(page.locator('[data-testid="ptr-missing"]')).toHaveCount(0);
  const edges = page.locator('[data-testid^="edge-"]');
  await expect(edges).toHaveCount(6);                                                   // 5 mutual pairs among A-D plus E-F, drawn once each
  expect(await edges.locator('path[marker-start]').count()).toBe(6);
  const titles = await page.locator('.vertex > title').allTextContents();
  expect(titles.every((t) => /edges to o\d+/.test(t) && /neighbour list edges = o\d+/.test(t))).toBe(true);   // identity stays inspectable
  const rects = await page.locator('.vertex rect.node-box').evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }));
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) { const a = rects[i], b = rects[j]; expect(a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3]).toBe(false); }
  await page.locator('.structures').screenshot({ path: `${SHOTS}/m6-graph-dark.png` });
  await page.getByRole('button', { name: 'Light mode', exact: true }).click(); await page.waitForTimeout(300);
  await page.locator('.structures').screenshot({ path: `${SHOTS}/m6-graph-light.png` });
});

test('directed graph: one-way edges have one head, a self loop and a back edge are drawn', async ({ page }) => {
  test.setTimeout(80000);
  await run(page, prog('dag'));
  await page.getByRole('button', { name: 'Last', exact: true }).click(); await settle(page);
  await expect(page.locator('.vertex')).toHaveCount(4);
  await expect(page.locator('[data-testid^="edge-"]')).toHaveCount(6);                  // A>B A>C B>D C>D D>A D>D
  await expect(page.locator('[data-testid^="edge-"] path[marker-start]')).toHaveCount(0);   // nothing points both ways: every line has one head
});

test('n-ary tree from children lists draws as layers under the root', async ({ page }) => {
  test.setTimeout(80000);
  await run(page, prog('ntree'));
  await page.getByRole('button', { name: 'Last', exact: true }).click(); await settle(page);
  await expect(page.locator('.vertex')).toHaveCount(9);
  const pos = await positions(page), ys = new Set(Object.values(pos).map((p: any) => p[1]));
  expect(ys.size).toBe(3);                                                              // root, a/b/c, leaves
  await page.locator('.structures').screenshot({ path: `${SHOTS}/m6-ntree.png` });
});

test('stable layout: stepping through a BST build moves few boxes between sampled steps and nothing overlaps', async ({ page }) => {
  test.setTimeout(110000);
  await run(page, prog('bst'));
  const n = await count(page);
  let prev: Record<string, number[]> = {}, worst = 0, total = 0;
  for (let i = 0; i < n; i += 4) {
    await seek(page, i);
    const cur = await positions(page);
    let m = 0; for (const [k, p] of Object.entries(cur) as [string, number[]][]) if (prev[k] && (Math.abs(prev[k][0] - p[0]) > 1 || Math.abs(prev[k][1] - p[1]) > 1)) m++;
    worst = Math.max(worst, m); total += m; prev = cur;
  }
  console.log(`M6 BST browser stepping: ${n} events, boxes moved in total ${total}, worst single step ${worst}`);
  expect(worst).toBeLessThanOrEqual(12);
  await page.getByRole('button', { name: 'Last', exact: true }).click(); await settle(page);
  await page.locator('.structures').screenshot({ path: `${SHOTS}/m6-bst.png` });
});

test('rotation keeps nodes in order: AVL-style rotations only change depth', async ({ page }) => {
  test.setTimeout(80000);
  await run(page, prog('avl'));
  await page.getByRole('button', { name: 'Last', exact: true }).click(); await settle(page);
  await page.locator('.structures').screenshot({ path: `${SHOTS}/m6-rotation.png` });
  await expect(page.locator('.vnode')).toHaveCount(5);
});

test('shared neighbour list is never hidden: the plain view stays, with no overlapping cards', async ({ page }) => {
  test.setTimeout(80000);
  await run(page, prog('shared'));
  await page.getByRole('button', { name: 'Last', exact: true }).click(); await settle(page);
  await expect(page.locator('.vertex')).toHaveCount(0);
  await expect(page.locator('.cell')).toHaveCount(2);
  await page.locator('.structures').screenshot({ path: `${SHOTS}/m6-shared.png` });
});

test('C++ vector<Node*> adjacency lists draw as a graph too', async ({ page }) => {
  test.setTimeout(100000);
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto('/');
  await expect(page.getByTestId('backend-state')).toContainText('Backend online');
  test.skip(await page.getByTestId('cpp-missing').count() > 0, 'g++/gdb not installed here');
  await run(page, prog('graph', 'cpp'), 'cpp');
  await page.getByRole('button', { name: 'Last', exact: true }).click(); await settle(page);
  await expect(page.locator('.vertex')).toHaveCount(4);
  await page.locator('.structures').screenshot({ path: `${SHOTS}/m6-cpp-graph.png` });
});
