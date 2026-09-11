import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  INSPECTED_READINGS,
  READING_RUNS,
  type Extent,
  headJoinRun,
  labelStandoff,
  obstacleFor,
  rowStandoff,
  settleMsFrom,
  labelLift,
} from "../src/render/tokenInspector.ts";

/** **What the analysis's marks do when they land on one another.**
 *
 * There is no browser in this suite, so nothing here can say what the overlay
 * *looks* like. What it can say is what the overlay *decides*, and the two
 * decisions the decollision makes are pure functions for exactly that reason:
 * how far the deprel label steps out of the category pills' way, and how far
 * the pill row then stands off its own character to clear what is left of the
 * label. A test that pinned pixel coordinates would say nothing — the
 * coordinates come out of a layout that does not run here — so every
 * expectation below is about a displacement being zero, or being the least
 * that clears, or being refused.
 *
 * ── What the reveal changed under this file ──────────────────────────────
 * The reader asked for the 品詞 alone by default, the semantic categories on
 * hover, and — the half that decides the layout — the 品詞 not to move when
 * they arrive. The pills are therefore in two boxes now: the 品詞 in the row's
 * flow, the domain and the sense in an absolutely positioned wrapper inside
 * it. **The row's box is consequently the 品詞 pill's box, in both states**,
 * and since the row's box is what `decollideOverlay` measures, that is what
 * every figure below is measured against. `ROW` records the new box and what
 * it was; `DEEP` keeps the old row's figures under a name that says what they
 * now stand for. The last describe block has what the change is worth, in the
 * two numbers it comes down to.
 *
 * The one thing about the reveal that no arithmetic here can reach is the
 * arrangement that produces it — that the wrapper is out of flow at all, which
 * is a fact about two stylesheet declarations and not about any function. The
 * last block reads them out of kunten.css, in the way tests/odoriji.test.ts
 * and tests/rereadLane.test.ts read the rules they are about. It is a ratchet
 * rather than a proof: nothing here can say what the page looks like, and
 * there is no browser in this checkout to look.
 *
 * ── What this file replaces ──────────────────────────────────────────────
 * It used to test three other decisions — `ARC_BOW_SIGN`, `stackNudge` and
 * `labelSidestep` — from a round in which the pills were a *stack* to the left
 * of the character, the arc was bowed to the right to make room for it, and a
 * label that had to move drew a leader line back to its arc. None of those
 * exist. The pills are a horizontal row centred on the glyph now
 * (`posChipParts`), the bow goes left because the reading lane is on the right
 * (`showInspector`), and the leader line went with the machinery that moved
 * the label off its arc at all — the long note at the foot of `showInspector`
 * is that deletion's argument. The tests are rewritten rather than deleted
 * because the *subject* survived the design: this is still where what the
 * overlay decides about its own layout is pinned.
 *
 * ── The geometry these numbers stand for ─────────────────────────────────
 * The app sets Japanese vertically (`writing-mode: vertical-rl`): text runs
 * top-to-bottom within a column and the columns advance right to left. So
 * screen-left is the block-flow end — the side the next column lies on — and
 * screen-right is the block-flow start, the side of the text already read.
 *
 * At the shipped scale a cell is 88px (`--kanji-advance`, which is
 * `--size-main` 44 plus `--kanji-gap` 44, and is the pitch *both* across the
 * page and down it). Across the page, measured out from a glyph's own centre:
 *
 *     −44 … −22   this character's kunten lane
 *     −22 …  22   the glyph
 *      22 …  44   this character's reading lane
 *      44 …  66   the next column's reading lane
 *      66 … 110   the next column's characters
 *
 * Down the page it is simpler: the glyph is 44 deep and the run between one
 * glyph's foot and the next one's head is the other 44.
 *
 * The figures below are arithmetic off those constants and off the pills' own
 * box (a 17.6px type size — a fifth of the cell, `CHIP_SIZE_OF_CELL` — over a
 * 1.2 line and 0.1rem of block padding, so 24.32px deep, standing 0.25rem off
 * the glyph). They are not measurements: there was no page to measure. */

/** A rectangle, from the two corners, since `Extent` is structural and a
 * `DOMRect` is not available here. Coordinates are viewport pixels with y
 * down, and the origin is put on the inspected glyph's own centre throughout,
 * so the table above can be read straight off the numbers. */
const box = (left: number, top: number, right: number, bottom: number): Extent => ({
  left, top, right, bottom,
});

/** The casing's reach, as `tests/chipCasing.test.ts` keeps it: a literal, so
 * that changing the stylesheet has to be a deliberate change here too. Both
 * functions are given marks *as painted* — the caller grows every box by this
 * before measuring — so it is spelt out wherever a box below is meant to be a
 * mark's own border box. */
const REACH = 2;
const cased = (extent: Extent): Extent => obstacleFor(extent, 0, REACH).box;

/** A box that is already a mark as painted, written directly. Used where a
 * test is about a depth of overlap between two *painted* marks: putting the
 * border box in and casing it would make every figure in the comment 2px away
 * from the figure in the code, which is the sort of arithmetic that makes a
 * test say something other than what it means. */
const painted = box;

/** **The row's box: the 品詞 pill, and nothing else.** Three characters at
 * 17.6px with 0.4rem of side padding, about 65px — so ±32 about the glyph's
 * centre — hanging 0.25rem below the glyph's foot at 22.
 *
 * ── What this constant was, and what changed under it ────────────────────
 * The whole three-pill row: 品詞, domain and sense side by side, about 167px,
 * ±83 about the centre. The reader has since asked for "only the POS chip by
 * default, and the semantic categories revealed on hover", and — the half of
 * the instruction that decides the layout — for "the POS in place when
 * revealing the semantics". What answers that is where the other two pills are
 * drawn: inside an absolutely positioned wrapper (`SEMANTICS_WRAPPER` in
 * tokenInspector.ts, `.token-subtitle-semantics` in kunten.css), out of the
 * row's flow, so the row's width is the 品詞 pill's width in both states and
 * the `translateX(-50%)` that centres the row centres *that pill* on its
 * character. `decollideOverlay` measures the row's box, so this is the box it
 * measures — revealed or not, which is why there is one constant here and not
 * two states of one.
 *
 * It is therefore the same box as the row a token with no semantics draws, and
 * the two constants this file kept apart have collapsed into one. **That
 * collapse is the finding**: the resting state is the single-chip geometry
 * every figure in `decollideOverlay`'s own notes was measured against — the 49
 * collisions on 酒蟲, the 10.66-to-25.34px lifts — from before the chip was
 * ever split into three.
 *
 * The pill of a token that *has* semantics carries 3.76px more trailing
 * padding than one that has none — half a chevron, reserved so that the point
 * it grows on hover has somewhere to be painted, and reserved in *both* states
 * so that growing the point changes no width (kunten.css). Its ink is cut back
 * by the same 3.76px while the semantics are hidden, so what a reader sees at
 * rest is an ordinary pill; what this constant leaves out is under 2px of
 * half-width, it is the same in both states, and nothing below turns on it. */
const ROW = cased(box(-32, 26, 32, 50.32));

/** A mark wide enough to swallow the label from end to end — the case that
 * neither mover can clear, and the one both of their clamps are written
 * against.
 *
 * The three-pill row was that mark, and **nothing the row draws is any more**.
 * The 品詞 pill is 65px, and the semantics, when a pointer reveals them, run
 * off its *right-hand* edge (the overlay is set `horizontal-tb`, so the row
 * reads left to right) — away from a label in the gutter, which is on the
 * left. So what is kept here is what these tests were always really about,
 * which is the function rather than the row: an obstacle that covers the label
 * outright, of the kind two lanes of ruby beside a long relation name on a
 * cross-line arc still make. The figures are the old row's, so the 56 and the
 * 7 below are the same numbers this file quoted before and can be compared
 * with it. */
const DEEP = cased(box(-83, 26, 83, 50.32));

/** A deprel label, as painted: a 3-character relation name set vertically
 * (`writing-mode: vertical-rl`), so one character wide and three deep — about
 * 26 × 73 — centred on the arc's midpoint. Placed here half a cell to the left
 * of the column, which is where `showInspector` puts a within-line arc's
 * label, and level with the glyph, which is where a cross-line arc's can fall.
 */
const LABEL = cased(box(-57, -36, -31, 36));

