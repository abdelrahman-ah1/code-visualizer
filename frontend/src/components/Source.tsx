import { memo, useEffect, useRef } from 'react';
export const Source = memo(function Source({ lines, line }: { lines: string[]; line: number | undefined }) {
  const active = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Scroll only the source viewport, not the whole page on each playback tick.
    const item = active.current, parent = item?.parentElement;
    if (item && parent && (item.offsetTop < parent.scrollTop || item.offsetTop + item.offsetHeight > parent.scrollTop + parent.clientHeight)) parent.scrollTop = item.offsetTop - parent.clientHeight / 2;
  }, [line]);
  return <section className="panel source-panel"><h2>Source <small>read only</small></h2><div className="source" tabIndex={0} aria-label="Recorded source">
    {lines.map((text, i) => <div ref={line === i + 1 ? active : undefined} className={`code-line ${line === i + 1 ? 'active' : ''}`} aria-current={line === i + 1 ? 'step' : undefined} key={i}><span className="line-number">{i + 1}</span><code>{text || ' '}</code></div>)}
  </div></section>;
});
