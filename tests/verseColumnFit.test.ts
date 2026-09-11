import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  columnCounts,
  kundokuColumnCapacity,
  lineStartColumns,
  linePerColumnSplit,
  longestLine,
  matchedDivision,
  planHangingMarks,
  planLinePadding,
  stretchedTracking,
  verseFloorDivision,
  verseFloorDivisionAtReducedAdvance,
} from "../src/render/KakikudashiView.ts";
import { rimeColumnFloor } from "../src/render/rimeAnnotation.ts";
import type { RimeIndex } from "../src/reading/rimeIndex.ts";
import { parseConllu } from "../src/parse/conlluParser.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { generateKakikudashiForTree } from "../src/kakikudashi/generator.ts";
import { findCompoundSpans, type JmdictIndex } from "../src/reading/jmdictLookup.ts";
import { createReadingResolver } from "../src/reading/readingResolver.ts";
import { sourceLayoutOf } from "../src/parse/sourceLayout.ts";
import type { KanjidicIndex } from "../src/reading/kanjidicLookup.ts";

// ---------------------------------------------------------------------------
// **A poem set line to a column, and a paragraph left alone.**
//
// The two panels are the two text rows of one grid, so a height given to the
// prose is a height taken from the kanbun, and `fitPassageExtent` chooses that
// division by matching how far the two passages run. On running prose that is
// the whole of what a reader wants. On a poem it is the wrong question and it
// does visible damage: ten prose columns at half the kanbun's pitch run half
// as far as ten kanbun columns, so the match *wants* the poem wrapped, and it
// bought its match by breaking every line of 春望 across two columns or three.
// The reader saw ten lines above and twenty-one below and could not read one
// against the other.
//
// `longestLine` and `linePerColumnSplit` are the answer: where the text sets
// its own lines and some division of the page holds the longest of them, the
// line wins and the extent match is not asked. The model below is the page's
// own arithmetic — the grid's `round(down, 60% …, --kanji-advance)` and the
// panel's `round(measure / advance)` — so that what the two functions do to a
// real poem at a real window can be checked without a layout engine, which
// this environment has none of.
// ---------------------------------------------------------------------------

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "public", "data");
const kanjidic = JSON.parse(readFileSync(join(DATA, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
const jmdict = JSON.parse(readFileSync(join(DATA, "jmdict-index.json"), "utf-8")) as JmdictIndex;
const resolve = createReadingResolver(kanjidic, jmdict);

/** The page's own lengths, in the units the stylesheets declare them in:
 * `--kanji-advance`, `--size-main` at the shipped 0.15em tracking, the prose
 * column pitch at half the kanbun's, and the frame `tests/panelMargins.test.ts`
 * checks the identity of. */
const ADVANCE = 88;
const SIZE_KAKIKUDASHI = 22;
const PROSE_ADVANCE = SIZE_KAKIKUDASHI * 1.15;
const PROSE_PITCH = 44;
const PANEL_MARGIN_TOP = 55;
/** `--prose-margin-top` + `--kanji-gap`, at the panel's *own* pitch —
 * `(PROSE_PITCH - SIZE_KAKIKUDASHI) / 2 + 44`, 11 + 44. This is the padding
 * every division but line-per-column measures against, because none of the
 * others ever write `--line-height-kakikudashi`. */
const PROSE_PADDING = 11 + 44;
/** The same sum at the *kanbun's* pitch — `(ADVANCE - SIZE_KAKIKUDASHI) / 2 +
 * 44`, 33 + 44 — which is what `--prose-margin-top` actually becomes the
 * instant line-per-column mode writes `PITCH_PROPERTY` to `VERSE_PITCH`
 * (KakikudashiView.ts). `panelAtForLine` asks its measure against this, not
 * `PROSE_PADDING`, because that write is what this division *is*; see its own
 * comment, and `tests/verseColumnFit.test.ts`'s "applied state" describe
 * block below for what asking the other one cost. */
const VERSE_PROSE_PADDING = 33 + 44;

/** Every `.main` a reader can put this page in, at the step this repository
 * measures the frame in.
 *
 * **`.main` is the grid area inside `#app`, not the window** — every `H` in
 * this file, and every `H` this file hands to `geometry`, is a `.main`
 * value, and `.main` is the *window's height minus the app's own chrome*
 * (the title bar and whatever frame surrounds `.main`), never the window
 * height itself. Measured against the shipped 春望 sample in a real Chrome
 * against the running dev server: an outer window height of 1020px leaves a
 * `.main` of 798px, so the chrome costs roughly 222px at this build. An
 * earlier round of this file did not keep the two separate — it measured a
 * reader's own window and wrote its height into a sweep labelled `.main`,
 * which is 222px too tall a page for every threshold computed from it. Kept
 * here as the standing warning against repeating that: **before writing a
 * width into this file, say whether it is a `.main` or a window, and if it
 * is a window, subtract the chrome first.**
 *
 * 680px and not 700: 700px was picked as "below any window the panels are
 * usable in" without checking what window produces it, and the chrome above
 * means a 700px `.main` is roughly a 922px window — not a small one. 680px
 * is chosen instead because it is what the same 222px of chrome leaves of a
 * 900px window, which is a real, unremarkable laptop height and a case the
 * sweep should cover on its own account, not by accident of where 700 fell.
 * (Below 680, `.main` starts producing the same near-empty-panel geometry
 * `matchedDivision`'s own tests already carve out at its lower bound, rather
 * than anything this file's invariants are about — see the widened sweep in
 * `tests/lineAlignment.test.ts`, whose own note has the figures.) 1600 is
 * past a 27-inch display. Module-level so every `describe` below sweeps the
 * same widths rather than each declaring its own. */
const WIDTHS: number[] = [];
for (let H = 680; H <= 1600; H += 1) WIDTHS.push(H);

/** `.main` at `H` px, divided `steps` from where the stylesheet leaves it:
 * what each panel then holds to a column. Transcribed from
 * `#app:not(.kakikudashi-collapsed):not(.kakikudashi-empty) .main` in
 * tategaki.css and from `fitPassageExtent`'s own ceiling.
 *
 * `verse` asks for the measure against `VERSE_PROSE_PADDING` instead of
 * `PROSE_PADDING` — the padding once `linePerColumnSplit`'s own choice has
 * been carried out, rather than the padding on the box before it is. Only the
 * `at` this file hands to `linePerColumnSplit` itself (`panelAtForLine`'s own
 * transcription, in `fit` and `division` below) ever asks with it set;
 * `verseFloorDivision` and the extent match never write that pitch, so for
 * them the page before and after the choice is the same page and the default
 * is correct. */
function geometry(H: number, steps: number, verse = false) {
  const kundokuRow = PANEL_MARGIN_TOP + Math.floor((0.6 * H - PANEL_MARGIN_TOP) / ADVANCE) * ADVANCE + steps * ADVANCE;
  const measure = H - kundokuRow - (verse ? VERSE_PROSE_PADDING : PROSE_PADDING);
  const counts = measure > 0 ? columnCounts(measure, SIZE_KAKIKUDASHI) : null;
  return {
    kundokuSlots: (kundokuRow - PANEL_MARGIN_TOP) / ADVANCE,
    ceiling: measure > 0 ? Math.round(measure / PROSE_ADVANCE) : 0,
    /** The count the panel can be *set* to, which is what decides whether a
     * line can have a column — see `PanelAtSplit`. */
    most: counts ? counts.most : 0,
  };
}

/** How far a lineated passage runs, in px: every line takes at least one
 * column and a line longer than the column takes as many as it needs. */
const extent = (lines: readonly number[], slots: number, pitch: number) =>
  slots < 1 ? Infinity : lines.reduce((sum, n) => sum + Math.max(1, Math.ceil(n / slots)), 0) * pitch;

const proseLines = (file: string): number[] => {
  const tree = parseConllu(readFileSync(join(DATA, "samples", file), "utf-8"));
  const out = generateKakikudashiForTree(
    tree,
    (sentence) => computeReadingOrder(sentence, findCompoundSpans(sentence, { kanjidic, jmdict })),
    resolve,
  );
  return out.split("\n").map((line) => [...line].length);
};

/** The 白文's own lines, in characters that take an advance — a mark of
 * punctuation takes none in that panel (`.punct-cell`, kunten.css). */
const kanbunLines = (file: string): number[] => {
  const tree = parseConllu(readFileSync(join(DATA, "samples", file), "utf-8"));
  const lines: number[] = [];
  let held = 0;
  let started = false;
  for (const sentence of tree.sentences) {
    for (const token of sentence.tokens) {
      if (sourceLayoutOf(token)?.breakBefore) {
        if (started) lines.push(held);
        held = 0;
      }
      started = true;
      if (!/[、。，；：？！「」『』《》]/.test(token.text)) held++;
    }
  }
  lines.push(held);
  return lines;
};

/** The raw prose flow, `\n`s and all — what `planHangingMarks` and
 * `lineStartColumns` (KakikudashiView.ts) walk, as opposed to `proseLines`'s
 * per-line character counts above. */
const proseText = (file: string): string => {
  const tree = parseConllu(readFileSync(join(DATA, "samples", file), "utf-8"));
  return generateKakikudashiForTree(
    tree,
    (sentence) => computeReadingOrder(sentence, findCompoundSpans(sentence, { kanjidic, jmdict })),
    resolve,
  );
};

/** Which column each of the kanbun's own lines begins in, given a column of
 * `slots` characters — `lineStartColumns`'s own arithmetic, transcribed for
 * the kanbun side, which has no hang or 禁則 of its own to complicate it: a
 * line always takes `ceil(characters / slots)` columns, in the order the
 * lines come. */
const kanbunStartColumns = (lines: readonly number[], slots: number): number[] => {
  const starts: number[] = [];
  let held = 0;
  for (const n of lines) {
    starts.push(held);
    held += Math.max(1, Math.ceil(n / slots));
  }
  return starts;
};

/** The measure `setColumnSlots` actually applies against once line-per-column
 * mode's own division has been carried out and `PITCH_PROPERTY` really is
 * `VERSE_PITCH` on the page — kept as its own sum, independent of whatever
 * `at` a search was handed to decide with, so that a regression letting the
 * decision and the apply drift apart again is caught here and not only by a
 * reader counting columns. `panelAtForLine`'s own comment (KakikudashiView.ts)
 * has the same arithmetic, stated for the reason it is needed there. */
const appliedMeasure = (H: number, steps: number): number => {
  const kundokuRow = PANEL_MARGIN_TOP + Math.floor((0.6 * H - PANEL_MARGIN_TOP) / ADVANCE) * ADVANCE + steps * ADVANCE;
  return H - kundokuRow - VERSE_PROSE_PADDING;
};

/** The whole of `fitPassageExtent`, at `H`, as arithmetic: the least step the
 * rime needs, then the line-per-column search, then the extent match if that
 * declines. Transcribed from that function so that what the page is actually
 * set to at a given window can be asserted with no layout engine. */
function fit(prose: readonly number[], kanbun: readonly number[], H: number, rimeFloor: number, verse = false) {
  const at = (steps: number) => {
    const g = geometry(H, steps);
    if (g.kundokuSlots < 1 || g.ceiling < 1) return null;
    return {
      ceiling: g.ceiling,
      most: g.most,
      kundoku: extent(kanbun, g.kundokuSlots, ADVANCE),
      kundokuSlots: g.kundokuSlots,
    };
  };
  // `panelAtForLine`'s own transcription (KakikudashiView.ts): the measure
  // `linePerColumnSplit` reasons with has to be the one the panel is left
  // with once *this* division writes `--line-height-kakikudashi`, not the one
  // on the box before it does — see `geometry`'s own comment above.
  const atForLine = (steps: number) => {
    const g = geometry(H, steps, true);
    if (g.kundokuSlots < 1 || g.ceiling < 1) return null;
    return {
      ceiling: g.ceiling,
      most: g.most,
      kundoku: extent(kanbun, g.kundokuSlots, ADVANCE),
      kundokuSlots: g.kundokuSlots,
    };
  };
  let rimeSteps = 0;
  if (rimeFloor > 0) {
    while (rimeSteps <= 6) {
      const measured = at(rimeSteps);
      if (measured === null || measured.kundokuSlots >= rimeFloor) break;
      rimeSteps++;
    }
    if (rimeSteps > 6) rimeSteps = 0;
  }
  const line = longestLine(prose.map((n) => "　".repeat(n)).join("\n"));
  const perLine = linePerColumnSplit(line, -6, atForLine, rimeFloor);
  if (perLine !== null) {
    // Also asked at the verse padding: once this division is taken the pitch
    // really is doubled, so the panel's own unaided count (`ceiling`, read
    // only where `perLine.slots` is `null`) is a fact about that padding too.
    const g = geometry(H, perLine.steps, true);
    return {
      mode: "line" as const,
      steps: perLine.steps,
      slots: perLine.slots ?? g.ceiling,
      kundokuSlots: g.kundokuSlots,
    };
  }
  // Verse that cannot have a column a line still does not go to the extent
  // match: the kanbun takes its floor and the prose the rest.
  if (verse) {
    const held = verseFloorDivision(rimeFloor, -6, 6, 3, at);
    if (held !== null) {
      const g = geometry(H, held.steps);
      return {
        mode: "floor" as const,
        steps: held.steps,
        slots: held.slots ?? g.ceiling,
        kundokuSlots: g.kundokuSlots,
      };
    }
  }
  const chosen = matchedDivision(
    6,
    (steps) => {
      const g = geometry(H, steps);
      if (g.ceiling < (steps === 0 ? 1 : 3)) return null;
      const target = extent(kanbun, g.kundokuSlots, ADVANCE);
      return target > 0 ? { target, ceiling: g.ceiling } : null;
    },
    (slots) => extent(prose, slots, PROSE_PITCH),
    rimeSteps,
  ) ?? (rimeSteps > 0 ? matchedDivision(
    6,
    (steps) => {
      const g = geometry(H, steps);
      if (g.ceiling < (steps === 0 ? 1 : 3)) return null;
      const target = extent(kanbun, g.kundokuSlots, ADVANCE);
      return target > 0 ? { target, ceiling: g.ceiling } : null;
    },
    (slots) => extent(prose, slots, PROSE_PITCH),
    0,
  ) : null);
  if (chosen === null) return { mode: "none" as const, steps: 0, slots: 0, kundokuSlots: geometry(H, 0).kundokuSlots };
  const g = geometry(H, chosen.steps);
  return { mode: "extent" as const, steps: chosen.steps, slots: chosen.slots, kundokuSlots: g.kundokuSlots };
}

/** The line-per-column search alone, which several tests below ask about
 * directly. */
function division(prose: readonly number[], kanbun: readonly number[], H: number, rimeFloor = 0): number | null {
  return (
    linePerColumnSplit(
      longestLine(prose.map((n) => "　".repeat(n)).join("\n")),
      -6,
      (steps) => {
        const g = geometry(H, steps, true);
        if (g.kundokuSlots < 1 || g.ceiling < 1) return null;
        return {
          ceiling: g.ceiling,
          most: g.most,
          kundoku: extent(kanbun, g.kundokuSlots, ADVANCE),
          kundokuSlots: g.kundokuSlots,
        };
      },
      rimeFloor,
    )?.steps ?? null
  );
}

describe("longestLine", () => {
  it("answers nothing for a text that sets no lines of its own", () => {
    // The gate that keeps this off prose. One line is a paragraph, however
    // long, and a paragraph is not a thing a column can hold.
    expect(longestLine("子曰學而時習之不亦說乎")).toBe(0);
    expect(longestLine("")).toBe(0);
  });

  it("takes the longest run between the panel's own breaks", () => {
    expect(longestLine("國破山河在\n城春草木深")).toBe(5);
    expect(longestLine("春望\n杜甫\n國破れ山河在り")).toBe(7);
  });

  it("counts an indent, which takes a slot like anything else", () => {
    expect(longestLine("春望\n　子曰く")).toBe(4);
  });

  it("counts a character and not a UTF-16 unit", () => {
    // A 𠮟 in the prose is one slot of the column, not two.
    expect(longestLine("春望\n𠮟𠮟𠮟")).toBe(3);
  });
});

describe("linePerColumnSplit", () => {
  /** A page whose panel holds `ceilings[steps]` at its own tracking and can be
   * set to `most[steps]`; `kundoku` is how far the kanbun passage runs and
   * `slots` how many cells its column holds. */
  const page =
    (
      ceilings: Record<number, number>,
      most: Record<number, number>,
      kundoku: Record<number, number>,
      slots: Record<number, number> = {},
    ) =>
    (steps: number) =>
      ceilings[steps] === undefined
        ? null
        : {
            ceiling: ceilings[steps],
            most: most[steps] ?? ceilings[steps],
            kundoku: kundoku[steps],
            kundokuSlots: slots[steps] ?? 99,
          };

  it("takes no step where the panel already holds the longest line", () => {
    // A step re-breaks every column of the kanbun, so one that buys nothing
    // must not be taken. The panel's own count reaches the line, so the column
    // is left at it and the type stays at the tracking it was drawn for.
    expect(linePerColumnSplit(16, -6, page({ 0: 16, [-1]: 20 }, {}, { 0: 880, [-1]: 880 }))).toEqual({
      steps: 0,
      slots: null,
    });
  });

  it("asks for the count the panel can be *set* to, not the one it takes unasked", () => {
    // **The fault this round.** `setColumnSlots` reaches a longer column by
    // spending the measure between the characters instead of beside them, and
    // the extent match has always used that. Asking here for the panel's own
    // count was refusing a setting the page was standing there able to take:
    // at a `.main` of 1008px the panel's own count is 15 and the count it can
    // hold is 16, which is the whole of 春望's longest line. Would have caught
    // the threshold sitting 23px higher than the page requires.
    expect(linePerColumnSplit(16, -6, page({ 0: 15 }, { 0: 16 }, { 0: 880 }))).toEqual({ steps: 0, slots: 16 });
    expect(linePerColumnSplit(16, -6, page({ 0: 15 }, { 0: 15 }, { 0: 880 }))).toBeNull();
  });

  it("walks down to the first step that reaches the line", () => {
    expect(
      linePerColumnSplit(16, -6, page({ 0: 14, [-1]: 18, [-2]: 21 }, {}, { 0: 880, [-1]: 880, [-2]: 880 })),
    ).toEqual({ steps: -1, slots: null });
  });

  it("stops where the kanbun passage begins to wrap", () => {
    // The bound, and the reason it is measured rather than reasoned: the
    // height comes out of the kanbun's own column, and the character that
    // takes a line of the poem over is the character that lengthens its
    // passage. Would have caught a search bounded by a step count alone —
    // which would have taken the step and set the panel above to eighteen
    // columns for a poem of ten lines.
    expect(linePerColumnSplit(16, -6, page({ 0: 14, [-1]: 18 }, {}, { 0: 880, [-1]: 1584 }))).toBeNull();
  });

  it("stops where the kanbun column falls below what the rime needs", () => {
    expect(
      linePerColumnSplit(16, -6, page({ 0: 14, [-1]: 18 }, {}, { 0: 880, [-1]: 880 }, { 0: 6, [-1]: 5 }), 6),
    ).toBeNull();
  });

  it("declines a text that sets no lines", () => {
    expect(linePerColumnSplit(0, -6, page({ 0: 14, [-1]: 18 }, {}, { 0: 880, [-1]: 880 }))).toBeNull();
  });

  it("declines where no division of the page reaches the line", () => {
    expect(
      linePerColumnSplit(16, -2, page({ 0: 11, [-1]: 14, [-2]: 15 }, {}, { 0: 880, [-1]: 880, [-2]: 880 })),
    ).toBeNull();
  });

  it("declines where there is no kanbun passage to measure against", () => {
    // A print band, a fixture, a panel with the document just closed: nothing
    // to be kept from wrapping, and so no bound on what could be taken.
    expect(linePerColumnSplit(16, -6, page({ 0: 20 }, {}, { 0: 0 }))).toBeNull();
  });
});

describe("verseFloorDivision", () => {
  const page =
    (most: Record<number, number>, kundoku: Record<number, number>, slots: Record<number, number>) =>
    (steps: number) =>
      most[steps] === undefined
        ? null
        : { ceiling: most[steps], most: most[steps], kundoku: kundoku[steps], kundokuSlots: slots[steps] };

  it("gives the kanbun its floor and the prose everything else", () => {
    // The least division at which the kanbun's lines still each have a column
    // and its rime still has its cell. Nothing above it is offered, however
    // well it might match the two passages' lengths.
    const at = page(
      { [-1]: 20, 0: 15, 1: 11, 2: 7 },
      { [-1]: 1760, 0: 880, 1: 880, 2: 880 },
      { [-1]: 5, 0: 6, 1: 7, 2: 8 },
    );
    expect(verseFloorDivision(6, -6, 6, 3, at)).toEqual({ steps: 0, slots: 15 });
  });

  it("steps up where the stylesheet leaves the kanbun below its floor", () => {
    const at = page({ 0: 20, 1: 15, 2: 11 }, { 0: 880, 1: 880, 2: 880 }, { 0: 5, 1: 6, 2: 7 });
    expect(verseFloorDivision(6, -6, 6, 3, at)).toEqual({ steps: 1, slots: 15 });
  });

  it("refuses a division that leaves no prose behind", () => {
    // A column of two characters is not prose, and `fittedTracking` is already
    // declining to set one. Where the floor cannot be had with a panel left
    // under it, this answers nothing and the caller keeps the extent match.
    const at = page({ 0: 8, 1: 2 }, { 0: 880, 1: 880 }, { 0: 5, 1: 6 });
    expect(verseFloorDivision(6, -6, 6, 3, at)).toBeNull();
  });

  it("never takes so much that the kanbun itself wraps", () => {
    // With no rime to hold the floor — a poem whose line-finals are outside the
    // 廣韻 — the bound that remains is the kanbun passage's own length.
    const at = page({ [-2]: 30, [-1]: 20, 0: 15 }, { [-2]: 2640, [-1]: 1760, 0: 880 }, { [-2]: 3, [-1]: 4, 0: 5 });
    expect(verseFloorDivision(0, -6, 6, 3, at)).toEqual({ steps: 0, slots: 15 });
  });

  it("declines where there is no kanbun passage at all", () => {
    expect(verseFloorDivision(6, -6, 6, 3, page({ 0: 20 }, { 0: 0 }, { 0: 6 }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// **The lever `verseFloorDivision` does not have: `--kanji-gap`, reduced.**
//
// `verseFloorDivision` holds the kanbun to its rime floor and gives the
// prose whatever is left, at the *design* 88px advance — which, on a poem
// whose translated lines run long enough, can still leave the prose short of
// "every line in at most two columns", the target that keeps a padded
// passage from permanently outrunning the kanbun (see `tests/lineAlignment
// .test.ts`'s own account of the 44px this cost 春望 at `.main` = 802).
// `verseFloorDivisionAtReducedAdvance` is the search that tries a slightly
// smaller `--kanji-gap` — and so a slightly smaller `--kanji-advance`,
// `KakikudashiView.ts`'s own note on why the two move together and
// `--size-main` moves for neither — before settling for that shortfall.
// ---------------------------------------------------------------------------

describe("verseFloorDivisionAtReducedAdvance", () => {
  /** A page whose `verseFloorDivision` answer at each whole-pixel gap
   * reduction is given directly, keyed first by reduction and then by step —
   * `page({0: {...}, 1: {...}})` reads as "at the design gap, this; one
   * pixel off it, this instead". A reduction with no entry answers `null` at
   * every step, matching a candidate the real `at` never measures because
   * the caller's own bound stopped the search first. */
  const page =
    (
      byReduction: Record<
        number,
        { most: Record<number, number>; kundoku: Record<number, number>; slots: Record<number, number> }
      >,
    ) =>
    (gapReductionPx: number, steps: number) => {
      const at = byReduction[gapReductionPx];
      if (!at || at.most[steps] === undefined) return null;
      return { ceiling: at.most[steps], most: at.most[steps], kundoku: at.kundoku[steps], kundokuSlots: at.slots[steps] };
    };

  it("never asks `--kanji-gap` for anything where the design advance already clears the target", () => {
    // The common case, and the one this must cost nothing extra at: a `.main`
    // roomy enough that `verseFloorDivision` alone already reaches `target`.
    // `gapReductionPx: 0` is the whole of the claim — the caller reads that
    // as "remove the override, if one is even there" (`setVerseGapReduction`)
    // — and reduction 1 is given an answer that would *also* clear the
    // target, which the search must never reach for having no reason to.
    const at = page({
      0: { most: { 0: 15, 1: 11 }, kundoku: { 0: 880, 1: 880 }, slots: { 0: 6, 1: 7 } },
      1: { most: { 0: 16, 1: 12 }, kundoku: { 0: 880, 1: 880 }, slots: { 0: 6, 1: 7 } },
    });
    expect(verseFloorDivisionAtReducedAdvance(6, -6, 6, 3, 8, 5, at)).toEqual({
      steps: 0,
      slots: 15,
      gapReductionPx: 0,
    });
  });

  it("takes the least reduction that reaches the target, and no more", () => {
    // Design gap: short of the target. One pixel off: still short. Two:
    // clears it. Three would clear it more generously, but is never asked
    // for — "never shrink more than needed".
    const at = page({
      0: { most: { 0: 6 }, kundoku: { 0: 880 }, slots: { 0: 6 } },
      1: { most: { 0: 7 }, kundoku: { 0: 880 }, slots: { 0: 6 } },
      2: { most: { 0: 8 }, kundoku: { 0: 880 }, slots: { 0: 6 } },
      3: { most: { 0: 9 }, kundoku: { 0: 880 }, slots: { 0: 6 } },
    });
    expect(verseFloorDivisionAtReducedAdvance(6, -6, 6, 3, 8, 5, at)).toEqual({
      steps: 0,
      slots: 8,
      gapReductionPx: 2,
    });
  });

  it("gives back the unreduced division, short of the target and all, once the bound is spent", () => {
    // Every reduction inside the bound tried and none reaches 8 — the rime
    // wins, exactly the standing ruling, and what it wins *at* is the same
    // answer `verseFloorDivision` alone would have given, not whatever the
    // last, deepest reduction the search tried happened to leave standing.
    const at = page({
      0: { most: { 0: 6 }, kundoku: { 0: 880 }, slots: { 0: 6 } },
      1: { most: { 0: 7 }, kundoku: { 0: 880 }, slots: { 0: 6 } },
    });
    expect(verseFloorDivisionAtReducedAdvance(6, -6, 6, 3, 8, 1, at)).toEqual({
      steps: 0,
      slots: 6,
      gapReductionPx: 0,
    });
  });

  it("answers nothing where no reduction within the bound gives any division at all", () => {
    // A degenerate panel at every reduction offered — the measurement
    // `verseFloorDivision`'s own `base.kundoku > 0` guard is stated against,
    // and true of the whole bound here and not just of the design gap — so
    // there is no fallback anywhere in the search to hand back, and this
    // answers `null` exactly as `verseFloorDivision` alone would have.
    const at = page({
      0: { most: { 0: 6 }, kundoku: { 0: 0 }, slots: { 0: 6 } },
      1: { most: { 0: 6 }, kundoku: { 0: 0 }, slots: { 0: 6 } },
    });
    expect(verseFloorDivisionAtReducedAdvance(6, -6, 6, 3, 8, 1, at)).toBeNull();
  });

  it("keeps searching past a reduction that itself finds nothing, rather than giving up at the first gap", () => {
    // Not every reduction has to *measure* cleanly for the search to still
    // succeed at a deeper one — a single unmeasurable candidate (`most`
    // undefined at every step, as `panelAtReducedGap` would report for a
    // reduction the real page happens to round awkwardly, `verseFloorDivis
    // ionAtReducedAdvance`'s own note on why this walks whole pixels and
    // remeasures each) is skipped, not fatal, and the fallback recorded at
    // `reduction = 0` is unaffected by it either way.
    const at = page({
      0: { most: { 0: 6 }, kundoku: { 0: 880 }, slots: { 0: 6 } },
      // reduction 1: no entry at all — every step answers null.
      2: { most: { 0: 9 }, kundoku: { 0: 880 }, slots: { 0: 6 } },
    });
    expect(verseFloorDivisionAtReducedAdvance(6, -6, 6, 3, 8, 5, at)).toEqual({
      steps: 0,
      slots: 9,
      gapReductionPx: 2,
    });
  });

  it("asks for nothing where the text sets no target — every division already clears zero", () => {
    const at = page({ 0: { most: { 0: 6 }, kundoku: { 0: 880 }, slots: { 0: 6 } } });
    expect(verseFloorDivisionAtReducedAdvance(6, -6, 6, 3, 0, 5, at)).toEqual({
      steps: 0,
      slots: 6,
      gapReductionPx: 0,
    });
  });
});

describe("春望, on the page", () => {
  const prose = proseLines("shunbou.conllu");
  const kanbun = kanbunLines("shunbou.conllu");
  const index = JSON.parse(readFileSync(join(DATA, "rime-index.json"), "utf-8")) as RimeIndex;
  const tree = parseConllu(readFileSync(join(DATA, "samples", "shunbou.conllu"), "utf-8"));
  const floor = rimeColumnFloor(tree, index);

  it("is ten lines of prose against ten of kanbun", () => {
    expect(kanbun).toEqual([2, 2, 5, 5, 5, 5, 5, 5, 5, 5]);
    expect(prose).toHaveLength(10);
    expect(Math.max(...prose)).toBe(16);
  });

  it("asks the rime annotation for its own floor, which is six", () => {
    // rime.css's bound, said where the annotation lives: the 割注 ends one cell
    // past the line's last character, so a 五言 needs a column of six.
    expect(floor).toBe(6);
  });

  it("never leaves a rime without a cell, at any width the page can give it one", () => {
    // **The guard, and it is the one the suite did not have.** The 割注 is out
    // of flow: clipping it moves no extent and lengthens no passage, so the fit
    // took a cell out of the kundoku column for a 五言 poem and every warichū in
    // 春望 disappeared without a number anywhere changing. Would have caught
    // exactly that, and does: run against the same fit with the floor passed as
    // 0 — which is what shipped — it fails at **233 of these 921 widths**, 950
    // and 1000 among them.
    //
    // A contiguous run at the bottom is excepted and named rather than
    // skipped: from a `.main` of 680 through 701 the kanbun needs 528px for
    // six cells and the prose is left under three characters to the column,
    // so no division of the page holds both. There the fit falls back to the
    // unconstrained walk (see `fitPassageExtent`), because a page divided for
    // the *previous* document is worse than a clipped gloss.
    const clipped: number[] = [];
    for (const H of WIDTHS) {
      const chosen = fit(prose, kanbun, H, floor);
      if (chosen.mode !== "none" && chosen.kundokuSlots < floor) clipped.push(H);
    }
    expect(clipped).toEqual(Array.from({ length: 22 }, (_, i) => 680 + i));
  });

  it("would have failed before the floor was stated, at 233 widths", () => {
    // The other half of the guard: the fault it is written against, reproduced
    // by passing the floor the fit used to pass.
    const clipped = WIDTHS.filter((H) => {
      const chosen = fit(prose, kanbun, H, 0);
      return chosen.mode !== "none" && chosen.kundokuSlots < floor;
    });
    expect(clipped).toHaveLength(233);
    expect(clipped).toContain(950);
    expect(clipped).toContain(1000);
  });

  // -------------------------------------------------------------------------
  // **The measurement, not just the arithmetic.**
  //
  // Every test above sweeps `fit`, which is `fitPassageExtent`'s decision
  // transcribed as arithmetic over `geometry` — and `geometry`'s own
  // `kundokuSlots` was always the *container's* capacity, `round(down, 60%
  // of .main - margins, --kanji-advance) / --kanji-advance` (plus steps).
  // That is what `verseFloorDivision` and `linePerColumnSplit` are stated
  // against, and it is a fact about `.kundoku-panel .tategaki`, the
  // container — never about `kundoku`, the `.tategaki-column` inside it,
  // which is what the shipped `kundokuSlotsNow` (`fitPassageExtent`,
  // KakikudashiView.ts) used to measure. Every test above was therefore
  // green on both sides of that bug: correct arithmetic, checked against
  // itself, cannot see a browser reading the wrong box.
  //
  // A verse line's own length is exactly `rimeFloor - 1` cells
  // (`rimeColumnFloor`'s own definition), and a source line forces a column
  // break (`applyClauseBreaks`) at its own length regardless of how tall the
  // container is — so `kundoku.getBoundingClientRect().height` can report
  // at most `rimeFloor - 1` cells for *any* verse text at *any* `.main`,
  // never the `rimeFloor` cells the rime needs. `atContentCapped` below is
  // that old, wrong measurement, modelled the same way `geometry` models the
  // right one: `kundokuSlots` capped at the longest kanbun line, which is
  // what a rendered column that never grows past its own content actually
  // reports.
  // -------------------------------------------------------------------------

  describe("the measurement, not just the arithmetic", () => {
    const longestKanbunLine = Math.max(...kanbun);

    /** `fit`'s own `at`, `atForLine` transcribed with `kundokuSlots` capped at
     * the longest kanbun line — the shipped bug, modelled. `kundoku` (the
     * passage extent) is unaffected: that is `.getBoundingClientRect().width`
     * off the same box in the real function, correct before and after the
     * fix, since a printed column's *width* was never the thing in question. */
    function fitAsShipped(H: number) {
      const capped = (steps: number) => {
        const g = geometry(H, steps);
        if (g.kundokuSlots < 1 || g.ceiling < 1) return null;
        const kundokuSlots = Math.min(g.kundokuSlots, longestKanbunLine);
        return {
          ceiling: g.ceiling,
          most: g.most,
          kundoku: extent(kanbun, g.kundokuSlots, ADVANCE),
          kundokuSlots,
        };
      };
      const cappedForLine = (steps: number) => {
        const g = geometry(H, steps, true);
        if (g.kundokuSlots < 1 || g.ceiling < 1) return null;
        const kundokuSlots = Math.min(g.kundokuSlots, longestKanbunLine);
        return {
          ceiling: g.ceiling,
          most: g.most,
          kundoku: extent(kanbun, g.kundokuSlots, ADVANCE),
          kundokuSlots,
        };
      };
      let rimeSteps = 0;
      while (rimeSteps <= 6) {
        const measured = capped(rimeSteps);
        if (measured === null || measured.kundokuSlots >= floor) break;
        rimeSteps++;
      }
      if (rimeSteps > 6) rimeSteps = 0;
      const line = longestLine(prose.map((n) => "　".repeat(n)).join("\n"));
      const perLine = linePerColumnSplit(line, -6, cappedForLine, floor);
      if (perLine !== null) {
        const g = geometry(H, perLine.steps, true);
        return { mode: "line" as const, kundokuSlots: Math.min(g.kundokuSlots, longestKanbunLine) };
      }
      const held = verseFloorDivision(floor, -6, 6, 3, capped);
      if (held !== null) {
        const g = geometry(H, held.steps);
        return { mode: "floor" as const, kundokuSlots: Math.min(g.kundokuSlots, longestKanbunLine) };
      }
      const matchAt = (steps: number) => {
        const g = geometry(H, steps);
        if (g.ceiling < (steps === 0 ? 1 : 3)) return null;
        const target = extent(kanbun, g.kundokuSlots, ADVANCE);
        return target > 0 ? { target, ceiling: g.ceiling } : null;
      };
      const chosen =
        matchedDivision(6, matchAt, (slots) => extent(prose, slots, PROSE_PITCH), rimeSteps) ??
        (rimeSteps > 0 ? matchedDivision(6, matchAt, (slots) => extent(prose, slots, PROSE_PITCH), 0) : null);
      if (chosen === null) return { mode: "none" as const, kundokuSlots: 0 };
      const g = geometry(H, chosen.steps);
      return { mode: "extent" as const, kundokuSlots: Math.min(g.kundokuSlots, longestKanbunLine) };
    }

    it("could never have reported the floor met, at any width, before the fix", () => {
      // The measurement itself is the ceiling: `kundokuSlots` never exceeds
      // `longestKanbunLine`, which is one short of `floor` by construction
      // (`rimeColumnFloor`), so `kundokuSlots >= floor` cannot be true from
      // this measurement at *any* step, at *any* width — not a threshold to
      // find, an identity to state. Checked over the same 921 widths anyway,
      // because a claim this file makes should be a claim this file checked.
      expect(longestKanbunLine).toBe(floor - 1);
      const clipped = WIDTHS.filter((H) => {
        const chosen = fitAsShipped(H);
        return chosen.mode !== "none" && chosen.kundokuSlots < floor;
      });
      expect(clipped).toEqual(WIDTHS);
      // Including 798, the reader's own `.main` — see "the reader's own
      // geometry" below for what the *fixed* measurement gives it instead.
      expect(clipped).toContain(798);
    });
  });

  it("gives the poem a column a line from a `.main` of 1030px, and says where that comes from", () => {
    // **The floor, named.** Below this the poem cannot have both its rimes and
    // a line to a column, and the reader should be told the number rather than
    // discover it. It is the sum of four lengths and nothing else:
    //
    //     kanbun column   6 cells x 88px      528.0   five for the line, one
    //                                                 for the 割注 below it
    //     prose column    16 chars x 23.11    369.7   the longest prose line,
    //                                                 at the tightest tracking
    //                                                 the fit will set
    //     frame above     --panel-margin-top   55.0
    //     prose padding   33 + 44              77.0   `--prose-margin-top`'s
    //                                                 value once this division
    //                                                 writes `VERSE_PITCH`,
    //                                                 not the value on the box
    //                                                 before it does
    //                                        ───────
    //                                        1029.7  so 1030px of `.main`
    //
    // It was 1031 at the very first round of this feature, because nothing
    // stopped `matchedDivision` reaching for the panel's own count rather than
    // the count it can be *set* to. The next round fixed that and brought the
    // threshold to 1008 — asking `columnCounts` at the padding already on the
    // box, which was correct for every division but this one. This round asks
    // this division's own question — the padding *it* is about to write — and
    // the threshold lands one pixel under where it started, at 1030: the two
    // faults happened to spend almost the same 22-odd pixels, in opposite
    // directions, and it is a coincidence that they so nearly cancel and not a
    // check on either (`panelAtForLine`, KakikudashiView.ts, has the working).
    expect(WIDTHS.filter((H) => fit(prose, kanbun, H, floor, true).mode === "line")[0]).toBe(1030);
    for (const H of [1030, 1031, 1032, 1100, 1200, 1400, 1600]) {
      expect({ H, mode: fit(prose, kanbun, H, floor, true).mode }).toEqual({ H, mode: "line" });
    }
    for (const H of [900, 1000, 1007, 1008, 1020, 1029]) {
      expect({ H, mode: fit(prose, kanbun, H, floor, true).mode }).not.toEqual({ H, mode: "line" });
    }
  });

  it("below that, gives the kanbun its floor and the prose the rest", () => {
    // **What the extent match was doing instead, and why it is gone for verse.**
    // It handed the kanbun two cells more than it needs and then cut the prose
    // column to six characters to spend enough columns to match the kanbun's
    // length — so a ten-line poem printed as twenty columns at every width
    // below the threshold, in a prose panel *shorter than the page would have
    // given it unasked*. `verseFloorDivision` keeps the kanbun at exactly six
    // cells and sets the prose to the longest column the panel can hold.
    //
    // 1008 through 1029 are in this table and not the "line" one above
    // precisely because of the fault this round fixes: at the *default*
    // pitch's own padding — the one `verseFloorDivision` measures against,
    // since it never writes `VERSE_PITCH` — the panel can already be set to
    // sixteen characters that low, which is what lets 春望's longest line have
    // a column of its own without the pitches ever being equalised; it is the
    // *doubled* pitch's padding that cannot reach sixteen until 1030, and that
    // is the padding line-per-column mode is answerable for. 1020 is kept in
    // this table as the round number it is — **not** the reader's own
    // `.main`, which is 798 (see `WIDTHS`'s own note, and "the reader's own
    // geometry" below, which uses the real figure).
    for (const [H, cells, slots] of [
      [825, 6, 8],
      [850, 6, 9],
      [900, 6, 11],
      [950, 6, 13],
      [1000, 6, 15],
      [1007, 6, 15],
      [1008, 6, 16],
      [1020, 6, 16],
      [1029, 6, 16],
    ] as const) {
      const chosen = fit(prose, kanbun, H, floor, true);
      expect({ H, mode: chosen.mode, cells: chosen.kundokuSlots, slots: chosen.slots }).toEqual({
        H,
        mode: "floor",
        cells,
        slots,
      });
    }
  });

  it("shortens the wrapped poem from twenty-one columns to eleven", () => {
    // The reader's complaint, as a count. At 900px of `.main` the poem came to
    // twenty-one columns and now comes to thirteen; at 1000 it came to
    // twenty-one and now comes to eleven.
    // Counted with this file's own `extent`, which is `ceil(characters / slots)`
    // a line and so runs a column short of the laid-out count that
    // `planHangingMarks` gives (21 against the panel's 20). The comparison is
    // between two numbers from the same model, which is what makes it one.
    for (const [H, was, now] of [
      [825, 21, 14],
      [900, 21, 13],
      [1000, 21, 11],
    ] as const) {
      const chosen = fit(prose, kanbun, H, floor, true);
      expect({ H, columns: extent(prose, chosen.slots, PROSE_PITCH) / PROSE_PITCH }).toEqual({ H, columns: now });
      // And what the extent match set it to: six characters to the column at
      // every width in the band, which is twenty columns of a ten-line poem.
      expect(extent(prose, 6, PROSE_PITCH) / PROSE_PITCH).toBe(was);
    }
  });

  it("gives the rime its cell in preference to giving each line a column", () => {
    // The standing ruling, where the two cannot both be had. At 1000px of
    // `.main` the kanbun has its six cells and the prose can be set to fifteen
    // characters — one short of the poem's longest line — and the step down
    // that would reach sixteen takes the kanbun to five, which clips every
    // warichū. With the floor stated the step is declined and the poem wraps;
    // without it, it was taken.
    expect(division(prose, kanbun, 1000, 0)).toBe(-1);
    expect(division(prose, kanbun, 1000, floor)).toBeNull();
    expect(geometry(1000, 0).kundokuSlots).toBe(6);
    expect(geometry(1000, 0).most).toBe(15);
    expect(geometry(1000, -1).kundokuSlots).toBe(5);
    expect(geometry(1000, -1).most).toBeGreaterThanOrEqual(16);
    // And what it falls to instead is the floor division, not the extent match.
    expect(fit(prose, kanbun, 1000, floor, true).mode).toBe("floor");
  });

  it("takes a step *up* where the stylesheet leaves the rime short", () => {
    // The other half of the floor, and a defect older than any of this: at
    // 825px the grid gives the kanbun five cells for a five-character poem, so
    // the warichū was clipped before the split was ever moved. The extent
    // match now starts its walk at the first step that holds the rime.
    expect(geometry(825, 0).kundokuSlots).toBe(5);
    const chosen = fit(prose, kanbun, 825, floor);
    expect(chosen.mode).toBe("extent");
    expect(chosen.steps).toBeGreaterThanOrEqual(1);
    expect(chosen.kundokuSlots).toBeGreaterThanOrEqual(6);
  });
});

// ---------------------------------------------------------------------------
// **`--kanji-gap`, reduced — at the reader's own `.main` of 802px.**
//
// `geometry` above models `.main`'s own grid formula at the *design*
// `--kanji-advance`. `geometryAtGap` below is the same formula with a whole
// number of pixels taken off `--kanji-gap` (and so off `--kanji-advance`,
// `--panel-margin-top` and the kundoku row all three move through) —
// `KakikudashiView.ts`'s own `setVerseGapReduction`, transcribed the way
// `geometry` itself transcribes `#app:not(.kakikudashi-collapsed) .main` in
// tategaki.css. Checked once against a real Chrome, not only against
// itself: whole-pixel reductions 0 through 10 at `.main` = 802, this formula
// and the running page agreed on which step first reaches six kundoku cells
// at every one of them (`--kanji-gap` and `--kanji-advance` written directly
// on `.main`'s own inline style, `.kundoku-panel .tategaki`'s measured
// height read back). Fractions of a pixel do not hold this agreement — see
// `verseFloorDivisionAtReducedAdvance`'s own note on the two, 41.2px and
// 41.1px, that measured a 426px and a 98px kundoku content height at the
// *same* nominal six cells — which is exactly why the real search only ever
// asks in whole pixels.
// ---------------------------------------------------------------------------

describe("the reader's own `.main`, at the gap this lever settles on", () => {
  const prose = proseLines("shunbou.conllu");
  const index = JSON.parse(readFileSync(join(DATA, "rime-index.json"), "utf-8")) as RimeIndex;
  const tree = parseConllu(readFileSync(join(DATA, "samples", "shunbou.conllu"), "utf-8"));
  const floor = rimeColumnFloor(tree, index);
  const longestProse = Math.max(...prose);
  /** The count a prose column needs so this poem's own longest line takes at
   * most two of them — `verseFloorDivisionAtReducedAdvance`'s own `target`,
   * computed the same way `fitPassageExtent` computes it for the real page. */
  const twoColumnTarget = Math.ceil(longestProse / 2);

  /** `geometry`, with `reductionPx` whole pixels taken off `--kanji-gap` —
   * and so off `--panel-margin-top` (`--kanji-gap + --size-main / 4`) and
   * `--kanji-advance` (`--size-main + --kanji-gap`) both, `--size-main`
   * itself never moved. */
  function geometryAtGap(H: number, steps: number, reductionPx: number) {
    const gap = PANEL_MARGIN_TOP - 11 - reductionPx; // `PANEL_MARGIN_TOP` is `--kanji-gap` (44) + `--size-main`/4 (11) at the design gap.
    const advance = ADVANCE - reductionPx;
    const panelMarginTop = gap + 11;
    const kundokuRow = panelMarginTop + Math.floor((0.6 * H - panelMarginTop) / advance) * advance + steps * advance;
    const measure = H - kundokuRow - PROSE_PADDING + (44 - gap); // prose's own bottom padding is `--kanji-gap` too.
    const counts = measure > 0 ? columnCounts(measure, SIZE_KAKIKUDASHI) : null;
    return {
      kundokuSlots: (kundokuRow - panelMarginTop) / advance,
      most: counts ? counts.most : 0,
    };
  }

  /** `verseFloorDivisionAtReducedAdvance`'s own search, transcribed over
   * `geometryAtGap` — the least whole-pixel `--kanji-gap` reduction, if any
   * within `maxReductionPx`, at which some step holds the poem's rime floor
   * without growing the kanbun past its own (unreduced) base and reaches
   * `target`. */
  function leastReductionReaching(H: number, target: number, maxReductionPx: number) {
    for (let reduction = 0; reduction <= maxReductionPx; reduction++) {
      for (let steps = -6; steps <= 6; steps++) {
        const g = geometryAtGap(H, steps, reduction);
        if (g.kundokuSlots !== floor) continue; // exactly the floor, as `verseFloorDivision` settles on the least step reaching it.
        if (g.most >= target) return { reduction, steps, most: g.most };
      }
    }
    return null;
  }

  it("needs 8 characters to the prose column so 別るるを恨みては鳥にも心を驚かす — 16 — takes at most two", () => {
    // Stated as its own check, so a future edit to the poem's readings that
    // moves this away from 16 shows up here first, against a comment that
    // says why 8, rather than silently changing what the next test expects.
    expect(longestProse).toBe(16);
    expect(twoColumnTarget).toBe(8);
  });

  it("at `.main` = 802, the least reduction reaching the target is 3px — `--kanji-gap` 41px, `--kanji-advance` 85px", () => {
    const found = leastReductionReaching(802, twoColumnTarget, 10);
    expect(found).toEqual({ reduction: 3, steps: 1, most: 8 });
    // The same figures `setVerseGapReduction` would write: `44 - 3 = 41`,
    // `88 - 3 = 85`.
    expect(44 - (found?.reduction ?? 0)).toBe(41);
    expect(88 - (found?.reduction ?? 0)).toBe(85);
  });

  it("the real `verseFloorDivisionAtReducedAdvance`, asked through this same geometry, agrees", () => {
    // The test above walks `geometryAtGap` directly, checking `kundokuSlots
    // === floor` itself; this instead hands `geometryAtGap` to the *real*,
    // exported search — the same function `fitPassageExtent` calls — through
    // an `at` shaped the way `panelAtReducedGap` shapes one, so a regression
    // in the search itself (not just in this file's model of the CSS) shows
    // up here. `kundoku`/`ceiling` are given fixed, arbitrary-but-consistent
    // values `verseFloorDivision`'s own bounds don't reject (`kundoku` never
    // above `base`'s, `ceiling` unused by the floor search) — the property
    // being checked is `kundokuSlots`-against-`floor` and `most`-against-
    // `target`, which `geometryAtGap` alone determines.
    const at = (gapReductionPx: number, steps: number) => {
      const g = geometryAtGap(802, steps, gapReductionPx);
      if (g.kundokuSlots < 1 || g.most < 1) return null;
      return { ceiling: g.most, most: g.most, kundoku: 880, kundokuSlots: g.kundokuSlots };
    };
    const found = verseFloorDivisionAtReducedAdvance(floor, -6, 6, 3, twoColumnTarget, 10, at);
    expect(found).toEqual({ steps: 1, slots: 8, gapReductionPx: 3 });
  });

  it("at `.main` = 823 and above, the design gap already clears the target — reduction 0, unmoved", () => {
    for (const H of [823, 824, 900, 1200, 1600]) {
      const found = leastReductionReaching(H, twoColumnTarget, 10);
      expect({ H, reduction: found?.reduction }).toEqual({ H, reduction: 0 });
    }
  });

  it("the 20% bound comfortably covers what 802px needs, with room for a longer line or a shorter window", () => {
    const maxReductionPx = Math.floor(44 * 0.2);
    expect(maxReductionPx).toBe(8);
    expect(leastReductionReaching(802, twoColumnTarget, maxReductionPx)?.reduction).toBe(3);
  });
});

describe("the two panels' lines, aligned", () => {
  const prose = proseLines("shunbou.conllu");
  const kanbun = kanbunLines("shunbou.conllu");
  const index = JSON.parse(readFileSync(join(DATA, "rime-index.json"), "utf-8")) as RimeIndex;
  const floor = rimeColumnFloor(parseConllu(readFileSync(join(DATA, "samples", "shunbou.conllu"), "utf-8")), index);
  const typography = readFileSync(join(ROOT, "src", "render", "typography.css"), "utf-8").replace(/\/\*[\s\S]*?\*\//g, "");

  it("states the two pitches as one relation, which is what the override leans on", () => {
    // `fitPassageExtent` writes `--line-height-kakikudashi: var(--column-pitch)`
    // for a poem set line to a column, and that is only "the kanbun's pitch"
    // while these two declarations hold. A change that broke the 2:1 relation
    // without touching the panel would otherwise make the override mean
    // something else silently.
    expect(typography).toContain("--column-pitch-kakikudashi: calc(var(--column-pitch) / 2)");
    expect(typography).toContain("--line-height-kakikudashi: var(--column-pitch-kakikudashi)");
  });

  it("puts line n of the prose where line n of the kanbun is, at every width the mode is on", () => {
    // The alignment rule, as arithmetic. Each panel sets one line to a column
    // in this mode, so with one pitch the two are the same distance along the
    // page for every line — an identity, with nothing added to the text.
    for (const H of [1030, 1042, 1100, 1200, 1300, 1400, 1600]) {
      const chosen = fit(prose, kanbun, H, floor, true);
      expect({ H, mode: chosen.mode }).toEqual({ H, mode: "line" });
      let kanbunAt = 0;
      let proseAt = 0;
      for (let line = 0; line < kanbun.length; line++) {
        expect({ H, line, kanbunAt, proseAt }).toEqual({ H, line, kanbunAt, proseAt: kanbunAt });
        kanbunAt += Math.max(1, Math.ceil(kanbun[line] / chosen.kundokuSlots)) * ADVANCE;
        // One pitch per column, and the pitch is now the kanbun's.
        proseAt += Math.max(1, Math.ceil(prose[line] / chosen.slots)) * ADVANCE;
      }
      // And so the two passages end together, which line-per-column mode had
      // given up when its columns were half as wide.
      expect({ H, prose: proseAt }).toEqual({ H, prose: kanbunAt });
    }
  });

  it("was half a page out before the pitch was equalised", () => {
    // What the reader saw: ten prose columns at 44px against ten kanbun columns
    // at 88, so every line of the 書き下し文 stood at half the distance of the
    // line it translates and the passage ended 440px short.
    const chosen = fit(prose, kanbun, 1100, floor, true);
    expect(extent(prose, chosen.slots, PROSE_PITCH)).toBe(440);
    expect(extent(kanbun, chosen.kundokuSlots, ADVANCE)).toBe(880);
  });
});

describe("prose is left to the extent match", () => {
  // The scoping, checked on the two prose samples this repository ships. Both
  // are lineated — 論語學而 breaks at every 章 and 酒蟲 at its two paragraphs —
  // so neither is excluded by having no breaks at all. What excludes them is
  // that a paragraph is not a column: their longest lines are 210 and 704
  // characters, and no division of any page holds one.
  for (const file of ["rongo-gakuji.conllu", "shuchu.conllu"]) {
    it(`declines ${file} at every height`, () => {
      const prose = proseLines(file);
      const kanbun = kanbunLines(file);
      expect(Math.max(...prose)).toBeGreaterThan(100);
      for (const H of [825, 900, 1000, 1200, 1400, 2000]) expect(division(prose, kanbun, H)).toBeNull();
    });
  }
});

// ---------------------------------------------------------------------------
// **The applied state — what every test above did not check.**
//
// Every assertion up to here measures `linePerColumnSplit`'s own *decision*:
// given an `at`, what division does it choose. That was true of this file
// before this round and it stayed true after: `geometry`'s `verse` flag makes
// the decision ask the honest question, but it is still only the decision
// being checked, by a model built to be internally consistent with itself.
// What none of it checked is the other half — whether `setColumnSlots` can
// actually *set* the division the decision handed down, once the page is the
// page the decision was supposedly reasoning about. `panelAtForLine`'s bug
// lived exactly in that gap, and a model that only ever asks the decision
// its own question cannot see a gap between the decision and the apply, by
// construction. This closes it: `appliedMeasure` is written once, standing
// for what `setColumnSlots` measures once `VERSE_PITCH` is really on the
// page, and every division `linePerColumnSplit` returns is checked against
// it rather than against whatever `at` happened to compute internally.
// ---------------------------------------------------------------------------

describe("the applied state: a chosen division has to be one setColumnSlots can set", () => {
  const prose = proseLines("shunbou.conllu");
  const kanbun = kanbunLines("shunbou.conllu");
  const index = JSON.parse(readFileSync(join(DATA, "rime-index.json"), "utf-8")) as RimeIndex;
  const floor = rimeColumnFloor(parseConllu(readFileSync(join(DATA, "samples", "shunbou.conllu"), "utf-8")), index);
  const line = longestLine(prose.map((n) => "　".repeat(n)).join("\n"));

  /** `linePerColumnSplit` asked the way `fitPassageExtent` asked it before
   * this round: against the padding standing on the box, `PITCH_PROPERTY`
   * never written — `geometry`'s default. `panelAt`, unwrapped, handed
   * straight to the search. */
  const staleAt = (H: number) => (steps: number) => {
    const g = geometry(H, steps, false);
    if (g.kundokuSlots < 1 || g.ceiling < 1) return null;
    return {
      ceiling: g.ceiling,
      most: g.most,
      kundoku: extent(kanbun, g.kundokuSlots, ADVANCE),
      kundokuSlots: g.kundokuSlots,
    };
  };

  /** `panelAtForLine`'s own transcription — see `geometry`'s `verse` flag and
   * `fit`'s `atForLine` above. */
  const honestAt = (H: number) => (steps: number) => {
    const g = geometry(H, steps, true);
    if (g.kundokuSlots < 1 || g.ceiling < 1) return null;
    return {
      ceiling: g.ceiling,
      most: g.most,
      kundoku: extent(kanbun, g.kundokuSlots, ADVANCE),
      kundokuSlots: g.kundokuSlots,
    };
  };

  it("caught the fault, before the fix, at 22 widths — every one from the old threshold to one short of the new", () => {
    // Reproduced rather than asserted from memory: the decision asked against
    // the stale padding, the achievability checked against `appliedMeasure`,
    // which is always the honest one — there is only one page a browser can
    // actually apply a division to. 1008 is where the *stale* decision first
    // believed sixteen fit (`columnCounts` at the undoubled padding's measure)
    // and 1030 is where the doubled padding's own measure first really holds
    // it (see "gives the poem a column a line from a `.main` of 1030px"
    // above); every width in between is exactly this fault, this poem, this
    // width — twenty-two widths, `1008` through `1029`.
    const caught: number[] = [];
    for (const H of WIDTHS) {
      const perLine = linePerColumnSplit(line, -6, staleAt(H), floor);
      if (perLine === null || perLine.slots === null) continue;
      const measure = appliedMeasure(H, perLine.steps);
      if (stretchedTracking(measure, SIZE_KAKIKUDASHI, perLine.slots) === null) caught.push(H);
    }
    expect(caught).toEqual(Array.from({ length: 22 }, (_, i) => 1008 + i));
  });

  it("holds at every width from 680px to 1600 once the decision asks the honest question", () => {
    // The standing guard. `honestAt` is `panelAtForLine`'s own transcription,
    // and `appliedMeasure` is the same sum stated independently — the fact
    // being checked is that a real fault reintroduced (the decision and the
    // apply disagreeing about which padding is in force) still shows up here
    // as a `null` tracking, not that this file's own arithmetic agrees with
    // itself.
    for (const H of WIDTHS) {
      const perLine = linePerColumnSplit(line, -6, honestAt(H), floor);
      if (perLine === null || perLine.slots === null) continue;
      const measure = appliedMeasure(H, perLine.steps);
      expect({ H, tracking: stretchedTracking(measure, SIZE_KAKIKUDASHI, perLine.slots) }).not.toEqual({
        H,
        tracking: null,
      });
    }
  });

  it("at a `.main` of 1020px, keeps the prose passage no longer than the kundoku's and no line starting before its counterpart", () => {
    // A round number below the 1030px line-per-column threshold, checked
    // directly rather than through the decision at all: whichever division
    // `fit` lands on — here, `verseFloorDivision`'s "floor" mode — the two
    // invariants the reader asked for hold: the padded prose must not
    // outrun the kanbun, and no prose line may sit above the kanbun line it
    // translates. **Not the reader's own `.main`** — that is 798, checked
    // next — kept because it is a round number well clear of every boundary
    // this file names, so a fault that only shows up near one of them would
    // not hide behind this test alone.
    const H = 1020;
    const chosen = fit(prose, kanbun, H, floor, true);
    expect(chosen.mode).toBe("floor");
    expect(chosen.slots).toBe(16);
    expect(chosen.kundokuSlots).toBe(6);

    const pitch = chosen.mode === "line" ? ADVANCE : PROSE_PITCH;
    const ratio = chosen.mode === "line" ? 1 : 2;
    const text = proseText("shunbou.conllu");
    const kanbunStarts = kanbunStartColumns(kanbun, chosen.kundokuSlots);
    const proseStarts = lineStartColumns(text, chosen.slots);
    const pads = planLinePadding(kanbunStarts, proseStarts, ratio);
    const { columns } = planHangingMarks(text, chosen.slots);
    const totalColumns = columns.length + pads.reduce((sum, pad) => sum + pad, 0);
    const proseExtent = totalColumns * pitch;
    const kundokuExtent = extent(kanbun, chosen.kundokuSlots, ADVANCE);

    // Nineteen columns of prose (ten written, nine of padding) against ten of
    // kanbun: 836px against 880, so the padded passage still ends 44px short
    // rather than running long.
    expect({ totalColumns, proseExtent, kundokuExtent }).toEqual({ totalColumns: 19, proseExtent: 836, kundokuExtent: 880 });
    expect(proseExtent).toBeLessThanOrEqual(kundokuExtent);

    let carried = 0;
    for (let l = 0; l < kanbun.length; l++) {
      carried += pads[l] ?? 0;
      const proseAbsolute = (proseStarts[l] + carried) * pitch;
      const kanbunAbsolute = kanbunStarts[l] * ADVANCE;
      expect({ l, proseAbsolute }).toEqual({ l, proseAbsolute: Math.max(proseAbsolute, kanbunAbsolute) });
    }
  });

  it("at the reader's own geometry, .main of 798px, gives the kanbun its rime floor and never starts a prose line before its counterpart", () => {
    // **The real number.** Measured in a real Chrome against the running dev
    // server: an outer window height of 1020px — the reader's own window —
    // leaves a `.main` of 798px, not 1020 (see `WIDTHS`'s own note for the
    // 222px of chrome that difference is). This is the geometry the reader
    // actually had, and it is the one the shipped `kundokuSlotsNow` got
    // wrong: measured off the *column* rather than the *container* (see
    // `kundokuColumnCapacity`, KakikudashiView.ts), it could report at most
    // five cells for this poem's five-character lines, one short of the
    // rime's floor of six, at every `.main` and every step alike — "the
    // measurement, not just the arithmetic" above states why that failure
    // was total and not a matter of degree. `fit` here is the *fixed*
    // measurement — `kundokuSlots` is the container's own capacity, exactly
    // as `verseFloorDivision` is stated — and at 798 it lands in "floor"
    // mode with the kanbun at its full six cells: the rime is drawn, not
    // clipped, which is the property this whole round exists to restore.
    const H = 798;
    const chosen = fit(prose, kanbun, H, floor, true);
    expect(chosen.mode).toBe("floor");
    expect(chosen.kundokuSlots).toBe(floor);
    expect(chosen.slots).toBe(6);

    // The one-sided guarantee `planLinePadding` makes — no prose line begins
    // before the kanbun line it translates — holds here regardless: it is
    // unconditional on `planLinePadding`'s own terms (see its note on why it
    // is always satisfiable) and does not depend on the *total* extent.
    const pitch = chosen.mode === "line" ? ADVANCE : PROSE_PITCH;
    const ratio = chosen.mode === "line" ? 1 : 2;
    const text = proseText("shunbou.conllu");
    const kanbunStarts = kanbunStartColumns(kanbun, chosen.kundokuSlots);
    const proseStarts = lineStartColumns(text, chosen.slots);
    const pads = planLinePadding(kanbunStarts, proseStarts, ratio);
    let carried = 0;
    for (let l = 0; l < kanbun.length; l++) {
      carried += pads[l] ?? 0;
      const proseAbsolute = (proseStarts[l] + carried) * pitch;
      const kanbunAbsolute = kanbunStarts[l] * ADVANCE;
      expect({ l, proseAbsolute }).toEqual({ l, proseAbsolute: Math.max(proseAbsolute, kanbunAbsolute) });
    }

    // What the *total* extent comes to at this width — 968px of padded prose
    // against the kanbun's 880 — is reported and not asserted within budget:
    // 798 is below the 823px floor `tests/lineAlignment.test.ts`'s "the prose
    // panel does not outrun the kanbun, for verse" already names as the point
    // below which the page cannot give both promises at once (a rime with
    // its cell, and a passage that does not outrun the one it translates).
    // Below it the rime wins, by the standing ruling, and this is what that
    // costs: 88px of overrun, not the total silence a clipped rime was.
    const { columns } = planHangingMarks(text, chosen.slots);
    const totalColumns = columns.length + pads.reduce((sum, pad) => sum + pad, 0);
    const proseExtent = totalColumns * pitch;
    const kundokuExtent = extent(kanbun, chosen.kundokuSlots, ADVANCE);
    expect({ totalColumns, proseExtent, kundokuExtent }).toEqual({ totalColumns: 22, proseExtent: 968, kundokuExtent: 880 });
  });
});

// ---------------------------------------------------------------------------
// **`kundokuColumnCapacity`, against a fake DOM.**
//
// Everything above is `fitPassageExtent`'s *decision*, transcribed as
// arithmetic that assumes `kundokuSlots` is the container's own capacity —
// which the shipped code did not measure. `kundokuColumnCapacity` is the
// function that now does, and it is the one piece of this whole mechanism
// that touches a real box rather than a model of one, so it is the one
// piece a pure-arithmetic sweep — however wide — cannot exercise: every
// `geometry` above *assumes* the fact this function is responsible for
// establishing. Checked here the way `tests/panelFitGesture.test.ts` checks
// `holdPanelMeasures` — a fake element carrying only the handful of DOM
// operations the function under test actually calls, run in this
// repository's `node` test environment (`vite.config.ts`), which has no
// `getComputedStyle` of its own to fall back on.
// ---------------------------------------------------------------------------

describe("kundokuColumnCapacity", () => {
  /** A `.tategaki-column` (`kundoku`) and the `.tategaki` container it sits
   * inside (`kundoku.parentElement`), each carrying only what the function
   * reads off it: the column's `--kanji-advance` and its own
   * `getBoundingClientRect`, the container's `paddingTop`/`paddingBottom`
   * and its own `getBoundingClientRect`. `columnHeight` and `containerHeight`
   * are independent parameters on purpose — see the real page's own figures
   * below, where they never agree. */
  function fakeColumn(
    columnHeight: number,
    containerHeight: number,
    advance: number,
    paddingTop: number,
    paddingBottom = 0,
  ) {
    const container = { getBoundingClientRect: () => ({ height: containerHeight }) };
    const column = { parentElement: container, getBoundingClientRect: () => ({ height: columnHeight }) };
    const styles = new Map<object, Record<string, string>>([
      [column, { "--kanji-advance": String(advance) }],
      [container, { paddingTop: `${paddingTop}px`, paddingBottom: `${paddingBottom}px` }],
    ]);
    return { column: column as unknown as HTMLElement, styles };
  }

  /** Stubs the one global this environment has none of, for the length of
   * `run`, and restores whatever was there before — there is nothing here
   * before the first test, so that is always `undefined`, but the guard
   * costs nothing and keeps this test file honest about not leaving a
   * global behind for whichever one runs after it. */
  function withComputedStyle<T>(styles: Map<object, Record<string, string>>, run: () => T): T {
    const previous = (globalThis as { getComputedStyle?: unknown }).getComputedStyle;
    (globalThis as { getComputedStyle?: unknown }).getComputedStyle = (el: object) => {
      const found = styles.get(el) ?? {};
      return { ...found, getPropertyValue: (name: string) => found[name as keyof typeof found] ?? "" };
    };
    try {
      return run();
    } finally {
      if (previous === undefined) delete (globalThis as { getComputedStyle?: unknown }).getComputedStyle;
      else (globalThis as { getComputedStyle?: unknown }).getComputedStyle = previous;
    }
  }

  it("reads the container's capacity, not the column's own rendered height — the fault this function replaces", () => {
    // The column is stuck at five cells (440px = 5 x 88), as a verse line's
    // own forced break leaves it regardless of the container — the container
    // has room for six (583px of box, 55px of padding-top, (583-55)/88 = 6).
    // The old code read `kundoku.getBoundingClientRect().height` directly and
    // would have answered 5 here; this answers 6, the container's own figure.
    const { column, styles } = fakeColumn(440, 583, 88, 55);
    expect(withComputedStyle(styles, () => kundokuColumnCapacity(column))).toBe(6);
    // Stated the other way, as the regression this guards: reading the
    // column's own box instead of the container's is exactly the bug, and
    // this is what it would still answer.
    expect(Math.round(440 / 88)).toBe(5);
  });

  it("matches the real page's own figures — checked in Chrome against the shipped 春望, `.main` at 746px", () => {
    // `--kundoku-extra-slots` at 1, 2, 3 and 4: the container grew every
    // time (a whole `--kanji-advance` a step, as tategaki.css's grid row
    // says it must) and the column measured 440px throughout, because no
    // line of this poem is longer than five characters and the container
    // was never short of that. `kundokuColumnCapacity` is checked against
    // both readings together, at every step, and answers the container's.
    for (const [containerHeight, cells] of [
      [495, 5],
      [583, 6],
      [671, 7],
      [759, 8],
    ] as const) {
      const { column, styles } = fakeColumn(440, containerHeight, 88, 55);
      expect({ containerHeight, capacity: withComputedStyle(styles, () => kundokuColumnCapacity(column)) }).toEqual({
        containerHeight,
        capacity: cells,
      });
    }
  });

  it("answers nothing where the advance is not a length, or the container has none to give", () => {
    const noAdvance = fakeColumn(440, 583, 0, 55);
    expect(withComputedStyle(noAdvance.styles, () => kundokuColumnCapacity(noAdvance.column))).toBe(0);
    const negativeMeasure = fakeColumn(440, 50, 88, 55);
    expect(withComputedStyle(negativeMeasure.styles, () => kundokuColumnCapacity(negativeMeasure.column))).toBe(0);
    const orphan = { getBoundingClientRect: () => ({ height: 440 }) } as unknown as HTMLElement;
    const styles = new Map<object, Record<string, string>>([[orphan, { "--kanji-advance": "88" }]]);
    expect(withComputedStyle(styles, () => kundokuColumnCapacity(orphan))).toBe(0);
  });
});