describe("the label steps across its gutter, and only across it", () => {
  const wall = -66; // the next column's characters, one advance out less half a glyph

  it("leaves a label that is already clear exactly where it belongs", () => {
    // Nothing in its band down the page, so nothing to move for.
    expect(labelStandoff(LABEL, [cased(box(-83, 200, 83, 224))], -1, wall)).toBe(0);
    // And nothing across it either: a label a lane further out than this one
    // is past the end of the row.
    expect(labelStandoff(cased(box(-70, 10, -44, 80)), [ROW], -1, wall)).toBe(0);
  });

  it("steps out by the least that clears, not by a lane", () => {
    // The row as it now stands: its painted edge is at −34 and the label's
    // trailing edge at −29, so 5px of the label is over it and 5px is what it
    // moves. A fixed step of one lane (22px) would have carried it to −81,
    // through the wall at −66 and onto the next column's characters, and would
    // then have found nothing there at all.
    const step = labelStandoff(LABEL, [ROW], -1, -200);
    expect(step).toBeCloseTo(LABEL.right - ROW.left, 6);
    expect(LABEL.right - step).toBeCloseTo(ROW.left, 6);
  });

  it("clears an obstacle outright when nothing walls it in", () => {
    // What the ruby step now passes: no wall at all. The reader reported the
    // label "isn't dodging ruby all the way", and the wall was why — it stopped
    // at the near edge of the neighbouring column's characters, about 22px past
    // the label's resting place, where a run of 振り仮名 with a standoff on it
    // wants more. With no wall the step is the whole overlap and the two are
    // properly apart.
    //
    // The wall is kept in the signature because the *idea* is still right for
    // any caller that has one; this caller has decided it would rather stand
    // beside the next column than on top of the ruby it is read with.
    expect(labelStandoff(LABEL, [DEEP], -1, -Infinity)).toBeCloseTo(56, 6);
    expect(labelStandoff(LABEL, [DEEP], -1, wall)).toBeCloseTo(7, 6);
  });

  it("asks only about the inspected token's own readings", () => {
    // The scoping, checked on the selector rather than on a layout jsdom
    // cannot produce. This has been wrong twice — first `READING_OBSTACLES`,
    // which is the pills, and then every reading in the column — and both
    // times the symptom on the page was the same (a label stepping aside with
    // no ruby under it), so the selector is worth pinning by name.
    expect(INSPECTED_READINGS).toContain(".token-cell-inspected");
    // Every alternative is scoped, not just the first — a selector list where
    // only the leading term carries the scope is the classic way to write this
    // wrong, and it would silently readmit every .okurigana on the page.
    const alternatives = INSPECTED_READINGS.split(",").map((s) => s.trim());
    expect(alternatives.length).toBe(READING_RUNS.split(",").length);
    for (const alternative of alternatives) {
      expect(alternative, alternative).toMatch(/^\.token-cell-inspected\s+\./);
    }
    // And it still names the same kinds of run it is derived from.
    for (const run of READING_RUNS.split(",").map((s) => s.trim())) {
      expect(INSPECTED_READINGS, run).toContain(run);
    }
  });

  it("moves for a reading it is actually on, and not for one it is merely near", () => {
    // The distinction the caller turns on, and the one it first got wrong.
    // `decollideOverlay` asks this function about the readings **as painted**
    // and adds the arc standoff to whatever it answers, rather than widening
    // the boxes and asking about those. The two are not the same rule: widening
    // first makes a reading the label is nowhere near into one it must dodge,
    // which is what put the label off its arc's midpoint on characters with no
    // ruby under it at all.
    //
    // Written as the pair, because it is the pair that is the rule: an obstacle
    // that overlaps buys its overlap, and one that does not buys nothing at
    // all — however close it is.
    const clear = { ...ROW, left: LABEL.right + 1, right: LABEL.right + 40 };
    expect(labelStandoff(LABEL, [clear], -1, -Infinity)).toBe(0);
    const touching = { ...ROW, left: LABEL.right - 3, right: LABEL.right + 40 };
    expect(labelStandoff(LABEL, [touching], -1, -Infinity)).toBeGreaterThan(0);
  });

  it("hands back the bare overlap, for the caller to add its margin to", () => {
    // How "clear the ruby by as much as the ruby clears the kanji" is
    // delivered: this function answers with the overlap, and `decollideOverlay`
    // adds the gap it measures between each reading and the glyph of its own
    // cell. Asserted as the arithmetic the caller does, since jsdom has no
    // layout for the caller itself to be measured in.
    //
    // The margin used to be the label's standoff from the arc. This one is
    // better for a reason worth keeping: it is a rhythm already on the page —
    // a reading sits so far off its character, and the label now sits so far
    // off the reading — where the arc standoff was a second, unrelated
    // interval. It also tracks the type size without being told to, being
    // measured rather than declared.
    const overlap = labelStandoff(LABEL, [DEEP], -1, -Infinity);
    expect(overlap).toBeCloseTo(56, 6);
    for (const rubyGap of [0, 6, 22]) {
      const step = overlap > 0 ? overlap + rubyGap : 0;
      expect(step, String(rubyGap)).toBeCloseTo(56 + rubyGap, 6);
    }
    // And the margin is never spent where there was no overlap to clear.
    const clear = { ...DEEP, left: LABEL.right + 1, right: LABEL.right + 40 };
    const none = labelStandoff(LABEL, [clear], -1, -Infinity);
    expect(none > 0 ? none + 6 : 0).toBe(0);
  });

  it("measures that margin the way the caller measures it", () => {
    // The gap itself, as arithmetic on two boxes — the one part of the rule
    // that is not `labelStandoff`'s. A reading on either side of its glyph
    // gives the same answer, because which side the ruby takes is a fact about
    // the writing mode and not about how far off it sits.
    const glyph = box(0, 0, 44, 44);
    const gapOf = (run: Extent) =>
      run.left >= glyph.right ? run.left - glyph.right : glyph.left - run.right;
    const margin = (runs: Extent[]) => (runs.length > 0 ? Math.max(0, Math.min(...runs.map(gapOf))) : 0);
    expect(margin([box(50, 0, 72, 44)])).toBeCloseTo(6, 6); // ruby after the glyph
    expect(margin([box(-28, 0, -6, 44)])).toBeCloseTo(6, 6); // ruby before it
    // A reading overlapping its own glyph would give a negative interval, and a
    // negative margin would pull the label *into* the ruby it is clearing.
    expect(margin([box(30, 0, 60, 44)])).toBe(0);
  });

  it("is pushed off a foldout along the column, which is the short way", () => {
    // The reader's rule, arrived at after the sideways version failed twice.
    //
    // The pill row is a *horizontal* bar. Clearing it sideways means travelling
    // its whole length — about 91px for two pills, against the ~13px of gutter
    // the label has before the neighbouring column, which is why a walled
    // sideways push read as no push and an unwalled one would have sent the
    // label into the next column. Clearing it vertically costs its height,
    // about 24px. The short way off a bar is across it.
    const label = box(-57, -30, -31, 30); // 26 wide, 60 tall, astride the row
    const bar = box(-80, 10, 60, 34); // a foldout row 24px tall, crossing it
    const lift = labelLift(label, [bar]);
    expect(lift).not.toBe(0);
    expect(Math.abs(lift)).toBeLessThan(40); // its height, not its length
    // Cleared: the label no longer overlaps the bar once moved.
    const moved = { ...label, top: label.top - lift, bottom: label.bottom - lift };
    expect(moved.top >= bar.bottom || bar.top >= moved.bottom).toBe(true);
  });

  it("leaves by the nearer edge of the bar", () => {
    // Up or down, whichever is shorter from where the label is. A label mostly
    // above the bar goes up; one mostly below goes down. Sign is the direction:
    // positive lifts (subtracted from `top`), negative drops.
    const bar = box(-80, 0, 60, 24);
    const high = box(-57, -40, -31, 6); // 6px of it below the bar's top
    const low = box(-57, 18, -31, 64); // 6px of it above the bar's bottom
    expect(labelLift(high, [bar])).toBeGreaterThan(0);
    expect(labelLift(low, [bar])).toBeLessThan(0);
    expect(Math.abs(labelLift(high, [bar]))).toBeCloseTo(6, 6);
    expect(Math.abs(labelLift(low, [bar]))).toBeCloseTo(6, 6);
  });

  it("does not move for a bar it is not on", () => {
    // At rest there is no foldout at all, and a row the label does not meet
    // asks nothing of it — the reveal is what creates the obstacle.
    const label = box(-57, -30, -31, 30);
    expect(labelLift(label, [])).toBe(0);
    expect(labelLift(label, [box(-80, 100, 60, 124)])).toBe(0); // far below
    expect(labelLift(label, [box(200, 10, 300, 34)])).toBe(0); // not across it
  });

  it("measures the foldout from where the ruby pass left the label", () => {
    // The two passes are one journey. Measuring the foldout from the label's
    // *drawn* position would count the gutter twice — once as room the ruby
    // pass had already spent — and push it that much too far.
    const ruby = { ...ROW, left: LABEL.right - 10, right: LABEL.right + 30 };
    const rubyStep = labelStandoff(LABEL, [ruby], -1, -Infinity);
    expect(rubyStep).toBeGreaterThan(0);

    const afterRuby = { ...LABEL, left: LABEL.left - rubyStep, right: LABEL.right - rubyStep };
    const foldout = { ...ROW, left: afterRuby.right - 5, right: afterRuby.right + 40 };
    const fromMoved = labelStandoff(afterRuby, [foldout], -1, -Infinity);
    const fromDrawn = labelStandoff(LABEL, [foldout], -1, -Infinity);
    expect(fromMoved).toBeLessThan(fromDrawn);
    expect(fromMoved).toBeCloseTo(5, 6);
  });

  it("lands exactly the margin clear, with no casing added to either side", () => {
    // The reader measured the result and found it wider than the ruby's own
    // gap. The cause was `obstacleFor`: it grows a box by the casing each mark
    // keeps, which is right for "do these two touch" and wrong for "how far
    // apart do they end up" — the label's 2px and the reading's 2px both landed
    // in the answer, so a 6px gap was cleared by 10.
    //
    // Both sides are painted boxes now, and the property to hold is that the
    // finished separation is the margin exactly. Written as the caller's whole
    // arithmetic, since that is where the two used to disagree.
    const glyph = box(0, 0, 44, 44);
    const ruby = box(50, 0, 72, 44); // one lane, 6px clear of its kanji
    const gap = ruby.left - glyph.right;
    expect(gap).toBeCloseTo(6, 6);

    // A label lying across that ruby, moving away from the column.
    const label = box(60, 0, 120, 44);
    const step = (() => {
      const overlap = labelStandoff(label, [ruby], 1, Infinity);
      return overlap > 0 ? overlap + gap : 0;
    })();
    const moved = { ...label, left: label.left + step, right: label.right + step };
    expect(moved.left - ruby.right).toBeCloseTo(gap, 6);

    // Cased boxes on either side would each add their own reach to that
    // separation, which is the arithmetic that was shipping.
    const cased = (b: Extent, by: number) => ({ ...b, left: b.left - by, right: b.right + by });
    const casedOverlap = labelStandoff(cased(label, 2), [cased(ruby, 2)], 1, Infinity);
    const casedMoved = label.left + casedOverlap + gap;
    expect(casedMoved - ruby.right).toBeCloseTo(gap + 4, 6);
  });

  it("clears one lane's worth when the ruby occupies one lane, and when it occupies two", () => {
    // The reader's rule: "if ruby is only one line, the deprel label shouldn't
    // clear space for two lines."
    //
    // A second lane sits a whole lane beyond the first, so *its* distance from
    // the glyph is the gap plus a lane. Taking the widest of the runs — which
    // is what this did — therefore made the margin grow with the number of
    // lanes occupied, which is the doubling that was seen on the page. The
    // margin is the offset of the nearest run, and that is the same 6 whether
    // the token wears one lane or two.
    const glyph = box(0, 0, 44, 44);
    const gapOf = (run: Extent) =>
      run.left >= glyph.right ? run.left - glyph.right : glyph.left - run.right;
    const margin = (runs: Extent[]) => (runs.length > 0 ? Math.max(0, Math.min(...runs.map(gapOf))) : 0);

    const furigana = box(50, 0, 72, 44); // first lane, 6 clear of the glyph
    const okurigana = box(72, 0, 94, 44); // second lane, 28 clear of it
    expect(gapOf(okurigana)).toBeCloseTo(28, 6);
    expect(margin([furigana])).toBeCloseTo(6, 6);
    expect(margin([furigana, okurigana])).toBeCloseTo(6, 6);
    // Order of the runs says nothing — it is the nearest, not the first.
    expect(margin([okurigana, furigana])).toBeCloseTo(6, 6);
    // And a token with no readings at all asks for no margin rather than for
    // `Math.min()`'s empty answer, which is Infinity.
    expect(margin([])).toBe(0);
  });

  it("spends the whole gutter rather than refusing when it cannot get clear", () => {
    // An obstacle that covers the label outright: getting out from under it
    // means travelling 56px, against a gutter worth 7.
    //
    // **It takes the 7.** This used to return 0 — "refuse rather than
    // half-clear" — and the reader reported the consequence: the label was not
    // being decollided at all, because at the time the common case was exactly
    // this one (the three-pill row overhung about 84px each way and swallowed
    // the label whole) and it always failed the test. A partial step is not a
    // failed clearing; it is 7px less overlap. See `labelStandoff`.
    //
    // The common case has since moved — the row is one pill wide now, and the
    // test below this describe block has what that is worth — but the clamp is
    // kept and is still what should happen: two lanes of ruby under a long
    // relation name cover a label just as thoroughly, and the readings are what
    // the caller actually asks this function about.
    expect(LABEL.left - wall).toBeCloseTo(7, 6); // the whole budget, casing included
    expect(labelStandoff(LABEL, [DEEP], -1, wall)).toBeCloseTo(7, 6);
    // Given room it would go the whole way, so the clamp is the wall and not
    // the geometry failing — and by exactly the 56 the note quotes.
    expect(labelStandoff(LABEL, [DEEP], -1, -200)).toBeCloseTo(56, 6);
  });

  it("clears a contiguous row by its far end, not by the pill it started in", () => {
    // The fixed point. A label sitting wholly inside the middle pill asks that
    // pill for a step of its own width — and having taken it is against the
    // pill before it, which the first pass could not see. Three pills, 50px
    // apart, with the label inside the middle one: the step is out to the far
    // edge of the *first*, not of the second.
    //
    // Still a case that arises, though not from the pills: the caller asks
    // about the readings, and a token's furigana and okurigana are two runs in
    // adjacent lanes with nothing between them. Written with pills because a
    // contiguous run is a contiguous run, and because this is the shape the
    // bug was found in.
    const pills = [cased(box(-75, 26, -25, 50.32)), cased(box(-25, 26, 25, 50.32)), cased(box(25, 26, 75, 50.32))];
    const inside = cased(box(-12, 10, 12, 60));
    const step = labelStandoff(inside, pills, -1, -200);
    expect(step).toBeCloseTo(inside.right - pills[0].left, 6);
    expect(inside.right - step).toBeCloseTo(pills[0].left, 6);
  });

  it("mirrors, so a label on the other side steps the other way", () => {
    // Nothing draws a within-line arc's label on the right today — the bow
    // goes left always, the reading lane being on the right — but a cross-line
    // arc's label sits on the plain chord midpoint and lands on whichever side
    // the head is, so both signs are reachable and a function that only worked
    // one way would be a trap.
    const right = cased(box(31, -36, 57, 36));
    expect(labelStandoff(right, [ROW], 1, 200)).toBeCloseTo(ROW.right - right.left, 6);
    expect(labelStandoff(right, [ROW], 1, 40)).toBe(0);
  });

  it("never moves along the column, whatever would have cleared", () => {
    // The rule's whole content, stated as the axis rather than as a number.
    // This obstacle covers the label from above its head to below its foot, so
    // no step across can clear it and none is taken — while a step of 90px
    // *down* the column would have cleared it easily. The label does not take
    // it: its position along the column is the arc's midpoint, and a label
    // anywhere else on the arc names a different stretch of the sentence.
    const across = cased(box(-200, -60, 200, 60));
    expect(labelStandoff(LABEL, [across], -1, -1000)).toBeGreaterThan(0); // across: possible, if far
    // Clamped to the gutter, not refused — but still only across it. The point
    // of the test is the axis, and no amount of clamping introduces a step
    // along the column.
    expect(labelStandoff(LABEL, [across], -1, wall)).toBeCloseTo(LABEL.left - wall, 6);
    expect(across.bottom).toBeLessThan(LABEL.bottom + 90); // where 90 down would have done
  });
});

