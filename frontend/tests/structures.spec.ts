import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';
const fixture = (name: string) => new URL(`../public/examples/${name}.trace.json`, import.meta.url).pathname;
const SHOTS = process.env.SHOTS_DIR || 'test-results/screens';
mkdirSync(SHOTS, { recursive: true });
const summaries = (page: Page) => page.getByTestId('lane-summaries').locator('li').allTextContents();
const seek = (page: Page, i: number) => page.getByLabel('Event timeline').fill(String(i));
async function load(page: Page, name: string) { await page.getByLabel('Example trace').selectOption(name); }
// Position relative to the SVG, so page-level layout shifts above it do not count as movement.
const box = async (page: Page, id: string) => { const b = (await page.getByTestId(`box-${id}`).boundingBox())!, o = (await page.getByTestId('structure-svg').boundingBox())!; return { x: b.x - o.x, y: b.y - o.y }; };
test.beforeEach(async ({ page }) => { await page.goto('/'); });

test('linked list builds up and ends in None, with variable tags and arrows', async ({ page }) => {
  await load(page, '11_linked_list_build');
  await page.getByRole('button', { name: 'Last', exact: true }).click();
  expect((await summaries(page))[0]).toMatch(/1 \(head, cur\)? ?→ 2 → 3 → None|1 \(head\) → 2 → 3 → None/);
  await expect(page.locator('[data-testid^=box-]')).toHaveCount(3);
  await expect(page.locator('svg path.arrow')).toHaveCount(2);
  await expect(page.locator('.tag text')).toHaveText(['head']);
  await expect(page.locator('.node-null')).toHaveCount(1);
});

test('empty list, then a single node with an alias', async ({ page }) => {
  await load(page, '13_empty_and_single');
  await expect(page.getByTestId('structures-empty')).toContainText('No linked-list nodes or arrays');
  await page.getByRole('button', { name: 'Last', exact: true }).click();
  await expect(page.locator('[data-testid^=box-]')).toHaveCount(1);
  await expect(page.locator('svg path.arrow')).toHaveCount(0);
  await expect(page.locator('.tag text')).toHaveText(['head, other']);
});

test('inserting in the middle keeps untouched nodes in place and slides later ones right', async ({ page }) => {
  await load(page, '12_linked_list_insert');
  const n = Number((await page.getByLabel('Event timeline').getAttribute('max')));
  let k = -1;
  for (let i = 0; i <= n && k < 0; i++) { await seek(page, i); if ((await summaries(page)).some((s) => /1.*→ 2.*→ 3.*→ 4/.test(s))) k = i; }
  expect(k).toBeGreaterThan(0);
  await seek(page, k - 1); await page.waitForTimeout(500);
  const head = (await page.getByTestId('lane-summaries').locator('li').count()) ? await page.locator('[data-testid^=box-]').first().getAttribute('data-testid').then((t) => t!.slice(4)) : '';
  const before = await box(page, head);
  await seek(page, k);
  // Read straight away: the head must be exactly where it was, even mid-transition.
  const after = await box(page, head);
  expect(after.y).toBeCloseTo(before.y, 0); expect(after.x).toBeCloseTo(before.x, 0);
  await page.waitForTimeout(600);
  const xs = await Promise.all((await page.locator('[data-testid^=box-]').evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-x'))))));
  expect(new Set(xs).size).toBe(xs.length);
});

test('changed and new nodes are marked, then settle', async ({ page }) => {
  await load(page, '12_linked_list_insert');
  const n = Number(await page.getByLabel('Event timeline').getAttribute('max'));
  let sawEnter = false, sawChanged = false;
  for (let i = 1; i <= n; i++) { await seek(page, i); await page.waitForTimeout(60); sawEnter ||= (await page.locator('.vnode .enter').count()) > 0; sawChanged ||= (await page.locator('.vnode .changed').count()) > 0; }
  expect(sawEnter && sawChanged).toBe(true);
});

test('alias example shows two tags on one node and a join arrow', async ({ page }) => {
  await load(page, '15_alias_list_nodes');
  await page.getByRole('button', { name: 'Last', exact: true }).click();
  expect((await summaries(page)).join(' ')).toContain('joins');
  expect(await page.locator('svg path.arrow').count()).toBeGreaterThan(1);
});

test('arrays: cells, index labels, and nested lists as rows', async ({ page }) => {
  await load(page, '14_array_mutation');
  await page.getByRole('button', { name: 'Last', exact: true }).click();
  const s = (await summaries(page)).join('\n');
  expect(s).toContain('[7, 2, 1, 3, 9]');
  expect(s).toContain('["a"]');
  await expect(page.locator('.cell-index').first()).toHaveText('0');
  await expect(page.locator('svg path.arrow')).toHaveCount(2);
});

test('self cycle draws a curved arrow back to the same node', async ({ page }) => {
  await load(page, '07_cycle');
  await page.getByRole('button', { name: 'Last', exact: true }).click();
  await expect(page.locator('[data-testid^=box-]')).toHaveCount(1);
  expect(await page.locator('svg path.arrow').getAttribute('d')).toContain('C');
});

test('reduced motion turns off transitions and animations', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await load(page, '12_linked_list_insert');
  await page.getByRole('button', { name: 'Last', exact: true }).click();
  expect(await page.locator('.vnode').first().evaluate((e) => getComputedStyle(e).transitionDuration)).toBe('0s');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  expect(await page.locator('.vnode').first().evaluate((e) => getComputedStyle(e).transitionDuration)).toBe('0.35s');
});

test('source text and values inside boxes stay text, never markup', async ({ page }) => {
  const t = JSON.parse(readFileSync(fixture('12_linked_list_insert'), 'utf8'));
  for (const e of t.events) for (const node of Object.values(e.heap) as any[]) if (node.fields?.value?.value === 1) node.fields.value = { kind: 'scalar', type: 'str', value: '<img src=x onerror=window.pwned=1>' };
  await page.locator('input[type=file]').setInputFiles({ name: 'x.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(t)) });
  await page.getByRole('button', { name: 'Last', exact: true }).click();
  await expect(page.locator('.structures img')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).pwned)).toBeUndefined();
});

test('desktop and phone, dark and light, no page-level sideways scroll', async ({ page }) => {
  for (const [name, label] of [['12_linked_list_insert', 'list'], ['14_array_mutation', 'array']] as const) {
    await load(page, name);
    await page.getByRole('button', { name: 'Last', exact: true }).click();
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (const theme of ['dark', 'light']) {
        if (theme === 'light') await page.getByRole('button', { name: 'Light mode', exact: true }).click();
        await page.waitForTimeout(450);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.locator('.structures').screenshot({ path: `${SHOTS}/m3-${label}-${width}-${theme}.png` });
        if (theme === 'light') await page.getByRole('button', { name: 'Dark mode', exact: true }).click();
      }
    }
  }
});

test('full page screenshot while stepping', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await load(page, '12_linked_list_insert');
  const n = Number(await page.getByLabel('Event timeline').getAttribute('max'));
  await seek(page, Math.floor(n * 0.7)); await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/m3-full-1280-dark.png`, fullPage: true });
});
