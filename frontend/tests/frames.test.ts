import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseTrace } from '../src/parseTrace';
import { FRAMES, frameRows, layoutFrames } from '../src/components/Frames';

const load = (name: string) => parseTrace(readFileSync(new URL(`../public/examples/${name}.trace.json`, import.meta.url), 'utf8'));

describe('frames column layout (visualization plan A1-A2)', () => {
  it('recursion: one box per active call, outermost first, the last one is current', () => {
    const t = load('03_recursion');
    const deepest = t.events.reduce((a, e) => (e.frames.length > a.frames.length ? e : a));
    const { boxes } = layoutFrames(deepest);
    expect(boxes.map((b) => b.frame.function)).toEqual(['<module>', 'factorial', 'factorial', 'factorial']);
    expect(boxes.map((b) => b.current)).toEqual([false, false, false, true]);
    // Stacked top to bottom without overlap.
    for (let i = 1; i < boxes.length; i++) expect(boxes[i].y).toBeGreaterThanOrEqual(boxes[i - 1].y + boxes[i - 1].h + FRAMES.gap);
  });
  it('a return event adds the return value as a row of the current frame only', () => {
    const t = load('03_recursion');
    const ret = t.events.find((e) => e.event === 'return' && e.frames.length > 1)!;
    const { boxes } = layoutFrames(ret);
    expect(boxes.at(-1)!.rows.at(-1)).toMatchObject({ isReturn: true, value: { kind: 'scalar', value: 1 } });
    expect(boxes.slice(0, -1).every((b) => !b.rows.some((r) => r.isReturn))).toBe(true);
  });
  it('function and class definitions are muted rows, data rows are not', () => {
    const t = load('03_recursion');
    const rows = frameRows(t.events.at(-1)!.frames[0]);
    expect(rows.find((r) => r.name === 'factorial')?.muted).toBe(true);
    expect(rows.find((r) => r.name === 'answer')?.muted).toBe(false);
  });
});
