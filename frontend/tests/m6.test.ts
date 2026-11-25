// M6: graph and tree layout. Fixtures are real recordings of the programs in tests/programs/m6 (rebuild with make_traces.py).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseTrace } from '../src/parseTrace';
import { buildScene, buildScenes, cloneLayoutState, graphSpec, linkPath, newLayoutState, sceneCache, vertexEdges } from '../src/structures';
import { layeredLayout, stabilize } from '../src/graphlayout';
import type { Slot } from '../src/graphlayout';
import type { Trace, TraceEvent } from '../src/types';

// path sampler, same as tests/routing.test.ts
type Pt = { x: number; y: number };
function samplePath(d: string, ox: number, oy: number): Pt[] {
  const tok = d.match(/[MLQC]|-?\d+(?:\.\d+)?(?:e-?\d+)?/g) ?? [], pts: Pt[] = [];
  let i = 0, cur: Pt = { x: 0, y: 0 }, cmd = '';
  const num = () => Number(tok[i++]);
  while (i < tok.length) {
    if (/[MLQC]/.test(tok[i])) cmd = tok[i++];
    if (cmd === 'M' || cmd === 'L') { const p = { x: num() + ox, y: num() + oy }; if (cmd === 'L') for (let k = 1; k <= 12; k++) pts.push({ x: cur.x + (p.x - cur.x) * k / 12, y: cur.y + (p.y - cur.y) * k / 12 }); else pts.push(p); cur = p; }
    else if (cmd === 'Q') { const c = { x: num() + ox, y: num() + oy }, p = { x: num() + ox, y: num() + oy }; for (let k = 1; k <= 8; k++) { const t = k / 8, u = 1 - t; pts.push({ x: u * u * cur.x + 2 * u * t * c.x + t * t * p.x, y: u * u * cur.y + 2 * u * t * c.y + t * t * p.y }); } cur = p; }
    else if (cmd === 'C') { const c1 = { x: num() + ox, y: num() + oy }, c2 = { x: num() + ox, y: num() + oy }, p = { x: num() + ox, y: num() + oy }; const NS = Math.min(3000, Math.max(40, Math.ceil(Math.hypot(p.x - cur.x, p.y - cur.y) / 4))); for (let k = 1; k <= NS; k++) { const t = k / NS, u = 1 - t; pts.push({ x: u * u * u * cur.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p.x, y: u * u * u * cur.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p.y }); } cur = p; }
  }
  return pts;
}
const load = (n: string): Trace => parseTrace(readFileSync(new URL(`./fixtures/m6/${n}.m6.json`, import.meta.url), 'utf8'));
const overlap = (a: { x: number; y: number; w: number; h: number }, b: typeof a) => a.x < b.x + b.w - 1 && b.x < a.x + a.w - 1 && a.y < b.y + b.h - 1 && b.y < a.y + a.h - 1;
const moved = (scenes: ReturnType<typeof buildScenes>) => { let total = 0, max = 0; for (let i = 1; i < scenes.length; i++) { let m = 0; for (const [id, b] of Object.entries(scenes[i].boxes)) { const a = scenes[i - 1].boxes[id]; if (a && Math.hypot(a.x - b.x, a.y - b.y) > 1) m++; } total += m; max = Math.max(max, m); } return { total, max }; };

