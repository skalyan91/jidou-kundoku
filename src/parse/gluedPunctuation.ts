import { isPunctuationMark } from "./punctuation.ts";
import type { Token } from "./types.ts";

/* ── The defect this module detects ────────────────────────────────────────
 *
 * Every panel in this app draws one cell per character of a token's `text`,
 * on the standing assumption that a token *is* one character, or — for a
 * genuine word of more than one, 君子, 孔子, 三百 — one further character of
 * the *same kind of thing*. `lzh_sud_kyoto`'s own tokenizer occasionally
 * breaks that: it emits a token whose `text` glues a punctuation mark onto
 * the character beside it, `。干` for a full stop that should have closed the
 * sentence before it, `、安` for a comma that should have introduced the
 * quotation after it. Nothing downstream is written to expect this — the
 * kundoku panel would draw the mark inside the same kaeriten cell as the
 * character it has nothing to do with, the kakikudashi generator would read
 * a `NOUN` whose lemma starts with a full stop, `titleSpansOf` in
 * `punctuation.ts` already documents the same assumption for `《`/`》`.
 *
 * **Measured, not assumed.** Every stage of the treebank this model trains
 * on — `lzh_kyoto-sud-{train,dev,test}` and all twenty-odd intermediate
 * files each goes through on the way to the shipped wheel — was checked for
 * this shape and holds not one instance of it, over 460,390 training tokens
 * and the two held-out splits besides. Nor is it a general property of
 * multi-character tokens: the treebank and this app's own fixtures both hold
 * a great many genuine ones, 1,725 occurrences of 765 distinct forms over
 * the 103,041 tokens `tests/fixtures/*.conllu` and `public/data/samples/*`
 * hold between them — proper nouns (君子 147, 孔子 76, 子貢 50), numerals (三百
 * 17, 五十 14), bound compounds (弟子, 伯夷) — none of them mixing a mark with
 * a character. What the treebank never does, `lzh_sud_kyoto` still does at
 * inference: run against `kanbun-info-parses.conllu` (a 103,029-token dump
 * of the shipped wheel's own output over a much larger, unseen corpus,
 * built by `scripts/build-kanbun-info-corpus.py`), it produces exactly 12
 * such tokens — 0.0116%, about one in every 8,586 — over 12 sentences out of
 * several thousand.
 *
 * ── Where the fix actually lives ───────────────────────────────────────────
 * Not here. The first version of this fix repaired the tree *after* the
 * tagger and parser had already run over the fused token as a single unit —
 * which meant both had analysed a word that does not exist, and a
 * hand-written rule then had to invent an attachment for the mark, guessing
 * at what the parser would have said had it seen the real tokens.
 *
 * Checked against all twelve measured cases by re-tokenising each one for
 * real and comparing: the guess agreed with the parser's own answer for the
 * mark's attachment in 10 of 12, but for the *content* token's own relation
 * in only 3 of 12 — the tagger had genuinely tagged the content as part of
 * the fused word, and a rule that only reattaches the mark leaves that
 * mistagging in place. 子 in `樊遲未達。子曰、…` is the clearest case: fused,
 * it reads `NOUN, comp:obj of 達` (an object of the wrong clause's verb);
 * split before parsing, the same character reads `NOUN, subj of 曰` — the
 * subject of 子曰, "the Master said", which is what it actually is. 、馬冒其
 * 目也 is the same story one level up: fused, `馬` came back the *root* of
 * its own one-word sentence; tokenised first, `sent_join` itself puts the
 * comma back on the *previous* clause where it belongs and 馬 reads
 * `subj of 冒` in the sentence that follows — a boundary this module used to
 * have to move by hand (`sent_join`'s own `謂接連前矛` defect,
 * `provisionalSentences.ts` documents the general shape of it) is simply
 * never wrong once the parser has the real tokens to segment.
 *
 * `pyodideWorker.ts`'s `parse()` now runs the model in two stages instead of
 * one: `nlp.tokenizer(text)` alone, then a `Doc.retokenize().split()` on
 * every token this module's `gluedPunctuationTokens` would flag, and only
 * then the rest of the pipeline (`tok2vec`, `parser`, `morphologizer`,
 * `tagger`, and the rule-based pipes after them, `sud_shared` through
 * `lzh_upos_rules`) over the corrected token sequence. Every component sees
 * the real units and decides their tags, their attachments and the
 * sentence boundaries around them itself — no attachment rule of this
 * app's own is in the loop, and re-verified against the same twelve cases,
 * re-tokenising first also puts the sentence break in the right place for
 * two of them (`。子`, `、馬`) where the fused token had kept two clauses
 * fused into one `doc.sents` group as well.
 *
 * What is left here is the *detector* — the predicate `parse()` uses to find
 * which tokens need splitting before it asks the model anything, and the
 * guard this module's own test file uses to show the finished tree never
 * carries one. One definition, both jobs, so the two can never drift apart. */

/** A token's text taken apart into a leading run of marks, the content
 * between them, and a trailing run of marks — `null` for a token this
 * module has nothing to say about, which is every ordinary token,
 * punctuation or content alone, and is therefore the overwhelmingly common
 * answer. Content-less (a token that is nothing but marks, several
 * characters of it) is also `null`: not one of the 765 distinct
 * multi-character forms measured across this app's fixtures is pure
 * punctuation, so there is no evidence to say what such a token would even
 * mean, and treating it as ordinary leaves it exactly as harmless as any
 * other token this module has never seen. */
interface GluedShape {
  lead: string[];
  content: string;
  trail: string[];
}

function analyzeGlue(text: string): GluedShape | null {
  const chars = Array.from(text);
  if (chars.length <= 1) return null; // one character can mix nothing with itself
  let leadEnd = 0;
  while (leadEnd < chars.length && isPunctuationMark(chars[leadEnd])) leadEnd++;
  let trailStart = chars.length;
  while (trailStart > leadEnd && isPunctuationMark(chars[trailStart - 1])) trailStart--;
  if (leadEnd === 0 && trailStart === chars.length) return null; // an ordinary word, whatever its length
  const content = chars.slice(leadEnd, trailStart).join("");
  if (content.length === 0) return null; // nothing but marks — see the header above
  return { lead: chars.slice(0, leadEnd), content, trail: chars.slice(trailStart) };
}

/** Every token in `tokens` whose own text mixes a punctuation mark with a
 * character that is not one — the guard this module exists to make true of
 * a finished parse. Not the same question as "is this token more than one
 * character": 君子 answers yes to that and no to this, which is the
 * distinction the whole module rests on. */
export function gluedPunctuationTokens(tokens: readonly Token[]): Token[] {
  return tokens.filter((t) => analyzeGlue(t.text) !== null);
}
