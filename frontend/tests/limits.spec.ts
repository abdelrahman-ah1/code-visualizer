import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
const SHOTS = process.env.SHOTS_DIR || 'test-results/screens'; mkdirSync(SHOTS, { recursive: true });
const prog = '#include <iostream>\nint main() {\n  int* p = new int(1);\n  long s = 0;\n  for (int i = 0; i < 5000; i++) {\n    s += i;\n  }\n  std::cout << s << "\\n";\n  delete p;\n  return 0;\n}\n';
test('a capped recording is never shown as a finished run, and it saves/reopens as .json.gz', async ({ page }) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto('/');
  await expect(page.getByTestId('backend-state')).toContainText('Backend online');
  await page.getByLabel('Language').selectOption('cpp');
  await page.getByLabel('C++ source code').fill(prog);
  await page.getByLabel('Event limit').selectOption('500');
  await page.getByLabel('Time limit').selectOption('10');
  await page.getByRole('button', { name: 'Run and record' }).click();
  await expect(page.getByText(/Event 1 of \d+/)).toBeVisible({ timeout: 40000 });
  await expect(page.locator('.run-status b').first()).toHaveText('Recorded run: trace_limit');
  await expect(page.locator('.run-status')).toContainText('may have continued');
  await expect(page.locator('.run-status')).not.toContainText('Run finished normally');
  await page.getByRole('button', { name: 'Last', exact: true }).click();
  await expect(page.locator('.run-status')).toContainText('trace_limit');
  await expect(page.getByText('Recording stopped after 500 steps', { exact: false }).first()).toBeVisible();
  // gzip affordances visible together: open control, both save buttons
  await page.locator('.loader').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/gzip-ui-capped.png`, fullPage: false });
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save recording (.json.gz)' }).click()]);
  await dl.saveAs('test-results/capped.json.gz');
  await page.reload();
  await page.locator('input[type=file]').setInputFiles('test-results/capped.json.gz');
  await expect(page.getByText(/Event 1 of \d+/)).toBeVisible();
  await expect(page.locator('.run-status b').first()).toHaveText('Recorded run: trace_limit');
});

test('a destroyed vector and string show an explicit "buffer released" state, values before destruction stay', async ({ page }) => {
  test.setTimeout(90000);
  const src = readFileSync(new URL('./programs/released_buffer.cpp', import.meta.url), 'utf8');
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto('/');
  await expect(page.getByTestId('backend-state')).toContainText('Backend online');
  await page.getByLabel('Language').selectOption('cpp');
  await page.getByLabel('C++ source code').fill(src);
  await page.getByRole('button', { name: 'Run and record' }).click();
  await expect(page.getByText(/Event 1 of \d+/)).toBeVisible({ timeout: 40000 });
  await page.waitForTimeout(900);
  // step to the line that uses v: its four items are visible
  for (let i = 0; i < 12; i++) { if (await page.getByText('[3]').count()) break; await page.getByRole('button', { name: 'Next', exact: true }).click(); await page.waitForTimeout(200); }
  await page.screenshot({ path: `${process.env.SHOTS_DIR || 'test-results/screens'}/released-before.png` });
  await page.getByRole('button', { name: 'Last', exact: true }).click();
  await page.waitForTimeout(700);
  await expect(page.locator('body')).toContainText('std::vector<int> (buffer released)');
  await page.screenshot({ path: `${process.env.SHOTS_DIR || 'test-results/screens'}/released-after.png` });
  await expect(page.locator('body')).toContainText('std::vector<int> (buffer released)');
  await page.screenshot({ path: `${process.env.SHOTS_DIR || 'test-results/screens'}/released-after.png` });
});
