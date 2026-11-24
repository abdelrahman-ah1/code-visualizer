// Replay performance measurement in real Chrome. Usage (from frontend/):
//   node perf/measure.mjs http://127.0.0.1:4173 [trace.json ...]
// With no trace arguments it builds its own scenarios from the repository examples.
// It prints one JSON object per scenario: load time, per-step latency, long tasks, JS heap.
// CPU_THROTTLE=6 slows the page's CPU 6x (Chrome DevTools throttling) to imitate a weaker device.
// "Step latency" = Next click until two animation frames later, so the new snapshot has been
// committed AND painted. At 60 Hz one frame is 16.7 ms, so about 33 ms is the floor of this method.
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = process.argv[2] ?? 'http://127.0.0.1:4173';
const dir = mkdtempSync(join(tmpdir(), 'codeviz-perf-'));
const example = (n) => JSON.parse(readFileSync(new URL(`../public/examples/${n}.trace.json`, import.meta.url), 'utf8'));
const scenarios = [];
for (const file of process.argv.slice(3)) scenarios.push({ name: file, path: file });
if (!scenarios.length) {
  // 10,000 events: the replay limit. Synthetic (one repeated snapshot), so it measures size, not realism.
  const big = example('05_alias'); const last = big.events.at(-1);
  big.events = Array.from({ length: 10000 }, (_, step) => ({ ...last, step })); big.limits.events = 10000;
  writeFileSync(join(dir, 'synthetic-10000.json'), JSON.stringify(big));
  // 2,500-line source on a small trace: stresses the source panel (it re-renders per step).
  const src = example('02_loop'); src.source += Array.from({ length: 2500 }, (_, i) => `# filler line ${i}`).join('\n');
  writeFileSync(join(dir, 'source-2500-lines.json'), JSON.stringify(src));
  scenarios.push({ name: 'synthetic-10000-events', path: join(dir, 'synthetic-10000.json') }, { name: 'source-2500-lines', path: join(dir, 'source-2500-lines.json') });
}
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || undefined });
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const pct = (a, p) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
for (const s of scenarios) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.addInitScript(() => { window.__long = []; new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__long.push(e.duration))).observe({ entryTypes: ['longtask'] }); });
  const throttle = Number(process.env.CPU_THROTTLE || 1);
  if (throttle > 1) await (await page.context().newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: throttle });
  await page.goto(base);
  await page.waitForTimeout(800); // let the page settle, as a person would before opening a file
  const t0 = Date.now();
  await page.setInputFiles('input[type=file]', s.path);
  await page.waitForSelector('.controls');
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const loadMs = Date.now() - t0;
  const r = await page.evaluate(async () => {
    const button = (name) => [...document.querySelectorAll('button')].find((x) => x.textContent === name);
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const time = async (fn) => { const t = performance.now(); fn(); await frame(); return performance.now() - t; };
    window.__long.length = 0;
    const steps = [];
    for (let i = 0; i < 60; i++) steps.push(await time(() => button('Next').click()));
    const jumps = [];
    for (let i = 0; i < 10; i++) { jumps.push(await time(() => button('Last').click())); jumps.push(await time(() => button('First').click())); }
    // Drag-style seeking: set the slider to 40 spread-out positions.
    const slider = document.getElementById('step'), setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set, seeks = [];
    for (let i = 0; i < 40; i++) seeks.push(await time(() => { setter.call(slider, String(Math.floor((i * 7919) % (Number(slider.max) + 1)))); slider.dispatchEvent(new Event('input', { bubbles: true })); }));
    return { steps, jumps, seeks, long: [...window.__long], heap: performance.memory ? performance.memory.usedJSHeapSize : null, events: Number(document.getElementById('step').max) + 1 };
  });
  console.log(JSON.stringify({ scenario: s.name, cpuThrottle: throttle, events: r.events, loadMs,
    stepMedianMs: +median(r.steps).toFixed(1), stepP95Ms: +pct(r.steps, .95).toFixed(1), stepMaxMs: +Math.max(...r.steps).toFixed(1),
    jumpMedianMs: +median(r.jumps).toFixed(1), seekMedianMs: +median(r.seeks).toFixed(1), seekP95Ms: +pct(r.seeks, .95).toFixed(1),
    longTasks: r.long.length, longTaskTotalMs: Math.round(r.long.reduce((a, b) => a + b, 0)), jsHeapMB: r.heap ? +(r.heap / 1e6).toFixed(0) : null }));
  await page.close();
}
await browser.close();
