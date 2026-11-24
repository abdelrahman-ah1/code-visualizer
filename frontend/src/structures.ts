// Pure structure analysis for Milestone 3. No React and no DOM here, so every rule can be unit tested.
//
// The job: read one trace snapshot and decide (a) which heap objects are linked-list nodes or
// arrays, (b) which "lane" (row) each structure sits in, and (c) where every box goes.
// Trace snapshots are never changed. Layout lives only in the Scene objects built here.
import type { HeapNode, Trace, TraceEvent, Value } from './types';

export const GEOM = { nodeW: 92, nodeH: 56, gap: 52, cell: 46, pad: 28, tagH: 34, belowH: 56 };
export const LANE_H = GEOM.tagH + GEOM.nodeH + GEOM.belowH;
const POCKET = 12; // distance from a node's right edge to the centre of its link dot

export interface Box { id: string; kind: 'node' | 'array'; x: number; y: number; w: number; h: number; lane: number }
// An arrow from one box (and, for arrays, one cell) to another drawn box.
export interface Link { from: string; cell?: number; to: string }
export interface SceneLane {
  lane: number; row: number; kind: 'list' | 'array'; ids: string[]; type: string;
  // list only: how the last node ends. 'null' = link is None; 'cycle' = points back into this chain;
  // 'join' = points into another chain; 'none' = no link field value we can draw.
  end?: 'null' | 'cycle' | 'join' | 'none'; endTo?: string;
}
export interface Scene {
  lanes: SceneLane[]; boxes: Record<string, Box>; links: Link[];
  tags: Record<string, string[]>;   // heap id -> variable names pointing at it
  nulls: string[];                  // variables currently None
  undrawn: { id: string; type: string }[]; // heap objects this view does not draw (see the Heap panel)
  width: number; height: number;
}

export const ARRAY_TYPES = ['list', 'tuple', 'array', 'std::vector']; // M5 adds the two C++ kinds
const isArray = (n: HeapNode) => !!n.items && ARRAY_TYPES.includes(n.type);
const sameTypeRef = (heap: Record<string, HeapNode>, from: HeapNode, v: Value | undefined): string | null =>
  v && v.kind === 'ref' && heap[v.id]?.fields && heap[v.id].type === from.type ? v.id : null;

// Which field links nodes of each object type? "next" wins by name. Otherwise a type with exactly one
// same-type reference field is a list. Two or more such fields (left/right) looks like a tree: not drawn in M3.
export function linkFieldsByType(heap: Record<string, HeapNode>): Map<string, string> {
  const named = new Set<string>(), counts = new Map<string, Map<string, number>>();
  for (const n of Object.values(heap)) {
    if (!n.fields) continue;
    if (Object.hasOwn(n.fields, 'next')) named.add(n.type);
    for (const [k, v] of Object.entries(n.fields)) {
      if (sameTypeRef(heap, n, v) === null) continue;
      const m = counts.get(n.type) ?? new Map<string, number>(); m.set(k, (m.get(k) ?? 0) + 1); counts.set(n.type, m);
    }
  }
  const out = new Map<string, string>();
  for (const t of named) out.set(t, 'next');
  for (const [t, m] of counts) if (!out.has(t) && m.size === 1) out.set(t, [...m.keys()][0]);
  return out;
}

export interface LayoutState { laneOf: Map<string, number>; headOf: Map<number, string>; rank: Map<string, number> }
export const newLayoutState = (): LayoutState => ({ laneOf: new Map(), headOf: new Map(), rank: new Map() });

interface Structure { kind: 'list' | 'array'; ids: string[]; type: string; end?: SceneLane['end']; endTo?: string }

export const arrayOmitted = (n: HeapNode) => {
  const shown = n.items?.length ?? 0;
  return Math.max(0, (n.length ?? shown) - shown, n.truncated && (n.length ?? 0) <= shown ? 1 : 0);
};

