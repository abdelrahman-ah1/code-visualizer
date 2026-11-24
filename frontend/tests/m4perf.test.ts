import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { parseTrace } from '../src/parseTrace';
import { buildLineIndex, nextStop, stopIndexes } from '../src/breakpoints';
import { changeIndexes, parseWatch, watchSignatures } from '../src/watch';
// Measured with the real parser on a 10,000 event recording (one repeated alias snapshot).
it('line index, stop lookup and watch signatures on 10,000 events', () => {
  const t = JSON.parse(readFileSync(new URL('../public/examples/05_alias.trace.json', import.meta.url), 'utf8'));
  const last = t.events.at(-1);
  t.events = Array.from({ length: 10000 }, (_, step) => ({ ...last, step, event: 'line', line: 1 + (step % 4) })); t.limits.events = 10000;
  const trace = parseTrace(JSON.stringify(t));
  let s = performance.now(); const index = buildLineIndex(trace.events); const indexMs = performance.now() - s;
  s = performance.now(); const stops = stopIndexes(index, new Set([1, 2])); const stopsMs = performance.now() - s;
  s = performance.now(); for (let i = 0; i < 10000; i++) nextStop(stops, i); const lookupsMs = performance.now() - s;
  const p = parseWatch('a'); if (!p.ok) throw new Error('parse');
  s = performance.now(); const sigs = watchSignatures(trace, p.path); const sigMs = performance.now() - s; changeIndexes(sigs);
  console.log(JSON.stringify({ events: 10000, buildLineIndexMs: +indexMs.toFixed(2), stopIndexesMs: +stopsMs.toFixed(2), tenThousandNextStopLookupsMs: +lookupsMs.toFixed(2), watchSignaturesMs: +sigMs.toFixed(2), node: process.version }));
  expect(stops).toHaveLength(5000); expect(nextStop(stops, 0)).toBe(1);
  expect(indexMs).toBeLessThan(500); expect(sigMs).toBeLessThan(3000);
});
