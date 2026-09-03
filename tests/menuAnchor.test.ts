import { describe, expect, it } from "vitest";
import { menuTopLeftFor } from "../src/render/tokenInspector.ts";

/** Where a context menu's box lands, checked over a grid of menus, anchors and
 * viewports rather than over the three cases anyone thought to open.
 *
 * There is no browser in this suite and no layout in it, which is exactly why
 * `menuTopLeftFor` takes the menu's measured box and the viewport as arguments
 * instead of reading them: everything the placement decides is arithmetic, and
 * the arithmetic is what is under test here. What cannot be tested here is the
 * measurement it is fed — that a menu of 34 relations really does come out at
 * some 471 × 438 — so the sizes below are quoted from the openers' own notes
 * and are the calibration, in the same way `tests/menuRowPadding.test.ts`
 * calibrates its model against three rows read off the open menu.
 *
 * The property that matters is the corner: a menu is `vertical-rl`, so its
 * first category is its rightmost column and its first entry the top of that
 * column, and the point the reader opened the menu from is now that corner. */
const GAP = 4; // `MENU_VIEWPORT_GAP` in tokenInspector.ts

/** Menus, by their measured box. The first is the relation menu as last read
 * off the page (12 columns, 471.1 × 438.2); the second is the same menu a few
 * per cent larger, which is what the padding added to composite rows predicts;
 * the third and fourth stand for the part-of-speech and readings menus, which
 * are far smaller. The last two fit in no viewport here and are only there to
 * pin down what the clamps do when nothing fits. */
const MENUS = [
  { width: 471.1, height: 438.2 },
  { width: 489.9, height: 455.7 },
  { width: 180, height: 220 },
  { width: 64, height: 349.2 },
  { width: 2000, height: 300 },
  { width: 300, height: 2000 },
];

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 800, height: 600 },
  { width: 390, height: 844 },
];

/** Anchors across the whole viewport, the four edges included: a menu is
 * opened wherever the character is, and the characters go right up to the
 * margins. */
const FRACTIONS = [0, 0.01, 0.25, 0.5, 0.75, 0.99, 1];

function* cases() {
  for (const viewport of VIEWPORTS)
    for (const size of MENUS)
      for (const fx of FRACTIONS)
        for (const fy of FRACTIONS) {
          const anchor = { x: viewport.width * fx, y: viewport.height * fy };
          yield { viewport, size, anchor, box: menuTopLeftFor(anchor, size, viewport) };
        }
}

const fitsWidth = (size: { width: number }, viewport: { width: number }) => size.width + GAP <= viewport.width;
const fitsHeight = (size: { height: number }, viewport: { height: number }) => size.height + GAP <= viewport.height;

describe("the corner a context menu hangs from", () => {
  it("puts the menu's top right corner on the anchor wherever there is room for it", () => {
    // The whole of the request, as a property rather than an example: given
    // room on the left and below, the box's right edge is the anchor's x and
    // its top is the anchor's y, to the pixel.
    //
    // "Room" includes the gap at the far edges: an anchor in the last four
    // pixels of the viewport is one the box cannot hang from untouched, since
    // its right edge would then be welded to the window's own.
    for (const { size, anchor, box, viewport } of cases()) {
      const roomLeft = anchor.x - size.width >= 0 && anchor.x <= viewport.width - GAP;
      const roomBelow = anchor.y + size.height + GAP <= viewport.height;
      if (!roomLeft || !roomBelow) continue;
      expect(box.left + size.width).toBeCloseTo(anchor.x, 10);
      expect(box.top).toBeCloseTo(anchor.y, 10);
    }
  });

  it("is not the top left corner it used to be", () => {
    // The old placement was `left = x`, and a menu with room on both sides is
    // exactly where the two answers differ — so this fails the moment the
    // anchor slips back to the far corner of the table.
    const viewport = { width: 1440, height: 900 };
    const size = { width: 471.1, height: 438.2 };
    const box = menuTopLeftFor({ x: 700, y: 200 }, size, viewport);
    expect(box.left).toBeCloseTo(700 - 471.1, 10);
    expect(box.left + size.width).toBeCloseTo(700, 10);
    expect(box.top).toBe(200);
  });
});

