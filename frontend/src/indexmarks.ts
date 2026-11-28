// Visualization plan C1: index variables drawn under the array cells they point at (i, j, lo, hi, mid ...).
// Pure inference from one snapshot plus the source text, no tracer change:
//   an integer variable v of the current frame is an index into the array that variable r refers to
//   when the source indexes r with an expression that mentions v (r[v], r[v + 1], r[lo:hi], r.at(v)).
// The marker sits on cell v; v equal to the length is drawn as "past the end", the usual loop exit.
import type { TraceEvent, Value } from './types';

export interface IndexMark { cell: number; names: string[]; pastEnd: boolean }

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isInt = (v: Value): v is Value & { kind: 'scalar'; value: number } => v.kind === 'scalar' && typeof v.value === 'number' && Number.isInteger(v.value) && !/bool|char|float|double/.test(v.type);

// Which (array name, index name) pairs the source uses. Cached per source text.
const pairCache = new Map<string, (r: string, v: string) => boolean>();
function usesIndex(source: string): (r: string, v: string) => boolean {
  let f = pairCache.get(source);
  if (!f) {
    const memo = new Map<string, boolean>();
    f = (r, v) => {
      const k = `${r}\u0000${v}`;
      let hit = memo.get(k);
      if (hit === undefined) {
        const word = `\\b${esc(v)}\\b`;
        hit = new RegExp(`\\b${esc(r)}\\s*\\[[^\\]\\n]*${word}`).test(source) || new RegExp(`\\b${esc(r)}\\s*\\.\\s*at\\s*\\([^)\\n]*${word}`).test(source);
        memo.set(k, hit);
      }
      return hit;
    };
    if (pairCache.size > 20) pairCache.clear();
    pairCache.set(source, f);
  }
  return f;
}

// For each array id in `arrays` (id -> number of cells), the index markers to draw, cell by cell.
export function indexMarks(event: TraceEvent, source: string, arrays: Map<string, number>): Map<string, IndexMark[]> {
  const out = new Map<string, IndexMark[]>();
  const frame = event.frames[event.frames.length - 1];
  if (!frame) return out;
  const uses = usesIndex(source);
  const locals = Object.entries(frame.locals);
  const ints = locals.filter(([, v]) => isInt(v)) as [string, Value & { value: number }][];
  if (!ints.length) return out;
  for (const [r, ref] of locals) {
    if (ref.kind !== 'ref' || !arrays.has(ref.id)) continue;
    const len = arrays.get(ref.id)!;
    const byCell = new Map<number, string[]>();
    for (const [v, val] of ints) {
      if (v === r || val.value < 0 || val.value > len || !uses(r, v)) continue;
      const names = byCell.get(val.value) ?? [];
      if (!names.includes(v)) names.push(v);
      byCell.set(val.value, names);
    }
    if (!byCell.size) continue;
    const prev = out.get(ref.id) ?? [];
    for (const [cell, names] of byCell) {
      const same = prev.find((m) => m.cell === cell);
      if (same) { for (const n of names) if (!same.names.includes(n)) same.names.push(n); } else prev.push({ cell, names, pastEnd: cell === len });
    }
    out.set(ref.id, prev.sort((a, b) => a.cell - b.cell));
  }
  return out;
}
