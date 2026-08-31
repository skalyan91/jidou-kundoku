import type { Sentence, Token } from "../parse/types.ts";
import type { ReadingPlan } from "../kundoku/types.ts";
import { conjugate, type ConjForm, type ConjClass } from "./classicalConjugation.ts";
import {
  COPULA,
  DESIDERATIVE,
  endingForMorph,
  EXISTENCE,
  NECESSITY,
  NEGATION,
  CAUSATIVE,
  PASSIVE_RU,
  PASSIVE_RARU,
  parseMorphFeatures,
  POTENTIAL,
  renyoukeiEndsInISound,
  sentenceFinalParticle,
  SENTENCE_FINAL_PARTICLE_LEMMAS,
  type ConjugatedForm,
} from "./bungoConjugation.ts";
import {
  attestedSenseByModernSpelling,
  FIXED_EXPRESSION_MAX_LENGTH,
  FIXED_EXPRESSIONS,
  lexiconSensesByReading,
  VERB_LEXICON,
  type LexiconEntry,
} from "./verbLexicon.ts";
import { isBracket, isOpeningBracket } from "../parse/punctuation.ts";
// One-way in the type graph, two-way at module level: `depClassification.ts`
// already imports `AUXILIARY_LEMMAS` from here. Both directions are consumed
// only from inside function bodies (never at module-evaluation time), so the
// cycle resolves the way ESM cycles between pure-function modules do.
import { classifyToken, isDistributivePostpose, isGenitiveComplement, isSpeechQuoteComplement } from "../kundoku/depClassification.ts";
import { isRereadUse, rereadGovernedForm, rereadNegates } from "./rereadCharacters.ts";
import { chosenReadingText } from "../reading/chosenReading.ts";
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

/** Modal auxiliary lemmas that render as a pure-kana conjugating auxiliary
 * (their own kanji is dropped in kakikudashibun, same as negation, and
 * their reading is treated as okurigana — not furigana — in the kundoku
 * panel, since they're grammatical markers rather than an independent
 * word's dictionary reading). Each conjugates via `selectForm`, so 不可
 * correctly chains to べからず (可's own mizenkei べから + ず) instead of
 * naively concatenating a bare "べし"+ず. Bounded to the clearest,
 * unambiguous cases — 可/能 (potential), 須/當/應/応 (necessity) — not a
 * general modal-auxiliary classifier. */
export const AUXILIARY_LEMMAS: Record<string, ConjugatedForm> = {
  可: POTENTIAL,
  能: POTENTIAL,
  須: NECESSITY,
  當: NECESSITY,
  応: NECESSITY,
  應: NECESSITY,
  欲: DESIDERATIVE,
  // 使役. These four behave exactly as the modals above do — their own
  // kanji is dropped and they render as a conjugating auxiliary after the
  // predicate they govern — and they bring one thing more: the causee
  // takes をして rather than a plain を (see `caseParticleFor`).
  使: CAUSATIVE,
  令: CAUSATIVE,
  教: CAUSATIVE,
  遣: CAUSATIVE,
};

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
 * rather than an ordinary object. */
export const CAUSATIVE_LEMMAS: ReadonlySet<string> = new Set(["使", "令", "教", "遣"]);

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
/** Whether this token is the predicate a 使役 or 受身 auxiliary governs,
 * and so must be in 未然形 for the しむ / る / らる that follows it. */
