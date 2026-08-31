import type { KundokuMark, KundokuTier, ReadingPlan, SpliceGroup } from "./types.ts";

const TIER_BY_DEPTH: KundokuTier[] = ["ichi-ni", "jou-ge", "kou-otsu", "ten-chi"];

/** A group's own governor token — "invert" (and the fused "chain") puts it
 * last in `rankTokenIds` (children read first), "postpose" puts it first
 * (governor read first). */
function governorOf(group: SpliceGroup): number {
  return group.kind === "postpose" ? group.rankTokenIds[0] : group.rankTokenIds[group.rankTokenIds.length - 1];
}

function span(group: SpliceGroup): [min: number, max: number] {
  return [Math.min(...group.rankTokenIds), Math.max(...group.rankTokenIds)];
}

/** The longest rank series each tier can actually spell. Real kanbun charts
 * 一二三四 for the numeric tier and stops at three for every tier above it:
 * 上中下, 甲乙丙, 天地人 — there is no 上中下◯. A fused chain longer than the
 * tier it lands on is therefore beyond the notation itself, and is left
 * unfused and escalated a tier instead of being written in symbols no
 * edition uses (see `fuseChains`). Indexed the same way `TIER_BY_DEPTH` is. */
const MAX_RANKS_BY_DEPTH = [4, 3, 3, 3];

/** Fuses splice groups that *overlap* rather than nest.
 *
 * Two groups NEST when one of them has to be read out completely while the
 * other's series is still in progress — the reader is inside group A,
 * reaches a member of A that cannot be read without first running the whole
 * of group B, and so is tracking two series at once. That is what the tiers
 * exist for, and it is what the `depth` loop below detects and escalates
 * (一二点 inside 上下点 inside 甲乙点 inside 天地点).
 *
 * Two groups OVERLAP when they merely meet end to end: the last-read member
 * of A is a member of B that B has not reached yet. Nothing is suspended
 * there — the reader finishes A's returns arriving at that shared character,
 * and carries straight on from it to B's destination. It is one continuous
 * run of returns, and the reader is never tracking two series at once, so a
 * second tier is exactly the wrong answer. Real kanbun spells a run of three
 * returns with three ranks of one tier — 一二三点, 上中下点, 甲乙丙点,
 * 天地人点 — which is what fusing A and B into a single group produces.
 *
 * The case this exists for is 不以飲爲累也 (酒蟲, sent. 4): 爲 is the deferred
 * governor of the INVERT group that reads 累也 before it, and simultaneously
 * the governor of the POSTPOSE group that reads 不 after it. Both groups
 * came out 一二点 and 爲 was written 二一 — two ranks of the same tier on one
 * character, which no edition does. Fused, the three returns are one series:
 * 不㆔ 以㆑ 飲 爲㆓ 累 也㆒, read 飲・以・累・也・爲・不.
 *
 * The shared character need not be the *first*-read member of B, and when it
 * is not, the two groups came out on different tiers rather than the same
 * one — 謂其身有異疾 (酒蟲, sent. 5), where 有 is 謂's rank 2 and the deferred
 * governor of 異疾有, and was written 下二. Same defect, one tier up, and the
 * same answer: 謂㆔ 其 身 有㆓ 異 疾㆒, read 其・身・異・疾・有・謂. See
 * `tryFuse` for what becomes of B's ranks before the join.
 *
 * The tier the fused run lands on is not inherited from either side: it is
 * recomputed, like every other group's, by `assignDepths` on the trial set.
 * That is the whole point — A and B were each other's reason for a tier bump
 * (`sharesGovernorAsMember`, `continuesUnfused` below), so once they are one
 * group that reason is gone and the run falls to whatever nesting genuinely
 * still encloses it: depth 0, 一二三点, in both the sent. 4 and sent. 5 cases.
 *
 * Never fuses a レ点 group. A レ点 pair already states its whole jump on its
 * own, and a chain of them (不㆑飲㆑酒) is ordinary notation; absorbing one
 * into a numeral series would silently trade a mark editions do use for one
 * they would not write here. So `isRe` is settled before this runs and a
 * レ点 group is passed over on both sides of the join — extending a group's
 * rank count can never change whether some other group renders as レ点.
 *
 * A fuse is also refused when the series it would make is longer than the
 * tier it lands on can spell (`MAX_RANKS_BY_DEPTH`) — 一二三四 is as far as
 * the numeric tier is charted and 上中下 has no fourth symbol at all. Since a
 * fuse changes the nesting picture for every other group, the tier is not
 * knowable in advance; each candidate is tried, depths recomputed, and the
 * fuse kept only if every group still fits its own tier. When it does not,
 * the two groups stay separate and `assignDepths` escalates the downstream
 * one instead, so the run of returns is written as a nesting (下 then 甲乙,
 * say) rather than in symbols no edition has. That is a real notation and a
 * reader can follow it; it is simply not the one this rule prefers. Nothing
 * in the corpus produces a chain longer than three, so this is a guard
 * rather than a behaviour anything currently exercises. */
