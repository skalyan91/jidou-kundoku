import { describe, expect, it } from "vitest";
import {
  alignmentKnots,
  correspondingPosition,
  gapAlignments,
  setupScrollSync,
} from "../src/render/scrollSync.ts";

/** A panel reduced to the parts `captureScroll` and its restore actually
 * touch: a clamped scroll position, the listener the module registers on it,
 * and a count of how many times the module went looking for sentence gaps —
 * which is how a sync announces itself, since `sync` reaches for them first
 * thing.
 *
 * The glide is deliberately not modelled. Nothing here starts one: a glide
 * only begins inside `sync`, and every case below either suppresses the sync
 * or asserts that it ran, and the assertion is the `querySelectorAll` count
 * rather than any movement it would cause. */
function fakePanel(scrollWidth: number, clientWidth: number) {
  const listeners: Array<() => void> = [];
  const panel = {
    scrollLeft: 0,
    scrollWidth,
    clientWidth,
    syncsAttempted: 0,
    scrollTo({ left }: { left: number; behavior?: string }) {
      // vertical-rl: 0 at the panel's own right edge, negative leftward, so
      // the reachable range is [-(scrollWidth - clientWidth), 0].
      panel.scrollLeft = Math.max(-(panel.scrollWidth - panel.clientWidth), Math.min(0, left));
    },
    addEventListener(_type: string, fn: () => void) {
      listeners.push(fn);
    },
    querySelectorAll() {
      panel.syncsAttempted += 1;
      return [] as unknown[];
    },
    /** The one 'scroll' event the browser coalesces a frame's writes into,
     * carrying whatever position the panel ended that frame at. */
    fireScroll() {
      for (const fn of listeners) fn();
    },
  };
  return panel;
}

function setup() {
  const kundoku = fakePanel(6248, 623);
  const kakikudashi = fakePanel(3212, 623);
  const sync = setupScrollSync(kundoku as unknown as HTMLElement, kakikudashi as unknown as HTMLElement);
  return { kundoku, kakikudashi, sync };
}

/** What a re-render does to a panel on its way out — see the tail of
 * `renderKundokuView`/`renderKakikudashiView`. */
function rerenderResetsToStart(...panels: Array<{ scrollTo(o: { left: number }): void }>): void {
  for (const panel of panels) panel.scrollTo({ left: 0 });
}

