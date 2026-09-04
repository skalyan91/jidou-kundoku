/** Which punctuation marks end a sentence, as against dividing one.
 *
 * **， is not one of them, and used to be.** The argument for putting it here
 * was that the parser segments on it and that a 而 following it reads しかも,
 * which opens a new sentence — and neither claim survived. The parser does
 * not segment on it: `splitIntoSentences` exists precisely because
 * 青、取之於藍，而青於藍。 comes back from the pipeline as *one* sentence
 * spanning both marks, so every break at a ， was this app cutting a sentence
 * the parser had kept whole. And しかも is decided by
 * `precededBySourcePunctuation`, which asks whether the token before 而 is a
 * mark of any kind — the 、 included — so it reads しかも with the comma
 * sitting beside it in one sentence, and needs no boundary to do it.
 *
 * What the mark is stays what it always was: a comma. This module's own
 * `COMMAS` has always held it, `japanesePunct` has always written it 、, and
 * `conjugationContext.ts`'s `coordinationSpansStop` keeps it with the commas
 * on measured evidence — a ， stands inside a nominal coordination chain 490
 * times over `lzh-{train,dev,test}` where no 。 does, and every one of them is
 * a genuine list. Three classifications called it a comma and this one called
 * it a full stop; that is now settled the way the other three had it.
 *
 * ： and ； are not here either, and never were. They divide a sentence rather
 * than ending one — a ： introduces reported speech within the sentence that
 * reports it (子曰：…), and a ； joins clauses too closely bound to stand
 * apart. Both come through as medial marks, which kakikudashi writes as 、
 * (see `medialPunctuation`).
 *
 * Its own module because three separate concerns need the same answer — where
 * a region is closed off for dispatch, how to close off a sentence in the
 * kakikudashi, and which form a predicate takes before 而 — and having any of
 * them import it from either of the others would make a cycle. */
const SENTENCE_FINAL_PUNCT: ReadonlySet<string> = new Set(["。", "．", "？", "！"]);

export function isSentenceFinalPunct(text: string): boolean {
  return SENTENCE_FINAL_PUNCT.has(text);
}

/** How a medial mark is written in kakikudashibun, which uses 、 for all of
 * them: a ： introducing reported speech becomes the 、 after 曰はく, and a
 * ； likewise. Returns null for anything that isn't punctuation this app
 * carries through at all — brackets, quote marks, the kaeriten's own glyphs.
 *
 * **Asked of `COMMAS`, and it used to have a list of its own.** That list held
 * 、：； and not ，, which was right only for as long as ， was *also* in
 * `SENTENCE_FINAL_PUNCT` above: a mark in that set is written by the join
 * between two sentences rather than here, so ， reached the page by the other
 * route and its absence here cost nothing. Taking it out of that set — see
 * there for why — left it in neither, and a ， was then dropped from the
 * kakikudashi outright: 學而時習之，不亦說乎？ came out 學びて時にこれを習ひ亦說
 * ばしからざるや, with nothing where the source wrote a mark, while the same
 * sentence written with 、 kept its comma.
 *
 * So the two lists are now one. `COMMAS` is what this module already means by
 * "a mark that divides a sentence", it carries both widths of each (a Literary
 * Chinese text and a Western edition must classify alike, which the block below
 * says outright), and one set cannot drift from the other. */
export function medialPunctuation(text: string): string | null {
  return COMMAS.has(text) ? "、" : null;
}

/* ── What a mark *is*, as against what it does to a sentence ──────────────
 *
 * A second classification, and deliberately not the one above. That one
 * answers "does this end a sentence", which is a question about structure.
 * These answer "what kind of mark is this", which is a question about
 * typography. The two used to disagree about ， — that one called it a full
 * stop and these called it a comma — and they no longer do; the division is
 * kept all the same, because the questions are still two.
 *
 * Both panels read them, which is the point of their being here. The kundoku
 * panel writes 訓読文 as Japanese is written — 。 at the end of a sentence, 、
 * within one, whatever the Literary Chinese original used — and the
 * kakikudashibun has to make the same call about the same mark, or the two
 * panels punctuate one text two ways. Held apart in two modules, they did:
 * the kundoku panel decided from the mark and the kakikudashibun from a
 * sentence's position in the list, and a text of three ？-ended sentences came
 * out of one panel as three sentences and out of the other as one.
 *
 * The lists are of what the *source* may carry, not of what is written: a
 * Literary Chinese text is punctuated with ，。？！ and a Western edition with
 * , . ? !, and both must classify the same. */