describe('graph detection', () => {
  it('treats Vertex.edges / T.children / V.out as neighbour lists and hides only those lists', () => {
    for (const n of ['graph', 'ntree', 'dag', 'bfs', 'multi']) {
      const t = load(n), e = t.events[t.events.length - 1], gs = graphSpec(e);
      expect(gs.vertices.length, n).toBeGreaterThan(2);
      for (const id of gs.collapsed.keys()) expect(Object.values(buildScene(e, newLayoutState()).boxes).some((b) => b.id === id), `${n} list ${id} must not be drawn`).toBe(false);
      for (const v of gs.vertices) expect(buildScene(e, newLayoutState()).boxes[v].vertex, n).toBe(true);
    }
  });
  it('leaves a list that two objects share as an ordinary, visible array (no silent aliasing loss)', () => {
    const t = load('shared'), e = t.events[t.events.length - 1], gs = graphSpec(e), s = buildScene(e, newLayoutState());
    expect(gs.vertices).toHaveLength(0);
    const arr = Object.keys(e.heap).find((id) => e.heap[id].items)!;
    expect(s.boxes[arr]).toBeDefined();
  });
  it('does not turn BSTs or hash tables into graphs', () => {
    for (const n of ['bst', 'avl']) { const t = load(n); expect(graphSpec(t.events[t.events.length - 1]).vertices, n).toHaveLength(0); }
  });
});

describe('graph edges keep direction, aliasing and multiplicity', () => {
  it('draws exactly the edges stored in the neighbour lists, at every step', () => {
    for (const n of ['graph', 'dag', 'ntree', 'bfs', 'multi']) {
      const t = load(n), scenes = buildScenes(t);
      t.events.forEach((e, i) => {
        const gs = graphSpec(e), truth = new Set<string>();
        for (const v of gs.vertices) for (const w of vertexEdges(e.heap, v, gs)) truth.add(`${v}>${w}`);
        const drawn = new Set<string>();
        for (const l of scenes[i].links.filter((x) => x.d && gs.vertices.includes(x.from) && gs.vertices.includes(x.to))) { drawn.add(`${l.from}>${l.to}`); if (l.both) drawn.add(`${l.to}>${l.from}`); }
        expect([...drawn].sort(), `${n} step ${i}`).toEqual([...truth].sort());
        // a two-headed line is only used when both directions really exist
        for (const l of scenes[i].links.filter((x) => x.both)) expect(truth.has(`${l.from}>${l.to}`) && truth.has(`${l.to}>${l.from}`), `${n} step ${i}`).toBe(true);
      });
    }
  });
  it('shows multiplicity, self loops and one-way edges (multi.py: A->B twice, B->A, B->C, C->C)', () => {
    const t = load('multi'), e = t.events[t.events.length - 1], s = buildScene(e, newLayoutState());
    const idOf = (name: string) => Object.keys(e.heap).find((id) => { const f = e.heap[id].fields?.name; return f?.kind === 'scalar' && f.value === name; })!;
    const [A, B, C] = ['A', 'B', 'C'].map(idOf);
    const find = (a: string, b: string) => s.links.find((l) => l.d && ((l.from === a && l.to === b) || (l.from === b && l.to === a)));
    expect(find(A, B)!.both).toBe(true); expect(find(A, B)!.label).toMatch(/×2/);
    expect(find(B, C)!.both).toBeFalsy(); expect(find(B, C)!.from).toBe(B);
    expect(s.links.find((l) => l.from === C && l.to === C)).toBeDefined();
  });
  it('neighbour-list variables keep a name pill on the owning vertex', () => {
    const t = load('bfs'), i = t.events.findIndex((e) => e.frames[0].locals.nbrs?.kind === 'ref'), s = buildScenes(t)[i], e = t.events[i];
    const ref = (e.frames[0].locals.nbrs as { id: string }).id, owner = graphSpec(e).collapsed.get(ref)!.owner;
    expect(s.tags[owner].join(' ')).toContain('nbrs');
  });
});