describe("captureScroll", () => {
  it("puts both panels back where the re-render found them", () => {
    const { kundoku, kakikudashi, sync } = setup();
    kundoku.scrollLeft = -2800;
    kakikudashi.scrollLeft = -1436;

    const restore = sync.captureScroll();
    rerenderResetsToStart(kundoku, kakikudashi);
    expect([kundoku.scrollLeft, kakikudashi.scrollLeft]).toEqual([0, 0]);
    restore();

    expect([kundoku.scrollLeft, kakikudashi.scrollLeft]).toEqual([-2800, -1436]);
  });

  it("restores to a position the sync claims as its own, so neither panel syncs the other", () => {
    const { kundoku, kakikudashi, sync } = setup();
    kundoku.scrollLeft = -2800;
    kakikudashi.scrollLeft = -1436;

    const restore = sync.captureScroll();
    rerenderResetsToStart(kundoku, kakikudashi);
    restore();
    kundoku.fireScroll();
    kakikudashi.fireScroll();

    // A restore read as a user scroll would have each panel dragging the
    // other to it — the panels were already in step, and putting them back
    // is not a scroll anyone performed.
    expect(kundoku.syncsAttempted).toBe(0);
    expect(kakikudashi.syncsAttempted).toBe(0);
    expect([kundoku.scrollLeft, kakikudashi.scrollLeft]).toEqual([-2800, -1436]);
  });

  it("leaves nothing behind that would swallow the next real scroll", () => {
    const { kundoku, kakikudashi, sync } = setup();
    kundoku.scrollLeft = -2800;
    kakikudashi.scrollLeft = -1436;

    const restore = sync.captureScroll();
    rerenderResetsToStart(kundoku, kakikudashi);
    restore();
    kundoku.fireScroll();
    kakikudashi.fireScroll();

    kundoku.scrollLeft = -3400;
    kundoku.fireScroll();
    expect(kundoku.syncsAttempted).toBe(1);
  });

  it("records nothing for a panel the restore does not move", () => {
    // A reader at the very start of the text: the re-render's reset and the
    // restore both write 0 to a panel already at 0, so no 'scroll' event is
    // coming and no entry may be left claiming that position — the stale
    // entry at a panel's own end is what once desynced the panels by 65px.
    const { kundoku, kakikudashi, sync } = setup();

    const restore = sync.captureScroll();
    rerenderResetsToStart(kundoku, kakikudashi);
    restore();

    // The user's own scroll onto 0 must still be seen as theirs.
    kundoku.fireScroll();
    expect(kundoku.syncsAttempted).toBe(1);
  });

  it("clamps a restore the re-render made unreachable", () => {
    // An edit can shorten a panel — a reading dropped, a compound joined —
    // and the position the reader was at is then past its new end.
    const { kundoku, kakikudashi, sync } = setup();
    kundoku.scrollLeft = -5625;
    kakikudashi.scrollLeft = -2589;

    const restore = sync.captureScroll();
    kundoku.scrollWidth = 5000;
    rerenderResetsToStart(kundoku, kakikudashi);
    restore();

    expect(kundoku.scrollLeft).toBe(-(5000 - 623));
    expect(kakikudashi.scrollLeft).toBe(-2589);
    // Clamped or not, the panel still landed where the module recorded, so
    // the event that follows is its own.
    kundoku.fireScroll();
    expect(kundoku.syncsAttempted).toBe(0);
  });
});

/** The geometry the interpolation tests run on, in the two panels' own scroll
 * coordinates (vertical-rl: 0 at the reading start, negative leftward).
 *
 * Four sentences whose starts both panels can reach, a fifth whose start
 * neither can, and the panel ends — the kundoku panel roughly twice the
 * kakikudashi panel's extent, as the 2:1 column pitch in typography.css makes
 * it. The numbers are fabricated, not measured; what they are here for is the
 * shape (differing head insets, differing per-sentence ratios, an unreachable
 * last sentence), since nothing in this file can render a panel. */
const fixture = {
  source: { alignments: [-40, -1200, -2600, -4100, -5900], end: -5625 },
  target: { alignments: [-20, -600, -1300, -2100, -3000], end: -2589 },
};

/** Every position a reader could scroll the source panel to, coarsely. */
function sweep(from: number, to: number, step = 7): number[] {
  const positions: number[] = [];
  for (let x = from; x > to; x -= step) positions.push(x);
  positions.push(to);
  return positions;
}

describe("gapAlignments", () => {
  it("gives the same position whatever the panel is currently scrolled to", () => {
    // The one property the rest depends on: an alignment is a fact about the
    // text, not about where the panel happens to be when it is read. Scrolling
    // 300px further in moves every gap's right edge 300px rightward on screen,
    // and the two cancel — which is what lets `sync` measure a panel a glide
    // is still moving.
    const atRest = gapAlignments(-900, 620, [580, -620, -2000]);
    const mid = gapAlignments(-1200, 620, [880, -320, -1700]);
    expect(mid).toEqual(atRest);
    expect(atRest).toEqual([-940, -2140, -3520]);
  });
});

