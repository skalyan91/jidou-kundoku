import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { planClauseColumns, planHangingMarks } from "../src/render/KakikudashiView.ts";
import { parseConllu } from "../src/parse/conlluParser.ts";
import { detectVerse } from "../src/render/rimeAnnotation.ts";
import type { RimeIndex } from "../src/reading/rimeIndex.ts";
import { computeReadingOrder } from "../src/kundoku/reorderEngine.ts";
import { generateKakikudashiPiecesForTree } from "../src/kakikudashi/generator.ts";
import { findCompoundSpans, type JmdictIndex } from "../src/reading/jmdictLookup.ts";
import { createReadingResolver } from "../src/reading/readingResolver.ts";
import type { KanjidicIndex } from "../src/reading/kanjidicLookup.ts";

// ---------------------------------------------------------------------------
// **Where the panel breaks a verse line that will not fit.**
//
// A source line longer than a column has to be broken again by the panel, and
// a break is a cut between clauses there as much as it is at a source line's
// own break (`breakCarriersFor`, generator.ts). `planClauseColumns` prefers a
// coordination or parataxis edge within two characters of where the column was
// going to break, and takes the ordinary break where none is in range —
// preferred, not obligatory.
//
// **It applies to poetry and not to paragraphs**, which is the reader's own
// ruling and is *not* the scope the rule was measured at. On prose it was
// doing visible work — 論語學而's 22 clause-edge breaks became 43 for two
// columns in 115 — and that is now switched off. What is left is the case the
// ruling is about, and the case `linePerColumnSplit` declines to force: a
// verse line at a `.main` too short to give it a column of its own. The numbers
// for both scopes are below, and in `planClauseColumns`' own note, so that
// what was given up is on the record rather than implied.
//
// The gate is `detectVerse` (rimeAnnotation.ts) — the app's one notion of
// verse, the same one that decides whether the rime 割注 is printed — asked
// once per render and left on the column for the fit to read.
// ---------------------------------------------------------------------------

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "public", "data");
const kanjidic = JSON.parse(readFileSync(join(DATA, "kanjidic-index.json"), "utf-8")) as KanjidicIndex;
const jmdict = JSON.parse(readFileSync(join(DATA, "jmdict-index.json"), "utf-8")) as JmdictIndex;
const resolve = createReadingResolver(kanjidic, jmdict);

/** The panel's flow and its clause edges, taken off the pieces exactly as
 * `proseFlow` takes them off the spans the renderer writes from those pieces:
 * one index per character, and the first character of a piece the generator
 * marked `opensClause`. */
function flow(file: string): { text: string; edges: number[] } {
  const tree = parseConllu(readFileSync(join(DATA, "samples", file), "utf-8"));
  const bodies = generateKakikudashiPiecesForTree(
    tree,
    (sentence) => computeReadingOrder(sentence, findCompoundSpans(sentence, { kanjidic, jmdict })),
    resolve,
  );
  let text = "";
  const edges: number[] = [];
  for (const body of bodies) {
    for (const piece of body) {
      if (piece.opensClause) edges.push([...text].length + (piece.kind === "layout" ? 1 : 0));
      text += piece.text + (piece.caseParticle ?? "");
    }
  }
  return { text, edges };
}

/** How many of the breaks the *panel* made, and how many are on a clause. */
function census(text: string, slots: number, edges: readonly number[], reach: number) {
  const characters = [...text];
  const source = new Set<number>();
  for (let at = 0; at < characters.length; at++) if (characters[at] === "\n") source.add(at + 1);
  const plan = reach === 0 ? { columns: planHangingMarks(text, slots).columns, breaks: [], onEdge: 0 } : planClauseColumns(text, slots, edges, reach);
  const opens = new Set(edges);
  let made = 0;
  let onEdge = 0;
  for (let c = 1; c < plan.columns.length; c++) {
    if (source.has(plan.columns[c])) continue;
    made++;
    if (opens.has(plan.columns[c])) onEdge++;
  }
  return { columns: plan.columns.length, made, onEdge, breaks: plan.breaks.length };
}

