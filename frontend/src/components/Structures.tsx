import { memo, useMemo, useRef, useState } from 'react';
import type { TraceEvent } from '../types';
import { CARD, GEOM, arrayOmitted, cardRows, portY, cellCentre, changedBetween, fmt, laneSummary, linkFieldsByType, linkPath, nodeDisplay } from '../structures';
import type { Scene } from '../structures';
import type { Value } from '../types';

// Draws one Scene. Layout comes from structures.ts. This file only turns boxes and arrows into SVG.
// Each box sits in its own <g> whose CSS transform is animated, so a box slides when its position changes.
// Arrows are drawn inside their source's <g>, so they travel with it.
const TAG_MAX = 16;
function Tag({ names }: { names: string[] }) {
  const full = names.join(', '), text = full.length > TAG_MAX ? `${full.slice(0, TAG_MAX - 1)}…` : full, w = text.length * 6.6 + 16;
  return <g className="tag" transform={`translate(0 ${-GEOM.tagH + 4})`}><title>{`Variables pointing here: ${full}`}</title>
    <rect width={w} height="20" rx="10"/><text x={w / 2} y="14" textAnchor="middle">{text}</text><path d="M10 20 l4 5 l4 -5z"/></g>;
}

const clipText = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
function cardText(v: Value | null, nullWord: string, note?: string) {
  if (!v) return note ?? '';
  if (v.kind === 'scalar' && v.value === null) return nullWord;
  return clipText(fmt(v, 8), 8);
}