export function isCausedOrPassivePredicate(token: Token, sentence: Sentence): boolean {
  const governor = sentence.tokens.find((t) => t.id === token.head && t.id !== token.id);
  if (!governor) return false;
  if (CAUSATIVE_LEMMAS.has(governor.lemma) && (token.dep === "comp:obl" || token.dep === "comp:aux")) return true;
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
  // Ahead of everything else: a nominal predicate handing on has already
  // written the して as part of its own にして, and 而 adding a second one
  // gave 王仁人にしてて. See `precedingCopulaSuppliesShite`.
  if (precedingCopulaSuppliesShite(plan, tokenId)) return { okurigana: "" };
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

const SHIKAMO: EruConnective = { reading: "しか", okurigana: "も" };

/** Case particles that attach directly after certain SUD relations,
 * regardless of how the token itself is rendered (kanji-retained, kana
 * reading, or conjugated) — kundoku conventionally supplies these even
 * though nothing in the source text realizes them. Bounded to the
 * clearest, least ambiguous relations rather than a full case-grammar
 * pass: `comp:obj` always wants を; `mod@tmod`/`mod@lmod` (temporal/
 * locative adverbials) want に. Plain `mod` is deliberately excluded — a
 * bare adverbial doesn't reliably take one particle in kundoku. */
const CASE_PARTICLE_FOR_DEP: Record<string, string> = {
  "comp:obj": "を",
  "mod@tmod": "に",
  "mod@lmod": "に",
  "comp:pred": "と",
};

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

/** This token's share of a lexicalised formula it stands inside — its reading
 * and its okurigana, already divided per character — or undefined for a token
 * that is not in one. See `FIXED_EXPRESSIONS` for the formulae and for why
 * 答へて曰く is remembered rather than derived.
 *
 * **Keyed on adjacent characters, and on nothing else.** Not on POS, not on
 * the dependency relation, and this is a deliberate judgement rather than an
 * oversight, so it is worth stating as one. The reader's own text has the
 * parser reading 劉答言 as a personal name — 答 comes back `PROPN`,
 * `NameType=Giv`, a `flat` of 劉 — and a formula that consulted the tag would
 * stand down there, on exactly the sentence it was asked for. The claim being
 * made is that 答 written immediately before 言 *is* 答へて言はく, in the same
 * way `findCompoundSpans` claims that two characters written side by side are
 * one word: a fact about the characters, which the tagging can be wrong about
 * without making it false. Compensating for a parser error would be reading
 * the tag and then discounting it; this never reads it.
 *
 * The narrowness is what makes that safe. To misfire, a text would need a
 * genuine name whose *last* character is 答 or 對, written with no mark
 * between it and an immediately following 曰 or 言 — and a reader meeting
 * 「…答曰…」 has no more evidence than this rule does. Neither character is a
 * common name element (both are ordinary verbs of replying), and the two-sided
 * adjacency is the whole test: a comma, a particle, or any other token between
 * them and the formula does not fire.
 *
 * Adjacency is in *source* order (`sentence.tokens`), not reading order, for
 * the same reason the formula is a fact about the characters: it is how they
 * are written that makes it one. Reading order is left alone — the two
 * characters are read in the order they stand, so nothing here moves a token
 * or changes what kunten are assigned. */
export function fixedExpressionPart(token: Token, sentence: Sentence): { reading: string; okurigana: string } | undefined {
  const index = sentence.tokens.indexOf(token);
  if (index < 0) return undefined;
  const key = (t: Token | undefined): string => t?.lemma || t?.text || "";
  // Each window of up to `FIXED_EXPRESSION_MAX_LENGTH` characters that ends at
  // or after this token and starts at or before it — i.e. every formula this
  // token could be any member of.
  for (let start = Math.max(0, index - FIXED_EXPRESSION_MAX_LENGTH + 1); start <= index; start++) {
    for (let length = index - start + 1; length <= FIXED_EXPRESSION_MAX_LENGTH; length++) {
      const window = sentence.tokens.slice(start, start + length);
      if (window.length !== length) break;
      const parts = FIXED_EXPRESSIONS[window.map(key).join("")];
      if (parts) return parts[index - start];
    }
  }
  return undefined;
}

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
 *    complete より directly (`yuReading`) — 取之於藍 -> 藍より取り, never
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
 * down closes on its own governed clause, not on this one. */
function readsLastInItsSubtree(token: Token, sentence: Sentence): boolean {
  return !sentence.tokens.some((child) => {
    if (child.head !== token.id || child.id === token.id || child.dep === "punct") return false;
    if (isRereadUse(child, sentence)) return true;
    const movement = classifyToken(child, token);
    if (movement === "postpose") return true;
    return movement === "no-invert" && child.id > token.id;
  });
}

/** と on the predicate a verb of speech reports — 劉答言無 is 劉答へて「無し」と
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
 * condition. */
export function isUnquotedSpeechComplement(token: Token, sentence: Sentence): boolean {
  if (!isSpeechComplement(token, sentence)) return false;
  const governor = sentence.tokens.find((t) => t.id === token.head && t.id !== token.id);
  if (isSpeechQuoteComplement(token, governor, sentence)) return false;
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

  // Ahead of the topicalization heuristics below, which otherwise claim the
  // same token: 楚 in 楚人有… is a `mod` carrying `Case=Loc` whose governor
  // is the sentence's `subj`, which is pattern b's exact signature, and it
  // was coming out 楚は人…有り. A name sitting on the noun it names is a
  // genitive first — the fronted-topic reading is what's left for a modifier
  // that *isn't* one.
  const genitive = genitiveNoParticle(token, sentence);
  if (genitive) return genitive;
  if (governor?.pos === "ADP" || (governor?.lemma === "之" && governor.dep === "mod")) {
    // The adposition itself (於 -> に via `yuReading`) already carries the
    // complete case marking once it inverts before its own governor; its
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
  if (governor && CAUSATIVE_LEMMAS.has(governor.lemma) && token.dep === "comp:obj") return "をして";

  // 如/若 in a comparison take their standard in に — 不如 reads
  // 〜に如かず. Bounded to the comparative use, which is what a `comp:obj`
  // under these two lemmas is; 如 also heads the 〜がごとし simile, where
  // the character is re-read and never reaches here.
  if (governor && (governor.lemma === "如" || governor.lemma === "若") && governor.pos === "VERB" && token.dep === "comp:obj") {
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

  // A predicate standing in an object slot is nominalized, and takes を on top
  // of the 連体形 `decideConjForm` gives it — 不得飲 -> 飲むを得ず. See
  // `isNominalizedObjectPredicate`, which both halves of the rule share.
  // Below the 如/若 branch above, which supplies に for its own comparative
  // complement (惡酒如仇 -> 仇するに如く) and must not be overridden.
  if (isNominalizedObjectPredicate(token, sentence)) return "を";

  if (NOMINAL_PREDICATE_POS.has(token.pos)) {
    const particle = CASE_PARTICLE_FOR_DEP[token.dep];
    if (particle) return particle;
  }

  if (token.dep === "subj") {
    const root = findRoot(sentence);
    if (root && root.lemma in AUXILIARY_LEMMAS) return "は";

    const alreadyHasItsOwnTopic = sentence.tokens.some(
      (t) => t.head === token.id && t.dep === "mod" && parseMorphFeatures(t.morph ?? "").Case === "Loc",
    );
    if (isTopicalizedAdjective(token, sentence) && !alreadyHasItsOwnTopic) return "は";
  }

  if (token.dep === "mod" && parseMorphFeatures(token.morph ?? "").Case === "Loc" && governor?.dep === "subj") {
    return "は";
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
  if (token.dep === "subj" && governor?.dep === "comp:obj" && parseMorphFeatures(governor.morph ?? "").Case === "Loc") {
    return "は";
  }

  return undefined;
}

/** True for 中 used verbally ("to hit, to conform to") but mistagged NOUN by
 * the parser — its own dep+morph signature (comp:obj carrying Case=Loc,
 * itself a further predicate's locative complement) is unambiguous even
 * though the POS tag isn't: 其曲中規 -> ...規を中る, not bare 中を with no
 * conjugation at all. Scoped to this one lemma+signature rather than a
 * blanket NOUN/VERB override, since 中 as a genuine NOUN ("middle") is very
 * common elsewhere and must *not* conjugate. */
export function isMistaggedLocativeVerb(token: Token): boolean {
  return token.lemma === "中" && token.dep === "comp:obj" && parseMorphFeatures(token.morph ?? "").Case === "Loc";
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
 * 斯 4, 子 4, 甫 2, 諸 1, 诸 1. Three are admitted here and the rest are held
 * out, each for a reason the counts state:
 *
 *  - **乎 and 焉** are in `SENTENCE_FINAL_PARTICLES`, and both panels take
 *    their discourse branch *ahead* of the lexicon dispatch this rule feeds.
 *    A suffix standing last (34 of 乎's 102, 10 of 焉's 36) would be read as
 *    the particle and one standing medially as タリ — the same character
 *    conjugating or not according to where it fell, which is worse than not
 *    covering it. 乎 fails on its own evidence besides: its commonest
 *    suffix-tagged bigrams are 嗟乎 (ああ) and 惡乎 (いづくにか), neither a
 *    形容動詞.
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
 * The three that remain cover 519 of the 654 suffix-tagged tokens, and their
 * adjacent bigrams are the paradigm cases: 喟然, 慨然, 忿然, 愕然, 茫然, 卒然;
 * 勃如, 躩如, 翕如; 莞爾, 率爾, 鏗爾. JMdict independently files 愕然, 突如,
 * 莞爾, 卒然, 躍如 and the rest as `'taru' adjective` — corroboration, and
 * deliberately *not* a condition (see `tariSuffixReading`). */
export const TARI_SUFFIX_CHARS: ReadonlySet<string> = new Set(["然", "如", "爾"]);

/** POS tags a タリ suffix may attach to. Read off the same survey: the token
 * immediately before a suffix-tagged 然 is VERB 290 / ADV 128 / NOUN 8 (and
 * PUNCT 4 — the clause-initial 然 excluded by the `unk` test below); before
 * 如, VERB 68 / NOUN 6; before 爾, VERB 12 / ADV 1. PROPN and ADJ ride along
 * as the tags this parser uses for the same descriptive words elsewhere. */
const TARI_STEM_POS: ReadonlySet<string> = new Set(["VERB", "ADV", "NOUN", "PROPN", "ADJ"]);

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
): LexiconEntry | undefined {
  if (isTariSuffix(token)) {
    return resolved.beatsLexicon ? syntheticLexiconEntry(resolved, token.lemma) : undefined;
  }
  if (!usesLexiconEntry(token)) return undefined;
  return resolved.beatsLexicon ? syntheticLexiconEntry(resolved, token.lemma) : VERB_LEXICON[token.lemma];
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
 * rather than guessed into this set. */
const LOCATIVE_GOVERNOR_LEMMAS = new Set(["坐", "居", "在", "戰", "戦", "處", "処"]);

/** 於 always inverts before its governor now (see `depClassification.ts`'s
 * `INVERT_DEPS`), landing in the same pre-head adjunct position regardless
 * of which of these senses applies. より is the default — it covers both a
 * stative predicate's comparison (藍より青し, "bluer *than* indigo") and a
 * plain action verb's source (取之於藍 -> 藍より取り, "takes it *from*
 * indigo"), which together cover every case this app's own seed sentences
 * exercise — with `LOCATIVE_GOVERNOR_LEMMAS` overriding it to おいて for the
 * bounded set of verbs whose 於-complement is a bare location instead (see
 * that set's own doc for why this can't be derived from the parse tree at
 * all, only from the governing verb's own lexical meaning). Always routed
 * through the okurigana slot, never furigana — 於 is a grammatical marker,
 * not an independent word's dictionary reading, same as every other
 * function word in this app. */
export function yuReading(token: Token, sentence: Sentence): string | undefined {
  if (token.lemma !== "於") return undefined;
  const governor = sentence.tokens.find((t) => t.id === token.head);
  return governor && LOCATIVE_GOVERNOR_LEMMAS.has(governor.lemma) ? "おいて" : "より";
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

/** The adjective and adjectival-noun paradigms, as opposed to the verb
 * ones — see `isNonFinalCoordinand`, which applies only to verbs. */
const ADJECTIVE_CONJ_CLASSES: ReadonlySet<ConjClass> = new Set<ConjClass>([
  "ku-keiyoushi",
  "shiku-keiyoushi",
  "nari-keiyoudoushi",
  "tari-keiyoudoushi",
]);

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
 * which short-circuits ahead of any conjugation decision.) */
export function isNonFinalCoordinand(
  token: Token,
  sentence: Sentence,
  conjClass?: ConjClass,
  /** Ask about a token that is not itself a verb. A *nominal* predicate
   * chains exactly as a verbal one does — 王仁人にして智…, the 人 handing on
   * to the 智 coordinated onto it — and the verbs-only gate below, which is
   * about which tokens `decideConjForm` may demote, was silently answering
   * "no" for every synthesized copula and existence ending `selectForm` asks
   * about. The chain is still walked verb-to-verb: only this token, the one
   * being asked about, is allowed not to be one. */
  nominalPredicate = false,
): boolean {
  // Whether the token being *asked about* is being used adjectivally is not
  // recoverable from the parse here — the parser leaves FEATS empty on these
  // tokens (measured on 愛人利物 and 飲酒食肉 alike), so `Degree=Pos` is no
  // help and the conjugation class is the only evidence available. A
  // non-final *adjective* conjunct does take 連用形 in classical Japanese
  // (山高く水長し), so this exclusion is a narrowing to what was asked for,
  // not a claim that adjectives behave differently. It says nothing about an
  // adjective standing at the *far* end of an edge: this parser tags a
  // descriptive word VERB with `Degree=Pos` (賢 in 王學而賢), so such a
  // conjunct is verbal here and has always been walked to.
  if (conjClass && ADJECTIVE_CONJ_CLASSES.has(conjClass)) return false;
  const isVerbal = (t: Token) => t.pos === "VERB" || t.pos === "AUX";
  if (!nominalPredicate && !isVerbal(token)) return false;

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
    const neighbours: { token: Token; edgeDep: string }[] = [];
    for (const mate of spanMates(current)) {
      if (COORDINATION_DEPS.has(mate.dep)) {
        const governor = byId.get(mate.head);
        if (governor && governor.id !== mate.id) neighbours.push({ token: governor, edgeDep: mate.dep });
      }
      for (const t of sentence.tokens) {
        if (t.head === mate.id && t.id !== mate.id && COORDINATION_DEPS.has(t.dep)) {
          neighbours.push({ token: t, edgeDep: t.dep });
        }
      }
    }
    for (const { token: neighbour, edgeDep } of neighbours) {
      if (!links(neighbour, edgeDep) || members.has(neighbour.id)) continue;
      members.add(neighbour.id);
      pending.push(neighbour);
    }
  }
  if (members.size < 2) return false;
  return token.id !== Math.max(...members);
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

export function decideConjForm(
  token: Token,
  nextToken: Token | undefined,
  sentence: Sentence,
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
  // The fourth of them: a predicate standing in an object slot, with no
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
  if (isNominalizedObjectPredicate(token, sentence)) return "rentai";
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
    if (isNonFinalCoordinand(token, sentence, conjClass)) return "renyou";
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
  // Not paired with `converbSuffix`'s て, by the reader's own decision: a
  // coordination chain links its members by 連用中止法, which is a bare 連用形
  // (酒を飲み肉を食ふ), and appending て here would turn every chain into a
  // converb sequence. See `converbSuffix`'s closing note.
  if (isNonFinalCoordinand(token, sentence, conjClass)) return "renyou";
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
export function converbSuffix(token: Token, nextToken: Token | undefined, conjClass: ConjClass | undefined): string {
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
 * be. A class is required up front rather than left to `attestedSense`
 * alone, because an on'yomi pick on a nominal carries no ending at all, and a
 * bare `undefined` okurigana matches every 形容動詞 sense in the lexicon —
 * which would conjugate a noun into なり.
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
export function pickedEnding(
  picked: { reading: string; okurigana?: string; conjClass?: ConjClass },
  token: Token,
  root: Token | undefined,
  plan: ReadingPlan,
  resolve: ReadingResolver,
): { okurigana: string; extra: string } {
  const lex = picked.conjClass ? syntheticLexiconEntry(picked, token.lemma) : undefined;
  const conjClass = lex?.conjClass;
  const next = nextMeaningfulToken(plan, token.id);
  // A governing 再読文字 dictates the form outright — 未 wants 未然形 whatever
  // else follows — and is consulted ahead of the ordinary context rules, the
  // same order both lexicon branches use. The resolver goes through with it
  // for the same reason too: a following 者 is attributive only under its
  // もの reading, and nothing but the resolver knows which of its two
  // readings this one took (see `isNominalizerAhead`).
  const okurigana = conjClass
    ? conjugatedOkurigana(lex!, rereadGovernedForm(token.id, plan) ?? decideConjForm(token, next, plan.sentence, conjClass, resolve)) +
      converbSuffix(token, next, conjClass)
    : picked.okurigana ?? "";

  // `extraEndingFor` returns the morph ending in preference to everything
  // else when a token has one, so a token that has one is simply not asked.
  if (endingForMorph(parseMorphFeatures(token.morph ?? ""))) return { okurigana, extra: "" };
  const extra = extraEndingFor(token, root, plan.sentence);
  return { okurigana, extra: extra ? selectForm(extra, plan, token.id) : "" };
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
    t.id !== root.id && (t.head === root.id ? t.dep === "clf" || t.pos === "NUM" : sentence.tokens.some((n) => n.id === t.head && n.head === root.id && n.pos === "NUM" && t.dep === "clf"));
  const parts = sentence.tokens.filter(inQuantity);
  return parts.reduce((last, t) => (t.id > last.id ? t : last), root);
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
      !hasExplicitCopulaParticle(token, sentence)
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

/** Picks a `ConjugatedForm`'s mizenkei variant when the token it attaches
 * to is immediately followed (in reading order) by a postposed negation,
 * falling back to the form's primary/shuushikei otherwise — the same
 * mizen-before-ず liaison rule `generator.ts` applies between pieces,
 * expressed here directly against the next token instead. */
export function selectForm(form: ConjugatedForm, plan: ReadingPlan, tokenId: number): string {
  const next = nextMeaningfulToken(plan, tokenId);
  const beforeNegation = !!next && isNegationUse(next);
  if (beforeNegation && form.mizen) return form.mizen;
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
  const token = plan.sentence.tokens.find((t) => t.id === tokenId);
  if (form.renyou && token && isNonFinalCoordinand(token, plan.sentence, undefined, true)) return form.renyou;
  return form.primary;
}

/** Whether the token immediately before `tokenId` in reading order is a
 * nominal predicate whose synthesized copula has already written 連用形
 * にして — in which case a 而 standing here has nothing left to write.
 *
 * にして *is* に plus して, and the して is what 而 would otherwise supply, so
 * the two would write it twice: 王仁人而智者 came out 王仁人にしてて. Decided
 * by asking `extraEndingFor` and `selectForm` the same questions about the
 * same token that produced the ending in the first place, so the answer
 * cannot drift from what was actually emitted — the same discipline
 * `repeatsPredicateCopula` follows for the 也 it suppresses. */
function precedingCopulaSuppliesShite(plan: ReadingPlan, tokenId: number): boolean {
  const prev = previousMeaningfulToken(plan, tokenId);
  if (!prev) return false;
  const form = extraEndingFor(prev, findRoot(plan.sentence), plan.sentence);
  return form === COPULA && selectForm(form, plan, prev.id) === COPULA.renyou;
}
