import type { Token } from "../parse/types.ts";
import { AUXILIARY_LEMMAS, COPULA, type ConjugatedForm, isDescriptiveToken } from "../kakikudashi/bungoConjugation.ts";
import { type ConjClass, isConjClass } from "../kakikudashi/classicalConjugation.ts";
import { attestedSenseByModernSpelling, lexiconSensesByReading } from "../kakikudashi/verbLexicon.ts";
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
 * **It began as the adjectives' key.** The menu offers them already converted
 * to the classical 終止形 (`classicalAdjectiveKun` — 易い is not a reading this
 * app would print), and both ク活用 and シク活用 end in し there, so やす + し and
 * やさ + し are one stored shape with two paradigms behind it. Nothing in `misc`
 * could tell them apart, and with no class there was nothing to inflect: a
 * picked 易 printed its 終止形 易し wherever it stood, including before のみ,
 * where 易耳 wants the 連体形 易き (or 易しき for やさシ). So the class is stored
 * rather than re-derived, taken from the candidate that knew it while the
 * modern ending was still in hand.
 *
 * **The verbs have joined them, and the reason is the same one read the other
 * way round.** Their endings could be re-derived — kanjidic writes verb
 * okurigana as a modern dictionary ending, and 立てる against 立ちる is the
 * 下二段/四段 distinction written down — and that legibility was exactly what
 * kept the menu offering them in modern shape: convert 起's き.る to 起く and the
 * lone く reads back as 四段カ行 where the word is 上二段. A menu spelled in
 * 下一段 endings beside a page written in 文語 is the thing the reader
 * objected to, and storing the class is what lifts the constraint — a
 * conversion may now be as lossy as it needs to be. See `classicalVerbKun` in
 * `kanjidicLookup.ts`, which writes the ending out of the paradigm rather than
 * converting the string, and so reaches 覺's おぼゆ where no shape rule could.
 * 用's もちゐる is here on its own account still: its ワ行上一段 is a fact about
 * the word and not about ゐる (see `LEXICAL_KUN` — 老いる and 悔いる are ヤ行上二段
 * with the same い before the same る).
 *
 * **A choice that stores no class is not left frozen either.** One written by
 * hand, or into a saved text or a `.conllu` file before any of this existed,
 * falls through to `chosenConjClass`'s derivation, which now has three routes
 * rather than one and reaches a paradigm for most of them — including the pins
 * whose stored ending is an inflected *form* rather than a citation, which no
 * ending-shaped rule could ever have read. Nothing is migrated: `misc` keeps
 * what the reader stored, so such a file round-trips byte for byte. */
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
 * しかり is one of them on a character that arrives `Degree=Pos`: tagged VERB
 * up to parser 0.3.1, and **ADJ** from 0.3.2, which recoded the stative class
 * (over the recoded gold 然 is ADV 442 / ADJ 303 / PART 215 and VERB 0 — the
 * entry's own `contextPos` was widened to match). The rule this feeds is written to survive that: it declines a
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
  if (token.misc?.[OKURIGANA_KEY]) return undefined;
  // **The 断定の助動詞 is the twelfth, and it is keyed on the reading rather than
  // on the lemma**, which is the one thing that distinguishes it from the
  // eleven above. Those are auxiliaries *of a character*: 可 is べし and nothing
  // else is. なり is an auxiliary of no character in particular — it is what
  // kundoku writes for whichever character happens to carry the copula in a
  // given sentence, and the reader is the one who says which. 有子's
  // 孝弟也者 pins `Reading=なり` on the 也 (whose own override reading at `mod`
  // is や) and 其為仁之本與 pins `Reading=たり` on the 爲; both are the reader
  // saying "this character is the copula", and neither lemma could be listed in
  // `AUXILIARY_LEMMAS` without asserting it of every other occurrence — 也 is a
  // sentence-final や or a topic marker far more often than it is a copula.
  //
  // What follows from being recognised here is the whole of the fix, and it is
  // the same thing the eleven get: the pin stops being a *reading drawn over a
  // character* and becomes an auxiliary the app writes and inflects. 也 kept its
  // kanji and its frozen なり in the prose (孝弟**也者**); it now writes 孝弟なる
  // もの — kanji dropped, `selectedForm` picking the 連体形 in front of the
  // nominalizer, which is exactly what a pinned べし gained when
  // `chosenAuxiliary` was written.
  //
  // **たり is admitted beside なり and resolves to the same paradigm.** `COPULA`
  // holds them as one form with たり as its `alt` — "the attributive-heavy
  // classical copula variant" — so the app has one 断定 paradigm and writes it
  // なり/なる/なら/なれ. The reader pinned たり on 爲 and asked for the sentence to
  // end **なるや**, not たるや, so nothing is lost by resolving the pin to the
  // paradigm rather than to the string: the pin says which construction the
  // character is, and the app writes that construction in its own citation
  // form. A separate 断定タリ paradigm would be a different claim (たら/たり/たる/
  // たれ, distinct from `tari-keiyoudoushi`'s として 連用形) and is deliberately
  // not added on a case that does not ask for it.
  const stored = storedReadingText(token);
  if (stored === COPULA.primary || stored === COPULA.alt) return COPULA;
  const aux = token.lemma === undefined ? undefined : AUXILIARY_LEMMAS[token.lemma];
  if (!aux) return undefined;
  return stored === aux.primary ? aux : undefined;
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
 * exactly as the resolver gates it — through the same `isDescriptiveToken`,
 * which is what keeps the two from drifting — and the gate is what keeps it
 * off the 連用形 nominals kanjidic writes with the same final い (扱's あつか.い
 * "handling", 向's む.かい "facing" — nouns, never 扱し). The verb one needs
 * no gate: a two-kana -る is a shape kanjidic only ever writes for an
 * inflecting word, and the menu offers a dotted kun'yomi to nothing else.
 * `isTopicalizedAdjective`'s 連体形 refinement is deliberately not attempted
 * — it needs the sentence, which `chosenReadingParts`' callers do not pass
 * — and 終止形 し is the right default rather than a compromise: the
 * resolver's chosen-reading branch runs ahead of that refinement anyway, so
 * nothing here ever reached it.
 *
 * **That gate was `pos === "ADJ" || Degree=Pos` written out here, and under
 * parser 0.3.2 its two disjuncts have come apart.** Up to 0.3.1 the first was
 * dead — the parser emitted no ADJ — and the second, on a VERB, *was* the
 * adjective test. Now the first catches the adjectives natively and the second
 * catches only ADV and NOUN, which are real cases and wanted here: a
 * descriptive standing adverbially still owes the page a classical ending
 * rather than kanjidic's modern い. What the disjunction must **not** go on
 * catching is a VERB that carries the feature, which is a 0.3.1-era tree the
 * app can still be handed — from a saved text, or from the canonical treebank
 * files uploaded as `.conllu`. The annotation editor shows such a token as
 * 動詞, so an adjective's ending written onto it would put the page at odds
 * with its own chip. `isDescriptiveToken` is where that exclusion is made, once
 * and for the resolver's own gate as well.
 *
 * An on'yomi candidate has no ending of its own — and a verb read on'yomi is
 * read サ変 in kundoku (中 as ちゅうス, not the bare stem), so that is
 * supplied here. Without it the ending left on screen would be whatever the
 * *previous* reading inflected to, which is how choosing ちゅう over あたル
 * first produced the nonsense ちゅうル. Restricted to VERB: an on'yomi noun
 * takes no ending at all, and an adjective would need なり rather than す,
 * which the copula machinery already decides on its own evidence.
 *
 * **That last exclusion only became real under 0.3.2**, which is worth saying
 * because it looks unchanged. Up to 0.3.1 a stative was tagged VERB, so a
 * pinned on'yomi on one took the す this line writes for a verb; the tag now
 * withholds it and the 形容動詞 machinery answers instead
 * (`pinnedKeiyoudoushi`). The one case that still wants す is a descriptive
 * *governing an object* — a transitive use, 僧愚之 — and it is written out
 * there rather than here, because it is a fact about the sentence and this
 * function is handed only a token. */
function chosenOkurigana(token: Token): string | undefined {
  const stored = token.misc?.[OKURIGANA_KEY];
  if (!stored) return token.pos === "VERB" ? "す" : undefined;
  const adjectival = isDescriptiveToken(token);
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
 * **Three routes now, tried in order, and the second and third exist because
 * an ending is not always evidence about a paradigm.** A pin picked off
 * today's menu carries its class outright and never reaches any of them
 * (`CONJ_CLASS_KEY`, checked first). What does reach them is everything
 * written before that, or by hand, or by an older build — and the reader's own
 * 酒蟲 has five such pins in it:
 *
 *  1. `classicalConjClass`, the derivation above, on the stored ending. It
 *     answers for 出's い + でる (下二段ダ行) and 惡's にく + む (四段マ行).
 *  2. `attestedSenseByModernSpelling`, on the same ending. The derivation
 *     already asks this for a *one-kana* ending, where it is the defence
 *     against its own 四段 guess; asked again with no length bound it reaches
 *     the endings that function declines to read at all — the ones with a stem
 *     mora inside them, 試's こころ + みる and 果's は + たす.
 *  3. `soleAttestedClass`, on the *word* and not on the ending at all, which is
 *     the only thing that can answer where the stored ending is an inflected
 *     form rather than a citation — 覺's おぼ + ゆる. See it for the three
 *     cases it refuses.
 *
 * Undefined still, wherever none of the three answers, and the pin then stands
 * exactly as frozen as it was.
 *
 * All three are `derivedConjClass` below, which is where they went when the
 * readings menu needed to ask the same question of a candidate — a label that
 * named a paradigm the app would not then inflect by would be worse than no
 * label at all, and one function is the only way to be sure it cannot happen.
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
  const reading = token.misc?.[READING_KEY];
  if (stored) return derivedConjClass(token.lemma, reading, stored);
  return token.pos === "VERB" ? "sa-hen" : undefined;
}

/** The two routes below `CONJ_CLASS_KEY` — the paradigm a reading and a
 * *modern* ending imply, where no class was stored beside them.
 *
 * Split out of `chosenConjClass` so that the **menu can ask the same question
 * of a candidate it has not stored yet**, and get the same answer. That is the
 * whole of what makes a conjugation cartouche honest: the label printed beside
 * 引ク in the menu has to be the paradigm the app will actually inflect a
 * picked 引ク by, and there is exactly one way to guarantee that, which is for
 * the two to be one function. See `conjClassCartouches` in
 * `kanjidicLookup.ts`, the menu's caller, which asks
 * `candidate.conjClass ?? derivedConjClass(...)` — the same order
 * `chosenConjClass` asks in, since a candidate's own class is stored outright
 * (`setChosenReading`) and so reaches `CONJ_CLASS_KEY` rather than here.
 *
 * **The ending it is asked about is the modern one**, kanjidic's own, exactly
 * as `chosenConjClass` reads it out of MISC unconverted — see the warning
 * there. A candidate's `okurigana` is that same modern ending wherever this
 * function is reached at all: `classicalVerbKun` converts an ending only when
 * it puts a class beside it, and a candidate carrying a class never asks.
 *
 * Undefined where none of the routes answers, which is a real state and not a
 * hole: the pin then stands at whatever form it holds, uninflected. That is
 * why the cartouche has a 未詳 to print rather than a gap to leave — and how
 * rarely it is reached is the measure of what the second and third routes are
 * worth. 合's あ+わす, 赤's あか+らむ and 卑's いや+しむ each hold an ending with a
 * stem mora inside it that `classicalConjClass` declines to read, and route 2
 * answers all three off the lexicon's own modern spelling (四段サ行, 四段マ行,
 * 四段マ行) — so over every collision in the shipped index the label falls back
 * to 未詳 exactly once, on 黑's くろ+し under a nominal tag. */
export function derivedConjClass(
  lemma: string,
  reading: string | undefined,
  okurigana: string,
): ConjClass | undefined {
  return (
    classicalConjClass(okurigana, { lemma, reading }) ??
    // **Then the exact modern spelling, at any length.** `classicalConjClass`
    // already asks this for a *one-kana* ending, where it is the defence
    // against its own 四段 guess; asked again here it reaches the endings that
    // function declines to read at all — the ones with a stem mora inside
    // them. 試's こころ + みる and 果's は + たす are both such pins in the
    // reader's own file, and both are a `VERB_LEXICON` sense's own modern
    // spelling, prefix and all (`modernOkurigana` writes み+る and た+す).
    // Nothing is claimed that the lexicon does not spell identically.
    attestedSenseByModernSpelling(lemma, reading, okurigana)?.conjClass ??
    // **And last, the word itself.** See `soleAttestedClass`.
    soleAttestedClass(lemma, reading)
  );
}

/** The paradigm this character's kun'yomi inflects by where the *word* settles
 * it and no ending could — the last thing `chosenConjClass` asks, and the only
 * one of its three that does not look at the stored ending at all.
 *
 * **This is what makes a pin that stores an already-inflected form inflect.**
 * The reader's own file has 覺 pinned `Reading=おぼ|Okurigana=ゆる`, and ゆる is
 * the 連体形 of ヤ行下二段 覚ゆ — a form, not a citation. Frozen, it printed
 * 覺おぼゆる in a clause whose 覺 is `root` with a `conj:coord` after it, where
 * the syntax wants the 連用中止法 and the same text unpinned derives exactly
 * that (覺おぼえ). No ending-shaped rule could see it: `classicalConjClass` has
 * no ゆ row (nor could it — the あ row it declines is declined precisely because
 * the surface cannot name the 行), and the modern spelling of that sense is
 * える, which ゆる is not. What does settle it is the character plus the stem the
 * reader chose: `LEXICON_SENSES` holds 覺's おぼ as 下二段ヤ行 and holds nothing
 * else under that reading.
 *
 * **The reader's choice is the reading, and the reading is kept.** What a pin
 * like this loses is only the frozen inflection, which is the whole of what was
 * asked for — and nothing in `misc` is rewritten, so the tree round-trips
 * through CoNLL-U byte for byte and a file opened by an older build behaves
 * exactly as it did. The stored ending is simply no longer the last word:
 * `pickedEnding` conjugates from the class and never reads it.
 *
 * **Exactly one class, and no prefix, and no fixed reading.** Each of the three
 * is a case where the answer would be wrong rather than merely absent:
 *
 *  - Two classes under one reading means the lexicon does not identify the
 *    word. 苦's くる is both シク活用 苦し and 四段マ行 苦しむ, and the reader's
 *    own 苦 pin (くる + しむ) names the second — but it names it in a division
 *    the lexicon does not share (its 四段マ行 sense carries no し prefix, so
 *    its modern spelling is む), and guessing between two paradigms on a stem
 *    they agree on is not a thing this file should do. It stays frozen.
 *  - A sense with an `okuriganaPrefix` states part of the *stem* in its
 *    ending, and a class returned bare would drop it: 果 read は + たす is
 *    四段サ行 with a た, and naming the class alone against a stored ending
 *    that is not the class's own 終止形 would print はす. Where such a pin does
 *    hold that 終止形, the arm above has already matched it and `attestedSense`
 *    recovers the prefix from the sense; where it holds anything else, nothing
 *    here can put the prefix back.
 *  - A `fixedReading` is a form that must not be conjugated at all — 曰's はく
 *    is an -aku nominalisation, and its sense carries 四段ハ行 beside it for the
 *    *other* use of the character. A pin of 曰 as い + はく would otherwise have
 *    started printing 曰いふ / 曰いひ, which is the one thing `fixedReading`
 *    exists to prevent.
 *
 * Silence everywhere else, which leaves such a pin exactly as frozen as it was
 * — the outcome to prefer over a confident wrong paradigm, and the same
 * discipline `chosenConjClass` above already states for its own derivation. */
function soleAttestedClass(lemma: string, reading: string | undefined): ConjClass | undefined {
  const senses = lexiconSensesByReading(lemma, reading);
  if (senses.some((sense) => sense.okuriganaPrefix !== undefined || sense.fixedReading !== undefined)) return undefined;
  const classes = new Set(senses.map((sense) => sense.conjClass).filter((c): c is ConjClass => c !== undefined));
  return classes.size === 1 ? [...classes][0] : undefined;
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
    // …except on a particle — see `chosenSpellsOutInProse`.
    ...(chosenSpellsOutInProse(token) ? { spellOutInProse: true } : {}),
  };
}

/** Whether a hand-picked reading is **written out in kana** rather than drawn
 * over the character it was picked on — `ResolvedReading.spellOutInProse` for
 * the pick path, decided here so the resolver and both panels' picked branches
 * cannot come to different answers about the same pin.
 *
 * A particle, and nothing else. That is not a fact about where the reading came
 * from — the split `spellOutInProse` exists to draw — but about the word: a
 * 書き下し文 writes 之 の, 也 なり, 者 もの, 而 て, and there is no particle it
 * writes as its kanji. Every particle the app resolves *unaided* already comes
 * back `spellOutInProse` (the whole `overrides.json` table, and
 * `zheParticleReading`'s topic は), and the pick was the one route past it: the
 * reader pinning `Reading=もの` on the 者 of 孝弟也者 — a correction *towards*
 * the received reading — printed 孝弟也**者**, where the same 者 unpinned
 * printed もの. A pick must never be worse than no pick.
 *
 * POS and not lemma, so it holds for any particle the reader touches. It says
 * nothing about the other function-word tags (ADP, CCONJ, SCONJ): those are
 * `overrides.json`'s business and it already marks them, and 而 never reaches
 * here at all — `teOrShite` owns it in both panels.
 *
 * **A 接尾辞 is not one, and that exclusion is the whole of the bound.** Over
 * `lzh_kyoto-sud-{train,dev,test}.relabeled_ext.udep_ruled.punct.rulemerged.adjfix.conllu`
 * a PART carries one of five xpos values — 句末 12,966, 提示 5,352, 接続体言化
 * 1,900, 句頭 801, and **接尾辞 364**. The first four are particles standing as
 * words. The fifth is not a word at all: it is the second half of one, the 然 of
 * 愕然 and the タリ binoms `tariSuffixReading` reads, and a jukugo keeps its
 * kanji however either half is pinned — 帝愕然たり, never 帝愕ぜんたり. The same
 * fact that function states as "the suffix tag is the parser saying it is not
 * standing as one". */
export function chosenSpellsOutInProse(token: Pick<Token, "pos" | "xpos">): boolean {
  return token.pos === "PART" && !token.xpos.startsWith(SUFFIX_XPOS);
}

/** `p,接尾辞` — the treebank's tag for a character that is the second half of a
 * word rather than a word. See `chosenSpellsOutInProse`. */
const SUFFIX_XPOS = "p,接尾辞";

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
