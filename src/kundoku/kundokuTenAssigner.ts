import type { KundokuMark, KundokuTier, ReadingPlan, SpliceGroup } from "./types.ts";

const TIER_BY_DEPTH: KundokuTier[] = ["ichi-ni", "jou-ge", "kou-otsu", "ten-chi"];

/** A group's own governor token — "invert" puts it last in `rankTokenIds`
 * (children read first), "postpose" puts it first (governor read first). */
function governorOf(group: SpliceGroup): number {
  return group.kind === "invert" ? group.rankTokenIds[group.rankTokenIds.length - 1] : group.rankTokenIds[0];
}

function span(group: SpliceGroup): [min: number, max: number] {
  return [Math.min(...group.rankTokenIds), Math.max(...group.rankTokenIds)];
}

/** Assigns kundoku-ten marks to every token that participates in a splice
 * group, and fills in each group's real `depth`/`isRe` (reorderEngine leaves
 * those as placeholders).
 *
 * A token can legitimately belong to *two* splice groups at once — e.g. a
 * negated verb (postpose source) that also governs a genuine comp:obl/
 * comp:pred complement (invert target) — and real kanbun typesetting does
 * stack two marks on such a character. This map keeps only the
 * later-processed group's mark for that token (a documented simplification:
 * it exists for depth/isRe assertions in tests, not for rendering — the
 * actual display glyphs come from `buildKundokuGlyphMap`, which reads
 * `plan.spliceGroups` directly and *does* accumulate both marks). */
export function assignKundokuTen(plan: ReadingPlan): Map<number, KundokuMark> {
  const groups = plan.spliceGroups;
  const spans = groups.map(span);
  const marks = new Map<number, KundokuMark>();

  // isRe first (the depth/collision logic below doesn't depend on it, but
  // is worth settling up front for readability).
  for (const group of groups) {
    // Two token ids differing by exactly 1 have no integer strictly between
    // them, so the "nothing else falls between" clause of the レ点 rule is
    // automatically satisfied whenever this adjacency test passes.
    group.isRe = group.rankTokenIds.length === 2 && Math.abs(group.rankTokenIds[0] - group.rankTokenIds[1]) === 1;
  }

  groups.forEach((group, i) => {
    const [lo, hi] = spans[i];
    let depth = 0;
    groups.forEach((other, j) => {
      if (j === i) return;
      const [otherLo, otherHi] = spans[j];
      // Genuine nesting: another group's span strictly contains this one —
      // this group's tokens sit *inside* resolving one of that group's own
      // members' subtree (自遠方's established 上下点 case: 自's own jump
      // sits inside reading 來's pre-content, and 來 is the outer group's
      // own rank-1 member) — escalating here is about the reader needing
      // to track two numeral series *simultaneously in progress*, not
      // about a literal same-character collision.
      const strictlyContains = otherLo < lo && otherHi > hi;
      // Same-token collision: this group's own governor is also a plain
      // (non-governor) member of some other group — the case a purely
      // span-based check misses, since the two groups' spans merely abut
      // rather than nest (e.g. a token that's simultaneously an outer
      // group's rank-2 member and its own separate inner group's
      // governor — 木直中繩's 爲). Left unescalated, that one character
      // would need two mutually-exclusive marks from the same tier.
      const governor = governorOf(group);
      const sharesGovernorAsMember = other.rankTokenIds.includes(governor) && governorOf(other) !== governor;
      if (strictlyContains || sharesGovernorAsMember) depth++;
    });
    group.depth = depth;

    const tier: KundokuTier = group.isRe
      ? "re"
      : TIER_BY_DEPTH[Math.min(depth, TIER_BY_DEPTH.length - 1)];

    // Real kanbun typesetting affixes the mark to a single character in the
    // *original, unreordered* text — never both. For a 2-member レ点 jump
    // that's always the source-earlier member (e.g. 習 in 習之 read as 之習;
    // 不 in 不知 read as 知不), which — since a レ点 pair is by definition
    // two source-adjacent tokens read in reverse — is always the one ranked
    // *last* in `rankTokenIds` (read second). The other member gets no mark
    // at all. Numeral tiers (一二 etc.) are unambiguous either way and do
    // label every member, since 3+-way jumps need each rank spelled out.
    if (group.isRe) {
      const last = group.rankTokenIds[group.rankTokenIds.length - 1];
      marks.set(last, { tier });
    } else {
      group.rankTokenIds.forEach((id, index) => {
        marks.set(id, { tier, rank: index + 1 });
      });
    }
  });

  return marks;
}
