import { useCallback, useEffect, useRef, useState } from 'react';
import { CodeEditor } from './CodeEditor';

// M4: paste code, run it through the LOCAL backend, get a trace back. The backend is
// http://127.0.0.1:8000, reached through the dev server's /api proxy (see vite.config.ts), so
// the browser only ever talks to its own origin.
export const MAX_SOURCE_BYTES = 65536;
export interface ExampleProgram { id: string; title: string; source: string; stdin: string }
export interface RunInfo { bytes: number; serverMs: number | null; roundTripMs: number }
type Backend = { state: 'checking' } | { state: 'online'; python: string } | { state: 'offline' };
const EVENT_CHOICES = [500, 1000, 2000], TIMEOUT_CHOICES = [2, 5, 10];

// "capture;dur=267.9, encode;dur=54.8" -> 267.9 + 54.8
function serverTime(header: string | null): number | null {
  if (!header) return null;
  const parts = [...header.matchAll(/dur=([\d.]+)/g)].map((m) => Number(m[1]));
  return parts.length ? parts.reduce((a, b) => a + b, 0) : null;
}
const bytesOf = (s: string) => new TextEncoder().encode(s).length;

export function RunPanel({ source, stdin, onSource, onStdin, onResult }: { source: string; stdin: string; onSource: (s: string) => void; onStdin: (s: string) => void; onResult: (raw: string, info: RunInfo) => void }) {
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
      const python = String((await health.json()).python ?? '');
      const list = await fetch('/api/examples', { signal: AbortSignal.timeout(3000) });
      if (list.ok) setExamples((await list.json()).examples as ExampleProgram[]);
      setBackend({ state: 'online', python });
    } catch { setBackend({ state: 'offline' }); }
  }, []);
  useEffect(() => { void check(); return () => controller.current?.abort(); }, [check]);

  const size = bytesOf(source), tooBig = size > MAX_SOURCE_BYTES;
  async function run() {
    if (running || tooBig || !source.trim()) return;
    const id = ++runId.current, abort = new AbortController();
    controller.current = abort; setRunning(true); setMessage(''); setInfo(null);
    const started = performance.now();
    try {
      const response = await fetch('/api/trace', { method: 'POST', headers: { 'content-type': 'application/json' }, signal: abort.signal, body: JSON.stringify({ source, stdin, timeout, max_events: events }) });
      const text = await response.text();
      if (id !== runId.current) return;
      if (!response.ok) {
        let why = `The backend answered ${response.status}.`;
        try { why = JSON.parse(text).error.message; } catch { /* not our JSON error: keep the generic text */ }
        setMessage(response.status === 429 ? `${why}` : why);
        return;
      }
      const next = { bytes: text.length, serverMs: serverTime(response.headers.get('server-timing')), roundTripMs: performance.now() - started };
      setInfo(next); setBackend((b) => (b.state === 'online' ? b : { state: 'online', python: '' }));
      onResult(text, next);
    } catch (e) {
      if (id !== runId.current || (e instanceof DOMException && e.name === 'AbortError')) return;
      setBackend({ state: 'offline' });
      setMessage('Could not reach the local backend. Start it (see the box below), then press Run again.');
    } finally { if (id === runId.current) setRunning(false); }
  }
  function cancel() { runId.current++; controller.current?.abort(); setRunning(false); setMessage('Stopped waiting. The backend run itself ends at its time limit.'); }

  return <section className="panel run-panel" aria-label="Run your code"><div className="run-head"><h2>Write code <small>Python · runs on this computer</small></h2>
    <span className={`backend-badge ${backend.state}`} role="status" data-testid="backend-state">{backend.state === 'online' ? `Backend online${backend.python ? ` · Python ${backend.python}` : ''}` : backend.state === 'checking' ? 'Checking backend...' : 'Backend offline'}</span></div>
    <div className="run-bar">
      <label className="example-label">Example program<select aria-label="Example program" value="" disabled={!examples.length} onChange={(e) => { const x = examples.find((p) => p.id === e.target.value); if (x) { onSource(x.source); onStdin(x.stdin); setMessage(''); } }}><option value="">{examples.length ? 'Choose example...' : 'Needs backend'}</option>{examples.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}</select></label>
      <label className="example-label">Event limit<select aria-label="Event limit" value={events} onChange={(e) => setEvents(Number(e.target.value))}>{EVENT_CHOICES.map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
      <label className="example-label">Time limit<select aria-label="Time limit" value={timeout} onChange={(e) => setTimeoutSeconds(Number(e.target.value))}>{TIMEOUT_CHOICES.map((n) => <option key={n} value={n}>{n} s</option>)}</select></label>
    </div>
    <CodeEditor value={source} onChange={onSource} onRun={() => void run()}/>
    <details className="stdin"><summary>Program input (stdin){stdin ? ' · set' : ''}</summary><textarea aria-label="Program input" value={stdin} maxLength={8192} rows={2} onChange={(e) => onStdin(e.target.value)} spellCheck={false}/></details>
    <div className="run-actions">{running ? <button type="button" onClick={cancel}>Cancel</button> : <button type="button" className="primary" onClick={() => void run()} disabled={tooBig || !source.trim()}>Run and record</button>}
      <span className="hint">{running ? 'Tracing...' : 'Ctrl+Enter also runs. In the editor, Tab indents; press Esc then Tab to leave it.'}</span>
      <span className={`hint ${tooBig ? 'warning' : ''}`}>{size.toLocaleString()} / {MAX_SOURCE_BYTES.toLocaleString()} bytes</span></div>
    {message && <div className="error" role="alert" data-testid="run-error"><b>Run failed</b><p>{message}</p></div>}
    {info && !message && <p className="hint" data-testid="run-info">Recorded {(info.bytes / 1e6).toFixed(2)} MB in {Math.round(info.roundTripMs)} ms{info.serverMs !== null ? `, of which ${Math.round(info.serverMs)} ms on the backend` : ''}.</p>}
    {backend.state === 'offline' && <div className="offline-help" data-testid="offline-help"><b>Backend not running.</b> Opening saved recordings below still works. To run code, open a second terminal in the repository folder:<pre>{`pip install -r backend/requirements.txt\npython -m uvicorn backend.app:app --host 127.0.0.1 --port 8000`}</pre><button type="button" onClick={() => void check()}>Check again</button></div>}
    <p className="hint">Run only programs you trust. They run as you, can read your files and use the network, and the backend is not a sandbox. Nothing is sent anywhere except to the backend on this computer.</p>
  </section>;
}
