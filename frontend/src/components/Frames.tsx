import type { Frame, TraceEvent, Value } from '../types';
import type { Scene } from '../structures';
import { GEOM } from '../structures';
import { show } from '../changes';

// Visualization plan A1-A3: the call stack drawn inside the structure diagram, as in Python Tutor.
// One box per frame, outermost at the top and the current frame at the bottom. Each variable is a row:
// a plain value is written in the row, a reference is a dot with an arrow to the object it refers to.
// Two names that share one object therefore show two arrows into one box (aliasing, A3).
export const FRAMES = { w: 168, x: 8, top: 10, head: 24, row: 19, pad: 6, gap: 14, margin: 40 };
export const FRAMES_W = FRAMES.x + FRAMES.w + FRAMES.margin;   // width of the column, heap content starts after it

const DEFINITION = /^(function|class|type|builtin_function_or_method|module)$/;
const frameTitle = (f: Frame) => (f.function === '<module>' ? 'Global frame' : f.function === '<globals>' ? 'Globals' : f.function);
export interface FrameRow { name: string; value: Value; muted?: boolean; isReturn?: boolean }
export function frameRows(f: Frame, returnValue?: Value): FrameRow[] {
  const rows: FrameRow[] = Object.entries(f.locals).map(([name, value]) => ({ name, value, muted: value.kind === 'opaque' && DEFINITION.test(value.type) }));
  if (returnValue) rows.push({ name: '\u21A9 return', value: returnValue, isReturn: true });
  return rows;
}
export interface FrameBox { frame: Frame; y: number; h: number; rows: FrameRow[]; current: boolean }
// Pure layout, exported for tests: where each frame box goes and how tall the column is.
export function layoutFrames(event: TraceEvent): { boxes: FrameBox[]; height: number } {
  let y = FRAMES.top;
  const last = event.frames.length - 1;
  const boxes = event.frames.map((frame, i) => {
    const rows = frameRows(frame, i === last && event.event === 'return' ? event.return_value : undefined);
    const h = FRAMES.head + Math.max(1, rows.length) * FRAMES.row + FRAMES.pad, b = { frame, y, h, rows, current: i === last };
    y += h + FRAMES.gap;
    return b;
  });
  return { boxes, height: y };
}
// Rows whose value differs from the previous snapshot's same frame: they flash once.
function changedRows(event: TraceEvent, prev?: TraceEvent): Set<string> {
  const out = new Set<string>();
  if (!prev) return out;
  event.frames.forEach((f, i) => {
    const p = prev.frames[i];
    if (!p || p.function !== f.function || p.depth !== f.depth) return;
    for (const [k, v] of Object.entries(f.locals)) if (JSON.stringify(p.locals[k]) !== JSON.stringify(v)) out.add(`${i}:${k}`);
  });
  return out;
}

const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

export function FramesColumn({ event, prev, scene, nullWord }: { event: TraceEvent; prev?: TraceEvent; scene: Scene; nullWord: string }) {
  const { boxes } = layoutFrames(event), changed = changedRows(event, prev);
  let arrowNo = 0;
  return <g className="frames" data-testid="frames">
    {boxes.map((fb, fi) => <g key={`${fb.frame.depth}:${fb.frame.function}`} className={`frame-box${fb.current ? ' current' : ' suspended'}`} data-testid={`frame-${fi}`} transform={`translate(${FRAMES.x} ${fb.y})`}>
      <title>{`${frameTitle(fb.frame)}, ${fb.current ? 'current frame' : `suspended at line ${fb.frame.line}`}`}</title>
      <rect className="frame-rect" width={FRAMES.w} height={fb.h} rx="8"/>
      <text className="frame-head" x="8" y="16">{clip(frameTitle(fb.frame), 16)}</text>
      <text className="frame-line" x={FRAMES.w - 8} y="16" textAnchor="end">{fb.current ? 'current' : `line ${fb.frame.line}`}</text>
      {!fb.rows.length && <text className="frame-empty" x="8" y={FRAMES.head + 13}>no variables yet</text>}
      {fb.rows.map((r, ri) => {
        const y = FRAMES.head + ri * FRAMES.row, cy = y + FRAMES.row / 2;
        const target = r.value.kind === 'ref' ? r.value.id : undefined, tb = target ? scene.boxes[target] : undefined;
        const isNull = r.value.kind === 'scalar' && r.value.value === null;
        // Arrow from the dot to the variable's name tag above the target box (heap content is shifted right by FRAMES_W).
        // It climbs to a lane just above the tag row, runs right, then drops onto the tag, so it never crosses a node
        // box or the node-to-node arrows. Each arrow gets its own lane height so parallel arrows stay apart.
        let path = '';
        if (tb) {
          const k = arrowNo++;
          const sx = FRAMES.w - 10, sy = cy, tx = FRAMES_W - FRAMES.x + tb.x + 14, tagTop = tb.y - GEOM.tagH + 4 - fb.y;
          const lane = Math.max(4 - fb.y, tagTop - 16 - 4 * (k % 4)), turn = FRAMES.w + 6 + 4 * (k % 6);
          path = `M ${sx} ${sy} L ${turn - 8} ${sy} Q ${turn} ${sy} ${turn} ${sy + Math.sign(lane - sy) * 8} L ${turn} ${lane + Math.sign(sy - lane) * 8} Q ${turn} ${lane} ${turn + 8} ${lane} L ${tx - 8} ${lane} Q ${tx} ${lane} ${tx} ${lane + 8} L ${tx} ${tagTop - 2}`;
        }
        return <g key={r.name} className={`frame-row${r.muted ? ' muted' : ''}${r.isReturn ? ' return' : ''}${changed.has(`${fi}:${r.name}`) ? ' changed-row' : ''}`} data-testid={`var-${fi}-${r.name}`} data-target={target}>
          <title>{`${r.name}: ${target ? `refers to ${target}` : show(r.value, nullWord, 80)}`}</title>
          <rect className="frame-row-bg" x="2" y={y} width={FRAMES.w - 4} height={FRAMES.row}/>
          <text className="frame-name" x="8" y={cy + 4}>{clip(r.name, 11)}</text>
          {target ? (tb ? <circle className="frame-dot" cx={FRAMES.w - 10} cy={cy} r="4"/> : <text className="frame-val" x={FRAMES.w - 8} y={cy + 4} textAnchor="end">→ {target}</text>)
            : <text className={`frame-val${isNull ? ' null' : ''}`} x={FRAMES.w - 8} y={cy + 4} textAnchor="end">{r.muted ? (r.value.kind === 'opaque' && r.value.type === 'type' ? 'class' : r.value.kind === 'opaque' ? r.value.type.replace(/^builtin_function_or_method$/, 'function') : '') : clip(show(r.value, nullWord, 14), 12)}</text>}
          {path && <path className={`var-arrow${fb.current ? '' : ' quiet'}`} d={path} data-from={`${fi}:${r.name}`} data-to={target} markerEnd={fb.current ? 'url(#cv-var-head)' : 'url(#cv-var-head-quiet)'}/>}
        </g>;
      })}
    </g>)}
  </g>;
}
