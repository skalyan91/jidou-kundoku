import type { KundokuMark, KundokuTier, ReadingPlan, SpliceGroup } from "./types.ts";

/** The tiers in the order kundoku convention stacks them, innermost first:
 * a return that encloses nothing else is 一二点, the return that brackets a
 * 一二点 series is 上中下点, and so on out to 天地人点. レ点 sits below all of
 * them and carries no series (see `assignKundokuTen`).
 *
 *   レ点 → 一二点 → 上中下点 → 甲乙丙点 → 天地人点
 *
 * The rule the teaching sources state it as is 「上中下点は、一二三点を挟んで
 * 使います」 — the upper tier is the one that *brackets* the lower. Worked
 * example: 見㆘読㆓漢文㆒者㆖, read 漢・文・読・者・見. 読's return over 漢文 is
 * the inner series and takes 一二; 見's return over the whole 読漢文者 encloses
 * it and takes 上下. Index 0 is therefore the *innermost* numeral tier, and
 * `assignDepths` measures how deeply a group nests *around* others. */
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
 * edition uses (see `fuseChains`). Indexed the same way `TIER_BY_DEPTH` is.
 *
 * What is compared against this is the count of ranks a group is actually
 * *written* with — `returnPoints`, not every member — since a member the
 * reader reaches by carrying straight on carries no mark and so spends none
 * of the alphabet. */
const MAX_RANKS_BY_DEPTH = [4, 3, 3, 3];

/** Fuses splice groups that *overlap* rather than nest.
 *
 * Two groups NEST when one of them has to be read out completely while the
 * other's series is still in progress — the reader is inside group A,
 * reaches a member of A that cannot be read without first running the whole
 * of group B, and so is tracking two series at once. That is what the tiers
 * exist for, and it is what `assignDepths` below detects and escalates — the
 * *enclosing* series taking the upper tier: 一二点 inside 上中下点 inside
 * 甲乙丙点 inside 天地人点.
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
 * The case this was written for is 不以飲爲累也 (酒蟲, sent. 4): 爲 is the
 * deferred governor of the INVERT group that reads 累也 before it, and
 * simultaneously the governor of the POSTPOSE group that reads 不 after it.
 * Both groups came out 一二点 and 爲 was written 二一 — two ranks of the same
 * tier on one character, which no edition does. Fused, the three returns are
 * one series: 不㆔ 以㆑ 飲 爲㆓ 累 也㆒.
 *
 * **That sentence no longer reaches here**, and it is worth saying why rather
 * than quietly changing the example. Its 也 was travelling inside 累's block
 * and being read before 爲 — 累なり爲さず — which both made the return from 累
 * two characters long and put the series' 一 on the particle. The particle now
 * stays where the source has it and is read last (`isClosingParticle` in
 * `reorderEngine.ts`), so the return is over the single character 累, which is
 * レ点, and a レ点 is never fused: the sentence is written 不㆓ 以㆑ 飲 爲㆒㆑ 累
 * 也 — a stacked 一レ点 — and read 飲・以・累・爲・不・也, which is the received
 * 飲を以て累と爲さざるなり. What still exercises the fuse is 謂其身有異疾 just
 * below.
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
 * (the second and third clauses of `enclosesForTier` below), so once they are
 * one group that reason is gone and the run falls to whatever nesting it
 * genuinely still brackets: depth 0, 一二三点, in both the sent. 4 and sent. 5
 * cases.
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

/** The members of a group that actually carry a rank, in reading order — the
 * points where the reader has to *return*, which is the only thing a kaeriten
 * says.
 *
 * A kaeriten series is read like this: run forward through the written text,
 * passing over every character that carries a return mark; on reaching the
 * character marked 一, read it and jump back up to 二, then to 三. Every step
 * of that walk is a jump *backwards*, so a series stands in the written text
 * in descending order — 三 … 二 … 一, 下 … 上 — and a character the reader
 * arrives at by simply carrying on forward needs no mark at all, because
 * carrying on forward is what the reader does unbidden.
 *
 * So a rank is emitted only at a step of `rankTokenIds` that runs *backwards*
 * through the source, and on both of that step's ends: the character the
 * reader jumps from and the character it lands on. A group whose members are
 * read A, B, C where B and C stand in that order in the text has one return in
 * it — C back to A — and is written A㆓ B C㆒, not A㆔ B㆒ C㆓. B's mark would
 * be telling the reader to do what he was going to do anyway, and it would put
 * a 一 in the text ahead of a 二, which is not a shape the notation has.
 *
 * **Counted, not assumed.** 論語集説 as transcribed on ja.wikisource — an Edo
 * commentary edition carrying its own 訓点, 741,962 characters over fifteen
 * chapters — has 1,204 places where one mark of a tier is followed by another
 * of the same tier within a series, and every one of them descends. Not one
 * ascending step, and in particular not one 三…一…二. (The 17 apparent
 * exceptions are all a mark repeating itself — 二 … 二 — where the
 * transcription dropped the closing 一 of the first series.) kanbun.info, the
 * corpus this project measures itself against, prints 白文 and 書き下し文 only
 * and carries no 返り点 at all, so it has nothing to say about the question.
 *
 * A group with no backward step at all yields nothing to mark, which is the
 * right answer: nothing about it departs from the written order.
 *
 * What this does *not* mend is a group whose reading order returns, runs
 * forward past where it started, and returns again — 亂生於治、怯生於勇 is one
 * (生 read at source 11, then 於 at 2, then 於 at 7, then 亂 at 0): the ranks
 * it needs stand in the text as 四 二 三 一, which is not a series any reader
 * could follow, and no choice of marks here would make it one. 49 of the
 * corpus's 8,017
 * numeral groups are that shape, and every one of them is a reading order the
 * engine produced, not a notation this file can choose better: the fix for
 * them is upstream, in how a governor's children come to be read out of source
 * order. */