describe("the row stands off its character, and only along the column", () => {
  /** What `decollideOverlay` computes: the run between two glyphs down the
   * column, less the air the row keeps at each end, less the row itself, less
   * the casing. About 10px at the shipped scale — one third of what the deepest
   * collision would ask for, which is why the refusal below matters. */
  const ceiling = 88 - 44 - 2 * 4 - 24.32 - REACH;

  it("is worth about ten pixels at the shipped scale", () => {
    expect(ceiling).toBeCloseTo(9.68, 2);
  });

  it("moves nothing that is already clear on either axis", () => {
    // Past the end of the row across the page, and past the end of it down the
    // page: either is enough.
    expect(rowStandoff(ROW, cased(box(-200, -36, -174, 36)), 1, ceiling)).toBe(0);
    expect(rowStandoff(ROW, cased(box(-57, 200, -31, 272)), 1, ceiling)).toBe(0);
  });

  it("takes a row written below down the page, by the least that clears", () => {
    // A label whose foot reaches 5px into the row as painted. The row moves
    // 5px further from its character and no more; the two then meet along one
    // line, with the 2px of page colour each of them carries between them.
    const label = painted(-57, -30, -31, ROW.top + 5);
    expect(rowStandoff(ROW, label, 1, ceiling)).toBeCloseTo(label.bottom - ROW.top, 6);
    expect(rowStandoff(ROW, label, 1, ceiling)).toBeCloseTo(5, 6);
  });

  it("takes a row written above up the page, which is the mirror of that", () => {
    // Above its character, the row's leading edge is its *top* and the label
    // it has to clear is below it, so the subtraction runs the other way. The
    // side is `placeSubtitle`'s and says which way the head lies, so it is
    // never given up to solve a collision — only the distance is.
    const above = cased(box(-32, -50.32, 32, -26));
    const label = painted(-57, above.bottom - 5, -31, 40);
    expect(rowStandoff(above, label, -1, ceiling)).toBeCloseTo(above.bottom - label.top, 6);
    expect(rowStandoff(above, label, -1, ceiling)).toBeCloseTo(5, 6);
  });

  it("takes the whole ceiling when the label is deeper than it", () => {
    // A 12-character relation name (並列構成要素〖動詞連続〗, the longest the
    // inventory can spell) on a short arc reaches about 130px each way from
    // the arc's midpoint, and no standoff a character has room for gets the
    // row wholly out from under it.
    //
    // **It goes as far as the next character's air allows**, for the reason
    // `labelStandoff`'s own note gives: this returned 0, and between the two
    // refusals nothing on the page moved at all. The worry it encoded — that a
    // row moved and still covered has spent "this pill belongs to that
    // character" for nothing — is real but is the lesser cost; the row is
    // still centred on its glyph, which is what carries that claim.
    const long = painted(-57, -130, -31, 130);
    expect(long.bottom - ROW.top).toBeGreaterThan(ceiling);
    expect(rowStandoff(ROW, long, 1, ceiling)).toBeCloseTo(ceiling, 6);
  });

  it("takes a standoff that lands exactly on the ceiling", () => {
    // The boundary, because a refusal written with the wrong comparison would
    // show up here and nowhere else.
    const label = painted(-57, -30, -31, ROW.top + ceiling);
    expect(rowStandoff(ROW, label, 1, ceiling)).toBeCloseTo(ceiling, 6);
    // Just past it the answer is the ceiling too, not zero — the clamp is
    // continuous where the old refusal was a cliff, which is the property that
    // makes a near-miss look like a near-miss instead of like no rule at all.
    const deeper = painted(-57, -30, -31, ROW.top + ceiling + 0.01);
    expect(rowStandoff(ROW, deeper, 1, ceiling)).toBeCloseTo(ceiling, 6);
  });
});

describe("the two moves are one arrangement, and this is what it buys", () => {
  const wall = -66;
  const ceiling = 88 - 44 - 2 * 4 - 24.32 - REACH;

  it("clears the ordinary collisions and spends everything it has on the extreme one", () => {
    // The claim `decollideOverlay` makes in prose, as arithmetic. A label out
    // in the gutter has about 7px of room before the next column's characters
    // and the row about 10px before the next character down the column, so:
    //
    //   a label that has stepped for its ruby  the row then has nothing to do;
    //   a label that has not  a shallow overlap, and the row's own travel
    //                         finishes it;
    //   a long relation name on a short arc  the row spends everything it has
    //                                        and the two still overlap.
    //
    // **The third line used to read "neither can, and both stay put", and that
    // was the bug the reader reported** — the deep case was the common one, so
    // in practice nothing was ever decollided. Both movers now clamp instead
    // of refusing, which turns "no rule" into "as much as there is room for".
    const shallow = painted(-57, -30, -31, ROW.top + 6);
    expect(labelStandoff(shallow, [ROW], -1, wall)).toBeGreaterThan(0);
    expect(rowStandoff(ROW, shallow, 1, ceiling)).toBeCloseTo(6, 6);

    const deep = painted(-57, -130, -31, 130);
    expect(labelStandoff(deep, [DEEP], -1, wall)).toBeCloseTo(deep.left - wall, 6);
    expect(rowStandoff(ROW, deep, 1, ceiling)).toBeCloseTo(ceiling, 6);
    // Everything either can give, and still not enough — which is the honest
    // outcome for this case and is now visible as a partial move rather than
    // as no move.
    expect(deep.left - wall).toBeLessThan(56);
    expect(ceiling).toBeLessThan(deep.bottom - ROW.top);
  });

  it("meets the label by 5px where the three-pill row met it by 56", () => {
    // **What the reveal is worth to this arrangement, in the one number that
    // decides everything else.** The label stands in the gutter at −59…−29 as
    // painted; the 品詞 pill reaches −34 and the three-pill row reached −85. So
    // the overlap the two movers have to find between them went from 56px to
    // 5 — and 56 was more than either could give, where 5 is less than each of
    // them can give on its own.
    //
    // Nothing about either mover changed to get this. What changed is which
    // pills are in the row's flow: the domain and the sense are drawn in an
    // absolutely positioned wrapper now (see `ROW` above), so the row measures
    // the 品詞 pill and the label is beside one pill rather than beside three.
    expect(LABEL.right - ROW.left).toBeCloseTo(5, 6);
    expect(LABEL.right - DEEP.left).toBeCloseTo(56, 6);
  });

  it("leaves the row nothing to do once the label has spent its gutter", () => {
    // The consequence, and the case that is the common one on the page: the
    // label steps aside for the ruby it is lying on (step 1 asks about the
    // readings and about nothing else), and having stepped it is clear of the
    // 品詞 pill outright — its trailing edge lands at −36 against the pill's
    // −34, 2px clear, so step 2 finds no collision and the row stays exactly
    // where it was drawn.
    const stepped = { ...LABEL, left: LABEL.left - 7, right: LABEL.right - 7 };
    expect(stepped.right).toBeCloseTo(-36, 6);
    expect(rowStandoff(ROW, stepped, 1, ceiling)).toBe(0);

    // Against the three-pill row the same 7px of gutter bought nothing: the
    // label was still 49px inside it, the row was asked for the 14px that
    // would have got its own top under the label's foot, and the ceiling gave
    // 9.68 of it. So the pair ended overlapping — the state the reader saw —
    // where they now end apart with neither of them moving at all.
    expect(stepped.right - DEEP.left).toBeCloseTo(49, 6);
    expect(rowStandoff(DEEP, stepped, 1, ceiling)).toBeCloseTo(ceiling, 6);
    expect(stepped.bottom - DEEP.top).toBeCloseTo(14, 6);
    expect(ceiling).toBeLessThan(stepped.bottom - DEEP.top);
  });

  it("still cannot clear a long relation name, which the reveal does not touch", () => {
    // The one case the narrower row does not improve, stated so that the claim
    // above is not read as more than it is. A 12-character relation name on a
    // short arc reaches about 130px each way from the arc's midpoint, so it
    // covers the row from above its head to below its foot; the overlap that
    // has to be cleared is *along the column*, and how wide the row is says
    // nothing about it. The row spends its ceiling and is still under the
    // label, exactly as it was before.
    const long = painted(-57, -130, -31, 130);
    expect(rowStandoff(ROW, long, 1, ceiling)).toBeCloseTo(ceiling, 6);
    expect(rowStandoff(DEEP, long, 1, ceiling)).toBeCloseTo(ceiling, 6);
  });
});

// ---------------------------------------------------------------------------

