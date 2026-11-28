// Access marks in the browser: the step's line touched a cell, so the cell wears a ring. Screenshots go to SHOTS_DIR.
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
const SHOTS = process.env.SHOTS_DIR || 'test-results/screens';
mkdirSync(SHOTS, { recursive: true });

// The shape from the user's own screenshot: a list of rows, a loop that takes one row at a time, and a comparison on
// line 11 that fetches nothing (so line 11 must stay unmarked while line 9 carries the mark).
const BFS = `edges = [[1, 0, 1], [3, 0, 2], [2, 1, 2], [4, 2, 3]]
n = 5
visited = {0: True}
order = []
parent = {}
while len(visited) < 4:
    m = 9729
    best = None
    for w, u, v in edges:
        if (u in visited and v not in visited) or (v in visited and u not in visited):
            if w < m:
                m = w
                best = (u, v)
    if best is None:
        break
    visited[best[1] if best[1] not in visited else best[2]] = True
    order.append(best)
print(len(visited))
`;
const MARKS = `rows = [[1, 2], [3, 4]]
total = 0
for r in rows:
    total += r[1]
rows[0][0] = 9
print(total)
`;
const rings = (page: Page) => page.locator('[data-testid^="access-ring-"]');
const seek = async (page: Page, i: number) => { await page.getByLabel('Event timeline').fill(String(i)); await page.waitForTimeout(15); };
const total = async (page: Page) => Number((await page.getByText(/Event \d+ of (\d+)/).textContent())!.match(/of (\d+)/)![1]);
const settle = (page: Page) => page.waitForFunction(() => document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity && a.playState === 'running').length === 0, null, { timeout: 5000 }).then(() => page.waitForTimeout(150));

const lineOf = async (page: Page) => Number(((await page.locator('.event-status b').first().textContent()) ?? '').match(/line (\d+)/)?.[1]);
async function run(page: Page, code: string) {
  await page.goto('/');
  await expect(page.getByTestId('backend-state')).toContainText('Backend online');
  await page.getByLabel(/source code/).fill(code);
  await page.getByRole('button', { name: 'Run and record' }).click();
  await expect(page.getByText(/Event 1 of \d+/)).toBeVisible({ timeout: 30000 });
  await page.waitForTimeout(300);
}
// The first step whose source line is `line` and which carries an access mark.
async function seekToMarked(page: Page, line: number): Promise<number | null> {
  const n = await total(page);
  for (let i = 1; i <= n; i++) {
    await seek(page, i);
    if (await lineOf(page) === line && await rings(page).count()) { await settle(page); return i; }
  }
  return null;
}

test('the row the loop takes wears the ring, on the loop line only', async ({ page }) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await run(page, BFS);
  const step = await seekToMarked(page, 9);
  expect(step, 'a step on line 9 that reads a row').not.toBeNull();
  await expect(rings(page)).toHaveCount(1);
  await expect(rings(page).first()).toHaveAttribute('data-mode', 'read');
  // The mark belongs to the line that fetched, and the summary says so in words.
  await expect(page.getByTestId('lane-summaries')).toContainText(/reading cell \d/);
  await page.locator('.structures').screenshot({ path: `${SHOTS}/access-bfs-loop-line.png` });
  // Line 11 is a comparison: it fetches nothing, so it must not wear a ring of its own.
  for (let i = step! + 1; i <= await total(page); i++) {
    await seek(page, i);
    if (await lineOf(page) === 11) { expect(await rings(page).count(), 'line 11 fetches nothing').toBe(0); break; }
  }
});

test('a write is a thicker ring with an arrow-in, and the read and the write of one line are both shown', async ({ page }) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await run(page, MARKS);
  const step = await seekToMarked(page, 5);
  expect(step, 'the step on the store line').not.toBeNull();
  await expect(rings(page)).toHaveCount(2);   // rows[0][0] = 9 reads rows[0] and writes a cell of the inner list
  await expect(page.locator('[data-mode="read"]')).toHaveCount(1);
  await expect(page.locator('[data-mode="write"]')).toHaveCount(1);
  await expect(page.locator('[data-mode="write"]')).toHaveAttribute('data-exact', 'yes');
  await expect(page.locator('.access-in')).toHaveCount(1);   // the arrow-in belongs to the write only
  await expect(page.getByTestId('lane-summaries')).toContainText(/writing cell 0/);
  await page.locator('.structures').screenshot({ path: `${SHOTS}/access-read-and-write.png` });
  // A phone keeps the ring legible: it is a shape on the cell, not a colour that a small screen washes out.
  await page.setViewportSize({ width: 390, height: 844 });
  await seek(page, step!);
  await settle(page);
  await page.locator('.structures').screenshot({ path: `${SHOTS}/access-phone.png` });
});

test('a recording made before access marking draws no rings', async ({ page }) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByLabel('Example trace').selectOption('04_list_mutation');
  await expect(page.getByText(/Event 1 of \d+/)).toBeVisible({ timeout: 30000 });
  for (const i of [1, 2, 3, 4]) { await seek(page, i); expect(await rings(page).count()).toBe(0); }
});
