// A generated "HashTree" (hash table whose buckets are binary search trees) drawn as compartment records:
// data in the main box, every pointer in its own compartment (first on the right, others underneath, names visible).
// This program was written for the test. It is NOT the user's own HashTree source.
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
const SHOTS = process.env.SHOTS_DIR || 'test-results/screens';
mkdirSync(SHOTS, { recursive: true });
const prog = (n: string) => readFileSync(new URL(`./programs/${n}.cpp`, import.meta.url), 'utf8');
async function load(page: Page, name: string) {
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.goto('/');
  await expect(page.getByTestId('backend-state')).toContainText('Backend online');
  await page.getByLabel('Language').selectOption('cpp');
  await page.getByLabel('C++ source code').fill(prog(name));
  await page.getByLabel('Event limit').selectOption('2000');
  await page.getByLabel('Time limit').selectOption('10');
  await page.getByRole('button', { name: 'Run and record' }).click();
  await expect(page.getByText(/Event 1 of \d+/)).toBeVisible({ timeout: 40000 });
  await page.waitForTimeout(900);
}
const settle = async (page: Page) => { await page.waitForFunction(() => document.getAnimations().filter(a => a.effect?.getComputedTiming().iterations !== Infinity && a.playState === 'running').length === 0, null, { timeout: 5000 }); await page.waitForTimeout(250); };
const last = async (page: Page) => { await page.getByRole('button', { name: 'Last', exact: true }).click(); await settle(page); };

test('HashTree: tree nodes show data in the main box and left/right as separate named pointer compartments', async ({ page }) => {
  test.setTimeout(90000);
  await load(page, 'hashtree');
  await last(page);
  await page.getByRole('button', { name: 'Fit all' }).click();
  await page.waitForTimeout(300);
  // 7 tree nodes survive (9 distinct keys inserted, 2 removed). Each has a first-pointer compartment on the right ("left", the first pointer field) and a strip underneath ("right"), both named.
  const rights = page.locator('[data-testid="ptr-right"]'), lefts = page.locator('[data-testid="ptr-left"]');
  await expect(rights).toHaveCount(7); await expect(lefts).toHaveCount(7);
  await expect(page.locator('.ptr-name', { hasText: /^right$/ }).first()).toBeVisible();
  await expect(page.locator('.ptr-name', { hasText: /^left$/ }).first()).toBeVisible();
  // data is NOT drawn as "left: None" lines in the main box
  const dataLines = await page.locator('[data-testid="data-line"]').allTextContents();
  expect(dataLines.some((t) => /^(left|right)\b/.test(t))).toBe(false);
  expect(dataLines.some((t) => t.startsWith('value: 99'))).toBe(true);                                  // the update of key 9 is shown
  // pointer geometry: the first pointer (left) has its compartment beside the main box, the second (right) is a strip underneath
  await page.screenshot({ path: `${SHOTS}/hashtree-final.png`, fullPage: true });
  const node = page.locator('.vnode').filter({ has: page.locator('[data-testid="ptr-left"]') }).first();
  const sideBox = (await node.locator('[data-testid="ptr-left"]').boundingBox())!, stripBox = (await node.locator('[data-testid="ptr-right"]').boundingBox())!;
  const g = { ry: sideBox.y, ly: stripBox.y };
  expect(g.ly).toBeGreaterThan(g.ry + 20);
  await expect(page.getByTestId('unreached-heap')).toHaveCount(0);           // nothing is orphaned in this program
  expect(await page.locator('.arrow').count()).toBe(8);   // HashTree.buckets (1) + 4 bucket roots + 3 tree edges (5->9, 2->10, 8->4)
  await page.screenshot({ path: `${SHOTS}/hashtree-final.png`, fullPage: true });
  await expect(page.locator('.output').first()).toContainText('7');
});

test('HashTree with a dangling pointer: freed node flagged, crash-style diagnostics, backend still usable', async ({ page }) => {
  test.setTimeout(90000);
  await load(page, 'hashtree_bug');
  await last(page);
  await expect(page.locator('.node-box.card-box.freed')).toHaveCount(1);
  await expect(page.getByText(/used after it was freed|use-after-free/i).first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/hashtree-bug.png`, fullPage: true });
  await page.getByRole('button', { name: 'Edit code' }).click();
  await page.getByLabel('Example program').selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Run and record' }).click();
  await expect(page.getByText(/Event 1 of \d+/)).toBeVisible({ timeout: 40000 });
});

test('lost pointer: the node stays allocated, keeps its values and is flagged unreferenced (before/after)', async ({ page }) => {
  test.setTimeout(90000);
  await load(page, 'lost_pointer');              // generated broken program: root->left = nullptr loses the only pointer to node 30 (and 20)
  const gotoLine = async (n: number) => {
    const first = page.getByRole('button', { name: 'First', exact: true });
    if (await first.isEnabled()) await first.click();
    for (let i = 0; i < 30; i++) {
      if (new RegExp(`step \\d+ · line ${n}(?!\\d)`).test((await page.locator('.event-status').first().textContent()) || '')) return;
      await page.getByRole('button', { name: 'Next', exact: true }).click(); await page.waitForTimeout(150);
    }
    throw new Error(`never reached line ${n}`);
  };
  await gotoLine(9);                              // before the line that loses the pointer runs
  await page.getByRole('button', { name: 'Fit all' }).click(); await settle(page);
  await expect(page.locator('.node-box.orphan')).toHaveCount(0);
  await expect(page.locator('[data-testid^="box-"]')).toHaveCount(4);   // the 4 tree nodes (50, 30, 70, 20)
  await page.screenshot({ path: `${SHOTS}/lost-pointer-before.png`, fullPage: true });
  await gotoLine(10);                             // after
  await page.getByRole('button', { name: 'Fit all' }).click(); await settle(page);
  await expect(page.locator('.node-box.orphan')).toHaveCount(2);        // nodes 30 and 20
  await expect(page.locator('.node-box.freed')).toHaveCount(0);         // not freed
  await expect(page.getByTestId('unreached-heap')).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/lost-pointer-after.png`, fullPage: true });
  expect((await page.locator('[data-testid="data-line"]').allTextContents()).some((t) => t.startsWith('value: 300'))).toBe(true);   // node 30 keeps its value
});