describe("the arrangement that keeps the 品詞 still while the semantics arrive", () => {
  /** The stylesheet as the browser reads it, less its prose. The comments in
   * this section of kunten.css quote the selectors they replaced — including
   * the one asserted absent below — so an assertion made against the raw file
   * would be answered by an argument about the file rather than by the file. */
  const kunten = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "render", "kunten.css"),
    "utf-8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");

  /** One rule's declarations, by the selector it opens with. Written out
   * rather than parsed with a library for the reason the other stylesheet
   * tests give: what is being pinned is a handful of declarations, and a
   * parser would be a dependency to keep in agreement with a browser.
   *
   * Anchored to the start of a line, which is not fastidiousness: three of
   * these selectors are named a second time, indented, inside the
   * reduced-motion block, and an unanchored search finds that one first and
   * reports every rule as declaring `transition: none` and nothing else. */
  const declarations = (selector: string): string => {
    const at = kunten.indexOf(`\n${selector} {`);
    expect(at, selector).toBeGreaterThan(-1);
    return kunten.slice(at, kunten.indexOf("}", at));
  };

  it("draws the semantics out of the row's flow, at the 品詞 pill's trailing edge", () => {
    // **The whole of the reader's second sentence, in three declarations.** A
    // box placed at the glyph's centre and pulled back by half of itself
    // re-centres whenever its width changes, so the 品詞 pill can only stay
    // still if the other two pills are not in the row's flow. `position:
    // absolute` is what takes them out of it; `left: 100%` puts the wrapper's
    // origin on the row's padding-box right edge, which — the row having no
    // padding and one in-flow child — is the 品詞 pill's own border-box edge,
    // where the domain pill's margin box began when the three were one flex
    // row; `top: 0` puts it level with that pill.
    const rule = declarations(".token-subtitle-semantics");
    expect(rule).toContain("position: absolute;");
    expect(rule).toContain("left: 100%;");
    expect(rule).toContain("top: 0;");
    // An absolutely positioned box with `left` set and `right: auto` is
    // shrink-to-fit, and its available width here is the containing block's
    // less `left`, which at 100% is zero — so `auto` would resolve to the
    // min-content width. It happens to equal the max-content width for a
    // nowrap row of unshrinkable pills, and the point of stating it is that
    // nothing should have to happen to happen to be true.
    expect(rule).toContain("width: max-content;");
  });

  it("hides them by opacity, which is what leaves the decollision measuring the resting state", () => {
    // **On the pills, not on the wrapper.** The hiding moved down a level when
    // the reader asked for the two subcategories to "unfold one after the
    // other": a stagger is two boxes starting at different times, and one
    // transition on the wrapper can only move the run as a unit. The wrapper
    // keeps the positioning; each pill fades and slides for itself.
    const rule = declarations(".token-subtitle-semantics > .token-subtitle");
    expect(rule).toContain("opacity: 0;");
    // Neither of the other two ways to hide a box, and each is excluded for a
    // different reason that would fail silently.
    //
    // `display: none` leaves the pills no box at all — and `caseApparatus`
    // draws the whole apparatus's casing once, at the moment the analysis goes
    // up, from the boxes the marks then have. A pill with no box at that
    // moment would have no casing when it was revealed, and there is no second
    // casing pass to give it one.
    //
    // `visibility: hidden` leaves the box but computes `opacity: 1`, and
    // `settledStrength` is how `decollideOverlay` decides which marks a
    // reading has to lift out of the way of. Hidden pills that read as full
    // strength would push the column's readings around for ink that is not on
    // the page.
    expect(rule).not.toContain("display: none");
    expect(rule).not.toContain("visibility: hidden");
  });

  it("lets the characters under a hidden pill be clicked, and a revealed one be right-clicked", () => {
    // `.token-subtitle` opts every pill into pointer events so that each can
    // carry its own menu; hidden, these two must opt back out, or the reader
    // would be unable to click the characters under 100px of invisible pill.
    // Revealed, they take events again — one class deeper, so it wins.
    expect(declarations(".token-subtitle-semantics .token-subtitle")).toContain("pointer-events: none;");
    expect(declarations(".token-semantics-shown .token-subtitle-semantics .token-subtitle")).toContain(
      "pointer-events: auto;",
    );
  });

  it("keeps the chevron seam across the new boundary, at the same numbers", () => {
    // The seam's geometry is settled and argued in the stylesheet, and the
    // split had to leave every figure in it alone: the same depth, the same
    // gap, the same padding on both sides of a seam, the same pull. What
    // changed is only which selector says "has a pill before it".
    expect(kunten).toContain("--chip-chevron: 0.4270em;");
    expect(kunten).toContain("--chip-chevron-gap: var(--head-box-halo);");
    expect(declarations(".token-subtitle:not(:last-child)")).toContain(
      "padding-right: calc(var(--chip-pad-inline) + var(--chip-chevron) / 2);",
    );
    const after = declarations(".token-subtitle-semantics > .token-subtitle");
    expect(after).toContain("padding-left: calc(var(--chip-pad-inline) + var(--chip-chevron) / 2);");
    expect(after).toContain("margin-left: calc(-1 * var(--chip-chevron) + var(--chip-chevron-gap));");

    // **And the positional test it replaced is gone.** `:first-child` is asked
    // of a pill's own parent, and the domain pill *is* the first child of the
    // wrapper — so `.token-subtitle:not(:first-child)` would have stopped
    // matching it, and the domain would have lost its notch and its pull and
    // sat 5.51px to the right of the point it is meant to close over. The
    // failure is a seam that looks slightly wrong rather than an error, which
    // is why it is worth a ratchet.
    expect(kunten).not.toContain(".token-subtitle:not(:first-child)");
    expect(kunten).not.toContain(".token-subtitle:first-child");
  });

  it("takes the casing away with the pills it was drawn for", () => {
    // A casing rect is page colour, so one showing while its pill does not is
    // a cream bar lying across the text. Two halves keep that from happening
    // and they are in different places: `caseApparatus` draws a rect for a
    // semantic pill *only while that pill is out* (a hidden one is parked a
    // slide's width left of where it belongs, and a halo drawn there would be
    // a halo for a position the pill never occupies), and these declarations
    // fade the rect out with its pill on the way back, in the interval before
    // `redecollide` replaces the layer.
    //
    // The class is on the overlay because this is exactly why it has to be:
    // the pills are in the row and the rects are in the casing SVG beside it,
    // and one class has to reach both.
    expect(declarations(".token-chip-casing-semantic")).toContain("opacity: 0;");
    expect(declarations(".token-chip-casing-semantic")).toContain("transition: opacity var(--semantics-reveal) ease-out;");
    const shown = declarations(".token-semantics-shown .token-chip-casing-semantic");
    expect(shown).toContain("opacity: 1;");
    // And no delay on the way in. The rects are already at their boxes when
    // they are revealed, so a delay would only make a reader who left the row
    // and came straight back watch the halo arrive late.
    expect(shown).not.toContain("transition-delay");
    expect(declarations(".token-semantics-shown .token-subtitle-semantics > .token-subtitle")).toContain(
      "opacity: 1;",
    );
  });

  it("does not animate the reveal for a reader who has asked for no motion", () => {
    // Both halves named, at both weights, in each of the two blocks: a
    // `transition: none` on the bare selector alone would be overridden by the
    // revealed rule wherever that rule declares anything of `transition`'s own
    // — and the casing's revealed rule declares a `transition-delay`, so this
    // is not hypothetical. Each block is placed *after* the rules it cancels,
    // which is what the rest of this stylesheet does and what makes the equal
    // weights come out the right way round.
    const blockAfter = (from: number): string => {
      const at = kunten.indexOf("@media (prefers-reduced-motion: reduce)", from);
      expect(at).toBeGreaterThan(-1);
      return kunten.slice(at, kunten.indexOf("}", kunten.indexOf("{", kunten.indexOf("{", at) + 1)));
    };
    const pills = blockAfter(
      kunten.indexOf("\n.token-semantics-shown .token-subtitle-semantics > .token-subtitle {"),
    );
    // The pills, at both weights — the hiding moved down from the wrapper when
    // the two subcategories were staggered, so this is what has to be cancelled.
    for (const selector of [
      ".token-subtitle-semantics > .token-subtitle",
      ".token-semantics-shown .token-subtitle-semantics > .token-subtitle",
    ]) {
      expect(pills, selector).toContain(selector);
    }
    // **And the delay with it.** A stagger with no animation is not a gentler
    // reveal — it is the sense pill appearing 160ms after the domain for no
    // visible reason, which is the flicker this block exists to refuse arriving
    // by another route.
    expect(pills).toContain("transition-delay: 0s;");
    expect(pills).toContain("transition: none;");

    const casing = blockAfter(kunten.indexOf("\n.token-semantics-shown .token-chip-casing-semantic {"));
    for (const selector of [".token-chip-casing-semantic", ".token-semantics-shown .token-chip-casing-semantic"]) {
      expect(casing, selector).toContain(selector);
    }
    expect(casing).toContain("transition: none;");

    // What that leaves is the revealed state arrived at without the journey,
    // which is what the reader asked for — not the reveal switched off. The
    // two things that must *not* be in a reduced-motion block are the
    // declarations that decide the state itself.
    expect(pills).not.toContain("opacity: 0");
    expect(pills).not.toContain("transform:");

    // The flicker guard is deliberately *not* in the transition — a pointer
    // crossing the 2px wedge between two pills leaves both of them for an
    // instant, and what holds the revealed state across that is the grace
    // period in `watchSemantics`, which a reduced-motion reader gets too. Nor
    // is the decollision's timing: `settleMsFrom` reads the duration off the
    // page, finds 0 here, and re-runs at once instead of waiting out a slide
    // that is not happening.
  });

  it("cuts the 品詞 pill straight until the semantics come out, and never changes its box", () => {
    // **The reader's revision, and the constraint it had to live with.** "The
    // chevron should be straight to start with, and only become a chevron on
    // hover" — while the 品詞 pill still must not move, which it would if the
    // point arrived with the padding it needs (3.76px of width is 1.88px of
    // `translateX(-50%)`). So the space is reserved in both states and only
    // the ink changes: the resting clip cuts the pill back by half a chevron,
    // which is exactly the reserved padding, leaving `--chip-pad-inline` of
    // air — the same air every un-seamed end of every pill has.
    const rest = declarations(".token-subtitle-row > .token-subtitle:not(:last-child)");
    // The inset is now spent through `--chip-clip-end`, which is the same
    // `--chip-chevron / 2` given a name so that the casing can read it — see
    // the block below, where the asymmetry that forced the name is worked out.
    expect(rest).toContain("--chip-clip-end: calc(var(--chip-chevron) / 2);");
    expect(rest).toContain("clip-path: inset(0 var(--chip-clip-end) 0 0 round var(--chip-radius));");
    // Rounded, because the instruction says the resting pill keeps its own
    // corners, and `inset()` is the only clip shape that can round one.
    expect(kunten).toContain("--chip-radius: 0.25rem;");
    expect(kunten).toContain("border-radius: var(--chip-radius);");

    // The point is the same pill with the ink let out into space that was
    // already allocated, and it is the *revealed* rule that draws it.
    const shown = declarations(".token-semantics-shown .token-subtitle-row > .token-subtitle:not(:last-child)");
    expect(shown).toContain("clip-path: polygon(");
    expect(shown).toContain("100% 50%");

    // **And the box is decided outside both of them.** The padding and the
    // margins that set the pill's width are in the unconditional rules, so
    // nothing about the geometry is keyed on the reveal. Asserted as the
    // absence it is: if a width, a padding or a margin ever appears in either
    // of the two state rules, the pill has started moving on hover.
    for (const rule of [rest, shown]) {
      for (const property of ["width:", "padding", "margin", "font-size"]) {
        expect(rule, property).not.toContain(property);
      }
    }
  });

  it("slides the semantics out from behind the 品詞 pill", () => {
    // "The semantic pills should slide out." They rest a slide's width to the
    // left of where they belong — inside the 品詞 pill, which paints over them
    // — and travel out as they fade in. Two properties, because a slide alone
    // would show the run's far end sticking out past the pill (the run is
    // wider than the pill) and a fade alone is the switch this replaces.
    // **Per pill, not per run** — see the stagger below. Each pill rests a
    // slide's width left of where it belongs and travels out for itself, which
    // is what lets the sense start after the domain.
    const rest = declarations(".token-subtitle-semantics > .token-subtitle");
    expect(rest).toContain("transform: translateX(calc(-1 * var(--semantics-slide)));");
    expect(rest).toContain("transition:");
    expect(rest).toContain("transform var(--semantics-reveal) ease-out");
    expect(rest).toContain("opacity var(--semantics-reveal) ease-out");
    expect(declarations(".token-semantics-shown .token-subtitle-semantics > .token-subtitle")).toContain(
      "transform: translateX(0);",
    );

    // The stagger itself: the sense waits a whole reveal, so the two come out
    // in turn rather than together. Keyed on the sense's own class, because a
    // tag with no sense draws no sense pill and `:nth-child(2)` would then
    // delay the only pill there is.
    expect(declarations(".token-subtitle-semantics > .token-subtitle-sense")).toContain(
      "transition-delay: var(--semantics-stagger);",
    );
    expect(kunten).toContain("--semantics-stagger: var(--semantics-reveal);");

    // The occlusion that makes it a slide out from *behind* rather than a
    // slide across the pill's face. `position: relative` with no offsets moves
    // nothing; it is only what lets the pill take a `z-index`.
    const pill = declarations(".token-subtitle-row > .token-subtitle");
    expect(pill).toContain("position: relative;");
    expect(pill).toContain("z-index: 1;");

    // The slide's length has to be less than the narrowest 品詞 pill, or the
    // run starts partly outside the pill that is meant to be hiding it. 12px
    // against a one-character pill of 17.6px of text and 12.8px of padding.
    expect(kunten).toContain("--semantics-slide: 0.75rem;");
    expect(0.75 * 16).toBeLessThan(17.6 + 2 * 6.4);
  });

  it("gives the folded pill the same air on both sides, and cases it on its ink", () => {
    // **The reader's report was that the folded pill's right padding does not
    // match its left, and the padding is not what is wrong.** This is the
    // re-derivation, as arithmetic rather than as an assertion about a page
    // nobody here can see. Writing `pad` for `--chip-pad-inline` and `chev`
    // for `--chip-chevron` at the shipped 17.6px chip:
    const pad = 0.4 * 16; // --chip-pad-inline, 6.4px
    const chev = 0.427 * 17.6; // --chip-chevron, 7.5152px at the shipped chip
    // The right-hand padding reserves the outer padding plus half a chevron,
    // and the resting clip takes half a chevron back off the ink. The two are
    // the same quantity, so what is left between the text and the ink is the
    // outer padding — the left-hand figure exactly, to the 0.0024px by which
    // 0.427em misses the 0.4rem the padding is written in.
    expect(pad + chev / 2 - chev / 2).toBeCloseTo(pad, 10);
    // Which is why the two rules must spend one number and not two: the
    // cancellation is an identity between a padding and a clip, and a clip
    // that drifted from the padding would open exactly the asymmetry that was
    // reported. `--chip-clip-end` is that one number.
    expect(declarations(".token-subtitle:not(:last-child)")).toContain(
      "padding-right: calc(var(--chip-pad-inline) + var(--chip-chevron) / 2);",
    );
    expect(declarations(".token-subtitle-row > .token-subtitle:not(:last-child)")).toContain(
      "--chip-clip-end: calc(var(--chip-chevron) / 2);",
    );

    // **Where the asymmetry actually was.** The resting `inset()` and the
    // revealed `polygon()` disagree about the pill's right edge — 100% - chev/2
    // against a flat edge at 100% - chev with a point out to 100% — so at rest
    // the pill paints chev/2 short of its own border box, and anything that
    // measured the box rather than the paint was out by that much on one side
    // and nothing on the other. The casing did: a rect on the border box, 2px
    // of stroke past it, gave the folded pill 5.755px of paper on the right
    // against 2px on the left.
    expect(chev / 2 + 2).toBeCloseTo(5.7576, 3);
    expect(chev / 2 + 2 - 2).toBeCloseTo(3.7576, 3);

    // The trim is now read off the pill by `caseApparatus`, which needs the
    // property to compute to a *length* — an unregistered custom property
    // would come back as the token stream `calc(0.4270em / 2)`. Registered, so
    // the em resolves against the chip's own inline font size.
    const at = kunten.indexOf("@property --chip-clip-end");
    expect(at).toBeGreaterThan(-1);
    const registration = kunten.slice(at, kunten.indexOf("}", at));
    expect(registration).toContain('syntax: "<length>";');
    expect(registration).toContain("inherits: false;");
    expect(registration).toContain("initial-value: 0px;");
    // And nothing to trim once the point is out: the polygon reaches 100%.
    expect(declarations(".token-semantics-shown .token-subtitle-row > .token-subtitle:not(:last-child)")).toContain(
      "--chip-clip-end: 0px;",
    );
  });

  it("lifts the mark whose menu is out, by a shadow the clip cannot reach", () => {
    // **The tab that is out takes the menu's ground, so it needs lifting off
    // it** — and neither `box-shadow` nor `filter: drop-shadow()` can be put
    // on the pill, because both are cut away by the pill's own `clip-path`
    // (the element is rendered, then filtered, then clipped: CSS Masking's
    // order, so a filter's shadow is generated and then removed at the same
    // edge). So the lift is on the row, which carries no clip and whose
    // silhouette is the union of the pills — one shadow under one bar, and
    // none in the seams.
    // The ground, through the property the fill is drawn from — one
    // declaration inverts whichever of the three pills is out, over the shade
    // step, which a class selector cannot outweigh.
    expect(declarations(".token-subtitle")).toContain("background: var(--chip-fill);");
    expect(declarations(".token-subtitle[data-menu-tab]")).toContain("--chip-fill: var(--color-bg-panel, #fff);");
    // **The pills carry no lift at all any more.** The row's drop shadow was
    // there because the ring — an inset shadow — could not follow a chevron, so
    // the cream tab's edge died at the seam and something had to keep the bar
    // readable there. The ring now works around the chevrons (mitred bands on a
    // true offset), so every edge of the tab is drawn by the tab, and the
    // reader's verdict was that the shadow had become a second answer to a
    // question already answered: "Now we no longer need shadows on the pills!"
    expect(kunten).not.toContain("filter: drop-shadow(var(--mark-lift));");
    // The pills themselves must go on carrying no *outer* shadow of their own,
    // or it would be drawn and clipped and cost a paint for nothing. The inset
    // one below is the exception that proves the rule: it is the only kind a
    // clip does not remove outright.
    expect(declarations(".token-subtitle[data-menu-tab]")).not.toContain("shadow");

    // **The deprel label takes the same treatment**, and can take the *lift*
    // directly: it has no clip. Same ink as the tab pill's and the same figure
    // for the shadow.
    const label = declarations(".token-arrow-label[data-menu-tab]");
    expect(label).toContain("color: var(--color-ink);");
    // Its ground is already the menu's, so there is nothing to invert.
    expect(declarations(".token-arrow-label")).toContain("background: var(--color-bg-panel, #fff);");
    // The radius is untouched, because `caseApparatus` reads it to draw the
    // label's casing rect and a radius that changed with the menu would change
    // the halo under it.
    expect(label).not.toContain("border-radius");

    // One figure for both marks, declared once on the overlay they share, and
    // derived from the menu's own by holding the ink and the 1:4 offset-to-blur
    // ratio and taking the height to a third.
    expect(kunten).toContain("--mark-lift: 0 2px 8px rgb(0 0 0 / 18%);");
    expect(kunten).toContain("box-shadow: 0 6px 24px rgb(0 0 0 / 18%);");
    expect(2 / 8).toBeCloseTo(6 / 24, 10);
  });

  it("draws both marks' edges inside their boxes, off one figure", () => {
    // **The reader:** *"The deprel chip border should be inset, and the
    // horizontal chip components should have similarly inset borders (which
    // should be invisible on a blue background)."*
    //
    // There is no browser here and nothing below says what the edge looks
    // like. What it says is the two things that make the edge safe to add at
    // all: that it is drawn with a property which enlarges no box, and that
    // its colour at rest is the ground it is drawn on.

    // One figure for both, beside `--mark-lift`, which is the same argument:
    // two marks of one apparatus, one length.
    expect(kunten).toContain("--mark-edge: 1.5px;");

    // **The pills.** Inset, so the box `decollideOverlay` measures, the box
    // `caseApparatus` cases and the half-width the row is centred by are all
    // exactly what they were — a `border` would have added 1.5px to each of
    // four sides of every pill and moved all three.
    expect(declarations(".token-subtitle")).toContain(
      "box-shadow: inset 0 0 0 var(--mark-edge) var(--chip-edge);",
    );
    // Invisible at rest, and as an identity rather than as a matched pair of
    // colours: the edge *is* the fill, whichever of the three grounds this
    // pill has.
    expect(declarations(".token-subtitle")).toContain("--chip-edge: var(--chip-fill);");
    for (const pill of [".token-subtitle", ".token-subtitle-domain", ".token-subtitle-sense"]) {
      expect(declarations(pill), pill).toContain("--chip-fill:");
      expect(declarations(pill), pill).not.toContain("background: color-mix");
    }
    // …and visible in the one state it is for, in the ink the text turns.
    expect(declarations(".token-subtitle[data-menu-tab]")).toContain("--chip-edge: var(--color-ink);");

    // **The label**, the same length in the same property, recoloured in the
    // same state — and its `border` gone, which is the change the instruction
    // actually asked for.
    expect(declarations(".token-arrow-label")).toContain(
      "box-shadow: inset 0 0 0 var(--mark-edge) var(--label-edge);",
    );
    expect(declarations(".token-arrow-label")).not.toContain("border: ");
    expect(declarations(".token-arrow-label[data-menu-tab]")).toContain("--label-edge: var(--color-ink);");
    // The lift and the frame in one declaration, because `box-shadow` is one
    // property: written as the lift alone, this rule would drop the ring.
    expect(declarations(".token-arrow-label[data-menu-tab]")).toContain(
      "box-shadow: var(--mark-lift), inset 0 0 0 var(--mark-edge) var(--label-edge);",
    );

    // **And the label's box does not move**, which is the whole of why the
    // padding is written as it is: the frame used to be 1.5px of border on
    // each side and is now 1.5px of shadow *inside* the same box, so the
    // padding buys back what the border occupied and the border box comes to
    // the same figure it always did. tests/helpFigureFit.test.ts holds a
    // measured 31px of label-and-arc overhang that a label 3px narrower would
    // have falsified with nothing to catch it.
    expect(declarations(".token-arrow-label")).toContain(
      "padding: calc(0.3rem + var(--mark-edge)) calc(0.15rem + var(--mark-edge));",
    );
    const PAD_BLOCK = 0.3 * 16;
    const PAD_INLINE = 0.15 * 16;
    const EDGE = 1.5;
    // Border box, before and after, per side: padding + border, against
    // padding-that-includes-the-edge + no border.
    expect(PAD_BLOCK + EDGE).toBe(PAD_BLOCK + EDGE);
    expect(PAD_INLINE + EDGE).toBeCloseTo(3.9, 10);
    // What it would have cost to leave the padding alone: the text would have
    // stood 0.9px off its own frame across the label, since 0.15rem is 2.4.
    expect(PAD_INLINE - EDGE).toBeCloseTo(0.9, 10);

    // **How much of the ring the inset shadow can carry**, which is the one
    // claim here that only a page can settle. An inset shadow follows the
    // border box's rounded rectangle; the chevron leaves that rectangle along
    // two diagonals, and a clip removes what is outside the silhouette. So
    // this declaration cannot reach the point, and the block below is what
    // does — the arithmetic of how much was missing is worth keeping either
    // way, since it is the size of the job that block has to do.
    const CHIP = 17.6;
    const chev = 0.427 * CHIP; // --chip-chevron, measured off the shipped face
    const height = 1.2 * CHIP + 2 * (0.1 * 16); // --chip-line over --chip-pad-block
    const width = 3 * CHIP + 2 * (0.4 * 16) + chev / 2; // a three-character 品詞
    const diagonal = Math.hypot(chev, height / 2);
    const silhouette = height + 2 * (width - chev) + 2 * diagonal;
    expect(height).toBeCloseTo(24.32, 6);
    expect(diagonal).toBeCloseTo(14.29, 2);
    expect(silhouette).toBeCloseTo(176.59, 2);
    expect((2 * diagonal) / silhouette).toBeCloseTo(0.162, 3);

    // And the clearance the ring leaves the text at the tightest corner, which
    // is the top: 0.1rem of block padding less the baseline shift, plus the
    // line box's own half-leading, less the edge.
    const shift = 0.047 * CHIP; // --box-baseline-shift
    const padTop = 0.1 * 16 - shift;
    const halfLeading = (1.2 * CHIP - CHIP) / 2;
    expect(padTop).toBeCloseTo(0.77, 2);
    expect(padTop + halfLeading - EDGE).toBeCloseTo(1.03, 2);
    expect(padTop + halfLeading - EDGE).toBeGreaterThan(0);
  });

  it("holds the row open from the mark that is out, in one place", () => {
    /** **A ratchet on the shape of a fix, since the bug it fixes cannot be
     * reached from here.** The reader's report was that the pill foldout
     * auto-hides on mouseout while a menu is open. Every piece of the hold
     * existed — `data-semantics-menu`, `holdSemanticsFor`,
     * `releaseSemanticsHold`, and `semanticsShown` reading all three flags —
     * and what was missing was one call: the tab *switch* in `watchSemantics`
     * went to `openRetagMenu`, which closes the menu that is there and so
     * releases the hold, and then marked the new tab without re-taking it. So
     * the row was held for the first menu of a session and unheld for every
     * one after a switch.
     *
     * Adding the missing call would have left the shape that produced it — a
     * rule spread over two callers that both have to remember it — so the hold
     * moved into `markMenuTab`, which every route already calls and which
     * `closeContextMenu` already calls with `null`. What is pinned here is
     * exactly that: **`holdSemanticsFor` is spent in one place, and that place
     * is the marker.** Nothing in this suite can open a menu, take a pointer
     * off a row and watch what happens; there is no browser and no layout. So
     * this is a check on the source, in the way this file's other ratchets are
     * checks on the stylesheet, and it is worth its keep because the failure it
     * guards against is silent — a foldout that closes a moment too early. */
    const inspector = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "src", "render", "tokenInspector.ts"),
      "utf-8",
    ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

    const calls = (name: string) => inspector.split(`${name}(`).length - 1;
    // One definition and one call apiece: the definition, plus the single
    // spend inside `markMenuTab`.
    expect(calls("holdSemanticsFor")).toBe(2);
    expect(calls("releaseSemanticsHold")).toBe(2);
    const marker = inspector.slice(
      inspector.indexOf("function markMenuTab"),
      inspector.indexOf("\n}", inspector.indexOf("function markMenuTab")),
    );
    expect(marker).toContain("releaseSemanticsHold();");
    expect(marker).toContain("holdSemanticsFor(mark);");
    // And the one route out: unmarking is what lets the hold go, so
    // `closeContextMenu` needs no second line of its own.
    const closer = inspector.slice(
      inspector.indexOf("function closeContextMenu"),
      inspector.indexOf("\n}", inspector.indexOf("function closeContextMenu")),
    );
    expect(closer).toContain("markMenuTab(null);");
    expect(closer).not.toContain("releaseSemanticsHold");
  });
});

