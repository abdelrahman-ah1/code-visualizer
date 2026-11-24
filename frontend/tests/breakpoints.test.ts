import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseTrace } from '../src/parseTrace';
import { buildLineIndex, isStop, nextStop, prevStop, stopIndexes, unreachedLines } from '../src/breakpoints';
const load = (n: string) => parseTrace(readFileSync(new URL(`../public/examples/${n}.trace.json`, import.meta.url), 'utf8'));

// Expected indexes below were read by hand from the recorded events (see HAND_CHECKS.md style):
// 02_loop: the loop header (source line 2) is evaluated before each pass; the body is line 3.
describe('breakpoints stop on recorded line events', () => {
  const loop = load('02_loop'), index = buildLineIndex(loop.events);
  it('a body line stops once per loop pass', () => { expect(stopIndexes(index, new Set([3]))).toEqual([3, 5, 7]); });
  it('the loop header stops before every pass and once more at the end', () => { expect(stopIndexes(index, new Set([2]))).toEqual([2, 4, 6, 8]); });
  it('several lines merge into one ascending list', () => { expect(stopIndexes(index, new Set([3, 2]))).toEqual([2, 3, 4, 5, 6, 7, 8]); });
  it('a line that never runs is reported, not silently ignored', () => {
    expect(stopIndexes(index, new Set([99]))).toEqual([]);
    expect(unreachedLines(index, new Set([99, 3, 50]))).toEqual([50, 99]);
  });
  it('an empty set of breakpoints has no stops', () => { expect(stopIndexes(index, new Set())).toEqual([]); });
  it('call and return events never stop, even on a chosen line (recursion)', () => {
    const rec = load('03_recursion'), idx = buildLineIndex(rec.events);
    // Source line 5 is `return n * partial`: two `line` events (13, 15); the return events 14 and 16 are on line 5 too.
    expect(rec.events.filter((e) => e.line === 5).map((e) => e.event)).toEqual(['line', 'return', 'line', 'return']);
    expect(stopIndexes(idx, new Set([5]))).toEqual([13, 15]);
    // `if n <= 1` (line 2) runs once per call level: 3, 2, 1.
    expect(stopIndexes(idx, new Set([2]))).toEqual([4, 7, 10]);
  });
});
describe('stop navigation', () => {
  const stops = [3, 5, 7];
  it('nextStop is strictly after the current event', () => {
    expect(nextStop(stops, 0)).toBe(3); expect(nextStop(stops, 3)).toBe(5);
    expect(nextStop(stops, 4)).toBe(5); expect(nextStop(stops, 7)).toBeUndefined();
  });
  it('prevStop is strictly before the current event', () => {
    expect(prevStop(stops, 9)).toBe(7); expect(prevStop(stops, 7)).toBe(5);
    expect(prevStop(stops, 3)).toBeUndefined(); expect(prevStop(stops, 0)).toBeUndefined();
  });
  it('isStop and empty lists', () => {
    expect(isStop(stops, 5)).toBe(true); expect(isStop(stops, 4)).toBe(false);
    expect(nextStop([], 0)).toBeUndefined(); expect(prevStop([], 5)).toBeUndefined(); expect(isStop([], 0)).toBe(false);
  });
  it('empty trace builds an empty index', () => { expect(buildLineIndex([]).size).toBe(0); });
});
