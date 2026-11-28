// Access marks: the step's line touched this cell, so the ring goes there. Pure functions, so they are asserted directly.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseTrace } from '../src/parseTrace';
import { ACCESS_RINGS, accessClause, accessTargets, buildScenes, laneSummary } from '../src/structures';
import type { Scene, SceneLane } from '../src/structures';
import type { TraceEvent } from '../src/types';

const trace = parseTrace(readFileSync(new URL('../../examples/16_access_marks.trace.json', import.meta.url), 'utf8'));
const scenes = buildScenes(trace);
const step = (n: number) => trace.events[n];
const arrayLane = (n: number) => scenes[n].lanes.find((l) => l.kind === 'array')!;

describe('access marks', () => {
  it('rings the cell the line fetched', () => {
    // Step 3 is the loop line: `for r in rows` takes rows[0].
    expect(step(3).line).toBe(3);
    expect(accessTargets(scenes[3], step(3))).toEqual([{ id: 'o1', cell: 0, mode: 'read', exact: true }]);
    // Step 4 reads r[1], which is rows[0][1]: the inner list is o2.
    expect(accessTargets(scenes[4], step(4))).toEqual([{ id: 'o2', cell: 1, mode: 'read', exact: true }]);
  });

  it('rings a read and a write on the same step', () => {
    expect(accessTargets(scenes[8], step(8))).toEqual([
      { id: 'o1', cell: 0, mode: 'read', exact: true },
      { id: 'o2', cell: 0, mode: 'write', exact: true },
    ]);
  });

  it('keeps the most recent rings when a line touches more cells than it can show', () => {
    // Five reads on one line: the last two are the ones the eye needs, and the summary still lists all five.
    const six = { type: 'list', items: [0, 1, 2, 3, 4, 5].map((value) => ({ kind: 'scalar' as const, type: 'int', value })), length: 6 };
    const scene = { boxes: { o1: { id: 'o1', kind: 'array' as const, x: 0, y: 0, w: 138, h: 46, lane: 0 } }, lanes: [] } as unknown as Scene;
    const busy: TraceEvent = { ...step(8), heap: { o1: six }, accesses: [0, 1, 2, 3, 4].map((cell) => ({ id: 'o1', mode: 'read' as const, line: 8, cell })) };
    expect(accessTargets(scene, busy)).toEqual([3, 4].map((cell) => ({ id: 'o1', cell, mode: 'read', exact: true })));
    expect(accessTargets(scene, busy)).toHaveLength(ACCESS_RINGS);
    expect(accessClause({ kind: 'array', ids: ['o1'] } as unknown as SceneLane, busy)).toBe(' (reading cells 0, 1, 2, 3, 4)');
  });

  it('shows one ring per cell, with the last touch winning', () => {
    const twice: TraceEvent = { ...step(8), accesses: [
      { id: 'o1', mode: 'read' as const, line: 8, cell: 0 },
      { id: 'o1', mode: 'write' as const, line: 8, cell: 0 },
    ] };
    expect(accessTargets(scenes[8], twice)).toEqual([{ id: 'o1', cell: 0, mode: 'write', exact: true }]);
  });

  it('draws nothing for an object this step does not draw, a key, or a cell the recording cut off', () => {
    const odd: TraceEvent = { ...step(3), accesses: [
      { id: 'o99', mode: 'read' as const, line: 3, cell: 0 },          // not in this scene
      { id: 'o1', mode: 'read' as const, line: 3, key: 'a' },           // a dict key: drawn in a later slice
      { id: 'o1', mode: 'read' as const, line: 3, cell: 7 },            // beyond the captured cells
    ] };
    expect(accessTargets(scenes[3], odd)).toEqual([]);
  });

  it('leaves a recording made before access marking alone', () => {
    const old: TraceEvent = { ...step(3) };
    delete old.accesses;
    expect(accessTargets(scenes[3], old)).toEqual([]);
    expect(accessClause(arrayLane(3), old)).toBe('');
  });

  it('says what the step read in the lane summary', () => {
    expect(laneSummary(arrayLane(3), step(3), scenes[3])).toMatch(/^list o1 \(rows\): \[→ o2, → o3\] \(reading cell 0\)$/);
    const busy: TraceEvent = { ...step(3), accesses: [0, 1].map((cell) => ({ id: 'o1', mode: 'read' as const, line: 3, cell })) };
    expect(accessClause(arrayLane(3), busy)).toBe(' (reading cells 0, 1)');
    const mixed: TraceEvent = { ...step(3), accesses: [
      { id: 'o1', mode: 'read' as const, line: 3, cell: 0 },
      { id: 'o1', mode: 'write' as const, line: 3, cell: 1 },
      { id: 'o1', mode: 'readwrite' as const, line: 3, cell: 2 },
    ] };
    expect(accessClause(arrayLane(3), mixed)).toBe(' (reading cell 0; writing cell 1; reading and writing cell 2)');
  });
});
