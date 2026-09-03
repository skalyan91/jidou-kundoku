import { describe, expect, it } from "vitest";
import { fittedTracking, matchedDivision, matchedSlots } from "../src/render/KakikudashiView.ts";

// ---------------------------------------------------------------------------
// Fitting the 書き下し文 column to a whole number of characters.
//
// A column here is a vertical band, and its usable length is the panel's own
// height less the padding at each end. Nothing makes that length a multiple
// of the character advance: the kundoku panel above rounds *its* height down
// to a whole number of slots and hands the remainder down, so this panel is
// where the remainder lands and it has no height of its own left to round
// away. Measured at a 792px viewport: 248.6px of column against a 25.3px
// advance — 9.83 characters, so nine were set and four fifths of a character
// sat unused at the foot of every column in the panel.
//
// `fittedTracking` spends that on the tracking instead: the measure divided
// by the nearest whole number of characters, less the character itself. It is
// pure so that the arithmetic can be checked without a layout engine; what
// cannot be checked here is that a browser lays the result out to the advance
// it was asked for, which is what `FIT_GUARD_PER_SLOT_PX` in the module is
// about.
// ---------------------------------------------------------------------------

/** The panel's live geometry, measured: a 22px character drawn at a 0.15em
 * tracking, so a 25.3px advance. */
const SIZE = 22;
const DESIGN = SIZE * 0.15;

/** How many characters a column of `measure` holds at a given tracking —
 * every character carrying its own trailing tracking, the last one included,
 * which falls below it and reads as the margin exactly as `--kanji-advance`
 * says the kundoku panel's does. */
const holds = (measure: number, tracking: number) => Math.floor(measure / (SIZE + tracking));

