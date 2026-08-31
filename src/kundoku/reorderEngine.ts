import type { Sentence, Token } from "../parse/types.ts";
import { governedPredicate, isRereadUse } from "../kakikudashi/rereadCharacters.ts";
import type { CompoundSpan } from "../reading/jmdictLookup.ts";
import type { ReadingPlan, SpliceGroup } from "./types.ts";
import { classifyToken, isConcessivePostpose, isSpeechQuoteComplement } from "./depClassification.ts";
import { carrierOf } from "./spanCarrier.ts";

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
function resolveEffectiveHead(token: Token, byId: Map<number, Token>): number {
  if (classifyToken(token) !== "postpose") return token.head;
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

    const effectiveHead = attachmentPoint(resolveEffectiveHead(token, byId));
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
   * of the real token adjacent to it in the final reading order. */
  function lastMeaningful(order: number[]): number {
    for (let i = order.length - 1; i >= 0; i--) {
      const t = byId.get(order[i]);
      if (t && t.dep !== "punct") return order[i];
    }
    return order[order.length - 1];
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
    const stack = sentence.tokens.filter((t) => t.head === predicateId && t.id !== predicateId && t.dep === "conj:coord").map((t) => t.id);
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (away.has(id)) continue;
      away.add(id);
      for (const t of sentence.tokens) if (t.head === id && t.id !== id) stack.push(t.id);
    }
    return away;
  }

  /** Where a 再読文字 governing `predicateId` reads its second time: the last
   * real token of that predicate's own clause, out of the order built for it. */
  function rereadCloseIn(order: number[], predicateId: number): number {
    const away = coordinatedAway(predicateId);
    const clause = order.filter((id) => !away.has(id));
    return lastMeaningful(clause.length > 0 ? clause : order);
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

    const preAtoms = pre.flatMap((kid) => {
      const atoms = expand(kid.id);
      if (isSpeechQuoteComplement(kid, governor, sentence)) markQuoteEnd(idsOf(atoms));
      return atoms;
    });
    const invOrders = inv.map((kid) => idsOf(expand(kid.id)));
    // Built incrementally (not a plain .map) so a concessive postpose (雖)
    // can be marked against exactly the order-so-far right before its own
    // subtree starts — that's the token と…雖も's と attaches to.
    const postposeOrders: number[][] = [];
    {
      let before = [...idsOf(preAtoms), ...invOrders.flat(), ...(spanOf.get(nodeId)?.tokenIds ?? [nodeId])];
      for (const kid of postpose) {
        const order = idsOf(expand(kid.id));
        if (isConcessivePostpose(kid)) markQuoteEnd(before);
        postposeOrders.push(order);
        before = [...before, ...order];
      }
    }
    const postAtoms = post.flatMap((kid) => {
      const atoms = expand(kid.id);
      if (isSpeechQuoteComplement(kid, governor, sentence)) markQuoteEnd(idsOf(atoms));
      return atoms;
    });

    if (invOrders.length > 0) {
      spliceGroups.push({
        // Rank order = the last (deepest-read) token of each INVERT child's
        // own subtree, in the children's source order, then the governor —
        // skipping any trailing punctuation in that subtree (lastMeaningful),
        // since a punct token never carries a kunten mark at all and would
        // silently swallow a numeral (e.g. 一_三 with no 二 visible anywhere).
        rankTokenIds: [...invOrders.map((order) => lastMeaningful(order)), nodeId],
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

    // Emitting `nodeId` alone would drop its non-carrier span-mates (they
    // were deliberately excluded from `children` above); emit the whole
    // span's token ids, in source order, in the one place nodeId itself
    // would have gone.
    const emit = spanOf.get(nodeId)?.tokenIds ?? [nodeId];

    // A re-read character that *heads* its clause (須 with the predicate as
    // its `comp:aux`, 当 with it as `comp:obj`) is read before what it
    // governs, not after it. The relation would otherwise place the
    // predicate first, as an inverted complement, and the adverbial half
    // would follow the verb it introduces.
    const headsReread = governorToken !== undefined && governedPredicate(governorToken, sentence) !== null;
    // The governor and everything spliced onto it: the one run that travels,
    // anchored where the governor's own word begins. Every other atom keeps
    // the key it was built with, so the merge below is a merge on source
    // position — see the `Atom` note above for why that is the whole contract.
    const nodeAtom: Atom = {
      key: emit[0],
      ids: headsReread
        ? [...emit, ...invOrders.flat(), ...postposeOrders.flat()]
        : [...invOrders.flat(), ...emit, ...postposeOrders.flat()],
    };
    const atoms = [...preAtoms, ...postAtoms, nodeAtom].sort((a, b) => a.key - b.key);
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
      const closeAt = rereadCloseIn(combined, nodeId);
      // Nested re-reads close outermost-last, so append rather than
      // replace.
      const at = rereadCloseIds.get(closeAt) ?? [];
      at.push(kid.id);
      rereadCloseIds.set(closeAt, at);
    }
    return atoms;
  }

  const order = idsOf(expand(rootId));

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

  return { sentence, order, spliceGroups, quoteEndIds, rereadCloseIds };
}
