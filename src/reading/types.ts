import type { Token } from "../parse/types.ts";
import type { ConjClass, ConjForm } from "../kakikudashi/classicalConjugation.ts";

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
  /** For one of `classicalEnding.ts`'s `KANJI_RETAINED_ADVERBS` — an adverb
   * that keeps its kanji in the 書き下し文 — the okurigana written after that
   * kanji: "" for 亦 and 皆, て for 嘗, ず for 必. Absent for every other token,
   * and for one of those adverbs whose reading here is not the adverb's own
   * word (獨 as the ドク of 獨酌).
   *
   * **It rides here because this is the only thing both panels already hold.**
   * The division is KANJIDIC2's own okurigana dot and is read from the index
   * (`retainedAdverbOkurigana` in `kanjidicLookup.ts`), and the index is
   * fetched at runtime — so it can only be asked for somewhere that has been
   * handed the index, and `generateKakikudashiPieces` has not: it takes a plan
   * and a resolver and nothing else. `createReadingResolver` is handed both
   * indices and is called once, so the question is asked there, once per token,
   * and the answer travels to the prose generator and to `KundokuView.ts` on
   * the reading they both already ask for. The alternative was threading a
   * kanjidic index down through the generator's whole signature and every one
   * of its callers, to reach two lines.
   *
   * Nothing else on this object moves with it: `reading`, `okurigana` and
   * `spellOutInProse` are exactly what they were, and this is read only by the
   * two branches that were reading the table directly. It is a fact about the
   * token's *lemma*, not about the reading beside it, and is set on every token
   * of a listed character — so a 猶 the parser tagged VERB carries なほ's
   * division even though it resolved to ごとし, and the branches that read it
   * refuse it there on the evidence they already used (`retainedAdverbParts`
   * declines a reading that does not end in the okurigana; both panels stand
   * the rule down on `beatsLexicon`). */
  retainedAdverbOkurigana?: string;
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
  /** **Which form of that class the `okurigana` above was written in**, where
   * it is not the 終止形 every other rule here writes.
   *
   * Set by `adverbialCopulaEnding` and by nothing else: it is the one rule in
   * `readingResolver.ts` that answers with an inflected form rather than a
   * citation one, an ADV-tagged 形容動詞 being in its 連用形 whatever the
   * predicate turns out to be (暴に, 大いに). Every other resolver-supplied
   * okurigana is a *seed* — `attestedSense` matches a `LEXICON_SENSES` entry
   * against it and `pickedEnding` then re-conjugates whatever comes back — so
   * the seed has to be conjugated in a form the matcher can compare against,
   * and the matcher has to be told which one it is.
   *
   * **Without it the match fails silently and a prefix is lost.** The matcher's
   * comparison is `conjugatedOkurigana(sense, "shuushi")`, so a 連用形 seed
   * matched nothing at all: 大 as おほ + `okuriganaPrefix` い answered いに, was
   * compared against いなり, found no sense, and fell back on a synthesized
   * entry rebuilt from the reading alone — which carries no prefix by design —
   * so the 399 adverbial 大 printed 大(おほ)に, a reading of nothing. That is the
   * same failure `pinnedKeiyoudoushi` names in its own doc and avoids the same
   * way, by seeding the 終止形 and reporting the form separately; this field is
   * that report for the resolver's half of the pair.
   *
   * Absent everywhere else, and then the matcher's default 終止形 is exactly
   * what it always compared against — so no reading that did not come from
   * that one rule can move. */
  okuriganaForm?: ConjForm;
  /** **The class beside this reading is the *span's*, to be written once after
   * the last member** — not this one character's.
   *
   * Set by the two span rules in `readingResolver.ts` and by the pick path that
   * carries their answer through a bare pin. `spanSuruReading` names サ変 for a
   * fused span read on'yomi and standing as a verb (蠕動す, 俯臥す) and
   * `redupTariReading` names タリ活用 for a reduplicated descriptive (蕭蕭たり,
   * 冥冥たり); the flag says the same thing about both, and the name is the
   * older of the two claims rather than a statement that the class is サ変.
   *
   * Named rather than inferred, because the panels cannot tell it from the
   * flags that were already there. `beatsLexicon` + a `conjClass` is also what
   * a transitivity-selected reading of a single character carries, and a span
   * member routinely has one: 俯 in 俯臥 resolves to ふ+す (四段サ行) and 暴 in
   * 暴癢 to a class of its own. Keying the group ending on those flags wrote
   * *that* member's own paradigm after the whole word — 俯臥す as ふ+す's 終止形,
   * and 暴癢る — which is a different claim from the one this flag makes, and
   * wrong wherever the two disagree: 俯臥 takes サ変 because it is a
   * Sino-Japanese word read ふぐわ, not because 俯 alone is a サ行 verb, and it
   * is サ変 that gives the 未然形 せ in 俯臥せしむ where ふ+す would give さ. */
  suruCompound?: boolean;
}

/** A resolver looks up one token in the context of its sentence (needed for
 * multi-character compound spans and dep/POS-conditioned overrides). */
export type ReadingResolver = (token: Token, sentence: { tokens: Token[] }) => ResolvedReading;
