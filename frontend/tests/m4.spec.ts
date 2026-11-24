// M4 end-to-end tests: real Chrome, real Vite dev server, real FastAPI backend, real tracer.
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
const SHOTS = process.env.SHOTS_DIR || 'test-results/screens';
mkdirSync(SHOTS, { recursive: true });

const LOOP = 'total = 0\nfor i in range(3):\n    total += i\n';   // same program as fixture 02_loop
const ed = async (page: Page) => { const b = page.getByRole('button', { name: 'Edit code' }); if (await b.isVisible()) await b.click(); return page.getByLabel('Python source code'); };   // the editor folds away after a run
const run = (page: Page) => page.getByRole('button', { name: 'Run and record' });
async function runCode(page: Page, code: string) {
  await (await ed(page)).fill(code);
  await run(page).click();
  await expect(page.getByText(/Event 1 of \d+/)).toBeVisible();
}
test.beforeEach(async ({ page }) => { await page.goto('/'); await expect(page.getByTestId('backend-state')).toContainText('Backend online'); });

test('paste code, run, replay: alias program shows one shared list', async ({ page }) => {
  await runCode(page, 'a = [1]\nb = a\nb.append(2)\n');
  await expect(page.locator('.run-status')).toContainText('Recorded run: ok');
  await page.getByRole('button', { name: 'Last', exact: true }).click();
  await expect(page.locator('.heap-node')).toHaveCount(1);
  await expect(page.locator('.heap-node .scalar')).toHaveText(['1', '2']);
  await page.getByRole('tab', { name: 'Call stack' }).click();
  await expect(page.locator('.frame .ref')).toHaveCount(2);
  await expect(page.locator('.source-panel')).toContainText('b.append(2)');
  await expect(page.getByTestId('run-info')).toContainText('on the backend');
  await expect(page.getByTestId('load-stats')).toContainText('validated');
});

test('built-in examples load into the editor and run, including input', async ({ page }) => {
  await page.getByLabel('Example program').selectOption('08_stdout_input');
  await expect((await ed(page))).toHaveValue(/input\(\)/);
  await run(page).click();
  await expect(page.getByText(/Event 1 of \d+/)).toBeVisible();
  await page.getByRole('button', { name: 'Last', exact: true }).click();
  await expect(page.getByTestId('stdout')).toContainText('Hello Ada');
  await page.getByLabel('Example program').selectOption('16_bubble_sort');
  await expect((await ed(page))).toHaveValue(/data\[j\]/);
});

test('failed runs are shown honestly, never as success', async ({ page }) => {
  await (await ed(page)).fill('x = 1\nraise ValueError("no")\n'); await run(page).click();
  await expect(page.locator('.run-status')).toContainText('Recorded run: error');
  await expect(page.locator('.run-status')).toContainText('ValueError');
  await (await ed(page)).fill('i = 0\nwhile True:\n    i = i + 1\n'); await run(page).click();
  await expect(page.locator('.run-status b')).toHaveText('Recorded run: trace_limit');
  await (await ed(page)).fill('def g():\n    yield 1\n'); await run(page).click();
  await expect(page.locator('.run-status b')).toHaveText('Recorded run: unsupported');
  await (await ed(page)).fill('x = 1\nif x\n'); await run(page).click();
  await expect(page.locator('.run-status')).toContainText('SyntaxError on line 2');
});

