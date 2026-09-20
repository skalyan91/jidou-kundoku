// `isNegationUse` joins `CAUSATIVE_LEMMAS` on the one import this file already
// makes back into `conjugationContext.ts` — a cycle at module level (that file
// imports this one) but not at evaluation time, since both are read from inside
// functions and never while either module body runs. Imported rather than
// reimplemented for the reason the doc on `isNegatedBareReport` gives: whether a
// 不 is *being used* as a negation is a question a hand-picked reading can
// answer differently, and a second copy of the test here would go on negating
// after the reader had taken the character out of the class.
import { CAUSATIVE_LEMMAS, isNegationUse } from "../kakikudashi/conjugationContext.ts";
// `AUXILIARY_LEMMAS` comes off the cycle entirely — it is a table of endings and
// lives beside them in this leaf, which is also how the furigana menu reaches it.
import { AUXILIARY_LEMMAS, SENTENCE_FINAL_PARTICLE_LEMMAS } from "../kakikudashi/bungoConjugation.ts";
import { isBracket, isOpeningBracket, isPunctuationMark } from "../parse/punctuation.ts";
import { isContentPredicatePos } from "../parse/types.ts";
import { storedReadingText, chosenReadingText } from "../reading/chosenReading.ts";

export type InvertBehavior = "invert" | "no-invert";
export type MovementBehavior = InvertBehavior | "postpose";

/** The governor a token is being classified against — just enough of it
 * (lemma, for the 以/genitive-之 exceptions and as the speech-verb fallback;
 * xpos, for the speech-verb class itself; dep, for the genitive-之 exception
 * specifically, which needs to confirm 之 *itself* is in its genitive use;
 * id, for `isPostposedSubject`, which is a claim about source order rather
 * than about either word) to decide movement, without depClassification.ts
 * needing the full `Token` type or a tree-walk context of its own. `morph`
 * isn't read by any current exception here, but is kept on the shape since
 * callers pass a real `Token` through unchanged.
 *
 * `id` is optional for the same reason `sentence` is optional on the
 * predicates below: a caller with no position in hand cannot ask a question
 * about position, and the answer without one has to be the standing
 * behaviour. `spanCarrier.ts` classifies a token with no governor at all. */
