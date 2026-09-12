import { describe, expect, it } from "vitest";
import {
  DEPREL_INVENTORY,
  type DeprelMenuRow,
  type DeprelSegment,
  MENU_HEADINGS,
  deprelMenuRows,
} from "../src/render/tokenInspector.ts";

/** The along-the-run box of every piece of a relation row, as kunten.css sets
 * it — and the reason there is a model here at all.
 *
 * The relation menu is `writing-mode: vertical-rl`, so the *inline* axis runs
 * down the column and "the vertical padding of a menu item" is the padding at
 * the two ends of its run: physically `padding-top` and `padding-bottom`, and
 * what a reader sees of it is the air the hover highlight puts above and below
 * an entry's characters. A row is a flex box of pieces that tile it end to end
 * (`.token-menu-row`, where the flicker that property was bought with is
 * written up), so how much padding a piece has is not a fact about that piece
 * alone — it depends on what class it carries and on what stands beside it.
 *
 * There is no browser in this suite and no layout in it, so this cannot be
 * measured here. What it can be is *modelled*, over the whole inventory rather
 * than over the three rows anyone thought to look at — which is this file's
 * standing discipline, and the only kind of check that catches a property of
 * every composite row and of no simple one.
 *
 * The model is calibrated against the only real measurements there are: three
 * rows read off the open menu at 161.18 / 121.18 / 201.18 (see `openRetagMenu`
 * in tokenInspector.ts). `measuredExtent` below reproduces all three, which is
 * what licenses the arithmetic to speak about the states that have not been
 * measured — the segment padding that was restored a round ago, and the grid
 * this round sets the whole menu on.
 *
 * ── What the menu is now, in one paragraph ────────────────────────────────
 * A cell is one character's advance, `EM` below. Every piece of a row is a
 * whole number of cells or costs the row nothing, and every character in the
 * menu stands at `二分 + n cells` from the top of its column: a word takes 二分
 * at each end (which is what the hover highlight fills), a bracket takes 二分
 * of ink and 二分 of aki, and the 中黒 takes 二分 of ink out of the 四分 each
 * of the two words beside it gives up — so a ・ lengthens nothing, exactly as
 * a mark of punctuation in the text panel takes no cell of its own (rule 2 at
 * the head of kunten.css). */
const EM = 20; // 1.25rem — `.token-context-menu`'s own font size, and the cell
const PAD = EM / 2; // 二分 — the along-the-run padding of a menu entry
const QUARTER = EM / 4; // 四分 — what a word gives up on the side a 中黒 is on
const AKI = EM / 2; // 二分 — the space paired with a bracket's ink
const HALF = EM / 2; // a mark's cell, set half-width through `vhal`

/** The figures as they stood when the three rows were measured: an entry's
 * padding was 0.35rem, and only the row's two ends carried any. */
const OLD_PAD = 5.6;

const OPEN = "〖";
const CLOSE = "〗";

const isBracket = (segment: DeprelSegment) => segment.text === OPEN || segment.text === CLOSE;
/** The 中黒, and anything else a row picks up that is neither a bracket nor a
 * word — which is exactly what the stylesheet's own selector says
 * (`.token-menu-punct:not(.subtype-bracket-open, .subtype-bracket-close)`). */
const isSeparator = (segment: DeprelSegment | undefined) =>
  segment !== undefined && segment.kind === "punct" && !isBracket(segment);

/** The ink one piece of a row occupies, marks counted at 二分. */
function ink(segment: DeprelSegment): number {
  return segment.kind === "punct" ? HALF : EM * [...segment.text].length;
}

/** The white one piece of a row carries before and after its own ink.
 *
 * Both brackets rebalance a fraction of an em between their two sides to
 * recentre the ink (`.subtype-bracket-open`, `.subtype-bracket-close`); a
 * rebalance moves the glyph and never the box, which is the whole reason it is
 * padding and not a margin or a relative offset, so the model works with the
 * sums and the fractions cancel. The 中黒 needs no such correction: measured
 * in the shipped subset, `vhal` moves it to the exact centre of the halved
 * cell. */
function padding(row: DeprelMenuRow, index: number): [before: number, after: number] {
  const segment = row.segments[index];
  if (segment.kind === "punct") {
    // A bracket pairs its ink with a 二分 of aki on the side that faces the
    // words: before an opening one, after a closing one. A 中黒 gets none —
    // its cell is made up out of its neighbours' padding instead.
    if (segment.text === OPEN) return [AKI, 0];
    if (segment.text === CLOSE) return [0, AKI];
    return [0, 0];
  }
  return [
    isSeparator(row.segments[index - 1]) ? QUARTER : PAD,
    isSeparator(row.segments[index + 1]) ? QUARTER : PAD,
  ];
}

/** Where every character of a row falls, measured down the run from the row's
 * own start — which, the gap between two atoms being 0, is where the previous
 * row's last character sat plus one cell. A mark is not a character and is not
 * listed: it stands in the gap between two words, as rule 2 has it. */
function characterOffsets(row: DeprelMenuRow): number[] {
  const offsets: number[] = [];
  let at = 0;
  row.segments.forEach((segment, index) => {
    const [before, after] = padding(row, index);
    at += before;
    if (segment.kind === "punct") at += HALF;
    else
      for (const _character of [...segment.text]) {
        offsets.push(at);
        at += EM;
      }
    at += after;
  });
  return offsets;
}

const extent = (row: DeprelMenuRow) =>
  row.segments.reduce((total, segment, index) => {
    const [before, after] = padding(row, index);
    return total + before + ink(segment) + after;
  }, 0);

/** The row exactly as it stood on the page when the three figures below were
 * read off it: the row's own 0.35rem at each of its two ends and nowhere else,
 * the 二分 before an opening bracket, and full-width ・. Kept because it is the
 * only tie this file has between its arithmetic and a real layout. */
function measuredExtent(row: DeprelMenuRow): number {
  return row.segments.reduce((total, segment, index) => {
    const first = index === 0;
    const last = index === row.segments.length - 1;
    const cell = isBracket(segment) ? HALF : EM * [...segment.text].length;
    return total + (first ? OLD_PAD : 0) + (segment.text === OPEN ? AKI : 0) + cell + (last ? OLD_PAD : 0);
  }, 0);
}

const ROWS = deprelMenuRows(DEPREL_INVENTORY);
const rowText = (row: DeprelMenuRow) => row.segments.map((s) => s.text).join("");
const row = (base: string) => ROWS.find((r) => r.base === base)!;
/** Floating-point sums of tenths; a hundredth of a pixel is the tolerance the
 * measurements themselves were quoted to. */
const near = (value: number) => expect(Math.round(value * 100) / 100);

