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
export function crossings(scene: Scene): { arrows: number; crossing: number; worst: number; shared: number; labelHits: number } {
  const boxes = Object.values(scene.boxes);
  let crossing = 0, worst = 0, arrows = 0, labelHits = 0;
  const labels = labelRects(scene.boxes, scene.tags);
  const paths: { to: string; pts: Pt[] }[] = [];
  scene.links.forEach((l, li) => {
    const a = scene.boxes[l.from], b = scene.boxes[l.to], d = linkPath(l, scene.boxes);
    if (!a || !b || !d) return;
    arrows++;
    const pts = samplePath(d, a.x, a.y);
    const hit = boxes.filter((o) => (o.id !== a.id || (a.kind === 'array' && !l.port)) && o.id !== b.id && pts.some((p) => p.x > o.x + 2 && p.x < o.x + o.w - 2 && p.y > o.y + 2 && p.y < o.y + o.h - 2));
    if (hit.length) { crossing++; worst = Math.max(worst, hit.length); }
    // name pills and id captions of other boxes (a thin line over a caption is milder than over a box; reported, not asserted)
    if (labels.some((o) => !o.id.startsWith(`${a.id}:`) && !o.id.startsWith(`${b.id}:`) && pts.some((p) => p.x > o.x && p.x < o.x + o.w && p.y > o.y && p.y < o.y + o.h))) labelHits++;
    paths.push({ to: l.to, pts: resample(pts) });
  });
  // Near-parallel: two arrows to different targets that stay within 6px of each other for 14+ samples (about 80px), ends excluded.
  let shared = 0;
  for (let i = 0; i < paths.length; i++) for (let j = i + 1; j < paths.length; j++) {
    if (paths[i].to === paths[j].to) continue;
    let c = 0; const P = paths[i].pts, Q = paths[j].pts;
    for (let k = 7; k < P.length - 7; k++) if (Q.slice(7, Q.length - 7).some((q) => Math.hypot(q.x - P[k].x, q.y - P[k].y) < 6)) c++;
    if (c >= 14) shared++;
  }
  return { arrows, crossing, worst, shared, labelHits };
}
const dir = new URL('../public/examples/', import.meta.url);
const names = readdirSync(dir).filter((f) => f.endsWith('.trace.json'));
describe('arrow routing', () => {
  it('reports arrows over other boxes' + "'" + ' name pills and captions', () => {
    let arrows = 0, hits = 0;
    for (const n of names) for (const s of buildScenes(parseTrace(readFileSync(new URL(n, dir), 'utf8')))) { const c = crossings(s); arrows += c.arrows; hits += c.labelHits; }
    console.log('label hits over all examples/events', hits, 'of', arrows, 'arrows');
  });
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
  });
});
