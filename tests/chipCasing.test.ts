import { describe, expect, it } from "vitest";
import { obstacleFor, type Extent } from "../src/render/tokenInspector.ts";

/** The joint casing, on the one part of it that is arithmetic.
 *
 * There is no browser in this suite, so what the casing *looks* like — that
 * no cream edge falls between the arc and the chip it runs into — cannot be
 * tested here; that property is a paint-order argument and it is made in
 * `caseApparatus` and at `.token-casing-layer` in kunten.css. What can be
 * tested is the consequence the casing has for the readings, which is the
 * one thing the change was at risk of quietly altering: `decollideOverlay`
 * treats the chip as an obstacle with a box and a buffer, and casing the
 * chip moves both.
 *
 * ── The two chips that come and go ──────────────────────────────────────
 * The domain and the sense are drawn hidden and slide out on hover, and none
 * of the arithmetic below changes for that — a rect is a rect on a border box.
 * What changes is *when* there is a rect at all, and it is worth recording
 * where the casing is tested:
 *
 *   - a semantic pill is cased only while it is out. Hidden, it is parked a
 *     slide's width to the left of where it belongs, so a rect on its box then
 *     would be a halo for a position the pill never occupies once it is
 *     visible — and a halo is page colour, which on the text reads as a bar
 *     with nothing drawn on it.
 *   - the casing therefore runs more than once per analysis. `redecollide`
 *     re-runs the decollision when the pills come out and again when they go
 *     back, and re-draws this layer at the boxes the marks ended up at, since
 *     a mark that moves afterwards would otherwise leave its halo behind.
 *   - a hidden pill is at `opacity: 0`, so `decollideOverlay` drops it from
 *     the obstacle list and no reading is lifted for ink that is not there.
 *
 * All three are arrangements rather than arithmetic; what can be pinned of
 * them is pinned in tests/inspectorLayout.test.ts, off the stylesheet. None of
 * it can be seen from here.
 *
 * The reach is 2px on the page — half of `.token-chip-casing`'s 4px stroke,
 * which is `.token-arrow-path-casing`'s 2px-per-side halo said for a filled
 * shape instead of a line. It is a literal here rather than an import for
 * the reason `tests/menuShading.test.ts` keeps its floor: changing it in the
 * stylesheet should have to be a deliberate change to these expectations
 * too. */
const REACH = 2;

/** A chip, in the coordinates `decollideOverlay` works in (viewport pixels,
 * y down). The numbers are a part-of-speech chip written *below* a glyph, at
 * the sizes the panel actually produces: 28.3px deep, which is the depth
 * `.reading-steps-up` in kunten.css quotes from 酒蟲, and 0.25rem = 4px off
 * the glyph's foot, which is `.token-subtitle-below`'s margin. */
const CHIP: Extent = { top: 400, right: 566, bottom: 428.3, left: 506 };
const MARGIN = 4;

/** What `decollideOverlay` computes for a run: the depth its foot reaches
 * past the obstacle's top, plus the obstacle's buffer. Copied here rather
 * than imported because it lives inside a closure that needs a document —
 * the point of the copy is that these two lines are all the casing can
 * affect. */
function lift(runBottom: number, obstacle: { box: Extent; buffer: number }): number {
  return runBottom - obstacle.box.top + obstacle.buffer;
}

describe("casing a chip does not move any reading further", () => {
  it("leaves the lift the length it was, at every depth of overlap", () => {
    for (let runBottom = CHIP.top; runBottom <= CHIP.bottom; runBottom += 1.7) {
      const uncased = lift(runBottom, obstacleFor(CHIP, MARGIN, 0));
      const cased = lift(runBottom, obstacleFor(CHIP, MARGIN, REACH));
      expect(cased).toBeCloseTo(uncased, 10);
    }
  });

  it("leaves it unchanged whatever the reach turns out to be", () => {
    // The reach is read off the stylesheet at draw time, so the cancellation
    // must not depend on its being 2: it is the *same* number added to the
    // box's top and taken off the buffer, and that is why it cancels.
    for (const reach of [0, 0.5, 2, 3, 7.25]) {
      expect(lift(420, obstacleFor(CHIP, MARGIN, reach))).toBeCloseTo(lift(420, obstacleFor(CHIP, MARGIN, 0)), 10);
    }
  });

  it("still ends a run exactly where the chip stands off its own character", () => {
    // The mirroring `markBuffer` argues for: lifted by its overlap plus the
    // buffer, a run's foot lands on the glyph's foot — which is the chip's
    // border-box top less the margin the chip keeps there. Casing the chip
    // spends 2px of that margin and grows the box by 2px, and the run ends
    // in the same place.
    const glyphFoot = CHIP.top - MARGIN;
    const runBottom = 420;
    expect(runBottom - lift(runBottom, obstacleFor(CHIP, MARGIN, REACH))).toBeCloseTo(glyphFoot, 10);
  });
});

describe("casing a chip widens what it catches", () => {
  it("grows the obstacle by the reach on all four sides", () => {
    const { box } = obstacleFor(CHIP, MARGIN, REACH);
    expect(box.top).toBeCloseTo(CHIP.top - REACH, 10);
    expect(box.bottom).toBeCloseTo(CHIP.bottom + REACH, 10);
    expect(box.left).toBeCloseTo(CHIP.left - REACH, 10);
    expect(box.right).toBeCloseTo(CHIP.right + REACH, 10);
  });

  it("catches a run that cleared the pill's border but not its casing", () => {
    // A run whose foot stops 1px above the chip's border: no collision
    // before, and the casing paints over the last 1px of it. The lift it now
    // asks for is small — the 2 to 4px `obstacleFor` predicts — and it is
    // upward, which is the only direction `decollideOverlay` can go.
    const runBottom = CHIP.top - 1;
    const cased = obstacleFor(CHIP, MARGIN, REACH);
    expect(runBottom).toBeLessThan(CHIP.top); // no overlap with the border box
    expect(runBottom).toBeGreaterThan(cased.box.top); // but inside the casing
    const needed = lift(runBottom, cased);
    expect(needed).toBeGreaterThan(0);
    expect(needed).toBeCloseTo(3, 10);
    expect(needed).toBeLessThan(2 * REACH);
  });

  it("still leaves a run well clear of the chip alone", () => {
    // Nothing is caught that the casing does not reach: a run a whole kana
    // above the chip is untouched, cased or not.
    const runBottom = CHIP.top - 14.666;
    const cased = obstacleFor(CHIP, MARGIN, REACH);
    expect(runBottom).toBeLessThan(cased.box.top);
  });
});
