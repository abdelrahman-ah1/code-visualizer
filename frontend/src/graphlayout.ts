// Milestone 6: layout maths for trees and graphs. Pure functions, no React and no DOM.
//
// Two jobs:
//  1. layeredLayout: a fresh layered (Sugiyama-style) layout for a graph: layer = shortest distance from a root,
//     order inside a layer reduced for crossings by barycenter sweeps, x relaxed toward the neighbours.
//  2. stabilize: take any fresh layout (this one, or the tidy-tree layout in structures.ts) and keep every object
//     where it was on the previous step unless the fresh position is more than `thr` slots away, or two objects in one
//     row would overlap. Positions are remembered by object id, so identity decides where a box goes, never its place in a list.
// Nothing here reads or changes trace snapshots.

export interface Slot { x: number; d: number }   // x in slot units (one slot = one card width plus gap), d = layer (row)

// Sort objects by x inside each layer and push right until neighbours are at least `minSep` apart. Order ties keep the input order.
function pack(items: { id: string; x: number; d: number }[], minSep: number): Map<string, number> {
  const rows = new Map<number, { id: string; x: number; i: number }[]>();
  items.forEach((it, i) => { (rows.get(it.d) ?? rows.set(it.d, []).get(it.d)!).push({ id: it.id, x: it.x, i }); });
  const out = new Map<string, number>();
  for (const row of rows.values()) {
    row.sort((a, b) => a.x - b.x || a.i - b.i);
    let prev = -Infinity;
    for (const r of row) { const x = Math.max(r.x, prev + minSep); out.set(r.id, x); prev = x; }
  }
  return out;
}

// mem is the remembered x per id (updated in place to the result). Returns the stabilised x per id.
export function stabilize(fresh: Map<string, Slot>, mem: Map<string, number>, thr = 0.5, minSep = 1): Map<string, number> {
  const items: { id: string; x: number; d: number }[] = [];
  for (const [id, f] of fresh) { const m = mem.get(id); items.push({ id, d: f.d, x: m !== undefined && Math.abs(m - f.x) <= thr ? m : f.x }); }
  const out = pack(items, minSep);
  mem.clear(); for (const [id, x] of out) mem.set(id, x);
  return out;
}

export interface GraphIn {
  ids: string[];                     // vertices, in first-seen order (the tie-break everywhere)
  out: Map<string, string[]>;        // directed edges, distinct targets, no self loops, targets are vertices
}

export function layeredLayout({ ids, out }: GraphIn): Map<string, Slot> {
  const rank = new Map(ids.map((id, i) => [id, i])), und = new Map<string, Set<string>>(ids.map((id) => [id, new Set()]));
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const a of ids) for (const b of out.get(a) ?? []) { und.get(a)!.add(b); und.get(b)!.add(a); indeg.set(b, indeg.get(b)! + 1); }
  // Weakly connected components, in first-seen order.
  const comp = new Map<string, number>(), comps: string[][] = [];
  for (const s of ids) {
    if (comp.has(s)) continue;
    const c: string[] = [], q = [s]; comp.set(s, comps.length);
    while (q.length) { const v = q.shift()!; c.push(v); for (const w of und.get(v)!) if (!comp.has(w)) { comp.set(w, comps.length); q.push(w); } }
    comps.push(c.sort((a, b) => rank.get(a)! - rank.get(b)!));
  }
  const result = new Map<string, Slot>();
  let offset = 0;
  for (const members of comps) {
    // Layers: BFS from every source at once (a cycle with no source starts at its first-seen vertex).
    const layer = new Map<string, number>(), order: string[] = [];
    const bfs = (starts: string[]) => {
      const q = [...starts]; starts.forEach((s) => layer.set(s, layer.get(s) ?? 0));
      while (q.length) { const v = q.shift()!; order.push(v); for (const w of out.get(v) ?? []) if (!layer.has(w)) { layer.set(w, layer.get(v)! + 1); q.push(w); } }
    };
    bfs(members.filter((v) => indeg.get(v) === 0));
    for (const v of members) if (!layer.has(v)) bfs([v]);
    const depth = Math.max(...members.map((v) => layer.get(v)!));
    const rows: string[][] = Array.from({ length: depth + 1 }, () => []);
    for (const v of order) rows[layer.get(v)!].push(v);
    const nb = (v: string, d: number) => [...und.get(v)!].filter((w) => layer.get(w) === d);
    // Barycenter sweeps: reorder each row by the mean position of its neighbours in the row above (down) or below (up).
    const pos = new Map<string, number>(); const refresh = () => rows.forEach((r) => r.forEach((v, i) => pos.set(v, i)));
    refresh();
    for (let it = 0; it < 4; it++) {
      const down = it % 2 === 0;
      for (let k = down ? 1 : depth - 1; down ? k <= depth : k >= 0; k += down ? 1 : -1) {
        const bary = (v: string) => { const n = nb(v, down ? k - 1 : k + 1); return n.length ? n.reduce((s, w) => s + pos.get(w)!, 0) / n.length : pos.get(v)!; };
        const keyed = rows[k].map((v, i) => ({ v, b: bary(v), i }));
        keyed.sort((a, b) => a.b - b.b || a.i - b.i);
        rows[k] = keyed.map((e) => e.v); rows[k].forEach((v, i) => pos.set(v, i));
      }
    }
    // x: spread each row evenly and centred, then relax toward the neighbours without letting boxes overlap.
    const width = Math.max(...rows.map((r) => r.length));
    const x = new Map<string, number>();
    rows.forEach((r) => r.forEach((v, i) => x.set(v, i - (r.length - 1) / 2 + (width - 1) / 2)));
    for (let it = 0; it < 6; it++) {
      const down = it % 2 === 0;
      for (let k = down ? 0 : depth; down ? k <= depth : k >= 0; k += down ? 1 : -1) {
        const want = rows[k].map((v) => { const n = [...nb(v, k - 1), ...nb(v, k + 1)]; return n.length ? n.reduce((s, w) => s + x.get(w)!, 0) / n.length : x.get(v)!; });
        // push right to keep a gap of 1, then pull the whole run back toward what it wanted
        const placed: number[] = []; want.forEach((w, i) => placed.push(i ? Math.max(w, placed[i - 1] + 1) : w));
        const shift = placed.reduce((s, p, i) => s + (want[i] - p), 0) / Math.max(1, placed.length);
        rows[k].forEach((v, i) => x.set(v, placed[i] + shift));
        for (let i = 1; i < rows[k].length; i++) if (x.get(rows[k][i])! < x.get(rows[k][i - 1])! + 1) x.set(rows[k][i], x.get(rows[k][i - 1])! + 1);
      }
    }
    const minX = Math.min(...members.map((v) => x.get(v)!)), maxX = Math.max(...members.map((v) => x.get(v)!));
    for (const v of members) result.set(v, { x: x.get(v)! - minX + offset, d: layer.get(v)! });
    offset += maxX - minX + 1.4;
  }
  return result;
}
