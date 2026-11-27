// Stack and queue shapes: exact type-name detection (deque/std::queue -> queue, std::stack -> stack),
// vertical stack geometry, and the false-positive corpus. Fixtures are real recordings of the programs
// in tests/programs/m6 (queue.py, stack.cpp, queue.cpp).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseTrace } from '../src/parseTrace';
import { buildScene, buildScenes, newLayoutState, arrayOmitted, laneSummary, linkPath, GEOM } from '../src/structures';
import type { Scene } from '../src/structures';
import type { Trace, TraceEvent } from '../src/types';

const load = (n: string): Trace => parseTrace(readFileSync(new URL(`./fixtures/m6/${n}.m6.json`, import.meta.url), 'utf8'));

// The first event whose heap holds a node of `type` with at least `minItems` captured items, with its scene.
const sceneWith = (t: Trace, type: string, minItems: number): { scene: Scene; id: string; event: TraceEvent } | null => {
  const state = newLayoutState();
  for (const e of t.events) {
    const scene = buildScene(e, state);
    for (const [id, n] of Object.entries(e.heap)) if (n.type === type && (n.items?.length ?? 0) >= minItems && scene.boxes[id]) return { scene, id, event: e };
  }
  return null;
};

const eventWith = (heap: TraceEvent['heap'], locals: Record<string, { kind: 'ref'; id: string }> = {}): TraceEvent =>
  ({ step: 0, event: 'line', line: 1, frames: [{ depth: 0, function: '<module>', line: 1, locals }], heap, stdout: '', stderr: '', truncated: [] });

const scalar = (value: number) => ({ kind: 'scalar' as const, type: 'int', value });

describe('queue shape from real recordings', () => {
  it('detects the Python deque BFS queue, front first', () => {
    const hit = sceneWith(load('queue'), 'deque', 2);
    expect(hit).not.toBeNull();
    const { scene, id, event } = hit!;
    const box = scene.boxes[id];
    expect(box.queue).toBe(true);
    expect(box.stack).toBeUndefined();
    expect(box.h).toBe(GEOM.cell);                      // horizontal strip, one cell tall
    expect(box.w).toBe((event.heap[id].items!.length) * GEOM.cell);
    // Queue cells hold the tree nodes being visited: arrows leave the strip.
    expect(scene.links.some((l) => l.from === id)).toBe(true);
    const lane = scene.lanes.find((l) => l.ids[0] === id)!;
    expect(laneSummary(lane, event, scene)).toContain('front to back');
  });

  it('detects std::queue the same way', () => {
    const hit = sceneWith(load('queuecpp'), 'std::queue', 5);
    expect(hit).not.toBeNull();
    const box = hit!.scene.boxes[hit!.id];
    expect(box.queue).toBe(true);
    expect(box.w).toBe(5 * GEOM.cell);
    expect(hit!.event.heap[hit!.id].items!.map((v) => (v.kind === 'scalar' ? v.value : null))).toEqual([10, 20, 30, 40, 50]);
  });

  it('keeps the queue in the same lane across the whole recording', () => {
    const t = load('queue'), scenes = buildScenes(t);
    let lane: number | undefined;
    for (const s of scenes) {
      const id = Object.keys(s.boxes).find((b) => s.boxes[b].queue);
      if (!id) continue;
      if (lane === undefined) lane = s.boxes[id].lane;
      expect(s.boxes[id].lane).toBe(lane);
    }
    expect(lane).toBeDefined();
  });
});