export function returnPoints(group: SpliceGroup): number[] {
  const ids = group.rankTokenIds;
  const marked = new Set<number>();
  for (let i = 1; i < ids.length; i++) {
    if (ids[i] < ids[i - 1]) {
      marked.add(ids[i - 1]);
      marked.add(ids[i]);
    }
  }
  return ids.filter((id) => marked.has(id));
}

/** Whether a group's rank count is one its tier can actually spell. Counted
 * over the ranks the group will really be *written* with (`returnPoints`) and
 * not over its members, since a member the reader reaches by reading forward
 * spends no symbol of the tier's alphabet. レ点 has no series at all, and a
 * depth past the last tier is its own documented limitation (everything that
 * deep is written 天地人) rather than this function's business. */
function fitsItsTier(group: SpliceGroup): boolean {
  if (group.isRe) return true;
  return returnPoints(group).length <= MAX_RANKS_BY_DEPTH[Math.min(group.depth, MAX_RANKS_BY_DEPTH.length - 1)];
}

/** Whether `group` has to be written a tier *above* `other` — i.e. `group`'s
 * series is still open across the whole of `other`'s, so the two cannot share
 * one alphabet and `group` is the one that brackets. Both are numeral groups;
 * `assignDepths` filters レ点 out before asking. `span`/`otherSpan` are the
 * two groups' own `span(...)` values, passed in rather than recomputed. */