describe('legibility', () => {
  it('never overlaps two boxes and never runs a vertex edge through another box', () => {
    for (const n of ['graph', 'dag', 'ntree', 'bfs', 'multi', 'bst', 'avl']) {
      const t = load(n), scenes = buildScenes(t);
      scenes.forEach((s, i) => {
        const boxes = Object.values(s.boxes);
        for (let a = 0; a < boxes.length; a++) for (let b = a + 1; b < boxes.length; b++) expect(overlap(boxes[a], boxes[b]), `${n} step ${i}: ${boxes[a].id} overlaps ${boxes[b].id}`).toBe(false);
        for (const l of s.links.filter((x) => x.d && x.from !== x.to)) {
          const a = s.boxes[l.from], pts = samplePath(linkPath(l, s.boxes)!, a.x, a.y);
          for (const o of boxes) if (o.id !== l.from && o.id !== l.to) expect(pts.some((p) => p.x > o.x + 3 && p.x < o.x + o.w - 3 && p.y > o.y + 3 && p.y < o.y + o.h - 3), `${n} step ${i}: edge ${l.from}>${l.to} crosses ${o.id}`).toBe(false);
        }
        for (const b of boxes) expect(b.x, `${n} ${b.id} on canvas`).toBeGreaterThanOrEqual(0);
        for (const b of boxes) expect(b.x + b.w, `${n} ${b.id} inside scene width`).toBeLessThanOrEqual(s.width + 1);
      });
    }
  });
  it('lays out disconnected components side by side and cycles without looping forever', () => {
    const out = new Map<string, string[]>([['a', ['b']], ['b', ['c']], ['c', ['a']], ['d', ['e']], ['e', []], ['f', []]]);
    const lay = layeredLayout({ ids: ['a', 'b', 'c', 'd', 'e', 'f'], out });
    expect(lay.size).toBe(6);
    const rows = new Map<number, number[]>(); for (const q of lay.values()) (rows.get(q.d) ?? rows.set(q.d, []).get(q.d)!).push(q.x);
    for (const xs of rows.values()) { xs.sort((p, q) => p - q); for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(1 - 1e-9); }
    expect(lay.get('a')!.d).toBe(0); expect(lay.get('b')!.d).toBe(1); expect(lay.get('c')!.d).toBe(2);   // a->b->c is two hops; the edge c->a points back up
  });
  it('handles an empty graph', () => { expect(layeredLayout({ ids: [], out: new Map() }).size).toBe(0); });
});

describe('stable layout', () => {
  it('stabilize keeps a node within the threshold, moves it past it, and pushes overlaps apart', () => {
    const mem = new Map<string, number>([['a', 0], ['b', 1]]);
    const near = stabilize(new Map<string, Slot>([['a', { x: 0.3, d: 0 }], ['b', { x: 1.2, d: 0 }]]), mem);
    expect([near.get('a'), near.get('b')]).toEqual([0, 1]);
    const far = stabilize(new Map<string, Slot>([['a', { x: 0, d: 0 }], ['b', { x: 3, d: 0 }]]), mem);
    expect(far.get('b')).toBe(3);
    const touch = stabilize(new Map<string, Slot>([['a', { x: 0, d: 0 }], ['b', { x: 0.2, d: 0 }]]), new Map());
    expect(touch.get('b')! - touch.get('a')!).toBeGreaterThanOrEqual(1);
  });
  it('moves fewer boxes than the old per-step layout (old numbers measured on 04c8e8c: bst 22, avl 16, ntree 90 moved boxes)', () => {
    const got = { bst: moved(buildScenes(load('bst'))), avl: moved(buildScenes(load('avl'))), ntree: moved(buildScenes(load('ntree'))) };
    expect(got.bst.total).toBeLessThanOrEqual(18); expect(got.avl.total).toBeLessThanOrEqual(15); expect(got.ntree.total).toBeLessThanOrEqual(26);
    expect(got.bst.max).toBeLessThanOrEqual(6); expect(got.ntree.max).toBeLessThanOrEqual(5);
  });
  it('a rotation changes structure but keeps left-to-right order of nodes that stay in the same row', () => {
    const t = load('avl'), scenes = buildScenes(t);
    for (let i = 1; i < scenes.length; i++) for (const [id, b] of Object.entries(scenes[i].boxes)) for (const [id2, b2] of Object.entries(scenes[i].boxes)) {
      const p = scenes[i - 1].boxes[id], p2 = scenes[i - 1].boxes[id2];
      if (id < id2 && p && p2 && p.y === p2.y && b.y === b2.y && Math.abs(p.x - p2.x) > 80 && Math.abs(b.x - b2.x) > 80) expect(Math.sign(p.x - p2.x), `avl step ${i}: ${id} and ${id2} swapped sides`).toBe(Math.sign(b.x - b2.x));
    }
  });
  it('sceneCache (lazy) and buildScenes give the same boxes and edges, in any access order', () => {
    for (const n of ['graph', 'bfs', 'bst']) {
      const t = load(n), all = buildScenes(t), cache = sceneCache(t), order = [...t.events.keys()].reverse();
      for (const i of order) { const s = cache.get(i); expect(JSON.stringify(s.boxes), `${n} ${i}`).toBe(JSON.stringify(all[i].boxes)); expect(s.links.length).toBe(all[i].links.length); }
    }
  });
  it('building a scene does not change the recorded trace', () => {
    const t = load('graph'), before = JSON.stringify(t); buildScenes(t); expect(JSON.stringify(t)).toBe(before);
  });
  it('layout state clones independently', () => {
    const s = newLayoutState(); s.gx.set('a', 1); const c = cloneLayoutState(s); c.gx.set('a', 5); expect(s.gx.get('a')).toBe(1);
  });
});

