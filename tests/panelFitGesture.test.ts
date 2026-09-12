import { afterEach, describe, expect, it } from "vitest";
import {
  holdPanelMeasures,
  observePanelFit,
  releasePanelMeasures,
  resumePanelFit,
  suspendPanelFit,
} from "../src/render/KakikudashiView.ts";

// ---------------------------------------------------------------------------
// **What a rail may and may not do to the page while it is moving.**
//
// Two things go wrong when a panel changes size over 260ms, and they are
// different things with one symptom:
//
//  - **The fit runs on every frame.** `observePanelFit` watches `.main`, and a
//    sidebar collapsing changes `.main`'s own width sixteen times over one
//    gesture. Each firing is `fitPassageExtent`: up to seven candidate splits,
//    each a write to the grid followed by a read of it — a forced synchronous
//    layout of the whole page — each preceded by a hanging-marks pass over the
//    whole prose. Of the order of ten forced layouts per frame. And the answer
//    it arrives at cannot change, since nothing the fit reasons from is a
//    width: it re-derives the same split sixteen times and writes it back
//    sixteen times.
//
//  - **The text re-breaks on the way.** The prose panel's rail sweeps `.main`'s
//    rows, and text does not sweep — it is set again at every height the sweep
//    passes through that changes how many characters a column holds. Four
//    times over one gesture for the kundoku passage at a 900px window, and on
//    every frame for a prose panel left on its whole share.
//
// The first is answered by suspending the fit for the length of the gesture
// and paying once at the end; the second by holding each passage at the
// measure it already has and putting the declaration back when the movement
// stops. Both are checked here, and both without a document: the gate is a
// state machine, and the hold is bookkeeping over one CSS property.
//
// What cannot be checked from here is the thing a browser would show — that a
// held panel *looks* the same on its way out. See the verification plan.
// ---------------------------------------------------------------------------

/** Everything `holdPanelMeasures` and `releasePanelMeasures` ask of a box, in
 * the manner of `tests/kakikudashiPanelClear.test.ts` and for the same reason:
 * the tests run in node, and between them the two functions touch a `height`
 * field, `removeProperty`, and one rectangle. */
function fakeBox(used: number, declared = "") {
  const box = {
    style: {
      height: declared,
      removeProperty(name: string) {
        if (name === "height") box.style.height = "";
      },
    },
    getBoundingClientRect: () => ({ height: used }),
  };
  return box;
}

const asBoxes = (...boxes: ReturnType<typeof fakeBox>[]) => boxes as unknown as HTMLElement[];

afterEach(() => {
  // The hold is module state and the gate is module state; a test that left
  // either set would pin the next test's boxes or swallow its fits.
  releasePanelMeasures();
  resumePanelFit();
});

describe("holding the measure through a gesture", () => {
  it("pins each box at the height it is set to", () => {
    // The kundoku panel declares no height of its own — `round(down, 100%,
    // --kanji-advance)` in tategaki.css is what gives it one — so the pin is
    // what stops the sweep re-breaking its columns under it.
    const kundoku = fakeBox(440);
    holdPanelMeasures(asBoxes(kundoku));
    expect(kundoku.style.height).toBe("440px");
  });

  it("puts back a height the fit had written, to the character", () => {
    // The prose panel's inline height is the fine half of `fitPassageExtent`'s
    // answer — the column length that makes the two passages end together. A
    // release that removed the property instead of restoring it would throw
    // that answer away the first time a reader shut the panel, and the panel
    // would come back set to whatever its whole share happened to be.
    const prose = fakeBox(248.6, "253px");
    holdPanelMeasures(asBoxes(prose));
    expect(prose.style.height).toBe("248.6px");
    releasePanelMeasures();
    expect(prose.style.height).toBe("253px");
  });

  it("puts back *nothing* where nothing was declared", () => {
    // Not `height: ""` written over the element, and not the pin left standing:
    // the box has to go back to taking its height from the stylesheet, or the
    // kundoku column would keep the quantum it had before the gesture forever.
    const kundoku = fakeBox(440);
    holdPanelMeasures(asBoxes(kundoku));
    releasePanelMeasures();
    expect(kundoku.style.height).toBe("");
  });

  it("round-trips both panels together", () => {
    const kundoku = fakeBox(440);
    const prose = fakeBox(248.6, "253px");
    holdPanelMeasures(asBoxes(kundoku, prose));
    expect([kundoku.style.height, prose.style.height]).toEqual(["440px", "248.6px"]);
    releasePanelMeasures();
    expect([kundoku.style.height, prose.style.height]).toEqual(["", "253px"]);
  });

  it("keeps the first hold when a second rail is clicked mid-gesture", () => {
    // The three rails share one licence and one timer, so a second click is
    // the same gesture running on. Recording again would record the *pin* as
    // the declaration, and the release would then leave the panel pinned at a
    // height chosen for the layout before the gesture began — permanently.
    const prose = fakeBox(248.6, "253px");
    holdPanelMeasures(asBoxes(prose));
    holdPanelMeasures(asBoxes(prose));
    releasePanelMeasures();
    expect(prose.style.height).toBe("253px");
  });

  it("releases nothing when nothing is held", () => {
    const prose = fakeBox(248.6, "253px");
    releasePanelMeasures();
    expect(prose.style.height).toBe("253px");
  });
});

