import type { Sentence, Token } from "../parse/types.ts";
import { governedPredicate, isRereadUse } from "../kakikudashi/rereadCharacters.ts";
import type { CompoundSpan } from "../reading/jmdictLookup.ts";
import type { ReadingPlan, SpliceGroup } from "./types.ts";
import { auxiliaryComplementNegated, classifyToken, ganReadsAsAdverb, isConcessivePostpose, isGanComplement, isNegatedBareReport, isNominalNegationPostpose, isPredicateNegationPostpose, isSpeechQuoteComplement, quoteFramingYue } from "./depClassification.ts";
import { carrierOf } from "./spanCarrier.ts";
import { TITLE_CLOSE, TITLE_OPEN, titleSpansOf } from "../parse/punctuation.ts";

/** Recursively computes the Japanese reading-order permutation of a
 * sentence's dependency tree, and the set of INVERT splice points
 * (kundoku-ten jumps) encountered along the way.
 *
 * `spans` (optional — defaults to none) are multi-token lexical/orthographic
 * units (see `findCompoundSpans`) that must stay contiguous in the output
 * regardless of what the dependency tree itself says: each span's non-
 * carrier members (see `carrierOf`) are never added to the tree walk as
 * their own independent child — a span's *carrier* alone is placed
 * according to its own head/dep, and wherever the carrier would normally be
 * emitted as a single token id, the whole span's token ids are emitted
 * together in source order instead. This is what keeps e.g. 遠方 together
 * even though the real parse attaches 遠 and 方 to two different governors.
 *
 * Dropping a non-carrier member from the walk must not drop what hangs off
 * it. It is only the member's *own* placement the carrier takes over, not
 * its dependents: a token whose head is a non-carrier member is re-parented
 * onto the carrier (`attachmentPoint` below) so the walk still reaches it.
 * 而家豪富、不以飲為累也 is the case that showed this — 豪富 is one span, 為
 * hangs off 富 (the non-carrier half), and with 富 absent from the walk
 * nothing reached 為, so 不以飲為累也 was silently absent from both panels.
 * Re-parenting rather than visiting the member separately is what the span
 * already means: 豪富 is one word, its dependents are that word's, and the
 * one position that word occupies is the carrier's. */
/** A postpose-classified token (negation, a modal auxiliary, 雖...) is
 * meant to jump past the one verb it actually negates/scopes over — but
 * this treebank sometimes chains several bare ADV `mod` adverbs together
 * (不復挺 parsed as 不→mod→復→mod→挺, not both 不 and 復 attached directly to
 * 挺 as siblings) instead of attaching each pre-verbal adverb straight to
 * the verb. Left as-is, postposing 不 relative to its literal head 復 only
 * swaps their order (復不, stranding 不 before the real verb 挺 it negates)
 * instead of reaching past it. This walks up through a chain of plain
 * ADV+mod links to find the token's *effective* attachment point for
 * reading-order purposes only — the real dependency tree (spans, everything
 * else) is untouched. */
function resolveEffectiveHead(token: Token, byId: Map<number, Token>, sentence: Sentence): number {
  if (classifyToken(token) !== "postpose") return token.head;
  // The inner negation of 不可不察 hangs off 可 and negates 察: it is read with
  // the complement, before the auxiliary. See `auxiliaryComplementNegated`.
  const complement = auxiliaryComplementNegated(token, sentence);
  if (complement) return complement.id;
  let headId = token.head;
  for (;;) {
    const head = byId.get(headId);
    if (!head || head.id === head.head || head.dep !== "mod" || head.pos !== "ADV") return headId;
    headId = head.head;
  }
}

/** One run of token ids that moves as a unit, tagged with where it belongs in
 * the source text.
 *
 * Reading order is not a free linearization of the tree. Kundoku's contract is
 * that the text is read in source order except at the jumps a kunten mark
 * names, and a kaeriten can only ever say "read the block below first, then
 * come back up to this one character": a return mark defers a single governor
 * and the deferred governors come back innermost-first. So the only run that
 * may travel is a governor together with what is spliced onto it; everything
 * else has to stay where the text put it.
 *
 * `expand` used to emit each child's whole subtree contiguously, which assumes
 * a subtree occupies a contiguous stretch of source — true of a projective
 * tree, false in general. 長山劉氏、體肥嗜飲 with the subject 劉 attached to
 * the second conjunct 嗜 is the case that showed it: 嗜's subtree is
 * 長山劉氏、…飲嗜, which straddles 體肥, so emitting it as one block read 體肥
 * before 長山劉氏. No kaeriten can express that — it would have to hold five
 * leading characters back and then give them again in their own order — so
 * `kundokuTenAssigner` marked none of it and the 訓読文 panel went on saying
 * 長山劉氏、體肥え飲を嗜む while the prose said something else.
 *
 * Merging atoms by `key` instead leaves unmarked material where the source put
 * it, so what the panels show can always be marked. On a projective tree every
 * child's atoms fall wholly on one side of its governor and the merge
 * reproduces the old concatenation exactly. */
interface Atom {
  /** First source position of the governor's own word — where this run
   * belongs in the text. Unique across a sentence's atoms: each is keyed by
   * the start of one governor's emitted span, and a span has one carrier. */
  key: number;
  ids: number[];
}

const idsOf = (atoms: readonly Atom[]): number[] => atoms.flatMap((a) => a.ids);

/** A mark of punctuation, by what it *is* rather than by what the parse says
 * it does. The upos tag alone would miss a mark tagged something else, and
 * the relation alone would miss one the parse hung off a word as an ordinary
 * modifier — which happens: the first 、 of 解縛視之、赤肉長三寸許 arrives
 * `mod` of 肉 rather than `punct` of anything, and it is a comma either way.
 * (That is a mis-annotation and should be fixed in the treebank; this
 * predicate is not here to paper over it, but a rule about where marks are
 * read has no business asking which of the two tags a mark happens to carry.) */
function isMark(token: Token): boolean {
  return token.pos === "PUNCT" || token.dep === "punct";
}

