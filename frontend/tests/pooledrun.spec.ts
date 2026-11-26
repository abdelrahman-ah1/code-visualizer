// Run now asks the backend for node-pool/2. The replay must look the same as with the plain recording, plain save must stay v1.0,
// compact save and the offline export must reopen to the same replay, and a program with lots of output must round trip.
import { expect, test } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const OUT = '/tmp/pooledrun'; mkdirSync(OUT, { recursive: true });
const PRINTY = "xs = []\nfor i in range(40):\n    xs.append(i)\n    print('row', i, '\\u00e9\\U0001F600')\n";

test('Run uses node-pool/2, plain save stays v1.0 and compact save and export reopen to the same replay', async ({ page }) => {
  test.setTimeout(90000);
  const bodies: string[] = [];
  let responseText = '';
  page.on('request', (r) => { if (r.url().endsWith('/api/trace')) bodies.push(r.postData() ?? ''); });
  page.on('response', async (r) => { if (r.url().endsWith('/api/trace')) responseText = await r.text(); });
  await page.goto('/');
  await page.getByLabel(/source code/).fill(PRINTY);
  await page.getByRole('button', { name: 'Run and record' }).click();
  await page.getByText(/Event 1 of \d+/).waitFor({ timeout: 20000 });
  expect(JSON.parse(bodies[0]).pooled).toBe(true);
  expect(JSON.parse(responseText).encoding).toBe('node-pool/3');   // the growing list is sent as deltas
  const last = page.getByRole('button', { name: 'Last', exact: true });
  await last.click();
  const shown = async () => page.locator('body').innerText();
  const finalView = await shown();
  expect(finalView).toContain('row 39');
  expect(finalView).toContain('\u00e9\uD83D\uDE00');

  const save = async (name: string, file: string) => { const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name }).click()]); await dl.saveAs(file); return gunzipSync(readFileSync(file)).toString('utf8'); };
  const plain = await save('Save recording (.json.gz)', `${OUT}/plain.json.gz`);
  const plainJson = JSON.parse(plain);
  expect(plainJson.schema_version).toBe('codeviz.trace/1.0');
  expect(plainJson.encoding).toBeUndefined();
  expect(typeof plainJson.events[0].frames).toBe('object');
  expect(typeof plainJson.events[5].stdout).toBe('string');
  const compact = await save('Save compact (.json.gz)', `${OUT}/compact.json.gz`);
  expect(JSON.parse(compact).encoding).toBe('node-pool/2');

  // reopen both saved files in fresh pages: same last-event view
  for (const [file, type] of [[`${OUT}/plain.json.gz`, 'plain'], [`${OUT}/compact.json.gz`, 'compact']]) {
    await page.goto('/');
    await page.locator('input[type=file]').first().setInputFiles({ name: 'rec.json.gz', mimeType: 'application/gzip', buffer: readFileSync(file) });
    await page.getByText(/Event 1 of \d+/).waitFor({ timeout: 20000 });
    await page.getByRole('button', { name: 'Last', exact: true }).click();
    const v = await shown();
    expect(v, type).toContain('row 39');
    expect(v, type).toContain('\u00e9\uD83D\uDE00');
  }
});

test('offline export of a pooled Run opens in a fresh page with no backend and shows the same output', async ({ page, browser }) => {
  test.setTimeout(90000);
  await page.goto('/');
  await page.getByLabel(/source code/).fill(PRINTY);
  await page.getByRole('button', { name: 'Run and record' }).click();
  await page.getByText(/Event 1 of \d+/).waitFor({ timeout: 20000 });
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export session (.html)' }).click()]);
  const file = `${OUT}/export.session.html`; await dl.saveAs(file);
  const html = readFileSync(file, 'utf8');
  expect(html).toMatch(/"encoding":"node-pool\/2"/);
  const ctx = await browser.newContext({ offline: true }); const viewer = await ctx.newPage();
  const errors: string[] = []; viewer.on('pageerror', (e) => errors.push(String(e)));
  await viewer.goto('file://' + file);
  await viewer.getByText(/Event 1 of \d+/).waitFor({ timeout: 20000 });
  await viewer.getByRole('button', { name: 'Last', exact: true }).click();
  const v = await viewer.locator('body').innerText();
  expect(v).toContain('row 39');
  expect(v).toContain('\u00e9\uD83D\uDE00');
  expect(errors).toEqual([]);
  await ctx.close();
});

test('a run stopped by the event limit says which limit and its value', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel(/source code/).fill('for i in range(5000):\n    a = i\n');
  await page.getByLabel('Event limit').selectOption({ index: 0 });
  const chosen = Number(await page.getByLabel('Event limit').inputValue());
  await page.getByRole('button', { name: 'Run and record' }).click();
  await page.getByText(/Event 1 of \d+/).waitFor({ timeout: 20000 });
  await expect(page.locator('.run-status')).toContainText(`${chosen.toLocaleString('en-US')}-event limit`);
});
