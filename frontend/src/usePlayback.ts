import { useEffect, useState } from 'react';
import { clampStep } from './replay';
export function usePlayback(count: number) {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(2);
  // One timeout per committed snapshot. Cleanup also handles pause/speed/unmount.
  useEffect(() => {
    if (!playing || count < 2) return;
    if (index >= count - 1) { setPlaying(false); return; }
    const timer = window.setTimeout(() => setIndex((i) => clampStep(i + 1, count)), 1000 / speed);
    return () => window.clearTimeout(timer);
  }, [playing, index, speed, count]);
  const seek = (i: number) => { setPlaying(false); setIndex(clampStep(i, count)); };
  const toggle = () => {
    if (count < 2) return;
    if (!playing && index === count - 1) setIndex(0);
    setPlaying((p) => !p);
  };
  return { index, playing, speed, seek, toggle, setSpeed };
}
