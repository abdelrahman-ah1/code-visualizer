import { test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
// Visualization plan C1 (index markers) and C2 (an object that drops out fades where it was).
test.beforeEach(async ({ page }) => { await page.goto('/'); });
test('bubble sort: the j marker sits under the cell being compared', async ({ page }) => {
  await page.locator('input[type=file]').setInputFiles(fileURLToPath(new URL('./fixtures/bubble_sort.trace.json', import.meta.url)));
  await page.getByLabel('Event timeline').fill('12');
  const mark = page.locator('[data-testid^="imark-"]');
  await expect(mark).toHaveCount(1);
  await expect(mark.locator('text')).toHaveText('j');
  const j = Number(await page.getByTestId('var-0-j').locator('.frame-val').textContent());
  await expect(mark).toHaveAttribute('data-testid', new RegExp(`-${j}$`));
});
test('a node that becomes unreachable leaves a fading ghost for one step', async ({ page }) => {
  await page.getByLabel('Example trace').selectOption('cpp_07_memory_leak');
  await page.getByLabel('Event timeline').fill('3');
  await expect(page.getByTestId('ghost-o1')).toHaveCount(1);
  await expect(page.getByTestId('box-o1')).toHaveCount(0);
  await page.getByLabel('Event timeline').fill('4');
  await expect(page.getByTestId('ghost-o1')).toHaveCount(0);
});
