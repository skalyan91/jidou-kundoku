import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gluedPunctuationTokens } from "../src/parse/gluedPunctuation.ts";
import { parseConllu } from "../src/parse/conlluParser.ts";
import type { Token } from "../src/parse/types.ts";

/** Shorthand for a token, in the style `deprojectivize.test.ts` already
 * uses — id, text, relation, head, and whatever else a particular case
 * needs to check (a non-default `pos`/`xpos`). */
function tok(id: number, text: string, dep: string, head: number, extra?: Partial<Token>): Token {
  return { id, text, lemma: text, pos: "NOUN", xpos: "n,名詞,可搬,道具", dep, head, ...extra };
}

describe("gluedPunctuationTokens — the guard", () => {
  it("catches a punctuation mark fused to the character it has nothing to do with", () => {
    // The report's own example, reproduced as a token: a full stop that
    // should have closed the sentence before it, glued instead to the
    // 干 that opens the next one.
    const tokens = [tok(0, "。干", "root", 0)];
    expect(gluedPunctuationTokens(tokens)).toEqual(tokens);
  });

  it("catches a trailing mark as readily as a leading one", () => {
    // 慈、 — one of the twelve measured cases, and the one shape that opens
    // with content rather than with the mark.
    const tokens = [tok(0, "慈、", "comp:obj", 0)];
    expect(gluedPunctuationTokens(tokens)).toEqual(tokens);
  });

  it("does not flag an ordinary multi-character word", () => {
    // 君子, 孔子, 三百 and the like — 1,725 occurrences across this app's own
    // fixtures, none of them a fault. A multi-character token is not by
    // itself the defect; mixing a mark into one is.
    const tokens = [tok(0, "君子", "subj", 1), tok(1, "疾", "root", 1)];
    expect(gluedPunctuationTokens(tokens)).toEqual([]);
  });

  it("does not flag a bare punctuation token, single- or multi-character", () => {
    const tokens = [tok(0, "。", "punct", 0, { pos: "PUNCT" }), tok(1, "、", "punct", 0, { pos: "PUNCT" })];
    expect(gluedPunctuationTokens(tokens)).toEqual([]);
  });

  it("does not flag a token that is nothing but marks, however many", () => {
    // Never measured (see the module's header on the shapes this parser has
    // actually produced), and deliberately not treated as the same defect as
    // a mark mixed with content — there is no evidence either way about what
    // such a token would mean, so this leaves it alone rather than guess.
    const tokens = [tok(0, "。」", "punct", 0, { pos: "PUNCT" })];
    expect(gluedPunctuationTokens(tokens)).toEqual([]);
  });

  it("fails against the raw tree the parser used to produce", () => {
    // 樊遲未達。子曰、… — one of `kanbun-info-parses.conllu`'s twelve measured
    // cases, the full stop closing 達's clause fused onto the 子 that opens
    // the next. This is what a reader hit before `parse()` retokenized ahead
    // of the tagger and parser; the guard has to say so, and does, since it
    // asks only about a token's own text.
    const raw = [
      tok(0, "樊", "subj", 3, { pos: "PROPN", xpos: "n,名詞,人,姓氏" }),
      tok(1, "遲", "flat", 0, { pos: "PROPN", xpos: "n,名詞,人,名" }),
      tok(2, "未", "mod", 3, { pos: "ADV", xpos: "v,副詞,否定,有界" }),
      tok(3, "達", "ROOT", 3, { pos: "VERB", xpos: "v,動詞,行為,動作" }),
      tok(4, "。子", "comp:obj", 3, { pos: "NOUN", xpos: "n,名詞,可搬,道具" }),
      tok(5, "曰", "parataxis", 3, { pos: "VERB", xpos: "v,動詞,行為,伝達" }),
    ];
    expect(gluedPunctuationTokens(raw)).toEqual([raw[4]]);
  });
});

// ---------------------------------------------------------------------------
// The measurement `gluedPunctuation.ts`'s own header comment quotes — run
// against the real fixture rather than asserted from memory, wherever this
// machine has it. `kanbun-info-parses.conllu` is gitignored
// (`kanbunInfoCorpus.test.ts` explains why) and built locally by
// `scripts/build-kanbun-info-corpus.py`, so this skips on a fresh checkout
// exactly as that suite does, and is not itself part of either ratchet: it
// reads the same file but writes no baseline and asserts no distance.
//
// This fixture is a frozen dump of `nlp(passage)` taken *outside* the app —
// `scripts/build-kanbun-info-corpus.py`'s own `parse()` calls spaCy directly
// rather than going through `pyodideWorker.ts` — so it still carries the raw
// defect this suite measures, and is exactly the right thing to measure it
// against: a change here is a real change in what the shipped wheel's
// tokenizer does on its own, before the two-stage fix in `parse()` ever
// touches it, and is worth re-reading `gluedPunctuation.ts`'s header over.
// ---------------------------------------------------------------------------

const PARSES_PATH = join(import.meta.dirname, "fixtures", "kanbun-info-parses.conllu");

if (existsSync(PARSES_PATH)) {
  describe("gluedPunctuationTokens — measured against the real corpus", () => {
    it("finds exactly the twelve measured cases in the untouched parse", () => {
      const tree = parseConllu(readFileSync(PARSES_PATH, "utf-8"));
      const raw = tree.sentences.flatMap((s) => s.tokens);
      expect(gluedPunctuationTokens(raw).length).toBe(12);
    });
  });
} else {
  describe("gluedPunctuationTokens — measured against the real corpus", () => {
    it.skip("kanbun-info-parses.conllu is not built on this machine", () => {});
  });
}
