// Time limit defaults per language, user override, and the neutral incomplete-recording message.
import { test, expect } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';
const SHOTS = process.env.SHOTS_DIR || 'test-results/screens';
mkdirSync(SHOTS, { recursive: true });
const HUFF = readFileSync('tests/programs/huffman.cpp', 'utf8');
test.beforeEach(async ({ page }) => { page.setViewportSize({ width: 1440, height: 1500 }); await page.goto('/'); await expect(page.getByTestId('backend-state')).toContainText('Backend online'); });
const limit = (p: any) => p.getByLabel('Time limit');
test('default Time limit follows the language until the user picks one', async ({ page }) => {
  await expect(limit(page)).toHaveValue('2');
  await page.getByLabel('Language').selectOption('cpp');
  await expect(limit(page)).toHaveValue('5');
  await page.getByLabel('Language').selectOption('python');
  await expect(limit(page)).toHaveValue('2');
  await limit(page).selectOption('10');
  await page.getByLabel('Language').selectOption('cpp');
  await expect(limit(page)).toHaveValue('10');
  await page.getByLabel('Language').selectOption('python');
  await expect(limit(page)).toHaveValue('10');
  await limit(page).selectOption('2');
  await page.getByLabel('Language').selectOption('cpp');
  await expect(limit(page)).toHaveValue('2');   // an explicit choice of 2 s is kept, not replaced by the default
});
test('Huffman example: default C++ limit completes; 2 s override gives neutral incomplete message', async ({ page }) => {
  await page.getByLabel('Language').selectOption('cpp');
  const b = page.getByRole('button', { name: 'Edit code' }); if (await b.isVisible()) await b.click();
  await page.getByLabel('C++ source code').fill(HUFF);
  const sent: number[] = []; page.on('request', (r) => { if (r.url().includes('/api/trace')) sent.push(JSON.parse(r.postData() || '{}').timeout); });
  await page.getByRole('button', { name: 'Run and record' }).click();
  await expect(page.locator('.run-status')).toContainText('Recorded run: ok', { timeout: 30000 });
  expect(sent[0]).toBe(5);
  if (await b.isVisible()) await b.click();
  await limit(page).selectOption('2');
  await page.getByRole('button', { name: 'Run and record' }).click();
  await expect(page.locator('.run-status')).toContainText('timeout', { timeout: 30000 });
  expect(sent[1]).toBe(2);
  await page.getByRole('button', { name: 'Last', exact: true }).click();
  const d = page.locator('.diagnostics');
  await expect(d).toContainText('capture is incomplete');
  await expect(d).not.toContainText('endless loop');
  await expect(d).toContainText('Memory leak');
  await page.screenshot({ path: `${SHOTS}/huffman-timeout.png`, fullPage: true });
});
