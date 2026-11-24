// Executing-line marker: an arrow and an "about to run" tag on the current line, breakpoints stay visible.
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
const SHOTS = process.env.SHOTS_DIR || 'test-results/screens';
mkdirSync(SHOTS, { recursive: true });
test('active line shows an arrow and tag, and a breakpoint on it stays visible', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto('/');
  await expect(page.getByTestId('backend-state')).toContainText('Backend online');
  await page.getByLabel('Language').selectOption('cpp');
  await page.getByLabel('Example program').selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Run and record' }).click();
  await expect(page.getByText(/Event 1 of \d+/)).toBeVisible({ timeout: 20000 });
  for (let i = 0; i < 6; i++) await page.getByRole('button', { name: 'Next', exact: true }).click();
  const active = page.locator('.code-line[aria-current="step"]');
  await expect(active).toHaveCount(1);
  await expect(active.locator('.exec-arrow')).toHaveText('▶');
  await expect(page.locator('.exec-arrow:not(:empty)')).toHaveCount(1);
  await active.locator('.line-number').click();            // breakpoint on the active line
  await expect(active.locator('.line-number')).toHaveClass(/bp-on/);
  await expect(active.locator('.exec-arrow')).toHaveText('▶');
  await page.locator('.source-panel').screenshot({ path: `${SHOTS}/arrow-dark.png` });
  await page.getByRole('button', { name: 'Light mode', exact: true }).click();
  await page.locator('.source-panel').screenshot({ path: `${SHOTS}/arrow-light.png` });
  // Terminal snapshot (a return event here): it gets a return marker and no "about to run" wording anywhere.
  await page.getByRole('button', { name: 'Last', exact: true }).click();
  await expect(page.locator('.exec-arrow:not(:empty)')).toHaveCount(1);
  await expect(page.getByText('about to run')).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/arrow-last.png` });
});

const settle = async (page: Page) => { await page.waitForFunction(() => document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity && a.playState === 'running').length === 0, null, { timeout: 5000 }); await page.waitForTimeout(250); };
for (const [w, h, theme] of [[1366, 768, 'dark'], [1920, 1080, 'light']] as const) {
  test(`one-screen layout at ${w}x${h} (${theme}): fits one screen, tabs open/close without scrolling, active line stays visible`, async ({ page }) => {
    test.setTimeout(80000);
    await page.setViewportSize({ width: w, height: h });
    await page.goto('/');
    await expect(page.getByTestId('backend-state')).toContainText('Backend online');
    await page.getByLabel('Language').selectOption('cpp');
    await page.getByLabel('Example program').selectOption({ index: 1 });
    await expect(page.locator('.editor')).toHaveCount(1);
    await page.getByRole('button', { name: 'Run and record' }).click();
    await expect(page.getByText(/Event 1 of \d+/)).toBeVisible({ timeout: 20000 });
    await expect(page.locator('.editor')).toHaveCount(0);                            // the editor folds away after a run
    await expect(page.getByRole('button', { name: 'Edit code' })).toBeVisible();
    if (theme === 'light') await page.getByRole('button', { name: 'Light mode', exact: true }).click();
    await page.waitForFunction(() => { const r = document.querySelector('.replay-root')!.getBoundingClientRect(); return Math.abs(r.top) < 40; });  // the run scrolled here by itself
    const box = async (sel: string) => (await page.locator(sel).first().boundingBox())!;
    const inView = async (sel: string, what: string) => { const b = await box(sel); expect(b.y, what + ' top').toBeGreaterThanOrEqual(-1); expect(b.y + b.height, what + ' bottom').toBeLessThanOrEqual(h + 1); };
    const fits = async (tag: string) => {
      for (const sel of ['.replay-root', '.sticky-bar', '.source-panel', '.structures', '.tabs']) await inView(sel, `${tag} ${sel}`);
    };
    await fits('start');
    const src = await box('.source-panel'), str = await box('.structures');
    expect(src.x + src.width).toBeLessThanOrEqual(str.x + 1);                       // side by side
    expect(str.width / src.width).toBeGreaterThan(1.8);                              // diagram about twice the code column
    expect(str.width / src.width).toBeLessThan(2.2);
    // Active line stays inside the source viewport for every step.
    const count = Number((await page.getByText(/Event 1 of (\d+)/).textContent())!.match(/of (\d+)/)![1]);
    for (let i = 0; i < count; i++) {
      const line = await page.locator('.code-line[aria-current="step"]').boundingBox();
      const view = await page.locator('.source').boundingBox();
      expect(line, `step ${i + 1}`).not.toBeNull();
      expect(line!.y, `step ${i + 1} top`).toBeGreaterThanOrEqual(view!.y - 1);
      expect(line!.y + line!.height, `step ${i + 1} bottom`).toBeLessThanOrEqual(view!.y + view!.height + 1);
      if (i < count - 1) await page.getByRole('button', { name: 'Next', exact: true }).click();
    }
    await page.getByRole('button', { name: 'First', exact: true }).click();
    for (let i = 0; i < 12; i++) await page.getByRole('button', { name: 'Next', exact: true }).click();
    const scrollY = await page.evaluate(() => window.scrollY);
    await expect(page.getByRole('tab', { name: 'Heap' })).toHaveAttribute('aria-selected', 'true');
    await settle(page); await fits('heap open');
    const heapPanel = await box('[role=tabpanel]');
    expect(heapPanel.height).toBeGreaterThan(250);                                   // real contents are visible, not only a heading
    await page.screenshot({ path: `${SHOTS}/final-${w}-${theme}-heap-open.png` });
    const openH = (await box('.structures')).height;
    await page.getByRole('tab', { name: 'Heap' }).click();                           // click the open tab: closes it
    await expect(page.getByRole('tabpanel')).toHaveCount(0);
    await settle(page); await fits('closed');
    expect((await box('.structures')).height).toBeGreaterThan(openH + 20);          // diagram takes the freed space
    await page.screenshot({ path: `${SHOTS}/final-${w}-${theme}-closed.png` });
    await page.getByRole('tab', { name: 'Call stack' }).click();                    // reopen with no scrolling needed
    await expect(page.locator('.frame').first()).toBeVisible();
    await settle(page); await fits('stack open');
    await page.screenshot({ path: `${SHOTS}/final-${w}-${theme}-stack.png` });
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollY);                 // the page never scrolled while opening/closing tabs
    await page.getByRole('button', { name: 'Edit code' }).click();
    await expect(page.locator('.editor')).toHaveCount(1);
  });
}

for (const [w, h] of [[1366, 768], [1920, 1080], [900, 800]] as const) {
  test(`collapsed run panel is one compact toolbar at ${w}x${h}`, async ({ page }) => {
    test.setTimeout(60000);
    await page.setViewportSize({ width: w, height: h });
    await page.goto('/');
    await expect(page.getByTestId('backend-state')).toContainText('Backend online');
    await page.getByLabel('Language').selectOption('cpp');
    await page.getByLabel('Example program').selectOption({ index: 1 });
    await page.getByRole('button', { name: 'Run and record' }).click();
    await expect(page.getByText(/Event 1 of \d+/)).toBeVisible({ timeout: 20000 });
    await expect(page.locator('.editor')).toHaveCount(0);
    await page.waitForTimeout(1200);
    await page.evaluate(() => window.scrollTo(0, 0));
    await settle(page);
    await page.screenshot({ path: `${SHOTS}/run-toolbar-${w}.png`, clip: { x: 0, y: 0, width: w, height: Math.min(h, 360) } });
    const panel = (await page.locator('.run-panel').boundingBox())!;
    const run = (await page.getByRole('button', { name: 'Run and record' }).boundingBox())!;
    const edit = (await page.getByRole('button', { name: 'Edit code' }).boundingBox())!;
    expect(panel.height, 'panel height').toBeLessThan(w >= 1100 ? 130 : 200);
    expect(Math.abs(run.y - edit.y), 'Run and Edit code share a row').toBeLessThan(6);
    expect(edit.x - (run.x + run.width), 'Edit code sits next to Run').toBeLessThan(40);
  });
}

test('combined preview: compact toolbar, same diagram height, details panel extends below', async ({ page }) => {
  test.setTimeout(60000);
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto('/');
  await expect(page.getByTestId('backend-state')).toContainText('Backend online');
  await page.getByLabel('Language').selectOption('cpp');
  await page.getByLabel('Example program').selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Run and record' }).click();
  await expect(page.getByText(/Event 1 of \d+/)).toBeVisible({ timeout: 20000 });
  await page.waitForTimeout(1200);
  for (let i = 0; i < 12; i++) await page.getByRole('button', { name: 'Next', exact: true }).click();
  await settle(page);
  await page.screenshot({ path: `${SHOTS}/combined-top.png` });
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await settle(page);
  await page.screenshot({ path: `${SHOTS}/combined-bottom.png` });
  const tp = (await page.locator('.tabs-panel').boundingBox())!;
  expect(tp.height).toBeGreaterThan(300);
  const sc = await page.evaluate(() => ({ y: window.scrollY, h: document.documentElement.scrollHeight }));
  expect(sc.h).toBeGreaterThan(768);
  expect(tp.y + tp.height).toBeLessThanOrEqual(768 + 1);   // after scrolling down, the whole panel is reachable
});
