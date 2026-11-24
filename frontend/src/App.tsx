import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import type { Trace } from './types';
import { MAX_BYTES, parseTrace } from './parseTrace';
import { Replay } from './components/Replay';
import { RunPanel } from './components/RunPanel';
import type { Language, RunInfo } from './components/RunPanel';
import { SHARE_NOTICE, buildSessionHtml, readEmbeddedSession, sessionFileName } from './session';
import { MAX_WATCHES, parseWatch } from './watch';

// Set when this page is an exported session file: the trace is already inside the page.
const embedded = readEmbeddedSession(document);
const examples = ['01_scalars', '02_loop', '03_recursion', '04_list_mutation', '05_alias', '06_shallow_copy', '07_cycle', '08_stdout_input', '09_exception', '10_timeout', '11_linked_list_build', '12_linked_list_insert', '13_empty_and_single', '14_array_mutation', '15_alias_list_nodes', 'cpp_01_linked_list_swap', 'cpp_02_arrays_structs', 'cpp_03_recursion', 'cpp_04_binary_tree_insert', 'cpp_05_crash_null_pointer', 'cpp_06_use_after_free', 'cpp_07_memory_leak', 'cpp_08_uncaught_exception', 'cpp_09_string_and_vector', 'cpp_10_writes_a_file'];

// The editor draft survives a page refresh. It stays in this browser (localStorage), is never
// sent anywhere except to the local backend when you press Run, and is not part of exports.
const DRAFT_KEY = 'codeviz.draft.v1';
const STARTERS: Record<Language, string> = {
  python: 'a = [1]\nb = a\nb.append(2)\nprint(a)\n',
  cpp: '#include <iostream>\n\nint main() {\n    int* p = new int(5);\n    int* q = p;\n    *q = 7;\n    std::cout << *p << "\\n";\n    delete p;\n    return 0;\n}\n',
};
interface Draft { source: string; stdin: string; language: Language }
function readDraft(): Draft {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? 'null');
    if (d && typeof d.source === 'string' && typeof d.stdin === 'string') return { source: d.source, stdin: d.stdin, language: d.language === 'cpp' ? 'cpp' : 'python' };
  } catch { /* unreadable draft: start fresh */ }
  return { source: STARTERS.python, stdin: '', language: 'python' };
}

function initial(): { trace: Trace | null; error: string } {
  if (!embedded) return { trace: null, error: '' };
  try { return { trace: parseTrace(embedded), error: '' }; }
  catch (e) { return { trace: null, error: e instanceof Error ? e.message : 'Could not read the embedded session' }; }
}

