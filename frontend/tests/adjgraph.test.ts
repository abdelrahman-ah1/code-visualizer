// Adjacency-list graphs: index-based detection, strict rejections, stable circle layout.
// Fixtures are real recordings of the programs in tests/programs/m6 (adjlist.py, adjlist.cpp, onebased.py, matrix.py).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseTrace } from '../src/parseTrace';
import { adjacencyOf, adjacencySpec, buildScene, buildScenes, newLayoutState, ADJ_LIMITS } from '../src/structures';
import type { Trace, TraceEvent } from '../src/types';

const load = (n: string): Trace => parseTrace(readFileSync(new URL(`./fixtures/m6/${n}.m6.json`, import.meta.url), 'utf8'));

// A minimal one-frame event with a hand-built heap, for the rejection corpus.
const scalar = (value: number | string | boolean, type?: string) => ({ kind: 'scalar' as const, type: type ?? typeof value === 'number' ? 'int' : typeof value === 'boolean' ? 'bool' : 'str', value });
const listOf = (items: ReturnType<typeof scalar>[], type = 'list') => ({ type, items, length: items.length });
const eventWith = (heap: TraceEvent['heap'], locals: Record<string, { kind: 'ref'; id: string }> = {}): TraceEvent =>
  ({ step: 0, event: 'line', line: 1, frames: [{ depth: 0, function: '<module>', line: 1, locals }], heap, stdout: '', stderr: '', truncated: [] });
// adj rows given as arrays of values; returns the event plus the outer id.
const adjEvent = (rows: (number | string | boolean)[][], opts: { type?: string; sharedRow?: number; truncatedRow?: number; uniform?: boolean } = {}) => {
  const heap: TraceEvent['heap'] = {};
  const lists = rows.map((r, i) => {
    const id = `r${i}`;
    const node = listOf(r.map((v) => scalar(v)) as ReturnType<typeof scalar>[], opts.type ?? 'list');
    if (opts.truncatedRow === i) { node.items = node.items.slice(0, 1); node.length = r.length; node.truncated = true; }
    heap[id] = node;
    return { kind: 'ref' as const, id };
  });
  heap['adj'] = { type: opts.type ?? 'list', items: lists, length: lists.length };
  const locals: Record<string, { kind: 'ref'; id: string }> = { adj: { kind: 'ref', id: 'adj' } };
  if (opts.sharedRow !== undefined) locals['alias'] = { kind: 'ref', id: `r${opts.sharedRow}` };
  return eventWith(heap, locals);
};

describe('adjacency detection from real recordings', () => {
  it('detects the Python BFS adjacency list as a 0-based graph and hides only its arrays', () => {
    const t = load('adjlist'), e = t.events[t.events.length - 1], specs = adjacencySpec(e, adjacencyOf(t));
    expect(specs).toHaveLength(1);
    const s = specs[0];
    expect(s.base).toBe(0);
    expect(s.n).toBe(5);
    expect(s.rows).toEqual([[1, 2], [3], [3, 4], [4], []]);
    const scene = buildScene(e, newLayoutState());
    for (const id of [s.outer, ...s.lists]) expect(scene.boxes[id], `${id} must not be drawn`).toBeUndefined();
    for (let i = 0; i < 5; i++) expect(scene.boxes[`${s.outer}#${i}`]?.circle).toBe(true);
    expect(scene.adjGroups).toHaveLength(1);
    expect(scene.adjGroups![0].label).toContain('adj');
    const edges = scene.links.filter((l) => l.from.startsWith(`${s.outer}#`) && l.to.startsWith(`${s.outer}#`));
    expect(edges).toHaveLength(6);   // 0->1, 0->2, 1->3, 2->3, 2->4, 3->4; no mutual pairs
    expect(scene.links.some((l) => l.from === s.outer || l.to === s.outer)).toBe(false);
  });
  it('detects the C++ vector<vector<int>> adjacency list the same way', () => {
    const t = load('adjcpp'), known = adjacencyOf(t);
    expect([...known.values()]).toContain(0);
    const e = t.events[60];
    const specs = adjacencySpec(e, known);
    expect(specs).toHaveLength(1);
    expect(specs[0].rows).toEqual([[1, 2], [3], [3, 4], [4], []]);
    const scene = buildScene(e, newLayoutState());
    for (let i = 0; i < 5; i++) expect(scene.boxes[`${specs[0].outer}#${i}`]?.circle).toBe(true);
  });
  it('builds every scene of the C++ recording without throwing, including after the buffer is released', () => {
    const scenes = buildScenes(load('adjcpp'));
    expect(scenes.length).toBeGreaterThan(100);
    const last = scenes[scenes.length - 1];
    expect(last.adjGroups ?? []).toHaveLength(0);   // buffer released: plain view, no crash, no half graph
  });
  it('detects 1-based indexing only when 0 appears nowhere and max equals n', () => {
    const t = load('onebased'), e = t.events[t.events.length - 1], specs = adjacencySpec(e, adjacencyOf(t));
    expect(specs).toHaveLength(1);
    expect(specs[0].base).toBe(1);
    const scene = buildScene(e, newLayoutState());
    for (const label of ['1', '2', '3']) expect(scene.boxes[`${specs[0].outer}#${label}`]?.circle).toBe(true);
    expect(scene.boxes[`${specs[0].outer}#0`]).toBeUndefined();
  });
});

