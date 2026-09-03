import type { Sentence, Token } from "../parse/types.ts";
import type { ReadingPlan } from "../kundoku/types.ts";
import { conjugate, type ConjForm, type ConjClass } from "./classicalConjugation.ts";
import {
  AUXILIARY_LEMMAS,
  COPULA,
  endingForMorph,
  EXISTENCE,
  NEGATION,
  PASSIVE_RU,
  PASSIVE_RARU,
  parseMorphFeatures,
  renyoukeiEndsInISound,
  genuineQuestionParticle,
  sentenceFinalParticle,
  SENTENCE_FINAL_PARTICLE_LEMMAS,
  type ConjugatedForm,
} from "./bungoConjugation.ts";
import {
  attestedSenseByModernSpelling,
  lexiconSensesByReading,
  VERB_LEXICON,
  type LexiconEntry,
} from "./verbLexicon.ts";
import { isBracket, isOpeningBracket } from "../parse/punctuation.ts";
// One-way in the type graph, two-way at module level: `depClassification.ts`
// already imports `isNegationUse` and `CAUSATIVE_LEMMAS` from here. Both
// directions are consumed only from inside function bodies (never at
// module-evaluation time), so the cycle resolves the way ESM cycles between
// pure-function modules do.
import {
  classifyToken,
  isDistributivePostpose,
  isGenitiveComplement,
  isNegatedBareReport,
  isSpeechQuoteComplement,
} from "../kundoku/depClassification.ts";
import { isRereadUse, rereadCharacter, rereadGovernedForm, rereadNegates } from "./rereadCharacters.ts";
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
import { chosenAuxiliary, chosenReadingText, isBareChosenReading } from "../reading/chosenReading.ts";
import type { ReadingResolver } from "../reading/types.ts";

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
  return sentence.tokens.some((t) => t.head === token.id && t.id !== token.id && isNegationUse(t));
}

/** Nominalizing particles (者/所, tagged PART rather than NOUN/PROPN by this
 * treebank) — grammatically equivalent to a following noun for rentaikei
 * purposes: 不復挺者 ("the thing that doesn't straighten back out") needs
 * 挺かぬ者 exactly the same way 不知人 needs 知らぬ人, even though 者 itself
 * isn't POS-tagged as a noun. */
const NOMINALIZING_LEMMAS = new Set(["者", "所"]);

