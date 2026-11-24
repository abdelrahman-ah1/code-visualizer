// Vite plugin: builds the replay app once more as a single HTML text (JS and CSS inlined, strict
// Content-Security-Policy, no network). The app fetches this "template" when you click Export,
// then session.ts drops the trace into it. Served in dev; written to dist/ by `npm run build`.
import { build } from 'vite';
import type { Plugin } from 'vite';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SESSION_MARKER } from './src/session.ts';

// default-src none blocks every network request; inline script/style are needed because all code is inlined.
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";

export async function buildTemplate(root: string): Promise<string> {
  const result = await build({
    root, configFile: false, logLevel: 'silent', base: './', publicDir: false,
    build: { write: false, cssCodeSplit: false, rollupOptions: { output: { codeSplitting: false } } },
  });
  const outputs = (Array.isArray(result) ? result : [result as { output: unknown[] }]).flatMap((r) => (r as { output: { type: string; fileName: string; code?: string; source?: string | Uint8Array }[] }).output);
  const js = outputs.filter((o) => o.type === 'chunk').map((o) => o.code ?? '').join('\n').replace(/<\/script/gi, '<\\/script');
  const css = outputs.filter((o) => o.fileName.endsWith('.css')).map((o) => String(o.source)).join('\n').replace(/<\/style/gi, '<\\/style');
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"/><meta http-equiv="Content-Security-Policy" content="${CSP}"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><title>Code Visualizer | Shared session</title><style>${css}</style></head><body><div id="root"></div>${SESSION_MARKER}<script type="module">${js}</script></body></html>`;
}

export function sessionTemplate(): Plugin {
  let root = process.cwd(), cached: Promise<string> | null = null, nested = false;
  return {
    name: 'codeviz-session-template',
    configResolved(c) { root = c.root; nested = c.command === 'build' && process.env.CODEVIZ_NESTED === '1'; },
    configureServer(server) {
      server.middlewares.use('/session-template.html', async (_req, res) => {
        try { cached ??= buildTemplate(root); const html = await cached; res.setHeader('content-type', 'text/html'); res.end(html); }
        catch (e) { cached = null; res.statusCode = 500; res.end(String(e)); }
      });
    },
    async closeBundle() {
      if (nested || this.environment?.config.command !== 'build') return;
      process.env.CODEVIZ_NESTED = '1';
      try { writeFileSync(join(this.environment.config.build.outDir.startsWith('/') ? this.environment.config.build.outDir : join(root, this.environment.config.build.outDir), 'session-template.html'), await buildTemplate(root)); }
      finally { delete process.env.CODEVIZ_NESTED; }
    },
  };
}
