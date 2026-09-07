import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Token, TokenTree } from "../src/parse/types.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { sourceLayoutOf } from "../src/parse/sourceLayout.ts";
// The real text pipeline, for the deal at the foot of this file: the pages it
// counts widows on are dealt from real parses read into real 書き下し文.
import { generateKakikudashiPiecesForTree, sentenceSeparator } from "../src/kakikudashi/generator.ts";
import { createReadingResolver } from "../src/reading/readingResolver.ts";
import type { KanjidicIndex } from "../src/reading/kanjidicLookup.ts";
import type { JmdictIndex } from "../src/reading/jmdictLookup.ts";
// The model `endsColumnFlush` asks. Imported here as well so that the tests
// for it can check its answer against the thing it is asking, rather than
// against a second copy of the same reasoning.
import { planHangingMarks } from "../src/render/KakikudashiView.ts";
import {
  bandHeightsMm,
  blockBegunIn,
  blockHandedOn,
  endsColumnFlush,
  filledKundokuAdvancePx,
  defaultProseSlots,
  flushThrough,
  printTypeScaleLengths,
  kundokuSlotsFor,
  matchedProseSlots,
  proseSlotCeiling,
  widowOrphanFree,
  pageThrough,
  pairedCuts,
  proseSlotChoices,
  unpairedCuts,
  type CutUnit,
} from "../src/render/printLayout.ts";

// ---------------------------------------------------------------------------
// Printing the two panels: dealing the text into pages, and dividing the sheet
// between the two bands.
//
// **There is no browser in this suite and no document either** (the vitest
// environment is `node`), so `scrollWidth`, `clientWidth` and
// `getBoundingClientRect` are not merely wrong here, they are absent. Every
// quantity a print layout is decided from is a measurement, which is why
// printLayout.ts is written the way `fittedTracking` and `matchedDivision` are
// (KakikudashiView.ts, and tests/kakikudashiColumnFit.test.ts beside them):
// the measurement is a *parameter*, and what is left is arithmetic and a
// decision, both of which are checkable with no layout engine anywhere near
// them.
//
// So what is checked below is:
//
//  - **the deal**, `pageThrough`, which is where the bug the reader reported
//    lived. The old loop asked `overflows(band)` — whether the band is
//    overflowing *at all*, not whether the sentence just added is what made it
//    overflow — so the first sentence too long for a band on its own left the
//    band permanently over its width, and every later sentence found it so and
//    was pushed to a page of its own. One paragraph per page for the rest of
//    the document. The tests below are that failure written down as a
//    property: a piece that does not fit anywhere must not cost the pieces
//    after it their page.
//
//  - **the cut**, `pairedCuts`, which is what lets a page end in the middle of
//    a paragraph without the two bands coming apart. The two panels write the
//    same sentence in different orders — the kanbun in source order above, the
//    same sentence read below — so this is a fact about two sequences and is
//    exactly the kind of thing that belongs in a test with no rendering in it.
//
//  - **the heights**, `bandHeightsMm` and the choice between them, which are
//    the arithmetic of the sheet — and `filledKundokuAdvancePx`, which spends
//    what the choice leaves over.
//
// What cannot be checked here, and cannot be checked at all in this
// repository as it stands: that a browser lays a 116.92mm band out as five
// kundoku characters and a 47.36mm band as six prose ones, that the two bands
// then really do come to the same length on paper, and that the continuation
// pages `spreadSpill` writes reveal the spilled columns rather than blank
// paper. Those want a print preview and a reader's eye.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The deal.
//
// A page is modelled as a capacity and the pieces as lengths, which is what a
// band is: a fixed width across the page, and a passage that runs a measurable
// distance into it. `fitsThrough` is the whole of what a browser is for here,
// and it is handed in.
// ---------------------------------------------------------------------------

/** A page of `capacity`, holding pieces of the given lengths. Answers the
 * `fitsThrough` `pageThrough` asks for, and records what it was asked, since
 * every question is a forced layout on the real page and the count is part of
 * what the bisection is for. */
function sheet(lengths: readonly number[], capacity: number, alreadyOn = 0, from = 0) {
  const asked: number[] = [];
  return {
    asked,
    fitsThrough(last: number): boolean {
      asked.push(last);
      let extent = alreadyOn;
      // From `from`, not from nothing: the pieces before it are on the page
      // before this one, which is what makes a paragraph continue rather than
      // start again.
      for (let at = from; at <= last; at++) extent += lengths[at];
      return extent <= capacity;
    },
  };
}

describe("pageThrough", () => {
  it("takes the whole remainder in one question where it fits", () => {
    // The ordinary case, and it has to stay cheap: a document of sentences
    // that fit is one probe per sentence, exactly as the old deal was.
    const page = sheet([10, 10, 10], 100);
    expect(pageThrough(0, 3, true, page.fitsThrough)).toEqual({ through: 2, spills: false });
    expect(page.asked).toEqual([2]);
  });

  it("fills the page and hands the rest to the next one", () => {
    // Four pieces of 30 into a page of 100: three fit, the fourth does not,
    // and the page is *full* rather than finished — nothing has spilled.
    const page = sheet([30, 30, 30, 30], 100);
    expect(pageThrough(0, 4, true, page.fitsThrough)).toEqual({ through: 2, spills: false });
    // And the page is left holding exactly what it answered with, since the
    // caller reads the DOM this leaves behind and does not re-place it.
    expect(page.asked[page.asked.length - 1]).toBe(2);
  });

  it("leaves an oversized piece where it is, and finishes the page", () => {
    // The one case the deal cannot solve by breaking: a piece longer than an
    // empty page. It stays — there is nowhere better for it — and `spills`
    // says so, which is what stops the page from being offered any more text.
    const page = sheet([500, 10, 10], 100);
    expect(pageThrough(0, 3, true, page.fitsThrough)).toEqual({ through: 0, spills: true });
  });

  it("does not let one oversized piece cost the pieces after it their page", () => {
    // **The reported bug, as a property.** A 500 among four 20s in a page of
    // 100: the 500 takes a page of its own, and the four that follow must
    // share the next one — not take four pages between them, which is what
    // asking "is this band overflowing" rather than "did this piece overflow
    // it" produced for the rest of the document.
    const lengths = [500, 20, 20, 20, 20];
    const pages: number[][] = [];
    let from = 0;
    while (from < lengths.length) {
      const page = sheet(lengths.slice(from), 100);
      const { through, spills } = pageThrough(0, lengths.length - from, true, page.fitsThrough);
      pages.push(lengths.slice(from, from + through + 1));
      expect(spills).toBe(through === 0 && lengths[from] > 100);
      from += through + 1;
    }
    expect(pages).toEqual([[500], [20, 20, 20, 20]]);
  });

  it("answers 'none of it' where the page already holds something", () => {
    // The page is 80 full of the sentence before, and nothing of this one
    // fits. `through` is below `from`, which is the caller's signal to take
    // the empty spans off again and open a page — *not* to keep the piece and
    // let it spill, which is only ever right on a page of its own.
    const page = sheet([30, 30], 100, 80);
    expect(pageThrough(0, 2, false, page.fitsThrough)).toEqual({ through: -1, spills: false });
  });

  it("asks about the sentence a logarithm of times, not a piece at a time", () => {
    // Every question is a write to the DOM and a read of it, which is a forced
    // synchronous layout of the whole page; a sentence of a thousand pieces
    // must not be a thousand of them. Adding text can only lengthen a band, so
    // the answer is monotone and the search is a bisection.
    const lengths = Array.from({ length: 1000 }, () => 1);
    const page = sheet(lengths, 100);
    expect(pageThrough(0, 1000, true, page.fitsThrough)).toEqual({ through: 99, spills: false });
    expect(page.asked.length).toBeLessThan(15);
  });

  it("leaves the page holding exactly what it answered", () => {
    // The last question asked is the answer, so the caller's DOM is already in
    // the state the answer describes and nothing has to be replaced.
    const page = sheet([30, 30, 30, 30], 100);
    const { through } = pageThrough(0, 4, true, page.fitsThrough);
    expect(page.asked[page.asked.length - 1]).toBe(through);
  });

  it("continues a sentence from where the last page left it", () => {
    // `from` is not always zero: a paragraph divided across a break is dealt
    // again from its first unplaced piece, on a page that is empty because the
    // break has just been taken. The two pieces already printed cost this page
    // nothing — which is the whole of what "continuous" means here.
    const page = sheet([40, 40, 60, 60], 100, 0, 2);
    expect(pageThrough(2, 4, true, page.fitsThrough)).toEqual({ through: 2, spills: false });
  });
});

// ---------------------------------------------------------------------------
// The cut.
//
// A `.sentence-gap`'s top-level children, as the two panels write them. The
// kundoku column is the kanbun in source order (`renderSentence` walks the
// sentence's tokens sorted by id); the prose is that sentence *read*, so its
// order is the reading order the kaeriten describe. A page may only end where
// the two have caught up with each other.
// ---------------------------------------------------------------------------

const cell = (...ids: number[]): CutUnit => ({ ids, breaks: false });
/** A child that puts nothing on the page: a `<br>`, an indent, the text node a
 * sentence separator is written as. */
const bare = (): CutUnit => ({ ids: [], breaks: false });
const br = (): CutUnit => ({ ids: [], breaks: true });

