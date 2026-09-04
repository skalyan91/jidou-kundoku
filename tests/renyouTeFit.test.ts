import { describe, expect, it } from "vitest";
import type { Sentence, TokenTree } from "../src/parse/types.ts";
import type { ReadingResolver, ResolvedReading } from "../src/reading/types.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { generateKakikudashiForTree } from "../src/kakikudashi/generator.ts";
import { setRenyouTe } from "../src/kakikudashi/renyouTe.ts";
import { matchedDivision, matchedSlots } from "../src/render/KakikudashiView.ts";
import { cellWalk } from "../src/render/KundokuView.ts";

// ---------------------------------------------------------------------------
// **The 連用形-て switch and the fit.**
//
// The switch writes a connective at every 連用形 that hands a clause on, so it
// changes *how many characters the prose holds* — and the division of the page
// between the two panels is chosen by measuring exactly that. Turning it off
// shortens the prose; a shorter prose runs a shorter passage at any given
// column length; and the column length that makes the two texts end together
// therefore moves. The user's constraints, in the order they were given:
//
//   - the prose panel is only as tall as it takes for the two texts to come
//     out the same length, short prose lines being welcome;
//   - the kundoku panel's own height constraint is not broken, and when the
//     prose panel shortens the kundoku panel **grows to match, in fixed
//     increments** — it can hold only whole characters, so the transfer moves
//     in whole `--kanji-advance` steps;
//   - what is measured is the panel's final extent, not something recomputed
//     frame by frame.
//
// All three are properties of `matchedSlots` and `matchedDivision`, which are
// pure for this reason, and none of them needs a document. What does need one
// — that a browser lays a column out to the count the fit asked for — is
// `FIT_GUARD_PER_SLOT_PX`'s business and is stated in
// `tests/kakikudashiColumnFit.test.ts`.
//
// The switch is module state, so every test that turns it on puts it back.
// ---------------------------------------------------------------------------

/** 王仁、愛民 — 王仁に、民を愛し by default, 王仁にして、民を愛し under the
 * switch. Two characters a sentence, which is the smallest real delta the
 * switch produces and so the least flattering case to test the fit on. */
const wangRen: Sentence = {
  tokens: [
    { id: 0, text: "王", lemma: "王", pos: "PROPN", xpos: "n,名詞,主体,人", dep: "subj", head: 1 },
    { id: 1, text: "仁", lemma: "仁", pos: "ADJ", xpos: "v,動詞,描写,態度", dep: "ROOT", head: 1, morph: "Degree=Pos" },
    { id: 2, text: "、", lemma: "、", pos: "PUNCT", xpos: "s,記号,読点,*", dep: "punct", head: 1 },
    { id: 3, text: "愛", lemma: "愛", pos: "VERB", xpos: "v,動詞,行為,態度", dep: "conj:coord", head: 1 },
    { id: 4, text: "民", lemma: "民", pos: "NOUN", xpos: "n,名詞,主体,他", dep: "comp:obj", head: 3 },
  ],
};

/** Readings are not what is being tested — the *count* is — so the resolver
 * answers with the character itself and the prose comes out in the shape the
 * generator gives it. */
const resolve: ReadingResolver = (token): ResolvedReading => ({ reading: token.text, source: "unresolved" });

/** How many characters the prose of a passage holds, in each state of the
 * switch. A passage rather than a sentence, because the fit is a fact about a
 * whole text: thirty of them here, which is a page of prose rather than a
 * line. */
function proseLengths(sentences: number): { off: number; on: number } {
  const tree: TokenTree = { sentences: Array.from({ length: sentences }, () => wangRen), source: "conllu" };
  const write = () => generateKakikudashiForTree(tree, (s) => computeReadingOrder(s), resolve).length;
  setRenyouTe(false);
  const off = write();
  setRenyouTe(true);
  const on = write();
  setRenyouTe(false);
  return { off, on };
}

