import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseTrace } from '../src/parseTrace';
import { indexMarks } from '../src/indexmarks';
import type { TraceEvent, Value } from '../src/types';

const int = (value: number): Value => ({ kind: 'scalar', type: 'int', value });
const ev = (locals: Record<string, Value>, len = 5): TraceEvent => ({ step: 1, event: 'line', line: 1, stdout: '', stderr: '', truncated: [],
  frames: [{ depth: 0, function: '<module>', line: 1, locals: { a: { kind: 'ref', id: 'o1' }, ...locals } }],
  heap: { o1: { type: 'list', items: Array.from({ length: len }, (_, i) => int(i)), length: len } } });
const arrays = new Map([['o1', 5]]);

describe('index markers (visualization plan C1)', () => {
  it('marks only integers the source uses inside the brackets of that array', () => {
    const m = indexMarks(ev({ i: int(1), j: int(3), n: int(5) }), 'for i in range(n):\n    a[j] = a[j + 1]\n', arrays);
    expect(m.get('o1')).toEqual([{ cell: 3, names: ['j'], pastEnd: false }]);
  });
  it('slices and two names on one cell', () => {
    const m = indexMarks(ev({ lo: int(2), hi: int(2) }), 'x = a[lo:hi]\n', arrays);
    expect(m.get('o1')).toEqual([{ cell: 2, names: ['lo', 'hi'], pastEnd: false }]);
  });
  it('one past the end is kept and flagged; beyond it and negatives are dropped', () => {
    expect(indexMarks(ev({ i: int(5) }), 'a[i]', arrays).get('o1')).toEqual([{ cell: 5, names: ['i'], pastEnd: true }]);
    expect(indexMarks(ev({ i: int(6) }), 'a[i]', arrays).get('o1')).toBeUndefined();
    expect(indexMarks(ev({ i: int(-1) }), 'a[i]', arrays).get('o1')).toBeUndefined();
  });
  it('C++ .at(), and no false match on a longer name or a bool', () => {
    expect(indexMarks(ev({ k: int(0) }), 'v = a.at(k);', arrays).get('o1')?.[0].names).toEqual(['k']);
    expect(indexMarks(ev({ i: int(0) }), 'a[idx]', arrays).get('o1')).toBeUndefined();
    expect(indexMarks(ev({ i: { kind: 'scalar', type: 'bool', value: 1 } }), 'a[i]', arrays).get('o1')).toBeUndefined();
  });
  it('bubble sort recording: j follows the comparison, i (never an index) is not drawn', () => {
    const t = parseTrace(readFileSync(new URL('./fixtures/bubble_sort.trace.json', import.meta.url), 'utf8'));
    const seen = new Set<string>();
    for (const e of t.events) {
      const ref = e.frames[0].locals.data;
      if (ref?.kind !== 'ref') continue;
      for (const mk of indexMarks(e, t.source, new Map([[ref.id, 5]])).get(ref.id) ?? []) mk.names.forEach((n) => seen.add(n));
    }
    expect([...seen]).toEqual(['j']);
  });
});
