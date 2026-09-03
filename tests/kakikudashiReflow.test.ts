import { describe, expect, it } from "vitest";
import { planKakikudashiReflow, type ReflowStep, type TokenBox } from "../src/render/KakikudashiView.ts";

// ---------------------------------------------------------------------------
// How the 書き下し文 panel settles after a redraw.
//
// The panel is running prose set `vertical-rl`, and a redraw that lengthens
// the text moves nearly every word in it — on 酒蟲's 連用形-て flip, 331 of
// 340 spans, by 1 to 29 characters. `animateKakikudashiReflow` does not treat
// those alike: a word still in the column it was in was *pushed along* that
// column and is walked there, while a word that has ended up in a different
// column was re-wrapped and is faded in where it now is, because it never
// travelled and animating a diagonal would show a path the layout did not
// take.
//
// That whole decision is `planKakikudashiReflow`, a pure function of two sets
// of rectangles, precisely so that it can be checked without a layout engine.
// What cannot be checked here is the *rectangles* — that a column really is a
// fixed screen x, that a wrapped span really reports two client rects. Those
// are claims about a browser, and they are what the walk rests on.
//
// The half-pixel threshold, the column pitch and the panel's own geometry are
// all named where they are decided; the numbers below are chosen to sit
// clearly either side of them (a kakikudashi column is 44px across, so a
// horizontal difference is either nothing or a whole column).
// ---------------------------------------------------------------------------

/** One span's rectangle. Defaults to a single fragment, which every span in
 * the panel but a wrapped one is. */
const box = (left: number, top: number, fragments = 1): TokenBox => ({ left, top, fragments });

const plan = (before: Record<string, TokenBox>, after: Record<string, TokenBox>): ReflowStep[] =>
  planKakikudashiReflow(new Map(Object.entries(before)), new Map(Object.entries(after)));

describe("what a redraw asks of each word", () => {
  it("leaves a word that did not move alone", () => {
    expect(plan({ "0:3:0": box(400, 120) }, { "0:3:0": box(400, 120) })).toEqual([]);
  });

  it("ignores a difference too small to see", () => {
    // Sub-pixel drift is not a movement, and a word that did not move must not
    // stir while the words around it are travelling.
    expect(plan({ "0:3:0": box(400, 120) }, { "0:3:0": box(400.3, 120.4) })).toEqual([]);
  });

  it("walks a word pushed further down its own column", () => {
    // 101px is the median walk the harness estimates for the 連用形-て flip:
    // four characters of inserted text at this panel's 25.3px advance.
    expect(plan({ "0:3:0": box(400, 120) }, { "0:3:0": box(400, 221) })).toEqual([
      { key: "0:3:0", kind: "walk", dx: 0, dy: -101 },
    ]);
  });

  it("walks a word pulled back up its column when text is removed", () => {
    // Turning the switch *off* is a redraw too, and shortens the text. The old
    // behaviour animated nothing at all here.
    expect(plan({ "0:3:0": box(400, 221) }, { "0:3:0": box(400, 120) })).toEqual([
      { key: "0:3:0", kind: "walk", dx: 0, dy: 101 },
    ]);
  });

  it("fades in a word that has been re-wrapped onto the next column", () => {
    // Foot of one column to head of the next: under `vertical-rl` the next
    // column is one pitch to the *left*. Nothing travelled — the line ran out.
    expect(plan({ "0:3:0": box(400, 700) }, { "0:3:0": box(356, 40) })).toEqual([{ key: "0:3:0", kind: "fade" }]);
  });

  it("fades a re-wrapped word even where it happens to land at the same height", () => {
    // The column is the whole of the test; a word at the same place down two
    // different columns is not a word that stayed still.
    expect(plan({ "0:3:0": box(400, 120) }, { "0:3:0": box(356, 120) })).toEqual([{ key: "0:3:0", kind: "fade" }]);
  });

  it("fades a word the redraw wrote for the first time", () => {
    expect(plan({}, { "0:9:0": box(400, 120) })).toEqual([{ key: "0:9:0", kind: "fade" }]);
  });

  it("says nothing about a word the redraw unwrote", () => {
    // Its node went with the redraw. Fading it out would mean holding a copy
    // of it in the finished page, and every other reader of this DOM — the
    // print clone, the inspector's highlight — would then have to be told to
    // ignore prose the tree does not have.
    expect(plan({ "0:3:0": box(400, 120) }, {})).toEqual([]);
  });

  it("declines to walk a word that is broken across a column boundary", () => {
    // A relative offset moves every fragment of an inline box together, so
    // pulling the first one down its column would drag the second one down the
    // next column, where nothing moved.
    expect(plan({ "0:3:0": box(400, 700, 2) }, { "0:3:0": box(400, 660, 2) })).toEqual([
      { key: "0:3:0", kind: "fade" },
    ]);
    expect(plan({ "0:3:0": box(400, 700) }, { "0:3:0": box(400, 660, 2) })).toEqual([{ key: "0:3:0", kind: "fade" }]);
    expect(plan({ "0:3:0": box(400, 700, 2) }, { "0:3:0": box(400, 660) })).toEqual([{ key: "0:3:0", kind: "fade" }]);
  });

  it("still leaves an unmoved wrapped word alone", () => {
    expect(plan({ "0:3:0": box(400, 700, 2) }, { "0:3:0": box(400, 700, 2) })).toEqual([]);
  });
});