describe("pairedCuts", () => {
  it("cuts where the two orders agree, and nowhere else", () => {
    // 不読書 — 書を読まず. The kundoku column has 不 読 書 in that order; the
    // prose writes 書 first, then 読, then the negation the 不 causes. Nothing
    // before the end is a place both panels have said the same thing, so there
    // is no way to divide this across a page break and the sentence is dealt
    // whole.
    expect(pairedCuts([cell(1), cell(2), cell(3)], [cell(3), cell(2), cell(1)])).toEqual([]);
  });

  it("finds a cut wherever a reordering has closed", () => {
    // 學而時習之 — 學びて時に之を習ふ: the first three characters are read in
    // source order and the last two are turned round. So the orders agree
    // after each of the first three, and again only at the end.
    const kundoku = [cell(1), cell(2), cell(3), cell(4), cell(5)];
    const prose = [cell(1), cell(2), cell(3), cell(5), cell(4)];
    expect(pairedCuts(kundoku, prose)).toEqual([
      { kundoku: 1, prose: 1 },
      { kundoku: 2, prose: 2 },
      { kundoku: 3, prose: 3 },
    ]);
  });

  it("counts a token once however many children carry it", () => {
    // A compound is one `.compound-group` above and several `.kaki-token`
    // spans below — a word and its ending share an id (`Piece.tokenId`) — so
    // the same token is introduced by one child in one panel and by two in the
    // other. What matters is where it is *first* written.
    expect(pairedCuts([cell(1, 2), cell(3)], [cell(1), cell(2), cell(3)])).toEqual([{ kundoku: 1, prose: 2 }]);
  });

  it("never cuts inside a child", () => {
    // A `.compound-group` is one child holding a whole compound and a
    // `.no-break-unit` is one child holding a character with the mark glued
    // after it (行末/行頭禁則 — `glueOpeningPunctForward` and `appendPunct` in
    // KundokuView.ts). The prose writes the same tokens as several spans, so
    // the orders agree part way through the group — and there is still no
    // boundary here to cut at, the page turn falling inside a box neither rule
    // allows to be opened.
    expect(pairedCuts([cell(1, 2, 3)], [cell(1), cell(2), cell(3)])).toEqual([]);
  });

  it("moves a cut past what puts nothing on the page", () => {
    // A mark of punctuation the prose renders as a bare text node, and the
    // separator written straight onto the `.sentence-gap`: a cut before them
    // would open the next page with a 。, which is 行頭禁則 broken by the
    // pagination itself. They stay with the character they follow.
    expect(pairedCuts([cell(1), bare(), cell(2)], [cell(1), bare(), cell(2)])).toEqual([{ kundoku: 2, prose: 2 }]);
  });

  it("keeps a source line break with the line it starts", () => {
    // A `<br>` is where the source began a new line, and the indent behind it
    // is that line's 一字下げ. Both belong to the text that follows, so the cut
    // stops in front of the break rather than being pushed past it — and the
    // band that then begins with a `<br>` has it taken off, the page turn
    // being a new column already.
    const kundoku = [cell(1), br(), bare(), cell(2)];
    const prose = [cell(1), br(), bare(), cell(2)];
    expect(pairedCuts(kundoku, prose)).toEqual([{ kundoku: 1, prose: 1 }]);
  });

  it("lets a token only one panel writes go with its neighbours", () => {
    // The kundoku column writes a cell for every PUNCT token; the generator
    // writes prose for one only where `medialPunctuation` gives it something
    // to write. A mark that reaches one panel and not the other constrains
    // nothing — it sits between two children that *are* paired — so the cuts
    // around it stand, where insisting the two panels write the same tokens
    // would have refused this sentence a cut at all.
    expect(pairedCuts([cell(1), cell(99), cell(2)], [cell(1), cell(2)])).toEqual([{ kundoku: 2, prose: 1 }]);
  });

  it("offers no cut inside a sentence with nothing in common", () => {
    // Not a state the panels are expected to reach; the answer is the one that
    // cannot put them out of step — deal the sentence whole, as the deal did
    // with every sentence before there were cuts at all.
    expect(pairedCuts([cell(1), cell(2)], [cell(7), cell(8)])).toEqual([]);
  });

  it("never offers the sentence's own end as a cut", () => {
    // The deal already has that boundary. Offering it again would make a piece
    // with nothing in it.
    const cuts = pairedCuts([cell(1), cell(2)], [cell(1), cell(2)]);
    expect(cuts).toEqual([{ kundoku: 1, prose: 1 }]);
  });

  it("offers strictly increasing cuts on both sides", () => {
    // The pieces are the gaps between consecutive cuts, so a cut that did not
    // advance both indices would be an empty piece in one band and text in the
    // other — the two bands out of step by exactly the thing this function
    // exists to prevent.
    const kundoku = [cell(1), bare(), cell(2), cell(3), br(), cell(4)];
    const prose = [cell(1), cell(2), bare(), cell(3), br(), cell(4)];
    const cuts = pairedCuts(kundoku, prose);
    for (let at = 1; at < cuts.length; at++) {
      expect(cuts[at].kundoku).toBeGreaterThan(cuts[at - 1].kundoku);
      expect(cuts[at].prose).toBeGreaterThan(cuts[at - 1].prose);
    }
    expect(cuts.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// And on real reordering.
//
// The cuts above are hand-written orders. This is the same question asked of
// the parse trees this repository keeps — the four openings of the Analects in
// `tests/fixtures/analects-raw-parses.json` — with the two panels' orders taken
// from where they actually come from: the kundoku column writes the tokens
// sorted by id (`renderSentence`), and the prose walks `plan.order`, the
// reading order `computeReadingOrder` answers with (`generateKakikudashiPieces`
// iterates exactly that).
//
// It is a model of the two columns and not the columns themselves: one child
// per token, where the DOM merges a compound into one `.compound-group` and
// glues a mark into the `.no-break-unit` of the character before it. Both of
// those only *remove* cuts (`pairedCuts` refuses to cut inside a child), and
// the prose's extra pieces — an ending, a case particle, a connective — carry
// their token's own id and add none. So this is the optimistic bound, which is
// the useful direction: what it has to show is that the pieces are far shorter
// than a page, and a bound that is too generous would fail to.
// ---------------------------------------------------------------------------

const fixtures: Record<string, Token[][]> = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/analects-raw-parses.json", import.meta.url)), "utf-8"),
);

describe("pairedCuts, on the parses in the fixtures", () => {
  it("cuts a real sentence every character or two", () => {
    // 8 clauses, 44 tokens, 21 cuts — a piece of 1.5 tokens on average and six
    // at the longest, against the 55 kanbun characters a sheet holds (11
    // columns of five). So a paragraph is dealt onto a page in pieces small
    // enough that a page ends within a character or two of full, and a piece
    // too long for a whole sheet is not a thing this text can produce.
    let tokens = 0;
    let cuts = 0;
    let clauses = 0;
    let longest = 0;
    for (const parses of Object.values(fixtures)) {
      for (const sentence of parses.map((t) => ({ tokens: t }))) {
        const plan = computeReadingOrder(sentence);
        const source = [...sentence.tokens].sort((a, b) => a.id - b.id).map((t) => cell(t.id));
        const reading = plan.order.map((id) => cell(id));
        const found = pairedCuts(source, reading);
        tokens += source.length;
        cuts += found.length;
        clauses += 1;
        let previous = 0;
        for (const cut of found) {
          longest = Math.max(longest, cut.kundoku - previous);
          previous = cut.kundoku;
        }
        longest = Math.max(longest, source.length - previous);
      }
    }
    expect({ clauses, tokens, cuts }).toEqual({ clauses: 8, tokens: 44, cuts: 21 });
    expect(longest).toBe(6);
    // Which is the claim, in the units the sheet is measured in.
    expect(longest).toBeLessThan(55);
  });

  it("puts the two panels' orders on either side of every cut it offers", () => {
    // The invariant itself, checked against real reordering rather than
    // asserted: at every cut, the tokens the kundoku column has written are
    // exactly the tokens the prose has. If this can fail, page n of one band is
    // not page n of the other, and the layout has no reason to exist.
    for (const parses of Object.values(fixtures)) {
      for (const sentence of parses.map((t) => ({ tokens: t }))) {
        const plan = computeReadingOrder(sentence);
        const source = [...sentence.tokens].sort((a, b) => a.id - b.id).map((t) => t.id);
        for (const cut of pairedCuts(
          source.map((id) => cell(id)),
          plan.order.map((id) => cell(id)),
        )) {
          const above = new Set(source.slice(0, cut.kundoku));
          const below = new Set(plan.order.slice(0, cut.prose));
          expect([...above].sort((a, b) => a - b)).toEqual([...below].sort((a, b) => a - b));
        }
      }
    }
  });
});

describe("unpairedCuts", () => {
  it("cuts at every child where there is no prose to keep in step", () => {
    // The reader having shut the 書き下し文 panel: the kundoku band has the
    // page to itself and nothing to correspond with, so every boundary between
    // two children is a place the page may end.
    expect(unpairedCuts([cell(1), cell(2), cell(3)])).toEqual([
      { kundoku: 1, prose: 1 },
      { kundoku: 2, prose: 2 },
    ]);
  });

  it("still does not cut in front of what puts nothing on the page", () => {
    // Same rule as the paired case: an indent goes with the line it indents, a
    // mark with the character it follows.
    expect(unpairedCuts([cell(1), bare(), cell(2), br(), cell(3)])).toEqual([
      { kundoku: 2, prose: 2 },
      { kundoku: 3, prose: 3 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The sheet, divided.
//
// A4 landscape less 14mm of margin is 269 x 182mm, and the two bands are
// allowed 178mm of the 182. Under vertical-rl a band's *height* is the length
// of one column, so a taller band holds more characters per column, needs
// fewer columns, and comes to a **shorter** horizontal length for the same
// text — which is the whole reason the two heights are what decides whether
// the two bands end together.
//
// The advances are the shipped type scale's, measured off a live band by
// `advanceDown` and stated here as what they come to: 88px down a kundoku
// column (a 44px character and the 44px gap that follows it) and 25.3px down a
// prose one (22px at the drawn 0.15em tracking, a print band going through no
// fit).
// ---------------------------------------------------------------------------

const KUNDOKU_ADVANCE = 88;
const PROSE_ADVANCE = 25.3;
const MM_PER_PX = 25.4 / 96;

describe("bandHeightsMm", () => {
  it("gives each band a whole number of characters and a cushion", () => {
    const heights = bandHeightsMm(5, 6, KUNDOKU_ADVANCE, PROSE_ADVANCE);
    // Five kundoku characters is 440px, which is 116.42mm.
    expect(heights.kundoku).toBeCloseTo(440 * MM_PER_PX + 0.5, 6);
    expect(heights.kundoku).toBeCloseTo(116.917, 3);
    // Six prose characters and the seventh advance the hang needs at the foot
    // of every column: 177.1px, 46.86mm.
    expect(heights.kakikudashi).toBeCloseTo(7 * PROSE_ADVANCE * MM_PER_PX + 0.5, 6);
    expect(heights.kakikudashi).toBeCloseTo(47.358, 3);
  });

  it("holds the count it was sized for, cushion and all", () => {
    // The point of the cushion: a band sized at exactly `slots x advance` is a
    // band one rounding away from holding a character fewer, since a line
    // breaker floors. It must never be enough to buy a character either.
    for (let slots = 4; slots <= 8; slots++) {
      const heights = bandHeightsMm(5, slots, KUNDOKU_ADVANCE, PROSE_ADVANCE);
      const measure = heights.kakikudashi / MM_PER_PX - PROSE_ADVANCE; // less the hanging room
      expect(Math.floor(measure / PROSE_ADVANCE)).toBe(slots);
    }
    const kundoku = bandHeightsMm(5, 6, KUNDOKU_ADVANCE, PROSE_ADVANCE).kundoku / MM_PER_PX;
    expect(Math.floor(kundoku / KUNDOKU_ADVANCE)).toBe(5);
  });

  it("keeps every pair inside the sheet", () => {
    // 178mm of the 182 between the margins, which is what the two bands have
    // always taken (they were 103 and 75). The widest pair comes to 177.66.
    for (let slots = 4; slots <= 8; slots++) {
      const heights = bandHeightsMm(5, slots, KUNDOKU_ADVANCE, PROSE_ADVANCE);
      expect(heights.kundoku + heights.kakikudashi).toBeLessThanOrEqual(178);
    }
    const widest = bandHeightsMm(5, 8, KUNDOKU_ADVANCE, PROSE_ADVANCE);
    expect(widest.kundoku + widest.kakikudashi).toBeCloseTo(177.662, 3);
  });
});

describe("the column lengths the scale chooses", () => {
  // **The three constants that did not derive, and now do.** `KUNDOKU_SLOTS`
  // was 5, the prose ceiling 8 and the fallback 6, each with a paragraph of
  // reasoning behind it in printLayout.ts and none of the reasoning left in
  // the code. The reader has asked for the print type at 33/60, and a frozen
  // constant is the one thing that would have kept its old value in silence.
  //
  // Every one of them is checked here against the number it replaces, at the
  // scale it was chosen at. **That agreement is the argument**: these are not
  // new choices, they are the old choices with the arithmetic left in.
  const drawn = { kundoku: 88, prose: 25.3 };
  const print = { kundoku: 88 * (33 / 60), prose: 25.3 * (33 / 60) };

  it("answers the shipped five and eight and six, at the scale they were chosen at", () => {
    expect(kundokuSlotsFor(drawn.kundoku, drawn.prose)).toBe(5);
    expect(proseSlotCeiling(5, drawn.kundoku, drawn.prose)).toBe(8);
    expect(defaultProseSlots(5)).toBe(6);
    // And the bands they come to are the millimetres the head of the file
    // records: 116.92mm of kundoku, 60.75mm of prose at the longest, 177.66mm
    // for the pair against a budget of 178.
    const heights = bandHeightsMm(5, 8, drawn.kundoku, drawn.prose);
    expect(heights.kundoku).toBeCloseTo(116.92, 2);
    expect(heights.kakikudashi).toBeCloseTo(60.75, 2);
    expect(heights.kundoku + heights.kakikudashi).toBeCloseTo(177.66, 2);
  });

  it("answers ten and twelve at 33/60, and fills the same sheet", () => {
    expect(kundokuSlotsFor(print.kundoku, print.prose)).toBe(10);
    expect(proseSlotCeiling(10, print.kundoku, print.prose)).toBe(12);
    expect(defaultProseSlots(10)).toBe(12);
    const heights = bandHeightsMm(10, 12, print.kundoku, print.prose);
    expect(heights.kundoku + heights.kakikudashi).toBeLessThanOrEqual(178);
    expect(heights.kundoku + heights.kakikudashi).toBeGreaterThan(176);
  });

  it("shows what the frozen five would have cost the rescaled sheet", () => {
    // The failure the derivation exists to prevent, priced. Five characters at
    // the print advance is a 64.53mm band, and the match beside it asks for a
    // prose column of six — 26.27mm. The pair stands at 90.8mm of 178, so 87mm
    // of every sheet would have been blank, and the fit test would have passed
    // it without a word.
    const frozen = bandHeightsMm(5, 6, print.kundoku, print.prose);
    expect(frozen.kundoku).toBeCloseTo(64.53, 2);
    expect(frozen.kakikudashi).toBeCloseTo(26.27, 2);
    expect(178 - (frozen.kundoku + frozen.kakikudashi)).toBeCloseTo(87.2, 1);
  });

  it("keeps the pitch lock, so the widow threshold's derivation survives", () => {
    // `WIDOW_ORPHAN_COLUMNS` is two because two prose columns are exactly one
    // kundoku column — `--column-pitch-kakikudashi: calc(--column-pitch / 2)`,
    // by construction in typography.css and rewritten as such by
    // `applyPrintTypeScale`. It is a ratio, so it is scale-free: at 33/60 the
    // kundoku pitch is 48.4px and the prose pitch 24.2px, and a page carries
    // 21 kundoku columns against 42 prose ones. **The derivation stands
    // unchanged.**
    const width = 269 / (25.4 / 96);
    for (const scale of [1, 33 / 60, 0.5, 2]) {
      // The lock itself, which is what the threshold rests on and is exact at
      // every scale.
      expect(88 * scale).toBeCloseTo(2 * (44 * scale), 10);
      // The columns a page carries are that ratio less what the page width
      // rounds away, so they are twice as many give or take one — 11 against
      // 23 at the drawn scale, 21 against 42 at 33/60.
      const kundoku = Math.floor(width / (88 * scale));
      const prose = Math.floor(width / (44 * scale));
      expect(prose - 2 * kundoku).toBeGreaterThanOrEqual(0);
      expect(prose - 2 * kundoku).toBeLessThanOrEqual(1);
    }
    expect(Math.floor(width / (88 * (33 / 60)))).toBe(21);
    expect(Math.floor(width / (44 * (33 / 60)))).toBe(42);
  });
});

describe("proseSlotChoices", () => {
  it("offers the five column lengths a five-character kundoku band leaves room for", () => {
    expect(proseSlotChoices(5, KUNDOKU_ADVANCE, PROSE_ADVANCE)).toEqual([4, 5, 6, 7, 8]);
  });

  it("stops offering what the sheet cannot carry", () => {
    // Six kundoku characters is 140.20mm with its cushion, and what is left of
    // the 178 holds four prose characters — a prose column answering to a text
    // whose translation is a third as long again as its original, which is
    // under anything a kanbun text comes to. That is why the kundoku column is
    // five and not six.
    expect(proseSlotChoices(6, KUNDOKU_ADVANCE, PROSE_ADVANCE)).toEqual([4]);
    // And seven leaves nothing worth setting at all.
    expect(proseSlotChoices(7, KUNDOKU_ADVANCE, PROSE_ADVANCE)).toEqual([]);
  });

  it("gives a four-character kundoku column the room five cannot", () => {
    // Kept as the measurement behind the choice rather than as an offer: four
    // would carry a text of up to r = 5.5, and costs a fifth of every page
    // (44 kanbun characters to the sheet against 55) to do it.
    // The ceiling is `proseSlotCeiling`'s now rather than a constant 8, so a
    // four-character kundoku column is offered everything its own leftover can
    // hold — eleven — where five is offered eight.
    expect(proseSlotChoices(4, KUNDOKU_ADVANCE, PROSE_ADVANCE)).toEqual([4, 5, 6, 7, 8, 9, 10, 11]);
    expect(proseSlotChoices(5, KUNDOKU_ADVANCE, PROSE_ADVANCE)).toEqual([4, 5, 6, 7, 8]);
    expect(proseSlotChoices(4, KUNDOKU_ADVANCE, PROSE_ADVANCE, 240)).toContain(8);
  });
});

// ---------------------------------------------------------------------------
// The match.
//
// 酒蟲, column for column, out of `tests/kakikudashiColumnFit.test.ts`, which
// counts it through the text pipeline: 271 kundoku cells and 652 characters of
// prose, wrapped a source line at a time. The kundoku band is fixed at five
// characters to the column, so the target is fixed too; what moves is the
// prose column, and the extents are a staircase.
//
// These are the *modelled* counts, as they are there — a browser's own line
// breaking spends the odd extra column on 禁則 and the hang takes some of them
// back, which is why the layout measures rather than divides. What is being
// checked is the choice, which is arithmetic.
// ---------------------------------------------------------------------------

const SHUCHU_KUNDOKU: Record<number, number> = { 4: 69, 5: 55, 6: 47 };
const SHUCHU_PROSE: Record<number, number> = { 4: 164, 5: 131, 6: 110, 7: 94, 8: 83 };
const proseExtent = (slots: number) => (SHUCHU_PROSE[slots] ?? 0) * 44;

describe("matchedProseSlots", () => {
  it("lands on the passage above it, to the pixel", () => {
    // The kundoku band at five characters is 55 columns and 4840px. Six
    // characters of prose is 110 columns of half the pitch, which is 4840px —
    // the same length to the pixel. Nothing arranges that; it is what the two
    // texts happen to come to, and it is the same division the screen fit
    // chooses at the shipped viewport (`matchedDivision`'s own first test).
    const target = SHUCHU_KUNDOKU[5] * 88;
    expect(target).toBe(4840);
    expect(proseExtent(6)).toBe(4840);
    expect(matchedProseSlots(target, [4, 5, 6, 7, 8], proseExtent)).toBe(6);
  });

  it("takes the nearer miss where no column lands on the target", () => {
    // A text a fifth wordier in the prose than 酒蟲 would want 7.2 characters
    // to the column; seven runs 94 x 44 = 4136px against a 4840px target and
    // eight runs 3652px, so seven it is.
    expect(matchedProseSlots(4600, [7, 8], proseExtent)).toBe(7);
    // And the miss really is the smaller of the two the staircase offers.
    expect(4600 - proseExtent(7)).toBe(464);
    expect(4600 - proseExtent(8)).toBe(948);
  });

  it("keeps the longer column where two lengths miss by the same amount", () => {
    // The fuller band, and the setting nearest the tracking the type is drawn
    // at — `matchedSlots`' own convention, for the panel this answers for.
    const target = (proseExtent(6) + proseExtent(7)) / 2;
    expect(matchedProseSlots(target, [6, 7], proseExtent)).toBe(7);
  });

  it("declines where there is nothing to measure", () => {
    // No prose in the document, a kundoku passage with no extent, or a
    // collapsed panel. The caller falls back to six — the division 酒蟲 and
    // the screen fit both come to — rather than choosing from nothing.
    expect(matchedProseSlots(0, [4, 5, 6], proseExtent)).toBeNull();
    expect(matchedProseSlots(4840, [], proseExtent)).toBeNull();
    expect(matchedProseSlots(4840, [4, 5, 6], () => 0)).toBeNull();
  });

  it("matches the text it is given, not the text this one is", () => {
    // The whole reason the choice is measured. `r` — characters of prose to a
    // kanbun character — is a property of the text, and the repository's own
    // range for it is two to three. At `nk` = 5 the matching column is
    // `2.5 x r`, so the five offered lengths answer to r = 1.6, 2.0, 2.4, 2.8
    // and 3.2, and cover that range with a column to spare at each end.
    const cells = 271;
    for (const [r, wanted] of [
      [2.0, 5],
      [2.4, 6],
      [2.8, 7],
    ] as const) {
      // A modelled passage at ratio `r`: the prose runs `44 x characters /
      // slots` and the kundoku `88 x cells / 5`.
      const extentAt = (slots: number) => (44 * (cells * r)) / slots;
      expect(matchedProseSlots((88 * cells) / 5, [4, 5, 6, 7, 8], extentAt)).toBe(wanted);
    }
  });
});

// ---------------------------------------------------------------------------
// Filling the sheet.
//
// The match above chooses the two *counts*; it does not fill the page. Five
// kundoku characters and six prose ones come to 164.27mm of the 178 the bands
// are allowed, so a printed sheet came back with 13.73mm blank below the prose
// band, on top of the 14mm margin — which is what the reader reported.
//
// `filledKundokuAdvancePx` spends it the way the screen spends exactly this
// leftover (`fittedTracking` in KakikudashiView.ts, and the head of
// tests/kakikudashiColumnFit.test.ts beside it): the band grows and the growth
// goes into the space *between* the characters, so the column still holds a
// whole number of them and there is no remainder at its foot. All of it goes
// to the kundoku band — printLayout.ts argues that at length, in millimetres —
// so the prose band, its tracking, and the hang that is computed from them are
// exactly what they were.
//
// The two properties that make this safe to add to a layout already confirmed
// on paper are the first two checks below: the count per column and the
// columns per page are both untouched, so every page breaks where it broke.
// ---------------------------------------------------------------------------

/** The band the fill produces for a given prose column length, in the terms
 * `planBands` puts it in: the prose band at its matched height, the kundoku
 * advance stretched into what is left, and the kundoku band that comes to. */
function filled(proseSlots: number, kundokuSlots = 5) {
  const prose = bandHeightsMm(kundokuSlots, proseSlots, KUNDOKU_ADVANCE, PROSE_ADVANCE).kakikudashi;
  const advance = filledKundokuAdvancePx(kundokuSlots, prose, KUNDOKU_ADVANCE);
  const kundoku = bandHeightsMm(kundokuSlots, 0, advance, PROSE_ADVANCE).kundoku;
  return { prose, advance, kundoku, pair: kundoku + prose, gapRatio: (advance - 44) / 44 };
}

describe("filledKundokuAdvancePx", () => {
  it("keeps the count the match chose, at every column length", () => {
    // **The property the whole change stands on.** A page holds
    // `floor(measure / advance)` characters to the column and `269mm / pitch`
    // columns across, and this touches neither: the pitch is measured across
    // the columns and nothing here is, and the count comes back five however
    // far the band has grown. So the deal puts the same text on the same page
    // as before, and the paired cuts and the spill are untouched.
    for (let slots = 4; slots <= 8; slots++) {
      const band = filled(slots);
      expect(Math.floor(band.kundoku / MM_PER_PX / band.advance)).toBe(5);
    }
  });

  it("leaves the prose band alone", () => {
    // The other half of the same guarantee, and the reason the split goes
    // where it does: `heldSlots` and `applyHangingMarks` read this band's own
    // measure and tracking, so a prose band that has not moved is a hang that
    // has not moved either.
    for (let slots = 4; slots <= 8; slots++) {
      expect(filled(slots).prose).toBeCloseTo(bandHeightsMm(5, slots, KUNDOKU_ADVANCE, PROSE_ADVANCE).kakikudashi, 9);
    }
  });

  it("spends the leftover the reader is looking at", () => {
    // 酒蟲 is np=6. Before: 116.92 + 47.36 = 164.27mm, and 13.73mm of the 178
    // standing blank. After: the kundoku band takes 96.8px per character —
    // the ceiling — for a 128.56mm band, and 2.08mm is left.
    const before = bandHeightsMm(5, 6, KUNDOKU_ADVANCE, PROSE_ADVANCE);
    expect(before.kundoku + before.kakikudashi).toBeCloseTo(164.274, 3);
    expect(178 - (before.kundoku + before.kakikudashi)).toBeCloseTo(13.726, 3);

    const band = filled(6);
    expect(band.advance).toBeCloseTo(96.8, 6);
    expect(band.kundoku).toBeCloseTo(128.558, 3);
    expect(band.pair).toBeCloseTo(175.916, 3);
    expect(178 - band.pair).toBeCloseTo(2.084, 3);
    // Which is under a third of one prose character — the unit a reader has
    // to compare it against, since it stands at the foot of the prose band.
    expect(178 - band.pair).toBeLessThan(PROSE_ADVANCE * MM_PER_PX / 3);
  });

  it("fills the sheet exactly where the ceiling does not bind", () => {
    // The two longest prose columns leave little enough that the stretch can
    // take all of it: 93.32px and 88.26px per kundoku character, gaps of 1.121
    // and 1.006 characters against the drawn 1.
    for (const slots of [7, 8]) {
      const band = filled(slots);
      expect(band.pair).toBeCloseTo(178, 6);
    }
    expect(filled(7).advance).toBeCloseTo(93.315, 3);
    expect(filled(7).gapRatio).toBeCloseTo(1.121, 3);
    expect(filled(8).advance).toBeCloseTo(88.255, 3);
    expect(filled(8).gapRatio).toBeCloseTo(1.006, 3);
  });

  it("stops where the text would rather be another character", () => {
    // The ceiling, and it is `fittedTracking`'s own rule read as a bound: that
    // function divides by the *nearest* whole number, so a band whose text has
    // grown by more than half a drawn advance is a band whose room would be
    // named `slots + 1` rather than `slots`. Past there the honest change is
    // to the count, and the count is the match's and the deal's.
    for (let slots = 4; slots <= 8; slots++) {
      const band = filled(slots);
      const text = 5 * band.advance; // the band less its cushion
      // To within float noise and not to within any slack: the ceiling is
      // `88 x 1.1`, which is 96.80000000000001 in binary, so five of them
      // overshoot 484 by 6e-14 — a hundred-billionth of a layout unit.
      expect(text).toBeLessThan(5.5 * KUNDOKU_ADVANCE + 1e-9);
    }
    // Strictly inside the boundary, the round names the count the match
    // chose. At the boundary itself it is indifferent — 5.5 goes up in
    // `Math.round` and down in half a dozen other roundings — which costs
    // nothing, because what the band is finally set to hold is a *floor*
    // (the check at the head of this block), and that is five either way.
    for (const slots of [7, 8]) {
      expect(Math.round((5 * filled(slots).advance) / KUNDOKU_ADVANCE)).toBe(5);
    }
    // The three short prose columns are all held there, and leave the rest
    // standing where it always stood.
    for (const slots of [4, 5, 6]) {
      expect(filled(slots).advance).toBeCloseTo(96.8, 6);
      expect(filled(slots).gapRatio).toBeCloseTo(1.2, 6);
    }
    expect(178 - filled(4).pair).toBeCloseTo(15.472, 3);
    expect(178 - filled(5).pair).toBeCloseTo(8.778, 3);
  });

  it("answers the collapsed panel too, without moving its count", () => {
    // A reader who has shut the 書き下し文 panel prints the kundoku band alone,
    // and it takes the budget seven characters at a time — leaving 54.87px,
    // which is 14.52mm, dead under the last one. The same stretch spends it:
    // seven characters at the ceiling of 94.29px is a 175.13mm band.
    const collapsed = filledKundokuAdvancePx(7, 0, KUNDOKU_ADVANCE);
    expect(collapsed).toBeCloseTo(94.286, 3);
    expect(bandHeightsMm(7, 0, KUNDOKU_ADVANCE, PROSE_ADVANCE).kundoku).toBeCloseTo(163.483, 3);
    expect(bandHeightsMm(7, 0, collapsed, PROSE_ADVANCE).kundoku).toBeCloseTo(175.125, 3);
    // And the count is still seven, though this is the one case where
    // `fittedTracking`'s round would say otherwise: 670.87px of measure over
    // an 88px advance is 7.62 characters, so the *fitted* answer is eight at a
    // tighter gap. It is not taken, because it would change how many
    // characters a page of this mode holds.
    expect(Math.round((178 - 0.5) / MM_PER_PX / KUNDOKU_ADVANCE)).toBe(8);
    expect(Math.floor(bandHeightsMm(7, 0, collapsed, PROSE_ADVANCE).kundoku / MM_PER_PX / collapsed)).toBe(7);
  });

  it("never tightens the gap the type is drawn at", () => {
    // A prose band wide enough to leave the kundoku band less than the
    // characters it was matched at is a plan the match should not produce; if
    // one ever arrived, setting the kanbun solid to make room for it would be
    // answering it in the wrong place. The drawn advance is the floor.
    expect(filledKundokuAdvancePx(5, 200, KUNDOKU_ADVANCE)).toBe(KUNDOKU_ADVANCE);
    expect(filledKundokuAdvancePx(5, 178, KUNDOKU_ADVANCE)).toBe(KUNDOKU_ADVANCE);
    // And nothing measurable at all comes back untouched rather than as a NaN
    // written into a band's inline style.
    expect(filledKundokuAdvancePx(0, 47.36, KUNDOKU_ADVANCE)).toBe(KUNDOKU_ADVANCE);
    expect(filledKundokuAdvancePx(5, 47.36, 0)).toBe(0);
  });

  it("follows the budget it is given", () => {
    // The budget is a parameter for the reason `proseSlotChoices`' is: a page
    // size or a margin is a thing that can change, and the arithmetic should
    // move with it rather than be re-derived. An 8mm shorter sheet is one the
    // ceiling does not reach at np=6, so the band comes to the room instead
    // and the pair fills it exactly.
    const prose = bandHeightsMm(5, 6, KUNDOKU_ADVANCE, PROSE_ADVANCE).kakikudashi;
    const tight = filledKundokuAdvancePx(5, prose, KUNDOKU_ADVANCE, 170);
    expect(tight).toBeLessThan(96.8);
    expect(tight).toBeGreaterThan(KUNDOKU_ADVANCE);
    expect(bandHeightsMm(5, 0, tight, PROSE_ADVANCE).kundoku + prose).toBeCloseTo(170, 6);
    // And a sheet too short for even the drawn band is not answered by
    // tightening the kanbun: the floor holds and the pair overruns, which is
    // a budget `proseSlotChoices` should never have offered this pair on.
    expect(filledKundokuAdvancePx(5, prose, KUNDOKU_ADVANCE, 158)).toBe(KUNDOKU_ADVANCE);
  });
});

// ---------------------------------------------------------------------------
// Where a prose column ends.
//
// The reader's page comes back with the 書き下し文 band stopping part way down
// a column, and it is not bad luck. A page is dealt to a *paired cut*, which
// is a boundary between two of a sentence's top-level children, and nothing
// makes such a boundary fall at the foot of a prose column. The quantisation
// then makes it systematic rather than merely likely: a sheet carries 11
// kundoku columns of five (55 cells) against 23 prose columns of six (138
// characters), and 酒蟲's 652 characters to 271 cells put those 55 cells at
// 132.3 characters — 96% of the prose band's capacity. The kundoku band is the
// binding one on every page, so the prose band stops around 21.75 of its 23
// columns and its last column holds four and a half of its six.
//
// `endsColumnFlush` is the test a fix would ask. **Nothing calls it yet**, and
// printLayout.ts says at length why: the constraint costs 10.4% of the
// characters on a page and buys the complete last line with *more* blank width,
// which is a trade for the reader and not for this file. The arithmetic is
// checked here while that decision is open.
//
// It is arithmetic on `planHangingMarks`' model — 禁則, ぶら下げ and 追い出し —
// asked by appending one ordinary character and seeing whether the passage grew
// a column. What is *not* checkable here, and is the model's own standing
// claim rather than this function's, is that a browser breaks its columns where
// the model says it does.
// ---------------------------------------------------------------------------

describe("endsColumnFlush", () => {
  it("tells a full last column from a part-filled one", () => {
    // Six characters to the column, which is what the match chooses on 酒蟲.
    // Twelve characters is two full columns; thirteen begins a third and
    // leaves five sixths of it empty.
    expect(endsColumnFlush("一二三四五六", 6)).toBe(true);
    expect(endsColumnFlush("一二三四五六七八九十百千", 6)).toBe(true);
    expect(endsColumnFlush("一二三四五六七", 6)).toBe(false);
    expect(endsColumnFlush("一二三四五", 6)).toBe(false);
    // And it follows the column length rather than a number of its own.
    expect(endsColumnFlush("一二三四五", 5)).toBe(true);
    expect(endsColumnFlush("一二三四五", 4)).toBe(false);
  });

  it("counts a hung mark as belonging to the column it hangs off", () => {
    // **The case a plain character count gets wrong.** A 。 after a full column
    // hangs into the margin: it takes no room in the column it hangs from and
    // none in the one after, so the column still holds its six characters and
    // the page ends flush. Counting the characters since the last column began
    // would find seven and call it a part-column.
    expect(endsColumnFlush("一二三四五六。", 6)).toBe(true);
    // The model agrees that this is a hang and not a seventh character.
    expect(planHangingMarks("一二三四五六。", 6).hangs).toEqual([6]);
    // A mark only ever hangs from a column that is already full. Anywhere
    // else it is an ordinary character taking an ordinary slot: 一二三四五。
    // is six characters and fills the column, and five of them do not.
    expect(endsColumnFlush("一二三四五。", 6)).toBe(true);
    expect(endsColumnFlush("一二三四。", 6)).toBe(false);
    expect(planHangingMarks("一二三四五。", 6).hangs).toEqual([]);
    // And a mark that opens a second column is two characters into it, not a
    // hang off the first.
    expect(endsColumnFlush("一二三四五六七。", 6)).toBe(false);
    expect(planHangingMarks("一二三四五六七。", 6).hangs).toEqual([]);
  });

  it("takes the source's own line break as a column the author closed", () => {
    // `planHangingMarks` closes on a newline "however short", so a passage
    // ending at a source line break has no column open. That counts as flush,
    // and the distinction is the point: a short column the *author* asked for
    // is one the reader sees on screen too, where a short column the
    // pagination introduced is the fault being looked for.
    expect(endsColumnFlush("一二三\n", 6)).toBe(true);
    expect(endsColumnFlush("一二三", 6)).toBe(false);
    // The break closes the column it ends, so what follows starts a fresh one
    // and is judged on its own length.
    expect(endsColumnFlush("一二三\n四五六七八九", 6)).toBe(true);
    expect(endsColumnFlush("一二三\n四五六", 6)).toBe(false);
  });

  it("reads a full column ending in an opening bracket as flush", () => {
    // 行末禁則 keeps an opening bracket off a column's foot — but only when
    // something follows it to be kept with. At the end of a passage nothing
    // does, so the column stands as it is with its six characters.
    expect(endsColumnFlush("一二三四五「", 6)).toBe(true);
    // The probe's own 追い出し pulls that bracket down with it, which is what
    // the model does to any character after it, and the passage still grows a
    // column — so the answer survives the mechanism used to ask.
    expect(planHangingMarks("一二三四五「字", 6).columns.length).toBe(2);
    expect(planHangingMarks("一二三四五「", 6).columns.length).toBe(1);
  });

  it("does not fault a passage with nothing in it", () => {
    // No text is no partial line. A caller has its own reason never to ask —
    // an empty page is refused by the deal well before this — and the answer
    // that leaves the deal alone is the one that does not report a fault.
    expect(endsColumnFlush("", 6)).toBe(true);
  });

  it("declines a column length the model will not walk", () => {
    // Below one character `planHangingMarks` returns no columns at all, so
    // there is no answer to give. `false` is the safe reading of no answer:
    // it says "not flush", which would leave a caller with today's cut rather
    // than let it act on a walk that never happened.
    expect(endsColumnFlush("一二三四五六", 0)).toBe(false);
    expect(endsColumnFlush("一二三四五六", -1)).toBe(false);
    expect(endsColumnFlush("一二三四五六", Number.NaN)).toBe(false);
  });

  it("agrees with the model over a long passage, character by character", () => {
    // The property, swept rather than sampled: at every prefix of a passage,
    // flush must mean that the characters standing in the open column are
    // none — that the model has just closed one. Read off `columns` and the
    // hang, which is the reading this function exists to avoid having to do
    // by hand, and here is the one place it is done to check the other.
    const text = "子曰、學而時習之、不亦說乎。有朋自遠方來、不亦樂乎。";
    for (let at = 0; at <= [...text].length; at++) {
      const prefix = [...text].slice(0, at).join("");
      const plan = planHangingMarks(prefix, 6);
      const characters = [...prefix].length;
      // How many characters stand in the column now open: everything after
      // the last column's first character, less any hung mark among them.
      const opened = plan.columns.length === 0 ? 0 : plan.columns[plan.columns.length - 1];
      const hung = plan.hangs.filter((h) => h >= opened).length;
      const standing = plan.columns.length === 0 ? characters : characters - opened - hung;
      expect(endsColumnFlush(prefix, 6)).toBe(standing === 6 || standing === 0);
    }
  });
});

// ---------------------------------------------------------------------------
// Dealing a page to a complete last column.
//
// `pageThrough` finds the fullest the page can be; `flushThrough` gives some of
// it back so that the prose band ends at the foot of a column rather than part
// way down one. It only ever gives back, which is what keeps every guarantee
// the deal already had — the answer is one of the paired cuts `pairedCuts`
// offered, so the two panels still hold the same tokens, and it is never below
// `from`, so the page still holds the piece it was opened for and the walk
// still makes progress.
//
// The cost was priced before it was built and is measured here against the
// shipped functions rather than predicted: see `the cost of a complete last
// column` below.
// ---------------------------------------------------------------------------

describe("flushThrough", () => {
  it("takes the fullest page whose prose ends flush", () => {
    // Pieces 0..5 are on offer and the page holds all six; 4 and 1 end flush.
    // The largest is the answer — this gives back as little as it can.
    expect(flushThrough(0, 5, (last) => last === 4 || last === 1)).toBe(4);
  });

  it("gives nothing back where the fullest page is already flush", () => {
    // The common case worth being cheap in: the first thing tried is the page
    // as `pageThrough` left it, so a page that is already flush costs one
    // probe and no re-placement.
    const asked: number[] = [];
    const at = flushThrough(2, 7, (last) => {
      asked.push(last);
      return true;
    });
    expect(at).toBe(7);
    expect(asked).toEqual([7]);
  });

  it("falls back to the fullest page where nothing is flush", () => {
    // **The page can never be emptied.** A sentence of one enormous piece has
    // no flush cut anywhere in it and must still be dealt; the fallback is the
    // cut the deal would have taken anyway, so this is never worse than the
    // behaviour it refines.
    expect(flushThrough(3, 9, () => false)).toBe(9);
    expect(flushThrough(4, 4, () => false)).toBe(4);
  });

  it("never gives back the piece the page was opened for", () => {
    // `from` is the floor, and it has to be: below it the page holds nothing,
    // `pageThrough` would be asked the same question again on a fresh page,
    // and the deal would not terminate. So a flush cut is looked for at `from`
    // and never under it.
    const asked: number[] = [];
    flushThrough(5, 8, (last) => {
      asked.push(last);
      return false;
    });
    expect(asked).toEqual([8, 7, 6, 5]);
    expect(Math.min(...asked)).toBe(5);
  });

  it("walks down rather than bisecting, because flushness is not monotone", () => {
    // `pageThrough` bisects because "does this fit" only ever goes from true
    // to false. "Does this end flush" is the character count modulo the
    // column, which goes in and out of true as pieces are added — so the only
    // route to the *largest* flush cut is to try them in order.
    const flushAt = new Set([0, 3, 6, 7]);
    expect(flushThrough(0, 8, (last) => flushAt.has(last))).toBe(7);
    expect(flushThrough(0, 5, (last) => flushAt.has(last))).toBe(3);
    expect(flushThrough(4, 5, (last) => flushAt.has(last))).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// The cost of a complete last column.
//
// The reader was shown this before it was built and chose it, so what follows
// is not a gate on the decision — it is the price recorded where it can be
// checked, and re-measured against the shipped `flushThrough` and
// `endsColumnFlush` rather than carried forward from the estimate that was put
// to him.
//
// A page is modelled from the repository's own measurements: 55 kundoku cells
// to a sheet (11 columns of five) and 6 characters to a prose column; pieces of
// 1.5 cells and 6 at the longest (44 tokens in 29 pieces across the Analects
// fixtures, counted in `pairedCuts, on the parses in the fixtures` above); and
// 2.406 prose characters to a cell (酒蟲's 652 to 271). One piece in five ends
// in a mark, which is what puts ぶら下げ and 禁則 into the walk at all rather
// than leaving it a division.
//
// The generator is a fixed seed, so every number below is exactly what this
// test computes — not a range that happens to hold.
// ---------------------------------------------------------------------------

const PAGE_CELLS = 55;
const PROSE_PER_CELL = 652 / 271;
const PIECE_CELLS = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 6];
const PAGE_GLYPHS = "一二三四五六七八九十百千萬子曰學而時習之有朋自遠方來";

/** One page's worth of pieces, dealt to `flushThrough` exactly as the layout
 * deals them, and what the constraint cost it. */
function modelledPages(count: number, slots: number) {
  let rng = 20260906;
  const rand = () => (rng = (rng * 1103515245 + 12345) % 2147483648) / 2147483648;
  const back: number[] = [];
  const probes: number[] = [];
  let backProse = 0;
  let fellBack = 0;
  let kept = 0;
  let pages = 0;
  for (let page = 0; page < count; page++) {
    const cells: number[] = [];
    const prose: string[] = [];
    let filled = 0;
    for (;;) {
      const n = PIECE_CELLS[Math.floor(rand() * PIECE_CELLS.length)];
      if (filled + n > PAGE_CELLS) break;
      filled += n;
      const length = Math.max(1, Math.round(n * PROSE_PER_CELL) + (rand() < 0.34 ? -1 : rand() < 0.5 ? 1 : 0));
      let piece = "";
      for (let at = 0; at < length; at++) piece += PAGE_GLYPHS[Math.floor(rand() * PAGE_GLYPHS.length)];
      if (rand() < 0.2) piece = piece.slice(0, -1) + (rand() < 0.5 ? "、" : "。");
      cells.push(n);
      prose.push(piece);
    }
    if (cells.length === 0) continue;
    let asked = 0;
    const flush = flushThrough(0, cells.length - 1, (last) => {
      asked += 1;
      return endsColumnFlush(prose.slice(0, last + 1).join(""), slots);
    });
    pages += 1;
    probes.push(asked);
    if (!endsColumnFlush(prose.slice(0, flush + 1).join(""), slots)) fellBack += 1;
    const given = cells.slice(flush + 1).reduce((a, b) => a + b, 0);
    back.push(given);
    backProse += prose.slice(flush + 1).join("").length;
    kept += filled - given;
  }
  const sorted = [...back].sort((a, b) => a - b);
  return {
    pages,
    backMean: back.reduce((a, b) => a + b, 0) / pages,
    backMedian: sorted[sorted.length >> 1],
    backP90: sorted[Math.floor(sorted.length * 0.9)],
    backMax: sorted[sorted.length - 1],
    backProseMean: backProse / pages,
    probesMean: probes.reduce((a, b) => a + b, 0) / pages,
    probesMax: Math.max(...probes),
    fellBack,
    keptMean: kept / pages,
  };
}

describe("the cost of a complete last column", () => {
  const cost = modelledPages(4000, 6);

  it("gives back about a tenth of the characters on a page", () => {
    // 5.02 cells of the 55, so 49.58 stay — 9.9% fewer. That is the number the
    // reader accepted, and it is what 酒蟲 going from five sheets to six comes
    // out of: 271 cells over 49.58 is 5.47 pages, which is six.
    expect(cost.backMean).toBeCloseTo(5.02, 2);
    expect(cost.keptMean).toBeCloseTo(49.58, 2);
    expect(100 * (1 - cost.keptMean / PAGE_CELLS)).toBeCloseTo(9.9, 1);
    expect(Math.ceil(271 / PAGE_CELLS)).toBe(5);
    expect(Math.ceil(271 / cost.keptMean)).toBe(6);
  });

  it("gives back a column and a half of prose, and never a page's worth", () => {
    // The distribution matters more than the mean here: the median page gives
    // back four cells and nine pages in ten give back twelve or fewer, so the
    // typical sheet loses a line or two rather than a paragraph. The worst
    // seen over four thousand pages is 20 of 55 — a third of a sheet, and the
    // reason the *worst* case is worth stating beside the average.
    expect(cost.backMedian).toBe(4);
    expect(cost.backP90).toBe(12);
    expect(cost.backMax).toBe(20);
    // In the units the fault is in: 11.0 characters, which at six to the
    // column is 1.83 prose columns given back to complete one.
    expect(cost.backProseMean).toBeCloseTo(11.0, 1);
    expect(cost.backProseMean / 6).toBeCloseTo(1.83, 2);
  });

  it("finds a flush cut on every page it is given", () => {
    // Not a guarantee and not treated as one — `flushThrough` falls back to
    // the fullest page and is tested doing so above — but worth recording that
    // over four thousand modelled pages the fallback never fired. Cuts come
    // every piece and a piece is a character or two, so a column boundary is
    // rarely far behind.
    expect(cost.fellBack).toBe(0);
    expect(cost.pages).toBe(4000);
  });

  it("costs about as many probes as the bisection it follows", () => {
    // Each probe is a forced layout of the page, so the walk has to be cheap
    // in the same currency `pageThrough` is careful about. 4.1 on average and
    // 10 at the worst, against roughly five for a bisection over a thirty-piece
    // sentence: the same order, not a new kind of cost.
    expect(cost.probesMean).toBeCloseTo(4.1, 1);
    expect(cost.probesMax).toBe(10);
  });

  it("costs less at a longer prose column and more at a shorter one", () => {
    // The constraint is "the character count is a multiple of the column
    // length", so a longer column has fewer boundaries to land on and each
    // miss gives back more. Worth knowing because the column length is chosen
    // per text (`matchedProseSlots`), so this cost moves with the text.
    const short = modelledPages(1000, 4);
    const long = modelledPages(1000, 8);
    expect(short.backMean).toBeLessThan(long.backMean);
  });
});

// ---------------------------------------------------------------------------
// Widows and orphans, where the lines are columns.
//
// **The unit had to be established before any of this could be written, and it
// is not the sentence.** A `.sentence-gap` carries no margin and flows inline
// (tategaki.css: "both panels read as one continuous solid passage"), so it
// begins no column and has neither a first column nor a last one — a widow
// cannot be stated about one. What begins a column is the source's own line
// break: `appendSourceBreak` writes a `<br>`, `proseFlow` renders it as a
// newline, and `planHangingMarks` closes a column on a newline. So the block
// that can be widowed or orphaned is the run between two source line breaks.
//
// Where a text sets one 章 to a line, that block and the 章 are the same thing.
// 酒蟲 is where they are not: 652 characters of prose over three source lines,
// so a block there is some 36 prose columns and the sentences inside it run on.
//
// The threshold is two prose columns, and the geometry picks it rather than
// tradition: the pitches are locked two prose columns to one kundoku column by
// construction, so a two-column remnant is one whole kundoku column and a
// one-column remnant is half of one — a fragment in the band above, which is
// worse than the widow it would be answering.
// ---------------------------------------------------------------------------

describe("widowOrphanFree", () => {
  it("refuses a remnant under the threshold at either end", () => {
    // One column of a block alone at a page foot is an orphan; one column
    // alone at the next page's head is a widow. Two is the floor.
    expect(widowOrphanFree(1, 8, 2)).toBe(false);
    expect(widowOrphanFree(8, 1, 2)).toBe(false);
    expect(widowOrphanFree(2, 2, 2)).toBe(true);
    expect(widowOrphanFree(8, 8, 2)).toBe(true);
  });

  it("takes null for a fault that cannot arise", () => {
    // No block begins on the page, so nothing on it can be orphaned; no block
    // is carried over, so nothing can be widowed. Both are the ordinary case
    // — a page in the middle of a long block is both at once.
    expect(widowOrphanFree(null, null, 2)).toBe(true);
    expect(widowOrphanFree(null, 1, 2)).toBe(false);
    // **A null tail is not an orphan however short the head.** The block ends
    // at the cut, so it began and finished on the one page and was never
    // divided — a complete short block is a short block. This read `false` and
    // called it an orphan, which cost nothing while a block ran to three
    // columns and more, and fires on a quarter of 學而's 章 at the print scale.
    expect(widowOrphanFree(1, null, 2)).toBe(true);
  });

  it("carries the threshold rather than assuming it", () => {
    // The number is `WIDOW_ORPHAN_COLUMNS` at the one place it is decided, and
    // this function is told it — so a change of mind about one column against
    // two is a change in one line and not in this arithmetic.
    expect(widowOrphanFree(1, 5, 1)).toBe(true);
    expect(widowOrphanFree(1, 5, 2)).toBe(false);
  });

  it("caps the threshold at half the block, and so never forbids a division", () => {
    // **A threshold a block cannot meet is not a threshold, it is a
    // prohibition on dividing the block** — and the reader has ruled that a 章
    // must be able to wrap. A block of four columns at a threshold of three
    // has no division that leaves three on each side, so the rule asks for the
    // most even one it can have instead of refusing the break.
    expect(widowOrphanFree(2, 2, 3)).toBe(true);
    // A three-column block, which is where this bites on 學而: 1-2 passes,
    // because 2-2 does not exist.
    expect(widowOrphanFree(1, 2, 2)).toBe(true);
    expect(widowOrphanFree(2, 1, 2)).toBe(true);
    // At or above twice the threshold nothing changes at all, which is every
    // block on a text whose paragraphs run to a page and a half.
    expect(widowOrphanFree(1, 3, 2)).toBe(false);
    expect(widowOrphanFree(3, 1, 2)).toBe(false);
    expect(widowOrphanFree(1, 30, 2)).toBe(false);
    // A block that began on an earlier page keeps the uncapped threshold: it
    // is longer than this cut can see, and so longer than the cap could ever
    // apply to.
    expect(widowOrphanFree(null, 1, 2)).toBe(false);
    expect(widowOrphanFree(null, 2, 2)).toBe(true);
  });
});

describe("blockBegunIn and blockHandedOn", () => {
  it("finds the block a page begins, and says when it begins none", () => {
    // Everything after the last source line break. A page with no break in it
    // is a page in the middle of a block: nothing on it can be orphaned.
    expect(blockBegunIn("一二三\n四五六")).toBe("四五六");
    expect(blockBegunIn("一二三")).toBeNull();
    // A break at the very end begins an empty block, which is a block whose
    // text is all overleaf — no columns on this page, and so nothing to
    // orphan. The empty string is not null, and the caller counts it as zero.
    expect(blockBegunIn("一二三\n")).toBe("");
    // Several breaks: the last one wins, being the only block still open.
    expect(blockBegunIn("一\n二\n三")).toBe("三");
  });

  it("finds the block a page hands on, and whether it ends there", () => {
    expect(blockHandedOn("四五六\n七八九")).toEqual({ text: "四五六", ends: true });
    // No break found: either the document ends here, or the caller stopped
    // gathering having already seen more than the threshold needs. Either way
    // the count that follows is a lower bound, which is all a threshold asks.
    expect(blockHandedOn("四五六")).toEqual({ text: "四五六", ends: false });
    // A break immediately: the block ended at the cut, so nothing is handed on
    // and there is no widow to make.
    expect(blockHandedOn("\n七八九")).toEqual({ text: "", ends: true });
  });

  it("counts a block's columns exactly, because a block starts at a column head", () => {
    // The reason these two are worth having as functions rather than as a
    // regular expression at the call site: the text they return begins at a
    // column head — `planHangingMarks` closed a column on the newline before
    // it — so counting its columns is exact rather than an estimate that has
    // to allow for where in a column the block started.
    const begun = blockBegunIn("一二三四五六七八\n九十百千")!;
    expect(planHangingMarks(begun, 6).columns.length).toBe(1);
    expect(planHangingMarks(blockHandedOn("九十百千百千萬子曰學而").text, 6).columns.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// What the tidy page costs, all told.
//
// The reader agreed to the flush cut at 9.9% fewer characters to a sheet and
// 酒蟲 going from five sheets to six. Widow and orphan control stacks on top of
// that, so what is measured here is the **combined** figure and not the
// marginal one — and it is measured by dealing whole documents rather than
// single pages, because a widow is a fact about two consecutive pages.
//
// A document is 271 kundoku cells (酒蟲's own length) with a source line break
// every 217 prose characters, which is its three lines over 652 characters.
// Pieces and the prose-per-cell ratio are as measured in the block above. Two
// hundred documents, fixed seeds, dealt through the shipped `flushThrough`,
// `endsColumnFlush`, `widowOrphanFree`, `blockBegunIn` and `blockHandedOn`.
//
// ── **It deals a stream, and for one round that was the flaw** ────────────
// `dealDocument` has no sentences in it. Its pieces run end to end, so `at` is
// the head of the *page* and `flushThrough(at, …)` may give back the whole
// sheet — about thirty-one candidates. The deal it was written against called
// `flushThrough(from, …)` with `from` = the first piece of the **sentence**
// straddling the page's foot, which left one to three; so the two figures this
// block records — the sheet cost, and "the second level was never reached at
// all" — were figures about a search the layout did not perform, and they are
// why widow control was predicted never to need to fire when in fact it could
// not. The reader printed it twice and reported the fault both times.
//
// `buildPrintLayout` now keeps a per-page ledger and gives the walk the head of
// the page, so **this model is a fair model of the shipped search again** and
// its figures stand as written. Two things it still does not have, both of which
// make it read the cost high: a **sentence boundary**, which is where a page
// break falls two times in three; and `pageEndsFlush`'s block-end stop, so it
// sends the walk hunting a column foot where the shipped deal would have
// stopped at the end of a 章. `the deal, on the parses in the fixtures` at the
// foot of this file asks the same questions of real parses dealt the way the
// code deals them, and is the measurement to trust where the two disagree.
// ---------------------------------------------------------------------------

const BLOCK_CHARS = 217; // 652 prose characters over three source lines.

/** One document dealt into pages, at a given level of constraint. */
function dealDocument(seed: number, cells: number, flushCuts: boolean, tidyPages: boolean) {
  let rng = seed;
  const rand = () => (rng = (rng * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pieces: { cells: number; prose: string }[] = [];
  let laid = 0;
  let sinceBreak = 0;
  while (laid < cells) {
    const n = PIECE_CELLS[Math.floor(rand() * PIECE_CELLS.length)];
    const length = Math.max(1, Math.round(n * PROSE_PER_CELL) + (rand() < 0.34 ? -1 : rand() < 0.5 ? 1 : 0));
    let prose = "";
    for (let at = 0; at < length; at++) prose += PAGE_GLYPHS[Math.floor(rand() * PAGE_GLYPHS.length)];
    if (rand() < 0.2) prose = prose.slice(0, -1) + (rand() < 0.5 ? "、" : "。");
    if (sinceBreak >= BLOCK_CHARS) {
      prose = `\n${prose}`;
      sinceBreak = 0;
    }
    sinceBreak += prose.length;
    laid += n;
    pieces.push({ cells: n, prose });
  }

  let at = 0;
  let pages = 0;
  let probes = 0;
  let given = 0;
  let fellBack = 0;
  while (at < pieces.length) {
    let last = at - 1;
    let filled = 0;
    while (last + 1 < pieces.length && filled + pieces[last + 1].cells <= PAGE_CELLS) {
      last += 1;
      filled += pieces[last].cells;
    }
    if (last < at) {
      last = at;
      filled = pieces[at].cells;
    }
    const fullest = last;
    let cut = fullest;
    // The last page of the document is left as the text leaves it: a passage
    // ending part way down its final column is how prose ends.
    if (flushCuts && fullest < pieces.length - 1) {
      const onPage = (upTo: number) => pieces.slice(at, upTo + 1).map((piece) => piece.prose).join("");
      const handedOn = (upTo: number) => {
        let text = "";
        for (let next = upTo + 1; next < pieces.length; next++) {
          text += pieces[next].prose;
          if (text.includes("\n") || text.length >= 3 * 6) break;
        }
        return text;
      };
      const judged = new Map<number, { flush: boolean; tidy: boolean }>();
      const judge = (upTo: number) => {
        const known = judged.get(upTo);
        if (known) return known;
        probes += 1;
        const page = onPage(upTo);
        const begun = blockBegunIn(page);
        const head = begun === null ? null : planHangingMarks(begun, 6).columns.length;
        const handed = blockHandedOn(handedOn(upTo));
        const tail = handed.text.length === 0 ? null : planHangingMarks(handed.text, 6).columns.length;
        const answer = {
          flush: endsColumnFlush(page, 6),
          tidy: tidyPages ? widowOrphanFree(head, tail, 2) : true,
        };
        judged.set(upTo, answer);
        return answer;
      };
      const both = flushThrough(at, fullest, (upTo) => judge(upTo).flush && judge(upTo).tidy);
      if (judge(both).flush && judge(both).tidy) cut = both;
      else {
        cut = flushThrough(at, fullest, (upTo) => judge(upTo).flush);
        fellBack += 1;
      }
    }
    given += filled - pieces.slice(at, cut + 1).reduce((a, piece) => a + piece.cells, 0);
    pages += 1;
    at = cut + 1;
  }
  return { pages, probesPerPage: probes / pages, givenPerPage: given / pages, fellBack };
}

function overDocuments(count: number, flushCuts: boolean, tidyPages: boolean) {
  let pages = 0;
  let probes = 0;
  let given = 0;
  let fellBack = 0;
  for (let seed = 1; seed <= count; seed++) {
    const deal = dealDocument(seed * 7919 + 13, 271, flushCuts, tidyPages);
    pages += deal.pages;
    probes += deal.probesPerPage;
    given += deal.givenPerPage;
    fellBack += deal.fellBack;
  }
  return { pages: pages / count, probes: probes / count, given: given / count, fellBack };
}

describe("the combined cost of a tidy page", () => {
  const plain = overDocuments(200, false, false);
  const flush = overDocuments(200, true, false);
  const tidy = overDocuments(200, true, true);

  it("costs a sheet on a text of 酒蟲's length, and the flush cut is all of it", () => {
    // 5.27 sheets unconstrained, 6.015 with flush cuts, 6.040 with widows and
    // orphans refused as well. **The whole of the page cost is the flush cut
    // the reader already agreed to**; this constraint adds 0.025 of a sheet.
    expect(plain.pages).toBeCloseTo(5.27, 2);
    expect(flush.pages).toBeCloseTo(6.015, 3);
    expect(tidy.pages).toBeCloseTo(6.04, 3);
    expect(tidy.pages - flush.pages).toBeLessThan(0.05);
  });

  it("gains a sheet on one document in forty, and loses one on none", () => {
    // The figure worth having beside the mean: refusing widows and orphans
    // does not shorten a document a little, it lengthens a few documents by a
    // whole sheet. Five of two hundred, and never the other way.
    let differ = 0;
    let longer = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const without = dealDocument(seed * 7919 + 13, 271, true, false).pages;
      const with_ = dealDocument(seed * 7919 + 13, 271, true, true).pages;
      if (with_ !== without) differ += 1;
      if (with_ > without) longer += 1;
    }
    expect(differ).toBe(5);
    expect(longer).toBe(5);
  });

  it("gives back half a cell more a page, and asks a third of a probe more", () => {
    // 4.23 cells given back a page becomes 4.82, and 3.66 probes become 4.05.
    // Both are the cost of looking, and both are small because the constraint
    // only bites where a block boundary lands within two columns of a page
    // boundary — which on a text of three long blocks is most pages never.
    expect(flush.given).toBeCloseTo(4.23, 2);
    expect(tidy.given).toBeCloseTo(4.82, 2);
    expect(flush.probes).toBeCloseTo(3.66, 2);
    expect(tidy.probes).toBeCloseTo(4.05, 2);
  });

  it("never has to abandon the rule it is layered under", () => {
    // The priority order, as a property: where no cut is both flush and tidy,
    // the *widow* rule is the one given up and flushness is kept — because
    // flushness is what the reader asked for and saw, and a mid-column page
    // foot is the fault he reported. Over two hundred documents the second
    // level was never reached at all, at either setting.
    expect(flush.fellBack).toBe(0);
    expect(tidy.fellBack).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The deal itself, on real text — and what the constraint above actually
// reaches on the pages that come out.
//
// **The reader printed the build the block above priced and reports that the
// widows and orphans are still there. He is right, and everything above this
// line is why he could be told otherwise.** `dealDocument` deals a document as
// *one stream of pieces*: it has no sentences in it, so `flushThrough(at, …)`
// is given the whole page to give back into. `buildPrintLayout` deals a
// document one `.sentence-gap` at a time and calls `flushThrough(from, …)`,
// where `from` is the first piece **of the sentence straddling the page's
// foot**. Everything before it on the page was placed by earlier sentences
// whose shells the loop no longer holds. So the model measured a walk of about
// thirty candidates and the code performs one of one to three, and the two
// levels of constraint — flushness and widow control alike — were priced on a
// search the page cannot make.
//
// What is dealt below is real: the four Analects openings in
// `tests/fixtures/analects-raw-parses.json`, through `computeReadingOrder` and
// `generateKakikudashiPiecesForTree` with the shipped kanjidic/jmdict resolver,
// cut by the shipped `pairedCuts`, and its columns counted by the shipped
// `planHangingMarks`. What is modelled is only the sheet: a page holds 11
// kundoku columns of five cells and 23 prose columns of six characters, which
// is `bandHeightsMm`'s own division at the shipped scale, and a mark of
// punctuation takes no advance in the kundoku band (`.punct-cell`, kunten.css).
//
// Three documents, because the fault turns on where the source's own line
// breaks fall and that is a property of the file the reader opens:
//
//   "chapter"  one 章 to a line — the case the widow rule was written from,
//              carried the real way, as `LineBreak` in a token's MISC
//   "none"     a text pasted as one line, which carries no break at all
//   217        a break every 217 prose characters, which is 酒蟲's own shape:
//              652 characters over three source lines
// ---------------------------------------------------------------------------

const DEAL_DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "../public/data");
const dealResolve = createReadingResolver(
  JSON.parse(readFileSync(join(DEAL_DATA_DIR, "kanjidic-index.json"), "utf-8")) as KanjidicIndex,
  JSON.parse(readFileSync(join(DEAL_DATA_DIR, "jmdict-index.json"), "utf-8")) as JmdictIndex,
);

/** One top-level child of a `.sentence-gap`, in both panels at once: what
 * `CutUnit` needs, plus the prose the child writes and the cells it costs the
 * kundoku band. A `<br>` writes a newline below and closes a column above. */
interface DealChild {
  ids: number[];
  breaks: boolean;
  text: string;
  cells: number;
}
const asCutUnit = (child: DealChild): CutUnit => ({ ids: child.ids, breaks: child.breaks });

/** One sentence as the two panels write it: the kundoku column in source
 * order, one cell per token; the prose in reading order, one child per piece
 * the generator emits, with the sentence separator after them. */
function dealtSentence(
  sentence: { tokens: Token[] },
  tree: TokenTree,
  at: number,
  pieces: readonly { kind: string; text: string; caseParticle?: string; tokenId: number }[],
): { kundoku: DealChild[]; prose: DealChild[] } {
  const kundoku: DealChild[] = [];
  for (const token of [...sentence.tokens].sort((a, b) => a.id - b.id)) {
    // `appendSourceBreak` (KundokuView.ts) writes the same `<br>` above that
    // the generator's "layout" piece writes below.
    if (sourceLayoutOf(token)?.breakBefore) kundoku.push({ ids: [], breaks: true, text: "", cells: 0 });
    kundoku.push({ ids: [token.id], breaks: false, text: "", cells: token.pos === "PUNCT" ? 0 : 1 });
  }
  const prose: DealChild[] = pieces.map((piece) =>
    piece.kind === "layout"
      ? { ids: [], breaks: true, text: piece.text, cells: 0 }
      : { ids: [piece.tokenId], breaks: false, text: piece.text + (piece.caseParticle ?? ""), cells: 0 },
  );
  const separator = sentenceSeparator(tree.sentences, at);
  if (separator) prose.push({ ids: [], breaks: false, text: separator, cells: 0 });
  return { kundoku, prose };
}

/** A document of `chapters` real Analects openings, laid out as `breaks` asks.
 *
 * Shuffled by default, so the deal is not measuring one repeating cycle. The
 * `ordered` variant is the cycle on purpose: a periodic document lands its page
 * breaks in the same place every time, which is how the one case where the
 * widow level has to *override* the flush level is got hold of at all. */
function dealtDocument(chapters: number, breaks: "chapter" | "none" | number, ordered = false) {
  const keys = Object.keys(fixtures);
  const document: { kundoku: DealChild[]; prose: DealChild[] }[] = [];
  let sinceBreak = 0;
  for (let c = 0; c < chapters; c++) {
    const parses =
      fixtures[keys[(ordered ? c : c * 3 + Math.floor(c / 4) * 5 + ((c * 7919 + 13) % 4)) % keys.length]];
    const tree: TokenTree = {
      sentences: parses.map((tokens) => ({ tokens: tokens.map((token) => ({ ...token })) })),
    } as TokenTree;
    // The real route to a line break: `annotateSourceLayout` writes `LineBreak`
    // into a token's MISC, `sourceLayoutOf` reads it, and the generator emits a
    // "layout" piece that the panel turns into a `<br>`.
    if (breaks === "chapter" && c > 0) {
      const first = [...tree.sentences[0].tokens].sort((a, b) => a.id - b.id)[0];
      first.misc = { ...first.misc, LineBreak: "line" };
    }
    const pieces = generateKakikudashiPiecesForTree(tree, (sentence) => computeReadingOrder(sentence), dealResolve);
    tree.sentences.forEach((sentence, at) => {
      const dealt = dealtSentence(sentence, tree, at, pieces[at]);
      if (typeof breaks === "number") {
        if (sinceBreak >= breaks && document.length > 0) {
          dealt.prose.unshift({ ids: [], breaks: true, text: "\n", cells: 0 });
          dealt.kundoku.unshift({ ids: [], breaks: true, text: "", cells: 0 });
          sinceBreak = 0;
        }
        sinceBreak += dealt.prose.reduce((a, child) => a + child.text.length, 0);
      }
      document.push(dealt);
    });
  }
  return document;
}

// ── The sheet, at the scale the print band is set in ─────────────────────
// **Derived from the scale rather than written down**, because the reader has
// asked for the print type at 33/60 and every one of these moves with it. The
// same arithmetic `planBands` runs, on the same drawn advances: 88px down a
// kundoku column and 25.3px down a prose one at the screen scale, 48.4 and
// 13.915 at this one.
//
// At the screen scale they come to 5 cells to a kundoku column, 6 characters to
// a prose one, and 11 and 23 columns across the page — which is the geometry
// every figure in this file used to be measured at. At 33/60: 10, 12, 21 and
// 42, and a sheet that holds 210 kundoku cells where it held 55.
const PRINT_SCALE = 33 / 60;
const DEAL_PAGE_WIDTH_PX = 269 / (25.4 / 96);
/** The sheet at a given type scale, all four numbers derived the way
 * `planBands` derives them. `let` rather than `const` so that the factor can be
 * swept — see `atScale` — which is the only way to put a choice of factor to
 * the reader in sheet counts rather than in millimetres. */
let DEAL_KUNDOKU_ADVANCE = 88 * PRINT_SCALE;
let DEAL_PROSE_ADVANCE = 25.3 * PRINT_SCALE;
let DEAL_CELLS_PER_COLUMN = kundokuSlotsFor(DEAL_KUNDOKU_ADVANCE, DEAL_PROSE_ADVANCE);
/** **The match, not the fallback.** `planBands` chooses the prose column by
 * measuring which length brings the prose to the same extent as the kundoku,
 * which is `np = nk x r / 2`; these fixtures come to r = 1.97-2.08 characters
 * of prose per kanbun cell, so the match is `nk` itself.
 *
 * Worth spelling out, because the fallback is a trap at this scale.
 * `defaultProseSlots(10)` is 12, and 學而 **can never end a page flush at 12**:
 * its 章 run 11, 14, 18, 19, 27 and 28 characters, each beginning at a column
 * head of its own, and no piece boundary inside any of them falls on a
 * multiple of 12 — 0 of 400 prefixes, against 56 at the matched 10. The
 * fallback only fires where there is no prose to measure, which is where there
 * is no prose band either, so nothing reaches it; but it is the kind of number
 * that would be very hard to find from a printed page. */
let DEAL_SLOTS = Math.round(DEAL_CELLS_PER_COLUMN * 2.0 / 2);
let DEAL_KUNDOKU_COLUMNS = Math.floor(DEAL_PAGE_WIDTH_PX / (88 * PRINT_SCALE));
let DEAL_PROSE_COLUMNS = Math.floor(DEAL_PAGE_WIDTH_PX / (44 * PRINT_SCALE));

/** Runs `body` with the sheet derived at `scale`, and puts the shipped one
 * back. Everything a page holds moves with the type scale, so a factor cannot
 * be judged from the factor — it has to be dealt. */
function atScale<T>(scale: number, body: () => T): T {
  const kept = [DEAL_KUNDOKU_ADVANCE, DEAL_PROSE_ADVANCE, DEAL_CELLS_PER_COLUMN, DEAL_SLOTS, DEAL_KUNDOKU_COLUMNS, DEAL_PROSE_COLUMNS] as const;
  DEAL_KUNDOKU_ADVANCE = 88 * scale;
  DEAL_PROSE_ADVANCE = 25.3 * scale;
  DEAL_CELLS_PER_COLUMN = kundokuSlotsFor(DEAL_KUNDOKU_ADVANCE, DEAL_PROSE_ADVANCE);
  DEAL_SLOTS = Math.round(DEAL_CELLS_PER_COLUMN * 2.0 / 2);
  DEAL_KUNDOKU_COLUMNS = Math.floor(DEAL_PAGE_WIDTH_PX / (88 * scale));
  DEAL_PROSE_COLUMNS = Math.floor(DEAL_PAGE_WIDTH_PX / (44 * scale));
  try {
    return body();
  } finally {
    [DEAL_KUNDOKU_ADVANCE, DEAL_PROSE_ADVANCE, DEAL_CELLS_PER_COLUMN, DEAL_SLOTS, DEAL_KUNDOKU_COLUMNS, DEAL_PROSE_COLUMNS] = kept;
  }
}

function dealtKundokuColumns(children: readonly DealChild[]): number {
  let columns = 1;
  let used = 0;
  // A source line break at the head of a band is trimmed by `buildPrintLayout`
  // — "the page turn is itself the start of a new column" — so it must not be
  // counted as one here either, or a page that opens a 章 is modelled a whole
  // column shorter than it prints.
  let at = 0;
  while (at < children.length && children[at].breaks) at += 1;
  for (const child of children.slice(at)) {
    if (child.breaks) {
      columns += 1;
      used = 0;
      continue;
    }
    for (let cell = 0; cell < child.cells; cell++) {
      if (used === DEAL_CELLS_PER_COLUMN) {
        columns += 1;
        used = 0;
      }
      used += 1;
    }
  }
  return columns;
}
const dealtProse = (children: readonly DealChild[]) => children.map((child) => child.text).join("");

interface DealtPage {
  prose: DealChild[];
  /** The kundoku band's children, so a page's fullness can be counted in the
   * cells the sheet is measured in. */
  kundoku: DealChild[];
  /** Which pieces of which sentences the page holds, in order — the ledger's
   * own record, kept so the paired-cut invariant can be checked at the cut
   * sites the ledger introduces. Empty for the deal that came before it. */
  entries?: { at: number; piece: number }[];
  /** Which branch closed the page: the flush/widow rule, or the one that
   * reaches neither because nothing of the next sentence fits. */
  closedBy: "rule" | "sentence-boundary" | "document-end";
}

/** The pieces of one sentence, as `piecesOf` cuts them. */
function dealtPieces(sentence: { kundoku: DealChild[]; prose: DealChild[] }) {
  const cuts = pairedCuts(sentence.kundoku.map(asCutUnit), sentence.prose.map(asCutUnit));
  const pieces: { kundoku: DealChild[]; prose: DealChild[] }[] = [];
  let fromK = 0;
  let fromP = 0;
  for (const cut of cuts) {
    pieces.push({ kundoku: sentence.kundoku.slice(fromK, cut.kundoku), prose: sentence.prose.slice(fromP, cut.prose) });
    fromK = cut.kundoku;
    fromP = cut.prose;
  }
  pieces.push({ kundoku: sentence.kundoku.slice(fromK), prose: sentence.prose.slice(fromP) });
  return pieces;
}

/** **The deal as it was before the ledger**, sentence by sentence, with the
 * flush and widow walks bounded below by `from` — the first piece of the
 * sentence straddling the page's foot. Kept, and only kept, so that the
 * before/after figures below are measured rather than remembered: this is the
 * deal the reader printed twice and reported the fault on both times. */
function dealBeforeTheLedger(document: ReturnType<typeof dealtDocument>, tidyPages: boolean) {
  const pages: DealtPage[] = [];
  let page: DealtPage = { prose: [], kundoku: [], closedBy: "document-end" };
  pages.push(page);
  let pageIsEmpty = true;
  let pageIsFinished = false;
  let atSentenceBoundary = 0;
  let ruleRan = 0;
  let sawUntidy = 0;
  let moved = 0;
  const windows: number[] = [];

  const startPage = () => {
    page = { prose: [], kundoku: [], closedBy: "document-end" };
    pages.push(page);
    pageIsEmpty = true;
    pageIsFinished = false;
  };

  for (let i = 0; i < document.length; i++) {
    const pieces = dealtPieces(document[i]);
    const enough = (2 + 1) * DEAL_SLOTS;
    const remnantAfter = (last: number): string => {
      let text = "";
      for (let at = last + 1; at < pieces.length; at++) {
        text += dealtProse(pieces[at].prose);
        if (text.includes("\n") || text.length >= enough) return text;
      }
      for (let next = i + 1; next < document.length; next++) {
        text += dealtProse(document[next].prose);
        if (text.includes("\n") || text.length >= enough) return text;
      }
      return text;
    };

    let from = 0;
    while (from < pieces.length) {
      if (pageIsFinished) startPage();
      const heldK = [...page.kundoku];
      const heldP = [...page.prose];
      const fitsThrough = (last: number): boolean => {
        page.kundoku = [...heldK];
        page.prose = [...heldP];
        for (let at = from; at <= last; at++) {
          page.kundoku.push(...pieces[at].kundoku);
          page.prose.push(...pieces[at].prose);
        }
        return (
          dealtKundokuColumns(page.kundoku) <= DEAL_KUNDOKU_COLUMNS &&
          planHangingMarks(dealtProse(page.prose), DEAL_SLOTS).columns.length <= DEAL_PROSE_COLUMNS
        );
      };

      const { through: fullest, spills } = pageThrough(from, pieces.length, pageIsEmpty, fitsThrough);
      let through = fullest;
      if (through < from) {
        page.kundoku = heldK;
        page.prose = heldP;
        page.closedBy = "sentence-boundary";
        atSentenceBoundary += 1;
        startPage();
        continue;
      }

      if (!spills && through < pieces.length - 1) {
        ruleRan += 1;
        page.closedBy = "rule";
        windows.push(through - from + 1);
        const judged = new Map<number, { flush: boolean; tidy: boolean }>();
        const judge = (last: number) => {
          const known = judged.get(last);
          if (known) return known;
          fitsThrough(last);
          const onPage = dealtProse(page.prose);
          const begun = blockBegunIn(onPage);
          const head = begun === null ? null : planHangingMarks(begun, DEAL_SLOTS).columns.length;
          const handed = blockHandedOn(remnantAfter(last));
          const tail = handed.text.length === 0 ? null : planHangingMarks(handed.text, DEAL_SLOTS).columns.length;
          const answer = {
            flush: endsColumnFlush(onPage, DEAL_SLOTS),
            tidy: tidyPages ? widowOrphanFree(head, tail, 2) : true,
          };
          judged.set(last, answer);
          return answer;
        };
        for (let last = from; last <= through; last++) if (!judge(last).tidy) sawUntidy += 1;
        const both = flushThrough(from, through, (last) => judge(last).flush && judge(last).tidy);
        const flushOnly = flushThrough(from, through, (last) => judge(last).flush);
        const cut = judge(both).flush && judge(both).tidy ? both : flushOnly;
        if (cut !== flushOnly) moved += 1;
        fitsThrough(cut);
        through = cut;
      }

      pageIsEmpty = false;
      pageIsFinished = spills;
      from = through + 1;
      if (from < pieces.length && !pageIsFinished) startPage();
    }
  }
  return { pages, atSentenceBoundary, ruleRan, sawUntidy, moved, windows };
}

/** **The deal `buildPrintLayout` performs now**, with the page's ledger: a
 * cursor over (sentence, piece) rather than a loop over sentences, so a page
 * that gives text back hands pieces of an *earlier* sentence to the next sheet
 * and `flushThrough` is bounded below by the head of the **page**.
 *
 * A mirror of that loop and not a model of it: the same `pageThrough` per
 * sentence, the same two-level walk over the whole page, the same close on both
 * kinds of full page — the one that runs out mid-sentence and the one that was
 * already full when the next sentence arrived. */
function dealWithLedger(
  document: ReturnType<typeof dealtDocument>,
  tidyPages: boolean,
  /** How far back the walk may give text, in prose characters. Unbounded as
   * shipped; a finite value is what the sweep in `a bounded give-back` prices. */
  reachChars = Number.POSITIVE_INFINITY,
  /** The block-end stop, shipped for one round and withdrawn: a page that ends
   * where a block ends counted as flush. Off as shipped now — the reader ruled
   * that a 章 should wrap — and kept as a parameter only so the cost of the
   * withdrawal can be measured rather than remembered. */
  blockEndsColumn = false,
) {
  const dealt = document.map((sentence) => {
    const pieces = dealtPieces(sentence);
    const text = pieces.map((piece) => dealtProse(piece.prose));
    return { pieces, text, whole: text.join("") };
  });
  const enough = (2 + 1) * DEAL_SLOTS;
  const pages: DealtPage[] = [];
  const windows: number[] = [];
  let sawUntidy = 0;
  let moved = 0;
  let fellBack = 0;
  const gaveBackPieces: number[] = [];
  const gaveBackCells: number[] = [];
  let onPage: { at: number; piece: number }[] = [];

  const proseThrough = (k: number) => onPage.slice(0, k + 1).map((e) => dealt[e.at].text[e.piece]).join("");
  const kundokuThrough = (k: number) => onPage.slice(0, k + 1).flatMap((e) => dealt[e.at].pieces[e.piece].kundoku);
  const fits = (k: number) =>
    dealtKundokuColumns(kundokuThrough(k)) <= DEAL_KUNDOKU_COLUMNS &&
    planHangingMarks(proseThrough(k), DEAL_SLOTS).columns.length <= DEAL_PROSE_COLUMNS;
  const remnantAfter = (k: number): string => {
    const cut = onPage[k];
    let text = "";
    for (let piece = cut.piece + 1; piece < dealt[cut.at].pieces.length; piece++) {
      text += dealt[cut.at].text[piece];
      if (text.includes("\n") || text.length >= enough) return text;
    }
    for (let next = cut.at + 1; next < dealt.length; next++) {
      text += dealt[next].whole;
      if (text.includes("\n") || text.length >= enough) return text;
    }
    return text;
  };
  const settledPage = (): number => {
    const ceiling = onPage.length - 1;
    if (ceiling < 0) return ceiling;
    windows.push(ceiling + 1);
    const judged = new Map<number, { flush: boolean; tidy: boolean }>();
    const judge = (k: number) => {
      const known = judged.get(k);
      if (known) return known;
      const shown = proseThrough(k);
      const begun = blockBegunIn(shown);
      const head = begun === null ? null : planHangingMarks(begun, DEAL_SLOTS).columns.length;
      const handed = blockHandedOn(remnantAfter(k));
      const tail = handed.text.length === 0 ? null : planHangingMarks(handed.text, DEAL_SLOTS).columns.length;
      const answer = {
        flush: (blockEndsColumn && handed.ends && handed.text.length === 0) || endsColumnFlush(shown, DEAL_SLOTS),
        tidy: tidyPages ? widowOrphanFree(head, tail, 2) : true,
      };
      judged.set(k, answer);
      return answer;
    };
    for (let k = 0; k <= ceiling; k++) if (!judge(k).tidy) sawUntidy += 1;
    const fullest = proseThrough(ceiling).length;
    let floor = ceiling;
    while (floor > 0 && fullest - proseThrough(floor - 1).length <= reachChars) floor -= 1;
    const both = flushThrough(floor, ceiling, (k) => judge(k).flush && judge(k).tidy);
    const flushOnly = flushThrough(floor, ceiling, (k) => judge(k).flush);
    const cut = judge(both).flush && judge(both).tidy ? both : flushOnly;
    if (cut !== flushOnly) moved += 1;
    gaveBackPieces.push(ceiling - cut);
    gaveBackCells.push(
      onPage.slice(cut + 1).reduce((a, e) => a + dealt[e.at].pieces[e.piece].kundoku.reduce((x, c) => x + c.cells, 0), 0),
    );
    if (!judge(cut).flush) fellBack += 1;
    return cut;
  };
  const closePage = (cut: number) => {
    onPage.length = cut + 1;
    pages.push({ prose: onPage.flatMap((e) => dealt[e.at].pieces[e.piece].prose), kundoku: onPage.flatMap((e) => dealt[e.at].pieces[e.piece].kundoku), entries: [...onPage], closedBy: "rule" });
    const last = onPage[cut];
    onPage = [];
    return last.piece + 1 < dealt[last.at].pieces.length
      ? { at: last.at, piece: last.piece + 1 }
      : { at: last.at + 1, piece: 0 };
  };

  let at = 0;
  let piece = 0;
  while (at < dealt.length) {
    const pieces = dealt[at].pieces;
    if (piece >= pieces.length) {
      at += 1;
      piece = 0;
      continue;
    }
    const base = onPage.length;
    const fitsThrough = (last: number) => {
      onPage.length = base;
      for (let p = piece; p <= last; p++) onPage.push({ at, piece: p });
      return fits(onPage.length - 1);
    };
    const { through, spills } = pageThrough(piece, pieces.length, base === 0, fitsThrough);
    if (spills) {
      pages.push({ prose: onPage.flatMap((e) => dealt[e.at].pieces[e.piece].prose), kundoku: onPage.flatMap((e) => dealt[e.at].pieces[e.piece].kundoku), entries: [...onPage], closedBy: "rule" });
      onPage = [];
      piece = through + 1;
      continue;
    }
    if (through === pieces.length - 1) {
      at += 1;
      piece = 0;
      continue;
    }
    const next = closePage(settledPage());
    at = next.at;
    piece = next.piece;
  }
  if (onPage.length > 0) {
    pages.push({ prose: onPage.flatMap((e) => dealt[e.at].pieces[e.piece].prose), kundoku: onPage.flatMap((e) => dealt[e.at].pieces[e.piece].kundoku), entries: [...onPage], closedBy: "document-end" });
  }
  return { pages, windows, sawUntidy, moved, fellBack, gaveBackPieces, gaveBackCells };
}

/** **The faults on the pages that came out**, counted from the printed pages
 * and not from the constraint's own opinion of them.
 *
 * Each page's prose is read as the band prints it, with the leading `<br>` the
 * layout trims at a band's head taken off (a page turn is itself the start of a
 * column). The fragments between the newlines are then stitched back into
 * blocks across the pages, and a block that stands on more than one page is an
 * orphan where its first page holds one column of it and a widow where its
 * last page does. */
function faultsOn(pages: readonly DealtPage[]) {
  const printed = pages
    .map((page) => {
      let text = dealtProse(page.prose);
      let headBreak = false;
      while (text.startsWith("\n")) {
        headBreak = true;
        text = text.slice(1);
      }
      return {
        text,
        headBreak,
        fragments: text.split("\n").map((run) => planHangingMarks(run, DEAL_SLOTS).columns.length),
      };
    })
    .filter((page) => page.text.length > 0);

  const blocks: number[][] = [];
  let open: number[] | null = null;
  printed.forEach((page, index) => {
    page.fragments.forEach((columns, at) => {
      if (at > 0 || page.headBreak || index === 0 || open === null) {
        open = [columns];
        blocks.push(open);
      } else open.push(columns);
      if (at < page.fragments.length - 1) open = null;
    });
  });

  let orphans = 0;
  let widows = 0;
  for (const block of blocks) {
    if (block.length < 2) continue;
    if (block[0] < 2) orphans += 1;
    if (block[block.length - 1] < 2) widows += 1;
  }
  return {
    pages: printed.length,
    blocks: blocks.length,
    orphans,
    widows,
    flush: printed.filter((page) => endsColumnFlush(page.text, DEAL_SLOTS)).length,
    columns: printed.map((page) => page.fragments.reduce((a, b) => a + b, 0)),
  };
}

/** ── EXPERIMENT: the deal with the paired cut relaxed ────────────────────
 * Each band stops where it likes, the two constrained only to stand in the
 * same sentence at every page break. */
interface FreeBand {
  children: DealChild[];
  /** Prefix lengths the band may stop at, in document order. */
  stops: number[];
  /** Which sentence each stop stands in. */
  sentence: number[];
}
function freeBandOf(document: ReturnType<typeof dealtDocument>, side: "kundoku" | "prose"): FreeBand {
  const children: DealChild[] = [];
  const stops: number[] = [];
  const sentence: number[] = [];
  document.forEach((s, at) => {
    const own = side === "kundoku" ? s.kundoku : s.prose;
    const base = children.length;
    const cuts = unpairedCuts(own.map(asCutUnit)).map((c) => c.kundoku);
    for (const c of cuts) {
      stops.push(base + c);
      sentence.push(at);
    }
    stops.push(base + own.length);
    sentence.push(at);
    children.push(...own);
  });
  return { children, stops, sentence };
}

function dealFreely(document: ReturnType<typeof dealtDocument>, tidyPages: boolean, crossSentence = false, blockEndsColumn = false) {
  const K = freeBandOf(document, "kundoku");
  const P = freeBandOf(document, "prose");
  const kFits = (from: number, to: number) => dealtKundokuColumns(K.children.slice(from, to)) <= DEAL_KUNDOKU_COLUMNS;
  const proseAt = (from: number, to: number) => P.children.slice(from, to).map((c) => c.text).join("");
  const pFits = (from: number, to: number) =>
    planHangingMarks(proseAt(from, to), DEAL_SLOTS).columns.length <= DEAL_PROSE_COLUMNS;

  const pages: { kundoku: DealChild[]; prose: DealChild[]; kSentence: number; pSentence: number; endsAtBlock: boolean }[] = [];
  let kPos = 0;
  let pPos = 0;
  let ki = 0;
  let pi = 0;
  let fellBack = 0;
  let guard = 0;

  while (ki < K.stops.length && pi < P.stops.length) {
    if (++guard > 10000) throw new Error("free deal made no progress");
    let kMax = ki - 1;
    while (kMax + 1 < K.stops.length && kFits(kPos, K.stops[kMax + 1])) kMax += 1;
    let pMax = pi - 1;
    while (pMax + 1 < P.stops.length && pFits(pPos, P.stops[pMax + 1])) pMax += 1;
    const topS = Math.min(
      kMax >= ki ? K.sentence[kMax] : K.sentence[ki],
      pMax >= pi ? P.sentence[pMax] : P.sentence[pi],
    );
    /** The largest kundoku stop that fits and stands in sentence `s`. */
    const kIn = (s: number) => {
      let best = -1;
      for (let t = ki; t <= kMax; t++) if (K.sentence[t] === s) best = t;
      return best;
    };
    const pIn = (s: number) => {
      const out: number[] = [];
      for (let t = pi; t <= pMax; t++) if (P.sentence[t] === s) out.push(t);
      return out;
    };
    const judged = new Map<number, { flush: boolean; tidy: boolean }>();
    const judge = (t: number) => {
      const known = judged.get(t);
      if (known) return known;
      const shown = proseAt(pPos, P.stops[t]);
      let rest = "";
      for (let x = P.stops[t]; x < P.children.length && rest.length < 3 * DEAL_SLOTS; x++) rest += P.children[x].text;
      const begun = blockBegunIn(shown);
      const head = begun === null ? null : planHangingMarks(begun, DEAL_SLOTS).columns.length;
      const handed = blockHandedOn(rest);
      const tail = handed.text.length === 0 ? null : planHangingMarks(handed.text, DEAL_SLOTS).columns.length;
      const answer = {
        flush: (blockEndsColumn && handed.ends && handed.text.length === 0) || endsColumnFlush(shown, DEAL_SLOTS),
        tidy: tidyPages ? widowOrphanFree(head, tail, 2) : true,
      };
      judged.set(t, answer);
      return answer;
    };

    // The sentence both bands stand in, and their stops inside it.
    let S = topS;
    while (S >= 0 && (kIn(S) < 0 || pIn(S).length === 0)) S -= 1;
    if (S < 0) {
      // Nothing fits at all: let each band spill by one stop, which is what
      // `pageThrough` does with a piece too long for a page of its own.
      const kCut = Math.min(ki, K.stops.length - 1);
      const pCut = Math.min(pi, P.stops.length - 1);
      pages.push({
        kundoku: K.children.slice(kPos, K.stops[kCut]),
        prose: P.children.slice(pPos, P.stops[pCut]),
        kSentence: K.sentence[kCut], pSentence: P.sentence[pCut], endsAtBlock: false,
      });
      kPos = K.stops[kCut]; pPos = P.stops[pCut];
      ki = kCut + 1; pi = pCut + 1;
      while (ki < K.stops.length && K.stops[ki] <= kPos) ki += 1;
      while (pi < P.stops.length && P.stops[pi] <= pPos) pi += 1;
      continue;
    }

    // ── The prose band's own walk ────────────────────────────────────────
    // Every prose stop the page could end at, in order: those in `S`, and —
    // where `crossSentence` allows it — those in the sentences before it, whose
    // sentence the kundoku band can also stand in. Within `S` a give-back is
    // free (the kundoku band does not move for it); across a sentence boundary
    // the kundoku band has to retreat with it.
    //
    // **Both levels walk the whole list before either gives up**, which is
    // `settledPage`'s order and not a per-sentence one: a flush-but-untidy stop
    // in `S` must not beat a flush-and-tidy stop in `S - 1`, or the widow rule
    // is overruled by a sentence boundary that has nothing to do with it.
    const reachable: number[] = [];
    for (let s = crossSentence ? 0 : S; s <= S; s++) {
      if (kIn(s) < 0) continue;
      for (const t of pIn(s)) reachable.push(t);
    }
    reachable.sort((a, b) => a - b);
    const down = [...reachable].reverse();
    let pCut = down.find((t) => judge(t).flush && judge(t).tidy) ?? down.find((t) => judge(t).flush) ?? -1;
    if (pCut < 0) {
      fellBack += 1;
      pCut = reachable[reachable.length - 1];
    }
    const chosenS = P.sentence[pCut];
    const kCut = kIn(chosenS);
    const shown = proseAt(pPos, P.stops[pCut]);
    let rest = "";
    for (let x = P.stops[pCut]; x < P.children.length && rest.length < 3 * DEAL_SLOTS; x++) rest += P.children[x].text;
    pages.push({
      kundoku: K.children.slice(kPos, K.stops[kCut]),
      prose: P.children.slice(pPos, P.stops[pCut]),
      kSentence: K.sentence[kCut],
      pSentence: P.sentence[pCut],
      endsAtBlock: blockHandedOn(rest).ends && blockHandedOn(rest).text.length === 0,
    });
    void shown;
    kPos = K.stops[kCut];
    pPos = P.stops[pCut];
    ki = kCut + 1;
    pi = pCut + 1;
    while (ki < K.stops.length && K.stops[ki] <= kPos) ki += 1;
    while (pi < P.stops.length && P.stops[pi] <= pPos) pi += 1;
  }
  return { pages, fellBack };
}

// ---------------------------------------------------------------------------
// What the type scale prints, in points.
//
// The reader asked for a factor and got characters; "microscopic" is a judgement
// about paper, and points is the unit it can be made in. 1 CSS px is 1/96 inch
// and 1pt is 1/72, so a point is three quarters of a pixel.
//
// **Nothing in the print pipeline scales the page a second time.** Checked
// rather than assumed: `@page` is A4 landscape at 14mm, which is exactly the
// 269 x 182mm `makeBand` sizes the bands in; `#print-root` carries only
// `position` and an off-canvas `left`; the only `transform` anywhere in the
// path is `spreadSpill`'s `translateX`, which moves and does not shrink; no
// rule sets a root `font-size`, and `--type-max-size` is a fixed 2.75rem with
// no media query anywhere near it. So the arithmetic below is the size on
// paper, unless the print dialog's own scale setting is under 100%.
// ---------------------------------------------------------------------------

describe("the print type scale reduces to the stylesheet at 1", () => {
  // **The property that makes the factor a factor**, and the one that was
  // false. The first build read `--size-main` with `parseFloat` on
  // `getComputedStyle`, and an unregistered custom property computes to its own
  // token sequence — `2.75rem` came back as the string "2.75rem" and parsed as
  // 2.75. Every length was a sixteenth of what it should have been, so the page
  // the reader called microscopic was set at 33/960 rather than 33/60.
  //
  // typography.css records the same trap where it registers `--size-furigana`:
  // "An unregistered custom property computes to its own token sequence with
  // `var()`s substituted and nothing else done." It cost `annotationCapacity`
  // eleven reading lanes once; it cost this two prints.
  //
  // The fix measures the two base lengths off a probe rather than parsing
  // them, which is unverifiable from here — there is no browser. **What is
  // verifiable is the arithmetic on top of them, and that is what this checks:
  // given the right pixels, scale 1 is the stylesheet exactly.**
  const shipped = { size: 44, kunten: 16, gapRatio: 1, lineHeight: 2 };

  it("gives back every one of typography.css's own values", () => {
    const at1 = printTypeScaleLengths(shipped.size, shipped.kunten, shipped.gapRatio, shipped.lineHeight, 1);
    expect(at1["--size-main"]).toBe(44); // --type-max-size, 2.75rem
    expect(at1["--kanji-gap"]).toBe(44); // size x --kanji-gap-ratio
    expect(at1["--kanji-advance"]).toBe(88); // size + gap
    expect(at1["--column-pitch"]).toBe(88); // size x --line-height-main
    expect(at1["--column-pitch-kakikudashi"]).toBe(44); // pitch / 2 — the lock
    expect(at1["--size-kakikudashi"]).toBe(22); // size x 0.5
    expect(at1["--line-height-kakikudashi"]).toBe(44); // = the prose pitch
    expect(at1["--size-kakikudashi-ruby"]).toBe(11); // prose size / 2
    expect(at1["--size-furigana"]).toBeCloseTo(44 / 3, 10); // three kana to a kanji
    expect(at1["--size-kunten"]).toBe(16); // --type-min-size, 1rem
    // Every advance the rest of this file is measured in follows from them.
    expect(at1["--kanji-advance"]).toBe(88);
    expect(at1["--size-kakikudashi"] * 1.15).toBeCloseTo(25.3, 10);
  });

  it("scales every length by the factor and nothing else", () => {
    // Linearity, which is what lets the reader choose a number and get it: no
    // length has a floor, a rounding or a special case in it, so the page at
    // factor f is the page at 1 times f in every dimension.
    const at1 = printTypeScaleLengths(shipped.size, shipped.kunten, shipped.gapRatio, shipped.lineHeight, 1);
    for (const scale of [33 / 60, 0.75, 0.8, 0.85, 0.9, 2]) {
      const at = printTypeScaleLengths(shipped.size, shipped.kunten, shipped.gapRatio, shipped.lineHeight, scale);
      for (const name of Object.keys(at1)) expect(at[name]).toBeCloseTo(at1[name] * scale, 10);
    }
  });

  it("records what the fault would have written, so it cannot come back unnoticed", () => {
    // The old reading, in the units it actually produced: 2.75 for `--size-main`
    // and 1 for `--size-kunten`, both a sixteenth of the truth at a 16px root.
    const faulty = printTypeScaleLengths(2.75, 1, shipped.gapRatio, shipped.lineHeight, 33 / 60);
    expect(faulty["--size-main"]).toBeCloseTo(1.5125, 4);
    expect(faulty["--size-main"] * 0.75).toBeCloseTo(1.13, 2); // points on paper
    const intended = printTypeScaleLengths(shipped.size, shipped.kunten, shipped.gapRatio, shipped.lineHeight, 33 / 60);
    expect(intended["--size-main"] / faulty["--size-main"]).toBeCloseTo(16, 6);
  });
});

describe("the printed type scale, in points", () => {
  const pt = (px: number) => +(px * 0.75).toFixed(2);
  /** The ten lengths `applyPrintTypeScale` rewrites, at a given factor. */
  const points = (scale: number) => {
    const size = 44 * scale;
    return {
      main: pt(size),
      gap: pt(size),
      advance: pt(2 * size),
      pitch: pt(2 * size),
      pitchProse: pt(size),
      prose: pt(size / 2),
      lineHeightProse: pt(size),
      proseRuby: pt(size / 4),
      furigana: pt(size / 3),
      kunten: pt(16 * scale),
    };
  };

  it("prints the screen scale at 33pt and 33/60 at 18.15pt", () => {
    expect(points(1)).toEqual({
      main: 33, gap: 33, advance: 66, pitch: 66, pitchProse: 33,
      prose: 16.5, lineHeightProse: 33, proseRuby: 8.25, furigana: 11, kunten: 12,
    });
    expect(points(33 / 60)).toEqual({
      main: 18.15, gap: 18.15, advance: 36.3, pitch: 36.3, pitchProse: 18.15,
      prose: 9.08, lineHeightProse: 18.15, proseRuby: 4.54, furigana: 6.05, kunten: 6.6,
    });
  });

  it("puts the smallest thing on the page at 4.54pt, and it is the 書き下し文 gloss", () => {
    // **Not the kaeriten and not the furigana**, which are the two that get
    // named: the gloss ruby over the prose is a quarter of the character, and a
    // quarter of 18.15pt is four and a half. That is below anything a press
    // sets running text in, and it is what "microscopic" is most likely to be.
    const at = points(33 / 60);
    expect(Math.min(...Object.values(at))).toBe(at.proseRuby);
    expect(at.proseRuby).toBe(4.54);
  });

  it("cannot float the two ruby sizes, and can float the kaeriten", () => {
    // **Which annotations may be given a floor is not a matter of taste.**
    //
    //  - `--size-furigana` is read by seven placements in kunten.css — the
    //    okurigana lane, the furigana run, the vertical centring of a reading
    //    against its character, the reading lane's width, the reread mark's
    //    length and its `left` offset — and typography.css sizes it so that
    //    **exactly three kana come to one kanji**. Float it and every placement
    //    in the reading lane is measured against a character it no longer
    //    divides.
    //  - `--size-kakikudashi-ruby` is **exactly two kana to one character of
    //    prose**, and typography.css records that at half the character a
    //    two-kana share "cannot overhang into the next column, so the guarantee
    //    is visible and not merely structural" — the guarantee being the two
    //    prose columns to one kundoku column that the widow threshold and the
    //    scroll sync both rest on. Float it and the ruby overhangs.
    //  - `--size-kunten` is read by **no geometry at all**: it appears in one
    //    declaration, `.kunten-glyph { font-size }`, and nowhere in kunten.css.
    //    A kaeriten is positioned against `.kanji-glyph`'s own edges (rule 1),
    //    so its size is a legibility choice and nothing is built on it.
    //
    // So the two ruby sizes move with the base by construction and only the
    // kaeriten can be floored — **which means that if the ruby is too small,
    // the factor is wrong**, and no amount of floating annotations will answer
    // it. It also means there is no ratio to restore for the kaeriten: it was
    // `--type-min-size`, the floor of the scale, and its 0.364 of a character
    // was an accident of two fixed numbers rather than a designed relation.
    const ratios = (scale: number) => {
      const at = points(scale);
      return { furigana: +(at.furigana / at.main).toFixed(3), proseRuby: +(at.proseRuby / at.prose).toFixed(3) };
    };
    expect(ratios(1)).toEqual({ furigana: 0.333, proseRuby: 0.5 });
    expect(ratios(33 / 60)).toEqual({ furigana: 0.333, proseRuby: 0.5 });
    // What a legible gloss would cost, as a factor: the ruby is a quarter of
    // the character, so a 6pt gloss wants a 24pt character and a factor of
    // 24/33 — and a 5pt gloss wants 20pt and 0.606.
    expect(pt(44 * (24 / 33) / 4)).toBe(6);
    expect(pt(44 * 0.606 / 4)).toBeCloseTo(5, 1);
  });
});

// ---------------------------------------------------------------------------
// The factor, as rows he can choose from.
//
// **He asked for a factor and got characters; points on paper and sheets of
// paper are the two units he can judge in.** And the rows cannot be
// interpolated between: a 章 is nine kundoku cells and a source line break
// opens a column of its own, so how well a factor divides nine decides how
// full a sheet comes out and whether a 章 can wrap at all. The fill swings from
// 49% to 87% across six neighbouring factors, and 章 wrap at 1.0, 0.9 and 0.85,
// **stop dead at 0.8 and 0.75**, and start again at 33/60.
//
// The smallest item at every factor is the 書き下し文 gloss, at a quarter of the
// character — 8.25pt at 1.0, 6.6pt at 0.8, 4.54pt at 33/60. If the gloss is
// what has to be legible, that column is where the choice is made; the option
// of not printing the gloss at all would take the constraint off entirely and
// leave the character free to be as small as the kanbun wants.
// ---------------------------------------------------------------------------

describe("the factor, in points and sheets", () => {
  const pt = (px: number) => +(px * 0.75).toFixed(2);
  const points = (scale: number) => {
    const at = printTypeScaleLengths(44, 16, 1, 2, scale);
    return {
      kundoku: pt(at["--size-main"]),
      prose: pt(at["--size-kakikudashi"]),
      furigana: pt(at["--size-furigana"]),
      kaeriten: pt(at["--size-kunten"]),
      gloss: pt(at["--size-kakikudashi-ruby"]),
    };
  };
  const dealt = (scale: number) =>
    atScale(scale, () => {
      const deal = dealWithLedger(dealtDocument(800, "chapter"), true);
      const faults = faultsOn(deal.pages);
      let wraps = 0;
      for (let i = 0; i + 1 < deal.pages.length; i++) if (!deal.pages[i + 1].kundoku[0]?.breaks) wraps += 1;
      const cells = deal.pages.map((p) => p.kundoku.reduce((a, c) => a + c.cells, 0)).filter((n) => n > 0);
      return {
        sheets: faults.pages,
        widows: faults.widows,
        orphans: faults.orphans,
        wraps,
        fill: Math.round((cells.reduce((a, b) => a + b, 0) / cells.length / (DEAL_CELLS_PER_COLUMN * DEAL_KUNDOKU_COLUMNS)) * 100),
        none: dealWithLedger(dealtDocument(800, "none"), true).pages.length,
        shuchu: dealWithLedger(dealtDocument(800, 217), true).pages.length,
      };
    });

  it("prints the five sizes he can judge, at each factor", () => {
    expect(points(1)).toEqual({ kundoku: 33, prose: 16.5, furigana: 11, kaeriten: 12, gloss: 8.25 });
    expect(points(0.9)).toEqual({ kundoku: 29.7, prose: 14.85, furigana: 9.9, kaeriten: 10.8, gloss: 7.43 });
    expect(points(0.85)).toEqual({ kundoku: 28.05, prose: 14.02, furigana: 9.35, kaeriten: 10.2, gloss: 7.01 });
    expect(points(0.8)).toEqual({ kundoku: 26.4, prose: 13.2, furigana: 8.8, kaeriten: 9.6, gloss: 6.6 });
    expect(points(0.75)).toEqual({ kundoku: 24.75, prose: 12.38, furigana: 8.25, kaeriten: 9, gloss: 6.19 });
    expect(points(33 / 60)).toEqual({ kundoku: 18.15, prose: 9.08, furigana: 6.05, kaeriten: 6.6, gloss: 4.54 });
    // The gloss is the smallest at every one of them, being a quarter of the
    // character where the furigana is a third and the kaeriten 0.364.
    for (const scale of [1, 0.9, 0.85, 0.8, 0.75, 33 / 60]) {
      const at = points(scale);
      expect(Math.min(...Object.values(at))).toBe(at.gloss);
    }
  }, 30000);

  it("prints the paper each factor costs, dealt", () => {
    // 學而, then the two long-block texts. **33/60 is the good row**: it is the
    // only one that both fills the sheet (78%) and wraps a 章, and it prints
    // 44 sheets against 1.0's 175. Of the rest, 0.8 fills less than half a
    // sheet, 0.9 and 0.85 print 51 and 50 orphans, and neither 0.8 nor 0.75
    // wraps a single 章. 1.0 wraps 174 of its breaks and takes 99 widows for
    // it, which is the shape of a text whose blocks no longer fit a column —
    // see the note at the head of `the deal, on the parses in the fixtures`.
    expect(dealt(1)).toMatchObject({ sheets: 175, none: 138, shuchu: 150, wraps: 174, widows: 99, orphans: 0, fill: 75 });
    expect(dealt(0.9)).toMatchObject({ sheets: 150, none: 101, shuchu: 109, wraps: 100, orphans: 51, fill: 67 });
    expect(dealt(0.85)).toMatchObject({ sheets: 126, none: 100, shuchu: 100, wraps: 76, orphans: 50, fill: 73 });
    expect(dealt(0.8)).toMatchObject({ sheets: 150, none: 100, shuchu: 84, wraps: 0, orphans: 0, fill: 49 });
    expect(dealt(0.75)).toMatchObject({ sheets: 101, none: 99, shuchu: 75, wraps: 0, orphans: 0, fill: 68 });
    expect(dealt(33 / 60)).toMatchObject({ sheets: 44, none: 37, shuchu: 40, wraps: 25, widows: 37, orphans: 25, fill: 78 });
  }, 120000);
});

// **Every figure in this describe moved together in one census, and the cause
// is a single character.** 亦 is now written 亦た (see `KANJI_RETAINED_ADVERBS`
// in `classicalEnding.ts` — the received reading writes it that way on 121 of
// 121 occurrences), and three of the four fixture 章 carry a 亦. At 33/60 a
// prose column holds ten characters, so one extra character took 學而's
// shortest 章 from 18 characters to 19 and from one prose column to two, which
// is what every count below is downstream of: the histogram, the wraps, the
// widows, the fullness spread and the sheets. The relations the tests assert —
// that no page falls back to the fullest cut, that a 章 wraps, that every
// division of one of these 章 leaves a single column standing alone — are
// unchanged; only the numbers are.
describe("the deal, on the parses in the fixtures", () => {
  // **Re-measured at the print type scale.** The reader asked for the printed
  // characters at 33/60, and two effects of that run in opposite directions and
  // are both large: a smaller character puts more characters in a column, so a
  // 章 occupies fewer of them; and it puts more columns across the page, so a
  // sheet holds far more. The sheet goes from 55 kundoku cells to 210, and
  // these documents from 38, 34 and 34 sheets to 10, 9 and 10.
  //
  // 800 章 here rather than the 200 the earlier figures were taken at, so that
  // a page break is still measured forty times over instead of nine. The
  // 200-章 sheet counts — the direct comparison with what the reader has
  // agreed to — are checked at the foot of this block.
  const shapes = {
    chapter: dealtDocument(800, "chapter"),
    none: dealtDocument(800, "none"),
    shuchu: dealtDocument(800, 217),
  };
  const before = {
    chapter: dealBeforeTheLedger(shapes.chapter, true),
    none: dealBeforeTheLedger(shapes.none, true),
    shuchu: dealBeforeTheLedger(shapes.shuchu, true),
  };
  const after = {
    chapter: dealWithLedger(shapes.chapter, true),
    none: dealWithLedger(shapes.none, true),
    shuchu: dealWithLedger(shapes.shuchu, true),
  };
  const shapeNames = ["chapter", "none", "shuchu"] as const;

  const fullness = (pages: readonly DealtPage[]) =>
    pages.map((page) => page.kundoku.reduce((a, child) => a + child.cells, 0)).filter((cells) => cells > 0);
  const spread = (counts: readonly number[]) => {
    const sorted = [...counts].sort((a, b) => a - b);
    const at = (f: number) => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))];
    return { min: sorted[0], p5: at(0.05), median: at(0.5), max: sorted[sorted.length - 1],
      mean: +(sorted.reduce((a, b) => a + b, 0) / sorted.length).toFixed(1) };
  };
  const wraps = (pages: readonly DealtPage[]) => {
    let wrapped = 0;
    for (let i = 0; i + 1 < pages.length; i++) if (!pages[i + 1].kundoku[0]?.breaks) wrapped += 1;
    return wrapped;
  };
  const blockColumns = (document: ReturnType<typeof dealtDocument>) => {
    const lengths: number[] = [];
    let run = "";
    const close = () => {
      if (run) lengths.push(planHangingMarks(run, DEAL_SLOTS).columns.length);
      run = "";
    };
    for (const sentence of document) {
      for (const child of sentence.prose) {
        if (child.breaks) close();
        else run += child.text;
      }
    }
    close();
    return lengths;
  };

  it("puts a page's worth of text where a quarter of one used to go", () => {
    // The whole of what the rescale does to the sheet, and every one of these
    // is derived rather than written down — see `kundokuSlotsFor` and the
    // geometry block above. 10 cells to a kundoku column against 5, 21 columns
    // across the page against 11, so **210 cells to a sheet against 55**.
    expect(DEAL_CELLS_PER_COLUMN).toBe(10);
    expect(DEAL_KUNDOKU_COLUMNS).toBe(21);
    expect(DEAL_PROSE_COLUMNS).toBe(42);
    expect(DEAL_CELLS_PER_COLUMN * DEAL_KUNDOKU_COLUMNS).toBe(210);
    // The reader's own documents, at the 200 章 his agreed figures were taken
    // at: 學而 38 sheets becomes 11, and the two long-block texts 34 each
    // become 9 and 10.
    expect(dealWithLedger(dealtDocument(200, "chapter"), true).pages.length).toBe(11);
    expect(dealWithLedger(dealtDocument(200, "none"), true).pages.length).toBe(9);
    expect(dealWithLedger(dealtDocument(200, 217), true).pages.length).toBe(10);
  });

  it("ends every page at the foot of a full prose column", () => {
    // The rule's own measure: **no page on any of the three documents falls
    // back to the fullest cut**, and 43 of 44, 36 of 37 and 39 of 40 end flush,
    // against 21 of 41, 25 of 35 and 5 of 37 before the ledger.
    for (const name of shapeNames) expect(after[name].fellBack).toBe(0);
    expect(faultsOn(after.chapter.pages).flush).toBe(43);
    expect(faultsOn(after.none.pages).flush).toBe(36);
    expect(faultsOn(after.shuchu.pages).flush).toBe(39);
    expect(faultsOn(before.chapter.pages).flush).toBe(21);
    expect(faultsOn(before.none.pages).flush).toBe(25);
    expect(faultsOn(before.shuchu.pages).flush).toBe(5);
  });

  it("gives the walks the page to give back into, where they had one to three cuts", () => {
    // `flushThrough(from, …)` could only give back pieces of the sentence
    // straddling the page's foot. `flushThrough(0, …)` over the page's ledger
    // is the fix, and at this scale a page is four times the text, so the walk
    // now chooses among 97 to 123 cuts where it had two or three.
    const window = (deal: { windows: number[] }) =>
      deal.windows.length === 0 ? 0 : deal.windows.reduce((a, b) => a + b, 0) / deal.windows.length;
    expect(Math.max(...before.none.windows)).toBe(3);
    expect(Math.max(...before.shuchu.windows)).toBe(3);
    // On 學而 the old deal reached the walk on **7 pages of 42**: 35 of the
    // breaks fell to the sentence-boundary branch instead.
    expect(before.chapter.windows.length).toBe(7);
    expect(before.chapter.atSentenceBoundary).toBe(35); // of 42 breaks
    for (const name of shapeNames) expect(window(after[name])).toBeGreaterThan(90);
  });

  it("lets a 章 wrap across pages, which is what the reader ruled for", () => {
    // **His ruling: "章 should wrap."** 25 page breaks of 43 on 學而 leave a 章
    // divided across the turn, against 14 for the deal before the ledger. The
    // two long-block texts wrap all but two breaks between them.
    expect(wraps(after.chapter.pages)).toBe(25);
    expect(after.chapter.pages.length - 1).toBe(43);
    expect(wraps(before.chapter.pages)).toBe(14);
    expect(wraps(after.none.pages)).toBe(36);
    expect(wraps(after.shuchu.pages)).toBe(39);
  });

  it("makes every 章 too short to divide without a one-column remnant", () => {
    // **The tension, and at this scale it is total.** At 33/60 a prose column
    // holds ten characters, and 學而's 章 run 12, 14, 19, 20, 28 and 29 — so
    // they come to **two and three prose columns**, 600 and 200 of the 800.
    // Every one of them is under the four columns an even division needs, where
    // at the screen scale a quarter of them were not.
    const lengths = blockColumns(shapes.chapter);
    expect(lengths.length).toBe(800);
    const histogram: Record<number, number> = {};
    for (const columns of lengths) histogram[columns] = (histogram[columns] ?? 0) + 1;
    expect(histogram).toEqual({ 2: 600, 3: 200 });
    expect(lengths.filter((c) => c < 2 * 2).length).toBe(800);
    // **Pinned in characters as well as columns**, because this is the census
    // that keeps moving under the reading conventions and it is the one that
    // decides whether a 章 can be divided at all. Nine okurigana corrections
    // landed without shifting it; the tenth did — 亦 is written 亦た now (see
    // `KANJI_RETAINED_ADVERBS`), which is one character on three of these four
    // 章 and moved the shortest of them off the foot of its column.
    const characters: number[] = [];
    let text = "";
    const shut = () => {
      if (text) characters.push(text.length);
      text = "";
    };
    for (const sentence of shapes.chapter) {
      for (const child of sentence.prose) {
        if (child.breaks) shut();
        else text += child.text;
      }
    }
    shut();
    expect([...new Set(characters)].sort((a, b) => a - b)).toEqual([12, 14, 19, 20, 28, 29]);
    // Exhaustively: a one-column 章 cannot be divided at all; a two-column 章
    // divides 1-1; a three-column 章 divides 1-2 or 2-1. **Every division of a
    // 章 on this text leaves a single column standing alone**, so "a 章 should
    // wrap" and "no one-column remnant" are not in tension here, they are
    // exclusive. The wrapped 章 come to 62 such remnants — 37 widows and 25
    // orphans — which is what the arithmetic requires and not a cut the walk
    // failed to find.
    expect(faultsOn(after.chapter.pages)).toMatchObject({ widows: 37, orphans: 25 });
    expect(faultsOn(dealWithLedger(shapes.chapter, false).pages)).toMatchObject({ widows: 37, orphans: 25 });
    // The two long-block texts are untouched by any of it: their blocks are 22
    // and 23 columns, and 1401, so the threshold is never capped and no fault
    // is printed.
    expect(blockColumns(shapes.shuchu).filter((c) => c < 4).length).toBe(0);
    expect(faultsOn(after.shuchu.pages)).toMatchObject({ widows: 0, orphans: 0 });
    expect(faultsOn(after.none.pages)).toMatchObject({ widows: 0, orphans: 0 });
  });

  it("judges every cut for a widow, and overrides the flush one where it can", () => {
    // Before the ledger the widow level changed no cut on any document.
    for (const name of shapeNames) expect(before[name].moved).toBe(0);
    // With the page to give back into it refuses 616 candidates on 學而 and 399
    // on 酒蟲's shape — and on 酒蟲's shape it **acts**, moving three cuts and
    // taking four orphans off the document that the flush walk alone would have
    // left, at the cost of one sheet.
    expect(after.chapter.sawUntidy).toBe(616);
    expect(after.shuchu.sawUntidy).toBe(399);
    expect(after.shuchu.moved).toBe(3);
    expect(faultsOn(dealWithLedger(shapes.shuchu, false).pages)).toMatchObject({ widows: 0, orphans: 4 });
    expect(faultsOn(after.shuchu.pages)).toMatchObject({ widows: 0, orphans: 0 });
    expect(dealWithLedger(shapes.shuchu, false).pages.length).toBe(after.shuchu.pages.length - 1);
    // On 學而 it can act on nothing, and the pages come out the same with it
    // off — not because it is idle but because every candidate it could move to
    // carries the same one-column remnant. That is the cap doing what it is
    // for: it does not spend sheets refusing a division the text has no better
    // version of.
    expect(after.chapter.moved).toBe(0);
    expect(dealWithLedger(shapes.chapter, false).pages.length).toBe(after.chapter.pages.length);
  });

  it("fills the page it is given, at four times the text", () => {
    // A sheet holds 210 cells now. 學而 comes out at a median of 164 and a
    // floor of 131; the two long-block texts at medians of 205 and 181 with
    // floors of 17 and 144. **The floor is the figure that moves most**, and it
    // is the one the 亦た census moved: the deal before the ledger leaves pages
    // of 144 and 98 cells on two of the three, where it used to leave 19 and 23.
    expect(spread(fullness(after.chapter.pages))).toEqual({ min: 131, p5: 161, median: 164, max: 169, mean: 163.6 });
    expect(spread(fullness(after.none.pages))).toMatchObject({ min: 17, median: 205, mean: 194.6 });
    expect(spread(fullness(after.shuchu.pages))).toMatchObject({ min: 144, median: 181, mean: 180 });
    expect(spread(fullness(before.chapter.pages)).min).toBe(144);
    expect(spread(fullness(before.shuchu.pages)).min).toBe(98);
    // And the sheets. The ledger costs a few on each, and the bound is the
    // reader's own: the 9.9% he agreed to for the flush cut. The worst of the
    // three now sits at 8.1%, where it used to sit at 2.6% — see the note at
    // the head of this describe for why every figure in it moved together.
    expect(after.chapter.pages.length).toBe(44);
    expect(after.none.pages.length).toBe(37);
    expect(after.shuchu.pages.length).toBe(40);
    for (const name of shapeNames) {
      expect(after[name].pages.length / before[name].pages.length).toBeLessThan(1.099);
    }
  });

  it("keeps the two panels writing the same tokens at every cut it now makes", () => {
    // **The invariant that does not move.** The ledger cuts in two places the
    // deal never cut before — between two sentences on a page, and back inside
    // a sentence the page had already finished — so it is checked at the cut
    // sites rather than trusted. The rescale does not touch it: a cut is still
    // a `pairedCuts` boundary whatever size the characters are set at.
    for (const name of shapeNames) {
      const document = shapes[name];
      const dealt = document.map(dealtPieces);
      const shared = document.map((sentence) => {
        const above = new Set(sentence.kundoku.flatMap((child) => child.ids));
        return new Set(sentence.prose.flatMap((child) => child.ids).filter((id) => above.has(id)));
      });
      const above = new Set<string>();
      const below = new Set<string>();
      let pages = 0;
      for (const page of after[name].pages) {
        for (const entry of page.entries!) {
          const piece = dealt[entry.at][entry.piece];
          for (const child of piece.kundoku) {
            for (const id of child.ids) if (shared[entry.at].has(id)) above.add(`${entry.at}:${id}`);
          }
          for (const child of piece.prose) {
            for (const id of child.ids) if (shared[entry.at].has(id)) below.add(`${entry.at}:${id}`);
          }
        }
        expect([...above].sort()).toEqual([...below].sort());
        pages += 1;
      }
      expect(pages).toBeGreaterThan(30);
    }
  });
});

// ---------------------------------------------------------------------------
// The paired cut relaxed — measured at the print scale, and its case has gone.
//
// The reader: "We only need sentence beginnings to match within each page."
//
// ── What the weaker invariant permits, from the geometry ─────────────────
// A page break may fall at **different token positions in the two bands**,
// provided both stand in the same sentence — so the sentences that *begin* on a
// page are the same set in both. **It needs no padding**: neither band may
// start sentence S+1 until both have finished S, so the offset between them is
// bounded by one sentence and returns to nil at every sentence end. Positional
// alignment was never a property of this layout and is not needed.
//
// ── Why it is not shipped, and why the answer keeps moving ───────────────
// Its case has now turned three times, and every turn was a fact about the
// *geometry* rather than about the freedom: at the screen scale the prose band
// had slack the kundoku band did not, and letting each stop where it liked
// spent that slack — four sheets in thirty-seven. **At 33/60 the two bands are
// matched much more closely** (10 cells to a kundoku column against a prose
// column of 10, where it was 5 against 6), so there is no slack left to spend,
// and all the freedom buys is a looser cut that leaves near-empty pages: the
// fullness floor falls from 131 cells to 14 and from 80 to 4.
//
// So it is declined on its own numbers rather than on a rule, and this block is
// the record of them.
// ---------------------------------------------------------------------------

describe("the paired cut relaxed", () => {
  const shapes = {
    chapter: dealtDocument(800, "chapter"),
    none: dealtDocument(800, "none"),
    shuchu: dealtDocument(800, 217),
  };
  const names = ["chapter", "none", "shuchu"] as const;
  const ledger = {
    chapter: dealWithLedger(shapes.chapter, true),
    none: dealWithLedger(shapes.none, true),
    shuchu: dealWithLedger(shapes.shuchu, true),
  };
  const free = {
    chapter: dealFreely(shapes.chapter, true, true),
    none: dealFreely(shapes.none, true, true),
    shuchu: dealFreely(shapes.shuchu, true, true),
  };
  const asPages = (pages: readonly { prose: DealChild[]; kundoku: DealChild[] }[]) =>
    pages.map((page) => ({ prose: page.prose, kundoku: page.kundoku, closedBy: "rule" as const }));
  const floor = (pages: readonly { kundoku: DealChild[] }[]) =>
    Math.min(...pages.map((page) => page.kundoku.reduce((a, child) => a + child.cells, 0)));

  it("keeps the sentences that begin on a page the same in both bands", () => {
    // **The weaker invariant, stated and checked.** Not that the two bands hold
    // the same tokens — they deliberately do not — but that neither has begun a
    // sentence the other has not. It holds on every page of every shape, which
    // is what makes the drift heal at each sentence end rather than accumulate,
    // and it holds at this scale as it did at the last: it is a fact about
    // sentences, and the type scale has no opinion about those.
    for (const name of names) {
      expect(free[name].pages.every((page) => page.kSentence === page.pSentence)).toBe(true);
      expect(free[name].pages.length).toBeGreaterThan(30);
    }
  });

  it("buys nothing at this scale, the two bands no longer having slack to spend", () => {
    // 學而 comes out identical — same sheets, same flush count, same faults,
    // same floor, the same twenty wrapped 章. There is nothing for the freedom
    // to do.
    expect(free.chapter.pages.length).toBe(ledger.chapter.pages.length);
    expect(floor(free.chapter.pages)).toBe(floor(ledger.chapter.pages));
    expect(faultsOn(asPages(free.chapter.pages))).toMatchObject({ widows: 37, orphans: 25 });
    expect(faultsOn(asPages(ledger.chapter.pages))).toMatchObject({ widows: 37, orphans: 25 });
  });

  it("costs the two long-block texts the floor it used to raise", () => {
    // The reversal, in the one figure that shows it. At the screen scale this
    // took 酒蟲's shape from 37 sheets to 34 and its floor from 29 cells to 47;
    // here it saves a sheet and takes the floor from 144 to 14 — a final sheet
    // of fourteen kanbun characters. On the text with no source break at all
    // the sheets are level and the floor falls from 17 to 14.
    expect(ledger.shuchu.pages.length).toBe(40);
    expect(free.shuchu.pages.length).toBe(39);
    expect(floor(ledger.shuchu.pages)).toBe(144);
    expect(floor(free.shuchu.pages)).toBe(14);
    expect(faultsOn(asPages(free.shuchu.pages)).widows).toBe(0);
    expect(faultsOn(asPages(ledger.shuchu.pages)).widows).toBe(0);
    expect(free.shuchu.fellBack).toBe(1);
    expect(ledger.shuchu.fellBack).toBe(0);
    expect(ledger.none.pages.length).toBe(free.none.pages.length);
    expect(floor(ledger.none.pages)).toBe(17);
    expect(floor(free.none.pages)).toBe(14);
  });
});
