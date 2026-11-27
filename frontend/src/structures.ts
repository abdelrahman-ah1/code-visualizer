// Pure structure analysis for Milestone 3. No React and no DOM here, so every rule can be unit tested.
//
// The job: read one trace snapshot and decide (a) which heap objects are linked-list nodes or
// arrays, (b) which "lane" (row) each structure sits in, and (c) where every box goes.
// Trace snapshots are never changed. Layout lives only in the Scene objects built here.
import type { HeapNode, Trace, TraceEvent, Value } from './types';
import { layeredLayout, stabilize } from './graphlayout';

export const GEOM = { nodeW: 124, nodeH: 56, gap: 52, cell: 46, pad: 28, tagH: 34, belowH: 56 };
export const LANE_H = GEOM.tagH + GEOM.nodeH + GEOM.belowH;
const POCKET = 15; // distance from a node's right edge to the centre of its link dot

export interface Box { id: string; kind: 'node' | 'array' | 'card'; x: number; y: number; w: number; h: number; lane: number; mainH?: number; rec?: boolean; vertex?: boolean; circle?: boolean; stack?: boolean; queue?: boolean }   // circle: an adjacency-graph vertex, drawn as a circle labelled by index; stack/queue: cell strip drawn as a vertical stack / marked queue
// An arrow from one box (and, for arrays, one cell) to another drawn box.
export interface Link { from: string; cell?: number; to: string; port?: { x: number; y: number };
  // M6 graph edges: a finished path (in the source box's coordinates), whether the line has a head at both ends
  // (the two vertices point at each other), and a multiplicity label when the same edge is stored more than once.
  d?: string; both?: boolean; label?: string; mid?: { x: number; y: number } }
// General object card: every captured object that is not a list node or array is drawn as a card of rows.
export const CARD = { w: 138, head: 25, row: 16, pad: 5, gap: 16 };
export interface CardRow { label: string; value: Value | null; note?: string }
export function cardRows(n: HeapNode): CardRow[] {
  const rows: CardRow[] = [];
  for (const [k, v] of Object.entries(n.fields ?? {})) rows.push({ label: k, value: v });
  (n.items ?? []).forEach((v, i) => rows.push({ label: `[${i}]`, value: v }));
  for (const [k, v] of n.entries ?? []) rows.push({ label: fmt(k, 10), value: v });
  const om = arrayOmitted(n); if (om > 0) rows.push({ label: '…', value: null, note: `${om} more not captured` });
  if (n.opaque) rows.push({ label: '', value: null, note: n.type.endsWith('(buffer released)') ? 'buffer released' : 'contents not captured' });
  if (!rows.length) rows.push({ label: '', value: null, note: 'empty' });
  return rows;
}
export const cardHeight = (n: HeapNode) => CARD.head + cardRows(n).length * CARD.row + CARD.pad;

// Compartment records (list nodes and plain objects): data in the main box, every pointer field in its own compartment.
// The first pointer sits in a compartment on the right (the chain link for lists), each further pointer in a strip underneath.
export const REC = { mainW: 84, ptrW: 40, strip: 22, minMainH: 56, line: 13 };
export const isPointer = (v: Value) => v.kind === 'ref' || (v.kind === 'scalar' && v.value === null && (/\*$/.test(v.type) || v.type === 'NoneType'));
export interface RecSplit { main: [string, Value] | null; rest: [string, Value][]; moreData: number; side: [string, Value] | null; under: [string, Value][] }
const MAIN_NAMES = ['value', 'val', 'data', 'key'];
export function splitFields(node: HeapNode, chainField?: string): RecSplit {
  const all = Object.entries(node.fields ?? {});
  const ptrs = all.filter(([, v]) => isPointer(v)), data = all.filter(([, v]) => !isPointer(v));
  const sideAt = Math.max(0, ptrs.findIndex(([k]) => k === chainField));
  const side = ptrs.length ? ptrs[sideAt] : null, under = ptrs.filter((_, i) => i !== sideAt);
  const mi = Math.max(0, data.findIndex(([k, v]) => MAIN_NAMES.includes(k) && v.kind === 'scalar'));
  const main = data[mi] ?? null, restAll = data.filter((_, i) => i !== mi);
  return { main, rest: restAll.slice(0, 3), moreData: restAll.length - Math.min(3, restAll.length), side, under };
}
export interface RecGeom { w: number; h: number; mainH: number; split: RecSplit }
export function recGeom(node: HeapNode, chainField?: string): RecGeom {
  const sp = splitFields(node, chainField), lines = sp.rest.length + (sp.moreData > 0 ? 1 : 0);
  const mainH = Math.max(REC.minMainH, 30 + lines * REC.line);
  return { w: REC.mainW + (sp.side ? REC.ptrW : 0), h: mainH + sp.under.length * REC.strip, mainH, split: sp };
}
// Where the arrow for one pointer field leaves the record (box-local coordinates).
export function recPort(g: RecGeom, key: string): { x: number; y: number } | null {
  if (g.split.side?.[0] === key) return { x: g.w - REC.ptrW / 2, y: g.mainH / 2 + 4 };
  const i = g.split.under.findIndex(([k]) => k === key);
  return i < 0 ? null : { x: g.w - 14, y: g.mainH + i * REC.strip + REC.strip / 2 };
}
export const isRecord = (n: HeapNode) => !!n.fields && !n.opaque && !n.freed && !n.items && !n.entries;
export const portY = (row: number) => CARD.head + row * CARD.row + CARD.row / 2;
export interface SceneLane {
  lane: number; row: number; kind: 'list' | 'array'; ids: string[]; type: string;
  // list only: how the last node ends. 'null' = link is None; 'cycle' = points back into this chain;
  // 'join' = points into another chain; 'none' = no link field value we can draw.
  end?: 'null' | 'cycle' | 'join' | 'none'; endTo?: string;
}
export interface Scene {
  lanes: SceneLane[]; boxes: Record<string, Box>; links: Link[];
  tags: Record<string, string[]>;   // heap id -> variable names pointing at it
  nulls: string[];                  // variables currently null
  graph?: GraphSpec;
  adjGroups?: AdjGroup[];           // adjacency-list graphs drawn as circles (vertices are synthetic ids, not heap objects)
  cards: string[];                  // ids drawn as general object cards
  undrawn: { id: string; type: string }[]; // heap objects this view does not draw (see the Heap panel)
  width: number; height: number;
}

export const ARRAY_TYPES = ['list', 'tuple', 'array', 'std::vector', 'deque', 'std::queue', 'std::stack', 'std::priority_queue']; // M5 adds the two C++ kinds; M6 adds the queue/stack families
// Queue and stack are decided by exact type name only (rule A: the tracer named it, believe the name). Anything else with
// items keeps the plain strip; std::priority_queue has items in heap order, so it stays a plain strip on purpose.
export const QUEUE_TYPES = ['deque', 'std::queue'];
export const STACK_TYPES = ['std::stack'];
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

export interface LayoutState { laneOf: Map<string, number>; headOf: Map<number, string>; rank: Map<string, number>;
  tx: Map<string, number>; gx: Map<string, number>; tOrigin?: number; gOrigin?: number; gaOrigin?: number;
  graphTypes?: Map<string, string[]>;   // types that are neighbour-list graph vertices at some point in this trace (type -> list fields), so they are drawn as vertices from the first event   // M6: remembered tree and graph x positions (slot units) by object id
  adjOf?: Map<string, 0 | 1> }          // array ids that are adjacency lists at some point in this trace, with their index base, so they are drawn as graphs from the first event
export const newLayoutState = (): LayoutState => ({ laneOf: new Map(), headOf: new Map(), rank: new Map(), tx: new Map(), gx: new Map() });
export const cloneLayoutState = (st: LayoutState): LayoutState => ({ laneOf: new Map(st.laneOf), headOf: new Map(st.headOf), rank: new Map(st.rank), tx: new Map(st.tx), gx: new Map(st.gx), tOrigin: st.tOrigin, gOrigin: st.gOrigin, gaOrigin: st.gaOrigin, graphTypes: st.graphTypes, adjOf: st.adjOf });

interface Structure { kind: 'list' | 'array'; ids: string[]; type: string; end?: SceneLane['end']; endTo?: string }

export const arrayOmitted = (n: HeapNode) => {
  const shown = n.items?.length ?? 0;
  return Math.max(0, (n.length ?? shown) - shown, n.truncated && (n.length ?? 0) <= shown ? 1 : 0);
};


