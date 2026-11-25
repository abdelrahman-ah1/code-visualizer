import type { Trace } from './types';

// This reader deliberately accepts only the documented version, not guessed future shapes.
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
export function parseTrace(raw: string): Trace {
  if (new TextEncoder().encode(raw).length > MAX_BYTES) fail('File', 'larger than the 20 MiB replay limit');
  let data: unknown;
  try { data = JSON.parse(raw); } catch { fail('File', 'not valid JSON'); }
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
  return data as Trace;
}