describe("alignmentKnots", () => {
  it("brackets the sentence starts with 0 and each panel's own end", () => {
    const knots = alignmentKnots(fixture.source, fixture.target);
    expect(knots.source).toEqual([0, -40, -1200, -2600, -4100, -5625]);
    expect(knots.target).toEqual([0, -20, -600, -1300, -2100, -2589]);
  });

  it("drops a trailing sentence neither panel can bring to its reading edge", () => {
    // -5900 and -3000 are past their panels' own ends: the last sentence is
    // shorter than the panel, so there is not enough text behind its start to
    // scroll that start to the reading edge. A knot no reachable position sits
    // at would leave the panel ends corresponding to nothing.
    const knots = alignmentKnots(fixture.source, fixture.target);
    expect(knots.source).not.toContain(-5900);
    expect(knots.target).not.toContain(-3000);
  });

  it("drops it from both lists when only one panel cannot reach it", () => {
    // The kundoku panel renders the same sentence wider, so it can have room
    // to reach a start the kakikudashi panel does not. A knot is a *pair*; one
    // half being unreachable makes the pair useless.
    const knots = alignmentKnots(
      { alignments: [-40, -1200, -2600], end: -5625 },
      { alignments: [-20, -600, -3000], end: -2589 },
    );
    expect(knots.source).toEqual([0, -40, -1200, -5625]);
    expect(knots.target).toEqual([0, -20, -600, -2589]);
  });

  it("keeps a last sentence longer than the panel, whose start is reachable", () => {
    const knots = alignmentKnots(
      { alignments: [-40, -1200], end: -2000 },
      { alignments: [-20, -600], end: -1000 },
    );
    expect(knots.source).toEqual([0, -40, -1200, -2000]);
    expect(knots.target).toEqual([0, -20, -600, -1000]);
  });

  it("flattens a segment rather than inverting one when the rects come out disordered", () => {
    // Geometry read mid-render, which the length guard in `sync` does not
    // catch on its own. An inverted pair of knots would make the mapping run
    // backwards over that stretch, and a goal that runs backwards is the
    // reversal the whole module is arranged to avoid.
    const knots = alignmentKnots(
      { alignments: [-40, -1200, -900], end: -5625 },
      { alignments: [-20, -600, -1300], end: -2589 },
    );
    expect(knots.source).toEqual([0, -40, -1200, -1200, -5625]);
    for (let i = 1; i < knots.source.length; i += 1) {
      expect(knots.source[i]).toBeLessThanOrEqual(knots.source[i - 1]);
    }
  });
});

