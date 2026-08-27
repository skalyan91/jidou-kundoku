/** Sentence-final punctuation the wheel's own training data treats as a hard
 * boundary. ， counts: it ends a sentence in this material, unlike the
 * medial 、, which separates items inside one. Used only to pick safe places to split a long *document* into
 * several `nlp()` calls — never to presegment sentences ourselves (lzh's own
 * clause-boundary detection runs inside the pipeline and stays in charge of
 * that; splitting on punctuation just avoids ever cutting a chunk mid-word). */
const SENTENCE_FINAL = /[。．？！，]/; // kept in step with punctuation.ts

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

/** Splits text into `nlp()`-sized chunks, only ever cutting right after a
 * sentence-final punctuation mark (or, as a last-resort fallback, at
 * `2 * MAX_CHUNK_CHARS` if none appears). Token ids in the pyodideWorker
 * parse output are assigned relative to each *sentence's* own start, so
 * chunk boundaries need no id renumbering afterwards — chunks' sentence
 * lists are simply concatenated. */
export function chunkText(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const lengthSoFar = i - start + 1;
    if (lengthSoFar >= MAX_CHUNK_CHARS && SENTENCE_FINAL.test(text[i])) {
      chunks.push(text.slice(start, i + 1));
      start = i + 1;
    } else if (lengthSoFar >= MAX_CHUNK_CHARS * 2) {
      chunks.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) chunks.push(text.slice(start));
  return chunks.length > 0 ? chunks : [text];
}