// ---- Adjacency-list graphs (index-based) -----------------------------------------------------------------------------
// An array whose items are all arrays of ints, every int a valid index into the outer array, is a graph: circles labelled
// by index, arrows from the inner lists. The outer array and its inner lists leave the diagram (they stay in the Heap panel).
// Strict rules, plain list view on ANY doubt: a uniform numeric rectangle is a matrix, not a graph; a row shared with another
// variable or cut off by the recording limits disqualifies the whole candidate. 1-based only when 0 appears nowhere and the
// largest value equals n exactly. Caps keep huge graphs in the list view. No tracer or trace-format change: list[list[int]]
// and vector<vector<int>> already record as arrays of arrays.
const INT_TYPE = /^(int|unsigned|unsigned int|long|long long|unsigned long|unsigned long long|short|unsigned short|size_t|u?int(8|16|32|64)(_t)?)$/;
export const isIntScalar = (v: Value) => v.kind === 'scalar' && typeof v.value === 'number' && Number.isInteger(v.value) && INT_TYPE.test(v.type);
export const ADJ_LIMITS = { vertices: 60, edges: 300 };
export interface AdjSpec { outer: string; base: 0 | 1; n: number; lists: string[]; rows: number[][] }   // rows: raw index values per vertex
export interface AdjGroup { outer: string; label: string; vertices: string[] }   // label: variable names + recorded type, for the group caption

export function adjacencySpec(event: TraceEvent, known?: Map<string, 0 | 1>): AdjSpec[] {
  const heap = event.heap, out: AdjSpec[] = [];
  const refs = new Map<string, number>();
  const bump = (v: Value) => { if (v.kind === 'ref') refs.set(v.id, (refs.get(v.id) ?? 0) + 1); };
  for (const n of Object.values(heap)) { Object.values(n.fields ?? {}).forEach(bump); (n.items ?? []).forEach(bump); (n.entries ?? []).forEach(([k, v]) => { bump(k); bump(v); }); }
  for (const f of event.frames) for (const v of Object.values(f.locals)) bump(v);
  for (const id of Object.keys(heap)) {
    const n = heap[id];
    if (!isArray(n) || !n.items || arrayOmitted(n) > 0) continue;      // cut-off rows: cannot verify every row
    const cnt = n.items.length;
    if (cnt < 2 || cnt > ADJ_LIMITS.vertices) continue;
    if (!n.items.every((r) => r.kind === 'ref' && r.id !== id)) continue;
    const lists = n.items.map((r) => (r as { kind: 'ref'; id: string }).id);
    if (new Set(lists).size !== lists.length) continue;                // the same row twice: aliasing we will not hide
    if (lists.some((l) => (refs.get(l) ?? 0) !== 1)) continue;         // a row is shared: it stays visible, like M6
    const inners = lists.map((l) => heap[l]);
    if (inners.some((a) => !a || !isArray(a) || !a.items || arrayOmitted(a) > 0)) continue;
    const lens = inners.map((a) => a.items!.length);
    if (lens.every((l) => l === lens[0]) && lens[0] > 1) continue;     // uniform rectangle 2+ wide: a matrix, not a graph (one index per row is a graph)
    if (inners.some((a) => !a.items!.every(isIntScalar))) continue;    // rows of anything but plain ints
    const rows = inners.map((a) => a.items!.map((v) => (v as { value: number }).value));
    const vals = rows.flat(), edgeCount = vals.length;
    if (edgeCount > ADJ_LIMITS.edges) continue;
    const kb = known?.get(id);
    let base: 0 | 1;
    if (kb !== undefined) {                                            // known from the trace scan: valid unless the values no longer fit its base
      if (!vals.every((v) => (kb === 0 ? v >= 0 && v < cnt : v >= 1 && v <= cnt))) continue;
      base = kb;
    } else if (vals.length === 0) continue;                            // all rows empty and never seen as a graph: nothing to detect from
    else if (vals.every((v) => v >= 0 && v < cnt)) base = 0;
    else if (vals.every((v) => v >= 1 && v <= cnt) && Math.max(...vals) === cnt) base = 1;
    else continue;
    out.push({ outer: id, base, n: cnt, lists, rows });
  }
  return out;
}

// Array ids that are adjacency lists in at least one event of the trace, with their base. Scanned once per trace (like
// graphTypesOf), so an adjacency list is drawn as a graph from the first event, while its rows are still empty.
export function adjacencyOf(trace: Trace): Map<string, 0 | 1> {
  const out = new Map<string, 0 | 1>();
  for (const e of trace.events) for (const s of adjacencySpec(e, out)) if (!out.has(s.outer)) out.set(s.outer, s.base);
  return out;
}

