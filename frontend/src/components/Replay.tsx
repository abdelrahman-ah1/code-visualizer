import { useEffect, useMemo, useState } from 'react';
import type { Trace } from '../types';
import { usePlayback } from '../usePlayback';
import { eventMeaning, outputAt, statusMeaning } from '../replay';
import { Controls } from './Controls';
import { Source } from './Source';
import { CallStack, Heap } from './Memory';
import { Structures } from './Structures';
import { buildScenes } from '../structures';
import { ValueView } from './ValueView';
import { Watch } from './Watch';
import { Diagnostics } from './Diagnostics';
import { buildLineIndex, stopIndexes, unreachedLines } from '../breakpoints';
type TabId = 'heap' | 'stack' | 'watch' | 'findings';
const TABS: { id: TabId; label: string }[] = [{ id: 'heap', label: 'Heap' }, { id: 'stack', label: 'Call stack' }, { id: 'watch', label: 'Watch' }, { id: 'findings', label: 'Findings' }];
interface Props { trace: Trace; breakpoints: ReadonlySet<number>; onToggleBreakpoint: (line: number) => void; watches: string[]; onAddWatch: (text: string) => string | null; onRemoveWatch: (text: string) => void }
export function Replay({ trace, breakpoints, onToggleBreakpoint, watches, onAddWatch, onRemoveWatch }: Props) {
  // Built once per trace; stops are recomputed only when the chosen lines change.
  const lineIndex = useMemo(() => buildLineIndex(trace.events), [trace]);
  const stops = useMemo(() => stopIndexes(lineIndex, breakpoints), [lineIndex, breakpoints]);
  const unreached = useMemo(() => unreachedLines(lineIndex, breakpoints), [lineIndex, breakpoints]);
  const p = usePlayback(trace.events.length, stops), event = trace.events[p.index];
  const scenes = useMemo(() => buildScenes(trace), [trace]);
  const lines = useMemo(() => trace.source.split('\n'), [trace.source]);
  const [tab, setTab] = useState<TabId | 'closed' | null>(null);
  useEffect(() => setTab(null), [trace]);
  const found = (trace.diagnostics ?? []).filter((d) => d.severity === 'error').length;
  // Findings opens by itself when the recording has problems; otherwise Heap is open by default.
  const shown: TabId | 'closed' = tab ?? (trace.diagnostics?.length ? 'findings' : 'heap');
  const atEnd = !trace.events.length || p.index === trace.events.length - 1;
  return <><div className="replay-root"><div className={`run-status ${trace.status === 'ok' && !found ? '' : 'warning'}`}>{found > 0 && <b className="overall" data-testid="overall">Problems found: {found} {found === 1 ? 'error' : 'errors'}. See Findings below.</b>}<b>Recorded run: {trace.status}</b><span>{statusMeaning[trace.status]}. {trace.complete ? 'Final record captured.' : 'Incomplete capture.'}{found > 0 && trace.status === 'ok' ? ' This only says the recording finished. It does not mean the program is correct.' : ''}</span><small>{trace.runtime.implementation} {trace.runtime.version}{trace.error ? ` · ${trace.error.type}${trace.error.line ? ` on line ${trace.error.line}` : ''}` : ''}</small></div>
    <div className="sticky-bar">
      <Controls playback={p} count={trace.events.length} stops={stops}/>
      <p className="hint breakpoint-note" data-testid="breakpoint-note">{breakpoints.size ? `Breakpoints: line ${[...breakpoints].sort((a, b) => a - b).join(', ')}. Play stops before each one runs.${unreached.length ? ` Never reached in this recording: ${unreached.join(', ')}.` : ''}` : 'Click a line number in the source to set a breakpoint. Breakpoints stop at recorded steps, they do not re-run the program.'}</p>
      <div className="event-status" role="status">{event ? <><b>{event.event} · step {event.step} · line {event.line}</b><span>{eventMeaning(event)}</span>{p.atBreakpoint && <span className="bp-hit" data-testid="breakpoint-hit">Breakpoint · line {event.line}</span>}{event.exception_type && <span className="warning">{event.exception_type}</span>}{event.return_value && <span>Recorded return value: <ValueView value={event.return_value}/></span>}{event.truncated.length > 0 && <span className="warning">Snapshot omissions: {event.truncated.join(', ')}</span>}</> : <b>No snapshots captured. The run status and final output still apply.</b>}</div>
    </div>
    <div className="replay-grid">
      <div className="col-left">
        {event && <Source lines={lines} line={event.line} kind={event.event} breakpoints={breakpoints} onToggleBreakpoint={onToggleBreakpoint}/>}
        <section className="panel output"><h2>Captured output <small>{atEnd ? 'final record, if available' : 'at this snapshot'}</small></h2>
        {(trace.stdout === undefined || trace.stderr === undefined) && <p className="warning">Final output is missing. At the end, the last checkpoint is shown and may lag.</p>}
        <div className="output-grid">{(['stdout', 'stderr'] as const).map((stream) => <div key={stream}><h3>{stream}</h3><pre data-testid={stream}>{outputAt(trace, p.index, stream) || '(empty)'}</pre></div>)}</div>
        </section>
      </div>
      <div className={`col-right ${shown === 'closed' ? 'closed' : ''}`}>
        {event && <Structures nullWord={/g\+\+|gcc|clang|c\+\+/i.test(trace.runtime.implementation) ? 'null' : 'None'} scene={scenes[p.index]} event={event} prev={trace.events[p.index - 1]} prevScene={scenes[p.index - 1]}/>}
        <section className="panel tabs-panel" aria-label="Details">
          <div className="tabs" role="tablist" aria-label="Details panels">
            {TABS.map((t) => <button type="button" role="tab" key={t.id} id={`tab-${t.id}`} aria-selected={shown === t.id} aria-controls="tabpanel" className={`tab ${shown === t.id ? 'on' : ''}`} onClick={() => setTab(shown === t.id ? 'closed' : t.id)}>{t.label}{t.id === 'findings' && found > 0 && <span className="badge" aria-label={`${found} errors`}>{found}</span>}</button>)}
          </div>
          {shown === 'closed' ? <p className="hint">Panel closed. Pick a tab to open it. Click the open tab again to close it.</p> : <div id="tabpanel" role="tabpanel" aria-labelledby={`tab-${shown}`}>
            {shown === 'heap' && event && <Heap event={event}/>}
            {shown === 'stack' && event && <CallStack event={event}/>}
            {shown === 'watch' && event && <Watch trace={trace} index={p.index} watches={watches} onAdd={onAddWatch} onRemove={onRemoveWatch} onSeek={p.seek}/>}
            {shown === 'findings' && (trace.diagnostics?.length ? <Diagnostics items={trace.diagnostics}/> : <p className="hint">No findings for this recording.</p>)}
          </div>}
        </section>
      </div>
    </div>
    </div>
    <p className="hint">Replay reads saved states only. It does not run code or undo the original program's side effects. Complete capture does not guarantee a complete heap.</p></>;
}
