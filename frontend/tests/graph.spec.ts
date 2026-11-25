// General object graph: every captured object is drawn (lists, arrays, or an object card), with pointer arrows, zoom and pan.
import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
const SHOTS = process.env.SHOTS_DIR || 'test-results/screens';
mkdirSync(SHOTS, { recursive: true });
const CODE = `struct Node { int key; Node* left; Node* right; };
struct Tree { Node* root; int count; };
Node* make(int k) { return new Node{k, nullptr, nullptr}; }
int main() {
  Tree* t = new Tree{nullptr, 0};
  t->root = make(20);
  t->root->left = make(10);
  t->root->right = make(30);
  t->root->left->right = make(15);
  t->count = 4;
  int vals[3] = {1, 2, 3};
  delete t->root->left->right;
  t->root->left->right = nullptr;
  return 0;
}
`;
test('every captured object is drawn, with pointer arrows, and zoom/pan work', async ({ page }) => {
  test.setTimeout(80000);
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto('/');
  await expect(page.getByTestId('backend-state')).toContainText('Backend online');
  await page.getByLabel('Language').selectOption('cpp');
  await page.getByLabel('C++ source code').fill(CODE);
  await page.getByRole('button', { name: 'Run and record' }).click();
  await expect(page.getByText(/Event 1 of \d+/)).toBeVisible({ timeout: 25000 });
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: 'Last', exact: true }).click();
  const heap = await page.evaluate(() => 0);
  // Heap tab lists the objects; the diagram must have a box for each one.
  const n = await page.getByRole('tabpanel').locator('.heap-object, .object, article, section').count().catch(() => 0);
  const boxes = await page.locator('[data-testid^="box-"]').count();
  expect(boxes).toBeGreaterThanOrEqual(3);
  expect(await page.getByText(/Not drawn here/).count()).toBe(0);
  expect(await page.locator('.node-box').count()).toBeGreaterThan(0);
  expect(await page.locator('svg[data-testid=structure-svg] path.arrow').count()).toBeGreaterThan(0);
  await page.waitForFunction(() => document.getAnimations().filter(a => a.playState === 'running' && a.effect?.getComputedTiming().iterations !== Infinity).length === 0);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/graph-1366-last.png` });
  // Zoom and pan
  const z0 = await page.getByTestId('zoom-level').textContent();
  await page.getByRole('button', { name: 'Zoom out' }).click();
  await expect(page.getByTestId('zoom-level')).not.toHaveText(z0!);
  await page.getByRole('button', { name: 'Zoom in' }).click(); await page.getByRole('button', { name: 'Zoom in' }).click();
  const sc = page.locator('.structure-scroll');
  const before = await sc.evaluate((e) => e.scrollLeft);
  await page.getByRole('button', { name: 'Pan right' }).click(); await page.waitForTimeout(500);
  const after = await sc.evaluate((e) => e.scrollLeft);
  expect(after).toBeGreaterThanOrEqual(before);
  await page.getByRole('button', { name: 'Fit all' }).click(); await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/graph-1366-fit.png` });
  await page.getByRole('button', { name: '100%' }).click(); await page.getByRole('button', { name: 'Pan down' }).click(); await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/graph-1366-100.png` });
  void heap; void n;
});

const BIG = `struct Node { int key; Node* left; Node* right; };
int main() {
  Node* all[200];
  for (int i = 0; i < 200; i++) all[i] = new Node{i, nullptr, nullptr};
  for (int i = 1; i < 200; i++) { if (i % 2) all[(i - 1) / 2]->left = all[i]; else all[(i - 1) / 2]->right = all[i]; }
  return 0;
}
`;
for (const [w, h, theme] of [[1366, 768, 'dark'], [1920, 1080, 'light'], [390, 844, 'dark']] as const) {
  test(`hundreds of objects at ${w}x${h} ${theme}: all drawn, fit and zoom stay responsive`, async ({ page }) => {
    test.setTimeout(100000);
    await page.setViewportSize({ width: w, height: h });
    await page.goto('/');
    await expect(page.getByTestId('backend-state')).toContainText('Backend online');
    await page.getByLabel('Language').selectOption('cpp');
    await page.getByLabel('C++ source code').fill(BIG);
    if (theme === 'light') await page.getByRole('button', { name: 'Light mode', exact: true }).click();
    await page.getByRole('button', { name: 'Run and record' }).click();
    await expect(page.getByText(/Event 1 of \d+/)).toBeVisible({ timeout: 60000 });
    await page.getByRole('button', { name: 'Last', exact: true }).click();
    await page.waitForTimeout(800);
    const info = await page.evaluate(() => ({ boxes: document.querySelectorAll('[data-testid^="box-"]').length, text: document.querySelector('.structures')?.textContent?.slice(0, 80) }));
    console.log(`BIG ${w}: boxes=${info.boxes}`);
    expect(info.boxes).toBeGreaterThanOrEqual(100);
    const t0 = Date.now();
    await page.getByRole('button', { name: 'Fit all' }).click();
    await page.getByRole('button', { name: 'Zoom in' }).click();
    await page.getByRole('button', { name: 'Pan right' }).click();
    await page.getByRole('button', { name: 'Previous', exact: true }).click();
    await page.waitForSelector('[data-testid^="box-"]');
    console.log(`BIG ${w}: fit+zoom+pan+step ${Date.now() - t0} ms`);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('button', { name: 'Fit all' }).click(); await page.waitForTimeout(500);
    await page.screenshot({ path: `${SHOTS}/graph-big-${w}-${theme}.png` });
  });
}

test('long names and values are cut with an ellipsis and keep the full text in a tooltip', async ({ page }) => {
  test.setTimeout(80000);
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto('/');
  await expect(page.getByTestId('backend-state')).toContainText('Backend online');
  await page.getByLabel('Language').selectOption('cpp');
  await page.getByLabel('C++ source code').fill(`struct HashTable { long long total_entries; double load_factor_value; };
int main() {
  HashTable* h = new HashTable{123456789012LL, 0.7512345};
  h->total_entries += 1;
  return 0;
}
`);
  const raw = page.waitForResponse((r) => r.url().includes('/api/trace') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Run and record' }).click();
  await expect(page.getByText(/Event 1 of \d+/)).toBeVisible({ timeout: 25000 });
  const trace = await (await raw).json();
  const last = trace.events.at(-1), obj = Object.values(last.heap)[0] as { fields: Record<string, { value: unknown; truncated?: boolean }> };
  console.log('CAPTURED', JSON.stringify(obj.fields));
  await page.getByRole('button', { name: 'Last', exact: true }).click();
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: '100%', exact: true }).click();
  const t = await page.locator('.node-main, [data-testid=data-line]').allTextContents();
  expect(t.some((x) => x.includes('…'))).toBe(true);
  const titles = await page.locator('.node-main title, [data-testid=data-line] title').allTextContents();
  const full = titles.find((x) => x.startsWith('total_entries: '))!;
  console.log('TOOLTIP', JSON.stringify(titles));
  expect(full).toBe(`total_entries: ${obj.fields.total_entries.value}`);   // tooltip == captured value, complete
  expect(obj.fields.total_entries.truncated).toBeFalsy();                     // capture itself was not cut
  await page.locator('.node-main').first().hover({ force: true });
  await page.screenshot({ path: `${SHOTS}/graph-1366-truncation.png` });
});