function enclosesForTier(group: SpliceGroup, other: SpliceGroup, span: [number, number], otherSpan: [number, number]): boolean {
  // Genuine nesting: this group's span strictly contains the other's — the
  // other's tokens sit *inside* resolving one of this group's own members'
  // subtrees, so the reader opens this series, runs the other's out
  // completely, and only then comes back. That is the textbook picture the
  // tiers are named for: 見㆘読㆓漢文㆒者㆖, where 見's return brackets 読's.
  if (span[0] < otherSpan[0] && span[1] > otherSpan[1]) return true;
  // Same-token collision: the *other* group's governor is also a plain
  // (non-governor) member of this one — the case a purely span-based check
  // misses, since the two spans merely abut rather than nest (a token that
  // is simultaneously this group's rank-2 member and its own separate
  // group's governor — 木直中繩's 爲). Left on one tier, that character
  // would need two mutually-exclusive marks from the same alphabet.
  //
  // This group is the one that brackets. The reader reaches the shared
  // character mid-way through *this* group's series — it is one of this
  // group's ranks, not its last — and the other's series closes there, having
  // been entered from a later source position; so the other's whole series
  // falls between two of this group's ranks while this group is still waiting
  // for the rest of its own. Escalating the *inner* one instead settles the
  // same collision and is what this file did before the tier direction was
  // corrected, but it writes the bracketing return on the lower tier.
  //
  // Reaching here at all means `fuseChains` declined the join, since this is
  // the same shared character it fuses on: the series the two would make
  // outruns its tier's alphabet, and the run of returns has to be written as a
  // nesting after all. (A POSTPOSE other cannot arrive here — its governor is
  // its first-read member, and `reorderEngine` ranks a governor's child by the
  // *last*-read token of that child's block, which for a negated child is the
  // negation rather than the verb. So a postposed verb is never another
  // group's plain member.)
  const governor = governorOf(group);
  const otherGovernor = governorOf(other);
  if (otherGovernor !== governor && group.rankTokenIds.includes(otherGovernor)) return true;
  // A chain `fuseChains` declined to fuse. Between two numeral-tier groups
  // the only reason it declines is that the fused series would overrun the
  // tier's alphabet, so the run of returns has to be written as a nesting
  // after all: this group starts at the character where `other` finished, and
  // so is still open once the other's series has been read out — exactly
  // 見㆘読㆓漢文㆒者㆖'s shape, where 見's 上 is picked up at the character
  // 読's 二 closes on. The continuation is the bracketing one and takes the
  // upper tier.
  return group.rankTokenIds[0] === other.rankTokenIds[other.rankTokenIds.length - 1];
}

/** Fills in every group's nesting `depth` — how many tiers of numeral series
 * this one has to be written *above*, so that a group and everything its own
 * series brackets never share an alphabet. Depth 0 is 一二点, 1 is 上中下点,
 * 2 is 甲乙丙点, 3 and beyond 天地人点 (see `TIER_BY_DEPTH`, which states the
 * convention this direction comes from). Reads `isRe`, which must already be
 * settled.
 *
 * It is the *longest chain* of enclosed groups, not the count of them: two
 * groups this one brackets which do not bracket each other are read one after
 * the other, never simultaneously, so they share 一二点 quite happily and
 * this group only needs to clear them by one. Counting would spend a tier per
 * sibling and skip straight past 上中下点 for a sentence that never needed it.
 *
 * レ点 groups are neither counted nor ranked. A レ点 states its whole jump on
 * one glyph on one character and spends no alphabet, so nothing has to clear
 * it (有㆓朋自㆑遠方來㆒ keeps 有's return on 一二点, and 謂㆔其身有㆓異疾㆒ its
 * fused three), and its own `depth` is left 0 and unread — `assignKundokuTen`
 * gives it the "re" tier whatever it says. */
function assignDepths(groups: SpliceGroup[]): void {
  const spans = groups.map(span);
  const depths = groups.map(() => 0);
  // 0 = not yet computed, 1 = being computed, 2 = final. `enclosesForTier` is
  // not guaranteed acyclic (two groups can each name the other's governor
  // among their members), and a group reached again while it is still being
  // computed contributes 0 rather than recursing forever — a cycle has no
  // innermost member to start counting from, so no tier can separate its
  // members and the best available answer is not to escalate on it.
  const state = groups.map(() => 0);
  const resolve = (i: number): number => {
    if (state[i] !== 0) return state[i] === 2 ? depths[i] : 0;
    state[i] = 1;
    let depth = 0;
    if (!groups[i].isRe) {
      groups.forEach((other, j) => {
        if (j === i || other.isRe) return;
        if (enclosesForTier(groups[i], other, spans[i], spans[j])) depth = Math.max(depth, resolve(j) + 1);
      });
    }
    depths[i] = depth;
    state[i] = 2;
    return depth;
  };
  groups.forEach((group, i) => {
    group.depth = resolve(i);
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
    // at all. A numeral tier marks the members the reader has to *return* to
    // or from and no others (`returnPoints`), so its ranks always descend
    // through the written text — a member read in forward continuation from
    // the one before it is reached without a mark.
    if (group.isRe) {
      const last = group.rankTokenIds[group.rankTokenIds.length - 1];
      marks.set(last, { tier });
    } else {
      returnPoints(group).forEach((id, index) => {
        marks.set(id, { tier, rank: index + 1 });
      });
    }
  });

  return marks;
}