/** Where a mark of punctuation is **read**, as against where the tree walk
 * left it.
 *
 * A mark divides the text: what stands before it in the source is what it
 * closes off. That is a statement about *source* positions, and the walk
 * above places every atom by one — but an atom's key is the start of its
 * governor's own word, and an INVERT child's whole subtree travels inside
 * that atom. So a mark falling between an inverted child and the governor it
 * returns to sorts *ahead* of material the source put in front of it, and the
 * mark comes out one element early.
 *
 * 解縛視之、赤肉長三寸許… is the case. 解 is an INVERT child of 肉, and 赤肉
 * is one compound span, so the run 縛-解-之-視 is carried in the atom keyed at
 * 赤 (source position 5); the 、 at source position 4 sorts in front of that
 * atom and the sentence opened 、縛を解きこれを視る赤肉にして — the comma
 * before the very clause it closes.
 *
 * So the mark is placed by reading order rather than by source order. The rule
 * this file first carried was "it follows the last token *read* out of
 * everything the source put before it", which settles 解縛視之、赤肉… — but it
 * is right only while the interleaving runs one way, and **it fails whenever an
 * inversion carries a pre-mark token past a post-mark one**, because the anchor
 * is dragged along with it.
 *
 * 若決積水於千仞之谿者、形也 is that case. 若 is read last of its clause, so
 * "the last token read out of everything before the 、" is 若 — which reading
 * order has already put *after* 形, material the source placed after the mark.
 * The sentence came out 決むる者は形の若し、なり: a comma wedged between 形 and
 * the 也 that predicates it. **kanbun.info writes no mark before なり anywhere:
 * 0 of 1,457.**
 *
 * **So the mark takes the cut fewest tokens cross.** It divides the source in
 * two; score every slot in reading order by how much material lands on the
 * wrong side of it — pre-mark tokens read after the slot, post-mark tokens read
 * before it — and take the cheapest, ties to the earliest. Where nothing has
 * moved across the mark, every pre-mark token precedes every post-mark one, the
 * cut through that boundary costs nothing, and the answer is the same token the
 * old rule gave; that is why this is safe to apply to every mark in every
 * sentence. Where something has moved, it is the cut that best keeps apart the
 * two halves the mark itself divides.
 *
 * Measured over the whole kanbun.info corpus against the received prose, both
 * anchors rendered in one process and scored through the corpus test's own
 * fold: **1,078 passages move, 822 closer and 89 further**, the gold tier
 * 10,412 → 10,377 (**−35**) and the parser tier 68,710 → 66,791 (**−1,919**),
 * and the 、なり sites fall from 126 to 14. The old anchor's gold total in that
 * run reproduces the banked baseline to the edit, which is what says the two
 * sides differ in the anchor and in nothing else. The nudge that was tried first — leave the anchor alone and merely
 * push a mark past a following 也/矣/焉 — is **rejected and should not be tried
 * again**: it moved 176 passages, 5 closer against 120 further (gold +23,
 * parser +119), because one slot to the right is not where the mark belongs
 * either. The fault was never the last step; it was the anchor.
 *
 * A permutation, and only that: every id goes back in exactly once, so the
 * coverage check below still guards the walk. Marks anchored to the same
 * token keep their source order among themselves (a ： and the 「 after it).
 * A mark that governs anything of its own keeps its dependents where the walk
 * put them — only the mark itself travels — which is right for the empty case
 * and is the only case there is.
 *
 * **《》 is the exception, because it is a wrapper and not a divider.** Every
 * rule above is about a mark that *closes off what precedes it* — a comma, a
 * full stop, a closing quote — and "the last token read out of that material"
 * is the right anchor for one. A 書名号 is not that: it is a pair drawn round a
 * title, and what it belongs to is the title, wherever reading order has put
 * it. 始可與言《詩》已矣 is the case — 詩 is 言's `comp:obj` and inverts in front
 * of it, and both brackets stayed behind with some low-id token that happened
 * to be read very late, printing 詩 in one place and 《》 together in another.
 *
 * So a title's brackets are anchored to **its own content**: 《 immediately
 * before the first-read token inside it and 》 immediately after the last-read
 * one. See `titlePairsOf`, which does the pairing; which tokens count as inside
 * is `titleSpansOf`'s answer and not re-derived here. The nesting, the stray
 * 》 and the unclosed 《 are all handled there, and anything that falls through
 * it — a stray 》, a title with no readable content — takes the general rule
 * above unchanged, so the permutation guarantee is untouched either way. */
function placeMarks(order: number[], sentence: Sentence): number[] {
  const byId = new Map(sentence.tokens.map((t) => [t.id, t]));
  const marks = order.filter((id) => isMark(byId.get(id)!));
  if (marks.length === 0) return order;

  const markIds = new Set(marks);
  const rest = order.filter((id) => !markIds.has(id));
  const positionOf = new Map(rest.map((id, i) => [id, i]));

  // The title brackets, anchored to their content before anything else is
  // anchored to a source position. `before` holds what is emitted immediately
  // *ahead* of a `rest` index, which no other mark needs.
  const before = new Map<number, number[]>();
  const afterTitle = new Map<number, number[]>();
  const wrapped = new Set<number>();
  for (const title of titlePairsOf(sentence.tokens)) {
    const inside = title.inside.map((id) => positionOf.get(id)).filter((i): i is number => i !== undefined);
    if (inside.length === 0) continue;
    const first = Math.min(...inside);
    const last = Math.max(...inside);
    (before.get(first) ?? before.set(first, []).get(first)!).push(title.open);
    wrapped.add(title.open);
    if (title.close !== undefined) {
      (afterTitle.get(last) ?? afterTitle.set(last, []).get(last)!).push(title.close);
      wrapped.add(title.close);
    }
  }
  // -1 is "before everything", for a mark the source put ahead of every word
  // this sentence reads — a 」 stranded at the head of its own sentence.
  //
  // **The cut fewest tokens cross.** A mark divides the source in two, and in
  // reading order those two halves may interleave; the slot to put the mark in
  // is the one that keeps them apart best. Every slot is scored by how much
  // material ends up on the wrong side of it — pre-mark tokens read after it,
  // post-mark tokens read before it — and the cheapest wins. See the doc above
  // for why the older "after the last-read token of everything before it" rule
  // is the special case of this, and where it broke.
  //
  // Ties go to the **earliest** slot — a mark closes off its material as soon
  // as that material is complete — and **that was measured, not reasoned**.
  // Over the kanbun.info corpus, earliest reads gold 10,377 / parser 66,791
  // against latest's 10,381 / 66,843, and leaves 14 of the 、なり sites where
  // latest leaves 22. Ties are common and they do not all want the same answer:
  // 若決積水於千仞之谿者、形也 wants the earlier cut and 劉答言：「無。」 wants the
  // later one, so one of the two has to lose whichever way this goes. It is
  // 劉答言, pinned in `kakikudashi-generator.test.ts` under its own name.
  //
  // Walked as a running cost rather than rescored per slot — moving the cut one
  // token to the right changes exactly one token's side, so the whole sweep is
  // linear in `rest` for each mark.
  //
  // **Which side of the mark a token counts on is its source side, with one
  // exception**: the coordinating 與 that opens the second conjunct counts
  // with what precedes the mark. See `coordinatorClosingFirstConjunct`.
  const preMark = (id: number, markId: number): boolean =>
    id < markId || coordinatorClosingFirstConjunct(id, markId, sentence, byId);
  const anchorOf = (markId: number): number => {
    let after = 0; // pre-mark by `preMark`, already left of the cut
    let before = rest.reduce((n, id) => n + (preMark(id, markId) ? 1 : 0), 0); // still right of it
    let best = -1;
    let bestCost = after + before;
    for (let i = 0; i < rest.length; i++) {
      if (!preMark(rest[i], markId)) after++;
      else before--;
      const cost = after + before;
      if (cost < bestCost) {
        bestCost = cost;
        best = i;
      }
    }
    return best;
  };
  const anchored = new Map<number, number[]>();
  for (const markId of [...marks].sort((a, b) => a - b)) {
    if (wrapped.has(markId)) continue;
    const anchor = anchorOf(markId);
    const at = anchored.get(anchor) ?? [];
    at.push(markId);
    anchored.set(anchor, at);
  }

  const placed: number[] = [...(anchored.get(-1) ?? [])];
  for (let i = 0; i < rest.length; i++) {
    // Source order among brackets at one slot puts the outer 《 first and the
    // inner 》 first, which is the nesting written back out: an outer 《 has the
    // smaller id of the two opens, and an inner 》 the smaller of the two
    // closes.
    for (const markId of (before.get(i) ?? []).sort((a, b) => a - b)) placed.push(markId);
    placed.push(rest[i]);
    for (const markId of (afterTitle.get(i) ?? []).sort((a, b) => a - b)) placed.push(markId);
    for (const markId of anchored.get(i) ?? []) placed.push(markId);
  }
  return placed;
}

/** The coordinators read と **in their own place**, ahead of the conjunct they
 * introduce. 與 and its 新字体 与, the set `coordinationClosingParticle`
 * (conjugationContext.ts) keys its second と on. */
const TO_COORDINATORS: ReadonlySet<string> = new Set(["與", "与"]);

