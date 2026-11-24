import type { Trace, TraceEvent } from './types';
export const clampStep = (index: number, count: number) => Math.max(0, Math.min(Math.trunc(index), Math.max(0, count - 1)));
// Snapshot checkpoints replace output; replay never appends them.
export function outputAt(trace: Trace, index: number, stream: 'stdout' | 'stderr') {
  const event = trace.events[index];
  return (!trace.events.length || index === trace.events.length - 1) ? (trace[stream] ?? event?.[stream] ?? '') : (event?.[stream] ?? '');
}
export function eventMeaning(e: TraceEvent) {
  switch (e.event) {
    case 'line': return 'Before this line executes';
    case 'call': return 'Frame entered. Parameters are bound';
    case 'return': return 'Frame returning or unwinding. Not necessarily a successful result';
    case 'exception': return 'Exception raised or propagated. It may still be caught';
  }
}
export const statusMeaning = {
  ok: 'Run finished normally', error: 'Run ended with a captured exception',
  timeout: 'Worker timed out. Last checkpoint may lag behind execution',
  trace_limit: 'Capture stopped at an event, object or stack limit',
  output_limit: 'Capture stopped at the output limit', unsupported: 'Program uses an unsupported construct',
  worker_error: 'Worker or protocol failed. This is not a user-code exception',
};