describe("what the switch does to the quantity the fit measures", () => {
  it("changes how many characters the prose holds", () => {
    // Which is the whole reason the fit has to be re-answered: two characters
    // a sentence, thirty sentences, and the passage the panel is being fitted
    // to is 22% longer in one state than the other.
    const { off, on } = proseLengths(30);
    expect(off).toBe(270);
    expect(on).toBe(330);
    expect(on - off).toBe(60);
  });

  it("leaves the switch as it found it", () => {
    // The module holds one flag and the whole app reads it; a test that left
    // it on would write the connective into every later suite's prose.
    const before = generateKakikudashiForTree(
      { sentences: [wangRen], source: "conllu" },
      (s) => computeReadingOrder(s),
      resolve,
    );
    proseLengths(2);
    expect(
      generateKakikudashiForTree({ sentences: [wangRen], source: "conllu" }, (s) => computeReadingOrder(s), resolve),
    ).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// The page, modelled. Every number below is the shipped geometry:
// `--column-pitch-kakikudashi` is 44px and the kundoku panel's is twice it, a
// prose character is 22px at the 0.15em design tracking, and a step of the
// split is one kundoku character — 88px, which is three and a half prose
// characters and is why the split alone cannot reach the answer.
//
// A passage of `chars` characters set `slots` to the column comes to
// `ceil(chars / slots)` columns. That is the naive count — it lets a mark
// begin a column, which 禁則 does not — and it is the same model
// `matchedDivision`'s own table reasons in, stated there as such. It is the
// right model *here* because what is being tested is the shape of the
// answer's dependence on the length, and 追い出し moves both states alike.
// ---------------------------------------------------------------------------

const PROSE_PITCH = 44;
const PROSE_ADVANCE = 22 * 1.15;
/** Ten characters of prose column, the shipped panel's own count. */
const PANEL_PX = 10 * PROSE_ADVANCE;
const STEP_PX = 88;
/** `MAX_KUNDOKU_STEPS` and `MIN_PROSE_SLOTS`, restated: they are private to
 * the module, and the model has to guard the same way `fitPassageExtent` does
 * or it would offer divisions the page refuses. */
const MAX_STEPS = 6;
const MIN_SLOTS = 3;

const extentOf = (chars: number) => (slots: number) => Math.ceil(chars / slots) * PROSE_PITCH;

/** The division the page would settle on for a prose of `chars` characters
 * against a kundoku passage `target` px long. */
function divisionFor(chars: number, target: number) {
  return matchedDivision(
    MAX_STEPS,
    (steps) => {
      const ceiling = Math.floor((PANEL_PX - steps * STEP_PX) / PROSE_ADVANCE);
      if (ceiling < (steps === 0 ? 1 : MIN_SLOTS)) return null;
      return { target, ceiling };
    },
    extentOf(chars),
  );
}

describe("the fit re-answers when the prose changes length", () => {
  const { off, on } = proseLengths(30);

  it("matches a shorter passage with a shorter column", () => {
    // The fine variable, on its own. Shortening the column is what *lengthens*
    // the passage, so a prose with fewer characters in it needs a shorter
    // column to reach the same target — never a longer one.
    let differed = 0;
    for (let target = 300; target <= 6000; target += 22) {
      const shorter = matchedSlots(target, 10, extentOf(off));
      const longer = matchedSlots(target, 10, extentOf(on));
      expect(shorter).toBeLessThanOrEqual(longer);
      if (shorter < longer) differed++;
    }
    expect(differed).toBeGreaterThan(0);
  });

  it("answers a different column length on the same page", () => {
    // One target, named, so the change is a fact and not a count of facts: at
    // a kundoku passage of 1544px the prose is set eight characters to the
    // column with the connective written and nine without it.
    expect(matchedSlots(1544, 10, extentOf(on))).toBe(9);
    expect(matchedSlots(1544, 10, extentOf(off))).toBe(8);
  });
});

describe("what the kundoku panel gets when the prose shortens", () => {
  const { off, on } = proseLengths(30);

  it("grows, and never shrinks, when the connective is hidden", () => {
    // **The user's constraint, as a sweep.** Hiding the て shortens the prose;
    // the shorter prose is matched by a shorter column; a shorter column
    // leaves height in the prose panel unused, and `matchedDivision`'s middle
    // term prefers the division that has *moved* that height across the rail
    // rather than declined to use it. So the kundoku panel takes at least as
    // many steps in the shorter state as in the longer one, at every target
    // the page can present.
    let grew = 0;
    for (let target = 300; target <= 6000; target += 22) {
      const shorter = divisionFor(off, target);
      const longer = divisionFor(on, target);
      if (!shorter || !longer) continue;
      expect(shorter.steps).toBeGreaterThanOrEqual(longer.steps);
      if (shorter.steps > longer.steps) grew++;
    }
    expect(grew).toBeGreaterThan(0);
  });

  it("moves the split at a named target rather than only in aggregate", () => {
    // At a kundoku passage of 1862px: with the connective written the split
    // stays where it is and the prose is set eight to the column; hidden, the
    // prose wants six, which leaves height over, and the page hands one whole
    // kundoku character across instead of leaving it under the prose.
    expect(divisionFor(on, 1862)).toMatchObject({ steps: 0, slots: 8 });
    expect(divisionFor(off, 1862)).toMatchObject({ steps: 1, slots: 6 });
  });

  it("only ever moves the split in whole characters", () => {
    // The fixed increment. `steps` is a count of `--kanji-advance`s, so the
    // kundoku column holds a whole number of characters at both ends of any
    // move the fit makes — which is the constraint that rules out
    // interpolating the height (see `fitPassageExtent`).
    for (let target = 300; target <= 6000; target += 22) {
      for (const chars of [off, on]) {
        const division = divisionFor(chars, target);
        if (!division) continue;
        expect(Number.isInteger(division.steps)).toBe(true);
        expect(division.steps).toBeGreaterThanOrEqual(0);
        expect(division.steps).toBeLessThanOrEqual(MAX_STEPS);
      }
    }
  });

  it("never takes a step that leaves the prose panel too short to be prose", () => {
    for (let target = 300; target <= 6000; target += 22) {
      for (const chars of [off, on]) {
        const division = divisionFor(chars, target);
        if (!division || division.steps === 0) continue;
        const ceiling = Math.floor((PANEL_PX - division.steps * STEP_PX) / PROSE_ADVANCE);
        expect(ceiling).toBeGreaterThanOrEqual(MIN_SLOTS);
        expect(division.slots).toBeGreaterThanOrEqual(1);
        expect(division.slots).toBeLessThanOrEqual(ceiling);
      }
    }
  });
});

// ---------------------------------------------------------------------------

describe("cellWalk", () => {
  // What the kundoku panel may animate when the split has moved under it. The
  // split changes the column length, so every column re-breaks and nearly
  // every cell lands somewhere else — and a cell that was *re-set* has not
  // travelled anywhere. See the note at `cellWalk`, and `pushedAlongTheFlow`
  // in KakikudashiView.ts, which is the same rule for the panel below.

  it("leaves a cell that did not move alone", () => {
    expect(cellWalk({ left: 100, top: 40 }, { left: 100, top: 40 })).toBeNull();
    // Under half a pixel is not a movement a reader can see.
    expect(cellWalk({ left: 100, top: 40 }, { left: 100.4, top: 40.3 })).toBeNull();
  });

  it("walks a cell pushed further down the column it was already in", () => {
    // Same column — same `left`, this panel being vertical-rl — and further
    // along it. That is travel, and a reader watching it slide sees what
    // happened.
    expect(cellWalk({ left: 100, top: 40 }, { left: 100, top: 128 })).toEqual({ dx: 0, dy: -88 });
  });

  it("refuses to fly a cell the re-break put in another column", () => {
    // One step of the split is 88px of column, so the whole passage is set
    // again: this cell is a column to the left and near the top of it. Walked,
    // it would describe a diagonal journey across the panel that the layout
    // never made — and it would not be alone, since a re-break moves nearly
    // every cell on the page.
    expect(cellWalk({ left: 176, top: 400 }, { left: 88, top: 40 })).toBeNull();
  });

  it("refuses it whichever way the column moved", () => {
    expect(cellWalk({ left: 88, top: 40 }, { left: 176, top: 400 })).toBeNull();
    // And even where the cell stayed at the same height in its new column,
    // which is the case a `top`-only test would have flown for nothing.
    expect(cellWalk({ left: 88, top: 40 }, { left: 176, top: 40 })).toBeNull();
  });
});
