// Pure structure analysis for Milestone 3. No React and no DOM here, so every rule can be unit tested.
//
// The job: read one trace snapshot and decide (a) which heap objects are linked-list nodes or
// arrays, (b) which "lane" (row) each structure sits in, and (c) where every box goes.
// Trace snapshots are never changed. Layout lives only in the Scene objects built here.
import type { HeapNode, Trace, TraceEvent, Value } from './types';

export const GEOM = { nodeW: 124, nodeH: 56, gap: 52, cell: 46, pad: 28, tagH: 34, belowH: 56 };
export const LANE_H = GEOM.tagH + GEOM.nodeH + GEOM.belowH;
const POCKET = 15; // distance from a node's right edge to the centre of its link dot

export interface Box { id: string; kind: 'node' | 'array' | 'card'; x: number; y: number; w: number; h: number; lane: number; mainH?: number; rec?: boolean }
// An arrow from one box (and, for arrays, one cell) to another drawn box.
export interface Link { from: string; cell?: number; to: string; port?: { x: number; y: number } }
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
  cards: string[];                  // ids drawn as general object cards
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
  // Arrays that hold pointers sit lowest, next to the objects they point at, so their arrows do not run across other arrays.
  const ptrMemo = new Map<Structure, number>();
  const ptrArray = (st: Structure) => { let v = ptrMemo.get(st); if (v === undefined) { v = st.kind === 'array' && (heap[st.ids[0]].items ?? []).some((x) => x.kind === 'ref') ? 1 : 0; ptrMemo.set(st, v); } return v; };
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
  const rowTop: number[] = []; rowH.reduce((acc, h, r) => { rowTop[r] = acc; return acc + h; }, 0);
  structures.forEach((s, i) => {
    const lane = laneFor[i], row = rowOf.get(lane)!, y = rowTop[row] + GEOM.tagH;
    lanes.push({ lane, row, kind: s.kind, ids: s.ids, type: s.type, end: s.end, endTo: s.endTo });
    if (s.kind === 'list') {
      let x = GEOM.pad;
      s.ids.forEach((id) => { const g = geomOf.get(id)!; boxes[id] = { id, kind: 'node', x, y, w: g.w, h: g.h, mainH: g.mainH, lane }; x += g.w + GEOM.gap; });
      width = Math.max(width, x - GEOM.gap + GEOM.pad + GEOM.gap);
    } else {
      const node = heap[s.ids[0]], cells = (node.items?.length ?? 0) + (arrayOmitted(node) > 0 ? 1 : 0);
      boxes[s.ids[0]] = { id: s.ids[0], kind: 'array', x: GEOM.pad, y, w: Math.max(1, cells) * GEOM.cell, h: GEOM.cell, lane };
      width = Math.max(width, GEOM.pad * 2 + Math.max(1, cells) * GEOM.cell);
    }
  });

  const lanesH = Math.max(LANE_H, rowH.reduce((a, b) => a + b, 0)) + 12;
  const cardIds = ids.filter((id) => !boxes[id]).sort((a, b) => rank(a) - rank(b));
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
    for (const id of treeIds) { const g = recGeom(heap[id]), q = pos.get(id)!; boxes[id] = { id, kind: 'card', x: x0 + q.x * slot, y: y0 + q.d * rowTall, w: g.w, h: g.h, lane: -1, rec: true, mainH: g.mainH }; geomOf.set(id, g); }
    width = Math.max(width, x0 + Math.max(...[...pos.values()].map((q) => q.x)) * slot + slot + GEOM.pad);
    totalH = Math.max(totalH, y0 + (maxD + 1) * rowTall);
  };
  for (const id of flatIds) {
    const rec = isRecord(heap[id]) ? recGeom(heap[id]) : null, h = rec ? rec.h : cardHeight(heap[id]), cw = rec ? rec.w : CARD.w;
    if (cx > GEOM.pad && cx + cw > wrapW) { cx = GEOM.pad; cy += crow + CARD.gap + GEOM.tagH - 8; crow = 0; }
    boxes[id] = { id, kind: 'card', x: cx, y: cy, w: cw, h, lane: -1, ...(rec ? { rec: true, mainH: rec.mainH } : {}) };
    if (rec) geomOf.set(id, rec);
    cx += cw + CARD.gap; crow = Math.max(crow, h); width = Math.max(width, cx - CARD.gap + GEOM.pad); totalH = cy + crow + GEOM.belowH / 2;
  }
  if (above && treeIds.length) {
    const bandH = cy + crow + GEOM.belowH / 2 - splitY;
    for (const b of Object.values(boxes)) if (b.kind !== 'card' && b.y >= splitY) b.y += bandH;
    totalH = bandH + lanesH;
    placeTree(GEOM.pad, bandH + lanesH + GEOM.tagH);
  } else if (treeIds.length) placeTree(flatIds.length ? cx : GEOM.pad, (occupied.length ? lanesH : 0) + GEOM.tagH);
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
    if (v.kind === 'ref' && boxes[v.id]) (tags[v.id] ??= []).push(label);
    else if (v.kind === 'scalar' && v.value === null && !nulls.includes(label)) nulls.push(label);
  }
  const undrawn: { id: string; type: string }[] = []; // every captured object now has a box
  return { lanes, boxes, links, tags, nulls, cards: cardIds, undrawn, width, height: totalH + 40 };   // room for same-row arrows that drop under the row
}

// All scenes for a trace, built once in order so lane choices carry forward. Stepping backward just indexes this array.
export function buildScenes(trace: Trace): Scene[] {
  const state = newLayoutState();
  return trace.events.map((e) => buildScene(e, state));
}

// Same scenes as buildScenes, built on demand. Lane state is sequential, so get(i) builds any scenes
// before i that are missing, in order, with the same function: the result is identical to buildScenes.
// Layout only: it never reads or changes validated trace data.
export interface SceneCache { get(i: number): Scene; step(max: number, ms?: number): boolean; built(): number }
export function sceneCache(trace: Trace): SceneCache {
  const state = newLayoutState(), scenes: Scene[] = [];
  const upTo = (i: number) => { while (scenes.length <= i && scenes.length < trace.events.length) scenes.push(buildScene(trace.events[scenes.length], state)); };
  return {
    get(i) { upTo(i); return scenes[i]; },
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
  if (a.kind === 'card' || b.kind === 'card' || link.port) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const sx = link.port ? link.port.x : a.kind === 'array' ? cellCentre(link.cell ?? 0) + 14 : a.w - POCKET, sy = link.port ? link.port.y : a.kind === 'array' ? a.h : a.h;
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
  const start = a.kind === 'node' ? { x: a.w - POCKET, y: (a.mainH ?? a.h) / 2 + 4 } : { x: cellCentre(link.cell ?? 0), y: a.h + 20 };
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
