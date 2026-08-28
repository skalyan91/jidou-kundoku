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
 * even though the real parse attaches 遠 and 方 to two different governors. */
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

export function computeReadingOrder(sentence: Sentence, spans: CompoundSpan[] = []): ReadingPlan {
  const children = new Map<number, Token[]>();
  const byId = new Map(sentence.tokens.map((t) => [t.id, t]));
  let rootId: number | undefined;

  const spanOf = new Map<number, CompoundSpan>();
  for (const s of spans) for (const id of s.tokenIds) spanOf.set(id, s);
  const carrierIdOfSpan = new Map<CompoundSpan, number>();
  for (const s of spans) carrierIdOfSpan.set(s, carrierOf(s, sentence).id);

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

    const effectiveHead = resolveEffectiveHead(token, byId);
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
  function markQuoteEnd(order: number[]): void {
    for (let i = order.length - 1; i >= 0; i--) {
      const t = byId.get(order[i]);
      if (t && t.dep !== "punct") {
        quoteEndIds.add(order[i]);
        return;
      }
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

  function expand(nodeId: number): number[] {
    const kids = (children.get(nodeId) ?? []).slice().sort((a, b) => a.id - b.id);
    const governorToken = byId.get(nodeId);
    const governor = governorToken && { lemma: governorToken.lemma, dep: governorToken.dep, morph: governorToken.morph };

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
      const behavior = classifyToken(kid, governor);
      if (behavior === "invert") inv.push(kid);
      else if (behavior === "postpose") postpose.push(kid);
      else if (kid.id < nodeId) pre.push(kid);
      else post.push(kid);
    }

    const preOrder = pre.flatMap((kid) => {
      const order = expand(kid.id);
      if (isSpeechQuoteComplement(kid, governor)) markQuoteEnd(order);
      return order;
    });
    const invOrders = inv.map((kid) => expand(kid.id));
    // Built incrementally (not a plain .map) so a concessive postpose (雖)
    // can be marked against exactly the order-so-far right before its own
    // subtree starts — that's the token と…雖も's と attaches to.
    const postposeOrders: number[][] = [];
    {
      let before = [...preOrder, ...invOrders.flat(), ...(spanOf.get(nodeId)?.tokenIds ?? [nodeId])];
      for (const kid of postpose) {
        const order = expand(kid.id);
        if (isConcessivePostpose(kid)) markQuoteEnd(before);
        postposeOrders.push(order);
        before = [...before, ...order];
      }
    }
    const postOrder = post.flatMap((kid) => {
      const order = expand(kid.id);
      if (isSpeechQuoteComplement(kid, governor)) markQuoteEnd(order);
      return order;
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
    const combined = headsReread
      ? [...preOrder, ...emit, ...invOrders.flat(), ...postposeOrders.flat(), ...postOrder]
      : [...preOrder, ...invOrders.flat(), ...emit, ...postposeOrders.flat(), ...postOrder];

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
    return combined;
  }

  const order = expand(rootId);
  return { sentence, order, spliceGroups, quoteEndIds, rereadCloseIds };
}
