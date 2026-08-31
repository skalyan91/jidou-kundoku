import type { Token } from "../parse/types.ts";
import { parseMorphFeatures } from "../kakikudashi/bungoConjugation.ts";
import { type ConjClass, isConjClass } from "../kakikudashi/classicalConjugation.ts";
import { classicalAdjectiveReading, classicalConjClass, classicalVerbEnding } from "./classicalEnding.ts";
import type { ResolvedReading } from "./types.ts";

/** A reading the user picked by hand, from the furigana's right-click menu.
 *
 * Stored in the token's own `misc` map rather than in a side table keyed by
 * token, because `misc` is already part of the tree: it is serialized into
 * saved texts, written to the MISC column on CoNLL-U export, and read back
 * by the importer. A choice therefore survives saving, reopening, and a
 * round trip through a `.conllu` file with no extra plumbing — and travels
 * with the token it belongs to rather than to a position that a later edit
 * could invalidate.
 *
 * The keys are CoNLL-U MISC attributes, so they follow that column's
 * Key=Value convention and its initial-capital style. */
const READING_KEY = "Reading";
const OKURIGANA_KEY = "Okurigana";
/** The third key, and the one that is not derivable from the other two.
 *
 * `chosenConjClass` reads the paradigm back off the stored ending wherever
 * the ending still says what it is, which is everywhere a verb is concerned:
 * kanjidic writes verb okurigana as a modern dictionary ending, and 立てる
 * against 立ちる is the 下二段/四段 distinction written down. Adjectives have
 * no such ending to read. The menu offers them already converted to the
 * classical 終止形 (`classicalAdjectiveKun` — 易い is not a reading this app
 * would print), and both ク活用 and シク活用 end in し there, so やす + し and
 * やさ + し are one stored shape with two paradigms behind it. Nothing in
 * `misc` could tell them apart, and with no class there was nothing to
 * inflect: a picked 易 printed its 終止形 易し wherever it stood, including
 * before のみ, where 易耳 wants the 連体形 易き (or 易しき for やさシ).
 *
 * So the class is stored rather than re-derived, taken from the candidate
 * that knew it while the modern ending was still in hand. Written only where
 * the ending cannot answer: the converted adjectives, and 用's もちゐる, whose
 * ワ行上一段 is a fact about the word and not about ゐる (see `LEXICAL_KUN` —
 * 老いる and 悔いる are ヤ行上二段 with the same い before the same る). A
 * choice that stores no class behaves precisely as it did before this key
 * existed, and so does one restored from a saved text or a `.conllu` file
 * written before it — `chosenConjClass` falls through to the derivation,
 * which reaches the same ワ行上一段 for a もち reading whichever of いる or
 * ゐる that older file happens to hold. */
const CONJ_CLASS_KEY = "ConjClass";

/** The ending a hand-picked kun'yomi takes, in classical shape.
 *
 * The stored ending is kanjidic's, taken off the candidate the reader
 * clicked, and kanjidic writes its okurigana as a *modern* dictionary
 * ending throughout — so it has to go through the same two conversions
 * `readingResolver.ts` applies to every reading it settles on itself, or a
 * picked reading lands modern Japanese in the middle of a classical text.
 * Both were live: picking 立's た.てる wrote 王太子を立てるて去ぬ where the
 * resolver's own 立 gives 立てて, and picking 遠's とほ.い — the reading
 * already on the page — turned 道遠し into 道遠い.
 *
 * The adjective conversion is gated on the token being used adjectivally,
 * exactly as the resolver gates it, and the gate is what keeps it off the
 * 連用形 nominals kanjidic writes with the same final い (扱's あつか.い
 * "handling", 向's む.かい "facing" — nouns, never 扱し). The verb one needs
 * no gate: a two-kana -る is a shape kanjidic only ever writes for an
 * inflecting word, and the menu offers a dotted kun'yomi to nothing else.
 * `isTopicalizedAdjective`'s 連体形 refinement is deliberately not attempted
 * — it needs the sentence, which `chosenReadingParts`' callers do not pass
 * — and 終止形 し is the right default rather than a compromise: the
 * resolver's chosen-reading branch runs ahead of that refinement anyway, so
 * nothing here ever reached it.
 *
 * An on'yomi candidate has no ending of its own — and a verb read on'yomi is
 * read サ変 in kundoku (中 as ちゅうス, not the bare stem), so that is
 * supplied here. Without it the ending left on screen would be whatever the
 * *previous* reading inflected to, which is how choosing ちゅう over あたル
 * first produced the nonsense ちゅうル. Restricted to VERB: an on'yomi noun
 * takes no ending at all, and an adjective would need なり rather than す,
 * which the copula machinery already decides on its own evidence. */