/** ず (shuushikei) vs. its true classical rentaikei ぬ (see `NEGATION`'s own
 * doc) — ぬ is needed specifically when the negated predicate modifies a
 * following noun (知らぬ人, "a person who doesn't know") or nominalizer
 * (挺かぬ者, see `NOMINALIZING_LEMMAS`), which in reading order means the
 * very next meaningful token is that noun/nominalizer. `nextToken` is
 * whatever `nextMeaningfulToken` finds after the negation piece itself. */
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
  // ざる and not ぬ, which is the other 連体形 ず has. The two are not
  // interchangeable and this file already draws the line between them: ぬ is
  // the plain ず-paradigm form, used attributively before a noun or a
  // nominalizer (知らぬ人, 挺かぬ者 — see `modifiesNominal` below), while the
  // ざり paradigm exists precisely because ず could not carry a following
  // auxiliary and had to be rebuilt as ず+あり to do it. So a further
  // auxiliary takes ざる — 及ばざるがごとし already in this function, and
  // 知らざるなり here — and only a noun takes ぬ.
  //
  // Keyed on the particle *reading* なり rather than on the lemma 也, since
  // that is the fact the rule turns on, and read from the one table that
  // decides it (`sentenceFinalParticle`) so this cannot drift from what the
  // discourse branch actually emits. 矣 is unread and 乎/哉 are や/かな, so
  // none of them pulls a 連体形.
  if (nextToken && sentenceFinalParticle(nextToken.lemma) === "なり") return NEGATION.rentaiZari!;
  // A 限定 耳 closing the sentence wants one as well, for the same reason in a
  // different grammatical class: it reads のみ, a 副助詞, and a 副助詞 attaches
  // to a 連体形. 不知之耳 was ending これを知らず + のみ where kundoku reads
  // これを知らざるのみ (孟子's 直不百步耳 — 直だ百歩ならざるのみ).
  //
  // ざる and not ぬ, by the line this function already draws between them. ぬ
  // is the plain ず-paradigm 連体形 and is used where the negated predicate
  // *modifies* something — a following noun (知らぬ人) or nominalizer (挺かぬ者),
  // which is what the `modifiesNominal` test below is looking for. のみ is
  // neither: nothing is being modified, the particle is attaching onto the
  // finished negative predicate, and carrying something further is precisely
  // what ず could not do and the ざり paradigm was rebuilt to do.
  //
  // Keyed on the *reading* のみ and read from `sentenceFinalParticle`, exactly
  // as the なり line above is, so this cannot disagree with what the discourse
  // branch in either panel actually prints. See `isLimitingParticleAhead`,
  // which is this rule's positive half — the 連体形 an *un*negated predicate
  // takes in front of the same particle.
  if (nextToken && sentenceFinalParticle(nextToken.lemma) === LIMITING_PARTICLE_READING) return NEGATION.rentaiZari!;
  const modifiesNominal =
    !!nextToken && (nextToken.pos === "NOUN" || nextToken.pos === "PROPN" || NOMINALIZING_LEMMAS.has(nextToken.lemma));
  return modifiesNominal ? NEGATION.alt! : NEGATION.primary;
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
export function auxiliaryFormFor(token: Token, sentence: Sentence): ConjugatedForm | undefined {
  const aux = AUXILIARY_LEMMAS[token.lemma];
  if (!aux) return undefined;
  // Both spellings consulted — the table is keyed on the lemma and the
  // 再読文字 table on the written form, and the parser lemmatizes 当 to 當.
  const reread = rereadCharacter(token.text) ?? rereadCharacter(token.lemma);
  if (reread && !isRereadUse(token, sentence) && !chosenAuxiliary(token)) return undefined;
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
  return (
    sentence.tokens.find(
      (t) => t.head === token.id && t.id !== token.id && (t.dep === "comp:obj" || t.dep === "comp:aux") && t.pos === "VERB",
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
 * Three relations, and the third is the one that had to be argued for:
 *
 *  - **`comp:obl`** — the ordinary shape, and what SUD reserves for a
 *    causative's clausal complement. 使民戰 comes back this way.
 *  - **`comp:aux`** — the same complement under the other label this parser
 *    uses for an auxiliary's governed predicate (it gives 被 its verb that
 *    way, see `passiveComplement`).
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
  if (token.dep === "comp:obl" || token.dep === "comp:aux") return true;
  return token.dep === "parataxis" && (token.pos === "VERB" || token.pos === "AUX");
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
 * 而 in reading order is itself stative/adjectival (`Degree=Pos`) — an
 * adjective's own 連用形 already reads straight into 而 as an ordinary
 * converb (長而敦敏 -> 長くて敦く敏し, not 長くしかして…), the same way any
 * other renyoukei-then-て chain does. Checked first, ahead of the
 * stative-*bridging* case below, since 長而敦敏's own 而 also happens to
 * bridge into a `Degree=Pos` conj:coord (敏) — without this check first,
 * that would wrongly read as a second, unwarranted rhetorical pivot on top
 * of the adjective 長 already being one.
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
 * nothing read on 而 itself, while しかも is 而 read しか with the particle も
 * after it. So the first two come back as okurigana alone and the third as a
 * reading plus its ending — which is what lets the 訓読文 set it as furigana
 * しか with モ beside it, and not as one katakana gloss.
 *
 * しかも rather than しかして: 而 opening a clause is 而も. (しかして was here
 * first and is what the tests were written against.) */
export interface EruConnective {
  /** Read over 而 itself; absent where 而 is only an ending on what precedes. */
  reading?: string;
  okurigana: string;
}

export function teOrShite(plan: ReadingPlan, tokenId: number): EruConnective {
  const prev = previousMeaningfulToken(plan, tokenId);
  // Ahead of everything else: a predicate handing on may have written the して
  // as part of its own 連用形 — にして for a nominal, として for a タリ形容動詞 —
  // and a 而 adding a second one gave 王仁人にしてて. See
  // `precedingFormSuppliesShite`.
  //
  // **Except where the mark below has already sent this 而 to しかも.** What the
  // stand-down exists to prevent is a *doubled ending* — a second て or して
  // written onto a 連用形 that already contains one — and しかも is not one: it
  // is a reading over 而 itself, "moreover", with nothing added to the word
  // before it (see `EruConnective`). Standing down over it does not avert a
  // doubling, it deletes a word. The case is live now that a タリ形容動詞 in a
  // coordination chain takes として (see `isNonFinalCoordinand`): 愕然、而笑
  // has the chain, so 愕 is 連用形 and writes として, and the 、 before 而 makes
  // it しかも — 愕然として、しかも笑ふ. Without this exception the 而 wrote
  // nothing at all and the reading lost its しかも.
  if (!precededBySourcePunctuation(plan.sentence, tokenId) && precedingFormSuppliesShite(plan, tokenId)) {
    return { okurigana: "" };
  }
  const afterNegation = !!prev && isNegationUse(prev);
  // A 再読文字 closing on the previous token negates it exactly as a postposed
  // 不 would, and is exactly as invisible to the test above — its ず is no
  // token of its own to be found in reading order. 未學禮而不知 reads
  // いまだ禮を學ばずして知らず, and read ずて without this.
  const afterRereadNegation =
    !!prev &&
    (plan.rereadCloseIds.get(prev.id) ?? []).some((id) => rereadNegates(plan.sentence.tokens.find((t) => t.id === id)?.text ?? ""));
  if (afterNegation || afterRereadNegation) return { okurigana: "して" };
  if (precededBySourcePunctuation(plan.sentence, tokenId)) return SHIKAMO;
  if (prev && parseMorphFeatures(prev.morph ?? "").Degree === "Pos") return { okurigana: "て" };
  const token = plan.sentence.tokens.find((t) => t.id === tokenId);
  const governor = token && plan.sentence.tokens.find((t) => t.id === token.head);
  const bridgesToStativeCoord =
    token?.dep === "mod" && governor?.dep === "conj:coord" && parseMorphFeatures(governor.morph ?? "").Degree === "Pos";
  return bridgesToStativeCoord ? SHIKAMO : { okurigana: "て" };
}

/** Exported so that `annotationEditor.ts` can recognize しか as *the*
 * reading 而 takes over the character, rather than restating it — that
 * module has to tell 而 read as the connective apart from 而 read as
 * anything else, and the only thing that settles which kana are the
 * connective's is this constant. */
export const SHIKAMO: EruConnective = { reading: "しか", okurigana: "も" };

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
 * it closes. The relation is the parser's own `discourse`/`discourse@sp`,
 * which is how every one of them attaches. */
function hasSentenceFinalParticle(token: Token, sentence: Sentence): boolean {
  return sentence.tokens.some(
    (t) =>
      t.head === token.id &&
      t.id !== token.id &&
      (t.dep === "discourse" || t.dep === "discourse@sp") &&
      SENTENCE_FINAL_PARTICLE_LEMMAS.has(t.lemma),
  );
}

/** Whether this token is one of `SENTENCE_FINAL_PARTICLES` *being used as
 * one*, as against a character that also spells a content word.
 *
 * 乎/也/矣/哉/夫/焉/耳 arrive tagged `discourse`/`discourse@sp` and need no
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
 * `sentenceFinalParticle` from a branch keyed on `dep === "discourse"`, which
 * a token caught by position has not got, so this test stands beside that dep
 * test in `generator.ts` and in `KundokuView.ts`. Beside and not instead of:
 * the dep test admits every `discourse` token including lemmas the table does
 * not know, and narrowing it to this predicate would change how those render.
 *
 * The three uses have to agree — a 否 read や with a を in front of it, or read
 * や in one panel and 否ム in the other, is the split this arrangement exists
 * to make impossible — which is why all three ask this one function rather
 * than each testing the position for itself. */
export function isSentenceFinalParticleUse(token: Token, sentence: Sentence): boolean {
  if (!SENTENCE_FINAL_PARTICLE_LEMMAS.has(token.lemma)) return false;
  if (token.dep === "discourse" || token.dep === "discourse@sp") return true;
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
  if (token.pos === "NOUN" || token.pos === "PROPN") return false;
  const meaningful = sentence.tokens.filter((t) => t.dep !== "punct");
  return meaningful.length > 1 && token.id === Math.max(...meaningful.map((t) => t.id));
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

/** の on a proper noun that modifies a following nominal — 楚人 -> 楚の人,
 * 孔子弟子 -> 孔子の弟子, 梁惠王 -> 梁の惠王. Literary Chinese realizes no
 * genitive particle here at all; kundoku supplies one, exactly as it
 * supplies を and に elsewhere in this table.
 *
 * A common noun modifying a common noun takes it too — 山中 -> 山の中, 門人 ->
 * 門の人. This was restricted to a PROPN modifier at first, on the grounds
 * that a NOUN+NOUN `mod` is often a fused jukugo read as one word (先帝
 * せんてい, 門人 もんじん) and arrives on exactly the same edge that 楚人 does,
 * so the relation cannot separate them. That is true, and it is not a reason
 * to withhold the particle: leaving those edges alone did not read them as
 * jukugo, it handed them to the fronted-topic rule below, and 山中有虎 came
 * out 山は中虎を有り. Between a genitive that is sometimes a compound and a
 * topic that is always wrong, the genitive is the better default. Telling a
 * real jukugo from a genitive needs lexical evidence, not a POS.
 *
 * The state-name `compound` case is the one addition beyond `mod`. This
 * parser labels 國名+王 `compound` rather than `mod` (秦王/楚王/齊王/趙王 all
 * measured that way, against `mod` for the very same states over 人/兵), the
 * same label it gives a genuine fused name — 黃帝, 惠王. What separates them
 * is not the relation but `NameType`: 秦 is `NameType=Nat`, a *state*, and a
 * state name standing on a title is a genitive ("the king OF Qin"), while 黃 is
 * `NameType=Giv` and 惠 `NameType=Prs` — personal-name elements, which fuse
 * into the name and must not be broken. Deliberately not extended to
 * `NameType=Geo` (安陵君, a fief title read as one word).
 *
 * The modifier must also precede its head with nothing between the two but
 * the head's own name-mates, so 梁 reaches past 惠 to 王 while a `mod` edge
 * flung across half a sentence (盾 over 者, seven tokens away) is left
 * alone. */
export function genitiveNoParticle(token: Token, sentence: Sentence): string | undefined {
  if (token.pos !== "PROPN" && token.pos !== "NOUN") return undefined;
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
 * 山の中に虎有り, and 謂其身有異疾 is その身に異疾有り — never …を…を有り,
 * which is what both were coming out as.
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
 *    shape, and the reading it gives (山の中に虎有り) is the one a code
 *    comment in `genitiveNoParticle` above records as wanted and unreached.
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
 * covers 曰/云/言/謂/問/答 by their shared xpos rather than by a lemma list. */
function isSpeechComplement(token: Token, sentence: Sentence): boolean {
  if (token.dep !== "comp:obj" && token.dep !== "comp:pred") return false;
  if (token.pos === "NOUN" || token.pos === "PROPN") return false;
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
  return !isQuotedSpeechComplement(token, sentence);
}

export function isNominalizedObjectPredicate(token: Token, sentence: Sentence): boolean {
  if (token.dep !== "comp:obj" || token.pos !== "VERB") return false;
  if (!isVerbalXpos(token) || isExistentialPredicate(token)) return false;
  const governor = sentence.tokens.find((t) => t.id === token.head && t.id !== token.id);
  if (!governor || governor.pos !== "VERB" || !isVerbalXpos(governor)) return false;
  if (isCommunicationVerb(governor) || isSpeechQuoteComplement(token, governor)) return false;
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
  if (!isNominalizedObjectPredicate(token, sentence)) return false;
  const governor = sentence.tokens.find((t) => t.id === token.head && t.id !== token.id);
  if (!governor || !INTENTION_VERB_LEMMAS.has(governor.lemma)) return false;
  return readsLastInItsSubtree(token, sentence);
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
  if (token.pos !== "VERB" || isExistentialPredicate(token)) return false;
  if (!isVerbalXpos(token) && !fusedWordIsVerbal(token, sentence)) return false;
  return readsLastInItsSubtree(token, sentence);
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

/** こと — the nominalizer kundoku supplies for a clause standing in a subject
 * slot. See `isNominalizedSubjectPredicate`. */
const SUBJECT_NOMINALIZER = "こと";

/** The negation that closes `token`'s clause — a 不/未/弗/勿 hanging off it,
 * which `depClassification.ts` postposes past its predicate so that the ず is
 * read after the verb it negates. Undefined for an unnegated predicate.
 *
 * `isNegationUse` rather than the lemma, so that a 不 the reader has taken out
 * of the class by picking a reading for it is no longer treated as one — the
 * same test both panels' negation branches spend. */
function negationClosing(token: Token, sentence: Sentence): Token | undefined {
  return sentence.tokens.find((t) => t.head === token.id && t.id !== token.id && isNegationUse(t));
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
  if (token.pos !== "VERB" || !isVerbalXpos(token) || isExistentialPredicate(token)) return false;
  const governor = sentence.tokens.find((t) => t.id === token.head && t.id !== token.id);
  if (!governor || governor.pos !== "VERB" || !isVerbalXpos(governor)) return false;
  if (isCommunicationVerb(governor) || isSpeechQuoteComplement(token, governor)) return false;
  return readsLastInItsSubtree(token, sentence, (child) => isNegationUse(child));
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
  if (predicate.dep !== "comp:obj" || predicate.pos !== "VERB") return false;
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

/** A token that is a predicate in its own right — VERB or AUX, confirmed by the
 * fine-grained tag. The modals 能/得/敢/欲 are AUX in this treebank
 * (`v,助動詞,…`) and are predicates exactly as a VERB is; `isVerbalXpos` is
 * what keeps out a *noun* the parser tagged VERB, and is asked here for the
 * same reason `isNominalizedObjectPredicate` asks it.
 *
 * Written once and shared by the two rules that claim the plain-`mod`
 * adverbial bucket, so their gates cannot drift apart again — see
 * `isNegatedAdverbialPredicate` for the 220 edges the drift was costing. */
function isVerbalPredicate(token: Token): boolean {
  return (token.pos === "VERB" || token.pos === "AUX") && isVerbalXpos(token);
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

/** ば — what a 已然形 conditional clause takes. See
 * `isConditionalTemporalClause`. */
const CONDITIONAL_PARTICLE = "ば";

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
 * discovery semantics rather than on anything a tree carries. */

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
 *  - **`mod` or plain `udep`.** The adverbial-clause slot, and the one
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
  if (token.pos !== "VERB" && token.pos !== "AUX") return false;
  if (!isVerbalXpos(token)) return false;
  // A 描写 stative used as a manner adverb or an attributive participle is not
  // a clause — 半 in 輒半種黍 is 半ば. A 描写 stative used as a *predicate* is
  // exactly what a protasis is built from (名不正則言不順), and the feature is
  // what tells the two apart. See `isAdverbialDescriptiveUse`.
  if (isAdverbialDescriptiveUse(token)) return false;
  const chain = predicateCoordinationChain(token, sentence);
  if (lastLinkOf(chain).id !== token.id) return false;
  if (!chain.some((link) => headsConditionalProtasis(link, token, sentence))) return false;
  return readsLastInItsSubtree(token, sentence, (child) => isNegationUse(child));
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
  if (head.pos !== "VERB" && head.pos !== "AUX") return false;
  if (!isVerbalXpos(head)) return false;
  if (isAdverbialDescriptiveUse(head)) return false;
  if (hasDistributivePostposeChild(head, sentence)) return false;
  const governor = sentence.tokens.find((t) => t.id === head.head && t.id !== head.id);
  if (!governor) return false;
  if (governor.pos !== "VERB" && governor.pos !== "AUX" && governor.pos !== "ADJ") return false;
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

/** What a sentence-final particle is read as *here* — the table's default,
 * unless the sentence settles a register the character alone leaves open.
 *
 * One entry does: 乎 reads か rather than や inside a 豈…乎 frame. See
 * `GENUINE_QUESTION_PARTICLES` for the pair and `RHETORICAL_QUESTION_ADVERB_LEMMAS`
 * for what licenses the switch.
 *
 * **Both panels must call this and not `sentenceFinalParticle`**, which is the
 * whole reason it exists as one exported function rather than as a test inside
 * either of them: a 乎 printing か in the prose and ヤ in the 訓読文 is exactly
 * the divergence `quoteClosing`, `negationEnding` and `pickedEnding` are each
 * shaped to make impossible. `sentenceFinalParticle` stays exported for the
 * callers that ask a *lemma* question and have no token — `negationForm`'s なり
 * and のみ tests, `isLimitingParticleAhead` — none of which 乎 is an answer to. */
export function sentenceFinalParticleFor(token: Token, sentence: Sentence): string {
  const base = sentenceFinalParticle(token.lemma);
  if (!base) return base;
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

/** Everything a negation piece writes: the ず/ぬ/ざる itself, and then the case
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
 * ざる and not ぬ, by the line `negationForm` already draws between them: ぬ is
 * the plain ず-paradigm 連体形 used where the negated predicate *modifies* a
 * noun or nominalizer, and the ざり paradigm is the one rebuilt to carry
 * something further — which is what a case particle is. Same answer as the
 * なり and のみ arms next to it, for the same reason.
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
export function negationEnding(token: Token, plan: ReadingPlan): string {
  const { form, particle, connective } = negationEndingParts(token, plan);
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
 * negation's own inflected shape (ず/ぬ/ざる/ざれ — `negationForm`), `particle`
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
export interface NegationEndingParts {
  /** The negation's own form — ず, ぬ, ざる, ざれ. */
  form: string;
  /** The case particle or conjunction the construction owes, or "". */
  particle: string;
  /** The して the 連用形の「て」 switch wrote, or "". */
  connective: string;
}

export function negationEndingParts(token: Token, plan: ReadingPlan): NegationEndingParts {
  const governor = plan.sentence.tokens.find((t) => t.id === token.head && t.id !== token.id);
  const oblique = !!governor && isNominalizedObliquePredicate(governor, plan.sentence);
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
  const bound = !oblique && !adverbial && !denied && boundByBindingParticle(token, plan);
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
  const object =
    !oblique &&
    !conditional &&
    !adverbial &&
    !denied &&
    !bound &&
    !!governor &&
    isNominalizedObjectPredicate(governor, plan.sentence);
  const rentai = oblique || adverbial || denied || bound || object;
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
  const chaining =
    !rentai && !conditional && !!governor && isNonFinalCoordinand(governor, plan.sentence, true);
  const next = nextMeaningfulToken(plan, token.id);
  // A 而 standing after the negation writes the connective itself, and writes
  // this very one: `teOrShite`'s `afterNegation` branch returns して. So the
  // switch stands down in front of one, exactly as `renyouTeSuffix` does for a
  // verb's own 連用形 — 人不知而不慍 is 人知らずして慍みず in both switch states,
  // and gave 人知らずしてして in one of them before this guard.
  const converb = chaining && renyouTeOn() && next?.lemma !== ERU_CONNECTIVE_LEMMA;
  const form = negationForm(
    next,
    rereadGovernedForm(token.id, plan) ??
      (rentai ? "rentai" : conditional ? "izen" : chaining ? "renyou" : undefined),
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
  const particle = bound
    ? ""
    : object
      ? OBJECT_PARTICLE
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

/** True when the negation `token` closes a clause a **係助詞 of the や/か class**
 * binds — so the ず takes the 連体形 ざる. 君飲嘗不醉否 is 醉は**ざる**や.
 *
 * The positive half of this rule is `isBindingParticleAhead`, and the two say
 * the same thing about the same slot: a 係助詞 attaching onto a predicate leaves
 * it attributive. What is different is only *which* token is standing in front
 * of the particle. On an unnegated clause it is the predicate itself and
 * `decideConjForm` answers (數有る**か**); on a negated one the 不 is postposed
 * past its verb, so the thing the particle lands on is the ず, and the verb owes
 * the ず a 未然形 rather than owing the particle anything. That is the same
 * division of labour 苦不得飲 (得ざるに), 學而不思則罔 (思はざれば) and
 * 不知之耳 (知らざるのみ) already run on.
 *
 * **不亦…乎 was carved out of this and no longer is.** A `RHETORICAL_FRAME_ADVERB`
 * test stood here, refusing the 連体形 wherever a 亦 hung off the same
 * coordination chain, so that 學而時習之，不亦說乎？ kept 亦說ばしから**ず**や.
 * The case for it was that the frame is one lexicalised formula — over
 * `lzh-{train,dev,test}.sud.conllu`, 72 of the 276 negation-before-や/か edges
 * carry a 亦 and every one of those 72 is 不亦…乎, while 不亦 itself occurs in 82
 * sentences and takes 乎 in 78 of them — and that 〜ずや is the formula's own
 * ending, learnt as a unit the way 豈〜んや is.
 *
 * **The reader has overruled it**, in those words: *"Don't carve out 不亦."* So
 * the rule is now what it says it is — a 係助詞 of the や/か class binds the thing
 * standing in front of it, and on a negated clause that thing is the ず — and it
 * applies to all 276 edges alike. 不亦說乎 reads 亦說ばしから**ざる**や, 不亦樂乎
 * 亦樂しからざるや, and 不亦君子乎 亦君子ならざるや. The counts above are kept
 * because they are the measurement the carve-out was made on and they say
 * exactly what is being given up by removing it; they are not an argument for
 * putting it back. */
function boundByBindingParticle(token: Token, plan: ReadingPlan): boolean {
  const sentence = plan.sentence;
  const governor = sentence.tokens.find((t) => t.id === token.head && t.id !== token.id);
  if (!governor) return false;
  const next = nextMeaningfulToken(plan, token.id);
  return isBindingParticleAhead(governor, next, sentence, undefined);
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

export function caseParticleFor(token: Token, sentence: Sentence): string | undefined {
  const governor = sentence.tokens.find((t) => t.id === token.head);

  // Ahead of everything: a sentence-final particle takes no case particle of
  // its own, however the parse tagged it. 否 closing 君飲嘗不醉否？ comes back
  // VERB/`comp:obj` of 醉, which `isNominalizedObjectPredicate` below read as a
  // predicate standing in an object slot and marked を — the "spurious を" this
  // line removes. See `isSentenceFinalParticleUse` for how the particle use is
  // told from the verb 否む, and for what is still missing before the character
  // reads や rather than 否む.
  if (isSentenceFinalParticleUse(token, sentence)) return undefined;

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
  const genitive = genitiveNoParticle(token, sentence);
  if (genitive) return genitive;

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

  if (governor?.pos === "ADP" || (governor?.lemma === "之" && governor.dep === "mod")) {
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
  if (
    governor &&
    CAUSATIVE_LEMMAS.has(governor.lemma) &&
    token.dep === "comp:obj" &&
    NOMINAL_PREDICATE_POS.has(token.pos)
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
  if (
    governor &&
    isComparativeYu(governor) &&
    (token.dep === "comp:obj" || (token.dep === "mod" && NOMINAL_PREDICATE_POS.has(token.pos))) &&
    token.id > governor.id &&
    !isInterrogativeStem(token) &&
    !hasComparativeNegation(governor, sentence)
  ) {
    return "の";
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
  if (governor && isExistentialPredicate(governor) && token.dep === "comp:obj") return undefined;
  if (isExistentialLocus(token, sentence)) return "に";

  // What a verb of thinking or intention has in view takes んと — the
  // volitional む plus the quotative と — on the 未然形 `decideConjForm` gives
  // it from the same predicate: 思飲酒 -> 酒を飲まんと思ふ. Ahead of the
  // nominalized-object rule immediately below, which it narrows: the two key
  // on the same relation and this one applies to the smaller class of
  // governor, so it has to answer first or the を would take every one of
  // them. See `isVolitionalComplement`.
  if (isVolitionalComplement(token, sentence)) return VOLITIONAL_PARTICLE;

  // A predicate standing in an object slot is nominalized, and takes を on top
  // of the 連体形 `decideConjForm` gives it — 不得飲 -> 飲むを得ず. See
  // `isNominalizedObjectPredicate`, which both halves of the rule share.
  // Below the 如/若 branch above, which supplies に for its own comparative
  // complement (惡酒如仇 -> 仇するに如く) and must not be overridden.
  //
  // **Withheld where a negation closes the clause**, exactly as the oblique and
  // conditional branches below withhold their own に and ば, and this was the
  // one member of the four that was not doing it. A postposed negation is read
  // *after* the predicate, so a particle written here lands inside it: 苦不得飲
  // with 得 on `comp:obj` — which is the label gold gives it, see
  // `isNominalizedObjectPredicate` — printed 飲むを得**を**ず, the object marker
  // wedged between the verb and its own ず. `negationEndingParts` writes it on
  // the 連体形 ざる instead, and 飲むを得ざるを苦しむ is what comes out.
  if (isNominalizedObjectPredicate(token, sentence)) {
    return negationClosing(token, sentence) ? undefined : OBJECT_PARTICLE;
  }

  // …and a predicate standing in a *subject* slot takes こと, on the 連体形
  // the same predicate gives it — 去首半尺 -> 首を去ること半尺. Above the
  // `dep === "subj"` topicalization branches below, which would otherwise
  // claim the same token and mark a whole clause は; those are about a
  // *nominal* subject standing as a dangling topic, and a predicate in that
  // slot is a nominalized clause first. See `isNominalizedSubjectPredicate`.
  if (isNominalizedSubjectPredicate(token, sentence)) return SUBJECT_NOMINALIZER;

  // …and a predicate standing in an *oblique* slot takes に, on the 連体形 the
  // same predicate gives it — 苦不得飲 -> 飲むを得ざるに苦しむ. The third of the
  // trio, beside the object and subject rules above and decided by the one
  // predicate that also decides its form, so the two cannot come apart.
  //
  // Withheld where a negation closes the clause, because the particle would
  // then land in front of the ず rather than after it (得にず). `negationEnding`
  // writes it there instead, on the 連体形 ざる. This is the only branch in this
  // function whose answer is emitted from another token, so it is the only one
  // that has to check.
  if (isNominalizedObliquePredicate(token, sentence)) {
    return negationClosing(token, sentence) ? undefined : OBLIQUE_PARTICLE;
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
  // 飲食給するを能はざるに至る, not 飲は食…. Both halves are needed and they are
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
    const particle =
      head.dep === "comp:pred" ? predicativeComplementParticle(headGovernor) : CASE_PARTICLE_FOR_DEP[head.dep];
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
    if (root && root.lemma in AUXILIARY_LEMMAS) return onCarrier("は");

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
 * One function rather than a condition written out at each site, because the
 * three sites are answering the same question about the same token and any
 * drift between them is visible as the two panels disagreeing about a
 * character. That is not hypothetical: the reading branch was missing this
 * gate entirely, so a mis-tagged PROPN (this parser tags 縛/驚/覺/解 that way)
 * took a lexicon reading in the prose gloss and the resolver's on'yomi in the
 * 訓読文 — 縛 glossed しば beside a ruby reading ばく. A parser error belongs on
 * screen, the same error in both panels, not silently patched out of one of
 * them by a lookup the other one refuses. */
export function usesLexiconEntry(token: Token): boolean {
  return (
    (token.pos === "VERB" ||
      token.pos === "AUX" ||
      isMistaggedLocativeVerb(token) ||
      isNominalizedVerbClause(token) ||
      isConverbUse(token)) &&
    !isNominalizedFaultNoun(token)
  );
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
  resolved: { beatsLexicon?: boolean; conjClass?: ConjClass; reading?: string; okurigana?: string },
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
  return resolved.beatsLexicon ? syntheticLexiconEntry(resolved, token.lemma) : VERB_LEXICON[token.lemma];
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

/** `COMPARATIVE_GOTOSHI` where `token` is a positive comparison 如/若, and
 * undefined everywhere else — including a *negated* comparison, which is the
 * other verb (如かず) and is what `VERB_LEXICON`'s own 四段カ行 entry is for. */
function comparisonLexiconEntry(token: Token, sentence: { tokens: Token[] }): LexiconEntry | undefined {
  if (!isComparativeYu(token)) return undefined;
  if (hasComparativeNegation(token, sentence)) return undefined;
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

/** How 於 is read, split into what stands *over* the character and what is
 * written after it — the distinction `EruConnective` draws for 而, and for the
 * same reason: the two senses are different kinds of word and are written
 * differently.
 *
 * 於 always inverts before its governor now (see `depClassification.ts`'s
 * `INVERT_DEPS`), landing in the same pre-head adjunct position regardless of
 * which sense applies. より is the default — it covers both a stative
 * predicate's comparison (藍より青し, "bluer *than* indigo") and a plain action
 * verb's source (取之於藍 -> 藍より取り, "takes it *from* indigo") — with
 * `LOCATIVE_GOVERNOR_LEMMAS` giving おいて for the bounded set of verbs whose
 * 於-complement is a bare location instead.
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
export function yuParts(token: Token, sentence: Sentence): { reading?: string; okurigana: string } | undefined {
  if (token.lemma !== "於") return undefined;
  const governor = sentence.tokens.find((t) => t.id === token.head);
  if (governor && LOCATIVE_GOVERNOR_LEMMAS.has(governor.lemma)) return { reading: "お", okurigana: "いて" };
  return { okurigana: "より" };
}

/** Whether this token is a 於 in its locative sense — the one read おいて,
 * whose object takes に. The presence of a reading over the character is what
 * marks it (see `yuParts`, where the two senses are told apart once and for
 * all), so what `caseParticleFor` writes and what the panels print cannot
 * disagree about which 於 this is. */
function isLocativeYu(token: Token, sentence: Sentence): boolean {
  return yuParts(token, sentence)?.reading !== undefined;
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

/** The marks that **close a sentence**, as against the ones that divide items
 * inside one. Read only by `coordinationSpansStop`.
 *
 * **Not `punctuation.ts`'s own `isSentenceFinalPunct`, and the divergence is
 * measured rather than casual.** That set holds 。．？！ *and* ，, because it
 * answers a different question — where this app *segments* a text — and the
 * parser it feeds segments on ， too. The question here is whether two
 * coordinated words are one phrase, and on that question ， sides with 、:
 * over `lzh-{train,dev,test}.sud.conllu` a ， stands inside a nominal
 * coordination chain **490** times where no 。 does, and every one of them is a
 * genuine list — 一簞食，一瓢飲 · 宗廟之美，百官之富 · 君臣上下，父子兄弟 ·
 * 五母雞，二母彘 — which take one particle after the whole enumeration. */
const CLAUSE_CLOSING_MARKS: ReadonlySet<string> = new Set(["。", "．", "？", "！"]);

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
  return sentence.tokens.some((t) => t.dep === "punct" && t.id > lo && t.id < hi && CLAUSE_CLOSING_MARKS.has(t.text));
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
 * edge: this parser tags a descriptive word VERB with `Degree=Pos` (賢 in
 * 王學而賢), so such a conjunct is verbal here and has always been walked to.
 *
 * **It did concern one standing at the *near* end, and that is what the gate
 * below now admits.** `predicateCoordinationChain`'s own `links` has always
 * counted an `ADJ` neighbour as a further link across an explicit coordinator,
 * for the reason written there — the parser mostly tags a descriptive VERB with
 * `Degree=Pos` but does sometimes use the plain tag, and 酒蟲's 豪 comes back
 * ADJ. The token being *asked about* was held to VERB/AUX alone, so the same
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
  const isPredicate = (t: Token) => t.pos === "VERB" || t.pos === "AUX" || t.pos === "ADJ";
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
function predicateCoordinationChain(token: Token, sentence: Sentence): Token[] {
  const isVerbal = (t: Token) => t.pos === "VERB" || t.pos === "AUX";

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
  const members = new Set<number>([token.id]);
  const pending: Token[] = [token];
  // A conjunct counts as a further link when it is itself a predicate: a verb,
  // or — across an explicit coordinator only — a bare nominal or an adjective.
  // `ADJ` belongs with the nominal here rather than with the verbs: the parser
  // tags most descriptive words VERB with `Degree=Pos`, but it does use the
  // plain tag, and 酒蟲's 豪 comes back ADJ. Left out, the verb before it saw
  // no chain at all and closed the sentence it is half of — 黍を種う where the
  // conjunct that follows wants 黍を種ゑ. Restricted to `NOMINAL_COORDINATION_
  // DEPS` for the same reason the nominal is: `parataxis` keeps a verb at its
  // far end so the walk cannot wander out of the chain.
  const links = (neighbour: Token, edgeDep: string): boolean =>
    isVerbal(neighbour) ||
    ((NOMINAL_PREDICATE_POS.has(neighbour.pos) || neighbour.pos === "ADJ") && NOMINAL_COORDINATION_DEPS.has(edgeDep));

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
      if (COORDINATION_DEPS.has(mate.dep)) {
        const governor = byId.get(mate.head);
        if (governor && governor.id !== mate.id) {
          neighbours.push({ token: governor, edgeDep: mate.dep, dependent: mate, head: governor });
        }
      }
      for (const t of sentence.tokens) {
        if (t.head === mate.id && t.id !== mate.id && COORDINATION_DEPS.has(t.dep)) {
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

/** 者's nominalizer reading, which is also the only one of its two readings
 * under which anything before it is attributive. See `isNominalizerAhead`. */
const ZHE_NOMINALIZER_READING = "もの";

/** True when the very next thing read is a nominalizer this token is what
 * gets nominalized — 大破者 ("the one who wins big"), 君子所大破 ("what the
 * gentleman defeated"). A nominalizer stands where a noun would, so the
 * predicate feeding it is attributive and takes 連体形, exactly as one
 * feeding a real noun does. `negationForm` already reads `NOMINALIZING_LEMMAS`
 * this way for the negated half of the same rule (挺かぬ者, the 連体形 of ず);
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
  if (!nextToken || nextToken.id !== token.head || !NOMINALIZING_LEMMAS.has(nextToken.lemma)) return false;
  if (nextToken.lemma !== "者") return true;
  return !!resolveReading && resolveReading(nextToken, sentence).reading === ZHE_NOMINALIZER_READING;
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
  if (!nextToken || nextToken.id === token.id || nextToken.head !== token.id) return false;
  if (sentenceFinalParticle(nextToken.lemma) !== LIMITING_PARTICLE_READING) return false;
  return isSentenceFinalParticleUse(nextToken, sentence);
}

/** **係り結び** — the 係助詞 whose 結び is a **連体形**: ぞ, なむ, や, か.
 *
 * The bound form of classical Japanese, and the fourth case of the same
 * principle `modifiesGenitiveZhi`, `isNominalizerAhead` and
 * `isLimitingParticleAhead` are the first three: a predicate that something
 * else attaches onto is attributive, not one closing a sentence.
 *
 * **こそ is not here, and its absence is the point.** こそ binds a 已然形, not
 * a 連体形 — 「〜こそ〜けれ」 — so it could not share this branch even in
 * principle. It is also unreachable: **nothing in the app reads こそ**. The
 * readings a particle can take come from two tables and one override file, and
 * こそ is in none of them — `SENTENCE_FINAL_PARTICLES` holds や/なり/かな/り/
 * のみ and the empty 矣, `GENUINE_QUESTION_PARTICLES` holds 乎's か, and
 * overrides.json's か entries are 与/與/歟/欤/邪/耶. A 已然形 branch keyed on a
 * string no table produces would be a rule that cannot fire, which this file's
 * own standard (see `isConditionalTemporalClause`'s note on the caused-predicate
 * guard it removed) calls the appearance of protection rather than protection.
 * When a character is given a こそ reading, that branch is what to add, beside
 * this one and returning `izen`.
 *
 * **How the reading is found, and why not the lemma.** The particles reach the
 * page as *readings*, not as characters: 乎 is や by default and **か** inside a
 * 豈…乎 frame (`sentenceFinalParticleFor`), 否 is や, and 与/與/歟/欤/邪/耶 are
 * か through overrides.json. Keyed on the reading, this rule follows all of
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
const BINDING_PARTICLE_READINGS: ReadonlySet<string> = new Set(["ぞ", "なむ", "や", "か"]);

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
  return resolveReading?.(particle, sentence).reading;
}

/** True when the very next thing read is a 係助詞 of the 連体形-binding class
 * closing this predicate. See `BINDING_PARTICLE_READINGS`. */
function isBindingParticleAhead(
  token: Token,
  nextToken: Token | undefined,
  sentence: Sentence,
  resolveReading: ReadingResolver | undefined,
): boolean {
  if (!nextToken || nextToken.id === token.id || nextToken.head !== token.id) return false;
  const reading = closingParticleReading(nextToken, sentence, resolveReading);
  return reading !== undefined && BINDING_PARTICLE_READINGS.has(reading);
}

export function decideConjForm(
  token: Token,
  nextToken: Token | undefined,
  sentence: Sentence,
  /** **Accepted and no longer read**, hence the underscore. Its one use was to
   * be handed on to `isNonFinalCoordinand`, which refused the four adjectival
   * paradigms on it; that narrowing is gone (see that function) and nothing
   * else in this decision ever depended on a paradigm — every rule below reads
   * the *tree*, and which okurigana the answer then spells is the caller's own
   * business. Kept as a positional slot rather than removed, because the four
   * call sites that fill it (`generator.ts`, `KundokuView.ts`,
   * `readingResolver.ts`, and this file's own `precedingFormSuppliesShite`)
   * pass `resolveReading` after it, and two of those files belong to other
   * owners. */
  _conjClass?: ConjClass,
  /** How the caller's own reading resolver reads a token — consulted only
   * for a following 者, whose two readings this file cannot tell apart on
   * its own. See `isNominalizerAhead`. */
  resolveReading?: ReadingResolver,
): ConjForm {
  // Negation first: 不 governs the form of the verb it negates regardless
  // of where that verb sits in a chain (學不厭教不倦 — 厭 is non-final, but
  // takes 未然形 for the ず that follows, not 連用形).
  if (nextToken && isNegationUse(nextToken)) return "mizen";
  // しむ and る/らる both attach to a mizenkei, so the predicate a 使役 or
  // 受身 governs takes that form wherever it sits — 戰 under 使 is 戰は,
  // not 戰く.
  if (isCausedOrPassivePredicate(token, sentence)) return "mizen";
  // Ahead of the coordination rule below, whose 連用形 would otherwise win on
  // a sentence like 毎得書讀之: 讀 is tagged `parataxis` onto 得, so 得 looks
  // like a non-final conjunct, when what it really heads is the 毎-clause
  // that the rest of the sentence is *about*. 毎's scope is the tighter one,
  // and it is the thing 得's ending has to attach to.
  if (hasDistributivePostposeChild(token, sentence)) return "rentai";
  // The other two attributive environments, grouped with 毎 above and ahead
  // of the coordination and 而 rules below for the same reason: what a
  // predicate modifies binds tighter than what it is coordinated with, and
  // a 連用形 there would leave the following nominal with nothing modifying
  // it. Both are a predicate standing on a nominal — one reached through の,
  // one through a nominalizer — which is the definition of 連体形.
  if (modifiesGenitiveZhi(token, sentence)) return "rentai";
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
  if (isNominalizedObjectPredicate(token, sentence)) return "rentai";
  // The same inference in the *subject* slot: a predicate standing where a
  // noun would is attributive, and kundoku supplies the こと that lets a clause
  // fill that slot — 去首半尺 is 首を去ること半尺. Beside the object rule above
  // rather than anywhere else, because it is that rule's mirror image and the
  // same `isNominalizedSubjectPredicate` decides this and the こと.
  if (isNominalizedSubjectPredicate(token, sentence)) return "rentai";
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
  if (isNominalizedObliquePredicate(token, sentence)) return "rentai";
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
  {
    const governor = sentence.tokens.find((t) => t.id === token.head && t.id !== token.id);
    if (governor && isExistentialPredicate(governor) && token.dep === "comp:obj" && token.pos === "VERB") return "rentai";
  }
  if (nextToken && nextToken.lemma === "而") {
    // An explicit coordination chain outranks the punctuation heuristic
    // below. The parse *says* this predicate has another coordinated onto it
    // and so is not the one that ends the sentence; a mark before 而 is only
    // evidence about how the author broke the line up, and it cannot be
    // right to close a clause the tree says is still open. 輒半種黍；而家豪富
    // read 黍を種う、しかも… — 終止形, then a "moreover" carrying on from the
    // sentence it had just closed — where 連用中止法 is what the ； wants:
    // 黍を種ゑ、しかも….
    if (isNonFinalCoordinand(token, sentence)) return "renyou";
    // Otherwise the mark decides. Plain て/して attaches to a 連用形 and
    // carries the clause on, while a 而 the author has set off behind a mark
    // is opening something new, so what precedes it closes — 終止形.
    //
    // This deliberately no longer agrees with `teOrShite` about every 而, and
    // the note that once stood here saying the two must not disagree is
    // withdrawn. It was written when the mark-preceded 而 was read しかして,
    // which does open a fresh sentence and so really does want a 終止形 in
    // front of it. It reads しかも now — "moreover", which continues a
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
  // Not paired with `converbSuffix`'s て, by the reader's own decision: a
  // coordination chain links its members by 連用中止法, which is a bare 連用形
  // (酒を飲み肉を食ふ), and appending て here would turn every chain into a
  // converb sequence. See `converbSuffix`'s closing note.
  if (isNonFinalCoordinand(token, sentence)) return "renyou";
  // The parser's own VerbForm=Conv on *this* token is a direct signal that
  // it's being used as a converb (a manner adverbial like 博く modifying a
  // following verb, or a genuine converb-chained action like 參り) —
  // renyoukei either way. See `converbSuffix` for the further (て)/(nothing)
  // decision this pairs with at the render call sites.
  if (parseMorphFeatures(token.morph ?? "").VerbForm === "Conv") return "renyou";
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
  if (form === "izen" || form === "rentai" || form === "mizen") return "";
  if (parseMorphFeatures(token.morph ?? "").VerbForm !== "Conv") return "";
  if (nextToken?.lemma === "而") return "";
  if (conjClass && !renyoukeiEndsInISound(conjClass)) return "";
  return "て";
}

/** The conjugated okurigana (prefix + suffix, no kanji, no reading) for a
 * lexicon entry in the given form. Returns "" for a `fixedReading` entry
 * (which has no conjugation to apply — the whole word is invariant). */
export function conjugatedOkurigana(lex: LexiconEntry, form: ConjForm): string {
  if (!lex.conjClass) return "";
  return (lex.okuriganaPrefix ?? "") + conjugate(lex.conjClass, form);
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
 * かな repeat nothing, whatever the predicate is. */
export function repeatsPredicateCopula(token: Token, sentence: Sentence): boolean {
  if (sentenceFinalParticle(token.lemma) !== "なり") return false;
  const head = sentence.tokens.find((t) => t.id === token.head && t.id !== token.id);
  if (!head) return false;
  const conjClass = VERB_LEXICON[head.lemma]?.conjClass;
  return conjClass === "nari-keiyoudoushi" || conjClass === "tari-keiyoudoushi";
}

export function syntheticLexiconEntry(
  resolved: { conjClass?: ConjClass; reading?: string; okurigana?: string },
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

/** **Whether the parser calls this token a descriptive** — the one test two
 * 形容動詞 rules now run, so they cannot come apart.
 *
 * `Degree=Pos`, and `ADJ` beside it. The treebank does not use ADJ at all —
 * **0** tokens over `lzh_kyoto-sud-{train,dev,test}`'s 433,169 — and tags every
 * descriptive VERB or ADV with `Degree=Pos` instead; that feature and the
 * tagset's own descriptive class are the same set to within 31 tokens (all
 * 26,880 `v,動詞,描写,*` carry `Degree=Pos`; the 31 that carry it without being
 * 描写 are `v,副詞,程度,軽度`). The **parser**, unlike the gold treebank, does
 * emit ADJ — 12 tokens in the reader's own 酒蟲, one of them the 貧 that
 * `pinnedKeiyoudoushi` exists for — so `Degree=Pos` alone would miss the live
 * case. The two are read as one disjunction, exactly as `chosenOkurigana`
 * already reads them for the adjective conversion it applies to a stored
 * ending.
 *
 * `Degree=Equ` is refused with the tag: the comparison 如/奈 is tagged ADJ in
 * the reader's tree and is ごとし, not a 形容動詞, and it is the same feature
 * `predicativeComplementParticle` and `isComparativeYu` already key that sense
 * on.
 *
 * Asked by `pinnedKeiyoudoushi` below of a single pinned character, and by
 * `redupTariReading` in `readingResolver.ts` of every member of a reduplicated
 * span. Two rules naming the same class from the same evidence is exactly the
 * pair that must not drift, which is why the evidence is written once. */
export function isDescriptiveToken(token: Token): boolean {
  const degree = parseMorphFeatures(token.morph ?? "").Degree;
  return degree === "Pos" || (token.pos === "ADJ" && degree === undefined);
}

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
 * thing"), and it is live in the reader's own text: 僧愚之 has 愚 tagged VERB
 * `Degree=Pos` `v,動詞,描写,形質` with 之 as its `comp:obj`, pinned `Reading=ぐ`,
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
  if (!isDescriptiveToken(token) || hasObject(token, sentence)) return picked;
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
  const converbTe = conjClass && pickedForm ? converbSuffix(token, next, conjClass, pickedForm) : "";
  const okurigana =
    conjClass && pickedForm ? conjugatedOkurigana(lex!, pickedForm) + converbTe : picked.okurigana ?? "";
  const conjugatedWith = { form: pickedForm, conjClass, converbTe };

  // `extraEndingFor` returns the morph ending in preference to everything
  // else when a token has one, so a token that has one is simply not asked.
  if (endingForMorph(parseMorphFeatures(token.morph ?? ""))) return { okurigana, extra: "", ...conjugatedWith };
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
 * same question of, one step earlier and on the *modern* ending. */
function attestedSense(resolved: { conjClass?: ConjClass; reading?: string; okurigana?: string }, lemma: string) {
  if (resolved.conjClass) {
    return lexiconSensesByReading(lemma, resolved.reading).find(
      (sense) => sense.conjClass === resolved.conjClass && conjugatedOkurigana(sense, "shuushi") === resolved.okurigana,
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
 * rather than by oversight. */
function isCoordinateClauseHead(token: Token, root: Token | undefined, sentence: Sentence): boolean {
  if (!root) return false;
  // The first conjunct: the ROOT itself, when something is coordinated onto
  // it directly.
  if (token.id === root.id) {
    return sentence.tokens.some((t) => t.head === token.id && t.id !== token.id && t.dep === "conj:coord");
  }
  if (!NOMINAL_COORDINATION_DEPS.has(token.dep)) return false;
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
export function extraEndingFor(token: Token, root: Token | undefined, sentence: Sentence, isDenominalCompound = false): ConjugatedForm | null {
  const morphEnding = endingForMorph(parseMorphFeatures(token.morph ?? ""));
  if (morphEnding) return morphEnding;
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
      (token.id === root.id || hasSubject(token, sentence)) &&
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
    // an ending (see `isDenominalCompound`). `Degree=Pos` was the only way of
    // saying "and it is being predicated", because the parser tags a
    // descriptive word VERB with that feature — but it also has a plain `ADJ`
    // tag and uses it for exactly this: 豪 and 富 in 酒蟲's 而家豪富 come back
    // ADJ with a *noun* xpos (n,名詞,描写,態度) and no `Degree` at all, which
    // is the Sino-Japanese denominal this branch was written for. An ADJ that
    // really is Japanese adjective morphology carries `Degree=Pos` (長, with a
    // verb xpos) and was already matching, so admitting the tag adds only the
    // denominal case.
    const morph = parseMorphFeatures(token.morph ?? "");
    if (isDenominalCompound && (morph.Degree === "Pos" || token.pos === "ADJ")) return COPULA;
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
export type SelectedSlot = "primary" | "mizen" | "renyou";

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
  // `teOrShite` reads しかも. Then the predicate closes: 臣、而君明 is
  // 臣なり、しかも君は明し, not 臣にして、しかも君は明し.
  //
  // **The argument is the doubled connective, and it is this file's own.**
  // にして is not a bare 連用形 with a て supplied by whatever follows — the
  // して is the copula's own way of continuing, written into `COPULA.renyou`
  // for exactly that reason, and `precedingFormSuppliesShite` stands a
  // following 而 down over it rather than let a second one be written
  // (王仁人にしてて). しかも is the one case that stand-down deliberately does
  // not cover: `teOrShite` exempts a mark-preceded 而 from it, on the sound
  // ground that しかも is a word read *on* 而 and not an ending added to what
  // precedes, so standing down there would delete the word rather than avert
  // a doubling. That exemption leaves the doubling itself standing —
  // "being a vassal, and moreover…" — and this is the other end of it: the
  // nominal takes the 終止形 it would have taken with no conjunct at all, and
  // しかも carries the sentence on from there.
  //
  // **Bounded to a 連用形 that carries its own connective**, which is what
  // `renyou.endsWith("して")` asks and is the whole of the argument above. A
  // verb before the same しかも keeps its 連用形 (see `decideConjForm`'s own 而
  // branch, and the 輒半種黍；而家豪富 reading its note records): a bare 連用形
  // is 連用中止法 and contains no connective, so nothing is doubled there. The
  // same goes for the synthesized endings that are not the copula — 使役's
  // しめ is 下二段 連用中止法 exactly as a verb's is, and 王令民戰、而歸 keeps
  // 民をして戰はしめ、しかも歸る. The asymmetry is between a form that carries
  // its own して and one that does not, and not between word classes.
  //
  // `EXISTENCE` is untouched: ラ変's 連用形 is あり, which carries no connective
  // of its own, so a quantity predication before a しかも has nothing to be
  // stood down over and keeps the あり `isNumeralPredication` gave it. It is
  // also the same string as its 終止形, so which of the two this returns was
  // once invisible on the page — no longer, since `synthesizedRenyouTe` reads
  // the slot rather than the string and writes ありて for the 連用形.
  //
  // `precededBySourcePunctuation` is asked directly rather than `teOrShite`,
  // and has to be: `teOrShite` consults `precedingFormSuppliesShite`, which
  // calls back into this function for this very token, and the two would
  // recur without end. The mark is the whole of what decides しかも in the
  // case at issue anyway — `teOrShite`'s other route to it is reachable only
  // where the stand-down above has already fired, i.e. where no しかも is
  // written at all.
  const token = plan.sentence.tokens.find((t) => t.id === tokenId);
  const beforeShikamo =
    !!form.renyou &&
    form.renyou.endsWith(CONVERB_CONNECTIVE) &&
    !!next &&
    next.lemma === "而" &&
    precededBySourcePunctuation(plan.sentence, next.id);
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
  // same `conjunct` and stood down over the same しかも, so a noun in this shape
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
 * withholds a て that nothing else supplied. `teOrShite` has no resolver to
 * ask, and giving it one to close that gap would put a reading lookup inside a
 * decision that is otherwise made from the tree alone. */
function precedingFormSuppliesShite(plan: ReadingPlan, tokenId: number): boolean {
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
  const form = extraEndingFor(prev, findRoot(plan.sentence), plan.sentence);
  return form === COPULA && selectForm(form, plan, prev.id) === COPULA.renyou;
}
