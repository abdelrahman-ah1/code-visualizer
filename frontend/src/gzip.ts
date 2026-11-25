// Optional .json.gz recordings. The browser's own Compression Streams are used, nothing is added.
// Decompression is bounded: it stops as soon as the output passes the raw limit, so a tiny file
// that expands into gigabytes cannot exhaust memory.
export const GZIP_EXT = '.json.gz';
export const gzipSupported = (): boolean => typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined' && typeof Blob !== 'undefined';
export const isGzip = (b: Uint8Array): boolean => b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;

export async function gzipText(text: string): Promise<Blob> {
  if (!gzipSupported()) throw new Error('This browser cannot compress files (no Compression Streams).');
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).blob();
}

export async function gunzipText(bytes: Uint8Array, maxBytes: number): Promise<string> {
  if (!gzipSupported()) throw new Error('This browser cannot open .gz files (no Compression Streams). Use a .json file, or a current Chrome, Edge, Firefox or Safari.');
  const ds = new DecompressionStream('gzip');
  const writer = ds.writable.getWriter(), reader = ds.readable.getReader();
  const chunks: Uint8Array[] = []; let total = 0, over = false;
  const feed = (async () => { try { await writer.write(bytes as Uint8Array<ArrayBuffer>); await writer.close(); } catch { /* the reader reports the real error */ } })();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) { over = true; await reader.cancel(); break; }
      chunks.push(value);
    }
  } catch { throw new Error('This .gz file is damaged or incomplete, so it was not opened.'); }
  await feed;
  if (over) throw new Error(`File expands to more than the ${Math.round(maxBytes / 1048576)} MiB replay limit once unpacked.`);
  const out = new Uint8Array(total); let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(out); }
  catch { throw new Error('The unpacked file is not valid UTF-8 text.'); }
}