function chosenOkurigana(token: Token): string | undefined {
  const stored = token.misc?.[OKURIGANA_KEY];
  if (!stored) return token.pos === "VERB" ? "す" : undefined;
  const adjectival = token.pos === "ADJ" || parseMorphFeatures(token.morph ?? "").Degree === "Pos";
  // Both are no-ops on an ending already in classical shape (a one-kana
  // ending for the verb rule, an ending not in い for the adjective one), so
  // this is safe to run over a choice restored from a saved text or read
  // back off a `.conllu` file's MISC column, whichever shape it was in when
  // it was written.
  // The reading is handed over unused — `classicalAdjectiveReading` only
  // rewrites it for an entry that has no okurigana at all to rewrite, which
  // a stored ending by definition is not — but passed all the same rather
  // than a stand-in, so the call says what it is asking about.
  const ending = adjectival
    ? classicalAdjectiveReading(token.misc?.[READING_KEY] ?? "", stored).okurigana
    : stored;
  // The reading goes with the ending because one word's ending cannot be
  // converted without it: 用's もち.いる is 用ゐる and 老's お.いる is 老ゆ, and
  // only the stem separates them (see `LEXICAL_KUN`). It matters here even
  // though the menu now offers もちゐる already converted — a choice stored
  // before that, in a saved text or a `.conllu` file, still holds the modern
  // いる, and this is where such a choice is brought up to date.
  return classicalVerbEnding(ending, token.misc?.[READING_KEY]);
}

/** The conjugation paradigm a hand-picked reading inflects by, or undefined
 * where it cannot be read off the ending.
 *
 * An ending alone is a citation form, and a citation form is all either panel
 * could print without this: picking 立's た.てる gave 王太子を立つて去ぬ where
 * the resolver's own 立 gives 立てて. Naming the class is what puts the choice
 * on the ordinary conjugation pipeline — `syntheticLexiconEntry`,
 * `decideConjForm`, `conjugatedOkurigana` — rather than around it, which is
 * the same treatment, through the same helpers, that a syntax-chosen reading
 * already gets from `beatsLexicon`.
 *
 * Derived from the ending as it is *stored*, which is kanjidic's modern one,
 * and deliberately not from what `chosenOkurigana` hands back: that has
 * already been converted to the classical 終止形, and the conversion is lossy
 * in exactly the place the class turns on — た.てる and た.ちる both give 立つ,
 * and 下二段タ行 against 四段タ行 is the whole difference between 廟を立てて and
 * 廟立ちて. Reading `misc` directly here is what keeps the unconverted value
 * in reach; see `classicalEnding.ts` for the same warning on the other side.
 *
 * An on'yomi candidate stores no ending at all and is read サ変 (see
 * `chosenOkurigana`) — but す is only that paradigm's 終止形, and naming the
 * class instead lets the pipeline inflect it from context, exactly as
 * `onyomiPairReading` does for the same reason: without it 大破 was frozen at
 * す everywhere, giving 大破すの時 for the 連体形 and 大破すず for the 未然形
 * where サ変's mizen is せ.
 *
 * Undefined everywhere the derivation is not certain — the whole あ row above
 * all — and that is deliberate: the caller then has no lexicon entry and
 * emits the classical citation form exactly as it does today. An
 * uninflected ending is what this path already produced; a confidently wrong
 * paradigm would be worse than either.
 *
 * The lemma and the picked reading are handed over with the ending, which is
 * what lets a one-kana ending reach an attested class instead of the 四段 the
 * shape alone suggests: picking 見's み.る off the menu gave 見り, since
 * `classicalConjClass` had only a bare る to go on. Both panels take this
 * branch ahead of the lexicon, so nothing else would have corrected it. */