// ---- M6 graph mode -------------------------------------------------------------------------------------------------
// A type is drawn as graph vertices when one of its fields holds a neighbour list: a list/array that only this one field
// points at and whose items are all objects of the same type (or null). Node.neighbors, Node.children, vector<Node*> adj.
// The list itself is then not drawn as a box: its items become edges. It stays in the Heap panel, the vertex's tooltip names it, and a
// variable that points at it gets its name pill on the owning vertex. A list that two objects share is never hidden (the type then
// keeps the plain array/card view). Items the recording cut off are counted on the vertex, never dropped silently.
export interface GraphSpec { vertices: string[]; collapsed: Map<string, { owner: string; field: string }>; edgeFields: Map<string, string[]> }
export function graphSpec(event: TraceEvent, known?: Map<string, string[]>): GraphSpec {
  const heap = event.heap, refs = new Map<string, number>(), bump = (v: Value) => { if (v.kind === 'ref') refs.set(v.id, (refs.get(v.id) ?? 0) + 1); };
  for (const n of Object.values(heap)) { Object.values(n.fields ?? {}).forEach(bump); (n.items ?? []).forEach(bump); (n.entries ?? []).forEach(([k, v]) => { bump(k); bump(v); }); }
  const cand = new Map<string, { ok: boolean; any: boolean; arrs: [string, string][]; type: string; field: string }>();
  for (const [nid, n] of Object.entries(heap)) {
    if (!isRecord(n)) continue;
    for (const [k, v] of Object.entries(n.fields!)) {
      if (v.kind !== 'ref' || !heap[v.id] || !isArray(heap[v.id])) continue;
      const arr = heap[v.id], key = `${n.type}\u0000${k}`, c = cand.get(key) ?? cand.set(key, { ok: true, any: false, arrs: [], type: n.type, field: k }).get(key)!;
      const items = arr.items ?? [];
      const good = refs.get(v.id) === 1 && items.every((x) => (x.kind === 'ref' && !!heap[x.id] && isRecord(heap[x.id]) && heap[x.id].type === n.type) || (x.kind === 'scalar' && x.value === null) || x.kind === 'truncated');
      c.ok = c.ok && good; c.any = c.any || (good && items.some((x) => x.kind === 'ref')); c.arrs.push([v.id, nid]);
    }
  }
  const edgeFields = new Map<string, string[]>(), collapsed = new Map<string, { owner: string; field: string }>();
  for (const c of cand.values()) if (c.ok && (c.any || known?.get(c.type)?.includes(c.field))) { (edgeFields.get(c.type) ?? edgeFields.set(c.type, []).get(c.type)!).push(c.field); for (const [a, o] of c.arrs) collapsed.set(a, { owner: o, field: c.field }); }
  // A type that is a graph later in the trace is a vertex from the start (its lists are still empty, or not assigned yet), unless one of its lists is shared or mixed now.
  if (known) for (const [type, fields] of known) if (!edgeFields.has(type) && ![...cand.values()].some((c) => c.type === type && !c.ok)) edgeFields.set(type, fields);
  const vertices = Object.keys(heap).filter((id) => isRecord(heap[id]) && edgeFields.has(heap[id].type));
  return { vertices, collapsed, edgeFields };
}
const VERTEX = { w: 116, minH: 56, gapX: 44, gapY: 64 };
const VERTEX_MAIN = ['value', 'val', 'data', 'key', 'name', 'label', 'id'];
// What a vertex card shows: one main value, up to three other plain values. Pointer fields become the arrows.
export function vertexDisplay(node: HeapNode) {
  const data = Object.entries(node.fields ?? {}).filter(([, v]) => !isPointer(v) && v.kind !== 'ref');
  const mi = Math.max(0, data.findIndex(([k, v]) => VERTEX_MAIN.includes(k) && v.kind === 'scalar'));
  const main = data[mi] ?? null, restAll = data.filter((_, i) => i !== mi);
  return { main, rest: restAll.slice(0, 3), more: restAll.length - Math.min(3, restAll.length) };
}
// Neighbour-list items the recording did not capture (cut off by the tracer's depth or length limits), summed over a vertex's lists.
export function vertexCutOff(heap: Record<string, HeapNode>, id: string, spec: GraphSpec): number {
  let n = 0;
  for (const f of spec.edgeFields.get(heap[id].type) ?? []) { const v = heap[id].fields?.[f]; const arr = v?.kind === 'ref' ? heap[v.id] : undefined; if (arr) n += (arr.items ?? []).filter((x) => x.kind === 'truncated').length + arrayOmitted(arr); }
  return n;
}
export const vertexHeight = (node: HeapNode, cut = 0) => { const d = vertexDisplay(node); return Math.max(VERTEX.minH, 30 + (d.rest.length + (d.more > 0 ? 1 : 0) + (cut > 0 ? 1 : 0)) * 13); };
// Edges of one vertex, in field order: neighbour-list items first-to-last, then direct pointer fields to other vertices. Null slots are skipped.
export function vertexEdges(heap: Record<string, HeapNode>, id: string, spec: GraphSpec): string[] {
  const n = heap[id], out: string[] = [], listFields = new Set(spec.edgeFields.get(n.type) ?? []), vs = new Set(spec.vertices);
  for (const [k, v] of Object.entries(n.fields ?? {})) {
    if (v.kind !== 'ref') continue;
    if (listFields.has(k)) { const arr = heap[v.id]; if (arr?.items) for (const x of arr.items) if (x.kind === 'ref' && vs.has(x.id)) out.push(x.id); }
    else if (vs.has(v.id)) out.push(v.id);
  }
  return out;
}
// A pointer from a list cell, an object row or a record field into a graph vertex: out of the source, then down into the top of the vertex.
// Returns null when that curve would cross another box, so the caller keeps the obstacle router's path for it instead.
export function pointerToVertex(link: Link, boxes: Record<string, Box>): string | null {
  const a = boxes[link.from], b = boxes[link.to]; if (!a || !b) return null;
  const s: Pt = link.port ? { x: a.x + link.port.x, y: a.y + link.port.y } : a.kind === 'array' ? { x: a.x + cellAnchor(a, link.cell ?? 0).x, y: a.y + cellAnchor(a, link.cell ?? 0).y } : { x: a.x + a.w - POCKET, y: a.y + a.h };
  const e: Pt = { x: b.x + b.w / 2 + 16, y: b.y - 3 }, side = !!link.port && s.x >= a.x + a.w - 14 ? 40 : 0;
  const c1 = { x: s.x + side, y: s.y + (side ? 0 : 40) }, c2 = { x: e.x, y: e.y - 45 };
  const pts = [...Array(33)].map((_, i) => { const t = i / 32, u = 1 - t; return { x: u * u * u * s.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * e.x, y: u * u * u * s.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * e.y }; });
  if (Object.values(boxes).some((o) => o.id !== a.id && o.id !== b.id && pts.some((p) => inside(p, o, -3)))) return null;
  if (e.y < s.y + 12) return null;   // the vertex is not below the source: leave it to the router
  const L = (p: Pt) => `${Math.round((p.x - a.x) * 10) / 10} ${Math.round((p.y - a.y) * 10) / 10}`;
  return `M ${L(s)} C ${L(c1)}, ${L(c2)}, ${L(e)}`;
}
const clipToBox = (b: Box, tx: number, ty: number, margin: number, shiftX = 0): Pt => {   // point on b's border towards (tx, ty), pushed out by margin
  // The line is aimed from a point shifted right of the centre (clear of the variable-name pill), but it must still
  // stop `margin` outside the box itself. Shifting the whole rectangle instead left the arrow end up to 19 px off the border.
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2, hw = b.w / 2 + margin, hh = b.h / 2 + margin;
  const ox = cx + Math.max(-hw + 4, Math.min(hw - 4, shiftX)), dx = tx - ox, dy = ty - cy;
  if (!dx && !dy) return { x: cx, y: b.y };
  const t = Math.min(dx > 0 ? (cx + hw - ox) / dx : dx < 0 ? (cx - hw - ox) / dx : Infinity, dy > 0 ? hh / dy : dy < 0 ? -hh / dy : Infinity);
  return { x: ox + dx * t, y: cy + dy * t };
};
// A vertex-to-vertex edge: a straight line from border to border; when it would cross another box it bends (a quadratic curve) the
// smallest amount that clears every box. If nothing clears, the straight line stays.
export function edgePath(a: Box, b: Box, boxes: Box[], both: boolean): { d: string; mid: Pt } {
  const ca = { x: a.x + a.w / 2, y: a.y + a.h / 2 }, cb = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const local = (p: Pt) => `${Math.round((p.x - a.x) * 10) / 10} ${Math.round((p.y - a.y) * 10) / 10}`;
  const others = boxes.filter((o) => o.id !== a.id && o.id !== b.id);
  const clear = (pts: Pt[]) => !others.some((o) => pts.some((p) => inside(p, o, -3)));
  const s0 = clipToBox(a, cb.x, cb.y, both ? 3 : 1), e0 = clipToBox(b, ca.x, ca.y, 3, 16);   // arrows land a little right of centre, clear of the variable-name pill above a box's left side
  const straight = [...Array(25)].map((_, i) => ({ x: s0.x + (e0.x - s0.x) * i / 24, y: s0.y + (e0.y - s0.y) * i / 24 }));
  if (clear(straight)) return { d: `M ${local(s0)} L ${local(e0)}`, mid: { x: (s0.x + e0.x) / 2 - a.x, y: (s0.y + e0.y) / 2 - a.y } };
  const len = Math.hypot(cb.x - ca.x, cb.y - ca.y) || 1, nx = -(cb.y - ca.y) / len, ny = (cb.x - ca.x) / len, mx = (ca.x + cb.x) / 2, my = (ca.y + cb.y) / 2;
  for (const f of [0.18, -0.18, 0.3, -0.3, 0.45, -0.45, 0.65, -0.65]) {
    const c = { x: mx + nx * len * f * 2, y: my + ny * len * f * 2 };   // control point; the curve passes about half that far out
    const s = clipToBox(a, c.x, c.y, both ? 3 : 1), e = clipToBox(b, c.x, c.y, 3);
    const pts = [...Array(25)].map((_, i) => { const t = i / 24, u = 1 - t; return { x: u * u * s.x + 2 * u * t * c.x + t * t * e.x, y: u * u * s.y + 2 * u * t * c.y + t * t * e.y }; });
    if (clear(pts)) return { d: `M ${local(s)} Q ${local(c)} ${local(e)}`, mid: { x: pts[12].x - a.x, y: pts[12].y - a.y } };
  }
  return { d: `M ${local(s0)} L ${local(e0)}`, mid: { x: (s0.x + e0.x) / 2 - a.x, y: (s0.y + e0.y) / 2 - a.y } };
}

// One line per pair of vertices. Two vertices that point at each other share one line with a head at both ends; a line
// with one head is a one-way edge. A vertex that points at itself gets a small loop out of its right side.
function graphLinksFor(vids: string[], edges: Map<string, string[]>, count: Map<string, number>, rank: (id: string) => number, boxes: Record<string, Box>): Link[] {
  const links: Link[] = [], allBoxes = Object.values(boxes), done = new Set<string>();
  for (const a of vids) for (const t of edges.get(a)!) {
    const key = [a, t].sort().join('|'); if (done.has(key)) continue; done.add(key);
    const rev = edges.get(t)!.includes(a), ab = count.get(`${a}|${t}`) ?? 0, ba = count.get(`${t}|${a}`) ?? 0;
    const [from, to] = rank(a) <= rank(t) || !rev ? [a, t] : [t, a], both = rev;
    const { d, mid } = edgePath(boxes[from], boxes[to], allBoxes, both);
    const label = both ? (ab > 1 || ba > 1 ? `×${from === a ? ab : ba} ×${from === a ? ba : ab}` : undefined) : (ab > 1 ? `×${ab}` : undefined);
    links.push({ from, to, d, both, label, mid });
  }
  for (const v of vids) if (count.get(`${v}|${v}`)) {
    const b = boxes[v];
    links.push({ from: v, to: v, d: `M ${b.w + 1} ${b.h * 0.3} C ${b.w + 40} ${b.h * 0.3 - 14}, ${b.w + 40} ${b.h * 0.7 + 14}, ${b.w + 3} ${b.h * 0.7}`, label: count.get(`${v}|${v}`)! > 1 ? `×${count.get(`${v}|${v}`)}` : undefined, mid: { x: b.w + 26, y: b.h * 0.5 + 4 } });
  }
  return links;
}

