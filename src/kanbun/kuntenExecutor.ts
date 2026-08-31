/** Reconstructs Japanese reading order purely from a linear sequence of
 * kaeriten (返り点) marks — the inverse operation of
 * `kundoku/reorderEngine.ts` + `kundoku/kundokuTenAssigner.ts`, which derive
 * those marks from a dependency tree. This is what lets an edited kunten
 * annotation (see `texAnnotation.ts`) drive a live re-render of the
 * kakikudashi panel without a dependency tree at all — exactly the
 * traditional pen-and-paper procedure for *reading* kunten-marked text,
 * implemented as code.
 *
 * The key structural fact this relies on (verified against
 * `tests/kuntenExecutor.test.ts`'s real-parse fixtures): a numeral group's
 * *governor* is always the source-earliest position among that group's
 * members — it carries the tier's highest rank, and its role mirrors an
 * ordinary SVO verb sitting before the object(s) that must be read before
 * it. So encountering a numeral mark with no enclosing search already
 * looking for it means *this* position opens a new group needing exactly
 * `rank` children (ranks 0..rank-1), which appear at *later* source
 * positions, each resolved (recursively — a child can itself be an
 * arbitrarily complex sub-unit) before the governor itself.
 *
 * Marks are plain characters (一二三四, 上中下, 甲乙丙, 天地人, レ), not the
 * Unicode Kanbun-block glyphs used for on-screen display — see
 * `texAnnotation.ts`'s plain-glyph table for that mapping. A position can
 * carry more than one stacked mark (e.g. simultaneously a numeral-tier
 * group's member *and* itself the governor of its own nested group); see
 * `render/kundokuGlyphs.ts`'s `buildMarkMap` stacking-order note, which
 * this mirrors: marks are ordered innermost-first, outermost-last — i.e.
 * "resolve as *me*" only after peeling off whatever an enclosing group
 * needed from me first. */

const TIER_NUMERALS = ["一二三四", "上中下", "甲乙丙", "天地人"];

function tierOf(mark: string): number {
  return TIER_NUMERALS.findIndex((t) => t.includes(mark));
}

function rankOf(mark: string): number {
  const tier = tierOf(mark);
  return tier === -1 ? -1 : TIER_NUMERALS[tier].indexOf(mark);
}

/** Splits a stacked kunten string ("三二", "上レ") into its individual mark
 * characters, innermost (resolved first) to outermost. */
export function parseMarkStack(kunten: string | undefined): string[] {
  return kunten ? [...kunten] : [];
}

function peelAt(marks: string[], idx: number): string[] {
  return [...marks.slice(0, idx), ...marks.slice(idx + 1)];
}

/** Resolves *exactly* the unit at position `j` — a bare token (if
 * unmarked), a レ-pair, or a numeral-tier group + its governor — with NO
 * leading-unmarked-run sweep first. This is the piece a レ-jump's pair
 * partner and a numeral group's own governor-self both need: "interpret
 * whatever's structurally right here," never "skip ahead past unrelated
 * later content looking for the next mark" (that sweeping behavior is
 * `readUnit`/`readChild`'s job, and calling it here instead was the
 * original bug — see the test fixtures' regression history). */
function readExactly(marksOf: string[][], j: number, end: number, isPunct: (i: number) => boolean): { order: number[]; next: number } {
  if (j >= end) return { order: [], next: j };
  const marks = marksOf[j];
  if (marks.length === 0) return { order: [j], next: j + 1 };

  const outer = marks[marks.length - 1];

  if (outer === "レ") {
    marksOf[j] = peelAt(marks, marks.length - 1);
    // レ pairs with the single *character* following it (kundokuTenAssigner's
    // own isRe condition requires exactly one character, punctuation
    // discounted). Punctuation is not text a kaeriten passes over — 劉答言㆑
    // ：「無。 returns over 無, three positions along — so any punctuation
    // between is stepped past here, and emitted ahead of the pair since
    // nothing downstream cares where a punct position lands.
    let partner = j + 1;
    const skipped: number[] = [];
    while (partner < end && isPunct(partner) && marksOf[partner].length === 0) {
      skipped.push(partner);
      partner++;
    }
    const { order: inner, next } = readExactly(marksOf, partner, end, isPunct);
    const self = readExactly(marksOf, j, j + 1, isPunct).order;
    return { order: [...skipped, ...inner, ...self], next };
  }

  const tier = tierOf(outer);
  const rank = rankOf(outer);
  marksOf[j] = peelAt(marks, marks.length - 1);

  if (rank === 0) {
    // A *postpose* group (reorderEngine.ts's `[nodeId, ...postposeOrders]`
    // construction always puts the governor first) — unlike an INVERT
    // governor, which always carries a tier's *highest* rank (a real group
    // needs >=2 members, so an invert governor's rank — its own children's
    // count — can never be 0), rank 0 unambiguously means *this* position
    // is a postpose governor: read it first, then the one other member
    // that follows (postposing multiple simultaneous siblings of one
    // governor is rare enough that only the common single-child case is
    // handled). Matched by tier alone, not an exact rank: a 2-member
    // jou-ge/kou-otsu/ten-chi group skips its middle symbol (上下, not
    // 上中下) the same way real kanbun notation does, so that lone other
    // member's mark reads as the tier's *last* symbol (下/乙/地) — which
    // `rankOf` (a fixed 3-slot alphabet position) would misreport as rank 2
    // rather than the 1 a real 2-member group has.
    const self = readExactly(marksOf, j, j + 1, isPunct).order;
    const child = readChild(marksOf, j + 1, end, (m) => tierOf(m) === tier, isPunct);
    return { order: [...self, ...child.order], next: child.next };
  }

  // INVERT-style group: this position is the governor, and every lower rank
  // of its tier that is really in play below it is a child, each found via
  // `readChild` at consecutively later positions, all read before the
  // governor itself.
  //
  // "Really in play" rather than a flat 0..rank-1, for the same
  // skipped-symbol reason the rank-0 branch above spells out: a tier's
  // symbols are a fixed 3-slot alphabet, but a 2-member group writes only
  // its ends — 上下, not 上中下 — so the governor of such a group carries the
  // tier's *last* symbol and `rankOf` reports 2 where the group has one
  // child. Asking which ranks the rest of the sentence actually carries
  // settles that without guessing: a well-formed 一二三 group has both 一 and
  // 二 below its 三, and an 上下 pair has only 上. Searching for the absent
  // 中 was not merely fruitless — `readChild` sweeps to the end of the
  // sentence looking for it, and everything it passes on the way is read as
  // part of the group (酒蟲's 三[下]寸許ヲ[上] swallowed the whole rest of its
  // sentence that way).
  const wantedRanks: number[] = [];
  for (let k = j + 1; k < end; k++) {
    for (const mark of marksOf[k]) {
      const r = rankOf(mark);
      if (tierOf(mark) === tier && r < rank && !wantedRanks.includes(r)) wantedRanks.push(r);
    }
  }
  wantedRanks.sort((a, b) => a - b);

  const collected: number[] = [];
  let scanPos = j + 1;
  for (const wantRank of wantedRanks) {
    const child = readChild(marksOf, scanPos, end, (m) => tierOf(m) === tier && rankOf(m) === wantRank, isPunct);
    collected.push(...child.order);
    scanPos = child.next;
  }
  const self = readExactly(marksOf, j, j + 1, isPunct).order;
  return { order: [...collected, ...self], next: scanPos };
}

