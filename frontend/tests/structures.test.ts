import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseTrace } from '../src/parseTrace';
import { sceneCache, buildScenes, changedBetween, laneSummary, linkPath, GEOM } from '../src/structures';
const load = (name: string) => parseTrace(readFileSync(new URL(`../public/examples/${name}.trace.json`, import.meta.url), 'utf8'));
const lanes = (name: string) => { const t = load(name), s = buildScenes(t); return t.events.map((e, i) => s[i].lanes.map((l) => laneSummary(l, e, s[i]))); };
const last = <T,>(a: T[]) => a[a.length - 1];

describe('linked lists', () => {
  it('builds 3 -> 2 -> 1 by pushing at the head, ending in None', () => {
    expect(last(last(lanes('11_linked_list_build')))).toMatch(/Node list o\d+: 1 \(head, cur\) → 2 → 3 → None|Node list o\d+: 1 \(head\) → 2 → 3 → None/);
  });
  it('shows an empty list as no structure, then a single node ending in None', () => {
    const t = load('13_empty_and_single'), s = buildScenes(t);
    const first = s[0];
    expect(first.lanes).toHaveLength(0);
    const end = last(lanes('13_empty_and_single'))[0];
    expect(end).toMatch(/^Node list o\d+: 5 \(head, other\) → None$/);
    expect(last(s).lanes).toHaveLength(1);
    expect(last(s).lanes[0].ids).toHaveLength(1);
  });
  it('lists variables that are None when nothing is drawn', () => {
    const t = load('13_empty_and_single'), s = buildScenes(t);
    const i = t.events.findIndex((e) => e.frames[0].locals.head?.kind === 'scalar');
    expect(s[i].nulls).toContain('head');
  });
  it('draws a self cycle as one node with a link back to itself', () => {
    const t = load('07_cycle'), s = last(buildScenes(t));
    expect(s.lanes).toHaveLength(1);
    expect(s.lanes[0].end).toBe('cycle');
    const link = s.links[0];
    expect(link.from).toBe(link.to);
    expect(linkPath(link, s.boxes)).toContain('C');
  });
  it('inserts in the middle: the new node appears between its neighbours and later nodes shift right', () => {
    const t = load('12_linked_list_insert'), s = buildScenes(t), sum = lanes('12_linked_list_insert');
    const k = sum.findIndex((l) => l.some((x) => /1.*→ 2.*→ 3.*→ 4/.test(x)));
    expect(k).toBeGreaterThan(0);
    const before = s[k - 1], after = s[k];
    const id4 = Object.keys(after.boxes).find((id) => t.events[k].heap[id].fields?.value && (t.events[k].heap[id].fields!.value as any).value === 4)!;
    if (before.boxes[id4]) expect(after.boxes[id4].x).toBeGreaterThan(before.boxes[id4].x);
    expect(after.boxes[id4].x).toBe(GEOM.pad + 3 * (GEOM.nodeW + GEOM.gap));
  });
  it('ends with the tail pointing back to the head (cycle)', () => {
    const t = load('12_linked_list_insert'), s = last(buildScenes(t));
    expect(s.lanes[0].end).toBe('cycle');
    expect(s.lanes[0].ids).toHaveLength(4);
  });
  it('keeps aliases: two variables tag the same node', () => {
    const t = load('15_alias_list_nodes'), s = last(buildScenes(t));
    const tagged = Object.values(s.tags).find((names) => names.includes('b'));
    expect(tagged).toBeDefined();
  });
  it('does not mutate trace snapshots', () => {
    const t = load('12_linked_list_insert'), before = JSON.stringify(t);
    buildScenes(t);
    expect(JSON.stringify(t)).toBe(before);
  });
});

describe('arrays', () => {
  it('renders list items in order and grows on append, insert', () => {
    const sums = lanes('14_array_mutation');
    const text = sums.flat().join('\n');
    expect(text).toContain('[4, 1, 3]');
    expect(text).toContain('[4, 1, 3, 9]');
    expect(text).toContain('[7, 1, 3, 9]');
    expect(text).toContain('[7, 2, 1, 3, 9]');
  });
  it('draws nested lists as their own rows with arrows from the outer cells', () => {
    const t = load('14_array_mutation'), s = last(buildScenes(t));
    const outer = s.links.filter((l) => l.cell !== undefined);
    expect(outer.length).toBe(2);
    expect(new Set(outer.map((l) => l.from)).size).toBe(1);
    expect(s.lanes.length).toBeGreaterThanOrEqual(4);
  });
  it('marks omitted elements instead of hiding them', () => {
    const t = load('14_array_mutation');
    const e = JSON.parse(JSON.stringify(t.events[t.events.length - 1]));
    const id = Object.keys(e.heap).find((k) => e.heap[k].type === 'list')!;
    e.heap[id].length = 100; e.heap[id].truncated = true;
    const t2 = { ...t, events: [e] };
    const s = buildScenes(t2)[0];
    expect(laneSummary(s.lanes.find((l) => l.ids[0] === id)!, e, s)).toContain('more omitted');
    expect(s.boxes[id].w).toBe(((e.heap[id].items?.length ?? 0) + 1) * GEOM.cell);
  });
});