describe("planClauseColumns, on a made-up line", () => {
  // 15 characters with no break of their own, four to the column, and a clause
  // opening at 5 and at 10. Without the preference the columns fall at 0, 4, 8
  // and 12; with a reach of 1 the second and third move onto the clauses.
  const text = "あいうえおかきくけこさしすせそ";
  const edges = [3, 7];

  it("leaves the columns alone where no clause is in range", () => {
    expect(planClauseColumns(text, 4, [], 2).columns).toEqual(planHangingMarks(text, 4).columns);
    expect(planClauseColumns(text, 4, [], 2).breaks).toEqual([]);
  });

  it("takes a clause edge one character back from the boundary", () => {
    // The columns fall at 0, 4, 8, 12 unaided. One break, at the clause one
    // character back from the first boundary, moves that column onto it — and
    // the boundary after it then lands on the second clause of its own accord,
    // which is the ordinary way a preference of this kind pays twice.
    expect(planHangingMarks(text, 4).columns).toEqual([0, 4, 8, 12]);
    const plan = planClauseColumns(text, 4, edges, 1);
    expect(plan.breaks).toEqual([3]);
    expect(plan.columns).toEqual([0, 3, 7, 11]);
    expect(plan.onEdge).toBe(2);
  });

  it("looks back from a boundary and never forward", () => {
    // A clause one character *past* the boundary is not a candidate: taking it
    // would be asking the column to hold a character more than it has. With a
    // reach of two the clause at 10 is in range of the boundary at 12 and the
    // one at 5 is in range of nothing.
    expect(planClauseColumns(text, 4, [5, 10], 1).breaks).toEqual([]);
    expect(planClauseColumns(text, 4, [5, 10], 2).breaks).toEqual([10]);
  });

  it("declines an edge further back than the reach", () => {
    // The fallback, and the whole of "preferred, not obligatory": the boundary
    // is at 4 and the only clause is at 1, three characters back. Would have
    // caught a rule that took the nearest clause edge whatever it cost — which
    // would have set a column of one character and left three slots blank.
    const plan = planClauseColumns(text, 4, [1], 2);
    expect(plan.breaks).toEqual([]);
    expect(plan.columns).toEqual(planHangingMarks(text, 4).columns);
  });

  it("leaves a boundary that is already on a clause alone", () => {
    const plan = planClauseColumns(text, 4, [4, 8], 2);
    expect(plan.breaks).toEqual([]);
    expect(plan.onEdge).toBe(2);
  });

  it("never breaks across a break the source wrote", () => {
    // The clause at 3 is in range of the boundary the panel would make at 5,
    // but the source's own break stands between them at 2.
    const plan = planClauseColumns("あい\nうえおかきく", 4, [3], 2);
    expect(plan.breaks).toEqual([]);
  });

  it("writes nothing at all where it is asked for a reach it cannot honour", () => {
    for (const reach of [0, -1, 4, 9]) expect(planClauseColumns(text, 4, edges, reach).breaks).toEqual([]);
  });
});

describe("the panel asks for verse and for nothing else", () => {
  // The scoping, at the one place it is decidable without a browser: the
  // detector the panel now gates on. `applyClauseBreaks` does nothing unless
  // `renderKakikudashiView` found a poem, and this is what it found.
  const index = JSON.parse(readFileSync(join(DATA, "rime-index.json"), "utf-8")) as RimeIndex;

  it("finds the poem, and neither of the prose samples", () => {
    expect(detectVerse(parseConllu(readFileSync(join(DATA, "samples", "shunbou.conllu"), "utf-8")), index)).not.toBeNull();
    for (const file of ["rongo-gakuji.conllu", "shuchu.conllu"]) {
      expect(detectVerse(parseConllu(readFileSync(join(DATA, "samples", file), "utf-8")), index)).toBeNull();
    }
  });

  it("is what the prose would have got, had it been asked", () => {
    // The feature that was measured and then scoped away, kept as a number so
    // that the cost of the ruling is on the record. The panel no longer runs
    // this on either text; the planner is pure and still answers.
    const { text, edges } = flow("rongo-gakuji.conllu");
    expect(edges.length).toBe(117);
    expect(census(text, 10, edges, 0)).toMatchObject({ columns: 115, made: 98, onEdge: 22 });
    expect(census(text, 10, edges, 2)).toMatchObject({ columns: 117, onEdge: 43 });
  });
});

describe("春望, which is the material the rule keeps", () => {
  const { text, edges } = flow("shunbou.conllu");

  it("moves one break onto a clause at the column length the panel sets it at", () => {
    // Six characters to the column is what the kanbun panel sets this poem
    // to at most `.main` widths below 1030px, where `linePerColumnSplit`
    // takes over instead — `rimeColumnFloor`'s own answer for a 五言 poem,
    // which is what `verseFloorDivision` holds the kanbun to once the page
    // can give it (`tests/verseColumnFit.test.ts` has the named widths). One
    // break moves, and it costs no column at all: twenty before and twenty
    // after.
    expect(census(text, 6, edges, 0)).toMatchObject({ columns: 20, made: 10, onEdge: 1 });
    expect(census(text, 6, edges, 2)).toMatchObject({ columns: 20, made: 10, onEdge: 2 });
    expect(planClauseColumns(text, 6, edges, 2).breaks).toEqual([10]);
  });

  it("fires at every column length between four and eight, and at none above", () => {
    // The whole of what this rule does to the only verse this repository has.
    // Would have caught a reach that had grown large enough to start taking
    // columns out of a poem, which is the one way it could do harm here.
    for (const slots of [4, 5, 6, 7, 8]) {
      const before = census(text, slots, edges, 0);
      const after = census(text, slots, edges, 2);
      expect(planClauseColumns(text, slots, edges, 2).breaks).toHaveLength(1);
      expect(after.onEdge).toBe(before.onEdge + 1);
      expect(after.columns).toBe(before.columns);
    }
    for (const slots of [9, 10, 11, 12, 13, 14, 15, 16]) {
      expect(planClauseColumns(text, slots, edges, 2).breaks).toEqual([]);
      expect(planClauseColumns(text, slots, edges, 2).columns).toEqual(planHangingMarks(text, slots).columns);
    }
  });

  it("is asked nothing at all once the page can hold its longest line", () => {
    // Sixteen characters is 春望's longest prose line; at that count and above
    // the panel breaks nothing, so there is nothing for a preference to prefer.
    expect(census(text, 16, edges, 0).made).toBe(0);
  });
});