export function buildScene(event: TraceEvent, state: LayoutState, extra?: Map<number, number>, route = true): Scene {
  const heap = event.heap, ids = Object.keys(heap);
  // First-seen order keeps lane choice deterministic. IDs are encounter order, but we do not rely on that.
  for (const id of ids) if (!state.rank.has(id)) state.rank.set(id, state.rank.size);
  const rank = (id: string) => state.rank.get(id) ?? 0;
  const gs = graphSpec(event, state.graphTypes), vertexSet = new Set(gs.vertices);
  const adjSpecs = adjacencySpec(event, state.adjOf), adjHidden = new Set(adjSpecs.flatMap((a) => [a.outer, ...a.lists]));
  const adjNameOf = new Map(adjSpecs.map((a) => [a.outer, [] as string[]]));
  for (const f of event.frames) for (const [name, v] of Object.entries(f.locals)) if (v.kind === 'ref' && adjNameOf.has(v.id)) adjNameOf.get(v.id)!.push(f.depth === 0 ? name : `${f.function}:${name}`);
  const linkField = linkFieldsByType(heap);
  const field = (id: string) => linkField.get(heap[id].type);
  const listNodes = ids.filter((id) => { const f = field(id); return !vertexSet.has(id) && !!f && !!heap[id].fields && Object.hasOwn(heap[id].fields!, f); });
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
  for (const id of ids) if (isArray(heap[id]) && !gs.collapsed.has(id) && !adjHidden.has(id)) structures.push({ kind: 'array', ids: [id], type: heap[id].type });
  // Arrays that hold pointers sit lowest, next to the objects they point at, so their arrows do not run across other arrays.
  // (An array whose pointers all lead to other arrays stays above them, so those arrows run downward.)
  const ptrMemo = new Map<Structure, number>();
  const ptrArray = (st: Structure) => { let v = ptrMemo.get(st); if (v === undefined) { v = st.kind === 'array' && (heap[st.ids[0]].items ?? []).some((x) => x.kind === 'ref' && !(heap[x.id] && isArray(heap[x.id]))) ? 1 : 0; ptrMemo.set(st, v); } return v; };
  structures.sort((a, b) => ptrArray(a) - ptrArray(b) || Math.min(...a.ids.map(rank)) - Math.min(...b.ids.map(rank)));

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
  const lanePtr = new Map<number, number>(structures.map((st, i) => [laneFor[i], ptrArray(st)])), occupied = [...claimed].sort((a, b) => (lanePtr.get(a) ?? 0) - (lanePtr.get(b) ?? 0) || a - b), rowOf = new Map(occupied.map((l, i) => [l, i]));
  const boxes: Record<string, Box> = {}, lanes: SceneLane[] = [];
  let width = 320;
  // A row is as tall as its tallest record (pointer strips make a node taller), never shorter than the standard lane.
  const geomOf = new Map<string, RecGeom>();
  const rowH: number[] = occupied.map(() => LANE_H);
  structures.forEach((st, i) => {
    if (st.kind !== 'list') return;
    for (const id of st.ids) geomOf.set(id, recGeom(heap[id], field(id)));
    const r = rowOf.get(laneFor[i])!;
    rowH[r] = Math.max(rowH[r], GEOM.tagH + Math.max(...st.ids.map((id) => geomOf.get(id)!.h)) + GEOM.belowH);
  });
  // A stack is a vertical column of cells: its row must be tall enough for every cell plus the labels.
  structures.forEach((st, i) => {
    if (st.kind !== 'array' || !STACK_TYPES.includes(heap[st.ids[0]].type)) return;
    const node = heap[st.ids[0]], cells = Math.max(1, (node.items?.length ?? 0) + (arrayOmitted(node) > 0 ? 1 : 0));
    const r = rowOf.get(laneFor[i])!;
    rowH[r] = Math.max(rowH[r], GEOM.tagH + cells * GEOM.cell + GEOM.belowH);
  });
  // Second pass only: rows whose re-routed arrows need a wider channel under them grow by that much.
  if (extra) for (const [lane, e] of extra) { const r = rowOf.get(lane); if (r !== undefined) rowH[r] += e; }
  const rowTop: number[] = []; rowH.reduce((acc, h, r) => { rowTop[r] = acc; return acc + h; }, 0);
  structures.forEach((s, i) => {
    const lane = laneFor[i], row = rowOf.get(lane)!, y = rowTop[row] + GEOM.tagH;
    lanes.push({ lane, row, kind: s.kind, ids: s.ids, type: s.type, end: s.end, endTo: s.endTo });
    if (s.kind === 'list') {
      let x = GEOM.pad;
      s.ids.forEach((id) => { const g = geomOf.get(id)!; boxes[id] = { id, kind: 'node', x, y, w: g.w, h: g.h, mainH: g.mainH, lane }; x += g.w + GEOM.gap; });
      width = Math.max(width, x - GEOM.gap + GEOM.pad + GEOM.gap);
    } else {
      const node = heap[s.ids[0]], cells = Math.max(1, (node.items?.length ?? 0) + (arrayOmitted(node) > 0 ? 1 : 0));
      const stack = STACK_TYPES.includes(node.type), queue = QUEUE_TYPES.includes(node.type);
      boxes[s.ids[0]] = { id: s.ids[0], kind: 'array', x: GEOM.pad, y, w: stack ? GEOM.cell : cells * GEOM.cell, h: stack ? cells * GEOM.cell : GEOM.cell, lane, ...(stack ? { stack: true } : {}), ...(queue ? { queue: true } : {}) };
      width = Math.max(width, GEOM.pad * 2 + (stack ? GEOM.cell : cells * GEOM.cell));
    }
  });

  const lanesH = Math.max(LANE_H, rowH.reduce((a, b) => a + b, 0)) + 12;
  const cardIds = ids.filter((id) => !boxes[id] && !vertexSet.has(id) && !gs.collapsed.has(id) && !adjHidden.has(id)).sort((a, b) => rank(a) - rank(b));
  const wrapW = Math.max(width, 1000);
  // With a tree, plain object cards (like the table that owns the arrays) go in a band just above the arrays that hold pointers,
  // so their arrows drop onto the array without crossing the arrows that leave it. Arrays without pointers stay above the band.
  const firstPtrRow = occupied.findIndex((l) => lanePtr.get(l) === 1);
  const above = firstPtrRow >= 0 && Object.keys(heap).some((id) => isRecord(heap[id]) && !boxes[id] && Object.values(heap[id].fields ?? {}).some((v) => v.kind === 'ref' && heap[v.id] && isArray(heap[v.id]) && boxes[v.id]));
  const splitY = above ? rowTop[firstPtrRow] : 0;
  let cx = GEOM.pad, cy = (above ? splitY : occupied.length ? lanesH : 0) + GEOM.tagH, crow = 0, totalH = lanesH;
  // Record cards that point at records of their own type (tree nodes) are laid out as a tree: children
  // below parents, roots in the order the arrays point at them, so lines do not cross.
  const cardSet = new Set(cardIds), kidsOf = new Map<string, string[]>(), hasParent = new Set<string>();
  for (const id of cardIds) {
    if (!isRecord(heap[id])) continue;
    const kids = Object.values(heap[id].fields ?? {}).filter((v) => v.kind === 'ref' && cardSet.has(v.id) && v.id !== id && heap[v.id].type === heap[id].type).map((v) => (v as { id: string }).id);
    kidsOf.set(id, kids); kids.forEach((k) => hasParent.add(k));
  }
  const sameTypeKids = (id: string) => kidsOf.get(id) ?? [];
  const treeTypes = new Set(cardIds.filter((id) => sameTypeKids(id).length > 0 || hasParent.has(id)).map((id) => heap[id].type));
  const isTreeNode = (id: string) => isRecord(heap[id]) && !boxes[id] && treeTypes.has(heap[id].type);
  const treeIds = cardIds.filter(isTreeNode);
  const treeSet = new Set(treeIds);
  const flatIds = cardIds.filter((id) => !treeSet.has(id));
  const placeTree = (x0: number, y0: number) => {
    const has = new Set<string>(); treeIds.forEach((id) => sameTypeKids(id).forEach((k) => has.add(k)));
    const arrOrder = new Map<string, number>(); let ai = 0;
    for (const id of ids) if (isArray(heap[id])) for (const v of heap[id].items ?? []) if (v.kind === 'ref' && !arrOrder.has(v.id)) arrOrder.set(v.id, ai++);
    const roots = treeIds.filter((id) => !has.has(id)).sort((a, b) => (arrOrder.get(a) ?? 1e6) - (arrOrder.get(b) ?? 1e6) || rank(a) - rank(b));
    const placed = new Set<string>(), pos = new Map<string, { x: number; d: number }>(); let leaf = 0, maxD = 0;
    const slot = Math.max(...treeIds.map((id) => recGeom(heap[id]).w)) + 28;
    const visit = (id: string, d: number): number => {
      placed.add(id); maxD = Math.max(maxD, d);
      const kids = sameTypeKids(id).filter((k) => treeSet.has(k) && !placed.has(k));
      const xs = kids.map((k) => visit(k, d + 1));
      const x = xs.length ? (Math.min(...xs) + Math.max(...xs)) / 2 : leaf++;
      pos.set(id, { x, d }); return x;
    };
    for (const r of [...roots, ...treeIds]) if (!placed.has(r)) visit(r, 0);   // anything left (a cycle) starts its own tree
    const rowTall = Math.max(...treeIds.map((id) => recGeom(heap[id]).h)) + 82;
    // M6: positions are remembered by object id. A node keeps its place unless the fresh tidy layout wants it more than half a slot away
    // (or two nodes in a row would touch), so growing or rotating a tree moves as few nodes as it can while parents stay near their children.
    const sx = stabilize(pos, state.tx), lo = Math.min(...sx.values());
    let origin = state.tOrigin ?? lo; if (lo < origin || lo - origin > 2) origin = lo; state.tOrigin = origin;
    for (const id of treeIds) { const g = recGeom(heap[id]), q = { x: sx.get(id)! - origin, d: pos.get(id)!.d }; boxes[id] = { id, kind: 'card', x: x0 + q.x * slot, y: y0 + q.d * rowTall, w: g.w, h: g.h, lane: -1, rec: true, mainH: g.mainH }; geomOf.set(id, g); }
    width = Math.max(width, x0 + (Math.max(...sx.values()) - origin) * slot + slot + GEOM.pad);
    totalH = Math.max(totalH, y0 + (maxD + 1) * rowTall);
  };
  for (const id of flatIds) {
    const rec = isRecord(heap[id]) ? recGeom(heap[id]) : null, h = rec ? rec.h : cardHeight(heap[id]), cw = rec ? rec.w : CARD.w;
    if (cx > GEOM.pad && cx + cw > wrapW) { cx = GEOM.pad; cy += crow + CARD.gap + GEOM.tagH - 8; crow = 0; }
    boxes[id] = { id, kind: 'card', x: cx, y: cy, w: cw, h, lane: -1, ...(rec ? { rec: true, mainH: rec.mainH } : {}) };
    if (rec) geomOf.set(id, rec);
    cx += cw + CARD.gap; crow = Math.max(crow, h); width = Math.max(width, cx - CARD.gap + GEOM.pad); totalH = cy + crow + GEOM.belowH / 2;
  }
  if (above && (treeIds.length || flatIds.length)) {
    const bandH = cy + crow + GEOM.belowH / 2 - splitY;
    for (const b of Object.values(boxes)) if (b.kind !== 'card' && b.y >= splitY) b.y += bandH;
    totalH = bandH + lanesH;
    if (treeIds.length) placeTree(GEOM.pad, bandH + lanesH + GEOM.tagH);
  } else if (treeIds.length) placeTree(flatIds.length ? cx : GEOM.pad, (occupied.length ? lanesH : 0) + GEOM.tagH);
  if (!treeIds.length) { state.tx.clear(); state.tOrigin = undefined; }

  // M6 graph mode: vertices in layers (distance from a root), crossings reduced, positions remembered by id.
  const graphLinks: Link[] = [];
  if (gs.vertices.length) {
    const vids = gs.vertices.slice().sort((a, b) => rank(a) - rank(b)), vset = new Set(vids);
    const edges = new Map<string, string[]>(), count = new Map<string, number>();
    for (const v of vids) {
      const targets = vertexEdges(heap, v, gs);
      for (const t of targets) count.set(`${v}|${t}`, (count.get(`${v}|${t}`) ?? 0) + 1);
      edges.set(v, [...new Set(targets)].filter((t) => t !== v && vset.has(t)));
    }
    const fresh = layeredLayout({ ids: vids, out: edges });
    const sx = stabilize(fresh, state.gx), lo = Math.min(...sx.values());
    let origin = state.gOrigin ?? lo; if (lo < origin || lo - origin > 2) origin = lo; state.gOrigin = origin;
    const hOf = new Map(vids.map((v) => [v, vertexHeight(heap[v], vertexCutOff(heap, v, gs))])), maxH = Math.max(...hOf.values());
    const slot = VERTEX.w + VERTEX.gapX, rowTall = maxH + VERTEX.gapY;
    const y0 = (occupied.length || flatIds.length || treeIds.length ? totalH + 10 : 0) + GEOM.tagH;
    let depth = 0;
    for (const v of vids) { const q = fresh.get(v)!; depth = Math.max(depth, q.d); boxes[v] = { id: v, kind: 'card', x: GEOM.pad + (sx.get(v)! - origin) * slot, y: y0 + q.d * rowTall, w: VERTEX.w, h: hOf.get(v)!, lane: -1, vertex: true }; }
    width = Math.max(width, GEOM.pad + (Math.max(...sx.values()) - origin) * slot + VERTEX.w + GEOM.pad);
    totalH = Math.max(totalH, y0 + depth * rowTall + maxH + GEOM.belowH / 2);
    graphLinks.push(...graphLinksFor(vids, edges, count, rank, boxes));
  }
  // Adjacency-list graphs: circles labelled by index, arrows from the inner lists. Same layout machinery as M6 graph mode,
  // positions remembered by synthetic vertex id (outer#label), so a vertex keeps its place across steps.
  const CIRCLE = 56;
  if (adjSpecs.length) {
    const y0 = (occupied.length || flatIds.length || treeIds.length || gs.vertices.length ? totalH + 10 : 0) + GEOM.tagH;
    let gx0 = y0;
    for (const spec of adjSpecs) {
      const vids = spec.lists.map((_, i) => `${spec.outer}#${i + spec.base}`), vset = new Set(vids), ord = new Map(vids.map((v, i) => [v, i]));
      const edges = new Map<string, string[]>(), count = new Map<string, number>();
      spec.rows.forEach((cols, r) => {
        const a = vids[r], targets = cols.map((c) => `${spec.outer}#${c}`).filter((t) => vset.has(t));
        for (const t of targets) count.set(`${a}|${t}`, (count.get(`${a}|${t}`) ?? 0) + 1);
        edges.set(a, [...new Set(targets)].filter((t) => t !== a));
      });
      const fresh = layeredLayout({ ids: vids, out: edges });
      const sx = stabilize(fresh, state.gx), lo = Math.min(...sx.values());
      let origin = state.gaOrigin ?? lo; if (lo < origin || lo - origin > 2) origin = lo; state.gaOrigin = origin;
      const slot = CIRCLE + VERTEX.gapX, rowTall = CIRCLE + VERTEX.gapY;
      let depth = 0;
      for (const v of vids) { const q = fresh.get(v)!; depth = Math.max(depth, q.d); boxes[v] = { id: v, kind: 'card', x: GEOM.pad + (sx.get(v)! - origin) * slot, y: gx0 + q.d * rowTall, w: CIRCLE, h: CIRCLE, lane: -1, vertex: true, circle: true }; }
      width = Math.max(width, GEOM.pad + (Math.max(...sx.values()) - origin) * slot + CIRCLE + GEOM.pad);
      totalH = Math.max(totalH, gx0 + depth * rowTall + CIRCLE + GEOM.belowH / 2);
      gx0 = totalH + 10;   // a second adjacency list draws below the first
      graphLinks.push(...graphLinksFor(vids, edges, count, (id) => ord.get(id) ?? 0, boxes));
    }
  } else state.gaOrigin = undefined;
  const links: Link[] = [];
  // Pointer fields on list nodes other than the chain link (prev, parent, owner ...).
  for (const id of listNodes) {
    const f = field(id), g = geomOf.get(id)!;
    Object.entries(heap[id].fields ?? {}).forEach(([k, v]) => { const port = recPort(g, k); if (k !== f && v.kind === 'ref' && boxes[v.id] && port) links.push({ from: id, to: v.id, port }); });
  }
  cardIds.forEach((id) => { const g = geomOf.get(id); if (!g) return;
    Object.entries(heap[id].fields ?? {}).forEach(([k, v]) => { const port = recPort(g, k); if (v.kind === 'ref' && boxes[v.id] && port) links.push({ from: id, to: v.id, port }); }); });
  cardIds.forEach((id) => geomOf.has(id) ? null : cardRows(heap[id]).forEach((r, i) => { if (r.value?.kind === 'ref' && boxes[r.value.id]) links.push({ from: id, cell: i, to: r.value.id, port: { x: CARD.w - 10, y: portY(i) } }); }));
  for (const id of listNodes) { const s = succ(id); if (s !== null && boxes[id] && boxes[s]) links.push({ from: id, to: s }); }
  for (const id of ids) {
    const n = heap[id];
    if (!isArray(n) || !boxes[id]) continue;
    n.items!.forEach((v, cell) => { if (v.kind === 'ref' && boxes[v.id]) links.push({ from: id, cell, to: v.id }); });
  }

  const tags: Record<string, string[]> = {}, nulls: string[] = [];
  for (const f of event.frames) for (const [name, v] of Object.entries(f.locals)) {
    const label = f.depth === 0 ? name : `${f.function}:${name}`;
    const col = v.kind === 'ref' ? gs.collapsed.get(v.id) : undefined;
    if (col && boxes[col.owner]) (tags[col.owner] ??= []).push(`${label} (${col.field} list)`);
    else if (v.kind === 'ref' && boxes[v.id]) (tags[v.id] ??= []).push(label);
    else if (v.kind === 'scalar' && v.value === null && !nulls.includes(label)) nulls.push(label);
  }
  for (const l of links) if (vertexSet.has(l.to) && !vertexSet.has(l.from)) { const d = pointerToVertex(l, boxes); if (d) l.d = d; }   // M6: clean curves into vertices
  const routed = route ? routeLinks(links.filter((l) => !l.d), boxes, width, tags) : { maxX: 0, needs: new Map<number, number>() };   // route=false: layout state only, arrows get routed when the scene is shown
  if (!extra && routed.needs.size) return buildScene(event, state, routed.needs);   // lay out again with room for the channels
  width = Math.max(width, routed.maxX);
  const undrawn: { id: string; type: string }[] = []; // every captured object now has a box
  const adjGroups: AdjGroup[] = adjSpecs.map((a) => ({ outer: a.outer, label: `${(adjNameOf.get(a.outer) ?? []).join(', ') || a.outer} (${heap[a.outer].type})`, vertices: a.lists.map((_, i) => `${a.outer}#${i + a.base}`) }));
  return { lanes, boxes, links: graphLinks.length ? [...links, ...graphLinks] : links, tags, nulls, cards: [...cardIds, ...gs.vertices], graph: gs, adjGroups, undrawn, width, height: totalH + 40 };   // room for same-row arrows that drop under the row
}

