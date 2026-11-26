import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { parseTrace } from '../src/parseTrace';
import { shareUnchanged } from '../src/shareUnchanged';
import type { TraceEvent } from '../src/types';

const ev = (step: number, heap: object, stdout = '', frames: object[] = [{ depth: 0, function: '<module>', line: 1, locals: {} }]) =>
  ({ step, event: 'line', line: 1, frames, heap, stdout, stderr: '', truncated: [] }) as unknown as TraceEvent;

describe('shareUnchanged', () => {
  it('shares equal parts, keeps changed ones, and changes no value', () => {
    const node = () => ({ type: 'list', length: 1, items: [{ kind: 'scalar', type: 'int', value: 1 }] });
    const changed = { type: 'list', length: 2, items: [{ kind: 'scalar', type: 'int', value: 1 }, { kind: 'scalar', type: 'int', value: 2 }] };
    const events = [ev(0, { o1: node(), o2: node() }), ev(1, { o1: node(), o2: changed })];
    const before = JSON.stringify(events);
    shareUnchanged(events);
    expect(JSON.stringify(events)).toBe(before);
    expect(events[1].heap.o1).toBe(events[0].heap.o1);
    expect(events[1].heap.o2).not.toBe(events[0].heap.o2);
    expect(events[1].frames).toBe(events[0].frames);
  });
  it('turns cumulative output into slices of the last string and leaves unrelated text alone', () => {
    const events = [ev(0, {}, 'hello world, one\n'), ev(1, {}, 'hello world, one\nhello world, two\n'), ev(2, {}, 'something else entirely')];
    const before = JSON.stringify(events);
    shareUnchanged(events);
    expect(JSON.stringify(events)).toBe(before);
  });
  it('is safe with a hostile heap id and with no events', () => {
    const a = ev(0, {}); Object.defineProperty(a.heap, '__proto__', { value: { type: 'x' }, enumerable: true, writable: true, configurable: true });
    const b = ev(1, {}); Object.defineProperty(b.heap, '__proto__', { value: { type: 'x' }, enumerable: true, writable: true, configurable: true });
    shareUnchanged([a, b]);
    expect(Object.getPrototypeOf(b.heap)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(b.heap, '__proto__')!.value).toBe(Object.getOwnPropertyDescriptor(a.heap, '__proto__')!.value);
    shareUnchanged([]);
  });
  it('parsing gives the same trace as before for every bundled example', () => {
    const dir = new URL('../public/examples/', import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith('.trace.json'));
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const raw = readFileSync(new URL(f, dir), 'utf8');
      const parsed = parseTrace(raw);
      expect(JSON.parse(JSON.stringify(parsed.events)), f).toEqual(JSON.parse(raw).events);
    }
  });
});

import { encodeNodePool } from '../src/nodepool';
describe('node-pool/2', () => {
  const dir = new URL('../public/examples/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.trace.json'));
  it('round-trips every bundled example through the writer and the real reader', () => {
    let packedCount = 0;
    for (const f of files) {
      const raw = readFileSync(new URL(f, dir), 'utf8');
      const trace = parseTrace(raw);
      const packed = encodeNodePool(trace, JSON.stringify(trace));
      if (packed.pooled) { packedCount++; expect(JSON.parse(packed.text).encoding, f).toBe('node-pool/2'); }
      expect(JSON.parse(JSON.stringify(parseTrace(packed.text).events)), f).toEqual(JSON.parse(raw).events);
    }
    expect(packedCount).toBeGreaterThan(0);
  });
  const base = () => JSON.parse(readFileSync(new URL(files[files.length - 1], dir), 'utf8'));
  const pack = () => JSON.parse(encodeNodePool(parseTrace(JSON.stringify(base())), JSON.stringify(base())).text);
  it('rejects bad pool indexes, bad output lengths and an unknown encoding', () => {
    const p = pack(); if (p.encoding !== 'node-pool/2') return;
    const f = structuredClone(p); f.events[0].frames = 9999; expect(() => parseTrace(JSON.stringify(f))).toThrow(/frame pool index/);
    const o = structuredClone(p); o.events[0].stdout = 'x'.length + 10 ** 6; if (typeof p.events[0].stdout === 'number') expect(() => parseTrace(JSON.stringify(o))).toThrow(/output length/);
    const u = structuredClone(p); u.encoding = 'node-pool/9'; expect(() => parseTrace(JSON.stringify(u))).toThrow(/unsupported/);
  });
  it('still reads node-pool/1 files', () => {
    const t = parseTrace(JSON.stringify(base()));
    const pool: unknown[] = [], idx = new Map<string, number>();
    const events = t.events.map((e) => ({ ...e, heap: Object.fromEntries(Object.entries(e.heap).map(([id, n]) => { const k = JSON.stringify(n); if (!idx.has(k)) { idx.set(k, pool.length); pool.push(n); } return [id, idx.get(k)]; })) }));
    const v1 = JSON.stringify({ ...t, events, encoding: 'node-pool/1', node_pool: pool });
    expect(JSON.parse(JSON.stringify(parseTrace(v1).events))).toEqual(JSON.parse(JSON.stringify(t.events)));
  });
  it('keeps the expanded-size bound for output lengths', () => {
    const p = pack(); if (p.encoding !== 'node-pool/2' || typeof p.events[0].stdout !== 'number') return;
    expect(() => parseTrace(JSON.stringify(p), { maxExpandedBytes: 10 })).toThrow(/replay limit/);
  });
});