describe("the model of a row's along-the-run box", () => {
  it("reproduces the three rows that were measured on the open menu", () => {
    // 161.18 / 121.18 / 201.18, read off the page with the 二分 in place, the
    // segments still unpadded and the ・ still full-width. Nothing below is
    // worth anything if this fails: it is the only tie between the arithmetic
    // and a real layout.
    near(measuredExtent(row("comp:obl"))).toBe(161.2);
    near(measuredExtent(row("comp"))).toBe(121.2);
    near(measuredExtent(row("mod"))).toBe(201.2);
    expect([rowText(row("comp:obl")), rowText(row("comp")), rowText(row("mod"))]).toEqual([
      "斜格補語〖場所〗",
      "補語〖形式〗",
      "修飾語〖時間・場所〗",
    ]);
  });

  it("agrees with the closed form the sizing note quotes", () => {
    // `EM · (Σ(len + 1) over the words, plus one cell for each bracket)` — the
    // whole of a row's length, with no term for the ・ and none for how many
    // of the words are pickable. Written out here so that the note in
    // `sizeMenuSquarish` and the stylesheet cannot drift apart silently.
    for (const r of ROWS) {
      const words = r.segments.filter((s) => s.kind !== "punct");
      const brackets = r.segments.filter(isBracket).length;
      const closed = EM * (words.reduce((n, s) => n + [...s.text].length + 1, 0) + brackets);
      near(extent(r)).toBe(Math.round(closed * 100) / 100);
    }
  });
});

describe("the grid the menu is set on", () => {
  it("puts every character of every row a whole number of cells down the run", () => {
    // The request, as a property of the entire inventory. Every character in
    // the menu stands at `二分 + n cells` from the top of its column: within a
    // row by this, and from one row to the next because a row's own extent is
    // a whole number of cells (below) and the gap between two atoms is 0.
    for (const r of ROWS) {
      for (const offset of characterOffsets(r)) {
        expect(offset % EM, `${rowText(r)} @ ${offset}`).toBeCloseTo(PAD, 6);
      }
    }
  });

  it("makes every row a whole number of cells long", () => {
    // Which is what carries the grid across a row boundary: the next atom
    // begins where this one ends, and opens with the same 二分.
    for (const r of ROWS) expect(extent(r) % EM, rowText(r)).toBeCloseTo(0, 6);
  });

  it("lets a 中黒 cost the row nothing", () => {
    // Rule 2 of the text panel, applied to a label: the mark takes no cell of
    // its own and is crammed into the gap. Checked as the property it is —
    // strike the ・ out of a row and the row is exactly as long — rather than
    // as an arithmetic identity, since it is the thing that keeps 場所 in
    // 修飾語〖時間・場所〗 on the same grid as every other character.
    const withoutSeparators = (r: DeprelMenuRow): DeprelMenuRow => ({
      base: r.base,
      segments: r.segments.filter((s) => !isSeparator(s)),
    });
    const dotted = ROWS.filter((r) => r.segments.some(isSeparator));
    // Three of the twenty-three rows have one, and none has two: the check
    // above is not passing on an inventory that has lost its 中黒.
    expect(dotted.map(rowText)).toEqual([
      "修飾語〖時間・場所〗",
      "並列構成要素〖動詞連続・外来語〗",
      "未分類の依存語〖場所・時間〗",
    ]);
    for (const r of dotted) near(extent(r)).toBe(Math.round(extent(withoutSeparators(r)) * 100) / 100);
  });

  it("keeps the pieces of a row tiling it end to end", () => {
    // No gaps and no overlaps: the sum of the pieces is the row. The property
    // the whole section is written to (see `.token-menu-row` in kunten.css,
    // where the flicker it was bought with is written up), restated over the
    // inventory because the grid moved every figure it is made of.
    for (const r of ROWS) {
      const pieces = r.segments.reduce((total, segment, index) => {
        const [before, after] = padding(r, index);
        return total + before + ink(segment) + after;
      }, 0);
      near(pieces).toBe(Math.round(extent(r) * 100) / 100);
      // And every piece is a box of positive extent, so none of them is a
      // strip of the row belonging to nothing.
      r.segments.forEach((segment, index) => {
        const [before, after] = padding(r, index);
        expect(before + ink(segment) + after, `${rowText(r)} / ${segment.text}`).toBeGreaterThan(0);
      });
    }
  });
});

describe("the vertical padding of a relation menu item", () => {
  it("gives every pickable segment air at both ends, and 二分 of it where nothing is beside it", () => {
    // A segment is a thing to point at, and the only way its padding is ever
    // seen is as the highlight that fills it — so a segment padded at one end
    // lights lopsided and one padded at neither lights as a rectangle cut to
    // its glyphs. 四分 rather than 二分 is spent only where a 中黒 stands
    // against that end, and there the mark's own ink fills the rest of the
    // cell, so what the reader sees between the highlight and the next word is
    // the same one cell either way.
    for (const r of ROWS) {
      r.segments.forEach((segment, index) => {
        if (segment.kind !== "relation") return;
        const [before, after] = padding(r, index);
        const floor = (neighbour: DeprelSegment | undefined) => (isSeparator(neighbour) ? QUARTER : PAD);
        expect(before, `${rowText(r)} / ${segment.text}`).toBe(floor(r.segments[index - 1]));
        expect(after, `${rowText(r)} / ${segment.text}`).toBe(floor(r.segments[index + 1]));
      });
    }
  });

  it("opens and closes every row with the same 二分, whatever stands there", () => {
    // Which is what makes two successive entries stand exactly one cell apart
    // — 二分 from each — and so what carries the column's grid across the
    // boundary between them. It holds on a row led by the inert 補語 label and
    // on one ended by a 〗 just as it does on a row of one segment.
    for (const r of ROWS) {
      const last = r.segments.length - 1;
      expect(padding(r, 0)[0], rowText(r)).toBe(PAD);
      expect(padding(r, last)[1], rowText(r)).toBe(PAD);
    }
  });

  it("costs a simple row one 二分 at each end and nothing else", () => {
    // A row of one segment is `EM · (n + 1)`, where it was `20n + 11.2` when
    // the padding was 0.35rem: 8.8px longer, which is the whole of what the
    // grid costs the two menus whose entries are one box apiece.
    for (const r of ROWS) {
      if (r.segments.length > 1) continue;
      near(extent(r)).toBe(EM * ([...rowText(r)].length + 1));
      near(extent(r) - measuredExtent(r)).toBe(Math.round((EM - 2 * OLD_PAD) * 100) / 100);
    }
  });

  it("moves the three measured rows and the longest one to the figures the notes quote", () => {
    near(extent(row("comp:obl"))).toBe(200);
    near(extent(row("comp"))).toBe(160);
    near(extent(row("mod"))).toBe(240);
    // The tallest atom is the floor under every cap `sizeMenuSquarish` writes,
    // so this one row is the single biggest lever on the menu's shape.
    const tallest = ROWS.reduce((a, b) => (extent(a) >= extent(b) ? a : b));
    expect(rowText(tallest)).toBe("並列構成要素〖動詞連続・外来語〗");
    near(measuredExtent(tallest)).toBe(321.2);
    near(extent(tallest)).toBe(360);
  });

  it("comes to the inline extent the sizing arithmetic is quoted against", () => {
    near(ROWS.reduce((n, r) => n + measuredExtent(r), 0)).toBe(3027.6);
    near(ROWS.reduce((n, r) => n + extent(r), 0)).toBe(3500);
    expect(ROWS.length).toBe(23);
  });
});

