import type { Trace } from './types';
// EXPERIMENT: writer for the node-pool/1 recording format (reader lives in parseTrace.ts).
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
    return { ...e, heap: links };
  });
  const out = { ...trace, events, encoding: 'node-pool/1', node_pool: pool };
  const text = JSON.stringify(out);
  // Check before use: unpacking what was just written must give back exactly the recording that was loaded.
  let ok = false;
  try {
    const back = JSON.parse(text) as { events: { heap: Record<string, number> }[]; node_pool: unknown[] };
    const rebuilt = back.events.map((e) => ({ ...e, heap: Object.fromEntries(Object.entries(e.heap).map(([id, i]) => [id, back.node_pool[i]])) }));
    ok = canon(rebuilt) === canon(trace.events);
  } catch { ok = false; }
  if (!ok) return { text: rawFull, pooled: false, uniqueNodes: pool.length, reason: 'check failed, wrote the ordinary format' };
  if (text.length >= rawFull.length) return { text: rawFull, pooled: false, uniqueNodes: pool.length, reason: 'not smaller, wrote the ordinary format' };
  return { text, pooled: true, uniqueNodes: pool.length };
}