describe('stability', () => {
  for (const name of ['11_linked_list_build', '12_linked_list_insert', '13_empty_and_single', '14_array_mutation', '15_alias_list_nodes']) {
    it(`${name}: structures keep their rows while the structure count is unchanged`, () => {
      const t = load(name), s = buildScenes(t);
      for (let i = 1; i < s.length; i++) {
        // A row may close up when a structure disappears, and a list that splits in two gives one half a new row.
        if (s[i].lanes.length !== s[i - 1].lanes.length) continue;
        for (const id of Object.keys(s[i].boxes)) {
          const was = s[i - 1].boxes[id];
          if (was && was.kind !== 'card' && s[i].boxes[id].kind !== 'card') expect({ name, step: i, id, y: s[i].boxes[id].y }).toEqual({ name, step: i, id, y: was.y });
        }
      }
    });
  }
  it('nodes that are not touched do not move when a node is added after them', () => {
    const t = load('12_linked_list_insert'), s = buildScenes(t), sum = lanes('12_linked_list_insert');
    const k = sum.findIndex((l) => l.some((x) => /1.*→ 2.*→ 3.*→ 4/.test(x)));
    const head = s[k].lanes[0].ids[0];
    expect(s[k].boxes[head].x).toBe(s[k - 1].boxes[head].x);
  });
  it('builds scenes quickly for a large trace', () => {
    const base = load('11_linked_list_build'), ev = base.events[base.events.length - 1];
    const events = Array.from({ length: 10000 }, (_, i) => ({ ...ev, step: i }));
    const start = performance.now(); const s = buildScenes({ ...base, events }); const ms = performance.now() - start;
    console.log(`structures perf: ${events.length} snapshots in ${ms.toFixed(0)} ms`);
    expect(s).toHaveLength(10000); expect(ms).toBeLessThan(5000);
  });
});

describe('splits', () => {
  it('a list that splits in two keeps the half that still starts at the old head in the old row', () => {
    const t = load('15_alias_list_nodes'), s = buildScenes(t), a = last(s), b = s[s.length - 2];
    expect(b.lanes).toHaveLength(1);
    expect(a.lanes).toHaveLength(2);
    expect(a.lanes.some((l) => l.end === 'join')).toBe(true);
    const head = b.lanes[0].ids[0];
    expect(a.boxes[head].y).toBe(b.boxes[head].y);
    expect(a.lanes.find((l) => l.ids[0] === head)!.row).toBe(0);
  });
});

describe('change detection', () => {
  it('flags new and changed objects only', () => {
    const t = load('12_linked_list_insert');
    let sawAdded = false, sawChanged = false;
    for (let i = 1; i < t.events.length; i++) { const d = changedBetween(t.events[i - 1], t.events[i]); sawAdded ||= d.added.size > 0; sawChanged ||= d.changed.size > 0; }
    expect(sawAdded && sawChanged).toBe(true);
    expect(changedBetween(undefined, t.events[0]).changed.size).toBe(0);
    expect(changedBetween(t.events[3], t.events[3])).toEqual({ changed: new Set(), added: new Set() });
  });
});

describe('sceneCache', () => {
  it('gives exactly the scenes buildScenes gives, whatever order they are asked for (far seek first, then back, then the slices)', () => {
    for (const name of ['12_linked_list_insert', '07_cycle', '13_empty_and_single']) {
      const t = load(name), all = buildScenes(t), c = sceneCache(t), n = t.events.length;
      expect(JSON.stringify(c.get(n - 1))).toBe(JSON.stringify(all[n - 1]));      // a far seek builds everything before it, in order
      expect(c.built()).toBe(n);
      for (let i = n - 1; i >= 0; i--) expect(JSON.stringify(c.get(i))).toBe(JSON.stringify(all[i]));
      const d = sceneCache(t); let done = false; while (!done) done = d.step(2);
      expect(d.built()).toBe(n);
      for (let i = 0; i < n; i++) expect(JSON.stringify(d.get(i))).toBe(JSON.stringify(all[i]));
    }
  });
});