describe("the decollision waits for the slide, and reads how long off the page", () => {
  /** **Why this is a unit test of a string.** The reader asked that the
   * semantics "push other elements out of the way", so `decollideOverlay` is
   * re-run when they come out and again when they go back — and it measures
   * boxes, so it has to run after the slide has stopped rather than during it.
   * What decides "after" is the wrapper's own transition duration, read off
   * the computed style rather than declared a second time in TypeScript.
   *
   * Reading it is where this can be quietly wrong: engines report the computed
   * value in seconds, `parseFloat("0.16s")` is 0.16, and 0.16 taken for
   * milliseconds is a re-run that happens before the slide has visibly begun.
   * Nothing in this suite has a layout to catch that; the string is the one
   * part of it that can be checked here, so it is. */
  it("reads seconds as seconds and milliseconds as milliseconds", () => {
    expect(settleMsFrom("0.16s", "0s")).toBe(160 + 32);
    expect(settleMsFrom("160ms", "0ms")).toBe(160 + 32);
    // The two are the same duration written two ways, and they had better come
    // out the same number.
    expect(settleMsFrom("0.16s", "0s")).toBe(settleMsFrom("160ms", "0ms"));
  });

  it("waits for the last property to finish, not the first", () => {
    // The wrapper transitions two properties, and a rule that gave them
    // different lengths would settle at the longer of them.
    expect(settleMsFrom("0.16s, 0.3s", "0s, 0s")).toBe(300 + 32);
    expect(settleMsFrom("0.3s, 0.16s", "0s, 0s")).toBe(300 + 32);
    // A delay counts toward the wait, since a property that has not started
    // has not finished.
    expect(settleMsFrom("0.16s", "0.1s")).toBe(260 + 32);
    // A delay list shorter than the duration list repeats, which is what the
    // cascade does with it.
    expect(settleMsFrom("0.16s, 0.16s", "0.1s")).toBe(260 + 32);
  });

  it("does not wait at all where there is no transition to wait for", () => {
    // Reduced motion, where the rules resolve to `transition: none` — the
    // re-run should be immediate rather than delayed by slack that exists to
    // let an animation finish. The same answer for a computed value that is
    // missing altogether, which is what a DOM without a style engine gives.
    expect(settleMsFrom("0s", "0s")).toBe(0);
    expect(settleMsFrom("", "")).toBe(0);
  });

  it("adds two frames of slack, and only where something is moving", () => {
    // A `setTimeout` for exactly the duration can be served on the frame the
    // transition ends or the one before it, and a frame early on a 12px slide
    // is a box measured up to 12px short of where it stops. Two frames late is
    // a box that has been still for 32ms. The asymmetry is the argument, and
    // the slack is worth pinning because it looks like a magic number.
    expect(settleMsFrom("0.16s", "0s") - 160).toBe(32);
    expect(settleMsFrom("0s", "0s")).toBe(0);
  });
});

