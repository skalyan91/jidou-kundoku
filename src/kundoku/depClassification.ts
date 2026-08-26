import { AUXILIARY_LEMMAS } from "../kakikudashi/conjugationContext.ts";

export type InvertBehavior = "invert" | "no-invert";
export type MovementBehavior = InvertBehavior | "postpose";

/** The governor a token is being classified against — just enough of it
 * (lemma, for the speech-verb/以/genitive-之 exceptions; dep, for the
 * genitive-之 exception specifically, which needs to confirm 之 *itself* is
 * in its genitive use) to decide movement, without depClassification.ts
 * needing the full `Token` type or a tree-walk context of its own. `morph`
 * isn't read by any current exception here, but is kept on the shape since
 * callers pass a real `Token` through unchanged. */
export interface GovernorContext {
  lemma: string;
  dep: string;
  morph?: string;
}

/** SUD relations whose dependent must be read before its governor (the OV
 * jump a kundoku-ten marks). Everything else — including relations not in
 * this list at all — is left at its source-relative position.
 *
 * `mod@lmod` (a locative/source adjunct — 於/于/乎 + noun) is included
 * unconditionally, not just for a stative governor: a directionality count
 * over the modern-Japanese SUD-spaCy treebank (`assets_sud/ja-*.sud.conllu`,
 * ~175k scored tokens) shows the dependent lands before its head 99.5% of
 * the time for the general `mod` relation (and 100% for `comp:obj`,
 * `comp:obl`, `comp:pred`, `comp:aux`, `subj`, `det`) — natural Japanese is
 * essentially uniformly head-final outside of `punct`, `conj:coord`, and the
 * catch-all `unk` bucket. A plain-verb governor's locative adjunct (取之於
 * 藍's 於藍) is no exception to that: 藍に取り, not 取り藍において — the
 * previous trailing-after-a-plain-verb treatment (kept only for a
 * `Degree=Pos` governor to invert) was an unforced, un-evidenced narrowing
 * of an otherwise-uniform pattern. */
export const INVERT_DEPS: ReadonlySet<string> = new Set([
  "comp:obj",
  "comp:obl",
  "comp:obl@lmod",
  "comp:pred",
  "comp:aux",
  "comp@expl",
  "mod@lmod",
]);

/** Any `dep` not in `INVERT_DEPS` — including unrecognized labels — is
 * classified no-invert. This is a deliberate safety default: never invert on
 * a relation the model itself left underspecified. */
export function classifyDep(dep: string): InvertBehavior {
  return INVERT_DEPS.has(dep) ? "invert" : "no-invert";
}

/** Pre-verbal negation adverbs (不/未/弗/勿) precede their verb in Chinese
 * source order but are read as a post-verbal inflection in kundoku (不知 →
 * 知らず, not ずしら) — real kanbun convention marks this jump with レ点,
 * same as an ordinary INVERT pair, just in the opposite direction (the
 * dependent moves *after* its governor instead of before). This can't be
 * decided from `dep` alone (most `mod` adverbs, e.g. 亦, stay put), so it's
 * keyed on lemma. Needs broader empirical verification beyond these four —
 * flagged the same way as the plan's other empirically-uncertain relations. */
const POSTPOSE_LEMMAS: ReadonlySet<string> = new Set(["不", "未", "弗", "勿"]);

/** Modal auxiliaries (可/能/須/當/應/応/欲) read as a post-verbal auxiliary
 * in kundoku (可行 → 行くべし, not べし行く) — but empirically (live parses
 * of every modal construction tested, e.g. 可以已矣/水可以觀/民可使由之/
 * 人皆可以為堯舜), the modal itself is *never* a dependent that needs
 * moving: it's always the clause's own head (ROOT, or a coordinate-clause
 * head via `conj:coord`), with the verb it governs attached to *it* as
 * `comp:aux` — already an `INVERT_DEPS` member, which alone puts the verb
 * before the modal with no extra postpose step needed. An earlier version
 * of this file postposed these lemmas unconditionally (regardless of the
 * token's own `dep`), on the theory that which side of `comp:aux` ends up
 * the dependent was unconfirmed. That unconditional check never actually
 * fired for the intended construction (the modal is never anyone's kid),
 * and did fire — wrongly — the one place it could: 能 used as its own
 * coordinate predicate (弱而能言 "weak, yet able to speak", 能 tagged
 * `conj:coord`, not a preverbal modifier at all), postposing 能 itself and
 * corrupting the postpose group's representative-token bookkeeping enough
 * to leave a stray レ点 on the unrelated 而. Removed rather than re-scoped:
 * there is no observed construction left for it to handle. */

/** 雖 ("although") precedes the clause it scopes over in Chinese source
 * order but reads *after* it in kundoku, as と…雖も (雖有槁暴 -> 槁暴ありと
 * いえども, not いえども槁暴あり) — the same pre-to-post flip as negation and
 * the modal auxiliaries above, just for a concessive-clause marker instead
 * of a verb-level one. Bounded to this one unambiguous lemma. */
const POSTPOSE_CONCESSIVE_LEMMAS: ReadonlySet<string> = new Set(["雖"]);

/** True when `token` is a concessive postpose marker (雖) — exported so
 * `reorderEngine.ts` can mark the token immediately preceding it (once
 * postposed) as needing a trailing ト: real kundoku suffixes と onto the
 * *complement* 雖 scopes over (槁暴あり**と**いえども), not onto 雖's own
 * reading (see `ReadingPlan.quoteEndIds`, which this reuses). */