/** ── The category headings, set as one tracked line ───────────────────────
 *
 * A heading is not a row, so nothing above models it and the model here is a
 * short one. What it shares with a row is the property the whole grid rests
 * on: every character in a column stands on the same pitch, and the entries
 * below a heading have to start where that pitch says.
 *
 * The device is smaller type tracked out to a whole cell a character — the
 * glyph is `g` and the `letter-spacing` after it is `cell - g`, so a label of
 * `n` characters is `n` cells whatever `g` is. That is what makes this
 * arithmetic rather than measurement, and it is also the strong reading of
 * "line up with the grid": with the cartouche's own cell above it, the
 * heading's glyphs are centred on the same multiples of the cell that the
 * entries' glyphs are.
 *
 * ── Why every one of these is walked over a range of glyph sizes ─────────
 * Because the stylesheet's figures were written when the heading was set at
 * exactly half the menu's size, where `2em` of the heading *is* one cell —
 * so `letter-spacing: 1em`, `text-indent: 1em` and an across-run total of
 * `2em` all landed on the grid, and every one of them was a coincidence of
 * that font size rather than an identity. Raising the type would have walked
 * the label off the grid silently. The terms that owe the grid a fixed
 * fraction of a *cell* are written against the cell now (`--menu-cell`), and
 * the ones that should scale with the type are in `em`; these tests are the
 * thing that would catch either being written as the other, so none of them
 * may hold at one size only.
 *
 * The two things a browser would have to confirm are that a CJK character
 * really advances its own font size, and that `letter-spacing` is applied
 * after the last character as well as between. The second is not an
 * assumption: the boxed heading's own measured figures (68.0 for four
 * characters at 0.8rem with 0.04em) only come out if the trailing space
 * counts, and the boxed reckoning below reproduces them. The first is checked
 * here as far as it can be — every heading character must be full-width, or
 * the count is not the run. */
const GLYPH = 0.65 * EM; // `font-size: 0.65em` — the heading's own type, 13px
const RULE = 1; // `border: 1px solid var(--menu-rule)` — the menu's one interior weight
const LANE = 1.5 * EM; // `line-height: 1.5` on the menu — the width a column of entries takes
const GUTTER = EM / 2; // `.token-menu-group`'s `row-gap: 0.5em`, with the 界線 down its middle

/** The figures as the stylesheet writes them, as functions of the cell and the
 * glyph — so that a term written in the wrong one of the two shows up as a
 * dependence on a size it should not have.
 *
 * `TRACK` and `INDENT` are `calc(--menu-cell - 1em)`, cell terms both: the
 * first takes the advance to a cell, the second balances the trailing tracking
 * the last character carries. `SIDE_PAD` is `calc(--menu-cell / 4)`, a cell
 * term too but no longer part of any identity — the across-run total is a
 * bound now, not a construction, and these tests say so. `END_PAD` is the one
 * em term that could be mistaken for a cell term, and is not: it falls out of
 * fixing the extent and the first glyph's centre. */
const TRACK = (cell: number, glyph: number) => cell - glyph;
const INDENT = TRACK;
const SIDE_PAD = (cell: number) => cell / 4;
const END_PAD = (glyph: number) => glyph / 2 - RULE;

/** Every heading character must take a whole em of its own type, or a tracked
 * line's extent is not its character count. The ranges are the full-width
 * blocks the labels are written in: CJK ideographs, kana, and the CJK
 * punctuation that holds the 中黒. */
const FULL_WIDTH = /^[　-〿぀-ヿ㐀-䶿一-鿿＀-｠]+$/u;

const chars = (heading: string) => [...heading].length;
/** A heading's extent down the run: the cartouche's cell and the label's. */
const headingExtent = (heading: string) => EM * (chars(heading) + 1);
/** Where the glyph at index `j` has its centre, measured from the top of the
 * heading — which is the top of its column, a heading being the first thing
 * in one. */
const glyphCentre = (j: number, cell = EM, glyph = GLYPH) =>
  RULE + END_PAD(glyph) + INDENT(cell, glyph) + cell * j + glyph / 2;

/** Cell and glyph pairs to walk every identity over. The first is the page as
 * it stands; the rest move the type size within its bounds and the root size
 * under it, since neither may be what makes an identity true. */
const SCALES: [cell: number, glyph: number][] = [
  [20, 12],
  [20, 10],
  [20, 11],
  [20, 13],
  [20, 14],
  [17.5, 10.5],
  [24, 14.4],
  [32, 19.2],
];

/** The relation menu's seven, in menu order, which is what `sizeMenuSquarish`'s
 * arithmetic is quoted against.
 *
 * Five until the relations were re-filed under 『体系漢文』's 成分
 * (`DEPREL_GROUPS` in tokenInspector.ts, where the handbook and the filing are
 * argued): the group holding the compounds and the coordinators split in two,
 * and the first two headings took the handbook's own names. Six until ROOT
 * was pulled out of 基本成分 into a singleton category of its own, first —
 * 述語, the handbook's own word for the one relation that lives there. Every
 * figure in this block moved with each change, and each is recomputed below
 * rather than re-measured — there is nothing here that a page decides. */
const RELATION_HEADINGS = ["述語", "基本成分", "修飾成分", "接続・並列", "談話・その他", "複合語", "未分類"];