describe('strict rejections: anything ambiguous stays in the plain view', () => {
  it('a uniform numeric rectangle is a matrix, not a graph', () => {
    const t = load('matrix');
    for (const e of t.events) expect(adjacencySpec(e, adjacencyOf(t))).toHaveLength(0);
    const scene = buildScene(t.events[t.events.length - 1], newLayoutState());
    expect(Object.values(scene.boxes).some((b) => b.kind === 'array')).toBe(true);   // still a cell strip
    expect(scene.adjGroups ?? []).toHaveLength(0);
  });
  it('rejects out-of-range values, both directions', () => {
    expect(adjacencySpec(adjEvent([[1], [4]]))).toHaveLength(0);      // 4 > n-1 and != n... n=2: out of range
    expect(adjacencySpec(adjEvent([[0], [-1]]))).toHaveLength(0);     // negative
  });
  it('rejects a row shared with another variable (no silent aliasing loss)', () => {
    const e = adjEvent([[1], [0]], { sharedRow: 0 });
    expect(adjacencySpec(e)).toHaveLength(0);
    const scene = buildScene(e, newLayoutState());
    expect(scene.boxes['r0'], 'shared row stays visible').toBeDefined();
    expect(scene.boxes['adj'], 'outer stays visible').toBeDefined();
  });
  it('rejects mixed or non-int rows: strings, floats, bools, nested refs', () => {
    expect(adjacencySpec(adjEvent([['x'], [0]]))).toHaveLength(0);
    expect(adjacencySpec(adjEvent([[true], [0]]))).toHaveLength(0);   // Python bool IS an int instance; the recorded type saves us
    const floats = adjEvent([[1], [0]]);
    (floats.heap['r0'].items![0] as { type: string }).type = 'float';
    expect(adjacencySpec(floats)).toHaveLength(0);
    const nested = eventWith({
      adj: { type: 'list', items: [{ kind: 'ref', id: 'r0' }, { kind: 'ref', id: 'r1' }], length: 2 },
      r0: { type: 'list', items: [{ kind: 'ref', id: 'r1' }], length: 1 },
      r1: { type: 'list', items: [], length: 0 },
    });
    expect(adjacencySpec(nested)).toHaveLength(0);                    // list of lists of lists: not an adjacency list
  });
  it('rejects a cut-off row (recording limits) rather than guessing', () => {
    expect(adjacencySpec(adjEvent([[1, 0], [0]], { truncatedRow: 0 }))).toHaveLength(0);
  });
  it('rejects fewer than 2 rows and more than the vertex cap', () => {
    expect(adjacencySpec(adjEvent([[0]]))).toHaveLength(0);
    expect(adjacencySpec(adjEvent(Array.from({ length: ADJ_LIMITS.vertices + 1 }, (_, i) => [(i + 1) % (ADJ_LIMITS.vertices + 1)])))).toHaveLength(0);
  });
  it('rejects the same row object twice', () => {
    const e = eventWith({
      adj: { type: 'list', items: [{ kind: 'ref', id: 'r0' }, { kind: 'ref', id: 'r0' }], length: 2 },
      r0: { type: 'list', items: [scalar(0)], length: 1 },
    });
    expect(adjacencySpec(e)).toHaveLength(0);
  });
  it('C++ int-family type names count as indices; bool does not', () => {
    const e = adjEvent([[1], [0]], { type: 'std::vector' });
    expect(adjacencySpec(e)).toHaveLength(1);
    (e.heap['r0'].items![0] as { type: string }).type = 'bool';
    expect(adjacencySpec(e)).toHaveLength(0);
  });
});

