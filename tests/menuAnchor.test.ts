import { describe, expect, it } from "vitest";
import { MENU_JOIN_GAP, menuAnchorFor, menuTopLeftFor } from "../src/render/tokenInspector.ts";

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

describe("menuAnchorFor", () => {
  /** A category pill, and the deprel label beside the same character. */
  const pill = { top: 100, right: 260, bottom: 124, left: 200 };
  const label = { top: 140, right: 320, bottom: 260, left: 300 };

  /** ── What changed, and what did not ──────────────────────────────────────
   * These assertions used to read `y: pill.bottom` and `x: label.left` — the
   * joins flush, with the menu's border sharing a pixel with the mark's. The
   * reader's correction was *"I didn't mean subjoin/left join with zero space!
   * Use the same amount of space as between the head box and the deprel
   * label"*, so both joins now stand off by `MENU_JOIN_GAP`, which is 6px and
   * is `--head-box-reach` in kunten.css (`--head-box-offset` 4px plus
   * `--head-box-casing` 2px, the `--head-box-stroke` being drawn inward from
   * the offset and adding nothing). The derivation is at the constant.
   *
   * What did *not* change is the axis, and that is asserted separately below
   * rather than folded into the coordinates: a subjoined menu keeps its right
   * edge flush with the pill's and moves only down, which is what the tab
   * strip needs (`openMenuKind` — switching tabs must not move the panel's
   * top); a left-joined menu keeps its top level with the label's and moves
   * only left. The gap is imported rather than written as 6 so that changing
   * the standoff is one edit and these stay true; the *shape* of the join is
   * what is pinned here, and it is pinned as two facts about each kind. */
  it("subjoins a category menu to its pill, standing off by the gap", () => {
    // The reader's rule for the horizontal marks: the menu hangs straight down
    // from the pill it is about. `menuTopLeftFor` anchors the box's top *right*
    // corner, so the point to give it is the pill's bottom right — that puts
    // the menu's top edge below the pill's bottom edge with their right edges
    // flush, which is what "subjoined" means.
    for (const kind of ["pos", "domain", "sense"] as const) {
      expect(menuAnchorFor(kind, pill), kind).toEqual({ x: pill.right, y: pill.bottom + MENU_JOIN_GAP });
    }
    // Stated as the join rather than as the coordinates: with a viewport that
    // does not clamp, the placed box hangs the gap below the pill and its
    // right edge meets the pill's exactly.
    const size = { width: 180, height: 200 };
    const placed = menuTopLeftFor(menuAnchorFor("pos", pill), size, { width: 2000, height: 2000 });
    expect(placed.top).toBe(pill.bottom + MENU_JOIN_GAP);
    expect(placed.left + size.width).toBe(pill.right);
  });

  it("left-joins the relation menu to its label, standing off by the gap", () => {
    // The vertical mark takes the other edge: the menu's right edge the gap
    // clear of the label's left, tops level, growing away to the left — which
    // is the direction a `vertical-rl` table grows anyway.
    expect(menuAnchorFor("dep", label)).toEqual({ x: label.left - MENU_JOIN_GAP, y: label.top });
    const size = { width: 180, height: 200 };
    const placed = menuTopLeftFor(menuAnchorFor("dep", label), size, { width: 2000, height: 2000 });
    expect(placed.top).toBe(label.top);
    expect(placed.left + size.width).toBe(label.left - MENU_JOIN_GAP);
  });

  it("moves each join along its own axis only", () => {
    // The property behind the two cases above, over both marks: compared with
    // a flush join (the gap passed explicitly as 0, which is what the function
    // used to do), a subjoined menu has moved on `y` and not on `x`, and a
    // left-joined one on `x` and not on `y`. A gap that leaked into the other
    // axis would push each menu diagonally off its mark and, for the three
    // tabs, would break the promise that switching tabs moves only the panel's
    // far edge.
    for (const kind of ["pos", "domain", "sense"] as const) {
      const flush = menuAnchorFor(kind, pill, 0);
      const stood = menuAnchorFor(kind, pill);
      expect(stood.x, kind).toBe(flush.x);
      expect(stood.y - flush.y, kind).toBe(MENU_JOIN_GAP);
    }
    const flushDep = menuAnchorFor("dep", label, 0);
    const stoodDep = menuAnchorFor("dep", label);
    expect(stoodDep.y).toBe(flushDep.y);
    expect(flushDep.x - stoodDep.x).toBe(MENU_JOIN_GAP);
  });

  it("stands the three tabs off by the same distance, so the panel's top does not move", () => {
    // The tab strip's own guarantee, restated against the gap: the three pills
    // share a row and so share a bottom edge, and every one of them adds the
    // same standoff to it — so switching tabs still leaves the menu's top
    // exactly where it was and moves only its right edge.
    const others = [
      { top: 100, right: 330, bottom: 124, left: 262 },
      { top: 100, right: 400, bottom: 124, left: 332 },
    ];
    const tops = [pill, ...others].map((mark) => menuAnchorFor("pos", mark).y);
    expect(new Set(tops).size).toBe(1);
    expect(tops[0]).toBe(pill.bottom + MENU_JOIN_GAP);
  });

  it("gives way to the viewport rather than to the join", () => {
    // A join near an edge is not worth going off screen for. The clamp in
    // `menuTopLeftFor` still applies to the anchor this function returns, so a
    // clamped menu is no longer flush — and that is the right order of
    // priority, since a menu half off the screen cannot be read at all.
    const atEdge = { top: 10, right: 60, bottom: 34, left: 10 };
    const size = { width: 180, height: 200 };
    const placed = menuTopLeftFor(menuAnchorFor("pos", atEdge), size, { width: 800, height: 600 });
    expect(placed.left).toBe(0); // clamped, so not flush with the pill's right edge
    expect(placed.left + size.width).not.toBe(atEdge.right);
  });
});