describe("a heading's characters stand on the column's own grid", () => {
  it("advances each of them one whole cell, at every glyph size", () => {
    // The identity the tracking exists for, and the first place an em term
    // written where a cell term belongs would show: `letter-spacing: 1em` is
    // right at one glyph size only.
    for (const [cell, glyph] of SCALES) {
      expect(glyph + TRACK(cell, glyph), `${cell}/${glyph}`).toBeCloseTo(cell, 9);
    }
  });

  it("centres every one of them on a multiple of the cell, at every glyph size", () => {
    // The claim the tracking is for. Glyph `j` is centred `(j + 1)` cells from
    // the top of the column, which is exactly where the entries' own glyphs
    // are centred — an entry's character sits at `二分 + n cells` and so is
    // centred a whole cell on from that.
    for (const [cell, glyph] of SCALES) {
      for (let j = 0; j < 8; j++) {
        const where = glyphCentre(j, cell, glyph);
        expect(where, `${cell}/${glyph} glyph ${j}`).toBeCloseTo(cell * (j + 1), 9);
        expect(where % cell, `${cell}/${glyph} glyph ${j}`).toBeCloseTo(0, 9);
      }
    }
  });

  it("would drift off the grid if the tracking were written in em", () => {
    // The coincidence this round removed, stated as the failure it would have
    // been. `letter-spacing: 1em` is one cell only where the glyph is half a
    // cell; at 0.6 it is a fifth of a cell short, and every glyph after the
    // first compounds the error.
    const emTracking = (glyph: number) => glyph; // what `1em` used to mean here
    // The drift is `2g - c`, so it is nought at half a cell and grows with the
    // glyph from there: 6px an advance at the size set here, and every glyph
    // after the first compounds it.
    for (const [cell, glyph] of SCALES) {
      expect(glyph + emTracking(glyph) - cell, `${cell}/${glyph}`).toBeCloseTo(2 * glyph - cell, 9);
    }
    expect(GLYPH + emTracking(GLYPH)).not.toBeCloseTo(EM, 9);
    expect(GLYPH + emTracking(GLYPH) - EM).toBe(6);
    expect(EM / 2 + emTracking(EM / 2)).toBeCloseTo(EM, 9); // right at half size, and only there
  });

  it("keeps the whole column in one phase, heading and entries alike", () => {
    // Since the heading's extent is a whole number of cells, the first entry
    // starts on a cell line and its own characters go on standing at
    // `二分 + n cells` from there. So every glyph centre in the column, at
    // whatever size, falls on a multiple of the cell from the column's top.
    for (const heading of MENU_HEADINGS) {
      expect(headingExtent(heading) % EM, heading).toBeCloseTo(0, 9);
      const firstEntryGlyphCentre = headingExtent(heading) + PAD + EM / 2;
      expect(firstEntryGlyphCentre % EM, heading).toBeCloseTo(0, 9);
    }
  });

  it("is written in characters that take a whole em", () => {
    // The assumption the count rests on, checked over the inventory rather
    // than assumed: a label is a string someone may edit, and a half-width
    // character in one would put its column off the grid with nothing left to
    // catch it.
    for (const heading of MENU_HEADINGS) expect(heading, heading).toMatch(FULL_WIDTH);
  });

  it("needs no parity, at any length", () => {
    // What died with the 割注. A half-cell advance made a heading `n` half
    // cells, so odd and even labels landed differently and one of them had to
    // be given a 二分 to bring it back; a whole-cell advance makes every
    // length land the same way. There is nothing here for `data-half-cell`,
    // `headingNeedsHalfCell` or `splitHeading` to do, which is why all three
    // are gone.
    for (let n = 1; n <= 12; n++) expect((EM * (n + 1)) % EM, `${n}`).toBe(0);
  });
});

describe("the cartouche", () => {
  it("stays inside the lane at every glyph size, which is the only rule across the run", () => {
    // The across-run total is a **bound**, not an identity. It used to be one
    // — two rules, half a tracking each side, and the glyph came to exactly a
    // cell — and that identity was also a ceiling, since the only way to give
    // the label more air was to shrink the glyph. The padding is asked for
    // directly now, so what is left to check is the thing that actually
    // governs: the frame must fit the lane, or it becomes the widest atom and
    // moves `w`.
    for (const [cell, glyph] of SCALES) {
      const across = 2 * RULE + 2 * SIDE_PAD(cell) + glyph;
      expect(across, `${cell}/${glyph}`).toBeLessThanOrEqual(1.5 * cell);
      // And narrower than the entry beside it, which is what keeps `w` at the
      // entry's own lane.
      expect(across, `${cell}/${glyph}`).toBeLessThan(1.5 * cell + 1e-9);
    }
    // The old identity is gone and must not come back by accident.
    const across = 2 * RULE + 2 * SIDE_PAD(EM) + GLYPH;
    expect(across).toBe(25);
    expect(across).not.toBe(EM);
  });

  it("spends half the width the lane had spare, and leaves the rest", () => {
    // 25px in a 30px lane: 2.5px of clear on each side, and 7.5px out to the
    // 界線, which stands at the middle of the 10px gutter beyond. There were
    // 10px of width available in total and this takes five of them.
    const across = 2 * RULE + 2 * SIDE_PAD(EM) + GLYPH;
    const clear = (LANE - across) / 2;
    expect(clear).toBe(2.5);
    expect(clear + GUTTER / 2).toBe(7.5); // out to the 界線
    // The padding beside the glyph is what the request was for: 5px where it
    // was 3.
    expect(SIDE_PAD(EM)).toBe(5);
    // And the ceiling, which is the lane and not the gutter: past this the
    // pitch moves and every column in the menu gets wider.
    expect(LANE - across).toBe(5); // width still available
    expect(2 * RULE + 2 * SIDE_PAD(EM) + (EM - 2 * RULE)).toBeLessThanOrEqual(LANE);
  });

  it("bounds the glyph by the lane, far above where the tracking gives out", () => {
    // Rearranged, the bound is `g ≤ c - 2px`, which at the default cell is
    // 18px — nowhere near binding, since a glyph that big would leave 2px of
    // tracking and the 疎組み would have stopped reading long before. The
    // point is that the lane no longer bounds the *type*; it bounds the frame.
    for (const [cell] of SCALES) {
      const widest = 1.5 * cell - 2 * RULE - 2 * SIDE_PAD(cell);
      expect(widest, `${cell}`).toBeCloseTo(cell - 2 * RULE, 9);
    }
    expect(EM - 2 * RULE).toBe(18);
    expect(GLYPH).toBeLessThan(EM - 2 * RULE);
  });

  it("comes to one cell along the run, at every glyph size", () => {
    // The 割注's identity — 二分 of frame plus the label — at the new scale
    // and now independent of it. The indent is what pays for it: inside the
    // box and outside the label, so a whole cell of frame comes out of only
    // half a glyph of padding at each end.
    for (const [cell, glyph] of SCALES) {
      const frame = 2 * RULE + 2 * END_PAD(glyph) + INDENT(cell, glyph);
      expect(frame, `${cell}/${glyph}`).toBeCloseTo(cell, 9);
      expect(frame + 5 * cell, `${cell}/${glyph}`).toBeCloseTo(cell * 6, 9);
    }
  });

  it("holds the same air at both ends of the label", () => {
    // Read from the top: rule, air, indent. Read from the foot: the last
    // character's own trailing tracking, then the same air and rule. Two
    // different mechanisms arriving at the same `cell - glyph/2`, so the frame
    // is symmetric about the label without either end being written twice.
    for (const [cell, glyph] of SCALES) {
      const above = RULE + END_PAD(glyph) + INDENT(cell, glyph);
      const below = TRACK(cell, glyph) + END_PAD(glyph) + RULE;
      expect(above, `${cell}/${glyph}`).toBeCloseTo(cell - glyph / 2, 9);
      expect(below, `${cell}/${glyph}`).toBeCloseTo(above, 9);
    }
    expect(EM - GLYPH / 2).toBe(13.5);
  });

  it("puts its top rule where every other column's first cell begins", () => {
    // The heading is the first thing in its column and takes no margin, so the
    // frame opens at the column's own top.
    expect(glyphCentre(0) - (RULE + END_PAD(GLYPH) + INDENT(EM, GLYPH) + GLYPH / 2)).toBe(0);
  });

  it("is bounded by the tracking and the hierarchy, the hug having stopped binding", () => {
    // Three bounds became two. The hug — the air between glyph and rule —
    // used to be spent by a larger glyph, because the frame was pinned to one
    // cell; it is `--menu-cell / 4` now, asked for and given, so the glyph and
    // the frame no longer draw on one budget.
    expect(SIDE_PAD(EM)).toBe(5); // the same whatever the glyph is
    expect(SIDE_PAD(EM)).toBeGreaterThan(3); // and more than the pinned frame allowed

    // The tracking is the near bound: it has to go on reading as 疎組み.
    expect(TRACK(EM, GLYPH) / GLYPH).toBeCloseTo(7 / 13, 9); // 0.54 of a glyph
    expect(TRACK(EM, GLYPH) / GLYPH).toBeGreaterThan(0.5);
    expect(TRACK(EM, 0.7 * EM) / (0.7 * EM)).toBeLessThan(0.5); // where it gives out
    expect(TRACK(EM, 0.8 * EM) / (0.8 * EM)).toBeLessThan(0.3);

    // And the heading has to stay subordinate to a full-cell entry.
    expect(GLYPH).toBeLessThan(EM);
    expect(GLYPH / EM).toBe(0.65);
    expect(GLYPH / EM).toBeLessThan(0.7);
  });
});

