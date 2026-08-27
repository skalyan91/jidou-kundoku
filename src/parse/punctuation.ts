/** Which punctuation marks end a sentence, as against dividing one.
 *
 * ， belongs with 。？！: in this material it closes a clause that stands as
 * its own sentence — the parser segments on it, and a 而 following it reads
 * しかして, which opens a new sentence. The medial 、 does not: it separates
 * items within a single sentence (青、取之於藍), and the clause carries on
 * into what follows.
 *
 * ： and ； close a clause too: the parser segments on both, and a ：
 * introducing reported speech is realised in kakikudashi as the 、 after
 * 曰はく rather than as a colon of its own — carrying it through as well
 * gave 子曰はく：、.
 *
 * Its own module because three separate concerns need the same answer — how
 * to chunk a long document for the parser, how to close off a sentence in
 * the kakikudashi, and which form a predicate takes before 而 — and having
 * any of them import it from either of the others would make a cycle. */
const SENTENCE_FINAL_PUNCT: ReadonlySet<string> = new Set(["。", "．", "？", "！", "，", "；", "："]);

export function isSentenceFinalPunct(text: string): boolean {
  return SENTENCE_FINAL_PUNCT.has(text);
}
