import { useMemo, useRef } from 'react';
import type { KeyboardEvent } from 'react';

// A plain <textarea> with a line-number gutter. No editor library: a library such as
// CodeMirror or Monaco adds hundreds of kB and a build step, and the pasted programs here are
// capped at 64 KiB. Revisit if syntax highlighting is wanted (measure the bundle first).
export function CodeEditor({ value, onChange, onRun, label = 'Python source code' }: { value: string; onChange: (v: string) => void; onRun: () => void; label?: string }) {
  const gutter = useRef<HTMLPreElement>(null), escaped = useRef(false);
  // Only rebuilt when the NUMBER of lines changes, not on every keystroke.
  const lineCount = value.split('\n').length;
  const numbers = useMemo(() => Array.from({ length: lineCount }, (_, i) => i + 1).join('\n'), [lineCount]);
  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); onRun(); return; }
    // Tab inserts four spaces so code can be indented. Escape then Tab moves focus away,
    // so keyboard users are never trapped in the editor.
    if (e.key === 'Escape') { escaped.current = true; return; }
    if (e.key === 'Tab' && !e.shiftKey && !escaped.current) {
      e.preventDefault();
      const el = e.currentTarget, start = el.selectionStart, end = el.selectionEnd;
      onChange(value.slice(0, start) + '    ' + value.slice(end));
      requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = start + 4; });
      return;
    }
    escaped.current = false;
  }
  return <div className="editor">
    <pre className="gutter" aria-hidden="true" ref={gutter}>{numbers}</pre>
    <textarea aria-label={label} value={value} spellCheck={false} wrap="off" autoCapitalize="off" autoCorrect="off"
      onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown}
      onScroll={(e) => { if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop; }}/>
  </div>;
}
