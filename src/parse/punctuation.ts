/** Which punctuation marks end a sentence, as against dividing one.
 *
 * ， belongs with 。？！: in this material it closes a clause that stands as
 * its own sentence — the parser segments on it, and a 而 following it reads
 * しかして, which opens a new sentence. The medial 、 does not: it separates
 * items within a single sentence (青、取之於藍), and the clause carries on
 * into what follows.
 *
 * ： and ； are *not* here. They divide a sentence rather than ending one —
 * a ： introduces reported speech within the sentence that reports it
 * (子曰：…), and a ； joins clauses too closely bound to stand apart. Both
 * come through as medial marks, which kakikudashi writes as 、 (see
 * `medialPunctuation`).
 *
 * Its own module because three separate concerns need the same answer — how
 * to chunk a long document for the parser, how to close off a sentence in
 * the kakikudashi, and which form a predicate takes before 而 — and having
 * any of them import it from either of the others would make a cycle. */
const SENTENCE_FINAL_PUNCT: ReadonlySet<string> = new Set(["。", "．", "？", "！", "，"]);

export function isSentenceFinalPunct(text: string): boolean {
  return SENTENCE_FINAL_PUNCT.has(text);
}

/** How a medial mark is written in kakikudashibun, which uses 、 for all of
 * them: a ： introducing reported speech becomes the 、 after 曰はく, and a
 * ； likewise. Returns null for anything that isn't punctuation this app
 * carries through at all — brackets, quote marks, the kaeriten's own
 * glyphs. */
export function medialPunctuation(text: string): string | null {
  return MEDIAL_PUNCT.has(text) ? "、" : null;
}

const MEDIAL_PUNCT: ReadonlySet<string> = new Set(["、", "：", "；"]);