// All scenes for a trace, built once in order so lane choices carry forward. Stepping backward just indexes this array.
// Types that are graph vertices in at least one event of the trace. Scanned once per trace, so the drawing of a type never flips because its lists are empty at the start.
export function graphTypesOf(trace: Trace): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const e of trace.events) { const gs = graphSpec(e); for (const [t, f] of gs.edgeFields) { const cur = out.get(t) ?? []; for (const x of f) if (!cur.includes(x)) cur.push(x); out.set(t, cur); } }
  return out;
}
export function buildScenes(trace: Trace): Scene[] {
  const state = newLayoutState(); state.graphTypes = graphTypesOf(trace); state.adjOf = adjacencyOf(trace);
  return trace.events.map((e) => buildScene(e, state));
}

// Same scenes as buildScenes, built on demand. Lane state is sequential, so get(i) builds any scenes
// before i that are missing, in order, with the same function: the result is identical to buildScenes.
// Layout only: it never reads or changes validated trace data.
export interface SceneCache { get(i: number): Scene; step(max: number, ms?: number): boolean; built(): number }
export function sceneCache(trace: Trace): SceneCache {
  const state = newLayoutState(), scenes: Scene[] = [], snaps: LayoutState[] = [], shown = new Map<number, Scene>();
  const clone = cloneLayoutState;
  // Scenes are laid out in order so lane choices carry forward, but arrow routing (the costly part) is done only for a scene that is asked for, from the lane state just before it.
  const upTo = (i: number) => { while (scenes.length <= i && scenes.length < trace.events.length) { state.graphTypes ??= graphTypesOf(trace); state.adjOf ??= adjacencyOf(trace); snaps.push(clone(state)); scenes.push(buildScene(trace.events[scenes.length], state, undefined, false)); } };
  return {
    get(i) {
      upTo(i);
      if (!snaps[i]) return scenes[i];   // out of range: same as before
      let s = shown.get(i);
      if (!s) { s = buildScene(trace.events[i], clone(snaps[i])); if (shown.size >= 64) shown.delete(shown.keys().next().value!); shown.set(i, s); }
      return s;
    },
    // One slice: at most `max` scenes and at most ~`ms` milliseconds, so big scenes never hold the page for long. True when everything is built.
    step(max, ms = 8) { const t0 = performance.now(); for (let k = 0; k < max && scenes.length < trace.events.length && (k === 0 || performance.now() - t0 < ms); k++) upTo(scenes.length); return scenes.length >= trace.events.length; },
    built: () => scenes.length,
  };
}

