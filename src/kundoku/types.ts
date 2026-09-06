import type { Sentence } from "../parse/types.ts";
import type { CompoundSpan } from "../reading/jmdictLookup.ts";

/** A single point in the tree where a child is read out of source order
 * relative to its governor — this is exactly one kundoku-ten "jump". Most
 * are INVERT (dependent moves before its governor, governor last in
 * `rankTokenIds`); negation postposing is the mirror image (governor moves
 * first, dependent(s) follow). */
export interface SpliceGroup {
  /** Token ids in this group, in Japanese-reading rank order (rank 1 first). */
  rankTokenIds: number[];
  /** Nesting depth among all splice groups in the sentence (0 = the innermost
   * numeral tier, i.e. 一二点; 1 = 上中下点; 2 = 甲乙丙点; 3 = 天地人点). The
   * *enclosing* return takes the upper tier — 上中下点は、一二三点を挟んで
   * 使います — so this counts how deeply a group nests around others, not how
   * deeply it sits inside them. See `kundokuTenAssigner.ts`'s `TIER_BY_DEPTH`
   * and `assignDepths`. */
  depth: number;
  /** True when this group is a 2-member, source-adjacent jump that should
   * render as レ点 instead of numerals. */
  isRe: boolean;
  /** Which end of `rankTokenIds` is the governor — "invert" puts it last
   * (children read first, then the governor); "postpose" puts it first
   * (the governor is read first, then its postposed dependents). Needed by
   * `kundokuTenAssigner.ts` to find a group's governor (for the same-token
   * tier-collision check) without re-deriving invert-vs-postpose from
   * scratch — see that file's own doc for why a token's *governor* role in
   * one group vs. its plain-*member* role in another is exactly the
   * condition that forces a tier bump.
   *
   * "chain" is what `kundokuTenAssigner.ts`'s `fuseChains` leaves behind
   * when an INVERT group and a POSTPOSE group meet at the one character
   * that is the last-read member of the first and the first-read member of
   * the second: the two are one continuous run of returns rather than two,
   * and are fused into a single extended rank series (一二三 instead of a
   * 一二 and another 一二 colliding on that shared character). The deferred
   * end is still the last entry in `rankTokenIds` — the final return
   * destination — so "chain" behaves like "invert" everywhere the governor
   * is what is being asked for. */
  kind: "invert" | "postpose" | "chain";
}

export interface ReadingPlan {
  sentence: Sentence;
  /** Token ids in Japanese reading order. */
  order: number[];
  /** The multi-token units this order was built to keep contiguous — exactly
   * the `spans` argument `computeReadingOrder` was handed (see
   * `findCompoundSpans`), carried here rather than re-derived downstream.
   *
   * **Because a consumer of the plan must never re-decide what a span is.**
   * `generateKakikudashiPieces` needs the spans to attach one shared
   * ending/case particle after a whole group instead of splicing a copula
   * between its characters (君なり子 for 君子なり), and it used to call
   * `findCompoundSpans` again on `plan.sentence` to get them. That is two
   * derivations of one fact, and they agree only for as long as the same
   * inputs reach both: the panels hand `computeReadingOrder` whatever spans
   * they detected, and the generator is handed a plan and a resolver and
   * nothing else, so a span source needing anything the generator has not got
   * would silently give the prose a different set from the one the order was
   * computed on — the reading order fusing two characters while the prose
   * still wrote an ending between them. Carrying them is what makes the two
   * one answer. */
  spans: readonly CompoundSpan[];
  /** One entry per inversion point in the tree. */
  spliceGroups: SpliceGroup[];
  /** Token ids that end a quoted/reported-speech complement of a speech verb
   * (曰/云 — see `depClassification.ts`'s `isSpeechQuoteComplement`) — the
   * last non-punctuation token of that complement's own reading-order
   * subtree. Real kanbun convention always closes such a quote with a
   * trailing ト, which each panel writes where that panel can write it: the
   * 訓読文 hangs it off this token as okurigana (a bracket is a character of
   * the source and carries none), and the 書き下し文 emits it as a piece and
   * moves it *outside* the closing bracket, which is where running prose puts
   * it — 「…」と (see `generator.ts`'s `closeQuotesOutsideBrackets`). Hence
   * "the last non-punctuation token" and not "the bracket": the two panels
   * need one answer, and only one of them has anywhere to put it.
   *
   * **A set, so a token can only end one quotation.** Two closing on the same
   * one — 曰：「甲曰：『乙』」, where 乙 is the last token of both — arrive here
   * as a single id and are written with a single ト. Counting them instead
   * (`Map<number, number>`) is what a second ト would take, and it would have
   * to be spent in three places: `KundokuView.ts`'s `withQuoteEnd`, this
   * panel's `markQuoteEnd`, and `conjugationContext.ts`'s `quoteClosing`,
   * which decides と against やと per quotation and would have to answer per
   * *quotation* rather than per token. Left as it is because the nesting has
   * not been seen in real material; the 書き下し文's one ト at least now stands
   * outside both brackets rather than inside the inner one. */
  quoteEndIds: Set<number>;
  /** Token id -> the 再読文字 tokens whose *second* reading is emitted after
   * it. A 再読文字 is read once where it stands and once after the clause it
   * governs (未…ず, 将…んとす), so it occupies two places in the reading
   * while appearing once in `order`; this carries the second. */
  rereadCloseIds: Map<number, number[]>;
}

export type KundokuTier = "re" | "ichi-ni" | "jou-ge" | "kou-otsu" | "ten-chi";

export interface KundokuMark {
  tier: KundokuTier;
  /** 1-based rank within the mark's local group; omitted for レ点, which has
   * no numeral. */
  rank?: number;
}