describe('cost', () => {
  const ring = (n: number): TraceEvent => {
    const heap: TraceEvent['heap'] = {};
    for (let i = 0; i < n; i++) { heap[`v${i}`] = { type: 'V', fields: { id: { kind: 'scalar', type: 'int', value: i }, nbrs: { kind: 'ref', id: `l${i}` } } }; heap[`l${i}`] = { type: 'list', items: [{ kind: 'ref', id: `v${(i + 1) % n}` }, { kind: 'ref', id: `v${(i * 7 + 3) % n}` }], length: 2 }; }
    return { step: 1, event: 'line', line: 1, frames: [{ depth: 0, function: '<module>', line: 1, locals: { first: { kind: 'ref', id: 'v0' } } }], heap, stdout: '', stderr: '', truncated: [] };
  };
  it('lays out 100 and 200 vertices (2 edges each) within a generous budget, measured and printed', () => {
    for (const n of [25, 100, 200]) {
      const e = ring(n), t0 = performance.now(); const s = buildScene(e, newLayoutState()); const ms = performance.now() - t0;
      console.log(`M6 cost: ${n} vertices, ${n * 2} edges, one scene incl. arrow routing: ${ms.toFixed(1)} ms`);
      expect(Object.keys(s.boxes)).toHaveLength(n);
      expect(ms).toBeLessThan(n === 200 ? 1500 : 600);
    }
  });
});

describe('graph drawn the same way from the first event (arrows never end in empty space)', () => {
  it('graph.py: every Vertex is a vertex card in every event, and every arrow ends on a drawn box', () => {
    const t = load('graph'), scenes = buildScenes(t);
    scenes.forEach((s, i) => {
      for (const [id, n] of Object.entries(t.events[i].heap)) if (n.type === 'Vertex') expect(s.boxes[id]?.vertex, `event ${i} ${id}`).toBe(true);
      for (const l of s.links) { const b = s.boxes[l.to]; expect(b && b.w > 0 && b.h > 0, `event ${i}: arrow to ${l.to} has no drawn box`).toBe(true); }
      expect(Object.values(t.events[i].heap).some((n) => n.type.includes('list') && s.boxes[Object.keys(t.events[i].heap).find((k) => t.events[i].heap[k] === n)!]), `event ${i} must not draw the neighbour lists`).toBe(false);
    });
  });
});

