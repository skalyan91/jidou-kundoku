import { afterEach, describe, expect, it, vi } from "vitest";
import { animateCharacterReveal } from "../src/render/KundokuView.ts";
import { CHAR_REVEAL_MAX_MS, CHAR_REVEAL_MS, charStepMs } from "../src/parse/provisionalSentences.ts";

// ---------------------------------------------------------------------------
// The reveal's **wiring**: which cell belongs to which sentence, what the
// prose is held to, and what the cancel leaves behind.
//
// The schedule itself is arithmetic and is checked in
// `tests/proseReveal.test.ts`. What is checked here is the half of
// `animateCharacterReveal` that reads a page — and it is checked against a
// stand-in rather than a document, in the manner of
// `tests/kakikudashiPanelClear.test.ts` and for the same reason: the tests run
// in node, and the function touches a countable number of things. Four, on the
// column (`querySelector`, `querySelectorAll`, `classList`, `closest`) and one
// on every cell it discloses (`style`).
//
// The stand-in is honest about what it cannot be. There is no `Element` in
// this environment, so `canFade` comes out false and the reveal is the plain
// visibility switch it falls back to — which is exactly the state the fade
// must not have changed, and checking it here is checking that the fallback
// still works. What the fade *does* when there is an `Element` to do it with
// cannot be seen from here; see the report at the head of the change.
//
// The one thing this can say about the two panels that a browser would say
// better: **they end together, and the cancel brings both up.** That is the
// property the whole of task two is judged on, and it is a property of this
// function's loop rather than of a layout.
// ---------------------------------------------------------------------------

/** Everything the reveal asks of an element it is disclosing. */
function fakeStyle() {
  const style = {
    visibility: "",
    removeProperty(name: string) {
      if (name === "visibility") style.visibility = "";
    },
  };
  return style;
}

interface FakeCell {
  style: ReturnType<typeof fakeStyle>;
  classList: { contains(name: string): boolean };
  textContent: string;
  closest(selector: string): unknown;
}

/** A column of `sentences` sentences, the numbers being how many
 * `.kanji-cell`s each `.sentence-gap` holds. */
function fakeColumn(sentences: readonly number[]) {
  const gaps = sentences.map(() => ({}));
  const cells: FakeCell[] = [];
  sentences.forEach((count, i) => {
    for (let at = 0; at < count; at++) {
      cells.push({
        style: fakeStyle(),
        classList: { contains: () => false },
        textContent: "甲",
        closest: (selector: string) => (selector === ".sentence-gap" ? gaps[i] : null),
      });
    }
  });
  const column = {
    querySelectorAll(selector: string) {
      return selector === ".kanji-cell" ? cells : gaps;
    },
  };
  const container = { querySelector: () => column };
  return { container: container as unknown as HTMLElement, cells, gaps };
}

/** One prose sentence's worth of characters. */
type FakeUnit = { style: ReturnType<typeof fakeStyle> };
const fakeProse = (count: number): FakeUnit[] => Array.from({ length: count }, () => ({ style: fakeStyle() }));

/** `animateCharacterReveal` with the stand-in's prose cast to what it stands
 * in for — one cast, here, rather than one at every call. */
function reveal(
  container: HTMLElement,
  onShown: (shown: number, total: number) => void,
  prose: readonly FakeUnit[][],
): () => void {
  return animateCharacterReveal(container, onShown, prose as unknown as readonly (readonly HTMLElement[])[]);
}

const shownIn = (units: readonly { style: { visibility: string } }[]) =>
  units.filter((unit) => unit.style.visibility !== "hidden").length;

/** The reveal, driven by hand: `frame(ms)` puts the clock at `ms` and runs
 * whatever the last frame asked for. */
