import type { Token } from "../parse/types.ts";
import type { ConjClass } from "../kakikudashi/classicalConjugation.ts";

export type ReadingSource = "override" | "kanjidic" | "jmdict" | "unresolved";

export interface ResolvedReading {
  /** Kana reading to render as furigana over the token's/span's base text. */
  reading: string;
  /** Trailing inflectional kana not covered by the kanji base (e.g. verb
   * okurigana), rendered as plain text after the base rather than as ruby. */
  okurigana?: string;
  gloss?: string;
  source: ReadingSource;
  /** Set when this reading was chosen by a rule that read the *sentence*,
   * not just the character — the transitive/intransitive split (立 as 立つ
   * or 立てる, decided by whether the token has a `comp:obj` child) and the
   * on'yomi compound rule (破 as は inside 大破, kun'yomi やぶる anywhere
   * else).
   *
   * It exists because both display paths — `KundokuView.ts`'s per-token
   * dispatch and `generator.ts`'s — consult `VERB_LEXICON` *before* the
   * resolver, and that lexicon is keyed by lemma alone: it holds one
   * conjugation class and one reading per word, which is precisely the
   * thing a context-conditioned reading has to be able to differ from.
   * Without this flag a transitive 立 resolves correctly here and is then
   * discarded upstream in favour of the lexicon's single intransitive
   * entry. A reading carrying it is the more specific answer of the two and
   * should be preferred to the lexicon's; one without it is unconditional
   * per-character data, which the lexicon rightly outranks. */
  beatsLexicon?: boolean;
  /** Set when this word is written out in kana rather than kept as its kanji:
   * the 書き下し文 prints the reading in place of the character, and the 訓読文
   * puts it in the okurigana slot beside the character instead of as furigana
   * over it (a pronoun excepted — it is a real word with a real reading, and
   * takes furigana like any other).
   *
   * A property of the *word*, not of where its reading was looked up. It used
   * to be read off `source === "override"`, which made one field decide two
   * unrelated things: which reading a token gets, and how that reading is
   * displayed. That coupling is why a misfiring override entry was wrong
   * twice over — 獨酌's 獨 came out ひとり *and* in the wrong slot — and why
   * twenty entries whose reading kanjidic already supplies still cannot be
   * deleted: they are redundant as data and load-bearing as display, and
   * dropping them would start printing 吾 where the prose wants われ.
   * Separated so each can be decided on its own evidence. */
  spellOutInProse?: boolean;
  /** Set when the reading already carries every ending it should take, so no
   * further morph-driven one may be appended to it.
   *
   * The same exemption both panels already make for an override-sourced
   * gloss — 以's own `VerbForm=Conv` must not put a second て on もって — and
   * needed for the same reason by the modifier half of an on'yomi pair, which
   * is half of one word rather than a word of its own. See
   * `onyomiPairReading`. */
  endingComplete?: boolean;
  /** The classical conjugation class of the word this reading is of, set
   * only alongside `beatsLexicon` and only where it can be derived with
   * certainty (see `classicalConjClass` in `readingResolver.ts`).
   *
   * `beatsLexicon` stands `VERB_LEXICON` down, and the lexicon entry it
   * stands down was carrying two things, not one: a reading *and* a
   * conjugation class. Without this the class is simply lost and the
   * syntax-chosen reading reaches the page in citation form wherever an
   * inflected one was called for — transitive 立 (下二段タ行, renyoukei 立て)
   * printing as 廟を立つて rather than 廟を立てて. Carrying it lets both
   * panels rebuild a stand-in `LexiconEntry` (see `syntheticLexiconEntry`)
   * and run the reading through the ordinary conjugation pipeline instead of
   * around it.
   *
   * Optional, and left unset wherever the derivation is not certain: a
   * reading with no class falls back to exactly the behaviour it had before
   * this field existed, which is the right outcome for a word whose
   * paradigm cannot be read off its okurigana. */
  conjClass?: ConjClass;
  /** Set only by `spanSuruReading`: this is the reading of a whole fused
   * span that JMdict lists as a する-verb, and the サ変 class beside it is the
   * *span's*, to be written once after the last member.
   *
   * Named rather than inferred, because the panels cannot tell it from the
   * flags that were already there. `beatsLexicon` + a `conjClass` is also what
   * a transitivity-selected reading of a single character carries, and a span
   * member routinely has one: 俯 in 俯臥 resolves to ふ+す (四段サ行) and 暴 in
   * 暴癢 to a class of its own. Keying the group ending on those flags gave
   * 俯臥す and 暴癢る — one member's verb ending written after a two-character
   * word that is not that verb — where 俯臥 and 暴癢 are in no dictionary and
   * take no ending at all. */
  suruCompound?: boolean;
}

/** A resolver looks up one token in the context of its sentence (needed for
 * multi-character compound spans and dep/POS-conditioned overrides). */
export type ReadingResolver = (token: Token, sentence: { tokens: Token[] }) => ResolvedReading;