describe('trace-level consistency and stability', () => {
  it('draws the graph from the first event, while every row is still empty', () => {
    const trace = {
      limit_hit: undefined, schema_version: 'codeviz.trace/1.0', source: '', runtime: { implementation: 'cpython', version: '3' },
      limits: { wall_seconds: 1, events: 100, output_chars: 1000 }, status: 'ok', complete: true,
      events: [
        eventWith({ adj: { type: 'list', items: [{ kind: 'ref', id: 'r0' }, { kind: 'ref', id: 'r1' }], length: 2 }, r0: listOf([]), r1: listOf([]) }, { adj: { kind: 'ref', id: 'adj' } }),
        eventWith({ adj: { type: 'list', items: [{ kind: 'ref', id: 'r0' }, { kind: 'ref', id: 'r1' }], length: 2 }, r0: listOf([scalar(1)]), r1: listOf([scalar(0)]) }, { adj: { kind: 'ref', id: 'adj' } }),
      ],
    } as unknown as Trace;
    const scenes = buildScenes(trace);
    for (const s of scenes) { expect(s.boxes['adj#0']?.circle).toBe(true); expect(s.boxes['adj#1']?.circle).toBe(true); }
  });
  it('vertices keep their exact positions across steps where the graph does not change', () => {
    const scenes = buildScenes(load('adjlist'));
    const withGraph = scenes.map((s, i) => ({ s, i })).filter(({ s }) => (s.adjGroups ?? []).length > 0);
    expect(withGraph.length).toBeGreaterThan(10);
    // Positions must be identical between steps where the rest of the diagram is unchanged (new variables appearing
    // legitimately shift the whole graph block down; what must not move is a vertex relative to that block).
    for (let k = 1; k < withGraph.length; k++) {
      const a = withGraph[k - 1].s.boxes, b = withGraph[k].s.boxes;
      if (Object.keys(a).length !== Object.keys(b).length || !Object.keys(b).every((id) => a[id])) continue;
      for (const id of Object.keys(b)) {
        expect([b[id].x, b[id].y], `${id} moved between scenes ${withGraph[k - 1].i} and ${withGraph[k].i}`).toEqual([a[id].x, a[id].y]);
      }
    }
    const settled = withGraph.filter((_, k) => k > 0 && Object.keys(withGraph[k - 1].s.boxes).length === Object.keys(withGraph[k].s.boxes).length);
    expect(settled.length, 'the recording must have settled stretches to assert on').toBeGreaterThan(5);
  });
  it('detection and scene building stay fast on the largest recording', () => {
    const t = load('adjcpp'), known = adjacencyOf(t);
    const t0 = performance.now();
    for (const e of t.events) adjacencySpec(e, known);
    const detectMs = performance.now() - t0;
    const t1 = performance.now();
    buildScenes(t);
    const buildMs = performance.now() - t1;
    console.log(`adjacency perf: ${t.events.length} events, detection ${detectMs.toFixed(1)} ms total (${(detectMs / t.events.length).toFixed(3)} ms/event), scenes ${buildMs.toFixed(0)} ms`);
    expect(detectMs / t.events.length).toBeLessThan(1);   // budget: under 1 ms per event
    expect(buildMs).toBeLessThan(5000);
  });
});