describe("what a tracked heading costs", () => {
  it("makes every heading one cell longer than its label", () => {
    expect(RELATION_HEADINGS.map(headingExtent)).toEqual([60, 100, 100, 120, 140, 80, 80]);
  });

  it("takes the relation menu's headings from 240px of L to 620, then 680 with 述語", () => {
    // The figure `sizeMenuSquarish` is quoted against, and the price of the
    // glyphs standing where the entries' glyphs stand. A 割注 heading was 二分
    // times its longer line; this is a cell times the whole label.
    //
    // 180 → 240 and 500 → 620 with the six-category filing. The 割注 column
    // moved by one heading's worth exactly (every one of the six comes to 40
    // under that formula, short labels and long alike, which is the halving at
    // work); the tracked column moved by 120, which is the new heading's 80
    // plus the 40 that 修飾 → 修飾成分 costs.
    //
    // 620 → 680 tracked, and 240 → 260 割注-style, with ROOT's own 述語 added
    // at the front. Two characters rather than the others' three to six is
    // what keeps its own cost the smallest of the seven either way: 60 tracked
    // against 80-140, and 20 割注-style against every other heading's 40 — the
    // one heading short enough that the parity trick 割注 used to equalise odd
    // and even lengths does not reach far enough to lift it into the same
    // bracket as the rest (see `warichu` below: `ceil(2/2)` is 1, which is
    // odd, so 述語 gets none of the bonus half-cell every four-to-six
    // character heading here happens to land on).
    near(RELATION_HEADINGS.reduce((n, h) => n + headingExtent(h), 0)).toBe(680);
    const warichu = (h: string) => EM / 2 + (EM / 2) * Math.ceil(chars(h) / 2) +
      (Math.ceil(chars(h) / 2) % 2 === 0 ? EM / 2 : 0);
    expect(warichu("述語")).toBe(20);
    near(RELATION_HEADINGS.reduce((n, h) => n + warichu(h), 0)).toBe(260);
  });

  it("still comes in under what the boxed headings cost", () => {
    // The calibration, and the long view: today's seven labels cost 540px of
    // `L` if they were boxed the way the originals were, against the 680 they
    // cost tracked. The gap is what the grid is bought with — a boxed
    // heading's extent is its ink rounded up to a cell, a tracked one is a
    // whole cell per character whether the character needs it or not — and it
    // is worth having the two side by side, because the tracked figure on its
    // own reads as expensive without saying what the alternative would have
    // been.
    //
    // It was 400 against 500 at five headings, then 480 against 620 at six.
    // Both moved by one heading's worth again with 述語: 60 boxed (two
    // characters lands in the same rounded-up bucket as three, 12.8·1.04·2 +
    // 14.8 = 41.4, ceil to the next cell), 60 tracked.
    const boxed = RELATION_HEADINGS.map((h) => {
      const extent = 12.8 * 1.04 * chars(h) + 2 * (6.4 + 1);
      return Math.ceil(extent / EM) * EM;
    });
    expect(boxed).toEqual([60, 80, 80, 100, 100, 60, 60]);
    near(boxed.reduce((n, x) => n + x, 0)).toBe(540);
  });

  it("takes the two other menus with it", () => {
    // 虚字 and 雑字 stand from the last round's rewording; 述語・項 and 未分類
    // are the two that were reverted, being a cell cheaper apiece. 述語・項 is
    // itself history now — 基本成分, at the same four characters and so the
    // same five cells, is what it became (ROOT's own later promotion to a
    // singleton "述語" group did not touch 基本成分's own name, only what it
    // holds) — and the pair is left here as the record of what the rewording
    // cost, which is what this line is for.
    expect(["体言", "用言", "虚字", "雑字"].map(headingExtent)).toEqual([60, 60, 60, 60]);
    expect(["機能語", "その他"].map(headingExtent)).toEqual([80, 80]);
    expect(["再読", "音読み", "訓読み", "既定"].map(headingExtent)).toEqual([60, 80, 80, 60]);
    expect(["述語とその項", "分類不明"].map(headingExtent)).toEqual([140, 100]);
  });
});

/** ── The menu's own margins ───────────────────────────────────────────────
 *
 * The band between the frame and the table — `padding` on `.token-context-menu`,
 * 天地 and 左右 — halved on instruction from 0.85rem/0.75rem to
 * 0.425rem/0.375rem.
 *
 * It is the one white in this menu that is a margin. The others are grid
 * quantities and are not halved: the atoms' 二分 of self-padding (`PAD`), the
 * category gutter (`GUTTER`, which carries the 界線) and the cartouche's own
 * padding. Nothing above this point in this file changes by a pixel, and that
 * is the property these check — from the other side, by showing that the
 * figure the margin *does* enter is one the grid never reads. */
const MARGIN_ALONG = 0.425 * 16; // `padding-top`/`bottom`, 6.8px — was 13.6
const MARGIN_ACROSS = EM / 4; // `padding-left`/`right`, 四分 — halved to 6px, then snapped
const FRAME = 1; // `border: 1px solid var(--color-border)` on the menu itself

/** `inlineBoxExtra` in tokenInspector.ts, and its across-the-block-axis twin:
 * what the border box carries over the content it holds. */
const boxExtra = (margin: number) => 2 * margin + 2 * FRAME;