describe("the key is what survives a redraw", () => {
  it("tells one token's several spans apart", () => {
    // A glossed word is written as a base inside the <ruby> and a tail after
    // it, both carrying the same token id — so the count is what separates
    // them, and the two can be asked to do different things.
    const before = { "0:3:0": box(400, 120), "0:3:1": box(400, 145) };
    const after = { "0:3:0": box(400, 170), "0:3:1": box(356, 40) };
    expect(plan(before, after)).toEqual([
      { key: "0:3:0", kind: "walk", dx: 0, dy: -50 },
      { key: "0:3:1", kind: "fade" },
    ]);
  });

  it("keeps two sentences' token 3 apart", () => {
    // Token ids are unique only within a sentence.
    const before = { "0:3:0": box(400, 120), "1:3:0": box(200, 120) };
    const after = { "0:3:0": box(400, 120), "1:3:0": box(200, 170) };
    expect(plan(before, after)).toEqual([{ key: "1:3:0", kind: "walk", dx: 0, dy: -50 }]);
  });
});

describe("a whole redraw at once", () => {
  it("splits a run of words at the column that ran out", () => {
    // The shape of the real thing: text inserted above a column pushes the
    // words below it along, the one that no longer fits is set again at the
    // head of the next column, and the word already in *that* column is
    // pushed down it in turn. The panel shows exactly that — two runs sliding
    // down their own columns, and the one word that changed column arriving.
    const before = {
      "0:1:0": box(400, 100),
      "0:2:0": box(400, 300),
      "0:3:0": box(400, 500),
      "0:4:0": box(400, 700),
      "0:5:0": box(356, 100),
    };
    const after = {
      "0:1:0": box(400, 100),
      "0:2:0": box(400, 350),
      "0:3:0": box(400, 550),
      "0:4:0": box(356, 100),
      "0:5:0": box(356, 300),
    };
    expect(plan(before, after)).toEqual([
      { key: "0:2:0", kind: "walk", dx: 0, dy: -50 },
      { key: "0:3:0", kind: "walk", dx: 0, dy: -50 },
      { key: "0:4:0", kind: "fade" },
      { key: "0:5:0", kind: "walk", dx: 0, dy: -200 },
    ]);
  });

  it("caps a walk at the column, without a cap", () => {
    // The one thing a numeric limit on the travel would have bought, bought by
    // the classifier instead: a word can only be walked while it is still in
    // the column it was in, so no walk is longer than a column. The 353px here
    // is a whole column's worth and is walked; the same word pushed one pixel
    // further would have wrapped, and would be faded by the rule above rather
    // than by a threshold anyone has to choose.
    expect(plan({ "0:3:0": box(400, 40) }, { "0:3:0": box(400, 393) })).toEqual([
      { key: "0:3:0", kind: "walk", dx: 0, dy: -353 },
    ]);
  });
});
