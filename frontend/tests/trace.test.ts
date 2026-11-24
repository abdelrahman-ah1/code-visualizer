import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { parseTrace } from '../src/parseTrace';
import { clampStep, eventMeaning, outputAt } from '../src/replay';
const read = (name: string) => readFileSync(new URL(`../public/examples/${name}.trace.json`, import.meta.url), 'utf8');
const alias = () => JSON.parse(read('05_alias'));
describe('recorded repository fixtures', () => {
  for (const file of readdirSync(new URL('../public/examples/', import.meta.url))) {
    it(`accepts ${file}`, () => expect(parseTrace(readFileSync(new URL(`../public/examples/${file}`, import.meta.url), 'utf8')).events.length).toBeGreaterThan(0));
  }
  it('shows pre-line values, not pending assignment results', () => {
    const trace = parseTrace(read('01_scalars'));
    const event = trace.events.find((e) => e.event === 'line' && e.line === 2)!;
    expect(event.frames.at(-1)!.locals.x).toMatchObject({ kind: 'scalar', value: 1 });
    expect(eventMeaning(event)).toContain('Before');
  });
  it('keeps recursion frames and return values', () => {
    const t = parseTrace(read('03_recursion'));
    expect(Math.max(...t.events.map((e) => e.frames.length))).toBe(4);
    expect(t.events.filter((e) => e.event === 'return' && e.frames.at(-1)!.function === 'factorial').map((e) => e.return_value)).toMatchObject([{value:1},{value:2},{value:6}]);
  });
  it('preserves shared references, shallow copies and self cycles', () => {
    const e = parseTrace(read('05_alias')).events.at(-1)!;
    expect(e.frames[0].locals.a).toEqual(e.frames[0].locals.b);
    const copy = parseTrace(read('06_shallow_copy')).events.at(-1)!;
    expect(copy.frames[0].locals.a).not.toEqual(copy.frames[0].locals.b);
    const cycle = parseTrace(read('07_cycle')).events.at(-1)!;
    expect(Object.entries(cycle.heap).some(([id, node]) => Object.values(node.fields ?? {}).some((v) => v.kind === 'ref' && v.id === id))).toBe(true);
  });
  it('restores cumulative output backwards without appending or mutation', () => {
    const t = parseTrace(read('08_stdout_input')), before = JSON.stringify(t);
    expect(outputAt(t, t.events.length - 1, 'stdout')).toBe(t.stdout);
    const line2 = t.events.findIndex((e) => e.event === 'line' && e.line === 2);
    expect(outputAt(t, line2, 'stdout')).toBe('');
    expect(JSON.stringify(t)).toBe(before);
  });
});
describe('validation and boundaries', () => {
  it.each(['ok','error','timeout','trace_limit','output_limit','unsupported','worker_error'])('distinguishes %s', (status) => {
    const t = alias(); t.status = status; t.complete = status === 'ok' || status === 'error';
    expect(parseTrace(JSON.stringify(t)).status).toBe(status);
  });
  it('handles empty and one-event traces', () => {
    const t = alias(); t.events = []; t.stdout = 'syntax-time output';
    expect(parseTrace(JSON.stringify(t)).events).toEqual([]);
    expect(outputAt(t, 0, 'stdout')).toBe('syntax-time output');
    t.events = [alias().events[0]];
    expect(parseTrace(JSON.stringify(t)).events.length).toBe(1);
    expect(clampStep(-1, 1)).toBe(0); expect(clampStep(40, 1)).toBe(0); expect(clampStep(1, 0)).toBe(0);
  });
  it('falls back to last checkpoint when final output is missing', () => {
    const t = alias(); delete t.stdout; t.events.at(-1).stdout = 'checkpoint';
    expect(outputAt(parseTrace(JSON.stringify(t)), t.events.length - 1, 'stdout')).toBe('checkpoint');
  });
  it('keeps omission markers even on an ok trace', () => {
    const t = alias(); t.events[0].truncated = ['locals'];
    expect(parseTrace(JSON.stringify(t)).events[0].truncated).toEqual(['locals']);
  });
  it.each([
    ['version', (t: any) => { t.schema_version = 'codeviz.trace/2.0'; }],
    ['missing frames', (t: any) => { delete t.events[0].frames; }],
    ['missing reference', (t: any) => { t.events[0].frames[0].locals.a = {kind:'ref',id:'missing'}; }],
    ['steps', (t: any) => { t.events[0].step = 10; }],
    ['invalid scalar', (t: any) => { t.events[0].frames[0].locals.a = {kind:'scalar',type:'int',value:{}}; }],
    ['missing output checkpoint', (t: any) => { delete t.events[0].stdout; }],
    ['inconsistent completion', (t: any) => { t.complete = false; }],
  ])('rejects %s with a path', (_, mutate) => { const t = alias(); mutate(t); expect(() => parseTrace(JSON.stringify(t))).toThrow(/: /); });
  it('rejects invalid JSON', () => expect(() => parseTrace('{')).toThrow('not valid JSON'));
  it('rejects oversized input', () => expect(() => parseTrace(' '.repeat(20*1024*1024+1))).toThrow('20 MiB'));
  it('does not execute source or output markup', () => {
    const t = alias(); t.source = '<script>throw 1</script>'; t.stdout = '<img onerror="throw 1">';
    expect(parseTrace(JSON.stringify(t)).source).toBe(t.source);
  });
});
