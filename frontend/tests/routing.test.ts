// Arrow routing: no arrow may pass through a box that is not its source or target, and arrows must not lie on top of each other.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { parseTrace } from '../src/parseTrace';
import { buildScenes, sceneCache, linkPath, labelRects } from '../src/structures';
import type { Scene } from '../src/structures';

type Pt = { x: number; y: number };
export function samplePath(d: string, ox: number, oy: number): Pt[] {
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
function resample(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (let i = 1; i < pts.length; i++) { const n = Math.max(1, Math.ceil(Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y) / 6)); for (let k = 0; k < n; k++) out.push({ x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * k / n, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * k / n }); }
  return out;
}
// Proper crossing of two path segments: they really pass through each other, not merely meet at a shared end.
function segCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const near = (p: Pt, q: Pt) => Math.hypot(p.x - q.x, p.y - q.y) < 1.5;
  if (near(a, c) || near(a, d) || near(b, c) || near(b, d)) return false;
  const o = (p: Pt, q: Pt, r: Pt) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
}
const pathLen = (p: Pt[]) => { let n = 0; for (let i = 1; i < p.length; i++) n += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y); return n; };
export function crossings(scene: Scene): { arrows: number; crossing: number; worst: number; shared: number; labelHits: number; arrowCross: number; crossGraph: number; crossCard: number; labelOverlap: number; outOfScene: number; maxDetour: number } {
  const boxes = Object.values(scene.boxes);
  let crossing = 0, worst = 0, arrows = 0, labelHits = 0;
  const labels = labelRects(scene.boxes, scene.tags);
  const paths: { from: string; to: string; graph: boolean; pts: Pt[] }[] = [];
  scene.links.forEach((l, li) => {
    const a = scene.boxes[l.from], b = scene.boxes[l.to], d = linkPath(l, scene.boxes);
    if (!a || !b || !d) return;
    arrows++;
    const pts = samplePath(d, a.x, a.y);
    const hit = boxes.filter((o) => (o.id !== a.id || (a.kind === 'array' && !l.port)) && o.id !== b.id && pts.some((p) => p.x > o.x + 2 && p.x < o.x + o.w - 2 && p.y > o.y + 2 && p.y < o.y + o.h - 2));
    if (hit.length) { crossing++; worst = Math.max(worst, hit.length); }
    // name pills and id captions of other boxes (a thin line over a caption is milder than over a box; reported, not asserted)
    if (labels.some((o) => !o.id.startsWith(`${a.id}:`) && !o.id.startsWith(`${b.id}:`) && pts.some((p) => p.x > o.x && p.x < o.x + o.w && p.y > o.y && p.y < o.y + o.h))) labelHits++;
    paths.push({ from: l.from, to: l.to, graph: !!l.d, pts: resample(pts) });
  });
  // Near-parallel: two arrows to different targets that stay within 6px of each other for 14+ samples (about 80px), ends excluded.
  let shared = 0;
  for (let i = 0; i < paths.length; i++) for (let j = i + 1; j < paths.length; j++) {
    if (paths[i].to === paths[j].to) continue;
    let c = 0; const P = paths[i].pts, Q = paths[j].pts;
    for (let k = 7; k < P.length - 7; k++) if (Q.slice(7, Q.length - 7).some((q) => Math.hypot(q.x - P[k].x, q.y - P[k].y) < 6)) c++;
    if (c >= 14) shared++;
  }
  // Two arrows of different links that actually cross. A fan out of one object (same source, different targets) is
  // allowed to share a trunk, so it is not counted; anything else crossing is the tangle this milestone removes.
  // Only pairs whose boxes overlap can cross, and 10px sampling is enough to see a crossing, so big scenes stay quick.
  const box = paths.map((p) => { let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity; for (const q of p.pts) { if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x; if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y; } return { x0, x1, y0, y1, pts: p.pts.filter((_, k) => k % 2 === 0) }; });
  let arrowCross = 0, crossGraph = 0, crossCard = 0, outOfScene = 0, maxDetour = 0;
  for (let i = 0; i < paths.length; i++) {
    for (let j = i + 1; j < paths.length; j++) {
      const A = box[i], B = box[j];
      if (A.x1 < B.x0 || B.x1 < A.x0 || A.y1 < B.y0 || B.y1 < A.y0) continue;   // no shared area: cannot cross
      if (paths[i].to === paths[j].to) continue;                              // two arrows into one target must converge
      let hit = false;
      const P = A.pts, Q = B.pts;
      for (let a = 1; a < P.length && !hit; a++) for (let b = 1; b < Q.length && !hit; b++) if (segCross(P[a - 1], P[a], Q[b - 1], Q[b])) hit = true;
      if (hit) { arrowCross++; if (paths[i].graph || paths[j].graph) crossGraph++; else crossCard++; }
    }
  }
  for (const l of scene.links) {
    const a = scene.boxes[l.from], d = linkPath(l, scene.boxes); if (!a || !d) continue;
    const pts = samplePath(d, a.x, a.y);
    if (pts.some((p) => p.x < -1 || p.y < -1 || p.x > scene.width + 1 || p.y > scene.height + 1)) outOfScene++;
    const s0 = pts[0], s1 = pts[pts.length - 1], straight = Math.hypot(s1.x - s0.x, s1.y - s0.y);
    if (straight > 40) maxDetour = Math.max(maxDetour, pathLen(pts) / straight);
  }
  // Two labels drawn on top of each other (a name pill, an id caption, a cell number).
  let labelOverlap = 0;
  for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
    const A = labels[i], B = labels[j];
    if (A.owner === B.owner) continue;
    if (A.x < B.x + B.w && B.x < A.x + A.w && A.y < B.y + B.h && B.y < A.y + A.h) labelOverlap++;
  }
  return { arrows, crossing, worst, shared, labelHits, arrowCross, crossGraph, crossCard, labelOverlap, outOfScene, maxDetour: Math.round(maxDetour * 100) / 100 };
}
const dir = new URL('../public/examples/', import.meta.url);
const names = readdirSync(dir).filter((f) => f.endsWith('.trace.json'));
// CI runners are about three times slower than this machine, and these walk every scene of every recording,
// so they get an explicit timeout instead of vitest's 5 s default.
const SLOW = 120_000;
describe('arrow routing', () => {
  it('reports arrows over other boxes' + "'" + ' name pills and captions', () => {
    let arrows = 0, hits = 0;
    for (const n of names) for (const s of buildScenes(parseTrace(readFileSync(new URL(n, dir), 'utf8')))) { const c = crossings(s); arrows += c.arrows; hits += c.labelHits; }
    console.log('label hits over all examples/events', hits, 'of', arrows, 'arrows');
  }, SLOW);
  for (const n of names) it(`${n}: sceneCache (routes only the scene shown) draws the same arrows as buildScenes, far seek first`, () => {
    const t = parseTrace(readFileSync(new URL(n, dir), 'utf8')), all = buildScenes(t), c = sceneCache(t);
    const sig = (s: any) => JSON.stringify([s.width, s.height, s.links.map((l: any) => linkPath(l, s.boxes))]);
    const order = [...all.keys()].reverse(); for (const i of order) expect(sig(c.get(i)), `${n} event ${i}`).toBe(sig(all[i]));
  });
  it('has example recordings to check', () => { expect(names.length).toBeGreaterThan(10); });
  for (const n of names) it(`${n}: no arrow passes through an unrelated box`, () => {
    const scenes = buildScenes(parseTrace(readFileSync(new URL(n, dir), 'utf8')));
    for (const [i, s] of scenes.entries()) { const c = crossings(s); expect(c.crossing, `${n} event ${i}`).toBe(0); expect(c.shared, `${n} event ${i} near-parallel pairs`).toBe(0); expect(c.labelHits, `${n} event ${i} over captions`).toBe(0); }
  });
  const big = process.env.CODEVIZ_ROUTE_TRACE;
  it.skipIf(!big)('large capture (CODEVIZ_ROUTE_TRACE): final scenes have no crossings', () => {
    const scenes = buildScenes(parseTrace(readFileSync(big!, 'utf8')));
    for (const i of [scenes.length - 1, Math.min(1165, scenes.length - 1)]) { const c = crossings(scenes[i]); console.log('event', i, JSON.stringify(c)); expect(c.crossing).toBe(0); expect(c.labelHits).toBe(0); expect(c.shared).toBe(0); }
  }, SLOW);
});

