import { memo } from 'react';
import type { TraceEvent } from '../types';
import { ValueView } from './ValueView';
export const Memory = memo(function Memory({ event }: { event: TraceEvent }) {
  return <><section className="panel"><h2>Call stack <small>{event.frames.length} frames</small></h2>
    <p className="hint">Outermost to current frame (<code>&lt;globals&gt;</code> and <code>&lt;module&gt;</code> are not stack frames). Parent lines are suspended call sites.</p>
    {event.frames.map((frame, i) => <article className="frame" key={frame.depth}>
      <h3>{frame.function} <small>line {frame.line}{i === event.frames.length - 1 ? ' · current' : ' · suspended'}</small></h3>
      {Object.keys(frame.locals).length ? <dl>{Object.entries(frame.locals).map(([name, value]) => <div className="binding" key={name}><dt>{name}</dt><dd><ValueView value={value}/></dd></div>)}</dl> : <p className="hint">No captured locals</p>}
    </article>)}
  </section><section className="panel"><h2>Heap <small>{Object.keys(event.heap).length} objects</small></h2>
    <p className="hint">References share a run-local ID. Cycles link back, never expand forever.</p>
    {!Object.keys(event.heap).length && <p className="empty">No reachable captured objects</p>}
    {Object.entries(event.heap).map(([id, node]) => <article className="heap-node" id={`heap-${encodeURIComponent(id)}`} key={id}>
      <h3><span className="ref">{id}</span> <small>{node.type}{node.length !== undefined ? ` · length ${node.length}` : ''}{node.storage ? ` · ${node.storage}` : ''}{node.address ? ` · ${node.address}` : ''}</small></h3>
      {node.freed && <p className="warning" data-testid="freed-note">Freed: the program already released this memory. A pointer to it is dangling.</p>}
      {node.opaque && <p className="hint">Opaque object. Internal data not captured.</p>}
      {node.items && <dl>{node.items.map((v, i) => <div className="binding" key={i}><dt>[{i}]</dt><dd><ValueView value={v}/></dd></div>)}</dl>}
      {node.entries && <dl>{node.entries.map(([k, v], i) => <div className="binding" key={i}><dt><ValueView value={k}/></dt><dd><ValueView value={v}/></dd></div>)}</dl>}
      {node.fields && <dl>{Object.entries(node.fields).map(([k, v]) => <div className="binding" key={k}><dt>{k}</dt><dd><ValueView value={v}/></dd></div>)}</dl>}
      {node.truncated && <p className="warning">Additional data omitted</p>}
    </article>)}
    <p className="hint">Missing later does not prove deallocation. IDs are not memory addresses.</p>
  </section></>;
});
