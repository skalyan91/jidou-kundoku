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
 * can fire "the panel resized" as many times as a transition would. */
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

/** A stand-in panel that counts the fits run against it.
 *
 * `refitPanel` asks the container for its column and returns at once when
 * there is none, so a container whose `querySelector` answers `null` is a fit
 * that costs nothing — and the count of times it was asked is the count of
 * fits. That is the probe, stated plainly because it is indirect: what is
 * being counted is entries into the fit, which is exactly the quantity the
 * chop is made of. */
function countingPanel() {
  const panel = {
    fits: 0,
    querySelector() {
      panel.fits++;
      return null;
    },
    closest: () => null,
    parentElement: null,
  };
  return panel;
}

describe("suspending the fit for the length of a gesture", () => {
  it("runs the fit on a resize when no gesture is running", () => {
    const observer = stubResizeObserver();
    const panel = countingPanel();
    observePanelFit(panel as unknown as HTMLElement);
    observer.fire();
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
    for (let frame = 0; frame < 16; frame++) observer.fire();
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
    for (let frame = 0; frame < 16; frame++) observer.fire();
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
    for (let frame = 0; frame < 16; frame++) observer.fire();
    resumePanelFit();
    const withGate = panel.fits;

    const second = stubResizeObserver();
    const ungated = countingPanel();
    observePanelFit(ungated as unknown as HTMLElement);
    for (let frame = 0; frame < 16; frame++) second.fire();
    expect(ungated.fits).toBe(16);
    expect(withGate).toBe(1);
  });
});
