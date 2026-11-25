// Regression: an arrow that points at an empty list must land on a visible box (empty lists used to draw nothing).
import { test, expect } from '@playwright/test';
test('empty lists are drawn, so arrows pointing at them land on a visible box', async ({ page }) => {
  test.setTimeout(60000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByLabel(/source code/).fill('adj = [[] for _ in range(4)]\nprint("x")\n');
  await page.getByRole('button', { name: 'Run and record' }).click();
  await page.getByText(/Event 1 of \d+/).waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: 'Last', exact: true }).click(); await page.waitForTimeout(400);
  await expect(page.getByTestId('empty-array')).toHaveCount(4);
  for (const g of await page.getByTestId('empty-array').all()) { const r = await g.boundingBox(); expect(r!.width).toBeGreaterThan(10); }
});
