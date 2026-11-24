import { useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import type { Trace } from './types';
import { MAX_BYTES, parseTrace } from './parseTrace';
import { Replay } from './components/Replay';
const examples = ['01_scalars', '02_loop', '03_recursion', '04_list_mutation', '05_alias', '06_shallow_copy', '07_cycle', '08_stdout_input', '09_exception', '10_timeout'];
export function App() {
  const [trace, setTrace] = useState<Trace | null>(null), [name, setName] = useState(''), [error, setError] = useState(''), [dark, setDark] = useState(true), [busy, setBusy] = useState(false);
  const revision = useRef(0), [loaded, setLoaded] = useState(0);
  function begin() { const id = ++revision.current; setBusy(true); setError(''); return id; }
  function accept(raw: string, label: string, id: number) {
    if (id !== revision.current) return;
    try { const next = parseTrace(raw); setTrace(next); setName(label); setLoaded(id); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not read trace'); }
    finally { setBusy(false); }
  }
  async function upload(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; e.target.value = '';
    if (!file) return;
    const id = begin();
    if (file.size > MAX_BYTES) { setError('File is larger than the 20 MiB replay limit.'); setBusy(false); return; }
    try { accept(await file.text(), file.name, id); }
    catch { if (id === revision.current) { setError('Could not read this file.'); setBusy(false); } }
  }
  async function example(file: string) {
    if (!file) return;
    const id = begin();
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}examples/${file}.trace.json`);
      if (!response.ok) throw new Error('Missing example');
      accept(await response.text(), `${file}.trace.json`, id);
    } catch { if (id === revision.current) { setError('Could not load example. Use npm run dev or import a local JSON file.'); setBusy(false); } }
  }
  return <main data-theme={dark ? 'dark' : 'light'}><div className="app-shell"><header><div><p className="eyebrow">CODE VISUALIZER / MILESTONE 2</p><h1>Execution, one step at a time.</h1><p className="subtitle">Load a recording. Follow the state. No code execution.</p></div><button onClick={() => setDark(!dark)}>{dark ? 'Light mode' : 'Dark mode'}</button></header>
    <section className="loader" aria-label="Load recording"><label className="file-label">Open trace JSON<input type="file" accept=".json,application/json" onChange={upload}/></label><label className="example-label">Or explore a fixture<select aria-label="Example trace" value="" onChange={(e) => void example(e.target.value)}><option value="">Choose example...</option>{examples.map((file) => <option key={file} value={file}>{file.replaceAll('_', ' ')}</option>)}</select></label><span className="hint">Local files stay in this browser. Up to 20 MiB / 10,000 events.</span></section>
    {busy && <p role="status">Reading trace...</p>}{error && <div className="error" role="alert"><b>Could not load trace</b><p>{error}</p>{trace && <small>The previous recording is still loaded.</small>}</div>}
    {trace ? <><div className="recording-name">{name}</div><Replay trace={trace} key={loaded}/></> : <section className="welcome"><span className="welcome-number">01 → 02 → 03</span><h2>A recording, not a runner.</h2><p>Start with the alias fixture: two variables, one list. Then try recursion or a cycle.</p><button className="primary" onClick={() => void example('05_alias')}>Explore alias example</button><p className="hint">A line snapshot is captured before the highlighted line executes.</p></section>}
    <footer>Python trace v1.0 · File-based replay · Source and output are displayed as text</footer></div></main>;
}