/** Opening brackets and quotes, the one class Japanese typesetting allows at
 * the head of a column (行頭禁則), and the one class that belongs to what
 * *follows* it rather than to what precedes it. */
export const OPENING_BRACKETS: ReadonlySet<string> = new Set([
  "「", "『", "（", "(", "〈", "《", "【", "‘", "“", "〔", "［", "[",
]);

/** Brackets and quotes of both hands. Not sentence punctuation at all: they
 * are written as the source has them, and neither ends a clause nor divides
 * one — a closing bracket belongs to the clause it closes, however that
 * clause was already punctuated. */
export const BRACKETS: ReadonlySet<string> = new Set([
  ...OPENING_BRACKETS,
  "」", "』", "）", ")", "〉", "》", "】", "’", "”", "〕", "］", "]",
]);

/** Marks that close a sentence outright. ， is not among them — it divides
 * one, which `SENTENCE_FINAL_PUNCT` above now agrees with. */
export const FULL_STOPS: ReadonlySet<string> = new Set(["。", "．", ".", "？", "?", "！", "!"]);

/** Marks that divide a sentence without closing it. */
export const COMMAS: ReadonlySet<string> = new Set(["，", ",", "、", "；", ";", "：", ":", "·"]);

export function isBracket(ch: string): boolean {
  return BRACKETS.has(ch);
}

export function isOpeningBracket(ch: string): boolean {
  return OPENING_BRACKETS.has(ch);
}

/** How a mark is written in Japanese: 。 at the end of a sentence and 、
 * within one, whatever the source used — so ， becomes 、, and 。？！ all
 * become 。, the question mark included, which loses the question and is what
 * was asked for. Brackets are written as they are.
 *
 * The mark's own class decides; `sentenceFinal` settles only a mark that is
 * neither kind. Applied per character, since one token may carry more than
 * one mark.
 *
 * A rule about setting the text, not about the text: the CoNLL-U export
 * writes from the tree rather than from either panel, so what a reader
 * downloads is still what they typed. */
export function japanesePunct(text: string, sentenceFinal: boolean): string {
  return [...text]
    .map((ch) => {
      if (BRACKETS.has(ch)) return ch;
      if (FULL_STOPS.has(ch)) return "。";
      if (COMMAS.has(ch)) return "、";
      return sentenceFinal ? "。" : "、";
    })
    .join("");
}

/** Whether a single character is a mark this app carries through as
 * punctuation at all — a full stop, a comma, or a bracket of either hand.
 *
 * The character-level counterpart of the `token.dep === "punct" ||
 * token.pos === "PUNCT"` test the kundoku panel makes of a parsed token, and
 * it exists because the *bare* render (see `renderBareKundokuView`) has no
 * tokens to ask: it draws the reader's own text before the parser has said
 * anything about it, and still has to decide which characters go into a
 * `.punct-cell` — a mark being crammed into the gap between two characters
 * rather than taking a place of its own in the line.
 *
 * The three sets above are exactly what `japanesePunct` knows how to write,
 * so this is also the test for "would `japanesePunct` recognise this". A mark
 * outside all three (an em dash, an ellipsis) the parser will still tag
 * PUNCT, and the bare render draws it as an ordinary character; it therefore
 * gains a place in the line at stage one and gives it up when its sentence is
 * annotated. Accepted rather than guarded: the marks that occur in this
 * material are all in the sets. */
export function isPunctuationMark(ch: string): boolean {
  return FULL_STOPS.has(ch) || COMMAS.has(ch) || BRACKETS.has(ch);
}