// The six acceptance programs he chose, with the numbers this slice started from (main 471bee9). A later change may
// improve them; going past one is a regression. arrowCross excludes pairs that share a source or a target, because a
// fan out of one object is meant to converge.
const PROGRAMS: [string, string, number, number, number, number][] = [
  // name, recording, arrowCross, labelOverlap, outOfScene, maxDetour   (measured on 471bee9 with this same counter)
  ['linked list build', 'public/examples/11_linked_list_build.trace.json', 0, 0, 0, 1],
  ['list mutation', 'public/examples/14_array_mutation.trace.json', 0, 0, 0, 1.21],
  ['alias / shallow copy', 'public/examples/06_shallow_copy.trace.json', 1, 0, 0, 3.65],
  ['deque BFS', 'tests/fixtures/m6/queue.m6.json', 181, 0, 0, 5.85],
  ['binary search tree', 'tests/fixtures/m6/bst.m6.json', 56, 1, 0, 1.17],
  ['adjacency list', 'tests/fixtures/m6/adjlist.m6.json', 0, 0, 0, 1],
];
describe('acceptance programs: every arrow inside the frame, none worse than the baseline', () => {
  for (const [name, rel, cross, lo, out, detour] of PROGRAMS) it(name, () => {
    const scenes = buildScenes(parseTrace(readFileSync(new URL('../' + rel, import.meta.url), 'utf8')));
    const step = scenes.length > 60 ? 3 : 1;
    let arrows = 0, c = 0, l = 0, o = 0, d = 0, cg = 0, cc = 0;
    for (let i = 0; i < scenes.length; i += step) { const m = crossings(scenes[i]); arrows += m.arrows; c += m.arrowCross; cg += m.crossGraph; cc += m.crossCard; l += m.labelOverlap; o += m.outOfScene; d = Math.max(d, m.maxDetour); }
    console.log(`3a ${name.padEnd(20)} arrows=${arrows} arrowCross=${c} (graph=${cg} card=${cc}) labelOverlap=${l} outOfScene=${o} maxDetour=${d}`);
    expect(o).toBe(out);
    expect(c).toBeLessThanOrEqual(cross);
    expect(l).toBeLessThanOrEqual(lo);
    expect(d).toBeLessThanOrEqual(detour);
  }, SLOW);
});
