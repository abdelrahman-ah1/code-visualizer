import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseTrace } from '../src/parseTrace';
import { describeStep, show } from '../src/changes';
import type { Trace } from '../src/types';

const load = (name: string) => parseTrace(readFileSync(new URL(`../public/examples/${name}.trace.json`, import.meta.url), 'utf8'));
const at = (t: Trace, i: number, nullWord = 'None') => describeStep(t.events[i - 1], t.events[i], nullWord, t.source.split('\n'));
const texts = (t: Trace, i: number, nullWord = 'None') => at(t, i, nullWord).changes.map((c) => c.text);

describe('describeStep: what the previous line did', () => {
  it('the first snapshot has nothing to compare with', () => {
    const t = load('01_scalars');
    expect(describeStep(undefined, t.events[0]).headline).toMatch(/Nothing has run yet/);
  });
  it('reports a new variable and a reassignment with old and new values', () => {
    const t = load('01_scalars');
    expect(texts(t, 2)).toEqual(['x = 1']);
    expect(at(t, 3).ranLine).toBe(2);
    expect(texts(t, 3)).toEqual(['x: 1 → 3']);
  });
  it('aliasing: the second name refers to the same object, no new object is created', () => {
    const t = load('05_alias');
    expect(texts(t, 2)).toEqual(['a now refers to list o1', 'Created list o1 with 1 item']);
    expect(texts(t, 3)).toEqual(['b now refers to list o1']);
    expect(texts(t, 4)).toEqual(['list o1 grew from 1 to 2 items (added 2)']);
  });
  it('recursion: calls name their arguments, returns name their value', () => {
    const t = load('03_recursion');
    const call = t.events.findIndex((e) => e.event === 'call' && e.frames.at(-1)!.locals.n?.kind === 'scalar' && (e.frames.at(-1)!.locals.n as { value: number }).value === 2);
    expect(at(t, call).headline).toBe('Line 4 called factorial.');
    expect(texts(t, call)).toContain('Called factorial(n=2)');
    const back = t.events.findIndex((e, i) => i > 0 && t.events[i - 1].event === 'return');
    expect(texts(t, back)).toContain('factorial finished and returned 1');
    expect(texts(t, back)).toContain('partial = 1');
  });
  it('a return and a new call of the same function read as two calls, not one', () => {
    const t = load('12_linked_list_insert');
    const i = t.events.findIndex((e, k) => k > 0 && e.event === 'call' && t.events[k - 1].event === 'return' && e.frames.at(-1)!.function === '__init__');
    expect(at(t, i).headline).toBe('__init__ finished, then __init__ was called.');
    expect(texts(t, i)[0]).toBe('__init__ finished');
    expect(texts(t, i)[1]).toMatch(/^Called __init__\(self=o\d+/);
  });
  it('object fields: set for the first time, then re-pointed', () => {
    const t = load('12_linked_list_insert');
    const all = t.events.map((_, i) => (i ? texts(t, i) : [])).flat();
    expect(all).toContain('o1.value = 4');
    expect(all).toContain('o2.next now points to Node o4 (was o1)');
    expect(all).toContain('o3.value: 1 → 10');
  });
  it('a class body is named as a class, not as a call', () => {
    const t = load('07_cycle');
    const all = t.events.map((_, i) => (i ? texts(t, i) : [])).flat();
    expect(all).toContain('Running the body of class Node');
    expect(all).toContain('Defined class Node');
    expect(all.some((s) => /Called Node/.test(s))).toBe(false);
  });
  it('exceptions and printed output', () => {
    const e = load('09_exception');
    const i = e.events.findIndex((x) => x.event === 'exception');
    expect(at(e, i).headline).toBe('Line 3 raised ZeroDivisionError.');
    const o = load('08_stdout_input');
    expect(texts(o, o.events.length - 1)).toContain('Printed: Hello Ada');
  });
  it('C++: null pointers and objects that drop out of the recording', () => {
    const t = load('cpp_07_memory_leak');
    const i = t.events.findIndex((e, k) => k > 0 && Object.keys(t.events[k - 1].heap).length > Object.keys(e.heap).length);
    expect(texts(t, i, 'null')).toContain('n: o1 → null');
    expect(texts(t, i, 'null').some((s) => s.startsWith('No longer reachable: Node o1'))).toBe(true);
  });
  it('freed and leaked flags are reported once, when they appear', () => {
    const base = { step: 1, event: 'line' as const, line: 1, frames: [{ depth: 0, function: 'main', line: 1, locals: {} }], stdout: '', stderr: '', truncated: [] };
    const a = { ...base, heap: { o1: { type: 'Node', fields: {} }, o2: { type: 'Node', fields: {} } } };
    const b = { ...base, step: 2, line: 2, heap: { o1: { type: 'Node', fields: {}, freed: true }, o2: { type: 'Node', fields: {}, orphan: true } } };
    const kinds = describeStep(a, b, 'null').changes.map((c) => c.kind);
    expect(kinds).toEqual(['freed', 'leak']);
    expect(describeStep(b, { ...b, step: 3 }, 'null').changes).toEqual([]);
  });
  it('list cells, dict entries and shrinking', () => {
    const base = { step: 1, event: 'line' as const, line: 1, frames: [{ depth: 0, function: '<module>', line: 1, locals: {} }], stdout: '', stderr: '', truncated: [] };
    const int = (value: number) => ({ kind: 'scalar' as const, type: 'int', value });
    const str = (value: string) => ({ kind: 'scalar' as const, type: 'str', value });
    const a = { ...base, heap: { o1: { type: 'list', items: [int(3), int(1)], length: 2 }, o2: { type: 'dict', entries: [[str('a'), int(1)], [str('b'), int(2)]] as [ReturnType<typeof str>, ReturnType<typeof int>][] } } };
    const b = { ...base, step: 2, line: 2, heap: { o1: { type: 'list', items: [int(1), int(3)], length: 2 }, o2: { type: 'dict', entries: [[str('a'), int(5)], [str('c'), int(9)]] as [ReturnType<typeof str>, ReturnType<typeof int>][] } } };
    expect(describeStep(a, b).changes.map((c) => c.text)).toEqual(['list o1 [0]: 3 → 1, [1]: 1 → 3', 'dict o2 "a": 1 → 5, added "c": 9, removed "b"']);
    const c = { ...base, step: 3, line: 3, heap: { o1: { type: 'list', items: [int(1)], length: 1 }, o2: b.heap.o2 } };
    expect(describeStep(b, c).changes.map((x) => x.text)).toEqual(['list o1 shrank from 2 to 1 item']);
  });
  it('show(): quotes strings, uses the language null word and Python booleans', () => {
    expect(show({ kind: 'scalar', type: 'str', value: '5' })).toBe('"5"');
    expect(show({ kind: 'scalar', type: 'NoneType', value: null })).toBe('None');
    expect(show({ kind: 'scalar', type: 'int*', value: null }, 'null')).toBe('null');
    expect(show({ kind: 'scalar', type: 'bool', value: true })).toBe('True');
    expect(show({ kind: 'scalar', type: 'bool', value: true }, 'null')).toBe('true');
  });
});