export function isConcessivePostpose(token: { dep: string; lemma: string }): boolean {
  return token.dep === "mod" && POSTPOSE_CONCESSIVE_LEMMAS.has(token.lemma);
}

/** Verbs of speech (曰/云 — "to say") — the one class of governor whose
 * *reported-speech* complement does not invert like an ordinary object/
 * predicate does. Real kanbun reads 子曰：「...」 straight through left to
 * right (曰く, then the quote), never reordering the quote before the verb
 * the way 之を知る would invert 之 before 知る — a speech verb's comp:obj/
 * comp:pred is the thing said, not an ordinary complement, *when* it's
 * actually a quoted clause. The same governor also takes a plain naming
 * complement (名曰軒轅, "[his] name was Xuanyuan" — not a quotation at all),
 * which behaves like an ordinary complement instead: see
 * `isSpeechQuoteComplement`'s own POS check for how the two are told apart.
 * Bounded to the two unambiguous "say" verbs, not e.g. 謂 (which also means
 * "to call X Y", not always direct quotation). */
const SPEECH_VERB_LEMMAS: ReadonlySet<string> = new Set(["曰", "云"]);

/** True when `token` is the *quoted* complement of a speech verb — see
 * `SPEECH_VERB_LEMMAS` — as opposed to that same governor's plain naming
 * complement (名曰軒轅), which inverts and takes と/を like any other
 * comp:obj/comp:pred instead (see `conjugationContext.ts`'s
 * `namingComplementParticle`). A quoted clause's own carrier token is
 * always the clause's predicate (VERB — 子曰習之's carrier is 習, "[he]
 * studies"); a naming complement's carrier is the name itself (NOUN/
 * PROPN — 軒轅). Excluding NOUN/PROPN is what actually distinguishes them,
 * not the dep alone: both uses land on the same comp:obj/comp:pred
 * relations, and this parser has no dedicated "this is a quotation" tag.
 * Exported separately from `classifyToken` so `reorderEngine.ts` can also
 * use it to find *which* children need their reading-order subtree's last
 * token marked as the end of a quote (for the trailing ト okurigana — see
 * `ReadingPlan.quoteEndIds`). */
export function isSpeechQuoteComplement(token: { dep: string; pos: string }, governor: GovernorContext | undefined): boolean {
  return (
    !!governor &&
    SPEECH_VERB_LEMMAS.has(governor.lemma) &&
    (token.dep === "comp:obj" || token.dep === "comp:pred") &&
    token.pos !== "NOUN" &&
    token.pos !== "PROPN"
  );
}

/** 以 attached directly to a modal auxiliary (可以, 得以, 足以 — "can/may",
 * lit. "able by-means-of") is part of a fused two-word modal, not an
 * ordinary adverbial with its own independent object: real kundoku reads
 * it immediately before whatever the modal's own complement is (可以已 ->
 * 以て已むべし, もって已む, not 已むべしもって). The parser tags this 以 with
 * whatever underspecified relation it lands on (often `unk`) since there's
 * no single-word label for "part of a compound modal" — so this is keyed
 * on lemma + governor lemma, the same way negation/aux postposing is,
 * rather than trusting that dep. Classified INVERT (not the postpose family
 * above): 以 already precedes its own complement (已) in source order, so
 * inverting relative to the *modal* auxiliary is what keeps it adjacent to
 * — immediately before — that complement once 已 itself inverts before the
 * modal, rather than being left stranded after it. */
const YI_LEMMA = "以";

function isYiOfAuxiliary(token: { dep: string; lemma: string }, governor: GovernorContext | undefined): boolean {
  return token.lemma === YI_LEMMA && !!governor && governor.lemma in AUXILIARY_LEMMAS;
}

/** 之's own complement in its genitive/attributive use (少典之子's 少典 —
 * see `conjugationContext.ts`'s `caseParticleFor` and `overrides.json`'s
 * `dep === "mod"` entry for の) is already exactly where it needs to be:
 * Chinese genitive order (possessor 之 possessed) already matches Japanese
 * order (possessor の possessed), so unlike an ordinary verb's comp:obj, no
 * jump is needed and no kunten mark should appear on it — 之 itself
 * doesn't invert (`mod` is already no-invert by `classifyDep`'s own
 * default), and its own complement shouldn't either, even though comp:obj
 * is ordinarily INVERT. Keyed on the governor's own `dep === "mod"`
 * (rather than just its lemma) so this stays scoped to 之's genitive use
 * specifically, not its comp:obj pronoun use (學而時習*之*). */
function isGenitiveComplement(token: { dep: string }, governor: GovernorContext | undefined): boolean {
  return !!governor && governor.lemma === "之" && governor.dep === "mod" && token.dep === "comp:obj";
}

/** Full movement classification for a token, given its dependency relation
 * and lemma, and (for the exceptions above) its governor's own lemma/morph.
 * `classifyDep` alone only distinguishes invert/no-invert; this additionally
 * detects the postpose case. */
export function classifyToken(token: { dep: string; lemma: string; pos: string }, governor?: GovernorContext): MovementBehavior {
  if (token.dep === "mod" && POSTPOSE_LEMMAS.has(token.lemma)) return "postpose";
  if (token.dep === "mod" && POSTPOSE_CONCESSIVE_LEMMAS.has(token.lemma)) return "postpose";
  if (isSpeechQuoteComplement(token, governor)) return "no-invert";
  if (isGenitiveComplement(token, governor)) return "no-invert";
  if (isYiOfAuxiliary(token, governor)) return "invert";
  return classifyDep(token.dep);
}