describe("halving the menu's margins", () => {
  it("takes 14px off the width and 13.6px off the height, and nothing else", () => {
    expect(boxExtra(MARGIN_ACROSS)).toBe(12);
    expect(boxExtra(MARGIN_ALONG)).toBeCloseTo(15.6, 9);
    // 12px of it from the halving, 2px more from snapping 6px to 四分 — which
    // is the same quantity the cartouche keeps inside its own long rules.
    expect(boxExtra(0.75 * 16) - boxExtra(MARGIN_ACROSS)).toBe(14);
    expect(MARGIN_ACROSS).toBe(SIDE_PAD(EM));
    expect(boxExtra(2 * MARGIN_ALONG) - boxExtra(MARGIN_ALONG)).toBeCloseTo(13.6, 9);
  });

  it("leaves every grid quantity alone", () => {
    // The margin is outside the content box and every one of these is inside
    // it, so halving one cannot reach the others. Stated as the identities
    // they are, so that halving a grid figure by mistake would land here.
    expect(PAD).toBe(EM / 2); // 二分 of self-padding on an atom
    expect(GUTTER).toBe(EM / 2); // 二分 of gutter, with the 界線 down it
    expect(SIDE_PAD(EM)).toBe(EM / 4); // 四分 inside each of the cartouche's long rules
    expect(LANE).toBe(1.5 * EM);
  });

  it("moves the squaring loop by under a pixel, so no column moves", () => {
    // The margin is part of the box and no part of `L`, so the first guess is
    // untouched; what it can reach is the corrective pass, which squares the
    // *border* box. Both boxes are past the loop's 5% test, so it runs once
    // either way, and it lands within a third of a pixel of the same cap.
    const L = 4000;
    const CONTENT_WIDTH = 11 * LANE + 10 * GUTTER; // 11 columns at the menu's pitch
    const FIRST_GUESS = (100 + Math.sqrt(100 ** 2 + 4 * L * 40)) / 2;
    const pass = (across: number, along: number) => {
      const box = { w: CONTENT_WIDTH + across, h: FIRST_GUESS + along };
      const offSquare = Math.abs(box.w - box.h) / Math.max(box.w, box.h);
      return { offSquare, cap: (box.h - along) * Math.sqrt(box.w / box.h) };
    };
    const before = pass(boxExtra(0.75 * 16), boxExtra(2 * MARGIN_ALONG));
    const after = pass(boxExtra(MARGIN_ACROSS), boxExtra(MARGIN_ALONG));

    expect(CONTENT_WIDTH).toBe(430);
    expect(FIRST_GUESS).toBeCloseTo(453.1, 1); // the same either way — no margin in `L`
    expect(before.offSquare).toBeGreaterThan(0.05); // the loop runs …
    expect(after.offSquare).toBeGreaterThan(0.05); // … in both cases
    // The snap takes it a little further from square, the box having been
    // taller than wide already — but nowhere near enough to matter.
    expect(after.offSquare).toBeGreaterThan(before.offSquare);
    expect(Math.abs(after.cap - before.cap)).toBeLessThan(1);
    expect(after.cap).toBeCloseTo(440.0, 1);
    // Which is what settles the column count: unchanged to two decimals, and
    // as near a twelfth column as it was before.
    expect(L / after.cap + 5 / 2).toBeCloseTo(L / before.cap + 5 / 2, 1);
    expect(L / after.cap + 5 / 2).toBeCloseTo(11.59, 2);
  });

  it("loosens the viewport clamp rather than tightening it", () => {
    // `extra` is subtracted from the ceiling, so less of it means more room;
    // and the floor is the tallest atom, which knows nothing about padding.
    const ceiling = (along: number) => 792 * 0.88 - boxExtra(along);
    expect(ceiling(MARGIN_ALONG)).toBeGreaterThan(ceiling(2 * MARGIN_ALONG));
    expect(ceiling(MARGIN_ALONG) - ceiling(2 * MARGIN_ALONG)).toBeCloseTo(13.6, 9);
    expect(441).toBeLessThan(ceiling(MARGIN_ALONG)); // neither bound is near binding
    expect(360).toBeLessThan(441); // the tallest atom, unmoved
  });
});

/** ── One margin, four menus ───────────────────────────────────────────────
 *
 * The reader: *"Make the margins of the POS/semantic menus exactly the same as
 * for the deprel menu."* All four retag menus are `.token-context-menu` and
 * carry one `padding`, so the answer had to be found by working the four edges
 * out rather than by reading the declaration — a margin is not the white it
 * produces, and what a reader sees at an edge is the figure *plus* whatever
 * the piece standing there carries of its own. What the working came to, and
 * what is pinned below, is that **the two menus are equal at every one of the
 * four edges**, and that the two quantities which are not equal are not the
 * margin.
 *
 * The two, recorded here because they are what a reader may be looking at:
 *
 *   **0.86px of box, 0.30px of ink**, at the foot of a column that ends on a
 *     bracketed relation row. `.token-menu-punct.subtype-bracket-close` takes
 *     `padding-bottom: calc(0.5em - 0.043em)` — the 〗's recentring, which is
 *     paid for out of its own trailing 二分 rather than out of a margin or an
 *     offset (see the note at `.subtype-bracket-open` in kunten.css, where
 *     `position: relative` is tried and rejected for punching a dead strip in
 *     the row's hit map). The box is still exactly one cell, so nothing about
 *     the wrap, the cap or the menu's own height can see it; what moves is
 *     where the ink sits inside that cell, and the bracket's foot ends up
 *     10.62px from the box's end against a kanji's 10.92px. It exists only in
 *     the relation menu, since a category entry has no bracket, and it cannot
 *     be given to the category menus without inventing one.
 *
 *   **2–3px of transparent slack** below the tallest column, from the
 *     `Math.ceil(...) + 2` tolerance in `shrinkMenuToContent` and
 *     `avoidWidowColumns` (tokenInspector.ts). It is the same code for all
 *     four menus and is not a difference between them — but it is
 *     inventory-dependent, so it can differ between the 品詞 menu and a sense
 *     menu quite as easily as between a category menu and the relation menu,
 *     and it is the largest number anywhere near this complaint. It is left
 *     alone deliberately: the +2 is what stops a re-cap tipping one entry into
 *     a fresh column (measured, at `shrinkMenuToContent`), and taking it out
 *     of the cap without a browser to re-wrap in is exactly the kind of guess
 *     at unverifiable geometry this apparatus has been broken by before.
 *
 * Nothing here was looked at: there is no browser in this checkout, and every
 * figure is arithmetic against the boxes the stylesheet declares. */
const HEADING_GLYPH = 0.65 * EM; // `.token-menu-heading`'s `font-size: 0.65em`

/** What a reader sees at one edge of the menu: the margin, plus whatever the
 * piece standing at that edge carries of its own. */
const edge = (margin: number, piece: number) => margin + piece;

