import { memo, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import type { Trace } from '../types';
import { MAX_WATCHES, changeIndexes, describe, parseWatch, resolveWatch, watchSignatures } from '../watch';
import { nextStop, prevStop } from '../breakpoints';

// One watched expression. The per-trace signature list is computed once (useMemo), so showing
// the value, "changed here" and the change jumps while stepping are cheap reads.
const WatchRow = memo(function WatchRow({ trace, text, index, onSeek, onRemove }: { trace: Trace; text: string; index: number; onSeek: (i: number) => void; onRemove: (text: string) => void }) {
  const parsed = useMemo(() => parseWatch(text), [text]);
  const sigs = useMemo(() => (parsed.ok ? watchSignatures(trace, parsed.path) : []), [trace, parsed]);
  const changes = useMemo(() => changeIndexes(sigs), [sigs]);
  if (!parsed.ok) return null;
  const event = trace.events[index];
  const resolved = event ? resolveWatch(event, parsed.path) : { ok: false as const, reason: 'no events' };
  const changedHere = index > 0 && sigs[index] !== undefined && sigs[index] !== sigs[index - 1];
  const prev = prevStop(changes, index), next = nextStop(changes, index);
  return <li className="watch-row" data-testid="watch-row">
    <div className="watch-head"><span className="watch-name mono">{text}</span>
      <button type="button" className="watch-remove" aria-label={`Remove watch ${text}`} onClick={() => onRemove(text)}>Remove</button></div>
    <div className={`watch-value ${resolved.ok ? '' : 'muted-state'}`} data-testid="watch-value">{resolved.ok && event ? describe(event, resolved.value) : resolved.ok ? '' : resolved.reason}</div>
    <div className="watch-meta"><span className={changedHere ? 'watch-changed' : 'hint'}>{changedHere ? 'Changed at this step' : changes.length ? `Changes at ${changes.length} step${changes.length === 1 ? '' : 's'}` : 'Never changes in this recording'}</span>
      <span className="watch-jump"><button type="button" aria-label={`Previous change of ${text}`} disabled={prev === undefined} onClick={() => prev !== undefined && onSeek(prev)}>Previous change</button>
        <button type="button" aria-label={`Next change of ${text}`} disabled={next === undefined} onClick={() => next !== undefined && onSeek(next)}>Next change</button></span></div>
  </li>;
});

export function Watch({ trace, index, watches, onAdd, onRemove, onSeek }: { trace: Trace; index: number; watches: string[]; onAdd: (text: string) => string | null; onRemove: (text: string) => void; onSeek: (i: number) => void }) {
  const [text, setText] = useState(''), [error, setError] = useState('');
  function submit(e: FormEvent) {
    e.preventDefault();
    const problem = onAdd(text);
    setError(problem ?? '');
    if (!problem) setText('');
  }
  return <section className="panel watch-panel" aria-label="Variable watch"><h2>Watch <small>values read from the recording</small></h2>
    <form className="watch-form" onSubmit={submit}><input value={text} onChange={(e) => setText(e.target.value)} placeholder="total, head.next.value, items[0]" aria-label="Watch expression" spellCheck={false} autoComplete="off" maxLength={80}/><button type="submit" className="primary">Add watch</button></form>
    {error && <p className="warning" role="alert">{error}</p>}
    {watches.length ? <ul className="watch-list">{watches.map((w) => <WatchRow key={w} trace={trace} text={w} index={index} onSeek={onSeek} onRemove={onRemove}/>)}</ul>
      : <p className="hint">Add a variable name to follow it step by step. Paths like <span className="mono">node.next.value</span> and <span className="mono">items[0]</span> work. Nothing is evaluated: values come from the saved snapshots.</p>}
    {watches.length >= MAX_WATCHES && <p className="hint">Limit of {MAX_WATCHES} watches reached.</p>}
  </section>;
}
