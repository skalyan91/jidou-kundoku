import type { Sentence, Token } from "../parse/types.ts";
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
    return [...preOrder, ...invOrders.flat(), ...emit, ...postposeOrders.flat(), ...postOrder];
  }

  return { sentence, order: expand(rootId), spliceGroups, quoteEndIds };
}