export function App() {
  const start = useRef(initial()).current;
  const [trace, setTrace] = useState<Trace | null>(start.trace), [name, setName] = useState(embedded ? 'Shared session' : '');
  const [error, setError] = useState(start.error), [notice, setNotice] = useState(''), [dark, setDark] = useState(true), [busy, setBusy] = useState(false);
  const revision = useRef(0), [loaded, setLoaded] = useState(0);
  // M4 state that outlives one recording: the editor draft, breakpoints and watches.
  const [draft, setDraft] = useState(readDraft), [ranSource, setRanSource] = useState<string | null>(null), [runStats, setRunStats] = useState('');
  const [breakpoints, setBreakpoints] = useState<ReadonlySet<number>>(new Set()), [watches, setWatches] = useState<string[]>([]);

  useEffect(() => {
    if (embedded) return;
    const timer = window.setTimeout(() => { try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch { /* storage full or blocked: draft just won't persist */ } }, 400);
    return () => window.clearTimeout(timer);
  }, [draft]);

  function begin() { const id = ++revision.current; setBusy(true); setError(''); return id; }
  // Parses and validates (parseTrace) before anything is shown, then swaps the recording in.
  function accept(raw: string, label: string, id: number, fromRun = false) {
    if (id !== revision.current) return;
    try {
      const t0 = performance.now(), next = parseTrace(raw), ms = performance.now() - t0;
      setTrace(next); setName(label); setLoaded(id); setRanSource(fromRun ? next.source : null);
      setRunStats(`${next.events.length.toLocaleString()} events validated in ${Math.max(1, Math.round(ms))} ms`);
      if (!fromRun) setBreakpoints(new Set()); // a different program: old line numbers mean nothing
    }
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
  // Result of a backend run: same validation path as a file, then scroll the replay into view.
  const runResult = (raw: string, info: RunInfo) => {
    const id = begin();
    accept(raw, 'editor-run', id, true);
    setRunStats((s) => `${s}. Backend round trip ${Math.round(info.roundTripMs)} ms`);
    requestAnimationFrame(() => document.getElementById('replay')?.scrollIntoView({ block: 'start' }));
  };
  const toggleBreakpoint = useCallback((line: number) => setBreakpoints((current) => { const next = new Set(current); if (!next.delete(line)) next.add(line); return next; }), []);
  const addWatch = useCallback((text: string): string | null => {
    const parsed = parseWatch(text);
    if (!parsed.ok) return parsed.error;
    if (watches.includes(parsed.path.text)) return `Already watching ${parsed.path.text}`;
    if (watches.length >= MAX_WATCHES) return `Limit of ${MAX_WATCHES} watches reached`;
    setWatches([...watches, parsed.path.text]);
    return null;
  }, [watches]);
  const removeWatch = useCallback((text: string) => setWatches((w) => w.filter((x) => x !== text)), []);

  // Export: fetch the built viewer template, put the validated trace inside, download one .html file.
  async function exportSession() {
    if (!trace) return;
    setNotice('');
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}session-template.html`);
      if (!response.ok) throw new Error('template');
      const html = buildSessionHtml(await response.text(), JSON.stringify(trace));
      const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
      const a = document.createElement('a'); a.href = url; a.download = sessionFileName(name); a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice(`Exported ${sessionFileName(name)}. ${SHARE_NOTICE}`);
    } catch { setError('Could not build the session file. Use npm run dev, or npm run build then npm run preview.'); }
  }
  const stale = trace && ranSource !== null && ranSource !== draft.source;
  return <main data-theme={dark ? 'dark' : 'light'}><div className="app-shell"><header><div><p className="eyebrow">CODE VISUALIZER / {embedded ? 'SHARED SESSION' : 'MILESTONE 5'}</p><h1>Execution, one step at a time.</h1><p className="subtitle">{embedded ? 'An exported recording. It replays offline and never runs code.' : 'Write Python or C++, record a run on this computer, then step through it with breakpoints and watches.'}</p></div><button onClick={() => setDark(!dark)}>{dark ? 'Light mode' : 'Dark mode'}</button></header>
    {!embedded && <RunPanel source={draft.source} stdin={draft.stdin} onSource={(source) => setDraft((d) => ({ ...d, source }))} onStdin={(stdin) => setDraft((d) => ({ ...d, stdin }))} language={draft.language} onLanguage={(language) => setDraft((d) => ({ ...d, language, source: d.source.trim() === '' || d.source === STARTERS[d.language] ? STARTERS[language] : d.source }))} onResult={runResult}/>}
    {!embedded && <section className="loader" aria-label="Load recording"><label className="file-label">Open trace JSON<input type="file" accept=".json,application/json" onChange={upload}/></label><label className="example-label">Or explore a fixture<select aria-label="Example trace" value="" onChange={(e) => void example(e.target.value)}><option value="">Choose example...</option>{examples.map((file) => <option key={file} value={file}>{file.replaceAll('_', ' ')}</option>)}</select></label><span className="hint">Saved recordings replay without the backend. Local files stay in this browser. Up to 20 MiB / 10,000 events.</span></section>}
    {busy && <p role="status">Reading trace...</p>}{error && <div className="error" role="alert"><b>Could not load trace</b><p>{error}</p>{trace && <small>The previous recording is still loaded.</small>}</div>}
    <div id="replay">{trace ? <><div className="recording-name">{name}{!embedded && <> <button className="export" onClick={() => void exportSession()}>Export session (.html)</button></>}</div>{embedded && <p className="hint" data-testid="share-notice">{SHARE_NOTICE}</p>}{!embedded && <p className="hint">{SHARE_NOTICE}</p>}{runStats && <p className="hint" data-testid="load-stats">{runStats}.</p>}{stale && <p className="warning" data-testid="stale-note">The editor has changed since this recording. Press Run and record to update it.</p>}{notice && <p role="status" data-testid="export-notice">{notice}</p>}<Replay trace={trace} key={loaded} breakpoints={breakpoints} onToggleBreakpoint={toggleBreakpoint} watches={watches} onAddWatch={addWatch} onRemoveWatch={removeWatch}/></> : <section className="welcome"><span className="welcome-number">01 → 02 → 03</span><h2>Record a run, then replay it.</h2><p>Press Run and record on the program above, or start with the alias fixture: two variables, one list.</p><button className="primary" onClick={() => void example('05_alias')}>Explore alias example</button><p className="hint">A line snapshot is captured before the highlighted line executes.</p></section>}</div>
    <footer>Trace v1.0 (Python and C++) · Local backend + file-based replay · Breakpoints and watches read recorded events · Source and output are displayed as text</footer></div></main>;
}
