import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { TraceEvent } from '../types';
import { CARD, GEOM, REC, arrayOmitted, cardRows, portY, cellCentre, accessTargets, accessClause, changedBetween, fmt, laneSummary, linkFieldsByType, linkPath, recGeom, graphSpec, vertexCutOff, vertexDisplay, vertexEdges } from '../structures';
import type { Link, Scene } from '../structures';
import type { Value } from '../types';
import { FRAMES_W, FramesColumn, layoutFrames } from './Frames';

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
const MARK_W = (t: string) => t.length * 6.6 + 6;   // the sq-mark font is 10px monospace: measure before placing
function cardText(v: Value | null, nullWord: string, note?: string) {
  if (!v) return note ?? '';
  if (v.kind === 'scalar' && v.value === null) return nullWord;
  return clipText(fmt(v, 8), 8);
}


// One compartment record: data in the main box, the first pointer in a compartment on the right, further pointers in strips underneath.
function Pointer({ name, value, x, y, drawn, nullWord, strip }: { name: string; value: Value; x: number; y: number; drawn: boolean; nullWord: string; strip: boolean }) {
  const isNull = value.kind === 'scalar' && value.value === null, target = value.kind === 'ref' ? value.id : '';
  return <g className="ptr" data-testid={`ptr-${name}`}><title>{`${name}: ${isNull ? nullWord : target}`}</title>
    <text className="ptr-name" x={strip ? 8 : x} y={strip ? y + 3 : y - 14} textAnchor={strip ? 'start' : 'middle'}>{clipText(name, strip ? 14 : 7)}</text>
    {isNull ? <text className="node-null" x={strip ? x : x} y={y + 5} textAnchor="middle">∅</text>
      : drawn ? <circle className="node-dot" cx={x} cy={y} r="4"/> : <text className="node-null" x={x} y={y + 4} textAnchor="middle" data-testid="ptr-missing">?</text>}</g>;
}

