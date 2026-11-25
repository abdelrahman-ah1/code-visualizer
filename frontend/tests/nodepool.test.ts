// Tests for the node-pool/1 recording format (reader in parseTrace.ts, writer in nodepool.ts).
// Self-contained: inputs are the shipped examples in public/examples plus one small committed fixture written by the
// Python helper (fixtures/nodepool/make_pooled.py). Larger recordings are built here by repeating the last event.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { parseTrace, MAX_BYTES } from '../src/parseTrace';
import { encodeNodePool } from '../src/nodepool';
import { buildScenes } from '../src/structures';
import { buildLineIndex } from '../src/breakpoints';
const exDir = new URL('../public/examples/', import.meta.url);
const exNames = readdirSync(exDir).filter((f) => f.endsWith('.trace.json')).sort();
const rawEx = (f: string) => readFileSync(new URL(f, exDir), 'utf8');
const OPEN = { maxExpandedBytes: 1e12 };
const grow = (t: any, n: number) => { const last = t.events.at(-1); const events = t.events.slice(); while (events.length < n) events.push({ ...last, step: events.length }); return { ...t, events, limits: { ...t.limits, events: 10000 } }; };
const pooledJson = (t: any) => JSON.parse(encodeNodePool(t, JSON.stringify(t)).text);
const deepFreeze = (x: any): any => { if (x && typeof x === 'object' && !Object.isFrozen(x)) { Object.freeze(x); Object.values(x).forEach(deepFreeze); } return x; };
const tree = () => JSON.parse(rawEx('cpp_04_binary_tree_insert.trace.json'));
const base = () => pooledJson(grow(tree(), 200));