test('breakpoints: play stops before the line, jump buttons move between stops, keyboard toggles', async ({ page }) => {
  await runCode(page, LOOP);                                       // 10 events; line 3 is event 4, 6, 8 (1-based)
  await expect(page.getByRole('button', { name: 'Next breakpoint' })).toBeDisabled();
  await page.getByRole('button', { name: 'Breakpoint on line 3' }).click();
  await expect(page.getByRole('button', { name: 'Breakpoint on line 3' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('breakpoint-note')).toContainText('line 3');
  await page.getByLabel('Playback speed').selectOption('8');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(page.getByTestId('breakpoint-hit')).toContainText('line 3');
  await expect(page.getByText('Event 4 of 10', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();   // paused, not still playing
  await page.getByRole('button', { name: 'Play', exact: true }).click();                 // continues to the NEXT stop
  await expect(page.getByText('Event 6 of 10', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Next breakpoint' }).click();
  await expect(page.getByText('Event 8 of 10', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next breakpoint' })).toBeDisabled();
  await page.getByRole('button', { name: 'Previous breakpoint' }).click();
  await expect(page.getByText('Event 6 of 10', { exact: true })).toBeVisible();
  // Keyboard: focus the gutter button of line 3, Enter removes it.
  await page.getByRole('button', { name: 'Breakpoint on line 3' }).focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Breakpoint on line 3' })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('breakpoint-hit')).toHaveCount(0);
});

test('a breakpoint on a line that never runs is reported', async ({ page }) => {
  await runCode(page, 'x = 1\nif x > 5:\n    x = 2\n');
  await page.getByRole('button', { name: 'Breakpoint on line 3' }).click();
  await expect(page.getByTestId('breakpoint-note')).toContainText('Never reached in this recording: 3');
  await expect(page.getByRole('button', { name: 'Next breakpoint' })).toBeDisabled();
});

test('breakpoints survive a re-run of edited code but not loading a different recording', async ({ page }) => {
  await runCode(page, LOOP);
  await page.getByRole('button', { name: 'Breakpoint on line 2' }).click();
  await (await ed(page)).fill(LOOP + 'print(total)\n'); await run(page).click();
  await expect(page.locator('.source-panel')).toContainText('print(total)');   // the new run has landed
  await expect(page.getByRole('button', { name: 'Breakpoint on line 2' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByLabel('Example trace').selectOption('05_alias');
  await expect(page.getByRole('button', { name: 'Breakpoint on line 2' })).toHaveAttribute('aria-pressed', 'false');
});

test('variable watch follows values and jumps between changes', async ({ page }) => {
  await runCode(page, LOOP);
  await page.getByRole('tab', { name: 'Watch' }).click();
  await page.getByLabel('Watch expression').fill('total'); await page.getByRole('button', { name: 'Add watch' }).click();
  await expect(page.getByTestId('watch-value')).toContainText('not in scope');
  await page.getByRole('button', { name: 'Next change of total' }).click();
  await expect(page.getByText('Event 3 of 10', { exact: true })).toBeVisible();
  await expect(page.getByTestId('watch-value')).toHaveText('0');
  await expect(page.locator('.watch-changed')).toBeVisible();
  await page.getByRole('button', { name: 'Next change of total' }).click();
  await expect(page.getByTestId('watch-value')).toHaveText('1');
  await page.getByRole('button', { name: 'Next change of total' }).click();
  await expect(page.getByTestId('watch-value')).toHaveText('3');
  await expect(page.getByText('Event 9 of 10', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next change of total' })).toBeDisabled();
  await page.getByRole('button', { name: 'Previous change of total' }).click();
  await expect(page.getByTestId('watch-value')).toHaveText('1');
  await page.getByRole('button', { name: 'Remove watch total' }).click();
  await expect(page.getByTestId('watch-row')).toHaveCount(0);
});

test('watch handles objects, list items and bad input without evaluating anything', async ({ page }) => {
  await runCode(page, 'items = [10, 20]\nitems.append(30)\nitems[0] = 99\n');
  await page.getByRole('button', { name: 'Last', exact: true }).click();
  await page.getByRole('tab', { name: 'Watch' }).click();
  for (const text of ['items', 'items[0]', 'items[-1]', 'items[9]']) { await page.getByLabel('Watch expression').fill(text); await page.getByRole('button', { name: 'Add watch' }).click(); }
  await expect(page.getByTestId('watch-value')).toHaveText(['[99, 20, 30]', '99', '30', 'index out of range']);
  await page.getByLabel('Watch expression').fill('__import__("os").getcwd()'); await page.getByRole('button', { name: 'Add watch' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Cannot read' })).toBeVisible();
  await page.getByLabel('Watch expression').fill('items'); await page.getByRole('button', { name: 'Add watch' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Already watching items' })).toBeVisible();
  await expect(page.getByTestId('watch-row')).toHaveCount(4);
});

test('backend problems: busy, rejected request, server error, and offline', async ({ page }) => {
  await (await ed(page)).fill('x = 1\n');
  await page.route('**/api/trace', (route) => route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: { code: 'busy', message: '2 runs are already in progress. Try again in a moment.' } }) }));
  await run(page).click();
  await expect(page.getByTestId('run-error')).toContainText('2 runs are already in progress');
  await page.unroute('**/api/trace');
  await page.route('**/api/trace', (route) => route.fulfill({ status: 500, contentType: 'text/plain', body: 'Internal Server Error' }));
  await run(page).click();
  await expect(page.getByTestId('run-error')).toContainText('answered 500');
  await page.unroute('**/api/trace');
  await page.route('**/api/trace', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"schema_version":"codeviz.trace/2.0"}' }));
  await run(page).click();
  await expect(page.getByRole('alert').filter({ hasText: 'supported version' })).toBeVisible();   // never replayed
  await page.unroute('**/api/trace');
  await page.route('**/api/trace', (route) => route.abort());
  await run(page).click();
  await expect(page.getByTestId('run-error')).toContainText('Could not reach the local backend');
  await expect(page.getByTestId('backend-state')).toHaveText('Backend offline');
  await expect(page.getByTestId('offline-help')).toContainText('uvicorn backend.app:app');
});

test('with the backend down, saved recordings still open and replay', async ({ page }) => {
  await page.route('**/api/**', (route) => route.abort());
  await page.reload();
  await expect(page.getByTestId('backend-state')).toHaveText('Backend offline');
  await expect(page.getByLabel('Example program')).toBeDisabled();
  await page.getByLabel('Example trace').selectOption('03_recursion');
  await page.getByRole('button', { name: 'Last', exact: true }).click();
  await page.getByRole('tab', { name: 'Call stack' }).click();
  await expect(page.locator('.frame')).toHaveCount(1);
  await page.screenshot({ path: `${SHOTS}/m4-backend-offline.png`, fullPage: true });
});

test('stale notice, cancel, and draft persistence', async ({ page }) => {
  await runCode(page, LOOP);
  await expect(page.getByTestId('stale-note')).toHaveCount(0);
  await (await ed(page)).fill(LOOP + '# changed\n');
  await expect(page.getByTestId('stale-note')).toBeVisible();
  await page.waitForTimeout(600); await page.reload();
  await expect((await ed(page))).toHaveValue(LOOP + '# changed\n');
  // Cancel: hold the response, press Cancel, then the late response must not replace anything.
  let release: () => void = () => {}; const gate = new Promise<void>((r) => { release = r; });
  await page.route('**/api/trace', async (route) => { await gate; await route.continue(); });
  await run(page).click();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('run-error')).toContainText('Stopped waiting');
  release();
  await expect(run(page)).toBeVisible();
  await expect(page.getByText(/Event 1 of/)).toHaveCount(0);
});

test('oversized source cannot be run, and the editor tab key indents', async ({ page }) => {
  await (await ed(page)).fill('# ' + 'x'.repeat(70000));
  await expect(run(page)).toBeDisabled();
  await (await ed(page)).fill('if True:\n'); await (await ed(page)).press('End'); await (await ed(page)).press('Control+End'); await (await ed(page)).press('Tab');
  await expect((await ed(page))).toHaveValue('if True:\n    ');
  await (await ed(page)).press('Escape'); await (await ed(page)).press('Tab');
  await expect((await ed(page))).not.toBeFocused();
});

test('export a run as a session; the offline file replays with breakpoints and watch, no network', async ({ page, browser }) => {
  await runCode(page, LOOP);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export session (.html)' }).click()]);
  expect(download.suggestedFilename()).toBe('editor-run.session.html');
  await download.saveAs('test-results/m4-run.session.html');
  const ctx = await browser.newContext({ offline: true }); const p = await ctx.newPage();
  const bad: string[] = []; p.on('request', (r) => { if (!/^(file|data|blob):/.test(r.url())) bad.push(r.url()); });
  const errors: string[] = []; p.on('pageerror', (e) => errors.push(String(e))); p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await p.goto('file://' + process.cwd() + '/test-results/m4-run.session.html');
  await expect(p.getByLabel('Python source code')).toHaveCount(0);   // no editor, no backend in a shared file
  await p.getByRole('button', { name: 'Breakpoint on line 3' }).click();
  await p.getByRole('button', { name: 'Next breakpoint' }).click();
  await expect(p.getByText('Event 4 of 10', { exact: true })).toBeVisible();
  await p.getByRole('tab', { name: 'Watch' }).click();
  await p.getByLabel('Watch expression').fill('total'); await p.getByRole('button', { name: 'Add watch' }).click();
  await expect(p.getByTestId('watch-value')).toHaveText('0');
  expect(bad).toEqual([]); expect(errors).toEqual([]);
  await ctx.close();
});

test('screenshots: editor, run result, breakpoint and watch, desktop dark/light and phone', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByLabel('Example program').selectOption('17_reverse_linked_list');
  await run(page).click(); await expect(page.getByText(/Event 1 of \d+/)).toBeVisible();
  await page.getByRole('button', { name: 'Breakpoint on line 10' }).click();
  await page.getByRole('tab', { name: 'Watch' }).click();
  await page.getByLabel('Watch expression').fill('cur.value'); await page.getByRole('button', { name: 'Add watch' }).click();
  await page.getByLabel('Watch expression').fill('prev'); await page.getByRole('button', { name: 'Add watch' }).click();
  await page.getByRole('button', { name: 'Next breakpoint' }).click(); await page.getByRole('button', { name: 'Next breakpoint' }).click();
  await expect(page.getByTestId('breakpoint-hit')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/m4-desktop-dark.png`, fullPage: true });
  await page.getByRole('button', { name: 'Light mode' }).click();
  await page.screenshot({ path: `${SHOTS}/m4-desktop-light.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `${SHOTS}/m4-phone-light.png`, fullPage: true });
  await page.getByRole('button', { name: 'Dark mode' }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `${SHOTS}/m4-phone-dark.png`, fullPage: true });
});