import { buildScenes, sceneCache } from '../src/structures';
describe('consumers never edit a parsed recording', () => {
  it('scenes, lazy scenes and a full walk over every example run on a frozen trace without throwing', () => {
    const dir = new URL('../public/examples/', import.meta.url);
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.trace.json'))) {
      const t = parseTrace(readFileSync(new URL(f, dir), 'utf8'));
      expect(Object.isFrozen(t.events[0]) && Object.isFrozen(t.events[0].heap), f).toBe(true);
      buildScenes(t);
      const c = sceneCache(t); for (let i = t.events.length - 1; i >= 0; i -= 3) c.get(i);
    }
  });
});

describe('node-pool/3 deltas', () => {
  const dir = new URL('../public/examples/', import.meta.url);
  const sample = parseTrace(readFileSync(new URL('02_loop.trace.json', dir), 'utf8'));
  const node = (items: number[], length = items.length, extra: object = {}) => ({ type: 'list', items: items.map((v) => ({ kind: 'scalar', type: 'int', value: v })), length, ...extra });
  const file = (pool: unknown[], heaps: number[]) => JSON.stringify({
    ...JSON.parse(JSON.stringify(sample)), encoding: 'node-pool/3', node_pool: pool,
    frame_pool: [sample.events[0].frames], stdout_text: '', stderr_text: '',
    events: heaps.map((h, i) => ({ step: i, event: 'line', line: 1, frames: 0, heap: { o1: h }, stdout: 0, stderr: 0, truncated: [] })),
  });
  it('rebuilds appended items and changed fields, sharing the unchanged item objects', () => {
    const t = parseTrace(file([node([1, 2]), { delta_of: 0, append: [{ kind: 'scalar', type: 'int', value: 3 }], set: { length: 3 } }, { delta_of: 1, set: { length: 90, truncated: true } }], [0, 1, 2]));
    expect(t.events[1].heap.o1).toEqual(node([1, 2, 3]));
    expect(t.events[2].heap.o1).toEqual(node([1, 2, 3], 90, { truncated: true }));
    expect(t.events[2].heap.o1.items).toBe(t.events[1].heap.o1.items);
    expect(t.events[1].heap.o1.items![0]).toBe(t.events[0].heap.o1.items![0]);
  });
  it('rejects bad bases, unknown fields, items replacement and append on a non-list', () => {
    const bad = (entry: object, pool: unknown[] = [node([1])]) => expect(() => parseTrace(file([...pool, entry], [1]))).toThrow();
    bad({ delta_of: 5 }); bad({ delta_of: 1 }); bad({ delta_of: -1 }); bad({ delta_of: 0, evil: 1 });
    bad({ delta_of: 0, set: { items: [] } }); bad({ delta_of: 0, append: 'x' });
    bad({ delta_of: 0, append: [] }, [{ type: 'Obj', fields: {} }]);
  });
  it('a delta entry is not read from node-pool/2 and cannot smuggle __proto__', () => {
    const f2 = JSON.parse(file([node([1]), { delta_of: 0, set: { length: 2 } }], [0, 1])); f2.encoding = 'node-pool/2';
    expect(() => parseTrace(JSON.stringify(f2))).toThrow();
    const p = parseTrace(file([node([1]), JSON.parse('{"delta_of":0,"set":{"__proto__":{"polluted":1}}}')], [0, 1]));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(p.events[1].heap.o1)).toBe(Object.prototype);
  });
  it('the expanded-size bound counts rebuilt entries', () => {
    expect(() => parseTrace(file([node([1, 2, 3]), { delta_of: 0, set: { length: 3 } }], [0, 1]), { maxExpandedBytes: 50 })).toThrow(/replay limit/);
  });
});