// Short text for a value inside a box.
export function fmt(v: Value, max = 9): string {
  const clip = (s: string) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
  switch (v.kind) {
    case 'scalar': return v.value === null ? 'None' : typeof v.value === 'boolean' ? (v.value ? 'True' : 'False') : typeof v.value === 'string' ? clip(JSON.stringify(v.value)) : clip(String(v.value));
    case 'ref': return `→ ${v.id}`;
    case 'opaque': return v.type.startsWith('uninitialised ') ? 'uninit' : clip(v.type);
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
// Where an arrow leaves a cell strip for one cell, in box coordinates. A stack is a vertical column
// (cell 0 at the bottom), so its arrows leave from the right edge at that cell's height.
const cellAnchor = (b: { w: number; h: number; stack?: boolean }, cell: number, below = 0): { x: number; y: number } =>
  b.stack ? { x: b.w, y: b.h - cell * GEOM.cell - GEOM.cell / 2 } : { x: cellCentre(cell), y: b.h + below };

// SVG path for one arrow, in the coordinate space of its source box (so the arrow travels with its source).
export function linkPath(link: Link, boxes: Record<string, Box>): string | null {
  if (link.d) return link.d;
  const routed = routeOf.get(link);
  if (routed) return routed;
  return basePath(link, boxes);
}
function basePath(link: Link, boxes: Record<string, Box>): string | null {
  const a = boxes[link.from], b = boxes[link.to];
  if (!a || !b) return null;
  if (a.kind === 'card' || b.kind === 'card' || link.port) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const sx = link.port ? link.port.x : a.kind === 'array' ? cellAnchor(a, link.cell ?? 0).x + (a.stack ? 0 : 14) : a.w - POCKET, sy = link.port ? link.port.y : cellAnchor(a, link.cell ?? 0).y;
    if (link.from === link.to) return `M ${sx} ${sy} C ${sx + 40} ${sy - 10}, ${sx + 40} ${sy + 20}, ${sx + 2} ${sy + 4}`;
    const tx = a.kind === 'card' && a.rec && b.rec && dy > a.h ? dx + b.w - 16 : dx + b.w / 2, ty = dy - 3;
    const right = (a.kind === 'card' || a.kind === 'node') && link.port && dx > a.w; // target is clear of the card on the right: go side to side
    const skipsOver = right && dy === 0 && dx > a.w + GEOM.gap + 1;    // same row, other nodes sit between: a straight arrow would pass behind them
    if (skipsOver) {                                                   // go under the row and come up into the target's bottom edge
      const bottom = dy + b.h - 2, low = Math.max(a.h, b.h) + 30, ex = dx + b.w - 12;   // runs below the ID labels, rises into the target's bottom edge at its right end (clear of the label)
      return `M ${sx} ${sy} C ${sx} ${sy + low}, ${ex} ${dy + low}, ${ex} ${bottom}`;
    }
    if (link.port && b.kind === 'array' && dy < 0) return `M ${sx} ${sy} C ${a.w + 40} ${sy}, ${dx + b.w + 50} ${dy + b.h / 2}, ${dx + b.w + 1} ${dy + b.h / 2}`;   // pointer to an array above: come in from its right end, not through its cells
    if (a.kind === 'card' && a.rec && b.rec && dy > a.h) return `M ${sx} ${sy} C ${a.w + 36} ${sy}, ${tx} ${ty - 45}, ${tx} ${dy - 1}`;   // tree edge: out of the pointer compartment, down into the child's top edge
    if (right) return `M ${sx} ${sy} C ${sx + 40} ${sy}, ${dx - 40} ${dy + b.h / 2}, ${dx - 3} ${dy + b.h / 2}`;
    return `M ${sx} ${sy} C ${sx + 50} ${sy + 20}, ${tx} ${ty - 60}, ${tx} ${ty}`;
  }
  const dx = b.x - a.x, dy = b.y - a.y;
  const start = a.kind === 'node' ? { x: a.w - POCKET, y: (a.mainH ?? a.h) / 2 + 4 } : cellAnchor(a, link.cell ?? 0, 20);
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
    const body = `[${(n.items ?? []).map((v) => fmt(v, 12)).join(', ')}${om ? `, … ${om} more omitted` : ''}]`;
    if (STACK_TYPES.includes(n.type)) return `${n.type} ${lane.ids[0]}${tag(lane.ids[0])}: ${body} (bottom to top)`;
    if (QUEUE_TYPES.includes(n.type)) return `${n.type} ${lane.ids[0]}${tag(lane.ids[0])}: ${body} (front to back)`;
    return `${n.type} ${lane.ids[0]}${tag(lane.ids[0])}: ${body}`;
  }
  const linkField = linkFieldsByType(heap).get(lane.type);
  const parts = lane.ids.map((id) => `${nodeDisplay(heap[id], linkField).main}${tag(id)}`);
  const end = lane.end === 'null' ? 'None' : lane.end === 'cycle' ? `back to ${nodeDisplay(heap[lane.endTo!], linkField).main}` : lane.end === 'join' ? `joins ${lane.endTo}` : 'end';
  return `${lane.type} list ${lane.ids[0]}: ${[...parts, end].join(' → ')}`;
}

