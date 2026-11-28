// "What changed": compares two consecutive snapshots and describes, in plain words, what the
// step between them did. Pure function of the two events, so it works for every recording,
// old or new, Python or C++, with no tracer change.
//
// Timing: event n is recorded BEFORE its line runs, so the difference between event n-1 and
// event n is the effect of running event n-1's line (or of entering / leaving a frame).
import type { Frame, HeapNode, TraceEvent, Value } from './types';

export type ChangeKind = 'call' | 'return' | 'exception' | 'new-var' | 'set-var' | 'del-var' | 'new-obj' | 'gone-obj' | 'freed' | 'leak' | 'mutate' | 'output';
export interface Change { kind: ChangeKind; text: string; ids?: string[] }
export interface StepSummary { ranLine?: number; headline: string; changes: Change[] }

const same = (a: Value | undefined, b: Value | undefined) => JSON.stringify(a) === JSON.stringify(b);

// A short, learner-friendly rendering of one value. Strings keep their quotes so 5 and "5" differ.
export function show(v: Value | undefined, nullWord = 'None', max = 24): string {
  if (!v) return '?';
  let s: string;
  switch (v.kind) {
    case 'ref': return v.id;
    case 'opaque': return v.type.startsWith('uninitialised ') ? 'uninitialised' : `${v.type} (opaque)`;
    case 'truncated': return `${v.type} (omitted)`;
    case 'scalar':
      if (v.value === null) return nullWord;
      s = typeof v.value === 'string' ? JSON.stringify(v.value) : typeof v.value === 'boolean' && nullWord === 'None' ? (v.value ? 'True' : 'False') : String(v.value);
  }
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// "list o1" for a heap object, so a learner sees what kind of thing appeared.
const label = (heap: Record<string, HeapNode>, id: string) => (heap[id] ? `${heap[id].type} ${id}` : id);

function describeVar(name: string, before: Value | undefined, after: Value | undefined, nullWord: string, heap: Record<string, HeapNode>, where: string): Change | null {
  if (same(before, after)) return null;
  if (before === undefined && after) {
    if (after.kind === 'opaque' && /^(function|class|type|builtin_function_or_method|module)$/.test(after.type)) return { kind: 'new-var', text: `Defined ${after.type === 'type' ? 'class' : after.type === 'module' ? 'module' : 'function'} ${name}${where}` };
    const ids = after.kind === 'ref' ? [after.id] : undefined;
    return { kind: 'new-var', ids, text: after.kind === 'ref' ? `${name}${where} now refers to ${label(heap, after.id)}` : `${name}${where} = ${show(after, nullWord)}` };
  }
  if (before && after === undefined) return { kind: 'del-var', text: `${name}${where} no longer exists` };
  if (before && after) {
    if (after.kind === 'ref') return { kind: 'set-var', ids: [after.id], text: `${name}${where} now refers to ${label(heap, after.id)}${before.kind === 'ref' ? ` (was ${before.id})` : ` (was ${show(before, nullWord)})`}` };
    return { kind: 'set-var', text: `${name}${where}: ${show(before, nullWord)} → ${show(after, nullWord)}` };
  }
  return null;
}

// Changes inside one object that exists in both snapshots: list/array cells, dict entries, object fields.
function describeObject(id: string, a: HeapNode, b: HeapNode, nullWord: string, heap: Record<string, HeapNode>, out: Change[]) {
  const name = label(heap, id);
  if (a.items && b.items) {
    const n = Math.min(a.items.length, b.items.length), cells: string[] = [];
    for (let i = 0; i < n; i++) if (!same(a.items[i], b.items[i])) cells.push(`[${i}]: ${show(a.items[i], nullWord, 12)} → ${show(b.items[i], nullWord, 12)}`);
    const la = a.length ?? a.items.length, lb = b.length ?? b.items.length;
    if (lb > la) {
      const added = b.items.slice(a.items.length).map((v) => show(v, nullWord, 12));
      out.push({ kind: 'mutate', ids: [id], text: `${name} grew from ${la} to ${lb} item${lb === 1 ? '' : 's'}${added.length && added.length <= 4 ? ` (added ${added.join(', ')})` : ''}` });
    } else if (lb < la) out.push({ kind: 'mutate', ids: [id], text: `${name} shrank from ${la} to ${lb} item${lb === 1 ? '' : 's'}` });
    // A shift (insert or remove at the front) changes every cell; the length line already says it.
    if (cells.length && (lb === la || cells.length <= 3)) out.push({ kind: 'mutate', ids: [id], text: `${name}${cells.length > 4 ? `: ${cells.length} cells changed` : ` ${cells.join(', ')}`}` });
  }
  if (a.entries && b.entries) {
    const key = (v: Value) => JSON.stringify(v);
    const before = new Map(a.entries.map(([k, v]) => [key(k), v])), after = new Map(b.entries.map(([k, v]) => [key(k), v]));
    const parts: string[] = [];
    for (const [k, v] of b.entries) {
      const old = before.get(key(k));
      if (old === undefined) parts.push(`added ${show(k, nullWord, 12)}: ${show(v, nullWord, 12)}`);
      else if (!same(old, v)) parts.push(`${show(k, nullWord, 12)}: ${show(old, nullWord, 12)} → ${show(v, nullWord, 12)}`);
    }
    for (const [k] of a.entries) if (!after.has(key(k))) parts.push(`removed ${show(k, nullWord, 12)}`);
    if (parts.length) out.push({ kind: 'mutate', ids: [id], text: `${name}${parts.length > 4 ? `: ${parts.length} entries changed` : ` ${parts.join(', ')}`}` });
  }
  if (a.fields && b.fields) {
    for (const [f, v] of Object.entries(b.fields)) {
      const old = a.fields[f];
      if (old === undefined) { out.push({ kind: 'mutate', ids: v.kind === 'ref' ? [id, v.id] : [id], text: v.kind === 'ref' ? `${id}.${f} now points to ${label(heap, v.id)}` : `${id}.${f} = ${show(v, nullWord)}` }); continue; }
      if (!same(old, v)) {
        const ids = v.kind === 'ref' ? [id, v.id] : [id];
        out.push({ kind: 'mutate', ids, text: v.kind === 'ref' ? `${id}.${f} now points to ${label(heap, v.id)} (was ${show(old, nullWord)})` : `${id}.${f}: ${show(old, nullWord)} → ${show(v, nullWord)}` });
      }
    }
  }
  if (b.freed && !a.freed) out.push({ kind: 'freed', ids: [id], text: `${name} was freed (delete). Pointers to it are now dangling` });
  if (b.orphan && !a.orphan && !b.freed) out.push({ kind: 'leak', ids: [id], text: `${name} became unreachable without being freed (a leak)` });
}

// Two frame lists share a prefix while the same calls are still active.
function commonFrames(a: Frame[], b: Frame[]) {
  let i = 0;
  while (i < a.length && i < b.length && a[i].depth === b[i].depth && a[i].function === b[i].function) i++;
  return i;
}

const callText = (f: Frame, nullWord: string) => `${f.function}(${Object.entries(f.locals).slice(0, 4).map(([k, v]) => `${k}=${show(v, nullWord, 10)}`).join(', ')}${Object.keys(f.locals).length > 4 ? ', …' : ''})`;

// `lines` (the source split into lines) is optional; with it a class body is named as such instead of as a call.
export function describeStep(prev: TraceEvent | undefined, cur: TraceEvent, nullWord = 'None', lines?: string[]): StepSummary {
  if (!prev) return { headline: 'Start of the recording. Nothing has run yet.', changes: [] };
  const changes: Change[] = [];
  // Same function at the same depth is not proof of the same call: a return followed by a new call of
  // the same function (nested constructors, a loop of calls) must read as finished + called.
  let shared = commonFrames(prev.frames, cur.frames);
  if (prev.event === 'return') shared = Math.min(shared, prev.frames.length - 1);
  if (cur.event === 'call') shared = Math.min(shared, cur.frames.length - 1);
  const isClassBody = (f: Frame, line: number | undefined) => !!line && !!lines && new RegExp(`^\\s*class\\s+${f.function.replace(/[^\w]/g, '')}\\b`).test(lines[line - 1] ?? '');
  const ranLine = prev.line > 0 ? prev.line : undefined;
  let headline = ranLine ? `Line ${ranLine} ran.` : 'The program started.';
  const top = prev.frames[prev.frames.length - 1];
  const leftFn = prev.event === 'return' && prev.frames.length > shared && !isClassBody(top, prev.frames[prev.frames.length - 2]?.line) ? prev.frames[prev.frames.length - 1].function : undefined;
  if (leftFn && leftFn !== '<module>') headline = `${leftFn} finished.`;

  // Frames left (returned or unwound), deepest first.
  for (let i = prev.frames.length - 1; i >= shared; i--) {
    const f = prev.frames[i];
    if (f.function === '<module>' || f.function === '<globals>') continue;
    const rv = i === prev.frames.length - 1 && prev.event === 'return' && f.function !== '__init__' ? prev.return_value : undefined;
    if (isClassBody(f, prev.frames[i - 1]?.line)) continue;   // "Defined class X" follows from the variable change
    changes.push({ kind: 'return', text: rv && !cur.exception_type ? `${f.function} finished and returned ${show(rv, nullWord)}` : `${f.function} finished` });
  }
  // Frames entered.
  for (let i = shared; i < cur.frames.length; i++) {
    const f = cur.frames[i];
    if (f.function === '<module>' || f.function === '<globals>') continue;
    if (isClassBody(f, cur.frames[i - 1]?.line)) { changes.push({ kind: 'call', text: `Running the body of class ${f.function}` }); continue; }
    changes.push({ kind: 'call', text: `Called ${callText(f, nullWord)}` });
    if (i === cur.frames.length - 1) headline = leftFn && leftFn !== '<module>' ? `${leftFn} finished, then ${f.function} was called.` : ranLine ? `Line ${ranLine} called ${f.function}.` : `Called ${f.function}.`;
  }
  // Variables in frames that stayed.
  for (let i = 0; i < shared; i++) {
    const a = prev.frames[i], b = cur.frames[i];
    const where = shared > 1 && i !== shared - 1 ? ` (in ${b.function})` : '';
    const names = new Set([...Object.keys(a.locals), ...Object.keys(b.locals)]);
    for (const n of names) { const c = describeVar(n, a.locals[n], b.locals[n], nullWord, cur.heap, where); if (c) changes.push(c); }
  }
  // Objects: created, changed, gone.
  for (const [id, node] of Object.entries(cur.heap)) {
    const old = prev.heap[id];
    if (!old) changes.push({ kind: 'new-obj', ids: [id], text: `Created ${label(cur.heap, id)}${node.length !== undefined ? ` with ${node.length} item${node.length === 1 ? '' : 's'}` : ''}` });
    else describeObject(id, old, node, nullWord, cur.heap, changes);
  }
  const gone = Object.keys(prev.heap).filter((id) => !cur.heap[id]);
  if (gone.length) changes.push({ kind: 'gone-obj', ids: gone, text: `No longer reachable: ${gone.slice(0, 5).map((id) => label(prev.heap, id)).join(', ')}${gone.length > 5 ? ` and ${gone.length - 5} more` : ''}` });

  if (cur.stdout.length > prev.stdout.length && cur.stdout.startsWith(prev.stdout)) {
    const text = cur.stdout.slice(prev.stdout.length).replace(/\n$/, '');
    changes.push({ kind: 'output', text: `Printed: ${text.length > 60 ? `${text.slice(0, 59)}…` : text}` });
  }
  if (cur.event === 'exception' && cur.exception_type) {
    changes.push({ kind: 'exception', text: `${cur.exception_type} raised. It may still be caught` });
    headline = `${ranLine ? `Line ${ranLine}` : 'This step'} raised ${cur.exception_type}.`;
  }
  if (cur.event === 'return' && !changes.some((c) => c.kind === 'call')) headline = `${ranLine ? `Line ${ranLine} ran. ` : ''}${cur.frames[cur.frames.length - 1]?.function ?? 'The frame'} is returning${cur.return_value && cur.frames[cur.frames.length - 1]?.function !== '__init__' ? ` ${show(cur.return_value, nullWord)}` : ''}.`;
  if (!changes.length && ranLine) headline = `Line ${ranLine} ran. Nothing visible changed.`;
  return { ranLine, headline, changes };
}
