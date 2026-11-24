import { useCallback, useEffect, useRef, useState } from 'react';
import { CodeEditor } from './CodeEditor';

// M4: paste code, run it through the LOCAL backend, get a trace back. The backend is
// http://127.0.0.1:8000, reached through the dev server's /api proxy (see vite.config.ts), so
// the browser only ever talks to its own origin.
export const MAX_SOURCE_BYTES = 65536;
export type Language = 'python' | 'cpp';
export const LANGUAGE_NAMES: Record<Language, string> = { python: 'Python', cpp: 'C++' };
export interface ExampleProgram { id: string; title: string; source: string; stdin: string; language?: Language }
export interface RunInfo { bytes: number; serverMs: number | null; roundTripMs: number }
type Cpp = { available: boolean; gpp: boolean; gdb: boolean } | null;
type Backend = { state: 'checking' } | { state: 'online'; python: string; cpp: Cpp } | { state: 'offline' };
const EVENT_CHOICES = [500, 1000, 2000], TIMEOUT_CHOICES = [2, 5, 10]; // C++ needs about 0.5 s of compile and start-up time on top of the program itself

// "capture;dur=267.9, encode;dur=54.8" -> 267.9 + 54.8
function serverTime(header: string | null): number | null {
  if (!header) return null;
  const parts = [...header.matchAll(/dur=([\d.]+)/g)].map((m) => Number(m[1]));
  return parts.length ? parts.reduce((a, b) => a + b, 0) : null;
}
const bytesOf = (s: string) => new TextEncoder().encode(s).length;

