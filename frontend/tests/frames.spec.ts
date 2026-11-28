import { test, expect } from '@playwright/test';
// Visualization plan A1-A3: frames with variable rows inside the structure diagram, arrows into the objects.
test.beforeEach(async ({ page }) => { await page.goto('/'); });
const load = (page: import('@playwright/test').Page, name: string) => page.getByLabel('Example trace').selectOption(name);
test('aliasing: two variables, two arrows, one object', async ({ page }) => {
  await load(page, '05_alias');
  await page.getByRole('button', { name: 'Last', exact: true }).click();
  await expect(page.getByTestId('frames')).toBeVisible();
  await expect(page.getByTestId('var-0-a')).toHaveAttribute('data-target', 'o1');
  await expect(page.getByTestId('var-0-b')).toHaveAttribute('data-target', 'o1');
  await expect(page.locator('path.var-arrow[data-to="o1"]')).toHaveCount(2);
  // The arrows end on the object's name tag, above its box.
  const tag = (await page.locator('[data-testid="box-o1"] .tag').boundingBox())!;
  const end = await page.locator('path.var-arrow').first().evaluate((p: SVGPathElement) => { const q = p.getPointAtLength(p.getTotalLength()), m = p.getScreenCTM()!; const r = new DOMPoint(q.x, q.y).matrixTransform(m); return { x: r.x, y: r.y }; });
  expect(Math.abs(end.y - tag.y)).toBeLessThan(6);
  expect(end.x).toBeGreaterThan(tag.x - 2); expect(end.x).toBeLessThan(tag.x + tag.width + 2);
});
test('recursion: stacked frames, the current one is marked, scalars are written in the rows', async ({ page }) => {
  await load(page, '03_recursion');
  await page.getByLabel('Event timeline').fill('11');
  await expect(page.locator('.frame-box')).toHaveCount(4);
  await expect(page.locator('.frame-box.current')).toHaveCount(1);
  await expect(page.locator('.frame-box.current .frame-head')).toHaveText('factorial');
  await expect(page.getByTestId('var-3-n').locator('.frame-val')).toHaveText('1');
  await expect(page.locator('.frame-box.suspended .frame-line').first()).toHaveText('line 6');
});
test('the Variables button hides and shows the frames column', async ({ page }) => {
  await load(page, '05_alias');
  await page.getByRole('button', { name: 'Last', exact: true }).click();
  await page.getByTestId('toggle-vars').click();
  await expect(page.getByTestId('frames')).toHaveCount(0);
  await expect(page.getByTestId('box-o1')).toBeVisible();
  await page.getByTestId('toggle-vars').click();
  await expect(page.getByTestId('frames')).toBeVisible();
});