describe('trace-wide graph types stay truthful', () => {
  const lastIdx = (t: Trace) => t.events.length - 1;
  const clone = (t: Trace): Trace => structuredClone(t);
  const view = (s: ReturnType<typeof buildScene>) => Object.entries(s.boxes).map(([id, b]) => `${id}:${b.kind}:${b.vertex ? 'v' : '-'}`).sort().join(',');
  it('eager buildScenes and lazy sceneCache (any seek order) draw every event the same', () => {
    const t = load('graph'), eager = buildScenes(t).map(view), cache = sceneCache(t);
    for (const i of [64, 3, 40, 0, 17, 63, 9, 30]) expect(view(cache.get(i)), `event ${i}`).toBe(eager[i]);
    const fresh = sceneCache(t);
    expect(view(fresh.get(12))).toBe(eager[12]);   // first ask is a middle event
  });
  it('early events show no edges that only exist later', () => {
    const t = load('graph'), scenes = buildScenes(t);
    expect(scenes[8].links).toHaveLength(0);
    expect(scenes[8].graph!.collapsed.size).toBe(0);
    const early = t.events.findIndex((e) => Object.values(e.heap).filter((n) => n.type === 'list').length === 1 && Object.keys(e.heap).length === 3);   // o1, its empty list, a fresh vertex
    for (const l of scenes[Math.max(0, early)].links) expect(Object.keys(t.events[early].heap)).toContain(l.to);
  });
  it('a list that becomes shared falls back to the plain view in that event only', () => {
    const t = clone(load('graph')), e = t.events[lastIdx(t)];
    e.heap.o3.fields!.edges = { kind: 'ref', id: 'o2' };   // o1 and o3 now share one list
    const s = buildScenes(t);
    expect(s[lastIdx(t)].graph!.vertices).toHaveLength(0);
    expect(s[20].graph!.vertices.length).toBeGreaterThan(0);
  });
  it('a mixed list (an object of another type inside) is not hidden as a neighbour list', () => {
    const t = clone(load('graph')), e = t.events[lastIdx(t)];
    e.heap.o99 = { type: 'Other', fields: { x: { kind: 'scalar', type: 'int', value: 1, truncated: false } } };
    e.heap.o2.items!.push({ kind: 'ref', id: 'o99' }); e.heap.o2.length = e.heap.o2.items!.length;
    const s = buildScenes(t);
    expect(s[lastIdx(t)].graph!.collapsed.has('o2')).toBe(false);
    expect(s[lastIdx(t)].boxes.o2?.kind).toBe('array');   // still drawn, nothing silently hidden
  });
  it('an unrelated empty list on a vertex type is still drawn, and an unrelated type with an edges list is not a vertex', () => {
    const t = clone(load('graph'));
    for (const e of t.events) {
      if (e.heap.o1?.fields?.edges) { e.heap.o1.fields.log = { kind: 'ref', id: 'o90' }; e.heap.o90 = { type: 'list', items: [], length: 0 }; }
      e.heap.o95 = { type: 'Other', fields: { edges: { kind: 'ref', id: 'o96' } } }; e.heap.o96 = { type: 'list', items: [], length: 0 };
    }
    const s = buildScenes(t);
    for (const i of [12, 30, lastIdx(t)]) {
      expect(s[i].boxes.o90?.kind, `event ${i}: log list must stay visible`).toBe('array');
      expect(s[i].boxes.o95?.vertex, `event ${i}: other type is not a vertex`).not.toBe(true);
      expect(s[i].boxes.o96?.kind, `event ${i}: other type's list stays drawn`).toBe('array');
      expect(s[i].boxes.o2).toBeUndefined();   // the real neighbour list stays hidden
    }
  });
  it('a program whose lists are always empty never becomes a graph: its empty lists stay visible', () => {
    const t = clone(load('graph'));
    for (const e of t.events) for (const n of Object.values(e.heap)) if (n.type === 'list') { n.items = []; n.length = 0; }
    const s = buildScenes(t);
    s.forEach((sc, i) => { expect(sc.graph!.vertices, `event ${i}`).toHaveLength(0); for (const [id, n] of Object.entries(t.events[i].heap)) if (n.type === 'list') expect(sc.boxes[id]?.kind, `event ${i}`).toBe('array'); });
  });
});