function fuseChains(groups: SpliceGroup[]): void {
  for (;;) {
    assignDepths(groups);
    const fused = tryFuse(groups, groups.filter((g) => !fitsItsTier(g)).length);
    if (!fused) return;
    groups.length = 0;
    groups.push(...fused);
  }
}

/** `groups` with the first admissible join applied, or `undefined` when no
 * join is admissible. A join is rejected when either side is a レ点 group,
 * when the fused series would repeat a token (two groups pointing at each
 * other — a return chain that came back to where it started is not a chain),
 * or when the result would overrun a tier's rank alphabet.
 *
 * The join point is A's *last-read* member — the last entry of `rankTokenIds`,
 * which is in reading order — found anywhere in B except B's own last entry.
 * The common case is B's *first* entry (the 爲 case: an INVERT group's
 * deferred governor is also the governor a POSTPOSE group reads first), but
 * a group's series can equally be picked up again from one of its *middle*
 * ranks — 謂其身有異疾 (酒蟲 sent. 5), where 謂 has two INVERT children and 有,
 * the second of them, is itself the deferred governor of 異疾有. There A's
 * returns end at 有 and B's series carries straight on from 有 to 謂: still
 * one continuous run, still one series, and 有 was being written 下二 for want
 * of noticing it.
 *
 * B's ranks *before* the join point are dropped rather than carried into the
 * fused series. They are read before A's series even begins, at the source
 * positions the text already put them in (they are B's governor's earlier
 * INVERT children, whose subtrees precede the join point's), so no return
 * ever lands on them and no mark is needed to reach them — 其身 in the sent. 5
 * case reads straight through. Carrying them would also break the series
 * itself: a rank series is a cascade of *returns*, each rank at an earlier
 * source position than the one before, and a dropped-in earlier child sits
 * the wrong way round (身 at source 7 ahead of 疾 at 10), which no reader
 * following the numerals could resolve.
 *
 * Fusing changes every group's nesting depth and so every group's tier, and
 * `overCapacity` is how many groups already do not fit theirs — measured on
 * the same set before this join. A join is admissible when the fused group
 * itself fits and the count of misfits does not go up; comparing rather than
 * demanding a clean sheet keeps one group that is already past its tier from
 * blocking unrelated fuses elsewhere in the sentence. */
function tryFuse(groups: SpliceGroup[], overCapacity: number): SpliceGroup[] | undefined {
  for (let i = 0; i < groups.length; i++) {
    for (let j = 0; j < groups.length; j++) {
      if (i === j) continue;
      const a = groups[i];
      const b = groups[j];
      if (a.isRe || b.isRe) continue;
      const join = a.rankTokenIds[a.rankTokenIds.length - 1];
      // Not b's own last entry: two series that *end* at the same token do
      // not continue one another, and the token-repeat check below would
      // reject the concatenation anyway.
      const at = b.rankTokenIds.indexOf(join);
      if (at === -1 || at === b.rankTokenIds.length - 1) continue;
      const rankTokenIds = [...a.rankTokenIds, ...b.rankTokenIds.slice(at + 1)];
      if (new Set(rankTokenIds).size !== rankTokenIds.length) continue;
      // A fused series has >= 3 members, so it is never レ点.
      const joined: SpliceGroup = { rankTokenIds, depth: 0, isRe: false, kind: "chain" };
      const trial = groups.map((g, k) => (k === i ? joined : g));
      trial.splice(j, 1);
      assignDepths(trial);
      if (fitsItsTier(joined) && trial.filter((g) => !fitsItsTier(g)).length <= overCapacity) return trial;
    }
  }
  return undefined;
}

/** Whether a group's rank count is one its tier can actually spell. レ点 has
 * no series at all, and a depth past the last tier is its own documented
 * limitation (everything that deep is written 天地人) rather than this
 * function's business. */
function fitsItsTier(group: SpliceGroup): boolean {
  if (group.isRe) return true;
  return group.rankTokenIds.length <= MAX_RANKS_BY_DEPTH[Math.min(group.depth, MAX_RANKS_BY_DEPTH.length - 1)];
}

/** Fills in every group's nesting `depth` — how many other groups' series
 * are already in progress at the point this one has to be read out. Depth 0
 * is 一二点, 1 is 上下点, 2 is 甲乙点, 3 and beyond 天地点 (see
 * `TIER_BY_DEPTH`). Reads `isRe`, which must already be settled. */
