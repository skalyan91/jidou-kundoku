import { describe, expect, it } from "vitest";
import { squarestMenuPlan, type MenuAtom, type MenuBox } from "../src/render/tokenInspector.ts";

/** **How a menu is squared**, over plain numbers — `squarestMenuPlan` is the
 * whole of the decision `sizeMenuSquarish` makes, and the page only measures
 * what it is handed and writes what it answers.
 *
 * The figures are the menu's own, as measured in the browser at 1292×792: a
 * 30px lane, a 10px gutter between columns and between categories, 12px of
 * box across the run and 15.6 along it. The eleven atoms of
 * the 品詞 menu are the heading bound to 名詞 (120) and then the entries at
 * three or four cells (60 or 80). */

const LANE = 30;
const BOX: MenuBox = {
  columnGap: 10,
  groupGap: 10,
  itemGap: 0,
  extraAlong: 15.6,
  extraAcross: 12,
  ceiling: 600,
  maxWidth: 1284,
};
const atoms = (alongs: number[]): MenuAtom[] => alongs.map((along) => ({ along, across: LANE }));
const POS = atoms([120, 80, 60, 80, 60, 60, 80, 60, 80, 60, 80]);

describe("squarestMenuPlan", () => {
  it("picks the column count whose box is nearest square", () => {
    // Six columns (cap 140) are 242 × 155.6, 1.56 wide; four (cap 220) are
    // 162 × 235.6, 0.69. Five, at the 200 their tallest column fills, are
    // 202 × 215.6 — 0.94, the nearest of the three. The loop this replaced
    // could stop at six, which is the 1.54 the reader saw.
    const plan = squarestMenuPlan([POS], BOX);
    expect(plan.columns).toBe(5);
    expect(plan.cap).toBe(200);
    expect(plan.width).toBe(202);
    expect(plan.height).toBeCloseTo(215.6, 6);
  });

  it("squares the border box, not the content box", () => {
    // Some 45px more of box along the run (a deeper padding — the menus once
    // had a two-row gloss line there) and the same eleven entries square up
    // better in six columns than in five (1.21 against 0.78): the box counts
    // in the score as the reader sees it, not only the table inside it.
    const plan = squarestMenuPlan([POS], { ...BOX, extraAlong: 60.28 });
    expect(plan.columns).toBe(6);
    expect(plan.width / plan.height).toBeCloseTo(1.21, 2);
  });

  it("starts every category on a column of its own", () => {
    // Two categories of one short entry each can never share a column, so
    // the plan is two columns whatever the cap.
    const plan = squarestMenuPlan([atoms([60]), atoms([60])], BOX);
    expect(plan.columns).toBe(2);
    expect(plan.width).toBe(2 * LANE + BOX.groupGap + BOX.extraAcross);
  });

  it("never caps under the tallest atom, nor over the viewport's ceiling", () => {
    const tall = squarestMenuPlan([atoms([360, 60, 60])], BOX);
    expect(tall.cap).toBeGreaterThanOrEqual(360);
    // A long single category under a low ceiling: whatever is squarest, the
    // cap stays at or under the ceiling, and every column holds what it can.
    const long = atoms(Array.from({ length: 40 }, () => 60));
    const low = squarestMenuPlan([long], { ...BOX, ceiling: 180 });
    expect(low.cap).toBeLessThanOrEqual(180);
    expect(low.columns).toBe(Math.ceil(40 / 3));
  });

  it("scores the box with the column ends trimmed, and wraps on whole atoms", () => {
    // `markColumnEnds` takes 二分 off the head of every column and off the
    // foot of the tallest, so the box the reader sees is 20px shorter than the
    // run the wrap packs. The wrap is unchanged — the same five columns at the
    // same cap — and only the height, which is what is scored, comes down.
    const trimmed = POS.map((atom) => ({ ...atom, head: 10, foot: 10 }));
    const plan = squarestMenuPlan([trimmed], BOX);
    expect(plan.columns).toBe(5);
    expect(plan.cap).toBe(200);
    expect(plan.height).toBeCloseTo(195.6, 6);
    // A column shorter than the tallest keeps its foot: it ends above the
    // foot of the table, so trimming it would change nothing seen. Two
    // categories, the taller one setting the box: 120 less its head and foot.
    const two = squarestMenuPlan(
      [
        [{ along: 120, across: LANE, head: 10, foot: 10 }],
        [{ along: 60, across: LANE, head: 10, foot: 10 }],
      ],
      BOX,
    );
    expect(two.height).toBeCloseTo(100 + BOX.extraAlong, 6);
  });

  it("prefers a box that fits the window to a squarer one that does not", () => {
    const long = atoms(Array.from({ length: 40 }, () => 60));
    const free = squarestMenuPlan([long], BOX);
    const narrow = squarestMenuPlan([long], { ...BOX, maxWidth: free.width - 1 });
    expect(narrow.width).toBeLessThanOrEqual(free.width - 1);
  });
});