// ---------------------------------------------------------------------------

/** A `ResizeObserver` that does nothing but hand back its callback, so a test
 * can fire "the panel resized" as many times as a transition would.
 *
 * Takes no argument: `observePanelFit` now re-measures its target with
 * `getBoundingClientRect()` on every firing rather than reading a size off
 * the callback's own entries (see there for why), so what makes a firing
 * "a resize" from this stub's point of view is that `countingPanel`'s own
 * `getBoundingClientRect` answers something new *before* `fire` is called,
 * not anything passed to `fire` itself. */
function stubResizeObserver(): { fire: () => void } {
  let callback: (() => void) | undefined;
  class Stub {
    constructor(cb: () => void) {
      callback = cb;
    }
    observe() {}
    disconnect() {}
  }
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = Stub;
  return { fire: () => callback?.() };
}

/** A stand-in panel that counts the fits run against it, and answers a box a
 * test can move.
 *
 * `refitPanel` asks the container for its column and returns at once when
 * there is none, so a container whose `querySelector` answers `null` is a fit
 * that costs nothing — and the count of times it was asked is the count of
 * fits. That is the probe, stated plainly because it is indirect: what is
 * being counted is entries into the fit, which is exactly the quantity the
 * chop is made of.
 *
 * `getBoundingClientRect` answers `rect`, mutable after construction — the
 * width `resizeTo` below writes to it is what `observePanelFit` reads, both
 * to seed itself and on every firing that follows, so a test says "the panel
 * resized" by changing this before it fires the stub, and "the panel did not"
 * by leaving it alone. */
function countingPanel() {
  const panel = {
    fits: 0,
    rect: { width: 0, height: 0 },
    querySelector() {
      panel.fits++;
      return null;
    },
    closest: () => null,
    parentElement: null,
    getBoundingClientRect: () => panel.rect,
  };
  return panel;
}

/** Moves a `countingPanel`'s own measured width, so the next firing of its
 * `ResizeObserver` reports a genuinely different box. `height` never varies
 * in these tests — one axis is enough to tell "changed" from "unchanged". */
function resizeTo(panel: ReturnType<typeof countingPanel>, width: number): void {
  panel.rect = { width, height: 0 };
}