describe("the four menus take one margin", () => {
  it("opens every column at the same distance from the frame, in both menus", () => {
    // 天, at the head of a column. Two kinds of column head exist and both
    // occur in both menus: one led by its category's cartouche (the first
    // column of every group) and one led by a bare atom.
    //
    // A cartouche leads with its own `margin: calc(0.5em - 1px)`, which is
    // 5.5px at the heading's 13px glyph, and what the eye lines up against is
    // its border rather than its type.
    expect(edge(MARGIN_ALONG, CARTOUCHE_MARGIN(HEADING_GLYPH))).toBeCloseTo(12.3, 9);
    // A bare atom leads with 二分, and it is 二分 whichever menu it is in: a
    // category entry (`.token-menu-item`), a pickable relation segment
    // (`.token-menu-seg`) and the inert 補語 that leads some relation rows
    // (`.token-menu-label`) all declare the same `padding: 0.5em 0`. That
    // third rule exists for exactly this reason — an inert piece at a row's
    // end is padded as a pickable one is, so a row cannot open differently
    // from an entry.
    expect(edge(MARGIN_ALONG, PAD)).toBeCloseTo(16.8, 9);
    // Which is the whole of 天, and it is one pair of figures for both menus.
    // Five groups against one changes which columns are cartouche-led, not
    // what a cartouche-led column opens with.
  });

  it("closes every column at the same distance, but for the bracket's 0.86px", () => {
    // 地. A category menu's last atom is an entry, so its foot is 二分. A
    // relation menu's is a row, whose last piece is either a segment (二分) or
    // a closing 〗, which spends 0.043em of its trailing 二分 on the
    // recentring above.
    const bracketFoot = PAD - 0.043 * EM;
    expect(edge(MARGIN_ALONG, bracketFoot)).toBeCloseTo(16.8 - 0.86, 9);
    expect(edge(MARGIN_ALONG, PAD) - edge(MARGIN_ALONG, bracketFoot)).toBeCloseTo(0.86, 9);
    // And the box it comes out of is untouched, which is why nothing upstream
    // of it can move: the 〗 is a half-width mark plus 0.043em before it and
    // the rest of its 二分 after, and that is one whole cell.
    expect(HALF + 0.043 * EM + bracketFoot).toBeCloseTo(EM, 9);
  });

  it("keeps the same band down each side, whatever the menu holds", () => {
    // 左右. The lane is `line-height: 1.5` on the menu, so it is 1.5 cells for
    // a `.token-menu-item` and 1.5 cells for a `.token-menu-row` alike — the
    // row's across-the-run size being the largest of its children's line
    // boxes, and every one of those is the same line box. Neither carries any
    // padding across the run, so what a glyph sees beside it is the margin
    // plus the half of the lane it does not fill.
    const lanePad = (LANE - EM) / 2;
    expect(lanePad).toBe(5);
    expect(edge(MARGIN_ACROSS, lanePad)).toBe(10);
    // The band cannot be changed by the number of categories either: a
    // category gutter is a column gutter, the menu's `row-gap` and the group's
    // being the same 二分, so a five-group table and a one-group table have
    // the same content width for the same column count.
    expect(GUTTER).toBe(EM / 2);
    const contentWidth = (columns: number) => columns * LANE + (columns - 1) * GUTTER;
    expect(contentWidth(5)).toBe(5 * 40 - 10);
    expect(contentWidth(12)).toBe(12 * 40 - 10);
  });

  it("carries the same box over its content, which is what the cap is derived from", () => {
    // `inlineBoxExtra` reads the padding and the border back off the menu, so
    // one padding means one `extra` for all four — 15.6px along the run, 12px
    // across it. A per-kind margin would have made the height cap, and so the
    // column count, a function of which menu was open.
    expect(boxExtra(MARGIN_ALONG)).toBeCloseTo(15.6, 9);
    expect(boxExtra(MARGIN_ACROSS)).toBe(12);
  });
});

/** ── Matching the vertical white to the horizontal ────────────────────────
 *
 * "Vertical" and "horizontal" are the screen's axes: the menu is
 * `vertical-rl`, so vertical is *along* the run and horizontal is *across*
 * it. What is being compared is the white above and below a thing against the
 * white beside it — 二分 against 四分 in both cases, which is why the two were
 * asked to be evened up.
 *
 * The two answers are different in kind, and that is the point of these. A
 * menu item cannot move its padding at all and had to have its *paint* inset
 * instead; a cartouche can move its frame, and moving it costs nothing. */
const FRAME_RULE = 1; // the cartouche's own `border: 1px solid var(--menu-rule)`
const CARTOUCHE_MARGIN = (glyph: number) => glyph / 2 - FRAME_RULE; // `calc(0.5em - 1px)`

describe("a menu item's along-run padding cannot move", () => {
  it("is pinned by two constraints at once, to an odd multiple of 二分", () => {
    // An entry of `n` characters is `2P + n·c` with the gap between two of
    // them at nought. The extent must be a whole number of cells, and the
    // glyph centres must stay on multiples of the cell. Walked over every
    // candidate at and below a cell, which is the range a *reduction* could
    // come from.
    const extentOk = (P: number) => (2 * P) % EM === 0;
    const phaseOk = (P: number) => (P + EM / 2) % EM === 0;
    const candidates = [0, EM / 4, EM / 2, (3 * EM) / 4, EM];
    expect(candidates.filter((P) => extentOk(P) && phaseOk(P))).toEqual([EM / 2]);
    expect(PAD).toBe(EM / 2); // and that is what the stylesheet has
  });

  it("rules out nought, which the extent alone would have allowed", () => {
    // Worth its own case because it is the near miss. Flush entries still tile
    // the grid — every extent is `n·c` — but they sit half a cell out of phase
    // with the heading above them, and the phase is the whole claim.
    expect((2 * 0) % EM).toBe(0); // extent fine
    expect((0 + EM / 2) % EM).not.toBe(0); // phase wrong, by exactly 二分
    expect((0 + EM / 2) % EM).toBe(EM / 2);
  });

  it("evens the lit pill by insetting the paint instead", () => {
    // The pill is `inset: calc(--menu-cell / 4) 0` on an `::after`, so it
    // leaves 四分 above and below the characters — the same as the lane's own
    // half-leading leaves at the sides, the entry having no across-run padding
    // at all. Paint only: the box is untouched, so every identity above holds.
    const pillInset = EM / 4;
    const airAlong = PAD - pillInset;
    const airAcross = (LANE - EM) / 2; // half-leading, the entry's whole side air
    expect(airAlong).toBe(EM / 4);
    expect(airAcross).toBe(EM / 4);
    expect(airAlong).toBe(airAcross); // which is what was asked for
    // And two adjacent pills are 二分 apart with the rule down the middle,
    // where they used to abut it — so nothing needs hiding on hover any more.
    expect(2 * pillInset).toBe(EM / 2);
    expect(pillInset).toBeGreaterThan(0);
  });
});

describe("a cartouche steps its frame in without moving its label", () => {
  it("keeps the glyph centres and the extent exactly where they were", () => {
    // The frame appears in neither identity: the centre equation fixes only
    // the sum `δ + pad + indent`, and the extent equation then forces the two
    // margins equal. So white moves from inside the frame to outside it, one
    // pixel for one pixel, and nothing on the grid notices.
    for (const [cell, glyph] of SCALES) {
      const total = cell - FRAME_RULE - glyph / 2; // δ + pad + indent, fixed
      const indent = INDENT(cell, glyph);
      for (const delta of [0, 1, CARTOUCHE_MARGIN(glyph)]) {
        const pad = total - delta - indent;
        expect(delta + FRAME_RULE + pad + indent + glyph / 2, `${cell}/${glyph}/${delta}`).toBeCloseTo(cell, 9);
        const extent = 2 * delta + 2 * FRAME_RULE + 2 * pad + indent + 5 * cell;
        expect(extent, `${cell}/${glyph}/${delta}`).toBeCloseTo(6 * cell, 9);
      }
    }
  });

  it("spends the whole padding, leaving the label's own tracking inside", () => {
    // Where it lands: `pad` goes to nought, so what is left between the rule
    // and the first glyph is the `text-indent`, and between the last glyph and
    // the foot rule the trailing letter-spacing — the same `c - g` at each
    // end, arrived at by two different mechanisms.
    const delta = CARTOUCHE_MARGIN(GLYPH);
    const pad = EM - FRAME_RULE - GLYPH / 2 - delta - INDENT(EM, GLYPH);
    expect(delta).toBe(5.5);
    expect(pad).toBe(0);
    const insideHead = pad + INDENT(EM, GLYPH);
    const insideFoot = TRACK(EM, GLYPH) + pad;
    expect(insideHead).toBe(7);
    expect(insideFoot).toBe(insideHead); // symmetric, unaided
  });

  it("closes the gap as far as the tracking allows, and no further", () => {
    // The request was to match the along-run white to the across-run white.
    // 12.5px against 5px has become 7px against 5px. The residue is the
    // label's own letter-spacing, which is inside the frame necessarily —
    // `pad` cannot go below nought, so 7px is the floor.
    const before = (0.5 * GLYPH - FRAME_RULE) + INDENT(EM, GLYPH); // the old pad + indent
    const after = INDENT(EM, GLYPH);
    expect(before).toBe(12.5);
    expect(after).toBe(7);
    expect(after).toBeLessThan(before);
    expect(after - SIDE_PAD(EM)).toBe(2); // the 2px that cannot be spent
    // Closing it would want `c - g = 四分`, i.e. a glyph at 0.75 of a cell —
    // which the tracking bound rules out (it would be a third of a glyph).
    expect(EM - 0.75 * EM).toBe(SIDE_PAD(EM));
    expect((EM - 0.75 * EM) / (0.75 * EM)).toBeLessThan(0.4);
  });
});