export interface GovernorContext {
  id?: number;
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

/** True for a **subject standing after its own governor** — 出 in 哇有物出,
 * where the parse hangs 出 off 有 by `subj` at a position to its right.
 *
 * **NO-INVERT is a claim that no movement is needed, not that movement would
 * be wrong.** `subj` is outside `INVERT_DEPS` because a Chinese subject
 * precedes its verb and Japanese wants it there too, so leaving it at its
 * source position already puts it where the reading needs it — the same
 * head-final measurement the `INVERT_DEPS` note quotes gives `subj` a
 * dependent-before-head rate of 100% over `assets_sud/ja-*.sud.conllu`.
 * Japanese has no postverbal subject at all. So where the *source* puts one
 * after its governor, the premise the classification rests on has failed and
 * the dependent has to move, exactly as an object does; the kaeriten that
 * states that jump is then written by the ordinary INVERT machinery.
 *
 * **The blast radius is measured, not assumed.** Over
 * `assets_sud/lzh-{train,dev,test}.sud.conllu` (42,304 sentences after
 * dropping the simplified duplicate of every one) a `subj`/`subj@pass`
 * dependent stands after its governor **160 times against 42,402 before it —
 * 0.38%**, spread over 39 governor lemmas. So this fires on one subject in
 * 265 and leaves the ordinary case untouched by construction.
 *
 * **What those 160 are, and why inverting is right for all of them.** Half
 * (82) are 爲 — 為田九十億畝, a copular/factitive complement labelled `subj`,
 * read 田を為す; 28 are 欲 — 欲其縱縱爾, the subject of the wanted clause, read
 * 其の…たるを欲す; the rest are the modals 可/能/須/應 (a raised subject inside
 * a clause the modal already inverts) and a long tail of one-offs. Every one
 * of them is a dependent Japanese reads before the word it hangs off.
 *
 * **This is not the existential rule it might look like.** 有/無 account for
 * exactly **1** of the 160: the gold treebank labels an existential's
 * postverbal argument `comp:obj` (2,694 for 有, 1,384 for 無 — against one
 * single postposed `subj` in the whole corpus), and reserves `subj` for the
 * possessor, which stands *before* (1,364 times for 有, never after but that
 * one). 有朋自遠方來 is that ordinary analysis and is why it already reads
 * 朋遠方より來る有り: the parse makes 來 a `comp:obj` of 有 and 朋 a `subj` of
 * **來**, standing before it, so the whole clause inverts as one INVERT
 * subtree and nothing here is needed. 哇有物出 differs only in that the parse
 * reached for `subj` where it ordinarily reaches for `comp:obj`. Narrowing
 * this to existential governors would therefore fix the reported sentence for
 * the wrong reason and leave the other 159 wrong — the generalisation that
 * holds is about the *direction*, which is a fact about Japanese, not about
 * 有.
 *
 * **Not widened past `subj`.** The other NO-INVERT relations are not all
 * head-final in the same way, and the postposed ones are mostly meant to stay:
 * over the same corpus `conj:coord` stands after its governor 99.86% of the
 * time, `discourse@sp` 99.15%, `flat` 100%, `parataxis` 99.94%, `clf` 97.67%
 * — Japanese reads all of those after their head too. Plain `mod` is the one
 * real candidate and it is a mixed class: 4,714 of its 87,847 instances
 * (5.37%) stand after their governor, and they include postverbal 然/否/以來,
 * a measure phrase after its noun (馬十乘), an ordinal after 篇第 (篇第四),
 * 等 after a name, and reduplicative descriptives (君子坦蕩蕩) — all of which
 * kundoku reads in place. See `tests/postposedSubject.test.ts`.
 *
 * **Two bounds, each measured on the same 160.**
 *
 * *A stop between the two words* (5 of the 160). A kaeriten returns within a
 * 句; it does not reach back across a 、 or a 。, and the parser's own pipeline
 * agrees — `splitSentences.ts` cuts a sentence at every stop before any of
 * this runs, so a subject on the far side of one is only ever reachable in an
 * uploaded tree that kept the stop. Every instance in the corpus is an
 * attachment across a clause boundary that should not move: 隨陽、右壤，此皆廣
 * 川大水，山林谿谷不食之地 hangs 山 off 水 two clauses back, 悍人也。中期 hangs
 * 中 off 人 across a full stop, and 子曰：「何哉，爾所謂達者」？ is the
 * predicate-fronting question below with a comma in it. The reader's own
 * 解縛視之、赤肉長三寸許、蠕動如游魚、口眼悉備。 is the same shape and the reason
 * the bound is here: the parse makes 肉 a `subj` of 視 across the 、, and 肉's
 * subtree is the whole rest of the sentence, so inverting it read
 * 縛を解き之を赤肉…口眼悉く備はる視 — three clauses hauled in front of the verb.
 *
 * *A descriptive predicate as governor* (8 of the 160). Literary Chinese
 * fronts a stative predicate before its subject to exclaim — 美哉水, 賢哉二大夫,
 * 仁夫公子重耳, 善如爾之問也, 嘉樂君子, 憲憲令德 — and kundoku keeps that order
 * rather than undoing it: 美なるかな水, 賢なるかな二大夫. This is the one
 * construction in which Japanese really does read a subject after its
 * predicate, so it has to come out. The corpus draws it sharply: a governor
 * whose xpos names the treebank's descriptive class (`v,動詞,描写,…`) *and*
 * whose morph carries `Degree=Pos` is those eight and nothing else. Both
 * signals are required because each alone would be looser than the
 * construction: `Degree=Equ` on 若 in 未若曾子之母也 is a comparison whose
 * standard Japanese does read first (曾子の母に若かず), and it is not 描写.
 *
 * **The residual, named rather than hidden.** 矍鑠哉是翁 is the same
 * exclamative with a governor the treebank tags `v,動詞,行為,態度` and no
 * `Degree` at all, so neither bound sees it and 是翁 moves in front of 矍鑠.
 * One instance in 42,562, against eight the bound does catch; widening to the
 * 哉 sitting between the two words would need the sentence at a call site that
 * deliberately does not pass one (see the parameter note below). */
export function isPostposedSubject(
  token: { id?: number; dep: string },
  governor: GovernorContext | undefined,
  sentence?: SentenceContext,
): boolean {
  if (!governor || governor.id === undefined || token.id === undefined) return false;
  if (token.dep !== "subj" && !token.dep.startsWith("subj@")) return false;
  if (token.id <= governor.id) return false;
  if (isDescriptivePredicate(governor)) return false;
  return !stopStandsBetween(governor.id, token.id, sentence);
}

/** A stative/descriptive predicate — the treebank's own `v,動詞,描写,…` class,
 * carrying `Degree=Pos`. Read only by `isPostposedSubject`, for the
 * predicate-fronting exclamative documented there. A tree with no xpos (one
 * written by hand, or by another tool) answers `false`, the same way
 * `isSpeechVerb` degrades to its lemma fallback. */
function isDescriptivePredicate(governor: GovernorContext): boolean {
  return (governor.xpos ?? "").startsWith("v,動詞,描写,") && (governor.morph ?? "").includes("Degree=Pos");
}

/** The parts of speech a standard of comparison is written in. Read only by
 * `isPostposedComparisonStandard`, whose doc says why the bound is here. */
const NOMINAL_POS: ReadonlySet<string> = new Set(["NOUN", "PROPN", "PRON", "NUM"]);

/** True for a **nominal standard of comparison standing after its
 * comparative governor** — 魚 in 蠕動如游魚 (酒蟲, sent_id 25), where the parse
 * hangs 游魚 off 如 by plain `mod` at a position to its right.
 *
 * **The same argument `isPostposedSubject` makes, and on the same footing.**
 * 如/若 are read ごとし, and ごとし is a Japanese predicate: its standard is
 * said first — 游魚の如し, never 如し游魚. So a standard the source puts after
 * the character is a dependent that has to move, whatever relation the parse
 * reached for, and the ordinary INVERT machinery writes the kaeriten that
 * states the jump (如㆓游魚㆒, read 游・魚・如).
 *
 * **The treebank's own label for that standard is `comp:obj`, which already
 * inverts.** Over `assets_sud/lzh-{train,dev,test}.sud.conllu` a `comp:obj`
 * dependent of a `Degree=Equ` governor stands *after* it 3,206 times against
 * 232 before — VERB 1,190, PRON 890, NOUN 826, PROPN 208, NUM 24 and a tail —
 * and every one of those is read first today, because `comp:obj` is in
 * `INVERT_DEPS`. The reader's parse simply reached for `mod` where the
 * treebank reaches for `comp:obj`, exactly as 哇有物出's reached for `subj`.
 * The direction is therefore not a new claim about kundoku; it is the claim
 * the corpus already makes about this construction, applied to the one
 * relation the parse wrote instead.
 *
 * **Bounded to a nominal dependent, and that bound is measured.** Over the
 * same corpus a *plain* `mod` dependent stands after a `Degree=Equ` governor
 * 18 times — 9 sentences, each present twice, since those files carry the
 * traditional text and its simplified duplicate — and not one of them is a
 * nominal: 於/于 (ADP, 14), 然 (ADV, 2), 以 (VERB, 2). Two of those three
 * classes must not move — 如見其肺肝然 is 其の肺肝を見るが如く然り and 區以別矣
 * is 區ちて以て別つ, both with the dependent read last — and the third is a
 * bare preposition whose *object* is what a reading moves (that is
 * `mod@lmod`'s business, not this rule's), so 若於齊 is a sentence this
 * declines to fix rather than one it gets wrong. The plain class at large is
 * far too mixed to widen into: a postposed nominal `mod` under *any* governor
 * occurs 3,030 times (1,515 sentences), overwhelmingly the 爲田九十億畝 shape
 * and measure phrases, ordinals and 等 after their noun — all of which kundoku
 * reads in place. See `isPostposedSubject`'s own note on that class.
 *
 * **So this fires on nothing in the corpus at all**, which is a statement
 * about its blast radius rather than about its evidence: the configuration —
 * a nominal, plain `mod`, after a comparative — simply does not occur in the
 * gold trees, because the gold trees label it `comp:obj`. It cannot change a
 * single corpus sentence, and it cannot reach any of the postposed-`mod`
 * classes the file already promises to leave alone (the ADV `mod` on 覺 in
 * 哇有物出's own sentence among them — see `tests/postposedSubject.test.ts`).
 *
 * *A stop between the two words* ends it, for the reason it ends
 * `isPostposedSubject`: a kaeriten returns within a 句, and a comparative
 * whose standard is on the far side of a 、 has been attached across a clause
 * boundary rather than given a standard. */
export function isPostposedComparisonStandard(
  token: { id?: number; dep: string; pos: string },
  governor: GovernorContext | undefined,
  sentence?: SentenceContext,
): boolean {
  if (!governor || governor.id === undefined || token.id === undefined) return false;
  if (token.dep !== "mod") return false;
  if (!NOMINAL_POS.has(token.pos)) return false;
  if (!(governor.morph ?? "").includes("Degree=Equ")) return false;
  if (token.id <= governor.id) return false;
  return !stopStandsBetween(governor.id, token.id, sentence);
}

/** Whether a stop stands strictly between the two source positions.
 *
 * `sentence` is optional, and answering `false` without one is deliberate, for
 * the reason `isSpeechQuoteComplement`'s own optional parameter has: the one
 * caller that has no tree in hand is `conjugationContext.ts`'s
 * `readsLastInItsSubtree`, which cannot be given one without also turning on
 * the two sentence-keyed speech-verb rules above — a change that file's doc
 * declines to make on its own grounds. Without the sentence this reports the
 * majority answer (155 of the 160 postposed subjects have no stop between),
 * so the two layers agree about every one of them but those five. */
function stopStandsBetween(fromId: number, toId: number, sentence: SentenceContext | undefined): boolean {
  if (!sentence) return false;
  return sentence.tokens.some((t) => t.dep === "punct" && t.id > fromId && t.id < toId);
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

/** 非/匪 ("is not X") negate a **nominal** predicate where 不 negates a verb,
 * and are read the same way round: the predicate first, the negation last.
 * 非劉之病 is 劉の病に**あらず**, never あらず劉の病 — exactly the pre-to-post
 * flip `POSTPOSE_LEMMAS` states for 不, and traditional notation writes it with
 * the same kaeriten (非㆓劉ノ病㆒).
 *
 * **A set of its own rather than four more entries in `POSTPOSE_LEMMAS`.**
 * That set is the mirror of `conjugationContext.ts`'s `NEGATION_LEMMAS`, and
 * what makes the two one class is the ず: a 不 postposed past its verb puts
 * that verb into 未然形 and writes ず onto it. 非 does no such thing. It takes
 * a nominal predicate marked with に and carries its own あら- (…に非ず), so
 * the head it postposes past must *not* be pushed into 未然形. Joining the
 * verbal set would have done exactly that. The two behaviours coincide only in
 * the movement, which is what this file is about, so the movement is all that
 * is shared.
 *
 * **What the corpus says.** Over `assets_sud/lzh-{train,dev,test}.sud.conllu`
 * the treebank's own `体言否定` ("nominal negation") xpos is carried by exactly
 * two characters — 非 (1,554) and 匪 (18) — and by nothing else; 莫/無/无/靡 are
 * tagged 存在否定 or 動詞否定 and are not in this class. 1,570 of those 1,572
 * are `mod` (the other two are `conj:coord`, a 非 heading its own coordinate
 * predicate — excluded, for the reason the removed modal-auxiliary rule above
 * gives about 弱而能言). 1,562 of the 1,570 stand *before* the head they
 * modify; the eight that do not are all 為非X ("to be a non-X", 若心有住則為非
 * 住 and three others, each present twice as traditional + simplified), where
 * the parse hangs 非 on the copula 為 to its left while its real scope is the
 * noun to its right. Those are left alone by the `token.id < governor.id`
 * guard: 非住と為す reads straight through, and postposing a token that already
 * follows its governor would only invite a mark for a jump nothing makes.
 *
 * **The head need not be a noun, and the movement does not care.** By POS the
 * head is nominal in 914 of the 1,570 (NOUN 716, PART 150 — the nominalizers
 * 者/所/也 — PROPN 32, PRON 14, NUM 2) and verbal in the rest (VERB 570, AUX
 * 60, ADP 18, SCONJ 6, ADV 2). A verbal head is read exactly the same way
 * round, nominalized: 非惡其聲而然也 is 其の聲を惡みて然るに非ざるなり. What
 * differs between the two is only the *form* the head takes before the に
 * (体言 as it stands, against 連体形), which is `conjugationContext.ts`'s
 * business, not this file's — so the gate here is on 非's own POS and relation
 * and says nothing about the head's.
 *
 * `pos === "ADV"` because 非 has two other uses the same lemma spells: the
 * noun 非 "a wrong" (`n,名詞,描写,態度`, 90×) and the verb 非 "to blame"
 * (`v,動詞,行為,交流`, 58×). Neither ever carries 体言否定, and `dep === "mod"`
 * alone still admits ten of them. And a reading picked by hand takes the
 * character out of the class, for the reason `classifyToken` gives about 未
 * read ひつじ. */
const POSTPOSE_NOMINAL_NEGATION_LEMMAS: ReadonlySet<string> = new Set(["非", "匪"]);

/** True when `token` is a nominal-negation postpose marker (非/匪) that will
 * actually be moved — see `POSTPOSE_NOMINAL_NEGATION_LEMMAS`. Exported so
 * `conjugationContext.ts` can put the head it postposes past into the form
 * …に takes (体言 + に for a nominal head, 連体形 + に for a verbal one), the
 * same way `isDistributivePostpose` is exported for 毎's 連体形. */
export function isNominalNegationPostpose(
  token: { id?: number; dep: string; lemma: string; pos: string; misc?: Record<string, string> },
  governor?: { id?: number },
): boolean {
  if (token.dep !== "mod" || token.pos !== "ADV") return false;
  if (!POSTPOSE_NOMINAL_NEGATION_LEMMAS.has(token.lemma)) return false;
  if (chosenReadingText(token) !== undefined) return false;
  // No position in hand answers the standing behaviour, exactly as
  // `isPostposedSubject` does: 非 precedes its head in 1,562 of 1,570.
  if (governor?.id === undefined || token.id === undefined) return true;
  return token.id < governor.id;
}

/** The negations that **realise a predicate of their own** rather than
 * inflecting the verb they negate — the existential 無/无 (罔/靡 beside them)
 * and the prohibitive 莫/毋 — standing as a preverbal `mod` over what they
 * deny. 無友不如己者 is 己に如かざる者を友とすること**無かれ**, never 無く…友;
 * 三年無改於父之道 is 三年父の道を改むること無し; 莫知其極 is 其の極を知る莫し.
 * The same pre-to-post flip `POSTPOSE_LEMMAS` states for 不 and
 * `POSTPOSE_NOMINAL_NEGATION_LEMMAS` for 非, for the third of the three
 * negations kundoku reads after what it negates.
 *
 * **A set of its own, and it has to be**, for exactly the reason 非 has one:
 * `POSTPOSE_LEMMAS` is the mirror of `NEGATION_LEMMAS`, and what makes that set
 * one class is the ず it writes onto the 未然形 of the verb it postposes past.
 * None of these writes a ず. They are the adjective 無し (莫し, 毋かれ) and
 * realise their own predicate — 改むること無し, 其の極を知る莫し — so the head
 * they move past must **not** be pushed into 未然形. Only the movement is
 * shared, and the movement is what this file is about. 勿 is the character
 * that shows the line: it is in `POSTPOSE_LEMMAS`, reads 憚らず on the head,
 * and stays there.
 *
 * **What the gold says about the existentials.** Over
 * `lzh_kyoto-sud-{train,dev,test}.relabeled_ext.udep_ruled.punct.sjmerged.conllu`
 * (46,168 sentences, 533,362 tokens) the treebank's existential class
 * `v,動詞,存在,存在` is carried by an ADV **489** times. **Every one of the 489
 * is `mod`, and every one carries `VerbForm=Conv`** — so neither the relation
 * nor the morphology separates anything here, and `VerbForm=Conv` in
 * particular is not the signal it looks like: it is on the ones that postpose
 * and on the ones that do not alike. What divides the class is the **lemma**:
 *
 * | lemma | n | what it is |
 * |---|---|---|
 * | 無 | 444 | the negative existential — 無し |
 * | 微 |  22 | the adverb ひそかに/かすかに — 微行, 微諫, 微服 |
 * | 有 |   6 | the *positive* existential |
 * | 罔 |   6 | negative existential — 惟狂罔念 |
 * | 靡 |   3 | negative existential — 時に爭ひ有ること靡し |
 * | 在/末/現/于/存 | 8 | positive existentials, and 末 |
 *
 * 微 is what makes the lemma gate necessary rather than tidy. It carries
 * `Polarity=Neg|VerbForm=Conv` on `v,動詞,存在,存在` — morphologically
 * indistinguishable from 無 — and is not an existential at all: 微服, 微行,
 * 微諫, 微謂, all of them ひそかに, read straight through in front of their
 * verb. A rule keyed on the tag alone would have postposed all 22.
 *
 * **And the 連用形 uses stay in front because they are not in this class at
 * all.** 無くして and 無かりせば — 無而爲有 (無くして有りと爲す), 微管仲
 * (管仲微かりせば) — are the *predicate* 無, tagged VERB or standing as its own
 * ROOT with the clause hanging off it, not an ADV `mod` under another
 * predicate. Nothing in this gate reaches them.
 *
 * **莫/毋 join on the ず, not on the xpos.** The gold tags them
 * `v,副詞,否定,禁止`, the prohibitive class — 莫 **356** ADV tokens (355 `mod`,
 * 354 of them before their head), 毋 **217** (215 `mod`, 212 before) — and by
 * the tag they are 勿's neighbours rather than 無's. By the reading they are
 * 無's: 莫知其鄉 is 其の鄉を知る莫し and 毋自欺也 is 自ら欺くこと毋かれ, an
 * adjective of their own at the end of the clause, where 勿's ず is an
 * inflection of the verb. So the xpos gate below admits both classes and the
 * lemma decides, which is the arrangement the readings license and the
 * corpus confirms: over the kanbun.info corpus, adding these two moved 70
 * passages closer to the received text against 6 further away.
 *
 * 无 is in the set as 無's variant graph. The gold does not contain it (0
 * tokens), but the shipped parser and `verbLexicon.ts` both treat it as the
 * same word.
 *
 * **The head must be something the negation can scope over.** By POS the head
 * of a negative existential is VERB in 393 of the 453, AUX in 29 (a modal —
 * 我能くする無し), PART in 8 (the nominalizer 所 — 控訴する所無し) and ADP in 3
 * (無自入 → 自ら入る無し). The 16 whose head is SCONJ are all the genitive 之,
 * and every one is a **lexical compound** rather than a negated predicate:
 * 無妄之福 (12 of the 16), 無爲之先, 無知之死人, 無能之如耳, 無已之求. 無妄 is
 * one word and the 之 heads the phrase, so postposing past it would write
 * 妄の福無し for 「無妄の福」. Those are the one governor left out, and only
 * those — see `isGenitiveGovernor` for why the bare-noun heads beside them are
 * not.
 *
 * **And one already standing after its head is left alone**, the same
 * `token.id < governor.id` guard `isNominalNegationPostpose` carries: all 17
 * such existentials hang off a modal to their left (可以無飢矣, 雖欲無王,
 * 能無議君於王), where the reading runs straight through and a mark would
 * state a jump nobody makes.
 *
 * A reading picked by hand takes the character out of the class, for the
 * reason `classifyToken` gives about 未 read ひつじ. */
const POSTPOSE_PREDICATE_NEGATION_LEMMAS: ReadonlySet<string> = new Set(["無", "无", "罔", "靡", "莫", "毋"]);

/** The two treebank classes the lemmas above are tagged with — the existential
 * `v,動詞,存在,存在` (無/罔/靡) and the prohibitive `v,副詞,否定,禁止` (莫/毋).
 * Required rather than inferred from the lemma alone, so that 莫 the noun
 * (莫 for 暮, `n,名詞,時,*`, 13×) and 莫 the place name stay out; and allowed
 * to be absent for the reason `isSpeechVerb` gives: a tree written by hand or
 * by another tool carries no xpos, and the lemma has to answer there. */
const PREDICATE_NEGATION_XPOS: ReadonlySet<string> = new Set(["v,動詞,存在,存在", "v,副詞,否定,禁止"]);

/** The one governor these negations do **not** postpose past: the genitive 之.
 * See `POSTPOSE_PREDICATE_NEGATION_LEMMAS` — all 16 of the gold's 之-headed
 * existentials are a lexical compound standing in front of the particle
 * (無妄之福, 無爲之先, 無知之死人, 無已之求), and moving the negation past the
 * 之 would write 妄の福無し for 「無妄の福」.
 *
 * **A bare noun head is deliberately *not* excluded with it**, though the same
 * argument reaches for it: the gold's four NOUN-headed existentials split (則國
 * 必無患矣 wants the postpose, 無量 does not), and over the kanbun.info corpus
 * excluding them measured **two edits worse**, on 毋意、毋必、毋固、毋我
 * (意毋く、必毋く…) and 莫不砥屬. The evidence runs the other way there, so the
 * line is drawn at the particle, which is the part the corpus is clean on. */
function isGenitiveGovernor(xpos: string | undefined): boolean {
  return xpos === "p,助詞,接続,属格";
}

/** True when `token` is a predicate-negation postpose marker (無/无/罔/靡/莫/毋)
 * that will actually be moved — see `POSTPOSE_PREDICATE_NEGATION_LEMMAS`.
 * Exported so `conjugationContext.ts` can decide the negation's own form from
 * where the reading puts it rather than from the `VerbForm=Conv` the parser
 * wrote about where the source puts it, the same way `isDistributivePostpose`
 * is exported for 毎's 連体形. */
export function isPredicateNegationPostpose(
  token: { id?: number; dep: string; lemma: string; pos: string; xpos?: string; misc?: Record<string, string> },
  governor?: { id?: number; xpos?: string },
  sentence?: SentenceContext,
): boolean {
  if (token.dep !== "mod" || token.pos !== "ADV") return false;
  if (!POSTPOSE_PREDICATE_NEGATION_LEMMAS.has(token.lemma)) return false;
  if (token.xpos !== undefined && token.xpos !== "" && !PREDICATE_NEGATION_XPOS.has(token.xpos)) return false;
  if (chosenReadingText(token) !== undefined) return false;
  if (governor === undefined) return true;
  if (isGenitiveGovernor(governor.xpos)) return false;
  // No position in hand answers the standing behaviour, exactly as
  // `isNominalNegationPostpose` does: the negation precedes its head in 436 of
  // the 453 existentials, 354 of 355 莫 and 212 of 215 毋.
  if (governor.id === undefined || token.id === undefined) return true;
  if (token.id >= governor.id) return false;
  // **A stop between the two ends it**, the same guard
  // `isPostposedComparisonStandard` carries and for the same reason: a
  // kaeriten returns within a 句, and a 無 attached across a 、 has been given
  // a governor by a parse that lost the clause boundary, not a predicate to
  // deny. **Free on the gold** — not one of the 453 has a stop between it and
  // its head — and not free at all on a parse: 故用兵之法、無恃其不來、恃吾有以
  // 待也 hangs its 無 on the *second* 恃, two clauses to the right, and moving
  // it there carried the whole of 恃吾有以待 to the front of the sentence.
  if (stopStandsBetween(token.id, governor.id, sentence)) return false;
  // **And one with dependents of its own is a predicate already.** What
  // postposes here is the token's whole subtree, so a 無 the parse has given a
  // `comp:obj` is not a preverbal adverb being moved past its verb but an
  // existential predicate with its complement — the shape `verbLexicon.ts` and
  // `conjugationContext.ts` already read as 〜こと無し where it stands. 450 of
  // the gold's 453 are leaves, so this costs three and keeps a parse's own
  // hedged analysis from being moved on top of.
  if (sentence?.tokens.some((t) => t.head === token.id && t.id !== token.id)) return false;
  return true;
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

/** True for a **PART the sentence-final particle table knows, standing last** —
 * a closing 也/乎/否/耳/矣/哉/夫/焉/歟 that the parse has nevertheless hung off
 * its predicate by an argument relation. It is read where it stands, never
 * hauled in front of the word it closes.
 *
 * **The case this was written for is 君飲嘗不醉否？** (酒蟲, sent_id 8). The
 * reader's tree tags 否 `PART` and attaches it to 醉 — both right — on the
 * relation **`comp:obj`**, which is in `INVERT_DEPS`. So the や was being read
 * *before* the verb it closes: 君飲みかつて**や**醉はず, with the ず then having
 * nothing after it and staying 終止形. Everything downstream followed from the
 * order: `boundByBindingParticle` looks for the particle in reading order after
 * the negation and found none, so the 係り結び never fired and the ざる the reader
 * asked for could not be reached from any rule. With the particle left in place
 * the sentence reads 君飲みかつて醉は**ざる**や.
 *
 * **The annotation is what is actually wrong, and it is named rather than worked
 * around.** A sentence-final particle attaches by `discourse@sp` in this treebank
 * (22,396 of the 24,434 PART tokens of these ten lemmas; `discourse` a further
 * 998), and 否 should carry that relation and the xpos `p,助詞,句末,*`. Verified
 * live: with the dep alone changed to `discourse@sp` — or to `discourse` — and
 * *nothing else* touched, the app already printed 醉はざるや before this rule
 * existed. The head was never the problem: the tree has had 否 on 醉 all along.
 *
 * **Why the rule is here anyway, and why it is not the compensation this file
 * forbids.** The app had already decided this token is a particle: three separate
 * places ask `isSentenceFinalParticleUse`, whose whole purpose is to rescue a
 * closing 否 the parser mis-read, and all three had rescued it — 否 was reading
 * や and carrying no case particle. Only the reading *order* had not been told,
 * and the result was a page that could not be defended under either analysis: a
 * sentence-final や read in the middle of the clause. This does not invent a
 * reading for a mis-annotated token; it stops one part of the app from acting on
 * an analysis the rest of it has already rejected.
 *
 * **PART, and that is the whole of the widening.** `isSentenceFinalParticleUse`
 * admits a token by position whatever its POS (bar NOUN/PROPN), because a
 * *reading* has to be produced for every token and the parser's 否-as-verb tag is
 * systematic. Movement is a different question with a different safety default —
 * this file's own, stated at `classifyDep`: never invert on evidence the model
 * left underspecified. A `PART` tag is the model saying outright that the token
 * is a particle, and a particle is not an argument of anything. So the two
 * predicates answer differently on purpose, and the movement one is the
 * conservative half.
 *
 * **Measured, over `assets_sud/lzh-{train,dev,test}.sud.conllu`** (137,786
 * sentences). A PART of these ten lemmas standing last on a relation in `INVERT_DEPS` occurs **14 times — seven sentences and their simplified
 * twins — and every one is 也**: 非達也 (達に**非ざるなり**, where inverting gave
 * なり達に非ず), 惡在其為民父母也, 未見所以敬王也 and four more of the same shape.
 * All seven are improvements. Widening past PART is what the count forbids:
 * dropping the POS test admits 108 PRON 焉 (心不在焉, where 焉 is the locative
 * pronoun and the order is right as it stands) and 81 VERB 否 (曰：「否。」, the
 * bare answer "no"), neither of which this rule is about. */
function isClosingParticleInPlace(
  token: { id?: number; dep: string; lemma: string; pos: string },
  sentence: SentenceContext | undefined,
): boolean {
  if (sentence === undefined || token.id === undefined) return false;
  if (token.pos !== "PART" || !SENTENCE_FINAL_PARTICLE_LEMMAS.has(token.lemma)) return false;
  const meaningful = sentence.tokens.filter((t) => t.dep !== "punct");
  return meaningful.length > 1 && token.id === Math.max(...meaningful.map((t) => t.id));
}

/** Whether `tokenId` carries a subject of its own — 是 on 福 in 蟲是劉之福,
 * where a noun is predicated of a subject and so heads a clause rather than
 * naming anything.
 *
 * Its own children, not the subtree: the question is whether *this* token
 * predicates something, and a subject further down belongs to some clause
 * below it. That is the opposite of what `hasOpeningBracketInSubtree` needs
 * and for the opposite reason — a bracket marks the edge of a span and may
 * hang anywhere inside it, where a subject is a relation this token itself
 * either bears or does not.
 *
 * Subtypes admitted (`subj@agent` and the like), as everywhere else in this
 * file that asks about a subject — see `isUnquotedSpeechComplement`'s own
 * subject test, which spells the same pair out. */
function hasOwnSubject(tokenId: number, sentence: SentenceContext): boolean {
  return sentence.tokens.some(
    (t) =>
      t.head === tokenId &&
      t.id !== tokenId &&
      (t.dep === "subj" || t.dep.startsWith("subj@")),
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

/** How many **words** the bracketed span opening inside this token's subtree
 * holds — the length of what was actually said, punctuation not counted.
 *
 * **Measured over the span in source order, not over a subtree**, and the
 * difference is the whole point. A quotation's words do not all hang off its
 * first word: 子曰：「弟子入則孝，出則悌，…」 gives 弟子 as 曰's `comp:obj` and
 * hangs 孝 and 悌 off **曰**, so 弟子's own subtree is one word and a subtree
 * count called a nine-clause saying a name. Where the clauses attach is a
 * question about the analysis; how much lies between the brackets is a fact
 * about the edition, and it is the second one this needs.
 *
 * The scan is depth-counted so a quotation inside a quotation closes its own
 * bracket — 曰：「…子貢曰：『…』…」 — and stops at the end of the sentence if the
 * source never closes it, which is the ordinary case for a quotation that runs
 * past a stop. Zero where no bracket opens in the subtree at all.
 *
 * See `isSpeechQuoteComplement`, its one caller, for what the count decides. */
function bracketedSpanWords(tokenId: number, sentence: SentenceContext): number {
  const subtree = subtreeOf(tokenId, sentence);
  const ordered = [...sentence.tokens].sort((a, b) => a.id - b.id);
  const start = ordered.findIndex((t) => subtree.has(t.id) && isOpeningBracket(t.text));
  if (start === -1) return 0;
  let depth = 0;
  let words = 0;
  for (const token of ordered.slice(start)) {
    if (isOpeningBracket(token.text)) {
      depth++;
      continue;
    }
    if (isBracket(token.text)) {
      depth--;
      if (depth <= 0) break;
      continue;
    }
    // Asked of the text and not of a UPOS, because `SentenceContext`'s token
    // carries no POS — and the text is the better question in any case: what
    // is being counted is how much was *said*, and a mark is not said.
    if (!isPunctuationMark(token.text)) words++;
  }
  return words;
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
 * **The particle is not the only such evidence, though, and reading it as
 * though it were is what the `subj` clause below fixes.** "The bracket is not
 * required" had been implemented as "the bracket is not consulted": a nominal
 * complement was put to `hasSentenceFinalParticle` and to nothing else, so a
 * bracketed nominal predicate carrying no 也 fell through to the naming branch
 * and inverted. **The case is 或言：『蟲是劉之福、非劉之病、僧愚之以成其術。』**
 * (酒蟲, sent_id 36). The complement is 福, and it is a NOUN because Literary
 * Chinese says "is" by predicating a noun of a subject — 蟲是劉之福, "the worm
 * *is* Liu's good fortune". The sentence came out あるひと『蟲は是れ劉の福**を**
 * …其の術を成す**言ふ**、: the frame hauled past the end of the quote it
 * introduces, and a を on a noun that is a predicate rather than an object.
 *
 * **The bracket's hand was never the variable, and the probe that settles it
 * changes one character.** Rendering that tree with 「 in place of 『 and
 * nothing else touched reproduces the inversion exactly — `isOpeningBracket`
 * has held both marks since it was written. Tagging 福 `VERB` instead, with the
 * 『 left as it stands, reads あるひと言ふ、『…其の術を成す**と**。 So the
 * discriminator was the complement's POS throughout, and 「 had merely never
 * met a nominal predicate without a 也 in this text.
 *
 * **A bracket alone will not do here, because a name can be bracketed too.**
 * Over lzh_kyoto-sud-{train,dev,test} — the `.punct` variants, which are the
 * same 86,239 sentences as the plain files with the source's own punctuation
 * restored, and the only ones in that directory that carry a bracket at all —
 * there are **96** nominal complements of a 伝達 governor that are bracketed and
 * carry no sentence-final particle. **95 of them are names**, and admitting
 * them would have been a straightforward regression: 謂之「伯父」, 自稱曰「老夫」,
 * 內事曰「孝王某」, 異姓謂之「伯舅」, 是以謂之『文』也. A name in quotation marks is
 * still a name — it reads 之を「伯父」と謂ふ, with the frame *after* it, which is
 * exactly the inversion `namingComplementParticle` is there to produce.
 *
 * **What separates 蟲是劉之福 from 伯父 is that it has a subject.** 是 sits on 福
 * by `subj`; 伯父 has only a `mod`. That is the same thing the sentence-final
 * particle was standing in for — this nominal is asserting something, not
 * naming something — read off the structure directly instead of off a clue the
 * writer may not have left. It is also the cleanest cut available: of those 96,
 * **exactly one** bears a subject, and it is a quoted clause on any reading —
 * 如來說『：一切法皆是佛法 ("the Tathāgata says, 'all dharmas are Buddha-dharmas'"),
 * the same 是-predication shape as the sentence this was written for. Widening
 * `subj` to `subj`-or-`dislocated` (蟲 hangs off 福 by `dislocated`) admits not
 * one case more, so the narrower relation is the one taken.
 *
 * Both halves are required, and each keeps a different regression out. Without
 * the bracket, the 24 unbracketed subject-bearing nominals in that corpus would
 * lose the を that `isUnquotedSpeechComplement`'s own rule reserves for them;
 * without the subject, the 95 bracketed names above would lose their inversion.
 * The paragraph above still stands as written — a bracket is not *required* of
 * a nominal, so 曰：「此酒蟲也。」 is now admitted twice over rather than once, and
 * a bare 名曰軒轅 is untouched either way.
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
  // **A quotation hung beside its 曰 rather than under it** is a quote whatever
  // its governor is, which is why this stands above the speech-verb gate: in
  // 大宰問於子貢曰：「夫子聖者與？」 the governor of 者 is 問, and 者 would
  // otherwise invert in front of 問 and take を. See
  // `quoteFramingYue`, which says which sibling that is. Only the two argument
  // relations are answered here, because only they would otherwise invert and
  // take を; a `parataxis` or `conj:coord` sibling already reads in place, and
  // `reorderEngine.ts` closes the quotation once, after the last of them.
  if (
    (token.dep === "comp:obj" || token.dep === "comp:pred") &&
    quoteFramingYue(token, sentence) !== undefined
  ) {
    return true;
  }
  if (!governor || !isSpeechVerb(governor)) return false;
  if (token.dep !== "comp:obj" && token.dep !== "comp:pred") return false;
  const nominal = token.pos === "NOUN" || token.pos === "PROPN";
  if (sentence === undefined || token.id === undefined) return !nominal;
  // **An argument set off from its 曰/云 by 、, ， or ： is a quotation, never a
  // name**, and this stands in front of every nominal test below because the
  // naming rule at the bottom of them was swallowing short quotes.
  //
  // 王笑之曰、善。 is the shape: 善 is a bare NOUN on `comp:obj` of 曰 with no
  // particle, no bracket and no subject of its own, so it fell through to "a
  // name", inverted, and 曰 lost 曰く along with it (`isNamingUse` asks this
  // function): 王之を笑ひ、善を曰ふ, where the reading is 曰く、善し、と.
  //
  // **A name is never punctuated off from 曰.** 名曰軒轅, 其一曰玄囂, 謂其臺曰靈臺
  // and 君稱之曰夫人 all run the name straight on, because the name is the
  // second object of "call it X" and nothing separates a verb from its object;
  // a mark after 曰 is the editor opening the words said. Counted over the
  // kanbun.info corpus (both tiers, 0.3.3 parses): a NOUN/PROPN `comp:obj` or
  // `comp:pred` of 曰/云 standing after it with 、，： directly behind the verb
  // occurs **112** times, and kanbun.info reads **every one** as a quotation
  // (子貢曰、夫子温良恭儉讓 → 子貢曰く、夫子は温・良…; 放齊曰、嗣子丹朱開明 →
  // 放斉曰く、嗣子丹朱開明なり、と). Not one of the 112 passages writes the name
  // form …と曰う for that 曰. The unmarked names above are untouched: with no
  // mark behind 曰 this rule answers nothing and the tests below decide.
  //
  // The mark is read off the **first token after 曰** and off its first
  // character, not off a `punct` relation: this parser occasionally glues the
  // mark onto the word after it (曰、安 comes back as 曰 + `、安`), and the
  // character is the evidence either way.
  if (SPEECH_VERB_LEMMAS.has(governor.lemma) && isSetOffFromGovernor(token.id, sentence)) return true;
  // A nominal asserting its own 也 is a quote on the particle alone, bracket or
  // no bracket — the case the を has no claim on.
  if (nominal && hasSentenceFinalParticle(token.id, sentence)) return true;
  // **A bracketed nominal of more than one word under 曰/云 is an utterance,
  // not a name**, and this stands in front of the naming rule below because
  // that rule was swallowing it.
  //
  // 子曰：「巧言令色，鮮矣仁」！ is the shape. 言 is the `comp:obj` of 曰 with 色
  // coordinated onto it and 鮮矣仁 hanging off it as `parataxis` — a whole
  // saying, headed by a noun because the saying begins with one. It has no
  // `subj` of its own and no sentence-final particle on its head, so it fell
  // past both tests above into "a name", was inverted like an ordinary object
  // and took を: **子巧言を令色を鮮なし仁曰ふ**, with the frame stranded at the
  // end of a sentence the received text opens with 子曰く.
  //
  // **Two conditions, and the corpus is what chose them.** Over the gold
  // (`punct.sjmerged`, the joined branch both this project's builders now
  // read) there are **880** nominal `comp:obj`/`comp:pred` of 曰/云. Crossing
  // the source's bracket against the size of the subtree:
  //
  //  - **bracketed and more than one word — 81**, every one an utterance, and
  //    the class this admits. 子曰：「巧言令色，鮮矣仁」！ is one.
  //  - **bracketed and one word — 13**, which are names and stay names:
  //    措之廟，立之主，曰「帝。」 is "called it 帝", and inverting it is right.
  //    This is why the count is here and not just the bracket.
  //  - **unbracketed — 470**, untouched in either direction. They hold the
  //    real names (謂其臺曰靈臺) and also the unbracketed quotations of editions
  //    that print none, and nothing in the tree separates those two; the
  //    bracket is the only evidence there is, so where it is absent this
  //    declines to guess and the naming rule goes on answering.
  //
  // Held to 曰/云 rather than to `isSpeechVerb`'s whole 伝達 class, for the
  // reason the clausal rule below gives: outside those two lemmas the bracket
  // is a coin flip, and 謂之「伯父」 — a bracketed two-word *name* under 謂 —
  // is exactly what a wider rule would break.
  if (
    nominal &&
    SPEECH_VERB_LEMMAS.has(governor.lemma) &&
    hasOpeningBracketInSubtree(token.id, sentence) &&
    bracketedSpanWords(token.id, sentence) > 1
  ) {
    return true;
  }
  // A nominal predicating nothing is a name (名曰軒轅, 謂之「伯父」), which
  // inverts whether or not the source put quotation marks round it.
  if (nominal && !hasOwnSubject(token.id, sentence)) return false;
  // **A clause under 曰/云 is a quote whether the source brackets it or not**,
  // and this is the one place the bracket test is stood down. The measurement
  // is `isNegatedBareReport`'s own, quoted from its doc below: of the 6,982
  // clausal complements of a `伝達` governor in lzh-{train,dev,test}, 曰/云
  // supply **4,811 and are 96.3% bracketed**, against 56.5% for every other
  // verb of speech. That is not a distribution in which the bracket is
  // deciding anything for these two lemmas — it is one in which the bracket is
  // a *typographic convention of the source*, applied to 曰/云 almost without
  // exception, and its absence is therefore evidence about the edition and not
  // about the sentence.
  //
  // Which matters because editions differ: kanbun.info prints its 白文 with no
  // quotation marks at all, so **every** 子曰 in it arrived here unbracketed
  // and read 〜を曰ふ — 不患人之不己知 came out 人の己を知らざるを患はず…と曰ふ、
  // with the frame stranded at the end of the sentence where the received
  // reading opens with 子曰く、. Over that corpus's 2,795 parsed passages this
  // is **2,950 edits**, the largest single class there was; over the 624 gold
  // ones, whose 白文 does carry the brackets, it costs 11.
  //
  // It also brings the three-argument form into line with the two-argument one,
  // which has always answered `!nominal` here — see the note on the optional
  // `sentence` above. The two disagreed about exactly this shape.
  //
  // Held to 曰/云 and not widened to the whole 伝達 class: 56.5% is a coin flip,
  // and the 謂其身有異疾 / 俱言不須 pair the reader has already ruled on lives in
  // it. `isNegatedBareReport` below is what answers there, on the one shape the
  // corpus does separate.
  if (!nominal && SPEECH_VERB_LEMMAS.has(governor.lemma)) return true;
  // Everything else — a clause, headed by a predicate or by a noun with a
  // subject — is a quote exactly where the source brackets it.
  return hasOpeningBracketInSubtree(token.id, sentence);
}

/** The marks an editor puts between 曰 and the words said — see
 * `isSpeechQuoteComplement`'s rule on them. */
const QUOTE_OPENING_MARKS = new Set(["、", "，", "："]);

/** Whether `tokenId` follows its governor and the first token after that
 * governor begins with a quote-opening mark (曰、善 / 曰：「…」). */
function isSetOffFromGovernor(tokenId: number, sentence: SentenceContext): boolean {
  const self = sentence.tokens.find((t) => t.id === tokenId);
  if (!self || self.head >= self.id) return false;
  const after = sentence.tokens.find((t) => t.id === self.head + 1);
  return after !== undefined && QUOTE_OPENING_MARKS.has([...after.text][0] ?? "");
}

/** The marks that divide one predication from the next inside a sentence —
 * the 、 an editor writes between two clauses, and the three glyphs that stand
 * for it. `QUOTE_OPENING_MARKS` above is the same inventory less the ；, which
 * never introduces a quotation and does divide two clauses. */
const CLAUSE_PAUSE_MARKS: ReadonlySet<string> = new Set(["、", "，", "；", "："]);

/** Whether a pause mark stands between `fromId` and `toId`, `toId` being the
 * left edge of something rather than a whole word: a mark glued onto the front
 * of the token at `toId` is still *before* it and still counts.
 *
 * Read off the characters rather than off a `punct` relation, for
 * `isSetOffFromGovernor`'s own reason: this parser occasionally glues the mark
 * onto the word after it (敢問、兵 comes back as 敢 + 問 + `、兵`), and the
 * character is the evidence either way. */
function pauseStandsBetween(fromId: number, toId: number, sentence: SentenceContext): boolean {
  for (const t of sentence.tokens) {
    if (t.id <= fromId || t.id > toId) continue;
    const chars = t.id === toId ? [...t.text].slice(0, 1) : [...t.text];
    if (chars.some((c) => CLAUSE_PAUSE_MARKS.has(c))) return true;
  }
  return false;
}

/** **A clausal complement the reader reaches only across a pause mark is read
 * where it stands, and the governor closes in front of it.**
 *
 * A 返読 crosses characters, not clauses. Where the editor has put a 、 between
 * a verb and the predicate hung off it as `comp:obj`/`comp:pred`, what follows
 * the mark is a fresh predication, and kundoku reads it as one — the governor
 * is said first and the clause after it, exactly as a quotation under 曰 is
 * (`isSpeechQuoteComplement`, which is this same shape one relation over and
 * which answers ahead of this rule for the two speech lemmas it owns).
 *
 * **Surveyed over the kanbun.info corpus** (3,419 passages, 0.3.5 parses), for
 * every `comp:obj`/`comp:pred` dependent that is a predicate — not a NOUN,
 * PROPN or NUM — and stands to the right of its governor. Which of the two
 * the received 書き下し文 says first was read off the two texts wherever it can
 * be read unambiguously: the governor's character occurring exactly once in
 * the received reading, against those characters of the clause that also occur
 * exactly once. 7,280 such arcs, of which 2,207 decide:
 *
 *             |    n   | 受 governor first | 受 clause first
 *   no mark   |  5,904 |             592   |          1,466
 *   pause     |  1,375 |             775   |              9
 *
 * That is 98.9% one way against 28.8% the other, and the split by token
 * distance says the mark is what carries it rather than the length: inside the
 * pause column the governor is read first 100% of the time at a distance of
 * 1-4 (12 decided), 98.8% at 5-9, 98.2% at 10-19 and 100% at 20 and over. **So
 * the condition is the mark alone, with no distance floor** — a floor would
 * throw away the short cases without buying any accuracy, and a pause mark
 * already implies a distance of 3 or more in all but three of the 1,375.
 *
 * Restricted to the arcs this app still inverts (the speech-verb rules above
 * having already claimed the rest, which are nearly all of 曰's 594) the pause
 * column is 357 against 9, and every one of the 728 stands on the parser tier:
 * on the gold tier the treebank hangs no clausal complement across a 、 that
 * something above has not already answered for.
 *
 * **The nine counterexamples** are 有…者 three times (rikutou53#6, #7, #10 —
 * 善く走る者有れば, an existential whose 有り is read last whatever stands in
 * front of it), a 若…者 of the same shape (rongo0115#1), two 得…助
 * (rikutou49#2, #6) and three one-off mis-attachments. None of them is a class
 * this can be keyed off: excluding an existential governor would give up 25
 * arcs the survey decides the other way to buy back 3, and excluding a 者-headed
 * complement 6 to buy back 4.
 *
 * **A NOUN or PROPN complement is not claimed**, and the exclusion is the one
 * `conjugationContext.ts`'s `isSpeechComplement` already makes for the same
 * reason: a nominal there is a name or an object, which returns like any other
 * object, and the naming rules above own the cases where it does not.
 *
 * The three things the new order has to agree with are named where they live:
 * `conjugationContext.ts`'s `isNominalizedObjectPredicate` stands down in front
 * of this (so the clause takes neither the を nor the 連体形 a nominalised
 * object takes, which after the mark would have been written behind the whole
 * clause), and `caseParticleFor`, `decideConjForm` and `negationEndingParts`
 * all read that one predicate. The 訓読文 needs nothing: `returningOrders` in
 * `reorderEngine.ts` writes a kaeriten for an INVERT child only, so a governor
 * that no longer returns to this clause no longer marks it. */
export function isClausalComplementAcrossPause(
  token: { id?: number; dep: string; pos: string },
  governor: GovernorContext | undefined,
  sentence?: SentenceContext,
): boolean {
  if (token.dep !== "comp:obj" && token.dep !== "comp:pred") return false;
  if (token.pos === "NOUN" || token.pos === "PROPN" || token.pos === "NUM" || token.pos === "PUNCT") return false;
  if (sentence === undefined || token.id === undefined) return false;
  const governorId = governor?.id;
  if (governorId === undefined || token.id <= governorId) return false;
  // Measured to the **left edge of the clause**, not to its head: 白晝如昏 hangs
  // 如 off a 欲 thirty tokens back and the clause begins at its subject 白, so
  // the mark that matters is the one before 白. Only the part of the subtree
  // that stands after the governor counts — a complement can reach back over
  // its own governor (a preposed subject, a shared 而 conjunct), and a mark on
  // the far side of the governor says nothing about the clause boundary here.
  let left = token.id;
  for (const id of subtreeOf(token.id, sentence)) {
    if (id > governorId && id < left) left = id;
  }
  return pauseStandsBetween(governorId, left, sentence);
}

/** Marks that end a sentence, which a 曰 hung off a verb across one is not
 * framed by that verb — 樊遲未達。子曰、… is two sentences the parser joined. */
const SENTENCE_CLOSING_MARKS = new Set(["。", "．", "？", "！"]);

/** **The 曰 whose quotation `token` is, when the treebank hangs the quotation
 * beside 曰 rather than under it** — the id of that 曰, or `undefined`.
 *
 * The treebank writes V之曰 with V as the head and 曰 as its `parataxis`, and
 * then very often attaches what is said to **V** as well: 夫子矢之曰：「予所否
 * 者，天厭之！」 has 厭 on `parataxis` of 矢, 大宰問於子貢曰：「夫子聖者與？」 has
 * 者 on `comp:obj` of 問, and 樊遲未達。子曰、舉直錯諸枉 has 舉 on `conj:coord`
 * of 達. 曰 itself has no complement, so nothing in `isSpeechQuoteComplement`
 * could see a quotation: 曰く was written (nothing made it a naming use), but
 * no と closed the quote, and a `comp:obj` of 問 inverted in front of 問 and
 * took を. Over the kanbun.info parses 曰 is `parataxis` **278** times. **97**
 * of those have no complement of their own and something on V standing after
 * them — the first sibling after 曰 is on `parataxis` 40 times, `conj:coord` 27,
 * `comp:obj` 29 and `dep` once — and **56** more have neither, their quotation
 * having been cut off into the next parsed sentence, where nothing here
 * reaches it.
 *
 * **What is said is whatever V governs after 曰**, because a sentence of the
 * form V + 曰 + X has no other place for X: V's own arguments are said before
 * 曰, and anything the source puts after 曰 is the words said. So the answer is
 * keyed on position, not on relation, with three refusals:
 *
 *  - **A 曰 that has a complement of its own frames nothing here.** Its
 *    quotation is that complement, and `isSpeechQuoteComplement` already
 *    answers for it; a further sibling after it (召舜曰、女謀事至、而言可績三年矣)
 *    is left as it was rather than guessed at.
 *  - **The nearest such 曰 decides**, so two framings on one verb each close
 *    their own quotation, and a sibling that is itself a 曰 is never a quote.
 *  - **Punctuation is never a quote.** A mark has no reading to hang と on.
 *
 * Only 曰 and not 云: 云 is `parataxis` 11 times in that corpus and has
 * anything after it on its verb twice (考其辭云、四爲正…), too few to know
 * whether the same reading holds. */
export function quoteFramingYue(
  token: { id?: number },
  sentence: SentenceContext | undefined,
): number | undefined {
  if (sentence === undefined || token.id === undefined) return undefined;
  const self = sentence.tokens.find((t) => t.id === token.id);
  if (!self || self.dep === "punct" || self.head === self.id) return undefined;
  if (self.lemma === "曰") return undefined;
  let nearest: SentenceContext["tokens"][number] | undefined;
  for (const t of sentence.tokens) {
    if (t.lemma !== "曰" || t.dep !== "parataxis" || t.head !== self.head) continue;
    if (t.id <= t.head || t.id >= self.id) continue;
    if (!nearest || t.id > nearest.id) nearest = t;
  }
  if (!nearest) return undefined;
  const yue = nearest;
  const hasOwnComplement = sentence.tokens.some(
    (t) => t.head === yue.id && t.id !== yue.id && (t.dep === "comp:obj" || t.dep === "comp:pred"),
  );
  return hasOwnComplement ? undefined : yue.id;
}

/** **The 曰 that hangs off the verb `tokenId` as its own clause's second
 * predicate**, if there is one — 之を誉めて曰く, 子貢に問ひて曰く, 之を命けて大紀と
 * 曰ふ. `conjugationContext.ts`'s `takesTeBeforeYue` asks this and then decides
 * whether the verb takes て; the question lives here, beside
 * `quoteFramingYue`, because both read the same V + `parataxis` 曰 shape.
 *
 * **A 曰 with a subject of its own, or a modifier, is its own clause and is
 * not joined to the verb before it.** 南宮适出，子曰 is 南宮适出づ。子曰く — the
 * 出 closes, a different speaker speaks — and 雖曰不要君 is 君を要せずと曰ふと
 * 雖も, where a て on the verb before 曰 would join what the 雖 is conceding.
 * So 曰 may govern only what it says or names and its punctuation: `punct`, the
 * two argument relations, and the two clause-joining relations a quotation
 * spreads over. A stop between the verb and 曰 refuses it too
 * (樊遲未達。子曰、…). */
export function parataxisYueOf(tokenId: number, sentence: SentenceContext): SentenceContext["tokens"][number] | undefined {
  return sentence.tokens.find(
    (yue) =>
      yue.lemma === "曰" &&
      yue.dep === "parataxis" &&
      yue.head === tokenId &&
      yue.id > tokenId &&
      !sentence.tokens.some((t) => t.id > tokenId && t.id < yue.id && SENTENCE_CLOSING_MARKS.has(t.text)) &&
      sentence.tokens.every(
        (t) => t.head !== yue.id || t.id === yue.id || FRAMED_YUE_CHILD_DEPS.has(t.dep),
      ),
  );
}

const FRAMED_YUE_CHILD_DEPS: ReadonlySet<string> = new Set([
  "punct",
  "comp:obj",
  "comp:pred",
  "parataxis",
  "conj:coord",
]);

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
 * **ADJ joins VERB and AUX in that second bound under parser 0.3.2**, which
 * recodes the stative class off VERB (see `isContentPredicatePos`). It has to
 * move with `conjugationContext.ts`'s `isCausedPredicateOf`, for the reason the
 * paragraph below already gives about 教: the two layers name one token, and a
 * caused predicate this half refused would have its しむ stranded in front of
 * the clause instead of after it. The reach is one gold token — a `parataxis`
 * dependent of the five causatives is VERB 171 / AUX 2 / **ADJ 1** / NUM 1 over
 * the recoded gold — and the point of the change is the agreement, not the one.
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
  return token.dep === "parataxis" && (isContentPredicatePos(token.pos) || token.pos === "AUX");
}

/** **能 read positively is the adverb 能く, and an adverb does not take its
 * complement in front of it.** True for the predicate a *non-negated* 能
 * governs, which therefore stays where the source put it: 事父母能竭其力 is
 * 父母に事へては**能く**其の力を竭くし, not 其の力を竭す**能ふ**.
 *
 * **能 is not the potential auxiliary this app used to read it as, and the
 * received text is unambiguous about it.** 能 stands **405** times in
 * kanbun.info's 白文 and **407** in the 書き下し文 beside it — it keeps its
 * character on every occurrence — and what is written after it is **く** on
 * roughly 250 of them and **はず** on the rest. あたわ and よく in kana appear
 * **zero** times, and べし never renders 能 at all. So the character has two
 * words, and they are not one paradigm:
 *
 *  - **positive: 能く**, an ordinary adverb standing in front of the predicate;
 *  - **negated: 〜こと能はず**, the 四段ハ行 verb あたふ, which *does* take the
 *    predicate in front of it, nominalized — 「言ふこと能はず」.
 *
 * The negated arm needs no rule here: with 能 out of `AUXILIARY_LEMMAS` it is
 * an ordinary predicate governing a `comp:aux`, that relation is in
 * `INVERT_DEPS`, and the inversion is what 能はず wants. It is the positive arm
 * that has to be exempted, and this is the exemption.
 *
 * **Keyed on the negation and not on the lemma alone**, which is the whole of
 * the split: of the 404 能 in the kanbun.info corpus's own parses, **151** carry
 * a `NEGATION_LEMMAS` child and 253 do not. 莫能 and 無能 are deliberately *not*
 * counted as negated — 莫 and 無 are the existential negation, which realises
 * its own predicate (「能く…する莫し」), and the 能 under it is the positive
 * adverb. That is the same line `COMPARATIVE_NEGATION_LEMMAS` in
 * `conjugationContext.ts` draws in the other direction and for its own reasons;
 * here the narrow set is the right one.
 *
 * `sentence` is optional and answering `false` without one is deliberate, for
 * the reason `isSpeechQuoteComplement`'s own optional parameter has: a caller
 * with no tree cannot ask about children, and the standing behaviour — an
 * inverting complement — is the safe fallback. */
export function isPositiveNengComplement(
  token: { dep: string },
  governor: GovernorContext | undefined,
  sentence?: SentenceContext,
): boolean {
  if (sentence === undefined || governor === undefined) return false;
  if (governor.lemma !== "能") return false;
  if (token.dep !== "comp:aux" && token.dep !== "comp:obj") return false;
  // A reading picked by hand takes the character out of the class, exactly as
  // it does for a negation and for a 再読文字's construction (`isNegationUse`,
  // `isRereadUse`, and `classifyToken`'s own first branch). A reader who pins
  // べし on a 能 is asking for the auxiliary this app used to make of it, and
  // an auxiliary does take its predicate in front of it.
  const self = sentence.tokens.find((t) => t.id === governor.id);
  if (self && storedReadingText(self) !== undefined) return false;
  return !nengIsNegated(governor, sentence);
}

/** Whether a 能 carries one of `NEGATION_LEMMAS` as its own `mod` child — the
 * one thing that tells 能はず from 能く. Written here rather than reusing
 * `conjugationContext.ts`'s `isNegationUse` for the reason `SPEECH_VERB_LEMMAS`
 * is duplicated above: that module imports this one. */
export function nengIsNegated(neng: { id?: number }, sentence: SentenceContext): boolean {
  if (neng.id === undefined) return false;
  // Not the inner 不 of 能不V, which negates the complement and leaves 能 the
  // adverb: 然後能不失天下 is 能く天下を失はず. See `auxiliaryComplementNegated`.
  return sentence.tokens.some(
    (t) =>
      t.head === neng.id &&
      t.id !== neng.id &&
      t.dep === "mod" &&
      NENG_NEGATION_LEMMAS.has(t.lemma) &&
      auxiliaryComplementNegated(t, sentence) === undefined,
  );
}

/** 不/未/弗/勿 — `conjugationContext.ts`'s own `NEGATION_LEMMAS`, restated here
 * because that module imports this one and the edge back would cycle. The same
 * duplication, and the same note, as `SPEECH_VERB_LEMMAS` above. */
const NENG_NEGATION_LEMMAS: ReadonlySet<string> = new Set(["不", "未", "弗", "勿"]);

/** **敢 over a predicate is the adverb 敢へて, read where it stands, and the
 * predicate is read straight on after it.** True for the `comp:aux` (or, with
 * no `comp:aux` beside it, `comp:obj`) a 敢 governs, which therefore does not
 * invert: 不敢當 is 敢へて當たらず, where the app read 當たる敢へず — the
 * predicate hauled in front of 敢 and 敢 conjugated as the verb あふ.
 *
 * **The received text has one reading for the character, and it is not a
 * verb.** 敢 stands **86** times in kanbun.info's 白文 and its 書き下し文 writes
 * **敢えて 81** times; the other five are 果敢 (3) and two passages the site
 * paraphrases. 敢え with any other kana after it, 敢ふ and 敢う appear **zero**
 * times. So unlike 能, which is 能く read positively and 能はず read negated (see
 * `isPositiveNengComplement`), 敢 has one word under a negation and outside
 * one: 不敢 41 in the 白文, 莫敢 9, 未敢 2, 無敢 1, and every one of them is
 * 敢えて with the negation closing the predicate after it — 敢えて帰らず, 敢えて
 * 先ず挙ぐる莫し, 敢えて慢る無し, 未だ敢えて先ず発せず. **So this is not keyed on
 * the negation**, where the rule for 能 has to be.
 *
 * **What the negation on 敢 closes is the complement**, and that half is
 * `reorderEngine.ts`, which folds the complement into 敢's own run ahead of the
 * negation (see `ganInPlace` there). The parse hangs the negation off 敢 and
 * not off the verb — **55 of the 56** 不/莫/未/無/非 written straight before a
 * 敢 in the corpus parses, the odd one out being 無敢慢, where 無 heads 敢 — so
 * read by the relation alone it would stand straight after 敢 (敢へず當たる),
 * which is the verb this rule exists to take away.
 *
 * **The tree is uniform.** In the corpus parses 敢 is AUX `v,助動詞,願望,*` on
 * all 86 tokens, and the predicate hangs off it as `comp:aux`; `comp:obj` stands
 * in for it in a handful (施令而下不敢犯, with 犯 as `comp:obj`), which is why
 * that relation is admitted too. Neither is inverted any more, and that is also
 * right for a `comp:obj` the parser hangs off 敢 across a comma — 敢問、兵可使
 * 如率然乎 is 敢へて問ふ、兵は率然の如くならしむ可きか, the question read after
 * 問ふ, where it had been hauled in front of it.
 *
 * A reading picked by hand takes the character out of the class, as for 能: a
 * reader who pins a verb on 敢 gets the verb, and a verb takes its complement in
 * front of it. `sentence` is optional for the reason it is optional on
 * `isPositiveNengComplement`. */
export function isGanComplement(
  token: { dep: string },
  governor: GovernorContext | undefined,
  sentence?: SentenceContext,
): boolean {
  if (sentence === undefined || governor === undefined) return false;
  if (token.dep !== "comp:aux" && token.dep !== "comp:obj") return false;
  return ganReadsAsAdverb(governor, sentence);
}

/** Whether a 敢 is the adverb 敢へて — its lemma, and no reading picked by hand
 * on it. Shared by `isGanComplement` (the position of what 敢 governs),
 * `reorderEngine.ts` (where a negation on 敢 is read) and `ganAdverbReading` in
 * `conjugationContext.ts` (the reading itself), so the three cannot disagree
 * about which tokens are in the class. */
export function ganReadsAsAdverb(gan: { id?: number; lemma: string }, sentence: SentenceContext): boolean {
  if (gan.lemma !== GAN_LEMMA || gan.id === undefined) return false;
  const self = sentence.tokens.find((t) => t.id === gan.id);
  return !(self && storedReadingText(self) !== undefined);
}

const GAN_LEMMA = "敢";

/** **A negation written between an auxiliary and its complement negates the
 * complement**, whichever of the two the parse hangs it on. Returns that
 * complement, or `undefined` for any other negation.
 *
 * 不可不察 is 察せざる可からず: the first 不 denies 可 and the second negates 察,
 * so what reads is 察・不・可・不. The parse hangs **both** negations off 可 —
 * every one of the **27** 不/弗 standing between a 可 and its complement in the
 * kanbun.info corpus parses, and the 7 between a 敢 and its complement (不敢不告,
 * 莫敢不敬) too — so read by the relation the inner 不 postposed past 可 beside
 * the outer one, and 知る可からずざる came out of 不可不知 where the site writes
 * 知らざる可からざる. kanbun.info reads the construction 〜ざる可から on all
 * **24** of its occurrences (ざる可からず 16, ざる可からざ 8).
 *
 * **Position is what says so, and it is uniform.** A negation the source puts
 * *before* the auxiliary (the 不 of 不可) scopes over the auxiliary, and one it
 * puts after the auxiliary and before the complement can only be scoping over
 * the complement. The corpus parses have **38** 不/弗 of the second kind (可
 * 27, 敢 7, 欲 3, 能 1), and every received reading of them negates the
 * complement: 亦可以弗畔矣夫 is 以て畔かざる可きか, 然後能不失天下 能く天下を失わず,
 * 欲不欲 欲せざるを欲し, 欲不與 与えざらんと欲す.
 *
 * **Only a `mod` 不/弗, and only an AUX head.** 未 is a 再読文字 and reads twice
 * where it stands; 非/無/莫 close a predicate of their own. The complement is
 * first `comp:aux` of the auxiliary, or with none its first `comp:obj`, the
 * choice `isGanComplement` makes; a stop between the negation and the
 * complement ends it, as a kaeriten returns within a 句. **敢 is left out**: a
 * negation on 敢 already closes the predicate 敢へて introduces (the 敢 fold in
 * `reorderEngine.ts`, which puts the inner one first), and moving the inner one
 * a second time would take it out of the run that fold builds.
 *
 * Shared by `reorderEngine.ts` (where the negation is read) and
 * `negationEndingParts` in `conjugationContext.ts` (the slot it answers to), so
 * the two cannot disagree about which predicate the negation closes. */
export function auxiliaryComplementNegated<
  T extends { id: number; head: number; dep: string; lemma: string; pos?: string; misc?: Record<string, string> },
>(token: T, sentence: { tokens: readonly T[] }): T | undefined {
  if (token.dep !== "mod" || !INNER_NEGATION_LEMMAS.has(token.lemma)) return undefined;
  if (chosenReadingText(token) !== undefined) return undefined;
  const aux = sentence.tokens.find((t) => t.id === token.head && t.id !== token.id);
  if (!aux || aux.pos !== "AUX" || aux.id > token.id || aux.lemma === GAN_LEMMA) return undefined;
  const kids = sentence.tokens.filter((t) => t.head === aux.id && t.id !== aux.id);
  const complement = kids.find((t) => t.dep === "comp:aux") ?? kids.find((t) => t.dep === "comp:obj");
  if (!complement || complement.id < token.id) return undefined;
  if (sentence.tokens.some((t) => t.dep === "punct" && t.id > token.id && t.id < complement.id)) return undefined;
  return complement;
}

/** 不 and 弗 — the verbal negations that read ず where they close and nothing
 * where they stand. See `auxiliaryComplementNegated`. */
const INNER_NEGATION_LEMMAS: ReadonlySet<string> = new Set(["不", "弗"]);

/** **奈何 / 如何 / 若何 / 何如 — one word, いかん, and not a verb with an
 * object.** True for the 何 of the idiom, which therefore neither inverts
 * before the character beside it nor takes a case particle of its own.
 *
 * The app read 奈何 as 何**を**奈 — the interrogative pronoun made the object of
 * a comparison verb, jumped in front of it and marked accusative — which is
 * **43 occurrences** over the kanbun.info corpus and the largest single class
 * left in its parsed tier. The received text writes the two characters in
 * source order and keeps both: **奈何 83, 何如 22, 如何 37, 何若 2** in
 * kanbun.info's 書き下し文, against **いかん in kana 0**. What follows them is an
 * ending — せん 17, ぞ 10, ともする 3 — or nothing at all, never a particle.
 *
 * **The shape is uniform in the parses and that is what this keys on.** Over
 * the corpus's own trees the 何 is `comp:obj` of an adjacent 奈/如/若 in **119
 * of 120** occurrences, tagged PRON `n,代名詞,疑問,*` against a governor tagged
 * `v,動詞,行為,分類` — the treebank's comparison class, the same one
 * `isComparativeYu` in `conjugationContext.ts` reads. 81 have the 何 after the
 * governor (奈何, 如何, 若何) and 22 before it (何如); both orders are the same
 * word and both are left where the source put them.
 *
 * **Adjacency is required**, and is what keeps this off a real question: 何 is
 * an ordinary interrogative object elsewhere (何憂何懼 — 何をか憂へ何をか懼れん),
 * and only the two characters written side by side are the idiom.
 *
 * **The preposed order needed no rule before this and still gets one.**
 * `caseParticleFor`'s comparison branch already withheld the の from a preposed
 * `comp:obj` of 如 by way of `isInterrogativeStem`, so 何如 came out unmarked by
 * a different route. Stating both orders here puts one rule where there were
 * one and a half, and means the postposed order cannot drift away from the
 * preposed one.
 *
 * **Nothing suppresses kaeriten across the pair, because nothing needs to.** A
 * kaeriten marks a jump in reading order; with the complement no longer
 * inverting there is no jump, and `computeReadingOrder` emits no mark. */
export function isIkanIdiom(
  token: { id?: number; dep: string; lemma: string; pos: string },
  governor: GovernorContext | undefined,
  sentence?: SentenceContext,
): boolean {
  if (token.lemma !== "何" && token.lemma !== "之") return false;
  if (token.pos !== "PRON") return false;
  if (token.dep !== "comp:obj" && token.dep !== "comp:pred") return false;
  if (!governor || !IKAN_GOVERNOR_LEMMAS.has(governor.lemma)) return false;
  if (!(governor.xpos ?? "").startsWith(IKAN_GOVERNOR_XPOS)) return false;
  if (token.id === undefined || governor.id === undefined) return false;
  const gap = token.id - governor.id;
  if (Math.abs(gap) === 1) return token.lemma === "何";
  // **如之何 — the same word with a 之 inside it.** 如之何 stands 20 times in
  // the kanbun.info 白文 and the received reading writes it 如何, the 之 not
  // read at all; this app prints the character it is given, so 如之何 is what
  // comes out, and what matters is that all three read in source order with no
  // particle between them. It read 之の何と如し before. Both the 何 and the 之
  // are the word here, which is why this admits either lemma.
  if (gap !== 2 || !sentence) return false;
  const governorId = governor.id;
  const inner = sentence.tokens.find((t) => t.id === governorId + 1);
  return !!inner && inner.lemma === "之" && inner.head === governorId;
}

/** 奈 / 如 / 若 — the three characters that spell いかん beside 何 (or beside
 * 之何). */
const IKAN_GOVERNOR_LEMMAS: ReadonlySet<string> = new Set(["奈", "如", "若"]);

/** `v,動詞,行為,分類` — the treebank's comparison class, which every one of the
 * 120 idiom governors carries. The same tag `isComparativeYu` reads in
 * `conjugationContext.ts`, and what keeps this off the conditional もし (ADV
 * `v,副詞,判断,推定`) and the 申申如也 suffix (PART). */
const IKAN_GOVERNOR_XPOS = "v,動詞,行為,分類";

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
  if (isNominalNegationPostpose(token, governor)) return "postpose";
  if (isPredicateNegationPostpose(token, governor, sentence)) return "postpose";
  // Above the construction exceptions below rather than beside them: those say
  // what a particular relation means, and this says that the token is not an
  // argument at all — a closing particle, whatever relation the parse reached
  // for. See `isClosingParticleInPlace`, and 君飲嘗不醉否 there.
  if (isClosingParticleInPlace(token, sentence)) return "no-invert";
  if (isSpeechQuoteComplement(token, governor, sentence)) return "no-invert";
  if (isPositiveNengComplement(token, governor, sentence)) return "no-invert";
  if (isGanComplement(token, governor, sentence)) return "no-invert";
  if (isIkanIdiom(token, governor, sentence)) return "no-invert";
  if (isGenitiveComplement(token, governor)) return "no-invert";
  if (isCausedPredicateParataxis(token, governor)) return "invert";
  if (isYiOfAuxiliary(token, governor)) return "invert";
  // **Last of the construction exceptions, and below every one of them.** Each
  // of those is a claim about a particular governor — 曰, 能, 敢, 如, a genitive
  // 之, a causative, the 以 of a modal — where this is a claim about the
  // *editor's mark*, and a claim about a word is the more specific of the two.
  // Two of them would actually be contradicted rather than merely duplicated:
  // `isSpeechQuoteComplement` owns the 曰/云 quotations, which are this same
  // shape and which read in place *and* close with と, and `isYiOfAuxiliary`
  // keeps an 以 adjacent to the complement it introduces. The four that also
  // answer "no-invert" are unaffected by the order and are above it for rank
  // rather than for precedence.
  if (isClausalComplementAcrossPause(token, governor, sentence)) return "no-invert";
  // Last of the exceptions, and deliberately after the four above: each of
  // them is a claim about a particular construction, where this one only says
  // that `classifyDep`'s answer for `subj` rests on a premise this token
  // breaks. None of the three can be reached by a `subj` anyway (they are
  // keyed on comp:*/parataxis/以), so the order is a statement of rank rather
  // than a live precedence.
  if (isPostposedSubject(token, governor, sentence)) return "invert";
  // Beside it rather than above it, and for the same reason: this too only
  // says that `classifyDep`'s answer for plain `mod` rests on a premise this
  // token breaks. The two cannot both fire (one is keyed on `subj`, the other
  // on `mod`), so the order between them is a statement of rank, not a
  // precedence — and both stand below the construction rules above.
  if (isPostposedComparisonStandard(token, governor, sentence)) return "invert";
  return classifyDep(token.dep);
}