export function RunPanel({ source, stdin, language, onSource, onStdin, onLanguage, onResult, collapsed = false, onToggleCollapsed }: { collapsed?: boolean; onToggleCollapsed?: () => void; source: string; stdin: string; language: Language; onSource: (s: string) => void; onStdin: (s: string) => void; onLanguage: (l: Language) => void; onResult: (raw: string, info: RunInfo) => void }) {
  const [backend, setBackend] = useState<Backend>({ state: 'checking' });
  const [examples, setExamples] = useState<ExampleProgram[]>([]);
  const [events, setEvents] = useState(500), [timeout, setTimeoutSeconds] = useState(2);
  const [running, setRunning] = useState(false), [message, setMessage] = useState(''), [info, setInfo] = useState<RunInfo | null>(null);
  const controller = useRef<AbortController | null>(null), runId = useRef(0);

  const check = useCallback(async () => {
    setBackend({ state: 'checking' });
    try {
      const health = await fetch('/api/health', { signal: AbortSignal.timeout(3000) });
      if (!health.ok) throw new Error('health');
      const body = await health.json(), python = String(body.python ?? ''), cpp: Cpp = body.cpp && typeof body.cpp === 'object' ? body.cpp : null;
      const list = await fetch('/api/examples', { signal: AbortSignal.timeout(3000) });
      if (list.ok) setExamples((await list.json()).examples as ExampleProgram[]);
      setBackend({ state: 'online', python, cpp });
    } catch { setBackend({ state: 'offline' }); }
  }, []);
  useEffect(() => { void check(); return () => controller.current?.abort(); }, [check]);

  const shown = examples.filter((x) => (x.language ?? 'python') === language);
  const cppMissing = language === 'cpp' && backend.state === 'online' && backend.cpp !== null && !backend.cpp.available;
  const size = bytesOf(source), tooBig = size > MAX_SOURCE_BYTES;
  async function run() {
    if (running || tooBig || !source.trim()) return;
    const id = ++runId.current, abort = new AbortController();
    controller.current = abort; setRunning(true); setMessage(''); setInfo(null);
    const started = performance.now();
    try {
      const response = await fetch('/api/trace', { method: 'POST', headers: { 'content-type': 'application/json' }, signal: abort.signal, body: JSON.stringify({ source, stdin, language, timeout, max_events: events }) });
      const text = await response.text();
      if (id !== runId.current) return;
      if (!response.ok) {
        let why = `The backend answered ${response.status}.`;
        try { why = JSON.parse(text).error.message; } catch { /* not our JSON error: keep the generic text */ }
        setMessage(response.status === 429 ? `${why}` : why);
        return;
      }
      const next = { bytes: text.length, serverMs: serverTime(response.headers.get('server-timing')), roundTripMs: performance.now() - started };
      setInfo(next); setBackend((b) => (b.state === 'online' ? b : { state: 'online', python: '', cpp: null }));
      onResult(text, next);
    } catch (e) {
      if (id !== runId.current || (e instanceof DOMException && e.name === 'AbortError')) return;
      setBackend({ state: 'offline' });
      setMessage('Could not reach the local backend. Start it (see the box below), then press Run again.');
    } finally { if (id === runId.current) setRunning(false); }
  }
  function cancel() { runId.current++; controller.current?.abort(); setRunning(false); setMessage('Stopped waiting. The backend run itself ends at its time limit.'); }

  return <section className={`panel run-panel${collapsed ? ' collapsed' : ''}`} aria-label="Run your code"><div className="run-head"><h2>Write code <small>{LANGUAGE_NAMES[language]} · runs on this computer</small></h2>
    <span className={`backend-badge ${backend.state}`} role="status" data-testid="backend-state">{backend.state === 'online' ? `Backend online${backend.python ? ` · Python ${backend.python}` : ''}` : backend.state === 'checking' ? 'Checking backend...' : 'Backend offline'}</span></div>
    <div className="run-bar">
      <label className="example-label">Language<select aria-label="Language" value={language} onChange={(e) => { onLanguage(e.target.value as Language); setMessage(''); }}><option value="python">Python</option><option value="cpp">C++</option></select></label>
      <label className="example-label">Example program<select aria-label="Example program" value="" disabled={!shown.length} onChange={(e) => { const x = shown.find((p) => p.id === e.target.value); if (x) { onSource(x.source); onStdin(x.stdin); setMessage(''); } }}><option value="">{shown.length ? 'Choose example...' : 'Needs backend'}</option>{shown.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}</select></label>
      <label className="example-label">Event limit<select aria-label="Event limit" value={events} onChange={(e) => setEvents(Number(e.target.value))}>{EVENT_CHOICES.map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
      <label className="example-label">Time limit<select aria-label="Time limit" value={timeout} onChange={(e) => setTimeoutSeconds(Number(e.target.value))}>{TIMEOUT_CHOICES.map((n) => <option key={n} value={n}>{n} s</option>)}</select></label>
    </div>
    {!collapsed && <CodeEditor value={source} onChange={onSource} onRun={() => void run()} label={`${LANGUAGE_NAMES[language]} source code`}/>}
    {!collapsed && <details className="stdin"><summary>Program input (stdin){stdin ? ' · set' : ''}</summary><textarea aria-label="Program input" value={stdin} maxLength={8192} rows={2} onChange={(e) => onStdin(e.target.value)} spellCheck={false}/></details>}
    <div className="run-actions">{running ? <button type="button" onClick={cancel}>Cancel</button> : <button type="button" className="primary" onClick={() => void run()} disabled={tooBig || !source.trim() || cppMissing}>Run and record</button>}
      {onToggleCollapsed && <button type="button" className="edit-toggle" aria-expanded={!collapsed} onClick={onToggleCollapsed}>{collapsed ? 'Edit code' : 'Hide editor'}</button>}
      <span className="hint">{running ? 'Tracing...' : 'Ctrl+Enter also runs. In the editor, Tab indents; press Esc then Tab to leave it.'}</span>
      <span className={`hint ${tooBig ? 'warning' : ''}`}>{size.toLocaleString()} / {MAX_SOURCE_BYTES.toLocaleString()} bytes</span></div>
    {!collapsed && language === 'cpp' && <p className="run-twice warning" data-testid="run-twice-warning"><b>C++ runs your program twice:</b> once for the step-by-step recording and once for the memory check. Each run gets its own empty working folder, so relative file names do not collide. Files written with absolute paths, and network calls, can still happen twice.</p>}
    {cppMissing && backend.state === 'online' && <div className="offline-help" data-testid="cpp-missing"><b>C++ tools not found.</b> This backend needs {[!backend.cpp?.gpp && 'g++', !backend.cpp?.gdb && 'gdb'].filter(Boolean).join(' and ')} on its PATH. On Ubuntu or WSL: <code>sudo apt install g++ gdb</code>, then press Check again.<br/><button type="button" onClick={() => void check()}>Check again</button></div>}
    {message && <div className="error" role="alert" data-testid="run-error"><b>Run failed</b><p>{message}</p></div>}
    {info && !message && <p className="hint" data-testid="run-info">Recorded {(info.bytes / 1e6).toFixed(2)} MB in {Math.round(info.roundTripMs)} ms{info.serverMs !== null ? `, of which ${Math.round(info.serverMs)} ms on the backend` : ''}.</p>}
    {backend.state === 'offline' && <div className="offline-help" data-testid="offline-help"><b>Backend not running.</b> Opening saved recordings below still works. To run code, open a second terminal in the repository folder:<pre>{`pip install -r backend/requirements.txt\npython -m uvicorn backend.app:app --host 127.0.0.1 --port 8000`}</pre><button type="button" onClick={() => void check()}>Check again</button></div>}
    <p className="hint">Run only programs you trust. They run as you, can read your files and use the network, and the backend is not a sandbox. Nothing is sent anywhere except to the backend on this computer.</p>
  </section>;
}
