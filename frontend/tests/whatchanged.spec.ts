import { test, expect } from '@playwright/test';
// Visualization plan B1 + B2: the plain-words step summary and the "just ran" / "runs next" line markers.
test.beforeEach(async ({ page }) => { await page.goto('/'); });
test('alias example: each step says what the previous line did, and marks that line', async ({ page }) => {
  await page.getByRole('button', { name: 'Explore alias example' }).click();
  const head = page.getByTestId('wc-headline'), next = page.getByRole('button', { name: 'Next', exact: true });
  await expect(head).toContainText('Nothing has run yet');
  await expect(page.locator('.code-line.ran')).toHaveCount(0);
  await next.click(); await next.click();
  await expect(head).toHaveText('Line 1 ran.');
  await expect(page.getByTestId('what-changed')).toContainText('a now refers to list o1');
  await expect(page.locator('.code-line.ran')).toHaveCount(1);
  await expect(page.locator('.code-line.ran .line-number')).toHaveText('1');
  await expect(page.locator('.code-line.active .line-number')).toHaveText('2');
  await next.click();
  await expect(page.getByTestId('what-changed')).toContainText('b now refers to list o1');
  await page.getByRole('button', { name: 'Last', exact: true }).click();
  await expect(page.getByTestId('what-changed')).toContainText('list o1 grew from 1 to 2 items (added 2)');
  // Going backwards recomputes the summary for that step; nothing is cached from the forward pass.
  await page.getByRole('button', { name: 'Previous', exact: true }).click();
  await expect(page.getByTestId('what-changed')).toContainText('b now refers to list o1');
});
