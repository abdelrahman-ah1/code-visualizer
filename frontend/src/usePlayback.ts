import { useEffect, useState } from 'react';
import { clampStep } from './replay';
import { isStop, nextStop, prevStop } from './breakpoints';
const NO_STOPS: readonly number[] = [];
// `stops` are ascending event indexes where a breakpoint is set (see breakpoints.ts).
// Pass the same array object while breakpoints are unchanged (useMemo), so the timer below is
// not recreated by every render.
export function usePlayback(count: number, stops: readonly number[] = NO_STOPS) {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(2);
  // One timeout per committed snapshot. Cleanup also handles pause/speed/unmount.
  useEffect(() => {
    if (!playing || count < 2) return;
    if (index >= count - 1) { setPlaying(false); return; }
    const timer = window.setTimeout(() => {
      const next = clampStep(index + 1, count);
      setIndex(next);
      // Playing runs until the next breakpoint, exactly like a debugger's Continue.
      if (isStop(stops, next)) setPlaying(false);
    }, 1000 / speed);
    return () => window.clearTimeout(timer);
  }, [playing, index, speed, count, stops]);
  const seek = (i: number) => { setPlaying(false); setIndex(clampStep(i, count)); };
  const toggle = () => {
    if (count < 2) return;
    if (!playing && index === count - 1) setIndex(0);
    setPlaying((p) => !p);
  };
  // Jump straight to the neighbouring stop. No stop in that direction means no move.
  const nextBreak = () => { const at = nextStop(stops, index); if (at !== undefined) seek(at); };
  const prevBreak = () => { const at = prevStop(stops, index); if (at !== undefined) seek(at); };
  return { index, playing, speed, seek, toggle, setSpeed, nextBreak, prevBreak, atBreakpoint: isStop(stops, index) };
}