describe("correspondingPosition", () => {
  const knots = alignmentKnots(fixture.source, fixture.target);
  const at = (position: number) => correspondingPosition(knots.source, knots.target, position);

  it("carries the fraction crossed of a sentence over to the other panel's copy", () => {
    // The whole change. -1900 is halfway through the source's second sentence
    // (-1200 to -2600), so the target sits halfway through its own (-600 to
    // -1300) — not parked at its start until the next sentence takes over,
    // which is what the sentence-quantised mapping did.
    expect(at(-1900).position).toBe(-950);
    expect(at(-1550).position).toBe(-775);
    expect(at(-2250).position).toBe(-1125);
  });

  it("moves the target for every movement of the source", () => {
    // Quantised, `position` was one of six values across the whole text and
    // held constant for a whole sentence at a time. Every step now tells.
    const inside = sweep(-1210, -2590, 10).map((x) => at(x).position);
    for (let i = 1; i < inside.length; i += 1) expect(inside[i]).toBeLessThan(inside[i - 1]);
  });

  it("crosses a sentence boundary without a step", () => {
    // The knot itself, approached from either side. The 0.2px of source
    // either way carries 0.1px of target across it — the local ratio of the
    // two panels' extents there — where the old mapping stood still for the
    // 1400px before it and then moved 700px at once.
    const before = at(-1199.9).position;
    const after = at(-1200.1).position;
    expect(before).toBeCloseTo(-599.95, 6);
    expect(after).toBeCloseTo(-600.05, 6);
  });

  it("puts each panel's own end and start on the other's", () => {
    expect(at(0).position).toBe(0);
    expect(at(fixture.source.end).position).toBe(fixture.target.end);
    // The absolute branches in `sync` take these two exactly; the point here
    // is that the general path agrees with them in the limit, so approaching
    // an end is a glide and not a jump.
    expect(at(fixture.source.end + 1).position).toBeCloseTo(-2588.68, 2);
  });

  it("stretches the head inset, which is not the same in the two panels", () => {
    // 40px of inset against 20px: halfway through the source's is halfway
    // through the target's, not 20px into it.
    expect(at(-20).position).toBe(-10);
    expect(at(-40).position).toBe(-20);
  });

  it("holds the last reachable sentence to its own share of what is left", () => {
    // -5000 is 900px into a 1525px stretch from the last knot to the source's
    // end; the target's counterpart runs 489px from -2100 to -2589.
    expect(at(-5000).position).toBeCloseTo(-2100 - (900 / 1525) * 489, 6);
  });

  it("interpolates a sentence longer than the panel like any other", () => {
    const long = alignmentKnots(
      { alignments: [-40, -1200], end: -2000 },
      { alignments: [-20, -600], end: -1000 },
    );
    expect(correspondingPosition(long.source, long.target, -1600).position).toBe(-800);
  });

  it("takes the start of a sentence the source has no room to cross", () => {
    // Zero extent in the source and 250px of it in the target: there is no
    // fraction to carry over, so the target takes the sentence's start as soon
    // as the source is past the point where it collapsed. The step that
    // remains is that sentence's whole target extent — unavoidable, since the
    // source has no positions to spread it over — but it is still forward.
    const degenerate = { source: [0, -100, -100, -900], target: [0, -50, -300, -450] };
    expect(correspondingPosition(degenerate.source, degenerate.target, -100).position).toBe(-50);
    expect(correspondingPosition(degenerate.source, degenerate.target, -101).position).toBeCloseTo(
      -300.1875,
      4,
    );
    for (const x of sweep(0, -900, 3)) {
      expect(Number.isNaN(correspondingPosition(degenerate.source, degenerate.target, x).position))
        .toBe(false);
    }
  });

  it("never sends the target backwards as the source goes forwards", () => {
    // The property `snapToColumnGrid`'s clamp is built on top of, and which
    // the sentence-quantised mapping had for free by being a step function.
    for (const fixtures of [
      knots,
      { source: [0, -100, -100, -900], target: [0, -50, -300, -450] },
      { source: [0, 0, -900], target: [0, -300, -450] },
    ]) {
      let last = Infinity;
      for (const x of sweep(0, fixtures.source[fixtures.source.length - 1] - 20, 3)) {
        const here = correspondingPosition(fixtures.source, fixtures.target, x).position;
        expect(here).toBeLessThanOrEqual(last);
        last = here;
      }
    }
  });

  it("bounds the column snap by the sentence before the one being read", () => {
    // At a sentence's own start this is exactly what the old caller computed:
    // the previous sentence's extent in the target panel (-600 back to -20).
    expect(at(-1200.1).headroom).toBeCloseTo(580.05, 6);
    // Partway in, the room left behind you in this sentence is added to it —
    // so the snap may still leave the panels at most one sentence adrift,
    // wherever in a sentence the reader has got to.
    expect(at(-1900).headroom).toBe(930);
    expect(at(-2599.9).headroom).toBeCloseTo(1279.95, 6);
    // Nothing precedes the head inset to be adrift of; the snap's own clamp to
    // the panel's range is then the only bound.
    expect(at(-20).headroom).toBe(Infinity);
  });

  it("survives a knot list with nothing in it to interpolate between", () => {
    // `sync` returns before this on a panel with no gaps, but the arithmetic
    // must not produce NaN if it ever does not.
    expect(correspondingPosition([0], [0], -50)).toEqual({ position: 0, headroom: Infinity });
    expect(correspondingPosition([], [], -50)).toEqual({ position: 0, headroom: Infinity });
  });
});