/** True when `id` is **a coordinating 與 standing just past `markId`** — the
 * 與 of A、與B, which `placeMarks` counts on the *near* side of the mark.
 *
 * **The と of 與 belongs to the first conjunct.** The app reads A與B as AとBと:
 * 與 itself is the first と, read in its source place, and
 * `coordinationClosingParticle` adds the second after B. The source puts the
 * mark between A and 與, so the cut through the source boundary put it between
 * A and that と, and 夫不可陷之楯、與無不陷之矛 came out 楯、と…矛とは, where
 * kanbun.info writes 陥す可からざるの楯と、陥さざる無きの矛とは. In kundoku the
 * mark that separates two conjuncts falls after the と of the first one,
 * because the と is the case the first conjunct stands in, and a と opening a
 * phrase after a comma is a quotative と and nothing else.
 *
 * **Measured** over the kanbun.info corpus. The received 書き下し文 writes 、と
 * **342** times, and every one of the 342 closes a quotation (…無かれ、と。).
 * Where the source has A、與B and the received reading coordinates the two,
 * the と comes before the mark each time it keeps the mark: 冕衣裳の者と、瞽者とを
 * (論語 子罕), 以て戦う可きと、以て戦う可からざるとを (孫子 謀攻), 功名を就すの説と、
 * 夫の百家衆技の流れ (大学章句序). The fourth, 元士の適子と凡民の俊秀とに (the
 * same 序), drops the mark and keeps the order.
 *
 * **Drawn as narrowly as the shape**, and each condition is there to keep
 * the other 與 out:
 *
 *  - `cc` and nothing else. The comitative 與X V (與朋友交, 與敵相當) and 與其…
 *    stand on `mod` or `comp:obl` and are read after their object, so their
 *    と already follows the phrase and never meets the mark. Of the 59 A、與B
 *    shapes in the corpus 白文, the parser makes 與 `cc` in **3**, and all three
 *    are comitatives it took for coordination (尾生、與女子期 among them);
 *    `coordinationClosingParticle` already gives those the second と, so the
 *    first と is put where that reading of the tree wants it.
 *  - Its head is a `conj` standing past the mark and **its head's own head
 *    stands before it**, so the mark is the one that separates the conjuncts
 *    rather than one inside the second conjunct.
 *  - Nothing but marks between the mark and the 與, so that in A、B與C the
 *    mark after A, which divides A from B, is left where it was.
 *
 * Asked about source ids, not about reading order, because `placeMarks` scores
 * a cut by source sides and this only changes which side one token is on. No
 * token moves, only the mark, and the 訓読文 draws every mark in its own
 * source cell, so what changes is the 書き下し文. */
function coordinatorClosingFirstConjunct(
  id: number,
  markId: number,
  sentence: Sentence,
  byId: ReadonlyMap<number, Token>,
): boolean {
  if (id <= markId) return false;
  const token = byId.get(id);
  if (!token || token.dep.split("@")[0] !== "cc") return false;
  if (!TO_COORDINATORS.has(token.text) && !TO_COORDINATORS.has(token.lemma)) return false;
  const conjunct = byId.get(token.head);
  if (!conjunct || conjunct.id <= markId || !conjunct.dep.startsWith("conj")) return false;
  const first = byId.get(conjunct.head);
  if (!first || first.id >= markId) return false;
  return sentence.tokens.every((t) => t.id <= markId || t.id >= id || isMark(t));
}

/** Each 《…》 in a sentence, as the pair of bracket ids and the ids of the
 * tokens they hold — the pairing `titleSpansOf` does not report, since a panel
 * asking "is this token inside a title" does not need to know which title.
 * `placeMarks` does: it anchors each bracket to its own content.
 *
 * **Which tokens count as inside is `titleSpansOf`'s**, asked once here rather
 * than re-derived, so the two cannot disagree about a nested or unbalanced run.
 * What this adds is only the stack that says which 》 closes which 《.
 *
 * The three awkward cases, and each is a bound rather than a repair — the same
 * position `titleReader` takes:
 *
 *  - **Nested.** 《甲《乙》丙》 is two pairs; the outer's content includes the
 *    inner's, so the outer's brackets land outside the inner's wherever reading
 *    order puts them.
 *  - **Unclosed 《.** It gets a pair with no `close`, holding everything
 *    `titleSpansOf` calls inside — which that function runs to the end of the
 *    sentence. The 《 is placed and no 》 is invented.
 *  - **Stray 》.** Nothing is open, so nothing is paired and the mark is left to
 *    `placeMarks`' general rule, which places it as it always did.
 *
 * Walked in source order, which a caller is not required to hand its tokens
 * over in. */
function titlePairsOf(tokens: readonly Token[]): { open: number; close?: number; inside: number[] }[] {
  const { inside } = titleSpansOf(tokens);
  const pairs: { open: number; close?: number; inside: number[] }[] = [];
  const open: number[] = [];
  for (const token of [...tokens].sort((a, b) => a.id - b.id)) {
    if (token.text === TITLE_OPEN) {
      pairs.push({ open: token.id, inside: [] });
      open.push(pairs.length - 1);
      continue;
    }
    if (token.text === TITLE_CLOSE) {
      const i = open.pop();
      if (i !== undefined) pairs[i].close = token.id;
      continue;
    }
    if (!inside.has(token.id)) continue;
    for (const i of open) pairs[i].inside.push(token.id);
  }
  return pairs;
}

/** The relations by which one clause continues after another — what a
 * 再読文字's own clause is bounded by. See `coordinatedAway`. */
const CLAUSE_CONTINUATION_DEPS: ReadonlySet<string> = new Set(["conj:coord", "conj:coord@emb", "parataxis"]);

