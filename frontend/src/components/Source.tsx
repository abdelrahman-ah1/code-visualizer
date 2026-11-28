import { memo, useCallback, useEffect, useRef } from 'react';

// Marker per event type: arrow for a line or call, a return arrow, a warning sign for an exception.
const MARK: Record<string, string> = { line: '\u25B6', call: '\u25B6', return: '\u21A9', exception: '\u26A0' };
// One source line. memo() means a playback step re-renders only the two lines whose props
// changed (the one that just stopped being current and the new current one), not the whole file.
// `ran`: this line is the one that just executed (Python Tutor's faint arrow). It is never also the active line.
const CodeLine = memo(function CodeLine({ n, text, active, ran, kind, breakpoint, onToggle }: { n: number; text: string; active: boolean; ran: boolean; kind: string; breakpoint: boolean; onToggle: (line: number) => void }) {
  return <div className={`code-line ${active ? 'active' : ''}${ran ? ' ran' : ''}`} aria-current={active ? 'step' : undefined} data-ran={ran || undefined}>
    <span className="exec-arrow" aria-hidden="true">{active ? MARK[kind] ?? '\u25B6' : ran ? '\u2192' : ''}</span>
    <button type="button" className={`line-number ${breakpoint ? 'bp-on' : ''}`} aria-pressed={breakpoint} aria-label={`Breakpoint on line ${n}`} title={breakpoint ? `Remove breakpoint on line ${n}` : `Set breakpoint on line ${n}`} onClick={() => onToggle(n)}>{n}</button>
    <code>{text || ' '}</code>
  </div>;
});

export const Source = memo(function Source({ lines, line, ranLine, kind, breakpoints, onToggleBreakpoint }: { lines: string[]; line: number | undefined; ranLine?: number; kind: string; breakpoints: ReadonlySet<number>; onToggleBreakpoint: (line: number) => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Scroll only the source viewport, not the whole page on each playback tick.
    const parent = box.current, item = parent?.querySelector<HTMLElement>('[aria-current]');
    if (item && parent && (item.offsetTop < parent.scrollTop || item.offsetTop + item.offsetHeight > parent.scrollTop + parent.clientHeight)) parent.scrollTop = item.offsetTop - parent.clientHeight / 2;
  }, [line]);
  const toggle = useCallback((n: number) => onToggleBreakpoint(n), [onToggleBreakpoint]);
  return <section className="panel source-panel"><h2>Source <small>read only · <span className="legend-ran">→ just ran</span> · <span className="legend-next">▶ runs next</span> · click a line number for a breakpoint</small></h2><div className="source" tabIndex={0} aria-label="Recorded source" ref={box}>
    {lines.map((text, i) => <CodeLine key={i} n={i + 1} text={text} active={line === i + 1} ran={ranLine === i + 1 && line !== i + 1} kind={kind} breakpoint={breakpoints.has(i + 1)} onToggle={toggle}/>)}
  </div></section>;
});
