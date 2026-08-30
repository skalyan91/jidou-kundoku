import { describe, expect, it } from "vitest";
import { opacityForLikelihood } from "../src/render/tokenInspector.ts";

/** The floor `opacityForLikelihood` never goes below — kept here as a
 * literal rather than imported, so that lowering it in the source has to be
 * a deliberate change to these expectations too. It is a legibility
 * decision made by looking at the menu in both themes (see the constant's
 * own doc), and the point of these tests is that nothing quietly erodes it. */
const FLOOR = 0.46;

describe("opacityForLikelihood", () => {
  it("draws a certainty solid", () => {
    expect(opacityForLikelihood(1)).toBe(1);
  });

  it("never draws anything below the legibility floor", () => {
    for (const p of [0, 1e-12, 1e-3, -1, Number.NaN]) {
      expect(opacityForLikelihood(p)).toBe(FLOOR);
    }
  });

  it("stays inside [floor, 1] across the whole range", () => {
    for (let e = 0; e >= -12; e -= 0.25) {
      const opacity = opacityForLikelihood(10 ** e);
      expect(opacity).toBeGreaterThanOrEqual(FLOOR);
      expect(opacity).toBeLessThanOrEqual(1);
    }
  });

  it("rises with likelihood", () => {
    const probabilities = [1e-4, 1e-3, 0.005, 0.02, 0.1, 0.3, 0.7, 1];
    const opacities = probabilities.map(opacityForLikelihood);
    for (let i = 1; i < opacities.length; i++) {
      expect(opacities[i]).toBeGreaterThanOrEqual(opacities[i - 1]);
    }
    // …and not merely by a hair: the range that matters has to be spread
    // out, or the shading says nothing. A linear map would have put every
    // one of the first five within 0.05 of the floor.
    expect(opacities.at(-1)! - opacities[0]).toBeGreaterThan(0.5);
  });

  it("puts the two arcs of 負郭田三百畝、輒半種黍 visibly apart", () => {
    // The parser's own numbers, measured live: the relation it likes best
    // for 三百→田 (an arc it barely wants at all, 0.022 in total) against
    // the one it likes best for 黍→種 (0.997). Both menus are shaded from
    // the same distribution, so the difference between the arcs shows up as
    // the difference between their best options.
    const sanbyakuBest = opacityForLikelihood(0.0131);
    const shoBest = opacityForLikelihood(0.985);
    expect(sanbyakuBest).toBeCloseTo(0.661, 3);
    expect(shoBest).toBeCloseTo(0.999, 3);
    expect(shoBest - sanbyakuBest).toBeGreaterThan(0.3);
  });

  it("shades a genuinely ambiguous tag as a gradient", () => {
    // 半 out of the morphologizer: VERB .786, ADV .204, NOUN .0076, AUX
    // .0023 — four options a reader might actually weigh, and they must not
    // collapse onto one another or onto the floor.
    const [verb, adv, noun, aux] = [0.786, 0.204, 0.00757, 0.00235].map(opacityForLikelihood);
    expect(verb).toBeCloseTo(0.981, 3);
    expect(adv).toBeCloseTo(0.876, 3);
    expect(noun).toBeCloseTo(0.618, 3);
    expect(aux).toBeCloseTo(0.527, 3);
    for (const [lighter, darker] of [
      [adv, verb],
      [noun, adv],
      [aux, noun],
    ]) {
      expect(darker - lighter).toBeGreaterThan(0.05);
    }
  });

  it("gives a tag the model cannot emit the same floor as a vanishing one", () => {
    // ADJ, DET and X are not in the morphologizer's label set at all, so
    // they arrive absent and the caller passes 0. That is a probability,
    // not a gap — and it must land where 1e-9 lands, not above it.
    expect(opacityForLikelihood(0)).toBe(opacityForLikelihood(1e-9));
  });
});
