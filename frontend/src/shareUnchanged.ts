// Memory only: after a recording is parsed, make equal parts of neighbouring events the SAME object, and make each
// cumulative stdout/stderr string a slice of the final one. Nothing the replay sees changes (values stay equal, and
// the replay never mutates events), but unchanged heap nodes, frames and output text are stored once instead of once
// per event. On a 1,806-event recording the parsed trace takes about 45% of its memory; on a print-heavy one about 10%.
import type { TraceEvent } from './types';

const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
  for (const k of ka) if (!Object.hasOwn(y, k) || !deepEqual(x[k], y[k])) return false;
  return true;
};
// Plain assignment would hit the special "__proto__" setter for a hostile id; define the own property instead.
const put = (target: object, key: string, value: unknown) => Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });

export function shareUnchanged(events: TraceEvent[]): void {
  const last = events[events.length - 1];
  if (!last) return;
  for (const key of ['stdout', 'stderr'] as const) {
    for (const e of events) {
      const s = e[key];
      // Output is cumulative, so each value is normally a prefix of the last one. A slice shares the last string's storage.
      if (s.length > 12 && s !== last[key] && last[key].startsWith(s)) e[key] = last[key].slice(0, s.length);
    }
  }
  let prev: TraceEvent | undefined;
  for (const e of events) {
    if (prev) {
      for (const id of Object.keys(e.heap)) {
        const before = Object.hasOwn(prev.heap, id) ? prev.heap[id] : undefined;
        if (before !== undefined && before !== e.heap[id] && deepEqual(before, e.heap[id])) put(e.heap, id, before);
      }
      if (prev.frames !== e.frames && deepEqual(prev.frames, e.frames)) e.frames = prev.frames;
      if (prev.truncated !== e.truncated && prev.truncated.length === 0 && e.truncated.length === 0) e.truncated = prev.truncated;
    }
    prev = e;
  }
}

// Development and tests only (never in a production build): freeze the whole parsed recording. Events share objects now,
// so code that edited one event in place would silently change others. With the freeze that mistake throws at once.
export function freezeInDev(events: unknown): void {
  if (!import.meta.env.DEV) return;
  const seen = new Set<object>();
  const walk = (x: unknown) => {
    if (x === null || typeof x !== 'object' || seen.has(x)) return;
    seen.add(x); Object.freeze(x);
    for (const v of Object.values(x)) walk(v);
  };
  walk(events);
}
