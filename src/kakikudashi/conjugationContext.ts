import { type Sentence, type Token, isContentPredicatePos } from "../parse/types.ts";
import type { ReadingPlan } from "../kundoku/types.ts";
import { conjugate, shuushiConnectiveForm, type ConjForm, type ConjClass } from "./classicalConjugation.ts";
import {
  AUXILIARY_LEMMAS,
  CAUSATIVE,
  COPULA,
  CONVERB,
  endingForMorph,
  EXISTENCE,
  isDescriptiveToken,
  NEGATION,
  PASSIVE_RU,
  PASSIVE_RARU,
  parseMorphFeatures,
  renyoukeiEndsInISound,
  genuineQuestionParticle,
  postposedTopicParticle,
  sentenceFinalParticle,
  SENTENCE_FINAL_PARTICLE_LEMMAS,
  SENTENCE_FINAL_WORD_LEMMAS,
  type ConjugatedForm,
  ZU,
} from "./bungoConjugation.ts";
import {
  attestedSenseByModernSpelling,
  lexiconSensesByReading,
  VERB_LEXICON,
  type LexiconEntry,
} from "./verbLexicon.ts";
import { COMMAS, FULL_STOPS, isBracket, isOpeningBracket, isPunctuationMark } from "../parse/punctuation.ts";
// One-way in the type graph, two-way at module level: `depClassification.ts`
// already imports `isNegationUse` and `CAUSATIVE_LEMMAS` from here. Both
// directions are consumed only from inside function bodies (never at
// module-evaluation time), so the cycle resolves the way ESM cycles between
// pure-function modules do.
import {
  auxiliaryComplementNegated,
  classifyToken,
  isDistributivePostpose,
  isPredicateNegationPostpose,
  isGenitiveComplement,
  isIkanIdiom,
  ganReadsAsAdverb,
  parataxisYueOf,
  isNegatedBareReport,
  isSpeechQuoteComplement,
  isClausalComplementAcrossPause,
} from "../kundoku/depClassification.ts";
import { isRereadUse, rereadCharacter, rereadCloseId, rereadGovernedForm, rereadNegates } from "./rereadCharacters.ts";
// One-way in both graphs: nothing in `reading/jmdictLookup.ts` imports back
// from this file. Read by `descriptiveRedupSpan`, which has to answer about a
// span and not about a token; `carrierOf` comes along for the same reason.
import { findCompoundSpans, type CompoundSpan } from "../reading/jmdictLookup.ts";
import { carrierOf } from "../kundoku/spanCarrier.ts";
// The second module-level cycle, and safe on the same terms as the
// `depClassification.ts` one at the top of these imports:
// `renyouTe.ts` imports this file's `decideConjForm`/`converbSuffix` and this
// file reads its switch state, both from inside function bodies only. The switch
// is needed here because the negation piece is written by `negationEnding` and
// by nothing else — neither panel assembles it — so a connective after a
// negation's 連用形 has nowhere else to be written. See `NEGATION_CONVERB`.
//
// The edge going that way is one call site narrower than it was:
// `pickedRenyouTe` used to re-derive the form `pickedEnding` had conjugated
// with, and `pickedEnding` reports it now (see `PickedEnding`). Only the fused
// サ変 span still re-derives, for the reason `compoundSuruOkurigana` gives.
import { renyouTeOn } from "./renyouTe.ts";
import { chosenAuxiliary, chosenReadingParts, chosenReadingText, chosenTopicParticle, isBareChosenReading, storedReadingText } from "../reading/chosenReading.ts";
// One-way, and the module it reaches is a leaf: `overridesLookup.ts` imports
// nothing but the JSON table. Read by `ownReadingSuppliesCaseParticle`, which
// has to know what okurigana a curated reading has already written before this
// file writes a particle after it.
import { findOverride } from "../reading/overridesLookup.ts";
import type { ReadingResolver } from "../reading/types.ts";
// The third module-level cycle, and safe on the same terms as the
// `depClassification.ts` and `renyouTe.ts` ones above: `readingResolver.ts`
// imports this file's `decideConjForm`/`converbSuffix`/`syntheticLexiconEntry`
// and this file calls back into it from inside one function body only. Read by
// `precedingFormSuppliesShite`, whose span arm has to ask the *same* question
// `generateKakikudashiPieces` asks first, and in the same order — see that
// function's span arm for why a restatement of the test would not do.
import { compoundSuruOkurigana } from "../reading/readingResolver.ts";

/** POS tags that need an inserted copula when a sentence's root has no
 * explicit copula/auxiliary token — Literary Chinese routinely has bare NP
 * predicates (e.g. 君子 for "[it] is a gentleman") with no token realizing
 * the "is". Shared so the kundoku panel can show the same synthesized なり
 * the kakikudashi generator inserts, even though it has no source token. */
export const NOMINAL_PREDICATE_POS = new Set(["NOUN", "PROPN", "PRON"]);

/** POS tags whose being a clause's head makes that clause nominal. A
 * particle heading a clause is doing no predicating of its own — 者 marks
 * its topic and 也 its assertion — so whatever nominal hangs off it is the
 * predicate, and takes なり. See `extraEndingFor`. */
const PARTICLE_HEAD_POS = new Set(["PART"]);

/** **者 as a nominal** — the headless relative, もの, which this treebank tags
 * `PART`/`p,助詞,提示,*` and which `NOMINAL_PREDICATE_POS` therefore misses.
 *
 * What 者 does is turn the clause in front of it into a noun phrase, so in a
 * slot that wants a person or a thing it is one: 天を談ずる**者** is "those who
 * discourse on the heavens". Written here rather than folded into
 * `NOMINAL_PREDICATE_POS`, because that set is read by branches (the
 * synthesized なり, the 非 rule) where a 者 is the *frame* and not the nominal,
 * and widening it would answer a different question in each of them. The one
 * caller is the causee's をして — see `caseParticleFor`, which carries the count.
 *
 * Keyed on the lemma and not on the xpos: 也 shares `p,助詞,提示,*` and is a
 * sentence particle, not a nominalizer. */
function isNominalizingZhe(token: Token): boolean {
  return token.pos === "PART" && token.lemma === "者";
}

/** A 者 that is the **causee** rather than the nominalizer of the whole
 * causative clause — the one made to act, and so the one that takes をして.
 *
 * `isNominalizingZhe` says the word is a nominal. Which nominal it is, in a
 * sentence that has a causative in it, is a question of order: **a causee
 * stands before the act** — 使民戰 puts 民 in front of 戰, and 使談天者無所取則
 * puts 者 in front of 無. A 者 standing *after* the act is nominalizing the
 * causative clause itself — 能使敵人自至**者** is 能く敵人をして自ら至らしむる
 * **は**, "the making of the enemy come of himself" — and the causee there is
 * 敵人, which already has its をして. Marked as a causee as well it came out
 * 敵人をして自ら至ら者をしてしむ, two causee markers on one predication.
 *
 * Measured against the received readings: over kanbun.info the unbounded 者 arm
 * moved 9 passages for −13 edits and **3** of the 9 were this shape —
 * 能使敵人自至者 (+2), 能治者 in 下民其憂、有能治者 (+1), 直使甲冑生蟣蝨者 (+1).
 * All three have the 者 last in its clause; every one of the six it helps has
 * the 者 in front of the act.
 *
 * The act is read off the tree rather than named: a verbal sibling under the
 * same causative, standing after this 者. `readsAsCausative` has already
 * established that there is one — this only asks which side of it the 者 is
 * on. Scoped to the 者 arm, where the shape arises, and not put on the NOUN
 * arm beside it: that arm's reach is measured as it stands, and a name or a
 * pronoun is never the nominalizer of the clause it stands in. */
function isCauseeZhe(token: Token, governor: Token, sentence: Sentence): boolean {
  if (!isNominalizingZhe(token)) return false;
  return sentence.tokens.some(
    (t) =>
      t.head === governor.id &&
      t.id !== governor.id &&
      t.id > token.id &&
      (isContentPredicatePos(t.pos) || t.pos === "AUX"),
  );
}

export function findRoot(sentence: Sentence): Token | undefined {
  return sentence.tokens.find((t) => t.dep === "ROOT" || t.head === t.id);
}

/** Whether the token governs a direct object — the syntactic fact that
 * decides between a character's transitive and intransitive kun'yomi (立太子
 * "install a crown prince" has 子 as 立's `comp:obj` and reads 立てる; 三十而立
 * "at thirty I stood on my own" has none and reads 立つ).
 *
 * Read off the tree rather than off the token's own features, because that
 * is where it lives: SUD marks the *dependent* as the object, so a verb has
 * no feature of its own saying it took one. `comp:obj@` subtypes are
 * included — the relation is still an object relation whatever the parser
 * qualifies it with — and a preposed object counts exactly as a postposed
 * one does (何如's 何 is `comp:obj` of 如 despite standing before it), since
 * the question here is whether the verb has an object at all, not where in
 * the line it sits.
 *
 * **Lives here rather than in `readingResolver.ts`, where it was written**,
 * because a second rule now asks it: `pinnedKeiyoudoushi` below refuses a
 * 形容動詞 paradigm to a descriptive that governs an object, on exactly the
 * evidence the resolver's own transitivity check runs on (see `adjectivalSense`
 * there — an object overrides the adjectival reading, "because it is evidence
 * about the same thing"). One predicate, so the reading a resolver picks and
 * the paradigm a pick inflects by cannot come to disagree about whether the
 * word is being used transitively. That file imports it from here, an edge it
 * already carries a dozen names over. */
export function hasObject(token: Token, sentence: { tokens: Token[] }): boolean {
  return sentence.tokens.some(
    (t) => t.head === token.id && t.id !== token.id && (t.dep === "comp:obj" || t.dep.startsWith("comp:obj@")),
  );
}

/** Pre-verbal negation adverbs — `reorderEngine.ts`'s `classifyToken`
 * already postposes these past their verb (不知 -> 知らず, not ずしら). Both
 * the kundoku panel (`KundokuView.ts`) and the kakikudashibun generator
 * need to recognize the same tokens as negation triggers, hence shared
 * here rather than duplicated. */
export const NEGATION_LEMMAS = new Set(["不", "未", "弗", "勿"]);

/** Whether a token is being *used* as a negation — one of those lemmas, in
 * the pre-verbal modifying relation, and not overridden by hand.
 *
 * A reading picked out of the readings menu takes the character out of the
 * class, exactly as it takes a 再読文字 out of its construction (see
 * `isRereadUse`, which settles the same question for the same reason).
 * Choosing ひつじ for 未 says this one is the earthly branch, not "not yet",
 * and nothing around it should go on negating: without this the character
 * stopped *reading* as a negation while everything that conjugates against
 * one carried on regardless, leaving 未學禮 as 未禮を學ば — a 未然形 with
 * nothing left to attach to it.
 *
 * Any stored reading counts. The menu's own 再読 entry stores nothing (it is
 * the default, and defaults are not stored), so choosing it leaves the
 * construction exactly as it was. */
export function isNegationUse(token: Pick<Token, "lemma" | "dep" | "misc">): boolean {
  return NEGATION_LEMMAS.has(token.lemma) && token.dep === "mod" && chosenReadingText(token) === undefined;
}

/** 非/匪 — the negation that denies a *predicate nominal* rather than suffixing
 * ず onto a verb, and which is why it is not in `NEGATION_LEMMAS` above.
 * 非劉之病 is 劉の病に**あらず**: あり negated, with the nominal standing in
 * front of it as the complement of a copula, which in classical Japanese is
 * marked **に**.
 *
 * **The treebank names the class in the tag, so this is not a lemma guess.**
 * Over `lzh-{train,dev,test}.sud.conllu` (137,786 sentences) 非/匪 is 1,736
 * tokens, and the split is not close:
 *
 * | UPOS |  n   | XPOS                    | what it is                 |
 * |------|------|-------------------------|----------------------------|
 * | ADV  | 1576 | `v,副詞,否定,体言否定` 1572 | あらず — the negation      |
 * | NOUN |   92 | `n,名詞,描写,態度` 90      | 非, "a fault, a wrong"     |
 * | VERB |   64 | `v,動詞,行為,交流` 58      | 非る, "to blame"           |
 * | PROPN|    4 | `n,名詞,人,名`            | a name                     |
 *
 * **体言否定 — "nominal-predicate negation" — is the treebank's own name for
 * exactly this rule.** 1,584 of the 1,736 carry `mod`, which is how the adverb
 * attaches to the predicate it denies.
 *
 * The lemma *and* the tag, on the discipline `isInterrogativeSpeechVerb` and
 * `isComparativeYu` already follow: the lemma names the class, the xpos
 * confirms the character is being used as that word rather than as the noun or
 * the verb it can also be. A tree with no xpos at all falls back to the UPOS,
 * as `isVerbalXpos` does, so a hand-written tree behaves as it did before. */
const NOMINAL_NEGATION_LEMMAS: ReadonlySet<string> = new Set(["非", "匪"]);

/** The treebank's tag for 非 used as the nominal-predicate negation. See
 * `NOMINAL_NEGATION_LEMMAS`. */
const NOMINAL_NEGATION_XPOS = "v,副詞,否定,体言否定";

/** Whether this token is 非/匪 *being used as* the あらず negation. See
 * `NOMINAL_NEGATION_LEMMAS` for the survey and for why both halves are asked.
 *
 * Exported because the reading of 非 and its reading-order position are two
 * other modules' questions about the same word, and all of them have to agree
 * about which occurrences of the character are the negation at all — the same
 * arrangement `isNegationUse` and `isSentenceFinalParticleUse` are in. */
export function isNominalNegationUse(token: Token): boolean {
  if (!NOMINAL_NEGATION_LEMMAS.has(token.lemma)) return false;
  if (token.xpos) return token.xpos.startsWith(NOMINAL_NEGATION_XPOS);
  return token.pos === "ADV";
}

/** に — what the predicate a 非 denies is marked with. See `negatedPredicate`. */
const NOMINAL_NEGATION_PARTICLE = "に";

/** True when a 非 hangs off this token to deny it — 病 in 非劉之病, which
 * therefore reads 劉の病**に**あらず.
 *
 * **The head of the 非, not the token before it.** 非 is written first and
 * read last, so the character it denies is not adjacent to it in reading
 * order; what says which predicate is being denied is the edge, which this
 * parser draws as a `mod` from the 非 onto its predicate (1,584 of 1,736).
 *
 * **Both kinds of head, and they take different routes to the same に.** 非's
 * governor is a NOUN 732 times, a VERB 650, a PART (者/所) 156 and an AUX 66,
 * so the verbal case is very nearly as common as the nominal one and both are
 * the same construction — 〜にあらず, a copula complement standing in front of
 * あり negated:
 *
 *  - **A nominal head takes に and *loses its copula*.** 非劉之病。 is
 *    劉の病にあらず, never 劉の病になりあらず. The copula is not an extra ending
 *    that composes with this — it *is* the predicate, and あらず is already
 *    supplying it. See `extraEndingFor`, which asks this predicate.
 *  - **A verbal head takes に on a 連体形.** 非惡其聲而然也 is
 *    其の聲を惡みて然る**に**非ざるなり, and 非道弘人 is 道人を弘むるにあらず.
 *    Nothing is suppressed there, because a verb has no synthesized copula to
 *    suppress. `decideConjForm` writes the form off this same predicate, so
 *    the form and the particle cannot come apart — the arrangement
 *    `isNominalizedObliquePredicate` and `isConditionalTemporalClause` are
 *    both in.
 *
 * One predicate for both, deliberately: what makes the に right is the 非, and
 * that is one fact about one edge. What differs is only what each *kind* of
 * head then needs beside the に, which is asked at the two branches that need
 * it (`extraEndingFor` for the copula, `decideConjForm` for the form) rather
 * than by splitting this in two. */
function negatedPredicate(token: Token, sentence: Sentence): boolean {
  return sentence.tokens.some(
    (t) => t.head === token.id && t.id !== token.id && t.dep === "mod" && isNominalNegationUse(t),
  );
}

/** The nominal half of `negatedPredicate` — a NOUN/PROPN/PRON predicate a 非
 * denies, which must *not* also be given a synthesized copula. See
 * `extraEndingFor`. */
function negatedNominalPredicate(token: Token, sentence: Sentence): boolean {
  return NOMINAL_PREDICATE_POS.has(token.pos) && negatedPredicate(token, sentence);
}

/** True when a **suffixal** negation — 不/未/弗/勿, `isNegationUse`, never the
 * 非 of `negatedPredicate` above — hangs off this token, so a ず is going to be
 * written onto it whatever else is decided about it.
 *
 * The same fact `isPredicationLicensed` reads off the root's own children, asked
 * of any token: a suffix has to have something to inflect. It is asked here by
 * the case-particle guard in `extraEndingFor`, which otherwise stands the copula
 * down under a negation and leaves the ず glued straight onto a bare noun. */
function suffixNegated(token: Token, sentence: Sentence): boolean {
  return negationClosing(token, sentence) !== undefined;
}

/** Nominalizing particles (者/所, tagged PART rather than NOUN/PROPN by this
 * treebank) — grammatically equivalent to a following noun for rentaikei
 * purposes: 不復挺者 ("the thing that doesn't straighten back out") needs
 * 挺かざる者 exactly the same way 不知人 needs 知らざる人, even though 者 itself
 * isn't POS-tagged as a noun. */
const NOMINALIZING_LEMMAS = new Set(["者", "所"]);

/** ず (終止形) against the 連体形 **ざる** — the attributive a negation takes
 * where the negated predicate modifies a following noun (知らざる人, "a person
 * who doesn't know") or nominalizer (挺かざる者, see `NOMINALIZING_LEMMAS`),
 * which in reading order means the very next meaningful token is that
 * noun/nominalizer. `nextToken` is whatever `nextMeaningfulTokenInClause`
 * finds after the negation piece itself. */
export function negationForm(nextToken: Token | undefined, governedForm?: ConjForm | null): string {
  // A 再読文字 closing here dictates the form outright, and wants the
  // ざり-paradigm rentaikei rather than ぬ: 猶…がごとし reads 及ばざるが
  // ごとし, never 及ばぬがごとし.
  if (governedForm === "rentai") return NEGATION.rentaiZari!;
  // A conditional protasis dictates the form the same way, and wants the
  // ざり-paradigm 已然形: 學而不思則罔 reads 學びて思はざれば則ち罔し. Beside the
  // 連体形 arm above rather than below the noun/particle heuristics, because
  // like it this is the governing construction *telling* the negation what to
  // be, not the negation inferring it from what follows. `negationEnding`
  // supplies it, and writes the ば itself. See `isConditionalTemporalClause`.
  if (governedForm === "izen") return NEGATION.izen!;
  // And a 使役 or 受身 auxiliary dictates it the same way, and wants the
  // ざり-paradigm 未然形: 使民不飢 reads 民をして飢ゑざらしむ, never 飢ゑずしむ.
  // Beside the two arms above rather than below the noun/particle heuristics,
  // for their reason — this is the governing construction *telling* the
  // negation what to be. `negationEndingParts`' `caused` arm supplies it, and
  // writes no particle after it; the しむ itself is a separate token both
  // panels already print.
  //
  // ざら and not ず, though `ZU` does have a 未然形 slot. That slot is the
  // fossilised ずは/ずば and nothing else: a 助動詞 attaching after a negation
  // is precisely what ず could not carry and what ず+あり was contracted to
  // carry, which is the line this function draws for ざる, ざれ and now ざら
  // alike. See `ZARI`.
  if (governedForm === "mizen") return NEGATION.mizenZari!;
  // And a 連用形, for a negated clause that hands on to the next instead of
  // closing — 連用中止法, which is what a non-final link in a coordination chain
  // does. 不飲不食 is 飲まず食はず. `negationEnding` supplies it; see the
  // `chaining` arm there for how the chain is found.
  //
  // **ず and not ざり, and this is the third time this file draws the same
  // line.** Both paradigms have a 連用形 (see `ZU` and `ZARI`), exactly as both
  // have a 連体形 (ぬ/ざる) and both a 已然形 (ね/ざれ). What separates them
  // every time is whether something attaches after the negation: the ざり series
  // exists *because* ず could carry nothing, so ざる takes the なり and the のみ
  // and the に, ざれ takes the ば — and a bare 連用中止法 takes nothing at all,
  // which is precisely the case ず still covers. 飲まざり食はず is not what
  // kundoku writes.
  //
  // ざり is therefore in the table and is not reached from here. What would
  // reach it is a 連用形-attaching 助動詞 standing after the negation — ざりき,
  // ざりけり, ざりつ — and this app renders none: the only 助動詞 it writes after
  // a predicate are べし, まほし, しむ, る/らる and the copula, all of which take
  // 未然形 or a nominal, plus 焉's 完了 り, which attaches to a 四段 已然形 and
  // never to a negation. So the slot is filled and the branch that would select
  // it is not written, rather than a branch being written that nothing can
  // reach — the same discipline `BINDING_PARTICLE_READINGS` states for こそ.
  if (governedForm === "renyou") return NEGATION.primary;
  // An assertive 也 closing the sentence wants one too. 也 reads なり — the
  // 断定 auxiliary — and an auxiliary attaches to a 連体形, so 不以飲為累也
  // was ending 累と為せず + なり where kundoku reads 累と為せざるなり.
  //
  // ざる and not ぬ, which is the other 連体形 ず has: the ざり paradigm exists
  // precisely because ず could not carry a following auxiliary and had to be
  // rebuilt as ず+あり to do it. So a further auxiliary takes ざる —
  // 及ばざるがごとし already in this function, and 知らざるなり here. (A noun
  // takes ざる as well, in the 訓読 register this app writes; see the
  // `modifiesNominal` arm below for the count.)
  //
  // Keyed on the particle *reading* なり rather than on the lemma 也, since
  // that is the fact the rule turns on, and read from the one table that
  // decides it (`sentenceFinalParticle`) so this cannot drift from what the
  // discourse branch actually emits. 矣 is unread and 乎 is や, neither of which
  // pulls a 連体形; 哉's かな does, and has its own arm below.
  if (nextToken && sentenceFinalParticle(nextToken.lemma) === "なり") return NEGATION.rentaiZari!;
  // An exclamatory 哉/夫 wants one too, and for the third time in the same
  // shape: it reads かな, a 終助詞 whose 接続 is 体言・連体形, so what stands in
  // front of it is attributive. 未見其人哉 is いまだ其の人を見**ざる**かな.
  //
  // ざる and not ぬ, for the reason given at the なり arm above: a particle
  // carried on the finished negation is exactly what ず could not carry and
  // the ざり paradigm was rebuilt to carry.
  //
  // Keyed on the reading through `sentenceFinalParticle`, as its two neighbours
  // are. See `EXCLAMATORY_PARTICLE_READINGS`, which is this rule's positive half
  // — the 連体形 an *un*negated predicate takes in front of the same particle.
  if (nextToken && sentenceFinalParticle(nextToken.lemma) === EXCLAMATORY_PARTICLE_READING) {
    return NEGATION.rentaiZari!;
  }
  // A 限定 耳 closing the sentence wants one as well, for the same reason in a
  // different grammatical class: it reads のみ, a 副助詞, and a 副助詞 attaches
  // to a 連体形. 不知之耳 was ending これを知らず + のみ where kundoku reads
  // これを知らざるのみ (孟子's 直不百步耳 — 直だ百歩ならざるのみ).
  //
  // ざる and not ぬ, for the same reason: nothing is being modified, the
  // particle is attaching onto the finished negative predicate, and carrying
  // something further is precisely what ず could not do and the ざり paradigm
  // was rebuilt to do.
  //
  // Keyed on the *reading* のみ and read from `sentenceFinalParticle`, exactly
  // as the なり line above is, so this cannot disagree with what the discourse
  // branch in either panel actually prints. See `isLimitingParticleAhead`,
  // which is this rule's positive half — the 連体形 an *un*negated predicate
  // takes in front of the same particle.
  if (nextToken && sentenceFinalParticle(nextToken.lemma) === LIMITING_PARTICLE_READING) return NEGATION.rentaiZari!;
  // And a following noun or nominalizer wants one, which is the attributive
  // proper: 不仁者 is 仁ならざる者, 無不避之者 之を避けざる者無し.
  //
  // **ざる here too, and not the ず-series 連体形 ぬ.** This arm once wrote ぬ,
  // on the argument that ぬ is the plain attributive and ざる the form that
  // carries something further — and the argument is sound 和文 grammar, which
  // is not what this app writes. 漢文訓読 reads the attributive of ず as ざる
  // wherever it reads one: kanbun.info's received 書き下し文 contain **704**
  // attributive ざる and **not one** attributive ぬ, before a noun, a 者 or
  // anything else. So ぬ stays in `ZU` as the grammatical fact it is, and
  // nothing in this app selects it; every 連体形 a negation takes comes out of
  // the ざり series, and the arms above differ only in *why* the clause is
  // attributive, not in what they write.
  const modifiesNominal =
    !!nextToken && (nextToken.pos === "NOUN" || nextToken.pos === "PROPN" || NOMINALIZING_LEMMAS.has(nextToken.lemma));
  return modifiesNominal ? NEGATION.rentaiZari! : NEGATION.primary;
}

/** `AUXILIARY_LEMMAS` asked of a token instead of of a bare lemma: the
 * auxiliary this token renders as, or undefined where the character is not
 * being used as one.
 *
 * Four of that table's entries — 須/當/応/應 — are 再読文字, and the table is
 * keyed on the lemma alone, so it answered べし for every occurrence of the
 * character whatever stood around it. That is the second half of a
 * construction, and it was being written where the first half had not been:
 * 須學 reads すべからく學ぶべし and is right, because 學 is the predicate 須
 * enjoins, but 不須 came out べからず and 須 alone べし, a "must" with nothing
 * it must. The re-read branch above this one in both panels had already
 * declined those (no governed predicate — see `isRereadUse`); they fell
 * through to here, which asked a question that could not tell them apart.
 *
 * So the gate is the same predicate the branch above spends, and this is why
 * it has to be: a 再読文字 that `isRereadUse` has declined is a character
 * being used in its own right, and must take the ordinary lookup like any
 * other — 須 as the verb もちゐる, 當 as あたる. `isRereadUse` is also what the
 * reading order consults, so the order, the 訓読文 and the 書き下し文 all turn
 * on one answer rather than three.
 *
 * 可/能/欲 and the four causatives are untouched: none is read twice, and
 * their entries mean what they always did.
 *
 * …and one 再読文字 *is* an auxiliary here after all, on the reader's own say-so.
 * `chosenAuxiliary` is the reader having picked べし off 須's menu, which is a
 * choice between the character's two constructions and not a reading to be
 * drawn: it says this 須 is the plain auxiliary, 酒を飲むべし, and not the double
 * reading すべからく酒を飲むべし. `isRereadUse` has already declined the
 * construction on the strength of that same choice (it consults what is
 * stored), so without this line the character fell past both branches and was
 * read as the verb もちゐる — a reading the reader had just declined to pick.
 * The gate above still stands for every *other* choice: a 須 picked もちヰル is
 * a character being used in its own right and takes the ordinary lookup. */
/** **The two characters in `AUXILIARY_LEMMAS` whose entry exists for the pin
 * alone** — the auxiliary is honoured where the reader has picked it off the
 * menu and nowhere else, because in ordinary use the character is a word of its
 * own and not the ending that table gives it.
 *
 *  - **能** (べし). The character's own two words are the adverb 能く and the
 *    verb 能はず, neither of which is べし. `positiveNengReading` and
 *    `isNegatedNengComplement` are the two arms, and each stands down on a
 *    pinned reading exactly as this admits one, so the three cannot disagree
 *    about which 能 this is. `isAuxiliaryRootForTopic` is the fourth place the
 *    same question is asked, for the subject's は.
 *  - **欲** (まほし). The received text reads 欲 as the verb 欲す, and the
 *    evidence is one-sided: kanbun.info's ruby is **ほっ 180 against よく 16**,
 *    `tests/keptCharacters.test.ts` already carries the okurigana counts
 *    (欲する 7, 欲す 6, 欲すれば 6, of 40), and the site's 書き下し文 writes 欲
 *    198 times of which **122 stand after んと** — the quoted volition
 *    …んと欲す — and not one of which is まほし. This app wrote まほし for all
 *    198: the character was dropped and the ending written after the predicate
 *    it governs, so 吾不欲觀之矣 came out 吾之を觀る**まほし**ず against a
 *    received 吾之を観るを欲せず.
 *
 * **Why this and not deletion.** Taking 欲 out of `AUXILIARY_LEMMAS` outright
 * removes まほし from the app entirely — 欲 is that table's only `DESIDERATIVE`
 * and the furigana menu offers the ending from there — so a reader who wants
 * the desiderative reading of a particular 欲 would have no way back to it. The
 * entry stays; what changes is that it is honoured only when chosen, which is
 * exactly the arrangement 能 has had since its own note was written.
 *
 * **Measured on this branch, every stage in one process** over kanbun.info's
 * 3,419 passages, each stage against the one above it and the first against the
 * branch as found (gold 10,350 / parser 66,666):
 *
 * | stage                                   | gold | parser | closer | further |
 * |-----------------------------------------|------|--------|--------|---------|
 * | 欲 stands down from `AUXILIARY_LEMMAS`  |  −50 |   −211 |    131 |       4 |
 * | …and takes no topic は as a root        |   −2 |     −9 |     16 |       4 |
 * | …and its complement takes 未然形 + んと |  −44 |   −125 |     74 |      30 |
 * | …and a negation inside it takes ざらんと |    0 |      0 |      0 |       0 |
 *
 * The fourth row is not an error: the shape it answers — a negation standing
 * *inside* a 欲 complement, 渾欲不勝簪 — does not occur in that corpus at all,
 * and it is in for the poem and for the consistency of the construction (see
 * `isVolitionalComplement`'s own note on the skip it takes).
 *
 * The first of those is this line and the `verbLexicon.ts` entry it lets
 * through; the second is `isAuxiliaryRootForTopic` below; the third is
 * `isDesiderativeComplement`. Together: **gold −96, parser −345**, 10,350 →
 * 10,254 and 66,666 → 66,321. On the gold tier — where a bad parse is no excuse
 * — exactly **three** passages read further than before: 論語 14.2 under the
 * first stage, and 論語 7.29 (我欲仁, whose 仁 this parse tags a predicate, so
 * the んと lands on 仁ならん where the received text has the noun 仁を) and
 * 論語 12.19 under the third.
 *
 * Keyed on the lemma, like the table it qualifies. */
const PINNED_ONLY_AUXILIARY_LEMMAS: ReadonlySet<string> = new Set(["能", "欲"]);

/** `PINNED_ONLY_AUXILIARY_LEMMAS` asked of a token. */
function isPinnedOnlyAuxiliary(token: Token): boolean {
  return PINNED_ONLY_AUXILIARY_LEMMAS.has(token.lemma);
}

export function auxiliaryFormFor(token: Token, sentence: Sentence): ConjugatedForm | undefined {
  // A **pinned copula** first, and it has to be first: it is keyed on the
  // stored reading rather than on the lemma (see `chosenAuxiliary`), so the
  // table below cannot find it — 也 and 爲 are in no auxiliary table and the
  // reader has said each of them is the 断定の助動詞 here. Everything downstream
  // is the eleven auxiliaries' own path: the kanji is dropped and
  // `selectedForm` inflects the form from context.
  const pinnedCopula = chosenAuxiliary(token);
  if (pinnedCopula === COPULA) return pinnedCopula;
  const aux = AUXILIARY_LEMMAS[token.lemma];
  if (!aux) return undefined;
  // **能 and 欲 are auxiliaries only where the reader says so**, and their
  // entries in that table are kept for the pin alone — see
  // `PINNED_ONLY_AUXILIARY_LEMMAS`, which holds the argument and the counts for
  // both.
  if (isPinnedOnlyAuxiliary(token) && chosenAuxiliary(token) !== aux) return undefined;
  // Both spellings consulted — the table is keyed on the lemma and the
  // 再読文字 table on the written form, and the parser lemmatizes 当 to 當.
  const reread = rereadCharacter(token.text) ?? rereadCharacter(token.lemma);
  if (reread && !isRereadUse(token, sentence) && !chosenAuxiliary(token)) return undefined;
  // **A 使役 auxiliary with nothing to cause is not one**, and the same test
  // stands the をして down beside it — see `readsAsCausative`.
  if (aux === CAUSATIVE && !readsAsCausative(token, sentence)) return undefined;
  return aux;
}

/* Focus, and why 限定 (唯/惟/但/獨 …のみ) is still absent.
 *
 * An earlier note here said the corpus does not record focus. That was too
 * strong, and the literature says why. Focus in Classical Chinese is marked
 * *structurally*, not morphologically: the focused complement is preposed
 * before the verb and picked up by a resumptive 之 or 是, optionally with a
 * focus-sensitive particle (唯/惟/非/其/必/將/固) to its left. Hahn (2011)
 * calls this the dependent marking construction; the Chinese literature
 * treats it as 賓語前置 with 「唯＋賓語＋是＋謂語」 as its exclusive-focus
 * subtype; Japanese kanbun pedagogy teaches it as 目的語前置, reading the
 * resumptive as これ. The particle marks where the focus domain begins and
 * the resumptive marks where it ends.
 *
 * That construction *is* in the treebank, as `comp@expl`: 384 occurrences
 * across the 433,169-token SUD Kyoto corpus, filled by 之 (327), 是 (47)
 * and a tail of 斯/此/伊, and attached to a predicate in every single one.
 * So a resumptive is reliably detectable, and our own parser reproduces it
 * (唯利是視 comes back with 是 as PRON/comp@expl).
 *
 * What remains unsafe is the step from there to のみ:
 *
 *  - The preposed element is tagged `subj`, not an object relation, and is
 *    identifiable as the focused constituent only by sitting between the
 *    particle and the resumptive. That pairing holds in 202 of the 384
 *    (53%); in 179 there is no `subj` sibling at all.
 *  - 唯/惟/維 with a resumptive — the exclusive-focus subtype, the one that
 *    actually calls for のみ — occurs 11 times in the whole corpus, and its
 *    resumptive is tagged three different ways across those 11. Too rare
 *    for the parser to have learned, and too rare to verify a rule against.
 *
 * The generally useful finding is the other one: a predicate with a
 * `comp@expl` child has a preposed complement, which kanbun reads with を
 * and a これ on the resumptive — 唯利是視 as 唯だ利を是れ視る, where this app
 * currently gives 利く. That is worth doing, and does not depend on
 * resolving focus scope at all. */

/** The resumptive of a preposed complement — 之 or 是 picking up a
 * complement moved in front of its verb. SUD files these under `comp@expl`;
 * see the note above for the corpus counts. */
export function resumptiveOf(verb: Token, sentence: Sentence): Token | null {
  return sentence.tokens.find((t) => t.head === verb.id && t.id !== verb.id && t.dep.startsWith("comp@expl")) ?? null;
}

/** Relations the preposed complement itself can carry.
 *
 * `subj` is what the treebank actually uses — it analyses the preposed
 * element in subject position — while `comp:obj` is what the relation
 * *is*, and so what someone correcting the parse by hand would set. Both
 * are accepted, because the label is not the evidence here: the evidence is
 * that the element is a child of the same predicate and stands immediately
 * before the resumptive that picks it up. Keying on `subj` alone would make
 * the reading get *worse* the moment a user fixed the tree. */
const PREPOSED_DEPS: ReadonlySet<string> = new Set(["subj", "comp:obj", "comp:obl", "comp:pred"]);

/** The complement a predicate carries in front of itself, resumed by 之/是
 * — 唯利是視, where 利 is the object of 視 despite standing before it.
 * Kanbun marks it を and reads the resumptive これ, so it must be told apart
 * from the ordinary subject it is tagged as.
 *
 * Identified by position: the predicate's own child sitting closest before
 * the resumptive. */
export function preposedComplement(verb: Token, sentence: Sentence): Token | null {
  const resumptive = resumptiveOf(verb, sentence);
  if (!resumptive) return null;
  const before = sentence.tokens.filter(
    (t) => t.head === verb.id && t.id !== verb.id && t.id < resumptive.id && PREPOSED_DEPS.has(t.dep),
  );
  return before.length > 0 ? before[before.length - 1] : null;
}

/** Whether this token is that complement. */
export function isPreposedComplement(token: Token, sentence: Sentence): boolean {
  const governor = sentence.tokens.find((t) => t.id === token.head && t.id !== token.id);
  return !!governor && preposedComplement(governor, sentence)?.id === token.id;
}

/** The exclusive-focus particles, restricted to the three the
 * 「唯＋賓語＋是＋謂語」 construction is actually named for.
 *
 * The wider class of 範圍副詞 (但/獨/只/徒/特/僅 …) limits in much the same
 * way, but it is this set that the literature documents standing at the
 * left edge of a resumptive-marked complement, and the rule below turns on
 * that pairing rather than on limiting sense alone. */
const EXCLUSIVE_FOCUS_LEMMAS: ReadonlySet<string> = new Set(["唯", "惟", "維"]);

/** A 唯/惟/維 modifying this predicate, or null.
 *
 * Only meaningful in combination with a resumptive — see
 * `caseParticleFor`, the one caller. */
export function exclusiveFocusOf(verb: Token, sentence: Sentence): Token | null {
  return (
    sentence.tokens.find(
      (t) =>
        t.head === verb.id &&
        t.id !== verb.id &&
        EXCLUSIVE_FOCUS_LEMMAS.has(t.lemma) &&
        (t.dep === "mod" || t.dep === "mod@tmod") &&
        t.pos === "ADV",
    ) ?? null
  );
}

/** 使役 governors, whose object is the *causee* — the one made to act —
 * rather than an ordinary object.
 *
 * **敎 stands beside 教, and it is the spelling the treebank actually uses.**
 * Counted over `lzh_kyoto-sud-{train,dev,test}` (86,239 sentences): the
 * character occurs 338 times, written 教 292 times and 敎 46 — and it is
 * lemmatized **敎 all 338 times, 教 none**. So a table keyed on 教 alone
 * matched no gold token at all, and every rule reached through this set (the
 * 未然形 a caused predicate takes, the をして its causee takes,
 * `depClassification.ts`'s `isCausedPredicateParataxis`, and
 * `AUXILIARY_LEMMAS`' しむ) stood down on the one spelling the parser writes.
 * Both are listed rather than one being normalized to the other, for the
 * reason `overrides.json` and `SENTENCE_FINAL_PARTICLES` list both spellings
 * of 歟/欤: nothing folds a lemma to a single form before these tables are
 * keyed by it, so a character written the other way would otherwise reach a
 * different answer from the identical character. */
export const CAUSATIVE_LEMMAS: ReadonlySet<string> = new Set(["使", "令", "教", "敎", "遣"]);

/** 受身 governors. 被 is unambiguous; 見 is overwhelmingly "to see" and is
 * only passive when the parser has tagged it AUX over a predicate, which
 * is what `passiveGovernor` checks — a bare lemma lookup here would turn
 * every 見 in every text into a passive. */
const PASSIVE_LEMMAS: ReadonlySet<string> = new Set(["被", "見"]);

/** The verb a passive auxiliary governs, or null. */
export function passiveComplement(token: Token, sentence: Sentence): Token | null {
  if (!PASSIVE_LEMMAS.has(token.lemma)) return null;
  if (token.lemma === "見" && token.pos !== "AUX") return null;
  // Either relation: the parser gives 見 its verb as `comp:obj` and 被 its
  // verb as `comp:aux` (both measured), for the same construction.
  //
  // ADJ beside VERB, for the reason `isContentPredicatePos` gives: what a
  // passive auxiliary governs is a predicate, and a stative one is still a
  // predicate (見不賢 is 賢ならざるを見る; 見賤 is 賤しめらる). Small but real —
  // over the recoded gold, an AUX-tagged 見 has **3** ADJ complements against
  // 39 VERB ones, and 被 has none — and the point of admitting it is that the
  // る/らる has somewhere to attach rather than being dropped in silence.
  return (
    sentence.tokens.find(
      (t) =>
        t.head === token.id &&
        t.id !== token.id &&
        (t.dep === "comp:obj" || t.dep === "comp:aux") &&
        isContentPredicatePos(t.pos),
    ) ?? null
  );
}

/** る or らる, decided by the verb underneath: る follows a mizenkei ending
 * in -a, which is the 四段/ナ変/ラ変 shape; every other class takes らる.
 * A property of the governed verb, so it can't live in a static table
 * beside the auxiliary itself. */
/** Whether `token` is the predicate `governor` *makes happen* — the thing
 * the しむ attaches to, as against the causee it acts on or a further clause
 * coordinated after the whole causation.
 *
 * Four relations, and the last two are the ones that had to be argued for:
 *
 *  - **`comp:obl`** — the ordinary shape, and what SUD reserves for a
 *    causative's clausal complement. 使民戰 comes back this way.
 *  - **`comp:aux`** — the same complement under the other label this parser
 *    uses for an auxiliary's governed predicate (it gives 被 its verb that
 *    way, see `passiveComplement`).
 *  - **`comp:obj`, restricted to a verbal child.** Oblique is the majority
 *    label and not the only one, and the minority is far too large to read as
 *    noise. Counted over `lzh_kyoto-sud-{train,dev,test}` (86,239 sentences),
 *    a VERB hanging off one of the five causatives arrives on `comp:obl`
 *    **1,138** times and on `comp:obj` **332** — 使 697/195, 令 254/74,
 *    遣 168/28, 敎 19/35, which is to say roughly 77% oblique overall and
 *    *object-majority* for 敎. Both labels say the same thing about the same
 *    construction, so the 未然形 has to follow either: 遣還 is 還らしむ whichever
 *    edge 還 came in on. This is the reader's own "whichever way it is".
 *
 *    The POS restriction is what keeps the causee out, and it is the same
 *    division `caseParticleFor`'s をして branch makes from the other side —
 *    that rule takes a *nominal* `comp:obj` and this one takes a *verbal* one,
 *    so the two partition the relation rather than competing for it. Gold
 *    bears the division out: 使's `comp:obj` is NOUN 491 / PROPN 244 /
 *    PRON 87 beside its VERB 195, and no token is both.
 *
 *    **What this costs, and why it is nevertheless right.** A verbal
 *    `comp:obj` under a plain verb is a *nominalized* object — 不得飲 is
 *    飲むを得ず, `isNominalizedObjectPredicate`'s whole subject — and until
 *    this arm existed a causative's `comp:obj` complement fell to that rule
 *    and printed 連体形 + を (俯臥**するを**しむ, a を wedged between the act and
 *    the auxiliary that causes it). A causative is not obtaining a thing; it
 *    is making an act happen, and the act is the auxiliary's own complement.
 *    So `isNominalizedObjectPredicate` now stands down in front of this
 *    predicate — see the guard there, which is what stops the を being written
 *    onto a 未然形.
 *  - **`parataxis`**, restricted to a verbal child. This parser falls back to
 *    `parataxis` for a caused predicate it has not labelled a complement, and
 *    that is what 酒蟲's 但令於日中俯臥、縶手足 (sent_id 20) actually comes back
 *    as: 俯 hangs off 令 by `parataxis`, and without this it took no 未然形 at
 *    all. The fallback is the same one `COORDINATION_DEPS` documents for
 *    asyndetic coordination — `parataxis` is where this parser puts a
 *    relation it has not named — and the restriction to a *causative*
 *    governor is what keeps the two uses apart.
 *
 * That last admission has a second consequence, and it is not optional: the
 * caused predicate now sits on an edge `isNonFinalCoordinand` also walks, so
 * that function has to be told this edge is a complement and not a conjunct.
 * See the guard there — without it 但令於日中俯臥 read 俯臥せしめ, a 連用形
 * handing on to a conjunct that is really the causative's own complement. */
function isCausedPredicateOf(token: Token, governor: Token): boolean {
  if (!CAUSATIVE_LEMMAS.has(governor.lemma)) return false;
  // **Verbal on every one of the four**, which the `parataxis` arm always
  // required and the two `comp:` arms did not. A caused predicate is a
  // predicate: what a causative governs that is *nominal* is the causee, and
  // it takes をして and no 未然形 at all (`caseParticleFor`). The two rules
  // partition the causative's dependents by POS and the relation decides
  // nothing, which is the only arrangement under which a swap of the two
  // labels — and gold swaps them, see above — cannot swap the readings.
  //
  // The cost is 26 gold tokens and they are all causees: of the 1,195
  // `comp:obl`/`comp:aux` dependents of the five causatives, 1,156 are VERB,
  // ADJ or AUX, 26 are NOUN/PRON/PROPN (后稷教民稼穡's 民, 教之樹畜's 之) and the
  // remaining 13 are SCONJ/PART/ADP — 之, 所, 也, 自 — which are no more
  // predicates than the nominals are.
  //
  // **敎民戰 is the sentence that tests this and it is not fixed here.** Parser
  // 0.3.2 returns 敎 VERB/root, 民 NOUN/`comp:obl`, 戰 **NOUN**/`comp:obj` —
  // unchanged from 0.3.1, re-checked live on the page after that upgrade
  // (nothing here was going to move: the recoding is of the *descriptive*
  // class, and 戰's xpos is 行為) —
  // exported from the page and read off the file, not inferred — so 戰 is a
  // nominal and this predicate declines it, and the page reads 民に戰をして
  // しむ. The relations are *not* the error: 教民睦也, 教民順也 and 后稷教民稼穡
  // carry that exact pair in gold. The error is the UPOS, and the parser's own
  // xpos says so — it wrote `v,動詞,行為,交流` on 戰, which is the verbal class
  // all 386 gold VERB 戰 carry (the 79 nominal ones are `n,名詞,行為,*`). A
  // nominal UPOS over a `v,` xpos is a self-contradiction and not an
  // annotation: it occurs **3 times in 433,169 gold tokens**. Reading the xpos
  // over the UPOS here would be compensating in the app for a parser error,
  // which this project does not do; the annotation to correct is 戰's UPOS to
  // VERB, and with that one edit the pair reads 民をして戰はしむ (asserted in
  // kuhouPatterns.test.ts).
  //
  // **The counts above are pre-0.3.2 and survive the recoding intact**, with
  // ADJ admitted: over the recoded gold the five causatives' `comp:obl`
  // dependents are 1,082 VERB + **56 ADJ** + 18 AUX = the same 1,156
  // predicates, against the same 26 nominals, and the `comp:obj` arm adds a
  // further **28** ADJ beside its 402 VERB. Those 85 caused predicates are
  // statives — 使民富, "make the people rich", which wants 民をして富ま**しむ** —
  // and a VERB-only gate would now refuse every one of them. See
  // `isContentPredicatePos`; `depClassification.ts`'s
  // `isCausedPredicateParataxis` is the other half of this same test and is
  // widened with it, as its own doc requires.
  const verbal = isContentPredicatePos(token.pos) || token.pos === "AUX";
  if (!verbal) return false;
  return (
    token.dep === "comp:obl" ||
    token.dep === "comp:aux" ||
    token.dep === "comp:obj" ||
    token.dep === "parataxis"
  );
}

/** **Whether one of the five 使役 characters is being read as the auxiliary at
 * all**, which is a question about the sentence and not about the lemma.
 *
 * 敎 is the character that forced it. It stands in `AUXILIARY_LEMMAS` and in
 * `CAUSATIVE_LEMMAS` on the strength of 敎民戰 — 民をして戰はしむ — and the table
 * is keyed on the lemma alone, so every one of its **202** gold VERB tokens
 * rendered as しむ with the kanji dropped. **137** of them govern no predicate
 * whatever: 教不倦 is 教へて倦まず, 其所教 is 其の教ふる所, 不教而殺 is
 * 教へずして殺す. A causative with nothing to cause is not a causative, and
 * what it is instead is the ordinary verb 教ふ (下二段ハ行 をし — see
 * `verbLexicon.ts`, which now holds it).
 *
 * **The other four are exposed the same way and by the same amount.** Counted
 * over `lzh_kyoto-sud-{train,dev,test}.relabeled_ext.udep_ruled.punct.rulemerged.adjfix.conllu`,
 * tokens of each character that reach `AUXILIARY_LEMMAS` against those with a
 * caused predicate under them:
 *
 * | | tokens | causing | not |
 * |---|---|---|---|
 * | 使 | 1,541 | 924 | 617 |
 * | 令 | 637 | 349 | 288 |
 * | 遣 | 332 | 225 | 107 |
 * | 敎 | 338 | 65 | 273 |
 *
 * — and the "not" column is not an edge case in any of the four. 惠則足以使人
 * is 人を使ふ, 既不能令 is 令すること能はず, 行秋令 is 秋の令を行ふ (a NOUN 令,
 * 206 of them, which nothing on this path ever gated on POS), 遣車一乘 is a
 * 遣車. Each was printing しむ. So the rule is written once, on the shared
 * `CAUSATIVE` form object rather than on a list of lemmas, and every character
 * that renders as しむ is asked the same question.
 *
 * **A pin outranks it**, as a pin outranks every rule here: a reader who has
 * chosen しむ on a character has said this *is* the auxiliary, whatever the
 * tree looks like, and `chosenAuxiliary` is what carries that. The 再読 test
 * immediately above `auxiliaryFormFor`'s call to this makes the identical
 * exception for the identical reason.
 *
 * **Measured**, against a baseline re-rendered immediately before, over the same
 * gold: **1,046** of the 2,848 tokens of the five characters change, in 1,048
 * of the 68,893 sentences. Three of the four move onto readings this project
 * already holds and they are the reason for the change — **229** 敎 (教ふ, and
 * 114 nominals that simply keep their character: 校者、教也 is 校なる者は教なり),
 * **313** verbal 使 (惠則足以使人 is 人を使ふ), **173** 令 that are almost all
 * nominal (行秋令 is 秋の令を行ふ).
 *
 * **Two populations trade one wrong answer for another, and neither is fixable
 * from here.** They are stated rather than used to narrow the rule, because
 * what they were printing before was a 使役 auxiliary in a sentence with no
 * causation in it, and that is wrong in kind and not merely in reading:
 *
 *  - **200 nominal 使** go from しむ to つかふ — 漢使 as 漢の**つかふ**, a finite
 *    verb standing where "envoy" belongs, with the character dropped. The
 *    cause is `overrides.json`'s second 使 entry (つか + ふ, "to use, to
 *    employ"), which carries no `contextPos` and so answers for a noun; the
 *    fix is a `contextPos` there, not a narrowing here.
 *  - **99 遣** go from しむ to 遣す — 乃遣沛公 as 沛の公を**遣す**. The structure
 *    is now right and the reading is doubtful: the derived sense is `yodan-sa`
 *    + や, which is 遣る's stem on 遣はす's paradigm, the same cross of two
 *    words `verbLexicon.ts`'s 絶 entry records for た.やす. 遣はす (つか + は +
 *    四段サ行) is the received kundoku and would be a `RESIDUAL` entry; which
 *    of 遣はす / 遣る a bare 遣 takes is for the reader.
 *
 * **Asked by both the しむ and the をして, because they are one decision.** The
 * causee's をして (`caseParticleFor`) marks *the one made to act*, and where
 * nothing is being caused there is no one made to act — 惠則足以使人 would come
 * out 人**をして**使ふ, a causee marking with no causative anywhere in the
 * sentence, if only one of the two stood down. That is the shape of failure
 * this codebase guards hardest against, and one predicate asked twice is what
 * makes it impossible. */
export function readsAsCausative(token: Token, sentence: Sentence): boolean {
  if (chosenAuxiliary(token) === CAUSATIVE) return true;
  return governsCausedPredicate(token, sentence);
}

/** Whether this causative has a caused predicate at all — the bound on the
 * oblique causee in `caseParticleFor`, and the whole of `readsAsCausative`
 * where the reader has pinned nothing. */
function governsCausedPredicate(governor: Token, sentence: Sentence): boolean {
  return sentence.tokens.some(
    (t) => t.head === governor.id && t.id !== governor.id && isCausedPredicateOf(t, governor),
  );
}

/** Whether this token is the predicate a 使役 or 受身 auxiliary governs,
 * and so must be in 未然形 for the しむ / る / らる that follows it. */
export function isCausedOrPassivePredicate(token: Token, sentence: Sentence): boolean {
  const governor = sentence.tokens.find((t) => t.id === token.head && t.id !== token.id);
  if (!governor) return false;
  if (isCausedPredicateOf(token, governor)) return true;
  return passiveComplement(governor, sentence)?.id === token.id;
}

export function passiveForm(complement: Token | null): ConjugatedForm {
  const conjClass = complement ? VERB_LEXICON[complement.lemma]?.conjClass : undefined;
  const aRow = !!conjClass && (conjClass.startsWith("yodan-") || conjClass === "na-hen" || conjClass === "ra-hen");
  return aRow ? PASSIVE_RU : PASSIVE_RARU;
}

/** The token that comes right after `tokenId` in Japanese reading order,
 * skipping punctuation (which carries no grammatical triggering
 * information of its own). Used to decide which conjugated form a
 * preceding content word needs — classical Japanese attachment is
 * determined by what *follows* a word, not the word itself. */
export function nextMeaningfulToken(plan: ReadingPlan, tokenId: number): Token | undefined {
  const byId = new Map(plan.sentence.tokens.map((t) => [t.id, t]));
  const idx = plan.order.indexOf(tokenId);
  for (let i = idx + 1; i < plan.order.length; i++) {
    const next = byId.get(plan.order[i]);
    if (next && next.dep !== "punct") return next;
  }
  return undefined;
}

/** `nextMeaningfulToken`, but **stopped at the end of the clause**.
 *
 * `nextMeaningfulToken` skips every `punct` token alike, a full stop included,
 * so what it finds after the last word of one sentence is the first word of
 * the next. That is right for the questions asked about a *chain* — a
 * coordination or a quotation genuinely runs on past a mark — and wrong for
 * every question about what a word is standing in front of.
 *
 * 學而 8 is what it cost. 學則不固。主忠信。 ends its first sentence on a
 * negation and opens the next on the noun 忠, and `negationForm`'s
 * attributive test — "is the very next token a noun?" — looked straight
 * through the 。 and found one, so the negation came out as the 連体形 modifying
 * it: 學びて則ち固から**ぬ**。忠信を主, where a sentence ending in a negation
 * takes the 終止形 固からず.
 *
 * A `punct` token whose text is in `FULL_STOPS` ends the walk, and so does one
 * in `COMMAS`. ，、；： divide a sentence without closing it, and this walk once
 * stepped over them on the ground that a negation before one might still be
 * inside the clause its noun belongs to. **It never is.** A punctuated text
 * does not put a mark between an attributive clause and the noun it modifies,
 * so what a negation finds across a 、 is the first word of the next clause,
 * exactly as across a 。. 孫子・地形 is what it cost: in 而不知敵之不可擊、勝之
 * 半也 the 不 of 不可擊 looked through the 、 at the noun 勝 opening the next
 * clause and wrote 敵の擊つ可から**ぬ**、勝の半ば as though the negation
 * modified 勝. Nor does anything this
 * walk is asked about — a 者, a なり, a のみ, a かな — stand on the far side of
 * a mark from the predicate it attaches to; each is written straight after it.
 *
 * Brackets do not stop the walk: a 」 closing a quotation is not a clause
 * boundary inside the sentence that quotes it. */
export function nextMeaningfulTokenInClause(plan: ReadingPlan, tokenId: number): Token | undefined {
  const byId = new Map(plan.sentence.tokens.map((t) => [t.id, t]));
  const idx = plan.order.indexOf(tokenId);
  for (let i = idx + 1; i < plan.order.length; i++) {
    const next = byId.get(plan.order[i]);
    if (!next) continue;
    if (next.dep === "punct") {
      if (FULL_STOPS.has(next.text) || COMMAS.has(next.text)) return undefined;
      continue;
    }
    return next;
  }
  return undefined;
}

/** Mirror of `nextMeaningfulToken`: the token right *before* `tokenId` in
 * Japanese reading order, skipping punctuation. */
export function previousMeaningfulToken(plan: ReadingPlan, tokenId: number): Token | undefined {
  const byId = new Map(plan.sentence.tokens.map((t) => [t.id, t]));
  const idx = plan.order.indexOf(tokenId);
  for (let i = idx - 1; i >= 0; i--) {
    const prev = byId.get(plan.order[i]);
    if (prev && prev.dep !== "punct") return prev;
  }
  return undefined;
}

/** て -> して when 而 (as connective て) immediately follows a postposed
 * negation in reading order (連用形+ず+して, standard classical liaison
 * joining two negated predicates), e.g. 人不知而不慍 -> 人知らずして慍みず.
 *
 * て stays plain て (never しかして) whenever the token immediately *before*
 * 而 in reading order is itself stative/adjectival (`Degree=Pos`) — a
 * stative's own 連用形 already reads straight into 而 as an ordinary converb,
 * the same way any other renyoukei-then-て chain does. Checked ahead of the
 * stative-*bridging* case below, since 長而敦敏's own 而 also happens to
 * bridge into a `Degree=Pos` conj:coord (敏) — without this check first,
 * that would wrongly read as a second, unwarranted rhetorical pivot on top
 * of the adjective 長 already being one.
 *
 * **A ク/シク活用形容詞 in front of that 而 writes して rather than て**, and
 * takes an arm of its own immediately above the feature's. くて is the modern
 * converb; 漢文訓読体 writes くして, and the received text is unanimous about
 * it: counted over the `yomi` field of
 * `tests/fixtures/kanbun-info-passages.json`, a ク活用 連用形 before 而 is
 * written **くして 176** against **くて 1**, and a シク活用 one **しくして 32**
 * against **しくて 0** — and the single くて is 「言葉に出さなくても」, inside a
 * modern-Japanese 解釈 gloss and no kundoku at all, so the score is 176–0 and
 * 32–0. This is `renyouTe.ts`'s `NON_VERB_CONNECTIVE` reached from the other
 * side, and now the two agree: that switch writes 貧しく**して** where the
 * source has no 而, and this writes it where the source has one, instead of
 * 貧しくて beside 飲みて in one line. 趙爽's 夫高而大者 came out
 * 夫れ高く**て**大いなる者 against the received 夫れ高く**して**大なる者.
 *
 * **Held to the paradigm and not to the feature**, which is the whole reason
 * the two arms are separate rather than one arm with its ending changed. The
 * parser writes `Degree=Pos` on every stative, including a great many this app
 * conjugates as サ変 or 四段 — 恢 in 體恢洪而廓落 is 恢洪**す**, 約 in
 * 其旨約而遠 is 約**まる** — and a して after those gives 恢洪しして and
 * 約まるして. So the ending follows what the word is actually inflecting by
 * (see `precedingKuAdjectiveConverb`), and the feature goes on answering for
 * the pivot alone. (kanbun.info reads 長而敦敏 itself 長**じて**敦敏, taking 長
 * as the verb 長ずる rather than as an adjective, so that anchor settles the
 * pivot and says nothing about the ending either way.)
 *
 * Otherwise, て -> しかして only when 而 *itself* is tagged `mod` (not `cc`)
 * and bridges into a *stative/adjectival* coordinate predicate (its head is
 * `conj:coord` and carries `Degree=Pos`) while the token *before* it is a
 * plain action verb: 取之於藍而青於藍 -> ...取り...、しかして藍に青し, a
 * genuine rhetorical pivot from action into an assessment. The `dep ===
 * "mod"` requirement is what keeps this from over-firing on 史記's 生而神
 * 靈／成而聰明 (生/成 no more stative than 取, and their own conj:coord
 * siblings 靈/聰明 do carry the same `Degree=Pos` shape) — those 而 tokens
 * are tagged `cc`, a plain coordinating conjunction linking one clause in a
 * repeated parallel list to the next, not `mod`'s tighter bridging
 * attachment into a specific pivot predicate; 生/成而 read as ordinary て
 * accordingly. Checked against 學而時習之 (而's head 習 is also `conj:coord`
 * but carries no `Degree` morph — a genuine action verb, correctly still
 * plain て) to isolate `Degree=Pos` specifically as the signal on top of
 * `dep`, not `conj:coord` alone. Shared so both panels render the same
 * gloss for 而 — decided directly from the dependency tree rather than by
 * inspecting already-rendered text, so it can't silently diverge from what
 * NEGATION_LEMMAS/selectForm actually produce elsewhere. */
/** True when the token immediately before `tokenId` *in source order*
 * (id - 1 — this parser's token ids are dense per sentence, so this is
 * exactly "the previous character/word as written", not reading order) is
 * punctuation. A comma right before 而 is real kanbun's own signal that
 * what follows is a fresh, bridging clause (しかして), more reliable than
 * this parser's own `mod`-vs-`cc` dep tag for 而 — that tag has been
 * observed to flip under a trivial surface change (an added comma) that
 * doesn't actually change the meaning, where the source punctuation itself
 * never does. */
function precededBySourcePunctuation(sentence: Sentence, tokenId: number): boolean {
  // Sentence-initial is the real condition — しかして *opens* a sentence,
  // so a 而 standing first in one is doing exactly that. Once sentences are
  // split at every boundary (see `splitIntoSentences`), the ， that closed
  // the previous clause is in the previous sentence and no longer visible
  // from here, which is what made this stop firing.
  if (tokenId === 0) return true;
  const prev = sentence.tokens.find((t) => t.id === tokenId - 1);
  // Any mark, the medial 、 included. This used to require a sentence-final
  // one, on the reasoning that a comma divides items inside a clause and
  // leaves it running on into what follows — which contradicted this
  // function's own doc above, and was wrong: 青取之於藍、而青於藍 is one
  // sentence to this parser, with the comma and 而 adjacent in it, and it read
  // 取り、て. A comma before 而 is exactly the case the doc describes, and the
  // one a reader meets most often, since 而 bridging two clauses is normally
  // written with the break marked.
  return !!prev && prev.dep === "punct";
}

/** What 而 contributes, split into what is read *of the character* and what
 * is written after it.
 *
 * The distinction is the same one `overrides.json` draws with its own
 * `okurigana` field: て and して are endings on the verb before 而, with
 * nothing read on 而 itself, while 而して is 而 read しか with して after it.
 * So the first two come back as okurigana alone and the third as a reading
 * plus its ending — which is what lets the 訓読文 set it as furigana しか
 * with シテ beside it, and the 書き下し文 keep the character.
 *
 * **而して, and the character is kept.** This has been three things in turn —
 * しかして, then しかも, and now 而して — and the last of them is the received
 * text's, which is what the reader has now asked the app to follow. Counted
 * over kanbun.info's 178,468 characters of 書き下し文: 而 stands **1,677** times
 * in its 白文 and **122** in the prose beside it, so the character is a 置き字
 * 92.7% of the time (which is the て/して arm below, an ending on the word
 * before 而 with nothing read on 而 itself); and of the 122 that *are* written,
 * every one keeps the character — **而して 59, 而も 19, 而る… 18 (而るに 11,
 * 而るを 7), 而ち 6** — against **しかも 0, しかして 0, しこうして 0** in kana.
 * The word this constant names is therefore 而して, the commonest of them, and
 * the division is KANJIDIC2's own dot: it files 而 as しか.して.
 *
 * 而も and 而るに are the residue and are not distinguished here. Which of the
 * three an editor writes turns on whether the clause continues the last one or
 * turns against it, and nothing in the tree says which; 而して is taken as the
 * default on the count. */
export interface EruConnective {
  /** Read over 而 itself; absent where 而 is only an ending on what precedes. */
  reading?: string;
  okurigana: string;
}

export function teOrShite(plan: ReadingPlan, tokenId: number, resolve?: ReadingResolver): EruConnective {
  // **A mark before 而 decides 而して, first and unconditionally.** The reader's
  // ruling used to be *"而 should not be read as して after a comma, only as
  // しかも"*; it is withdrawn, and the instruction now is to follow the received
  // text, which writes 而して 59 times and しかも in kana never. See
  // `SHIKASHITE`, where the count is.
  //
  // It used to stand below the negation branch, and a 而 that is both preceded
  // by a mark *and* stands after a negation therefore never reached it:
  // 不好犯上，而好作亂者 came out 上を犯すを好ま**ず、して**亂を作る… where the
  // reading is 上を犯すを好まず、**而して**亂を作るを好む者.
  //
  // **Why the mark outranks both branches below it.** The two of them write an
  // *ending on the word before* 而 — て, して — and the mark is the source saying
  // that word has already closed: what stands after a break is a new clause, and
  // 而 opening one is read しか + も, "moreover", with nothing added to what
  // precedes (see `EruConnective`). That is also why the stand-down below could
  // never have applied to it: standing down over a 而して does not avert a
  // doubled ending, it deletes a word, which is what the exception written into
  // that branch's own guard used to say. With the mark asked first the guard is
  // unnecessary and is gone, and the three branches read as one order —
  // **the mark, then what the preceding form already wrote, then what the
  // preceding word needs.**
  //
  // The predicate before a 而して closes on its own and needs nothing from 而:
  // `decideConjForm`'s 而 branch reads the same `precededBySourcePunctuation`
  // and gives it a 終止形 (or a 連用形 where the tree says the chain is still
  // open, which is 連用中止法 and complete as it stands), and a negation there
  // writes ず, which serves. So the two functions agree about which 而 this is,
  // as they must.
  if (precededBySourcePunctuation(plan.sentence, tokenId)) return SHIKASHITE;
  const prev = previousMeaningfulToken(plan, tokenId);
  // Then the 然 that has already written the join itself: 然而 is 然れども,
  // one adversative conjunction spelled across two characters, and the ども
  // is the whole of what 而 contributes to it. Without this the 然 would take
  // the `Degree=Pos` arm below — every 然 carries that feature — and the
  // sentence came out 然れどもして. Stands with the two stand-downs after it
  // rather than above the mark, because 然 is a word and not a break: a 而
  // behind a real mark is 而して whatever preceded it. See `isAdversativeZhen`.
  if (prev && isAdversativeZhen(prev, plan.sentence)) return { okurigana: "" };
  // Then the stand-down: a predicate handing on may have written the して as
  // part of its own 連用形 — にして for a nominal, として for a タリ形容動詞 — and a
  // 而 adding a second one gave 王仁人にしてて. See `precedingFormSuppliesShite`.
  // 愕然、而笑 is the case that needed the mark asked first: the chain puts 愕 in
  // 連用形 として and the 、 makes the 而 而して — 愕然として、而して笑ふ — where
  // standing down here would have left the sentence with no 而して in it.
  if (precedingFormSuppliesShite(plan, tokenId, resolve)) return { okurigana: "" };
  const afterNegation = !!prev && isNegationUse(prev);
  // A 再読文字 closing on the previous token negates it exactly as a postposed
  // 不 would, and is exactly as invisible to the test above — its ず is no
  // token of its own to be found in reading order. 未學禮而不知 reads
  // いまだ禮を學ばずして知らず, and read ずて without this.
  //
  // Both anchors have no mark before their 而 and are untouched by the hoist:
  // 人不知而不慍 stays 人知ら**ずして**慍みず and 未學禮而不知
  // いまだ禮を學ば**ずして**知らず. What moved is only the 而 the source itself
  // set off behind a break.
  const afterRereadNegation =
    !!prev &&
    (plan.rereadCloseIds.get(prev.id) ?? []).some((id) => rereadNegates(plan.sentence.tokens.find((t) => t.id === id)?.text ?? ""));
  if (afterNegation || afterRereadNegation) return { okurigana: "して" };
  // Then the ク/シク adjective, which writes して where the arm below it writes
  // て. Asked of the paradigm and not of the feature, above the feature's own
  // arm and inside it — see this function's doc for the 176–0 / 32–0 count,
  // and `precedingKuAdjectiveConverb` for why the feature cannot answer this.
  if (precedingKuAdjectiveConverb(plan, tokenId, resolve)) return { okurigana: "して" };

  // **And a span that wrote ナリ活用's 連用形 に is owed して, not て.** This is
  // the third case of the same three-way split the two branches above and
  // `renyouTeSuffix` all draw — a verb's 連用形 takes て, everything else's
  // takes して — arriving here because the ending was written by
  // `compoundSuruOkurigana` inside the span branch and neither panel ever saw
  // the class it used. The copula's own にして needs nothing from 而 and the
  // stand-down above catches it; the サ変 span's し wants the plain て and gets
  // it (悾悾して); ナリ活用's に wants the して and read 恢洪**にて**廓落 without
  // this, where the received reading of 體恢洪而廓落 is 體は恢洪**にして**廓落.
  // The 而 is where the corpus puts this: of the 20 descriptive binomes the
  // kanbun.info 書き下し文 writes にして (see `descriptiveBinomeNariReading`),
  // most stand in front of one — 富貴而驕 is 富貴にして驕れば, 淸明而無隱 is
  // 淸明にして隱るる無し.
  //
  // ナリ活用 and not the whole of `SHITE_CLASSES`: タリ活用's 連用形 is として,
  // which carries the connective already, and the redup arm of
  // `precedingFormSuppliesShite` has stood the 而 down over it before this line
  // is reached. The two adjective classes never reach a span at all.
  if (precedingSpanWroteNariRenyou(plan, tokenId, resolve)) return { okurigana: "して" };
  if (prev && parseMorphFeatures(prev.morph ?? "").Degree === "Pos") return { okurigana: "て" };
  const token = plan.sentence.tokens.find((t) => t.id === tokenId);
  const governor = token && plan.sentence.tokens.find((t) => t.id === token.head);
  const bridgesToStativeCoord =
    token?.dep === "mod" && governor?.dep === "conj:coord" && parseMorphFeatures(governor.morph ?? "").Degree === "Pos";
  return bridgesToStativeCoord ? SHIKASHITE : { okurigana: "て" };
}

/** Exported so that `annotationEditor.ts` can recognize しか as *the*
 * reading 而 takes over the character, rather than restating it — that
 * module has to tell 而 read as the connective apart from 而 read as
 * anything else, and the only thing that settles which kana are the
 * connective's is this constant. */
export const SHIKASHITE: EruConnective = { reading: "しか", okurigana: "して" };

/** The two characters a clause-opening 然 stands before when it is the
 * **adversative** 然れども. See `isAdversativeZhen`. */
const ADVERSATIVE_ZHEN_FOLLOWERS: ReadonlySet<string> = new Set(["而", "其"]);

/** **然 opening a clause and turning it against the last one — 然れども.**
 *
 * 然 is several words and the tree tells them apart badly, because every one
 * of them arrives ADV/`mod` with `Degree=Pos`. Over the kanbun.info parses 然
 * is ADV/`mod` 71 times, and pairing each occurrence with the received
 * 書き下し文 of its passage sorts those by **the character that follows**, not
 * by anything in the tree:
 *
 *     然 + 後   然る後        27 passages
 *     然 + 則   然らば則ち     4
 *     然 + 而   然れども       2  (rongo 19-15, 尉繚子 6)
 *     然 + 其   然れども       3  (大學序, 史記 64, 呉子 4)
 *     然 + 尚   然るに尚       1
 *
 * So this is stated for **而 and 其 only**, which is 5 tokens and every one of
 * them 然れども — against 然りて **0** in the whole corpus, which is what the
 * app was writing. The wider class is there (然 before 不, 非, 所, 戰, 大, 諸,
 * 臣, 相 is 然れども too, another eight), but those followers say nothing in
 * themselves: 然 before a predicate is the adversative in one passage and the
 * 然り of 「然り、禹よ」 in the next, and only a reader can tell. 而 and 其 are
 * the two the *construction* is legible in — 然而 is a fixed compound, and a
 * 然 followed by the possessive opening a fresh clause has nothing else it
 * can be — so the condition is held to them.
 *
 * **Clause-initial, and that bound is doing work.** It is the same test
 * `precededBySourcePunctuation` makes of 而, for the same reason: what stands
 * after a break opens a clause. Without it the タリ suffix 然 walks straight
 * in, 繟然而 and 欣然而 being the other two 然而 in the corpus and both of them
 * 繟然と / 欣然と, where a 然れども would have deleted the binom's own ending.
 *
 * Asked by `readingResolver.ts` for what 然 reads and by `teOrShite` for what
 * the 而 after it writes, so the two cannot come apart: 然れどもして is not a
 * word, and the 而 of 然而 has to write nothing at all. */
export function isAdversativeZhen(token: Token, sentence: { tokens: Token[] }): boolean {
  if (token.lemma !== "然" && token.text !== "然") return false;
  if (token.pos !== "ADV" && token.pos !== "ADJ") return false;
  const prev = sentence.tokens.find((t) => t.id === token.id - 1);
  if (prev && prev.dep !== "punct") return false;
  const next = sentence.tokens.find((t) => t.id === token.id + 1);
  return !!next && ADVERSATIVE_ZHEN_FOLLOWERS.has(next.lemma);
}

/** **What "oblique" is, in the labels this treebank actually writes.**
 *
 * An oblique is an argument or adjunct that is neither the subject nor the
 * direct object — where it happens, when it happens, what it is done with —
 * and Japanese marks that slot に. Naming the class needs the label inventory
 * rather than the notion, because SUD writes it in two registers and the app
 * meets both:
 *
 *  - **What the gold treebank writes.** Counted over
 *    `assets_sud/lzh-{train,dev,test}.sud.conllu` (1,066,724 tokens, 137,786
 *    sentences): `comp:obl` 10,610, `udep@tmod` 5,074, `udep` 4,110,
 *    `udep@lmod` 3,856 — 23,650 in all, 2.2% of the corpus. **`mod@lmod`,
 *    `mod@tmod`, `comp:obl@lmod` and `comp:obl@tmod` do not occur in it at
 *    all**, which is worth saying plainly because this file and
 *    `depClassification.ts` both key rules on the first two. `udep` is SUD's
 *    underspecified relation, and the `@lmod`/`@tmod` subtypes ride on *it*
 *    in the gold annotation.
 *  - **What the parser writes.** The lzh_sud_kyoto pipeline disambiguates
 *    `udep` into `mod` or `comp:obl` at inference time and carries the
 *    subtype across with it, so a parse produces `mod@lmod`/`mod@tmod`/
 *    `comp:obl@lmod` where the gold file has `udep@lmod`/`udep@tmod`. The
 *    wheel's own relation inventory (`KNOWN_LZH_DEPRELS` in
 *    `conlluParser.ts`, copied from its meta.json) lists exactly that set.
 *    酒蟲's own tree has `comp:obl` 5, `mod@tmod` 4, `mod@lmod` 1 and no
 *    `udep` at all.
 *
 * So the set is the union of the two registers — otherwise a rule written
 * against a live parse silently stops applying to a `.conllu` file the reader
 * uploads, and vice versa.
 *
 * **Plain `udep` is deliberately left out**, and it is the one judgement call
 * here. It is by construction the relation the model declined to classify, and
 * `depClassification.ts` already states the matching safety default for the
 * reading-order half ("never invert on a relation the model itself left
 * underspecified"). Its dependents bear that out: 48% NOUN but 23% PRON and
 * 19% PART, against `udep@lmod` 94% NOUN and `udep@tmod` 95% NOUN. A blanket
 * に over that bucket would mark particles.
 *
 * Used for the particle below, for the 連体形 an oblique *predicate* takes
 * (`isNominalizedObliquePredicate`), and — as `INVERT_DEPS` — for the reading
 * order that puts an oblique before its head. */
export const OBLIQUE_DEPS: ReadonlySet<string> = new Set([
  "comp:obl",
  "comp:obl@lmod",
  "comp:obl@tmod",
  "mod@lmod",
  "mod@tmod",
  "udep@lmod",
  "udep@tmod",
]);

/** Case particles that attach directly after certain SUD relations,
 * regardless of how the token itself is rendered (kanji-retained, kana
 * reading, or conjugated) — kundoku conventionally supplies these even
 * though nothing in the source text realizes them. Bounded to the
 * clearest, least ambiguous relations rather than a full case-grammar
 * pass: `comp:obj` always wants を; every oblique relation (see
 * `OBLIQUE_DEPS`) wants に. Plain `mod` is deliberately excluded — a
 * bare adverbial doesn't reliably take one particle in kundoku.
 *
 * に on the whole oblique class, and not on the two `@lmod`/`@tmod` labels
 * alone, is what makes 墮酒中 read 酒の中に墮す: 中 there is a plain `comp:obl`
 * carrying `Case=Loc`, the ordinary shape of a locative argument, and it was
 * getting no particle at all while the identical noun one edge over
 * (`mod@lmod`) got its に. The table is read only where the token is a nominal
 * (see `caseParticleFor`'s chain-head branch), which is what keeps it off the
 * 5,548 `comp:obl` ADP tokens — an adposition inverts carrying its own case
 * marking and never takes a second particle. */
const CASE_PARTICLE_FOR_DEP: Record<string, string> = {
  "comp:obj": "を",
  "comp:pred": "と",
  ...Object.fromEntries([...OBLIQUE_DEPS].map((dep) => [dep, "に"])),
};

/** **The time nouns kundoku writes bare as a clause adverbial** — 今天下大亂
 * is 今、天下大いに亂る, never 今に. See `isBareTimeAdverbial`. */
const BARE_TIME_ADVERBIAL_NOUNS: ReadonlySet<string> = new Set(["今", "昔", "古", "初", "蚤", "夜", "晝", "昼"]);

/** The two relations a *clause-level* time adverbial arrives on. `comp:obl@tmod`
 * is left out: it is an argument of its governor (至今 is 今に至る, and the
 * に there belongs to 至), not a setting for the whole clause. */
const TIME_ADVERBIAL_DEPS: ReadonlySet<string> = new Set(["mod@tmod", "udep@tmod"]);

/** The tags a modifier may wear to make a **two-character time word** of the
 * nominal it stands on — 餘日, 累代, 終夜, 明日. Exactly the three tags the
 * count found in that position: NUM is deliberately not among them (see
 * `isBareTimeAdverbial` for what separates the two), and PROPN, which never
 * stands there in this corpus, is left out rather than added unmeasured. */
const COMPOUND_TIME_MODIFIER_POS: ReadonlySet<string> = new Set(["NOUN", "VERB", "ADJ"]);

/** True for a **bare time noun that takes no に** where `CASE_PARTICLE_FOR_DEP`
 * would give its `@tmod` relation one: 今 in 今天下大亂, 昔 in 昔殷之興, 夜 in
 * 燕軍夜大驚.
 *
 * **The table wrote に on every oblique**, and for a time phrase that is right
 * when the phrase names a *point* by date or count — 三年に, 是の時に, 暮に,
 * 朝に道を聞かば — and wrong for the handful of time nouns Japanese itself uses
 * as adverbs. kanbun.info writes 今、 **43** times against 今に **6**, and
 * none of the 6 is a time adverbial: 今に到る/至る/及ぶ (four, where 今 is the
 * verb's own argument), 今に於いて (governed by 於), and 来者の今に如かざる (the
 * standard of comparison 如 takes).
 *
 * **Counted per character, not assumed from "deictic"**, because the line does
 * not fall where that word would put it. Over kanbun.info's 3,419 passages,
 * taking every childless `mod@tmod`/`udep@tmod` token carrying `Case=Tem` and
 * asking whether the received 書き下し文 of its passage writes the character
 * followed by に anywhere at all:
 *
 *     never:          今 58 tokens, 昔 7, 晝 5 (昼寝ぬ, 昼は則ち), 蚤 5 (蚤く),
 *                     初 4 (初め, 初めて)
 *     once or twice:  夜 2 of 19, 古 1 of 2
 *     often:          暮 5 of 6, 日 10 of 16, 時 9 of 16, 后 7 of 17,
 *                     後 32 of 66, and 朝/夕/夙 on their one or two tokens
 *                     (朝に道を聞かば)
 *
 * So the set is **lexical**, and 夜 and 晝 are in it on the count although
 * neither is deictic. The two に on 夜 are both 夜に寐ぬ in the fixed pair
 * 夙に興き夜に寐ぬ, borrowing the に of the 夙に beside it; the one on 古 is
 * 古に因れば, where the parser has taken the object of 因 for a time adverbial.
 * 古 is kept as the counterpart of 今 that its other token is: 蓋古治之行、今治之止
 * is 蓋し古は治の行はれ、今は治の止む, and the app wrote 古に…今に. The "often" row
 * stays with the table, including the tokens of 後 and 后 that go bare: 知止而后
 * 有定 is 止まるを知りて后定まる有り where 而后可以教… is 而る后に以て…, and
 * nothing in the two trees tells those apart. 冬 and 春 split (冬に川を渉る, 冬、倉廩を實たす, 春、台に登る, 春に振旅す)
 * on too few tokens to say, and stay with the table as well.
 *
 * **Only a childless token** — where the character has to be on the list. A
 * *numeral* makes the phrase a dated point again (三年に, 五日に), and a
 * coordinated one (夙夜に之を念ふ) takes the particle once after the pair, which
 * is the chain rule's business.
 *
 * **A non-numeral modifier standing directly in front is the other bare
 * shape, and it needs no list at all.** 累代之を存して, 薪を負ふ餘日 — this
 * wrote 累代**に**之を存り and 薪を負かすこと餘日**に**. Over the same 3,419
 * passages, taking every `Case=Tem` token on one of `TIME_ADVERBIAL_DEPS`
 * and classifying it by what hangs beneath it:
 *
 *     no child at all:            に 77, bare 172
 *     one NUM `mod` before it:    に 15, bare  42
 *     one NOUN `mod` before it:   に  0, bare  18
 *     one VERB `mod` before it:   に  0, bare   6
 *     one ADJ `mod` before it:    に  1, bare   4
 *
 * The NOUN row is 今日, 旬日, 期月, 正月, 旦日, 夕時, 前後, 先後, 後世, 古昔,
 * 時時, 天時, 年冬, 年春, 數年 — a two-character time word, which is what 累代
 * and 餘日 are; the VERB and ADJ rows are 終日, 終夜 and 明日, the same thing
 * with a descriptive first half. **No head character is in common** (日 代 世
 * 月 昔 時 冬 春 後), which is why the closed list is not widened to take 代 and
 * 日: the shape decides this, not the lexeme, and 日 by itself is on the
 * "often" row above. The one counter-example is 吉月、必朝服而朝 (吉月に), and it
 * is left to cost this rule one token rather than argued away.
 *
 * NUM is excluded and the rows above are why: a counted quantity of time is
 * a dated point and takes に 15 times in 57, where a modifier that names
 * rather than counts takes it once in 29. The modifier must also stand
 * *immediately* before its head on a plain `mod`, so a determiner (`det`), a
 * fronted subject or a modifier flung further off leaves the token to the
 * table (に3, bare 16, neither 19 — left where it stood rather than widened
 * into, with half those tokens undecided).
 *
 * **Only the child standing at `id - 1` is looked at, and the rest are not
 * counted.** 負薪餘日 is the shape that forces this: 餘日 there carries *two*
 * modifiers, 餘 beside it and the whole relative clause 負薪 ("carrying
 * firewood") over it, and a rule that demanded a lone child would read
 * 薪を負ふ餘日**に** where the gold has 薪を負ふ餘日. Re-measured on the
 * immediately-preceding child alone, admitting a token with further children
 * costs nothing: the corpus has one such NOUN and one such ADJ and both are
 * undecided. */
function isBareTimeAdverbial(token: Token, sentence: Sentence): boolean {
  if (!TIME_ADVERBIAL_DEPS.has(token.dep)) return false;
  if (parseMorphFeatures(token.morph ?? "").Case !== "Tem") return false;
  const children = sentence.tokens.filter((t) => t.head === token.id && t.id !== token.id && t.dep !== "punct");
  if (children.length === 0) {
    return BARE_TIME_ADVERBIAL_NOUNS.has(token.lemma) || BARE_TIME_ADVERBIAL_NOUNS.has(token.text);
  }
  const modifier = children.find((t) => t.id + 1 === token.id && t.dep === "mod");
  return modifier !== undefined && COMPOUND_TIME_MODIFIER_POS.has(modifier.pos);
}

/** **The verbs whose complement is marked に and never を** — 父母に事ふ, 之に
 * 從ふ, 遠方より來るに及ぶ — so that `CASE_PARTICLE_FOR_DEP`'s blanket を for
 * `comp:obj` does not reach them.
 *
 * **A closed lemma list, and the objection to closed lemma lists here is
 * answered rather than ignored.** `predicativeComplementParticle`'s own note
 * sets out why a list of *becoming* verbs bolted onto `comp:obj` cannot work:
 * 成 and 適 each have a genuinely transitive sense sharing the relation
 * (成其術 is 其の術**を**成す), so a lemma rule would mark those too, and no tag
 * in the treebank separates the two senses. That objection turns entirely on
 * the lemma being ambiguous. These are the lemmas where it is not: 事 as a verb
 * is つかふ, "to serve", and its complement is the one served; 從/従 is したがふ;
 * 及 is およぶ; 勝/克 is かつ; 臨 is のぞむ; 由/因 is よる. None of them has a
 * を-taking sense to protect.
 *
 * **Counted in the received reading, which is where the list comes from.**
 * Over kanbun.info's 178,468 characters of 書き下し文, taking each candidate
 * character and counting the particle written immediately before it:
 *
 * | 事 72に / 7を | 従 74/2 | 入 72/1 | 因 70/0 | 及 70/0 | 勝 68/0 |
 * | 居 64/2 | 當 59/1 | 處 48/1 | 足 42/2 | 臨 32/0 | 乘 27/0 |
 * | 應 24/0 | 由 24/0 | 順 23/4 | 遇 22/2 | 近 14/2 | 坐 13/0 |
 *
 * The を column is not noise to be explained away — it is 事 as the *noun*
 * 「事」 ("affairs", 事を敬して信あり) and 從 as 從へる ("to make follow"), both of
 * which are a different word from the one this list names and neither of which
 * reaches here, since this fires only where the character is the governor of a
 * `comp:obj`.
 *
 * **Both spellings of each character**, for the reason `PURPOSIVE_WEI_LEMMAS`
 * lists 為 beside 爲: nothing normalises a lemma before this set is keyed by
 * it, and the 白文 this app is handed may be in either.
 *
 * 任 and 服 are the two candidates that were tried and **left out**, both of
 * them the ambiguous kind the objection above is about: 任賢 is 賢**を**任ず,
 * "appoints the worthy", against 任於人's 人**に**任ず, and 服 is the noun
 * 「服」 ("clothing", 服**を**…) as readily as the verb 服す. Each is worth a
 * handful of edits and 服 costs 9 of them, which is what a lemma that fails
 * this list's own criterion should be expected to do.
 *
 * 在 (196に/1を) and 至 (92/0) are here too, and the worry that kept them out
 * at first does not arise: where 於 stands between the verb and the place, the
 * place is **於's** `comp:obj` and not the verb's — 至於是邦 hangs 是邦 off the
 * 於 — so `yuParts` answers that one and this never sees it. What this answers
 * is the bare frame, 在其位 -> 其の位**に**在り, which was reading 其の位を在り.
 * Worth 32 gold edits and 91 parsed ones.
 *
 * **抵 is the newest member, and the corpus could not decide it — the gold
 * treebank did.** 家書抵萬金 was reading 萬金**を**抵る against the received
 * 万金**に**抵たる. The received text carries the character **once** in its whole
 * 178,468 characters (盗抵罪 -> 罪**に**抵る), so the count this table is otherwise
 * kept by has a sample of one here, and the ratchet can move by at most an edit
 * either way. The evidence is the treebank instead. 抵 governs a `comp:obj`
 * **25** times in `lzh_kyoto-sud-{train,dev,test}`, and the split is **20 に
 * against 4 を**: arrival at a place (抵南山, 抵京師 x3, 抵澶州, 抵夾寨,
 * 抵晉陽城下, 抵營室, 抵漣水軍), 抵罪/抵法 x8 — 罪に抵る, the fixed phrase for
 * incurring a penalty — and 抵萬金, "comes to as much as"; against 抵掌 x2,
 * 抵璧於山 and 抵其奏於地.
 *
 * **Those four are the other word**, which is the excuse this table already
 * grants itself twice over: the を column above is 事 the *noun* and 從 as
 * 從へる, "both of which are a different word from the one this list names". 抵
 * as あたる reaches or is equivalent to something and marks it に; 抵 as うつ
 * strikes or flings a thing and marks it を, and 掌, 璧 and 奏 are the three
 * things flung. That is not the ambiguity 任 and 服 were kept out for, and it is
 * not 遠's either: 遠's two words are 遠ざかる and 遠ざく, one meaning read two
 * ways, and the received text writes を for 8 of its 14 (see
 * `DATIVE_PREDICATE_OBJECT_LEMMAS`). Measured, admitting 抵 is **-1 edit**
 * (parser tier, the one 抵罪 passage), which is the whole of what a lemma
 * occurring once can be worth and is the right sign.
 *
 * **感 was measured beside it and is refused.** 感時花濺淚 wants 時**に**感じ and
 * this table would give it, at the same **-1 edit** on the same corpus (its one
 * 感 passage, 禾黍を生ずる**に**感じ). It is refused all the same, because 感 is
 * exactly the ambiguous lemma the paragraph above excludes 任 and 服 for:
 * gold's 28 `comp:obj` under 感 are led by the **transitive** sense — 姦聲感人,
 * 正聲感人, 其感人深, 足以感動人之善心 — where 感 *moves* someone and the
 * complement is marked を. 人**に**感ず there says the sounds were moved by the
 * people, which is the sentence backwards. A lemma whose commonest use in the
 * treebank the rule would invert is not admitted for one edit on a corpus
 * holding two of it.
 *
 * The narrower route was tried too and buys nothing: 感 in
 * `DATIVE_PREDICATE_OBJECT_LEMMAS` — the *predicate*-slot carve-out 遠 is in,
 * and the slot the corpus's own 感 actually stands in — moves **0 passages**,
 * that complement not reaching `isNominalizedObjectPredicate`'s branch at all.
 * So 時を感ず stands, and it stands for a stated reason.
 *
 * **依 is the newest member and is the plainest case the table has had.** It
 * is the third of the よる verbs, beside 由 and 因 which are already here, and
 * it fails none of the tests the others are weighed by. Counted the way the
 * column above is counted, over kanbun.info's whole 書き下し文: **に依 10,
 * を依 0** — 仁に依り, 鬼神に依りて, 水草に依りて, 八陣の図に依り, 丘陵険阻に
 * 依り, 險阻に依れ — with one further 依 carrying no particle at all (其の衆
 * 依ること, where the complement is its subject). There is no を-taking sense to
 * protect: KANJIDIC2 gives the character one kun, よ.る, and the corpus parses
 * give it 10 VERB tokens and 11 `comp:obj` dependents between them, so the
 * relation this fires on is exactly the one the received text marks に. 輒依經
 * 為圖 (the 周髀算經 preface) was reading 經**を**依り against 經**に**依りて.
 *
 * **Measured** over those 3,419 passages: **-6 edits**, 8 passages moving — 6
 * closer, 1 level and 1 further. The one further is 史記 樂書 (shiki001e#54),
 * 律和之聲 依, where the site writes を: the parse hangs 聲 off 依 as a
 * `comp:obj` in a clause the received reading does not divide there at all. */
const DATIVE_OBJECT_LEMMAS: ReadonlySet<string> = new Set([
  "事", "從", "従", "及", "勝", "克", "臨", "加", "歸", "帰", "處", "処", "居",
  "乘", "乗", "由", "因", "依", "入", "遇", "順", "應", "応", "當", "当", "足",
  "親", "近", "違", "坐", "在", "至", "抵",
]);

/** **Whether this verb's complement is marked に — which is the same fact as
 * its being read intransitively, and so the answer to the transitivity
 * question the reading is picked by.**
 *
 * The reader's rule: 入's object takes を where the verb is read transitively
 * and に where it is read intransitively — 之**を**入る against 門**に**入る.
 * The particle has to follow the word the reading picked, and this app was
 * writing the two halves from two different premises. `hasObject` decided the
 * reading (an object means the transitive kun, so 入 with any `comp:obj` was
 * 下二段 入る, "to put in") while `DATIVE_OBJECT_LEMMAS` decided the particle
 * (に, always). The result was に on a transitive paradigm — 太廟**に**入れ,
 * 門**に**入れんとす, 危邦**に**入れず, 國**に**入るれば — which is neither of the
 * two readings the reader named.
 *
 * **Which half moves is settled by the received text and not by preference.**
 * The rule couples the particle to the reading, so it can be honoured from
 * either end; keying the particle on the reading would write 太廟**を**入れ.
 * Over kanbun.info's 121 occurrences of 入 the site writes 入り/入ら/入れば (四段,
 * "enter") everywhere but two — 之**を**入れ and 糧**を**罰し入れて — and the に
 * before it 72 times. So it is the *reading* that was wrong: the objects these
 * verbs take are goals, not themes, and a goal-taking 入 is 入る 四段. Hence the
 * table is read here as evidence about the **verb**, which is what its own doc
 * says it is: these are the lemmas with no を-taking sense to protect, and a
 * lemma with no を-taking sense has no transitive reading either.
 *
 * **The two 入 the site does read transitively are not recoverable and are not
 * compensated for.** 開入之 and 罰入糧 put the theme on `comp:obj`, the very
 * relation 門 and 太廟 stand in; no feature in the treebank separates a goal
 * from a theme there, and the annotation that would is one this app does not
 * have. Two occurrences against 119 is the trade the governing rule takes.
 *
 * **Worth 120 forms and −94 edits**, measured A/B in one process over the whole
 * of kanbun.info: 74 passages closer and 7 further. Six of the seven are a
 * coincidence of kana rather than a word — the site writes a 已然形+ば (軍に
 * 入れば, 其の有司に親しめば) or a causative (食を足らしめ) where this app's clause
 * structure writes a 連用形, and the transitive form it used to print happened to
 * share a kana with it. The seventh is 臨菑に入れて, one of the two genuine
 * transitives above. The forms that moved: 入れ → 入り 32 and → 入ら 11, 及ぼす →
 * 及ぶ 46 across its paradigm, 親し/親しく → 親しむ/親しみ 11, 違ふる → 違ふ 8,
 * 入るる → 入る 6, 足す → 足る 3. The reading ratchet does not move at all, and
 * cannot: 入る and 入る are both い, which is why this defect was invisible to it
 * and the conjugation class had to be asserted by hand — see
 * `tests/dativeObjectTransitivity.test.ts`.
 *
 * **加 is the one member of the table this does not hold of, and it is excluded
 * by measurement rather than by taste.** Its に is a *goal* standing beside a
 * を-marked theme — 加諸人 is 諸**を**人**に**加ふ — so the particle is に and the
 * verb is transitive all the same, which is precisely the pairing the rest of
 * the table does not have. kanbun.info settles it: over its 書き下し文 the site
 * writes the 下二段 加ふ ("to add to" — 加う, 加うる, 加え, 加うれ) **35** times,
 * **21** of them straight after a に, against the 四段 加はる **2**, both of those
 * after a に as well. Applied to 加 the rule cost 21 forms, every one of them
 * 加ふ → 加はる, and **+26 edits**. See `DATIVE_GOAL_TRANSITIVE_LEMMAS`.
 *
 * Asked of the governing verb (not of the complement), so it can be put to the
 * transitivity question in `readingResolver.ts` — which is a question about the
 * verb — where `caseParticleFor`'s own two arms above ask it of the dependent's
 * governor. */
export function readsWithDativeObject(token: Token): boolean {
  return DATIVE_OBJECT_LEMMAS.has(token.lemma) && !DATIVE_GOAL_TRANSITIVE_LEMMAS.has(token.lemma);
}

/** **The に-taking verbs whose に is a goal and not the whole complement**, so
 * that the particle says nothing about the verb's transitivity and
 * `readsWithDativeObject` must stand down. 加 alone; the case is argued there. */
const DATIVE_GOAL_TRANSITIVE_LEMMAS: ReadonlySet<string> = new Set(["加"]);

/** **遠 — the one distance verb whose に holds for a *predicate* complement and
 * not for a nominal one**, which is why it is here and not in
 * `DATIVE_OBJECT_LEMMAS` above.
 *
 * The reader asked for 遠's object to take に or と rather than を, on 論語 學而
 * 13's 恭近於禮、遠恥辱也 — kanbun.info's 恥辱**に**遠ざかる against this app's
 * 恥辱**を**遠き. Counted before anything was written, and the count says the
 * blanket rule would cost more than it bought.
 *
 * **遠 is two words, and the received text uses both.** 遠ざかる (四段,
 * intransitive, "keep away *from*") takes に; 遠ざく (下二段, transitive, "put at
 * a distance") takes を. Over the 18 places where a `comp:obj` hangs off 遠 in
 * this corpus's own parses, kanbun.info writes:
 *
 * | を 8 | に 6 | より 1 | 3 the parse or a compound makes unusable |
 *
 *   を  敬鬼神而遠之 之**を**遠ざく · 遠佞人 佞人**を**遠ざく · 君子之遠其子也
 *       其の子**を**遠ざくる · 遠之則怨 之**を**遠ざくれば · 遠我旌旗 旌旗**を**遠くし
 *   に  遠恥辱也 恥辱**に**遠ざかる · 斯遠暴慢矣 暴慢**に**遠ざかる ·
 *       斯遠鄙倍矣 鄙倍**に**遠ざかる · 則遠怨矣 怨み**に**遠ざかる ·
 *       必遠其罪 其の罪**に**遠ざかる · 陵而遠之 之**に**遠ざかり
 *
 * So 遠 is exactly the ambiguous lemma `DATIVE_OBJECT_LEMMAS`' own doc excludes
 * 任 and 服 for — a lemma with a genuine を-taking sense sharing the relation,
 * and no tag in the treebank separating the two: all 18 are ADJ `Degree=Pos`,
 * and the gold's 55 `comp:obj` under 遠 are one xpos class (`v,動詞,描写,量`).
 * Putting 遠 in that list would fix 6 and break 8.
 *
 * **What is not ambiguous is the predicate slot.** 遠ざく puts a *thing* at a
 * distance — the corpus's を are 之, 佞人, 其の子, 旌旗, 其の路, all nominals —
 * and a clause cannot be put anywhere. All three of the corpus's predicate
 * complements of 遠 are on the に side (恥辱, 暴慢, 鄙倍), and to write を there
 * this app would have to be reading 遠 as a transitive verb, which it is not:
 * it reads the adjective 遠し, and an adjective takes no object at all. So the
 * rule is stated where the reader's own case lives and nowhere wider, and the
 * nominals are left as the corpus has them.
 *
 * **Alone, and 近/親/違 are not beside it.** They are already in
 * `DATIVE_OBJECT_LEMMAS` and so already reach this branch through it. 疏/疎 was
 * measured and left out: all four of its corpus objects are を (其の親**を**
 * 疏んずる ×2, 之**を**疏んじて, 行陣**を**疎にし), which is the opposite of the
 * claim. */
const DATIVE_PREDICATE_OBJECT_LEMMAS: ReadonlySet<string> = new Set(["遠"]);


/** と — what a predicative complement takes under the copula 爲 and under the
 * comparison 如/奈. The table's own `comp:pred` entry, named so that
 * `predicativeComplementParticle` can say which of the two answers it is
 * giving. */
const PREDICATIVE_PARTICLE = "と";

/** に — what a predicative complement takes under a verb of **becoming or
 * arriving at**: 成佳釀 is 佳釀**に**成る, 適齊 is 齊**に**適く. */
const BECOMING_PARTICLE = "に";

/** Which particle a `comp:pred` takes, and the one place this file splits that
 * relation.
 *
 * **What `comp:pred` actually is in this treebank, measured.** Over
 * `lzh-{train,dev,test}.sud.conllu` (137,786 sentences) it is carried **5,814**
 * times, and it is not the general "predicative complement of a verb of
 * becoming" the label's name suggests. It is very nearly one verb's:
 *
 * | governor | edges | tag on the governor      | what it is                |
 * |----------|-------|--------------------------|---------------------------|
 * | 爲/为    | 5,576 | `VerbType=Cop`, `v,動詞,存在,存在` | the copula |
 * | 是       |     4 | `VerbType=Cop`           | the same, on a demonstrative |
 * | 如       |   188 | `Degree=Equ`, `v,動詞,行為,分類` | 如何 — "how is it"   |
 * | 奈       |    22 | `Degree=Equ`             | 奈何 — the same idiom     |
 * | 使/令/以/求/敎/謂 | 20 | — (no feature)   | the residue               |
 *
 * The dependent is a nominal 4,894 times (NOUN 4,376, PRON 256, PROPN 164,
 * NUM 98) against 920 verbal.
 *
 * **The verbs the reader named are not in it at all.** 適 carries `comp:pred`
 * **0** times — its complement is `comp:obj` (73 of its 111 dependents) — and
 * so does 成 (`comp:obj`, 582 of 1,138). Both share that relation with their
 * own genuinely transitive uses: 成其術 ("accomplishes his trick", 其の術を成す)
 * is a `comp:obj` too, and so is 去仁 under the motion class. **No tag in the
 * treebank separates the two senses**, which was measured before this was
 * written: the `v,動詞,行為,移動` class looked like the place to key a
 * destination's に, and its 11,218 `comp:obj` dependents turn out to be 去仁 /
 * 出言 / 過我 — plain objects taking を — as often as 適齊. There is nothing to
 * key on, and a lemma list of becoming-verbs bolted onto `comp:obj` would mark
 * the transitive uses as well.
 *
 * **So the split is drawn where the treebank does draw one**, on the governor's
 * own features, and it moves 20 corpus edges:
 *
 *  - **`VerbType=Cop` keeps と.** 爲 is 〜と爲す / 〜と爲る in kundoku, and that
 *    is not a default being left alone for want of evidence — 不以飲爲累 is
 *    飲を以て累**と**爲さず, the settled reading, and it is in the reader's own
 *    text. This is the 96% case.
 *  - **`Degree=Equ` keeps と too**, and this branch declines to touch it: 如/奈's
 *    `comp:pred` is 何 218 times out of 210 edges' worth of 如何/奈何, a fixed
 *    interrogative read いかん whose 何 is part of the idiom rather than a
 *    case-marked complement. The same feature `isComparativeYu` already keys the
 *    comparison sense on.
 *  - **Everything else takes に** — a predicative complement under a governor
 *    the treebank does *not* mark as the copula or the comparison, which is what
 *    a verb of becoming or arriving is.
 *
 * **What this is for, said plainly.** 20 gold edges is small, and the rule's
 * real work is on the reader's own tree: 甕中貯水、入蟲攪之、即成佳釀 wants
 * 佳釀**に**成る, and the way to get it is to label 釀 `comp:pred` of 成 —
 * which is SUD's relation for exactly that, a predicative complement — rather
 * than the `comp:obj` it now carries, where it is indistinguishable from
 * 成其術's real object. That is an annotation, and it is named in the report
 * rather than guessed at from a lemma here. */
function predicativeComplementParticle(governor: Token | undefined): string {
  if (!governor) return PREDICATIVE_PARTICLE;
  const features = parseMorphFeatures(governor.morph ?? "");
  if (features.VerbType === "Cop" || features.Degree === "Equ") return PREDICATIVE_PARTICLE;
  if (governor.xpos.startsWith(COPULA_XPOS) || governor.xpos.startsWith(COMPARISON_XPOS)) return PREDICATIVE_PARTICLE;
  return BECOMING_PARTICLE;
}

/** True when `token` is the **predicative complement of a verb of becoming**
 * and is not a nominal — the shape whose 連用形 `decideConjForm` writes.
 *
 * The reader: *貧 still isn't in 連用形 when used as a complement of 適; this
 * should generally be the case for predicative complements of verbs of
 * becoming.* That is the same instruction as the earlier one this file already
 * carries out — *such complements should end in に* — read one level up: に **is**
 * the ナリ活用 paradigm's 連用形, and a ク活用 descriptive's 連用形 is 〜く. So
 * 適以益貧 wants 貧**しく**, not the 終止形 貧し the sentence ends on today, and
 * both answers are the one form.
 *
 * **Which governors count as verbs of becoming is not a new list**, and
 * deliberately not: it is `predicativeComplementParticle`'s own split, asked
 * again here so that the form and the particle cannot come apart — the
 * discipline `isNominalizedObjectPredicate`, `isNominalizedSubjectPredicate`
 * and `isNominalizedObliquePredicate` each follow with their own particle. That
 * split is measured in that function's doc and drawn on the governor's features
 * rather than on a lemma set: `VerbType=Cop` / `v,動詞,存在,存在` is the copula
 * 爲 and keeps と (飲を以て累**と**爲さず), `Degree=Equ` / `v,動詞,行為,分類` is
 * the comparison 如/奈 and keeps と, and **everything else is a verb of becoming
 * or arriving** — which is what 適 (`v,副詞,頻度,偶発`), 成, 化 and the rest come
 * back as. A lemma list was considered there and rejected on the evidence: no
 * tag in the treebank separates 適齊 ("goes to Qi") from 去仁 ("abandons
 * benevolence"), so a list of becoming-verbs bolted onto `comp:obj` would mark
 * the transitive uses too. `comp:pred` is the relation that already means
 * "predicative complement", and reading it is the whole of the rule.
 *
 * **Two exclusions, each because another rule owns the token.**
 *
 *  - **A nominal.** A NOUN/PROPN/PRON complement has no paradigm of its own and
 *    is handed the copula's 連用形 as a *particle* — the に
 *    `caseParticleFor` writes off `BECOMING_PARTICLE`, 成佳釀 -> 佳釀に成る.
 *    Returning 連用形 here as well would put a second に after it.
 *  - **A verb of communication.** A `comp:pred` under 曰/云/言/謂 is a reported
 *    proposition, not a state something comes to be in, and
 *    `isUnquotedSpeechComplement` / `namingComplementParticle` already answer
 *    for it (連体形 + を, or と). `predicativeComplementParticle` does not
 *    exclude them because the 20 corpus edges it moves are too few to matter to
 *    a particle; a *form* has to say so.
 *
 * **Reach, measured over `lzh_kyoto-sud-{train,dev,test}` (86,239 sentences).**
 * `comp:pred` is carried 2,907 times; **10** of those have a governor that is
 * neither the copula nor the comparison, and of those 10 the dependent is a
 * nominal 5 times. So this rule reaches **5 gold edges** — 以…卯 (SYM), 教之
 * (SCONJ), 求…於 (ADP), 使…得 (AUX), 使…爲 (ADP) — every one of them a function
 * word with no paradigm to inflect. Its real work is on the reader's own tree,
 * where 貧 is `comp:pred` of 適, and that is said plainly rather than dressed up:
 * the corpus does not exercise this rule and cannot vouch for it. */
export function isBecomingComplement(token: Token, sentence: Sentence): boolean {
  if (token.dep !== "comp:pred") return false;
  if (NOMINAL_PREDICATE_POS.has(token.pos)) return false;
  const governor = sentence.tokens.find((t) => t.id === token.head && t.id !== token.id);
  if (!governor || isCommunicationVerb(governor)) return false;
  return predicativeComplementParticle(governor) === BECOMING_PARTICLE;
}

/** `v,動詞,存在,存在` — the treebank's class for the copula 爲, and the column
 * that carries the same fact `VerbType=Cop` does.
 *
 * **Both columns are read, not one**, on `isComparativeYu`'s pattern and for
 * the reason its own doc gives: this parser does not always emit the feature.
 * The reader's own 不以飲爲累也 is the case that proved it — its 爲 comes back
 * `v,動詞,存在,存在` with an **empty** FEATS column, so a `VerbType=Cop` test
 * alone read it as a becoming verb and turned the settled 飲を以て累と爲さず
 * into 累に爲さず. The counts are the same whichever column is read:
 * `VerbType=Cop` is carried 5,580 times over `comp:pred` and
 * `v,動詞,存在,存在` 5,580 times, on the same edges. */
const COPULA_XPOS = "v,動詞,存在,存在";

/** `v,動詞,行為,分類` — the class for the comparison 如/奈, which `Degree=Equ`
 * also marks (214 `comp:pred` edges under each). The same tag
 * `isComparativeYu` reads for the same purpose. */
const COMPARISON_XPOS = "v,動詞,行為,分類";

/** 曰/云 (duplicated from `depClassification.ts`'s own `SPEECH_VERB_LEMMAS`
 * rather than imported — that module already imports from this one, so the
 * reverse import would cycle). A *naming* complement of one of these verbs
 * (名曰軒轅, "[his] name was Xuanyuan" — as opposed to a *quoted* complement,
 * which `depClassification.ts`'s `isSpeechQuoteComplement` keeps out of the
 * ordinary invert/particle machinery entirely) takes と if it's a proper
 * noun (軒轅と曰う, naming a specific person/place) or を if it's a common
 * noun (曰う takes an ordinary direct object the way any other verb's
 * comp:obj would) — replacing `CASE_PARTICLE_FOR_DEP`'s own blanket を for
 * comp:obj / と for comp:pred rather than adding to it, so a token is never
 * marked with both at once. */
const NAMING_VERB_LEMMAS: ReadonlySet<string> = new Set(["曰", "云"]);

/** Whether a sentence-final discourse particle hangs off this token — 也 on
 * 蟲 in 曰：「此酒蟲也。」, 乎 on 有 in 豈飲啄固有數乎.
 *
 * What it settles is whether the token *heads a clause*. A sentence-final
 * particle is a predication's own closing mark: nothing in Literary Chinese
 * puts 也 or 乎 after a bare name, so a nominal carrying one is not being
 * named, it is being asserted — 此れ酒の蟲なり, "this is the wine worm". That
 * is the fact `namingComplementParticle` and `caseParticleFor` below both
 * need and neither could see, since both were reading only the complement's
 * own POS.
 *
 * Any of the particles the table knows counts, read or unread: 矣 renders as
 * nothing at all (see `SENTENCE_FINAL_PARTICLES`) and still marks the clause
 * it closes. The relation is the parser's own **`discourse@sp`**, which is how
 * every one of them attaches — see `isSentenceFinalParticleUse` below, where
 * the census that separates that relation from bare `discourse` is set out.
 * This once admitted bare `discourse` too, which let a *sentence-initial* 夫
 * report its own clause as asserted; it is narrowed here for the reason it is
 * narrowed there, and because all three call sites have to mean one thing by
 * "this clause carries a sentence-final particle". Rendered over the whole gold
 * with the wider test and with this one, no passage of the 624 changes by a
 * character — 夫's 495 sentence-initial tokens hang off predicates that are
 * asserted or not on their own account — so this is the same answer stated
 * once instead of two ways. */
function hasSentenceFinalParticle(token: Token, sentence: Sentence): boolean {
  return sentence.tokens.some(
    (t) =>
      t.head === token.id &&
      t.id !== token.id &&
      t.dep === "discourse@sp" &&
      SENTENCE_FINAL_PARTICLE_LEMMAS.has(t.lemma) &&
      // **Except the 也 of `AB也者`**, which wears `discourse@sp` in 66 of its 80
      // gold tokens and closes nothing: it is the copula なる standing
      // attributively before 者, so the 者 heads a topic phrase and not an
      // asserted clause. Left in, this claimed the frame's own 者 — 禮也者，
      // 合於天時 came out 禮をなり者、…, the 者 stripped of the は its `subj`
      // relation owes it because the clause was reported as already closed. See
      // `isPresentativeCopula`.
      !isPresentativeCopula(t, sentence),
  );
}

/** Whether this token is one of `SENTENCE_FINAL_PARTICLES` *being used as
 * one*, as against a character that also spells a content word.
 *
 * 乎/也/矣/哉/夫/焉/耳 arrive tagged `discourse@sp` and need no
 * further evidence. 否 is the case that does: it is a real verb as well as a
 * particle (否む, "to refuse"), and this parser reads it as the verb — in
 * 君飲嘗不醉否？ it comes back VERB/`comp:obj` of 醉, which is what put a を
 * on it. Position is the discriminator, and the only one available: a
 * sentence-final particle stands last, so a 否 with nothing after it but
 * punctuation is closing the question, while 然歟否歟？'s 否 (which has a 歟
 * after it and is the sentence's own ROOT) is the verb and must stay one.
 *
 * Used here to keep a case particle off it — see `caseParticleFor` — and, in
 * both panels, to let it actually *read* や. Each routes a particle to
 * `sentenceFinalParticle` from a branch keyed on `dep === "discourse@sp"`,
 * which a token caught by position has not got, so this test stands beside that
 * dep test in `generator.ts` and in `KundokuView.ts`. Beside and not instead
 * of: the dep test admits every `discourse@sp` token including lemmas the table
 * does not know, and narrowing it to this predicate would change how those
 * render.
 *
 * **`discourse@sp` and not bare `discourse`, which are two different relations
 * and were being read as one.** The `@sp` half of the label is the parser's own
 * word for *sentence particle*, and over the recoded gold
 * (`lzh_kyoto-sud-{train,dev,test}.relabeled_ext.udep_ruled.punct.rulemerged.adjfix.conllu`)
 * the two do not overlap for any lemma in the table but one: 也 (7,317), 矣
 * (1,850), 乎 (893), 焉 (561), 哉 (334), 與 (189), 耳 (165), 邪 (69), 耶 (38)
 * and 歟 (19) are `discourse@sp` and *never* bare `discourse`, while **夫 is
 * bare `discourse` 499 times against 29 `discourse@sp`** — and 495 of those 499
 * do not stand last in their clause. Bare `discourse` in this treebank is the
 * *sentence-initial* discourse marker, and its 826 tokens are 夫 499, 其 171,
 * 蓋 67 and a tail of INTJ (嗟 17, 羌 16, 蹇 6, 嗚 5, 噫 4): none of them a
 * particle closing anything.
 *
 * **What that cost was 夫 read as かな at the head of its own sentence.** 夫 is
 * two words on one character — それ introducing a topic, かな exclaiming at the
 * end — and reading `discourse` and `discourse@sp` alike gave the first of them
 * the second's word: 夫仁者己欲立而立人 came out **かな**仁なる者は…, and
 * 夫如是則四方之民 **かな**是の如ければ…, against the received 夫れ仁者は and
 * 夫れ是くの如くなれば. 14 gold passages had it. The 171 其 and 67 蓋 were
 * silenced rather than mis-read — a lemma the table does not know renders as
 * nothing from that branch — so 堯舜其猶病諸's 其 and 蓋有不知而作之者's 蓋
 * simply vanished off the page.
 *
 * The parser says the same thing a second way, in the tag it hangs beside the
 * relation: bare `discourse` carries `p,助詞,**句頭**,*` in 751 of its 826
 * tokens and `discourse@sp` carries `p,助詞,**句末**,*` in 12,876 of its
 * 13,047. Sentence-head and sentence-end, named as such. Keyed on the relation
 * rather than on the tag because the relation is what every other branch in
 * this file is keyed on, and because the two agree.
 *
 * Narrowing sends all three to the reading resolver instead, which has had the
 * right answer for them all along and could not be reached: `overrides.json`
 * reads a PART 夫 それ, a PART 其 それ and a PART 蓋 けだし. Measured over the
 * 624 gold passages the narrowing is worth **38 edits** (15,132 -> 15,094),
 * with the two panels moving together because both take this same test.
 *
 * **Rendered over the whole gold treebank both ways**, **845** of the 68,893
 * sentences change and every change is one of these:
 *
 *     499  かな -> 夫れ     the sentence-initial 夫, which is the whole of it
 *     168  ∅   -> 其れ     the 語気 其, silenced where it stood
 *      67  ∅   -> 蓋し     蓋, the same
 *      26  それ -> 夫れ     `overrides.json`'s flag, not this test — see there
 *      45  ∅   -> 嗟/羌/嗚/噫/咨 …  the INTJ tail, now printing its character
 *      15  ∅   -> 蹇る/謇る/惡し/云ふ/逝く/載せる/只/侯/聿/疇 …
 *
 * The last row is the honest cost of the narrowing and is left standing: these
 * are bare-`discourse` lemmas no curated table names, so the resolver gives
 * them an ordinary lexical reading where the branch used to give them nothing.
 * 15 tokens in 68,893 sentences, none of them in the kanbun.info corpus, and a
 * reading nobody wants is a thing a reader can see and correct — where silence
 * is not.
 *
 * The three uses have to agree — a 否 read や with a を in front of it, or read
 * や in one panel and 否ム in the other, is the split this arrangement exists
 * to make impossible — which is why all three ask this one function rather
 * than each testing the position for itself. */
export function isSentenceFinalParticleUse(token: Token, sentence: Sentence): boolean {
  if (!SENTENCE_FINAL_PARTICLE_LEMMAS.has(token.lemma)) return false;
  if (token.dep === "discourse@sp") return true;
  // A bound suffix closing a binom is not the particle, wherever in the
  // sentence the binom happens to fall. 乎 and 焉 are in the table above *and*
  // in `TARI_SUFFIX_CHARS`, and 34 of 乎's 102 suffix-tagged tokens and 10 of
  // 焉's 36 stand last — so without this the same tag would read one way
  // medially (洋乎 ヨウコたり) and another way finally (…や), the character
  // conjugating by position rather than by what it is.
  //
  // Below the dep test and never in front of it, which is what keeps
  // 不亦說乎 intact: that 乎 is `discourse@sp` and has already been answered
  // yes two lines up. `isTariSuffix` requires `dep === "unk"` besides, so the
  // two conditions cannot both hold and this only ever narrows the positional
  // fallback — exactly what the NOUN/PROPN guard below it does.
  //
  // The *group* is required, not the tag alone: a suffix character with no
  // stem to attach to (a sentence-initial one, 嗟乎's INTJ 嗟, 惡乎's
  // interrogative 惡) renders no binom, so there is nothing for this to
  // protect and its previous reading stands.
  if (isTariSuffix(token) && tariSuffixGroup(token, sentence)) return false;
  // The positional fallback rescues a particle the parser has read as a
  // *predicate* — 否む, the case it was written for. It must not commit the
  // opposite error for a particle whose rival sense is a nominal, and 耳 is
  // one: it is also the noun みみ, and a noun in object position stands last
  // in the source as a matter of course. 割其耳 comes back NOUN/`comp:obj`
  // and reads その耳を割る; position alone would make it 割るのみ, and would
  // take the を off it into the bargain (`caseParticleFor` asks this too).
  //
  // A token the parser has tagged NOUN/PROPN has been given a nominal reading
  // and a case particle to go with it, which is not the shape of a mis-tagged
  // particle. Nothing in the table is rescued out of that tag — 否's verb
  // reading is the only mis-tag this fallback has to undo.
  //
  // **PRON stands beside them, and it is 焉 that puts it there.** 焉 is four
  // words sharing a character (see `SENTENCE_FINAL_PARTICLES`' own note on it),
  // and one of them is the **fused 於之 pronoun** — "in it", "therein" — which
  // this parse tags PRON: 心不在焉 is 心**ここに**在らず, the received 大學 line,
  // and 大舜有大焉 大舜大なる有りここに. Over the recoded gold
  // (`lzh_kyoto-sud-{train,dev,test}.relabeled_ext.udep_ruled.punct.rulemerged.adjfix.conllu`)
  // **83** of 焉's 764 tokens are that pronoun — `udep` 55, `comp:obj` 21,
  // `mod@lmod` 5, `subj` 1, `comp:obl@lmod` 1 — and **48** of them (36 `udep`,
  // 12 `comp:obj`) stand last among the non-punctuation tokens, which is
  // precisely what the line below claims them by. Claimed, they took the
  // discourse branch and rendered as **nothing**, the 置き字 treatment that is
  // right for the particle and wastes a word here.
  //
  // The reasoning is the NOUN/PROPN one word for word: a PRON has been given a
  // reading of its own and a case particle to go with it, which is not the
  // shape of a mis-tagged particle. It is also the sharper statement in this
  // case — **焉 is 於之**, so the に in ここに is the 於 half of the fusion, its
  // slot is locative and can never be accusative, and the を that `comp:obj`
  // would otherwise write is wrong on the character's own account.
  // `overrides.json` reads a PRON 焉 as ここ + に for exactly that reason and
  // `ownReadingSuppliesCaseParticle` stands the second particle down; that
  // entry was written to pair with this line and was inert without it, both
  // panels taking the discourse branch before the resolver is ever consulted.
  //
  // **The 561 PART 焉 on `discourse`/`discourse@sp` are untouched** — they are
  // answered two lines up by the dep test and never reach here — so a 焉
  // standing last *as a particle* is still the unread 置き字 it was.
  if (token.pos === "NOUN" || token.pos === "PROPN" || token.pos === "PRON") return false;
  const meaningful = sentence.tokens.filter((t) => t.dep !== "punct");
  return meaningful.length > 1 && token.id === Math.max(...meaningful.map((t) => t.id));
}

/** Whether this token is a sentence-final particle **read as a word of the
 * sentence** — 乎 as や or か, 也 as なり, 耳 as のみ, 哉 as かな — as against a
 * character the panels render some other way.
 *
 * **What it decides is a slot, and only a slot**: the kana go *over* the
 * character as furigana rather than beside it as okurigana. That is the
 * reader's own ruling, recorded at length in `SENTENCE_FINAL_WORD_LEMMAS` —
 * *sentence-final particles should always carry furigana rather than
 * okurigana; they are content words* — and it says nothing about the prose,
 * which writes these particles in kana with the character dropped either way.
 *
 * **The two conditions are the two this app has always used to say "this token
 * is the particle", and they are not the same condition.** The relation admits
 * every `discourse`/`discourse@sp` token whatever its lemma;
 * `isSentenceFinalParticleUse` adds the one the parser mis-tags (否 as the verb
 * 否む) and refuses the ones whose rival sense is a noun (耳 as みみ, a 乎 that is
 * a タリ suffix). Then the lemma has to be one the table reads at all: 矣 renders
 * as the empty string and is deliberately in neither slot.
 *
 * **Exported because a *picked* reading has to land in the same slot as an
 * unpicked one**, and it did not. `KundokuView.ts` runs its hand-picked branch
 * above its discourse branch — a pick outranks every guess this app makes — and
 * that branch decided the slot from `chosenSpellsOutInProse` alone, which is
 * true of every PART. So a reader choosing **か** off 乎's furigana menu got か
 * *beside* the character, where the identical か chosen by the app for a 豈…乎
 * frame goes *over* it. One character, one reading, two slots, depending only on
 * who picked it. Both branches ask this now.
 *
 * Not asked by the prose panel, and it does not need to be: `generator.ts`
 * writes the bare kana for a discourse particle and `chosenSpellsOutInProse`
 * already makes its picked branch write the bare kana too, so the two agree
 * there without this. The divergence was the 訓読文's alone. */
export function readsAsSentenceFinalWord(token: Token, sentence: Sentence): boolean {
  // The presentative copula is admitted first, on the same footing and for the
  // same reason as the rest: なる is a word of the sentence standing where the
  // character stands, so it goes *over* 也 as furigana. It reaches this by a
  // frame rather than by a relation — 14 of the 80 wear `mod`/`comp:obj` and
  // would fail both tests below — and both panels route it into their discourse
  // branch by the same predicate. See `isPresentativeCopula`.
  if (isPresentativeCopula(token, sentence)) return true;
  if (token.dep !== "discourse" && token.dep !== "discourse@sp" && !isSentenceFinalParticleUse(token, sentence)) {
    return false;
  }
  return SENTENCE_FINAL_WORD_LEMMAS.has(token.lemma);
}

function namingComplementParticle(token: Token, governor: Token | undefined, sentence: Sentence): string | undefined {
  if (!governor || !NAMING_VERB_LEMMAS.has(governor.lemma)) return undefined;
  if (token.dep !== "comp:obj" && token.dep !== "comp:pred") return undefined;
  // A complement closed by a sentence-final particle heads a clause, not a
  // name, and this rule stands down for it — 曰：「此酒蟲也。」 is 曰はく、
  // 「此れ酒の蟲なり」と, where the naming heuristic was reading 蟲 as an
  // ordinary NOUN object and giving it を (此酒の蟲をなり曰ふ).
  //
  // This test wins over the POS test below, and has to: the POS test is a
  // proxy for "is this a name", and 也 is the source saying outright that it
  // is not. 名曰軒轅 — the pattern the rule exists for — has no such particle,
  // so nothing it was written to catch is lost.
  if (hasSentenceFinalParticle(token, sentence)) return undefined;
  // And the other thing that is not a name: a **quotation headed by a noun**.
  // 子曰：「巧言令色，鮮矣仁」！ has no sentence-final particle on 言 to stand
  // this rule down — 矣 sits on 鮮, inside the saying — so the POS test below
  // reached it and wrote を on the opening word of a quotation: 「巧言令色**を**、
  // 鮮なし仁」と. `isSpeechQuoteComplement` is the one place that tells a name
  // from an utterance, on the source's own bracket and the size of the
  // subtree, and it is asked here for the same reason `isSpeechComplement`
  // asks it — so that the particle this writes and the reading order the
  // reorder engine chooses cannot disagree about the same token.
  if (isSpeechQuoteComplement(token, { lemma: governor.lemma, xpos: governor.xpos, dep: governor.dep }, sentence)) {
    return undefined;
  }
  if (token.pos === "PROPN") return "と";
  if (token.pos === "NOUN") return "を";
  return undefined;
}

/** True when `token` (曰/云) is being used as a plain naming verb rather
 * than introducing reported speech — the same distinction
 * `namingComplementParticle` makes from the complement's own side, checked
 * here from the governor's side instead: does it have a NOUN/PROPN
 * comp:obj/comp:pred child at all. Used to choose `VERB_LEXICON`'s
 * `conjClass` (いふ, a real 四段ハ行 conjugation) over its `fixedReading`
 * (曰はく, which presupposes an actual quote follows) at the render call
 * sites in `generator.ts`/`KundokuView.ts`.
 *
 * **The question is asked of `isSpeechQuoteComplement` and of nothing else.**
 * 曰はく presupposes that the quote follows the verb in reading order, and that
 * file is what decides the order — so if this rule answered on separate
 * evidence the frame could be stranded after the clause it introduces
 * (此酒の蟲なり曰はく). One test settles both shapes a complement comes in:
 *
 *  - **A nominal.** A NOUN/PROPN complement is ordinarily a name — 名曰軒轅,
 *    the pattern this rule exists for — unless it carries a sentence-final
 *    particle, because nothing in Literary Chinese puts 也/矣/乎 after a bare
 *    name. 曰：「此酒蟲也。」's 也 is the source saying outright that 蟲 is
 *    asserted and not named, so that is 曰はく、「此れ酒の蟲なり」と where the
 *    bare POS test gave 曰ふ. 軒轅 carries no particle, which is exactly the
 *    discriminator, so it keeps 曰ふ.
 *  - **A clause.** A clausal complement is a quotation when the source
 *    brackets it and an ordinary object when it does not. 子曰：「學而時習之。」
 *    is bracketed and is 子曰はく; an unbracketed 曰有之 is これ有るを曰ふ, the
 *    same reading 言有之 has always had under a governor that was never
 *    exempt. This second half arrived with the bracket test, and it is why
 *    keying on the sentence-final particle alone is not enough: a particle
 *    says nothing about an unbracketed clause.
 *
 * `token` is handed in as the governor, which is what makes the two halves one
 * question — the complement's own evidence, read against the verb that governs
 * it. */
export function isNamingUse(token: Token, sentence: Sentence): boolean {
  if (!NAMING_VERB_LEMMAS.has(token.lemma)) return false;
  return sentence.tokens.some(
    (t) =>
      t.head === token.id &&
      t.id !== token.id &&
      (t.dep === "comp:obj" || t.dep === "comp:pred") &&
      !isSpeechQuoteComplement(t, token, sentence),
  );
}

/** The case particle `token` takes, if any — see `CASE_PARTICLE_FOR_DEP` —
 * plus:
 *
 * 1. Nothing extra on an adposition's own object: 藍 as comp:obj of 於
 *    inverts before 於 (see `depClassification.ts`'s `INVERT_DEPS`, which
 *    now includes `mod@lmod` unconditionally), and 於 itself supplies the
 *    complete より directly (`yuParts`) — 取之於藍 -> 藍より取り, never
 *    …藍をより…（を never applies to an adposition's object regardless —
 *    only a verb takes を）.
 *
 *    **Two adpositions are exceptions, and they are exceptions for one
 *    reason**: 於 read おいて and 為 read ために are read as *content words* —
 *    a verb form and a noun — so they do not carry case at all and what they
 *    govern has to be marked in front of them. 日中**に**於いて and
 *    人**の**ために. Both branches stand immediately above the adposition rule
 *    they carve out of; see `isLocativeYu` and `isPurposiveWei`.
 * 2. は for two narrow, structurally-distinctive topicalization patterns
 *    classical Chinese uses that a plain subject/object elsewhere doesn't
 *    reliably call for (this pipeline has no way to judge は/が/no-particle
 *    for an ordinary subject, so those are deliberately left unmarked):
 *    a. A `subj` whose sentence root is a modal auxiliary (可/能/etc. —
 *       see `AUXILIARY_LEMMAS`): 學不可以已 topicalizes its subject
 *       (學ぶは…べからず, "as for learning, ..."), the natural Japanese
 *       framing for "X cannot/must VERB".
 *    b. A `mod` carrying `Case=Loc` whose own governor is itself the
 *       sentence's `subj` — a dangling/fronted topic loosely attached
 *       ahead of the real subject rather than integrated as an argument of
 *       the main predicate (冰，水為之 -> 冰は水これを為し, "as for ice,
 *       water forms it" — 冰 modifies 水 the subject, it isn't the subject
 *       or object of 為 itself). `Case=Loc` on a modifier of a *noun*
 *       (rather than of a verb, its ordinary adverbial role) is itself the
 *       unusual, marked combination this keys off.
 *    c. The sentence root's `subj`, when the root has a `conj:coord`
 *       sibling predicate that itself carries `Degree=Pos` — the same
 *       stative-pivot signal `teOrShite`'s しかして keys off. A multi-clause
 *       sentence that pivots into a stative *assessment* is asserting that
 *       assessment about the same shared subject as the first clause (青取
 *       之於藍，而青於藍 -> 青は…取り…、しかして…青し, "as for blue: it's
 *       taken from indigo, AND it's bluer than indigo") — but a coordinate
 *       clause that's just a further *action* (not an assessment) doesn't
 *       reliably share its subject with the first clause this way (人不知
 *       而不慍: 慍's implicit subject is not necessarily 人 the way 青's
 *       second predicate's subject is definitely still 青 — 慍 carries no
 *       `Degree` morph, correctly leaving 人 unmarked, unlike 青/寒 who do).
 *       Suppressed when that subject already has its own incoming pattern-b
 *       topic (冰水為之，而寒於水: 為's conj:coord sibling 寒 does carry
 *       Degree=Pos, but 水 must NOT also get は — 冰 already claims the
 *       topic role via pattern b, giving 冰は水これを…, never 冰は水は…).
 *       Only one token per sentence ever gets は here. */
/** **An adjective standing immediately before the nominal it modifies** —
 * plain attributive modification, which classical Japanese writes with the
 * adjective's 連体形: 高き山, 良き馬, 賢しき人.
 *
 * **The rule has nothing to do until such a pair stops fusing**, which is why
 * it did not exist before. `findCompoundSpans` draws an adjacent
 * adjective-plus-noun pair as one cell group with one whole-word reading, so
 * the adjective never reached the conjugation pipeline and no form was ever
 * asked of it. That default is kept — the construction is far more often a
 * lexicalised title than a live phrase, and the counts are in that function —
 * but a **hand-picked reading on either member now stands the fusion down**,
 * so that the reader can select a kun reading for a modifying adjective and
 * have it appear. What that leaves behind is an adjective sitting before a
 * noun with nothing saying which form it is in: unattended, `decideConjForm`
 * fell through to its default and printed the 終止形, 高**し**山 — a
 * sentence-ending form in the middle of a noun phrase.
 *
 * The company it is kept in is the argument for it. `modifiesGenitiveZhi` and
 * `isNominalizerAhead` are the other two attributive environments, grouped
 * here for the reason written above them — what a predicate modifies binds
 * tighter than what it is coordinated with — and both are "a predicate
 * standing on a nominal, which is the definition of 連体形". This is the third
 * and the plainest: no の between them and no nominalizer after them, just
 * juxtaposition.
 *
 * **Three bounds, each doing work.**
 *
 *  - **Plain `mod`, never `mod@tmod`/`mod@lmod`.** Those are clause-level
 *    adverbials rather than NP-internal modification — the same division
 *    `findCompoundSpans` draws in its own attributive branch, and for the
 *    same reason.
 *  - **`ADJ`, and not `isDescriptiveToken`.** The wider test would take in the
 *    `Degree=Pos` **adverbs**, and one of those standing `mod` on a nominal
 *    has a settled treatment already: an ADV-tagged 形容動詞 is in its 連用形 by
 *    construction, which `adverbialCopulaEnding` writes directly and
 *    `pinnedKeiyoudoushi` names for a pinned one. Two rules answering that
 *    token differently is the drift this file exists to prevent, so this one
 *    is held to the tag that means *adjective* — which is also the reader's own
 *    word for what they are selecting a reading on.
 *  - **Adjacent in source order.** A genuine attributive modifier sits directly
 *    against its noun; a non-adjacent `mod` edge is some looser attachment, and
 *    a 連体形 written on one would claim a modification the source does not
 *    show. The third bound of its kind in this neighbourhood and the third on
 *    the same evidence.
 *
 * Below the negation and 使役/受身 rules at the top of `decideConjForm`, which
 * govern the form outright wherever they fire, and above the coordination and
 * 而 rules, whose 連用形 would leave the following noun with nothing modifying
 * it. */
function modifiesAdjacentNominal(token: Token, sentence: Sentence): boolean {
  if (token.dep !== "mod" || token.pos !== "ADJ") return false;
  const head = sentence.tokens.find((t) => t.id === token.head && t.id !== token.id);
  return !!head && token.id + 1 === head.id && isAdjacentNominalHead(head);
}

/** **What an adjective standing directly on it is attributive to**, for
 * `modifiesAdjacentNominal`. NOUN and PROPN are the two the rule was written
 * for; 者 is the third, and the only one the corpus adds.
 *
 * **Counted, POS by POS.** Over the kanbun.info parses, taking every ADJ
 * `mod` whose head is the very next token in source order — which is the
 * whole of what this rule fires on — the heads are: **NOUN 938, PART 123,
 * VERB 56, ADJ 32, PROPN 13, ADV 9, AUX 9, ADP 1, NUM 1**. Every one of the
 * 123 PART is **者**; 所, the other nominalizer this file names, does not
 * occur in the class at all. The rest are not nominals and are no business of
 * a rule about attributive modification.
 *
 * **者 takes the 連体形**, which the received text says outright: over
 * kanbun.info's 書き下し文 者 stands after **き 80** times against **し 4**, and
 * the 4 are the 連体形 of the past 助動詞 き (勝ちし所, 学びし所 and the like),
 * not an adjective's 終止形 — so an adjective before 者 is written き **80 to
 * 0**. The app wrote 廣**し**者 for 趙爽's 厚而廣者, where the reading is
 * 廣**き**者.
 *
 * **What this adds over `isNominalizerAhead`, which already answers 連体形 for
 * most of the same tokens**: that rule asks the *resolver* what it read 者 as,
 * because 者 also reads は, the topic marker, after which nothing is
 * attributive — and it declines outright where a caller passes no resolver.
 * This one is a fact about the tree and holds either way. The two cannot
 * disagree about the topic marker, which is what makes admitting 者 here safe:
 * a topic 者 is one a *bare noun or name* modifies (黃帝者), and this branch
 * is reached only from an **ADJ**. */
function isAdjacentNominalHead(head: Token): boolean {
  return head.pos === "NOUN" || head.pos === "PROPN" || (head.pos === "PART" && head.lemma === "者");
}

/** True for a `subj` token that's really a topicalized adjective, not a
 * true nominal subject — a `subj` feeding a `conj:coord` sibling of the
 * ROOT that itself carries Degree=Pos (敦, subj of 敏, in 長而敦敏，"[he
 * grew up] generous and quick") is two adjectives juxtaposed in apposition
 * ("generous, [and also] quick"), not subject-predicate — SUD just has no
 * dedicated relation for bare adjective coordination-by-juxtaposition and
 * lands on `subj` instead. Exported (not inlined in `caseParticleFor`) so
 * `readingResolver.ts` can also use it: real classical Japanese puts a
 * topicalized adjective in 連体形 (敦き, not the shuushikei 敦し, and
 * definitely not the modern い-adjective 敦い) even when — as here — this
 * parser doesn't tag the token itself Degree=Pos at all, only its sibling. */
export function isTopicalizedAdjective(token: Token, sentence: Sentence): boolean {
  if (token.dep !== "subj") return false;
  const root = findRoot(sentence);
  // **Not where the root is a verb of speech**, because then the stative is
  // not a coordinate of this clause at all — it is the first predicate of what
  // was *said*, hung on the speech verb by `conj:coord` the way a quotation's
  // content is. 子夏曰：「賢賢易色…」 has 賢 `conj:coord` of 曰 with `Degree=Pos`,
  // and this read it as a stative predication about 子夏 and wrote 子夏**は**曰く.
  //
  // The reader asked why some subjects of a speech verb take は and others do
  // not, and the answer was that nothing here knew 曰 was a speech verb: the
  // same name fell on both sides of the test according to whether the
  // treebank had attached the quotation as `conj:coord` (は) or as
  // `parataxis` (no は), and whether its opening predicate happened to be
  // stative. 子貢 got は in 學而 15 and none in 學而 10 for exactly that reason.
  //
  // **The received text settles it outright**: over kanbun.info's prose a
  // subject standing before 曰く is written bare **959** times and with は
  // **once** (君は曰く). So the は was spurious wherever this fired on a
  // quotation.
  if (root && isCommunicationVerb(root)) return false;
  return sentence.tokens.some(
    (t) => t.dep === "conj:coord" && t.head === root?.id && parseMorphFeatures(t.morph ?? "").Degree === "Pos",
  );
}

/** The relations that fuse a token into its head's *name* rather than
 * standing it beside one as a modifier (惠 in 梁惠王, 黃 in 黃帝). Kept as its
 * own local copy of `jmdictLookup.ts`'s `SPAN_FUSING_DEPS` rather than
 * imported from it: that set isn't exported, and `reading/jmdictLookup.ts`
 * already imports from `kakikudashi/rereadCharacters.ts`, so reaching back
 * the other way for one constant would knot the two layers together for no
 * gain. Used only to let a genitive modifier see *past* its head's own
 * name-mates — see `genitiveNoParticle`. */
const NAME_FUSING_DEPS: ReadonlySet<string> = new Set(["compound", "compound@redup", "flat", "flat@vv", "flat@foreign"]);

/** The nouns a state name stands on **with no の between them** — 楚人, 秦王,
 * 周公, 齊君. See `isStateNameOnItsPeople`. */
const STATE_PEOPLE_NOUNS: ReadonlySet<string> = new Set(["人", "王", "公", "君", "后", "子"]);

/** True for a state name standing directly on a noun for **its people or its
 * ruler**, which kundoku reads as one word with no particle: 楚人 is 楚人, 齊人
 * is 齊人, 秦王 is 秦王.
 *
 * **This reverses a deliberate decision**, and the note on
 * `genitiveNoParticle` below used to give 楚人 -> 楚の人 and 秦王 -> 秦の王 as the
 * examples the rule was built for. The received readings say otherwise. Over
 * kanbun.info's 3,419 passages, every `NameType=Nat` PROPN standing `mod` or
 * `compound` on the token directly after it, against whether the received
 * 書き下し文 writes the pair bare or with の:
 *
 *     bare:  人 26 of 26, 王 42 of 43, 子 16 of 16 (呉子), 公 10 of 11 (周公),
 *            后 6 of 6 (夏后氏), 君 2 of 3 (齊君, 衞君)
 *     の:    將 6 of 6 (燕の将, 趙の将), 師 4 of 4, 壁 3 of 3, 性 4 of 4,
 *            宮 2 of 2, 民 2 of 2, 兵 (楚の兵, 漢の兵), 軍 12 of 22
 *
 * kanbun.info gives the reason in its own note on 齊人: a state name before 人
 * is read ひと directly, as one word. The one の on 王 is 趙の王将, where 王 is
 * the first half of 王将 and not the king, and the one on 公 is 齊の公子, the
 * same shape with 公子. So the line runs between the people and rulers a state name
 * identifies (the man of Qi, the king of Qin, the Duke of Zhou) and the
 * things it owns (its army, its walls, its generals), which take の like any
 * other genitive. 將 falls on the second side although a general is a person:
 * that is the count, and the rule follows the count.
 *
 * **Adjacent pairs only.** 梁惠王 is 梁の惠王 still: 惠王 is a name of its own,
 * and 梁 stands on it from outside.
 *
 * **Only the particle is withheld; the pair is not fused into one span.**
 * `findCompoundSpans` still keeps a `NameType=Nat` compound apart, and a `mod`
 * over 人 was never fused, so each character keeps the furigana it resolves
 * to alone: 楚 そ over 人 ひと, 齊 せい over 人 ひと, 秦 しん over 王 わう. Those
 * are the readings kanbun.info's ruby gives the same pairs (斉人 せいひと,
 * 秦王 しんおう), and 人 in particular must stay ひと, which a span drawn
 * through `compoundFurigana` would turn into on'yomi.
 *
 * **Not subsumed by `isJuxtaposedNominalTerm`**, which came later and takes
 * the general case this is a corner of. That rule leaves a `NameType=Nat`
 * modifier holding its の — 趙の軍, 秦の宮, on a count of 59 to 31 — so this
 * remains the only thing standing between 楚 and 人. */
export function isStateNameOnItsPeople(token: Token, sentence: Sentence): boolean {
  if (token.pos !== "PROPN" || parseMorphFeatures(token.morph ?? "").NameType !== "Nat") return false;
  if (token.dep !== "mod" && token.dep !== "compound") return false;
  const head = sentence.tokens.find((t) => t.id === token.head && t.id !== token.id);
  if (!head || head.id !== token.id + 1 || (head.pos !== "NOUN" && head.pos !== "PROPN")) return false;
  return STATE_PEOPLE_NOUNS.has(head.text) || STATE_PEOPLE_NOUNS.has(head.lemma);
}

/** **Two nominals written side by side are one term, and take no の** — 玄象,
 * 晷儀, 渾天, 蓋天, 昊天, 周髀, 景行, 軌轍, 堂室, where this wrote 玄の象, 晷の儀,
 * 渾の天. Nothing stands between the two in the source, and the received
 * reading writes nothing between them either.
 *
 * **This inverts the default in `genitiveNoParticle`, and the count is what
 * inverts it.** Taking every token that function answers の for over
 * kanbun.info's 3,419 passages — 2,559 of them — and asking whether the
 * passage's received 書き下し文 writes the run of characters from the modifier
 * to its head bare or with a の after the modifier:
 *
 *     the modifier stands directly before its head:  の 251, bare 1,972, neither 303
 *     the modifier reaches past something:           の  28, bare     1, neither   4
 *
 * So **adjacency is the whole of the distinction**, and it runs the opposite
 * way at each end: juxtaposition is 89% one term, and a `mod` edge that has to
 * reach over an intervening token (梁惠王, 孔子弟子 — see `NAME_FUSING_DEPS`)
 * is 28 of 29 a genitive. The examples the old doc gave divide on exactly
 * that line: 梁の惠王 keeps its の and 楚の兵 loses it.
 *
 * **977 of the juxtaposed pairs never reach this rule at all** — the
 * lexical-word branch in `findCompoundSpans` has already fused them, on the
 * strength of a JMdict headword read on'yomi throughout (門人 もんじん, 天道
 * てんだう, 先帝 せんてい), and a fused span has no room for a particle between
 * its halves. That branch is right (906 of the 977 bare in the received
 * reading, 38 with の) and is left exactly as it is. What it cannot reach is a
 * term no modern dictionary lists: JMdict holds none of 周髀, 玄象, 晷儀, 渾天,
 * 蓋天, 昊天, 景行, 軌轍, 堂室. The **1,549** pairs left over are what this
 * covers, 1,066 of them bare in the received reading against 213 with の.
 *
 * **Suppressing the particle is not the same as fusing the span, and only the
 * particle is taken here.** Fusing 周髀 would also buy the furigana しうひ over
 * the pair instead of しう and ひ over its halves, which is the reading the
 * term wants. But a span is drawn as one cell group whose furigana
 * `compoundFurigana` forces to on'yomi, and there is no evidence to drive it:
 * the dictionary that would license the fusion is precisely the one that does
 * not hold these words, so fusing would mean guessing from the relation alone
 * — the thing `SPAN_FUSING_DEPS` in `jmdictLookup.ts` records as tried and
 * reverted. It would also reach 中人, 山中 and every other locative pair in the
 * 1,972, whose halves are read kun and must stay so. The prose is fixed here,
 * on a count of the prose; the furigana is left for a change that measures the
 * furigana.
 *
 * **A state name is the one modifier that keeps its の**, which is why
 * `isStateNameOnItsPeople` is not subsumed by this and both rules stand. Of
 * the juxtaposed pairs this would otherwise reach, those whose modifier is
 * `NameType=Nat` go の **59** times against bare **31** — 趙の軍, 燕の將, 秦の宮,
 * 齊の師, 楚の兵, 漢の兵, 夏の禮 — because a state name on a common noun really
 * is a possessor. (The 31 are mostly a state with the *name* of its ruler,
 * 齊桓, 晉文, 秦穆, or a state with its own land, 楚國, 趙城, 梁下.) So the state
 * arm is kept whole, `isStateNameOnItsPeople` goes on naming the heads where
 * even a state name goes bare (人 王 公 君 后 子), and the two rules now read as
 * one graded statement: a juxtaposed pair is one term, unless the first half
 * names a state, unless what it stands on is the people or the ruler of that
 * state.
 *
 * **The price, named.** The 213 pairs that do take の and lose it are spread
 * thin — no head accounts for more than ten — and the heads with any weight at
 * all are 時 (の10 / 連4), 父 (9/2), 子 (9/6), 軍 (18/24, nearly all state names
 * and so untouched), 道 (8/12), 禮 (6/3). A curated list of head nouns could
 * take back a few dozen of them; nothing in the tree can, and picking heads
 * off a corpus this size would be fitting noise. The 89% is the rule.
 *
 * Restricted to `mod`: `compound` on a nominal pair is the treebank's label
 * for a fused *name* (黃帝, 惠王), which never took a の here anyway, and for the
 * state-name case that the arm above keeps. */
export function isJuxtaposedNominalTerm(token: Token, sentence: Sentence): boolean {
  if (token.pos !== "NOUN" && token.pos !== "PROPN") return false;
  if (token.dep !== "mod") return false;
  if (parseMorphFeatures(token.morph ?? "").NameType === "Nat") return false;
  const head = sentence.tokens.find((t) => t.id === token.head && t.id !== token.id);
  if (!head || head.id !== token.id + 1) return false;
  return head.pos === "NOUN" || head.pos === "PROPN";
}

/** の on a nominal that modifies a following nominal **from outside it** —
 * 孔子弟子 -> 孔子の弟子, 梁惠王 -> 梁の惠王. Literary Chinese realizes no
 * genitive particle here at all; kundoku supplies one, exactly as it
 * supplies を and に elsewhere in this table.
 *
 * **A modifier standing directly on its head is not this**, and that is the
 * larger half of the rule: 玄象, 渾天, 軌轍 are one term apiece and take
 * nothing, on the 1,972-against-251 count set out in
 * `isJuxtaposedNominalTerm`, which is asked first. What is left for this
 * function is the edge that reaches *past* the head's own name-mates — 梁 over
 * 惠 to 王 — which the received readings write with の 28 times in 29.
 *
 * A common noun could once modify a common noun here too — 山中 -> 山の中, 門人
 * -> 門の人 — and the note that stood here defended it: a NOUN+NOUN `mod` is
 * often a fused jukugo (先帝 せんてい, 門人 もんじん) arriving on exactly the
 * edge 楚人 does, but withholding the の did not read those as jukugo, it
 * handed them to the fronted-topic rule below and 山中有虎 came out
 * 山は中虎を有り. **That argument was right about the danger and wrong about
 * the remedy**, and the danger is now closed at its source: the withholding
 * returns outright at the call site instead of falling through, so 山 reaches
 * neither the topic rule nor anything else, and `isExistentialLocus` below
 * puts the に on 中 — 山中に虎有り, which is how kanbun.info writes 山中 in the
 * two passages that have it (予譲、山中に遁逃して). Telling a real jukugo from a
 * genitive needs lexical evidence, not a POS; what the corpus says is that
 * juxtaposition *is* that evidence, 89% of the time.
 *
 * The state-name `compound` case is the one addition beyond `mod`. This
 * parser labels 國名+王 `compound` rather than `mod` (秦王/楚王/齊王/趙王 all
 * measured that way, against `mod` for the very same states over 人/兵), the
 * same label it gives a genuine fused name — 黃帝, 惠王. What separates them
 * is not the relation but `NameType`: 秦 is `NameType=Nat`, a *state*, while 黃
 * is `NameType=Giv` and 惠 `NameType=Prs` — personal-name elements, which fuse
 * into the name and must not be broken. Deliberately not extended to
 * `NameType=Geo` (安陵君, a fief title read as one word). This case once wrote
 * 秦の王 ("the king OF Qin"); the received readings write 秦王 bare 42 times in
 * 43, and `isStateNameOnItsPeople` now withholds the の there, so what the
 * `compound` arm still reaches is a state name on a noun outside that set.
 *
 * The modifier must also precede its head with nothing between the two but
 * the head's own name-mates, so 梁 reaches past 惠 to 王 while a `mod` edge
 * flung across half a sentence (盾 over 者, seven tokens away) is left
 * alone. */
export function genitiveNoParticle(token: Token, sentence: Sentence): string | undefined {
  if (token.pos !== "PROPN" && token.pos !== "NOUN") return undefined;
  if (isStateNameOnItsPeople(token, sentence)) return undefined;
  if (isJuxtaposedNominalTerm(token, sentence)) return undefined;
  const head = sentence.tokens.find((t) => t.id === token.head && t.id !== token.id);
  if (!head || (head.pos !== "NOUN" && head.pos !== "PROPN")) return undefined;
  if (token.id > head.id) return undefined;
  const isStateName = parseMorphFeatures(token.morph ?? "").NameType === "Nat";
  if (token.dep !== "mod" && !(token.dep === "compound" && isStateName)) return undefined;
  for (let id = token.id + 1; id < head.id; id++) {
    const between = sentence.tokens.find((t) => t.id === id);
    if (!between || between.head !== head.id || !NAME_FUSING_DEPS.has(between.dep)) return undefined;
  }
  return "の";
}

/** 有/無 — the existential predicates, "there is" and "there is not".
 *
 * Their argument structure is not a transitive verb's, and this is the whole
 * reason they need their own rule. 有 predicates *of* the thing that exists;
 * nothing is acted on, so the postverbal nominal is the existent (the notional
 * subject) and takes no を at all, while whatever stands *in front of* 有 is
 * the place or possessor it exists at, which Japanese marks に. 山中有虎 is
 * 山中に虎有り, and 謂其身有異疾 is その身に異疾有り — never …を…を有り,
 * which is what both were coming out as. (This wrote 山**の**中 when the rule
 * was added, on the genitive that then stood between any two nominals;
 * `isJuxtaposedNominalTerm` has since withdrawn it, and kanbun.info writes
 * 山中 both times it has the pair.)
 *
 * Keyed on the lemma plus a VERB tag rather than on the treebank's own
 * 存在 xpos class: every 有/無 measured in 酒蟲 and in the live parses of
 * 山中有虎／楚人有一妻／有朋自遠方來 carries `v,動詞,存在,存在`, so the xpos adds
 * no discrimination here, and requiring it would silently switch the rule off
 * for a hand-corrected tree that left the field out. 無 as a preverbal
 * converb ("without …ing" — 無損其富, tagged ADV) is not this: it takes no
 * complement of its own, so the VERB requirement is what tells the two uses
 * apart. */
const EXISTENTIAL_LEMMAS: ReadonlySet<string> = new Set(["有", "無", "无"]);

export function isExistentialPredicate(token: Pick<Token, "lemma" | "pos">): boolean {
  return EXISTENTIAL_LEMMAS.has(token.lemma) && token.pos === "VERB";
}

/** The place or possessor an existential 有/無 predicates at — the nominal
 * that takes に.
 *
 * What licenses it is *position*, not the relation: the existent follows 有
 * and the locus precedes it, so the nominal standing immediately before an
 * existential 有 is its locus however the parse labels that nominal. Two
 * labels are actually observed, and admitting both is what makes this general
 * rather than a fix for one sentence:
 *
 *  - 有's own `subj` — 山中有虎 (中), 楚人有一妻 (人). This is the ordinary
 *    shape, and the reading it gives (山中に虎有り) is the one a code comment
 *    in `genitiveNoParticle` above records as wanted and unreached. The の
 *    that comment wanted between 山 and 中 has since gone: the received text
 *    writes 山中 as one word, and `isJuxtaposedNominalTerm` withholds it.
 *  - a *sibling* of 有 under a shared governor — 謂其身有異疾, where 身 is a
 *    `comp:obj` of 謂 and so is 有. The parser has taken 謂 to have two
 *    objects; what the sentence has is one small-clause complement,
 *    謂[其身 有異疾], whose subject the parser raised onto the matrix verb.
 *    The two children are still adjacent and still in locus-then-existential
 *    order, which is the evidence this rule turns on either way.
 *
 * Adjacency is required in *source* order (ids are dense per sentence — see
 * `precededBySourcePunctuation`, which reads them the same way), so a nominal
 * flung across the sentence never picks this up, and 有朋自遠方來 — where 朋
 * *follows* 有 and is the `subj` of 來 — is untouched.
 *
 * Restricted to a nominal. 豈飲啄固有數乎 has 飲 (a VERB, with 啄 fused onto
 * it) as 有's `subj`, and a predicate standing there is a nominalized clause
 * rather than a place: 飲啄に would be a guess about what kind of argument it
 * is, where 中/人/身 are unambiguously loci. */
function isExistentialLocus(token: Token, sentence: Sentence): boolean {
  if (!NOMINAL_PREDICATE_POS.has(token.pos)) return false;
  const next = sentence.tokens.find((t) => t.id === token.id + 1);
  if (!next || !isExistentialPredicate(next)) return false;
  if (token.head === next.id) return token.dep === "subj" || token.dep.startsWith("subj@");
  return token.head === next.head && token.head !== next.id;
}

/** Whether this parser's coarse tag says the word is being used verbally.
 *
 * The treebank carries two categories per token and they disagree often
 * enough to matter: 醞 in 置良醞一器 ("set out one vessel of good wine") and 藥
 * in 問需何藥 are both tagged VERB in the UPOS column while their xpos is
 * `n,名詞,…` — nouns, which is what they are. The rule below is about a
 * *predicate* standing in an object slot, and a noun standing there is just
 * an object; taking the xpos as the tie-breaker keeps those two out.
 *
 * An absent xpos falls back to trusting the UPOS, so a tree written by hand
 * (or by another tool) behaves as it did before rather than switching the
 * rule off. */
function isVerbalXpos(token: Token): boolean {
  return !token.xpos || token.xpos.startsWith("v,");
}

/** The treebank's semantic class for verbs of communication — 曰, 云, 言, 問,
 * 謂, 答 all come back `v,動詞,行為,伝達`. What one of these governs is a
 * reported *proposition*, not a nominalized action, so it is read with と (or,
 * as here, left alone) and never with を: 或言「…成其術」 is …術を成すと言ふ,
 * not …成すを言ふ.
 *
 * This is `isSpeechQuoteComplement`'s distinction — which `depClassification.ts`
 * draws for 曰/云 by lemma, deliberately leaving 謂 out because 謂 also means
 * "to call X Y" — reached from the other side, through the class the treebank
 * itself assigns. Both are applied: the xpos generalizes to 言/問/謂, and the
 * lemma test keeps 曰/云 excluded even in a tree that carries no xpos. */
function isCommunicationVerb(token: Token): boolean {
  const xpos = token.xpos ?? "";
  // Both ends of the field are required, not `includes`. The class name is
  // reused across categories: 術 in 成其術 is `n,名詞,可搬,伝達` — a noun about
  // transmission, not a verb of it — and a bare substring test made it a
  // speech verb.
  return xpos.startsWith("v,動詞,") && xpos.endsWith("伝達");
}

/** True when `token` is a predicate standing where a noun would — the object
 * of another verb — and so is nominalized: 連体形, and を.
 *
 * 不得飲 is 飲むを得ず, not 飲む得ず. This is the same inference
 * `isNominalizerAhead` and `modifiesGenitiveZhi` already make for 者 and
 * genitive 之 (a predicate feeding a nominal slot is attributive); the only
 * difference is that here the nominal slot is an argument position with no
 * particle or nominalizer of its own realized in the source, so kundoku
 * supplies both the 連体形 and the を.
 *
 * Four exclusions, each from a shape in 酒蟲 that the bare relation gets
 * wrong:
 *
 *  - **A noun tagged VERB** (`isVerbalXpos`) — 置良醞一器, 問需何藥.
 *  - **A communication verb's complement** (`isCommunicationVerb`,
 *    `isSpeechQuoteComplement`) — a reported proposition, not an action
 *    nominal.
 *  - **An existential 有/無** (`isExistentialPredicate`). 謂其身有異疾's 有 is
 *    a `comp:obj` of 謂 exactly as 飲 is a `comp:obj` of 得, and it must not
 *    take を: 有 heads a complete predication ("there is X"), which is a
 *    proposition and never a thing obtained or done. This is the same
 *    "independent clausal complement" that `ASPECTUAL_VERB_LEMMAS` above
 *    records as having to stay 終止形.
 *  - **A non-verbal governor.** 解縛視之… attaches 如 to a 解 tagged PROPN;
 *    an object relation under a name is not a predicate taking a complement.
 *    The governor's xpos has to agree too, for the same reason the token's
 *    does — and this is the bound the standing 食肉飲酒歌舞 anchor turned out
 *    to need. There 歌 comes back UPOS VERB with xpos `n,名詞,可搬,伝達`, the
 *    noun "song", and 舞 hangs off it as `comp:obj`; without the test the
 *    anchor read 舞ふを歌ふ where it had read 舞ふ歌ふ. (Typed on its own, 歌舞
 *    comes back with a *verbal* 歌 and does still take the を — the parse
 *    calls 舞 an object of 歌 rather than the second half of a V-V compound,
 *    and that is a parse this app renders faithfully rather than second-
 *    guesses.)
 *
 * `comp:aux` is deliberately not admitted alongside `comp:obj`, and neither is
 * an AUX complement. 至不能給 hangs 能 (AUX) off 至 and 給 off 能: 能 is the
 * potential auxiliary, which `AUXILIARY_LEMMAS` renders as postposed kana with
 * the negation written after it, so a particle belonging to 能 would land
 * inside that chain (給ふべから+を+ず). See the report on this rule for what
 * 至's complement would actually need, which is に and a lexical fact about 至. */
/** Whether nothing hanging off `token` is read *after* it — so that anything
 * written onto this token's own piece really does close its clause.
 *
 * `caseParticleFor` writes its particle onto the token it is asked about, and
 * a quotative と has to fall at the end of the whole quoted span, not at the
 * end of its head word. For an ordinary case particle the difference never
 * shows: を marks the word it is on. For と it decides whether the rule is
 * usable at all, so the question is asked here rather than assumed.
 *
 * The movement rules are `depClassification.ts`'s own `classifyToken`, not a
 * second copy written here — a child that inverts is read before its head, one
 * that postposes is read after it, and one left where it stands is read after
 * only if the source put it there. Two panels quietly disagreeing about
 * reading order is a failure this project has had, and asking the one
 * classifier both panels' reordering already asks is what stops it.
 *
 * A 再読文字 hanging off the token blocks it too, and cannot be seen any other
 * way: 將 in 問將何用 stands *before* 用 and is read there, and then reads a
 * second time — んとす — after the clause 用 closes. Its second reading is no
 * token of its own for `classifyToken` to place (the same blind spot
 * `teOrShite` documents for a re-read's ず), so `isRereadUse` is asked
 * directly. Without it 用 came out 用ゐとんとす.
 *
 * Direct children only. A re-read governing this token from *above* attaches
 * as one of `REREAD_DEPS` — `mod`/`comp:aux`/`mod@tmod` — which makes it a
 * child of the predicate it governs, so it is seen here; a re-read further
 * down closes on its own governed clause, not on this one.
 *
 * **A word this token is *fused with* is not something read after it**, and
 * that is the one class exempted here rather than by a caller. 豈飲啄固有數乎
 * hangs 啄 off 飲 by `flat@vv` — 飲啄 is one word, the V-V compound "eating and
 * drinking" — and 飲 is 有's `subj`, so the whole compound is a nominalized
 * clause and takes こと. Counting 啄 as a following word made 飲 not the last
 * thing read in its own subtree, `isNominalizedSubjectPredicate` stood down,
 * and the こと was **not written at all**.
 *
 * Where the こと then lands is already settled and is not this function's to
 * decide: both panels ask `caseParticleFor` about the span's **carrier** (the
 * member holding the relation, 飲) and emit what it returns after the span's
 * **last member** (啄), which is the same carrier/last-member split
 * `compoundSuruOkurigana` and `nominalCoordinationChain` make. So the answer
 * comes out 飲啄**こと**, never 飲**こと**啄, with nothing added here or there.
 *
 * `NAME_FUSING_DEPS` and not a wider set: those are the relations that make two
 * tokens one word (`flat`, `flat@vv`, `compound`, …), which is exactly the
 * claim being made — not that the child is unimportant, but that it is *this
 * word*. Over `lzh-{train,dev,test}.sud.conllu` a VERB standing on `subj` has a
 * `flat@vv` child **1,012** times (進退, 富貴, 長幼, 陶冶, 險阻 — every one of
 * them a binomial compound), and all 1,012 are this shape.
 *
 * `skip` exempts a child from the count — one caller passes it, and for one
 * child: a postposed negation, which is read after its predicate but is *not*
 * something written after the particle. It closes the clause itself, and so
 * carries the particle instead of blocking it. See `negationEnding`. */
function readsLastInItsSubtree(token: Token, sentence: Sentence, skip?: (child: Token) => boolean): boolean {
  return !sentence.tokens.some((child) => {
    if (child.head !== token.id || child.id === token.id || child.dep === "punct") return false;
    if (NAME_FUSING_DEPS.has(child.dep)) return false;
    if (skip?.(child)) return false;
    if (isRereadUse(child, sentence)) return true;
    const movement = classifyToken(child, token);
    if (movement === "postpose") return true;
    return movement === "no-invert" && child.id > token.id;
  });
}

/** と on the predicate a verb of speech reports — 劉答言無 is 劉答へ「無し」と
 * 言ふ, never 無し言ふ.
 *
 * This is the carve-out from `isNominalizedObjectPredicate` below, and it is a
 * branch rather than a swap of particle: a quoted clause is not nominalized at
 * all. Classical と takes the 終止形 (「行く」と言ふ), where a nominalized object
 * takes the 連体形 (飲むを得ず), so the exception has to keep the form as well
 * as change the particle. It does so by construction — the same
 * `isCommunicationVerb` that gates this keeps the governor out of
 * `isNominalizedObjectPredicate`, which is what would otherwise have given the
 * 連体形 — and there is nothing further to do for the form.
 *
 * **What counts as a speech verb** is the treebank's own class, not a lemma
 * list: 曰/言/謂/問 all come back `v,動詞,行為,伝達` in 酒蟲, and so does the 答 of
 * 劉答 (which governs nothing there — the parser fuses it into the name).
 * `depClassification.ts` keeps a lemma set of two, 曰 and 云, and says in its
 * own doc that it leaves 謂 out because 謂 also means "to call X Y"; the tag
 * settles that case from the parse instead of from a guess, and generalizes to
 * 言 and 問 without anything to maintain.
 *
 * **What counts as heading a quoted span** is the quotation marks — see
 * `isQuotedSpeechComplement`, which is the whole of the と/を decision now.
 *
 * This reverses what stood here. The note it replaces argued that the marks
 * could not carry it, on two grounds: that this parser splits a sentence at
 * every stop, so 酒蟲's closing 」 repeatedly ends up as a sentence of its own
 * (sent_id 7, 9, 11, 13 are each a lone bracket); and that Literary Chinese
 * writes most reported speech with no marks at all. The first is true and
 * turns out not to matter — the *opening* bracket is never split off, since
 * it stands inside the quoted sentence rather than after it, and one edge of
 * the span is all this needs. The second is also true and is now answered
 * rather than worked around: an unbracketed complement is not a quotation,
 * and takes 連体形 + を instead (`isUnquotedSpeechComplement`). 謂其身有異疾
 * has no marks and no longer takes と — その身に異疾有るを謂ふ.
 *
 * Two things hold it back:
 *
 *  - **A quote `reorderEngine.ts` already closes.** `isSpeechQuoteComplement`
 *    marks the last token of the quote's own reading order and the panels
 *    write と there (`ReadingPlan.quoteEndIds`), which is the *right* place and
 *    the one this function cannot reach. Where that machinery fires, this
 *    stands down rather than writing a second と — 曰：「易耳。」 is 易きのみと,
 *    with the と on the 耳 that follows 易, and adding one to 易 gave 易しとと.
 *  - **A complement that is not the end of its own quote**
 *    (`readsLastInItsSubtree`). This rule can only write onto the head word,
 *    so where something is still read after it the と would land inside the
 *    quotation.
 *
 * The second bound is what keeps this honest about being the smaller rule.
 * Widening `depClassification.ts`'s `SPEECH_VERB_LEMMAS` to this same 伝達
 * class would put every case on the machinery that gets the position right,
 * and would need no bound at all — see the report; that file belongs to
 * another owner. */
export function quotativeParticleFor(token: Token, sentence: Sentence): string | undefined {
  if (!isSpeechComplement(token, sentence)) return undefined;
  const governor = sentence.tokens.find((t) => t.id === token.head && t.id !== token.id);
  // The sentence goes in, so that this asks the same question of the same
  // complement that `reorderEngine.ts` does. What it is standing down for is a
  // と that machinery is already writing, and that machinery now applies the
  // bracket test — so a *bracketed* complement must still come back true here
  // or the two と double up (有りとと), while an *unbracketed* one must come
  // back false so the next line can send it to を. No constant answers both,
  // which is why the parameter exists rather than a default.
  if (isSpeechQuoteComplement(token, governor, sentence)) return undefined;
  if (!isQuotedSpeechComplement(token, sentence)) return undefined;
  return readsLastInItsSubtree(token, sentence) ? "と" : undefined;
}

/** The shape both the quoted and the unquoted rule share: a *clausal*
 * complement of a verb of speech.
 *
 * `comp:obj`/`comp:pred`, the two relations a speech verb's complement lands
 * on, and not a NOUN/PROPN — a nominal there is a name, which
 * `namingComplementParticle` answers for (名曰軒轅). The governor is one the
 * treebank classes as a verb of communication (`isCommunicationVerb`), which
 * covers 曰/云/言/謂/問/答 by their shared xpos rather than by a lemma list.
 *
 * **敎 is a verb of communication and also a 使役 character, and what it
 * governs cannot be both.** The treebank writes `v,動詞,行為,伝達` on **188** of
 * 敎's 202 VERB tokens (the other 14 are `v,動詞,行為,使役`) — "to teach" is
 * transmission, and the class is right — so a caused predicate under one of
 * them satisfies every condition above and was being read as a reported
 * proposition. 后稷教民稼穡 came out 民をして稼穡せ**を**しむ,
 * a を wedged between the act and the auxiliary that causes it; the reading is
 * 民をして稼穡せしむ. What a causative governs is its own complement, in 未然形
 * with no particle at all, and that is as true of the と the quoted branch
 * would write as of the を the unquoted one does — 教…「…」 would give
 * 稼穡せとしむ on the same evidence. So the guard sits in the shape both rules
 * share rather than in either of them.
 *
 * **It is the identical guard `isNominalizedObjectPredicate` carries**, put in
 * for the identical reason and against the identical failure (俯臥**するを**
 * しむ, named in that rule's own doc). That rule never reached these tokens:
 * it excludes a communication verb outright, which sent every complement of 敎
 * down this path instead — the exclusion and the causative arm were written
 * for different sentences and 敎 is in both.
 *
 * **The two halves of one predicate had already come apart, which is how this
 * was visible at all.** `isUnquotedSpeechComplement` is read by
 * `caseParticleFor` for the を and by `decideConjForm` for the 連体形, and its
 * own doc says the two must not be able to separate — but `decideConjForm`
 * asks `isCausedOrPassivePredicate` *first* and returned 未然形, while
 * `caseParticleFor` had no such test in front of it and wrote the を. 稼穡
 * printed **せを**: the 未然形 of サ変 with an object marker after it, which is
 * not a form. The repair is a guard inside the shared predicate, not a third
 * copy of the test at the second call site.
 *
 * **Measured** over
 * `lzh_kyoto-sud-{train,dev,test}.relabeled_ext.udep_ruled.punct.rulemerged.adjfix.conllu`:
 * of the 533,362 gold tokens, **38** are a speech complement that is also a
 * caused or passive predicate. Every one of them is under 敎: 使 (1,268 VERB),
 * 遣 (330) and all but two of 令's 408 are `v,動詞,行為,使役`, which
 * `isCommunicationVerb` does not admit, and the passive arm cannot meet it at
 * all — a passive 被 or 見 is the AUX the treebank writes `v,助動詞,受動,*` on,
 * and that is not a `v,動詞,` xpos. (令's two 伝達 tokens are real and govern no
 * caused predicate, so the count is 敎's alone by measurement and not by
 * assumption.) Every one of the 38 arrives on `comp:obj`: VERB 33, ADJ 4,
 * AUX 1, and **35** of them were printing the を — 教之樹畜 これをして樹畜せ**を**
 * しむ, 教民相愛 民をして相愛せ**を**しむ, 教民睦也 民をして睦ば**を**しむなり.
 * Rendered both ways against a baseline taken immediately before, **34** of the
 * 68,893 sentences change and every change is the deletion of that one を,
 * 35 of them in all: 民をして稼穡せしむ, これをして樹畜せしむ, 民をして相愛せしむ.
 *
 * The remaining **3** printed no particle either way, and one of them is the
 * reason the guard is not written in the unquoted rule alone: 錡宣之教韓王取秦，
 * 曰：「爲公叔具車百乘 has an opening bracket inside the complement's subtree, so
 * it is the *quoted* branch that claims it, and only `readsLastInItsSubtree`
 * — a bound about position, not about causation — withheld the と. */
function isSpeechComplement(token: Token, sentence: Sentence): boolean {
  if (token.dep !== "comp:obj" && token.dep !== "comp:pred") return false;
  // **A nominal is a name — unless the reordering side has already called it a
  // quotation**, and then it is one here too.
  //
  // The bare exclusion is right for 名曰軒轅 and wrong for 子曰：「巧言令色，鮮矣
  // 仁」！, whose quotation is headed by a noun because the saying begins with
  // one. `isSpeechQuoteComplement` in `depClassification.ts` is what tells
  // those two apart, on the source's own bracket and the size of the subtree;
  // the count and the argument are in its doc.
  //
  // **It is asked here because the two panels must not be able to disagree
  // about one character.** That side decides the reading *order* and marks the
  // end of the quote for the trailing と; this side decides the particle and
  // the form. With the exclusion standing unconditionally the two came apart
  // on exactly this sentence: the order put 曰く first and closed the quote
  // with と, while the particle rule still called 言 a name and wrote を after
  // it — 子曰く、「巧言令色**を**、鮮なし仁」と. One function answers now, and
  // the disagreement cannot be reintroduced by editing one side.
  if (token.pos === "NOUN" || token.pos === "PROPN") {
    const gov = sentence.tokens.find((t) => t.id === token.head && t.id !== token.id);
    if (!gov || !isSpeechQuoteComplement(token, { lemma: gov.lemma, xpos: gov.xpos, dep: gov.dep }, sentence)) {
      return false;
    }
  }
  if (isCausedOrPassivePredicate(token, sentence)) return false;
  const governor = sentence.tokens.find((t) => t.id === token.head && t.id !== token.id);
  return !!governor && isCommunicationVerb(governor);
}

/** Whether the source actually *quotes* this complement — the discriminator
 * between 終止形 + と and 連体形 + を.
 *
 * **What is keyed on: an opening bracket inside the complement's own
 * subtree.** 「 and 『 (and the rest of `OPENING_BRACKETS`) come through the
 * parse as ordinary `punct` tokens attached somewhere in the quoted clause,
 * and that attachment is what is read here — not the bracket's bare presence
 * in the sentence, which would let a quotation elsewhere in the line claim an
 * unrelated complement.
 *
 * The subtree, rather than the complement itself, because the parser does not
 * always hang the bracket on the complement's own head. Both shapes occur in
 * 酒蟲 and both must count:
 *  - directly on the complement — 曰：「有之。」 (「 on 有), 或言：『…成其術。』
 *    (『 on 成), 僧曰：「君飲嘗不醉否？」 (「 on 醉);
 *  - one edge down — 曰：「此酒之精、甕中貯水…」, where the complement is 貯 and
 *    the 「 hangs on 精, 貯's own `subj`. Asking only about direct children
 *    would call that sentence unquoted.
 *
 * **The closing bracket is deliberately not required**, and this is what makes
 * the rule usable at all. This parser splits a sentence at every stop, so the
 * 」 that closes a quote is regularly parsed as a sentence of its own — 酒蟲's
 * sent_id 7, 9, 11 and 13 are each a lone bracket, with no tie to the clause
 * they close. The opening mark has no such problem: it stands *before* the
 * quoted material, inside the same split, and so is always still there. One
 * edge of the span is enough to answer "was this quoted".
 *
 * **What happens to an unbracketed quotation.** It is treated as not quoted,
 * and takes 連体形 + を — which is the rule as asked for, and is a real change
 * of reading for Literary Chinese, where reported speech is frequently written
 * with no marks at all. 謂其身有異疾 is the case in this text: no bracket
 * anywhere, so その身に異疾有るを謂ふ where it read …異疾有りと謂ふ before.
 * Nothing in the parse distinguishes that from a genuine unquoted object; the
 * marks are the evidence, and where an author supplied none there is none. */
function isQuotedSpeechComplement(token: Token, sentence: Sentence): boolean {
  const subtree = new Set<number>([token.id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const t of sentence.tokens) {
      if (!subtree.has(t.id) && subtree.has(t.head) && t.id !== t.head) {
        subtree.add(t.id);
        grew = true;
      }
    }
  }
  return sentence.tokens.some((t) => subtree.has(t.id) && t.id !== token.id && isOpeningBracket(t.text));
}

/** True for a clausal complement of a speech verb that the source left
 * unquoted — 連体形 and を, where a quoted one takes 終止形 and と.
 *
 * Both halves of that are this one predicate's, deliberately: `caseParticleFor`
 * reads it for the を and `decideConjForm` for the 連体形, the same shared-test
 * discipline `isNominalizedObjectPredicate` already follows next door, so the
 * particle and the form cannot come apart.
 *
 * **Why this cannot simply be `isNominalizedObjectPredicate`**, which is the
 * rule it makes the complement behave like. That rule excludes an existential
 * 有/無 outright, and says why in its own doc: 有 heads a complete predication
 * and is never a thing obtained or done. The exclusion was written when every
 * complement of a speech verb took と and so needed nothing from it; with と
 * now withheld from an unbracketed complement, leaving 有 excluded strands it
 * — 謂其身有異疾 would render 異疾有り謂ふ, a 終止形 with no particle and
 * nothing joining it to the verb that reports it. So this branch runs ahead of
 * that exclusion rather than through it. Reporting that something exists is
 * exactly the case where a proposition *is* the object of the verb.
 *
 * **曰/云 are no longer excluded.** They were, and the exclusion was mechanical
 * rather than principled: `isSpeechQuoteComplement` used to treat every
 * non-nominal complement of those two as a quote regardless of brackets, and
 * `reorderEngine.ts` writes a と at the end of such a quote's reading order
 * (`ReadingPlan.quoteEndIds`), so a を added here would have landed on top of
 * that と rather than instead of it. That file now applies the bracket test
 * itself, given the sentence — which is why the sentence is passed below. An
 * unbracketed 曰有之 read これ有り曰はく where 言有之, the same sentence under a
 * governor that had never been exempt, correctly read これ有るを言ふ; both now
 * take the を and the 連体形. The very next line makes the same bracket test,
 * so passing the sentence removes a short circuit rather than adding a
 * condition.
 *
 * **One shape of unbracketed complement is nevertheless held out**, and it is
 * `depClassification.ts`'s `isNegatedBareReport` — a complement carrying its own
 * negation and no subject of its own, 俱言不須's 不須. That rule is candid in its
 * own doc about being a shape match rather than a discriminator, and about the
 * corpus finding that motivates the caution: what brackets actually mark in this
 * treebank is 曰/云, not と-versus-を. Held out here rather than tested
 * separately at the two call sites, so the を and the 連体形 stay one decision;
 * the と that replaces them is written from `reorderEngine.ts`, which can reach
 * the position this rule cannot (after a postposed ず). 謂其身有異疾 carries no
 * negation, so it never meets that rule and reads その身に異疾有るを謂ふ,
 * unchanged. */
export function isUnquotedSpeechComplement(token: Token, sentence: Sentence): boolean {
  if (!isSpeechComplement(token, sentence)) return false;
  const governor = sentence.tokens.find((t) => t.id === token.head && t.id !== token.id);
  if (isSpeechQuoteComplement(token, governor, sentence)) return false;
  if (isNegatedBareReport(token, governor, sentence)) return false;
  // **And the same stand-down `isNominalizedObjectPredicate` makes**, for the
  // same reason and on the same test: a complement reached only across a 、 is
  // read where it stands, so a を written off its head lands behind the whole
  // clause instead of between the clause and the verb that reports it. The 36
  // arcs this reaches are the ones whose governor carries the treebank's 伝達
  // tag without being 曰 or 云 — 謂 8, 聞 7, 言 5, 聽 4, 吿 3, and a tail — and
  // they fall through to the ordinary predicate endings exactly as the
  // nominalized objects do. Worth 25 edits over the 915 passages.
  //
  // **No と is written in their place**, and that is a decision rather than an
  // oversight: what closes a quotation is `reorderEngine.ts`'s
  // `quoteEndIds`, which is fed by `isSpeechQuoteComplement` and marks the
  // last token of the quote's own reading order. Half of these governors
  // (聞/聽/察) do not report speech at all, and the bracket that tells a
  // quotation from a perception is absent from every one of them — the
  // evidence `isSpeechQuoteComplement`'s own note says is missing outside 曰/云.
  if (isClausalComplementAcrossPause(token, governor, sentence)) return false;
  return !isQuotedSpeechComplement(token, sentence);
}

/** Whether something hung off `token` as a clausal complement is read after it
 * rather than returned to — the governor's half of
 * `depClassification.ts`'s `isClausalComplementAcrossPause`, which that file
 * answers from the dependent's side. `decideConjForm` is the one caller.
 *
 * **What a verb of speech reports is not counted, although it too is read
 * after the verb.** A verb of speech and the words it reports are one clause,
 * and the verb keeps the form the sentence it stands in asks of it: 劉答言：無。
 * is 劉答へ言**ふ**、無し, never 劉答へ言**ひ**、無し, and the bracketed edition
 * of the same line is 劉答へ言**ふ**、「無し」と。 — the two must agree, since
 * the bracket is the source's typography and not a fact about the reading
 * (`isSpeechQuoteComplement`'s own note makes that argument at length). What
 * the 連用形 above states is that the governor has *stopped* and another
 * predication follows, which is true of the clause the editor's 、 opens and
 * false of a report. Asked of `isSpeechComplement`, the shape both the quoted
 * and the unquoted rule share, so no bracket decides it here either. */
function hasClausalComplementAcrossPause(token: Token, sentence: Sentence): boolean {
  return sentence.tokens.some(
    (kid) =>
      kid.head === token.id &&
      kid.id !== token.id &&
      isClausalComplementAcrossPause(kid, token, sentence) &&
      !isSpeechComplement(kid, sentence),
  );
}

/** The governor of the link that bears the `comp:obj` relation in this
 * predicate's coordination chain — the token `DATIVE_OBJECT_LEMMAS` has to be
 * keyed on, exactly as the nominal branch of `caseParticleFor` keys it on the
 * *chain head's* governor rather than on the carrier's. A predicate that is not
 * coordinated is its own bearer and nothing changes. */
function nominalizedObjectGovernor(token: Token, sentence: Sentence): Token | undefined {
  const chain = predicateCoordinationChain(token, sentence, NOMINAL_COORDINATION_DEPS);
  const bearer = chain.find((link) => isNominalizedObjectPredicate(link, sentence)) ?? token;
  return sentence.tokens.find((t) => t.id === bearer.head && t.id !== bearer.id);
}

export function isNominalizedObjectPredicate(token: Token, sentence: Sentence): boolean {
  // ADJ beside VERB throughout this rule — both for the predicate itself and
  // for the governor below. A stative in an object slot is a nominalized
  // clause exactly as a verb there is (見不賢而內自省 is 賢ならざるを見て…), and
  // over the recoded gold this is **3,188** ADJ tokens standing `comp:obj`
  // under a verbal governor, every one of them carrying a `v,動詞,描写,…`
  // xpos so `isVerbalXpos` admits them unchanged. The governor arm is a
  // further **529** VERB objects hanging off a stative governor (不病人之不己知
  // → 人の己を知らざるを病む). Under 0.3.1 both sets were VERB and this rule
  // already claimed them; the recoding, left alone, would have dropped them.
  if (token.dep !== "comp:obj" || !isContentPredicatePos(token.pos)) return false;
  if (!isVerbalXpos(token) || isExistentialPredicate(token)) return false;
  // A predicate an auxiliary governs is not nominalized at all: it is what the
  // しむ or the らる attaches to, and it owes that auxiliary a 未然形 with no
  // particle. Both a 使役 and a 受身 can hand their complement over on
  // `comp:obj` — see `isCausedPredicateOf` for the 332 gold causatives that
  // do, and `passiveComplement` for 被 — and this rule was claiming every one
  // of them, printing 連体形 + を where the auxiliary wanted 未然形 and nothing
  // (俯臥**するを**しむ). `decideConjForm` already asks
  // `isCausedOrPassivePredicate` ahead of this rule and so had the form right;
  // it is `caseParticleFor` that reads this predicate for the を, so the guard
  // has to sit here, in the one place both halves share, rather than at that
  // one call site. Same arrangement as `isNominalizedObliquePredicate`, which
  // holds the identical guard for the identical reason.
  if (isCausedOrPassivePredicate(token, sentence)) return false;
  const governor = sentence.tokens.find((t) => t.id === token.head && t.id !== token.id);
  if (!governor || !isContentPredicatePos(governor.pos) || !isVerbalXpos(governor)) return false;
  if (isCommunicationVerb(governor) || isSpeechQuoteComplement(token, governor)) return false;
  // **A complement the reader reaches only across a 、 is not nominalized**,
  // because it is not read in an object slot at all: `classifyToken` leaves it
  // standing where the editor's mark put it and closes the governor in front
  // of it (see `isClausalComplementAcrossPause`, which measured the order in
  // the received readings — 775 of the 784 that decide read the governor
  // first). The を this rule writes would then land *behind the whole clause*,
  // several predications after the verb that is supposed to govern it:
  // 士卒闘はんと欲す、…白晝昏の如き**を** is not a sentence, and the 連体形 that
  // goes with the を is no better.
  //
  // **The guard sits here rather than at the three call sites**, for the
  // reason the causative guard above it sits here: `caseParticleFor` reads
  // this predicate for the を, `decideConjForm` for the 連体形 and
  // `negationEndingParts` for the ざる + を, and all three go through this one
  // function, so a form arriving without its particle (or the other way about)
  // cannot arise. With the rule stood down the clause falls through to the
  // ordinary predicate endings and closes on its own ending — 夫子之を欲し、
  // 吾が二臣を者、皆欲せざるなり, for 季氏 1's received 夫子之を欲す、吾が二臣の
  // 者は、皆欲せざるなり.
  if (isClausalComplementAcrossPause(token, governor, sentence)) return false;
  return true;
}

/** Verbs of thinking and intention, whose verbal object is not a thing done
 * but a thing *meant* to be done — 飲まんと思ふ, "thinks to drink", where the
 * ordinary nominalized object would give 飲むを思ふ.
 *
 * **A lemma list, because the treebank cannot draw this class**, and that is
 * a measured finding rather than an assumption. `isCommunicationVerb` next
 * door reads the class straight off the xpos (`v,動詞,行為,伝達`), so the same
 * was tried here first. Across `lzh-{train,dev,test}.sud.conllu` (137,786
 * sentences, 122 distinct xpos values) the semantic field has no compartment
 * for thought at all on the verbal side: 思, 念, 願, 謀, 圖, 意 and 知 alike
 * come back `v,動詞,行為,動作`, the catch-all with 92,658 tokens in it —
 * every ordinary action verb in the language. The neighbouring
 * `v,動詞,行為,態度` (16,436) is closer to a psychological class and is still
 * the wrong one: it holds 恐/懼/疑/冀/肯 — fear and doubt — and does not hold
 * 思/願/念 at all.
 *
 * The corpus does carry two classes that name this sense, and *both are
 * already spoken for*, which is the second half of why this list is what is
 * left:
 *
 *  - **`v,助動詞,願望,*`** (3,010: 欲 1,848, 敢 1,074, 肯 88) — volition, as an
 *    *auxiliary*. 欲 is in `AUXILIARY_LEMMAS` and renders まほし, and its
 *    complement comes back `comp:aux` (1,788 of 2,372) rather than the
 *    `comp:obj` this rule keys on, so the two constructions do not meet.
 *  - **`v,副詞,時相,将来`** (1,260: 將/将/且) — imminent intention, as an
 *    adverb. Those three are 再読文字 and already write んとす from
 *    `REREAD_CHARACTERS`; see the bound below, which is what stops the ンと
 *    being written twice.
 *  - **`n,名詞,思考,思考`** (1,724: 故/志/怨/意/思/想/謀/望) does name thought,
 *    and names it as a *noun*. A noun is not a governor.
 *
 * So the lemmas below are hand-listed, in the same spirit as
 * `ASPECTUAL_VERB_LEMMAS` and `EXCLUSIVE_FOCUS_LEMMAS`, and each is here
 * because it actually governs a verbal `comp:obj` in the corpus — the counts,
 * measured over the same three files, are 願 326, 思 122, 謀 53, 望 42, 期 32,
 * 慮 16, 念 14, 冀 10, 圖 5. Simplified variants are listed beside their
 * traditional forms the way `AUXILIARY_LEMMAS` lists 応 beside 應.
 *
 * Verbs of *fear* and *doubt* (恐/懼/疑) are deliberately absent although the
 * treebank groups them with 冀: what they take is a proposition feared, not
 * an action intended, and 敗れんと恐る would say the speaker means to lose. */
const INTENTION_VERB_LEMMAS: ReadonlySet<string> = new Set([
  "思", "念", "慮", "虑", "願", "愿", "望", "冀", "謀", "谋", "圖", "図", "图", "期",
]);

/** True when `token` is the action a verb of thinking or intention has in
 * view — 未然形, and んと.
 *
 * んと is the volitional む plus the quotative と: what such a verb governs is
 * not a nominalized action but an intention *entertained*, which classical
 * Japanese states as a quoted volition — 酒を飲まんと思ふ, 禮を學ばんと願ふ.
 * Both halves are this one predicate's, `decideConjForm` reading it for the
 * 未然形 and `caseParticleFor` for the んと, which is the shared-test
 * discipline `isNominalizedObjectPredicate` and `isUnquotedSpeechComplement`
 * already follow: a 未然形 with no んと after it is not a form at all, so the
 * two must not be able to come apart.
 *
 * It is the same slot the quotative と occupies, and it is bounded the same
 * way — `readsLastInItsSubtree`. A particle written here lands on the head
 * word, and the んと has to fall at the end of the whole intended clause; where
 * something is still read after this token the rule stands down and the
 * ordinary 連体形 + を stands, which is what the sentence had before.
 *
 * **That bound is also what keeps the ンと from being written twice.** 將/且
 * are 再読文字 and read んとす of their own accord after the clause they
 * govern; such a character hangs off the predicate it governs, so
 * `readsLastInItsSubtree` sees it (it asks `isRereadUse` about every child for
 * exactly this reason) and refuses. 思將歸 therefore keeps its single
 * まさに…んとす rather than gaining a second んと from 思. The *form* could not
 * have collided in any case — `generator.ts` and `KundokuView.ts` both spend
 * `rereadGovernedForm` ahead of `decideConjForm`, and 將's own entry asks for
 * the same 未然形 this rule would.
 *
 * Everything else is `isNominalizedObjectPredicate`'s own gate, re-used
 * rather than restated: a verbal `comp:obj` of a verbal governor, with a noun
 * mis-tagged VERB (`isVerbalXpos`) and a speech verb's reported proposition
 * both already excluded there. This rule is a narrowing of that one — the
 * same relation under a smaller class of governor — so it runs ahead of it at
 * both call sites and replaces both of its answers. */
function isVolitionalComplement(token: Token, sentence: Sentence): boolean {
  const governor = sentence.tokens.find((t) => t.id === token.head && t.id !== token.id);
  if (!governor) return false;
  // **The postposed negation is skipped here and not in the arm below.** 不 is
  // read *after* the predicate it negates, so a negated complement never read
  // last in its own subtree and the whole construction stood down on it —
  // 渾欲不勝簪 came out 簪に勝へ**ず**欲す where the received reading is
  // 簪に勝へ**ざらんと**欲す. What writes the んと there is `negationEndingParts`,
  // onto the 未然形 ざら, exactly as it writes the を of 飲むを得ざるを;
  // `caseParticleFor` withholds it from this predicate whenever that is going to
  // happen (`negationClosing`), so the two cannot both write it. It is the same
  // one-child skip `isPreposedAdverbialClause` and `isNegatedAdverbialPredicate`
  // take, and deliberately **not** `argumentClauseSkip`, which also looks past a
  // `conj:coord` conjunct: that skip belongs with `closesArgumentChain`, which
  // carries the particle to the chain's *last* member, and this rule is not asked
  // through it — used here it wrote the んと on the chain's head instead
  // (君子欲訥於言而敏於行 → 訥ら**んと**…敏なり欲す). Measured both ways over
  // kanbun.info's 3,419 passages: with `argumentClauseSkip`, gold −3 / parser +4
  // over 5 passages; with this one-child skip, **0 and 0, and not one passage
  // moves** — a negation standing inside a 欲 complement does not occur in that
  // corpus at all. 春望 is where it occurs.
  if (isDesiderativeComplement(token, governor)) {
    return readsLastInItsSubtree(token, sentence, (child) => isNegationUse(child));
  }
  if (!isNominalizedObjectPredicate(token, sentence)) return false;
  if (!INTENTION_VERB_LEMMAS.has(governor.lemma)) return false;
  return readsLastInItsSubtree(token, sentence);
}

/** **What a 欲 read as the verb 欲す has in view** — the same quoted volition
 * `INTENTION_VERB_LEMMAS` names, arriving on the relation this treebank gives a
 * modal's complement rather than on `comp:obj`.
 *
 * The note on `INTENTION_VERB_LEMMAS` above records why the two constructions
 * did not meet: 欲 rendered まほし out of `AUXILIARY_LEMMAS`, and its complement
 * comes back **`comp:aux`** (1,788 of 2,372 in this treebank) where that rule
 * keys on `comp:obj`. Both halves of that have now changed —
 * `PINNED_ONLY_AUXILIARY_LEMMAS` reads an unpinned 欲 as the verb 欲す — and
 * what a verb of volition governs is what this file already knows how to write:
 * 未然形 + んと.
 *
 * **The received text is emphatic about it.** Of the **198** 欲 in
 * kanbun.info's own 書き下し文, **122 stand immediately after んと** — 則ち勝た
 * **んと**欲す, 東に帰ら**んと**欲す, 己立た**んと**欲して — and the construction
 * is the same quoted volition 思 and 願 take. The remainder are the uses this
 * rule does not reach and must not: a nominal object (我仁を欲すれば, 其の生を
 * 欲し), a 所-nominalization (心の欲する所), and the bare noun 欲.
 *
 * `comp:aux` **and** `comp:obj`, because both labels reach this governor: the
 * treebank writes 822 `comp:aux` against 27 `comp:obj` over a negated
 * predicate, and the reading is one construction under either. A *nominal*
 * complement is refused by the POS gate, which is what keeps 我欲仁 at 仁を欲す.
 *
 * A **pinned** 欲 is the auxiliary まほし and governs nothing quoted, exactly as
 * it takes no は and writes no ending of its own — the three arms of
 * `PINNED_ONLY_AUXILIARY_LEMMAS` stand down together or not at all. */
function isDesiderativeComplement(token: Token, governor: Token): boolean {
  if (governor.lemma !== "欲" || chosenAuxiliary(governor) !== undefined) return false;
  if (token.dep !== "comp:aux" && token.dep !== "comp:obj") return false;
  return isContentPredicatePos(token.pos) && isVerbalXpos(token);
}

/** んと — the volitional む in its 終止形 plus the quotative と. Written once
 * here so that the particle `caseParticleFor` emits and the rule's own name
 * cannot drift apart. */
const VOLITIONAL_PARTICLE = "んと";

/** True when `token` is a predicate standing in a *subject* slot, and so is
 * nominalized: 連体形, and こと. 去首半尺 is 首を去ること半尺, not 首を去ぬ半尺.
 *
 * The fourth case of the inference `isNominalizerAhead` (者), `modifiesGenitiveZhi`
 * (之) and `isLimitingParticleAhead` (耳) are the other three of: a predicate
 * standing where a noun would stand is attributive. The difference here is
 * the one `isNominalizedObjectPredicate` also has — the nominal slot is an
 * argument position with no nominalizer realized in the source — and the only
 * further difference from that rule is which argument position it is. So this
 * is written to its shape: one predicate answering both halves, the 連体形 for
 * `decideConjForm` and the こと for `caseParticleFor`, so the form and the
 * particle cannot come apart.
 *
 * こと rather than the bare 連体形, because Literary Chinese realizes no
 * nominalizer here and Japanese needs one for a clause to fill a subject
 * slot. It goes in the particle slot, which is where the quotative と goes,
 * and is bounded by the same `readsLastInItsSubtree` for the same reason: the
 * particle is written onto the head word, and こと has to fall at the end of
 * the whole subject clause. 去首半尺 passes because 首 is 去's `comp:obj` and
 * inverts before it, so 去 really is the last thing read in its own subtree.
 *
 * **`isVerbalXpos` is doing load-bearing work**, not tidying. 酒蟲's
 * 劉使試之、果然 comes back with 使 tagged UPOS VERB, dep `subj`, and xpos
 * `n,名詞,人,役割` — the noun "envoy". A name standing in a subject slot is
 * not a predicate and takes no こと; the same tie-breaker keeps 醞 and 藥 out
 * of the object rule next door.
 *
 * An existential is excluded for `isNominalizedObjectPredicate`'s own reason:
 * 有 heads a complete predication, and 虎有ること is not what 山中有虎 says.
 *
 * **The xpos is asked of the whole compound, not of its first character**, and
 * that is the reader's rule for this shape stated exactly: *when the first
 * member of a verb compound is a subject, the last member of the compound
 * should end in 連体形 + コト*. 蠕動如游魚 is the case. 蠕 is the `subj` of 如
 * with 動 fused onto it by `flat@vv` — one word, the V-V compound "to wriggle"
 * — and `readsLastInItsSubtree` already looks through a `NAME_FUSING_DEPS`
 * child for precisely that reason (see its doc: a word this token is fused
 * with is not something read after it). The xpos test was still asking about
 * the single character, and this parser returns 蠕 as `n,名詞,可搬,道具` while
 * giving 動 the verb tag `v,動詞,行為,動作` — so a compound that is verbal by
 * its own second half was refused, the こと was not written at all, and 蠕動
 * closed the clause in 終止形: 蠕動**す**游魚のごとし, where the subject slot
 * wants 蠕動**する**こと.
 *
 * Looking through the fusion is the same claim `readsLastInItsSubtree` and
 * `predicateCoordinationChain`'s `spanMates` already make — that the members
 * are one word — carried to the one question about that word this rule had
 * been asking of a single character. It is not a widening of what counts as a
 * predicate: a compound with no verbal member anywhere is refused exactly as
 * before, which is what keeps 劉使試之's 使 (`n,名詞,人,役割`, the noun "envoy")
 * out.
 *
 * **Measured, and the measurement is what to weigh this by.** Over
 * `lzh_kyoto-sud-{train,dev,test}` a VERB standing on `subj` has a fusing child
 * **514** times, and in **all 514** the head's own xpos is already verbal — so
 * this changes nothing in the gold treebank, and its whole reach is a tree in
 * which the parser has tagged the first member of a compound a noun. The
 * reader's own 酒蟲 is such a tree. The annotation that would make the point
 * moot is 蠕 carrying `v,動詞,行為,動作` like the 動 beside it; the rule is worth
 * having anyway, because what it asks about — the word — is what the reader's
 * rule is about. */
function isNominalizedSubjectPredicate(token: Token, sentence: Sentence): boolean {
  if (token.dep !== "subj" && !token.dep.startsWith("subj@")) return false;
  // ADJ beside VERB — see `isContentPredicatePos`. A stative standing on
  // `subj` is a nominalized clause in a subject slot exactly as a verb there
  // is, and there are **603** of them over the recoded gold, all with a
  // verbal xpos.
  //
  // **A clause with a genitive subject is let in on two more counts** — see
  // `hasGenitiveSubject`. 之 is what nominalizes a clause in Classical Chinese,
  // so the clause is a nominal whatever its head: an auxiliary (堯舜之不可兩譽,
  // 可 on `subj`) and an existential (人之有技, 有 on `subj`) stand in the slot
  // exactly as a verb does, where without the 之 the first is not a content
  // predicate and the second a complete predication (山中有虎).
  const genitiveSubject = hasGenitiveSubject(token, sentence);
  if (!genitiveSubject && (!isContentPredicatePos(token.pos) || isExistentialPredicate(token))) return false;
  // The auxiliary has to be one this app writes as an auxiliary after its
  // clause (`auxiliaryFormFor`: 可, 能, 使…), which is what gives it a 連体形 to
  // stand in: 道之爲物 has 爲 on `subj` as AUX too, and reads 物たる, where a
  // nominalized 爲 wrote 物と爲する**は**.
  if (genitiveSubject && !isContentPredicatePos(token.pos) && auxiliaryFormFor(token, sentence) === undefined) {
    return false;
  }
  if (!isVerbalXpos(token) && !fusedWordIsVerbal(token, sentence)) return false;
  // **The postposed negation is skipped**, exactly as `isNominalizedObliquePredicate`
  // skips it, and until it was this rule could not see a negated clause at all.
  // 不 is read *after* the verb it negates, so it is always the last thing in
  // the subtree and "does this predicate read last" answered no for every one of
  // them: 不知難 came out 知ら**ず**難し, where the reader's ruling — *if a
  // negated verb is used as an argument, the negation should be read as ざる* —
  // makes it 知ら**ざること**難し. The ず standing at the clause's end is what
  // carries the nominalization, which is `negationEndingParts`' `subject` arm,
  // and this is the half that lets it be reached.
  //
  // **113** gold tokens: a 不/未/弗/勿 on `mod` whose head is a VERB or ADJ
  // standing on `subj`. The object slot (1,413) never needed it —
  // `isNominalizedObjectPredicate` asks no subtree question — and the oblique
  // (36) has had it since it was written.
  //
  // **A conjunct of this token's own chain is skipped too** — see
  // `argumentClauseSkip`: what follows a chain head is the rest of the chain,
  // and the こと is written after its last member rather than being withheld
  // because that member exists.
  return readsLastInItsSubtree(token, sentence, argumentClauseSkip(token, sentence));
}

/** True when some word `token` is *fused into one word with* — a
 * `NAME_FUSING_DEPS` child of it — carries a verbal xpos. See
 * `isNominalizedSubjectPredicate`, the one caller, for the argument.
 *
 * Direct children only, and deliberately: the members of a two-character
 * compound hang off its first, which is the token every rule in this file asks
 * about. A deeper walk is what `predicateCoordinationChain`'s `spanMates` does,
 * and it does it because a *conjunct* can hang off any member; nothing here
 * needs to reach past the word itself. */
function fusedWordIsVerbal(token: Token, sentence: Sentence): boolean {
  return sentence.tokens.some(
    (t) => t.head === token.id && t.id !== token.id && NAME_FUSING_DEPS.has(t.dep) && !!t.xpos && t.xpos.startsWith("v,"),
  );
}

/** True when `token` is the predicate of a **主之謂** clause — N之V, with the
 * 之 standing between the subject and its predicate. The treebank annotates
 * the 之 `subj` of the predicate with the subject noun as its `comp:obj` (人之見之者:
 * 人 `comp:obj`>之, 之 `subj`>見), and the parser returns the same arcs under
 * SCONJ, PART or PRON for the 之; the arcs are what is asked, not the tag.
 *
 * The subject noun is required, before the 之, so that a 之 the parse has
 * made the subject on its own (a pronoun "it", which Classical Chinese does
 * not use in that slot) is not taken for the construction. */
function hasGenitiveSubject(token: Token, sentence: Sentence): boolean {
  return sentence.tokens.some(
    (zhi) =>
      zhi.head === token.id &&
      zhi.id < token.id &&
      zhi.lemma === "之" &&
      (zhi.dep === "subj" || zhi.dep.startsWith("subj@")) &&
      sentence.tokens.some((noun) => noun.head === zhi.id && noun.id < zhi.id && noun.dep !== "punct"),
  );
}

/** The particle a nominalized subject clause takes: **は on a 主之謂 clause**,
 * こと on any other — and こと on a 主之謂 clause too where what it is the
 * subject of **measures it**.
 *
 * **What the received reading writes**, over kanbun.info — every passage whose
 * tree (gold or parsed) has an N之V predicate on `subj`, read by hand against
 * the 書き下し文, counting the ones the site reads as a verb:
 *
 * | 連体形 + は 10 | こと 4 | や 2 | も 1 |
 *
 * The は include 夫子の性と天道とを言ふ**は**、得て聞く可からざるなり,
 * 道の行はれざる**は**、已に之を知れり, 民の治め難き**は**、其の智多きを以てなり
 * (老子 65 and 75), 人の技有る**は**, 軍旅の固き**は**, 人の道に在る**は**、魚の水に
 * 在るが若し, and 王の王たらざる**は**、爲さざるなり. Five more of those trees put
 * a verb where the site reads a noun (朋友の饋**は**, 紂の不善**は**, 小敵の堅**は**,
 * 智者の慮**は**, 先王の治**は**), and those take は as well. This app wrote こと
 * on every one of them it reached.
 *
 * **The こと are mostly the extent construction**, the one
 * `isNominalizedSubjectPredicate` already anchors with 去首半尺 (首を去ること半尺):
 * the predicate the clause is the subject of says *how much* or *how long* —
 * 丘の禱ること久し (an adjective), 祿の公室を去ること五世 (a number). The other two,
 * 人の己を視ること、其の肺肝を見るが如く and 成敗の轉ずること、譬へば…若し, stand
 * before a comparison, which the corpus also reads with は (人の技有る**は**、
 * 己之れ有るが若く; 人の道に在る**は**、魚の水に在るが若し), so the comparison
 * cannot be told apart and is left to the majority. The 矛盾 passage is the
 * extent construction: 吾楯之堅、莫能陷也 is received as 吾が楯の堅き**こと**、
 * 能く陷す莫し, where what measures the hardness is the adjective 莫し, read last
 * in its clause (`hasPostposedPredicateNegationChild`). So an ADJ, a NUM, or a
 * predicate a postposed 無/莫 closes keeps こと, and the rest take は. An
 * adjective governs a verbal 主之謂 subject twice in these passages, as
 * 禱ること久し and 迷へる**や**、其の日固より久し; the two it governs with は
 * (紂の不善は、是くの如く甚だしからず; 智者の慮は、必ず利害に雜ふ) are both read as
 * nouns, where the app writes a verb either way.
 *
 * The や has no 也 in the source to stand for, so nothing in the tree could ask
 * for it; where the source *has* the 也 — 人之生也直, 人の生くる**や**直し — the や
 * is that 也, a token of its own, and the clause is not on `subj` at all.
 *
 * The negated clause takes the same は on its ざる, which `negationEndingParts`
 * writes: 道之不行 is 道の行はれざる**は**, and 堯舜之不可兩譽 堯舜の兩つながら
 * 譽む可からざる**は**.
 *
 * **Asked of every link of the chain**, since the 之 hangs off the first
 * predicate and the particle is written on the last; the measuring predicate is
 * the governor of the link that bears `subj`. */
function subjectNominalizerFor(token: Token, sentence: Sentence): string {
  const chain = predicateCoordinationChain(token, sentence, NOMINAL_COORDINATION_DEPS);
  if (!chain.some((link) => hasGenitiveSubject(link, sentence))) return SUBJECT_NOMINALIZER;
  const bearer = chain.find((link) => link.dep === "subj" || link.dep.startsWith("subj@")) ?? token;
  const measure = sentence.tokens.find((t) => t.id === bearer.head && t.id !== bearer.id);
  return measure && measuresExtent(measure, sentence) ? SUBJECT_NOMINALIZER : TOPIC_PARTICLE;
}

/** True when `predicate`, the governor of a 主之謂 subject clause, says how much
 * or how long rather than commenting on the clause — an adjective (久し), a
 * number (五世), or a clause closed by a postposed 無/莫, which reads as the
 * adjective 無し. See `subjectNominalizerFor`. */
function measuresExtent(predicate: Token, sentence: Sentence): boolean {
  if (predicate.pos === "ADJ" || predicate.pos === "NUM") return true;
  return hasPostposedPredicateNegationChild(predicate, sentence);
}

/** こと — the nominalizer kundoku supplies for a clause standing in a subject
 * slot, and for the one 能はず governs. See `isNominalizedSubjectPredicate` and
 * `isNegatedNengComplement`. */
const SUBJECT_NOMINALIZER = "こと";

/** True for the predicate a **negated** 能 governs — 連体形 + こと, which is what
 * 能はず takes in front of it: 未能信之 is 未だ之を信ず**ること**能はず, 不能學
 * 學ぶ**こと**能はず.
 *
 * **The fourth of the shape `isNominalizedObjectPredicate` (を),
 * `isNominalizedSubjectPredicate` (こと) and `isNominalizedObliquePredicate` (に)
 * already make**, and it takes the same こと as the second of them, for the same
 * reason: a clause cannot stand in a nominal slot in Japanese without one. What
 * differs is only which slot — this is the complement of a verb, not a subject —
 * so it is written as its own predicate rather than folded into that one, and
 * the two are keyed on different relations.
 *
 * **Only where 能 is negated.** A positive 能 is the adverb 能く and governs
 * nothing nominal at all — 能く之を知る, with the predicate reading straight on
 * after it. That arm is `positiveNengReading` above and
 * `isPositiveNengComplement` in `depClassification.ts`; between them the two
 * halves of the character are answered in three places that have to agree, and
 * each names the others.
 *
 * **The count.** 能 is written **407** times in kanbun.info's 書き下し文 and the
 * kana after it is く on roughly 250 and はず on the rest; 「こと能わ」 stands
 * **72** times there, against no bare 「能わ」 following a 終止形. So the こと is
 * not optional in the received reading, it is how the construction is built.
 *
 * Withheld where a negation closes the complement's own clause, exactly as the
 * three branches above withhold their particles and for their one reason: a
 * postposed negation is read after the predicate, so a こと written here would
 * land inside it. `negationEndingParts` writes it on the 連体形 ざる instead. */
export function isNegatedNengComplement(token: Token, sentence: Sentence): boolean {
  if (token.dep !== "comp:aux" && token.dep !== "comp:obj") return false;
  const governor = sentence.tokens.find((t) => t.id === token.head && t.id !== token.id);
  if (!governor || governor.lemma !== "能") return false;
  // …and stands down on a pinned 能, as its two fellows do. See
  // `positiveNengReading`.
  if (storedReadingText(governor) !== undefined) return false;
  if (!isContentPredicatePos(token.pos)) return false;
  return sentence.tokens.some(
    (t) =>
      t.head === governor.id &&
      t.id !== governor.id &&
      isNegationUse(t) &&
      auxiliaryComplementNegated(t, sentence) === undefined,
  );
}

/** The negation that closes `token`'s clause — a 不/未/弗/勿 hanging off it,
 * which `depClassification.ts` postposes past its predicate so that the ず is
 * read after the verb it negates. Undefined for an unnegated predicate.
 *
 * `isNegationUse` rather than the lemma, so that a 不 the reader has taken out
 * of the class by picking a reading for it is no longer treated as one — the
 * same test both panels' negation branches spend. */
function negationClosing(token: Token, sentence: Sentence): Token | undefined {
  // Hung on the auxiliary over `token` and standing between the two, a 不
  // closes `token` and not the auxiliary: the inner 不 of 欲不欲 closes the
  // second 欲, which is 欲せざるを欲す. Hung on `token` itself, it closes
  // `token` unless it is that same inner negation seen from its own head. See
  // `auxiliaryComplementNegated`.
  return sentence.tokens.find((t) => {
    if (t.id === token.id || !isNegationUse(t)) return false;
    const complement = auxiliaryComplementNegated(t, sentence);
    return complement ? complement.id === token.id : t.head === token.id;
  });
}

/** True when `token` is a predicate standing in an *oblique* slot, and so is
 * nominalized: 連体形, and に. 苦不得飲 is 飲むを得ざるに苦しむ.
 *
 * The third of the trio `isNominalizedObjectPredicate` (を) and
 * `isNominalizedSubjectPredicate` (こと) already make, written to the same
 * shape and for the same reason: a predicate standing where a nominal would
 * stand is attributive, and the slot decides the particle. The slot here is
 * every relation in `OBLIQUE_DEPS` — see that set for what the treebank and
 * the parser each write, and for why plain `udep` is not one of them.
 *
 * 苦不得飲 is what it was written for, and **it is no longer that sentence's
 * rule** — the label was re-measured and 得 is 苦's `comp:obj`, not an oblique
 * of it (see `negationEndingParts`' object arm for the counts, and for what the
 * を costs). What this rule keeps is every *genuinely* oblique verbal
 * dependent, which is where the parser puts a predicate hanging off another
 * predicate when the relation really is an adjunct one: the whole negated
 * clause is then marked に, exactly as a locative noun in the same slot would
 * be. 至見之 is 至るにこれを見る.
 *
 * **`isNominalizedObjectPredicate`'s gate, re-used rather than restated**: a
 * verbal dependent of a verbal governor, with a noun the parser mis-tagged
 * VERB (`isVerbalXpos`) and an existential both excluded, and a speech verb's
 * reported proposition kept out — that is a quotation and takes と. The one
 * thing that differs is the relation, which is the whole content of the rule.
 *
 * **A caused or passive predicate is excluded first, and it has to be.** SUD
 * gives a causative its governed predicate on `comp:obl` — that is the ordinary
 * shape, and `isCausedPredicateOf` names it as such — so 戰 in 使民戰 arrives
 * on a relation this set contains, from a verbal governor, with nothing read
 * after it. Every clause of the gate below passes, and the rule marked it:
 * 使民戰 read **民をして戰はにしむ**, a に wedged between the 未然形 and the しむ.
 *
 * The two readings are not merely both available, they are incompatible. A
 * predicate an auxiliary governs is in 未然形 *because* the しむ attaches to it;
 * a predicate in an oblique slot is in 連体形 *because* a particle closes it.
 * One token cannot be both, and the auxiliary has the prior claim: 戰 is what
 * the causation makes happen, not an adjunct saying when or where it happens.
 * A caused predicate takes no case particle at all — it is the act, not an
 * argument.
 *
 * This is the same fault, in a second place, that the causee branch of
 * `caseParticleFor` was restricted to nominals to fix. There the act was
 * getting the *causee*'s をして (俯臥をして); here it gets the oblique's に. The
 * causee side could be settled on POS because no predicate is ever a causee,
 * and this side cannot: the caused predicate genuinely is a verb on a genuinely
 * oblique edge, so what separates them is the auxiliary's claim on it and
 * nothing about the token itself. Hence `isCausedOrPassivePredicate` — the one
 * function that already decides which predicates the auxiliary machinery owns,
 * asked here rather than restated, so the two cannot drift apart.
 *
 * **The negation is skipped in the end-of-clause test, and that is the crux.**
 * A particle written from here lands on the head word, so — like と, こと and
 * んと — the rule stands down where something is still read after this token.
 * A postposed negation *is* read after it, and it is not something the particle
 * would land inside: it closes the clause, so it carries the に itself and the
 * form it takes is 連体形 ざる. `negationEnding` is where both of those are
 * written; `caseParticleFor` withholds the particle here whenever a negation is
 * going to write it, so the に is emitted exactly once. */
export function isNominalizedObliquePredicate(token: Token, sentence: Sentence): boolean {
  if (!OBLIQUE_DEPS.has(token.dep)) return false;
  if (isCausedOrPassivePredicate(token, sentence)) return false;
  // ADJ beside VERB on both ends, the same widening `isNominalizedObjectPredicate`
  // takes and for the same reason — see `isContentPredicatePos`. The oblique
  // arm is much the smaller of the two: **74** ADJ tokens stand `comp:obl`
  // over the recoded gold.
  if (!isContentPredicatePos(token.pos) || !isVerbalXpos(token) || isExistentialPredicate(token)) return false;
  const governor = sentence.tokens.find((t) => t.id === token.head && t.id !== token.id);
  if (!governor || !isContentPredicatePos(governor.pos) || !isVerbalXpos(governor)) return false;
  if (isCommunicationVerb(governor) || isSpeechQuoteComplement(token, governor)) return false;
  // The postposed negation, and a conjunct of this token's own chain — see
  // `argumentClauseSkip`. The に closes the whole chain (飲みて食ふに), so a
  // second conjunct is not something read after the phrase this rule marks.
  return readsLastInItsSubtree(token, sentence, argumentClauseSkip(token, sentence));
}

/** に — what a clause standing in an oblique slot takes. See
 * `isNominalizedObliquePredicate`. */
const OBLIQUE_PARTICLE = "に";

/** を — what a clause standing in an *object* slot takes. See
 * `isNominalizedObjectPredicate`.
 *
 * Named here, beside the oblique's に and the subject slot's こと, because two
 * functions now write it about one construction and neither may state it as a
 * bare literal: `caseParticleFor` writes it onto the predicate, and
 * `negationEndingParts` writes it onto the ず that closes a negated one. That
 * is the arrangement the oblique に has always been in, one slot over. */
const OBJECT_PARTICLE = "を";

/** は — the topic particle, written here once so the branches that reach for
 * it say which fact they are stating rather than repeating a bare literal. */
const TOPIC_PARTICLE = "は";

/** **の — what the subject of a *subordinate* clause takes, where the subject
 * of a main clause takes は or nothing.**
 *
 * This is one of the oldest facts about 文語 and the app was writing nothing
 * at all for it: a clause standing in a nominal slot marks its own subject
 * with の (or が), never with は, because は is a topic and a subordinate
 * clause has no topic of its own to set. 有朋自遠方來 is 朋**の**遠方より來る
 * 有り, 哇有物出 is 物**の**出づる有り, 非劉之病 is 劉の病にあらず.
 *
 * **の and not が, and that is a choice about this corpus rather than a claim
 * that が is wrong.** Both are the classical subordinate-subject markers and
 * both take the 連体形; what separates them in 文語 is animacy and register —
 * が leans to a person, and to the writer's own side (わが君, 人の言ふ) — and
 * nothing in a dependency tree states either. Kanbun kundoku's own convention
 * settles it: the 訓読 tradition writes の here almost without exception, and
 * every rendering this file's docs already quote as a target (朋の遠方より來る,
 * 物の出づる, 子の道) uses の. A rule that guessed between the two from a POS
 * tag would be inventing evidence; one が is not reachable from a tree is a
 * limit worth stating, and it is stated here. */
const SUBORDINATE_SUBJECT_PARTICLE = "の";

/** The demonstrative pronouns that stand as a **resumptive** — the 是 of
 * 蟲是劉之福, "the worm, *this* is Liu's fortune".
 *
 * 是/此/斯 and not 之 or 其, and both exclusions are measured over
 * `lzh-{train,dev,test}.sud.conllu`:
 *
 *  - **其** is by far the commonest pronoun standing beside a subject (156 of
 *    the 206 subject-sibling pronouns) and is not a resumptive at any of them:
 *    泰山其頹乎, 匡人其如予何, 回也其庶乎 are the 其…乎 modal frame, where 其
 *    is "surely" and the noun before it is the plain subject. は there would
 *    be marking a topic the sentence does not have.
 *  - **之** is the genitive and the object pronoun; the four subject-sibling
 *    rows it does have (秘密事之載心兮) are the genitive mis-attached, not a
 *    resumption.
 *
 * See `resumedByDemonstrative` for what the shape is bounded to. */
const RESUMPTIVE_DEMONSTRATIVES: ReadonlySet<string> = new Set(["是", "此", "斯"]);

/** True for a nominal **immediately resumed by a demonstrative pronoun that
 * fills the same slot it does** — 蟲 in 蟲是劉之福 (酒蟲, sent_id 36), where
 * 蟲 and 是 are both `subj` of 成 and adjacent.
 *
 * Two nominals cannot both be the subject of one predicate. What the sentence
 * has is a *dislocation*: the noun is set out in front, and the pronoun after
 * it fills the slot the noun has vacated — which is the definition of a topic,
 * and Japanese marks a topic は. 蟲**は**是れ劉の福.
 *
 * **The treebank's own label for this is `dislocated`, and that is what the
 * reader's tree should carry.** Measured over `lzh-{train,dev,test}.sud.conllu`
 * (137,786 sentences): `dislocated` is written 536 times, 440 of them preposed
 * — 籩豆之事、則ち有司存す, 禹、吾間然すること無し, 水火、吾… — and 20 of those
 * are immediately followed by a resumptive pronoun. The shape this function
 * accepts instead, *two* `subj` of one head with the second a demonstrative,
 * occurs **4 times** (2 sentences, each present twice as the traditional text
 * and its simplified duplicate): 盡飾之道，斯其行者遠矣 and 中原皇帝。是天上
 * 人做。 So the relation the reader wrote is not the one gold writes, and it is
 * named here rather than argued with: **蟲(5) should be `dislocated` of 成(20)**,
 * leaving 是(6) as the sole `subj`.
 *
 * Both are accepted, deliberately, because the rule has to hold either way:
 * the reader's tree as it stands, and the same sentence once the relation is
 * corrected. What is required is that the two tokens **share a head** and that
 * the noun's own relation is a subject one or `dislocated` — a demonstrative
 * that merely happens to follow a noun (惟此文王 — 此 is a `det`, "this King
 * Wen") shares neither, and is refused.
 *
 * **Adjacent in source order, punctuation aside.** The resumption is what
 * makes this a dislocation, and a pronoun flung across the sentence resumes
 * nothing; a 、 between the two is exactly how the construction is written
 * (禹，吾…) and is looked through. */
function resumedByDemonstrative(token: Token, sentence: Sentence): boolean {
  if (!NOMINAL_PREDICATE_POS.has(token.pos)) return false;
  const dislocated = token.dep === "dislocated" || token.dep.startsWith("dislocated@");
  if (!dislocated && token.dep !== "subj" && !token.dep.startsWith("subj@")) return false;
  const next = sentence.tokens
    .filter((t) => t.id > token.id && t.dep !== "punct")
    .reduce<Token | undefined>((best, t) => (best === undefined || t.id < best.id ? t : best), undefined);
  if (!next || next.pos !== "PRON" || !RESUMPTIVE_DEMONSTRATIVES.has(next.lemma)) return false;
  if (next.head !== token.head || next.id === token.head || next.head === next.id) return false;
  return dislocated || next.dep === token.dep;
}

/** True when `predicate` heads the clause an **existential 有/無 asserts the
 * existence of** — 來 in 有朋自遠方來, 在 in 有父兄在 — so that a subject inside
 * it is a subordinate subject and takes の.
 *
 * 有 does not take an object; it takes a whole predication and says that it
 * obtains. That predication stands in a nominal slot, which is why
 * `decideConjForm` already gives it the 連体形 (see the existential note there,
 * and `caseParticleFor`'s own branch withholding を from it) — and a clause in a
 * nominal slot marks its own subject の, never は. 朋**の**遠方より來る有り.
 *
 * **Bounded to the shape the anchor has, and the bound is what makes the rule
 * usable.** Measured over `lzh-{train,dev,test}.sud.conllu`, a nominal `subj`
 * whose governor is an existential's `comp:obj` occurs **436** times, and the
 * unbounded class is half parse error: 蓋有之矣，我未之見也 attaches 見 to the 有
 * of the *previous* clause, so 我 — the topic of a sentence of its own — came
 * out 我の. Requiring the 有/無 to stand **before** the subject, the subject
 * before its own verb, and **no stop anywhere between the 有 and that verb**
 * leaves **242**, and those 242 are one construction: 有父兄在, 有眾逐虎,
 * 有流矢在白肉, 將有四方之賓來, 焉有仁人在位罔民而可為也, 有其舉之. The two
 * order tests are what a cross-clause attachment fails, and the stop test is
 * `stopStandsBetween`'s own argument one construction over — a 、 between the
 * existential and its clause means the parse reached across a 句, not that the
 * sentence has a long existential.
 *
 * **The wider rule this is the conservative corner of, and what it cost to
 * find.** Every other way `decideConjForm` reaches 連体形 was measured as a
 * candidate arm for the same の and each is reported rather than shipped:
 * `isNominalizedObjectPredicate` marks **6,998** subjects (蓋有之矣，我未之見也
 * → 我の — the matrix topic, wrong), `isNominalizedSubjectPredicate` **1,293**
 * (民鮮久矣 → 民の, 孔子辭以疾 → 孔子の — same fault), `negatedPredicate`
 * **454** (我非生而知之者 → 我の, and it would put a の on the standing anchor
 * 非道弘人 → 道の人を弘むるにあらず), `modifiesGenitiveZhi` **196** (the
 * cleanest of them, 堯崩之後 → 堯の崩ずる…, but still mixed), and
 * `isNominalizedObliquePredicate` **0** — a branch that could not fire, which
 * this file's own standard calls the appearance of protection rather than
 * protection. The three routes that need the *next token in reading order* (a
 * following 者, a following 耳, a 係助詞) cannot be asked at all here, since
 * `caseParticleFor` is given no reading order. */
function inAttributiveClause(predicate: Token, subject: Token, sentence: Sentence): boolean {
  // ADJ beside VERB: an existential's clausal complement can be a stative
  // (**277** of them over the recoded gold, against 1,192 VERB), and the の
  // this rule licenses belongs to the construction and not to the word class.
  if (predicate.dep !== "comp:obj" || !isContentPredicatePos(predicate.pos)) return false;
  const existential = sentence.tokens.find((t) => t.id === predicate.head && t.id !== predicate.id);
  if (!existential || !isExistentialPredicate(existential)) return false;
  if (!(existential.id < subject.id && subject.id < predicate.id)) return false;
  return !sentence.tokens.some((t) => t.dep === "punct" && t.id > existential.id && t.id < predicate.id);
}

/** True when `token` is a *negated* predicate modifying another predicate on
 * plain `mod`, and so reads **連体形 ざる + に** — 不飲一斗、適以益貧 is
 * 一斗を飲まざるに、貧に適ひて以て益す. The 不 reads ザルニ.
 *
 * **Why the negation is what makes this a rule.** Plain `mod` on a verb is the
 * generic adverbial bucket — 15,948 verbal-`mod`-of-verbal edges in
 * `lzh-{train,dev,test}.sud.conllu` — and it is left alone on purpose: an
 * *un*negated clause there takes 連用形 (連用中止法) or its own `VerbForm=Conv`
 * て, both of which are complete constructions that need no particle. A negated
 * one cannot: `negationEnding` writes ず, the 終止形, which closes the sentence
 * in the middle of one. So the negation is not a filter narrowing a rule that
 * would otherwise be right — it is the whole reason there is something to fix,
 * and it is what the user's rule names.
 *
 * **How big it is.** 988 of those 15,948 edges carry a negation, and 212 of the
 * 988 also carry a すなはち-class connective on the governor and so are already
 * claimed by `isConditionalTemporalClause` (ざれば, not ざるに) before this is
 * asked. 46 more carry a 而 and are excluded below. That leaves roughly 730
 * edges — 4.6% of the bucket — moving from a bare ず to ざるに.
 *
 * **Not all 730 want に rather than ば**: 割不正，不食 is 正しからざれば食はず, a
 * conditional with no 則 to say so, and the corpus has many like it. That is a
 * real limit and it is stated rather than papered over. What can be said is
 * that ざるに is never the worse of the two: it is a well-formed adverbial
 * clause either way, where the bare ず it replaces is a finite predicate
 * standing where the sentence has not finished.
 *
 * **The gate is `isNominalizedObliquePredicate`'s, re-used**, since the two
 * rules write the same に onto the same shape of clause and differ only in the
 * relation — that one's `OBLIQUE_DEPS`, this one's plain `mod`. A caused or
 * passive predicate, a noun the parser tagged VERB, an existential, and a
 * speech verb's reported proposition are all kept out for the reasons set out
 * there.
 *
 * **…except at one place, where the re-used gate was too narrow and the rule
 * was silently declining a fifth of its own class: AUX.** Re-measured over
 * `lzh-{train,dev,test}.sud.conllu`, every negated verbal `mod`/`udep` under a
 * verbal governor is **986** edges, and the gate as first shipped — VERB
 * dependent, VERB governor — accepted **766** of them and refused **220**:
 *
 * | dependent | governor | edges | example                        |
 * |-----------|----------|-------|--------------------------------|
 * | AUX       | VERB     |   130 | 不欲變，故不受也。               |
 * | VERB      | AUX      |    70 | 不以規矩，不能成方員             |
 * | AUX       | AUX      |    20 | 不敢以祭，則不敢以宴             |
 *
 * All 220 are the modals — 能, 得, 敢, 欲 — which this treebank tags AUX
 * (`v,助動詞,…`) and which are predicates like any other: 不以規矩、不能成方員
 * is 規矩を以ゐざるに方員を成すこと能はず, the same ざるに on the same shape of
 * clause. `isConditionalTemporalClause` — this rule's sibling, claiming the
 * same `mod` bucket one lexical trigger over — has always accepted VERB **or**
 * AUX at both ends, so an AUX-headed negated clause with a 則 got its ざれば
 * while the same clause without one fell through to a bare ず. That asymmetry
 * was the whole of what was left unimplemented, and the two gates now agree.
 *
 * **ADJ is not admitted, and that is measured too**: the governor is an ADJ in
 * **0** of the 986. `isConditionalTemporalClause` accepts one because its own
 * class has them; this one has none, and a branch that cannot fire is the
 * appearance of protection rather than protection — the standard that function's
 * own doc sets when it records removing a caused-predicate guard for the same
 * reason.
 *
 * **A 而 stands this down.** 而 supplies its own connective — `teOrShite` writes
 * て/して after the preceding form — and 人不知而不慍 is 人知らずして慍らず. Two
 * connectives on one clause is one too many, and the one the source actually
 * wrote wins. 46 of the 988 negated edges carry one. */
function isNegatedAdverbialPredicate(token: Token, sentence: Sentence): boolean {
  if (token.dep !== "mod") return false;
  if (!negationClosing(token, sentence)) return false;
  if (sentence.tokens.some((t) => t.head === token.id && t.id !== token.id && t.lemma === "而")) return false;
  if (isCausedOrPassivePredicate(token, sentence)) return false;
  if (!isVerbalPredicate(token) || isExistentialPredicate(token)) return false;
  const governor = sentence.tokens.find((t) => t.id === token.head && t.id !== token.id);
  if (!governor || !isVerbalPredicate(governor)) return false;
  if (isCommunicationVerb(governor) || isSpeechQuoteComplement(token, governor)) return false;
  return readsLastInItsSubtree(token, sentence, (child) => isNegationUse(child));
}

/** A token that is a predicate in its own right — VERB, ADJ or AUX, confirmed
 * by the fine-grained tag. The modals 能/得/敢/欲 are AUX in this treebank
 * (`v,助動詞,…`) and are predicates exactly as a VERB is; `isVerbalXpos` is
 * what keeps out a *noun* the parser tagged VERB, and is asked here for the
 * same reason `isNominalizedObjectPredicate` asks it.
 *
 * ADJ is here because a stative predicate is a predicate — see
 * `isContentPredicatePos` for the recoding that made the tag reachable, and
 * note that a stative's xpos is `v,動詞,描写,…`, so `isVerbalXpos` admits it
 * unchanged and no second gate is needed for the ADJ arm.
 *
 * Written once and shared by the two rules that claim the plain-`mod`
 * adverbial bucket, so their gates cannot drift apart again — see
 * `isNegatedAdverbialPredicate` for the 220 edges the drift was costing. */
function isVerbalPredicate(token: Token): boolean {
  return (isContentPredicatePos(token.pos) || token.pos === "AUX") && isVerbalXpos(token);
}

/** **則/即/卽/乃/斯/輒/便 — the すなはち class**, and the trigger this file keys
 * the 已然形+ば conditional on.
 *
 * The question the rule answers is "a predicate that temporally modifies
 * another predicate should read 已然形+ば". **That cannot be keyed on the
 * relation**, which is what a survey of the gold treebank
 * (`assets_sud/lzh-{train,dev,test}.sud.conllu`, 137,786 sentences /
 * 1,066,724 tokens) settled: `udep@tmod` is carried 5,074 times and **not one
 * of its dependents is a VERB or an AUX** — 93.9% of them carry XPOS
 * `n,名詞,時,*`, and a 時-class token is never tagged VERB. `@tmod` is a
 * lexical property of *time nouns*, and a verbal temporal modifier has no
 * label of its own in the inventory at all. Worse, 至見之 (至るにこれを見る)
 * and 苦不得飲 (飲むを得ざるに苦しむ) travel one code path, so keying on the
 * relation would have given the second 得ざれば and broken a confirmed target.
 *
 * So the trigger is lexical, and the corpus says which lexeme. Of the
 * 15,948 VERB/AUX/ADJ-on-`mod`|`udep`-of-VERB/AUX/ADJ edges, the connective
 * standing on the **governor** is by far the strongest signal available:
 *
 * | on the governor | edges | | on the dependent | edges |
 * |---|---|---|---|---|
 * | 則 | 1,754 | | 未 | 62 |
 * | 乃 | 76 | | 已 | 32 |
 * | 斯 | 42 | | 既 | 27 |
 * | 即 | 15 | | 始 | 14 |
 * | 輒 | 5 | | 至 | 6 |
 * | 卽 | 3 | | 及 | 4 |
 * | 便 | 2 | | 旣 | 1 |
 *
 * 至於他邦，則曰 is 他邦に至れば則ち曰く; 邦有道，則知 is 邦道有れば則ち知;
 * 杖者出，斯出矣 is 杖者出づれば斯ち出づ. The connective *is* the apodosis
 * marker, so its presence is the statement that what precedes was a protasis
 * — which is exactly the "temporally modifies" the reader asked for, said in
 * the only vocabulary the treebank has for saying it.
 *
 * **What was proposed and excluded, and why.** The candidate set put forward
 * was 既/旣/及/至/比:
 *  - **及 / 至 / 比 take て or に, not ば, and are excluded outright.** They
 *    are not adverbs marking someone else's clause; they are VERBs heading
 *    their own, with the time expression as their `comp:obj` — 及 is VERB
 *    784× / ADP 294×, 至 VERB 2,386×, 比 VERB 214×. 及其更也 is 其の更むるに
 *    及びて and 至於道 is 道に至りて: 連用形, which is what the app already
 *    writes. A ば there would be 及べば for a clause that never was one.
 *  - **比 never occurs in this bucket at all** (0 edges), so there is nothing
 *    to key on even had the shape been right.
 *  - **既/旣 are admitted**, as the one member of the proposed set that is an
 *    adverb (ADV 709×/125×, XPOS `v,副詞,時相,完了`) marking the clause it
 *    stands in rather than heading one — 既灌，然後迎牲 is 既に灌げば然る後に
 *    牲を迎ふ. 28 edges, small but the shape is exactly right, and it is the
 *    one trigger that sits on the *dependent* rather than the governor.
 *
 * **What was offered for inclusion and excluded.** 未幾 does not occur; 俄
 * (10 tokens, all ADV) and 尋 (75 ADV) are **never** a modifier of another
 * predicate — every single one heads its own root clause. They are narrative
 * sentence adverbs, 俄かに and 尋いで, and subordinate nothing. 未 (62) is the
 * negation adverb いまだ〜ず and marks polarity, not temporality; 已 (32) is a
 * real synonym of 既 but is also the verb 止む and the particle のみ, and is
 * held back rather than guessed at; 始 (14) is はじめて, a manner adverb.
 *
 * Gated on `pos === "ADV"`, the same gate overrides.json already puts on
 * these characters' own すなはち readings — 則 is also the noun のり, 斯 also
 * the pronoun これ, 便 also the noun たより. */
const RESULTATIVE_CONNECTIVE_LEMMAS: ReadonlySet<string> = new Set(["則", "即", "卽", "乃", "斯", "輒", "便"]);

/** 既/旣 — "already, once", XPOS `v,副詞,時相,完了`. The one trigger that
 * stands inside the clause it marks rather than on the clause that answers
 * it. See `RESULTATIVE_CONNECTIVE_LEMMAS` for the survey both come from. */
const COMPLETIVE_ADVERB_LEMMAS: ReadonlySet<string> = new Set(["既", "旣"]);

/** 則 — the one member of the すなはち class that *is* an apodosis marker rather
 * than a narrative "and then", and the whole of what
 * `conditionalApodosisParataxis` keys on. See that function for the corpus
 * split that took the other six out of its arm and left them in the `mod`
 * arm's `RESULTATIVE_CONNECTIVE_LEMMAS`. */
const APODOSIS_MARKER_LEMMA = "則";

/** ば — what a 已然形 conditional clause takes. See
 * `isConditionalTemporalClause`. */
const CONDITIONAL_PARTICLE = "ば";

/** A verbal predicate this treebank tags **ADV with `VerbForm=Conv`** rather
 * than VERB or ADJ — 學 in 學則不固, 過 in 過則勿憚改, 出 and 入 in
 * 出則事公卿，入則事父兄.
 *
 * **The feature is a claim about the source's word order and not about the
 * reading**, which is the finding `POSTPOSE_PREDICATE_NEGATION_LEMMAS` states
 * for the negative existential and this is the second construction to turn on
 * it. `VerbForm=Conv` says the word stands preverbally in the 白文. A converb
 * stands preverbally, and so does a protasis, so the feature cannot separate
 * the two and nothing in it says the clause hands on rather than conditions.
 * What separates them is the 則, which this rule was already reading and was
 * refusing to look at here because of the tag.
 *
 * **Counted over `lzh_kyoto-sud-{train,dev,test}…sjmerged.conllu`**, a verbal
 * `mod`/`udep` dependent whose governor carries a すなはち-class connective
 * standing after it — the protasis slot, exactly as `headsConditionalProtasis`
 * defines it — is VERB **637**, **ADV 341** and AUX 5. Every one of the 341
 * carries `VerbForm=Conv` and **not one** stands there without it: the feature
 * is what put them in ADV, so on such a token it is not evidence about the use.
 *
 * **And they are protases in the received text, not a residue.** 奢則不孫 is
 * 奢れば則ち不遜, 儉則固 儉なれば則ち固, 出則事公卿 出でては則ち公卿に事へ,
 * 恭則不侮 恭なれば則ち侮られず, 過則勿憚改 過てば則ち改むるに憚ること勿かれ —
 * and 學則不固, which is 學べば則ち固ならず where this app wrote 學**びて**則ち.
 * The 連用形+て came from the same feature, through `morphEndingFor`'s converb
 * arm; `extraEndingFor` stands that arm down where this rule has claimed the
 * token, so the ending and the form cannot come apart. */
function isConverbTaggedPredicate(token: Token): boolean {
  if (token.pos !== "ADV") return false;
  if (!token.xpos.startsWith("v,動詞,")) return false;
  return parseMorphFeatures(token.morph ?? "").VerbForm === "Conv";
}

/** The POS gate `isConditionalTemporalClause` and `headsConditionalProtasis`
 * share — VERB, ADJ and AUX as before, and the converb-tagged ADV above beside
 * them. Written once because those two functions find the *end* and the *head*
 * of one clause, and a chain whose head one of them refused would lose its ば
 * however the other end was tagged. */
function isProtasisPredicatePos(token: Token): boolean {
  return isContentPredicatePos(token.pos) || token.pos === "AUX" || isConverbTaggedPredicate(token);
}

/** `isAdverbialDescriptiveUse`, asked of a protasis candidate — and **not asked
 * of one the treebank has already tagged ADV**, which is the one place that
 * refusal has to stand down.
 *
 * `isAdverbialDescriptiveUse` refuses a 描写 stative carrying `VerbForm=Conv`
 * because a stative used as a manner adverb is not a clause (半 in 輒半種黍 is
 * 半ば). Its evidence is the feature standing on a **VERB or ADJ**, where the
 * feature is the only thing separating the adverbial use from the predicative
 * one. On a token tagged ADV the feature is not that evidence — it is what put
 * the token in ADV, and every one of the 341 protasis-slot ADV carries it. So
 * the two tests would cancel: `isConverbTaggedPredicate` would admit them and
 * this would refuse the 174 of the 341 that are 描写 (97 of those the 然 of
 * 然則, which is 然らば則ち).
 *
 * **Measured over the kanbun.info corpus**, both ways round and in one process:
 * admitting the converb-tagged ADV while keeping this refusal moves 15 passages
 * closer and 5 further, net −20 edits; standing it down for them as well moves
 * **30 closer and 7 further, net −50**. The wider reading is the one the
 * received text keeps agreeing with, so it is the one shipped. */
function refusedAsAdverbialDescriptive(token: Token): boolean {
  if (isConverbTaggedPredicate(token)) return false;
  return isAdverbialDescriptiveUse(token);
}

/** `v,動詞,描写` — the treebank's **stative/descriptive** verb class, the words
 * that are adjectives in Japanese: 正, 重, 盛, 煩, 強, 弱, 明, 急.
 *
 * Named here for `isAdverbialDescriptiveUse`, which is the one thing in this
 * file that reads it. */
const DESCRIPTIVE_XPOS_PREFIX = "v,動詞,描写";

/** True for a 描写 stative standing as a **manner adverb or an attributive
 * participle** rather than as a clause of its own — the use
 * `isConditionalTemporalClause` has to keep out.
 *
 * **This replaces a blanket refusal of the whole 描写 class, and the class was
 * the wrong unit.** The refusal was written for 輒半種黍 — 輒ち半ば黍を種う,
 * where 半 is the adverb 半ば and 半ばば is nonsense — and it was reading the
 * fine tag as if `v,動詞,描写,*` in an adverbial slot could only ever be a
 * manner or degree adverb. It cannot: a stative predicate is exactly what a
 * conditional protasis is most often built out of, because "if X is Y" is the
 * commonest thing a protasis says.
 *
 * **What the corpus actually holds.** Over `lzh_kyoto-sud-{train,dev,test}`
 * (86,239 sentences / 433,169 tokens) a 描写-tagged token on `mod`/`udep` is
 * **three** disjoint things, and the features say which:
 *
 * | shape                     | edges | example                       |
 * |---------------------------|-------|-------------------------------|
 * | VERB + `VerbForm=Part`    | 7,600 | 不仁者 — attributive, on a NOUN |
 * | ADV  + `VerbForm=Conv`    | 4,491 | 父母在不遠遊 — the manner adverb  |
 * | VERB, no `VerbForm`       |   652 | 我未見力不足者 — a bare stative   |
 *
 * The manner adverb is `VerbForm=Conv`, and **輒半種黍's 半 is one of them**:
 * the reader's own tree tags it `ADV v,動詞,描写,量 Degree=Pos`, and 14 of
 * gold's 42 `mod`-attached 半 are the same ADV+Conv shape (the other 28 are
 * VERB+Part, the attributive 半夏生 / 緣廣寸半). So the anchor the blanket
 * refusal was written for was already being refused twice over — by
 * `isConditionalTemporalClause`'s own `pos === "VERB" || "AUX"` gate for the
 * ADV ones, and by its verbal-governor gate for the Part ones, which modify a
 * noun. The 描写 line was not what kept 半ばば out of the prose.
 *
 * **What it did keep out, measured.** Of the edges that pass every other
 * condition this rule has — the relation, a verbal governor, a すなはち-class
 * connective standing after the clause (or a 既 inside it), and being the last
 * link of its own coordination chain — **82** carry a 描写 dependent, across
 * **74** distinct sentences, and the blanket refusal was turning all 82 into a
 * bare 終止形 in the middle of a conditional. Not one of them is a manner
 * adverb; **every one carries `Degree=Pos` and no `VerbForm` at all**, and what
 * they are is the textbook 已然形+ば:
 *
 *     名不正則言不順   名正しからざれば則ち言順はず
 *     君子不重則不威   君子重からざれば則ち威あらず
 *     物盛則衰         物盛んなれば則ち衰ふ
 *     事煩則亂         事煩はしければ則ち亂る
 *     楚強則秦弱       楚強ければ則ち秦弱し
 *     心莊則體舒       心莊なれば則ち體舒ぶ
 *
 * That is 82 of the 636 edges the relation-plus-trigger test admits — 13% of
 * the rule's own class, and the single largest thing it was not reaching.
 *
 * **So the guard keys on the feature, which is what states the use.** It is not
 * a guard that cannot fire: `VerbForm=Conv` and `VerbForm=Part` are carried by
 * 12,091 描写 tokens in this very slot, which is 95% of them. What is true is
 * that none of those 12,091 also carries a すなはち trigger, so nothing in gold
 * changes on account of the guard alone — it is there for a live parse, where
 * the same character can come back VERB rather than ADV, and it is the feature
 * and not the coarse tag that would then say 半 is 半ば. */
function isAdverbialDescriptiveUse(token: Token): boolean {
  if (!token.xpos.startsWith(DESCRIPTIVE_XPOS_PREFIX)) return false;
  const verbForm = parseMorphFeatures(token.morph ?? "").VerbForm;
  return verbForm === "Conv" || verbForm === "Part";
}

/** **A note on `mod@tmod` over a verbal dependent, which is not a relation and
 * which nothing here keys on.**
 *
 * A rule was written to make such an edge read 已然形+ば and then taken out
 * again, because the finding underneath it is about *annotation* and not about
 * this file. It is recorded here so the same rule is not written a second time.
 *
 * **The label is out of the treebank's inventory.** `RESULTATIVE_CONNECTIVE_LEMMAS`
 * already reports that `udep@tmod` is carried 5,074 times in
 * `lzh-{train,dev,test}.sud.conllu` with **not one VERB or AUX dependent** —
 * 93.9% are `n,名詞,時,*`, time *nouns*. Re-measured across all seven
 * `OBLIQUE_DEPS`: every oblique edge with a VERB/AUX dependent is `comp:obl`
 * (2,586) or `udep@lmod` (20), and **`mod@tmod` over a verb does not occur once
 * in 137,786 sentences**. `isNominalizedObliquePredicate`'s own doc already
 * calls it "the label this parser reaches for when a predicate hangs off
 * another predicate obliquely" — a parser artefact, not an analysis.
 *
 * **It is being made to carry two different relations**, which is why no test
 * inside this file can separate them:
 *
 *  - 得 in 苦不得飲 is an **argument** — what 苦しむ is suffering from — and the
 *    relation is **`comp:obj`**. This bullet said `comp:obl` and that is
 *    withdrawn: re-measured over `lzh_kyoto-sud-{train,dev,test}`, a governor of
 *    苦's own class (`v,動詞,描写,態度`) takes a VERB/AUX dependent on `comp:obj`
 *    170 times and on `comp:obl` **once** in the whole corpus, and 苦 itself
 *    governs a predicate 13 times with **none** of them oblique. 俗士苦不知變
 *    and 李斯稅駕苦不早 are the same construction and both are `comp:obj`. See
 *    `negationEndingParts`' object arm.
 *  - 解 in 解縛視之、赤肉… and 貯 in 甕中貯水…即成佳釀 are free adverbial
 *    **adjuncts**, which is plain **`mod`**.
 *
 * **Re-labelled, two of the three readings fall out of the rules already
 * shipped, with no code at all.** Measured on the reader's own tree with those
 * three edges relabelled and nothing else changed:
 *
 *  - 得 → `comp:obj` (the label the bullet above corrects to): 飲むを得ざるを
 *    苦しむ. `isNominalizedObjectPredicate` gives the 連体形 and
 *    `negationEndingParts` writes the を onto the ざる, which is the arrangement
 *    the oblique に has always been in. Under `comp:obl` — the label this line
 *    used to name — it is 飲むを得ざるに instead, and that reading is unchanged
 *    for a tree that carries it.
 *  - 貯 → `mod`: 蟲を入れこれを攪せ**ば**、すなはち佳釀を成す — this rule fires on
 *    its own 即, which stands on the governor after the whole clause and is
 *    exactly the trigger it has always keyed on. The label was the only thing
 *    refusing it.
 *  - 解 → `mod`: 縛を解きこれを視る、赤肉…. **No ば**, because the sentence
 *    contains no connective and nothing in any correct annotation of it says
 *    the clause is a protasis. 之を視れば is a real reading and the evidence for
 *    it is the discovery semantics, which no label carries. That one is a
 *    question about this rule's trigger, not about the tree, and is referred
 *    back rather than answered by routing the 11,822-edge adverbial bucket to
 *    ば. See the report.
 *
 * **The one narrow trigger that was proposed for 解縛視之, measured and
 * refused.** 解's governor is the *nominal* root 肉, not a verb, so "a verbal
 * clause adjunct on a nominal predicate" looked like it might be a much
 * smaller and better-defined class than the whole adverbial bucket. Counted
 * over `lzh-{train,dev,test}.sud.conllu` it narrows steadily and is the wrong
 * class at every size:
 *
 * | shape                                            | edges  |
 * |--------------------------------------------------|--------|
 * | verbal `mod`, any governor                       | 47,216 |
 * | …of a non-verbal governor (NOUN 22,990)          | 31,268 |
 * | …of a NOUN that is the sentence root             |  1,926 |
 * | …and carrying a core argument of its own         |    560 |
 *
 * **What is in it is not clause adjuncts.** It is attributive adjectives and
 * relatives standing *inside* a nominal predicate — 里仁篇第四, 皆賢人也,
 * 人之大倫也, 何事非君 — and the 560 that carry an argument are 文勝質則史,
 * 是社稷之臣也, 是誰之過與. A ば keyed on that shape reads 里の篇 as 里れば. The
 * 1,918-of-1,926 that precede their governor do not separate it either: nearly
 * all of them do, because that is where a modifier goes.
 *
 * So there is no narrow trigger, and the answer stands where the last round
 * left it — **the annotation**. What 解縛視之 would need is a すなはち-class
 * connective the sentence does not have; there is no label that says a clause
 * is a protasis on its own, and the reading 之を視れば rests on the passage's
 * discovery semantics rather than on anything a tree carries.
 *
 * **And the trigger itself was then dropped and measured, which settles the
 * question the paragraph above referred back.** 白頭搔更短 is received 白頭掻け
 * **ば**更に短く and carries no 則 and no 既, so it asks for exactly the same
 * thing 解縛視之 does: a protasis recognised from the tree alone. Run that way —
 * `headsConditionalProtasis` returning true on the relation and the POS gate,
 * with the two lexical tests removed and nothing else changed — the whole of
 * kanbun.info reads **+1,597 edits worse** (gold +112, parser +1,485), moving
 * 811 passages of which **39 are closer and 772 further**. That is not a rule
 * being narrowly outvoted; it is the wrong analysis of the slot.
 *
 * **What is in the slot says why.** The relation-and-POS gate alone admits
 * **18,578** untriggered edges over `lzh_kyoto-sud-{train,dev,test}`, and the
 * lemmas heading them are 以 5,478, 大 666, 無 490, 然 374, 因 275, 獨 223,
 * 至 212, 始 212, 凡 160, 甚 157 — adverbs, overwhelmingly, not clauses. 以て
 * comes out **以てば** under it, and 獨り, 凡そ, 甚だ likewise. The trigger is not
 * a hedge around a rule that is otherwise right; it is the only thing in the
 * tree that distinguishes a protasis from an adverb standing in front of a verb.
 *
 * **The slot is answered all the same, and with the other form.** Everything
 * this refuses now falls to `isPreposedAdverbialClause` below, which reads a
 * preposed verbal `mod` as 連用形 — 白頭搔 comes out 白頭搔**き**更に短く, the
 * 連用中止法 rather than the ば. That is the reading the corpus does accept, at
 * -34 edits when the gate was chosen and -2 when it was re-measured against a
 * later tree (see that function's closing paragraph), against this rule's
 * +1,597; and where the received text has ば this app is now one construction
 * short rather than a sentence boundary out. The ば itself needs a すなはち in
 * the sentence or a hand in the annotation, and neither is this file's to
 * supply. */

/** True when `token` is a predicate whose clause is the protasis of a
 * conditional/temporal pair, and so reads **已然形 + ば**: 至於他邦，則曰 is
 * 他邦に至れば、則ち曰く.
 *
 * Written to the same shape as the `isNominalizedObjectPredicate` (を) /
 * `isNominalizedSubjectPredicate` (こと) / `isNominalizedObliquePredicate`
 * (に) trio above, and for the same reason: **one predicate is asked by both
 * `decideConjForm` (the 已然形) and `caseParticleFor` (the ば)**, so a form
 * with no particle after it, or a particle on a form that did not expect one,
 * cannot arise. `negationEnding` is the third caller, for the case where a
 * postposed negation is what actually stands at the end of the clause and so
 * carries the ば itself — 學而不思則罔 is 學びて思はざれば則ち罔し.
 *
 * The conditions, and what each one is keeping out:
 *
 *  - **`mod` or plain `udep`** — *or* the apodosis hanging off this clause by
 *    `parataxis`, which is the same pair of clauses with the edge running the
 *    other way and is the treebank's commonest arrangement of them. See
 *    `conditionalApodosisParataxis`, which is the whole of that second arm.
 *    The adverbial-clause slot, and the one
 *    `decideConjForm` had no branch for at all — such a token fell out the
 *    bottom to 終止形, or took 連用形/て off its own `VerbForm=Conv`. The
 *    oblique relations (`@tmod`, `@lmod`, `comp:obl`) are deliberately *not*
 *    here: those are `isNominalizedObliquePredicate`'s, they read 連体形+に,
 *    and 苦不得飲 → 飲むを得ざるに苦しむ is the target that keeps them so.
 *  - **A lexical trigger.** Either the governor carries a すなはち-class
 *    connective as a direct ADV child, or this token carries 既/旣 as one.
 *  - **The connective is written after this clause.** 則 marks the apodosis
 *    and always follows its protasis; requiring `id` order keeps a
 *    sentence-initial 乃 from retro-claiming a clause that reads before it.
 *  - **Verbal, and not an *adverbial or attributive* use of a 描写 stative.**
 *    The eventive classes (行為/変化/移動) and the existentials 有/無 are what a
 *    protasis is built from: 邦有道，則知 is 邦道有れば則ち知, and that ラ変 已然形
 *    れ is one of the forms this rule exists to reach. **So is a 描写 stative,
 *    and this is where the rule was refusing its own best class** — see
 *    `DESCRIPTIVE_XPOS_PREFIX` for the three-way split the corpus draws and for
 *    the 82 protases the blanket refusal was costing.
 *  - **A caused predicate needs no guard, and does not get one.** 使民戰 is
 *    民をして戰はしむ, and a caused predicate owes its governor a 未然形 and
 *    takes no particle at all — but it is never on `mod`. This parser puts a
 *    caused predicate on `comp:obl` (使民戰's own 戰), `comp:aux`, or
 *    `parataxis` (酒蟲's 但令於日中俯臥), which is the whole of what
 *    `isCausedPredicateOf` accepts, and none of the three is a relation this
 *    rule reads. An `isCausedOrPassivePredicate` call here was written and
 *    then taken out on finding it could not fire: the relations are disjoint,
 *    and a guard that never runs is not protection, only the appearance of it.
 *    Same for a passive, whose complement is `comp:obj` or `comp:aux`.
 *  - **Not already claimed by the distributive 每.** 每獨酌、輒盡一甕 has both
 *    a 每 on the dependent and a 輒 on the governor, and 每 wins: the reading
 *    is 獨り酌むごとに輒ち一甕を盡くす, 連体形+ごとに, which
 *    `hasDistributivePostposeChild` already writes. Two conjunctions on one
 *    clause is one too many.
 *  - **Reads last in its own subtree**, so the ば lands at the clause end and
 *    not inside it. A postposed negation is skipped exactly as the oblique
 *    rule skips it, because that negation is what carries the ば.
 *
 * **What this deliberately does not cover.** 180 of the triggered edges also
 * carry an explicit hypothetical 若/如/苟 in the protasis, where the classical
 * reading is the *未然形*+ば of a supposition (若取法相，即著我 → 若し法相を取ら
 * ば) rather than the 已然形+ば of a fact. They are given the 已然形 here along
 * with the rest: it is one ば either way, the two differ only in the stem, and
 * splitting the rule on a second lexical class before the first one has been
 * looked at in use would be guessing twice. And a clause joined by
 * `conj:coord` rather than `mod` is not reached at all — 劉愕然、便求醫療 has
 * its 便 on a coordinand, and 劉愕然たれば便ち醫療を求む is a reading this rule
 * does not produce. Coordination is `isNonFinalCoordinand`'s, it means 連用中止法
 * by the reader's own settled decision, and reaching into it wants its own
 * pass. */
export function isConditionalTemporalClause(token: Token, sentence: Sentence): boolean {
  // Which predicate *is* the clause, and which one ends it, are two questions
  // once the protasis is a chain of coordinated verbs — 學而不思則罔 heads its
  // protasis on 學, which carries the `mod` and the 則, and closes it on 思,
  // which carries the ば. A chain of one collapses the two back together and
  // this reads exactly as it did before there was a chain to walk.
  // The cheap tests about this token alone first — a chain walk is a
  // whole-sentence traversal and every token in the sentence reaches here
  // through `caseParticleFor`.
  // ADJ beside VERB and AUX. **The doc line below is the argument for it**:
  // this rule was already written around statives — 名不正則言不順 is the
  // example it gives — and under 0.3.2 名不**正** is tagged ADJ, so a
  // VERB/AUX-only gate would have refused the very sentence the rule exists
  // for. Over the recoded gold a protasis head is VERB 1,549 / **ADJ 197** /
  // AUX 91. See `isContentPredicatePos`.
  if (!isProtasisPredicatePos(token)) return false;
  if (!isVerbalXpos(token)) return false;
  // A 描写 stative used as a manner adverb or an attributive participle is not
  // a clause — 半 in 輒半種黍 is 半ば. A 描写 stative used as a *predicate* is
  // exactly what a protasis is built from (名不正則言不順), and the feature is
  // what tells the two apart. See `isAdverbialDescriptiveUse`, which is the
  // whole of what keeps the ADJ arm above from claiming an adverbial one.
  if (refusedAsAdverbialDescriptive(token)) return false;
  const chain = predicateCoordinationChain(token, sentence);
  if (lastLinkOf(chain).id === token.id && chain.some((link) => headsConditionalProtasis(link, token, sentence))) {
    return readsLastInItsSubtree(token, sentence, (child) => isNegationUse(child));
  }
  // …and the other way round the edge. See `conditionalApodosisParataxis`.
  const conjuncts = predicateCoordinationChain(token, sentence, NOMINAL_COORDINATION_DEPS);
  if (lastLinkOf(conjuncts).id !== token.id) return false;
  const apodosis = conjuncts.reduce<Token | undefined>(
    (found, link) => found ?? conditionalApodosisParataxis(link, token, sentence),
    undefined,
  );
  if (!apodosis) return false;
  return readsLastInItsSubtree(
    token,
    sentence,
    (child) => isNegationUse(child) || child.id === apodosis.id,
  );
}

/** The **apodosis this predicate carries as a `parataxis` child of its own** —
 * the second shape a protasis comes in, and the one
 * `headsConditionalProtasis` above cannot see because the edge runs the other
 * way.
 *
 * `headsConditionalProtasis` reads the arrangement the parser ordinarily
 * returns: the protasis hangs off the apodosis by `mod`, and the 則 stands on
 * the apodosis as an ADV child. 趙爽's preface parses that way for
 * 有以見天地之𦣱，則渾天有靈憲之文 and reads 天地の𦣱を見ること有**れば**則ち.
 * The hand-corrected tree for the same sentence does not: it makes the two
 * clauses siblings in a narrative chain, hanging the apodosis 有 off the
 * protasis 有 by `parataxis`, and the ば disappeared — 見る有り、則ち渾天に….
 * Nothing about the sentence changed, only which end of one edge is the
 * dependent, and the received reading is 見ること有**れば**則ち either way.
 *
 * **The shape is the treebank's commonest, not a peculiarity of that tree.**
 * Counted over `lzh_kyoto-sud-{train,dev,test}…sjmerged.conllu` by asking what
 * governs each すなはち-class ADV: its governor stands on `parataxis` **1,825**
 * times against 1,059 roots, 502 `conj:coord` and 48 `comp:obj`, and in
 * **1,870** of those the governor hangs off a token that precedes the 則. Of
 * those 1,870 the token the apodosis hangs off is a verbal VERB **1,683** and
 * an AUX 101 — and they are protases: 名不正，則言不順；言不順，則事不成 chains
 * five of them in one sentence, each 則-clause a `parataxis` child of the
 * clause that conditions it, and the received reading is
 * 名正しからざれば則ち言順はず、言順はざれば則ち事成らず.
 *
 * The remaining 186 are refused by the same POS and xpos gates the `mod` arm
 * spends: NOUN 39, PART 15, NUM 9, ADP 6, PUNCT 5 (子曰「：弟子入則孝 hangs the
 * apodosis off the misplaced colon), PRON 3, PROPN 3, INTJ 3 (嗟乎！貧窮則…),
 * ADV 2, SCONJ 1.
 *
 * **The 則 must stand between the two clauses, which is what tells this shape
 * from a parse that has simply mis-attached one.** 忠告而善道之，不可則止 hangs
 * 可 off 告 by `parataxis` and puts the 則 on 可 — but *after* it, because what
 * the 則 answers there is 不可 and not 忠告. Requiring `clauseEnd < 則 <
 * apodosis` keeps 忠告 out while admitting every 〜，則〜 in the corpus, where
 * the connective opens the answering clause by construction.
 *
 * **The chain is walked with the explicit coordinators only**
 * (`NOMINAL_COORDINATION_DEPS`), where the `mod` arm walks the full
 * `COORDINATION_DEPS`. It has to be: `parataxis` is in that wider set, so the
 * apodosis is itself a link of the protasis chain under it, the protasis is
 * never the chain's last member, and the rule could not fire at all. What a
 * protasis of coordinated verbs is joined by is 而 — `conj:coord` — and that is
 * what the narrower walk keeps.
 *
 * **則 alone, where the `mod` arm takes the whole すなはち class, and the corpus
 * is what draws the line.** Over the same treebank the connective in this shape
 * is 則 **1,449**, 乃 166, 即 48, 斯 37, 卽 3, 輒 2, 便 2. Run with the whole
 * class, the rule moved 17 kanbun.info passages for a net of **+2** — and the
 * sign splits by lemma. Every 則 passage is a win: 上好禮則民易使 goes
 * 上禮を好み → 上禮を好め**ば**則ち (−2), 其言之不怍則為之也難 其の言を之れ怍ら
 * ざれ**ば**則ち (−3), 薄責於人則遠怨矣 薄く人に責むれ**ば**則ち (−3),
 * 如得其情則哀矜勿喜 其の情を得れ**ば**則ち (−2). Every 乃 passage is a loss:
 * 必見人災，乃可以謀 is received 人災を見**て**、乃ち以て謀る可し and came out
 * 見れ**ば**乃ち (+1, and +2 again in the next passage of the same text),
 * 項王已約，乃引兵解而東歸 項王已に約し、乃ち (+1).
 *
 * **And that is what the two words are.** 則 marks an apodosis — it says the
 * clause before it was a condition — where 乃 in a narrative chain is "and
 * then", the next thing that happened, which kundoku hands on with 連用形 or て.
 * The `mod` relation carries the claim that one clause subordinates the other
 * and can afford the looser lexical class; this shape is a chain of siblings
 * and has nothing but the connective to say that a subordination is meant, so
 * it takes only the word that says so. 即/卽/斯/輒/便 are held out with 乃 rather
 * than admitted on 斯's one −1: 90 edges between them is not enough to separate
 * them on, and the conservative answer keeps the 連用形 the app already writes.
 *
 * **And the apodosis is skipped from the subtree test for the same reason.**
 * `readsLastInItsSubtree` asks whether anything in this token's subtree is read
 * after it, so that the ば lands at the clause end; under this shape the whole
 * answering clause *is* in that subtree, and counting it would refuse every one
 * of the 1,784. It is skipped exactly as a postposed negation is: what follows
 * the protasis here is not material inside it but the clause it hands on to. */
function conditionalApodosisParataxis(head: Token, clauseEnd: Token, sentence: Sentence): Token | undefined {
  if (!isProtasisPredicatePos(head) || !isVerbalXpos(head)) return undefined;
  if (refusedAsAdverbialDescriptive(head)) return undefined;
  // 每 wins over 則 here as it does in `headsConditionalProtasis`, and the
  // guard stays on the head where the 每 hangs.
  if (hasDistributivePostposeChild(head, sentence)) return undefined;
  return sentence.tokens.find((apodosis) => {
    if (apodosis.head !== head.id || apodosis.id === head.id) return false;
    if (apodosis.dep !== "parataxis" || apodosis.id <= clauseEnd.id) return false;
    if (!isContentPredicatePos(apodosis.pos) && apodosis.pos !== "AUX") return false;
    const connective = sentence.tokens.find(
      (t) =>
        t.head === apodosis.id &&
        t.id !== apodosis.id &&
        t.id > clauseEnd.id &&
        t.id < apodosis.id &&
        t.pos === "ADV" &&
        t.lemma === APODOSIS_MARKER_LEMMA,
    );
    if (!connective) return false;
    // **And the protasis must be the clause the 則 actually answers**, which
    // on a long sentence is not given by the edge alone. 故能彌綸天地之道，
    // 有以見天地之𦣱，則渾天有靈憲之文 parses with the 則-clause a `parataxis`
    // child of the *root* 能 and the real protasis 有 buried inside that
    // child's own subtree, so the edge said 能 while the reading is
    // 故に能く…彌綸し、𦣱を見ること有れ**ば**則ち. Taken on the edge alone the app
    // wrote 故に能く**ば**, a ば on a clause five words and another clause away
    // from its connective.
    //
    // So the last word written before the connective has to be this clause's
    // own — inside the protasis and outside the answering clause. Punctuation
    // is skipped, since a ， is what ordinarily stands between the two, and the
    // apodosis's own subtree is what the second test rules out: 𦣱 above is a
    // descendant of both 能 and the 則-clause, and that is exactly what says the
    // protasis is the clause 𦣱 belongs to rather than 能's.
    const before = sentence.tokens.reduce<Token | undefined>(
      (last, t) =>
        t.id < connective.id && t.dep !== "punct" && (!last || t.id > last.id) ? t : last,
      undefined,
    );
    if (!before) return false;
    return governs(head.id, before.id, sentence) && !governs(apodosis.id, before.id, sentence);
  });
}

/** Whether `head` is the predicate that *holds a conditional protasis onto its
 * apodosis* — the relation and the lexical trigger, which are claims about the
 * clause as a whole rather than about the word the ば is written on.
 *
 * `clauseEnd` is the member of `head`'s chain said last, and is what the
 * connective has to follow: 則 marks the apodosis, so it stands after the whole
 * protasis, not merely after the conjunct that heads it. For a protasis of one
 * predicate the two are the same token and this is the test that has always
 * been written here.
 *
 * The 每 guard stays on the head, where the 每 hangs: 每獨酌、輒盡一甕 has both a
 * 每 on the dependent and a 輒 on the governor, and 每 wins (獨り酌むごとに輒ち
 * 一甕を盡くす). See `isConditionalTemporalClause`'s own doc for what each of
 * these conditions is keeping out. */
function headsConditionalProtasis(head: Token, clauseEnd: Token, sentence: Sentence): boolean {
  if (head.dep !== "mod" && head.dep !== "udep") return false;
  // The same widening `isConditionalTemporalClause` takes, and it has to be
  // the same one: that function finds the clause's *end* and this one its
  // *head*, and a chain whose head this refused would lose its ば however the
  // end was tagged.
  if (!isProtasisPredicatePos(head)) return false;
  if (!isVerbalXpos(head)) return false;
  if (refusedAsAdverbialDescriptive(head)) return false;
  if (hasDistributivePostposeChild(head, sentence)) return false;
  const governor = sentence.tokens.find((t) => t.id === head.head && t.id !== head.id);
  if (!governor) return false;
  // The ADJ arm here was written before the parser could emit the tag and was
  // dead code until 0.3.2; it is live now, and it is what it always claimed to
  // be — an apodosis whose own predicate is a stative (名不正則言不**順**).
  if (!isContentPredicatePos(governor.pos) && governor.pos !== "AUX") return false;
  return (
    sentence.tokens.some(
      (t) =>
        t.head === governor.id &&
        t.id !== governor.id &&
        t.id > clauseEnd.id &&
        t.pos === "ADV" &&
        RESULTATIVE_CONNECTIVE_LEMMAS.has(t.lemma),
    ) ||
    sentence.tokens.some(
      (t) => t.head === head.id && t.id !== head.id && t.pos === "ADV" && COMPLETIVE_ADVERB_LEMMAS.has(t.lemma),
    )
  );
}

/** True when `token` heads a **preposed verbal adjunct clause** — a VERB
 * hanging off a predicate by `mod` and standing in front of it — which reads
 * **連用形**, the 連用中止法 that hands one clause on to the next. 感時花濺淚 is
 * 時を感じ花に淚を濺ぎ, where this app wrote the 終止形 時を感**ず**; 誡曰 is
 * 誡めて曰く, where it wrote 誡**む**曰く.
 *
 * **This is the relation `decideConjForm` had no branch for at all.** A token
 * in this slot fell out the bottom of that function to 終止形 — the form that
 * *closes* a sentence — so a clause the tree says is subordinate was printed as
 * though it ended the line and the next clause began cold after it. It is the
 * commonest such slot the treebank has: over
 * `lzh_kyoto-sud-{train,dev,test}.relabeled_ext.udep_ruled.punct.rulemerged.adjfix.conllu`
 * the gate below reaches **6,372** edges (head VERB 4,830, AUX 1,001, ADJ 541),
 * **1,484** of which carry a すなはち-class connective and are claimed by
 * `isConditionalTemporalClause` above this — 已然形+ば — leaving **4,888** that
 * nothing in this file had anything to say about.
 *
 * **The feature that would ordinarily mark it cannot reach this token, and that
 * is counted rather than assumed.** `VerbForm=Conv` stands on **13,478** tokens
 * of that corpus and every one of them is tagged **ADV** — 13,478 of 13,478 —
 * and **not one** of the 13,478 governs a `comp:obj`. The feature is carried by
 * a word the treebank has already re-tagged as an adverb, so a verb still
 * holding an object of its own can never wear it: 感 in 感時 governs 時 and is
 * VERB, and `decideConjForm`'s Conv branch is blind to it by construction. The
 * shape has to be read off the tree, and this is that reading.
 *
 * The conditions, and what each one is keeping out:
 *
 *  - **Plain `mod`, and VERB.** The adverbial-adjunct slot, the same relation
 *    `headsConditionalProtasis` keys on. `udep` is deliberately *not* here
 *    where it is there: a protasis is identified by its own lexical trigger and
 *    can afford the looser label, while this rule has no trigger and must not
 *    reach for one. The oblique subtypes (`@tmod`, `@lmod`, `comp:obl`) are
 *    `isNominalizedObliquePredicate`'s and read 連体形+に.
 *  - **Preposed.** A `mod` standing *after* its head is not an adjunct clause
 *    the reading hands on from; it is postposed material, and whatever form it
 *    takes is decided where it is actually read.
 *  - **The head is a predicate** — `isContentPredicatePos` or AUX, the identical
 *    governor gate `headsConditionalProtasis` applies, so the two adverbial
 *    rules agree about what an apodosis is. A verbal `mod` of a *nominal* is
 *    not reached, and that exclusion is load-bearing: the note above
 *    `isConditionalTemporalClause` counts 31,268 verbal `mod` edges under a
 *    non-verbal governor and finds them to be attributive relatives inside a
 *    nominal predicate (里仁篇第四, 皆賢人也, 是誰之過與), not adjuncts at all.
 *  - **Not an adverbial or attributive use of a 描写 stative**, the same refusal
 *    `isConditionalTemporalClause` takes and by the same function — 半 in
 *    輒半種黍 is 半ば and is not a clause.
 *  - **Reads last in its own subtree**, so the 連用形 lands at the clause's end
 *    and not inside it, with a postposed negation skipped for the reason
 *    `isConditionalTemporalClause` skips it. Worth −2 edits on its own (see the
 *    table).
 *
 * **Measured A/B in one process over the whole of kanbun.info**, each variant
 * against the tree rendered immediately before it, all figures gold/parser:
 *
 * | variant                                        | gold | parser | total |
 * |------------------------------------------------|-----:|-------:|------:|
 * | `mod`+VERB, head VERB/ADJ                      |   ±0 |    −25 |   −25 |
 * | …and `readsLastInItsSubtree`                   |   ±0 |    −27 |   −27 |
 * | …and an AUX head — **shipped**                 |   ±0 |    −34 |   −34 |
 * | …ADJ dependents beside VERB                    |   ±0 |    −25 |   −25 |
 * | …only where the clause governs something       |   ±0 |     −6 |    −6 |
 * | …that, and `readsLastInItsSubtree`             |   ±0 |     −8 |    −8 |
 * | …`mod`+VERB with 以 excluded                   |   ±0 |    −25 |   −25 |
 *
 * The shipped row moves 174 passages, 102 closer and 72 further, and no passage
 * by more than 2 in the wrong direction. 誡曰 -> 誡めて曰く and 舍人相與諫曰 ->
 * 相諫めて曰く are what it is buying; kokyo07's 導之以禮樂 -> 之を導**き** against
 * the received 之を導く**に** (a 連体形 the oblique rule would have to claim) and
 * kokyo15's 從父之令 -> 父の令に從**ひ** against the received 從**う** are what it
 * is paying, and both of those are one kana each.
 *
 * **How much of that survives is a question about the rest of the tree, and the
 * honest answer is: the sign, not the size.** Those seven rows were taken
 * against one another in one process and against the tree rendered immediately
 * before them, which is what chose the gate and is the only thing that
 * comparison is for. Re-measured two hours later — the same corpus, the same
 * fold, this rule against a copy of the tree with exactly this rule and the 抵
 * line reverted — the pair reads **-3** (gold +1, parser -4; 64 passages closer,
 * 61 further), of which 抵 is -1 and this rule is **-2**. In between, concurrent
 * work on `readingResolver.ts` moved the whole corpus **+1,322 edits**, and what
 * a 連用形 *spells* is exactly what such a change decides, so most of the -34
 * was being scored against readings that have since moved. The rule is right
 * about the relation either way and it improves the total either way; the figure
 * to bank is the one taken when the branch is assembled, not this one.
 *
 * **Three of those rows are worth reading as findings rather than as rejected
 * settings.**
 *
 *  - **以 is inert here**, and the −25 row proves it: excluding the lemma moves
 *    *exactly* the same 156 passages by exactly the same 25 edits. 以 is 2,242
 *    of the 4,888 untriggered edges — by far the largest lemma in the class —
 *    and `overrides.json` reads it as a split もつ + て, a fixed reading no
 *    conjugation rule can touch. So the class is half the size it looks.
 *  - **Requiring the clause to govern something makes it worse** (−6 against
 *    −25), which is the opposite of what "a clause, not an adverb" would
 *    predict. Nearly all the gain is on *bare* verbal `mod` — 誡曰, 諫曰, 對曰 —
 *    where the received text writes the converb as a matter of course. A
 *    single-token adjunct is not an adverb wrongly tagged; it is the shape this
 *    reading is surest about.
 *  - **ADJ dependents cost 2 edits** (−25 against −27 on the same base), so the
 *    gate stays on VERB. An ADJ in this slot is overwhelmingly attributive, and
 *    `modifiesAdjacentNominal` above already has the ones that are not.
 *
 * The て is not written here, by the reader's settled decision that
 * 連用中止法 is a bare 連用形 — see `converbSuffix`'s closing note. The received
 * 時に感じ**ては** carries both a て and a は; `renyouTe.ts` writes the first when
 * the reader asks for it, and the second is emphasis no relation states. */
function isPreposedAdverbialClause(token: Token, sentence: Sentence): boolean {
  if (token.dep !== "mod") return false;
  if (token.pos !== "VERB") return false;
  if (!isVerbalXpos(token)) return false;
  if (refusedAsAdverbialDescriptive(token)) return false;
  const governor = sentence.tokens.find((t) => t.id === token.head && t.id !== token.id);
  if (!governor) return false;
  if (token.id >= governor.id) return false;
  if (!isContentPredicatePos(governor.pos) && governor.pos !== "AUX") return false;
  return readsLastInItsSubtree(token, sentence, (child) => isNegationUse(child));
}

/** Verbs of *asking* — the narrow class inside `isCommunicationVerb`'s 伝達
 * whose complement is a question rather than a statement, so that the quotation
 * closes 〜やと rather than a bare 〜と. 問：「需何藥？」 is
 * 「なにの藥を需ふや」と問ふ.
 *
 * **A lemma list, because the treebank does not draw this class**, and that is
 * measured rather than assumed — the same finding, reached the same way, that
 * `INTENTION_VERB_LEMMAS` records for verbs of thought. Over
 * `lzh-{train,dev,test}.sud.conllu` (1,066,724 tokens, 137,786 sentences) the
 * verbal side of 伝達 is **one flat bucket**: `v,動詞,行為,伝達`, 29,266 tokens
 * across 45 distinct lemmas, holding 曰 (13,750), 言 (1,450), 謂 (1,338), 聞
 * (894), 吿 (774), 問 (729), 命 (608), 云 (500) and the rest side by side. The
 * only neighbouring class the field offers is `n,名詞,可搬,伝達` (5,760), which
 * is the *noun* — a message, not an asking. There is no sub-tag to key on.
 *
 * **Nor does the distribution separate it**, which was the next thing tried and
 * is the reason this is not a corpus-derived class after all. If asking verbs
 * were tellable by what they govern, a complement carrying an interrogative
 * would be their signature. Measured on the complement head's *own* clause
 * (itself, its direct children, and those children's det/clf/mod) against a
 * 3.58% base rate of sentences containing an interrogative at all:
 *
 *     云 18.81% (404 complements)   問  8.48% (519)   曰  6.34% (11,100)
 *     白  2.94% (68)                謂  2.36% (1,566) 言  1.78% (900)
 *     聞  0.25% (786)               命  0.00% (456)   答  0.00% (38)
 *
 * 問 is well above the base rate, and **云 is more than twice as far above it**
 * — because of the fixed idiom 云何 ("how is it that"), which is not an asking
 * verb governing a question but a set phrase. A threshold that admitted 問
 * would admit 云 first. So the signal is real and is not the class, and a list
 * is what is left.
 *
 * The lemmas below are the asking verbs the 伝達 class actually contains, each
 * with its count in that class: 問/问 729 each, 詰/诘 10, 詢/询 2, 訊/讯 1.
 * Simplified variants are listed beside their traditional forms the way
 * `AUXILIARY_LEMMAS` lists 応 beside 應 — the corpus carries both spellings on
 * separate lines and the parser can return either.
 *
 * 咨/諮 are deliberately absent: both mean "to consult" but neither is tagged
 * 伝達 in this corpus at all (咨 is overwhelmingly the interjection
 * `p,感嘆詞,*,*`), so admitting them would be a claim the evidence does not
 * carry. The xpos gate below means a lemma outside the class never fires
 * anyway; the list is bounded on both sides. */
const INTERROGATIVE_SPEECH_LEMMAS: ReadonlySet<string> = new Set([
  "問", "问", "詰", "诘", "詢", "询", "訊", "讯",
]);

/** True for a verb of asking — one of `INTERROGATIVE_SPEECH_LEMMAS` that this
 * parse also tags as a verb of communication. Both halves, for the reason
 * `isCommunicationVerb` gives for applying its own two: the lemma is what names
 * the class, and the xpos is what confirms the character is being used as that
 * verb rather than as the noun or name it can also be (問 comes back
 * `n,名詞,可搬,伝達` 5 times and `n,名詞,可搬,成果物` once in the same corpus). */
function isInterrogativeSpeechVerb(token: Token): boolean {
  return INTERROGATIVE_SPEECH_LEMMAS.has(token.lemma) && isCommunicationVerb(token);
}

/** **豈 — the 反語 adverb**, and the one thing in a sentence that overrules
 * `SENTENCE_FINAL_PARTICLES`' default reading of 乎.
 *
 * 乎 is や by default because kanbun's 乎 usually is the rhetorical particle and
 * nothing in the character itself says which it is; か is the documented
 * alternative, and the table has said so since it was written. 豈 is the
 * evidence that settles it. It is not an ordinary adverb that happens to
 * co-occur — this treebank's tag for it is `v,副詞,疑問,反語`, which names the
 * rhetorical-question class outright — and the 豈…乎 frame is a single
 * construction with a mark at each end: 豈飲啄固有數乎？ is
 * あに飲啄もとより數有らんか.
 *
 * The lemma, and the ADV tag beside it, on the same discipline
 * `RESULTATIVE_CONNECTIVE_LEMMAS` applies to its own characters: 豈 is also a
 * rare surname and a variant of 愷, and the tag is what says the adverb is what
 * is being used. */
const RHETORICAL_QUESTION_ADVERB_LEMMAS: ReadonlySet<string> = new Set(["豈"]);

/** Whether a 豈 stands inside the clause this particle closes — the two ends of
 * the 豈…乎 frame meeting.
 *
 * **The clause, not the one governor**, and the reader's own two trees are why.
 * 豈飲啄固有數乎？ has 乎 on 有 in both of them, and the 豈 moved: the later tree
 * hangs it on 有 as well, the earlier one on 飲, which is 有's own `subj`. The
 * frame is the same sentence either way and the reading is the same か, so a
 * test that answered differently for the two would be reporting where an adverb
 * was attached rather than what the sentence says.
 *
 * Bounded to that clause all the same, by walking *up* from the 豈 rather than
 * scanning the sentence: 反語 scopes over the predicate it marks, and a 乎
 * closing some outer predicate is closing a different clause. So the 豈's own
 * governor must be the predicate the 乎 hangs off, or something below it. */
function closesRhetoricalQuestion(particle: Token, sentence: Sentence): boolean {
  const inClause = (token: Token): boolean => {
    const seen = new Set<number>([token.id]);
    for (let current = token; ; ) {
      if (current.id === particle.head) return true;
      const governor = sentence.tokens.find((t) => t.id === current.head && t.id !== current.id);
      if (!governor || seen.has(governor.id)) return false;
      seen.add(governor.id);
      current = governor;
    }
  };
  return sentence.tokens.some(
    (t) => t.id !== particle.id && t.pos === "ADV" && RHETORICAL_QUESTION_ADVERB_LEMMAS.has(t.lemma) && inClause(t),
  );
}

/** **`dislocated` — the relation that says the thing this particle stands on
 * was said *after* the predicate that speaks about it.**
 *
 * 賢哉回也 puts 回 at the end and 賢 at the front: the sentence exclaims first
 * and names its subject afterwards, and SUD marks exactly that with
 * `dislocated`. The 也 is `discourse@sp` on the dislocated word, which makes the
 * head's relation and not the particle's the thing to read — see
 * `POSTPOSED_TOPIC_PARTICLES`, which is where the reading and the evidence for
 * the key both live.
 *
 * Written as its own predicate rather than inline in the one caller, on the
 * shape `closesRhetoricalQuestion` beside it already takes: what licenses a
 * second reading of a character is a fact about the sentence, and it is stated
 * where it can be read on its own. */
function standsOnPostposedTopic(particle: Token, sentence: Sentence): boolean {
  const head = sentence.tokens.find((t) => t.id === particle.head && t.id !== particle.id);
  return head !== undefined && head.dep === "dislocated";
}

/** The XPOS the treebank writes on a **presentative** 也 — the one that marks a
 * topic — as against `p,助詞,句末,*` on the 也 that closes a predicate. */
const PRESENTATIVE_PARTICLE_XPOS = "p,助詞,提示,*";

/** 者, the nominalizer this frame is built on. */
const NOMINALIZER_LEMMA = "者";

/** **なる** — the copula's 連体形, which is what the 也 of `AB也者` is. */
const PRESENTATIVE_COPULA_READING = "なる";

/** **AB也者, the topic-presenting frame** — "as for A B" — where 也 is not a
 * particle at all but the **copula standing attributively in front of 者**, and
 * so reads **なる**: 孝弟也者 is 孝弟**なる**者は, 達也者 達なる者は, 禮也者
 * 禮なる者は. It is a fixed classical shape (孝弟也者, 仁也者, 忠恕也者), and the
 * received text reads it that way wherever it prints it — kanbun.info has
 * 孝弟なる者は, 夫れ達なる者は and 夫れ聞なる者は.
 *
 * **The gold treebank's own tagging is what tells this 也 from the other one,
 * and the two keys agree exactly.** Over
 * `lzh_kyoto-sud-{train,dev,test}.relabeled_ext.udep_ruled.punct.rulemerged.adjfix.conllu`
 * 也 carries `p,助詞,句末,*` **7,197** times and `p,助詞,提示,*` **564**; of the
 * 564 presentative ones **80** are immediately followed by 者, and **all 80** of
 * the 也 that stand before a 者 are presentative — not one 句末 也 anywhere in
 * the gold is followed by 者. So (XPOS, next token) settles it on its own and no
 * question has to be put to the tree, which matters because the tree does *not*
 * settle it: the 80 wear four different relations (`discourse@sp` 65, `mod` 8,
 * `comp:obj` 4, one each of `conj:coord`/`comp:pred`/`comp:aux`), and 66 of them
 * are `discourse@sp` — the very relation that everywhere else means the
 * assertive なり. Keyed on both halves rather than on the following 者 alone,
 * which is the measured statement: it is *the presentative 也 before 者*, and a
 * parse that tagged one 句末 would be saying something this rule has no evidence
 * for.
 *
 * **Why it needs a rule of its own rather than either existing branch.** Both
 * were wrong, and differently, which is why the frame came out two ways
 * depending on the relation the parse happened to give the particle:
 *
 *  - The 65 `discourse@sp` ones took the sentence-final branch and read
 *    **なり**, closing a predicate in the middle of a subject — 禮**をなり**者,
 *    中**をなり**者.
 *  - The other 14 missed that branch and fell to `overrides.json`'s 提示 entry,
 *    which reads **や** on every relation that is not `discourse` — 孝弟す**や**
 *    者は, 夫れ達す**や**者は. That entry is right about 由也好勇 and 今也則亡,
 *    where the topic stands *bare*; it is the 者 that makes this frame different,
 *    because a nominalizer needs an attributive in front of it and や is not one.
 *
 * The three things this fact is spent on are all consequences of the same
 * reading, and each is stated where that kind of thing is decided: the word
 * (`sentenceFinalParticleFor`), the clause the 者 heads (`hasSentenceFinalParticle`,
 * which must stop reporting the frame as an asserted clause or the 者 loses its
 * は), and the particle on the topic (`caseParticleFor` — a copula's predicand
 * is not an object, however the parse relates it). */
export function isPresentativeCopula(token: Token, sentence: Sentence): boolean {
  if (token.lemma !== "也" || token.xpos !== PRESENTATIVE_PARTICLE_XPOS) return false;
  const next = sentence.tokens.find((t) => t.id === token.id + 1);
  return next !== undefined && next.lemma === NOMINALIZER_LEMMA;
}

/** Whether `token` is the **nominal the presentative copula predicates of** —
 * the A of `AB也者`, which is to say the token standing immediately in front of
 * a 也 this frame claims.
 *
 * Asked by `compoundSuruOkurigana` in `readingResolver.ts`, where it withholds
 * the サ変 す from an on'yomi span standing there: 孝弟 in 孝弟也者 is the
 * **nominal** かうてい and not the verb 孝弟す, because なる is already the
 * predication and a copula attaches to a 体言. Adjacency is the key here for the
 * same reason it is in `isPresentativeCopula` — the relation the parse writes
 * between the two is not stable (the gold hangs 也 off 者 and leaves the topic
 * on the predicate; the shipped parser hangs the topic off 也 as `comp:obj`),
 * and the frame is a fixed sequence of characters. */
export function isPresentativeCopulaTopic(token: Token, sentence: Sentence): boolean {
  const next = sentence.tokens.find((t) => t.id === token.id + 1);
  return next !== undefined && isPresentativeCopula(next, sentence);
}

/** What a sentence-final particle is read as *here* — the table's default,
 * unless the sentence settles a register the character alone leaves open.
 *
 * **Two entries do.** 乎 reads か rather than や inside a 豈…乎 frame — see
 * `GENUINE_QUESTION_PARTICLES` for the pair and
 * `RHETORICAL_QUESTION_ADVERB_LEMMAS` for what licenses the switch. And 也 reads
 * **や** rather than なり where it stands on a **postposed topic**: 賢哉回也 is
 * 賢なるかな回**や**, the received 論語 reading, where the character's default なり
 * gave 回なり. See `POSTPOSED_TOPIC_PARTICLES` for the word and the 〜哉…也 frame
 * it belongs to, and `standsOnPostposedTopic` just above for the key — the
 * `dislocated` relation on the particle's own head, which over the whole gold
 * picks out 8 tokens and nothing else.
 *
 * The two switches are asked in that order and cannot collide: no lemma is in
 * both tables (`GENUINE_QUESTION_PARTICLES` holds 乎/與/与, this one holds 也),
 * and each is bounded by a frame the other has no test for.
 *
 * **What the 也 switch carries with it is the *form* of the predicate in front
 * of it**, and that follows without a second rule, which is the point of keying
 * every particle rule in this file on what the particle is *read as*: a 也 that
 * reads や is a 終助詞 や, so `closingParticleReading` hands it to
 * `TERMINAL_PARTICLE_READINGS` and the predicate takes a 終止形 — 善哉問也 is
 * 善きかな問ふ**や** — where `isAssertiveParticleAhead` would have asked for the
 * 連体形 the copula なり needs. One decision, read off one table.
 *
 * **Both panels must call this and not `sentenceFinalParticle`**, which is the
 * whole reason it exists as one exported function rather than as a test inside
 * either of them: a 乎 printing か in the prose and ヤ in the 訓読文 is exactly
 * the divergence `quoteClosing`, `negationEnding` and `pickedEnding` are each
 * shaped to make impossible. `sentenceFinalParticle` stays exported for the
 * callers that ask a *lemma* question and have no token — `negationForm`'s なり
 * and のみ tests, `isLimitingParticleAhead`, `repeatsPredicateCopula` — none of
 * which 乎 is an answer to, and none of which the postposed 也 reaches either:
 * its head is a dislocated topic and not a ナリ活用 predicate, so the copula
 * these ask about is not in play. */
export function sentenceFinalParticleFor(token: Token, sentence: Sentence): string {
  const base = sentenceFinalParticle(token.lemma);
  if (!base) return base;
  // …and a third entry does, ahead of both: the 也 of the `AB也者` frame, which
  // is neither of this character's two particles but the **copula in its
  // 連体形**, なる. See `isPresentativeCopula` for the frame and for the count
  // that separates it — 80 gold tokens, every one of them presentative.
  if (isPresentativeCopula(token, sentence)) return PRESENTATIVE_COPULA_READING;
  // …and a particle closing a 豈敢 clause is its や, whatever it reads
  // elsewhere: 豈に敢へて之を愛せんや, not 愛せんか or 愛せんかな. See
  // `rhetoricalGanOf`.
  if (RHETORICAL_GAN_PARTICLE_LEMMAS.has(token.lemma) && token.dep === "discourse@sp") {
    const head = sentence.tokens.find((t) => t.id === token.head && t.id !== token.id);
    const closing = head && (ganReadsAsAdverb(head, sentence) ? (ganClauseComplement(head, sentence) ?? head) : head);
    if (closing && rhetoricalGanOf(closing, sentence)) return INTERROGATIVE_PARTICLE;
  }
  const topic = postposedTopicParticle(token.lemma);
  if (topic !== undefined && standsOnPostposedTopic(token, sentence)) return topic;
  const genuine = genuineQuestionParticle(token.lemma);
  return genuine !== undefined && closesRhetoricalQuestion(token, sentence) ? genuine : base;
}

/** や — the 係助詞 that marks a quoted clause as the question it is. */
const INTERROGATIVE_PARTICLE = "や";

/** と — the quotative particle that closes a reported clause. Written here
 * once, where `quoteClosing` composes it with the や above, rather than as a
 * bare literal at each of the two panels that used to append it. */
const QUOTATIVE_PARTICLE = "と";

/** Everything written at the close of a quoted complement: the や a question
 * ends on, then the quotative と.
 *
 * **Order, and why it is this way round.** と is the quotative particle: it
 * marks the whole quotation as reported, so it stands outside everything the
 * quotation itself says. や is inside — it is part of the sentence being
 * quoted, the mark that makes it a question. 「需何藥や」と問ふ, never 〜とや.
 * `reorderEngine.ts` picks the token the と lands on (`ReadingPlan.quoteEndIds`
 * — the last non-punctuation token of the complement's own reading order) and
 * that position is already right for both; only the string written there
 * changes, so nothing about the reading order or the kunten moves.
 *
 * **Both panels call this**, in place of each appending a bare と of its own —
 * `generator.ts`'s `markQuoteEnd` and `KundokuView.ts`'s `withQuoteEnd`. The
 * two panels quietly disagreeing about one character is a failure mode this
 * project has had, and a quotation closing 〜やと in the prose and 〜ト in the
 * 訓読文 would be one.
 *
 * **The asking verb is found by walking up**, because the caller has only the
 * id of the token the と lands on, and that token is the last word *inside* the
 * quotation — several edges below the verb that asked. The walk stops at the
 * first ancestor that is a quoted complement of an asking verb, which is the
 * quotation this と is closing; an outer speech frame further up is closing a
 * different one and is not consulted.
 *
 * **Withheld where the quotation already ends in や.** 乎/歟/邪/耶 read や
 * (`sentenceFinalParticle`), and a source that wrote one has already asked the
 * question — 問：「…乎？」 would otherwise close 〜ややと. Asked of the closing
 * token's own lemma through the one table that decides the reading, the same
 * discipline `negationForm` follows for the なり and のみ it keys on. */
export function quoteClosing(tokenId: number, plan: ReadingPlan): string {
  if (!plan.quoteEndIds.has(tokenId)) return "";
  const sentence = plan.sentence;
  const closing = sentence.tokens.find((t) => t.id === tokenId);
  // Asked through `sentenceFinalParticleFor`, and against both readings 乎 has:
  // a quotation closing 〜か has asked its question exactly as one closing 〜や
  // has, and 問：「豈…乎？」 would otherwise come out 〜かやと.
  if (
    closing &&
    (sentenceFinalParticleFor(closing, sentence) === INTERROGATIVE_PARTICLE ||
      genuineQuestionParticle(closing.lemma) === sentenceFinalParticleFor(closing, sentence))
  ) {
    return QUOTATIVE_PARTICLE;
  }
  const seen = new Set<number>();
  let token = closing;
  while (token && !seen.has(token.id)) {
    seen.add(token.id);
    const governor: Token | undefined = sentence.tokens.find((t) => t.id === token!.head && t.id !== token!.id);
    if (!governor) break;
    if (isInterrogativeSpeechVerb(governor) && isSpeechQuoteComplement(token, governor, sentence)) {
      return INTERROGATIVE_PARTICLE + QUOTATIVE_PARTICLE;
    }
    token = governor;
  }
  return QUOTATIVE_PARTICLE;
}

/** Everything a negation piece writes: the ず/ざる/ざれ itself, and then the case
 * particle owed by the clause it closes.
 *
 * **Why the particle is the negation's to write.** `caseParticleFor` writes
 * onto the token it is asked about, and a negation is postposed past its
 * predicate — so on a negated clause the predicate's own piece is no longer the
 * end of that clause, and a particle written there comes out *inside* the
 * negation: 苦不得飲 would read 得にず. The thing standing at the end is the ず,
 * so the ず is what carries the に, and the form it takes is the 連体形 ざる that
 * a following particle needs. 飲むを得ざるに苦しむ.
 *
 * ざる and not ぬ: the ざり paradigm is the one rebuilt to carry something
 * further, which is what a case particle is. Same answer as the なり and のみ
 * arms in `negationForm`, for the same reason — and the answer that function
 * now gives every attributive negation, a noun-modifying one included.
 *
 * **Both panels call this, and only this, for a negation piece**, so the ず
 * one prints and the ず the other prints cannot come apart — the discipline
 * `pickedEnding` and `syntheticLexiconEntry` already follow. It also folds in
 * `rereadGovernedForm`, which `generator.ts` was passing and `KundokuView.ts`
 * was not; that divergence is closed by there being one function rather than
 * two call sites each assembling the arguments.
 *
 * **The three pieces are available separately** — see `negationEndingParts`,
 * which this is the concatenation of. A caller that needs to know *which* kana
 * the 連用形の「て」 switch contributed should ask that instead of re-deriving
 * it; nothing else about this function has changed. */
export function negationEnding(token: Token, plan: ReadingPlan, resolveReading?: ReadingResolver): string {
  const { form, particle, connective } = negationEndingParts(token, plan, resolveReading);
  return form + particle + connective;
}

/** The three things a negation piece is made of, kept apart.
 *
 * `negationEnding` above joins them and is what both panels call to *write* a
 * negation. This exists because one caller needs to know not what was written
 * but **where it came from**: the prose panel inks in the connective the
 * 連用形の「て」 switch adds, and to do that it has to be able to point at the
 * characters that switch contributed.
 *
 * Every other connective in the app arrives from one of `renyouTe.ts`'s suffix
 * functions and is already a value in the caller's hand. A negation's cannot
 * be: neither panel assembles the negation piece — that is the whole point of
 * `negationEnding` being the one function both of them call — so the ずして is
 * decided here and nowhere else (see `NEGATION_CONVERB`). `generator.ts`
 * therefore recovered it by asking `negationEnding` a second time with the
 * switch momentarily off and diffing the two answers, guarded by a prefix
 * check. That reconstruction is sound and it is a reconstruction of something
 * this function already knows, so this reports it instead.
 *
 * The split is the one the fields name and not a new decision: `form` is the
 * negation's own inflected shape (ず/ざる/ざれ/ざら — `negationForm`), `particle`
 * is what the *construction* owes it (the oblique's に, an object slot's を, a
 * protasis's ば, and nothing at all for a 係り結び's 結び, whose や is a token of
 * its own), and
 * `connective` is the して the switch writes when the negation stands in a
 * 連用形 and the reader has asked for the joins to be spelled out. The first
 * two are mutually exclusive with the third by construction — a 連体形 or a
 * 已然形 is not a 連用形 — which is why one string could carry all three before.
 *
 * **The same debt is still owed by two other functions in this file**, and is
 * named here rather than quietly left: `pickedEnding` and
 * `compoundSuruOkurigana` likewise return only a finished string, so
 * `renyouTe.ts`'s `recoveredRenyouTe` re-derives the form and the class they
 * conjugated with and then checks its work against the string. Paying those
 * two means adding fields to their return shapes and having `renyouTe.ts` read
 * them, which is a change in a file this task did not own; the seam is open
 * here whenever that is wanted. */
/** The 豈敢 clause a negation closes, as the predicate it closes and the 敢 —
 * where the negation hangs on 敢 and is the last thing read in the clause.
 * See `negationEndingParts`. */
function rhetoricalGanNegation(
  token: Token,
  nextInClause: Token | undefined,
  sentence: Sentence,
): { closing: Token; frame: { gan: Token; ya: boolean } } | undefined {
  if (nextInClause && !isSentenceFinalParticleUse(nextInClause, sentence)) return undefined;
  const head = sentence.tokens.find((t) => t.id === token.head && t.id !== token.id);
  if (!head) return undefined;
  // On 敢 (不敢不… aside, which `deniedByNegation` has taken) or on the
  // complement itself (敢不受天之詔命乎 hangs its 不 on 受).
  const closing = ganReadsAsAdverb(head, sentence) ? (ganClauseComplement(head, sentence) ?? head) : head;
  const frame = rhetoricalGanOf(closing, sentence);
  return frame ? { closing, frame } : undefined;
}

/** 得 — the auxiliary a negated clause stands as the object of in 不得不V. See
 * `negationEndingParts`. */
const OBTAIN_LEMMA = "得";

/** んばあら — what stands between a denied ず and the negation denying it:
 * the nasalised は of the conditional ずは, and the 未然形 of あり the outer ず
 * is suffixed to. See `negationEndingParts`' double-negation arm. */
const DENIED_NEGATION_LINK = "んばあら";

/** Whether the negation `token` is itself denied by a second verbal negation —
 * a 不 or 弗 read straight after it, or a negating 再読文字 (未) whose second
 * reading closes on it. See `negationEndingParts`, which writes ずんばあら for
 * it.
 *
 * **Both negations on one head**, which is the shape the parse gives the
 * construction every time (不敢不告 and 莫敢不敬 on 敢, 未嘗不得見 on 得), and
 * what keeps a pair that is merely adjacent out of it. 不善不能改 hangs its
 * first 不 on 善, an adverb of 能, and walking that adverb chain reads it after
 * 能 beside the second: two ず side by side, and not one denying the other. */
function deniedByNegation(token: Token, nextInClause: Token | undefined, plan: ReadingPlan): boolean {
  if (
    nextInClause &&
    nextInClause.head === token.head &&
    isNegationUse(nextInClause) &&
    !isRereadUse(nextInClause, plan.sentence)
  ) {
    return true;
  }
  const closing = plan.rereadCloseIds.get(token.id) ?? [];
  return closing.some((id) => {
    const reread = plan.sentence.tokens.find((t) => t.id === id);
    return !!reread && reread.head === token.head && rereadNegates(reread.text);
  });
}

export interface NegationEndingParts {
  /** The negation's own form — ず, ざる, ざれ, ざら. */
  form: string;
  /** The case particle or conjunction the construction owes, or "". */
  particle: string;
  /** The して the 連用形の「て」 switch wrote, or "". */
  connective: string;
}

export function negationEndingParts(
  token: Token,
  plan: ReadingPlan,
  /** How the caller reads a token — consulted only for the ぞ inside an
   * interrogative word, which is a *reading* and not a relation. See
   * `boundByBindingParticle`. Both panels pass theirs; a caller without one
   * loses the 何ぞ〜ざる half of 係り結び and nothing else. */
  resolveReading?: ReadingResolver,
): NegationEndingParts {
  // The predicate this negation closes, which is its head except where the
  // parse has hung it on an auxiliary it stands after: the inner 不 of 不可不察
  // closes 察, and every slot rule below asks about the clause of 察, not of 可. See
  // `auxiliaryComplementNegated`, which `reorderEngine.ts` reads the same way.
  const governor =
    auxiliaryComplementNegated(token, plan.sentence) ??
    plan.sentence.tokens.find((t) => t.id === token.head && t.id !== token.id);
  // Asked of the clause and not of the raw reading order, for `negationForm`'s
  // own reason: nothing across a full stop or a 、 is modified by this
  // negation, and a particle across one is not this clause's to answer to.
  // Shared by the double-negation arm just below and the `chaining` guard
  // further down, so the two cannot disagree about which token is "next".
  const nextInClause = nextMeaningfulTokenInClause(plan, token.id);
  // **A double negation — 無不V, 莫不V — ends on the predicate negation, and
  // the ず in front of it is attributive.** Both negations hang off the one
  // verb, `scopeRank` in reorderEngine.ts reads the 無 last, and what the 無
  // predicates of is the negated clause before it: 莫不知 is 知らざる莫し, "there
  // is none who does not know". That clause stands in the subject slot of the
  // adjective 無し, which is the argument `hasPostposedPredicateNegationChild`
  // makes for the 連体形 an *un*negated predicate takes there (友とする無し),
  // met here from the negation's side: what stands in front of the 無 is the
  // ず, so the ず is what goes attributive, and a negation's attributive is ざる.
  //
  // **Counted in the received reading**: kanbun.info reads 20 of its 24 無不
  // passages and all 18 of its 莫不 passages as 〜ざる無し / 〜ざる莫し. Before
  // this arm the 不 saw a 無 that is neither a noun nor a particle and wrote the
  // 終止形: 有らず莫, 克たず無し.
  //
  // **Ahead of every other arm, and writing nothing after the ざる.** Whatever
  // slot the negated clause stands in — object, oblique, protasis, a link in a
  // chain — the 無 is now what closes that clause and owes the slot its
  // particle, not this ず; and the ず is attributive to the 無 whatever the
  // clause is. Read off reading-order adjacency rather than off the two sharing
  // a governor, since adjacency is what the form lands against.
  if (nextInClause && isPostposedPredicateNegation(nextInClause, plan.sentence)) {
    return { form: negationForm(nextInClause, "rentai"), particle: "", connective: "" };
  }
  // **A negation another ず denies reads ずんばあらず**: 不敢不告 is 敢へて告げ
  // ずんばあらず, 未嘗不V 未だ嘗てVずんばあらず — "not (not V)". The inner ず is
  // what the outer one is suffixed to, and a negation cannot take one straight
  // on (告げずず, which is what this wrote); the language puts あり between them,
  // and before it the conditional ずは of the 未然形 slot in `ZU`, nasalised to ずんば.
  // So this ず writes ずんばあら and the negation after it writes its own ず or
  // ざる unchanged: 敢へて告げずんばあら・ざるなり.
  //
  // **The あら is kana, written on this negation, and not a reading of either
  // character.** The source has two 不 and the reading two ず, one each; the
  // あり between them is supplied, as the 訓読文 writes 不ンバアラ on the inner
  // character. It goes in `particle` rather than `form` because it is owed by
  // the construction, as the に a 非 is owed, and `form` stays the one cell of
  // the paradigm the ず is.
  //
  // **Counted in the received reading**: kanbun.info writes ずんばあら **6** times
  // and ずず or ずざる never. Four are written by this arm (敢えて勉めずんばあらず, 敢えて
  // 告げずんばあらざる twice, 未だ嘗て見ゆることを得ずんばあらざる); the other
  // two are 未嘗非 (未だ嘗て多力の国士に非ずんばあらず), where the inner negation
  // is 非 and its ず is the okurigana of 非, which this function does not write.
  //
  // **Two ways the outer negation stands after this one.** A 不 or 弗 read
  // straight after it (不敢不告: the 敢 fold reads the inner one first), or a
  // negating 再読文字 closing on it (未嘗不V, where the ず of 未 is the second reading
  // written on this very token — `rereadNegates`). 非 and 無/莫 over a 不 are
  // not this construction: those read ざるに非ず and ざる無し (the `denied` arm
  // below and the arm just above).
  if (deniedByNegation(token, nextInClause, plan)) {
    return { form: ZU.mizen!, particle: DENIED_NEGATION_LINK, connective: "" };
  }
  // **豈敢不V closes on ざらんや**, the negation standing where the predicate
  // stands in 豈敢V (`rhetoricalGanOf`): the ん wants a 未然形, and a negation
  // with something attached takes ざら, from the ざり paradigm. The 不 hangs on 敢
  // and the fold in `reorderEngine.ts` reads it after the complement, so the
  // clause is asked of the complement, or of 敢 where there is none (豈敢不,
  // 豈に敢へてせざらんや).
  const ganClose = rhetoricalGanNegation(token, nextInClause, plan.sentence);
  if (ganClose) {
    return {
      form: NEGATION.mizenZari!,
      particle: rhetoricalGanEnding(ganClose.closing, ganClose.frame, plan.sentence),
      connective: "",
    };
  }
  // **A negation read straight before a べし is ざる**: 不可不察 is 察せざる可からず.
  // べし is the 終止形接続 auxiliary (`SHUUSHI_CONNECTIVE_AUXILIARY`), and ず
  // having no ラ変 終止形 it takes the 連体形 of the ざり paradigm, which is the rule
  // `shuushiConnectiveForm` states for every ラ変型 word. kanbun.info writes
  // ざる可から **24** times and never the ず of a negation before 可から (its two
  // ず可から are the verbs 疏んず and 応ず). Reached by the inner 不 of 不可不V,
  // which `auxiliaryComplementNegated` reads with 察 and before 可.
  if (nextInClause && isShuushiAuxiliaryAhead(token, nextInClause, plan.sentence)) {
    return { form: NEGATION.rentaiZari!, particle: "", connective: "" };
  }
  // **And before a 得 it closes the object of, ざる + を**: 不得不戰 is 戰はざるを
  // 得ず, the negated clause nominalized as what 得 gets. kanbun.info writes
  // ざるを得 on all **3** of its occurrences (死せざるを得たり, 戦わざるを得ざる,
  // 戒めざるを得んや) and ず得 never. Only where the parse hangs the negation on
  // that 得 and it stands between 得 and its complement
  // (`auxiliaryComplementNegated`); a 不 the parse already hangs on the verb
  // keeps the slot rules below.
  if (
    nextInClause &&
    nextInClause.lemma === OBTAIN_LEMMA &&
    token.head === nextInClause.id &&
    auxiliaryComplementNegated(token, plan.sentence) !== undefined
  ) {
    return { form: NEGATION.rentaiZari!, particle: "を", connective: "" };
  }
  // **The one that binds tightest of the seven, and so the one that wins.**
  // Where the predicate this negation closes is itself what a 使役 or a 受身
  // governs, the auxiliary stands immediately after the ず in reading order —
  // 使民不飢 reads 民をして飢ゑ・ず・しむ — so the ず is what owes it a 未然形,
  // and a negation's 未然形 is the ざり paradigm's ざら. 民をして飢ゑ**ざら**しむ.
  //
  // Not ず, which is what this function printed before (飢ゑ**ず**しむ). The ず
  // series' own 未然形 slot is filled — see `ZU` — but it is parenthesised in
  // every grammar and survives only in the fossilised ずは/ずば; anything that
  // *attaches* after a negation takes the ざり series, which is the whole
  // reason the language built ず+あり in the first place. `negationForm`'s own
  // doc draws that line three times over (ざるがごとし, ざるなり, ざれば), and
  // `NEGATION`'s doc says of `mizenZari` that what reaches it is
  // `negationForm`'s to say. This is what reaches it — the third of the five
  // 助動詞 this app writes after a predicate (べし, まほし, しむ, る/らる, the
  // copula), every one of which takes a 未然形.
  //
  // Applied as an override at the foot of this function rather than as a
  // `!caused` on each of the six arms below, because it displaces all of them
  // at once and for one reason: what attaches directly onto the negation binds
  // tighter than the slot the *clause* stands in. The same ordering principle
  // `decideConjForm` states for its own negation branch.
  const caused = !!governor && isCausedOrPassivePredicate(governor, plan.sentence);
  // **And the same tightness one construction over: a quoted volition.** Where
  // the predicate this negation closes is what a verb of intention has in view,
  // the んと stands immediately after the ず in reading order — 渾欲不勝簪 reads
  // 簪に勝へ・ず・欲す — so the ず is what owes the 未然形 the む attaches to, and
  // a negation's 未然形 is again the ざり paradigm's ざら: 簪に勝へ**ざらん**と
  // 欲す. `caseParticleFor` withholds the んと from the predicate itself whenever
  // this writes it, which is the pairing the object, subject and purposive arms
  // are already in. Beside `caused` and below it, since a caused predicate owes
  // its auxiliary the slot first and the two never co-occur in any case.
  const volitional = !caused && !!governor && isVolitionalComplement(governor, plan.sentence);
  // **The four argument arms are asked through `closesArgumentChain`**, the same
  // way `caseParticleFor` and `decideConjForm` ask them, and the third side of
  // that pairing is here: this function writes the particle those two withhold
  // from a clause a postposed negation closes, so it has to agree with them
  // about *which* clause that is. Where the negated predicate is a non-final
  // conjunct the slot's particle now belongs to a later member, and this falls
  // through to the `chaining` arm below — 連用形 ず, the 連用中止法 of a negated
  // conjunct — instead of writing a ざる + を in the middle of the chain.
  const oblique =
    !!governor && closesArgumentChain(governor, plan.sentence, isNominalizedObliquePredicate);
  // The same arrangement one construction over: where the predicate this
  // negation closes is a conditional protasis, the negation is what stands at
  // the end of the clause, so it takes the 已然形 ざれ and carries the ば.
  // 學而不思則罔 -> 學びて思はざれば則ち罔し. `caseParticleFor` withholds the ば
  // from the predicate itself whenever this is going to write it, exactly as
  // it withholds the oblique に. See `isConditionalTemporalClause`.
  const conditional = !oblique && !!governor && isConditionalTemporalClause(governor, plan.sentence);
  // And the same arrangement a third time, on the plain `mod` adverbial clause
  // that neither of the two above claims. A negated predicate modifying another
  // predicate reads 連体形 ざる + に — 不飲一斗 is 一斗を飲まざるに — so the 不
  // reads ザルニ, exactly as it does in the oblique case. **Last of the three**,
  // because a clause that is also an oblique argument or a conditional protasis
  // is those first: 學而不思則罔 keeps its ざれば, and 苦不得飲 its ざるに by the
  // route it already took. See `isNegatedAdverbialPredicate`.
  const adverbial =
    !oblique && !conditional && !!governor && isNegatedAdverbialPredicate(governor, plan.sentence);
  // And a fourth time, for a predicate a 非 also denies. 非不說子之道 is
  // 子の道を說ばざるにあらず: this ず closes the clause the 非's に lands after,
  // so the ず takes the 連体形 ざる and carries that に itself, exactly as it
  // does in the oblique case. `caseParticleFor` withholds the に from the
  // predicate whenever this writes it. See `negatedPredicate`.
  const denied = !!governor && negatedPredicate(governor, plan.sentence);
  // And a fifth, which takes the 連体形 and writes **no particle of its own**:
  // 係り結び. A 係助詞 of the や/か class binds its predicate to the 連体形, and
  // on a negated clause the thing standing in front of that particle is the ず
  // — so it is the ず that has to be attributive. 君飲嘗不醉否 is
  // 君飲みかつて醉は**ざる**や, not 醉はずや. Exactly the arrangement
  // `decideConjForm`'s own 係り結び branch already makes for an *un*negated
  // predicate (豈飲啄固有數乎 -> 數有る**か**), reached from the other side.
  //
  // Held apart from the four above because it is the one of the five that adds
  // nothing after the ざる: the particle is a token of its own and both panels
  // already print it. See `boundByBindingParticle`.
  const bound = !oblique && !adverbial && !denied && boundByBindingParticle(token, plan, resolveReading);
  // And a sixth, which takes the 連体形 like the four above it but writes **を**
  // rather than に: a negated clause standing in an *object* slot. 苦不得飲 is
  // 飲むを得ざるを苦しむ — 得 is 苦's `comp:obj`, so the whole negated clause
  // 飲むを得ざる is what 苦しむ suffers, and the ず that closes it is what carries
  // the object marker.
  //
  // **Why `comp:obj` and not the oblique arm at the top of this list**, which is
  // where this sentence used to be answered. The label was measured over
  // `lzh_kyoto-sud-{train,dev,test}`: a governor tagged `v,動詞,描写,態度` — 苦's
  // own class — takes a VERB/AUX dependent on `comp:obj` **170** times and on
  // `comp:obl` **once** in the whole corpus (吾羞爲之下), and 苦 itself governs a
  // predicate 13 times with **not one** of them oblique. Two of the 170 are this
  // very construction, a negated predicate under 苦: **俗士苦不知變** (知 on
  // `comp:obj`, 不 on 知) and **李斯稅駕苦不早**, with 爾輩苦無恃 and 三徑苦無資
  // beside them on the existential. 苦 is a transitive psych verb and what it
  // suffers is its object. So `comp:obl` — which an earlier round named as the
  // correct annotation for 得 — is overturned, and the reader's own tree already
  // carries `comp:obj`.
  //
  // **What the を is not, and what it costs.** Japanese 苦しむ is intransitive
  // (JMdict, which this app ships and already reads for transitivity, files it
  // `intransitive verb`, against 樂しむ and 悲しむ as `transitive verb`), and the
  // kundoku tradition marks its stimulus に: 百姓苦秦苛法 is 百姓秦の苛法**に**
  // 苦しむ. That is a fact about the *Japanese* verb and not about the tree —
  // the same `comp:obj` under 樂 or 恥 wants を — so no relation can carry it,
  // and this function has no reading resolver in hand to ask JMdict with. The
  // relation's own answer is what is written here; the に is put to the reader.
  //
  // **Last of the six**, for the reason the adverbial arm is third: a clause
  // that is also an oblique argument, a protasis, a plain adverbial, a 非's
  // complement or a 係り結び's 結び is those first, and each of those five wants
  // に, ば or nothing rather than を.
  // And a seventh that has to be asked **before** the object arm, because the
  // relation it stands on is the very one that arm reads: a negated clause
  // standing as the **standard of a positive comparison** 如/若. It takes the
  // 連体形 like the five above it and writes **が**, the 連体格 after an
  // attributive — 如不祭 is 祭ら**ざるが**如し, where this wrote 祭ら**が**ざる
  // **を**如し: the が in front of the ず it belongs after, and the object arm's
  // を on top of it. `caseParticleFor`'s comparison branch withholds the が
  // whenever this writes it, which is the pairing the object, subject and
  // purposive arms are already in.
  //
  // **The standard of a comparison arrives on `comp:obj`** — 2,484 of 如's
  // 7,838 dependents, the largest class by far (see that branch's own count) —
  // so without this arm every negated standard was read as 如's *object*, which
  // is the one thing the reader's rule about 如 says it never is: 之を知る者は
  // 好む者に如かず is the negated **comparison**, and a positive 如's complement
  // takes の or が and never を.
  //
  // The particle is が and not の with no test on the POS, where the branch in
  // `caseParticleFor` divides the two: what this arm writes after is a 連体形
  // ざる, and a negation closing a clause is a predicate by construction.
  const comparison =
    !oblique &&
    !conditional &&
    !adverbial &&
    !denied &&
    !bound &&
    !!governor &&
    // **The plain predicate and not `closesArgumentChain`**, which is what the
    // four arms around this one are asked through — because the branch this
    // pairs with is asked that way too. `caseParticleFor` writes the standard's
    // particle on the standard itself, with no chain test, so a coordination
    // test *here* and not there would leave a negated standard inside a chain
    // with the が withheld by one side and written by neither: 廣德若不足 lost
    // it outright, where it had had it in the wrong place. What the two must
    // agree about is which tokens the slot claims, and this is that agreement
    // written down.
    isComparisonStandard(governor, plan.sentence);
  const object =
    !oblique &&
    !conditional &&
    !adverbial &&
    !denied &&
    !bound &&
    !comparison &&
    !!governor &&
    closesArgumentChain(governor, plan.sentence, isNominalizedObjectPredicate);
  // And a seventh, the last of the argument slots and the one that was missing:
  // a negated clause standing in a **subject** slot. It takes the 連体形 like the
  // five above it and writes **こと**, the nominalizer kundoku supplies to let a
  // clause fill that slot — 不知難 is 知ら**ざること**難し, where this printed
  // 知ら**ず**難し.
  //
  // The reader's ruling: *if a negated verb is used as an argument, the negation
  // should be read as ざる.* The object slot already obeyed it (患不知 ->
  // 知らざるを患ふ) and so did the oblique (苦不得飲 -> 得ざるに苦しむ); the
  // subject slot did not, and the reason was one function call away —
  // `isNominalizedSubjectPredicate` asked `readsLastInItsSubtree` without
  // skipping the postposed negation, so a negated clause never answered yes.
  // Both halves are fixed together, because a form here with no particle after
  // it (or a particle with no form) is exactly what the pairing exists to
  // prevent: `caseParticleFor` withholds the こと whenever this writes it.
  //
  // **113 gold tokens**, against 1,413 in the object slot and 36 in the oblique.
  // 5,376 negations stand on a `root` and 994 on a `conj:coord` — not arguments,
  // and they keep their ず.
  //
  // **Last of the seven**, for the reason the adverbial arm is third: a clause
  // that is also an oblique argument, a protasis, a plain adverbial, a 非's
  // complement, a 係り結び's 結び or an object is those first.
  const subject =
    !oblique &&
    !conditional &&
    !adverbial &&
    !denied &&
    !bound &&
    !comparison &&
    !object &&
    !!governor &&
    closesArgumentChain(governor, plan.sentence, isNominalizedSubjectPredicate);
  // And an eighth: a negated clause standing as what a **prepositional 為** is
  // the 為 *of*. It takes the 連体形 like the five above it and writes **が**, the
  // 連体格 that follows an attributive — 為子之不便也 is 子の便ならざる**が**爲なり,
  // where this printed 便なら**ず**爲. `caseParticleFor` withholds the が whenever
  // this writes it, which is the same pairing the object and subject arms are
  // in; **3** of the 155 complements in the gold are negated (王特為臣之右手不倦
  // 賞臣, 為子之不便也, 為肥甘不足於口與), so this arm is what keeps those three
  // from being the one shape where the form and the particle come apart.
  //
  // **Last of the eight**, for the reason the adverbial arm is third: a clause
  // that is also an oblique argument, a protasis, a plain adverbial, a 非's
  // complement, a 係り結び's 結び, an object or a subject is those first.
  const purposive =
    !oblique &&
    !conditional &&
    !adverbial &&
    !denied &&
    !bound &&
    !comparison &&
    !object &&
    !subject &&
    !!governor &&
    closesArgumentChain(governor, plan.sentence, isPurposiveWeiComplement);
  // And one more that takes the 連体形 and writes **no particle of its own**,
  // like the 係り結び arm: a negated clause that **modifies a noun through a
  // genitive 之**. 不可陷之楯 is 陷す可からざるの楯, "a shield that cannot be
  // pierced" — the clause 陷す可からず stands where a possessor would, the 之
  // reads の, and what stands immediately in front of that の is the ず. So the
  // ず is what goes attributive, exactly as an *un*negated predicate in the
  // same slot does (`modifiesGenitiveZhi`, 大破するの時), and the の is a token
  // of its own that both panels already print.
  //
  // **Counted in the received reading.** Every negation kanbun.info writes in
  // front of a genitive の is attributive: ざるの **8** (教へざるの民,
  // 虞らざるの道, 伐らざるの士 twice, 知らざるの敗, 得ざるの姦, 掲げざるの罪,
  // 獲ざるの姦), 無きの **2** (過ち無きの城, 罪無きの人), against **0** ずの,
  // 0 ぬの and 0 無しの / 莫しの.
  //
  // **Asked of the governor, and of what is read next.** `modifiesGenitiveZhi`
  // says the predicate this negation closes is the complement of a genitive 之
  // (the one test `depClassification.ts` shares, so a PART, SCONJ or PRON 之 on
  // `mod` all count, as they do for the unnegated rule); adjacency to that same
  // 之 in reading order says the の is landing on the ず rather than on
  // something read in between.
  const genitive =
    !!governor && modifiesGenitiveZhi(governor, plan.sentence) && nextInClause?.id === governor.head;
  const rentai =
    genitive || oblique || adverbial || denied || bound || comparison || object || subject || purposive;
  // And a sixth, which is not a 連体形 at all: **連用中止法**. Where the clause
  // this negation closes is a non-final link in a coordination chain, the clause
  // hands on to the next rather than closing, and the thing standing at its end
  // — the ず — is what has to be in 連用形. 不飲不食 is 飲まず食はず.
  //
  // That is the same demotion `decideConjForm` makes for an *un*negated conjunct
  // and `selectForm` for a synthesized ending, asked of the same predicate
  // (`isNonFinalCoordinand`) from the third side. Before this the negation had no
  // notion of a 連用形 at all: it fell through to `primary`, which happens to be
  // the same string ず, so nothing on the page was wrong — but nothing could
  // *depend* on the form either, which is why the 連用形-て switch could not see a
  // negated conjunct. It can now; see `NEGATION_CONVERB`.
  //
  // **Last of the six**, for the reason the adverbial arm is third: a clause that
  // is also an oblique argument, a protasis, a 非's complement or a 係り結び's 結び
  // is those first. A coordinand is what is left.
  //
  // **Except where the clause carries its own 連体形-taking particle**, which is
  // what `attributiveParticleAhead` collects — 者/所, 耳ののみ, ぞ・なむ・かの
  // 係り結び, 哉・夫のかな, 也のなり — asked of the *governor* (the verb this
  // negation closes on) against the token that actually follows the negation's
  // own ending in reading order. Before this guard, a chain member's ず went
  // straight to `primary` (連用形 ず) the moment `isNonFinalCoordinand` held,
  // and the particle checks inside `negationForm` — real and correct on their
  // own — never ran, because `governedForm === "renyou"` returns before ever
  // reaching them: 不知地之厚也 written as one non-final member of a longer
  // 不X，不知Y之Z也 chain came out 知らずなり, a ず with なり glued straight onto
  // it, where 荀子・勸學 closes it 知らざるなり.
  //
  // The 係助詞 か・ぞ・なむ are already inside `bound` above and so already stand
  // above `chaining` without this guard — `attributiveParticleAhead` tests for
  // them again, which is redundant exactly where `bound` already holds and so
  // harmless, and is what lets one shared predicate close the whole class
  // rather than two. のみ, かな and なり have no equivalent among the eight
  // `rentai` arms above, because none of those eight is about a particle
  // attaching onto the predicate — they are about the *clause* being an
  // argument, a protasis, a 非's complement or a 係り結び's 結び. A particle
  // attaching onto a finished predicate is the fourth kind of environment
  // entirely, the same one `decideConjForm` keeps separate from its own
  // nominalization rules for an *un*negated predicate (`isLimitingParticleAhead`,
  // `isBindingParticleAhead`, `isExclamatoryParticleAhead`,
  // `isAssertiveParticleAhead`, all ordered above `isNonFinalCoordinand` there)
  // — this is that same fourth kind, reached from the negation's side of the
  // same construction rather than restated for it.
  //
  // **や asks for nothing here and gets nothing.** や's 終止形 requirement is
  // already met by `primary`, ず's plain form, whether or not the negation is
  // also a chain member — a 連用形 and a 終止形 both spell ず, so whether
  // `chaining` holds changes nothing about what や sees.
  // `attributiveParticleAhead` does not test for や, on its own doc's reasoning,
  // and this guard inherits that omission correctly rather than by accident.
  //
  // **未 never reaches this guard, and does not need it.** A re-read's own ず
  // is not decided here at all: `isNegationUse` never fires for 未 or 盍
  // (`chosenReadingText` aside), whose second reading `rereadSecondReading`
  // writes on a wholly separate path that already asks `attributiveParticleAhead`
  // before choosing between `entry.second` and `negationForm(next, "rentai")`.
  // This guard is what gives an ordinary 不/弗/勿 the same answer that path
  // already gave 未/盍, off the one shared predicate rather than a second copy
  // of it.
  //
  // **Measured** over
  // `lzh_kyoto-sud-{train,dev,test}.relabeled_ext.udep_ruled.punct.rulemerged.adjfix.conllu`:
  // 936 negated predicates (不/未/弗/勿) carry their own written sentence-final
  // particle (なり 764, や 126, かな 22, のみ 16, か 8); of those, 20 are also a
  // non-final coordinand of their governor, and 7 of the 20 are governed by 未
  // and were already correct through `rereadSecondReading`. The remaining
  // **13** — all 不/弗/勿, all carrying なり but for one か (already caught by
  // `bound`) — are this guard's whole class.
  //
  // Asked of `nextInClause` (computed at the top of this function) rather than
  // of the negation's raw `next` below.
  const chaining =
    !rentai &&
    !conditional &&
    !!governor &&
    !attributiveParticleAhead(governor, nextInClause, plan.sentence, resolveReading) &&
    isNonFinalCoordinand(governor, plan.sentence, true);
  const next = nextMeaningfulToken(plan, token.id);
  // A 而 standing after the negation writes the connective itself, and writes
  // this very one: `teOrShite`'s `afterNegation` branch returns して. So the
  // switch stands down in front of one, exactly as `renyouTeSuffix` does for a
  // verb's own 連用形 — 人不知而不慍 is 人知らずして慍みず in both switch states,
  // and gave 人知らずしてして in one of them before this guard.
  const converb = !caused && !volitional && chaining && renyouTeOn() && next?.lemma !== ERU_CONNECTIVE_LEMMA;
  const form = negationForm(
    // Computed once, at the top, as `nextInClause`, and shared with the
    // `chaining` guard just above so the two cannot come to disagree about
    // which token counts as "next" — see the note where it is computed.
    nextInClause,
    rereadGovernedForm(token.id, plan) ??
      (caused || volitional ? "mizen" : rentai ? "rentai" : conditional ? "izen" : chaining ? "renyou" : undefined),
  );
  // The 係り結び arm writes no particle: the や is a token of its own. Every
  // other 連体形 arm here owes the に it took the form for; the 連用形 arm owes
  // the connective only when the reader has asked for connectives.
  //
  // The connective is held in its own field rather than folded in with the に
  // and the ば, though the three are mutually exclusive and one string carried
  // all of them before. They are different kinds of thing — two of them are
  // owed by the construction and are written whatever the reader has switched
  // on, and the third is the display option — and the panel that fades the
  // switch's own kana in has to be able to tell them apart. See
  // `NegationEndingParts`.
  const particle = caused
    ? // The auxiliary owns this negation's clause; nothing stands between the
      // ざら and the しむ. Beside the 係り結び arm, which is the other one of
      // the seven that writes nothing.
      ""
    : volitional
      ? // …and the quoted volition owns it the same way: the ざら is what the
        // む attaches to, so the んと is written straight onto it.
        VOLITIONAL_PARTICLE
      : genitive || bound
        ? ""
        : comparison
          ? PURPOSIVE_GENITIVE
          : object
            ? OBJECT_PARTICLE
            : subject
              ? subjectNominalizerFor(governor!, plan.sentence)
              : purposive
                ? PURPOSIVE_GENITIVE
                : rentai
                  ? OBLIQUE_PARTICLE
                  : conditional
                    ? CONDITIONAL_PARTICLE
                    : "";
  return { form, particle, connective: converb ? NEGATION_CONVERB : "" };
}

/** 而 — the character whose own connective a 連用形 must not have a second one
 * written on top of. Named here for the one guard in `negationEnding` that needs
 * it; `renyouTe.ts` makes the same test on the same lemma for a verb's 連用形,
 * and `teOrShite` is what actually writes the connective in both cases. */
const ERU_CONNECTIVE_LEMMA = "而";

/** **The connective a negation's 連用形 takes under the 連用形の「て」 switch** —
 * して, giving 〜ずして.
 *
 * `renyouTe.ts` is a display option, not a grammar change: with it off a 連用形
 * stands bare (連用中止法) and with it on the join is written out. Its rule is
 * **verb → て, adjective and 形容動詞 → して**, and until the arm above existed no
 * negation had a 連用形 for it to have an opinion about. One is needed now, and
 * a negation is neither a verb nor an adjective, so the rule next door does not
 * answer it. It is written here rather than there because the negation piece is
 * `negationEnding`'s to write and nothing else's — the same reason the に and the
 * ば are written here.
 *
 * **して and not て, i.e. 〜ずして and not 〜ざりて.** Both are attested and the
 * reader said so. What settles it is that **this app has already settled it**:
 * `teOrShite` — the function that decides what a *source* 而 writes after the
 * word before it — has one branch keyed on exactly this, `afterNegation ||
 * afterRereadNegation`, and it returns して. 人不知而不慍 reads 人知ら**ずして**
 * 慍みず and 未學禮而不知 いまだ禮を學ば**ずして**知らず, both of them standing
 * anchors. A 而 and this switch are two ways of asking for the same thing — write
 * the join out instead of leaving the 連用形 bare — so an answer that differed
 * would put 知らずして and 知らざりて in the same paragraph depending on whether
 * the source happened to spell the connective.
 *
 * The grammar agrees with the precedent, which is why the precedent is right:
 *
 *  - **ずして is the ず series' own converb**, and it is not ず+て. The して is a
 *    接続助詞 in its own right (the same して `COPULA.renyou` and タリ活用's として
 *    are built on), and it attaches to the bare ず precisely because ず can take
 *    a 接続助詞 even though it can take no 助動詞. 漢文訓読体 writes it as a matter
 *    of course — 人不知而不慍 is 人知らずして慍らず, 不學而能 は 學ばずして能くす,
 *    無而爲有 は 無くして有りと爲す. This app targets 文語 and specifically the
 *    訓読 register (see `NON_VERB_CONNECTIVE`'s note on 貧しくして), and in that
 *    register ずして is the ordinary form and ざりて is not.
 *  - **ざりて is a 和文 form.** The ざり series exists to carry 助動詞 (ざりき,
 *    ざりけり, ざるべし) — see `ZARI` — and て is not one. Where 和文 does write
 *    ざりて it is beside ずて/ずして rather than instead of them, and 訓読 hardly
 *    writes it at all.
 *
 * So the ず-series 連用形 with its own connective, throughout: 飲まず食はず bare,
 * 飲まずして食はず under the switch, and 知らずして where a 而 is written — one
 * answer from `teOrShite` and from here.
 *
 * **What is not measured, and is named rather than hidden**: there is no 訓読
 * corpus in this repo to count ずして against ざりて in, the LZH treebanks
 * carrying no Japanese readings at all. The argument above is the precedent plus
 * the philology, not a count. Changing it to ざりて means returning
 * `NEGATION.renyouZari` from `negationForm`'s 連用形 arm and setting this to て —
 * and moving `teOrShite`'s negation branch with them, since ざり + して is not a
 * form and the two must not disagree. */
const NEGATION_CONVERB = "して";

/** True when the negation `token` closes a clause **係り結び binds** — so the ず
 * takes the 連体形 ざる. Both halves of the construction reach it:
 *
 *  - **a 係助詞 か / ぞ / なむ closing the clause right after the ず**, which is
 *    `isBindingParticleAhead` asked of the predicate this negation hangs off —
 *    豈…邪 gives 〜ざる**か**; and
 *  - **a ぞ-bearing interrogative standing earlier in the clause**, which is
 *    `boundAsInterrogativeMusubi` asked of that same predicate. 胡不遄死 is
 *    胡ぞ遄かに死せ**ざる**, 何不食肉糜 何ぞ肉糜を食は**ざる** — **102** gold
 *    sentences put an interrogative binder in front of a suffix-negated
 *    governor.
 *
 * The positive half of both is in `decideConjForm`, and they say the same thing
 * about the same slot: what 係り結び binds is whatever stands at the clause's
 * end. What is different is only *which* token that is. On an unnegated clause
 * it is the predicate itself and `decideConjForm` answers (數有る**か**); on a
 * negated one the 不 is postposed past its verb, so the thing at the end is the
 * ず, and the verb owes the ず a 未然形 rather than owing the binding anything.
 * That is the same division of labour 苦不得飲 (得ざるに), 學而不思則罔
 * (思はざれば) and 不知之耳 (知らざるのみ) already run on.
 *
 * **不亦…乎 no longer reaches this at all, and neither a carve-out nor an
 * overruling is what took it out.** A `RHETORICAL_FRAME_ADVERB` test once stood
 * here refusing the 連体形 wherever a 亦 hung off the same chain, so that
 * 學而時習之，不亦說乎？ kept 亦說ばしから**ず**や; the case for it was that the
 * frame is one lexicalised formula — over `lzh-{train,dev,test}.sud.conllu`, 72
 * of the 276 negation-before-や/か edges carry a 亦 and every one of those 72 is
 * 不亦…乎, while 不亦 itself occurs in 82 sentences and takes 乎 in 78 of them.
 * The reader struck it out in those words: *"Don't carve out 不亦."* The rule
 * then applied to all 276 edges alike and printed 亦說ばしから**ざる**や.
 *
 * **What has changed is the 接続 of や itself**, which was the real error the
 * carve-out was compensating for: a 終助詞 や takes the **終止形**, so 〜ずや
 * falls out for all 276 edges with no carve-out anywhere and the reader's
 * instruction is honoured rather than reversed. や is out of
 * `BINDING_PARTICLE_READINGS`, whose doc carries the argument; this function is
 * untouched by the change beyond no longer being reached for a 乎.
 *
 * **The resolver is optional and both halves degrade the same way.** Without one
 * the closing-particle half still reads `SENTENCE_FINAL_PARTICLES` (which is
 * where 乎/歟/與/否 and the 豈-frame's か live) and the interrogative half
 * answers no, since the ぞ it binds on is a *reading* and there is nothing to
 * read it with. Both panels pass one. */
function boundByBindingParticle(
  token: Token,
  plan: ReadingPlan,
  resolveReading: ReadingResolver | undefined,
): boolean {
  const sentence = plan.sentence;
  const governor = sentence.tokens.find((t) => t.id === token.head && t.id !== token.id);
  if (!governor) return false;
  const next = nextMeaningfulToken(plan, token.id);
  return (
    isBindingParticleAhead(governor, next, sentence, resolveReading) ||
    boundAsInterrogativeMusubi(governor, sentence, resolveReading)
  );
}

/** The negators that put a 如/若 comparison into the 〜に如かず construction —
 * 不 498, 莫 76, 弗 14, 未 6 immediately before a 如 in
 * `lzh-{train,dev,test}.sud.conllu`, 594 of its 2,920 occurrences.
 *
 * Wider than `NEGATION_LEMMAS`, deliberately. That set is the one the ず/ざる
 * machinery writes an ending from, and 莫/無/无 are not in it because they are
 * the *existential* negation 無し, which realises its own predicate rather than
 * suffixing one. For the question this asks — is this comparison a negative one
 * — 莫如舜 ("none comes up to Shun", 舜に如くは莫し) is exactly as negative as
 * 不如, and its standard takes the same に. So the two sets answer different
 * questions and are written separately rather than one being bent to the
 * other's shape. */
const COMPARATIVE_NEGATION_LEMMAS: ReadonlySet<string> = new Set(["不", "弗", "未", "勿", "莫", "無", "无"]);

/** Whether this token is 如/若 **used as a comparison** — the "resemble, come up
 * to" verb, as against the conditional もし and the 申申如也 suffix, which the
 * two branches in `caseParticleFor` must leave completely alone.
 *
 * Three tests, in decreasing order of what the tree actually states:
 *
 *  - **`Degree=Equ`**, the treebank's own feature for it, carried by 2,594 如
 *    and 748 若 in `lzh-{train,dev,test}.sud.conllu`.
 *  - **XPOS `v,動詞,行為,分類`** — "verb of classification" — which the corpus
 *    says is *the same set*: it is carried 2,594 times, exactly the `Degree=Equ`
 *    count, whatever the UPOS on top of it. Stated as a second route rather than
 *    left implicit because a parse can carry the fine tag and drop the feature.
 *  - **The UPOS, and only where the tree states neither of the above.** Same
 *    discipline `isVerbalXpos` follows for a hand-written tree that carries no
 *    xpos at all: with nothing to read, the coarse tag is what there is. A tree
 *    that *does* carry features and says neither Equ nor 分類 is taken at its
 *    word and refused.
 *
 * The two uses that must survive are both refused by all three: the conditional
 * もし is ADV `v,副詞,判断,推定` (198 tokens, no `Degree`), and the タリ suffix is
 * PART `p,接尾辞,*,*` (76), which is `TARI_SUFFIX_CHARS`'s and never reaches a
 * case particle in any event. */
function isComparativeYu(token: Token): boolean {
  if (token.lemma !== "如" && token.lemma !== "若") return false;
  if (parseMorphFeatures(token.morph ?? "").Degree === "Equ") return true;
  if (token.xpos.startsWith("v,動詞,行為,分類")) return true;
  if (token.xpos || token.morph) return false;
  return token.pos === "VERB" || token.pos === "ADJ";
}

/** Whether this 如/若 is negated — see `COMPARATIVE_NEGATION_LEMMAS`. Asked of
 * the token's own children rather than of the character before it, so a
 * negation belonging to some other predicate cannot claim it. */
function hasComparativeNegation(token: Token, sentence: { tokens: Token[] }): boolean {
  return sentence.tokens.some(
    (t) => t.head === token.id && t.id !== token.id && t.id < token.id && COMPARATIVE_NEGATION_LEMMAS.has(t.lemma),
  );
}

/** The particles that mark a nominal's **slot** — what the word standing in it
 * is to the word that governs it.
 *
 * Five of the six are particles this function writes itself: を for an object,
 * に for an oblique, と for a predicative, の and は for a subject. **が** is here
 * on top of those because が and の are one slot spelled two ways — 吾が身 is
 * 我の身 — so a reading that has written the one has written what this function
 * would have written as the other, and the doubling is the same doubling.
 *
 * **Matched whole, never as a suffix**, and that is the whole of what keeps the
 * predicate below off an ending that merely *ends* in a particle's kana. 於 is
 * お + いて and 幸 さいは + ひに; 再 is ふたた + び and 一 ひと + たび. Those are
 * verb and adverb endings with a particle's shape somewhere in them and no
 * particle in them, and `okurigana === "に"` is true of ために and false of
 * さいはひに where `endsWith("に")` would have been true of both. 於 in
 * particular has to survive, since its object takes に from its own branch below
 * and 日中**に**於**いて** is the reading that combination is written for.
 *
 * も is deliberately out (雖 いへど + も): a 係助詞 adds to a word that is already
 * marked rather than marking it, so a case particle after one is not a second
 * marking of one slot. */
export const SLOT_MARKING_PARTICLES: ReadonlySet<string> = new Set(["を", "に", "と", "の", "が", "は"]);

/** The word classes whose reading's particle-shaped ending is **not** case
 * marking — the boundary the stand-down below turns on, and a boundary rather
 * than an omission.
 *
 * Nine `overrides.json` entries read a word as *stem + に*, and in every one of
 * them the に is a 形容動詞's 連用形 ending, which makes an adverb rather than
 * filling a slot: 遂/終/卒/竟 つひに, 倶/俱 ともに, 徒 いたづらに, 毎/每 ごとに,
 * 故 ゆゑに. Measured over the gold, tokens those entries claim **do** draw a
 * case particle here — **故 221** of 1,532, **徒 45** of 150, **毎 2** of 79 —
 * and every one of the 268 is a *content* word the entry has claimed wrongly:
 * the 徒 of 子曰：「非吾徒也。」 is the noun "disciple" (吾が徒にあらず) and not
 * the adverb いたづらに, the 故 of 挾故而問 is the noun "cause" and not the
 * conjunction ゆゑに, the 毎 of 毎月輒更其題品 the distributive and not a
 * predicate. What is on those pages is a doubling — 吾がいたづらに**に**あらず —
 * and it is a *symptom*: the reading is already wrong before any particle is
 * written, and standing down there would delete the one correct piece (the 非's
 * に) and leave the wrong いたづらに standing. The correction is to the entries'
 * own context conditions, which is `overrides.json`'s to make and not this
 * function's to compensate for; the counts are here so that the population is
 * named rather than silently swept in.
 *
 * What is left after them is the closed classes — the adposition, the pronoun,
 * the determiner, the particle — where a curated reading ending in a case
 * particle is that word's *marking*, written out, and where a second particle
 * therefore marks one slot twice. PRON is deliberately on the open side of the
 * line here although `NOMINAL_PREDICATE_POS` counts it a nominal: 吾が, 其の,
 * 何の are genitive readings, and the が in them does exactly what the の this
 * function writes for a subject does. */
export const CONTENT_WORD_POS: ReadonlySet<string> = new Set(["NOUN", "PROPN", "VERB", "ADJ", "NUM"]);



/** Whether a ROOT in `AUXILIARY_LEMMAS` is one this clause's subject should be
 * topicalized for — every character in that table except an **unpinned 能 or
 * 欲**, whose entries there exist only so that a reader who picks the auxiliary
 * off the menu gets the paradigm back (see `PINNED_ONLY_AUXILIARY_LEMMAS`,
 * which is the one statement of which two those are). A pinned one *is* the
 * auxiliary and counts.
 *
 * 欲 joined 能 when it joined that set, and for the same reason read through to
 * this branch: what the branch claims is that the clause's predicate is a modal
 * auxiliary, and a 欲 the app now reads as the verb 欲す is not one — 白頭搔更短
 * 渾欲不勝簪 came out 白頭**は**搔き, a topic marked on the strength of an
 * auxiliary the sentence no longer has. Measured with the rest of the 欲 change;
 * see `PINNED_ONLY_AUXILIARY_LEMMAS`. */
function isAuxiliaryRootForTopic(root: Token): boolean {
  return !isPinnedOnlyAuxiliary(root) || chosenAuxiliary(root) !== undefined;
}

/** Whether this token's own reading has **already written the particle that
 * marks its slot** — in which case `caseParticleFor` has nothing left to write,
 * exactly as a 而 has nothing left to write after a 連用形 that already contains
 * its own して.
 *
 * This is `precedingFormSuppliesShite`'s shape asked one token nearer: that
 * predicate asks whether the word *before* has written the connective (王仁人に
 * して**て** is what it averts), and this asks whether the word *itself* has
 * written the particle. `readingResolver.ts` states the same fact from a third
 * side, refusing to split an ending off a reading where a case particle is
 * coming — *"an ending of its own already claims the slot, exactly as a case
 * particle does"*.
 *
 * **Two readings reach it today, and they are one fact.** Both are written in
 * `overrides.json` as a reading of the character plus a particle in the
 * okurigana slot, which is what makes the doubling two marks on the 訓読文 and
 * not merely an extra kana in the prose. Counted over
 * `lzh_kyoto-sud-{train,dev,test}.relabeled_ext.udep_ruled.punct.rulemerged.adjfix.conllu`
 * (68,893 sentences):
 *
 *  - **為/爲 tagged ADP — ため + に.** The entry claims **1,045** tokens and
 *    **15** of them draw a second particle here: に 9 (非爲趙也 -> 趙のために**に**
 *    あらず, the に from `negatedPredicate` eleven branches down), は 5
 *    (為君使而死 -> 君のために**は**しめて死ぬ), を 1.
 *  - **吾/我/予/余/朕 on `det` — わ + が.** The entry claims **393** tokens and
 *    **1** doubles: 吾有司死者三十三人, where gold has 吾 as the `det` of 司 with
 *    有 (`VerbForm=Part`) its sibling, so `isExistentialLocus` reads the
 *    determiner standing in front of 有 as the place the officers exist at and
 *    marks it に — わが**に**有司死ぬる者. 吾が有司 is the reading, and the わが
 *    has already said so.
 *
 * **Three conditions, and each of them is load-bearing.**
 *
 * 1. **The okurigana is a slot-marking particle, matched whole.** Never as a
 *    suffix, and that is the whole of what keeps this off an ending that merely
 *    *ends* in a particle's kana: 於 is お + いて and 幸 さいは + ひに, 再 is
 *    ふたた + び and 一 ひと + たび — verb and adverb endings with a particle's
 *    shape somewhere in them and no particle in them. `okurigana === "に"` is
 *    true of ために and false of さいはひに where `endsWith("に")` would have been
 *    true of both. 於 has to survive in particular, since its object takes に
 *    from its own branch below and 日中**に**於**いて** is the reading that
 *    combination is written for.
 * 2. **The word is not a content word** — see `CONTENT_WORD_POS`, which carries
 *    the 268 gold tokens that condition excludes and why they are not this
 *    function's to fix.
 * 3. **The entry names the role the token actually occupies.** `curatedInRole`
 *    in `readingResolver.ts` draws the same distinction for its own purposes and
 *    for the same reason: a char-only entry states the character's reading
 *    *standing on its own* and says nothing about this occurrence, while a
 *    conditioned entry speaks about the token as it here stands. Only the second
 *    kind is evidence that the particle on the page belongs to *this* slot.
 *
 * **Keyed on the okurigana that is actually on the page**, not on the table
 * alone: a reader's pinned reading outranks every curated reading in both panels
 * (`chosenReadingParts`), so a pin is asked first and answers whole — a pin with
 * no okurigana has replaced ために with something that writes no particle, and
 * this has to say so. Below a pin the table answers, and for these classes it is
 * what the page shows: both panels consult `verbLexicon.ts` ahead of the
 * resolver only for the tags `usesLexiconEntry` admits, and no closed class is
 * among them, so nothing stands between such an entry and the page.
 *
 * **Written to generalise, because the same shape is already being asked for
 * again.** The reader has ruled 我**が**ために for a first-person pronoun under a
 * prepositional 為 (`isPurposiveWeiComplement` below writes the particle half of
 * that today, on the pronoun's `comp:obj`). If the が is ever moved into the
 * *reading* instead — the わ + が entry widened past `det` — that token lands
 * here: PRON, a conditioned entry, okurigana が, and the が this function would
 * write is withheld rather than doubled. Keying on the role the entry names
 * rather than on a list of the two roles that have one today is what makes that
 * true in advance.
 *
 * Asked of the token and not of the sentence, deliberately: what a reading has
 * written is a property of the word, and every branch below is free to go on
 * asking about the tree. */
function ownReadingSuppliesCaseParticle(token: Token): boolean {
  if (CONTENT_WORD_POS.has(token.pos)) return false;
  const chosen = chosenReadingParts(token);
  if (chosen) return chosen.okurigana !== undefined && SLOT_MARKING_PARTICLES.has(chosen.okurigana);
  const entry = findOverride(token.text, token.pos, token.dep);
  if (!entry || (entry.contextPos === undefined && entry.contextDep === undefined)) return false;
  return entry.okurigana !== undefined && SLOT_MARKING_PARTICLES.has(entry.okurigana);
}

/** **The standard of a *positive* comparison 如/若 — what it is compared to.**
 *
 * Lifted out of `caseParticleFor`'s comparison branch, whose conditions these
 * are and whose doc there states the count standing behind each one, so that
 * `negationEndingParts` can ask the same question of the same tokens. The
 * two have to agree: this slot's particle is written by `caseParticleFor` on
 * the standard itself where nothing follows it, and by `negationEndingParts`
 * onto the ざる where a postposed negation closes the clause. A condition
 * restated in two places is a condition that will come apart. */
function isComparisonStandard(token: Token, sentence: Sentence): boolean {
  const governor = sentence.tokens.find((t) => t.id === token.head && t.id !== token.id);
  return (
    !!governor &&
    isComparativeYu(governor) &&
    (token.dep === "comp:obj" || (token.dep === "mod" && NOMINAL_PREDICATE_POS.has(token.pos))) &&
    token.id > governor.id &&
    !isInterrogativeStem(token) &&
    !hasComparativeNegation(governor, sentence)
  );
}

export function caseParticleFor(token: Token, sentence: Sentence): string | undefined {
  // A 敢 read as 敢へて owes its slot nothing: what closes its clause on the
  // page is its complement, which is asked instead, through the view in which
  // it holds that slot (see `ganClauseView`) — or, for a bare 敢へてせ, the ず
  // after it, which `negationEnding` already writes the slot's particle onto.
  if (ganAdverbReading(token, sentence) !== undefined && chosenTopicParticle(token) === undefined) return undefined;
  // The ん (and や) of 豈敢V, on the 未然形 `decideConjForm` gives the same
  // predicate — unless a negation closes the clause, which writes ざらんや
  // instead. See `rhetoricalGanOf`.
  const rhetoricalGan = rhetoricalGanOf(token, sentence);
  if (rhetoricalGan && chosenTopicParticle(token) === undefined) {
    const negated = sentence.tokens.some(
      (t) => (t.head === token.id || t.head === rhetoricalGan.gan.id) && t.id !== t.head && isNegationUse(t),
    );
    return negated ? undefined : rhetoricalGanEnding(token, rhetoricalGan, sentence);
  }
  const ganView = ganClauseView(token, sentence);
  if (ganView) return caseParticleFor(ganView.token, ganView.sentence);
  const governor = sentence.tokens.find((t) => t.id === token.head);

  // Above every rule below it, because it is not a rule: the reader has said
  // what this slot takes. A 係助詞 written by hand *replaces* the particle the
  // relation would have marked and does not join it — a subject's が and its
  // は are one slot, and 鳥がは is not a Japanese phrase — so this returns
  // rather than composing, and every branch under it is left unread.
  //
  // Standing above the two stand-downs as well as above the writers is the
  // conservative placement and not merely the simple one. Both of them say
  // only that *this function* has nothing to write, and neither is evidence
  // that the slot is already marked on the page: a token whose reading
  // supplied its own particle is one the menu never offers this on
  // (`topicParticleOffered` admits a subject and nothing else), so a は found
  // here on such a token was written by hand into a file, and honouring it is
  // the reading of the reader's intent that the pin convention already takes
  // everywhere else — see `ownReadingSuppliesCaseParticle`, which asks a pin
  // first and lets it answer whole.
  //
  // Nothing fires by default. `chosenTopicParticle` is undefined on every
  // token of every parse until a reader picks the item, so with no choice made
  // this line is a lookup that misses and the function goes on exactly as it
  // did — which is what `tests/topicParticle.test.ts` pins over the corpus.
  const topic = chosenTopicParticle(token);
  if (topic !== undefined) return topic;

  // Ahead of everything else: a sentence-final particle takes no case particle of
  // its own, however the parse tagged it. 否 closing 君飲嘗不醉否？ comes back
  // VERB/`comp:obj` of 醉, which `isNominalizedObjectPredicate` below read as a
  // predicate standing in an object slot and marked を — the "spurious を" this
  // line removes. See `isSentenceFinalParticleUse` for how the particle use is
  // told from the verb 否む, and for what is still missing before the character
  // reads や rather than 否む.
  if (isSentenceFinalParticleUse(token, sentence)) return undefined;

  // And beside it, the frame the same argument covers from the other side: the
  // **nominal a presentative copula predicates of** takes no case particle
  // either. The gold hangs the topic of `AB也者` off the 也 as `comp:obj` — 禮 in
  // 禮也者 — which is where the blanket を on a `comp:obj` nominal came from, and
  // 禮**を**なる者は says the copula's predicand is its object. It is not: なる is
  // a copula and what stands in front of it is what the topic *is*. The
  // particle the frame does want is the 者's own は, which the parse marks and
  // `hasSentenceFinalParticle` now stops suppressing. See `isPresentativeCopula`.
  if (isPresentativeCopulaTopic(token, sentence)) return undefined;

  // And beside it, the other stand-down: a token whose own reading has already
  // written the particle that marks its slot takes none from its relation. The
  // two are in no order with respect to each other — both say only that nothing
  // is to be written — but both stand above every branch that writes something,
  // because a particle written *anywhere* below lands after a reading that has
  // already marked the slot: 非爲趙也 read 趙のために**に**あらず with the second
  // に from `negatedPredicate` eleven branches down, and 吾有司死者 read
  // わが**に**有司 with its に from `isExistentialLocus` thirty below that. See
  // `ownReadingSuppliesCaseParticle`.
  if (ownReadingSuppliesCaseParticle(token)) return undefined;

  // The predicate a 非 denies takes に — 非劉之病 is 劉の病にあらず.
  //
  // **Second only to the sentence-final-particle guard, and every branch below
  // it is a branch this has to outrank.** 非 says this token is a *predicate*,
  // and every rule further down asks the wrong question of one: 徒 in
  // 子曰：「非吾徒也。」 arrives as 曰's `comp:obj`, where `namingComplementParticle`
  // immediately below reads it as the thing being named and marks it を (吾が徒を
  // 曰ふ); 病 in the reader's own tree arrives on `subj`, where the topicalization
  // branches mark it は; a 非 over any other `comp:obj` takes
  // `CASE_PARTICLE_FOR_DEP`'s blanket を. It is none of those. It is what the
  // sentence says the thing is not — 吾が徒にあらざるなり.
  //
  // Written on the token itself rather than through the coordination carrier
  // below, because the 非 attaches to *its own head* and the に belongs where
  // the 非 points. 非A、B… coordinates two clauses, not two halves of one
  // nominal, and putting the に on the last conjunct would move it out of the
  // clause the 非 negates.
  //
  // Withheld where a *further* negation closes the clause, exactly as the
  // oblique branch below withholds its own に: 非不說子之道 is
  // 子の道を說ばざるにあらず, and the に has to land after that ず rather than in
  // front of it (說にず). `negationEnding` writes it there, on the 連体形 ざる.
  //
  // 非's own reading (あらず, ず as okurigana) and the fact that it is read
  // *after* the predicate it precedes in the source are two other modules'
  // halves of the same word. This writes only the particle, and it assumes of
  // them exactly what `isNominalNegationUse` asks: that the same occurrences
  // of the character are the negation. See `negatedPredicate`.
  if (negatedPredicate(token, sentence)) {
    return negationClosing(token, sentence) ? undefined : NOMINAL_NEGATION_PARTICLE;
  }

  // **Every complement that is a quotation takes no particle here**, and this
  // stands above the naming rule because the two answer one question and this
  // is the half that answers it best. 或言：『蟲は是れ劉の福、…』 was coming out
  // 劉の福**を**なり — the copula the clause earns (福 has 是 as its own `subj`,
  // so `extraEndingFor` predicates it) with a blanket object marker written in
  // front of it. No 也 stands on 福, so the sentence-final-particle guard below
  // could not see it; what says it is a quote is the bracket the source put
  // round the whole thing.
  //
  // **`isSpeechQuoteComplement` is asked, and nothing is restated here**, which
  // is what makes this one condition rather than three. That predicate is a
  // cascade over exactly the distinction this branch needs
  // (`depClassification.ts`): a nominal asserting its own 也 is a quote on the
  // particle alone; a nominal predicating nothing is a **name**, which inverts
  // and keeps its と/を; and everything else is a quote where the source
  // brackets it. So a naming complement is refused by the middle step and falls
  // through to `namingComplementParticle` below with its particle intact —
  // 名曰軒轅 keeps its と, 自稱曰「老夫」 its を — while the reader's 福, which
  // has a subject and a bracket, is admitted here.
  //
  // **Above the naming rule and below the 非 rule**, and both placements are
  // load-bearing. `namingComplementParticle` speaks only for 曰/云 and asks a
  // coarser question than the cascade does — POS, plus a stand-down for a
  // sentence-final particle — so a bracketed nominal with a subject of its own
  // under 曰 was being marked を as a *name* before this branch was reached
  // (曰：「此酒之精、…」 -> 此れ酒の精**を**にして). 非 stays above both, because
  // 非 says the token is a predicate and owes it the に that `negationEnding`
  // and this function share: 子曰：「非吾徒也。」 is 吾が徒にあらざるなり, and it
  // is a quote as well.
  //
  // What the quote wants in place of the を is a closing と after the whole of
  // it, which is `reorderEngine.ts`'s to write (`ReadingPlan.quoteEndIds`) and
  // a position this function cannot reach.
  if (governor && isSpeechQuoteComplement(token, governor, sentence)) return undefined;

  const naming = namingComplementParticle(token, governor, sentence);
  if (naming) return naming;

  // A nominal complement closed by a sentence-final particle heads a clause,
  // so it takes no ordinary object marking either — the blanket を that
  // `CASE_PARTICLE_FOR_DEP` gives every `comp:obj` nominal further down would
  // otherwise put back exactly the particle `namingComplementParticle` has
  // just stood down over (曰：「此酒蟲也。」 -> 此酒の蟲をなり). What the clause
  // wants instead is a closing と *after* its 也/なり, which is a position this
  // function cannot write to — see the report.
  if (
    (token.dep === "comp:obj" || token.dep === "comp:pred") &&
    governor &&
    isCommunicationVerb(governor) &&
    hasSentenceFinalParticle(token, sentence)
  ) {
    return undefined;
  }

  // The nominal predicate a 非 denies takes に — 非劉之病 is 劉の病にあらず.
  //
  // Ahead of everything below it, and that placement is the rule. 非's own
  // predicate is a *predicate*, so every heuristic further down is asking the
  // wrong question of it: 病 in the reader's own tree arrives on `subj`, where
  // the topicalization branches would have marked it は, and a 非 over a
  // `comp:obj` would have taken the blanket を. It is neither the subject of
  // something nor the object of something; it is what the sentence says the
  // thing is not.
  //
  // Written on the token itself rather than through the coordination carrier
  // below, because the 非 attaches to *its own head* and the に belongs where
  // the 非 points. 非A、B… coordinates two clauses, not two halves of one
  // nominal, and putting the に on the last conjunct would move it out of the
  // clause the 非 negates.
  //
  // Ahead of the topicalization heuristics below, which otherwise claim the
  // same token: 楚 in 楚人有… is a `mod` carrying `Case=Loc` whose governor
  // is the sentence's `subj`, which is pattern b's exact signature, and it
  // was coming out 楚は人…有り. A name sitting on the noun it names is a
  // genitive first — the fronted-topic reading is what's left for a modifier
  // that *isn't* one.
  //
  // **And a state name on its own people takes nothing at all**, ahead of the
  // same heuristics and for the same reason: 楚人有… is 楚人…有り, one word, and
  // withholding the の must not hand 楚 back to the topic rule that wrote 楚は.
  // See `isStateNameOnItsPeople`.
  //
  // **And neither does a juxtaposed pair of nominals**, which is the general
  // case the state-name rule turned out to be one corner of: 玄象, 渾天, 軌轍
  // are one term apiece. Returned here, beside the state-name test and ahead
  // of the same heuristics, for exactly the reason given above — this is where
  // the withholding has to happen if it is not to become a は. See
  // `isJuxtaposedNominalTerm`.
  if (isStateNameOnItsPeople(token, sentence) || isJuxtaposedNominalTerm(token, sentence)) return undefined;
  const genitive = genitiveNoParticle(token, sentence);
  if (genitive) return genitive;

  // **奈何 / 何如 is one word and its 何 takes nothing.** Ahead of every case
  // rule below, including the comparison branch that already withheld a の from
  // the preposed order: いかん is a fixed interrogative and its 何 is part of it,
  // not an argument. See `isIkanIdiom` in `depClassification.ts`, which also
  // holds the position half of the same claim.
  if (governor && isIkanIdiom(token, governor, sentence)) return undefined;

  // The place a locative 於 names takes に — 日中に於いて, 堂に於いて. Ahead of
  // the adposition branch immediately below, which is what was suppressing it:
  // that branch says an adposition already carries the complete case marking
  // once it inverts, and for the より sense it does (藍より取る is finished, and
  // 藍により取る is not a reading). おいて is the sense where it does not — 於いて
  // is a verb form, "being at", and the place it is at has to be marked before
  // it, exactly as any other locative nominal is.
  //
  // Keyed on the *reading* rather than on 於's dep, and that is what keeps
  // 取之於藍 intact: the two senses wear the same `mod@lmod`, so a dep-keyed
  // rule marked 藍 に as well and read 藍により取る. `isLocativeYu` asks the one
  // function that decides the reading, so the particle and the reading cannot
  // come apart. See `yuParts`.
  //
  // 自 is untouched, which the 有朋自遠方來 anchor turns on: its object goes
  // through the same adposition branch below and keeps taking nothing —
  // 朋遠方より來る有り, never 朋遠方により來る.
  if (governor && token.dep === "comp:obj" && isLocativeYu(governor, sentence)) return "に";

  // And the second adposition whose object has to be marked before it: the
  // benefactive/causal **為**, read ために. 為人謀 is 人**の**ために謀る, where this
  // read 人ために謀る with nothing between the two.
  //
  // The reader's rule: *為 when read as a preposition should be ために (with に as
  // okurigana), and should add の to its object.* The reading half is
  // `overrides.json`'s and belongs to whoever holds that file; this is the
  // particle half.
  //
  // **Beside the 於 branch above and for its exact reason**, which is worth
  // stating rather than leaving to the adjacency: an adposition ordinarily
  // carries its own case marking whole once it inverts — 藍**より**取る is
  // finished and 藍**に**より取る is not a reading — and the branch below says so
  // for every ADP at once. ため is the other kind: it is a *noun*, "the sake",
  // with に after it, so what it is the sake **of** stands in front of it in the
  // genitive exactly as 日中 stands in front of 於いて in the locative. Two
  // exceptions now, both of them adpositions that are read as content words.
  //
  // **Keyed on the tag, because that is what keys the reading.** `overrides.json`
  // gives 為/爲 ために on `contextPos: ["ADP"]` and on nothing else — the same
  // character is the copula たり at `comp:pred`/ROOT and the verb なす elsewhere
  // — so ADP *is* the condition under which the ために is on the page, and asking
  // it here is asking the same question the reading asks. (The 於 branch can do
  // better, keying on `yuParts`' own answer, because 於's two senses share a
  // tag and a function had to be written to tell them apart. 為's do not.)
  //
  // **What stands in that slot, measured.** Over
  // `lzh_kyoto-sud-{train,dev,test}.relabeled_ext.udep_ruled.punct.rulemerged.adjfix.conllu`
  // an ADP 為/爲 takes **1,045** `comp:obj` dependents: NOUN **430**,
  // PROPN **217**, PRON **210** — 857 nominals — VERB **132** and ADJ **23**,
  // with a tail of PART 16, AUX 9, SCONJ 6, ADV 2. The three arms below divide
  // it, and the division is the reader's:
  //
  //  - **a common or proper noun takes の** — 為人謀 is 人**の**ために謀る;
  //  - **a pronoun takes が**, which is the classical 連体格 for the closed class
  //    (我が, 誰が, 己が, 之が — 我**の**ために is not a 文語 reading). The reader's
  //    words: *"我がために."* 210 tokens, 之 92, 何 46, 我 19, 己 9, 奚 8, 自 8,
  //    余 7, 子 7, 誰 3, 曷 3, 吾 2 and a tail; the interrogatives come with them
  //    rather than being carved out, 何**が**故に being the ordinary kundoku of
  //    exactly this frame;
  //  - **a clause takes が too, on a 連体形** — which is `isPurposiveWeiComplement`
  //    below, and the 155 VERB/ADJ complements are what it is about.
  //
  // The nominal arm is written on the token itself rather than through the
  // coordination carrier below because the reader's rule is about what 為
  // governs, and 為 governs the head of that phrase.
  if (closesArgumentChain(token, sentence, isPurposiveWeiComplement)) {
    // Withheld where a negation closes the clause, exactly as the three
    // nominalization branches below withhold their own particles: the ず is read
    // after the predicate, so a が written here would land in front of it
    // (便がならず). `negationEndingParts` writes it on the 連体形 ざる instead —
    // 為子之不便也 is 子の便ならざる**が**爲なり. **3** of the 155 are negated.
    //
    // Through `closesArgumentChain`, the fourth of the four: 為其拜而蓌拜 is
    // 其の拜みて蓌拜する**が**爲なり, with the が after the whole chain.
    return negationClosing(token, sentence) ? undefined : PURPOSIVE_GENITIVE;
  }

  if (governor && token.dep === "comp:obj" && isPurposiveWei(governor) && NOMINAL_PREDICATE_POS.has(token.pos)) {
    return token.pos === "PRON" ? PURPOSIVE_GENITIVE : "の";
  }

  if (governor?.pos === "ADP" || (governor?.lemma === "之" && (governor.dep === "mod" || governor.dep === "subj"))) {
    // The adposition itself (於 -> より via `yuParts`, 自 -> より) already
    // carries the complete case marking once it inverts before its own
    // governor; its
    // object never takes an additional particle of its own. 之 used as the
    // genitive/attributive の (少典之子 -> 少典の子 — see overrides.json,
    // keyed on `dep === "mod"` since this parser tags it SCONJ here, not
    // ADP) is the same kind of already-complete postposition, just not
    // POS-tagged as one: without this, 少典 (之's own comp:obj) picked up
    // CASE_PARTICLE_FOR_DEP's blanket を below on top of の, giving the
    // nonsensical 少典をの子.
    //
    // **`subj` beside `mod`, because the same word wears both.** 之 between a
    // clause's subject and its predicate is the *subject* genitive — 人之不己知
    // is 人**の**己を知らざる — and the parser hangs that 之 off the predicate,
    // so it comes back `subj` where the attributive comes back `mod`. It is one
    // postposition either way and its object takes nothing either way;
    // 禮之用和爲貴 read 禮**を之れ**用ゐる with the を this branch is here to
    // withhold. See `overrides.json`'s `contextDep: ["subj"]` entry for 之,
    // which supplies the の, and for the 451 tokens it answers.
    return undefined;
  }

  // A complement standing in front of its verb and resumed by 之/是 is an
  // object however the parse labels it, so it takes を — not the は its
  // `subj` tagging would otherwise attract, and not nothing.
  //
  // Plus のみ when a 唯/惟/維 modifies the same predicate. Focus scope is
  // generally not recoverable from a sentence — the preposed complement of
  // this construction is often topical, with the focus on the predicate
  // instead (Hahn 2011, §2.1.5), which is why nothing else here tries to
  // mark it. This one configuration is the exception: both edges of the
  // domain are present, 唯 opening it and the resumptive closing it, and
  // an exclusive reading of a *topical* element is incoherent, so the
  // restriction can only be applying to the complement between them.
  // Bare 唯 with no resumptive stays plain ただ, which is where the scope
  // genuinely is undetermined.
  if (isPreposedComplement(token, sentence)) {
    const predicate = governor && preposedComplement(governor, sentence) ? governor : undefined;
    return predicate && exclusiveFocusOf(predicate, sentence) ? "をのみ" : "を";
  }

  // The causee of a 使役 takes をして, not a plain を: 使民戰 reads
  // 民をして戰はしむ. It is the one made to act, not the thing acted on.
  //
  // **A nominal, and only a nominal.** A causee is a person or a thing; what
  // it is made to *do* is the caused predicate, which takes the 未然形 the
  // しむ attaches to (`isCausedPredicateOf`) and no case particle at all. The
  // relation alone cannot tell the two apart — this parser puts the caused
  // predicate on `comp:obj` as readily as the causee, and 酒蟲's
  // 但令於日中俯臥 (sent_id 20) came back with 俯 exactly that way — so the
  // particle was written onto the act rather than onto the actor: 俯臥をして,
  // the causee marking on a verb. The POS is what separates them, and it is
  // not a heuristic: no predicate is a causee, whatever edge it arrives on.
  // 使民戰's 民 is a NOUN, so the anchor this rule was written for is
  // untouched, and so is every other causee a text can actually have.
  //
  // **…except the one nominal this treebank does not tag as one: 者.** A
  // headless relative is a person as much as 民 is — 使談天者無所取則 is
  // 天を談ずる者**をして**取則する所無からしめんとす — and the causee there came
  // out bare, with no particle at all, because 者 is tagged `PART` and
  // `NOMINAL_PREDICATE_POS` holds the three nominal tags. It is not a POS
  // question: 者 nominalizes the clause in front of it, which is exactly what
  // `readingResolver.ts` reads it as (もの, with a topic は of its own in a
  // subject slot), and a nominalizer standing under a causative is the causee.
  //
  // **Counted over `lzh_kyoto-sud-{train,dev,test}…sjmerged.conllu`**, a PART
  // on `comp:obj`/`comp:obl` under one of the five causatives is **44** tokens
  // and three lemmas: 者 **39** (30 of them with an act beside them, which is
  // the bound below), 所 4, 也 1. Only 者 is admitted — the other two are three
  // tokens between them, which is not a rule, and 也 is not a nominalizer at
  // all. Against the received readings: kanbun.info writes をして **164** times
  // and the noun before it is 人 31, **者 14**, 民 12, 軍 10, 之 9 — so 者 is the
  // second commonest causee the corpus has, and the one the app was silent on.
  //
  // **And `comp:obl` beside `comp:obj`, bounded.** The relation is no more
  // fixed on this side than it is on the caused predicate's: gold puts the
  // causee of 敎 on `comp:obl` 13 times (后稷教民稼穡, 教民睦也, 始教之讓) with
  // the act on `comp:obj` beside it, the exact mirror of the 使民戰 shape. Read
  // by relation alone, those 13 took the oblique's に — 民**に**戰はしむ, a
  // dative on the one made to act.
  //
  // The bound is that the causative must actually govern an act, and it is
  // measured: of the 26 nominals gold hangs off a causative by `comp:obl`, the
  // 15 with a verbal complement beside them are causees without exception, and
  // the 11 without one are not — 斯遣之藥 and 中山之君遣之齊 are a recipient and
  // a goal under a 遣 that is plain "send", and 教之鄉飲酒之禮 is what someone is
  // taught rather than someone made to act. Those keep the に they have.
  //
  // **The bound covers `comp:obj` as well, and it did not always.** While every
  // one of the five characters rendered as しむ wherever it stood, a nominal on
  // the direct relation under a causative really was the causee whether or not
  // the act was expressed, and this arm was written unbounded to say so.
  // `readsAsCausative` has since stood the auxiliary down where nothing is being
  // caused, and a をして surviving that stand-down would mark a causee in a
  // sentence with no causative in it: 惠則足以使人 is 人**を**使ふ, not
  // 人をして使ふ. So the particle and the auxiliary are asked of one predicate,
  // and cannot come apart — 617 tokens of 使 alone turn on it.
  if (
    governor &&
    CAUSATIVE_LEMMAS.has(governor.lemma) &&
    (NOMINAL_PREDICATE_POS.has(token.pos) || isCauseeZhe(token, governor, sentence)) &&
    (token.dep === "comp:obj" || token.dep === "comp:obl") &&
    readsAsCausative(governor, sentence)
  ) {
    return "をして";
  }

  // What a comparison 如/若 is compared *to* takes の — 如游魚 is 游魚のごとし,
  // 惡酒如仇 is 酒を惡むこと仇のごとし. Never を, and never に outside the one
  // negated construction the branch below keeps.
  //
  // **What 如 is, measured.** Over `lzh-{train,dev,test}.sud.conllu` (137,786
  // sentences / 1,066,724 tokens) 如 is 2,920 tokens, and the POS is not close:
  //
  // | UPOS |  n   |   %   | XPOS                | sense                |
  // |------|------|-------|---------------------|----------------------|
  // | VERB | 2526 | 86.5% | `v,動詞,行為,分類` 2594 | "be like, resemble"  |
  // | ADV  |  314 | 10.8% | `v,副詞,判断,推定` 198  | もし, "if"            |
  // | PART |   76 |  2.6% | `p,接尾辞,*,*`         | the 〜如 タリ suffix   |
  // | ADP  |    4 |  0.1% | `v,動詞,行為,移動` 52   | "go to" (使景鯉如秦)  |
  //
  // — so **如 is a verb**, and the one it is is "resemble". Its own relation is
  // `root` 51.8%, `mod` 23.8%, `comp:obj` 15.3%. What it *governs* is a
  // `comp:obj`: 2,484 of its 7,838 dependents, the largest class by far and
  // ahead of `subj` (1,244) and `mod` (1,188, of which 1,018 are ADV — 猶/亦
  // modifying the simile, not the thing compared to). That `comp:obj` follows
  // 如 2,264 times and precedes it 220, and the 220 are the fixed 何如 idiom.
  // Its own POS is VERB 850 / PRON 774 / NOUN 590 / PROPN 204.
  //
  // So the complement is `comp:obj`, and it is a `comp:obj` that was taking
  // `CASE_PARTICLE_FOR_DEP`'s blanket を wherever 如 came back tagged something
  // other than VERB (酒蟲's sent_id 33 read 仇をごとし), or the branch below's
  // に wherever it came back VERB. `mod` stays admitted beside it because this
  // parser does use it: 蠕動如游魚 comes back with 魚 as 如's `mod`.
  //
  // `Degree=Equ` is what confirms the comparison use, and it is the treebank's
  // own feature rather than a guess: it is carried by 2,594 如 — exactly the
  // `v,動詞,行為,分類` count above, whatever the UPOS on top of it — and by 748
  // 若. **It is absent from both of the uses that must survive**: the ADV もし
  // (`v,副詞,判断,推定`) and the 76 PART tokens of the 申申如也 suffix, which is
  // `TARI_SUFFIX_CHARS`'s and never reaches a case particle at all.
  //
  //  - **`comp:obj` at any POS.** The rule the reader states is that **the
  //    object of 如 is always marked with の, never を**, and the object is
  //    whatever stands on that relation — VERB 850, PRON 774, NOUN 590,
  //    PROPN 204. A predicate complement is a clause read 〜のごとし on its own
  //    連体形, not something 如 acts on, so the POS is no condition here. Left
  //    out, the 850 VERB complements fell through to
  //    `isNominalizedObjectPredicate` and picked up exactly the を the rule
  //    forbids.
  //  - **`mod` only where nominal**, because `mod` is the relation the *parse*
  //    reaches for and not the one gold uses — gold analyses a comparative's
  //    standard as `comp:obj`, postposed 3,206× against 232× preposed. A `mod`
  //    of 如 is an adverb 1,018 times out of 1,188 (猶, 亦 — modifying the simile
  //    rather than naming what is compared to), and an adverb takes no の.
  //    酒蟲's 蠕動如游魚 comes back with 魚 on `mod`, which is as far as this
  //    needs to reach.
  //  - **Following 如 only.** The 220 preposed `comp:obj` are 何如 ("how is
  //    it?"), a fixed interrogative and not a comparison; 何 there is read as
  //    part of the idiom and takes nothing of its own.
  //  - **Not an interrogative**, which excludes the other half of the same
  //    family — 如何 and 如之何, where the complement follows. Asked through
  //    `isInterrogativeStem`, the treebank's own 疑問 field, rather than by
  //    listing 何.
  //  - **Not negated**, which is the whole of what the branch below keeps.
  if (isComparisonStandard(token, sentence)) {
    // **Withheld where a negation closes the standard's own clause**, exactly
    // as the purposive-為 branch above withholds its own が and for that
    // branch's one reason: a postposed 不 is read *after* the predicate it
    // denies, so a が written on the predicate lands in front of it —
    // 如不祭 came out 祭ら**が**ざるを如し, with the 連体格 wedged inside the
    // word and a second particle after it. `negationEndingParts`' comparison
    // arm writes the が onto the 連体形 ざる instead: 祭ら**ざるが**如し, which
    // is the received reading of 論語 八佾 12 to the character.
    if (negationClosing(token, sentence)) return undefined;
    // **が where the standard is a clause, の where it is a nominal**, which is
    // the same division `isPurposiveWeiComplement` draws for 為: a predicate
    // standing in a nominal slot is read on its 連体形 and the classical
    // 連体格 after one is が, not の. 祭如在 is 在すが如くす and
    // 其如示諸斯乎 其れ諸を斯に示すが如きか; 游魚の如し keeps its の.
    //
    // **Counted in the received reading.** Over kanbun.info's 178,468
    // characters of 書き下し文, 如 is preceded by が **90** times and by の
    // **105**, and the two are not in free variation: every one of the が
    // follows a 連体形 ending (るが 55, うが 5, むが 3 …) and every one of the
    // の follows a noun. The app wrote の on all 195.
    return isContentPredicatePos(token.pos) ? PURPOSIVE_GENITIVE : "の";
  }

  // 〜に如かず — the *negated* comparative, and the one place the standard takes
  // に rather than the の above. 不如 is "does not come up to", a different
  // predicate from "is like": 知之者不如好之者 is 之を知る者は之を好む者に如かず.
  //
  // Negation is what separates the two, and it is not a fringe case: 594 of the
  // 2,920 如 in the corpus stand directly after one (不 498, 莫 76, 弗 14, 未 6),
  // 20.3% of every occurrence. Before this the *tagging* was made to carry the
  // distinction — に wherever 如 came back VERB — and the corpus says that is
  // 2,474 of 2,594 comparison uses, i.e. very nearly all of them, positive ones
  // included.
  //
  // **Negation and nothing else**, where this branch used to key on 如 coming
  // back tagged VERB. Two things follow from narrowing it:
  //
  //  - A *positive* 如's object reaches the の above whatever its POS, which is
  //    the rule as the reader states it: the object of 如 is always marked の.
  //  - 何如 — the 220 preposed objects, and the one shape the の rule refuses —
  //    now takes **nothing** where it used to take a spurious に (何に如く). 何如
  //    is いかん, a fixed interrogative whose 何 is read as part of the idiom.
  //
  // No POS gate and no ordering gate here: what a negated comparison is measured
  // against is its object wherever it stands and whatever it is, and the
  // corpus's own commonest case has a VERB there (知之者不如好之者 —
  // 之を好む者に如かず).
  if (
    governor &&
    isComparativeYu(governor) &&
    token.dep === "comp:obj" &&
    hasComparativeNegation(governor, sentence)
  ) {
    return "に";
  }

  // What a verb of speech reports takes と, never を — the carve-out from the
  // nominalized-object rule below. Ahead of the existential branch, since a
  // reported 有 is both (謂其身有異疾: 有 is 謂's complement *and* the
  // existential whose own object takes nothing).
  const quotative = quotativeParticleFor(token, sentence);
  if (quotative) return quotative;

  // …and an *unquoted* one takes を instead, on the 連体形 `decideConjForm`
  // gives it from the same predicate. Ahead of the existential branch below
  // for the reason `isUnquotedSpeechComplement` sets out: 謂其身有異疾's 有 is
  // both an existential and the thing 謂 reports, and the existential rule
  // alone would leave it with no particle at all now that と is withheld.
  if (isUnquotedSpeechComplement(token, sentence)) return "を";

  // Existential 有/無, both halves of it, ahead of the blanket を below —
  // which is what was writing both of the wrong particles in 謂其身有異疾
  // (その身を異疾を有り). See `isExistentialPredicate`.
  //
  // The existent takes nothing. It is what the sentence says exists, not
  // something acted on, and を marks a direct object: 山中有虎 is 虎有り, 曰有之
  // is 之有り. Written as an early `undefined` rather than as a condition on
  // the table below, so it holds whatever the existent's own POS is — 疾/數/虎
  // are nominals and 來/出 (有朋自遠方來, 哇有物出) are verbs, and neither takes
  // one.
  // **Including a clause, which is a rule that was written here and measured
  // out again.** See the note above `inExistentialChain` for what was tried and
  // for what the received readings said to it.
  if (inExistentialChain(token, sentence)) return undefined;
  if (isExistentialLocus(token, sentence)) return "に";

  // What a verb of thinking or intention has in view takes んと — the
  // volitional む plus the quotative と — on the 未然形 `decideConjForm` gives
  // it from the same predicate: 思飲酒 -> 酒を飲まんと思ふ. Ahead of the
  // nominalized-object rule immediately below, which it narrows: the two key
  // on the same relation and this one applies to the smaller class of
  // governor, so it has to answer first or the を would take every one of
  // them. See `isVolitionalComplement`.
  if (isVolitionalComplement(token, sentence)) {
    // **Withheld where a negation closes the clause**, exactly as the object
    // branch just below withholds its を: the 不 is read after the predicate, so
    // an んと written here would land inside the clause — 簪に勝へ**んと**ず.
    // `negationEndingParts`' volitional arm writes it on the 未然形 ざら instead,
    // and 簪に勝へざらんと欲す is what comes out.
    return negationClosing(token, sentence) ? undefined : VOLITIONAL_PARTICLE;
  }

  // A predicate standing in an object slot is nominalized, and takes を on top
  // of the 連体形 `decideConjForm` gives it — 不得飲 -> 飲むを得ず. See
  // `isNominalizedObjectPredicate`, which both halves of the rule share.
  // Below the 如/若 branch above, which supplies に for its own comparative
  // complement (惡酒如仇 -> 仇するに如く) and must not be overridden.
  //
  // **Asked through `closesArgumentChain`**, which is the whole of the
  // coordination fix and stands in front of all four of these rules: the を is
  // decided about the conjunct that carries the relation and written on the one
  // said last, 飲酒食肉 under 得 giving 酒を飲み肉を食ふを得 rather than a を
  // wedged in after 飲む. A clause that is not coordinated is answered by the
  // rule alone, unchanged.
  //
  // **Withheld where a negation closes the clause**, exactly as the oblique and
  // conditional branches below withhold their own に and ば, and this was the
  // one member of the four that was not doing it. A postposed negation is read
  // *after* the predicate, so a particle written here lands inside it: 苦不得飲
  // with 得 on `comp:obj` — which is the label gold gives it, see
  // `isNominalizedObjectPredicate` — printed 飲むを得**を**ず, the object marker
  // wedged between the verb and its own ず. `negationEndingParts` writes it on
  // the 連体形 ざる instead, and 飲むを得ざるを苦しむ is what comes out.
  if (closesArgumentChain(token, sentence, isNominalizedObjectPredicate)) {
    if (negationClosing(token, sentence)) return undefined;
    // **…except under the verbs whose complement is marked に and never を**,
    // which is `DATIVE_OBJECT_LEMMAS` reaching this second slot. That table's
    // claim is about the *verb* and not about what fills its object slot —
    // 觀るに足る stands to 位に足る exactly as 仁に親しむ stands to 賢に親しむ —
    // and until now it was consulted only where the complement is a nominal,
    // so a predicate in the same slot got the blanket を: 斯近信矣 came out
    // 斯く信するを近く where the received reading is 斯に信に近づく.
    //
    // Asked of the governor of the link that actually **bears** the relation,
    // not of this token's own, for the reason `closesArgumentChain` exists: in
    // a coordination the particle is decided about the conjunct carrying the
    // `comp:obj` and written on the one read last. See
    // `nominalizedObjectGovernor`.
    const governor = nominalizedObjectGovernor(token, sentence);
    if (governor && DATIVE_OBJECT_LEMMAS.has(governor.lemma)) return BECOMING_PARTICLE;
    if (governor && DATIVE_PREDICATE_OBJECT_LEMMAS.has(governor.lemma)) return BECOMING_PARTICLE;
    return OBJECT_PARTICLE;
  }

  // …and a predicate standing in a *subject* slot takes こと, on the 連体形
  // the same predicate gives it — 去首半尺 -> 首を去ること半尺. Above the
  // `dep === "subj"` topicalization branches below, which would otherwise
  // claim the same token and mark a whole clause は; those are about a
  // *nominal* subject standing as a dangling topic, and a predicate in that
  // slot is a nominalized clause first. See `isNominalizedSubjectPredicate`.
  //
  // Through `closesArgumentChain` like the object rule above, and this is the
  // slot where that mattered most: the subject rule asks
  // `readsLastInItsSubtree`, so a coordinated clause used to write no こと at
  // all rather than a misplaced one — 治則進，亂則退，伯夷也 is 退く**こと**
  // 伯夷なり.
  //
  // **Withheld where a negation closes the clause**, the third of the four
  // branches to do it and for their one reason: a postposed negation is read
  // after the predicate, so a こと written here would land inside it
  // (知らことず). `negationEndingParts` writes it on the 連体形 ざる instead —
  // 知らざること難し.
  //
  // は in place of こと on a 主之謂 clause — see `subjectNominalizerFor`.
  if (closesArgumentChain(token, sentence, isNominalizedSubjectPredicate)) {
    return negationClosing(token, sentence) ? undefined : subjectNominalizerFor(token, sentence);
  }

  // …and a predicate standing in an *oblique* slot takes に, on the 連体形 the
  // same predicate gives it — 苦不得飲 -> 飲むを得ざるに苦しむ. The third of the
  // trio, beside the object and subject rules above and decided by the one
  // predicate that also decides its form, so the two cannot come apart. Through
  // `closesArgumentChain` like the two of them — 又何如得此樂而樂之 is
  // 此の樂を得てこれを樂しむ**に**如かん, with the に after the second conjunct.
  //
  // Withheld where a negation closes the clause, because the particle would
  // then land in front of the ず rather than after it (得にず). `negationEnding`
  // writes it there instead, on the 連体形 ざる. This is the only branch in this
  // function whose answer is emitted from another token, so it is the only one
  // that has to check.
  if (closesArgumentChain(token, sentence, isNominalizedObliquePredicate)) {
    return negationClosing(token, sentence) ? undefined : OBLIQUE_PARTICLE;
  }

  // …and the predicate a **negated 能** governs takes こと, on the 連体形 the
  // same predicate gives it — 未能信之 is 未だ之を信ずる**こと**能はず. The fourth
  // of the shape, beside the three above and withheld on a closing negation for
  // their one reason. See `isNegatedNengComplement`.
  if (closesArgumentChain(token, sentence, isNegatedNengComplement)) {
    return negationClosing(token, sentence) ? undefined : SUBJECT_NOMINALIZER;
  }

  // …and a predicate heading a conditional protasis takes ば, on the 已然形 the
  // same predicate gives it — 至於他邦，則曰 -> 他邦に至れば、則ち曰く. Written to
  // the trio's shape and standing below them: those three are about a clause
  // filling a *nominal* slot, which is a stronger claim on the same token, and
  // none of their relations overlaps this one anyway.
  //
  // Withheld where a negation closes the clause, for the same reason the
  // oblique branch withholds に: the ば would land in front of the ず (思にば)
  // instead of after it. `negationEnding` writes it there, on the 已然形 ざれ.
  if (isConditionalTemporalClause(token, sentence)) {
    return negationClosing(token, sentence) ? undefined : CONDITIONAL_PARTICLE;
  }

  // Everything below is decided about the *chain head* and written on the
  // member said *last* — 縶手足 is 手足を縶ぐ, not 手を足縶ぐ; 飲食至不能給 is
  // 飲食給するを能はざるに至る, not 飲は食…. **A *predicate* chain is answered the
  // same way and four branches earlier**, by `closesArgumentChain`, which is
  // this block's counterpart for the を/こと/に/が the nominalization rules
  // write: same split — head decides, last member carries — over a walk that
  // admits verbs. Both halves are needed and they are
  // different tokens: a later conjunct's own `conj:coord` is in none of these
  // rules, so asking about this token alone withheld the particle from the very
  // member it belongs on, while the head carries the relation but stands inside
  // the phrase the particle closes.
  //
  // **This used to be `CASE_PARTICLE_FOR_DEP`'s three relations only** — を for
  // `comp:obj`, と for `comp:pred`, に for the obliques — because those are the
  // relations that table holds, and the subject rules below it were asked about
  // the token in front of them. So 縶手足 came out right and 飲食…至 came out
  // 飲は食…, the same particle-inside-its-own-phrase fault one relation over.
  //
  // **What the widening admits, and why those.** The user's rule is "the first
  // of multiple conjoined nouns being a subject, or having any other core
  // dependency". Measured over `lzh-{train,dev,test}.sud.conllu`, the head of a
  // nominal coordination chain of two or more members carries:
  //
  //     comp:obj 8,062 (51.1%)   subj 5,558 (35.2%)   mod 956 (6.1%)
  //     root 678 (4.3%)          comp:pred 172        udep@tmod 134
  //     udep 84                  udep@lmod 38         comp:obl 28
  //     subj@pass 4              comp:aux 2
  //
  // `subj` is the second-largest and was the one core relation not covered —
  // 5,558 chains, more than a third of them. SUD's core relations are `subj`,
  // `comp:obj`, `comp:obl`, `comp:pred` and `comp:aux`; the middle three are
  // already in the table, `comp:aux` (2 chains) is an auxiliary's own
  // complement and takes no particle at all, so **`subj` is the whole of what
  // "any other core dependency" leaves to add** — together with `subj@pass`,
  // listed beside it because it is the same relation on a passive and the
  // parser can return either.
  //
  // The `mod`+`Case=Loc` topic rule below is not a core relation and is widened
  // along with them anyway: it writes the same は onto the same kind of phrase,
  // and a rule that put 手足は right and 手は足 wrong would be the fault this
  // block exists to fix, kept alive one branch further down.
  const chain = NOMINAL_PREDICATE_POS.has(token.pos) ? nominalCoordinationChain(token, sentence) : [token];
  const head = chain[0];
  const carrier = chain.reduce((last, t) => (t.id > last.id ? t : last), head);
  /** The particle this chain takes, or undefined — written only on `carrier`. */
  const onCarrier = (particle: string | undefined): string | undefined =>
    particle !== undefined && carrier.id === token.id ? particle : undefined;
  const headGovernor = head.id === token.id ? governor : sentence.tokens.find((t) => t.id === head.head);

  if (NOMINAL_PREDICATE_POS.has(token.pos)) {
    // `comp:pred` is the one relation in the table whose answer depends on the
    // governor: と under the copula 爲 and under the comparison 如/奈, に under
    // a verb of becoming or arriving. Asked of the *chain head's* governor,
    // which is the one the relation belongs to, exactly as the table lookup is
    // keyed on the chain head's own dep. See `predicativeComplementParticle`.
    //
    // …and **nothing at all where the governor is a pinned copula**. The reader
    // saying a character is the 断定の助動詞 (`chosenAuxiliary`) makes it the very
    // particle this branch would otherwise write: 其為仁之本與 with `Reading=たり`
    // on the 爲 and 本 as its `comp:pred` puts the copula after the complement in
    // reading order — 其れ仁の本なるや — and a case particle in front of it gave
    // 本**に**なるや, a becoming-verb's に and a copula asserted of one noun.
    // It is the same claim `hasExplicitCopulaParticle` makes for a 也 and
    // `negatedNominalPredicate` for a 非: where the copula is already written,
    // the nominal in front of it needs nothing.
    //
    // Reaches no gold token — a pin exists only in a reader's own file — and is
    // written on the pin rather than on the copula class the treebank marks
    // (`COPULA_XPOS`/`VerbType=Cop`, 2,788 爲) deliberately: that class is
    // overwhelmingly 〜と爲る, "came to serve as" (三仕為令尹, 子游為武城宰), and
    // `predicativeComplementParticle`'s と is right for it.
    // **The verbs whose one complement is marked に and never を**, ahead of
    // the table lookup below, which would give every `comp:obj` a blanket を.
    // See `DATIVE_OBJECT_LEMMAS`.
    if (head.dep === "comp:obj" && headGovernor && DATIVE_OBJECT_LEMMAS.has(headGovernor.lemma)) {
      return onCarrier(BECOMING_PARTICLE);
    }

    // **謂's nominal complement is named, not acted on, and takes と** —
    // 可謂孝矣 is 孝**と**謂ふ可し, 可謂士矣 is 士**と**謂ふ可し. The same claim
    // `namingComplementParticle` makes for 曰/云, made here for the third verb
    // of the group and made in the particle table rather than in that function
    // because that function's other caller (`isNamingUse`) is about 曰's own
    // 曰はく/曰ふ split and has no business with 謂.
    //
    // **Counted in the received reading**: over kanbun.info's 書き下し文 the
    // particle written immediately before 謂 is と **200** times against を 35,
    // and the を is the *other* slot in the same frame — 是を過ちと謂ふ, where
    // 是 is what is being named and 過ち is the name. So the rule is held to a
    // NOUN/PROPN complement and stands down for a pronoun, which is what that
    // slot is filled with. Worth 2 gold edits and 82 parsed ones.
    if (head.dep === "comp:obj" && token.pos !== "PRON" && headGovernor && headGovernor.lemma === "謂") {
      return onCarrier(PREDICATIVE_PARTICLE);
    }

    // **And where the chain head is a quotation rather than an argument, the
    // chain takes nothing.** 子曰：「巧言令色，鮮矣仁」！ is 言 standing `comp:obj`
    // of 曰 with 色 coordinated onto it, so the を this table gives a `comp:obj`
    // was resolved off the head and written on the carrier: 「巧言令色**を**、
    // 鮮なし仁」と.
    //
    // Asked of the **head** and not of the carrier, because it is the head
    // that bears the relation this table is reading — the carrier's own dep is
    // `conj:coord` and says nothing about the frame. That is the same
    // asymmetry every branch in this block is built on, and the reason the two
    // guards already added upstream (`isSpeechComplement` and
    // `namingComplementParticle`, both of which now ask
    // `isSpeechQuoteComplement`) could not reach this token: they are asked of
    // the token whose particle is being written, and here that token is 色,
    // whose governor is 言 and not a verb of speech at all.
    if (
      headGovernor &&
      isSpeechQuoteComplement(
        head,
        { lemma: headGovernor.lemma, xpos: headGovernor.xpos, dep: headGovernor.dep },
        sentence,
      )
    ) {
      return undefined;
    }

    const particle =
      head.dep === "comp:pred"
        ? headGovernor && chosenAuxiliary(headGovernor) === COPULA
          ? undefined
          : predicativeComplementParticle(headGovernor)
        : isBareTimeAdverbial(head, sentence)
          ? undefined
          : CASE_PARTICLE_FOR_DEP[head.dep];
    if (particle) return onCarrier(particle);
  }

  // A noun resumed by a demonstrative pronoun is dislocated, and a dislocated
  // topic takes は — 蟲是劉之福 is 蟲**は**是れ劉の福. Ahead of every other
  // subject branch because it is the most specific of them: it is decided by
  // what stands next to this token rather than by anything about the clause,
  // and where it fires the topic marking is not a guess. See
  // `resumedByDemonstrative`.
  if (resumedByDemonstrative(head, sentence)) return onCarrier(TOPIC_PARTICLE);

  // A subject inside the clause an existential asserts takes の, not は —
  // 有朋自遠方來 is 朋**の**遠方より來る有り. Written on the chain carrier like
  // every other particle here, so a coordinated subject takes it once, after
  // the whole phrase. See `inAttributiveClause` for the bound and for the four
  // wider rules measured beside it and not shipped.
  if (
    NOMINAL_PREDICATE_POS.has(token.pos) &&
    (head.dep === "subj" || head.dep === "subj@pass") &&
    headGovernor &&
    inAttributiveClause(headGovernor, head, sentence)
  ) {
    return onCarrier(SUBORDINATE_SUBJECT_PARTICLE);
  }

  if (head.dep === "subj" || head.dep === "subj@pass") {
    const root = findRoot(sentence);
    // **The table lookup, minus 能.** 能's entry in `AUXILIARY_LEMMAS` exists
    // for the pin alone — the character's own two words are 能く and 能はず, see
    // the note on that entry — so a 能-rooted clause is not what this branch is
    // about, and the bare lookup went on writing は for all 149 of them at a
    // cost of 61 edits.
    //
    // **Narrowed to that one lemma and not replaced by `auxiliaryFormFor`**,
    // which was tried and is the wrong test here even though it is the right
    // test for the *ending*: it declines a 遣 that governs no predicate, and
    // 武帝遣使 is 武帝**は**使を遣はす all the same. What this branch reads off the
    // table is that the clause's predicate is one of these characters, not that
    // this occurrence inflects as an auxiliary. A **pinned** 能 is the
    // auxiliary, though, and gets its は back with everything else the pin
    // restores — see `isAuxiliaryRootForTopic`.
    if (root && isAuxiliaryRootForTopic(root) && root.lemma in AUXILIARY_LEMMAS) return onCarrier("は");

    const alreadyHasItsOwnTopic = sentence.tokens.some(
      (t) => t.head === head.id && t.dep === "mod" && parseMorphFeatures(t.morph ?? "").Case === "Loc",
    );
    if (isTopicalizedAdjective(head, sentence) && !alreadyHasItsOwnTopic) return onCarrier("は");
  }

  if (head.dep === "mod" && parseMorphFeatures(head.morph ?? "").Case === "Loc" && headGovernor?.dep === "subj") {
    return onCarrier("は");
  }

  // d. A `subj` whose own governor is itself introduced as a Case:Loc
  //    complement of some further predicate (曲, subj of a nested 中 that is
  //    comp:obj+Case=Loc of 爲 — 其曲中規, "its curving conforms to the
  //    compass") reads as a de-facto independent statement despite that
  //    nominal embedding, the same way pattern b's dangling topic does —
  //    その曲は規を中る, not bare その曲. Distinct from pattern b (which keys
  //    off the *mod* token's own Case:Loc) — here it's the subj's *governor*
  //    that carries it, because the governor is the whole embedded clause,
  //    not a modifier of one.
  if (
    (head.dep === "subj" || head.dep === "subj@pass") &&
    headGovernor?.dep === "comp:obj" &&
    parseMorphFeatures(headGovernor.morph ?? "").Case === "Loc"
  ) {
    return onCarrier("は");
  }

  return undefined;
}

/** True for 中 used verbally ("to hit, to conform to") but mistagged NOUN by
 * the parser — 其曲中規 -> ...規を中る, not bare 中を with no conjugation at
 * all. Scoped to this one lemma rather than a blanket NOUN/VERB override,
 * since 中 as a genuine NOUN ("middle") is very common elsewhere and must
 * *not* conjugate.
 *
 * **The xpos is what tells the two uses apart, and the dep+morph signature
 * alone did not.** That signature — `comp:obj` carrying `Case=Loc` — was
 * described here as "itself a further predicate's locative complement", and
 * the description was doing work the test was not: an *adposition's* object
 * wears exactly the same signature, and 酒蟲's 但令於日中俯臥 (sent_id 20) is
 * that shape. 中 there is the `comp:obj` of 於, carrying `Case=Loc`, and it is
 * the plain noun "middle" — 日中, "in the daytime" — which is precisely the
 * genuine NOUN this predicate's own doc says must not conjugate. It was
 * conjugating: 日の中る, a verb inside a prepositional phrase.
 *
 * The treebank settles it in the column the UPOS tag is wrong in. Measured:
 * 其曲中規's 中 comes back xpos `v,動詞,行為,動作` — a verb — while
 * 但令於日中's comes back `n,名詞,固定物,関係`, a noun of place. Both are UPOS
 * NOUN, which is why this predicate exists at all; the fine-grained tag
 * disagrees with the coarse one in the first case and agrees in the second,
 * and that disagreement *is* the mis-tagging this is named for.
 *
 * `isVerbalXpos` is the same tie-breaker `isNominalizedObjectPredicate` and
 * `isNominalizedSubjectPredicate` already spend on the same question (a noun
 * the parser tagged VERB), read here in the other direction — and, like them,
 * it trusts the UPOS where a tree carries no xpos at all, so a hand-written
 * tree behaves as it did before. Asked of the token alone, deliberately: the
 * two panels share this predicate through `usesLexiconEntry`, which takes no
 * sentence, and a fix needing one would have had to be passed to only one of
 * them. */
export function isMistaggedLocativeVerb(token: Token): boolean {
  return (
    token.lemma === "中" &&
    token.dep === "comp:obj" &&
    isVerbalXpos(token) &&
    parseMorphFeatures(token.morph ?? "").Case === "Loc"
  );
}

/** A VERB_LEXICON word used adverbially before a further verb (博學而日參
 * 省乎己's 博/參) is tagged ADV, not VERB, by this parser — but its own
 * VerbForm=Conv morph is an unambiguous, general signal (not tied to any
 * one lemma) that it still needs real conjugation, not the bare kanjidic
 * citation form the generic fallback path would give it. General (any
 * lemma), unlike the other POS-override predicates above, since VerbForm=
 * Conv is exactly the treebank's own "this is being used as a converb"
 * marker regardless of which word carries it. */
export function isConverbUse(token: Token): boolean {
  return parseMorphFeatures(token.morph ?? "").VerbForm === "Conv";
}

/** 曲 as the `subj` of a Case:Loc-embedded clause (see pattern d above,
 * その曲は規を中る) is tagged NOUN, but it's really the rentai form of 曲がる
 * used *without* an explicit こと/もの nominalizer — a headless nominalized
 * clause (a well-attested classical pattern: rentai standing directly as a
 * clause's topic/subject, e.g. 言ふは易く). Its own conjugated form (rentai
 * happens to be identical to shuushi for yodan-ra: る either way) still
 * needs VERB_LEXICON's real conjugation machinery, not kanjidic's bare
 * citation-form okurigana — so this is a POS override, not a different
 * okurigana. */
export function isNominalizedVerbClause(token: Token): boolean {
  return token.lemma === "曲" && token.pos === "NOUN" && token.dep === "subj";
}

/** 過 in a Degree=Pos, nominal "fault/error" use (無過, "without fault") is
 * the NOUN 過ち — not any of VERB_LEXICON's extracted verb senses for this
 * lemma (過ぎる/過ごす/過つ; kanjidic's own kun'yomi list has the identical
 * problem, listing only those same verb senses, never the noun). Excluded
 * from the lexicon dispatch (see its two call sites) so it falls through to
 * `readingResolver.ts`'s own dedicated reading for it instead. Scoped to
 * this one lemma+morph signature, not the POS tag alone — 過 as a genuine
 * action verb (VERB, no Degree=Pos) elsewhere is exactly what VERB_LEXICON's
 * entry is for. */
export function isNominalizedFaultNoun(token: Token): boolean {
  return token.lemma === "過" && parseMorphFeatures(token.morph ?? "").Degree === "Pos";
}

/** Whether this use of the token is the verb/adjective/copula use a
 * `VERB_LEXICON` entry stands for — the POS gate the three lexicon dispatches
 * share (`generator.ts`'s, `KundokuView.ts`'s okurigana branch, and
 * `furiganaFor`'s reading branch).
 *
 * An entry represents that lemma's *conjugating* sense specifically, not
 * every use of the character: 青/寒 are also plain NOUNs (the colour or the
 * condition as a substance, 青 as subj of 取之於藍) where conjugating them
 * would be wrong — 青 bare, never 青し. AUX joins VERB for 爲/為's copula-like
 * "becomes X" use, which this parser tags AUX; the three predicates above
 * join them for the POS tags this parser gets wrong in a recognisable way;
 * and `isNominalizedFaultNoun` takes 過's nominal sense back out again.
 *
 * **ADJ joins VERB under parser 0.3.2, and this is the single site the
 * recoding would have cost the most.** The lexicon's adjective senses are the
 * whole point of its ク活用/シク活用 classes — 198 of its 1,285 lemmas hold one
 * (痛 いたし, 重 おもし, 易 やすし) — and every token they are for is a stative
 * predicate, which is exactly the class 0.3.2 moved off VERB. Measured over
 * the recoded gold: of its **22,368** ADJ tokens **13,859** have a
 * `VERB_LEXICON` entry and **10,163** have an adjective sense in it. Left as
 * VERB/AUX this gate would have refused all 13,859, and both panels would
 * have fallen through to the resolver for words the lexicon speaks for —
 * silently, since a refused gate reads as "no entry" and not as an error.
 * See `isContentPredicatePos` for why that direction is the dangerous one.
 *
 * One function rather than a condition written out at each site, because the
 * three sites are answering the same question about the same token and any
 * drift between them is visible as the two panels disagreeing about a
 * character. That is not hypothetical: the reading branch was missing this
 * gate entirely, so a mis-tagged PROPN (this parser tags 縛/驚/覺/解 that way)
 * took a lexicon reading in the prose gloss and the resolver's on'yomi in the
 * 訓読文 — 縛 glossed しば beside a ruby reading ばく. A parser error belongs on
 * screen, the same error in both panels, not silently patched out of one of
 * them by a lookup the other one refuses.
 *
 * **A postposed predicate negation joins them** (`isPredicateNegationPostpose`).
 * The existential 無/无/罔/靡 already came in through `isConverbUse`, since all
 * 489 ADV tokens of that class carry `VerbForm=Conv`; the 莫 the treebank files
 * as `v,副詞,否定,禁止` carries none, so it printed no ending at all — 知る莫,
 * 能く莫陷る — where kanbun.info writes 莫し 75 times, 莫く 23 and 莫き 14, the
 * ク活用 paradigm the lexicon already holds for it. See
 * `lexiconNegationExcluded` for the one lemma of the class left out. */
export function usesLexiconEntry(token: Token): boolean {
  return (
    (isContentPredicatePos(token.pos) ||
      token.pos === "AUX" ||
      isMistaggedLocativeVerb(token) ||
      isNominalizedVerbClause(token) ||
      isConverbUse(token) ||
      (isPredicateNegationPostpose(token) && !lexiconNegationExcluded(token))) &&
    !isNominalizedFaultNoun(token)
  );
}

/** **毋 stays out of `usesLexiconEntry`**, though it is in the class and shares
 * the xpos of 莫. It is the prohibitive, and where it closes a clause the
 * received reading is its 命令形: kanbun.info writes 毋かれ 11 times against
 * 毋し once. The lexicon entry would conjugate it as the plain adjective and
 * write 毋し there, and over the 28 passages holding 毋/无/罔/靡/無能/無敢 that
 * came out even (5 closer, 6 further, four of the six a 毋かれ written 毋し or
 * 毋き). Choosing the 命令形 is a question about mood that nothing here
 * asks yet, so 毋 keeps the bare reading its override gives it until something
 * does. */
function lexiconNegationExcluded(token: Token): boolean {
  return token.lemma === "毋";
}

/** The XPOS this treebank gives a *bound suffix*, as against the tag it gives
 * the same character standing on its own. It is the whole discriminator for
 * the タリ rule below, and it is a clean one: across the three SUD Kyoto
 * splits, 然 carries `v,動詞,描写,態度` in all 1,470 of its adverbial and
 * verbal uses and `p,接尾辞,*,*` in all 430 of its suffix uses, with no
 * overlap in either direction. */
const SUFFIX_XPOS = "p,接尾辞,*,*";

/** Characters read as タリ活用形容動詞 suffixes — the second half of a
 * Sino-Japanese binom describing a manner or state (愕然 ガクゼン, 突如 トツジョ,
 * 莞爾 カンジ), which takes たり/たる/と rather than any ending of its own.
 *
 * Chosen from a full enumeration of `SUFFIX_XPOS` over lzh-train/dev/test in
 * `assets_sud`, not from intuition. Every character that carries that tag,
 * with its count: 然 430, 乎 102, 如 76, 兮 42, 焉 36, 爾 13, 尔 13, 若 4,
 * 斯 4, 子 4, 甫 2, 諸 1, 诸 1. Five are admitted here and the rest are held
 * out, each for a reason the counts state:
 *
 *  - **兮** is the 楚辞 line-particle. All 42 have their head two or more
 *    tokens away — not one is adjacent to the word it would suffix — so
 *    whatever the tag says, this is not a bound suffix.
 *  - **若 (4), 斯 (4), 子 (4), 甫 (2), 諸/诸 (1 each)** are too few to
 *    generalise from, and what they are is visible: 箚子/册子 and 章甫 are
 *    nouns, 言斯/栗斯 are 詩經 line-particles.
 *  - **尔** is 爾's simplified form and the app's KANJIDIC index has no entry
 *    for it, so no on'yomi could be produced for it (see
 *    `tariSuffixReading`); it is left out rather than admitted to decline.
 *
 * **乎 and 焉 were held out and are now in**, and what let them in was
 * settling two separate objections from the corpus rather than from intuition:
 *
 *  - *That the tag would be overruled by position.* Both are in
 *    `SENTENCE_FINAL_PARTICLES`, whose branch both panels take ahead of the
 *    lexicon dispatch this rule feeds, and 34 of 乎's 102 suffix-tagged tokens
 *    and 10 of 焉's 36 stand last. That is settled where it arises, in
 *    `isSentenceFinalParticleUse`: a suffix with a stem is not the particle,
 *    last or not, so the tag decides and the position no longer does. The
 *    particle still wins outright wherever the parser says `discourse`/
 *    `discourse@sp` — which is what 不亦說乎's 乎 is, and is 1792 of the 2440
 *    乎 in the corpus against these 102.
 *  - *That 乎's own commonest bigrams are not 形容動詞.* True, and the two are
 *    separable on the stem's tag alone. 嗟乎 (20), 於乎 (1) and 于乎 (1) have
 *    an INTJ `p,感嘆詞,*,*` stem, which `TARI_STEM_POS` already refuses;
 *    惡乎/恶乎 (14) have the interrogative-adverb stem `v,副詞,疑問,所在`,
 *    which `tariSuffixGroup` now refuses (see `INTERROGATIVE_STEM_FIELD`).
 *    Between them, and with the 8 `discourse@sp` and 2 `root` rows that the
 *    `dep === "unk"` test already dropped, that is 46 of the 102 out — and
 *    every one of the 56 that remain is a descriptive binom: 巍乎 8, 洋乎 8,
 *    忽乎 4, 蕩/荡乎 3, 郁乎 2, 怨乎 2, 堂乎 2, 皜乎 2, 岌乎 2, 善乎 2, 洞乎 2,
 *    愉乎 2, and singletons of the same shape (煥乎, 頹乎, 頎乎, 纍乎, 硜乎).
 *    焉 needed neither guard: all 36 are `unk`, every stem is
 *    描写/行為/固定物/変化/時相, and none is interrogative or exclamatory —
 *    忽焉, 慨焉, 悵焉, 愾焉, 儳焉, 俛焉, 惚焉, 皇焉, 洋焉, 圉焉.
 *
 * The 疑問 and 感嘆詞 stems are peculiar to 乎: across all five admitted
 * characters those 14 惡乎 are the only interrogative stems and those 22 the
 * only exclamatory ones, so neither guard changes anything for 然/如/爾/焉.
 *
 * The five cover 611 of the 654 suffix-tagged tokens, and their adjacent
 * bigrams are the paradigm cases: 喟然, 慨然, 忿然, 愕然, 茫然, 卒然; 勃如,
 * 躩如, 翕如; 莞爾, 率爾, 鏗爾. JMdict independently files 愕然, 突如, 莞爾,
 * 卒然, 躍如 and the rest as `'taru' adjective` — corroboration, and
 * deliberately *not* a condition (see `tariSuffixReading`). */
export const TARI_SUFFIX_CHARS: ReadonlySet<string> = new Set(["然", "如", "爾", "乎", "焉"]);

/** POS tags a タリ suffix may attach to. Read off the same survey: the token
 * immediately before a suffix-tagged 然 is VERB 290 / ADV 128 / NOUN 8 (and
 * PUNCT 4 — the clause-initial 然 excluded by the `unk` test below); before
 * 如, VERB 68 / NOUN 6; before 爾, VERB 12 / ADV 1; before 乎, VERB 48 /
 * INTJ 22 / ADV 20 / NOUN 8 / ADP 2; before 焉, VERB 24 / ADV 8 / NOUN 4.
 * PROPN and ADJ ride along as the tags this parser uses for the same
 * descriptive words elsewhere.
 *
 * **INTJ and ADP are the exclusions that do work**, and both are 乎's: the
 * INTJ rows are 嗟乎 (20), 於乎 (1) and 于乎 (1), all tagged
 * `p,感嘆詞,*,*` — 嗟乎 is ああ, an exclamation followed by its particle and
 * not a binom at all — and the ADP rows are the preposition 為/为 before a
 * `discourse@sp` 乎. Those 22 exclamatory stems are the only ones standing
 * before any suffix-tagged character in the corpus, so this exclusion is
 * about 乎 and nothing else. */
const TARI_STEM_POS: ReadonlySet<string> = new Set(["VERB", "ADV", "NOUN", "PROPN", "ADJ"]);

/** The XPOS subcategory (the third comma-separated field) this treebank gives
 * an *interrogative* — 惡/恶 as `v,副詞,疑問,所在`, "where/how".
 *
 * A suffix character after one of these is closing an interrogative phrase,
 * not a descriptive binom: 惡乎 is いづくにか ("wherein?"), and the 14 tokens of
 * it are the second half of why 乎 could not simply be admitted on its tag.
 * They are also the only 疑問 stems standing before any suffix-tagged
 * character in the whole corpus — every other admitted stem is
 * 描写/行為/変化/固定物/時相/存在/人/頻度/可搬/不可譲 — so this refuses exactly
 * 惡乎/恶乎 and touches nothing else.
 *
 * Read as a field of the XPOS rather than as a lemma test, for the reason
 * `SUFFIX_XPOS` itself is: the same character is a perfectly ordinary word
 * elsewhere (惡 is also あし, "bad", tagged `v,動詞,描写,態度`), and it is the
 * tag and not the character that says which use this is. */
const INTERROGATIVE_STEM_FIELD = "疑問";

function isInterrogativeStem(stem: Token): boolean {
  return stem.xpos.split(",")[2] === INTERROGATIVE_STEM_FIELD;
}

/** Whether `token` is a タリ suffix — the second half of one of these binoms,
 * as against the same character used as a word.
 *
 * `dep === "unk"` stands beside the XPOS test rather than being implied by it,
 * and it earns its place on four tokens: of the 430 suffix-tagged 然, 426 are
 * `unk` and 4 are `mod`, and those 4 are all the *clause-initial* 然 of
 * 收恢台之孟夏兮，然欿傺而沈藏 — a 然 that stands after a comma and heads what
 * follows (its head is the token *after* it, not before), which is しかれども
 * and not a suffix at all. The XPOS alone would have made a suffix of it. The
 * same test also holds off 兮's and 乎's `discourse@sp` uses and 斯's
 * `conj:coord` ones, though those characters are already out of the set.
 *
 * Token-only, so both panels' lexicon dispatch can ask it without a sentence
 * in hand; whether the suffix has a stem to attach to is `tariSuffixGroup`'s
 * question. */
export function isTariSuffix(token: Token): boolean {
  return (
    token.pos === "PART" && token.xpos === SUFFIX_XPOS && token.dep === "unk" && TARI_SUFFIX_CHARS.has(token.text)
  );
}

/** The stem+suffix group `token` belongs to, from either end, or null.
 *
 * **Source adjacency, not the dependency edge.** The suffix's own head is
 * unusable: in the reader's own 劉愕然、便求醫療 the parser hangs 然 off 劉 —
 * the surname two tokens away — not off the 愕 it suffixes. The corpus says
 * adjacency is the reliable signal instead: 374 of the 430 suffix-tagged 然
 * have their head immediately before them, and in every one of the 56 that do
 * not, the token immediately before is still the stem — the second half of a
 * reduplication (循循然, 望望然, 由由然), attached by `compound@redup` to the
 * first. Reading backwards one token gets the stem in both shapes; reading the
 * head edge gets it in neither of the second. */
export function tariSuffixGroup(token: Token, sentence: { tokens: Token[] }): { stem: Token; suffix: Token } | null {
  const byId = new Map(sentence.tokens.map((t) => [t.id, t]));
  const pair = (suffix: Token): { stem: Token; suffix: Token } | null => {
    const stem = byId.get(suffix.id - 1);
    if (!stem || !TARI_STEM_POS.has(stem.pos) || stem.dep === "punct") return null;
    // 惡乎 is いづくにか and not a binom — see `INTERROGATIVE_STEM_FIELD`. The
    // companion exclusion, 嗟乎's exclamatory 嗟, is `TARI_STEM_POS`'s own
    // (INTJ is not in it) and needs nothing here.
    if (isInterrogativeStem(stem)) return null;
    return { stem, suffix };
  };
  if (isTariSuffix(token)) return pair(token);
  const next = byId.get(token.id + 1);
  if (next && isTariSuffix(next)) {
    const group = pair(next);
    return group && group.stem.id === token.id ? group : null;
  }
  return null;
}

/** The token whose syntactic role decides which *form* an ending written on
 * `token` takes. Itself, for all but one case.
 *
 * A タリ suffix is the exception, and it is the same split `compoundSuruOkurigana`
 * makes over a fused span: the ending is *written* on the last member and the
 * relation it expresses belongs to the member holding the group onto the
 * sentence. 然 hangs off its own stem, so every rule in `decideConjForm` that
 * reads the token's head — a 者 or 所 ahead of it, a genitive 之, a 耳 closing
 * it — saw 愕 where it needed the clause, and 愕然者 came out 愕然たりもの
 * instead of 愕然たる者. Asking the stem instead puts the group's real relation
 * to the sentence in front of those rules.
 *
 * Only the subject of the question moves. What follows in reading order stays
 * the *suffix's* neighbour, since that is where the ending is written and what
 * a negation or a 而 has to land against — `decideConjForm`'s other argument,
 * which the callers go on passing unchanged. */
export function conjugationSubject(token: Token, sentence: { tokens: Token[] }): Token {
  if (!isTariSuffix(token)) return token;
  return tariSuffixGroup(token, sentence)?.stem ?? token;
}

/** The `LexiconEntry` a token conjugates by: the one the syntax chose where it
 * stood the lexicon down, and `VERB_LEXICON`'s otherwise.
 *
 * Both panels ask this and neither restates it — `generator.ts`'s branch and
 * `KundokuView.ts`'s okurigana branch held the identical ternary, and the two
 * quietly disagreeing about one character is the failure this codebase guards
 * hardest against.
 *
 * A タリ suffix is dispatched here on `isTariSuffix` rather than on
 * `usesLexiconEntry`, and its `VERB_LEXICON` arm is closed. The lexicon holds
 * 然 as ラ変 しか (the standalone word 然り) and 爾 the same way, and that is
 * the *other* use of the character — the very one the suffix tag distinguishes
 * it from. Admitting the suffix through the ordinary gate would have printed
 * 愕然り wherever the resolver declined to claim the group. The class a suffix
 * takes belongs to the binom it closes, so it can only come from the resolver,
 * which is the one thing here that has seen both halves. */
export function lexiconEntryFor(
  token: Token,
  resolved: { beatsLexicon?: boolean; conjClass?: ConjClass; reading?: string; okurigana?: string; okuriganaForm?: ConjForm },
  /** The sentence, for the one entry that is chosen by syntax rather than by
   * lemma — a *positive* comparison 如/若 is ごとし and a negated one is 如く,
   * and only a negation standing on the token says which. Optional so that a
   * caller with no sentence in hand behaves exactly as it did before there was
   * a comparison arm; see `comparisonLexiconEntry`. */
  sentence?: { tokens: Token[] },
): LexiconEntry | undefined {
  if (isTariSuffix(token)) {
    return resolved.beatsLexicon ? syntheticLexiconEntry(resolved, token.lemma) : undefined;
  }
  if (!usesLexiconEntry(token)) return undefined;
  const comparison = sentence && comparisonLexiconEntry(token, sentence);
  if (comparison) return comparison;
  // …and the same arrangement for the other entry the lemma alone cannot
  // supply: 以 is もつてす where it predicates and もつて where it modifies, and
  // only the relation says which. See `predicateYiLexiconEntry`.
  const predicateYi = sentence && predicateYiLexiconEntry(token, sentence);
  if (predicateYi) return predicateYi;
  const entry = resolved.beatsLexicon ? syntheticLexiconEntry(resolved, token.lemma) : VERB_LEXICON[token.lemma];
  // …and the one entry *built on* the lemma's entry rather than chosen in its
  // place: an adjective with an object is its own 連用形 plus す. See
  // `factitiveAdjectiveLexiconEntry`.
  return (sentence && factitiveAdjectiveLexiconEntry(token, entry, sentence)) ?? entry;
}

/** The dependents an adjective's object can be: a word that names a thing. A
 * `comp:obj` of any other category on an ADJ is a complement clause (難 over
 * 養 in 爲難養 is 養ひ難し) or a parse artefact, and the adjective makes
 * nothing of either. */
const FACTITIVE_OBJECT_POS: ReadonlySet<string> = new Set(["NOUN", "PRON", "PROPN"]);

/** The adjectives this rule is stated for — the ones whose くす reading the
 * received text attests and whose rendering it measurably improves. See
 * `factitiveAdjectiveLexiconEntry` for the counts and for the adjectives that
 * are left out. */
const FACTITIVE_ADJECTIVE_LEMMAS: ReadonlySet<string> = new Set(["同", "久", "厚", "美", "鋭", "空"]);

/** **形容詞連用形 + す: an adjective with a direct object means "to make it so".**
 *
 * 不可同世而立 is 世を同じくして立つ可からず; 同其塵 其の塵を同じくす; 同天下之利者
 * 天下の利を同じくする者; 趙見我走、必空壁逐我 壁を空しくして. The ク/シク
 * adjective takes its 連用形, サ変 す is written after it, and from there the
 * word is a サ変 verb in every cell the sentence asks for — 同じくせず, 同じくすれば
 * (而同三軍之任), 同じくする者. The app had no rule for the shape at all, so the
 * adjective went on inflecting as a predicate of state with an accusative in
 * front of it: 世を同じ, 任を同じば.
 *
 * **Why a list of adjectives, and not every ADJ with an object.** Over the
 * kanbun.info corpus parses **687** ADJ tokens carry a `comp:obj` dependent.
 * Aligned to the received 書き下し文 where the character stands once in both
 * texts, 64 read 連用形 + す and 55 read 形容動詞 + にす (其の勇を明らかにす);
 * the rest read a verb of the character's own — 貴ぶ, 重んず, 輕んず, 遠ざく,
 * 近づく, 正す — or are parse artefacts in which the "object" is really the
 * adjective's subject (多怨 is 怨み多し, 衆草多障者 衆草の障多き者) or a
 * に-phrase (近道 道に近し). The rule was measured first with no list, over the
 * 309 passages holding an ADJ-with-object whose entry is ク/シク: **46 better,
 * 56 worse, 11,493 → 11,500 edits**. The losses are those three shapes, and
 * they fall on 多 (12 passages), 近 (7), 遠, 輕, 難, 長, 堅, 乏 and 寒, where the
 * parse cannot tell an object from a subject or a verb reading is what the
 * received text wants. So the rule is stated for the adjectives whose くす is
 * attested in the received prose and which it improves:
 *
 * | lemma | received                                   | probe (passages) |
 * |-------|--------------------------------------------|------------------|
 * | 同    | 同じくす 21 · 同じくし 14 · 同じくせ 5 · 同じうす/うし 11 | the bulk of the gain |
 * | 久    | 久しくす 2 · 久しくせ 2 · 久しうす 1         | 3 better, 1 worse |
 * | 厚    | 厚くす 2 · 厚くせ 4 · 厚くし 2               | 2 better, 1 worse |
 * | 美    | 美くす 2                                    | 3 better, 2 worse |
 * | 鋭    | 鋭くす 2                                    | 1 better         |
 * | 空    | 空しくして 4 (空壁)                          | 4 better         |
 *
 * The entry's class is still asked as well: a lemma the reading layer has taken
 * to a verb (`beatsLexicon`) comes back with that verb's entry, and a verb
 * with an object needs nothing from here.
 *
 * **An object is a nominal by POS or by xpos.** lzh_sud_kyoto 0.3.3 returns
 * the 世 of 不可同世而立 as VERB with the nominal xpos `n,名詞,制度,場`, so a POS
 * test alone misses the very sentence the fault was reported on; over the
 * corpus that mismatch is 9 of the 687 objects (VERB 3, ADJ 6).
 *
 * **Written as an entry rather than as a form**, for the reason `PREDICATE_YI`
 * is: both panels reach it through `lexiconEntryFor`, the 連用形 rides in
 * `okuriganaPrefix` the way the て of 以てす does, and `decideConjForm` chooses
 * the サ変 cell with every rule it already has. The adjective's 連用形 is taken
 * from its own entry by `conjugatedOkurigana`, so a stem prefix (同じく)
 * comes along with it. */
function factitiveAdjectiveLexiconEntry(
  token: Token,
  entry: LexiconEntry | undefined,
  sentence: { tokens: Token[] },
): LexiconEntry | undefined {
  if (token.pos !== "ADJ" || !FACTITIVE_ADJECTIVE_LEMMAS.has(token.lemma)) return undefined;
  if (entry?.conjClass !== "ku-keiyoushi" && entry?.conjClass !== "shiku-keiyoushi") return undefined;
  const hasObject = sentence.tokens.some(
    (t) =>
      t.head === token.id &&
      t.id !== token.id &&
      t.dep === "comp:obj" &&
      (FACTITIVE_OBJECT_POS.has(t.pos) || (t.xpos ?? "").startsWith("n,")),
  );
  if (!hasObject) return undefined;
  return { conjClass: "sa-hen", okuriganaPrefix: conjugatedOkurigana(entry, "renyou"), reading: entry.reading };
}

/** **ごとし — the ク活用 paradigm a *positive* comparison 如/若 inflects by**, and
 * the one entry in this file that `VERB_LEXICON` cannot supply because the
 * lemma alone does not identify the word.
 *
 * 如 is two verbs, and the lexicon holds only one of them. `VERB_LEXICON["如"]`
 * is `yodan-ka` + し — 如**く**, "to come up to", the verb of 不如/莫如 — and
 * it was being applied to every 如, comparison included. The two paradigms are
 * very nearly each other's mirror, which is why the damage was invisible:
 *
 * | form | 四段カ行 as shipped | ク活用 as it should be |
 * |------|--------------------|----------------------|
 * | 連用形 | 如**き**            | 如**く** (ごとく)      |
 * | 終止形 | 如**く**            | 如**し** (ごとし)      |
 * | 連体形 | 如**く**            | 如**き** (ごとき)      |
 *
 * So 蠕動如游魚 — where `decideConjForm` has always correctly answered 連用形,
 * 如 being a non-final conjunct with 備 coordinated onto it — printed 游魚の如
 * **き**, and 劉自是惡酒如仇, where the same function answers 終止形, printed
 * 仇の如**く**. Each was the other's form. Nothing in `decideConjForm` was
 * wrong and no rule there needed changing; the paradigm underneath it was the
 * wrong word's.
 *
 * **The split is the negation, and it is the split `caseParticleFor` already
 * makes** for the same two characters one decision over — `hasComparativeNegation`
 * is asked here rather than restated, so the paradigm and the case particle
 * cannot come apart about which 如 this is. A positive 如 is ごとし and its
 * standard takes **の** (游魚のごとし); a negated one is 如く and its standard
 * takes **に** (之を好む者に如かず), which is `COMPARATIVE_NEGATION_LEMMAS`' own
 * branch and is left exactly as it stands.
 *
 * **Measured** over `lzh_kyoto-sud-{train,dev,test}`: 如/若 used as a comparison
 * (`Degree=Equ`, or the XPOS `v,動詞,行為,分類` beside it — see `isComparativeYu`)
 * is 1,671 tokens, **1,296 of them positive** and 375 negated. So the lexicon's
 * single 四段 entry was speaking for 22% of the comparisons and being applied to
 * all of them.
 *
 * **Written as an entry rather than as a reading**, which is what puts it on
 * the ordinary conjugation pipeline instead of around it: both panels reach it
 * through `lexiconEntryFor`, conjugate it with `conjugatedOkurigana`, and get
 * one answer. `overrides.json`'s own char-only entry for 如 (ごと + し) states
 * the same reading and the same split of it, and goes on being what the
 * resolver returns; what it cannot state is a paradigm, so the ending it
 * carries is a 終止形 frozen at し wherever the lexicon does not speak. */
const COMPARATIVE_GOTOSHI: LexiconEntry = { conjClass: "ku-keiyoushi", reading: "ごと" };

/** **もつてす — the サ変 verb 以 is when it is a predicate and not a modifier.**
 *
 * The reader's ruling, verbatim: *"If 以 is a main predicate (not a modifier),
 * it should be read as もつてす, with てす as okurigana."* 論語 子罕's pair is the
 * case — 博我以文、約我以禮 is 我を博むるに文を以てし、我を約するに禮を以てす —
 * and 加之以師旅 (先進) and 辭以疾 (陽貨) are the same word: "does it *with* X",
 * where 以 carries the whole predication and nothing else in the clause does.
 *
 * **Written as an entry rather than as a reading, for the reason ごとし above
 * is**: an `overrides.json` okurigana is a fixed spelling, and this ending is
 * not fixed. サ変 inflects through every form the sentence asks of it —
 * 終止形 以てす (禮を以てす), 連用形 以てし (文を以てし、…), 未然形 以てせ
 * (仁を以てせず · 何を以てせんや), 連体形 以てする (其れ之を外すを以てするなり) —
 * and the table can state none of that. `okuriganaPrefix` carries the invariant
 * て in front of the paradigm, exactly as it carries the た of 来たる.
 *
 * The two `overrides.json` entries stay where they are and go on speaking for
 * every other 以: the reading もつ and the split of it are the same word's, and
 * what they cannot state is a paradigm. */
const PREDICATE_YI: LexiconEntry = {
  conjClass: "sa-hen",
  okuriganaPrefix: "て",
  reading: "もつ",
  // **The 連用形 is 以て and not サ変's 以てし**, which is the reader's second
  // ruling on this word, verbatim: *"以 in a 連用形 context is just もつて, not
  // もつてして."* 以てす is 以て with す on it, and 連用中止法 simply does not write
  // the す — what hands the clause on is the て that is already there. So in this
  // one cell the predicate use and the modifier use fall together on もつて, which
  // is what `overrides.json` reads for every other 以 and what the ADP tokens in
  // the same sentence print.
  //
  // Stated rather than conjugated because nothing may be appended to it: サ変's
  // 連用形 し is an い-sound, so `converbSuffix` would write 以てして wherever the
  // tree marks the token a converb, and the 連用形-て switch (`renyouTeSuffix`)
  // wrote exactly that — **60 tokens over 36 gold sentences** — which is the
  // string the ruling names. `statedForms` is what stands both of them down; see
  // its own doc in `verbLexicon.ts`.
  //
  // **Measured** over the 727 admitted tokens in
  // `lzh_kyoto-sud-{train,dev,test}.relabeled_ext.udep_ruled.punct.rulemerged.adjfix.conllu`:
  // 578 終止形 以てす, 61 連用形, 46 連体形 以てする, 44 未然形 以てせ. This moves
  // the 61 and nothing else — 之を繼ぐに規矩準繩を**以て**、以て方員平直を為す ·
  // 之に繼ぐに忍びざるの政を**以て**、而して仁天下を覆ふ. The other three cells
  // keep the サ変 the first ruling gave them.
  statedForms: { renyou: "て" },
};

/** The relations on which 以 **heads a clause of its own**, and so is the
 * predicate the reader's ruling is about. Measured over
 * `lzh_kyoto-sud-{train,dev,test}.relabeled_ext.udep_ruled.punct.rulemerged.adjfix.conllu`,
 * where 以 occurs **7,290** times:
 *
 * | dep | count | | example |
 * |---|---|---|---|
 * | `mod` | 5,615 | ADV 3,048 + VERB 2,567 | 無以尚之 · 不仁者不可以久處約 |
 * | `ROOT` | 669 | | 約我以禮 · 必以其道 |
 * | `unk` | 380 | | 可以語上也 |
 * | `comp:obj` | 545 | ADV 352 + VERB 193 | 患所以立 · 中人以上 |
 * | `conj:coord` | 25 | | 約之以禮 · 講之以學而不合之以仁 |
 * | `comp:aux` | 18 | | 不能以寸 · 不足以一獻 |
 * | `parataxis` | 16 | | 菆塗龍輴以椁 · 行之以忠 |
 * | `subj` | 13 | | 以纓、拾、矢，可也 |
 * | `comp:obl` | 4 | | 益封安平君以夜邑萬戶 · 乃使人以百里之地 |
 * | `discourse@sp` | 4 | PART | 黃雀因是以 |
 * | `cc` | 1 | CCONJ | 互名夏大以殷中 |
 *
 * **The 5,615 on `mod` are the modifier and are the whole of what the ruling
 * excludes** — 之を約するに禮を**以て**す has both words in it, and only the
 * second is this one. Nothing here reaches them; the render below is the check.
 *
 * The five admitted come to **727**. Each is a relation on which 以 *is* a
 * clause's predicate: `ROOT` outright; `conj:coord` and `parataxis` a clause
 * coordinated with or set beside another (前以三鼎、而後以五鼎與 is
 * 前に三鼎を以てし、後に五鼎を以てするか); `subj` a nominalized clause standing
 * as one (以纓、拾、矢，可也 is 纓・拾・矢を以てするは可なり); `comp:obl` the
 * predicate a 使役 governor makes happen (乃使人以百里之地 is
 * 乃ち人をして百里の地を以てせしむ — the same edge `isCausedPredicateParataxis`
 * is about, on the label a complement ordinarily arrives on).
 *
 * **`unk` (380) and `comp:aux` (18) are held out, and together they are one
 * thing**: every one of the 398 hangs off a modal — 可 297, 足 69, 能 9, 欲 9,
 * 有 6, 敢 5, 無 2, 得 1 — which is 可以/足以/得以, the fused two-word modal
 * `depClassification.ts`'s `isYiOfAuxiliary` already rules on. That rule reads
 * this 以 as the modifier もつて and puts it immediately before the modal's own
 * complement (可以已 -> 以て已むべし), which is this app's settled answer for the
 * configuration; a サ変 here would contradict it in the same sentence.
 *
 * **`comp:obj` (545) cannot be admitted flat**, and the 423 under 所 are why:
 * that is 所以, whose ordinary kundoku is ゆゑん (不患無位、患所以立 is
 * 立つ所以を患ふ) and which is a settled collocation, not a clause 以 heads.
 * Behind them the relation holds the ordinary object of another 以
 * (彼以其富、我以吾仁, 25 under 以). But it is also the relation a **quoted
 * clause's own head** arrives on, and the reader has ruled that those take the
 * same reading — so they are reached by a rule that looks at the governor
 * instead, `headsAQuotedClause` below.
 *
 * `discourse@sp` and `cc` are not verbs at all: 因是以 is a line-final particle
 * and 互名夏大以殷中 a conjunction.
 *
 * **A sixth position stands beside this set and cannot be written into it**,
 * because naming it takes the governor and not the relation: 以 heading a clause
 * a verb of speech quotes. See `headsAQuotedClause`. */
const PREDICATE_YI_DEPS = new Set(["ROOT", "conj:coord", "parataxis", "subj", "comp:obl"]);

/** The second half of 以上 · 以下 · 以來 · 以後 · 以前 · 以東/西/南/北 · 以遠 —
 * the bound pair in which 以 is half of one word and もつてす would be nonsense.
 *
 * **32 of the 727 are this shape** (26 `ROOT`, 6 `subj`), and the gold's own
 * annotation is what finds them: the character stands immediately after 以 and
 * hangs off it. 下 13, 上 7, 後 6, 來 1, 前 1, 南 1, 東 1, 西 1, 北 1 —
 * 中人以下 · 自世婦以下 · 由命士以上 · 自上世以來 · 晉自敗秦以後 · 自河以東 ·
 * 十五日以前 · 大功以上散帶.
 *
 * Held out rather than read: **the reader has been asked separately about
 * 以來/以下/以遠 and has not yet ruled**, so this rule leaves every one of them
 * reading exactly as it did. Not a correction of the parse — 以下 really is one
 * word and the treebank simply has no label saying so — which is why the fact
 * is stated about the *character* and not about the relation, the same shape as
 * `LOCATIVE_GOVERNOR_LEMMAS`.
 *
 * **降 is deliberately not in the set**, though 以降 is a word of exactly this
 * family. Its one gold occurrence is 離騒's 惟庚寅吾以降 — 惟れ庚寅 吾以て降る,
 * where 降 is the verb "was born" and 以 the modifier before it — and the gold
 * makes 以 the ROOT with 降 a `parataxis` under it, so it reads 以てし降る here.
 * That is the annotation's error and is left visible as one; putting 降 in this
 * set would hide it behind a claim about a word this sentence does not contain. */
const YI_BOUND_SECOND_MEMBERS = new Set([..."上下來来往外內内前後東西南北遠"]);

/** **The sixth position, and the one the relation alone cannot name: 以 heading
 * a clause that a verb of speech quotes.** The reader's ruling on the question
 * this rule first left him: *"yes, it should also have this reading as the head
 * of a speech complement."*
 *
 * A quoted clause's head arrives on `comp:obj` — the quote is the speech verb's
 * object — which is the one relation in the table above that could not be
 * admitted flat: 545 of the 7,290 以 stand on it and 423 of those are 所以. So
 * the governor has to be looked at, and `isSpeechQuoteComplement` is the
 * question already asked of it everywhere else in this file (see
 * `quotativeParticleFor` and `isNominalizedObjectPredicate`). Sharing it rather
 * than restating it is what keeps this in step with the machinery that decides
 * where the frame is read and whether the clause takes と.
 *
 * **The relation is itself the guard the ruling asked for.** A 以 *modifying*
 * something inside a quote hangs off that something by `mod` and never reaches
 * the speech verb at all — all 5,615 of them are refused by the clause above,
 * quoted or not. What arrives here is only what the gold has made the quote's
 * own head, which is structurally a ROOT with a frame in front of it: 秦封君以陶
 * is 秦君を封ずるに陶を以てす, 湯以亳、武王以鄗 is 湯は亳を以てし、武王は鄗を以てす,
 * 何以哉 is 何を以てせんや.
 *
 * **Measured, and not carried over from the first count of this population.**
 * 以 stands on `comp:obj`/`comp:pred` under a 伝達 governor **45** times — 曰 38,
 * 聞 2, and one each of 言/教/云/詔/告. The seven beyond 曰 are the whole
 * `v,動詞,…,伝達` class `isSpeechVerb` reads off the xpos, which the earlier
 * count of "38 under a speech verb" had missed by looking at 曰 alone.
 *
 * `isSpeechQuoteComplement` admits the **36** whose quote the source actually
 * brackets and refuses the **9** it does not — 未聞以割烹也 · 教以右手 ·
 * 詔五品以上言事 · 魏許寡人以地 · 翦今楚王資之以地 · 天不言，以行與事示之而已矣 ·
 * 臣聞趙王以百里之地 · 其行之以貨、力、辭讓 · 以綈袍戀戀. That refusal is
 * conservative and deliberate, and it is not this rule's judgement but the
 * file's standing one: without a bracket nothing in the tree distinguishes a
 * quotation from an ordinary object, and every other rule here declines to guess
 * it. Six of the nine read as predicates all the same, and they are the price.
 *
 * Two of the 36 are 以上 (子曰：「中人以上」 · 子曰：「自行束脩以上」) and
 * `YI_BOUND_SECOND_MEMBERS` takes them back out, so **34** tokens are reached.
 * Rendering the 6,946 gold sentences holding a 以 moves exactly those 34 on top
 * of the 695 the relation set already moved — 729 in all, もつて falling
 * 7,193 -> 6,464 — and nothing else.
 *
 * **The split inside those 34, since it is a real one: 23 read as predicates and
 * 11 as modifiers the annotation has lifted into the head slot.** The eleven are
 * 以吾一日長乎爾 · 以其存心也 · 子以是為竊屨來與 · 以孟嘗、芒卯之賢 · 以張儀之知 ·
 * 以秦之強 · 以公相則國家安 · 以周㝡也 · 徒以親在 · 以其亂也 · 以王之強而怒周.
 *
 * They are left visible rather than carved out, and the reason is consistency
 * with what is already shipped rather than indifference. Five of them are the
 * causal 「…を以てなり」 — 以 with a clausal object and a 也 closing — which is
 * exactly the shape of 以其外之也, a `ROOT` in the set above that this rule has
 * been reading 其れ之を外すを以てするなり since the first ruling. 以王之強而怒周
 * hangs 怒 off 以 by `conj:coord`, which says in so many words that the two are
 * coordinate predicates, and gets the same answer as the other 25 `conj:coord`.
 * Refusing them here while accepting them there would be one character read two
 * ways on one page.
 *
 * **No test on 以's own subtree can draw the line either**, which is what was
 * tried first: 秦封君以陶 — the reader's own example — has 封 hanging off 以 by
 * `subj`, exactly as 博 does in 博我以文, so "has a predicate dependent" refuses
 * the case the ruling was given for, and "has a predicate `comp:obj`" refuses
 * 君使人告齊王以周最不肯為太子也 while still admitting 以孟嘗、芒卯之賢. */
function headsAQuotedClause(token: Token, sentence: { tokens: Token[] }): boolean {
  const governor = sentence.tokens.find((t) => t.id === token.head && t.id !== token.id);
  return isSpeechQuoteComplement(token, governor, sentence);
}

/** `PREDICATE_YI` where `token` is a 以 heading a clause of its own, and
 * undefined everywhere else — the 5,615 modifier 以 above all, which go on
 * reading もつて from `overrides.json`. */
function predicateYiLexiconEntry(token: Token, sentence: { tokens: Token[] }): LexiconEntry | undefined {
  if (token.lemma !== "以") return undefined;
  // `ROOT`, not `root`: `conlluParser.ts` normalizes the one DEPREL and leaves
  // every other alone, so a set written in the file's own spelling would match
  // nothing at all on the relation that carries 669 of the 727. See the test.
  if (!PREDICATE_YI_DEPS.has(token.dep) && !headsAQuotedClause(token, sentence)) return undefined;
  const next = sentence.tokens.find((t) => t.id === token.id + 1);
  if (next && next.head === token.id && YI_BOUND_SECOND_MEMBERS.has(next.text)) return undefined;
  return PREDICATE_YI;
}

/** `COMPARATIVE_GOTOSHI` where `token` is a positive comparison 如/若, and
 * undefined everywhere else — including a *negated* comparison, which is the
 * other verb (如かず) and is what `VERB_LEXICON`'s own 四段カ行 entry is for. */
function comparisonLexiconEntry(token: Token, sentence: { tokens: Token[] }): LexiconEntry | undefined {
  if (!isComparativeYu(token)) return undefined;
  if (hasComparativeNegation(token, sentence)) return undefined;
  // **奈何 / 何如 is not a comparison**, and the paradigm has to stand down for
  // it here rather than be overruled downstream: this function is asked ahead
  // of `resolved.beatsLexicon` in `lexiconEntryFor`, so a reading that claims
  // the token cannot reach it. 何如 printed 何如**し** — the comparison's own
  // 終止形 — where the received text writes the bare pair. See
  // `ikanIdiomReading`, which supplies what this declines to.
  if (ikanIdiomReading(token, sentence)) return undefined;
  return COMPARATIVE_GOTOSHI;
}

/** Kanji whose only attested kanjidic kun'yomi is a modern sense unrelated
 * to a real classical predicate-adjective reading also needed in kanbun —
 * 利's kanjidic entry has only 利く ("to be effective/work"), never the
 * classical とし ("sharp, advantageous") this exact word needs as a bare
 * ROOT predicate (金就礪則利, "metal that is put to the grindstone becomes
 * sharp"). A closed, hand-verified table — the same bounded-exception shape
 * as `SPEECH_VERB_LEMMAS`/`LOCATIVE_GOVERNOR_LEMMAS` elsewhere in this
 * file — not a general kanjidic-gap-filling mechanism. Scoped to `dep ===
 * "ROOT"` so it never touches 利 in its ordinary "profit" noun sense
 * elsewhere (e.g. as an object/complement). */
const CLASSICAL_ADJECTIVE_ROOT_READINGS: Record<string, { reading: string; okurigana: string }> = {
  利: { reading: "と", okurigana: "し" },
};

export function classicalAdjectiveRootReading(token: Token): { reading: string; okurigana: string } | undefined {
  if (token.dep !== "ROOT") return undefined;
  return CLASSICAL_ADJECTIVE_ROOT_READINGS[token.lemma];
}

/** **能 read positively is 能く**, the adverb — and undefined for a negated 能,
 * which is the verb あたふ and takes `VERB_LEXICON`'s own 四段ハ行 entry
 * (能はず).
 *
 * The character's two words, and the count that says they are two, are set out
 * at `isPositiveNengComplement` in `depClassification.ts`, which exempts the
 * positive one's complement from inverting so that the adverb can stand in
 * front of it. This is the other half of the same change: the position and the
 * reading have to agree, or 能 is read 能ふ in a slot the adverb has been given.
 *
 * **`beatsLexicon`, and it has to be.** 能 is tagged AUX and both panels consult
 * `VERB_LEXICON` ahead of the resolver for an AUX, where the entry is あた +
 * 四段ハ行 — the right word for the negated arm and the wrong one here. The flag
 * is exactly what `OverrideEntry.beatsLexicon` is for, and this is the same
 * claim one of those entries makes: the syntax has chosen the word.
 *
 * **The character is kept**, which the received text is unanimous about: 能
 * stands 405 times in kanbun.info's 白文 and 407 in its 書き下し文, and よく in
 * kana appears none. So this is a reading of the character with its ending
 * beside it — 能(よ)ク — and not a gloss standing in for it. */
/** **The 如/若 of 奈何・何如 is half of いかん and takes no ending of its own.**
 * Returns the word for the pair and an empty okurigana, so that the prose
 * prints the bare character — 何如, 如何 — where `COMPARATIVE_GOTOSHI` would
 * otherwise inflect it as the comparison ごとし and print 何如**し**.
 *
 * The received text writes 如 with no kana after it **72** times of 398, and
 * those 72 are this idiom and the 突如-type suffix; 何如 stands 22 times, 如何
 * 37, 奈何 83 and 何若 2, and none of them carries an adjectival ending. 奈 needed
 * nothing here — it has no ごとし entry and already printed bare — which is why
 * this reads as a stand-down for the other two rather than as a rule of its own.
 *
 * **The division of いかん across the two characters is not attempted.** The
 * word belongs to the pair, and this app annotates per character; the reading is
 * returned whole against the character that ends it, and the 書き下し文 — which
 * is what the corpus measures — prints neither, only the two kanji. A reader who
 * wants 何(いか)ン has the furigana menu.
 *
 * See `isIkanIdiom` in `depClassification.ts`, which holds the position and the
 * particle halves of the same claim and carries the counts. */
export function ikanIdiomReading(
  token: Token,
  sentence: Sentence | { tokens: Token[] },
): { reading: string; okurigana: string } | undefined {
  if (token.lemma !== "如" && token.lemma !== "若") return undefined;
  const he = sentence.tokens.find(
    (t) => t.head === token.id && t.id !== token.id && t.lemma === "何" && isIkanIdiom(t, token, sentence),
  );
  return he ? { reading: "いかん", okurigana: "" } : undefined;
}

export function positiveNengReading(
  token: Token,
  sentence: Sentence | { tokens: Token[] },
): { reading: string; okurigana: string } | undefined {
  if (token.lemma !== "能") return undefined;
  // A hand-picked reading takes the character out of the class — the same
  // discipline `isNegationUse` and `isRereadUse` follow, and the one
  // `isPositiveNengComplement` follows for the *position* that goes with this
  // reading. A reader who pins べし on a 能 gets the auxiliary back, whole.
  if (storedReadingText(token) !== undefined) return undefined;
  // A 能 governing nothing is the noun 能 ("ability", 多能) or the verb 能くす,
  // not the adverb: 其多能也 is 其の多能なる. The adverb modifies a predicate,
  // and `comp:aux` is the relation it hangs one on — 338 of the 404 in the
  // kanbun.info corpus's parses, VERB 299 and ADJ 39.
  const complement = sentence.tokens.find(
    (t) => t.head === token.id && t.id !== token.id && (t.dep === "comp:aux" || t.dep === "comp:obj"),
  );
  if (!complement) return undefined;
  if (negationClosing(token, sentence)) return undefined;
  return { reading: "よ", okurigana: "く" };
}

/** **敢 over a predicate is 敢へて**, the adverb, whether or not a negation
 * hangs on it — the reading half of `isGanComplement` in `depClassification.ts`,
 * which carries the counts (敢えて 81 in kanbun.info's 書き下し文 against 敢え +
 * anything else 0).
 *
 * **`beatsLexicon`, for the reason `positiveNengReading` gives.** 敢 is tagged
 * AUX, both panels consult `VERB_LEXICON` ahead of the resolver for an AUX, and
 * the lexicon holds 敢 as the 下二段ハ行 verb あふ. That entry is what wrote
 * 敢へず, 敢ふる and 敢ふ on every one of these tokens: the kanji right and the
 * word wrong. `endingComplete` says the same thing from the other side — へて is
 * the whole of what stands beside the character, and no form a context asks for
 * (the 未然形 before 不, the 連体形 before 莫) is to be spelt on top of it.
 *
 * **A 敢 that governs nothing is the adverb over a dummy す**, and is read so
 * only where a negation hangs on it and nothing follows it in its clause.
 * 欲去不敢, 擊之不敢 and 進退不敢 are the three
 * in kanbun.info, and the site writes 敢えてせ on all three (敢えてせざるは,
 * 敢えてせず, 敢えてせず); the lexicon read them 敢へず. The せ is the 未然形 the
 * ず asks for, written into the okurigana because no token stands for the す.
 * 豈敢 (1, 豈に敢えてせんや) is the same dummy す in the same 未然形, with the
 * ん and the や written after it (`rhetoricalGanOf`). Any other bare 敢 is left
 * to the lexicon: that is 果敢 (3, 果敢にして), which is not this word. */
export function ganAdverbReading(
  token: Token,
  sentence: Sentence | { tokens: Token[] },
): { reading: string; okurigana: string } | undefined {
  if (!ganReadsAsAdverb(token, sentence)) return undefined;
  const complement = sentence.tokens.find(
    (t) => t.head === token.id && t.id !== token.id && (t.dep === "comp:aux" || t.dep === "comp:obj"),
  );
  if (!complement) {
    const negated = sentence.tokens.some((t) => t.head === token.id && t.id !== token.id && isNegationUse(t));
    // Standing last in its clause, too: 堯二女不敢以貴驕事舜親戚 hangs 以 off 敢
    // as a plain `mod`, a predicate the parse did not label as the complement,
    // and 敢へてせず in front of it is a second verb the sentence does not have.
    const next = sentence.tokens.find((t) => t.id === token.id + 1);
    const closesClause = next === undefined || next.pos === "PUNCT";
    if (negated && closesClause) return { reading: "あ", okurigana: "へてせ" };
    // **豈敢 with nothing after it is 豈に敢へてせんや** — the same dummy す, in
    // the 未然形 the ん asks for, and the や written with it where no 乎 closes
    // the clause. The one 豈敢 on kanbun.info (則吾豈敢？) is 吾豈に敢えてせんや. See
    // `rhetoricalGanOf`.
    const rhetorical = rhetoricalGanOf(token, sentence);
    if (rhetorical) return { reading: "あ", okurigana: "へてせ" + rhetoricalGanEnding(token, rhetorical, sentence) };
    return undefined;
  }
  return { reading: "あ", okurigana: "へて" };
}

/** **The clause a 敢 heads, seen from the predicate that closes it.** Returns
 * the sentence rearranged so that the complement stands in 敢's slot — 敢's
 * own head and relation, and every other child of 敢 (a 不, a 非, a subject)
 * hung off it — with 敢 as a plain `mod` of the complement; `undefined` for
 * anything else.
 *
 * **Why a view, and why only for the slot.** 敢 is read in place as 敢へて (see
 * `isGanComplement` in `depClassification.ts`), so the character that ends the
 * clause on the page is the complement, not 敢. The tree still says 敢 is the
 * predicate, and what this file writes *for the slot a clause stands in* — the
 * に a 非 is owed, the に of an oblique and the form in front of either — was
 * asked of 敢 and written after 敢へて: 非敢後也 read 敢へて**に**後る非ずなり
 * and 除害在於敢斷 read 敢へて**に**斷る於いて. The received readings put the に
 * after the whole clause: 敢えて後れたる**に**非ず, 敢断**に**在り. Asked of the
 * complement in this view, those rules find the end of the clause where the
 * reader finds it (敢へて後るるに非ず, 敢へて斷るに於いて), and not one of them
 * had to learn about 敢.
 *
 * **Only `caseParticleFor` and `decideConjForm` look through it**, the two
 * questions a clause answers at its last word. The reading order, the marks
 * and the negation (whose governor is still 敢, and whose slot rules already
 * ask about 敢's slot) are left on the tree the parser gave. */
export function ganClauseView(token: Token, sentence: Sentence): { token: Token; sentence: Sentence } | undefined {
  const gan = sentence.tokens.find((t) => t.id === token.head && t.id !== token.id);
  if (!gan || token.id < gan.id || ganAdverbReading(gan, sentence) === undefined) return undefined;
  if (ganClauseComplement(gan, sentence)?.id !== token.id) return undefined;
  const tokens = sentence.tokens.map((t): Token => {
    if (t.id === gan.id) return { ...t, head: token.id, dep: "mod" };
    if (t.id === token.id) return { ...t, head: gan.head, dep: gan.dep };
    if (t.head === gan.id) return { ...t, head: token.id };
    return t;
  });
  return { token: tokens.find((t) => t.id === token.id)!, sentence: { ...sentence, tokens } };
}

/** The predicate a 敢 read as 敢へて introduces: its first `comp:aux`, or with
 * none, its first `comp:obj` — the same choice `reorderEngine.ts` makes for the
 * complement a negation on 敢 closes. */
function ganClauseComplement(gan: Token, sentence: Sentence | { tokens: Token[] }): Token | undefined {
  const kids = sentence.tokens.filter((t) => t.head === gan.id && t.id !== gan.id);
  return kids.find((t) => t.dep === "comp:aux") ?? kids.find((t) => t.dep === "comp:obj");
}

/** **豈敢 — "how would I dare"**, and the other rhetorical questions 敢へて
 * stands in, which close their clause on 未然形 + ん: 豈敢V is 豈に敢へてVんや,
 * 何敢V 何ぞ敢へてVん. Returns the 敢 where `token` is what closes such a
 * clause — the complement a 敢へて introduces, or a bare 敢 that introduces
 * none — with whether the clause owes a や of its own; `undefined` otherwise.
 *
 * **Why not the 豈…乎 frame this file already reads.** That frame writes the
 * 連体形 and か (`closesRhetoricalQuestion`: 豈に數有るか), and a 豈 over 敢
 * reached neither half: 則吾豈敢？ read 豈に敢ふ, 敢 conjugated as the verb あふ
 * because nothing followed it (see `ganAdverbReading`). "Dare" in a question
 * is an act contemplated rather than a fact asserted, and the received text
 * writes the volitional ん on every one of these kanbun.info has:
 *
 *  - **豈敢 1**: 則ち吾豈に敢えてせんや — the や written with the ん.
 *  - **何敢 2** and **孰敢 1**: 賜や何ぞ敢えて回を望まん, 回何ぞ敢えて死せん,
 *    孰か敢えて正しからざらん — the question word makes the question, and no
 *    や follows.
 *  - **敢…乎 1**: 敢不受天之詔命乎 is 敢えて天の詔命を受けざらんや — the や the
 *    乎 is read as.
 *
 * So a 豈 owes a や where the source has no particle to read as one
 * (`rhetoricalGanEnding`), an interrogative word owes none, and a question
 * particle on the clause licenses the ん by itself and supplies its own や
 * (`sentenceFinalParticleFor`). Before this rule the app read the four 豈に敢ふ,
 * 何ぞ敢へて回を望む, 孰敢へて正しからず and 敢へて命を受けずや.
 *
 * **Keyed on the tree.** The 豈 or the interrogative is a `mod` or `subj` of 敢
 * or of its complement standing before 敢 (the parse hangs 何 as `mod`, 孰 as
 * `subj`); the particle is a `discourse@sp` on either. A particle alone is not
 * taken over a verb of speech — 敢問…乎 asks the question the particle closes
 * and does not dare anything rhetorically. And the complement has to be what
 * is read last in the clause: a negation after it closes the clause in its
 * place (`negationEndingParts` writes ざらん), and a clause coordinated onto 敢
 * is another clause. */
function rhetoricalGanOf(
  token: Token,
  sentence: Sentence | { tokens: Token[] },
): { gan: Token; ya: boolean } | undefined {
  const bare = token.lemma === GAN_ADVERB_LEMMA && ganReadsAsAdverb(token, sentence);
  const gan = bare ? token : sentence.tokens.find((t) => t.id === token.head && t.id !== token.id);
  if (!gan || !ganReadsAsAdverb(gan, sentence)) return undefined;
  const complement = ganClauseComplement(gan, sentence);
  if (bare ? complement !== undefined : complement?.id !== token.id) return undefined;
  const inClause = (t: Token): boolean => (t.head === gan.id || t.head === token.id) && t.id !== t.head;
  const asker = sentence.tokens.find(
    (t) =>
      inClause(t) &&
      t.id < gan.id &&
      (t.dep === "mod" || t.dep === "subj") &&
      (RHETORICAL_QUESTION_ADVERB_LEMMAS.has(t.lemma) || RHETORICAL_GAN_ASKER_LEMMAS.has(t.lemma)),
  );
  const particle = sentence.tokens.some(
    (t) => inClause(t) && t.dep === "discourse@sp" && RHETORICAL_GAN_QUESTION_PARTICLE_LEMMAS.has(t.lemma),
  );
  if (!asker && !(particle && !bare && !isCommunicationVerb(token))) return undefined;
  const asSentence = sentence as Sentence;
  const closesLast = (child: Token): boolean => isNegationUse(child) || child.dep === "discourse@sp";
  if (
    !readsLastInItsSubtree(
      gan,
      asSentence,
      (child) => child.id <= token.id || closesLast(child) || COORDINATION_DEPS.has(child.dep),
    )
  ) {
    return undefined;
  }
  if (!bare && !readsLastInItsSubtree(token, asSentence, closesLast)) return undefined;
  return { gan, ya: !!asker && RHETORICAL_QUESTION_ADVERB_LEMMAS.has(asker.lemma) };
}

/** 敢 — the lemma `rhetoricalGanOf` asks after. `ganReadsAsAdverb` asks it too. */
const GAN_ADVERB_LEMMA = "敢";

/** ん, and the や after it where a 豈 asks for one and the source closes the
 * clause with no particle to read as it. See `rhetoricalGanOf`. */
function rhetoricalGanEnding(
  closing: Token,
  frame: { gan: Token; ya: boolean },
  sentence: Sentence | { tokens: Token[] },
): string {
  const particle = sentence.tokens.some(
    (t) =>
      (t.head === closing.id || t.head === frame.gan.id) &&
      t.dep === "discourse@sp" &&
      RHETORICAL_GAN_PARTICLE_LEMMAS.has(t.lemma),
  );
  return RHETORICAL_GAN_VOLITIONAL + (frame.ya && !particle ? INTERROGATIVE_PARTICLE : "");
}

/** ん — the volitional む, as `VOLITIONAL_PARTICLE` writes it before its と. */
const RHETORICAL_GAN_VOLITIONAL = "ん";

/** 何/孰/誰 — the question words a 敢へて clause is asked with (何ぞ敢へて,
 * 孰か敢へて). See `rhetoricalGanOf`. */
const RHETORICAL_GAN_ASKER_LEMMAS: ReadonlySet<string> = new Set(["何", "孰", "誰"]);

/** The question particles that make a 敢へて clause rhetorical on their own
 * (敢不受天之詔命乎). */
const RHETORICAL_GAN_QUESTION_PARTICLE_LEMMAS: ReadonlySet<string> = new Set(["乎", "邪", "耶", "歟", "與", "与"]);

/** The particles read や where they close such a clause: the question
 * particles, and 哉, which reads かな elsewhere (豈…哉). */
const RHETORICAL_GAN_PARTICLE_LEMMAS: ReadonlySet<string> = new Set([...RHETORICAL_GAN_QUESTION_PARTICLE_LEMMAS, "哉"]);

/** Verbs whose 於-complement names a bare *place* — where the action
 * happens, not a source it comes from or a standard it's measured against
 * — so 於 reads the fuller おいて there instead of より. This is a real,
 * closed lexical fact about the *governing verb*, not something derivable
 * from this parser's own tags: a live-parsed comparison confirmed 藍 in 取
 * 之於藍 ("takes it from indigo") and 堂上 in 王坐於堂上 ("sits in the hall")
 * both come out tagged identically (`mod@lmod`, `Case=Loc` on the
 * complement) despite being a source and a location respectively — the
 * parser has no signal here at all for which sense applies, only the verb
 * itself does. Bounded to unambiguous plain-existence/plain-location verbs
 * (坐 "to sit", 居/在 "to dwell/be present", 戰 "to fight", 處 "to reside") —
 * not e.g. 生 ("to be born"), which is genuinely ambiguous between "born
 * *in* [a place]" and "born *from/of* [circumstances]" depending on
 * context this app has no way to judge, so it's left at the より default
 * rather than guessed into this set.
 *
 * 俯 and 臥 join by the same criterion the four originals meet: they are
 * posture verbs, and lying down happens *at* a place and is not taken *from*
 * one. 酒蟲's 但令於日中俯臥 (sent_id 20) is the case — 日中に於いて俯臥せしむ,
 * where the line read 日中より俯臥せしむ, "made [him] lie prone *from* the
 * daytime". They are added to this set rather than to a rule keyed on 於's
 * own dep, which is what was proposed and which cannot work: see
 * `isLocativeYu` for the measurement. */
const LOCATIVE_GOVERNOR_LEMMAS = new Set(["坐", "居", "在", "戰", "戦", "處", "処", "俯", "臥"]);

/** Verbs whose 於-complement is a **source** — what the action is taken or
 * comes out *from* — so 於 reads より there against the plain に the default
 * now gives. The mirror of `LOCATIVE_GOVERNOR_LEMMAS` above, and closed for the
 * same reason: the parser tags a source and a location identically
 * (`mod@lmod`, `Case=Loc` on both), so nothing but the governing verb's own
 * meaning separates them.
 *
 * 取 is 勸學's own line and this app's oldest anchor for the character —
 * 青取之於藍 is 青は之を藍**より**取る, "blue is taken *from* indigo" — and 出 is
 * the same relation with the motion made explicit. Held to those two: 生 is
 * genuinely ambiguous between "born *in*" and "born *of*" (see
 * `LOCATIVE_GOVERNOR_LEMMAS`' own note, which declines to guess it), and 受 /
 * 聞 / 學 take their source as often as they take a person marked に. */
const ABLATIVE_GOVERNOR_LEMMAS = new Set(["取", "出"]);

/** How 於 is read, split into what stands *over* the character and what is
 * written after it — the distinction `EruConnective` draws for 而, and for the
 * same reason: the two senses are different kinds of word and are written
 * differently.
 *
 * 於 always inverts before its governor now (see `depClassification.ts`'s
 * `INVERT_DEPS`), landing in the same pre-head adjunct position regardless of
 * which sense applies. **に is the default** and より is the comparison, with
 * `LOCATIVE_GOVERNOR_LEMMAS` giving the fuller 於いて for the bounded set of
 * verbs whose 於-complement is a bare location.
 *
 * **より was the default and that was the wrong way round, measured.** Over
 * kanbun.info's 書き下し文 the app wrote より where the site wrote に **200**
 * times (49 on gold parses, 151 on parsed ones) and there is no class the other
 * way. The 821 ADP 於/于/乎 in the corpus's own parses say why: **736** of them
 * govern a plain VERB — 在 39, 至 27, 問 25, 有 14, 立 8, 置 8 — where 於 is a
 * 置き字 and its object simply takes に, against **85** governed by the
 * treebank's 描写 ("descriptive") class, which is the comparison and is the only
 * place より belongs. 事に敏にして言に慎み (論語 學而 14) is the shape: 敏於事 is
 * 事**に**敏, never 事より敏.
 *
 * So the sense is taken from the governor's **category** — the treebank names
 * the 描写 class in the xpos — **and then from a lemma list inside it**, which
 * is the correction the paragraph above was already asking for and did not
 * make. A descriptive predicate is where a comparison can stand; it is not by
 * itself a comparison. 賢於生也 is 生**より**賢なり, and 敏於事 is 事**に**敏 with
 * the same 描写,態度 tag on its governor — the tree cannot tell them apart, so
 * `DOMAIN_GOVERNOR_LEMMAS` does, and its own doc carries the
 * measurement (gold −11, parser −45 against the category alone).
 *
 * **より is a case particle and carries no reading of its own.** 取之於藍 is
 * 藍より取る: 於 is not written at all in the prose, the way a case particle
 * this app supplies never is. So `reading` is absent and the whole answer is
 * okurigana, which is exactly what this function returned before it was
 * split.
 *
 * **おいて is a verb form and keeps its kanji.** 日中に於いて, not 日中におい
 * て — 於いて is the ordinary spelling of the phrase, and the character is a
 * word in the sentence rather than a particle standing in for one. So the
 * answer divides: お over the character, いて beside it.
 *
 * **The boundary is お + いて and not おい + て.** KANJIDIC2 gives 於 both —
 * おい.て (於て) and お.ける (於ける) — and the second is the one to follow,
 * since 於いて and 於ける are the same stem お- and a boundary that moves
 * between them is describing two different characters. `overrides.json`
 * carries an entry stating the same split; that entry cannot reach either
 * panel (this function answers for every 於 and both panels ask it first), so
 * the strings live here, where the panels can see them. Both panels take the
 * split from here as a split: `generator.ts` writes the kanji in the prose
 * exactly when a `reading` is present, and `KundokuView.ts` puts that reading
 * in the furigana slot and the okurigana beside it — 於(お)イテ against a bare
 * 於ヨリ.
 *
 * **Which sense applies is still `LOCATIVE_GOVERNOR_LEMMAS`, and not 於's own
 * dep.** The obvious rule — and the one that entry is keyed on — is the
 * locative dep subtype `mod@lmod`/`comp:obl@lmod`, and it was measured not to
 * separate the two senses at all: 青取之於藍's 於 comes back `mod@lmod`
 * exactly as 坐於堂's does. The parser calls 藍 a location in both, which it
 * has no way not to; what differs is whether the governing verb takes a
 * *source* or sits *at* a place, which is a fact about that verb's meaning
 * and is what the lemma set holds. Keying on the dep read 藍に於いて取る. */
/** **The descriptive predicates whose 於-complement is a *domain* rather than a
 * standard of comparison** — the exceptions to より, written out because the
 * tree cannot find them.
 *
 * `isDescriptivePredicate` was doing this job alone and it is too broad, a fact
 * the doc above already recorded without acting on it: it names 敏於事 =
 * 事**に**敏 as the shape the rule gets wrong while sending every 描写 governor
 * to より. Three tokens of exactly that shape are in this app's own 論語 sample
 * and all three came out with より — 敏於事 (事に敏, 學而 14), 近於義 (義に近け
 * れば, 學而 13), 異乎人之求之 (人の之を求むるに異なるか, 學而 10).
 *
 * The treebank cannot separate them: 賢 and 敏 are both `v,動詞,描写,態度`, 近
 * and 異 both `描写,形質`. So it is lexical, and the question is only which way
 * round to write the list.
 *
 * **Written as the exceptions rather than as the members, and that is the
 * substantive choice here.** A gradable quality standing over 於 is a
 * comparison by default — 青於藍 is 藍**より**青し, 寒於水 水**より**寒し, 大於
 * 天下 天下**より**大なり — and there is no closing that class: any adjective
 * can head a comparison. What *is* a closed class is the handful of relational
 * predicates whose 於-phrase names a domain or a goal instead. Listing the
 * comparatives was tried first and it fails exactly where an open class must:
 * 勸學's 青 and 寒 are comparisons, are not in any list assembled from the
 * corpus (勸學 is not in it), and came out with に until they were named.
 *
 * **Measured** over kanbun.info, every variant rendered in the same process:
 *
 *  | 於 reads より when its governor is        | gold | parser |
 *  |---|---|---|
 *  | any 描写 predicate (as shipped)          | 10,378 | 66,791 |
 *  | a 描写 predicate **not in this set**      | **10,367** | **66,746** |
 *  | one of 11 hand-listed comparative lemmas | 10,367 | 66,735 |
 *  | never — the rule dropped entirely        | 10,371 | 66,761 |
 *
 * The inclusion list scores 11 better on the parser tier and is **not** taken:
 * that is 0.016% of the tier, well inside the noise of a lexical list built by
 * hand off one corpus, and it is bought by a rule that silently mis-reads every
 * comparative it has not met. Both narrowings beat the shipped breadth by a
 * wide margin, and that dropping the rule *entirely* also beats it is what says
 * the old rule was over-applying rather than merely imprecise.
 *
 * `ABLATIVE_GOVERNOR_LEMMAS` is a separate set and is untouched: those are
 * verbs of *source* (取之於藍, 藍より取る), which take より for a different
 * reason and are not descriptive predicates at all. */
const DOMAIN_GOVERNOR_LEMMAS: ReadonlySet<string> = new Set([
  "敏", "近", "異", "同", "明", "富", "倚", "類", "和", "雜", "幾", "庶", "利", "暴",
]);

export function yuParts(token: Token, sentence: Sentence): { reading?: string; okurigana: string } | undefined {
  if (token.lemma !== "於") return undefined;
  const governor = sentence.tokens.find((t) => t.id === token.head);
  if (governor && LOCATIVE_GOVERNOR_LEMMAS.has(governor.lemma)) return { reading: "お", okurigana: "いて" };
  const comparative =
    (governor !== undefined &&
      isDescriptivePredicate(governor) &&
      !DOMAIN_GOVERNOR_LEMMAS.has(governor.lemma)) ||
    ABLATIVE_GOVERNOR_LEMMAS.has(governor?.lemma ?? "");
  if (comparative) {
    return { okurigana: "より" };
  }
  return { okurigana: "に" };
}

/** Whether a token is a **descriptive** predicate — the treebank's 描写 class,
 * or a bare ADJ in a tree that states no fine tag — which is the one thing
 * `yuParts` needs of 於's governor and the one thing that separates 於's two
 * senses where `LOCATIVE_GOVERNOR_LEMMAS` does not.
 *
 * Three routes, in `isComparativeYu`'s own order and for its reasons: the
 * treebank's feature first, its fine tag second, and the coarse UPOS only where
 * the tree states neither. Over the 821 ADP 於/于/乎 in the kanbun.info corpus's
 * parses the three agree exactly — **82** governors carry `Degree=Pos` and 81 of
 * those carry 描写, against **0** of the 599 plain VERB governors — so the
 * feature is the same claim the tag makes and is read first because a
 * hand-written tree carries it where it carries no xpos.
 *
 * Written as its own function beside that set rather than inlined, because it
 * answers a question about the *governor's own category* while the set answers
 * one about a bounded list of lemmas, and the two are different kinds of claim
 * about different things. */
function isDescriptivePredicate(token: Token): boolean {
  if (parseMorphFeatures(token.morph ?? "").Degree === "Pos") return true;
  if (token.xpos.startsWith("v,動詞,描写")) return true;
  if (token.xpos || token.morph) return false;
  return token.pos === "ADJ";
}

/** Whether this token is a 於 in its locative sense — the one read おいて,
 * whose object takes に. The presence of a reading over the character is what
 * marks it (see `yuParts`, where the two senses are told apart once and for
 * all), so what `caseParticleFor` writes and what the panels print cannot
 * disagree about which 於 this is. */
function isLocativeYu(token: Token, sentence: Sentence): boolean {
  return yuParts(token, sentence)?.reading !== undefined;
}

/** 為/爲 — the two spellings of one character; nothing normalises a lemma to
 * one of them before a table is keyed by it, which is the reason
 * `SENTENCE_FINAL_PARTICLES` lists 歟 beside 欤 and 與 beside 与. */
const PURPOSIVE_WEI_LEMMAS: ReadonlySet<string> = new Set(["為", "爲"]);

/** Whether this token is the benefactive/causal **為** — the adposition read
 * ために, "for the sake of", as against the copula たり or the verb なす.
 *
 * The tag is the whole of the condition because the tag is the whole of what
 * decides the reading: `overrides.json` gives 為/爲 ために on `contextPos:
 * ["ADP"]`, たり on VERB at `comp:pred`/ROOT, and なす on everything else. So a
 * 為 this answers yes for is a 為 the page prints ために, which is what the
 * particle rule in `caseParticleFor` needs to know. See that branch for what it
 * writes and for the counts.
 *
 * Named here beside `isLocativeYu` rather than inlined, because it is the same
 * kind of question about the same kind of word — an adposition that is read as a
 * content word and therefore leaves its object to be marked — and the two
 * branches that ask them stand together. */
function isPurposiveWei(token: Token): boolean {
  return token.pos === "ADP" && PURPOSIVE_WEI_LEMMAS.has(token.lemma);
}

/** が — the 連体格助詞 a **prepositional 為** takes in front of it, from a
 * pronoun and from a clause alike. 我**が**ために, 後無き**が**爲なり.
 *
 * One constant for the two arms because it is one particle doing one job: が is
 * what stands between 為 and what it is the 為 *of* wherever the thing in front
 * of it is not a plain noun. The reader ruled the two together — *"Use が"* for
 * the clause, *"我がために"* for the pronoun — and a noun's own の is written as
 * a literal beside it, since that arm is the one the reader stated first and it
 * is not this constant's.
 *
 * **Why the clause cannot take の.** 為無後也 is 後無き**が**爲なり: what precedes
 * is a 連体形, and の after a 連体形 is not a reading of 文語 at all — 後無しの爲
 * is what giving it の would print. が is the particle that follows an
 * attributive, which is the same reason `decideConjForm` has to be answering
 * about the same token: a 連体形 with no が, or a が on a 終止形, is exactly the
 * pairing this file's discipline exists to prevent. */
const PURPOSIVE_GENITIVE = "が";

/** A **clause** standing as the complement of a prepositional 為 — 連体形, and
 * が. 舜不告而娶，**為無後**也 is 舜告げずして娶る、後無き**が**爲なり, and
 * **為得罪**於父 父に罪を得る**が**爲に.
 *
 * The fourth of the shape `isNominalizedObjectPredicate` (を),
 * `isNominalizedSubjectPredicate` (こと) and `isNominalizedObliquePredicate` (に)
 * already make, and written to it deliberately: one predicate answers both
 * halves — the 連体形 in `decideConjForm` and the particle in `caseParticleFor`
 * — so the form and the particle cannot come apart. `negationEndingParts` holds
 * the third share of it, for the clause a postposed negation closes.
 *
 * **Why it is not `isNominalizedObjectPredicate` itself**, which claims exactly
 * this relation from a *content-word* governor. 為 here is tagged ADP, and that
 * gate refuses it — deliberately, since an adposition's complement is ordinarily
 * marked by the adposition and by nothing else (the `governor?.pos === "ADP"`
 * branch below says so for every one of them). A prepositional 為 is the
 * exception the two branches above this one are already about: it is *read as a
 * content word*, ため, so what it governs has to be marked in front of it, and a
 * clause in that slot is nominalized exactly as a clause in an ordinary object
 * slot is. What differs is only the particle — が after the 連体形, where an
 * ordinary object takes を.
 *
 * **Measured over
 * `lzh_kyoto-sud-{train,dev,test}.relabeled_ext.udep_ruled.punct.rulemerged.adjfix.conllu`.**
 * An ADP 為/爲 governs **155** predicate `comp:obj` — VERB 132, ADJ 23, every one
 * of them carrying a `v,動詞,…` xpos, so `isVerbalXpos` admits them all. ADJ
 * comes with VERB rather than being left out: parser 0.3.2 recoded the stative
 * predicates off VERB, and 為其病也 (病, `v,動詞,描写,形質`) is 其の病める**が**
 * 爲なり as much as 為無後也 is — the same argument `isNominalizedObjectPredicate`
 * makes for its own 3,188 ADJ objects.
 *
 * **An existential is admitted, where the object rule excludes it**, and the
 * reader's own example is one: 為無後也's complement is 無, `v,動詞,存在,存在`.
 * That rule excludes an existential because 有's own complement takes no particle
 * (物**の**出づる有り); here 無 is not the existential's complement but the whole
 * existential *clause* standing in 為's slot, and a clause is what が follows.
 *
 * **The 43 VERB/ADJ dependents on `mod` are not this, and they take nothing.**
 * They are a different edge from the 155 and were once counted in with them —
 * see the overrides table's note on 為/爲, which now separates the two. In
 * 迎貓，為其食田鼠也 gold makes 為 the root, its `comp:obj` the clause 其食田鼠
 * — and its `mod` the **matrix** clause 迎貓, the thing done *for* that reason.
 * 介者不拜，為其拜而蓌拜 is the same shape (拜 the matrix on `mod`, 拜 the reason
 * on `comp:obj`), and so is every one of the 43 sampled. They are the clause the
 * 為-phrase modifies, not what it governs; が there would read
 * 貓を迎ふる**が**爲に其れ田鼠を食らふ and turn the sentence inside out. So the
 * relation is `comp:obj` and only that.
 *
 * **A coordinated complement writes the が after the whole chain**, which is
 * `closesArgumentChain`'s doing and not this predicate's. 介者不拜，**為其拜而蓌拜**
 * has 拜 as the complement with 蓌 coordinated onto it, and the が used to land
 * between the two — 其の拜む**が**て蓌拜する — where the phrase closes only after
 * the second conjunct: 其の拜みて蓌拜する**が**爲なり. **7** of the 155 are
 * coordinated this way on an explicit coordinator, 5 of which now carry the が on
 * their last conjunct; a further **6** stand in a chain only `parataxis` holds
 * together and are untouched, for the reason that function gives about dragging
 * a particle across that relation. The three nominalization rules above had the
 * identical exposure for their own を/こと/に — the `onCarrier` block further
 * down speaks for *nominal* chains only — and it was one fix for all four.
 *
 * **One of the 7 is a mis-annotation and is named there rather than worked
 * around**: 為得罪於父，不得近 makes the matrix clause 不得近 a `conj:coord` of
 * 得罪, so the が is now carried across the comma onto it. The matrix clause
 * belongs on `mod`, which is what the 43 measured just above wear.
 *
 * **Two of the 155 are an 以…為… frame**, where 為 is not the preposition at all
 * but the verb "make of, take to be" — 子以是為竊屨來與 ("do you take this to be
 * coming to steal shoes"), 盡以為人. Those are a tagging error on 為 (ADP for a
 * verb) and are named rather than carved out: the same two are already wrong in
 * the nominal arm above, which has marked their complement の since it shipped,
 * and the correct annotation is a VERB tag on that 為. */
export function isPurposiveWeiComplement(token: Token, sentence: Sentence): boolean {
  if (token.dep !== "comp:obj") return false;
  if (!isContentPredicatePos(token.pos) || !isVerbalXpos(token)) return false;
  const governor = sentence.tokens.find((t) => t.id === token.head && t.id !== token.id);
  return !!governor && isPurposiveWei(governor);
}


/** 子 defaults to し ("master/teacher" — 孔子/君子/弟子 etc., the vastly more
 * common classical sense) unless it carries its own possessive modifier
 * (其子/吾子/是子, "his/my/this child"), in which case it's read こ
 * ("child") instead. `det` is this treebank's determiner relation, the
 * closest available signal for a possessive/demonstrative pronoun modifying
 * a noun (no dedicated "poss" relation exists in the 34-label inventory).
 * Furigana-only — kakikudashi never shows a reading for a plain retained
 * noun either way, so this doesn't need a kakikudashi-side counterpart. */
export function ziReading(token: Token, sentence: Sentence): string | undefined {
  if (token.text !== "子") return undefined;
  const hasPossessiveModifier = sentence.tokens.some((t) => t.head === token.id && t.dep === "det");
  return hasPossessiveModifier ? "こ" : "し";
}

/** Which of the six base forms a content word needs, given what follows it
 * in reading order:
 *  - a postposed negation token next -> mizenkei (ク/シク adjectives fall
 *    back to their -から/-しから form automatically, see
 *    `classicalConjugation.ts`)
 *  - 而 next -> renyoukei (realized as て/して)
 *  - anything else, including end of clause -> shuushikei (correct for
 *    both a true sentence end and a mid-sentence clause boundary right
 *    before a 、, e.g. "習ふ、") */
/** True for a stative (`Degree=Pos`) `flat@vv` predicate attached directly
 * to a NOUN that is itself the sentence's `subj` (see `jmdictLookup.ts`'s
 * `isNominalHeadedFlatVV` — the same signal that excludes this pair from
 * compound-span fusion, since 直 here is a real predicate of its own, not
 * part of a fused word). Such a predicate has no explicit 而/comma
 * connector at all (unlike しかして's stative conj:coord pivot) — it's bare
 * juxtaposition — so it needs renyoukei to function adverbially into the
 * main predicate that still follows: 木直中繩 -> 木、直く繩に中る ("the wood,
 * [being] straight, conforms to the line"), not a bare shuushikei 直し
 * stranded mid-clause with nothing to attach it to what follows. */
function isStativeSubjectModifier(token: Token, sentence: Sentence): boolean {
  if (token.dep !== "flat@vv" || parseMorphFeatures(token.morph ?? "").Degree !== "Pos") return false;
  const governor = sentence.tokens.find((t) => t.id === token.head);
  return governor?.dep === "subj";
}

/** Aspectual/purposive verbs (就 — "to go on to, to undergo/submit to X")
 * that take a *nominalized verbal action* as their complement, not an
 * ordinary noun object — SUD still tags that complement `comp:obj` (there's
 * no dedicated relation for "nominalized verbal complement"), so this can't
 * be a general "any VERB comp:obj of a VERB governor" rule: that would also
 * wrongly catch a governor's own genuinely *independent* clausal
 * complement (有朋自遠方來's 來, 子曰「...」's quoted 習 — both complete
 * predications in their own right, correctly staying shuushikei) — trying
 * exactly that broader rule live-regressed both of those established
 * anchors. 就's complement functions as a converb feeding into 就 itself
 * (金就礪 -> 金礪き就く, "metal undergoes being ground," not 金礪く就く) —
 * renyoukei, the same "this verb isn't the finite predicate, something
 * still follows it" logic as this function's other triggers. Bounded to
 * this one verified lemma rather than generalized further. */
const ASPECTUAL_VERB_LEMMAS: ReadonlySet<string> = new Set(["就"]);

function isAspectualVerbComplement(token: Token, sentence: Sentence): boolean {
  if (token.dep !== "comp:obj") return false;
  const governor = sentence.tokens.find((t) => t.id === token.head);
  return !!governor && ASPECTUAL_VERB_LEMMAS.has(governor.lemma);
}

/** The relations that string predicates into one chain.
 *
 * `parataxis` belongs here with the `conj:coord` pair, on the parser's own
 * evidence: it labels a coordination `conj:coord` only when an explicit
 * coordinator is present, and falls back to `parataxis` for the asyndetic
 * case — 飲酒食肉 and 讀書習禮 both come back `parataxis`, while 子釣而不綱
 * and 學而時習之 come back `conj:coord`. Restricting this to `conj:coord`
 * would therefore fix only the chains that carry a 而, which the 而 rule
 * above already handles, and leave every asyndetic chain — the ones
 * actually reading wrong — untouched. */
const COORDINATION_DEPS: ReadonlySet<string> = new Set(["conj:coord", "conj:coord@emb", "parataxis"]);

/** The subset of those across which a *nominal* conjunct still counts as a
 * link in the chain — see `isNonFinalCoordinand`.
 *
 * `parataxis` is deliberately not here, and that is the whole reason this
 * exists as a second set rather than the walk simply dropping its verb test.
 * The mixed uses that relation carries — a quotative frame and what it
 * introduces, an appositive clause and its host — are exactly the ones whose
 * far end is a nominal, so admitting nominals across `parataxis` would let
 * the walk wander out of the chain in precisely the cases the verb test was
 * put there to stop. An explicit coordinator is what the parser reserves
 * `conj:coord` for, and that is evidence enough that the two really are
 * conjuncts. */
const NOMINAL_COORDINATION_DEPS: ReadonlySet<string> = new Set(["conj:coord", "conj:coord@emb"]);

/** The marks that **close a clause outright**, as against the ones that divide
 * items inside one. Read only by `coordinationSpansStop`, which is what stops a
 * coordination chain running across one.
 *
 * **Not `punctuation.ts`'s own `isSentenceFinalPunct`.** That set answers where
 * this app *segments* a text; this one answers whether two coordinated words
 * are one phrase, and on ， the two come apart: a ， sides with 、. Over
 * `lzh-{train,dev,test}` a ， stands inside a nominal coordination chain **490**
 * times where no 。 does, every one a genuine list — 一簞食，一瓢飲 ·
 * 宗廟之美，百官之富 · 君臣上下，父子兄弟 · 五母雞，二母彘 — which take one
 * particle after the whole enumeration.
 *
 * **； and ： were here, were taken out on the reader's instruction, and ： is
 * back — because the reader has since ruled that alignment with the received
 * text decides, and it measures.** The argument for taking them out was that
 * neither closes a chain: both mark material too closely bound to stand apart,
 * a ： *introducing* what follows and a ； joining clauses that are one
 * construction, so 孝弟，而好犯上者，鮮矣 reads 鮮 as あざやかにして across its ；.
 * The measurement behind it was that of the 33 nominal-or-predicate chains
 * spanning a ； or a ： over the recoded gold, **26** have 而 as the very next
 * token — 輒半種黍；而家豪富 · 萬物之率也；而時勢者… · 楚之耎國；而秦… — so the
 * traffic was almost entirely chains the source itself marks as continuing, and
 * the 7 remaining boundaries did not pay for a rule.
 *
 * **Against kanbun.info the 7 pay handsomely.** Restoring ： alone reads **21
 * edits better on the gold tier and level on the parser tier**: 23 passages
 * move, 20 of them closer and 3 further (論語 8.03, 16.08 and 16.10, one edit
 * each). Every one of them is 論語, and the parser tier does not move at all,
 * which is the whole shape of the finding — the ： is the *treebank's* mark for
 * a boundary kanbun.info's own 白文 writes as a 。, so this is only ever reached
 * on a gold passage. 吾黨之直者、異於是：父爲子隱 is the case: the received text
 * closes on 是に異**なり** and the app wrote the 連用中止 異**に**, because the
 * parse hangs 隱 off 異 as a `parataxis` and the mark between them was not one
 * this set held. 我則異於是，無可無不可 (論語 18.08) is the same shape written
 * with a ，, and is the one this still does not reach: nothing here can tell an
 * enumerating ， from a sentence-ending one.
 *
 * **； is deliberately not restored with it.** It was not measured here, and the
 * 而 argument above is about ； first of all — 26 of the 33 chains it counted
 * carry one. 適以益貧：豈飲啄固有數乎？, which that note diagnosed as a chain
 * reaching into a rhetorical question rather than as a fact about the mark, is
 * cut by this restoration as well; the diagnosis stands and the ？ that answers
 * it was already in this set. */
const CLAUSE_CLOSING_MARKS: ReadonlySet<string> = new Set(["。", "．", "？", "！", "："]);

/** Whether a sentence-closing mark stands between two coordinated tokens — the
 * one thing that ends a coordination chain short of its last conjunct.
 *
 * **The user's rule is that chain inversion applies only to contiguous
 * conjuncts, and this is the half of it the corpus supports.** Measured over
 * `lzh-{train,dev,test}.sud.conllu`, 4,566 of the 16,508 nominal coordination
 * chains (27.7%) have *some* stop between two consecutive members — and a
 * blanket guard on that would be wrong, because **、 is the enumeration mark**
 * and putting one between conjuncts is how a list is written: 伯夷、叔齊 ·
 * 巧言、令色、足恭 · 堯、舜 · 齋、戰、疾 · 怪、力、亂、神 all carry one, and all
 * of them want a single particle after the *last* member, which is exactly
 * what the chain machinery gives them. 4,912 of the stops found inside chains
 * are 、.
 *
 * What a chain must not do is cross a **sentence**. 傳昭明。相士。昌若。曹圉。
 * is four sentences of one name each, and the parse coordinates all four; one
 * particle after 曹圉 would be marking a phrase that spans four full stops.
 * That is **586** nominal chains (3.6%) and **686** predicate chains (2.1%),
 * and it is the whole of what this refuses.
 *
 * **It does not reach 酒蟲's 或言 quotation, and that is the finding.** 病 and
 * 僧 there are separated by a 、, so on the evidence above they are contiguous
 * conjuncts and the chain is right to join them. What is wrong is upstream:
 * 僧愚之以成其術 is a clause of its own — "the monk fooled him and thereby
 * achieved his art" — so **僧(16) is not a `conj:coord` of 病(14) at all**; it
 * is the subject of that clause, and 愚(17) is its verb rather than 僧's
 * `flat@vv`. See the report. */
function coordinationSpansStop(a: Token, b: Token, sentence: Sentence): boolean {
  const [lo, hi] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
  return sentence.tokens.some(
    (t) =>
      t.dep === "punct" &&
      t.id > lo &&
      t.id < hi &&
      CLAUSE_CLOSING_MARKS.has(t.text),
  );
}

/** Every nominal conjunct in the chain `token` belongs to, head first — the
 * one phrase that a single case particle marks.
 *
 * 縶手足 is two hands of one object: 手 is 縶's `comp:obj` and 足 is `conj:coord`
 * onto 手, and what the sentence means is "binds [hands and feet]". Japanese
 * marks that once, after the whole phrase — 手足を縶ぐ — where
 * `CASE_PARTICLE_FOR_DEP`, asked about each token on its own, put を on 手
 * (which carries the relation) and nothing on 足 (whose own dep is not in that
 * table at all), giving 手を足縶ぐ: a particle inside its own phrase.
 *
 * **The same split every other group in this file makes**, and named the same
 * way: `compoundSuruOkurigana` and `generator.ts`'s span branch write a fused
 * span's ending after its *last member* while taking the *carrier's* relation
 * to decide what that ending is, `quantityPredicateCarrier` puts a
 * predication's あり on whichever part of the quantity is said last, and
 * `conjugationSubject` asks a タリ group's stem for the form its suffix writes.
 * A coordination chain is one more group of that shape: the head holds the
 * phrase onto the sentence and the last member is where what marks the phrase
 * is written.
 *
 * **Nominals across an explicit coordinator only**, which is
 * `NOMINAL_COORDINATION_DEPS` and not `COORDINATION_DEPS`. `parataxis` is the
 * mixed relation `isNonFinalCoordinand` documents at length — it also links a
 * quotative frame to what it introduces — and a case particle dragged across
 * one would land in a different clause. Both ends of every edge must be
 * nominal for the same reason: a *predicate* coordinated onto a nominal is a
 * second clause, not a second thing marked by the first one's particle.
 *
 * Kept separate from `isNonFinalCoordinand` rather than expressed through it,
 * though the two ask overlapping questions. That one decides a *conjugation
 * form* and admits verbs and `parataxis` to do it; this one decides where a
 * *particle* is written and must not follow either. Sharing the walk would
 * have tied the narrower rule to the wider one's reach. */
function nominalCoordinationChain(token: Token, sentence: Sentence): Token[] {
  const byId = new Map(sentence.tokens.map((t) => [t.id, t]));
  const isNominal = (t: Token) => NOMINAL_PREDICATE_POS.has(t.pos);
  if (!isNominal(token)) return [token];

  let head = token;
  const climbed = new Set<number>([token.id]);
  for (;;) {
    if (!NOMINAL_COORDINATION_DEPS.has(head.dep)) break;
    const governor = byId.get(head.head);
    if (!governor || governor.id === head.id || climbed.has(governor.id) || !isNominal(governor)) break;
    if (coordinationSpansStop(head, governor, sentence)) break;
    climbed.add(governor.id);
    head = governor;
  }

  const members = [head];
  const pending = [head];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const t of sentence.tokens) {
      if (t.head !== current.id || t.id === current.id) continue;
      if (!NOMINAL_COORDINATION_DEPS.has(t.dep) || !isNominal(t)) continue;
      if (coordinationSpansStop(current, t, sentence)) continue;
      if (members.some((m) => m.id === t.id)) continue;
      members.push(t);
      pending.push(t);
    }
  }
  return members;
}

/** The coordinators after which kundoku writes **a second と after the last
 * conjunct** — see `coordinationClosingParticle`. 與 and its 新字体 与 only. */
const TO_COORDINATORS: ReadonlySet<string> = new Set(["與", "与"]);

/** The と that closes a 與 coordination. Named apart from `PREDICATIVE_PARTICLE`,
 * which is the same kana marking a different thing (the complement of 爲). */
const COORDINATION_CLOSING_PARTICLE = "と";

/** **A與B is AとBと**, and the second と goes after B, ahead of whatever case
 * particle the whole phrase takes: 鬻楯與矛 is 楯と矛とを鬻ぐ, 性與天道 is
 * 性と天道とを言ふ, 文與武 is 文と武とは. Answers "と" for the token that closes
 * such a chain, and undefined for every other token.
 *
 * The first と is 與 itself (`overrides.json` reads the ADP/CCONJ 與 と), and
 * nothing wrote the second one, so the app printed 楯と矛を鬻ぐ. kanbun.info
 * states the rule in its own note on the passage (「A与B」の場合は、「AとB与」と
 * 読む), and the received readings keep it. Of the nominal 與 coordinations
 * in its parsed passages whose received reading coordinates the two nouns at
 * all, all but two write the second と: 女と回と孰れか, 性と天道とを, 聖と仁との
 * 若き, 利と命と仁とを, 由と求とは, 父と君とを, 玄囂と蟜極とより, 後母と弟とに,
 * 絺衣と琴とを, 弓と弩とを, 車騎と徒とを, 文と武とは, 敵と将とは, 貴と富とを,
 * 飛江と転関と天潢とを, 呉と膠西とは. The two that do not are 楽と餌には and
 * 人と地を.
 *
 * **Written once, on the carrier**, which is where every particle of a
 * nominal chain is written (see the chain block in `caseParticleFor`): 利與命與
 * 仁 is 利と命と仁とを, three と and not four, because the two inside the
 * phrase are the two 與.
 *
 * **Keyed on the coordinator that introduces the last conjunct**, so a chain
 * mixing 及 and 與 follows its own last link: 父及後母與弟 is 父及び後母と弟とに.
 * 及 is not in the set: the received readings write 及 as および, a
 * coordinator complete in itself that no と follows — 王及び諸侯,
 * 漢軍及び諸侯の兵, 公及び桓楚をして, six of the six nominal 及 coordinations
 * in the same passages.
 *
 * **Only a nominal chain, and only a `cc` 與.** The verb 與 ("give", 與人), the
 * preposition 與 heading its own phrase (與民同樂) and 與其… all stand on other
 * relations and never reach here. A comitative 與 the parser has taken for
 * coordination (瞽叟與象共下) does get the と, which the received reading does
 * not write (瞽叟、象と共に); that parse makes 瞽叟 and 象 one subject, and the
 * と is the right reading of the tree as given.
 *
 * **Asked by `particleStack.ts` rather than by `caseParticleFor`**, and the
 * split is deliberate: `caseParticleFor` answers what case the *relation*
 * wants, and three callers outside the two panels ask it that question (a
 * copula check among them) and must not see a と that marks no case. */
export function coordinationClosingParticle(token: Token, sentence: Sentence): string | undefined {
  if (!NOMINAL_PREDICATE_POS.has(token.pos) || !NOMINAL_COORDINATION_DEPS.has(token.dep)) return undefined;
  const chain = nominalCoordinationChain(token, sentence);
  if (chain.length < 2) return undefined;
  if (chain.some((t) => t.id > token.id)) return undefined;
  const introducedByTo = sentence.tokens.some(
    (t) => t.head === token.id && t.id !== token.id && t.dep === "cc" && (TO_COORDINATORS.has(t.lemma) || TO_COORDINATORS.has(t.text)),
  );
  return introducedByTo ? COORDINATION_CLOSING_PARTICLE : undefined;
}

/** True when `token` is a **noun compound** — a nominal the *parse* fuses with
 * a neighbour by one of `NAME_FUSING_DEPS` (豪+富, 飲+食, 劉+氏).
 *
 * The reader's rule: *if a noun compound is conjoined with a predicate, then it
 * must be a predicate as well, and should take the 連用形 of なり.* It is a
 * compound and not a nominal in general, and the narrowing is the whole of what
 * makes the rule safe to apply across `parataxis` — see `predicateCoordinationChain`
 * and `isCoordinateClauseHead`, both of which admit a bare nominal only across
 * an explicit coordinator, on the ground that `parataxis` also links a
 * quotative frame to what it introduces and an appositive clause to its host,
 * whose far ends are exactly the bare nominals.
 *
 * **Measured** over
 * `lzh_kyoto-sud-{train,dev,test}.relabeled_ext.udep_ruled.punct.rulemerged.adjfix.conllu`:
 * a nominal hangs off a predicate by `parataxis` **64** times, and **1** of the
 * 64 is a compound (圖羽, in 亦勸權圖羽操師救樊). So the widening this predicate
 * licenses reaches one gold edge where dropping it would reach 64 — and the
 * conj:coord half, which needs none of this, is where the reader's own case
 * lives: 而家豪富 has 豪 `conj:coord` onto 種 with 富 `flat` onto 豪, and already
 * reads 家豪富にして.
 *
 * **A multi-character *token* is deliberately not one of these**, and the
 * distinction was reached by breaking an anchor and measuring rather than by
 * taste. 王學君子 with 君子 arriving as one NOUN token on `parataxis` is the
 * app's own anchor for the restriction this widens (*"does not widen what
 * parataxis may reach"*, `tests/kakikudashi-generator.test.ts`), and its stated
 * reason is precisely a quotation or an appositive at the far end of the
 * relation — which is a multi-character nominal and nothing else. So the token
 * arm admitted exactly the case the anchor forbids. It also has no corpus behind
 * it: of the 64 nominals hanging off a predicate by `parataxis` in the recoded
 * gold, 61 are one character and the 3 that are not are tokenizer fusions of the
 * same kind. What is left is the *parse's* own fusing relation, which says the
 * two characters are one word because the tree says so.
 *
 * Everything else is refused however it is coordinated, so the widening can only
 * ever add a link the chain walk could not see, never remove one. */
function isCompoundNominal(token: Token, sentence: Sentence): boolean {
  if (!NOMINAL_PREDICATE_POS.has(token.pos)) return false;
  return sentence.tokens.some(
    (t) =>
      t.id !== token.id &&
      ((NAME_FUSING_DEPS.has(t.dep) && t.head === token.id) || (NAME_FUSING_DEPS.has(token.dep) && token.head === t.id)),
  );
}

/** True when `token` is a member of a chain of coordinated predicates and
 * something further in that chain still follows it.
 *
 * Only the *last* conjunct carries the sentence's finite predicate; every
 * earlier one is continuative, so 飲酒食肉 reads 酒を飲み肉を食ふ, not 酒を
 * 飲む肉を食ふ.
 *
 * The chain is collected by walking coordination edges *transitively*, in
 * both directions, rather than by taking one head and its direct children.
 * SUD's own convention is that every later conjunct hangs off the first, and
 * this parser does follow it much of the time (民饑而死、士寒而病、國亡 comes
 * back with 病 and 亡 both attached to 寒) — but not always: 食肉飲酒歌舞
 * comes back with 飲 attached to 食 and 歌 attached to *飲*, one link further
 * down. Reading only the direct children of a single head sees that chain as
 * the two separate pairs {食,飲} and {飲,歌}, makes 飲 the last member of the
 * first pair, and gives it the finite 飲む in the middle of the sentence —
 * 肉を食ひ酒を飲む舞ふ歌ふ. Walking the whole connected component gets the one
 * chain the sentence actually has, and only its genuinely last member ends
 * it.
 *
 * Each step must be a predicate at both ends — a verb, or a bare nominal
 * across an explicit coordinator (see `NOMINAL_COORDINATION_DEPS`).
 * `parataxis` in particular is a mixed relation — it also links a quotative
 * frame to what it introduces, and an appositive clause to its host — and
 * demoting a predicate to 連用形 there would be wrong; keeping the far end of
 * a `parataxis` edge verbal keeps this to chains of predicates, and stops
 * the transitive walk from wandering out of one. (The commonest such frame,
 * 子曰, never reaches here anyway: 曰 is a `fixedReading` lexicon entry,
 * which short-circuits ahead of any conjugation decision.)
 *
 * **The conjugation class is not a parameter, and no longer one.** A third
 * argument used to carry it here so that the four adjectival paradigms
 * (ク/シク形容詞, ナリ/タリ形容動詞) could be refused outright, and its own note
 * said what that was: "a narrowing to what was asked for, not a claim that
 * adjectives behave differently", since a non-final *adjective* conjunct does
 * take 連用形 in classical Japanese — 山高く水長し. The narrowing is gone, and
 * with it the only reason this function ever had to know a paradigm: the rule
 * is now the one the grammar states, that whatever a conjunct inflects by, only
 * the last member of a chain carries the finite predicate. Three readings moved
 * with it, one per class shape:
 *
 *  - **タリ形容動詞** — 劉愕然、便求醫療 reads 劉愕然として、すなはち醫療を求む
 *    where it read 劉愕然たり, a 終止形 closing a sentence the tree says is still
 *    open. として *is* たり's 連用形 (see `classicalConjugation.ts`), not a
 *    connective added on top of one, so this is the same bare 連用中止法 the
 *    verbs take, and nothing appends a further て to it: `converbSuffix` refuses
 *    the class, and a 而 that would write one stands down
 *    (`precedingFormSuppliesShite`). 愕然 with no chain onto it is untouched and
 *    still closes — 愕然たり.
 *  - **ク/シク形容詞** — 體漸瘦、家亦日貧、後飲食至不能給 reads 家亦日に貧しく
 *    where it read 貧し, and 山高、水長 reads 山は高く、水は長し, which is the
 *    textbook example the old note named against itself.
 *  - **ナリ形容動詞** — 王仁、愛民 reads 王仁に、民を愛づ. The paradigm's own
 *    連用形 is the bare に, where the *synthesized* copula this file writes for a
 *    bare nominal predicate has にして (`COPULA.renyou` — 王仁人にして智). Both
 *    are 連用中止法 and に is what the ナリ table holds, so it stands; the
 *    asymmetry is between a 形容動詞 inflecting itself and a noun being handed a
 *    copula, and is not this rule's to settle.
 *
 * None of that ever concerned an adjective standing at the *far* end of an
 * edge: up to parser 0.3.1 a descriptive word was tagged VERB with `Degree=Pos`
 * (賢 in 王學而賢), so such a conjunct was verbal here and had always been
 * walked to. From 0.3.2 it is tagged ADJ instead, and the walk reaches it
 * because `predicateCoordinationChain`'s `isVerbal` was widened to say so —
 * see the note there on why ADJ moved from the nominal arm to the verbal one.
 *
 * **It did concern one standing at the *near* end, and that is what the gate
 * below now admits.** That `links` test had always counted an `ADJ` neighbour
 * as a further link across an explicit coordinator, for the reason written
 * there — under 0.3.1 the tag was the rare exception, used for the denominal
 * 豪 of 酒蟲 and little else. The token being *asked about* was held to VERB/AUX alone, so the same
 * word was a predicate when the walk arrived at it and not a predicate when the
 * question was put to it. The reader's own 劉愕然、便求醫療 is where the two
 * halves meet: 愕 is `root` and ADJ, 求 is its `conj:coord`, and 然 is a タリ
 * suffix whose form question `conjugationSubject` puts to that 愕 — so the chain
 * {愕, 求} was found, 求 was correctly its last link, and the gate discarded the
 * answer before it could be used. 愕然たり closed a sentence with a coordinated
 * predicate still to come; it now reads 劉愕然として、すなはち醫療を求む, which
 * is the very reading the タリ bullet above already claims. (The タリ *binom*
 * has to be recognised for any of this to matter: 然 must be `unk`, which is
 * what the treebank tags a suffixing 然 — see `isTariSuffix`.)
 *
 * ADJ and not "anything at all": the `nominalPredicate` escape below is what a
 * caller uses when it knows it is asking about a synthesized copula, and
 * widening this gate to every POS would answer for tokens no rule here has
 * decided is a predicate. A descriptive adjective is one by its tag. */
export function isNonFinalCoordinand(
  token: Token,
  sentence: Sentence,
  /** Ask about a token that is not itself a verb. A *nominal* predicate
   * chains exactly as a verbal one does — 王仁人にして智…, the 人 handing on
   * to the 智 coordinated onto it — and the verbs-only gate below, which is
   * about which tokens `decideConjForm` may demote, was silently answering
   * "no" for every synthesized copula and existence ending `selectForm` asks
   * about. The chain is still walked verb-to-verb: only this token, the one
   * being asked about, is allowed not to be one. */
  nominalPredicate = false,
): boolean {
  // The ADJ arm here was written when the tag was the rare exception; under
  // 0.3.2 it is the ordinary tag for a stative and this is simply the
  // predicate test — see `isContentPredicatePos`.
  const isPredicate = (t: Token) => isContentPredicatePos(t.pos) || t.pos === "AUX";
  if (!nominalPredicate && !isPredicate(token)) return false;
  const members = predicateCoordinationChain(token, sentence);
  if (members.length < 2) return false;
  return token.id !== lastLinkOf(members).id;
}

/** True when a **numeral is coordinated onto this nominal and follows it** —
 * 赤肉、長三寸許, where 肉 is a NOUN and the 三 of the measurement hangs off it.
 * The reader's rule: *a noun coordinated with a following numeral should be in
 * 連用形.*
 *
 * A quantity standing after a noun in this shape is a second predication about
 * it — "[it was] red flesh, [it was] three inches long" — so the noun is
 * predicative and non-final, exactly as any other non-final conjunct in this
 * file is, and the copula it is handed goes into its 連用形: 赤肉**にして**、
 * 長さ三寸許にして…, where it read 赤肉**なり** and closed a sentence the rest of
 * the line carries on from. (`COPULA.renyou` is にして throughout, the same
 * にして 王仁人にして智 takes; the ナリ活用 bare に is what a 形容動詞 inflecting
 * *itself* writes, and a noun handed a copula is the other side of the
 * asymmetry `isNonFinalCoordinand` documents.)
 *
 * **Why this is its own rule and not a widening of the chain walk.** The chain
 * `predicateCoordinationChain` builds admits a nominal conjunct only across
 * `NOMINAL_COORDINATION_DEPS` (an explicit coordinator), and admits nothing at
 * all on the far side of a `parataxis` that is not a verb — both deliberate,
 * both documented there. 三 is a NUM on a `parataxis`, so it fails on each
 * count, and the walk from 肉 found the chain {解, 視, 肉} with 肉 last: a noun
 * closing the sentence, which is what the なり was. Admitting NUM to the walk
 * would have widened every rule that reads it (a case particle dragged across
 * an edge, a protasis's ば, a negation's 連用形), for one shape.
 *
 * **The direction is part of the rule and is tested for.** A numeral *before*
 * the noun is its modifier — 一甕, 三百畝 — and says nothing about the noun
 * being predicative; only a numeral read after it is a further predication.
 * `coordinationSpansStop` is asked for the reason every other coordination
 * test in this file asks it: a conjunct across a full stop is in another
 * sentence.
 *
 * **Measured.** Over `lzh_kyoto-sud-{train,dev,test}` a nominal carries a
 * following NUM on a coordination relation **35** times, every one of them
 * `conj:coord` (旬有二日, 軍旅什伍, 五色六章十二衣, 建炎戊申) and **none**
 * `parataxis` — while the reader's own 赤肉長三寸許 is the `parataxis` one. Both
 * relations are admitted, through `COORDINATION_DEPS`, because the distinction
 * between them is the presence of an explicit coordinator and not anything
 * about what is being said. The 35 are an upper bound on the reach and not the
 * reach: this is read only from `selectForm`, i.e. only about a token this file
 * has *already* decided to hand a synthesized copula, and a numeral enumeration
 * sitting inside a larger clause is given none. */
function isCoordinatedWithFollowingNumeral(token: Token, sentence: Sentence): boolean {
  if (!NOMINAL_PREDICATE_POS.has(token.pos)) return false;
  return sentence.tokens.some(
    (t) =>
      t.head === token.id &&
      t.id > token.id &&
      t.pos === "NUM" &&
      COORDINATION_DEPS.has(t.dep) &&
      !coordinationSpansStop(token, t, sentence),
  );
}

/** The member of a coordination chain that is said last — the one link that
 * carries whatever closes the whole chain, be that the sentence's finite
 * predicate (`isNonFinalCoordinand`) or a protasis's ば
 * (`isConditionalTemporalClause`).
 *
 * **Source order, and the two orders cannot come apart here.** Reading order
 * would be the stronger question to ask in general — `reorderEngine.ts`'s
 * `lastMeaningful` asks exactly that when it decides which character a kaeriten
 * leaves from — but a coordination chain is the one structure where the answer
 * is the same either way: `conj:coord`/`parataxis` are NO-INVERT relations, so
 * every conjunct is read at its source position, and a later conjunct's own
 * dependents are read inside that conjunct's own stretch. What the reorder
 * engine's note calls "asking for the last token *read*" differs from asking
 * for the last *conjunct* only in reaching that conjunct's post-dependents,
 * which are not chain members and never carry the chain's ending. Measured
 * against `lzh-{train,dev,test}.sud.conllu`: over all **223** predicate chains
 * whose head heads a すなはち-class protasis, the last member by source id and
 * the last member in `computeReadingOrder`'s own order are the same token
 * **223 times out of 223**. Source order it is, and nothing in the corpus
 * distinguishes the two. */
function lastLinkOf(members: readonly Token[]): Token {
  return members.reduce((last, t) => (t.id > last.id ? t : last), members[0]);
}

/** Every predicate coordinated with `token`, itself included — the connected
 * component of coordination edges it sits in.
 *
 * Split out of `isNonFinalCoordinand`, whose doc below describes the walk and
 * why it is transitive and bidirectional, so that a second rule can ask which
 * member of a chain is said last without asking that one for a conjugation
 * form. `isConditionalTemporalClause` is that caller: a protasis built out of
 * coordinated verbs *ends* on a token the `mod` relation is not on
 * (學而不思則罔 heads its protasis on 學 and closes it on 思), so it needs the
 * chain in order to find the head, exactly as `nominalCoordinationChain`'s
 * callers need it in order to find the member a case particle is written on.
 *
 * Kept apart from `nominalCoordinationChain` for the reason that one's own doc
 * gives: it walks a narrower set of edges, because a case particle dragged
 * across a `parataxis` would land in a different clause. */
function predicateCoordinationChain(
  token: Token,
  sentence: Sentence,
  /** Which relations count as a coordination edge. `COORDINATION_DEPS` — the
   * default, and what every form rule asks for — admits the asyndetic
   * `parataxis` beside the explicit `conj:coord`. `closesArgumentChain` passes
   * the narrower `NOMINAL_COORDINATION_DEPS` instead, for the reason
   * `nominalCoordinationChain` gives about its own walk: a *case particle*
   * dragged across a `parataxis` lands in a different clause. */
  coordinationDeps: ReadonlySet<string> = COORDINATION_DEPS,
): Token[] {
  const isVerbal = (t: Token) => isContentPredicatePos(t.pos) || t.pos === "AUX";

  // The connected component of coordination edges containing this token,
  // reached from it in both directions: up to the conjunct it is coordinated
  // onto, and down to every conjunct coordinated onto it.
  //
  // A conjunct that is a bare nominal counts too, across an explicit
  // coordination edge (see `NOMINAL_COORDINATION_DEPS`). Literary Chinese
  // predicates with a bare noun and no token realizing the "is", so
  // 生而神靈 and 王學君子 are a verb and a *nominal* predicate coordinated,
  // exactly as 飲酒食肉 is two verbal ones — and the verb-only walk could not
  // see the second conjunct at all, found a chain of one, and left the verb
  // closing the sentence it is only half of (王學君子 read 王學ぶ君子…). Each
  // edge is tested on its own dep, so admitting a nominal never widens what
  // `parataxis` may reach.
  const byId = new Map(sentence.tokens.map((t) => [t.id, t]));
  // **A token the sentence does not contain is a chain of one.** Not a
  // hypothetical: `readingResolver.ts` asks `caseParticleFor` about a token
  // held against an empty sentence when it resolves a word on its own (see
  // `readingEndingSplit`, and the fallback-chain tests in
  // `tests/reading.test.ts`), and every walk below reaches its members through
  // `byId` — `spanMates` first of all, which would hand a neighbour of
  // `undefined` to the loop. The older callers never met this because each of
  // them spends its POS and xpos gates before asking for a chain;
  // `closesArgumentChain` has to know which member of a chain is last before it
  // can put its rule to any of them, so it asks about every token there is.
  if (!byId.has(token.id)) return [token];
  const members = new Set<number>([token.id]);
  const pending: Token[] = [token];
  // A conjunct counts as a further link when it is itself a predicate: a verb
  // or an adjective, or — across an explicit coordinator only — a bare nominal.
  //
  // **`ADJ` has moved from the nominal arm to the verbal one, and the move is
  // the 0.3.2 recoding.** It sat with the nominal because the tag was rare and
  // unlike itself: the parser tagged most descriptive words VERB with
  // `Degree=Pos`, and the handful that did come back ADJ were 酒蟲's 豪 and 富,
  // Sino-Japanese denominals with a *noun* xpos. Restricting them to
  // `NOMINAL_COORDINATION_DEPS` was the right caution then — `parataxis` keeps
  // a verb at its far end, so the walk could not wander out of the chain on the
  // strength of a tag nothing had measured. Under 0.3.2 ADJ is the ordinary tag
  // for a stative predicate, its xpos is `v,動詞,描写,…`, and it stands on the
  // coordination relations in quantity: **1,099** ADJ tokens on `conj:coord`
  // and **642** on `parataxis` over the recoded gold. Kept on the nominal arm
  // those 642 would have stopped being links at all — where under 0.3.1, as
  // VERBs, every one of them was one — and the verb before each would have
  // closed a sentence it is only half of, which is the exact failure the ADJ
  // arm was added to fix. The nominal restriction stays for the nominals.
  //
  // **A noun *compound* is a further link across `parataxis` too**, which is the
  // one place the nominal restriction is lifted and is the reader's own rule:
  // *if a noun compound is conjoined with a predicate, then it must be a
  // predicate as well.* 飲食 standing as a `parataxis` conjunct of 肥 was not a
  // link at all, so the chain was one member long and 飲食 closed a clause it is
  // only half of — 飲食肥ゆ, where the reading is 飲食にして肥ゆ. What keeps the
  // restriction meaningful for everything else is that a compound is what the
  // mixed uses of `parataxis` do *not* have at their far end; see
  // `isCompoundNominal` for the 1-in-64 measurement.
  const links = (neighbour: Token, edgeDep: string): boolean =>
    isVerbal(neighbour) ||
    (NOMINAL_PREDICATE_POS.has(neighbour.pos) &&
      (NOMINAL_COORDINATION_DEPS.has(edgeDep) || isCompoundNominal(neighbour, sentence)));

  /** The tokens fused into one word with `t` — see `NAME_FUSING_DEPS`.
   *
   * A span is a single predication, so a conjunct hanging off *any* of its
   * members is a conjunct of the whole: 酒蟲's 而家豪富、不以飲為累也 attaches
   * 為 to 富, the second half of the 豪富 span, and asking only about 豪 (the
   * carrier, which is what everything else asks about) found no conjunct and
   * closed the clause. The mates are looked *through*, never counted: they
   * are the same predicate, not a further one, and adding them as members
   * would make a span with nothing after it look like a two-link chain and
   * demote its own ending. Uses this file's own copy of the fusing relations
   * rather than importing `findCompoundSpans`, which would knot the reading
   * layer back into this one — the same reason `NAME_FUSING_DEPS` exists. */
  const spanMates = (t: Token): Token[] => {
    const mates = new Set<number>([t.id]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const other of sentence.tokens) {
        if (mates.has(other.id)) continue;
        // Either direction of a fusing edge: `other` fused onto a member, or
        // a member fused onto `other`.
        const fusedOntoMember = NAME_FUSING_DEPS.has(other.dep) && mates.has(other.head);
        const memberFusedOnto = [...mates].some((id) => {
          const mate = byId.get(id);
          return !!mate && NAME_FUSING_DEPS.has(mate.dep) && mate.head === other.id;
        });
        if (fusedOntoMember || memberFusedOnto) {
          mates.add(other.id);
          grew = true;
        }
      }
    }
    return [...mates].map((id) => byId.get(id)!);
  };

  while (pending.length > 0) {
    const current = pending.pop()!;
    // Each edge carries which end of it is the dependent, so that the caused
    // predicate can be told from a conjunct — see the guard below, which is
    // the one question about an edge that cannot be answered from its
    // relation alone.
    const neighbours: { token: Token; edgeDep: string; dependent: Token; head: Token }[] = [];
    for (const mate of spanMates(current)) {
      if (coordinationDeps.has(mate.dep)) {
        const governor = byId.get(mate.head);
        if (governor && governor.id !== mate.id) {
          neighbours.push({ token: governor, edgeDep: mate.dep, dependent: mate, head: governor });
        }
      }
      for (const t of sentence.tokens) {
        if (t.head === mate.id && t.id !== mate.id && coordinationDeps.has(t.dep)) {
          neighbours.push({ token: t, edgeDep: t.dep, dependent: t, head: mate });
        }
      }
    }
    for (const { token: neighbour, edgeDep, dependent, head } of neighbours) {
      // A 使役's own caused predicate is not a conjunct of it, however the
      // parser labelled the edge. The two overlap in exactly one relation —
      // `parataxis`, which `isCausedPredicateOf` admits as the caused
      // predicate and `COORDINATION_DEPS` admits as an asyndetic conjunct —
      // and reading it as a conjunct made every 使役 with such a complement
      // look like a non-final link in a chain: 但令於日中俯臥 handed on with
      // 俯臥せしめ to a "next conjunct" that is the causative's own
      // complement. Asked of the *edge*, not of this token, so it holds
      // whichever end of it the walk arrives from.
      if (isCausedPredicateOf(dependent, head)) continue;
      // And a conjunct on the far side of a **full stop** is not a conjunct
      // either, for `coordinationSpansStop`'s own reason: a chain that crosses
      // a sentence would demote a finite predicate to 連用形 in a sentence that
      // has already ended. 686 of the corpus's 33,040 predicate chains (2.1%)
      // do that. Asked of the same edge and with the same set as the nominal
      // walk, so the two cannot disagree about where a phrase ends.
      if (coordinationSpansStop(dependent, head, sentence)) continue;
      if (!links(neighbour, edgeDep) || members.has(neighbour.id)) continue;
      members.add(neighbour.id);
      pending.push(neighbour);
    }
  }
  return [...members].map((id) => byId.get(id)!);
}

/** What an existential 有/無 asserts the existence of — its `comp:obj`,
 * whatever the POS of that is: 山中有虎 has a nominal there and 哇有物出 a
 * predicate, and neither takes a case particle (虎有り, 物の出づる有り).
 *
 * Lifted out of the two branches that used to ask it inline — `caseParticleFor`
 * withholds the particle and `decideConjForm` gives the 連体形 — so that both
 * can put the question to `closesArgumentChain` and get the same answer about a
 * chain. See that function; an existent with a conjunct on it is one existence
 * asserted of two things, 有畏而哭之 is 畏れて之を哭く有り, and the を the object
 * rule would otherwise have written onto the last link is exactly what this is
 * here to refuse. */
function isExistentialComplement(token: Token, sentence: Sentence): boolean {
  const governor = sentence.tokens.find((t) => t.id === token.head && t.id !== token.id);
  return !!governor && isExistentialPredicate(governor) && token.dep === "comp:obj";
}

/** **A note on こと for a clause standing as what an existential asserts — a
 * rule that was written, measured over the whole of kanbun.info, and taken out
 * again.** It is recorded here so it is not written a second time.
 *
 * **The proposal.** 有以見天地之𦣱 is received 以て天地の𦣱を見る**こと**有り, and
 * the app writes 見る有り. A clause cannot stand in a nominal slot in Japanese
 * without a nominalizer — the fact `isNominalizedSubjectPredicate` and
 * `isNegatedNengComplement` both answer with `SUBJECT_NOMINALIZER` — so a
 * clausal existent looked like the fourth member of that family. 「こと有」
 * stands **27** times in the corpus's 書き下し文 (皆能く養う**こと**有り ·
 * 其の力を仁に用うる**こと**有らんか · 衆を逃るる**こと**有るは).
 *
 * **What the corpus said.** Written as the narrowest version that reaches the
 * anchor — a verbal `comp:obj` of 有/無, eventive by xpos (a 描写 stative
 * refused, since 無過矣 is 過ち無し), with no subject of its own inside the
 * clause (哇有物出 is 物**の**出づる有り, where `inAttributiveClause`'s の already
 * nominalizes it) — it moved **213** passages for **+257 edits**, and nearly
 * every one of the 213 is a loss. The received readings write the bare 連体形
 * far more often than they write the こと, and on both halves of the
 * existential: 管氏三たび歸る有り · 君子に三たび畏る有り · 君子に九思ふ有り ·
 * 其の功を成す有るなり · 古より皆死ぬる有り · 近く憂ふる有り — and 適く無き ·
 * 怨む無し · 以て言ふ無し · 以て立つ無し · 唯だ酒に量る無く · 遠慮する無く.
 *
 * **So the 27 are the minority of their own class and nothing in the tree
 * separates them from the majority.** 有能一日用其力於仁矣乎 (こと) and
 * 博施於民而能濟衆 (no こと) are the same shape down to the 能 — a clausal
 * existent with an object and an auxiliary — and 君子亦有窮乎 (こと) is a bare
 * one-word clause like 君子有三畏 (no こと). Clause length, having an object,
 * having an auxiliary and the polarity of the existential were each looked at
 * and none of them draws the line. The こと is a choice the editor makes, not
 * something the sentence carries, and this app writes the majority reading.
 *
 * What 周髀's 見ること有り would need is a hand in the annotation or a fact the
 * tree does not hold, and it is left as one edit short rather than bought at
 * 257. */

/** True for **every member** of a chain an existential asserts, not only the
 * conjunct that carries the relation — 今有仁心仁聞而民不被其澤 has 心 and 聞
 * coordinated under 有, and neither of them takes a case particle: 今仁心仁聞
 * 有りて…, one existence asserted of the whole phrase.
 *
 * The one question in this file whose answer is the same for every link, and so
 * the one asked of the chain rather than of its last member: `caseParticleFor`
 * reads it to write *nothing*, and nothing is what the head and the carrier
 * alike take. Asking `closesArgumentChain` here instead would have suppressed
 * the carrier and let the head fall through to the branches below it — which is
 * `CASE_PARTICLE_FOR_DEP`'s blanket を for a nominal head (仁心**を**), the exact
 * particle-inside-its-own-phrase this round is removing. `decideConjForm` does
 * ask `closesArgumentChain`, because the 連体形 belongs to the last member alone
 * and the ones before it hand on in 連用中止法. */
function inExistentialChain(token: Token, sentence: Sentence): boolean {
  return predicateCoordinationChain(token, sentence, NOMINAL_COORDINATION_DEPS).some((m) =>
    isExistentialComplement(m, sentence),
  );
}

/** `readsLastInItsSubtree`'s `skip` for a rule that fills an argument slot: a
 * postposed negation, and a **conjunct of this token's own chain**.
 *
 * The negation is `negationEnding`'s exemption and is unchanged — 不 is read
 * after the predicate it negates and carries the particle itself, so it does not
 * block one (知らざること難し). A conjunct is the same kind of exemption one
 * relation over, and the same one `readsLastInItsSubtree` already makes for a
 * word this token is *fused* with: what follows a chain head is the rest of its
 * own phrase, and what marks that phrase is written after its last member (see
 * `closesArgumentChain`) rather than withheld because a further member exists.
 *
 * Without this the two rules that ask the subtree question could not see a
 * coordinated clause at all, and the particle was not misplaced but **missing**:
 * 治則進，亂則退，伯夷也 read 治りてすなはち進み、亂してすなはち退く、伯夷なり
 * with no こと anywhere, where the reading is 退く**こと**伯夷なり. **307** gold
 * clauses over `lzh_kyoto-sud-{train,dev,test}` were losing their こと or their
 * に this way, against the 701 whose を or が was written in the wrong place.
 *
 * Explicit coordinators only — `NOMINAL_COORDINATION_DEPS`, the same set
 * `closesArgumentChain` walks with, and they have to be the same: what is
 * skipped here is exactly what the particle is carried past there, and a rule
 * let through on a conjunct the particle then never reaches would write nothing
 * at all. A `parataxis` conjunct still blocks, as does any other child read
 * after this token. */
function argumentClauseSkip(token: Token, sentence: Sentence): (child: Token) => boolean {
  const conjuncts = new Set(
    predicateCoordinationChain(token, sentence, NOMINAL_COORDINATION_DEPS).map((m) => m.id),
  );
  return (child) => isNegationUse(child) || conjuncts.has(child.id);
}

/** True when the argument-slot rule `fillsSlot` holds of the coordination chain
 * `token` sits in **and** `token` is the member said last — the one link the
 * particle that marks the whole chain is written on.
 *
 * **The fault this mends is the app's, and the annotation is right.**
 * 介者不拜，**為其拜而蓌拜** ("the man in armour does not bow; his bowing is a
 * crouching bow") hangs 蓌 off 拜 by `conj:coord` with 拜 standing as the
 * prepositional 為's `comp:obj`, and gold is right about every edge of that. What
 * was wrong is where the app wrote the が: onto 拜, the conjunct that *carries*
 * the relation, which puts the particle inside the very construction it closes —
 * 其の拜む**が**て蓌拜する, with the て of the chain then following it. A particle
 * marking a phrase falls after the whole phrase: 其の拜みて蓌拜する**が**爲なり.
 *
 * **The nominal side of this file already answers exactly this question**, and
 * this is its counterpart rather than a second invention. 縶手足 is 手足を縶ぐ —
 * one を after the whole coordination — which `caseParticleFor`'s `onCarrier`
 * block writes by taking the relation off the chain's *head* and emitting the
 * particle on its *last member*. Head decides, last member carries: the same
 * split `compoundSuruOkurigana` makes for a fused span and `conjugationSubject`
 * for a タリ binome.
 *
 * **What could not be shared is the walk.** `nominalCoordinationChain` refuses a
 * non-nominal on its first line and requires both ends of every edge to be
 * nominal — the whole of what makes it safe, and the whole of what makes it
 * useless here. A predicate chain is `predicateCoordinationChain`'s, and that is
 * also the chain `isNonFinalCoordinand` demotes the non-final members with, so
 * asking it here is what keeps the form and the particle answering to one fact
 * about the sentence: the members put in 連用中止法 are exactly the members the
 * particle is written past.
 *
 * **The *edge set*, though, is the nominal one, and that half does transfer.**
 * `NOMINAL_COORDINATION_DEPS` — the explicit coordinator alone — is what this
 * passes to that walk, for the reason `nominalCoordinationChain`'s own doc gives
 * about particles: `parataxis` is a mixed relation, and a case particle dragged
 * across one lands in a different clause. 子在齊聞《韶》，三月不知肉味，曰：「…」
 * attaches 曰 to 知 by `parataxis`, and a を carried onto that 曰 would mark a
 * verb of speech in the next clause as what 知 knows. So the two questions
 * divide on the relation they may cross rather than on what counts as a
 * predicate. Measured over the recoded gold: **16,911** predicate chains of more
 * than one member stand on explicit coordinators against **27,056** counting
 * `parataxis`, and the **517** argument-slot predicates whose chain only
 * `parataxis` holds together (511 objects, 6 purposive 為 complements, no
 * subjects and no obliques) are left exactly as they were — the head keeps its
 * 連体形 and its particle, which is what a chain of one gets.
 *
 * **The population and where it goes**, per rule, over
 * `lzh_kyoto-sud-{train,dev,test}.relabeled_ext.udep_ruled.punct.rulemerged.adjfix.conllu`
 * — gold predicates filling an argument slot that stand non-final in an explicit
 * chain:
 *
 *     isNominalizedObjectPredicate   を    694   611 relocated, 83 withheld
 *     isNominalizedSubjectPredicate  こと  303   298 relocated,  5 withheld
 *     isNominalizedObliquePredicate  に      4     3 relocated,  1 withheld
 *     isPurposiveWeiComplement       が      7     5 relocated,  2 withheld
 *
 * **The four were failing in two different ways, which is why one fix had to
 * reach all of them.** を and が are written with no subtree test, so those 701
 * landed inside the phrase. こと and に ask `readsLastInItsSubtree`, which a
 * following conjunct always fails, so those 307 were never written at all —
 * see `argumentClauseSkip`, which is the half of this that lets a chain head
 * past that test.
 *
 * **`readsLastInItsSubtree` is still asked, of the carrier**, and that is where
 * the 91 withheld go: 秦豈得愛趙而憎韓哉 closes its chain on 憎, and gold hangs
 * the 哉 on 憎 rather than on the matrix 得, so a を written there would read
 * 憎む**を**かな. Nothing is written instead — the silence these rules already
 * keep wherever a particle cannot reach its place, and a smaller error than a
 * particle in front of a 終助詞. The postposed negation is skipped for
 * `negationEndingParts`' own reason: the ず stands at the clause's end and
 * carries the particle itself.
 *
 * **A chain of one is answered by the rule alone**, on the first line below, so
 * nothing outside a coordination can move: what this changes is bounded to the
 * 1,008 above by construction.
 *
 * **One gold chain is a mis-annotation, and it is named rather than worked
 * around.** 為得罪於父，不得近 ("for having incurred blame with his father, he
 * could not approach") comes back with the matrix clause 不得近 as a `conj:coord`
 * of 得罪, which is the 為's own complement — so the が is now carried across the
 * comma onto the matrix verb, 罪を父より得、近づくを得ざる**が**爲に. The correct
 * annotation is the one `isPurposiveWeiComplement`'s doc measures 43 of: the
 * 為-phrase holds the matrix clause by `mod`, with the `comp:obj` covering 得罪
 * alone. Nothing here compensates for the tree it was given.
 *
 * Read by the four rules at both of the call sites that must agree
 * (`caseParticleFor` for the particle, `decideConjForm` for the 連体形) and by
 * `negationEndingParts`, which writes both of them onto a postposed ず — the
 * same three-way pairing each of those rules was already in.
 */
function closesArgumentChain(
  token: Token,
  sentence: Sentence,
  fillsSlot: (t: Token, s: Sentence) => boolean,
): boolean {
  const chain = predicateCoordinationChain(token, sentence, NOMINAL_COORDINATION_DEPS);
  if (chain.length === 1) return fillsSlot(token, sentence);
  if (lastLinkOf(chain).id !== token.id) return false;
  if (!chain.some((link) => fillsSlot(link, sentence))) return false;
  return readsLastInItsSubtree(token, sentence, (child) => isNegationUse(child));
}

/** True when a 毎/每 hangs off this token and will be read after it (see
 * `isDistributivePostpose`). What such a 毎 quantifies is an *occasion* —
 * "every time that …" — so the predicate it attaches to heads a nominalized
 * clause rather than closing a sentence, and takes 連体形: 毎得書 reads
 * 書を得るごとに, never 書を得ごとに.
 *
 * Invisible to `decideConjForm`'s ordinary "what follows in reading order"
 * machinery, which is why it needs its own check: 毎 is *pre*-verbal in the
 * source and only reaches its post-verbal reading position because
 * `classifyToken` postposes it, so what the form has to answer to is a child
 * of this token, not its neighbour. */
function hasDistributivePostposeChild(token: Token, sentence: Sentence): boolean {
  return sentence.tokens.some((t) => t.head === token.id && t.id !== token.id && isDistributivePostpose(t));
}

/** True when one of the negations that realise a predicate of their own
 * (無/无/罔/靡/莫/毋) hangs off this token and will be read *after* it — see
 * `isPredicateNegationPostpose`, which is the statement of record and is asked
 * here rather than re-derived, so that a character the reader has taken out of
 * the class by picking a reading is out of it in both panels at once.
 *
 * **What the form has to answer to, and why it is not the negation's 未然形.**
 * 不 suffixes ず onto the verb it denies, and ず is 未然形接続 — that is the
 * relation `isNegationUse` and `negationForm` are about. 無 is a different word
 * doing a different thing: it is the **adjective 無し**, ク活用, predicating
 * *of* a subject, and the clause it stands after is that subject rather than
 * anything it governs. A subject is a nominal, a clause in a nominal slot is
 * nominalised, and a nominalised clause closes on its 連体形 — the same claim
 * `isNominalizedSubjectPredicate` makes for 首を去ること半尺 and
 * `modifiesGenitiveZhi` for 大破するの時.
 *
 * **Counted in the received reading**, over kanbun.info's 178,468 characters
 * of 書き下し文, taking every 無/莫/毋 in an adjectival form and reading what
 * stands immediately in front of it:
 *
 * | こと 182 | a bare 連体形 in -る 158 | 所 50 | は 41 |
 *
 * — against **0** in a 終止形 that the paradigm spells apart from its 連体形
 * (悔ゆる無き, 稱する無し, 尚うる無し, never 悔ゆ無し).
 *
 * **The nominaliser is the second question, and the answer is no.** こと is the
 * plurality of that table and is what the reader's own passage has
 * (己に如かざる者を友とする**こと**無かれ), so it was written as well — a fifth
 * arm in `caseParticleFor` beside the one `isNegatedNengComplement` holds for
 * 未だ之を信ずる**こと**能はず — and measured. It reads the gold tier **11**
 * edits closer and the parsed tier **132** further, which is a clear net loss
 * and is not shipped. The split is the tiers' own: a parse that has hung the 無
 * on the wrong governor writes the こと into the wrong clause, and a bare 連体形
 * misplaced the same way costs nothing, since 158 of the received text's own
 * 無 stand on one. The bare form is what the corpus is unanimous about and the
 * nominaliser is what it is divided about, so the rule takes the first and
 * leaves the second.
 *
 * Invisible to `decideConjForm`'s ordinary "what follows in reading order"
 * machinery for the reason `hasDistributivePostposeChild` gives about 毎: the
 * 無 is *pre*-verbal in the source and only reaches its post-verbal reading
 * position because `classifyToken` postposes it, so what the form has to
 * answer to is a child of this token rather than its neighbour. */
function hasPostposedPredicateNegationChild(token: Token, sentence: Sentence): boolean {
  return sentence.tokens.some(
    (t) => t.head === token.id && t.id !== token.id && isPredicateNegationPostpose(t, token, sentence),
  );
}

/** True when this token is one of the negations that realise a predicate of
 * their own (無/无/罔/靡/莫/毋) and `classifyToken` postposes past its governor
 * — see `isPredicateNegationPostpose`, which is the statement of record and is
 * asked here rather than re-derived, so that a character the reader has taken
 * out of the class by picking a reading is out of it in both panels at once. */
function isPostposedPredicateNegation(token: Token, sentence: Sentence): boolean {
  const governor = sentence.tokens.find((t) => t.id === token.head);
  return isPredicateNegationPostpose(token, governor, sentence);
}

/** True when this token is the predicate a genitive 之 hangs its following
 * nominal on — 大破之時, "the time of the great defeat". A verb in that slot
 * modifies the nominal through の and so is attributive: 大破するの時, never
 * 大破すの時.
 *
 * The 之-is-genitive test is `depClassification.ts`'s own
 * `isGenitiveComplement`, not a second one written here: 之 is the genitive
 * の exactly when it is tagged `mod` and the token in question is its
 * `comp:obj` (measured — 破 in 大破之時 and 立 in 立廟之時 both come back that
 * way, as does the nominal 少典 in 少典之子), which is the same condition
 * `caseParticleFor` suppresses を on and the same one overrides.json keys
 * 之's own の reading to. */
function modifiesGenitiveZhi(token: Token, sentence: Sentence): boolean {
  return isGenitiveComplement(
    token,
    sentence.tokens.find((t) => t.id === token.head && t.id !== token.id),
  );
}

/** True when `token` is a postposed predicate negation (無/莫/毋…) read
 * straight before the genitive 之 that the clause it closes modifies —
 * 無不陷之矛, 陷らざる無き**の**矛; 無過之城, 過ち無き**の**城.
 *
 * `modifiesGenitiveZhi` answers for the predicate itself, and cannot answer
 * here: the 之 holds the verb 陷 as its `comp:obj`, the 無 hangs off that verb,
 * and the reading moves the 無 to the end of the clause
 * (`isPredicateNegationPostpose`), so the token that actually meets the の is
 * one the tree does not attach to the 之 at all. Before this the 無 fell through
 * to the 終止形 and wrote 陷らざる無し**の**矛, a form kanbun.info never writes:
 * 無きの **2**, 無しの / 莫しの **0**.
 *
 * Both conditions are the ones `negationEndingParts` asks of a 不 in the same
 * place, and for the same reason: the governor is the complement of a genitive
 * 之 (the clause belongs to the noun phrase), and the next token read is that
 * very 之 (the の lands on the negation and not on something between). */
function closesGenitiveZhiClause(token: Token, nextToken: Token | undefined, sentence: Sentence): boolean {
  if (!nextToken || !isPostposedPredicateNegation(token, sentence)) return false;
  const governor = sentence.tokens.find((t) => t.id === token.head && t.id !== token.id);
  return !!governor && nextToken.id === governor.head && modifiesGenitiveZhi(governor, sentence);
}

/** True when `particle` is the closing particle of the clause `token` ends —
 * the dependency half of the particle-ahead tests below
 * (`isLimitingParticleAhead`, `isAssertiveParticleAhead`,
 * `closingParticleAheadIs`), each of which pairs it with reading-order
 * adjacency.
 *
 * Ordinarily that is the particle hanging off `token` itself, which is how
 * every sentence-final particle attaches (see `hasSentenceFinalParticle`).
 * **A postposed predicate negation is the one exception**, because it closes a
 * clause it does not head. 莫能陷也 hangs both the 莫 and the 也 off 能, and the
 * reading moves the 莫 to the end of 能's clause (`isPredicateNegationPostpose`),
 * so the 也 is read straight after it and is *its* particle in every sense but
 * the tree's: the 莫 has to be the 連体形 莫き for the なり, 能く陷す莫きなり,
 * where asking for a 也 hanging off the 莫 found none and left 莫しなり.
 *
 * **Anywhere in the clause of the governor, not only on the governor itself.**
 * The same 莫能陷也 is annotated both ways: the parse (and the hand-corrected
 * 矛盾 tree, following the treebank) hangs the 也 off 陷, the `comp:aux`
 * complement of 能, rather than off 能. The reorder already reads that 也
 * after the 莫 — the `comp:aux` fold in reorderEngine.ts holds a closing
 * particle at the end of the complement back for exactly this reason — so the
 * order was 能く陷る莫也 and the form still asked for a 也 sharing the governor
 * of the 莫, found none, and wrote 莫しなり. A form that disagrees with the
 * order it is written in is the fault; the order is right.
 *
 * So the test is the two facts the order itself turns on, and not the arc the
 * parser happened to draw: **reading-order adjacency** (the caller's
 * `nextToken`, as for every particle-ahead test here) and **membership of the
 * clause the negation closes**, which is the subtree of its governor
 * (`governs`, the widening `assertiveParticleClosesAuxiliary` already makes for
 * an auxiliary and for the same reason). A particle outside that subtree is
 * another clause's to answer to, and one inside it that is read straight
 * after the 莫 can only be the one the fold held back. */
function closesOnParticle(token: Token, particle: Token, sentence: Sentence): boolean {
  if (particle.head === token.id) return true;
  return isPostposedPredicateNegation(token, sentence) && governs(token.head, particle.head, sentence);
}

/** 者's nominalizer reading, which is also the only one of its two readings
 * under which anything before it is attributive. See `isNominalizerAhead`. */
const ZHE_NOMINALIZER_READING = "もの";

/** The **は a nominalizing 者 puts in its okurigana slot** — 復た挺かざる者は —
 * which is how `readingResolver.ts` now tells its two particle uses apart:
 * the *topic marker* 者 (a bare noun or name modifies it, 黃帝者 -> 黃帝は)
 * fills the reading slot with は and leaves the okurigana empty, while the
 * *nominalizer* (a predicate modifies it) leaves the reading empty and puts
 * the は here. Neither returns もの any longer, so `ZHE_NOMINALIZER_READING`
 * above no longer matches anything and this is what the rule turns on.
 *
 * **Withheld from a 者 that closes its clause**, which takes the copula なり
 * instead — see `isSentenceFinalZhe` in this file. That reverses a previous
 * ruling of this project's, on the reader's explicit instruction (**−4** against
 * kanbun.info), and it is why `isNominalizerAhead` below must keep reading the
 * もの arm: a clause-closing nominalizer answers on `reading` alone now, with no
 * okurigana at all, and the predicate in front of it is still attributive.
 *
 * A local copy of that module's own exported `ZHE_TOPIC_OKURIGANA`, and kept
 * local for `NAME_FUSING_DEPS`' reason one layer over: `readingResolver.ts`
 * imports *this* file (it asks `decideConjForm` for a span's form), so
 * importing back for one string would close a cycle across the reading and
 * conjugation layers for no gain. The two must stay equal; both say so. */
const ZHE_NOMINALIZER_OKURIGANA = "は";

/** True when the very next thing read is a nominalizer this token is what
 * gets nominalized — 大破者 ("the one who wins big"), 君子所大破 ("what the
 * gentleman defeated"). A nominalizer stands where a noun would, so the
 * predicate feeding it is attributive and takes 連体形, exactly as one
 * feeding a real noun does. `negationForm` already reads `NOMINALIZING_LEMMAS`
 * this way for the negated half of the same rule (挺かざる者, the 連体形 of ず);
 * this is that rule's positive half.
 *
 * Both conditions are required and they are not the same condition. The
 * dependency says this token is what the nominalizer nominalizes (破 is a
 * `mod` child of 者, 破 a `comp:obj` child of 所 — the relation differs, the
 * attachment does not), and reading-order adjacency says the ending is
 * actually landing against it: 大破之軍者 comes back with 軍 between the two,
 * and 破's ending has a noun to answer to there rather than the nominalizer.
 *
 * 者 alone among the nominalizers also reads は, the topic marker, and then
 * nominalizes nothing at all — 黃帝者、少典之子也 is 黃帝は, and its predicate
 * must stay 終止形. That distinction is `readingResolver.ts`'s
 * `zheTopicReading` and is deliberately not re-derived here: this asks the
 * resolver what it read the character as and believes the answer, so a
 * reading the user picked by hand out of the readings menu moves the
 * conjugation with it, the same way `isNegationUse` lets a chosen reading
 * take 未 out of the negation class. With no resolver to hand (a caller that
 * passes none) 者 is left alone rather than guessed at. */
function isNominalizerAhead(
  token: Token,
  nextToken: Token | undefined,
  sentence: Sentence,
  resolveReading: ReadingResolver | undefined,
): boolean {
  if (!nextToken || !NOMINALIZING_LEMMAS.has(nextToken.lemma)) return false;
  if (nextToken.id !== token.head && !closesNominalizedChain(token, nextToken, sentence)) return false;
  if (nextToken.lemma !== "者") return true;
  if (!resolveReading) return false;
  const zhe = resolveReading(nextToken, sentence);
  // Either shape the resolver has produced for the nominalizer: the もの this
  // rule was written against, and the empty reading with は beside it that
  // `zheParticleReading` returns now. See `ZHE_NOMINALIZER_OKURIGANA` — the
  // topic marker is the one that fills `reading` with は, and it nominalizes
  // nothing, so 黃帝者、少典之子也 keeps its 終止形.
  return zhe.reading === ZHE_NOMINALIZER_READING || (zhe.reading === "" && zhe.okurigana === ZHE_NOMINALIZER_OKURIGANA);
}

/** True when `token` is the **last link of a coordination chain the
 * nominalizer holds** — the reader's rule: *if a coordinated chain of
 * predicates is a dependent of 者, then the last one in the chain should be in
 * 連体形.*
 *
 * The chain hangs off the nominalizer by its **head**, and by its head only.
 * 好謀而成者 attaches 好 to 者 as `mod` and 成 to *好* as `conj:coord`, so the
 * last conjunct — the one the 者 is actually read against — has no relation to
 * the 者 at all, and `isNominalizerAhead`'s direct test answered no for it.
 * 成 then fell past every 連体形 rule to the 終止形, which is what closes a
 * sentence, in a phrase that is a noun.
 *
 * **The relation is `mod`, and the corpus is unambiguous about it.** Over
 * `lzh_kyoto-sud-{train,dev,test}.relabeled_ext.udep_ruled.punct.rulemerged.adjfix.conllu`
 * a dependent of a 者 that is a predicate carries `mod` — VERB **2,744**, ADJ
 * **610**, AUX **260** — against nothing else of that kind (the other labels on
 * a 者's dependents are `punct` 1,755, `discourse@sp` 340, `udep` 155, `subj`
 * and `det` for the pronoun it stands with, and `mod` again for the 770 NOUN /
 * 106 PROPN / 106 ADV / 105 NUM cases where what the 者 marks is not a clause).
 * **443** of those `mod` predicates head a coordination chain, and every later
 * conjunct in them hangs off that head rather than off the 者 — `conj:coord`
 * **337**, `parataxis` **106**. So the answer to the reader's parenthetical is:
 * the chain's *head* is `mod` of the 者, and the rest of the chain is
 * `conj:coord` (or `parataxis`, asyndetically) of that head. Nothing should
 * attach a later conjunct to the 者 directly.
 *
 * **Only the last link**, which is what keeps the 連用形 the chain owes its
 * earlier members: 好 in 好謀而成者 hands on to 成 and stays 連用形 (謀るを好み),
 * and it is 成 that the 者 lands against (成る者). `lastLinkOf` is the same
 * source-order answer `isNonFinalCoordinand` spends, so the two cannot disagree
 * about which link that is.
 *
 * **Reading-order adjacency is still required and is still the caller's**: this
 * only widens which token may be *asked*, never whether the nominalizer is
 * actually landing against it. */
function closesNominalizedChain(token: Token, nominalizer: Token, sentence: Sentence): boolean {
  const members = predicateCoordinationChain(token, sentence);
  if (members.length < 2 || lastLinkOf(members).id !== token.id) return false;
  return members.some((m) => m.head === nominalizer.id && m.id !== nominalizer.id && m.dep === "mod");
}

/** The 限定 sentence-final particle's reading — 耳's のみ. Read off the one
 * table that decides it (`sentenceFinalParticle`) rather than written as a
 * lemma test, so what pulls the 連体形 here is the same fact the panels
 * actually print, and a second limiting particle added to that table needs
 * nothing added here. See 耳's own entry in `SENTENCE_FINAL_PARTICLES`. */
const LIMITING_PARTICLE_READING = "のみ";

/** True when the very next thing read is 耳 closing this predicate — the
 * limiting particle, read のみ, "…and that is all". のみ is a 副助詞, and a
 * 副助詞 attaches to a 連体形: 曰：「易耳。」 is 易きのみ, never 易しのみ.
 *
 * The same principle `isNominalizerAhead` and `modifiesGenitiveZhi` are the
 * other two cases of — a predicate that something else attaches onto, rather
 * than one closing a sentence, is attributive — and written to their shape
 * deliberately, as its third case rather than a rule of its own.
 *
 * Both conditions are required and they are not the same condition. The
 * dependency says this 耳 is *this* predicate's own closing particle (it hangs
 * off it, the way every sentence-final particle attaches — see
 * `hasSentenceFinalParticle`), and reading-order adjacency says the のみ is
 * landing against it rather than after something else read in between.
 *
 * Whether the character is the particle at all is `isSentenceFinalParticleUse`'s
 * question and is not re-asked here: 耳 is also the noun みみ, and 割其耳 must
 * stay その耳を割る. */
function isLimitingParticleAhead(token: Token, nextToken: Token | undefined, sentence: Sentence): boolean {
  if (!nextToken || nextToken.id === token.id || !closesOnParticle(token, nextToken, sentence)) return false;
  if (sentenceFinalParticle(nextToken.lemma) !== LIMITING_PARTICLE_READING) return false;
  return isSentenceFinalParticleUse(nextToken, sentence);
}

/** The 断定 sentence-final particle's reading — 也's なり. Read off
 * `sentenceFinalParticle` for `LIMITING_PARTICLE_READING`'s own reason: the
 * fact this rule turns on is that the particle *reads* なり, and taking it from
 * the one table that decides that keeps this from drifting away from what the
 * panels actually print. */
const ASSERTIVE_PARTICLE_READING = "なり";

/** The 詠嘆 sentence-final particle's reading — 哉's and 夫's かな. Read off the
 * one table that decides it for `LIMITING_PARTICLE_READING`'s own reason, and
 * used by `negationForm`, which has a lemma and no token. The *set* the
 * unnegated rule keys on is `EXCLAMATORY_PARTICLE_READINGS`, built from this. */
const EXCLAMATORY_PARTICLE_READING = "かな";

/** True when the very next thing read is an assertive 也 closing this
 * predicate — read なり, the 断定 auxiliary, which attaches to a 連体形.
 *
 * The reader's rule: *if a verb in a coordination/parataxis chain has a
 * sentence-final particle, the conjugation selected by that particle should
 * override the usual 連用形 of coordination.* Three of the four particles that
 * select a form already did so, because their branches in `decideConjForm`
 * stand above the coordination rule — 耳's のみ (`isLimitingParticleAhead`) and
 * the 係助詞 や/か/ぞ/なむ (`isBindingParticleAhead`). なり had no branch at all:
 * `negationForm` drew the line for a *negated* predicate (不以飲為累也 ->
 * 累と為せざるなり) and an unnegated one fell straight through to the chain,
 * which demoted it — 飲也、食 came out 飲**み**なり食ふ, a 連用形 with an
 * auxiliary standing on it.
 *
 * **Measured** over
 * `lzh_kyoto-sud-{train,dev,test}.relabeled_ext.udep_ruled.punct.rulemerged.adjfix.conllu`:
 * of the 7,317 assertive 也, **137** stand on a predicate that has a further
 * conjunct after them — 地未有過千里者也，而齊有其地矣 · 人有不為也，而後可以有為 ·
 * 陽貨矙孔子之亡也而饋孔子蒸豚 — and it is those 137 whose 連用形 the ordering
 * overturns. The other **7,180** close their sentence outright, where what the
 * rule replaces is a 終止形 and the change shows only in the paradigms that spell
 * the two apart: 有りなり -> 有るなり, 求むなり -> 求むるなり, 惡しなり -> 惡きなり.
 * Rendered over the whole gold, **1,345** of the 7,023 sentences carrying an
 * assertive 也 come out differently for that.
 *
 * Beside `isLimitingParticleAhead` and `isBindingParticleAhead` rather than
 * anywhere else, because it is the same fact about the same slot for the third
 * time: a particle attaching onto the predicate leaves it attributive, and the
 * rule is read off what the particle is *read as* rather than off which
 * character it is. Both of that pair's conditions are required here too and are
 * not the same condition — the dependency says this 也 is *this* predicate's own
 * closing particle, and reading-order adjacency says the なり is landing against
 * it rather than after something read in between.
 *
 * Below the negation rule at the top of `decideConjForm`, on which the negated
 * case depends exactly as 不知之耳 depends on it: what stands between the
 * predicate and the なり is then ず, and it is ず that has to be attributive —
 * 累と為せざるなり, which `negationForm`'s own なり arm writes.
 *
 * **One form everywhere, and the bound this once carried is gone.** For a while
 * `decideConjForm` asked this only of a *non-final conjunct*, because a chain is
 * the whole of what the reader had asked to be overridden, while the reader's
 * own pin read 有**り**なり for a 也 closing a sentence outright — so the same
 * particle took two forms (有るなり in a chain, 有りなり at the close), which was
 * reported rather than settled in the code, since only the reader could settle
 * it. The reader has settled it: **有るなり**, which is what the argument above
 * gives anyway — なり is an auxiliary and an auxiliary attaches to a 連体形, so a
 * predicate closing a sentence with a 也 on it is attributive exactly as one in
 * a chain is. The bound came off, and the 7,180 gold 也 that close their sentence
 * outright now take the 連体形 too — the 1,345 sentences counted above.
 *
 * The negated case never moved and stays 連体形 throughout (`negationForm`'s なり
 * arm), which is why `attributiveParticleAhead` can put this same question for a
 * 再読文字's own ず — 未果也 -> いまだ果てざるなり, where the ざり paradigm is owed
 * to the なり outright and nothing about chains is asked.
 *
 * **This predicate says only that the particle is there**, and the answer to
 * what it asks for is `decideConjForm`'s: where the predicate is itself
 * ナリ/タリ活用 its own 終止形 *is* なり, the particle's copy is suppressed
 * (`repeatsPredicateCopula`) and the form that agrees with that is 終止形, not
 * the 連体形 an auxiliary would need. The division is made at the branch rather
 * than here, because it is the branch that also knows what to return instead —
 * and made by asking `repeatsPredicateCopula` itself, so a form chosen for a
 * copula that is then not written cannot arise. */
function isAssertiveParticleAhead(token: Token, nextToken: Token | undefined, sentence: Sentence): boolean {
  if (!nextToken || nextToken.id === token.id || !closesOnParticle(token, nextToken, sentence)) return false;
  if (sentenceFinalParticle(nextToken.lemma) !== ASSERTIVE_PARTICLE_READING) return false;
  return isSentenceFinalParticleUse(nextToken, sentence);
}

/** The same question `isAssertiveParticleAhead` asks, asked for an **auxiliary
 * this app writes after the clause it governs** — 可/能's べし, 須/當/應's, 欲's
 * まほし, 使/令/敎/遣's しむ, 被/見's る・らる.
 *
 * **Why the edge test has to be widened, and by exactly this much.** An
 * assertive 也 closes the *predicate*, and an auxiliary heads the clause that
 * predicate is in: 言可復也 hangs the 也 off 復, and 復 off 可 as its `comp:aux`.
 * So `isAssertiveParticleAhead`'s "the particle is this token's own dependent"
 * is false of every auxiliary, though the なり lands directly on the auxiliary's
 * kana — 可 is read last, after the whole clause, and the particle after it.
 * Widened to the auxiliary's **subtree**, which says the 也 closes the clause
 * this auxiliary heads and nothing more; reading-order adjacency (the caller's
 * `nextMeaningfulToken`) says the なり is landing against this token rather than
 * after something read in between, exactly as it does for のみ and かな.
 *
 * **Measured over the gold** (`lzh_kyoto-sud-{train,dev,test}` …`sjmerged`):
 * **665** tokens of an `AUXILIARY_LEMMAS` character head a clause whose
 * assertive 也 stands after every non-particle token of their subtree — 可 311,
 * 能 116, 使 83, 欲 87, 敎 31, 當 15, 令 15, and a tail of 應/須/遣. That is the
 * population; what moves on the page is the auxiliaries whose 終止形 and 連体形
 * differ, which is all of them. */
function assertiveParticleClosesAuxiliary(
  token: Token | undefined,
  nextToken: Token | undefined,
  sentence: Sentence,
): boolean {
  if (!token || !nextToken || nextToken.id === token.id) return false;
  if (sentenceFinalParticle(nextToken.lemma) !== ASSERTIVE_PARTICLE_READING) return false;
  if (!isSentenceFinalParticleUse(nextToken, sentence)) return false;
  if (auxiliaryFormFor(token, sentence) === undefined) return false;
  return governs(token.id, nextToken.head, sentence);
}

/** Whether `descendantId` lies at or below `ancestorId` in the tree. Written
 * here rather than imported: `depClassification.ts`'s `subtreeOf` is not
 * exported, and this walks *up* from the one node in hand instead of
 * enumerating a whole subtree, which is the cheaper direction for the one
 * question asked of it. A cycle in a hand-edited tree ends the walk at the
 * sentence's length rather than spinning. */
function governs(ancestorId: number, descendantId: number, sentence: Sentence): boolean {
  const byId = new Map(sentence.tokens.map((t) => [t.id, t]));
  let at = descendantId;
  for (let steps = 0; steps <= sentence.tokens.length; steps++) {
    if (at === ancestorId) return true;
    const node = byId.get(at);
    if (!node || node.head === at || node.head === 0) return false;
    at = node.head;
  }
  return false;
}

/** **係り結び** — the 係助詞 whose 結び is a **連体形**: ぞ, なむ, か.
 *
 * The bound form of classical Japanese, and the fourth case of the same
 * principle `modifiesGenitiveZhi`, `isNominalizerAhead` and
 * `isLimitingParticleAhead` are the first three: a predicate that something
 * else attaches onto is attributive, not one closing a sentence.
 *
 * **や has been taken out of this set, and that is the substantive correction
 * of this round.** It sat here on the analysis that a sentence-final や is the
 * 係助詞 used 文末, whose 結び is 連体形. The 接続 the received grammar actually
 * gives the **終助詞** や is the **終止形**, and three anchors say so, one of
 * them this app's own:
 *
 *  - **亦説ばしから*ず*や** (不亦說乎), which is what every printed kundoku
 *    edition of 論語 學而 has. ず is the ず-series 終止形; its 連体形 is ぬ and
 *    its ざり-series 連体形 ざる, and 〜ざるや appears nowhere. The app printed
 *    亦說ばしからざるや until this change (see `boundByBindingParticle`, whose
 *    doc records the reader's instruction *"Don't carry out a carve-out for
 *    不亦"* — the carve-out is no longer needed, because the general rule now
 *    gives 〜ずや for all 276 edges without one).
 *  - **「ありやなしや」** (伊勢物語 九段) and the kundoku set phrase
 *    **「然りや否や」**. あり and 然り are ラ変, and both take the plain 終止形
 *    in front of this particle.
 *  - **「あはれなりや」**. ナリ活用 is ラ変型 and takes 終止形 なり, not なる.
 *
 * The last two are also the answer to whether the **ラ変 exception** reaches
 * this particle: it does not. That exception belongs to the 終止形接続の助動詞
 * — べし・らむ・まじ・めり・らし — and `shuushiConnectiveForm` in
 * `classicalConjugation.ts` is where it is named and where `decideConjForm`'s
 * closing line consults it. A 終助詞 is not a 助動詞 and attaches to what the
 * paradigm actually spells. See `TERMINAL_PARTICLE_READINGS`, which is where や
 * went and which asks for `shuushi`.
 *
 * **か and かな stay 連体形 and are two different rules.** か is here, a 係助詞
 * (and 終助詞) that binds; かな is a 終助詞 whose 接続 is 体言・連体形 and lives in
 * `EXCLAMATORY_PARTICLE_READINGS` beside this. 賢哉囘也 is **賢なるかな**囘や,
 * 大哉堯之爲君 **大なるかな** — the received readings, and the shape 論語 prints
 * throughout. 哉 took a 終止形 before this change (賢**し**かな).
 *
 * **こそ is not here, and its absence is the point.** こそ binds a 已然形, not
 * a 連体形 — 「〜こそ〜けれ」 — so it could not share this branch even in
 * principle. It is also unreachable: **nothing in the app reads こそ**. The
 * readings a particle can take come from two tables and one override file, and
 * こそ is in none of them — `SENTENCE_FINAL_PARTICLES` holds や/なり/かな/り/
 * のみ and the empty 矣, `GENUINE_QUESTION_PARTICLES` holds 乎's か, and
 * overrides.json's か entries are 邪 and 耶 (与/與/歟/欤 read や — 歟 and 與
 * were corrected to it when 與's own sentence-final reading was added, so that
 * each table and the override agree about one character). A 已然形 branch keyed on a
 * string no table produces would be a rule that cannot fire, which this file's
 * own standard (see `isConditionalTemporalClause`'s note on the caused-predicate
 * guard it removed) calls the appearance of protection rather than protection.
 * When a character is given a こそ reading, that branch is what to add, beside
 * this one and returning `izen`. **Re-checked this round and still true**: no
 * token in the recoded gold resolves to こそ through any of the three routes.
 *
 * **ぞ and なむ are not reachable as *closing* particles either**, and are kept
 * here for the reason the whole set is keyed on readings: nothing in
 * `SENTENCE_FINAL_PARTICLES` or in overrides.json reads a sentence-final
 * character as ぞ. The ぞ this app actually writes is **inside an interrogative
 * word** — なんぞ, いづくんぞ — and it stands *medially*, binding a 結び further
 * on rather than the predicate it is glued to. That is real 係り結び and it is
 * `INTERROGATIVE_BINDING_READINGS` below, not this set.
 *
 * **How the reading is found, and why not the lemma.** The particles reach the
 * page as *readings*, not as characters: 乎 is や by default and **か** inside a
 * 豈…乎 frame (`sentenceFinalParticleFor`), 否 and 与/與/歟/欤 are や — the
 * first three through `SENTENCE_FINAL_PARTICLES` — and 邪/耶 are か through
 * overrides.json. Keyed on the reading, this rule follows all of
 * them — including a reading the user picked by hand out of the menu — and
 * needs nothing added when a table gains another か. That is the same
 * discipline `isLimitingParticleAhead` follows for 耳's のみ and
 * `isNominalizerAhead` for 者's もの.
 *
 * Both conditions of those two rules are required here too and are not the same
 * condition: the dependency says this particle is *this* predicate's own
 * closing mark, and reading-order adjacency says the kana are landing against
 * it rather than after something read in between.
 *
 * **Below the negation rule in `decideConjForm`, and that ordering is what
 * keeps 不亦說乎.** 亦說ばしからず**や** is the anchor: the 乎 there does close
 * the predicate, but what stands between them is ず, and it is ず — not 說 —
 * that the particle lands on. 說 owes the negation a 未然形 (說ばしから), which
 * the negation rule answers before this is ever asked, and `negationForm`
 * decides ず's own form separately and is untouched by this. The same ordering
 * 苦不得飲 and 學而不思則罔 already depend on, for the same reason. */
const BINDING_PARTICLE_READINGS: ReadonlySet<string> = new Set(["ぞ", "なむ", "か"]);

/** **かな** — the 終助詞 whose 接続 is 体言・活用語の**連体形**, and the row of the
 * table that was simply wrong before this change.
 *
 * 哉 and 夫 both read かな (`SENTENCE_FINAL_PARTICLES`), and かな is か + な: the
 * interrogative particle plus the exclamatory な, which is why it takes the same
 * 連体形 its first half does. The received kundoku is unambiguous and is what
 * 論語 prints wherever the character falls —
 *
 *   賢哉囘也       賢なるかな囘や
 *   大哉堯之爲君   大なるかな堯の君爲るや
 *   管仲之器小哉   管仲の器は小なるかな
 *
 * — and 散りぬる**かな**, うれしき**かな**, あはれなる**かな** are the same 接続
 * in 和文. **334** gold 哉 stand `discourse`/`discourse@sp`, and every one of
 * them took a 終止形 before this (賢**し**かな, 大**し**かな).
 *
 * A set rather than a bare string, on `BINDING_PARTICLE_READINGS`' own
 * discipline: what the rule turns on is the reading, and a second exclamatory
 * particle added to either table joins this by being read かな. Kept apart from
 * that set even though both arms return `rentai`, because they are different
 * grammar — a 係助詞 binding a 結び against a 終助詞 attaching to a form — and the
 * 係り結び set has a 已然形 sibling (こそ) waiting for it that this has not.
 *
 * **Measured.** Rendered over the whole gold both ways, this arm changes
 * **144** of the 68,893 sentences: 賢哉囘也 賢**し**かな -> 賢**しき**かな,
 * 觚哉 觚**なり**かな -> 觚**なる**かな, 唯我與爾有是夫 是れ有**り**かな ->
 * 是れ有**る**かな, 孝哉閔子騫 孝**す**かな -> 孝**する**かな. (賢 and 大 are read
 * as ク/シク adjectives by this app rather than as the 形容動詞 賢なり/大なり the
 * received text has, so what it prints is 賢しきかな where 論語 prints
 * 賢なるかな — the *form* is now right for the reading the app has chosen, and
 * which reading that should be is a separate question for `VERB_LEXICON`.) */
const EXCLAMATORY_PARTICLE_READINGS: ReadonlySet<string> = new Set([EXCLAMATORY_PARTICLE_READING]);

/** **や** — the 終助詞 whose 接続 is the **終止形**, plain, with no ラ変 exception.
 * The whole argument is in `BINDING_PARTICLE_READINGS` above, which is where や
 * used to live; the anchors are 亦説ばしから**ず**や, 「ありやなしや」 and
 * 「あはれなりや」.
 *
 * **A rule is needed at all, rather than the fall-through**, because
 * `decideConjForm` ends on `shuushi` only after the coordination and 而 rules
 * have had their say, and those would demote a predicate carrying this particle
 * to 連用形. That is the reader's own rule about a chain — *a sentence-final
 * particle overrides the 連用形 of coordination* — met the way the three
 * 連体形 particles above meet it, by standing in front of the chain rather than
 * by a rule about chains. 飲**み**や食ふ is not a sentence.
 *
 * It is also what keeps the ラ変 exception off this particle: this arm returns
 * `shuushi` outright and the closing line that consults
 * `shuushiConnectiveForm` is never reached. Should the reader rule that a 終助詞
 * や does take the exception after all — 數有る**や** rather than 數有り**や** —
 * the one-line change is to return `shuushiConnectiveForm(conjClass)` here
 * instead.
 *
 * **Measured.** Rendered through `computeReadingOrder` + `generateKakikudashi`
 * over the whole gold with the particle in the binding set and out of it,
 * **457** of the 68,893 sentences come out differently — every one of them in
 * the direction 連体形 -> 終止形: 亦重からざるや -> 亦重から**ず**や, 是誰之過與
 * …過なるや -> …過**なり**や, 夫子爲衞君乎 爲するや -> 爲**す**や, 曰怨乎
 * 怨しきや -> 怨**し**や. What reaches it is whatever *reads* や, which on
 * `discourse`/`discourse@sp` over the recoded gold is **乎 893** (less the 17
 * standing in a 豈 frame, which read か), **與 189**, **歟 19**, and 否 wherever
 * position rescues it. **邪 69** and **耶 38** read か through `overrides.json`
 * and are untouched — they keep the 連体形 they had, which is the shape of the
 * whole correction: it is a division between two particles, not a retreat from
 * 係り結び. */
const TERMINAL_PARTICLE_READINGS: ReadonlySet<string> = new Set(["や"]);

/** What a sentence-final particle standing on `token` is read as, through
 * whichever of the two routes decides it — the tables for the lemmas
 * `SENTENCE_FINAL_PARTICLES` knows, the caller's own resolver for the rest.
 * Undefined for a token that is not a closing particle at all. See
 * `BINDING_PARTICLE_READINGS`. */
function closingParticleReading(
  particle: Token,
  sentence: Sentence,
  resolveReading: ReadingResolver | undefined,
): string | undefined {
  if (isSentenceFinalParticleUse(particle, sentence)) return sentenceFinalParticleFor(particle, sentence);
  if (particle.dep !== "discourse" && particle.dep !== "discourse@sp") return undefined;
  const resolved = resolveReading?.(particle, sentence);
  // **The whole reading, furigana plus okurigana**, and not the furigana half
  // alone. The table arm above returns the whole of what a particle is read as,
  // so the resolver arm has to as well or the two answer different questions —
  // and a word split across the two slots then matches a one-mora particle by
  // its stem. 已 is the case: it resolves や + む (止む, "to cease"), and while や
  // was still in `BINDING_PARTICLE_READINGS` it bound one — 可大紛已 read
  // 紛し**き**べし, a 結び chosen for a verb standing where the particle should be.
  // や leaving that set took the last live instance with it, so this guard moves
  // **0** gold sentences today. It is written all the same, because the sets it
  // feeds hold か and かな too and 已 is not the only character whose kun reading
  // begins with one of those.
  return resolved && resolved.reading + (resolved.okurigana ?? "");
}

/** True when the very next thing read is a closing particle of `readings`
 * standing on this predicate — the body the three reading-keyed particle rules
 * below share, written once because they differ in nothing but the set.
 *
 * Both conditions are required and they are not the same condition: the
 * dependency says the particle is *this* predicate's own closing mark, and
 * reading-order adjacency says the kana are landing against it rather than
 * after something read in between. That is what `isLimitingParticleAhead` and
 * `isAssertiveParticleAhead` each state for themselves; those two stay written
 * out separately because they read the *table* alone (`sentenceFinalParticle`)
 * rather than the table plus the caller's resolver, and narrowing or widening
 * that is a decision about のみ and なり and not about this shape. */
function closingParticleAheadIs(
  token: Token,
  nextToken: Token | undefined,
  sentence: Sentence,
  resolveReading: ReadingResolver | undefined,
  readings: ReadonlySet<string>,
): boolean {
  if (!nextToken || nextToken.id === token.id || !closesOnParticle(token, nextToken, sentence)) return false;
  const reading = closingParticleReading(nextToken, sentence, resolveReading);
  return reading !== undefined && readings.has(reading);
}

/** True when the very next thing read is a 係助詞 of the 連体形-binding class
 * closing this predicate. See `BINDING_PARTICLE_READINGS`. */
function isBindingParticleAhead(
  token: Token,
  nextToken: Token | undefined,
  sentence: Sentence,
  resolveReading: ReadingResolver | undefined,
): boolean {
  return closingParticleAheadIs(token, nextToken, sentence, resolveReading, BINDING_PARTICLE_READINGS);
}

/** True when the very next thing read is an exclamatory かな closing this
 * predicate, which therefore stands in 連体形. See
 * `EXCLAMATORY_PARTICLE_READINGS`. */
function isExclamatoryParticleAhead(
  token: Token,
  nextToken: Token | undefined,
  sentence: Sentence,
  resolveReading: ReadingResolver | undefined,
): boolean {
  return closingParticleAheadIs(token, nextToken, sentence, resolveReading, EXCLAMATORY_PARTICLE_READINGS);
}

/** True when the very next thing read is a 終助詞 や closing this predicate,
 * which therefore stands in 終止形. See `TERMINAL_PARTICLE_READINGS`. */
function isTerminalParticleAhead(
  token: Token,
  nextToken: Token | undefined,
  sentence: Sentence,
  resolveReading: ReadingResolver | undefined,
): boolean {
  return closingParticleAheadIs(token, nextToken, sentence, resolveReading, TERMINAL_PARTICLE_READINGS);
}

/** **係り結び proper** — the readings of the interrogative words this app writes
 * with a 係助詞 **ぞ** inside them: なんぞ and いづくんぞ / いずくんぞ.
 *
 * This is where 係り結び actually happens in kanbun kundoku, and it is a
 * different shape from every other particle rule in this file: the 係助詞 stands
 * **medially**, glued to an interrogative adverb near the head of the clause,
 * and what it binds is the predicate that *closes* that clause, several tokens
 * later. 何ぞ〜する, 安くんぞ〜する — the received readings, against the 終止形
 * this app wrote before.
 *
 *   子曰、盍各言爾志       子曰はく、盍ぞ各〻爾の志を言は**ざる**
 *   女奚不曰               女奚ぞ曰は**ざる**
 *   敢問夫子惡乎長         敢へて問ふ、夫子惡くに**か**長**ずる**
 *
 * The 盍 case is the proof that the app has needed this all along: 盍 is 何不
 * written as one character, `REREAD_CHARACTERS` gives it the second reading ざる
 * outright, and that ざる is nothing but a 係り結び's 結び spelled into a table
 * because no rule could produce it.
 *
 * **Keyed on the reading and not on the character or the tag**, for
 * `BINDING_PARTICLE_READINGS`' own reason and with a sharper edge here. The
 * treebank does have a tag for the class — `v,副詞,疑問,原因` (何 527, 寧 53,
 * 奚 33, 胡 19, 盍 14, 曷 3 over the recoded gold) and `v,副詞,疑問,所在` (安 115,
 * 焉 96, 惡 37) — and it is the wrong thing to read, because **寧 is in it and
 * this app reads 寧 むしろ**. A tag test would bind a 結び to a ぞ that is not on
 * the page. What licenses the 連体形 is the 係助詞 the reader actually sees, so
 * the rule asks what the character is read as.
 *
 * **Exact readings, not "ends in ぞ".** Over the recoded gold the resolver
 * returns a ぞ-final reading for 1,013 tokens, and three of those readings are
 * not interrogative at all: 溝/畎/洫/瀆 みぞ (29), 楮 こうぞ (1). Membership in a
 * named set excludes them and a suffix test would not. What the set does reach
 * beyond the ADV tag is the interrogative mis-tagged as a nominal — 胡/NOUN 60,
 * 奚/PRON 30 — which read なんぞ all the same and so bind all the same.
 *
 * **いづくんぞ and いずくんぞ are both listed, and that is a wart being recorded
 * rather than papered over.** 安/惡 take いづくんぞ from `overrides.json`, in
 * 歴史的仮名遣い as everything else this app writes is; 焉 has no override entry
 * and takes **いずくんぞ** from KANJIDIC2, in modern kana. The right repair is an
 * override entry for 焉/ADV reading いづく + んぞ, which is a change to that file
 * and to what the character prints — the reader's call, not this rule's. Until
 * it is made, binding on one spelling and not the other would make 焉んぞ the one
 * interrogative that does not bind, so both are listed.
 *
 * **こそ would go here too**, if anything read it: it is the same medial shape
 * and its 結び is 已然形. Nothing does — see `BINDING_PARTICLE_READINGS`.
 *
 * **Measured.** Rendered through `computeReadingOrder` + `generateKakikudashi`
 * over the whole gold with this rule off and on, **314** of the 68,893
 * sentences change, all of them 終止形 -> 連体形 on the clause-final predicate:
 * 何必然 なんぞ必ず然**り** -> 然**る**, 安得六百里 いづくんぞ六百里得 ->
 * 得**る**, 何獨至於人而疑之 なんぞ…疑**し** -> 疑**しき**, 焉有子死而不哭者乎
 * 焉んぞ…有**り**や -> 有**る**や. **102** of the binders stand in front of a
 * suffix-negated governor, where the 結び is the ず and comes out ざる —
 * 胡不遄死 胡ぞ遄かに死な**ざる**, 何不殺之 なんぞこれを殺さ**ざる** — which is
 * `boundByBindingParticle`'s half of the rule. */
const INTERROGATIVE_BINDING_READINGS: ReadonlySet<string> = new Set(["なんぞ", "いづくんぞ", "いずくんぞ"]);

/** Whether this token is read as one of the ぞ-bearing interrogatives — **as the
 * page will actually print it**. See `INTERROGATIVE_BINDING_READINGS`.
 *
 * The reading is the resolver's whole answer, furigana plus okurigana, because
 * 安 and 惡 carry the ぞ in the okurigana slot (いづく + んぞ) where 何 carries the
 * whole word in the reading slot.
 *
 * **And then `lexiconEntryFor` has to be asked, which is the correction this
 * rule needed and did not have at first.** Both panels consult `VERB_LEXICON`
 * *before* the resolver (see `ResolvedReading.beatsLexicon`), so a resolver
 * answer the lexicon outranks is not what the reader sees. **安** holds a ク活用
 * やす entry there and **惡** わる/あし: 安 is ADV over the *verb* xpos
 * `v,動詞,行為,態度` **31** times in the gold, carrying `VerbForm=Conv` with it,
 * and 安無傾 prints 安**く**傾く無し with no ぞ anywhere in it, however plainly
 * `overrides.json` says いづくんぞ for an ADV 安. Binding a 結び on a particle the
 * page does not print is the one thing this rule must not do, and it did it for
 * 10 gold sentences before this test was added.
 *
 * Asked through `lexiconEntryFor` rather than by testing `VERB_LEXICON`
 * directly, because that function *is* the panels' answer — the タリ-suffix
 * arm, the `usesLexiconEntry` POS gate and the `beatsLexicon` override are all
 * inside it — and a second copy of the precedence here could come to disagree
 * with what is printed, which is the whole failure being guarded against. It is
 * also what keeps the *ordinary* uses of 安 and 惡 out with no character list:
 * the tag that means the interrogative (`v,副詞,疑問,所在`, 安 115 and 惡 37)
 * carries no lexicon entry, so those bind exactly as 何 does.
 *
 * **The 31 are a data problem this rule declines to paper over.** Either the
 * lexicon entry should not be reached over that tag or the override should carry
 * `beatsLexicon`, and it is the reader's call which; until it is settled those
 * tokens print no ぞ and so bind nothing, which is what the page reads.
 * 何/胡/曷/奚/盍/詎 and 焉 have no lexicon entry at all and are unaffected. */
function isInterrogativeBinder(token: Token, sentence: Sentence, resolveReading: ReadingResolver): boolean {
  const resolved = resolveReading(token, sentence);
  if (!INTERROGATIVE_BINDING_READINGS.has(resolved.reading + (resolved.okurigana ?? ""))) return false;
  return lexiconEntryFor(token, resolved, sentence) === undefined;
}

/** The **結び** a medial 係助詞 binds: the predicate that ends the clause the
 * particle stands in.
 *
 * **Not the sentence root and not the next token**, which are the two wrong
 * answers. A 何ぞ hangs off the predicate it questions — `mod` for the adverbial
 * uses, `comp:obj`/`subj` for the ones the parser reads as pronouns — and that
 * predicate is the clause. The one thing that has to be added to it is the
 * coordination chain: a clause built out of coordinated verbs *ends* on a token
 * the relation is not on, so the 結び is the chain's last link and the earlier
 * links keep the 連用中止法 `isNonFinalCoordinand` gives them. 何ぞ〜し、〜する.
 *
 * `predicateCoordinationChain` + `lastLinkOf` are reused rather than reinvented,
 * for the reason `isConditionalTemporalClause` reuses them: they are this file's
 * one answer to "which link closes the chain", and a second walk could come to
 * disagree with the 連用形 the other links are getting. `coordinationSpansStop`
 * is inside that walk, so a chain crossing a 。 does not carry the binding into
 * the next sentence.
 *
 * **Forward only.** 係り結び binds what follows the particle; a governor standing
 * *before* it is not the clause this opens. That is what keeps 如之何 — whose 何
 * the parser hangs on a 如 to its left — from binding backwards.
 *
 * **A predicate, or nothing.** The governor of a mis-parsed interrogative can be
 * a bare noun or a particle, and there is no form to select on one. */
function interrogativeMusubi(binder: Token, sentence: Sentence): Token | undefined {
  const governor = sentence.tokens.find((t) => t.id === binder.head && t.id !== binder.id);
  if (!governor || !(isContentPredicatePos(governor.pos) || governor.pos === "AUX")) return undefined;
  const members = predicateCoordinationChain(governor, sentence);
  const musubi = members.length > 1 ? lastLinkOf(members) : governor;
  return musubi.id > binder.id ? musubi : undefined;
}

/** True when `token` is the 結び of a ぞ-bearing interrogative standing earlier
 * in its clause, and so takes the 連体形. See `INTERROGATIVE_BINDING_READINGS`
 * for what binds and `interrogativeMusubi` for how the 結び is found.
 *
 * Answers `false` with no resolver in hand rather than guessing from the lemma:
 * the whole point of the rule is that the ぞ is on the page. `decideConjForm`
 * is handed a resolver at all four of its call sites; `selectedForm` is
 * deliberately not (see its own note on why threading one there would let the
 * two panels disagree), so a *synthesized* copula standing as a 結び keeps its
 * 終止形 — 何ぞ〜なり where the received reading is 何ぞ〜なる. That is the one
 * shape this rule does not reach, and it is named here rather than left to be
 * discovered. */
function boundAsInterrogativeMusubi(
  token: Token,
  sentence: Sentence,
  resolveReading: ReadingResolver | undefined,
): boolean {
  if (!resolveReading) return false;
  return sentence.tokens.some(
    (t) =>
      t.id !== token.id &&
      t.id < token.id &&
      isInterrogativeBinder(t, sentence, resolveReading) &&
      interrogativeMusubi(t, sentence)?.id === token.id,
  );
}

/** True when a **連体形-taking particle** stands on `token` and is the very next
 * thing read — the disjunction of the three particle rules `decideConjForm`
 * answers `rentai` for, asked as one question because one caller needs the
 * whole of it rather than any one part.
 *
 * That caller is `rereadSecondReading` below: what a 再読文字's own second
 * reading has to inflect for is exactly "does a particle attach onto this
 * predicate", and asking the three rules separately there would be the same
 * list written twice. The nominalizer is included on the same footing — 者/所
 * is not a particle in the grammar's sense but it does the identical thing to
 * the predicate before it, which is why `decideConjForm` groups the four.
 *
 * **Must stay equal to those four branches.** Anything added there that returns
 * `rentai` *because something attaches onto the predicate* belongs here too;
 * anything that returns it because the predicate *modifies* something (a
 * genitive 之, an adjacent nominal) deliberately does not. A suffixal negation
 * before one of those reaches the same ざる through `negationForm`'s own
 * `modifiesNominal` arm, and a 再読文字 before one keeps its table `second`. */
function attributiveParticleAhead(
  token: Token,
  nextToken: Token | undefined,
  sentence: Sentence,
  resolveReading: ReadingResolver | undefined,
): boolean {
  return (
    isNominalizerAhead(token, nextToken, sentence, resolveReading) ||
    isLimitingParticleAhead(token, nextToken, sentence) ||
    isBindingParticleAhead(token, nextToken, sentence, resolveReading) ||
    // かな joins the four on the criterion this doc states, being a 終助詞 that
    // attaches onto the predicate and takes its 連体形 — 未果哉 is
    // いまだ果てざるかな, the same shape 未果也 already had. See
    // `EXCLAMATORY_PARTICLE_READINGS`.
    //
    // The や that left `BINDING_PARTICLE_READINGS` this round is *not* replaced
    // here by a `isTerminalParticleAhead` arm, and must not be: what this
    // function collects is the 連体形 environments, and a 終助詞 や leaves the ず
    // in 終止形 — 未果乎 is いまだ果てずや, which is the ず `rereadSecondReading`
    // already writes when nothing here answers.
    isExclamatoryParticleAhead(token, nextToken, sentence, resolveReading) ||
    isAssertiveParticleAhead(token, nextToken, sentence)
  );
}

/** The second reading a 再読文字 writes where its clause closes — `second` off
 * `REREAD_CHARACTERS`, inflected where the sentence inflects it.
 *
 * Only the negating pair (未, 盍) has anything to inflect, and only in one
 * direction. The reader's rule: *いまだ…ず should put its head in mizenkei; also,
 * if there is a following rentaikei particle, it should end in ざる.* The first
 * half is `rereadGovernedForm`'s and has always held; this is the second. ず is
 * a 終止形, and a 連体形-taking particle standing after it wants the ざり
 * paradigm's 連体形 — 未知之耳 is いまだこれを知らざるのみ, not 知るのみず, and
 * 未果也 いまだ果てざるなり, not 果つなりず.
 *
 * **ざる and not ぬ**: the ざり paradigm exists precisely because ず could carry
 * nothing after it and had to be rebuilt as ず+あり to do so. のみ, なり and the
 * 係助詞 are things carried; so, on the reader's own instruction, is the 者 of
 * 未見者 — いまだ見ざる者, the form kanbun kundoku conventionally writes, and
 * the same ざる the plain suffixal 不 takes before a 者 (挺かざる者; see the
 * `modifiesNominal` arm in `negationForm`).
 *
 * **`negationForm` is what writes the string**, asked with `governedForm` set to
 * `rentai` — the same call its own 再読文字 arm answers — so the ざる here and
 * the ざる 猶…がごとし takes come out of one table and one decision.
 *
 * The placement of the ending is `reorderEngine.ts`'s and not this function's,
 * and the two have to agree: `rereadCloseIn` drops a sentence-final particle
 * from the clause a 再読文字 closes on, so the ざる is written *before* the なり
 * it is attributive for. Without that half this one would inflect for a particle
 * standing on the wrong side of it.
 *
 * **Asked with the 再読文字 alone, and it finds the closing token itself**
 * (`rereadCloseId`) rather than being handed one. The two panels write this
 * reading in different places — the prose as an ending at the token the clause
 * closes on, the 訓読文 down the character's own left-hand side — so a signature
 * taking the closing id could only be called by the panel that happens to hold
 * it, and for a whole session only that panel called it: the 訓読文 printed
 * `entry.second` off the table and 未之有也 came out いまだこれ有ら**ズ** in the
 * ruby against いまだこれ有ら**ざる**なり in the prose, over 175 characters of the
 * gold. One question, one argument list, both panels.
 *
 * Where nothing was recorded — no closing token for this character — the
 * table's own `second` stands. That is a decision and not a fallback: the
 * inflection is for what follows the clause, and a character whose clause the
 * plan never closed has no such "what follows" to inflect for. The prose emits
 * nothing at all in that state (it writes only from the map), so the 終止形 the
 * table states is what the 訓読文 shows alone, unchanged from what it showed
 * before this function was reachable from it. */
export function rereadSecondReading(reread: Token, plan: ReadingPlan, resolveReading?: ReadingResolver): string {
  const entry = rereadCharacter(reread.text);
  if (!entry) return "";
  if (!rereadNegates(reread.text)) return entry.second;
  const closeAtId = rereadCloseId(reread.id, plan);
  if (closeAtId === null) return entry.second;
  const closeAt = plan.sentence.tokens.find((t) => t.id === closeAtId);
  if (!closeAt) return entry.second;
  const next = nextMeaningfulToken(plan, closeAtId);
  // **Closing on a negation it denies** (未嘗不V, where this ず follows the
  // ずんばあら of the 不 — see `negationEndingParts`), the particle after it
  // hangs on the predicate and not on the 不, so asking whether one hangs on
  // `closeAt` finds nothing: 未嘗不得見也 wrote ずんばあらずなり. What follows is
  // read off adjacency instead, which is how `negationForm` reads it for a 不
  // in the same place: 見ゆ得ずんばあらざるなり.
  const denies = isNegationUse(closeAt) && negationForm(next) === NEGATION.rentaiZari;
  if (!denies && !attributiveParticleAhead(closeAt, next, plan.sentence, resolveReading)) return entry.second;
  return negationForm(next, "rentai");
}

/** べし — the one **終止形接続の助動詞** this app writes, and the only consumer
 * of the ラ変 exception. `AUXILIARY_LEMMAS` gives it to 可/能 (POTENTIAL) and
 * 須/當/応/應 (NECESSITY); the other endings that attach to a predicate take a
 * 未然形 (まほし, しむ, る/らる) or a nominal (the copula), so none of them asks
 * this question.
 *
 * Read as the *string the table writes* rather than as a list of lemmas or a
 * comparison against the two `ConjugatedForm` objects, on the discipline this
 * file follows for every particle: what makes the exception apply is that a
 * べし is going onto this predicate, and taking that from the one table that
 * decides it means a べし added to `AUXILIARY_LEMMAS` under a further character
 * is covered by construction. */
const SHUUSHI_CONNECTIVE_AUXILIARY = "べし";

/** True when a べし is the **very next thing read** and is this predicate's own
 * governor — so the べし is written directly onto it and it is this predicate
 * that owes the auxiliary its form. See `SHUUSHI_CONNECTIVE_AUXILIARY`, and
 * `shuushiConnectiveForm` in `classicalConjugation.ts` for what the answer is
 * then used to choose.
 *
 * **The *governor*, because that is the direction this treebank draws the
 * edge** — the reverse of every particle rule in this file. 可 heads its clause
 * (908 ROOT, 276 `comp:obj` over the recoded gold) and the verb it licenses
 * hangs off it as `comp:obj` (可 245, 能 197 over VERB). That is also why the
 * verb escapes `isNominalizedObjectPredicate`, which requires a content-word
 * governor and 可 is AUX, and so reaches `decideConjForm`'s closing line with
 * nothing having claimed it.
 *
 * **Reading-order adjacency is required and is not the same condition**, which
 * is the correction this rule needed after its first measurement. Testing the
 * edge alone caught every relation an auxiliary happens to head — a
 * `conj:coord` sibling, a fronted 雖然 — and the べし in those is written
 * somewhere else entirely: 雖然，不可不審察也 came out 然**る**といへども where
 * the received reading is 然**り**と雖も, and 有客，不能館 客**有る** for 客有り.
 * Asking that the auxiliary be the next thing *read* is what says the べし is
 * landing against this word rather than after something read in between —
 * exactly the second condition `isLimitingParticleAhead` and its neighbours
 * require, with the dependency running the other way. It took the rule from 56
 * gold sentences to **23**, and every one of the 33 it gave up was of that
 * shape.
 *
 * **What the 23 are.** Rendered through `computeReadingOrder` +
 * `generateKakikudashi` over the whole gold both ways, the rule changes 23
 * sentences and every one of them is a ラ変 verb under 可/能: 可以有事於上帝 ->
 * 事有**る**べし, 此奇貨可居 -> 居**る**べし, 竟不能有爲 -> 爲する有**る**
 * べからず, 正自不能不爾 -> 爾**る**べからず. */
function isShuushiAuxiliaryAhead(token: Token, nextToken: Token | undefined, sentence: Sentence): boolean {
  if (!nextToken || nextToken.id === token.id || token.head !== nextToken.id) return false;
  return auxiliaryFormFor(nextToken, sentence)?.primary === SHUUSHI_CONNECTIVE_AUXILIARY;
}

/** しむ — the **未然形接続の助動詞** this app writes after a whole clause, read
 * as the string its table writes for the reason `SHUUSHI_CONNECTIVE_AUXILIARY`
 * gives: what makes the rule apply is that a しむ is going onto this predicate,
 * and taking that from `AUXILIARY_LEMMAS` covers a fifth character added there.
 */
const CAUSATIVE_AUXILIARY = "しむ";

/** True when a 使役 しむ is the **very next thing read** and this predicate is
 * inside the clause it governs — so the しむ is written directly onto this word
 * and it is this word that owes the auxiliary its 未然形.
 *
 * **Why the tree test beside it is not enough.** `isCausedOrPassivePredicate`
 * asks the edge — is this token the predicate 使 governs — and that is the
 * right question about *scope* and the wrong one about *attachment*. しむ
 * attaches to whatever is read last before it, and three ordinary shapes put
 * something else there:
 *
 *  - **A postposed negation.** 必也使無訟乎 hangs 無 on 訟 and 訟 on 使, and
 *    kundoku reads the 無 after its verb (`isPredicateNegationPostpose`), so
 *    what the しむ lands on is 無し. 訟へ無**から**しむ is the received shape;
 *    it was coming out 訟せ無**し**しむ.
 *  - **A non-final conjunct's chain end.** 使驕且吝 makes 驕 the caused
 *    predicate and coordinates 吝 onto it, and 吝 is read last: 驕り且つ吝**なら**
 *    しめば, where 吝**し**しめ was written.
 *  - **An auxiliary of this app's own**, which is `selectedForm`'s half of the
 *    same rule rather than this one's — 可 under a 使 wants べ**から**しむ.
 *
 * Reading-order adjacency is therefore the condition, and the subtree test
 * beside it says the しむ scopes over this word rather than merely standing
 * after it — the same pairing `assertiveParticleClosesAuxiliary` makes, with
 * the dependency running from the auxiliary down instead of up.
 *
 * **Measured over the gold** (`lzh_kyoto-sud-{train,dev,test}` …`sjmerged`):
 * **1,722** 使/令/敎/遣 have a caused predicate at all, and **1,603** of them are
 * bare — the caused predicate is itself the last thing read, and
 * `isCausedOrPassivePredicate` above already answers for it. The remaining
 * **119** are the three shapes: 79 carry a `conj:coord` conjunct after the
 * caused predicate, 25 an auxiliary of this app's own, and 17 a preverbal
 * 無/莫/毋 that kundoku postposes. Those 119 are the whole of what this adds.
 *
 * **One guard and not five, which was the question worth asking first.** The
 * 未然形 of every paradigm this can land on is already in the tables and no
 * class needed a new cell: ク/シク have no plain 未然形 and `conjugate` falls
 * through to the カリ から/しから on its own (see its doc), ナリ/タリ carry なら/
 * たら, べし carries べから, and `COPULA` なら. So the fix is this one predicate
 * asked at the two places a form is chosen — `decideConjForm` for a real
 * predicate, `selectedForm` for a synthesized ending — and nothing per-class.
 *
 * A 使 with nothing to cause is not a causative at all and never reaches here:
 * `auxiliaryFormFor` stands the whole entry down over `readsAsCausative`, so
 * 惠則足以使人 keeps its つかふ and the word in front of it keeps its own form. */
function isCausativeAuxiliaryAhead(token: Token, nextToken: Token | undefined, sentence: Sentence): boolean {
  if (!nextToken || nextToken.id === token.id) return false;
  if (auxiliaryFormFor(nextToken, sentence)?.primary !== CAUSATIVE_AUXILIARY) return false;
  return governs(nextToken.id, token.id, sentence);
}

/** True when a caused predicate is **not** the conjunct the しむ lands on, and
 * so owes the auxiliary nothing — it hands on to the next conjunct by
 * 連用中止法 instead.
 *
 * 使驕且吝 is 驕**り**且つ吝ならしめ. `isCausedOrPassivePredicate` asks the
 * *edge* — is this the predicate 使 governs — and answers yes for 驕, which
 * carries the relation, and no for 吝, which is merely coordinated onto it. But
 * 未然形 is owed by *attachment*, not by scope: しむ attaches to whatever is read
 * last before it, which is 吝. `isCausativeAuxiliaryAhead` already gives 吝 its
 * 未然形 from the other side (it was added for exactly this shape, among three);
 * what was left was 驕 taking one too, and 驕**ら**且つ吝ならしめ states a
 * 未然形 with no auxiliary behind it.
 *
 * So the edge test keeps its 未然形 only where the edge and the attachment
 * agree, and a non-final conjunct falls through to the coordination rule
 * further down `decideConjForm` — which is where a non-final conjunct has
 * always been sent, and which writes the 連用形 this wants. Nothing is added to
 * that rule and nothing per-paradigm is added anywhere: the fall-through is the
 * whole mechanism.
 *
 * **Measured over `lzh_kyoto-sud-{train,dev,test}…sjmerged`**: **1,615**
 * causative tokens (使/令/敎/教/遣, `isCausedPredicateOf`'s own four relations)
 * govern a caused predicate, and **109** of those caused predicates carry a
 * following `conj:coord` conjunct and are therefore non-final — the whole of
 * what this demotes. Over the kanbun.info corpus it moves 5 passages closer and
 * 2 further, net **−3** edits.
 *
 * **`isCausativeAuxiliaryAhead` is asked first and outranks this**, because a
 * chain of one collapses the two questions together: where the conjunct the
 * しむ lands on is also the one carrying the edge, the 未然形 is owed and this
 * must not take it away. */
function causedConjunctHandsOn(token: Token, nextToken: Token | undefined, sentence: Sentence): boolean {
  if (isCausativeAuxiliaryAhead(token, nextToken, sentence)) return false;
  return isNonFinalCoordinand(token, sentence);
}

export function decideConjForm(
  token: Token,
  nextToken: Token | undefined,
  sentence: Sentence,
  /** **Read again, by the closing line and by nothing else.** For a while this
   * was accepted and ignored — its one use had been to be handed on to
   * `isNonFinalCoordinand`, which refused the four adjectival paradigms on it,
   * and that narrowing is gone. Every *rule* below still reads the tree alone,
   * and which okurigana the answer then spells is still the caller's business.
   *
   * What brought it back is the one fact about this decision that is not in the
   * tree: the **ラ変 exception**. A 終止形接続 助動詞 attaches to the 連体形 of a
   * ラ変型 word — 可有 is 有る**べし**, not 有りべし — and no relation says which
   * paradigm a word inflects by. So the closing line asks the tree whether a
   * べし is going on (`governedByShuushiAuxiliary`) and asks this whether the
   * paradigm is one of the three that spells its 終止形 り
   * (`shuushiConnectiveForm`). Both halves are required and neither is
   * sufficient: without the tree test every ラ変 predicate would stop being able
   * to close a sentence (弟子三千人ある。), and without this the exception cannot
   * be stated at all.
   *
   * All four call sites already passed a real class (`generator.ts`,
   * `KundokuView.ts`, `readingResolver.ts` and this file's own
   * `precedingFormSuppliesShite` / `renyouTe.ts`), so nothing had to be
   * threaded. Undefined only where a caller genuinely has no paradigm, and the
   * closing line then answers 終止形 exactly as it did. */
  conjClass?: ConjClass,
  /** How the caller's own reading resolver reads a token — consulted only
   * for a following 者, whose two readings this file cannot tell apart on
   * its own. See `isNominalizerAhead`. */
  resolveReading?: ReadingResolver,
): ConjForm {
  // Negation first: 不 governs the form of the verb it negates regardless
  // of where that verb sits in a chain (學不厭教不倦 — 厭 is non-final, but
  // takes 未然形 for the ず that follows, not 連用形).
  if (nextToken && isNegationUse(nextToken)) return "mizen";
  // 豈敢V closes on the 未然形 its ん attaches to: 豈に敢へて之を愛せんや. Ahead
  // of the view below, whose 豈…乎 frame would ask for the 連体形 of 愛するか. See
  // `rhetoricalGanOf`, and `caseParticleFor` for the ん.
  if (rhetoricalGanOf(token, sentence)) return "mizen";
  // The predicate a 敢へて introduces closes the clause 敢 heads, and answers
  // for that clause's slot — see `ganClauseView`.
  const ganView = ganClauseView(token, sentence);
  if (ganView) return decideConjForm(ganView.token, nextToken, ganView.sentence, conjClass, resolveReading);
  // しむ and る/らる both attach to a mizenkei, so the predicate a 使役 or
  // 受身 governs takes that form wherever it sits — 戰 under 使 is 戰は,
  // not 戰く.
  if (isCausedOrPassivePredicate(token, sentence) && !causedConjunctHandsOn(token, nextToken, sentence)) return "mizen";
  // …and so does whatever is **read immediately before the しむ**, which is not
  // always the predicate the tree hangs off the causative. See
  // `isCausativeAuxiliaryAhead` for the three shapes the edge test misses and
  // for what they were printing.
  if (isCausativeAuxiliaryAhead(token, nextToken, sentence)) return "mizen";
  // Ahead of the coordination rule below, whose 連用形 would otherwise win on
  // a sentence like 毎得書讀之: 讀 is tagged `parataxis` onto 得, so 得 looks
  // like a non-final conjunct, when what it really heads is the 毎-clause
  // that the rest of the sentence is *about*. 毎's scope is the tighter one,
  // and it is the thing 得's ending has to attach to.
  if (hasDistributivePostposeChild(token, sentence)) return "rentai";
  // …and a predicate negation the reading has moved to the end of the clause
  // asks the same thing of the predicate it now stands after, for a different
  // reason: 無し is an **adjective predicating of something**, so what precedes
  // it is its subject and not its object, and a clause standing in a subject
  // slot is attributive. 無友不如己者 is 己に如かざる者を友とする無し, never
  // 友とす無し. See `hasPostposedPredicateNegationChild`.
  if (hasPostposedPredicateNegationChild(token, sentence)) return "rentai";
  // …and so does the predicate the negation is read straight after where that
  // is not the negation's own governor. 莫能陷也 hangs the 莫 off 能 and reads it
  // after 能's complement 陷 (see the `comp:aux` fold in reorderEngine.ts), so
  // the clause standing in 無し's subject slot ends on 陷, and 陷 is what goes
  // attributive: 能く陷す莫きなり, 能く之を禦ぐる莫し. Asked only of a
  // predicate the negation's governor dominates, so a clause that merely
  // happens to precede the 莫 in reading order is not claimed.
  if (nextToken && isPostposedPredicateNegation(nextToken, sentence) && governs(nextToken.head, token.id, sentence)) {
    return "rentai";
  }
  // The other two attributive environments, grouped with 毎 above and ahead
  // of the coordination and 而 rules below for the same reason: what a
  // predicate modifies binds tighter than what it is coordinated with, and
  // a 連用形 there would leave the following nominal with nothing modifying
  // it. Both are a predicate standing on a nominal — one reached through の,
  // one through a nominalizer — which is the definition of 連体形.
  if (modifiesGenitiveZhi(token, sentence)) return "rentai";
  // …and the postposed 無/莫 that closes such a clause, for the reason the
  // negation above gives from the other side: 無不陷之矛 reads 陷らざる無きの矛,
  // so what stands in front of the の is the 無, and the 無 is what goes
  // attributive. See `closesGenitiveZhiClause`.
  if (closesGenitiveZhiClause(token, nextToken, sentence)) return "rentai";
  if (modifiesAdjacentNominal(token, sentence)) return "rentai";
  if (isNominalizerAhead(token, nextToken, sentence, resolveReading)) return "rentai";
  // And the third: a 限定 耳 closing the predicate, read のみ — a 副助詞, which
  // attaches to a 連体形 the same way the nominalizer above stands on one.
  // 曰：「易耳。」 is 易きのみ.
  //
  // Below the negation and 使役/受身 rules rather than beside them, and the
  // order is load-bearing. Those two answer to what attaches to the predicate
  // *first*: in 不…耳 the ず comes between the predicate and the のみ, so the
  // predicate owes ず a 未然形 (易から) and it is ず that has to be attributive
  // in front of のみ — 易からざるのみ, which `negationForm` writes. Ahead of
  // this branch, 不知之耳 would have asked 知 for a 連体形 and then bolted ず
  // onto it.
  //
  // Above the 而 and coordination rules for the reason the two branches above
  // give: what attaches onto a predicate binds tighter than what it is
  // coordinated with, and a 連用形 would leave the のみ with no 連体形 to sit on.
  if (isLimitingParticleAhead(token, nextToken, sentence)) return "rentai";
  // And the fourth: 係り結び. A 係助詞 of the ぞ/なむ/や/か class binds its
  // predicate to the 連体形 — 豈飲啄固有數乎？ is あに飲啄もとより數有る**か**,
  // not 數有りか.
  //
  // Beside 耳's のみ rather than anywhere else, because it is the same fact
  // about the same slot: a particle attaching onto the predicate leaves it
  // attributive, and both of them are read off what the particle actually
  // *says* rather than off which character it is. Below the negation rule at
  // the top of this function, which is what keeps 不亦說乎 as
  // 亦說ばしからずや — see `BINDING_PARTICLE_READINGS` for that ordering, and
  // for why こそ (已然形, not 連体形) has no branch here.
  if (isBindingParticleAhead(token, nextToken, sentence, resolveReading)) return "rentai";
  // …and 係り結び's other half, the one that is actually medial: a 係助詞 ぞ
  // riding inside an interrogative word — 何ぞ, 安くんぞ — binds the predicate
  // that *closes its clause*, several tokens further on. 女奚不曰 is
  // 女奚ぞ曰は**ざる**, 敢問夫子惡乎長 夫子惡くにか長**ずる**.
  //
  // Above the 終助詞 や below it, and the ordering is what 何ぞ〜(ス)るや needs:
  // where both are present the ぞ is what binds and the や is a 終助詞 standing
  // after the form the ぞ chose, not the other way about. Below the negation
  // rule at the top for the reason every particle rule here is — in 何ぞ〜ざる
  // the thing the clause ends on is the ず, which owes the verb nothing and the
  // 係助詞 a 連体形, and `negationEndingParts` answers for it from the other side.
  //
  // See `INTERROGATIVE_BINDING_READINGS` for what binds, and
  // `interrogativeMusubi` for how the 結び is found — the governor of the
  // interrogative, advanced to the last link of its coordination chain, so that
  // 何ぞ〜し、〜する keeps the 連用中止法 on the earlier links.
  if (boundAsInterrogativeMusubi(token, sentence, resolveReading)) return "rentai";
  // And the exclamatory かな, which is a 終助詞 rather than a 係助詞 and takes the
  // 連体形 all the same: 賢哉囘也 is 賢**なるかな**囘や, 大哉堯之爲君
  // 大**なるかな**. かな is か + な and inherits the 接続 of its first half. This
  // arm is new and the 334 gold 哉 took a 終止形 before it — 賢**し**かな. See
  // `EXCLAMATORY_PARTICLE_READINGS`.
  if (isExclamatoryParticleAhead(token, nextToken, sentence, resolveReading)) return "rentai";
  // And the 終助詞 **や**, which takes the **終止形** — the row of the table this
  // round corrected, and the reason there is a rule here at all rather than a
  // fall-through: the coordination and 而 rules below would otherwise demote a
  // predicate carrying this particle to 連用形, and 飲**み**や食ふ is not a
  // sentence. 亦說ばしから**ず**や is the anchor and 「ありやなしや」/
  // 「あはれなりや」 are why no ラ変 exception is taken here. See
  // `TERMINAL_PARTICLE_READINGS`, and `BINDING_PARTICLE_READINGS` for the whole
  // argument and for what it would take to reverse it.
  if (isTerminalParticleAhead(token, nextToken, sentence, resolveReading)) return "shuushi";
  // …and the third of the same class: an assertive 也, read なり. なり is the
  // 断定 助動詞 and an auxiliary attaches to a 連体形, so 得也 is 得るなり. This
  // is the reader's rule about a chain — *a sentence-final particle overrides
  // the 連用形 of coordination* — and it is met by standing here, with the two
  // particle rules above it, rather than by a rule about chains: what a
  // particle attaching onto a predicate asks of it is the same question
  // wherever the predicate sits. See `isAssertiveParticleAhead` for the 137
  // gold chains this moves.
  //
  // **Unbounded, and it was once bounded here.** The rule ran for a *non-final
  // conjunct* only, since a chain was the whole of what the reader had asked to
  // be overridden and the reader's own pin then read 有**り**なり for a 也 closing
  // a sentence outright. The reader has since ruled **有るなり**, which is what
  // the argument above gives anyway, so the `isNonFinalCoordinand` guard came
  // off and the particle asks one thing of its predicate everywhere. See
  // `isAssertiveParticleAhead` for what that moved.
  //
  // **終止形 where the predicate is itself ナリ/タリ活用**, because there the なり
  // this branch is making room for is never written. A ナリ活用形容動詞's own
  // 終止形 *is* なり, so 君子仁也 is 君子仁**なり** and not 君子仁なりなり, and
  // `repeatsPredicateCopula` is what suppresses the particle's copy — both
  // panels ask it before writing anything for the 也. Asked here too, and by
  // that same function rather than by a second test of the same fact, so the
  // form and the suppression are one decision: a 連体形 chosen for a copula that
  // is then not written leaves a bare attributive with nothing to attach to,
  // which is what 君子仁**なる** and 賢於生也 生より賢**なる** were. What the 也
  // asks of this predicate is still one question asked everywhere — it is the
  // *answer* that divides, by whether the predicate supplies the copula itself.
  //
  // 終止形 stated outright rather than left to fall through the rules below,
  // which is what keeps the reader's own rule about chains: a sentence-final
  // particle overrides the 連用形 of coordination, and a ナリ predicate falling
  // through would have taken にして from `isNonFinalCoordinand` — 君子仁にして
  // for a 也 that closes.
  //
  // **Measured** over
  // `lzh_kyoto-sud-{train,dev,test}.relabeled_ext.udep_ruled.punct.rulemerged.adjfix.conllu`.
  // **42** assertive 也 stand on a head whose `VERB_LEXICON` class is
  // ナリ/タリ活用 — 仁 28, 賢 7, 大 6, 暴 1 — and **17** of them are tagged so
  // that the predicate actually conjugates through the lexicon (`usesLexiconEntry`
  // admits no NOUN, and 17 of the 42 heads are one). Rendered through
  // `computeReadingOrder` + `generateKakikudashi` both ways, exactly those **17**
  // of the 68,893 sentences change and every edit is the same one character:
  // 仁なる -> 仁**なり** (7), 賢なる -> 賢**なり** (5), 大なる -> 大**なり** (4).
  // 取數多者仁也 數を取ること多き者は仁**なる** -> 〜仁**なり**; 賢於生也
  // 生より賢**なる** -> 生より賢**なり**.
  //
  // **The seventeenth is 暴也, and it is a different symptom wearing the same
  // shape.** 暴 is ナリ活用 にはかなり in the lexicon and the resolver reads the
  // token あばる (下二段) instead, so the predicate on the page writes no copula
  // at all while `repeatsPredicateCopula` — which asks the lexicon — suppresses
  // the particle's. 暴るる -> 暴る is what this line does for it: a complete
  // sentence in place of a bare attributive, where the right answer is either
  // 暴るる**なり** or the reading にはかなり. Which of those it should be is a
  // question about the *word* and belongs to `verbLexicon.ts` and the resolver,
  // not here; it is named rather than compensated for.
  if (nextToken && isAssertiveParticleAhead(token, nextToken, sentence)) {
    return repeatsPredicateCopula(nextToken, sentence) ? "shuushi" : "rentai";
  }
  // And the fifth: a predicate a 非 denies. 非 reads あらず — the copula あり
  // negated — so what stands in front of it is a copula complement, marked に
  // and therefore attributive: 非惡其聲而然也 is 其の聲を惡みて然る**に**非ざる
  // なり, and 非道弘人 is 道人を弘むるにあらず.
  //
  // Beside the four above and decided by the one predicate that also writes
  // the に (`caseParticleFor`), so a 連体形 with no particle after it, or a
  // particle on a 終止形, cannot arise — the same arrangement
  // `isNominalizedObliquePredicate` is in.
  //
  // Below the negation rule at the top, on which the doubly-negated case
  // depends exactly as 苦不得飲 depends on it: 說 in 非不說子之道 owes 不 a
  // 未然形 (說ばら), and it is the ず that has to be attributive in front of
  // the に — 說ばざるに, which `negationEnding` writes.
  if (negatedPredicate(token, sentence)) return "rentai";
  // The sixth of them: a predicate standing in an object slot, with no
  // nominalizer or particle realized in the source at all. 不得飲 -> 飲むを得ず.
  // Grouped here with the other two for the reason the comment above them
  // gives — what a predicate feeds binds tighter than what it is coordinated
  // with — and the same `isNominalizedObjectPredicate` decides this and the を
  // `caseParticleFor` writes, so the form and the particle cannot come apart.
  //
  // Reached by an existential 有/無's own complement too, which takes the
  // 連体形 without the を: 哇有物出 is 物の出づる有り, 有朋自遠方來 is
  // 朋の遠方より來る有り. `caseParticleFor` suppresses the particle there; the
  // nominalization is real either way.
  //
  // …except where the governor is a verb of thinking or intention, which does
  // not nominalize what it governs but quotes it as a volition: 未然形, for the
  // んと that `caseParticleFor` writes from this same predicate — 思飲酒 is
  // 酒を飲まんと思ふ, not 酒を飲むを思ふ. Ahead of the nominalized-object rule it
  // narrows, since the two key on the same relation. See
  // `isVolitionalComplement`.
  if (isVolitionalComplement(token, sentence)) return "mizen";
  // …and asked through `closesArgumentChain`, which is what keeps this in step
  // with the を: only the member of a coordination chain said last is
  // attributive, and the ones before it hand on in 連用中止法 — 為其拜而蓌拜 is
  // 其の拜**み**て蓌拜す**る**が, not 其の拜**む**がて. All four of the rules
  // below take it, and each of them takes it at both call sites, so a 連体形
  // here with its particle written four branches away in `caseParticleFor`
  // cannot come apart from it.
  if (closesArgumentChain(token, sentence, isNominalizedObjectPredicate)) return "rentai";
  // The same inference in the *subject* slot: a predicate standing where a
  // noun would is attributive, and kundoku supplies the こと that lets a clause
  // fill that slot — 去首半尺 is 首を去ること半尺. Beside the object rule above
  // rather than anywhere else, because it is that rule's mirror image and the
  // same `isNominalizedSubjectPredicate` decides this and the こと.
  if (closesArgumentChain(token, sentence, isNominalizedSubjectPredicate)) return "rentai";
  // And the same again in an *oblique* slot — 苦不得飲 is 飲むを得ざるに苦しむ,
  // where 得 is 苦's `mod@tmod`. Beside the object and subject rules for the
  // reason they are beside each other: one predicate answers both halves, the
  // 連体形 here and the に in `caseParticleFor`, so a form with no particle
  // after it cannot arise. See `isNominalizedObliquePredicate`.
  //
  // Below the negation rule at the top of this function, and that ordering is
  // what makes 苦不得飲 come out: 得 owes ず a 未然形 (得), and it is the ず that
  // has to be attributive in front of the に — 得ざるに, which `negationEnding`
  // writes. The same order the 耳 branch above relies on, for the same reason.
  if (closesArgumentChain(token, sentence, isNominalizedObliquePredicate)) return "rentai";
  // And the same again in front of a negated 能 — 未能信之 is
  // 未だ之を信ずる**こと**能はず. Beside the three above for their reason: one
  // predicate answers both halves, the 連体形 here and the こと in
  // `caseParticleFor`. See `isNegatedNengComplement`.
  if (closesArgumentChain(token, sentence, isNegatedNengComplement)) return "rentai";
  // And the fourth of that trio, one relation over: a clause standing as what a
  // **prepositional 為** is the 為 *of*. 為無後也 is 後無き**が**爲なり — 連体形,
  // with the が `caseParticleFor` writes off this same predicate, so neither can
  // arrive without the other. See `isPurposiveWeiComplement`, which also says
  // why `isNominalizedObjectPredicate` above cannot answer for this slot.
  //
  // Below the negation rule at the top of this function for the reason 苦不得飲
  // is: 便 in 為子之不便也 owes its 不 a 未然形, and it is the ず that has to be
  // attributive in front of the が — 便ならざる**が**, which `negationEnding`
  // writes.
  if (closesArgumentChain(token, sentence, isPurposiveWeiComplement)) return "rentai";
  // A conditional protasis is the one adverbial clause that is *not*
  // nominalized — it stays a clause and hands on through ば, so 已然形 rather
  // than the 連体形 the three rules above give. 至於他邦，則曰 is 他邦に至れば、
  // 則ち曰く. `caseParticleFor` writes the ば off the same predicate, and this
  // is `izen`'s only consumer in the app — every paradigm in
  // classicalConjugation.ts has always supplied one and nothing asked.
  //
  // Below the negation rule at the top of this function, on which the negated
  // case depends exactly as 苦不得飲 depends on it: 思 owes ず a 未然形 (思は),
  // and it is the ず that has to be 已然形 in front of the ば — 思はざれば,
  // which `negationEnding` writes. Below `hasDistributivePostposeChild` too,
  // which claims 每獨酌、輒盡一甕 for 連体形+ごとに; the predicate itself declines
  // that case rather than relying on the ordering, since `caseParticleFor`
  // consults these rules in a different order.
  if (isConditionalTemporalClause(token, sentence)) return "izen";
  // The unquoted complement of a speech verb is nominalized the same way, and
  // is a separate branch only because `isNominalizedObjectPredicate` excludes
  // a communication verb's complement (and an existential) by construction —
  // see `isUnquotedSpeechComplement`. The を `caseParticleFor` writes comes
  // from that same predicate, so the form and the particle cannot disagree.
  if (isUnquotedSpeechComplement(token, sentence)) return "rentai";
  // ADJ beside VERB, the same admission `inAttributiveClause` makes about
  // the same **277** gold tokens: the 連体形 is owed to the clause standing
  // under the existential, not to its predicate being a verb.
  //
  // Asked through `closesArgumentChain` like the four rules above, and it has
  // to be: an existent with a conjunct on it is one existence asserted of the
  // whole chain, so the 連体形 belongs to the member said last and the ones
  // before it hand on in 連用中止法 — 有畏而哭之 is 畏れて之を哭く有り, where
  // this branch alone gave 畏るて. `caseParticleFor` asks the same question of
  // the same `isExistentialComplement` and withholds the particle across the
  // whole chain, so the form and the (absent) particle cannot come apart.
  if (closesArgumentChain(token, sentence, isExistentialComplement) && isContentPredicatePos(token.pos))
    return "rentai";
  if (nextToken && nextToken.lemma === "而") {
    // An explicit coordination chain outranks the punctuation heuristic
    // below. The parse *says* this predicate has another coordinated onto it
    // and so is not the one that ends the sentence; a mark before 而 is only
    // evidence about how the author broke the line up, and it cannot be
    // right to close a clause the tree says is still open. 輒半種黍；而家豪富
    // read 黍を種う、而して… — 終止形, then a "moreover" carrying on from the
    // sentence it had just closed — where 連用中止法 is what the ； wants:
    // 黍を種ゑ、而して….
    if (isNonFinalCoordinand(token, sentence)) return "renyou";
    // Otherwise the mark decides. Plain て/して attaches to a 連用形 and
    // carries the clause on, while a 而 the author has set off behind a mark
    // is opening something new, so what precedes it closes — 終止形.
    //
    // This deliberately no longer agrees with `teOrShite` about every 而, and
    // the note that once stood here saying the two must not disagree is
    // withdrawn. It was written when the mark-preceded 而 was read しかして,
    // which does open a fresh sentence and so really does want a 終止形 in
    // front of it. It reads 而して now — "moreover", which continues a
    // sentence rather than beginning one — so the two questions have come
    // apart: what 而 is *read as* is still the mark's business, and what
    // precedes it is the chain's wherever there is one. The reading is
    // untouched either way; only the form before it moves.
    return precededBySourcePunctuation(sentence, nextToken.id) ? "shuushi" : "renyou";
  }
  // A predicative complement of a verb of **becoming** is in 連用形 — 適以益貧
  // is 貧しく, not the 終止形 貧し. This is the third route to a 連用形 in this
  // function and it is written as its own rule rather than folded into either
  // of the other two: it is not a coordination (the complement is an argument
  // of its governor, not a conjunct of it) and it is not the parser's own
  // `VerbForm=Conv`. See `isBecomingComplement`, which decides this and answers
  // to the same split of `comp:pred` that `caseParticleFor` writes the に from,
  // so the form and the particle cannot disagree about which governors are
  // verbs of becoming.
  //
  // Below every 連体形 rule above and below the 而 branch, on the ordering
  // those rules already run on: what a predicate *feeds* — a nominalizer, a
  // particle attaching onto it, a slot a noun would fill — binds tighter than
  // what it is predicated of. In particular it is below
  // `isUnquotedSpeechComplement`, which claims the `comp:pred` of a verb of
  // speech; `isBecomingComplement` declines a communication governor itself as
  // well, so that ordering is belt and braces rather than the whole of the
  // guard.
  if (isBecomingComplement(token, sentence)) return "renyou";
  // A verb its 曰 hangs off is in 連用形 whether or not it is counted a
  // coordinand: 之を誉めて曰く. `converbSuffix` writes the て, off the same
  // `takesTeBeforeYue`, so the form and the て cannot come apart.
  if (takesTeBeforeYue(token, nextToken, sentence)) return "renyou";
  // **And a verb whose clausal complement is read after it is in 連用形 too**,
  // for the reason the 曰 rule above gives: another predication is still to
  // come, so the verb does not close the sentence. `classifyToken` leaves such
  // a complement standing where the editor's 、 put it rather than returning to
  // it (see `depClassification.ts`'s `isClausalComplementAcrossPause`), and the
  // 終止形 this had been printing then closed a sentence the next clause carried
  // straight on from — 敵人分かる三四爲**す**、或ひは戰ひて, where the received
  // reading is 敵人分ちて三四と為**り**、或いは戦いて. 連用中止法, the same bare
  // 連用形 a coordination chain links its members by, and for the same fact
  // about the same slot.
  //
  // **Below every 連体形 rule above and below the 而 branch**, on the ordering
  // those rules already run on: what attaches *onto* this predicate binds
  // tighter than what follows it, so a 也 or a 耳 or a 係助詞 still takes the
  // form it asks for. 學也、祿在其中矣 is 學ぶ**なり**、祿其の中に在り, where the
  // assertive-也 branch answers and this line is never reached; that kanbun.info
  // reads the same 也 as や is that branch's business and not this one.
  //
  // **Measured** over the 915 kanbun.info passages that hold an arc of this
  // shape: with this line stood down they read 28,091 edits against the
  // received text, and with it 28,017.
  if (hasClausalComplementAcrossPause(token, sentence)) return "renyou";
  // Not paired with `converbSuffix`'s て, by the reader's own decision: a
  // coordination chain links its members by 連用中止法, which is a bare 連用形
  // (酒を飲み肉を食ふ), and appending て here would turn every chain into a
  // converb sequence. See `converbSuffix`'s closing note.
  if (isNonFinalCoordinand(token, sentence)) return "renyou";
  // And the fourth route to a 連用形: a **preposed verbal adjunct clause**, a
  // VERB on `mod` standing in front of the predicate it modifies. 感時花濺淚 is
  // 時を感じ花に淚を濺ぎ, where this printed the 終止形 時を感**ず** and started the
  // next clause cold after it.
  //
  // Beside the coordination rule rather than folded into it, and the two are
  // genuinely different relations saying the same thing about the form: a
  // conjunct is one of several predicates asserted together, an adjunct is
  // subordinate to the one it hangs off, and 連用中止法 is what carries either
  // onto what follows. Beside the `VerbForm=Conv` branch below for the reason
  // `isPreposedAdverbialClause`'s doc counts out: that feature is on ADV and
  // only ADV (13,478 of 13,478) and never on a token governing an object, so it
  // cannot reach a verb that still has one.
  //
  // **Below `isConditionalTemporalClause` and that ordering is the whole
  // division of labour between them.** The two rules read the same slot and
  // give it two different forms — 已然形+ば where the sentence carries a
  // すなはち-class connective saying the clause is a protasis, 連用形 where it
  // does not. 至於他邦，則曰 keeps 他邦に至れば則ち曰く; 感時花濺淚, which has no
  // such word in it, gets the converb. See that function's doc, and the note
  // above it for why the ば cannot be had without the trigger.
  //
  // Below the 而 branch and every 連体形 rule above on the ordering they already
  // run on: what a predicate feeds binds tighter than what it is an adjunct of.
  if (isPreposedAdverbialClause(token, sentence)) return "renyou";
  // The parser's own VerbForm=Conv on *this* token is a direct signal that
  // it's being used as a converb (a manner adverbial like 博く modifying a
  // following verb, or a genuine converb-chained action like 參り) —
  // renyoukei either way. See `converbSuffix` for the further (て)/(nothing)
  // decision this pairs with at the render call sites.
  //
  // **Except for a predicate negation the reading has moved to the end of
  // the clause.** `VerbForm=Conv` on a 無 is the parser saying it stands in
  // front of its verb in the *source*, and it says it of every one of them —
  // all 489 ADV tokens of the treebank's 存在 class carry it. Kundoku reads
  // that shape with the 無 last (`isPredicateNegationPostpose`), so by the
  // time the form is chosen the token is no longer in front of anything and
  // the feature no longer describes where it is: 無友不如己者 closes on 無し,
  // not on 無く. The rest of this function then answers from the position the
  // reading actually gives it, which is the same question it answers for any
  // other clause-final predicate.
  if (parseMorphFeatures(token.morph ?? "").VerbForm === "Conv" && !isPostposedPredicateNegation(token, sentence))
    return "renyou";
  if (isStativeSubjectModifier(token, sentence)) return "renyou";
  if (isAspectualVerbComplement(token, sentence)) return "renyou";
  // A copula-verb (VerbType=Cop — 爲/為 used as "becomes X") that still has
  // more of the sentence to render afterward (it's itself an INVERT child,
  // spliced in before its own governor, which is still pending) chains via
  // renyoukei rather than terminating: 爲輪 -> 輪と爲し、其の曲... , not 爲す
  // stranded mid-sentence. Excludes a following discourse particle
  // (乎/也/矣/etc.), which pairs with shuushikei even for a token that
  // technically has "more" after it in reading order (its own sentence-
  // final ending, not a further predicate).
  if (
    nextToken &&
    nextToken.dep !== "discourse" &&
    nextToken.dep !== "discourse@sp" &&
    parseMorphFeatures(token.morph ?? "").VerbType === "Cop"
  ) {
    return "renyou";
  }
  // **The closing line, and the ラ変 exception's one consumer.** Everything that
  // reaches here is a predicate nothing in the sentence has claimed a form for,
  // which is 終止形 — and 終止形 is what it stays unless a **終止形接続 助動詞** is
  // going onto it, in which case a ラ変型 paradigm writes its 連体形 instead:
  // 可有 -> 有る**べし**, 當然 -> 然る**べし**, where this wrote 有りべし and
  // 然りべし. See `shuushiConnectiveForm` in `classicalConjugation.ts` for the
  // rule and for which paradigms are ラ変型, and `governedByShuushiAuxiliary`
  // for the tree half.
  //
  // **Here and not higher up**, which is what makes the exception exactly as
  // wide as the reader's own statement of it — *a rule wanting 終止形 must take
  // 連体形 from a ラ変型 paradigm*. Every other rule in this function has
  // already had its say, so a ラ変 predicate that is a non-final conjunct keeps
  // its 連用形, one before a 而 keeps whatever the 而 branch gave it, and one
  // closing a sentence outright keeps its own 終止形 — 弟子三千人**あり**。, which
  // is right and which a blanket ラ変 → 連体形 would have ruined.
  //
  // **The 終助詞 や never arrives here**, because its own branch above returns
  // `shuushi` outright: 「ありやなしや」 and 「あはれなりや」 are the plain 終止形
  // of ラ変型 words, and a 終助詞 is not a 助動詞. That asymmetry is the whole
  // content of `TERMINAL_PARTICLE_READINGS`' doc.
  //
  // **A synthesized ending does not come through here at all** and so does not
  // get the exception: `selectForm`/`selectedForm` choose among `COPULA`'s and
  // `EXISTENCE`'s own slots, both of which are ラ変型 tables, and a べし after
  // one of those would want なるべし/あるべし. Named rather than fixed here,
  // because that selector's `SelectedSlot` question is a different one and the
  // two panels share it.
  if (conjClass && isShuushiAuxiliaryAhead(token, nextToken, sentence)) return shuushiConnectiveForm(conjClass);
  return "shuushi";
}

/** Whether a VERB_LEXICON-dispatched token needs an explicit trailing て
 * appended after its own conjugated okurigana — the "own morph says
 * VerbForm=Conv" half of `decideConjForm`'s renyoukei rule needs this
 * companion, since an i-sound renyoukei is a bare stem (參り), not yet the
 * converb (參りて): whenever nothing else already supplies that connecting
 * て, this does. Three cases:
 *  - The following token in reading order literally *is* 而 (博學而日參省
 *    — 博 immediately precedes 而): 而 renders its own て/して/しかして
 *    right there (see `teOrShite`), so appending another here would double
 *    it up (博くてて). No suffix in this case.
 *  - **The 連用形 does not end in an い-sound.** て attaches to an i-sound
 *    renyoukei — 直し→直して, 然り→然りて, 答ひ→答ひて — and a renyoukei of any
 *    other shape hands on as the bare form instead, which is 連用中止法 and a
 *    complete construction rather than a missing て. This is the third place
 *    in this file where the answer is "write nothing", and the reasoning is
 *    the same each time: 而 already writes the て (above), a nominal
 *    predicate's にして already contains it (`precedingCopulaSuppliesShite`),
 *    and a く/しく/と 連用形 never wanted one. See
 *    `renyoukeiEndsInISound` for which classes qualify and why the test has
 *    to be by *class* rather than on the written suffix (上一段 writes no
 *    okurigana at all and is an い-sound; ア行下二段 writes none either and is
 *    not).
 *
 *    **The class is the caller's own** — the third parameter — and not a
 *    `VERB_LEXICON` lookup made here. It has to be: what decides whether a て
 *    may be written is the shape of the 連用形 now standing on the page, which
 *    is the class the caller *conjugated* with, and only the caller knows
 *    which one that was.
 *
 *    `VERB_LEXICON` is keyed by lemma and holds one class per kanji — its
 *    leading sense — which is the very thing a context-conditioned reading
 *    contradicts. Where the syntax chose another sense (`beatsLexicon`, whose
 *    `syntheticLexiconEntry` the call sites conjugate with), the two disagree,
 *    and a lookup here then tested a paradigm the page is not written in: 見
 *    is `kami-ichidan` (見る, an い-sound) in the lexicon and `shimo-nidan-ya`
 *    (見ゆ, an え-sound) when the resolver reads it with no object, so a
 *    converb 見 came out 見えて — 見る's て after 見ゆ's stem. Every caller has
 *    the class in hand at the point it calls — it is `lex.conjClass`, the same
 *    one the okurigana immediately before was conjugated with — so it is
 *    passed rather than re-derived.
 *
 *    `undefined` is a real answer and means *no classical paradigm was
 *    used* — the generic `resolve()` fallback path, whose okurigana is
 *    kanjidic's modern spelling, and a `fixedReading` entry, which has no
 *    conjugation to apply. There is nothing to test in either case and the
 *    answer is て, which is exactly what was written before the い-sound rule
 *    existed: the rule only ever *withholds* a て and never adds one where
 *    none stood, so it cannot be the source of a doubled て.
 *  - Otherwise (參 in 博學而日參省乎己 — its own VerbForm=Conv, but
 *    nothing else follows it with its own connecting て): this token is
 *    the *only* thing that can supply the converb's て, so it does
 *    (參り→參りて). Bounded to VerbForm=Conv specifically — the *other*
 *    renyoukei triggers in `decideConjForm` (a still-pending mod@lmod
 *    child, `isStativeSubjectModifier`, a copula chaining onward) each
 *    already have their own token or particle providing whatever needs to
 *    follow, and must *not* also get a bare て glued on.
 *
 * Note on scope, since the rule as stated is about 連用形 generally: a
 * *coordination chain* also puts its non-final members in 連用形
 * (`isNonFinalCoordinand`), and those stay bare — 肉を食ひ酒を飲み歌ひ舞ふ,
 * not 肉を食ひて酒を飲みて歌ひて舞ふ. **The reader has settled this**: a chain
 * links its members by 連用中止法, and 連用中止法 is a bare 連用形. It is not
 * a missing て and this rule does not reach it. The 食肉飲酒歌舞 anchor is
 * what the decision is pinned to (see `tests/coordinationChain.test.ts`), and
 * the gate that keeps the chain out is the `VerbForm=Conv` test on the first
 * line below: a coordinand takes its 連用形 from `isNonFinalCoordinand`, which
 * is a fact about the *tree*, and carries no Conv feature of its own. */
export function converbSuffix(
  token: Token,
  nextToken: Token | undefined,
  conjClass: ConjClass | undefined,
  form?: ConjForm,
  /** Needed only to see a 曰 hanging off `token` (`takesTeBeforeYue`).
   * Every panel call site has it; omitted, that rule is not asked. */
  sentence?: Sentence,
): string {
  // A 已然形 is not a 連用形 and takes ば, not て — 酌めてば is not a word. The
  // token's own `VerbForm=Conv` is no help here: the parser marks a `mod`
  // clause Conv on sight, and `isConditionalTemporalClause` is precisely the
  // rule that overrides that reading of it, so the two would otherwise both
  // write and 酌めて + ば come out. The **form the caller actually conjugated
  // with** is the fact that settles it, for the same reason `conjClass` is the
  // caller's own and not a fresh lookup: only the caller knows what it wrote.
  // Optional, so a call site with no form in hand behaves as before.
  //
  // A **連体形** is refused for the same reason and by the same argument, and
  // the two are one rule: a 連体形 is not a 連用形 either, and what follows it
  // is the thing it modifies or the particle attaching to it — 然るてか is no
  // more a word than 酌めてば is. The parser's Conv is again no help, marking
  // 然 in 然歟否歟 a converb while the 歟 standing on it binds it to 然る
  // (`isBindingParticleAhead` — 係り結び). Every 連体形 rule in
  // `decideConjForm` overrides Conv the same way `isConditionalTemporalClause`
  // does, so this holds for all of them and not only for the newest.
  //
  // And a **未然形** is refused by the same argument a third time, which is
  // where the ずして rule reaches this function. A 未然形 is not a 連用形 either,
  // and the only thing that ever stands after one is the auxiliary that
  // governs it — the ず above all — so 飲まてず is no more a word than 酌めてば
  // is. The parser's Conv is again no help: it marks a `mod` clause a converb
  // on sight and says nothing about the 不 hanging off the same token, and
  // `decideConjForm`'s very first rule overrides it for exactly that reason.
  // What supplies the connective in this position is the negation itself, and
  // it writes ず**して** — `negationEnding`'s 連用形 arm and `NEGATION_CONVERB`,
  // which is the same して a source 而 after a negation writes (`teOrShite`) —
  // so refusing here is what puts a negated converb on the one answer this app
  // gives everywhere else, instead of a て glued inside it. 不飲食肉 reads
  // 飲まず肉を食ふ, and 飲まずして肉を食ふ under the 連用形の「て」 switch, where
  // it read 飲まてず in both.
  //
  // No gold tree exercises it: over `lzh_kyoto-sud-{train,dev,test}` 26 tokens
  // carry `VerbForm=Conv` with a 不/未/弗/勿 of their own, and all 26 are ADV,
  // which this branch never reaches with a paradigm in hand. It is a hand-built
  // or hand-corrected tree that puts the feature on a verb — and the reader's
  // own tree is hand-corrected throughout.
  // **And the 終止形, which is the fourth of them and generalises the three.**
  // A converb's て attaches to a 連用形 and to nothing else, so the test is now
  // *is the form the caller conjugated with the 連用形* rather than a list of
  // the forms seen to go wrong. The 終止形 arrived in this position when the
  // 終助詞 や was corrected from 連体形 to 終止形 (`TERMINAL_PARTICLE_READINGS`):
  // 然歟否歟's 然 carries the parser's Conv and is now 然**り** rather than
  // 然**る**, and ラ変 spells its 終止形 and its 連用形 alike, so the string alone
  // could not refuse what the 連体形 arm had been refusing — 然りてや否むや, with
  // a converb's て inside a closed predication. 然りや否や is the phrase.
  //
  // Stated as one rule rather than a fourth clause because that is what the
  // three below always were, and writing it out invites the next form into the
  // same mistake. `undefined` stays a real answer and still means *no classical
  // paradigm was used*, exactly as the doc above says.
  if (form !== undefined && form !== "renyou") return "";
  if (sentence && takesTeBeforeYue(token, nextToken, sentence)) {
    return conjClass && ADJECTIVAL_CONJ_CLASSES.has(conjClass) ? "" : "て";
  }
  if (parseMorphFeatures(token.morph ?? "").VerbForm !== "Conv") return "";
  if (nextToken?.lemma === "而") return "";
  if (conjClass && !renyoukeiEndsInISound(conjClass)) return "";
  return "て";
}

/** The four classes whose 連用形 is not a verb's — see `renyouTe.ts`'s
 * `SHITE_CLASSES`, which draws the same line for the same reason. */
const ADJECTIVAL_CONJ_CLASSES: ReadonlySet<ConjClass> = new Set<ConjClass>([
  "ku-keiyoushi",
  "shiku-keiyoushi",
  "nari-keiyoudoushi",
  "tari-keiyoudoushi",
]);

/** **The verb before its 曰 hands on in 連用形 + て: 之を誉めて曰く.**
 *
 * The treebank writes V之曰 with 曰 on `parataxis` of V, and a `parataxis`
 * pair is a coordination chain to `isNonFinalCoordinand`, which gives V the
 * bare 連用形 of 連用中止法: 王之を笑ひ、曰く. kundoku does not read the pair as
 * two coordinate predicates. The act and the speaking are one event, the first
 * the manner of the second, and the join is written out. kanbun.info has 26
 * passages with V之曰 in the 白文, and **25 write V with て** (之を聞きて曰く,
 * 之に告げて曰く, 之を憐れんで曰く, 之を閲して曰く); the one exception is
 * daigaku08 故諺有之曰, which closes 有 with a mark (諺に之れ有り、曰く). The て
 * stands before a naming 曰 as well: 之を命けて大紀と曰う, 之を称して夫人と曰う,
 * 之を号して太公望と曰う.
 *
 * **Unconditional, and not the 連用形-て switch (`renyouTe.ts`).** That switch
 * chooses between two printing conventions for one analysis — a bare 連用形
 * (酒を飲み肉を食ふ) or one with the connective spelled out (飲みて…食ひて) —
 * and editions differ over it. They do not differ over this: て曰く is the fixed
 * form of the phrase, as 而 is て wherever it stands, and kanbun.info, which
 * writes 連用中止法 elsewhere, writes this て 25 times in 26. So it is written
 * with the switch off, and with the switch on `renyouTeSuffix` sees this て
 * already written (`converbTe`) and adds nothing.
 *
 * **Not held to an い-sound 連用形**, unlike the `VerbForm=Conv` rule below it.
 * That rule withholds て after a 下二段 連用形 because a Conv adverbial in that
 * class hands on bare; here the received reading has the て on exactly that
 * class — 誉**め**て, 對**へ**て — so the gate would refuse the commonest case. An
 * adjective or 形容動詞 before 曰 takes nothing: 〜くて is not 文語, and 〜くして曰
 * occurs nowhere in kanbun.info.
 *
 * **Two refusals beyond `parataxisYueOf`'s own**, each from a passage the
 * first version of this rule made worse:
 *
 *  - **The 曰 has to be the next thing read**, or the name it gives, which
 *    inverts in front of it (之を命けて**大紀と**曰ふ). A verb whose reading hands
 *    on to anything else first is not joined to 曰 by its て: in 仁者雖告之曰
 *    the 雖 is postposed past 告, and 告げて**と雖も** is not a phrase; in 靖拜舞曰
 *    the verb before 曰 is 舞, not 拜 (拜みて舞ひ was written). A 而 in between
 *    writes its own て, which is the same refusal.
 *  - **Where a word runs straight on after 曰, V has to be a verb of naming.**
 *    A quotation is set off from 曰 by a mark and a name is not (see
 *    `isSpeechQuoteComplement`, where the mark separated 112 quotations from
 *    every name), so an unmarked 曰 is naming something, and what V is then
 *    decides the reading. 命之曰大紀 and 號曰安平君 name with V: 命けて…と曰う,
 *    号して…と曰う. 以一擊十曰走 and 知和曰常 do not: V there heads the subject
 *    clause the parser hung 曰 off, and the reading is 十を撃つを走と曰う, with
 *    no て. Over the kanbun.info parses, an unmarked `parataxis` 曰 after a
 *    VERB has 稱, 號, 命 or 謂 before it in the 9 passages read with て (謂 in
 *    其の将に謂いて…と曰わざるは無し), and other verbs (擊, 棄, 知, 畏, 成, 守,
 *    施, 奉, 居, 有) in those read without. A 曰 with nothing after it at all
 *    (its quotation cut off into the next parsed sentence) is admitted as a
 *    mark would be. */
function takesTeBeforeYue(token: Token, nextToken: Token | undefined, sentence: Sentence): boolean {
  const yue = parataxisYueOf(token.id, sentence);
  if (!yue || !nextToken) return false;
  // `nextToken` itself or one of its governors has to be the 曰.
  let reached = false;
  for (let at: Token | undefined = nextToken, steps = 0; at && steps < sentence.tokens.length; steps++) {
    if (at.id === yue.id) {
      reached = true;
      break;
    }
    if (at.head === at.id) break;
    const headId: number = at.head;
    at = sentence.tokens.find((t) => t.id === headId);
  }
  if (!reached) return false;
  const after = sentence.tokens.find((t) => t.id === yue.id + 1);
  if (after === undefined || isPunctuationMark([...after.text][0] ?? "")) return true;
  return NAMING_ACT_LEMMAS.has(token.lemma);
}

/** Verbs that name what 曰 then gives the name of — 命之曰大紀, 稱之曰夫人,
 * 號曰安平君, 字之曰道 — in the 舊字體 the treebank lemmatizes to and in the
 * 新字体 a hand-typed text may carry. See `takesTeBeforeYue`. */
const NAMING_ACT_LEMMAS: ReadonlySet<string> = new Set(["命", "稱", "称", "號", "号", "謂", "字", "名"]);

/** The conjugated okurigana (prefix + suffix, no kanji, no reading) for a
 * lexicon entry in the given form. Returns "" for a `fixedReading` entry
 * (which has no conjugation to apply — the whole word is invariant). */
export function conjugatedOkurigana(lex: LexiconEntry, form: ConjForm): string {
  const stated = lex.statedForms?.[form];
  if (stated !== undefined) return stated;
  if (!lex.conjClass) return "";
  return (lex.okuriganaPrefix ?? "") + conjugate(lex.conjClass, form);
}

/** Whether `conjugatedOkurigana` wrote this form out of the entry's own
 * `statedForms` rather than out of its paradigm — in which case the string on
 * the page is a **finished word and not a stem**, and neither `converbSuffix`
 * nor `renyouTeSuffix` may add anything after it.
 *
 * Asked at the two call sites that pair those three functions (`generator.ts`
 * and `KundokuView.ts`) rather than inside the two connective rules, for the
 * reason each of them gives about `conjClass`: what may be written after a
 * 連用形 turns on the okurigana *actually on the page*, and the call site is the
 * one place that has the entry, the form and that string all in hand. Both
 * panels ask it, so they cannot come apart over whether the て is written —
 * which is the same discipline the `form` and `conjClass` arguments beside it
 * already enforce.
 *
 * One entry answers yes today (`PREDICATE_YI`'s 連用形), so this is "" for every
 * other token and the two panels are byte-identical to what they were. */
export function writesStatedForm(lex: LexiconEntry, form: ConjForm): boolean {
  return lex.statedForms?.[form] !== undefined;
}

/** The `LexiconEntry` a syntax-chosen reading stands in with, once
 * `beatsLexicon` has stood `VERB_LEXICON` down for this token — or undefined
 * where the resolver could not derive a class, in which case the caller has
 * no lexicon entry at all and behaves exactly as it did before.
 *
 * The lexicon is keyed by lemma and holds one reading and one class per
 * word, which is the very thing a context-conditioned reading contradicts:
 * 立 is 四段タ行 たつ or 下二段タ行 たてる depending on whether it has an
 * object. Standing the whole entry down is right for the *reading*, but it
 * also threw away the class, and the two panels then had nothing left to
 * conjugate with and printed the citation form (廟を立つて for 廟を立てて).
 * Rebuilding an entry out of the resolved reading puts the syntax's answer
 * back on the ordinary path — `decideConjForm`, the renyoukei-in-coordination
 * rule, the rentaikei-before-毎 rule, negation — rather than around it.
 *
 * Shared by `generator.ts` and `KundokuView.ts` and deliberately not
 * open-coded in each: the two panels quietly disagreeing about the same
 * character is a failure mode this project has had before, and one function
 * they both call is what makes that impossible here.
 *
 * Wiktionary's own entry for the chosen reading is preferred over that
 * derivation wherever the lexicon has one — see `attestedSense`. The
 * mechanical route stays the fallback, and it has to: the lexicon knows only
 * words Wiktionary files a classical table for, which is most of them and
 * nowhere near all.
 *
 * A synthesized entry carries no `okuriganaPrefix`, because a prefix is a
 * *typesetting* fact about where a particular word's conventional okurigana
 * boundary falls (来たる) and nothing in a per-character reading can
 * reconstruct it — the resolver's own reading/okurigana split already is the
 * boundary for this path. An attested sense does carry one, having been
 * derived from a real spelling rather than from a per-character reading. */
/** Whether a sentence-final particle would write out a copula its own
 * predicate already carries.
 *
 * 也 reads as なり, and a ナリ活用形容動詞's 終止形 *is* なり — so 君子仁也 is
 * 君子仁なり, and emitting both gave 君子仁なりなり. The same doubling the
 * negation branch in `generator.ts` guards against, where a 不 carrying its
 * own `Polarity=Neg` would otherwise negate twice (亦説ばしからずずや).
 *
 * Keyed on the particle's own head, which is the predicate it attaches to —
 * 也 is `discourse@sp` of the word it closes — rather than on the text
 * emitted just before it, so both panels can ask the same question of the
 * same token and cannot drift. Only the copular particles: 乎's や and 哉's
 * かな repeat nothing, whatever the predicate is.
 *
 * **`decideConjForm` asks this too, and that is what makes the suppression and
 * the form one decision.** Suppressing the particle's なり while the predicate
 * went on taking the 連体形 the particle had asked for printed a bare
 * attributive with no copula anywhere — 君子仁**なる**, against what the
 * paragraph above says this writes — so the 也 branch there returns 終止形
 * exactly where this returns true. Asked of this function rather than of a
 * second test of the same fact, so that widening or narrowing what counts as a
 * repeated copula moves both halves at once. See that branch for the 17 gold
 * sentences it moves. */
export function repeatsPredicateCopula(token: Token, sentence: Sentence): boolean {
  if (sentenceFinalParticle(token.lemma) !== "なり") return false;
  const head = sentence.tokens.find((t) => t.id === token.head && t.id !== token.id);
  // **Only where the head writes that copula**, which takes two things. The
  // head has to conjugate by its entry at all: a NOUN 仁 has the entry and
  // writes no なり, so 能與人共之者仁也 printed 者は仁。 with the particle
  // suppressed and nothing in its place, against the received 仁なり. And no 非
  // may deny it: under 非 the head is written 連体形 + に and 非 writes あらず,
  // so 也's なり repeats nothing — 非奇也 printed 奇なるに非ず。 against the
  // received 奇に非ざるなり. Over kanbun.info the first shape is 六韜 1 and 6, 2
  // edits closer each, and 六韜 48, whose NOUN 奇 has a ナリ entry too; the
  // second is 李衛公問対 3.
  if (!head || !usesLexiconEntry(head)) return false;
  if (sentence.tokens.some((t) => t.head === head.id && t.id !== head.id && isNominalNegationUse(t))) return false;
  const conjClass = VERB_LEXICON[head.lemma]?.conjClass;
  return conjClass === "nari-keiyoudoushi" || conjClass === "tari-keiyoudoushi";
}

export function syntheticLexiconEntry(
  resolved: { conjClass?: ConjClass; reading?: string; okurigana?: string; okuriganaForm?: ConjForm },
  lemma: string,
): LexiconEntry | undefined {
  const attested = attestedSense(resolved, lemma);
  if (attested) return attested;
  if (!resolved.conjClass) return undefined;
  return { conjClass: resolved.conjClass, reading: resolved.reading };
}

/** Everything a reading picked off the furigana menu writes after its kanji:
 * its own ending, inflected for where the character stands, and separately
 * the extra ending the sentence needs of it.
 *
 * The two are returned apart rather than joined because the panels spend
 * them differently — `generator.ts` emits the extra as a piece of its own, so
 * that a synthesized copula is not covered by the word's first-mention ruby
 * gloss (see `rubyGloss.ts`), while `KundokuView.ts` concatenates. Both call
 * this, and only this, for the same reason `syntheticLexiconEntry` is shared:
 * the two panels quietly disagreeing about one character is a failure mode
 * this project has had before.
 *
 * `okurigana` — a hand-picked reading is taken by its own branch in both
 * panels, *ahead* of the lexicon branch (the choice outranks every
 * context-specific reading and the lexicon is one of them), so it never
 * reached the conjugation pipeline and could only be printed in its
 * dictionary form: 王立太子而去 with た.てる picked came out 王太子を立つて去ぬ
 * where the resolver's own 立 gives 立てて. This is that branch's way onto the
 * same pipeline, through the same helpers. `converbSuffix` rides along for
 * the same reason it does in both lexicon branches — and it, not
 * `endingForMorph`, is what supplies a converb's て here, because only it
 * knows to stand down when a following 而 is already writing one.
 *
 * The ending is returned uninflected wherever no class could be derived (see
 * `chosenConjClass` — the あ row above all). That is exactly what this path
 * printed before, so it is no regression; a confidently wrong paradigm would
 * be.
 *
 * **But "no class could be derived from the ending's shape" is not the same as
 * "no class is known", and this used to treat them as one.** `chosenConjClass`
 * reads the paradigm off the modern okurigana and abstains wherever the shape
 * does not state one — the あ row above all, where a bare え could be ア行, ヤ行,
 * ワ行 or (by ハ行転呼) ハ行 下二段. `attestedSense` answers exactly that
 * question from evidence instead of from shape, by looking the whole modern
 * headword up in the verb lexicon (`attestedSenseByModernSpelling` — reading
 * and okurigana together, since a reading alone is a stem). It was unreachable
 * from here: `syntheticLexiconEntry` was asked only once a class had *already*
 * been found, which is precisely when the lexicon has nothing left to add. So a
 * picked reading in the one position where the shape rule cannot help was
 * frozen at its citation form with the app's own best evidence unconsulted —
 * the wall 肥's こ.える hits, and the same one 覺's おぼ.える hits (see the report
 * for what that character still needs, which is a lexicon sense and not a
 * mechanism).
 *
 * **A stored okurigana is what the fallback is gated on**, which is the guard
 * the class requirement was really standing in for. An on'yomi pick carries no
 * ending at all, and a bare `undefined` okurigana matches every 形容動詞 sense
 * in the lexicon — which would conjugate a noun into なり. A pick with no
 * okurigana still needs a class up front, and still has one wherever it can:
 * `chosenConjClass` gives a VERB read on'yomi サ変 outright.
 *
 * **The okurigana handed over is the unconverted modern one**, which is what
 * `attestedSenseByModernSpelling` is keyed by, and that holds by construction
 * rather than by luck. `classicalVerbEnding` converts an ending using
 * `NIDAN_SHUUSHI`, which is exactly the union of the two tables
 * `classicalConjClass` derives a class from — so wherever no class was derived,
 * no conversion happened either, and the string still spells the modern
 * headword.
 *
 * `extra` — the branch used to `continue` before reaching `extraEndingFor`,
 * so every *synthesized* ending was silently dropped for a token whose
 * reading had been touched. A quantity predication lost its あり the moment
 * the reader changed the reading of whatever closed the quantity (負郭田三百畝
 * with 畝 repicked), and picking the original reading back did not bring it
 * back, because the choice is still stored and the token stays on this
 * branch. A picked reading should change what the character is read as, not
 * whether the sentence gets its predicate. Routed through `selectForm` rather
 * than emitting `primary` directly, so a picked token in a coordination chain
 * takes renyoukei exactly as an unpicked one does.
 *
 * Only the *synthesized* half of `extraEndingFor` is taken, never the
 * morph-driven one it answers with ahead of everything else. That is the
 * whole reason this branch outranks the grammar-word branches below it: a
 * token's morph says what the parse takes the character to be *doing* —
 * 未 is `Polarity=Neg` — and naming a dictionary reading for it is the reader
 * overruling exactly that. Emitting it anyway put the negation straight back,
 * so 未學禮 with ひつじ picked read 未ず禮を學ぶ. It would also have written a
 * converb's て twice on the conjugated path, where `decideConjForm` and
 * `converbSuffix` have already spent it — and it is `converbSuffix`, not
 * `endingForMorph`, that knows to stand down before a 而 already writing one.
 *
 * Nothing else needs holding back, and the two flags that guard this
 * elsewhere both turn out not to apply. `endingComplete` cannot arise here at
 * all: it marks a self-contained function-word gloss (もって, おいて), and a
 * picked reading is by construction a kanjidic content-word reading. Nor can
 * the サ変 す that `chosenOkurigana` supplies for a verb read on'yomi be
 * doubled: supplying it names a class, so that ending is the conjugated one,
 * and the synthesized copula/existence endings are offered to nominals
 * only. */
export interface PickedEnding {
  /** The word's own okurigana, converb suffix included. */
  okurigana: string;
  /** The synthesized ending the sentence owes it beyond that, or "". */
  extra: string;
  /** **The three below are how it was conjugated, not what it wrote**, and
   * they are here for the one caller that has to know: the 連用形の「て」 switch
   * writes て after a 連用形 and して after an adjective's or a 形容動詞's, and
   * neither question can be answered from the finished string. `renyouTe.ts`
   * used to re-derive all three by repeating the four lines above and then
   * check the re-derivation against `okurigana` before daring to act on it;
   * reporting them is the same answer without the second copy. Undefined
   * where no class was derived and the picked okurigana was printed as it
   * stood — which is a word standing at its citation form, and no form for the
   * switch to have an opinion about. */
  form?: ConjForm;
  conjClass?: ConjClass;
  /** `converbSuffix`'s own て, held apart from `okurigana` because a 下二段タ行
   * 連用形 *is* 立て and does want a further one (立てて) — see
   * `RenyouTeContext.converbTe`, which cannot tell the two apart by looking. */
  converbTe: string;
}

/** Re-exported from `bungoConjugation.ts`, where the definition now lives so
 * that `reading/chosenReading.ts` can ask the same question without importing
 * this file (which imports *it* — see `isBareChosenReading` above). Exported
 * from here as well because this is where its callers are and where its name
 * has always been looked up. */
export { isDescriptiveToken };

/** The fused span `token` belongs to, where that span is a **reduplicated
 * descriptive** — 蕭蕭, 冥冥, 皇皇, 穆穆, the タリ活用 class — or null.
 *
 * The claim is `redupTariReading`'s (readingResolver.ts), which is where the
 * evidence for it is written out; it lives here because a second caller needs
 * the same answer from the tree alone. `precedingFormSuppliesShite` below has
 * to know that the token before a 而 has already written a として of its own, and
 * it has no resolver to ask — the same position it is in for the タリ *suffix*,
 * whose arm it answers the same way and with the same bounded residual: this
 * says the span is one of these, not that `redupTariReading` succeeded in
 * reading it (that rule also asks KANJIDIC2 for an on'yomi on every member,
 * which nothing here can). Where it declines, the span writes no ending and
 * this withholds a て nothing else supplied.
 *
 * Three conditions, and the object guard `pinnedKeiyoudoushi` above makes on
 * the same evidence for the same reason — a 形容動詞 governs none:
 *
 *  - **Every member the same character.** The relation alone is not enough:
 *    `findCompoundSpans` unions whatever edges it finds, and the gold treebank's
 *    陶陶遂遂 is one span of four where a `flat@vv` joins two different
 *    reduplicated pairs. That is not a reduplication of anything.
 *  - **At least one `compound@redup` edge**, which is the parser's own
 *    statement that this is what it looks like.
 *  - **`isDescriptiveToken` on every member** — see `redupTariReading` for the
 *    counts behind asking all of them rather than the carrier alone.
 *
 * `findCompoundSpans` is consumed from inside this body only, never at module
 * evaluation, which is how the two module-level cycles this file already
 * carries resolve — see the `depClassification.ts` and `renyouTe.ts` notes at
 * the imports. Nothing in `reading/jmdictLookup.ts` imports back from here, so
 * this edge is one-way. */
export function descriptiveRedupSpan(token: Token, sentence: { tokens: Token[] }): CompoundSpan | null {
  const span = findCompoundSpans(sentence as Sentence).find((s) => s.tokenIds.includes(token.id));
  if (!span) return null;
  const byId = new Map(sentence.tokens.map((t) => [t.id, t]));
  const members = span.tokenIds.map((id) => byId.get(id)!);
  if (!members.some((t) => t.dep === "compound@redup")) return null;
  if (members.some((t) => t.text !== members[0].text)) return null;
  if (!members.every(isDescriptiveToken)) return null;
  if (hasObject(carrierOf(span, sentence as Sentence), sentence as Sentence)) return null;
  return span;
}

/** The fused span `token` belongs to, where that span is a **two-character
 * descriptive binome** — 恢洪, 脩廣, 幽清, 廉潔, 富貴, the ナリ活用 class — or
 * null.
 *
 * The claim is `descriptiveBinomeNariReading`'s (readingResolver.ts), which is
 * where the evidence for it is written out; it lives here beside
 * `descriptiveRedupSpan` because it is that function's rule one shape over and
 * the two have to keep the same shape, and because a caller with no resolver in
 * hand may need the same answer from the tree alone. As there, this says the
 * span is one of these, not that the resolver succeeded in reading it (that
 * rule also asks KANJIDIC2 for an on'yomi on every member, which nothing here
 * can).
 *
 * Five conditions, three of them `descriptiveRedupSpan`'s own:
 *
 *  - **Exactly two members.** The word this names is a binome, and the corpus
 *    holds only two all-descriptive spans that are longer: 恍惚惚, where a
 *    `flat@vv` and a `compound@redup` meet in one span and the reduplication is
 *    of 惚 alone, and 暑勞苦, three coordinated qualities the parser has fused.
 *    Neither is a two-character Sino-Japanese word and neither is what the ナリ
 *    class is a claim about.
 *  - **At least one `flat@vv` edge**, which is the parser's own statement that
 *    these two characters fill one predicate slot together — the same weight
 *    `descriptiveRedupSpan` puts on `compound@redup`. `findCompoundSpans` also
 *    fuses an attributive `mod`, and the three all-descriptive spans it reaches
 *    that way (空虚 twice, 盛衰 once) are a modifier standing over its head
 *    rather than one word.
 *  - **Not a reduplication**, tested as `descriptiveRedupSpan` tests it — every
 *    member the same character. That span is the *other* half of the classical
 *    two-character descriptive and it is タリ活用, not ナリ活用 (蕭蕭たり,
 *    冥冥たる). `redupTariReading` stands ahead of the ナリ rule and claims it,
 *    but it can decline (no on'yomi on a member), and a declined reduplication
 *    must not fall into this one and be read 蕭蕭なり.
 *  - **`isDescriptiveToken` on every member**, which is the whole of the
 *    distinction between 恢洪 and 彌綸: see `descriptiveBinomeNariReading` for
 *    the counts.
 *  - **No object on the carrier**, the guard `descriptiveRedupSpan` and
 *    `pinnedKeiyoudoushi` both make on the same evidence — a 形容動詞 governs
 *    none — and which pays for itself here: of the five corpus binomes of this
 *    shape whose carrier has a `comp:obj`, four are read サ変 by the received
 *    text (便章す, 哀戚し, 表章す, 熒惑し) against one ナリ.
 *  - **And the carrier is not itself an object**, which is the condition the
 *    corpus argues for hardest. A 形容動詞 stem is a 体言, and one standing in
 *    another verb's object slot is being used as the noun it is, with no
 *    predicate ending of any kind: 遠近を計る, 吉凶を視る, 剛柔を兼ぬ, 輕重を
 *    以てす, 淑慝を旌別す. Of the **61** spans of this shape whose carrier is a
 *    `comp:obj`, the received reading writes the word **bare 43** times against
 *    ナリ 5, サ変 6 and タリ 1 — where the `mod` slot next door runs ナリ 10 to
 *    bare 5. Claiming those 43 for ナリ writes a なり that nothing in the
 *    received text answers to, and one kana longer than the す they already
 *    carried. The object slot is left to `spanSuruReading` exactly as it was;
 *    what it prints there is no better, and this rule has nothing to say about
 *    a word being used as a noun. */



/** `isDescriptiveToken`, **widened to the xpos column**, and asked only of a
 * binome member.
 *
 * The doc on `descriptiveBinomeNariReading` says the xpos draws the line
 * between a noun-verb (彌綸す, `v,動詞,行為,*`) and a quality (恢洪, 幽清,
 * `v,動詞,描写,*`). `isDescriptiveToken` reads UPOS and `Degree` and never that
 * column, so a member the parser returns as NOUN over the *verbal* descriptive
 * xpos fell out of the class — and took the whole span with it.
 *
 * **What that cost is stated in `prosePunctuation.test.ts`**: parser 0.3.1
 * returns the 渴 of 燥渴 as NOUN over `v,動詞,描写,境遇` and attaches it by plain
 * `flat`, a shape gold never writes (all 8 渴 there are VERB on `flat@vv`).
 * That file's whole point is that the span reads the same under the parser's
 * annotation as under the corrected one, and with the UPOS test alone it no
 * longer did: 燥渴**なり** corrected, 燥渴**す** as parsed. A reading that
 * depends on a tag the file documents as wrong is the fault, not the fixture.
 *
 * Bounded twice. It is asked of a **member of a two-character on'yomi binome**
 * and never of a token standing alone, where a NOUN over a descriptive xpos is
 * simply a noun (形, 色 carry `n,名詞,描写,形質` — a *nominal* xpos, which this
 * does not match either). And the plain `flat` it admits beside `flat@vv` has
 * to clear the same descriptive test on **every** member, which is what keeps
 * the name-mate `flat` chains (柳奭韓瑗, all `n,名詞,人,*`) out. */
function isDescriptiveMember(token: Token): boolean {
  return isDescriptiveToken(token) || /^v,動詞,描写,/.test(token.xpos ?? "");
}

export function descriptiveBinomeSpan(token: Token, sentence: { tokens: Token[] }): CompoundSpan | null {
  const span = findCompoundSpans(sentence as Sentence).find((s) => s.tokenIds.includes(token.id));
  if (!span || span.tokenIds.length !== 2) return null;
  const byId = new Map(sentence.tokens.map((t) => [t.id, t]));
  const members = span.tokenIds.map((id) => byId.get(id)!);
  // `flat@vv` or the plain `flat` the parser writes in its place — see
  // `isDescriptiveMember` for why the second is admitted and what bounds it.
  if (!members.some((t) => t.dep === "flat@vv" || t.dep === "flat")) return null;
  if (members.every((t) => t.text === members[0].text)) return null;
  if (!members.every(isDescriptiveMember)) return null;
  const carrier = carrierOf(span, sentence as Sentence);
  if (hasObject(carrier, sentence as Sentence)) return null;
  if (carrier.dep === "comp:obj" || carrier.dep.startsWith("comp:obj@")) return null;
  // **A carrier standing as the subject is *not* excluded, and that was
  // measured.** The object line above suggests it should be — a 形容動詞 stem
  // is a 体言 either way — and excluding it does read three corpus edits
  // better. It also costs the shape the rule exists for: 宏遠不可指掌 and
  // 巨闊不可度量 (周髀算經) hang 宏遠 and 巨闊 off the modal 可 by `subj`, and
  // the received reading is 其の宏遠**なる**こと, 其の巨闊**なる**こと — a
  // clause being predicated, not a quality being named. What the corpus cases
  // have instead is a copular sentence whose *root* is the binome
  // (地者遠近險易廣狹死生也), and the list bound in `compoundSuruOkurigana`
  // already answers those. Three edits is not worth reading a predicated
  // clause as a noun.
  return span;
}

/** **A bare hand-picked reading on a descriptive word is a 形容動詞**, and this
 * is the paradigm it inflects by — or `picked` back unchanged for every other
 * kind of pick.
 *
 * The reader: *pinned on'yomi for an adjective should always be treated as a
 * nari- or tari-adjective.*
 *
 * **What the pin was before this.** A reading stored with no ending and no
 * class beside it is what `candidateReadings`' on'yomi arm writes (see
 * `isBareChosenReading`, which is the whole of the test), and it reached both
 * panels through `chosenOkurigana`, whose answer for such a pick is サ変's す on
 * a VERB and nothing at all on anything else. Neither is a paradigm a
 * descriptive can inflect by, so a pinned 貧 could not take a 連用形, could not
 * take a 連体形, and could not take a case particle that depends on a form: the
 * reader's own 不飲一斗、適以益貧 has 貧 `comp:pred` of 適 and reads 貧しく適き
 * unpinned — `isBecomingComplement`'s 連用形 — while pinned `Reading=ひん` it
 * printed a bare 貧(ひん) with the whole clause hanging off nothing.
 *
 * **ナリ or タリ is decided by whether the word is half of a binom**, which is
 * the distinction the classical grammar actually draws: タリ活用 is the class of
 * the two-character Sino-Japanese descriptive compound (愕然たり, 莞爾たり,
 * 洋洋たり) and ナリ活用 covers everything else, single Sino-Japanese morphemes
 * included (貧なり, 愚なり, 靜かなり). This treebank tokenises one character per
 * token, so "half of a binom" is a fact about the neighbours and not about the
 * token, and there is exactly one shape of it this app already recognises:
 * `tariSuffixGroup`, the stem + 然/如/爾/乎/焉 suffix that `tariSuffixReading`
 * reads as one on'yomi word. So:
 *
 *  - **The suffix takes タリ活用**, spelled the way `tariSuffixReading` spells
 *    it. This is the arm that keeps a pin from *contradicting* that rule: a
 *    pinned ぜん on the 然 of 元帝愕然 printed 元の帝愕然, the たり gone, because
 *    the pick is consulted ahead of every context rule and 然 is a PART, which
 *    `chosenOkurigana` gives no ending. It now reads 元の帝愕然たり — the same
 *    string the unpinned sentence gives.
 *  - **The stem takes no ending at all**, for the reason `tariSuffixReading`
 *    marks it `endingComplete`: the ending belongs to the binom and the suffix
 *    is already writing it. A pinned がく on 愕 printed 元の帝愕**す**然たり,
 *    サ変's 終止形 wedged inside a word; it now reads 元の帝愕然たり.
 *  - **Everything else adjectival takes ナリ活用**, and inflects from there
 *    through `decideConjForm` like any other class — 未然 なら, 連用 に, 終止
 *    なり, 連体 なる, 已然 なれ. 貧 is 貧(ひん)に, and with the 連用形の「て」
 *    switch on 貧(ひん)にして, since ナリ活用 is in `SHITE_CLASSES`.
 *
 * **Reach, measured over `lzh_kyoto-sud-{train,dev,test}` (86,239 sentences,
 * 433,169 tokens).** The タリ arm is not a guess about a rare shape: those files
 * hold **310** stem+suffix groups the app's own `tariSuffixGroup` gate accepts,
 * and **184** of their stems carry `Degree=Pos` — so without the group check the
 * ナリ arm below would have claimed 184 binom halves and written 愕なり然たり
 * over them.
 *
 * **What counts as adjectival is `isDescriptiveToken` above** — `Degree=Pos`,
 * and ADJ beside it — which is where the evidence for that test is written out,
 * and which `redupTariReading` now asks the same question of.
 *
 * **An object stands the whole rule down**, because a 形容動詞 governs none. A
 * `Degree=Pos` token with a `comp:obj` is a descriptive being used as a
 * transitive verb, which is a distinction `readingResolver.ts` already draws on
 * the same evidence (its `adjectivalSense` is overruled by `wantTransitive` —
 * "an object overrides that suppression, because it is evidence about the same
 * thing"), and it is live in the reader's own text: 僧愚之 has 愚 tagged
 * `Degree=Pos` `v,動詞,描写,形質` — VERB up to parser 0.3.1, **ADJ** from 0.3.2,
 * which is why the サ変 this case needs is now written out in the body below
 * instead of being carried in by `chosenOkurigana` — with 之 as its `comp:obj`,
 * pinned `Reading=ぐ`,
 * and it is "the monk made a fool of him" — 僧これを愚す, not 僧これを愚に. That
 * sentence is why the guard is here rather than argued for in the abstract.
 *
 * **Spent by `pickedEnding` and by nothing else**, which is what puts both
 * panels on one answer: they each call that function for a picked token and
 * take the ending it returns, so a class named here reaches the 訓読文's
 * okurigana slot and the 書き下し文's ending piece as the same string, and the
 * 連用形の「て」 switch reads the form and class off the same `PickedEnding`. It
 * is deliberately not folded into `chosenReading.ts`, where the pick's other
 * two fields are decided: this needs `tariSuffixGroup` and `hasObject`, so it
 * needs the sentence and this module, and that module cannot import this one
 * (the edge already runs the other way).
 *
 * **What it does not reach, and no longer needs to: a reduplication.** 蕭蕭,
 * 冥冥 and the other 634 `compound@redup` binoms in the gold treebank are the
 * other half of the タリ class, and 382 of them are descriptive (`Degree=Pos` on
 * both halves — the same 382 as `v,動詞,描写,*` on both halves; 390 have it on
 * the head alone). This rule cannot see them, because `compound@redup` is one
 * of `SPAN_FUSING_DEPS` — both panels render such a pair through the fused-span
 * branch, which stands *ahead* of the hand-picked branch and writes the group's
 * ending itself, once, after the last member. A rule here that gave *one*
 * member of a fused pair ナリ would print 木蕭なり蕭なり.
 *
 * Both halves of that are now answered where they belong, in
 * `readingResolver.ts`: `redupTariReading` gives the span タリ活用 (木蕭蕭たり,
 * where `spanSuruReading` used to make it the サ変 木蕭蕭す), and the resolver's
 * hand-picked branch carries a span's class through a bare pin, so a pinned
 * member gets the same たり the unpinned sentence gives instead of losing the
 * ending altogether. The ending stays the span's throughout — written once, at
 * the last member, by `compoundSuruOkurigana`.
 *
 * **The okurigana returned is always the citation form — the 終止形 — and never
 * the form the sentence wants.** It is a *seed*, not an answer:
 * `syntheticLexiconEntry` hands it to `attestedSense`, which matches a
 * `LEXICON_SENSES` entry by comparing `conjugatedOkurigana(sense, "shuushi")`
 * against it, and `pickedEnding` then re-conjugates whatever entry comes back
 * for the form the position actually calls for. Spelling a 連用形 here would
 * therefore change nothing that prints, and would quietly break the match — a
 * sense with an `okuriganaPrefix` (靜**か**なり) would stop being found and lose
 * its prefix. The form is reported separately, below.
 *
 * **An ADV takes the 連用形, and that is the one form named here rather than
 * left to `decideConjForm`.** The reader's own 忽覺咽中暴癢 pins `Reading=にはか`
 * on a 暴 the parser tags `ADV` with `Degree=Pos`, and the pin printed 暴なり:
 * `decideConjForm` reads the tree, finds a `mod` edge onto the root and none of
 * its 連体形/未然形 environments, and answers 終止形 — which is right for a
 * predicate and wrong for an adverb, since an adverb is not a predicate at all.
 * Unpinned, the same token reads 暴に, because `adverbialCopulaEnding` in
 * `readingResolver.ts` answers for an ADV-tagged 形容動詞 without asking the
 * conjugation pipeline anything; the pick, which outranks every resolver rule,
 * routed around it. So the pin now reaches the same 連用形 by the same argument,
 * written out in full at that function: *a word tagged ADV is modifying a
 * predicate, and a 形容動詞 modifying a predicate is in its 連用形, whatever the
 * predicate turns out to be.* 暴 is 暴に, and 暴にして under the 連用形の「て」
 * switch, which is exactly what the unpinned token gives through
 * `adverbialRenyouTe` — the pinned one reaching the switch through
 * `pickedRenyouTe` instead, off the `form` and `conjClass` reported here.
 *
 * **Named here and not in `decideConjForm`, deliberately.** That function is
 * asked about tokens this one never sees, and one of them is an ADV: a タリ
 * binom's stem may be tagged ADV (`TARI_STEM_POS` admits it), and it is that
 * stem — not the 然 the ending is written on — that `conjugationSubject` puts
 * the form question to. A blanket "ADV means 連用形" there would make every such
 * binom として wherever it stands, including in final position, where たり is
 * what a タリ活用 predicate takes. The claim is about a word being *used
 * adverbially*, which the pin is being told by the tag on the token it is
 * actually on, so it is answered on that token and nowhere wider. */
export function pinnedKeiyoudoushi(
  picked: { reading: string; okurigana?: string; conjClass?: ConjClass },
  token: Token,
  sentence: { tokens: Token[] },
): { reading: string; okurigana?: string; conjClass?: ConjClass; form?: ConjForm } {
  if (!isBareChosenReading(token)) return picked;
  const group = tariSuffixGroup(token, sentence);
  if (group) {
    return token.id === group.suffix.id
      ? { reading: picked.reading, okurigana: conjugate("tari-keiyoudoushi", "shuushi"), conjClass: "tari-keiyoudoushi" }
      : { reading: picked.reading };
  }
  if (!isDescriptiveToken(token)) return picked;
  // **A descriptive that governs an object is a transitive use and is
  // declined** — 僧愚之 is "the monk made a fool of him", not "the monk was
  // foolish", so サ変 stands and no copula is synthesized. The same evidence
  // `readingResolver.ts`'s own transitivity check runs on.
  //
  // Where a `picked` for such a token used to arrive with サ変 already on it,
  // this returned it untouched. It no longer does: `chosenOkurigana` supplies
  // the す on `pos === "VERB"` and deliberately still does (a genuine adjective
  // wants なり, which is this function's other arm), and parser 0.3.2 tags the
  // stative ADJ — so a pinned 愚(ぐ) with an object came back with no ending at
  // all. Written out here rather than by widening that gate, because this is
  // the only place that knows there is an object: `chosenOkurigana` is handed
  // a token and no sentence, which is why it can answer the tag and not the
  // use. `isBareChosenReading` above is what guarantees there is no stored
  // ending or class of the reader's own to overwrite.
  if (hasObject(token, sentence)) {
    return token.pos === "VERB"
      ? picked
      : { reading: picked.reading, okurigana: conjugate("sa-hen", "shuushi"), conjClass: "sa-hen" };
  }
  return {
    reading: picked.reading,
    okurigana: conjugate("nari-keiyoudoushi", "shuushi"),
    conjClass: "nari-keiyoudoushi",
    form: token.pos === "ADV" ? "renyou" : undefined,
  };
}

/** A hand-picked reading of a positive comparison 如/若, with the ク活用 class
 * `COMPARATIVE_GOTOSHI` names written onto it — so that a picked ごとし inflects
 * exactly as an unpicked one does.
 *
 * **Only where the pick states no class of its own**, which is the discipline
 * `pinnedKeiyoudoushi` follows for its own rule: a reader who has named a
 * paradigm outright (`ConjClass=` in MISC) has said something this cannot
 * improve on. What it corrects is the ordinary pick, where the stored ending is
 * a bare し and no paradigm can be read back off it.
 *
 * **And only where the pick is the comparison's own reading.** A pick that
 * spells something else is the reader saying this 如 is a different word — the
 * conditional もし, or the 移動 verb "go to" — and handing it ごとし's paradigm
 * would inflect one word by another's table. `isComparativeYu` has already
 * refused those two by tag; this is the further guard for a tag the reader has
 * overruled by hand. */
function pinnedComparison(
  picked: { reading: string; okurigana?: string; conjClass?: ConjClass; form?: ConjForm },
  token: Token,
  sentence: { tokens: Token[] },
): { reading: string; okurigana?: string; conjClass?: ConjClass; form?: ConjForm } {
  if (picked.conjClass) return picked;
  const entry = comparisonLexiconEntry(token, sentence);
  if (!entry?.conjClass || picked.reading !== entry.reading) return picked;
  return { ...picked, conjClass: entry.conjClass };
}

export function pickedEnding(
  rawPicked: { reading: string; okurigana?: string; conjClass?: ConjClass },
  token: Token,
  root: Token | undefined,
  plan: ReadingPlan,
  resolve: ReadingResolver,
): PickedEnding {
  // A bare pin on a descriptive is a 形容動詞 — the reader's rule, applied to
  // `picked` before anything reads it so that the okurigana, the form, the
  // converb's て and the 連用形の「て」 switch all come out of the one paradigm.
  // See `pinnedKeiyoudoushi`.
  //
  // …and a pin on a positive comparison 如/若 is ク活用 ごとし, named the same
  // way and for the same reason. The menu offers ごと + し off `overrides.json`,
  // and a pick stores exactly that; but a bare し states no paradigm that
  // `chosenConjClass` can read back — `classicalConjClass("し")` is undefined —
  // so the ending froze at the 終止形 wherever it stood, and 蠕動如游魚 printed
  // 游魚の如**し** in a clause `decideConjForm` had already answered 連用形 for.
  // Naming the class is what puts the pick back on the conjugation pipeline,
  // which is `pinnedKeiyoudoushi`'s own argument one construction over.
  // `comparisonLexiconEntry` is asked so that a picked 如 and an unpicked one
  // inflect by the one paradigm.
  const picked = pinnedComparison(pinnedKeiyoudoushi(rawPicked, token, plan.sentence), token, plan.sentence);
  const lex = picked.conjClass || picked.okurigana ? syntheticLexiconEntry(picked, token.lemma) : undefined;
  const conjClass = lex?.conjClass;
  const next = nextMeaningfulToken(plan, token.id);
  // A governing 再読文字 dictates the form outright — 未 wants 未然形 whatever
  // else follows — and is consulted ahead of the ordinary context rules, the
  // same order both lexicon branches use. The resolver goes through with it
  // for the same reason too: a following 者 is attributive only under its
  // もの reading, and nothing but the resolver knows which of its two
  // readings this one took (see `isNominalizerAhead`).
  //
  // `picked.form` is the third source, and it is a form the rule that named the
  // *class* named at the same time: an ADV-tagged 形容動詞 is in its 連用形 by
  // construction, and `decideConjForm` — which reads the tree for what a
  // predicate owes its neighbours — has no question to ask about a word that is
  // not being predicated at all. See `pinnedKeiyoudoushi`, where the argument is
  // written out. Below the 再読文字 and not above it, keeping that character's
  // "dictates the form outright" precedence exactly as the comment above states
  // it; the two cannot in practice both answer, since a 再読文字 governs the
  // predicate of its clause and this describes a modifier of one.
  const pickedForm = conjClass
    ? rereadGovernedForm(token.id, plan) ??
      picked.form ??
      decideConjForm(token, next, plan.sentence, conjClass, resolve)
    : undefined;
  const converbTe = conjClass && pickedForm ? converbSuffix(token, next, conjClass, pickedForm, plan.sentence) : "";
  // **A pinned particle takes the ending its own rule would have written.** The
  // resolver merges it onto the pick (see `createReadingResolver`'s note on
  // `zheParticleReading`) — the reading stays the reader's, the particle is the
  // sentence's — and this is where the panels collect it, since both reach the
  // ending through here and neither asks the resolver for a token it has a pin
  // on. 孝弟也者 with `Reading=もの` on the 者 printed もの where it wants ものは.
  //
  // Held to PART and to a pick with no ending of its own: a particle's ending is
  // the app's own machinery throughout (`overrides.json`'s glosses are complete,
  // and 者's は is written by rule), where a content word's belongs to the pick.
  const pinnedParticleOkurigana =
    token.pos === "PART" && picked.okurigana === undefined && !conjClass
      ? resolve(token, plan.sentence).okurigana
      : undefined;
  const okurigana =
    conjClass && pickedForm
      ? conjugatedOkurigana(lex!, pickedForm) + converbTe
      : pinnedParticleOkurigana ?? picked.okurigana ?? "";
  const conjugatedWith = { form: pickedForm, conjClass, converbTe };

  // `extraEndingFor` returns the morph ending in preference to everything
  // else when a token has one, so a token that has one is simply not asked.
  if (morphEndingFor(token)) return { okurigana, extra: "", ...conjugatedWith };
  const extra = extraEndingFor(token, root, plan.sentence);
  return { okurigana, extra: extra ? selectForm(extra, plan, token.id) : "", ...conjugatedWith };
}

/** Wiktionary's own classified sense for the word the syntax just chose, or
 * undefined where its data does not settle the question.
 *
 * The reading is the key, because the reading is what the syntax decided:
 * having asked whether 肥 has an object and been told no, the resolver is
 * reading こ+える, and the sense wanted is whichever of 肥's classical words
 * is written こ+える. But a reading alone is a *stem*, and a stem is shared by
 * words that are not the same word — 悔 read く is 悔いる to KANJIDIC2 and
 * 悔む to Wiktionary, 哀 read あわ is 哀れむ and 哀む — so the okurigana has to
 * agree too, or the lexicon quietly answers about a different verb. Which
 * spelling the okurigana is compared in depends on how far the resolver got:
 *
 *  - It reached a class. Then it has already converted the ending into
 *    classical shape, and it has already identified the paradigm, so a sense
 *    is taken only if it agrees on *both* — which means the sense adds
 *    nothing but its `okuriganaPrefix`, and nothing the resolver decided is
 *    ever overruled. 立's attested senses are both 四段 (立つ and a second ラ行
 *    word), so with an object — where the modern 立てる gives 下二段タ行 —
 *    neither is taken and 廟を立てて stands exactly as before.
 *  - It reached none. Then the ending is still KANJIDIC2's own modern
 *    okurigana, untouched, and the sense must be the word that spells itself
 *    that way today — see `modernOkurigana`. 馬肥's える is 肥ゆ's modern
 *    spelling and not 肥やす's やす, which is what separates the pair, and
 *    what makes 馬肥 read 馬肥ゆ.
 *
 * The second case is the whole point of consulting the lexicon at all: the
 * resolver reaches no class precisely where the modern spelling is ambiguous
 * about which classical paradigm it descends from, and the あ row is the
 * chief such gap (a bare え could be ア行, ヤ行 or ワ行下二段 — see
 * `classicalConjClass`). Wiktionary has the answer that the surface form does
 * not carry.
 *
 * More than one surviving candidate means the evidence to hand does not
 * identify the word, so nothing is claimed and the mechanical route stands —
 * see `attestedSenseByModernSpelling`, which `classicalConjClass` now asks the
 * same question of, one step earlier and on the *modern* ending.
 *
 * **The form compared in is the resolver's own, and it is not always the
 * 終止形.** Every rule in `readingResolver.ts` but one answers with a citation
 * form, which is why "shuushi" is the default here and was for a long time the
 * only thing written. `adverbialCopulaEnding` is the exception — an ADV-tagged
 * 形容動詞 is in its 連用形 whatever the predicate turns out to be — and it
 * reports the form on `okuriganaForm` (see `ResolvedReading` in
 * `reading/types.ts`) precisely so that this comparison can be made in it.
 * Comparing a 連用形 ending against a 終止形 conjugation matched nothing, which
 * is silent rather than wrong for a sense with no `okuriganaPrefix` — the
 * synthesized fallback states the same class and reading — and loses the prefix
 * for one that has it: 大 as おほ + い answered いに, was compared against
 * いなり, and printed 大(おほ)に on all 399 adverbial tokens.
 *
 * Reported rather than accepted by widening the comparison to *either* form,
 * which was the other route and was measured to be unambiguous within the
 * shipped lexicon. It was declined for what it would do to a hand-typed pin: a
 * pin carries no `okuriganaForm`, so a reader who spelled a 連用形 into one
 * would find it newly matching a sense and being re-conjugated where today it
 * stands frozen exactly as written. The narrower route cannot reach a pin at
 * all. */
function attestedSense(
  resolved: { conjClass?: ConjClass; reading?: string; okurigana?: string; okuriganaForm?: ConjForm },
  lemma: string,
) {
  if (resolved.conjClass) {
    const form = resolved.okuriganaForm ?? "shuushi";
    return lexiconSensesByReading(lemma, resolved.reading).find(
      (sense) => sense.conjClass === resolved.conjClass && conjugatedOkurigana(sense, form) === resolved.okurigana,
    );
  }
  return attestedSenseByModernSpelling(lemma, resolved.reading, resolved.okurigana);
}

/** True for a token that heads one clause of a coordination — either side of
 * it, and at whatever depth the coordination sits.
 *
 * Three things had to be got right here, and each was learned the hard way
 * from a sentence that came out wrong:
 *
 *  - **Either side.** A `conj:coord` sibling is a clause head (生而神靈，
 *    弱而能言，... — each of 神靈/能/徇/敦/聰 is its own clause's predicate,
 *    parallel to 生/弱/幼/長/成), and so is the token it is coordinated
 *    *onto*, which is the first conjunct and no less a clause head for being
 *    first. Only the second half used to count, so 而家豪富、不以飲為累也 with
 *    豪富 heading the first clause got no ending, while the identical
 *    coordination written the other way round got 豪富にして.
 *
 *  - **At any depth.** The other bound was `token.head === root.id`, which
 *    is a much stronger claim than "this is a clause": in real text the
 *    coordination is routinely nested. In the 酒蟲 parse the chain is
 *    三百 ← 種 ← 豪, so 豪 heads a clause perfectly well while being two
 *    edges from the root and hanging off a `parataxis`, and the direct-
 *    sibling test rejected it.
 *
 *  - **But not any `conj:coord` anywhere**, which is what the direct-sibling
 *    bound was really guarding and why it cannot simply be dropped. A
 *    `conj:coord` nested inside some other complement (人皆可以為堯舜's 舜,
 *    coordinate with 堯 as a shared *nominal* complement of 為) coordinates
 *    two arguments, not two clauses, and must not pick up a synthesized
 *    ending. What separates the two is not depth but what the path is made
 *    of: 豪 reaches the root through `conj:coord` then `parataxis` — both
 *    relations that string *predicates* together — while 舜 reaches it
 *    through 堯's `comp:obj`, which is an argument relation and stops the
 *    walk. So the rule is that every edge from here to the root must be one
 *    of `COORDINATION_DEPS`, the set this file already keeps for exactly
 *    "relations that string predicates into one chain".
 *
 * A quoted clause reached through `parataxis` does satisfy that, and its
 * predicate genuinely is a clause head, so it is admitted deliberately
 * rather than by oversight.
 *
 * **The first conjunct of a *nominalised* clause is the third arm**, and it is
 * there because the "either side" claim above was only ever implemented for the
 * ROOT. The walk below asks about the token a conjunct hangs *off*; the ROOT
 * branch asks about the token a conjunct hangs *onto*; and between them sat the
 * case where the coordination is neither at the root nor reached from its far
 * end — a chain standing in a relative clause. 有子's 其為人也孝弟而好犯上者鮮矣
 * is it: 孝弟 is the `mod` of 者 with 好 `conj:coord` onto it, so it is the first
 * link of a two-link chain and got no ending at all, reading 孝弟、而して上を犯す
 * を好む者 where it wants 孝弟にして上を犯すを好む者.
 *
 * **`mod` of a PART and nothing else**, which is the same claim `extraEndingFor`
 * already makes for a particle at the ROOT (see `PARTICLE_HEAD_POS`): 者 marks
 * what its clause is about and predicates nothing itself, so its `mod` *is* a
 * clause position, exactly as the root is. Dropping the path guard outright
 * instead was measured and is wrong: over
 * `lzh_kyoto-sud-{train,dev,test}.relabeled_ext.udep_ruled.punct.rulemerged.adjfix.conllu`
 * **10** compound nominals head a coordination onto a following predicate from
 * outside a coordination path, and all 10 are argument-internal or list
 * coordination that must take no copula — 虜王離**等**, 衣服玩好, 滅知氏而分其地,
 * 離一切顛倒夢想苦惱. The `mod`-of-PART shape is disjoint from every one of them.
 *
 * **Measured over the same file**: a nominal `mod` of a PART heading a
 * `conj:coord` onto a following predicate occurs **7** times, all under 者, and
 * every one of them wants the 連用形 — 惡勇而無禮者 (勇にして禮無き者), 死三日而后
 * 斂者 (三日にして後斂する者), 夫一人身、而牽留萬乘者, 十人而從一人者, 齊衰三月與
 * 大功同者. The seventh, 非其人而得進者, is a 非 predicate and stands its own
 * copula down two guards later in `extraEndingFor`. None of the 7 is a
 * compound, so restricting this arm to `isCompoundNominal` — which is how the
 * reader states the rule, and how the `parataxis` widening above is bounded —
 * would have bought no safety the measurement does not already give and would
 * have left the 7 unread. The chain itself is `isNonFinalCoordinand`'s, so the
 * links, the 使役 exclusion and the full-stop guard are the ones every other
 * coordination rule in this file uses. */
function isCoordinateClauseHead(token: Token, root: Token | undefined, sentence: Sentence): boolean {
  if (!root) return false;
  // The first conjunct: the ROOT itself, when something is coordinated onto
  // it directly.
  if (token.id === root.id) {
    return sentence.tokens.some((t) => t.head === token.id && t.id !== token.id && t.dep === "conj:coord");
  }
  // …and the first conjunct of a clause a particle nominalises, which is a
  // clause position for the same reason the root is one.
  if (token.dep === "mod") {
    const head = sentence.tokens.find((t) => t.id === token.head && t.id !== token.id);
    if (head && PARTICLE_HEAD_POS.has(head.pos) && isNonFinalCoordinand(token, sentence, true)) return true;
  }
  // A noun compound counts across `parataxis` as well, for the reason
  // `isCompoundNominal` gives and `predicateCoordinationChain`'s own `links`
  // states: the compound is the shape the mixed uses of that relation do not
  // have at their far end, so admitting it does not admit them. Everything
  // else still needs an explicit coordinator.
  if (!NOMINAL_COORDINATION_DEPS.has(token.dep) && !(COORDINATION_DEPS.has(token.dep) && isCompoundNominal(token, sentence)))
    return false;
  const byId = new Map(sentence.tokens.map((t) => [t.id, t]));
  const seen = new Set<number>([token.id]);
  for (let current = token; ; ) {
    if (!COORDINATION_DEPS.has(current.dep)) return false;
    const head = byId.get(current.head);
    if (!head || head.id === current.id || seen.has(head.id)) return false;
    if (head.id === root.id) return true;
    seen.add(head.id);
    current = head;
  }
}

/** True when `token` stands inside a clause a **particle nominalises** — the
 * `mod` of a 者/所, or a conjunct chained onto one.
 *
 * The relation is the reader's: a predicate dependent of 者 is `mod`, **3,457**
 * times over
 * `lzh_kyoto-sud-{train,dev,test}.relabeled_ext.udep_ruled.punct.rulemerged.adjfix.conllu`.
 * What the position means is what `PARTICLE_HEAD_POS` already says of a particle
 * at the ROOT — 者 marks what its clause is about and predicates nothing itself —
 * read one level down: the clause is a *noun*, so no 終止形 can stand anywhere
 * inside it, and the only finite-looking form it ends in is the 連体形 that meets
 * the particle.
 *
 * Walks up through `COORDINATION_DEPS` so a later conjunct is inside the clause
 * its first conjunct heads, and stops at anything else — an argument or an
 * adjunct of the clause is a construction of its own and is not being asked
 * about here.
 *
 * `NAME_FUSING_DEPS` is walked through as well, and it is not optional: the one
 * caller asks about whichever token *carries* the ending, and for a fused span
 * that is the last member, not the head. 孝弟 hands its copula to 弟, whose own
 * relation is `compound` — so a walk that stopped there would say no about every
 * compound, which is the shape the rule was written for. Looked *through* and
 * never counted, exactly as `predicateCoordinationChain`'s `spanMates` does: the
 * mates are one predicate, and the question is about where that predicate
 * stands. */
function isNominalisedClauseMember(token: Token, sentence: Sentence): boolean {
  const byId = new Map(sentence.tokens.map((t) => [t.id, t]));
  const seen = new Set<number>([token.id]);
  for (let current = token; ; ) {
    const head = byId.get(current.head);
    if (!head || head.id === current.id || seen.has(head.id)) return false;
    if (current.dep === "mod" && PARTICLE_HEAD_POS.has(head.pos)) return true;
    if (!COORDINATION_DEPS.has(current.dep) && !NAME_FUSING_DEPS.has(current.dep)) return false;
    seen.add(head.id);
    current = head;
  }
}

/** True when `root` already has its own explicit sentence-final copula
 * particle (也, tagged discourse@sp and read なり — see overrides.json) as a
 * child. See `extraEndingFor`'s doc for why this suppresses its synthesized
 * ROOT copula. Scoped to 也 specifically, not 矣/乎/etc. — those don't
 * themselves read なり (矣 is often unread; 乎 is や/か), so a bare-nominal
 * ROOT followed by one of *those* still needs its own synthesized copula. */
function hasExplicitCopulaParticle(root: Token, sentence: Sentence): boolean {
  return sentence.tokens.some(
    (t) => t.head === root.id && t.id !== root.id && (t.dep === "discourse" || t.dep === "discourse@sp") && t.lemma === "也",
  );
}

/** Whether a subject hangs off this token — the relation that makes a noun a
 * predication rather than a phrase.
 *
 * X Y with X as Y's subject *is* "X is Y", wherever in the tree it sits: 此吾
 * 師 has 此 as 師's `subj`, and 王仁人而智者 has 王 as the `subj` of a 人 that
 * is not the root at all. Being the sentence's root was standing in for this
 * and only partly covers it — every root nominal predication has a subject
 * or could take one, but not every nominal with a subject is the root.
 *
 * It is also the strongest licence there is (see `isPredicationLicensed`).
 * The licences already there — a closing mark, a sentence-final particle, a
 * negation over the root — all say the *source* marked a predication; a
 * subject says the parse found one. That is what keeps 秦王 out: 秦 is a
 * `compound` on 王 and 王 has no subject, so "the king of Qin" stays the noun
 * phrase it is, and bare 君子 likewise.
 *
 * `subj@` subtypes count — the relation is still a subject relation whatever
 * the parser qualifies it with — while `det` does not: 吾 in 此吾師 is a
 * determiner on 師 ("my teacher"), not something 師 is predicated of. */
function hasSubject(token: Token, sentence: Sentence): boolean {
  return sentence.tokens.some(
    (t) => t.head === token.id && t.id !== token.id && (t.dep === "subj" || t.dep.startsWith("subj@")),
  );
}

/** Whether the source presents this sentence as a complete predication at
 * all — the gate on every *synthesized* sentence-final ending below.
 *
 * A bare nominal is the one predicate Literary Chinese realizes with no
 * token of its own, which is exactly why a copula has to be invented for it
 * — and exactly why the inference is unsafe when nothing says a sentence
 * ended here. 秦王 and 君子 typed on their own are noun phrases, "the king of
 * Qin" and "a gentleman", and were coming back 秦王なり / 君子なり, asserting
 * a predication the source never made. Punctuation is what licenses it:
 * 君子。 is "[he] is a gentleman", 君子 is not.
 *
 * Two further things count as the source marking the sentence closed, since
 * both are sentence-final material the writer put there in place of a mark:
 *  - a sentence-final discourse particle on the root (君子乎 -> 君子なりや);
 *  - a negation over the root (不亦君子 -> 亦君子ならず). This one is not a
 *    nicety: the negation's own ず is emitted whatever happens here, so
 *    withholding the copula does not leave a bare noun — it leaves ず glued
 *    onto one, 亦君子ず, with nothing to inflect.
 *
 * A subject licenses a predication too, on stronger evidence than any of
 * these — but only the *copula*, so that licence is applied at the branch
 * that needs it rather than here. A count's subject is not something the
 * count is predicated of but the thing being counted, and an unpunctuated
 * 弟子三千人 is "three thousand disciples" for exactly the reason an
 * unpunctuated 秦王 is "the king of Qin". See `extraEndingFor` and
 * `hasSubject`.
 *
 * A mark closing the predicate's own *clause* counts as well as one closing
 * the sentence. This parser does not always split at a 、, so a predication
 * can sit inside a longer sentence with its own break marked and the
 * sentence's last token belonging to something else entirely: in
 * 負郭田三百畝、輒半種黍 the quantity is closed by the comma and the sentence
 * ends on 黍, and looking only at the last token withheld the あり however
 * the tree was rearranged. The end of the root's own subtree is where its
 * clause ends, so a mark immediately after that is the writer closing it. */
/** True when the span running from `firstTokenId` to `lastTokenId` is **the
 * whole of an unpunctuated sentence** — the reader's rule: *if a sentence ends
 * in an on'yomi compound but not a punctuation mark, then don't add any
 * morphology to it — it's likely to be a title.*
 *
 * Read only by `generateKakikudashiPieces`' compound-span branch, which is what
 * makes the "on'yomi compound" half of the rule true by construction: the
 * ending it stands down is `compoundSuruOkurigana`'s サ変 す, and that string is
 * written for exactly one thing — a JMdict する-verb span read on'yomi. 蠕動,
 * 俯臥, 醫療 and 酒蟲 standing alone as a whole sentence were coming out 蠕動す,
 * 俯臥す, 醫療す, 酒蟲す, a verb made out of a title.
 *
 * **The synthesized copula needed no such rule and has not been given one.**
 * `isPredicationLicensed` above already withholds it from an unpunctuated
 * sentence, on the same evidence and for the same reason (君子 is "a
 * gentleman" and 君子。 is "[he] is a gentleman"), so an unpunctuated 醫療 was
 * already bare and only the サ変 す was left. Stated so that a reader meeting
 * this knows the rule is one half of a pair and not a new principle.
 *
 * **A mark anywhere at the end counts**, by the same backwards scan past
 * brackets `isPredicationLicensed` opens with — this is not asking whether the
 * *span* is followed by a mark but whether the sentence was closed at all, so a
 * 、 or a 」 does not make a title of what precedes it.
 *
 * **The span must be the whole sentence, and that tightening was measured.**
 * The rule as stated tests only the mark, and on that test 木蕭蕭 — a
 * reduplicated descriptive with 木 as its *subject*, and this app's own anchor
 * for the タリ ending (木蕭蕭たり) — is a title, which it plainly is not: it is a
 * sentence whose author simply wrote no 。. A title has nothing else in it, so
 * that is what is asked. What still moves under the tightened rule is the five
 * one-word fixtures that were the app's evidence a span gets an ending at all
 * (俯臥す, 蠕動す, 燥渴す, 孳孳す, 陶陶遂遂す); each is a minimal unit fixture
 * testing the span mechanism rather than the title question, and each now
 * carries the closing mark that says so. */
export function isUnpunctuatedTitleSpan(firstTokenId: number, lastTokenId: number, plan: ReadingPlan): boolean {
  if (nextMeaningfulToken(plan, lastTokenId) !== undefined) return false;
  if (previousMeaningfulToken(plan, firstTokenId) !== undefined) return false;
  for (const token of [...plan.sentence.tokens].sort((a, b) => b.id - a.id)) {
    if (isBracket(token.text)) continue;
    return token.dep !== "punct";
  }
  return true;
}

function isPredicationLicensed(sentence: Sentence, root: Token): boolean {
  for (const token of [...sentence.tokens].sort((a, b) => b.id - a.id)) {
    if (isBracket(token.text)) continue;
    if (token.dep === "punct") return true;
    break;
  }

  const subtree = new Set<number>([root.id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const t of sentence.tokens) {
      if (!subtree.has(t.id) && subtree.has(t.head) && t.id !== t.head) {
        subtree.add(t.id);
        grew = true;
      }
    }
  }
  const clauseEnd = Math.max(...subtree);
  const after = sentence.tokens.find((t) => t.id === clauseEnd + 1);
  if (after?.dep === "punct" && !isBracket(after.text)) return true;
  return sentence.tokens.some(
    (t) =>
      t.head === root.id &&
      t.id !== root.id &&
      (t.dep === "discourse" || t.dep === "discourse@sp" || isNegationUse(t)),
  );
}

/** True when the sentence's root predication states a *quantity* rather than
 * an identity, so that あり is the ending it wants and not なり — 弟子三千人
 * あり ("[he] had three thousand disciples"), never 弟子三千人なり, which would
 * say the disciples *are* three thousand people.
 *
 * Two shapes, both taken from live parses of this construction:
 *  - the numeral itself is the root, with the counted nominal as its `subj`
 *    and (usually, not always) a classifier as its `clf` — 弟子三千人。,
 *    馬千匹。, 門人三百。 and 兵十萬。 all come back this way. Nothing else in
 *    this file fires on a NUM root at all, so these were ending with no
 *    predicate ending whatsoever.
 *  - an ordinary nominal root carrying a numeral `mod` — 一妻。, "[there is]
 *    one wife".
 *
 * Not a numeral anywhere in the sentence: 三人行。 has 三 modifying 人, which
 * is the verb 行's subject and not the predicate at all, and 齊人有一妻一妾者
 * has its numerals down inside a relative clause. It is specifically the
 * *predicate* that must be the counted thing. */
function isNumeralPredication(root: Token, sentence: Sentence): boolean {
  const childrenOfRoot = sentence.tokens.filter((t) => t.head === root.id && t.id !== root.id);
  if (root.pos === "NUM") return childrenOfRoot.some((t) => t.dep === "subj");
  if (!NOMINAL_PREDICATE_POS.has(root.pos)) return false;
  return childrenOfRoot.some((t) => t.pos === "NUM" && t.dep === "mod");
}

/** Which token of a numeral predication the あり hangs off: whichever of the
 * quantity phrase is said last, since あり closes the whole predication and
 * an ending emitted anywhere earlier lands inside it.
 *
 * Both parses of a count put something after the root. Where the numeral is
 * the root, its classifier follows — 人 in 弟子三千人 is a `clf` of 三千, and
 * emitting on the root gave 弟子三千あり人. Where the *noun* is the root and
 * the numeral modifies it, the numeral follows — 十萬 is a NUM `mod` of 兵 in
 * 沛公兵十萬, and emitting on the root gave 沛の公の兵あり十萬. Only the first
 * shape was handled, because only `clf` was looked for.
 *
 * Taking the greatest id rather than naming a relation per shape: the
 * quantity is written in one run, so the token said last is the one written
 * last, and that holds whichever of the two is the head. It also keeps 一妻
 * right, where the numeral *precedes* its noun and the noun is still what
 * closes the phrase. */
function quantityPredicateCarrier(root: Token, sentence: Sentence): Token {
  const inQuantity = (t: Token): boolean =>
    t.id !== root.id &&
    (t.head === root.id
      ? t.dep === "clf" || t.pos === "NUM" || isQuantityPostModifier(t, root)
      : sentence.tokens.some((n) => n.id === t.head && n.head === root.id && n.pos === "NUM" && t.dep === "clf"));
  const parts = sentence.tokens.filter(inQuantity);
  return parts.reduce((last, t) => (t.id > last.id ? t : last), root);
}

/** A **post-modifier of a quantity** — a nominal `mod` written *after* the
 * quantity it modifies, and so part of the phrase rather than something
 * following it. 許 in 長三寸許 ("about three inches") is the live one: it reads
 * ばかり, an approximative that closes the measurement, and 三寸ばかり is one
 * predicate.
 *
 * This is what makes 三寸ばかり**に** land where it does. Whatever the quantity
 * phrase's ending is, it goes after the part said last (see
 * `quantityPredicateCarrier`, whose rule this extends from the classifier to
 * the modifier) — and with only `clf` and `NUM` counted, 許 was not in the
 * phrase at all and the ending would have been written in front of it:
 * 三寸にばかり.
 *
 * **"Any other such post-modifier", bounded and measured.** The class is small
 * and the corpus says what is in it: over `lzh-{train,dev,test}.sud.conllu` a
 * NUM's postposed `mod` children are 餘/余 24 each ("and more" — 三百餘, and
 * the same word arrives `conj:coord` 109 times besides), 一 12, and a tail of
 * 以/人/百/半/月 at 2–4 apiece. 許 does not occur there at all; it is the
 * reader's own text that has it. So this is not a lemma list — it is the
 * relation and the position, which is what "any other such post-modifier"
 * means, and the whole class it can reach is on the order of 70 gold edges.
 *
 * Three conditions, each excluding a different thing that also hangs postposed
 * off a numeral:
 *
 *  - **`mod`**, so a `conj:coord` (如 in 三寸許蠕動如游魚, and the 109 coordinate
 *    餘) is a further *clause*, not part of this phrase. `clf` is already
 *    counted by the caller and `punct` is not a word.
 *  - **Nominal**, so an ADJ or VERB hanging off the numeral is a predicate of
 *    its own.
 *  - **After the numeral in source order**, which is the whole of what
 *    "post-modifier" says: 一 in 一妻 precedes its noun and closes nothing. */
function isQuantityPostModifier(token: Token, quantity: Token): boolean {
  return token.dep === "mod" && token.id > quantity.id && NOMINAL_PREDICATE_POS.has(token.pos);
}

/** The quantity phrase `token` closes, if it closes one — the NUM whose
 * `quantityPredicateCarrier` this token is.
 *
 * The same split every group in this file makes, asked from the other end: a
 * quantity is one predicate written across several characters, so **the
 * questions about the clause are the head's and the writing is the carrier's**.
 * `extraEndingFor` needs it to ask whether the phrase is a non-final conjunct
 * (which is true of 三, not of the 許 the ending lands on), and `selectForm`
 * needs it to pick 連用形 over 終止形 for the same reason. Without it the ending
 * was decided about whichever character happened to be last and came out
 * 三寸許なり — a 終止形 closing a clause the tree says is still open.
 *
 * Returns the token itself for a quantity phrase of one character, so a caller
 * that has no phrase to speak of behaves exactly as it did before there was
 * one. */
function quantityPhraseHeadOf(token: Token, sentence: Sentence): Token | undefined {
  if (token.pos === "NUM") return token;
  const governor = sentence.tokens.find((t) => t.id === token.head && t.id !== token.id);
  if (!governor || governor.pos !== "NUM") return undefined;
  return quantityPredicateCarrier(governor, sentence).id === token.id ? governor : undefined;
}

/** The extra ending a token needs beyond its own reading/okurigana, if
 * any — either a morph-driven auxiliary (potential/desiderative/passive/
 * etc., from the token's own `morph` field) or, for a predicate with no
 * such morph, a synthesized ending Literary Chinese leaves implicit:
 *
 *  - A bare nominal at the sentence ROOT (君子, "[it] is a gentleman") is an
 *    equative "X is Y" predication and gets なり — well-established, see
 *    the 亦君子なり anchor. Only where the source closed the sentence, though
 *    (`isPredicationLicensed`), and only where the predication is an
 *    identity rather than a count (`isNumeralPredication`, which takes あり
 *    instead) — see both for the reasoning and for how they compose.
 *  - A `conj:coord` sibling coordinated directly onto the ROOT (see
 *    `isCoordinateClauseHead`) is a parallel clause in its own right, and a
 *    bare NOUN/PROPN/PRON one predicates the same way a bare nominal does
 *    anywhere else: なり (生而神靈 -> 生まれて神靈なり, 王學君子 -> 王學びて
 *    君子なり). This branch used to give it the do-verb す instead, reading
 *    it as a denominal action parallel to the other conjuncts; see the
 *    branch itself for what that argument was and why it no longer stands.
 *
 * `isDenominalCompound` (true only for a compound-span *carrier* — see the
 * two call sites in generator.ts/KundokuView.ts) marks a predicate resolved
 * as one fused whole-word JMdict reading rather than conjugated character
 * by character — real classical shuushikei (終止形) always ends in し, never
 * い+なり, so a genuine ADJ-like predicate (Degree=Pos) with its own
 * kun'yomi (via VERB_LEXICON's conjClass, or readingResolver.ts's own
 * modern-い-to-classical-し conversion for the kanjidic-fallback case)
 * already supplies that し on its own and needs no copula at all. Only a
 * *denominal* adjective — one that isn't really Japanese verb/adjective
 * morphology at all, like the Sino-Japanese compound noun read as a whole
 * word (成而聰明's 聰明, そうめい, a real jukugo — its own characters'
 * individual kun'yomi conjugation classes are irrelevant once fused into
 * that whole-word reading) — has no such ending of its own, and gets なり
 * (成而聰明 -> 成りて聰明なり).
 *
 * A ROOT that already has its own explicit copula particle (也, see
 * `hasExplicitCopulaParticle`) is skipped entirely — 也 already *is* the
 * なり this branch would otherwise synthesize a second, redundant copy of
 * (少典之子也 -> 少典の子なり, never 少典の子なりなり).
 *
 * A ROOT with its own `classicalAdjectiveRootReading` (利, "sharp" —
 * see that function's doc) is also skipped — it already supplies its own
 * classical shuushikei (利し) directly as its reading's okurigana, and
 * needs no separate copula stacked after it any more than an ordinary
 * conjugated adjective does. */
/** The ending a token's own morphology asks for, where its *role* allows that
 * morphology to mean what it says.
 *
 * `endingForMorph` is a table from features to endings and is handed no token,
 * so it cannot ask the one question the converb arm needs: a 連用形 て is what a
 * word modifying a predicate takes, and a **subject is not modifying
 * anything** — it is an argument of the predicate, and an ending there attaches
 * to nothing.
 *
 * **The reader's 本立而道生 is the case.** The parser returns 本 as NOUN on
 * `subj` with `VerbForm=Conv`, and the て that feature asked for came out in
 * front of the verb that follows: 本**て**立ちて道生る, where the reading is
 * もと立ちて. Over the recoded gold (`…rulemerged.adjfix`) `VerbForm=Conv`
 * stands on `mod` **13,060** times and on `comp:obj` **418**, every one of them
 * an ADV, and on a `subj` **0 times in 13,478** — so the feature and the
 * relation contradict each other, and the annotation to correct is 本's, not
 * this rule. What is corrected here is narrower and is the app's own fault: it
 * was spending a converb ending without asking whether the token was in a
 * position to carry one.
 *
 * Bounded to `subj` rather than to "not `mod`/`comp:obj`", because that is
 * where the evidence is: those are the two relations gold attests, but a
 * relation absent from 13,478 tokens is not thereby impossible, and refusing
 * every unattested one would be a much larger claim than the reading needs.
 * The other arms of the table are untouched — a negation, a potential, a
 * copula are all things a subject genuinely can carry. */
function morphEndingFor(token: Token): ConjugatedForm | null {
  const ending = endingForMorph(parseMorphFeatures(token.morph ?? ""));
  if (ending === CONVERB && (token.dep === "subj" || token.dep.startsWith("subj@"))) return null;
  return ending;
}

/** The relations a clause-closing 者 stands in — the slots in which a 者 that
 * ends the sentence is the thing being **asserted** rather than something a
 * further predicate governs. See `isSentenceFinalZhe`. */
const CLAUSE_CLOSING_ZHE_DEPS: ReadonlySet<string> = new Set(["ROOT", "root", "parataxis", "conj:coord"]);

/** True when `token` is a PART 者 that **closes the sentence in a slot where
 * it is the predicate**, so that 告諸往而知來者 is 諸に往くを告げて來るを知る者
 * なり and not a noun phrase left hanging.
 *
 * **Three separate things had to move before this could be asked at all**, and
 * naming them is most of the rule:
 *
 *  1. `extraEndingFor`'s copula arm keys on `NOMINAL_PREDICATE_POS`
 *     (NOUN/PROPN/PRON), and 者 is PART. A nominalizing 者 *is* a noun ("the
 *     one who…") but nothing in the POS column says so, which is why this is a
 *     named arm of its own rather than a widening of that set — a PART 者 in
 *     any other position is still a particle.
 *  2. That arm's own licence is `token.id === root.id || hasSubject ||
 *     suffixNegated`, all three of which describe a nominal asserting itself.
 *     A 者 hanging several relations below the root passes none of them, so
 *     this arm carries its own licence: the sentence ends here, and the
 *     relation says the clause it ends is not an argument of anything.
 *  3. `zheParticleReading` returned `endingComplete`, and **both panels skip
 *     `extraEndingFor` outright** on a reading that says so. That flag is now
 *     withheld from 者 at that call site — but only where that rule *answers*
 *     for the 者 at all: a 者 it declines falls through to the catch-all もの
 *     entry, and every entry in that table is `endingComplete`, so this gate
 *     closes again behind any bound that makes the rule decline. That is
 *     exactly what a later change did, giving the nominalizer arm the
 *     `isTopicSlot` bound its neighbours carry — `parataxis` is not a topic
 *     slot — and 論語 學而 15 lost its copula again. The arms there now ask
 *     about this predicate as well as about the slot; see `answersForThisZhe`
 *     in `readingResolver.ts`.
 *
 * **The relation bound is the whole of what keeps this small, and the class is
 * not what it looks like.** Of the sentences whose 白文 ends on a PART 者, the
 * overwhelming majority stand on `comp:obj` — 吾未見剛者 is 剛なる者を見ず, where
 * 者 is what the verb fails to see and is not last in *reading* order at all.
 * Giving those a copula measured **+117** against kanbun.info (an earlier
 * measurement of this same change, before the baseline moved under it);
 * restricted to the ROOT/parataxis/conj:coord slots it measured **+3**, every
 * one of those regressions 者**はなり** — the copula stacking on the topic
 * marker — and with `zheParticleReading` withholding that は as well it turned
 * negative. `subj` is deliberately absent: a sentence-final 者 on `subj` is a
 * fragment whose predicate the parse has lost, not a predication.
 *
 * **As shipped it measures −4**: of the 15 sentences in that corpus this fires
 * on, 10 change what the app writes — 4 passages closer, 3 further, 3 level.
 * (The two forms above were measured against an earlier baseline and reported
 * −8; the ratchet moved between the two runs.) Both regressions are mis-parses
 * and are named where they occur: 悉舉貴戚及疏遠隱匿者 makes 者 the root where
 * it is 舉's object, and 願更相推擇可者 does the same for 擇.
 *
 * **What this does *not* ask is whether the copula will actually be written**,
 * and `readingResolver.ts` uses it for the は on exactly that understanding —
 * see its own note. `extraEndingFor` writes なり only where the sentence is
 * asserted (`isPredicationLicensed`: a closing 。, a discourse particle, a
 * negation), so an unpunctuated 者 clause loses its は and gets no なり, which
 * is a bare noun phrase and is what an unpunctuated string is here. The one
 * place that costs an edit is 尉繚子 兵令下 24, where the parser splits
 * 殺十三者力加諸侯 after the 者 and leaves 殺十三者 as a three-token sentence
 * with no punctuation: 十の三を殺す者**は**力… is the received reading, and it
 * is right for the reason this rule is not wrong — 殺十三者 is the `subj` of 加,
 * exactly as the parallel 殺十一者 in the next clause is the `subj` of 令, and
 * the split is the annotation to correct.
 *
 * **A 者 followed by 也 is excluded by construction and needs no clause here.**
 * 也 is never `punct` — over this corpus's parses it wears `discourse@sp`
 * (1,407), `subj` (105), `mod` (13) and a tail — so a 者 with a 也 after it is
 * never the last non-`punct` token, and 黃帝者、少典之子也 is untouched. The
 * outer `hasExplicitCopulaParticle(root, …)` guard this arm sits under is the
 * second line of the same defence: 也 already *is* the なり. */
export function isSentenceFinalZhe(token: Token, sentence: Sentence | { tokens: Token[] }): boolean {
  if (token.text !== "者" || token.pos !== "PART") return false;
  if (!CLAUSE_CLOSING_ZHE_DEPS.has(token.dep)) return false;
  if (!sentence.tokens.every((t) => t.id <= token.id || t.dep === "punct")) return false;
  // **The nominalizer only, never the bare topic marker.** 者's other particle
  // use is the は of 黃帝者、少典之子也 — a *particle*, read in place of the
  // character — and a copula written after that stacks on it: 六韜 選将 20 ends
  // 而反忠實者, whose 者 the parser hangs off a NOUN 實, and it came out
  // 忠を實反りて**はなり**. That はなり is the very shape this whole change
  // exists to stop, so the two uses have to be told apart *here* as well.
  //
  // The test is `zheParticleReading`'s own, restated over the same primitive
  // (`isContentPredicatePos`) rather than imported: `readingResolver.ts`
  // imports this module, so the edge back is a cycle — the same one
  // `ZHE_NOMINALIZER_OKURIGANA` is duplicated across. What is restated is only
  // the *core* of it (does a predicate modify 者), not the resolver's full
  // answer, and it is restated in the direction that is safe to be wrong in:
  // a 者 this declines to call a nominalizer keeps exactly the reading and the
  // は it had before this change.
  const modifier = sentence.tokens.find((t) => t.head === token.id && t.id !== token.id && t.dep === "mod");
  if (!modifier) return false;
  return isContentPredicatePos(modifier.pos) || modifier.pos === "AUX" || modifier.lemma === "也";
}


export function extraEndingFor(token: Token, root: Token | undefined, sentence: Sentence, isDenominalCompound = false): ConjugatedForm | null {
  const morphEnding = morphEndingFor(token);
  if (morphEnding && !(morphEnding === CONVERB && isConditionalTemporalClause(token, sentence))) return morphEnding;
  if (
    root &&
    !hasExplicitCopulaParticle(root, sentence) &&
    !classicalAdjectiveRootReading(root) &&
    // The two rules run strictly in this order, and the order is the whole
    // of how they interact: `isPredicationLicensed` decides *whether* the
    // sentence gets a synthesized ending at all, and `isNumeralPredication`
    // decides only *which* one it gets once it has. So an unpunctuated
    // 弟子三千人 gets neither あり nor なり — it is a noun phrase, "three
    // thousand disciples", for the same reason an unpunctuated 君子 is one —
    // and 弟子三千人。 gets あり rather than なり.
    //
    // A nominal with a subject of its own is licensed whatever the source
    // marked, on stronger evidence than any of the marks: X Y with X as Y's
    // subject *is* "X is Y". Written as a second licence here rather than
    // inside `isPredicationLicensed`, because a count must not have it — the
    // `subj` of 三千 in 弟子三千人 is what is being counted, not something the
    // count is asserted of, and reading it as a licence gave the unpunctuated
    // noun phrase an あり. So the copula gets this and the existence ending
    // does not.
    (isPredicationLicensed(sentence, root) || (NOMINAL_PREDICATE_POS.has(token.pos) && hasSubject(token, sentence)))
  ) {
    if (isNumeralPredication(root, sentence)) {
      // Not necessarily on the root — see `quantityPredicateCarrier`.
      // Checked ahead of the copula below and not beside it: 弟子三千人 has
      // 弟子 as the `subj` of the numeral, so a count is a nominal with a
      // subject too, and asking about the copula first would say the three
      // thousand *are* the disciples.
      if (token.id === quantityPredicateCarrier(root, sentence).id) return EXISTENCE;
    } else if (
      NOMINAL_PREDICATE_POS.has(token.pos) &&
      // A subject makes it a predication wherever it sits, where being the
      // root only covers the case where the predication is the sentence —
      // 人 in 王仁人而智者 is a `mod` of the 者 that heads it and still has 王
      // as its own `subj`. See `hasSubject`.
      //
      // **And so does a suffixal negation, for a reason that is not about
      // predication at all but about there being something for the ず to
      // inflect.** 不/未/弗/勿 emit their ず whatever is decided here — the same
      // fact guard four below already turns on, and the whole of why that guard
      // exempts them — so a nominal carrying one and reaching no copula is left
      // with the suffix glued onto a bare noun. 不亦君子乎 is the case, and the
      // live parse is what exposes it: it makes 君子 a `comp:obj` of the 知 four
      // characters earlier rather than a predication of its own, so 君子 is
      // neither the root nor the bearer of a subject, never reached this branch,
      // and came out 亦君子**を**ざるや — an object marker and a negation with no
      // copula between them. With the licence it is 亦君子ならざるや, which is
      // the reading, and the stray を stays on the page as the trace of the
      // annotation fault it is (君子 is not what 知 knows; the two clauses are
      // coordinate). Named rather than patched around, as everything else here.
      (token.id === root.id || hasSubject(token, sentence) || suffixNegated(token, sentence)) &&
      // The root's own 也 is caught by the outer condition; this catches a
      // non-root predicate carrying one of its own, which would otherwise
      // write the copula 也 is already there to write.
      !hasExplicitCopulaParticle(token, sentence) &&
      // …and the same argument a third time, for a predicate a 非 denies.
      // 非 reads **あらず** — あり with ず on it — so the copula is already
      // written, negated, and standing after the nominal: 非劉之病。 is
      // 劉の病にあらず. Synthesizing a second one gave 劉の病になりあらず, the
      // affirmative copula and its own negation both asserted of one noun.
      //
      // Not the same case as `isPredicationLicensed`'s negation licence two
      // conditions up, and the difference is the whole of why this is here.
      // That licence is about 不/未/弗/勿, which are **suffixes**: 不亦君子 has
      // to be 亦君子ならず because ず is emitted regardless and needs something
      // to attach to. 非 attaches to nothing — it is a predicate in its own
      // right, and what the nominal in front of it needs is the に
      // `caseParticleFor` writes off this same predicate, not a copula.
      !negatedNominalPredicate(token, sentence) &&
      // …and a fourth time, for a nominal that is about to be **given a case
      // particle**. A case particle is what says the nominal fills a slot in
      // some other predicate's clause, and a thing filling a slot is not also
      // asserting itself. 忽覺咽中暴癢 has 中 as the `subj` of 癢 and 癢 as 覺's
      // `comp:obj`, so the licence above fires on it and the を
      // `caseParticleFor` writes came out beside a なり — 咽中癢さをなり覺え,
      // an object marker and a predication made of the same noun at once.
      // 咽中暴癢 is a nominalised clause standing in 覺's object slot, "that
      // the throat suddenly itched"; it is what is perceived, not something
      // the sentence says is so, and 癢さを is the whole of what it wants.
      //
      // **Asked of `caseParticleFor` itself, and not of the relation.** The
      // question this needs answered is whether a particle *will be written*
      // here, and that is not a function of the dep: `caseParticleFor` stands
      // its own particle down for a quote (或言：『蟲是劉之福…』 — 福 has 是 as
      // its `subj` and is a `comp:obj`, and keeps the copula it earns,
      // 劉の福にして), for an existential's complement, and for a postposed
      // negation, so a list of relations would suppress the copula in exactly
      // the places nothing is going to be written. Measured over
      // `lzh_kyoto-sud-{train,dev,test}` (86,239 sentences), 126 non-root
      // nominals with a subject of their own reach this branch, and they
      // divide 72 with a particle to 54 without:
      //
      //     を 64  (comp:obj 62, conj:coord 2)   — 其為氣也配義與道
      //     の  6  (mod 5, comp:obj 1)           — 陳勝爲其御莊賈所殺
      //     に  2  (comp:obl, udep@tmod)         — 賜興名弘正
      //     none 54 (conj:coord 17, mod 16, subj 8, comp:obj 7, …)
      //
      // — so keying on `comp:obj` alone would both miss 10 of the 72 and fire
      // on the 7 `comp:obj` that take nothing (4 of them an existential's
      // complement, 未有恭帝禪制).
      //
      // **The ROOT falls out on its own and needs no clause here.** A root
      // nominal predicate takes なり and no case particle, so the guard is
      // simply not reached on one: of the 5,155 nominal roots in that corpus,
      // `caseParticleFor` answers for 266, and 265 of those are a 非/匪
      // predicate taking its に (非吾徒也) — every one of them already stood
      // down over by guard three. 少典之子也 is untouched.
      //
      // The single root this guard does reach is 潯陽地僻無音樂, where 僻 heads
      // the sentence and is also the **locus** an existential 無 predicates at
      // (`isExistentialLocus`), so its に is written and the copula's にして was
      // being stacked on top of it: 潯陽の地僻ににして音樂無し, now
      // 潯陽の地僻に音樂無し. That is the rule doing exactly what it says — the
      // に says 僻 is where the music is missing, not something asserted.
      //
      // **No recursion, and the call is a plain one.** `caseParticleFor` asks
      // only about the tree — nothing in it or below it asks for an ending —
      // so it can be called from here as cheaply as from the two panels that
      // call it for the particle itself.
      //
      // **The one exemption is a suffixal negation** (`suffixNegated`), and it
      // is the very distinction guard three above turns on read the other way.
      // 不/未/弗/勿 emit their ず whatever is decided here, so standing the
      // copula down under one does not leave a bare nominal — it leaves ず glued
      // onto one with nothing to inflect: 上以其不情而遂非惡之 has 情 as 以's
      // `comp:obj` with 其 as its `subj` and a 不 of its own, and went from
      // その情をならずして to その情をずして. It is the single case in the corpus
      // where the two meet, and the を beside the ならず is a separate fault
      // (以其不情 wants その情ならざるをもつて — the negated copula attributive,
      // and the を after it) which this guard is not the place to fix.
      (caseParticleFor(token, sentence) === undefined || suffixNegated(token, sentence))
    ) {
      return COPULA;
    } else if (isSentenceFinalZhe(token, sentence)) {
      // **A 者 that closes the sentence is a predicate and takes なり.** 論語
      // 學而 15 ends 告諸往而知來者, which came out 諸を往くを告げて來るを知る者
      // with no ending at all where the received reading is
      // 諸に往を告げて来を知る者**なり**. See `isSentenceFinalZhe` for the three
      // gates this had to pass and for the relation bound that keeps it to the
      // slots where 者 is what is being asserted.
      //
      // Its own arm rather than a widening of the guard above, because every
      // condition in that guard is about a *nominal* asserting itself and none
      // of them holds of this: 者 is PART, it is usually not the root, and it
      // has no subject. What licenses it is that the sentence stops here.
      return COPULA;
    }
  }
  // A **quantity phrase standing as a non-final conjunct** predicates too, and
  // hands on: 赤肉、長三寸許、蠕動如游魚、口眼悉備 is 赤肉、長さ三寸ばかりにして、
  // 蠕動すること游魚のごとく、口眼悉く備はる. 三 is a NUM with 如 coordinated onto
  // it, so the measurement is one clause in a chain of them and takes the
  // copula's 連用形, not nothing at all.
  //
  // **Asked about the head and written on the carrier**, which is
  // `quantityPhraseHeadOf`'s whole reason for existing: "is this a non-final
  // conjunct" is true of 三 and false of the 許 the ending lands after. The
  // same two-token split `caseParticleFor`'s chain branch makes for a case
  // particle, and `quantityPredicateCarrier` already made for あり.
  //
  // **Below the root block above, and it must stay below it.** 負郭田三百畝
  // takes あり from `isNumeralPredication` (a *count* of things asserts that
  // they exist in that number) and returns before reaching here. What this
  // branch adds is the case where the quantity is not the sentence's own
  // predication but one link of a coordination chain, where a count and a
  // measurement alike are simply predicated — なり, in its 連用形.
  //
  // **NUM is not in `NOMINAL_PREDICATE_POS` and is not being added to it.** A
  // numeral is a predicate here because a conjunct of a predicate chain is one,
  // which is a fact about this position and not about the word class; the set
  // is read in a dozen other places that are not about position at all.
  {
    const quantity = quantityPhraseHeadOf(token, sentence);
    if (
      quantity &&
      quantity.pos === "NUM" &&
      token.id === quantityPredicateCarrier(quantity, sentence).id &&
      isNonFinalCoordinand(quantity, sentence, true) &&
      !hasExplicitCopulaParticle(quantity, sentence)
    ) {
      return COPULA;
    }
  }
  if (isCoordinateClauseHead(token, root, sentence)) {
    // A fused whole-word predicate takes なり: the reading is one jukugo with
    // no okurigana of its own to inflect, so there is nothing on it to carry
    // an ending (see `isDenominalCompound`). What has to be true beside that is
    // that the word is *being predicated as a descriptive*, and this was
    // written as `Degree=Pos || pos === "ADJ"` — a disjunction that stood for
    // one thing under 0.3.1 (the feature was the whole signal; the tag was the
    // rare exception, 豪 and 富 in 酒蟲's 而家豪富 arriving ADJ with a *noun*
    // xpos and no `Degree`) and stands for two different things under 0.3.2,
    // where ADJ is the ordinary tag and `Degree=Pos` on its own now means ADV
    // or NOUN. Asked through `isDescriptiveToken` rather than restated, so that
    // this site, `chosenOkurigana` and the resolver's own adjective gate answer
    // it identically — including its refusal of a legacy VERB that still
    // carries the feature, which see. `Degree=Equ` is refused there too, which
    // this site wants: a comparison 如/若 is ごとし, not a jukugo copula.
    if (isDenominalCompound && isDescriptiveToken(token)) return COPULA;
    // **A 非 denies this conjunct, so the copula is already written.** The same
    // claim the branch above makes for a root or a subject-bearing nominal,
    // made a second time here because a conjunct reaches the copula by a route
    // that never passes it: 病 in 蟲是劉之福、非劉之病 is neither the root nor
    // the bearer of a subject — 是 is 福's — so it arrives through
    // `isCoordinateClauseHead` alone, and came out 劉の病に**なり**あらず, the
    // affirmative copula and its own negation both asserted of one noun. 非
    // reads あらず, あり with ず on it; what the nominal in front of it wants is
    // the に `caseParticleFor` writes off this same predicate and nothing else.
    //
    // Placed on the nominal arm only. The descriptive arm above it is a jukugo
    // read as one word (豪富), and a 非 denying one of those would want the
    // identical treatment — but no such pair occurs in the corpus, so the arm
    // is left as it is rather than widened on a case nothing has measured.
    if (negatedNominalPredicate(token, sentence)) return null;
    if (NOMINAL_PREDICATE_POS.has(token.pos)) {
      // There is deliberately no locative guard here, and one was written and
      // taken out again — so before adding another, read this.
      //
      // On the raw parse of 輒半種黍；而家豪富 this branch puts にして on 家,
      // which carries `Case=Loc` and means "at home". That looks like the
      // rule misfiring on an adjunct, and it is not: the にして is the 連用形,
      // and it is there because a further conjunct (豪, then 富) still
      // follows. Take the conjunct away and the same 家 takes なり; the
      // locative feature has no part in it either way. Guarding on
      // `Case=Loc` therefore suppresses an ending this branch derived
      // correctly from the tree it was handed.
      //
      // What is actually wrong there is the tree: 豪富 is one adjectival
      // predicate with 家 as its subject, and the parser splits it into two
      // nominals and coordinates them onto 種. Given that tree, 家にして豪富む
      // is the faithful reading of it, and rendering the tree faithfully is
      // this app's job — the fix belongs in the parse. Given the corrected
      // tree (家 as `subj` of a single 豪富) the branch is never reached at
      // all and the line comes out 家は豪富なり, which is the wanted reading.
      //
      // A bare nominal coordinated onto the predicate is a *predication*, and
      // takes なり. It is the same equative reading a bare nominal gets
      // anywhere else — 王學君子 is "the king studies and is a gentleman",
      // 生而神靈 "he was born and was numinous" — reached through the
      // coordination rather than through the root or through a subject of its
      // own, which is a difference in how it is found and not in what it is.
      //
      // This overturns a rule that stood here and argued the opposite: that
      // such a noun is used *verbally*, as a denominal action parallel to the
      // other conjuncts, and so takes the do-verb す (生而神靈 -> 生まれて
      // 神靈す, on the reasoning that the clause is not asserting "X is
      // spirit-and-numen"). That reading is available for some nouns and not
      // for most, and it was being applied to all of them; the equative one
      // is what the construction ordinarily means, and it is what this
      // project now renders. Kept as a note rather than deleted because the
      // す is what several existing expectations were written against, and a
      // reader meeting 神靈なり should know it was once 神靈す on purpose.
      //
      // A clause whose head is a particle reaches the same なり by the same
      // inference, but needs the licence the ROOT branch needs: 者 marks what
      // the clause is *about* and realises no predicate of its own, so the
      // nominal hanging off it is the whole sentence's predicate, and an
      // unpunctuated 黃帝者、少典之子 is the noun phrase "Huangdi, the son of
      // Shaodian" and stops there. The coordination case takes no such
      // licence and needs none: a verbal clause already stands before it, so
      // there is no question of the whole thing being a noun phrase — only of
      // what its second conjunct does.
      if (root && PARTICLE_HEAD_POS.has(root.pos)) {
        return isPredicationLicensed(sentence, root) ? COPULA : null;
      }
      return COPULA;
    }
  }
  return null;
}

/** The して a 連用形 can contain outright — `COPULA.renyou`'s にして and
 * `classicalConjugation.ts`'s タリ活用 として, both of which are the form's own
 * way of continuing rather than a connective the sentence supplies. A form
 * ending in this needs nothing written after it and must not have a second
 * connective stacked onto it; that is what `precedingFormSuppliesShite` stands
 * a following 而 down over, and what `selectForm` declines the 連用形 outright
 * for when the 而 is one it cannot stand down over. */
const CONVERB_CONNECTIVE = "して";

/** Which of `ConjugatedForm`'s three selectable slots `selectedForm` took.
 *
 * **The slots and not the 活用形**, which is why this is its own three-member
 * type rather than a `ConjForm`. `mizen` and `renyou` do name a form, but
 * `primary` deliberately does not: its own doc says "shuushikei or rentaikei as
 * appropriate for the auxiliary", and calling it `"shuushi"` here would put a
 * claim into the report that the table declines to make. What the one consumer
 * needs is only whether the 連用形 was the one taken, and that is exactly what
 * naming the slot says. */
export type SelectedSlot = "primary" | "mizen" | "renyou" | "rentai";

/** A selected synthesized ending: the string, and which slot it came out of. */
export interface SelectedForm {
  text: string;
  which: SelectedSlot;
}

/** Picks a `ConjugatedForm`'s mizenkei variant when the token it attaches
 * to is immediately followed (in reading order) by a postposed negation,
 * falling back to the form's primary/shuushikei otherwise — the same
 * mizen-before-ず liaison rule `generator.ts` applies between pieces,
 * expressed here directly against the next token instead.
 *
 * The string alone, for the callers that only write it. **`selectedForm` below
 * is the same choice with the slot it landed in reported**, and is what the
 * 連用形の「て」 switch has to be given: two of the tables have slots that hold
 * the same kana (`CAUSATIVE.mizen` and `CAUSATIVE.renyou` are both しめ,
 * `EXISTENCE.renyou` and `EXISTENCE.primary` both あり), so the returned string
 * does not say which question was answered. This is the same split
 * `negationEnding`/`negationEndingParts` already makes one construction over,
 * and for the same reader: a caller that needs to know where a character came
 * from asks for the parts, and a caller that only writes it asks for the
 * string. */
export function selectForm(form: ConjugatedForm, plan: ReadingPlan, tokenId: number): string {
  return selectedForm(form, plan, tokenId).text;
}

/** The same choice, saying which slot it came out of — see `selectForm` above,
 * whose doc this shares and whose body this is. */
export function selectedForm(form: ConjugatedForm, plan: ReadingPlan, tokenId: number): SelectedForm {
  // A governing 再読文字 asks for its form before anything else, because the
  // thing it will attach is not a token: 未's ず is the character's own second
  // reading, emitted after the whole clause, so the "is the next token a
  // negation?" test below cannot see it. Without this, 未君子 came out
  // いまだ君子なりず — the 未 read twice correctly, and the copula left in
  // 終止形 because nothing followed it in reading order.
  //
  // Asked of the *synthesized* ending only, which is what `selectForm` is
  // for; a real verb under a 再読文字 already goes through
  // `rereadGovernedForm` at its own two call sites above.
  const governed = rereadGovernedForm(tokenId, plan);
  if (governed === "mizen" && form.mizen) return { text: form.mizen, which: "mizen" };
  const next = nextMeaningfulToken(plan, tokenId);
  const beforeNegation = !!next && isNegationUse(next);
  if (beforeNegation && form.mizen) return { text: form.mizen, which: "mizen" };
  const token = plan.sentence.tokens.find((t) => t.id === tokenId);
  // A 使役 しむ standing next in reading order asks for the 未然形 the same way
  // a ず does, and for the same reason: しむ is 未然形接続. This is the
  // synthesized half of `isCausativeAuxiliaryAhead`, which answers the question
  // for a real predicate — 可 under a 使 is べ**から**しむ, and a nominal
  // predication under one is 〜**なら**しむ.
  if (token && next && form.mizen && isCausativeAuxiliaryAhead(token, next, plan.sentence)) {
    return { text: form.mizen, which: "mizen" };
  }
  // **Then the attributive environments**, in the order `decideConjForm` puts
  // them in for a real verb and for its reason: what attaches *onto* a
  // predicate binds tighter than what it is coordinated with, so a のみ or a
  // 係助詞 closing this nominal takes its 連体形 before the coordination rule
  // below can demote it to 連用形.
  //
  // **Nothing selected these until `COPULA` had them.** The paradigm carried
  // なら / にして / なり — three of ナリ活用's six — so the 終止形 stood in for
  // every slot it lacked, and both rules that would have asked were already
  // right and had nothing to hand back: 君子耳 came out 君子**なり**のみ where
  // it wants 君子**なる**のみ, and 是知乎 是れ知**なり**や for 知**なる**や. The
  // slots are `EXISTENCE`'s too, ラ変 あり/ある, on the same reasoning.
  //
  // **Asked without a reading resolver, deliberately.** `selectForm` is called
  // from three sites in `KundokuView.ts` as well as three here, and threading a
  // resolver through only the ones this file owns would have the 書き下し文
  // select a 連体形 the 訓読文 could not — the two panels disagreeing about one
  // character, which is the failure mode half this file exists to prevent. What
  // that costs is the particles whose reading lives in `overrides.json` rather
  // than in `SENTENCE_FINAL_PARTICLES` (邪, 耶): `closingParticleReading` reads
  // the table without a resolver and consults one only for a particle the table
  // does not know. 耳 and 乎/歟/與/否 — the ones this is for — are all in it.
  //
  // A following 者 is the third attributive environment, and it **is** asked now
  // — it was not, and the note here said why: `isNominalizerAhead` needs a
  // resolver this function has none of, and nothing reaching here could stand
  // before a 者 anyway, since a nominal modified into a 者 phrase is neither a
  // root nor the bearer of a subject and `extraEndingFor` synthesised it no
  // ending. The second half stopped being true when the 断定の助動詞 became
  // something the reader can pin (`chosenAuxiliary`): 孝弟也者 puts a copula on
  // the 也 that is the `mod` of the 者, and it printed the 終止形 — 孝弟なり者,
  // where the received reading is 孝弟なるものは.
  //
  // **The resolver is not needed for this shape, and that is why the test is a
  // tree test.** `isNominalizerAhead` consults it for one thing only: 者 alone
  // among the nominalizers also reads は, the topic marker, and then nominalizes
  // nothing (黃帝者、少典之子也 keeps its 終止形). A 者 that a *synthesized or
  // pinned predicate ending* stands in front of cannot be that one — its `mod`
  // is a predicate, which is exactly the condition `zheParticleReading` reads
  // the nominalizer off. 黃帝 is a bare NOUN with no chain onto it and reaches
  // no ending here to select. So the relation plus the reading-order adjacency
  // are the whole of the question, the two conditions `isNominalizerAhead` also
  // requires and for its own stated reasons.
  //
  // 已然形 is absent for the same reason and is worth recording so it is not
  // added on symmetry: the one rule that returns it, `isConditionalTemporalClause`,
  // refuses anything that is not VERB/ADJ/AUX over a verbal xpos, and every
  // token reaching here is a nominal carrying a synthesized ending. `COPULA`
  // holds なれ against the day a rule asks for it.
  if (
    form.rentai &&
    token &&
    next &&
    (isLimitingParticleAhead(token, next, plan.sentence) ||
      isBindingParticleAhead(token, next, plan.sentence, undefined) ||
      // かな joins them: a 終助詞 whose 接続 is 体言・連体形, so a nominal
      // predication closed by 哉/夫 takes なる — 唯我與爾有是夫 is
      // 唯だわれと爾と是れ有**る**かな, and 大哉堯之爲君 大**なる**かな. The same
      // slot the two rules beside it ask for, added when 哉 was corrected from
      // 終止形 to 連体形; see `EXCLAMATORY_PARTICLE_READINGS`.
      //
      // The や that left `BINDING_PARTICLE_READINGS` is not replaced here, and
      // that is the visible half of the correction on this side: 是知乎 goes
      // back to 是れ知**なり**や, 君子人與 君子人**なり**や. `COPULA.rentai` is
      // still selected by のみ, by か and by a following 者.
      isExclamatoryParticleAhead(token, next, plan.sentence, undefined) ||
      // …and the 断定 なり joins them, for the **auxiliaries alone**. なり is
      // itself an auxiliary and an auxiliary attaches to a 連体形, which is the
      // claim `decideConjForm` already makes for every real predicate
      // (`isAssertiveParticleAhead`) and `negationForm` for a negated one
      // (累と為せ**ざる**なり). A synthesized べし was the one predicate ending
      // left out of it: 言可復也 came out 言復た可**し**なり where the received
      // reading is 可**き**なり — 44 「可きなり」 against 0 「可しなり」 over
      // kanbun.info's 書き下し文.
      //
      // **`assertiveParticleClosesAuxiliary` and not `isAssertiveParticleAhead`
      // itself**, for one reason: that predicate requires the 也 to hang off
      // *this* token, and a 可's 也 does not. 言可復也 attaches the particle to
      // 復, which is 可's own `comp:aux` — the auxiliary heads the clause and
      // the particle closes the predicate inside it — so the edge to test is
      // the one into this token's subtree. See that function.
      //
      // **And the copula is deliberately not in this**, though the same
      // argument would seem to reach it. A 也 standing after a nominal *is* the
      // copula in this app — `extraEndingFor` synthesizes `COPULA` from the
      // particle and the particle then writes nothing of its own — so there is
      // no second auxiliary attaching onto the first, and 是知也 stays 是れ知
      // **なり** rather than becoming 知**なる**なり. `EXISTENCE` is out for the
      // same reason: what would stand on あり is the 也 that produced it.
      assertiveParticleClosesAuxiliary(token, next, plan.sentence) ||
      (NOMINALIZING_LEMMAS.has(next.lemma) && next.id === token.head))
  ) {
    return { text: form.rentai, which: "rentai" };
  }
  // A synthesized predicate that is a non-final link in a coordination chain
  // takes renyoukei, exactly as a real verb there does (see
  // `isNonFinalCoordinand`) — the clause hands on to the next instead of
  // closing. Negation still wins: ず attaches to mizenkei whatever the
  // clause does afterwards.
  //
  // Asked as a nominal: everything that reaches here is carrying an ending
  // this file synthesized for it, and those go to nominals — the copula and
  // the existence ending both. Without saying so the verbs-only gate refused
  // every one of them, so `COPULA`'s にして and `EXISTENCE`'s あり could not
  // be selected at all however the sentence was shaped.
  //
  // …unless what follows is a 而 the source has set off behind a mark, which
  // `teOrShite` reads 而して. Then the predicate closes: 臣、而君明 is
  // 臣なり、而して君は明し, not 臣にして、而して君は明し.
  //
  // **The argument is the doubled connective, and it is this file's own.**
  // にして is not a bare 連用形 with a て supplied by whatever follows — the
  // して is the copula's own way of continuing, written into `COPULA.renyou`
  // for exactly that reason, and `precedingFormSuppliesShite` stands a
  // following 而 down over it rather than let a second one be written
  // (王仁人にしてて). 而して is the one case that stand-down deliberately does
  // not cover: `teOrShite` exempts a mark-preceded 而 from it, on the sound
  // ground that 而して is a word read *on* 而 and not an ending added to what
  // precedes, so standing down there would delete the word rather than avert
  // a doubling. That exemption leaves the doubling itself standing —
  // "being a vassal, and moreover…" — and this is the other end of it: the
  // nominal takes the 終止形 it would have taken with no conjunct at all, and
  // 而して carries the sentence on from there.
  //
  // **Bounded to a 連用形 that carries its own connective**, which is what
  // `renyou.endsWith("して")` asks and is the whole of the argument above. A
  // verb before the same 而して keeps its 連用形 (see `decideConjForm`'s own 而
  // branch, and the 輒半種黍；而家豪富 reading its note records): a bare 連用形
  // is 連用中止法 and contains no connective, so nothing is doubled there. The
  // same goes for the synthesized endings that are not the copula — 使役's
  // しめ is 下二段 連用中止法 exactly as a verb's is, and 王令民戰、而歸 keeps
  // 民をして戰はしめ、而して歸る. The asymmetry is between a form that carries
  // its own して and one that does not, and not between word classes.
  //
  // `EXISTENCE` is untouched: ラ変's 連用形 is あり, which carries no connective
  // of its own, so a quantity predication before a 而して has nothing to be
  // stood down over and keeps the あり `isNumeralPredication` gave it. It is
  // also the same string as its 終止形, so which of the two this returns was
  // once invisible on the page — no longer, since `synthesizedRenyouTe` reads
  // the slot rather than the string and writes ありて for the 連用形.
  //
  // `precededBySourcePunctuation` is asked directly rather than `teOrShite`,
  // and has to be: `teOrShite` consults `precedingFormSuppliesShite`, which
  // calls back into this function for this very token, and the two would
  // recur without end. The mark is the whole of what decides 而して in the
  // case at issue anyway — `teOrShite`'s other route to it is reachable only
  // where the stand-down above has already fired, i.e. where no 而して is
  // written at all.
  //
  // **And not inside a clause a particle nominalises**, which is the one
  // position where the argument above cannot hold. 而して closes the predicate
  // before it because that predicate *can* close — 臣 is the ROOT of 臣、而君明
  // and a sentence may end there. 有子's 其為人也孝弟而好犯上者 puts the same
  // shape inside a 者: 孝弟 is the `mod` of the particle with 好 coordinated onto
  // it, and no 終止形 can stand there at all, since what closes is the 連体形 好む
  // in front of 者. It came out 孝弟なり、而して上を犯すを好む者, a sentence ended
  // in the middle of a relative clause, where the received reading is 孝弟にして、
  // 而して上を犯すを好む者. Both halves are written, exactly as the タリ chain
  // writes 愕然として、而して笑ふ — the doubling this guard exists to avoid is a
  // second *て*, and 而して is a word read on 而, not an ending.
  //
  // Measured over
  // `lzh_kyoto-sud-{train,dev,test}.relabeled_ext.udep_ruled.punct.rulemerged.adjfix.conllu`:
  // a nominal `mod` of a PART heading a coordination has a mark-preceded 而
  // anywhere after it **3** times (夫一人身，而牽留萬乘者 · 非夫孤寡者…而侯王 ·
  // 鄭、魏者…而秦), and only the first has that 而 as its *next* token, which is
  // what this condition asks. 一人の身にして、而して萬乘を牽留する者 is the
  // reading it gains. 臣、而君明 is untouched: its 臣 is the ROOT.
  const beforeShikamo =
    !!form.renyou &&
    form.renyou.endsWith(CONVERB_CONNECTIVE) &&
    !!next &&
    next.lemma === "而" &&
    precededBySourcePunctuation(plan.sentence, next.id) &&
    !(token && isNominalisedClauseMember(token, plan.sentence));
  // Asked about the quantity phrase's *head* where this token is closing one —
  // 許 in 三寸許 carries the ending but 三 is the conjunct, and asking 許 whether
  // it is non-final answered no and closed the clause with なり. See
  // `quantityPhraseHeadOf`, which `extraEndingFor` consults from the other side
  // so that the form and the ending are decided about the same token. For every
  // other token the phrase head is the token itself and nothing changes.
  const conjunct = (token && quantityPhraseHeadOf(token, plan.sentence)) ?? token;
  // …and a noun with a numeral coordinated onto it after it hands on the same
  // way, though the chain walk cannot see the edge — see
  // `isCoordinatedWithFollowingNumeral`, which is the reader's own rule and
  // says why it is written beside the walk rather than into it. Asked of the
  // same `conjunct` and stood down over the same 而して, so a noun in this shape
  // takes the 連用形 by exactly the conditions any other non-final link does.
  if (
    form.renyou &&
    !beforeShikamo &&
    conjunct &&
    (isNonFinalCoordinand(conjunct, plan.sentence, true) || isCoordinatedWithFollowingNumeral(conjunct, plan.sentence))
  ) {
    return { text: form.renyou, which: "renyou" };
  }
  return { text: form.primary, which: "primary" };
}

/** Whether the token immediately before `tokenId` in reading order has
 * already written a して of its own — in which case a 而 standing here has
 * nothing left to write.
 *
 * Two 連用形 in this app contain the して outright, and both are written that
 * way for the same reason: the connective is the form's own way of continuing
 * and not a separate word the sentence supplies.
 *
 *  - **にして**, the synthesized copula's (see `COPULA.renyou`). 王仁人而智者
 *    came out 王仁人にしてて before this stood down.
 *  - **として**, a タリ活用形容動詞's (see `classicalConjugation.ts`). 莞爾而笑
 *    would be 莞爾としてて by the same arithmetic.
 *
 * **A タリ活用 reaches this from two shapes, and both are asked.** The suffix
 * binom (愕然, 莞爾) is one; a reduplicated descriptive written as a fused span
 * (蕭蕭, 悾悾) is the other, and its ending is `compoundSuruOkurigana`'s rather
 * than any single token's. 悾悾而不信 came out 悾悾**としてて**信ぜず on exactly
 * the arithmetic above. The span arm asks `decideConjForm` of the span's
 * **carrier**, which is the token that function is actually given there — see
 * `compoundSuruOkurigana`, whose split between the carrier (which decides the
 * form) and the last member (which is where the ending is written, and so whose
 * neighbour this 而 is) this mirrors line for line.
 *
 * Each arm asks the same questions about the same token that produced the
 * ending in the first place — `extraEndingFor`/`selectForm` for the copula,
 * `decideConjForm` on the group's `conjugationSubject` for the タリ suffix —
 * so neither answer can drift from what the panels actually emitted. That is
 * the discipline `repeatsPredicateCopula` follows for the 也 it suppresses.
 *
 * The タリ arm assumes the group *was* rendered, which is `isTariSuffix` plus
 * a resolvable on'yomi for both halves; where `tariSuffixReading` declines
 * (neither 然/如/爾 nor any ordinary stem lacks an on'yomi, so this is a
 * bound residual rather than a live case) the group writes no ending and this
 * withholds a て that nothing else supplied.
 *
 * **The copula arm asks about the wrong token whenever the word is a span, and
 * that is the whole of the 王仁人にしてて fault as it survives in real text.**
 * The copula ending is decided about a span's *carrier* and written on its
 * *last member* — `generateKakikudashiPieces`' span branch and
 * `compoundGroupCell` both do exactly that — while the token standing next to
 * the 而 is the last member. So `extraEndingFor` asked of `prev` answered about
 * 敢, 飧, 桴, 產, the second 洋 and the second 旦, none of which carries the
 * ending, and the 而 wrote a second connective on top of a にして already on the
 * page. Over `lzh_kyoto-sud-{train,dev,test}.relabeled_ext.udep_ruled.punct.rulemerged.adjfix.conllu`
 * **7,371** sentences contain a 而 and **11** of them printed にしてて:
 * 惡果敢而窒者 (果敢にして窒がる者を惡む), 饔飧而治 (饔飧にして治まる), 蕢桴而土鼓,
 * 思蹇產而不釋, 莽洋洋而無極兮, 時時而間進, 或相倍蓰而無筭者, 旦旦而伐之,
 * 日康娛而自忘兮 and 世溷濁而莫余知兮. This is the *same* claim the redup arm
 * above already makes about a span — "the group's ending is written on the last
 * member and nowhere else" — carried to the arm that never got it.
 *
 * **And it needs the resolver, because the span branch it mirrors asks two
 * questions in order and the first of them is a dictionary fact.** That branch
 * takes `compoundSuruOkurigana` where the span is a JMdict する-verb read
 * on'yomi and only falls through to `extraEndingFor` where it is not, so a span
 * whose carrier *would* take the copula may be printing サ変 し instead — and a
 * stand-down there deletes a て that was owed: 悾悾而不信 is 悾悾**して**信ぜず,
 * 阨窮而不憫 阨窮**して**憫まず. Over the same file **113** spans stand before a
 * 而 with the copula's にして selected on their carrier and **76** of them take
 * the サ変 ending instead. The split is by carrier POS and is total — all 76 are
 * ADJ carriers, and none of the 31 NOUN carriers takes it — but the POS is a
 * *correlate* of the dictionary fact and not the fact itself, so the order is
 * reproduced rather than proxied: this asks `compoundSuruOkurigana` first, the
 * same call with the same arguments, and only then the copula. That is what
 * `resolve` is for, and it is optional so that a caller with no resolver in hand
 * (the tests' direct `teOrShite` calls) behaves exactly as before. Both panels
 * have one at the 而 branch and pass it.
 *
 * `isUnpunctuatedTitleSpan`, the span branch's other guard, is not asked and
 * needs no note beyond this one: it answers false whenever anything is read
 * after the span, and a 而 standing here is such a thing. */
function precedingFormSuppliesShite(plan: ReadingPlan, tokenId: number, resolve?: ReadingResolver): boolean {
  const prev = previousMeaningfulToken(plan, tokenId);
  if (!prev) return false;
  if (isTariSuffix(prev)) {
    // The class is not looked up: `tariSuffixReading` is the only thing that
    // gives a suffix a class at all, and it gives every one of them this one.
    const form =
      rereadGovernedForm(prev.id, plan) ??
      decideConjForm(
        conjugationSubject(prev, plan.sentence),
        nextMeaningfulToken(plan, prev.id),
        plan.sentence,
        "tari-keiyoudoushi",
      );
    return conjugate("tari-keiyoudoushi", form) === conjugate("tari-keiyoudoushi", "renyou");
  }
  const redup = descriptiveRedupSpan(prev, plan.sentence);
  // Only from the last member: the group's ending is written there and nowhere
  // else, so a 而 standing after any other member is not standing after a
  // として. (In practice a 而 can only ever follow the last one, the members
  // being contiguous, but the ending's position is the fact this turns on and
  // it is worth saying so.)
  if (redup && prev.id === redup.tokenIds[redup.tokenIds.length - 1]) {
    const form =
      rereadGovernedForm(prev.id, plan) ??
      decideConjForm(
        carrierOf(redup, plan.sentence),
        nextMeaningfulToken(plan, prev.id),
        plan.sentence,
        "tari-keiyoudoushi",
      );
    return conjugate("tari-keiyoudoushi", form) === conjugate("tari-keiyoudoushi", "renyou");
  }
  // The span arm, above the per-token one and not in place of it: a token that
  // is the last member of a span may also be answered by its own
  // `extraEndingFor` (千里而近 is 千里近し, the copula taken on 里 itself), and
  // that answer is unchanged. What is added is the span's own ending, asked of
  // the carrier and selected at the member the ending is written on — the two
  // arguments `generateKakikudashiPieces` passes, in its order.
  const span = plan.spans.find((s) => s.tokenIds[s.tokenIds.length - 1] === prev.id);
  if (span && resolve) {
    const carrier = carrierOf(span, plan.sentence);
    if (compoundSuruOkurigana(carrier, prev.id, plan, resolve) === undefined) {
      const spanForm = extraEndingFor(carrier, findRoot(plan.sentence), plan.sentence, true);
      if (spanForm === COPULA && selectForm(spanForm, plan, prev.id) === COPULA.renyou) return true;
    }
  }
  const form = extraEndingFor(prev, findRoot(plan.sentence), plan.sentence);
  return form === COPULA && selectForm(form, plan, prev.id) === COPULA.renyou;
}

/** Whether the token before `tokenId` closes a fused span that wrote **ナリ
 * 活用's 連用形 に** — the one span ending the 而 has to finish with して rather
 * than て. See the branch in `teOrShite` that spends it for why.
 *
 * The lines are `precedingFormSuppliesShite`'s span arm, asking the same
 * question of the same two tokens in the same order (the carrier decides the
 * form, the last member is where the ending is written and so whose neighbour
 * the 而 is), and then **checking their work**: the class is acted on only
 * where re-conjugating it for the 連用形 reproduces, character for character,
 * the string `compoundSuruOkurigana` actually returned. That is
 * `compoundSuruRenyouTe`'s discipline and it is here for its reason — that
 * function writes the finished ending itself and reports neither the form nor
 * the class, so a caller that needs them has to derive them again, and a
 * derivation that has drifted must fail closed. Failing closed here means the
 * plain て, which is what this line wrote before the check existed.
 *
 * Needs the resolver, and answers false without one, exactly as the span arm
 * above does: a caller with none in hand (the tests' direct `teOrShite` calls)
 * behaves as it did before. Both panels have one at the 而 branch. */
function precedingSpanWroteNariRenyou(plan: ReadingPlan, tokenId: number, resolve?: ReadingResolver): boolean {
  if (!resolve) return false;
  const prev = previousMeaningfulToken(plan, tokenId);
  if (!prev) return false;
  const span = plan.spans.find((s) => s.tokenIds[s.tokenIds.length - 1] === prev.id);
  if (!span) return false;
  const carrier = carrierOf(span, plan.sentence);
  const written = compoundSuruOkurigana(carrier, prev.id, plan, resolve);
  if (written === undefined) return false;
  const resolved = resolve(carrier, plan.sentence);
  // The span's own class and never the carrier's single character — the guard
  // `compoundSuruOkurigana` itself makes, for the reason written there.
  const lex = resolved.suruCompound ? syntheticLexiconEntry(resolved, carrier.lemma) : undefined;
  if (lex?.conjClass !== "nari-keiyoudoushi") return false;
  return written === conjugatedOkurigana(lex, "renyou");
}

/** The two classes whose 連用形 takes して in front of a 而 — `renyouTe.ts`'s
 * `SHITE_CLASSES` minus the two 形容動詞, which `precedingFormSuppliesShite`
 * has already answered for by then (a ナリ writes にして and a タリ として, and
 * both are the converb already, so 而 adds nothing rather than して). */
const KU_ADJECTIVE_CLASSES: ReadonlySet<ConjClass> = new Set<ConjClass>(["ku-keiyoushi", "shiku-keiyoushi"]);

/** True when what is read immediately before this 而 is a **ク/シク活用形容詞
 * standing in its 連用形** — 高くして, 貧しくして. See `teOrShite`, which is
 * where the count is and the only caller.
 *
 * **The paradigm, asked the way both panels ask it**, and not the token's
 * `Degree=Pos`: the feature is on every stative the parser meets, and this app
 * conjugates a great many of those as サ変 or 四段 (恢洪す, 約まる, 勝つ), where
 * a して would print 恢洪しして. `lexiconEntryFor` is the one function that
 * answers which entry a token conjugates by — the lexicon's, a reading the
 * syntax chose, or the synthetic entry a resolver-supplied class builds — and
 * asking it here is what keeps this and the okurigana the panels actually
 * write from drifting apart.
 *
 * **The form is asked too.** して is a 連用形's converb and nothing else, so a
 * 形容詞 the sentence has put in some other form must not take one: a 連体形 in
 * front of a 而 would print 廣きして. `decideConjForm` is asked with the same
 * arguments the panels pass it, through `rereadGovernedForm` first for the
 * reason `precedingFormSuppliesShite` gives.
 *
 * With no resolver in hand the lexicon alone answers, which is what this
 * function's one caller already documents for `precedingFormSuppliesShite`:
 * a `VERB_LEXICON` adjective (高) is found either way, and a class derived by
 * the reading layer (厚, 廣) needs the resolver that derived it. */
function precedingKuAdjectiveConverb(plan: ReadingPlan, tokenId: number, resolve?: ReadingResolver): boolean {
  const prev = previousMeaningfulToken(plan, tokenId);
  if (!prev) return false;
  // **A span's ending is its carrier's**, so a span is asked about its
  // carrier and not about the member the ending happens to be written on.
  // 體恢洪而廓落 and 形脩廣而幽清 are the pair that says so: 脩廣 is one span
  // read サ変 (脩廣**す**, 連用形 脩廣し) whose *last* member 廣 is a ク活用
  // adjective in its own right, and asking 廣 printed 脩廣しして. The same
  // arm, for the same reason, as the span arm in
  // `precedingFormSuppliesShite` above.
  const span = plan.spans.find((s) => s.tokenIds[s.tokenIds.length - 1] === prev.id);
  const subject = span ? carrierOf(span, plan.sentence) : prev;
  const resolved = resolve?.(subject, plan.sentence) ?? {};
  const conjClass = lexiconEntryFor(subject, resolved, plan.sentence)?.conjClass;
  if (conjClass === undefined || !KU_ADJECTIVE_CLASSES.has(conjClass)) return false;
  const form =
    rereadGovernedForm(prev.id, plan) ??
    decideConjForm(
      conjugationSubject(subject, plan.sentence),
      nextMeaningfulToken(plan, prev.id),
      plan.sentence,
      conjClass,
      resolve,
    );
  return form === "renyou";
}
