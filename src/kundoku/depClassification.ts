// `isNegationUse` joins `AUXILIARY_LEMMAS` on the one import this file already
// makes back into `conjugationContext.ts` — a cycle at module level (that file
// imports this one) but not at evaluation time, since both are read from inside
// functions and never while either module body runs. Imported rather than
// reimplemented for the reason the doc on `isNegatedBareReport` gives: whether a
// 不 is *being used* as a negation is a question a hand-picked reading can
// answer differently, and a second copy of the test here would go on negating
// after the reader had taken the character out of the class.
import { AUXILIARY_LEMMAS, CAUSATIVE_LEMMAS, isNegationUse } from "../kakikudashi/conjugationContext.ts";
import { SENTENCE_FINAL_PARTICLE_LEMMAS } from "../kakikudashi/bungoConjugation.ts";
import { isOpeningBracket } from "../parse/punctuation.ts";
import { chosenReadingText } from "../reading/chosenReading.ts";

export type InvertBehavior = "invert" | "no-invert";
export type MovementBehavior = InvertBehavior | "postpose";

/** The governor a token is being classified against — just enough of it
 * (lemma, for the 以/genitive-之 exceptions and as the speech-verb fallback;
 * xpos, for the speech-verb class itself; dep, for the genitive-之 exception
 * specifically, which needs to confirm 之 *itself* is in its genitive use) to
 * decide movement, without depClassification.ts needing the full `Token` type
 * or a tree-walk context of its own. `morph` isn't read by any current
 * exception here, but is kept on the shape since callers pass a real `Token`
 * through unchanged. */