export const Structures = memo(function Structures({ scene, event, prev, prevScene, nullWord = 'None' }: { scene: Scene; event: TraceEvent; prev?: TraceEvent; prevScene?: Scene; nullWord?: string }) {
  const [zoom, setZoom] = useState(1), box = useRef<HTMLDivElement>(null), drag = useRef<{ x: number; y: number; l: number; t: number } | null>(null);
  const setZ = (z: number) => setZoom(Math.min(2.5, Math.max(0.2, Math.round(z * 100) / 100)));
  const pan = (dx: number, dy: number) => box.current?.scrollBy({ left: dx, top: dy, behavior: 'smooth' });
  const fit = () => { const el = box.current; if (el) setZ(Math.min(1.5, (el.clientWidth - 12) / scene.width, (el.clientHeight - 12) / scene.height)); el?.scrollTo({ left: 0, top: 0 }); };
  const { changed } = useMemo(() => changedBetween(prev, event), [prev, event]);
  const linkField = useMemo(() => linkFieldsByType(event.heap), [event]);
  const summaries = scene.lanes.map((lane) => laneSummary(lane, event, scene));
  const linksFrom = (id: string) => scene.links.filter((l) => l.from === id);
  const mark = (id: string) => (prevScene && !prevScene.boxes[id] ? 'enter' : changed.has(id) ? 'changed' : '');
  return <section className="panel structures" aria-label="Structures">
    <div className="structures-head"><h2>Structures <small>every captured object: lists, arrays, and object cards</small></h2>
      <div className="zoom-bar" role="group" aria-label="Zoom and pan the diagram">
        <button type="button" aria-label="Pan left" onClick={() => pan(-240, 0)}>←</button><button type="button" aria-label="Pan up" onClick={() => pan(0, -160)}>↑</button><button type="button" aria-label="Pan down" onClick={() => pan(0, 160)}>↓</button><button type="button" aria-label="Pan right" onClick={() => pan(240, 0)}>→</button>
        <button type="button" aria-label="Zoom out" onClick={() => setZ(zoom / 1.25)}>−</button><output data-testid="zoom-level">{Math.round(zoom * 100)}%</output><button type="button" aria-label="Zoom in" onClick={() => setZ(zoom * 1.25)}>+</button>
        <button type="button" onClick={fit}>Fit all</button><button type="button" onClick={() => setZ(1)}>100%</button></div></div>
    <ul className="sr-only" data-testid="lane-summaries">{summaries.map((s, i) => <li key={i}>{s}</li>)}</ul>
    {!scene.lanes.length && !scene.cards.length && <p className="empty" data-testid="structures-empty">No linked-list nodes or arrays at this snapshot.{scene.nulls.length > 0 && ` ${nullWord}: ${scene.nulls.join(', ')}.`}</p>}
    {(scene.lanes.length > 0 || scene.cards.length > 0) && <div className="structure-scroll" ref={box} tabIndex={0} role="group" aria-label="Structure diagram. Drag, use arrow keys or the pan buttons to move; zoom with the buttons"
      onPointerDown={(e) => { if (e.button === 0 && box.current) drag.current = { x: e.clientX, y: e.clientY, l: box.current.scrollLeft, t: box.current.scrollTop }; }}
      onPointerMove={(e) => { const d = drag.current; if (d && box.current && e.buttons === 1) box.current.scrollTo({ left: d.l - (e.clientX - d.x), top: d.t - (e.clientY - d.y) }); }}
      onPointerUp={() => { drag.current = null; }} onPointerLeave={() => { drag.current = null; }}>
      <svg width={Math.ceil(scene.width * zoom)} height={Math.ceil(scene.height * zoom)} viewBox={`0 0 ${scene.width} ${scene.height}`} role="img" aria-label={summaries.join('. ')} data-testid="structure-svg" data-zoom={zoom}>
        <defs><marker id="cv-arrowhead" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L10 5 L0 10z" className="arrowhead"/></marker></defs>
        {scene.cards.map((id) => {
          const b = scene.boxes[id], node = event.heap[id], rows = cardRows(node), tag = scene.tags[id], m = mark(id);
          return <g key={id} className="vnode" data-testid={`box-${id}`} data-x={b.x} data-y={b.y} style={{ transform: `translate(${b.x}px, ${b.y}px)` }}>
            <title>{`${node.type} ${id}${node.address ? ` at ${node.address}` : ''}${node.freed ? ' (freed)' : ''}`}</title>
            {tag && <Tag names={tag}/>}
            <g key={m ? `${m}${event.step}` : 's'} className={m}>
              <rect className={`node-box card-box${node.freed ? ' freed' : ''}`} width={b.w} height={b.h} rx="8"/>
              <text className="card-head" x="8" y="17">{clipText(`${id} ${node.type}`, 17)}{node.freed ? ' (freed)' : ''}</text>
              <line className="node-divider" x1="0" x2={b.w} y1={CARD.head - 4} y2={CARD.head - 4} />
              {rows.map((r, i) => { const isRef = r.value?.kind === 'ref', ok = isRef && !!scene.boxes[(r.value as { id: string }).id];
                return <g key={i} className="card-row"><title>{`${r.label ? r.label + ": " : ""}${r.value ? (r.value.kind === "ref" ? `-> ${r.value.id}` : r.value.kind === "scalar" ? (r.value.value === null ? nullWord : String(r.value.value)) : r.value.kind) : r.note ?? ""}`}</title><text className="card-label" x="8" y={portY(i) + 4}>{clipText(r.label, 7)}</text>
                  <text className={`card-value${r.note ? ' note' : ''}`} x={b.w - (isRef ? 22 : 10)} y={portY(i) + 4} textAnchor="end">{isRef && !ok ? `${(r.value as { id: string }).id} missing` : isRef ? (r.value as { id: string }).id : cardText(r.value, nullWord, r.note)}</text>
                  {ok && <circle className="node-dot" cx={b.w - 10} cy={portY(i)} r="3.5"/>}</g>; })}
            </g>
            {linksFrom(id).map((l) => { const d = linkPath(l, scene.boxes); return d && <path key={`${l.cell}>${l.to}`} className="arrow" d={d} markerEnd="url(#cv-arrowhead)"/>; })}
          </g>;
        })}
        {scene.lanes.map((lane) => lane.ids.map((id) => {
          const box = scene.boxes[id], node = event.heap[id], tag = scene.tags[id], m = mark(id);
          const arrows = linksFrom(id).map((l) => { const d = linkPath(l, scene.boxes); return d && <path key={`${l.cell ?? 'n'}>${l.to}${l.port ? 'p' : ''}`} className="arrow" d={d} markerEnd="url(#cv-arrowhead)"/>; });
          if (lane.kind === 'array') {
            const items = node.items ?? [], omitted = arrayOmitted(node);
            return <g key={id} className="vnode" data-testid={`box-${id}`} data-x={box.x} data-y={box.y} style={{ transform: `translate(${box.x}px, ${box.y}px)` }}>
              <title>{`${node.type} ${id}, length ${node.length ?? items.length}`}</title>
              {tag && <Tag names={tag}/>}
              {items.map((v, i) => {
                const arrowed = v.kind === 'ref' && scene.boxes[v.id];
                // Only the cells whose value differs get the flash, not the whole array.
                const cm = m === 'enter' ? 'enter' : m === 'changed' && JSON.stringify(prev?.heap[id]?.items?.[i]) !== JSON.stringify(v) ? 'changed' : '';
                return <g key={i} className="cell"><g key={cm ? `${cm}${event.step}` : 's'} className={cm}>
                  <rect className="cell-box" x={i * GEOM.cell} width={GEOM.cell} height={GEOM.cell}/>
                  <text className="cell-value" x={cellCentre(i)} y={GEOM.cell / 2 + 4} textAnchor="middle">{arrowed ? '•' : fmt(v, 5)}</text></g>
                  <text className="cell-index" x={cellCentre(i)} y={GEOM.cell + 13} textAnchor="middle">{i}</text></g>;
              })}
              {omitted > 0 && <g className="cell"><rect className="cell-box omitted" x={items.length * GEOM.cell} width={GEOM.cell} height={GEOM.cell}/><text className="cell-value" x={cellCentre(items.length)} y={GEOM.cell / 2 + 4} textAnchor="middle">…</text><title>{`${omitted} more not captured`}</title></g>}
              {arrows}
            </g>;
          }
          const d = nodeDisplay(node, linkField.get(node.type)), lv = node.fields?.[linkField.get(node.type) ?? ''];
          const isNull = lv?.kind === 'scalar' && lv.value === null, has = linksFrom(id).length > 0;
          const mainY = d.rest.length === 0 ? 33 : d.rest.length === 1 ? 25 : 20;
          return <g key={id} className="vnode" data-testid={`box-${id}`} data-x={box.x} data-y={box.y} style={{ transform: `translate(${box.x}px, ${box.y}px)` }}>
            <title>{`${node.type} ${id}: ${Object.entries(node.fields ?? {}).map(([k, v]) => `${k}=${fmt(v, 20)}`).join(', ')}`}</title>
            {tag && <Tag names={tag}/>}
            <g key={m ? `${m}${event.step}` : 's'} className={m}>
              <rect className="node-box" width={box.w} height={box.h} rx="10"/>
              <line className="node-divider" x1={box.w - 24} x2={box.w - 24} y1="0" y2={box.h}/>
              <text className="node-main" x={(box.w - 24) / 2} y={mainY} textAnchor="middle">{d.main}</text>
              {d.rest.map((r, i) => <text className="node-rest" key={i} x={(box.w - 24) / 2} y={mainY + 15 + i * 12} textAnchor="middle">{r}</text>)}
              {isNull ? <text className="node-null" x={box.w - 12} y={box.h / 2 + 5} textAnchor="middle">∅</text> : has && <circle className="node-dot" cx={box.w - 12} cy={box.h / 2} r="4"/>}
            </g>
            <text className="node-id" x="0" y={box.h + 14}>{id}</text>
            {arrows}
          </g>;
        }))}
      </svg></div>}
    {(scene.lanes.length > 0 || scene.cards.length > 0) && scene.nulls.length > 0 && <p className="hint">{nullWord}: {scene.nulls.join(', ')}</p>}
    {scene.undrawn.length > 0 && <p className="hint">Not drawn here ({scene.undrawn.length}): {scene.undrawn.map((u) => `${u.id} ${u.type}`).join(', ')}. See the Heap panel.</p>}
  </section>;
});
