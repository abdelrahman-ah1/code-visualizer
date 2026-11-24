import type { usePlayback } from '../usePlayback';
import { nextStop, prevStop } from '../breakpoints';
export function Controls({ playback: p, count, stops = [] }: { playback: ReturnType<typeof usePlayback>; count: number; stops?: readonly number[] }) {
  return <section className="controls" aria-label="Playback controls"><div className="control-buttons">
    <button onClick={() => p.seek(0)} disabled={!count || p.index === 0}>First</button>
    <button onClick={() => p.seek(p.index - 1)} disabled={!count || p.index === 0}>Previous</button>
    <button className="primary" onClick={p.toggle} disabled={count < 2}>{p.playing ? 'Pause' : p.index === count - 1 && count > 1 ? 'Replay' : 'Play'}</button>
    <button onClick={() => p.seek(p.index + 1)} disabled={!count || p.index === count - 1}>Next</button>
    <button onClick={() => p.seek(count - 1)} disabled={!count || p.index === count - 1}>Last</button>
    <button onClick={p.prevBreak} disabled={prevStop(stops, p.index) === undefined} title="Jump to the previous recorded stop on a breakpoint line">Previous breakpoint</button>
    <button onClick={p.nextBreak} disabled={nextStop(stops, p.index) === undefined} title="Jump to the next recorded stop on a breakpoint line">Next breakpoint</button>
  </div><div className="timeline"><label htmlFor="step">{count ? `Event ${p.index + 1} of ${count}` : 'No events'}</label><input id="step" aria-label="Event timeline" type="range" min="0" max={Math.max(0, count - 1)} value={p.index} disabled={count < 2} onChange={(e) => p.seek(Number(e.target.value))}/></div>
    <label className="speed">Speed<select aria-label="Playback speed" value={p.speed} onChange={(e) => p.setSpeed(Number(e.target.value))}>{[0.5, 1, 2, 4, 8].map((speed) => <option value={speed} key={speed}>{speed} events/s</option>)}</select></label>
  </section>;
}