describe("suspending the fit for the length of a gesture", () => {
  it("runs the fit on a resize when no gesture is running", () => {
    const observer = stubResizeObserver();
    const panel = countingPanel();
    observePanelFit(panel as unknown as HTMLElement);
    resizeTo(panel, 100);
    observer.fire();
    resizeTo(panel, 200);
    observer.fire();
    expect(panel.fits).toBe(2);
  });

  it("runs it not at all while a rail is moving", () => {
    // The sixteen frames of a 260ms sidebar collapse, and the whole of the
    // complaint: none of them may reach the search.
    const observer = stubResizeObserver();
    const panel = countingPanel();
    observePanelFit(panel as unknown as HTMLElement);
    suspendPanelFit();
    for (let frame = 0; frame < 16; frame++) {
      resizeTo(panel, frame + 1);
      observer.fire();
    }
    expect(panel.fits).toBe(0);
  });

  it("pays exactly one fit when the gesture settles", () => {
    // Deferred, not dropped. The page really may have changed under the
    // gesture — a window dragged during it — so the settle owes one answer,
    // on the geometry the page has actually arrived at.
    const observer = stubResizeObserver();
    const panel = countingPanel();
    observePanelFit(panel as unknown as HTMLElement);
    suspendPanelFit();
    for (let frame = 0; frame < 16; frame++) {
      resizeTo(panel, frame + 1);
      observer.fire();
    }
    resumePanelFit();
    expect(panel.fits).toBe(1);
  });

  it("owes nothing where nothing resized", () => {
    // The prose panel's own rail changes `.main`'s rows and not `.main`, so it
    // fires the observer not at all — and suspending on its account, which the
    // rails do uniformly, must then cost the page nothing at all.
    const observer = stubResizeObserver();
    const panel = countingPanel();
    observePanelFit(panel as unknown as HTMLElement);
    suspendPanelFit();
    resumePanelFit();
    expect(panel.fits).toBe(0);
    // And the gate is open again afterwards.
    resizeTo(panel, 100);
    observer.fire();
    expect(panel.fits).toBe(1);
  });

  it("collapses a whole gesture's worth of resizes into one, not one per frame", () => {
    // Stated as the ratio, since that is what the reader feels: sixteen frames
    // of forced layout against one.
    const observer = stubResizeObserver();
    const panel = countingPanel();
    observePanelFit(panel as unknown as HTMLElement);
    suspendPanelFit();
    for (let frame = 0; frame < 16; frame++) {
      resizeTo(panel, frame + 1);
      observer.fire();
    }
    resumePanelFit();
    const withGate = panel.fits;

    const second = stubResizeObserver();
    const ungated = countingPanel();
    observePanelFit(ungated as unknown as HTMLElement);
    for (let frame = 0; frame < 16; frame++) {
      resizeTo(ungated, frame + 1);
      second.fire();
    }
    expect(ungated.fits).toBe(16);
    expect(withGate).toBe(1);
  });

  it("owes nothing for the firing `observe()` itself guarantees", () => {
    // `ResizeObserver.observe` reports the target's current box once, on the
    // next frame, whether or not it ever changes — the spec's own contract,
    // not something a particular browser does. `observePanelFit` runs after
    // `fitPassageExtent` has already fit this exact box in the same task, so
    // this firing can only ever repeat an answer already on the page. On a
    // 1,520-sentence upload this one firing cost 5.7s of forced layout for a
    // result that could not differ from the 4.9s just spent getting it — see
    // the note at `observePanelFit`. `countingPanel`'s box starts at {0, 0}
    // and nothing here moves it, so this firing reports exactly the box
    // `observePanelFit` already seeded itself with.
    const observer = stubResizeObserver();
    const panel = countingPanel();
    observePanelFit(panel as unknown as HTMLElement);
    observer.fire();
    expect(panel.fits).toBe(0);
    // A genuine resize afterwards is not swallowed with it.
    resizeTo(panel, 120);
    observer.fire();
    expect(panel.fits).toBe(1);
  });

  it("does not let a repeated size mask a resize that came before it", () => {
    // The comparison is against the *last reported* box and not only the
    // seed, or a page that resized once and then settled back to its
    // original width would have its second, real resize (back to the
    // original size) mistaken for the do-nothing firing above.
    const observer = stubResizeObserver();
    const panel = countingPanel();
    observePanelFit(panel as unknown as HTMLElement);
    resizeTo(panel, 200); // genuine resize away from {0, 0}
    observer.fire();
    resizeTo(panel, 0); // genuine resize back
    observer.fire();
    expect(panel.fits).toBe(2);
  });
});