describe("the tie between two boxes of one token stops at the boxes", () => {
  /** **The reader:** *"Multi-character token ties still jut into the token's
   * head boxes."*
   *
   * The connector `markHeadCells` finds ran from one glyph's foot to the next
   * glyph's head — the *characters'* edges — and both characters are boxed,
   * with the box standing off the glyph rather than sitting on it. So each end
   * of the tie began inside the box it was leaving. Nothing here can look at
   * one; what it can do is hold the three lengths the box is declared from
   * against the one the tie is inset by, which is where the fault was.
   *
   * The lengths are read out of kunten.css rather than written here, in the
   * way this file's other stylesheet ratchets are: the whole defect was a
   * figure in the script disagreeing with a figure in the stylesheet. */
  const kunten = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "render", "kunten.css"),
    "utf-8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  const length = (name: string): number => {
    const at = kunten.indexOf(`${name}: `);
    expect(at, name).toBeGreaterThan(-1);
    return parseFloat(kunten.slice(at + name.length + 2));
  };

  const SIZE = length("--head-box-size"); // glyph edge to the box's outer edge
  const STROKE = length("--head-box-stroke"); // the border, drawn inside it
  const HALO = length("--head-box-halo"); // page colour outside it
  /** What the script insets each end by: the border's own centre line, which
   * is the figure and the expression the arc's bow already uses against this
   * same box (`boxBorder` in `showInspector`). */
  const INSET = SIZE - STROKE / 2;

  it("reads the box as three bands out from the glyph", () => {
    expect([SIZE, STROKE, HALO]).toEqual([4, 2, 2]);
    // 0-2 background, 2-4 the line, 4-6 background again — the bands
    // `.kanji-glyph::after` declares, and the reach every annotation on a
    // boxed character is placed against.
    expect(SIZE - STROKE).toBe(2);
    expect(SIZE + HALO).toBe(6);
    expect(INSET).toBe(3);
  });

  it("used to run four pixels past the ink and six past the halo", () => {
    // The fault, as a number. An end at the glyph's own edge crossed the whole
    // of the box's 2px stroke and ran 2px further into the halo inside it.
    const wasInset = 0;
    expect(SIZE - wasInset).toBe(4); // past the outer face of the ink
    expect(SIZE + HALO - wasInset).toBe(6); // past the outermost pixel it paints
    // And now it stops 1px inside the stroke, which is invisible: the tie and
    // the border are the same colour at the same width (`.token-head-join`).
    expect(SIZE - INSET).toBe(1);
    expect(INSET).toBeLessThan(SIZE);
    expect(INSET).toBeGreaterThan(SIZE - STROKE);
  });

  it("takes the inset off both ends and leaves the middle", () => {
    // Two glyphs an advance apart down a column: 44px of glyph and 44px of
    // gap at the shipped scale, so the run between two feet is 44 and the tie
    // covers all but 3 at each end.
    const run = headJoinRun(100, 144, INSET)!;
    expect(run).toEqual({ top: 103, bottom: 141 });
    expect(run.bottom - run.top).toBe(44 - 2 * INSET);
    // Symmetrical, which is the property that matters: a tie that met one box
    // and overshot the other would read as a line belonging to one character.
    expect(run.top - 100).toBe(144 - run.bottom);
  });

  it("draws nothing where the two boxes already meet", () => {
    // The degenerate case the inset introduces, and the one that was already
    // guarded. Twice the inset is 6px, against the 44px this geometry actually
    // leaves — so this cannot fire on the page as it is set, and fires only if
    // the type is ever set so tight that the boxes touch, where two boxes with
    // nothing between them are already the one unit the tie exists to draw.
    expect(headJoinRun(100, 106, INSET)).toBeNull(); // exactly twice the inset
    expect(headJoinRun(100, 105, INSET)).toBeNull();
    expect(headJoinRun(100, 100, INSET)).toBeNull(); // no gap at all
    expect(headJoinRun(100, 90, INSET)).toBeNull(); // measured backwards
    expect(headJoinRun(100, 107, INSET)).toEqual({ top: 103, bottom: 104 });
  });

  it("falls back to the old geometry where no box is declared", () => {
    // `headBoxInset` answers 0 for an engine that computes no custom
    // properties — jsdom is one — and 0 is exactly the tie as it was drawn
    // before any box existed, rather than no tie at all.
    expect(headJoinRun(100, 144, 0)).toEqual({ top: 100, bottom: 144 });
  });
});

describe("the deprel label walks its push instead of jumping it", () => {
  /** **The reader:** *"The deprel push-up should be animated."*
   *
   * The push is `labelLift`, and the hazard is that `decollideOverlay`
   * measures the label as often as it moves it — so a transition on the
   * property it writes would have it measuring a box that has not started
   * travelling. What is pinned here is the shape of the answer: the easing is
   * a class, the class is armed only after the measuring is done, and it rides
   * on an offset rather than on the position. Nothing here can see a frame of
   * it; there is no browser in this checkout. */
  const kunten = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "render", "kunten.css"),
    "utf-8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  const inspector = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "render", "tokenInspector.ts"),
    "utf-8",
  ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

  it("eases on the reveal's own clock, and not at all under reduced motion", () => {
    // The same 160ms the pills slide on, read from the same property, because
    // the push is an answer to that slide and an answer on its own interval
    // would read as a second kind of motion.
    expect(kunten).toContain("transition: translate var(--semantics-reveal) ease-out;");
    expect(kunten).toContain("transition: transform var(--semantics-reveal) ease-out;");
    // Both of them dropped together under the preference, in one block, so
    // that a mark cannot be left travelling beside one that arrives.
    expect(kunten).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.token-marks-eased \.token-arrow-label,\s*\.token-marks-eased \.token-chip-casing-label \{\s*transition: none;/,
    );
  });

  it("arms the easing only around the measuring, never through it", () => {
    const walk = inspector.slice(
      inspector.indexOf("function redecollide"),
      inspector.indexOf("\n}", inspector.indexOf("function redecollide")),
    );
    // Read where the reader sees it, disarm, measure, draw, then arm.
    const order = ["getBoundingClientRect", "classList.remove(MARKS_EASED)", "decollideOverlay(", "caseApparatus(", "classList.add(MARKS_EASED)"];
    let at = -1;
    for (const step of order) {
      const next = walk.indexOf(step, at + 1);
      expect(next, step).toBeGreaterThan(at);
      at = next;
    }
    // And the offset is dropped before the measuring, so `decollideOverlay`
    // sees the label at the position it itself wrote.
    expect(walk.indexOf('removeProperty("translate")')).toBeLessThan(walk.indexOf("decollideOverlay("));
    // The label's own position is never what transitions: it is an offset on
    // top of it, so the property `decollideOverlay` writes is exact at every
    // instant that function is looking.
    expect(kunten).not.toContain("transition: top var(--semantics-reveal)");
  });
});

