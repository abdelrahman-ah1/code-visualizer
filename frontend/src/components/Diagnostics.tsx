import { memo } from 'react';
import type { Diagnostic } from '../types';

// M5: what the compiler, the memory checker and the run itself found. Text only, never HTML.
// Clicking a line number jumps the source panel's breakpoint-free view: it just names the line,
// because the recording may not contain a step on that line (compile errors have no steps at all).
const label: Record<Diagnostic['severity'], string> = { error: 'Error', warning: 'Warning', info: 'Note' };
const sourceName: Record<string, string> = {
  compiler: 'Compiler', sanitizer: 'Memory check', runtime: 'Run', scanner: 'Unsupported feature', tracer: 'Recorder', toolchain: 'Setup',
};

export const Diagnostics = memo(function Diagnostics({ items }: { items: Diagnostic[] }) {
  if (!items.length) return null;
  return <section className="panel diagnostics" aria-label="Diagnostics" data-testid="diagnostics">
    <h2>Findings <small>{items.filter((d) => d.severity === 'error').length} errors · {items.filter((d) => d.severity === 'warning').length} warnings</small></h2>
    <ul>{items.map((d, i) => <li key={i} className={`diag ${d.severity}`} data-kind={d.kind}>
      <b>{label[d.severity]}</b> <span className="diag-source">{sourceName[d.source] ?? d.source}</span>
      {d.line !== undefined && <span className="diag-line">line {d.line}{d.column !== undefined ? `:${d.column}` : ''}</span>}
      <p>{d.message}</p></li>)}</ul>
    {items.some((d) => d.source === 'sanitizer') && <p className="hint" data-testid="twice-note">Your program is run twice: once for the step-by-step recording and once more, separately, for the memory check. Each run has its own working folder, but files written with absolute paths and network calls can still happen twice. Only the recording's output is shown.</p>}
    <p className="hint">Memory-check findings come from a separate native run of the whole program. They explain problems; they are not a guarantee that nothing else is wrong.</p>
  </section>;
});
