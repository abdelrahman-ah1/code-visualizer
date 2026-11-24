import { useMemo } from 'react';
import type { Trace } from '../types';
import { usePlayback } from '../usePlayback';
import { eventMeaning, outputAt, statusMeaning } from '../replay';
import { Controls } from './Controls';
import { Source } from './Source';
import { Memory } from './Memory';
import { ValueView } from './ValueView';
export function Replay({ trace }: { trace: Trace }) {
  const p = usePlayback(trace.events.length), event = trace.events[p.index];
  const lines = useMemo(() => trace.source.split('\n'), [trace.source]);
  const atEnd = !trace.events.length || p.index === trace.events.length - 1;
  return <><div className={`run-status ${trace.status === 'ok' ? '' : 'warning'}`}><b>Recorded run: {trace.status}</b><span>{statusMeaning[trace.status]}. {trace.complete ? 'Final record captured.' : 'Incomplete capture.'}</span><small>{trace.runtime.implementation} {trace.runtime.version}{trace.error ? ` · ${trace.error.type}${trace.error.line ? ` on line ${trace.error.line}` : ''}` : ''}</small></div>
    <Controls playback={p} count={trace.events.length}/>
    <div className="event-status" role="status">{event ? <><b>{event.event} · step {event.step} · line {event.line}</b><span>{eventMeaning(event)}</span>{event.exception_type && <span className="warning">{event.exception_type}</span>}{event.return_value && <span>Recorded return value: <ValueView value={event.return_value}/></span>}{event.truncated.length > 0 && <span className="warning">Snapshot omissions: {event.truncated.join(', ')}</span>}</> : <b>No snapshots captured. The run status and final output still apply.</b>}</div>
    <div className="workspace"><Source lines={lines} line={event?.line}/>{event && <Memory event={event}/>}</div>
    <section className="panel output"><h2>Captured output <small>{atEnd ? 'final record, if available' : 'at this snapshot'}</small></h2>
      {(trace.stdout === undefined || trace.stderr === undefined) && <p className="warning">Final output is missing. At the end, the last checkpoint is shown and may lag.</p>}
      <div className="output-grid">{(['stdout', 'stderr'] as const).map((stream) => <div key={stream}><h3>{stream}</h3><pre data-testid={stream}>{outputAt(trace, p.index, stream) || '(empty)'}</pre></div>)}</div>
    </section><p className="hint">Replay reads saved states only. It does not run code or undo the original program's side effects. Complete capture does not guarantee a complete heap.</p></>;
}
