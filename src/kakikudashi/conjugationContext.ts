import type { Sentence, Token } from "../parse/types.ts";
import type { ReadingPlan } from "../kundoku/types.ts";
import { conjugate, type ConjForm, type ConjClass } from "./classicalConjugation.ts";
import {
  COPULA,
  DESIDERATIVE,
  endingForMorph,
  NECESSITY,
  NEGATION,
  CAUSATIVE,
  PASSIVE_RU,
  PASSIVE_RARU,
  parseMorphFeatures,
  POTENTIAL,
  SURU,
  type ConjugatedForm,
} from "./bungoConjugation.ts";
import { VERB_LEXICON, type LexiconEntry } from "./verbLexicon.ts";

/** POS tags that need an inserted copula when a sentence's root has no
 * explicit copula/auxiliary token — Literary Chinese routinely has bare NP
 * predicates (e.g. 君子 for "[it] is a gentleman") with no token realizing
 * the "is". Shared so the kundoku panel can show the same synthesized なり
 * the kakikudashi generator inserts, even though it has no source token. */
export const NOMINAL_PREDICATE_POS = new Set(["NOUN", "PROPN", "PRON"]);

export function findRoot(sentence: Sentence): Token | undefined {
  return sentence.tokens.find((t) => t.dep === "ROOT" || t.head === t.id);
}

/** Pre-verbal negation adverbs — `reorderEngine.ts`'s `classifyToken`
 * already postposes these past their verb (不知 -> 知らず, not ずしら). Both
 * the kundoku panel (`KundokuView.ts`) and the kakikudashibun generator
 * need to recognize the same tokens as negation triggers, hence shared
 * here rather than duplicated. */
export const NEGATION_LEMMAS = new Set(["不", "未", "弗", "勿"]);

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
  const prev = sentence.tokens.find((t) => t.id === tokenId - 1);
  return !!prev && prev.dep === "punct";
}

export function teOrShite(plan: ReadingPlan, tokenId: number): string {
  const prev = previousMeaningfulToken(plan, tokenId);
  const afterNegation = !!prev && NEGATION_LEMMAS.has(prev.lemma) && prev.dep === "mod";
  if (afterNegation) return "して";
  if (precededBySourcePunctuation(plan.sentence, tokenId)) return "しかして";
  if (prev && parseMorphFeatures(prev.morph ?? "").Degree === "Pos") return "て";
  const token = plan.sentence.tokens.find((t) => t.id === tokenId);
  const governor = token && plan.sentence.tokens.find((t) => t.id === token.head);
  const bridgesToStativeCoord =
    token?.dep === "mod" && governor?.dep === "conj:coord" && parseMorphFeatures(governor.morph ?? "").Degree === "Pos";
  return bridgesToStativeCoord ? "しかして" : "て";
}

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

