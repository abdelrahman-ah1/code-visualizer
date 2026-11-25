// M3.5: session export. A "session" is one self-contained .html file: the built replay app
// (inlined) plus the recorded trace as a JSON data block. No server, no network.
// The trace already holds the source code, captured values and output, so nothing else is embedded.

export const SESSION_MARKER = '<!--CODEVIZ_SESSION_DATA-->';
export const SESSION_ELEMENT_ID = 'codeviz-session';

// Put JSON inside an HTML <script> block safely. "<" cannot start "</script" or "<!--", and
// U+2028/2029 are escaped for old parsers. JSON.parse turns every escape back into the same text.
export function escapeJsonForHtml(json: string): string {
  return json.replace(/[<>&\u2028\u2029]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

// Insert the trace into the viewer template. The marker is replaced once (its first occurrence
// is the HTML one, before the inlined script). Returns the full HTML text of the session file.
export function buildSessionHtml(template: string, traceJson: string): string {
  const at = template.indexOf(SESSION_MARKER);
  if (at < 0) throw new Error('Viewer template is missing its data marker.');
  const block = `<script type="application/json" id="${SESSION_ELEMENT_ID}">${escapeJsonForHtml(traceJson)}</script>`;
  return template.slice(0, at) + block + template.slice(at + SESSION_MARKER.length);
}

// The viewer reads the embedded text as data only (textContent), never as markup.
export function readEmbeddedSession(doc: Document): string | null {
  const el = doc.getElementById(SESSION_ELEMENT_ID);
  return el && el.textContent ? el.textContent : null;
}

// A safe download name: letters, digits, dot, dash, underscore only.
export function sessionFileName(label: string): string {
  const base = label.replace(/\.trace\.json(\.gz)?$|\.json(\.gz)?$/i, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'session';
  return `${base.slice(0, 60)}.session.html`;
}

export const SHARE_NOTICE = 'A session file contains the program source, every captured value and the program output. Anyone who gets the file can read all of it.';
