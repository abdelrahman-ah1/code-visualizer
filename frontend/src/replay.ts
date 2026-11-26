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
  ok: 'Run finished normally', error: 'Run ended with an error: an exception, a crash or a compile error',
  timeout: 'Worker timed out. Last checkpoint may lag behind execution',
  trace_limit: 'Capture stopped at an event, stack or recording-size limit. The program may have continued',
  output_limit: 'Capture stopped at the output limit', unsupported: 'Program uses an unsupported construct',
  worker_error: 'Worker or protocol failed. This is not a user-code exception',
};

// Which limit ended the run, in plain words. Empty when the recording does not say (older files) or no limit was hit.
export function limitText(hit: Trace['limit_hit']): string {
  if (!hit) return '';
  const n = hit.limit === undefined ? '' : hit.limit.toLocaleString('en-US');
  switch (hit.kind) {
    case 'events': return `It stopped at the ${n}-event limit, so the program may have kept running. Raise "Event limit" to record more.`;
    case 'objects': return `It stopped because the program created more than ${n} distinct objects to track.`;
    case 'stack_depth': return `It stopped because calls were nested more than ${n} deep.`;
    case 'output_chars': return `It stopped at the ${n}-character output limit.`;
    case 'wall_time': return `It stopped at the ${n} s time limit. Raise "Time limit" to let it run longer.`;
    case 'step_time': return `It stayed on one line for more than ${n} s, which usually means an endless loop. Recording stopped there.`;
    case 'cpu_time': return `It was ended by the ${n} s CPU-time backstop, which sits above the time limit.`;
    case 'memory': return `It ran out of memory: the ${Math.round((hit.limit ?? 0) / 1048576)} MiB allowance is shared by the program and the recorder, so this does not by itself show which one needed it.`;
    case 'recording_size': return `It stopped because the recording reached the ${n === '' ? '' : Math.round((hit.limit ?? 0) / 1048576) + ' MiB '}file size limit.`;
  }
}