function drive() {
  let clock = 0;
  const queue: (() => void)[] = [];
  const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
  const raf = vi.fn((cb: () => void) => {
    queue.push(cb);
    return 0;
  });
  (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = raf;
  return {
    frame(ms: number) {
      clock = ms;
      const due = queue.splice(0, queue.length);
      for (const cb of due) cb();
    },
    restore() {
      now.mockRestore();
      delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
    },
  };
}

let driver: ReturnType<typeof drive> | null = null;
afterEach(() => {
  driver?.restore();
  driver = null;
});

describe("animateCharacterReveal", () => {
  it("hides both panels before the first frame and leaves nothing else touched", () => {
    driver = drive();
    const { container, cells } = fakeColumn([3, 2]);
    const prose = [fakeProse(5), fakeProse(4)];
    reveal(container, () => {}, prose);
    expect(cells.every((cell) => cell.style.visibility === "hidden")).toBe(true);
    expect(prose.flat().every((unit) => unit.style.visibility === "hidden")).toBe(true);
  });

  it("holds each prose sentence to the kundoku sentence it belongs to", () => {
    driver = drive();
    // Two sentences of three and two characters; five and four of prose. The
    // second prose sentence must not begin while the column is still in the
    // first, however much shorter its own step is.
    const { container } = fakeColumn([3, 2]);
    const prose = [fakeProse(5), fakeProse(4)];
    reveal(container, () => {}, prose);

    driver.frame(3 * CHAR_REVEAL_MS); // the first sentence exactly done
    expect(shownIn(prose[0])).toBe(5);
    expect(shownIn(prose[1])).toBe(0);

    driver.frame(4 * CHAR_REVEAL_MS); // halfway through the second
    expect(shownIn(prose[1])).toBe(2);
  });

  it("ends the two panels together", () => {
    driver = drive();
    const { container, cells } = fakeColumn([4, 1, 6]);
    const prose = [fakeProse(9), fakeProse(3), fakeProse(11)];
    let reported = 0;
    reveal(container, (shown) => (reported = shown), prose);

    driver.frame(11 * CHAR_REVEAL_MS);
    expect(reported).toBe(11);
    expect(shownIn(cells)).toBe(11);
    expect(prose.every((sentence) => shownIn(sentence) === sentence.length)).toBe(true);
  });

  it("discloses a sentence whose prose is empty, and one whose column is", () => {
    driver = drive();
    // The middle sentence has no `.kanji-cell` at all, so it takes no time;
    // the first has no prose. Neither may leave anything permanently hidden.
    const { container } = fakeColumn([2, 0, 2]);
    const prose = [fakeProse(0), fakeProse(3), fakeProse(4)];
    reveal(container, () => {}, prose);

    driver.frame(2 * CHAR_REVEAL_MS + 1);
    expect(shownIn(prose[1])).toBe(3); // landed whole, at its own moment
    driver.frame(4 * CHAR_REVEAL_MS);
    expect(prose.every((sentence) => shownIn(sentence) === sentence.length)).toBe(true);
  });

  it("brings a prose sentence with no kundoku sentence up at the very end", () => {
    driver = drive();
    const { container } = fakeColumn([3]);
    const prose = [fakeProse(4), fakeProse(2)];
    reveal(container, () => {}, prose);

    driver.frame(3 * CHAR_REVEAL_MS - 1);
    expect(shownIn(prose[1])).toBe(0);
    driver.frame(3 * CHAR_REVEAL_MS);
    expect(shownIn(prose[1])).toBe(2);
  });

  it("brings both panels up at once when cancelled, leaving no inline style", () => {
    driver = drive();
    const { container, cells } = fakeColumn([4, 4]);
    const prose = [fakeProse(7), fakeProse(6)];
    let reported: [number, number] = [0, 0];
    const stop = reveal(container, (shown, total) => (reported = [shown, total]), prose);

    driver.frame(2 * CHAR_REVEAL_MS);
    expect(shownIn(cells)).toBeLessThan(8);
    stop();

    expect(shownIn(cells)).toBe(8);
    expect(prose.every((sentence) => shownIn(sentence) === sentence.length)).toBe(true);
    expect(reported).toEqual([8, 8]);
    // `visibility` off and nothing put in its place: the page as it was
    // rendered.
    expect(cells.every((cell) => cell.style.visibility === "")).toBe(true);
    expect(prose.flat().every((unit) => unit.style.visibility === "")).toBe(true);
  });

  it("is idempotent, and stops the loop", () => {
    driver = drive();
    const { container } = fakeColumn([4]);
    let calls = 0;
    const stop = reveal(container, () => calls++, []);
    driver.frame(CHAR_REVEAL_MS);
    const before = calls;
    stop();
    stop();
    driver.frame(4 * CHAR_REVEAL_MS);
    expect(calls).toBe(before + 1); // the cancel's own report, and no frame after it
  });

  it("puts everything up at once where there is nothing that can animate", () => {
    // No `requestAnimationFrame`: the node environment as it stands, and the
    // fallback the reveal has always had. Nothing is hidden, in either panel,
    // so there is nothing left for a cancel to undo.
    const { container, cells } = fakeColumn([3, 3]);
    const prose = [fakeProse(4), fakeProse(4)];
    let reported: [number, number] = [0, 0];
    const stop = reveal(container, (shown, total) => (reported = [shown, total]), prose);
    expect(reported).toEqual([6, 6]);
    expect(cells.every((cell) => cell.style.visibility === "")).toBe(true);
    expect(prose.flat().every((unit) => unit.style.visibility === "")).toBe(true);
    expect(() => stop()).not.toThrow();
  });

  it("discloses an empty column without touching the prose", () => {
    const { container } = fakeColumn([]);
    const prose = [fakeProse(3)];
    let reported: [number, number] = [-1, -1];
    reveal(container, (shown, total) => (reported = [shown, total]), prose);
    expect(reported).toEqual([0, 0]);
    expect(shownIn(prose[0])).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// **A long text, and the two things that had to stay true of it.**
//
// The complete-tree route discloses a text of any length now — a stored text
// arrives whole, so the frontier is holding nothing up and there is nothing
// for a length cap to protect (see `RevealContext`). Two properties of this
// function carry that, and neither was checked before because no reveal could
// run for longer than 2.4 seconds:
//
//  1. **The reveal ends.** Past a thousand characters the step shortens so the
//     whole thing lands on `CHAR_REVEAL_MAX_MS` — which from the frame's side
//     is the frontier advancing by more than one character a tick. It always
//     did (three to the frame at 60Hz); what is new is the size of the number.
//  2. **A character that is up is a character that answers.** The reveal's
//     only mark on a cell is `visibility`, and `visibility: hidden` is also
//     what takes a cell out of hit testing — so "on the page" and "answers the
//     inspector" are one state, and there is no third state in between. That
//     is the whole mechanism behind editing a stored text while it is still
//     appearing: the sentences behind these cells were registered by
//     `renderKundokuView` before the first character was hidden, so the
//     inspector can resolve any cell it is allowed to reach.
//
// What cannot be seen from here is the click itself; there is no hit testing
// in this environment. What is checked is the state the hit testing reads —
// that a cell which is up carries no inline style at all (it is the cell the
// render built, not a cell in some reveal-only condition), that the shown
// cells are always a prefix of the column, and that none is ever taken back.
// ---------------------------------------------------------------------------

describe("animateCharacterReveal, on a long text", () => {
  it("lands on the budget however long the text is", () => {
    driver = drive();
    const { container, cells } = fakeColumn([5000, 5000]);
    let reported: [number, number] = [0, 0];
    reveal(container, (shown, total) => (reported = [shown, total]), []);

    // A single frame brings up twenty-seven characters rather than two: the
    // step is 0.6ms at ten thousand characters (6000/10000), against the 6ms
    // the house rate would have taken sixty seconds at.
    expect(charStepMs(cells.length)).toBeCloseTo(0.6, 10);
    driver.frame(1000 / 60);
    expect(shownIn(cells)).toBe(27);

    driver.frame(CHAR_REVEAL_MAX_MS - 1);
    expect(shownIn(cells)).toBeLessThan(cells.length);
    driver.frame(CHAR_REVEAL_MAX_MS);
    expect(reported).toEqual([10_000, 10_000]);
    expect(shownIn(cells)).toBe(10_000);
  });

  it("holds the prose to the column at the shortened step too", () => {
    driver = drive();
    // Two sentences of two thousand characters; the prose runs half again as
    // long, as it does on real text. The step here is 1.5ms, not 6, and the
    // pairing has to be answering to *that* — a prose panel still reading the
    // house rate would be four times ahead of the column above it.
    const { container } = fakeColumn([2000, 2000]);
    const prose = [fakeProse(3000), fakeProse(3000)];
    reveal(container, () => {}, prose);
    const step = charStepMs(4000);
    expect(step).toBe(1.5);

    driver.frame(2000 * step); // the first kundoku sentence exactly done
    expect(shownIn(prose[0])).toBe(3000);
    expect(shownIn(prose[1])).toBe(0);

    driver.frame(3000 * step); // halfway through the second
    expect(shownIn(prose[1])).toBe(1500);

    driver.frame(CHAR_REVEAL_MAX_MS);
    expect(prose.every((sentence) => shownIn(sentence) === sentence.length)).toBe(true);
  });

  it("leaves every character that is up answerable, and never takes one back", () => {
    driver = drive();
    const { container, cells } = fakeColumn([400, 400, 400]);
    reveal(container, () => {}, []);
    let before = 0;
    for (const ms of [0, 30, 200, 1200, 4000, 6000]) {
      driver.frame(ms);
      const up = cells.filter((cell) => cell.style.visibility !== "hidden").length;
      expect(up).toBeGreaterThanOrEqual(before); // nothing is taken back
      // A prefix of the column, and every one of them with no inline style
      // left on it: the cell the render built, which is the cell the inspector
      // knows how to answer for.
      expect(cells.slice(0, up).every((cell) => cell.style.visibility === "")).toBe(true);
      expect(cells.slice(up).every((cell) => cell.style.visibility === "hidden")).toBe(true);
      before = up;
    }
    expect(before).toBe(1200);
  });

  it("brings a long text up whole when an edit cancels it partway", () => {
    // What a reader gets who corrects a tag two seconds into a six-second
    // reveal. The edit's redraw runs after this, so what it re-fits is a page
    // with every character at full ink — nothing is mid-fade, and nothing is
    // hidden for the re-break to strand. See `redrawInPlace`.
    driver = drive();
    const { container, cells } = fakeColumn([2500, 2500]);
    const prose = [fakeProse(3600), fakeProse(3600)];
    const stop = reveal(container, () => {}, prose);

    driver.frame(2000);
    const partway = shownIn(cells);
    expect(partway).toBeGreaterThan(0);
    expect(partway).toBeLessThan(cells.length);

    stop();
    expect(shownIn(cells)).toBe(cells.length);
    expect(cells.every((cell) => cell.style.visibility === "")).toBe(true);
    expect(prose.flat().every((unit) => unit.style.visibility === "")).toBe(true);
  });
});
