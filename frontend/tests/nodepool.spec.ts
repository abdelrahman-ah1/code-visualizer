// Browser checks for the node-pool/1 format: compact save and reopen, session export and reopen, old files still open.
// Uses only shipped examples (public/examples). Compares what the replay page shows, not file bytes.
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
const OUT = 'test-results/nodepool'; mkdirSync(OUT, { recursive: true });
const EX = 'cpp_04_binary_tree_insert';
const exFile = () => readFileSync(new URL(`../public/examples/${EX}.trace.json`, import.meta.url));
const norm = (t: string) => t.replace(/validated in \d+ ms/, 'validated in N ms');
const upload = (page: Page, name: string, mime: string, buf: Buffer) => page.locator('input[type=file]').setInputFiles({ name, mimeType: mime, buffer: buf });
async function views(page: Page) {
  const out: string[] = [];
  await expect(page.getByText(/Event 1 of \d+/).first()).toBeVisible();
  for (const pos of ['First', 'Next', 'Next', 'Next', 'Last']) {
    const b = page.getByRole('button', { name: pos, exact: true }); if (await b.isEnabled()) await b.click();   // First is disabled at event 1
    await page.waitForTimeout(250);
    out.push(norm(await page.locator('.replay-root').innerText()));
  }
  return out;
}
test('compact save writes node-pool/1, reopens to the same replay, and the plain save is unchanged', async ({ page }) => {
  await page.goto('/');
  await upload(page, `${EX}.json`, 'application/json', exFile());
  const original = await views(page);
  await page.getByRole('button', { name: 'First', exact: true }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save compact (.json.gz)' }).click()]);
  expect(dl.suggestedFilename()).toBe(`${EX}.pooled.json.gz`);
  await dl.saveAs(`${OUT}/compact.json.gz`);
  const packed = gunzipSync(readFileSync(`${OUT}/compact.json.gz`)).toString('utf8');
  expect(JSON.parse(packed).encoding).toBe('node-pool/1');
  expect(packed.length).toBeLessThan(exFile().length);
  await expect(page.getByTestId('export-notice')).toContainText('node-pool format');
  // the original "Save recording" button still writes exactly the text that was loaded
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save recording (.json.gz)' }).click()]);
  await dl2.saveAs(`${OUT}/plain.json.gz`);
  expect(gunzipSync(readFileSync(`${OUT}/plain.json.gz`)).toString('utf8')).toBe(exFile().toString('utf8'));
  // reopen the compact file in a fresh page, same display name
  await page.goto('/');
  await upload(page, `${EX}.json`, 'application/gzip', readFileSync(`${OUT}/compact.json.gz`));
  expect(await views(page)).toEqual(original);
});
test('a pooled file opens directly (plain .json and .json.gz), and an old-format file still opens', async ({ page }) => {
  await page.goto('/');
  await upload(page, 'x.json', 'application/json', exFile());
  await page.getByRole('button', { name: 'Save compact (.json.gz)' }).waitFor();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save compact (.json.gz)' }).click()]);
  await dl.saveAs(`${OUT}/c2.json.gz`);
  const pooledText = gunzipSync(readFileSync(`${OUT}/c2.json.gz`));
  await page.goto('/'); await upload(page, `${EX}.json`, 'application/json', pooledText);
  await expect(page.getByText(/Event 1 of \d+/).first()).toBeVisible();
  await page.goto('/'); await upload(page, `${EX}.json.gz`, 'application/gzip', gzipSync(exFile()));
  await expect(page.getByText(/Event 1 of \d+/).first()).toBeVisible();
});
test('session export embeds the pooled form, opens offline from disk and replays the same', async ({ page, browser }) => {
  await page.goto('/');
  await upload(page, `${EX}.json`, 'application/json', exFile());
  const original = await views(page);
  await page.getByRole('button', { name: 'First', exact: true }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export session (.html)' }).click()]);
  await dl.saveAs(`${OUT}/session.html`);
  const html = readFileSync(`${OUT}/session.html`, 'utf8');
  expect(html).toContain('node-pool/1');
  expect(html).not.toMatch(/(src|href)="https?:/);
  const ctx = await browser.newContext({ offline: true }); const p = await ctx.newPage();
  const errors: string[] = []; p.on('pageerror', (e) => errors.push(String(e)));
  await p.goto('file://' + process.cwd() + `/${OUT}/session.html`);
  expect(await views(p)).toEqual(original.map((t) => t));   // same text as the original replay
  expect(errors).toEqual([]);
  await ctx.close();
});
test('a pooled file with a bad node index is refused with a message and keeps the loaded recording', async ({ page }) => {
  await page.goto('/');
  await upload(page, `${EX}.json`, 'application/json', exFile());
  await page.getByRole('button', { name: 'Save compact (.json.gz)' }).waitFor();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save compact (.json.gz)' }).click()]);
  await dl.saveAs(`${OUT}/c3.json.gz`);
  const t = JSON.parse(gunzipSync(readFileSync(`${OUT}/c3.json.gz`)).toString('utf8'));
  const ev = t.events.find((e: any) => Object.keys(e.heap).length); ev.heap[Object.keys(ev.heap)[0]] = 99999;
  await upload(page, 'bad.json', 'application/json', Buffer.from(JSON.stringify(t)));
  await expect(page.getByRole('alert')).toContainText('bad node pool index');
  await expect(page.locator('.recording-name')).toContainText(EX);
});
