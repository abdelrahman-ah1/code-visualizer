// M4: breakpoints on RECORDED events. Nothing here runs code.
//
// Definition (agreed in agent.md for M4): a breakpoint on line N stops at every recorded `line`
// event whose line is N. Because a `line` event is a snapshot taken BEFORE the line executes,
// stopping there shows the state just before line N runs, like a debugger paused on that line.
// `call`, `return` and `exception` events never trigger a breakpoint, so a recursive call does
// not stop twice for the same source line.
import type { TraceEvent } from './types';

// line number -> ascending event indexes. Built once per trace (one pass), then every lookup
// is a map read plus a sort of only the chosen lines, never a rescan of all events.
export type LineIndex = Map<number, number[]>;

export function buildLineIndex(events: readonly TraceEvent[]): LineIndex {
  const index: LineIndex = new Map();
  events.forEach((event, i) => {
    if (event.event !== 'line') return;
    const list = index.get(event.line);
    if (list) list.push(i); else index.set(event.line, [i]);
  });
  return index;
}

// All event indexes where any chosen line stops, ascending. Lines with no recorded `line`
// event contribute nothing (see unreachedLines).
export function stopIndexes(index: LineIndex, lines: ReadonlySet<number>): number[] {
  const out: number[] = [];
  for (const line of lines) { const hits = index.get(line); if (hits) out.push(...hits); }
  return out.sort((a, b) => a - b);
}

// Chosen lines that never run in this recording (so they can never stop). Shown to the user
// instead of silently doing nothing.
export function unreachedLines(index: LineIndex, lines: ReadonlySet<number>): number[] {
  return [...lines].filter((line) => !index.has(line)).sort((a, b) => a - b);
}

// Binary searches over the ascending stop list: O(log n) per query.
export function nextStop(stops: readonly number[], from: number): number | undefined {
  let lo = 0, hi = stops.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (stops[mid] <= from) lo = mid + 1; else hi = mid; }
  return stops[lo];
}
export function prevStop(stops: readonly number[], from: number): number | undefined {
  let lo = 0, hi = stops.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (stops[mid] < from) lo = mid + 1; else hi = mid; }
  return stops[lo - 1];
}
export function isStop(stops: readonly number[], at: number): boolean {
  const next = nextStop(stops, at - 1);
  return next === at;
}
