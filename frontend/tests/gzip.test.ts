import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { gunzipText, gzipSupported, gzipText, isGzip } from '../src/gzip';
import { parseTrace } from '../src/parseTrace';
import { sessionFileName } from '../src/session';
const raw = readFileSync(new URL('../public/examples/05_alias.trace.json', import.meta.url), 'utf8');
const bytes = async (b: Blob) => new Uint8Array(await b.arrayBuffer());
describe('gzip recordings', () => {
  it('is available here', () => expect(gzipSupported()).toBe(true));
  it('round-trips byte-exactly, including non-ASCII text', async () => {
    for (const text of [raw, '{"a":"héllo ✓ 日本 \u{1F600}"}', '']) {
      const z = await bytes(await gzipText(text));
      expect(isGzip(z)).toBe(true);
      expect(await gunzipText(z, 20 * 1048576)).toBe(text);
    }
    expect(parseTrace(await gunzipText(await bytes(await gzipText(raw)), 20 * 1048576)).events.length).toBeGreaterThan(0);
  });
  it('rejects a truncated file', async () => {
    const z = await bytes(await gzipText(raw.repeat(20)));
    for (const cut of [z.length - 1, z.length - 8, Math.floor(z.length / 2), 12]) await expect(gunzipText(z.slice(0, cut), 1e9)).rejects.toThrow(/damaged or incomplete/);
  });
  it('rejects corrupted data and a bad checksum', async () => {
    const z = await bytes(await gzipText(raw.repeat(20)));
    const flipped = z.slice(); flipped[Math.floor(z.length / 2)] ^= 0xff;
    await expect(gunzipText(flipped, 1e9)).rejects.toThrow(/damaged or incomplete/);
    const crc = z.slice(); crc[crc.length - 6] ^= 0xff;
    await expect(gunzipText(crc, 1e9)).rejects.toThrow(/damaged or incomplete/);
    await expect(gunzipText(new Uint8Array([0x1f, 0x8b, 8, 0, 1, 2, 3]), 1e9)).rejects.toThrow(/damaged or incomplete/);
  });
  it('stops a decompression bomb at the raw limit without unpacking it all', async () => {
    const z = await bytes(await gzipText('0'.repeat(300 * 1048576)));
    expect(z.length).toBeLessThan(1_000_000);
    const t = performance.now();
    await expect(gunzipText(z, 20 * 1048576)).rejects.toThrow(/more than the 20 MiB/);
    expect(performance.now() - t).toBeLessThan(5000);
  });
  it('accepts exactly the limit and rejects one byte over', async () => {
    const z = await bytes(await gzipText('x'.repeat(1000)));
    expect((await gunzipText(z, 1000)).length).toBe(1000);
    await expect(gunzipText(z, 999)).rejects.toThrow(/more than/);
  });
  it('rejects unpacked bytes that are not UTF-8', async () => {
    const s = new Blob([new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])]).stream().pipeThrough(new CompressionStream('gzip'));
    await expect(gunzipText(await bytes(await new Response(s).blob()), 1e6)).rejects.toThrow(/UTF-8/);
  });
  it('names saved files sensibly', () => {
    expect(sessionFileName('a.trace.json.gz')).toBe('a.session.html');
    expect(sessionFileName('a.json.gz')).toBe('a.session.html');
  });
});
