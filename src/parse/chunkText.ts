/** Where a cut is safe, in order of preference. Used only to pick a place to
 * split a long *document* into several `nlp()` calls — never to presegment
 * sentences (lzh's own clause-boundary detection runs inside the pipeline and
 * stays in charge of that; cutting at punctuation just avoids ever cutting a
 * chunk mid-word).
 *
 * **Two tiers, and the second one is a concession.** A cut is a hard boundary
 * the parser cannot see across, so the only place one belongs is the end of a
 * sentence — which ， is not (see `punctuation.ts`, where it was taken out of
 * `SENTENCE_FINAL_PUNCT` for exactly this reason: it divides a sentence rather
 * than ending one, and cutting there splits a sentence the parser would have
 * kept whole). But a chunk cannot grow unbounded either, and a document with no
 * 。 for thousands of characters has to be cut *somewhere*. So a full stop is
 * taken wherever one appears past the cap, and a comma only once half again as
 * much text has gone by with no full stop in it — by which point the choice is
 * no longer "a comma or a sentence end" but "a comma or the middle of a word".
 *
 * This is why the file no longer says "kept in step with punctuation.ts": the
 * two answer different questions now. That module says what a mark *is*; this
 * one says where a cut does least damage when one is unavoidable. */
const FULL_STOP = /[。．？！]/;
const COMMA = /[，、；：]/;

/** Feeding a very long document to `nlp()` in one call scales badly under
 * Pyodide — SUD-spaCy's own docs record this exact failure mode (a
 * whole-book-sized single call reliably fails there, surfacing as a JS
 * "Maximum call stack size exceeded" that is actually the WASM heap for a
 * doc-sized batch through the parser's neural components, not real
 * recursion depth). Capping each `nlp()` call at this many characters keeps
 * every call well inside what a browser tab can hold. Doubled as a hard
 * force-break for the pathological case of a run with no sentence-final
 * punctuation at all for thousands of characters, so a chunk can never grow
 * unbounded regardless of input. */
export const MAX_CHUNK_CHARS = 1500;

/** Splits text into `nlp()`-sized chunks, cutting after a full stop wherever
 * one appears past `MAX_CHUNK_CHARS`, after a comma once `1.5 ×` that has gone
 * by without one, and at `2 ×` regardless. Token ids in the pyodideWorker
 * parse output are assigned relative to each *sentence's* own start, so chunk
 * boundaries need no id renumbering afterwards — chunks' sentence lists are
 * simply concatenated.
 *
 * The tiers are monotone in `lengthSoFar` and never look backwards, so each
 * one only ever widens what the previous would have accepted; a text with
 * ordinary punctuation never reaches the second tier at all. */
export function chunkText(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const lengthSoFar = i - start + 1;
    const cut =
      (lengthSoFar >= MAX_CHUNK_CHARS && FULL_STOP.test(text[i])) ||
      (lengthSoFar >= MAX_CHUNK_CHARS * 1.5 && COMMA.test(text[i])) ||
      lengthSoFar >= MAX_CHUNK_CHARS * 2;
    if (cut) {
      chunks.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) chunks.push(text.slice(start));
  return chunks.length > 0 ? chunks : [text];
}
