/** Browser/worker loader: fetch a JSON index and parse it. Ships as plain
 * `.json` (not pre-gzipped) deliberately — a static host's own transport
 * compression (gzip/br, negotiated via `Accept-Encoding` and applied by
 * virtually every static host, including Vite's own dev server) already
 * shrinks this in transit. An earlier version of this file pre-gzipped the
 * data and manually re-decompressed it with `DecompressionStream`, which
 * broke wherever the server *also* declared `Content-Encoding: gzip` for
 * the `.gz` file — the browser's fetch() then auto-decompresses the body
 * once, and re-running it through `DecompressionStream("gzip")` on already-
 * decompressed bytes fails (surfacing, confusingly, as a generic "Failed to
 * fetch" TypeError). Plain JSON avoids the double-decompression entirely. */
export async function loadJsonIndex<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to fetch ${url}: ${res.status}`);
  return (await res.json()) as T;
}
