import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { SESSION_MARKER, buildSessionHtml, escapeJsonForHtml, sessionFileName } from '../src/session';
import { parseTrace } from '../src/parseTrace';
const alias = readFileSync(new URL('../public/examples/05_alias.trace.json', import.meta.url), 'utf8');
const template = `<html><body>${SESSION_MARKER}<script type="module">var m="${SESSION_MARKER}"</script></body></html>`;
const dataBlock = (html: string) => /<script type="application\/json" id="codeviz-session">([\s\S]*?)<\/script>/.exec(html)![1];
describe('session export helpers', () => {
  it('escapes characters that could end or alter a script block', () => {
    const out = escapeJsonForHtml('{"s":"</script><!-- & \u2028"}');
    expect(out).not.toMatch(/[<>&\u2028\u2029]/);
    expect(JSON.parse(out)).toEqual({ s: '</script><!-- & \u2028' });
  });
  it('round-trips a real trace byte-for-byte through the data block', () => {
    const html = buildSessionHtml(template, alias);
    expect(JSON.parse(dataBlock(html))).toEqual(JSON.parse(alias));
    expect(parseTrace(dataBlock(html)).events.length).toBeGreaterThan(0);
  });
  it('replaces only the first marker, in the HTML, not the one inside the script', () => {
    const html = buildSessionHtml(template, alias);
    expect(html.split(SESSION_MARKER).length - 1).toBe(1);
    expect(html.indexOf('id="codeviz-session"')).toBeLessThan(html.indexOf('<script type="module">'));
  });
  it('hostile source text cannot close the data block', () => {
    const t = JSON.parse(alias); t.source = 'print("</script><script>alert(1)</script>")';
    const html = buildSessionHtml(template, JSON.stringify(t));
    expect(html.match(/<script/g)!.length).toBe(2);
    expect(parseTrace(dataBlock(html)).source).toBe(t.source);
  });
  it('rejects a template without the marker', () => expect(() => buildSessionHtml('<html></html>', alias)).toThrow('marker'));
  it('makes safe file names', () => {
    expect(sessionFileName('05_alias.trace.json')).toBe('05_alias.session.html');
    expect(sessionFileName('../../etc/pass wd.json')).toBe('etc-pass-wd.session.html');
    expect(sessionFileName('')).toBe('session.session.html');
  });
});