/** Finds and resolves the next unit an *enclosing* numeral group needs — a
 * leading unmarked run (real pre-content belonging to this child — e.g.
 * its own subj/mod dependents sitting before it in source order), then
 * whichever position carries a mark satisfying `matches` *anywhere in its
 * remaining stack* (not necessarily its outermost — peeling it off first,
 * then resolving whatever's left on that position via `readExactly`).
 * This distinction (an explicitly-targeted mark vs. whatever `readExactly`
 * would interpret unprompted) is what a plain recursive scan can't get on
 * its own: the very same mark can simultaneously be "the rank an outer
 * group is waiting for" *and*, once peeled, reveal a completely
 * independent inner group of the same tier on the same token (see the
 * stacked "三二" case in the test fixtures). Any marked position `matches`
 * rejects is resolved fully in its own right and skipped past — it's some
 * unrelated intervening structure (a different postpose/レ pair, say), not
 * a sign the target doesn't exist further on. */
function readChild(
  marksOf: string[][],
  i: number,
  end: number,
  matches: (mark: string) => boolean,
  isPunct: (i: number) => boolean,
): { order: number[]; next: number } {
  const collected: number[] = [];
  let pos = i;
  for (;;) {
    while (pos < end && marksOf[pos].length === 0) {
      collected.push(pos);
      pos++;
    }
    if (pos >= end) return { order: collected, next: pos };
    const marks = marksOf[pos];
    const idx = marks.findIndex(matches);
    if (idx !== -1) {
      marksOf[pos] = peelAt(marks, idx);
      const { order: self, next } = readExactly(marksOf, pos, end, isPunct);
      return { order: [...collected, ...self], next };
    }
    // Whatever's marked here isn't our target — it's some unrelated
    // intervening structure (a different レ/numeral group entirely, e.g.
    // a postposed negation chain sitting between this group's members).
    // Resolve it fully in its own right and keep searching past it.
    const { order: self, next } = readExactly(marksOf, pos, end, isPunct);
    collected.push(...self);
    pos = next;
  }
}

/** Top-level scan step: a leading unmarked run, then whatever the next
 * marked position resolves to (via `readExactly`). */
function readUnit(marksOf: string[][], i: number, end: number, isPunct: (i: number) => boolean): { order: number[]; next: number } {
  const leading: number[] = [];
  let j = i;
  while (j < end && marksOf[j].length === 0) {
    leading.push(j);
    j++;
  }
  if (j >= end) return { order: leading, next: j };
  const { order: self, next } = readExactly(marksOf, j, end, isPunct);
  return { order: [...leading, ...self], next };
}

/** Computes the Japanese reading-order permutation (indices into `kuntens`)
 * for one sentence's worth of kunten marks, given in source order.
 * `kuntens[i]` is that position's plain-character mark string (e.g. "一",
 * "レ", "三二", or undefined/"" for an unmarked position — including every
 * punctuation mark and most ordinary tokens). Punctuation's exact position
 * in the returned order isn't meaningful (real kakikudashi generation
 * drops it entirely regardless — see `annotationEditor.ts`), only
 * content tokens' relative order is.
 *
 * `isPunct` says which positions hold punctuation, and only a レ点 consults
 * it: レ点 is the one-*character* return, and a 、 or a quote bracket sitting
 * between a レ点 and the character it returns over is not a character the
 * mark passes over (`kundokuTenAssigner.ts`'s `clauseLengthIn` discounts
 * punctuation on the way in, so this has to discount it on the way back
 * out). Callers that do not know which positions are punctuation may omit
 * it; every position is then treated as text, which is what this function
 * did before the option existed. */
export function executeKunten(kuntens: (string | undefined)[], isPunct: (i: number) => boolean = () => false): number[] {
  const marksOf = kuntens.map(parseMarkStack);
  const order: number[] = [];
  let i = 0;
  while (i < marksOf.length) {
    const { order: unit, next } = readUnit(marksOf, i, marksOf.length, isPunct);
    order.push(...unit);
    i = next;
  }
  return order;
}
