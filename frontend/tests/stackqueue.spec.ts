// Stack and queue shapes in the browser, from real runs (Python deque, C++ stack/queue/priority_queue).
// Screenshots go to SHOTS_DIR (default test-results/screens).
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
const count = async (page: Page) => Number((await page.getByText(/Event \d+ of (\d+)/).textContent())!.match(/of (\d+)/)![1]);
const seek = async (page: Page, i: number) => { await page.getByLabel('Event timeline').fill(String(i)); await page.waitForTimeout(15); };
const settle = (page: Page) => page.waitForFunction(() => document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity && a.playState === 'running').length === 0, null, { timeout: 5000 }).then(() => page.waitForTimeout(150));
// Seek forward until `testid` shows up (or give up at the last event).
async function seekUntil(page: Page, testid: string): Promise<boolean> {
  const total = await count(page);
  for (let i = 1; i <= total; i++) {
    await seek(page, i);
    if (await page.getByTestId(testid).count()) { await settle(page); return true; }
  }
  return false;
}

test('Python deque BFS: front/back marks on the queue strip, arrows to the nodes', async ({ page }) => {
  test.setTimeout(80000);
  await run(page, prog('queue'));
  expect(await seekUntil(page, 'queue-back')).toBe(true);
  await expect(page.getByTestId('queue-front')).toHaveCount(1);
  await expect(page.getByTestId('queue-back')).toHaveCount(1);
  await expect(page.getByTestId('stack-top')).toHaveCount(0);
  // The queue holds the graph nodes being visited: its arrows end on drawn cards.
  const fronts = page.getByTestId('queue-front');
  const box = page.locator('.vnode', { has: fronts });
  await expect(box.locator('path.arrow[data-from]').first()).toBeVisible();
  // front sits under the leftmost cell, back under the rightmost.
  const f = await page.getByTestId('queue-front').boundingBox(), b = await page.getByTestId('queue-back').boundingBox();
  expect(f!.x).toBeLessThan(b!.x);
  await page.locator('.structures').screenshot({ path: `${SHOTS}/queue-py-dark.png` });
  await page.getByRole('button', { name: 'Light mode', exact: true }).click(); await page.waitForTimeout(300);
  await page.locator('.structures').screenshot({ path: `${SHOTS}/queue-py-light.png` });
});

test('C++ std::stack: vertical column, top marked, cell 0 at the bottom', async ({ page }) => {
  test.setTimeout(80000);
  await run(page, prog('stack', 'cpp'), 'cpp');
  expect(await seekUntil(page, 'stack-top')).toBe(true);
  // The int stack depth = [1, 2, 3]: find the event with three cells.
  const total = await count(page);
  let three = false;
  for (let i = 1; i <= total && !three; i++) {
    await seek(page, i);
    const box = page.locator('.vnode', { has: page.getByTestId('stack-top') });
    if (await box.locator('.cell').count() === 3) three = true;
  }
  expect(three).toBe(true);
  await settle(page);
  const box = page.locator('.vnode', { has: page.getByTestId('stack-top') });
  const cells = box.locator('.cell .cell-value');
  const texts = await cells.allTextContents();
  expect(texts).toEqual(['1', '2', '3']);
  const ys = await cells.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().y));
  expect(ys[0]).toBeGreaterThan(ys[2]);                 // item 0 at the bottom, item 2 above it
  const top = await page.getByTestId('stack-top').boundingBox();
  expect(Math.abs(top!.y + top!.height / 2 - (ys[2] + 23)) < 30).toBe(true);   // "top" beside the highest cell
  await page.locator('.structures').screenshot({ path: `${SHOTS}/stack-cpp-dark.png` });
});

test('C++ std::queue and priority_queue: queue marked, priority_queue a plain strip', async ({ page }) => {
  test.setTimeout(80000);
  await run(page, prog('queue', 'cpp'), 'cpp');
  expect(await seekUntil(page, 'queue-front')).toBe(true);
  await expect(page.getByTestId('queue-front')).toHaveCount(1);
  await page.locator('.structures').screenshot({ path: `${SHOTS}/queue-cpp-dark.png` });
  // Later, in the priority_queue phase: a strip with no front/back marks.
  const total = await count(page);
  let plain = false;
  for (let i = total; i >= 1; i--) {
    await seek(page, i);
    if (await page.getByTestId('queue-front').count() === 0 && await page.locator('.cell').count() >= 4) { plain = true; break; }
  }
  expect(plain).toBe(true);
  await expect(page.getByTestId('queue-back')).toHaveCount(0);
  await expect(page.getByTestId('stack-top')).toHaveCount(0);
});

test('Phone width: marks stay readable', async ({ page }) => {
  test.setTimeout(80000);
  await run(page, prog('queue'));
  await page.setViewportSize({ width: 390, height: 700 });
  expect(await seekUntil(page, 'queue-back')).toBe(true);
  await expect(page.getByTestId('queue-front')).toBeVisible();
  await expect(page.getByTestId('queue-back')).toBeVisible();
  await page.locator('.structures').screenshot({ path: `${SHOTS}/queue-py-phone.png` });
});
