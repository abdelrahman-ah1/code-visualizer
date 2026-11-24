import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseTrace } from '../src/parseTrace';
import { changeIndexes, describe as show, parseWatch, resolveWatch, watchSignatures } from '../src/watch';
import type { Trace } from '../src/types';
const load = (n: string) => parseTrace(readFileSync(new URL(`../public/examples/${n}.trace.json`, import.meta.url), 'utf8'));
const path = (text: string) => { const p = parseWatch(text); if (!p.ok) throw new Error(p.error); return p.path; };
const text = (t: Trace, step: number, expr: string) => { const r = resolveWatch(t.events[step], path(expr)); return r.ok ? show(t.events[step], r.value) : `missing: ${r.reason}`; };

describe('parseWatch', () => {
  it('accepts names, fields, indexes and string keys', () => {
    expect(path('head.next.value').steps).toEqual([{ kind: 'field', name: 'next' }, { kind: 'field', name: 'value' }]);
    expect(path(' items[2] ').steps).toEqual([{ kind: 'index', index: 2 }]);
    expect(path('d["a b"]').steps).toEqual([{ kind: 'key', key: 'a b' }]);
    expect(path("x[-1].y['k']").steps).toHaveLength(3);
  });
  it('rejects anything that is not a plain path, so nothing can be evaluated', () => {
    for (const bad of ['', '   ', '1abc', 'a+b', 'f(x)', 'a.b()', '__import__("os")', 'a[b]', 'a.', 'a..b', 'x; y', 'lambda: 1']) {
      expect(parseWatch(bad).ok, bad).toBe(false);
    }
    expect(parseWatch('a'.repeat(81)).ok).toBe(false);
  });
});

describe('resolveWatch on recorded loop and recursion traces', () => {
  const loop = load('02_loop'), rec = load('03_recursion');
  it('reads the value that exists before the highlighted line runs', () => {
    expect(text(loop, 3, 'total')).toBe('0'); expect(text(loop, 6, 'total')).toBe('1'); expect(text(loop, 9, 'total')).toBe('3');
  });
  it('a name that does not exist yet is not in scope', () => { expect(text(loop, 1, 'total')).toContain('not in scope'); });
  it('uses the current frame first, then the module globals', () => {
    expect(text(rec, 6, 'n')).toBe('2');          // innermost factorial(2)
    expect(text(rec, 10, 'n')).toBe('1');
    expect(text(rec, 17, 'n')).toContain('not in scope'); // back at module level: no n
    expect(text(rec, 17, 'answer')).toBe('6');
    expect(text(rec, 6, 'factorial')).toBe('<function>'); // global seen from inside the call
  });
});

describe('watch on lists, objects and cycles', () => {
  const list = load('04_list_mutation'), ll = load('12_linked_list_insert');
  it('describes lists and indexes into them, including negative indexes', () => {
    expect(text(list, 3, 'items')).toBe('[10, 20, 30]');
    expect(text(list, 4, 'items')).toBe('[99, 20, 30]');
    expect(text(list, 4, 'items[0]')).toBe('99'); expect(text(list, 4, 'items[-1]')).toBe('30');
    expect(text(list, 4, 'items[5]')).toContain('index out of range');
    expect(text(list, 4, 'items.x')).toContain('no field x');
    expect(text(list, 4, 'items[0].y')).toContain('no members');
  });
  it('walks object fields and survives the cycle at the end of the linked-list recording', () => {
    const last = ll.events.length - 1;
    expect(text(ll, last, 'head.value')).toBe('10');
    expect(text(ll, last, 'head.next.value')).toBe('2');
    expect(text(ll, last, 'head.next.next.value')).toBe('3');
    const whole = text(ll, last, 'head');
    expect(whole).toContain('Node(');
    expect(whole).toMatch(/<o\d+>/);             // the cycle prints as a back reference, not forever
    expect(whole.length).toBeLessThanOrEqual(160);
  });
});

describe('change detection', () => {
  it('finds each step where a loop variable changes', () => {
    const loop = load('02_loop');
    expect(changeIndexes(watchSignatures(loop, path('total')))).toEqual([2, 6, 8]);   // appears, then 0->1, 1->3
    expect(changeIndexes(watchSignatures(loop, path('i')))).toEqual([3, 5, 7]);
  });
  it('sees an in-place mutation of the same object (same id, different contents)', () => {
    const list = load('04_list_mutation');
    expect(changeIndexes(watchSignatures(list, path('items')))).toEqual([2, 3, 4]);
    expect(changeIndexes(watchSignatures(list, path('items[0]')))).toEqual([2, 4]);
  });
  it('a name rebound to an equal-looking but different object counts as a change', () => {
    const t = structuredClone(load('05_alias')); const e = t.events[t.events.length - 1];
    // Same contents, new ID: a copy, not the same list.
    const before = watchSignatures(t, path('a'));
    const copy = structuredClone(e); const id = (copy.frames[0].locals.a as { id: string }).id;
    copy.heap['o99'] = structuredClone(copy.heap[id]); copy.frames[0].locals.a = { kind: 'ref', id: 'o99' };
    t.events = [e, copy];
    const sigs = watchSignatures(t, path('a'));
    expect(sigs[0]).not.toBe(sigs[1]); expect(changeIndexes(sigs)).toEqual([1]); expect(before.length).toBeGreaterThan(0);
  });
  it('a value that goes out of scope counts as a change', () => {
    const rec = load('03_recursion');
    const idx = changeIndexes(watchSignatures(rec, path('n')));
    expect(idx[0]).toBe(3);          // factorial(3) is entered
    expect(idx.at(-1)).toBe(17);     // and n disappears back at module level
  });
});