function chosenConjClass(token: Token): ConjClass | undefined {
  // A class stored outright outranks the derivation below, and is the only
  // thing that can speak for an adjective — see `CONJ_CLASS_KEY` for why the
  // stored ending cannot. Checked against the paradigm table before it is
  // believed, since MISC is whatever the `.conllu` file says and `conjugate`
  // throws on a name it has no table for; an unrecognised one falls through
  // to the derivation exactly as an absent one does.
  const named = token.misc?.[CONJ_CLASS_KEY];
  if (named && isConjClass(named)) return named;
  const stored = token.misc?.[OKURIGANA_KEY];
  if (stored) return classicalConjClass(stored, { lemma: token.lemma, reading: token.misc?.[READING_KEY] });
  return token.pos === "VERB" ? "sa-hen" : undefined;
}

/** The hand-picked reading for `token`, or null if it has none. */
export function chosenReading(token: Token): ResolvedReading | null {
  const reading = token.misc?.[READING_KEY];
  if (reading === undefined) return null;
  const conjClass = chosenConjClass(token);
  return {
    reading,
    okurigana: chosenOkurigana(token),
    ...(conjClass ? { conjClass } : {}),
    // Tagged "kanjidic" rather than "override": these come from the
    // kanjidic candidate list and are content-word readings that keep their
    // kanji in the kakikudashi, which is what that tag controls — not the
    // bare-kana treatment `source: "override"` gives function words.
    source: "kanjidic",
  };
}

/** Just the reading string, for the render paths that build furigana
 * directly instead of going through the resolver (the verb lexicon, and the
 * per-character fallback inside a compound). Those bypass
 * `createReadingResolver` altogether, so a hand-picked reading has to be
 * checked at each of them or it would appear to be ignored on exactly the
 * common words the lexicon exists to cover.
 *
 * Takes anything carrying a `misc` map rather than a whole `Token`, since
 * that is all it reads — `isRereadUse` asks this of the structural token
 * shape it is declared against. */
export function chosenReadingText(token: Pick<Token, "misc">): string | undefined {
  return token.misc?.[READING_KEY] || undefined;
}

/** The reading, its ending, and the paradigm that ending inflects by, for
 * the same direct-render paths — they build okurigana from the reading they
 * picked, so a hand-picked one has to bring its own or the old reading's
 * inflection would be left behind.
 *
 * The class comes along because both panels' hand-picked branch is reached
 * *ahead* of the lexicon branch that would otherwise supply one: the choice
 * outranks every context-specific reading, the lexicon included, so the
 * ending has to arrive already knowing how to inflect or it can only be
 * printed in citation form. The shape returned is deliberately the one
 * `syntheticLexiconEntry` reads (`{ conjClass, reading, okurigana }`), so
 * both panels hand it straight over rather than each assembling an entry of
 * its own. */
export function chosenReadingParts(
  token: Token,
): { reading: string; okurigana?: string; conjClass?: ConjClass } | null {
  const reading = chosenReadingText(token);
  if (reading === undefined) return null;
  const conjClass = chosenConjClass(token);
  return { reading, okurigana: chosenOkurigana(token), ...(conjClass ? { conjClass } : {}) };
}

/** `conjClass` is the candidate's own, and only the candidates that have one
 * — the adjectives whose ending was converted to the classical 終止形, where
 * the ク/シク distinction the paradigm turns on is no longer in the ending
 * (see `CONJ_CLASS_KEY`). Deleted rather than left standing when absent, so
 * that picking a plain verb reading over an adjective one does not inherit
 * the adjective's paradigm — every key here describes one choice, and a
 * choice replaces the previous one whole. */
export function setChosenReading(token: Token, reading: string, okurigana?: string, conjClass?: ConjClass): void {
  token.misc = { ...token.misc, [READING_KEY]: reading };
  if (okurigana) token.misc[OKURIGANA_KEY] = okurigana;
  else delete token.misc[OKURIGANA_KEY];
  if (conjClass) token.misc[CONJ_CLASS_KEY] = conjClass;
  else delete token.misc[CONJ_CLASS_KEY];
}

/** Drops the hand-picked reading, returning the token to whatever the
 * resolver would work out on its own. */
export function clearChosenReading(token: Token): void {
  if (!token.misc) return;
  delete token.misc[READING_KEY];
  delete token.misc[OKURIGANA_KEY];
  delete token.misc[CONJ_CLASS_KEY];
}

export function hasChosenReading(token: Token): boolean {
  return token.misc?.[READING_KEY] !== undefined;
}

/** The three keys, for the undo snapshot — which has to record them or a
 * reading choice would be the one edit Cmd+Z couldn't reach. */
export const READING_MISC_KEYS = [READING_KEY, OKURIGANA_KEY, CONJ_CLASS_KEY] as const;
