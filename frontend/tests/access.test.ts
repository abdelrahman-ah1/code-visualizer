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

// Dict keys and object fields: the same ring, on the row or the line that holds them. These events are built by hand
// so the shapes under test (a dict card, a list node, a plain object card) do not depend on a recording.
const sc = (v: string | number | boolean | null, type: string) => ({ kind: 'scalar' as const, type, value: v });
const dict = { type: 'dict', entries: [[sc('a', 'str'), sc(1, 'int')], [sc(1, 'int'), sc(2, 'int')], [sc(true, 'bool'), sc(3, 'int')]] as [ReturnType<typeof sc>, ReturnType<typeof sc>][] };
const nodeA = { type: 'Node', fields: { val: sc(1, 'int'), next: { kind: 'ref' as const, id: 'o3' } } };
const nodeB = { type: 'Node', fields: { val: sc(2, 'int'), next: sc(null, 'NoneType') } };
const cardBox = (id: string, rec = false) => ({ id, kind: 'card' as const, x: 0, y: 0, w: 138, h: 80, lane: -1, ...(rec ? { rec: true, mainH: 56 } : {}) });
const handBuilt = (heap: TraceEvent['heap'], boxes: Scene['boxes'], accesses: TraceEvent['accesses']) =>
  ({ scene: { boxes, lanes: [] } as unknown as Scene, event: { ...step(3), heap, accesses } as TraceEvent });

describe('access marks on dict keys and object fields', () => {
  it('rings the row of the key, and tells 1, "1" and True apart', () => {
    const { scene, event } = handBuilt({ o1: dict }, { o1: cardBox('o1') }, [
      { id: 'o1', mode: 'read', line: 3, key: 'a' },
      { id: 'o1', mode: 'write', line: 3, key: 1 },
    ]);
    expect(accessTargets(scene, event)).toEqual([{ id: 'o1', row: 0, mode: 'read', exact: true }, { id: 'o1', row: 1, mode: 'write', exact: true }]);
    const bool = handBuilt({ o1: dict }, { o1: cardBox('o1') }, [{ id: 'o1', mode: 'read', line: 3, key: true }]);
    expect(accessTargets(bool.scene, bool.event)).toEqual([{ id: 'o1', row: 2, mode: 'read', exact: true }]);
    const text = handBuilt({ o1: dict }, { o1: cardBox('o1') }, [{ id: 'o1', mode: 'read', line: 3, key: '1' }]);
    expect(accessTargets(text.scene, text.event)).toEqual([]);   // the string "1" is not the int 1
  });

  it('draws nothing for a key the dict does not hold yet, and says it in words anyway', () => {
    const { scene, event } = handBuilt({ o1: dict }, { o1: cardBox('o1') }, [{ id: 'o1', mode: 'write', line: 3, key: 'new' }]);
    expect(accessTargets(scene, event)).toEqual([]);
    expect(accessClause({ ids: ['o1'] }, event)).toBe(" (writing key 'new')");
  });

  it('rings the whole node, once, however many of its fields the line touched', () => {
    const boxes = { o1: { id: 'o1', kind: 'node' as const, x: 0, y: 0, w: 124, h: 56, lane: 0, mainH: 56 } };
    const { scene, event } = handBuilt({ o1: nodeA, o3: nodeB }, boxes, [
      { id: 'o1', mode: 'read', line: 3, field: 'val' },
      { id: 'o1', mode: 'write', line: 3, field: 'next' },
      { id: 'o1', mode: 'read', line: 3, field: 'nope' },        // a field the node does not hold: no ring of its own
    ]);
    expect(accessTargets(scene, event)).toEqual([{ id: 'o1', field: 'next', mode: 'readwrite', exact: true }]);   // one ring, read and write merged
    const two = handBuilt({ o1: nodeA, o3: nodeB }, { ...boxes, o3: { ...boxes.o1, id: 'o3' } }, [
      { id: 'o1', mode: 'read', line: 3, field: 'next' },
      { id: 'o3', mode: 'read', line: 3, field: 'val' },
    ]);
    expect(accessTargets(two.scene, two.event).map((t) => t.id)).toEqual(['o1', 'o3']);   // two nodes, two whole-box rings
    expect(accessClause({ ids: ['o1'] }, event)).toBe(' (reading fields val, nope; writing field next)');   // the words still name every field
  });

  it('rings the row of an object drawn as a card, and leaves graph vertices to their own slice', () => {
    const obj = { type: 'Point', fields: { x: sc(1, 'int'), y: sc(2, 'int') }, items: [sc(5, 'int')] };
    const { scene, event } = handBuilt({ o1: obj, o2: nodeB }, { o1: cardBox('o1'), o2: { ...cardBox('o2'), vertex: true } }, [
      { id: 'o1', mode: 'read', line: 3, field: 'y' },
      { id: 'o2', mode: 'read', line: 3, field: 'val' },
    ]);
    expect(accessTargets(scene, event)).toEqual([{ id: 'o1', row: 1, mode: 'read', exact: true }]);
  });

  it('keeps every old behaviour: no field, no ring, and the cap still holds', () => {
    const many = handBuilt({ o1: dict }, { o1: cardBox('o1') }, ['a', 1, true].map((key) => ({ id: 'o1', mode: 'read' as const, line: 3, key })));
    expect(accessTargets(many.scene, many.event)).toHaveLength(ACCESS_RINGS);
  });
});
