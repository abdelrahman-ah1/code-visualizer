// M4 performance checks in real Chrome with the real backend. They print measurements (so the
// numbers can be copied into PERF_REPORT.md) and fail only on generous ceilings, because CI
// machines differ. The ceilings catch a regression of 10x, not 10%.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

test('run the 1,800 event example end to end, then step through it', async ({ page, browserName }) => {
  await page.goto('/');
  await expect(page.getByTestId('backend-state')).toContainText('Backend online');
  await page.getByLabel('Example program').selectOption('19_long_loop');
  await page.getByLabel('Event limit').selectOption('2000');
  await page.getByLabel('Time limit').selectOption('10');
  const t0 = Date.now();
  await page.getByRole('button', { name: 'Run and record' }).click();
  await expect(page.getByText(/Event 1 of 1806/)).toBeVisible({ timeout: 20000 });
  const clickToReplayMs = Date.now() - t0;
  await expect(page.locator('.run-status')).toContainText('Recorded run: ok');
  const info = await page.getByTestId('run-info').innerText(), stats = await page.getByTestId('load-stats').innerText();
  const steps = await page.evaluate(async () => {
    const next = [...document.querySelectorAll('button')].find((x) => x.textContent === 'Next')!;
    const out: number[] = [];
    for (let i = 0; i < 100; i++) { const s = performance.now(); next.click(); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); out.push(performance.now() - s); }
    return out.sort((a, b) => a - b);
  });
  console.log(JSON.stringify({ browserName, events: 1806, clickToReplayMs, info, stats, stepMedianMs: +steps[50].toFixed(1), stepP95Ms: +steps[95].toFixed(1), stepMaxMs: +steps[99].toFixed(1) }));
  expect(clickToReplayMs).toBeLessThan(8000);
  expect(steps[50]).toBeLessThan(100);
});

test('breakpoint lookup and watch signatures stay fast on a 10,000 event recording', async ({ page }) => {
  await page.goto('/');
  const t = JSON.parse(readFileSync(new URL('../public/examples/05_alias.trace.json', import.meta.url), 'utf8'));
  const e = t.events.at(-1); t.events = Array.from({ length: 10000 }, (_, step) => ({ ...e, step, event: 'line', line: 1 + (step % 3) })); t.limits.events = 10000;
  await page.locator('input[type=file]').setInputFiles({ name: 'big.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(t)) });
  await expect(page.getByText('Event 1 of 10000', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Breakpoint on line 2' }).click();    // 3,333 stops
  const t1 = Date.now();
  await page.getByRole('button', { name: 'Next breakpoint' }).click();
  await expect(page.getByText('Event 2 of 10000', { exact: true })).toBeVisible();
  const jumpMs = Date.now() - t1, t2 = Date.now();
  await page.getByRole('tab', { name: 'Watch' }).click(); await page.getByLabel('Watch expression').fill('a'); await page.getByRole('button', { name: 'Add watch' }).click();
  await expect(page.getByTestId('watch-value')).toBeVisible();
  const watchMs = Date.now() - t2;
  console.log(JSON.stringify({ events: 10000, stops: 3333, nextBreakpointAndAssertMs: jumpMs, addWatchAndAssertMs: watchMs }));
  expect(jumpMs).toBeLessThan(2000); expect(watchMs).toBeLessThan(3000);
});
