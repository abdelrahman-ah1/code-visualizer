// M5 end-to-end tests: real Chrome, real Vite, real FastAPI backend, real g++/gdb tracer.
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
const SHOTS = process.env.SHOTS_DIR || 'test-results/screens';
mkdirSync(SHOTS, { recursive: true });
const openEditor = async (page: Page) => { const b = page.getByRole('button', { name: 'Edit code' }); if (await b.isVisible()) await b.click(); };
const run = (page: Page) => page.getByRole('button', { name: 'Run and record' });
test.beforeEach(async ({ page }) => { page.setViewportSize({ width: 1440, height: 1500 }); await page.goto('/'); await expect(page.getByTestId('backend-state')).toContainText('Backend online'); });
async function runExample(page: Page, n: number) {
  await page.getByLabel('Language').selectOption('cpp');
  await page.getByLabel('Example program').selectOption({ index: n });
  await run(page).click();
  await expect(page.getByText(/Event 1 of \d+/)).toBeVisible({ timeout: 20000 });
}
test('C++ linked list swap runs and shows the list', async ({ page }) => {
  await page.getByLabel('Language').selectOption('cpp');
  await expect(page.getByTestId('run-twice-warning')).toContainText('runs your program twice');
  await page.screenshot({ path: `${SHOTS}/m5-run-warning.png` });
  await runExample(page, 1);
  await expect(page.locator('.run-status')).toContainText('Recorded run: ok');
  await page.getByRole('button', { name: 'Last', exact: true }).click();
  await page.screenshot({ path: `${SHOTS}/m5-linked-list.png`, fullPage: true });
});
test('null pointer crash keeps partial trace and shows diagnostics', async ({ page }) => {
  await runExample(page, 5);
  await expect(page.locator('.run-status')).toContainText('error');
  await page.getByRole('button', { name: 'Last', exact: true }).click();
  await expect(page.locator('.diagnostics')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/m5-crash.png`, fullPage: true });
});
test('use after free shows a freed node', async ({ page }) => {
  await runExample(page, 6);
  await page.getByRole('button', { name: 'Last', exact: true }).click();
  await expect(page.locator('.diagnostics')).toBeVisible();
  await expect(page.getByTestId('overall')).toContainText('Problems found: 1 error');
  await expect(page.locator('.run-status')).toHaveClass(/warning/);
  await expect(page.getByTestId('twice-note')).toContainText('run twice');
  await page.screenshot({ path: `${SHOTS}/m5-use-after-free.png`, fullPage: true });
});
test('compile error is reported, then a good program runs again', async ({ page }) => {
  await page.getByLabel('Language').selectOption('cpp');
  await openEditor(page); await page.getByLabel('C++ source code').fill('int main() {\n  int x = ;\n  return 0;\n}\n');
  await run(page).click();
  await expect(page.locator('.diagnostics')).toBeVisible({ timeout: 20000 });
  await page.screenshot({ path: `${SHOTS}/m5-compile-error.png`, fullPage: true });
  await page.getByLabel('Example program').selectOption({ index: 1 });
  await run(page).click();
  await expect(page.getByText(/Event 1 of \d+/)).toBeVisible({ timeout: 20000 });
});
test('infinite loop times out and the next run still works', async ({ page }) => {
  await page.getByLabel('Language').selectOption('cpp');
  await openEditor(page); await page.getByLabel('C++ source code').fill('int main() {\n  int i = 0;\n  while (true) {\n    i++;\n  }\n}\n');
  await run(page).click();
  await expect(page.locator('.run-status')).toContainText('timeout', { timeout: 20000 });
  await page.getByLabel('Example program').selectOption({ index: 1 });
  await run(page).click();
  await expect(page.locator('.run-status')).toContainText('Recorded run: ok', { timeout: 20000 });
});
test('file-writing example: each run has its own folder, so one line is counted', async ({ page }) => {
  await page.getByLabel('Language').selectOption('cpp');
  await page.getByLabel('Example program').selectOption({ index: 10 });
  await run(page).click();
  await expect(page.getByText(/Event 1 of \d+/)).toBeVisible({ timeout: 20000 });
  await page.getByRole('button', { name: 'Last', exact: true }).click();
  await expect(page.getByTestId('stdout')).toContainText('lines in notes.txt: 1');
});
