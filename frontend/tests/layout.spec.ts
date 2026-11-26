// Layout check, no screenshots needed: at sampled steps (up to 40 per recording, first and last included) of real
// recordings, every drawn arrow must start on its own source box and end on its own target box (within a few pixels).
// Catches arrows that point into blank space or at a neighbour. Sampled steps, not every step.
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
const here = new URL('./', import.meta.url);
const m6 = readdirSync(new URL('programs/m6/', here)).filter((f) => f.endsWith('.py') || f.endsWith('.cpp'));
const own = readdirSync(new URL('../programs/', here)).filter((f) => f.endsWith('.py') && !f.startsWith('__'));
const cases: [string, string, 'python' | 'cpp'][] = [
  ...m6.map((f): [string, string, 'python' | 'cpp'] => [`m6/${f}`, readFileSync(new URL(`programs/m6/${f}`, here), 'utf8'), f.endsWith('.cpp') ? 'cpp' : 'python']),
  ...own.map((f): [string, string, 'python' | 'cpp'] => [`programs/${f}`, readFileSync(new URL(`../programs/${f}`, here), 'utf8'), 'python']),
  ['tests/huffman.cpp', readFileSync(new URL('programs/huffman.cpp', here), 'utf8'), 'cpp'],
];
const TOL = 6;          // an arrow's head must end within this of a box
const START_TOL = 22;   // array arrows leave from just below the cell's index label (20 px under the cell)
const settle = (page: Page) => page.waitForFunction(() => document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity && a.playState === 'running').length === 0, null, { timeout: 5000 }).then(() => page.waitForTimeout(120));
// Each arrow carries its source and target heap ids. Returns the arrows whose start is not on its own source box
// or whose end is not on its own target box (a neighbour's box does not count).
const stray = (page: Page) => page.evaluate(([tol, startTol]) => {
  const svg = document.querySelector('[data-testid="structure-svg"]') as SVGSVGElement | null;
  if (!svg) return { arrows: 0, bad: [] as string[] };
  // Compare in screen pixels: arrows live inside translated groups, so read each point through its own transform.
  const rects = (id: string) => [...svg.querySelectorAll(`[data-testid="box-${id}"] .node-box, [data-testid="box-${id}"] .card-box, [data-testid="box-${id}"] .cell-box, [data-testid="box-${id}"] .vertex-box`)].map((r) => {
    const b = r.getBoundingClientRect(); return { x0: b.left, y0: b.top, x1: b.right, y1: b.bottom };
  });
  const dist = (id: string, px: number, py: number) => Math.min(...rects(id).map((b) => Math.hypot(Math.max(b.x0 - px, 0, px - b.x1), Math.max(b.y0 - py, 0, py - b.y1))), Infinity);
  const bad: string[] = []; const paths = [...svg.querySelectorAll('path.arrow')] as SVGPathElement[];
  paths.forEach((p, i) => {
    const from = p.getAttribute('data-from') ?? '?', to = p.getAttribute('data-to') ?? '?';
    const m = p.getScreenCTM()!, len = p.getTotalLength();
    const at = (t: number) => { const q = p.getPointAtLength(t); return new DOMPoint(q.x, q.y).matrixTransform(m); };
    const a = at(0), z = at(len), ds = dist(from, a.x, a.y), de = dist(to, z.x, z.y);
    if (ds > startTol) bad.push(`arrow ${i} ${from}->${to}: start is ${ds === Infinity ? 'on no drawn box' : ds.toFixed(1) + 'px from'} ${from}`);
    if (de > tol) bad.push(`arrow ${i} ${from}->${to}: end is ${de === Infinity ? 'on no drawn box' : de.toFixed(1) + 'px from'} ${to}`);
  });
  return { arrows: paths.length, bad };
}, [TOL, START_TOL] as const);

for (const [name, code, lang] of cases) {
  test(`arrows start and end on boxes at sampled steps: ${name}`, async ({ page }) => {
    test.setTimeout(100000);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/');
    await expect(page.getByTestId('backend-state')).toContainText('Backend online');
    if (lang === 'cpp') await page.getByLabel('Language').selectOption('cpp');
    await page.getByLabel(lang === 'cpp' ? 'C++ source code' : /source code/).fill(code);
    await page.getByRole('button', { name: 'Run and record' }).click();
    await expect(page.getByText(/Event 1 of \d+/)).toBeVisible({ timeout: 40000 });
    const count = Number((await page.getByText(/Event 1 of (\d+)/).textContent())!.match(/of (\d+)/)![1]);
    const picks = [...new Set(Array.from({ length: Math.min(count, 40) }, (_, k) => Math.round((k * (count - 1)) / Math.max(Math.min(count, 40) - 1, 1))))];
    let arrowsSeen = 0; const problems: string[] = [];
    for (const i of picks) {
      await page.getByLabel('Event timeline').fill(String(i)); await settle(page);
      const r = await stray(page); arrowsSeen += r.arrows;
      r.bad.forEach((b) => problems.push(`step ${i}: ${b}`));
    }
    console.log(`LAYOUT ${name}: ${count} events, ${picks.length} sampled, ${arrowsSeen} arrows checked, ${problems.length} problems`);
    expect(problems.slice(0, 5)).toEqual([]);
  });
}