export interface GovernorContext {
  lemma: string;
  dep: string;
  xpos?: string;
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
 * of an otherwise-uniform pattern.
 *
 * **The whole oblique class, not two of its labels.** `OBLIQUE_DEPS` in
 * `conjugationContext.ts` is the enumeration — see it for what the gold
 * treebank writes (`udep@lmod`/`udep@tmod`, never `mod@lmod`/`mod@tmod`) as
 * against what a parse writes, and for the counts. The same directionality
 * measurement that admitted `mod@lmod` covers every one of them, since they are
 * subtypes of the two relations it counted: over `assets_sud/ja-*.sud.conllu`
 * (185,554 scored tokens) the dependent lands before its head 99.47% of the
 * time for `mod` and 99.96% for `udep`, against 100% for `comp:obl`, which was
 * already here.
 *
 * 苦不得飲 is what needed the rest of it. 得 hangs off 苦 by `mod@tmod`, and
 * with that relation left where it stood the sentence read 苦しむ飲むを得ず —
 * the governor said first, then the clause it governs. Inverted, it reads
 * 飲むを得ざるに苦しむ. Plain `udep` stays out, on this file's own standing
 * ground: never invert on a relation the model itself left underspecified.
 *
 * **Written out rather than spread from `OBLIQUE_DEPS`**, though that set is
 * the statement of record and this list must stay equal to it (a test holds
 * them together). The import at the top of this file is a module-level cycle
 * that is safe only because every value it brings in is read from *inside* a
 * function; a spread here would be read while this module's body runs, which is
 * exactly the thing that note promises does not happen. */
export const INVERT_DEPS: ReadonlySet<string> = new Set([
  "comp:obj",
  "comp:pred",
  "comp:aux",
  "comp@expl",
  "comp:obl",
  "comp:obl@lmod",
  "comp:obl@tmod",
  "mod@lmod",
  "mod@tmod",
  "udep@lmod",
  "udep@tmod",
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
 * いへども, not いへども槁暴あり) — the same pre-to-post flip as negation and
 * the modal auxiliaries above, just for a concessive-clause marker instead
 * of a verb-level one. Bounded to this one unambiguous lemma. */
const POSTPOSE_CONCESSIVE_LEMMAS: ReadonlySet<string> = new Set(["雖"]);

/** 毎/每 ("every, each") stands before what it distributes over in Chinese
 * source order but is read *after* it in kundoku — 毎事問 is 事ごとに問ふ and
 * 毎見其人 is 其の人を見るごとに, never ごとに事問ふ. Same pre-to-post flip as
 * the negations and 雖 above, for a distributive quantifier instead.
 *
 * Both the Japanese form 毎 and the traditional 每 are listed because the
 * parse carries them on different fields: live parses of both sentences above
 * give `text` 毎 but `lemma` 每, and `overrides.json` already carries the
 * reading (ごと, with に as its okurigana) under both characters for the same
 * reason.
 *
 * Conditioned on `mod` — the relation both live parses assign, whether the
 * head is the noun it counts (事, `mod`) or the verb whose every occasion it
 * marks (見, `mod`) — and, like the negations, suspended once a reading has
 * been picked by hand: a 毎 deliberately read まい as half of a jukugo is a
 * character standing where it stands, and postposing it past its head would
 * strand it after a word it is no longer quantifying. */
const POSTPOSE_DISTRIBUTIVE_LEMMAS: ReadonlySet<string> = new Set(["毎", "每"]);

/** True when `token` is a distributive postpose marker (毎/每) that will
 * actually be moved — exported so `conjugationContext.ts` can put a verb head
 * into 連体形 for it (受くるごとに, not 受くごとに): what 毎 attaches to is a
 * nominalized occasion ("every time that…"), which is an attributive
 * environment, not a sentence-final one. */
export function isDistributivePostpose(token: { dep: string; lemma: string; pos: string; misc?: Record<string, string> }): boolean {
  return token.dep === "mod" && POSTPOSE_DISTRIBUTIVE_LEMMAS.has(token.lemma) && chosenReadingText(token) === undefined;
}

/** True when `token` is a concessive postpose marker (雖) — exported so
 * `reorderEngine.ts` can mark the token immediately preceding it (once
 * postposed) as needing a trailing ト: real kundoku suffixes と onto the
 * *complement* 雖 scopes over (槁暴あり**と**いへども), not onto 雖's own
 * reading (see `ReadingPlan.quoteEndIds`, which this reuses). */
export function isConcessivePostpose(token: { dep: string; lemma: string }): boolean {
  return token.dep === "mod" && POSTPOSE_CONCESSIVE_LEMMAS.has(token.lemma);
}

/** Verbs of speech — the one class of governor whose *reported-speech*
 * complement does not invert like an ordinary object/predicate does. Real
 * kanbun reads 子曰：「...」 straight through left to right (曰く, then the
 * quote), never reordering the quote before the verb the way 之を知る would
 * invert 之 before 知る — a speech verb's comp:obj/comp:pred is the thing said,
 * not an ordinary complement, *when* it's actually a quoted clause. The same
 * governor also takes a plain naming complement (名曰軒轅, "[his] name was
 * Xuanyuan" — not a quotation at all), which behaves like an ordinary
 * complement instead: see `isSpeechQuoteComplement` for how the two are told
 * apart.
 *
 * **The treebank's own class, `v,動詞,…,伝達` ("transmission").** 曰/云/言/
 * 謂/問/答 all come back with that xpos, and `conjugationContext.ts` has been
 * asking the same question of the same field (`isCommunicationVerb`) for the
 * と/を decision the whole time. Reading it here is what puts every one of them
 * on the machinery that gets the *position* right, rather than only 曰/云.
 *
 * Both ends of the field are required, not `includes` — the class name is
 * reused across categories, and 術 in 成其術 is `n,名詞,可搬,伝達`, a noun about
 * transmission rather than a verb of it.
 *
 * This used to be a two-lemma set with 謂 deliberately excluded, on the ground
 * that 謂 also means "to call X Y" and so does not always take a quotation. The
 * ground was sound and the bound is no longer what carries it:
 * `isSpeechQuoteComplement` below now asks whether the source *brackets* the
 * complement, which is the distinction the exclusion was standing in for and
 * answers it per sentence instead of per lemma. 謂其身有異疾 carries no bracket
 * and so is not a quotation under the wider set either — その身に異疾有るを謂ふ,
 * unchanged.
 *
 * The lemma set survives as a fallback for a tree carrying no xpos at all (one
 * written by hand, or by another tool), so 曰/云 behave there as they always
 * have. Every other member of the class needs the tag, which is the same
 * arrangement `isCommunicationVerb` documents. */
const SPEECH_VERB_LEMMAS: ReadonlySet<string> = new Set(["曰", "云"]);

function isSpeechVerb(governor: GovernorContext): boolean {
  if (SPEECH_VERB_LEMMAS.has(governor.lemma)) return true;
  const xpos = governor.xpos ?? "";
  return xpos.startsWith("v,動詞,") && xpos.endsWith("伝達");
}

/** Just enough of the sentence for the two questions asked of one below — is
 * there a sentence-final particle on this token, and is there an opening
 * bracket anywhere in its subtree. Structural rather than the imported
 * `Sentence`, matching how `GovernorContext` above keeps this file off the
 * full `Token` type; a real `Sentence` satisfies it unchanged. */
export interface SentenceContext {
  tokens: readonly { id: number; head: number; dep: string; lemma: string; text: string; misc?: Record<string, string> }[];
}

/** Every token at or below `tokenId`. */
function subtreeOf(tokenId: number, sentence: SentenceContext): Set<number> {
  const subtree = new Set<number>([tokenId]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const t of sentence.tokens) {
      if (!subtree.has(t.id) && subtree.has(t.head) && t.id !== t.head) {
        subtree.add(t.id);
        grew = true;
      }
    }
  }
  return subtree;
}

/** Whether a sentence-final discourse particle hangs off `tokenId` — 也 on 蟲
 * in 曰：「此酒蟲也。」, 乎 on 有 in 豈飲啄固有數乎.
 *
 * Reimplemented here rather than imported: the one other copy is
 * `conjugationContext.ts`'s own `hasSentenceFinalParticle`, and this file is
 * already imported *by* that one, so reaching back for it would cycle — the
 * same reason `SPEECH_VERB_LEMMAS` above is duplicated in the other direction.
 * Only the particle inventory is shared, from `bungoConjugation.ts`, which is
 * a leaf table both files already sit above. */
function hasSentenceFinalParticle(tokenId: number, sentence: SentenceContext): boolean {
  return sentence.tokens.some(
    (t) =>
      t.head === tokenId &&
      t.id !== tokenId &&
      (t.dep === "discourse" || t.dep === "discourse@sp") &&
      SENTENCE_FINAL_PARTICLE_LEMMAS.has(t.lemma),
  );
}

/** Whether an opening bracket stands anywhere inside `tokenId`'s subtree —
 * the same test, on the same grounds, as `conjugationContext.ts`'s
 * `isQuotedSpeechComplement` makes for 言/謂/問 (and duplicated for the same
 * cycle reason as `hasSentenceFinalParticle` above).
 *
 * The subtree, not the token's own children: the parser does not always hang
 * the bracket on the complement's head — in 曰：「此酒之精、甕中貯水…」 the
 * complement is 貯 and the 「 hangs on 精, 貯's own `subj`.
 *
 * The *opening* bracket only. This parser splits a sentence at every stop, so
 * the 」 that closes a quote is regularly a sentence of its own (酒蟲's sent_id
 * 7, 9, 11 and 13 are each a lone bracket) with no tie to the clause it
 * closes. The opening mark stands inside the quoted material and so survives
 * the split. One edge of the span is enough to answer "was this quoted". */
function hasOpeningBracketInSubtree(tokenId: number, sentence: SentenceContext): boolean {
  const subtree = subtreeOf(tokenId, sentence);
  return sentence.tokens.some((t) => t.id !== tokenId && subtree.has(t.id) && isOpeningBracket(t.text));
}

/** True when `token` is the *quoted* complement of a speech verb — see
 * `SPEECH_VERB_LEMMAS` — as opposed to that same governor's plain naming
 * complement (名曰軒轅), which inverts and takes と/を like any other
 * comp:obj/comp:pred instead (see `conjugationContext.ts`'s
 * `namingComplementParticle`). Exported separately from `classifyToken` so
 * `reorderEngine.ts` can also use it to find *which* children need their
 * reading-order subtree's last token marked as the end of a quote (for the
 * trailing ト okurigana — see `ReadingPlan.quoteEndIds`).
 *
 * Two things have to hold, and neither is readable from the dep alone: both
 * uses land on the same comp:obj/comp:pred relations and this parser has no
 * "this is a quotation" tag.
 *
 * **It has to head a clause.** A quoted clause's carrier is ordinarily its own
 * predicate (VERB — 子曰習之's carrier is 習, "[he] studies") where a naming
 * complement's carrier is the name itself (NOUN/PROPN — 軒轅), so POS carries
 * this most of the time. It is a proxy, though, and a sentence-final particle
 * overrides it: nothing in Literary Chinese puts 也 or 乎 after a bare name, so
 * a nominal carrying one is not being named, it is being asserted. 曰：「此酒蟲
 * 也。」 is 「此れ酒の蟲なり」と — a clause, headed by a NOUN. 名曰軒轅, the
 * pattern the POS test exists for, carries no such particle, which is exactly
 * what tells the two apart.
 *
 * **A non-nominal one has to actually be quoted.** A clausal complement of a
 * speech verb takes 終止形 + と only where the source brackets it;
 * unbracketed, it is an ordinary object taking 連体形 + を.
 * `conjugationContext.ts` already holds these verbs to that, keyed on an
 * opening bracket in the complement's own subtree, and 曰/云 bypassed it only
 * because the と they take is written from here instead — so the same test
 * belongs here. It is also what made widening `SPEECH_VERB_LEMMAS` to the whole
 * 伝達 class safe: the bracket answers per sentence the question the two-lemma
 * bound was answering per lemma.
 *
 * The bracket is *not* required of the nominal admitted above, and the
 * asymmetry is the point: what makes withholding と safe is that 連体形 + を
 * is waiting to take its place, and for a nominal it is not.
 * `isUnquotedSpeechComplement`, which writes that を, excludes a NOUN/PROPN
 * outright — a nominal there is a name, which `namingComplementParticle`
 * answers for — and that rule has already stood down over the sentence-final
 * particle. So requiring a bracket of the nominal would leave it with neither
 * particle rather than with the other one. The particle is the whole of the
 * evidence in that case, and it is evidence about the same thing brackets are.
 *
 * It also keeps this in step with `conjugationContext.ts`'s `isNamingUse`,
 * which chooses 曰はく over 曰ふ off the sentence-final particle alone: 曰はく
 * presupposes that the quote follows the verb, so the two have to agree about
 * which nominals are quotes or the frame is stranded after the clause it
 * introduces (此酒の蟲なり曰はく).
 *
 * `sentence` is optional because neither question can be asked without it, and
 * two of the three call sites in `conjugationContext.ts` (which owns that
 * file's と/を decision) still call the two-argument form. Omitted, this
 * answers exactly as it did before either test existed — POS alone, no bracket
 * required — so those call sites keep the behaviour they were written against.
 * Passing the sentence there is what would put the を and the 連体形 on an
 * unbracketed complement of a speech verb as well; see the report. */
export function isSpeechQuoteComplement(
  token: { id?: number; dep: string; pos: string },
  governor: GovernorContext | undefined,
  sentence?: SentenceContext,
): boolean {
  if (!governor || !isSpeechVerb(governor)) return false;
  if (token.dep !== "comp:obj" && token.dep !== "comp:pred") return false;
  const nominal = token.pos === "NOUN" || token.pos === "PROPN";
  if (sentence === undefined || token.id === undefined) return !nominal;
  if (nominal) return hasSentenceFinalParticle(token.id, sentence);
  return hasOpeningBracketInSubtree(token.id, sentence);
}

/** True for one narrow shape of *unbracketed* clausal complement of a verb of
 * speech that takes 終止形 + と anyway: **one carrying its own negation and no
 * subject of its own.** 俱言不須 is ともに用ゐずと言ふ, not ともに用ゐざるを言ふ.
 *
 * **This is a shape, not a principle, and it is put here labelled as one.** The
 * standing rule is that a clausal complement takes と only where the source
 * brackets it (see `isSpeechQuoteComplement` and `conjugationContext.ts`'s
 * `isQuotedSpeechComplement`), and 俱言不須 has no bracket. The obvious next
 * question — what *else* distinguishes it from 謂其身有異疾, which has no bracket
 * either and reads その身に異疾有るを謂ふ — was put to lzh-train/dev/test in
 * `assets_sud` (68,893 sentences after removing the simplified duplicate of
 * every one), and the honest answer is **nothing does**. The counts, on the
 * 5,861 clausal complements of a `v,動詞,行為,伝達` governor:
 *
 *  - **Bracketing barely measures quotation at all; it measures 曰/云.** Those
 *    two governors supply 4,811 of the 6,982 complements and are 96.3%
 *    bracketed (odds ratio 22.3 against everything else). Strip them and the
 *    remainder sits at 56.5% bracketed — a coin flip, in which the と/を
 *    contrast lives entirely and about which the corpus is therefore silent.
 *  - **Negation alone does almost nothing.** 81.0% of unnegated complements are
 *    bracketed against 94.0% of negated ones, which looks decisive until 曰/云
 *    come out: 56.5% against 61.9%.
 *  - **Three candidate discriminators separate the two sentences backwards.**
 *    謂 is *more* bracketed than 言 (72.5% against 53.1%); an existential 有/無
 *    complement is *more* bracketed than average (63.1% against 56.7%); and a
 *    complement bearing its own object is *more* bracketed than one without
 *    (66.4% against 48.2%). Every one of those favours と for 謂其身有異疾, which
 *    is the reading the reader has already accepted as を.
 *  - **Having a subject of its own is flat** — 56.8% against 57.4%, no signal
 *    whatever on its own.
 *
 * What is left is the *conjunction* of the last two, and it is the whole of the
 * evidence for this rule: negated **and** subjectless runs 75.5% bracketed
 * (37 of 49) against the 57% baseline, and it is the only cell that fires on
 * 俱言不須 and not on 謂其身有異疾. n=49 and a 75/57 split is a shape match, not a
 * discriminator, and the corpus's nearest analogue of each sentence sits on the
 * matching side of it: 言不敢散其志也 (negated, no subject) beside 俱言不須, and
 * 謂壽皇有廢立意 — with the whole 聞其婦有孕 / 聞將軍有意督過之 / 及聞後宮有暴死者
 * cluster behind it — beside 謂其身有異疾.
 *
 * **What it deliberately does not do.** It leaves 謂其身有異疾 exactly as it
 * reads today (unnegated, so this never fires), and it leaves every bracketed
 * complement to `isSpeechQuoteComplement`, which owns them and also owns their
 * *position*: a bracketed quote follows its verb (子曰はく、「…」と) where this
 * shape inverts before it (…ずと言ふ), so this must not be folded into that
 * predicate. Only the trailing と is shared, through `ReadingPlan.quoteEndIds`
 * — see `reorderEngine.ts`, which marks it against the complement's own
 * reading-order subtree. That is the position an ordinary `quotativeParticleFor`
 * と cannot reach here: 不 is *postposed past* 須, so the と belongs after the ず
 * and not on the word the rule would be written onto.
 *
 * `sentence` is optional and answering `false` without one is deliberate, for
 * the reason `isSpeechQuoteComplement`'s own optional parameter has: a caller
 * with no tree in hand cannot ask about children, and the standing behaviour
 * (unbracketed complements take を) is the right thing to fall back to. */
export function isNegatedBareReport(
  token: { id?: number; dep: string; pos: string },
  governor: GovernorContext | undefined,
  sentence?: SentenceContext,
): boolean {
  if (sentence === undefined || token.id === undefined) return false;
  if (!governor || !isSpeechVerb(governor)) return false;
  if (token.dep !== "comp:obj" && token.dep !== "comp:pred") return false;
  // A nominal complement is a name (名曰軒轅) or an asserted clause carrying its
  // own 也 — both already answered by `isSpeechQuoteComplement` above, neither
  // ever negated.
  if (token.pos === "NOUN" || token.pos === "PROPN") return false;
  // A bracketed complement belongs to the rule above, whose と is written from a
  // different position. Both firing would put two と in the sentence.
  if (hasOpeningBracketInSubtree(token.id, sentence)) return false;
  const children = sentence.tokens.filter((t) => t.head === token.id && t.id !== token.id);
  if (!children.some((t) => isNegationUse(t))) return false;
  return !children.some((t) => t.dep === "subj" || t.dep.startsWith("subj@"));
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
 * specifically, not its comp:obj pronoun use (學而時習*之*).
 *
 * Exported (like `isSpeechQuoteComplement` beside it) because the same
 * question is asked from outside the movement machinery too:
 * `conjugationContext.ts`'s `decideConjForm` needs it to put a verb standing
 * here into 連体形 (大破之時 -> 大破するの時), and one 之-is-genitive test
 * shared between the two is what keeps the reading and the movement from
 * ever disagreeing about the same character. */
export function isGenitiveComplement(token: { dep: string }, governor: GovernorContext | undefined): boolean {
  return !!governor && governor.lemma === "之" && governor.dep === "mod" && token.dep === "comp:obj";
}

/** True when `token` is the predicate a 使役 governor (使/令/教/遣) makes
 * happen, reached over the **`parataxis`** edge this parser falls back to for a
 * caused predicate it has not labelled a complement.
 *
 * A causative reads *after* the predicate it governs — 使民戰 is 民をして
 * 戰はしむ — and nothing here says so directly: what puts the しむ last is that
 * the caused predicate is an INVERT child, so it and its whole subtree are
 * spliced in ahead of the auxiliary. That works for the relation the parser
 * ordinarily uses — a live parse of 使民戰 and of 令民俯 both give the caused
 * predicate `comp:obl`, and `comp:aux` is the same complement under the label
 * used for an auxiliary's governed predicate — since both are already in
 * `INVERT_DEPS`. It does not work for `parataxis`, which is not an INVERT
 * relation and never should be in general, so the auxiliary was read first.
 *
 * **`parataxis` is what a live parse actually returns** once the clause is
 * longer than a bare 使民戰. 但令於日中俯臥。 parses with 臥 attached to 令 by
 * `parataxis` (and 俯 as 臥's own `mod`), and before this it read
 * 但し日の中より**しむ**俯す臥さ — the しむ standing in front of the clause it
 * closes. It now reads 但し日の中より俯す臥さしむ. 酒蟲's sent_id 20 is the same
 * sentence and comes back the same way.
 *
 * **This is the reading-order half of a decision the conjugation layer already
 * makes.** `conjugationContext.ts`'s `isCausedPredicateOf` admits exactly this
 * edge — a verbal `parataxis` child of a causative — so that 俯 takes the 未然形
 * the しむ needs (俯臥**さ**しむ). The two halves have to name the *same* token
 * or the 未然形 lands on one word and the auxiliary jumps past another; that
 * disagreement is precisely what this sentence was showing. Same three
 * conditions, in the same order, and `CAUSATIVE_LEMMAS` is imported rather than
 * re-listed so the governor inventory can only ever be one list.
 *
 * The predicate itself is written out here rather than imported because
 * `isCausedPredicateOf` is private to that file and its exported wrapper
 * (`isCausedOrPassivePredicate`) is typed on the full `Token`/`Sentence` pair
 * this file deliberately stays off — the same reason `hasSentenceFinalParticle`
 * above is a local copy, and answered the same way: the *table* is shared even
 * where the function cannot be. `tests/kundoku.test.ts` holds the two to each
 * other on real trees, so a later change to either one that the other does not
 * follow fails rather than silently splitting the sentence in half.
 *
 * **Why this does not move a quotative frame.** `parataxis` is a mixed
 * relation — it also links a quotative frame to what it introduces, and an
 * appositive clause to its host, and this parser reaches for it for asyndetic
 * coordination as well (see `COORDINATION_DEPS` in `conjugationContext.ts`).
 * Two bounds keep those out. The governor must be one of the four causatives,
 * which the ordinary speech verbs are not: 曰/云/言/謂/問/答 are none of them,
 * so no frame headed by one of those moves. And the dependent must be verbal,
 * which keeps this to a predicate rather than to a nominal apposed after one.
 *
 * The residual case is **教**, which is a causative *and* carries the treebank's
 * 伝達 tag (a live parse of 教民戰 gives it `v,動詞,行為,伝達`), so a quotative
 * frame headed by 教 is inside this bound. That is not a bound this file can
 * tighten on its own and stay correct: `conjugationContext.ts` puts the same
 * `parataxis` child of the same 教 into 未然形 and writes a しむ for it, and a
 * narrower test here would strand that しむ in front of the clause instead of
 * after it. The two layers have to name one token, so the place to reconsider
 * 教 is the shared predicate, not this half of it. */
export function isCausedPredicateParataxis(
  token: { dep: string; pos: string },
  governor: GovernorContext | undefined,
): boolean {
  if (!governor || !CAUSATIVE_LEMMAS.has(governor.lemma)) return false;
  return token.dep === "parataxis" && (token.pos === "VERB" || token.pos === "AUX");
}

/** Full movement classification for a token, given its dependency relation
 * and lemma, and (for the exceptions above) its governor's own lemma/morph.
 * `classifyDep` alone only distinguishes invert/no-invert; this additionally
 * detects the postpose case. */
export function classifyToken(
  token: { id?: number; dep: string; lemma: string; pos: string; misc?: Record<string, string> },
  governor?: GovernorContext,
  sentence?: SentenceContext,
): MovementBehavior {
  // A reading picked by hand takes the character out of the class, exactly as
  // it does for the negation it reads as and for a 再読文字's construction
  // (`isNegationUse`, `isRereadUse`). 未 read ひつじ is a noun standing where
  // it stands, and postposing it past the verb — which is a thing done to
  // negations because the negation is read after what it negates — left it
  // at the end of a clause it is not negating: 未學禮 read 禮を學ぶ未.
  if (token.dep === "mod" && POSTPOSE_LEMMAS.has(token.lemma)) {
    return chosenReadingText(token) === undefined ? "postpose" : classifyDep(token.dep);
  }
  if (token.dep === "mod" && POSTPOSE_CONCESSIVE_LEMMAS.has(token.lemma)) return "postpose";
  if (isDistributivePostpose(token)) return "postpose";
  if (isSpeechQuoteComplement(token, governor, sentence)) return "no-invert";
  if (isGenitiveComplement(token, governor)) return "no-invert";
  if (isCausedPredicateParataxis(token, governor)) return "invert";
  if (isYiOfAuxiliary(token, governor)) return "invert";
  return classifyDep(token.dep);
}
