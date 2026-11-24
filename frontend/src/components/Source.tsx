import { memo, useCallback, useEffect, useRef } from 'react';

// One source line. memo() means a playback step re-renders only the two lines whose props
// changed (the one that just stopped being current and the new current one), not the whole file.
const CodeLine = memo(function CodeLine({ n, text, active, breakpoint, onToggle }: { n: number; text: string; active: boolean; breakpoint: boolean; onToggle: (line: number) => void }) {
  return <div className={`code-line ${active ? 'active' : ''}`} aria-current={active ? 'step' : undefined}>
    <button type="button" className={`line-number ${breakpoint ? 'bp-on' : ''}`} aria-pressed={breakpoint} aria-label={`Breakpoint on line ${n}`} title={breakpoint ? `Remove breakpoint on line ${n}` : `Set breakpoint on line ${n}`} onClick={() => onToggle(n)}>{n}</button>
    <code>{text || ' '}</code>
  </div>;
});

export const Source = memo(function Source({ lines, line, breakpoints, onToggleBreakpoint }: { lines: string[]; line: number | undefined; breakpoints: ReadonlySet<number>; onToggleBreakpoint: (line: number) => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Scroll only the source viewport, not the whole page on each playback tick.
    const parent = box.current, item = parent?.querySelector<HTMLElement>('[aria-current]');
    if (item && parent && (item.offsetTop < parent.scrollTop || item.offsetTop + item.offsetHeight > parent.scrollTop + parent.clientHeight)) parent.scrollTop = item.offsetTop - parent.clientHeight / 2;
  }, [line]);
  const toggle = useCallback((n: number) => onToggleBreakpoint(n), [onToggleBreakpoint]);
  return <section className="panel source-panel"><h2>Source <small>read only · click a line number for a breakpoint</small></h2><div className="source" tabIndex={0} aria-label="Recorded source" ref={box}>
    {lines.map((text, i) => <CodeLine key={i} n={i + 1} text={text} active={line === i + 1} breakpoint={breakpoints.has(i + 1)} onToggle={toggle}/>)}
  </div></section>;
});