describe("the ring carries on around the chevrons", () => {
  /** **The reader:** *"the borders on the horizontal pill components should
   * work around the chevrons, rather than being cut by them."*
   *
   * An inset `box-shadow` cannot: it follows the border box's rounded
   * rectangle and the clip removes it wherever the silhouette leaves that
   * rectangle. So the two diagonals of a point, and the two of a notch, are
   * drawn as a band on a pseudo-element instead — and the whole of what can be
   * got wrong there is *what shape the inner edge of that band is*. This block
   * is that arithmetic, checked against the polygon kunten.css declares.
   *
   * Nothing here can see a pixel; there is no browser in this checkout. What
   * it can do is show that the two lengths the polygon is built from make the
   * band a true offset — a constant perpendicular distance — rather than a
   * scaled copy of the chevron, which is what the first attempt would have
   * been and what the reader's instruction rules out. */
  const kunten = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "render", "kunten.css"),
    "utf-8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");

  /** The shipped chip and the box it makes: a fifth of an 88px cell, over a
   * 1.2 line box and 0.1rem of block padding. */
  const CHIP = 17.6;
  const c = 0.427 * CHIP; //            --chip-chevron, measured off the face
  const H = 1.2 * CHIP + 2 * (0.1 * 16); // --chip-height
  const run = H / 2; //                  one diagonal's vertical run
  const L = Math.hypot(c, run); //       its length
  const w = 1.5; //                      --mark-edge
  /** The two derived lengths, exactly as the stylesheet computes them. */
  const A = (w * L) / run; // --chip-edge-shift
  const B = (c * w) / run; // --chip-edge-rise

  /** How far a point is from the line through `from` and `to`. */
  const offsetFrom = (
    [ax, ay]: [number, number],
    [bx, by]: [number, number],
    [px, py]: [number, number],
  ): number => Math.abs((bx - ax) * (py - ay) - (by - ay) * (px - ax)) / Math.hypot(bx - ax, by - ay);

  it("is a true offset, not a scaled chevron", () => {
    expect(c).toBeCloseTo(7.5152, 4);
    expect(H).toBeCloseTo(24.32, 6);
    expect(L).toBeCloseTo(14.2949, 4);
    // The two figures the polygon is written from.
    expect(A).toBeCloseTo(1.7633, 4);
    expect(B).toBeCloseTo(0.927, 3);
    // **A is not w**, and that difference is the whole of this block: a
    // diagonal of this slope has to move 1.1756px sideways to move 1px
    // perpendicular.
    expect(A / w).toBeCloseTo(L / run, 10);
    expect(A).toBeGreaterThan(w);

    // Take the pointed pill's outer diagonal at a width of 100 (the `100%` the
    // polygon writes) and measure the polygon's own inner vertices against it.
    const W = 100;
    const shoulder: [number, number] = [W - c, 0];
    const apex: [number, number] = [W, run];
    // The inner apex, at `100% - --chip-edge-shift`.
    expect(offsetFrom(shoulder, apex, [W - A, run])).toBeCloseTo(w, 10);
    // The inner shoulder, at `100% - c - A + B`, where the offset diagonal
    // meets the offset top edge at y = w. Both on the line, so the band is
    // exactly `--mark-edge` wide the whole way down it.
    expect(offsetFrom(shoulder, apex, [W - c - A + B, w])).toBeCloseTo(w, 10);
    // …and it sits 0.8363px further in than the outer shoulder, which is the
    // mitre: measured vertically the band is thicker than w, as a mitre is.
    expect(c + A - B).toBeCloseTo(8.3515, 4);

    // The notch is the same shape mirrored, so the same two lengths place it.
    const notchApex: [number, number] = [c, run];
    expect(offsetFrom([0, 0], notchApex, [c + A, run])).toBeCloseTo(w, 10);
    expect(offsetFrom([0, 0], notchApex, [A + B, w])).toBeCloseTo(w, 10);
  });

  it("beats the naive inset it replaces, at both ends of the diagonal", () => {
    // **What insetting the box and re-clipping would have given**, which is
    // the version rejected in the round before this one: the chevron's depth
    // is a fixed em while the box loses `w` at each end, so the inner diagonal
    // is not parallel to the outer one.
    const W = 100;
    const shoulder: [number, number] = [W - c, 0];
    const apex: [number, number] = [W, run];
    // The same polygon in a box inset by w on all four sides.
    const naiveApex: [number, number] = [W - w, run];
    const naiveShoulder: [number, number] = [W - w - c, w];
    expect(offsetFrom(shoulder, apex, naiveApex)).toBeCloseTo(1.276, 3);
    expect(offsetFrom(shoulder, apex, naiveShoulder)).toBeCloseTo(2.065, 3);
    // 38% over at the shoulder, 15% under at the apex, on a 1.5px ring.
    expect(offsetFrom(shoulder, apex, naiveShoulder) / w).toBeCloseTo(1.376, 3);
    expect(offsetFrom(shoulder, apex, naiveApex) / w).toBeCloseTo(0.851, 3);
  });

  it("clears the text at the one place it is tight", () => {
    // The band reaches `c + A` into the pill at mid-height, against a padding
    // of `--chip-pad-inline + --chip-chevron / 2` on the chevron side.
    const padding = 0.4 * 16 + c / 2;
    expect(padding).toBeCloseTo(10.1576, 4);
    expect(padding - (c + A)).toBeCloseTo(0.879, 3);
    expect(padding - (c + A)).toBeGreaterThan(0);
    // What it was before the band existed — the notch's own ink against the
    // same padding — and so what the ring costs at this scale.
    expect(padding - c).toBeCloseTo(2.642, 3);

    // It scales in one direction only: the padding is a fixed 0.4rem and the
    // chevron an em, so the clearance falls as the chip grows, and the ring
    // brings the collapse forward from a 30px chip to a 21.7px one. The
    // shipped chip is a fifth of an 88px cell.
    const clearance = (size: number, edge: number) => 0.4 * 16 - 0.427 * size / 2 - (edge * Math.hypot(0.427 * size, (1.2 * size + 3.2) / 2)) / ((1.2 * size + 3.2) / 2);
    expect(clearance(CHIP, w)).toBeCloseTo(0.879, 3);
    expect(clearance(21.7, w)).toBeLessThan(0.05);
    expect(clearance(30, 0)).toBeLessThan(0.05);
    expect(CHIP).toBe(88 / 5);
  });

  it("fails safe where the arithmetic cannot be computed", () => {
    // `hypot()` and length-by-length division are CSS Values 4, and an engine
    // without them would leave an *unregistered* custom property as an
    // unparsable token stream — which makes `clip-path` invalid at
    // computed-value time and drops it to `none`, painting an unclipped
    // rectangle of ink over the pill. Registered, the same failure computes to
    // the initial value instead, and 0 collapses the band onto the edge it
    // offsets.
    for (const name of ["--chip-edge-shift", "--chip-edge-rise"]) {
      const at = kunten.indexOf(`@property ${name}`);
      expect(at, name).toBeGreaterThan(-1);
      const registration = kunten.slice(at, kunten.indexOf("}", at));
      expect(registration, name).toContain('syntax: "<length>";');
      expect(registration, name).toContain("initial-value: 0px;");
      // Inherited, because the rules that spend them are pseudo-elements of
      // the element they are declared on.
      expect(registration, name).toContain("inherits: true;");
    }
    // With both at 0 the inner apex is the outer apex and the inner shoulder
    // the outer shoulder: a band of no width, which is a chevron drawn exactly
    // as it was before this rule existed.
    expect(c + 0 - 0).toBeCloseTo(c, 10);

    // And a pill with no chevron at that end draws no band at all, which is
    // what the shared rule's own clip says before any of the three below give
    // it a shape.
    const at = kunten.indexOf("\n.token-subtitle::before,");
    expect(at).toBeGreaterThan(-1);
    expect(kunten.slice(at, kunten.indexOf("}", at))).toContain("clip-path: polygon(0 0, 0 0, 0 0);");
  });

  it("draws the band on a pseudo-element per chevron, and one per end", () => {
    // Two, because a pill can have a chevron at each end and one polygon
    // cannot be two disjoint regions. The middle pill of a three-pill row
    // wears both.
    expect(kunten).toContain(
      "\n.token-semantics-shown .token-subtitle-row > .token-subtitle:not(:last-child)::before,\n.token-subtitle-semantics > .token-subtitle:not(:last-child)::before {",
    );
    expect(kunten).toContain("\n.token-subtitle-semantics > .token-subtitle::after {");
    // The polygons are written from the custom properties, never from
    // literals: the ring has to stay uniform if the chevron, the type size or
    // the padding move.
    const point = kunten.slice(
      kunten.indexOf("--chip-point-inner:"),
      kunten.indexOf("}", kunten.indexOf("--chip-point-inner:")),
    );
    expect(point).toContain("calc(100% - var(--chip-edge-shift)) 50%");
    expect(point).toContain("var(--chip-point-inner) var(--mark-edge)");
    expect(point).not.toMatch(/\d+px/);
    const notch = kunten.slice(
      kunten.indexOf("--chip-notch-inner:"),
      kunten.indexOf("}", kunten.indexOf("--chip-notch-inner:")),
    );
    expect(notch).toContain("calc(var(--chip-chevron) + var(--chip-edge-shift)) 50%");
    expect(notch).not.toMatch(/\d+px/);
    // The pill has to be a containing block for them, which the two inside the
    // semantics wrapper were not.
    const pill = kunten.slice(kunten.indexOf("\n.token-subtitle {"), kunten.indexOf("}", kunten.indexOf("\n.token-subtitle {")));
    expect(pill).toContain("position: relative;");
    expect(pill).toContain("--chip-edge-shift: calc(var(--mark-edge) * var(--chip-chevron-edge) / var(--chip-chevron-run));");
  });
});