function namingComplementParticle(token: Token, governor: Token | undefined): string | undefined {
  if (!governor || !NAMING_VERB_LEMMAS.has(governor.lemma)) return undefined;
  if (token.dep !== "comp:obj" && token.dep !== "comp:pred") return undefined;
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
 * sites in `generator.ts`/`KundokuView.ts`. */
export function isNamingUse(token: Token, sentence: Sentence): boolean {
  if (!NAMING_VERB_LEMMAS.has(token.lemma)) return false;
  return sentence.tokens.some(
    (t) =>
      t.head === token.id &&
      (t.dep === "comp:obj" || t.dep === "comp:pred") &&
      (t.pos === "NOUN" || t.pos === "PROPN"),
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

export function caseParticleFor(token: Token, sentence: Sentence): string | undefined {
  const governor = sentence.tokens.find((t) => t.id === token.head);
  const naming = namingComplementParticle(token, governor);
  if (naming) return naming;
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
 * 飲む肉を食ふ. In SUD every later conjunct hangs off the *first*, so the
 * chain is that head plus its coordinated children, and the final member is
 * simply the one latest in the sentence.
 *
 * Both ends must be verbal. `parataxis` in particular is a mixed relation —
 * it also links a quotative frame to what it introduces, and an appositive
 * clause to its host — and demoting a predicate to 連用形 there would be
 * wrong; requiring a verb on both ends keeps this to chains of predicates.
 * (The commonest such frame, 子曰, never reaches here anyway: 曰 is a
 * `fixedReading` lexicon entry, which short-circuits ahead of any
 * conjugation decision.) */
export function isNonFinalCoordinand(token: Token, sentence: Sentence, conjClass?: ConjClass): boolean {
  // Verbs only, per the rule this implements. Whether a token is being used
  // adjectivally is not recoverable from the parse here — the parser leaves
  // FEATS empty on these tokens (measured on 愛人利物 and 飲酒食肉 alike),
  // so `Degree=Pos` is no help and the conjugation class is the only
  // evidence available. A non-final *adjective* conjunct does take 連用形
  // in classical Japanese (山高く水長し), so this exclusion is a narrowing
  // to what was asked for, not a claim that adjectives behave differently.
  if (conjClass && ADJECTIVE_CONJ_CLASSES.has(conjClass)) return false;
  const isVerbal = (t: Token) => t.pos === "VERB" || t.pos === "AUX";
  if (!isVerbal(token)) return false;

  // A chain is identified from its head, which is either this token's own
  // coordination governor or — when this token heads the chain — itself.
  const headId = COORDINATION_DEPS.has(token.dep) ? token.head : token.id;
  const head = sentence.tokens.find((t) => t.id === headId);
  if (!head || !isVerbal(head)) return false;

  const members = [
    head,
    ...sentence.tokens.filter((t) => t.head === headId && t.id !== headId && COORDINATION_DEPS.has(t.dep) && isVerbal(t)),
  ];
  if (members.length < 2 || !members.some((m) => m.id === token.id)) return false;
  return token.id !== Math.max(...members.map((m) => m.id));
}

export function decideConjForm(token: Token, nextToken: Token | undefined, sentence: Sentence, conjClass?: ConjClass): ConjForm {
  // Negation first: 不 governs the form of the verb it negates regardless
  // of where that verb sits in a chain (學不厭教不倦 — 厭 is non-final, but
  // takes 未然形 for the ず that follows, not 連用形).
  if (nextToken && NEGATION_LEMMAS.has(nextToken.lemma) && nextToken.dep === "mod") return "mizen";
  // しむ and る/らる both attach to a mizenkei, so the predicate a 使役 or
  // 受身 governs takes that form wherever it sits — 戰 under 使 is 戰は,
  // not 戰く.
  if (isCausedOrPassivePredicate(token, sentence)) return "mizen";
  if (nextToken && nextToken.lemma === "而") return "renyou";
  // Deliberately not paired with `converbSuffix`'s て: a coordination chain
  // links its members with a bare 連用形 (酒を飲み肉を食ふ), and appending
  // て here would turn every chain into a converb sequence.
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
 * companion, since renyoukei alone is a bare stem (博く), not yet the
 * converb (博くて): whenever nothing else already supplies that connecting
 * て, this does. Two cases:
 *  - The following token in reading order literally *is* 而 (博學而日參省
 *    — 博 immediately precedes 而): 而 renders its own て/して/しかして
 *    right there (see `teOrShite`), so appending another here would double
 *    it up (博くてて). No suffix in this case.
 *  - Otherwise (參 in the same sentence — its own VerbForm=Conv, but
 *    nothing else follows it with its own connecting て): this token is
 *    the *only* thing that can supply the converb's て, so it does
 *    (參り→參りて). Bounded to VerbForm=Conv specifically — the *other*
 *    renyoukei triggers in `decideConjForm` (a still-pending mod@lmod
 *    child, `isStativeSubjectModifier`, a copula chaining onward) each
 *    already have their own token or particle providing whatever needs to
 *    follow, and must *not* also get a bare て glued on. */
export function converbSuffix(token: Token, nextToken: Token | undefined): string {
  if (parseMorphFeatures(token.morph ?? "").VerbForm !== "Conv") return "";
  return nextToken?.lemma === "而" ? "" : "て";
}

/** The conjugated okurigana (prefix + suffix, no kanji, no reading) for a
 * lexicon entry in the given form. Returns "" for a `fixedReading` entry
 * (which has no conjugation to apply — the whole word is invariant). */
export function conjugatedOkurigana(lex: LexiconEntry, form: ConjForm): string {
  if (!lex.conjClass) return "";
  return (lex.okuriganaPrefix ?? "") + conjugate(lex.conjClass, form);
}

/** True for a token that heads its own clause the way the sentence's ROOT
 * does — the ROOT itself, or a `conj:coord` sibling coordinated *directly*
 * onto it (生而神靈，弱而能言，... — each of 神靈/能/徇/敦/聰 is its own
 * clause's predicate, parallel to 生/弱/幼/長/成). Deliberately restricted to
 * direct root siblings, not `conj:coord` at any depth: a `conj:coord`
 * nested inside some other complement (人皆可以為堯舜's 舜, coordinate with
 * 堯 as a shared *nominal* complement of 為, not its own predication) is a
 * different construction entirely and must not pick up a synthesized
 * ending of its own. */
function isCoordinateClauseHead(token: Token, root: Token | undefined): boolean {
  return !!root && token.dep === "conj:coord" && token.head === root.id;
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

/** The extra ending a token needs beyond its own reading/okurigana, if
 * any — either a morph-driven auxiliary (potential/desiderative/passive/
 * etc., from the token's own `morph` field) or, for a predicate with no
 * such morph, a synthesized ending Literary Chinese leaves implicit:
 *
 *  - A bare nominal at the sentence ROOT (君子, "[it] is a gentleman") is an
 *    equative "X is Y" predication and gets なり — well-established, see
 *    the 亦君子なり anchor.
 *  - A `conj:coord` sibling coordinated directly onto the ROOT (see
 *    `isCoordinateClauseHead`) is a parallel clause in its own right, not
 *    an equative predication of the *sentence's* subject: a bare NOUN/
 *    PROPN/PRON one is read as a denominal action parallel to the other
 *    coordinate verbs, and gets す, not なり (生而神靈 -> 生まれて神靈す, not
 *    the equative 神靈なり — it isn't asserting "X is spirit-and-numen").
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
    token.id === root.id &&
    NOMINAL_PREDICATE_POS.has(token.pos) &&
    !hasExplicitCopulaParticle(root, sentence) &&
    !classicalAdjectiveRootReading(root)
  ) {
    return COPULA;
  }
  if (isCoordinateClauseHead(token, root)) {
    if (isDenominalCompound && parseMorphFeatures(token.morph ?? "").Degree === "Pos") return COPULA;
    if (NOMINAL_PREDICATE_POS.has(token.pos)) return SURU;
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
  const beforeNegation = !!next && NEGATION_LEMMAS.has(next.lemma) && next.dep === "mod";
  return beforeNegation && form.mizen ? form.mizen : form.primary;
}
