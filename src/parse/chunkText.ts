/** Where a cut is safe, in order of preference. Used only to pick a place to
 * split a long *document* into several `nlp()` calls — never to presegment
 * sentences (lzh's own clause-boundary detection runs inside the pipeline and
 * stays in charge of that; cutting at punctuation just avoids ever cutting a
 * chunk mid-word).
 *
 * **Three tiers now, and only the bottom two are a concession.** A cut is a
 * hard boundary the parser cannot see across — the two calls it falls
 * between never share a `Doc`, so nothing on one side can inform the tok2vec
 * embedding, the tagging or the attachment of anything on the other. That is
 * free exactly where nothing *should* be shared, and costly everywhere else.
 * A paragraph break (`PARAGRAPH_BREAK` below, two or more newlines — the same
 * test `annotateSourceLayout` in `sourceLayout.ts` uses for its `"para"`
 * kind) is the one place in ordinary prose the parser has no business seeing
 * across in the first place, so cutting there costs nothing a whole-document
 * call would have bought. That makes it the tier tried first, ahead of any
 * punctuation.
 *
 * The other two are still what they always were, and the concession is still
 * theirs. A full stop (。．？！) ends a sentence, so cutting there costs at
 * most the tok2vec context of the *next* sentence over — but ， is not a
 * sentence end (see `punctuation.ts`, where it was taken out of
 * `SENTENCE_FINAL_PUNCT` for exactly this reason: it divides a sentence
 * rather than ending one, and cutting there splits a sentence the parser
 * would have kept whole). A chunk cannot grow unbounded regardless, and a
 * paragraph with no 。 for thousands of characters has to be cut *somewhere*.
 * So within a paragraph too large for one call, a full stop is taken wherever
 * one appears past the cap, and a comma only once half again as much text has
 * gone by with no full stop in it — by which point the choice is no longer
 * "a comma or a sentence end" but "a comma or the middle of a word".
 *
 * This is why the file no longer says "kept in step with punctuation.ts": the
 * two answer different questions now. That module says what a mark *is*; this
 * one says where a cut does least damage when one is unavoidable. */
const FULL_STOP = /[。．？！]/;
const COMMA = /[，、；：]/;

/** A run of whitespace holding two or more newlines — the exact test
 * `annotateSourceLayout` runs on the whitespace between two tokens to decide
 * `"para"` against `"line"` (see `sourceLayout.ts`): newlines are counted
 * across the whole run, so non-newline whitespace sitting between them (a
 * blank line with trailing spaces on it, say) does not stop them counting
 * together. Deliberately the same regexp-free counting rule and not a second
 * definition of "paragraph" invented for this file — this app already has
 * one, and a chunker that drew its own boundary here could split a document
 * differently from how the rest of the app understands its structure.
 *
 * **What the text reaching `chunkText` actually is.** Every caller
 * (`pyodideWorker.ts`'s `parse`, reached from `main.ts`'s single-shot
 * re-parse and its streamed batches) hands this the reader's own typed
 * source, or a substring of it cut at region boundaries — never a tree, and
 * so never anything `annotateSourceLayout` has already walked. So this file
 * reads the same raw newlines that module would, rather than reusing its
 * output; there is nothing yet to reuse. */
const WHITESPACE_RUN = /\s+/g;

function isParagraphBreak(run: string): boolean {
  let newlines = 0;
  for (const ch of run) if (ch === "\n") newlines++;
  return newlines >= 2;
}

/** Feeding a very long document to `nlp()` in one call scales badly under
 * Pyodide — SUD-spaCy's own docs record this exact failure mode (a
 * whole-book-sized single call reliably fails there, surfacing as a JS
 * "Maximum call stack size exceeded" that is actually the WASM heap for a
 * doc-sized batch through the parser's neural components, not real
 * recursion depth). Capping each `nlp()` call at this many characters keeps
 * every call well inside what a browser tab can hold. Doubled as a hard
 * force-break for the pathological case of a run with no sentence-final
 * punctuation at all for thousands of characters, so a chunk can never grow
 * unbounded regardless of input.
 *
 * Also the threshold `chunkText` measures a *paragraph* against: a paragraph
 * at or under this many characters goes to `nlp()` whole, and only a longer
 * one falls through to the size tiers below. Every paragraph in the samples
 * this was checked against is far under it — 96 characters is the longest in
 * `rongo-gakuji.conllu`, 293 in `shuchu.conllu` — so the fallback exists for
 * documents these samples do not represent rather than for anything shipped. */
export const MAX_CHUNK_CHARS = 1500;

/** Splits one paragraph-sized run of text at a punctuation boundary — the
 * two size tiers `chunkText`'s own doc comment above describes, applied
 * without knowing or caring whether the text it is given is a whole
 * paragraph or (on the hard-cap tier) a fragment of one already cut once.
 *
 * Token ids in the pyodideWorker parse output are assigned relative to each
 * *sentence's* own start, so a cut made here needs no id renumbering
 * afterwards — `chunkText` simply concatenates every tier's chunks in
 * order.
 *
 * The tiers are monotone in `lengthSoFar` and never look backwards, so each
 * one only ever widens what the previous would have accepted; a paragraph
 * with ordinary punctuation never reaches the second tier at all. */
function chunkBySize(text: string): string[] {
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

/** Divides `text` at every paragraph break (see `isParagraphBreak` above),
 * each piece keeping the break that follows it — the same convention the
 * size tiers use, where a cut keeps the punctuation it cuts after rather
 * than opening the next piece with it. So every piece but the last ends in
 * the whitespace that separated it from its neighbour, `chunks.join("")`
 * reconstructs `text` exactly, and none of them is empty: a break sitting at
 * the very start of `text` (leading blank lines) is not cut on, since there
 * is no paragraph yet on its near side to close off. */
function splitParagraphs(text: string): string[] {
  const paragraphs: string[] = [];
  let start = 0;
  WHITESPACE_RUN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WHITESPACE_RUN.exec(text))) {
    if (match.index > start && isParagraphBreak(match[0])) {
      const end = match.index + match[0].length;
      paragraphs.push(text.slice(start, end));
      start = end;
    }
  }
  if (start < text.length) paragraphs.push(text.slice(start));
  return paragraphs.length > 0 ? paragraphs : [text];
}

/** Splits text into `nlp()`-sized chunks: at every paragraph break first,
 * since that boundary costs the parse nothing (see this file's opening
 * comment); then, only inside a paragraph too long for one call, after a
 * full stop wherever one appears past `MAX_CHUNK_CHARS`, after a comma once
 * `1.5 ×` that has gone by without one, and at `2 ×` regardless.
 *
 * A document of ordinary short paragraphs — the common case this exists
 * for — never reaches the size tiers at all: every paragraph is its own
 * `nlp()` call, whatever its length under the cap, because a paragraph
 * break is a boundary the reader drew and not one this file is choosing
 * between alternatives to place. The size tiers are unchanged from before
 * paragraphs were considered; only what they are applied *to* has: a whole
 * document, previously, and now whatever is left of one paragraph after the
 * boundaries within it are drawn. */
export function chunkText(text: string): string[] {
  const chunks: string[] = [];
  for (const paragraph of splitParagraphs(text)) {
    if (paragraph.length <= MAX_CHUNK_CHARS) chunks.push(paragraph);
    else chunks.push(...chunkBySize(paragraph));
  }
  return chunks;
}