describe("fittedTracking", () => {
  it("takes up the slack the panel is measured with", () => {
    // The 792px viewport, character for character: nine characters and 20.9px
    // of nothing become ten characters and a tracking a reader cannot see the
    // difference in.
    expect(holds(248.6015625, DESIGN)).toBe(9);
    const tracking = fittedTracking(248.6015625, SIZE, DESIGN)!;
    expect(holds(248.6015625, tracking)).toBe(10);
    expect(tracking).toBeGreaterThan(2.8);
    expect(tracking).toBeLessThan(2.9);
    // And what is left over is a tracking's worth and not a character's.
    expect(248.6015625 - 10 * (SIZE + tracking)).toBeLessThan(tracking + 0.01);
  });

  it("fills the measure, to within what the layout grid can round away", () => {
    // The kundoku column ends flush with its content edge — 4 x 88px into
    // 352px of measure — and this one should read as the same page. What the
    // fit may not claim is the half layout unit per character that a snapped
    // letter-spacing can round up by, since a column that overruns loses a
    // whole character; everything else is spent.
    for (let measure = 200; measure < 900; measure += 0.25) {
      const tracking = fittedTracking(measure, SIZE, DESIGN);
      if (tracking === null) continue;
      const slots = Math.round(measure / (SIZE + DESIGN));
      const left = measure - slots * (SIZE + tracking);
      expect(left).toBeGreaterThanOrEqual(0);
      expect(left).toBeLessThanOrEqual(slots / 120 + 1e-9);
      // At the shipped ten characters that is a twelfth of a pixel.
      if (slots === 10) expect(left).toBeLessThan(0.09);
    }
  });

  it("never asks for a column it cannot have", () => {
    // The advance the panel is laid out at must not exceed the measure over
    // the count, or the last character wraps and the fit has cost a character
    // rather than gaining one.
    for (let measure = 120; measure < 900; measure += 0.5) {
      const tracking = fittedTracking(measure, SIZE, DESIGN);
      if (tracking === null) continue;
      const slots = Math.round(measure / (SIZE + DESIGN));
      expect(slots * (SIZE + tracking)).toBeLessThanOrEqual(measure);
    }
  });

  it("rounds to the nearest count rather than always down", () => {
    // Rounding down would mean only ever loosening: a column 9.8 characters
    // long would be set at nine and a tracking half again as loose. The
    // nearest count tightens by 0.44px a character and gains a character in
    // every column of the panel.
    const loose = fittedTracking(9.2 * (SIZE + DESIGN), SIZE, DESIGN)!;
    const tight = fittedTracking(9.8 * (SIZE + DESIGN), SIZE, DESIGN)!;
    expect(loose).toBeGreaterThan(DESIGN);
    expect(tight).toBeLessThan(DESIGN);
  });

  it("stays within a tracking a reader would have to measure to see", () => {
    // Over the whole range of panel heights it accepts, the fitted tracking
    // is the drawn one give or take half a slot's worth — which is small
    // while the column is long, and is why the band below exists for when it
    // is not.
    for (let measure = 200; measure < 900; measure += 0.25) {
      const tracking = fittedTracking(measure, SIZE, DESIGN);
      if (tracking === null) continue;
      expect(Math.abs(tracking - DESIGN)).toBeLessThan(1.7);
    }
  });

  it("keeps the drawn tracking where fitting would set the type solid", () => {
    // A column of three characters is a panel dragged shut, and a measure
    // 2.6 characters long rounded up to three has to close the tracking past
    // nothing to get there. Saving a fraction of a character is not worth
    // setting the type solid, so the panel keeps what it is drawn at and
    // accepts the part-slot.
    expect(fittedTracking(2.6 * (SIZE + DESIGN), SIZE, DESIGN)).toBeNull();
  });

  it("declines a panel with no column in it", () => {
    // The collapsed panel, whose grid row is zero high — the padding alone
    // makes the measure negative — and the moment before the type scale has
    // resolved.
    expect(fittedTracking(-110, SIZE, DESIGN)).toBeNull();
    expect(fittedTracking(0, SIZE, DESIGN)).toBeNull();
    expect(fittedTracking(248.6, 0, DESIGN)).toBeNull();
    expect(fittedTracking(Number.NaN, SIZE, DESIGN)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Matching the passage to the one above it.
//
// The two panels hold the same text and used to end in different places. The
// kundoku panel sets four characters to a column at the shipped type scale and
// runs 88px a column; this one ran 44px a column and held ten — and the prose
// of a kanbun passage is two to three times as many characters as the kanbun,
// which at half the pitch is well under half the width. Counted on 酒蟲: 271
// kundoku cells against 652 characters of prose (a mark of punctuation costs
// the kundoku line nothing — see `.punct-cell` in kunten.css — which is why
// the first number is not the 359 characters the source has), coming to 69
// columns against 66, 6072px against 2904px.
//
// `matchedSlots` closes that by shortening the prose column, which lengthens
// the passage. What it may not do is lengthen the column past what the panel
// can hold, so the search runs downwards from there and the answer is a
// comparison of measured extents rather than a division: the achievable
// extents are a staircase whose steps near the answer are hundreds of pixels
// apart, and there is generally no step on the target.
// ---------------------------------------------------------------------------

/** 酒蟲, column for column: how many columns the prose comes to at each column
 * length. A column is 44px across.
 *
 * The character counts are the text pipeline's own (parse -> reading order ->
 * kakikudashi, over the file the panel was tuned on: 652 characters across the
 * source's three lines); the columns are those counts wrapped a line at a
 * time, `ceil(line / slots)`. That is arithmetic and not a rendering, and it
 * runs a little short of what a browser lays out — 禁則 keeps a mark of
 * punctuation off the head of a column and so spends the odd extra one, which
 * on this text at ten characters to the column is the difference between the
 * 66 below and the 67 `.text-kakikudashi` in typography.css records having
 * measured. The shortfall is under two per cent and it is in the same
 * direction at every length, so what it can move is the size of a miss and not
 * which of two candidates is nearer; the panel itself measures rather than
 * predicts, which is `kundokuExtent`'s subject. */
const SHUCHU_COLUMNS: Record<number, number> = { 3: 218, 4: 164, 5: 131, 6: 110, 7: 94, 8: 83, 9: 74, 10: 66 };
const shuchuExtent = (slots: number) => (SHUCHU_COLUMNS[slots] ?? 0) * 44;

describe("matchedSlots", () => {
  it("matches the kundoku passage as closely as a whole column length can", () => {
    // The shipped panel at a 792px viewport: ten characters to the column, and
    // a kundoku passage of 69 columns to reach.
    const target = 69 * 88;
    expect(shuchuExtent(10)).toBe(2904); // where the prose ended: less than half way
    expect(matchedSlots(target, 10, shuchuExtent)).toBe(5);
    // And the miss is the smaller of the two the staircase offers.
    expect(target - shuchuExtent(5)).toBe(308);
    expect(shuchuExtent(4) - target).toBe(1144);
  });

  it("lands on the target exactly where a step happens to sit on it", () => {
    // A taller window gives the kundoku panel five characters to the column
    // instead of four, so its passage comes to 55 columns — and six characters
    // to the prose column is 110 columns of half the pitch, which is the same
    // distance to the pixel. Nothing arranges this; it is what the two texts
    // happen to come to. The ceiling is left at ten so that the target is the
    // only thing that has moved.
    expect(shuchuExtent(6)).toBe(55 * 88);
    expect(matchedSlots(55 * 88, 10, shuchuExtent)).toBe(6);
  });

  it("leaves a passage that already runs past the target alone", () => {
    // The kundoku panel is one column of a short text and this one is already
    // longer than it: every candidate below only makes the gap worse, and the
    // panel keeps the length it holds unaided.
    expect(matchedSlots(88, 10, shuchuExtent)).toBe(10);
  });

  it("stops as soon as a candidate reaches the target", () => {
    // Every candidate is a write and a forced layout, so the walk ends at the
    // first extent to reach the target: the ones below it are further away
    // still. Six is the first to pass a target of 4700, and five is measured
    // only because it is the step before it.
    const asked: number[] = [];
    const measure = (slots: number) => {
      asked.push(slots);
      return shuchuExtent(slots);
    };
    expect(matchedSlots(4700, 10, measure)).toBe(6);
    expect(Math.min(...asked)).toBe(6);
  });

  it("keeps the longer column where two lengths miss by the same amount", () => {
    // Half way between two steps, the fuller panel — which is also the state
    // nearest the one the panel was in before any of this.
    const target = (shuchuExtent(5) + shuchuExtent(6)) / 2;
    expect(matchedSlots(target, 10, shuchuExtent)).toBe(6);
  });

  it("answers one character where there is no panel to walk down from", () => {
    // The collapsed panel, and the moment before the type scale has resolved:
    // a ceiling below one is not a length to search. The caller never gets
    // here — `fitPassageExtent` leaves such a panel alone rather than asking —
    // so what matters is only that the answer is a column that could exist.
    expect(matchedSlots(6072, 0, shuchuExtent)).toBe(1);
    expect(matchedSlots(6072, Number.NaN, shuchuExtent)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Dividing the page between the two panels.
//
// The panels are the two text rows of one grid and share one height, so
// height given up by the prose is height the kanbun receives — and the kundoku
// column has to hold a whole number of characters, so it can only receive it
// 88px at a time. That makes the coarse variable a single integer: how many
// steps to move across the rail. The fine variable is the prose column length
// within whatever share is left, which is what reaches the range between one
// step and the next — 88px being three and a half prose characters.
//
// `matchedDivision` walks the steps, asks `matchedSlots` for the best column
// at each, and takes the least mismatch, ties going to the fewer steps: a step
// re-breaks every column of the text the reader is reading, so a division that
// matches no better has not earned one.
//
// The page below is modelled, not rendered — the geometry from the stylesheets
// (the 60% rounded split, the 55/11 and 55/55 insets, the 0.9rem rail, the
// 88px and 25.3px advances) and the column counts from the text pipeline. What
// it is a test of is the choice, which is arithmetic; the panel itself
// measures, and `matchedDivision`'s two callbacks are where that goes.
// ---------------------------------------------------------------------------

/** 酒蟲 in both panels: columns at each column length. The kundoku table is
 * cells — 271 of them, a mark of punctuation taking no advance there — and the
 * prose table is 652 characters, each wrapped a source line at a time. */
const SHUCHU_KUNDOKU: Record<number, number> = { 1: 271, 2: 136, 3: 91, 4: 69, 5: 55, 6: 47, 7: 41, 8: 36, 9: 32, 10: 28, 11: 26, 12: 25, 13: 22, 14: 21 };
const SHUCHU_PROSE: Record<number, number> = { 1: 652, 2: 327, 3: 218, 4: 164, 5: 131, 6: 110, 7: 94, 8: 83, 9: 74, 10: 66, 11: 60, 12: 56, 13: 52, 14: 48, 15: 45, 16: 42, 17: 40, 18: 38, 19: 36, 20: 34 };

/** The page at a given viewport height, as the two stylesheets build it: the
 * kundoku row is `margins + border + round(down, 60% - those, 88)` plus the
 * steps this division is asking for, the rail is 0.9rem, and the prose panel
 * is the `1fr` remainder less its own 55px at each end. */
function page(viewport: number) {
  const KUNDOKU_INSET = 55 + 11 + 1; // margin above, margin below, border
  const PROSE_INSET = 110; // 55 at each end
  const RAIL = 14.4;
  const ADVANCE = 88;
  const PROSE_ADVANCE = 25.3;
  const base = Math.floor((0.6 * viewport - KUNDOKU_INSET) / ADVANCE);
  return (steps: number) => {
    const row = KUNDOKU_INSET + (base + steps) * ADVANCE;
    const measure = viewport - row - RAIL - PROSE_INSET;
    const ceiling = Math.round(measure / PROSE_ADVANCE);
    if (ceiling < (steps === 0 ? 1 : 3)) return null;
    return { target: SHUCHU_KUNDOKU[base + steps] * 88, ceiling, held: base + steps, measure };
  };
}
const proseExtent = (slots: number) => (SHUCHU_PROSE[slots] ?? 0) * 44;

describe("matchedDivision", () => {
  it("moves one step, and lands on the kundoku passage exactly", () => {
    // The shipped 792px viewport. Unmoved, the kundoku holds four characters
    // to the column and runs 69 x 88 = 6072px while the prose holds ten and
    // runs 66 x 44 = 2904px — the same text ending less than half way along
    // the passage it translates. One step gives the kanbun a fifth character
    // (55 columns, 4840px) and leaves the prose a measure that holds six (110
    // columns, 4840px), which is the same distance to the pixel.
    const at = page(792);
    expect(at(0)!.held).toBe(4);
    expect(at(1)!.held).toBe(5);
    expect(at(1)!.ceiling).toBe(6);
    const best = matchedDivision(6, at, proseExtent)!;
    expect(best).toEqual({ steps: 1, slots: 6, unused: 0, fills: true, gap: 0 });
    // `fills`, so the prose panel's own share is the column that matches and
    // no height is given up to nothing.
    expect(proseExtent(best.slots)).toBe(SHUCHU_KUNDOKU[5] * 88);
  });

  it("declines a second step rather than cutting the prose panel to nothing", () => {
    // Two steps leaves 72.6px of prose panel — three characters to the column,
    // where the text runs 218 columns and 9592px against the kanbun's 4136:
    // more than twice as long, and the worst of the three divisions by a long
    // way. The step is coarse, and this is what its coarseness costs.
    const at = page(792);
    expect(at(2)!.ceiling).toBe(3);
    expect(proseExtent(3) - at(2)!.target).toBe(5456);
    expect(matchedDivision(6, at, proseExtent)!.steps).toBe(1);
  });

  it("stays where it is where the fine variable answers better than a step", () => {
    // At 845px the kundoku panel already holds five characters, and a step
    // would take it to six (47 columns, 4136px) against a prose panel that
    // could then hold five (131 columns, 5764px) — 39% long. Left where it is,
    // the prose column cut from the eight the panel holds to six comes to
    // 4840px against 4840px. So the division that leaves the reader's panel
    // alone is also the one that matches, and it wins on both counts.
    const at = page(845);
    expect(at(0)!.held).toBe(5);
    expect(at(0)!.ceiling).toBe(8);
    const best = matchedDivision(6, at, proseExtent)!;
    expect(best).toEqual({ steps: 0, slots: 6, unused: 2, fills: false, gap: 0 });
  });

  it("takes the step where two divisions match equally and one wastes less", () => {
    // At 900px both no step (five characters to the kundoku column, the prose
    // cut from the eleven its panel holds to six) and one step (six
    // characters, the prose cut from seven to seven) end in the same place.
    // The first leaves five characters of prose panel — 117px — empty; the
    // second gives that height to the kanbun and fills what is left exactly.
    // Height a division declines to use should go across the rail rather than
    // stand as a margin, so the step wins.
    const at = page(900);
    expect(at(0)!.ceiling).toBe(11);
    expect(at(1)!.ceiling).toBe(7);
    const best = matchedDivision(6, at, proseExtent)!;
    expect(best).toEqual({ steps: 1, slots: 7, unused: 0, fills: true, gap: 0 });
    // The one it passed over really was as good a match, not merely worse.
    const stayed = at(0)!;
    expect(proseExtent(matchedSlots(stayed.target, stayed.ceiling, proseExtent))).toBe(stayed.target);
  });

  it("misses, and says by how much, where no division lands well", () => {
    // A 640px window: three characters to the kundoku column unmoved, which is
    // 91 columns and 8008px — longer than the prose reaches at any length the
    // panel can hold — and a step overshoots the other way. The best available
    // is 792px short of 8008, which is 9.9%, and that is the answer rather
    // than an error: the staircase has no step near the target here.
    const at = page(640);
    const best = matchedDivision(6, at, proseExtent)!;
    expect(best).toEqual({ steps: 0, slots: 4, unused: 3, fills: false, gap: 792 });
    expect(best.gap / at(0)!.target).toBeCloseTo(0.099, 3);
  });

  it("answers nothing where the page cannot be divided at all", () => {
    // The collapsed panel: no measure, no column, no division. The caller puts
    // the split back where it found it rather than declaring it zero.
    expect(matchedDivision(6, () => null, proseExtent)).toBeNull();
  });
});
