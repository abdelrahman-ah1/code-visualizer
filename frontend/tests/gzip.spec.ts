import { test, expect } from '@playwright/test';
import { gzipSync, gunzipSync } from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const OUT = 'test-results/gz'; mkdirSync(OUT, { recursive: true });
const raw = readFileSync('public/examples/12_linked_list_insert.trace.json');
const upload = (page: import('@playwright/test').Page, name: string, buf: Buffer) => page.locator('input[type=file]').setInputFiles({ name, mimeType: 'application/gzip', buffer: buf });

test('open .json.gz, save it again: bytes round-trip exactly; export session still works', async ({ page }) => {
  await page.goto('/');
  await upload(page, 'mine.trace.json.gz', gzipSync(raw));
  await expect(page.getByText('Event 1 of', { exact: false })).toBeVisible();
  await expect(page.locator('.recording-name')).toContainText('mine.trace.json.gz');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save recording (.json.gz)' }).click()]);
  expect(dl.suggestedFilename()).toBe('mine.json.gz');
  await dl.saveAs(`${OUT}/saved.json.gz`);
  const back = gunzipSync(readFileSync(`${OUT}/saved.json.gz`));
  expect(back.equals(raw)).toBe(true);
  await expect(page.getByTestId('export-notice')).toContainText('MiB');
  const [ex] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export session (.html)' }).click()]);
  expect(ex.suggestedFilename()).toBe('mine.session.html');
  // the saved file opens again
  await page.reload(); await upload(page, 'saved.json.gz', readFileSync(`${OUT}/saved.json.gz`));
  await expect(page.getByText('Event 1 of', { exact: false })).toBeVisible();
});
test('plain .json still opens, and an example can be saved as .json.gz', async ({ page }) => {
  await page.goto('/');
  await page.locator('input[type=file]').setInputFiles({ name: 'plain.json', mimeType: 'application/json', buffer: raw });
  await expect(page.getByText('Event 1 of', { exact: false })).toBeVisible();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save recording (.json.gz)' }).click()]);
  expect(dl.suggestedFilename()).toBe('plain.json.gz');
});
test('truncated, corrupt and oversized-when-unpacked files are refused and keep the loaded recording', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Example trace').selectOption('05_alias');
  await expect(page.getByText('Event 1 of', { exact: false })).toBeVisible();
  const z = gzipSync(raw);
  await upload(page, 'cut.json.gz', z.subarray(0, z.length - 20));
  await expect(page.getByRole('alert')).toContainText('damaged or incomplete');
  await expect(page.getByRole('alert')).toContainText('previous recording is still loaded');
  await expect(page.locator('.recording-name')).toContainText('05_alias');
  const bad = Buffer.from(z); bad[Math.floor(bad.length / 2)] ^= 0xff;
  await upload(page, 'bad.json.gz', bad);
  await expect(page.getByRole('alert')).toContainText('damaged or incomplete');
  await upload(page, 'bomb.json.gz', gzipSync(Buffer.alloc(200 * 1048576, 48)));
  await expect(page.getByRole('alert')).toContainText('more than the 20 MiB');
  await upload(page, 'notjson.json.gz', gzipSync(Buffer.from('hello')));
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.locator('.recording-name')).toContainText('05_alias');
});
test('browser without Compression Streams: clear message, .json and export still work, no save button', async ({ page }) => {
  await page.addInitScript(() => { delete (window as any).DecompressionStream; delete (window as any).CompressionStream; });
  await page.goto('/');
  await upload(page, 'a.json.gz', gzipSync(raw));
  await expect(page.getByRole('alert')).toContainText('cannot open .gz');
  await page.locator('input[type=file]').setInputFiles({ name: 'plain.json', mimeType: 'application/json', buffer: raw });
  await expect(page.getByText('Event 1 of', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save recording (.json.gz)' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Export session (.html)' })).toBeVisible();
});
