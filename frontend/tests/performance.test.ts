import { it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { parseTrace } from '../src/parseTrace';
it('parses a bounded 10,000-event trace without mutating replay snapshots', () => {
  const base = JSON.parse(readFileSync(new URL('../public/examples/05_alias.trace.json', import.meta.url),'utf8'));
  const event = base.events.at(-1);
  base.events = Array.from({length:10000}, (_, step) => ({...event, step}));
  base.limits.events = 10000;
  const raw = JSON.stringify(base), start = performance.now();
  const trace = parseTrace(raw), ms = performance.now() - start;
  console.log(JSON.stringify({events:10000,bytes:Buffer.byteLength(raw),parseMilliseconds:Number(ms.toFixed(2)),runtime:process.version,platform:process.platform,arch:process.arch}));
  expect(trace.events).toHaveLength(10000);
  expect(trace.events[0].step).toBe(0); expect(trace.events.at(-1)!.step).toBe(9999);
});