function assignDepths(groups: SpliceGroup[]): void {
  const spans = groups.map(span);
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
      //
      // For an INVERT group this is the same shared character `fuseChains`
      // fuses on, so reaching here at all means the fuse was declined —
      // the series it would make outruns its tier's alphabet, and the run of
      // returns has to be written as a nesting after all. It is still live in
      // its own right for a POSTPOSE group, whose governor is its *first*-read
      // member rather than its last, and which therefore never offers that
      // character as a join point (木直中繩's 爲).
      //
      // Not counted against a レ点 `other`: a レ点 group writes one glyph, on
      // its own last entry, and nothing at all on its other member. A numeral
      // series whose governor is that unmarked member collides with nothing
      // there (但令㆑於… — 令 takes the レ, 於 takes the numeral, two
      // characters), and one whose governor is the marked member gets the
      // ordinary combined 一レ every edition writes. Neither needs a tier of
      // its own to stay legible.
      const governor = governorOf(group);
      const sharesGovernorAsMember =
        !other.isRe && other.rankTokenIds.includes(governor) && governorOf(other) !== governor;
      // A chain `fuseChains` declined to fuse. Between two numeral-tier
      // groups the only reason it declines is that the fused series would
      // overrun the tier's alphabet, so the run of returns has to be written
      // as a nesting after all: this group starts where `other` finished, and
      // escalating it puts the continuation on the next tier (…下, then 甲乙)
      // instead of a second series of symbols the same tier already spent.
      // Not applied to レ点 on either side — a レ点 chain (不㆑飲㆑酒) is
      // ordinary notation and takes no tier of its own.
      const continuesUnfused =
        !group.isRe && !other.isRe && group.rankTokenIds[0] === other.rankTokenIds[other.rankTokenIds.length - 1];
      if (strictlyContains || sharesGovernorAsMember || continuesUnfused) depth++;
    });
    group.depth = depth;
  });
}

/** How long the clause a two-member group jumps over is, in characters, with
 * punctuation discounted — the quantity the レ点 rule is stated in terms of.
 * レ点 is the one-character return (一字返り); two characters or more is what
 * 一二点 exists for.
 *
 * "The clause" is the stretch of *source* text the reader takes in before
 * returning: from just after the character that will carry the mark, down to
 * and including the group's other member. The mark goes on the source-earlier
 * member — `rankTokenIds`'s last entry, read second, for both an INVERT
 * governor and a postposed negation — so that is where the stretch starts.
 * The reorder engine leaves everything except the governor's own run where
 * the source put it, so this source stretch is exactly the material read
 * before the return; it is not the governor's whole dependency subtree, which
 * can reach further than the return does.
 *
 * Punctuation does not count. A 、 or 。 or a quote bracket is editorial, not
 * text a kaeriten passes over, and a one-character clause with a comma after
 * it is still one character: 劉答言：「無。」 returns over the single character
 * 無 and takes レ点, though 言 and 無 are three token positions apart.
 *
 * Characters, not tokens: a multi-character token (三百, 番僧) is a
 * two-character return however the tokenizer split it, so it is not a レ点.
 *
 * A group whose marked member is *not* the source-earlier one measures an
 * empty stretch and so counts 0 — nothing is being returned over, and レ点
 * would be the wrong mark. */
function clauseLengthIn(sentence: ReadingPlan["sentence"]): (group: SpliceGroup) => number {
  const contentLength = new Map<number, number>(
    sentence.tokens.map((t) => [t.id, t.dep === "punct" ? 0 : [...t.text].length]),
  );
  return (group) => {
    const marked = group.rankTokenIds[group.rankTokenIds.length - 1];
    const other = group.rankTokenIds[0];
    let chars = 0;
    for (const [id, length] of contentLength) if (id > marked && id <= other) chars += length;
    return chars;
  };
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
 * `plan.spliceGroups` directly and *does* accumulate both marks).
 *
 * Mutates `plan.spliceGroups` in place, and — since `fuseChains` replaces an
 * overlapping pair with the single extended series real notation writes —
 * may leave it *shorter* than `computeReadingOrder` built it. Every consumer
 * (`buildMarkMap`, `KundokuView`) reads the array after this call, so they
 * all see the fused groups. */
export function assignKundokuTen(plan: ReadingPlan): Map<number, KundokuMark> {
  const groups = plan.spliceGroups;
  const marks = new Map<number, KundokuMark>();

  // isRe first: `fuseChains` needs it settled, since it never absorbs a
  // レ点 group into a numeral series.
  const clauseLength = clauseLengthIn(plan.sentence);
  for (const group of groups) {
    group.isRe = group.rankTokenIds.length === 2 && clauseLength(group) === 1;
  }

  fuseChains(groups);
  assignDepths(groups);

  groups.forEach((group) => {
    const tier: KundokuTier = group.isRe
      ? "re"
      : TIER_BY_DEPTH[Math.min(group.depth, TIER_BY_DEPTH.length - 1)];

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
