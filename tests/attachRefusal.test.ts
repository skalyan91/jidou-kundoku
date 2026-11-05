import { describe, expect, it } from "vitest";
import { refusalNoteOrigin } from "../src/render/tokenInspector.ts";

/** Where the note a refused drop leaves is placed (`showAttachRefusal`): beside
 * the release point or the candidate, below and to its right, flipped when that
 * would run off the viewport, and pinned to the margin when nothing fits. */
describe("refusalNoteOrigin: placing the note a refused drop leaves", () => {
  const viewport = { width: 1000, height: 800 };
  const size = { width: 300, height: 60 };
  const point = (x: number, y: number) => ({ left: x, right: x, top: y, bottom: y });

  it("sits below and to the right of the release point", () => {
    expect(refusalNoteOrigin(point(100, 100), size, viewport)).toEqual({ left: 112, top: 112 });
  });

  it("clears the whole of a candidate, not just its corner", () => {
    const glyph = { left: 100, right: 144, top: 200, bottom: 244 };
    expect(refusalNoteOrigin(glyph, size, viewport)).toEqual({ left: 156, top: 256 });
  });

  it("flips to the left of the anchor near the right edge", () => {
    expect(refusalNoteOrigin(point(900, 100), size, viewport)).toEqual({ left: 588, top: 112 });
  });

  it("flips above the anchor near the foot", () => {
    expect(refusalNoteOrigin(point(100, 780), size, viewport)).toEqual({ left: 112, top: 708 });
  });

  it("is pinned inside the margin when it fits on neither side", () => {
    const narrow = { width: 320, height: 800 };
    expect(refusalNoteOrigin(point(160, 100), size, narrow)).toEqual({ left: 8, top: 112 });
  });
});
