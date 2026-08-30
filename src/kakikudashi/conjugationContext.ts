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
  SURU,
  type ConjugatedForm,
} from "./bungoConjugation.ts";
import { lexiconSensesByReading, VERB_LEXICON, type LexiconEntry } from "./verbLexicon.ts";
import { isBracket, isSentenceFinalPunct } from "../parse/punctuation.ts";
// One-way in the type graph, two-way at module level: `depClassification.ts`
// already imports `AUXILIARY_LEMMAS` from here. Both directions are consumed
// only from inside function bodies (never at module-evaluation time), so the
// cycle resolves the way ESM cycles between pure-function modules do.
import { isDistributivePostpose, isGenitiveComplement } from "../kundoku/depClassification.ts";
import { rereadNegates } from "./rereadCharacters.ts";
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
  // Otherwise a sentence-final mark within this sentence still counts, and
  // the medial 、 still does not: it divides items inside one sentence and
  // leaves the clause running on into what follows.
  return !!prev && prev.dep === "punct" && isSentenceFinalPunct(prev.text);
}

export function teOrShite(plan: ReadingPlan, tokenId: number): string {
  const prev = previousMeaningfulToken(plan, tokenId);
  const afterNegation = !!prev && isNegationUse(prev);
  // A 再読文字 closing on the previous token negates it exactly as a postposed
  // 不 would, and is exactly as invisible to the test above — its ず is no
  // token of its own to be found in reading order. 未學禮而不知 reads
  // いまだ禮を學ばずして知らず, and read ずて without this.
  const afterRereadNegation =
    !!prev &&
    (plan.rereadCloseIds.get(prev.id) ?? []).some((id) => rereadNegates(plan.sentence.tokens.find((t) => t.id === id)?.text ?? ""));
  if (afterNegation || afterRereadNegation) return "して";
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

export function caseParticleFor(token: Token, sentence: Sentence): string | undefined {
  const governor = sentence.tokens.find((t) => t.id === token.head);
  const naming = namingComplementParticle(token, governor);
  if (naming) return naming;

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
 * Every step must be verbal at both ends. `parataxis` in particular is a
 * mixed relation — it also links a quotative frame to what it introduces,
 * and an appositive clause to its host — and demoting a predicate to 連用形
 * there would be wrong; requiring a verb at both ends of each edge keeps
 * this to chains of predicates, and stops the transitive walk from
 * wandering out of one. (The commonest such frame, 子曰, never reaches here
 * anyway: 曰 is a `fixedReading` lexicon entry, which short-circuits ahead
 * of any conjugation decision.) */
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

  // The connected component of coordination edges containing this token,
  // reached from it in both directions: up to the conjunct it is coordinated
  // onto, and down to every conjunct coordinated onto it.
  const byId = new Map(sentence.tokens.map((t) => [t.id, t]));
  const members = new Set<number>([token.id]);
  const pending: Token[] = [token];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const neighbours: Token[] = [];
    if (COORDINATION_DEPS.has(current.dep)) {
      const governor = byId.get(current.head);
      if (governor && governor.id !== current.id) neighbours.push(governor);
    }
    for (const t of sentence.tokens) {
      if (t.head === current.id && t.id !== current.id && COORDINATION_DEPS.has(t.dep)) neighbours.push(t);
    }
    for (const neighbour of neighbours) {
      if (!isVerbal(neighbour) || members.has(neighbour.id)) continue;
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
  if (nextToken && nextToken.lemma === "而") {
    // Which form depends on which 而 this is. Plain て/して attaches to a
    // 連用形 and carries the clause on; しかして opens a *new* sentence, so
    // what precedes it has to close one — 終止形. The condition is the same
    // one `teOrShite` reads the character by, so the two cannot disagree
    // about the same 而, which they previously did: this returned 連用形
    // whatever followed.
    return precededBySourcePunctuation(sentence, nextToken.id) ? "shuushi" : "renyou";
  }
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
export function syntheticLexiconEntry(
  resolved: { conjClass?: ConjClass; reading?: string; okurigana?: string },
  lemma: string,
): LexiconEntry | undefined {
  const attested = attestedSense(resolved, lemma);
  if (attested) return attested;
  if (!resolved.conjClass) return undefined;
  return { conjClass: resolved.conjClass, reading: resolved.reading };
}

/** The modern okurigana a classical paradigm surfaces as, which is the
 * spelling KANJIDIC2 is written in — the inverse of the modern-to-classical
 * derivation `readingResolver.ts` performs, and the thing that lets an
 * attested sense be checked against the reading the resolver just produced.
 *
 * Every regular family collapses the same way it historically did: 四段
 * became 五段 with its 終止形 intact (は行's ふ alone modernizing to う, 習ふ
 * -> 習う), and both 二段 families became 一段, keeping their mizen vowel and
 * taking る (肥ゆ's え -> 肥える, 立つ's て -> 立てる, 起く's き -> 起きる).
 * The irregulars all ended up in -る too (見る, 来る, 有る), except ナ変's 死ぬ.
 * 形容動詞 have no okurigana of this kind at all and return undefined.
 *
 * Where this guesses wrong it fails *closed* — a sense whose modern spelling
 * doesn't match is simply not taken, leaving the caller exactly where it was
 * without one — which is why サ変 is given the する that covers 爲/為 rather
 * than the す that would also fit 為す. */
function modernOkurigana(sense: LexiconEntry): string | undefined {
  const conjClass = sense.conjClass;
  if (!conjClass) return undefined;
  const prefix = sense.okuriganaPrefix ?? "";
  if (conjClass === "ku-keiyoushi") return modernKana(prefix + "い");
  if (conjClass === "shiku-keiyoushi") return modernKana(prefix + "しい");
  if (conjClass === "nari-keiyoudoushi" || conjClass === "tari-keiyoudoushi") return undefined;
  if (conjClass.startsWith("kami-nidan-") || conjClass.startsWith("shimo-nidan-")) {
    return modernKana(prefix + conjugate(conjClass, "mizen") + "る");
  }
  if (conjClass.startsWith("yodan-")) return modernKana(prefix + conjugate(conjClass, "shuushi"));
  if (conjClass === "na-hen") return modernKana(prefix + "ぬ");
  return modernKana(prefix + "る");
}

/** 歴史的仮名遣い to 現代仮名遣い, for okurigana only.
 *
 * The lexicon is written historically throughout and KANJIDIC2 is written
 * modernly, so the two spellings have to be brought into one before they can
 * be compared at all. Everything in an okurigana is word-*medial* by
 * construction — the kanji is in front of it — which is exactly the position
 * the three regular mergers apply in, and which is why this is a fixed table
 * rather than the undecidable modern-to-historical direction
 * `classicalConjugation.ts` warns about (that direction is one-to-many; this
 * one is many-to-one, and only ever run forwards).
 *
 *  - ハ行転呼: medial は行 became わ行/あ行 (習ふ -> 習う, 与へる -> 与える,
 *    変はる -> 変わる, 生ひる -> 生いる);
 *  - ワ行: ゐ/ゑ/を merged into い/え/お (用ゐる -> 用いる, 植ゑる -> 植える);
 *  - 四つ仮名: ぢ/づ merged into じ/ず (恥ぢる -> 恥じる).
 *
 * Without this the three rows added with `EXTRA_SUFFIX_OF` could never match
 * anything: ワ行下二段's own mizen ゑ built 植ゑる where KANJIDIC2 has 植える,
 * so 王植樹 went on reading the modern 植える even with 植う in the lexicon. */
function modernKana(okurigana: string): string {
  return [...okurigana].map((kana) => MEDIAL_KANA_MERGERS[kana] ?? kana).join("");
}

const MEDIAL_KANA_MERGERS: Record<string, string> = {
  は: "わ", ひ: "い", ふ: "う", へ: "え", ほ: "お",
  ゐ: "い", ゑ: "え", を: "お",
  ぢ: "じ", づ: "ず",
};

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
 * identify the word, so nothing is claimed and the mechanical route stands. */
function attestedSense(resolved: { conjClass?: ConjClass; reading?: string; okurigana?: string }, lemma: string) {
  const candidates = lexiconSensesByReading(lemma, resolved.reading);
  if (resolved.conjClass) {
    return candidates.find(
      (sense) => sense.conjClass === resolved.conjClass && conjugatedOkurigana(sense, "shuushi") === resolved.okurigana,
    );
  }
  const matches = candidates.filter((sense) => modernOkurigana(sense) === resolved.okurigana);
  return matches.length === 1 ? matches[0] : undefined;
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
 *    onto one, 亦君子ず, with nothing to inflect. */
function isPredicationLicensed(sentence: Sentence, root: Token): boolean {
  for (const token of [...sentence.tokens].sort((a, b) => b.id - a.id)) {
    if (isBracket(token.text)) continue;
    if (token.dep === "punct") return true;
    break;
  }
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

/** Which token of a numeral predication the あり hangs off. Not the root, if
 * the root is the numeral and a classifier follows it: 人 in 弟子三千人 is a
 * `clf` child of 三千 and is read after it, so an ending emitted on the root
 * lands inside the quantity — 弟子三千あり人 — instead of after it. The
 * classifier is the last thing said, so it is what closes the sentence. */
function quantityPredicateCarrier(root: Token, sentence: Sentence): Token {
  const classifiers = sentence.tokens.filter((t) => t.head === root.id && t.id !== root.id && t.dep === "clf");
  return classifiers.length > 0 ? classifiers[classifiers.length - 1] : root;
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
    !hasExplicitCopulaParticle(root, sentence) &&
    !classicalAdjectiveRootReading(root) &&
    // The two rules run strictly in this order, and the order is the whole
    // of how they interact: `isPredicationLicensed` decides *whether* the
    // sentence gets a synthesized ending at all, and `isNumeralPredication`
    // decides only *which* one it gets once it has. So an unpunctuated
    // 弟子三千人 gets neither あり nor なり — it is a noun phrase, "three
    // thousand disciples", for the same reason an unpunctuated 君子 is one —
    // and 弟子三千人。 gets あり rather than なり.
    isPredicationLicensed(sentence, root)
  ) {
    if (isNumeralPredication(root, sentence)) {
      // Not necessarily on the root — see `quantityPredicateCarrier`.
      if (token.id === quantityPredicateCarrier(root, sentence).id) return EXISTENCE;
    } else if (token.id === root.id && NOMINAL_PREDICATE_POS.has(token.pos)) {
      return COPULA;
    }
  }
  if (isCoordinateClauseHead(token, root)) {
    if (isDenominalCompound && parseMorphFeatures(token.morph ?? "").Degree === "Pos") return COPULA;
    if (NOMINAL_PREDICATE_POS.has(token.pos)) {
      // A clause whose head is a particle is nominal, and takes なり rather
      // than the do-verb. 者 marks what the clause is *about* and realises
      // no predicate of its own, so the nominal hanging off it is the
      // predicate: 黃帝者、少典之子 says 黃帝 IS the son of Shaodian, not
      // that he does anything. Without this the same branch reached for す,
      // giving 少典の子す.
      //
      // That copula needs the same licence the ROOT branch above needs, and
      // it is the only one here that does: it is the identical inference — a
      // bare nominal read as a complete predication — reached through a 者
      // heading the clause rather than through the nominal itself, so an
      // unpunctuated 黃帝者、少典之子 is the noun phrase "Huangdi, the son of
      // Shaodian" and stops there. す is untouched, because a noun used
      // *verbally* as one clause of a chain is not a sentence ending in a
      // noun at all.
      if (root && PARTICLE_HEAD_POS.has(root.pos)) {
        return isPredicationLicensed(sentence, root) ? COPULA : null;
      }
      return SURU;
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
  return beforeNegation && form.mizen ? form.mizen : form.primary;
}
