import type { Token } from "../parse/types.ts";
import { AUXILIARY_LEMMAS, type ConjugatedForm, parseMorphFeatures } from "../kakikudashi/bungoConjugation.ts";
import { type ConjClass, isConjClass } from "../kakikudashi/classicalConjugation.ts";
import { attestedHistoricalReading, classicalAdjectiveReading, classicalConjClass, classicalVerbEnding } from "./classicalEnding.ts";
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

/** The reading exactly as the reader stored it, whatever kind of reading it
 * turns out to be — the raw MISC value, before `chosenAuxiliary` below sorts
 * the auxiliaries out of it.
 *
 * Two callers need the unsorted question answered, and both are asking
 * whether the reader has *touched* this character rather than what should be
 * drawn over it: `isRereadUse`, which lets any stored reading stand a 再読文字's
 * construction down, and the menu's 自動 item, which is the only way back from
 * a choice and so must appear wherever one is stored. Everything else wants
 * `chosenReadingText`. */
export function storedReadingText(token: Pick<Token, "misc">): string | undefined {
  return token.misc?.[READING_KEY];
}

/** Whether the reader's choice is a **bare reading** — a `Reading=` with
 * neither an `Okurigana=` nor a `ConjClass=` beside it.
 *
 * **This is what "the reader pinned an on'yomi" looks like in the data**, and
 * it is the test `conjugationContext.ts`'s `pinnedKeiyoudoushi` puts to a
 * token rather than sniffing the kana. The three keys above are written
 * together by `setChosenReading`, from one menu candidate, so the shape of
 * what was stored says which kind of candidate it was: `candidateReadings`
 * builds its on'yomi arm (`fromOn`) as a reading and nothing else, while every
 * kun'yomi it offers an *inflecting* token carries the dictionary's own dot as
 * an `Okurigana=` — the `kunWordClass(k) !== "nominal"` filter it applies at
 * `pos === "VERB"` and `pos === "ADJ"` is exactly the undotted readings, and it
 * drops every one of them. The lexicon arm writes an ending too (a 終止形
 * conjugated out of the sense's own class, with the class beside it), and an
 * auxiliary pick is held out one line below by `chosenAuxiliary`.
 *
 * **What that leaves is not quite only the on'yomi**, and the residue is
 * `overrides.json` — 165 of its 208 entries state no okurigana, and 然's
 * しかり is one of them on a character this treebank tags VERB with
 * `Degree=Pos`. The rule this feeds is written to survive that: it declines a
 * token that governs an object, it defers to `tariSuffixGroup` where the
 * character is half of a binom, and where a curated reading does slip through
 * it replaces one wrong ending (a bare stored reading on a VERB is already
 * given サ変's す by `chosenOkurigana` below, so a picked しかり prints 然しかりす
 * today) with another. Nothing that is right today is made wrong.
 *
 * Deliberately *not* a check that the reading is in KANJIDIC2's on series for
 * the character, which would be the direct test and is the one thing this
 * module cannot ask: the index is loaded at runtime and handed to the resolver,
 * and neither this file nor `conjugationContext.ts` — where the rule has to
 * live, since it needs `tariSuffixGroup` and the tree — has it in hand. The
 * stored shape is the evidence that is actually here, and it is the same
 * evidence `chosenOkurigana`'s own サ変 rule already runs on. */
export function isBareChosenReading(token: Pick<Token, "misc"> & Partial<Pick<Token, "lemma">>): boolean {
  return (
    storedReadingText(token) !== undefined &&
    !token.misc?.[OKURIGANA_KEY] &&
    !token.misc?.[CONJ_CLASS_KEY] &&
    !chosenAuxiliary(token)
  );
}

/** **The auxiliary a hand-picked reading *is*, where the reader picked one of
 * this app's own auxiliaries rather than a reading of the character.**
 *
 * べし, まほし and しむ are on the menu because the page shows them — the menu's
 * standing rule (see `curatedCandidates`) — and they arrive there from
 * `AUXILIARY_LEMMAS` and from `overrides.json`'s identical entries for 可 and
 * 使/令/教. But an auxiliary is not a reading of its character in the way every
 * other candidate is. Its kanji is dropped in the prose, its kana stand in the
 * okurigana slot rather than over the character, and it inflects by a paradigm
 * this app already holds — which is precisely what a pick used to throw away.
 * A picked べし was stored as a whole word with no class beside it (none could
 * be named: `conjugatedOkurigana` appends a suffix, and a class named beside
 * べし would print 可[べし]シ), so it went through the hand-picked branch of
 * both panels and froze there: 王不可飲酒 came out 可[べし] in the 訓読文 with
 * the ベカラ gone, and 王は酒を飲む可べしず in the prose — the very べし+ず that
 * `POTENTIAL.mizen` exists to prevent, with 可's kanji left standing besides.
 *
 * **So a picked auxiliary is not routed round the auxiliary machinery; it is
 * routed back into it.** This is what tells the two apart, and everything
 * downstream follows from it: `pickedReading` returns nothing for such a token,
 * so both panels' hand-picked branch stands down and the ordinary auxiliary
 * branch below it renders the cell — same slot, same `selectForm`, same
 * 未然形 before a following ず. The pick then behaves exactly as the auxiliary
 * the app would have written unaided, which is the whole of what "picked
 * auxiliaries should inflect" asks for.
 *
 * **No new MISC key was needed to record it**, and that is not an accident of
 * the implementation but a fact about the data: `AUXILIARY_LEMMAS` is keyed on
 * the lemma and each of the eleven characters has exactly one auxiliary, so
 * "the stored reading is this character's auxiliary" is a question the stored
 * reading already answers. A choice written into a saved text or a `.conllu`
 * file *before* this existed is therefore recognised on sight and starts
 * inflecting the moment it is reopened — including the ones made through
 * `overrides.json`, which store the same べし and しむ and were frozen the same
 * way.
 *
 * **The okurigana is what keeps this off the dictionary's own べし.** KANJIDIC2
 * lists 可 as べ.し and べ.き, which the menu offers beside the curated べし and
 * which are a genuinely different claim: a 可 read as an adjective in its own
 * right, kanji retained, inflecting by ク活用 (可し, 可き). Those are stored as
 * a stem べ with an ending し, so they are not this — and the reader who wants
 * them still has them. Only a reading standing on its own, spelled exactly as
 * the paradigm's citation form, is the auxiliary. */
