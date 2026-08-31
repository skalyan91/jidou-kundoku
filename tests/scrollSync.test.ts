import { describe, expect, it } from "vitest";
import { setupScrollSync } from "../src/render/scrollSync.ts";

/** A panel reduced to the parts `captureScroll` and its restore actually
 * touch: a clamped scroll position, the listener the module registers on it,
 * and a count of how many times the module went looking for sentence gaps —
 * which is how a sync announces itself, since `sync` reaches for them first
 * thing.
 *
 * The glide is deliberately not modelled. Nothing here starts one: a glide
 * only begins inside `sync`, and every case below either suppresses the sync
 * or asserts that it ran, and the assertion is the `querySelectorAll` count
 * rather than any movement it would cause. */
function fakePanel(scrollWidth: number, clientWidth: number) {
  const listeners: Array<() => void> = [];
  const panel = {
    scrollLeft: 0,
    scrollWidth,
    clientWidth,
    syncsAttempted: 0,
    scrollTo({ left }: { left: number; behavior?: string }) {
      // vertical-rl: 0 at the panel's own right edge, negative leftward, so
      // the reachable range is [-(scrollWidth - clientWidth), 0].
      panel.scrollLeft = Math.max(-(panel.scrollWidth - panel.clientWidth), Math.min(0, left));
    },
    addEventListener(_type: string, fn: () => void) {
      listeners.push(fn);
    },
    querySelectorAll() {
      panel.syncsAttempted += 1;
      return [] as unknown[];
    },
    /** The one 'scroll' event the browser coalesces a frame's writes into,
     * carrying whatever position the panel ended that frame at. */
    fireScroll() {
      for (const fn of listeners) fn();
    },
  };
  return panel;
}

function setup() {
  const kundoku = fakePanel(6248, 623);
  const kakikudashi = fakePanel(3212, 623);
  const sync = setupScrollSync(kundoku as unknown as HTMLElement, kakikudashi as unknown as HTMLElement);
  return { kundoku, kakikudashi, sync };
}

/** What a re-render does to a panel on its way out — see the tail of
 * `renderKundokuView`/`renderKakikudashiView`. */
function rerenderResetsToStart(...panels: Array<{ scrollTo(o: { left: number }): void }>): void {
  for (const panel of panels) panel.scrollTo({ left: 0 });
}

describe("captureScroll", () => {
  it("puts both panels back where the re-render found them", () => {
    const { kundoku, kakikudashi, sync } = setup();
    kundoku.scrollLeft = -2800;
    kakikudashi.scrollLeft = -1436;

    const restore = sync.captureScroll();
    rerenderResetsToStart(kundoku, kakikudashi);
    expect([kundoku.scrollLeft, kakikudashi.scrollLeft]).toEqual([0, 0]);
    restore();

    expect([kundoku.scrollLeft, kakikudashi.scrollLeft]).toEqual([-2800, -1436]);
  });

  it("restores to a position the sync claims as its own, so neither panel syncs the other", () => {
    const { kundoku, kakikudashi, sync } = setup();
    kundoku.scrollLeft = -2800;
    kakikudashi.scrollLeft = -1436;

    const restore = sync.captureScroll();
    rerenderResetsToStart(kundoku, kakikudashi);
    restore();
    kundoku.fireScroll();
    kakikudashi.fireScroll();

    // A restore read as a user scroll would have each panel dragging the
    // other to it — the panels were already in step, and putting them back
    // is not a scroll anyone performed.
    expect(kundoku.syncsAttempted).toBe(0);
    expect(kakikudashi.syncsAttempted).toBe(0);
    expect([kundoku.scrollLeft, kakikudashi.scrollLeft]).toEqual([-2800, -1436]);
  });

  it("leaves nothing behind that would swallow the next real scroll", () => {
    const { kundoku, kakikudashi, sync } = setup();
    kundoku.scrollLeft = -2800;
    kakikudashi.scrollLeft = -1436;

    const restore = sync.captureScroll();
    rerenderResetsToStart(kundoku, kakikudashi);
    restore();
    kundoku.fireScroll();
    kakikudashi.fireScroll();

    kundoku.scrollLeft = -3400;
    kundoku.fireScroll();
    expect(kundoku.syncsAttempted).toBe(1);
  });

  it("records nothing for a panel the restore does not move", () => {
    // A reader at the very start of the text: the re-render's reset and the
    // restore both write 0 to a panel already at 0, so no 'scroll' event is
    // coming and no entry may be left claiming that position — the stale
    // entry at a panel's own end is what once desynced the panels by 65px.
    const { kundoku, kakikudashi, sync } = setup();

    const restore = sync.captureScroll();
    rerenderResetsToStart(kundoku, kakikudashi);
    restore();

    // The user's own scroll onto 0 must still be seen as theirs.
    kundoku.fireScroll();
    expect(kundoku.syncsAttempted).toBe(1);
  });

  it("clamps a restore the re-render made unreachable", () => {
    // An edit can shorten a panel — a reading dropped, a compound joined —
    // and the position the reader was at is then past its new end.
    const { kundoku, kakikudashi, sync } = setup();
    kundoku.scrollLeft = -5625;
    kakikudashi.scrollLeft = -2589;

    const restore = sync.captureScroll();
    kundoku.scrollWidth = 5000;
    rerenderResetsToStart(kundoku, kakikudashi);
    restore();

    expect(kundoku.scrollLeft).toBe(-(5000 - 623));
    expect(kakikudashi.scrollLeft).toBe(-2589);
    // Clamped or not, the panel still landed where the module recorded, so
    // the event that follows is its own.
    kundoku.fireScroll();
    expect(kundoku.syncsAttempted).toBe(0);
  });
});
