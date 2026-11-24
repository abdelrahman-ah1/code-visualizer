// M4: variable watch over RECORDED data. No eval, no code execution: a watch is a small path
// like `head.next.value` or `items[2]` that is walked through the saved frames and heap.
//
// Lookup follows Python's own order for a plain name: the innermost (current) frame's locals
// first, then the module frame (depth 0), which holds the globals. Enclosing function frames
// are not searched, because Python does not search them either (no closures are modeled).
import type { HeapNode, Trace, TraceEvent, Value } from './types';

export type Step = { kind: 'field'; name: string } | { kind: 'index'; index: number } | { kind: 'key'; key: string };
export interface WatchPath { text: string; root: string; steps: Step[] }
export type Parsed = { ok: true; path: WatchPath } | { ok: false; error: string };

export const MAX_WATCHES = 8;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*/;

// Grammar: name ( .name | [int] | ['text'] | ["text"] )*   up to 80 characters.
export function parseWatch(input: string): Parsed {
  const text = input.trim();
  if (!text) return { ok: false, error: 'Type a variable name, like total or head.next.value' };
  if (text.length > 80) return { ok: false, error: 'Watch expressions are limited to 80 characters' };
  const rootMatch = IDENT.exec(text);
  if (!rootMatch) return { ok: false, error: 'Start with a variable name' };
  const steps: Step[] = [];
  let at = rootMatch[0].length;
  while (at < text.length) {
    const rest = text.slice(at);
    let m: RegExpExecArray | null;
    if (rest[0] === '.' && (m = IDENT.exec(rest.slice(1)))) { steps.push({ kind: 'field', name: m[0] }); at += 1 + m[0].length; }
    else if ((m = /^\[\s*(-?\d+)\s*\]/.exec(rest))) { steps.push({ kind: 'index', index: Number(m[1]) }); at += m[0].length; }
    else if ((m = /^\[\s*(?:'([^'\\]*)'|"([^"\\]*)")\s*\]/.exec(rest))) { steps.push({ kind: 'key', key: m[1] ?? m[2] }); at += m[0].length; }
    else return { ok: false, error: `Cannot read "${rest.slice(0, 12)}". Use names, .field, [0] or ['key'] only` };
  }
  return { ok: true, path: { text, root: rootMatch[0], steps } };
}

export type Resolved = { ok: true; value: Value } | { ok: false; reason: string };

function child(event: TraceEvent, value: Value, step: Step): Resolved {
  if (value.kind !== 'ref') return { ok: false, reason: value.kind === 'scalar' ? `a ${value.type} has no members` : 'not expandable' };
  const node: HeapNode | undefined = event.heap[value.id];
  if (!node) return { ok: false, reason: 'object not captured' };
  if (step.kind === 'field') {
    const hit = node.fields?.[step.name];
    return hit ? { ok: true, value: hit } : { ok: false, reason: node.opaque ? 'object internals not captured' : `no field ${step.name}` };
  }
  if (step.kind === 'index') {
    if (!node.items) return { ok: false, reason: `${node.type} is not a list or tuple` };
    const length = node.length ?? node.items.length, at = step.index < 0 ? length + step.index : step.index;
    if (at < 0 || at >= length) return { ok: false, reason: 'index out of range' };
    return at < node.items.length ? { ok: true, value: node.items[at] } : { ok: false, reason: 'item beyond the captured 40' };
  }
  if (!node.entries) return { ok: false, reason: `${node.type} is not a dict` };
  const entry = node.entries.find(([k]) => k.kind === 'scalar' && k.type === 'str' && k.value === step.key);
  return entry ? { ok: true, value: entry[1] } : { ok: false, reason: `no key '${step.key}'` };
}

export function resolveWatch(event: TraceEvent, path: WatchPath): Resolved {
  const frames = event.frames;
  const local = frames[frames.length - 1].locals[path.root] ?? frames[0].locals[path.root];
  if (!local) return { ok: false, reason: 'not in scope at this step' };
  let current: Resolved = { ok: true, value: local };
  for (const step of path.steps) {
    if (!current.ok) break;
    current = child(event, current.value, step);
  }
  return current;
}

function quote(s: string) { return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`; }
function scalarText(v: Extract<Value, { kind: 'scalar' }>): string {
  if (v.value === null) return 'None';
  if (typeof v.value === 'boolean') return v.value ? 'True' : 'False';
  return v.type === 'str' ? quote(String(v.value)) : String(v.value);
}

// Short human text for one value, depth-limited. Cycles print as <oN>.
export function describe(event: TraceEvent, value: Value, depth = 2, seen: Set<string> = new Set()): string {
  if (value.kind === 'scalar') return scalarText(value);
  if (value.kind === 'opaque') return `<${value.type}>`;
  if (value.kind === 'truncated') return '...';
  const node = event.heap[value.id];
  if (!node) return `<${value.id}>`;
  if (seen.has(value.id) || depth < 0) return `<${value.id}>`;
  seen.add(value.id);
  const part = (v: Value) => describe(event, v, depth - 1, seen);
  let out: string;
  if (node.items) {
    const shown = node.items.slice(0, 8).map(part);
    const more = (node.length ?? node.items.length) > shown.length ? ', ...' : '';
    out = node.type === 'tuple' ? `(${shown.join(', ')}${more})` : `[${shown.join(', ')}${more}]`;
  } else if (node.entries) {
    const shown = node.entries.slice(0, 6).map(([k, v]) => `${part(k)}: ${part(v)}`);
    out = `{${shown.join(', ')}${node.entries.length > 6 ? ', ...' : ''}}`;
  } else if (node.fields) {
    out = `${node.type}(${Object.entries(node.fields).slice(0, 6).map(([k, v]) => `${k}=${part(v)}`).join(', ')})`;
  } else out = `<${node.type}>`;
  seen.delete(value.id);
  return out.length > 160 ? out.slice(0, 157) + '...' : out;
}

// A string that is equal exactly when the watched value is unchanged. It includes object IDs
// (rebinding a name to a different but equal-looking list IS a change) and walks the whole
// reachable structure (a deep mutation IS a change). IDs make cycles safe: a node already
// on the current path is written as its ID only.
function signature(event: TraceEvent, value: Value, path: Set<string>): string {
  if (value.kind === 'scalar') return `${value.type}:${String(value.value)}`;
  if (value.kind !== 'ref') return value.kind + ':' + value.type;
  const node = event.heap[value.id];
  if (!node || path.has(value.id)) return value.id;
  path.add(value.id);
  const part = (v: Value) => signature(event, v, path);
  const body = node.items ? node.items.map(part).join(',')
    : node.entries ? node.entries.map(([k, v]) => part(k) + '=>' + part(v)).join(',')
    : node.fields ? Object.entries(node.fields).map(([k, v]) => k + '=' + part(v)).join(',') : '';
  path.delete(value.id);
  return `${value.id}{${node.type}${node.truncated ? '+' : ''}|${body}}`;
}

const MISSING = '\u0000missing';

// One signature per event: computed once when a watch is added, then every "changed here?"
// or "next change" question is an array read.
export function watchSignatures(trace: Trace, path: WatchPath): string[] {
  return trace.events.map((event) => {
    const r = resolveWatch(event, path);
    return r.ok ? signature(event, r.value, new Set()) : MISSING;
  });
}

// Event indexes where the watched value differs from the previous event. Index 0 never counts
// (nothing precedes it); the first time a name appears does count.
export function changeIndexes(signatures: readonly string[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < signatures.length; i++) if (signatures[i] !== signatures[i - 1]) out.push(i);
  return out;
}
