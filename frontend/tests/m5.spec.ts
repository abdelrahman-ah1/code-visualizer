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

test('a live node behind freed memory is still drawn, flagged unreferenced', async ({ page }) => {
  test.setTimeout(60000);
  await page.getByLabel('Language').selectOption('cpp');
  await openEditor(page);
  await page.getByLabel('C++ source code').fill(`#include <iostream>
#include <string>
struct Entry { std::string key; int value; Entry* next; };
struct HashTable { Entry* buckets[4]; int size; };
int hashOf(const std::string& k, int n) { int h = 0; for (char c : k) h = h * 31 + c; return (h < 0 ? -h : h) % n; }
void put(HashTable* t, const std::string& k, int v) {
  int i = hashOf(k, 4);
  for (Entry* e = t->buckets[i]; e; e = e->next) if (e->key == k) { e->value = v; return; }
  t->buckets[i] = new Entry{k, v, t->buckets[i]};
  t->size++;
}
int main() {
  HashTable t{}; 
  const char* ks[] = {"apple","pear","fig","plum","kiwi","lime"};
  for (int i = 0; i < 6; i++) put(&t, ks[i], i * 10);
  put(&t, "fig", 99);
  Entry* gone = t.buckets[hashOf("pear",4)];
  delete gone;
  std::cout << t.size << "\\n";
  return 0;
}
`);
  await run(page).click();
  await expect(page.getByText(/Event 1 of \d+/)).toBeVisible({ timeout: 25000 });
  await expect(page.locator('.node-box.orphan')).toHaveCount(0);           // nothing is orphaned at the first step
  await page.getByRole('button', { name: 'Last', exact: true }).click();
  await expect(page.locator('.node-box.orphan')).toHaveCount(1);           // "apple": still allocated, nothing points to it
  await expect(page.getByText('· unreferenced')).toBeVisible();
  await expect(page.getByTestId('unreached-heap')).toHaveCount(0);         // every live block is drawn
  await expect(page.locator('[data-testid^="box-"]')).toHaveCount(9);      // 5 entries + the freed node + the table + 2 arrays (buckets, ks)
  await page.screenshot({ path: `${SHOTS}/orphan-node.png`, fullPage: true });
});
test('a live block that never had a type is drawn as raw bytes, not invented', async ({ page }) => {
  test.setTimeout(60000);
  await page.getByLabel('Language').selectOption('cpp');
  await openEditor(page);
  await page.getByLabel('C++ source code').fill('int main() {\n  void* p = new int(5);\n  p = nullptr;\n  return 0;\n}\n');
  await run(page).click();
  await expect(page.getByText(/Event 1 of \d+/)).toBeVisible({ timeout: 25000 });
  await page.getByRole('button', { name: 'Last', exact: true }).click();
  await expect(page.getByTestId('unreached-heap')).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/untyped-block.png`, fullPage: true });
  await expect(page.locator('[data-testid^="box-"]', { hasText: 'untyped block' })).toBeVisible();
});