// ---- Arrow routing -------------------------------------------------------------------------------------------------
// The default curve for a link is cheap but knows nothing about other boxes. After layout, any arrow whose curve would run
// through a box that is neither its source nor its target is re-routed through a free channel: out of the source into the
// gap under its row, along the gap to a vertical gutter right of every box, up or down the gutter, then into the target.
// Each re-routed arrow gets its own gutter column and gap height, ordered so they do not cross each other where avoidable.
const routeOf = new WeakMap<Link, string>();
type Pt = { x: number; y: number };
function sampleBase(d: string, a: Box): Pt[] {   // points of a single-cubic or line path, in absolute scene coordinates
  const n = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number), pts: Pt[] = [];
  if (d.includes('C') && n.length >= 8) {
    const [x0, y0, x1, y1, x2, y2, x3, y3] = n;
    for (let i = 0; i <= 40; i++) { const t = i / 40, u = 1 - t; pts.push({ x: a.x + u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3, y: a.y + u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3 }); }
  } else if (n.length >= 4) { pts.push({ x: a.x + n[0], y: a.y + n[1] }, { x: a.x + n[2], y: a.y + n[3] }); }
  return pts;
}
const inside = (p: Pt, o: Box, m = 2) => p.x > o.x + m && p.x < o.x + o.w - m && p.y > o.y + m && p.y < o.y + o.h - m;
function polyHits(pts: Pt[], boxes: Box[], skip: Set<string>): number {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of pts) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; }
  let hits = 0;
  for (const o of boxes) {
    if (o.x > x1 || o.x + o.w < x0 || o.y > y1 || o.y + o.h < y0 || skip.has(o.id)) continue;   // box outside the curve's bounding box
    if (pts.some((p) => inside(p, o))) hits++;
  }
  return hits;
}
function rounded(pts: Pt[], a: Box, r = 7): string {   // polyline with rounded corners, in the source box's coordinates
  const P = pts.map((p) => ({ x: p.x - a.x, y: p.y - a.y }));
  let d = `M ${P[0].x} ${P[0].y}`;
  for (let i = 1; i < P.length - 1; i++) {
    const p0 = P[i - 1], p1 = P[i], p2 = P[i + 1];
    const l1 = Math.hypot(p1.x - p0.x, p1.y - p0.y), l2 = Math.hypot(p2.x - p1.x, p2.y - p1.y), rr = Math.min(r, l1 / 2, l2 / 2);
    if (rr < 0.5) { d += ` L ${p1.x} ${p1.y}`; continue; }
    d += ` L ${p1.x + (p0.x - p1.x) / l1 * rr} ${p1.y + (p0.y - p1.y) / l1 * rr} Q ${p1.x} ${p1.y} ${p1.x + (p2.x - p1.x) / l2 * rr} ${p1.y + (p2.y - p1.y) / l2 * rr}`;
  }
  const e = P[P.length - 1]; return d + ` L ${e.x} ${e.y}`;
}
// Returns the right-most x the routed arrows need, so the caller can widen the scene.
// Text that sits outside a box: the variable-name pill above it and the id caption / cell numbers under it.
export type Label = Box & { owner: string };
export function labelRects(boxes: Record<string, Box>, tags: Record<string, string[]>): Label[] {
  const out: Label[] = [];
  for (const b of Object.values(boxes)) {
    out.push({ ...b, owner: b.id, id: `${b.id}:id`, kind: 'card', y: b.y + b.h, h: 20, w: b.kind === 'array' ? b.w : b.rec ? 150 : 44, rec: undefined, mainH: undefined });
    const t = tags[b.id];
    if (t?.length) out.push({ ...b, owner: b.id, id: `${b.id}:tag`, kind: 'card', y: b.y - 30, h: 26, w: Math.min(t.join(', ').length, 16) * 6.6 + 16, rec: undefined, mainH: undefined });
  }
  return out;
}
const segHits = (pts: Pt[], rects: Label[], skip: (r: Box) => boolean): boolean => {   // axis-aligned or diagonal segments against caption rectangles
  for (let i = 1; i < pts.length; i++) {
    const x0 = Math.min(pts[i].x, pts[i - 1].x), x1 = Math.max(pts[i].x, pts[i - 1].x), y0 = Math.min(pts[i].y, pts[i - 1].y), y1 = Math.max(pts[i].y, pts[i - 1].y);
    for (const r of rects) {
      if (r.x > x1 || r.x + r.w < x0 || r.y > y1 || r.y + r.h < y0 || skip(r)) continue;
      const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 3);
      for (let k = 0; k <= n; k++) { const q = { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * k / Math.max(1, n), y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * k / Math.max(1, n) }; if (inside(q, r, 0)) return true; }
    }
  }
  return false;
};
// Routing depends only on box geometry, the link list and the name pills, and most steps change none of them, so the last results are kept.
const routeCache = new Map<string, { paths: (string | undefined)[]; maxX: number; needs: Map<number, number> }>();
export function routeLinks(links: Link[], boxes: Record<string, Box>, sceneW: number, tags: Record<string, string[]> = {}): { maxX: number; needs: Map<number, number> } {
  let sig = `${Math.round(sceneW)}|`;
  for (const b of Object.values(boxes)) sig += `${b.id},${b.kind[0]},${Math.round(b.x)},${Math.round(b.y)},${b.w},${b.h},${b.lane}${b.rec ? 'r' : ''};`;
  for (const l of links) sig += `${l.from}.${l.cell ?? ''}.${l.to}.${l.port ? `${l.port.x},${l.port.y}` : ''};`;
  for (const k of Object.keys(tags)) sig += `${k}=${tags[k].join(',').length}|`;
  const hit = routeCache.get(sig);
  if (hit) { links.forEach((l, i) => { const d = hit.paths[i]; if (d) routeOf.set(l, d); }); return { maxX: hit.maxX, needs: hit.needs }; }
  const out = routeLinksCompute(links, boxes, sceneW, tags);
  if (routeCache.size >= 24) routeCache.delete(routeCache.keys().next().value!);
  routeCache.set(sig, { paths: links.map((l) => routeOf.get(l)), maxX: out.maxX, needs: out.needs });
  return out;
}
function routeLinksCompute(links: Link[], boxes: Record<string, Box>, sceneW: number, tags: Record<string, string[]>): { maxX: number; needs: Map<number, number> } {
  const all = Object.values(boxes), needs = new Map<number, number>();
  if (!all.length) return { maxX: 0, needs };
  const maxRight = Math.max(sceneW - 28, ...all.map((o) => o.x + o.w));
  type R = { link: Link; a: Box; b: Box; start: Pt; base: string };
  const labels = labelRects(boxes, tags);
  const srcCount = new Map<string, number>(); for (const l of links) srcCount.set(l.from, (srcCount.get(l.from) ?? 0) + 1);
  const bad: R[] = [], good: { link: Link; a: Box; pts: Pt[] }[] = [];
  for (const link of links) {
    const a = boxes[link.from], b = boxes[link.to];
    if (!a || !b || a === b) continue;
    const base = basePath(link, boxes);
    if (!base) continue;
    const pts = sampleBase(base, a);
    const fromArrayCell = a.kind === 'array' && !link.port;   // these leave the bottom edge, so a path that re-enters its own source is a fault too
    const m = base.match(/^M\s+(-?[\d.]+)\s+(-?[\d.]+)/)!;
    const r: R = { link, a, b, start: fromArrayCell ? { x: a.x + cellAnchor(a, link.cell ?? 0).x, y: a.y + cellAnchor(a, link.cell ?? 0, 20).y } : { x: a.x + Number(m[1]), y: a.y + Number(m[2]) }, base };
    let overCaption = false;
    if (pts.length) {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const p of pts) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; }
      for (const o of labels) { if (o.owner === a.id || o.owner === b.id || o.x > x1 || o.x + o.w < x0 || o.y > y1 || o.y + o.h < y0) continue; if (pts.some((p) => inside(p, o, 0))) { overCaption = true; break; } }
    }
    if (pts.length && (polyHits(pts, all, new Set(fromArrayCell ? [b.id] : [a.id, b.id])) > 0 || overCaption)) bad.push(r);
    else good.push({ link, a, pts: (srcCount.get(link.from) ?? 0) <= 8 ? densify(pts) : [] });
    (r as R & { pts?: Pt[] }).pts = pts;
  }
  // Two arrows that run side by side for a long way are as unreadable as one through a box: send the later one through its own channel.
  // Only small fans are checked (a 40-way fan from one array is spread by design and cannot all move into channels).
  const perSource = new Map<string, number>(); for (const g of good) perSource.set(g.a.id, (perSource.get(g.a.id) ?? 0) + 1);
  const small = (i: number) => (perSource.get(good[i].a.id) ?? 0) <= 8;
  const grid = new Map<string, { i: number; x: number; y: number }[]>(), CELL = 6;
  good.forEach((g, i) => { if (!small(i)) return; g.pts.forEach((p, k) => { if (k < 7 || k > g.pts.length - 8) return; const key = `${Math.floor(p.x / CELL)},${Math.floor(p.y / CELL)}`; (grid.get(key) ?? grid.set(key, []).get(key)!).push({ i, x: p.x, y: p.y }); }); });
  const moved = new Set<number>();
  good.forEach((g, i) => {
    if (moved.has(i) || !small(i)) return;
    const near = new Map<number, number>();
    g.pts.forEach((p, k) => { if (k < 7 || k > g.pts.length - 8) return; const cx = Math.floor(p.x / CELL), cy = Math.floor(p.y / CELL), seen = new Set<number>();
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const q of grid.get(`${cx + dx},${cy + dy}`) ?? []) if (q.i > i && !moved.has(q.i) && !seen.has(q.i) && good[q.i].link.to !== g.link.to && Math.hypot(q.x - p.x, q.y - p.y) < 6) { seen.add(q.i); near.set(q.i, (near.get(q.i) ?? 0) + 1); } });
    for (const [j, c] of near) if (c >= 14) moved.add(j);   // 14 samples x 6px is about 80px side by side, closer than 6px
  });
  // One source with a side-by-side pair sends all its arrows through channels, so they stay in one consistent family.
  const movedSrc = new Set([...moved].map((j) => good[j].a.id));
  good.forEach((g, j) => { if (movedSrc.has(g.a.id)) moved.add(j); });
  for (const j of moved) { const g = good[j], a = g.a, link = g.link, b = boxes[link.to], fromArrayCell = a.kind === 'array' && !link.port, m = basePath(link, boxes)!.match(/^M\s+(-?[\d.]+)\s+(-?[\d.]+)/)!;
    bad.push({ link, a, b, start: fromArrayCell ? { x: a.x + cellCentre(link.cell ?? 0), y: a.y + a.h + 20 } : { x: a.x + Number(m[1]), y: a.y + Number(m[2]) }, base: '' }); }
  if (!bad.length) return { maxX: 0, needs };
  // Gutter columns: arrows going up are ordered so the one reaching highest sits outermost; arrows going down so the lowest does.
  const ty = (r: { b: Box }) => r.b.y + r.b.h / 2, up = (r: { a: Box; b: Box }) => r.b.y + r.b.h / 2 < r.a.y + r.a.h / 2;
  const ordered = [...bad.filter(up).sort((p, q) => ty(q) - ty(p) || p.start.x - q.start.x), ...bad.filter((r) => !up(r)).sort((p, q) => ty(p) - ty(q) || q.start.x - p.start.x)];
  const colStep = ordered.length > 60 ? 4 : ordered.length > 24 ? 6 : 8;
  const perRow = new Map<number, number>(), seenRow = new Map<number, number>(), laneOfRow = new Map<number, number>();
  // The channel runs under the whole row (the tallest box in it), not just under the source.
  const rowBottom = (a: Box) => Math.max(a.y + a.h, ...all.filter((o) => Math.abs(o.y - a.y) < 1).map((o) => o.y + o.h));
  for (const r of ordered) { const key = Math.round(rowBottom(r.a)); perRow.set(key, (perRow.get(key) ?? 0) + 1); laneOfRow.set(key, r.a.lane); }
  // Channels need 6px each so neighbouring runs stay distinct lines. The free band under a row is 18px; a row with more arrows than that is made taller on the second layout pass.
  for (const [key, n] of perRow) { const lane = laneOfRow.get(key)!, e = Math.max(0, n * 6 + 4 - 18); if (lane >= 0 && e > 0) needs.set(lane, Math.max(needs.get(lane) ?? 0, e)); }
  // Arrows leaving one node each get their own column in the gap beside it (lower ports closest), so the first vertical runs do not coincide.
  const stubIdx = new Map<Link, number>(), bySrc = new Map<string, R[]>();
  for (const r of ordered) if (r.link.port || r.a.kind !== 'array') (bySrc.get(r.a.id) ?? bySrc.set(r.a.id, []).get(r.a.id)!).push(r);
  for (const list of bySrc.values()) list.sort((p, q) => q.start.y - p.start.y).forEach((r, i) => stubIdx.set(r.link, Math.min(i, 6)));
  // Top-edge entries into one row: the target furthest left runs highest, so the others drop under its run without crossing it.
  const rowRightOf = (r: R) => all.some((o) => o.id !== r.b.id && o.id !== r.a.id && o.x >= r.b.x + r.b.w && o.y < r.b.y + r.b.h && o.y + o.h > r.b.y);
  const topRank = new Map<Link, number>(), topRows = new Map<number, R[]>();
  for (const r of ordered) if (rowRightOf(r)) (topRows.get(Math.round(r.b.y)) ?? topRows.set(Math.round(r.b.y), []).get(Math.round(r.b.y))!).push(r);
  for (const list of topRows.values()) list.sort((p, q) => q.b.x - p.b.x || p.start.x - q.start.x).forEach((r, i) => topRank.set(r.link, i));
  let maxX = maxRight;
  ordered.forEach((r, k) => {
    const gx = maxRight + 22 + k * colStep, key = Math.round(rowBottom(r.a)), n = perRow.get(key)!, j = seenRow.get(key) ?? 0; seenRow.set(key, j + 1);
    const band = 18 + (r.a.lane >= 0 ? Math.max(0, n * 6 + 4 - 18) : 0), step = Math.min(6, band / Math.max(1, n)), gy = rowBottom(r.a) + 26 + (up(r) ? n - 1 - j : j) * step;
    const pts: Pt[] = [r.start];
    const leavesSide = r.link.port || r.a.kind !== 'array';
    if (leavesSide) { const sx = r.a.x + r.a.w + 6 + (stubIdx.get(r.link) ?? 0) * 7; pts.push({ x: sx, y: r.start.y }, { x: sx, y: gy }); }
    else pts.push({ x: r.start.x, y: gy });
    pts.push({ x: gx, y: gy });
    const yMid = r.b.y + r.b.h / 2, rowRight = rowRightOf(r);
    if (!rowRight) pts.push({ x: gx, y: yMid }, { x: r.b.x + r.b.w + 2, y: yMid });   // free to the right of the target: enter its right edge
    else {   // boxes sit to its right: come down onto its top edge, along whichever height clears the name pills
      const ex = r.b.x + r.b.w - 10;
      let best: Pt[] | null = null;
      const rk = topRank.get(r.link) ?? 0;
      for (const off of [8 + rk * 7, 4 + rk * 7, 12 + rk * 7]) { const t = [...pts, { x: gx, y: r.b.y - off }, { x: ex, y: r.b.y - off }, { x: ex, y: r.b.y - 3 }]; if (!segHits(t.slice(pts.length - 1), labels, (l) => l.id === `${r.b.id}:id` || l.id === `${r.a.id}:id`)) { best = t; break; } }
      pts.splice(0, pts.length, ...(best ?? [...pts, { x: gx, y: r.b.y - 8 - rk * 7 }, { x: ex, y: r.b.y - 8 - rk * 7 }, { x: ex, y: r.b.y - 3 }]));
    }
    routeOf.set(r.link, rounded(pts, r.a));
    maxX = Math.max(maxX, gx);
  });
  return { maxX: maxX + 28, needs };
}
// Resample a polyline to roughly 6px steps.
function densify(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (let i = 1; i < pts.length; i++) { const n = Math.max(1, Math.ceil(Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y) / 6)); for (let k = 0; k < n; k++) out.push({ x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * k / n, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * k / n }); }
  if (pts.length) out.push(pts[pts.length - 1]);
  return out;
}