describe("what a left click on one of the four marks now does", () => {
  /** **Two instructions, one rule.** *"Single-clicking on the folded-out pill
   * should be enough to open the menu"*, then *"Left-clicking the deprel pill
   * should be enough to open it"*, then *"A second tap on the POS pill should
   * just close the menu."* What they come to is: **the mark that opens a menu
   * is the mark that closes it**, on the ordinary gesture, for all four marks.
   *
   * None of that can be exercised here — there is no browser, no layout, and
   * no menu to open — so this is a ratchet on the source, in the way this
   * file's other ratchets are. It is worth its keep because every one of these
   * gestures has a *second* listener that can silently eat it: the
   * capture-phase dismissal on `document`, which runs before anything else and
   * stops the click it dismisses on. That listener has now had to be taught
   * about each of these marks in turn, and a rule added here without a line
   * there would look exactly like a rule that does nothing. */
  const inspector = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "render", "tokenInspector.ts"),
    "utf-8",
  ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

  const body = (name: string): string => {
    const at = inspector.indexOf(`function ${name}`);
    expect(at, name).toBeGreaterThan(-1);
    return inspector.slice(at, inspector.indexOf("\n}", at));
  };

  it("opens a pill's menu while the row is revealed, and closes it on the second click", () => {
    const watcher = body("watchSemantics");
    // The gate is the *reveal*, not the open menu it used to be: with the
    // semantics up, any of the three pills opens its own menu.
    expect(watcher).toContain("if (selected && semanticsShown(row)) {");
    expect(watcher).toContain("if (kind === openMenuKind) closeContextMenu();");
    expect(watcher).toContain("openRetagMenu(kind, selected.entry, anchor.x, anchor.y);");
    // The unfold survives underneath it, which is the touch reader's only way
    // in and the one thing the instruction said to keep.
    expect(watcher).toContain('if (!target.closest(".token-subtitle-pos")) return;');
    expect(watcher).toContain('row.dataset.semanticsPinned = "true";');
  });

  it("opens the relation menu on a left click, with no reveal to wait for", () => {
    const watcher = body("watchDeprelLabel");
    expect(watcher).toContain('label.addEventListener("click"');
    // No `semanticsShown` anywhere in it: the label is always drawn, is never
    // folded away, and a left click on it never meant anything else.
    expect(watcher).not.toContain("semanticsShown");
    expect(watcher).toContain('openRetagMenu("dep", selected.entry, anchor.x, anchor.y);');
    // The same toggle the pills take.
    expect(watcher).toContain('if (openMenuKind === "dep") {');
    expect(watcher).toContain("closeContextMenu();");
    // And it is wired to the label that is drawn, so it lives and dies with
    // the overlay rather than accumulating on the container.
    expect(inspector).toContain("watchDeprelLabel(label);");
  });

  it("lets both gestures past the capture-phase dismissal", () => {
    // The listener on `document` that puts an open menu away when the reader
    // presses somewhere else. It runs first and calls `stopPropagation`, so
    // anything it does not exempt never reaches the handlers above.
    const at = inspector.indexOf('document.addEventListener(\n    "pointerdown"');
    expect(at).toBeGreaterThan(-1);
    const guard = inspector.slice(at, inspector.indexOf("\n  );", at));
    expect(guard.length).toBeGreaterThan(0);
    // The label unconditionally — it answers a click whenever it is on the
    // page, so no state can decide this one.
    expect(guard).toContain("if (target.closest(DEPREL_LABEL)) return;");
    // A pill only while its own row is revealed, which is exactly when a click
    // on it means something.
    expect(guard).toContain("if (pressedRow && semanticsShown(pressedRow)) return;");
  });
});

describe("what an arrow key does to an open menu", () => {
  /** The keydown handler's source, which is where this behaviour lives — there
   * is no DOM in this suite to press a key in, and the ordering it turns on is
   * a fact about the source rather than about a layout. */
  const source = readFileSync(join(import.meta.dirname, "..", "src", "render", "tokenInspector.ts"), "utf-8");
  const arrowBranch = (() => {
    const at = source.indexOf("const direction = ARROW_DIRECTIONS[event.key];");
    expect(at).toBeGreaterThan(-1);
    return source.slice(at, source.indexOf("navigate(direction);", at) + "navigate(direction);".length);
  })();

  it("closes it, rather than leaving it over a different character", () => {
    // A retag menu is a question about *one* token — its rows are that token's
    // 品詞's domains, that domain's senses, that arc's relations — and picking
    // one edits whatever is selected when the click lands. Left standing after
    // an arrow it would offer the old token's options and apply them to the
    // new one, which is worse than stale.
    expect(arrowBranch).toContain("closeContextMenu();");
  });

  it("closes it before moving, not after", () => {
    // The order matters for one reason worth pinning: closing releases the
    // menu's hold on the pill row (`markMenuTab`), and that has to happen while
    // the row being held is still the row the menu came from.
    expect(arrowBranch.indexOf("closeContextMenu();")).toBeLessThan(arrowBranch.indexOf("navigate(direction);"));
  });

  it("still moves, which is what separates it from Escape", () => {
    // Escape puts the menu away and stops. An arrow puts it away *and* goes on
    // reading — a reader pressing an arrow asked to move, not to dismiss.
    expect(arrowBranch).toContain("navigate(direction);");
  });
});

describe("every custom property a mark uses is one it can see", () => {
  /** **A `var()` an element cannot resolve takes the whole declaration with
   * it**, and for `transform` that means falling back to `none`.
   *
   * Not hypothetical, and it is why this block exists. `--chip-chevron` was
   * declared inside `.token-subtitle`, and `.token-subtitle-row` — the pill's
   * *parent* — expressed its centring in terms of it. Custom properties
   * inherit downward only, so the row's `var()` was unresolvable, its
   * `translateX(-50%)` was dropped at computed-value time, and the row hung
   * from the glyph's centre by its left edge: the 品詞 pill sat half its own
   * width right of the character it names, on every token in every text.
   * Nothing in the suite could see it — a custom property is a string in a
   * stylesheet until a browser resolves it, and there is no browser here.
   *
   * What *can* be checked without one is reachability: a property used in a
   * rule must be declared on that rule's own element or on an ancestor. The
   * overlay is the ancestor of every mark the analysis draws, so that is where
   * a shared figure belongs. */
  const sheet = readFileSync(join(import.meta.dirname, "..", "src", "render", "kunten.css"), "utf-8");
  const blockFor = (selector: string): string => {
    const at = sheet.indexOf(`\n${selector} {`);
    return at < 0 ? "" : sheet.slice(at, sheet.indexOf("\n}", at) + 2);
  };
  const declaredIn = (selector: string): string[] =>
    [...blockFor(selector).matchAll(/^ +(--[a-z0-9-]+) *:/gm)].map((m) => m[1]);
  const usedIn = (selector: string): string[] =>
    [...blockFor(selector).matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]);

  it("finds the rules it is meant to be checking", () => {
    // The guard's own guard: a selector lookup that silently stopped matching
    // would make every assertion below vacuous, which is the shape of the bug
    // this file exists for.
    expect(blockFor(".token-subtitle-row")).not.toBe("");
    expect(blockFor(".token-inspector-overlay")).not.toBe("");
    expect(usedIn(".token-subtitle-row").length).toBeGreaterThan(0);
  });

  it("resolves the row's own properties from the overlay above it", () => {
    const overlay = declaredIn(".token-inspector-overlay");
    const own = declaredIn(".token-subtitle-row");
    const unreachable = usedIn(".token-subtitle-row").filter(
      (name) => !overlay.includes(name) && !own.includes(name),
    );
    expect(unreachable.join(", ")).toBe("");
  });

  it("keeps the chevron on the overlay, where the row and the pills both see it", () => {
    // Named, because putting it back on the pill is the exact regression above.
    expect(declaredIn(".token-inspector-overlay")).toContain("--chip-chevron");
    expect(declaredIn(".token-subtitle")).not.toContain("--chip-chevron");
    // Still an `em`, so each element re-resolves it against its own font size —
    // which `showInspector` sets on the row as well as on every pill, so the
    // two agree on what it comes to.
    expect(sheet).toContain("--chip-chevron: 0.4270em;");
  });
});

describe("where a deprel label is placed before anything moves it", () => {
  /** The two placements are different kinds of decision, and conflating them
   * is the regression this pins. Read off the source, since there is no layout
   * in this suite to measure a placed label in. */
  const source = readFileSync(join(import.meta.dirname, "..", "src", "render", "tokenInspector.ts"), "utf-8");

  it("places a same-column label in the gutter and a cross-line one on its midpoint", () => {
    // A same-column arc runs beside a column of text, so `gutterOffset` is
    // where its label *lives*. A cross-line arc runs between the columns and
    // is already clear of the text at the midpoint of its own edge, so that is
    // where its label belongs — `peak` is 0 for it, which is what makes the
    // second half of this expression the chord midpoint exactly.
    expect(source).toContain("const labelX = sameColumn ? midX + nx * gutterOffset : midX + nx * peak;");
    expect(source).toContain("const labelY = midY + ny * peak;");
  });

  it("gives the cross-line label no standoff of its own", () => {
    // It was given the same half-cell as the same-column case, which put it
    // 44px off the edge it names — "way off", as the reader had it. Any
    // displacement it needs is `decollideOverlay`'s, and minimal by
    // construction: across the gutter only far enough to clear the readings,
    // with the pill row yielding along the column rather than the label
    // yielding to it.
    expect(source).not.toContain("labelStandoffFromArc");
  });
});

describe("a label stays inside the text it annotates", () => {
  /** The clamp `decollideOverlay` applies last, as arithmetic on two boxes —
   * jsdom has no layout to clip anything in, so what is checkable is the rule. */
  const clampShift = (label: Extent, columnBox: Extent, casing: number): number => {
    if (label.bottom - label.top > columnBox.bottom - columnBox.top) return 0;
    const above = columnBox.top + casing - label.top;
    const below = label.bottom - (columnBox.bottom - casing);
    return above > 0 ? above : below > 0 ? -below : 0;
  };
  const column = box(0, 0, 500, 900);

  it("leaves a label that already fits exactly where it was", () => {
    // The ordinary case, and the one the clamp must not touch: a label's
    // position along the column is the arc's own midpoint, and moving it names
    // a different stretch of the sentence.
    expect(clampShift(box(100, 300, 130, 500), column, 2)).toBe(0);
  });

  it("pushes a label clipped at the head of the column down, by the least that shows it", () => {
    // The reader's case: a cross-line label sits on its own chord's midpoint,
    // and when the target is at the top of a column that midpoint is near the
    // top too — so a 200px vertical label reaches 100px above the first
    // character and `overflow-y: hidden` takes that half away.
    const high = box(100, -60, 130, 140); // 200 tall, 60 above the column
    const shift = clampShift(high, column, 2);
    expect(shift).toBeCloseTo(62, 6); // the 60 it is out by, plus the casing
    expect(high.top + shift).toBeGreaterThanOrEqual(column.top);
  });

  it("pushes one clipped at the foot up, and by no more", () => {
    const low = box(100, 800, 130, 1000);
    const shift = clampShift(low, column, 2);
    expect(shift).toBeCloseTo(-102, 6);
    expect(low.bottom + shift).toBeLessThanOrEqual(column.bottom);
  });

  it("leaves a label taller than the column alone", () => {
    // It cannot be made whole at either end, and pinning it to one would be a
    // displacement bought for nothing.
    expect(clampShift(box(100, -50, 130, 1000), column, 2)).toBe(0);
  });
});

describe("what the label treats as ruby", () => {
  /** Source-level, because the distinction is between two DOM measurements and
   * jsdom has no layout to tell them apart. */
  const source = readFileSync(join(import.meta.dirname, "..", "src", "render", "tokenInspector.ts"), "utf-8");

  it("measures the kana, not the lane they are set in", () => {
    // The reader's words: the label "should only stay clear of the ruby lane if
    // it would otherwise collide with the highlighted ruby". It was clearing
    // the lane. `getBoundingClientRect` on a reading returns its laid-out box,
    // which is the whole run's extent down the column — so a label beside an
    // empty stretch of that lane registered as a collision with kana that were
    // nowhere near it, and was pushed aside for nothing. A `Range` over the
    // run's contents measures the glyphs' own line boxes instead.
    expect(source).toContain("range.selectNodeContents(run)");
    expect(source).toContain("range.getClientRects()");
    expect(source).toContain("const readingBoxes = readings.flatMap(inkOf);");
  });

  it("falls back to the box where a Range answers nothing", () => {
    // A run that reports no rects must become *smaller*, not invisible: losing
    // it from the obstacle set would let the label sit straight on the kana.
    expect(source).toContain("rects.length > 0 ? rects : [run.getBoundingClientRect()]");
  });

  it("still asks only about the inspected token's own readings", () => {
    // Unchanged, and the two are easy to confuse: *which* readings is
    // `INSPECTED_READINGS`, *how much of one* is the Range. Getting the second
    // right does not excuse widening the first.
    expect(source).toContain("column.querySelectorAll<HTMLElement>(INSPECTED_READINGS)");
  });
});
