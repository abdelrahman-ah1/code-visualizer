import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
const fixture = (name: string) => new URL(`../public/examples/${name}.trace.json`, import.meta.url).pathname;
async function upload(page: import('@playwright/test').Page, trace: unknown) {
  await page.locator('input[type=file]').setInputFiles({name:'edge.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(trace))});
}
test.beforeEach(async ({ page }) => { await page.goto('/'); });
test('alias UI, boundaries, backwards, references and keyboard controls', async ({ page }) => {
  await page.getByRole('button', {name:'Explore alias example'}).click();
  await expect(page.getByRole('button', {name:'Previous',exact:true})).toBeDisabled();
  await page.getByRole('button', {name:'Next',exact:true}).focus(); await page.keyboard.press('Enter');
  await expect(page.locator('.event-status')).toContainText('Before this line executes');
  await page.getByRole('button', {name:'Last',exact:true}).click();
  await expect(page.getByRole('button', {name:'Next',exact:true})).toBeDisabled();
  await page.getByRole('tab', {name:'Call stack'}).click();
  await expect(page.locator('.frame .ref')).toHaveCount(2);
  await page.getByRole('tab', {name:'Heap'}).click();
  await expect(page.locator('.heap-node')).toHaveCount(1);
  await expect(page.locator('.heap-node .scalar')).toHaveText(['1','2']);
  await page.getByRole('button', {name:'Previous',exact:true}).click();
  await expect(page.locator('.heap-node .scalar')).toHaveText(['1']);
  await expect(page.locator('.event-status')).toContainText('Before this line executes');
});
test('output resets backwards; final output is not appended twice', async ({ page }) => {
  await page.getByLabel('Example trace').selectOption('08_stdout_input');
  await page.getByRole('button', {name:'Last',exact:true}).click();
  const final = await page.getByTestId('stdout').textContent();
  expect(final).toContain('Ada');
  await page.getByRole('button', {name:'First',exact:true}).click();
  await expect(page.getByTestId('stdout')).toHaveText('(empty)');
  await page.getByRole('button', {name:'Last',exact:true}).click();
  await expect(page.getByTestId('stdout')).toHaveText(final!);
});
test('play, pause, speed changes, final event and replay use one timer', async ({ page }) => {
  await page.clock.install();
  await page.getByRole('button', {name:'Explore alias example'}).click();
  await page.getByRole('button', {name:'Play',exact:true}).click();
  await page.clock.runFor(500); await expect(page.getByText('Event 2 of 5',{exact:true})).toBeVisible();
  await page.getByRole('button', {name:'Pause',exact:true}).click();
  await page.clock.runFor(3000); await expect(page.getByText('Event 2 of 5',{exact:true})).toBeVisible();
  await page.getByLabel('Playback speed').selectOption('8');
  await page.getByRole('button', {name:'Play',exact:true}).click();
  await page.clock.runFor(125); await expect(page.getByText('Event 3 of 5',{exact:true})).toBeVisible();
  await page.getByLabel('Playback speed').selectOption('1');
  await page.clock.runFor(900); await expect(page.getByText('Event 3 of 5',{exact:true})).toBeVisible();
  await page.clock.runFor(100); await expect(page.getByText('Event 4 of 5',{exact:true})).toBeVisible();
  await page.clock.runFor(1000); await expect(page.getByText('Event 5 of 5',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Replay',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Replay',exact:true}).click();
  await expect(page.getByText('Event 1 of 5',{exact:true})).toBeVisible();
});
test('empty, single snapshot, malformed and partial files', async ({ page }) => {
  const trace = JSON.parse(readFileSync(fixture('05_alias'),'utf8'));
  trace.events = []; await upload(page,trace);
  await expect(page.locator('.event-status')).toContainText('No snapshots');
  await expect(page.getByRole('button',{name:'Play',exact:true})).toBeDisabled();
  trace.events = JSON.parse(readFileSync(fixture('05_alias'),'utf8')).events.slice(0,1); await upload(page,trace);
  await expect(page.getByText('Event 1 of 1',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Play',exact:true})).toBeDisabled();
  delete trace.events[0].frames; await upload(page,trace);
  await expect(page.getByRole('alert')).toContainText('frames');
  await expect(page.getByRole('alert')).toContainText('previous recording');
  await page.locator('input[type=file]').setInputFiles(fixture('10_timeout'));
  await expect(page.locator('.run-status')).toContainText('timeout');
  await expect(page.locator('.output')).toContainText('Final output is missing');
});
test('recursion, cycle, omitted markers and markup remain safe', async ({ page }) => {
  await page.getByLabel('Example trace').selectOption('03_recursion');
  await page.getByLabel('Event timeline').fill('9');
  await page.getByRole('tab', {name:'Call stack'}).click();
  expect(await page.locator('.frame').count()).toBeGreaterThan(1);
  await page.getByLabel('Example trace').selectOption('07_cycle');
  await page.getByRole('button',{name:'Last',exact:true}).click();
  await expect(page.locator('.heap-node a.ref')).toHaveCount(1);
  await page.locator('.heap-node a.ref').click(); await expect(page.locator('.heap-node:target')).toBeVisible();
  const t = JSON.parse(readFileSync(fixture('05_alias'),'utf8'));
  t.source = '<img src=x onerror="window.pwned=1">'; t.events[0].truncated=['locals']; await upload(page,t);
  await expect(page.locator('.event-status')).toContainText('Snapshot omissions: locals');
  await expect(page.locator('code').first()).toHaveText(t.source);
  await expect(page.locator('.source img')).toHaveCount(0);
});
test('desktop and phone layouts in both themes', async ({ page }) => {
  await page.getByLabel('Example trace').selectOption('07_cycle');
  await page.getByRole('button',{name:'Last',exact:true}).click();
  for (const width of [1280,390,320]) {
    await page.setViewportSize({width,height:900});
    for (const theme of ['dark','light']) {
      if (theme === 'light') await page.getByRole('button',{name:'Light mode',exact:true}).click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({path:`/downloads/m2-${width}-${theme}.png`,fullPage:true});
      if (theme === 'light') await page.getByRole('button',{name:'Dark mode',exact:true}).click();
    }
  }
});
test('all run statuses are labeled, and trace replacement stops playback', async ({ page }) => {
  const t = JSON.parse(readFileSync(fixture('05_alias'),'utf8'));
  for (const status of ['ok','error','timeout','trace_limit','output_limit','unsupported','worker_error']) {
    t.status=status; t.complete=['ok','error'].includes(status); await upload(page,t);
    await expect(page.locator('.run-status b')).toHaveText(`Recorded run: ${status}`);
  }
  await page.clock.install();
  await page.getByRole('button',{name:'Play',exact:true}).click();
  await page.locator('input[type=file]').setInputFiles(fixture('03_recursion'));
  await page.clock.runFor(3000);
  await expect(page.locator('.event-status')).toContainText('step 0');
});
test('large bounded recording loads and seeks in the browser', async ({ page, browserName }) => {
  const t = JSON.parse(readFileSync(fixture('05_alias'),'utf8'));
  const e = t.events.at(-1); t.events=Array.from({length:10000},(_,step)=>({...e,step})); t.limits.events=10000;
  const start=Date.now(); await upload(page,t);
  await expect(page.getByText('Event 1 of 10000',{exact:true})).toBeVisible();
  const loadMs=Date.now()-start, seekStart=Date.now();
  await page.getByRole('button',{name:'Last',exact:true}).click();
  await expect(page.getByText('Event 10000 of 10000',{exact:true})).toBeVisible();
  console.log(JSON.stringify({browserName,events:10000,bytes:Buffer.byteLength(JSON.stringify(t)),loadAndRenderMs:loadMs,lastSeekAndAssertMs:Date.now()-seekStart}));
});
test('error and before-line visual states', async ({ page }) => {
  await page.setViewportSize({width:1280,height:900});
  await page.getByRole('button',{name:'Explore alias example'}).click();
  await page.getByRole('button',{name:'Last',exact:true}).click();
  await page.getByRole('button',{name:'Previous',exact:true}).click();
  await page.screenshot({path:'/downloads/m2-before-line.png',fullPage:true});
  await page.locator('input[type=file]').setInputFiles({name:'bad.json',mimeType:'application/json',buffer:Buffer.from('{')});
  await expect(page.getByRole('alert')).toContainText('not valid JSON');
  await page.screenshot({path:'/downloads/m2-error.png',fullPage:true});
});
