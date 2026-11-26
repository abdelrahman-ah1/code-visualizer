import { freezeInDev, shareUnchanged } from './shareUnchanged';
import type { Trace } from './types';

// This reader deliberately accepts only the documented version, not guessed future shapes.
const LIMIT_KINDS = ['events', 'objects', 'stack_depth', 'output_chars', 'wall_time', 'step_time', 'cpu_time', 'memory', 'recording_size'];
export const MAX_BYTES = 20 * 1024 * 1024;
const fail = (path: string, detail: string): never => { throw new Error(`${path}: ${detail}`); };
function record(x: unknown, p: string): Record<string, unknown> {
  if (!x || typeof x !== 'object' || Array.isArray(x)) fail(p, 'expected an object');
  return x as Record<string, unknown>;
}
function text(x: unknown, p: string): asserts x is string {
  if (typeof x !== 'string') fail(p, 'expected text');
}
function number(x: unknown, p: string): asserts x is number {
  if (typeof x !== 'number' || !Number.isFinite(x) || x < 0) fail(p, 'expected a non-negative number');
}
function integer(x: unknown, p: string): asserts x is number { number(x, p); if (!Number.isInteger(x)) fail(p, 'expected an integer'); }
function boolean(x: unknown, p: string) { if (typeof x !== 'boolean') fail(p, 'expected true or false'); }
function array(x: unknown, p: string): unknown[] {
  if (!Array.isArray(x)) fail(p, 'expected an array');
  return x as unknown[];
}
function optionalBoolean(o: Record<string, unknown>, key: string, p: string) {
  if (o[key] !== undefined) boolean(o[key], `${p}.${key}`);
}
function value(x: unknown, p: string, heap: Record<string, unknown>) {
  const v = record(x, p);
  switch (v.kind) {
    case 'scalar':
      text(v.type, `${p}.type`);
      if (!(v.value === null || ['boolean', 'string', 'number'].includes(typeof v.value))) fail(p, 'invalid scalar');
      if (typeof v.value === 'number' && !Number.isFinite(v.value)) fail(p, 'non-finite JSON number');
      optionalBoolean(v, 'truncated', p); break;
    case 'ref':
      text(v.id, `${p}.id`);
      if (!Object.hasOwn(heap, v.id)) fail(p, `missing heap reference ${v.id}`);
      break;
    case 'opaque': case 'truncated': text(v.type, `${p}.type`); break;
    default: fail(p, 'unknown value kind');
  }
}
function bindings(x: unknown, p: string, heap: Record<string, unknown>) {
  Object.entries(record(x, p)).forEach(([k, v]) => value(v, `${p}.${k}`, heap));
}
// EXPERIMENT (node-pool/1): a recording may store each distinct heap node once in `node_pool`, and each event's
// `heap` as {nodeId: poolIndex}. This turns it back into the ordinary shape (the pooled node objects are shared, not
// copied) so every check and the rest of the viewer run unchanged. Pool nodes are never edited afterwards.
// Resource bound: all later checks and the UI work on the EXPANDED recording, so the work is bounded by the expanded
// size, not the file size. A small file with a big node linked from many events could otherwise cost far more than any
// ordinary file. The expanded size (sum of every linked node's JSON length) is therefore held to `maxExpandedBytes`,
// which defaults to the same 20 MiB limit ordinary recordings have. Raising it for pooled files is a policy choice, not made here.
export interface ParseOptions { maxExpandedBytes?: number }
export function expandNodePool(data: unknown, maxExpanded: number): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const t = data as Record<string, unknown>;
  if (t.encoding === undefined && t.node_pool === undefined) return data;
  // node-pool/1: heap nodes pooled. node-pool/2 adds pooled frames and stdout/stderr stored as lengths into one final text.
  if (t.encoding !== 'node-pool/1' && t.encoding !== 'node-pool/2' && t.encoding !== 'node-pool/3') fail('encoding', 'unsupported recording encoding');
  const v3 = t.encoding === 'node-pool/3', v2 = v3 || t.encoding === 'node-pool/2';
  const rawPool = array(t.node_pool, 'node_pool');
  // node-pool/3: an entry {delta_of, set?, append?} is an earlier entry with some top-level fields replaced and items
  // added at the end. It is rebuilt here, once, sharing the unchanged item objects with the entry it extends.
  const pool: unknown[] = new Array(rawPool.length);
  const weight: (number | undefined)[] = new Array(rawPool.length);   // JSON length of each (rebuilt) entry
  let expanded = 0;
  const charge = (n: number) => { expanded += n; if (expanded > maxExpanded) fail('File', `expands to more than the ${Math.round(maxExpanded / 1048576)} MiB replay limit once its pooled nodes are unpacked`); };
  // Rebuilding is bounded before anything is allocated: each rebuilt entry is charged its JSON size (the base's plus what it
  // adds), against the same limit a plain file has. A chain of one-item appends would otherwise cost far more memory than
  // the file's own size suggests.
  let rebuilt = 0;
  const base0 = (k: number) => (pool[k] && typeof pool[k] === 'object' ? pool[k] : {}) as Record<string, unknown>;
  const sizeOf = (k: number): number => weight[k] ??= JSON.stringify(pool[k]).length;
  rawPool.forEach((entry, k) => {
    if (!v3 || !entry || typeof entry !== 'object' || Array.isArray(entry) || !Object.hasOwn(entry, 'delta_of')) { pool[k] = entry; return; }
    const d = entry as Record<string, unknown>, at = `node_pool[${k}]`;
    if (typeof d.delta_of !== 'number' || !Number.isInteger(d.delta_of) || d.delta_of < 0 || d.delta_of >= k) fail(at, 'bad delta base');
    const base = pool[d.delta_of as number] as Record<string, unknown>;
    if (!base || typeof base !== 'object' || Array.isArray(base)) fail(at, 'delta base is not a node');
    for (const key of Object.keys(d)) if (key !== 'delta_of' && key !== 'set' && key !== 'append') fail(at, 'unknown delta field');
    let cost = sizeOf(d.delta_of as number) + (d.append === undefined ? 0 : JSON.stringify(d.append).length);
    if (d.set !== undefined && typeof d.set === 'object' && d.set !== null && !Array.isArray(d.set)) {
      // a replaced field costs only its growth, so a chain of small edits is not counted as growing for ever
      for (const [key, v] of Object.entries(d.set)) cost += Math.max(0, JSON.stringify(v).length - (Object.hasOwn(base0(d.delta_of as number), key) ? JSON.stringify(base0(d.delta_of as number)[key]).length : -key.length - 4));
    }
    rebuilt += cost;
    if (rebuilt > maxExpanded) fail('File', `expands to more than the ${Math.round(maxExpanded / 1048576)} MiB replay limit once its pooled nodes are unpacked`);
    weight[k] = cost;
    const node: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(base)) Object.defineProperty(node, key, { value: v, enumerable: true, writable: true, configurable: true });
    if (d.set !== undefined) for (const [key, v] of Object.entries(record(d.set, `${at}.set`))) {
      if (key === 'items') fail(at, 'items change by append only');
      Object.defineProperty(node, key, { value: v, enumerable: true, writable: true, configurable: true });
    }
    if (d.append !== undefined) {
      const more = array(d.append, `${at}.append`), items = base.items;
      if (!Array.isArray(items)) fail(at, 'append needs a list base');
      Object.defineProperty(node, 'items', { value: (items as unknown[]).concat(more), enumerable: true, writable: true, configurable: true });
    }
    pool[k] = node;
  });
  const framePool = v2 ? array(t.frame_pool, 'frame_pool') : [];
  const texts: Record<string, string | undefined> = { stdout: undefined, stderr: undefined };
  if (v2) for (const k of ['stdout', 'stderr']) { const v = t[`${k}_text`]; if (v !== undefined) { if (typeof v !== 'string') fail(`${k}_text`, 'expected text'); texts[k] = v as string; } }
  const events = array(t.events, 'events');
  if (events.length > 10000) fail('events', 'more than the 10,000-event replay limit');
  const fweight: (number | undefined)[] = new Array(framePool.length);
  const out = events.map((raw, i) => {
    const e = record(raw, `events[${i}]`);
    const links = record(e.heap, `events[${i}].heap`);
    const heap: Record<string, unknown> = {};
    for (const [id, idx] of Object.entries(links)) {
      if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0 || idx >= pool.length) fail(`events[${i}].heap.${id}`, 'bad node pool index');
      const k = idx as number;
      charge((weight[k] ??= JSON.stringify(pool[k]).length) + id.length + 4);
      Object.defineProperty(heap, id, { value: pool[k], enumerable: true, writable: true, configurable: true });   // own property even for "__proto__"
    }
    const r: Record<string, unknown> = { ...e, heap };
    if (v2) {
      if (typeof e.frames === 'number') {
        const k = e.frames;
        if (!Number.isInteger(k) || k < 0 || k >= framePool.length) fail(`events[${i}].frames`, 'bad frame pool index');
        charge(fweight[k] ??= JSON.stringify(framePool[k]).length);
        r.frames = framePool[k];
      }
      for (const key of ['stdout', 'stderr']) {
        const v = e[key];
        if (typeof v !== 'number') continue;
        const text = texts[key];
        if (text === undefined || !Number.isInteger(v) || v < 0 || v > text.length) fail(`events[${i}].${key}`, 'bad output length');
        charge(v);
        r[key] = (text as string).slice(0, v);
      }
    }
    return r;
  });
  const { encoding: _e, node_pool: _p, frame_pool: _f, stdout_text: _o, stderr_text: _r, ...rest } = t;
  return { ...rest, events: out };
}
export function parseTrace(raw: string, opts: ParseOptions = {}): Trace {
  if (new TextEncoder().encode(raw).length > MAX_BYTES) fail('File', 'larger than the 20 MiB replay limit');
  let data: unknown;
  try { data = JSON.parse(raw); } catch { fail('File', 'not valid JSON'); }
  data = expandNodePool(data, opts.maxExpandedBytes ?? MAX_BYTES);
  const t = record(data, 'Trace');
  if (t.schema_version !== 'codeviz.trace/1.0') fail('schema_version', 'supported version is codeviz.trace/1.0');
  text(t.source, 'source');
  const runtime = record(t.runtime, 'runtime');
  text(runtime.implementation, 'runtime.implementation'); text(runtime.version, 'runtime.version');
  const limits = record(t.limits, 'limits');
  number(limits.wall_seconds, 'limits.wall_seconds'); integer(limits.events, 'limits.events'); integer(limits.output_chars, 'limits.output_chars');
  if (!['ok', 'error', 'timeout', 'trace_limit', 'output_limit', 'unsupported', 'worker_error'].includes(String(t.status))) fail('status', 'unknown run status');
  boolean(t.complete, 'complete');
  if (t.complete !== (t.status === 'ok' || t.status === 'error')) fail('complete', 'inconsistent with run status');
  for (const key of ['stdout', 'stderr']) if (t[key] !== undefined) text(t[key], key);
  optionalBoolean(t, 'resource_limits_applied', 'Trace');
  if (t.limit_hit !== undefined) {
    const h = record(t.limit_hit, 'limit_hit');
    if (!LIMIT_KINDS.includes(String(h.kind))) fail('limit_hit.kind', 'unknown limit');
    if (h.limit !== undefined) number(h.limit, 'limit_hit.limit');
  }
  if (t.error !== undefined) {
    const e = record(t.error, 'error'); text(e.type, 'error.type');
    if (e.line !== undefined) integer(e.line, 'error.line');
  }
  if (t.diagnostics !== undefined) {
    const list = array(t.diagnostics, 'diagnostics');
    if (list.length > 100) fail('diagnostics', 'more than 100 entries');
    list.forEach((raw, i) => {
      const d = record(raw, `diagnostics[${i}]`);
      text(d.source, `diagnostics[${i}].source`); text(d.kind, `diagnostics[${i}].kind`); text(d.message, `diagnostics[${i}].message`);
      if (!['error', 'warning', 'info'].includes(String(d.severity))) fail(`diagnostics[${i}]`, 'unknown severity');
      for (const key of ['line', 'column', 'freed_line', 'allocated_line']) if (d[key] !== undefined) integer(d[key], `diagnostics[${i}].${key}`);
    });
  }
  if (t.exit_code !== undefined && (typeof t.exit_code !== 'number' || !Number.isInteger(t.exit_code))) fail('exit_code', 'expected an integer');
  const events = array(t.events, 'events');
  if (events.length > 10000) fail('events', 'more than the 10,000-event replay limit');
  if (events.length > limits.events) fail('events', 'exceeds declared event budget');
  events.forEach((rawEvent, i) => {
    const p = `events[${i}]`, e = record(rawEvent, p);
    if (e.step !== i) fail(`${p}.step`, 'expected consecutive steps starting at zero');
    if (!['call', 'line', 'return', 'exception'].includes(String(e.event))) fail(p, 'unknown event type');
    integer(e.line, `${p}.line`);
    text(e.stdout, `${p}.stdout`); text(e.stderr, `${p}.stderr`);
    array(e.truncated, `${p}.truncated`).forEach((x) => text(x, `${p}.truncated`));
    if (e.unreached_heap !== undefined) { const u = record(e.unreached_heap, `${p}.unreached_heap`); integer(u.count, `${p}.unreached_heap.count`); integer(u.bytes, `${p}.unreached_heap.bytes`); }
    const heap = record(e.heap, `${p}.heap`);
    Object.entries(heap).forEach(([id, rawNode]) => {
      const np = `${p}.heap.${id}`, n = record(rawNode, np);
      text(n.type, `${np}.type`); optionalBoolean(n, 'truncated', np); optionalBoolean(n, 'opaque', np); optionalBoolean(n, 'orphan', np);
      if (n.length !== undefined) integer(n.length, `${np}.length`);
      if (n.items !== undefined) array(n.items, `${np}.items`).forEach((v) => value(v, `${np}.items`, heap));
      if (n.entries !== undefined) array(n.entries, `${np}.entries`).forEach((entry) => {
        const pair = array(entry, `${np}.entry`);
        if (pair.length !== 2) fail(np, 'dictionary entries must be key/value pairs');
        pair.forEach((v) => value(v, `${np}.entry`, heap));
      });
      if (n.fields !== undefined) bindings(n.fields, `${np}.fields`, heap);
      if (['list', 'tuple', 'array', 'std::vector'].includes(n.type) && (n.items === undefined || n.length === undefined)) fail(np, 'sequence requires items and length');
      optionalBoolean(n, 'freed', np);
      for (const key of ['storage', 'address', 'element_type']) if (n[key] !== undefined) text(n[key], `${np}.${key}`);
      if (n.type === 'dict' && n.entries === undefined) fail(np, 'dictionary requires entries');
    });
    const frames = array(e.frames, `${p}.frames`);
    if (!frames.length) fail(`${p}.frames`, 'snapshot needs a frame');
    frames.forEach((rawFrame, depth) => {
      const f = record(rawFrame, `${p}.frames[${depth}]`);
      if (f.depth !== depth) fail(p, 'frame depths must start at zero');
      text(f.function, `${p}.function`); integer(f.line, `${p}.frame.line`);
      bindings(f.locals, `${p}.locals`, heap);
    });
    if (e.event === 'return') value(e.return_value, `${p}.return_value`, heap);
    if (e.event === 'exception') text(e.exception_type, `${p}.exception_type`);
  });
  const trace = data as Trace;
  shareUnchanged(trace.events);
  freezeInDev(trace.events);
  return trace;
}