/** ── A lit segment beside a 中黒 ──────────────────────────────────────────
 *
 * The mark costs the row nothing — 二分 of ink in a half-width cell, paid for
 * by 四分 off each neighbour — and what it costs instead is the *pill*: the
 * neighbour gave up exactly the 四分 the pill insets by, so the highlight
 * stopped at its own last glyph and was five pixels short at one end.
 *
 * The fix is paint: the pill's inset goes to nought at the reduced end, and
 * the mark is taken to `opacity: 0` while either neighbour is lit. These check
 * the two things a test can reach — that no *layout* answer exists, and that
 * the pill comes out the length of an undotted one — and the browser was used
 * for the rest. Measured live on 修飾語〖時間・場所〗: 時間 hovered lit
 * [425.79, 475.79], fifty pixels, against 主語's fifty; every box in the row
 * identical in all eight states walked; and `elementFromPoint` over the hidden
 * mark still returning the mark. */
const insetAt = (reduced: boolean) => (reduced ? 0 : QUARTER);

describe("no layout answer exists for a lit segment beside a 中黒", () => {
  it("cannot restore the 四分 and stay on the grid, either way", () => {
    // The mark's 二分 is shared between two neighbours and only one is ever
    // hovered, so there is nothing to take the restored 四分 out of. The two
    // available moves miss the grid by a quarter of a cell, in opposite
    // directions.
    const restore = QUARTER; // +5: give the hovered neighbour its padding back
    const deleteMark = restore - HALF; // …and take the mark's box away: −5
    const keepMark = restore; //          …or leave the box where it is: +5
    expect(deleteMark).toBe(-QUARTER);
    expect(keepMark).toBe(QUARTER);
    for (const net of [deleteMark, keepMark]) {
      expect(net, `${net}`).not.toBe(0);
      expect(Math.abs(net) % EM, `${net}`).not.toBe(0);
      expect(Math.abs(net), `${net}`).toBe(QUARTER); // a quarter cell out, either way
    }
  });
});

describe("a lit pill is its ink plus 二分, whatever is beside it", () => {
  it("holds for every pickable segment in the inventory", () => {
    // The single property the whole change comes to. A segment's box is
    // `before + ink + after`; the pill insets 四分 at each end *except* an end
    // whose padding was already reduced by 四分 for a mark, where the two
    // cancel and the pill fills its box. So the pill is always `ink + 二分`,
    // and a reader cannot tell from the lit shape whether there is a mark
    // next door.
    for (const r of ROWS) {
      r.segments.forEach((segment, index) => {
        if (segment.kind === "punct" || segment.kind === "label") return;
        const [before, after] = padding(r, index);
        const box = before + ink(segment) + after;
        const pill = box - insetAt(isSeparator(r.segments[index - 1])) - insetAt(isSeparator(r.segments[index + 1]));
        expect(pill, `${rowText(r)} / ${segment.text}`).toBeCloseTo(ink(segment) + PAD, 6);
      });
    }
  });

  it("gives a dotted segment the same pill as an undotted one of the same length", () => {
    // 時間 and 場所 are two characters each and sit against the mark; 主語 is
    // two characters with nothing beside it. All three light fifty pixels —
    // which is what the browser measured.
    const pillOf = (base: string, text: string) => {
      const r = ROWS.find((x) => rowText(x).startsWith(base))!;
      const index = r.segments.findIndex((s) => s.text === text);
      const [before, after] = padding(r, index);
      return before + ink(r.segments[index]) + after
        - insetAt(isSeparator(r.segments[index - 1])) - insetAt(isSeparator(r.segments[index + 1]));
    };
    expect(pillOf("主語", "主語")).toBe(50);
    expect(pillOf("修飾語〖時間", "時間")).toBe(50);
    expect(pillOf("修飾語〖時間", "場所")).toBe(50);
  });

  it("insets nought at exactly the ends the padding rules reduce", () => {
    // The unreduction is written with the *same* two selectors as the
    // reduction, so the two cannot come apart. Stated here as the identity
    // they share: an end is inset by nought if and only if it was reduced.
    for (const r of ROWS) {
      r.segments.forEach((segment, index) => {
        if (segment.kind !== "relation") return;
        const [before, after] = padding(r, index);
        expect(insetAt(isSeparator(r.segments[index - 1])) === 0, `${segment.text} head`)
          .toBe(Math.abs(before - QUARTER) < 1e-9);
        expect(insetAt(isSeparator(r.segments[index + 1])) === 0, `${segment.text} foot`)
          .toBe(Math.abs(after - QUARTER) < 1e-9);
      });
    }
  });
});

describe("every 中黒 in the inventory is one the selectors reach", () => {
  it("stands between two pickable segments, never at an end or beside an inert piece", () => {
    // The CSS names `.token-menu-seg` on both sides. A mark beside a
    // `.token-menu-label` would get no reduction from the padding rules and no
    // unreduction from these — consistent, but worth knowing it does not
    // happen. Three of the twenty-three rows carry one, and all three are the
    // same shape.
    const dotted = ROWS.filter((r) => r.segments.some(isSeparator));
    expect(dotted.map(rowText)).toEqual([
      "修飾語〖時間・場所〗",
      "並列構成要素〖動詞連続・外来語〗",
      "未分類の依存語〖場所・時間〗",
    ]);
    for (const r of dotted) {
      r.segments.forEach((segment, index) => {
        if (!isSeparator(segment)) return;
        expect(index, rowText(r)).toBeGreaterThan(0);
        expect(index, rowText(r)).toBeLessThan(r.segments.length - 1);
        expect(r.segments[index - 1].kind, rowText(r)).toBe("relation");
        expect(r.segments[index + 1].kind, rowText(r)).toBe("relation");
      });
    }
  });
});
