import type { Sentence } from "../parse/types.ts";

/** A single point in the tree where a child is read out of source order
 * relative to its governor — this is exactly one kundoku-ten "jump". Most
 * are INVERT (dependent moves before its governor, governor last in
 * `rankTokenIds`); negation postposing is the mirror image (governor moves
 * first, dependent(s) follow). */
export interface SpliceGroup {
  /** Token ids in this group, in Japanese-reading rank order (rank 1 first). */
  rankTokenIds: number[];
  /** Nesting depth among all splice groups in the sentence (0 = outermost
   * tier, i.e. 一二点; 1 = 上下点; 2 = 甲乙点; 3 = 天地点). */
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
  /** One entry per inversion point in the tree. */
  spliceGroups: SpliceGroup[];
  /** Token ids that end a quoted/reported-speech complement of a speech verb
   * (曰/云 — see `depClassification.ts`'s `isSpeechQuoteComplement`) — the
   * last non-punctuation token of that complement's own reading-order
   * subtree. Real kanbun convention always closes such a quote with a
   * trailing ト, attached to this token as okurigana by both render panels. */
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