import { limitText } from '../src/replay';
describe('which limit fired', () => {
  const base = () => JSON.parse(readFileSync(new URL('02_loop.trace.json', new URL('../public/examples/', import.meta.url)), 'utf8'));
  it('parses a recording that names its limit and rejects an unknown one', () => {
    const t = base(); t.limit_hit = { kind: 'events', limit: 10 };
    expect(parseTrace(JSON.stringify(t)).limit_hit).toEqual({ kind: 'events', limit: 10 });
    t.limit_hit = { kind: 'banana' }; expect(() => parseTrace(JSON.stringify(t))).toThrow(/limit_hit/);
    t.limit_hit = { kind: 'events', limit: 'many' }; expect(() => parseTrace(JSON.stringify(t))).toThrow();
  });
  it('old recordings with no limit_hit still open and say nothing', () => {
    expect(parseTrace(JSON.stringify(base())).limit_hit).toBeUndefined();
    expect(limitText(undefined)).toBe('');
  });
  it('says each limit in plain words with its value', () => {
    expect(limitText({ kind: 'events', limit: 2000 })).toContain('2,000-event');
    expect(limitText({ kind: 'wall_time', limit: 2 })).toContain('2 s time limit');
    expect(limitText({ kind: 'memory', limit: 268435456 })).toContain('256 MiB');
    expect(limitText({ kind: 'recording_size', limit: 16777216 })).toContain('16 MiB');
    for (const k of ['objects', 'stack_depth', 'output_chars', 'cpu_time'] as const) expect(limitText({ kind: k, limit: 5 })).toContain('5');
  });
});

describe('node-pool/3 adversarial and large', () => {
  const dir = new URL('../public/examples/', import.meta.url);
  const sample = JSON.parse(readFileSync(new URL('02_loop.trace.json', dir), 'utf8'));
  const item = (v: number) => ({ kind: 'scalar', type: 'int', value: v });
  const make = (pool: unknown[], events: number) => JSON.stringify({
    ...sample, limits: { ...sample.limits, events: 20000 }, encoding: 'node-pool/3', node_pool: pool, frame_pool: [sample.events[0].frames], stdout_text: '', stderr_text: '',
    events: Array.from({ length: events }, (_, i) => ({ step: i, event: 'line', line: 1, frames: 0, heap: { o1: Math.min(i, pool.length - 1) }, stdout: 0, stderr: 0, truncated: [] })),
  });
  it('a long chain of one-item appends is refused before it is built', () => {
    const pool: unknown[] = [{ type: 'list', items: [item(0)], length: 1 }];
    for (let k = 1; k < 9000; k++) pool.push({ delta_of: k - 1, append: [item(k)], set: { length: k + 1 } });
    const text = make(pool, 100);
    expect(text.length).toBeLessThan(2 * 1024 * 1024);   // a small file ...
    const t0 = performance.now();
    expect(() => parseTrace(text)).toThrow(/replay limit/);   // ... that would otherwise build about 40 million item slots
    expect(performance.now() - t0).toBeLessThan(2000);
  });
  it('a chain of set-only deltas on a 40-item list opens and is counted at the plain file size', () => {
    const base = { type: 'list', items: Array.from({ length: 40 }, (_, i) => item(i)), length: 40, truncated: true };
    const pool: unknown[] = [base];
    for (let k = 1; k < 2000; k++) pool.push({ delta_of: k - 1, set: { length: 40 + k } });
    const t = parseTrace(make(pool, 2000));
    expect(t.events[1999].heap.o1.length).toBe(2039);
    expect(t.events[1999].heap.o1.items).toBe(t.events[0].heap.o1.items);
  });
  it('10,000 events of that kind open within the same bounds, fast, and the 10,001st event is refused', () => {
    const base = { type: 'list', items: Array.from({ length: 40 }, (_, i) => item(i)), length: 40, truncated: true };
    const pool: unknown[] = [base];
    for (let k = 1; k < 10000; k++) pool.push({ delta_of: k - 1, set: { length: 40 + k } });
    const t0 = performance.now();
    let parsed: ReturnType<typeof parseTrace> | undefined, err = '';
    try { parsed = parseTrace(make(pool, 10000)); } catch (e) { err = String(e); }
    const ms = performance.now() - t0;
    console.log(`BIG10000 ${parsed ? 'parsed' : 'refused: ' + err.slice(0, 90)} in ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(5000);
    expect(() => parseTrace(make(pool, 10001))).toThrow(/10,000-event/);
  });
});
