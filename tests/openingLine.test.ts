import { describe, expect, it } from "vitest";
import { planOpeningLine } from "../src/render/KakikudashiView.ts";

describe("planOpeningLine", () => {
  it("centres a one-column heading under one kundoku column, half a column in", () => {
    // Two prose columns under the kanbun, one taken: half a column of spare on
    // each side, which only a shift can give; the paragraph starts at column 2.
    expect(planOpeningLine(1, 2, 1)).toEqual({ before: 0, halfShift: true, after: 1 });
  });

  it("sets a heading that fills its room flush, with nothing to pad", () => {
    expect(planOpeningLine(1, 2, 2)).toEqual({ before: 0, halfShift: false, after: 0 });
  });

  it("starts the paragraph at the column its kanbun starts in", () => {
    for (const [columns, width] of [[2, 1], [2, 3], [3, 2], [3, 5]]) {
      const plan = planOpeningLine(columns, 2, width)!;
      expect(plan.before + width + plan.after).toBe(columns * 2);
      expect(plan.before * 2 + (plan.halfShift ? 1 : 0)).toBe(columns * 2 - width);
    }
  });

  it("declines a heading longer than the room under its kanbun", () => {
    expect(planOpeningLine(1, 2, 3)).toBeNull();
    expect(planOpeningLine(0, 2, 1)).toBeNull();
  });
});
