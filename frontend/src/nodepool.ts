import type { Trace } from './types';
import { expandNodePool } from './parseTrace';
// EXPERIMENT: writer for the node-pool/2 recording format (the reader also accepts node-pool/1) (reader lives in parseTrace.ts).
// A node is stored once; each event's heap becomes {nodeId: poolIndex}. Equality of two nodes is equality of their
// complete canonical text (keys sorted), compared by the Map, so there is no digest and no collision possibility.
function canon(x: unknown): string {
  if (x === null || typeof x !== 'object') return JSON.stringify(x);
  if (Array.isArray(x)) return '[' + x.map(canon).join(',') + ']';
  const o = x as Record<string, unknown>;
  return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + canon(o[k])).join(',') + '}';
}
export interface Pooled { text: string; pooled: boolean; uniqueNodes: number; reason?: string }
export function encodeNodePool(trace: Trace, rawFull: string): Pooled {
  const pool: unknown[] = [], index = new Map<string, number>();
  const events = trace.events.map((e) => {
    const links: Record<string, number> = {};
    for (const [id, node] of Object.entries(e.heap)) {
      const key = canon(node); let i = index.get(key);
      if (i === undefined) { i = pool.length; index.set(key, i); pool.push(node); }
      Object.defineProperty(links, id, { value: i, enumerable: true, writable: true, configurable: true });
    }
    return { ...e, heap: links } as Record<string, unknown>;
  });
  // node-pool/2 extras. Frames: each distinct frame list once. Output: cumulative stdout/stderr become lengths into the
  // final text, but only when every event's text is a prefix of the last one (otherwise that stream stays as written).
  const framePool: unknown[] = [], frameIndex = new Map<string, number>();
  trace.events.forEach((e, n) => {
    const key = canon(e.frames); let i = frameIndex.get(key);
    if (i === undefined) { i = framePool.length; frameIndex.set(key, i); framePool.push(e.frames); }
    events[n].frames = i;
  });
  const extra: Record<string, string> = {};
  const lastEvent = trace.events[trace.events.length - 1];
  for (const k of ['stdout', 'stderr'] as const) {
    if (!lastEvent || !trace.events.every((e) => typeof e[k] === 'string' && lastEvent[k].startsWith(e[k]))) continue;
    extra[`${k}_text`] = lastEvent[k];
    trace.events.forEach((e, n) => { events[n][k] = e[k].length; });
  }
  const out = { ...trace, events, encoding: 'node-pool/2', node_pool: pool, frame_pool: framePool, ...extra };
  const text = JSON.stringify(out);
  // Check before use: unpacking what was just written must give back exactly the recording that was loaded.
  let ok = false;
  try {
    const rebuilt = (expandNodePool(JSON.parse(text), Infinity) as { events: unknown[] }).events;   // the real reader, so the check covers what will be read back
    ok = canon(rebuilt) === canon(trace.events);
  } catch { ok = false; }
  if (!ok) return { text: rawFull, pooled: false, uniqueNodes: pool.length, reason: 'check failed, wrote the ordinary format' };
  if (text.length >= rawFull.length) return { text: rawFull, pooled: false, uniqueNodes: pool.length, reason: 'not smaller, wrote the ordinary format' };
  return { text, pooled: true, uniqueNodes: pool.length };
}