export function buildScene(event: TraceEvent, state: LayoutState): Scene {
  const heap = event.heap, ids = Object.keys(heap);
  // First-seen order keeps lane choice deterministic. IDs are encounter order, but we do not rely on that.
  for (const id of ids) if (!state.rank.has(id)) state.rank.set(id, state.rank.size);
  const rank = (id: string) => state.rank.get(id) ?? 0;
  const linkField = linkFieldsByType(heap);
  const field = (id: string) => linkField.get(heap[id].type);
  const listNodes = ids.filter((id) => { const f = field(id); return !!f && !!heap[id].fields && Object.hasOwn(heap[id].fields!, f); });
  const succ = (id: string) => sameTypeRef(heap, heap[id], heap[id].fields?.[field(id)!]);
  const nullEnd = (id: string) => { const v = heap[id].fields?.[field(id)!]; return v?.kind === 'scalar' && v.value === null; };

  const indeg = new Map<string, number>(listNodes.map((id) => [id, 0]));
  for (const id of listNodes) { const s = succ(id); if (s !== null && indeg.has(s)) indeg.set(s, indeg.get(s)! + 1); }
  const seen = new Set<string>(), structures: Structure[] = [];
  const walk = (start: string) => {
    const chain: string[] = [], inChain = new Set<string>();
    let cur: string | null = start, end: Structure['end'] = 'none', endTo: string | undefined;
    while (cur !== null) {
      if (inChain.has(cur)) { end = 'cycle'; endTo = cur; break; }
      if (seen.has(cur)) { end = 'join'; endTo = cur; break; }
      inChain.add(cur); chain.push(cur);
      const next = succ(cur);
      if (next === null || !indeg.has(next)) { end = nullEnd(cur) ? 'null' : 'none'; break; }
      cur = next;
    }
    chain.forEach((c) => seen.add(c));
    structures.push({ kind: 'list', ids: chain, type: heap[start].type, end, endTo });
  };
  // Heads first (nothing points at them), then anything left over is a pure cycle.
  for (const id of listNodes.filter((n) => indeg.get(n) === 0).sort((a, b) => rank(a) - rank(b))) walk(id);
  for (const id of listNodes.slice().sort((a, b) => rank(a) - rank(b))) if (!seen.has(id)) walk(id);
  for (const id of ids) if (isArray(heap[id])) structures.push({ kind: 'array', ids: [id], type: heap[id].type });
  structures.sort((a, b) => Math.min(...a.ids.map(rank)) - Math.min(...b.ids.map(rank)));

  // Lane assignment: a structure keeps a lane one of its members already had, so rows do not shuffle.
  // When a list splits, the half that still starts at the lane's old head keeps the lane.
  const claimed = new Set<number>(), laneFor: number[] = new Array(structures.length);
  const claim = (i: number, lane: number) => { claimed.add(lane); laneFor[i] = lane; state.headOf.set(lane, structures[i].ids[0]); for (const id of structures[i].ids) state.laneOf.set(id, lane); };
  structures.forEach((st, i) => { const l = state.laneOf.get(st.ids[0]); if (l !== undefined && state.headOf.get(l) === st.ids[0] && !claimed.has(l)) claim(i, l); });
  structures.forEach((st, i) => {
    if (laneFor[i] !== undefined) return;
    const wanted = [...new Set(st.ids.map((id) => state.laneOf.get(id)).filter((l): l is number => l !== undefined))].sort((a, b) => a - b);
    let lane = wanted.find((l) => !claimed.has(l));
    if (lane === undefined) { lane = 0; while (claimed.has(lane)) lane++; }
    claim(i, lane);
  });
  // Rows are the occupied lanes in order. A row closes up only when its whole structure disappears.
  const occupied = [...claimed].sort((a, b) => a - b), rowOf = new Map(occupied.map((l, i) => [l, i]));
  const boxes: Record<string, Box> = {}, lanes: SceneLane[] = [];
  let width = 320;
  structures.forEach((s, i) => {
    const lane = laneFor[i], row = rowOf.get(lane)!, y = row * LANE_H + GEOM.tagH;
    lanes.push({ lane, row, kind: s.kind, ids: s.ids, type: s.type, end: s.end, endTo: s.endTo });
    if (s.kind === 'list') {
      s.ids.forEach((id, k) => { boxes[id] = { id, kind: 'node', x: GEOM.pad + k * (GEOM.nodeW + GEOM.gap), y, w: GEOM.nodeW, h: GEOM.nodeH, lane }; });
      width = Math.max(width, GEOM.pad * 2 + s.ids.length * (GEOM.nodeW + GEOM.gap));
    } else {
      const node = heap[s.ids[0]], cells = (node.items?.length ?? 0) + (arrayOmitted(node) > 0 ? 1 : 0);
      boxes[s.ids[0]] = { id: s.ids[0], kind: 'array', x: GEOM.pad, y, w: Math.max(1, cells) * GEOM.cell, h: GEOM.cell, lane };
      width = Math.max(width, GEOM.pad * 2 + Math.max(1, cells) * GEOM.cell);
    }
  });

  const links: Link[] = [];
  for (const id of listNodes) { const s = succ(id); if (s !== null && boxes[id] && boxes[s]) links.push({ from: id, to: s }); }
  for (const id of ids) {
    const n = heap[id];
    if (!isArray(n) || !boxes[id]) continue;
    n.items!.forEach((v, cell) => { if (v.kind === 'ref' && boxes[v.id]) links.push({ from: id, cell, to: v.id }); });
  }

  const tags: Record<string, string[]> = {}, nulls: string[] = [];
  for (const f of event.frames) for (const [name, v] of Object.entries(f.locals)) {
    const label = f.depth === 0 ? name : `${f.function}:${name}`;
    if (v.kind === 'ref' && boxes[v.id]) (tags[v.id] ??= []).push(label);
    else if (v.kind === 'scalar' && v.value === null && !nulls.includes(label)) nulls.push(label);
  }
  const undrawn = ids.filter((id) => !boxes[id]).map((id) => ({ id, type: heap[id].type }));
  return { lanes, boxes, links, tags, nulls, undrawn, width, height: Math.max(1, occupied.length) * LANE_H + 12 };
}

// All scenes for a trace, built once in order so lane choices carry forward. Stepping backward just indexes this array.
export function buildScenes(trace: Trace): Scene[] {
  const state = newLayoutState();
  return trace.events.map((e) => buildScene(e, state));
}