describe('stack shape from real recordings', () => {
  it('draws std::stack as a vertical column, bottom to top in item order', () => {
    const hit = sceneWith(load('stack'), 'std::stack', 3);
    expect(hit).not.toBeNull();
    const { scene, id, event } = hit!;
    const box = scene.boxes[id];
    expect(box.stack).toBe(true);
    expect(box.queue).toBeUndefined();
    expect(box.w).toBe(GEOM.cell);                      // one cell wide
    expect(box.h).toBe(event.heap[id].items!.length * GEOM.cell);   // one cell per item
    expect(event.heap[id].items!.map((v) => (v.kind === 'scalar' ? v.value : null))).toEqual([1, 2, 3]);
    const lane = scene.lanes.find((l) => l.ids[0] === id)!;
    expect(laneSummary(lane, event, scene)).toContain('bottom to top');
  });

  it('grows the row for a tall stack so nothing overlaps it', () => {
    const heap: TraceEvent['heap'] = {};
    const items = Array.from({ length: 8 }, (_, i) => scalar(i));
    heap['s'] = { type: 'std::stack', items, length: 8 } as TraceEvent['heap'][string];
    heap['after'] = { type: 'list', items: [scalar(99)], length: 1 } as TraceEvent['heap'][string];
    const e = eventWith(heap, { s: { kind: 'ref', id: 's' }, after: { kind: 'ref', id: 'after' } });
    const scene = buildScene(e, newLayoutState());
    const stackBox = scene.boxes['s'], other = scene.boxes['after'];
    expect(stackBox.h).toBe(8 * GEOM.cell);
    // The plain array sits on another row, below the stack's full height.
    expect(other.y).toBeGreaterThanOrEqual(stackBox.y + stackBox.h);
  });

  it('arrows leave a stack cell from its right edge at that cell\'s height', () => {
    // The Node* DFS stack: every arrow that leaves a stack cell must start at the right edge,
    // at the vertical middle of that cell (cell 0 at the bottom).
    const t = load('stack'), scenes = buildScenes(t);
    let checked = 0;
    for (const s of scenes) {
      for (const l of s.links) {
        const a = s.boxes[l.from];
        if (!a?.stack || l.cell === undefined) continue;
        const d = linkPath(l, s.boxes);
        expect(d).not.toBeNull();
        const m = d!.match(/^M ([-\d.]+) ([-\d.]+)/)!;
        expect(Number(m[1])).toBeCloseTo(a.w, 6);
        expect(Number(m[2])).toBeCloseTo(a.h - l.cell * GEOM.cell - GEOM.cell / 2, 6);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe('false positives: nothing else becomes a stack or queue', () => {
  it('a plain Python list used as a queue stays a plain strip', () => {
    const t = load('bfs');   // bfs.py keeps its frontier in a list with pop(0)
    const scenes = buildScenes(t);
    for (const s of scenes) for (const b of Object.values(s.boxes)) {
      expect(b.stack).toBeUndefined();
      expect(b.queue).toBeUndefined();
    }
  });

  it('std::vector stays a plain strip', () => {
    const t = load('adjcpp'), scenes = buildScenes(t);
    let strips = 0;
    for (const s of scenes) for (const [id, b] of Object.entries(s.boxes)) {
      if (b.kind !== 'array') continue;
      strips++;
      expect(b.stack).toBeUndefined();
      expect(b.queue).toBeUndefined();
    }
    expect(strips).toBeGreaterThan(0);
  });

  it('std::priority_queue is captured but stays a plain strip: its items are heap order, not front/back', () => {
    const hit = sceneWith(load('queuecpp'), 'std::priority_queue', 4);
    expect(hit).not.toBeNull();
    const box = hit!.scene.boxes[hit!.id];
    expect(box.kind).toBe('array');
    expect(box.queue).toBeUndefined();
    expect(box.stack).toBeUndefined();
  });

  it('an opaque std::stack from an old recording stays a card, never a stack', () => {
    const heap: TraceEvent['heap'] = { old: { type: 'std::stack', opaque: true } as TraceEvent['heap'][string] };
    const scene = buildScene(eventWith(heap, { s: { kind: 'ref', id: 'old' } }), newLayoutState());
    expect(Object.values(scene.boxes).every((b) => !b.stack && !b.queue)).toBe(true);
  });

  it('an empty deque draws one empty cell and no marks', () => {
    const heap: TraceEvent['heap'] = { q: { type: 'deque', items: [], length: 0 } as TraceEvent['heap'][string] };
    const scene = buildScene(eventWith(heap, { q: { kind: 'ref', id: 'q' } }), newLayoutState());
    const box = scene.boxes['q'];
    expect(box.queue).toBe(true);
    expect(box.w).toBe(GEOM.cell);
    expect(box.h).toBe(GEOM.cell);
  });

  it('a truncated deque keeps the omitted cell in its width', () => {
    const heap: TraceEvent['heap'] = {
      q: { type: 'deque', items: Array.from({ length: 40 }, (_, i) => scalar(i)), length: 50, truncated: true } as TraceEvent['heap'][string],
    };
    const e = eventWith(heap, { q: { kind: 'ref', id: 'q' } });
    const scene = buildScene(e, newLayoutState());
    expect(arrayOmitted(heap['q'])).toBe(10);
    expect(scene.boxes['q'].w).toBe(41 * GEOM.cell);
  });
});

describe('cost', () => {
  it('builds every scene of the three new fixtures within a generous budget, measured and printed', () => {
    for (const name of ['queue', 'stack', 'queuecpp']) {
      const t = load(name), t0 = performance.now(), scenes = buildScenes(t), ms = performance.now() - t0;
      console.log(`stackqueue cost: ${name}: ${t.events.length} events, ${scenes.length} scenes in ${ms.toFixed(1)} ms (${(ms / t.events.length).toFixed(3)} ms/event)`);
      expect(scenes.length).toBe(t.events.length);
      expect(ms).toBeLessThan(1000);
    }
  });
});