export function chosenAuxiliary(token: Pick<Token, "misc"> & Partial<Pick<Token, "lemma">>): ConjugatedForm | undefined {
  const aux = token.lemma === undefined ? undefined : AUXILIARY_LEMMAS[token.lemma];
  if (!aux || token.misc?.[OKURIGANA_KEY]) return undefined;
  return storedReadingText(token) === aux.primary ? aux : undefined;
}

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

/** The picked reading itself, in the orthography this app writes in.
 *
 * **A choice is stored as the reader typed it and read back converted**, which
 * is the same discipline `chosenOkurigana` above follows and for the same two
 * reasons. The kanjidic candidate the menu offers is written in 現代仮名遣い —
 * 貯's own is たくわ.える — so a choice that were echoed verbatim would put
 * modern Japanese in the middle of a classical text: 貯 printed たくは when the
 * resolver read it out of `VERB_LEXICON` and たくわ the moment the reader
 * *picked that same word* off the menu. And converting on the way in instead
 * would leave every choice already stored — in a saved text, or in the MISC
 * column of a `.conllu` file — exactly as wrong as it was, with nothing to
 * bring it up to date. Converting here fixes those too, and the round trip is
 * unaffected either way: MISC keeps the reader's own string, `conlluExporter`
 * writes back what it read, and the conversion is re-derived on every render.
 *
 * `attestedHistoricalReading` is the whole of the conversion — see its doc for
 * why there is no general modern-to-historical rule to apply instead, and for
 * the four cases in which it declines and hands the reading back untouched.
 *
 * Both panels and the resolver come through here (`chosenReading`,
 * `chosenReadingParts`, and `chosenReadingText`'s three direct-render callers),
 * so none of them can print a spelling the others do not.
 *
 * **The stored, unconverted reading is what `chosenOkurigana` and
 * `chosenConjClass` above go on reading**, deliberately: they are keyed by the
 * modern citation spelling KANJIDIC2 wrote (`LEXICAL_KUN`'s もちいる,
 * `attestedSenseByModernSpelling`'s reading+okurigana pair), and both accept
 * either spelling in any case, so nothing is gained by handing them the
 * converted one and the modern-ending warning on `chosenConjClass` stays true
 * as written. */
function pickedReading(token: Pick<Token, "misc"> & Partial<Pick<Token, "lemma">>): string | undefined {
  const stored = storedReadingText(token);
  if (stored === undefined) return undefined;
  // **An auxiliary is not one of these**, and this is the one gate that keeps
  // it out of all of them: `chosenReading`, `chosenReadingText` and
  // `chosenReadingParts` are this function wearing three hats, so declining
  // here stands the hand-picked branch of both panels down at once and lets
  // the auxiliary branch behind it render the cell, inflected. See
  // `chosenAuxiliary` for why that is the right treatment and not an evasion.
  if (chosenAuxiliary(token)) return undefined;
  return attestedHistoricalReading(token.lemma, stored, token.misc?.[OKURIGANA_KEY]);
}

/** The hand-picked reading for `token`, or null if it has none. */
export function chosenReading(token: Token): ResolvedReading | null {
  const reading = pickedReading(token);
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
 * shape it is declared against.
 *
 * The lemma is optional for that same reason and is the one thing the
 * historical-kana conversion needs (`pickedReading` — a reading is a stem, and
 * only the character it sits on says which word's stem it is). Every caller
 * that *draws* the reading hands over a whole token and gets the conversion;
 * the three that only ask whether a choice exists at all
 * (`isRereadUse`, `isNegationUse`, `depClassification`'s two) are unaffected
 * either way, since a conversion never turns a reading into `undefined`. */
export function chosenReadingText(token: Pick<Token, "misc"> & Partial<Pick<Token, "lemma">>): string | undefined {
  return pickedReading(token) || undefined;
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

/** Whether a hand-picked reading is what this token is drawn from — asked by
 * `rubyGloss.ts`, which puts the reading over the word in the prose so that a
 * reading the reader chose is visible there as well as in the 訓読文.
 *
 * An auxiliary pick is *not* one, by the same reading of the same rule
 * `pickedReading` above applies: nothing is drawn from it that the app would
 * not have drawn anyway, and the prose piece for such a token is the auxiliary's
 * own kana with the kanji dropped — so a ruby raised over it would be spelling
 * べし over べし. Use `storedReadingText` for the other question, whether the
 * reader has touched the character at all. */
export function hasChosenReading(token: Token): boolean {
  return storedReadingText(token) !== undefined && !chosenAuxiliary(token);
}

/** The three keys, for the undo snapshot — which has to record them or a
 * reading choice would be the one edit Cmd+Z couldn't reach. */
export const READING_MISC_KEYS = [READING_KEY, OKURIGANA_KEY, CONJ_CLASS_KEY] as const;