// Short text for a value inside a box.
export function fmt(v: Value, max = 9): string {
  const clip = (s: string) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
  switch (v.kind) {
    case 'scalar': return v.value === null ? 'None' : typeof v.value === 'boolean' ? (v.value ? 'True' : 'False') : typeof v.value === 'string' ? clip(JSON.stringify(v.value)) : clip(String(v.value));
    case 'ref': return `→ ${v.id}`;
    case 'opaque': return clip(v.type);
    case 'truncated': return '…';
  }
}

// What a list node shows: one main value and up to a few smaller "name: value" lines. The link field is the arrow.
export function nodeDisplay(node: HeapNode, linkField: string | undefined) {
  const entries = Object.entries(node.fields ?? {}).filter(([k]) => k !== linkField);
  const mainIndex = Math.max(0, entries.findIndex(([k, v]) => ['value', 'val', 'data', 'key'].includes(k) && v.kind === 'scalar'));
  const main = entries[mainIndex], rest = entries.filter((_, i) => i !== mainIndex);
  return { main: main ? fmt(main[1]) : '', rest: rest.slice(0, 2).map(([k, v]) => `${k}: ${fmt(v, 7)}`) };
}

// Cell index in an array box to the x centre of that cell.
export const cellCentre = (cell: number) => cell * GEOM.cell + GEOM.cell / 2;

// SVG path for one arrow, in the coordinate space of its source box (so the arrow travels with its source).
export function linkPath(link: Link, boxes: Record<string, Box>): string | null {
  const a = boxes[link.from], b = boxes[link.to];
  if (!a || !b) return null;
  const dx = b.x - a.x, dy = b.y - a.y;
  const start = a.kind === 'node' ? { x: a.w - POCKET, y: a.h / 2 } : { x: cellCentre(link.cell ?? 0), y: a.h + 20 };
  // Straight arrow: next node sits directly to the right in the same row.
  if (a.kind === 'node' && b.kind === 'node' && dy === 0 && dx === a.w + GEOM.gap) return `M ${start.x} ${start.y} L ${dx - 2} ${start.y}`;
  const below = a.kind === 'node' ? { x: a.w - POCKET, y: a.h } : start;
  const tx = b.kind === 'node' ? dx + b.w / 2 : dx + GEOM.cell / 2;
  if (dy > 0) {
    // Target row is lower: enter from the top. If rows sit in between, bow out to the right of them so the arrow does not cross them.
    const between = Object.values(boxes).filter((o) => o.y > a.y && o.y < b.y);
    const reach = Math.max(0, ...between.map((o) => o.x + o.w - a.x)), out = reach > 0 ? Math.max(below.x, tx, (reach + 24 - 0.25 * below.x) / 0.75) : 0;
    if (out > 0) return `M ${below.x} ${below.y} C ${out} ${below.y + 30}, ${out} ${dy - 34}, ${tx} ${dy - 3}`;
    return `M ${below.x} ${below.y} C ${below.x} ${below.y + 30}, ${tx} ${dy - 34}, ${tx} ${dy - 3}`;
  }
  const ty = dy + b.h + 3, bend = 40; // same row or higher: loop under and come up into the target's bottom edge
  return `M ${below.x} ${below.y} C ${below.x} ${below.y + bend}, ${tx} ${ty + bend}, ${tx} ${ty}`;
}

// Heap ids whose own data differs from the previous snapshot, plus ids that are new. Used for highlighting only.
export function changedBetween(prev: TraceEvent | undefined, cur: TraceEvent): { changed: Set<string>; added: Set<string> } {
  const changed = new Set<string>(), added = new Set<string>();
  if (!prev) return { changed, added };
  for (const [id, node] of Object.entries(cur.heap)) {
    const before = prev.heap[id];
    if (!before) added.add(id);
    else if (JSON.stringify(before) !== JSON.stringify(node)) changed.add(id);
  }
  return { changed, added };
}

// Plain-text version of each lane, for screen readers and for tests: "3 → 2 → 1 → None".
export function laneSummary(lane: SceneLane, event: TraceEvent, scene: Scene): string {
  const heap = event.heap, tag = (id: string) => (scene.tags[id]?.length ? ` (${scene.tags[id].join(', ')})` : '');
  if (lane.kind === 'array') {
    const n = heap[lane.ids[0]], om = arrayOmitted(n);
    return `${n.type} ${lane.ids[0]}${tag(lane.ids[0])}: [${(n.items ?? []).map((v) => fmt(v, 12)).join(', ')}${om ? `, … ${om} more omitted` : ''}]`;
  }
  const linkField = linkFieldsByType(heap).get(lane.type);
  const parts = lane.ids.map((id) => `${nodeDisplay(heap[id], linkField).main}${tag(id)}`);
  const end = lane.end === 'null' ? 'None' : lane.end === 'cycle' ? `back to ${nodeDisplay(heap[lane.endTo!], linkField).main}` : lane.end === 'join' ? `joins ${lane.endTo}` : 'end';
  return `${lane.type} list ${lane.ids[0]}: ${[...parts, end].join(' → ')}`;
}