describe("the nudge back inside the viewport", () => {
  it("keeps a menu that fits entirely inside the viewport, wherever it was opened", () => {
    for (const { size, viewport, box } of cases()) {
      if (!fitsWidth(size, viewport) || !fitsHeight(size, viewport)) continue;
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.top).toBeGreaterThanOrEqual(0);
      expect(box.left + size.width).toBeLessThanOrEqual(viewport.width - GAP + 1e-9);
      expect(box.top + size.height).toBeLessThanOrEqual(viewport.height - GAP + 1e-9);
    }
  });

  it("moves the box no further than the edge it would have crossed", () => {
    // A nudge is a nudge: where the natural position is already inside, it is
    // returned untouched, and where it is not, the box comes to rest against
    // the edge and no deeper. Anything else would be a menu that jumped away
    // from the character for no reason the reader could see.
    for (const { size, anchor, viewport, box } of cases()) {
      if (!fitsWidth(size, viewport) || !fitsHeight(size, viewport)) continue;
      const natural = { left: anchor.x - size.width, top: anchor.y };
      const clamp = (v: number, hi: number) => Math.min(Math.max(v, 0), hi);
      expect(box.left).toBeCloseTo(clamp(natural.left, viewport.width - size.width - GAP), 10);
      expect(box.top).toBeCloseTo(clamp(natural.top, viewport.height - size.height - GAP), 10);
    }
  });

  it("hangs a menu opened near the left edge from the edge itself", () => {
    // The overflow the new corner introduces, and the one the old placement
    // never had: anchored on the right, a menu wider than the distance to the
    // left margin runs off that side. It comes to rest flush with it — and so
    // does cover the character it was opened from, which is unavoidable in the
    // leftmost columns and is what the old placement did on the right.
    const viewport = { width: 800, height: 600 };
    const size = { width: 471.1, height: 200 };
    const box = menuTopLeftFor({ x: 120, y: 300 }, size, viewport);
    expect(box.left).toBe(0);
    expect(box.left + size.width).toBeGreaterThan(120);
  });

  it("never moves the box back the way the anchor came", () => {
    // Monotone in the anchor: sliding the pointer rightward or downward can
    // only move the menu the same way or leave it be.
    for (const viewport of VIEWPORTS)
      for (const size of MENUS)
        for (let i = 1; i < FRACTIONS.length; i += 1) {
          const before = FRACTIONS[i - 1];
          const after = FRACTIONS[i];
          const at = (f: number) =>
            menuTopLeftFor({ x: viewport.width * f, y: viewport.height * f }, size, viewport);
          expect(at(after).left).toBeGreaterThanOrEqual(at(before).left - 1e-9);
          expect(at(after).top).toBeGreaterThanOrEqual(at(before).top - 1e-9);
        }
  });

  it("sacrifices the far end of a menu that fits on neither side", () => {
    // Nothing in the present inventories comes near this — the widest menu is
    // some 471px and `sizeMenuSquarish` caps the height at 0.88 of the
    // viewport — but the order of the clamps decides which end of an oversized
    // menu is the one left on screen, and the answer is the end the reading
    // starts at: the rightmost column, and the top of every column.
    const viewport = { width: 800, height: 600 };
    const wide = menuTopLeftFor({ x: 400, y: 100 }, { width: 2000, height: 300 }, viewport);
    expect(wide.left + 2000).toBe(viewport.width - GAP);
    const tall = menuTopLeftFor({ x: 400, y: 100 }, { width: 300, height: 2000 }, viewport);
    expect(tall.top).toBe(0);
  });
});
