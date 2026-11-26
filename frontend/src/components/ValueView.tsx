import type { Value } from '../types';
export function ValueView({ value }: { value: Value }) {
  if (value.kind === 'ref') return <a className="ref" href={`#heap-${encodeURIComponent(value.id)}`}>→ {value.id}</a>;
  if (value.kind === 'opaque' && value.type.startsWith('uninitialised ')) return <span className="warning" title="This variable exists but its declaration has not stored a value yet">{value.type}</span>;
  if (value.kind === 'opaque') return <span className="muted">{value.type} (opaque)</span>;
  if (value.kind === 'truncated') return <span className="warning">{value.type}: omitted</span>;
  return <span className="scalar">{JSON.stringify(value.value)}{value.truncated && <b className="warning"> [truncated]</b>}</span>;
}