describe('node-pool/1 round trips', () => {
  it('there are shipped examples to test', () => expect(exNames.length).toBeGreaterThanOrEqual(20));
  for (const f of exNames) it(`${f}: writer output reads back as exactly the original`, () => {
    const raw = rawEx(f); const orig = JSON.parse(raw);
    const packed = encodeNodePool(parseTrace(raw), raw);
    expect(parseTrace(packed.text)).toEqual(orig);
    if (packed.pooled) expect(packed.text.length).toBeLessThan(raw.length); else expect(packed.text).toBe(raw);
  });
  it('a file written by the Python helper reads back as the shipped example (cross-implementation check)', () => {
    const py = readFileSync(new URL('./fixtures/nodepool/cpp_10_writes_a_file.python-pooled.json', import.meta.url), 'utf8');
    expect(parseTrace(py)).toEqual(JSON.parse(rawEx('cpp_10_writes_a_file.trace.json')));
  });
  it('writer falls back to the ordinary text when pooling is not smaller (compact recording with no heap nodes)', () => {
    const t = JSON.parse(rawEx('01_scalars.trace.json')); const raw = JSON.stringify(t);
    const p = encodeNodePool(parseTrace(raw), raw);
    expect(p.pooled).toBe(false); expect(p.text).toBe(raw);
  });
  it('unchanged nodes are shared, not copied, between events', () => {
    const got = parseTrace(JSON.stringify(base())); const a = got.events[100].heap, b = got.events[101].heap;
    expect(Object.keys(a).length).toBeGreaterThan(0); expect(Object.keys(a).every((k) => b[k] === a[k])).toBe(true);
  });
});
describe('node-pool/1 resource bounds', () => {
  const big = (n: number) => grow(JSON.parse(rawEx('cpp_10_writes_a_file.trace.json')), n);   // about 28 KB expanded per event
  it('stops an expansion bomb (small file, one big node linked from many events) fast, at the default limit', () => {
    const t = base(); const node = { type: 'array', element_type: 'int', length: 20000, items: Array.from({ length: 20000 }, (_, i) => ({ kind: 'scalar', type: 'int', value: i })) };
    t.node_pool = [node];
    const ev = t.events[0]; t.events = Array.from({ length: 3000 }, (_, step) => ({ ...ev, step, heap: Object.fromEntries(Array.from({ length: 20 }, (_, k) => [`o${k}`, 0])) }));
    t.limits.events = 10000; const raw = JSON.stringify(t);
    const t0 = performance.now(); expect(() => parseTrace(raw)).toThrow(/expands to more than/); const ms = performance.now() - t0;
    expect(raw.length).toBeLessThan(MAX_BYTES); expect(ms).toBeLessThan(2000);
  });
  it('an explicit smaller override is honoured', () => { expect(() => parseTrace(JSON.stringify(pooledJson(big(100))), { maxExpandedBytes: 1e6 })).toThrow(/expands to more than/); });
  it('default limit is the ordinary 20 MiB of expanded text: about 14 MB opens, about 39 MB is refused unless raised', () => {
    const small = big(500), large = big(1500);
    expect(JSON.stringify(small).length).toBeLessThan(MAX_BYTES); expect(JSON.stringify(large).length).toBeGreaterThan(MAX_BYTES);
    expect(parseTrace(JSON.stringify(pooledJson(small))).events).toHaveLength(500);
    const packed = encodeNodePool(large, JSON.stringify(large)); expect(packed.pooled).toBe(true);   // the writer can pack it
    expect(() => parseTrace(packed.text)).toThrow(/expands to more than the 20 MiB/);               // but the reader keeps today's limit
    expect(parseTrace(packed.text, OPEN).events).toHaveLength(1500);
  }, 60000);
  it('rejects more than 10,000 events before expanding', () => {
    const t = base(); const ev = t.events[0]; t.events = Array.from({ length: 10001 }, (_, step) => ({ ...ev, step, heap: {} })); t.limits.events = 20000;
    expect(() => parseTrace(JSON.stringify(t))).toThrow(/10,000-event/);
  });
});
describe('node-pool/1 malformed input', () => {
  const mutate = (f: (t: any) => void, re: RegExp) => { const t = base(); f(t); expect(() => parseTrace(JSON.stringify(t))).toThrow(re); };
  const k = (t: any) => Object.keys(t.events[10].heap)[0];
  it('bad indexes', () => { for (const bad of [-1, 1.5, 'x', null, true, [], {}, 1e308, 4294967296]) mutate((t) => { t.events[10].heap[k(t)] = bad; }, /pool index/); });
  it('bad containers and bad pooled nodes', () => {
    mutate((t) => { t.node_pool = {}; }, /expected an array/);
    mutate((t) => { delete t.node_pool; }, /expected an array/);
    mutate((t) => { t.events[10].heap = []; }, /expected an object/);
    mutate((t) => { delete t.events[10].heap; }, /expected an object/);
    mutate((t) => { t.node_pool[t.events[10].heap[k(t)]] = 5; }, /expected an object/);
    mutate((t) => { t.node_pool[t.events[10].heap[k(t)]] = { type: 3 }; }, /expected text/);
    mutate((t) => { t.encoding = 'node-pool/9'; }, /encoding/);
  });
  it('a pointer to a node absent from that event is rejected like in an ordinary file', () => {
    const t = base(); const ev = t.events[16]; const id = Object.keys(ev.heap).find((i) => JSON.stringify(t.node_pool[ev.heap[i]]).includes('"ref"'))!;
    const refId = JSON.stringify(t.node_pool[ev.heap[id]]).match(/"id":"(o\d+)"/)![1]; delete ev.heap[refId];
    expect(() => parseTrace(JSON.stringify(t))).toThrow(/missing heap reference/);
  });
  it('node ids "__proto__" and "constructor" become ordinary own entries; the prototype is untouched', () => {
    const t = base(); t.node_pool.push({ type: 'Plain', fields: { v: { kind: 'scalar', type: 'int', value: 1 } } });
    const last = t.node_pool.length - 1; t.events[0].heap = {};
    const raw = JSON.stringify(t).replace('"heap":{}', `"heap":{"__proto__":${last},"constructor":${last}}`);
    const h = parseTrace(raw).events[0].heap;
    expect(Object.getPrototypeOf(h)).toBe(Object.prototype); expect(Object.keys(h)).toEqual(['__proto__', 'constructor']); expect(h['__proto__'].type).toBe('Plain');
    expect(({} as any).type).toBeUndefined();
  });
});
describe('node-pool/1 shared records stay unmodified by the viewer logic', () => {
  for (const f of exNames) it(`${f}: a frozen pooled trace goes through scene building and line indexing; scenes equal the original's`, () => {
    const raw = rawEx(f); const orig = parseTrace(raw);
    const pooled = deepFreeze(parseTrace(encodeNodePool(orig, raw).text));   // any write to a shared node would throw (ES modules are strict)
    const before = JSON.stringify(pooled);
    expect(JSON.stringify(buildScenes(pooled))).toBe(JSON.stringify(buildScenes(orig)));
    buildLineIndex(pooled.events);
    expect(JSON.stringify(pooled)).toBe(before);
  });
  it('documents the alias risk: mutating a shared node after parse changes every event that shares it', () => {
    const got = parseTrace(JSON.stringify(base())); const a = got.events[100].heap, b = got.events[101].heap;
    const shared = Object.keys(a).find((id) => a[id] === b[id])!; (a[shared] as any).type = 'CHANGED';
    expect(b[shared].type).toBe('CHANGED');
  });
});
