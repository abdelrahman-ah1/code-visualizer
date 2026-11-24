import { useMemo } from 'react';
import type { Trace } from '../types';
import { usePlayback } from '../usePlayback';
import { eventMeaning, outputAt, statusMeaning } from '../replay';
import { Controls } from './Controls';
import { Source } from './Source';
import { Memory } from './Memory';
import { Structures } from './Structures';
import { buildScenes } from '../structures';
import { ValueView } from './ValueView';
import { Watch } from './Watch';
import { buildLineIndex, stopIndexes, unreachedLines } from '../breakpoints';
interface Props { trace: Trace; breakpoints: ReadonlySet<number>; onToggleBreakpoint: (line: number) => void; watches: string[]; onAddWatch: (text: string) => string | null; onRemoveWatch: (text: string) => void }
export function Replay({ trace, breakpoints, onToggleBreakpoint, watches, onAddWatch, onRemoveWatch }: Props) {
  // Built once per trace; stops are recomputed only when the chosen lines change.
  const lineIndex = useMemo(() => buildLineIndex(trace.events), [trace]);
  const stops = useMemo(() => stopIndexes(lineIndex, breakpoints), [lineIndex, breakpoints]);
  const unreached = useMemo(() => unreachedLines(lineIndex, breakpoints), [lineIndex, breakpoints]);
  const p = usePlayback(trace.events.length, stops), event = trace.events[p.index];
  const scenes = useMemo(() => buildScenes(trace), [trace]);
  const lines = useMemo(() => trace.source.split('\n'), [trace.source]);
  const atEnd = !trace.events.length || p.index === trace.events.length - 1;
  return <><div className={`run-status ${trace.status === 'ok' ? '' : 'warning'}`}><b>Recorded run: {trace.status}</b><span>{statusMeaning[trace.status]}. {trace.complete ? 'Final record captured.' : 'Incomplete capture.'}</span><small>{trace.runtime.implementation} {trace.runtime.version}{trace.error ? ` · ${trace.error.type}${trace.error.line ? ` on line ${trace.error.line}` : ''}` : ''}</small></div>
    <Controls playback={p} count={trace.events.length} stops={stops}/>
    <p className="hint breakpoint-note" data-testid="breakpoint-note">{breakpoints.size ? `Breakpoints: line ${[...breakpoints].sort((a, b) => a - b).join(', ')}. Play stops before each one runs.${unreached.length ? ` Never reached in this recording: ${unreached.join(', ')}.` : ''}` : 'Click a line number in the source to set a breakpoint. Breakpoints stop at recorded steps, they do not re-run the program.'}</p>
    <div className="event-status" role="status">{event ? <><b>{event.event} · step {event.step} · line {event.line}</b><span>{eventMeaning(event)}</span>{p.atBreakpoint && <span className="bp-hit" data-testid="breakpoint-hit">Breakpoint · line {event.line}</span>}{event.exception_type && <span className="warning">{event.exception_type}</span>}{event.return_value && <span>Recorded return value: <ValueView value={event.return_value}/></span>}{event.truncated.length > 0 && <span className="warning">Snapshot omissions: {event.truncated.join(', ')}</span>}</> : <b>No snapshots captured. The run status and final output still apply.</b>}</div>
    {event && <Structures scene={scenes[p.index]} event={event} prev={trace.events[p.index - 1]} prevScene={scenes[p.index - 1]}/>}
    {event && <Watch trace={trace} index={p.index} watches={watches} onAdd={onAddWatch} onRemove={onRemoveWatch} onSeek={p.seek}/>}
    <div className="workspace"><Source lines={lines} line={event?.line} breakpoints={breakpoints} onToggleBreakpoint={onToggleBreakpoint}/>{event && <Memory event={event}/>}</div>
    <section className="panel output"><h2>Captured output <small>{atEnd ? 'final record, if available' : 'at this snapshot'}</small></h2>
      {(trace.stdout === undefined || trace.stderr === undefined) && <p className="warning">Final output is missing. At the end, the last checkpoint is shown and may lag.</p>}
      <div className="output-grid">{(['stdout', 'stderr'] as const).map((stream) => <div key={stream}><h3>{stream}</h3><pre data-testid={stream}>{outputAt(trace, p.index, stream) || '(empty)'}</pre></div>)}</div>
    </section><p className="hint">Replay reads saved states only. It does not run code or undo the original program's side effects. Complete capture does not guarantee a complete heap.</p></>;
}