const ORPHAN_HINT = 'Not reachable through the captured roots at this step: no captured local, global, file-level static or top-level function-static leads to this block, directly or through other blocks. It is still allocated, so this is not a leak report. Statics in nested blocks or lambdas, thread-locals, registers and unmanaged buffers are not captured.';
export const Structures = memo(function Structures({ scene, event, prev, prevScene, nullWord = 'None' }: { scene: Scene; event: TraceEvent; prev?: TraceEvent; prevScene?: Scene; nullWord?: string }) {
  const [zoom, setZoom] = useState(1), box = useRef<HTMLDivElement>(null), drag = useRef<{ x: number; y: number; l: number; t: number } | null>(null);
  // Visualization plan A1: the frames column (variables with arrows into the diagram). On by default; the reader can hide it.
  const [showVars, setShowVars] = useState(true);
  const frameLayout = useMemo(() => layoutFrames(event), [event]);
  const withVars = showVars && event.frames.length > 0, offX = withVars ? FRAMES_W : 0;
  const totalW = scene.width + offX, totalH = Math.max(scene.height, withVars ? frameLayout.height + 10 : 0);
  const userZoom = useRef(false);   // once the reader sets a zoom, the panel stops fitting scenes for them
  const setZ = (z: number) => { userZoom.current = true; setZoom(Math.min(2.5, Math.max(0.2, Math.round(z * 100) / 100))); };
  const pan = (dx: number, dy: number) => box.current?.scrollBy({ left: dx, top: dy, behavior: 'smooth' });
  const fit = () => { const el = box.current; if (el) setZ(Math.min(1.5, (el.clientWidth - 12) / totalW, (el.clientHeight - 12) / totalH)); el?.scrollTo({ left: 0, top: 0 }); };
  const { changed } = useMemo(() => changedBetween(prev, event), [prev, event]);
  const linkField = useMemo(() => linkFieldsByType(event.heap), [event]);
  const summaries = scene.lanes.map((lane) => laneSummary(lane, event, scene));
  // The elements this step's line touched, at most two of them: a thin ring for a read, a thick one with an arrow for a
  // write, dashed when the tracer only knew the line. The changed-object flash keeps the colour job; the ring is shape.
  const rings = useMemo(() => accessTargets(scene, event), [scene, event]);
  const ringAt = (id: string, cell: number) => rings.find((r) => r.id === id && r.cell === cell);
  // A ring on a card row or a record line: the rectangle around it, thin for a read, thicker with an arrow-in for a write (on the left of a row, on top of a whole node).
  const ringBox = (r: { id: string; mode: string; exact: boolean }, at: { x: number; y: number; w: number; h: number }, name: string, top = false) => {
    const w = r.mode !== 'read' ? 3.8 : 2.2, pad = w / 2;
    return <g className="access" data-testid={`access-ring-${r.id}-${name}`} data-mode={r.mode} data-exact={r.exact ? 'yes' : 'no'}>
      <rect className={`access-ring${r.mode !== 'read' ? ' strong' : ''}${r.exact ? '' : ' guess'}`} x={at.x - pad} y={at.y - pad} width={at.w + w} height={at.h + w} rx={4} strokeWidth={w}/>
      {r.mode !== 'read' && <path className="access-in" d={top ? `M ${at.x + at.w / 2 - 5} ${at.y - 13} L ${at.x + at.w / 2 + 5} ${at.y - 13} L ${at.x + at.w / 2} ${at.y - 6} Z` : `M ${at.x - 14} ${at.y + at.h / 2 - 5} L ${at.x - 14} ${at.y + at.h / 2 + 5} L ${at.x - 7} ${at.y + at.h / 2} Z`}/>}
    </g>;
  };
  const linksFrom = (id: string) => scene.links.filter((l) => l.from === id);
  const mark = (id: string) => (prevScene && !prevScene.boxes[id] ? 'enter' : changed.has(id) ? 'changed' : '');
  // The arrows that touch what this step changed stay in the accent colour; the rest go quiet, so one step reads as one path.
  const anyChange = changed.size > 0, live = (l: Link) => changed.has(l.from) || changed.has(l.to);
  const arrowCls = (l: Link) => (!anyChange ? 'arrow' : live(l) ? 'arrow live' : 'arrow muted');
  const arrowHead = (l: Link) => (!anyChange || live(l) ? 'url(#cv-arrowhead)' : 'url(#cv-arrowhead-muted)');
  // A scene taller than the panel opens fitted instead of at 100 percent; the reader's own zoom always wins.
  // Fitted no further than 45 percent: below that nothing is readable, so a phone pans rather than shrinks to a stamp.
  useEffect(() => {
    if (userZoom.current) return;
    const el = box.current; if (!el) return;
    // Fit to the boxes, not to the canvas: the canvas is a little taller when a step routes an arrow below the last
    // row, and letting that overhang zoom the whole picture out would shrink every node for one long arrow.
    const boxesBottom = Math.max(0, ...Object.values(scene.boxes).map((b) => b.y + b.h)) + 40;
    // Fitted to the structures only, as before the frames column existed: a call, a return or a growing list must not
    // rescale the whole picture under the reader. The column may then need a sideways pan; "Fit all" includes it.
    const k = Math.min((el.clientWidth - 12) / scene.width, (el.clientHeight - 12) / Math.min(scene.height, boxesBottom), 1);
    setZoom(k < 0.95 ? Math.min(1, Math.max(0.45, Math.round(k * 100) / 100)) : 1);
  }, [scene.width, scene.height]);
  const renderRecord = (id: string, b: Scene['boxes'][string], node: TraceEvent['heap'][string], tag: string[] | undefined, m: string, chainField?: string) => {
    const g = recGeom(node, chainField), sp = g.split, mainW = REC.mainW, mid = mainW / 2;
    const fmtData = (v: Value) => (v.kind === 'scalar' && v.value === null ? nullWord : fmt(v, 8));
    const mainText = sp.main ? fmt(sp.main[1], 8) : '', mainY = sp.rest.length + (sp.moreData ? 1 : 0) === 0 ? g.mainH / 2 + 5 : 22;
    const drawn = (v: Value) => v.kind === 'ref' && !!scene.boxes[v.id];
    const arrows = linksFrom(id).map((l) => { const d = linkPath(l, scene.boxes); return d && <path key={`${l.cell ?? 'n'}>${l.to}${l.port ? 'p' : ''}`} className={arrowCls(l)} data-from={l.from} data-to={l.to} d={d} markerEnd={arrowHead(l)}/>; });
    return <g key={id} className="vnode" data-testid={`box-${id}`} data-x={b.x} data-y={b.y} style={{ transform: `translate(${b.x}px, ${b.y}px)` }}>
      <title>{`${node.type} ${id}${node.address ? ` at ${node.address}` : ''}${accessClause({ ids: [id] }, event)}: ${Object.entries(node.fields ?? {}).map(([k, v]) => `${k}=${v.kind === 'ref' ? v.id : fmt(v, 20)}`).join(', ')}`}</title>
      {tag && <Tag names={tag}/>}
      <g key={m ? `${m}${event.step}` : 's'} className={m}>
        <rect className={`node-box${node.orphan ? ' orphan' : ''}`} width={b.w} height={g.mainH} rx="10"/>
        {sp.side && <line className="node-divider" x1={mainW} x2={mainW} y1="0" y2={g.mainH}/>}
        {sp.main && <text className="node-main" x={mid} y={mainY} textAnchor="middle"><title>{`${sp.main[0]}: ${String(sp.main[1].kind === 'scalar' ? sp.main[1].value : '')}`}</title>{mainText}</text>}
        {sp.rest.map(([k, v], i) => <text className="node-rest" key={k} x={mid} y={mainY + 15 + i * REC.line} textAnchor="middle" data-testid="data-line"><title>{`${k}: ${v.kind === 'scalar' ? String(v.value) : v.kind}`}</title>{`${k}: ${clipText(fmtData(v), 7)}`}</text>)}
        {sp.moreData > 0 && <text className="node-rest" x={mid} y={mainY + 15 + sp.rest.length * REC.line} textAnchor="middle">{`+${sp.moreData} more`}</text>}
        {rings.filter((r) => r.id === id && r.field !== undefined).map((r) => <g key="node">{ringBox(r, { x: 0, y: 0, w: b.w, h: b.h }, 'node', true)}</g>)}
        {sp.side && <Pointer name={sp.side[0]} value={sp.side[1]} x={mainW + REC.ptrW / 2} y={g.mainH / 2 + 4} drawn={drawn(sp.side[1])} nullWord={nullWord} strip={false}/>}
        {sp.under.map(([k, v], i) => <g key={k} transform={`translate(0 ${g.mainH + i * REC.strip})`}>
          <rect className="node-box ptr-strip" width={b.w} height={REC.strip} rx="6"/>
          <Pointer name={k} value={v} x={b.w - 14} y={REC.strip / 2} drawn={drawn(v)} nullWord={nullWord} strip/></g>)}
      </g>
      <text className="node-id" x="0" y={b.h + 14}>{node.orphan && !node.freed && <title>{ORPHAN_HINT}</title>}{node.freed ? `${id} (freed)` : node.orphan ? `${id} · unreferenced` : b.rec ? clipText(`${id} ${node.type}`, 20) : id}</text>
      {arrows}
    </g>;
  };
  const gs = useMemo(() => scene.graph ?? graphSpec(event), [event, scene]);
  // A graph vertex: a rounded card with its plain values. Its pointer fields and neighbour list are the arrows (one-way edges have one head,
  // two vertices that point at each other share a line with two heads). The title lists every edge and the list it came from.
  const renderVertex = (id: string, b: Scene['boxes'][string], node: TraceEvent['heap'][string], tag: string[] | undefined, m: string) => {
    const cut = vertexCutOff(event.heap, id, gs), d = vertexDisplay(node), listFields = gs.edgeFields.get(node.type) ?? [], out = vertexEdges(event.heap, id, gs);
    const via = listFields.map((f) => { const v = node.fields?.[f]; return v?.kind === 'ref' ? `${f} = ${v.id}` : ''; }).filter(Boolean).join(', ');
    const mainY = d.rest.length + (d.more > 0 ? 1 : 0) + (cut > 0 ? 1 : 0) === 0 ? b.h / 2 + 5 : 22;
    const fv = (v: Value) => (v.kind === 'scalar' && v.value === null ? nullWord : fmt(v, 8));
    return <g key={id} className="vnode vertex" data-testid={`box-${id}`} data-x={b.x} data-y={b.y} style={{ transform: `translate(${b.x}px, ${b.y}px)` }}>
      <title>{`${node.type} ${id}${node.address ? ` at ${node.address}` : ''}: ${out.length ? `edges to ${out.join(', ')}` : 'no edges'}${via ? ` (neighbour list ${via})` : ''}${cut ? `; ${cut} neighbour-list items not captured` : ''}`}</title>
      {tag && <Tag names={tag}/>}
      <g key={m ? `${m}${event.step}` : 's'} className={m}>
        <rect className={`node-box vertex-box${node.orphan ? ' orphan' : ''}`} width={b.w} height={b.h} rx="16"/>
        {d.main && <text className="node-main" x={b.w / 2} y={mainY} textAnchor="middle"><title>{`${d.main[0]}: ${String(d.main[1].kind === 'scalar' ? d.main[1].value : '')}`}</title>{clipText(fmt(d.main[1], 8), 8)}</text>}
        {d.rest.map(([k, v], i) => <text className="node-rest" key={k} x={b.w / 2} y={mainY + 15 + i * REC.line} textAnchor="middle" data-testid="data-line">{`${clipText(k, 7)}: ${clipText(fv(v), 7)}`}</text>)}
        {d.more > 0 && <text className="node-rest" x={b.w / 2} y={mainY + 15 + d.rest.length * REC.line} textAnchor="middle">{`+${d.more} more`}</text>}
        {cut > 0 && <text className="node-rest" x={b.w / 2} y={mainY + 15 + (d.rest.length + (d.more > 0 ? 1 : 0)) * REC.line} textAnchor="middle" data-testid="edges-cut"><title>{`${cut} neighbour-list item${cut === 1 ? '' : 's'} not captured by the recording`}</title>{`${cut} edge${cut === 1 ? '' : 's'} not captured`}</text>}
      </g>
      <text className="node-id" x="9" y="12">{id}</text>
      {linksFrom(id).map((l) => { const p = linkPath(l, scene.boxes); return p && <g key={`g>${l.to}`} data-testid={`edge-${l.from}-${l.to}`}><path className={arrowCls(l)} data-from={l.from} data-to={l.to} d={p} markerEnd={arrowHead(l)} markerStart={l.both ? arrowHead(l) : undefined}/>{l.label && l.mid && <text className="edge-label" x={l.mid.x} y={l.mid.y - 4} textAnchor="middle">{l.label}</text>}</g>; })}
    </g>;
  };
  // An adjacency-list graph vertex: a circle labelled by its index. Its arrows come from the inner lists (scene.links,
  // paths already laid out). Not a heap object, so no id tag; the title keeps it inspectable.
  const renderAdjVertex = (id: string, g: NonNullable<Scene['adjGroups']>[number]) => {
    const b = scene.boxes[id]; if (!b) return null;
    const m = mark(id), label = id.slice(id.indexOf('#') + 1);
    const out = linksFrom(id).filter((l) => l.to !== id).map((l) => l.to.slice(l.to.indexOf('#') + 1)), self = linksFrom(id).some((l) => l.to === id);
    return <g key={id} className="vnode vertex adjv" data-testid={`box-${id}`} data-x={b.x} data-y={b.y} style={{ transform: `translate(${b.x}px, ${b.y}px)` }}>
      <title>{`vertex ${label} of ${g.label}: ${out.length ? `edges to ${out.join(', ')}` : 'no edges'}${self ? ' (and itself)' : ''}; adjacency list ${g.outer}`}</title>
      <g key={m ? `${m}${event.step}` : 's'} className={m}>
        <circle className="node-box vertex-circle" cx={b.w / 2} cy={b.h / 2} r={b.w / 2}/>
        <text className="node-main" x={b.w / 2} y={b.h / 2 + 5} textAnchor="middle">{label}</text>
      </g>
      {linksFrom(id).map((l) => { const pth = linkPath(l, scene.boxes); return pth && <g key={`g>${l.to}`} data-testid={`edge-${l.from}-${l.to}`}><path className={arrowCls(l)} data-from={l.from} data-to={l.to} d={pth} markerEnd={arrowHead(l)} markerStart={l.both ? arrowHead(l) : undefined}/>{l.label && l.mid && <text className="edge-label" x={l.mid.x} y={l.mid.y - 4} textAnchor="middle">{l.label}</text>}</g>; })}
    </g>;
  };
  const adjGroups = scene.adjGroups ?? [];
  return <section className="panel structures" aria-label="Structures">
    <div className="structures-head"><h2>Structures <small>every captured object: lists, arrays, and object cards</small></h2>
      <div className="zoom-bar" role="group" aria-label="Zoom and pan the diagram">
        <button type="button" aria-label="Pan left" onClick={() => pan(-240, 0)}>←</button><button type="button" aria-label="Pan up" onClick={() => pan(0, -160)}>↑</button><button type="button" aria-label="Pan down" onClick={() => pan(0, 160)}>↓</button><button type="button" aria-label="Pan right" onClick={() => pan(240, 0)}>→</button>
        <button type="button" aria-label="Zoom out" onClick={() => setZ(zoom / 1.25)}>−</button><output data-testid="zoom-level">{Math.round(zoom * 100)}%</output><button type="button" aria-label="Zoom in" onClick={() => setZ(zoom * 1.25)}>+</button>
        <button type="button" aria-pressed={showVars} data-testid="toggle-vars" title="Show or hide the stack frames and their arrows" onClick={() => setShowVars(!showVars)}>Variables</button><button type="button" onClick={fit}>Fit all</button><button type="button" onClick={() => setZ(1)}>100%</button></div></div>
    <ul className="sr-only" data-testid="lane-summaries">{summaries.map((s, i) => <li key={i}>{s}</li>)}</ul>
    {!scene.lanes.length && !scene.cards.length && !adjGroups.length && <p className="empty" data-testid="structures-empty">No linked-list nodes or arrays at this snapshot.{scene.nulls.length > 0 && ` ${nullWord}: ${scene.nulls.join(', ')}.`}</p>}
    {(scene.lanes.length > 0 || scene.cards.length > 0 || adjGroups.length > 0 || withVars) && <div className="structure-scroll" ref={box} tabIndex={0} role="group" aria-label="Structure diagram. Drag, use arrow keys or the pan buttons to move; zoom with the buttons"
      onPointerDown={(e) => { if (e.button === 0 && box.current) drag.current = { x: e.clientX, y: e.clientY, l: box.current.scrollLeft, t: box.current.scrollTop }; }}
      onPointerMove={(e) => { const d = drag.current; if (d && box.current && e.buttons === 1) box.current.scrollTo({ left: d.l - (e.clientX - d.x), top: d.t - (e.clientY - d.y) }); }}
      onPointerUp={() => { drag.current = null; }} onPointerLeave={() => { drag.current = null; }}>
      <svg width={Math.ceil(totalW * zoom)} height={Math.ceil(totalH * zoom)} viewBox={`0 0 ${totalW} ${totalH}`} role="img" aria-label={summaries.join('. ')} data-testid="structure-svg" data-zoom={zoom}>
        <defs><marker id="cv-arrowhead" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10z" className="arrowhead"/></marker><marker id="cv-arrowhead-muted" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10z" className="arrowhead-muted"/></marker><marker id="cv-var-head" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="8" markerHeight="8" orient="auto"><path d="M0 0 L10 5 L0 10z" className="var-head"/></marker><marker id="cv-var-head-quiet" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="8" markerHeight="8" orient="auto"><path d="M0 0 L10 5 L0 10z" className="var-head quiet"/></marker></defs>
        <g className="heap-area" transform={offX ? `translate(${offX} 0)` : undefined}>
        {scene.cards.map((id) => {
          const b = scene.boxes[id], node = event.heap[id], tag = scene.tags[id], m = mark(id);
          if (b.vertex) return renderVertex(id, b, node, tag, m);
          if (b.rec) return renderRecord(id, b, node, tag, m);
          const rows = cardRows(node);
          return <g key={id} className="vnode" data-testid={`box-${id}`} data-x={b.x} data-y={b.y} style={{ transform: `translate(${b.x}px, ${b.y}px)` }}>
            <title>{`${node.type} ${id}${node.address ? ` at ${node.address}` : ''}${node.freed ? ' (freed)' : ''}${accessClause({ ids: [id] }, event)}`}</title>
            {tag && <Tag names={tag}/>}
            <g key={m ? `${m}${event.step}` : 's'} className={m}>
              <rect className={`node-box card-box${node.freed ? ' freed' : ''}`} width={b.w} height={b.h} rx="8"/>
              <text className="card-head" x="8" y="17">{clipText(`${id} ${node.type}`, 17)}{node.freed ? ' (freed)' : ''}</text>
              <line className="node-divider" x1="0" x2={b.w} y1={CARD.head - 4} y2={CARD.head - 4} />
              {rows.map((r, i) => { const isRef = r.value?.kind === 'ref', ok = isRef && !!scene.boxes[(r.value as { id: string }).id];
                return <g key={i} className="card-row"><title>{`${r.label ? r.label + ": " : ""}${r.value ? (r.value.kind === "ref" ? `-> ${r.value.id}` : r.value.kind === "scalar" ? (r.value.value === null ? nullWord : String(r.value.value)) : r.value.kind) : r.note ?? ""}`}</title><text className="card-label" x="8" y={portY(i) + 4}>{clipText(r.label, 7)}</text>
                  <text className={`card-value${r.note ? ' note' : ''}`} x={b.w - (isRef ? 22 : 10)} y={portY(i) + 4} textAnchor="end">{isRef && !ok ? `${(r.value as { id: string }).id} missing` : isRef ? (r.value as { id: string }).id : cardText(r.value, nullWord, r.note)}</text>
                  {ok && <circle className="node-dot" cx={b.w - 10} cy={portY(i)} r="3.5"/>}</g>; })}
              {rings.filter((r) => r.id === id && r.row !== undefined).map((r) => <g key={r.row}>{ringBox(r, { x: 3, y: portY(r.row!) - CARD.row / 2 + 1, w: b.w - 6, h: CARD.row - 2 }, `row${r.row}`)}</g>)}
            </g>
            {linksFrom(id).map((l) => { const d = linkPath(l, scene.boxes); return d && <path key={`${l.cell}>${l.to}`} className={arrowCls(l)} data-from={l.from} data-to={l.to} d={d} markerEnd={arrowHead(l)}/>; })}
          </g>;
        })}
        {scene.lanes.map((lane) => lane.ids.map((id) => {
          const box = scene.boxes[id], node = event.heap[id], tag = scene.tags[id], m = mark(id);
          const arrows = linksFrom(id).map((l) => { const d = linkPath(l, scene.boxes); return d && <path key={`${l.cell ?? 'n'}>${l.to}${l.port ? 'p' : ''}`} className={arrowCls(l)} data-from={l.from} data-to={l.to} d={d} markerEnd={arrowHead(l)}/>; });
          if (lane.kind === 'array') {
            const items = node.items ?? [], omitted = arrayOmitted(node), cells = Math.max(1, items.length + (omitted > 0 ? 1 : 0));
            // A stack is a vertical column, cell 0 at the bottom, top marked; a queue is horizontal with front/back marks.
            // When the recording cut items off, the missing end is the one not marked: the true top/back was not captured.
            const cx = (i: number) => (box.stack ? 0 : i * GEOM.cell);
            const cy = (i: number) => (box.stack ? box.h - (i + 1) * GEOM.cell : 0);
            return <g key={id} className="vnode" data-testid={`box-${id}`} data-x={box.x} data-y={box.y} style={{ transform: `translate(${box.x}px, ${box.y}px)` }}>
              <title>{`${node.type} ${id}, length ${node.length ?? items.length}`}</title>
              {tag && <Tag names={tag}/>}
              {items.map((v, i) => {
                const arrowed = v.kind === 'ref' && scene.boxes[v.id];
                // Only the cells whose value differs get the flash, not the whole array.
                const cm = m === 'enter' ? 'enter' : m === 'changed' && JSON.stringify(prev?.heap[id]?.items?.[i]) !== JSON.stringify(v) ? 'changed' : '';
                const ring = ringAt(id, i), ringW = ring && ring.mode !== 'read' ? 4.2 : 2.2, ringPad = 1 + ringW / 2;
                return <g key={i} className="cell"><g key={cm ? `${cm}${event.step}` : 's'} className={cm}>
                  <rect className="cell-box" x={cx(i)} y={cy(i)} width={GEOM.cell} height={GEOM.cell}/>
                  <text className="cell-value" x={cx(i) + GEOM.cell / 2} y={cy(i) + GEOM.cell / 2 + 4} textAnchor="middle">{arrowed ? '•' : fmt(v, 5)}</text></g>
                  {ring && <g className="access" data-testid={`access-ring-${id}-${i}`} data-mode={ring.mode} data-exact={ring.exact ? 'yes' : 'no'}>
                    <rect className={`access-ring${ring.mode !== 'read' ? ' strong' : ''}${ring.exact ? '' : ' guess'}`} x={cx(i) - ringPad} y={cy(i) - ringPad} width={GEOM.cell + ringPad * 2} height={GEOM.cell + ringPad * 2} rx={4} strokeWidth={ringW}/>
                    {ring.mode !== 'read' && <path className="access-in" d={`M ${cx(i) + GEOM.cell / 2 - 5} ${cy(i) - 13} L ${cx(i) + GEOM.cell / 2 + 5} ${cy(i) - 13} L ${cx(i) + GEOM.cell / 2} ${cy(i) - 6} Z`}/>}
                  </g>}
                  {box.stack
                    ? <text className="cell-index" x={-8} y={cy(i) + GEOM.cell / 2 + 4} textAnchor="end">{i}</text>
                    : <text className="cell-index" x={cellCentre(i)} y={GEOM.cell + 13} textAnchor="middle">{i}</text>}</g>;
              })}
              {items.length === 0 && omitted === 0 && <g className="cell" data-testid="empty-array"><rect className="cell-box empty" width={GEOM.cell} height={GEOM.cell}/><text className="cell-value" x={GEOM.cell / 2} y={GEOM.cell / 2 + 4} textAnchor="middle">[ ]</text><title>{`empty ${node.type}`}</title></g>}
              {omitted > 0 && <g className="cell"><rect className="cell-box omitted" x={box.stack ? 0 : items.length * GEOM.cell} y={box.stack ? 0 : 0} width={GEOM.cell} height={GEOM.cell}/><text className="cell-value" x={(box.stack ? 0 : items.length * GEOM.cell) + GEOM.cell / 2} y={GEOM.cell / 2 + 4} textAnchor="middle">…</text><title>{`${omitted} more not captured`}</title></g>}
              {box.stack && items.length > 0 && omitted === 0 && <text className="sq-mark" data-testid="stack-top" x={GEOM.cell + 8} y={cy(items.length - 1) + GEOM.cell / 2 + 4}>top</text>}
              {/* Front and back are marks under the first and last cell, but two marks that would touch are drawn as one caption
                  instead: a one-cell queue used to draw "front" and "back" on top of each other. */}
              {box.queue && items.length > 0 && (() => {
                const fx = cellCentre(0), bx = cellCentre(items.length - 1), gap = Math.abs(bx - fx), need = (MARK_W('front') + MARK_W('back')) / 2;
                const back = items.length > 1 && omitted === 0;
                return !back || gap < need
                  ? <text className="sq-mark" data-testid="queue-front" x={(fx + bx) / 2} y={GEOM.cell + 28} textAnchor="middle">{back ? 'front · back' : 'front'}</text>
                  : <g><text className="sq-mark" data-testid="queue-front" x={fx} y={GEOM.cell + 28} textAnchor="middle">front</text><text className="sq-mark" data-testid="queue-back" x={bx} y={GEOM.cell + 28} textAnchor="middle">back</text></g>;
              })()}
              {arrows}
            </g>;
          }
          return renderRecord(id, box, node, tag, m, linkField.get(node.type));
        }))}
              {adjGroups.map((g) => {
          const vs = g.vertices.map((id) => scene.boxes[id]).filter(Boolean);
          if (!vs.length) return null;
          const x0 = Math.min(...vs.map((b) => b.x)), y0 = Math.min(...vs.map((b) => b.y));
          return <g key={g.outer} data-testid={`adj-group-${g.outer}`}>
            <text className="adj-caption" data-testid={`adj-caption-${g.outer}`} x={x0} y={y0 - 12}>{`${g.label}: graph, ${g.vertices.length} vertices`}</text>
            {g.vertices.map((id) => renderAdjVertex(id, g))}
          </g>;
        })}
        </g>
        {withVars && <FramesColumn event={event} prev={prev} scene={scene} nullWord={nullWord}/>}
      </svg></div>}
    {(scene.lanes.length > 0 || scene.cards.length > 0) && scene.nulls.length > 0 && <p className="hint">{nullWord}: {scene.nulls.join(', ')}</p>}
    {Object.values(event.heap).some((n) => n.orphan && !n.freed) && <p className="hint" data-testid="orphan-legend">Dashed outline, "unreferenced": {ORPHAN_HINT}</p>}
    {event.unreached_heap && <p className="warning" data-testid="unreached-heap">{event.unreached_heap.count} live heap block{event.unreached_heap.count === 1 ? '' : 's'} ({event.unreached_heap.bytes.toLocaleString()} bytes) not shown: no captured variable or object points to {event.unreached_heap.count === 1 ? 'it' : 'them'} here. They can sit behind freed memory, belong to library objects such as strings, or be leaked. The diagram is not the whole heap.</p>}
    {scene.undrawn.length > 0 && <p className="hint">Not drawn here ({scene.undrawn.length}): {scene.undrawn.map((u) => `${u.id} ${u.type}`).join(', ')}. See the Heap panel.</p>}
  </section>;
});