export function computeReadingOrder(sentence: Sentence, spans: CompoundSpan[] = []): ReadingPlan {
  const children = new Map<number, Token[]>();
  const byId = new Map(sentence.tokens.map((t) => [t.id, t]));
  let rootId: number | undefined;

  const spanOf = new Map<number, CompoundSpan>();
  for (const s of spans) for (const id of s.tokenIds) spanOf.set(id, s);
  const carrierIdOfSpan = new Map<CompoundSpan, number>();
  for (const s of spans) carrierIdOfSpan.set(s, carrierOf(s, sentence).id);

  /** Where a token attaching to `headId` actually joins the walk. A head
   * inside a span is that span's carrier, which is the only member the walk
   * visits — see the span note in this function's own doc. Any other head is
   * itself. */
  const attachmentPoint = (headId: number): number => {
    const span = spanOf.get(headId);
    if (!span) return headId;
    return carrierIdOfSpan.get(span) ?? headId;
  };

  for (const token of sentence.tokens) {
    if (token.head === token.id) {
      rootId = token.id;
      continue;
    }
    // A non-carrier span member is never added as an independent tree
    // child of its own head — its position is entirely determined by the
    // carrier's placement (see the `emit` step in `expand` below), so the
    // head it happens to carry in the source parse (which may point
    // somewhere the *other* span member doesn't) is never consulted.
    const span = spanOf.get(token.id);
    if (span && carrierIdOfSpan.get(span) !== token.id) continue;

    const effectiveHead = attachmentPoint(resolveEffectiveHead(token, byId, sentence));
    const siblings = children.get(effectiveHead);
    if (siblings) siblings.push(token);
    else children.set(effectiveHead, [token]);
  }

  if (rootId === undefined) {
    throw new Error("Sentence has no ROOT token (no token with head === id)");
  }

  const spliceGroups: SpliceGroup[] = [];
  const quoteEndIds = new Set<number>();
  /** Where each 再読文字's second reading is emitted: the last token of the
   * clause it governs, mapped to the re-read tokens closing there. */
  const rereadCloseIds = new Map<number, number[]>();

  // The last *non-punctuation* token of an order array — used both for a
  // speech-quote complement's own subtree (where the trailing ト attaches;
  // real kanbun convention closes a quote there, not on a closing 。/？
  // that isn't part of the quote's own text) and, reused below, for the
  // token 雖 postposes past (と…雖も's と attaches to *that* token, not to
  // 雖 itself).
  //
  // Withheld where a 再読文字 *inside* the span closes on that same token.
  // Both readings are written onto one token, and neither panel can order
  // them: `generator.ts`'s `closeToken` and `KundokuView.ts`'s `withQuoteEnd`
  // each emit the ト first and the re-read's second reading after it, which is
  // right when the re-read governs the quote from outside (「…」ト未ダ曰ハず —
  // its clause is the whole sentence and so ends on the quote's last token
  // too) and wrong when it stands inside (問：「將何用？」 came out
  // 用ゐ**とんとす**, the ト landing in the middle of んとす). The two cases are
  // indistinguishable downstream, since both arrive as one id in each set, so
  // the ト is dropped rather than misplaced — leaving 問ふ、「まさになんぞ用ゐ
  // んとす」, which is what the sentence already read before the frame moved to
  // the front. `conjugationContext.ts`'s `readsLastInItsSubtree` withholds its
  // own と from exactly this shape, for exactly this reason; this is the same
  // bound, kept because the ordering gap it works around is still there.
  function markQuoteEnd(order: number[]): void {
    for (let i = order.length - 1; i >= 0; i--) {
      const t = byId.get(order[i]);
      if (!t || t.dep === "punct") continue;
      const rereadsClosingHere = rereadCloseIds.get(order[i]) ?? [];
      if (!rereadsClosingHere.some((id) => order.includes(id))) quoteEndIds.add(order[i]);
      return;
    }
  }

  /** The last non-punctuation token in `order` — for an INVERT child's own
   * rank-representative (see the `rankTokenIds` comment below): the child's
   * subtree can end in its *own* trailing source punctuation (a comma right
   * after that clause), which is never rendered with a kunten mark at all
   * (see KundokuView.ts's punct branch) — using it as the representative
   * silently drops a numeral (一_三, no 二) onto an invisible comma instead
   * of the real token adjacent to it in the final reading order.
   *
   * This is also what puts a return over a **coordination chain** on the
   * chain's last member. 縶手足 is read 手足を縶ぐ — the reader takes 手 and 足
   * in as one noun phrase and only then returns to 縶 — so 足 is the character
   * the return leaves from and the one that carries 一. A `conj:coord` chain
   * hangs off its first conjunct, so its later members sit inside that
   * conjunct's subtree and are read after it, and asking for the subtree's
   * last-read token answers the coordination question without ever naming
   * coordination. Nothing here reads the relation label, which is why
   * `conj:coord@emb` behaves identically.
   *
   * Asking for the last token *read* rather than the last *conjunct* is the
   * stronger of the two answers, and deliberately so: what a kaeriten states
   * is positional — return from here — so when the last conjunct has
   * post-dependents of its own (置良醞一器's 器 does, on the other side), the
   * mark still belongs on whatever is read immediately before the return, not
   * on the conjunct as such.
   *
   * The placement is load-bearing rather than cosmetic. `clauseLengthIn`
   * measures the returned-over clause from the group's rank-1 member, so
   * putting the mark on the *first* conjunct instead would shorten that
   * clause to one character and render the group as レ点 — 縶㆑手足, which
   * traces 手縶足, with 足 stranded after the verb that governs it. See
   * `tests/coordinationKaeriten.test.ts`. */
  function lastMeaningful(order: number[]): number {
    for (let i = order.length - 1; i >= 0; i--) {
      const t = byId.get(order[i]);
      if (t && t.dep !== "punct" && !isClosingParticle(order[i])) return order[i];
    }
    for (let i = order.length - 1; i >= 0; i--) {
      const t = byId.get(order[i]);
      if (t && t.dep !== "punct") return order[i];
    }
    return order[order.length - 1];
  }

  /** A **sentence-final particle** — 也, 矣, 乎, 哉, 焉, 耳 — as the parse
   * labels one: `discourse@sp`.
   *
   * Two questions in this file turn on it, and they are one question asked
   * twice. `rereadCloseIn` asks where a 再読文字's clause ends, and the particle
   * is outside it: 也 is read なり, the 断定 auxiliary, and an auxiliary stands
   * *on* a finished predicate rather than inside it (see that function).
   * `lastMeaningful` asks which character a return *leaves from*, and the
   * answer is the same character for the same reason — the particle closes the
   * clause after the predicate has been read, and a 返り点 marks the predicate
   * the reader turns back from, not the particle trailing it.
   *
   * Leaving it in put the 一 on the particle right across the gold treebank:
   * 是人之所欲也 came out 所㆓…也㆒ where the 一 belongs on 欲, 可謂孝矣 came out
   * 矣㆒ 可㆓ where it belongs on 孝, and 不可不知也 wrote the 一 of its fused
   * 一二三 on 也 rather than on 知. **2,306 of the treebank's 42,399 numeral
   * groups** carried a rank on such a particle.
   *
   * The fallback loop above is for a subtree that is *nothing but* such a
   * particle: there is then no earlier character to carry the mark, and the
   * particle carries it rather than the group losing its rank altogether. */
  function isClosingParticle(id: number): boolean {
    const t = byId.get(id);
    return !!t && t.dep === "discourse@sp";
  }

  /** Every token at or below `tokenId`, walked over the raw token list for
   * `coordinatedAway`'s reason: span-mates are not in `children`. */
  function subtreeIds(tokenId: number): Set<number> {
    const ids = new Set<number>();
    const stack = [tokenId];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (ids.has(id)) continue;
      ids.add(id);
      for (const t of sentence.tokens) if (t.head === id && t.id !== id) stack.push(t.id);
    }
    return ids;
  }

  /** Every token in a clause coordinated onto `predicateId` — a `conj:coord`
   * child of it, and everything hanging off that child.
   *
   * A 再読文字's second reading closes on the clause its predicate makes, and
   * a coordinate is a parallel clause rather than part of that one: in
   * 未學禮而不知 the 未 negates 學禮, and 而不知 is its own predication, with
   * its own negation already. Closing at the end of the whole subtree put 未's
   * ず after 知's — いまだ禮を學びて知らずず, two negations on one predicate, and
   * 學 left unnegated in the 連用形 the coordination gave it rather than the
   * 未然形 未 asks for.
   *
   * Walked over the raw token list rather than the `children` map, which
   * omits non-carrier span members: a span-mate left in scope could be picked
   * as the last token of a clause it is not in.
   *
   * Only clauses coordinated onto the predicate, never a negation nested
   * inside it. 未嘗不 is a real construction — いまだかつて…ずんばあらず — and
   * its inner 不 modifies the same predicate 未 governs rather than heading a
   * clause beside it, so both readings still land. */
  function coordinatedAway(predicateId: number): Set<number> {
    const away = new Set<number>();
    const stack = sentence.tokens
      .filter((t) => t.head === predicateId && t.id !== predicateId && CLAUSE_CONTINUATION_DEPS.has(t.dep))
      .map((t) => t.id);
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (away.has(id)) continue;
      away.add(id);
      for (const t of sentence.tokens) if (t.head === id && t.id !== id) stack.push(t.id);
    }
    return away;
  }

  /** Where a 再読文字 governing `predicateId` reads its second time: the last
   * real token of that predicate's own clause, out of the order built for it.
   *
   * **A `parataxis` continuation is another clause exactly as a `conj:coord`
   * one is**, and both are walked away from here. This set held `conj:coord`
   * alone, and the asymmetry cost the reader a whole negation: in 有子's
   * 不好犯上而好作亂者未之有也。君子務本… the 務 hangs off 有 by `parataxis`, so
   * 有's subtree — and with it 未's clause — ran to the end of all 58 tokens,
   * the ず was carried past four further clauses, and 未之有也 came out
   * いまだこれ有り**なり** with no negation on it at all. The same sentence cut
   * down to 未之有也 alone reads いまだこれ有らざるなり, which is what fixing the
   * extent restores in place.
   *
   * The two relations are one thing here for the reason `COORDINATION_DEPS` in
   * `conjugationContext.ts` gives: this parser reserves `conj:coord` for a
   * coordination with an explicit coordinator and falls back to `parataxis` for
   * the asyndetic case, so a set holding only the first describes the chains
   * that happen to carry a 而 rather than the chains.
   *
   * **A sentence-final particle is outside that clause**, exactly as a
   * coordinate clause is, and for a reason of the same kind: 也 is read なり —
   * the 断定 auxiliary — and an auxiliary stands *on* a finished predicate
   * rather than inside it. Counting it as the clause's last token put 未's ず
   * after it: 未果也 came out いまだ果つなりず, the negation asserted of the
   * assertion. What the sentence says is いまだ果てざるなり, the negation inside
   * and the なり on top of it, which is what dropping the particle here gives.
   *
   * Every `discourse`/`discourse@sp` token is dropped rather than only a
   * trailing one, and it makes no difference which: this asks only which token
   * is *last*, so a particle standing anywhere else was never the answer. The
   * particle is still read where reading order puts it — nothing here moves it,
   * and `order` is untouched. */
  function rereadCloseIn(order: number[], predicateId: number): number {
    const away = coordinatedAway(predicateId);
    // `discourse` alongside `isClosingParticle`'s `discourse@sp`: a 句頭
    // particle is no more part of the predicate's clause than a 句末 one, and
    // this asks which token is *last* rather than which can carry a mark.
    const clause = order.filter(
      (id) => !away.has(id) && !isClosingParticle(id) && byId.get(id)?.dep !== "discourse",
    );
    return lastMeaningful(clause.length > 0 ? clause : order);
  }

  /** The **return** a 再読文字's second reading is, entered into the
   * kaeriten system as an ordinary splice group.
   *
   * A 再読文字 is read twice: いまだ where it stands, and ず after the clause it
   * governs. The second half is a jump *backwards* — the reader runs 未 → 之 →
   * 有 and then returns to 未 for the ざる — and a jump backwards is precisely
   * and only what a 返り点 states. Nothing else in this file was stating it:
   * the character's first reading went into `pre`, its second was recorded in
   * `rereadCloseIds` for the two panels to *write* (the 訓読文 draws it down the
   * character's own left-hand side, `.reread-second`), and no splice group was
   * ever built, so 未 carried no mark at all. That is why 未之有也 came out
   * unmarked where every edition writes 未㆓之有㆒也: the marks are assigned from
   * a reading order that returns, and this return was not in it.
   *
   * The group is an INVERT one — the governor last, since the 再読文字 is what
   * the reader comes back *to* — and from there the ordinary machinery decides
   * everything else. `clauseLengthIn` measures the returned-over stretch and
   * gives the adjacent case (未有) レ点, the one-character return, while a
   * 再読文字 held off its predicate by a character or more (未之有) gets 一二点,
   * with 一 on the predicate and 二 on the character. That split is the whole
   * of the convention here, and neither half is written into this function.
   *
   * **The population.** Over the 68,893 gold Kyoto sentences the app finds
   * 2,457 再読 uses, of which **858 stand a character or more off their
   * predicate** against 1,599 adjacent — so the shape 未之有 is in is a class
   * about a third the size of the plain one, not one sentence.
   *
   * `closeAt` is where the second reading lands (`rereadCloseIn`), which has
   * already put a coordinate clause and a sentence-final particle outside the
   * clause — so the 一 falls on the predicate, not on the 也 after it. A close
   * that is not later in the source than the character is no return at all and
   * is passed over. */
  function addRereadReturn(rereadId: number, closeAt: number): void {
    if (closeAt <= rereadId) return;
    spliceGroups.push({
      rankTokenIds: [closeAt, rereadId],
      depth: 0, // overwritten by kundokuTenAssigner
      isRe: false, // overwritten by kundokuTenAssigner
      kind: "invert",
    });
  }

  /** Mirror of `lastMeaningful`, for the postpose case's own representative
   * (see the `rankTokenIds` comment below) — punctuation is far less likely
   * to lead a subtree than trail one, but kept symmetric on principle. */
  function firstMeaningful(order: number[]): number {
    for (const id of order) {
      const t = byId.get(id);
      if (t && t.dep !== "punct") return id;
    }
    return order[0];
  }

  function expand(nodeId: number): Atom[] {
    const kids = (children.get(nodeId) ?? []).slice().sort((a, b) => a.id - b.id);
    const governorToken = byId.get(nodeId);
    // `xpos` is what identifies a verb of speech: the class is the treebank's
    // own 伝達 tag, not a lemma list (see `SPEECH_VERB_LEMMAS`).
    const governor = governorToken && {
      // `id` is what `isPostposedSubject` compares against: a subject standing
      // to the right of the word it hangs off has to be moved, and neither
      // token's lemma or relation says so.
      id: governorToken.id,
      lemma: governorToken.lemma,
      dep: governorToken.dep,
      xpos: governorToken.xpos,
      morph: governorToken.morph,
    };

    const pre: Token[] = [];
    const post: Token[] = [];
    const inv: Token[] = [];
    const postpose: Token[] = [];
    for (const kid of kids) {
      // A 再読文字 is read before the predicate it governs, whatever its
      // relation would otherwise say. These characters look like
      // auxiliaries or negations to the classifier, which postposes them —
      // right for the half of them that *is* an auxiliary (the ず, the
      // べし), and wrong for the adverbial half, which is read first. Being
      // read twice, they need the earlier slot here; the later one is
      // recorded below and emitted by the kakikudashi generator.
      if (isRereadUse(kid, sentence)) {
        pre.push(kid);
        continue;
      }
      // `sentence` is what lets the speech-quote exception see whether the
      // complement heads a clause (a sentence-final particle on a nominal) and
      // whether the source brackets it — see `isSpeechQuoteComplement`.
      const behavior = classifyToken(kid, governor, sentence);
      if (behavior === "invert") inv.push(kid);
      else if (behavior === "postpose") postpose.push(kid);
      else if (kid.id < nodeId) pre.push(kid);
      else post.push(kid);
    }

    // Emitting `nodeId` alone would drop its non-carrier span-mates (they
    // were deliberately excluded from `children` above); emit the whole
    // span's token ids, in source order, in the one place nodeId itself
    // would have gone.
    const emit = spanOf.get(nodeId)?.tokenIds ?? [nodeId];
    // Where the governor's own word begins. A span is read as a unit, so this
    // is the first of its characters, not `nodeId` — see `returningOrders`.
    const wordStart = Math.min(...emit);

    const preAtoms = pre.flatMap((kid) => {
      const atoms = expand(kid.id);
      if (isSpeechQuoteComplement(kid, governor, sentence)) markQuoteEnd(idsOf(atoms));
      return atoms;
    });
    // The third source of a trailing ト, beside a bracketed quote (above and
    // below) and 雖 (just after). A negated, subjectless clausal complement of a
    // speech verb reports a proposition and takes と — see
    // `isNegatedBareReport`, which is candid about being a shape rather than a
    // principle — but unlike a bracketed quote it is not held in place: it is an
    // ordinary INVERT child, read *before* the verb that reports it, so the と
    // has to be marked here rather than in either of the two branches around
    // this one. Marked against the child's own reading-order subtree, which is
    // what puts the と after a negation postposed past the predicate: 俱言不須
    // reads ともに用ゐ**ずと**言ふ, and the と landing on 須 instead would have
    // given 用ゐとず.
    //
    // **An INVERT child the source already put in front of the governor is
    // not spliced onto it at all**, and keeps its own place in the text. What
    // "invert" states is that the child is read before its governor; where the
    // source has already done that, there is nothing to move, and gathering it
    // into the governor's own travelling run drags it *across its own
    // siblings*. 吾日三省吾身 is the case: 日 is `mod@tmod` of 省 and inverts, 三
    // is a plain `mod` of the same 省 and does not, so 日 was carried into the
    // governor's atom at 省's position while 三 stayed at its own — 吾三たび日に
    // わが身を省みる, the two adverbs swapped for no reason a reader could see.
    // Emitted as its own atoms instead, keyed by its own source positions, it
    // sorts back where the text has it: 吾日に三たび…, which is the received
    // reading.
    //
    // **This is the same fact `returningOrders` below already acts on**, met
    // one step earlier. That filter drops exactly these children from the
    // splice group because "a return from here" is not what the reader does —
    // they read straight on. Splitting them out here is what makes the reading
    // order say the same thing the marks do: the marks never named this child,
    // so nothing licenses moving it.
    //
    // Measured by the child's last-*read* token against the governor's word
    // start, not by its span of source positions: a child whose own subtree
    // straddles the governor still has material to bring back, and only one
    // that finishes before the governor's word begins is genuinely in place.
    const invAtoms = inv.map((kid) => {
      const atoms = expand(kid.id);
      if (isNegatedBareReport(kid, governor, sentence)) markQuoteEnd(idsOf(atoms));
      return atoms;
    });
    const invOrders: number[][] = [];
    // A sentence-final particle trailing an INVERT child does not travel with
    // it. 也 is read なり (or, on a topic, や) and an auxiliary stands *on* a
    // finished predicate: in 不以飲爲累也 the 也 closes 爲's whole clause, not
    // 累's, so carrying it inside 累's block read 飲を以て累なり爲さず — the
    // 断定 asserted before the predicate it asserts. Left behind, keyed by its
    // own source position, it sorts back after the governor's run and the
    // clause closes where it closes: 飲を以て累と爲さざるなり. 其爲人也 is the
    // same shape a relation away (也 on the topic 人): 其の人と爲るや.
    //
    // This is what makes the marks and the reading order say one thing.
    // `lastMeaningful` will not put a rank on such a particle (see
    // `isClosingParticle`), so the 一 of 不以飲爲累也 stands on 累 and the marks
    // trace 飲・以・累・爲・不・也; a particle still travelling inside 累's block
    // would leave the order tracing 累・也・爲・不 and the two panels disagreeing
    // about where the clause ends.
    //
    // **Punctuation does not end the run, and that is what this walk had to
    // learn.** A sentence-final particle is very nearly always followed by a
    // mark — 。, or a 」 closing the speech it ends, or both — and the walk
    // below stopped at the first atom that was not the particle, so a 也 with
    // a 。 behind it was never reached. That is why 自古之政也 read
    // 古の政より**なり** with the 也 inside 政's block, and 未足與議也 read
    // 未だ議する**なり**に足らず: the rule was right and simply never got to
    // them. Over the kanbun.info corpus the block held **98 numeral groups**
    // and **30 レ点 ones** where the particle was read before the character
    // the return goes back to, against 915 where it was already read after.
    //
    // Stepping over a mark costs nothing, because a mark's position in this
    // order is not decided here at all: `placeMarks` re-anchors every one of
    // them to the source token it follows, after the whole walk has run (see
    // its own note). So the marks are carried back with the particles purely
    // to keep the atoms contiguous; where they are *read* is the same either
    // way.
    const trailAtoms: Atom[] = [];
    for (const atoms of invAtoms) {
      // `hold` is the earliest atom of the trailing run that is a closing
      // particle — marks are stepped over but never held back on their own,
      // so a child ending in bare punctuation keeps every atom it had.
      let end = atoms.length;
      let hold = end;
      while (end > 0) {
        const ids = atoms[end - 1].ids;
        if (ids.every(isClosingParticle)) { end--; hold = end; continue; }
        if (ids.every((id) => isMark(byId.get(id)!))) { end--; continue; }
        break;
      }
      // Never the whole child: a child that *is* the particle has nothing else
      // to be read before the governor, and holding it back would move it past
      // material the source put after it.
      if (hold > 0) trailAtoms.unshift(...atoms.splice(hold));
      if (lastMeaningful(idsOf(atoms)) > wordStart) invOrders.push(idsOf(atoms));
      else preAtoms.push(...atoms);
    }
    // Postposed children are read in source order — except where two of them
    // scope over each other, which source order does not say. A nominal
    // negation (非/匪) takes in the whole predicate, a verbal negation (不…)
    // included: 城非不高也 is 城高からざるに非ざるなり — 高, then 不, then 非 —
    // where source order gave 城高に非ず…ず, which is not a reading. A
    // **predicate negation** (無/莫/毋 — `isPredicateNegationPostpose`) scopes
    // over the same 不 in the same way: 莫不知 is 知らざる莫し and 靡不有初 is
    // 初め有らざる靡し, where source order gave 知る莫ず, which is not a reading
    // either. A concessive (雖) takes in both in turn, since と…雖も closes the
    // clause it concedes: 少小雖非投筆吏 is 少小 投筆の吏に非ずと雖も, 非 before
    // 雖. All of them hang off the same head as `mod` and nothing in the tree
    // separates them, so the rank below states the scope directly. Sorted
    // stably, so siblings of equal rank keep the source order they had — which
    // is what settles a 非 standing beside a 無, the one pair the middle rank
    // holds two of.
    const scopeRank = (kid: Token): number =>
      isConcessivePostpose(kid)
        ? 2
        : isNominalNegationPostpose(kid, governor) || isPredicateNegationPostpose(kid, governor, sentence)
          ? 1
          : 0;
    // **敢 read in place as 敢へて** (`isGanComplement`): the predicate it
    // governs is read straight on after it, and every negation the parse hangs
    // on 敢 closes that predicate — see the fold below.
    const ganInPlace =
      governorToken !== undefined &&
      ganReadsAsAdverb(governorToken, sentence) &&
      post.some((kid) => isGanComplement(kid, governor, sentence));
    // Under 敢, a negation written *after* the character is the inner one. 不敢
    // 不告 and 莫敢不敬 hang both negations off 敢, one on each side of it, and
    // what the text says is that the second 不 negates 告 and the first denies
    // the whole: 敢へて告げずんばあらず, 敢へて敬せざる莫し. Where the scope rank
    // already separates the two (莫 over 不) this changes nothing; where it does
    // not (不 and 不), it puts the inner one first, where source order would put
    // the outer one first and draw the marks back to front.
    const innerFirst = (kid: Token): number => (ganInPlace && kid.id > nodeId ? 0 : 1);
    const orderedPostpose =
      postpose.length > 1
        ? postpose
            .map((kid, i) => ({ kid, i }))
            .sort((a, b) => scopeRank(a.kid) - scopeRank(b.kid) || innerFirst(a.kid) - innerFirst(b.kid) || a.i - b.i)
            .map((entry) => entry.kid)
        : postpose;
    // **A predicate negation over an auxiliary is read after the auxiliary's
    // complement, not straight after the auxiliary.** 莫能陷也 hangs 莫 and 陷
    // both off 能: the 莫 postposes (`isPredicateNegationPostpose`) and the 陷,
    // a `comp:aux` the source already has after 能, is read straight on. Kept
    // apart, the 莫 was spliced onto 能 while 陷 stayed its own atom at its own
    // source position, so the reading ran 能・莫・陷 — 能く莫陷る, a negation
    // inside the clause it denies. What 無し predicates of is the whole 能陷
    // clause, and the received reading is 能く陷す莫きなり: kanbun.info reads 11
    // of its 14 莫能 passages as 能く…莫し, and the parsed corpus has 28 trees
    // of exactly this shape.
    //
    // So where the governor has a predicate negation to postpose, its
    // `comp:aux` children are folded into the governor's own run, and the
    // negation (with anything ranked after it, i.e. a 雖) comes after them.
    // Only the atoms standing after the governor's word are folded: an object
    // the source fronts before the auxiliary (莫之能禦) keeps its own place, for
    // the reason the INVERT note above gives — nothing licenses moving it, and
    // 之を能く禦ぐ莫し is what the marks can say.
    //
    // **`comp:aux` only.** That is the one relation that puts a governor's
    // clause material after it and reads it straight on; a coordinate or a
    // `parataxis` child after the governor is another clause, which the 無
    // does not scope over.
    //
    // **Under 敢 every postposed child is deferred, 不 as much as 莫.** What 能
    // has is two words, and a 不 on 能 is read straight after it because that
    // 能 is the verb 能はず; 敢 has one, the adverb 敢へて, and a 不 on it
    // negates the predicate it introduces: 不敢當 is 敢へて當たらず, 莫敢當其前
    // 敢へて其の前に當たる莫し. kanbun.info writes the negation after the
    // predicate on all 36 of its 敢えて…ず and all 9 of its 敢えて…莫し, and
    // before it on none. The complement folded is the `comp:aux`, or where the
    // parse has none, the `comp:obj` it gave the predicate instead (下不敢犯);
    // a `comp:obj` beside a `comp:aux` is a second clause the parse hung on
    // the same 敢 (未敢先舉、吾欲令…), which the negation does not reach.
    const firstDeferred = ganInPlace
      ? orderedPostpose.length > 0 ? 0 : -1
      : orderedPostpose.findIndex((kid) => isPredicateNegationPostpose(kid, governor, sentence));
    const foldedDep = ganInPlace && !post.some((kid) => kid.dep === "comp:aux") ? "comp:obj" : "comp:aux";
    // One complement under 敢, the first: 敢問、敵衆整而將來 hangs two `comp:aux`
    // off the one 敢, and the second is the question asked, not a predicate
    // 敢へて introduces. `ganClauseView` in `conjugationContext.ts` makes the
    // same choice for the particle and the form.
    const ganComplement = ganInPlace ? post.find((kid) => kid.dep === foldedDep) : undefined;
    const auxComplements =
      firstDeferred < 0 ? [] : ganComplement ? [ganComplement] : post.filter((kid) => kid.dep === foldedDep);
    const auxAtoms = auxComplements.flatMap((kid) => expand(kid.id));
    // **A clause coordinated onto the complement is not folded**, for the
    // reason `coordinatedAway` gives a 再読文字: it is a predication beside the
    // one negated, not part of it. 主人不敢當而陵之 hangs 陵 off 當 as
    // `conj:coord`, and kanbun.info reads 主人敢えて当らずして之を陵ぐ — the
    // negation on 當 alone. Folded whole, the 不 was carried past 陵之 and
    // negated the wrong verb. Left out, those atoms keep their own source
    // positions and are read after the negation, like any other `post` child.
    const awayFromAux = new Set(auxComplements.flatMap((kid) => [...coordinatedAway(kid.id)]));
    const foldedAux = auxAtoms.filter((atom) => atom.key > wordStart && !atom.ids.some((id) => awayFromAux.has(id)));
    // A closing particle (and the marks around it) at the end of the
    // complement stays behind, for the reason the INVERT walk above gives: a
    // 也 the parse hangs off 陷 rather than 能 still closes the whole clause,
    // so it is read after the 莫 and not before it.
    while (foldedAux.length > 0) {
      const ids = foldedAux[foldedAux.length - 1].ids;
      if (!ids.every((id) => isClosingParticle(id) || isMark(byId.get(id)!))) break;
      foldedAux.pop();
    }
    if (foldedAux.length > 0 && foldedAux.every((atom) => atom.ids.every((id) => isMark(byId.get(id)!)))) foldedAux.length = 0;
    const deferFrom = foldedAux.length > 0 ? firstDeferred : orderedPostpose.length;
    // Built incrementally (not a plain .map) so a concessive postpose (雖)
    // can be marked against exactly the order-so-far right before its own
    // subtree starts — that's the token と…雖も's と attaches to.
    const postposeOrders: number[][] = [];
    const deferredOrders: number[][] = [];
    {
      let before = [...idsOf(preAtoms), ...invOrders.flat(), ...(spanOf.get(nodeId)?.tokenIds ?? [nodeId])];
      orderedPostpose.forEach((kid, i) => {
        if (i === deferFrom) before = [...before, ...idsOf(foldedAux)];
        const order = idsOf(expand(kid.id));
        if (isConcessivePostpose(kid)) markQuoteEnd(before);
        (i >= deferFrom ? deferredOrders : postposeOrders).push(order);
        before = [...before, ...order];
      });
    }
    // **A quotation hung beside its 曰 closes once, after the last thing said.**
    // In 夫子矢之曰：「予所否者，天厭之！」 the quotation is 厭, a `parataxis` of
    // 矢 and not a complement of 曰 at all (see `quoteFramingYue`), so the
    // per-child test below never saw it and no と was written. What 曰 frames
    // is every sibling after it, and those can be several — 子曰、舉直錯諸枉、
    // 能使枉者直 puts 舉 and 使 on 達 side by side — so the と goes after the
    // last child each 曰 frames rather than after each of them, which would
    // have closed the quotation in the middle and opened nothing after it.
    // A framed `comp:obj` also answers yes to `isSpeechQuoteComplement`, so the
    // framing test is asked first; asked the other way round, that sibling
    // would take a と of its own.
    const lastFramedBy = new Map<number, number>();
    for (const kid of post) {
      const yue = quoteFramingYue(kid, sentence);
      if (yue !== undefined) lastFramedBy.set(yue, kid.id);
    }
    const postAtoms = [
      ...post
        .filter((kid) => !auxComplements.includes(kid))
        .flatMap((kid) => {
          const atoms = expand(kid.id);
          const yue = quoteFramingYue(kid, sentence);
          if (yue !== undefined) {
            if (lastFramedBy.get(yue) === kid.id) markQuoteEnd(idsOf(atoms));
          } else if (isSpeechQuoteComplement(kid, governor, sentence)) {
            markQuoteEnd(idsOf(atoms));
          }
          return atoms;
        }),
      ...(foldedAux.length > 0 ? auxAtoms.filter((atom) => !foldedAux.includes(atom)) : auxAtoms),
    ];

    /** What a kaeriten states is "the material below is read before this
     * character" — so a mark is only ever needed for a child the reader would
     * otherwise reach *after* the governor. A child whose own last-read token
     * already stands before the governor's word in the source is read before
     * it either way, by reading straight on, and ranking it says nothing.
     *
     * 但令於日中俯臥 is where the difference shows. 於's subtree (於日中) is
     * 俯's INVERT child and stands wholly in front of it, so the group came out
     * [於, 俯] — a "return" from 於 forward to 俯, which is not a return at all.
     * `clauseLengthIn` already measures that stretch as empty (see its closing
     * note) and declines to write it as レ点; what it could not do from there
     * was decline to write it at all, so 俯 took a numeral of its own. Fused
     * with the genuine 日中/於 inversion beside it, that put **two marks on the
     * one word 俯臥** — a ㆘ under 俯 and a ㆒ under 臥 — where the word needs
     * exactly one, and a reader following the ㆘ was sent forward past 臥 into
     * the next clause (酒蟲 sent_id 20 failed its own marks-only round trip on
     * precisely this).
     *
     * Only the vacuous children drop out; a governor keeping any genuine one
     * still ranks it, and the ranks are contiguous because the reader never
     * needed the dropped one. The governor's *reading order* is untouched —
     * an INVERT child is still read before it, which for these children is
     * where the source already had them.
     *
     * Measured against the start of the governor's whole word, not against
     * `nodeId`: a span is read as a unit, so a child standing before the first
     * of its characters is what "already read" means for a compound.
     *
     * The split itself is made where `invOrders` is built, so that a child
     * this test drops is not merely unranked but left standing where the
     * source has it — see the note there. Every order reaching `invOrders` has
     * already passed, and the name is kept for what the group means. */
    const returningOrders = invOrders;
    if (returningOrders.length > 0) {
      spliceGroups.push({
        // Rank order = the last (deepest-read) token of each INVERT child's
        // own subtree, in the children's source order, then the governor —
        // skipping any trailing punctuation in that subtree (lastMeaningful),
        // since a punct token never carries a kunten mark at all and would
        // silently swallow a numeral (e.g. 一_三 with no 二 visible anywhere).
        rankTokenIds: [...returningOrders.map((order) => lastMeaningful(order)), nodeId],
        depth: 0, // overwritten by kundokuTenAssigner
        isRe: false, // overwritten by kundokuTenAssigner
        kind: "invert",
      });
    }
    if (postposeOrders.length > 0) {
      spliceGroups.push({
        // Mirror image of the INVERT case: the governor is read first, then
        // each postposed child's subtree, in source order. INVERT uses each
        // child's *last*-read token as the representative because that's
        // the one immediately adjacent to nodeId in final reading order
        // (invert children are spliced in *before* nodeId). Postpose is the
        // mirror: children are spliced in *after* nodeId, so the adjacent —
        // and thus representative — token is each child's *first*-read
        // token instead. This matters once a postposed child has its own
        // postposed descendant (e.g. a negated modal auxiliary, 不可 ->
        // べからず): using the *last* token there would grab the negation
        // two jumps down instead of the auxiliary immediately after nodeId,
        // and collide with that inner group's own mark on the same token.
        rankTokenIds: [nodeId, ...postposeOrders.map((order) => firstMeaningful(order))],
        depth: 0,
        isRe: false,
        kind: "postpose",
      });
    }
    if (deferredOrders.length > 0) {
      // The same group for a negation read after the folded `comp:aux` above:
      // what it is read straight after is the last character of that
      // complement, so that character stands where the governor stands in
      // the group before — 莫㆓能陷㆒, the 一 on 陷.
      //
      // **Two deferred negations make a chain of two groups, not one group of
      // three.** 莫敢不敬 reads 敬, then 不, then 莫, and each is read straight
      // after the one before: 莫㆓敢不㆒レ敬, the conventional marking.
      // One three-member group wrote 莫㆔敢不㆓敬㆒ instead — the same order
      // for a reader who knows the construction, but a fan of three where the
      // text has a chain, and the marks-only round trip, which reads a 三 as a
      // governor over *every* 一 and 二 still ahead of it, carried the 莫 past
      // the two clauses that follow it in 上好禮，則民莫敢不敬；上好義….
      const heads = [lastMeaningful(idsOf(foldedAux)), ...deferredOrders.map((order) => firstMeaningful(order))];
      for (let k = 1; k < heads.length; k++) {
        spliceGroups.push({
          rankTokenIds: [heads[k - 1], heads[k]],
          depth: 0,
          isRe: false,
          kind: "postpose",
        });
      }
    }

    // A re-read character that *heads* its clause (須 with the predicate as
    // its `comp:aux`, 当 with it as `comp:obj`) is read before what it
    // governs, not after it. The relation would otherwise place the
    // predicate first, as an inverted complement, and the adverbial half
    // would follow the verb it introduces.
    // `isRereadUse` alongside the relation, not the relation alone: holding a
    // predicate is what makes this shape a re-read, but it is not the whole
    // question, and the two panels ask the whole one. A reading picked by hand
    // takes the character out of the construction, and a noun use of it was
    // never in one — either way the panels stop writing the second reading,
    // while this went on recording where to write it and on reading the
    // character before what it governs. The rest of the file already spends
    // `isRereadUse` for exactly that reason (see `rereadCharacters.ts`); this
    // one line was deciding for itself.
    const headsReread =
      governorToken !== undefined && isRereadUse(governorToken, sentence) && governedPredicate(governorToken, sentence) !== null;
    // The governor and everything spliced onto it: the one run that travels,
    // anchored where the governor's own word begins. Every other atom keeps
    // the key it was built with, so the merge below is a merge on source
    // position — see the `Atom` note above for why that is the whole contract.
    const nodeAtom: Atom = {
      key: emit[0],
      ids: [
        ...(headsReread ? [...emit, ...invOrders.flat()] : [...invOrders.flat(), ...emit]),
        ...postposeOrders.flat(),
        ...(deferredOrders.length > 0 ? idsOf(foldedAux) : []),
        ...deferredOrders.flat(),
      ],
    };
    const atoms = [...preAtoms, ...postAtoms, ...trailAtoms, nodeAtom].sort((a, b) => a.key - b.key);
    const combined = idsOf(atoms);

    if (headsReread) {
      // Against the predicate this character holds, not against itself: what
      // it governs is that predicate's clause, and a coordinate hanging off
      // the predicate is outside it here exactly as it is below.
      const closeAt = rereadCloseIn(combined, governedPredicate(governorToken!, sentence)?.id ?? nodeId);
      if (closeAt !== nodeId) {
        const at = rereadCloseIds.get(closeAt) ?? [];
        at.push(nodeId);
        rereadCloseIds.set(closeAt, at);
      }
    }

    // A 再読文字 modifying this node is read a second time after everything
    // the node governs — that is what makes it re-read rather than merely
    // long. The loop above put its first reading among `pre`; this records
    // where the second one lands, the last real token of this whole
    // subtree, exactly as a quote's closing ト is placed.
    for (const kid of pre) {
      if (!isRereadUse(kid, sentence)) continue;
      // Under 敢, the clause a 未 negates ends with the predicate 敢へて
      // introduces, as the 不 folded above does. 未敢先舉、吾欲令…走 hangs the
      // whole 欲 clause off the same 敢 as `comp:obj`, and closing at the end of
      // 敢's subtree carried 未's ず past it to 走: 未だ敢へて先に舉ぐ、…走らず,
      // where kanbun.info reads 未だ敢えて先ず挙げざるに.
      const ganClause = ganComplement ? subtreeIds(ganComplement.id) : undefined;
      const closeAt = ganComplement && ganClause
        ? rereadCloseIn(combined.filter((id) => ganClause.has(id)), ganComplement.id)
        : rereadCloseIn(combined, nodeId);
      // Nested re-reads close outermost-last, so append rather than
      // replace.
      const at = rereadCloseIds.get(closeAt) ?? [];
      at.push(kid.id);
      rereadCloseIds.set(closeAt, at);
      addRereadReturn(kid.id, closeAt);
    }
    return atoms;
  }

  const order = placeMarks(idsOf(expand(rootId)), sentence);

  // Every token, once. A token the walk never reaches is read nowhere and
  // marked nowhere, so neither panel has anything to show for it and nothing
  // in either one says a clause went missing — the failure that made
  // 不以飲為累也 vanish in silence. Loud is strictly better than silent here,
  // and this is the same guard the missing-ROOT check above already is.
  const seen = new Set<number>();
  const duplicated: number[] = [];
  for (const id of order) {
    if (seen.has(id)) duplicated.push(id);
    seen.add(id);
  }
  const dropped = sentence.tokens.filter((t) => !seen.has(t.id));
  if (dropped.length > 0 || duplicated.length > 0) {
    const name = (id: number) => `${id}:${sentence.tokens.find((t) => t.id === id)?.text ?? "?"}`;
    const parts = [
      dropped.length > 0 ? `dropped ${dropped.map((t) => name(t.id)).join(" ")}` : "",
      duplicated.length > 0 ? `repeated ${duplicated.map(name).join(" ")}` : "",
    ].filter(Boolean);
    throw new Error(`Reading order does not cover the sentence exactly once: ${parts.join("; ")}`);
  }

  return { sentence, order, spans, spliceGroups, quoteEndIds, rereadCloseIds };
}
