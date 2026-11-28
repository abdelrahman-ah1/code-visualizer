import { memo } from 'react';
import type { StepSummary } from '../changes';

const MAX_SHOWN = 8;
// The plain-words summary of the step that led to this snapshot. aria-live so a screen reader
// hears what changed when the learner presses Next.
export const WhatChanged = memo(function WhatChanged({ summary }: { summary: StepSummary }) {
  const shown = summary.changes.slice(0, MAX_SHOWN), more = summary.changes.length - shown.length;
  return <section className="panel what-changed" aria-label="What this step did" data-testid="what-changed">
    <h2>What this step did</h2>
    <p className="wc-headline" aria-live="polite" data-testid="wc-headline">{summary.headline}</p>
    {shown.length > 0 && <ul className="wc-list">{shown.map((c, i) => <li key={i} className={`wc-${c.kind}`} data-kind={c.kind}>{c.text}</li>)}</ul>}
    {more > 0 && <p className="hint">and {more} more change{more === 1 ? '' : 's'}</p>}
  </section>;
});
